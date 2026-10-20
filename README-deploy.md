# Deploying the audit fixes (branch `audit-fixes`)

Order matters. Code first, then the SQL. Test on `dev` (staging) before `main`.

## 1. Before you push
Vercel → Project → Settings → Environment Variables. Confirm **`SUPABASE_SERVICE_KEY` is set for Production AND Preview**
(get-summary already used it, so Production almost certainly has it; Preview may not). Without it every API
route returns 500 "Server is not configured". Optional: `SUPABASE_URL` (defaults to the KERNL project).

## 2. Push the code to `dev`, test, then `main`
Nothing breaks if you deploy code before the SQL: the server just becomes stricter than the database.
Test on the staging URL:
- signed out, open the landing page demo (Meditations): text, play, Send to Kindle still work
- signed in free user: open a new book → counter goes up by 1; re-open the same book → no change
- signed in free user at the limit: opening a new book is refused (403) with a clear message
- Pro user: new book generates, audio generates ONCE (check xAI usage / Storage: one file)
- free user, uncached audio: shows "Audio available on Pro", and nothing is generated

## 3. Run `sql/01-lockdown.sql` (Supabase SQL editor)
Read the output of the first two queries (existing policies; the sign-up trigger) before running the rest.
After it: anon key can read only title/author/synopsis/categories; nothing can be written from the browser.
Then retest sign-up, login, the library grid, Account page, remove-from-library.

## What changed
- `lib/kernl.js` (new) — one place for Supabase access (service key from env), who-is-calling, limits, guest list, audio keys/hash
- All API routes: no hard-coded key; tier/limit/guest rules enforced on the server
- tts / tts-stream / generate-audio: text is read from the library, never from the browser; one key scheme; `audio_meta` always written;
  existing audio is never regenerated; same-instance concurrent requests share one xAI call; generation is Pro/admin only
- get-summary / summarise: exact-first lookups; anonymous = guest books only; signed in = server counts usage
- send-to-kindle: content from the library; recipient must be @kindle.com / @free.kindle.com; 10/hour limit
- summarise `patchWords`: admin (service key) only
- app.js: sends the session token on every call, no longer writes `profiles` / `user_library`, single audio trigger

## Things to know
- **Admin/bulk scripts** that wrote to Supabase with the anon key will stop working after the SQL. Use the service-role key.
  For API calls from scripts send `Authorization: Bearer <service key>`.
- Cross-instance duplicate audio generation is reduced, not impossible (Vercel runs separate instances). The exists-check
  makes a second generation of a finished file a no-op.
- Removing a book from My Library does not refund the usage counter (same as before).
- The guest book list lives in `lib/kernl.js` (`GUEST_BOOKS`) and `public/library.html` (`CURATED_BOOKS`). They must match.
- Audio files are in a public bucket; anyone who knows a file URL can play it. Fixing that needs signed URLs — not done here.
- `/upgrade.html` does not exist (the Upgrade button 404s). No payment flow yet.
- `public/summary.html` and `public/library.html` are untouched for now; they still work for the 24 guest books.
- Tests: `npm install && node test/mock.test.js` (mocked Supabase/xAI — it proves the rules, not the live services).
