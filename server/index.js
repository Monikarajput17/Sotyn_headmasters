// Sentry MUST be required before express/route files so the v8 auto-
// instrumentation can hook into them. No-op if SENTRY_DSN is unset.
const sentry = require('./lib/sentry');

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initializeDatabase } = require('./db/schema');

// Surface uncaught errors to Sentry (and the console). Without these,
// PM2 just silently restarts on a crash and we lose the stack trace.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  sentry.captureException(err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
  sentry.captureException(err);
});

const app = express();
const PORT = process.env.PORT || 5000;

// CORS - allow all origins in dev, restrict in production
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? false : '*',
  credentials: true
}));

// Gzip compression — typical 60-80% smaller JSON responses, faster pages
// over slow networks (mobile / site engineers on 4G). Skip very small
// responses (level=6 default).
try {
  const compression = require('compression');
  app.use(compression());
  console.log('[perf] gzip compression enabled');
} catch (e) {
  console.warn('[perf] compression not installed — run npm install for faster pages');
}

app.use(express.json({ limit: '10mb' }));

// Cache static assets (logo, icons, JS bundles) for 1 day in browser.
// React build files have content-hashed filenames so they invalidate
// automatically on next deploy — safe to cache aggressively.
app.use((req, res, next) => {
  if (req.path.startsWith('/assets/') || req.path.endsWith('.webp') || req.path.endsWith('.png') || req.path.endsWith('.svg') || req.path.endsWith('.css') || req.path.endsWith('.js')) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }
  next();
});

// Trust proxy for cloud deployments
app.set('trust proxy', 1);

