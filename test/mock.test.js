const STOIC = 'Stoic text. '.repeat(400).trim(), SPICE = 'Spice text. '.repeat(400).trim();
// Mocked-fetch tests: no network, no real Supabase/xAI.
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const SERVICE = b64({alg:'HS256'}) + '.' + b64({role:'service_role'}) + '.sig';
process.env.SUPABASE_SERVICE_KEY = SERVICE;
process.env.XAI_API_KEY = 'x'; process.env.RESEND_API_KEY = 'r';
const assert = require('assert');

const db = {
  summaries: [
    { id: 1, title: 'Meditations', author: 'Marcus Aurelius', lookup_key: 'meditations||marcus aurelius||nospoilers', plain: STOIC, html: '<p>stoic</p>', words: '[]' },
    { id: 2, title: 'Dune', author: 'Frank Herbert', lookup_key: 'dune||frank herbert||nospoilers', plain: SPICE, html: '<p>spice</p>', words: '[]' }
  ],
  user_library: [], profiles: [
    { id: 'u1', tier: 'free', downloads_used: 0 }, { id: 'u2', tier: 'free', downloads_used: 36 }, { id: 'u3', tier: 'pro', downloads_used: 0 },
    { id: 'u6', tier: 'pro', downloads_used: 200 }, { id: 'u7', tier: 'free', downloads_used: 0 }, { id: 'u8', tier: 'pro', downloads_used: 0 },
    { id: 'u9', tier: 'free', downloads_used: 3 }, { id: 'u10', tier: 'pro', downloads_used: 0 }, { id: 'u11', tier: 'free', downloads_used: 0 }
  ],
  audio_meta: [], storage: new Set(), sync_errors: [], title_creations: [], apple_notifications: [], _seq: 1000, xai: 0, emails: 0
};
const users = {
  tokA: { id: 'u1', email: 'a@x.com' }, tokB: { id: 'u2', email: 'b@x.com' }, tokP: { id: 'u3', email: 'p@x.com' },
  tokG: { id: 'u4', is_anonymous: true }, tokH: { id: 'u5', is_anonymous: true },
  tokQ: { id: 'u6', email: 'q@x.com' }, tokS: { id: 'u7', email: 's@x.com' }, tokR: { id: 'u8', email: 'r@x.com' },
  tokD: { id: 'u9', email: 'd@x.com' }, tokHand: { id: 'u10', email: 'h@x.com' }, tokSteal: { id: 'u11', email: 't@x.com' }
};
const J = (o, st = 200) => ({ ok: st < 300, status: st, text: async () => JSON.stringify(o), json: async () => o, arrayBuffer: async () => Buffer.from('mp3data').buffer });

function rowMatches(r, q) {
  for (const [k, v] of q) {
    if (['select', 'limit', 'order', 'offset', 'on_conflict'].includes(k)) continue;
    if (v.startsWith('eq.')) { if (String(r[k]) !== v.slice(3)) return false; }
    else if (v.startsWith('gte.')) { if (!(String(r[k]) >= v.slice(4))) return false; }
    else if (v.startsWith('gt.')) { if (!(String(r[k]) > v.slice(3))) return false; }
    else if (v.startsWith('lte.')) { if (!(String(r[k]) <= v.slice(4))) return false; }
    else if (v.startsWith('lt.')) { if (!(String(r[k]) < v.slice(3))) return false; }
    else if (v.startsWith('ilike.')) {
      const pat = v.slice(6).replace(/\\/g, '').toLowerCase();
      const hay = String(r[k] == null ? '' : r[k]).toLowerCase();
      if (pat.includes('%') ? !hay.includes(pat.replace(/%/g, '')) : hay !== pat) return false;
    }
  }
  return true;
}

global.fetch = async (url, o = {}) => {
  const u = new URL(url); const m = o.method || 'GET'; const q = u.searchParams;
  if (u.host === 'api.x.ai') { db.xai++; return J({}); }
  if (u.host === 'api.resend.com') { db.emails++; return J({ id: 'e' }); }
  if (u.host === 'api.anthropic.com') {
    db.anthropic = (db.anthropic || 0) + 1;
    let parsed = {};
    try { parsed = o.body ? JSON.parse(o.body) : {}; } catch (e) { parsed = {}; }
    if (parsed.stream && db.anthropicStream) {
      const payload = 'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { text: db.anthropicText } }) + '\n\n'
        + 'data: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) + '\n\n';
      const value = Buffer.from(payload);
      let sent = false;
      return {
        ok: true, status: 200,
        body: { getReader() { return { read: async () => sent ? { done: true } : (sent = true, { done: false, value }) }; } },
        text: async () => payload,
        json: async () => { throw new Error('stream'); }
      };
    }
    return J({ error: { message: 'mock: no generation' } }, 500);
  }
  if (u.host === 'openlibrary.org') { db.ol = (db.ol || 0) + 1; return J({ docs: [{ title: 'Meditations', author_name: ['Marcus Aurelius'], first_publish_year: 1634 }] }); }
  if (u.host === 'api.storekit.itunes.apple.com' || u.host === 'api.storekit-sandbox.itunes.apple.com') {
    db.appleCalls = (db.appleCalls || 0) + 1;
    const id = decodeURIComponent(u.pathname.split('/').pop());
    if (u.pathname.indexOf('/inApps/v1/subscriptions/') !== -1) {
      const pack = db.appleSubs && db.appleSubs[id];
      return pack ? J(pack) : J({ errorCode: 4040010, errorMessage: 'not found' }, 404);
    }
    if (u.pathname.indexOf('/inApps/v1/transactions/') !== -1) {
      const signed = db.appleTx && db.appleTx[id];
      return signed ? J({ signedTransactionInfo: signed }) : J({ errorCode: 4040010, errorMessage: 'not found' }, 404);
    }
    return J({ errorCode: 4040000 }, 404);
  }
  if (u.pathname === '/auth/v1/user') {
    const t = (o.headers.Authorization || '').slice(7); return users[t] ? J(users[t]) : J({}, 401);
  }
  if (u.pathname.startsWith('/auth/v1/admin/users/')) {
    if (m !== 'DELETE') return J({ message: 'method' }, 405);
    const id = decodeURIComponent(u.pathname.split('/').pop());
    db.deletedUsers = (db.deletedUsers || []).concat(id);
    return J({});
  }
  if (u.pathname.startsWith('/storage/v1/object/info/audio/')) return J({}, db.storage.has(decodeURIComponent(u.pathname.split('/').pop())) ? 200 : 404);
  if (u.pathname.startsWith('/storage/v1/object/audio/')) { db.storage.add(decodeURIComponent(u.pathname.split('/').pop())); return J({}); }
  const table = u.pathname.split('/').pop(); const rows = db[table];
  if (!Array.isArray(rows)) return J({ message: 'no table' }, 404);
  if (m === 'DELETE') {
    const keep = [];
    rows.forEach(row => { if (!rowMatches(row, q)) keep.push(row); });
    rows.length = 0; keep.forEach(row => rows.push(row));
    return J([]);
  }
  if (m === 'POST') {
    const b = JSON.parse(o.body);
    if (table === 'user_library') {
      if (rows.find(r => r.user_id === b.user_id && r.summary_id === b.summary_id)) return J([]);
      rows.push(b); return J([b], 201);
    }
    // Like the real table: audio_key is unique and the primary key is a separate id, so a plain POST of an
    // existing audio_key is refused (merge-duplicates without on_conflict only merges on the primary key).
    if (table === 'audio_meta') { if (rows.find(r => r.audio_key === b.audio_key)) return J({ code: '23505', message: 'duplicate key value violates unique constraint' }, 409); rows.push(b); return J([], 201); }
    if (b.id == null) b.id = ++db._seq;
    rows.push(b); return J([b], 201);
  }
  if (m === 'PATCH') {
    const hit = rows.filter(r => [...q].every(([k, v]) => ['select'].includes(k) || !v.startsWith('eq.') || String(r[k]) === v.slice(3)));
    hit.forEach(r => Object.assign(r, JSON.parse(o.body)));
    return J(((o.headers && o.headers.Prefer) || '').includes('return=representation') ? hit : []);
  }
  return J(rows.filter(row => rowMatches(row, q)));
};

