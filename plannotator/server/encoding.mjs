import {gzip} from 'node:zlib';
import {promisify} from 'node:util';

export const compress = promisify(gzip);

export function acceptsGzip(header = '') {
  const encodings = new Map(header.toLowerCase().split(',').map(entry => {
    const [name, ...parameters] = entry.trim().split(';');
    const quality = parameters.find(p => p.trim().startsWith('q='));
    return [name.trim(), quality === undefined ? 1 : Number(quality.trim().slice(2))];
  }));
  return (encodings.get('gzip') ?? encodings.get('*') ?? 0) > 0;
}

export async function sendEncoded(req, res, status, headers, body, compressed) {
  const out = {...headers};
  delete out['content-encoding'];
  out.vary = [...new Set([...(out.vary || '').split(',').filter(Boolean), 'Accept-Encoding'])].join(', ');
  if (acceptsGzip(req.headers['accept-encoding'])) {
    body = await (compressed || compress(body));
    out['content-encoding'] = 'gzip';
  }
  if (res.destroyed) return;
  out['content-length'] = Buffer.byteLength(body);
  res.writeHead(status, out);
  res.end(req.method === 'HEAD' ? undefined : body);
}
