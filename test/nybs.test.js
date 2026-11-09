import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { fixture, signup } from './helpers/http.js';
import { confirmRemoval, databaseTask } from '../nybs.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../nybs.js', import.meta.url));
function run(f, args, env = {}) {
  return exec(process.execPath, [cli, ...args], {
    cwd: f.dir, env: { ...process.env, DB_PATH: f.config.dbPath, ...env },
  });
}

test('the executable works through a link from outside the checkout', async t => {
  const f = await fixture(t);
  const link = join(f.dir, 'nybs');
  symlinkSync(cli, link);
  const options = { cwd: f.dir, env: { ...process.env, DB_PATH: f.config.dbPath } };
  assert.match((await exec(link, ['--help'], options)).stdout, /^Usage: nybs/);
  assert.match((await exec(link, ['ls', '--local'], options)).stdout, /No projects yet/);
});

test('operator commands show readable pages and download correctly escaped CSV without overwriting files', async t => {
  const f = await fixture(t);
  assert.match((await run(f, ['ls', '--local'])).stdout, /No projects yet/);
  const project = 'Launch, "quoted"; $(touch side-effect)';
  await signup(f.url, { project, email: 'first@example.com' });
  await signup(f.url, { project, email: 'second@example.com' });
  await signup(f.url, { project: 'other', email: 'other@example.com' });
  const listed = (await run(f, ['ls', '--local'])).stdout;
  assert.match(listed, /PROJECT\s+SIGNUPS/);
  assert.ok(listed.includes(project));
  const shown = (await run(f, ['show', project, '--local', '--limit', '1', '--offset', '1'])).stdout;
  assert.match(shown, /EMAIL\s+IP\s+SIGNED UP/);
  assert.match(shown, /second@example.com/);
  assert.doesNotMatch(shown, /first@example.com/);
  assert.match(shown, /Showing 2–2 of 2/);
  assert.match((await run(f, ['show', 'missing', '--local'])).stdout, /No signups yet/);
  const destination = join(f.dir, 'export.csv');
  await run(f, ['download', project, '--local', '-o', destination]);
  const expected = await exec(process.execPath, [fileURLToPath(new URL('../cli.js', import.meta.url)), 'export', project], {
    env: { ...process.env, DB_PATH: f.config.dbPath },
  });
  assert.equal(readFileSync(destination, 'utf8'), expected.stdout);
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  await assert.rejects(run(f, ['download', project, '--local', '-o', destination]), /already exists/);
  assert.equal(readFileSync(destination, 'utf8'), expected.stdout);
  assert.equal(existsSync(join(f.dir, 'side-effect')), false);
  await assert.rejects(run(f, ['show', project, '--local', '--limit', '0']), /--limit must be/);
  await run(f, ['download', '../../missing', '--local']);
  assert.ok(existsSync(join(f.dir, 'missing.csv')));
});

test('removal confirmation defaults to cancellation and requires an explicit yes', async () => {
  for (const [answer, expected] of [['', false], ['n', false], ['yes please', false], ['y', true], ['YES', true]]) {
    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = true;
    let prompt = '';
    output.on('data', chunk => { prompt += chunk; });
    const result = confirmRemoval('my-project', 2, { input, output });
    input.write(`${answer}\n`);
    assert.equal(await result, expected);
    assert.match(prompt, /Permanently delete 2 signups/);
    assert.match(prompt, /\[y\/N\]/);
    input.destroy();
    output.destroy();
  }
});

test('rm deletes only the selected project, preserves shared quotas, and permits future signups', async t => {
  const f = await fixture(t);
  const project = 'Delete, "only"; $(touch side-effect)';
  await signup(f.url, { project, email: 'first@example.com' });
  await signup(f.url, { project, email: 'second@example.com' });
  await signup(f.url, { project: 'other', email: 'other@example.com' });
  const db = new DatabaseSync(f.config.dbPath, { readOnly: true });
  const quotaBefore = db.prepare('SELECT * FROM rate_limits').all();
  await assert.rejects(run(f, ['rm', project, '--local']), /terminal or pass --yes/);
  assert.equal(f.rows().length, 3);
  const removed = await run(f, ['rm', project, '--local', '--yes']);
  assert.match(removed.stdout, /Deleted 2 signups/);
  assert.deepEqual(f.rows().map(row => row.project), ['other']);
  assert.deepEqual(db.prepare('SELECT * FROM rate_limits').all(), quotaBefore);
  db.close();
  assert.equal(existsSync(join(f.dir, 'side-effect')), false);
  assert.match((await run(f, ['rm', project, '--local', '-y'])).stdout, /No signups found/);
  assert.equal((await signup(f.url, { project, email: 'new@example.com' })).status, 200);
  assert.equal(f.rows().filter(row => row.project === project).length, 1);
  await assert.rejects(run(f, ['ls', '--local', '--yes']), /--yes is for rm/);
});

