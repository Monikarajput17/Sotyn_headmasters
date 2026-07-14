# 10. Dashboards & Executive Views

This section documents the five dashboard surfaces in the SEPL ERP and the
machinery that feeds them. There are two tiers:

- **Home Dashboard** — the landing page every authenticated user sees after
  login. Personal, operational, low-altitude.
- **Executive dashboards** — the **War Room**, the **Operating Console (CMD,
  Stage 1)**, the **TOC View (CMD, Stage 2)**, and the underlying **CMD Audit
  feed**. These are admin-only and exist for the MD/CMD/COO to read the whole
  business in 30 seconds.

The three executive React pages (`/dashboard/war-room`, `/dashboard/cmd`,
`/dashboard/cmd-toc`) and their two data endpoints
(`/api/dashboards/kpi`, `/api/dashboards/cmd-detail`) are all **admin-gated**.
Two scheduled jobs — a **07:30 audit snapshot** and a **09:00 CMD email** —
turn the same data into a daily push to the director.

---

## 10.1 Overview — the dashboard landscape

| Dashboard | Route | Who sees it | Data source | Purpose |
|---|---|---|---|---|
| Home Dashboard | `/` (index) | Every logged-in user | `GET /api/dashboard` + personal endpoints | Personal tasks, checklists, attendance, recent rows |
| War Room | `/dashboard/war-room` | Admin only (`AdminRoute`) | `GET /api/dashboards/cmd-detail` | Director's CMD/COO traffic-light board + "do-not-show" RBAC plan |
| Operating Console (CMD Stage 1) | `/dashboard/cmd` | Admin only | `GET /api/dashboards/cmd-detail` | Section-by-section operating screen across all functions |
| TOC View (CMD Stage 2) | `/dashboard/cmd-toc` | Admin only | `GET /api/dashboards/cmd-detail` | Same data re-framed as a Theory-of-Constraints decision board |
| CMD Audit feed | `GET /audit` (+ `/data-quality`, `/analytics`, `/kpi`) | External / server-to-server (bearer token) | Direct SQLite | 12 KPI tiles + exception lists; feeds the daily CMD email |

### Front-end access control

The three executive pages are wrapped in an `AdminRoute` guard in
`client/src/App.jsx`:

```jsx
function AdminRoute({ children }) {
  const { isAdmin, loading } = useAuth();
  ...
  return isAdmin() ? children : <Navigate to="/" />;
}

<Route path="dashboard/cmd"      element={<AdminRoute><DashboardCMD /></AdminRoute>} />
<Route path="dashboard/cmd-toc"  element={<AdminRoute><DashboardCMDToc /></AdminRoute>} />
<Route path="dashboard/war-room" element={<AdminRoute><DashboardWarRoom /></AdminRoute>} />
```

A non-admin who navigates to any of these URLs is bounced back to the Home
Dashboard. The Home Dashboard itself is **not** admin-gated — it adapts its
content based on `isAdmin()`.

### Back-end access control

| Endpoint | File | Auth |
|---|---|---|
| `GET /api/dashboard` | `server/routes/dashboard.js` | `authMiddleware` (any logged-in user) |
| `GET /api/dashboards/kpi` | `server/routes/dashboards.js` | `authMiddleware` + `adminOnly` |
| `GET /api/dashboards/cmd-detail` | `server/routes/dashboards.js` | `authMiddleware` + `adminOnly` |
| `GET /audit`, `/audit/*` | `server/routes/auditReport.js` | Bearer token (`AUDIT_API_TOKEN`), no session |

---

## 10.2 Home Dashboard

**File:** `client/src/pages/Dashboard.jsx` (≈337 lines)
**Endpoint:** `GET /api/dashboard` — `server/routes/dashboard.js`

### Business purpose

The Home Dashboard is the post-login landing page. It is deliberately
**personal and operational** rather than executive: it tells the logged-in
user what *they* must do today (tasks, checklists, support tickets, their
attendance), and shows a small "recent activity" strip. The old top-of-page
KPI tile row was deliberately removed.

### KPI tiles were removed

The component still fetches `GET /api/dashboard`, but a documented decision
(mam, 2026-05-22) **removed the eight colour-coded KPI tiles** that used to sit
at the top — Total Leads / Won Deals / Active Orders / Installations / Open
Complaints / Employees / Pending Expenses / Candidates. Each module already has
its own page with richer filters, so the tiles were duplicating numbers
without adding value. The data fetcher is intentionally left intact (no schema
change) in case the tiles are reintroduced behind an admin toggle later.

