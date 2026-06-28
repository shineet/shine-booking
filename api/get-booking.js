export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // TEMP one-off (token-gated) — tidy Paget's garbled first inbound (decode + set subject). Remove after.
  if (req.query.tidypaget === '16774083175a705e990689c71b2cec0b') {
    const supaHeaders = { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` };
    const base = `${process.env.SUPABASE_URL}/rest/v1`;
    const MSG_ID = 'e72b9f68-c963-4e4c-9395-d2d6bedb4e23';
    const CLEAN = "Begin forwarded message:\n\nFrom: Paget Goldthwait <paget@fifthstreetdmc.com>\nSubject: Mentalist for Executive Dinner - Shionogi, July 1st\nDate: June 16, 2026 at 1:25 PM CDT\nTo: 2020shine@gmail.com, Samantha Lenz <samantha@fifthstreetdmc.com>, Kayla Morgan <kayla@fifthstreetdmc.com>\n\nHi,\n\nI hope you're doing well!\n\nI'm reaching out regarding an upcoming executive dinner event, as we are looking to hire a mentalist for the evening and thought you could be a great fit.\n\nThe event will take place from 5:30 PM to 8:30 PM and will host approximately 45 guests. The dinner will be held at either Juniper or Quince Lakehouse in Austin, with the final venue being confirmed later this week.\n\nThis is a corporate executive dinner, so we are looking for an engaging, polished, and sophisticated experience that encourages guest interaction throughout the evening.\n\nAt this stage, we'd love to know:\n- Your availability for the event date\n- Your typical approach for an executive dinner setting\n- Recommended timing/coverage for a group of this size\n- Pricing information\n\nPlease let me know if this is something you'd be interested in, and I'd be happy to share additional details as they are confirmed.\n\nLooking forward to hearing from you!\n\nBest,\nPaget Goldthwait | Event Producer\nFifth Street DMC\nAustin + Montana's 1st DMC\nC: 617.797.3074 | O: 512.899.8991";
    try {
      const r = await fetch(`${base}/messages?id=eq.${MSG_ID}`, {
        method: 'PATCH', headers: { ...supaHeaders, 'Prefer': 'return=representation' },
        body: JSON.stringify({ content: CLEAN, email_subject: 'Mentalist for Executive Dinner - Shionogi, July 1st' })
      });
      const body = await r.json();
      res.status(r.ok ? 200 : 500).json({ ok: r.ok, updated: Array.isArray(body) ? body.length : 0, detail: r.ok ? undefined : body });
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
