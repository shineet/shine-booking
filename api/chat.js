export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const { toPhone, toEmail, clientName, eventType, venue, otherEntertainment, pricingType, prices, smsOverride, emailOverride, ...claudeBody } = req.body;

    // Step 1: Claude writes SMS (or use override)
    let smsMessage = smsOverride;
    if (!smsMessage) {
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
      smsMessage = claudeData.content[0].text;
    }

    // Step 2: Claude writes email (or use override)
    let emailSubject = '';
    let emailBody = '';

    if (emailOverride) {
      const lines = emailOverride.split('\n');
      emailSubject = lines[0].replace('Subject:', '').trim();
      emailBody = lines.slice(2).join('\n').trim();
    } else {
      const emailPrompt = `Write a warm, professional first contact email for this Bark lead:
Name: ${clientName}
Event: ${eventType}

Rules:
- Write as Shine, The Mentalist in first person — never say "Shine will" or refer to yourself in third person
- Friendly and personal, use their first name
- 2-3 short paragraphs
- Mention you do 45-60 min interactive mentalism and magic shows
- Tell them you'd love to be part of their ${eventType}
- Ask ONE natural question about their venue or what kind of atmosphere they're going for
- Do NOT ask about date, number of guests, or pricing
- Signature must be exactly:
  Shine, The Mentalist
  +1 (612) 865-7681
  www.texasmentalist.com
- First line must be: Subject: [subject line]
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
      emailSubject = emailLines[0].replace('Subject:', '').trim();
      emailBody = emailLines.slice(2).join('\n').trim();
    }

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
          from: 'Shine, The Mentalist <shine@texasmentalist.com>',
          to: toEmail,
          subject: emailSubject,
          text: emailBody
        })
      });
      const resendData = await resendResponse.json();
      if (resendData.id) emailSent = true;
    }

    // Step 5: Save client to Supabase
    let clientId = null;
    if (toPhone || toEmail) {
      const supabaseRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          name: clientName,
          phone: toPhone || null,
          email: toEmail || null,
          event_type: eventType,
          venue: venue || null,
          other_entertainment: otherEntertainment || null,
          pricing_type: pricingType || 'standard',
          custom_price_deluxe: prices?.deluxe || null,
          custom_price_signature: prices?.signature || null,
          custom_price_premium: prices?.premium || null,
          status: 'new',
          last_activity: new Date().toISOString()
        })
      });
      const supabaseData = await supabaseRes.json();
      if (supabaseData[0]?.id) {
        clientId = supabaseData[0].id;

        // Save outbound message to messages table
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_SECRET_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
          },
          body: JSON.stringify({
            client_id: clientId,
            channel: 'sms',
            direction: 'outbound',
            content: smsMessage,
            status: smsSent ? 'sent' : 'failed'
          })
        });
      }
    }

    res.status(200).json({ smsMessage, emailSubject, emailBody, smsSent, emailSent, clientId });

  } catch(e) {
    res.status(500).json({ error: { message: e.message } });
  }
}
