const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';

function makeAudioKey(title, author, voice) {
  const safe = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
  return `${safe(title)}__${safe(author)}__${voice}.mp3`;
}

function makeTimingsKey(title, author, voice) {
  const safe = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
  return `${safe(title)}__${safe(author)}__${voice}`;
}

// ── Supabase Storage: check/get cached audio ──────────────────────────────────
async function getCachedAudioUrl(filename) {
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/info/public/audio/${encodeURIComponent(filename)}`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  if (!res.ok) return null;
  return `${SUPABASE_URL}/storage/v1/object/public/audio/${encodeURIComponent(filename)}`;
}

async function saveAudioToStorage(filename, buffer) {
  const res = await fetch(
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
  if (!res.ok) { console.error('Storage upload failed:', await res.text()); return false; }
  return true;
}

// ── Timings stored in Supabase: audio_timings table ──────────────────────────
async function getTimingsFromDB(key) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/audio_timings?audio_key=eq.${encodeURIComponent(key)}&select=timings&limit=1`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || !data.length || !data[0].timings) return null;
  try { return JSON.parse(data[0].timings); } catch(e) { return null; }
}

async function saveTimingsToDB(key, timings) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/audio_timings`,
    {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({ audio_key: key, timings: JSON.stringify(timings) })
    }
  );
  if (!res.ok) { console.error('Timings save failed:', res.status, await res.text()); }
}

// ── Whisper: get word timestamps from audio buffer ────────────────────────────
async function getWordTimings(audioBuffer, plain) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', audioBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('prompt', plain ? plain.slice(0, 200) : '');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      ...form.getHeaders()
    },
    body: form
  });

  if (!res.ok) throw new Error(`Whisper error: ${await res.text()}`);
  const data = await res.json();
  return data.words || [];
}

// ── Text chunker (14k chars to stay under Grok's 15k limit) ──────────────────
function chunkText(text, maxChars = 14000) {
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > 0) {
    if (remaining.length <= maxChars) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('. ', maxChars);
    if (splitAt === -1) splitAt = remaining.lastIndexOf(' ', maxChars);
    if (splitAt === -1) splitAt = maxChars;
    chunks.push(remaining.slice(0, splitAt + 1).trim());
    remaining = remaining.slice(splitAt + 1).trim();
  }
  return chunks;
}

// ── Grok TTS ──────────────────────────────────────────────────────────────────
async function generateGrokAudio(text, grokVoice) {
  const chunks = chunkText(text);
  console.log(`Grok TTS: ${chunks.length} chunk(s), voice: ${grokVoice}`);

  const audioBuffers = [];
  for (const chunk of chunks) {
    const response = await fetch('https://api.x.ai/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: chunk,
        voice_id: grokVoice,
        language: 'en'
      })
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Grok TTS error: ${err}`);
    }
    audioBuffers.push(Buffer.from(await response.arrayBuffer()));
  }

  return Buffer.concat(audioBuffers);
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, voice, title, author } = req.body;
  if (!text) return res.status(400).json({ error: 'Text is required' });

  // Eve = female, Leo = male
  const grokVoice  = voice === 'male' ? 'leo' : 'eve';
  const filename   = makeAudioKey(title || 'unknown', author || 'unknown', voice || 'female');
  const timingsKey = makeTimingsKey(title || 'unknown', author || 'unknown', voice || 'female');

  // ── Step 1: Check audio cache ─────────────────────────────────────────────
  try {
    const cachedUrl = await getCachedAudioUrl(filename);
    if (cachedUrl) {
      console.log('Audio cache hit:', filename);
      const timings = await getTimingsFromDB(timingsKey);
      return res.status(200).json({ url: cachedUrl, source: 'cache', timings: timings || [] });
    }
  } catch(e) { console.warn('Cache check failed:', e.message); }

  // ── Step 2: Generate audio via Grok TTS ──────────────────────────────────
  try {
    const combined = await generateGrokAudio(text, grokVoice);

    // ── Step 3: Save audio to Supabase Storage ────────────────────────────
    saveAudioToStorage(filename, combined).catch(e => console.warn('Storage save failed:', e.message));

    // ── Step 4: Get word timestamps from Whisper (async, don't block) ─────
    (async () => {
      try {
        console.log('Getting word timings from Whisper for:', filename);
        const timings = await getWordTimings(combined, text);
        if (timings && timings.length > 0) {
          await saveTimingsToDB(timingsKey, timings);
          console.log(`Saved ${timings.length} word timings for ${filename}`);
        }
      } catch(e) {
        console.warn('Whisper timings failed:', e.message);
      }
    })();

    // ── Step 5: Return audio directly ────────────────────────────────────
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', combined.length);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(combined);

  } catch(err) {
    console.error('TTS generation error:', err.message);
    res.status(500).json({ error: err.message || 'TTS generation failed' });
  }
};
