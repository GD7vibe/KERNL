const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';

function makeAudioKey(title, author, voice) {
  const safe = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
  return `${safe(title)}__${safe(author)}__${voice}.mp3`;
}

// Simple FNV-32 hash — consistent across all files, no crypto module needed
function fnv32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function plainHash(plain) {
  // Normalise whitespace before hashing so minor formatting differences don't cause false mismatches
  return fnv32(String(plain || '').replace(/\s+/g, ' ').trim());
}

async function getAudioMeta(audioKey) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/audio_meta?audio_key=eq.${encodeURIComponent(audioKey)}&select=plain_hash&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    return rows && rows.length > 0 ? rows[0] : null;
  } catch (e) {
    console.warn('[tts] getAudioMeta failed:', e.message);
    return null;
  }
}

async function getCurrentPlain(title, author) {
  try {
    const norm = s => String(s || '').toLowerCase().trim();
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/summaries?title=ilike.${encodeURIComponent('%' + norm(title) + '%')}&select=plain,title,author&limit=10`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    if (!rows || !rows.length) return null;
    // Pick closest title match
    const normT = norm(title);
    const match = rows.find(r => norm(r.title) === normT) || rows[0];
    return match.plain || null;
  } catch (e) {
    console.warn('[tts] getCurrentPlain failed:', e.message);
    return null;
  }
}

async function logSyncError(title, author, voice, errorType, detail) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/sync_errors`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ title, author, voice, error_type: errorType, detail, resolved: false })
    });
  } catch (e) {
    console.warn('[tts] logSyncError failed:', e.message);
  }
}

// Grok fix: use /info/audio/ not /info/public/audio/
async function getCachedUrl(filename) {
  const mp3Res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/info/audio/${encodeURIComponent(filename)}`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  if (mp3Res.ok) return `${SUPABASE_URL}/storage/v1/object/public/audio/${encodeURIComponent(filename)}`;
  // WAV fallback for old library books
  const wavFilename = filename.replace(/\.mp3$/, '.wav');
  const wavRes = await fetch(
    `${SUPABASE_URL}/storage/v1/object/info/audio/${encodeURIComponent(wavFilename)}`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  if (wavRes.ok) return `${SUPABASE_URL}/storage/v1/object/public/audio/${encodeURIComponent(wavFilename)}`;
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { voice, title, author } = req.body;
  const filename = makeAudioKey(title || 'unknown', author || 'unknown', voice || 'female');

  try {
    const cachedUrl = await getCachedUrl(filename);
    if (cachedUrl) {
      // Check if audio matches current summary text
      const [meta, currentPlain] = await Promise.all([
        getAudioMeta(filename),
        getCurrentPlain(title, author)
      ]);

      if (meta && currentPlain) {
        const currentHash = plainHash(currentPlain);
        if (meta.plain_hash !== currentHash) {
          // Hashes differ — audio is stale, log and force fresh generation
          console.warn('[tts] Hash mismatch for:', filename, '| stored:', meta.plain_hash, '| current:', currentHash);
          await logSyncError(title, author, voice || 'female', 'hash_mismatch',
            `Audio hash ${meta.plain_hash} does not match current summary hash ${currentHash}. Audio key: ${filename}`
          );
          return res.status(200).json({ cached: false, reason: 'hash_mismatch' });
        }
      } else if (!meta && currentPlain) {
        // Audio exists in Storage but has no audio_meta row — legacy file, no hash on record
        // Serve it but log so we know it needs a meta row
        console.log('[tts] Cache hit (no meta row — legacy):', filename);
        await logSyncError(title, author, voice || 'female', 'missing_meta',
          `Audio file exists in Storage but has no audio_meta row. Key: ${filename}. Served from cache but hash integrity unverified.`
        );
        return res.status(200).json({ url: cachedUrl, source: 'cache' });
      }

      console.log('[tts] Cache hit (verified):', filename);
      return res.status(200).json({ url: cachedUrl, source: 'cache' });
    }
  } catch (e) {
    console.warn('[tts] Cache check failed:', e.message);
  }

  return res.status(200).json({ cached: false });
};
