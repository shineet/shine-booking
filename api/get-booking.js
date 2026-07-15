import crypto from 'node:crypto';

const ALLOWED_TABLES = new Set(['clients', 'messages', 'bookings', 'app_settings', 'gigs']);

// Session token = one-way hash of the dashboard password + the server secret key.
// Reveals nothing if intercepted; only matches if the holder logged in with the real password.
function makeToken() {
  return crypto.createHash('sha256')
    .update(String(process.env.DASHBOARD_PASSWORD || '') + '|' + String(process.env.SUPABASE_SECRET_KEY || ''))
    .digest('hex');
}
function tokenValid(t) {
  if (!t || typeof t !== 'string' || !process.env.DASHBOARD_PASSWORD) return false;
  const a = Buffer.from(t);
  const b = Buffer.from(makeToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // ── Dashboard auth + Supabase proxy (POST) ──────────────────────────────────
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    if (body.action === 'login') {
      if (!process.env.DASHBOARD_PASSWORD) {
        res.status(500).json({ error: 'DASHBOARD_PASSWORD is not set on the server.' });
        return;
      }
      const supplied = Buffer.from(String(body.password || ''));
      const real = Buffer.from(String(process.env.DASHBOARD_PASSWORD));
      const ok = supplied.length === real.length && crypto.timingSafeEqual(supplied, real);
      if (!ok) { res.status(401).json({ error: 'Wrong password.' }); return; }
      res.status(200).json({ token: makeToken() });
      return;
    }

    if (body.action === 'db') {
      if (!tokenValid(body.token)) { res.status(401).json({ error: 'Unauthorized' }); return; }
      const path = String(body.path || '');
      const table = path.split(/[?/]/)[0];
      if (!ALLOWED_TABLES.has(table)) { res.status(403).json({ error: 'Table not allowed: ' + table }); return; }
      const method = String(body.method || 'GET').toUpperCase();
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) { res.status(405).json({ error: 'Method not allowed' }); return; }

      const opts = {
        method,
        headers: {
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': body.prefer || 'return=representation',
        },
      };
      if (body.body !== undefined && body.body !== null && method !== 'GET' && method !== 'DELETE') {
        opts.body = JSON.stringify(body.body);
      }
      const sbRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, opts);
      const text = await sbRes.text();
      const cr = sbRes.headers.get('content-range');
      if (cr) res.setHeader('Content-Range', cr);
      res.setHeader('Content-Type', sbRes.headers.get('content-type') || 'application/json');
      res.status(sbRes.status).send(text);
      return;
    }

    // Delete a client + its messages/bookings (was api/delete-client.js; merged here
    // and now token-protected). FK order: messages -> bookings -> client.
    if (body.action === 'delete-client') {
      if (!tokenValid(body.token)) { res.status(401).json({ error: 'Unauthorized' }); return; }
      const clientId = body.clientId;
      if (!clientId) { res.status(400).json({ error: 'clientId required' }); return; }
      const h = {
        'apikey': process.env.SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
      };
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?client_id=eq.${clientId}`, { method: 'DELETE', headers: h });
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings?client_id=eq.${clientId}`, { method: 'DELETE', headers: h });
      const delRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${clientId}`, {
        method: 'DELETE', headers: { ...h, 'Prefer': 'return=representation' }
      });
      if (!delRes.ok) {
        const t = await delRes.text();
        console.error('Client delete failed:', t);
        res.status(500).json({ error: 'Failed to delete client: ' + t });
        return;
      }
      res.status(200).json({ deleted: true });
      return;
    }

    res.status(400).json({ error: 'Unknown action' });
    return;
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
    const { bid, mode, diag } = req.query;
    if (diag === 'fix_dedrah_school_0715b') {
      const h = { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
      if (req.query.commit !== '1') {
        res.status(200).json({ dryRun: true, wouldSet: 'event_type=School / Education Event on booking d31e950c-43bf-4b54-b5fe-0599ef4c3f65' });
        return;
      }
      const r3 = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings?id=eq.d31e950c-43bf-4b54-b5fe-0599ef4c3f65`, {
        method: 'PATCH', headers: h, body: JSON.stringify({ event_type: 'School / Education Event' })
      });
      const rows3 = await r3.json();
      res.status(200).json({ committed: true, rows3 });
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
