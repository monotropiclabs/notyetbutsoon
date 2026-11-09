#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { chmodSync, constants, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';

// The same database operations run locally or through Ample.
export const databaseTask = String.raw`
const { DatabaseSync } = require('node:sqlite');
const { existsSync, openSync, closeSync, writeFileSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const input = JSON.parse(process.argv[1]);
let db, fd, file;
try {
  if (input.action === 'rm' && !existsSync(input.db)) throw new Error('Database file not found');
  db = new DatabaseSync(input.db, { readOnly: input.action !== 'rm', timeout: 5000 });
  let result;
  if (input.action === 'ls') {
    result = db.prepare('SELECT project, COUNT(*) AS count FROM signups WHERE project > ? GROUP BY project ORDER BY project LIMIT 500').all(input.after || '');
  } else if (input.action === 'show') {
    const count = db.prepare('SELECT COUNT(*) AS count FROM signups WHERE project = ?').get(input.project).count;
    const rows = db.prepare('SELECT email, ip, created_at FROM signups WHERE project = ? ORDER BY id LIMIT ? OFFSET ?').all(input.project, input.limit, input.offset);
    result = { count, rows };
  } else if (input.action === 'rm-preview' || input.action === 'rm') {
    if (input.action === 'rm') db.exec('BEGIN IMMEDIATE');
    const preview = db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS maxId FROM signups WHERE project = ?').get(input.project);
    if (input.action === 'rm-preview') {
      result = preview;
    } else {
      if (preview.count !== input.count || preview.maxId !== input.maxId) {
        throw new Error('Signups changed since the preview. Nothing deleted; run rm again.');
      }
      result = { deleted: db.prepare('DELETE FROM signups WHERE project = ?').run(input.project).changes };
      db.exec('COMMIT');
    }
  } else {
    const target = input.output || join(tmpdir(), 'nybs-' + input.nonce + '.csv');
    fd = openSync(target, 'wx', 0o600);
    file = target;
    const csv = value => '"' + String(value).replaceAll('"', '""') + '"';
    writeFileSync(fd, 'project,email,ip,created_at\n');
    let count = 0;
    for (const row of db.prepare('SELECT project, email, ip, created_at FROM signups WHERE project = ? ORDER BY id').iterate(input.project)) {
      writeFileSync(fd, Object.values(row).map(csv).join(',') + '\n');
      count++;
    }
    closeSync(fd);
    fd = undefined;
    result = { file, count };
  }
  console.log(JSON.stringify(result));
} catch (error) {
  if (db?.isTransaction) db.exec('ROLLBACK');
  if (fd !== undefined) closeSync(fd);
  if (file) unlinkSync(file);
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
`;

const help = `Usage: nybs <command> [options]

  ls                         List all projects and signup counts
  show <project>             Show emails, IPs, and signup times
  download <project>         Save the full CSV to <project>.csv
  rm <project>               Permanently delete a project's signups (asks first)

  --local                    Use the local database instead of saved Ample settings
  --limit <n>                Rows to show (default 50, maximum 1000)
  --offset <n>               Rows to skip when showing a project
  --output, -o <file>        Download to a different file; existing files are preserved
  --yes, -y                  Skip the rm confirmation prompt
  --help, -h                 Show help

DB_PATH selects the database file. For Ample, set NYBS_SERVER or use the
gitignored .ample/instance.json file's server_id. Ample must be authenticated.`;

function run(program, args) {
  const child = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (child.error) {
    if (child.error.code === 'ENOENT' && program === 'ample') {
      throw new Error('Ample CLI not found. Install it and run ample auth login, or use --local.');
    }
    throw child.error;
  }
  let result;
  try { result = JSON.parse(child.stdout); } catch { /* Errors can be plain text. */ }
  if (child.status !== 0 || result?.error) {
    throw new Error(result?.error?.message || child.stderr.trim() || `Command failed: ${program}`);
  }
  if (result === undefined) throw new Error(`${program} returned an invalid JSON response`);
  return result;
}

const ample = args => run('ample', ['--format', 'json', 'server', ...args]);

function database(input, connection) {
  const args = ['--disable-warning=ExperimentalWarning', '-e', databaseTask, JSON.stringify({ ...input, db: connection.db })];
  if (!connection.server) return run(process.execPath, args);
  const result = ample(['exec', connection.server, '--', 'node', ...args]);
  if (result.exit_code !== 0) throw new Error(result.stderr?.trim() || 'Remote database command failed');
  return JSON.parse(result.stdout);
}

