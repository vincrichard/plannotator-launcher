import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createSessionStore} from './server/sessions.mjs';

test('home uses creation time, checks live identities and retains suspended reviews', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-session-test-'));
  const state = path.join(root, 'routes'); fs.mkdirSync(state);
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const started = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const make = (n, title, created, overrides = {}, routeOverrides = {}) => {
    const id = String(n).padStart(32, '0'), record = path.join(root, 'records', id), route = path.join(state, id);
    fs.mkdirSync(record, {recursive: true}); fs.mkdirSync(route);
    fs.writeFileSync(path.join(record, 'session.json'), JSON.stringify({id, title, created_at: created, status: 'running',
      review_pid: process.pid, review_start: started, supervisor_pid: process.pid, supervisor_start: started, ...overrides}));
    fs.writeFileSync(path.join(route, 'route.json'), JSON.stringify({record, status: 'running', port: 12345, pid: process.pid, title, token: 'private', ...routeOverrides}));
    return {id, record};
  };
  try {
    const old = make(1, 'Alpha', 100, {resumed_at: 9999});
    const newest = make(2, 'Zulu', 300);
    const saved = make(3, 'Saved', 200, {status: 'suspended'}, {status: 'suspended', pid: undefined, port: undefined});
    const stale = [make(4, 'Ended', 900, {status: 'completed'}), make(5, 'Reused pid', 900, {review_start: '0'}),
      make(6, 'Lost owner', 900, {supervisor_start: '0'}), make(7, 'Wrong pid', 900, {review_pid: process.pid + 1})];
    const store = createSessionStore(state);
    assert.deepEqual(store.list().map(r => r.id), [newest.id, saved.id, old.id]);
    for (const item of stale) assert.throws(() => store.read(item.id));
    assert.equal(store.read(saved.id).status, 'suspended');
    fs.writeFileSync(path.join(newest.record, 'cancel'), '');
    assert.equal(store.list()[0].closing, true);
    assert.ok(!JSON.stringify(store.list()).includes('private'));
    assert.ok(fs.existsSync(path.join(stale[0].record, 'session.json')), 'Listing never deletes retained data');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('legacy reviews use route timestamp and a live positive PID', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-session-test-'));
  try {
    for (const [n, pid] of [[1, process.pid], [2, -1]]) {
      const dir = path.join(root, String(n).padStart(32, '0')); fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'route.json'), JSON.stringify({pid, port: 12345, title: 'Legacy'}));
      fs.utimesSync(path.join(dir, 'route.json'), 150, 150);
    }
    const rows = createSessionStore(root).list();
    assert.equal(rows.length, 1); assert.equal(rows[0].createdAt, 150000); assert.equal(rows[0].status, 'running');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
