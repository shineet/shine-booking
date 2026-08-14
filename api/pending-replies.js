function normalizePhone(phone) {
  if (!phone) return phone;
  var digits = phone.replace(/[^0-9]/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (phone.trim().startsWith('+')) return '+' + digits;
  return phone;
}

// Case-insensitive email match (Postgres eq. is case-sensitive; see email-reply.js/intake.js
// for the bug this avoids). % and _ escaped since ilike treats them as wildcards.
function emailIlikeParam(email) {
  return encodeURIComponent(String(email || '').trim().replace(/[%_\\]/g, function(m) { return '\\' + m; }));
}

// Best-effort safety net for action=findleads: the model is told today's real date and told to
// exclude events that have already happened, but web search results (event calendar aggregators
// especially) routinely surface past events without labeling them as such, and the model can
// still misjudge a date. This is a second, code-level check so a past event can't slip through
// even if the prompt instruction alone fails. Only acts when a real date is actually parseable
// out of the freeform eventWindow text (e.g. "March 28, 2026") -- vague windows like "Q3 2026" or
// "not specified" are left alone rather than guessed at.
function isPastEventWindow(eventWindow, todayISO) {
  if (!eventWindow) return false;
  const cleaned = String(eventWindow).trim();
  let d = new Date(cleaned);
  if (isNaN(d.getTime())) {
    const m = cleaned.match(/([A-Z][a-z]{2,8}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})/);
    if (m) d = new Date(m[1].replace(/(st|nd|rd|th)/, ''));
  }
  if (isNaN(d.getTime())) return false;
  const today = new Date(todayISO + 'T00:00:00');
  return d.getTime() < today.getTime();
}

// ── Gmail (past-clients outreach) ──────────────────────────────────────────
// Read-only Gmail access (scope: gmail.readonly) used only to (a) confirm a real thread exists
// with a past client before nudging them and pull a little real context, and (b) sweep for past
// clients who were never logged in this app's own database. Sending still goes through the
// existing Resend/Twilio compose path (api/chat.js mode=compose), never through Gmail itself, so
// logging/dedup stays consistent with every other outbound message in the app.
const GMAIL_REDIRECT_URI = 'https://shine-booking.vercel.app/api/pending-replies?action=gmail-callback';
const GMAIL_SLOTS = [1, 2, 3]; // up to three inboxes

async function getAppSettingsRow(select) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/app_settings?id=eq.1&select=${select}&limit=1`, {
    headers: { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}` }
  });
  const rows = await r.json();
  return (Array.isArray(rows) && rows[0]) || null;
}

// Returns [{slot, email, connectedAt}] for every Gmail account currently connected.
async function getConnectedGmailAccounts() {
  const row = await getAppSettingsRow(GMAIL_SLOTS.map(s => `gmail${s}_refresh_token,gmail${s}_email,gmail${s}_connected_at`).join(','));
  if (!row) return [];
  return GMAIL_SLOTS
    .filter(s => row[`gmail${s}_refresh_token`])
    .map(s => ({ slot: s, email: row[`gmail${s}_email`] || null, connectedAt: row[`gmail${s}_connected_at`] || null }));
}

async function getGmailAccessTokenForSlot(slot) {
  const row = await getAppSettingsRow(`gmail${slot}_refresh_token`);
  const refreshToken = row && row[`gmail${slot}_refresh_token`];
  if (!refreshToken) return null;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken, grant_type: 'refresh_token'
    }).toString()
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) { console.error(`Gmail token refresh failed for slot ${slot}:`, tokenData); return null; }
  return tokenData.access_token;
}

// Returns [{slot, email, accessToken}] for every connected account, skipping any whose token
// refresh failed (e.g. revoked access) rather than failing the whole scan.
async function getActiveGmailSessions() {
  const accounts = await getConnectedGmailAccounts();
  const sessions = [];
  for (const acc of accounts) {
    const accessToken = await getGmailAccessTokenForSlot(acc.slot);
    if (accessToken) sessions.push({ slot: acc.slot, email: acc.email, accessToken });
  }
  return sessions;
}

async function gmailGetProfile(accessToken) {
  try {
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await r.json();
    return r.ok ? data.emailAddress : null;
  } catch(e) { return null; }
}

async function gmailSearch(accessToken, query, maxResults) {
  try {
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults || 5}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await r.json();
    if (!r.ok) { console.error('Gmail search failed:', data); return []; }
    return Array.isArray(data.messages) ? data.messages : [];
  } catch(e) { console.error('Gmail search error:', e.message); return []; }
}

