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

    if (from.includes('texasmentalist.com') ||
        from.includes('shinethementalist@gmail.com') ||
        from.includes('2020shine@gmail.com') ||
        from.includes('resend.com') ||
        from.includes('noreply')) {
      res.status(200).json({ received: true, skipped: 'own email' });
      return;
    }

    let emailBody = body || '';
    if (!emailBody && rawEmail) {
      const textMatch = rawEmail.match(/Content-Type: text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\r?\nContent-Type)/);
      if (textMatch) {
        emailBody = textMatch[1].trim();
      } else {
        const headerEnd = rawEmail.indexOf('\r\n\r\n') || rawEmail.indexOf('\n\n');
        if (headerEnd > -1) emailBody = rawEmail.substring(headerEnd).trim().substring(0, 1000);
      }
    }
    if (!emailBody) emailBody = `Client sent an email with subject: ${subject}`;

    const fromEmail = from.match(/<(.+)>/)?.[1] || from;

    // Look up client in Supabase — failure safe
    let client = null;
    try {
      const clientRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/clients?email=eq.${encodeURIComponent(fromEmail)}&order=created_at.desc&limit=1`,
        { headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` } }
      );
      const clients = await clientRes.json();
      client = Array.isArray(clients) ? (clients[0] || null) : null;
    } catch(e) {
      console.error('Supabase lookup failed:', e.message);
    }

    const SYSTEM_PROMPT = `You are Shine Thankappan, The Mentalist — writing emails personally as yourself in first person.

IMPORTANT: Always write as "I" — never say "Shine will" or refer to yourself in third person.

About me:
- I perform 45-60 minute interactive mentalism and magic shows in Texas
- Payment: Cash, Zelle (2020shine@gmail.com), Venmo (@Shine-Thankappan), PayPal (shine_e_thankappan@yahoo.com)
- Website: www.texasmentalist.com
- Phone: +1 (612) 865-7681

Rules:
- Write in first person always
- Be warm and conversational, not salesy
- Keep replies concise — 2-3 short paragraphs
- If asked about pricing, reply warmly saying you have three packages to suit different needs and will send the full details right away. Do NOT include any link or prices. Then add [PRICING_REQUESTED] at the very end
- If client says "yes lets book", "I want to book", "send the contract" — reply saying you will send over the contract shortly, then add [BOOKING_INTENT] at the very end
- Never make up availability

Signature:
Shine, The Mentalist
+1 (612) 865-7681
www.texasmentalist.com`;

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Client email:\nFrom: ${from}\nSubject: ${subject}\n\n${emailBody}` }]
      })
    });

    const claudeData = await claudeResponse.json();
    if (claudeData.error) throw new Error(claudeData.error.message);

    const replyText = claudeData.content[0].text;
    const bookingIntent = replyText.includes('[BOOKING_INTENT]');
    const pricingRequested = replyText.includes('[PRICING_REQUESTED]');
    const cleanReply = replyText.replace('[BOOKING_INTENT]', '').replace('[PRICING_REQUESTED]', '').trim();

    // Send reply email
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
      body: JSON.stringify({
        from: 'Shine, The Mentalist <shine@texasmentalist.com>',
        to: fromEmail,
        subject: subject?.startsWith('Re:') ? subject : `Re: ${subject || 'Your inquiry'}`,
        text: cleanReply
      })
    });

    // Update Supabase — failure safe
    if (client) {
      try {
        let newStatus = 'chatting';
        if (pricingRequested) newStatus = 'pricing_requested';
        if (bookingIntent) newStatus = 'booked';

        await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${client.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
          body: JSON.stringify({ status: newStatus, last_activity: new Date().toISOString(), last_channel: 'email' })
        });

        await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
          body: JSON.stringify([
            { client_id: client.id, channel: 'email', direction: 'inbound', content: emailBody, status: 'received' },
            { client_id: client.id, channel: 'email', direction: 'outbound', content: cleanReply, status: 'sent' }
          ])
        });
      } catch(e) {
        console.error('Supabase update failed:', e.message);
      }
    }

    // Notify you if pricing requested or booking intent
    if (pricingRequested || bookingIntent) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
          body: JSON.stringify({
            from: 'Shine Booking Assistant <shine@texasmentalist.com>',
            to: 'shinethementalist@gmail.com',
            subject: bookingIntent ? `🎯 ${client?.name || fromEmail} wants to book!` : `💰 ${client?.name || fromEmail} is asking about pricing`,
            text: bookingIntent
              ? `Client is ready to book!\n\nFrom: ${fromEmail}\nName: ${client?.name}\nEvent: ${client?.event_type}\n\nLog in to send the contract:\nshine-booking.vercel.app`
              : `Client is asking about pricing!\n\nFrom: ${fromEmail}\nName: ${client?.name}\nEvent: ${client?.event_type}\n\nOpen the app to send their pricing:\nshine-booking.vercel.app`
          })
        });
      } catch(e) {
        console.error('Notification failed:', e.message);
      }
    }

    res.status(200).json({ received: true, replied: true, bookingIntent, pricingRequested });

  } catch(e) {
    console.error('Email reply error:', e);
    res.status(200).json({ received: true, error: e.message });
  }
}
