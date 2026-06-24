export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
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

      const result = pending.map(m => ({
        id: m.id,
        clientId: m.client_id,
        clientName: clientsById[m.client_id] || 'Unknown',
        channel: m.channel,
        toAddress: m.to_address,
        draft: m.content,
        createdAt: m.created_at
      }));

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
- Sign off as: Shine, The Mentalist | +1 (612) 865-7681
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
          system: systemPrompt,
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
          body: new URLSearchParams({ From: process.env.TWILIO_FROM, To: message.to_address, Body: finalText }).toString()
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

    res.status(400).json({ error: 'Unknown action' });

  } catch(e) {
    console.error('pending-replies error:', e);
    res.status(500).json({ error: e.message });
  }
}
