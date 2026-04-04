const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';

// Make a safe filename from title, author and voice
function makeAudioKey(title, author, voice) {
  const safe = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
  return `${safe(title)}__${safe(author)}__${voice}.mp3`;
}

// Check if audio already exists in Supabase Storage
async function getCachedAudioUrl(filename) {
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/info/public/audio/${encodeURIComponent(filename)}`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  if (!res.ok) return null;
  return `${SUPABASE_URL}/storage/v1/object/public/audio/${encodeURIComponent(filename)}`;
}

// Upload MP3 buffer to Supabase Storage
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
  if (!res.ok) {
    const err = await res.text();
    console.error('Supabase Storage upload failed:', err);
    return false;
  }
  return true;
}

// Split text into chunks at sentence boundaries under the OpenAI 4096 char limit
function chunkText(text, maxChars = 4000) {
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('. ', maxChars);
    if (splitAt === -1) splitAt = remaining.lastIndexOf(' ', maxChars);
    if (splitAt === -1) splitAt = maxChars;
    chunks.push(remaining.slice(0, splitAt + 1).trim());
    remaining = remaining.slice(splitAt + 1).trim();
  }
  return chunks;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text, voice, title, author } = req.body;
  if (!text) return res.status(400).json({ error: 'Text is required' });

  const openaiVoice = voice === 'male' ? 'onyx' : 'nova';
  const filename = makeAudioKey(title || 'unknown', author || 'unknown', voice || 'female');

  // Step 1 — check cache first
  try {
    const cachedUrl = await getCachedAudioUrl(filename);
    if (cachedUrl) {
      console.log('Audio cache hit:', filename);
      return res.status(200).json({ url: cachedUrl, source: 'cache' });
    }
  } catch (e) {
    console.warn('Cache check failed:', e.message);
  }

  // Step 2 — generate full audio from OpenAI, chunking as needed
  try {
    const chunks = chunkText(text);
    console.log(`Generating audio: ${chunks.length} chunk(s) for ${filename}`);

    // Fetch chunks sequentially to avoid hammering OpenAI rate limits
    const audioBuffers = [];
    for (const chunk of chunks) {
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'tts-1',
          input: chunk,
          voice: openaiVoice,
          response_format: 'mp3'
        })
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenAI TTS error: ${err}`);
      }

      audioBuffers.push(Buffer.from(await response.arrayBuffer()));
    }

    // Combine all chunks into one MP3 buffer
    const combined = Buffer.concat(audioBuffers);

    // Step 3 — save to Supabase Storage (fire and forget — don't block the response)
    saveAudioToStorage(filename, combined).catch(e => console.warn('Storage save failed:', e.message));

    // Step 4 — return the audio directly this first time
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', combined.length);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(combined);

  } catch (err) {
    console.error('TTS generation error:', err.message);
    res.status(500).json({ error: err.message || 'TTS generation failed' });
  }
};
