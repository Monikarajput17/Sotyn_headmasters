# 13. Technical Reference

This section is the engineering reference for the SEPL Business ERP. It documents
the runtime architecture, technology stack, repository layout, the persisted data
model, how to build and run the app locally, how it is deployed to the Hostinger
VPS, and the security model. Every fact below was verified against the source
(package manifests, `server/index.js`, `server/db/schema.js`, the deployment
scripts, and the React entry points) — nothing here is aspirational.

---

## 13.1 High-Level Architecture

The ERP is a classic three-tier application packaged as a **single Node process
that serves both the API and the compiled front-end**. There is no separate
application server, no container orchestration, and no external database server —
the entire datastore is a single SQLite file on disk.

```
                          HTTPS (Let's Encrypt)
   ┌──────────────┐        :443                 ┌────────────────────────────┐
   │   Browser /  │  ───────────────────────▶   │   Nginx (reverse proxy)    │
   │  iOS/Android │  ◀───────────────────────   │   securederp.in            │
   │   PWA shell  │                             │   proxy_pass → :5000        │
   └──────────────┘                             └─────────────┬──────────────┘
        React SPA                                             │ HTTP :5000
   (Vite build, served                                        ▼
    as static files)                            ┌────────────────────────────┐
                                                │   Node / Express process    │
                                                │   (managed by PM2 "erp")    │
                                                │                            │
                                                │  • CORS + gzip + JSON body  │
                                                │  • JWT auth middleware      │
                                                │  • Audit middleware         │
                                                │  • ~56 route routers        │
                                                │  • Static serve client/dist │
                                                │  • Cron schedulers (in-proc)│
                                                └─────────────┬──────────────┘
                                                              │ better-sqlite3
                                                              ▼
                                                ┌────────────────────────────┐
                                                │   data/erp.db (SQLite file) │
                                                │   ~150 tables, synchronous  │
                                                │   in-process reads/writes   │
                                                └────────────────────────────┘
```

Key architectural properties:

- **Client SPA ⇄ Express API ⇄ better-sqlite3 file DB.** The React single-page
  app talks only to `/api/*` (and the special `/audit` endpoint) over JSON. The
  Express layer is the only thing that touches the database.
- **One process, two responsibilities.** In production the same Express process
  both answers API calls and serves the Vite build from `client/dist`. If the
  build is missing it falls back to "API only mode".
- **Synchronous database access.** `better-sqlite3` is a synchronous, in-process
  driver. There is no connection pool and no network round-trip to the DB; a
  query is a direct function call against the embedded SQLite engine. This keeps
  the code simple (no async DB plumbing) at the cost of being single-machine.
- **In-process schedulers.** All background jobs (nightly backup, audit
  snapshot, DPR prompts, cash-fidelity rollovers, HR automations, procurement
  reminders, the CMD email, fortnightly installation billing, Fire-NOC autopilot)
  are cron-style timers started inside `server/index.js` on boot. There is no
  separate worker process — PM2 keeps the single process alive and the timers
  run within it.
- **PWA front-end.** The client ships a service worker and a web-app manifest so
  it installs to a phone home screen and can receive Web Push notifications even
  when the tab is closed.

### Request lifecycle

1. Browser sends `GET/POST /api/...` with an `Authorization: Bearer <JWT>` header.
2. Express applies CORS, gzip compression, a 10 MB JSON body parser, and static
   cache headers.
3. The audit middleware registers a response-finish hook (fire-and-forget) so any
   mutating request is logged after it completes.
4. The matching router runs its own `authMiddleware`, which verifies the JWT and
   sets `req.user`. Sliding-session logic may attach a fresh token via the
   `X-Refresh-Token` response header.
5. The handler reads/writes `data/erp.db` synchronously through `better-sqlite3`
   and returns JSON.
6. A global Express error handler catches any thrown error (including synchronous
   SQLite throws) and returns a structured JSON error body instead of HTML.

---

## 13.2 Technology Stack

