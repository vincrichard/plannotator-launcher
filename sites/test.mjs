import assert from 'node:assert/strict';
import {test, before, after} from 'node:test';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {createSiteServer, readRoute} from './server.mjs';
import {createGateway} from '../gateway.mjs';

let temporary, state, port, host, upstream, server, upstreamHeaders;
const sockets = new Set();
const token = 'a'.repeat(64), otherToken = 'b'.repeat(64);
const cookie = `site_access=${token}`;

async function listen(server, requestedPort = 0) {
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(requestedPort, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function request(url, {headers = {}, method = 'GET', body} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, path: url, method, headers: {host, ...headers}}, response => {
      const chunks = [];
      response.on('error', reject);
      response.on('data', data => chunks.push(data));
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString()}));
    });
    req.on('error', reject);
    req.end(body);
  });
}

before(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sites-test-'));
  state = path.join(temporary, 'state');
  const directory = path.join(temporary, 'public');
  await fs.mkdir(state);
  await fs.mkdir(path.join(directory, 'nested'), {recursive: true});
  await fs.writeFile(path.join(directory, 'index.html'), '<h1>Hello</h1><link rel="stylesheet" href="style.css">');
  await fs.writeFile(path.join(directory, 'style.css'), 'body { color: green; }');
  await fs.writeFile(path.join(directory, 'nested/index.html'), 'Nested page');
  await fs.writeFile(path.join(directory, '.env'), 'SECRET');
  await fs.writeFile(path.join(temporary, 'private.txt'), 'SECRET');
  await fs.symlink(path.join(temporary, 'private.txt'), path.join(directory, 'escape.txt'));
  await fs.symlink(path.join(directory, '.env'), path.join(directory, 'hidden.txt'));
  await fs.writeFile(path.join(state, 'hello.json'), JSON.stringify({kind: 'directory', path: directory, token}));
  await fs.writeFile(path.join(state, 'other.json'), JSON.stringify({kind: 'directory', path: directory, token: otherToken}));
  upstream = http.createServer(async (req, res) => {
    if (req.url === '/sites/app/events') {
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.write('data: ready\n\n');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.writeHead(201, {'content-type': 'application/json', connection: 'x-upstream-hop', 'x-upstream-hop': 'remove'});
    res.end(JSON.stringify({url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString()}));
  });
  upstream.on('upgrade', (req, socket, head) => {
    upstreamHeaders = req.headers;
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\npeer-head`);
    if (head.length) socket.write(head);
    socket.on('data', data => socket.write(data));
  });
  const upstreamPort = await listen(upstream);
  await fs.writeFile(path.join(state, 'app.json'), JSON.stringify({kind: 'proxy', port: upstreamPort, token}));
  if (process.env.TEST_GATEWAY === '1') {
    const reservation = http.createServer();
    port = await listen(reservation);
    await new Promise(resolve => reservation.close(resolve));
    const reviewState = path.join(temporary, 'reviews');
    await fs.mkdir(reviewState);
    server = createGateway(reviewState, state, port);
    await listen(server, port);
  } else {
    server = createSiteServer(state);
    port = await listen(server);
  }
  host = `127.0.0.1:${port}`;
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  await fs.rm(temporary, {recursive: true, force: true});
});

test('private links unlock a site, remove the secret, and keep the cookie on that path', async () => {
  assert.equal((await request('/sites/hello/')).status, 401);
  assert.equal((await request('/sites/hello/?access=wrong')).status, 401);
  const entry = await request(`/sites/hello/?access=${token}&view=wide`, {headers: {'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate'}});
  assert.equal(entry.status, 303);
  assert.equal(entry.headers.location, '/sites/hello/?view=wide');
  assert.ok(entry.headers['set-cookie'][0].includes('Path=/sites/hello/; HttpOnly; SameSite=Lax'));
  assert.equal(entry.headers['referrer-policy'], 'no-referrer');
  assert.equal(entry.headers['cache-control'], 'no-store');
  assert.equal((await request('/sites/hello/', {headers: {cookie}})).status, 200);
  assert.equal((await request('/sites/other/', {headers: {cookie}})).status, 401);
});

test('static pages, assets, HEAD and nested directory redirects work', async () => {
  const page = await request('/sites/hello/', {headers: {cookie}});
  assert.match(page.body, /<h1>Hello<\/h1>/);
  assert.match(page.headers['content-type'], /text\/html/);
  const css = await request('/sites/hello/style.css?v=1', {headers: {cookie}});
  assert.match(css.headers['content-type'], /text\/css/);
  assert.match(css.body, /green/);
  const head = await request('/sites/hello/style.css', {method: 'HEAD', headers: {cookie}});
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], css.headers['content-length']);
  const nested = await request('/sites/hello/nested?view=1', {headers: {cookie}});
  assert.equal(nested.status, 308);
  assert.equal(nested.headers.location, '/sites/hello/nested/?view=1');
  assert.equal((await request('/sites/hello/nested/', {headers: {cookie}})).body, 'Nested page');
  assert.equal((await request(`/sites/hello?access=${token}`)).headers.location, '/sites/hello/');
});

test('HTTP cannot read outside a site or register new targets', async () => {
  for (const url of ['/sites/hello/.env', '/sites/hello/../private.txt', '/sites/hello/%2e%2e/private.txt', '/sites/hello/%2eenv', '/sites/hello/escape.txt', '/sites/hello/hidden.txt', '/sites/hello/%00']) {
    const response = await request(url, {headers: {cookie}});
    assert.equal(response.status, 403, url);
    assert.ok(!response.body.includes('SECRET'));
  }
  assert.equal((await request('/sites/hello/%xx', {headers: {cookie}})).status, 400);
  assert.equal((await request('/sites/hello/missing', {headers: {cookie}})).status, 404);
  assert.equal((await request('/sites/unknown/', {headers: {cookie}})).status, 404);
  assert.equal((await request('/sites/hello/', {method: 'POST', headers: {cookie}, body: 'replace'})).status, 405);
  assert.equal((await request('/register', {method: 'POST', body: '{}'})).status, 404);
  assert.equal((await readRoute(state, 'hello')).kind, 'directory');
});

test('Host, Origin and cross-site guards reject unwanted requests', async () => {
  for (const headers of [{host: `sites.localhost:${port}`}, {host: '127.0.0.1:0'}, {host: `evil.example:${port}`}, {origin: 'http://evil.example'}, {'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors'}]) {
    assert.equal((await request('/sites/hello/', {headers: {cookie, ...headers}})).status, 403);
  }
  const health = await request('/health', {headers: {host: `127.0.0.1:${port}`}});
  assert.deepEqual(JSON.parse(health.body), {name: process.env.TEST_GATEWAY === '1' ? 'plannotator-review-proxy' : 'agent-sites', version: 1});
  assert.deepEqual(JSON.parse((await request('/sites/health')).body), {name: 'agent-sites', version: 1});
});

test('the shared origin routes sites outside the Reviews app scope', {skip: process.env.TEST_GATEWAY !== '1'}, async () => {
  const manifest = await request('/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  const app = JSON.parse(manifest.body);
  assert.equal(app.id, '/');
  assert.equal(app.start_url, '/reviews/');
  assert.equal(app.scope, '/reviews/');
  const launcher = await request('/reviews/');
  assert.equal(launcher.status, 200);
  assert.equal(launcher.headers.location, undefined);
  assert.match(launcher.body, /<ul[^>]+id="reviews"/);
  const site = await request('/sites/hello/', {headers: {cookie}});
  assert.equal(site.status, 200);
  assert.match(site.body, /<h1>Hello/);
  assert.equal(site.headers['cache-control'], 'no-store');
  assert.equal(site.headers['service-worker-allowed'], undefined);
  assert.equal((await request('/reviews/' + 'a'.repeat(32) + '/', {headers: {cookie}})).status, 410);
  assert.equal((await request('/hello/', {headers: {cookie}})).status, 404);
});

test('proxy preserves the app base path, query, body and app credentials without leaking its access cookie', async () => {
  const response = await request('/sites/app/api/echo?value=a%20b', {method: 'POST', headers: {
    cookie: `${cookie}; pr_launcher=review-secret; pr_access=review-secret; app_session=keep`, origin: `http://${host}`, authorization: 'Bearer app-token',
    'x-forwarded-host': 'spoof', forwarded: 'spoof', connection: 'x-client-hop', 'x-client-hop': 'remove',
  }, body: 'request payload'});
  assert.equal(response.status, 201);
  const echo = JSON.parse(response.body);
  assert.equal(echo.url, '/sites/app/api/echo?value=a%20b');
  assert.equal(echo.method, 'POST');
  assert.equal(echo.body, 'request payload');
  assert.equal(echo.headers.host, host);
  assert.equal(echo.headers.origin, `http://${host}`);
  assert.equal(echo.headers.authorization, 'Bearer app-token');
  assert.equal(echo.headers.cookie.trim(), 'app_session=keep');
  assert.equal(echo.headers['x-forwarded-prefix'], '/sites/app/');
  assert.equal(echo.headers['x-forwarded-host'], host);
  assert.equal(echo.headers['x-forwarded-proto'], 'http');
  assert.equal(echo.headers.forwarded, undefined);
  assert.equal(echo.headers['x-client-hop'], undefined);
  assert.equal(response.headers['x-upstream-hop'], undefined);
  await fs.writeFile(path.join(state, 'recursive.json'), JSON.stringify({kind: 'proxy', port, token}));
  assert.equal((await request('/sites/recursive/', {headers: {cookie}})).status, 502);
});

