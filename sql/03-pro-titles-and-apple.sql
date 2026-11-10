-- sql/03-pro-titles-and-apple.sql
-- Run this yourself in the Supabase SQL editor, on staging first, after the API is deployed.
-- Safe to run more than once. It does not change downloads_used, LIMITS, or any stripe_* column.
--
-- What it adds:
--   1. title_creations — one row each time a Pro member commissions a new catalogue title.
--      The server counts rows from the last 12 months (rolling, UTC). Removing a book from
--      user_library does not delete these rows, so the 10-a-year cap is not refunded.
--      This is separate from profiles.downloads_used (the 200 library-book allowance).
--   2. Apple subscription columns on profiles, filled only after the server has checked
--      the purchase with Apple. Product id in the app: com.kernl.pro.annual (£20 a year).
--   3. apple_notifications — a record of App Store Server Notifications V2 already handled.
--
-- The browser is not granted access. The API uses the service role, which bypasses RLS.

-- ── 1. New-title log ──────────────────────────────────────────────────────────────────────────
create table if not exists public.title_creations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  -- Set null if the catalogue row is later removed, so the creation still counts.
  summary_id  uuid references public.summaries (id) on delete set null,
  lookup_key  text,
  title       text,
  author      text,
  created_at  timestamptz not null default now()
);

create index if not exists title_creations_user_created_idx
  on public.title_creations (user_id, created_at desc);

alter table public.title_creations enable row level security;
revoke all on public.title_creations from anon, authenticated;

comment on table public.title_creations is
  'Pro new-title commissions. Counted on a rolling 12 months. Not the library allowance.';

-- ── 2. App Store subscription on the profile (stripe_* columns are left as they are) ─────────
alter table public.profiles
  add column if not exists apple_original_transaction_id text,
  add column if not exists apple_product_id text,
  add column if not exists apple_expires_at timestamptz,
  add column if not exists apple_environment text,
  add column if not exists apple_status text,
  add column if not exists apple_transaction_id text;

create unique index if not exists profiles_apple_original_tx_idx
  on public.profiles (apple_original_transaction_id)
  where apple_original_transaction_id is not null;

comment on column public.profiles.apple_original_transaction_id is
  'App Store original transaction id for com.kernl.pro.annual. Empty when Pro was granted by hand.';

-- ── 3. Notification log ───────────────────────────────────────────────────────────────────────
create table if not exists public.apple_notifications (
  notification_uuid        text primary key,
  notification_type        text,
  original_transaction_id  text,
  received_at              timestamptz not null default now()
);

alter table public.apple_notifications enable row level security;
revoke all on public.apple_notifications from anon, authenticated;

-- ── 4. Check ──────────────────────────────────────────────────────────────────────────────────
-- title_creations and apple_notifications should show rowsecurity = true and no policies.
select c.relname, c.relrowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('title_creations', 'apple_notifications');

select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'profiles' and column_name like 'apple_%'
order by column_name;

-- ── ROLLBACK (removes the new-title log, the notification log, and the Apple columns) ────────
-- drop table if exists public.apple_notifications;
-- drop table if exists public.title_creations;
-- drop index if exists public.profiles_apple_original_tx_idx;
-- alter table public.profiles
--   drop column if exists apple_original_transaction_id,
--   drop column if exists apple_product_id,
--   drop column if exists apple_expires_at,
--   drop column if exists apple_environment,
--   drop column if exists apple_status,
--   drop column if exists apple_transaction_id;