| Layer | Technology | Version (declared) | Notes |
|-------|-----------|--------------------|-------|
| Runtime | Node.js | `>=18.0.0` (VPS installs Node 20) | Single process, `engines` enforced in root `package.json`. |
| Web framework | Express | `^4.19.2` | Route routers mounted under `/api/*`; one special `/audit` mount. |
| Database | SQLite via **better-sqlite3** | `^11.0.0` | Synchronous, embedded; file at `data/erp.db`. |
| Auth | jsonwebtoken + bcryptjs | `^9.0.2` / `^2.4.3` | JWT bearer tokens (7-day sliding); bcrypt password hashing (cost 10). |
| Compression | compression (gzip) | `^1.7.4` | Enabled globally; 60–80% smaller JSON. |
| CORS | cors | `^2.8.5` | Open in dev (`*`), locked (`origin:false`) in production behind Nginx. |
| File uploads | multer | `^1.4.5-lts.1` | Disk storage to `data/uploads`, 20 MB limit. |
| Error monitoring | @sentry/node + @sentry/react | `^8.45.0` | Activated only when `SENTRY_DSN` is set; strips auth/cookies/body before send. |
| Web Push | web-push | `^3.6.7` | VAPID keys auto-generated and persisted in `app_settings`. |
| Email | nodemailer | `^8.0.7` | SMTP notifications (HR automations, CMD daily email). |
| WhatsApp / SMS | twilio | `^6.0.2` | Optional complaint-registration notifications (disabled if creds blank). |
| Document parsing | mammoth, pdf-parse, xlsx | — | Resume/BOQ/Excel ingestion and CSV/XLSX import-export. |
| AI | @anthropic-ai/sdk | `^0.40.1` | Backs the `/api/ai-agent` route. |
| Env config | dotenv | `^16.4.5` | Loads `.env` at boot. |
| Dev orchestration | concurrently | `^8.2.2` | Runs server + client together via `npm run dev`. |

### Front-end stack

| Layer | Technology | Version (declared) | Notes |
|-------|-----------|--------------------|-------|
| UI library | React + React DOM | `^19.2.4` | Function components + hooks. |
| Build tool | Vite | `^5.4.21` | Dev server on port 3000, proxies `/api` → `localhost:5000`. |
| Router | react-router-dom | `^7.14.0` | `ProtectedRoute` / `AdminRoute` / `ModuleRoute` guards. |
| Styling | Tailwind CSS + @tailwindcss/forms | `^3.4.19` | PostCSS + autoprefixer pipeline. |
| HTTP client | axios | `^1.15.0` | Single wrapper in `client/src/api.js` with auth + refresh interceptors. |
| Charts | recharts | `^3.8.1` | Dashboard analytics. |
| Maps | leaflet | `^1.9.4` | Geofence / attendance location views. |
| QR scanning | html5-qrcode | `^2.3.8` | Asset / tool scanning. |
| Toasts | react-hot-toast | `^2.6.0` | In-app notifications. |
| Icons | react-icons | `^5.6.0` | — |
| Error monitoring | @sentry/react | `^8.45.0` | Front-end crash reporting. |
| Linting | eslint (+ react-hooks / react-refresh plugins) | `^9.39.4` | `npm run lint` in `client/`. |

A `__BUILD_STAMP__` constant is injected at build time by `vite.config.js`
(`MM-DD HH:MM`) so a header badge reveals exactly which bundle a given phone is
running — this exists to defeat stale-PWA-cache confusion.

---

## 13.3 Repository Layout

