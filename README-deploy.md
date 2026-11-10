# Deploying the audit fixes (branch `audit-fixes`)

Order matters. Code first, then the SQL. Test on `dev` (staging) before `main`.

## 0. Supabase dashboard (do this first, staging project first if you have one)
Authentication → **Sign In / Providers**:
- **Allow anonymous sign-ins**: ON (this is how guests get their 12 books with no email)
- **Enable manual linking**: ON (lets a guest attach Google / email to the same account so their books carry over)
- **Google**: ON. Create an OAuth client in Google Cloud Console (APIs & Services → Credentials → OAuth client ID → Web application).
  Authorised redirect URI = the callback URL shown on Supabase's Google provider page (`https://<project>.supabase.co/auth/v1/callback`).
  Paste the Client ID and Secret into Supabase.
Authentication → **URL Configuration**: add `https://kernlbooks.com/app.html`, `https://kernlbooks.com/login.html` and your staging
URLs to Redirect URLs.
If anonymous sign-in is off or fails, the app falls back to the login page, so nothing breaks, guests just can't browse.

## 0b. The Vercel key must be the real service-role key
Supabase → Project Settings → API (or API Keys) → copy the **service_role** key (NOT the anon/public key).
Vercel → Settings → Environment Variables → `SUPABASE_SERVICE_KEY` → paste it, all environments, then redeploy.
The code now checks the key's own role and refuses a non-service-role key (and logs why in the Vercel function logs).

## 1. Before you push
Vercel → Project → Settings → Environment Variables. Confirm **`SUPABASE_SERVICE_KEY` is set for Production AND Preview**
(get-summary already used it, so Production almost certainly has it; Preview may not). Without it every API
route returns 500 "Server is not configured". Optional: `SUPABASE_URL` (defaults to the KERNL project).

## 2. Push the code to `dev`, test, then `main`
Nothing breaks if you deploy code before the SQL: the server just becomes stricter than the database.
Test on the staging URL:
- signed out, landing page demo (Meditations): text and play still work
- open /app.html in a private window: you are a guest ("12 of 12 free books remaining"), no login screen
- open any library book as a guest: counter drops by 1; re-open: no change; a book that isn't in the library is refused with "create a free account"
- guest → "Create free account" → Google: you land back in the app with the same books, now as a Free user
- Account page and sign-out hidden for guests; Account redirects a guest to sign-up
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

## Guest mode and tiers
- Guest (anonymous session) = 12 books, any in the library, cached audio only, no new summaries, no Kindle.
- Free account = **36** (must never be lower than guest or a guest who signs up is instantly over the limit). Pro = 200.
  Numbers live in `lib/kernl.js` (LIMITS), `public/app.js` and `public/account.html`. Change all three together.
- A guest who clears browser data gets a fresh 12. That is the accepted trade-off of no-email access. There is also a per-IP daily
  ceiling (150 new books) as a best-effort brake on scripts.
- Reading Journey removed from the Account page (the API still returns the data; nothing displays it).
- `library.html` now opens books in the app. `summary.html` is no longer linked from anywhere and can be deleted.

## Things to know
- **Admin/bulk scripts** that wrote to Supabase with the anon key will stop working after the SQL. Use the service-role key.
  For API calls from scripts send `Authorization: Bearer <service key>`.
- Cross-instance duplicate audio generation is reduced, not impossible (Vercel runs separate instances). The exists-check
  makes a second generation of a finished file a no-op.
- Removing a book from My Library does not refund the usage counter (same as before).
- Audio files are in a public bucket; anyone who knows a file URL can play it. Fixing that needs signed URLs — not done here.
- Pro is £20 a year in the iOS app (`com.kernl.pro.annual`). The website does not take payment. See below.
- Tests: `npm install && node test/mock.test.js` (mocked Supabase/xAI — it proves the rules, not the live services).

## Pro titles and the App Store

New catalogue titles (the Pro “Summarise a new book” button, `generate: true`) are capped at **10 per rolling 12 months**. That counter is `title_creations`. It is not `downloads_used`, and removing a book does not refund it. The library allowance is unchanged: guest 12, free 36, pro 200.

Run `sql/03-pro-titles-and-apple.sql` yourself in the Supabase SQL editor after this code is on staging. Do not point the app at production until you have run it there too. Until the table exists, new-title requests fail closed.

App Store verification needs these Vercel environment variables (Preview and Production). Do not commit the key:

- `APPLE_BUNDLE_ID` — suggested `com.kernl.books`
- `APPLE_ISSUER_ID`
- `APPLE_KEY_ID`
- `APPLE_PRIVATE_KEY` — contents of the App Store Connect .p8 key
- `APPLE_ENVIRONMENT` — `Sandbox` or `Production`
- `APPLE_APP_APPLE_ID` — optional numeric app id; when set, notifications must match it

Product id to create in App Store Connect: `com.kernl.pro.annual` (£20 a year).

- `POST /api/apple-verify` — the iOS app sends the signed transaction after a purchase or restore. The server checks it with Apple, then sets `profiles.tier`.
- `POST /api/apple-notifications` — App Store Server Notifications V2. Renewal keeps Pro. Refund, revoke and expiry set that subscription back to Free. A hand-granted Pro account with no Apple id is left alone.

Sign in with Apple is not in this change. Google sign-in is already offered, so the App Store build will need Sign in with Apple before submission. Email and password stay as they are.
