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
  // Try to find plain text part
  // Look for Content-Type: text/plain section
  const plainMatch = raw.match(/Content-Type: text\/plain[^\n]*\n(?:.*\n)*?\n([\s\S]*?)(?:\n--|\n\n--|\z)/i);
  if (plainMatch && plainMatch[1].trim()) {
    return decodeEmailBody(plainMatch[1].trim());
  }
  // Fallback: strip all headers and MIME boundaries, return remaining text
  const lines = raw.split('\n');
  let inBody = false;
  let bodyLines = [];
  let headersDone = false;
  for (const line of lines) {
    if (!headersDone && line.trim() === '') { headersDone = true; inBody = true; continue; }
    if (!inBody) continue;
    if (line.startsWith('--')) continue; // MIME boundary
    if (line.match(/^Content-Type:|^Content-Transfer-Encoding:|^Content-Disposition:/i)) continue;
    bodyLines.push(line);
  }
  return decodeEmailBody(bodyLines.join('\n').trim());
}

function decodeEmailBody(text) {
  // Decode quoted-printable encoding
  return text
    .replace(/=\r?\n/g, '')           // soft line breaks
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/<[^>]*>/g, '')          // strip any HTML tags
    .trim();
}

function extractSenderName(fromHeader) {
  // "Francisco Lopez <francisco@gmail.com>" -> "Francisco Lopez"
  const match = fromHeader.match(/^([^<]+)</);
  if (match) return match[1].trim();
  // Fallback: derive from email address
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

    // Parse body from rawEmail, fallback to direct fields
    let body = payload.text || payload.body || '';
    if (!body && rawEmail) {
      body = extractTextFromRawEmail(rawEmail);
    }

    if (!fromEmail) return res.status(200).json({ received: true, reason: 'no from' });

    // Don't reply to our own emails or system emails
    const skip = ['texasmentalist.com','2020shine@gmail.com','resend.com',
                  'shinethementalist@gmail.com','noreply','no-reply','mailer-daemon',
                  'postmaster','bounce'];
    if (skip.some(s => fromEmail.toLowerCase().includes(s))) {
      return res.status(200).json({ received: true, skipped: true });
    }

    // Use body or subject as context (body might be empty if encoding fails)
    const context = body || subject || '(no message body)';

    // ── 1. Generate AI reply ────────────────────────────────────────────────
    let replyText = '';
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
          max_tokens: 1024,
          system: `You are a booking assistant for Shine, The Mentalist — a professional mentalism and magic performer in Texas. Write warm, concise email replies to potential clients. Always sign off as "Shine, The Mentalist" with phone +1 (612) 865-7681 and website www.texasmentalist.com. Never confirm bookings or quote prices without saying "I'll check my availability and send you details." Keep replies under 150 words.`,
          messages: [{
            role: 'user',
            content: `Reply to this email inquiry:\nFrom: ${fromFull}\nSubject: ${subject}\n\n${context.slice(0, 2000)}`
          }],
        }),
      });
      const claudeData = await claudeRes.json();
      if (claudeData.content && Array.isArray(claudeData.content)) {
        for (const block of claudeData.content) {
          if (block.type === 'text' && block.text) replyText += block.text;
        }
      }
    } catch(e) {
      console.error('Claude error:', e);
    }

    if (!replyText) {
      replyText = `Hi,\n\nThank you for reaching out about booking Shine, The Mentalist! I received your message and will get back to you shortly with more details.\n\n– Shine, The Mentalist\n+1 (612) 865-7681\nwww.texasmentalist.com`;
    }

    // ── 2. Create or update lead in Supabase ────────────────────────────────
    try {
      const existingRes = await fetch(
        `${SB_URL}/rest/v1/clients?email=eq.${encodeURIComponent(fromEmail)}&limit=1`,
        { headers: SB_HDR }
      );
      const existing = await existingRes.json();

      if (!existing || existing.length === 0) {
        const clientName = extractSenderName(fromFull);
        const text = (subject + ' ' + context).toLowerCase();
        let eventType = 'Private event';
        if (text.includes('birthday'))                              eventType = 'Birthday party';
        else if (text.includes('bachelorette')||text.includes('bridal')) eventType = 'Bachelorette party';
        else if (text.includes('wedding'))                          eventType = 'Wedding';
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
            status:        'new',
            notes:         `Email inquiry:\nSubject: ${subject}\n\n${context.slice(0, 500)}`,
            last_activity: new Date().toISOString(),
          }),
        });
        console.log('New lead created:', fromEmail);
      } else {
        await fetch(`${SB_URL}/rest/v1/clients?id=eq.${existing[0].id}`, {
          method: 'PATCH',
          headers: SB_HDR,
          body: JSON.stringify({ last_activity: new Date().toISOString() }),
        });
        console.log('Existing client updated:', fromEmail);
      }
    } catch(e) {
      console.error('Supabase error:', e);
    }

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
      subject: `📬 New email lead: ${fromEmail}`,
      text:    `From: ${fromFull}\nSubject: ${subject}\n\n--- Message ---\n${context.slice(0, 1000)}\n\n--- Auto-reply sent ---\n${replyText}\n\nView leads: https://shine-booking.vercel.app`,
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
