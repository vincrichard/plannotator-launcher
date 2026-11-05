import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {equal, reply, reviewCookie} from './access.mjs';

export function createLauncher(state, sessions) {
  const launcherTokenFile = path.join(state, 'launcher-token');
  try { fs.writeFileSync(launcherTokenFile, crypto.randomBytes(32).toString('hex'), {flag: 'wx', mode: 0o600}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const launcherToken = fs.readFileSync(launcherTokenFile, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(launcherToken)) throw Error('Invalid launcher token file');
  const launcherCookie = scope => `pr_launcher=${launcherToken}; Path=${scope}; Max-Age=2592000; HttpOnly; SameSite=Lax`;
  const launcherFiles = new Map([
    ['/reviews/', ['index.html', 'text/html; charset=utf-8']],
    ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
    ...['app.js', 'style.css', 'icon.svg', 'icon-192.png', 'icon-512.png'].map(name => [`/launcher/${name}`, [name, {'js': 'text/javascript', 'css': 'text/css', 'svg': 'image/svg+xml', 'png': 'image/png'}[name.split('.').pop()]]]),
  ].map(([route, [file, type]]) => [route, {body: fs.readFileSync(new URL(`../launcher/${file}`, import.meta.url)), type}]));

  return function handleLauncher(req, res, url) {
    if (['/', '/reviews/'].includes(url.pathname) && url.searchParams.has('unlock')) {
      if (req.method !== 'GET' || !equal(url.searchParams.get('unlock'), launcherToken)) return reply(res, 401, 'Invalid launcher access link');
      res.writeHead(303, {location: '/reviews/', 'set-cookie': [launcherCookie('/reviews/launcher/'), launcherCookie('/launcher/')], 'cache-control': 'no-store', 'referrer-policy': 'no-referrer'});
      return res.end();
    }
    if (url.pathname === '/' || url.pathname === '/reviews') {
      if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, 'Method not allowed');
      res.writeHead(308, {location: '/reviews/' + url.search, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer'});
      return res.end();
    }
    const pathname = url.pathname.startsWith('/reviews/launcher/') ? url.pathname.slice('/reviews'.length) : url.pathname;
    const action = /^\/launcher\/(suspend|resume|prepare|close|save-close)\/([a-f0-9]{32})$/.exec(pathname);
    if (action) {
      if (req.method !== 'POST') return reply(res, 405, 'Method not allowed');
      if (req.headers['x-review-action'] !== '1') return reply(res, 403, 'Review action header required');
      let session;
      try { session = sessions.read(action[2]); } catch { return reply(res, 410, 'Review unavailable'); }
      if (!session.record || path.basename(session.record) !== action[2]) return reply(res, 409, 'This review predates suspension support');
      req.resume();
      execFile('python3', [fileURLToPath(new URL('../lifecycle.py', import.meta.url)), action[1], session.record],
        {timeout: 75000, maxBuffer: 1024 * 1024}, (error, stdout) => {
          let result;
          try { result = JSON.parse(stdout); } catch { result = {error: 'Review action was not confirmed. Refresh before retrying.'}; }
          res.writeHead(error ? 409 : 200, {'content-type': 'application/json', 'cache-control': 'no-store'});
          res.end(JSON.stringify(result));
        });
      return;
    }
    const open = /^\/launcher\/open\/([a-f0-9]{32})$/.exec(pathname);
    if (pathname === '/launcher/reviews' || open) {
      if (req.method !== 'GET') return reply(res, 405, 'Method not allowed');
      if (open) {
        const id = open[1];
        let session;
        try { session = sessions.read(id); } catch { return reply(res, 410, 'Review has ended or is unavailable'); }
        res.writeHead(303, {location: `/reviews/${id}/`, 'set-cookie': reviewCookie(id, session.token), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer'});
        return res.end();
      }
      const reviews = sessions.list();
      // Migrate browsers that still have only the original /launcher/ login cookie.
      if (url.pathname === '/launcher/reviews') res.setHeader('set-cookie', launcherCookie('/reviews/launcher/'));
      res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff'});
      return res.end(JSON.stringify({reviews}));
    }
    const asset = launcherFiles.get(pathname);
    if (asset) {
      if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, 'Method not allowed');
      res.writeHead(200, {'content-type': asset.type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"});
      return res.end(req.method === 'HEAD' ? undefined : asset.body);
    }
    return reply(res, 404, 'Review not found');
  };
}
