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
          const bookingId = md.bookingId || '';
          const type      = md.type || 'payment';
          const amount    = (session.amount_total || 0) / 100;
          const payerEmail = (session.customer_details && session.customer_details.email) || session.customer_email || 'unknown';

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
      successUrl: `${APP_BASE}/payment-success.html`,
      cancelUrl: `${APP_BASE}/payment-success.html?canceled=1`
    });

    res.status(200).json({ success: true, url: session.url, id: session.id });
  } catch (e) {
    console.error('create-payment error:', e);
    res.status(500).json({ error: e.message });
  }
}
