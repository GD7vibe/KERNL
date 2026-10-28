// api/es-pipeline.js
// Spanish edition build tool. Pro / admin only. Each call does ONE small job so it fits a serverless time limit.
//
//   POST { action:'pick' }                          -> the pilot list: 3 books per genre shelf (read-only)
//   POST { action:'translate', id, force? }         -> translate one English summary into Latin American Spanish
//                                                      (+ title, synopsis and 21 Spanish Mega Words) and save it
//   POST { action:'audio', id, force? }             -> make the female Spanish (es-MX) narration for one translated book
//   POST { action:'voicetest' }                     -> a ~20 second Spanish sample, to hear the voice before spending more
//   POST { action:'status', ids:[...] }             -> what exists for each id (text, words, audio)
//
// Text comes from the English library row (public.summaries) and is saved to public.summaries_es with the SAME id.
// Nothing here is reachable by free users or guests, and nothing in the browser can call it without a Pro session.
const K = require('../lib/kernl');
const { translate, parseTranslation, englishById, spanishById } = require('../lib/es-translate');

const TTS_PRICE_PER_CHAR = 15 / 1e6;                 // USD per character
const REST_CHAR_LIMIT = 14000;                       // xAI documents 15,000 characters per request: stay under it

// Same shelves, in the same order, as public/scenes.js (a book sits on the FIRST shelf that matches any of its categories).
const GROUPS = [
  { key: 'crime',    cats: ['Crime & True Crime', 'Fiction — Thriller'] },
  { key: 'fiction',  cats: ['Fiction — Literary', 'Fiction — Sci-Fi', 'Fiction — Historical'] },
  { key: 'lives',    cats: ['Biography & Memoir', 'Sport'] },
  { key: 'science',  cats: ['Science & Technology', 'Nature & Environment'] },
  { key: 'history',  cats: ['History', 'Politics & Society'] },
  { key: 'business', cats: ['Business & Entrepreneurship', 'Economics', 'Leadership'] },
  { key: 'mind',     cats: ['Personal Development', 'Psychology', 'Health & Wellbeing', 'Parenting & Family'] },
  { key: 'ideas',    cats: ['Philosophy', 'Spirituality'] }
];
function groupFor(cats) {
  cats = cats || [];
  for (const g of GROUPS) for (const c of g.cats) if (cats.indexOf(c) !== -1) return g.key;
  return 'ideas';
}