async function gmailGetMessageMeta(accessToken, id) {
  try {
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=From&metadataHeaders=To`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await r.json();
    if (!r.ok) return null;
    const headers = {};
    ((data.payload && data.payload.headers) || []).forEach(h => { headers[h.name] = h.value; });
    return { id, subject: headers.Subject || '', date: headers.Date || '', from: headers.From || '', to: headers.To || '', snippet: data.snippet || '' };
  } catch(e) { console.error('Gmail message fetch error:', e.message); return null; }
}

// Decides whether a past (completed) client is due for a relationship-keeping note, and why.
// daysSinceLastContact is null if Shine has never sent them anything since the event (per the
// messages table), which lets the same rule both gate re-nagging AND let annual reminders recur.
function computeDueReason(eventType, gigDateISO, todayISO, daysSinceLastContact) {
  if (!gigDateISO) return null;
  const type = (eventType || '').toLowerCase();
  const gigDate = new Date(gigDateISO + 'T00:00:00');
  const today = new Date(todayISO + 'T00:00:00');
  if (isNaN(gigDate.getTime())) return null;
  const daysSinceGig = Math.floor((today.getTime() - gigDate.getTime()) / 86400000);
  if (daysSinceGig < 14) return null; // too soon after the show either way

  if (type.includes('birthday')) {
    // Recurs annually: fire once in the ~20-40 day window before the anniversary of the event.
    let next = new Date(today.getFullYear(), gigDate.getMonth(), gigDate.getDate());
    if (next.getTime() < today.getTime()) next.setFullYear(next.getFullYear() + 1);
    const daysUntil = Math.round((next.getTime() - today.getTime()) / 86400000);
    if (daysUntil < 20 || daysUntil > 40) return null;
    if (daysSinceLastContact !== null && daysSinceLastContact < 300) return null; // already nudged this cycle
    return { kind: 'birthday', label: 'Birthday season coming up in about ' + daysUntil + ' days' };
  }
  if (type.includes('bachelorette') || type.includes('bachelor')) {
    if (daysSinceGig < 60) return null;
    if (daysSinceLastContact !== null && daysSinceLastContact < 300) return null;
    return { kind: 'checkin', label: daysSinceGig + ' days since the event, casual check-in' };
  }
  // Everything else: a generic periodic relationship check-in.
  if (daysSinceGig < 150) return null;
  if (daysSinceLastContact !== null && daysSinceLastContact < 150) return null;
  return { kind: 'checkin', label: daysSinceGig + ' days since the event' };
}

// Pulls a plain email address out of a Gmail header value, e.g. "John Doe <john@example.com>".
function extractEmailAddress(headerVal) {
  if (!headerVal) return null;
  const angle = String(headerVal).match(/<([^>]+)>/);
  const candidate = angle ? angle[1] : String(headerVal).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate.trim().toLowerCase() : null;
}

// Real carrier/line-type lookup via Twilio Lookup v2 (line_type_intelligence add-on), used by
// the research step so the phone-type read is a verified fact instead of an area-code guess.
// Separate credentials (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN) from the messaging pair
// (TWILIO_SID/TWILIO_TOKEN) used everywhere else in this file, though today they're the same
// Twilio account. Fails soft: returns null on any error/timeout so research always proceeds.
async function lookupPhoneLineType(phone) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const normalized = normalizePhone(phone);
  if (!sid || !token || !normalized) return null;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(
      `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(normalized)}?Fields=line_type_intelligence`,
      { headers: { Authorization: 'Basic ' + auth }, signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!resp.ok) { console.error('Twilio Lookup error:', resp.status); return null; }
    const data = await resp.json();
    const lti = data && data.line_type_intelligence;
    if (!lti || !lti.type) return null;
    return { type: lti.type, carrierName: lti.carrier_name || null };
  } catch(e) { console.error('Twilio Lookup failed:', e.message); return null; }
}

// Voice prompts used only by the "regenerate" action below. These MIRROR the prompts in
// email-reply.js (EMAIL_VOICE) and reply.js (SMS_VOICE) so a re-drafted reply keeps Shine's
// voice. If you change the voice in those files, update it here too.
const EMAIL_VOICE = `You are Shine Thankappan, a mentalist and magician based in Texas, replying to your own client emails personally. Write exactly the way you'd actually type an email on your phone between gigs — not the way a customer service rep or an AI assistant would write.

About me:
- I blend visual magic with mentalism — astonishing effects built around real human connection, not just tricks for their own sake
- I perform 45-60 minute interactive shows in Texas
- I also do strolling/walk-around magic — up-close magic that moves through a crowd (great for cocktail hours at weddings and corporate events), either on its own or paired with a short stage finale
- Payment: Cash, Zelle (2020shine@gmail.com), Venmo (@Shine-Thankappan), PayPal (shine_e_thankappan@yahoo.com)
- Website: www.texasmentalist.com
- Phone: +1 (737) 271-5308

How I describe what I do, depending on what they ask for:
- If they specifically say "mentalist," "mentalism," or "mind reading" — lead entirely with that. Talk about reading minds, psychological connection, predicting thoughts. Don't dilute it by bringing up visual magic unless they ask
- If they specifically say "magician," "magic," or "illusions" — lead with the visual side. Striking, surprising, visually stunning effects
- If they're general ("entertainer," "performer," "something fun for our event") or haven't specified a style — use the blended description above

Format guidance based on event type — my STAGE SHOW is my strength, so always emphasize it:
- Private parties (birthdays, bachelorette parties, house/home parties, any small private event): lead with and emphasize the stage show. Do NOT bring up strolling/walk-around on my own — only mention it if the client specifically asks for it. If they ask, I'm glad to do it, but never suggest it myself for these
- Cocktail parties / cocktail-style mingling events: mention BOTH — strolling (which fits a mingling crowd well) and the stage show. Suggest the stage show too whenever the setup allows it (somewhere guests can gather and watch). Still emphasize the stage show as my strength, but make clear both are options for a cocktail setting
- Corporate events and weddings: I can mention both, but the stage show is the headline. Present the stage show as the main event and strolling only as an optional add-on (for example during a cocktail hour). Keep the emphasis clearly on the stage show, never lead with strolling
- Only lead with or center strolling if the client explicitly asks about walk-around/close-up/roving magic

How I actually write:
- Always first person, never "Shine will" or third person
- Short sentences. Real contractions (I'm, that's, can't, you're). Sometimes a sentence starts with "And" or "So" or "Also" — that's normal for me, not a mistake
- I don't pad replies with stock openers like "Thank you for reaching out" or "I hope this email finds you well" or "Great question!" — I just respond like I'm continuing a conversation with someone
- I vary how I open each email based on what they actually said, not a template. If they're excited, match that energy. If they're asking something simple, just answer it
- No corporate filler like "I appreciate your interest" or "Please don't hesitate to reach out" or "I look forward to hearing from you"
- One or two short paragraphs is usually enough. I don't over-explain
- A little personality is good — genuine enthusiasm about their event, a light joke if it fits naturally — but never forced or try-hard

Critical — sounding repetitive kills trust:
- Before writing, look back at what I've already said earlier in this email thread (shown above as prior messages)
- Never reuse a phrase, sentence opener, or stock expression I've already used earlier in this same thread — especially things like "great question," "I'd love to," "feel free to," "looking forward to it," "that sounds amazing/awesome." If I already said something like that once, find a genuinely different way to say it this time, or just skip the filler and say the thing directly
- If I've already thanked them once in this thread, don't thank them again the same way — just move the conversation forward

Rules:
- If asked about pricing, respond warmly that I have a few packages depending on what they're looking for and I'll send the details right over. Do NOT include any link or prices.
- Never claim I only do one format — I do both stage shows and strolling, and which one fits is something we figure out together based on their event
- Never make up availability
- Return ONLY the email body. No subject line, no commentary, no internal tags.

Signature:
Shine, The Mentalist
+1 (737) 271-5308
www.texasmentalist.com`;

const SMS_VOICE = `You are Shine Thankappan, a mentalist and magician based in Texas, texting your own clients personally. Write exactly the way you'd actually text someone on your phone — not the way a business or an AI assistant would text.

About me:
- I blend visual magic with mentalism — astonishing effects built around real human connection, not just tricks for their own sake
- I perform 45-60 minute interactive shows in Texas
- I also do strolling/walk-around magic — up-close magic that moves through a crowd (great for cocktail hours at weddings and corporate events), either on its own or paired with a short stage finale
- Website: www.texasmentalist.com
- Phone: +1 (737) 271-5308

How I describe what I do, depending on what they ask for:
- If they specifically say "mentalist," "mentalism," or "mind reading" — lead entirely with that. Talk about reading minds, psychological connection, predicting thoughts. Don't dilute it by bringing up visual magic unless they ask
- If they specifically say "magician," "magic," or "illusions" — lead with the visual side. Striking, surprising, visually stunning effects
- If they're general ("entertainer," "performer," "something fun for our event") or haven't specified a style — use the blended description above

How I actually text:
- Always first person, never "Shine will" or third person
- Short, casual, real contractions (I'm, that's, can't, you're)
- No stock openers like "Thanks for reaching out!" or "Great question!" — I just answer like I'm mid-conversation
- No corporate filler ("I appreciate your interest", "feel free to reach out")
- Default to short, like a real text — most replies should fit in one SMS segment. It's fine to run longer when the content genuinely needs it (e.g. explaining packages/pricing in real detail, especially if the client has no email on file so this text has to carry the whole explanation). Never pad length just to fill space, and never cut a real explanation short just to hit a character count. Hard technical ceiling: stay well under 1500 characters — carriers reject SMS bodies over 1600, so never approach that

Critical — sounding repetitive kills trust:
- Look back at what I've already texted earlier in this thread (shown above as prior messages)
- Never reuse a phrase or opener I've already used earlier in this same thread — especially things like "great question," "I'd love to," "sounds amazing," "looking forward to it." Say it a genuinely different way, or just skip the filler

Rules:
- If asked about pricing, respond warmly that I have a few packages depending on what they need and I'll send the details right over. Do NOT include any link or prices.
- My stage show is my strength — always emphasize it. For private parties (birthdays, house/home parties, small private events) do NOT bring up strolling unless the client specifically asks. For cocktail parties mention BOTH strolling and the stage show. For weddings and corporate events I can mention strolling too, but only as an optional add-on with the stage show as the headline
- Never make up availability
- Return ONLY the message text, no commentary, no internal tags.`;

// Give the research action (Claude + web search) room to finish server-side.
export const config = { maxDuration: 60 };

// Pull the lead's actual conversation (what they messaged Shine) so research + drafts
// factor in their own words, not just the notes field. Inbound + outbound, oldest first.
async function fetchLeadConversation(clientId) {
  if (!clientId) return '';
  try {
    const sb = { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` };
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?client_id=eq.${clientId}&status=not.in.(discarded)&order=created_at.asc&limit=12`, { headers: sb });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return '';
    const lines = rows
      // 4000 chars, not 500: a full email (e.g. one that quotes a specific price partway
      // through) was getting silently truncated before the model ever saw the price.
      .map(m => (m.direction === 'inbound' ? 'THEM: ' : 'SHINE: ') + String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 4000))
      .filter(x => x.length > 8);
    return lines.length ? '\n\nWHAT THEY ACTUALLY MESSAGED (read this closely and respond to it):\n' + lines.join('\n') : '';
  } catch(e) { console.error('fetchLeadConversation failed:', e.message); return ''; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    // Owner's custom response guidance (editable from the dashboard "AI Settings" panel).
    // Returns a ready-to-append suffix, or '' if none set.
    const guidanceSuffix = async () => {
      try {
        const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/app_settings?id=eq.1&select=ai_guidance&limit=1`, {
          headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` }
        });
        const rows = await r.json();
        const g = (Array.isArray(rows) && rows[0] && rows[0].ai_guidance) ? String(rows[0].ai_guidance).trim() : '';
        return g ? `\n\nSHINE'S CUSTOM INSTRUCTIONS (highest priority. Follow these; if they conflict with anything above, these win, but never invent availability):\n${g}` : '';
      } catch(e) { console.error('AI guidance fetch failed:', e.message); return ''; }
    };

    // GET ?action=settings -> read the global review-mode toggle
    if (req.method === 'GET' && req.query.action === 'settings') {
      const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/app_settings?id=eq.1&limit=1`, {
        headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` }
      });
      const rows = await r.json();
      const settings = Array.isArray(rows) ? rows[0] : null;
      res.status(200).json({ reviewMode: settings ? settings.review_mode : false });
      return;
    }

    // GET ?action=gmail-status -> which of the (up to two) Gmail inboxes are connected
    if (req.method === 'GET' && req.query.action === 'gmail-status') {
      const accounts = await getConnectedGmailAccounts();
      res.status(200).json({ accounts, maxAccounts: GMAIL_SLOTS.length });
      return;
    }

    // GET ?action=gmail-authstart&slot=1|2 -> redirect into Google's OAuth consent screen for a
    // specific inbox slot (state=slot round-trips through Google so the callback knows which slot
    // to save into). Gmail readonly scope only (never gmail.send -- outbound still goes through
    // Resend/Twilio like everything else). access_type=offline + prompt=consent forces a
    // refresh_token back every time, since without it Google only issues one on the first grant.
    if (req.method === 'GET' && req.query.action === 'gmail-authstart') {
      const slot = GMAIL_SLOTS.includes(Number(req.query.slot)) ? Number(req.query.slot) : 1;
      const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: GMAIL_REDIRECT_URI,
        response_type: 'code',
        access_type: 'offline',
        prompt: 'consent',
        state: String(slot),
        scope: 'https://www.googleapis.com/auth/gmail.readonly'
      });
      res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
      res.end();
      return;
    }

    // GET ?action=gmail-callback -> Google redirects here after consent with a one-time code and
    // the slot we sent back as `state`. Exchange the code for tokens, look up which address this
    // actually is (users.getProfile), and persist to that slot's columns in app_settings.
    if (req.method === 'GET' && req.query.action === 'gmail-callback') {
      const code = req.query.code;
      const slot = GMAIL_SLOTS.includes(Number(req.query.state)) ? Number(req.query.state) : 1;
      if (!code) { res.writeHead(302, { Location: 'https://shine-booking.vercel.app/?gmail=error' }); res.end(); return; }
      try {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
            code, grant_type: 'authorization_code', redirect_uri: GMAIL_REDIRECT_URI
          }).toString()
        });
        const tokenData = await tokenRes.json();
        if (!tokenRes.ok || !tokenData.refresh_token) { console.error('Gmail OAuth exchange failed:', tokenData); res.writeHead(302, { Location: 'https://shine-booking.vercel.app/?gmail=error' }); res.end(); return; }
        const email = await gmailGetProfile(tokenData.access_token);
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/app_settings?id=eq.1`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
          body: JSON.stringify({ [`gmail${slot}_refresh_token`]: tokenData.refresh_token, [`gmail${slot}_email`]: email, [`gmail${slot}_connected_at`]: new Date().toISOString() })
        });
        res.writeHead(302, { Location: 'https://shine-booking.vercel.app/?gmail=connected' });
        res.end();
      } catch(e) {
        console.error('Gmail OAuth callback failed:', e.message);
        res.writeHead(302, { Location: 'https://shine-booking.vercel.app/?gmail=error' });
        res.end();
      }
      return;
    }

    // POST action=gmail-disconnect { slot } -> clear one inbox's stored refresh token
    if (req.method === 'POST' && req.body.action === 'gmail-disconnect') {
      const slot = GMAIL_SLOTS.includes(Number(req.body.slot)) ? Number(req.body.slot) : 1;
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/app_settings?id=eq.1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
        body: JSON.stringify({ [`gmail${slot}_refresh_token`]: null, [`gmail${slot}_email`]: null, [`gmail${slot}_connected_at`]: null })
      });
      res.status(200).json({ success: true });
      return;
    }

    // GET (default) -> list all pending replies with client info
    if (req.method === 'GET') {
      const r = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/messages?status=eq.pending_review&order=created_at.asc&select=*`,
        { headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` } }
      );
      const pending = await r.json();
      if (!Array.isArray(pending) || pending.length === 0) {
        res.status(200).json({ pending: [] });
        return;
      }

      const clientIds = [...new Set(pending.map(m => m.client_id).filter(Boolean))];
      let clientsById = {};
      if (clientIds.length) {
        const idsParam = clientIds.join(',');
        const cRes = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/clients?id=in.(${idsParam})&select=id,name`,
          { headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` } }
        );
        const cRows = await cRes.json();
        if (Array.isArray(cRows)) cRows.forEach(c => { clientsById[c.id] = c.name; });
      }

      // Pull each client's recent INBOUND messages so we can show the owner the message
      // they're actually replying to (the thing the AI draft is responding to).
      let inboundByClient = {};
      if (clientIds.length) {
        try {
          const idsParam = clientIds.join(',');
          const inRes = await fetch(
            `${process.env.SUPABASE_URL}/rest/v1/messages?client_id=in.(${idsParam})&direction=eq.inbound&order=created_at.desc&select=client_id,channel,content,created_at,email_subject`,
            { headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` } }
          );
          const inRows = await inRes.json();
          if (Array.isArray(inRows)) {
            inRows.forEach(m => {
              // keep the most recent inbound per client+channel (rows are newest-first)
              const key = m.client_id + '|' + m.channel;
              if (!inboundByClient[key]) inboundByClient[key] = m;
            });
          }
        } catch(e) { console.error('Inbound fetch for pending failed:', e.message); }
      }

      const result = pending.map(m => {
        const inb = inboundByClient[m.client_id + '|' + m.channel] || null;
        return {
          id: m.id,
          clientId: m.client_id,
          clientName: clientsById[m.client_id] || 'Unknown',
          channel: m.channel,
          toAddress: m.to_address,
          draft: m.content,
          createdAt: m.created_at,
          subject: m.email_subject || null,
          cc: m.cc_address || null,
          incoming: inb ? inb.content : null,
          incomingAt: inb ? inb.created_at : null
        };
      });

      res.status(200).json({ pending: result });
      return;
    }

    // POST action=generate-followup -> generate context-aware draft and save to messages
    if (req.method === 'POST' && req.body.action === 'generate-followup') {
      const { clientId, clientName, eventType, eventDate, venue, guests, status, hoursAgo, toEmail, toPhone } = req.body;

      const statusContext = {
        'new':               'You sent them an initial message but they have not replied yet. Follow up warmly, reference their event, and ask if they have any questions.',
        'chatting':          'You have been chatting. They have not replied to your last message. Follow up gently to keep the conversation going.',
        'pricing_requested': 'They asked about pricing. You sent pricing info but they have not responded. Ask if they had questions about the packages.',
        'pricing_sent':      'You sent them your pricing page but they have not responded. Check if they had a chance to look and if they have questions.',
        'package_selected':  'They selected a package. Follow up about the next step: filling out the event questionnaire so you can personalise the show.',
        'booked':            'They are booked. Follow up about completing the event questionnaire/intake form so you can start preparing.',
        'intake_sent':       'You sent the event questionnaire but they have not filled it out yet. Remind them and offer help if needed.',
        'intake_completed':  'They completed the questionnaire. Follow up about sending the contract to finalise everything.',
        'contract_sent':     'You sent the contract but they have not signed yet. Remind them to sign so the booking is confirmed.'
      };

      const followUpContext = statusContext[status] || 'Follow up professionally about the next step.';

      const systemPrompt = `You are writing a follow-up email on behalf of Shine, The Mentalist — a professional mentalism and magic performer in Texas.

RULES:
- This is NOT a first contact. Do NOT introduce yourself or describe your show.
- Write only what is appropriate for the stage described below.
- Warm, brief, natural. Under 80 words total.
- Sign off as: Shine, The Mentalist | +1 (737) 271-5308
- Return ONLY the email body. No subject line. No commentary.

STAGE: ${followUpContext}`;

      const userPrompt = `Client: ${clientName}
Event: ${eventType || 'not specified'}
Date: ${eventDate || 'not specified'}
Venue: ${venue || 'not specified'}
Guests: ${guests || 'not specified'}
Hours since last contact: ${hoursAgo}`;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 300,
          system: systemPrompt + (await guidanceSuffix()),
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });

      const claudeData = await claudeRes.json();
      if (claudeData.error) throw new Error(claudeData.error.message || JSON.stringify(claudeData.error));

      let draft = '';
      if (claudeData.content && Array.isArray(claudeData.content)) {
        claudeData.content.forEach(b => { if (b.type === 'text') draft += b.text; });
      }
      if (!draft) throw new Error('No draft generated');

      // Save to messages table
      const sbHdr = {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
        'Prefer': 'return=representation'
      };

      const saveRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
        method: 'POST',
        headers: sbHdr,
        body: JSON.stringify({
          client_id: clientId,
          channel: toEmail ? 'email' : 'sms',
          content: draft,
          status: 'pending_review',
          to_address: toEmail || toPhone || null,
          direction: 'outbound',
          created_at: new Date().toISOString()
        })
      });

      const saved = await saveRes.json();
      if (saved && saved.code) throw new Error('Supabase: ' + (saved.message || saved.code));

      res.status(200).json({ success: true, draft });
      return;
    }

    // POST action=generate-reply -> draft a contextual reply for the compose modal
    if (req.method === 'POST' && req.body.action === 'generate-reply') {
      const { clientName, eventType, eventDate, venue, guests, status, notes, instruction, channel } = req.body;

      const systemPrompt = `You are writing a reply SMS on behalf of Shine, The Mentalist — a professional mentalism and magic performer in Texas.

RULES:
- This is a reply to a client who has already been in contact, NOT a first introduction
- Warm, direct, natural tone — not salesy
- Default to short, like a real text, but it's fine to run longer when the content genuinely needs it (e.g. explaining pricing/packages in real detail, or this client has no email on file so the text has to carry the whole thing). Never pad for its own sake. Hard technical ceiling: stay well under 1500 characters — carriers reject SMS bodies over 1600, so never approach that
- Sign off as: - Shine | +1 (737) 271-5308
- Return ONLY the message text, no commentary

PRICING:
- Shine's minimum rate is $350 for any show
- If the client's notes mention a budget below $350, the reply MUST:
  1. State the rate clearly and without apology: "My rate starts at $350"
  2. Acknowledge their stated budget briefly and without judgment
  3. Ask if there's any flexibility: "Is there any wiggle room on budget?"
  4. Offer a scope adjustment as an alternative if appropriate (e.g. shorter set)
  5. Keep the door open — warm but firm on the minimum`;

      const userPrompt = [
        `Client: ${clientName}`,
        eventType ? `Event: ${eventType}` : '',
        eventDate ? `Date: ${eventDate}` : '',
        venue ? `Venue: ${venue}` : '',
        guests ? `Guests: ${guests}` : '',
        status ? `Status: ${status}` : '',
        notes ? `Notes: ${notes}` : ''
      ].filter(Boolean).join('\n');

      // If composing an email, use the email signoff instead of the SMS one above.
      const channelBlock = channel === 'email'
        ? '\n\nFORMAT OVERRIDE: This is an EMAIL, not an SMS. Use one or two short paragraphs; sign off as "Shine, The Mentalist" with the phone and website.'
        : '';
      // Per-draft steering the owner typed for THIS message.
      const instrBlock = (instruction && String(instruction).trim())
        ? `\n\nSHINE'S INSTRUCTION FOR THIS DRAFT (highest priority — follow this; never invent availability):\n${String(instruction).trim()}`
        : '';

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: systemPrompt + (await guidanceSuffix()) + channelBlock + instrBlock,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });

      const claudeData = await claudeRes.json();
      if (claudeData.error) throw new Error(claudeData.error.message || JSON.stringify(claudeData.error));

      let draft = '';
      if (claudeData.content && Array.isArray(claudeData.content)) {
        claudeData.content.forEach(b => { if (b.type === 'text') draft += b.text; });
      }
      if (!draft) throw new Error('No draft generated');

      res.status(200).json({ success: true, draft });
      return;
    }

    // POST action=toggle -> flip review-mode
    if (req.method === 'POST' && req.body.action === 'toggle') {
      const { reviewMode } = req.body;
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/app_settings?id=eq.1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
        body: JSON.stringify({ review_mode: reviewMode, updated_at: new Date().toISOString() })
      });
      res.status(200).json({ success: true, reviewMode });
      return;
    }

    // POST action=approve -> send and mark sent
    if (req.method === 'POST' && req.body.action === 'approve') {
      const { messageId, editedText } = req.body;
      const msgRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?id=eq.${messageId}&limit=1`, {
        headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` }
      });
      const msgRows = await msgRes.json();
      const message = Array.isArray(msgRows) ? msgRows[0] : null;
      if (!message) { res.status(404).json({ error: 'Message not found' }); return; }

      let finalText = editedText || message.content;

      if (message.channel === 'sms') {
        // Safety backstop: Twilio hard-rejects any SMS body over 1600 chars.
        // Shouldn't happen given the prompt guidance the drafts are written
        // with, but this send has no response check below, so an over-limit
        // body would otherwise fail silently.
        if (finalText.length > 1550) finalText = finalText.slice(0, 1550).trim() + '…';
        const twilioAuth = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64');
        await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${twilioAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ From: process.env.TWILIO_FROM, To: normalizePhone(message.to_address), Body: finalText }).toString()
        });
      } else if (message.channel === 'email') {
        const ccList = message.cc_address ? message.cc_address.split(',').map(s => s.trim()).filter(Boolean) : null;
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
          body: JSON.stringify({
            from: 'Shine, The Mentalist <shine@texasmentalist.com>',
            to: message.to_address,
            ...(ccList && ccList.length ? { cc: ccList } : {}),
            subject: message.email_subject || 'Following up',
            text: finalText
          })
        });
      }

      await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?id=eq.${messageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
        body: JSON.stringify({ status: 'sent', content: finalText })
      });

      res.status(200).json({ success: true });
      return;
    }

    // POST action=discard -> drop without sending
    if (req.method === 'POST' && req.body.action === 'discard') {
      const { messageId } = req.body;
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?id=eq.${messageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
        body: JSON.stringify({ status: 'discarded' })
      });
      res.status(200).json({ success: true });
      return;
    }

    // POST action=restore -> bring a discarded draft back into the pending-review queue
    // so it can be edited/regenerated/sent through the normal flow.
    if (req.method === 'POST' && req.body.action === 'restore') {
      const { messageId } = req.body;
      if (!messageId) { res.status(400).json({ error: 'messageId required' }); return; }
      const sbHeaders = { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` };
      const chkRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?id=eq.${messageId}&limit=1`, { headers: sbHeaders });
      const chkRows = await chkRes.json();
      const msg = Array.isArray(chkRows) ? chkRows[0] : null;
      if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }
      if (msg.status !== 'discarded') { res.status(400).json({ error: 'Only discarded drafts can be restored' }); return; }
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?id=eq.${messageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...sbHeaders },
        body: JSON.stringify({ status: 'pending_review' })
      });
      res.status(200).json({ success: true });
      return;
    }

    // POST action=regenerate -> re-draft this pending reply, optionally steered by a
    // per-message instruction the owner types after reading the client's message.
    if (req.method === 'POST' && req.body.action === 'regenerate') {
      const { messageId, instruction } = req.body;
      if (!messageId) { res.status(400).json({ error: 'messageId required' }); return; }
      const sbHeaders = { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` };

      // The pending draft we're regenerating
      const dRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?id=eq.${messageId}&limit=1`, { headers: sbHeaders });
      const dRows = await dRes.json();
      const draftMsg = Array.isArray(dRows) ? dRows[0] : null;
      if (!draftMsg) { res.status(404).json({ error: 'Draft not found' }); return; }
      const channel = draftMsg.channel === 'sms' ? 'sms' : 'email';

      // Conversation history for this client + channel (excludes pending/discarded, so the
      // draft itself isn't fed back in; the client's latest inbound is the last 'user' turn).
      let history = [];
      if (draftMsg.client_id) {
        try {
          const hRes = await fetch(
            `${process.env.SUPABASE_URL}/rest/v1/messages?client_id=eq.${draftMsg.client_id}&channel=eq.${channel}&status=not.in.(pending_review,discarded)&order=created_at.asc&limit=20`,
            { headers: sbHeaders }
          );
          const hRows = await hRes.json();
          if (Array.isArray(hRows)) history = hRows.map(m => ({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: m.content }));
        } catch(e) { console.error('Regenerate history fetch failed:', e.message); }
      }

      // Collapse consecutive same-role turns (Claude requires strict alternation) and make
      // sure it starts and ends on a 'user' turn.
      const msgs = [];
      for (const m of history) {
        if (msgs.length && msgs[msgs.length - 1].role === m.role) msgs[msgs.length - 1].content += '\n\n' + m.content;
        else msgs.push({ role: m.role, content: m.content });
      }
      if (!msgs.length || msgs[0].role !== 'user') msgs.unshift({ role: 'user', content: '(Start of conversation.)' });
      if (msgs[msgs.length - 1].role !== 'user') msgs.push({ role: 'user', content: '(Please draft my reply to the latest message above.)' });

      const baseVoice = channel === 'sms' ? SMS_VOICE : EMAIL_VOICE;
      const instrBlock = (instruction && String(instruction).trim())
        ? `\n\nSHINE'S INSTRUCTION FOR THIS SPECIFIC REPLY (highest priority — follow this for this one draft; it wins over anything above except: never invent availability):\n${String(instruction).trim()}`
        : '';
      const systemPrompt = baseVoice + (await guidanceSuffix()) + instrBlock;

      async function callClaude(model) {
        try {
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model, max_tokens: 1024, system: systemPrompt, messages: msgs })
          });
          const txt = await resp.text();
          let data; try { data = JSON.parse(txt); } catch(e) { return null; }
          if (!resp.ok || data.error) { console.error('Regenerate model error:', data && data.error && data.error.message); return null; }
          return (data.content && data.content[0] && data.content[0].text) ? data.content[0].text : null;
        } catch(e) { console.error('Regenerate call failed:', e.message); return null; }
      }

      let text = await callClaude('claude-sonnet-4-6');
      if (!text) text = await callClaude('claude-opus-4-8');
      if (!text) { res.status(200).json({ error: 'Could not generate a new draft — try again.' }); return; }

      const newDraft = text
        .replace('[BOOKING_INTENT]', '')
        .replace('[PRICING_REQUESTED]', '')
        .replace(/\[LEAD_INFO\][\s\S]*?\[\/LEAD_INFO\]/, '')
        .trim();

      // Persist the new draft on the pending message so it survives a refresh.
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?id=eq.${messageId}`, {
        method: 'PATCH',
        headers: { ...sbHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newDraft })
      });

      res.status(200).json({ success: true, draft: newDraft });
      return;
    }

    // POST action=research -> STEP 1: deep-research a lead (company + person via live web
    // search), read affordability, resolve the phone line type. Research only — NO drafting
    // here (that's the separate, fast action=draft step). Split so each call stays well under
    // Vercel's 60s function ceiling regardless of web-search latency.
    if (req.method === 'POST' && req.body.action === 'research') {
      const lead = req.body.lead || {};
      const emailDomain = (lead.email && lead.email.indexOf('@') !== -1) ? lead.email.split('@')[1].trim().toLowerCase() : '';

      const RESEARCH_SYSTEM = `You are the research analyst for Shine Thankappan, a corporate mentalist and magician based in Austin, TX. Given one inbound lead, use the web_search tool to research the company and the person, judge how much they can afford, and resolve their phone line type. You do NOT write any outreach — a separate step drafts the messages.

