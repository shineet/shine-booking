// api/email-reply.js
// Handles inbound emails from Cloudflare Worker
// Worker sends: { from, to, subject, rawEmail }

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_KEY);

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SECRET_KEY;
const SB_HDR = {
  'apikey': SB_KEY,
  'Authorization': `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation'
};

function extractTextFromRawEmail(raw) {
  if (!raw) return '';
  const plainMatch = raw.match(/Content-Type: text\/plain[^\n]*\n(?:.*\n)*?\n([\s\S]*?)(?:\n--|\n\n--)/i);
  if (plainMatch && plainMatch[1].trim()) return decodeEmailBody(plainMatch[1].trim());
  const lines = raw.split('\n');
  let inBody = false, bodyLines = [], headersDone = false;
  for (const line of lines) {
    if (!headersDone && line.trim() === '') { headersDone = true; inBody = true; continue; }
    if (!inBody) continue;
    if (line.startsWith('--')) continue;
    if (line.match(/^Content-Type:|^Content-Transfer-Encoding:|^Content-Disposition:/i)) continue;
    bodyLines.push(line);
  }
  return decodeEmailBody(bodyLines.join('\n').trim());
}

function decodeEmailBody(text) {
  return text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/<[^>]*>/g, '')
    .trim();
}

function extractSenderName(fromHeader) {
  const match = fromHeader.match(/^([^<]+)</);
  if (match) return match[1].trim();
  const email = fromHeader.replace(/[<>]/g, '').trim();
  const namePart = email.split('@')[0].replace(/[._-]/g, ' ');
  return namePart.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = req.body;

    const fromEmail = (payload.from || '').replace(/.*<(.+)>/, '$1').trim() || payload.from || '';
    const fromFull  = payload.from || fromEmail;
    const subject   = payload.subject || '';
    const rawEmail  = payload.rawEmail || '';

    let body = payload.text || payload.body || '';
    if (!body && rawEmail) body = extractTextFromRawEmail(rawEmail);

    if (!fromEmail) return res.status(200).json({ received: true, reason: 'no from' });

    const skip = ['texasmentalist.com','2020shine@gmail.com','resend.com',
                  'shinethementalist@gmail.com','noreply','no-reply','mailer-daemon','postmaster','bounce'];
    if (skip.some(s => fromEmail.toLowerCase().includes(s))) {
      return res.status(200).json({ received: true, skipped: true });
    }

    const context = body || subject || '(no message body)';

    // ── 1. Claude: extract name + status + generate reply ───────────────────
    let replyText = '';
    let extractedName = '';
    let extractedStatus = 'new';

    try {
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          system: `You are a booking assistant for Shine, The Mentalist — a professional mentalism and magic performer in Texas.

Respond in this EXACT format:
NAME: [sender's real name from the email, or UNKNOWN]
STATUS: [new, contacted, price_requested, or negotiating]
REPLY:
[warm reply under 150 words signed as Shine, The Mentalist with +1 (612) 865-7681 and www.texasmentalist.com]

STATUS rules:
- price_requested: they ask about cost, pricing, rates, how much, fees
- negotiating: going back and forth on details after receiving pricing
- contacted: general follow-up, no pricing question
- new: first inquiry

Never quote specific prices. If asked, say you will send pricing details shortly.`,
          messages: [{
            role: 'user',
            content: `Process this email:\nFrom: ${fromFull}\nSubject: ${subject}\n\n${context.slice(0, 2000)}`
          }],
        }),
      });
      const claudeData = await claudeRes.json();
      let raw = '';
      if (claudeData.content && Array.isArray(claudeData.content)) {
        for (const block of claudeData.content) {
          if (block.type === 'text' && block.text) raw += block.text;
        }
      }
      if (raw) {
        const nameMatch = raw.match(/^NAME:\s*(.+)$/m);
        if (nameMatch && nameMatch[1].trim() !== 'UNKNOWN') extractedName = nameMatch[1].trim();
        const statusMatch = raw.match(/^STATUS:\s*(.+)$/m);
        if (statusMatch) {
          const s = statusMatch[1].trim().toLowerCase();
          if (['new','contacted','price_requested','negotiating'].includes(s)) extractedStatus = s;
        }
        const replyMatch = raw.match(/^REPLY:\s*\n([\s\S]+)$/m);
        if (replyMatch) replyText = replyMatch[1].trim();
      }
    } catch(e) { console.error('Claude error:', e); }

    if (!replyText) {
      replyText = `Hi,\n\nThank you for reaching out about booking Shine, The Mentalist! I received your message and will get back to you shortly.\n\n– Shine, The Mentalist\n+1 (612) 865-7681\nwww.texasmentalist.com`;
    }

    // ── 2. Create or update lead in Supabase ────────────────────────────────
    try {
      const existingRes = await fetch(
        `${SB_URL}/rest/v1/clients?email=eq.${encodeURIComponent(fromEmail)}&limit=1`,
        { headers: SB_HDR }
      );
      const existing = await existingRes.json();

      if (!existing || existing.length === 0) {
        const clientName = extractedName || extractSenderName(fromFull);
        const text = (subject + ' ' + context).toLowerCase();
        let eventType = 'Private event';
        if (text.includes('birthday'))                                    eventType = 'Birthday party';
        else if (text.includes('bachelorette')||text.includes('bridal')) eventType = 'Bachelorette party';
        else if (text.includes('wedding'))                                eventType = 'Wedding';
        else if (text.includes('corporate')||text.includes('company')||text.includes('team')) eventType = 'Corporate event';
        else if (text.includes('party')||text.includes('celebration'))   eventType = 'Private party';

        await fetch(`${SB_URL}/rest/v1/clients`, {
          method: 'POST',
          headers: SB_HDR,
          body: JSON.stringify({
            name:          clientName,
            email:         fromEmail,
            event_type:    eventType,
            lead_source:   'Email',
            status:        extractedStatus,
            notes:         `Email inquiry:\nSubject: ${subject}\n\n${context.slice(0, 500)}`,
            last_activity: new Date().toISOString(),
          }),
        });
        console.log('New lead created:', fromEmail, 'name:', clientName, 'status:', extractedStatus);
      } else {
        const updateData = { last_activity: new Date().toISOString() };
        if (extractedStatus && extractedStatus !== 'new') updateData.status = extractedStatus;
        if (extractedName) updateData.name = extractedName;
        await fetch(`${SB_URL}/rest/v1/clients?id=eq.${existing[0].id}`, {
          method: 'PATCH',
          headers: SB_HDR,
          body: JSON.stringify(updateData),
        });
        console.log('Existing client updated:', fromEmail, 'status:', extractedStatus);
      }
    } catch(e) { console.error('Supabase error:', e); }

    // ── 3. Send auto-reply to client ─────────────────────────────────────────
    await resend.emails.send({
      from:    'Shine, The Mentalist <shine@texasmentalist.com>',
      to:      [fromEmail],
      subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
      text:    replyText,
    });

    // ── 4. Notify Shine ───────────────────────────────────────────────────────
    await resend.emails.send({
      from:    'Shine Booking Assistant <shine@texasmentalist.com>',
      to:      ['shinethementalist@gmail.com'],
      subject: `📬 New email lead: ${extractedName || fromEmail} [${extractedStatus}]`,
      text:    `From: ${fromFull}\nSubject: ${subject}\nStatus: ${extractedStatus}\n\n--- Message ---\n${context.slice(0, 1000)}\n\n--- Auto-reply sent ---\n${replyText}\n\nView leads: https://shine-booking.vercel.app`,
    });

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('email-reply error:', err);
    try {
      await resend.emails.send({
        from: 'Shine The Mentalist <shine@texasmentalist.com>',
        to:   ['shinethementalist@gmail.com'],
        subject: '⚠️ Inbound email failed to process',
        text: `Error: ${err.message}\n\nCheck Gmail for the original message.`,
      });
    } catch(_) {}
    return res.status(200).json({ received: true, error: err.message });
  }
};