### What the page renders today

| Widget | Visible to | Source | Notes |
|---|---|---|---|
| ERP-culture mantra banner | Everyone | `ErpMantraBanner` component | Rotates by day-of-year so the whole team sees the same quote at standup |
| This Month's Attendance (mini calendar) | **Non-admins only** | `GET /api/attendance/my-month` | Admin is skipped on purpose — they monitor everyone, so the "absent" figure would be noise |
| Support Tickets Assigned to You | Anyone with active tickets | `GET /api/support/mine` | Only shown when `active > 0`; lists ticket no, priority, module, raiser, status |
| My Tasks (delegations) | Everyone | `GET /api/delegations?scope=mine` | Pending/rejected delegations with inline proof-upload "Submit" button |
| Today's Checklists | Everyone | `GET /api/hr/checklists/my-today` | Pending vs done; inline "Upload Proof" to complete |
| Recent Leads | Everyone | `stats.recentLeads` (5 rows) | Company / status / date |
| Recent Orders | Everyone | `stats.recentOrders` (5 rows) | PO number / amount / status |
| Recent Complaints | Everyone | `stats.recentComplaints` (5 rows) | Number / description / priority / status |

### The `/api/dashboard` payload

`server/routes/dashboard.js` is a single `GET /` handler (behind
`authMiddleware`) that returns aggregate counts plus three recent-row lists:

| Group | Fields |
|---|---|
| `leads` | `total`, `new`, `qualified`, `won` (from the legacy `leads` table) |
| `orders` | `total`, `totalValue`, `inProgress` (from `purchase_orders`) |
| `installations` | `total`, `pending`, `inProgress`, `completed` |
| `complaints` | `open`, `inProgress` |
| `hr` | `employees` (active), `candidates`, `subContractors` (active) |
| `expenses` | `pending` sum, `approved` sum |
| `recentLeads` | last 5 leads |
| `recentOrders` | last 5 POs |
| `recentComplaints` | last 5 complaints |

The aggregate count groups (`leads`, `orders`, `installations`, etc.) are the
data that backed the removed tiles — kept live but no longer rendered. The
React page consumes only `recentLeads`, `recentOrders`, and `recentComplaints`.

### Inline proof upload

Both "My Tasks" and "Today's Checklists" support uploading a proof file inline.
The shared helper POSTs the file to `/api/upload`, then:

- a checklist is completed via `POST /api/hr/checklists/:id/complete` with the
  returned `proof_url`;
- a delegation submits via `POST /api/delegations/:id/submit` with the proof
  URL, after which it awaits admin approval.

---

## 10.3 The executive data layer

All three executive React pages read from **one consolidated endpoint** so the
War Room, the Operating Console, and the TOC View can never disagree about the
numbers. There are two compute functions and two routes.

### Routes — `server/routes/dashboards.js`

```js
router.use(authMiddleware);

// Same payload as /audit/kpi, but session-authed + admin-gated.
router.get('/kpi', adminOnly, (req, res) =>
  res.json(computeKpiPayload(getDb(), req.query.days)));

// Extended payload for BOTH CMD pages (Stage 1 + Stage 2) in one round-trip.
router.get('/cmd-detail', adminOnly, (req, res) =>
  res.json(computeCmdDetail(getDb(), req.query.days)));
```

- `/api/dashboards/kpi` re-uses `computeKpiPayload` from
  `server/routes/auditReport.js` — identical JSON to the external `/audit/kpi`,
  but authenticated by the user's normal JWT session instead of a bearer token,
  and locked to admins.
- `/api/dashboards/cmd-detail` calls `computeCmdDetail` from
  `server/utils/cmdDashboard.js` — a richer payload designed so the **same
  response feeds both** the Operating Console (Stage 1) and the TOC View
  (Stage 2). One fetch loads every section.

Both routes accept an optional `?days=N` window (clamped 7–365; defaults 90 for
`cmd-detail`, 30 for `kpi`).

### `computeCmdDetail(db, days)` — `server/utils/cmdDashboard.js`

