export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // TEMP one-off (token-gated) — backfill Paget's dropped 6/28 inbound email. Remove after.
  if (req.query.backfillpaget === '16774083175a705e990689c71b2cec0b') {
    const supaHeaders = { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` };
    const base = `${process.env.SUPABASE_URL}/rest/v1`;
    const CLIENT_ID = 'fe9f613a-c339-474b-9532-08467699f655';
    const SUBJECT = 'Re: Mentalist for Executive Dinner - Shionogi, July 1st';
    const AT = '2026-06-28T18:41:00Z';
    const MESSAGE = "Hi Shine,\n\nWe are ready to confirm! The event will be held at Quince Lakehouse on Wednesday. I will arrive around 5pm and will send you a text message so we can meet and walk the space.\n\nThe contract has been signed! Unfortunately, we are unable to pay the deposit via Zelle. Do you mind sharing a formal invoice and I will have our accounting department write a check?\n\nThank you!";
    try {
      const existing = await (await fetch(`${base}/messages?client_id=eq.${CLIENT_ID}&direction=eq.inbound&select=id,content`, { headers: supaHeaders })).json();
      if (Array.isArray(existing) && existing.some(m => (m.content || '').includes('unable to pay the deposit via Zelle'))) {
        res.status(200).json({ status: 'already_present' }); return;
      }
      const ins = await fetch(`${base}/messages`, {
        method: 'POST', headers: { ...supaHeaders, 'Prefer': 'return=representation' },
        body: JSON.stringify([{ client_id: CLIENT_ID, channel: 'email', direction: 'inbound', content: MESSAGE, status: 'received', to_address: null, email_subject: SUBJECT, created_at: AT }])
      });
      const insBody = await ins.json();
      if (!ins.ok) { res.status(500).json({ error: 'insert failed', detail: insBody }); return; }
      await fetch(`${base}/clients?id=eq.${CLIENT_ID}`, {
        method: 'PATCH', headers: supaHeaders,
        body: JSON.stringify({ last_activity: AT, last_channel: 'email' })
      });
      res.status(200).json({ status: 'inserted', message_id: Array.isArray(insBody) ? insBody[0]?.id : null });
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
