// Offline test: a Pro reader asks for a book that is not in the Spanish library (api/summarise.js), and the Spanish reading portrait.
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const SERVICE = b64({ alg: 'HS256' }) + '.' + b64({ role: 'service_role' }) + '.sig';
process.env.SUPABASE_SERVICE_KEY = SERVICE; process.env.XAI_API_KEY = 'x'; process.env.ANTHROPIC_API_KEY = 'a';
const assert = require('assert');

const EN_P = 'This book tells a gripping story in plain words and explains what it means. '.repeat(30).trim();
const EN_RAW = 'GENRE:NONFICTION\n' + ['A', 'B', 'C', 'D', 'E'].map(h => '<h2>Part ' + h + '</h2><p>' + EN_P + '</p>').join('') + '\nWORDS_START\n' +
  Array.from({ length: 21 }, (_, i) => JSON.stringify({ word: 'word' + i, definition: 'meaning ' + i })).join('\n') + '\nWORDS_END';
const ES_P = 'Este libro cuenta una historia apasionante con palabras sencillas y explica lo que significa. '.repeat(30).trim();
const WORDS = Array.from({ length: 21 }, (_, i) => JSON.stringify({ word: 'palabra' + i, definition: 'definición sencilla número ' + i })).join('\n');
const ES_RAW = 'TITLE_ES: Papillon\nSYNOPSIS_ES: Un hombre condenado injustamente se juega la vida en una fuga imposible.\nHTML_START\n' +
  ['A', 'B', 'C', 'D', 'E'].map(h => '<h2>Parte ' + h + '</h2><p>' + ES_P + '</p>').join('') + '\nHTML_END\nWORDS_START\n' + WORDS + '\nWORDS_END';

