const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';

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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, voice, title, author } = req.body;
  if (!text) return res.status(400).json({ error: 'Text is required' });

  const xaiVoice = voice === 'male' ? 'leo' : 'eve';
  const filename = makeAudioKey(title || 'unknown', author || 'unknown', voice || 'female');

  // Stream MP3 from xAI WebSocket to browser response.
  // Browser reads full response into arrayBuffer, creates blob, plays it.
  // Simultaneously saves complete MP3 to Supabase — next play is instant cache hit.
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Transfer-Encoding', 'chunked');

  const WebSocket = require('ws');
  const wsUrl = `wss://api.x.ai/v1/tts?language=en&voice=${xaiVoice}&codec=mp3&sample_rate=24000`;
  const allChunks = [];

  try {
    await new Promise((resolve, reject) => {
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
          if (event.type === 'audio.done') { ws.close(); resolve(); }
          if (event.type === 'error') reject(new Error(event.message));
        } catch (e) { console.warn('WS parse error:', e.message); }
      });

      ws.on('error', reject);
      ws.on('close', resolve);
    });
  } catch (err) {
    console.error('TTS stream error:', err.message);
    if (!res.headersSent) return res.status(502).json({ error: 'Stream failed' });
  }

  res.end();

  // Save to Supabase in background -- next play will be instant cache hit
  if (allChunks.length > 0) {
    saveAudioToStorage(filename, Buffer.concat(allChunks));
  }
};
