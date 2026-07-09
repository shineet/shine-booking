// One function handles BOTH jobs (to stay within Vercel's 12-function limit):
//   1. POST {action:'create', ...}      -> make a Checkout link (dashboard button / email senders)
//   2. POST from Stripe (webhook)        -> a payment completed; mark the booking paid + notify Shine
// The webhook is detected by the `stripe-signature` header Stripe always sends. We verify
// authenticity by re-fetching the session from Stripe (see lib/stripe.js), so no webhook
// signing secret is required — you only ever set STRIPE_SECRET_KEY.

import { createCheckoutSession, retrieveSession } from '../lib/stripe.js';

const APP_BASE = 'https://shine-booking.vercel.app';

function sbHeaders() {
  return {
    'apikey': process.env.SUPABASE_SECRET_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
  };
}

function normalizePhone(phone) {
  if (!phone) return phone;
  const d = String(phone).replace(/[^0-9]/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return String(phone).trim().startsWith('+') ? '+' + d : phone;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, stripe-signature');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  // ── Webhook path (Stripe posts here) ──────────────────────────────────────
  if (req.headers['stripe-signature']) {
    try {
      let event = req.body;
      if (typeof event === 'string') { try { event = JSON.parse(event); } catch (e) { event = {}; } }

      if (event && event.type === 'checkout.session.completed' && event.data && event.data.object) {
        // Verify by re-reading the session from Stripe (don't trust the posted body).
        let session = null;
        try { session = await retrieveSession(event.data.object.id); }
        catch (e) { console.error('Session re-fetch failed:', e.message); }

        if (session && session.payment_status === 'paid') {
          const md        = session.metadata || {};
          let   bookingId = md.bookingId || '';
          const type      = md.type || 'payment';
          const amount    = (session.amount_total || 0) / 100;
          const payerEmail = (session.customer_details && session.customer_details.email) || session.customer_email || 'unknown';

          // Pricing-page "Pay deposit & book": the payment gates the booking. Reuse
          // select-package (marks booked, creates the booking, sends the intake), then
          // read the booking it linked to the client so we can mark the deposit below.
          if (md.bookOnPay === '1' && md.clientId) {
            try {
              await fetch(`${APP_BASE}/api/select-package`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  clientId: md.clientId,
                  name: md.name || undefined,
                  contact: md.contact || undefined,
                  category: md.category || undefined,
                  tier: md.tier || undefined,
                  label: md.label || undefined,
                  price: md.price ? Number(md.price) : undefined,
                  format: md.format || undefined,
                  strollingDurationMinutes: md.dur ? Number(md.dur) : undefined,
                  readyToBook: true
                })
              });
            } catch (e) { console.error('bookOnPay select-package call failed:', e.message); }
            try {
              const cRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${md.clientId}&select=booking_id&limit=1`, { headers: sbHeaders() });
              const cRows = await cRes.json();
              if (Array.isArray(cRows) && cRows[0] && cRows[0].booking_id) bookingId = cRows[0].booking_id;
            } catch (e) { console.error('bookOnPay booking lookup failed:', e.message); }
          }

          if (bookingId) {
            const patch = {
              deposit_paid: true, // any successful payment satisfies the deposit
              paid_at: new Date().toISOString(),
              payment_amount: amount,
              payment_type: type,
              stripe_session_id: session.id
            };
            if (type === 'full') patch.paid_in_full = true;
            try {
              await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings?id=eq.${bookingId}`, {
                method: 'PATCH',
                headers: { ...sbHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify(patch)
              });
            } catch (e) { console.error('Booking mark-paid failed:', e.message); }
          }

          try {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
              body: JSON.stringify({
                from: 'Shine Booking Assistant <shine@texasmentalist.com>',
                to: 'shinethementalist@gmail.com',
                subject: `💵 Payment received: $${amount} (${type})`,
                text: `A ${type} payment of $${amount} just came in via Stripe.\n\nFrom: ${payerEmail}\nBooking: ${bookingId || 'n/a'}\n\n${bookingId ? 'The booking is now marked paid on your dashboard.' : '(No booking id on this payment — mark it manually.)'}\n\nshine-booking.vercel.app`
              })
            });
          } catch (e) { console.error('Payment notify failed:', e.message); }
        }
      }
      // Always 200 so Stripe doesn't keep retrying.
      res.status(200).json({ received: true });
    } catch (e) {
      console.error('Stripe webhook error:', e);
      res.status(200).json({ received: true, error: e.message });
    }
    return;
  }

  // ── Create-link path (our dashboard / email senders) ──────────────────────
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    // Send an already-generated payment link to the client by email or SMS (branded + logged).
    if (body.action === 'send-link') {
      const url = body.url;
      const channel = body.send === 'sms' ? 'sms' : 'email';
      if (!url) { res.status(400).json({ error: 'Missing url' }); return; }

      let email = body.clientEmail || '', phone = body.clientPhone || '', name = body.clientName || '';
      if (body.clientId) {
        try {
          const cr = await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${body.clientId}&select=email,phone,name&limit=1`, { headers: sbHeaders() });
          const rows = await cr.json();
          if (Array.isArray(rows) && rows[0]) {
            email = email || rows[0].email || '';
            phone = phone || rows[0].phone || '';
            name  = name  || rows[0].name  || '';
          }
        } catch (e) { console.error('client lookup for send-link failed:', e.message); }
      }
      const eventName = body.eventName || 'your event';
      const firstName = (name || 'there').split(' ')[0];

      if (channel === 'email') {
        if (!email) { res.status(400).json({ error: 'No email on file for this client.' }); return; }
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
          body: JSON.stringify({
            from: 'Shine, The Mentalist <shine@texasmentalist.com>',
            to: email,
            subject: `Payment link — ${eventName}`,
            text: `Hi ${firstName},\n\nHere's a secure link to pay for ${eventName}:\n${url}\n\nThank you!\nShine, The Mentalist\n(737) 271-5308`,
            html: `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#1a1a2e"><p>Hi ${firstName},</p><p>Here's a secure link to pay for <strong>${eventName}</strong>:</p><div style="text-align:center;margin:24px 0"><a href="${url}" style="background:#1a7f5a;color:#fff;padding:13px 30px;border-radius:6px;text-decoration:none;font-size:15px;font-weight:bold;display:inline-block">💳 Pay online</a></div><p style="font-size:12px;color:#6b7280">Or open: <a href="${url}">${url}</a></p><p>Thank you!<br>Shine, The Mentalist<br>(737) 271-5308</p></div>`
          })
        });
        if (!r.ok) { const t = await r.text(); res.status(500).json({ error: 'Email failed: ' + t.slice(0, 150) }); return; }
      } else {
        if (!phone) { res.status(400).json({ error: 'No phone number on file for this client.' }); return; }
        const twilioAuth = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64');
        const smsBody = `Hi ${firstName}, here's a secure link to pay for ${eventName} and lock in your date: ${url} — Shine, The Mentalist`;
        const tw = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${twilioAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ From: process.env.TWILIO_FROM, To: normalizePhone(phone), Body: smsBody }).toString()
        });
        if (!tw.ok) { const t = await tw.text(); res.status(500).json({ error: 'SMS failed: ' + t.slice(0, 150) }); return; }
      }

      if (body.clientId) {
        try {
          await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
            method: 'POST', headers: { ...sbHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: body.clientId, channel, direction: 'outbound', content: 'Payment link sent: ' + url, status: 'sent', to_address: channel === 'email' ? email : normalizePhone(phone) })
          });
        } catch (e) { console.error('log payment-link message failed:', e.message); }
      }
      res.status(200).json({ success: true, sent: channel });
      return;
    }

    if (body.action !== 'create') { res.status(400).json({ error: 'Unknown action' }); return; }

    const amountDollars = Number(body.amountDollars);
    if (!amountDollars || amountDollars <= 0) { res.status(400).json({ error: 'A positive amount is required.' }); return; }

    const type  = body.type === 'full' ? 'full' : 'deposit';
    const label = body.label || (type === 'deposit' ? 'Event deposit' : 'Performance fee');

    const session = await createCheckoutSession({
      amountCents: Math.round(amountDollars * 100),
      label,
      description: body.description || undefined,
      customerEmail: body.clientEmail || undefined,
      bookingId: body.bookingId || '',
      clientId: body.clientId || '',
      type,
      extraMetadata: (body.extraMetadata && typeof body.extraMetadata === 'object') ? body.extraMetadata : undefined,
      successUrl: body.successUrl || `${APP_BASE}/payment-success.html`,
      cancelUrl: body.cancelUrl || `${APP_BASE}/payment-success.html?canceled=1`
    });

    res.status(200).json({ success: true, url: session.url, id: session.id });
  } catch (e) {
    console.error('create-payment error:', e);
    res.status(500).json({ error: e.message });
  }
}
