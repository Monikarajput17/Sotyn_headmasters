# 12. Automations, Scheduled Jobs & Integrations

This section documents everything the SEPL ERP does **on its own** — the cron-style
schedulers wired up at server boot, the one-shot maintenance scripts in
`server/scripts/`, the third-party integrations (email, web-push, Twilio,
Anthropic Claude, Sentry, Excel/PDF parsing), and the unified notifications model
(in-app bell + push + email + SMS/WhatsApp).

All facts below are drawn directly from `server/index.js`, the
`server/scripts/` directory, and the integration libraries under
`server/lib/`, `server/services/`, and `server/utils/`.

---

## 12.1 How scheduling works (no node-cron)

The ERP does **not** use `node-cron` or any external scheduler. Every job uses the
same hand-rolled **drift-corrected `setTimeout` → `setInterval`** pattern:

1. On boot, compute the milliseconds until the next target local time
   (e.g. next 02:00).
2. `setTimeout` fires once at that time.
3. From inside that first run, a `setInterval(fn, 24h)` keeps it repeating daily
   (or hourly / every 30 min for the higher-frequency jobs).

The nightly backup goes one step further: it **re-chains a fresh `setTimeout`**
after each run instead of using a fixed interval, so DST / timezone shifts are
absorbed automatically each day.

Because all timers are based on **local server time** (the VPS clock), "02:00"
means 02:00 in the server's timezone. There is no UTC normalisation.

Each scheduler is wrapped in a `try/catch` in `server/index.js`, so if any one
scheduler fails to start (e.g. a missing package), the server still boots and
logs a `[<name>] Scheduler not started: <reason>` warning rather than crashing.

### Disable flags (ENV)

Every recurring job can be turned off with an `ERP_DISABLE_*` environment
variable (set to `1`). These are read at boot from `.env` or the pm2 process
env. Set them locally to keep dev machines quiet, or to pause a job in
production without a code change.

---

## 12.2 Master table — every scheduled job

