import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { fetch, fixture, signup } from './helpers/http.js';

const exec = promisify(execFile);
const root = new URL('../', import.meta.url);

test('accepts arbitrary projects, deduplicates within a project, and keeps the original IP and timestamp', async t => {
  const f = await fixture(t);
  const first = await signup(f.url, { project: ' Rocket 🚀 ', email: ' Person+launch@Example.com ' }, {
    'X-Forwarded-For': '203.0.113.50',
  });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true });
  assert.equal((await signup(f.url, { project: 'Rocket 🚀', email: 'person+launch@example.com' })).status, 200);
  assert.equal((await signup(f.url, { project: 'Another project', email: 'person+launch@example.com' })).status, 200);
  const rows = f.rows();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].project, 'Rocket 🚀');
  assert.equal(rows[0].email, 'person+launch@example.com');
  assert.equal(rows[0].ip, '127.0.0.1');
  assert.ok(Number.isFinite(Date.parse(rows[0].created_at)));
});

test('supports cross-origin JSON preflights and URL-encoded form submissions', async t => {
  const f = await fixture(t, { rateLimit: 1 });
  const preflight = await fetch(`${f.url}/signup`, {
    method: 'OPTIONS', headers: { Origin: 'https://any-project.example', 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.match(preflight.headers.get('access-control-allow-headers'), /Content-Type/);
  const result = await fetch(`${f.url}/signup`, {
    method: 'POST', body: new URLSearchParams({ project: 'Form project', email: 'form@example.com' }),
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('access-control-allow-origin'), '*');
  assert.equal(f.rows()[0].project, 'Form project');
});

test('persists the global IP quota across restarts and expires it', async t => {
  let timestamp = 1_700_000_000_000;
  const f = await fixture(t, { rateLimit: 2 }, { now: () => timestamp });
  assert.equal((await signup(f.url)).status, 200);
  assert.equal((await signup(f.url, { project: 'other', email: 'a@example.com' })).status, 200);
  await f.close();
  const restarted = await f.start();
  const blocked = await signup(restarted.url, { project: 'third', email: 'b@example.com' }, { 'X-Forwarded-For': '198.51.100.1' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '600');
  assert.equal(blocked.headers.get('access-control-allow-origin'), '*');
  assert.equal(f.rows().length, 2);
  timestamp += 600_000;
  assert.equal((await signup(restarted.url, { project: 'third', email: 'b@example.com' })).status, 200);
  assert.equal(f.rows().length, 3);
});

test('uses only trusted forwarding hops and groups IPv6 privacy addresses into one quota', async t => {
  const f = await fixture(t, { rateLimit: 1, trustedProxies: '127.0.0.1/32,10.0.0.0/8' });
  assert.equal((await signup(f.url, undefined, { 'X-Forwarded-For': '192.0.2.1, 2001:db8::1, 10.1.2.3' })).status, 200);
  assert.equal(f.rows()[0].ip, '2001:db8::1');
  assert.equal((await signup(f.url, undefined, { 'X-Forwarded-For': '192.0.2.2, 2001:0db8:0:0::2, 10.1.2.3' })).status, 429);
  assert.equal((await signup(f.url, { project: 'v4', email: 'v4@example.com' }, { 'X-Forwarded-For': '::ffff:198.51.100.1' })).status, 200);
  assert.equal(f.rows()[1].ip, '198.51.100.1');
  assert.equal((await signup(f.url, undefined, { 'X-Forwarded-For': '198.51.100.1' })).status, 429);
});

test('concurrent attempts cannot overrun the IP quota', async t => {
  const f = await fixture(t, { rateLimit: 3 });
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    signup(f.url, { project: 'concurrent', email: `p${i}@example.com` })));
  assert.equal(responses.filter(r => r.status === 200).length, 3);
  assert.equal(responses.filter(r => r.status === 429).length, 9);
  assert.equal(f.rows().length, 3);
});

test('rejects malformed inputs and oversized bodies without saving them', async t => {
  const f = await fixture(t, { rateLimit: 100 });
  for (const input of [null, [], {}, { project: '', email: 'a@example.com' },
    { project: 'x'.repeat(121), email: 'a@example.com' }, { project: 'bad\nname', email: 'a@example.com' },
    { project: 'ok', email: 'bad' }, { project: 'ok', email: 'a..b@example.com' },
    { project: 'ok', email: 'a@-example.com' }, { project: 1, email: 'a@example.com' }]) {
    assert.equal((await signup(f.url, input)).status, 400);
  }
  assert.equal((await fetch(`${f.url}/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' })).status, 400);
  assert.equal((await fetch(`${f.url}/signup`, { method: 'POST', body: 'hello' })).status, 415);
  assert.equal((await signup(f.url, { project: 'ok', email: 'a@example.com', padding: 'x'.repeat(5000) })).status, 413);
  assert.equal((await fetch(`${f.url}/signup`, {
    method: 'POST', body: new URLSearchParams([['project', 'a'], ['project', 'b'], ['email', 'a@example.com']]),
  })).status, 400);
  assert.equal(f.rows().length, 0);
});

test('provides no public access to collected data', async t => {
  const f = await fixture(t);
  await signup(f.url);
  for (const path of ['/signups', '/projects', '/data/signups.sqlite', '/signup/']) {
    assert.equal((await fetch(`${f.url}${path}`)).status, 404);
  }
  assert.equal((await fetch(`${f.url}/signup`)).status, 405);
  const health = await fetch(`${f.url}/healthz`);
  assert.deepEqual(await health.json(), { ok: true });
});

test('serves agent instructions through both names without consuming the signup quota', async t => {
  const f = await fixture(t, { rateLimit: 1 });
  const guide = await fetch(`${f.url}/llm.txt`);
  assert.equal(guide.status, 200);
  assert.match(guide.headers.get('content-type'), /^text\/plain; charset=utf-8$/);
  assert.equal(guide.headers.get('access-control-allow-origin'), '*');
  const text = await guide.text();
  assert.match(text, /Use the origin that served this document as your base URL/);
  assert.match(text, /POST \/signup/);
  assert.match(text, /Retry-After/);
  assert.equal(await (await fetch(`${f.url}/llms.txt`)).text(), text);
  const head = await fetch(`${f.url}/llm.txt`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(text));
  assert.equal(await head.text(), '');
  const options = await fetch(`${f.url}/llms.txt`, { method: 'OPTIONS' });
  assert.equal(options.status, 204);
  assert.match(options.headers.get('access-control-allow-methods'), /GET/);
  const unsupported = await fetch(`${f.url}/llm.txt`, { method: 'POST' });
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get('allow'), 'GET, HEAD, OPTIONS');
  assert.equal(f.rows().length, 0);
  assert.equal((await signup(f.url)).status, 200);
});

test('CLI exports exact project buckets and creates a consistent SQLite backup', async t => {
  const f = await fixture(t);
  const project = 'Rocket, "launch"';
  await signup(f.url, { project, email: 'csv@example.com' });
  await signup(f.url, { project: 'other', email: 'other@example.com' });
  const options = { cwd: root, env: { ...process.env, DB_PATH: f.config.dbPath } };
  const projects = await exec(process.execPath, ['cli.js', 'projects'], options);
  assert.match(projects.stdout, /"Rocket, ""launch""",1/);
  const exported = await exec(process.execPath, ['cli.js', 'export', project], options);
  assert.match(exported.stdout, /csv@example.com/);
  assert.doesNotMatch(exported.stdout, /other@example.com/);
  const destination = join(f.dir, 'backup.sqlite');
  await exec(process.execPath, ['cli.js', 'backup', destination], options);
  const backup = new DatabaseSync(destination, { readOnly: true });
  try { assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM signups').get().n, 2); }
  finally { backup.close(); }
  await assert.rejects(exec(process.execPath, ['cli.js', 'backup', destination], options), /already exists/);
});
