const K = require('../lib/kernl');
const SUPABASE_URL = K.SUPABASE_URL;
const ES = require('../lib/es-translate');
// A new book is always written in English first (that row gives the book its id), then translated into the edition's language.
const GEN_TABLE = K.LANG === 'en' ? K.SUMMARIES_TABLE : 'summaries';

// ── String helpers ────────────────────────────────────────────────────────────
function norm(s) {
  return String(s||'').toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D'"]/g,'')
    .replace(/[*!?@#$%^&()_+=\[\]{};:<>,.\/\\|~`]/g,'')
    .replace(/\s+/g,' ').trim();
}

function normTitle(s) {
  return norm(s)
    .replace(/^(the|a|an)\s+/i,'')
    .replace(/\s*[:\-\u2014]\s*.+$/,'')
    .trim();
}

function makeKey(title, author) { return norm(title)+'||'+norm(author)+'||nospoilers'; }

function levenshtein(a, b) {
  const m=a.length, n=b.length;
  const dp=Array.from({length:m+1},(_,i)=>[i,...Array(n).fill(0)]);
  for(let j=0;j<=n;j++) dp[0][j]=j;
  for(let i=1;i<=m;i++)
    for(let j=1;j<=n;j++)
      dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}

function combinedScore(candidateTitle, candidateAuthor, queryTitle, queryAuthor) {
  const nt1 = normTitle(queryTitle), nt2 = normTitle(candidateTitle);
  const maxTLen = Math.max(nt1.length, nt2.length);
  const titleScore = maxTLen === 0 ? 1 : 1 - levenshtein(nt1, nt2) / maxTLen;

  if (!queryAuthor || queryAuthor.length < 2) return titleScore;

  const na1 = norm(queryAuthor), na2 = norm(candidateAuthor || '');
  const maxALen = Math.max(na1.length, na2.length);
  const authorScore = maxALen === 0 ? 0 : 1 - levenshtein(na1, na2) / maxALen;

  return titleScore * 0.6 + authorScore * 0.4;
}

function titleExactEnough(candidateTitle, queryTitle) {
  const nt1 = normTitle(queryTitle), nt2 = normTitle(candidateTitle);
  const maxLen = Math.max(nt1.length, nt2.length);
  if (maxLen === 0) return true;
  return (1 - levenshtein(nt1, nt2) / maxLen) >= 0.85;
}

function getDistinctiveWord(title) {
  const stops = new Set([
    'the','a','an','and','or','of','in','on','at','to','for','with','by',
    'from','is','it','its','as','be','are','was','were','not','no','my',
    'your','his','her','our','their','this','that','these','those','i','me',
    'we','us','you','he','she','they','them','what','how','why','when','who',
    'walk','walks','into','out','up','down','back','all','new','one','two',
    'book','life','story','world','man','woman','way','day','time','year'
  ]);
  const words = normTitle(title).split(' ').filter(w => w.length > 4 && !stops.has(w));
  if (!words.length) return normTitle(title).split(' ').find(w => w.length > 3) || '';
  return words.sort((a, b) => b.length - a.length)[0];
}

async function supabaseGet(url) {
  const r = await K.sb(url.slice(SUPABASE_URL.length));
  return r.ok && Array.isArray(r.data) && r.data.length > 0 ? r.data : null;
}

// ── Sync error logger ─────────────────────────────────────────────────────────
function logSyncError(title, author, voice, errorType, detail) {
  return K.logSyncError({ title, author }, voice, errorType, detail);
}

// ── Duplicate detection before insert ────────────────────────────────────────
async function checkForDuplicate(title, author, newKey) {
  try {
    const nTitle = norm(title);
    const rows = await supabaseGet(
      SUPABASE_URL + '/rest/v1/'+GEN_TABLE+'?title=ilike.' + encodeURIComponent('%' + nTitle + '%') +
      '&select=id,title,author,lookup_key&limit=20'
    );
    if (!rows) return;

    for (const row of rows) {
      if (row.lookup_key === newKey) continue; // same key — not a duplicate, it's the same record
      const score = combinedScore(row.title, row.author, title, author);
      if (score >= 0.85 && titleExactEnough(row.title, title)) {
        const detail = `New entry "${title}" by "${author}" (key: ${newKey}) is very similar to existing row id=${row.id} "${row.title}" by "${row.author}" (key: ${row.lookup_key}). Score: ${score.toFixed(3)}. Review and merge if duplicate.`;
        console.warn('[summarise] Potential duplicate detected:', detail);
        await logSyncError(title, author, null, 'duplicate_entry', detail);
      }
    }
  } catch (e) {
    console.warn('checkForDuplicate failed:', e.message);
  }
}

// Returns the new row's id (or the existing row's id if a concurrent request saved the same book first).
async function saveToSupabase(title, author, key, html, plain, words) {
  await checkForDuplicate(title, author, key);
  const r = await K.sb('/rest/v1/'+GEN_TABLE, {
    method: 'POST', prefer: 'return=representation',
    body: { title, author, lookup_key: key, html, plain, words: JSON.stringify(words) }
  });
  if (r.ok && Array.isArray(r.data) && r.data[0]) return r.data[0].id;
  console.error('Supabase insert failed:', r.status, JSON.stringify(r.data).slice(0, 200));
  const again = await K.sb('/rest/v1/'+GEN_TABLE+'?select=id&lookup_key=eq.' + encodeURIComponent(key) + '&limit=1');
  return again.ok && again.data && again.data[0] ? again.data[0].id : null;
}

async function patchWordsById(id, words) {
  const r = await K.sb('/rest/v1/'+K.SUMMARIES_TABLE+'?id=eq.' + id, { method: 'PATCH', prefer: 'return=minimal', body: { words: JSON.stringify(words) } });
  if (!r.ok) console.error('Supabase patch failed:', r.status);
}

async function generateWordsOnly(plain, title, author) {
  if (K.LANG !== 'en') return [];   // the Spanish edition never makes English vocabulary lists
  const prompt = 'Generate exactly 21 interesting vocabulary words for this book summary. You MUST provide exactly 21 unique words — no more, no fewer.\n\nBook: "'+title+'" by '+author+'\n\n'+plain.slice(0,3000)+'\n\nRespond ONLY with a valid JSON array of exactly 21 items:\n[{"word":"example","definition":"concise definition under 15 words"}]';
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1400, messages: [{ role: 'user', content: prompt }] })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'API error');
  const text = data.content[0].text.replace(/```json|```/g,'').trim();
  const words = JSON.parse(text);
  const seen = new Set();
  const unique = words.filter(w => { const k=w.word.toLowerCase().trim(); if(seen.has(k))return false; seen.add(k); return true; }).slice(0,21);
  if (unique.length < 21) console.warn(`generateWordsOnly: only got ${unique.length} words for "${title}"`);
  return unique;
}