// File uploads
const multer = require('multer');
const fs = require('fs');
const uploadsDir = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`)
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// Initialize DB
initializeDatabase();

// Lock in the JWT signing secret NOW, while the DB is guaranteed ready and
// before any request can arrive. getSecret() persists the secret in
// app_settings on first call and memoizes it; calling it eagerly here
// removes the last "DB not ready → seed fallback → secret flips → everyone
// logged out" window (mam, repeatedly: "automatically logout — very bad").
// The boot log lets us confirm the secret is stable instead of guessing the
// next time a logout is reported.
try {
  const { getSecret } = require('./middleware/auth');
  if (typeof getSecret === 'function') {
    getSecret();
    console.log('[auth] JWT secret locked in at boot (stable across restarts)');
  }
} catch (e) {
  console.warn('[auth] could not pre-lock JWT secret:', e.message);
}

// Seed the 20 MIS scorecard templates on first boot. Idempotent.
// Sotyn.Headmasters (salon): these templates are construction KPIs (Site
// Engineer, DPR profit, Indent accuracy…), so they're disabled by default via
// ERP_DISABLE_SCORING_SEED. Unset the env to restore for a construction ERP.
if (!process.env.ERP_DISABLE_SCORING_SEED) {
  try {
    const { seedScoringTemplates } = require('./db/seedScoring');
    const { getDb } = require('./db/schema');
    const r = seedScoringTemplates(getDb());
    if (r.seeded > 0) console.log(`[seed] scoring: seeded ${r.seeded} templates`);
    if (r.raciAdded > 0) console.log(`[seed] scoring: added RACI row to ${r.raciAdded} templates`);
  } catch (e) {
    console.warn('[seed] scoring failed:', e.message);
  }
}

// Solar Quotation module — create tables + seed the rate book on first boot
// (mam 2026-06-21). Idempotent: tables use IF NOT EXISTS, rows only seed when
// each table is empty. Skip via ERP_DISABLE_SOLAR_SEED=1.
if (!process.env.ERP_DISABLE_SOLAR_SEED) {
  try {
    const { initSolar } = require('./db/seedSolar');
    const { getDb } = require('./db/schema');
    const r = initSolar(getDb());
    if (r.seeded > 0) console.log(`[seed] solar: seeded ${r.seeded} rate rows`);
  } catch (e) {
    console.warn('[seed] solar failed:', e.message);
  }
}

// One-time cleanup: strip CSV-import quote artifacts ("""M/s X""") and
// extra whitespace from business_book text columns. Idempotent — only
// updates rows where the cleaned value differs.
try {
  const { getDb } = require('./db/schema');
  const db = getDb();
  const cols = ['client_name', 'company_name', 'project_name', 'district', 'state', 'po_number', 'category', 'employee_assigned'];
  const expr = (c) => `TRIM(REPLACE(REPLACE(REPLACE(REPLACE(${c}, '"', ''), CHAR(96), ''), CHAR(39), ''), CHAR(9), ' '))`;
  let total = 0;
  for (const c of cols) {
    const r = db.prepare(`UPDATE business_book SET ${c} = ${expr(c)} WHERE ${c} IS NOT NULL AND ${c} != ${expr(c)}`).run();
    total += r.changes || 0;
  }
  if (total > 0) console.log(`[cleanup] business_book: scrubbed ${total} cells`);
} catch (e) {
  // Non-fatal — DB may not have business_book yet
}

// Nightly DB backup scheduler — runs at 02:00 local time every day and
// keeps the last 30 backups. Backups go to ~/erp-backups on the VPS (or
// ../backups on Windows). Admin can also list / download / trigger manually
// via /api/admin/backups/*. Skip in dev via ERP_DISABLE_BACKUP_SCHEDULER=1.
if (!process.env.ERP_DISABLE_BACKUP_SCHEDULER) {
  try {
    const { scheduleNightly } = require('./scripts/backup-db');
    scheduleNightly();
  } catch (e) {
    console.warn('[backup] Scheduler not started:', e.message);
  }
}

// Daily 07:30 AM audit JSON snapshot — TOC v3 P0 #5.  Writes the same
// JSON the /audit endpoints return into data/audit-snapshots/<date>/
// so the CMD's 09:00 email and the four role dashboards can render
// from a fixed "as of this morning" file.  Skip via
// ERP_DISABLE_AUDIT_SNAPSHOT=1 (dev / local runs).
try {
  const { scheduleDailyAuditSnapshot } = require('./scripts/dailyAuditSnapshot');
  scheduleDailyAuditSnapshot();
} catch (e) {
  console.warn('[audit-snapshot] Scheduler not started:', e.message);
}

// Daily 18:00 DPR auto-prompt — TOC v3 P1 #4.  Pushes a notification
// to every site engineer who hasn't submitted today's DPR for their
// active site(s).  Sunday off.  Sends a rollup to admins when overall
// adherence is below 50%.  Skip via ERP_DISABLE_DPR_PROMPT=1.
try {
  const { scheduleDprAutoPrompt } = require('./scripts/dprAutoPrompt');
  scheduleDprAutoPrompt();
} catch (e) {
  console.warn('[dpr-prompt] Scheduler not started:', e.message);
}

// AR collection-day auto-roll — daily 01:00 moves unpaid, overdue AR entries
// to the next Mon/Thu (mam 2026-06-18). Skip via ERP_DISABLE_ARAP_ROLL=1.
try {
  const { scheduleArApRollCron } = require('./scripts/arApRollCron');
  scheduleArApRollCron();
} catch (e) {
  console.warn('[arap-roll] Scheduler not started:', e.message);
}

// Cash fidelity cron — audit items A7 + A14.  Daily 00:00 rolls over
// cash_flow_daily (so runway numbers don't drift on no-collection
// days); daily 01:00 recomputes receivables ageing across the board
// (replaces the manual "Refresh Ageing" button as primary truth).
// Skip via ERP_DISABLE_CASH_CRON=1.
try {
  const { scheduleCashFidelity } = require('./scripts/cashFidelityCron');
  scheduleCashFidelity();
} catch (e) {
  console.warn('[cash-fidelity] Scheduler not started:', e.message);
}

// Item Master cleanup — mam (2026-05-16): "correct item wise master
// sheet unit as per market if our wrong and no need duplicacy and
// correct the spelling".  One-shot, idempotent via
// app_settings.item_master_cleanup_v1.  Skip via
// ERP_DISABLE_ITEM_CLEANUP=1.
try {
  require('./scripts/itemMasterCleanup').runOnce();
} catch (e) {
  console.warn('[item-master-cleanup] failed to start:', e.message);
}

// One-time rate import — mam (2026-06-01): "according to this excel
// update rate in item wise in erp".  Reads data/itemwise-rates-
// 2026-06-01.json and updates item_master.current_price for the 140
// rows mam shared.  Guarded by an app_settings flag so it runs
// exactly once after deploy.  Skip via ERP_DISABLE_ITEM_RATE_IMPORT=1.
try {
  require('./scripts/itemwiseRateImport').runOnce();
} catch (e) {
  console.warn('[itemwise-rate-import] failed to start:', e.message);
}

// v2 — second-pass rate import (mam 2026-06-01): broader CSV
// export with 2,496 rate rows.  Separate flag so v1 stays
// settled.  Skip via ERP_DISABLE_ITEM_RATE_IMPORT=1 (same env
// var as v1 — disables both).
try {
  require('./scripts/itemwiseRateImportV2').runOnce();
} catch (e) {
  console.warn('[itemwise-rate-import-v2] failed to start:', e.message);
}

// v3 — third-pass rate import (mam 2026-06-01): 101 daybook-matched
// rows from final item.xlsx.  Separate flag, code-ci fallback added.
// Skip via ERP_DISABLE_ITEM_RATE_IMPORT=1 (same env var).
try {
  require('./scripts/itemwiseRateImportV3').runOnce();
} catch (e) {
  console.warn('[itemwise-rate-import-v3] failed to start:', e.message);
}

// One-time backfill — mam (2026-06-01): "this person every month
// make salary full" for Parul Goyal, Rajat Sir, Nitin Jain, Ankur
// Kaplesh, Pooja Kaplesh, D.S Kaplesh, Soma Kaplesh.  Sets
// employees.salary_exempt=1 for matches.  Skip via
// ERP_DISABLE_PAYROLL_EXEMPT_BACKFILL=1.
try {
  require('./scripts/payrollExemptBackfill').runOnce();
} catch (e) {
  console.warn('[payroll-exempt] failed to start:', e.message);
}

// Fire NOC auto-pilot — mam (2026-05-16): "i need easy to user for
// update but automatically things which you can done".  Backfills
// existing rows once on boot (idempotent via app_settings flag),
// then runs every hour to keep stages + statuses in sync with the
// passing days.  Skip via ERP_DISABLE_FIRE_NOC_CRON=1.
try {
  const { scheduleFireNocCron, backfillOnceOnBoot } = require('./scripts/fireNocCron');
  backfillOnceOnBoot();
  scheduleFireNocCron();
} catch (e) {
  console.warn('[fire-noc-cron] Scheduler not started:', e.message);
}

// HR Automations cron — mam (2026-05-22 Batch E module #15).
// Every 30 min: scans for interview reminders, stale offers, pending
// hiring-request approvals → creates in-app notifications + emails
// HR users.  Skip via ERP_DISABLE_HR_CRON=1.
try {
  require('./scripts/hrAutomationsCron').schedule();
} catch (e) {
  console.warn('[hr-cron] Scheduler not started:', e.message);
}

// Procurement schedule reminder cron — mam (2026-05-29):
// "only 1 day before reminder and suggestion".  Every weekday at
// 09:00 (and 60 s after boot for catch-up) scans the schedule for
// indent rows whose end_date == tomorrow's business day, and posts
// an announcement + push for each.  Dedup table guarantees no
// double-posts.  Skip via ERP_DISABLE_PROCSCH_REMINDER=1.
try {
  const { scheduleProcurementReminderCron } = require('./scripts/procurementReminderCron');
  scheduleProcurementReminderCron();
} catch (e) {
  console.warn('[procsch-reminder] Scheduler not started:', e.message);
}

// Daily 09:00 CMD audit email — audit item B20 + TOC v3 P0 #5.
// Reads the 07:30 snapshot JSON (falls back to live /audit/kpi if
// the snapshot folder is missing) and emails the director address
// configured in Admin → Email Settings.  Skip via
// ERP_DISABLE_CMD_EMAIL=1.  Sunday off.
try {
  const { scheduleDailyCmdEmail } = require('./scripts/dailyCmdEmail');
  scheduleDailyCmdEmail();
} catch (e) {
  console.warn('[cmd-email] Scheduler not started:', e.message);
}

// Fortnightly (1st & 16th) installation-billing — auto-generates Type-3 sales
// bills from approved DPRs (work value × Against-Installation %). Idempotent;
// bills are approved but a human still clicks "Sent to Client".
// Skip via ERP_DISABLE_INSTALL_BILLING=1.
try {
  const { scheduleInstallationBillingCron } = require('./scripts/installationBillingCron');
  scheduleInstallationBillingCron();
} catch (e) {
  console.warn('[install-billing] Scheduler not started:', e.message);
}

// Admin-triggered procurement reminder run — fires the 1-day-before
// scan on demand so mam can verify the announcement + push delivery
// without waiting for the 09:00 cron tick.  Uses the same auth
// pattern as the CMD email manual trigger below.
const { authMiddleware: _procReminderAuthMw } = require('./middleware/auth');
app.post('/api/admin/procsch-reminder/run-now', _procReminderAuthMw, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { runOnce } = require('./scripts/procurementReminderCron');
    const r = runOnce();
    res.json({ message: 'Reminder scan complete', ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin-triggered CMD email — sends the same daily summary on
// demand so mam can verify SMTP + content without waiting for 9 AM.
// authMiddleware is required inline here because the original require
// is further down the file (line ~244) — using it earlier hit the
// const TDZ on boot. Idempotent: the second require below is a
// cache-hit, no double load.
const { authMiddleware: _authMw } = require('./middleware/auth');
app.post('/api/admin/cmd-email/send-now', _authMw, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { runOnce } = require('./scripts/dailyCmdEmail');
    runOnce().catch(e => console.error('[cmd-email manual]', e.message));
    res.json({ message: 'CMD email fired — check pm2 logs for delivery confirmation' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Audit middleware — runs before the routes so every mutating request
// (POST/PUT/PATCH/DELETE) is logged on response finish. Reads req.user set
// by authMiddleware inside each router. Fire-and-forget so it can't slow
// down or break real requests.
const { auditMiddleware } = require('./middleware/audit');
app.use(auditMiddleware);

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin/audit', require('./routes/audit'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/sales-funnel', require('./routes/salesfunnel'));
app.use('/api/quotations', require('./routes/quotations'));
app.use('/api/solar', require('./routes/solar'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/business-book', require('./routes/businessbook'));
app.use('/api/payment-required', require('./routes/paymentrequired'));
app.use('/api/raci', require('./routes/raci').router);
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/support', require('./routes/support'));
app.use('/api/item-master', require('./routes/itemmaster'));
app.use('/api/pipe-weights', require('./routes/pipeweights'));
app.use('/api/procurement', require('./routes/procurement'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/installation', require('./routes/installation'));
app.use('/api/sales-billing', require('./routes/salesBilling'));
app.use('/api/complaints', require('./routes/complaints'));
app.use('/api/hr', require('./routes/hr'));
// Mam (2026-05-22 Batch D): unauthenticated public offer-accept
// endpoint.  Mounted as its own router (no auth middleware) so
// candidates can accept / decline via /offer/:token without
// logging in to the ERP.
app.use('/api/public', require('./routes/publicHr'));
app.use('/api/payroll', require('./routes/payroll'));
app.use('/api/scoring', require('./routes/scoring'));
app.use('/api/gamification', require('./routes/champions'));
app.use('/api/tools', require('./routes/tools'));
app.use('/api/rentals', require('./routes/rentals'));
app.use('/api/snags', require('./routes/snags'));
// Mam (2026-05-30): labour payment indents — sits in the Projects
// sidebar group, raised against a site + sub-contractor.
app.use('/api/labour-payment', require('./routes/labourPayment'));
// Indent Labour Payment — Phase 1 (mam 2026-06-01).
app.use('/api/indent-labour-payment', require('./routes/indentLabourPayment'));
app.use('/api/company-assets', require('./routes/companyAssets'));
app.use('/api/push', require('./routes/push'));

// Initialise VAPID keys on boot (auto-generates on first run, then
// persists in app_settings so PM2 restarts keep the same keys).
try {
  require('./lib/push').ensureVapid();
} catch (e) {
  console.warn('[push] VAPID init failed (web-push package may need npm install):', e.message);
}
app.use('/api/delegations', require('./routes/delegations'));
app.use('/api/announcements', require('./routes/announcements'));
app.use('/api/price-requests', require('./routes/pricerequests'));
app.use('/api/pms-tasks', require('./routes/pmstasks'));
app.use('/api/admin/backups', require('./routes/backups'));
app.use('/api/admin/word-count', require('./routes/wordcount'));
app.use('/api/admin/changelog', require('./routes/changelog'));
app.use('/api/admin/locations', require('./routes/locations'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/ai-agent', require('./routes/aiAgent'));
app.use('/api/email-rules', require('./routes/emailRules'));
app.use('/api/sub-contractors', require('./routes/subcontractors'));
app.use('/api/subcon-hiring', require('./routes/subconHiring'));
app.use('/api/procurement-schedule', require('./routes/procurementSchedule'));
app.use('/api/crm-funnel', require('./routes/crmFunnel'));
app.use('/api/cheques', require('./routes/cheques'));
app.use('/api/dashboards', require('./routes/dashboards'));
app.use('/api/fire-noc', require('./routes/fireNoc'));
app.use('/api/rental-tools', require('./routes/rentalTools'));
// ─── Sotyn.Headmasters fork — salon & spa modules ───────────────────────────
app.use('/api/salon/services', require('./routes/salonServices'));
app.use('/api/salon/stylists', require('./routes/salonStylists'));
app.use('/api/salon/clients', require('./routes/salonClients'));
app.use('/api/salon/appointments', require('./routes/salonAppointments'));
app.use('/api/salon/memberships', require('./routes/salonMemberships'));
app.use('/api/salon/public', require('./routes/salonPublic'));   // NO auth — public online booking
app.use('/api/salon/products', require('./routes/salonProducts'));
app.use('/api/salon/pos', require('./routes/salonPos'));
app.use('/api/salon/commissions', require('./routes/salonCommissions'));
app.use('/api/influencers', require('./routes/influencers'));
app.use('/api/crm-kitting', require('./routes/crmKitting'));
app.use('/api/hr-system', require('./routes/hrSystem'));

// 4 Critical Systems
app.use('/api/cashflow', require('./routes/cashflow'));
app.use('/api/collections', require('./routes/collections'));
// AR/AP Tracker — rolling weekly cash-flow forecast (mam 2026-06-18)
app.use('/api/ar-ap-tracker', require('./routes/arApTracker'));
// Site Chat — internal WhatsApp-style message thread per site (mam 2026-06-18)
app.use('/api/site-chat', require('./routes/siteChat'));
app.use('/api/indent-fms', require('./routes/indentfms'));
app.use('/api/dpr', require('./routes/dpr'));

// CMD Audit endpoint (Master Prompt v3) — lives at /audit (not /api/audit)
// so an external scheduler can hit `securederp.in/audit` directly with a
// bearer token, no session cookie required. Returns 12 KPI tiles, 5
// exception lists, plus /audit/data-quality and /audit/analytics.
// Set AUDIT_API_TOKEN in pm2 env (`pm2 set ERP:AUDIT_API_TOKEN <token>`)
// or .env to enable; without it the endpoint replies 503.
app.use('/audit', require('./routes/auditReport'));

// File upload endpoint
const { authMiddleware } = require('./middleware/auth');
app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}`, filename: req.file.originalname, size: req.file.size });
});

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

