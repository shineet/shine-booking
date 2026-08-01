import crypto from 'node:crypto';

const ALLOWED_TABLES = new Set(['clients', 'messages', 'bookings', 'app_settings', 'gigs']);

const SB_HDR = () => ({
  'apikey': process.env.SUPABASE_SECRET_KEY,
  'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
  'Content-Type': 'application/json',
});

// Returns the current date (optionally offset by days) as YYYY-MM-DD in Central time,
// matching the plain-date format bookings.event_date is stored in.
function centralDateString(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// Reads the hour (0-23) out of a free-text start time like "7 PM", "11:30am", "2-3 PM".
// Returns null if it can't be confidently parsed -- callers should treat that as "late"
// (afternoon/evening), the safer default since it still gets a same-day reminder rather
// than none at all.
function parseStartHour(timeStr) {
  if (!timeStr) return null;
  const cleaned = String(timeStr).trim().toLowerCase();
  const firstPart = cleaned.split('-')[0].trim();
  const match = firstPart.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  let meridiem = match[3];
  if (!meridiem) {
    const fullMatch = cleaned.match(/(am|pm)/);
    if (fullMatch) meridiem = fullMatch[1];
  }
  if (isNaN(hour) || hour > 23 || !meridiem) return null;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return hour;
}

const REMINDER_SUBJECT = 'Show day reminder';

// Fired by two Vercel Cron jobs (see vercel.json): a 9am Central "morning" run that
// reminds clients whose show is TODAY and isn't early (>= noon, or unparseable time --
// defaulting unknown times to this bucket means they still get a same-day heads-up
// rather than silently missing one), and a 5pm Central "evening" run the day before
// that catches morning/noon shows, since a 9am-same-day reminder would land too close
// to an early start time to be useful.
async function sendReminders(req, res) {
  const auth = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const run = req.query.run === 'evening' ? 'evening' : 'morning';
  const targetDate = run === 'evening' ? centralDateString(1) : centralDateString(0);

  const results = { run, targetDate, sent: [], skipped: [], errors: [] };

  try {
    const bRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings?event_date=eq.${targetDate}&contract_status=eq.signed&select=*`, {
      headers: SB_HDR(),
    });
    const bookings = await bRes.json();
    if (!Array.isArray(bookings)) throw new Error('Unexpected bookings response');

    for (const booking of bookings) {
      const hour = parseStartHour(booking.start_time);
      const isEarly = hour !== null && hour < 12;
      // Morning run only handles non-early (afternoon/evening/unknown) shows;
      // evening run only handles early (morning/noon) shows for tomorrow.
      if (run === 'morning' && isEarly) { results.skipped.push({ id: booking.id, reason: 'early show, handled by evening run' }); continue; }
      if (run === 'evening' && !isEarly) { results.skipped.push({ id: booking.id, reason: 'not an early show' }); continue; }

      try {
        // Dedup: skip if we already sent this booking's reminder recently.
        if (booking.client_id) {
          const dupRes = await fetch(
            `${process.env.SUPABASE_URL}/rest/v1/messages?client_id=eq.${booking.client_id}&email_subject=eq.${encodeURIComponent(REMINDER_SUBJECT)}&order=created_at.desc&limit=1`,
            { headers: SB_HDR() }
          );
          const dupRows = await dupRes.json().catch(() => []);
          if (Array.isArray(dupRows) && dupRows[0]) {
            const sentAt = new Date(dupRows[0].created_at).getTime();
            if (Date.now() - sentAt < 3 * 86400000) { results.skipped.push({ id: booking.id, reason: 'already sent' }); continue; }
          }
        }

        const firstName = (booking.client_name || 'there').split(' ')[0];
        const smsText = `Hi ${firstName}, this is Shine -- all set for tomorrow's show! I'll arrive about 15 minutes early to get set up before we start. Looking forward to it!`;
        const emailText = `Hi ${firstName},\n\nJust a quick note ahead of tomorrow's event -- everything is set on my end and I'm looking forward to it!\n\nI'll plan to arrive about 15 minutes before the show start time to get set up, so we're ready to go right on schedule.\n\nIf anything changes or you need to reach me before then, just reply to this email or call/text me at (737) 271-5308.\n\nSee you tomorrow!\n\n– Shine, The Mentalist`;

        let clientPhone = null;
        if (booking.client_id) {
          const cRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${booking.client_id}&select=phone`, { headers: SB_HDR() });
          const cRows = await cRes.json().catch(() => []);
          if (Array.isArray(cRows) && cRows[0]) clientPhone = cRows[0].phone || null;
        }

        const sentChannels = [];

        if (booking.client_email) {
          const emailRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
            body: JSON.stringify({
              from: 'Shine, The Mentalist <shine@texasmentalist.com>',
              to: booking.client_email,
              bcc: ['shinethementalist@gmail.com'],
              subject: 'All set for tomorrow!',
              text: emailText,
            }),
          });
          if (emailRes.ok) {
            sentChannels.push('email');
            if (booking.client_id) {
              await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
                method: 'POST', headers: SB_HDR(),
                body: JSON.stringify({
                  client_id: booking.client_id, channel: 'email', direction: 'outbound',
                  content: emailText, status: 'sent', to_address: booking.client_email,
                  email_subject: REMINDER_SUBJECT,
                }),
              });
            }
          }
        }

        if (clientPhone && process.env.TWILIO_SID) {
          const normPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? '+1' + d : (d.length === 11 && d[0] === '1' ? '+' + d : (String(p || '').startsWith('+') ? p : '+' + d)); };
          const twRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`, {
            method: 'POST',
            headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ From: process.env.TWILIO_FROM, To: normPhone(clientPhone), Body: smsText }).toString(),
          });
          if (twRes.ok) {
            sentChannels.push('sms');
            if (booking.client_id) {
              await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
                method: 'POST', headers: SB_HDR(),
                body: JSON.stringify({
                  client_id: booking.client_id, channel: 'sms', direction: 'outbound',
                  content: smsText, status: 'sent', to_address: normPhone(clientPhone),
                  email_subject: REMINDER_SUBJECT,
                }),
              });
            }
          }
        }

        if (sentChannels.length) {
          results.sent.push({ id: booking.id, client: booking.client_name, channels: sentChannels });
        } else {
          results.skipped.push({ id: booking.id, reason: 'no email or phone on file' });
        }
      } catch (bookingErr) {
        results.errors.push({ id: booking.id, error: bookingErr.message });
      }
    }

    res.status(200).json(results);
  } catch (e) {
    console.error('send-reminders error:', e);
    res.status(500).json({ error: e.message, ...results });
  }
}

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
    const { bid, mode } = req.query;

    if (mode === 'send-reminders') {
      return await sendReminders(req, res);
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

    // mode=invoice -> for invoice-view.html (stable client-facing invoice/pay link)
    if (mode === 'invoice') {
      res.status(200).json({
        clientId: booking.client_id,
        clientEmail: booking.client_email,
        clientName: booking.client_name,
        fee: booking.fee,
        depositPaid: !!booking.deposit_paid,
        paidInFull: !!booking.paid_in_full,
        paymentAmount: booking.payment_amount || null,
        eventDate: booking.event_date,
        eventTitle: booking.event_title,
        venueAddress: booking.venue_address
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
