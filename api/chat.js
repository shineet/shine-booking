export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const { toPhone, toEmail, clientName, eventType, ...claudeBody } = req.body;

    // Step 1: Claude writes the SMS
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
    const smsMessage = claudeData.content[0].text;

    // Step 2: Claude writes the email
    const emailPrompt = `Write a warm, professional booking inquiry email for this Bark lead:
Name: ${clientName}
Event: ${eventType}

Rules:
- Friendly and personal tone
- 3-4 short paragraphs
- Introduce yourself as Shine, The Mentalist
- Mention you do 45-60 min interactive mentalism and magic shows
- Ask about their event details
- Do NOT mention pricing yet
- Sign off as "Shine, The Mentalist"
- Subject line on first line as "Subject: ..."
- Then blank line
- Then email body`;

    const emailResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{ role: 'user', content: emailPrompt }]
      })
    });
    const emailData = await emailResponse.json();
    const emailFull = emailData.content[0].text;
    const emailLines = emailFull.split('\n');
    const subjectLine = emailLines[0].replace('Subject: ', '').trim();
    const emailBody = emailLines.slice(2).join('\n').trim();

    // Step 3: Send SMS via Twilio
    let smsSent = false;
    if (toPhone) {
      const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`;
      const twilioAuth = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64');
      const smsBody = new URLSearchParams({
        From: process.env.TWILIO_FROM,
        To: toPhone,
        Body: smsMessage
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
      if (!twilioData.error_code) smsSent = true;
    }

    // Step 4: Send email via Resend
    let emailSent = false;
    if (toEmail) {
      const resendResponse = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.RESEND_KEY}`
        },
        body: JSON.stringify({
          from: 'Shine, The Mentalist <onboarding@resend.dev>',
          to: toEmail,
          subject: subjectLine,
          text: emailBody
        })
      });
      const resendData = await resendResponse.json();
      if (resendData.id) emailSent = true;
    }

    res.status(200).json({
      message: smsMessage,
      emailBody,
      subjectLine,
      smsSent,
      emailSent
    });

  } catch(e) {
    res.status(500).json({ error: { message: e.message } });
  }
}