const db = {
  summaries: [{ id: 5, title: 'Atomic Habits', author: 'James Clear', lookup_key: 'atomic habits||james clear||nospoilers', html: '<p>x</p>', plain: 'x', words: '[]', categories: '["Personal Development"]' }],
  summaries_es: [], user_library: [], portraits: [], audio_meta: [],
  profiles: [{ id: 'p1', tier: 'pro', downloads_used: 0 }], calls: { sonnet46: 0, sonnet55: 0, haiku: 0 }, canon: { title: 'Papillon', author: 'Henri Charrière' }
};
let nextId = 100;
const J = (o, st = 200) => ({ ok: st < 300, status: st, text: async () => JSON.stringify(o), json: async () => o, arrayBuffer: async () => Buffer.from('x').buffer });
global.fetch = async (url, o = {}) => {
  const u = new URL(url); const m = o.method || 'GET'; const q = u.searchParams;
  if (u.host === 'api.anthropic.com') {
    const b = JSON.parse(o.body); const prompt = b.messages[0].content;
    if (b.model.includes('haiku')) {
      db.calls.haiku++;
      if (prompt.startsWith('A reader typed')) return J({ content: [{ text: JSON.stringify(db.canon) }], stop_reason: 'end_turn' });
      if (prompt.startsWith('Categorise')) return J({ content: [{ text: '["Biography & Memoir"]' }], stop_reason: 'end_turn' });
      if (prompt.startsWith('Write a single')) return J({ content: [{ text: 'A man fights to escape a prison island.' }], stop_reason: 'end_turn' });
      if (prompt.startsWith('Eres un compa')) { db.portraitPrompt = prompt; return J({ content: [{ text: 'Parece que te atraen las historias de supervivencia.' }], stop_reason: 'end_turn' }); }
    }
    if (b.model === 'claude-sonnet-4-6') { db.calls.sonnet46++; return J({ content: [{ text: EN_RAW }], stop_reason: 'end_turn', usage: {} }); }
    db.calls.sonnet55++; return J({ content: [{ text: ES_RAW }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  }
  if (u.pathname === '/auth/v1/user') { const t = (o.headers.Authorization || '').slice(7); return t === 'tokP' ? J({ id: 'p1', email: 'p@x.com' }) : J({}, 401); }
  const table = u.pathname.split('/').pop(); const rows = db[table];
  if (!rows) return J([]);
  if (m === 'POST') {
    const b = JSON.parse(o.body);
    if (table === 'summaries') { const row = Object.assign({ id: nextId++ }, b); rows.push(row); return J([row], 201); }
    if (table === 'summaries_es') { const i = rows.findIndex(r => String(r.id) === String(b.id)); i >= 0 ? rows[i] = b : rows.push(b); return J([], 201); }
    if (table === 'user_library') { if (rows.find(r => r.user_id === b.user_id && r.summary_id === b.summary_id)) return J([]); rows.push(b); return J([b], 201); }
    rows.push(b); return J([b], 201);
  }
  if (m === 'PATCH') { const id = q.get('id').replace('eq.', ''); const r = rows.find(r => String(r.id) === id); if (r) Object.assign(r, JSON.parse(o.body)); return J([]); }
  let out = rows.slice();
  for (const [k, v] of q) {
    if (['select', 'limit', 'order', 'offset', 'on_conflict'].includes(k)) continue;
    if (v.startsWith('eq.')) out = out.filter(r => String(r[k]) === v.slice(3));
    else if (v.startsWith('in.(')) { const ids = v.slice(4, -1).split(','); out = out.filter(r => ids.includes(String(r[k]))); }
    else if (v.startsWith('ilike.')) { const pat = v.slice(6).replace(/\\/g, '').toLowerCase(); out = out.filter(r => pat.includes('%') ? String(r[k]).toLowerCase().includes(pat.replace(/%/g, '')) : String(r[k]).toLowerCase() === pat); }
  }
  return J(out);
};
const mkRes = () => { const r = { code: 200, body: null, headers: {}, chunks: [], setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }, write(s) { this.chunks.push(s); }, on() {} }; return r; };
const events = r => r.chunks.filter(c => c.startsWith('data: ')).map(c => JSON.parse(c.slice(6)));
const call = async (h, body, token) => { const res = mkRes(); await h({ method: 'POST', body, query: {}, headers: token ? { authorization: 'Bearer ' + token } : {} }, res); return res; };

(async () => {
  const sum = require('../api/summarise'), portrait = require('../api/generate-portrait'), K = require('../lib/kernl');
  let r, ev;

  // 1. a book nobody has asked for: written in English (new row, gets an id), then translated, then charged once
  r = await call(sum, { title: 'Papillon', author: 'Henri Charrière' }, 'tokP');
  ev = events(r); const done = ev.find(e => e.done);
  assert.ok(done, JSON.stringify(ev.slice(-2))); assert.strictEqual(done.title, 'Papillon'); assert.strictEqual(done.source, 'generated');
  assert.ok(ev.some(e => e.status && /español/.test(e.status)), 'progress messages are sent');
  assert.strictEqual(db.summaries.length, 2); assert.strictEqual(db.summaries[1].title, 'Papillon');
  assert.strictEqual(db.summaries_es.length, 1); assert.strictEqual(String(db.summaries_es[0].id), String(db.summaries[1].id));
  assert.strictEqual(JSON.parse(db.summaries_es[0].words).length, 21);
  assert.deepStrictEqual(db.calls.sonnet46, 1); assert.strictEqual(db.calls.sonnet55, 1);
  assert.strictEqual(db.user_library.length, 1); assert.strictEqual(db.user_library[0].language, 'es');
  assert.strictEqual(db.profiles[0].downloads_used, 1); assert.ok(done.book && done.book.title === 'Papillon');
  console.log('ok Pro new book: English row, Spanish row (same id), 21 words, one allowance slot, language=es');

  // 2. asking again (any spelling) is a free cache hit
  const before = JSON.stringify(db.calls);
  r = await call(sum, { title: 'Papillon', author: 'Henri Charrière' }, 'tokP');
  assert.strictEqual(r.body && r.body.source || events(r).find(e => e.done).source, 'cache'); assert.strictEqual(JSON.stringify(db.calls), before); assert.strictEqual(db.profiles[0].downloads_used, 1);
  console.log('ok asking again costs nothing');

  // 3. an English title for a book that exists in English but not yet in Spanish: translate only, no English rewrite
  db.canon = { title: 'Atomic Habits', author: 'James Clear' };
  db.summaries[0].html = ['A', 'B', 'C', 'D', 'E'].map(h => '<h2>Part ' + h + '</h2><p>' + EN_P + '</p>').join('');
  db.summaries[0].plain = db.summaries[0].html.replace(/<h2>/g, '\n\n').replace(/<\/h2>/g, '\n\n').replace(/<\/?p>/g, '');
  const en46 = db.calls.sonnet46;
  r = await call(sum, { title: 'Hábitos atómicos', author: 'James Clear' }, 'tokP');
  ev = events(r); assert.ok(ev.find(e => e.done), JSON.stringify(ev.slice(-2)));
  assert.strictEqual(db.calls.sonnet46, en46); assert.strictEqual(db.summaries.length, 2); assert.strictEqual(db.summaries_es.length, 2);
  console.log('ok Spanish title resolves to the existing English book and only translates');

  // 4. a cut-short translation is refused and not charged
  db.canon = { title: 'Nuevo', author: 'Alguien' };
  const used = db.profiles[0].downloads_used, esN = db.summaries_es.length;
  const realFetch = global.fetch;
  global.fetch = async (url, o = {}) => { const res = await realFetch(url, o); if (new URL(url).host === 'api.anthropic.com' && JSON.parse(o.body).model === 'claude-sonnet-5-5') return { ok: true, status: 200, json: async () => ({ content: [{ text: ES_RAW.slice(0, 900) }], stop_reason: 'max_tokens', usage: {} }) }; return res; };
  r = await call(sum, { title: 'Nuevo', author: 'Alguien' }, 'tokP');
  ev = events(r); assert.ok(ev.some(e => e.error), JSON.stringify(ev)); assert.ok(!ev.some(e => e.done));
  assert.strictEqual(db.summaries_es.length, esN); assert.strictEqual(db.profiles[0].downloads_used, used);
  global.fetch = realFetch; console.log('ok broken translation is not saved and not charged');

  // 5. reading portrait: Spanish, per language, from the Spanish table, and it excludes books already read
  db.summaries_es.push(...[1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ id: 200 + i, title: 'Libro ' + i, author: 'Autor ' + i, categories: '["Biography & Memoir"]', synopsis: 'Sinopsis ' + i })));
  db.summaries_es.push({ id: 301, title: 'Libro 9', author: 'Autor 9', categories: '["Biography & Memoir"]' }, { id: 302, title: 'Libro 10', author: 'Autor 10', categories: '["Biography & Memoir"]' });
  db.user_library.length = 0;
  [201, 202, 203, 204, 205, 206, 207, 208, 301, 302].forEach(id => db.user_library.push({ user_id: 'p1', summary_id: id, language: 'es' }));
  db.user_library.push({ user_id: 'p1', summary_id: 5, language: 'en' });
  db.summaries_es.push({ id: 400, title: 'Libro sin leer', author: 'Autor X', categories: '["Biography & Memoir"]', synopsis: 'Aún no leído.' });
  r = await call(portrait, {}, 'tokP');
  assert.strictEqual(r.code, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.bookCount, 10);
  assert.ok(/Parece que te atraen/.test(r.body.portrait)); assert.ok(/Español latinoamericano/.test(db.portraitPrompt));
  assert.strictEqual(db.portraits[0].language, 'es'); assert.strictEqual(db.portraits[0].book_count_at_generation, 10);
  const owned = new Set(['Libro 1', 'Libro 2', 'Libro 3', 'Libro 4', 'Libro 5', 'Libro 6', 'Libro 7', 'Libro 8', 'Libro 9', 'Libro 10']);
  assert.ok(r.body.recommendations.length >= 1 && r.body.recommendations.every(x => !owned.has(x.title)), JSON.stringify(r.body.recommendations));
  console.log('ok Spanish portrait + recommendations (unread Spanish books only, English-edition books not counted)');

  console.log('\nALL PASSED');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
