-- sql/02-spanish.sql
-- Creates the Spanish (Latin American) library table for the Spanish edition. RUN THIS ONCE in the Supabase SQL editor.
-- It only ADDS a table. The English tables, policies and data are not touched.
--
-- Each Spanish row has the SAME id as its English row in public.summaries, so a user's library, allowance and
-- profile keep working unchanged. Browser access mirrors the English lockdown: catalogue columns only
-- (id, title, author, synopsis, categories); the summary text is served by the API using the service key.

begin;

-- The id column copies whatever type summaries.id already has (bigint or uuid), so the foreign key always fits.
do $$
declare idtype text;
begin
  select format_type(a.atttypid, a.atttypmod) into idtype
  from pg_attribute a
  where a.attrelid = 'public.summaries'::regclass and a.attname = 'id' and not a.attisdropped;

  execute format($f$
    create table if not exists public.summaries_es (
      id          %s primary key references public.summaries(id) on delete cascade,
      title       text not null,          -- Spanish title
      author      text,                   -- author as in the English row (names are not translated)
      title_en    text,                   -- original English title
      html        text,
      plain       text,
      words       text,                   -- JSON string: 21 Spanish "Mega Words" [{word, definition}]
      synopsis    text,
      categories  text,                   -- JSON string, English category keys (same as the English row)
      lookup_key  text unique,
      created_at  timestamptz not null default now()
    )
  $f$, idtype);
end $$;

alter table public.summaries_es enable row level security;
revoke all on public.summaries_es from anon, authenticated;
grant select (id, title, author, synopsis, categories) on public.summaries_es to anon, authenticated;

drop policy if exists summaries_es_catalogue_read on public.summaries_es;
create policy summaries_es_catalogue_read on public.summaries_es for select to anon, authenticated using (true);

commit;

-- ── Check ──────────────────────────────────────────────────────────────────────────────────────
-- Should return 0 rows now and the pilot count after the translation run:
--   select count(*) from public.summaries_es;
-- As the anon role this must FAIL with "permission denied" (text is not readable from the browser):
--   select plain from public.summaries_es limit 1;

-- ── ROLLBACK (removes only the Spanish table) ─────────────────────────────────────────────────
-- drop table public.summaries_es;