```
business-erp/
├── package.json                # Root: backend deps + npm scripts (dev/server/build)
├── package-lock.json
├── render.yaml                 # Render.com blueprint (alternative host)
├── deploy-vps.sh               # One-shot Hostinger VPS provisioning script
├── health-check.sh             # Post-deploy endpoint smoke test
├── .env.example                # Sample environment file
├── .gitignore                  # Ignores node_modules, /data, .env, client/dist
├── ERP-AUTOMATION-AUDIT.md     # Project docs / audit notes (Markdown)
├── INDENT-TO-DISPATCH*.md      # Procurement process docs
├── SALES-BILLING-MODULE.md     # Sales billing design doc
├── data/                       # (gitignored) runtime: erp.db, uploads, snapshots
├── backups/                    # (gitignored) DB backups on Windows dev box
├── docs/sections/              # This documentation set
│
├── server/                     # ── Express backend ──────────────────────────
│   ├── index.js                # App entry: middleware, route mounts, cron, static
│   ├── erp.db                  # (stray dev copy; canonical DB lives in data/)
│   ├── db/
│   │   ├── schema.js           # ~5,300-line schema: all CREATE TABLE + migrations
│   │   ├── fireNocSchema.js    # Fire-NOC tables (split out)
│   │   ├── rentalToolsSchema.js# Rental-tools tables (split out)
│   │   ├── nextSequence.js     # Document-number sequence generator
│   │   ├── seedScoring.js      # Seeds 20 MIS scorecard templates
│   │   ├── import-bb.js        # Business Book CSV importer
│   │   ├── import-vendors.js   # Vendor importer
│   │   ├── items_seed.json     # Item-master seed data
│   │   ├── vendors_import.json # Vendor seed data
│   │   ├── bb_import.json      # Business Book seed data
│   │   ├── labourRatesSeed.json# Labour-rate seed data
│   │   ├── poFocSeed.json      # PO free-of-cost seed data
│   │   └── stock_sheet_import.json # Opening-stock seed data
│   ├── routes/                 # ~56 Express routers (one per domain area)
│   ├── middleware/
│   │   ├── auth.js             # JWT verify, adminOnly, requirePermission factory
│   │   └── audit.js            # Mutating-request audit logger
│   ├── lib/                    # Cross-cutting helpers
│   │   ├── sentry.js           # Backend Sentry init (no-op without DSN)
│   │   ├── push.js             # Web Push / VAPID management
│   │   ├── email.js            # Nodemailer transport
│   │   ├── emailRules.js       # Rule-based email routing
│   │   ├── emailEvents.js
│   │   ├── businessHours.js    # Working-day / cutoff helpers
│   │   ├── cashSync.js         # Cash-flow recompute helpers
│   │   └── fireNocSync.js
│   ├── services/
│   │   └── notify.js           # Unified in-app/push/WhatsApp notification fan-out
│   ├── utils/
│   │   ├── cmdDashboard.js     # CMD audit dashboard aggregation
│   │   ├── duplicateGuard.js   # Idempotency / dedup helpers
│   │   ├── resumeParser.js     # CV parsing (mammoth/pdf-parse)
│   │   ├── validate.js         # Shared input validation
│   │   └── whatsapp.js         # Twilio WhatsApp wrapper
│   └── scripts/                # ~28 cron jobs + one-shot migrations/backfills
│
└── client/                     # ── React front-end ──────────────────────────
    ├── package.json            # Front-end deps + scripts (dev/build/lint/preview)
    ├── vite.config.js          # Vite config + build stamp + /api dev proxy
    ├── tailwind.config.js
    ├── postcss.config.js
    ├── eslint.config.js
    ├── index.html              # SPA shell
    ├── dist/                   # (gitignored) production build output
    ├── public/
    │   ├── manifest.json       # PWA manifest (standalone, theme color)
    │   ├── sw.js               # Service worker (push receive + click routing)
    │   ├── icon.svg / icons.svg / favicon.svg
    │   └── sepl-logo.webp
    └── src/
        ├── main.jsx            # React root / providers mount
        ├── App.jsx             # Router + route guards (Protected/Admin/Module)
        ├── api.js              # axios instance + auth + token-refresh interceptors
        ├── sentry.js           # Front-end Sentry init
        ├── index.css           # Tailwind entry
        ├── context/
        │   └── AuthContext.jsx # Auth state, permissions, live-refresh on focus
        ├── pages/              # ~72 page-level screens (one per module/view)
        ├── components/         # ~25 shared UI components
        ├── hooks/
        │   ├── useDraggableFab.js
        │   └── useUrlTab.js
        ├── lib/
        │   └── push.js         # Client push-subscription helper
        ├── utils/
        │   ├── compressImage.js
        │   ├── dateIST.js      # IST date formatting
        │   ├── exportCsv.js
        │   └── numberToWords.js# Amount-in-words for printed documents
        ├── assets/
        └── data/
```

---

## 13.4 Data Model

All persistent state lives in a single SQLite database at `data/erp.db`
(`DB_PATH = path.join(__dirname, '..', '..', 'data', 'erp.db')`). The schema is
created and migrated by `server/db/schema.js` on every boot — `CREATE TABLE IF NOT
EXISTS` statements are idempotent, and the file also contains numerous guarded
ALTER/rebuild migrations (the `*_new` tables seen below are intermediate
rebuild targets used by migrations, not steady-state tables). Two domains have
their schema split into separate files: Fire-NOC (`fireNocSchema.js`) and
rental-tools (`rentalToolsSchema.js`).

The tables below are grouped by business domain. Names are taken verbatim from the
`CREATE TABLE` statements in `schema.js`.

