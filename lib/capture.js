/**
 * Shared lead-capture logic.
 *
 * Required by BOTH runtimes so validation can never drift between them:
 *   backend/server.js   long-lived Node server (local dev, or any VPS/container)
 *   api/scores.js       Vercel serverless function
 *   api/leaderboard.js  Vercel serverless function
 *
 * Nothing here touches `http` or `fs` — it is pure logic plus fetch, so it
 * works unchanged in a serverless handler.
 */
'use strict';

const crypto = require('node:crypto');

const EMAIL_RE   = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const CONTROL_RE = /[\u0000-\u001F\u007F]/;   // control chars smuggled into a name

const MAX_SCORE  = 100000;
const MAX_NAME   = 60;
const MAX_EMAIL  = 200;

/* ---------------- config ---------------- */
function config(env = process.env) {
  return {
    url:        (env.SUPABASE_URL || '').replace(/\/+$/, ''),
    key:        env.SUPABASE_SERVICE_ROLE_KEY || '',
    origins:    (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean),
    rateMax:    Number(env.RATE_LIMIT_MAX || 10),
    rateWindow: Number(env.RATE_LIMIT_WINDOW_MS || 60000),
    ipSalt:     env.IP_SALT || ''
  };
}

/** Names of any required vars that are missing or still a placeholder. */
function missingConfig(cfg) {
  return [
    ['SUPABASE_URL', cfg.url, u => u && !u.includes('YOUR-PROJECT')],
    ['SUPABASE_SERVICE_ROLE_KEY', cfg.key,
      k => k && !k.startsWith('PASTE_') && !k.startsWith('eyJhbGciOi...')]
  ].filter(([, v, ok]) => !ok(v)).map(([n]) => n);
}

/**
 * Supabase issues two keys and they are easy to mix up:
 *   sb_publishable_... / anon JWT         -> ships in a browser, obeys RLS
 *   sb_secret_...      / service_role JWT -> server only, bypasses RLS
 * A publishable key still captures (capture_lead is granted to anon), so this
 * is advisory, not fatal — but nothing needing admin access will work.
 */
function keyKind(k) {
  if (!k) return 'missing';
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

/* ---------------- validation ---------------- */
/** Validate and normalise a submission. Returns { row }, { error }, or { bot }. */
function validate(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { error: 'Malformed request.' };
  }

  // Honeypot: a real player never fills a field they cannot see.
  if (typeof input.website === 'string' && input.website.trim() !== '') return { bot: true };

  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > MAX_NAME) return { error: `Name must be 2-${MAX_NAME} characters.` };
  if (CONTROL_RE.test(name))                     return { error: 'Name contains invalid characters.' };

  const email = String(input.email ?? '').trim().toLowerCase();
  if (email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
    return { error: 'That email does not look valid.' };
  }

  // The score arrives from the browser, so it is a claim, not a fact. Clamp it
  // to what the game can actually produce and move on -- this is a mailing
  // list, not a tournament ladder. See README for the caveat.
  const num = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
  };

  return {
    row: {
      p_name:        name,
      p_email:       email,
      p_score:       num(input.score, 0, MAX_SCORE, 0),
      p_level:       num(input.level, 1, 4, 4),
      p_duration_ms: num(input.duration_ms, 0, 86400000, null) || null,
      p_source:      'web'
    }
  };
}

/* ---------------- supabase ---------------- */
function supabaseFetch(cfg, path, init = {}) {
  return fetch(`${cfg.url}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      apikey: cfg.key,
      authorization: `Bearer ${cfg.key}`,
      ...(init.headers || {})
    },
    signal: AbortSignal.timeout(8000)
  });
}

/**
 * Send a validated row to capture_lead().
 * Returns { ok: true } or { badInput: true } — a 400 here means the database's
 * own checks rejected it, which is the player's problem, not a server fault.
 * Throws for anything else so the caller can answer 502.
 */
async function captureLead(cfg, row) {
  const r = await supabaseFetch(cfg, '/rest/v1/rpc/capture_lead', {
    method: 'POST', body: JSON.stringify(row)
  });
  if (r.status === 400) {
    const body = await r.json().catch(() => ({}));
    return { badInput: true, detail: body.message };
  }
  if (!r.ok) throw new Error(`supabase ${r.status} ${await r.text().catch(() => '')}`);
  return { ok: true };
}

async function fetchLeaderboard(cfg, limit = 25) {
  const r = await supabaseFetch(
    cfg, `/rest/v1/leaderboard?select=name,score,level&order=score.desc&limit=${limit}`);
  if (!r.ok) throw new Error(`supabase ${r.status}`);
  return r.json();
}

/* ---------------- rate limiting ---------------- */
/**
 * Fixed window, per IP, held in memory.
 *
 * On the long-lived server this is exact. On Vercel each warm instance keeps
 * its own counter and cold starts reset it, so there it is best-effort only —
 * it blunts a naive flood but will not stop a determined one. The real limits
 * on abuse are the honeypot and capture_lead upserting on email, so hammering
 * one address rewrites one row rather than growing the table.
 */
function createLimiter({ max, windowMs }) {
  const hits = new Map();
  return function overLimit(ip) {
    const now = Date.now();
    if (hits.size > 10000) hits.clear();               // crude bound on memory
    const rec = hits.get(ip);
    if (!rec || now - rec.start > windowMs) { hits.set(ip, { start: now, n: 1 }); return false; }
    rec.n += 1;
    return rec.n > max;
  };
}

const clientIp = req =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket?.remoteAddress || 'unknown';

/** Enough to spot abuse in logs, not enough to identify anyone. */
const hashIp = (ip, salt) =>
  crypto.createHash('sha256').update(ip + salt).digest('hex').slice(0, 16);

/* ---------------- cors ---------------- */
function corsHeaders(origin, origins) {
  const allow = origins.includes('*') ? '*' : (origins.includes(origin) ? origin : '');
  const h = {
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400'
  };
  if (allow) {
    h['access-control-allow-origin'] = allow;
    if (allow !== '*') h.vary = 'Origin';
  }
  return h;
}

module.exports = {
  EMAIL_RE, CONTROL_RE, MAX_SCORE, MAX_NAME, MAX_EMAIL,
  config, missingConfig, keyKind,
  validate, supabaseFetch, captureLead, fetchLeaderboard,
  createLimiter, clientIp, hashIp, corsHeaders
};
