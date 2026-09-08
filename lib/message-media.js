// Keeping the photos and video clients send.
//
// Twilio holds the media, but behind account credentials and not for ever, and
// the app had no copy at all -- a picture was named in the conversation and
// forwarded to Shine's phone, and that forward was the only place it existed.
// This fetches each file once, on arrival, and puts it in a private bucket so
// the picture can be looked at in the thread months later, beside the
// conversation it belongs to.
//
// Everything here is best effort. A photo that fails to copy must never cost
// the client their message: their words are already saved before any of this
// runs, and a failure here leaves the file named but not stored, which the
// conversation says out loud rather than hiding.

const BUCKET = 'message-media';

// Twilio caps MMS at a few megabytes, so this is really a guard against RCS and
// against a surprise. It matches the bucket's own limit; a file over it is
// recorded but not copied, and is still in Twilio and on Shine's phone.
const MAX_BYTES = 50 * 1024 * 1024;

// The webhook has seconds, not minutes: Twilio retries a slow one and the
// function is killed regardless. Better to copy the first few and say so than
// to copy none because the request died on the fourth.
const MAX_FILES = 4;
const PER_FILE_MS = 5000;

function extensionFor(type) {
  const map = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/gif': 'gif', 'image/heic': 'heic', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/3gpp': '3gp',
    'application/pdf': 'pdf',
  };
  return map[String(type || '').toLowerCase()] || 'bin';
}

/// Copy each file into the bucket and describe what happened to it.
///
/// Returns the array that goes into messages.media. Every file gets an entry
/// whether or not it was stored, because "three photos arrived and one is too
/// big to keep" is a true and useful thing for the conversation to say, and
/// silence is exactly the bug this replaces.
export async function storeTwilioMedia(media, { clientId, messageSid }) {
  if (!media || !media.length) return [];
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return [];

  const twilioAuth = Buffer.from(
    `${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64');
  const out = [];

  for (let i = 0; i < media.length; i++) {
    const m = media[i];
    const entry = { type: m.type || '', stored: false };

    if (i >= MAX_FILES) {
      entry.reason = 'not copied: too many files in one message';
      out.push(entry);
      continue;
    }

    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), PER_FILE_MS);
      const r = await fetch(m.url, {
        headers: { 'Authorization': `Basic ${twilioAuth}` },
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (!r.ok) throw new Error(`Twilio ${r.status}`);

      const buf = Buffer.from(await r.arrayBuffer());
      entry.bytes = buf.length;
      if (buf.length > MAX_BYTES) {
        entry.reason = 'not copied: larger than 50 MB';
        out.push(entry);
        continue;
      }

      // Path carries the client and the Twilio message, so a file can always be
      // traced back to the exact message it arrived on.
      const path = `${clientId || 'unknown'}/${messageSid}/${i}.${extensionFor(m.type)}`;
      const up = await fetch(
        `${process.env.SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`,
        { method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
            'Content-Type': m.type || 'application/octet-stream',
            'x-upsert': 'true',
          },
          body: buf });
      if (!up.ok) throw new Error(`Storage ${up.status}: ${(await up.text()).slice(0, 200)}`);

      entry.path = path;
      entry.stored = true;
    } catch (e) {
      entry.reason = `not copied: ${e.name === 'AbortError' ? 'timed out' : e.message}`;
      console.error('Media copy failed:', m.url, e.message);
    }
    out.push(entry);
  }

  return out;
}

/// A link the app can actually open, valid for an hour.
///
/// The bucket is private because these are photographs of other people's
/// weddings and children. Signed links mean a URL that leaks is useless
/// tomorrow, rather than for ever.
export async function signedMediaUrl(path, expiresIn = 3600) {
  if (!path) return null;
  try {
    const r = await fetch(
      `${process.env.SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${path}`,
      { method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn }) });
    if (!r.ok) return null;
    const d = await r.json();
    return d.signedURL ? `${process.env.SUPABASE_URL}/storage/v1${d.signedURL}` : null;
  } catch (e) {
    console.error('signedMediaUrl failed:', e.message);
    return null;
  }
}
