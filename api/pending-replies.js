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

      // Fetch client names for display
      const clientIds = [...new Set(pending.map(m => m.client_id).filter(Boolean))];
      let clientsById = {};
      if (clientIds.length) {
        const idsParam = clientIds.join(',');
        const cRes = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/clients?id=in.(${idsParam})&select=id,name`,
          { headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` } }
        );
        const cRows = await cRes.json();
        if (Array.isArray(cRows)) {
          cRows.forEach(c => { clientsById[c.id] = c.name; });
        }
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

    // POST ?action=toggle -> flip the global review-mode setting
    if (req.method === 'POST' && req.body.action === 'toggle') {
      const { reviewMode } = req.body;
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/app_settings?id=eq.1`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
        },
        body: JSON.stringify({ review_mode: reviewMode, updated_at: new Date().toISOString() })
      });
      res.status(200).json({ success: true, reviewMode });
      return;
    }

    // POST ?action=approve -> send the (possibly edited) reply and mark sent
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
        const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`;
        const twilioAuth = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64');
        await fetch(twilioUrl, {
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
            subject: message.email_subject || 'Re: Your inquiry',
            text: finalText
          })
        });
      }

      await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?id=eq.${messageId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
        },
        body: JSON.stringify({ status: 'sent', content: finalText })
      });

      res.status(200).json({ success: true });
      return;
    }

    // POST ?action=discard -> drop the pending reply without sending
    if (req.method === 'POST' && req.body.action === 'discard') {
      const { messageId } = req.body;
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?id=eq.${messageId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
        },
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
