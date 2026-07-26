// Last 10 digits of any phone format — used to match an inbound E.164 number
// against client records that may have been stored in a non-normalized format.
function last10(phone) {
  if (!phone) return '';
  const d = String(phone).replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}

// Cheap keyword guard so the personal-phone-forward path (below) doesn't fire an extra
// Claude call on every ordinary reply — only worth checking when the recent thread
// actually mentions a call/talk together with a day or time.
function looksLikeSchedulingTalk(text) {
  const t = String(text || '').toLowerCase();
  const hasCallWord = /\b(call|talk|chat|meet|meeting|phone)\b/.test(t);
  const hasTimeWord = /\b(tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|noon|midnight)\b/.test(t)
    || /\d{1,2}(:\d{2})?\s*(am|pm)\b/.test(t);
  return hasCallWord && hasTimeWord;
}

// Used on the personal-phone-forward path, where Shine types his own reply and there's
// no AI drafting call already happening to piggyback the [CALL_SCHEDULED] marker onto
// (that path is handled inline further down, in the main Claude reply call). Runs a
// small standalone Claude call over the recent thread to catch the same "date + time
// mutually confirmed" case when Shine is the one who typed the confirmation himself.
async function detectAndSaveCallSuggestion(clientId, supaHeaders) {
  if (!clientId) return;
  try {
    const histRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/messages?client_id=eq.${clientId}&channel=eq.sms&order=created_at.desc&limit=10&select=direction,content`,
      { headers: supaHeaders }
    );
    const histRows = await histRes.json();
    if (!Array.isArray(histRows) || !histRows.length) return;
    const lines = histRows.reverse().map(m => (m.direction === 'inbound' ? 'THEM: ' : 'SHINE: ') + String(m.content || '').replace(/\s+/g, ' ').trim());
    const convoText = lines.join('\n');
    if (!looksLikeSchedulingTalk(convoText)) return;

    const today = new Date().toISOString().slice(0, 10);
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 60,
        system: `Today's date is ${today}. You are scanning a text conversation to check whether a specific date AND a specific time have been mutually confirmed by both people for a phone call or meeting (NOT the actual event/performance date itself). Resolve relative dates ("tomorrow", "Thursday") against today's date. If both a date and time are clearly settled by both sides, respond with EXACTLY this and nothing else: [CALL_SCHEDULED: YYYY-MM-DD|H:MM AM/PM|short title]. Otherwise respond with exactly: NONE`,
        messages: [{ role: 'user', content: convoText }]
      })
    });
    const claudeData = await claudeRes.json();
    const text = claudeData?.content?.[0]?.text || '';
    const match = text.match(/\[CALL_SCHEDULED:\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^\]|]+?)\s*\|\s*([^\]]+?)\s*\]/);
    if (match) {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${clientId}`, {
        method: 'PATCH',
        headers: { ...supaHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendar_suggestion: { date: match[1], time: match[2].trim(), title: match[3].trim() } })
      });
    }
  } catch(e) {
    console.error('Call suggestion detection failed:', e.message);
  }
}

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

    // Shared Supabase auth headers -- hoisted above the personal-phone branch below
    // since that branch also needs Supabase access (message log + call detection).
    const supaHeaders = { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` };

    // If Shine is replying from his personal phone, route to the last forwarded client
    if (From === '+16128657681') {
      try {
        const settingsRes = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/app_settings?id=eq.1&select=last_forwarded_sms_phone,last_forwarded_sms_client_id`,
          { headers: supaHeaders }
        );
        const settings = await settingsRes.json();
        const lastPhone    = settings[0]?.last_forwarded_sms_phone || null;
        const lastClientId = settings[0]?.last_forwarded_sms_client_id || null;

        if (lastPhone) {
          const twilioUrl  = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`;
          const twilioAuth = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64');

          await fetch(twilioUrl, {
            method: 'POST',
            headers: { 'Authorization': `Basic ${twilioAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ From: process.env.TWILIO_FROM, To: lastPhone, Body }).toString()
          });

          if (lastClientId) {
            await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
              method: 'POST',
              headers: { ...supaHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify([{
                client_id: lastClientId, channel: 'sms', direction: 'outbound',
                content: Body, status: 'sent', to_address: lastPhone
              }])
            });
            await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${lastClientId}`, {
              method: 'PATCH',
              headers: { ...supaHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify({ last_activity: new Date().toISOString(), last_channel: 'sms' })
            });
            // Shine may have just typed the confirmation himself (e.g. "Yes 12 works for
            // me") -- the AI reply path below never runs on this branch, so check here too.
            await detectAndSaveCallSuggestion(lastClientId, supaHeaders);
          }
        }
      } catch(e) {
        console.error('Shine personal reply forward failed:', e.message);
      }
      res.setHeader('Content-Type', 'text/xml');
      res.status(200).send('<Response></Response>');
      return;
    }

    // Look up client in Supabase — failure safe.
    // Inbound Twilio `From` is E.164 (+1XXXXXXXXXX). Older client records may have been
    // saved in a non-normalized format (e.g. "(610) 908-6678"), so an exact match can miss.
    // Match on the last 10 digits as a fallback, then self-heal the stored phone to E.164.
    const fromDigits = last10(From);
    let client = null;
    try {
      const exactRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/clients?phone=eq.${encodeURIComponent(From)}&order=created_at.desc&limit=1`,
        { headers: supaHeaders }
      );
      const exact = await exactRes.json();
      client = Array.isArray(exact) ? (exact[0] || null) : null;

      // Fallback: scan and match by last 10 digits (handles legacy/unnormalized formats)
      if (!client && fromDigits) {
        const allRes = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/clients?select=*&order=created_at.desc`,
          { headers: supaHeaders }
        );
        const all = await allRes.json();
        if (Array.isArray(all)) client = all.find(c => last10(c.phone) === fromDigits) || null;
      }

      // Self-heal: rewrite a matched-but-misformatted phone to E.164 so future lookups hit the fast path
      if (client && client.phone !== From && last10(client.phone) === fromDigits) {
        try {
          await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${client.id}`, {
            method: 'PATCH',
            headers: { ...supaHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: From })
          });
          client.phone = From;
        } catch(healErr) { console.error('Phone self-heal failed:', healErr.message); }
      }
    } catch(e) {
      console.error('Supabase lookup failed:', e.message);
    }

    // Cold inbound (never messaged from the app) — capture the lead so it still shows in the dashboard
    if (!client) {
      try {
        const createRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients`, {
          method: 'POST',
          headers: { ...supaHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
          body: JSON.stringify([{
            phone: From, status: 'new', lead_source: 'Inbound SMS',
            last_channel: 'sms', last_activity: new Date().toISOString()
          }])
        });
        const created = await createRes.json();
        client = Array.isArray(created) ? (created[0] || null) : null;
      } catch(e) {
        console.error('Auto-create inbound client failed:', e.message);
      }
    }

    // Forward incoming SMS to Shine's personal phone and record who sent it — failure safe
    try {
      const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`;
      const twilioAuth = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64');
      const senderLabel = client?.name ? client.name : From;
      await fetch(twilioUrl, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${twilioAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          From: process.env.TWILIO_FROM,
          To: '+16128657681',
          Body: `📱 ${senderLabel}: ${Body}`
        }).toString()
      });
      // Save exactly who was forwarded so replies route to the right client
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/app_settings?id=eq.1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
        body: JSON.stringify({ last_forwarded_sms_phone: From, last_forwarded_sms_client_id: client?.id || null })
      });
    } catch(e) {
      console.error('Forward to Shine failed:', e.message);
    }

    const SYSTEM_PROMPT = `You are Shine Thankappan, a mentalist and magician based in Texas, texting your own clients personally. Write exactly the way you'd actually text someone on your phone — not the way a business or an AI assistant would text.

About me:
- I blend visual magic with mentalism — astonishing effects built around real human connection, not just tricks for their own sake
- I perform 45-60 minute interactive shows in Texas
- I also do strolling/walk-around magic — up-close magic that moves through a crowd (great for cocktail hours at weddings and corporate events), either on its own or paired with a short stage finale
- Website: www.texasmentalist.com
- Phone: +1 (737) 271-5308

How I describe what I do, depending on what they ask for:
- If they specifically say "mentalist," "mentalism," or "mind reading" — lead entirely with that. Talk about reading minds, psychological connection, predicting thoughts. Don't dilute it by bringing up visual magic unless they ask
- If they specifically say "magician," "magic," or "illusions" — lead with the visual side. Striking, surprising, visually stunning effects
- If they're general ("entertainer," "performer," "something fun for our event") or haven't specified a style — use the blended description above

How I actually text:
- Always first person, never "Shine will" or third person
- Short, casual, real contractions (I'm, that's, can't, you're)
- No stock openers like "Thanks for reaching out!" or "Great question!" — I just answer like I'm mid-conversation
- No corporate filler ("I appreciate your interest", "feel free to reach out")
- Default to short, like a real text — most replies should fit in one SMS segment. It's fine to run longer when the content genuinely needs it (e.g. explaining packages/pricing in real detail, especially if the client has no email on file so this text has to carry the whole explanation). Never pad length just to fill space, and never cut a real explanation short just to hit a character count. Hard technical ceiling: stay well under 1500 characters — carriers reject SMS bodies over 1600, so never approach that

Critical — sounding repetitive kills trust:
- Look back at what I've already texted earlier in this thread (shown above as prior messages)
- Never reuse a phrase or opener I've already used earlier in this same thread — especially things like "great question," "I'd love to," "sounds amazing," "looking forward to it." Say it a genuinely different way, or just skip the filler

Rules:
- If asked about pricing, respond warmly that I have a few packages depending on what they need and I'll send the details right over. Do NOT include any link or prices. Then add [PRICING_REQUESTED] at the very end
- My stage show is my strength — always emphasize it. For private parties (birthdays, house/home parties, small private events) do NOT bring up strolling unless the client specifically asks. For cocktail parties mention BOTH strolling and the stage show (suggest the stage show too if the setup allows guests to gather and watch). For weddings and corporate events I can mention strolling too, but only as an optional add-on with the stage show as the headline — never lead with strolling. Only center strolling if they explicitly ask about walk-around/close-up/roving magic
- Never claim I only do one format (stage show) if asked about strolling — I do both, and which one fits is something we figure out together
- If client says "yes lets book", "I want to book", "send the contract" — thank them for booking (in a way I haven't already phrased earlier in this thread) and mention I'll send a quick questionnaire to get everything set up, then add [BOOKING_INTENT] at the very end
- Never make up availability

Call/meeting detection (separate from the actual performance date):
- Today's date is ${new Date().toISOString().slice(0, 10)}. Resolve any relative date the client gives ("tomorrow", "Thursday", "next week") against this.
- If, across this thread including their latest message, a specific date AND a specific time have been mutually confirmed for a phone call, video call, or meeting to talk further (this is NOT the event/performance date itself), append this marker on its own line at the very end, after any other marker: [CALL_SCHEDULED: YYYY-MM-DD|H:MM AM/PM|short title]
- Only add it when both a specific date and a specific time are clearly settled by both sides — not when a call is merely proposed or "sometime tomorrow" with no time given. If unsure, leave it out.`;

    // Owner's custom response guidance (editable from the dashboard "AI Settings" panel).
    // A single free-text field in app_settings, layered on top of the base voice above.
    let ownerGuidance = '';
    try {
      const gRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/app_settings?id=eq.1&select=ai_guidance&limit=1`, { headers: supaHeaders });
      const gRows = await gRes.json();
      if (Array.isArray(gRows) && gRows[0] && gRows[0].ai_guidance) ownerGuidance = String(gRows[0].ai_guidance).trim();
    } catch(e) { console.error('AI guidance fetch failed:', e.message); }

    const finalSystemPrompt = ownerGuidance
      ? `${SYSTEM_PROMPT}\n\nSHINE'S CUSTOM INSTRUCTIONS (highest priority. Follow these; if they conflict with anything above, these win, but never exceed the SMS length limit and never invent availability):\n${ownerGuidance}`
      : SYSTEM_PROMPT;

    // Real conversation history from the messages table, not in-memory state -- a module-level
    // JS object doesn't reliably survive between requests on Vercel serverless (each invocation
    // can land on a fresh container), which is exactly why Jim got asked "what day?" after he'd
    // already said "tomorrow" in the previous text: the in-memory history had been wiped between
    // his two messages, so the AI saw this one in total isolation. Mirrors fetchLeadConversation
    // in pending-replies.js: a single user turn with prior turns flattened into plain text, not a
    // multi-turn messages array (keeps this immune to any alternating-role requirement).
    let historyBlock = '';
    if (client && client.id) {
      try {
        const histRes = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/messages?client_id=eq.${client.id}&channel=eq.sms&status=not.in.(discarded)&order=created_at.asc&limit=20&select=direction,content`,
          { headers: supaHeaders }
        );
        const histRows = await histRes.json();
        if (Array.isArray(histRows) && histRows.length) {
          const lines = histRows
            .map(m => (m.direction === 'inbound' ? 'THEM: ' : 'SHINE: ') + String(m.content || '').replace(/\s+/g, ' ').trim())
            .filter(x => x.length > 6);
          if (lines.length) historyBlock = 'CONVERSATION SO FAR:\n' + lines.join('\n') + '\n\n';
        }
      } catch(e) { console.error('SMS history fetch failed:', e.message); }
    }
    const userContent = historyBlock ? historyBlock + 'THEIR LATEST MESSAGE (respond to this): ' + Body : Body;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, system: finalSystemPrompt, messages: [{ role: 'user', content: userContent }] })
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
    const callMatch = replyText.match(/\[CALL_SCHEDULED:\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^\]|]+?)\s*\|\s*([^\]]+?)\s*\]/);
    const callSuggestion = callMatch ? { date: callMatch[1], time: callMatch[2].trim(), title: callMatch[3].trim() } : null;
    let cleanReply = replyText
      .replace('[BOOKING_INTENT]', '')
      .replace('[PRICING_REQUESTED]', '')
      .replace(/\[CALL_SCHEDULED:[^\]]*\]/, '')
      .trim();
    // Safety backstop, not expected to trigger given the prompt guidance above --
    // Twilio hard-rejects any SMS body over 1600 chars, and this send has no
    // response check below, so an over-limit body would fail completely
    // silently (client gets nothing, nothing logged). Truncate defensively.
    if (cleanReply.length > 1550) cleanReply = cleanReply.slice(0, 1550).trim() + '…';

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
        // Ordinary chat replies shouldn't regress a client that's already past
        // the chatting stage (e.g. booked/intake_sent/contract_signed) back to
        // 'chatting' -- only move status forward, never backward.
        const STATUS_RANK = { new: 0, chatting: 1, pricing_requested: 1, pricing_sent: 2, package_selected: 3, booked: 4, intake_sent: 5, intake_completed: 6, contract_sent: 7, contract_signed: 8, completed: 9 };
        let newStatus = 'chatting';
        if (pricingRequested) newStatus = 'pricing_requested';
        if (bookingIntent) newStatus = 'booked';
        if ((STATUS_RANK[newStatus] ?? 0) < (STATUS_RANK[client.status] ?? 0)) newStatus = client.status;

        const clientPatch = { status: newStatus, last_activity: new Date().toISOString(), last_channel: 'sms' };
        if (callSuggestion) clientPatch.calendar_suggestion = callSuggestion;

        await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${client.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
          body: JSON.stringify(clientPatch)
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
            // Guard against duplicate bookings: if bookingIntent trips again on a
            // later message (e.g. client clarifies event details after already
            // confirming), don't create a second booking row for the same client.
            const existingRes = await fetch(
              `${process.env.SUPABASE_URL}/rest/v1/bookings?client_id=eq.${client.id}&status=not.in.(completed,lost,cancelled)&select=id&limit=1`,
              { headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` } }
            );
            const existingRows = await existingRes.json();
            const alreadyHasActiveBooking = Array.isArray(existingRows) && existingRows.length > 0;

            const bookingRes = alreadyHasActiveBooking ? null : await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings`, {
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
            const bookingRows = bookingRes ? await bookingRes.json() : null;
            const booking = Array.isArray(bookingRows) ? bookingRows[0] : null;

            if (booking) {
              const intakeLink = `https://shine-booking.vercel.app/intake.html?bid=${booking.id}`;
              await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
                body: JSON.stringify({
                  from: 'Shine, The Mentalist <shine@texasmentalist.com>',
                  to: client.email,
                  bcc: ['shinethementalist@gmail.com'],
                  subject: 'Thank you for booking! Quick questionnaire inside',
                  text: `Hi ${client.name ? client.name.split(' ')[0] : 'there'},\n\nThank you so much for booking — I'm really looking forward to your event!\n\nTo get everything set up, including your performance agreement, could you fill out this short questionnaire?\n\n${intakeLink}\n\nIt only takes a couple of minutes and helps me personalize the show for you and your guests.\n\nShine, The Mentalist\n+1 (737) 271-5308\nwww.texasmentalist.com`
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
          ? '\n\nThis looks like a corporate/wedding event — lead with your stage show (your strength); strolling magic can be offered as an optional add-on (e.g. cocktail hour) if it fits.'
          : '';
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
          body: JSON.stringify({
            from: 'Shine Booking Assistant <shine@texasmentalist.com>',
            to: 'shinethementalist@gmail.com',
            subject: bookingIntent ? `🎯 ${client?.name || From} wants to book!` : `💰 ${client?.name || From} is asking about pricing`,
            text: bookingIntent
              ? `Client is ready to book!\n\nPhone: ${From}\nName: ${client?.name || 'Unknown (new lead)'}\nEvent: ${client?.event_type || 'Not specified'}\n\n${client?.email ? "A thank-you note with the intake questionnaire was sent automatically." : "They have no email on file, so the questionnaire wasn't sent — follow up to get one."}\n\nshine-booking.vercel.app`
              : `Client is asking about pricing via SMS!\n\nPhone: ${From}\nName: ${client?.name || 'Unknown (new lead)'}\nEvent: ${client?.event_type || 'Not specified'}\n\nOpen the app to send their pricing:\nshine-booking.vercel.app${strollingHint}`
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
