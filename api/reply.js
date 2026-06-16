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

    // Look up client in Supabase — failure safe
    let client = null;
    try {
      const clientRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/clients?phone=eq.${encodeURIComponent(From)}&order=created_at.desc&limit=1`,
        { headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` } }
      );
      const clients = await clientRes.json();
      client = Array.isArray(clients) ? (clients[0] || null) : null;
    } catch(e) {
      console.error('Supabase lookup failed:', e.message);
    }

    const SYSTEM_PROMPT = `You are Shine Thankappan, The Mentalist — writing SMS messages personally as yourself in first person.

IMPORTANT: Always write as "I" — never say "Shine will" or refer to yourself in third person.

About me:
- I perform 45-60 minute interactive mentalism and magic shows in Texas
- Website: www.texasmentalist.com
- Phone: +1 (612) 865-7681

Rules:
- Keep replies under 160 characters — this is SMS
- Be warm, conversational, not salesy
- If asked about pricing, reply warmly saying you have packages to suit different needs and will send the details right away. Do NOT include any link or prices. Then add [PRICING_REQUESTED] at the very end
- If client says "yes lets book", "I want to book", "send the contract" — reply thanking them warmly for booking and let them know you'll send a quick questionnaire to get everything set up, then add [BOOKING_INTENT] at the very end
- Never make up availability`;

    if (!conversations[From]) conversations[From] = [];
    conversations[From].push({ role: 'user', content: Body });
    if (conversations[From].length > 10) conversations[From] = conversations[From].slice(-10);

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 200, system: SYSTEM_PROMPT, messages: conversations[From] })
    });

    const claudeData = await claudeRes.json();
    const replyText = claudeData.content[0].text;
    const bookingIntent = replyText.includes('[BOOKING_INTENT]');
    const pricingRequested = replyText.includes('[PRICING_REQUESTED]');
    const cleanReply = replyText.replace('[BOOKING_INTENT]', '').replace('[PRICING_REQUESTED]', '').trim();

    conversations[From].push({ role: 'assistant', content: cleanReply });

    // Send SMS reply
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`;
    const twilioAuth = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64');
    await fetch(twilioUrl, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${twilioAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: process.env.TWILIO_FROM, To: From, Body: cleanReply }).toString()
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
          body: JSON.stringify({ status: newStatus, last_activity: new Date().toISOString(), last_channel: 'sms' })
        });

        await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
          body: JSON.stringify([
            { client_id: client.id, channel: 'sms', direction: 'inbound', content: Body, status: 'received' },
            { client_id: client.id, channel: 'sms', direction: 'outbound', content: cleanReply, status: 'sent' }
          ])
        });

        // Client confirmed booking intent — send thank-you + intake questionnaire if we have their email
        if (bookingIntent && client.email) {
          try {
            const bookingRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': process.env.SUPABASE_SECRET_KEY,
                'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
                'Prefer': 'return=representation'
              },
              body: JSON.stringify({
                client_id: client.id,
                client_name: client.name,
                client_email: client.email,
                event_type: client.event_type || '',
                event_date: client.event_date || null,
                fee: client.selected_price || null,
                contract_status: 'not_sent',
                intake_status: 'sent'
              })
            });
            const bookingRows = await bookingRes.json();
            const booking = Array.isArray(bookingRows) ? bookingRows[0] : null;

            if (booking) {
              const intakeLink = `https://shine-booking.vercel.app/intake.html?bid=${booking.id}`;
              await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
                body: JSON.stringify({
                  from: 'Shine, The Mentalist <shine@texasmentalist.com>',
                  to: client.email,
                  subject: 'Thank you for booking! Quick questionnaire inside',
                  text: `Hi ${client.name ? client.name.split(' ')[0] : 'there'},\n\nThank you so much for booking — I'm really looking forward to your event!\n\nTo get everything set up, including your performance agreement, could you fill out this short questionnaire?\n\n${intakeLink}\n\nIt only takes a couple of minutes and helps me personalize the show for you and your guests.\n\nShine, The Mentalist\n+1 (612) 865-7681\nwww.texasmentalist.com`
                })
              });

              await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${client.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
                body: JSON.stringify({
                  status: 'intake_sent',
                  booking_id: booking.id,
                  last_activity: new Date().toISOString(),
                  notes: `Intake form sent: ${intakeLink}`
                })
              });
            }
          } catch (intakeErr) {
            console.error('Send intake on booking intent failed:', intakeErr);
          }
        }
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
            subject: bookingIntent ? `🎯 ${client?.name || From} wants to book!` : `💰 ${client?.name || From} is asking about pricing`,
            text: bookingIntent
              ? `Client is ready to book!\n\nPhone: ${From}\nName: ${client?.name}\nEvent: ${client?.event_type}\n\n${client?.email ? "A thank-you note with the intake questionnaire was sent automatically." : "They have no email on file, so the questionnaire wasn't sent — follow up to get one."}\n\nshine-booking.vercel.app`
              : `Client is asking about pricing via SMS!\n\nPhone: ${From}\nName: ${client?.name}\nEvent: ${client?.event_type}\n\nOpen the app to send their pricing:\nshine-booking.vercel.app`
          })
        });
      } catch(e) {
        console.error('Notification failed:', e.message);
      }
    }

    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');

  } catch(e) {
    console.error('Reply handler error:', e);
    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');
  }
}
