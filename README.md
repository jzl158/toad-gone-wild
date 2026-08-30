# Toad Gone Wild — lead capture

Beat the fourth board and the win overlay asks for a name and email before it
offers "Play again". Everything is wired; you need to add two Supabase values.

```
toad-gone-wild-crossing.html   the game + capture form
lib/capture.js                 shared validation, Supabase calls, rate limiting
api/scores.js                  Vercel function  -> POST /api/scores
api/leaderboard.js             Vercel function  -> GET  /api/leaderboard
backend/server.js              long-lived Node server (local dev / VPS)
backend/schema.sql             table, RLS, capture_lead() RPC, leaderboard view
backend/.env                   local only — never committed, never deployed
vercel.json                    routes / to the game
```

Two runtimes, one brain: `lib/capture.js` holds all validation, the Supabase
calls and the rate limiter, and is required by both the Vercel functions and
the standalone server, so the two cannot drift apart.

The Node server serves the game as well as the API. One origin means no CORS to
configure and no way to forget it, and one thing to deploy.

## Setup

**1. Run the schema.** Open the SQL editor in your Supabase project, paste
`backend/schema.sql`, run it.

**2. Add your keys.** In `backend/.env`, fill in the two placeholder lines from
Supabase → Project Settings → API:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
```

Use the **secret** key, not the publishable one. Newer projects label these
`sb_secret_...` and `sb_publishable_...`; older ones call the same pair
`service_role` and `anon`. The variable keeps the older name, but the server
accepts either format and warns loudly at startup if it gets a publishable key.

It stays on the server — `.env` is gitignored and the server refuses to serve
it over HTTP. The rest of the file already has working defaults, including a
generated `IP_SALT`.

**3. Start it.**

```bash
cd backend && npm start
```

Then open <http://localhost:8787>. No dependencies to install; needs Node 20.6+.
The server exits with a clear message if a key is still a placeholder.

Do not open the HTML file directly off disk — the API is not there to answer,
and submissions will queue instead of saving.

## What the schema creates

- **`game_leads`** — one row per player. RLS on with **no policies at all**, so
  neither the anon key nor a logged-in user can read, update, or delete it.
- **`capture_lead(...)`** — a `security definer` function that is the only write
  path. Trims and lowercases the email, revalidates name and email server side,
  clamps the score, and upserts on email keeping the player's **best** score
  while incrementing `plays`. A second win improves their standing instead of
  erroring on the unique index.
- **`leaderboard`** — a view of name, score, and level. No emails.

## Routes

| | |
|---|---|
| `GET /` | the game |
| `POST /api/scores` | validate → rate limit → `capture_lead` |
| `GET /api/leaderboard` | top 25, names and scores only |
| `GET /health` | |

`/api/leaderboard` is live but nothing in the game consumes it yet — it is there
for when you want to show a top-scores panel.

## Reading your list

```sql
select name, email, score, plays, created_at
from game_leads
order by score desc;
```

The Supabase table editor works too — it uses the service role, so RLS does not
hide anything from you.

## How the form behaves

- **Validation** runs client side, again in the Node API, and again inside
  `capture_lead()`. Only the last one actually protects the data.
- **Honeypot** — a hidden `website` field. Anything that fills it gets a success
  response and is silently discarded.
- **Network failure does not lose the lead.** It queues in `localStorage` (last
  25) and retries on the next page load. The player sees "Saved, we will sync…"
  rather than an error they cannot act on.
- **Returning players** get name and email prefilled.
- **Skip** is always available. No one is trapped behind the form.
- **It appears on game over too**, headed "Save your rank" rather than "Get on
  the board". Two guards stop that becoming nagging: once a player hits Skip,
  losing stops asking for the rest of the page session, and a losing run whose
  score is no better than one already banked does not ask at all. **Winning
  always asks**, regardless of either guard — a win is worth interrupting for.
  `capture_lead` keeps the greater score, so submitting a bad run can never
  pull a player's rank down.
- **Rate limit** is 10 submissions per IP per minute; IPs are only ever logged
  as a salted hash, never stored in the table.

## Deploying

### Vercel (what this repo is set up for)

Set two environment variables in the Vercel dashboard — Settings → Environment
Variables — and deploy:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your secret key>
```

`api/scores.js` and `api/leaderboard.js` are picked up automatically as
functions; `vercel.json` rewrites `/` to the game. `backend/` is excluded from
the deployment by `.vercelignore`, along with `.env` at any depth — the Vercel
CLI uploads your working directory, so that exclusion matters even though
`.env` is untracked in git.

The game needs no config change: it targets `location.origin`, which on Vercel
is your deployment URL, so `/api/scores` resolves on the same origin.

**One caveat.** The per-IP rate limit is in-process. On a long-lived server it
is exact; on Vercel each warm instance keeps its own counter and cold starts
reset it, so there it is best-effort — it blunts a naive flood but will not
stop a determined one. What actually bounds abuse is the honeypot plus
`capture_lead` upserting on email, so hammering one address rewrites one row
rather than growing the table. If you ever need a real limit, move the counter
into Postgres or a KV store.

Note that `README.md` and `lib/capture.js` are served as static files at their
own paths. Neither contains a secret, and both are public on GitHub anyway.

### Anywhere that runs Node

Fly, Railway, Render, a VPS — `backend/server.js` serves the game and the API
from one process. Set the same env vars, point `ALLOWED_ORIGINS` at your real
origin if the game is hosted separately, and put it behind TLS.

### Static host, no server at all

The schema supports the browser talking to Supabase directly, since the anon
key can only reach `capture_lead` and cannot read the table. Set `supabaseUrl`
and `supabaseAnonKey` in the HTML config. You lose the server-side rate limit
and honeypot enforcement.

## Things worth knowing

**The score is a claim, not a fact.** It is computed and posted by the browser,
so anyone with devtools can submit any number. Both layers clamp it to the
0–100000 range the game can actually produce, which is the right amount of
effort for a mailing list. A leaderboard people genuinely compete on would need
server-authoritative scoring — a signed run token or replaying inputs server
side — and is a much bigger change.

**Email is the identity key**, stored `citext`, so `Ada@x.com` and `ada@x.com`
are one person.

**You are collecting personal data.** The form promises you will only email
about this game — honour that, and give people a real unsubscribe before you
send anything. GDPR or CAN-SPAM may apply depending on where your players are.

## Verified

Tested end to end against the live Supabase project, not just a stub:

- A capture through `POST /api/scores` lands in `game_leads`, with
  `Verify.Toad@Example.COM` normalised to `verify.toad@example.com`.
- A second win with a **better** score updates to it and increments `plays`;
  a third with a **worse** score does not regress it. Case-varied email still
  matched the same row, confirming `citext`.
- `leaderboard` returns name and score, never email.
- **RLS holds**: with a publishable/anon key, `select` on `game_leads` returns
  `[]` even while a row exists. The public key cannot read the email list.

The test row was deleted afterward; the table is empty.

In the browser: the win overlay's form, client validation, honeypot, the
offline queue and its flush on reload, skip, play-again reset, and layout at
375px and desktop widths. On the server: the game serves from `/` with ETag
revalidation, and `.env`, `server.js`, `schema.sql`, `README.md`, dotfiles, and
percent-encoded traversal (`%2e%2e%2f`) all return 403.
