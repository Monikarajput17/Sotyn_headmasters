// Resilient auth-token storage.
//
// Some devices can't reliably persist localStorage — in-app browsers
// (opening the link inside WhatsApp / Instagram / Facebook), private /
// incognito mode, "clear site data on exit", or cookies+site-data blocked
// for the site. On those devices the login token was saved and then gone
// before the very next request, so /auth/me went out unauthenticated, got
// a 401, and the app snapped straight back to login (mam 2026-06-23:
// "when I login automatically logout … some devices").
//
// Fix: always keep the token in a module-level in-memory variable too, so
// the CURRENT page session keeps working even when localStorage is blocked.
// We also detect the blocked case so the UI can tell the user to open the
// site in a real browser instead of silently bouncing them.
//
// Supabase migration: sessions now come from Supabase Auth, which issues an
// access token (short-lived) + a refresh token. Both are kept here with the
// same resilience; the api layer slides the session using the refresh token
// so users still never get logged out while active.

let memToken = null;          // in-memory fallback — survives the page session
let memRefresh = null;
let storageBlocked = false;   // set true once we detect localStorage can't persist

export function isStorageBlocked() {
  return storageBlocked;
}

export function getToken() {
  try {
    const t = localStorage.getItem('token');
    if (t) return t;
  } catch {
    storageBlocked = true;
  }
  // Fall back to the in-memory copy when storage is empty/blocked.
  return memToken;
}

export function setToken(token) {
  memToken = token || null;   // ALWAYS keep an in-memory copy first
  try {
    if (token) localStorage.setItem('token', token);
    else localStorage.removeItem('token');
    // Some browsers (private mode / blocked storage) accept setItem but
    // silently drop it — verify the write actually stuck.
    if (token && localStorage.getItem('token') !== token) storageBlocked = true;
  } catch {
    storageBlocked = true;
  }
}

export function getRefreshToken() {
  try { const t = localStorage.getItem('refresh_token'); if (t) return t; } catch { storageBlocked = true; }
  return memRefresh;
}

export function setRefreshToken(token) {
  memRefresh = token || null;
  try {
    if (token) localStorage.setItem('refresh_token', token);
    else localStorage.removeItem('refresh_token');
  } catch { storageBlocked = true; }
}

export function clearToken() {
  memToken = null;
  memRefresh = null;
  try { localStorage.removeItem('token'); localStorage.removeItem('refresh_token'); } catch { /* ignore */ }
}
