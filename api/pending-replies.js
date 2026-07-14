function normalizePhone(phone) {
  if (!phone) return phone;
  var digits = phone.replace(/[^0-9]/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (phone.trim().startsWith('+')) return '+' + digits;
  return phone;
}

// Real carrier/line-type lookup via Twilio Lookup v2 (line_type_intelligence add-on), used by
// the research step so the phone-type read is a verified fact instead of an area-code guess.
// Separate credentials (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN) from the messaging pair
// (TWILIO_SID/TWILIO_TOKEN) used everywhere else in this file, though today they're the same
// Twilio account. Fails soft: returns null on any error/timeout so research always proceeds.
async function lookupPhoneLineType(phone) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const normalized = normalizePhone(phone);
  if (!sid || !token || !normalized) return null;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(
      `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(normalized)}?Fields=line_type_intelligence`,
      { headers: { Authorization: 'Basic ' + auth }, signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!resp.ok) { console.error('Twilio Lookup error:', resp.status); return null; }
    const data = await resp.json();
    const lti = data && data.line_type_intelligence;
    if (!lti || !lti.type) return null;
    return { type: lti.type, carrierName: lti.carrier_name || null };
  } catch(e) { console.error('Twilio Lookup failed:', e.message); return null; }
}

// Voice prompts used only by the "regenerate" action below. These MIRROR the prompts in
// email-reply.js (EMAIL_VOICE) and reply.js (SMS_VOICE) so a re-drafted reply keeps Shine's
// voice. If you change the voice in those files, update it here too.
const EMAIL_VOICE = `You are Shine Thankappan, a mentalist and magician based in Texas, replying to your own client emails personally. Write exactly the way you'd actually type an email on your phone between gigs — not the way a customer service rep or an AI assistant would write.

About me:
- I blend visual magic with mentalism — astonishing effects built around real human connection, not just tricks for their own sake
- I perform 45-60 minute interactive shows in Texas
- I also do strolling/walk-around magic — up-close magic that moves through a crowd (great for cocktail hours at weddings and corporate events), either on its own or paired with a short stage finale
- Payment: Cash, Zelle (2020shine@gmail.com), Venmo (@Shine-Thankappan), PayPal (shine_e_thankappan@yahoo.com)
- Website: www.texasmentalist.com
- Phone: +1 (737) 271-5308

How I describe what I do, depending on what they ask for:
- If they specifically say "mentalist," "mentalism," or "mind reading" — lead entirely with that. Talk about reading minds, psychological connection, predicting thoughts. Don't dilute it by bringing up visual magic unless they ask
- If they specifically say "magician," "magic," or "illusions" — lead with the visual side. Striking, surprising, visually stunning effects
- If they're general ("entertainer," "performer," "something fun for our event") or haven't specified a style — use the blended description above

Format guidance based on event type — my STAGE SHOW is my strength, so always emphasize it:
- Private parties (birthdays, bachelorette parties, house/home parties, any small private event): lead with and emphasize the stage show. Do NOT bring up strolling/walk-around on my own — only mention it if the client specifically asks for it. If they ask, I'm glad to do it, but never suggest it myself for these
- Cocktail parties / cocktail-style mingling events: mention BOTH — strolling (which fits a mingling crowd well) and the stage show. Suggest the stage show too whenever the setup allows it (somewhere guests can gather and watch). Still emphasize the stage show as my strength, but make clear both are options for a cocktail setting
- Corporate events and weddings: I can mention both, but the stage show is the headline. Present the stage show as the main event and strolling only as an optional add-on (for example during a cocktail hour). Keep the emphasis clearly on the stage show, never lead with strolling
- Only lead with or center strolling if the client explicitly asks about walk-around/close-up/roving magic

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
- If asked about pricing, respond warmly that I have a few packages depending on what they're looking for and I'll send the details right over. Do NOT include any link or prices.
- Never claim I only do one format — I do both stage shows and strolling, and which one fits is something we figure out together based on their event
- Never make up availability
- Return ONLY the email body. No subject line, no commentary, no internal tags.

Signature:
Shine, The Mentalist
+1 (737) 271-5308
www.texasmentalist.com`;

const SMS_VOICE = `You are Shine Thankappan, a mentalist and magician based in Texas, texting your own clients personally. Write exactly the way you'd actually text someone on your phone — not the way a business or an AI assistant would text.

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
- Under 160 characters since this is SMS

Critical — sounding repetitive kills trust:
- Look back at what I've already texted earlier in this thread (shown above as prior messages)
- Never reuse a phrase or opener I've already used earlier in this same thread — especially things like "great question," "I'd love to," "sounds amazing," "looking forward to it." Say it a genuinely different way, or just skip the filler

Rules:
- If asked about pricing, respond warmly that I have a few packages depending on what they need and I'll send the details right over. Do NOT include any link or prices.
- My stage show is my strength — always emphasize it. For private parties (birthdays, house/home parties, small private events) do NOT bring up strolling unless the client specifically asks. For cocktail parties mention BOTH strolling and the stage show. For weddings and corporate events I can mention strolling too, but only as an optional add-on with the stage show as the headline
- Never make up availability
- Return ONLY the message text, no commentary, no internal tags.`;

// Give the research action (Claude + web search) room to finish server-side.
export const config = { maxDuration: 60 };