A single function returns every list, breakdown, and chart series the two CMD
pages need. Money figures are raw rupees. When the ERP does not yet capture the
source data for a metric (e.g. EBITDA %, solar kW live, LTI safety days,
quote-loss reasons), the field returns `null`; the front-end renders an em-dash
with a "needs capture" tooltip rather than fabricating a number.

The response top-level keys:

| Key | Contents |
|---|---|
| `pulse` | The 8-number headline: bank balance, free cash, runway days, order book (+ count), revenue MTD, CCC (with DSO/DIO/DPO), DPR adherence %, open snags, free inventory, WIP locked/unbilled, revenue per FTE, quote lead-time, lead→PO % |
| `cash` | Bank row, AR outstanding + 4 aging buckets, AP outstanding, top-5 debtors (with a derived "action today"), statutory dues calendar, 30-day cash forecast series, cost-of-inaction/day |
| `sales` | Funnel (leads→qualified→quoted→POs→in-execution→billed→collected), vertical mix, lead-source mix, 12-week booking trend (MEPF vs Solar), top customers, pipeline by stage, quote lead-time distribution, loss reasons, pending quotes, conversion by source |
| `operations` | Active sites (deduped), snags by priority, snag aging buckets, DPR adherence, on-time milestone %, sites past target date, materials-in-transit, tools-out |
| `it` | `sentry_active` boolean (green if Sentry DSN configured) |
| `inventory` | Total / free-to-use / reserved / slow-moving / dead-stock values |
| `procurement` | Top vendors by spend (with paid %) |
| `people` | Active FTE, headcount by dept, revenue per FTE (+ by dept), attendance today (present/late/leave/absent), KPI top/bottom 3 |
| `customer` | Complaints by priority, predictive flags (slip-risk / churn-risk / cash-gap) |
| `data_quality` | Junk-PO list + count + total ₹ affected |

#### Notable derived metrics

- **Active sites** are deduped by linked `business_book` project (legacy PO
  re-uploads created duplicate site rows; mam, 2026-05-30). Sites with no BB
  link fall back to a normalized name key.
- **Cash conversion cycle (CCC) = DSO + DIO − DPO**, each computed over the
  selected window. **Free cash = bank − dues falling in the next 30 days**.
  **Runway = bank ÷ average daily outflow** over the last 30 days.
- **Top-5 debtors** each get an `action_today` string derived live from
  days-overdue: 90+ "Legal notice today", 60–89 "CEO call today", 30–59 "Site
  visit today", else "Follow-up email today".
- **Statutory dues** are pulled live from `statutory_dues_calendar` (label +
  `due_day`), resolved to "GST due 20-Jun" for the current/next month, with a
  red/amber/green status by days-out — replacing four old hardcoded `null` rows.
- **Funnel counts** come from the **live `sales_funnel` (11-stage)**, not the
  near-empty legacy `leads` table (which had made the War Room show "1 lead").
- **Junk POs**: a `business_book` PO number is "junk" if blank, a known dummy
  (`5252525`, `141414`, …) or shorter than 10 characters. The count and ₹ total
  scan all junk rows so the Stage-1 escalation banner shows the true figure.
- **Materials-in-transit** (`indents` in `po_sent`/`dispatched`) and
  **tools-out** (`tools` `in_use`) were previously literal em-dashes in the War
  Room; both are now live (mam, 2026-05-30 audit).
- **IT systems light** is a live boolean: green when a Sentry DSN exists in
  `app_settings`, amber otherwise — replacing a hardcoded amber light.

### Shared UI kit — `client/src/components/cmdDashboardUi.jsx`

Both CMD pages import a common component/style library so they share one look:

| Export | Role |
|---|---|
| `C`, `fmtINR`, `fmtNum`, `fmtPct` | Palette + formatters (₹ rendered as cr/L/K) |
| `PageHeader` | Top banner with title, tag, subtitle, right-rail meta |
| `SectionHead` | Section divider headings |
| `KpiTile` | Single coloured-stripe KPI tile (`accent` red/amber/green/blue/…) |
| `Card`, `MiniStat`, `Pill`, `Row` | Layout primitives |
| `FunnelBar`, `HBar`, `HeatCell`, `TicksList` | Chart primitives |
| `ConstraintBanner`, `TocStep` | TOC-specific blocks (binding constraint, Exploit/Subordinate/Elevate moves) |
| `StageTabs` | The two-tab switcher between `op` (Operating Console) and `toc` (TOC View) |
| `DataGap` | "needs capture" placeholder when a metric is `null` |

