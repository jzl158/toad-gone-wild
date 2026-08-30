/**
 * GET /api/leaderboard  — Vercel serverless function
 *
 * Reads the `leaderboard` view: name, score, level. Never emails.
 */
'use strict';

const { config, missingConfig, fetchLeaderboard, corsHeaders } = require('../lib/capture.js');

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

  const missing = missingConfig(cfg);
  if (missing.length) {
    console.error('Missing Vercel env vars:', missing.join(', '));
    return res.status(500).json({ error: 'Server is not configured.' });
  }

  try {
    const leaderboard = await fetchLeaderboard(cfg, 25);
    // Public, non-personal data — let the edge hold it briefly so a busy
    // moment does not turn into 25 identical Supabase reads.
    res.setHeader('cache-control', 'public, s-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({ leaderboard });
  } catch (err) {
    console.error('leaderboard:', err.message);
    return res.status(502).json({ error: 'Leaderboard unavailable.' });
  }
};
