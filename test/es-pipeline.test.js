// Offline test for the Spanish build tool (api/es-pipeline.js): no network, no real Supabase, Claude or xAI.
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const SERVICE = b64({ alg: 'HS256' }) + '.' + b64({ role: 'service_role' }) + '.sig';
process.env.SUPABASE_SERVICE_KEY = SERVICE; process.env.XAI_API_KEY = 'x'; process.env.ANTHROPIC_API_KEY = 'a';
const assert = require('assert');

const EN_P = 'This book explains a big idea in plain words. '.repeat(40).trim();
const EN_HTML = ['A', 'B', 'C', 'D'].map(h => '<h2>Part ' + h + '</h2><p>' + EN_P + '</p>').join('') ;
const EN_PLAIN = EN_HTML.replace(/<h2>/g, '\n\n').replace(/<\/h2>/g, '\n\n').replace(/<\/?p>/g, '');
const db = {
  summaries: [{ id: 7, title: 'Atomic Habits', author: 'James Clear', lookup_key: 'atomic habits||james clear||nospoilers', html: EN_HTML, plain: EN_PLAIN, words: '[]', categories: JSON.stringify(['Personal Development']) }],
  summaries_es: [], audio_meta: [], storage: new Map(), claude: 0, xai: 0
};
const ES_P = 'Este libro explica una gran idea con palabras sencillas. '.repeat(40).trim();
const WORDS = Array.from({ length: 21 }, (_, i) => JSON.stringify({ word: 'palabra' + i, definition: 'definición sencilla número ' + i })).join('\n');
const GOOD = 'TITLE_ES: Hábitos atómicos\nSYNOPSIS_ES: Pequeños cambios diarios que, sumados con paciencia, transforman por completo tu vida.\nHTML_START\n' +
  ['A', 'B', 'C', 'D'].map(h => '<h2>Parte ' + h + '</h2><p>' + ES_P + '</p>').join('') + '\nHTML_END\nWORDS_START\n' + WORDS + '\nWORDS_END';
let claudeReply = GOOD, claudeStop = 'end_turn';

const J = (o, st = 200) => ({ ok: st < 300, status: st, text: async () => JSON.stringify(o), json: async () => o, arrayBuffer: async () => Buffer.from('mp3data-' + 'x'.repeat(50)).buffer });
global.fetch = async (url, o = {}) => {
  const u = new URL(url); const m = o.method || 'GET'; const q = u.searchParams;
  if (u.host === 'api.anthropic.com') { db.claude++; return J({ content: [{ text: claudeReply }], stop_reason: claudeStop, usage: { input_tokens: 2500, output_tokens: 3700 } }); }
  if (u.host === 'api.x.ai') { db.xai++; db.lastTts = JSON.parse(o.body); return J({}); }
  if (u.pathname === '/auth/v1/user') { const t = (o.headers.Authorization || '').slice(7); return t === 'tokP' ? J({ id: 'p1', email: 'p@x.com' }) : t === 'tokF' ? J({ id: 'f1', email: 'f@x.com' }) : J({}, 401); }
  if (u.pathname.startsWith('/storage/v1/object/info/audio/')) return J({}, db.storage.has(decodeURIComponent(u.pathname.split('/').pop())) ? 200 : 404);
  if (u.pathname.startsWith('/storage/v1/object/audio/')) { db.storage.set(decodeURIComponent(u.pathname.split('/').pop()), 1); return J({}); }
  if (u.pathname === '/rest/v1/profiles') return J(u.searchParams.get('id') === 'eq.p1' ? [{ tier: 'pro', downloads_used: 0 }] : [{ tier: 'free', downloads_used: 0 }]);
  const table = u.pathname.split('/').pop(); const rows = db[table];
  if (m === 'POST') {
    const b = JSON.parse(o.body);
    if (table === 'summaries_es') { const i = rows.findIndex(r => String(r.id) === String(b.id)); i >= 0 ? rows[i] = b : rows.push(b); return J([], 201); }
    if (table === 'audio_meta') { const i = rows.findIndex(r => r.audio_key === b.audio_key); i >= 0 ? rows[i] = b : rows.push(b); return J([], 201); }
    rows.push(b); return J([b], 201);
  }
  let out = rows.slice();
  for (const [k, v] of q) {
    if (['select', 'limit', 'order', 'offset', 'on_conflict'].includes(k)) continue;
    if (v.startsWith('eq.')) out = out.filter(r => String(r[k]) === v.slice(3));
    else if (v.startsWith('ilike.')) { const pat = v.slice(6).replace(/\\/g, '').toLowerCase(); out = out.filter(r => pat.includes('%') ? String(r[k]).toLowerCase().includes(pat.replace(/%/g, '')) : String(r[k]).toLowerCase() === pat); }
  }
  return J(out);
};
const mkRes = () => ({ code: 200, body: null, headers: {}, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } });
const call = async (h, body, token) => { const res = mkRes(); await h({ method: 'POST', body, query: {}, headers: token ? { authorization: 'Bearer ' + token } : {} }, res); return res; };

