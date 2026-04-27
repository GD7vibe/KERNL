const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';

function makeAudioKey(title, author, voice) {
  const safe = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
  return `${safe(title)}__${safe(author)}__${voice}.mp3`;
}

async function getCachedFilename(title, author, voice) {
  // NOTE: info check uses /info/audio/ (no /public/)
  const mp3 = makeAudioKey(title, author, voice);
  const r = await fetch(
    `${SUPABASE_URL}/storage/v1/object/info/audio/${encodeURIComponent(mp3)}`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  if (r.ok) return mp3;
  // WAV fallback for old library books
  const wav = mp3.replace(/\.mp3$/, '.wav');
  const r2 = await fetch(
    `${SUPABASE_URL}/storage/v1/object/info/audio/${encodeURIComponent(wav)}`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  if (r2.ok) return wav;
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { voice, title, author } = req.body;
  try {
    const filename = await getCachedFilename(title || 'unknown', author || 'unknown', voice || 'female');
    if (filename) {
      console.log('Cache hit:', filename);
      // Return proxied URL — same domain, no CORS issues
      return res.status(200).json({
        url: `/api/audio?file=${encodeURIComponent(filename)}`,
        source: 'cache'
      });
    }
  } catch (e) {
    console.warn('Cache check failed:', e.message);
  }
  return res.status(200).json({ cached: false });
};