// Widely read titles per shelf, most famous first. The first three that exist in the library AND sit on that shelf are used.
// (The library holds no popularity data, so "most popular" here is a judgement call. Swap any title freely.)
const CANDIDATES = {
  business: [['Zero to One', 'Peter Thiel'], ['The Lean Startup', 'Eric Ries'], ['Rich Dad Poor Dad', 'Robert Kiyosaki'], ['Good to Great', 'Jim Collins'], ['The Intelligent Investor', 'Benjamin Graham'], ['Think and Grow Rich', 'Napoleon Hill'], ['Start with Why', 'Simon Sinek'], ['The 4-Hour Workweek', 'Timothy Ferriss']],
  mind:     [['Atomic Habits', 'James Clear'], ['Thinking, Fast and Slow', 'Daniel Kahneman'], ['How to Win Friends and Influence People', 'Dale Carnegie'], ["Man's Search for Meaning", 'Viktor Frankl'], ['The 7 Habits of Highly Effective People', 'Stephen Covey'], ['Deep Work', 'Cal Newport'], ['The Power of Habit', 'Charles Duhigg'], ['Why We Sleep', 'Matthew Walker']],
  ideas:    [['Meditations', 'Marcus Aurelius'], ["Sophie's World", 'Jostein Gaarder'], ['Letters from a Stoic', 'Seneca'], ['The Art of War', 'Sun Tzu'], ['Tao Te Ching', 'Lao Tzu'], ['The Republic', 'Plato'], ['Beyond Good and Evil', 'Friedrich Nietzsche'], ['The Prophet', 'Kahlil Gibran']],
  history:  [['Sapiens', 'Yuval Noah Harari'], ['Guns, Germs, and Steel', 'Jared Diamond'], ['The Prince', 'Niccolò Machiavelli'], ['The Rise and Fall of the Third Reich', 'William L. Shirer'], ["A People's History of the United States", 'Howard Zinn'], ['Why Nations Fail', 'Daron Acemoglu'], ['SPQR', 'Mary Beard'], ['Homo Deus', 'Yuval Noah Harari']],
  science:  [['A Brief History of Time', 'Stephen Hawking'], ['The Selfish Gene', 'Richard Dawkins'], ['Cosmos', 'Carl Sagan'], ['Silent Spring', 'Rachel Carson'], ['The Origin of Species', 'Charles Darwin'], ['The Gene', 'Siddhartha Mukherjee'], ['Astrophysics for People in a Hurry', 'Neil deGrasse Tyson'], ['The Hidden Life of Trees', 'Peter Wohlleben']],
  lives:    [['Long Walk to Freedom', 'Nelson Mandela'], ['Steve Jobs', 'Walter Isaacson'], ['Educated', 'Tara Westover'], ['Born a Crime', 'Trevor Noah'], ['Into the Wild', 'Jon Krakauer'], ['Papillon', 'Henri Charrière'], ['Open', 'Andre Agassi'], ['The Diary of a Young Girl', 'Anne Frank']],
  fiction:  [['1984', 'George Orwell'], ['To Kill a Mockingbird', 'Harper Lee'], ['Pride and Prejudice', 'Jane Austen'], ['The Great Gatsby', 'F. Scott Fitzgerald'], ['Dune', 'Frank Herbert'], ['Frankenstein', 'Mary Shelley'], ['Animal Farm', 'George Orwell'], ['Brave New World', 'Aldous Huxley']],
  crime:    [['In Cold Blood', 'Truman Capote'], ['The Da Vinci Code', 'Dan Brown'], ['Gone Girl', 'Gillian Flynn'], ['And Then There Were None', 'Agatha Christie'], ['The Girl with the Dragon Tattoo', 'Stieg Larsson'], ['The Silence of the Lambs', 'Thomas Harris'], ['The Godfather', 'Mario Puzo'], ['Murder on the Orient Express', 'Agatha Christie']]
};

function parseCats(v) {
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch (e) { return []; }
}

// ── pick ──────────────────────────────────────────────────────────────────────
async function pick() {
  const out = [], missed = [];
  for (const key of Object.keys(CANDIDATES)) {
    const chosen = [];
    for (const [title, author] of CANDIDATES[key]) {
      if (chosen.length >= 3) break;
      const row = await K.findBook(title, author, 'id,title,author,categories', 'summaries');
      if (!row) { missed.push(key + ': ' + title + ' (not in library)'); continue; }
      if (groupFor(parseCats(row.categories)) !== key) { missed.push(key + ': ' + row.title + ' (sits on shelf "' + groupFor(parseCats(row.categories)) + '")'); continue; }
      if (chosen.some(c => String(c.id) === String(row.id))) continue;
      chosen.push({ id: row.id, title: row.title, author: row.author, shelf: key });
    }
    out.push(...chosen);
  }
  return { count: out.length, books: out, skipped: missed };
}

// ── audio ─────────────────────────────────────────────────────────────────────
function chunkText(text, limit) {
  if (text.length <= limit) return [text];
  const parts = text.split(/\n\n+/), chunks = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + '\n\n' + p).length > limit && cur) { chunks.push(cur); cur = p; } else cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
async function xaiSpeak(text) {
  const bufs = [];
  for (const chunk of chunkText(text, REST_CHAR_LIMIT)) {
    const r = await fetch('https://api.x.ai/v1/tts', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.XAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: chunk, voice_id: 'eve', language: K.TTS_LANGUAGE })
    });
    if (!r.ok) { const e = new Error('xAI TTS failed: ' + r.status + ' ' + (await r.text()).slice(0, 200)); e.status = 502; throw e; }
    const b = Buffer.from(await r.arrayBuffer());
    if (!b.length) { const e = new Error('xAI returned empty audio'); e.status = 502; throw e; }
    bufs.push(b);
  }
  return Buffer.concat(bufs);
}

