// lib/es-translate.js
// English summary -> Latin American Spanish (title, synopsis, text and 21 Spanish Mega Words), saved to summaries_es.
// Shared by api/es-pipeline.js (batch build) and api/summarise.js (a Pro reader asking for a new book).
const K = require('./kernl');

const MODEL = 'claude-sonnet-5-5';
const PRICE_IN = 2 / 1e6, PRICE_OUT = 10 / 1e6;      // USD per token, standard (non-batch) rates

async function englishById(id) {
  const r = await K.sb('/rest/v1/summaries?select=id,title,author,html,plain,words,synopsis,categories&id=eq.' + encodeURIComponent(id) + '&limit=1');
  return r.ok && Array.isArray(r.data) && r.data[0] ? r.data[0] : null;
}
async function spanishById(id) {
  const r = await K.sb('/rest/v1/' + K.SUMMARIES_TABLE + '?select=id,title,author,title_en,html,plain,words,synopsis,categories&id=eq.' + encodeURIComponent(id) + '&limit=1');
  return r.ok && Array.isArray(r.data) && r.data[0] ? r.data[0] : null;
}

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


module.exports = { translate, parseTranslation, englishById, spanishById, htmlToPlain };
