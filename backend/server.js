#!/usr/bin/env node
/**
 * Toad Gone Wild -- lead capture API
 *
 * Zero dependencies. Node 20.6+ (built-in fetch, crypto, --env-file).
 *
 *   GET  /                 the game itself
 *   POST /api/scores       { name, email, score, level, duration_ms, website }
 *   GET  /api/leaderboard  -> top 25, names and scores only
 *   GET  /health
 *
 * Serving the game from the same process is deliberate: one origin means
 * no CORS to configure and no way to forget it, and one thing to deploy.
 *
 * Why a server at all when Supabase can take the insert directly?
 * Because the service key never reaches a browser, rate limiting sits
 * somewhere a player cannot edit, and you get one place to hang a
 * welcome email or a Slack ping later.
 */
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const PORT         = Number(process.env.PORT || 8787);
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ORIGINS      = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
const RATE_MAX     = Number(process.env.RATE_LIMIT_MAX || 10);
const RATE_WINDOW  = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const SERVER_DIR   = path.resolve(__dirname);
const PUBLIC_DIR   = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, '..'));
const INDEX_FILE   = process.env.INDEX_FILE || 'toad-gone-wild-crossing.html';

// Catch the half-filled .env before it turns into a confusing 502 at runtime.
const unset = [
  ['SUPABASE_URL', SUPABASE_URL, u => u && !u.includes('YOUR-PROJECT')],
  ['SUPABASE_SERVICE_ROLE_KEY', SUPABASE_KEY, k => k && !k.startsWith('PASTE_') && !k.startsWith('eyJhbGciOi...')]
].filter(([, v, ok]) => !ok(v)).map(([n]) => n);

if (unset.length) {
  console.error(`\nMissing or unfilled in backend/.env: ${unset.join(', ')}`);
  console.error('Get both from your Supabase project: Settings -> API.');
  console.error('The secret key belongs here, never in the HTML.\n');
  process.exit(1);
}

// Supabase issues two keys and they are easy to mix up:
//   sb_publishable_... / anon JWT  -> meant to ship in a browser, obeys RLS
//   sb_secret_...      / service_role JWT -> server only, bypasses RLS
// A publishable key still works here (capture_lead is granted to anon), so this
// is a warning rather than a hard stop -- but nothing that needs admin access,
// like reading the leads table back, will work until it is the secret key.
function keyKind(k) {
  if (k.startsWith('sb_secret_')) return 'secret';
  if (k.startsWith('sb_publishable_')) return 'publishable';
  if (k.startsWith('eyJ')) {
    try {
      const role = JSON.parse(Buffer.from(k.split('.')[1], 'base64url').toString()).role;
      if (role === 'service_role') return 'secret';
      if (role === 'anon') return 'publishable';
    } catch { /* not a JWT we can read */ }
  }
  return 'unknown';
}

const KEY_KIND = keyKind(SUPABASE_KEY);
if (KEY_KIND === 'publishable') {
  console.warn('\nWARNING: SUPABASE_SERVICE_ROLE_KEY holds a PUBLISHABLE (anon) key.');
  console.warn('  Captures will still work, but this server has no admin access.');
  console.warn('  For the secret key: Supabase -> Settings -> API -> secret keys.\n');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const CONTROL_RE = /[\u0000-\u001F\u007F]/;   // reject control chars smuggled into a name

/* ---------------- rate limiting: fixed window, per IP ---------------- */
const hits = new Map();
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW;
  for (const [k, v] of hits) if (v.start < cutoff) hits.delete(k);
}, RATE_WINDOW).unref();

function overLimit(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > RATE_WINDOW) { hits.set(ip, { start: now, n: 1 }); return false; }
  rec.n += 1;
  return rec.n > RATE_MAX;
}

const clientIp = req =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket.remoteAddress || 'unknown';

/* ---------------- helpers ---------------- */
function cors(req, res) {
  const origin = req.headers.origin;
  const allow = ORIGINS.includes('*') ? '*' : (ORIGINS.includes(origin) ? origin : '');
  if (allow) {
    res.setHeader('access-control-allow-origin', allow);
    if (allow !== '*') res.setHeader('vary', 'Origin');
  }
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-max-age', '86400');
}

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Payload too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('Malformed JSON.')); }
    });
    req.on('error', reject);
  });
}

/** Validate and normalise. Returns { row }, { error }, or { bot }. */
function validate(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { error: 'Malformed request.' };
  }

  // Honeypot: a real player never fills a field they cannot see.
  if (typeof input.website === 'string' && input.website.trim() !== '') return { bot: true };

  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 60)  return { error: 'Name must be 2-60 characters.' };
  if (CONTROL_RE.test(name))                return { error: 'Name contains invalid characters.' };

  const email = String(input.email ?? '').trim().toLowerCase();
  if (email.length > 200 || !EMAIL_RE.test(email)) return { error: 'That email does not look valid.' };

  // The score arrives from the browser, so it is a claim, not a fact.
  // Clamp it to what the game can actually produce and move on -- this is
  // a mailing list, not a tournament ladder. See README for the caveat.
  const num = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
  };

  return {
    row: {
      p_name:        name,
      p_email:       email,
      p_score:       num(input.score, 0, 100000, 0),
      p_level:       num(input.level, 1, 4, 4),
      p_duration_ms: num(input.duration_ms, 0, 86400000, null) || null,
      p_source:      'web'
    }
  };
}