// Health check for deployment platforms
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve React build in production.
// Mam (2026-06-02): mobile-card sweep landed but mam's iPhone kept
// showing the old desktop tables.  Root cause: express.static() used
// default cache headers, so browsers cached index.html itself.  Since
// index.html points at the content-hashed bundle name (e.g.
// index-CEasqyYx.js), a cached index.html keeps loading the OLD JS
// even after deploy.  Fix:
//   - Hashed asset files (under /assets/*) → cache forever (immutable)
//   - index.html + other root files → no-cache so a refresh ALWAYS
//     fetches the current bundle name.
const clientBuild = path.join(__dirname, '..', 'client', 'dist');
const fs2 = require('fs');
if (fs2.existsSync(clientBuild)) {
  app.use(express.static(clientBuild, {
    setHeaders: (res, filePath) => {
      // Vite emits hashed filenames into /assets/* — safe to cache hard.
      // Everything else (index.html, manifest.json, sw.js, favicons) is
      // served no-cache so a re-deploy is picked up on next page load.
      if (filePath.includes(`${path.sep}assets${path.sep}`) || filePath.includes('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    },
  }));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/uploads')) {
      // A request for a missing hashed asset (a STALE chunk after a re-deploy)
      // must 404 — NOT fall back to index.html. Serving HTML for a .js import
      // makes the dynamic import resolve to an HTML page → "Cannot read
      // properties of undefined (reading 'default')" in the browser, which
      // bypasses the client's stale-chunk auto-reload. A clean 404 surfaces as
      // "failed to fetch dynamically imported module", which DOES auto-recover
      // (mam 2026-06-27, /crm-funnel crash).
      if (req.path.startsWith('/assets/') || /\.(js|mjs|css|map|json|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)$/i.test(req.path)) {
        return res.status(404).send('Not found');
      }
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.sendFile(path.join(clientBuild, 'index.html'));
    } else {
      // CRITICAL: must close the response for unmatched /api/* paths.
      // Without this `else`, the handler did nothing and the response
      // hung open for 60+ seconds — surfaced as 502/timeout in the
      // 13-endpoint audit on /api/orders (no GET / route) and
      // /api/expenses (route file doesn't exist).
      res.status(404).json({ error: 'Not found', path: req.path, method: req.method });
    }
  });
  console.log('Serving frontend from client/dist');
} else {
  console.log('WARNING: client/dist not found - API only mode');
  app.get('/', (req, res) => res.json({ status: 'API running', message: 'Frontend not built. Run: npm run build' }));
}