### Identity, Access & Audit

| Table | Purpose |
|-------|---------|
| `users` | Application user accounts (bcrypt password hash, role, department). |
| `roles` | Named roles. |
| `role_permissions` | Per-module CRUD/approve/see-all flags for each role. |
| `user_roles` | Many-to-many user↔role assignment. |
| `delegations` | Temporary authority hand-offs between users. |
| `audit_log` | Append-only record of every mutating API request. |
| `activity_log` | General activity/event trail. |
| `app_settings` | Key/value app config (VAPID keys, migration flags, SMTP). |
| `notifications` | In-app notification feed. |
| `push_subscriptions` | Web Push endpoints per device. |
| `announcements` / `announcement_reads` | Broadcast messages + read receipts. |

### CRM — Leads, Funnel & Quotations

| Table | Purpose |
|-------|---------|
| `leads` | Inbound enquiries / prospects. |
| `lead_sources` | Lookup of lead origin channels. |
| `lead_followups` | Scheduled follow-up actions on leads. |
| `meetings` | Logged client meetings. |
| `sales_funnel` | Opportunity pipeline rows with stage/value. |
| `sales_funnel_audit` | Stage-change history for the funnel. |
| `sales_funnel_boqs` | BOQs attached to funnel opportunities. |
| `crm_funnel` | CRM-side funnel view. |
| `boq` / `boq_items` | Bill-of-Quantities header and line items. |
| `quotations` | Customer quotations. |
| `estimate_quotations` | Internal cost estimates feeding quotations. |
| `support_tickets` / `support_tickets_new` | Support/enquiry tickets (rebuild target). |

### Orders & Business Book (Projects)

| Table | Purpose |
|-------|---------|
| `business_book` | Master record of awarded projects/orders (client, PO, value). |
| `order_planning` | Planning data per order. |
| `customers` | Client master. |
| `proj_projects` | Project register for the Projects module. |
| `proj_budgets` | Per-project budget lines. |
| `proj_work_orders` | Work orders issued under a project. |
| `proj_salary_entries` | Project-charged salary entries. |
| `proj_daily_wage_entries` | Daily-wage labour entries. |
| `proj_muster_roll` | Attendance muster roll for project labour. |
| `proj_mb_sheets` / `proj_mb_lines` | Measurement-book sheets and lines. |
| `proj_contractor_ra_bills` / `proj_contractor_ra_deductions` | Contractor RA bills + deductions. |
| `proj_client_ra_bills` / `proj_client_ra_deductions` | Client RA bills + deductions. |
| `project_finance` | Project-level finance summary. |

### Procurement — Indents, Vendors, POs, GRN

| Table | Purpose |
|-------|---------|
| `indents` / `indents_new` | Material indents (rebuild target). |
| `indent_items` | Indent line items. |
| `indent_item_rates` | Quoted rates per indent item. |
| `indent_tracker` | Indent lifecycle tracking. |
| `vendors` | Vendor/supplier master. |
| `vendor_rates` | Vendor price lists. |
| `vendor_pos` / `vendor_po_items` | Vendor purchase orders + lines. |
| `purchase_orders` / `po_items` | Purchase order header + lines. |
| `po_foc_entries` | Free-of-cost PO entries. |
| `purchase_bills` | Vendor purchase bills. |
| `grn` / `grn_items` | Goods-Receipt-Note header + lines. |
| `procurement_schedule` (built via schema/migrations) | Procurement timeline; drives 1-day-before reminders. |
| `labour_payment_indents` | Labour-payment indents raised against a site/sub-contractor. |

### Items, Inventory & Stock

| Table | Purpose |
|-------|---------|
| `item_master` | Item/SKU catalogue with current price. |
| `item_price_history` | Historical price changes per item. |
| `pipe_weights` | Editable pipe weight master (MTR↔KG conversion). |
| `price_requests` | Requests for a price/rate to be filled. |
| `warehouses` | Stock locations. |
| `stock_balance` | Current on-hand quantity per item/warehouse. |
| `stock_movements` | Stock in/out ledger. |
| `stock_issue_notes` | Material issue notes. |
| `tools` / `tool_movements` | Tool register and check-in/out movements. |
| `tools_list_submissions` | Submitted site tool lists. |
| `company_assets` / `company_asset_movements` | Fixed-asset register + transfers. |
| `labour_rates` | Labour rate master (SITC-derived). |