// ── Categories ────────────────────────────────────────────────────────────────
const CATEGORIES = [
  'Business & Entrepreneurship','Personal Development','Psychology','History',
  'Science & Technology','Politics & Society','Philosophy','Biography & Memoir',
  'Fiction — Literary','Fiction — Thriller','Fiction — Sci-Fi','Fiction — Historical',
  'Health & Wellbeing','Economics','Leadership','Nature & Environment',
  'Crime & True Crime','Sport','Parenting & Family','Spirituality'
];

async function categoriseBook(title, author, plain) {
  try {
    const prompt = 'Categorise this book into 1-3 categories from the list below. Return ONLY a JSON array of category strings, nothing else.\n\nBook: "' + title + '" by ' + (author || 'Unknown') + '\nSummary snippet: ' + (plain || '').slice(0, 400) + '\n\nAvailable categories:\n' + CATEGORIES.map((c, i) => (i + 1) + '. ' + c).join('\n') + '\n\nRules:\n- Choose 1 to 3 categories maximum\n- Only use categories from the list above, spelled exactly as shown\n- Return ONLY a JSON array e.g. ["History", "Biography & Memoir"]';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 100, messages: [{ role: 'user', content: prompt }] })
    });
    if (!res.ok) return [];
    const data = await res.json();
    const text = data.content[0].text.trim().replace(/```json|```/g, '').trim();
    const cats = JSON.parse(text);
    const valid = cats.filter(c => CATEGORIES.includes(c)).slice(0, 3);
    return valid.length > 0 ? valid : [];
  } catch (e) {
    console.warn('categoriseBook failed:', e.message);
    return [];
  }
}