function supabase(path, init = {}) {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${SUPABASE_KEY}`,
      ...(init.headers || {})
    },
    signal: AbortSignal.timeout(8000)
  });
}

/* ---------------- static files ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',   '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg'
};

// PUBLIC_DIR is the repo root, which also holds backend/ and its .env.
// Three independent gates, because leaking the service_role key here would
// hand someone the whole database:
//   1. no dotfiles or dot-segments in any path component
//   2. nothing resolving inside the backend directory
//   3. only extensions we explicitly know how to serve
function servable(file) {
  const rel = path.relative(PUBLIC_DIR, file);
  if (rel.split(path.sep).some(seg => seg.startsWith('.'))) return false;
  if (file === SERVER_DIR || file.startsWith(SERVER_DIR + path.sep)) return false;
  return Object.hasOwn(MIME, path.extname(file).toLowerCase());
}

async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname === '/' ? INDEX_FILE : pathname.slice(1)); }
  catch { return json(res, 400, { error: 'Bad path.' }); }

  // Resolve first, then confirm the result is still inside PUBLIC_DIR.
  // Anything with ../ in it lands outside and gets a 403 rather than a file.
  const file = path.resolve(PUBLIC_DIR, rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    return json(res, 403, { error: 'Forbidden.' });
  }
  if (!servable(file)) return json(res, 403, { error: 'Forbidden.' });

  let stat;
  try { stat = await fsp.stat(file); }
  catch { return json(res, 404, { error: 'Not found.' }); }
  if (!stat.isFile()) return json(res, 404, { error: 'Not found.' });

  // The game embeds a ~500KB image, so let conditional requests short-circuit.
  const etag = `W/"${stat.size}-${Number(stat.mtimeMs).toString(36)}"`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }

  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const isHtml = type.startsWith('text/html');
  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    etag,
    // The HTML carries the game logic; never let a stale copy pin an old API base.
    'cache-control': isHtml ? 'no-cache' : 'public, max-age=3600',
    'x-content-type-options': 'nosniff'
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

/* ---------------- routes ---------------- */
const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });

  if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
    try {
      const r = await supabase('/rest/v1/leaderboard?select=name,score,level&order=score.desc&limit=25');
      if (!r.ok) throw new Error(`supabase ${r.status}`);
      return json(res, 200, { leaderboard: await r.json() });
    } catch (err) {
      console.error('leaderboard:', err.message);
      return json(res, 502, { error: 'Leaderboard unavailable.' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/scores') {
    const ip = clientIp(req);
    if (overLimit(ip)) { res.setHeader('retry-after', '60'); return json(res, 429, { error: 'Slow down.' }); }

    let input;
    try { input = await readBody(req); }
    catch (err) { return json(res, 400, { error: err.message }); }

    const { row, error, bot } = validate(input);
    if (error) return json(res, 400, { error });
    if (bot)   return json(res, 201, { ok: true });   // look successful, store nothing

    try {
      const r = await supabase('/rest/v1/rpc/capture_lead', { method: 'POST', body: JSON.stringify(row) });
      if (r.status === 400) {
        const body = await r.json().catch(() => ({}));
        console.warn('rejected by db:', body.message);
        return json(res, 400, { error: 'That did not look right. Check your details.' });
      }
      if (!r.ok) throw new Error(`supabase ${r.status} ${await r.text().catch(() => '')}`);

      // Hash the IP rather than storing it: enough to spot abuse, not enough to track anyone.
      const ipHash = crypto.createHash('sha256')
        .update(ip + (process.env.IP_SALT || '')).digest('hex').slice(0, 16);
      console.log(`lead ${row.p_email} score=${row.p_score} ip=${ipHash}`);
      return json(res, 201, { ok: true });
    } catch (err) {
      console.error('capture:', err.message);
      return json(res, 502, { error: 'Could not save right now.' });
    }
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res, url.pathname).catch(err => {
      console.error('static:', err.message);
      if (!res.headersSent) json(res, 500, { error: 'Server error.' });
    });
  }

  json(res, 404, { error: 'Not found.' });
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use -- something else is on it.`);
    console.error(`  Find it:  lsof -ti:${PORT}`);
    console.error(`  Or pick another port:  PORT=8788 npm start\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`Toad Gone Wild running on http://localhost:${PORT}`);
  console.log(`  game:    ${path.join(PUBLIC_DIR, INDEX_FILE)}`);
  console.log(`  origins: ${ORIGINS.join(', ')}   rate: ${RATE_MAX} per ${RATE_WINDOW / 1000}s`);
  if (!fs.existsSync(path.join(PUBLIC_DIR, INDEX_FILE))) {
    console.warn(`  WARNING: ${INDEX_FILE} not found in ${PUBLIC_DIR} -- set PUBLIC_DIR or INDEX_FILE.`);
  }
});