// Sentry's Express error handler — captures the error and forwards it
// to the next handler. No-op if Sentry isn't initialized.
sentry.setupExpressErrorHandler(app);

// Global Express error handler — MUST be after all routes. Ensures every
// crash in a route handler (including synchronous throws from better-sqlite3)
// returns a JSON body with the real error, instead of HTML or a blank 500.
// Without this, the client sees only "Request failed with status code 500"
// and has no way to know what actually broke.
app.use((err, req, res, next) => {
  console.error('[express-error]', req.method, req.originalUrl, '-', err.message);
  console.error(err.stack);
  if (res.headersSent) return next(err);
  res.status(500).json({
    error: err.message || 'Internal server error',
    path: req.originalUrl,
    method: req.method,
  });
});

const serverPort = process.env.PORT || 5000;
// Wrap Express in an HTTP server so Socket.IO (real-time chat) can attach to
// it — the chat uses its own DB + this socket, separate from the rest (mam
// 2026-06-18). Falls back gracefully if the socket layer fails to start.
const httpServer = require('http').createServer(app);
try { require('./lib/chatSocket').initChatSocket(httpServer); console.log('[chat] Socket.IO ready'); }
catch (e) { console.warn('[chat] Socket.IO not started:', e.message); }
httpServer.listen(serverPort, '0.0.0.0', () => {
  console.log(`\n======================================`);
  console.log(`  Business ERP Server`);
  console.log(`  Running on port ${serverPort}`);
  console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`======================================\n`);
});
