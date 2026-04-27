// api/tts-stream.js
// POST {text, voice, title, author}
// Streams MP3 from xAI WebSocket directly to browser.
// Frontend reads response as blob, plays it.
// Saves complete MP3 to Supabase in background for future cache hits.

const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';

function makeAudioKey(title, author, voice) {
  const safe = s => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
  return `${safe(title)}__${safe(author)}__${voice}.mp3`;
}

async function saveAudioToStorage(filename, buffer) {
  try {
    const r = await fetch(
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
    if (!r.ok) console.error('Supabase save failed:', await r.text());
    else console.log('Saved:', filename);
  } catch (e) {
    console.error('Supabase save error:', e.message);
  }
}

module.exports = (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, voice, title, author } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });

  const xaiVoice = voice === 'male' ? 'leo' : 'eve';
  const filename = makeAudioKey(title || 'unknown', author || 'unknown', voice || 'female');

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache');

  const WebSocket = require('ws');
  const wsUrl = `wss://api.x.ai/v1/tts?language=en&voice=${xaiVoice}&codec=mp3&sample_rate=24000`;
  const allChunks = [];

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, {
      headers: { 'Authorization': `Bearer ${process.env.XAI_API_KEY}` }
    });

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'text.delta', delta: text }));
      ws.send(JSON.stringify({ type: 'text.done' }));
    });

    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        if (event.type === 'audio.delta' && event.delta) {
          const chunk = Buffer.from(event.delta, 'base64');
          allChunks.push(chunk);
          try { res.write(chunk); } catch (e) { /* client disconnected */ }
        }
        if (event.type === 'audio.done') {
          res.end();
          ws.close();
          if (allChunks.length > 0) {
            saveAudioToStorage(filename, Buffer.concat(allChunks));
          }
          resolve();
        }
        if (event.type === 'error') {
          console.error('xAI error:', event.message);
          if (!res.headersSent) res.status(500).end();
          resolve();
        }
      } catch (e) { console.warn('WS parse error:', e.message); }
    });

    ws.on('error', (err) => {
      console.error('WS error:', err.message);
      if (!res.headersSent) res.status(502).end();
      resolve();
    });

    ws.on('close', resolve);
  });
};
