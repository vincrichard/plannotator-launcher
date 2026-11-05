import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes, createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

const root = path.dirname(fileURLToPath(import.meta.url));
const servers = [];
const sessions = [];
let state, child, origin, launcherToken;
async function listen(server) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
function request(route, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(origin + route, options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve(new Response(options.method === 'HEAD' ? null : Buffer.concat(chunks), {
        status: res.statusCode, headers: res.headers,
      })));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

before(async () => {
  state = await fs.mkdtemp(path.join(os.tmpdir(), 'review-http-test-'));
  for (const label of ['Alpha', 'Bravo']) {
    const upstream = http.createServer(async (req, res) => {
      if (req.url === '/' || req.url === '/popout.html') {
        res.writeHead(200, {'content-type': 'text/html', etag: 'original-html'});
        return res.end('<html><head><link rel="manifest" href="/native.webmanifest"><link rel="stylesheet" href="/app.css"></head><body><img src="/icon.png"><script>const literal = "/api/diff";</script></body></html>');
      }
      if (req.url === '/events') {
        res.writeHead(200, {'content-type': 'text/event-stream'});
        res.write(`data: ${label}\n\n`);
        return; // Stays open: the proxy must deliver this event before the stream ends.
      }
      if (req.url.startsWith('/api/echo?')) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        res.writeHead(201, {
          'content-type': 'application/json',
          'set-cookie': 'upstream=value; Path=/api/; HttpOnly',
          location: '/api/next?view=diff',
          connection: 'x-upstream-hop', 'x-upstream-hop': 'remove-me',
        });
        return res.end(JSON.stringify({label, path: req.url, method: req.method, body: Buffer.concat(chunks).toString(), headers: req.headers}));
      }
      if (req.url === '/api/large-snapshot') {
        const body = JSON.stringify({label, patch: 'const value = 42;\n'.repeat(5000)});
        res.writeHead(200, {'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), etag: 'snapshot'});
        return res.end(body);
      }
      if (req.url === '/api/json-stream') {
        res.writeHead(200, {'content-type': 'application/json'});
        res.write('{"pending":');
        return; // Unknown-length JSON must retain streaming behavior too.
      }
      if (req.url === '/icon.png') {
        res.writeHead(200, {'content-type': 'image/png'});
        return res.end(Buffer.from([137, 80, 78, 71]));
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({label, path: req.url}));
    });
    const port = await listen(upstream);
    const id = randomBytes(16).toString('hex'), token = randomBytes(32).toString('hex');
    await fs.mkdir(path.join(state, id));
    await fs.writeFile(path.join(state, id, 'route.json'), JSON.stringify({port, pid: process.pid, token, title: label}));
    const createdAt = label === 'Alpha' ? 100000 : 200000;
    await fs.utimes(path.join(state, id, 'route.json'), createdAt / 1000, createdAt / 1000);
    sessions.push({id, token, label, createdAt, prefix: `/reviews/${id}/`, cookie: `pr_access=${token}`});
  }
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [process.env.PROXY_ENTRY || path.join(root, 'proxy.mjs'), state, String(port)], {stdio: ['ignore', 'pipe', 'pipe']});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Proxy startup timeout')), 5000);
    let errorOutput = '';
    child.stderr.on('data', data => errorOutput += data);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(Error(`Proxy exited before startup: ${errorOutput}`)); });
    child.stdout.on('data', data => {
      if (String(data).includes('Review proxy listening')) { clearTimeout(timer); resolve(); }
    });
  });
  launcherToken = (await fs.readFile(path.join(state, 'launcher-token'), 'utf8')).trim();
});

