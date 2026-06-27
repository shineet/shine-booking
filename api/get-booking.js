export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // TEMP read-only (token-gated) — list Maggie's Twilio inbound vs what's in the DB. Remove after.
  if (req.query.twiliocheck === '16774083175a705e990689c71b2cec0b') {
    const PHONE = '+16109086678';
    try {
      const sid = process.env.TWILIO_SID;
      const auth = Buffer.from(`${sid}:${process.env.TWILIO_TOKEN}`).toString('base64');
      // Messages SHE sent to the Twilio number (inbound)
      const tw = await (await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json?From=${encodeURIComponent(PHONE)}&PageSize=50`, { headers: { 'Authorization': `Basic ${auth}` } })).json();
      const inbound = (tw.messages || []).map(m => ({ sid: m.sid, date: m.date_sent || m.date_created, body: m.body }));

      const supaHeaders = { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` };
      const base = `${process.env.SUPABASE_URL}/rest/v1`;
      const last10 = p => { const d = String(p || '').replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; };
      let client = null;
      const all = await (await fetch(`${base}/clients?select=*&order=created_at.desc`, { headers: supaHeaders })).json();
      if (Array.isArray(all)) client = all.find(c => last10(c.phone) === last10(PHONE)) || null;
      let dbInbound = [];
      if (client) {
        const msgs = await (await fetch(`${base}/messages?client_id=eq.${client.id}&direction=eq.inbound&select=id,content,created_at&order=created_at.asc`, { headers: supaHeaders })).json();
        if (Array.isArray(msgs)) dbInbound = msgs.map(m => ({ id: m.id, created_at: m.created_at, content: m.content }));
      }
      const dbBodies = dbInbound.map(m => (m.content || '').trim());
      const missing = inbound.filter(m => !dbBodies.includes((m.body || '').trim()));

      let inserted = [];
      if (req.query.apply === '1' && client && missing.length) {
        for (const m of missing) {
          let createdAt; try { createdAt = new Date(m.date).toISOString(); } catch { createdAt = undefined; }
          const row = { client_id: client.id, channel: 'sms', direction: 'inbound', content: m.body, status: 'received', to_address: null };
          if (createdAt) row.created_at = createdAt;
          const ins = await fetch(`${base}/messages`, { method: 'POST', headers: { ...supaHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=representation' }, body: JSON.stringify([row]) });
          const insBody = await ins.json();
          inserted.push({ ok: ins.ok, id: Array.isArray(insBody) ? insBody[0]?.id : null, body: m.body, detail: ins.ok ? undefined : insBody });
        }
        // Bump client so the newest activity surfaces
        const newest = missing.map(m => { try { return new Date(m.date).toISOString(); } catch { return null; } }).filter(Boolean).sort().pop();
        await fetch(`${base}/clients?id=eq.${client.id}`, { method: 'PATCH', headers: { ...supaHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ last_channel: 'sms', last_activity: newest || undefined }) });
      }

      res.status(200).json({ client_id: client?.id || null, twilio_inbound_count: inbound.length, db_inbound_count: dbInbound.length, missing_count: missing.length, missing, inserted });
      return;
    } catch (e) { res.status(500).json({ error: e.message }); return; }
  }

  function normalizeTime(value) {
    if (!value) return value;
    const match = String(value).trim().match(/^(\d{1,2})(?::(\d{1,2}))?/);
    if (!match) return value;
    let hours = parseInt(match[1], 10);
    let minutes = match[2] !== undefined ? parseInt(match[2], 10) : 0;
    if (isNaN(hours)) return value;
    if (isNaN(minutes)) minutes = 0;
    hours = Math.min(Math.max(hours, 0), 23);
    minutes = Math.min(Math.max(minutes, 0), 59);
    return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
  }

  try {
    const { bid, mode } = req.query;
    if (!bid) {
      res.status(400).json({ error: 'Missing booking id' });
      return;
    }

    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings?id=eq.${bid}&limit=1`, {
      headers: {
        'apikey': process.env.SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
      }
    });
    const rows = await r.json();
    const booking = Array.isArray(rows) ? rows[0] : null;

    if (!booking) {
      res.status(404).json({ error: 'Booking not found' });
      return;
    }

    const answers = booking.intake_answers || {};

    // mode=full -> for intake.html (name + event type + event date + any previously saved answers)
    if (mode === 'full') {
      res.status(200).json({
        clientName: booking.client_name,
        eventType: booking.event_type,
        eventDate: booking.event_date || '',
        savedAnswers: answers
      });
      return;
    }

    // mode=contract -> for the contract review modal in dashboard
    if (mode === 'contract') {
      res.status(200).json({
        bookingId: booking.id,
        clientName: booking.client_name,
        clientEmail: booking.client_email,
        eventType: booking.event_type,
        fee: booking.fee,
        venueAddress: booking.venue_address || answers.q_address || '',
        eventDate: answers.q_event_date || booking.event_date || '',
        startTime: normalizeTime(booking.start_time || answers.q_start_time || ''),
        indoorOutdoor: answers.q_indoor_outdoor || '',
        guests: answers.q_guests || ''
      });
      return;
    }

    // mode=answers -> for dashboard "View answers" modal
    if (mode === 'answers') {
      res.status(200).json({
        clientName: booking.client_name,
        eventType: booking.event_type,
        intakeCompletedAt: booking.intake_completed_at,
        answers: answers
      });
      return;
    }

    // default mode -> for contract.html signing page
    const eventDateFormatted = booking.event_date
      ? new Date(booking.event_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : 'TBD';

    res.status(200).json({
      clientName: booking.client_name,
      venueAddress: booking.venue_address,
      eventTitle: booking.event_title,
      eventDate: eventDateFormatted,
      startTime: booking.start_time,
      duration: booking.duration,
      fee: booking.fee,
      todayDate: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    });

  } catch(e) {
    console.error('get-booking error:', e);
    res.status(500).json({ error: e.message });
  }
}
