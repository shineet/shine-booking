export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    // Extract toPhone separately — don't send it to Claude
    const { toPhone, ...claudeBody } = req.body;

    // Step 1: Claude writes the message
    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(claudeBody)
    });
    const claudeData = await claudeResponse.json();
    if (claudeData.error) throw new Error(claudeData.error.message);
    const message = claudeData.content[0].text;

    // Step 2: Twilio sends the SMS if phone provided
    if (toPhone) {
      const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`;
      const twilioAuth = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64');
      const smsBody = new URLSearchParams({
        From: process.env.TWILIO_FROM,
        To: toPhone,
        Body: message
      });
      const twilioResponse = await fetch(twilioUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${twilioAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: smsBody.toString()
      });
      const twilioData = await twilioResponse.json();
      if (twilioData.error_code) throw new Error(`Twilio: ${twilioData.message}`);
    }

    res.status(200).json({ ...claudeData, smsSent: !!toPhone, message });

  } catch(e) {
    res.status(500).json({ error: { message: e.message } });
  }
}
