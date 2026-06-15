import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

const SYSTEM_PROMPT = `You are a booking assistant for Shine, The Mentalist — a professional mentalism and magic show performer in Texas.

Shine performs 45-60 minute interactive mentalism and magic shows.
Pricing: Private events (birthdays, bachelorette, celebrations) start at $400. Corporate events start at $800.
Payment: Cash, Zelle (2020shine@gmail.com), Venmo (@Shine-Thankappan), PayPal (shine_e_thankappan@yahoo.com)
Website: www.texasmentalist.com
Phone: +1 (612) 865-7681

You are handling SMS conversations with potential clients. Be warm, professional, and concise (under 160 characters per message).

Rules:
- Answer pricing questions honestly
- If asked about availability, say you'll check and confirm shortly
- Never make promises about specific dates without confirmation
- If the client says something like "yes let's book", "I want to book", "let's do it", "sounds good let's confirm" — respond with ONE final message saying you'll send over the contract details, then add the tag [BOOKING_INTENT] at the very end
- Keep responses short and conversational for SMS
- Sign off as "- Shine" (short version for SMS)`;

// Simple in-memory conversation store (resets on server restart)
const conversations = {};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  try {
    const { From, Body } = req.body;

    if (!From || !Body) {
      res.status(400).send('Missing From or Body');
      return;
    }

    // Get or create conversation history for this number
    if (!conversations[From]) {
      conversations[From] = [];
    }

    // Add client message to history
    conversations[From].push({
      role: 'user',
      content: Body
    });

    // Keep only last 10 messages to stay within token limits
    if (conversations[From].length > 10) {
      conversations[From] = conversations[From].slice(-10);
    }

    // Call Claude with full conversation history
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: conversations[From]
    });

    const replyText = response.content[0].text;
    const bookingIntent = replyText.includes('[BOOKING_INTENT]');
    const cleanReply = replyText.replace('[BOOKING_INTENT]', '').trim();

    // Add assistant reply to history
    conversations[From].push({
      role: 'assistant',
      content: cleanReply
    });

    // Send SMS reply via Twilio
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`;
    const twilioAuth = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64');
    const smsBody = new URLSearchParams({
      From: process.env.TWILIO_FROM,
      To: From,
      Body: cleanReply
    });

    await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${twilioAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: smsBody.toString()
    });

    // If booking intent detected — notify you by email
    if (bookingIntent) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.RESEND_KEY}`
        },
        body: JSON.stringify({
          from: 'Shine Booking Assistant <shine@texasmentalist.com>',
          to: '2020shine@gmail.com',
          subject: `🎯 Booking intent detected — ${From}`,
          text: `A client is ready to book!\n\nPhone: ${From}\n\nConversation:\n${conversations[From].map(m => `${m.role === 'user' ? 'Client' : 'Shine'}: ${m.content}`).join('\n\n')}\n\nLog into your booking app to confirm and send the contract.`
        })
      });
    }

    // Respond to Twilio with empty TwiML (we already sent the reply above)
    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');

  } catch(e) {
    console.error('Reply handler error:', e);
    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');
  }
}
