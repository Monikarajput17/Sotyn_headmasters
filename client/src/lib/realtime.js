// Supabase Realtime client — replaces the Socket.IO shell socket.
//
// Topics/events (see supabase/functions/api/routes/CHAT-REALTIME.md):
//   user:<userId>        events: chat:changed {groupId}, call:signal {...}
//   chat:group:<groupId> events: message {row}, message_deleted {id}
// Channels are PRIVATE: the user's access token authorises them via the
// realtime.messages policy (supabase/migrations). Degrades to "no realtime"
// (pages still poll) when the env vars are missing.
import { createClient } from '@supabase/supabase-js';
import { getToken } from './tokenStore';

const URL = import.meta.env.VITE_SUPABASE_URL;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

let client = null;
export function getRealtime() {
  if (client) return client;
  if (!URL || !ANON) return null;
  client = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

// Keep Realtime authorised with the CURRENT access token (it slides).
export function syncRealtimeAuth() {
  const c = getRealtime();
  const t = getToken();
  if (c && t) { try { c.realtime.setAuth(t); } catch { /* ignore */ } }
}

// Subscribe to one private topic; returns an unsubscribe function.
// handlers: { [event]: (payload) => void }
export function subscribeTopic(topic, handlers) {
  const c = getRealtime();
  if (!c) return () => {};
  syncRealtimeAuth();
  const ch = c.channel(topic, { config: { private: true } });
  for (const [event, fn] of Object.entries(handlers || {})) {
    ch.on('broadcast', { event }, (msg) => { try { fn(msg.payload); } catch (e) { console.warn('[realtime] handler', e); } });
  }
  ch.subscribe((status) => { if (status === 'CHANNEL_ERROR') console.warn('[realtime] channel error', topic); });
  return () => { try { c.removeChannel(ch); } catch { /* ignore */ } };
}
