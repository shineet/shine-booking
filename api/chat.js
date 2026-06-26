function normalizePhone(phone) {
  if (!phone) return phone;
  // Strip everything except digits and leading +
  var digits = phone.replace(/[^\d]/g, '');
  // If 10 digits, add +1
  if (digits.length === 10) return '+1' + digits;
  // If 11 digits starting with 1, add +
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  // Already has +, return cleaned
  if (phone.trim().startsWith('+')) return '+' + digits;
  return phone;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const mode = req.query.mode || 'default';

  // ── Compose mode (free-form send) ─────────────────────────────────────────
  if (req.body.action === 'compose') {
    try {
      const { clientId, channel, toPhone, toEmail, subject, body } = req.body;
      if (channel === 'sms' && toPhone) {
        const twilioAuth = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64');
        const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${twilioAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ From: process.env.TWILIO_FROM, To: normalizePhone(toPhone), Body: body }).toString()
        });
        const d = await r.json();
        if (d.status === 'failed' || d.error_code) throw new Error(d.message || 'SMS failed');
      } else if (channel === 'email' && toEmail) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
          body: JSON.stringify({ from: 'Shine, The Mentalist <shine@texasmentalist.com>', to: toEmail, subject: subject || 'Message from Shine, The Mentalist', text: body })
        });
      }
      if (clientId) {
        const now = new Date().toISOString();
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${clientId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
          body: JSON.stringify({ last_activity: now })
        });
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
          body: JSON.stringify({ client_id: clientId, channel, direction: 'outbound', content: body, status: 'sent', created_at: now })
        });
      }
      return res.status(200).json({ success: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (mode === 'pricing') {
    try {
      const { clientId, clientName, phone, email, lastChannel, pricingLink } = req.body;
      const message = `Hi! Here are my show packages and pricing: ${pricingLink} — Shine, The Mentalist`;
      const emailText = `Hi ${clientName},\n\nHere's a link to my packages and pricing — you can view all three options and what's included:\n\n${pricingLink}\n\nFeel free to reach out if you have any questions!\n\nShine, The Mentalist\n+1 (612) 865-7681\nwww.texasmentalist.com`;
      let sent = false;
      const channel = lastChannel || (phone ? 'sms' : 'email');
      // Send via SMS if that's the channel they used
      if (channel === 'sms' && phone) {
        const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`;
        const twilioAuth = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64');
        const twilioRes = await fetch(twilioUrl, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${twilioAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ From: process.env.TWILIO_FROM, To: normalizePhone(phone), Body: message }).toString()
        });
        const twilioData = await twilioRes.json();
        if (!twilioData.error_code) sent = true;
      }
      // Send via email if that's the channel they used
      if (channel === 'email' && email) {
        const resendRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
          body: JSON.stringify({
            from: 'Shine, The Mentalist <shine@texasmentalist.com>',
            to: email,
            subject: 'My show packages & pricing',
            text: emailText
          })
        });
        const resendData = await resendRes.json();
        if (resendData.id) sent = true;
      }
      // Update Supabase status
      if (clientId) {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${clientId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_SECRET_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
          },
          body: JSON.stringify({
            status: 'pricing_sent',
            notes: `Pricing link sent: ${pricingLink}`,
            last_activity: new Date().toISOString()
          })
        });
      }
      res.status(200).json({ sent, channel, pricingLink });
    } catch(e) {
      console.error('Send pricing error:', e);
      res.status(500).json({ error: e.message });
    }
    return;
  }

  // Default mode: generate AI first-contact messages, send them, and create the client record
  try {
    const { toPhone, toEmail, clientName, eventType, venue, otherEntertainment, pricingType, prices, leadSource, eventDate, guests, smsOverride, emailOverride, existingClientId, ...claudeBody } = req.body;

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
        To: normalizePhone(toPhone),
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
      const clientPayload = {
        name: clientName,
        phone: toPhone || null,
        email: toEmail || null,
        event_type: eventType,
        venue: venue || null,
        other_entertainment: otherEntertainment || null,
        lead_source: leadSource || null,
        event_date: eventDate || null,
        guests: guests || null,
        pricing_type: pricingType || 'standard',
        custom_price_deluxe: prices?.deluxe || null,
        custom_price_signature: prices?.signature || null,
        custom_price_premium: prices?.premium || null,
        last_activity: new Date().toISOString()
      };

      if (existingClientId) {
        // Update the existing record (e.g. messaging a previously-saved lead for the first time)
        // rather than creating a duplicate. Status moves on from 'new' since first contact is happening now.
        clientPayload.status = 'chatting';
        const updateRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${existingClientId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_SECRET_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
            'Prefer': 'return=representation'
          },
          body: JSON.stringify(clientPayload)
        });
        const updateData = await updateRes.json();
        if (updateData[0]?.id) clientId = updateData[0].id;
      } else {
        clientPayload.status = 'new';
        const supabaseRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_SECRET_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
            'Prefer': 'return=representation'
          },
          body: JSON.stringify(clientPayload)
        });
        const supabaseData = await supabaseRes.json();
        if (supabaseData[0]?.id) clientId = supabaseData[0].id;
      }

      if (clientId) {
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
