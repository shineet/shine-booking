export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const {
      bookingId, clientId, clientName, clientEmail, eventType,
      eventTitle, venueAddress, eventDate, startTime, endTime, duration, fee
    } = req.body;

    if (!bookingId || !clientName || !clientEmail || !venueAddress || !eventDate || !fee) {
      res.status(400).json({ error: 'Missing required contract fields' });
      return;
    }

    // Update the existing booking record (created at intake step) with final contract details
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings?id=eq.${bookingId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
      },
      body: JSON.stringify({
        event_title: eventTitle,
        venue_address: venueAddress,
        event_date: eventDate,
        start_time: startTime,
        end_time: endTime,
        duration: duration,
        fee: fee,
        contract_status: 'sent'
      })
    });

    const contractLink = `https://shine-booking.vercel.app/contract.html?bid=${bookingId}`;

    // Email contract link to client
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
      body: JSON.stringify({
        from: 'Shine, The Mentalist <shine@texasmentalist.com>',
        to: clientEmail,
        subject: 'Your performance agreement — please sign',
        text: `Hi ${clientName.split(' ')[0]},\n\nThanks for sharing all the event details! Please review and sign the performance agreement here:\n\n${contractLink}\n\nLooking forward to your event!\n\nShine, The Mentalist\n+1 (612) 865-7681\nwww.texasmentalist.com`
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
          status: 'contract_sent',
          last_activity: new Date().toISOString(),
          notes: `Contract sent: ${contractLink}`
        })
      });
    }

    res.status(200).json({ success: true, bookingId, contractLink });

  } catch(e) {
    console.error('send-contract error:', e);
    res.status(500).json({ error: e.message });
  }
}
