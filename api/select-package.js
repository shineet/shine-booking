export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const { clientId, name, contact, category, tier, label, price, readyToBook, format, strollingDurationMinutes } = req.body;

    const formatNote = format === 'strolling'
      ? ` (Strolling, ${strollingDurationMinutes ? (strollingDurationMinutes / 60) + 'hr' : ''})`
      : '';
    const selectionNote = `Selected package: ${category === 'corporate' ? 'Corporate' : 'Private'} — ${label}${formatNote} ($${price})`;
    let finalClientId = clientId || null;
    let finalClientName = name;
    let finalClientEmail = null;
    let finalEventType = category === 'corporate' ? 'Corporate event' : 'Private celebration';
    let finalEventDate = null;

    // If we have a clientId, update that client record and fetch its details
    if (clientId) {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${clientId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
        },
        body: JSON.stringify({
          status: readyToBook ? 'booked' : 'package_selected',
          selected_package: label,
          selected_category: category,
          selected_price: price,
          notes: selectionNote,
          last_activity: new Date().toISOString()
        })
      });

      // Fetch full client record so we have email/event_type for the intake send
      const clientRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${clientId}&limit=1`, {
        headers: {
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
        }
      });
      const clientRows = await clientRes.json();
      const client = Array.isArray(clientRows) ? clientRows[0] : null;
      if (client) {
        finalClientName = client.name;
        finalClientEmail = client.email;
        finalEventType = client.event_type || finalEventType;
        finalEventDate = client.event_date || null;
      }
    } else {
      // No clientId in URL — create a new lead from this selection
      const isEmail = (contact || '').includes('@');
      const newClientRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          name: name || 'Unknown (from pricing page)',
          email: isEmail ? contact : null,
          phone: isEmail ? null : contact,
          event_type: finalEventType,
          status: readyToBook ? 'booked' : 'package_selected',
          selected_package: label,
          selected_category: category,
          selected_price: price,
          notes: selectionNote,
          last_activity: new Date().toISOString()
        })
      });
      const newClientRows = await newClientRes.json();
      const newClient = Array.isArray(newClientRows) ? newClientRows[0] : null;
      if (newClient) {
        finalClientId = newClient.id;
        finalClientName = newClient.name;
        finalClientEmail = newClient.email;
      }
    }

    // Notify you immediately
    const notifyName = finalClientName || name || 'A client';
    const notifyContact = finalClientEmail || contact || 'on file';
    const formatLine = format === 'strolling' && strollingDurationMinutes
      ? `\nDuration: ${strollingDurationMinutes / 60} hour${strollingDurationMinutes > 60 ? 's' : ''} of strolling`
      : '';
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_KEY}`
      },
      body: JSON.stringify({
        from: 'Shine Booking Assistant <shine@texasmentalist.com>',
        to: 'shinethementalist@gmail.com',
        subject: readyToBook ? `🎯 ${notifyName} is ready to book!` : `${notifyName} selected the ${label} package`,
        text: readyToBook
          ? `Great news!\n\n${notifyName} selected:\n${category === 'corporate' ? 'Corporate' : 'Private'} — ${label}\nPrice: $${price}${formatLine}\n\nContact: ${notifyContact}\n\nThey confirmed they're ready to book — a thank-you note with the intake questionnaire is being sent automatically.`
          : `${notifyName} selected:\n${category === 'corporate' ? 'Corporate' : 'Private'} — ${label}\nPrice: $${price}${formatLine}\n\nContact: ${notifyContact}\n\nThey chose "I need more time" — not ready to confirm yet. No questionnaire was sent.`
      })
    });

    // If they confirmed they're ready to book, send the thank-you + intake questionnaire now
    if (readyToBook && finalClientEmail) {
      try {
        const bookingRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_SECRET_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
            'Prefer': 'return=representation'
          },
          body: JSON.stringify({
            client_id: finalClientId,
            client_name: finalClientName,
            client_email: finalClientEmail,
            event_type: finalEventType,
            event_date: finalEventDate,
            fee: price || null,
            duration: strollingDurationMinutes ? `${strollingDurationMinutes / 60} hour${strollingDurationMinutes > 60 ? 's' : ''} strolling` : null,
            contract_status: 'not_sent',
            intake_status: 'sent'
          })
        });
        const bookingRows = await bookingRes.json();
        const booking = Array.isArray(bookingRows) ? bookingRows[0] : null;

        if (booking) {
          const intakeLink = `https://shine-booking.vercel.app/intake.html?bid=${booking.id}`;
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
            body: JSON.stringify({
              from: 'Shine, The Mentalist <shine@texasmentalist.com>',
              to: finalClientEmail,
              subject: 'Thank you for booking! Quick questionnaire inside',
              text: `Hi ${finalClientName ? finalClientName.split(' ')[0] : 'there'},\n\nThank you so much for booking — I'm really looking forward to your event!\n\nTo get everything set up, including your performance agreement, could you fill out this short questionnaire?\n\n${intakeLink}\n\nIt only takes a couple of minutes and helps me personalize the show for you and your guests.\n\nShine, The Mentalist\n+1 (612) 865-7681\nwww.texasmentalist.com`
            })
          });

          if (finalClientId) {
            await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${finalClientId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
              body: JSON.stringify({
                status: 'intake_sent',
                booking_id: booking.id,
                last_activity: new Date().toISOString(),
                notes: `Intake form sent: ${intakeLink}`
              })
            });
          }
        }
      } catch (intakeErr) {
        console.error('Send intake on readyToBook failed:', intakeErr);
      }
    }

    res.status(200).json({ success: true });

  } catch(e) {
    console.error('Select package error:', e);
    res.status(500).json({ error: e.message });
  }
}
