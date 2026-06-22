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
      const { clientId, clientName, clientEmail, eventType, fee } = req.body;
      if (!clientName || !clientEmail) {
        return res.status(400).json({ error: 'Missing client name or email' });
      }

      // Fetch live client record for event_date
      let eventDate = null;
      if (clientId) {
        const clientRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${clientId}&limit=1`, {
          headers: {
            'apikey': process.env.SUPABASE_SECRET_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
          }
        });
        const clientRows = await clientRes.json();
        const client = Array.isArray(clientRows) ? clientRows[0] : null;
        if (client) eventDate = client.event_date || null;
      }

      // Create booking record
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
      const booking = Array.isArray(bookingRows) ? bookingRows[0] : null;
      if (!booking) throw new Error('Failed to create booking record');

      const intakeLink = `https://shine-booking.vercel.app/intake.html?bid=${booking.id}`;

      // Email the client
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
        body: JSON.stringify({
          from: 'Shine, The Mentalist <shine@texasmentalist.com>',
          to:   clientEmail,
          subject: 'Quick questionnaire for your upcoming show',
          text: `Hi ${clientName.split(' ')[0]},\n\nSo excited to be part of your event! To get everything set up — including your performance agreement — could you fill out this short questionnaire?\n\n${intakeLink}\n\nIt only takes a couple of minutes and helps me personalize the show for you and your guests.\n\nShine, The Mentalist\n+1 (612) 865-7681\nwww.texasmentalist.com`
        })
      });

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
            notes:         `Intake form sent: ${intakeLink}`
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

  } else {
    return res.status(400).json({ error: 'Invalid action. Use "send" or "submit".' });
  }
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