test('event streams arrive before the upstream closes', async () => {
  const data = await new Promise((resolve, reject) => {
    const req = http.get({host: '127.0.0.1', port, path: '/sites/app/events', headers: {host, cookie}}, res => {
      res.once('data', chunk => { resolve(chunk.toString()); res.destroy(); });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
  assert.equal(data, 'data: ready\n\n');
});

function upgrade(headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let output = '';
    socket.on('error', reject);
    socket.on('connect', () => {
      const fields = {host, connection: 'Upgrade', upgrade: 'websocket', origin: `http://${host}`, cookie, 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers};
      socket.write(`GET /sites/app/socket HTTP/1.1\r\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\nclient-head`);
    });
    socket.on('data', chunk => {
      output += chunk;
      if (output.includes('peer-headclient-head') || output.startsWith('HTTP/1.1 403')) { socket.destroy(); resolve(output); }
    });
  });
}

test('authenticated WebSockets forward handshake and buffered bytes, while invalid access is rejected', async () => {
  const response = await upgrade();
  assert.match(response, /^HTTP\/1.1 101/);
  assert.match(response, /peer-headclient-head/);
  assert.equal(upstreamHeaders.cookie, '');
  assert.equal(upstreamHeaders.host, host);
  assert.match(await upgrade({cookie: ''}), /^HTTP\/1.1 403/);
  assert.match(await upgrade({origin: 'http://evil.example'}), /^HTTP\/1.1 403/);
  assert.match(await upgrade({host: 'evil.example'}), /^HTTP\/1.1 403/);
});

test('unregistering a site takes effect without restarting or deleting source files', async () => {
  const route = await readRoute(state, 'other');
  await fs.unlink(path.join(state, 'other.json'));
  assert.equal((await request('/sites/other/', {headers: {cookie: `site_access=${otherToken}`}})).status, 404);
  assert.match(await fs.readFile(path.join(route.path, 'index.html'), 'utf8'), /Hello/);
});
