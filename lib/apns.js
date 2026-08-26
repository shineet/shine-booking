// APNs push sender. A lib/ helper (NOT an api/ function) so it doesn't count
// against the 12-function Vercel Hobby cap -- reply.js and email-reply.js import
// notifyNewReply() and call it when a draft is held for review.
//
// Token-based auth (.p8 key): we sign a short-lived ES256 JWT with the APNs key
// and talk to APNs over HTTP/2 (APNs rejects HTTP/1.1, so this uses node:http2,
// not fetch). Everything no-ops quietly if the APNS_* env vars aren't set, so
// the webhooks keep working before push is configured.

import http2 from 'node:http2';
import crypto from 'node:crypto';

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

const SB = () => ({
  apikey: process.env.SUPABASE_SECRET_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
});

function configured() {
  return !!(process.env.APNS_KEY && process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_BUNDLE_ID);
}

// APNs provider JWT, cached ~50 min (Apple rejects tokens older than 60 min and
// throttles minting a new one more than once every ~20 min).
let _jwt = null, _jwtAt = 0;
function providerToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_jwt && now - _jwtAt < 3000) return _jwt;
  let key = process.env.APNS_KEY || '';
  if (key.includes('\\n')) key = key.replace(/\\n/g, '\n'); // env vars often store the PEM with escaped newlines
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: process.env.APNS_KEY_ID }));
  const payload = b64url(JSON.stringify({ iss: process.env.APNS_TEAM_ID, iat: now }));
  const signer = crypto.createSign('SHA256');
  signer.update(`${header}.${payload}`);
  const sig = signer.sign({ key, dsaEncoding: 'ieee-p1363' }); // raw r||s, the JOSE form APNs needs
  _jwt = `${header}.${payload}.${b64url(sig)}`;
  _jwtAt = now;
  return _jwt;
}

function apnsHost() {
  return process.env.APNS_ENV === 'production'
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com';
}

function sendOne(deviceToken, notification) {
  return new Promise((resolve) => {
    let client;
    try { client = http2.connect(apnsHost()); }
    catch (e) { resolve({ ok: false, error: e.message, token: deviceToken }); return; }
    client.on('error', (e) => resolve({ ok: false, error: e.message, token: deviceToken }));

    const body = JSON.stringify(notification);
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${providerToken()}`,
      'apns-topic': process.env.APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });
    let status = 0, data = '';
    req.on('response', (h) => { status = h[':status']; });
    req.setEncoding('utf8');
    req.on('data', (d) => { data += d; });
    req.on('end', () => { client.close(); resolve({ ok: status === 200, status, data, token: deviceToken }); });
    req.on('error', (e) => { client.close(); resolve({ ok: false, error: e.message, token: deviceToken }); });
    req.write(body);
    req.end();
  });
}

async function deviceTokens() {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/device_tokens?select=token`, { headers: SB() });
  const rows = await r.json();
  return Array.isArray(rows) ? rows.map((x) => x.token).filter(Boolean) : [];
}

// Fire a push to every registered device. Best-effort: never throws (a webhook
// must not fail because a push didn't go out), and prunes tokens Apple reports dead.
export async function notify({ title, body, badge } = {}) {
  try {
    if (!configured()) return;
    const tokens = await deviceTokens();
    if (!tokens.length) return;
    const payload = { aps: { alert: { title, body }, sound: 'default', ...(badge != null ? { badge } : {}) } };
    const results = await Promise.all(tokens.map((t) => sendOne(t, payload)));
    for (const res of results) {
      const dead = res.status === 410 || (res.data && /BadDeviceToken|Unregistered/.test(res.data));
      if (dead) {
        fetch(`${process.env.SUPABASE_URL}/rest/v1/device_tokens?token=eq.${res.token}`,
              { method: 'DELETE', headers: SB() }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('APNs notify failed:', e.message);
  }
}

// Convenience wrapper for the review-queue case.
export async function notifyNewReply({ clientName, channel, badge } = {}) {
  const ch = channel === 'email' ? 'email' : 'text';
  await notify({
    title: 'Reply waiting for review',
    body: `${clientName || 'A client'} sent a ${ch} — a draft is ready to send.`,
    badge,
  });
}
