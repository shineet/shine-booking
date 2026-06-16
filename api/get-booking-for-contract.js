export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { bid } = req.query;
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

    res.status(200).json({
      bookingId: booking.id,
      clientName: booking.client_name,
      clientEmail: booking.client_email,
      eventType: booking.event_type,
      fee: booking.fee,
      venueAddress: booking.venue_address || answers.q_address || '',
      eventDate: answers.q_event_date || '',
      startTime: booking.start_time || answers.q_start_time || '',
      indoorOutdoor: answers.q_indoor_outdoor || '',
      guests: answers.q_guests || ''
    });

  } catch(e) {
    console.error('get-booking-for-contract error:', e);
    res.status(500).json({ error: e.message });
  }
}
