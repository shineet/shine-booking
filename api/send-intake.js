export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const { clientId, clientName, clientEmail, eventType, fee } = req.body;

    if (!clientName || !clientEmail) {
      res.status(400).json({ error: 'Missing client name or email' });
      return;
    }

    // Create a booking record now — intake answers will fill it in
    const bookingRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        client_id: clientId || null,
        client_name: clientName,
        client_email: clientEmail,
        event_type: eventType || '',
        fee: fee || null,
        contract_status: 'not_sent',
        intake_status: 'sent'
      })
    });
    const bookingRows = await bookingRes.json();
    const booking = Array.isArray(bookingRows) ? bookingRows[0] : null;
    if (!booking) throw new Error('Failed to create booking record');

    const intakeLink = `https://shine-booking.vercel.app/intake.html?bid=${booking.id}`;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
      body: JSON.stringify({
        from: 'Shine, The Mentalist <shine@texasmentalist.com>',
        to: clientEmail,
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
          status: 'intake_sent',
          booking_id: booking.id,
          last_activity: new Date().toISOString(),
          notes: `Intake form sent: ${intakeLink}`
        })
      });
    }

    res.status(200).json({ success: true, bookingId: booking.id, intakeLink });

  } catch(e) {
    console.error('send-intake error:', e);
    res.status(500).json({ error: e.message });
  }
}