---

## 10.4 War Room (Director's War Room)

**File:** `client/src/pages/DashboardWarRoom.jsx` (≈837 lines)
**Route:** `/dashboard/war-room` (admin only)
**Data:** `GET /api/dashboards/cmd-detail?days=90`

### Business purpose

The War Room mirrors mam's HTML spec `SEPL_CMD_COO_Dashboard_v1.html`. It is
the director's "single screen of glass" combining a CMD (director) board, a COO
(operations) board, and an explicit **RBAC / do-not-show plan** for the future
five-role rollout. All traffic lights and numbers are computed live from
`/api/dashboards/cmd-detail`; the default window is 90 days and is adjustable.

### Three tabs

| Tab | Audience | Contents |
|---|---|---|
| **CMD VIEW (Director)** | MD/CMD | Seven sections (below) |
| **COO VIEW (Operations)** | COO | Execution-only operating screen |
| **DO-NOT-SHOW LIST** | IT/Admin | What to hide from which role + the RBAC build sheet |

### CMD VIEW — seven sections

1. **Traffic Light (30-second read)** — six `TrafficCard`s: Cash, Sales,
   Delivery, People, Systems, Data Quality. Each light (red/amber/green) is
   auto-computed from the `cmd-detail` payload. A banner fires when ≥2 of
   Cash/Sales/Delivery/Data-Quality are red.
2. **Top 3 Bottlenecks (₹/day cost)** — the most expensive constraints, costed
   from the cost-of-inaction estimate.
3. **Today's 3 Decisions** — the three calls the director must make today, each
   with an owner and a deadline.
4. **Cash · Sales · Delivery** — hard numbers only: cash position, live sales
   funnel, delivery health.
5. **Pareto · Predictive · Exceptions** — "20% of customers = 80% revenue",
   predictive flags (next 14 days), and anomalies (>2σ today).
6. **Accountability** — top/bottom performers this week (Friday view), SLA
   breaches and culture flags.
7. **IT Head Watchlist** — the active IT build queue (e.g. RBAC for 5 roles).

### COO VIEW

Execution-focused: today's site map (DPR + snag + risk), people
(attendance/behaviour/performance with top/bottom KPI), procure-to-pay &
inventory health (top vendors, inventory exceptions, 30-day cash-gap watch),
and customer voice (complaints & tickets). Closes with the **COO routine**:
09:00 read the screen → 09:15 call the top-2 RED projects.

### DO-NOT-SHOW LIST

A governance tab, not a data tab. It documents:

- **Hide from Sales / Junior Ops** — cash runway, bank balance, statutory dues
  (CMD + CFO only); customer churn-risk scores (CMD + COO + Sales Head only).
- **Hide from CMD daily** — daily attendance roll (COO & HR; CMD sees only
  anomalies); per-engineer DPR text (COO + line manager only).
- An **RBAC build sheet** matrix (Module × CMD/COO/CFO/HR/Sales/Site-Eng) to
  hand to the IT head.

---

## 10.5 Operating Console — CMD Stage 1

**File:** `client/src/pages/DashboardCMD.jsx` (≈540 lines)
**Route:** `/dashboard/cmd` (admin only)
**Data:** `GET /api/dashboards/cmd-detail?days=90`

### Business purpose

The Operating Console mirrors mam's `SEPL_CMD_TOC_Dashboard` Stage-1 spec. It
is a section-by-section **operating screen** that walks the whole business cycle
top to bottom. It uses the shared UI kit and the `StageTabs` switcher to flip to
the TOC View. Header tag: `CMD VIEW`, title "SEPL Operating Console".

### Sections (in order)

| # | Section | Key widgets |
|---|---|---|
| 1 | **Pulse · 8 numbers that decide today** | KPI tiles: Bank balance (+ runway), Order book (+ PO count / active sites), Revenue MTD, CCC days (DSO + DIO − DPO), DPR adherence, Open snags (+ oldest), Free inventory, Lead → PO % |
| 2 | **Business cycle** | Lead → Quote → PO → Site → Bill → Cash funnel bars + escalation banner |
| 3 | **Vertical mix** | Order-book split by `business_book.category` |
| 4 | **Sales · Order Book · Customers** | Top customers, pipeline by stage, conversion by source |
| 5 | **Site execution · MEPF discipline split** | DPR adherence, snag aging, sites past target |
| 6 | **Procurement · Vendors · Inventory** | Top vendors by spend, inventory split, cash position |
| 7 | **Cash · AR aging · Collection** | AR buckets, top debtors, 30-day cash forecast |
| 8 | **People · Attendance · KPI** | Attendance today, headcount, KPI top/bottom |
| 9 | **Data quality · Junk POs in book** | Junk-PO list + escalation count |