function table(headers, rows) {
  const clean = value => String(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
  const values = [headers, ...rows].map(row => row.map(clean));
  const widths = values.reduce((widths, row) => widths.map((width, i) => Math.max(width, row[i].length)), headers.map(() => 0));
  const line = row => row.map((value, i) => value.padEnd(widths[i])).join('  ').trimEnd();
  console.log(line(values[0]));
  console.log(widths.map(width => '-'.repeat(width)).join('  '));
  for (const row of values.slice(1)) console.log(line(row));
}

function integer(value, name, min, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function connection(local) {
  let saved = {};
  if (!local) {
    try { saved = JSON.parse(readFileSync(new URL('./.ample/instance.json', import.meta.url), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const server = local ? undefined : process.env.NYBS_SERVER || saved.server_id;
  const db = process.env.DB_PATH || saved.db_path || (server ? '/data/signups.sqlite' : resolve('data/signups.sqlite'));
  return { server, db };
}

function download(project, output, target) {
  const slug = project.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[.-]+/, '').slice(0, 100) || 'signups';
  const destination = resolve(output || `${slug}.csv`);
  if (existsSync(destination)) throw new Error('Output file already exists. Choose another path with --output.');
  const staging = mkdtempSync(join(dirname(destination), '.nybs-'));
  const temporary = join(staging, 'export.csv');
  const nonce = randomUUID();
  let remoteFile;
  try {
    const result = database({ action: 'download', project, nonce, ...(target.server ? {} : { output: temporary }) }, target);
    if (target.server) {
      if (basename(result.file) !== `nybs-${nonce}.csv`) throw new Error('Unexpected remote export path');
      remoteFile = result.file;
      ample(['cp', `${target.server}:${remoteFile}`, temporary]);
    }
    chmodSync(temporary, 0o600);
    copyFileSync(temporary, destination, constants.COPYFILE_EXCL);
    console.log(`Saved ${result.count} signup${result.count === 1 ? '' : 's'} to ${destination}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (remoteFile) {
      try {
        const removed = ample(['exec', target.server, '--', 'rm', '-f', remoteFile]);
        if (removed.exit_code !== 0) throw new Error('Remote cleanup failed');
      }
      catch { console.error(`Could not remove temporary export ${remoteFile} from ${target.server}.`); }
    }
  }
}

export async function confirmRemoval(project, count, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) throw new Error('Removal requires confirmation. Run in a terminal or pass --yes.');
  const prompt = createInterface({ input, output, terminal: false });
  try {
    const answer = await prompt.question(`Permanently delete ${count} signup${count === 1 ? '' : 's'} for ${JSON.stringify(project)}? [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    local: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    output: { type: 'string', short: 'o' }, limit: { type: 'string' }, offset: { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
  } });
  const [command, rawProject, ...extra] = positionals;
  if (values.help || !command) return console.log(help);
  if (!['ls', 'show', 'download', 'rm'].includes(command) || extra.length ||
      (command === 'ls' ? rawProject !== undefined : !rawProject?.trim())) throw new Error(help);
  if ((values.output && command !== 'download') || ((values.limit || values.offset) && command !== 'show') ||
      (values.yes && command !== 'rm')) {
    throw new Error('--output is for download; --limit/--offset are for show; --yes is for rm.');
  }
  const target = connection(values.local);
  const project = rawProject?.trim().normalize('NFC');
  if (command === 'ls') {
    const rows = [];
    let page, after;
    do {
      page = database({ action: 'ls', after }, target);
      rows.push(...page);
      after = page.at(-1)?.project;
    } while (page.length === 500);
    if (!rows.length) return console.log('No projects yet.');
    table(['PROJECT', 'SIGNUPS'], rows.map(row => [row.project, row.count]));
    return;
  }
  if (command === 'rm') {
    const preview = database({ action: 'rm-preview', project }, target);
    if (!preview.count) return console.log(`No signups found for ${JSON.stringify(project)}.`);
    if (!values.yes && !await confirmRemoval(project, preview.count)) return console.log('Cancelled. Nothing deleted.');
    const result = database({ action: 'rm', project, ...preview }, target);
    return console.log(`Deleted ${result.deleted} signup${result.deleted === 1 ? '' : 's'} from ${JSON.stringify(project)}.`);
  }
  if (command === 'download') return download(project, values.output, target);
  const limit = integer(values.limit ?? '50', '--limit', 1, 1000);
  const offset = integer(values.offset ?? '0', '--offset', 0);
  const result = database({ action: 'show', project, limit, offset }, target);
  console.log(`${project}: ${result.count} signup${result.count === 1 ? '' : 's'}`);
  if (!result.rows.length) return console.log(result.count ? 'No rows at this offset.' : 'No signups yet.');
  table(['EMAIL', 'IP', 'SIGNED UP (UTC)'], result.rows.map(row => [row.email, row.ip, row.created_at.slice(0, 19).replace('T', ' ')]));
  console.log(`Showing ${offset + 1}–${offset + result.rows.length} of ${result.count}.`);
  if (offset + result.rows.length < result.count) console.log(`Use --offset ${offset + result.rows.length} for the next page, or download for the full CSV.`);
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { await main(); }
  catch (error) { console.error(error.code === 'EEXIST' ? 'Output file already exists. Choose another --output path.' : error.message); process.exitCode = 1; }
}
