// api/email-reply.js
// Handles inbound emails forwarded from Cloudflare Email Worker
// Fixed: robust Claude response parsing that handles tool_use blocks

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = req.body;

    // Support both Cloudflare Worker format and Resend webhook format
    const fromEmail = payload.from || payload.sender || '';
    const subject   = payload.subject || '';
    const body      = payload.text || payload.body ||
                      (payload.html || '').replace(/<[^>]*>/g, '') || '';

    if (!fromEmail || !body) return res.status(200).json({ received: true });

    // Don't reply to our own emails or system emails
    const skip = ['texasmentalist.com','2020shine@gmail.com','resend.com',
                  'shinethementalist@gmail.com','noreply','no-reply'];
    if (skip.some(s => fromEmail.toLowerCase().includes(s))) {
      return res.status(200).json({ received: true, skipped: true });
    }

    // Generate AI reply
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
        messages: [
          {
            role: 'user',
            content: `Reply to this email from ${fromEmail}:\n\nSubject: ${subject}\n\n${body.slice(0, 2000)}`
          }
        ],
      }),
    });

    const claudeData = await claudeRes.json();

    // ── Robust content extraction ──────────────────────────────────────────────
    // Handle text blocks, tool_use blocks, or unexpected shapes
    let replyText = '';
    if (claudeData.content && Array.isArray(claudeData.content)) {
      for (const block of claudeData.content) {
        if (block.type === 'text' && block.text) {
          replyText += block.text;
        }
      }
    }

    if (!replyText) {
      // Fallback: send a generic holding reply so the client isn't left hanging
      replyText = `Hi,\n\nThank you for reaching out about booking Shine, The Mentalist! I received your message and will get back to you shortly with more details.\n\n– Shine, The Mentalist\n+1 (612) 865-7681\nwww.texasmentalist.com`;
      console.warn('Claude returned no text content — sending fallback reply. Raw response:', JSON.stringify(claudeData).slice(0, 500));
    }

    // Send the reply
    await resend.emails.send({
      from:    'Shine, The Mentalist <shine@texasmentalist.com>',
      to:      [fromEmail],
      subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
      text:    replyText,
    });

    // Notify Shine about the inbound email
    await resend.emails.send({
      from:    'Shine Booking Assistant <shine@texasmentalist.com>',
      to:      ['shinethementalist@gmail.com'],
      subject: `📬 Inbound email from ${fromEmail} — auto-reply sent`,
      text:    `From: ${fromEmail}\nSubject: ${subject}\n\n--- Their message ---\n${body.slice(0, 1000)}\n\n--- Auto-reply sent ---\n${replyText}`,
    });

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('email-reply error:', err);

    // Send error notification to Shine
    try {
      const r2 = new Resend(process.env.RESEND_KEY);
      await r2.emails.send({
        from:    'Shine The Mentalist <shine@texasmentalist.com>',
        to:      ['shinethementalist@gmail.com'],
        subject: '⚠️ An inbound email failed to process',
        text:    `An email came in but I couldn't generate a reply or draft for it, so nothing showed up on your dashboard for this one.\n\nError: ${err.message}\n\nYou may want to check your Gmail (shinethementalist@gmail.com) for the original message and reply manually if needed.`,
      });
    } catch(_) {}

    return res.status(200).json({ received: true, error: err.message });
  }
};
