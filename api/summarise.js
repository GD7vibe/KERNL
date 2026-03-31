const fetch = require('node-fetch');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { title, author } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Book title is required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const prompt = `You are KERNL, a premium book summarisation service. Write a comprehensive 1500-word summary of "${title}"${author ? ` by ${author}` : ''}.

Format using ONLY <h2> and <p> HTML tags. Start immediately with the first <h2> tag.

Structure:
<h2>The Author & Context</h2>
<h2>The Core Story or Argument</h2>
<h2>Key Themes & Ideas</h2>
<h2>Pivotal Moments or Arguments</h2>
<h2>Legacy & Why It Matters</h2>

Write 1500 words of genuine insight. No preamble.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messa
