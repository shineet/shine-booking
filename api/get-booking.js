export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // TEMP one-off backfill (token-gated) — inserts Maggie's lost inbound SMS. Remove after running.
  if (req.query.backfill === '16774083175a705e990689c71b2cec0b') {
    const supaHeaders = { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` };
    const base = `${process.env.SUPABASE_URL}/rest/v1`;
    const FROM = '+16109086678';
    const MESSAGE = "Hi Shine! Sorry I am just seeing this message – I love your website and your performances! I am traveling this weekend so I won't be able to chat on the phone, however I can message. What is your quote for a private group of around 20 people? Thank you!";
    const RECEIVED_AT = '2026-06-27T14:00:00Z';
    const last10 = p => { const d = String(p || '').replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; };
    try {
      let client = null;
      const ex = await (await fetch(`${base}/clients?phone=eq.${encodeURIComponent(FROM)}&order=created_at.desc&limit=1`, { headers: supaHeaders })).json();
      client = Array.isArray(ex) ? (ex[0] || null) : null;
      if (!client) {
        const all = await (await fetch(`${base}/clients?select=*&order=created_at.desc`, { headers: supaHeaders })).json();
        if (Array.isArray(all)) client = all.find(c => last10(c.phone) === last10(FROM)) || null;
      }
      if (!client) { res.status(404).json({ error: 'no client matched' }); return; }
      if (client.phone !== FROM) {
        await fetch(`${base}/clients?id=eq.${client.id}`, { method: 'PATCH', headers: { ...supaHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: FROM }) });
      }
      const existing = await (await fetch(`${base}/messages?client_id=eq.${client.id}&direction=eq.inbound&select=id,content`, { headers: supaHeaders })).json();
      if (Array.isArray(existing) && existing.some(m => (m.content || '').trim() === MESSAGE.trim())) {
        res.status(200).json({ status: 'already_present', client_id: client.id, client_name: client.name }); return;
      }
      const ins = await fetch(`${base}/messages`, { method: 'POST', headers: { ...supaHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=representation' }, body: JSON.stringify([{ client_id: client.id, channel: 'sms', direction: 'inbound', content: MESSAGE, status: 'received', to_address: null, created_at: RECEIVED_AT }]) });
      const insBody = await ins.json();
      if (!ins.ok) { res.status(500).json({ error: 'insert failed', detail: insBody }); return; }
      await fetch(`${base}/clients?id=eq.${client.id}`, { method: 'PATCH', headers: { ...supaHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'pricing_requested', last_channel: 'sms', last_activity: RECEIVED_AT }) });
      res.status(200).json({ status: 'inserted', client_id: client.id, client_name: client.name, message_id: Array.isArray(insBody) ? insBody[0]?.id : null });
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
