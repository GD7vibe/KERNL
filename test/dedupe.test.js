// node test/dedupe.test.js  — must print ALL PASSED. Mocked Supabase; no network.
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const SERVICE = b64({ alg: 'HS256' }) + '.' + b64({ role: 'service_role' }) + '.sig';
process.env.SUPABASE_SERVICE_KEY = SERVICE;
process.env.CRON_SECRET = 'cron-test-secret';
const assert = require('assert');

const LONG = ('Word '.repeat(800) + 'end.').trim();
let db;
const reset = (summaries, library) => { db = { summaries, user_library: library || [], sync_errors: [], audio: new Set() }; };
const J = (o, st = 200) => ({ ok: st < 300, status: st, text: async () => JSON.stringify(o), json: async () => o });

global.fetch = async (url, o = {}) => {
  const u = new URL(url), m = o.method || 'GET', q = u.searchParams;
  if (u.pathname === '/auth/v1/user') return J({}, 401);
  if (u.pathname.startsWith('/storage/v1/object/info/audio/')) return J({}, db.audio.has(decodeURIComponent(u.pathname.split('/').pop())) ? 200 : 404);
  const table = u.pathname.split('/').pop(), rows = db[table];
  const match = r => [...q].every(([k, v]) => ['select', 'limit', 'offset', 'order'].includes(k) || (v.startsWith('eq.') ? String(r[k]) === v.slice(3) : true));
  if (m === 'POST') { rows.push(JSON.parse(o.body)); return J([], 201); }
  if (m === 'PATCH') { rows.filter(match).forEach(r => Object.assign(r, JSON.parse(o.body))); return J([]); }
  if (m === 'DELETE') { db[table] = rows.filter(r => !match(r)); return J([]); }
  const off = +(q.get('offset') || 0), lim = +(q.get('limit') || 1e9);
  return J(rows.filter(match).slice(off, off + lim));
};