// ── Synopsis ──────────────────────────────────────────────────────────────────
async function generateSynopsis(title, author, plain) {
  try {
    const prompt = 'Write a single enticing synopsis for this book in 25 words or fewer. Be specific, punchy and compelling. Shorter is better. Use British English spelling throughout (honour, colour, organise, centre, realise etc). Must be a complete sentence ending with a full stop. No markdown, no hashtags, no title, no quotes, no labels — just the synopsis.\n\nBook: "' + title + '" by ' + (author || 'Unknown') + '\nSummary: ' + (plain || '').slice(0, 500);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 80, messages: [{ role: 'user', content: prompt }] })
    });
    if (!res.ok) return null;
    const data = await res.json();
    let text = data.content[0].text.trim().replace(/^["']|["']$/g, '');
    const words = text.split(/\s+/);
    if (words.length > 25) {
      text = words.slice(0, 25).join(' ');
      const lastSentenceEnd = Math.max(text.lastIndexOf('.'), text.lastIndexOf('!'), text.lastIndexOf('?'));
      if (lastSentenceEnd > 10) text = text.slice(0, lastSentenceEnd + 1).trim();
    }
    if (text && !/[.!?]$/.test(text)) text = text + '.';
    return text || null;
  } catch (e) {
    console.warn('generateSynopsis failed:', e.message);
    return null;
  }
}

// ── Cache lookup — robust multi-level with combined title+author scoring ───────
async function findCached(title, author, table) {
  table = table || K.SUMMARIES_TABLE;
  const nAuthor = norm(author || '');
  const exactKey = makeKey(title, author);

  let rows = await supabaseGet(SUPABASE_URL+'/rest/v1/'+table+'?lookup_key=eq.'+encodeURIComponent(exactKey)+'&select=id,html,plain,words,lookup_key,title,author&limit=1');
  if (rows) { console.log('Cache hit L1'); return rows[0]; }

  const oldSpoilersKey = norm(title)+'||'+norm(author)+'||spoilers';
  rows = await supabaseGet(SUPABASE_URL+'/rest/v1/'+table+'?lookup_key=eq.'+encodeURIComponent(oldSpoilersKey)+'&select=id,html,plain,words,lookup_key,title,author&limit=1');
  if (rows) { console.log('Cache hit L1b'); return rows[0]; }

  const titleKey = norm(title)+'||nospoilers';
  rows = await supabaseGet(SUPABASE_URL+'/rest/v1/'+table+'?lookup_key=eq.'+encodeURIComponent(titleKey)+'&select=id,html,plain,words,lookup_key,title,author&limit=1');
  if (rows) { console.log('Cache hit L2'); return rows[0]; }

  function pickBest(candidates, minCombined) {
    return candidates
      .filter(r => titleExactEnough(r.title, title))
      .map(r => ({ row: r, score: combinedScore(r.title, r.author, title, author) }))
      .filter(r => r.score >= minCombined)
      .sort((a, b) => b.score - a.score)
      .map(r => r.row)[0] || null;
  }

  const nTitle = norm(title);
  rows = await supabaseGet(SUPABASE_URL+'/rest/v1/'+table+'?title=ilike.'+encodeURIComponent('%'+nTitle+'%')+'&select=id,html,plain,words,lookup_key,title,author&limit=20');
  if (rows) { const m = pickBest(rows, 0.82); if (m) { console.log('Cache hit L3'); return m; } }

  const ntTitle = normTitle(title);
  if (ntTitle !== nTitle) {
    rows = await supabaseGet(SUPABASE_URL+'/rest/v1/'+table+'?title=ilike.'+encodeURIComponent('%'+ntTitle+'%')+'&select=id,html,plain,words,lookup_key,title,author&limit=20');
    if (rows) { const m = pickBest(rows, 0.82); if (m) { console.log('Cache hit L3b'); return m; } }
  }

  const word = getDistinctiveWord(title);
  if (word && word.length >= 5) {
    rows = await supabaseGet(SUPABASE_URL+'/rest/v1/'+table+'?title=ilike.'+encodeURIComponent('%'+word+'%')+'&select=id,html,plain,words,lookup_key,title,author&limit=20');
    if (rows) { const m = pickBest(rows, 0.85); if (m) { console.log('Cache hit L4'); return m; } }
  }

  if (nAuthor && nAuthor.length > 2) {
    rows = await supabaseGet(SUPABASE_URL+'/rest/v1/'+table+'?author=ilike.'+encodeURIComponent('%'+nAuthor+'%')+'&select=id,html,plain,words,lookup_key,title,author&limit=20');
    if (rows) { const m = pickBest(rows, 0.80); if (m) { console.log('Cache hit L5'); return m; } }
  }

  console.log('Cache miss'); return null;
}