The footer prints the refresh source (`/api/dashboards/cmd-detail`),
`spec_version`, and `generated_at` so the viewer can see how fresh the data is.
Metrics with no source data render through `DataGap` as an em-dash.

---

## 10.6 TOC View — CMD Stage 2

**File:** `client/src/pages/DashboardCMDToc.jsx` (≈546 lines)
**Route:** `/dashboard/cmd-toc` (admin only)
**Data:** `GET /api/dashboards/cmd-detail?days=90` (same endpoint as Stage 1)

### Business purpose

The TOC View mirrors mam's `SEPL_CMD_TOC_Dashboard_v3.html`. It renders the
**same `cmd-detail` data** as the Operating Console but re-framed through the
**Theory of Constraints** (Identify → Exploit → Subordinate → Elevate →
Repeat). Instead of "here are all the numbers", it asks "what is *the one*
binding constraint today, and what three moves attack it?" Header tag:
`CMD · TOC v3`.

### The binding-constraint engine

`bindingConstraint(data)` inspects the pulse metrics and picks the single
binding constraint. For example, if Lead → PO conversion is below the 40% TOC
threshold, the pipeline leak is named the binding constraint until conversion
improves (focus the quote-in-4-days rule and subcontractor close-out
discipline). If every pulse metric is inside its threshold, it advises running a
weekly TOC review so the system does not drift.

### Sections (in order)

| # | Section | Focus |
|---|---|---|
| 1 | **Pulse · 8 numbers (TOC-aligned)** | Cash on hand, free cash, CCC, etc. |
| 2 | **Identify · Today's binding constraint** | `ConstraintBanner` — the single chosen constraint + why |
| 3 | **Problem #1 · Cash flow** | CCC waterfall, AR aging, 30-day forecast |
| 4 | **Problem #2 + #3 · Quote lead time · Lead → PO conversion** | Quote-LT distribution, conversion by source |
| 5 | **Problem #4 · Operations / project management** | DPR, snags, sites past target |
| 6 | **Inventory · TOC view** | Every ₹ in inventory = ₹ not in cash (free/reserved/slow/dead) |
| 7 | **Problem #5 · People — who to hire, whom to fire** | Headcount, revenue per FTE, KPI top/bottom |
| 8 | **Today's 3 moves · Exploit · Subordinate · Elevate** | `TocStep` cards — e.g. hire a Collections Officer + deploy invoice-on-milestone automation |

It closes with a TOC-discipline reminder: don't fix everything — identify the
binding constraint, exploit it, then repeat.

### Stage 1 ↔ Stage 2 navigation

Both pages render `<StageTabs active=… onChange=…>`. Selecting the other tab
calls `nav('/dashboard/cmd')` or `nav('/dashboard/cmd-toc')`. Because both pages
hit the same `cmd-detail` endpoint, switching tabs never re-derives numbers
differently.

---

## 10.7 CMD Audit feed (`/audit`)

**File:** `server/routes/auditReport.js` (≈1014 lines)
**Mount:** `app.use('/audit', require('./routes/auditReport'))` —
**outside `/api/*`** on purpose, so an external scheduler can hit
`securederp.in/audit` directly.

### Business purpose

The Audit feed is a **read-only, token-authenticated JSON API** built to the
Master Prompt v3 spec. Mam's MD requested it so an automated caller (the daily
9 AM email job, or any external scheduler) can pull a full data-integrity audit
**without being given a user login**. It is the canonical source for the
executive KPIs and for the exception lists that surface data-quality problems.

### Token authentication

The router's own middleware (kept separate from the cookie/session
`middleware/auth.js`, because this traffic is server-to-server) checks a shared
secret:

- Set `AUDIT_API_TOKEN` (≥8 chars) in the server environment
  (`pm2 set ERP:AUDIT_API_TOKEN <token>` or `.env`).
