export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const { clientId, name, contact, category, tier, label, price } = req.body;

    const selectionNote = `Selected package: ${category === 'corporate' ? 'Corporate' : 'Private'} — ${label} ($${price})`;

    // If we have a clientId, update that client record
    if (clientId) {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${clientId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
        },
        body: JSON.stringify({
          status: 'booked',
          selected_package: label,
          selected_category: category,
          selected_price: price,
          notes: selectionNote,
          last_activity: new Date().toISOString()
        })
      });
    } else {
      // No clientId in URL — create a new lead from this selection
      const isEmail = contact.includes('@');
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
        },
        body: JSON.stringify({
          name: name || 'Unknown (from pricing page)',
          email: isEmail ? contact : null,
          phone: isEmail ? null : contact,
          event_type: category === 'corporate' ? 'Corporate event' : 'Private celebration',
          status: 'booked',
          selected_package: label,
          selected_category: category,
          selected_price: price,
          notes: selectionNote,
          last_activity: new Date().toISOString()
        })
      });
    }

    // Notify you immediately
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_KEY}`
      },
      body: JSON.stringify({
        from: 'Shine Booking Assistant <shine@texasmentalist.com>',
        to: 'shinethementalist@gmail.com',
        subject: `🎯 ${name || 'A client'} selected the ${label} package!`,
        text: `Great news!\n\n${name || 'A client'} selected:\n${category === 'corporate' ? 'Corporate' : 'Private'} — ${label}\nPrice: $${price}\n\nContact: ${contact}\n\nLog in to follow up and send the contract:\nshine-booking.vercel.app`
      })
    });

    res.status(200).json({ success: true });

  } catch(e) {
    console.error('Select package error:', e);
    res.status(500).json({ error: e.message });
  }
}