function buildPrompt(title, author) {
  return 'Write a comprehensive 1,500-word summary of the book "'+title+'"'+(author?' by '+author:'')+'. Write a full, comprehensive summary covering all key arguments, themes, insights, plot points, character arcs, and conclusions. Include spoilers where relevant — the reader wants the complete picture. A disclaimer about spoilers will be shown separately so do not add one yourself. IMPORTANT: On the very first line of your response, write either GENRE:FICTION or GENRE:NONFICTION so the system knows how to categorise this book. Then continue with the summary on the next line. Structure it with clear sections using HTML formatting: - An opening paragraph introducing the book and its significance - 4-6 sections with <h2> headings covering key themes, characters, and insights - Each section should be 2-3 substantial paragraphs - A closing section on legacy and impact Format rules: - Use <h2> for section headings - Use <p> tags for paragraphs - No <html>, <body>, or <head> tags - return only the inner content - Write in an engaging, intelligent tone - Target exactly 1,500 words. Do not exceed 1,550 words under any circumstances. After the summary, on a new line write: WORDS_START Then provide EXACTLY 21 interesting, unusual, or book-specific words from the book or relevant to its themes. These should be words a teenager might not know but would find fascinating to learn. CRITICAL: You MUST provide exactly 21 words — not 20, not 22, exactly 21. Every word must be completely unique - no word may appear more than once in the list. Count your words before finalising. Format each word as JSON on its own line like this: {"word":"example","definition":"the meaning of the word in plain English"} Then on a new line write: WORDS_END';
}

function parseWordsBlock(raw) { const wordsStart = raw.indexOf('WORDS_START'); const wordsEnd = raw.indexOf('WORDS_END'); if (wordsStart === -1 || wordsEnd === -1) return []; const wordsBlock = raw.slice(wordsStart + 11, wordsEnd).trim(); const seen = new Set(); return wordsBlock.split('\n').map(line => { try { return JSON.parse(line.trim()); } catch(e) { return null; } }).filter(w => w && w.word && w.definition).filter(w => { const k = w.word.toLowerCase().trim(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 21); }
function stripWordsBlock(raw) { const wordsStart = raw.indexOf('WORDS_START'); return wordsStart > -1 ? raw.slice(0, wordsStart).trim() : raw.trim(); }
function htmlToPlain(html) { return html.replace(/<h2[^>]*>/gi, '\n\n').replace(/<\/h2>/gi, '\n\n').replace(/<p[^>]*>/gi, '').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim(); }

function parseWords(row) {
  try { return row.words ? JSON.parse(row.words) : []; } catch (e) { return []; }
}


// ── Spanish edition: a Pro reader asks for a book that is not in the Spanish library yet ─────────────────────────
// 1. work out the book's original (English) title and author, whatever language the reader typed
// 2. use the English summary if the library has one, otherwise write it
// 3. translate it into Latin American Spanish (title, synopsis, text, 21 Spanish Mega Words), save, charge once
async function canonicalise(title, author) {
  try {
    const prompt = 'A reader typed a book title (any language) and maybe an author. Return the book\'s original title in English (or its original language if it was never published in English, as it is usually known) and its author, as ONLY a JSON object: {"title":"...","author":"..."}. If you do not recognise a real book, return {"title":"' + title.replace(/"/g, '') + '","author":"' + (author || '').replace(/"/g, '') + '"}.\n\nTitle: ' + title + '\nAuthor: ' + (author || '(not given)');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 150, messages: [{ role: 'user', content: prompt }] })
    });
    if (!r.ok) return { title, author };
    const d = await r.json();
    const o = JSON.parse(d.content[0].text.replace(/```json|```/g, '').trim());
    return { title: K.cleanText(o.title, 200) || title, author: K.cleanText(o.author, 200) || author };
  } catch (e) { return { title, author }; }
}

