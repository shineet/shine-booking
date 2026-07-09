// Shared Stripe helpers — plain fetch against the Stripe REST API (no SDK), matching
// how the rest of this app talks to Twilio/Resend/Anthropic. Lives in /lib so it is
// bundled into the functions that import it and is NOT counted as a Vercel function.

const STRIPE_API = 'https://api.stripe.com/v1';

// Build an application/x-www-form-urlencoded body from a flat map, skipping empties.
function form(obj) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    usp.append(k, String(v));
  }
  return usp.toString();
}

export function stripeConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

// Create a one-time hosted Checkout Session and return { url, id }.
export async function createCheckoutSession({
  amountCents, label, description, customerEmail,
  bookingId, clientId, type, successUrl, cancelUrl, extraMetadata
}) {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing).');
  const amt = Math.round(Number(amountCents));
  if (!amt || amt < 50) throw new Error('Amount too small.'); // Stripe minimum is 50 cents

  const params = {
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: customerEmail,
    'line_items[0][quantity]': 1,
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': amt,
    'line_items[0][price_data][product_data][name]': label || 'Performance payment',
    'line_items[0][price_data][product_data][description]': description,
    'metadata[bookingId]': bookingId,
    'metadata[clientId]': clientId,
    'metadata[type]': type || 'payment',
    // mirror onto the PaymentIntent so it also shows in the payment record
    'payment_intent_data[metadata][bookingId]': bookingId,
    'payment_intent_data[metadata][type]': type || 'payment'
  };
  if (extraMetadata && typeof extraMetadata === 'object') {
    for (const k of Object.keys(extraMetadata)) {
      const v = extraMetadata[k];
      if (v !== undefined && v !== null && v !== '') params['metadata[' + k + ']'] = String(v);
    }
  }
  const body = form(params);

  const r = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error('Stripe: ' + ((data.error && data.error.message) || ('HTTP ' + r.status)));
  return { url: data.url, id: data.id };
}

// Re-fetch a Checkout Session straight from Stripe. Used by the webhook to VERIFY a
// payment really happened (a forged webhook event can't survive this, because only our
// secret key can read our own sessions), so we don't need a webhook signing secret.
export async function retrieveSession(id) {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured.');
  const r = await fetch(`${STRIPE_API}/checkout/sessions/${encodeURIComponent(id)}`, {
    headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` }
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error('Stripe: ' + ((data.error && data.error.message) || ('HTTP ' + r.status)));
  return data;
}