### Sales Billing, Delivery & Receivables

| Table | Purpose |
|-------|---------|
| `sales_bills` / `sales_bill_items` | Customer sales bills (4 sequential types) + lines. |
| `sales_bill_status_log` | Status transitions for sales bills. |
| `debit_notes` | Debit notes against bills. |
| `delivery_notes` | Goods delivery/dispatch notes. |
| `installations` | Installation records. |
| `installation_bills` | Installation-stage bills. |
| `ra_bills` / `mb_bills` | Running-account and measurement-book bills. |
| `testing_commissioning` | T&C records. |
| `handover_certificates` | Project handover certificates. |
| `receivables` | Outstanding receivable ledger (with ageing). |
| `collections` | Cash/cheque collection records. |
| `collection_follow_ups` | Follow-up actions on overdue receivables. |
| `cheques` / `cheque_actions` | Cheque register + lifecycle actions. |
| `payments` | Payment records. |

### Finance — Cash Flow, Payments & Statutory

| Table | Purpose |
|-------|---------|
| `cash_flow_daily` | Daily cash position / runway rollover. |
| `cash_flow_entries` | Individual cash-flow line items. |
| `payment_requests` / `payment_requests_new` | Outbound payment requests (rebuild target). |
| `payment_approvals` | L1→L2→L3→Release approval trail for payment requests. |
| `expenses` | Expense claims/records. |
| `statutory_dues_calendar` | Statutory due-date calendar (GST/TDS etc.). |

### HR, Recruitment & Payroll

| Table | Purpose |
|-------|---------|
| `employees` | Employee master (salary, exemption flags). |
| `sub_contractors` | Sub-contractor master. |
| `candidates` | Recruitment candidates. |
| `candidate_docs` / `candidate_events` | Candidate documents and event timeline. |
| `hiring_requests` | Headcount/hiring requisitions. |
| `jd_templates` / `job_descriptions` | JD templates and concrete JDs. |
| `screening_questions` / `screening_answers` | Screening Q&A. |
| `interview_scorecards` | Interview evaluation scorecards. |
| `final_round_questions` | Final-round interview questions. |
| `induction_items` | New-joiner induction checklist. |
| `training_videos` / `training_assignments` | Training content + assignments. |
| `attendance` / `attendance_new` | Daily attendance (rebuild target). |
| `geofence_settings` | Geofence radius/config for attendance. |
| `location_tracking` | Field-staff GPS pings. |
| `leave_requests` / `leave_requests_new` | Leave applications (rebuild target). |
| `payroll_settings` | Payroll rules/config. |
| `payroll_runs` | Monthly payroll runs. |
| `payroll_advances` | Salary advances. |
| `manpower_required_overrides` | Manual overrides to required-manpower slab. |
| `manpower_project_settings` | Per-project manpower assumptions. |

### Site Execution — DPR & Sites

| Table | Purpose |
|-------|---------|
| `sites` | Active project sites. |
| `dpr` | Daily Progress Report header. |
| `dpr_work_items` | Work items completed per DPR. |
| `dpr_manpower` | Manpower deployed per DPR. |
| `dpr_material` | Material consumed per DPR. |
| `dpr_machinery` | Machinery used per DPR. |
| `dpr_contractors` | Sub-contractor lines per DPR. |

### Performance, Complaints, Rentals & Misc

| Table | Purpose |
|-------|---------|
| `score_templates` / `score_kpis` | MIS scorecard templates and their KPIs. |
| `score_user_template` / `score_user_kpi_target` | Per-user scorecard assignment + targets. |
| `score_entries` | Recorded KPI scores. |
| `complaints` | Customer complaints (with WhatsApp/SMS on register). |
| `snags` | Snag-list defects. |
| `checklists` / `checklist_completions` | Checklist definitions + completions. |
| `pms_tasks` | Project-management tasks. |
| `rental_properties` / `rental_rooms` / `rental_bookings` | Rental accommodation register. |
| `rent_requests` / `rental_payments` | Rent requests and payments. |
| `email_rules` | Configurable email routing rules. |

> Migration scaffolding note: tables ending in `_new` (`indents_new`,
> `attendance_new`, `leave_requests_new`, `support_tickets_new`,
> `payment_requests_new`) are temporary rebuild targets created inside guarded
> migrations in `schema.js` — they are renamed into place, not kept as
> independent tables.

### Seed & import data