test('HTML negotiates gzip without changing its contents or caching private documents', async () => {
  const [a] = sessions;
  const plain = await request(a.prefix, {headers: {cookie: a.cookie}});
  const html = await plain.text();
  for (const encoding of ['gzip', 'br, gzip;q=0.8', '*;q=0.5']) {
    const response = await request(a.prefix, {headers: {cookie: a.cookie, 'accept-encoding': encoding}});
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    assert.match(response.headers.get('vary'), /Accept-Encoding/i);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(gunzipSync(Buffer.from(await response.arrayBuffer())).toString(), html);
  }
  for (const encoding of ['br', 'GZip;q=0, *;q=1']) {
    const response = await request(a.prefix, {headers: {cookie: a.cookie, 'accept-encoding': encoding}});
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(await response.text(), html);
  }
  assert.equal((await request(a.prefix, {headers: {'accept-encoding': 'gzip'}})).status, 401);
});

test('finite JSON snapshots compress without caching or changing data, streams stay immediate', async () => {
  const [a] = sessions;
  const plain = await request(a.prefix + 'api/large-snapshot', {headers: {cookie: a.cookie}});
  const expected = await plain.text();
  const zipped = await request(a.prefix + 'api/large-snapshot', {headers: {cookie: a.cookie, 'accept-encoding': 'gzip'}});
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers.get('content-encoding'), 'gzip');
  assert.equal(zipped.headers.get('cache-control'), 'no-store');
  assert.match(zipped.headers.get('vary'), /Accept-Encoding/i);
  assert.equal(zipped.headers.get('etag'), null);
  assert.equal(zipped.headers.get('content-length'), null);
  const bytes = Buffer.from(await zipped.arrayBuffer());
  assert.equal(gunzipSync(bytes).toString(), expected);
  assert.ok(bytes.length < Buffer.byteLength(expected) / 10);
  const declined = await request(a.prefix + 'api/large-snapshot', {headers: {cookie: a.cookie, 'accept-encoding': 'gzip;q=0'}});
  assert.equal(declined.headers.get('content-encoding'), null);
  assert.equal(await declined.text(), expected);
  assert.equal((await request(a.prefix + 'api/large-snapshot', {headers: {'accept-encoding': 'gzip'}})).status, 401);
  const tiny = await request(a.prefix + 'api/tiny', {headers: {cookie: a.cookie, 'accept-encoding': 'gzip'}});
  assert.equal(tiny.headers.get('content-encoding'), null);
  await new Promise((resolve, reject) => {
    const req = http.get(origin + a.prefix + 'api/json-stream', {headers: {cookie: a.cookie, 'accept-encoding': 'gzip'}}, res => {
      assert.equal(res.headers['content-encoding'], undefined);
      res.once('data', chunk => { assert.equal(chunk.toString(), '{"pending":'); req.destroy(); resolve(); });
    });
    req.on('error', reject);
    req.setTimeout(1000, () => { req.destroy(); reject(Error('JSON stream was buffered')); });
  });
});

test('HEAD describes the same encoded document as GET without sending a body', async () => {
  const [a] = sessions;
  for (const route of ['', 'popout.html']) {
    const headers = {cookie: a.cookie, 'accept-encoding': 'gzip'};
    const get = await request(a.prefix + route, {headers});
    const head = await request(a.prefix + route, {method: 'HEAD', headers});
    for (const name of ['content-type', 'content-encoding', 'content-length', 'cache-control', 'vary']) {
      assert.equal(head.headers.get(name), get.headers.get(name), name);
    }
    assert.equal(await head.text(), '');
  }
});

