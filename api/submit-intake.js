export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  function normalizeTime(value) {
    if (!value) return null;
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
    const { bookingId, answers } = req.body;
    if (!bookingId) {
      res.status(400).json({ error: 'Missing booking id' });
      return;
    }

    // Map intake answers to contract-relevant fields
    const venueAddress = answers.q_address || null;
    const startTime = normalizeTime(answers.q_start_time);

    // Save answers and mapped fields to booking record
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings?id=eq.${bookingId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
      },
      body: JSON.stringify({
        intake_status: 'completed',
        intake_answers: answers,
        intake_completed_at: new Date().toISOString(),
        venue_address: venueAddress,
        start_time: startTime
      })
    });

    // Get booking details for notification and client update
    const bookingRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings?id=eq.${bookingId}&limit=1`, {
      headers: {
        'apikey': process.env.SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
      }
    });
    const bookingRows = await bookingRes.json();
    const booking = Array.isArray(bookingRows) ? bookingRows[0] : null;

    // Update client status so dashboard shows "Send contract" button next
    if (booking?.client_id) {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${booking.client_id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
        },
        body: JSON.stringify({
          status: 'intake_completed',
          last_activity: new Date().toISOString()
        })
      });
    }

    // Notify Shine
    const answersText = Object.entries(answers)
      .filter(([k, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
      body: JSON.stringify({
        from: 'Shine Booking Assistant <shine@texasmentalist.com>',
        to: 'shinethementalist@gmail.com',
        subject: `Questionnaire completed: ${booking?.client_name || 'A client'} — ready for contract`,
        text: `${booking?.client_name || 'A client'} completed their event questionnaire!\n\n${answersText}\n\nThe contract is now ready to send with these details pre-filled — open the app to review and send.\n\nshine-booking.vercel.app`
      })
    });

    res.status(200).json({ success: true });

  } catch(e) {
    console.error('submit-intake error:', e);
    res.status(500).json({ error: e.message });
  }
}
