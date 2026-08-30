-- ============================================================
--  Toad Gone Wild -- lead capture schema
--  Paste into the Supabase SQL editor and run once.
--
--  Design: the table is fully locked (RLS on, zero policies). All
--  writes go through capture_lead(), a security-definer function.
--  That way the public anon key can add a lead but can never read,
--  update, or delete the email list -- even if it leaks.
-- ============================================================

create extension if not exists citext;
create extension if not exists pgcrypto;   -- gen_random_uuid()

create table if not exists public.game_leads (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  name        text        not null,
  email       citext      not null unique,
  score       integer     not null default 0,
  level       smallint    not null default 4,
  duration_ms integer,
  plays       integer     not null default 1,
  source      text        not null default 'web',
  user_agent  text,
  constraint game_leads_name_len  check (char_length(btrim(name)) between 2 and 60),
  constraint game_leads_email_fmt check (email ~ '^[^\s@]+@[^\s@]+\.[a-z]{2,}$'),
  constraint game_leads_score_rng check (score between 0 and 100000),
  constraint game_leads_level_rng check (level between 1 and 4)
);

create index if not exists game_leads_score_idx   on public.game_leads (score desc, created_at asc);
create index if not exists game_leads_created_idx on public.game_leads (created_at desc);

alter table public.game_leads enable row level security;
-- Deliberately no policies: anon and authenticated get nothing directly.

-- ============================================================
--  capture_lead -- the only write path
--  Upserts on email and keeps the player's BEST score, so a second
--  win improves their standing instead of erroring or regressing it.
-- ============================================================
create or replace function public.capture_lead(
  p_name        text,
  p_email       text,
  p_score       integer default 0,
  p_level       smallint default 4,
  p_duration_ms integer default null,
  p_source      text default 'web'
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name  text := btrim(coalesce(p_name, ''));
  v_email citext := lower(btrim(coalesce(p_email, '')));
begin
  if char_length(v_name) < 2 or char_length(v_name) > 60 then
    raise exception 'invalid name' using errcode = '22023';
  end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[a-z]{2,}$' or char_length(v_email) > 200 then
    raise exception 'invalid email' using errcode = '22023';
  end if;

  insert into public.game_leads (name, email, score, level, duration_ms, source)
  values (v_name, v_email,
          least(greatest(coalesce(p_score, 0), 0), 100000),
          least(greatest(coalesce(p_level, 4), 1), 4),
          nullif(greatest(coalesce(p_duration_ms, 0), 0), 0),
          coalesce(nullif(btrim(p_source), ''), 'web'))
  on conflict (email) do update
    set name        = excluded.name,
        score       = greatest(public.game_leads.score, excluded.score),
        level       = greatest(public.game_leads.level, excluded.level),
        duration_ms = case when excluded.score > public.game_leads.score
                           then excluded.duration_ms else public.game_leads.duration_ms end,
        plays       = public.game_leads.plays + 1,
        updated_at  = now();
end;
$$;

revoke all on function public.capture_lead(text, text, integer, smallint, integer, text) from public;
grant execute on function public.capture_lead(text, text, integer, smallint, integer, text)
  to anon, authenticated, service_role;

-- ============================================================
--  Public leaderboard -- names and scores only, never emails.
--  Runs as the view owner, so it reads past the table's RLS.
-- ============================================================
create or replace view public.leaderboard as
  select name, score, level, updated_at
  from public.game_leads
  order by score desc, updated_at asc
  limit 25;

grant select on public.leaderboard to anon, authenticated;
