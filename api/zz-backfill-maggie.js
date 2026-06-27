// ONE-OFF backfill endpoint — inserts Maggie's lost inbound SMS reply into the dashboard.
// Token-gated, idempotent, no SMS is sent. Delete this file right after it runs once.
const TOKEN = '16774083175a705e990689c71b2cec0b';

const FROM = '+16109086678';
const MESSAGE = "Hi Shine! Sorry I am just seeing this message – I love your website and your performances! I am traveling this weekend so I won't be able to chat on the phone, however I can message. What is your quote for a private group of around 20 people? Thank you!";
const RECEIVED_AT = '2026-06-27T14:00:00Z'; // ~9:00 AM Austin (CDT)

function last10(phone) {
  if (!phone) return '';
  const d = String(phone).replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}

export default async function handler(req, res) {
  if ((req.query.token || '') !== TOKEN) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  const supaHeaders = { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` };
  const base = `${process.env.SUPABASE_URL}/rest/v1`;
  const target = last10(FROM);

  try {
    // 1. Find Maggie's client row (exact, then last-10-digit fallback)
    let client = null;
    const exactRes = await fetch(`${base}/clients?phone=eq.${encodeURIComponent(FROM)}&order=created_at.desc&limit=1`, { headers: supaHeaders });
    const exact = await exactRes.json();
    client = Array.isArray(exact) ? (exact[0] || null) : null;

    if (!client) {
      const allRes = await fetch(`${base}/clients?select=*&order=created_at.desc`, { headers: supaHeaders });
      const all = await allRes.json();
      if (Array.isArray(all)) client = all.find(c => last10(c.phone) === target) || null;
    }

    if (!client) {
      res.status(404).json({ error: 'no client matched', target });
      return;
    }

    // Self-heal phone to E.164 so future inbounds hit the fast path
    if (client.phone !== FROM) {
      await fetch(`${base}/clients?id=eq.${client.id}`, {
        method: 'PATCH',
        headers: { ...supaHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: FROM })
      });
    }

    // 2. Idempotency — skip if this inbound is already saved
    const existingRes = await fetch(`${base}/messages?client_id=eq.${client.id}&direction=eq.inbound&select=id,content`, { headers: supaHeaders });
    const existing = await existingRes.json();
    const already = Array.isArray(existing) && existing.some(m => (m.content || '').trim() === MESSAGE.trim());
    if (already) {
      res.status(200).json({ status: 'already_present', client_id: client.id, client_name: client.name });
      return;
    }

    // 3. Insert the inbound message
    const insRes = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: { ...supaHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify([{
        client_id: client.id, channel: 'sms', direction: 'inbound',
        content: MESSAGE, status: 'received', to_address: null, created_at: RECEIVED_AT
      }])
    });
    const insBody = await insRes.json();
    if (!insRes.ok) {
      res.status(500).json({ error: 'insert failed', detail: insBody });
      return;
    }

    // 4. Bump the client so the thread surfaces as active
    await fetch(`${base}/clients?id=eq.${client.id}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'pricing_requested', last_channel: 'sms', last_activity: RECEIVED_AT })
    });

    res.status(200).json({
      status: 'inserted',
      client_id: client.id,
      client_name: client.name,
      message_id: Array.isArray(insBody) ? insBody[0]?.id : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
