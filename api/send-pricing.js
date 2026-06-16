export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const { clientId, clientName, phone, email, lastChannel, pricingLink } = req.body;

    const message = `Hi! Here are my show packages and pricing: ${pricingLink} — Shine, The Mentalist`;
    const emailText = `Hi ${clientName},\n\nHere's a link to my packages and pricing — you can view all three options and what's included:\n\n${pricingLink}\n\nFeel free to reach out if you have any questions!\n\nShine, The Mentalist\n+1 (612) 865-7681\nwww.texasmentalist.com`;

    let sent = false;
    const channel = lastChannel || (phone ? 'sms' : 'email');

    // Send via SMS if that's the channel they used
    if (channel === 'sms' && phone) {
      const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`;
      const twilioAuth = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64');
      const twilioRes = await fetch(twilioUrl, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${twilioAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: process.env.TWILIO_FROM, To: phone, Body: message }).toString()
      });
      const twilioData = await twilioRes.json();
      if (!twilioData.error_code) sent = true;
    }

    // Send via email if that's the channel they used
    if (channel === 'email' && email) {
      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
        body: JSON.stringify({
          from: 'Shine, The Mentalist <shine@texasmentalist.com>',
          to: email,
          subject: 'My show packages & pricing',
          text: emailText
        })
      });
      const resendData = await resendRes.json();
      if (resendData.id) sent = true;
    }

    // Update Supabase status
    if (clientId) {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${clientId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
        },
        body: JSON.stringify({
          status: 'pricing_sent',
          notes: `Pricing link sent: ${pricingLink}`,
          last_activity: new Date().toISOString()
        })
      });
    }

    res.status(200).json({ sent, channel, pricingLink });

  } catch(e) {
    console.error('Send pricing error:', e);
    res.status(500).json({ error: e.message });
  }
}
