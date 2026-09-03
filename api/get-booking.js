import crypto from 'node:crypto';

// family_events is read-only in practice: it is written by the Mac-side
// note agent (tools/family-note-sync), and the dashboard only reads it to
// warn about clashes. Added here rather than as a new endpoint because
// Vercel Hobby caps this project at 12 serverless functions and api/ is
// already at 12 -- a 13th file fails the build.
const ALLOWED_TABLES = new Set(['clients', 'messages', 'bookings', 'app_settings', 'gigs', 'family_events', 'family_note']);

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

// Same definition of "active gig" as gig-dashboard.html's upcoming-list filter --
// a booking counts if it has an event date and hasn't been marked done/dead, regardless
// of whether a contract was ever sent (Shine often books without one).
const DONE_STATUSES = ['completed', 'lost', 'cancelled'];

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
    const bRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings?event_date=eq.${targetDate}&select=*`, {
      headers: SB_HDR(),
    });
    const allBookings = await bRes.json();
    if (!Array.isArray(allBookings)) throw new Error('Unexpected bookings response');
    const bookings = allBookings.filter(b => !DONE_STATUSES.includes(String(b.status || '').toLowerCase()));

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
        // The morning run's targetDate is TODAY (non-early shows), the evening run's is
        // TOMORROW (early shows caught the night before) -- the wording has to match which
        // one actually fired, or a same-day reminder ends up telling the client the show is
        // tomorrow when it's actually today (real incident: 2026-08-06, Rachel's show).
        const dayWord = run === 'morning' ? 'today' : 'tomorrow';
        const smsText = `Hi ${firstName}, this is Shine -- all set for ${dayWord}'s show! I'll arrive about 15 minutes early to get set up before we start. Looking forward to it!`;
        const emailText = `Hi ${firstName},\n\nJust a quick note ahead of ${dayWord}'s event -- everything is set on my end and I'm looking forward to it!\n\nI'll plan to arrive about 15 minutes before the show start time to get set up, so we're ready to go right on schedule.\n\nIf anything changes or you need to reach me before then, just reply to this email or call/text me at (737) 271-5308.\n\nSee you ${dayWord}!\n\n– Shine, The Mentalist`;

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
              subject: `All set for ${dayWord}!`,
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

    // Piggybacked on this same daily cron (morning run only, so it fires once/day) rather
    // than a separate schedule -- texts Shine himself if any active gig falls in the next
    // 2 calendar days, a closer-in heads-up than the Monday weekly summary.
    results.headsUp = run === 'morning' ? await sendUpcomingHeadsUp() : { sent: false, reason: 'evening run, heads-up already handled by morning' };

    res.status(200).json(results);
  } catch (e) {
    console.error('send-reminders error:', e);
    res.status(500).json({ error: e.message, ...results });
  }
}

// Shine's own cell -- same number api/reply.js already recognizes as the personal-phone-forward
// sender, kept in sync with that hardcoded value rather than a new env var.
const SHINE_PHONE = '+16128657681';

// Like parseStartHour, but also accepts a bare 24-hour "H:MM"/"HH:MM" value with no am/pm
// suffix (the format normalizeTime() elsewhere in this file writes, and what some bookings
// -- e.g. Jacquie's, "20:30" -- are actually stored as). parseStartHour alone returns null
// for those since it requires an am/pm marker somewhere in the string.
function parseAnyHour(timeStr) {
  if (!timeStr) return null;
  const bare = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (bare) {
    const h = parseInt(bare[1], 10);
    return (h >= 0 && h <= 23) ? h : null;
  }
  return parseStartHour(timeStr);
}

// Human-readable time for the weekly summary sentence. Converts a bare 24-hour value
// ("20:30") to "8:30 PM"; anything already free text ("8 PM", "2-3 PM") is passed through
// as-is since it's presumably already readable.
function formatTimeLabel(timeStr) {
  if (!timeStr) return null;
  const raw = String(timeStr).trim();
  const bare = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!bare) return raw;
  const hour = parseInt(bare[1], 10);
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  const meridiem = hour < 12 ? 'AM' : 'PM';
  return `${displayHour}:${bare[2]} ${meridiem}`;
}

// One full sentence per show, with whatever detail is actually on file -- type, venue, fee
// are each optional clauses so a sparsely-filled booking (like Jacquie's) still reads clean.
function formatShowSentence(b) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long' }).format(new Date(b.event_date + 'T12:00:00Z'));
  const monthDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric' }).format(new Date(b.event_date + 'T12:00:00Z'));
  const time = formatTimeLabel(b.start_time);
  const label = b.event_title || b.client_name || 'Untitled event';
  const typePrefix = b.event_type ? `${b.event_type} for ` : '';
  const timePart = time ? ` at ${time}` : '';
  const venuePart = b.venue_address ? ` at ${b.venue_address}` : '';
  const feeNum = Number(b.fee);
  const feePart = (b.fee !== null && b.fee !== undefined && b.fee !== '' && !isNaN(feeNum)) ? `, fee $${feeNum.toLocaleString()}` : '';
  return `${weekday}, ${monthDay}${timePart}: ${typePrefix}${label}${venuePart}${feePart}.`;
}

// Shared by both personal-digest sends below (Monday weekly summary + the daily 2-day
// heads-up) -- fetches active gigs with event_date in [rangeStart, rangeEnd], sentence-
// formats them, and texts Shine. Tagged so it's unmistakable at a glance in the same
// thread as forwarded client texts (this and the client-forward path in reply.js share
// one Twilio number, by design -- Shine chose to keep it on Twilio rather than a second
// number or a carrier gateway). Never throws; callers get a { sent: false, ... } result.
async function sendShineDigest(rangeStart, rangeEnd, tag) {
  const bRes = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/bookings?event_date=gte.${rangeStart}&event_date=lte.${rangeEnd}&select=*`,
    { headers: SB_HDR() }
  );
  const allBookings = await bRes.json();
  if (!Array.isArray(allBookings)) return { sent: false, error: 'Unexpected bookings response' };
  const bookings = allBookings.filter(b => !DONE_STATUSES.includes(String(b.status || '').toLowerCase()));

  if (!bookings.length) return { sent: false, count: 0, reason: 'no active gigs in range' };

  bookings.sort((a, b) => {
    if (a.event_date !== b.event_date) return a.event_date < b.event_date ? -1 : 1;
    const ah = parseAnyHour(a.start_time), bh = parseAnyHour(b.start_time);
    if (ah === null && bh === null) return 0;
    if (ah === null) return 1;
    if (bh === null) return -1;
    return ah - bh;
  });

  const sentences = bookings.map(formatShowSentence);
  const smsText = `${tag} (${bookings.length} show${bookings.length > 1 ? 's' : ''}):\n${sentences.join('\n')}`;

  const twRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: process.env.TWILIO_FROM, To: SHINE_PHONE, Body: smsText }).toString(),
  });

  if (!twRes.ok) {
    const twErr = await twRes.text();
    return { sent: false, count: bookings.length, twilioError: twErr };
  }
  return { sent: true, count: bookings.length };
}

