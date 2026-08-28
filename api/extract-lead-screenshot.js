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
        text: `You are looking at one or more screenshots of a client inquiry for booking a mentalist/magician performer. Read every message bubble, label, and header visible in every image carefully — don't skim or summarize prematurely; extract from the full text actually present.

Extract whatever you can find across all the images and combine it into a single JSON object with these exact fields:
{"name": "...", "phone": "...", "email": "...", "event_type": "...", "event_date": "...", "guests": "...", "venue": "...", "lead_source": "...", "budget_mentioned": "...", "budget_advice": "...", "notes": "..."}

Rules:
- event_type should be one of: "Birthday party", "Bachelorette party", "Bachelor party", "Corporate event", "Graduation", "Baby Shower", "Private celebration", "Anniversary", "Other" — pick the closest match, or "Other" if unclear.
- event_date should be in YYYY-MM-DD format if a specific date is visible, otherwise null.
- lead_source: identify WHICH platform this screenshot is actually from, using visible branding, logos, URLs, app chrome, or wording — do not assume. Return one of "Bark", "GigSalad", "TheBash", "Website", "Referral", or, if it's a different platform/app/text thread, the actual platform name you can read (e.g. "Instagram", "WhatsApp"). If you truly cannot tell which platform it is, use null — never default to any platform as a guess.
- budget_mentioned: if the client states or implies a specific budget, price, or dollar amount anywhere in the messages, extract it verbatim (e.g. "$750", "around $500-800", "under $1000"). null if no budget/price is mentioned anywhere.
- budget_advice: ONLY when budget_mentioned is not null, write ONE short, concrete sentence advising Shine (the performer) how to approach that specific number — talking TO Shine, not drafting a client-facing reply. Compare the stated budget against his real floors for the matching event_type: Bachelorette parties — floor $500 (only worth going that low if the vibe/crowd sounds energetic and fun), aim for $1000+. Birthday parties — floor $750. Weddings — minimum $2000. Corporate events — minimum $2500. For any other event_type, there is no fixed floor on record, so just note whether the number sounds low for a professional mentalist/magician and suggest asking about their full range before quoting, without inventing a specific dollar floor. If the stated budget is at or above the relevant floor, say so plainly and suggest anchoring toward the higher end rather than assuming the floor is the target. If budget_mentioned is null, set budget_advice to null too.
- If a field isn't visible in any image, use null for it — never guess or invent a value.
- notes can include any other relevant details visible (event description, special requests, etc.) as a short plain-text summary. Do NOT put the budget in notes — it has its own field above.
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
        model: 'claude-sonnet-5',
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
