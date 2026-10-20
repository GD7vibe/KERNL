-- sql/01-lockdown.sql
-- RUN THIS ONLY AFTER the new API code is deployed AND SUPABASE_SERVICE_KEY is set for that environment.
-- Run it on a staging/branch database first if you have one; otherwise run it in the Supabase SQL editor
-- and test straight away (rollback notes at the bottom).
--
-- What it does: the browser (anon / authenticated roles) can no longer write anything, and can only read
--   - summaries: the catalogue columns (id, title, author, synopsis, categories) — NOT the text
--   - profiles: its own row
--   - user_library: its own rows (read + delete)
-- All other access goes through the API using the service-role key, which bypasses RLS.

-- ── 0. See what exists now (informational; read the output before continuing) ──────────────────
select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where (schemaname = 'public' and tablename in ('summaries','profiles','user_library','audio_meta','sync_errors'))
   or (schemaname = 'storage' and tablename = 'objects')
order by schemaname, tablename, policyname;

-- Profile rows must be created by a trigger on auth.users, because the browser can no longer insert them.
-- This should return at least one row. If it returns none, STOP and tell me: new sign-ups would have no profile.
select t.tgname, c.relname
from pg_trigger t join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'auth' and c.relname = 'users' and not t.tgisinternal;

begin;

-- ── 1. Drop every existing policy on the five tables, then recreate the minimal set ─────────────
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies
           where schemaname = 'public' and tablename in ('summaries','profiles','user_library','audio_meta','sync_errors')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

alter table public.summaries    enable row level security;
alter table public.profiles     enable row level security;
alter table public.user_library enable row level security;
alter table public.audio_meta   enable row level security;
alter table public.sync_errors  enable row level security;

-- ── 2. Table privileges: start from nothing, grant back only what the browser needs ─────────────
revoke all on public.summaries    from anon, authenticated;
revoke all on public.profiles     from anon, authenticated;
revoke all on public.user_library from anon, authenticated;
revoke all on public.audio_meta   from anon, authenticated;
revoke all on public.sync_errors  from anon, authenticated;

-- summaries: catalogue columns only (the summary text is served by /api/get-summary and /api/summarise)
grant select (id, title, author, synopsis, categories) on public.summaries to anon, authenticated;
create policy summaries_catalogue_read on public.summaries for select to anon, authenticated using (true);

-- profiles: read your own row. Tier and the usage counter can only be changed by the server.
grant select on public.profiles to authenticated;
create policy profiles_read_own on public.profiles for select to authenticated using (auth.uid() = id);

-- user_library: read and remove your own rows. Rows are added by the server when you open a book.
grant select, delete on public.user_library to authenticated;
create policy user_library_read_own   on public.user_library for select to authenticated using (auth.uid() = user_id);
create policy user_library_delete_own on public.user_library for delete to authenticated using (auth.uid() = user_id);

-- audio_meta, sync_errors: server only (no grants, no policies).

-- ── 3. Storage: the audio bucket stays publicly READABLE; remove any browser write policies ─────
do $$
declare r record;
begin
  for r in select policyname from pg_policies
           where schemaname = 'storage' and tablename = 'objects'
             and cmd in ('INSERT','UPDATE','DELETE','ALL')
             and (coalesce(qual,'') ilike '%audio%' or coalesce(with_check,'') ilike '%audio%')
             and (roles && array['anon','authenticated','public']::name[])
  loop
    raise notice 'dropping storage policy: %', r.policyname;
    execute format('drop policy %I on storage.objects', r.policyname);
  end loop;
end $$;

commit;

-- ── 4. Check ───────────────────────────────────────────────────────────────────────────────────
-- As the anon role this should now FAIL with "permission denied" (text is no longer readable):
--   select plain from public.summaries limit 1;
-- and this should work:
--   select title, author from public.summaries limit 1;

-- ── ROLLBACK (if something you rely on breaks and you need the old behaviour back quickly) ──────
-- grant select, insert, update, delete on public.summaries, public.profiles, public.user_library,
--   public.audio_meta, public.sync_errors to anon, authenticated;
-- create policy temp_open on public.summaries for all to anon, authenticated using (true) with check (true);
-- (repeat the policy for the other tables). Then tell me what broke.
