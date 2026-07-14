// Optional Sentry integration for backend error monitoring.
//
// IMPORTANT: this module must be required BEFORE express / route files
// so the @sentry/node v8 auto-instrumentation can hook into them.
// See server/index.js — first line is `require('./lib/sentry')`.
//
// Activated only when SENTRY_DSN is set in the environment. Without it,
// this module is a no-op so local dev / fresh deploys keep working.
//
// Env vars:
//   SENTRY_DSN                   The DSN from Sentry → Project → Settings
//   SENTRY_TRACES_SAMPLE_RATE    0..1 (default 0.1 = 10% of requests)
//   SENTRY_RELEASE               Optional release name (e.g. git SHA)
//   NODE_ENV                     Used as the Sentry environment tag

require('dotenv').config();

const dsn = process.env.SENTRY_DSN;
let Sentry = null;

if (dsn) {
  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      release: process.env.SENTRY_RELEASE || undefined,
      tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
      // Strip auth tokens / cookies / request bodies before they leave
      // the server. Sentry should NEVER see passwords or JWTs.
      beforeSend(event) {
        try {
          if (event.request) {
            if (event.request.headers) {
              delete event.request.headers.authorization;
              delete event.request.headers.cookie;
              delete event.request.headers['x-auth-token'];
            }
            delete event.request.data;       // body
            delete event.request.cookies;
          }
        } catch {}
        return event;
      },
    });
    // Mask the secret part of the DSN in the log
    console.log('[sentry] initialized for', dsn.replace(/\/\/.*@/, '//***@'));
  } catch (e) {
    console.warn('[sentry] init failed (run `npm install` to add @sentry/node):', e.message);
    Sentry = null;
  }
}

module.exports = {
  Sentry,
  enabled: !!Sentry,
  // Wire the Express error handler at the end of the middleware chain.
  // No-op if Sentry isn't loaded.
  setupExpressErrorHandler(app) {
    if (Sentry?.setupExpressErrorHandler) {
      // @sentry/node v8 helper
      Sentry.setupExpressErrorHandler(app);
    } else if (Sentry?.Handlers?.errorHandler) {
      // @sentry/node v7 fallback
      app.use(Sentry.Handlers.errorHandler());
    }
  },
  captureException(err, ctx) {
    try { Sentry?.captureException(err, ctx); } catch {}
  },
};
