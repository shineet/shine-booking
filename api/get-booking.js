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

  // ── TEMP diagnostic: missed-response check (remove after use) ────────────────
  if (req.method === 'GET' && req.query.diag === '40fbe49ac84170ce6af39805f7bd700d') {
    try {
      const sbHeaders = {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      };
      const [msgsR, clientsR] = await Promise.all([
        fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?select=*&order=created_at.desc&limit=200`, { headers: sbHeaders }),
        fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?select=id,name,phone,email,status,last_channel&limit=1000`, { headers: sbHeaders }),
      ]);
      const msgs = await msgsR.json();
      const clients = await clientsR.json();
      const clientById = {};
      const clientByPhone = {};
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const last10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);
      (clients || []).forEach((c) => { clientById[c.id] = c; const k = last10(c.phone); if (k) clientByPhone[k] = c; });

      // Messages grouped per client (already desc by created_at)
      const msgsByClient = {};
      (msgs || []).forEach((m) => { (msgsByClient[m.client_id] = msgsByClient[m.client_id] || []).push(m); });

      // Latest message per client -> those ending on an inbound are awaiting a reply
      const latestByClient = {};
      for (const m of (msgs || [])) { if (!latestByClient[m.client_id]) latestByClient[m.client_id] = m; }
      const awaitingReplyDb = Object.values(latestByClient)
        .filter((m) => m.direction === 'inbound')
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .map((m) => ({
          client: (clientById[m.client_id] || {}).name || m.client_id,
          status: (clientById[m.client_id] || {}).status,
          channel: m.channel,
          when: m.created_at,
          content: String(m.content || '').slice(0, 240),
        }));

      // Twilio inbound (source of truth for SMS), grouped by sender
      let twilioInbound = [];
      let twilioError = null;
      try {
        const twR = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json?PageSize=100`, {
          headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64') },
        });
        const tw = await twR.json();
        twilioInbound = (tw.messages || []).filter((x) => x.direction === 'inbound')
          .map((x) => ({ from: x.from, body: x.body, date: x.date_sent }));
      } catch (e) { twilioError = e.message; }

      const byFrom = {};
      twilioInbound.forEach((t) => { const k = last10(t.from); (byFrom[k] = byFrom[k] || []).push(t); });
      const smsThreads = Object.keys(byFrom).map((k) => {
        const arr = byFrom[k].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
        const lastIn = arr[arr.length - 1];
        const client = clientByPhone[k];
        const cmsgs = client ? (msgsByClient[client.id] || []) : [];
        const lastInMs = Date.parse(lastIn.date);
        const answered = cmsgs.some((m) => m.direction === 'outbound' && Date.parse(m.created_at) > lastInMs);
        const inDb = cmsgs.some((m) => m.direction === 'inbound' && norm(m.content) === norm(lastIn.body));
        return {
          phone: '+1' + k,
          client: client ? client.name : '(no client record)',
          status: client ? client.status : null,
          inboundCount: arr.length,
          lastInbound: { when: lastIn.date, body: String(lastIn.body).slice(0, 260) },
          repliedAfterLastInbound: answered,
          lastInboundSavedToDb: inDb,
        };
      }).sort((a, b) => (a.repliedAfterLastInbound === b.repliedAfterLastInbound ? 0 : a.repliedAfterLastInbound ? 1 : -1));

      res.status(200).json({
        counts: { messagesScanned: (msgs || []).length, clients: (clients || []).length, twilioInboundFetched: twilioInbound.length },
        smsThreads,
        awaitingReplyDb,
        twilioError,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
    return;
  }

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
