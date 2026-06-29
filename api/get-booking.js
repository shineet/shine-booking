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
      function looksLikeBase64Block(s) {
        const raw = String(s || '').trim();
        if (/ /.test(raw)) return false;
        const t = raw.replace(/\s+/g, '');
        return t.length >= 24 && t.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(t);
      }
      function decodeBase64Body(s) {
        try { const out = Buffer.from(String(s).replace(/\s+/g, ''), 'base64').toString('utf-8');
          const p = out.replace(/[^\x09\x0A\x0D\x20-\x7E -￿]/g, ''); return p.length >= out.length * 0.8 ? out : s; } catch (e) { return s; }
      }
      const hdrs = { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` };
      const mr = await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?channel=eq.email&direction=eq.inbound&select=id,content,client_id&order=created_at.desc&limit=200`, { headers: hdrs });
      const msgs = await mr.json();
      const changes = [];
      for (const m of (Array.isArray(msgs) ? msgs : [])) {
        const orig = m.content || '';
        let dec = orig;
        if (looksLikeBase64Block(orig)) dec = decodeBase64Body(orig);
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
