const Anthropic = require('@anthropic-ai/sdk');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { title, author } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `Write a comprehensive 1,500-word summary of the book "${title}"${author ? ` by ${author}` : ''}. 

Structure it with clear sections using HTML formatting:
- Opening paragraph introducing the book and its significance
- 4-6 sections with <h2> headings covering key themes, arguments, and insights
- Each section should be 2-3 substantial paragraphs
- A closing section on legacy/impact

Format rules:
- Use <h2> for section headings
- Use <p> tags for paragraphs
- No <html>, <body>, or <head> tags
- Write in an engaging, intelligent tone
- Aim for exactly 1,500 words

After the HTML, on a new line write: PLAINTEXT_START
Then write the entire summary as plain text with no HTML tags.`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content[0].text;
    const splitIdx = raw.indexOf('PLAINTEXT_START');
    const html = splitIdx > -1 ? raw.slice(0, splitIdx).trim() : raw;
    const plain = splitIdx > -1 ? raw.slice(splitIdx + 15).trim() : raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    res.status(200).json({ html, plain });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to generate summary' });
  }
};
