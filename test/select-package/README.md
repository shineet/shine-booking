# select-package tests

Drives `api/select-package.js` against a stubbed Supabase. Every `fetch` is
intercepted and recorded, so the assertions are about the requests the handler
makes, which is where the bug lived.

    node test/select-package/drive.mjs

No install, no stub process, no network.

## What it is guarding

Isabella, December 2026. She already had a booking and had filled in her
questionnaire. She paid an advance, the Stripe webhook's bookOnPay path called
this endpoint with `readyToBook`, and the endpoint **inserted a second booking
unconditionally** and repointed the client at it. Her answers stayed on the old
row and her money went to the new one, and both showed on the Dashboard as
separate gigs.

`api/intake.js` had already been taught to reuse an existing booking. This
endpoint had not, and nothing was watching.

## Proving it still bites

A test that passes against the broken code tests nothing, so point the suite at
the pre-fix endpoint and watch it fail:

    mkdir -p /tmp/spk-old/api
    git show <commit-before-fix>:api/select-package.js > /tmp/spk-old/api/select-package.js
    ln -sfn "$PWD/lib" /tmp/spk-old/lib
    SELECT_PACKAGE_MODULE="file:///tmp/spk-old/api/select-package.js" node test/select-package/drive.mjs

Seven of the fourteen fail there, including `the payment on the row is untouched
(is undefined)`, which is Isabella's exact symptom.

## What each scenario covers

1. **A client who already has a booking confirms again.** No insert, the
   existing row is patched, and four things on it survive: a completed
   questionnaire, the gig's own date, a sent contract, and a recorded payment.
   No second questionnaire is emailed.
2. **A client with no booking.** Still gets one, with the fee just selected, and
   is linked to it, and does receive the questionnaire.
3. **`booking_id` pointing at a deleted row.** Self-heals into exactly one new
   booking and relinks, rather than failing the confirmation.
