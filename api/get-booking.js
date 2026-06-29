export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

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

    // TEMP one-off (token-gated): decode inbound email messages stored as a raw,
    // unreadable base64 block. Base64-only on purpose — readable quoted-printable
    // messages are left alone. Dry-run unless apply=1. Remove after running.
    if (req.query.fixenc === 'enc-fix-9f3a7c-2026') {
      // Pull the leading run of base64 chars (handles a trailing truncation marker
      // appended by the old capping code). Returns decoded text, or the original if
      // it is not a base64 blob / does not decode to mostly-printable text.
      function decodeLeadingBase64(s) {
        const raw = String(s || "");
        const m = raw.match(/^[A-Za-z0-9+/\r\n]{24,}={0,2}/);
        if (!m) return s;
        let b64 = m[0].replace(/\s+/g, "");
        b64 = b64.slice(0, b64.length - (b64.length % 4));
        if (b64.length < 24) return s;
        try {
          const out = Buffer.from(b64, "base64").toString("utf-8");
          const p = out.replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, "");
          return p.length >= out.length * 0.8 ? out : s;
        } catch (e) { return s; }
      }
      const hdrs = { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` };
      const mr = await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?channel=eq.email&direction=eq.inbound&select=id,content,client_id,created_at&order=created_at.desc&limit=200`, { headers: hdrs });
      const msgs = await mr.json();
      if (req.query.debug === '1') {
        const diag = (Array.isArray(msgs) ? msgs : []).map(m => {
          const c = m.content || '';
          const t = c.replace(/\s+/g, '');
          return { id: m.id, client_id: m.client_id, created_at: m.created_at, len: c.length, noSpace: !/ /.test(c.trim()), mod4: t.length % 4, head: (m.id==="80b2259f-9716-40d3-a6fe-91270ebab790"? c : c.slice(0,50)), wouldDecode: decodeLeadingBase64(c) !== c };
        });
        res.status(200).json({ scanned: diag.length, diag });
        return;
      }
      const changes = [];
      for (const m of (Array.isArray(msgs) ? msgs : [])) {
        const orig = m.content || '';
        let dec = orig;
        dec = decodeLeadingBase64(orig);
        if (dec !== orig) {
          changes.push({ id: m.id, client_id: m.client_id, before: orig.slice(0, 60), after: dec.slice(0, 120) });
          if (req.query.apply === '1') {
            await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?id=eq.${m.id}`, {
              method: 'PATCH', headers: { ...hdrs, 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: dec })
            });
          }
        }
      }
      res.status(200).json({ applied: req.query.apply === '1', scanned: Array.isArray(msgs) ? msgs.length : 0, changedCount: changes.length, changes });
      return;
    }

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
