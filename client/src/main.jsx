// A tiny local error boundary always wraps the app (renders the fallback
// immediately); the heavy @sentry/react SDK is lazy-loaded + DSN-gated via
// initSentry() below, off the first-paint critical path.
import { AppErrorBoundary, initSentry } from './sentry'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { AuthProvider } from './context/AuthContext'
import { SocketProvider } from './context/SocketProvider'
import { getToken } from './lib/tokenStore'
// Self-hosted Inter (weight-axis variable font, one same-origin woff2 covering
// all weights). Replaces the render-blocking Google Fonts @import — subsets are
// unicode-range gated so only the Latin file is fetched for the English UI.
import '@fontsource-variable/inter/wght.css'
import './index.css'
import App from './App.jsx'

// --- Stale-chunk recovery after a code-split deploy -----------------------
// Each deploy gives the lazy route chunks new hashed filenames and removes the
// old ones. A tab still running the PREVIOUS index.html then fails to fetch a
// chunk when it navigates: "Failed to fetch dynamically imported module". We
// reload once to pull the fresh index.html + assets. A 10s throttle prevents
// any reload loop if the failure is something else (mam 2026-06-25).
// Also catch the symptom of a stale chunk URL being served index.html instead
// of 404 (HTML parsed as a module): the lazy import resolves to undefined →
// "reading 'default'", or the HTML trips "Unexpected token '<'". The 10s
// throttle below means a genuine (non-stale) bug reloads at most once, then
// shows the real error (mam 2026-06-27).
const CHUNK_ERR_RE = /dynamically imported module|module script failed|error loading dynamically|reading ['"]default['"]|unexpected token/i
function recoverFromStaleChunk() {
  try {
    const last = +sessionStorage.getItem('chunk-reload-at') || 0
    if (Date.now() - last < 10000) return false   // reloaded just now → don't loop
    sessionStorage.setItem('chunk-reload-at', String(Date.now()))
  } catch { /* storage blocked — still reload below */ }
  // Belt-and-suspenders before reloading: drop any Cache-Storage app shell that
  // could keep handing back a stale index.html (Chrome especially), then reload
  // to the fresh build. The reload itself revalidates index.html (no-cache).
  const reload = () => window.location.reload()
  try {
    if (window.caches && caches.keys) {
      caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))).finally(reload)
      return true
    }
  } catch { /* fall through */ }
  reload()
  return true
}
// Vite emits this when a preloaded/imported chunk 404s after a deploy.
window.addEventListener('vite:preloadError', (e) => { e?.preventDefault?.(); recoverFromStaleChunk() })
// Catch the raw dynamic-import rejection too (covers non-preload paths).
window.addEventListener('unhandledrejection', (e) => { if (CHUNK_ERR_RE.test(e?.reason?.message || '')) recoverFromStaleChunk() })

// Friendly fallback shown if a render error escapes a per-page boundary.
function ErrorScreen({ error, resetError }) {
  const msg = error?.message || String(error)
  const stale = CHUNK_ERR_RE.test(msg)
  // A failed chunk = a new version was deployed under this tab → reload to it.
  if (stale) recoverFromStaleChunk()
  return (
    <div style={{ padding: 32, fontFamily: 'sans-serif', color: '#7f1d1d' }}>
      <h2 style={{ marginBottom: 8 }}>{stale ? 'Updating to the latest version…' : 'Something went wrong'}</h2>
      <p style={{ color: '#374151', marginBottom: 16 }}>
        {stale ? 'A new version was just deployed — reloading the page.' : 'The error has been reported. You can refresh or try again.'}
      </p>
      {!stale && (
        <pre style={{ background: '#fef2f2', padding: 12, borderRadius: 6, overflow: 'auto' }}>
          {msg}
        </pre>
      )}
      <button onClick={() => { try { sessionStorage.removeItem('chunk-reload-at') } catch {}; window.location.reload() }} style={{ marginTop: 12, padding: '8px 14px', background: '#dc2626', color: 'white', border: 0, borderRadius: 6, cursor: 'pointer' }}>
        Reload
      </button>
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AppErrorBoundary fallback={ErrorScreen}>
      <BrowserRouter>
        <AuthProvider>
          <SocketProvider>
            <App />
            <Toaster position="top-right" />
          </SocketProvider>
        </AuthProvider>
      </BrowserRouter>
    </AppErrorBoundary>
  </StrictMode>,
)

// Warm the lazy Layout shell for LIKELY-authenticated visitors (a token is
// present) so its chunk downloads in parallel with the /auth/me round-trip
// instead of serially after the entry evaluates — collapsing the entry → Layout
// → page waterfall on the logged-in first paint / post-login reload. Logged-out
// visitors (no token) never fetch it, preserving the lean login-first paint.
if (getToken()) {
  const warmShell = () => { import('./components/Layout'); };
  if (window.requestIdleCallback) window.requestIdleCallback(warmShell, { timeout: 2000 });
  else setTimeout(warmShell, 0);
}

// Load + init Sentry after first paint (no-op without VITE_SENTRY_DSN). Deferred
// off the critical path — same idle pattern as SocketProvider.
const startSentry = () => { initSentry(); };
if (window.requestIdleCallback) window.requestIdleCallback(startSentry, { timeout: 3000 });
else setTimeout(startSentry, 0);
