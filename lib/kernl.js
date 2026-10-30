'use strict';
// lib/kernl.js
// Shared server-side helpers for every KERNL API function.
//
// One place that:
//   - holds the Supabase credentials (service-role key, from the environment — never in code)
//   - works out who a request is from (signed-in user, admin script, or anonymous)
//   - enforces tier limits and the free guest-book list
//   - builds audio keys / hashes consistently across tts, tts-stream and generate-audio
//
// Requires Vercel environment variables (Production AND Preview):
//   SUPABASE_SERVICE_KEY   service-role key   (already set — get-summary.js uses it)
//   SUPABASE_URL           optional, defaults to the KERNL project URL

const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://peebgzfufyklxzdfnesc.supabase.co').replace(/\/+$/, '');
const RAW_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// SUPABASE_SERVICE_KEY must really be the service-role key. If someone pastes the PUBLIC anon key there
// (easy to do, and it looks identical), every write fails and, worse, the anon key — which is visible in the
// page source — would be accepted as the admin password. So the key's own role claim is checked, and a key that
// is not service-role is treated as missing: no admin access, and every server-side data call fails loudly.
function keyIsServiceRole(key) {
  if (!key) return false;
  if (key.startsWith('sb_secret_')) return true;               // new-style secret key
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64').toString('utf8'));
    return payload.role === 'service_role';
  } catch (e) { return false; }
}
const SERVICE_KEY = keyIsServiceRole(RAW_SERVICE_KEY) ? RAW_SERVICE_KEY : '';
if (RAW_SERVICE_KEY && !SERVICE_KEY) {
  console.error('[kernl] SUPABASE_SERVICE_KEY is set but is NOT a service-role key (looks like the anon key). Server features are disabled until it is replaced.');
}

// The anon key is PUBLIC by design (it ships in the browser). The server only uses it to
// ask Supabase Auth whose access token a request is carrying. It is never used to read
// or write data any more.
const ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';

// ── Limits ────────────────────────────────────────────────────────────────────
// guest = anonymous visitor (no email), free = signed-in free account, pro = paid.
// free is not allowed to be lower than guest, or a guest who signs up would find themselves already over the limit.
// Mirrored in public/app.js and public/account.html — change all three together.
const LIMITS = { guest: 12, free: 36, pro: 200 };

// The only book readable with NO session at all (the landing-page demo). Everything else needs at least
// an anonymous guest session, which is how the guest allowance is counted.
const DEMO_BOOKS = [['Meditations', 'aurelius']];

// ── String helpers ────────────────────────────────────────────────────────────
const enc = encodeURIComponent;

