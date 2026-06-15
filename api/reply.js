export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const payload = req.body;
    const data = payload.data || payload;

    const fromEmail = data.from || '';
    const subject = data.subject || 'Your inquiry';
    const emailId = data.email_id || '';
    let body = data.text || data.html?.replace(/<[^>]*>/g, '') || '';

    if (!fromEmail) {
      res.status(200).json({ received: true });
      return;
    }

    // Don't reply to your own emails
    if (fromEmail.includes('texasmentalist.com') ||
        fromEmail.includes('2020shine@gmail.com') ||
        fromEmail.includes('resend.com')) {
      res.status(200).json({ received: true, skipped: 'own email' });
      return;
    }

    // If no body, fetch full email from Resend API
    if (!body && emailId) {
      const emailResponse = await fetch(`https://api.resend.com/emails/${emailId}`, {
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_KEY}`
        }
      });
      const emailData = await emailResponse.json();
      body = emailData.text || emailData.html?.replace(/<[^>]*>/g, '') || '';
    }

    // If still no body use subject as context
    if (!body) {
      body = `Client sent an email with subject: ${subject}`;
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
- Keep responses concise — 2-3 short paragraphs max
- Do NOT ask about date or number of guests
- If the client says something like "yes lets book", "I want to book", "lets confirm", "send the contract" — reply saying you will send over the contract shortly, then add [BOOKING_INTENT] at the very end
- Always sign off with:
  Shine, The Mentalist
  +1 (612) 865-7681
  www.texasmentalist.com`;

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

    // Send reply email
    const resendReply = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_KEY}`
      },
      body: JSON.stringify({
        from: 'Shine, The Mentalist <shine@texasmentalist.com>',
        to: fromEmail,
        subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
        text: cleanReply
      })
    });

    const resendData = await resendReply.json();

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
          text: `A client wants to book!\n\nFrom: ${fromEmail}\nSubject: ${subject}\n\nTheir message:\n${body}\n\nYour reply:\n${cleanReply}\n\nLog in to send the contract:\nshine-booking.vercel.app`
        })
      });
    }

    res.status(200).json({ received: true, replied: true, bookingIntent, resendId: resendData.id });

  } catch(e) {
    console.error('Email reply error:', e);
    res.status(200).json({ received: true, error: e.message });
  }
}