const mkRes = () => { const r = { code: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }, write() {}, on() {} }; return r; };
const call = async (h, { method = 'POST', body, query, token } = {}) => { const res = mkRes(); await h({ method, body, query: query || {}, headers: token ? { authorization: 'Bearer ' + token } : {} }, res); return res; };

(async () => {
  const gs = require('../api/get-summary'), tts = require('../api/tts'), gen = require('../api/generate-audio'), kindle = require('../api/send-to-kindle'), sum = require('../api/summarise');
  let r;

  r = await call(gs, { method: 'GET', query: { title: 'Meditations', author: 'Marcus Aurelius' } });
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.plain, STOIC); console.log('ok anon guest read');

  r = await call(gs, { method: 'GET', query: { title: 'Dune', author: 'Frank Herbert' } });
  assert.strictEqual(r.code, 401); assert.strictEqual(r.body.code, 'auth_required'); console.log('ok anon non-guest blocked');

  r = await call(gs, { method: 'GET', query: { title: 'Dune', author: 'Frank Herbert' }, token: 'tokA' });
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.quota.used, 1);
  assert.strictEqual(db.user_library.length, 1); assert.strictEqual(db.profiles[0].downloads_used, 1); console.log('ok signed-in read charges 1');

  r = await call(gs, { method: 'GET', query: { title: 'Dune', author: 'Frank Herbert' }, token: 'tokA' });
  assert.strictEqual(r.body.quota.used, 1); assert.strictEqual(db.user_library.length, 1); console.log('ok re-open is free');

  r = await call(gs, { method: 'GET', query: { title: 'Dune', author: 'Frank Herbert' }, token: 'tokB' });
  assert.strictEqual(r.code, 403); assert.strictEqual(r.body.code, 'limit'); console.log('ok limit enforced');

  r = await call(gs, { method: 'GET', query: { title: 'Dune', author: 'Frank Herbert' }, token: SERVICE });
  assert.strictEqual(r.code, 200); console.log('ok admin bypass');

  // summarise: cache path + gating + admin-only patchWords
  r = await call(sum, { body: { title: 'Dune', author: 'Frank Herbert' } });
  assert.strictEqual(r.code, 401); console.log('ok summarise anon non-guest blocked');
  r = await call(sum, { body: { title: 'Meditations', author: 'Marcus Aurelius' } });
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.source, 'cache'); console.log('ok summarise anon guest cache');
  r = await call(sum, { body: { title: 'Unknown Book', author: 'Nobody', generate: true } });
  assert.strictEqual(r.code, 401); console.log('ok summarise anon cannot generate');
  r = await call(sum, { body: { title: 'Unknown Book', author: 'Nobody', generate: true }, token: 'tokB' });
  assert.strictEqual(r.code, 403); assert.strictEqual(r.body.code, 'pro_required'); console.log('ok summarise free user cannot generate');
  r = await call(sum, { body: { patchWords: true, title: 'Dune' }, token: 'tokA' });
  assert.strictEqual(r.code, 403); console.log('ok patchWords admin-only');

  // guests (anonymous sessions): any book, 12 max, no generation, no kindle
  r = await call(gs, { method: 'GET', query: { title: 'Dune', author: 'Frank Herbert' }, token: 'tokG' });
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.quota.tier, 'guest'); assert.strictEqual(r.body.quota.limit, 12); assert.strictEqual(r.body.quota.used, 1);
  console.log('ok guest can open ANY library book, counted 1/12');
  for (let i = 0; i < 12; i++) db.user_library.push({ user_id: 'u5', summary_id: 1000 + i });
  r = await call(gs, { method: 'GET', query: { title: 'Dune', author: 'Frank Herbert' }, token: 'tokH' });
  assert.strictEqual(r.code, 403); assert.strictEqual(r.body.code, 'limit'); console.log('ok guest stopped at 12');
  r = await call(sum, { body: { title: 'Unknown Book', author: 'Nobody', generate: true }, token: 'tokG' });
  assert.strictEqual(r.code, 403); assert.strictEqual(r.body.code, 'signup_required'); console.log('ok guest cannot generate new summaries');
  r = await call(kindle, { body: { title: 'Dune', author: 'Frank Herbert', kindleEmail: 'me@kindle.com' }, token: 'tokG' });
  assert.strictEqual(r.code, 403); assert.strictEqual(db.emails, 0); console.log('ok guest cannot use kindle');

  // tts / generate-audio
  r = await call(tts, { body: { title: 'Meditations', author: 'Marcus Aurelius', voice: 'female' } });
  assert.strictEqual(r.body.cached, false); console.log('ok tts miss');

  r = await call(gen, { body: { title: 'Dune', author: 'Frank Herbert' } });
  assert.strictEqual(r.code, 401); assert.strictEqual(db.xai, 0); console.log('ok generate anon non-guest blocked, no xAI spend');

  r = await call(gen, { body: { title: 'Meditations', author: 'Marcus Aurelius', voice: 'female' } });
  assert.strictEqual(r.code, 403); assert.strictEqual(r.body.code, 'pro_required'); assert.strictEqual(db.xai, 0); console.log('ok anon cannot trigger paid generation');
  r = await call(gen, { body: { title: 'Meditations', author: 'Marcus Aurelius', voice: 'female' }, token: 'tokA' });
  assert.strictEqual(r.code, 403); assert.strictEqual(db.xai, 0); console.log('ok free user cannot trigger paid generation');

  const [g1, g2] = await Promise.all([
    call(gen, { body: { title: 'Meditations', author: 'Marcus Aurelius', voice: 'female', plain: 'EVIL TEXT' }, token: 'tokP' }),
    call(gen, { body: { title: 'Meditations', author: 'Marcus Aurelius', voice: 'female' }, token: 'tokP' })
  ]);
  assert.strictEqual(g1.code, 200); assert.strictEqual(g2.code, 200);
  assert.strictEqual(db.xai, 1, 'xAI called ' + db.xai + ' times'); console.log('ok concurrent generate = 1 xAI call');
  assert.strictEqual(db.audio_meta.length, 1);
  assert.strictEqual(db.audio_meta[0].plain_hash, require('../lib/kernl').plainHash(STOIC)); console.log('ok audio_meta written from DB text, client plain ignored');

  r = await call(gen, { body: { title: 'Meditations', author: 'Marcus Aurelius', voice: 'female' } });
  assert.strictEqual(r.body.cached, true); assert.strictEqual(db.xai, 1); console.log('ok repeat generate is free');

  r = await call(tts, { body: { title: 'Meditations', author: 'Marcus Aurelius', voice: 'female' } });
  assert.strictEqual(r.body.source, 'cache'); console.log('ok tts hit');

  db.summaries[0].plain = STOIC + ' Edited ending.';
  r = await call(tts, { body: { title: 'Meditations', author: 'Marcus Aurelius', voice: 'female' } });
  assert.strictEqual(r.body.reason, 'hash_mismatch'); console.log('ok tts stale detected');

  // wrong-book title match no longer collides
  db.summaries.push({ id: 3, title: 'Meditations on First Philosophy', author: 'Descartes', lookup_key: 'x', plain: 'cogito', html: '', words: '[]' });
  r = await call(tts, { body: { title: 'Meditations', author: 'Marcus Aurelius', voice: 'female' } });
  assert.strictEqual(r.body.reason, 'hash_mismatch'); console.log('ok similar title does not hijack hash lookup');

  // kindle
  r = await call(kindle, { body: { title: 'Meditations', author: 'Marcus Aurelius', kindleEmail: 'victim@gmail.com' } });
  assert.strictEqual(r.code, 400); assert.strictEqual(db.emails, 0); console.log('ok kindle relay blocked');
  r = await call(kindle, { body: { title: 'Dune', author: 'Frank Herbert', kindleEmail: 'me@kindle.com' } });
  assert.strictEqual(r.code, 401); console.log('ok kindle non-guest anon blocked');
  r = await call(kindle, { body: { title: 'Meditations', author: 'Marcus Aurelius', kindleEmail: 'me@kindle.com' } });
  assert.strictEqual(r.code, 200); assert.strictEqual(db.emails, 1); console.log('ok kindle guest send');
  assert.strictEqual(db.ol, 1, 'year lookup not called once'); console.log('ok kindle send looks up the year');

  // ── Re-made audio must re-stamp its record (the Harry Potter audio fault) ──
  // Audio exists from an older text; the library text changes (e.g. a duplicate was removed); the audio is
  // re-made. The record must now match the new text, or every later check calls it stale and nothing plays.
  {
    const K = require('../lib/kernl');
    const NEW = 'New wizard text. '.repeat(400).trim();
    const hp = { id: 8, title: 'Wizard Book', author: 'J.K. Rowling', lookup_key: 'wizard book||jk rowling||nospoilers', plain: STOIC, html: '<h2>a</h2><h2>b</h2><h2>c</h2>', words: '[]' };
    db.summaries.push(hp); db.user_library.push({ user_id: 'u3', summary_id: 8 });
    const key = K.audioKey(hp.title, hp.author, 'female');
    r = await call(gen, { body: { title: hp.title, author: hp.author, voice: 'female' }, token: 'tokP' });
    assert.strictEqual(r.code, 200); assert.ok(db.storage.has(key));
    hp.plain = NEW;                                            // text changes after the audio was made
    r = await call(tts, { body: { title: hp.title, author: hp.author, voice: 'female' }, token: 'tokP' });
    assert.strictEqual(r.body.reason, 'hash_mismatch');
    r = await call(gen, { body: { title: hp.title, author: hp.author, voice: 'female' }, token: 'tokP' });
    assert.strictEqual(r.code, 200, 'regeneration should report success only if the record was updated');
    assert.strictEqual(db.audio_meta.filter(m => m.audio_key === key).length, 1, 'one record per audio file');
    assert.strictEqual(db.audio_meta.find(m => m.audio_key === key).plain_hash, K.plainHash(NEW), 'record must match the new text');
    r = await call(tts, { body: { title: hp.title, author: hp.author, voice: 'female' }, token: 'tokP' });
    assert.ok(r.body.url, 'after re-making, the audio must be served');
    const paid = db.xai;
    r = await call(gen, { body: { title: hp.title, author: hp.author, voice: 'female' }, token: 'tokP' });
    assert.strictEqual(db.xai, paid, 'opening again must not pay to re-make it');
    console.log('ok re-made audio is re-stamped, served, and not paid for again');
    // Hard cap: the text changes yet again the same day; this would be the third paid attempt, so it is refused.
    hp.plain = 'Third version of the text. '.repeat(300).trim();
    const paid2 = db.xai;
    r = await call(gen, { body: { title: hp.title, author: hp.author, voice: 'female' }, token: 'tokP' });
    assert.strictEqual(r.code, 429); assert.strictEqual(r.body.code, 'audio_daily_cap'); assert.strictEqual(db.xai, paid2, 'paid beyond the daily cap');
    assert.ok(db.sync_errors.some(e => e.error_type === 'audio_cap_reached'));
    r = await call(require('../api/tts-stream'), { body: { title: hp.title, author: hp.author, voice: 'female' }, token: 'tokP' });
    assert.strictEqual(r.code, 429); assert.strictEqual(db.xai, paid2, 'stream path paid beyond the daily cap');
    console.log('ok never pays more than twice a day for one book, on either path');
    db.summaries = db.summaries.filter(x => x.id !== 8);
  }

  // ── Library books never trigger a new summary (the Harry Potter fault) ──
  // A real-looking row whose stored lookup_key came from a differently-typed request, with punctuation
  // ("Philosopher's", "J.K.") that the text matching strips: a title-only lookup misses it.
  db.summaries.push({ id: 7, title: "Harry Potter and the Philosopher's Stone", author: 'J.K. Rowling', lookup_key: 'harry potter philosophers stone||j k rowling||nospoilers', plain: STOIC, html: '<p>wizard</p>', words: '[{"word":"wand","definition":"a stick"}]' });
  const before = db.anthropic || 0;
  r = await call(sum, { body: { title: "Harry Potter and the Philosopher's Stone", author: 'J.K. Rowling' }, token: 'tokP' });
  assert.strictEqual(r.code, 404); assert.strictEqual(r.body.code, 'not_in_library'); assert.strictEqual(db.anthropic || 0, before, 'a library click paid for a new summary');
  console.log('ok pro clicking a library title never writes a new summary');
  r = await call(sum, { body: { id: 7, title: "Harry Potter and the Philosopher's Stone", author: 'J.K. Rowling' }, token: 'tokP' });
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.html, '<p>wizard</p>'); assert.strictEqual(db.anthropic || 0, before);
  console.log('ok library click by id opens the exact book');
  r = await call(sum, { body: { id: 99999, title: 'Nope' }, token: 'tokP' });
  assert.strictEqual(r.code, 404); assert.strictEqual(db.anthropic || 0, before); console.log('ok unknown id is a 404, never a generation');
  r = await call(sum, { body: { id: '7; drop table', title: 'x' }, token: 'tokP' });
  assert.notStrictEqual(r.code, 200); console.log('ok malformed id ignored');
  {
    const uid = '233a9309-e125-41e6-af7e-ce4826d24d0a';
    db.summaries.push({ id: uid, title: 'UUID Book', author: 'Tester', lookup_key: 'uuid book||tester||nospoilers', plain: STOIC, html: '<p>uuid</p>', words: '[{"word":"uuid","definition":"an id"}]' });
    const paid = db.anthropic || 0, paidX = db.xai || 0;
    r = await call(sum, { body: { id: uid.toUpperCase(), title: 'Wrong Title On Purpose', author: 'Nobody' }, token: 'tokP' });
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.id, uid); assert.strictEqual(r.body.html, '<p>uuid</p>');
    assert.strictEqual(db.anthropic || 0, paid, 'opening a book by its id paid for a new summary');
    assert.strictEqual(db.xai || 0, paidX, 'opening a book by its id paid for audio');
    r = await call(sum, { body: { id: uid + ';drop', title: 'No Such Title' }, token: 'tokP' });
    assert.strictEqual(r.code, 404); assert.strictEqual(db.anthropic || 0, paid);
    db.summaries = db.summaries.filter(x => x.id !== uid);
    db.user_library = db.user_library.filter(x => String(x.summary_id) !== uid);
    console.log('ok a real book id (UUID) opens that exact book and never writes a new one');
  }
  r = await call(sum, { body: { title: 'Brand New Book', author: 'Someone', generate: true }, token: 'tokP' });
  assert.strictEqual(db.anthropic, before + 1, 'pro generate:true should reach the writer'); console.log('ok only pro + generate:true writes a new summary');
  r = await call(sum, { body: { title: 'Brand New Book', author: 'Someone', generate: true }, token: 'tokA' });
  assert.strictEqual(r.code, 403); assert.strictEqual(r.body.code, 'pro_required'); assert.strictEqual(db.anthropic, before + 1); console.log('ok free user generate:true refused');
  db.summaries = db.summaries.filter(x => x.id !== 7);

  // ── Summary prompt: varied openings, structure markers intact ──
  {
    const seen = new Set();
    for (let i = 0; i < 300; i++) { const pr = sum.buildPrompt('Dune', 'Frank Herbert'); assert.ok(pr.includes('GENRE:FICTION') && pr.includes('WORDS_START') && pr.includes('WORDS_END')); seen.add(pr.match(/OPENING: (.*?) IMPORTANT:/)[1]); }
    assert.strictEqual(seen.size, sum.OPENING_STYLES.length, 'every opening style should come up');
    console.log('ok summary prompt varies its opening and keeps genre/words markers');
  }

  // ── Listening progress ──
  {
    const prog = require('../api/progress');
    const get = (token, id) => call(prog, { method: 'GET', query: { id: String(id) }, token });
    const post = (token, body) => call(prog, { method: 'POST', body, token });
    const lib = db.user_library.find(x => x.user_id === 'u1' && x.summary_id === 2);
    assert.ok(lib, 'u1 should own Dune from the earlier test');
    r = await get(null, 2); assert.strictEqual(r.code, 401);
    r = await get('tokG', 2); assert.strictEqual(r.code, 403); assert.strictEqual(r.body.code, 'signup_required');
    console.log('ok progress: anonymous refused, guests nudged to sign up');
    r = await get('tokA', 2); assert.deepStrictEqual(r.body, { pos: 0, dur: null, pct: 0, listens: 0, finished: false });
    r = await post('tokA', { id: 2, pos: 120, dur: 600 }); assert.strictEqual(r.code, 200); assert.strictEqual(r.body.pct, 20);
    r = await post('tokA', { id: 2, pos: 60, dur: 600 });                       // jumped back: furthest point kept
    r = await get('tokA', 2); assert.strictEqual(r.body.pos, 60); assert.strictEqual(r.body.pct, 20); assert.strictEqual(r.body.finished, false);
    console.log('ok progress: position saved, furthest point kept');
    r = await post('tokA', { id: 2, pos: 590, dur: 600, done: true });
    r = await get('tokA', 2); assert.strictEqual(r.body.listens, 1); assert.strictEqual(r.body.finished, true); assert.strictEqual(r.body.pos, 0); assert.strictEqual(r.body.pct, 100);
    r = await post('tokA', { id: 2, pos: 595, dur: 600, done: true });
    r = await get('tokA', 2); assert.strictEqual(r.body.listens, 2);
    console.log('ok progress: finishing counts a listen and restarts from the beginning next time');
    r = await post('tokA', { id: 1, pos: 10, dur: 600 }); assert.strictEqual(r.code, 404);          // not in their library
    r = await post('tokA', { id: '2; drop', pos: 10, dur: 600 }); assert.strictEqual(r.code, 400);
    r = await post('tokA', { id: 2, pos: -5, dur: 600 }); assert.strictEqual(r.code, 400);
    r = await post('tokB', { id: 2, pos: 10, dur: 600 }); assert.notStrictEqual(r.code, 200);       // someone else's book
    r = await get('tokA', 2); assert.strictEqual(r.body.listens, 2);
    console.log('ok progress: only your own library books, bad input refused');
    const uid = '233a9309-e125-41e6-af7e-ce4826d24d0a';
    db.user_library.push({ user_id: 'u1', summary_id: uid, listen_pct: 0, listens: 0 });
    r = await post('tokA', { id: uid.toUpperCase(), pos: 25, dur: 100 });
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.pct, 25);
    r = await get('tokA', uid); assert.strictEqual(r.body.pos, 25); assert.strictEqual(r.body.pct, 25);
    r = await post('tokA', { id: uid + ';drop', pos: 10, dur: 100 }); assert.strictEqual(r.code, 400);
    r = await post('tokB', { id: uid, pos: 10, dur: 100 }); assert.strictEqual(r.code, 404);
    r = await get('tokA', uid); assert.strictEqual(r.body.pos, 25); assert.strictEqual(r.body.pct, 25);
    const row = db.user_library.find(x => x.user_id === 'u1' && x.summary_id === uid);
    assert.strictEqual(row.listen_pos, 25); assert.strictEqual(row.listen_pct, 25); assert.ok(row.last_listened_at);
    console.log('ok progress: a real book id (UUID) is saved on that library row');
  }

  // ── Book-open audit (read-only; Pro/admin only) ──
  const audit = require('../api/audit-books');
  r = await call(audit, { method: 'GET', query: {}, token: 'tokA' });
  assert.strictEqual(r.code, 403); console.log('ok audit refused for free user');
  r = await call(audit, { method: 'GET', query: {} });
  assert.strictEqual(r.code, 403); console.log('ok audit refused for anonymous');
  r = await call(audit, { method: 'GET', query: { limit: '10' }, token: 'tokP' });
  assert.strictEqual(r.code, 200); assert.ok(r.body.rows.length >= 2);
  assert.ok(r.body.rows.every(x => x.opens === 'ok'), 'a seeded book failed the open check: ' + JSON.stringify(r.body.rows.map(x => x.opens)));
  console.log('ok audit: every seeded book opens via the click lookup');
  db.summaries.push({ id: 99, title: 'Ghost', author: 'Nobody', lookup_key: 'something-else', plain: STOIC, html: '<p>x</p>', words: '[]' });
  const savedLookup = db.summaries[2].lookup_key; db.summaries[2].title = 'Zzzz Unfindable Qqqq'; db.summaries[2].lookup_key = 'zzzz';
  r = await call(audit, { method: 'GET', query: { limit: '10' }, token: 'tokP' });
  assert.ok(r.body.rows.find(x => x.id === 99), 'ghost row missing');
  db.summaries.pop();
  console.log('ok audit runs on odd rows without crashing');

  // ── Pro: 10 new titles a year, separate from the 200 library allowance ──
  {
    const fs = require('fs');
    const K = require('../lib/kernl');
    const quotaApi = require('../api/quota');
    assert.strictEqual(K.LIMITS.pro, 200);
    assert.strictEqual(K.TITLE_CREATION_LIMIT, 10);
    const appSrc = fs.readFileSync(__dirname + '/../public/app.js', 'utf8');
    const accSrc = fs.readFileSync(__dirname + '/../public/account.html', 'utf8');
    assert.ok(appSrc.includes('const TITLE_CREATION_LIMIT = 10'));
    assert.ok(accSrc.includes('const TITLE_CREATION_LIMIT = 10'));
    assert.ok(appSrc.includes('pro: 200') && accSrc.includes('pro: 200'));
    const sinceOf = () => K.creationWindowStart().toISOString();
    const inWindow = id => db.title_creations.filter(x => x.user_id === id && String(x.created_at) >= sinceOf());
    const pro = db.profiles.find(p => p.id === 'u8');
    const capped = db.profiles.find(p => p.id === 'u6');

    r = await call(sum, { body: { title: 'QQQQQQQQQQQQQQ blocked', author: 'Nope Author', generate: true }, token: 'tokQ' });
    assert.strictEqual(r.code, 403); assert.strictEqual(r.body.code, 'limit');
    assert.strictEqual(capped.downloads_used, 200);
    assert.strictEqual(inWindow('u6').length, 0);
    console.log('ok a full library allowance blocks a new title and does not touch the 200');

    r = await call(sum, { body: { title: 'Dune', author: 'Frank Herbert', generate: true }, token: 'tokR' });
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.source, 'cache');
    assert.strictEqual(pro.downloads_used, 1); assert.strictEqual(inWindow('u8').length, 0);
    r = await call(sum, { body: { title: 'Dune', author: 'Frank Herbert', generate: true }, token: 'tokR' });
    assert.strictEqual(pro.downloads_used, 1); assert.strictEqual(inWindow('u8').length, 0);
    r = await call(sum, { body: { id: 3 }, token: 'tokR' });
    assert.strictEqual(r.code, 200); assert.strictEqual(pro.downloads_used, 2); assert.strictEqual(inWindow('u8').length, 0);
    console.log('ok adding a book already in the catalogue does not use a new title');

    function sampleSummary() {
      const para = '<p>' + ('Word '.repeat(200)).trim() + '.</p>';
      const words = [];
      for (let n = 0; n < 21; n++) words.push('{"word":"word' + n + '","definition":"a test word"}');
      return 'GENRE:NONFICTION\n<h2>One</h2>' + para + '<h2>Two</h2>' + para + '<h2>Three</h2>' + para + '<h2>Four</h2>' + para + '\nWORDS_START\n' + words.join('\n') + '\nWORDS_END';
    }
    db.anthropicStream = true;
    db.anthropicText = sampleSummary();
    for (let i = 0; i < 10; i++) {
      const title = String.fromCharCode(65 + i).repeat(14) + ' volume';
      const author = 'Writer ' + String.fromCharCode(65 + i).repeat(8);
      const before = inWindow('u8').length;
      const dls = pro.downloads_used;
      await call(sum, { body: { title, author, generate: true }, token: 'tokR' });
      assert.strictEqual(inWindow('u8').length, before + 1, 'creation ' + i + ' was not recorded');
      assert.strictEqual(pro.downloads_used, dls + 1, 'library allowance moved by more than the book added');
      assert.ok(db.summaries.some(s => s.title === title), 'summary was not saved');
      assert.ok(db.title_creations.some(s => s.user_id === 'u8' && s.title === title && s.summary_id), 'log row has no summary');
    }
    assert.strictEqual(inWindow('u8').length, 10);
    assert.strictEqual(pro.downloads_used, 12);
    assert.ok(pro.downloads_used < K.LIMITS.pro);
    console.log('ok pro can create 10 new titles; library counter only counts the books added');

    const paid = db.anthropic || 0;
    const dls = pro.downloads_used;
    r = await call(sum, { body: { title: 'ELEVENTHUNIQUEBOOK', author: 'Eleventh Author', generate: true }, token: 'tokR' });
    assert.strictEqual(r.code, 403); assert.strictEqual(r.body.code, 'creation_limit');
    assert.strictEqual(db.anthropic || 0, paid, 'the 11th title was sent to the writer');
    assert.strictEqual(pro.downloads_used, dls);
    assert.strictEqual(inWindow('u8').length, 10);
    console.log('ok the 11th new title is refused');

    db.user_library = db.user_library.filter(x => x.user_id !== 'u8');
    r = await call(sum, { body: { title: 'TWELFTHUNIQUEBOOK', author: 'Twelfth Author', generate: true }, token: 'tokR' });
    assert.strictEqual(r.code, 403); assert.strictEqual(r.body.code, 'creation_limit');
    assert.strictEqual(inWindow('u8').length, 10);
    console.log('ok removing books from the library does not refund a new title');

    const oldAt = new Date(K.creationWindowStart().getTime() - 24 * 60 * 60 * 1000).toISOString();
    db.title_creations.push({ id: 'old-row', user_id: 'u8', title: 'Ancient', author: 'Historian', lookup_key: 'ancient||historian||nospoilers', created_at: oldAt, summary_id: 2 });
    r = await call(sum, { body: { title: 'THIRTEENTHUNIQUEBOOK', author: 'Thirteenth Author', generate: true }, token: 'tokR' });
    assert.strictEqual(r.code, 403); assert.strictEqual(r.body.code, 'creation_limit');
    assert.ok(db.title_creations.some(x => x.id === 'old-row'));
    const recent = db.title_creations.find(x => x.user_id === 'u8' && x.id !== 'old-row');
    db.title_creations = db.title_creations.filter(x => x !== recent);
    K.clearRateLimits();
    const beforeDrop = pro.downloads_used;
    r = await call(sum, { body: { title: 'NNNNNNNNNNNNNN volume', author: 'Writer NNNNNNNN', generate: true }, token: 'tokR' });
    assert.strictEqual(inWindow('u8').length, 10, 'a title older than 12 months should have made room');
    assert.strictEqual(pro.downloads_used, beforeDrop + 1);
    assert.ok(db.title_creations.some(x => x.id === 'old-row'), 'the old log row must stay');
    console.log('ok the cap is a rolling 12 months and the old log row is kept');

    const freeRows = db.title_creations.length;
    r = await call(sum, { body: { title: 'FREEUSERUNIQUEBOOK', author: 'Free Author', generate: true }, token: 'tokA' });
    assert.strictEqual(r.code, 403); assert.strictEqual(r.body.code, 'pro_required');
    assert.strictEqual(db.title_creations.length, freeRows);
    console.log('ok a free account still cannot create a title');

    const rowsBeforeAdmin = db.title_creations.length;
    const paidAdmin = db.anthropic || 0;
    await call(sum, { body: { title: 'ADMINUNIQUEBOOKZZ', author: 'Admin Author', generate: true }, token: SERVICE });
    assert.ok((db.anthropic || 0) > paidAdmin, 'admin should still be able to commission a title');
    assert.strictEqual(db.title_creations.length, rowsBeforeAdmin, 'admins are not counted against the cap');
    assert.strictEqual(inWindow('u8').length, 10);
    console.log('ok an admin is not limited by the new-title cap');

    r = await call(quotaApi, { method: 'GET', token: 'tokR' });
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.library.limit, 200);
    assert.strictEqual(r.body.creations.limit, 10);
    assert.strictEqual(r.body.creations.remaining, 0);
    r = await call(quotaApi, { method: 'GET', token: 'tokA' });
    assert.strictEqual(r.body.creations.limit, 0);
    assert.strictEqual(r.body.library.limit, 36);
    console.log('ok quota reports the library allowance and the new-title cap separately');
    db.anthropicStream = false;
  }

  // ── App Store: Pro is set only after Apple confirms the transaction ──
  {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const crypto = require('crypto');
    const { execFileSync } = require('child_process');
    const A = require('../lib/apple');
    const verify = require('../api/apple-verify');
    const notes = require('../api/apple-notifications');
    assert.strictEqual(A.APPLE_PRODUCT_ID, 'com.kernl.pro.annual');
    const up = fs.readFileSync(__dirname + '/../public/upgrade.html', 'utf8');
    assert.ok(up.includes('com.kernl.pro.annual'));
    assert.ok(up.includes('iOS app'));
    assert.ok(up.includes('cannot take payment'));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernl-apple-'));
    const run = args => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
    fs.writeFileSync(path.join(dir, 'ext.cnf'), '[inter]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n1.2.840.113635.100.6.2.1=critical,DER:05:00\n[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n1.2.840.113635.100.6.11.1=critical,DER:05:00\n');
    run(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'root.key']);
    run(['req', '-new', '-x509', '-key', 'root.key', '-out', 'root.pem', '-days', '3650', '-subj', '/CN=KERNL Test Apple Root']);
    run(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'inter.key']);
    run(['req', '-new', '-key', 'inter.key', '-out', 'inter.csr', '-subj', '/CN=KERNL Test WWDR']);
    run(['x509', '-req', '-in', 'inter.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'inter.pem', '-days', '3650', '-extfile', 'ext.cnf', '-extensions', 'inter']);
    run(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key']);
    run(['req', '-new', '-key', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=KERNL Test Leaf']);
    run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'inter.pem', '-CAkey', 'inter.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '3650', '-extfile', 'ext.cnf', '-extensions', 'leaf']);
    const rootPem = fs.readFileSync(path.join(dir, 'root.pem'), 'utf8');
    const interPem = fs.readFileSync(path.join(dir, 'inter.pem'), 'utf8');
    const leafPem = fs.readFileSync(path.join(dir, 'leaf.pem'), 'utf8');
    const leafKey = fs.readFileSync(path.join(dir, 'leaf.key'), 'utf8');
    const pemBody = pem => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const x5c = [pemBody(leafPem), pemBody(interPem), pemBody(rootPem)];
    const header = { alg: 'ES256', x5c };
    const txJws = fields => A.signJws(header, Object.assign({
      bundleId: 'com.kernl.books', environment: 'Sandbox', productId: 'com.kernl.pro.annual',
      type: 'Auto-Renewable Subscription', signedDate: Date.now()
    }, fields), leafKey);
    const noteJws = (type, signed, status) => A.signJws(header, {
      notificationType: type, notificationUUID: crypto.randomUUID(), version: '2.0', signedDate: Date.now(),
      data: { bundleId: 'com.kernl.books', environment: 'Sandbox', signedTransactionInfo: signed, status }
    }, leafKey);

    const savedVercel = process.env.VERCEL;
    delete process.env.VERCEL;
    process.env.KERNL_APPLE_TEST = '1';
    process.env.KERNL_APPLE_TEST_ROOT = rootPem;
    process.env.APPLE_BUNDLE_ID = 'com.kernl.books';
    process.env.APPLE_ISSUER_ID = '00000000-0000-0000-0000-000000000000';
    process.env.APPLE_KEY_ID = 'KEYID12345';
    process.env.APPLE_ENVIRONMENT = 'Sandbox';
    process.env.APPLE_PRIVATE_KEY = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    db.appleTx = {};
    db.appleSubs = {};
    const member = () => db.profiles.find(p => p.id === 'u7');
    const hand = () => db.profiles.find(p => p.id === 'u10');

    r = await call(verify, { body: { tier: 'pro' }, token: 'tokS' });
    assert.strictEqual(r.code, 400); assert.strictEqual(member().tier, 'free');
    console.log('ok a client that merely claims Pro is refused');

    const callsBeforeForge = db.appleCalls || 0;
    const forged = A.signJws(header, {
      transactionId: '2000000000000099', originalTransactionId: '2000000000000099', bundleId: 'com.kernl.books',
      environment: 'Sandbox', productId: 'com.kernl.pro.annual', type: 'Auto-Renewable Subscription',
      expiresDate: Date.now() + 86400000, signedDate: Date.now()
    }, process.env.APPLE_PRIVATE_KEY);
    r = await call(verify, { body: { signedTransaction: forged, transactionId: '2000000000000099' }, token: 'tokS' });
    assert.strictEqual(r.code, 400); assert.strictEqual(r.body.code, 'invalid_transaction');
    assert.strictEqual(db.appleCalls || 0, callsBeforeForge);
    assert.strictEqual(member().tier, 'free');
    console.log('ok a receipt not signed by Apple is refused before any tier change');

    const active = txJws({ transactionId: '2000000000000001', originalTransactionId: '2000000000000001', expiresDate: Date.now() + 30 * 86400000 });
    r = await call(verify, { body: { signedTransaction: active, transactionId: '2000000000000001' }, token: 'tokS' });
    assert.strictEqual(r.code, 400); assert.strictEqual(r.body.code, 'transaction_not_found');
    assert.strictEqual(member().tier, 'free');
    assert.ok(!member().apple_original_transaction_id);
    console.log('ok a signed receipt is not enough on its own; Apple must confirm it');

    const stale = txJws({ transactionId: '2000000000000002', originalTransactionId: '2000000000000002', expiresDate: Date.now() - 1000, revocationDate: Date.now() - 500 });
    db.appleTx['2000000000000002'] = stale;
    r = await call(verify, { body: { transactionId: '2000000000000002' }, token: 'tokHand' });
    assert.strictEqual(r.code, 403); assert.strictEqual(r.body.code, 'subscription_inactive');
    assert.strictEqual(hand().tier, 'pro');
    assert.ok(!hand().apple_original_transaction_id);
    console.log('ok an inactive receipt does not remove Pro that was granted by hand');

    const wrong = txJws({ transactionId: '2000000000000008', originalTransactionId: '2000000000000008', productId: 'com.kernl.other', expiresDate: Date.now() + 86400000 });
    db.appleTx['2000000000000008'] = wrong;
    r = await call(verify, { body: { transactionId: '2000000000000008' }, token: 'tokSteal' });
    assert.strictEqual(r.code, 403); assert.strictEqual(r.body.code, 'wrong_product');
    assert.strictEqual(db.profiles.find(p => p.id === 'u11').tier, 'free');
    console.log('ok a different App Store product does not grant Pro');

    db.appleTx['2000000000000001'] = active;
    const callsBefore = db.appleCalls || 0;
    r = await call(verify, { body: { signedTransaction: active, transactionId: '2000000000000001' }, token: 'tokS' });
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.tier, 'pro'); assert.strictEqual(r.body.active, true);
    assert.ok((db.appleCalls || 0) > callsBefore);
    assert.strictEqual(member().tier, 'pro');
    assert.strictEqual(member().apple_original_transaction_id, '2000000000000001');
    assert.strictEqual(member().apple_product_id, 'com.kernl.pro.annual');
    assert.strictEqual(member().apple_environment, 'Sandbox');
    assert.ok(member().apple_expires_at);
    assert.strictEqual(member().downloads_used, 0);
    console.log('ok a transaction Apple confirms sets Pro and stores the subscription, without touching the library allowance');

    r = await call(verify, { body: { transactionId: '2000000000000001' }, token: 'tokSteal' });
    assert.strictEqual(r.code, 409); assert.strictEqual(r.body.code, 'subscription_in_use');
    assert.strictEqual(db.profiles.find(p => p.id === 'u11').tier, 'free');
    console.log('ok the same App Store subscription cannot be claimed by a second account');

    const expired = txJws({ transactionId: '2000000000000001', originalTransactionId: '2000000000000001', expiresDate: Date.now() - 1000 });
    db.appleTx['2000000000000001'] = expired;
    r = await call(verify, { body: { transactionId: '2000000000000001' }, token: 'tokS' });
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.tier, 'free'); assert.strictEqual(member().tier, 'free');
    console.log('ok a confirmed expiry on a linked subscription returns the account to Free');

    const renewed = txJws({ transactionId: '2000000000000003', originalTransactionId: '2000000000000001', expiresDate: Date.now() + 400 * 86400000 });
    db.appleSubs['2000000000000001'] = { data: [{ lastTransactions: [{ status: 1, originalTransactionId: '2000000000000001', signedTransactionInfo: renewed }] }] };
    r = await call(notes, { body: { signedPayload: noteJws('DID_RENEW', renewed, 1) } });
    assert.strictEqual(r.code, 200); assert.strictEqual(member().tier, 'pro');
    assert.strictEqual(member().apple_transaction_id, '2000000000000003');
    console.log('ok a renewal notification keeps Pro');

    const callsBeforeRefund = db.appleCalls || 0;
    const refunded = txJws({ transactionId: '2000000000000003', originalTransactionId: '2000000000000001', expiresDate: Date.now() + 400 * 86400000, revocationDate: Date.now() });
    r = await call(notes, { body: { signedPayload: noteJws('REFUND', refunded, 5) } });
    assert.strictEqual(r.code, 200); assert.strictEqual(member().tier, 'free'); assert.strictEqual(member().apple_status, 'revoked');
    assert.ok((db.appleCalls || 0) > callsBeforeRefund, 'the refund was not checked with Apple');
    console.log('ok a refund drops Pro even if Apple’s status call still looks active');

    r = await call(notes, { body: { signedPayload: noteJws('EXPIRED', txJws({ transactionId: '2000000000000077', originalTransactionId: '2000000000000077', expiresDate: Date.now() - 1000 }), 2) } });
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.linked, false);
    assert.strictEqual(hand().tier, 'pro');
    console.log('ok a notification for an unknown subscription changes nobody');

    const badNote = A.signJws(header, { notificationType: 'REVOKE', notificationUUID: crypto.randomUUID(), data: { bundleId: 'com.kernl.books', environment: 'Sandbox' } }, process.env.APPLE_PRIVATE_KEY);
    r = await call(notes, { body: { signedPayload: badNote } });
    assert.strictEqual(r.code, 401);
    assert.strictEqual(hand().tier, 'pro');
    console.log('ok an unverified notification is rejected');

    process.env.VERCEL = '1';
    const sneaky = txJws({ transactionId: '2000000000000004', originalTransactionId: '2000000000000004', expiresDate: Date.now() + 86400000 });
    db.appleTx['2000000000000004'] = sneaky;
    r = await call(verify, { body: { signedTransaction: sneaky, transactionId: '2000000000000004' }, token: 'tokSteal' });
    assert.strictEqual(r.code, 400);
    assert.strictEqual(db.profiles.find(p => p.id === 'u11').tier, 'free');
    if (savedVercel == null) delete process.env.VERCEL; else process.env.VERCEL = savedVercel;
    delete process.env.KERNL_APPLE_TEST;
    delete process.env.KERNL_APPLE_TEST_ROOT;
    console.log('ok the test signing root is ignored when running on Vercel');
  }

  // ── Account deletion (required for the App Store) ──
  {
    const del = require('../api/delete-account');
    db.user_library.push({ id: 'lib9', user_id: 'u9', summary_id: 2 });
    db.title_creations.push({ id: 'c9', user_id: 'u9', title: 'Gone', author: 'Gone', lookup_key: 'gone', created_at: new Date().toISOString() });
    r = await call(del, { body: { confirm: 'DELETE' } });
    assert.strictEqual(r.code, 401);
    r = await call(del, { body: { confirm: 'DELETE' }, token: 'tokG' });
    assert.strictEqual(r.code, 403);
    r = await call(del, { body: {}, token: 'tokD' });
    assert.strictEqual(r.code, 400);
    assert.ok(db.profiles.some(p => p.id === 'u9'));
    r = await call(del, { body: { confirm: 'DELETE' }, token: 'tokD' });
    assert.strictEqual(r.code, 200);
    assert.ok(!db.profiles.some(p => p.id === 'u9'));
    assert.ok(!db.user_library.some(p => p.user_id === 'u9'));
    assert.ok(!db.title_creations.some(p => p.user_id === 'u9'));
    assert.ok((db.deletedUsers || []).includes('u9'));
    assert.ok(db.profiles.some(p => p.id === 'u1'));
    console.log('ok a confirmed account deletion removes the profile, library and title log');
  }

  // a service key that is really the public anon key must be refused everywhere
  const anon = b64({alg:'HS256'}) + '.' + b64({role:'anon'}) + '.sig';
  delete require.cache[require.resolve('../lib/kernl')];
  process.env.SUPABASE_SERVICE_KEY = anon;
  const K2 = require('../lib/kernl');
  const ctxAnonAsAdmin = await K2.authenticate({ headers: { authorization: 'Bearer ' + anon } });
  assert.ok(!ctxAnonAsAdmin || !ctxAnonAsAdmin.admin, 'anon key must not become admin');
  await assert.rejects(() => K2.sb('/rest/v1/summaries'), /not a service-role key/);
  console.log('ok wrong (anon) key as SUPABASE_SERVICE_KEY is refused, no admin bypass');

  console.log('\nALL PASSED');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
