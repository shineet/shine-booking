export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const { bookingId, answers } = req.body;
    if (!bookingId) {
      res.status(400).json({ error: 'Missing booking id' });
      return;
    }

    // Save answers to booking record
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
        intake_completed_at: new Date().toISOString()
      })
    });

    // Get booking details for notification
    const bookingRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings?id=eq.${bookingId}&limit=1`, {
      headers: {
        'apikey': process.env.SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
      }
    });
    const bookingRows = await bookingRes.json();
    const booking = Array.isArray(bookingRows) ? bookingRows[0] : null;

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
        subject: `Questionnaire completed: ${booking?.client_name || 'A client'}`,
        text: `${booking?.client_name || 'A client'} completed their event questionnaire!\n\n${answersText}\n\nView full booking in the app:\nshine-booking.vercel.app`
      })
    });

    res.status(200).json({ success: true });

  } catch(e) {
    console.error('submit-intake error:', e);
    res.status(500).json({ error: e.message });
  }
}
