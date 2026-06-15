export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const payload = req.body;

    // Extract email details from Resend webhook
    const fromEmail = payload.from || '';
    const fromName = payload.headers?.['from'] || fromEmail;
    const subject = payload.subject || '';
    const body = payload.text || payload.html?.replace(/<[^>]*>/g, '') || '';
    const toEmail = fromEmail;

    if (!fromEmail || !body) {
      res.status(200).json({ received: true });
      return;
    }

    // Don't reply to your own emails or notifications
    if (fromEmail.includes('texasmentalist.com') || 
        fromEmail.includes('2020shine@gmail.com') ||
        fromEmail.includes('resend.com')) {
      res.status(200).json({ received: true });
      return;
    }

    const SYSTEM_PROMPT = `You are a booking assistant for Shine, The Mentalist — a professional mentalism and magic show performer in Texas.

Shine performs 45-60 minute interactive mentalism and magic shows.
Pricing: Private events (birthdays, bachelorette, celebrations) start at $400. Corporate events start at $800.
Payment: Cash, Zelle (2020shine@gmail.com), Venmo (@Shine-Thankappan), PayPal (shine_e_thankappan@yahoo.com)
Website: www.texasmentalist.com
Phone: +1 (612) 865-7681

You are handling email conversations with potential clients. Be warm, professional, and helpful.

Rules:
- Answer pricing questions honestly
- If asked about availability, say you will check and confirm shortly
- Keep responses concise but friendly — 2-3 short paragraphs max
- Do NOT ask about date or number of guests — they already provided that on Bark
- If the client says something like "yes lets book", "I want to book", "lets confirm", "send the contract" — reply saying you will send over the contract shortly, then add [BOOKING_INTENT] at the very end of your response
- Always sign off with:
  Shine, The Mentalist
  +1 (612) 865-7681
  www.texasmentalist.com`;

    // Call Claude to write the reply
    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Client email:\nFrom: ${fromEmail}\nSubject: ${subject}\n\n${body}`
        }]
      })
    });

    const claudeData = await claudeResponse.json();
    if (claudeData.error) throw new Error(claudeData.error.message);

    const replyText = claudeData.content[0].text;
    const bookingIntent = replyText.includes('[BOOKING_INTENT]');
    const cleanReply = replyText.replace('[BOOKING_INTENT]', '').trim();

    // Send email reply via Resend
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_KEY}`
      },
      body: JSON.stringify({
        from: 'Shine, The Mentalist <shine@texasmentalist.com>',
        to: toEmail,
        subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
        text: cleanReply
      })
    });

    // If booking intent — notify you
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
          subject: `🎯 Booking intent from ${fromEmail}`,
          text: `A client wants to book!\n\nFrom: ${fromEmail}\nSubject: ${subject}\n\nTheir message:\n${body}\n\nYour reply:\n${cleanReply}\n\nLog into your booking app to send the contract:\nshine-booking.vercel.app`
        })
      });
    }

    res.status(200).json({ received: true, replied: true, bookingIntent });

  } catch(e) {
    console.error('Email reply error:', e);
    res.status(200).json({ received: true, error: e.message });
  }
}
