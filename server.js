import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { clientIP, makeTrustProxy, rateLimitKey } from './ip.js';

const MAX_BODY_BYTES = 4096;
const AGENT_GUIDE = readFileSync(new URL('./llm.txt', import.meta.url));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

export function configFromEnv(env = process.env) {
  const port = positiveInteger(env.PORT ?? 3080, 'PORT');
  if (port > 65535) throw new Error('PORT must be at most 65535');
  return {
    port,
    host: env.HOST ?? '127.0.0.1',
    dbPath: resolve(env.DB_PATH ?? 'data/signups.sqlite'),
    rateLimit: positiveInteger(env.RATE_LIMIT ?? 10, 'RATE_LIMIT'),
    windowMs: positiveInteger(env.RATE_WINDOW_SECONDS ?? 600, 'RATE_WINDOW_SECONDS') * 1000,
    trustedProxies: env.TRUSTED_PROXIES ?? '',
  };
}

function readBody(req) {
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    throw new HttpError(413, 'Request body is too large');
  }
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body is too large'));
      } else chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('Request aborted')));
  });
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof input.project !== 'string' || typeof input.email !== 'string') {
    throw new HttpError(400, 'Provide project and email strings');
  }
  const project = input.project.trim().normalize('NFC');
  const email = input.email.trim().toLowerCase();
  if (!project || project.length > 120 || /[\p{Cc}\p{Cf}]/u.test(project)) {
    throw new HttpError(400, 'Project must contain 1–120 characters without control characters');
  }
  // Practical syntax validation, without claiming the mailbox is verified.
  const [local, domain, extra] = email.split('@');
  if (email.length > 254 || !local || local.length > 64 || !domain || extra !== undefined ||
      !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/i.test(local) ||
      local.startsWith('.') || local.endsWith('.') || local.includes('..') ||
      !domain.includes('.') || domain.split('.').some(label =>
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    throw new HttpError(400, 'Provide a valid email address');
  }
  return { project, email };
}

export function createService(config = configFromEnv(), { now = Date.now } = {}) {
  const isTrusted = makeTrustProxy(config.trustedProxies);
  mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(config.dbPath, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS signups (
      id INTEGER PRIMARY KEY,
      project TEXT NOT NULL,
      email TEXT NOT NULL,
      ip TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(project, email)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS rate_limits (
      ip TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      hits INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(started_at);
  `);
  const insert = db.prepare(`
    INSERT INTO signups (project, email, ip, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(project, email) DO NOTHING
  `);
  const limit = db.prepare(`
    INSERT INTO rate_limits (ip, started_at, hits) VALUES ($ip, $now, 1)
    ON CONFLICT(ip) DO UPDATE SET
      hits = CASE WHEN started_at + $window <= $now THEN 1 ELSE MIN(hits + 1, $max + 1) END,
      started_at = CASE WHEN started_at + $window <= $now THEN $now ELSE started_at END
    RETURNING hits, started_at
  `);
  const prune = db.prepare('DELETE FROM rate_limits WHERE started_at <= ?');
  const cleanup = setInterval(() => {
    try { prune.run(now() - config.windowMs); }
    catch (error) { console.error('Rate-limit cleanup failed:', error.code ?? 'database error'); }
  }, Math.min(config.windowMs, 600_000));
  cleanup.unref();

  const server = createServer({
    maxHeaderSize: 8192,
    requestTimeout: 10_000,
    headersTimeout: 5000,
    keepAliveTimeout: 5000,
  }, async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, data) => {
      if (res.destroyed) return;
      // Close early rejections instead of buffering a remaining request body.
      if (!req.complete) res.setHeader('Connection', 'close');
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    try {
      const path = req.url.split('?')[0];
      if (path === '/llm.txt' || path === '/llms.txt') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          return res.end();
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.setHeader('Allow', 'GET, HEAD, OPTIONS');
          return reply(405, { error: 'Method not allowed' });
        }
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': AGENT_GUIDE.length,
        });
        return res.end(req.method === 'HEAD' ? undefined : AGENT_GUIDE);
      }
      if (path === '/healthz' && req.method === 'GET') {
        db.prepare('SELECT 1').get();
        return reply(200, { ok: true });
      }
      if (path !== '/signup') return reply(404, { error: 'Not found' });
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Max-Age', '86400');
        res.writeHead(204);
        return res.end();
      }
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST, OPTIONS');
        return reply(405, { error: 'Method not allowed' });
      }
      const ip = clientIP(req, isTrusted);
      const timestamp = now();
      const bucket = limit.get({
        ip: rateLimitKey(ip), now: timestamp, window: config.windowMs, max: config.rateLimit,
      });
      if (bucket.hits > config.rateLimit) {
        const retryAfter = Math.max(1, Math.ceil((bucket.started_at + config.windowMs - timestamp) / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        return reply(429, { error: 'Too many attempts. Please try again later.' });
      }
      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json' && type !== 'application/x-www-form-urlencoded') {
        throw new HttpError(415, 'Use application/json or application/x-www-form-urlencoded');
      }
      const body = await readBody(req);
      let input;
      if (type === 'application/json') {
        try { input = JSON.parse(body); }
        catch { throw new HttpError(400, 'Invalid JSON'); }
      } else {
        const params = new URLSearchParams(body);
        if (params.getAll('project').length !== 1 || params.getAll('email').length !== 1) {
          throw new HttpError(400, 'Provide one project and one email');
        }
        input = Object.fromEntries(params);
      }
      const { project, email } = validateInput(input);
      insert.run(project, email, ip, new Date(timestamp).toISOString());
      return reply(200, { ok: true });
    } catch (error) {
      if (!error.status && !req.aborted) console.error('Request failed:', error.code ?? 'internal error');
      return reply(error.status ?? 503, {
        error: error.status ? error.message : 'Temporarily unavailable. Please try again later.',
      });
    }
  });
  server.maxRequestsPerSocket = 100;
  server.on('close', () => {
    clearInterval(cleanup);
    db.close();
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  const config = configFromEnv();
  const server = createService(config);
  server.on('error', error => {
    console.error('Server failed:', error.code ?? error.message);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    console.log(`notyetbutsoon listening on http://${config.host}:${config.port}`);
  });
  const shutdown = () => {
    server.close();
    const deadline = setTimeout(() => server.closeAllConnections(), 10_000);
    deadline.unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