// Identical to norm() in summarise.js — lookup keys are built with this, so it must not drift.
function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/[‘’“”'"]/g, '')
    .replace(/[*!?@#$%^&()_+=\[\]{};:<>,.\/\\|~`]/g, '')
    .replace(/\s+/g, ' ').trim();
}

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function makeLookupKey(title, author) { return norm(title) + '||' + norm(author) + '||nospoilers'; }

// "Sapiens: A Brief History of Humankind" -> "sapiens"; drops a leading article.
function baseTitle(s) {
  return norm(String(s || '').split(/\s*[:—(]\s*|\s+-\s+/)[0]).replace(/^(the|a|an)\s+/, '');
}

const DEMO_SET = DEMO_BOOKS.map(([t, a]) => [baseTitle(t), a]);

function isDemoBook(row) {
  if (!row) return false;
  const t = baseTitle(row.title);
  const a = fold(row.author);
  return DEMO_SET.some(([bt, key]) => bt === t && a.includes(key));
}

function lastName(s) {
  const parts = fold(s).replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// Loose "is this probably the same author" test — only used to stop a title-only match
// returning a different book that happens to share the title.
function authorMatches(rowAuthor, queryAuthor) {
  if (!String(queryAuthor || '').trim()) return true;
  const ra = fold(rowAuthor), qa = fold(queryAuthor);
  if (!ra) return true;
  const rl = lastName(rowAuthor), ql = lastName(queryAuthor);
  return ra.includes(qa) || qa.includes(ra) || (ql && ra.includes(ql)) || (rl && qa.includes(rl));
}

// Escape a value for an exact, case-insensitive ILIKE (no wildcards).
function likeEq(s) { return String(s || '').replace(/\*/g, '').replace(/[\\%_]/g, m => '\\' + m); }

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

// Strip control characters and cap the length of anything a user types that ends up in a prompt.
function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200);
}

// ── Supabase REST (service role) ─────────────────────────────────────────────
function requireServiceKey() {
  if (!SERVICE_KEY) {
    const e = new Error(RAW_SERVICE_KEY ? 'SUPABASE_SERVICE_KEY is not a service-role key' : 'Server is not configured (SUPABASE_SERVICE_KEY missing)');
    e.status = 500;
    throw e;
  }
}

async function sb(path, opts) {
  requireServiceKey();
  const o = opts || {};
  const headers = Object.assign({ apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }, o.headers || {});
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  if (o.prefer) headers.Prefer = o.prefer;
  const res = await fetch(SUPABASE_URL + path, {
    method: o.method || 'GET',
    headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// ── Who is calling? ──────────────────────────────────────────────────────────
function bearer(req) {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

const _authCache = new Map(); // token -> { ctx, exp }

// Returns:
//   { admin: true,  tier: 'pro', user: null }               — a script holding the service-role key
//   { admin: false, tier: 'free'|'pro', user: {id,email} }  — a signed-in user
//   null                                                    — anonymous / invalid token
async function authenticate(req) {
  const token = bearer(req);
  if (!token) return null;

  if (SERVICE_KEY && safeEqual(token, SERVICE_KEY)) return { admin: true, tier: 'pro', user: null, ip: clientIp(req) };

  const ip = clientIp(req);
  const hit = _authCache.get(token);
  if (hit && hit.exp > Date.now()) return Object.assign({}, hit.ctx, { ip });

  let r;
  try {
    r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token } });
  } catch (e) { return null; }
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  if (!u || !u.id) return null;

  // Anonymous sign-ins (visitors with no email) are the 'guest' tier.
  let tier = u.is_anonymous ? 'guest' : 'free';
  if (tier === 'free') try {
    const p = await sb('/rest/v1/profiles?id=eq.' + enc(u.id) + '&select=tier&limit=1');
    if (p.ok && p.data && p.data[0] && p.data[0].tier === 'pro') tier = 'pro';
  } catch (e) { /* default to free */ }

  const ctx = { admin: false, tier, user: { id: u.id, email: u.email || null, anonymous: !!u.is_anonymous } };
  if (_authCache.size > 500) _authCache.clear();
  _authCache.set(token, { ctx, exp: Date.now() + 60 * 1000 });
  return Object.assign({}, ctx, { ip });
}

// ── Finding books ────────────────────────────────────────────────────────────
const BOOK_COLS = 'id,title,author,plain,html,words,lookup_key';

// Exact lookups only: lookup_key first, then case-insensitive title equality with an
// author sanity check. Never a substring match, so it can't return a different book.
async function findBook(title, author, cols) {
  const t = cleanText(title, 300), a = cleanText(author, 300);
  if (!t) return null;
  const select = cols || BOOK_COLS;

  const keys = [makeLookupKey(t, a), norm(t) + '||' + norm(a) + '||spoilers'];
  for (const k of keys) {
    const r = await sb('/rest/v1/summaries?select=' + select + '&lookup_key=eq.' + enc(k) + '&limit=1');
    if (r.ok && Array.isArray(r.data) && r.data.length) return r.data[0];
  }

  const r = await sb('/rest/v1/summaries?select=' + select + '&title=ilike.' + enc(likeEq(t)) + '&limit=20');
  if (!r.ok || !Array.isArray(r.data) || !r.data.length) return null;
  const rows = r.data.filter(row => authorMatches(row.author, a));
  if (!rows.length) return null;
  if (a) {
    const na = norm(a);
    const exact = rows.find(row => norm(row.author) === na);
    if (exact) return exact;
  }
  return rows[0];
}

// Looser lookup kept for get-summary (callers like the legacy player pass a title only).
async function findBookFuzzy(title, author, cols) {
  const exact = await findBook(title, author, cols);
  if (exact) return exact;

  const select = cols || BOOK_COLS;
  const t = cleanText(title, 300), a = cleanText(author, 300);
  const nt = norm(t), na = norm(a);
  if (!nt) return null;

  const r = await sb('/rest/v1/summaries?select=' + select + '&title=ilike.' + enc('%' + likeEq(t) + '%') + '&limit=20');
  if (r.ok && Array.isArray(r.data) && r.data.length) {
    let rows = r.data.filter(row => authorMatches(row.author, a));
    if (na) rows = rows.sort((x, y) => levenshtein(norm(x.author), na) - levenshtein(norm(y.author), na));
    const best = rows[0];
    if (best && levenshtein(norm(best.title), nt) <= Math.max(5, nt.length * 0.3)) return best;
  }

  const words = nt.split(' ').filter(w => w.length > 4);
  for (const word of words) {
    const w = await sb('/rest/v1/summaries?select=' + select + '&title=ilike.' + enc('%' + likeEq(word) + '%') + '&limit=10');
    if (w.ok && Array.isArray(w.data) && w.data.length) {
      const rows = w.data.filter(row => authorMatches(row.author, a))
        .sort((x, y) => levenshtein(norm(x.title), nt) - levenshtein(norm(y.title), nt));
      const best = rows[0];
      if (best && levenshtein(norm(best.title), nt) <= Math.max(5, nt.length * 0.4)) return best;
    }
  }
  return null;
}

// ── Limits, ownership, quota ─────────────────────────────────────────────────
function limitFor(tier) { return LIMITS[tier] || LIMITS.free; }

async function getProfile(userId) {
  const r = await sb('/rest/v1/profiles?id=eq.' + enc(userId) + '&select=tier,downloads_used&limit=1');
  return r.ok && Array.isArray(r.data) && r.data.length ? r.data[0] : null;
}

async function getOwnedIds(userId) {
  const r = await sb('/rest/v1/user_library?select=summary_id&user_id=eq.' + enc(userId) + '&limit=5000');
  const rows = r.ok && Array.isArray(r.data) ? r.data : [];
  return new Set(rows.map(x => String(x.summary_id)));
}

async function isOwned(userId, summaryId) {
  const r = await sb('/rest/v1/user_library?select=id&user_id=eq.' + enc(userId) + '&summary_id=eq.' + enc(summaryId) + '&limit=1');
  return r.ok && Array.isArray(r.data) && r.data.length > 0;
}

// Opening a book that isn't already in the user's library costs one slot.
// Returns { ok:true, quota } or { ok:false, status, body }.
async function accessBook(ctx, summaryId) {
  if (ctx.admin) return { ok: true, quota: null };

  const [profile, owned] = await Promise.all([getProfile(ctx.user.id), getOwnedIds(ctx.user.id)]);
  const limit = limitFor(ctx.tier);
  // The counter never goes down when a book is removed from a library; the row count is a floor for accounts without a profile row.
  let used = Math.max(profile ? (profile.downloads_used || 0) : 0, owned.size);
  const quota = () => ({ used, limit, tier: ctx.tier });

  if (owned.has(String(summaryId))) return { ok: true, quota: quota() };

  if (used >= limit) {
    const msg = ctx.tier === 'guest'
      ? 'You have used your ' + limit + ' free books. Create a free account to keep your library, or upgrade to Pro for ' + LIMITS.pro + ' a year.'
      : ctx.tier === 'pro'
        ? 'You have reached your annual limit of ' + limit + ' summaries.'
        : 'You have used all ' + limit + ' of your free summaries. Upgrade to Pro for ' + LIMITS.pro + ' a year.';
    return { ok: false, status: 403, body: { code: 'limit', error: msg, quota: quota() } };
  }

  // Backstop against scripted guest farming: anonymous sessions are free to create, so cap by IP too.
  // (In-memory per serverless instance, so best effort. Generous enough for a shared office or school.)
  if (ctx.tier === 'guest' && ctx.ip && rateLimited('guestopen:' + ctx.ip, 150, 24 * 60 * 60 * 1000)) {
    return { ok: false, status: 429, body: { code: 'ip_limit', error: 'Too many new books from this network today. Please sign in or try again tomorrow.', quota: quota() } };
  }

  const ins = await sb('/rest/v1/user_library?on_conflict=user_id,summary_id,voice,language', {
    method: 'POST',
    body: { user_id: ctx.user.id, summary_id: summaryId, voice: 'female', language: 'en' },
    prefer: 'resolution=ignore-duplicates,return=representation'
  });
  if (!ins.ok) {
    // Fail closed: if we cannot record the book we must not hand it out uncounted.
    console.error('[accessBook] user_library insert failed:', ins.status, JSON.stringify(ins.data).slice(0, 300));
    return { ok: false, status: 503, body: { code: 'record_failed', error: 'Could not record this book. Please try again.' } };
  }
  const inserted = Array.isArray(ins.data) && ins.data.length > 0;
  if (inserted) {
    used += 1;
    if (profile) {
      const pr = await sb('/rest/v1/profiles?id=eq.' + enc(ctx.user.id), {
        method: 'PATCH', body: { downloads_used: used }, prefer: 'return=minimal'
      });
      if (!pr.ok) console.error('[accessBook] profiles update failed:', pr.status, JSON.stringify(pr.data).slice(0, 200));
    }
  }
  return { ok: true, quota: quota() };
}

// May this caller read this book's text? (anonymous callers: guest books only)
// Returns { ok:true, quota? } or { ok:false, status, body }.
async function authoriseRead(ctx, book) {
  if (isDemoBook(book)) return { ok: true, quota: null };
  if (!ctx) return { ok: false, status: 401, body: { code: 'auth_required', error: 'Please sign in to read this summary.' } };
  return accessBook(ctx, book.id);
}

// May this caller play/generate audio for this book?
//   anonymous: guest books only · signed-in: books already in their library · admin: anything
async function authoriseAudioRead(ctx, book) {
  if (isDemoBook(book)) return { ok: true };
  if (!ctx) return { ok: false, status: 401, body: { code: 'auth_required', error: 'Please sign in to listen.' } };
  if (ctx.admin) return { ok: true };
  if (await isOwned(ctx.user.id, book.id)) return { ok: true };
  return { ok: false, status: 403, body: { code: 'not_in_library', error: 'Open this summary first, then press play.' } };
}

// Generating NEW audio costs money: Pro users and admins only. Playing audio that already
// exists is open to anyone who may read the book (see authoriseAudioRead).
function canGenerateAudio(ctx) { return !!(ctx && (ctx.admin || ctx.tier === 'pro')); }

// ── Audio ─────────────────────────────────────────────────────────────────────
function safeName(s) { return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').slice(0, 60); }

function audioKey(title, author, voice) {
  return safeName(title) + '__' + safeName(author) + '__' + (voice === 'male' ? 'male' : 'female') + '.mp3';
}

// Keys to look for, newest convention first: the library row's own title/author, then
// whatever the browser sent (older files were named from what the browser sent).
function audioKeyCandidates(book, clientTitle, clientAuthor, voice) {
  const keys = [audioKey(book.title, book.author, voice)];
  if (clientTitle) {
    const k = audioKey(clientTitle, clientAuthor || 'unknown', voice);
    if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}

// FNV-32 — must stay identical to the hash already stored in audio_meta.
function fnv32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function plainHash(plain) { return fnv32(String(plain || '').replace(/\s+/g, ' ').trim()); }

function publicAudioUrl(filename) { return SUPABASE_URL + '/storage/v1/object/public/audio/' + enc(filename); }

async function storageHas(filename) {
  requireServiceKey();
  const r = await fetch(SUPABASE_URL + '/storage/v1/object/info/audio/' + enc(filename), {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
  });
  return r.ok;
}

// First candidate key that exists in Storage (with the legacy .wav fallback). Returns { filename, url } or null.
async function findCachedAudio(keys) {
  for (const k of keys) {
    if (await storageHas(k)) return { filename: k, url: publicAudioUrl(k) };
    const wav = k.replace(/\.mp3$/, '.wav');
    if (await storageHas(wav)) return { filename: wav, url: publicAudioUrl(wav) };
  }
  return null;
}

async function getAudioMeta(key) {
  try {
    const r = await sb('/rest/v1/audio_meta?audio_key=eq.' + enc(key) + '&select=plain_hash&limit=1');
    return r.ok && Array.isArray(r.data) && r.data.length ? r.data[0] : null;
  } catch (e) { return null; }
}

// Records which text an audio file was made from. Updates the existing record for this file if there is one,
// otherwise adds it. (A plain insert is refused once a record exists, which left re-made audio marked as
// "made from older text" forever, so it was never served.)
async function saveAudioMeta(book, voice, key, plain) {
  try {
    const fields = {
      title: book.title, author: book.author, voice, audio_key: key, plain_hash: plainHash(plain),
      voice_gender: voice === 'male' ? 'male' : 'female',
      voice_accent: 'british',   // all current xAI voices are British English
      voice_language: 'en'
    };
    const upd = await sb('/rest/v1/audio_meta?audio_key=eq.' + enc(key), { method: 'PATCH', prefer: 'return=representation', body: fields });
    if (upd.ok && Array.isArray(upd.data) && upd.data.length) return true;
    const ins = await sb('/rest/v1/audio_meta', { method: 'POST', prefer: 'return=minimal', body: fields });
    if (ins.ok) return true;
    // Lost a race with another save of the same file: update the record that now exists.
    if (ins.status === 409) {
      const again = await sb('/rest/v1/audio_meta?audio_key=eq.' + enc(key), { method: 'PATCH', prefer: 'return=representation', body: fields });
      if (again.ok && Array.isArray(again.data) && again.data.length) return true;
    }
    console.error('[audio_meta] save failed:', ins.status, JSON.stringify(ins.data).slice(0, 200));
    return false;
  } catch (e) {
    console.error('[audio_meta] save error:', e.message);
    return false;
  }
}

async function uploadAudio(filename, buffer) {
  requireServiceKey();
  const r = await fetch(SUPABASE_URL + '/storage/v1/object/audio/' + enc(filename), {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'audio/mpeg', 'Cache-Control': '3600', 'x-upsert': 'true'
    },
    body: buffer
  });
  if (!r.ok) console.error('[audio] upload failed:', r.status, (await r.text()).slice(0, 200));
  return r.ok;
}

// ── Spending guard: never pay xAI for the same audio file more than AUDIO_DAILY_CAP times a day ──
// Every paid attempt is written down BEFORE paying (failed attempts count too, because they are paid for as
// well), in sync_errors as error_type 'audio_paid', detail '<file>|<YYYY-MM-DD>'. If the count can't be read,
// nothing is paid for (fail closed). Applies to everyone, admins included.
const AUDIO_DAILY_CAP = 2;
async function reserveAudioSpend(book, voice, key) {
  const tag = key + '|' + new Date().toISOString().slice(0, 10);
  const r = await sb('/rest/v1/sync_errors?select=id&error_type=eq.audio_paid&detail=eq.' + enc(tag) + '&limit=' + (AUDIO_DAILY_CAP + 1));
  if (!r.ok || !Array.isArray(r.data)) return { ok: false, reason: 'check_failed' };
  if (r.data.length >= AUDIO_DAILY_CAP) {
    await logSyncError(book, voice, 'audio_cap_reached', 'Refused to pay for ' + key + ' again today (' + r.data.length + ' paid attempts already).');
    return { ok: false, reason: 'cap' };
  }
  const w = await sb('/rest/v1/sync_errors', { method: 'POST', prefer: 'return=minimal',
    body: { title: book.title, author: book.author, voice: voice || null, error_type: 'audio_paid', detail: tag, resolved: true } });
  return w.ok ? { ok: true } : { ok: false, reason: 'check_failed' };
}
function audioSpendRefusal(r) {
  return r.reason === 'cap'
    ? { status: 429, body: { code: 'audio_daily_cap', error: 'Audio for this book has already been made twice today, so it will not be paid for again until tomorrow.' } }
    : { status: 503, body: { code: 'audio_guard_unavailable', error: 'Audio cannot be made right now. Please try again later.' } };
}

// Decide whether an existing audio file can be served as-is.
//   fresh   — meta hash matches the current text
//   unknown — no meta row (legacy file): serve it, but it is unverified
//   stale   — meta hash differs: audio is for older text, regenerate
async function audioStatus(key, plain) {
  const meta = await getAudioMeta(key);
  if (!meta) return { state: 'unknown', meta: null };
  return { state: meta.plain_hash === plainHash(plain) ? 'fresh' : 'stale', meta };
}

async function logSyncError(book, voice, type, detail) {
  try {
    await sb('/rest/v1/sync_errors', {
      method: 'POST', prefer: 'return=minimal',
      body: { title: book.title, author: book.author, voice: voice || null, error_type: type, detail, resolved: false }
    });
  } catch (e) { /* best effort */ }
}

// In-flight generation registry (per serverless instance). Stops generate-audio and tts-stream
// from both paying xAI for the same file when they land on the same instance close together.
const _inflight = new Map();
const inflight = {
  get: key => _inflight.get(key) || null,
  set: (key, promise) => {
    _inflight.set(key, promise);
    const done = () => { if (_inflight.get(key) === promise) _inflight.delete(key); };
    promise.then(done, done);
  }
};

// Female voice only for now: a male request would make us pay to generate a second voice per book.
// Completeness check for a summary. Returns a list of problems; 'too_short' and 'abrupt_end' are hard failures.
// Used before saving a new summary and before spending money on narration.
function summaryProblems(plain, html) {
  const p = String(plain || '').trim(), out = [];
  const words = p ? p.split(/\s+/).length : 0;
  if (words < 700) out.push('too_short');
  if (p && !/[.!?\u2026"'\u201d\u2019)]$/.test(p)) out.push('abrupt_end');
  if (html && (String(html).match(/<h2/gi) || []).length < 3) out.push('few_sections');
  return out;
}
function isIncomplete(plain, html) { return summaryProblems(plain, html).some(x => x === 'too_short' || x === 'abrupt_end'); }

function normVoice() { return 'female'; }

// ── Small utilities ──────────────────────────────────────────────────────────
const _rl = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const list = (_rl.get(key) || []).filter(t => now - t < windowMs);
  list.push(now);
  _rl.set(key, list);
  if (_rl.size > 2000) { for (const [k, v] of _rl) if (!v.some(t => now - t < windowMs)) _rl.delete(k); }
  return list.length > max;
}

function clientIp(req) {
  return String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim() || 'unknown';
}

function fail(res, r) { return res.status(r.status).json(r.body); }

module.exports = {
  SUPABASE_URL, LIMITS, DEMO_BOOKS,
  norm, fold, baseTitle, makeLookupKey, isDemoBook, authorMatches, likeEq, levenshtein, cleanText,
  sb, authenticate, bearer,
  findBook, findBookFuzzy,
  limitFor, getProfile, getOwnedIds, isOwned, accessBook, authoriseRead, authoriseAudioRead, canGenerateAudio, inflight,
  audioKey, audioKeyCandidates, fnv32, plainHash, publicAudioUrl, storageHas, findCachedAudio,
  getAudioMeta, saveAudioMeta, uploadAudio, audioStatus, logSyncError, reserveAudioSpend, audioSpendRefusal, AUDIO_DAILY_CAP,
  summaryProblems, isIncomplete,
  normVoice, rateLimited, clientIp, fail
};