On first boot the schema/seed code loads JSON fixtures from `server/db/`:

| File | Loaded into |
|------|-------------|
| `items_seed.json` | `item_master` opening catalogue. |
| `vendors_import.json` | `vendors` master. |
| `bb_import.json` | `business_book` projects. |
| `labourRatesSeed.json` | `labour_rates`. |
| `poFocSeed.json` | `po_foc_entries`. |
| `stock_sheet_import.json` | opening stock balances. |
| `seedScoring.js` | 20 MIS scorecard templates (`score_templates`/`score_kpis`). |

All seeders are idempotent: re-running when rows already exist is a no-op.

---

## 13.5 Build & Run

All scripts are declared in the **root** `package.json` unless noted.

| Command | What it does |
|---------|--------------|
| `npm run dev` | Runs backend + front-end together via `concurrently` (server on :5000, Vite on :3000). The recommended local-dev command. |
| `npm run server` | Backend only — `node server/index.js` (also the `start` script). |
| `npm run client` | Front-end only — `cd client && npm run dev` (Vite dev server). |
| `npm run build` | Builds the front-end: `cd client && npm install && npm run build` → emits `client/dist`. |
| `npm run install-all` | Installs root + client dependencies. |
| `npm start` | Production start — `node server/index.js`. |
| `postinstall` | Automatically runs `npm run build` after `npm install` so a fresh deploy always has a current bundle. |

Inside `client/` (`client/package.json`):

| Command | What it does |
|---------|--------------|
| `npm run dev` | Vite dev server (port 3000, proxies `/api` → `localhost:5000`). |
| `npm run build` | Production Vite build into `client/dist`. |
| `npm run preview` | Serves the built bundle locally. |
| `npm run lint` | ESLint over the client source. |

### Local development flow

1. `npm run install-all` (first time only).
2. Copy `.env.example` → `.env` and set at minimum `PORT`, `JWT_SECRET`,
   `NODE_ENV=development`.
3. `npm run dev`.
4. Open `http://localhost:3000` (Vite proxies API calls to the backend on :5000).

In **development** the backend serves API only and Vite serves the SPA with its
proxy. In **production** the backend serves the SPA from `client/dist` itself and
Vite is not involved. The DB file and `data/uploads` are created automatically on
first boot if absent. Several dev-only `ERP_DISABLE_*` env flags turn off the
in-process schedulers (see operations below).

---

## 13.6 Deployment & Operations

### Hosting

Production runs on a **Hostinger VPS** behind **Nginx** at `securederp.in`, with
the Node process supervised by **PM2** under the name `erp`. A `render.yaml`
blueprint also exists as an alternative one-click Render.com deployment, but the
VPS is the live environment.

### Initial provisioning (`deploy-vps.sh`)

`deploy-vps.sh` is the one-shot bootstrap run as root on a fresh VPS. It:

1. Updates the OS and installs **Node.js 20**, build tools (`build-essential`,
   `python3`, `git`) and **Nginx**.
2. Installs **PM2** globally.
3. Clones the repo to `/root/erp`, runs `npm install`, then builds the front-end
   (`cd client && npm install && npm run build`).
4. Writes a production `.env` (`PORT=5000`, `JWT_SECRET`, `NODE_ENV=production`).
5. Starts the app with `pm2 start server/index.js --name erp`, then `pm2 save`
   and `pm2 startup` so it survives reboots.
6. Configures Nginx as a reverse proxy for `securederp.in` →
   `http://localhost:5000` with a 20 MB `client_max_body_size`.
7. Provisions free HTTPS via **Let's Encrypt / certbot** with auto-renewal.

### Routine deploy flow

For day-to-day releases the flow is **push to `main` → SSH to the VPS → pull,
rebuild, restart**:

```
# locally
git push origin main

# on the VPS
cd /root/erp
git pull
npm install            # postinstall rebuilds client/dist
pm2 restart erp
```

Because `client/dist` is gitignored, the front-end is rebuilt on the server (the
`postinstall` hook handles this). Content-hashed asset filenames plus the
no-cache headers on `index.html` (set in `server/index.js`) ensure browsers and
the PWA pick up the new bundle on next load rather than serving a stale cache.

### PM2

