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

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, voice, title, author } = req.body;
  if (!text) return res.status(400).json({ error: 'Text is required' });

  const grokVoice  = voice === 'male' ? 'leo' : 'eve';
  const filename   = makeAudioKey(title || 'unknown', author || 'unknown', voice || 'female');
  const timingsKey = makeTimingsKey(title || 'unknown', author || 'unknown', voice || 'female');

  // ── Step 1: Check audio cache — return URL instantly if cached ────────────
  try {
    const cachedUrl = await getCachedAudioUrl(filename);
    if (cachedUrl) {
      console.log('Audio cache hit:', filename);
      const timings = await getTimingsFromDB(timingsKey);
      return res.status(200).json({ url: cachedUrl, source: 'cache', timings: timings || [] });
    }
  } catch(e) { console.warn('Cache check failed:', e.message); }

  // ── Step 2: Stream audio via xAI WebSocket ────────────────────────────────
  try {
    const WebSocket = require('ws');

    const wsUrl = `wss://api.x.ai/v1/tts?language=en&voice=${grokVoice}&codec=mp3&sample_rate=24000&bit_rate=128000`;

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: { 'Authorization': `Bearer ${process.env.XAI_API_KEY}` }
      });

      // Set up SSE response headers so browser receives chunks immediately
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const allChunks = [];
      let headersSent = false;

      ws.on('open', () => {
        console.log('xAI WebSocket open, sending text...');
        // Send full text as one delta then signal done
        ws.send(JSON.stringify({ type: 'text.delta', delta: text }));
        ws.send(JSON.stringify({ type: 'text.done' }));
      });

      ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());

          if (event.type === 'audio.delta' && event.delta) {
            // Forward base64 chunk to browser via SSE
            if (!headersSent) headersSent = true;
            res.write(`data: ${JSON.stringify({ audio: event.delta })}\n\n`);
            allChunks.push(Buffer.from(event.delta, 'base64'));
          }

          if (event.type === 'audio.done') {
            console.log('xAI audio.done received');
            // Signal completion to browser
            res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
            res.end();
            ws.close();

            // Save full audio to Supabase in background
            if (allChunks.length > 0) {
              const combined = Buffer.concat(allChunks);
              saveAudioToStorage(filename, combined).catch(e => console.warn('Storage save failed:', e.message));
            }

            resolve();
          }

          if (event.type === 'error') {
            console.error('xAI WebSocket error event:', event.message);
            reject(new Error(event.message));
          }

        } catch(e) {
          console.warn('WS message parse error:', e.message);
        }
      });

      ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
        reject(err);
      });

      ws.on('close', (code, reason) => {
        console.log('WebSocket closed:', code, reason.toString());
        resolve();
      });
    });

  } catch(err) {
    console.error('TTS generation error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'TTS generation failed' });
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
};
