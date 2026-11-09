import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, '.ample-source');
const files = ['package.json', 'package-lock.json', 'server.js', 'ip.js', 'cli.js', 'nybs.js', 'llm.txt', 'ample.toml'];
const sources = files.map(name => [name, readFileSync(join(root, name))]);

const existing = lstatSync(output, { throwIfNoEntry: false });
if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
  throw new Error('.ample-source must be a regular directory');
}
mkdirSync(output, { recursive: true });
for (const name of readdirSync(output)) {
  // Keep Ample's local deployment state between releases.
  if (name !== '.ample') rmSync(join(output, name), { recursive: true, force: true });
}
for (const [name, contents] of sources) writeFileSync(join(output, name), contents);
console.log('Prepared .ample-source/');
