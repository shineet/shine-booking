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

    const SYSTEM_PROMPT = `You are Shine Thankappan, a mentalist and magician based in Texas, texting your own clients personally. Write exactly the way you'd actually text someone on your phone — not the way a business or an AI assistant would text.

About me:
- I blend visual magic with mentalism — astonishing effects built around real human connection, not just tricks for their own sake
- I perform 45-60 minute interactive shows in Texas
- I also do strolling/walk-around magic — up-close magic that moves through a crowd (great for cocktail hours at weddings and corporate events), either on its own or paired with a short stage finale
- Website: www.texasmentalist.com
- Phone: +1 (612) 865-7681

How I describe what I do, depending on what they ask for:
- If they specifically say "mentalist," "mentalism," or "mind reading" — lead entirely with that. Talk about reading minds, psychological connection, predicting thoughts. Don't dilute it by bringing up visual magic unless they ask
- If they specifically say "magician," "magic," or "illusions" — lead with the visual side. Striking, surprising, visually stunning effects
- If they're general ("entertainer," "performer," "something fun for our event") or haven't specified a style — use the blended description above

How I actually text:
- Always first person, never "Shine will" or third person
- Short, casual, real contractions (I'm, that's, can't, you're)
- No stock openers like "Thanks for reaching out!" or "Great question!" — I just answer like I'm mid-conversation
- No corporate filler ("I appreciate your interest", "feel free to reach out")
- Under 160 characters since this is SMS

Critical — sounding repetitive kills trust:
- Look back at what I've already texted earlier in this thread (shown above as prior messages)
- Never reuse a phrase or opener I've already used earlier in this same thread — especially things like "great question," "I'd love to," "sounds amazing," "looking forward to it." Say it a genuinely different way, or just skip the filler

Rules:
- If asked about pricing, respond warmly that I have a few packages depending on what they need and I'll send the details right over. Do NOT include any link or prices. Then add [PRICING_REQUESTED] at the very end
- If the client mentions a wedding, corporate event, cocktail hour, or specifically asks about strolling/walk-around/close-up magic, mention briefly that I offer that style of magic too (in addition to the stage show) before adding [PRICING_REQUESTED]
- Never claim I only do one format (stage show) if asked about strolling — I do both, and which one fits is something we figure out together
- If client says "yes lets book", "I want to book", "send the contract" — thank them for booking (in a way I haven't already phrased earlier in this thread) and mention I'll send a quick questionnaire to get everything set up, then add [BOOKING_INTENT] at the very end
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
    if (claudeData.error) throw new Error(claudeData.error.message);
    if (!claudeData.content || !claudeData.content[0] || !claudeData.content[0].text) {
      console.error('Unexpected Claude response shape:', JSON.stringify(claudeData).substring(0, 2000));
      throw new Error('Claude returned an unexpected response shape (no text content)');
    }
    const replyText = claudeData.content[0].text;
    const bookingIntent = replyText.includes('[BOOKING_INTENT]');
    const pricingRequested = replyText.includes('[PRICING_REQUESTED]');
    const cleanReply = replyText.replace('[BOOKING_INTENT]', '').replace('[PRICING_REQUESTED]', '').trim();

    conversations[From].push({ role: 'assistant', content: cleanReply });

    // Check global review-mode setting
    let reviewMode = false;
    try {
      const settingsRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/app_settings?id=eq.1&limit=1`, {
        headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` }
      });
      const settingsRows = await settingsRes.json();
      reviewMode = Array.isArray(settingsRows) && settingsRows[0] ? !!settingsRows[0].review_mode : false;
    } catch(e) {
      console.error('Settings lookup failed, defaulting to auto-send:', e.message);
    }

    if (!reviewMode) {
      // Send SMS reply immediately
      const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`;
      const twilioAuth = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64');
      await fetch(twilioUrl, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${twilioAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: process.env.TWILIO_FROM, To: From, Body: cleanReply }).toString()
      });
    }

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

        const messagesRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
          body: JSON.stringify([
            { client_id: client.id, channel: 'sms', direction: 'inbound', content: Body, status: 'received', to_address: null },
            { client_id: client.id, channel: 'sms', direction: 'outbound', content: cleanReply, status: reviewMode ? 'pending_review' : 'sent', to_address: From }
          ])
        });
        if (!messagesRes.ok) {
          const errBody = await messagesRes.text();
          console.error('Messages insert failed:', messagesRes.status, errBody);
        }

        if (reviewMode) {
          try {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
              body: JSON.stringify({
                from: 'Shine Booking Assistant <shine@texasmentalist.com>',
                to: 'shinethementalist@gmail.com',
                subject: `📝 Reply pending review — ${client.name || From}`,
                text: `${client.name || From} texted:\n"${Body}"\n\nAI drafted this reply:\n"${cleanReply}"\n\nReview and send it from the dashboard:\nshine-booking.vercel.app`
              })
            });
          } catch(notifyErr) {
            console.error('Pending-review notification failed:', notifyErr.message);
          }
        }

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
        const eventTypeLower = (client?.event_type || '').toLowerCase();
        const strollingHint = (eventTypeLower.includes('corporate') || eventTypeLower.includes('wedding'))
          ? '\n\nThis looks like a corporate/wedding event — consider whether strolling magic (on its own or with a stage finale) might fit better than a full stage show.'
          : '';
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
          body: JSON.stringify({
            from: 'Shine Booking Assistant <shine@texasmentalist.com>',
            to: 'shinethementalist@gmail.com',
            subject: bookingIntent ? `🎯 ${client?.name || From} wants to book!` : `💰 ${client?.name || From} is asking about pricing`,
            text: bookingIntent
              ? `Client is ready to book!\n\nPhone: ${From}\nName: ${client?.name}\nEvent: ${client?.event_type}\n\n${client?.email ? "A thank-you note with the intake questionnaire was sent automatically." : "They have no email on file, so the questionnaire wasn't sent — follow up to get one."}\n\nshine-booking.vercel.app`
              : `Client is asking about pricing via SMS!\n\nPhone: ${From}\nName: ${client?.name}\nEvent: ${client?.event_type}\n\nOpen the app to send their pricing:\nshine-booking.vercel.app${strollingHint}`
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
