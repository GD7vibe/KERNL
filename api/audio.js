// api/audio.js
// Same-origin proxy for audio files in the public "audio" bucket (avoids CORS for Web Audio).
// GET/HEAD /api/audio?file=<name>.mp3
// The bucket is public, so no key is sent upstream.
const K = require('../lib/kernl');

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();

  const { file } = req.query;
  if (!file) return res.status(400).end();

  const filename = String(file);
  if (!/^[a-z0-9_]+\.(mp3|wav)$/.test(filename)) return res.status(400).end();

  try {
    const upstream = await fetch(K.publicAudioUrl(filename), { method: req.method });
    if (!upstream.ok) return res.status(upstream.status).end();

    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    if (req.method === 'HEAD') return res.end();

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
