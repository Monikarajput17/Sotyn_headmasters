import axios from 'axios';
import { getToken, setToken, clearToken } from './lib/tokenStore';

const api = axios.create({ baseURL: '/api' });

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
  // Remember which token this request went out with, so a 401 can tell
  // whether it's still the active session or a stale in-flight request.
  config.metadata = { ...(config.metadata || {}), tokenAtSend: token || null };
  return config;
});

api.interceptors.response.use(
  res => {
    // Sliding session: the server hands back a fresh token once the current
    // one is past a day old. Swap it in so an active user never gets logged
    // out (mam 2026-06-12). Subsequent requests read it from the token store.
    const fresh = res.headers?.['x-refresh-token'];
    if (fresh) {
      setToken(fresh);
      api.defaults.headers.common.Authorization = `Bearer ${fresh}`;
    }
    return res;
  },
  err => {
    if (err.response?.status === 401) {
      // Bulletproof logout policy (mam, repeatedly: "automatically logout —
      // very bad"). The ONLY thing that may end a session is the definitive
      // session check, GET /auth/me, rejecting the CURRENT token. Two guards:
      //
      //   1. Only /auth/me 401s log out. A 401 from ANY other endpoint — a
      //      stale in-flight request from a previous session, a flaky call, or
      //      an endpoint that wrongly returns 401 instead of 403 — is ignored
      //      and never drops a working session. AuthContext re-pulls /auth/me
      //      on mount, on tab focus, and every 2 min, so a genuinely dead
      //      token is still caught and logged out promptly.
      //   2. Even for /auth/me, only act if the token that failed is still the
      //      active one — a slow stale /auth/me resolving AFTER the user
      //      re-logged in must not clear the brand-new token (the "log in,
      //      then instantly logged out" race — Nitin Jain, 2026-06-24).
      const url = err.config?.url || '';
      const used = err.config?.metadata?.tokenAtSend || null;
      const current = getToken();
      const isSessionCheck = url.includes('/auth/me');
      // Self-heal a spurious 401 from a token race: if this data request went
      // out with NO token, or with a DIFFERENT token than the one now active
      // (a first-render race on a fresh load, or a request in flight across a
      // login/refresh), retry it ONCE with the current token instead of leaving
      // the page's data broken. mam 2026-07-01: on a valid session (/auth/me was
      // 200) a couple of calls — track-location and the CRM-kitting matrix —
      // still 401'd because they beat the token onto the wire. Never retry the
      // /auth/me check itself, and guard with a flag so it can never loop.
      if (!isSessionCheck && current && used !== current && err.config && !err.config._retried401) {
        err.config._retried401 = true;
        err.config.headers = { ...(err.config.headers || {}), Authorization: `Bearer ${current}` };
        return api(err.config);
      }
      if (isSessionCheck && current && used === current) {
        clearToken();
        delete api.defaults.headers.common.Authorization;
        // Only hard-redirect if we're NOT already on the login page — a 401
        // from a background poll on /login would otherwise loop the page.
        if (!window.location.pathname.startsWith('/login')) {
          window.location.href = '/login';
        }
      } else if (!isSessionCheck && used && used === current) {
        // A data endpoint rejected the current token. Per mam's standing rule
        // ("automatic logout — very bad"), a single data-endpoint 401 must
        // NEVER end the session — it can be a stale in-flight request, a flaky
        // call, or an endpoint wrongly 401'ing. We do NOT force an immediate
        // /auth/me logout here (that change, 5d5a6c8, kicked active users out
        // on the first failing request and was reverted 2026-06-26). The
        // deliberate session check — AuthContext's /auth/me on mount, on tab
        // focus, and every 2 min — still catches a genuinely dead token and
        // logs out cleanly. We only strip the raw "Invalid token" text so the
        // page shows its own friendly fallback instead of the internal string.
        if (err.response.data && /token/i.test(err.response.data.error || '')) {
          err.response.data = { ...err.response.data, error: null };
        }
      }
    }
    return Promise.reject(err);
  }
);

export default api;