test('review documents and assets work below either session prefix', async () => {
  for (const session of sessions) {
    for (const route of ['', 'popout.html']) {
      const response = await request(session.prefix + route, {headers: {cookie: session.cookie}});
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.ok(html.includes(`<base href="${session.prefix}">`));
      assert.ok(html.includes(`href="${session.prefix}app.css"`));
      assert.ok(html.includes(`src="${session.prefix}icon.png"`));
      assert.ok(html.includes('const literal = "/api/diff";'));
      assert.equal((html.match(/rel="manifest"/g) || []).length, 1);
      assert.ok(html.includes('href="/manifest.webmanifest"'));
      assert.equal(response.headers.get('etag'), null);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    const asset = await request(session.prefix + 'icon.png', {headers: {cookie: session.cookie}});
    assert.equal(asset.headers.get('content-type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await asset.arrayBuffer())], [137, 80, 78, 71]);
  }
  const unknownScript = createHash('sha256').update('const literal = "/api/diff";').digest('hex');
  assert.equal((await request(`/ui/${unknownScript}.js`)).status, 404, 'Unpinned inline scripts must never become public assets');
});

test('API forwarding preserves credentials and bodies while containing proxy cookies and redirects', async () => {
  const [a] = sessions;
  const response = await request(a.prefix + 'api/echo?filter=a%2Fb', {
    method: 'POST', body: '{"serverSession":"fixture","text":"unchanged"}',
    headers: {
      cookie: `${a.cookie}; pr_launcher=${launcherToken}; preference=light`,
      authorization: 'Bearer fixture-upstream-secret', origin,
      'content-type': 'application/json',
      connection: 'x-client-hop', 'x-client-hop': 'remove-me',
      'if-none-match': 'stale', 'if-modified-since': 'Tue, 01 Jan 2030 00:00:00 GMT',
    },
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('location'), a.prefix + 'api/next?view=diff');
  assert.equal(response.headers.get('set-cookie'), `upstream=value; Path=${a.prefix}api/; HttpOnly`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-upstream-hop'), null);
  const data = await response.json();
  assert.equal(data.path, '/api/echo?filter=a%2Fb');
  assert.equal(data.method, 'POST');
  assert.equal(data.body, '{"serverSession":"fixture","text":"unchanged"}');
  assert.equal(data.headers.authorization, 'Bearer fixture-upstream-secret');
  assert.equal(data.headers.origin, origin);
  assert.equal(data.headers.host, new URL(origin).host);
  assert.equal(data.headers.cookie.trim(), 'preference=light');
  for (const name of ['x-client-hop', 'if-none-match', 'if-modified-since']) assert.equal(data.headers[name], undefined);
});

test('two simultaneous event streams deliver data before either upstream closes', async () => {
  await Promise.all(sessions.map(session => new Promise((resolve, reject) => {
    const req = http.get(origin + session.prefix + 'events', {headers: {cookie: session.cookie, 'accept-encoding': 'gzip'}}, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (!data.includes('\n\n')) return;
        clearTimeout(timer);
        try {
          assert.equal(res.statusCode, 200);
          assert.equal(res.headers['content-encoding'], undefined);
          assert.equal(data, `data: ${session.label}\n\n`);
          assert.equal(res.complete, false);
          resolve();
        } catch (error) { reject(error); }
        finally { res.destroy(); }
      });
      res.on('error', reject);
    });
    const timer = setTimeout(() => { req.destroy(); reject(Error('Stream was buffered or lost')); }, 2000);
    req.on('error', error => { clearTimeout(timer); reject(error); });
  })));
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  if (state) await fs.rm(state, {recursive: true, force: true});
});

test('access links authenticate only their own review and retain request guards', async () => {
  const [a, b] = sessions;
  assert.equal((await request(a.prefix)).status, 401);
  assert.equal((await request(a.prefix, {headers: {cookie: b.cookie}})).status, 401);
  assert.equal((await request(`${a.prefix}?access=${b.token}`)).status, 401);
  const login = await request(`${a.prefix}?access=${a.token}&view=diff`, {
    headers: {'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate'},
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), `${a.prefix}?view=diff`);
  assert.equal(login.headers.get('set-cookie'), `${a.cookie}; Path=${a.prefix}; HttpOnly; SameSite=Lax`);
  for (const session of sessions) {
    const response = await request(`${session.prefix}api/diff`, {headers: {cookie: session.cookie}});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {label: session.label, path: '/api/diff'});
  }
  for (const headers of [
    {origin: 'https://hostile.test'},
    {'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors'},
  ]) assert.equal((await request(a.prefix, {headers: {cookie: a.cookie, ...headers}})).status, 403);
  assert.equal(await new Promise((resolve, reject) => {
    http.get(origin + '/health', {headers: {host: 'hostile.test'}}, res => {
      res.resume(); resolve(res.statusCode);
    }).on('error', reject);
  }), 403);
  assert.equal((await request(`/reviews/${'0'.repeat(32)}/`)).status, 410);
});

test('launcher lists and opens reviews without an unlock; legacy links remain valid', async () => {
  const [a, b] = sessions;
  const headers = {cookie: `pr_launcher=${launcherToken}`};
  assert.equal((await request('/reviews/launcher/reviews')).status, 200);
  assert.equal((await request('/launcher/reviews', {headers: {cookie: a.cookie}})).status, 200);
  assert.equal((await request('/?unlock=wrong')).status, 401);
  const unlocked = await request(`/reviews/?unlock=${launcherToken}`);
  assert.equal(unlocked.status, 303);
  assert.equal(unlocked.headers.get('location'), '/reviews/');
  assert.ok(unlocked.headers.get('set-cookie').includes(`pr_launcher=${launcherToken}; Path=/reviews/launcher/; Max-Age=2592000; HttpOnly; SameSite=Lax`));
  assert.ok(unlocked.headers.get('set-cookie').includes(`pr_launcher=${launcherToken}; Path=/launcher/; Max-Age=2592000; HttpOnly; SameSite=Lax`));
  const listing = await request('/reviews/launcher/reviews');
  assert.equal(listing.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await listing.json(), {reviews: [b, a].map(s => ({id: s.id, title: s.label, path: `/reviews/launcher/open/${s.id}`, createdAt: s.createdAt, status: 'running', closing: false}))});
  const opened = await request(`/reviews/launcher/open/${a.id}`);
  assert.equal(opened.status, 303);
  assert.equal(opened.headers.get('location'), a.prefix);
  assert.equal(opened.headers.get('set-cookie'), `${a.cookie}; Path=${a.prefix}; HttpOnly; SameSite=Lax`);
  assert.equal((await request(a.prefix, {headers})).status, 401);
  assert.equal((await request('/launcher/reviews', {method: 'POST', headers})).status, 405);

  assert.equal((await request('/reviews/launcher/reviews', {headers: {origin: 'http://foreign.test'}})).status, 403);
  assert.equal((await request(`/reviews/launcher/open/${a.id}`, {headers: {'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors'}})).status, 403);
  const legacy = await request('/launcher/reviews', {headers});
  assert.equal(legacy.status, 200);
  assert.ok(legacy.headers.get('set-cookie').includes('Path=/reviews/launcher/;'));
  assert.equal((await request(`/launcher/open/${a.id}`, {headers})).headers.get('location'), a.prefix);
  assert.equal((await request(`/?unlock=${launcherToken}`)).headers.get('location'), '/reviews/');
  assert.equal((await request('/')).headers.get('location'), '/reviews/');
  assert.equal((await request('/reviews')).headers.get('location'), '/reviews/');
  const home = await request('/reviews/');
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('location'), null);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.ok((await home.text()).includes('id="running-heading">Reviews'));
  const head = await request('/reviews/', {method: 'HEAD'});
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await request('/launcher/mobile.py')).status, 404);
  assert.equal((await request('/launcher/app.js', {method: 'POST'})).status, 405);
  assert.equal((await request('/launcher/app.js')).headers.get('content-type'), 'text/javascript');
  const manifest = await (await request('/manifest.webmanifest')).json();
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/reviews/');
  assert.equal(manifest.scope, '/reviews/');
  for (const icon of manifest.icons) assert.equal((await request(icon.src)).headers.get('content-type'), 'image/png');

  await fs.unlink(path.join(state, b.id, 'route.json'));
  assert.deepEqual(await (await request('/launcher/reviews', {headers})).json(), {
    reviews: [{id: a.id, title: 'Alpha', path: `/reviews/launcher/open/${a.id}`, createdAt: a.createdAt, status: 'running', closing: false}],
  });
  assert.equal((await request(`/launcher/open/${b.id}`, {headers})).status, 410);
});
