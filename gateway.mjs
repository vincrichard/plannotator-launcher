import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createReviewServer} from './plannotator/server/review-server.mjs';
import {createSiteServer} from './sites/server.mjs';

export function createGateway(reviewState, siteState, port) {
  const reviews = createReviewServer(reviewState, port);
  const sites = createSiteServer(siteState, port);
  const forSites = req => {
    const pathname = req.url.split('?')[0];
    return req.headers.host === `127.0.0.1:${port}` && (pathname === '/sites' || pathname.startsWith('/sites/'));
  };
  const server = http.createServer((req, res) => {
    (forSites(req) ? sites : reviews).emit('request', req, res);
  });
  server.requestTimeout = 0;
  server.on('upgrade', (req, socket, head) => {
    if (forSites(req)) return sites.emit('upgrade', req, socket, head);
    socket.on('error', () => socket.destroy());
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  return server;
}

if (import.meta.main) {
  process.umask(0o077);
  const [reviewState = path.join(os.tmpdir(), `plannotator-mobile-${process.getuid()}`), portText = '19433',
    siteState = path.join(os.homedir(), '.local/state/agent-sites')] = process.argv.slice(2);
  for (const state of [reviewState, siteState]) {
    fs.mkdirSync(state, {recursive: true, mode: 0o700});
    const info = fs.lstatSync(state);
    if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077) throw Error(`Expected an owner-only directory: ${state}`);
  }
  const server = createGateway(reviewState, siteState, Number(portText));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(Number(portText), '127.0.0.1', () => console.log(`Review proxy listening on 127.0.0.1:${portText}; sites share this gateway under /sites/`));
}
