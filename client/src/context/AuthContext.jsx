import { createContext, useContext, useState, useEffect } from 'react';
import api from '../api';
import { getToken, setToken as persistToken, clearToken, setRefreshToken } from '../lib/tokenStore';

const AuthContext = createContext();

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [permissions, setPermissions] = useState({});
  const [userRoles, setUserRoles] = useState([]);
  const [token, setToken] = useState(getToken());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) { setLoading(false); return; }
    api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    let cancelled = false;
    // Only log out when the server actually rejects the token (401).
    // A 500/503 / network blip must NOT nuke a valid session — that was
    // turning a transient error into an instant logout (mam 2026-06-23).
    // Also ignore a 401 from a STALE /auth/me (one that used an older
    // token than the now-active one) — that stale-request race logged a
    // just-logged-in user straight back out (mam 2026-06-24, Nitin Jain).
    // Supabase migration: a serverless cold start / pooler hiccup can 503
    // the very first session check, and with user still null the router
    // would bounce to /login — so retry transient failures with backoff
    // (1s, 2s, 4s, 8s) before giving up.
    const attempt = (n) => api.get('/auth/me')
      .then(r => {
        if (cancelled) return;
        setUser({
          id: r.data.id, name: r.data.name, email: r.data.email, username: r.data.username,
          role: r.data.role, department: r.data.department, phone: r.data.phone,
          approval_role: r.data.approval_role || null,
          avatar_url: r.data.avatar_url || null,
          has_recovery_code: !!r.data.has_recovery_code,
        });
        setPermissions(r.data.permissions || {});
        setUserRoles(r.data.userRoles || []);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        const st = e?.response?.status;
        if (st === 401) {
          if ((e.config?.metadata?.tokenAtSend || null) === getToken()) logout();
          setLoading(false);
          return;
        }
        if (n < 4) { setTimeout(() => attempt(n + 1), 1000 * Math.pow(2, n)); return; }
        setLoading(false);
      });
    attempt(0);
    return () => { cancelled = true; };
  }, [token]);

  // Live-refresh permissions so a grant an admin just made takes effect WITHOUT
  // a re-login (mam 2026-06-15: "if I give permission, not working proper").
  // Backend enforces permissions live; the frontend used to only read them at
  // login. Re-pull /auth/me when the tab regains focus and every 2 min while
  // active, debounced. Background failures are ignored (never auto-logout here).
  useEffect(() => {
    if (!token) return;
    let last = Date.now();
    const refresh = () => {
      if (Date.now() - last < 5000) return;     // debounce double events
      last = Date.now();
      api.get('/auth/me').then(r => {
        // Only re-set (and thus re-render every consumer) when the data actually
        // changed — an unchanged 2-min / on-focus refresh otherwise cascades a
        // re-render through the whole app for nothing (perf pass). Returning the
        // SAME reference tells React to bail; a real change still applies.
        const p = r.data.permissions || {};
        setPermissions(prev => JSON.stringify(prev) === JSON.stringify(p) ? prev : p);
        const ur = r.data.userRoles || [];
        setUserRoles(prev => JSON.stringify(prev) === JSON.stringify(ur) ? prev : ur);
        setUser(u => (u && u.role === r.data.role && u.department === r.data.department) ? u : (u ? { ...u, role: r.data.role, department: r.data.department } : u));
      }).catch(() => {});
    };
    const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVis);
    const id = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 120000);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(id);
    };
  }, [token]);

  const login = async (identifier, password) => {
    // Accept username or email — backend matches either.
    const { data } = await api.post('/auth/login', { username: identifier, email: identifier, password });
    persistToken(data.token);   // localStorage + in-memory fallback
    if (data.refresh_token) setRefreshToken(data.refresh_token);   // Supabase Auth: lets the session slide
    api.defaults.headers.common['Authorization'] = `Bearer ${data.token}`;
    setToken(data.token);
    setUser(data.user);
    setPermissions(data.permissions || {});
    setUserRoles(data.userRoles || []);
    // Best-effort: re-subscribe this device for push notifications so
    // PM2 restarts or expired endpoints don't silently lose this device.
    // Only triggers if the user previously granted permission — never
    // pops a fresh permission prompt (that lives in the bell-icon button).
    setTimeout(() => {
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          import('../lib/push').then(m => m.enablePushNotifications());
        }
      } catch {}
    }, 500);
    return data;
  };

  const logout = () => {
    clearToken();
    delete api.defaults.headers.common['Authorization'];
    setToken(null);
    setUser(null);
    setPermissions({});
    setUserRoles([]);
  };

  // Permission helper functions
  const can = (module, action = 'view') => {
    if (user?.role === 'admin') return true;
    const perm = permissions[module];
    if (!perm) return false;
    const actionMap = { view: 'can_view', create: 'can_create', edit: 'can_edit', delete: 'can_delete', approve: 'can_approve' };
    return !!perm[actionMap[action]];
  };

  const canView = (module) => can(module, 'view');
  const canCreate = (module) => can(module, 'create');
  const canEdit = (module) => can(module, 'edit');
  const canDelete = (module) => can(module, 'delete');
  const canApprove = (module) => can(module, 'approve');
  // The "See All" toggle in the role matrix — bypasses scope filters
  // (e.g. show every help ticket / DPR / cashflow project, not just
  // the user's own). Admin always passes.
  const canSeeAll = (module) => {
    if (user?.role === 'admin') return true;
    return !!permissions[module]?.can_see_all;
  };
  const isAdmin = () => user?.role === 'admin';

  // Called after the user successfully saves a recovery code so the
  // force-set modal stops appearing without a full /auth/me refetch.
  const markRecoveryCodeSet = () => setUser(u => u ? { ...u, has_recovery_code: true } : u);

  return (
    <AuthContext.Provider value={{
      user, token, permissions, userRoles,
      login, logout, loading,
      can, canView, canCreate, canEdit, canDelete, canApprove, canSeeAll, isAdmin,
      markRecoveryCodeSet,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
