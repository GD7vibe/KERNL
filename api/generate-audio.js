// api/generate-audio.js
// Called by frontend after summary is done
// Generates xAI TTS audio and saves to Supabase Storage
// Returns {ok: true} when audio is ready — frontend unlocks play button

const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';

function makeAudioKey(title, author, voice) {
  const safe = s => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
  return `${safe(title)}__${safe(author)}__${voice}.mp3`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { title, author, plain, voice } = req.body;
  if (!plain) return res.status(400).json({ error: 'plain text required' });

  const xaiVoice = voice === 'male' ? 'leo' : 'eve';
  const filename = makeAudioKey(title || 'unknown', author || 'unknown', voice || 'female');

  try {
    console.log('Generating audio:', filename);

    const ttsRes = await fetch('https://api.x.ai/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: plain, voice_id: xaiVoice, language: 'en' })
    });

    if (!ttsRes.ok) {
      const err = await ttsRes.text();
      console.error('xAI failed:', ttsRes.status, err);
      return res.status(502).json({ ok: false, error: 'xAI TTS failed' });
    }

    const buffer = await ttsRes.arrayBuffer();

    // Try POST first, PUT if file exists
    let uploadRes = await fetch(
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

    if (!uploadRes.ok) {
      uploadRes = await fetch(
        `${SUPABASE_URL}/storage/v1/object/audio/${encodeURIComponent(filename)}`,
        {
          method: 'PUT',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'audio/mpeg',
            'Cache-Control': '3600'
          },
          body: buffer
        }
      );
    }

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      console.error('Supabase upload failed:', err);
      return res.status(502).json({ ok: false, error: 'Upload failed' });
    }

    console.log('Audio saved:', filename);
    return res.status(200).json({ ok: true, filename });

  } catch (e) {
    console.error('generate-audio error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