// Fired by a third Vercel Cron job (see vercel.json), Monday mornings. Texts Shine himself
// a heads-up of the active gigs on the calendar Mon-Sun that week, so he has a prep reminder
// at the top of the week -- separate from the per-client day-before reminders above. Sends
// nothing (silent no-op) if the week has no active gigs, per Shine's ask ("if I have some
// shows that week").
async function sendWeeklySummary(req, res) {
  const auth = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const todayStr = centralDateString(0);
    // getUTCDay() on a fixed-noon-UTC Date is a safe way to read the weekday of a plain
    // Y-M-D calendar date without any local-timezone parsing ambiguity. 0=Sun..6=Sat.
    const todayWeekday = new Date(todayStr + 'T12:00:00Z').getUTCDay();
    const daysSinceMonday = (todayWeekday + 6) % 7; // Mon=0, Tue=1, ... Sun=6
    const weekStart = centralDateString(-daysSinceMonday);
    const weekEnd = centralDateString(-daysSinceMonday + 6);

    const result = await sendShineDigest(weekStart, weekEnd, 'WEEKLY PREP');
    res.status(200).json({ weekStart, weekEnd, ...result });
  } catch (e) {
    console.error('send-weekly-summary error:', e);
    res.status(500).json({ error: e.message });
  }
}

