// One shared realtime connection for the app shell (chat unread badge / toasts
// + WebRTC call signalling). Supabase-native version: Socket.IO is gone; the
// shell subscribes to its private Realtime topic `user:<id>` and the Edge
// Function broadcasts into it. The public API (subscribe / emit / isConnected)
// is unchanged so Layout and CallProvider keep working as before.
//
// Event mapping (server → client), see supabase/functions/api/routes/CHAT-REALTIME.md:
//   'chat:changed' {groupId}                → handlers for 'changed' (+ 'group_deleted' legacy name)
//   'call:signal'  {fromUserId,fromName,type,data} → handlers for <type> with {...data, from, fromName}
// emit(event, payload) for 'call:*' events → POST /site-chat/calls/signal.
import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import api from '../api';
import { useAuth } from './AuthContext';
import { subscribeTopic, syncRealtimeAuth } from '../lib/realtime';

const SocketContext = createContext(null);

// Safe no-op fallback if a consumer mounts outside the provider — degrades to
// "no realtime" instead of crashing.
const NOOP = { subscribe: () => () => {}, emit: () => {}, isConnected: () => false };
export const useAppSocket = () => useContext(SocketContext) || NOOP;

export function SocketProvider({ children }) {
  const { user } = useAuth();
  const handlersRef = useRef(new Map());   // event -> Set(handler); outlives the channel
  const connectedRef = useRef(false);

  const dispatch = (event, payload) => {
    const set = handlersRef.current.get(event);
    if (!set) return;
    for (const h of set) { try { h(payload); } catch (e) { console.warn('[realtime] handler failed', event, e); } }
  };

  useEffect(() => {
    if (!user?.id) return;
    let off = () => {};
    let idleId = null, timeoutId = null, cancelled = false;
    const start = () => {
      if (cancelled) return;
      syncRealtimeAuth();
      off = subscribeTopic(`user:${user.id}`, {
        'chat:changed': (p) => { dispatch('changed', p); dispatch('group_deleted', p); },
        'call:signal': (p) => {
          if (!p || !p.type) return;
          dispatch(p.type, { ...(p.data || {}), from: p.fromUserId, fromName: p.fromName });
        },
        'notification:new': (p) => {
          dispatch('notification:new', p);
        },
      });
      connectedRef.current = true;
    };
    // Defer off the first-paint critical path; still sub-second and automatic.
    if (window.requestIdleCallback) idleId = window.requestIdleCallback(start, { timeout: 2000 });
    else timeoutId = setTimeout(start, 0);
    return () => {
      cancelled = true;
      if (idleId != null && window.cancelIdleCallback) { try { window.cancelIdleCallback(idleId); } catch { /* ignore */ } }
      if (timeoutId != null) clearTimeout(timeoutId);
      connectedRef.current = false;
      off();
    };
  }, [user?.id]);

  const value = useMemo(() => ({
    subscribe: (event, handler) => {
      let set = handlersRef.current.get(event);
      if (!set) { set = new Set(); handlersRef.current.set(event, set); }
      set.add(handler);
      return () => { set.delete(handler); };
    },
    emit: (event, payload) => {
      if (!String(event).startsWith('call:')) return;   // only call signalling is client→server
      const to = payload?.to;
      if (!to) return;
      api.post('/site-chat/calls/signal', { toUserId: to, type: event, data: payload }).catch(() => {});
    },
    isConnected: () => connectedRef.current,
  }), []);

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}
