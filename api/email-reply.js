// api/email-reply.js
// Handles inbound emails, generates AI reply, creates lead in Supabase

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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = req.body;

    const fromEmail = payload.from || payload.sender || '';
    const subject   = payload.subject || '';
    const body      = payload.text || payload.body ||
                      (payload.html || '').replace(/<[^>]*>/g, '') || '';

    if (!fromEmail || !body) return res.status(200).json({ received: true });

    // Don't reply to our own emails or system emails
    const skip = ['texasmentalist.com','2020shine@gmail.com','resend.com',
                  'shinethementalist@gmail.com','noreply','no-reply','mailer-daemon'];
    if (skip.some(s => fromEmail.toLowerCase().includes(s))) {
      return res.status(200).json({ received: true, skipped: true });
    }

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
          system: `You are a booking assistant for Shine, The Mentalist — a professional mentalism and magic performer in Texas. Write warm, concise email replies to potential clients. Always sign off as "Shine, The Mentalist" with phone +1 (612) 865-7681 and website www.texasmentalist.com. Never confirm bookings or quote prices without saying "I'll check availability and get back to you." Keep replies under 150 words.`,
          messages: [{
            role: 'user',
            content: `Reply to this email from ${fromEmail}:\n\nSubject: ${subject}\n\n${body.slice(0, 2000)}`
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
      replyText = `Hi,\n\nThank you for reaching out about booking Shine, The Mentalist! I received your message and will get back to you shortly.\n\n– Shine, The Mentalist\n+1 (612) 865-7681\nwww.texasmentalist.com`;
    }

    // ── 2. Create or find lead in Supabase ──────────────────────────────────
    try {
      // Check if client already exists
      const existingRes = await fetch(
        `${SB_URL}/rest/v1/clients?email=eq.${encodeURIComponent(fromEmail)}&limit=1`,
        { headers: SB_HDR }
      );
      const existing = await existingRes.json();

      if (!existing || existing.length === 0) {
        // Extract name from email (e.g. "Francisco Lopez" from "francisco.lopez@gmail.com")
        const namePart = fromEmail.split('@')[0].replace(/[._]/g, ' ');
        const clientName = namePart.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

        // Detect event type from subject/body
        const text = (subject + ' ' + body).toLowerCase();
        let eventType = 'Corporate event';
        if (text.includes('birthday')) eventType = 'Birthday party';
        else if (text.includes('bachelorette') || text.includes('bridal')) eventType = 'Bachelorette party';
        else if (text.includes('wedding')) eventType = 'Wedding';
        else if (text.includes('corporate') || text.includes('company') || text.includes('team')) eventType = 'Corporate event';
        else if (text.includes('party') || text.includes('celebration')) eventType = 'Private party';

        // Create the client lead
        await fetch(`${SB_URL}/rest/v1/clients`, {
          method: 'POST',
          headers: SB_HDR,
          body: JSON.stringify({
            name:          clientName,
            email:         fromEmail,
            event_type:    eventType,
            lead_source:   'Email',
            status:        'new',
            notes:         `Email inquiry:\nSubject: ${subject}\n\n${body.slice(0, 500)}`,
            last_activity: new Date().toISOString(),
          }),
        });
        console.log('New lead created from email:', fromEmail);
      } else {
        // Update last activity on existing client
        await fetch(`${SB_URL}/rest/v1/clients?id=eq.${existing[0].id}`, {
          method: 'PATCH',
          headers: SB_HDR,
          body: JSON.stringify({ last_activity: new Date().toISOString() }),
        });
      }
    } catch(e) {
      console.error('Supabase lead creation error:', e);
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
      text:    `New inquiry from: ${fromEmail}\nSubject: ${subject}\n\n--- Their message ---\n${body.slice(0, 1000)}\n\n--- Auto-reply sent ---\n${replyText}\n\nView in booking app: https://shine-booking.vercel.app`,
    });

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('email-reply error:', err);
    try {
      await resend.emails.send({
        from:    'Shine The Mentalist <shine@texasmentalist.com>',
        to:      ['shinethementalist@gmail.com'],
        subject: '⚠️ An inbound email failed to process',
        text:    `Error: ${err.message}\n\nCheck Gmail for the original message.`,
      });
    } catch(_) {}
    return res.status(200).json({ received: true, error: err.message });
  }
};