- Callers pass it as `Authorization: Bearer <token>` **or** `?token=<token>`.
- If the token is unconfigured → `503 audit_token_unconfigured`.
- If the provided token mismatches → `401 unauthorized`.

### Endpoints

| Method | Path | Returns |
|---|---|---|
| `GET` | `/audit` | 12 KPI tiles + 8 exception lists + DB metadata + summary |
| `GET` | `/audit/data-quality` | Per-table row counts, null-rate scorecard, quality score |
| `GET` | `/audit/analytics?days=N` | 30-day rolling activity totals, by-day series, top vendors/clients |
| `GET` | `/audit/kpi?days=N` | Operating-cycle KPI payload (DSO/DIO/DPO/CCC, AR aging, WIP, funnel, rev/FTE, margin variance) |

> Note: `computeKpiPayload` is exported from this file and re-used by the
> session-authed, admin-gated `/api/dashboards/kpi` route, so the in-app
> dashboards and the external feed share one implementation.

### `GET /audit` — the 12 KPI tiles

Each tile is `{ id, label, value, unit }`:

| id | Label | Unit |
|---|---|---|
| `active_sites` | Active Sites | count |
| `open_pos` | Open Purchase Orders | count |
| `mtd_sale_value` | MTD Sale Value (ex-GST) | inr |
| `mtd_received` | MTD Cash Received | inr |
| `outstanding_receivables` | Total Outstanding Receivables | inr |
| `overdue_receivables` | Overdue (>60d) Receivables | count |
| `dpr_submitted_today` | DPRs Submitted Today | count |
| `dpr_missing_today` | Sites Missing DPR Today | count |
| `pending_payment_requests` | Pending Payment Requests | count |
| `pending_indents` | Pending Indents | count |
| `active_employees` | Active Employees | count |
| `cheques_open` | Cheques Awaiting Action | count |

(The list yields 12 tiles; the spec is referred to as the "12 KPI tiles".)

### `GET /audit` — the exception lists

The response groups exceptions under named keys; each carries a `description`,
an `items` array, and a computed `count`. Items can be flagged
`severity: 'critical'`.

| Key | What it flags |
|---|---|
| `duplicates` | Records sharing key identifiers — BB client+project pairs, duplicate vendors / customers / item-master rows, and (critical) duplicate `purchase_orders.po_number` |
| `arithmetic_errors` | Computed total ≠ recorded total: sales/purchase bills where `amount + gst ≠ total` (>₹1), POs where `total ≠ Σ po_items.amount` (>₹10), DPR `grand_total_a − grand_total_b ≠ profit_loss` |
| `missing_required` | Blank critical fields: BB (`lead_no`/`client_name`/`po_amount`), POs, vendors (no phone/email, or missing GST/address/contact-person), customers, sites (address), active employees (phone) |
| `stale_records` | Open work-items past SLA: POs `received` >30d, receivables 90+ not escalated, complaints open >14d, snags open >30d, indents pending >14d |
| `schema_drift` | Columns the code depends on (`EXPECTED_COLUMNS`) that are missing/renamed — surfaced as `critical` so a bad deploy is caught before downstream queries break |
| `cashflow_recon` | One `company_name` rolling up >1 distinct `client_name` in the Cash Flow tracker (surprising rollups; mam, 2026-05-16) |
| `cashflow_sale_drift` | Invariant check: Cash-Flow project Sale total must equal the raw `business_book.SUM(sale_amount_without_gst)`; any drift means a regression (e.g. a fan-out JOIN) — guards the bug fixed in commit 7d87429 |
| `geofence_violations` | Attendance punches recorded outside the configured site geofence (haversine to nearest active geofence, beyond radius + 500 m buffer; >3 km flagged critical) |

The top-level `summary` returns `kpi_count`, `total_exceptions`, and
`critical_exceptions`, alongside `database` metadata (path, size, last-modified).

### `GET /audit/data-quality`

Walks the same `EXPECTED_COLUMNS` set and, per table, reports row count, the
last rowid, per-column `null_count` / `null_pct`, and a `quality_score`
(100 minus the worst null-rate on a required column). A row-count-weighted
`overall_quality_score` is returned at the top.

### `GET /audit/analytics`

A 30-day (configurable via `?days=N`) rolling activity view:

