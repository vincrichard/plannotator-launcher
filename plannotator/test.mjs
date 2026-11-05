import assert from 'node:assert/strict';
import {stopTestReviews} from './test-durable-cleanup.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';

const root = path.dirname(new URL(import.meta.url).pathname);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'plannotator-proxy-test-'));
const reviewEnv = {PLANNOTATOR_REVIEW_STATE_DIR: path.join(temp, 'records'), PLANNOTATOR_REVIEW_NOTIFY: '0'};
const artifacts = path.join(root, 'test-artifacts');
await fs.mkdir(artifacts, {recursive: true});
const sessions = [];
let browser;
async function until(fn, description, ms = 45000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error(`Timed out: ${description}`);
}
async function dismissOnboarding(page) {
  for (let i=0; i<5; i++) {
    await page.waitForTimeout(250);
    for (const name of ['Continue', 'Done', 'Got it']) {
      const button = page.getByRole('button', {name, exact:true});
      if (await button.isVisible()) await button.click();
    }
  }
}
async function launch(label) {
  const patch = path.join(temp, `${label}.diff`);
  await fs.writeFile(patch, `diff --git a/demo.js b/demo.js\nindex 1234567..7654321 100644\n--- a/demo.js\n+++ b/demo.js\n@@ -1 +1 @@\n-console.log('before');\n+console.log('${label}');\n`);
  const child = spawn(path.join(root, 'mobile.py'), ['--patch-file', patch], {env: {...process.env, ...reviewEnv, PLANNOTATOR_AI: 'disabled', PLANNOTATOR_SHARE: 'disabled'}});
  const session = {child, stdout: '', stderr: '', code: null, label};
  sessions.push(session);
  child.stdout.on('data', b => session.stdout += b);
  child.stderr.on('data', b => session.stderr += b);
  child.on('exit', code => session.code = code);
  await until(() => /Mobile:  (\S+)/.test(session.stderr), `launch ${label}`);
  session.url = /Mobile:  (\S+)/.exec(session.stderr)[1];
  session.base = new URL('.', session.url).href;
  return session;
}
try {
  const [a, b] = await Promise.all([launch('ALPHA'), launch('BRAVO')]);
  assert.notEqual(a.base, b.base);
  assert.equal((await fetch(a.base)).status, 401);
  const wrong = new URL(a.url); wrong.searchParams.set('access', new URL(b.url).searchParams.get('access'));
  assert.equal((await fetch(wrong)).status, 401);
  wrong.searchParams.set('access', 'é'.repeat(64));
  assert.equal((await fetch(wrong)).status, 401);
  assert.equal((await fetch(a.url, {headers: {origin: 'https://evil.invalid'}})).status, 403);
  assert.equal(await new Promise(resolve => http.get('http://127.0.0.1:19433/health', {headers: {host: 'evil.invalid'}}, res => {res.resume(); resolve(res.statusCode)})), 403);
  console.log('PASS: authentication, cross-session tokens, Host and Origin guards');
  browser = await chromium.launch({headless: true});
  const context = await browser.newContext({viewport: {width: 393, height: 851}, isMobile: true, hasTouch: true, deviceScaleFactor: 1});
  const pages = await Promise.all([context.newPage(), context.newPage()]);
  const unexpected = [], errors = [];
  for (const [i, page] of pages.entries()) {
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', req => { const u = new URL(req.url()); if (u.protocol === 'http:' && u.origin === new URL(sessions[i].base).origin && u.pathname !== '/manifest.webmanifest' && !/^\/ui\/[a-f0-9]{64}\.(js|css)$/.test(u.pathname) && !u.pathname.startsWith('/launcher/icon-') && !u.pathname.startsWith(new URL(sessions[i].base).pathname)) unexpected.push(u.pathname); });
    await page.goto([a,b][i].url, {waitUntil: 'domcontentloaded'});
    await page.getByText('demo.js', {exact: false}).first().waitFor();
    assert.equal(new URL(page.url()).search, '');
    await dismissOnboarding(page);
    await page.screenshot({path: path.join(artifacts, `mobile-${i + 1}.png`), fullPage: true});
    const data = await page.evaluate(() => fetch('/api/diff').then(r => r.json()));
    assert.ok(JSON.stringify(data).includes([a,b][i].label));
    assert.ok(!JSON.stringify(data).includes([b,a][i].label));
    const asset = await page.evaluate(() => fetch('/favicon.png').then(r => ({status:r.status, type:r.headers.get('content-type')})));
    assert.equal(asset.status, 200); assert.match(asset.type, /image/);
    const width = await page.evaluate(() => ({inner: innerWidth, scroll: document.documentElement.scrollWidth}));
    assert.ok(width.scroll <= width.inner + 1, JSON.stringify(width));
  }
  console.log('PASS: two authenticated mobile pages, distinct diffs and prefixed assets');
  // Observe versioned snapshots without holding a browser connection open.
  for (const page of pages) await page.evaluate(() => {
    window.reviewEvents = [];
    window.reviewPoll = setInterval(async () => {
      const data = await fetch('/api/external-annotations').then(r => r.json());
      window.reviewEvents.push(data);
    }, 500);
  });
  for (const page of pages) await page.waitForFunction(() => window.reviewEvents.length > 0);
  for (const [i, page] of pages.entries()) {
    const status = await page.evaluate(async label => {
      const response = await fetch('/api/external-annotations', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({source:'codex', scope:'line', filePath:'demo.js', lineStart:1, lineEnd:1, text:`Please fix ${label} only`})});
      return response.status;
    }, [a,b][i].label);
    assert.equal(status, 201);
    await page.waitForFunction(label => JSON.stringify(window.reviewEvents).includes(label), [a,b][i].label);
    assert.ok(!(await page.evaluate(() => JSON.stringify(window.reviewEvents))).includes([b,a][i].label));
    await page.waitForTimeout(300);
    await page.getByRole('button', {name:'Options', exact:true}).click();

    await page.screenshot({path:path.join(artifacts, `mobile-${i+1}.png`),fullPage:true});
  }
  console.log('PASS: Polled snapshots and live annotation updates remain isolated');
  // The same review also retains Plannotator's native tablet and desktop layouts.
  await pages[1].getByRole('button', {name:'Options', exact:true}).click();
  for (const [name, width, height] of [['tablet', 820, 1180], ['desktop', 1440, 900]]) {
    await pages[1].setViewportSize({width,height});
    await dismissOnboarding(pages[1]);
    await pages[1].screenshot({path:path.join(artifacts, `${name}.png`),fullPage:true});
    assert.ok(await pages[1].evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  const desktopContext = await browser.newContext({viewport:{width:1440,height:900}, storageState:await context.storageState()});
  const desktop = await desktopContext.newPage();
  await desktop.goto(b.url,{waitUntil:'domcontentloaded'});
  await desktop.getByText('demo.js',{exact:false}).first().waitFor();
  await dismissOnboarding(desktop);
  const restore = desktop.getByRole('button',{name:'Restore',exact:true});
  if (await restore.isVisible()) await restore.click();
  await desktop.getByRole('button',{name:/Send feedback/i}).first().waitFor();
  await desktop.screenshot({path:path.join(artifacts,'desktop.png'),fullPage:true});
  assert.ok(await desktop.getByRole('button',{name:/Send feedback/i}).first().isVisible());
  await desktopContext.close();
  await pages[1].setViewportSize({width:393,height:851});
  await pages[1].getByRole('button', {name:'Options', exact:true}).click();
  // Preserve upstream stale-session protection as well as proxy authentication.
  assert.equal(await pages[0].evaluate(() => fetch('/api/feedback', {method:'POST',headers:{'content-type':'application/json'}, body:JSON.stringify({serverSession:'wrong-session',feedback:'must not deliver',annotations:[]})}).then(r=>r.status)),409);
  for (const page of pages) await page.evaluate(() => clearInterval(window.reviewPoll));
  // Submit via the actual mobile buttons, then check each originating process's stdout.
  await pages[0].getByRole('button', {name:/^Send feedback/}).click();
  await until(() => a.code !== null, 'ALPHA decision');
  assert.equal(a.code, 0);
  assert.equal(b.code, null, 'BRAVO must still wait for its own reviewer');
  const first = JSON.parse(a.stdout.trim());
  assert.equal(first.decision, 'annotated');
  assert.match(first.message, /Please fix ALPHA only/);
  assert.doesNotMatch(first.message, /BRAVO/);
  assert.equal((await fetch(a.base)).status,410);
  await pages[1].getByRole('button', {name:/^Send feedback/}).click();
  await until(() => b.code !== null, 'BRAVO decision');
  assert.equal(b.code,0);
  const second = JSON.parse(b.stdout.trim());
  assert.equal(second.decision,'annotated');
  assert.match(second.message,/Please fix BRAVO only/);
  assert.doesNotMatch(second.message,/ALPHA/);
  console.log('PASS: mobile feedback buttons returned isolated JSON to each launcher; ended routes return 410');

  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  console.log('PASS: all browser requests stayed under their own session prefix; no JS errors');
} finally {
  await browser?.close();
  await stopTestReviews(reviewEnv.PLANNOTATOR_REVIEW_STATE_DIR);
  for (const s of sessions) if (s.code === null) s.child.kill('SIGTERM');
  await fs.rm(temp, {recursive: true, force: true});
}
