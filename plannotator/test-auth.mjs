import assert from 'node:assert/strict';
import {stopTestReviews} from './test-durable-cleanup.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chromium, firefox} from 'playwright';
import {measureLoading} from './measure-loading.mjs';

const root = path.dirname(new URL(import.meta.url).pathname);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'plannotator-auth-test-'));
const reviewEnv = {PLANNOTATOR_REVIEW_STATE_DIR: path.join(temp, 'records'), PLANNOTATOR_REVIEW_NOTIFY: '0'};
const children = [];
const engine = process.env.TEST_BROWSER === 'firefox' ? firefox : chromium;
let browser;
function start(command, args, env = {}) {
  const child = spawn(command, args, {cwd: root, env: {...process.env, ...reviewEnv, ...env}, stdio: 'ignore'});
  child.on('error', () => {});
  children.push(child);
  return child;
}
async function until(fn) {
  for (let i = 0; i < 300; i++) {
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Timed out waiting for disposable test service');
}
try {
  // Keep the shared proxy and all user reviews completely outside this test.
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const siteState = path.join(temp, 'sites');
  await fs.mkdir(siteState, {mode: 0o700});
  start(process.execPath, [process.env.PROXY_ENTRY || path.join(root, 'proxy.mjs'), temp, String(port), siteState]);
  await until(async () => {
    try { return (await fetch(`${origin}/health`)).ok; } catch { return false; }
  });
  const sessions = [];
  for (const label of ['ALPHA', 'BRAVO']) {
    const patch = path.join(temp, `${label}.diff`);
    await fs.writeFile(patch, `diff --git a/demo.js b/demo.js\nindex 1234567..7654321 100644\n--- a/demo.js\n+++ b/demo.js\n@@ -1 +1 @@\n-console.log('before');\n+console.log('${label}');\n`);
    const title = label === 'ALPHA' ? 'Session expiry — ALPHA' : 'BRAVO </script><script>window.titleInjected=1</script> $&';
    // Run the actual launcher with its state and port redirected to this test's proxy.
    start('python3', ['-c', `import runpy, sys\nfrom pathlib import Path\nm = runpy.run_path(sys.argv[1])\ng = m['main'].__globals__\ng['STATE'] = Path(sys.argv[2])\ng['PORT'] = int(sys.argv[3])\nsys.argv = [sys.argv[1], *sys.argv[4:]]\nm['main']()`, path.join(root, 'mobile.py'), temp, String(port), '--title', title, '--patch-file', patch], {PLANNOTATOR_AI: 'disabled', PLANNOTATOR_SHARE: 'disabled'});
    let id, session;
    await until(async () => {
      for (const name of await fs.readdir(temp)) {
        if (!/^[a-f0-9]{32}$/.test(name)) continue;
        try {
          const candidate = JSON.parse(await fs.readFile(path.join(temp, name, 'route.json'), 'utf8'));
          if (candidate.title === title) { id = name; session = candidate; return true; }
        } catch {}
      }
      return false;
    });
    const {token} = session;
    const prefix = `/reviews/${id}/`;
    sessions.push({label, title, prefix, token, upstreamPort: session.port, base: origin + prefix, url: `${origin}${prefix}?access=${token}`});
  }
  const [a, b] = sessions;
  const sharedAssets = [];
  const known = JSON.parse(await fs.readFile(path.join(root, 'server/bundles.json'), 'utf8'));
  for (const session of sessions) {
    const response = await fetch(session.base, {headers: {cookie: `pr_access=${session.token}`}});
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text();
    const upstream = await (await fetch(`http://127.0.0.1:${session.upstreamPort}/`)).text();
    const expected = [];
    for (const [, tag, body] of upstream.matchAll(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
      const hash = createHash('sha256').update(body).digest('hex');
      if (known[tag.toLowerCase()].includes(hash)) expected.push(`/ui/${hash}.${tag.toLowerCase() === 'script' ? 'js' : 'css'}`);
      else assert.ok(html.includes(body), 'Unrecognized inline content must remain private and unchanged');
    }
    const assets = [...new Set(html.match(/\/ui\/[a-f0-9]{64}\.(?:js|css)/g))].sort();
    assert.deepEqual(assets, [...new Set(expected)].sort());
    sharedAssets.push(assets);
  }
  assert.equal(sharedAssets[0].length, 2, 'Installed UI must have both bundles pinned; update verified hashes after a build');
  assert.deepEqual(sharedAssets[0], sharedAssets[1], 'Concurrent reviews must reuse identical bundle URLs');
  for (const asset of sharedAssets[0]) {
    const response = await fetch(origin + asset, {headers: {'accept-encoding': 'gzip'}});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const body = await response.arrayBuffer();
    assert.ok(Number(response.headers.get('content-length')) < body.byteLength);
    const cached = await fetch(origin + asset, {headers: {'if-none-match': response.headers.get('etag')}});
    assert.equal(cached.status, 304);
    assert.equal((await cached.arrayBuffer()).byteLength, 0);
    const head = await fetch(origin + asset, {method: 'HEAD'});
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await fetch(origin + asset, {method: 'POST'})).status, 405);
    assert.equal((await fetch(origin + asset, {headers: {origin: 'http://hostile.test'}})).status, 403);
  }
  assert.equal((await fetch(`${origin}/ui/${'0'.repeat(64)}.js`)).status, 404);
  console.log('PASS: private inline fallback, allowlisted immutable bundles, cache validation, and asset guards');
  browser = await engine.launch({headless: true});
  if (process.env.MEASURE_LOADING === '1' && engine === chromium) {
    let baselineOrigin;
    if (process.env.BASELINE_PROXY) {
      const reservation = http.createServer();
      await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
      const baselinePort = reservation.address().port;
      await new Promise(resolve => reservation.close(resolve));
      baselineOrigin = `http://127.0.0.1:${baselinePort}`;
      start(process.execPath, [process.env.BASELINE_PROXY, temp, String(baselinePort)]);
      await until(async () => {
        try { return (await fetch(`${baselineOrigin}/health`)).ok; } catch { return false; }
      });
    }
    const token = (await fs.readFile(path.join(temp, 'launcher-token'), 'utf8')).trim();
    await measureLoading(browser, sessions, origin, token, baselineOrigin);
  }
  // No Playwright request routing here: interception disables the browser's HTTP cache.
  const cachedContext = await browser.newContext({viewport: {width: 393, height: 851}, hasTouch: true});
  const cachedPage = await cachedContext.newPage();
  const pageErrors = [];
  cachedPage.on('pageerror', error => pageErrors.push(error.message));
  await cachedPage.goto(a.url);
  await cachedPage.getByText('demo.js', {exact: false}).first().waitFor();
  const launcherSecret = (await fs.readFile(path.join(temp, 'launcher-token'), 'utf8')).trim();
  await cachedPage.goto(`${origin}/?unlock=${launcherSecret}`);
  await cachedPage.getByRole('link', {name: `Open ${b.title}`, exact: true}).click();
  await cachedPage.getByText('demo.js', {exact: false}).first().waitFor();
  const warmAssets = await cachedPage.evaluate(() => performance.getEntriesByType('resource')
    .filter(entry => new URL(entry.name).pathname.startsWith('/ui/'))
    .map(entry => ({transfer: entry.transferSize, decoded: entry.decodedBodySize})));
  assert.equal(warmAssets.length, sharedAssets[1].length);
  assert.ok(warmAssets.every(asset => asset.transfer === 0 && asset.decoded > 0), 'Opening another review from the launcher must reuse every allowlisted cached bundle');
  assert.deepEqual(pageErrors, []);
  // Interception disables caching, so exercise slow polling only after the cache assertions.
  let snapshotReads = 0;
  await cachedPage.route('**/api/external-annotations?since=2147483647', async route => {
    snapshotReads++;
    await new Promise(resolve => setTimeout(resolve, 100));
    await route.fulfill({contentType: 'application/json', body: '{"version":1,"annotations":[]}'});
  });
  const snapshots = await cachedPage.evaluate(() => Promise.all(Array.from({length: 5}, () =>
    fetch('/api/external-annotations?since=2147483647').then(r => r.json()))));
  assert.equal(snapshotReads, 1, 'Overlapping snapshot polls must share one network transfer');
  assert.ok(snapshots.every(snapshot => snapshot.version === 1 && snapshot.annotations.length === 0));
  await cachedPage.evaluate(() => fetch('/api/external-annotations?since=2147483647').then(r => r.json()));
  assert.equal(snapshotReads, 2, 'A completed snapshot must not be reused by a later poll');
  console.log(`PASS (${engine.name()}): slow snapshot polls share a transfer and later polls fetch fresh data`);
  await cachedContext.close();
  console.log(`PASS (${engine.name()}): launcher opens a second review with cached allowlisted bundles and no JavaScript errors`);
  const tabsContext = await browser.newContext();
  const tabs = [];
  for (let i = 0; i < 4; i++) {
    const tab = await tabsContext.newPage();
    tabs.push(tab);
    await tab.goto(i % 2 ? b.url : a.url);
    await tab.getByText('demo.js', {exact: false}).first().waitFor();
    // With permanent streams, the third tab consumes connection six and this hangs.
    assert.equal(await tabs[0].evaluate(() => fetch('/api/diff', {signal: AbortSignal.timeout(5000)}).then(r => r.status)), 200);
  }
  await tabsContext.close();
  console.log('PASS: four review tabs leave connections available for API requests');
  const context = await browser.newContext({viewport: {width: 393, height: 851}, ...(engine === chromium ? {isMobile: true} : {}), hasTouch: true});
  const page = await context.newPage();
  await page.goto(origin);
  await page.getByRole('link', {name: `Open ${a.title}`, exact: true}).waitFor();
  assert.equal(await page.locator('#reviews li').count(), 2);
  if (engine === chromium) {
    const cdp = await context.newCDPSession(page);
    assert.deepEqual((await cdp.send('Page.getAppManifest')).errors, []);
    assert.deepEqual((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors, []);
    await cdp.detach();
  }
  assert.equal((await fetch(`${origin}/launcher/mobile.py`)).status, 404);
  assert.equal((await fetch(origin, {method: 'POST'})).status, 405);
  const launcher = await fetch(`${origin}/reviews/`, {redirect: 'manual'});
  assert.equal(launcher.status, 200);
  assert.equal(launcher.headers.get('location'), null);
  assert.equal(page.url(), `${origin}/reviews/`);
  const manifest = await (await fetch(`${origin}/manifest.webmanifest`)).json();
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/reviews/');
  assert.equal(manifest.scope, '/reviews/');
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) {
    const response = await fetch(origin + icon.src);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const png = Buffer.from(await response.arrayBuffer());
    assert.equal(png.readUInt32BE(16), Number(icon.sizes.split('x')[0]));
  }
  if (process.env.PROXY_ENTRY) {
    const siteToken = 'c'.repeat(64);
    await fs.writeFile(path.join(siteState, 'hello.json'), JSON.stringify({kind: 'directory', path: path.resolve(root, '../sites/demo'), token: siteToken}));
    const siteContext = await browser.newContext({viewport: {width: 390, height: 844}});
    const sitePage = await siteContext.newPage();
    await siteContext.route('http://site-entry.test/', route => route.fulfill({contentType: 'text/html', body: `<a href="${origin}/sites/hello/?access=${siteToken}">Open website</a>`}));
    await sitePage.goto('http://site-entry.test/');
    await sitePage.getByRole('link', {name: 'Open website'}).click();
    await sitePage.waitForURL(`${origin}/sites/hello/`);
    await sitePage.getByRole('button', {name: 'Tap to test'}).click();
    assert.equal(await sitePage.getByRole('status').textContent(), 'Tap received! 1 tap so far.');
    assert.equal(new URL(sitePage.url()).origin, origin);
    assert.ok(!new URL(sitePage.url()).pathname.startsWith(manifest.scope));
    assert.equal(await sitePage.locator('link[rel="manifest"]').count(), 0);
    assert.equal(await sitePage.evaluate(() => navigator.serviceWorker.getRegistrations().then(registrations => registrations.length)), 0);
    assert.equal((await siteContext.cookies()).find(cookie => cookie.name === 'site_access').path, '/sites/hello/');
    await siteContext.close();
    console.log('PASS: generated site opens from another origin on the same IP/port, outside /reviews/, without registering a service worker');
  }
  // A direct visit succeeds even with the original broken Strict cookie.
  assert.equal((await page.goto(a.url)).status(), 200);
  await context.clearCookies();
  console.log('PASS: direct access-link navigation');
  await context.route('http://entry.test/', route => route.fulfill({contentType: 'text/html', body: `<a href="${a.url}">Open review</a>`}));
  await page.goto('http://entry.test/');
  const landing = page.waitForResponse(r => r.url() === a.base && r.request().isNavigationRequest());
  await page.getByRole('link', {name: 'Open review'}).click();
  const response = await landing;
  assert.equal(response.status(), 200, 'Cross-site access-link redirect must authenticate (401 means the reported entry error)');
  assert.equal(new URL(page.url()).search, '');
  assert.equal((await page.reload()).status(), 200);
  console.log('PASS: cross-site anchor, token removal, and reload');

  const fromHerdr = await browser.newContext();
  const entry = await fromHerdr.newPage();
  await entry.route(`http://localhost:${port}/`, route => route.fulfill({contentType: 'text/html', body: `<a href="${a.url}" target="_blank" rel="noopener noreferrer">Open review</a>`}));
  await entry.goto(`http://localhost:${port}/`);
  const popup = fromHerdr.waitForEvent('page');
  await entry.getByRole('link', {name: 'Open review'}).click();
  const reviewTab = await popup;
  await reviewTab.getByText('demo.js', {exact: false}).first().waitFor();
  assert.equal(new URL(reviewTab.url()).hostname, '127.0.0.1');
  await reviewTab.close();
  assert.equal(entry.isClosed(), false);
  await fromHerdr.close();
  console.log('PASS: localhost source opens IP review in a new tab and source survives closing it');

  assert.equal((await context.request.get(b.base)).status(), 401);
  const second = await context.newPage();
  assert.equal((await second.goto(b.url)).status(), 200);
  for (const [i, tab] of [page, second].entries()) {
    await tab.getByText('demo.js', {exact: false}).first().waitFor();
    const data = await tab.evaluate(() => fetch('/api/diff').then(r => r.json()));
    assert.ok(JSON.stringify(data).includes(sessions[i].label));
    assert.ok(!JSON.stringify(data).includes(sessions[1 - i].label));
    assert.equal(await tab.evaluate(() => fetch('/favicon.png').then(r => r.status)), 200);
    assert.ok(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.ok(!(await tab.evaluate(() => document.cookie)).includes('pr_access'));
    assert.equal(await tab.evaluate(() => window.titleInjected), undefined);
    assert.equal(await tab.locator('link[rel="manifest"]').getAttribute('href'), '/manifest.webmanifest');
    assert.equal(await tab.evaluate(() => fetch('/api/external-annotations/stream').then(r => r.status)), 503);
    assert.equal(await tab.evaluate(() => fetch('/api/agents/jobs/stream').then(r => r.status)), 503);
    assert.equal(await tab.evaluate(() => fetch('/api/external-annotations').then(r => r.status)), 200);
  }
  const cookies = (await context.cookies()).filter(c => c.name === 'pr_access');
  assert.equal(cookies.length, 2);
  for (const session of sessions) {
    assert.ok(cookies.some(c => c.path === session.prefix && c.httpOnly));
    assert.equal((await fetch(session.base)).status, 401);
    assert.equal((await fetch(`${session.base}?access=wrong`)).status, 401);
  }
  assert.equal((await fetch(a.base, {headers: {cookie: `pr_access=${b.token}`}})).status, 401);
  assert.equal((await fetch(`${a.base}?access=${b.token}`)).status, 401);
  assert.equal((await fetch(`${a.base}?access=${'é'.repeat(64)}`)).status, 401);
  assert.equal((await fetch(a.base, {headers: {cookie: `pr_access=${a.token}`, origin: 'http://entry.test'}})).status, 403);
  assert.equal((await fetch(`${a.base}api/diff`, {headers: {cookie: `pr_access=${a.token}`, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors'}})).status, 403);
  // Harmless nonexistent endpoint: no feedback, approval, or annotation is submitted.
  assert.equal((await fetch(`${a.base}auth-test-only`, {method: 'POST', headers: {cookie: `pr_access=${a.token}`, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate'}})).status, 403);
  assert.equal(await new Promise((resolve, reject) => {
    http.get(`${origin}/health`, {headers: {host: 'entry.test'}}, res => {res.resume(); resolve(res.statusCode);}).on('error', reject);
  }), 403);
  console.log('PASS: two mobile diffs, assets, snapshot polling, HttpOnly/path scoping, authentication and Host/Origin/CSRF guards');

  const token = (await fs.readFile(path.join(temp, 'launcher-token'), 'utf8')).trim();
  assert.equal((await fs.stat(path.join(temp, 'launcher-token'))).mode & 0o777, 0o600);
  const unlock = `${origin}/reviews/?unlock=${token}`;
  const listURL = `${origin}/reviews/launcher/reviews`;
  const openURL = `${origin}/reviews/launcher/open/${a.prefix.split('/')[2]}`;
  assert.equal((await fetch(listURL)).status, 200);
  assert.equal((await fetch(openURL, {redirect: 'manual'})).status, 303);
  assert.equal((await fetch(listURL, {headers: {cookie: `pr_access=${a.token}`}})).status, 200);
  assert.equal((await fetch(`${origin}/?unlock=wrong`)).status, 401);
  assert.equal((await fetch(listURL, {headers: {cookie: `pr_launcher=${token}`, origin: 'http://entry.test'}})).status, 403);
  assert.equal((await fetch(listURL, {headers: {cookie: `pr_launcher=${token}`, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors'}})).status, 403);
  assert.equal((await fetch(listURL, {method: 'POST', headers: {cookie: `pr_launcher=${token}`}})).status, 405);
  await context.clearCookies();
  await context.addCookies([{name: 'pr_launcher', value: token, domain: '127.0.0.1', path: '/launcher/', httpOnly: true, sameSite: 'Lax'}]);
  await page.goto(`${origin}/reviews/`);
  await page.getByRole('link', {name: `Open ${a.title}`, exact: true}).waitFor();
  assert.equal((await context.request.get(listURL)).status(), 200);
  assert.ok((await page.getByRole('link', {name: `Open ${a.title}`, exact: true}).getAttribute('href')).startsWith('/reviews/'));
  await context.clearCookies();
  await context.route('http://unlock.test/', route => route.fulfill({contentType: 'text/html', body: `<a href="${unlock}">Unlock</a>`}));
  await page.goto('http://unlock.test/');
  await page.getByRole('link', {name: 'Unlock', exact: true}).click();
  await page.getByRole('link', {name: `Open ${a.title}`, exact: true}).waitFor();
  assert.equal(new URL(page.url()).search, '');
  assert.equal(new URL(page.url()).pathname, '/reviews/');
  assert.equal(await page.locator('#reviews li').count(), 2);
  assert.ok((await page.locator('#reviews').innerText()).includes(b.title));
  assert.equal(await page.evaluate(() => window.titleInjected), undefined);
  const listing = await page.evaluate(() => fetch('/reviews/launcher/reviews').then(r => r.text()));
  assert.ok(!listing.includes(a.token) && !listing.includes(b.token) && !listing.includes(token));
  assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(token));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const dashboardCookie = (await context.cookies()).find(c => c.name === 'pr_launcher' && c.path === '/reviews/launcher/');
  assert.ok(dashboardCookie.httpOnly);
  assert.ok(!(await context.cookies(a.base)).some(c => c.name === 'pr_launcher'));
  await fs.mkdir(path.join(root, 'test-artifacts'), {recursive: true});
  await page.screenshot({path: path.join(root, `test-artifacts/launcher-${engine.name()}.png`), fullPage: true});
  await context.clearCookies();
  await page.getByRole('link', {name: `Open ${a.title}`, exact: true}).click();
  await page.waitForURL(a.base);
  await page.getByText('demo.js', {exact: false}).first().waitFor();
  assert.equal((await context.request.get(b.base)).status(), 401);
  await page.goto(origin);
  await page.getByRole('link', {name: `Open ${b.title}`, exact: true}).click();
  await page.waitForURL(b.base);
  await page.getByText('demo.js', {exact: false}).first().waitFor();
  await page.goto(origin);
  await page.getByRole('link', {name: `Open ${b.title}`, exact: true}).waitFor();
  await fs.unlink(path.join(temp, b.prefix.split('/')[2], 'route.json'));
  await page.waitForFunction(() => document.querySelectorAll('#reviews li').length === 1, null, {timeout: 12000});
  assert.equal((await context.request.get(`${origin}/reviews/launcher/open/${b.prefix.split('/')[2]}`)).status(), 410);
  const fresh = await browser.newContext();
  const freshPage = await fresh.newPage();
  await freshPage.goto(origin);
  await freshPage.getByRole('link', {name: `Open ${a.title}`, exact: true}).waitFor();
  assert.equal(await freshPage.locator('#reviews li').count(), 1);
  assert.equal((await freshPage.goto(a.base)).status(), 401);
  assert.equal((await freshPage.goto(a.url)).status(), 200);
  await freshPage.getByText('demo.js', {exact: false}).first().waitFor();
  assert.equal((await fresh.request.get(listURL)).status(), 200);
  console.log(`PASS (${engine.name()}): original review link works and a fresh browser can list reviews without an unlock`);
  await fresh.close();
  const legacyFile = path.join(temp, a.prefix.split('/')[2], 'route.json');
  const legacy = JSON.parse(await fs.readFile(legacyFile, 'utf8'));
  delete legacy.title;
  await fs.writeFile(legacyFile, JSON.stringify(legacy));
  await page.getByRole('button', {name: 'Refresh', exact: true}).click();
  await page.getByRole('link', {name: `Open Review ${a.prefix.split('/')[2].slice(0, 8)}`, exact: true}).waitFor();
  await fs.unlink(legacyFile);
  await page.getByRole('button', {name: 'Refresh', exact: true}).click();
  await page.getByText('No saved or running reviews. New reviews will appear here automatically.').waitFor();
  await context.clearCookies();
  await page.getByRole('button', {name: 'Refresh', exact: true}).click();
  await page.getByText('No saved or running reviews. New reviews will appear here automatically.').waitFor();
  assert.equal((await context.request.get(listURL)).status(), 200);
  console.log('PASS: no-unlock running list, safe titles, legacy unlock, one-click opening, cookie scoping and empty state after clearing cookies');

} finally {
  await browser?.close();
  await stopTestReviews(reviewEnv.PLANNOTATOR_REVIEW_STATE_DIR);
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => {clearTimeout(timer); resolve();});
    child.kill('SIGTERM');
  })));
  await fs.rm(temp, {recursive: true, force: true});
}