test('rm refuses a changed project and rolls back without deleting any rows', async t => {
  const f = await fixture(t);
  await signup(f.url, { project: 'race', email: 'first@example.com' });
  const task = input => exec(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', databaseTask, JSON.stringify({ ...input, db: f.config.dbPath })]);
  const preview = JSON.parse((await task({ action: 'rm-preview', project: 'race' })).stdout);
  await signup(f.url, { project: 'race', email: 'new@example.com' });
  await assert.rejects(task({ action: 'rm', project: 'race', ...preview }), /Signups changed since the preview/);
  assert.equal(f.rows().length, 2);
  assert.match((await run(f, ['rm', 'race', '--local', '--yes'])).stdout, /Deleted 2 signups/);
  assert.equal(f.rows().length, 0);
});

test('Ample download transfers a large CSV as a file and cleans up after transfer failures', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.config.dbPath);
  const insert = db.prepare('INSERT INTO signups (project,email,ip,created_at) VALUES (?,?,?,?)');
  db.exec('BEGIN');
  for (let i = 0; i < 7000; i++) insert.run('bulk', `${i}${'x'.repeat(200)}@example.com`, '192.0.2.1', '2026-11-09T12:00:00.000Z');
  for (let i = 0; i < 501; i++) insert.run(`project-${String(i).padStart(3, '0')}`, 'p@example.com', '192.0.2.1', '2026-11-09T12:00:00.000Z');
  db.exec('COMMIT');
  db.close();
  const bin = join(f.dir, 'bin');
  const log = join(f.dir, 'calls.jsonl');
  mkdirSync(bin);
  writeFileSync(join(bin, 'ample'), `#!/usr/bin/env node
const fs=require('node:fs');
const cp=require('node:child_process');
const args=process.argv.slice(2);
if(args[0]==='--format')args.splice(0,2);
const op=args[1];
if(op==='exec'){
 const command=args.slice(args.indexOf('--')+1);
 if(command[0]==='rm'){
   fs.rmSync(command[2],{force:true});
   fs.appendFileSync(process.env.NYBS_TEST_LOG,JSON.stringify({op:'cleanup',file:command[2]})+'\\n');
   console.log(JSON.stringify({exit_code:0,stdout:'',stderr:''}));
 }else{
   const r=cp.spawnSync(process.execPath,command.slice(1),{encoding:'utf8'});
   fs.appendFileSync(process.env.NYBS_TEST_LOG,JSON.stringify({op:'exec',bytes:r.stdout.length})+'\\n');
   console.log(JSON.stringify({exit_code:r.status,stdout:r.stdout,stderr:r.stderr}));
 }
}else if(op==='cp'){
 const source=args[2].slice(args[2].indexOf(':')+1);
 fs.appendFileSync(process.env.NYBS_TEST_LOG,JSON.stringify({op:'cp',source})+'\\n');
 if(process.env.NYBS_TEST_CP_FAIL){console.error('transfer failed');process.exit(1);}
 fs.copyFileSync(source,args[3]);
 console.log(JSON.stringify({copied:true}));
}else process.exit(1);
`, { mode: 0o755 });
  const env = { PATH: `${bin}${delimiter}${process.env.PATH}`, NYBS_SERVER: 'test-server', NYBS_TEST_LOG: log };
  const listed = (await run(f, ['ls'], env)).stdout;
  assert.match(listed, /bulk\s+7000/);
  assert.match(listed, /project-500/);
  const shown = (await run(f, ['show', 'bulk', '--limit', '1'], env)).stdout;
  assert.match(shown, /Showing 1–1 of 7000/);
  assert.match(shown, /--offset 1/);
  const destination = join(f.dir, 'bulk.csv');
  await run(f, ['download', 'bulk'], env);
  assert.ok(statSync(destination).size > 1024 * 1024);
  assert.equal(readFileSync(destination, 'utf8').trimEnd().split('\n').length, 7001);
  let calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(c => c.op === 'cp'));
  assert.ok(calls.filter(c => c.op === 'exec').every(c => c.bytes < 100000));
  assert.ok(calls.filter(c => c.op === 'cleanup').every(c => !existsSync(c.file)));
  const failedOutput = join(f.dir, 'failed.csv');
  await assert.rejects(run(f, ['download', 'bulk', '-o', failedOutput], { ...env, NYBS_TEST_CP_FAIL: '1' }), /transfer failed/);
  assert.equal(existsSync(failedOutput), false);
  calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(c => c.op === 'cleanup').length, 2);
  assert.ok(calls.filter(c => c.op === 'cleanup').every(c => !existsSync(c.file)));
  assert.match((await run(f, ['rm', 'bulk', '--yes'], env)).stdout, /Deleted 7000 signups/);
  assert.equal(f.rows().length, 501);
  assert.ok(f.rows().every(row => row.project !== 'bulk'));
});