The single process is supervised by PM2 (`erp`). PM2 restarts the process on
crash; `uncaughtException` / `unhandledRejection` handlers in `index.js` forward
the stack trace to Sentry (and the console) before PM2 cycles the process so
crashes are not lost silently. Logs are viewable with `pm2 logs erp`. Some
per-environment secrets are set directly in PM2 (e.g.
`pm2 set ERP:AUDIT_API_TOKEN <token>`).

### Background jobs / schedulers

All of the following start inside `server/index.js` on boot and run in-process
(each can be disabled with the noted env flag for dev):

| Job | Schedule | Disable flag |
|-----|----------|--------------|
| Nightly DB backup (keeps last 30) | 02:00 daily | `ERP_DISABLE_BACKUP_SCHEDULER` |
| Audit JSON snapshot | 07:30 daily | `ERP_DISABLE_AUDIT_SNAPSHOT` |
| DPR auto-prompt to site engineers | 18:00 daily (Sun off) | `ERP_DISABLE_DPR_PROMPT` |
| Cash-fidelity rollover + ageing recompute | 00:00 / 01:00 daily | `ERP_DISABLE_CASH_CRON` |
| Fire-NOC autopilot | hourly (+ boot backfill) | `ERP_DISABLE_FIRE_NOC_CRON` |
| HR automations (reminders/offers/approvals) | every 30 min | `ERP_DISABLE_HR_CRON` |
| Procurement 1-day-before reminder | weekdays 09:00 | `ERP_DISABLE_PROCSCH_REMINDER` |
| Daily CMD audit email | 09:00 daily (Sun off) | `ERP_DISABLE_CMD_EMAIL` |
| Fortnightly installation billing (Type-3) | 1st & 16th | `ERP_DISABLE_INSTALL_BILLING` |

Backups are written to `~/erp-backups` on the VPS (or `../backups` on Windows)
and are also listable/downloadable/triggerable by an admin via
`/api/admin/backups/*`.

### Health check & monitoring

- `health-check.sh` logs in with an admin account, obtains a JWT, then hits a
  fixed list of monitored endpoints, printing a pass/fail per route (treating
  `200` and `403` as healthy). Run it after a deploy or whenever someone reports
  an outage: `bash /root/erp/health-check.sh`.
- `GET /api/health` returns `{status:'ok', timestamp}` for uptime monitors.
- **Sentry** captures backend and front-end exceptions when `SENTRY_DSN` is
  configured; it scrubs auth headers, cookies and request bodies before sending.
- The `/audit` endpoint (note: not under `/api`) exposes KPI tiles and exception
  lists for an external scheduler; it requires the `AUDIT_API_TOKEN` bearer token
  (or `?token=`) and returns `503` if the token is unset.

### Environment variables

From `.env.example` plus variables consumed in code (`server/index.js`,
`lib/sentry.js`, `lib/push.js`, `middleware/auth.js`, `routes/auditReport.js`):

| Variable | Configures |
|----------|-----------|
| `PORT` | HTTP listen port (default `5000`). |
| `NODE_ENV` | `production` locks CORS and enables static SPA serving. |
| `JWT_SECRET` | Signing secret for JWT auth tokens. **Must be changed from the sample.** |
| `AUDIT_API_TOKEN` | Bearer token guarding the `/audit` reporting endpoint. |
| `SENTRY_DSN` | Enables Sentry error monitoring (no-op if unset). |
| `SENTRY_TRACES_SAMPLE_RATE` | Sentry trace sampling (default `0.1`). |
| `SENTRY_RELEASE` | Optional release tag (e.g. git SHA). |
| `VAPID_SUBJECT` | Contact `mailto:` for Web Push (default `admin@securedengineers.com`). VAPID key pair itself is auto-generated and stored in `app_settings`. |
| `TWILIO_ACCOUNT_SID` | Twilio account SID for WhatsApp/SMS (blank = channel off). |
| `TWILIO_AUTH_TOKEN` | Twilio auth token. |
| `TWILIO_WHATSAPP_FROM` | WhatsApp sender (E.164, no `whatsapp:` prefix). |
| `TWILIO_SMS_FROM` | SMS sender number (E.164). |
| `ERP_DISABLE_*` | Per-scheduler kill switches (see job table above). |

`.gitignore` keeps `node_modules/`, `/data/` (the live DB + uploads), `.env`,
`client/dist/` and `.claude/worktrees/` out of version control.

---

## 13.7 Front-End Application Notes