async function writeEnglish(title, author) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 5000, messages: [{ role: 'user', content: buildPrompt(title, author) }] })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.error && d.error.message) || 'Anthropic API error');
  let raw = ((d.content && d.content[0] && d.content[0].text) || '').trim();
  const first = raw.split('\n')[0].trim();
  if (first.toUpperCase().startsWith('GENRE:')) raw = raw.slice(first.length).trim();
  const words = parseWordsBlock(raw);
  const html = stripWordsBlock(raw);
  const plain = htmlToPlain(html);
  const problems = K.summaryProblems(plain, html);
  if (d.stop_reason !== 'end_turn' || problems.includes('too_short') || problems.includes('abrupt_end')) return null;
  const id = await saveToSupabase(title, author, makeKey(title, author), html, plain, words);
  if (!id) return null;
  try {
    const [categories, synopsis] = await Promise.all([categoriseBook(title, author, plain), generateSynopsis(title, author, plain)]);
    const patch = {};
    if (categories && categories.length) patch.categories = JSON.stringify(categories);
    if (synopsis) patch.synopsis = synopsis;
    if (Object.keys(patch).length) await K.sb('/rest/v1/' + GEN_TABLE + '?id=eq.' + id, { method: 'PATCH', prefer: 'return=minimal', body: patch });
  } catch (e) { console.warn('Categories/synopsis save failed:', e.message); }
  return id;
}

