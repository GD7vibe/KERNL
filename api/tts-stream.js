const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';

// In-memory token store: token -> {text, voice, title, author, expires}
const tokenStore = new Map();

function makeAudioKey(title, author, voice) {
  const safe = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
  return `${safe(title)}__${safe(author)}__${voice}.mp3`;
}

async function saveAudioToStorage(filename, buffer) {
  try {
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
    if (!res.ok) console.error('Supabase upload failed:', await res.text());
    else console.log('Saved to Supabase:', filename);
  } catch (e) {
    console.error('Supabase save error:', e.message);
  }
}

module.exports = async (req, res) => {

  // ── POST: register text, get back a short-lived token ──────────────────────
  // Frontend calls this first, gets a token, then sets audio.src = GET?token=...
  if (req.method === 'POST') {
    const { text, voice, title, author } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });

    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    tokenStore.set(token, {
      text, voice: voice || 'female', title: title || '', author: author || '',
      expires: Date.now() + 5 * 60 * 1000 // 5 minutes
    });

    // Clean up expired tokens
    for (const [k, v] of tokenStore.entries()) {
      if (v.expires < Date.now()) tokenStore.delete(k);
    }

    return res.status(200).json({ token });
  }

  // ── GET: stream audio using token ──────────────────────────────────────────
  // <audio src="/api/tts-stream?token=xyz"> — browser plays as chunks arrive
  if (req.method === 'GET') {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const data = tokenStore.get(token);
    if (!data || data.expires < Date.now()) {
      tokenStore.delete(token);
      return res.status(410).json({ error: 'Token expired or invalid' });
    }
    tokenStore.delete(token); // one-use

    const { text, voice, title, author } = data;
    const xaiVoice = voice === 'male' ? 'leo' : 'eve';
    const filename = makeAudioKey(title, author, voice);

    // Stream headers — force browser to start playing immediately
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache');

    const WebSocket = require('ws');
    const wsUrl = `wss://api.x.ai/v1/tts?language=en&voice=${xaiVoice}&codec=mp3&sample_rate=24000`;
    const allChunks = [];

    // Return the Promise directly (Gemini's suggestion) so Vercel keeps the
    // function alive and flushes chunks to the client as they arrive
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
            // Save to Supabase after browser has already started playing
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
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
