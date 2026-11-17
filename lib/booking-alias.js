// A booking that was merged into another keeps working: its old id is stored in
// booking_aliases (old_id -> new_id) and client-facing endpoints resolve it before
// looking the booking up. Fails safe: if the table is missing or the call errors,
// the id comes back unchanged and behaviour is exactly as before.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveBookingId(id) {
  try {
    if (!id || !UUID.test(String(id))) return id;
    const key = process.env.SUPABASE_SECRET_KEY;
    const r = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/booking_aliases?old_id=eq.${id}&select=new_id&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!r.ok) return id;
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] && rows[0].new_id ? rows[0].new_id : id;
  } catch (e) {
    return id;
  }
}
