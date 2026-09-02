// Server → client push via Supabase Realtime Broadcast (replaces Socket.IO
// `io.to(room).emit(event, payload)`). Uses the Realtime HTTP API with the
// service key; channels are PRIVATE (clients need a valid user token and a
// realtime.messages RLS policy — see supabase/migrations).
//
//   await broadcast(`chat:group:${groupId}`, 'message', msg)
//   await broadcast(`user:${userId}`, 'chat:changed', { groupId })
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// deno-lint-ignore no-explicit-any
export async function broadcast(topic: string, event: string, payload: any): Promise<void> {
  try {
    const r = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ messages: [{ topic, event, payload, private: true }] }),
    });
    if (!r.ok) console.warn("[realtime] broadcast failed", r.status, await r.text());
  } catch (e) { console.warn("[realtime] broadcast error", (e as Error).message); }
}

// deno-lint-ignore no-explicit-any
export async function broadcastMany(items: Array<{ topic: string; event: string; payload: any }>): Promise<void> {
  if (!items.length) return;
  try {
    const r = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ messages: items.map((i) => ({ ...i, private: true })) }),
    });
    if (!r.ok) console.warn("[realtime] broadcastMany failed", r.status, await r.text());
  } catch (e) { console.warn("[realtime] broadcastMany error", (e as Error).message); }
}