(async () => {
  const h = require('../api/es-pipeline'), K = require('../lib/kernl');
  let r;

  r = await call(h, { action: 'pick' });
  assert.strictEqual(r.code, 403); console.log('ok anonymous refused');
  r = await call(h, { action: 'translate', id: 7 }, 'tokF');
  assert.strictEqual(r.code, 403); assert.strictEqual(db.claude, 0); console.log('ok free user refused, no Claude spend');

  r = await call(h, { action: 'pick' }, 'tokP');
  assert.strictEqual(r.code, 200); assert.ok(r.body.books.some(b => b.title === 'Atomic Habits' && b.shelf === 'mind')); console.log('ok pick finds a known book on the right shelf');

  r = await call(h, { action: 'translate', id: 7 }, 'tokP');
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
  assert.strictEqual(db.summaries_es.length, 1);
  const row = db.summaries_es[0];
  assert.strictEqual(String(row.id), '7'); assert.strictEqual(row.title, 'Hábitos atómicos'); assert.strictEqual(row.title_en, 'Atomic Habits'); assert.strictEqual(row.author, 'James Clear');
  assert.strictEqual(JSON.parse(row.words).length, 21); assert.strictEqual(row.categories, JSON.stringify(['Personal Development']));
  assert.strictEqual(row.lookup_key, K.makeLookupKey('Hábitos atómicos', 'James Clear'));
  assert.ok(!K.isIncomplete(row.plain, row.html)); console.log('ok translate saved Spanish row with the same id, 21 words, categories kept');

  r = await call(h, { action: 'translate', id: 7 }, 'tokP');
  assert.strictEqual(r.body.skipped, 'already_translated'); assert.strictEqual(db.claude, 1); console.log('ok repeat translate is free');

  // a cut-off or short answer is never saved
  db.summaries_es.length = 0; claudeStop = 'max_tokens';
  r = await call(h, { action: 'translate', id: 7 }, 'tokP');
  assert.strictEqual(r.body.ok, false); assert.strictEqual(db.summaries_es.length, 0); console.log('ok cut-short translation is not saved');
  claudeStop = 'end_turn'; claudeReply = GOOD.replace(/WORDS_START[\s\S]*$/, 'WORDS_START\n' + WORDS.split('\n').slice(0, 10).join('\n') + '\nWORDS_END');
  db.claude = 0;
  r = await call(h, { action: 'translate', id: 7 }, 'tokP');
  assert.strictEqual(r.body.ok, false); assert.ok(r.body.problems.includes('words_10')); assert.strictEqual(db.claude, 2); assert.strictEqual(db.summaries_es.length, 0); console.log('ok wrong word count retried once then refused');
  claudeReply = GOOD;

  // audio
  r = await call(h, { action: 'audio', id: 7 }, 'tokP');
  assert.strictEqual(r.code, 404); console.log('ok audio needs Spanish text first');
  await call(h, { action: 'translate', id: 7 }, 'tokP');
  r = await call(h, { action: 'audio', id: 7 }, 'tokP');
  assert.strictEqual(r.body.ok, true, JSON.stringify(r.body)); assert.strictEqual(db.xai, 1);
  assert.strictEqual(db.lastTts.language, 'es-MX'); assert.strictEqual(db.lastTts.voice_id, 'eve'); console.log('ok audio uses es-MX and the female voice (eve)');
  assert.ok(db.storage.has('habitos_at_micos__james_clear__female__es.mp3') || [...db.storage.keys()].every(k => k.endsWith('__es.mp3')), [...db.storage.keys()].join());
  assert.strictEqual(db.audio_meta[0].voice_language, 'es'); console.log('ok audio file has __es key and es metadata');
  r = await call(h, { action: 'audio', id: 7 }, 'tokP');
  assert.strictEqual(r.body.skipped, 'already_has_audio'); assert.strictEqual(db.xai, 1); console.log('ok repeat audio is free');

  r = await call(h, { action: 'status', ids: [7, 99] }, 'tokP');
  assert.strictEqual(r.body.rows[0].audio, true); assert.strictEqual(r.body.rows[0].words, 21); assert.strictEqual(r.body.rows[1].es, false); console.log('ok status');

  // a long text is split into requests under the 15,000-character limit
  db.summaries_es[0].plain = ('Párrafo de prueba largo. '.repeat(30) + '\n\n').repeat(40).trim(); db.xai = 0;
  r = await call(h, { action: 'audio', id: 7, force: true }, 'tokP');
  assert.strictEqual(r.body.ok, true); assert.ok(db.xai >= 2); assert.ok(db.lastTts.text.length <= 14000); console.log('ok long text chunked under the xAI limit');

  console.log('\nALL PASSED');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
