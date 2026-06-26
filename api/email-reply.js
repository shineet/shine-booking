export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Handle outbound email.sent events (Gmail sends via Resend SMTP)
  if (req.body && req.body.type === 'email.sent') {
    try {
      const emailId  = req.body.data?.email_id;
      const fromAddr = req.body.data?.from || '';
      const toList   = req.body.data?.to   || [];
      const subj     = req.body.data?.subject || '';

      if (!fromAddr.includes('texasmentalist.com')) {
        return res.status(200).json({ received: true, skipped: 'not from texasmentalist' });
      }

      const toEmail = Array.isArray(toList) ? toList[0] : toList;
      if (!toEmail || toEmail.includes('texasmentalist.com') || toEmail.includes('resend.com') || toEmail === 'shinethementalist@gmail.com') {
        return res.status(200).json({ received: true, skipped: 'internal email' });
      }

      // Skip if the booking app already logged this send in the last 90s
      const since = new Date(Date.now() - 90000).toISOString();
      const dupRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/messages?channel=eq.email&direction=eq.outbound&to_address=eq.${encodeURIComponent(toEmail)}&created_at=gte.${since}&limit=1`,
        { headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` } }
      );
      const dups = await dupRes.json();
      if (Array.isArray(dups) && dups.length > 0) {
        return res.status(200).json({ received: true, skipped: 'already logged by app' });
      }

      // Fetch full email body from Resend
      let emailBody = `[Email with subject: ${subj}]`;
      if (emailId) {
        try {
          const emailRes = await fetch(`https://api.resend.com/emails/${emailId}`, {
            headers: { 'Authorization': `Bearer ${process.env.RESEND_KEY}` }
          });
          const emailData = await emailRes.json();
          const rawText = emailData.text || (emailData.html || '').replace(/<[^>]+>/g, '').trim();
          if (rawText) emailBody = rawText.substring(0, 4000);
        } catch(e) {
          console.error('Failed to fetch email content from Resend:', e.message);
        }
      }

      // Find matching client by recipient email
      const clientRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/clients?email=eq.${encodeURIComponent(toEmail)}&order=created_at.desc&limit=1`,
        { headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` } }
      );
      const clients = await clientRes.json();
      const client  = Array.isArray(clients) ? (clients[0] || null) : null;

      if (client) {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
          body: JSON.stringify([{ client_id: client.id, channel: 'email', direction: 'outbound', content: emailBody, status: 'sent', to_address: toEmail, email_subject: subj }])
        });
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${client.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
          body: JSON.stringify({ last_activity: new Date().toISOString(), last_channel: 'email' })
        });
      }

      return res.status(200).json({ received: true, logged: !!client });
    } catch(e) {
      console.error('email.sent handler error:', e.message);
      return res.status(200).json({ received: true, error: e.message });
    }
  }

  try {
    const { from, to, subject, body, rawEmail } = req.body;

    if (!from) {
      res.status(200).json({ received: true });
      return;
    }

    const isOwnSystem = from.includes('resend.com') || from.includes('noreply');
    const isShineManual = !isOwnSystem && (
      from.includes('texasmentalist.com') ||
      from.includes('shinethementalist@gmail.com') ||
      from.includes('2020shine@gmail.com')
    );

    if (isOwnSystem || isShineManual) {
      // If Shine manually emailed a client and BCC'd log@texasmentalist.com, log it as outbound
      if (isShineManual && to) {
        const toEmail = to.match(/<(.+)>/)?.[1] || to.split(',')[0].trim();
        if (toEmail && !toEmail.includes('texasmentalist.com') && !toEmail.includes('resend.com')) {
          let manualBody = body || '';
          if (!manualBody && rawEmail) {
            const textMatch = rawEmail.match(/Content-Type: text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\r?\nContent-Type)/);
            if (textMatch) {
              manualBody = textMatch[1].trim();
            } else {
              const headerEnd = rawEmail.indexOf('\r\n\r\n') !== -1 ? rawEmail.indexOf('\r\n\r\n') : rawEmail.indexOf('\n\n');
              if (headerEnd > -1) manualBody = rawEmail.substring(headerEnd).trim().substring(0, 2000);
            }
          }
          try {
            const clientRes = await fetch(
              `${process.env.SUPABASE_URL}/rest/v1/clients?email=eq.${encodeURIComponent(toEmail)}&order=created_at.desc&limit=1`,
              { headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` } }
            );
            const clients = await clientRes.json();
            const manualClient = Array.isArray(clients) ? (clients[0] || null) : null;
            if (manualClient) {
              await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
                body: JSON.stringify([{
                  client_id: manualClient.id,
                  channel: 'email',
                  direction: 'outbound',
                  content: manualBody || `[Email with subject: ${subject}]`,
                  status: 'sent',
                  to_address: toEmail,
                  email_subject: subject
                }])
              });
              await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${manualClient.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
                body: JSON.stringify({ last_activity: new Date().toISOString(), last_channel: 'email' })
              });
            }
          } catch(e) {
            console.error('Manual outbound log failed:', e.message);
          }
        }
      }
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
    // Cap length defensively — long reply threads can carry the full quoted history,
    // which can blow up the prompt size and the response we get back from Claude.
    if (emailBody.length > 4000) {
      emailBody = emailBody.substring(0, 4000) + '\n\n[...message truncated, original was longer...]';
    }

    // Detect out-of-office / vacation auto-replies so we don't create a lead or
    // draft a reply for them. No single signal is reliable on its own across all
    // mail providers, so we check several common ones together.
    function looksLikeAutoReply(rawEmailStr, subjectStr, bodyStr) {
      const headerBlock = (rawEmailStr || '').split(/\r?\n\r?\n/)[0] || '';
      const headerSignals = [
        /^Auto-Submitted:\s*(?!no\b)/im,
        /^X-Autoreply:\s*yes/im,
        /^X-Autorespond:/im,
        /^Precedence:\s*auto_reply/im,
        /^X-Auto-Response-Suppress:/im
      ];
      if (headerSignals.some(function(re) { return re.test(headerBlock); })) return true;

      const subjectLower = (subjectStr || '').toLowerCase();
      const subjectSignals = [
        'out of office', 'out-of-office', 'automatic reply', 'auto reply',
        'auto-reply', 'autoreply', "i'm away", 'vacation response', 'away from'
      ];
      if (subjectSignals.some(function(s) { return subjectLower.includes(s); })) return true;

      const bodyLower = (bodyStr || '').toLowerCase().substring(0, 500);
      const bodySignals = [
        'i am currently out of the office', "i'm currently out of the office",
        'i am out of office', 'i will be out of the office', 'currently out of office',
        'on vacation and will respond', 'limited access to email', 'i am on leave',
        'will be back in the office'
      ];
      if (bodySignals.some(function(s) { return bodyLower.includes(s); })) return true;

      return false;
    }

    if (looksLikeAutoReply(rawEmail, subject, emailBody)) {
      res.status(200).json({ received: true, skipped: 'auto-reply / out-of-office detected' });
      return;
    }

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

Format guidance based on event type:
- Birthday parties and bachelorette parties: lead with the stage show. That's what works best for these. Mention strolling is available if they specifically ask or if it seems like a fit
- Cocktail hours, corporate events, weddings, galas, or any event where people are mingling: mention BOTH options and ask what they prefer. Most people doing cocktail-style events lean toward strolling (I move through guests doing close-up effects one-on-one), but a stage finale or hybrid is also possible. Don't assume — ask. Something like "For a cocktail setup, most of my clients go with walk-around so I'm right in the middle of your guests, but I can also do a stage moment at the end if you want — what sounds more like what you had in mind?"
- Never mention a stage show as the default or primary option for cocktail-style events — it's misleading and has lost leads before

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
- Never claim I only do one format — I do both stage shows and strolling, and which one fits is something we figure out together based on their event
- If client says "yes lets book", "I want to book", "send the contract" — thank them for booking (in a way I haven't already phrased earlier in this thread) and mention I'll send a quick questionnaire to get everything set up, then add [BOOKING_INTENT] at the very end
- Never make up availability

Signature:
Shine, The Mentalist
+1 (612) 865-7681
www.texasmentalist.com`;

    const EXTRACTION_INSTRUCTION = `

This person is not yet in my client records — they're a brand new inquiry. After writing your reply, on a new line at the very end, output an extraction block in this exact format (after any [PRICING_REQUESTED] or [BOOKING_INTENT] tags, as the last thing in your response):
[LEAD_INFO]{"name":"their name if mentioned or inferable from the email, else null","eventType":"one of: Birthday party, Bachelorette party, Corporate event, Private celebration, Anniversary, Other, or null if unclear","eventDate":"YYYY-MM-DD if a specific date is mentioned, else null","guests":"a short string like '25-50' or a number if mentioned, else null","contactType":"either 'planner' or 'client'"}[/LEAD_INFO]

For contactType, classify based on the whole email, weighing these signals together (no single one is decisive on its own):
- A job title suggesting they book entertainment for OTHERS, e.g. "Event Producer", "Event Coordinator", "Wedding Planner", "Director of Events", "DMC" (Destination Management Company)
- Language like "on behalf of our client", "our client is looking for", "I'm reaching out for one of our clients"
- A signature block naming a company that does event planning/production/coordination as its business, rather than being the actual host of the event
- A business-sounding email domain (not gmail/yahoo/icloud/outlook.com) combined with one of the above signals

If the email reads like someone planning THEIR OWN event (birthday, wedding, office party they're personally organizing), classify as "client" even if sent from a work email address. When genuinely unsure, default to "client" — false positives here are worse than false negatives.

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
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages
      })
    });

    let claudeData;
    const claudeRawText = await claudeResponse.text();
    try {
      claudeData = JSON.parse(claudeRawText);
    } catch(parseErr) {
      throw new Error(`Claude response was not valid JSON (HTTP ${claudeResponse.status}): ${claudeRawText.substring(0, 500)}`);
    }
    if (!claudeResponse.ok || claudeData.error) {
      throw new Error(`Claude API error (HTTP ${claudeResponse.status}): ${claudeData.error?.message || claudeRawText.substring(0, 500)}`);
    }
    if (!claudeData.content || !claudeData.content[0] || !claudeData.content[0].text) {
      console.error('Unexpected Claude response shape:', JSON.stringify(claudeData));
      throw new Error(`Claude returned no text content. stop_reason: ${claudeData.stop_reason}, content: ${JSON.stringify(claudeData.content)}`);
    }

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
        const leadContactType = (extractedLead && extractedLead.contactType === 'planner') ? 'planner' : 'client';

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
            contact_type: leadContactType,
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
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
        body: JSON.stringify({
          from: 'Shine Booking Assistant <shine@texasmentalist.com>',
          to: 'shinethementalist@gmail.com',
          subject: '⚠️ An inbound email failed to process',
          text: `An email came in but I couldn't generate a reply or draft for it, so nothing showed up on your dashboard for this one.\n\nError: ${e.message}\n\nYou may want to check your Gmail (shinethementalist@gmail.com) for the original message and reply manually if needed.`
        })
      });
    } catch(notifyErr) {
      console.error('Failure-notification email also failed:', notifyErr.message);
    }
    res.status(200).json({ received: true, error: e.message });
  }
}
