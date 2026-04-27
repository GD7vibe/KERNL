const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';

function makeAudioKey(title, author, voice) {
  const safe = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
  return `${safe(title)}__${safe(author)}__${voice}.mp3`;
}

async function getCachedUrl(filename) {
  const mp3Res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/info/public/audio/${encodeURIComponent(filename)}`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  if (mp3Res.ok) {
    return `${SUPABASE_URL}/storage/v1/object/public/audio/${encodeURIComponent(filename)}`;
  }
  // WAV fallback for old library books
  const wavFilename = filename.replace(/\.mp3$/, '.wav');
  const wavRes = await fetch(
    `${SUPABASE_URL}/storage/v1/object/info/public/audio/${encodeURIComponent(wavFilename)}`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  if (wavRes.ok) {
    return `${SUPABASE_URL}/storage/v1/object/public/audio/${encodeURIComponent(wavFilename)}`;
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, voice, title, author, cacheOnly } = req.body;
  if (!text && !cacheOnly) return res.status(400).json({ error: 'Text is required' });

  const filename = makeAudioKey(title || 'unknown', author || 'unknown', voice || 'female');

  // Cache check — used by frontend on page load to see if audio is ready
  try {
    const cachedUrl = await getCachedUrl(filename);
    if (cachedUrl) {
      console.log('Cache hit:', filename);
      return res.status(200).json({ url: cachedUrl, source: 'cache' });
    }
  } catch (e) {
    console.warn('Cache check failed:', e.message);
  }

  // If cacheOnly flag set, just report not cached — don't generate
  if (cacheOnly) {
    return res.status(200).json({ cached: false });
  }

  // Should not reach here — generation is handled by tts-stream.js
  return res.status(200).json({ cached: false });
};