// Pull the lead's actual conversation (what they messaged Shine) so research + drafts
// factor in their own words, not just the notes field. Inbound + outbound, oldest first.
async function fetchLeadConversation(clientId) {
  if (!clientId) return '';
  try {
    const sb = { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` };
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?client_id=eq.${clientId}&status=not.in.(discarded)&order=created_at.asc&limit=12`, { headers: sb });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return '';
    const lines = rows
      // 4000 chars, not 500: a full email (e.g. one that quotes a specific price partway
      // through) was getting silently truncated before the model ever saw the price.
      .map(m => (m.direction === 'inbound' ? 'THEM: ' : 'SHINE: ') + String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 4000))
      .filter(x => x.length > 8);
    return lines.length ? '\n\nWHAT THEY ACTUALLY MESSAGED (read this closely and respond to it):\n' + lines.join('\n') : '';
  } catch(e) { console.error('fetchLeadConversation failed:', e.message); return ''; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    // Owner's custom response guidance (editable from the dashboard "AI Settings" panel).
    // Returns a ready-to-append suffix, or '' if none set.
    const guidanceSuffix = async () => {
      try {
        const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/app_settings?id=eq.1&select=ai_guidance&limit=1`, {
          headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` }
        });
        const rows = await r.json();
        const g = (Array.isArray(rows) && rows[0] && rows[0].ai_guidance) ? String(rows[0].ai_guidance).trim() : '';
        return g ? `\n\nSHINE'S CUSTOM INSTRUCTIONS (highest priority. Follow these; if they conflict with anything above, these win, but never invent availability):\n${g}` : '';
      } catch(e) { console.error('AI guidance fetch failed:', e.message); return ''; }
    };

    // GET ?action=settings -> read the global review-mode toggle
    if (req.method === 'GET' && req.query.action === 'settings') {
      const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/app_settings?id=eq.1&limit=1`, {
        headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` }
      });
      const rows = await r.json();
      const settings = Array.isArray(rows) ? rows[0] : null;
      res.status(200).json({ reviewMode: settings ? settings.review_mode : false });
      return;
    }

    // GET (default) -> list all pending replies with client info
    if (req.method === 'GET') {
      const r = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/messages?status=eq.pending_review&order=created_at.asc&select=*`,
        { headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` } }
      );
      const pending = await r.json();
      if (!Array.isArray(pending) || pending.length === 0) {
        res.status(200).json({ pending: [] });
        return;
      }

      const clientIds = [...new Set(pending.map(m => m.client_id).filter(Boolean))];
      let clientsById = {};
      if (clientIds.length) {
        const idsParam = clientIds.join(',');
        const cRes = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/clients?id=in.(${idsParam})&select=id,name`,
          { headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` } }
        );
        const cRows = await cRes.json();
        if (Array.isArray(cRows)) cRows.forEach(c => { clientsById[c.id] = c.name; });
      }

      // Pull each client's recent INBOUND messages so we can show the owner the message
      // they're actually replying to (the thing the AI draft is responding to).
      let inboundByClient = {};
      if (clientIds.length) {
        try {
          const idsParam = clientIds.join(',');
          const inRes = await fetch(
            `${process.env.SUPABASE_URL}/rest/v1/messages?client_id=in.(${idsParam})&direction=eq.inbound&order=created_at.desc&select=client_id,channel,content,created_at,email_subject`,
            { headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` } }
          );
          const inRows = await inRes.json();
          if (Array.isArray(inRows)) {
            inRows.forEach(m => {
              // keep the most recent inbound per client+channel (rows are newest-first)
              const key = m.client_id + '|' + m.channel;
              if (!inboundByClient[key]) inboundByClient[key] = m;
            });
          }
        } catch(e) { console.error('Inbound fetch for pending failed:', e.message); }
      }

      const result = pending.map(m => {
        const inb = inboundByClient[m.client_id + '|' + m.channel] || null;
        return {
          id: m.id,
          clientId: m.client_id,
          clientName: clientsById[m.client_id] || 'Unknown',
          channel: m.channel,
          toAddress: m.to_address,
          draft: m.content,
          createdAt: m.created_at,
          subject: m.email_subject || null,
          incoming: inb ? inb.content : null,
          incomingAt: inb ? inb.created_at : null
        };
      });

      res.status(200).json({ pending: result });
      return;
    }

    // POST action=generate-followup -> generate context-aware draft and save to messages
    if (req.method === 'POST' && req.body.action === 'generate-followup') {
      const { clientId, clientName, eventType, eventDate, venue, guests, status, hoursAgo, toEmail, toPhone } = req.body;

      const statusContext = {
        'new':               'You sent them an initial message but they have not replied yet. Follow up warmly, reference their event, and ask if they have any questions.',
        'chatting':          'You have been chatting. They have not replied to your last message. Follow up gently to keep the conversation going.',
        'pricing_requested': 'They asked about pricing. You sent pricing info but they have not responded. Ask if they had questions about the packages.',
        'pricing_sent':      'You sent them your pricing page but they have not responded. Check if they had a chance to look and if they have questions.',
        'package_selected':  'They selected a package. Follow up about the next step: filling out the event questionnaire so you can personalise the show.',
        'booked':            'They are booked. Follow up about completing the event questionnaire/intake form so you can start preparing.',
        'intake_sent':       'You sent the event questionnaire but they have not filled it out yet. Remind them and offer help if needed.',
        'intake_completed':  'They completed the questionnaire. Follow up about sending the contract to finalise everything.',
        'contract_sent':     'You sent the contract but they have not signed yet. Remind them to sign so the booking is confirmed.'
      };

      const followUpContext = statusContext[status] || 'Follow up professionally about the next step.';

      const systemPrompt = `You are writing a follow-up email on behalf of Shine, The Mentalist — a professional mentalism and magic performer in Texas.

RULES:
- This is NOT a first contact. Do NOT introduce yourself or describe your show.
- Write only what is appropriate for the stage described below.
- Warm, brief, natural. Under 80 words total.
- Sign off as: Shine, The Mentalist | +1 (737) 271-5308
- Return ONLY the email body. No subject line. No commentary.

STAGE: ${followUpContext}`;

      const userPrompt = `Client: ${clientName}
Event: ${eventType || 'not specified'}
Date: ${eventDate || 'not specified'}
Venue: ${venue || 'not specified'}
Guests: ${guests || 'not specified'}
Hours since last contact: ${hoursAgo}`;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 300,
          system: systemPrompt + (await guidanceSuffix()),
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });

      const claudeData = await claudeRes.json();
      if (claudeData.error) throw new Error(claudeData.error.message || JSON.stringify(claudeData.error));

      let draft = '';
      if (claudeData.content && Array.isArray(claudeData.content)) {
        claudeData.content.forEach(b => { if (b.type === 'text') draft += b.text; });
      }
      if (!draft) throw new Error('No draft generated');

      // Save to messages table
      const sbHdr = {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
        'Prefer': 'return=representation'
      };

      const saveRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
        method: 'POST',
        headers: sbHdr,
        body: JSON.stringify({
          client_id: clientId,
          channel: toEmail ? 'email' : 'sms',
          content: draft,
          status: 'pending_review',
          to_address: toEmail || toPhone || null,
          direction: 'outbound',
          created_at: new Date().toISOString()
        })
      });

      const saved = await saveRes.json();
      if (saved && saved.code) throw new Error('Supabase: ' + (saved.message || saved.code));

      res.status(200).json({ success: true, draft });
      return;
    }

    // POST action=generate-reply -> draft a contextual reply for the compose modal
    if (req.method === 'POST' && req.body.action === 'generate-reply') {
      const { clientName, eventType, eventDate, venue, guests, status, notes, instruction, channel } = req.body;

      const systemPrompt = `You are writing a reply SMS on behalf of Shine, The Mentalist — a professional mentalism and magic performer in Texas.

RULES:
- This is a reply to a client who has already been in contact, NOT a first introduction
- Warm, direct, natural tone — not salesy
- Keep it concise — readable in one glance on a phone screen
- Sign off as: - Shine | +1 (737) 271-5308
- Return ONLY the message text, no commentary

PRICING:
- Shine's minimum rate is $350 for any show
- If the client's notes mention a budget below $350, the reply MUST:
  1. State the rate clearly and without apology: "My rate starts at $350"
  2. Acknowledge their stated budget briefly and without judgment
  3. Ask if there's any flexibility: "Is there any wiggle room on budget?"
  4. Offer a scope adjustment as an alternative if appropriate (e.g. shorter set)
  5. Keep the door open — warm but firm on the minimum`;

      const userPrompt = [
        `Client: ${clientName}`,
        eventType ? `Event: ${eventType}` : '',
        eventDate ? `Date: ${eventDate}` : '',
        venue ? `Venue: ${venue}` : '',
        guests ? `Guests: ${guests}` : '',
        status ? `Status: ${status}` : '',
        notes ? `Notes: ${notes}` : ''
      ].filter(Boolean).join('\n');

      // If composing an email, relax the SMS length/signoff rule.
      const channelBlock = channel === 'email'
        ? '\n\nFORMAT OVERRIDE: This is an EMAIL, not an SMS. Use one or two short paragraphs; sign off as "Shine, The Mentalist" with the phone and website. Ignore the SMS "one glance" length rule above.'
        : '';
      // Per-draft steering the owner typed for THIS message.
      const instrBlock = (instruction && String(instruction).trim())
        ? `\n\nSHINE'S INSTRUCTION FOR THIS DRAFT (highest priority — follow this; never invent availability):\n${String(instruction).trim()}`
        : '';

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 400,
          system: systemPrompt + (await guidanceSuffix()) + channelBlock + instrBlock,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });

      const claudeData = await claudeRes.json();
      if (claudeData.error) throw new Error(claudeData.error.message || JSON.stringify(claudeData.error));

      let draft = '';
      if (claudeData.content && Array.isArray(claudeData.content)) {
        claudeData.content.forEach(b => { if (b.type === 'text') draft += b.text; });
      }
      if (!draft) throw new Error('No draft generated');

      res.status(200).json({ success: true, draft });
      return;
    }

    // POST action=toggle -> flip review-mode
    if (req.method === 'POST' && req.body.action === 'toggle') {
      const { reviewMode } = req.body;
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/app_settings?id=eq.1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
        body: JSON.stringify({ review_mode: reviewMode, updated_at: new Date().toISOString() })
      });
      res.status(200).json({ success: true, reviewMode });
      return;
    }

    // POST action=approve -> send and mark sent
    if (req.method === 'POST' && req.body.action === 'approve') {
      const { messageId, editedText } = req.body;
      const msgRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?id=eq.${messageId}&limit=1`, {
        headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` }
      });
      const msgRows = await msgRes.json();
      const message = Array.isArray(msgRows) ? msgRows[0] : null;
      if (!message) { res.status(404).json({ error: 'Message not found' }); return; }

      const finalText = editedText || message.content;

      if (message.channel === 'sms') {
        const twilioAuth = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64');
        await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${twilioAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ From: process.env.TWILIO_FROM, To: normalizePhone(message.to_address), Body: finalText }).toString()
        });
      } else if (message.channel === 'email') {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
          body: JSON.stringify({
            from: 'Shine, The Mentalist <shine@texasmentalist.com>',
            to: message.to_address,
            subject: message.email_subject || 'Following up',
            text: finalText
          })
        });
      }

      await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?id=eq.${messageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
        body: JSON.stringify({ status: 'sent', content: finalText })
      });

      res.status(200).json({ success: true });
      return;
    }

    // POST action=discard -> drop without sending
    if (req.method === 'POST' && req.body.action === 'discard') {
      const { messageId } = req.body;
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?id=eq.${messageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
        body: JSON.stringify({ status: 'discarded' })
      });
      res.status(200).json({ success: true });
      return;
    }

    // POST action=restore -> bring a discarded draft back into the pending-review queue
    // so it can be edited/regenerated/sent through the normal flow.
    if (req.method === 'POST' && req.body.action === 'restore') {
      const { messageId } = req.body;
      if (!messageId) { res.status(400).json({ error: 'messageId required' }); return; }
      const sbHeaders = { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` };
      const chkRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?id=eq.${messageId}&limit=1`, { headers: sbHeaders });
      const chkRows = await chkRes.json();
      const msg = Array.isArray(chkRows) ? chkRows[0] : null;
      if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }
      if (msg.status !== 'discarded') { res.status(400).json({ error: 'Only discarded drafts can be restored' }); return; }
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?id=eq.${messageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...sbHeaders },
        body: JSON.stringify({ status: 'pending_review' })
      });
      res.status(200).json({ success: true });
      return;
    }

    // POST action=regenerate -> re-draft this pending reply, optionally steered by a
    // per-message instruction the owner types after reading the client's message.
    if (req.method === 'POST' && req.body.action === 'regenerate') {
      const { messageId, instruction } = req.body;
      if (!messageId) { res.status(400).json({ error: 'messageId required' }); return; }
      const sbHeaders = { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` };

      // The pending draft we're regenerating
      const dRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?id=eq.${messageId}&limit=1`, { headers: sbHeaders });
      const dRows = await dRes.json();
      const draftMsg = Array.isArray(dRows) ? dRows[0] : null;
      if (!draftMsg) { res.status(404).json({ error: 'Draft not found' }); return; }
      const channel = draftMsg.channel === 'sms' ? 'sms' : 'email';

      // Conversation history for this client + channel (excludes pending/discarded, so the
      // draft itself isn't fed back in; the client's latest inbound is the last 'user' turn).
      let history = [];
      if (draftMsg.client_id) {
        try {
          const hRes = await fetch(
            `${process.env.SUPABASE_URL}/rest/v1/messages?client_id=eq.${draftMsg.client_id}&channel=eq.${channel}&status=not.in.(pending_review,discarded)&order=created_at.asc&limit=20`,
            { headers: sbHeaders }
          );
          const hRows = await hRes.json();
          if (Array.isArray(hRows)) history = hRows.map(m => ({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: m.content }));
        } catch(e) { console.error('Regenerate history fetch failed:', e.message); }
      }

      // Collapse consecutive same-role turns (Claude requires strict alternation) and make
      // sure it starts and ends on a 'user' turn.
      const msgs = [];
      for (const m of history) {
        if (msgs.length && msgs[msgs.length - 1].role === m.role) msgs[msgs.length - 1].content += '\n\n' + m.content;
        else msgs.push({ role: m.role, content: m.content });
      }
      if (!msgs.length || msgs[0].role !== 'user') msgs.unshift({ role: 'user', content: '(Start of conversation.)' });
      if (msgs[msgs.length - 1].role !== 'user') msgs.push({ role: 'user', content: '(Please draft my reply to the latest message above.)' });

      const baseVoice = channel === 'sms' ? SMS_VOICE : EMAIL_VOICE;
      const instrBlock = (instruction && String(instruction).trim())
        ? `\n\nSHINE'S INSTRUCTION FOR THIS SPECIFIC REPLY (highest priority — follow this for this one draft; it wins over anything above except: never invent availability):\n${String(instruction).trim()}`
        : '';
      const systemPrompt = baseVoice + (await guidanceSuffix()) + instrBlock;

      async function callClaude(model) {
        try {
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model, max_tokens: channel === 'sms' ? 300 : 1024, system: systemPrompt, messages: msgs })
          });
          const txt = await resp.text();
          let data; try { data = JSON.parse(txt); } catch(e) { return null; }
          if (!resp.ok || data.error) { console.error('Regenerate model error:', data && data.error && data.error.message); return null; }
          return (data.content && data.content[0] && data.content[0].text) ? data.content[0].text : null;
        } catch(e) { console.error('Regenerate call failed:', e.message); return null; }
      }

      let text = await callClaude('claude-sonnet-4-6');
      if (!text) text = await callClaude('claude-opus-4-8');
      if (!text) { res.status(200).json({ error: 'Could not generate a new draft — try again.' }); return; }

      const newDraft = text
        .replace('[BOOKING_INTENT]', '')
        .replace('[PRICING_REQUESTED]', '')
        .replace(/\[LEAD_INFO\][\s\S]*?\[\/LEAD_INFO\]/, '')
        .trim();

      // Persist the new draft on the pending message so it survives a refresh.
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?id=eq.${messageId}`, {
        method: 'PATCH',
        headers: { ...sbHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newDraft })
      });

      res.status(200).json({ success: true, draft: newDraft });
      return;
    }

    // POST action=research -> STEP 1: deep-research a lead (company + person via live web
    // search), read affordability, resolve the phone line type. Research only — NO drafting
    // here (that's the separate, fast action=draft step). Split so each call stays well under
    // Vercel's 60s function ceiling regardless of web-search latency.
    if (req.method === 'POST' && req.body.action === 'research') {
      const lead = req.body.lead || {};
      const emailDomain = (lead.email && lead.email.indexOf('@') !== -1) ? lead.email.split('@')[1].trim().toLowerCase() : '';

      const RESEARCH_SYSTEM = `You are the research analyst for Shine Thankappan, a corporate mentalist and magician based in Austin, TX. Given one inbound lead, use the web_search tool to research the company and the person, judge how much they can afford, and resolve their phone line type. You do NOT write any outreach — a separate step drafts the messages.

