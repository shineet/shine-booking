// lib/dashboard-token.js
// The dashboard session token, in one place.
//
// A one-way hash of the dashboard password and the server's secret key. It
// reveals nothing if intercepted and only matches for somebody who logged in
// with the real password.
//
// Pulled out of api/get-booking.js when api/extract-lead-screenshot.js turned
// out to have NO authentication at all -- 89 lines, no token check, calling a
// paid vision model. Anyone who found the URL could spend the Anthropic budget
// until it ran out, and nothing would have said so until the bill did.
//
// It lives here rather than being copied into the second file because an auth
// check that exists twice is an auth check that will one day only be fixed
// once. Both callers now import the same comparison.

import crypto from 'node:crypto';

export function makeToken() {
  return crypto.createHash('sha256')
    .update(String(process.env.DASHBOARD_PASSWORD || '') + '|' + String(process.env.SUPABASE_SECRET_KEY || ''))
    .digest('hex');
}

/// Constant-time, and false whenever the server has no password configured --
/// an unset DASHBOARD_PASSWORD must lock the door, not leave it open.
export function tokenValid(t) {
  if (!t || typeof t !== 'string' || !process.env.DASHBOARD_PASSWORD) return false;
  const a = Buffer.from(t);
  const b = Buffer.from(makeToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
