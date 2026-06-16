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
    const fromNameMatch = from.match(/^"?([^"<]+)"?\s*<.+>$/);
    const fromName = fromNameMatch ? fromNameMatch[1].trim() : '';

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

    // Fetch prior email history for this client so replies aren't generated cold each time
    let priorMessages = [];
    if (client) {
      try {
        const historyRes = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/messages?client_id=eq.${client.id}&channel=eq.email&status=not.in.(pending_review,discarded)&order=created_at.asc&limit=20`,
          { headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` } }
        );
        const historyRows = await historyRes.json();
        if (Array.isArray(historyRows)) {
          priorMessages = historyRows.map(m => ({
            role: m.direction === 'inbound' ? 'user' : 'assistant',
            content: m.content
          }));
        }
      } catch(e) {
        console.error('Email history lookup failed:', e.message);
      }
    }

    const SYSTEM_PROMPT = `You are Shine Thankappan, a mentalist and magician based in Texas, replying to your own client emails personally. Write exactly the way you'd actually type an email on your phone between gigs — not the way a customer service rep or an AI assistant would write.

About me:
- I blend visual magic with mentalism — astonishing effects built around real human connection, not just tricks for their own sake
- I perform 45-60 minute interactive shows in Texas
- I also do strolling/walk-around magic — up-close magic that moves through a crowd (great for cocktail hours at weddings and corporate events), either on its own or paired with a short stage finale
- Payment: Cash, Zelle (2020shine@gmail.com), Venmo (@Shine-Thankappan), PayPal (shine_e_thankappan@yahoo.com)
- Website: www.texasmentalist.com
- Phone: +1 (612) 865-7681

How I describe what I do, depending on what they ask for:
- If they specifically say "mentalist," "mentalism," or "mind reading" — lead entirely with that. Talk about reading minds, psychological connection, predicting thoughts. Don't dilute it by bringing up visual magic unless they ask
- If they specifically say "magician," "magic," or "illusions" — lead with the visual side. Striking, surprising, visually stunning effects
- If they're general ("entertainer," "performer," "something fun for our event") or haven't specified a style — use the blended description above

How I actually write:
- Always first person, never "Shine will" or third person
- Short sentences. Real contractions (I'm, that's, can't, you're). Sometimes a sentence starts with "And" or "So" or "Also" — that's normal for me, not a mistake
- I don't pad replies with stock openers like "Thank you for reaching out" or "I hope this email finds you well" or "Great question!" — I just respond like I'm continuing a conversation with someone
- I vary how I open each email based on what they actually said, not a template. If they're excited, match that energy. If they're asking something simple, just answer it
- No corporate filler like "I appreciate your interest" or "Please don't hesitate to reach out" or "I look forward to hearing from you"
- One or two short paragraphs is usually enough. I don't over-explain
- A little personality is good — genuine enthusiasm about their event, a light joke if it fits naturally — but never forced or try-hard

Critical — sounding repetitive kills trust:
- Before writing, look back at what I've already said earlier in this email thread (shown above as prior messages)
- Never reuse a phrase, sentence opener, or stock expression I've already used earlier in this same thread — especially things like "great question," "I'd love to," "feel free to," "looking forward to it," "that sounds amazing/awesome." If I already said something like that once, find a genuinely different way to say it this time, or just skip the filler and say the thing directly
- If I've already thanked them once in this thread, don't thank them again the same way — just move the conversation forward

Rules:
- If asked about pricing, respond warmly that I have a few packages depending on what they're looking for and I'll send the details right over. Do NOT include any link or prices. Then add [PRICING_REQUESTED] at the very end
- If the client mentions a wedding, corporate event, cocktail hour, or specifically asks about strolling/walk-around/close-up magic, mention briefly that I offer that style of magic too (in addition to the stage show) before adding [PRICING_REQUESTED]
- Never claim I only do one format (stage show) if asked about strolling — I do both, and which one fits is something we figure out together
- If client says "yes lets book", "I want to book", "send the contract" — thank them for booking (in a way I haven't already phrased earlier in this thread) and mention I'll send a quick questionnaire to get everything set up, then add [BOOKING_INTENT] at the very end
- Never make up availability

Signature:
Shine, The Mentalist
+1 (612) 865-7681
www.texasmentalist.com`;

    const EXTRACTION_INSTRUCTION = `

This person is not yet in my client records — they're a brand new inquiry. After writing your reply, on a new line at the very end, output an extraction block in this exact format (after any [PRICING_REQUESTED] or [BOOKING_INTENT] tags, as the last thing in your response):
[LEAD_INFO]{"name":"their name if mentioned or inferable from the email, else null","eventType":"one of: Birthday party, Bachelorette party, Corporate event, Private celebration, Anniversary, Other, or null if unclear","eventDate":"YYYY-MM-DD if a specific date is mentioned, else null","guests":"a short string like '25-50' or a number if mentioned, else null"}[/LEAD_INFO]
Only include this block once. Do not mention this block or its contents in the visible reply text — it's purely structured data for internal use.`;

    const systemPrompt = client ? SYSTEM_PROMPT : SYSTEM_PROMPT + EXTRACTION_INSTRUCTION;

    // Build the full message list, then defensively collapse any consecutive
    // same-role messages (e.g. if a prior reply failed to save) since the API
    // requires strict user/assistant alternation
    const rawMessages = [
      ...priorMessages,
      { role: 'user', content: `Client email:\nFrom: ${from}\nSubject: ${subject}\n\n${emailBody}` }
    ];
    const messages = [];
    for (const m of rawMessages) {
      if (messages.length && messages[messages.length - 1].role === m.role) {
        messages[messages.length - 1].content += '\n\n' + m.content;
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: systemPrompt,
        messages: messages
      })
    });

    const claudeData = await claudeResponse.json();
    if (claudeData.error) throw new Error(claudeData.error.message);

    const replyText = claudeData.content[0].text;
    const bookingIntent = replyText.includes('[BOOKING_INTENT]');
    const pricingRequested = replyText.includes('[PRICING_REQUESTED]');

    // Extract structured lead info if present, without ever letting it leak into the visible reply
    let extractedLead = null;
    const leadInfoMatch = replyText.match(/\[LEAD_INFO\]([\s\S]*?)\[\/LEAD_INFO\]/);
    if (leadInfoMatch) {
      try {
        extractedLead = JSON.parse(leadInfoMatch[1].trim());
      } catch(e) {
        console.error('Failed to parse LEAD_INFO block:', e.message, leadInfoMatch[1]);
      }
    }

    const cleanReply = replyText
      .replace('[BOOKING_INTENT]', '')
      .replace('[PRICING_REQUESTED]', '')
      .replace(/\[LEAD_INFO\][\s\S]*?\[\/LEAD_INFO\]/, '')
      .trim();

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

    const replySubject = subject?.startsWith('Re:') ? subject : `Re: ${subject || 'Your inquiry'}`;

    if (!reviewMode) {
      // Send reply email immediately
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
        body: JSON.stringify({
          from: 'Shine, The Mentalist <shine@texasmentalist.com>',
          to: fromEmail,
          subject: replySubject,
          text: cleanReply
        })
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
          body: JSON.stringify({ status: newStatus, last_activity: new Date().toISOString(), last_channel: 'email' })
        });

        const messagesRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
          body: JSON.stringify([
            { client_id: client.id, channel: 'email', direction: 'inbound', content: emailBody, status: 'received', to_address: null, email_subject: null },
            { client_id: client.id, channel: 'email', direction: 'outbound', content: cleanReply, status: reviewMode ? 'pending_review' : 'sent', to_address: fromEmail, email_subject: replySubject }
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
                subject: `📝 Reply pending review — ${client.name || fromEmail}`,
                text: `${client.name || fromEmail} emailed:\n"${emailBody}"\n\nAI drafted this reply:\n"${cleanReply}"\n\nReview and send it from the dashboard:\nshine-booking.vercel.app`
              })
            });
          } catch(notifyErr) {
            console.error('Pending-review notification failed:', notifyErr.message);
          }
        }

        // Client confirmed booking intent — send thank-you + intake questionnaire
        if (bookingIntent) {
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
                client_email: fromEmail,
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
                  to: fromEmail,
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
    } else {
      // No existing client matches this email — auto-create a new lead from the inbound inquiry
      try {
        const leadName = (extractedLead && extractedLead.name) || fromName || fromEmail.split('@')[0];
        const leadEventType = (extractedLead && extractedLead.eventType) || '';
        const leadEventDate = (extractedLead && extractedLead.eventDate) || null;
        const leadGuests = (extractedLead && extractedLead.guests) || null;

        const newClientRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_SECRET_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
            'Prefer': 'return=representation'
          },
          body: JSON.stringify({
            name: leadName,
            email: fromEmail,
            event_type: leadEventType,
            event_date: leadEventDate,
            guests: leadGuests,
            status: pricingRequested ? 'pricing_requested' : 'chatting',
            lead_source: 'Website',
            last_channel: 'email',
            last_activity: new Date().toISOString(),
            notes: `Auto-added from inbound email inquiry`
          })
        });
        const newClientRows = await newClientRes.json();
        const newClient = Array.isArray(newClientRows) ? newClientRows[0] : null;

        if (newClient) {
          const messagesRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
            body: JSON.stringify([
              { client_id: newClient.id, channel: 'email', direction: 'inbound', content: emailBody, status: 'received', to_address: null, email_subject: null },
              { client_id: newClient.id, channel: 'email', direction: 'outbound', content: cleanReply, status: reviewMode ? 'pending_review' : 'sent', to_address: fromEmail, email_subject: replySubject }
            ])
          });
          if (!messagesRes.ok) {
            const errBody = await messagesRes.text();
            console.error('Messages insert failed for new lead:', messagesRes.status, errBody);
          }

          try {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
              body: JSON.stringify({
                from: 'Shine Booking Assistant <shine@texasmentalist.com>',
                to: 'shinethementalist@gmail.com',
                subject: `✨ New lead auto-added: ${leadName}`,
                text: `A new inquiry came in from ${fromEmail} and wasn't already in your client list, so I added them automatically.\n\nName: ${leadName}\nEvent type: ${leadEventType || 'not specified'}\nEvent date: ${leadEventDate || 'not specified'}\nGuests: ${leadGuests || 'not specified'}\n\nTheir message:\n"${emailBody}"\n\n${reviewMode ? "The reply is waiting for your review on the dashboard." : "A reply was sent automatically."}\n\nCheck the dashboard to fill in any missing details:\nshine-booking.vercel.app`
              })
            });
          } catch(notifyErr) {
            console.error('New-lead notification failed:', notifyErr.message);
          }
        }
      } catch(e) {
        console.error('Auto-create new lead failed:', e.message);
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
            subject: bookingIntent ? `🎯 ${client?.name || fromEmail} wants to book!` : `💰 ${client?.name || fromEmail} is asking about pricing`,
            text: bookingIntent
              ? `Client is ready to book!\n\nFrom: ${fromEmail}\nName: ${client?.name}\nEvent: ${client?.event_type}\n\nA thank-you note with the intake questionnaire was sent automatically.\n\nshine-booking.vercel.app`
              : `Client is asking about pricing!\n\nFrom: ${fromEmail}\nName: ${client?.name}\nEvent: ${client?.event_type}\n\nOpen the app to send their pricing:\nshine-booking.vercel.app${strollingHint}`
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