async function spanishNewBook(req, res, ctx, title, author) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
  const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* closed */ } }, 8000);
  try {
    send({ status: 'Buscando el libro…' });
    const canon = await canonicalise(title, author);
    let en = await findCached(canon.title, canon.author, 'summaries');
    let enId = en ? en.id : null;

    // Already translated under another spelling of the title? Then it is just a library hit.
    if (enId) {
      const have = await ES.spanishById(enId);
      if (have && have.plain) {
        const access = await K.authoriseRead(ctx, have);
        if (!access.ok) { send({ error: (access.body && access.body.error) || 'No disponible.' }); return res.end(); }
        let w = []; try { w = have.words ? JSON.parse(have.words) : []; } catch (e) { /* none */ }
        send({ done: true, title: have.title, author: have.author, html: have.html, plain: have.plain, words: w, source: 'cache', quota: access.quota || null });
        return res.end();
      }
    }

    if (!enId) {
      send({ status: 'Escribiendo el resumen… (1 de 2)' });
      enId = await writeEnglish(canon.title, canon.author);
      if (!enId) { send({ error: 'El resumen se cortó, así que no se guardó. Inténtalo de nuevo.' }); return res.end(); }
    }

    send({ status: 'Traduciendo al español… (2 de 2)' });
    const t = await ES.translate(enId, false);
    if (!t.ok) { send({ error: 'No se pudo crear el resumen en español. Inténtalo de nuevo en un momento.' }); return res.end(); }
    const es = await ES.spanishById(enId);
    if (!es || !es.plain) { send({ error: 'No se pudo guardar el resumen. Inténtalo de nuevo.' }); return res.end(); }

    let quota = null;
    try { const acc = await K.accessBook(ctx, enId); quota = acc.quota || null; } catch (e) { console.warn('accessBook failed:', e.message); }
    let words = []; try { words = es.words ? JSON.parse(es.words) : []; } catch (e) { /* none */ }
    send({ done: true, title: es.title, author: es.author, book: { title: es.title, author: es.author, synopsis: es.synopsis, categories: es.categories }, html: es.html, plain: es.plain, words, source: 'generated', quota });
    return res.end();
  } catch (e) {
    console.error('[summarise es] failed:', e.message);
    try { send({ error: 'Algo salió mal al crear el resumen. Inténtalo de nuevo.' }); res.end(); } catch (x) { /* closed */ }
  } finally { clearInterval(beat); }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (K.rateLimited('sum:' + K.clientIp(req), 40, 60 * 1000)) return res.status(429).json({ error: 'Demasiadas solicitudes' });

  const body = req.body || {};
  const ctx = await K.authenticate(req);

  // ── Patch words mode (admin scripts only) ─────────────────────────────────
  if (body.patchWords) {
    if (!(ctx && ctx.admin)) return res.status(403).json({ error: 'Forbidden' });
    try {
      const cached = await findCached(K.cleanText(body.title, 300), K.cleanText(body.author, 300));
      if (!cached) return res.status(404).json({ error: 'Book not found' });
      let words = parseWords(cached);
      if (!words || words.length === 0) words = await generateWordsOnly(cached.plain, cached.title, cached.author || body.author || '');
      await patchWordsById(cached.id, words);
      return res.status(200).json({ ok: true, wordCount: words.length });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  const title = K.cleanText(body.title, 200);
  const author = K.cleanText(body.author, 200);
  if (!title) return res.status(400).json({ error: 'Falta el título' });

  // ── Cache check ───────────────────────────────────────────────────────────
  try {
    const cached = await findCached(title, author);
    if (cached) {
      const access = await K.authoriseRead(ctx, cached);
      if (!access.ok) return K.fail(res, access);
      let words = parseWords(cached);
      if (!words || words.length === 0) {
        try {
          words = await generateWordsOnly(cached.plain, cached.title, cached.author || author || '');
          if (words.length > 0 && cached.id) await patchWordsById(cached.id, words);
        } catch (e) { words = []; }
      }
      return res.status(200).json({ html: cached.html, plain: cached.plain, words, source: 'cache', quota: access.quota || null });
    }
  } catch (e) {
    console.error('Cache lookup error:', e.message);
    // Fail closed: don't fall through to a paid generation on a lookup error.
    return res.status(503).json({ error: 'La biblioteca no está disponible por ahora. Inténtalo de nuevo.' });
  }

  // ── Not cached: generating costs money, so it needs a signed-in user with allowance left ──
  if (!ctx) return res.status(401).json({ code: 'auth_required', error: 'Inicia sesión para crear un resumen nuevo.' });
  if (ctx.tier === 'guest') {
    return res.status(403).json({ code: 'signup_required', error: 'Ese libro todavía no está en la biblioteca. Crea una cuenta gratis para pedir resúmenes nuevos.' });
  }
  if (!ctx.admin) {
    const profile = await K.getProfile(ctx.user.id);
    const limit = K.limitFor(ctx.tier);
    const used = profile ? (profile.downloads_used || 0) : 0;
    if (used >= limit) {
      return res.status(403).json({ code: 'limit', error: 'Has usado tus ' + limit + ' resúmenes.', quota: { used, limit, tier: ctx.tier } });
    }
    if (K.rateLimited('gensum:' + ctx.user.id, 10, 60 * 60 * 1000)) {
      return res.status(429).json({ error: 'Demasiados resúmenes nuevos esta hora. Inténtalo más tarde.' });
    }
  }

    // ── Spanish edition: English first, then translate ───────────────────────
  if (K.LANG !== 'en') return spanishNewBook(req, res, ctx, title, author);

  // ── Not cached — stream from Anthropic ───────────────────────────────────
  const prompt = buildPrompt(title, author);

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 5000, stream: true, messages: [{ role: 'user', content: prompt }] })
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json();
      return res.status(500).json({ error: err.error?.message || 'Anthropic API error' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const reader = anthropicRes.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let genreStripped = false;
    let stopReason = null;
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'message_delta' && parsed.delta && parsed.delta.stop_reason) stopReason = parsed.delta.stop_reason;
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            const chunk = parsed.delta.text;
            fullText += chunk;

            let toSend = fullText;
            if (!genreStripped) {
              const firstNewline = toSend.indexOf('\n');
              if (firstNewline > -1) {
                const firstLine = toSend.slice(0, firstNewline).trim();
                if (firstLine.toUpperCase().startsWith('GENRE:')) {
                  toSend = toSend.slice(firstNewline).trimStart();
                  genreStripped = true;
                }
              } else { continue; }
            }

            const wordsStartIdx = toSend.indexOf('WORDS_START');
            const visibleText = wordsStartIdx > -1 ? toSend.slice(0, wordsStartIdx) : toSend;
            res.write(`data: ${JSON.stringify({ chunk: visibleText })}\n\n`);
          }
        } catch(e) { /* ignore */ }
      }
    }

    // ── Parse and save ────────────────────────────────────────────────────────
    let raw = fullText.trim();
    const firstLine = raw.split('\n')[0].trim();
    if (firstLine.toUpperCase().startsWith('GENRE:')) raw = raw.slice(firstLine.length).trim();
    const saveKey = makeKey(title, author);
    let words = parseWordsBlock(raw);
    const html = stripWordsBlock(raw);
    const plain = htmlToPlain(html);

    // Top up to 21 words if Claude returned fewer
    if (words.length < 21) {
      console.log(`Only ${words.length} words parsed — topping up to 21 via Haiku`);
      try {
        const existingWordSet = new Set(words.map(w => w.word.toLowerCase().trim()));
        const topUpPrompt = 'Generate exactly ' + (21 - words.length) + ' more interesting vocabulary words for this book. They must be different from these already chosen: ' + words.map(w => w.word).join(', ') + '.\n\nBook: "' + title + '" by ' + (author || 'Unknown') + '\n\n' + plain.slice(0, 2000) + '\n\nRespond ONLY with a valid JSON array:\n[{"word":"example","definition":"concise definition under 15 words"}]';
        const topUpRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 800, messages: [{ role: 'user', content: topUpPrompt }] })
        });
        if (topUpRes.ok) {
          const topUpData = await topUpRes.json();
          const topUpText = topUpData.content[0].text.replace(/```json|```/g, '').trim();
          const topUpWords = JSON.parse(topUpText);
          const newWords = topUpWords.filter(w => w.word && w.definition && !existingWordSet.has(w.word.toLowerCase().trim()));
          words = [...words, ...newWords].slice(0, 21);
          console.log(`Topped up to ${words.length} words`);
        }
      } catch(e) { console.warn('Word top-up failed:', e.message); }
    }

    // Never save (or narrate, or charge for) a summary that was cut short.
    const problems = K.summaryProblems(plain, html);
    if (stopReason !== 'end_turn' || problems.includes('too_short') || problems.includes('abrupt_end')) {
      console.error('[summarise] incomplete summary NOT saved:', title, 'stop_reason=' + stopReason, problems.join(','));
      res.write('data: ' + JSON.stringify({ error: 'El resumen se cortó, así que no se guardó. Inténtalo de nuevo.' }) + '\n\n');
      return res.end();
    }

    const savedId = await saveToSupabase(title, author, saveKey, html, plain, words).catch(e => { console.error('Supabase save failed:', e.message); return null; });

    // ── Categories + synopsis ─────────────────────────────────────────────────
    if (savedId) {
      try {
        const [categories, synopsis] = await Promise.all([
          categoriseBook(title, author, plain),
          generateSynopsis(title, author, plain)
        ]);
        const patch = {};
        if (categories && categories.length > 0) patch.categories = JSON.stringify(categories);
        if (synopsis) patch.synopsis = synopsis;
        if (Object.keys(patch).length > 0) {
          await K.sb('/rest/v1/'+GEN_TABLE+'?id=eq.' + savedId, { method: 'PATCH', prefer: 'return=minimal', body: patch });
        }
      } catch (e) { console.warn('Categories/synopsis save failed:', e.message); }
    }

    // ── Charge the user's allowance (adds the book to their library) ──────────
    let quota = null;
    if (savedId) {
      try {
        const acc = await K.accessBook(ctx, savedId);
        quota = acc.quota || null;
      } catch (e) { console.warn('accessBook failed:', e.message); }
    }

    res.write('data: ' + JSON.stringify({ done: true, html, plain, words, source: 'generated', quota }) + '\n\n');
    res.end();

  } catch(err) {
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: err.message || 'Failed to generate summary' });
    }
  }
};

// Exposed for api/audit-books.js so the audit runs the exact lookup a book click runs.
module.exports.findCached = findCached;
