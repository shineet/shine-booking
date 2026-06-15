export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');
    return;
  }

  try {
    const { From, Body } = req.body;

    if (!From || !Body) {
      res.setHeader('Content-Type', 'text/xml');
      res.status(200).send('<Response></Response>');
      return;
    }

    const SYSTEM_PROMPT = `You are a booking assistant for Shine, The Mentalist — a professional mentalism and magic show performer in Texas.

Shine performs 45-60 minute interactive mentalism and magic shows.
Pricing: Private events (birthdays, bachelorette, celebrations) start at $400. Corporate events start at $800.
Payment: Cash, Zelle (2020shine@gmail.com), Venmo (@Shine-Thankappan), PayPal (shine_e_thankappan@yahoo.com)
Website: www.texasmentalist.com
Phone: +1 (612) 865-7681

You are handling SMS conversations with potential clients. Be warm, professional, and concise (under 160 characters per message).

Rules:
- Answer pricing questions honestly
- If asked about availability, say you will check and confirm shortly
- Never make promises about specific dates without confirmation
- If the client says something like "yes lets book", "I want to book", "lets do it", "sounds good lets confirm" — respond with ONE final message saying you will send over the contract details, then add the tag [BOOKING_INTENT] at the very end
- Keep responses short and conversational for SMS
- Sign off as "- Shine"`;

    // Call Claude
    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Client texted: ${Body}` }]
      })
    });

    const claudeData = await claudeResponse.json();
    if (claudeData.error) throw new Error(claudeData.error.message);

    const replyText = claudeData.content[0].text;
    const bookingIntent = replyText.includes('[BOOKING_INTENT]');
    const cleanReply = replyText.replace('[BOOKING_INTENT]', '').trim();

    // Send SMS reply via Twilio
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`;
    const twilioAuth = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64');
    const smsBody = new URLSearchParams({
      From: process.env.TWILIO_FROM,
      To: From,
      Body: cleanReply
    });

    await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${twilioAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: smsBody.toString()
    });

    // If booking intent — notify you by email
    if (bookingIntent) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.RESEND_KEY}`
        },
        body: JSON.stringify({
          from: 'Shine Booking Assistant <shine@texasmentalist.com>',
          to: '2020shine@gmail.com',
          subject: `Booking intent detected from ${From}`,
          text: `A client is ready to book!\n\nPhone: ${From}\nTheir message: ${Body}\n\nLog into your booking app to confirm and send the contract.\n\nshine-booking.vercel.app`
        })
      });
    }

    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');

  } catch(e) {
    console.error('Reply error:', e);
    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');
  }
}
