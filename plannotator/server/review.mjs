import http from 'node:http';
import {createGzip} from 'node:zlib';
import {equal, reply, reviewCookie} from './access.mjs';
import {rewriteReviewDocument} from './document.mjs';
import {acceptsGzip, sendEncoded} from './encoding.mjs';

const hop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function headersWithoutHop(headers) {
  const result = { ...headers };
  for (const key of [...hop, ...(headers.connection || '').split(',').map(s => s.trim().toLowerCase())]) delete result[key];
  return result;
}

export function handleReview(req, res, url, sessions) {
  const match = /^\/reviews\/([a-f0-9]{32})(\/.*)?$/.exec(url.pathname);
  if (!match) return reply(res, 404, 'Review not found');
  const id = match[1], prefix = `/reviews/${id}/`;
  let session;
  try {
    session = sessions.read(id);
  } catch { return reply(res, 410, 'Review has ended or is unavailable'); }
  const access = url.searchParams.get('access');
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('pr_access='))?.slice(10);
  if (access !== null) {
    if (req.method !== 'GET' || !equal(access, session.token)) return reply(res, 401, 'Invalid review access link');
    url.searchParams.delete('access');
    res.writeHead(303, {
      location: prefix + (match[2] || '/').slice(1) + url.search,
      // Cross-site access-link redirects need Lax; Origin and fetch-metadata checks still guard requests.
      'set-cookie': reviewCookie(id, session.token),
      'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
    });
    return res.end();
  }
  if (!equal(cookie, session.token)) return reply(res, 401, 'Open the access link from the agent to enter this review');
  if (session.status === 'suspended') return reply(res, 410, 'This review is saved and offline. Resume it from /reviews/ or ask your agent to run plannotator-mobile --resume ' + id);
  if (!match[2]) { res.writeHead(308, {location: prefix + url.search}); return res.end(); }
  // Two permanent streams per tab exhaust HTTP/1's six connections on this shared origin.
  // These native clients already fall back to versioned snapshot polling on initial failure.
  if (req.method === 'GET' && ['/api/external-annotations/stream', '/api/agents/jobs/stream'].includes(match[2])) {
    return reply(res, 503, 'Use snapshot polling on the shared review proxy');
  }
  const headers = headersWithoutHop(req.headers);
  // Preserve Host, Origin and Authorization: upstream keeps its own host/CSRF checks.
  headers['accept-encoding'] = 'identity';
  delete headers['if-none-match'];
  delete headers['if-modified-since'];
  headers.cookie = (req.headers.cookie || '').split(';').filter(s => !/^pr_(access|launcher)=/.test(s.trim())).join(';');
  const documentPath = match[2] === '/' || match[2] === '/popout.html';
  // HEAD needs the transformed representation's headers; sendEncoded omits its body.
  const method = req.method === 'HEAD' && documentPath ? 'GET' : req.method;
  const upstream = http.request({hostname: '127.0.0.1', port: session.port, path: match[2] + url.search, method, headers}, incoming => {
    const out = headersWithoutHop(incoming.headers);
    out['cache-control'] = 'no-store';
    out['referrer-policy'] = 'no-referrer';
    out['x-content-type-options'] = 'nosniff';
    if (out.location?.startsWith('/') && !out.location.startsWith('//')) out.location = prefix.slice(0, -1) + out.location;
    if (out['set-cookie']) out['set-cookie'] = out['set-cookie'].map(c => c.replace(/;\s*Path=\/([^;]*)/i, `; Path=${prefix}$1`));
    const appDocument = documentPath && String(out['content-type']).includes('text/html');
    if (appDocument) {
      const chunks = [];
      incoming.on('data', c => chunks.push(c));
      incoming.on('end', () => {
        const html = rewriteReviewDocument(Buffer.concat(chunks).toString('utf8'), prefix);
        delete out['content-length']; delete out.etag;
        sendEncoded(req, res, incoming.statusCode, out, html).catch(() => res.destroy());
      });
    } else if (req.method === 'GET' && incoming.statusCode === 200
      && /^application\/json(?:;|$)/i.test(String(out['content-type']))
      && Number(out['content-length']) >= 1024 && !out['content-encoding']
      && acceptsGzip(req.headers['accept-encoding'])) {
      // Compress finite snapshots without retaining private data or delaying live streams.
      delete out['content-length']; delete out.etag;
      out['content-encoding'] = 'gzip';
      out.vary = [...new Set([...(out.vary || '').split(',').filter(Boolean), 'Accept-Encoding'])].join(', ');
      const gzip = createGzip();
      gzip.on('error', () => res.destroy());
      res.on('close', () => gzip.destroy());
      res.writeHead(incoming.statusCode, out);
      res.flushHeaders();
      incoming.pipe(gzip).pipe(res);
    } else {
      res.writeHead(incoming.statusCode, out);
      res.flushHeaders();
      incoming.pipe(res); // Stream SSE/fetch output immediately, with backpressure.
    }
    incoming.on('error', () => res.destroy());
    res.on('close', () => incoming.destroy());
  });
  upstream.on('error', () => { if (!res.headersSent) reply(res, 502, 'Review process unavailable'); else res.destroy(); });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}
