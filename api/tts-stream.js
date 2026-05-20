// api/tts-stream.js
// Chrome path: WebSocket to xAI, stream MP3 chunks progressively to browser
// Browser plays via Web Audio API as chunks arrive (~1s to first audio)
// After streaming, saves complete MP3 to Supabase for future cache hits
// Also writes audio_meta row so hash integrity can be verified on future plays
const WebSocket = require('ws');
const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';

function makeAudioKey(title, author, voice) {
  const safe = s => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
  return `${safe(title)}__${safe(author)}__${voice}.mp3`;
}

// Simple FNV-32 hash — must match implementation in tts.js
function fnv32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function plainHash(plain) {
  return fnv32(String(plain || '').replace(/\s+/g, ' ').trim());
}

async function saveAudioToStorage(filename, buffer) {
  try {
    let res = await fetch(
      `${SUPABASE_URL}/storage/v1/object/audio/${encodeURIComponent(filename)}`,
      { method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'audio/mpeg', 'Cache-Control': '3600' }, body: buffer }
    );
    if (!res.ok) {
      res = await fetch(
        `${SUPABASE_URL}/storage/v1/object/audio/${encodeURIComponent(filename)}`,
        { method: 'PUT', headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'audio/mpeg', 'Cache-Control': '3600' }, body: buffer }
      );
    }
    if (res.ok) console.log('[tts-stream] Saved to Supabase:', filename);
    else console.error('[tts-stream] Supabase save failed:', res.status);
    return res.ok;
  } catch (e) {
    console.error('[tts-stream] Supabase save error:', e.message);
    return false;
  }
}

async function saveAudioMeta(title, author, voice, audioKey, plain) {
  try {
    const hash = plainHash(plain);
    // Upsert — if a row already exists for this audio_key, update the hash
    const res = await fetch(`${SUPABASE_URL}/rest/v1/audio_meta`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({ title, author, voice, audio_key: audioKey, plain_hash: hash })
    });
    if (res.ok) console.log('[tts-stream] audio_meta saved for:', audioKey, '| hash:', hash);
    else console.error('[tts-stream] audio_meta save failed:', res.status, await res.text());
  } catch (e) {
    console.error('[tts-stream] audio_meta save error:', e.message);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { text, voice, title, author } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });
  const xaiVoice = voice === 'male' ? 'leo' : 'eve';
  const filename = makeAudioKey(title || 'unknown', author || 'unknown', voice || 'female');
  console.log('[tts-stream] Starting WebSocket stream for:', filename);

  // SSE headers — stream MP3 chunks as base64 events to frontend
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const wsUrl = `wss://api.x.ai/v1/tts?language=en&voice=${xaiVoice}&codec=mp3&sample_rate=24000`;
  const allChunks = [];
  let browserConnected = true;

  res.on('close', () => {
    browserConnected = false;
    console.log('[tts-stream] Browser disconnected — continuing for cache');
  });

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, {
      headers: { 'Authorization': `Bearer ${process.env.XAI_API_KEY}` }
    });

    ws.on('open', () => {
      console.log('[tts-stream] WS open, sending text length:', text.length);
      ws.send(JSON.stringify({ type: 'text.delta', delta: text }));
      ws.send(JSON.stringify({ type: 'text.done' }));
    });

    ws.on('message', async (data) => {
      try {
        const event = JSON.parse(data.toString());

        if (event.type === 'audio.delta' && event.delta) {
          const chunk = Buffer.from(event.delta, 'base64');
          allChunks.push(chunk);
          if (browserConnected) {
            try {
              res.write(`data: ${JSON.stringify({ mp3: event.delta })}\n\n`);
            } catch (e) { browserConnected = false; }
          }
        }

        if (event.type === 'audio.done') {
          console.log('[tts-stream] Audio done, chunks:', allChunks.length);
          if (browserConnected) {
            try {
              res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
              res.end();
            } catch (e) {}
          }
          ws.close();

          // Save audio to Supabase Storage, then write audio_meta row
          if (allChunks.length > 0) {
            const saved = await saveAudioToStorage(filename, Buffer.concat(allChunks));
            if (saved) {
              await saveAudioMeta(title || 'unknown', author || 'unknown', voice || 'female', filename, text);
            }
          }
          resolve();
        }

        if (event.type === 'error') {
          console.error('[tts-stream] xAI error:', event.message);
          if (!res.headersSent) res.status(500).end();
          resolve();
        }
      } catch (e) { console.warn('[tts-stream] parse error:', e.message); }
    });

    ws.on('error', (err) => {
      console.error('[tts-stream] WS error:', err.message);
      if (!res.headersSent) res.status(502).end();
      resolve();
    });

    ws.on('close', resolve);
  });
};
