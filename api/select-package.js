export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const { clientId, name, contact, category, tier, label, price } = req.body;

    const selectionNote = `Selected package: ${category === 'corporate' ? 'Corporate' : 'Private'} — ${label} ($${price})`;
    let finalClientId = clientId || null;
    let finalClientName = name;
    let finalClientEmail = null;
    let finalEventType = category === 'corporate' ? 'Corporate event' : 'Private celebration';

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
          status: 'package_selected',
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
          status: 'package_selected',
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
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_KEY}`
      },
      body: JSON.stringify({
        from: 'Shine Booking Assistant <shine@texasmentalist.com>',
        to: 'shinethementalist@gmail.com',
        subject: `🎯 ${notifyName} selected the ${label} package!`,
        text: `Great news!\n\n${notifyName} selected:\n${category === 'corporate' ? 'Corporate' : 'Private'} — ${label}\nPrice: $${price}\n\nContact: ${notifyContact}\n\nThey haven't confirmed they want to book yet — once they do (via chat reply), I'll automatically send the questionnaire. You can also send it manually from the dashboard if needed.`
      })
    });

    res.status(200).json({ success: true });

  } catch(e) {
    console.error('Select package error:', e);
    res.status(500).json({ error: e.message });
  }
}