const mkRes = () => ({ code: 200, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (h, { query, token } = {}) => { const res = mkRes(); await h({ method: 'GET', query: query || {}, headers: token ? { authorization: 'Bearer ' + token } : {} }, res); return res; };
const book = (id, title, author, extra) => Object.assign({ id, title, author, lookup_key: 'k' + id, plain: LONG, html: '<h2>a</h2><h2>b</h2><h2>c</h2>', synopsis: 'S', categories: '["History"]' }, extra || {});

(async () => {
  const dedupe = require('../api/dedupe');
  const G = rows => dedupe.findGroups(rows).map(g => g.map(r => r.id).sort((a, b) => a - b));

  // ── What counts as the same book ──
  assert.deepStrictEqual(G([book(1, "Harry Potter and the Philosopher's Stone", 'J.K. Rowling'), book(2, 'Harry Potter and the Philosopher’s Stone', 'J. K. Rowling')]), [[1, 2]]);
  console.log('ok apostrophes and initials do not hide a duplicate');
  assert.deepStrictEqual(G([book(1, 'Sapiens', 'Yuval Noah Harari'), book(2, 'Sapiens: A Brief History of Humankind', 'Yuval Noah Harari')]), [[1, 2]]);
  console.log('ok same book with and without subtitle is a duplicate');
  assert.deepStrictEqual(G([book(1, 'The Prince', 'Niccolo Machiavelli'), book(2, 'Prince', 'Niccolò Machiavelli')]), [[1, 2]]);
  console.log('ok leading article and accents ignored');
  assert.deepStrictEqual(G([book(1, 'Dune', 'Frank Herbert'), book(2, 'Dune Messiah', 'Frank Herbert')]), []);
  assert.deepStrictEqual(G([book(1, "Harry Potter and the Philosopher's Stone", 'J.K. Rowling'), book(2, 'Harry Potter and the Chamber of Secrets', 'J.K. Rowling')]), []);
  console.log('ok sequels and series books are never merged');
  assert.deepStrictEqual(G([book(1, 'Meditations', 'Marcus Aurelius'), book(2, 'Meditations', 'Rene Descartes')]), []);
  console.log('ok same title by different authors is never merged');
  assert.deepStrictEqual(G([book(1, 'Sapiens: One', 'Harari'), book(2, 'Sapiens: Two', 'Harari')]), []);
  assert.deepStrictEqual(G([book(1, 'Sapiens', 'Harari'), book(2, 'Sapiens: One', 'Harari'), book(3, 'Sapiens: Two', 'Harari')]), []);
  console.log('ok different subtitles stay separate');
  assert.deepStrictEqual(G([book(1, 'Untitled', ''), book(2, 'Untitled', '')]), []);
  console.log('ok rows with no author are never auto-matched');

  // ── Permission ──
  reset([book(7, "Harry Potter and the Philosopher's Stone", 'J.K. Rowling'), book(12, 'Harry Potter and the Philosopher’s Stone', 'J. K. Rowling')]);
  let r = await call(dedupe, {});
  assert.strictEqual(r.code, 401); assert.strictEqual(db.summaries.length, 2);
  r = await call(dedupe, { token: 'wrong' });
  assert.strictEqual(r.code, 401); assert.strictEqual(db.summaries.length, 2);
  console.log('ok refused without the cron secret, nothing touched');

  // ── Dry run changes nothing ──
  r = await call(dedupe, { token: 'cron-test-secret', query: { dry: '1' } });
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.toRemove, 1); assert.strictEqual(r.body.plan[0].keep.id, 7);
  assert.strictEqual(db.summaries.length, 2); assert.strictEqual(db.sync_errors.length, 0);
  console.log('ok dry run reports the plan and changes nothing');

  // ── Real run: readers moved, duplicate removed, record kept ──
  reset([book(7, "Harry Potter and the Philosopher's Stone", 'J.K. Rowling', { synopsis: '' }), book(12, 'Harry Potter and the Philosopher’s Stone', 'J. K. Rowling', { synopsis: 'A boy wizard.' })],
    [{ id: 'a', user_id: 'u1', summary_id: 12 }, { id: 'b', user_id: 'u2', summary_id: 12 }, { id: 'c', user_id: 'u2', summary_id: 7 }]);
  r = await call(dedupe, { token: 'cron-test-secret' });
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.removed, 1);
  assert.deepStrictEqual(db.summaries.map(x => x.id), [7], 'the original (oldest) copy should be kept');
  assert.deepStrictEqual(db.user_library.map(x => x.user_id + ':' + x.summary_id).sort(), ['u1:7', 'u2:7'], 'readers should end up on the kept copy, once each');
  assert.strictEqual(db.summaries[0].synopsis, 'A boy wizard.', 'missing synopsis should be filled from the duplicate');
  const rec = db.sync_errors.find(e => e.error_type === 'dedupe_removed');
  assert.ok(rec && JSON.parse(rec.detail).removed_id === 12 && JSON.parse(rec.detail).kept_id === 7);
  console.log('ok duplicate removed, readers moved, synopsis kept, removal recorded');

  // ── Keeper choice: complete text beats incomplete, audio beats no audio ──
  reset([book(3, 'Sapiens', 'Harari', { plain: 'Too short.' }), book(9, 'Sapiens', 'Harari')]);
  r = await call(dedupe, { token: 'cron-test-secret' });
  assert.deepStrictEqual(db.summaries.map(x => x.id), [9]); console.log('ok complete copy kept over a cut-short one');
  // Older copy 3 has no audio; newer copy 9 (spelt slightly differently, so its own audio file) has audio.
  reset([book(3, 'Dune', 'Frank Herbert'), book(9, 'Dune.', 'Frank Herbert')]);
  const K = require('../lib/kernl');
  assert.notStrictEqual(K.audioKey('Dune', 'Frank Herbert', 'female'), K.audioKey('Dune.', 'Frank Herbert', 'female'));
  db.audio.add(K.audioKey('Dune.', 'Frank Herbert', 'female'));
  r = await call(dedupe, { token: 'cron-test-secret' });
  assert.deepStrictEqual(db.summaries.map(x => x.id), [9]); console.log('ok copy with audio kept over an older copy without');

  // ── Safety cap: too many at once means hold, change nothing ──
  const many = [];
  for (let i = 0; i < 26; i++) many.push(book(100 + i * 2, 'Book ' + i, 'Author ' + i), book(101 + i * 2, 'Book ' + i + '.', 'Author ' + i));
  reset(many);
  r = await call(dedupe, { token: 'cron-test-secret' });
  assert.strictEqual(r.body.held, true); assert.strictEqual(db.summaries.length, 52);
  assert.ok(db.sync_errors.some(e => e.error_type === 'dedupe_held'));
  console.log('ok more than 25 duplicates in one run: held for review, nothing deleted');

  // ── Clean library: nothing happens ──
  reset([book(1, 'Dune', 'Frank Herbert'), book(2, 'Sapiens', 'Harari')]);
  r = await call(dedupe, { token: 'cron-test-secret' });
  assert.strictEqual(r.body.removed, 0); assert.strictEqual(db.summaries.length, 2); assert.strictEqual(db.sync_errors.length, 0);
  console.log('ok clean library: nothing changed, nothing logged');

  console.log('\nALL PASSED');
})().catch(e => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
