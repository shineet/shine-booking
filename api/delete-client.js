export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const { clientId } = req.body;
    if (!clientId) {
      res.status(400).json({ error: 'clientId required' });
      return;
    }

    // Delete messages first (foreign key)
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?client_id=eq.${clientId}`, {
      method: 'DELETE',
      headers: {
        'apikey': process.env.SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
      }
    });

    // Delete client
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${clientId}`, {
      method: 'DELETE',
      headers: {
        'apikey': process.env.SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
      }
    });

    res.status(200).json({ deleted: true });

  } catch(e) {
    console.error('Delete error:', e);
    res.status(500).json({ error: e.message });
  }
}
