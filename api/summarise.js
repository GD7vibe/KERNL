const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';

// ── Audio key helper ──────────────────────────────────────────────────────────
function makeAudioKey(title, author, voice) {
  const safe = s => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
  return `${safe(title)}__${safe(author)}__${voice}.mp3`;
}

// ── Generate and cache audio using xAI REST API ───────────────────────────────
async function generateAndCacheAudio(title, author, plainText, voice = 'female') {
  try {
    const xaiVoice = voice === 'male' ? 'leo' : 'eve';
    const filename = makeAudioKey(title, author, voice);
    console.log('Pre-generating TTS:', filename);

    const ttsRes = await fetch('https://api.x.ai/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: plainText, voice_id: xaiVoice, language: 'en' })
    });

    if (!ttsRes.ok) {
      console.error('xAI TTS failed:', ttsRes.status, await ttsRes.text());
      return false;
    }

    const buffer = await ttsRes.arrayBuffer();

    const uploadRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/audio/${encodeURIComponent(filename)}`,
      {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'audio/mpeg',
          'Cache-Control': '3600'
        },
        body: buffer
      }
    );

    if (!uploadRes.ok) {
      const upsertRes = await fetch(
        `${SUPABASE_URL}/storage/v1/object/audio/${encodeURIComponent(filename)}`,
        {
          method: 'PUT',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'audio/mpeg',
            'Cache-Control': '3600'
          },
          body: buffer
        }
      );
      if (!upsertRes.ok) {
        console.error('Supabase audio save failed:', await upsertRes.text());
        return false;
      }
    }

    console.log('Audio pre-cached:', filename);
    return true;
  } catch (e) {
    console.error('Pre-generate audio error:', e.message);
    return false;
  }
}

// ── Existing helpers ──────────────────────────────────────────────────────────
function norm(s) { return String(s||'').toLowerCase().replace(/[\u2018\u2019\u201C\u201D'"]/g,'').replace(/[*!?@#$%^&()_+=\[\]{};:<>,.\/\\|~`]/g,'').replace(/\s+/g,' ').trim(); }
function normTitle(s) { return norm(s).replace(/^(the|a|an)\s+/i,'').replace(/\s*[:\-\u2014]\s*.+$/,'').trim(); }
function makeKey(title, author) { return norm(title)+'||'+norm(author)+'||nospoilers'; }
function levenshtein(a,b) { const m=a.length,n=b.length,dp=Array.from({length:m+1},(_,i)=>[i,...Array(n).fill(0)]);for(let j=0;j<=n;j++)dp[0][j]=j;for(let i=1;i<=m;i++)for(let j=1;j<=n;j++)dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);return dp[m][n]; }
function similarity(a,b) { const na=normTitle(a),nb=normTitle(b),maxLen=Math.max(na.length,nb.length);if(maxLen===0)return 1;return 1-levenshtein(na,nb)/maxLen; }
function getDistinctiveWord(title) { const stops=new Set(['the','a','an','and','or','of','in','on','at','to','for','with','by','from','is','it','its','as','be','are','was','were','not','no','my','your','his','her','our','their','this','that','these','those','i','me','we','us','you','he','she','they','them','what','how','why','when','who']);const words=normTitle(title).split(' ').filter(w=>w.length>3&&!stops.has(w));if(!words.length)return normTitle(title).split(' ')[0];return words.sort((a,b)=>b.length-a.length)[0]; }
async function supabaseGet(url) { const res=await fetch(url,{headers:{'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY}});const data=await res.json();return data&&data.length>0?data:null; }
async function saveToSupabase(title,author,key,html,plain,words) { const res=await fetch(SUPABASE_URL+'/rest/v1/summaries',{method:'POST',headers:{'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY,'Content-Type':'application/json','Prefer':'return=minimal'},body:JSON.stringify({title,author,lookup_key:key,html,plain,words:JSON.stringify(words)})}); if(!res.ok){const err=await res.text();console.error('Supabase insert failed:',err);} }
async function patchWordsById(id, words) { const res = await fetch(SUPABASE_URL+'/rest/v1/summaries?id=eq.'+id, { method: 'PATCH', headers: {'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY,'Content-Type':'application/json','Prefer':'return=minimal'}, body: JSON.stringify({ words: JSON.stringify(words) }) }); if (!res.ok) console.error('Supabase patch failed:', res.status); }
async function generateWordsOnly(plain, title, author) { const prompt = 'Generate exactly 21 interesting vocabulary words for this book summary. You MUST provide exactly 21 unique words — no more, no fewer.\n\nBook: "'+title+'" by '+author+'\n\n'+plain.slice(0,3000)+'\n\nRespond ONLY with a valid JSON array of exactly 21 items:\n[{"word":"example","definition":"concise definition under 15 words"}]'; const response = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: {'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'}, body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:1400, messages:[{role:'user',content:prompt}] }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || 'API error'); const text = data.content[0].text.replace(/```json|```/g,'').trim(); const words = JSON.parse(text); const seen = new Set(); const unique = words.filter(w => { const k=w.word.toLowerCase().trim(); if(seen.has(k))return false; seen.add(k); return true; }).slice(0,21); if (unique.length < 21) console.warn(`generateWordsOnly: only got ${unique.length} words for "${title}"`); return unique; }

// ── Categories ────────────────────────────────────────────────────────────────
const CATEGORIES = [
  'Business & Entrepreneurship',
  'Personal Development',
  'Psychology',
  'History',
  'Science & Technology',
  'Politics & Society',
  'Philosophy',
  'Biography & Memoir',
  'Fiction — Literary',
  'Fiction — Thriller',
  'Fiction — Sci-Fi',
  'Fiction — Historical',
  'Health & Wellbeing',
  'Economics',
  'Leadership',
  'Nature & Environment',
  'Crime & True Crime',
  'Sport',
  'Parenting & Family',
  'Spirituality'
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
    const prompt = 'Write a single enticing synopsis for this book in 25 words or fewer. Be specific, punchy and compelling. Shorter is better. Use British English spelling throughout (honour, colour, organise, centre, realise etc). Must be a complete sentence. No markdown, no hashtags, no title, no quotes, no labels — just the synopsis.\n\nBook: "' + title + '" by ' + (author || 'Unknown') + '\nSummary: ' + (plain || '').slice(0, 500);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 60, messages: [{ role: 'user', content: prompt }] })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.content[0].text.trim().replace(/^["']|["']$/g, '');
    return text.split(/\s+/).slice(0, 25).join(' ');
  } catch (e) {
    console.warn('generateSynopsis failed:', e.message);
    return null;
  }
}

async function findCached(title, author) {
  const nTitle=norm(title), nAuthor=norm(author), ntTitle=normTitle(title);
  const exactKey=makeKey(title, author);

  // L1: exact key match (nospoilers — all new records)
  let rows=await supabaseGet(SUPABASE_URL+'/rest/v1/summaries?lookup_key=eq.'+encodeURIComponent(exactKey)+'&select=id,html,plain,words,lookup_key,title,author&limit=1');
  if(rows){console.log('Cache hit L1');return rows[0];}

  // L1b: also check old spoilers key for backward compat with any old records
  const oldSpoilersKey = norm(title)+'||'+norm(author)+'||spoilers';
  rows=await supabaseGet(SUPABASE_URL+'/rest/v1/summaries?lookup_key=eq.'+encodeURIComponent(oldSpoilersKey)+'&select=id,html,plain,words,lookup_key,title,author&limit=1');
  if(rows){console.log('Cache hit L1b (old spoilers key)');return rows[0];}

  // L2: title-only key (legacy records without author)
  const titleKey=norm(title)+'||nospoilers';
  rows=await supabaseGet(SUPABASE_URL+'/rest/v1/summaries?lookup_key=eq.'+encodeURIComponent(titleKey)+'&select=id,html,plain,words,lookup_key,title,author&limit=1');
  if(rows){console.log('Cache hit L2');return rows[0];}

  // L3: title ILIKE fuzzy
  rows=await supabaseGet(SUPABASE_URL+'/rest/v1/summaries?title=ilike.'+encodeURIComponent('%'+nTitle+'%')+'&select=id,html,plain,words,lookup_key,title,author&limit=10');
  if(rows){const scored=rows.map(r=>({row:r,score:similarity(title,r.title)})).filter(r=>r.score>=0.75).sort((a,b)=>b.score-a.score);if(scored.length){console.log('Cache hit L3');return scored[0].row;}}

  // L3b: normTitle fuzzy
  if(ntTitle!==nTitle){rows=await supabaseGet(SUPABASE_URL+'/rest/v1/summaries?title=ilike.'+encodeURIComponent('%'+ntTitle+'%')+'&select=id,html,plain,words,lookup_key,title,author&limit=10');if(rows){const scored=rows.map(r=>({row:r,score:similarity(title,r.title)})).filter(r=>r.score>=0.75).sort((a,b)=>b.score-a.score);if(scored.length){console.log('Cache hit L3b');return scored[0].row;}}}

  // L4: distinctive word
  const word=getDistinctiveWord(title);
  if(word&&word.length>=4){rows=await supabaseGet(SUPABASE_URL+'/rest/v1/summaries?title=ilike.'+encodeURIComponent('%'+word+'%')+'&select=id,html,plain,words,lookup_key,title,author&limit=20');if(rows){const scored=rows.map(r=>({row:r,score:similarity(title,r.title)})).filter(r=>r.score>=0.70).sort((a,b)=>b.score-a.score);if(scored.length){console.log('Cache hit L4');return scored[0].row;}}}

  // L5: author fuzzy
  if(nAuthor&&nAuthor.length>2){rows=await supabaseGet(SUPABASE_URL+'/rest/v1/summaries?author=ilike.'+encodeURIComponent('%'+nAuthor+'%')+'&select=id,html,plain,words,lookup_key,title,author&limit=20');if(rows){const scored=rows.map(r=>({row:r,score:similarity(title,r.title)})).filter(r=>r.score>=0.65).sort((a,b)=>b.score-a.score);if(scored.length){console.log('Cache hit L5');return scored[0].row;}}}

  console.log('Cache miss');return null;
}

function buildPrompt(title, author) {
  return 'Write a comprehensive 1,500-word summary of the book "'+title+'"'+(author?' by '+author:'')+'. Write a full, comprehensive summary covering all key arguments, themes, insights, plot points, character arcs, and conclusions. Include spoilers where relevant — the reader wants the complete picture. A disclaimer about spoilers will be shown separately so do not add one yourself. IMPORTANT: On the very first line of your response, write either GENRE:FICTION or GENRE:NONFICTION so the system knows how to categorise this book. Then continue with the summary on the next line. Structure it with clear sections using HTML formatting: - An opening paragraph introducing the book and its significance - 4-6 sections with <h2> headings covering key themes, characters, and insights - Each section should be 2-3 substantial paragraphs - A closing section on legacy and impact Format rules: - Use <h2> for section headings - Use <p> tags for paragraphs - No <html>, <body>, or <head> tags - return only the inner content - Write in an engaging, intelligent tone - Target exactly 1,500 words. Do not exceed 1,550 words under any circumstances. After the summary, on a new line write: WORDS_START Then provide EXACTLY 21 interesting, unusual, or book-specific words from the book or relevant to its themes. These should be words a teenager might not know but would find fascinating to learn. CRITICAL: You MUST provide exactly 21 words — not 20, not 22, exactly 21. Every word must be completely unique - no word may appear more than once in the list. Count your words before finalising. Format each word as JSON on its own line like this: {"word":"example","definition":"the meaning of the word in plain English"} Then on a new line write: WORDS_END';
}

function parseWordsBlock(raw) { const wordsStart = raw.indexOf('WORDS_START'); const wordsEnd = raw.indexOf('WORDS_END'); if (wordsStart === -1 || wordsEnd === -1) return []; const wordsBlock = raw.slice(wordsStart + 11, wordsEnd).trim(); const seen = new Set(); return wordsBlock.split('\n').map(line => { try { return JSON.parse(line.trim()); } catch(e) { return null; } }).filter(w => w && w.word && w.definition).filter(w => { const k = w.word.toLowerCase().trim(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 21); }
function stripWordsBlock(raw) { const wordsStart = raw.indexOf('WORDS_START'); return wordsStart > -1 ? raw.slice(0, wordsStart).trim() : raw.trim(); }
function htmlToPlain(html) { return html.replace(/<h2[^>]*>/gi, '\n\n').replace(/<\/h2>/gi, '\n\n').replace(/<p[^>]*>/gi, '').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim(); }

function extractCompleteSentences(text) {
  const sentenceEnd = /[.!?]+(?:\s|$)/g;
  let lastIdx = 0;
  let match;
  let sentences = '';
  while ((match = sentenceEnd.exec(text)) !== null) {
    lastIdx = match.index + match[0].length;
    sentences = text.slice(0, lastIdx);
  }
  const remaining = text.slice(lastIdx);
  return { sentences: sentences.trim(), remaining: remaining };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Patch words mode ──────────────────────────────────────────────────────
  if (req.body && req.body.patchWords) {
    const { title, author } = req.body;
    try {
      const cached = await findCached(title, author || '');
      if (!cached) return res.status(404).json({ error: 'Book not found' });
      let words = [];
      try { words = cached.words ? JSON.parse(cached.words) : []; } catch(e) {}
      if (!words || words.length === 0) {
        words = await generateWordsOnly(cached.plain, cached.title, cached.author || author || '');
      }
      const pRes = await fetch(SUPABASE_URL + '/rest/v1/summaries?id=eq.' + cached.id, {
        method: 'PATCH',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY, 'Authorization': 'Bearer ' + (process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ words: JSON.stringify(words) })
      });
      return res.status(200).json({ ok: pRes.ok, status: pRes.status, wordCount: words.length });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  const { title, author, voice, skipAudio } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  // ── Cache check ───────────────────────────────────────────────────────────
  try {
    const cached = await findCached(title, author);
    if (cached) {
      let words = [];
      try { words = cached.words ? JSON.parse(cached.words) : []; } catch(e) {}
      if (!words || words.length === 0) {
        try {
          words = await generateWordsOnly(cached.plain, cached.title, cached.author || author || '');
          if (words.length > 0 && cached.id) await patchWordsById(cached.id, words);
        } catch(e) { words = []; }
      }
      return res.status(200).json({ html: cached.html, plain: cached.plain, words, source: 'cache' });
    }
  } catch(e) { console.error('Cache lookup error:', e.message); }

  // ── Not cached — stream from Anthropic ───────────────────────────────────
  const prompt = buildPrompt(title, author);
  const audioVoice = voice || 'female';
  const audioFilename = makeAudioKey(title, author, audioVoice);

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 3000, stream: true, messages: [{ role: 'user', content: prompt }] })
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

    // ── Claude done — parse and save ─────────────────────────────────────────
    let raw = fullText.trim();
    const firstLine = raw.split('\n')[0].trim();
    if (firstLine.toUpperCase().startsWith('GENRE:')) raw = raw.slice(firstLine.length).trim();
    const saveKey = makeKey(title, author);
    let words = parseWordsBlock(raw);
    const html = stripWordsBlock(raw);
    const plain = htmlToPlain(html);

    // Ensure exactly 21 Mega Words — top up via Haiku if Claude returned fewer
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

    await saveToSupabase(title, author, saveKey, html, plain, words).catch(e => console.error('Supabase save failed:', e.message));

    // ── Categories + synopsis — fire and forget in parallel ───────────────────
    // Does not block the response — runs after res.end()
    // skipAudio flag suppresses audio generation (used for batch imports)
    if (!skipAudio) {
    Promise.all([
      categoriseBook(title, author, plain),
      generateSynopsis(title, author, plain)
    ]).then(async ([categories, synopsis]) => {
      try {
        const findRes = await fetch(SUPABASE_URL + '/rest/v1/summaries?lookup_key=eq.' + encodeURIComponent(saveKey) + '&select=id&limit=1', {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
        });
        const rows = await findRes.json();
        if (rows && rows[0]) {
          const patch = {};
          if (categories && categories.length > 0) patch.categories = JSON.stringify(categories);
          if (synopsis) patch.synopsis = synopsis;
          if (Object.keys(patch).length > 0) {
            await fetch(SUPABASE_URL + '/rest/v1/summaries?id=eq.' + rows[0].id, {
              method: 'PATCH',
              headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
              body: JSON.stringify(patch)
            });
            console.log('Categories + synopsis saved for:', title, categories, synopsis);
          }
        }
      } catch (e) { console.warn('Categories/synopsis save failed:', e.message); }
    }).catch(e => console.warn('Categories/synopsis generation failed:', e.message));
    } else {
      // skipAudio=true — still run categories+synopsis, just skip audio
      categoriseBook(title, author, plain).then(async categories => {
        try {
          const synopsis = await generateSynopsis(title, author, plain);
          const findRes = await fetch(SUPABASE_URL + '/rest/v1/summaries?lookup_key=eq.' + encodeURIComponent(saveKey) + '&select=id&limit=1', {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
          });
          const rows = await findRes.json();
          if (rows && rows[0]) {
            const patch = {};
            if (categories && categories.length > 0) patch.categories = JSON.stringify(categories);
            if (synopsis) patch.synopsis = synopsis;
            if (Object.keys(patch).length > 0) {
              await fetch(SUPABASE_URL + '/rest/v1/summaries?id=eq.' + rows[0].id, {
                method: 'PATCH',
                headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
                body: JSON.stringify(patch)
              });
            }
          }
        } catch(e) { console.warn('Categories/synopsis save failed (skipAudio):', e.message); }
      }).catch(e => console.warn('Categories/synopsis failed (skipAudio):', e.message));
    }

    res.write('data: ' + JSON.stringify({ done: true, html, plain, words, source: 'generated' }) + '\n\n');
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
