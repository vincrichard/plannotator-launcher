import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {timingSafeEqual} from 'node:crypto';

export const validName = name => typeof name === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) && name !== 'health';
export const validPort = port => Number.isInteger(port) && port > 0 && port < 65536;
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const types = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.pdf': 'application/pdf'};

function reply(res, status, message) {
  res.writeHead(status, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'});
  res.end(message);
}

export async function readRoute(state, name) {
  if (!validName(name)) throw Error('Invalid site name');
  const route = JSON.parse(await fs.readFile(path.join(state, `${name}.json`), 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(route.token) ||
      !(route.kind === 'directory' && typeof route.path === 'string' && path.isAbsolute(route.path) ||
        route.kind === 'proxy' && validPort(route.port))) throw Error('Invalid site registration');
  return route;
}

function allowed(req, port) {
  const host = `127.0.0.1:${port}`;
  return req.headers.host === host && (!req.headers.origin || req.headers.origin === `http://${host}`) &&
    (req.headers['sec-fetch-site'] !== 'cross-site' || req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate');
}

function authenticated(req, route) {
  return (req.headers.cookie || '').split(';').some(cookie => equal(cookie.trim(), `site_access=${route.token}`));
}

function cleanHeaders(headers) {
  const copy = {...headers};
  for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...(headers.connection || '').toLowerCase().split(',').map(s => s.trim())]) delete copy[name];
  return copy;
}

function upstreamRequest(req, port, prefix) {
  const headers = cleanHeaders(req.headers);
  headers.cookie = (headers.cookie || '').split(';').filter(cookie => !/^(site_access|pr_access|pr_launcher)=/.test(cookie.trim())).join(';');
  for (const name of Object.keys(headers)) if (name === 'forwarded' || name.startsWith('x-forwarded-')) delete headers[name];
  headers['x-forwarded-host'] = req.headers.host;
  headers['x-forwarded-proto'] = 'http';
  headers['x-forwarded-prefix'] = prefix;
  // shortcut: apps must serve their /sites/name/ base path; use a separate origin if an app cannot support a base path.
  return http.request({hostname: '127.0.0.1', port, method: req.method, path: req.url, headers});
}

async function serveDirectory(req, res, root, suffix) {
  if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, 'Method not allowed');
  if (suffix.includes('\0') || suffix.includes('\\') || suffix.split('/').some(segment => segment.startsWith('.'))) return reply(res, 403, 'Path not allowed');
  root = await fs.realpath(root);
  const inside = target => target === root || target.startsWith(root + path.sep);
  let file = await fs.realpath(path.resolve(root, '.' + suffix));
  if (!inside(file)) return reply(res, 403, 'Path not allowed');
  if ((await fs.stat(file)).isDirectory()) {
    if (!suffix.endsWith('/')) {
      const url = new URL(req.url, 'http://127.0.0.1');
      res.writeHead(308, {location: url.pathname + '/' + url.search});
      return res.end();
    }
    file = await fs.realpath(path.join(file, 'index.html'));
  }
  if (!inside(file) || path.relative(root, file).split(path.sep).some(segment => segment.startsWith('.'))) return reply(res, 403, 'Path not allowed');
  const handle = await fs.open(file, 'r');
  const info = await handle.stat();
  if (!info.isFile()) { await handle.close(); return reply(res, 404, 'File not found'); }
  res.writeHead(200, {'content-type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': info.size});
  if (req.method === 'HEAD') { await handle.close(); return res.end(); }
  const stream = handle.createReadStream();
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

export function createSiteServer(state, publicPort) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    const port = publicPort ?? server.address().port;
    if (['/health', '/sites/health'].includes(req.url) && req.method === 'GET' && allowed(req, port)) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({name: 'agent-sites', version: 1}));
    }
    if (!allowed(req, port)) return reply(res, 403, 'Host or origin not allowed');
    if (!req.url.startsWith('/') || req.url.startsWith('//')) return reply(res, 400, 'Invalid URL');
    if (req.url === '/sites' && ['GET', 'HEAD'].includes(req.method)) { res.writeHead(308, {location: '/sites/'}); return res.end(); }
    if (req.url === '/sites/' && req.method === 'GET') return reply(res, 200, 'Agent sites is ready. Open the private /sites/name/ link printed by agent-site.');
    let pathname;
    try { pathname = decodeURIComponent(req.url.split('?')[0]); }
    catch { return reply(res, 400, 'Invalid URL encoding'); }
    const match = /^\/sites\/([a-z0-9-]+)(\/.*)?$/.exec(pathname);
    if (!match || !validName(match[1])) return reply(res, 404, 'Site not found');
    const name = match[1], prefix = `/sites/${name}/`;
    try {
      const route = await readRoute(state, name);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const access = url.searchParams.get('access');
      if (access !== null) {
        if (req.method !== 'GET' || !equal(access, route.token)) return reply(res, 401, 'Invalid site access link');
        url.searchParams.delete('access');
        res.writeHead(303, {location: (match[2] ? url.pathname : prefix) + url.search,
          'set-cookie': `site_access=${route.token}; Path=${prefix}; HttpOnly; SameSite=Lax`});
        return res.end();
      }
      if (!authenticated(req, route)) return reply(res, 401, 'Open the private access link printed by agent-site');
      if (!match[2]) { res.writeHead(308, {location: prefix + url.search}); return res.end(); }
      if (route.kind === 'directory') return await serveDirectory(req, res, route.path, match[2]);
      if (route.port === port) return reply(res, 502, 'A site cannot proxy back to this service');
      const upstream = upstreamRequest(req, route.port, prefix);
      upstream.on('response', incoming => {
        const headers = cleanHeaders(incoming.headers);
        headers['cache-control'] = 'no-store';
        headers['referrer-policy'] = 'no-referrer';
        res.writeHead(incoming.statusCode, headers);
        res.flushHeaders();
        incoming.on('error', () => res.destroy());
        incoming.pipe(res);
      });
      upstream.on('error', () => { if (res.headersSent) res.destroy(); else reply(res, 502, 'Website server unavailable'); });
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return reply(res, 404, 'Site or file not found');
      console.error('Site request failed:', error.message);
      reply(res, 500, 'Site unavailable; check the service log');
    }
  });
  server.requestTimeout = 0;
  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const reject = () => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    const port = publicPort ?? server.address().port;
    const match = /^\/sites\/([a-z0-9-]+)\//.exec(req.url);
    if (req.method !== 'GET' || !allowed(req, port) || !match || req.headers.upgrade?.toLowerCase() !== 'websocket') return reject();
    try {
      const route = await readRoute(state, match[1]);
      if (route.kind !== 'proxy' || route.port === port || !authenticated(req, route) || socket.destroyed) return reject();
      const upstream = upstreamRequest(req, route.port, `/sites/${match[1]}/`);
      upstream.setHeader('connection', 'Upgrade');
      upstream.setHeader('upgrade', 'websocket');
      upstream.on('upgrade', (incoming, peer, peerHead) => {
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(incoming.headers).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(v => `${key}: ${v}\r\n`)).join('')}\r\n`);
        if (peerHead.length) socket.write(peerHead);
        if (head.length) peer.write(head);
        peer.on('error', () => socket.destroy());
        socket.on('error', () => peer.destroy());
        socket.on('close', () => peer.destroy());
        peer.on('close', () => socket.destroy());
        socket.pipe(peer).pipe(socket);
      });
      upstream.on('response', incoming => { incoming.resume(); reject(); });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      socket.on('close', () => upstream.destroy());
      upstream.end();
    } catch { reject(); }
  });
  return server;
}
