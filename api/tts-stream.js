// api/tts-stream.js
// Chrome path: WebSocket to xAI, MP3 chunks streamed to the browser as SSE while they are generated.
// The finished MP3 is saved to Storage with its audio_meta hash so every later play is a cache hit.
// POST { title, author, voice }
//   -> SSE  data:{mp3:<base64>} ... data:{done:true}
//   -> or JSON { cached:true, url } if the audio already exists (client should just play the URL)
//
// The text comes from the library row, never the browser, so a caller cannot make us
// pay to narrate arbitrary text or overwrite a book's audio with something else.
const WebSocket = require('ws');
const K = require('../lib/kernl');

const MAX_CHARS = 120000;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.XAI_API_KEY) return res.status(500).json({ error: 'Server is not configured' });

  const body = req.body || {};
  const voice = K.normVoice(body.voice);
  const title = K.cleanText(body.title, 300);
  const author = K.cleanText(body.author, 300);
  if (!title) return res.status(400).json({ error: 'title required' });

  let book, filename, keys;
  try {
    const ctx = await K.authenticate(req);
    book = await K.findBook(title, author);
    if (!book || !book.plain) return res.status(404).json({ error: 'Summary not found' });

    const access = await K.authoriseAudioRead(ctx, book);
    if (!access.ok) return K.fail(res, access);

    keys = K.audioKeyCandidates(book, title, author, voice);
    filename = keys[0];

    const hit = await K.findCachedAudio(keys);
    if (hit) {
      const st = await K.audioStatus(hit.filename, book.plain);
      if (st.state !== 'stale') return res.status(200).json({ cached: true, url: hit.url });
    }

    if (K.isIncomplete(book.plain, book.html)) {
      return res.status(422).json({ code: 'incomplete_text', error: 'This summary looks incomplete, so no audio was made. It needs regenerating first.' });
    }

    // Cache miss from here on. Generating new audio costs money: Pro and admin only.
    // (Checked after the in-flight wait below so a free user can still pick up a file a Pro user just made.)
    const pending0 = K.inflight.get(filename);
    if (!pending0 && !K.canGenerateAudio(ctx)) {
      return res.status(403).json({ code: 'pro_required', error: 'Audio generation is a Pro feature.' });
    }

    // A generate-audio call for the same file is already running on this instance: wait, then serve it.
    const pending = K.inflight.get(filename);
    if (pending) {
      try { await pending; } catch (e) { /* fall through to stream it ourselves */ }
      const again = await K.findCachedAudio(keys);
      if (again) return res.status(200).json({ cached: true, url: again.url });
      if (!K.canGenerateAudio(ctx)) return res.status(403).json({ code: 'pro_required', error: 'Audio generation is a Pro feature.' });
    }

    const who = ctx && ctx.user ? ctx.user.id : K.clientIp(req);
    if (!(ctx && ctx.admin) && K.rateLimited('gen:' + who, 12, 60 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many audio requests. Try again later.' });
    }
  } catch (e) {
    console.error('[tts-stream] setup failed:', e.message);
    return res.status(e.status || 500).json({ error: e.message });
  }

  const text = book.plain.slice(0, MAX_CHARS);
  console.log('[tts-stream] streaming:', filename, 'chars:', text.length);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const wsUrl = 'wss://api.x.ai/v1/tts?language=en&voice=' + (voice === 'male' ? 'leo' : 'eve') + '&codec=mp3&sample_rate=24000';
  const allChunks = [];
  let browserConnected = true;
  res.on('close', () => { browserConnected = false; });

  const job = new Promise((resolve) => {
    let finished = false;
    const finish = () => { if (!finished) { finished = true; resolve(); } };

    const ws = new WebSocket(wsUrl, { headers: { Authorization: 'Bearer ' + process.env.XAI_API_KEY } });

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'text.delta', delta: text }));
      ws.send(JSON.stringify({ type: 'text.done' }));
    });

    ws.on('message', async (data) => {
      try {
        const event = JSON.parse(data.toString());

        if (event.type === 'audio.delta' && event.delta) {
          allChunks.push(Buffer.from(event.delta, 'base64'));
          if (browserConnected) {
            try { res.write('data: ' + JSON.stringify({ mp3: event.delta }) + '\n\n'); } catch (e) { browserConnected = false; }
          }
        }

        if (event.type === 'audio.done') {
          if (browserConnected) {
            try { res.write('data: ' + JSON.stringify({ done: true }) + '\n\n'); res.end(); } catch (e) { /* closed */ }
          }
          try { ws.close(); } catch (e) { /* already closed */ }
          if (allChunks.length > 0 && await K.uploadAudio(filename, Buffer.concat(allChunks))) {
            await K.saveAudioMeta(book, voice, filename, book.plain);
          }
          finish();
        }

        if (event.type === 'error') {
          console.error('[tts-stream] xAI error:', event.message);
          if (!res.headersSent) res.status(502).json({ error: 'TTS provider error' });
          else if (browserConnected) { try { res.end(); } catch (e) { /* closed */ } }
          finish();
        }
      } catch (e) { console.warn('[tts-stream] parse error:', e.message); }
    });

    ws.on('error', (err) => {
      console.error('[tts-stream] WS error:', err.message);
      if (!res.headersSent) res.status(502).json({ error: 'TTS provider unreachable' });
      else if (browserConnected) { try { res.end(); } catch (e) { /* closed */ } }
      finish();
    });

    ws.on('close', finish);
  });

  K.inflight.set(filename, job);
  return job;
};