| Job | Module (`server/scripts/`) | Schedule (local time) | What it does | Disable flag |
|---|---|---|---|---|
| **Nightly DB backup** | `backup-db.js` → `scheduleNightly()` | Daily **02:00** (self-rechaining) | Copies the SQLite DB to `~/erp-backups` (VPS) / `../backups` (Windows); keeps the **last 30** backups. Also exposed via `/api/admin/backups/*` for manual list/download/trigger. | `ERP_DISABLE_BACKUP_SCHEDULER` |
| **Daily audit snapshot** | `dailyAuditSnapshot.js` → `scheduleDailyAuditSnapshot()` | Daily **07:30** | Writes the `/audit` JSON into `data/audit-snapshots/<date>/` so the 09:00 CMD email and the role dashboards render from a fixed "as of this morning" file. | `ERP_DISABLE_AUDIT_SNAPSHOT` |
| **DPR auto-prompt** | `dprAutoPrompt.js` → `scheduleDprAutoPrompt()` | Daily **18:00** (Sunday off) | Notifies every site engineer who hasn't submitted today's DPR for their active site(s); sends admins a rollup when overall adherence is below 50%. | `ERP_DISABLE_DPR_PROMPT` |
| **Cash rollover** | `cashFidelityCron.js` → `scheduleCashFidelity()` | Daily **00:00** | Rolls over `cash_flow_daily` (creates the new day's row) so runway numbers don't drift on no-collection days. | `ERP_DISABLE_CASH_CRON` |
| **Receivables ageing refresh** | `cashFidelityCron.js` → `scheduleCashFidelity()` | Daily **01:00** | Recomputes receivables ageing across the board — the primary truth, replacing the manual "Refresh Ageing" button. | `ERP_DISABLE_CASH_CRON` |
| **Fire NOC auto-pilot** | `fireNocCron.js` → `scheduleFireNocCron()` | **Hourly** (first run +60s after boot) | Keeps Fire-NOC cycle stages + statuses in sync with elapsed days via `syncAllActiveCycles()`. Also runs a one-time idempotent **boot backfill** for legacy rows. | `ERP_DISABLE_FIRE_NOC_CRON` |
| **HR automations** | `hrAutomationsCron.js` → `schedule()` | **Every 30 min** (first run +10s after boot) | Scans for interview reminders (next 24h), stale offers (>7 days, not accepted/declined), and pending hiring-request approvals (>24h). Creates in-app notifications + emails HR users. Dedupe-keyed so it never spams. | `ERP_DISABLE_HR_CRON` |
| **Procurement schedule reminder** | `procurementReminderCron.js` → `scheduleProcurementReminderCron()` | Daily **09:00** (plus a +60s boot catch-up) | Scans the procurement schedule for indent rows whose `end_date` is tomorrow's business day; posts an announcement + push for each. A dedup table prevents double-posts. | `ERP_DISABLE_PROCSCH_REMINDER` |
| **Daily CMD email** | `dailyCmdEmail.js` → `scheduleDailyCmdEmail()` | Daily **09:00** | Reads the 07:30 audit snapshot (falls back to live `/audit/kpi`) and emails the director address from Admin → Email Settings. | `ERP_DISABLE_CMD_EMAIL` |
| **Fortnightly installation billing** | `installationBillingCron.js` → `scheduleInstallationBillingCron()` | Daily **08:00** check; **acts only on the 1st & 16th** (plus a +90s boot catch-up) | Auto-generates Type-3 (Against-Installation) sales bills from approved DPRs (work value × Against-Installation %). Idempotent; bills are approved but a human still clicks "Sent to Client". | `ERP_DISABLE_INSTALL_BILLING` |

### One-shot, idempotent jobs (run once on boot, then never again)

These run at boot, guard themselves with an `app_settings` flag (or a similar
marker) so they execute **exactly once** after deploy, and then become no-ops on
every subsequent restart.

| Job | Module | Purpose | Disable flag |
|---|---|---|---|
| **Item Master cleanup** | `itemMasterCleanup.js` → `runOnce()` | Corrects item-master units to market values, removes duplicates, fixes spelling. Guarded by `app_settings.item_master_cleanup_v1`. | `ERP_DISABLE_ITEM_CLEANUP` |
| **Itemwise rate import v1** | `itemwiseRateImport.js` → `runOnce()` | Reads `data/itemwise-rates-2026-06-01.json` (140 rows) → updates `item_master.current_price`. | `ERP_DISABLE_ITEM_RATE_IMPORT` |
| **Itemwise rate import v2** | `itemwiseRateImportV2.js` → `runOnce()` | Second-pass broader CSV export (2,496 rate rows). Separate `app_settings` flag. | `ERP_DISABLE_ITEM_RATE_IMPORT` (shared) |
| **Itemwise rate import v3** | `itemwiseRateImportV3.js` → `runOnce()` | Third-pass 101 daybook-matched rows from `final item.xlsx`; adds a code-ci fallback. | `ERP_DISABLE_ITEM_RATE_IMPORT` (shared) |
| **Payroll exempt backfill** | `payrollExemptBackfill.js` → `runOnce()` | Sets `employees.salary_exempt=1` for the named "always full salary" staff (Parul Goyal, Rajat Sir, Nitin Jain, Ankur Kaplesh, Pooja Kaplesh, D.S Kaplesh, Soma Kaplesh). | `ERP_DISABLE_PAYROLL_EXEMPT_BACKFILL` |
| **Fire NOC boot backfill** | `fireNocCron.js` → `backfillOnceOnBoot()` | One-time sync of 100+ legacy Fire-NOC rows stuck at `stage=CYCLE_CLOSE / status=active`. Guarded by an `app_settings` flag. | `ERP_DISABLE_FIRE_NOC_CRON` (shared with the hourly cron) |

> **Note on the shared `ERP_DISABLE_ITEM_RATE_IMPORT` flag:** setting it disables
> **all three** rate-import passes (v1, v2, v3) at once.

### Manual / admin-triggered runs

Two of the schedulers expose an admin-only "run now" endpoint so mam can verify
delivery without waiting for the cron tick (both require `role==='admin'`):

| Endpoint | Fires |
|---|---|
| `POST /api/admin/procsch-reminder/run-now` | The procurement 1-day-before reminder scan (`procurementReminderCron.runOnce()`). |
| `POST /api/admin/cmd-email/send-now` | The daily CMD summary email (`dailyCmdEmail.runOnce()`). |

The backup scheduler likewise has manual list / download / trigger endpoints
under `/api/admin/backups/*`.

---

## 12.3 The `server/scripts/` directory — full inventory

Beyond the schedulers above, `server/scripts/` holds CLI one-shots run manually
with `node server/scripts/<file>.js`. They are **not** wired into boot.

### Scheduler / boot modules (described above)

`backup-db.js`, `dailyAuditSnapshot.js`, `dprAutoPrompt.js`,
`cashFidelityCron.js`, `fireNocCron.js`, `hrAutomationsCron.js`,
`procurementReminderCron.js`, `dailyCmdEmail.js`, `installationBillingCron.js`,
`itemMasterCleanup.js`, `itemwiseRateImport.js`, `itemwiseRateImportV2.js`,
`itemwiseRateImportV3.js`, `payrollExemptBackfill.js`.

### Manual data-import / seed scripts

| Script | Purpose |
|---|---|
| `import-customers.js` | Imports customers from `customers-seed.csv` into SQLite. Run once after deploy. |
| `import-payment-targets.js` | One-shot import of 57 payment-collection target rows (mam's "Payment collection followup" sheet, 28-Apr-2026). Each becomes a receivable. |
| `import-stock-sheet.js` | One-shot importer for `db/stock_sheet_import.json` (588 opening-balance rows: location/item/qty/unit/rate) → seeds inventory. |
| `update-client-addresses.js` | One-shot: updates Business Book billing + shipping addresses from `ADDRESS.pdf` (2026-06-04). |
| `customers-seed.csv` | Seed data file consumed by `import-customers.js`. |

### Maintenance / recovery scripts

| Script | Purpose |
|---|---|
| `reset-admin-password.js` | Resets the local admin password (default `admin123`, or an arg). |
| `regenerate-emergency-code.js` | Regenerates the owner emergency recovery code; rewrites `data/RECOVERY.txt` and the `app_settings` hash. |
| `restore-business-book.js` | Surgical restore of ONE deleted Business Book order and all cascade-deleted children (sites, DPRs + work-items/manpower/machinery, attendance, po_items, planning, finance, POs, receivables, geofence) from a backup DB without overwriting current data. |
| `backfill-audit.js` | One-shot: synthesises `audit_log` CREATE rows for entries created before audit logging worked (the `ERP_DISABLE_AUDIT=1` bug period). |

### Diagnostic (read-only) scripts

| Script | Purpose |
|---|---|
| `which-order.js` | For a sales bill (delivery note), shows which Business Book order it resolves to + that order's Against-Delivery %, via both lookup paths. Changes nothing. |
| `scan-backups-for.js` | Scans every nightly backup for a Business Book order (by name keyword) and reports how much of its data survives in each — use when you don't know the deletion date. |
| `audit-po-2026-0222.js` | Diagnostic for a specific purchase order (PO 2026-0222). |
| `fix-po-2026-0222.js` | Targeted fix for the same purchase order. |

### Subfolder

`server/scripts/data/` holds supporting JSON / data fixtures used by the import
scripts.

---

## 12.4 Integrations

Each integration follows the same **graceful-degradation** contract: if its
credentials or package are missing, the helper logs a one-line warning and
returns a `{ skipped: true }` / no-op result rather than throwing — so a missing
integration never blocks the user's real work or crashes the server.

### 12.4.1 Email — SMTP / Nodemailer

- **File:** `server/lib/email.js` (package: `nodemailer`).
- **Powers:** the daily CMD audit email, HR automation emails (interview /
  offer / approval nudges), and any alert that calls `sendEmail()`.
- **Credentials:** stored in `app_settings` (Admin → **Email Settings**), **not**
  in `.env`, so mam can paste Gmail / SendGrid / Mailgun credentials inside the
  ERP. Keys:
  - `email_smtp_host`, `email_smtp_port` (default 587),
    `email_smtp_secure` (`1` = 465/TLS, blank = STARTTLS),
    `email_smtp_user`, `email_smtp_pass` (app password — never logged),
    `email_from` (display From), `email_director_to`
    (default recipient; falls back to `director@securedengineers.com`).
- **Per-rule From override:** callers may pass a `from`, used by email rules
  (2026-06-03). Note many providers (Gmail) ignore a From that isn't the
  authenticated account / a verified alias.
- **Graceful degradation:** `sendEmail()` returns `{ skipped: true, reason }`
  when host/user/pass are unset, or when `nodemailer` can't be required. It
  never throws. `isConfigured()` lets callers check first.

### 12.4.2 Web Push — VAPID / web-push

- **Files:** `server/lib/push.js` (helper) + `server/routes/push.js` (routes);
  package: `web-push`.
- **Powers:** browser/PWA push notifications for delegations, tickets,
  payments, announcements, procurement reminders, etc.
- **Credentials (VAPID keys):** **auto-generated on first boot** by
  `ensureVapid()` and persisted in `app_settings`
  (`vapid_public_key` / `vapid_private_key`) so pm2 restarts don't invalidate
  every device's subscription. The VAPID subject defaults to
  `mailto:admin@securedengineers.com` (overridable via `VAPID_SUBJECT`).
  `server/index.js` calls `ensureVapid()` on boot.
- **Routes (`/api/push`):** `GET /vapid` (public key), `POST /subscribe`,
  `POST /unsubscribe`, `GET /devices`, `POST /test`, `POST /broadcast`
  (admin-only).
- **Subscription hygiene:** a send that returns 404/410 (expired) auto-sets that
  subscription's `active=0`.
- **Fan-out helpers:** `pushToUser`, `pushToUsers`, `pushToAll`, plus
  fire-and-forget wrappers `notify` / `notifyMany` / `notifyAll` (via
  `setImmediate`, so a push failure can never block or break a route).

### 12.4.3 SMS & WhatsApp — Twilio

There are **two distinct WhatsApp paths**, which is important to understand:

**(a) Live Twilio (SMS + WhatsApp)** — `server/services/notify.js`
(package: `twilio`).

- **Powers:** the "complaint registered" confirmation to the customer
  (`sendComplaintRegistered`) and ad-hoc one-off notices (`sendText`, e.g.
  procurement receiving-mismatch alerts). Both fire **WhatsApp + SMS in
  parallel**.
- **Credentials (ENV / pm2 env):**
  - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (client),
  - `TWILIO_WHATSAPP_FROM` (WhatsApp sender),
  - `TWILIO_SMS_FROM` (SMS sender).
- **Graceful degradation:** the Twilio client is lazy-loaded. If credentials are
  missing or the `twilio` package isn't installed, it warns **once** and returns
  `{ skipped: true, reason: 'twilio_unavailable' }`. Per-channel sends that lack
  a `From` return `{ skipped: true }`. Indian numbers are normalised to E.164
  (`toE164`, defaulting to `+91`); invalid numbers skip cleanly. The module
  **never throws** — callers don't need try/catch.

**(b) WhatsApp click-to-send deep links** — `server/utils/whatsapp.js`
(no API, no credentials).

- **Powers:** the Complaints flow's three messages (registration ack to client,
  assignment notice to engineer, assignment + OTP to client) as `wa.me`
  click-to-send links that mam (or her EA) clicks to fire from her **own**
  WhatsApp.
- It also centralises the message templates and a guessing-resistant 4-digit
  resolution OTP generator (`generateOtp`).
- The file notes that once a Business WhatsApp API is provisioned, callers can
  swap `whatsappLink()` for an `await sendWhatsapp()` in one place.

### 12.4.4 AI — Anthropic Claude SDK

- **File:** `server/routes/aiAgent.js` (and OCR/invoice flows); package:
  `@anthropic-ai/sdk`.
- **Powers:** the in-ERP AI agent and document understanding (e.g. uploading a
  vendor invoice PDF/image for extraction — the agent supports vision/OCR
  inputs). Anthropic/Claude imports also appear across procurement, orders, HR,
  quotations, influencers, procurement-schedule, price-requests, fire-noc,
  customers and resume parsing flows.
- **Credentials:** stored in `app_settings` (Admin → AI Settings), **not** env:
  - `ai_api_key` (secret; server-side only, **masked** on GET),
  - `ai_provider` (default `anthropic`),
  - `ai_model` (default `claude-opus-4-7`).
- **Behaviour:** the client is built per-call as
  `new Anthropic.default({ apiKey, timeout })` with a 150s timeout
  (`ANTHROPIC_TIMEOUT_MS`). Adaptive/extended features are enabled only for
  models matching `claude-(opus-4-[67]|sonnet-4-6)`.
- **Graceful degradation:** if `ai_api_key` isn't set, AI endpoints return a
  "not configured" response; `GET` config reports `{ configured: false }`.

### 12.4.5 Error monitoring — Sentry

- **File:** `server/lib/sentry.js` (package: `@sentry/node` v8).
- **Powers:** backend error monitoring. It is required as the **very first line**
  of `server/index.js` so v8 auto-instrumentation can hook Express/route files.
  `process.on('uncaughtException')` and `unhandledRejection` handlers forward to
  `sentry.captureException`, and `setupExpressErrorHandler(app)` is wired at the
  end of the middleware chain.
- **Credentials (ENV / pm2 env):**
  - `SENTRY_DSN` (activates the integration; without it the module is a
    complete no-op),
  - `SENTRY_TRACES_SAMPLE_RATE` (default 0.1 = 10%),
  - `SENTRY_RELEASE` (optional, e.g. git SHA),
  - `NODE_ENV` (used as the environment tag).
- **Privacy:** a `beforeSend` hook strips `authorization` / `cookie` /
  `x-auth-token` headers, the request body, and cookies before any event leaves
  the server — Sentry never sees passwords or JWTs. The DSN secret is masked in
  the boot log.

### 12.4.6 File parsing & spreadsheets

| Library | Used for |
|---|---|
| `xlsx` | Excel import/export — itemwise rate imports, stock-sheet seeding, and various route-level Excel parsing/export. |
| `pdf-parse` | Text extraction from PDFs — resume parsing (`utils/resumeParser.js`) and PDF-sourced imports. |
| `mammoth` | DOCX → text extraction for resume parsing. |
| `multer` | Multipart file uploads. Disk storage under `data/uploads/`, **20 MB** per-file limit, sanitised filenames. Served read-only at `/uploads`; upload via `POST /api/upload`. |

- **Resume parser** (`utils/resumeParser.js`): best-effort extraction of
  name / email / phone / address / LinkedIn from a candidate's PDF
  (`pdf-parse`) / DOCX (`mammoth`) / TXT, returning per-field nulls when not
  confidently detected. Powers HR auto-fill on resume upload.

### 12.4.7 Other libraries (HTTP / perf)

- `compression` — gzip on all responses (lazy-required; warns if absent, server
  still boots).
- `cors`, `express`, `better-sqlite3`, `bcryptjs`, `jsonwebtoken`, `dotenv` —
  core stack (not "integrations" but listed for completeness of the dependency
  surface).

---

## 12.5 Notifications model

The ERP delivers a notification through up to **four** channels, layered so that
the loss of any single channel still leaves the user informed.

| Layer | Mechanism | Where it lives | Reaches |
|---|---|---|---|
| **In-app bell / notifications** | Notification rows inserted into the DB (with `dedupe_key`), shown in the app bell | HR cron, schedulers, route handlers | Logged-in users |
| **Announcements** | `announcements` table + `/api/announcements`; pushed for broadcasts | Procurement reminder cron, admin posts | All / targeted users |
| **Web push** | `server/lib/push.js` (`notify` / `notifyMany` / `notifyAll`) | Any route or cron | Subscribed browsers/PWAs |
| **Email** | `server/lib/email.js` (`sendEmail`) | CMD email, HR cron | SMTP recipients |
| **SMS + WhatsApp** | `server/services/notify.js` (Twilio) and `server/utils/whatsapp.js` (wa.me links) | Complaints, ad-hoc alerts | Customers / engineers on mobile |

### Design principles

- **Dedupe everywhere.** The HR cron uses `dedupe_key`s
  (`interview_reminder:<candidate>:<date>`, `offer_expiry:<candidate>`,
  `approval_pending:<request>`); the procurement reminder uses a dedup table.
  This makes re-running a cron (e.g. after a boot catch-up) safe — no spam.
- **Fire-and-forget.** Push uses `setImmediate` wrappers that never throw, so a
  notification failure cannot break the user action that triggered it.
- **Layered fallback.** A single event commonly creates an in-app notification
  **and** sends an email/push — if SMTP or push isn't configured, the in-app row
  still records it.
- **Skip-not-fail.** Email, Twilio, push and AI all return a `{ skipped }`-style
  result when unconfigured, so an under-configured environment (local dev, fresh
  deploy) keeps functioning.

---

## 12.6 Where credentials live — quick reference

| Integration | Credential location |
|---|---|
| SMTP (email) | `app_settings` via **Admin → Email Settings** |
| Web Push (VAPID) | `app_settings` (auto-generated on first boot); `VAPID_SUBJECT` optional in env |
| Twilio (SMS/WhatsApp) | **ENV / pm2 env** — `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `TWILIO_SMS_FROM` |
| Anthropic Claude (AI) | `app_settings` via **Admin → AI Settings** (`ai_api_key`, `ai_provider`, `ai_model`) |
| Sentry | **ENV / pm2 env** — `SENTRY_DSN` (+ optional `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_RELEASE`) |
| Audit API token | **ENV / pm2 env** — `AUDIT_API_TOKEN` (`pm2 set ERP:AUDIT_API_TOKEN <token>`); `/audit` returns 503 without it |
| Cron disable flags | **ENV / pm2 env** — `ERP_DISABLE_*` (see §12.2) |

> **Rule of thumb:** mam-managed, rotatable credentials (SMTP, AI key) live in the
> ERP's own Admin settings (`app_settings`) so they can be changed without a
> redeploy. Infrastructure-level credentials (Twilio, Sentry, audit token) and
> all cron toggles live in the server environment / pm2 config.
