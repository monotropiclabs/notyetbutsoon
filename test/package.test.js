import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('packaging excludes private files and preserves deployment state across rebuilds', t => {
  const root = mkdtempSync(join(tmpdir(), 'nybs-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  for (const name of ['package.json', 'package-lock.json', 'server.js', 'ip.js', 'cli.js', 'nybs.js', 'llm.txt', 'ample.toml', 'scripts/package-ample.js']) {
    copyFileSync(new URL(`../${name}`, import.meta.url), join(root, name));
  }
  const output = join(root, '.ample-source');
  const state = join(output, '.ample');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'config.toml'), 'deployment state');
  writeFileSync(join(root, '.env'), 'PRIVATE=fixture');
  writeFileSync(join(output, '.env'), 'stale private fixture');
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data/signups.sqlite'), 'database fixture');
  const run = () => execFileSync(process.execPath, [join(root, 'scripts/package-ample.js')], { stdio: 'pipe' });

  run();
  assert.equal(existsSync(join(output, '.env')), false);
  assert.equal(existsSync(join(output, 'data')), false);
  assert.equal(existsSync(join(output, 'test')), false);
  assert.equal(readFileSync(join(output, 'llm.txt'), 'utf8'), readFileSync(join(root, 'llm.txt'), 'utf8'));
  assert.equal(readFileSync(join(state, 'config.toml'), 'utf8'), 'deployment state');

  writeFileSync(join(root, 'llm.txt'), 'updated guide');
  writeFileSync(join(output, 'obsolete.js'), 'stale runtime file');
  run();
  assert.equal(existsSync(join(output, 'obsolete.js')), false);
  assert.equal(readFileSync(join(output, 'llm.txt'), 'utf8'), 'updated guide');
  assert.equal(readFileSync(join(state, 'config.toml'), 'utf8'), 'deployment state');

  rmSync(output, { recursive: true });
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'keep.txt'), 'keep');
  symlinkSync(elsewhere, output, 'dir');
  assert.throws(run, /must be a regular directory/);
  assert.equal(readFileSync(join(elsewhere, 'keep.txt'), 'utf8'), 'keep');
});
