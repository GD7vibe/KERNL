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

const MODEL = 'claude-sonnet-5-5';
const PRICE_IN = 2 / 1e6, PRICE_OUT = 10 / 1e6;      // USD per token, standard (non-batch) rates
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

async function englishById(id) {
  const r = await K.sb('/rest/v1/summaries?select=id,title,author,html,plain,words,synopsis,categories&id=eq.' + encodeURIComponent(id) + '&limit=1');
  return r.ok && Array.isArray(r.data) && r.data[0] ? r.data[0] : null;
}
async function spanishById(id) {
  const r = await K.sb('/rest/v1/' + K.SUMMARIES_TABLE + '?select=id,title,author,title_en,html,plain,words,synopsis,categories&id=eq.' + encodeURIComponent(id) + '&limit=1');
  return r.ok && Array.isArray(r.data) && r.data[0] ? r.data[0] : null;
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

// ── translate ─────────────────────────────────────────────────────────────────
function translationPrompt(en) {
  return 'You are a professional literary translator and editor. Translate the book summary below from English into neutral Latin American Spanish (español neutro latinoamericano).\n\n' +
    'STYLE\n' +
    '- Standard vocabulary understood from Mexico to Argentina. Use "tú" (tuteo). Never "vosotros", never Spain-only expressions, no regional slang.\n' +
    '- Keep the tone: engaging, intelligent, clear. It must read as if originally written in Spanish, not as a word-for-word translation.\n' +
    '- Do not add, remove or invent facts, characters, arguments or plot points. Keep all proper names.\n' +
    '- Keep the same HTML structure: the same <h2> section headings (translated) and <p> paragraphs. No <html>, <body> or <head> tags. Same length, within 10%.\n' +
    '- Quotation marks: use “ ”. Write numbers, dates and abbreviations so a text-to-speech voice reads them naturally. No markdown, no English words unless they are part of a proper name.\n\n' +
    'BOOK: "' + en.title + '" by ' + en.author + '\n\n' +
    'OUTPUT FORMAT (exactly, nothing before or after):\n' +
    'TITLE_ES: <the established Spanish title of this book if one exists in the Spanish-speaking world, otherwise a faithful translation of the title>\n' +
    'SYNOPSIS_ES: <one enticing complete sentence of 25 words or fewer, ending with a full stop>\n' +
    'HTML_START\n<the translated summary as HTML>\nHTML_END\n' +
    'WORDS_START\n' +
    '<EXACTLY 21 lines, one JSON object per line: {"word":"palabra","definition":"definición en español sencillo, menos de 15 palabras"}>\n' +
    'WORDS_END\n\n' +
    'MEGA WORDS: these are 21 interesting, unusual or book-specific Spanish words that a teenager might not know but would find fascinating to learn, drawn from the Spanish text or its themes. They must be genuine Spanish words, NOT translations of the English vocabulary of the original. Every word unique; the definition in plain Spanish. Count them: exactly 21.\n\n' +
    'ENGLISH SUMMARY TO TRANSLATE:\n' + en.html;
}

function between(raw, a, b) {
  const i = raw.indexOf(a); if (i < 0) return null;
  const j = raw.indexOf(b, i + a.length); if (j < 0) return null;
  return raw.slice(i + a.length, j).trim();
}
function htmlToPlain(html) { return html.replace(/<h2[^>]*>/gi, '\n\n').replace(/<\/h2>/gi, '\n\n').replace(/<p[^>]*>/gi, '').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim(); }

function parseTranslation(raw, en) {
  const problems = [];
  const titleM = raw.match(/^TITLE_ES:\s*(.+)$/m), synM = raw.match(/^SYNOPSIS_ES:\s*(.+)$/m);
  const title = titleM ? titleM[1].trim().replace(/^["“”']|["“”']$/g, '') : '';
  let synopsis = synM ? synM[1].trim() : '';
  const html = between(raw, 'HTML_START', 'HTML_END') || '';
  const wordsBlock = between(raw, 'WORDS_START', 'WORDS_END') || '';
  const seen = new Set();
  const words = wordsBlock.split('\n').map(l => { try { return JSON.parse(l.trim()); } catch (e) { return null; } })
    .filter(w => w && w.word && w.definition)
    .filter(w => { const k = String(w.word).toLowerCase().trim(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 21);
  const plain = htmlToPlain(html);
  if (!title || title.length > 200) problems.push('no_title');
  if (!synopsis) problems.push('no_synopsis'); else if (!/[.!?]$/.test(synopsis)) synopsis += '.';
  const sp = K.summaryProblems(plain, html);
  if (sp.includes('too_short')) problems.push('too_short');
  if (sp.includes('abrupt_end')) problems.push('abrupt_end');
  const h2es = (html.match(/<h2/gi) || []).length, h2en = (String(en.html || '').match(/<h2/gi) || []).length;
  if (h2es < 3 || (h2en && Math.abs(h2es - h2en) > 1)) problems.push('sections_' + h2es + '_vs_' + h2en);
  const ratio = String(en.plain || '').length ? plain.length / String(en.plain).length : 1;
  if (ratio < 0.9 || ratio > 1.6) problems.push('length_ratio_' + ratio.toFixed(2));
  if (words.length !== 21) problems.push('words_' + words.length);
  const warnings = [];
  const eng = (plain.match(/\b(the|and|of|with|which)\b/gi) || []).length;
  if (eng > 15) warnings.push('possible_english_in_text_' + eng);
  return { title, synopsis, html, plain, words, problems, warnings, ratio: +ratio.toFixed(2) };
}

async function callClaude(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 9000, messages: [{ role: 'user', content: prompt }] })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((d.error && d.error.message) || 'Anthropic error ' + r.status); e.status = 502; throw e; }
  return { text: (d.content && d.content[0] && d.content[0].text) || '', stop: d.stop_reason, usage: d.usage || {} };
}

async function translate(id, force) {
  const en = await englishById(id);
  if (!en || !en.plain || !en.html) { const e = new Error('English summary not found for id ' + id); e.status = 404; throw e; }
  if (K.isIncomplete(en.plain, en.html)) { const e = new Error('English summary looks incomplete; not translating'); e.status = 422; throw e; }
  const existing = await spanishById(id);
  if (existing && existing.plain && !force) return { ok: true, id, skipped: 'already_translated', title: existing.title };

  let usageIn = 0, usageOut = 0, last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const c = await callClaude(translationPrompt(en));
    usageIn += c.usage.input_tokens || 0; usageOut += c.usage.output_tokens || 0;
    const t = parseTranslation(c.text, en);
    if (c.stop !== 'end_turn') t.problems.push('stop_' + c.stop);
    last = t;
    if (!t.problems.length) {
      const row = {
        id: en.id, title: t.title, author: en.author, title_en: en.title, html: t.html, plain: t.plain,
        words: JSON.stringify(t.words), synopsis: t.synopsis,
        categories: typeof en.categories === 'string' ? en.categories : JSON.stringify(en.categories || []),
        lookup_key: K.makeLookupKey(t.title, en.author)
      };
      const w = await K.sb('/rest/v1/' + K.SUMMARIES_TABLE + '?on_conflict=id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: row });
      if (!w.ok) { const e = new Error('Save failed: ' + w.status + ' ' + JSON.stringify(w.data).slice(0, 300)); e.status = 502; throw e; }
      const usd = usageIn * PRICE_IN + usageOut * PRICE_OUT;
      return { ok: true, id, title: t.title, titleEn: en.title, words: t.plain.split(/\s+/).length, englishWords: String(en.plain).split(/\s+/).length, ratio: t.ratio, attempts: attempt, warnings: t.warnings, tokensIn: usageIn, tokensOut: usageOut, usd: +usd.toFixed(4) };
    }
    console.warn('[es-pipeline] translate attempt', attempt, 'failed for', en.title, t.problems.join(','));
  }
  return { ok: false, id, title: en.title, problems: last ? last.problems : ['unknown'], note: 'Nothing saved.' };
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
