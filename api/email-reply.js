export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { from, to, subject, body, rawEmail } = req.body;

    if (!from) {
      res.status(200).json({ received: true });
      return;
    }

    // Don't reply to your own emails
    if (from.includes('texasmentalist.com') ||
        from.includes('2020shine@gmail.com') ||
        from.includes('resend.com') ||
        from.includes('noreply')) {
      res.status(200).json({ received: true, skipped: 'own email' });
      return;
    }

    // Extract readable text from raw email if body is empty
    let emailBody = body || '';
    if (!emailBody && rawEmail) {
      // Try to extract plain text from raw email
      const textMatch = rawEmail.match(/Content-Type: text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\r?\nContent-Type)/);
      if (textMatch) {
        emailBody = textMatch[1].trim();
      } else {
        // Just use everything after the headers
        const headerEnd = rawEmail.indexOf('\r\n\r\n') || rawEmail.indexOf('\n\n');
        if (headerEnd > -1) {
          emailBody = rawEmail.substring(headerEnd).trim().substring(0, 1000);
        }
      }
    }

    if (!emailBody) {
      emailBody = `Client sent an email with subject: ${subject}`;
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
          content: `Client email:\nFrom: ${from}\nSubject: ${subject}\n\n${emailBody}`
        }]
      })
    });

    const claudeData = await claudeResponse.json();
    if (claudeData.error) throw new Error(claudeData.error.message);

    const replyText = claudeData.content[0].text;
    const bookingIntent = replyText.includes('[BOOKING_INTENT]');
    const cleanReply = replyText.replace('[BOOKING_INTENT]', '').trim();

    // Send reply email via Resend
    const resendReply = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_KEY}`
      },
      body: JSON.stringify({
        from: 'Shine, The Mentalist <shine@texasmentalist.com>',
        to: from,
        subject: subject?.startsWith('Re:') ? subject : `Re: ${subject || 'Your inquiry'}`,
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
          subject: `🎯 Booking intent from ${from}`,
          text: `A client wants to book!\n\nFrom: ${from}\nSubject: ${subject}\n\nTheir message:\n${emailBody}\n\nYour reply:\n${cleanReply}\n\nLog in to send the contract:\nshine-booking.vercel.app`
        })
      });
    }

    res.status(200).json({ 
      received: true, 
      replied: true, 
      bookingIntent,
      resendId: resendData.id 
    });

  } catch(e) {
    console.error('Email reply error:', e);
    res.status(200).json({ received: true, error: e.message });
  }
}
