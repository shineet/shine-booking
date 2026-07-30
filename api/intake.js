// api/intake.js
// Merges send-intake.js and submit-intake.js into one serverless function.
// POST { action: 'send', clientId, clientName, clientEmail, eventType, fee }
// POST { action: 'submit', bookingId, answers }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { action } = req.body;

  if (action === 'send') {
    // ── formerly send-intake.js ───────────────────────────────────────────────
    try {
      let { clientId, clientName, clientEmail, clientPhone, eventType, fee, channel } = req.body;
      if (!clientName || (!clientEmail && !clientPhone)) {
        return res.status(400).json({ error: 'Missing client name and contact info' });
      }

      function normalizePhone(phone) {
        if (!phone) return phone;
        var digits = phone.replace(/[^0-9]/g, '');
        if (digits.length === 10) return '+1' + digits;
        if (digits.length === 11 && digits[0] === '1') return '+' + digits;
        if (phone.trim().startsWith('+')) return '+' + digits;
        return phone;
      }

      // Fetch live client record for event_date + any existing booking (e.g. from Mark as
      // booked) so this reuses it instead of creating a duplicate.
      let eventDate = null;
      let existingBookingId = null;
      let existingNotes = '';
      if (clientId) {
        const clientRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${clientId}&limit=1`, {
          headers: {
            'apikey': process.env.SUPABASE_SECRET_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
          }
        });
        const clientRows = await clientRes.json();
        const client = Array.isArray(clientRows) ? clientRows[0] : null;
        if (client) {
          eventDate = client.event_date || null;
          existingNotes = client.notes || '';
          existingBookingId = client.booking_id || null;
          // Use phone from client record if not passed in
          if (!clientPhone && client.phone) clientPhone = client.phone;
        }
      }

      // Reuse an existing booking (e.g. one already created by Mark as booked) instead of
      // always inserting a new row -- this used to create a duplicate every time intake was
      // (re)sent, leaving the original orphaned.
      async function insertNewBooking() {
        const bookingRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_SECRET_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
            'Prefer': 'return=representation'
          },
          body: JSON.stringify({
            client_id:       clientId || null,
            client_name:     clientName,
            client_email:    clientEmail,
            event_type:      eventType || '',
            event_date:      eventDate,
            fee:             fee || null,
            contract_status: 'not_sent',
            intake_status:   'sent'
          })
        });
        const bookingRows = await bookingRes.json();
        return Array.isArray(bookingRows) ? bookingRows[0] : null;
      }

      let booking;
      if (existingBookingId) {
        const updateRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings?id=eq.${existingBookingId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_SECRET_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
            'Prefer': 'return=representation'
          },
          body: JSON.stringify({
            client_name:  clientName || undefined,
            client_email: clientEmail || undefined,
            event_type:   eventType || undefined,
            event_date:   eventDate || undefined,
            fee:          fee || undefined,
            intake_status: 'sent'
          })
        });
        const updateRows = await updateRes.json();
        booking = Array.isArray(updateRows) ? updateRows[0] : null;
        // client.booking_id pointed at a row that no longer exists (deleted, or a stale/
        // dangling reference from an earlier failed flow) -- self-heal by creating a fresh
        // booking and re-linking the client, instead of hard-failing every future send.
        if (!booking) {
          console.error(`intake send: client ${clientId}'s booking_id ${existingBookingId} no longer exists -- checking for a concurrent fix before creating a new one`);
          // Guard against a race: "Resend intake" and "Copy link" both hit this same
          // self-heal path, so clicking both in quick succession (while the booking_id
          // is still dangling) used to create two separate replacement bookings -- only
          // one could win the client relink below, leaving the other as an orphaned
          // duplicate. Re-check the client's booking_id right before creating; if another
          // in-flight request already relinked it, reuse that booking instead.
          let booking2 = null;
          if (clientId) {
            const recheckRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${clientId}&select=booking_id&limit=1`, {
              headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` }
            });
            const recheckRows = await recheckRes.json();
            const latestBookingId = Array.isArray(recheckRows) && recheckRows[0] ? recheckRows[0].booking_id : null;
            if (latestBookingId && latestBookingId !== existingBookingId) {
              const reRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings?id=eq.${latestBookingId}&limit=1`, {
                headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` }
              });
              const reRows = await reRes.json();
              booking2 = Array.isArray(reRows) ? reRows[0] : null;
            }
          }
          booking = booking2;
          if (!booking) {
            booking = await insertNewBooking();
            if (!booking) throw new Error('Failed to create booking record');
            if (clientId) {
              await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${clientId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
                body: JSON.stringify({ booking_id: booking.id })
              });
            }
          }
        }
      } else {
        booking = await insertNewBooking();
        if (!booking) throw new Error('Failed to create booking record');
      }

      const intakeLink = `https://shine-booking.vercel.app/intake.html?bid=${booking.id}`;

      const firstName = clientName.split(' ')[0];
      const intakeMessage = `Hi ${firstName}! So excited to be part of your event! Please fill out this short questionnaire so I can personalize your show: ${intakeLink} — Shine, The Mentalist`;

      // channel: 'sms' | 'email' | 'link' (grab link, send nothing) | undefined (send to all on file)
      const wantSms   = channel === 'sms'   || (!channel && clientPhone);
      const wantEmail = channel === 'email' || (!channel && clientEmail);

      const sentLogRows = [];

      if (wantSms && clientPhone) {
        const twilioAuth = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64');
        await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${twilioAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ From: process.env.TWILIO_FROM, To: normalizePhone(clientPhone), Body: intakeMessage }).toString()
        });
        if (clientId) sentLogRows.push({ client_id: clientId, channel: 'sms', direction: 'outbound', content: intakeMessage, status: 'sent', to_address: normalizePhone(clientPhone) });
      }

      const intakeEmailText = `Hi ${firstName},\n\nSo excited to be part of your event! To get everything set up — including your performance agreement — could you fill out this short questionnaire?\n\n${intakeLink}\n\nIt only takes a couple of minutes and helps me personalize the show for you and your guests.\n\nShine, The Mentalist\n+1 (737) 271-5308\nwww.texasmentalist.com`;
      if (wantEmail && clientEmail) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
          body: JSON.stringify({
            from: 'Shine, The Mentalist <shine@texasmentalist.com>',
            to:   clientEmail,
            bcc:  ['shinethementalist@gmail.com'],
            subject: 'Quick questionnaire for your upcoming show',
            text: intakeEmailText
          })
        });
        if (clientId) sentLogRows.push({ client_id: clientId, channel: 'email', direction: 'outbound', content: intakeEmailText, status: 'sent', to_address: clientEmail, email_subject: 'Quick questionnaire for your upcoming show' });
      }

      // Log whatever actually went out so it shows in the conversation thread --
      // this send previously wasn't logged at all, same gap as the pricing modal.
      if (sentLogRows.length) {
        try {
          await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
            body: JSON.stringify(sentLogRows)
          });
        } catch (logErr) {
          console.error('Intake message log failed:', logErr.message);
        }
      }

      // Update client status
      if (clientId) {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${clientId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_SECRET_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
          },
          body: JSON.stringify({
            status:        'intake_sent',
            booking_id:    booking.id,
            last_activity: new Date().toISOString(),
            // Append rather than overwrite -- this used to wipe out any real notes already
            // on the client (call recaps, context, etc) every time intake was (re)sent.
            notes:         existingNotes ? `${existingNotes}\n\nIntake form sent: ${intakeLink}` : `Intake form sent: ${intakeLink}`
          })
        });
      }

      return res.status(200).json({ success: true, bookingId: booking.id, intakeLink });

    } catch (e) {
      console.error('intake send error:', e);
      return res.status(500).json({ error: e.message });
    }

  } else if (action === 'submit') {
    // ── formerly submit-intake.js ─────────────────────────────────────────────
    try {
      const { bookingId, answers } = req.body;
      if (!bookingId) return res.status(400).json({ error: 'Missing booking id' });

      const venueAddress = answers.q_address || null;
      const startTime    = normalizeTime(answers.q_start_time);

      // Save answers to booking
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings?id=eq.${bookingId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
        },
        body: JSON.stringify({
          intake_status:       'completed',
          intake_answers:      answers,
          intake_completed_at: new Date().toISOString(),
          venue_address:       venueAddress,
          start_time:          startTime
        })
      });

      // Fetch booking for notification + client update
      const bookingRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings?id=eq.${bookingId}&limit=1`, {
        headers: {
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
        }
      });
      const bookingRows = await bookingRes.json();
      const booking = Array.isArray(bookingRows) ? bookingRows[0] : null;

      // Update client status
      if (booking?.client_id) {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${booking.client_id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_SECRET_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
          },
          body: JSON.stringify({
            status:        'intake_completed',
            last_activity: new Date().toISOString()
          })
        });
      }

      // Notify Shine
      const answersText = Object.entries(answers)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
        body: JSON.stringify({
          from:    'Shine Booking Assistant <shine@texasmentalist.com>',
          to:      'shinethementalist@gmail.com',
          subject: `Questionnaire completed: ${booking?.client_name || 'A client'} — ready for contract`,
          text:    `${booking?.client_name || 'A client'} completed their event questionnaire!\n\n${answersText}\n\nThe contract is now ready to send with these details pre-filled — open the app to review and send.\n\nshine-booking.vercel.app`
        })
      });

      return res.status(200).json({ success: true });

    } catch (e) {
      console.error('intake submit error:', e);
      return res.status(500).json({ error: e.message });
    }

  } else if (action === 'webform') {
    // ── direct website contact-form -> lead ───────────────────────────────────
    // Primary path: the Wix contact form POSTs its fields here as clean JSON, so
    // a lead lands on the dashboard instantly without waiting on the email parser.
    // The email-to-parser pipeline (api/email-reply.js) stays on as a fallback and
    // dedupes against leads this branch just created (10-min window, by email).
    try {
      // Optional shared-secret gate. Enforced only once WEBFORM_SECRET is set in
      // Vercel; until then the endpoint works openly so it can be wired + tested.
      const secret = process.env.WEBFORM_SECRET;
      if (secret && req.headers['x-webform-secret'] !== secret) {
        return res.status(401).json({ error: 'unauthorized' });
      }

      const b = req.body || {};
      const clientEmail = (b.email || '').trim();
      if (!clientEmail) return res.status(400).json({ error: 'Missing email' });

      const firstName = (b.firstName || '').trim();
      const lastName  = (b.lastName || '').trim();
      const leadName  = (b.name || [firstName, lastName].filter(Boolean).join(' ') || clientEmail.split('@')[0]).trim();
      const phone     = (b.phone || '').trim() || null;
      const company   = (b.company || '').trim() || null;
      const eventType = normalizeEventType(b.eventType); // map to the dashboard's canonical values
      const guests    = (b.guests || '').toString().trim() || null;
      const messageVal = (b.message || '').trim();
      const rawDate   = (b.eventDate || '').trim();
      const eDate     = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
      const noteLine  = messageVal || `Lead from website contact form${company ? ` — ${company}` : ''}`;

      const supaHdrs = {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
      };

      // Find or create the client keyed on the submitter email
      let client = null;
      try {
        const cRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?email=ilike.${emailIlikeParam(clientEmail)}&order=created_at.desc&limit=1`, { headers: supaHdrs });
        const cRows = await cRes.json();
        client = Array.isArray(cRows) ? (cRows[0] || null) : null;
      } catch (e) { console.error('webform lead lookup failed:', e.message); }

      if (!client) {
        let createRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients`, {
          method: 'POST', headers: { ...supaHdrs, 'Prefer': 'return=representation' },
          body: JSON.stringify([{
            name: leadName, email: clientEmail, phone: phone,
            company: company, event_type: eventType, guests: guests,
            event_date: eDate,
            status: 'new', lead_source: 'Website form', last_channel: 'web',
            last_activity: new Date().toISOString(), notes: noteLine
          }])
        });
        let rows = await createRes.json();
        client = Array.isArray(rows) ? (rows[0] || null) : null;
        // Never drop a lead: if the enriched insert is rejected, retry with only the
        // core columns and fold the extras into notes so nothing is lost.
        if (!client) {
          console.error('webform lead insert failed:', createRes.status, JSON.stringify(rows).slice(0, 300));
          const extras = [company && `Company: ${company}`, eventType && `Event type: ${eventType}`, guests && `Guests: ${guests}`].filter(Boolean).join(' | ');
          createRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients`, {
            method: 'POST', headers: { ...supaHdrs, 'Prefer': 'return=representation' },
            body: JSON.stringify([{
              name: leadName, email: clientEmail, phone: phone, event_date: eDate,
              status: 'new', lead_source: 'Website form', last_channel: 'web',
              last_activity: new Date().toISOString(),
              notes: [noteLine, extras].filter(Boolean).join('\n\n')
            }])
          });
          rows = await createRes.json();
          client = Array.isArray(rows) ? (rows[0] || null) : null;
          if (!client) console.error('webform lead core insert ALSO failed:', createRes.status, JSON.stringify(rows).slice(0, 300));
        }
      } else {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${client.id}`, {
          method: 'PATCH', headers: supaHdrs,
          body: JSON.stringify({ last_activity: new Date().toISOString(), last_channel: 'web' })
        });
      }

      // Log the submission as an inbound message so it shows in the conversation.
      // Only the visitor's actual message — the structured fields (company, event
      // type, guests, phone, date) already live in their own columns, so don't
      // duplicate them here.
      if (client) {
        const convo = messageVal || `Website contact form submission from ${leadName}.`;
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
          method: 'POST', headers: supaHdrs,
          body: JSON.stringify([{ client_id: client.id, channel: 'web', direction: 'inbound', content: convo.slice(0, 4000), status: 'received', to_address: null, email_subject: 'Website contact form' }])
        });
      }

      // Notify Shine
      await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
        body: JSON.stringify({
          from: 'Shine Booking Assistant <shine@texasmentalist.com>',
          to: 'shinethementalist@gmail.com',
          subject: `✨ New website lead: ${leadName}`,
          text: `A new lead came in from your website contact form and is now on your dashboard.\n\nName: ${leadName}\nEmail: ${clientEmail}\n${company ? 'Company: ' + company + '\n' : ''}${eventType ? 'Event type: ' + eventType + '\n' : ''}${eDate ? 'Event date: ' + eDate + '\n' : ''}${guests ? 'Guests: ' + guests + '\n' : ''}${phone ? 'Phone: ' + phone + '\n' : ''}${messageVal ? '\nMessage: ' + messageVal + '\n' : ''}\nReply from the dashboard:\nshine-booking.vercel.app`
        })
      });

      return res.status(200).json({ success: true, leadCreated: !!client, clientId: client?.id || null });
    } catch (e) {
      console.error('webform lead handling failed:', e.message);
      return res.status(500).json({ error: e.message });
    }

  } else {
    return res.status(400).json({ error: 'Invalid action. Use "send", "submit", or "webform".' });
  }
}

// Map a free-form event type (e.g. the Wix form's "Corporate Event") to the
// dashboard's canonical option values so the Edit dropdown matches and displays
// it. Case-insensitive; unknown values pass through unchanged so nothing is lost.
// Postgres eq. is case-sensitive and mail clients aren't consistent about From-header
// casing between messages, so an exact-match lookup can miss an existing client and
// create a duplicate lead. ilike matches case-insensitively; % and _ are escaped since
// ilike treats them as wildcards.
function emailIlikeParam(email) {
  return encodeURIComponent(String(email || '').trim().replace(/[%_\\]/g, function(m) { return '\\' + m; }));
}

function normalizeEventType(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  const CANONICAL = ['Birthday party', 'Bachelorette party', 'Bachelor party', 'Wedding', 'Corporate event', 'School / Education Event', 'Graduation', 'Baby Shower', 'Private celebration', 'Anniversary', 'Other'];
  const hit = CANONICAL.find(function (t) { return t.toLowerCase() === s.toLowerCase(); });
  return hit || s;
}

function normalizeTime(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{1,2})(?::(\d{1,2}))?/);
  if (!match) return value;
  let hours   = parseInt(match[1], 10);
  let minutes = match[2] !== undefined ? parseInt(match[2], 10) : 0;
  if (isNaN(hours)) return value;
  if (isNaN(minutes)) minutes = 0;
  hours   = Math.min(Math.max(hours, 0), 23);
  minutes = Math.min(Math.max(minutes, 0), 59);
  return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
}