- `totals` — new rows created in the window per entity (business book, POs,
  sales/purchase bills, DPR, indents, payment requests, cheques, complaints,
  snags).
- `by_day` — day-by-day series for DPR, sales bills, and cash inflows.
- `top_vendors` (by spend) and `top_clients` (by sale value).

### `GET /audit/kpi`

The operating-cycle payload (also served at `/api/dashboards/kpi`):
cash-conversion-cycle (`dso`, `dio`, `dpo`, `ccc`), AR outstanding + aging, AP
outstanding, inventory total / free-to-use, sales in window, bank position,
WIP (book/billed/unbilled), funnel (leads, won, lead→PO %, quote lead-time),
revenue per FTE (overall + by department), on-time milestone %, and
project-margin variance (avg + worst-5 POs). All money in raw rupees.

---

## 10.8 Daily scheduled jobs

Two crons (registered in `server/index.js`) turn the audit data into a daily
push to the director. They mirror the snapshot/email cadence and both skip
Sunday.

### 07:30 — daily audit snapshot

**File:** `server/scripts/dailyAuditSnapshot.js`
**Registration:** `scheduleDailyAuditSnapshot()` (skip via
`ERP_DISABLE_AUDIT_SNAPSHOT=1`)

Every morning at **07:30 local time** it pulls the same JSON the `/audit`,
`/audit/kpi`, `/audit/data-quality`, and `/audit/analytics` endpoints return and
writes it to `data/audit-snapshots/<YYYY-MM-DD>/<endpoint>.json`. Purpose:

1. the 09:00 email can read that snapshot instead of rerunning all queries;
2. the CMD/COO/Sales/Finance dashboards can show "as of this morning" values
   without hitting the DB on every load;
3. a permanent point-in-time history (bank / AR aging / WIP / CCC) for trend
   analysis.

Retention is **90 days**; older snapshot folders are pruned on each run. The job
requires `AUDIT_API_TOKEN` to be configured and self-schedules to the next
07:30 with a drift-corrected `setTimeout` then a 24-hour interval (the same
pattern as the nightly DB backup).

### 09:00 — CMD audit email

**File:** `server/scripts/dailyCmdEmail.js`
**Registration:** `scheduleDailyCmdEmail()` (skip via `ERP_DISABLE_CMD_EMAIL=1`,
Sunday off)

At **09:00 local time** it reads the 07:30 snapshot
(`data/audit-snapshots/<today>/kpi.json` + `audit.json`) and emails a formatted
HTML summary to the director address from Admin → Email Settings
(`app_settings.email_director_to`). It degrades gracefully:

- SMTP not configured in `app_settings` → logs a skip, no error.
- Today's snapshot folder missing → computes the KPI payload **live** via
  `computeKpiPayload` so the email still goes out (marked "live fallback —
  7:30 snapshot missing").

The email body mirrors the War Room CMD aesthetic (inlined CSS so every mail
client renders it) and surfaces the pulse numbers, cash/CCC/AR, funnel, WIP, and
exception counts.

### Manual trigger

`server/index.js` also exposes an admin-only manual fire:
`POST /api/admin/cmd-email/send-now` runs the same `runOnce()` immediately
(without waiting for the 09:00 tick) for testing or an on-demand send.

---

## 10.9 Summary

- **Home Dashboard** (`/`) is the only non-admin dashboard — personal tasks,
  checklists, support tickets, attendance, and recent-row strips. Its old KPI
  tiles were intentionally removed; the data fetcher is kept live.
- **War Room**, **Operating Console (CMD Stage 1)**, and **TOC View (CMD
  Stage 2)** are admin-only React pages, all guarded by `AdminRoute` and all fed
  by the single admin-gated `GET /api/dashboards/cmd-detail` endpoint
  (`computeCmdDetail`) — guaranteeing the three executive views never disagree.
- The **CMD Audit feed** (`/audit`, plus `/data-quality`, `/analytics`, `/kpi`)
  is a token-authenticated, session-less JSON API: 12 KPI tiles, 8 exception
  lists, a data-quality scorecard, and rolling analytics. Its `computeKpiPayload`
  is re-used by the in-app `/api/dashboards/kpi` route.
- Two crons consolidate it into a daily director push: a **07:30 snapshot** to
  disk (90-day retention) and a **09:00 CMD email** (snapshot-backed, live
  fallback, Sunday off), with an admin manual-trigger endpoint.
