// Keeping a client's emails in ONE conversation.
//
// Every reply went out as a brand new email. Mail clients do not thread on
// sender or subject alone -- they thread on the RFC 5322 headers In-Reply-To
// and References, which carry the Message-ID of the mail being answered.
// Nothing here read that header on the way in or wrote it on the way out, so a
// client's inbox showed a pile of unrelated messages from Shine rather than one
// exchange. Gmail hides the worst of it by grouping on subject; Outlook does
// not, and Outlook is what corporate planners use.
//
// So: capture the Message-ID when their mail arrives, and quote it when
// replying. Two small functions, used by both api/email-reply.js (the AI reply)
// and api/chat.js (a message composed in the app), so the two cannot drift into
// threading differently.

/// The Message-ID of an inbound email, angle brackets and all.
///
/// Returned WITH the brackets because that is the form the outgoing headers
/// need, and stripping them here would only mean putting them back at every
/// call site, which is exactly how one of them ends up forgotten.
///
/// Headers can wrap onto a continuation line, so unfold before matching. Only
/// the top-level header is wanted: a forwarded mail carries the original's
/// Message-ID inside its body, and threading a reply onto that would attach it
/// to a conversation the recipient may never have seen.
export function extractMessageId(rawEmail) {
  if (!rawEmail) return null;
  const text = String(rawEmail);
  // Headers end at the first blank line. Anything after it is body.
  const headerBlock = text.split(/\r?\n\r?\n/)[0] || '';
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  const m = unfolded.match(/^Message-ID:\s*(<[^>\s]+>)/im);
  return m ? m[1] : null;
}

/// The headers that put a reply inside the client's existing thread.
///
/// `inReplyTo` is the Message-ID being answered. References repeats it, which
/// is the minimum a client needs to thread; a full References chain would be
/// better for long exchanges and needs the ids of every message in between,
/// which we do not keep.
///
/// Returns an empty object when there is nothing to thread onto -- a first
/// email, or a client whose mail predates this being captured. An empty object
/// spreads into a send payload harmlessly, so no call site needs a branch.
export function threadHeaders(inReplyTo) {
  if (!inReplyTo) return {};
  return { 'In-Reply-To': inReplyTo, 'References': inReplyTo };
}

/// The Message-ID of the most recent email this client sent us, or null.
///
/// Reads the messages table directly rather than being passed one, because the
/// reply is often composed a day later from a different screen, and the id has
/// to come from the conversation rather than from whatever is in hand.
export async function lastInboundMessageId(clientId) {
  if (!clientId) return null;
  try {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/messages` +
      `?client_id=eq.${clientId}&channel=eq.email&direction=eq.inbound` +
      `&email_message_id=not.is.null&select=email_message_id` +
      `&order=created_at.desc&limit=1`,
      { headers: {
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
        } }
    );
    const rows = await res.json();
    return (Array.isArray(rows) && rows[0] && rows[0].email_message_id) || null;
  } catch (e) {
    // Threading is a nicety; failing to send is not. Never let this throw.
    console.error('lastInboundMessageId failed:', e.message);
    return null;
  }
}
