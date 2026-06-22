export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const {
      bookingId, clientId, clientName, clientEmail, eventType,
      eventTitle, venueAddress, clientAddress, eventDate, startTime, duration, fee
    } = req.body;

    if (!clientName || !clientEmail || !venueAddress || !eventDate || !fee) {
      res.status(400).json({ error: 'Missing required contract fields' });
      return;
    }

    let resolvedBookingId = bookingId;

    if (resolvedBookingId) {
      // Update the existing booking record (created at intake step)
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings?id=eq.${resolvedBookingId}`, {
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
          duration: duration,
          fee: fee,
          contract_status: 'sent'
        })
      });
    } else {
      // No intake form was submitted — create a fresh bookings row now
      const createRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          client_id: clientId,
          client_name: clientName,
          client_email: clientEmail,
          event_type: eventType || '',
          event_title: eventTitle,
          venue_address: venueAddress,
          event_date: eventDate,
          start_time: startTime,
          duration: duration,
          fee: fee,
          contract_status: 'sent',
          intake_status: 'completed'  // skipped intake — mark as complete so it doesn't show as pending
        })
      });
      if (!createRes.ok) {
        const errText = await createRes.text();
        throw new Error('Could not create booking record: ' + errText);
      }
      const newBooking = await createRes.json();
      resolvedBookingId = newBooking[0]?.id;
      if (!resolvedBookingId) throw new Error('Booking created but no ID returned');

      // Link the new booking back to the client record
      if (clientId) {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${clientId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_SECRET_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
          },
          body: JSON.stringify({ booking_id: resolvedBookingId })
        });
      }
    }

    const contractLink = `https://shine-booking.vercel.app/contract.html?bid=${resolvedBookingId}${clientAddress ? '&caddr=' + encodeURIComponent(clientAddress) : ''}`;

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

    res.status(200).json({ success: true, bookingId: resolvedBookingId, contractLink });

  } catch(e) {
    console.error('send-contract error:', e);
    res.status(500).json({ error: e.message });
  }
}
