// Drives api/select-package.js against a stubbed Supabase, and checks the one
// thing that went wrong in production: whether confirming a booking for someone
// who ALREADY has one creates a second gig.
//
// Isabella, Dec 2026. She paid an advance, the Stripe webhook's bookOnPay path
// called this endpoint with readyToBook, and it inserted a duplicate booking and
// repointed the client at it -- so her questionnaire answers sat on one row and
// her money on the other. Both showed on the Dashboard as separate gigs.
//
//     node test/select-package/drive.js
//
// No network: every fetch is intercepted and recorded, so the assertions are
// about the requests the handler MAKES, which is where the bug lived.

let fails = 0, total = 0;
const check = (label, ok, extra = '') => {
  total++;
  console.log((ok ? '  ok    ' : '  FAIL  ') + label + (extra ? '  ' + extra : ''));
  if (!ok) fails++;
};

process.env.SUPABASE_URL = 'https://stub.supabase.test';
process.env.SUPABASE_SECRET_KEY = 'stub-key';
process.env.RESEND_KEY = 'stub-resend';

// The client and booking the stub serves. Each scenario rewrites these.
let CLIENT = null;
let BOOKING = null;
let calls = [];

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

global.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  let body = null;
  try { body = opts.body ? JSON.parse(opts.body) : null; } catch (e) { body = opts.body; }
  calls.push({ url: String(url), method, body });

  const u = String(url);
  if (u.includes('/rest/v1/clients')) {
    if (method === 'GET') return jsonResponse(CLIENT ? [CLIENT] : []);
    if (method === 'PATCH') { Object.assign(CLIENT, body); return jsonResponse([CLIENT]); }
    if (method === 'POST') { CLIENT = { id: 'new-client', ...body }; return jsonResponse([CLIENT]); }
  }
  if (u.includes('/rest/v1/bookings')) {
    if (method === 'GET') return jsonResponse(BOOKING ? [BOOKING] : []);
    if (method === 'PATCH') {
      if (!BOOKING) return jsonResponse([]);
      for (const [k, v] of Object.entries(body || {})) if (v !== undefined) BOOKING[k] = v;
      return jsonResponse([BOOKING]);
    }
    if (method === 'POST') { BOOKING = { id: 'booking-NEW', ...body }; return jsonResponse([BOOKING]); }
  }
  if (u.includes('/rest/v1/family_note')) return jsonResponse([{ content: '' }]);
  // Resend, Twilio, message logs: all fire-and-forget as far as this test cares.
  return jsonResponse({ id: 'stub' });
};

const res = () => {
  const r = { statusCode: null, payload: null };
  r.setHeader = () => {};
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.payload = p; return r; };
  r.end = () => r;
  return r;
};

const bookingWrites = () => calls.filter(c => c.url.includes('/rest/v1/bookings') && c.method !== 'GET');

(async () => {
  // Overridable so the suite can be pointed at the PRE-FIX endpoint to prove it
  // fails there. A test that passes against the broken code tests nothing.
  const modulePath = process.env.SELECT_PACKAGE_MODULE
    || new URL('../../api/select-package.js', import.meta.url).href;
  const { default: handler } = await import(modulePath);

  // ---------------------------------------------------------------- scenario 1
  // The regression. A client with a booking already on file confirms again.
  calls = [];
  CLIENT = {
    id: 'client-1', name: 'Isabella', email: 'isabella@example.com',
    event_type: 'Bachelorette party', event_date: '2026-12-04',
    booking_id: 'booking-EXISTING', last_channel: 'email'
  };
  BOOKING = {
    id: 'booking-EXISTING', client_id: 'client-1', event_date: '2026-12-04',
    fee: 350, intake_status: 'completed', contract_status: 'sent',
    venue_address: 'east 2nd street', payment_amount: 175
  };
  await handler({ method: 'POST', body: {
    clientId: 'client-1', category: 'private', tier: 'standard',
    label: 'Signature Show', price: 350, readyToBook: true
  } }, res());

  const w1 = bookingWrites();
  check('no second booking is inserted for a client who has one',
        !w1.some(c => c.method === 'POST'),
        w1.some(c => c.method === 'POST') ? '(inserted one)' : '');
  check('the existing booking is updated instead',
        w1.some(c => c.method === 'PATCH' && c.url.includes('booking-EXISTING')));
  check('the client still points at the booking it had',
        CLIENT.booking_id === 'booking-EXISTING', `(points at ${CLIENT.booking_id})`);
  check('a completed questionnaire is not knocked back to Awaiting',
        BOOKING.intake_status === 'completed', `(is ${BOOKING.intake_status})`);
  check('a date the gig already holds is not overwritten',
        BOOKING.event_date === '2026-12-04', `(is ${BOOKING.event_date})`);
  check('a sent contract is not reset to not_sent',
        BOOKING.contract_status === 'sent', `(is ${BOOKING.contract_status})`);
  check('the payment on the row is untouched',
        BOOKING.payment_amount === 175, `(is ${BOOKING.payment_amount})`);
  check('no second questionnaire is emailed over a completed one',
        !calls.some(c => c.url.includes('api.resend.com') &&
                         JSON.stringify(c.body || '').includes('intake.html')));

  // ---------------------------------------------------------------- scenario 2
  // The ordinary path still has to work: a client with no booking gets one.
  calls = [];
  CLIENT = {
    id: 'client-2', name: 'Fresh Lead', email: 'fresh@example.com',
    event_type: 'Birthday party', event_date: '2027-02-10',
    booking_id: null, last_channel: 'email'
  };
  BOOKING = null;
  await handler({ method: 'POST', body: {
    clientId: 'client-2', category: 'private', tier: 'standard',
    label: 'Signature Show', price: 500, readyToBook: true
  } }, res());

  const w2 = bookingWrites();
  check('a client with no booking still gets one created',
        w2.some(c => c.method === 'POST'));
  check('the new booking carries the fee just selected',
        BOOKING && BOOKING.fee === 500, BOOKING ? `(is ${BOOKING.fee})` : '(no booking)');
  check('the client is linked to it',
        CLIENT.booking_id === 'booking-NEW', `(points at ${CLIENT.booking_id})`);
  check('that client does get the questionnaire',
        calls.some(c => c.url.includes('api.resend.com') &&
                        JSON.stringify(c.body || '').includes('intake.html')));

  // ---------------------------------------------------------------- scenario 3
  // booking_id pointing at a row that no longer exists, which is what deleting a
  // duplicate by hand used to leave behind. It must self-heal, not fail.
  calls = [];
  CLIENT = {
    id: 'client-3', name: 'Dangling', email: 'dangling@example.com',
    event_type: 'Other', event_date: '2027-03-01',
    booking_id: 'booking-GONE', last_channel: 'email'
  };
  BOOKING = null; // the GET for booking-GONE comes back empty
  await handler({ method: 'POST', body: {
    clientId: 'client-3', category: 'private', tier: 'standard',
    label: 'Signature Show', price: 400, readyToBook: true
  } }, res());

  check('a dangling booking_id self-heals into one new booking',
        bookingWrites().filter(c => c.method === 'POST').length === 1,
        `(${bookingWrites().filter(c => c.method === 'POST').length} inserts)`);
  check('and the client is relinked to it',
        CLIENT.booking_id === 'booking-NEW', `(points at ${CLIENT.booking_id})`);

  console.log(`\n${total - fails}/${total} passed`);
  process.exit(fails ? 1 : 0);
})();
