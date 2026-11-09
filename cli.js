import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const [command, argument, ...extra] = process.argv.slice(2);
if (extra.length || !['projects', 'export', 'backup'].includes(command) ||
    (command === 'projects' ? argument !== undefined : !argument)) {
  console.error('Usage: node cli.js projects | export <project> | backup <new-file.sqlite>');
  process.exit(1);
}

process.umask(0o077);
const dbPath = resolve(process.env.DB_PATH ?? 'data/signups.sqlite');
let db;
async function write(text) {
  if (!process.stdout.write(text)) await once(process.stdout, 'drain');
}
const csv = value => `"${String(value).replaceAll('"', '""')}"`;

try {
  db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  if (command === 'projects') {
    await write('project,count\n');
    for (const row of db.prepare('SELECT project, COUNT(*) AS count FROM signups GROUP BY project ORDER BY project').iterate()) {
      await write(`${csv(row.project)},${row.count}\n`);
    }
  } else if (command === 'export') {
    await write('project,email,ip,created_at\n');
    for (const row of db.prepare('SELECT project, email, ip, created_at FROM signups WHERE project = ? ORDER BY id').iterate(argument.trim().normalize('NFC'))) {
      await write(`${Object.values(row).map(csv).join(',')}\n`);
    }
  } else {
    const destination = resolve(argument);
    if (existsSync(destination)) throw new Error('Backup destination already exists; choose a new filename');
    await backup(db, destination);
    console.error(`Backup saved to ${destination}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
