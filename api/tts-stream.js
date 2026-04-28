const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';

function makeAudioKey(title, author, voice) {
  const safe = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
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
    else console.log('Saved to cache:', filename);
  } catch (e) {
    console.error('Supabase save error:', e.message);
  }
}

async function storeToken(token, text, voice, title, author) {
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/tts_tokens`,
    {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ id: token, text, voice, title, author, expires_at: expiresAt })
    }
  );
  if (!r.ok) throw new Error('Failed to store token: ' + await r.text());
}

async function fetchToken(token) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/tts_tokens?id=eq.${encodeURIComponent(token)}&expires_at=gt.${new Date().toISOString()}&select=*`,
    {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    }
  );
  if (!r.ok) return null;
  const rows = await r.json();
  return rows && rows.length > 0 ? rows[0] : null;
}

async function deleteToken(token) {
  await fetch(
    `${SUPABASE_URL}/rest/v1/tts_tokens?id=eq.${encodeURIComponent(token)}`,
    {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    }
  );
}

module.exports = async (req, res) => {

  // ── POST: store text in Supabase, return short token ─────────────────────
  if (req.method === 'POST') {
    const { text, voice, title, author } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });

    const token = 'tts_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

    try {
      await storeToken(token, text, voice || 'female', title || 'unknown', author || 'unknown');
      return res.status(200).json({ token });
    } catch (e) {
      console.error('Token store error:', e.message);
      return res.status(500).json({ error: 'Failed to create token' });
    }
  }

  // ── GET: look up token, stream audio from xAI ─────────────────────────────
  if (req.method === 'GET') {
    const { token } = req.query;
    if (!token) return res.status(400).end('Token required');

    let data;
    try {
      data = await fetchToken(token);
    } catch (e) {
      return res.status(500).end('Token lookup failed');
    }

    if (!data) return res.status(404).end('Invalid or expired token');

    // Delete token immediately — one use only
    deleteToken(token); // intentionally not awaited

    const { text, voice, title, author } = data;
    const xaiVoice = voice === 'male' ? 'leo' : 'eve';
    const filename = makeAudioKey(title, author, voice);

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

      ws.on('message', (rawData) => {
        try {
          const event = JSON.parse(rawData.toString());
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
  }

  return res.status(405).end();
};