- **api wrapper** (`client/src/api.js`): a single axios instance with `baseURL:
  '/api'`. A request interceptor attaches the JWT from `localStorage`. A response
  interceptor (a) swaps in a fresh token whenever the server returns an
  `X-Refresh-Token` header (sliding session), and (b) on `401` clears the token
  and redirects to `/login`.
- **AuthContext** (`client/src/context/AuthContext.jsx`): holds `user`,
  `permissions`, `userRoles`, and `token`. On mount it calls `/auth/me` to hydrate
  state. It **live-refreshes permissions** by re-pulling `/auth/me` when the tab
  regains focus and every two minutes while active (debounced), so an admin's
  permission grant takes effect without a re-login. Background refresh failures
  never trigger an auto-logout.
- **Route guards** (`client/src/App.jsx`):
  - `ProtectedRoute` — requires a logged-in user, else redirects to `/login`.
  - `AdminRoute` — requires `isAdmin()`, else redirects to `/`.
  - `ModuleRoute module="..."` — requires `canView(module)`, else renders an
    in-place "Access Denied" panel.
- **PWA**: `public/manifest.json` declares a `standalone` installable app
  (`SEPL Business ERP`, theme `#1e40af`). `public/sw.js` is the service worker —
  it claims clients on activate, receives `push` events (showing a notification
  even when the tab is closed), and on notification click focuses an existing ERP
  tab or opens the deep link. `client/src/lib/push.js` manages the browser push
  subscription against the server's VAPID public key.

---

## 13.8 Security Notes

- **Authentication — JWT bearer tokens.** Login (`POST /api/auth/login`) returns a
  7-day JWT signed with `JWT_SECRET` containing `{id, email, role, name}`.
  `authMiddleware` verifies the token on every protected route and sets
  `req.user`. A **sliding session** re-issues a fresh token (via the
  `X-Refresh-Token` response header) once the current token is more than a day
  old, so an active user is never logged out mid-session, while a fully idle
  session still expires at 7 days.
- **Password storage — bcrypt.** Passwords are hashed with `bcryptjs` at cost 10
  (`bcrypt.hashSync(password, 10)`) and verified with `bcrypt.compareSync`. Plain
  passwords are never stored.
- **Authorization — role-based permission gating.** Access is enforced server-side
  via `requirePermission(module, action)` which joins `user_roles` →
  `role_permissions` and checks the relevant `can_view/can_create/can_edit/
  can_delete/can_approve` flag. The `admin` role bypasses all checks
  (`adminOnly` is also available for admin-only routes). The front-end mirrors
  this with `ModuleRoute`, but enforcement is authoritative on the backend — the
  client gate is UX only.
- **Audit logging.** `auditMiddleware` records every mutating request
  (POST/PUT/PATCH/DELETE) into `audit_log` after the response finishes,
  fire-and-forget so it never adds latency. It **redacts secret fields**
  (`password`, `current_password`, `new_password`, `token`, `authorization`,
  `secret`) from the logged body, auto-derives the action from the HTTP method,
  and skips high-frequency noise paths (location pings, dashboard polls).
- **CORS.** Open (`*`) in development for local tooling; in production
  `origin:false` because the SPA is same-origin (served by the same process
  behind Nginx), so cross-origin browser requests are rejected.
- **Transport security.** Nginx terminates TLS with a Let's Encrypt certificate
  and force-redirects HTTP→HTTPS; certbot handles auto-renewal.
- **Error hygiene.** The global Express error handler returns a JSON error body
  (never raw HTML/stack traces to the client). Sentry's `beforeSend` strips auth
  headers, cookies and request bodies so credentials never leave the server.
- **Upload limits.** Multer caps uploads at 20 MB and sanitises filenames
  (`[^a-zA-Z0-9.-]` → `_`); the JSON body parser is capped at 10 MB.
- **Public surface.** Two endpoints are intentionally unauthenticated:
  `/api/public/*` (candidate offer accept/decline by token) and `/api/health`.
  Everything else under `/api` requires a valid JWT; `/audit` requires the
  separate `AUDIT_API_TOKEN`.

> Hardening note for operators: the sample `JWT_SECRET` in `.env.example`,
> `render.yaml`, and `deploy-vps.sh` is a placeholder. Set a strong, unique
> `JWT_SECRET` (and a real `AUDIT_API_TOKEN`) per environment — the auth
> middleware falls back to a hard-coded default secret only if the env var is
> entirely absent, which must never happen in production.