// Called from sendReminders' morning run (not a separate cron -- Shine asked for this to
// ride the existing daily job). Texts Shine himself if any active gig falls in the next 2
// calendar days (tomorrow or the day after), a closer-in nudge than the Monday weekly
// summary. No dedup: if a show stays inside this 2-day window across two consecutive
// mornings, he'll get pinged both days -- treated as a feature (a reminder that gets more
// insistent as the date nears), not a bug. Revisit if that turns out to be annoying.
async function sendUpcomingHeadsUp() {
  try {
    const rangeStart = centralDateString(1);
    const rangeEnd = centralDateString(2);
    const result = await sendShineDigest(rangeStart, rangeEnd, 'HEADS UP: next 2 days');
    return { rangeStart, rangeEnd, ...result };
  } catch (e) {
    console.error('send-upcoming-heads-up error:', e);
    return { sent: false, error: e.message };
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

// A separate, weaker credential for the family page (family.html), so Shine's
// wife can edit the shared note without the dashboard password -- which would
// also open the leads/revenue dashboard. A family token is scoped in the db
// proxy to just the note (and reading gigs), nothing else.
function makeFamilyToken() {
  return crypto.createHash('sha256')
    .update(String(process.env.FAMILY_PIN || '') + '|' + String(process.env.SUPABASE_SECRET_KEY || '') + '|family')
    .digest('hex');
}
function familyTokenValid(t) {
  if (!t || typeof t !== 'string' || !process.env.FAMILY_PIN) return false;
  const a = Buffer.from(t);
  const b = Buffer.from(makeFamilyToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// What a family token is allowed to touch: the note freely, gigs read-only.
function familyAllowed(table, method) {
  if (table === 'family_note') return true;
  if (table === 'bookings' && method === 'GET') return true;
  return false;
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

    if (body.action === 'family_login') {
      if (!process.env.FAMILY_PIN) {
        res.status(500).json({ error: 'FAMILY_PIN is not set on the server.' });
        return;
      }
      const supplied = Buffer.from(String(body.pin || ''));
      const real = Buffer.from(String(process.env.FAMILY_PIN));
      const ok = supplied.length === real.length && crypto.timingSafeEqual(supplied, real);
      if (!ok) { res.status(401).json({ error: 'Wrong PIN.' }); return; }
      res.status(200).json({ token: makeFamilyToken() });
      return;
    }

    if (body.action === 'db') {
      const path = String(body.path || '');
      const table = path.split(/[?/]/)[0];
      const method = String(body.method || 'GET').toUpperCase();
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) { res.status(405).json({ error: 'Method not allowed' }); return; }
      // Full dashboard token: any allowed table. Family token: note + gigs only.
      const isFull = tokenValid(body.token);
      const isFamily = !isFull && familyTokenValid(body.token);
      if (!isFull && !isFamily) { res.status(401).json({ error: 'Unauthorized' }); return; }
      if (isFamily && !familyAllowed(table, method)) { res.status(403).json({ error: 'Not allowed for this login' }); return; }
      if (isFull && !ALLOWED_TABLES.has(table)) { res.status(403).json({ error: 'Table not allowed: ' + table }); return; }

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
    // TEMPORARY -- backfill Michela's three texts of 2026-09-03, lost when the
    // inbound save sat on the far side of a Claude call that threw (fixed in
    // e9a3047). Takes NO input beyond the secret: the phone number and the three
    // message bodies are fixed below, so the worst this can do if found is write
    // the same three rows twice -- and it checks for that too. REMOVE after use.
    if (body.action === 'backfill-once') {
      if (body.secret !== 'xenJB11OCeSzYkEjj_nW1OJ79R5qtx97') { res.status(401).json({ error: 'Unauthorized' }); return; }
      const digits = '2105013400';
      const cRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?phone=like.*${digits}&select=id,name,phone`, { headers: SB_HDR() });
      const clients = await cRes.json();
      if (!Array.isArray(clients) || !clients[0]) { res.status(404).json({ error: 'No client for that number', got: clients }); return; }
      const client = clients[0];
      const existing = await (await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?client_id=eq.${client.id}&select=id,direction,content`, { headers: SB_HDR() })).json();
      const bodies = [
        'hi! My name is Michela! Im interested in booking for my Halloween Party in Austin',
        'It would be october 31st, around 10pm at my house (located in north austin) \u{1F60A}',
        'im expecting around 20 - 30 people at this time',
      ];
      const already = Array.isArray(existing) ? existing.map(m => String(m.content || '')) : [];
      const rows = bodies
        .map((content, i) => ({
          client_id: client.id, channel: 'sms', direction: 'inbound', content,
          status: 'received', to_address: null,
          // 3:28pm Central, seconds apart so the dashboard's created_at sort
          // keeps them in the order she actually sent them.
          created_at: new Date(Date.UTC(2026, 8, 3, 20, 28, i * 2)).toISOString(),
        }))
        .filter(r => !already.includes(r.content));
      if (!rows.length) { res.status(200).json({ ok: true, inserted: 0, note: 'already present', client }); return; }
      const insRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
        method: 'POST', headers: { ...SB_HDR(), 'Prefer': 'return=representation' }, body: JSON.stringify(rows),
      });
      const insText = await insRes.text();
      res.status(insRes.ok ? 200 : 500).json({ ok: insRes.ok, client, inserted: rows.length, body: insText.slice(0, 500) });
      return;
    }

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

    // Register (or refresh) an APNs device token for push notifications. Gated
    // on the dashboard token so only the signed-in app can register a device.
    // Upsert on the token itself so re-registering the same device is idempotent.
    if (body.action === 'register-push') {
      if (!tokenValid(body.token)) { res.status(401).json({ error: 'Unauthorized' }); return; }
      const deviceToken = String(body.deviceToken || '').trim();
      if (!deviceToken) { res.status(400).json({ error: 'deviceToken required' }); return; }
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/device_tokens?on_conflict=token`, {
        method: 'POST',
        headers: {
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates',
        },
        body: JSON.stringify([{
          token: deviceToken,
          platform: body.platform || 'ios',
          environment: body.environment || 'sandbox',
          last_seen: new Date().toISOString(),
        }]),
      });
      res.status(200).json({ success: true });
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

    if (mode === 'send-weekly-summary') {
      return await sendWeeklySummary(req, res);
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
