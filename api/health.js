/**
 * GET /api/health — Vercel serverless function
 *
 * Says whether this deployment can actually reach Supabase, and if not, what
 * went wrong. A capture failure otherwise surfaces as an opaque 502 with no way
 * to tell a missing env var from a wrong key from a missing table.
 *
 * Safe to expose: it reports the project host (which every Supabase browser app
 * ships anyway) and the KIND and length of the key, never the key itself.
 */
'use strict';

const { config, diagnose, corsHeaders } = require('../lib/capture.js');

const cfg = config();

module.exports = async function handler(req, res) {
  for (const [k, v] of Object.entries(corsHeaders(req.headers.origin, cfg.origins))) {
    res.setHeader(k, v);
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  res.setHeader('cache-control', 'no-store');
  const report = await diagnose(cfg);
  return res.status(report.supabase && report.supabase.ok ? 200 : 503).json(report);
};
