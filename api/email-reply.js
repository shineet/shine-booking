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
      const textMatch = rawEmail.match(/Content-Type: text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\r?\nContent-Type)/);
      if (textMatch) {
        emailBody = textMatch[1].trim();
      } else {
        const headerEnd = rawEmail.indexOf('\r\n\r\n') || rawEmail.indexOf('\n\n');
        if (headerEnd > -1) {
          emailBody = rawEmail.substring(headerEnd).trim().substring(0, 1000);
        }
      }
    }

    if (!emailBody) {
      emailBody = `Client sent an email with subject: ${subject}`;
    }

    // Look up client in Supabase by email
    let client = null;
    const fromEmail = from.match(/<(.+)>/)?.[1] || from;
    const clientRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/clients?email=eq.${encodeURIComponent(fromEmail)}&order=created_at.desc&limit=1`,
      {
        headers: {
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
        }
      }
    );
    const clients = await clientRes.json();
    client = clients[0] || null;

    // Build pricing info and link
    let pricingContext = '';
    let pricingLink = '';
    if (client) {
      const isCorporate = (client.event_type || '').toLowerCase().includes('corporate');
      const eventTypeParam = isCorporate ? 'corporate' : 'private';
      const prices = client.pricing_type === 'custom' ? {
        deluxe: client.custom_price_deluxe || (isCorporate ? 1000 : 400),
        signature: client.custom_price_signature || (isCorporate ? 1200 : 500),
        premium: client.custom_price_premium || (isCorporate ? 1500 : 600)
      } : {
        deluxe: isCorporate ? 1000 : 400,
        signature: isCorporate ? 1200 : 500,
        premium: isCorporate ? 1500 : 600
      };

      // Build pricing link with correct params
      if (client.pricing_type === 'custom') {
        pricingLink = `https://shine-booking.vercel.app/pricing.html?type=${eventTypeParam}&d1=${prices.deluxe}&d2=${prices.signature}&d3=${prices.premium}`;
      } else {
        pricingLink = `https://shine-booking.vercel.app/pricing.html?type=${eventTypeParam}`;
      }

      pricingContext = `
Client: ${client.name}
Event type: ${client.event_type}
Pricing packages:
- Deluxe: $${prices.deluxe}
- Signature: $${prices.signature}
- Premium: $${prices.premium}
Pricing link: ${pricingLink}`;
    } else {
      // Unknown client â€” send generic link
      pricingLink = 'https://shine-booking.vercel.app/pricing.html';
    }

    const SYSTEM_PROMPT = `You are Shine Thankappan, The Mentalist â€” writing emails personally as yourself in first person.

IMPORTANT: Always write as "I" â€” never say "Shine will" or refer to yourself in third person. Never say "Shine offers" â€” say "I offer".
${pricingContext}

About me:
- I perform 45-60 minute interactive mentalism and magic shows in Texas
- Payment: Cash, Zelle (2020shine@gmail.com), Venmo (@Shine-Thankappan), PayPal (shine_e_thankappan@yahoo.com)
- Website: www.texasmentalist.com
- Phone: +1 (612) 865-7681

Rules:
- Write in first person always
- Be warm and conversational, not salesy
- Keep replies concise â€” 2-3 short paragraphs
- If asked about pricing, write a warm reply and include the pricing link EXACTLY as provided: ${pricingLink}
  Say something like "Here's a link to my packages and pricing: ${pricingLink}" â€” include the full URL
  Then add [PRICING_SENT] at the very end of your reply
- If client says "yes lets book", "I want to book", "send the contract" â€” reply saying you will send over the contract shortly, then add [BOOKING_INTENT] at the very end
- Never make up availability

Signature:
Shine, The Mentalist
+1 (612) 865-7681
www.texasmentalist.com`;

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
    const pricingSent = replyText.includes('[PRICING_SENT]');
    const cleanReply = replyText.replace('[BOOKING_INTENT]', '').replace('[PRICING_SENT]', '').trim();

    // Send reply email
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_KEY}`
      },
      body: JSON.stringify({
        from: 'Shine, The Mentalist <shine@texasmentalist.com>',
        to: fromEmail,
        subject: subject?.startsWith('Re:') ? subject : `Re: ${subject || 'Your inquiry'}`,
        text: cleanReply
      })
    });

    // Update client status in Supabase
    if (client) {
      let newStatus = 'chatting';
      if (pricingSent) newStatus = 'pricing_sent';
      if (bookingIntent) newStatus = 'booked';

      const updateData = {
        status: newStatus,
        last_activity: new Date().toISOString()
      };
      // Save the pricing link sent so dashboard can show it
      if (pricingSent) updateData.notes = `Pricing link sent: ${pricingLink}`;

      await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${client.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
        },
        body: JSON.stringify(updateData)
      });

      // Save messages
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
        },
        body: JSON.stringify([
          { client_id: client.id, channel: 'email', direction: 'inbound', content: emailBody, status: 'received' },
          { client_id: client.id, channel: 'email', direction: 'outbound', content: cleanReply, status: 'sent' }
        ])
      });
    }

    // Notify you if pricing sent or booking intent
    if (pricingSent || bookingIntent) {
      const notifSubject = bookingIntent
        ? `ðŸŽ¯ ${client?.name || fromEmail} wants to book!`
        : `ðŸ“‹ Pricing sent to ${client?.name || fromEmail}`;

      const notifText = bookingIntent
        ? `Client is ready to book!\n\nFrom: ${fromEmail}\nName: ${client?.name}\nEvent: ${client?.event_type}\n\nLog in to send the contract:\nshine-booking.vercel.app`
        : `Pricing link was sent to client!\n\nFrom: ${fromEmail}\nName: ${client?.name}\nEvent: ${client?.event_type}\nPricing type: ${client?.pricing_type}\n\nLink sent: ${pricingLink}\n\nshine-booking.vercel.app`;

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.RESEND_KEY}`
        },
        body: JSON.stringify({
          from: 'Shine Booking Assistant <shine@texasmentalist.com>',
          to: '2020shine@gmail.com',
          subject: notifSubject,
          text: notifText
        })
      });
    }

    res.status(200).json({ received: true, replied: true, bookingIntent, pricingSent, pricingLink });

  } catch(e) {
    console.error('Email reply error:', e);
    res.status(200).json({ received: true, error: e.message });
  }
}