async function audio(id, force) {
  const es = await spanishById(id);
  if (!es || !es.plain) { const e = new Error('Spanish text not found for id ' + id + '. Translate it first.'); e.status = 404; throw e; }
  if (K.isIncomplete(es.plain, es.html)) { const e = new Error('Spanish text looks incomplete; no audio made'); e.status = 422; throw e; }
  const key = K.audioKey(es.title, es.author, 'female');
  if (!force && await K.storageHas(key)) {
    const st = await K.audioStatus(key, es.plain);
    if (st.state === 'fresh') return { ok: true, id, title: es.title, skipped: 'already_has_audio', filename: key };
  }
  const buf = await xaiSpeak(es.plain);
  if (!(await K.uploadAudio(key, buf))) { const e = new Error('Upload failed'); e.status = 502; throw e; }
  await K.saveAudioMeta({ title: es.title, author: es.author }, 'female', key, es.plain);
  return { ok: true, id, title: es.title, filename: key, chars: es.plain.length, bytes: buf.length, usd: +(es.plain.length * TTS_PRICE_PER_CHAR).toFixed(4), bytesPerChar: +(buf.length / es.plain.length).toFixed(1) };
}

async function voicetest() {
  const text = 'Hola, soy la voz de KERNL en español. Este es un breve ejemplo de cómo sonarán los resúmenes de libros: claros, cálidos y fáciles de seguir. ' +
    'Los grandes libros guardan ideas que pueden cambiar la manera en que trabajamos, aprendemos y vivimos. Aquí tienes lo esencial, para que leas menos y sepas más.';
  const buf = await xaiSpeak(text);
  const key = '_prueba_voz_es_mx.mp3';
  if (!(await K.uploadAudio(key, buf))) { const e = new Error('Upload failed'); e.status = 502; throw e; }
  return { ok: true, filename: key, url: K.publicAudioUrl(key), chars: text.length, bytes: buf.length, usd: +(text.length * TTS_PRICE_PER_CHAR).toFixed(5) };
}

async function status(ids) {
  const rows = [];
  for (const id of (ids || []).slice(0, 60)) {
    const es = await spanishById(id);
    const row = { id, es: !!(es && es.plain), title: es ? es.title : null, words: 0, audio: false, audioState: 'none' };
    if (es && es.plain) {
      try { row.words = JSON.parse(es.words || '[]').length; } catch (e) { /* leave 0 */ }
      const key = K.audioKey(es.title, es.author, 'female');
      if (await K.storageHas(key)) { row.audio = true; row.audioState = (await K.audioStatus(key, es.plain)).state; }
    }
    rows.push(row);
  }
  return { rows };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const ctx = await K.authenticate(req);
    if (!ctx || !K.canGenerateAudio(ctx)) return res.status(403).json({ error: 'Not allowed' });
    if (!process.env.ANTHROPIC_API_KEY || !process.env.XAI_API_KEY) return res.status(500).json({ error: 'Server is not configured' });
    const b = req.body || {};
    const id = b.id !== undefined && b.id !== null ? String(b.id) : '';
    switch (b.action) {
      case 'pick': return res.status(200).json(await pick());
      case 'translate': if (!id) return res.status(400).json({ error: 'id required' }); return res.status(200).json(await translate(id, !!b.force));
      case 'audio': if (!id) return res.status(400).json({ error: 'id required' }); return res.status(200).json(await audio(id, !!b.force));
      case 'voicetest': return res.status(200).json(await voicetest());
      case 'status': return res.status(200).json(await status(b.ids));
      default: return res.status(400).json({ error: 'unknown action' });
    }
  } catch (e) {
    console.error('[es-pipeline] error:', e.message);
    return res.status(e.status || 500).json({ ok: false, error: e.message });
  }
};

// Exposed for the offline test.
module.exports.parseTranslation = parseTranslation;
module.exports.groupFor = groupFor;
