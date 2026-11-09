import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Duplex } from 'node:stream';
import { createService, configFromEnv } from '../../server.js';

const memoryServers = new Map();
let nextServer = 0;

// Use Node's real HTTP parser over an in-memory socket when TCP is unavailable.
export async function fetch(url, options) {
  if (process.env.TEST_TRANSPORT !== 'memory') return globalThis.fetch(url, options);
  const request = new Request(url, options);
  const target = new URL(url);
  const server = memoryServers.get(target.origin);
  assert.ok(server, 'memory server must be running');
  const body = Buffer.from(await request.arrayBuffer());
  request.headers.set('host', target.host);
  request.headers.set('connection', 'close');
  if (body.length) request.headers.set('content-length', String(body.length));
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = new Duplex({
      read() {},
      write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); },
    });
    Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
    socket.on('error', reject);
    socket.on('finish', () => {
      socket.destroy();
      try {
        const raw = Buffer.concat(chunks);
        const split = raw.indexOf('\r\n\r\n');
        const [statusLine, ...lines] = raw.subarray(0, split).toString().split('\r\n');
        const headers = new Headers(lines.map(line => {
          const colon = line.indexOf(':');
          return [line.slice(0, colon), line.slice(colon + 1).trim()];
        }));
        let payload = raw.subarray(split + 4);
        if (headers.get('transfer-encoding') === 'chunked') {
          const decoded = [];
          while (payload.length) {
            const end = payload.indexOf('\r\n');
            const size = parseInt(payload.subarray(0, end).toString(), 16);
            if (!size) break;
            decoded.push(payload.subarray(end + 2, end + 2 + size));
            payload = payload.subarray(end + 2 + size + 2);
          }
          payload = Buffer.concat(decoded);
        }
        resolve(new Response(payload.length ? payload : null, { status: Number(statusLine.split(' ')[1]), headers }));
      } catch (error) { reject(error); }
    });
    server.emit('connection', socket);
    const head = `${request.method} ${target.pathname}${target.search} HTTP/1.1\r\n` +
      [...request.headers].map(([key, value]) => `${key}: ${value}\r\n`).join('') + '\r\n';
    socket.push(Buffer.concat([Buffer.from(head), body]));
  });
}

export async function fixture(t, overrides = {}, hooks = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'emailsignup-test-'));
  const config = { ...configFromEnv({}), dbPath: join(dir, 'signups.sqlite'), ...overrides };
  const running = new Set();
  async function start() {
    const server = createService(config, hooks);
    const memory = process.env.TEST_TRANSPORT === 'memory';
    let url;
    if (memory) {
      url = `http://memory-${nextServer++}.test`;
      memoryServers.set(url, server);
    } else {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      url = `http://127.0.0.1:${server.address().port}`;
    }
    running.add(server);
    return {
      async close() {
        await new Promise((resolve, reject) => server.close(error =>
          error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
        memoryServers.delete(url);
        running.delete(server);
      },
      url,
    };
  }
  t.after(async () => {
    for (const server of running) await new Promise(resolve => server.close(resolve));
    for (const [url, server] of memoryServers) if (running.has(server)) memoryServers.delete(url);
    rmSync(dir, { recursive: true, force: true });
  });
  function rows() {
    const db = new DatabaseSync(config.dbPath, { readOnly: true });
    try { return db.prepare('SELECT * FROM signups ORDER BY id').all(); }
    finally { db.close(); }
  }
  return { ...(await start()), start, rows, config, dir };
}

export function signup(url, body = { project: 'new-launch', email: 'person@example.com' }, headers = {}) {
  return fetch(`${url}/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