1. COMPANY: From the email domain and any company name, search and identify the organization — what it is, size/prestige signals, industry, location. If the email domain is a free provider (gmail/yahoo/outlook/icloud) or none is given, treat it as an individual / private lead and say so.
2. PERSON: Always search the person's name, corporate or private lead alike. For corporate leads, search name + company/domain and surface role/title plus any public LinkedIn/company-page/social snippet. For private/individual leads, run MULTIPLE targeted searches, not just one generic name search: try "<name> instagram", "<name> X" or "<name> twitter", and "<name> facebook" as separate queries (add city/area if the name is common), since a single plain-name search often misses social platforms that a targeted search catches. Useful context is anything confirming this looks like a real person versus a spam/test entry, or a public detail relevant to the event. If multiple people share the name or nothing distinct turns up, say so plainly. Never fabricate a title, profile match, or fact.
3. AFFORDABILITY: Judge whether this lead can afford a HIGH or LOW price, from concrete signals (company type/prestige, role, event type, guest count, venue). Shine's corporate floor is $2,500; his real corporate booking anchor is $3,500. Give a specific recommended anchor number and a short internal price range with when to push higher.
4. PHONE: The lead's phone is "${lead.phone || '(none given)'}". State which region/city the area code is registered to as a plain fact (this is useful for spotting out-of-town clients, e.g. a bachelorette party booking Shine from New York for an Austin event) — but do NOT speculate about whether the lead currently lives there, has relocated, or is "out of state", since people commonly keep the same number across moves and that inference is unreliable. If a "VERIFIED PHONE LINE TYPE" fact is given below, state mobile/landline directly and confidently (it's real carrier data, not a guess) and advise whether Shine should ALSO text the number (yes if mobile). If no verified fact is given, say you can't determine mobile vs landline without a carrier lookup and recommend confirming at freecarrierlookup.com.
5. FIT + STRATEGY: one tight paragraph on why this is (or isn't) a good fit and how to approach the reply.

BE CONCISE (time-sensitive): 1-2 short sentences per field. Do not pad.
HARD STYLE RULE: absolutely NO em dashes (—). Use commas, periods, or "to".

Return your ENTIRE response as a SINGLE fenced JSON code block (\`\`\`json ... \`\`\`) and nothing else, with exactly these string fields:
{
  "company": "what the company is + prestige/size signals, or 'Individual / private lead' if no company",
  "person": "role/title and any public profile findings, or what you could not find",
  "affordability": "HIGH or LOW read with the reasoning",
  "recommendedAnchor": "a dollar figure, e.g. $3,500",
  "priceRange": "internal range + when to push higher",
  "phone": "area code's registered region, mobile vs landline assessment, confidence, and whether to also text",
  "fit": "fit + strategy paragraph"
}`;

      // Real carrier lookup runs alongside nothing else here (before the LLM call), so its
      // ~1-2s (or 5s timeout on failure) adds minimal risk to the 60s budget.
      const lineType = lead.phone ? await lookupPhoneLineType(lead.phone) : null;

      const userPrompt = [
        `Lead name: ${lead.name || '(unknown)'}`,
        `Email: ${lead.email || '(none)'}${emailDomain ? '  (domain: ' + emailDomain + ')' : ''}`,
        `Phone: ${lead.phone || '(none)'}`,
        lineType ? `VERIFIED PHONE LINE TYPE (via Twilio carrier lookup): ${lineType.type}${lineType.carrierName ? ', carrier: ' + lineType.carrierName : ''}` : '',
        lead.company ? `Company field: ${lead.company}` : '',
        `Event type: ${lead.event_type || '(unspecified)'}`,
        lead.event_date ? `Event date: ${lead.event_date}` : '',
        lead.guests ? `Guests: ${lead.guests}` : '',
        lead.lead_source ? `Source: ${lead.lead_source}` : '',
        lead.notes ? `Notes / their message: ${lead.notes}` : ''
      ].filter(Boolean).join('\n') + (await fetchLeadConversation(lead.clientId));

      // Server-side web search: Claude runs the searches itself. Loop on pause_turn
      // (the server-tool loop caps and pauses; re-send to resume). Kept fast + bounded so
      // the browser reliably gets a response. Fewer searches + tighter output = lower latency.
      async function runResearch(model) {
        let messages = [{ role: 'user', content: userPrompt }];
        let text = '', ref = false;
        try {
          for (let i = 0; i < 2; i++) {
            const resp = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({
                model,
                max_tokens: 1800,
                system: RESEARCH_SYSTEM,
                // Basic web search (no per-result code-exec filtering) = much faster per search,
                // which keeps the whole call under Vercel's 60s function ceiling. Tried restoring
                // the dynamic-filtering version on 2026-07-13; measured 54.7s (vs ~23-30s here) and
                // the model reported it couldn't complete a live search in time. Reverted.
                // max_uses raised 2->4 same day so private-lead person search has room to run
                // multiple platform-targeted queries (instagram/X/facebook) instead of one generic
                // name search; measured latency stayed well under budget (see brain notes).
                tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
                messages
              })
            });
            const data = await resp.json();
            if (!resp.ok || data.error) { console.error('Research model error:', data && data.error && data.error.message); break; }
            if (data.stop_reason === 'refusal') { ref = true; break; }
            text = '';
            if (Array.isArray(data.content)) data.content.forEach(b => { if (b.type === 'text') text += b.text; });
            if (data.stop_reason === 'pause_turn') {
              messages = [{ role: 'user', content: userPrompt }, { role: 'assistant', content: data.content }];
              continue; // resumed turn re-emits text; keep only the last pass
            }
            break;
          }
        } catch(e) { console.error('Research call failed (' + model + '):', e.message); }
        return { text, ref };
      }

      // Single fast pass on Opus 4.8 (testing 2026-07-13: research now persists per lead via
      // localStorage, so it only runs once per lead, making the extra cost/latency worth it for
      // quality). No fallback: two research passes back-to-back risk the 60s function limit.
      const r = await runResearch('claude-opus-4-8');
      const finalText = r.text; const refused = r.ref;

      if (refused) { res.status(200).json({ error: 'The AI declined this one (rare false positive). Try again, or research manually.' }); return; }
      if (!finalText) { res.status(200).json({ error: 'Could not generate research — try again in a moment.' }); return; }

      // Parse the trailing ```json block; fall back to first {...last }.
      let parsed = null;
      try {
        const blocks = finalText.match(/```json\s*([\s\S]*?)```/gi);
        let jsonStr = null;
        if (blocks && blocks.length) jsonStr = blocks[blocks.length - 1].replace(/```json\s*/i, '').replace(/```$/, '');
        else { const s = finalText.indexOf('{'); const e = finalText.lastIndexOf('}'); if (s !== -1 && e > s) jsonStr = finalText.slice(s, e + 1); }
        if (jsonStr) parsed = JSON.parse(jsonStr);
      } catch(e) { console.error('Research parse failed:', e.message); }

      // Web search embeds <cite> citation tags in the text; strip them for clean display.
      const stripCite = (s) => typeof s === 'string' ? s.replace(/<\/?cite[^>]*>/gi, '').replace(/[ \t]+\n/g, '\n').trim() : s;
      if (parsed) Object.keys(parsed).forEach(k => { parsed[k] = stripCite(parsed[k]); });

      if (!parsed) { res.status(200).json({ success: true, research: null, raw: stripCite(finalText) }); return; }
      res.status(200).json({ success: true, research: parsed });
      return;
    }

    // POST action=draft -> STEP 2: draft the email + SMS for a lead, using the research from
    // step 1 as context. NO web search here, so it's fast (~8-15s) and never risks the timeout.
    if (req.method === 'POST' && req.body.action === 'draft') {
      const lead = req.body.lead || {};
      const rc = req.body.research || {};
      const hasEmail = !!(lead.email && String(lead.email).trim());
      const sourceLabel = (lead.lead_source && String(lead.lead_source).trim()) || '';

      const DRAFT_SYSTEM_BASE = `You are Shine Thankappan, a corporate mentalist and magician based in Austin, TX (website texasmentalist.com, phone +1 737-271-5308). You perform a 45-60 minute interactive mentalism + visual-magic STAGE SHOW (your strength) and also do strolling/walk-around magic. Draft outreach for a new lead. These are DRAFTS you will review and send yourself.

Use the research context provided (company, affordability, recommended anchor, event details) to write a confident, specific reply that shows you understood their event. Do NOT quote a specific price or dollar figure in this first message, even if a recommended anchor price is given, use it only to inform your tone and confidence, not to state a number. Show genuine interest, ask at most 1-2 light qualifying questions, and offer to send over pricing/next steps once you know a bit more. Never invent availability.

Tone by event type — the STAGE SHOW is always the headline:
- Corporate events / weddings: lead with the stage show; strolling only as an optional add-on.
- Private parties (birthday, bachelorette, house/home, small private): lead with and emphasize the stage show; do NOT bring up strolling unless the client asked for it.
- Cocktail parties: mention both strolling and the stage show.

Voice: first person, short sentences, real contractions (I'm, that's, you're). No stock openers ("Thanks for reaching out", "I hope this finds you well"), no corporate filler ("I appreciate your interest", "don't hesitate to reach out"). A little genuine warmth, never try-hard.

HARD STYLE RULE: absolutely NO em dashes (—). Use commas, periods, or "to".

If a CURRENT DRAFT and feedback from Shine are shown below, you are REVISING: change the message(s) to address his feedback while keeping everything that already works, and directly answer any question he asks (e.g. "did you consider the anniversary angle?"). Put your reply to Shine in the "note" field — one or two short sentences, like a collaborator talking back (answer the question, or say what you changed and why). On a first draft with no feedback, leave "note" as an empty string.`;

      const DRAFT_SYSTEM_EMAIL_TAIL = `

This lead has an email on file, so draft BOTH an email and an SMS. The email is the primary, more detailed message, one or two short paragraphs. The SMS should be noticeably shorter and more condensed than the email, a natural-sounding text pointing to and complementing it, not a copy-paste of the same content, but it does NOT need to be capped at ~160 chars — let it run a bit longer if there's a bit more worth saying in the moment. (If Shine wants a bare one-line reminder text for a specific lead, he can just edit the SMS himself before sending.)

Return your ENTIRE response as a SINGLE fenced JSON code block (\`\`\`json ... \`\`\`) and nothing else, with exactly these string fields:
{
  "note": "1-2 short sentences replying to Shine's feedback/question, or \\"\\" on a first draft",
  "emailSubject": "the email subject line",
  "emailBody": "the full email body, signed 'Shine, The Mentalist / texasmentalist.com / 737-271-5308'",
  "sms": "a shorter, condensed text version, still noticeably briefer than the email"
}`;

      const DRAFT_SYSTEM_SMS_ONLY_TAIL = `

This lead has NO email on file, only a phone number, so SMS is the only way to reach them. Draft ONLY a text message, leave emailSubject and emailBody as empty strings. This is the first message they'll get from you, so the text needs to do the whole job an email would have, not just nudge toward one. Hard technical ceiling: stay well under 1500 characters even so — carriers reject SMS bodies over 1600.

Because this is a first-touch cold text, be slightly warmer than a normal quick SMS reply, a genuine, personal opening line, not "Hi, saw your inquiry." ${sourceLabel ? `Open by naturally mentioning you saw their event inquiry on ${sourceLabel} (referencing their actual event details, not a generic form) so it's obviously not spam.` : `Open by naturally referencing their actual event details so it's obviously not spam.`} It's fine to run longer than a typical quick nudge if the message needs it, but keep it reading like a real text, not an email crammed into a text box. End with a short sign-off that includes the website, for example "- Shine, texasmentalist.com".

Return your ENTIRE response as a SINGLE fenced JSON code block (\`\`\`json ... \`\`\`) and nothing else, with exactly these string fields:
{
  "note": "1-2 short sentences replying to Shine's feedback/question, or \\"\\" on a first draft",
  "emailSubject": "",
  "emailBody": "",
  "sms": "the full text message, warm and specific, signed off with the website"
}`;

      const DRAFT_SYSTEM = DRAFT_SYSTEM_BASE + (hasEmail ? DRAFT_SYSTEM_EMAIL_TAIL : DRAFT_SYSTEM_SMS_ONLY_TAIL);

      let draftUser = [
        `Lead name: ${lead.name || '(unknown)'}`,
        `Event type: ${lead.event_type || '(unspecified)'}`,
        lead.event_date ? `Event date: ${lead.event_date}` : '',
        lead.guests ? `Guests: ${lead.guests}` : '',
        lead.notes ? `Their message / notes: ${lead.notes}` : '',
        sourceLabel ? `Lead source: ${sourceLabel}` : '',
        hasEmail ? '' : 'NOTE: this lead has no email on file, SMS only.',
        '',
        'RESEARCH CONTEXT:',
        rc.company ? `Company: ${rc.company}` : '',
        rc.affordability ? `Affordability: ${rc.affordability}` : '',
        rc.recommendedAnchor ? `Recommended anchor price: ${rc.recommendedAnchor}` : '',
        rc.fit ? `Fit/strategy: ${rc.fit}` : ''
      ].filter(Boolean).join('\n') + (await fetchLeadConversation(lead.clientId));

      // Iterative refinement: if Shine sent feedback on a current draft, include the draft
      // + his earlier feedback so the revision builds on what's already there.
      const cur = req.body.current || null;
      const priorInstr = Array.isArray(req.body.priorInstructions) ? req.body.priorInstructions.filter(Boolean) : [];
      if (cur && (cur.emailBody || cur.sms)) {
        draftUser += '\n\nCURRENT DRAFT (revise this, keep what works):\n' +
          (cur.emailSubject ? 'Email subject: ' + cur.emailSubject + '\n' : '') +
          (cur.emailBody ? 'Email body:\n' + cur.emailBody + '\n' : '') +
          (cur.sms ? 'SMS: ' + cur.sms : '');
        if (priorInstr.length) draftUser += '\n\nShine\'s earlier feedback (for context):\n- ' + priorInstr.join('\n- ');
      }

      const instr = (req.body.instruction && String(req.body.instruction).trim())
        ? `\n\nSHINE'S LATEST FEEDBACK / REQUEST (highest priority, act on this; never invent availability):\n${String(req.body.instruction).trim()}`
        : '';

      async function callDraft(model) {
        try {
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model, max_tokens: 1200, system: DRAFT_SYSTEM + instr, messages: [{ role: 'user', content: draftUser }] })
          });
          const txt = await resp.text();
          let data; try { data = JSON.parse(txt); } catch(e) { return { text: null, ref: false }; }
          if (!resp.ok || data.error) { console.error('Draft model error:', data && data.error && data.error.message); return { text: null, ref: false }; }
          if (data.stop_reason === 'refusal') return { text: null, ref: true };
          let t = ''; if (Array.isArray(data.content)) data.content.forEach(b => { if (b.type === 'text') t += b.text; });
          return { text: t, ref: false };
        } catch(e) { console.error('Draft call failed (' + model + '):', e.message); return { text: null, ref: false }; }
      }

      // Opus 4.8 FIRST for the draft: it's less refusal-prone, so it usually succeeds in ONE
      // call. Going Sonnet-first risked a refusal on payment-heavy corporate leads, which then
      // fell back to Opus = two stacked calls (~40s+) that the browser dropped ("Network issue"
      // client-side though the server returned 200). Sonnet is only a last-resort if Opus errors.
      let dr = await callDraft('claude-opus-4-8');
      if (!dr.text && !dr.ref) dr = await callDraft('claude-sonnet-5');
      if (dr.ref) { res.status(200).json({ error: 'The AI declined this draft (rare). Try again.' }); return; }
      if (!dr.text) { res.status(200).json({ error: 'Could not draft the messages — try again.' }); return; }

      let drafts = null;
      try {
        const blocks = dr.text.match(/```json\s*([\s\S]*?)```/gi);
        let js = null;
        if (blocks && blocks.length) js = blocks[blocks.length - 1].replace(/```json\s*/i, '').replace(/```$/, '');
        else { const s = dr.text.indexOf('{'); const e = dr.text.lastIndexOf('}'); if (s !== -1 && e > s) js = dr.text.slice(s, e + 1); }
        if (js) drafts = JSON.parse(js);
      } catch(e) { console.error('Draft parse failed:', e.message); }

      if (!drafts) { res.status(200).json({ success: true, drafts: null, raw: dr.text }); return; }
      res.status(200).json({ success: true, drafts });
      return;
    }

    // POST action=callprep -> a plain-text call prep brief for an upcoming call with this
    // lead, meant to be copy-pasted straight into Shine's notes app. Reuses whatever research
    // has already been cached client-side (no fresh web_search here, so this stays fast) plus
    // the actual message history, so it doesn't re-ask anything already answered.
    if (req.method === 'POST' && req.body.action === 'callprep') {
      const lead = req.body.lead || {};
      const rc = req.body.research || {};

      const CALLPREP_SYSTEM = `You are helping Shine Thankappan, a corporate mentalist and magician based in Austin, TX, prepare for an upcoming phone call with a lead or client. Given everything known about them (event details, notes, any prior research, and the actual message history below), write a short CALL PREP brief he can paste straight into his notes app and glance at right before the call.

Ground everything in the actual details given. Never invent facts, availability, or budget numbers that aren't implied by the research/notes. If something important is unknown (no research on file, thin notes), say so plainly instead of guessing.

CRITICAL — never invent a specific time, date, or number. If a call time, price, or other concrete detail was proposed or confirmed anywhere in the message history below, quote that exact value, word for word, don't paraphrase it into a different number. If it's genuinely ambiguous or was never stated, say so explicitly (e.g. "confirm the exact time you two land on") rather than picking a plausible-sounding placeholder.

Shine's corporate floor is $2,500, his standard corporate anchor is $3,500. Use the research's recommended anchor/affordability read if given; otherwise fall back to these defaults and say you're using the default.

Output PLAIN TEXT ONLY (no markdown asterisks/bold, this is pasted into a plain notes app). Use exactly this shape:

SNAPSHOT
2-4 lines: who they are, the event, date, guest count, venue, and the budget/affordability read. IMPORTANT: scan the message history for any specific price/rate Shine already stated in writing (an email or text he sent). If one exists, state it explicitly here, and flag clearly if it may need revising, e.g. it was quoted for a different guest count or scope than what's now confirmed. Don't let an old written number get contradicted for free on the call.

QUESTIONS TO ASK
3-6 bullets ("- " prefix), close-blocking questions first (payment process/PO or decision authority, timing/logistics specific to their venue or organization), then personalization questions (tone, names, details to weave in). Do NOT re-ask anything they already answered in the message history below.

HOW TO CLOSE
2-4 bullets: the price to lead with and how to frame it given their budget sensitivity (reconcile it with any already-quoted number from the SNAPSHOT above), plus the concrete next step to push for on the call.

HARD STYLE RULE: absolutely no em dashes (—). Use commas, periods, or "to".`;

      const userPrompt = [
        `Lead name: ${lead.name || '(unknown)'}`,
        `Event type: ${lead.event_type || '(unspecified)'}`,
        lead.event_date ? `Event date: ${lead.event_date}` : '',
        lead.guests ? `Guests: ${lead.guests}` : '',
        lead.venue ? `Venue: ${lead.venue}` : '',
        lead.status ? `Current status: ${lead.status}` : '',
        lead.notes ? `Notes: ${lead.notes}` : '',
        '',
        rc && (rc.company || rc.person || rc.affordability || rc.recommendedAnchor || rc.fit)
          ? [
              'PRIOR RESEARCH ON FILE:',
              rc.company ? `Company: ${rc.company}` : '',
              rc.person ? `Person: ${rc.person}` : '',
              rc.affordability ? `Affordability: ${rc.affordability}` : '',
              rc.recommendedAnchor ? `Recommended anchor: ${rc.recommendedAnchor}` : '',
              rc.priceRange ? `Price range: ${rc.priceRange}` : '',
              rc.fit ? `Fit/strategy: ${rc.fit}` : ''
            ].filter(Boolean).join('\n')
          : '(No prior research on file for this lead.)'
      ].filter(Boolean).join('\n') + (await fetchLeadConversation(lead.clientId));

      let text = '';
      try {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 900, system: CALLPREP_SYSTEM, messages: [{ role: 'user', content: userPrompt }] })
        });
        const data = await resp.json();
        if (!resp.ok || data.error) throw new Error(data && data.error && data.error.message || 'Model error');
        if (data.stop_reason === 'refusal') { res.status(200).json({ error: 'The AI declined this one (rare). Try again.' }); return; }
        if (Array.isArray(data.content)) data.content.forEach(b => { if (b.type === 'text') text += b.text; });
      } catch(e) {
        console.error('Call prep failed:', e.message);
        res.status(200).json({ error: 'Could not generate the call prep brief — try again.' });
        return;
      }

      if (!text.trim()) { res.status(200).json({ error: 'Could not generate the call prep brief — try again.' }); return; }
      res.status(200).json({ success: true, brief: text.trim() });
      return;
    }

    // POST action=triage -> scan the whole active pipeline in ONE call and suggest concrete
    // next actions (follow up, call instead of text, mark lost, etc), ranked most urgent first.
    // Frontend sends a compact per-lead summary (status, hours since Shine last heard from
    // them, event proximity, hot flag, short notes) rather than full message history, so this
    // stays fast and cheap even as the lead list grows.
    if (req.method === 'POST' && req.body.action === 'triage') {
      const leads = Array.isArray(req.body.leads) ? req.body.leads : [];
      if (!leads.length) { res.status(200).json({ success: true, items: [] }); return; }

      const TRIAGE_SYSTEM = `You are triaging Shine Thankappan's active client/lead pipeline (a mentalist and magician based in Austin, TX). You get a compact list of leads/clients: their status, how many hours since Shine last heard from them, their event date and how many days away it is, guest count, whether he's flagged them hot, the source, and short notes.

Decide which ones need an action from Shine RIGHT NOW, and say exactly what to do. Guidance:
- A quiet lead is more urgent the closer their event date is, and more urgent if flagged hot.
- Word the action specifically to the situation, don't just say "follow up" every time: sometimes it's a follow-up text/email, sometimes "call instead of text, it's been too long for another message", sometimes "this one looks dead, consider marking it lost so it stops cluttering the list", sometimes "their event is in N days and they haven't signed the contract, this is urgent."
- A booked/contract_sent/intake_sent lead going quiet with an event date coming up soon is a real business risk, not just an admin nag. Flag those high.
- Skip anything that does not need action right now (recently contacted within a normal window, nothing pending on Shine's side, or already fully wrapped up).
- Never invent facts not present in the data given, and never invent a specific date/time/number.

HARD STYLE RULE: absolutely no em dashes (—). Use commas, periods, or "to".

Return ONLY a single fenced JSON code block (\`\`\`json ... \`\`\`) and nothing else, with this exact shape:
{"items": [{"clientId": "...", "urgency": "high"|"medium"|"low", "action": "one specific, concrete next step, imperative voice, under ~20 words", "reason": "one short clause grounding it in the actual facts given"}]}
Order items most urgent first (high, then medium, then low). Omit any lead that does not need action.`;

      const userPrompt = 'LEADS:\n' + leads.map(function(l) {
        return '- id:' + l.clientId + ' name:"' + (l.name || '') + '" status:' + (l.statusLabel || l.status || '') +
          ' hoursSinceContact:' + (l.hoursSinceContact != null ? l.hoursSinceContact : 'n/a') +
          ' hot:' + (l.hot ? 'yes' : 'no') +
          ' eventDate:' + (l.eventDate || 'n/a') + ' daysToEvent:' + (l.daysToEvent != null ? l.daysToEvent : 'n/a') +
          ' guests:' + (l.guests || 'n/a') + ' source:' + (l.leadSource || 'n/a') +
          ' notes:"' + String(l.notes || '').replace(/"/g, "'").slice(0, 200) + '"';
      }).join('\n');

      let text = '';
      try {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: Math.min(4000, 500 + leads.length * 150), system: TRIAGE_SYSTEM, messages: [{ role: 'user', content: userPrompt }] })
        });
        const data = await resp.json();
        if (!resp.ok || data.error) throw new Error(data && data.error && data.error.message || 'Model error');
        if (data.stop_reason === 'refusal') { res.status(200).json({ error: 'The AI declined this one (rare). Try again.' }); return; }
        if (Array.isArray(data.content)) data.content.forEach(b => { if (b.type === 'text') text += b.text; });
      } catch(e) {
        console.error('Triage failed:', e.message);
        res.status(200).json({ error: 'Could not run the triage — try again.' });
        return;
      }

      let items = null;
      try {
        const blocks = text.match(/```json\s*([\s\S]*?)```/gi);
        let js = null;
        if (blocks && blocks.length) js = blocks[blocks.length - 1].replace(/```json\s*/i, '').replace(/```$/, '');
        else { const s = text.indexOf('{'); const e = text.lastIndexOf('}'); if (s !== -1 && e > s) js = text.slice(s, e + 1); }
        if (js) items = (JSON.parse(js) || {}).items;
      } catch(e) { console.error('Triage parse failed:', e.message); }

      if (!Array.isArray(items)) { res.status(200).json({ error: 'Could not read the triage results — try again.' }); return; }
      res.status(200).json({ success: true, items });
      return;
    }

    // POST action=findleads -> web-search sweep for live event opportunities that fit Shine,
    // each with a drafted intro email. NEVER auto-sends: every result is a draft Shine reviews
    // and sends himself one at a time (see action=send-outreach-lead below), per the standing
    // rule that outreach is always a draft. Contacts are only included if a real, specific,
    // publicly-listed email was found via search, never guessed.
    if (req.method === 'POST' && req.body.action === 'findleads') {
      const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      const todayLabel = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const FINDLEADS_SYSTEM = `You are Shine Thankappan's lead-scout. He is a corporate mentalist and magician based in Austin, TX (texasmentalist.com, +1 737-271-5308, 156 five-star Google reviews). He targets corporate events, conferences, and private events with budgets fitting his floor of $2,500+.

TODAY'S REAL DATE IS ${todayLabel} (${todayISO}). Do not rely on your training data or guess at "current" -- use this exact date as the source of truth for what counts as upcoming.

CRITICAL DATE RULE: only surface events that have NOT happened yet relative to ${todayISO}. Event calendar sites and aggregators frequently keep past events listed on the same page as upcoming ones with no visual distinction, so check every candidate's actual date against today before including it. If an event's date is before ${todayISO}, it is DEAD, discard it immediately and do not spend a lead slot on it, even if everything else about it looks like a great fit. When a listing's date is genuinely ambiguous (no year given, "recurring event", etc), search one step further to confirm the specific upcoming occurrence's date before including it; never assume ambiguous means upcoming.

This is a TWO-PHASE job. Do not skip phase 2.

PHASE 1, survey: use web_search to find CURRENT, ACTIVE, real event opportunities where entertainment is plausibly still being sourced. Search across these angles (spread your searches across several of them, don't just do one):
1. Event planning / RFP boards: Cvent supplier network, EventSource, MeetingsNet, BizBash event listings
2. Conference calendars: upcoming corporate conferences and trade shows in Austin, Houston, Dallas, and nationally where entertainment is typically hired
3. Venue booking boards: hotel event spaces, convention centers seeking entertainment or posting open dates
4. LinkedIn: event planners, corporate event coordinators, or DMCs posting about upcoming events or seeking entertainers
5. Local Austin / Texas business event listings (Austin Chamber, Texas Monthly events calendar, etc.)

Do NOT search or surface leads from GigSalad, The Bash, or Bark.com. Shine already has active accounts on all three and gets notified directly of new requests there, so those results are pure duplicate noise for this tool. Skip that angle entirely, spend the freed-up search budget on the angles above instead.

Narrow this down to your best 3-4 candidates rather than trying to log every mention. Quality over quantity: a lead you can actually email is worth far more than a longer list of dead ends. You have a hard time budget for this whole task, so stop surveying once you have 3-4 solid candidates and move to phase 2, don't keep surveying for more.

PHASE 2, verify contact info: for every candidate, run at least one MORE targeted search specifically for that organization's contact info before concluding no email exists, e.g. "<organization name> contact email", "<organization name> contact us", "<organization name> events@ OR info@". Do not stop at the first article or aggregator listing that mentioned the opportunity, that is rarely where a contact email lives. Go to the organization's own site.

A generic inbox on the organization's OWN domain (info@, contact@, events@, hello@, bookings@, rentals@, etc) counts as a REAL, usable contactEmail, it does not need to belong to a named person. Prefer it over leaving contactEmail null.

CRITICAL, NON-NEGOTIABLE RULE: only include a contactEmail if you actually found it published on the organization's own site or a specific listing (a staff bio page, a "contact us" page, a posted RFP contact, a footer address). NEVER invent, guess, or construct an email address that you did not literally see (e.g. never assume firstname@company.com or info@company.com just because you know the domain, unless you actually saw that address published somewhere). The only legitimate reason to leave contactEmail null is that you genuinely ran a phase 2 search on that organization's own site and it truly has no published contact email anywhere. Do not default to null just because the first survey search didn't happen to surface one.

For each lead found, also judge fit for Shine (corporate mentalist, stage show is his strength, Austin-based, $2,500+ floor) in one sentence.

For every lead where you found a real contactEmail (and ONLY those), draft a short, confident, no-fluff introduction email in Shine's voice: first person, direct, no stock openers ("I hope this finds you well", "I'm excited to reach out"), no corporate filler, mention the specific event/opportunity so it's clearly not a form blast, 1-2 short paragraphs, sign off "Shine, The Mentalist | texasmentalist.com | +1 (737) 271-5308". No em dashes anywhere in any field.

Return ONLY a single fenced JSON code block (\`\`\`json ... \`\`\`) and nothing else:
{"leads": [{
  "source": "where you found it, e.g. 'BizBash Austin events calendar' or 'Cvent supplier network RFP'",
  "eventType": "short event type/category",
  "eventWindow": "date or date window as stated, or 'not specified'",
  "location": "city/venue if known",
  "estimatedBudget": "budget or audience size signal if listed, else 'not listed'",
  "contactName": "a real name if found, else null",
  "contactEmail": "a real, specific, publicly-listed email, or null if none exists, NEVER guessed",
  "fit": "one sentence on why this is (or isn't) a good fit",
  "draftSubject": "email subject, or null if contactEmail is null",
  "draftBody": "the drafted intro email body, or null if contactEmail is null"
}]}
Depth over breadth: 3-4 well-verified leads with real contact info actually checked beats a longer list you didn't dig into. You are on a strict search budget, spend it on verifying contact info for a few candidates, not surveying more of them.`;

      let text = '';
      try {
        // max_uses:8 + 2-iteration cap, not more: the research action measured ~54.7s at a
        // similar setting and had to be pulled back to stay inside Vercel's 60s Hobby ceiling.
        // Broader coverage isn't worth a timeout that returns nothing usable.
        let messages = [{ role: 'user', content: 'Find current lead opportunities for Shine per the instructions.' }];
        for (let i = 0; i < 2; i++) {
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: 'claude-opus-4-8', max_tokens: 4000, system: FINDLEADS_SYSTEM,
              tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
              messages
            })
          });
          const data = await resp.json();
          if (!resp.ok || data.error) { console.error('Find leads model error:', data && data.error && data.error.message); break; }
          if (data.stop_reason === 'refusal') { res.status(200).json({ error: 'The AI declined this one (rare). Try again.' }); return; }
          text = '';
          if (Array.isArray(data.content)) data.content.forEach(b => { if (b.type === 'text') text += b.text; });
          if (data.stop_reason === 'pause_turn') { messages = [messages[0], { role: 'assistant', content: data.content }]; continue; }
          break;
        }
      } catch(e) {
        console.error('Find leads failed:', e.message);
        res.status(200).json({ error: 'Could not run the lead search — try again.' });
        return;
      }

      let leads = null;
      try {
        const blocks = text.match(/```json\s*([\s\S]*?)```/gi);
        let js = null;
        if (blocks && blocks.length) js = blocks[blocks.length - 1].replace(/```json\s*/i, '').replace(/```$/, '');
        else { const s = text.indexOf('{'); const e = text.lastIndexOf('}'); if (s !== -1 && e > s) js = text.slice(s, e + 1); }
        if (js) leads = (JSON.parse(js) || {}).leads;
      } catch(e) { console.error('Find leads parse failed:', e.message); }

      if (!Array.isArray(leads)) { res.status(200).json({ error: 'Could not read the lead search results — try again.' }); return; }
      const stripCite = (s) => typeof s === 'string' ? s.replace(/<\/?cite[^>]*>/gi, '').replace(/[ \t]+\n/g, '\n').trim() : s;
      leads.forEach(l => Object.keys(l).forEach(k => { l[k] = stripCite(l[k]); }));
      const beforeCount = leads.length;
      leads = leads.filter(l => !isPastEventWindow(l.eventWindow, todayISO));
      if (leads.length < beforeCount) console.log(`Find leads: dropped ${beforeCount - leads.length} past-dated lead(s) as a safety net (today=${todayISO})`);

      // Flag anyone already in the pipeline BEFORE Shine sees the card.
      //
      // The lead search is a fresh web sweep with no memory: the model is not
      // given the client list and cannot know who has already been contacted,
      // so it will happily draft a cold intro to someone mid-negotiation or to
      // a venue that already declined. The existing email lookup on
      // send-outreach-lead runs only AFTER Resend has delivered, which means
      // "you already know this person" arrives too late to act on.
      //
      // Deliberately a lookup rather than a prompt instruction -- this has to
      // be right every time, not usually.
      try {
        const withEmail = leads.filter(l => l.contactEmail);
        if (withEmail.length) {
          const sbHeaders = { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` };
          await Promise.all(withEmail.map(async (l) => {
            try {
              const r = await fetch(
                `${process.env.SUPABASE_URL}/rest/v1/clients?email=ilike.${emailIlikeParam(l.contactEmail)}` +
                `&select=id,name,status,last_activity,last_channel,lead_source&order=created_at.desc&limit=1`,
                { headers: sbHeaders }
              );
              if (!r.ok) return;                       // fail open: no badge beats no leads
              const rows = await r.json();
              const hit = Array.isArray(rows) ? rows[0] : null;
              if (!hit) return;
              l.known = {
                name: hit.name || null,
                status: hit.status || null,
                lastActivity: hit.last_activity || null,
                lastChannel: hit.last_channel || null,
                leadSource: hit.lead_source || null,
              };
            } catch (e) { /* one failed lookup must not lose the whole sweep */ }
          }));
          const n = leads.filter(l => l.known).length;
          if (n) console.log(`Find leads: ${n} of ${leads.length} lead(s) already in the pipeline`);
        }
      } catch (e) {
        console.error('Find leads: known-contact check failed:', e.message);
      }

      res.status(200).json({ success: true, leads });
      return;
    }

    // POST action=send-outreach-lead -> Shine explicitly clicked Send on one drafted intro
    // email from action=findleads. Finds-or-creates the client (case-insensitive email match,
    // same fix as the rest of the app) so a reply lands in the normal pipeline, then sends via
    // Resend and logs the outbound message. This is the ONLY place a cold-outreach email
    // actually goes out, and it only fires on an explicit per-lead click, never automatically.
    if (req.method === 'POST' && req.body.action === 'send-outreach-lead') {
      const { name, email, eventType, eventWindow, location, source, subject, body } = req.body;
      if (!email || !subject || !body) { res.status(400).json({ error: 'Missing email, subject, or body' }); return; }
      const sbHeaders = { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` };
      const now = new Date().toISOString();

      try {
        let clientId = null;
        const existingRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?email=ilike.${emailIlikeParam(email)}&order=created_at.desc&limit=1`, { headers: sbHeaders });
        const existingRows = await existingRes.json();
        const existing = Array.isArray(existingRows) ? existingRows[0] : null;

        if (existing) {
          clientId = existing.id;
        } else {
          const notesLines = [];
          if (source) notesLines.push('Found via cold-outreach lead search: ' + source);
          if (eventWindow) notesLines.push('Event window: ' + eventWindow);
          if (location) notesLines.push('Location: ' + location);
          const createRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...sbHeaders, 'Prefer': 'return=representation' },
            body: JSON.stringify({
              name: name || email, email, event_type: eventType || '', notes: notesLines.join('\n'),
              lead_source: 'Cold outreach' + (source ? ' (' + source + ')' : ''),
              status: 'new', last_activity: now, last_channel: 'email'
            })
          });
          const createdRows = await createRes.json();
          const created = Array.isArray(createdRows) ? createdRows[0] : null;
          if (!created) { const t = JSON.stringify(createdRows); throw new Error('Could not create client: ' + t); }
          clientId = created.id;
        }

        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
          body: JSON.stringify({ from: 'Shine, The Mentalist <shine@texasmentalist.com>', to: email, subject, text: body })
        });
        if (!emailRes.ok) { const t = await emailRes.text(); throw new Error('Resend failed: ' + t); }

        await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...sbHeaders },
          body: JSON.stringify({ client_id: clientId, channel: 'email', direction: 'outbound', content: body, status: 'sent', to_address: email, email_subject: subject, created_at: now })
        });
        if (existing) {
          await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${clientId}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json', ...sbHeaders },
            body: JSON.stringify({ last_activity: now, last_channel: 'email' })
          });
        }

        res.status(200).json({ success: true, clientId, reusedExisting: !!existing });
      } catch(e) {
        console.error('Send outreach lead failed:', e.message);
        res.status(500).json({ error: e.message });
      }
      return;
    }

    // POST action=past-clients-scan -> find completed past clients due for a relationship-keeping
    // note (birthday: ~1 month before the event's annual anniversary; bachelorette/bachelor: a
    // one-time casual check-in a couple months out; everything else: a periodic check-in). Uses
    // Gmail (read-only) to confirm real correspondence exists and pull light context, plus a
    // lightweight secondary sweep for past clients who were never logged in this app's own
    // database. Drafting happens per-item on demand (action=past-client-draft), same pattern as
    // Suggested Actions; nothing here ever auto-sends.
    if (req.method === 'POST' && req.body.action === 'past-clients-scan') {
      const sessions = await getActiveGmailSessions();
      if (!sessions.length) { res.status(200).json({ error: 'gmail_not_connected' }); return; }

      const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      const sbHeaders = { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}` };
      // Never flag one of Shine's own connected inboxes (or his business domain) as a "missing"
      // past client in the secondary sweep below.
      const ownEmails = new Set(sessions.map(s => (s.email || '').toLowerCase()).filter(Boolean));

      try {
        // "Completed" lives in three places depending on when/how the gig was closed out:
        // legacy clients.status='completed' (pre contact/gig-separation refactor), the live
        // bookings.status='completed' (the current model), and the gigs table (the permanent
        // per-performance archive written by "Mark as Done", which has no status of its own).
        // Merge all three, keyed by client, keeping each client's MOST RECENT completed event
        // so a repeat client's due reminder is based on their latest show, not their first.
        const [clientsRes, bookingsRes, gigsRes] = await Promise.all([
          fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?select=id,name,email,phone,event_type,event_date,status`, { headers: sbHeaders }),
          fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings?status=eq.completed&select=client_id,event_type,event_date`, { headers: sbHeaders }),
          fetch(`${process.env.SUPABASE_URL}/rest/v1/gigs?client_id=not.is.null&select=client_id,type,date`, { headers: sbHeaders })
        ]);
        const allClients = await clientsRes.json();
        if (!Array.isArray(allClients)) throw new Error('Could not read clients');
        const completedBookings = await bookingsRes.json();
        const completedGigs = await gigsRes.json();
        const knownEmails = new Set(allClients.map(c => (c.email || '').toLowerCase()).filter(Boolean));

        const clientsById = {};
        allClients.forEach(c => { clientsById[c.id] = c; });
        const bestByClient = {};
        const considerDate = (clientId, eventType, eventDate) => {
          if (!clientId || !eventDate) return;
          const cur = bestByClient[clientId];
          if (!cur || new Date(eventDate).getTime() > new Date(cur.eventDate).getTime()) {
            bestByClient[clientId] = { eventType: eventType || '', eventDate };
          }
        };
        allClients.forEach(c => { if (c.status === 'completed') considerDate(c.id, c.event_type, c.event_date); });
        (Array.isArray(completedBookings) ? completedBookings : []).forEach(b => considerDate(b.client_id, b.event_type, b.event_date));
        (Array.isArray(completedGigs) ? completedGigs : []).forEach(g => considerDate(g.client_id, g.type, g.date));

        const completed = Object.keys(bestByClient)
          .map(cid => clientsById[cid] ? { id: cid, name: clientsById[cid].name, email: clientsById[cid].email, phone: clientsById[cid].phone, event_type: bestByClient[cid].eventType, event_date: bestByClient[cid].eventDate } : null)
          .filter(Boolean);

        let lastOutboundByClient = {};
        if (completed.length) {
          const ids = completed.map(c => c.id).join(',');
          const mRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?client_id=in.(${ids})&direction=eq.outbound&order=created_at.desc&select=client_id,created_at`, { headers: sbHeaders });
          const mRows = await mRes.json();
          if (Array.isArray(mRows)) mRows.forEach(m => { if (!lastOutboundByClient[m.client_id]) lastOutboundByClient[m.client_id] = m.created_at; });
        }

        const items = [];
        for (const c of completed) {
          const lastContact = lastOutboundByClient[c.id];
          const daysSinceLastContact = lastContact ? Math.floor((Date.now() - new Date(lastContact).getTime()) / 86400000) : null;
          const due = computeDueReason(c.event_type, c.event_date, todayISO, daysSinceLastContact);
          if (!due) continue;

          // Try each connected inbox in turn -- stop at the first one with real correspondence.
          let gmailContext = null, gmailFoundIn = null;
          if (c.email) {
            for (const s of sessions) {
              const msgs = await gmailSearch(s.accessToken, `to:${c.email} OR from:${c.email}`, 3);
              if (msgs.length) {
                const meta = await gmailGetMessageMeta(s.accessToken, msgs[0].id);
                if (meta) { gmailContext = { subject: meta.subject, snippet: meta.snippet, date: meta.date }; gmailFoundIn = s.email; break; }
              }
            }
          }

          items.push({
            clientId: c.id, name: c.name, email: c.email || null, phone: c.phone || null,
            eventType: c.event_type || '', eventDate: c.event_date, kind: due.kind, label: due.label,
            gmailFound: !!gmailContext, gmailFoundIn, gmailContext
          });
        }

        // Secondary sweep: past clients who exist in Gmail but were never logged in this app.
        // Runs once per connected inbox, merged and deduped. Manual-confirm only, never
        // auto-drafted or auto-added -- an email match alone isn't proof of who someone is or
        // what event they had.
        let possibleMissing = [];
        const seen = new Set();
        for (const s of sessions) {
          if (possibleMissing.length >= 6) break;
          try {
            const sentMsgs = await gmailSearch(s.accessToken, 'in:sent (invoice OR contract OR "your event" OR "thank you for booking" OR "performance fee") older_than:90d', 8);
            for (const m of sentMsgs.slice(0, 6)) {
              const meta = await gmailGetMessageMeta(s.accessToken, m.id);
              if (!meta) continue;
              const email = extractEmailAddress(meta.to);
              if (!email || knownEmails.has(email) || seen.has(email) || ownEmails.has(email)) continue;
              if (/texasmentalist\.com/i.test(email)) continue;
              seen.add(email);
              possibleMissing.push({ email, subject: meta.subject, date: meta.date, foundIn: s.email });
              if (possibleMissing.length >= 6) break;
            }
          } catch(e) { console.error(`Gmail missing-client sweep failed for ${s.email}:`, e.message); }
        }

        res.status(200).json({ success: true, items, possibleMissing, accounts: sessions.map(s => s.email) });
      } catch(e) {
        console.error('Past clients scan failed:', e.message);
        res.status(200).json({ error: 'Could not run the scan — try again.' });
      }
      return;
    }

    // POST action=past-client-draft -> draft a warm, low-pressure relationship-keeping note for
    // one past client. Distinct voice from generate-reply, which is written for an active lead
    // mid-conversation -- this is explicitly NOT a sales pitch.
    if (req.method === 'POST' && req.body.action === 'past-client-draft') {
      const { clientName, eventType, eventDate, kind, label, channel, gmailContext } = req.body;
      const kindGuidance = kind === 'birthday'
        ? 'Their next birthday party season is coming up. Write a warm, no-pressure note letting them know you\'re thinking of them and would love to help make this year\'s celebration special again if they\'re planning something. Reference their past event naturally (e.g. "last year\'s birthday bash"). This is NOT a hard sell, keep it light.'
        : 'Write a casual, genuine check-in. No ask, no pitch. You are just checking in because you enjoyed working their event and want to stay in touch. Keep it short and warm. You can mention you\'re around if they ever want entertainment again, but this must not read as a sales message.';

      const systemPrompt = `You are writing a relationship-keeping note on behalf of Shine, The Mentalist, to a PAST client whose event already happened (${eventType || 'an event'} on ${eventDate || 'an earlier date'}). This is not a lead, not a follow-up on an open conversation, just staying in touch.

${kindGuidance}

RULES:
- Warm, brief, genuine, first person. Under 90 words.
- No stock openers ("I hope this finds you well"), no corporate filler.
- Sign off as: Shine, The Mentalist | +1 (737) 271-5308
- Return ONLY the message body, no subject line, no commentary.
- Absolutely no em dashes.`;

      const userPrompt = [
        'Client: ' + (clientName || ''),
        'Reason this note is going out now: ' + (label || ''),
        (gmailContext && gmailContext.subject) ? 'Last real email subject on file with them: ' + gmailContext.subject : ''
      ].filter(Boolean).join('\n');

      try {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6', max_tokens: 300,
            system: systemPrompt + (await guidanceSuffix()) + (channel === 'email' ? '\n\nFORMAT OVERRIDE: this is an EMAIL, one short paragraph is fine, ignore any SMS length instinct.' : '\n\nFORMAT: this is an SMS. Keep it feeling like a real text, not capped at a fixed character count -- write as long as it naturally needs to be for a warm check-in.'),
            messages: [{ role: 'user', content: userPrompt }]
          })
        });
        const claudeData = await claudeRes.json();
        if (claudeData.error) throw new Error(claudeData.error.message || JSON.stringify(claudeData.error));
        let draft = '';
        if (Array.isArray(claudeData.content)) claudeData.content.forEach(b => { if (b.type === 'text') draft += b.text; });
        if (!draft) throw new Error('No draft generated');
        res.status(200).json({ success: true, draft });
      } catch(e) {
        res.status(500).json({ error: e.message });
      }
      return;
    }

    // POST action=thank-you-draft -> draft a post-gig thank-you note asking for a Google
    // review, optionally mentioning that the remaining-balance invoice is attached/included.
    // Triggered manually from the Gig Dashboard once a gig is marked Done.
    if (req.method === 'POST' && req.body.action === 'thank-you-draft') {
      const { clientName, eventType, eventDate, channel, reviewLink, includeBalance, balanceAmount, instruction } = req.body;
      if (!reviewLink) { res.status(400).json({ error: 'Missing reviewLink' }); return; }

      const balanceLine = includeBalance
        ? `Also let them know the invoice for the remaining balance ($${Number(balanceAmount || 0).toLocaleString()}) is ${channel === 'email' ? 'attached to this email' : 'included below'}, and to reach out with any questions.`
        : '';

      const instrBlock = (instruction && String(instruction).trim())
        ? `\n\nSHINE'S INSTRUCTION FOR THIS SPECIFIC DRAFT (highest priority -- follow this for this one draft):\n${String(instruction).trim()}`
        : '';

      const systemPrompt = `You are writing a thank-you note on behalf of Shine, The Mentalist, to a client whose event (${eventType || 'event'}${eventDate ? ' on ' + eventDate : ''}) JUST HAPPENED and went well.

Thank them warmly and specifically for having Shine perform -- reference the event naturally, don't just say "your event." Then ask them, warmly and not pushy, if they'd be willing to leave a quick Google review. Include this exact link on its own line, unchanged: ${reviewLink}
${balanceLine}
${instrBlock}

RULES:
- Warm, genuine, first person, brief. This is a thank-you, not a pitch.
- Do NOT start with a greeting line like "Hi ${clientName || 'there'}," or "Hello" -- begin directly with the thank-you itself. A greeting is added automatically outside your text (for email, the send template always prepends "Hi {name},"; writing your own would duplicate it).
- No stock openers ("I hope this finds you well"), no corporate filler.
- Sign off as: Shine, The Mentalist | +1 (737) 271-5308
- Return ONLY the message body, no subject line, no commentary.
- Absolutely no em dashes.`;

      const userPrompt = `Client: ${clientName || 'there'}`;

      try {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6', max_tokens: 300,
            system: systemPrompt + (await guidanceSuffix()) + (channel === 'email'
              ? '\n\nFORMAT: this is an EMAIL. One or two short paragraphs is fine.'
              : '\n\nFORMAT: this is an SMS. Keep it feeling like a real text -- short, but the review link must still be included on its own line.'),
            messages: [{ role: 'user', content: userPrompt }]
          })
        });
        const claudeData = await claudeRes.json();
        if (claudeData.error) throw new Error(claudeData.error.message || JSON.stringify(claudeData.error));
        let draft = '';
        if (Array.isArray(claudeData.content)) claudeData.content.forEach(b => { if (b.type === 'text') draft += b.text; });
        if (!draft) throw new Error('No draft generated');
        res.status(200).json({ success: true, draft });
      } catch(e) {
        res.status(500).json({ error: e.message });
      }
      return;
    }

    res.status(400).json({ error: 'Unknown action' });

  } catch(e) {
    console.error('pending-replies error:', e);
    res.status(500).json({ error: e.message });
  }
}
