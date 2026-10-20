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
  user_library: [], profiles: [{ id: 'u1', tier: 'free', downloads_used: 0 }, { id: 'u2', tier: 'free', downloads_used: 36 }, { id: 'u3', tier: 'pro', downloads_used: 0 }],
  audio_meta: [], storage: new Set(), sync_errors: [], xai: 0, emails: 0
};
const users = { tokA: { id: 'u1', email: 'a@x.com' }, tokB: { id: 'u2', email: 'b@x.com' }, tokP: { id: 'u3', email: 'p@x.com' }, tokG: { id: 'u4', is_anonymous: true }, tokH: { id: 'u5', is_anonymous: true } };
const J = (o, st = 200) => ({ ok: st < 300, status: st, text: async () => JSON.stringify(o), json: async () => o, arrayBuffer: async () => Buffer.from('mp3data').buffer });

global.fetch = async (url, o = {}) => {
  const u = new URL(url); const m = o.method || 'GET'; const q = u.searchParams;
  if (u.host === 'api.x.ai') { db.xai++; return J({}); }
  if (u.host === 'api.resend.com') { db.emails++; return J({ id: 'e' }); }
  if (u.pathname === '/auth/v1/user') {
    const t = (o.headers.Authorization || '').slice(7); return users[t] ? J(users[t]) : J({}, 401);
  }
  if (u.pathname.startsWith('/storage/v1/object/info/audio/')) return J({}, db.storage.has(decodeURIComponent(u.pathname.split('/').pop())) ? 200 : 404);
  if (u.pathname.startsWith('/storage/v1/object/audio/')) { db.storage.add(decodeURIComponent(u.pathname.split('/').pop())); return J({}); }
  const table = u.pathname.split('/').pop(); const rows = db[table];
  if (m === 'POST') {
    const b = JSON.parse(o.body);
    if (table === 'user_library') {
      if (rows.find(r => r.user_id === b.user_id && r.summary_id === b.summary_id)) return J([]);
      rows.push(b); return J([b], 201);
    }
    if (table === 'audio_meta') { const i = rows.findIndex(r => r.audio_key === b.audio_key); i >= 0 ? rows[i] = b : rows.push(b); return J([], 201); }
    rows.push(b); return J([b], 201);
  }
  if (m === 'PATCH') { const id = q.get('id').replace('eq.', ''); const r = rows.find(r => String(r.id) === id); Object.assign(r, JSON.parse(o.body)); return J([]); }
  let out = rows.slice();
  for (const [k, v] of q) {
    if (['select', 'limit', 'order', 'offset', 'on_conflict'].includes(k)) continue;
    if (v.startsWith('eq.')) out = out.filter(r => String(r[k]) === v.slice(3));
    else if (v.startsWith('ilike.')) { const pat = v.slice(6).replace(/\\/g, '').toLowerCase(); out = out.filter(r => pat.includes('%') ? String(r[k]).toLowerCase().includes(pat.replace(/%/g, '')) : String(r[k]).toLowerCase() === pat); }
  }
  return J(out);
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
  r = await call(sum, { body: { title: 'Unknown Book', author: 'Nobody' } });
  assert.strictEqual(r.code, 401); console.log('ok summarise anon cannot generate');
  r = await call(sum, { body: { title: 'Unknown Book', author: 'Nobody' }, token: 'tokB' });
  assert.strictEqual(r.code, 403); assert.strictEqual(r.body.code, 'limit'); console.log('ok summarise over-limit cannot generate');
  r = await call(sum, { body: { patchWords: true, title: 'Dune' }, token: 'tokA' });
  assert.strictEqual(r.code, 403); console.log('ok patchWords admin-only');

  // guests (anonymous sessions): any book, 12 max, no generation, no kindle
  r = await call(gs, { method: 'GET', query: { title: 'Dune', author: 'Frank Herbert' }, token: 'tokG' });
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.quota.tier, 'guest'); assert.strictEqual(r.body.quota.limit, 12); assert.strictEqual(r.body.quota.used, 1);
  console.log('ok guest can open ANY library book, counted 1/12');
  for (let i = 0; i < 12; i++) db.user_library.push({ user_id: 'u5', summary_id: 1000 + i });
  r = await call(gs, { method: 'GET', query: { title: 'Dune', author: 'Frank Herbert' }, token: 'tokH' });
  assert.strictEqual(r.code, 403); assert.strictEqual(r.body.code, 'limit'); console.log('ok guest stopped at 12');
  r = await call(sum, { body: { title: 'Unknown Book', author: 'Nobody' }, token: 'tokG' });
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
