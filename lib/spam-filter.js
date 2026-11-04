// Shared cold-solicitation / sales-spam detector.
//
// Used by every path that can turn an inbound message into a lead:
//   - api/email-reply.js  (inbound email, and the Wix-form notification branch)
//   - api/intake.js       (the direct website contact-form POST)
//
// A real booking inquiry is someone wanting to HIRE Shine to perform. This
// catches the mirror image: someone SELLING him a service (web/app development,
// SEO, digital marketing, outsourcing) in bulk cold outreach, which kept landing
// as brand-new leads and auto-drafting replies that Shine then had to delete by
// hand along with their history (Shine, 2026-11-04).
//
// Conservative by design. looksLikeColdSolicitation fires only when BOTH a sales
// pitch AND an opt-out/unsubscribe instruction are present: a genuine client
// never tells Shine how to stop receiving THEIR emails, so pairing the two keeps
// a real enquiry from ever being dropped. isBlockedSender is a separate, exact
// kill-switch for domains/addresses confirmed to be bots.

// Sender domains (or full addresses) known to be bots. Exact-domain or
// exact-address match only, lowercased. Keep this list to confirmed spam
// sources -- never a provider a real client might use (gmail, outlook, etc).
const BLOCKED_SENDERS = new Set([
  'techmeants.com',
]);

export function isBlockedSender(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !e.includes('@')) return false;
  const domain = e.split('@').pop();
  return BLOCKED_SENDERS.has(e) || BLOCKED_SENDERS.has(domain);
}

export function looksLikeColdSolicitation(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return false;

  // An unsubscribe / opt-out instruction -- the fingerprint of bulk outreach.
  const optOut = [
    /reply\s+"?\s*(no|stop|unsubscribe|remove)\s*"?\s+(if|to\b)/,
    /if you('?d| would)\s+(rather|prefer)\s+not\s+(to\s+)?receive/,
    /\b(unsubscribe|opt[\s-]?out|remove (me|you|your email|us)|stop these emails|no longer wish to receive|take you off|taken off (our|the) list)\b/,
    /not\s+interested\b[\s\S]{0,20}\breply\b/,
  ].some((re) => re.test(t));

  // A pitch to SELL Shine a service -- the opposite of hiring him to perform.
  const pitch = [
    /\bwe\s+(build|develop|design|offer|provide|speciali[sz]e|can help|are a|do)\b/,
    /\b(web\s?site|web\s?design|mobile app|app\s+(development|design)|software|seo|digital marketing|link building|back\s?links?|guest post|lead generation|data entry|virtual assistant)\b/,
    /\b(usd|us\$|\$|rs\.?|inr)\s?\d{1,5}\s*(\/|per\s)\s*(hour|hr|month|project|week)\b/,
    /\b(india|offshore|outsourc\w*)\b[\s\S]{0,30}\b(team|developers?|based|company)\b/,
    /\b(increase|boost|grow|double|improve)\b[\s\S]{0,30}\b(sales|traffic|ranking|rankings|revenue|leads?|visibility)\b/,
  ].some((re) => re.test(t));

  return optOut && pitch;
}

// One call for every lead-creating path: drop it when the sender is blocked OR
// the content reads as cold solicitation. Pass the sender email when known.
export function shouldDropAsSpam({ text, email } = {}) {
  return isBlockedSender(email) || looksLikeColdSolicitation(text);
}
