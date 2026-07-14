// One shared Socket.IO connection for the app shell (perf pass — shell-socket).
// Before this, every logged-in user opened TWO always-on sockets on every page:
// one in Layout (chat unread badge / toasts) and a separate one in CallProvider
// (WebRTC call signalling). Both now ride this single connection, halving the
// shell's WebSocket connections and the server-side connection/room load.
//
// The connect is DEFERRED to a post-paint idle callback so the handshake +
// per-feature setup never compete with the initial route render — but it still
// connects automatically for every logged-in user (no user gesture), so
// incoming calls and chat notifications keep arriving on ANY page. The chat
// PAGE's own socket (SiteChat.jsx) is intentionally left separate.
import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from './AuthContext';
import { getToken } from '../lib/tokenStore';

const SocketContext = createContext(null);

// Safe no-op fallback if a consumer mounts outside the provider — degrades to
// "no realtime" instead of crashing.
const NOOP = { subscribe: () => () => {}, emit: () => {}, isConnected: () => false };
export const useAppSocket = () => useContext(SocketContext) || NOOP;

export function SocketProvider({ children }) {
  const { user } = useAuth();
  const socketRef = useRef(null);
  // event -> Set(handler). The registry OUTLIVES the socket so a consumer can
  // subscribe before the deferred connect fires, and stays attached across a
  // socket (re)creation — order-independent, reconnect-safe.
  const handlersRef = useRef(new Map());

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false, idleId = null, timeoutId = null;

    const start = () => {
      if (cancelled) return;
      // Function-form auth so storage-blocked / in-app browsers still send the
      // current token (mam 2026-07-04) — same as the two sockets this replaces.
      const socket = io({ path: '/socket.io', auth: (cb) => cb({ token: getToken() }), transports: ['websocket', 'polling'] });
      socketRef.current = socket;
      for (const [event, set] of handlersRef.current) for (const h of set) socket.on(event, h);
    };

    // Defer off the first-paint critical path; still sub-second and automatic.
    if (window.requestIdleCallback) idleId = window.requestIdleCallback(start, { timeout: 2000 });
    else timeoutId = setTimeout(start, 0);

    return () => {
      cancelled = true;
      if (idleId != null && window.cancelIdleCallback) { try { window.cancelIdleCallback(idleId); } catch { /* ignore */ } }
      if (timeoutId != null) clearTimeout(timeoutId);
      const socket = socketRef.current;
      if (socket) {
        for (const [event, set] of handlersRef.current) for (const h of set) socket.off(event, h);
        try { socket.disconnect(); } catch { /* ignore */ }
      }
      socketRef.current = null;
    };
  }, [user?.id]);

  const value = useMemo(() => ({
    // Register a handler; attaches now if the socket already exists, otherwise
    // when the deferred connect fires. Returns an unsubscribe.
    subscribe: (event, handler) => {
      let set = handlersRef.current.get(event);
      if (!set) { set = new Set(); handlersRef.current.set(event, set); }
      set.add(handler);
      socketRef.current?.on(event, handler);
      return () => { set.delete(handler); socketRef.current?.off(event, handler); };
    },
    emit: (...args) => socketRef.current?.emit(...args),
    isConnected: () => !!socketRef.current?.connected,
  }), []);

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}
