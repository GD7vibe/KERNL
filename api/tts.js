module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text, voice } = req.body;
  if (!text) return res.status(400).json({ error: 'Text is required' });

  // Map our voice names to OpenAI voice IDs
  const voiceMap = { female: 'nova', male: 'onyx' };
  const openaiVoice = voiceMap[voice] || 'nova';

  // OpenAI TTS has a 4096 character limit per request — chunk if needed
  const MAX_CHARS = 4000;
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > 0) {
    if (remaining.length <= MAX_CHARS) {
      chunks.push(remaining);
      break;
    }
    // Split at a sentence boundary before the limit
    let splitAt = remaining.lastIndexOf('. ', MAX_CHARS);
    if (splitAt === -1) splitAt = remaining.lastIndexOf(' ', MAX_CHARS);
    if (splitAt === -1) splitAt = MAX_CHARS;
    chunks.push(remaining.slice(0, splitAt + 1).trim());
    remaining = remaining.slice(splitAt + 1).trim();
  }

  try {
    // Fetch all chunks in parallel
    const audioBuffers = await Promise.all(chunks.map(async (chunk) => {
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

      return Buffer.from(await response.arrayBuffer());
    }));

    // Concatenate all MP3 buffers
    const combined = Buffer.concat(audioBuffers);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', combined.length);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(combined);

  } catch (err) {
    console.error('TTS error:', err.message);
    res.status(500).json({ error: err.message || 'TTS generation failed' });
  }
};
