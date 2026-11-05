import http from 'node:http';
import {reply} from './access.mjs';
import {createSessionStore} from './sessions.mjs';
import {handleReview} from './review.mjs';
import {createLauncher} from './launcher.mjs';
import {handleAsset} from './assets.mjs';

export function createReviewServer(state, port) {
  const sessions = createSessionStore(state);
  const launcher = createLauncher(state, sessions);
  const server = http.createServer((req, res) => {
    const host = req.headers.host;
    if (![ `localhost:${port}`, `127.0.0.1:${port}` ].includes(host)) return reply(res, 403, 'Host not allowed');
    if ((req.headers['sec-fetch-site'] === 'cross-site' && !(req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate')) || (req.headers.origin && req.headers.origin !== `http://${host}`)) return reply(res, 403, 'Origin not allowed');
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname.startsWith('/ui/')) return handleAsset(req, res, url);
    if (['/', '/reviews', '/reviews/', '/manifest.webmanifest'].includes(url.pathname) || url.pathname.startsWith('/launcher/') || url.pathname.startsWith('/reviews/launcher/')) {
      return launcher(req, res, url);
    }
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, {'content-type': 'application/json'});
      return res.end(JSON.stringify({name: 'plannotator-review-proxy', version: 1}));
    }
    handleReview(req, res, url, sessions);
  });
  server.requestTimeout = 0;
  return server;
}
