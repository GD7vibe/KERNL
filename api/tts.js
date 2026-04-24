const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';

function makeAudioKey(title, author, voice) {
  const safe = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
  return `${safe(title)}__${safe(author)}__${voice}.wav`;
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

async function saveAudioToStorage(filename, buffer, contentType) {
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/audio/${encodeURIComponent(filename)}`,
    {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': contentType,
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

function pcmToWav(pcmChunks, sampleRate) {
  const pcmLength = pcmChunks.reduce((s, c) => s + c.length, 0);
  const wavBuffer = Buffer.alloc(44 + pcmLength);
  wavBuffer.write('RIFF', 0);
  wavBuffer.writeUInt32LE(36 + pcmLength, 4);
  wavBuffer.write('WAVE', 8);
  wavBuffer.write('fmt ', 12);
  wavBuffer.writeUInt32LE(16, 16);
  wavBuffer.writeUInt16LE(1, 20);
  wavBuffer.writeUInt16LE(1, 22);
  wavBuffer.writeUInt32LE(sampleRate, 24);
  wavBuffer.writeUInt32LE(sampleRate * 2, 28);
  wavBuffer.writeUInt16LE(2, 32);
  wavBuffer.writeUInt16LE(16, 34);
  wavBuffer.write('data', 36);
  wavBuffer.writeUInt32LE(pcmLength, 40);
  let offset = 44;
  for (const chunk of pcmChunks) { chunk.copy(wavBuffer, offset); offset += chunk.length; }
  return wavBuffer;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, voice, title, author } = req.body;
  if (!text) return res.status(400).json({ error: 'Text is required' });

  const grokVoice  = voice === 'male' ? 'leo' : 'eve';
  const filename   = makeAudioKey(title || 'unknown', author || 'unknown', voice || 'female');
  const timingsKey = makeTimingsKey(title || 'unknown', author || 'unknown', voice || 'female');
  const SAMPLE_RATE = 24000;

  // Check audio cache
  try {
    const cachedUrl = await getCachedAudioUrl(filename);
    if (cachedUrl) {
      console.log('Audio cache hit:', filename);
      const timings = await getTimingsFromDB(timingsKey);
      return res.status(200).json({ url: cachedUrl, source: 'cache', timings: timings || [] });
    }
  } catch(e) { console.warn('Cache check failed:', e.message); }

  // Stream via xAI WebSocket using PCM codec (works on all browsers including iOS/Android)
  try {
    const WebSocket = require('ws');
    const wsUrl = `wss://api.x.ai/v1/tts?language=en&voice=${grokVoice}&codec=pcm&sample_rate=${SAMPLE_RATE}`;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const allPcmChunks = [];
    let browserConnected = true;
    res.on('close', () => {
      browserConnected = false;
      console.log('Browser disconnected -- continuing to completion for caching');
    });

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: { 'Authorization': `Bearer ${process.env.XAI_API_KEY}` }
      });

      ws.on('open', () => {
        console.log('xAI WebSocket open, streaming PCM...');
        ws.send(JSON.stringify({ type: 'text.delta', delta: text }));
        ws.send(JSON.stringify({ type: 'text.done' }));
      });

      // async handler so we can await the Supabase save before signalling done
      ws.on('message', async (data) => {
        try {
          const event = JSON.parse(data.toString());

          if (event.type === 'audio.delta' && event.delta) {
            const pcmBuf = Buffer.from(event.delta, 'base64');
            allPcmChunks.push(pcmBuf);
            if (browserConnected) {
              try {
                res.write(`data: ${JSON.stringify({ pcm: event.delta, sampleRate: SAMPLE_RATE })}\n\n`);
              } catch(e) { browserConnected = false; }
            }
          }

          if (event.type === 'audio.done') {
            console.log('xAI audio.done received -- saving WAV to Supabase before signalling browser');
            ws.close();

            // Save WAV to Supabase FIRST -- controls unlock only after this completes
            if (allPcmChunks.length > 0) {
              try {
                const wavBuf = pcmToWav(allPcmChunks, SAMPLE_RATE);
                await saveAudioToStorage(filename, wavBuf, 'audio/wav');
                console.log('WAV saved to Supabase:', filename);
              } catch(e) {
                // Non-fatal: log and continue so the browser still unlocks
                console.warn('WAV save failed:', e.message);
              }
            }

            // NOW tell the browser everything is done -- unlocks controls
            if (browserConnected) {
              try {
                res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
                res.end();
              } catch(e) {}
            }

            resolve();
          }

          if (event.type === 'error') {
            console.error('xAI error:', event.message);
            reject(new Error(event.message));
          }
        } catch(e) { console.warn('WS parse error:', e.message); }
      });

      ws.on('error', (err) => { reject(err); });
      ws.on('close', () => { resolve(); });
    });

  } catch(err) {
    console.error('TTS error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'TTS generation failed' });
    } else {
      try { res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`); res.end(); } catch(e) {}
    }
  }
};
