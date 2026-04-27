// api/audio.js
// Proxies audio files from Supabase Storage to the browser.
// Solves CORS — browser fetches same-domain /api/audio, 
// server fetches from Supabase, streams back.

const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();

  const { file } = req.query;
  if (!file) return res.status(400).end();

  // Only allow our own audio bucket files
  const filename = decodeURIComponent(file);
  if (filename.includes('..') || filename.includes('/')) {
    return res.status(400).end();
  }

  const supabaseUrl = `${SUPABASE_URL}/storage/v1/object/public/audio/${encodeURIComponent(filename)}`;

  try {
    const upstream = await fetch(supabaseUrl, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });

    if (!upstream.ok) return res.status(upstream.status).end();

    const contentType = upstream.headers.get('content-type') || 'audio/mpeg';
    const contentLength = upstream.headers.get('content-length');

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Accept-Ranges', 'bytes');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    // Stream from Supabase to browser
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    console.error('Audio proxy error:', e.message);
    res.status(502).end();
  }
};
