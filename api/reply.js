const conversations = {};

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

    // Look up client in Supabase by phone number
    const clientRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/clients?phone=eq.${encodeURIComponent(From)}&order=created_at.desc&limit=1`,
      {
        headers: {
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
        }
      }
    );
    const clients = await clientRes.json();
    const client = clients[0] || null;

    // Build pricing link
    let pricingLink = 'https://shine-booking.vercel.app/pricing.html';
    let pricingContext = '';
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

      if (client.pricing_type === 'custom') {
        pricingLink = `https://shine-booking.vercel.app/pricing.html?type=${eventTypeParam}&d1=${prices.deluxe}&d2=${prices.signature}&d3=${prices.premium}`;
      } else {
        pricingLink = `https://shine-booking.vercel.app/pricing.html?type=${eventTypeParam}`;
      }

      pricingContext = `
Client: ${client.name}
Event type: ${client.event_type}
Pricing link: ${pricingLink}`;
    }

    const SYSTEM_PROMPT = `You are Shine Thankappan, The Mentalist â€” writing SMS messages personally as yourself in first person.

IMPORTANT: Always write as "I" â€” never say "Shine will" or refer to yourself in third person.

About me:
- I perform 45-60 minute interactive mentalism and magic shows in Texas
- Website: www.texasmentalist.com
- Phone: +1 (612) 865-7681
${pricingContext}

Rules:
- Keep replies under 160 characters â€” this is SMS
- Be warm, conversational, not salesy
- If asked about pricing, reply with ONLY this format (under 160 chars):
  "Here are my packages: ${pricingLink} - Shine"
  Then add [PRICING_SENT] at the very end
- If client says "yes lets book", "I want to book", "send the contract" â€” reply saying you will send over the contract shortly, then add [BOOKING_INTENT] at the very end
- Never make up availability`;

    if (!conversations[From]) conversations[From] = [];
    conversations[From].push({ role: 'user', content: Body });
    if (conversations[From].length > 10) {
      conversations[From] = conversations[From].slice(-10);
    }

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
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
        messages: conversations[From]
      })
    });

    const claudeData = await claudeRes.json();
    const replyText = claudeData.content[0].text;
    const bookingIntent = replyText.includes('[BOOKING_INTENT]');
    const pricingSent = replyText.includes('[PRICING_SENT]');
    const cleanReply = replyText.replace('[BOOKING_INTENT]', '').replace('[PRICING_SENT]', '').trim();

    conversations[From].push({ role: 'assistant', content: cleanReply });

    // Send SMS reply via Twilio
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`;
    const twilioAuth = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64');
    await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${twilioAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        From: process.env.TWILIO_FROM,
        To: From,
        Body: cleanReply
      }).toString()
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
          { client_id: client.id, channel: 'sms', direction: 'inbound', content: Body, status: 'received' },
          { client_id: client.id, channel: 'sms', direction: 'outbound', content: cleanReply, status: 'sent' }
        ])
      });
    }

    // Notify you if pricing sent or booking intent
    if (pricingSent || bookingIntent) {
      const notifSubject = bookingIntent
        ? `ðŸŽ¯ ${client?.name || From} wants to book!`
        : `ðŸ“‹ Pricing sent to ${client?.name || From}`;

      const notifText = bookingIntent
        ? `Client is ready to book!\n\nPhone: ${From}\nName: ${client?.name}\nEvent: ${client?.event_type}\n\nLog in to send the contract:\nshine-booking.vercel.app`
        : `Pricing link was sent to client via SMS!\n\nPhone: ${From}\nName: ${client?.name}\nEvent: ${client?.event_type}\nPricing type: ${client?.pricing_type}\n\nLink sent: ${pricingLink}\n\nshine-booking.vercel.app`;

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

    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');

  } catch(e) {
    console.error('Reply handler error:', e);
    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');
  }
}
