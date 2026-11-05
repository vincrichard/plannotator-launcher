import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const prefix = `/reviews/${'a'.repeat(32)}/`;
const origin = 'http://127.0.0.1:19433';
const source = fs.readFileSync(new URL('./route-adapter.js', import.meta.url), 'utf8');
function adapter(fetch) {
  class Element { setAttribute() {} }
  const sandbox = {
    window: {fetch}, URL, Request, Response, Element,
    document: {baseURI: origin + prefix}, location: {origin},
    navigator: {sendBeacon() {}}, XMLHttpRequest: {prototype: {open() {}}},
  };
  for (const name of ['Image', 'Script', 'Link', 'IFrame', 'Anchor', 'Source', 'Media']) sandbox[`HTML${name}Element`] = class extends Element {};
  vm.runInNewContext(source.replace('__REVIEW_PREFIX__', JSON.stringify(prefix)), sandbox);
  return sandbox.window.fetch;
}

test('identical snapshot polls share one full transfer and independently readable responses', async () => {
  for (const route of ['external-annotations', 'agents/jobs']) {
    let calls = 0, controller;
    const fetch = adapter(async () => {
      calls++;
      return new Response(new ReadableStream({start(c) {controller = c;}}), {headers: {'content-type': 'application/json'}});
    });
    const first = fetch(`/api/${route}?since=1`);
    await new Promise(resolve => setImmediate(resolve)); // Headers have arrived, body is still pending.
    const second = fetch(`${origin}/api/${route}?since=1`);
    assert.equal(calls, 1, 'Do not queue another poll while the response body is pending');
    controller.enqueue(new TextEncoder().encode('{"version":2}'));
    controller.close();
    const responses = await Promise.all([first, second]);
    assert.notEqual(responses[0], responses[1]);
    assert.deepEqual(await Promise.all(responses.map(r => r.json())), [{version: 2}, {version: 2}]);
    const next = fetch(`/api/${route}?since=1`);
    assert.equal(calls, 2, 'Completed snapshots must not be cached');
    controller.close(); await next;
  }
});

test('versions, ordinary reads, explicit request options and mutations remain independent', async () => {
  const calls = [];
  const fetch = adapter(async (...args) => {calls.push(args); return new Response(null, {status: 304});});
  const routes = [
    ['/api/external-annotations?since=1'], ['/api/external-annotations?since=2'],
    ['/api/diff'], ['/api/diff'],
    ['/api/external-annotations', {method: 'POST', body: '{}'}],
    ['/api/external-annotations', {headers: {authorization: 'test'}}],
    ['/api/external-annotations', {signal: new AbortController().signal}],
    [new Request(origin + '/api/external-annotations')],
  ];
  const responses = await Promise.all(routes.map(args => fetch(...args)));
  assert.equal(calls.length, routes.length);
  assert.ok(responses.every(r => r.status === 304));
  assert.equal(calls[4][1].method, 'POST');
  assert.equal(calls[4][1].body, '{}');
  assert.equal(calls[7][0].url, origin + prefix + 'api/external-annotations');
});

test('a failed shared poll rejects its callers and allows the next poll to retry', async () => {
  let calls = 0;
  const fetch = adapter(async () => {if (++calls === 1) throw Error('offline'); return new Response('{}');});
  const failed = await Promise.allSettled([fetch('/api/agents/jobs'), fetch('/api/agents/jobs')]);
  assert.equal(calls, 1);
  assert.ok(failed.every(r => r.status === 'rejected' && r.reason.message === 'offline'));
  assert.deepEqual(await (await fetch('/api/agents/jobs')).json(), {});
  assert.equal(calls, 2);
});