1. COMPANY: From the email domain and any company name, search and identify the organization — what it is, size/prestige signals, industry, location. If the email domain is a free provider (gmail/yahoo/outlook/icloud) or none is given, treat it as an individual / private lead and say so.
2. PERSON: Always search the person's name, corporate or private lead alike. For corporate leads, search name + company/domain and surface role/title plus any public LinkedIn/company-page/social snippet. For private/individual leads, run MULTIPLE targeted searches, not just one generic name search: try "<name> instagram", "<name> X" or "<name> twitter", and "<name> facebook" as separate queries (add city/area if the name is common), since a single plain-name search often misses social platforms that a targeted search catches. Useful context is anything confirming this looks like a real person versus a spam/test entry, or a public detail relevant to the event. If multiple people share the name or nothing distinct turns up, say so plainly. Never fabricate a title, profile match, or fact.
3. AFFORDABILITY: Judge whether this lead can afford a HIGH or LOW price, from concrete signals (company type/prestige, role, event type, guest count, venue). Shine's corporate floor is $2,500; his real corporate booking anchor is $3,500. Give a specific recommended anchor number and a short internal price range with when to push higher.
4. PHONE: The lead's phone is "${lead.phone || '(none given)'}". State which region/city the area code is registered to as a plain fact (this is useful for spotting out-of-town clients, e.g. a bachelorette party booking Shine from New York for an Austin event) — but do NOT speculate about whether the lead currently lives there, has relocated, or is "out of state", since people commonly keep the same number across moves and that inference is unreliable. If a "VERIFIED PHONE LINE TYPE" fact is given below, state mobile/landline directly and confidently (it's real carrier data, not a guess) and advise whether Shine should ALSO text the number (yes if mobile). If no verified fact is given, say you can't determine mobile vs landline without a carrier lookup and recommend confirming at freecarrierlookup.com.
5. FIT + STRATEGY: one tight paragraph on why this is (or isn't) a good fit and how to approach the reply.

BE CONCISE (time-sensitive): 1-2 short sentences per field. Do not pad.
HARD STYLE RULE: absolutely NO em dashes (—). Use commas, periods, or "to".

Return your ENTIRE response as a SINGLE fenced JSON code block (\`\`\`json ... \`\`\`) and nothing else, with exactly these string fields:
{
  "company": "what the company is + prestige/size signals, or 'Individual / private lead' if no company",
  "person": "role/title and any public profile findings, or what you could not find",
  "affordability": "HIGH or LOW read with the reasoning",
  "recommendedAnchor": "a dollar figure, e.g. $3,500",
  "priceRange": "internal range + when to push higher",
  "phone": "area code's registered region, mobile vs landline assessment, confidence, and whether to also text",
  "fit": "fit + strategy paragraph"
}`;

      // Real carrier lookup runs alongside nothing else here (before the LLM call), so its
      // ~1-2s (or 5s timeout on failure) adds minimal risk to the 60s budget.
      const lineType = lead.phone ? await lookupPhoneLineType(lead.phone) : null;

      const userPrompt = [
        `Lead name: ${lead.name || '(unknown)'}`,
        `Email: ${lead.email || '(none)'}${emailDomain ? '  (domain: ' + emailDomain + ')' : ''}`,
        `Phone: ${lead.phone || '(none)'}`,
        lineType ? `VERIFIED PHONE LINE TYPE (via Twilio carrier lookup): ${lineType.type}${lineType.carrierName ? ', carrier: ' + lineType.carrierName : ''}` : '',
        lead.company ? `Company field: ${lead.company}` : '',
        `Event type: ${lead.event_type || '(unspecified)'}`,
        lead.event_date ? `Event date: ${lead.event_date}` : '',
        lead.guests ? `Guests: ${lead.guests}` : '',
        lead.lead_source ? `Source: ${lead.lead_source}` : '',
        lead.notes ? `Notes / their message: ${lead.notes}` : ''
      ].filter(Boolean).join('\n') + (await fetchLeadConversation(lead.clientId));

      // Server-side web search: Claude runs the searches itself. Loop on pause_turn
      // (the server-tool loop caps and pauses; re-send to resume). Kept fast + bounded so
      // the browser reliably gets a response. Fewer searches + tighter output = lower latency.
      async function runResearch(model) {
        let messages = [{ role: 'user', content: userPrompt }];
        let text = '', ref = false;
        try {
          for (let i = 0; i < 2; i++) {
            const resp = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({
                model,
                max_tokens: 1800,
                system: RESEARCH_SYSTEM,
                // Basic web search (no per-result code-exec filtering) = much faster per search,
                // which keeps the whole call under Vercel's 60s function ceiling. Tried restoring
                // the dynamic-filtering version on 2026-07-13; measured 54.7s (vs ~23-30s here) and
                // the model reported it couldn't complete a live search in time. Reverted.
                // max_uses raised 2->4 same day so private-lead person search has room to run
                // multiple platform-targeted queries (instagram/X/facebook) instead of one generic
                // name search; measured latency stayed well under budget (see brain notes).
                tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
                messages
              })
            });
            const data = await resp.json();
            if (!resp.ok || data.error) { console.error('Research model error:', data && data.error && data.error.message); break; }
            if (data.stop_reason === 'refusal') { ref = true; break; }
            text = '';
            if (Array.isArray(data.content)) data.content.forEach(b => { if (b.type === 'text') text += b.text; });
            if (data.stop_reason === 'pause_turn') {
              messages = [{ role: 'user', content: userPrompt }, { role: 'assistant', content: data.content }];
              continue; // resumed turn re-emits text; keep only the last pass
            }
            break;
          }
        } catch(e) { console.error('Research call failed (' + model + '):', e.message); }
        return { text, ref };
      }

      // Single fast pass on Opus 4.8 (testing 2026-07-13: research now persists per lead via
      // localStorage, so it only runs once per lead, making the extra cost/latency worth it for
      // quality). No fallback: two research passes back-to-back risk the 60s function limit.
      const r = await runResearch('claude-opus-4-8');
      const finalText = r.text; const refused = r.ref;

      if (refused) { res.status(200).json({ error: 'The AI declined this one (rare false positive). Try again, or research manually.' }); return; }
      if (!finalText) { res.status(200).json({ error: 'Could not generate research — try again in a moment.' }); return; }

      // Parse the trailing ```json block; fall back to first {...last }.
      let parsed = null;
      try {
        const blocks = finalText.match(/```json\s*([\s\S]*?)```/gi);
        let jsonStr = null;
        if (blocks && blocks.length) jsonStr = blocks[blocks.length - 1].replace(/```json\s*/i, '').replace(/```$/, '');
        else { const s = finalText.indexOf('{'); const e = finalText.lastIndexOf('}'); if (s !== -1 && e > s) jsonStr = finalText.slice(s, e + 1); }
        if (jsonStr) parsed = JSON.parse(jsonStr);
      } catch(e) { console.error('Research parse failed:', e.message); }

      // Web search embeds <cite> citation tags in the text; strip them for clean display.
      const stripCite = (s) => typeof s === 'string' ? s.replace(/<\/?cite[^>]*>/gi, '').replace(/[ \t]+\n/g, '\n').trim() : s;
      if (parsed) Object.keys(parsed).forEach(k => { parsed[k] = stripCite(parsed[k]); });

      if (!parsed) { res.status(200).json({ success: true, research: null, raw: stripCite(finalText) }); return; }
      res.status(200).json({ success: true, research: parsed });
      return;
    }

    // POST action=draft -> STEP 2: draft the email + SMS for a lead, using the research from
    // step 1 as context. NO web search here, so it's fast (~8-15s) and never risks the timeout.
    if (req.method === 'POST' && req.body.action === 'draft') {
      const lead = req.body.lead || {};
      const rc = req.body.research || {};

      const DRAFT_SYSTEM = `You are Shine Thankappan, a corporate mentalist and magician based in Austin, TX (website texasmentalist.com, phone +1 737-271-5308). You perform a 45-60 minute interactive mentalism + visual-magic STAGE SHOW (your strength) and also do strolling/walk-around magic. Draft outreach for a new lead. These are DRAFTS you will review and send yourself.

Use the research context provided (company, affordability, recommended anchor, event details) to write a confident, specific reply. If a recommended anchor price is given and the lead gave enough detail, put a starting number in the email ("my rate starts at $X") rather than sending them to a form — website leads bail on friction. Ask at most 1-2 light qualifying questions. Never invent availability.

Tone by event type — the STAGE SHOW is always the headline:
- Corporate events / weddings: lead with the stage show; strolling only as an optional add-on.
- Private parties (birthday, bachelorette, house/home, small private): lead with and emphasize the stage show; do NOT bring up strolling unless the client asked for it.
- Cocktail parties: mention both strolling and the stage show.

Voice: first person, short sentences, real contractions (I'm, that's, you're). No stock openers ("Thanks for reaching out", "I hope this finds you well"), no corporate filler ("I appreciate your interest", "don't hesitate to reach out"). One or two short paragraphs. A little genuine warmth, never try-hard. The SMS is a short friendly nudge pointing back to the email (under ~160 chars).

HARD STYLE RULE: absolutely NO em dashes (—). Use commas, periods, or "to".

If a CURRENT DRAFT and feedback from Shine are shown below, you are REVISING: change the email and SMS to address his feedback while keeping everything that already works, and directly answer any question he asks (e.g. "did you consider the anniversary angle?"). Put your reply to Shine in the "note" field — one or two short sentences, like a collaborator talking back (answer the question, or say what you changed and why). On a first draft with no feedback, leave "note" as an empty string.

Return your ENTIRE response as a SINGLE fenced JSON code block (\`\`\`json ... \`\`\`) and nothing else, with exactly these string fields:
{
  "note": "1-2 short sentences replying to Shine's feedback/question, or \\"\\" on a first draft",
  "emailSubject": "the email subject line",
  "emailBody": "the full email body, signed 'Shine, The Mentalist / texasmentalist.com / 737-271-5308'",
  "sms": "a short SMS nudge"
}`;

      let draftUser = [
        `Lead name: ${lead.name || '(unknown)'}`,
        `Event type: ${lead.event_type || '(unspecified)'}`,
        lead.event_date ? `Event date: ${lead.event_date}` : '',
        lead.guests ? `Guests: ${lead.guests}` : '',
        lead.notes ? `Their message / notes: ${lead.notes}` : '',
        '',
        'RESEARCH CONTEXT:',
        rc.company ? `Company: ${rc.company}` : '',
        rc.affordability ? `Affordability: ${rc.affordability}` : '',
        rc.recommendedAnchor ? `Recommended anchor price: ${rc.recommendedAnchor}` : '',
        rc.fit ? `Fit/strategy: ${rc.fit}` : ''
      ].filter(Boolean).join('\n') + (await fetchLeadConversation(lead.clientId));

      // Iterative refinement: if Shine sent feedback on a current draft, include the draft
      // + his earlier feedback so the revision builds on what's already there.
      const cur = req.body.current || null;
      const priorInstr = Array.isArray(req.body.priorInstructions) ? req.body.priorInstructions.filter(Boolean) : [];
      if (cur && (cur.emailBody || cur.sms)) {
        draftUser += '\n\nCURRENT DRAFT (revise this, keep what works):\n' +
          (cur.emailSubject ? 'Email subject: ' + cur.emailSubject + '\n' : '') +
          (cur.emailBody ? 'Email body:\n' + cur.emailBody + '\n' : '') +
          (cur.sms ? 'SMS: ' + cur.sms : '');
        if (priorInstr.length) draftUser += '\n\nShine\'s earlier feedback (for context):\n- ' + priorInstr.join('\n- ');
      }

      const instr = (req.body.instruction && String(req.body.instruction).trim())
        ? `\n\nSHINE'S LATEST FEEDBACK / REQUEST (highest priority, act on this; never invent availability):\n${String(req.body.instruction).trim()}`
        : '';

      async function callDraft(model) {
        try {
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model, max_tokens: 1200, system: DRAFT_SYSTEM + instr, messages: [{ role: 'user', content: draftUser }] })
          });
          const txt = await resp.text();
          let data; try { data = JSON.parse(txt); } catch(e) { return { text: null, ref: false }; }
          if (!resp.ok || data.error) { console.error('Draft model error:', data && data.error && data.error.message); return { text: null, ref: false }; }
          if (data.stop_reason === 'refusal') return { text: null, ref: true };
          let t = ''; if (Array.isArray(data.content)) data.content.forEach(b => { if (b.type === 'text') t += b.text; });
          return { text: t, ref: false };
        } catch(e) { console.error('Draft call failed (' + model + '):', e.message); return { text: null, ref: false }; }
      }

      // Opus 4.8 FIRST for the draft: it's less refusal-prone, so it usually succeeds in ONE
      // call. Going Sonnet-first risked a refusal on payment-heavy corporate leads, which then
      // fell back to Opus = two stacked calls (~40s+) that the browser dropped ("Network issue"
      // client-side though the server returned 200). Sonnet is only a last-resort if Opus errors.
      let dr = await callDraft('claude-opus-4-8');
      if (!dr.text && !dr.ref) dr = await callDraft('claude-sonnet-5');
      if (dr.ref) { res.status(200).json({ error: 'The AI declined this draft (rare). Try again.' }); return; }
      if (!dr.text) { res.status(200).json({ error: 'Could not draft the messages — try again.' }); return; }

      let drafts = null;
      try {
        const blocks = dr.text.match(/```json\s*([\s\S]*?)```/gi);
        let js = null;
        if (blocks && blocks.length) js = blocks[blocks.length - 1].replace(/```json\s*/i, '').replace(/```$/, '');
        else { const s = dr.text.indexOf('{'); const e = dr.text.lastIndexOf('}'); if (s !== -1 && e > s) js = dr.text.slice(s, e + 1); }
        if (js) drafts = JSON.parse(js);
      } catch(e) { console.error('Draft parse failed:', e.message); }

      if (!drafts) { res.status(200).json({ success: true, drafts: null, raw: dr.text }); return; }
      res.status(200).json({ success: true, drafts });
      return;
    }

    // POST action=callprep -> a plain-text call prep brief for an upcoming call with this
    // lead, meant to be copy-pasted straight into Shine's notes app. Reuses whatever research
    // has already been cached client-side (no fresh web_search here, so this stays fast) plus
    // the actual message history, so it doesn't re-ask anything already answered.
    if (req.method === 'POST' && req.body.action === 'callprep') {
      const lead = req.body.lead || {};
      const rc = req.body.research || {};

      const CALLPREP_SYSTEM = `You are helping Shine Thankappan, a corporate mentalist and magician based in Austin, TX, prepare for an upcoming phone call with a lead or client. Given everything known about them (event details, notes, any prior research, and the actual message history below), write a short CALL PREP brief he can paste straight into his notes app and glance at right before the call.

Ground everything in the actual details given. Never invent facts, availability, or budget numbers that aren't implied by the research/notes. If something important is unknown (no research on file, thin notes), say so plainly instead of guessing.

CRITICAL — never invent a specific time, date, or number. If a call time, price, or other concrete detail was proposed or confirmed anywhere in the message history below, quote that exact value, word for word, don't paraphrase it into a different number. If it's genuinely ambiguous or was never stated, say so explicitly (e.g. "confirm the exact time you two land on") rather than picking a plausible-sounding placeholder.

Shine's corporate floor is $2,500, his standard corporate anchor is $3,500. Use the research's recommended anchor/affordability read if given; otherwise fall back to these defaults and say you're using the default.

Output PLAIN TEXT ONLY (no markdown asterisks/bold, this is pasted into a plain notes app). Use exactly this shape:

SNAPSHOT
2-4 lines: who they are, the event, date, guest count, venue, and the budget/affordability read. IMPORTANT: scan the message history for any specific price/rate Shine already stated in writing (an email or text he sent). If one exists, state it explicitly here, and flag clearly if it may need revising, e.g. it was quoted for a different guest count or scope than what's now confirmed. Don't let an old written number get contradicted for free on the call.

QUESTIONS TO ASK
3-6 bullets ("- " prefix), close-blocking questions first (payment process/PO or decision authority, timing/logistics specific to their venue or organization), then personalization questions (tone, names, details to weave in). Do NOT re-ask anything they already answered in the message history below.

HOW TO CLOSE
2-4 bullets: the price to lead with and how to frame it given their budget sensitivity (reconcile it with any already-quoted number from the SNAPSHOT above), plus the concrete next step to push for on the call.

HARD STYLE RULE: absolutely no em dashes (—). Use commas, periods, or "to".`;

      const userPrompt = [
        `Lead name: ${lead.name || '(unknown)'}`,
        `Event type: ${lead.event_type || '(unspecified)'}`,
        lead.event_date ? `Event date: ${lead.event_date}` : '',
        lead.guests ? `Guests: ${lead.guests}` : '',
        lead.venue ? `Venue: ${lead.venue}` : '',
        lead.status ? `Current status: ${lead.status}` : '',
        lead.notes ? `Notes: ${lead.notes}` : '',
        '',
        rc && (rc.company || rc.person || rc.affordability || rc.recommendedAnchor || rc.fit)
          ? [
              'PRIOR RESEARCH ON FILE:',
              rc.company ? `Company: ${rc.company}` : '',
              rc.person ? `Person: ${rc.person}` : '',
              rc.affordability ? `Affordability: ${rc.affordability}` : '',
              rc.recommendedAnchor ? `Recommended anchor: ${rc.recommendedAnchor}` : '',
              rc.priceRange ? `Price range: ${rc.priceRange}` : '',
              rc.fit ? `Fit/strategy: ${rc.fit}` : ''
            ].filter(Boolean).join('\n')
          : '(No prior research on file for this lead.)'
      ].filter(Boolean).join('\n') + (await fetchLeadConversation(lead.clientId));

      let text = '';
      try {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 900, system: CALLPREP_SYSTEM, messages: [{ role: 'user', content: userPrompt }] })
        });
        const data = await resp.json();
        if (!resp.ok || data.error) throw new Error(data && data.error && data.error.message || 'Model error');
        if (data.stop_reason === 'refusal') { res.status(200).json({ error: 'The AI declined this one (rare). Try again.' }); return; }
        if (Array.isArray(data.content)) data.content.forEach(b => { if (b.type === 'text') text += b.text; });
      } catch(e) {
        console.error('Call prep failed:', e.message);
        res.status(200).json({ error: 'Could not generate the call prep brief — try again.' });
        return;
      }

      if (!text.trim()) { res.status(200).json({ error: 'Could not generate the call prep brief — try again.' }); return; }
      res.status(200).json({ success: true, brief: text.trim() });
      return;
    }

    // POST action=triage -> scan the whole active pipeline in ONE call and suggest concrete
    // next actions (follow up, call instead of text, mark lost, etc), ranked most urgent first.
    // Frontend sends a compact per-lead summary (status, hours since Shine last heard from
    // them, event proximity, hot flag, short notes) rather than full message history, so this
    // stays fast and cheap even as the lead list grows.
    if (req.method === 'POST' && req.body.action === 'triage') {
      const leads = Array.isArray(req.body.leads) ? req.body.leads : [];
      if (!leads.length) { res.status(200).json({ success: true, items: [] }); return; }

      const TRIAGE_SYSTEM = `You are triaging Shine Thankappan's active client/lead pipeline (a mentalist and magician based in Austin, TX). You get a compact list of leads/clients: their status, how many hours since Shine last heard from them, their event date and how many days away it is, guest count, whether he's flagged them hot, the source, and short notes.

Decide which ones need an action from Shine RIGHT NOW, and say exactly what to do. Guidance:
- A quiet lead is more urgent the closer their event date is, and more urgent if flagged hot.
- Word the action specifically to the situation, don't just say "follow up" every time: sometimes it's a follow-up text/email, sometimes "call instead of text, it's been too long for another message", sometimes "this one looks dead, consider marking it lost so it stops cluttering the list", sometimes "their event is in N days and they haven't signed the contract, this is urgent."
- A booked/contract_sent/intake_sent lead going quiet with an event date coming up soon is a real business risk, not just an admin nag. Flag those high.
- Skip anything that does not need action right now (recently contacted within a normal window, nothing pending on Shine's side, or already fully wrapped up).
- Never invent facts not present in the data given, and never invent a specific date/time/number.

HARD STYLE RULE: absolutely no em dashes (—). Use commas, periods, or "to".

Return ONLY a single fenced JSON code block (\`\`\`json ... \`\`\`) and nothing else, with this exact shape:
{"items": [{"clientId": "...", "urgency": "high"|"medium"|"low", "action": "one specific, concrete next step, imperative voice, under ~20 words", "reason": "one short clause grounding it in the actual facts given"}]}
Order items most urgent first (high, then medium, then low). Omit any lead that does not need action.`;

      const userPrompt = 'LEADS:\n' + leads.map(function(l) {
        return '- id:' + l.clientId + ' name:"' + (l.name || '') + '" status:' + (l.statusLabel || l.status || '') +
          ' hoursSinceContact:' + (l.hoursSinceContact != null ? l.hoursSinceContact : 'n/a') +
          ' hot:' + (l.hot ? 'yes' : 'no') +
          ' eventDate:' + (l.eventDate || 'n/a') + ' daysToEvent:' + (l.daysToEvent != null ? l.daysToEvent : 'n/a') +
          ' guests:' + (l.guests || 'n/a') + ' source:' + (l.leadSource || 'n/a') +
          ' notes:"' + String(l.notes || '').replace(/"/g, "'").slice(0, 200) + '"';
      }).join('\n');

      let text = '';
      try {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: Math.min(4000, 500 + leads.length * 150), system: TRIAGE_SYSTEM, messages: [{ role: 'user', content: userPrompt }] })
        });
        const data = await resp.json();
        if (!resp.ok || data.error) throw new Error(data && data.error && data.error.message || 'Model error');
        if (data.stop_reason === 'refusal') { res.status(200).json({ error: 'The AI declined this one (rare). Try again.' }); return; }
        if (Array.isArray(data.content)) data.content.forEach(b => { if (b.type === 'text') text += b.text; });
      } catch(e) {
        console.error('Triage failed:', e.message);
        res.status(200).json({ error: 'Could not run the triage — try again.' });
        return;
      }

      let items = null;
      try {
        const blocks = text.match(/```json\s*([\s\S]*?)```/gi);
        let js = null;
        if (blocks && blocks.length) js = blocks[blocks.length - 1].replace(/```json\s*/i, '').replace(/```$/, '');
        else { const s = text.indexOf('{'); const e = text.lastIndexOf('}'); if (s !== -1 && e > s) js = text.slice(s, e + 1); }
        if (js) items = (JSON.parse(js) || {}).items;
      } catch(e) { console.error('Triage parse failed:', e.message); }

      if (!Array.isArray(items)) { res.status(200).json({ error: 'Could not read the triage results — try again.' }); return; }
      res.status(200).json({ success: true, items });
      return;
    }

    res.status(400).json({ error: 'Unknown action' });

  } catch(e) {
    console.error('pending-replies error:', e);
    res.status(500).json({ error: e.message });
  }
}
