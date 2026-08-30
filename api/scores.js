/**
 * POST /api/scores  — Vercel serverless function
 *
 * All validation lives in lib/capture.js, shared with backend/server.js, so the
 * two runtimes cannot drift apart.
 */
'use strict';

const {
  config, missingConfig, validate, captureLead,
  createLimiter, clientIp, hashIp, corsHeaders
} = require('../lib/capture.js');

const cfg = config();

// Module scope, so it survives between invocations on a warm instance. Each
// instance has its own counter and cold starts reset it -- see the note in
// lib/capture.js. Best-effort here by nature, not a guarantee.
const overLimit = createLimiter({ max: cfg.rateMax, windowMs: cfg.rateWindow });

module.exports = async function handler(req, res) {
  for (const [k, v] of Object.entries(corsHeaders(req.headers.origin, cfg.origins))) {
    res.setHeader(k, v);
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const missing = missingConfig(cfg);
  if (missing.length) {
    console.error('Missing Vercel env vars:', missing.join(', '));
    return res.status(500).json({ error: 'Server is not configured.' });
  }

  const ip = clientIp(req);
  if (overLimit(ip)) {
    res.setHeader('retry-after', '60');
    return res.status(429).json({ error: 'Slow down.' });
  }

  // Vercel parses JSON bodies for us, but a string arrives if the content-type
  // was wrong or the body was sent raw -- handle both rather than 500ing.
  let input = req.body;
  if (typeof input === 'string') {
    try { input = input ? JSON.parse(input) : {}; }
    catch { return res.status(400).json({ error: 'Malformed JSON.' }); }
  }
  if (input == null) input = {};

  const { row, error, bot } = validate(input);
  if (error) return res.status(400).json({ error });
  if (bot)   return res.status(201).json({ ok: true });   // look successful, store nothing

  try {
    const result = await captureLead(cfg, row);
    if (result.badInput) {
      console.warn('rejected by db:', result.detail);
      return res.status(400).json({ error: 'That did not look right. Check your details.' });
    }
    console.log(`lead ${row.p_email} score=${row.p_score} ip=${hashIp(ip, cfg.ipSalt)}`);
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('capture:', err.message);
    return res.status(502).json({ error: 'Could not save right now.' });
  }
};
