// Optional Sentry integration for the frontend — LAZY-loaded (perf pass —
// bundle). The @sentry/react SDK (core + browser tracing + Session Replay's
// rrweb recorder) is ~75–90 KB gzip and was previously in the ENTRY bundle for
// every page, even in dev / deploys with no DSN. It's now behind a dynamic
// import() gated on VITE_SENTRY_DSN, so Rollup emits it as a separate async
// chunk that is never fetched unless a DSN is configured — and initSentry() is
// called AFTER first paint, off the critical path.
//
// Error boundary: a tiny local class (no dependency on the SDK) always wraps the
// app so render errors show a fallback immediately; once the SDK has finished
// loading it also forwards caught errors to Sentry.captureException.
//
// Env vars (set in client/.env or via the deploy environment):
//   VITE_SENTRY_DSN              The frontend DSN from Sentry
//   VITE_SENTRY_RELEASE          Optional release tag (e.g. git SHA)
import { Component, createElement } from 'react';

let sentry = null;   // the loaded @sentry/react module, or null until initSentry() resolves

// Load + initialise Sentry only when a DSN is set. Safe to call once, deferred
// (e.g. from a requestIdleCallback after render) — reporting is best-effort.
export async function initSentry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn || sentry) return;
  try {
    const S = await import('@sentry/react');
    S.init({
      dsn,
      environment: import.meta.env.MODE,
      release: import.meta.env.VITE_SENTRY_RELEASE || undefined,
      integrations: [
        S.browserTracingIntegration(),
        // Session Replay only kicks in when there's an error — privacy-safe
        // (text masked, media blocked) and cheap on the Sentry quota.
        S.replayIntegration({ maskAllText: true, blockAllMedia: true }),
      ],
      tracesSampleRate: 0.1,
      replaysSessionSampleRate: 0.0,
      replaysOnErrorSampleRate: 1.0,
      // Don't ship Authorization headers / JWTs to Sentry.
      beforeSend(event) {
        try {
          if (event.request?.headers) {
            delete event.request.headers.Authorization;
            delete event.request.headers.authorization;
            delete event.request.headers.cookie;
          }
          if (event.breadcrumbs) {
            for (const b of event.breadcrumbs) {
              if (b?.data?.request_headers) delete b.data.request_headers;
            }
          }
        } catch {}
        return event;
      },
    });
    sentry = S;
    // eslint-disable-next-line no-console
    console.log('[sentry] initialized for', dsn.replace(/\/\/.*@/, '//***@'));
    // Expose on window so admins can fire test events from the DevTools console:
    //   window.Sentry.captureMessage('hello')
    //   window.Sentry.captureException(new Error('boom'))
    if (typeof window !== 'undefined') window.Sentry = S;
  } catch { /* SDK failed to load — app keeps running without reporting */ }
}

// Report an already-caught error if the SDK is loaded (no-op otherwise).
export function reportError(error, info) {
  try { sentry?.captureException?.(error, info ? { extra: info } : undefined); } catch {}
}

// Local error boundary — no @sentry/react dependency, so it ships in the entry
// with zero SDK weight. Renders the `fallback` render-prop (same shape Sentry's
// own ErrorBoundary used: { error, resetError }) and forwards to Sentry if loaded.
export class AppErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; this.resetError = this.resetError.bind(this); }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { reportError(error, info); }
  resetError() { this.setState({ error: null }); }
  render() {
    if (this.state.error) {
      const Fallback = this.props.fallback;
      return Fallback ? createElement(Fallback, { error: this.state.error, resetError: this.resetError }) : null;
    }
    return this.props.children;
  }
}
