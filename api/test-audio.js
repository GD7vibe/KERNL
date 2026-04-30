// api/test-audio.js - TEMPORARY TEST ENDPOINT - DELETE AFTER USE
// Tests: 1) xAI REST API works 2) Supabase storage upload works

const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';

module.exports = async (req, res) => {
  const results = {};

  // Step 1: Call xAI REST API with short text
  try {
    const xaiRes = await fetch('https://api.x.ai/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: 'Hello. This is a test of the KERNL audio system.',
        voice_id: 'eve',
        language: 'en'
      })
    });

    results.xai_status = xaiRes.status;
    results.xai_ok = xaiRes.ok;
    results.xai_content_type = xaiRes.headers.get('content-type');

    if (!xaiRes.ok) {
      results.xai_error = await xaiRes.text();
    } else {
      const buffer = await xaiRes.arrayBuffer();
      results.xai_bytes = buffer.byteLength;

      // Step 2: Upload to Supabase
      const filename = 'test_audio_kernl_test.mp3';
      const uploadRes = await fetch(
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

      results.supabase_status = uploadRes.status;
      results.supabase_ok = uploadRes.ok;

      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        results.supabase_error = errText;

        // Try PUT if POST fails (file exists)
        const putRes = await fetch(
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
        results.supabase_put_status = putRes.status;
        results.supabase_put_ok = putRes.ok;
        if (!putRes.ok) results.supabase_put_error = await putRes.text();
      }

      // Step 3: Verify file is accessible
      const checkRes = await fetch(
        `${SUPABASE_URL}/storage/v1/object/info/audio/${encodeURIComponent(filename)}`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      results.verify_status = checkRes.status;
      results.verify_found = checkRes.ok;
    }
  } catch (e) {
    results.error = e.message;
  }

  res.status(200).json(results);
};
