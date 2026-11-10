-- 02-listen-progress.sql — listening progress that follows a signed-in reader across devices.
-- Run once in Supabase → SQL Editor. Safe to run more than once. Adds columns only; changes no existing data.
-- The browser can already read its own user_library rows (see 01-lockdown.sql); only the server writes these.

alter table public.user_library
  add column if not exists listen_pos       real        not null default 0,   -- where they stopped, in seconds
  add column if not exists listen_dur       real,                             -- length of the audio, in seconds
  add column if not exists listen_pct       smallint    not null default 0,   -- furthest point reached, 0–100
  add column if not exists listens          integer     not null default 0,   -- times listened to the end
  add column if not exists finished_at      timestamptz,                      -- first time they finished it
  add column if not exists last_listened_at timestamptz;

-- Check: should list the six new columns.
select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'user_library'
  and (column_name like 'listen%' or column_name in ('finished_at','last_listened_at'))
order by column_name;

-- ROLLBACK (removes the feature's data only):
-- alter table public.user_library drop column listen_pos, drop column listen_dur, drop column listen_pct,
--   drop column listens, drop column finished_at, drop column last_listened_at;
