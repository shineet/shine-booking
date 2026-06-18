export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { images } = req.body; // array of { data: base64string, mediaType: 'image/png' etc }

    if (!images || !Array.isArray(images) || images.length === 0) {
      res.status(400).json({ error: 'No images provided' });
      return;
    }
    if (images.length > 4) {
      res.status(400).json({ error: 'Too many images — please upload at most 4 at a time' });
      return;
    }

    const content = [
      {
        type: 'text',
        text: `You are looking at one or more screenshots from a lead-generation platform (such as Bark, GigSalad, or TheBash) showing a client inquiry for booking a mentalist/magician performer.

Extract whatever you can find across all the images and combine it into a single JSON object with these exact fields:
{"name": "...", "phone": "...", "email": "...", "event_type": "...", "event_date": "...", "guests": "...", "venue": "...", "notes": "..."}

Rules:
- event_type should be one of: "Birthday party", "Bachelorette party", "Bachelor party", "Corporate event", "Graduation", "Baby Shower", "Private celebration", "Anniversary", "Other" — pick the closest match, or "Other" if unclear.
- event_date should be in YYYY-MM-DD format if a specific date is visible, otherwise null.
- If a field isn't visible in any image, use null for it — never guess or invent a value.
- notes can include any other relevant details visible (event description, special requests, budget mentioned, etc.) as a short plain-text summary.
- Respond with ONLY the JSON object, no other text, no markdown formatting, no code fences.`
      }
    ];

    for (const img of images) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType || 'image/png', data: img.data }
      });
    }

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        messages: [{ role: 'user', content }]
      })
    });

    const claudeData = await claudeResponse.json();
    if (claudeData.error) {
      console.error('Claude API error during screenshot extraction:', claudeData.error);
      res.status(502).json({ error: 'Extraction failed: ' + claudeData.error.message });
      return;
    }
    if (!claudeData.content || !claudeData.content[0] || !claudeData.content[0].text) {
      console.error('Unexpected Claude response shape:', JSON.stringify(claudeData).substring(0, 2000));
      res.status(502).json({ error: 'Extraction returned an unexpected response' });
      return;
    }

    const rawText = claudeData.content[0].text.trim();
    const cleanText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let extracted;
    try {
      extracted = JSON.parse(cleanText);
    } catch (parseErr) {
      console.error('Failed to parse extraction JSON:', parseErr.message, cleanText.substring(0, 500));
      res.status(502).json({ error: 'Could not parse extracted details — try again or enter manually' });
      return;
    }

    res.status(200).json({ extracted });

  } catch (e) {
    console.error('Screenshot extraction error:', e);
    res.status(500).json({ error: e.message });
  }
}
