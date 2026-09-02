import axios from 'axios';
import { getToken, setToken, clearToken, getRefreshToken, setRefreshToken } from './lib/tokenStore';

// API base: in dev the Vite proxy forwards '/api' to the Edge Function; in
// production the build points straight at Supabase
// (VITE_API_BASE = https://<ref>.supabase.co/functions/v1/api).
export const API_BASE = import.meta.env.VITE_API_BASE || '/api';
const api = axios.create({ baseURL: API_BASE });

// Seed the auth header from storage at module load — BEFORE the first render —
// so any request fired on the very first tick after a fresh page load (e.g. the
// post-login reload) carries the token even if it somehow races the request
// interceptor below (mam 2026-07-01: track-location + the CRM-kitting matrix
// 401'd on a fresh, valid session).
try { const t0 = getToken(); if (t0) api.defaults.headers.common.Authorization = `Bearer ${t0}`; } catch { /* storage blocked — interceptor still attaches per-request */ }

api.interceptors.request.use(config => {
  // Resilient read: falls back to an in-memory copy when localStorage is
  // blocked/wiped (in-app browsers, private mode) — otherwise the request
  // goes out unauthenticated and the user is bounced to login.
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // The session check carries the refresh token so the server can slide the
  // session (Supabase Auth access tokens are short-lived; the server rotates
  // the pair when it's close to expiry and hands both back in headers).
  if ((config.url || '').includes('/auth/me')) {
    const rt = getRefreshToken();
    if (rt) config.headers['X-Refresh-Token'] = rt;
  }
  // Remember which token this request went out with, so a 401 can tell
  // whether it's still the active session or a stale in-flight request.
  config.metadata = { ...(config.metadata || {}), tokenAtSend: token || null };
  return config;
});

function adoptSession(token, refresh) {
  if (token) { setToken(token); api.defaults.headers.common.Authorization = `Bearer ${token}`; }
  if (refresh) setRefreshToken(refresh);
}

// One in-flight refresh at a time; concurrent 401s share it.
let refreshing = null;
async function tryRefresh() {
  const rt = getRefreshToken();
  if (!rt) return null;
  if (!refreshing) {
    refreshing = axios.post(`${API_BASE}/auth/refresh`, { refresh_token: rt })
      .then(r => { adoptSession(r.data.token, r.data.refresh_token); return r.data.token; })
      .catch(() => null)
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

api.interceptors.response.use(
  res => {
    // Sliding session: the server hands back a fresh token pair once the
    // current one is close to expiry. Swap them in so an active user never
    // gets logged out (mam 2026-06-12).
    const fresh = res.headers?.['x-refresh-token'];
    const freshRt = res.headers?.['x-new-refresh-token'];
    if (fresh) adoptSession(fresh, freshRt);
    return res;
  },
  async err => {
    if (err.response?.status === 401) {
      // Bulletproof logout policy (mam, repeatedly: "automatically logout —
      // very bad"). The ONLY thing that may end a session is the definitive
      // session check, GET /auth/me, rejecting the CURRENT token — and even
      // then only after a refresh attempt with the stored refresh token failed.
      const url = err.config?.url || '';
      const used = err.config?.metadata?.tokenAtSend || null;
      const current = getToken();
      const isSessionCheck = url.includes('/auth/me');
      // Self-heal a spurious 401 from a token race: if this data request went
      // out with NO token, or with a DIFFERENT token than the one now active,
      // retry it ONCE with the current token.
      if (!isSessionCheck && current && used !== current && err.config && !err.config._retried401) {
        err.config._retried401 = true;
        err.config.headers = { ...(err.config.headers || {}), Authorization: `Bearer ${current}` };
        return api(err.config);
      }
      // Expired access token (the normal Supabase case): refresh once and
      // replay the ORIGINAL request transparently.
      if (current && used === current && err.config && !err.config._refreshed401) {
        const newTok = await tryRefresh();
        if (newTok) {
          err.config._refreshed401 = true;
          err.config.headers = { ...(err.config.headers || {}), Authorization: `Bearer ${newTok}` };
          return api(err.config);
        }
      }
      if (isSessionCheck && current && used === current) {
        clearToken();
        delete api.defaults.headers.common.Authorization;
        if (!window.location.pathname.startsWith('/login')) {
          window.location.href = '/login';
        }
      } else if (!isSessionCheck && used && used === current) {
        // A data endpoint rejected the current token — never end the session
        // here (see the standing rule above); just strip the raw token text.
        if (err.response.data && /token/i.test(err.response.data.error || '')) {
          err.response.data = { ...err.response.data, error: null };
        }
      }
    }
    return Promise.reject(err);
  }
);

export default api;
