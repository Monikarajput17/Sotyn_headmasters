# 5. Projects

The **Projects** domain of the SEPL ERP covers everything that happens once a sales
order is won and the company has to *execute* and *bill* the work on site. It is a
cluster of five inter-related modules that together carry a project from the moment
labour is paid on the ground, through the daily site report, the snag list, the
statutory Fire-NOC renewal funnel, and finally the sequence of client sales bills
that turn the executed work into money received.

| Module | Page | Route | Server route file |
|---|---|---|---|
| Indent Labour Payment | `client/src/pages/IndentLabourPayment.jsx` | `/indent-labour-payment` | `server/routes/indentLabourPayment.js` |
| Daily Reports (DPR) | `client/src/pages/DPR.jsx` | `/dpr` | `server/routes/dpr.js` |
| Snags | `client/src/pages/Snags.jsx` | `/snags` | `server/routes/snags.js` |
| Fire NOC Renewal | `client/src/pages/FireNoc.jsx` | `/fire-noc` | `server/routes/fireNoc.js` |
| Sales Billing (4-type) | `client/src/pages/SalesBilling.jsx` | `/installation` | `server/routes/salesBilling.js` |

> **Two sales-bill flows exist.** The 4-type sequential module above is the planned
> per-order billing chain. A second, **delivery-note-driven** sales-bill flow lives
> in `server/routes/procurement.js` and produces the actual printable SEPL Tax
> Invoice (with CGST/SGST/IGST split and the Against-Delivery "Payment Due" line).
> Both write to the shared `sales_bills` table. Both are documented in §5.5.

---

## 5.1 Indent Labour Payment (Project Execution & Billing)

### Business purpose

Track, per project, every rupee of **labour** spent on site, split across the three
ways SEPL pays for labour:

- **L1 — Salary** (own staff on the company payroll)
- **L2 — Daily Wages** (daily-rated workers, `per_day_rate × days`)
- **L3 — Sub-contract Work Orders** (work given to sub-contractors, paid against a
  Work-Order value)

The project **Budget** is simply the running sum of all three streams. From there the
module is designed to grow into the full execution-to-billing chain (Muster Roll →
DPR link → Measurement Book / CDPR → Contractor RA Bill → Client RA Bill → Payment
Received), but only the **Projects** tab is fully built today; **MB/CDPR**, **RA
Bills** and **Dashboard** are phase stubs.

> This module **coexists** with the simpler `labour_payment_indents` module (the
> older `/labour-payment` indent screen, table `labour_payment_indents`). The two do
> not share data; the new module uses the `proj_*` tables.

### Who uses it

Project / commercial team (default owner shown as **Aanchal**). Gated by the
`indent_labour_payment` permission module (`view` / `create` / `edit`).

### Main screen / tabs

The page (`IndentLabourPayment.jsx`) has four top tabs, each labelled with its build
phase (P1, P5, P6):

| Tab | Phase | State |
|---|---|---|
| **Projects** | P1 | Built — list + per-project Salary / Daily Wages / Work Orders |
| **MB / CDPR** | P5 | Phase stub |
| **RA Bills** | P6 | Phase stub |
| **Dashboard** | P6 | Phase stub |

The **Projects** list shows, per project: name, owner, **L1 / L2 / L3** sub-totals,
work-order count, and the derived **Budget = L1 + L2 + L3**.

### Key fields

- **Project** (`proj_projects`): unique `name`, `owner` (default Aanchal), `notes`.
  Projects are entered **manually** — they are *not* derived from the Business Book
  (a deliberate Phase-1 amendment because auto-derivation was creating wrong
  projects).
- **Salary entry** (`proj_salary_entries`): `kind` = `legacy` (one bulk pre-ERP
  amount captured at kickoff) or `monthly` (per-month rows with `employee_name` +
  `period_month` `YYYY-MM`), `amount`.
- **Daily-wage entry** (`proj_daily_wage_entries`): `kind` = `legacy` or `entry`;
  for `entry`, `total_amount = per_day_rate × days_required`.
- **Work Order** (`proj_work_orders`): `wo_number`, `sub_contractor_id`/`_name`,
  `scope`, `planned_value`, `amount_paid` (running), `work_order_file_url` (uploaded
  WO doc), `status` (`draft`/`active`/`closed`/`cancelled`). **Balance is derived:
  `planned_value − amount_paid`.** The WO count per project is dynamic (never
  hard-coded).

### Step-by-step workflow

1. Create a **Project** (unique name; duplicate names are rejected case-insensitively).
2. Add **Salary** entries (L1) — a legacy bulk row and/or monthly rows.
3. Add **Daily Wages** entries (L2) — legacy bulk and/or `rate × days` entries.
4. Create **Work Orders** (L3), attach the WO file, set `planned_value`, and post
   payments which accumulate into `amount_paid`.
5. The Budget tile updates live as the sum of all three streams.

### Formulas

- **Project Budget** = `Σ proj_salary_entries.amount` + `Σ proj_daily_wage_entries.total_amount` + `Σ proj_work_orders.amount_paid`
- **Daily-wage entry total** = `per_day_rate × days_required`
- **Work-order balance** = `planned_value − amount_paid`

### Automations / statuses

No cron. Statuses are on the work order only (`draft`/`active`/`closed`/`cancelled`).

### API endpoints

All under `/api/indent-labour-payment`, all guarded by `indent_labour_payment`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/projects` | List projects with L1/L2/L3 + budget; `?q=`, `?owner=` filters |
| GET | `/projects/:id` | One project with rollup |
| POST | `/projects` | Create project (unique name) |
| PUT | `/projects/:id` | Rename / change owner / notes |
| DELETE | `/projects/:id` | Delete project |
| GET | `/owners` | Distinct owner list |
| GET | `/projects/:pid/salary` | List salary entries |
| POST | `/projects/:pid/salary` | Add salary entry |
| DELETE | `/salary/:id` | Delete salary entry |
| GET | `/projects/:pid/daily-wages` | List daily-wage entries |
| POST | `/projects/:pid/daily-wages` | Add daily-wage entry |
| DELETE | `/daily-wages/:id` | Delete daily-wage entry |
| GET | `/projects/:pid/work-orders` | List work orders |
| GET | `/active-work-orders` | All active WOs across projects (feeds DPR) |
| GET | `/work-orders/:id/dpr-items` | DPR items linked to a WO (progress rollup) |
| POST | `/projects/:pid/work-orders` | Create WO |
| PUT | `/work-orders/:id` | Update WO (incl. running `amount_paid`) |
| DELETE | `/work-orders/:id` | Delete WO |

### DB tables

`proj_projects`, `proj_salary_entries`, `proj_daily_wage_entries`,
`proj_work_orders`, plus the phase-stub tables `proj_budgets`, `proj_muster_roll`,
`proj_mb_sheets`, `proj_mb_lines` (and the RA-bill tables seeded for later phases).
The active-WO endpoint joins into `dpr_work_items.work_order_id`.

---

## 5.2 Daily Reports (DPR)

### Business purpose

The **Daily Progress Report** is the core site-execution document. Each day, the site
engineer logs what was installed (**Table A**), what it cost in labour/staff/rental
(**Table B**), the manpower deployed, material consumed, machinery used, safety
observations, hindrances, and a next-day plan. The system derives a per-day
**Profit / Loss** for the site, surfaces loss reasons to management, scores engineer
compliance, and marks a DPR as `billing_ready` so the Installation (Type-3) sales
bill can be raised against it.

### Who uses it

- **Site engineers** submit DPRs and plan the week.
- **Project managers / admin** approve DPRs and flag `billing_ready`.
- **Management** reads the Dashboard, Loss Reasons, and Engineer Compliance views.

Gated by the `dpr` permission module (`view` / `create` / `approve`).

### Main screen / tabs

The DPR page toolbar exposes five tabs:

| Tab | Content |
|---|---|
| **Dashboard** | KPI tiles — Active Sites, DPR Today, Pending approvals, BOQ progress; each tile drills into the matching list |
| **Daily Reports** | The DPR list (filterable by date / pending), submit modal, approve, view detail |
| **Engineer Compliance** | Shared `EngineerPerformance` component (also reachable from HR → Performance) |
| **Sites** | Site master (create / edit / delete) |
| **Loss Reasons** | Management view of DPRs with `profit_loss < 0`, grouped by category/reason |

> **Manpower Plan tab** — required vs actual manpower (required from the order's
> value slab, actual from DPR `dpr_manpower`) is presented in the **HR System** area,
> not on the DPR page itself. DPR also has a **Plan-Week** feature (`/dpr/week-view`,
> `/dpr/plan-week`) that lets an engineer lay out a 7-day plan; planned-only days are
> stored as stub DPR rows with `is_planned_template=1`.

### Key fields

**DPR header (`dpr`):** `site_id`, `report_date`, `shift` (day/night), `weather`,
`overall_status` (`on_track`/`delayed`/`ahead`/`blocked`), `system_type` (MEPF
system — Fire Fighting, Electrical, Low Voltage, Plumbing, HVAC, Solar),
`floor_zone`, `mb_sheet_no`, safety flags (`safety_toolbox_talk`,
`safety_ppe_compliance`, `safety_incidents`), `next_day_plan`, `hindrances`,
`remarks`, `grand_total_a`, `grand_total_b`, `profit_loss`, `billing_ready`,
`approval_status` (`pending`/`approved`/`rejected`).

**Table A — Installation work items (`dpr_work_items`):** from the site's PO/BOQ.
Per row: `description`, `unit`, `floor_zone`, `boq_qty`, `rate`, `amount`,
`planned_qty`, `actual_qty`, `cumulative_qty`, `variance_pct`, optional
`work_order_id` link (feeds the Indent Labour Payment contractor rollup).

**Table B — Costs:** Skilled Manpower @ ₹800/qty and Helper @ ₹500/qty (fixed
company rates), Rental Cost, **Staff Cost** (auto-pulled from the site's PO engineers
— sum of monthly salary ÷ 30, never exposing individual salaries to the client), and
**TA/DA** (auto). Stored via `dpr_manpower` (trade / required / deployed / shortage)
and the cost rows.

**Supporting child tables:** `dpr_contractors` (up to 5+ sub-contractors per day,
name + manpower), `dpr_material` (consumed today / cumulative / balance),
`dpr_machinery` (equipment, qty, hours, condition).

### The DPR Table A labour rate — 11% of SITC

The PO/BOQ rate is the **full SITC** value (Supply + Installation + Testing &
Commissioning) and already includes labour. The DPR Table A must carry **only the
labour portion**, which is taken as **11% of the SITC rate**:

```
LABOUR_RATE_PCT = 0.11
Table-A row rate = round(SITC_rate × 0.11, 2)      // e.g. 1810 → 199.1
```

This 11% is the agreed placeholder until real labour rates are collected. The
server-side note in `dpr.js` confirms the rates the app sends are already the labour
portion. Historical DPRs were backfilled to this rule via a guarded migration.

### Profit / Loss formula

```
Grand Total (A) = Σ Table-A amounts        // labour value of work installed
Grand Total (B) = Σ Table-B cost amounts   // skilled + helper + rental + staff + TA/DA
Profit / Loss   = Grand Total (A) − Grand Total (B)
```

When `Profit/Loss < 0`, the submit form makes the **loss Category and Reason
mandatory** so management always knows why a site lost money that day.

### Step-by-step workflow

1. (Optional) Engineer plans the week via Plan-Week — stub rows with
   `is_planned_template=1`.
2. Engineer opens the **Submit DPR** modal for a site/date.
3. Table A auto-fills installation items from the site's PO; rate is set to
   **11% of SITC**; engineer enters `actual_qty`.
4. Table B fills skilled/helper qty; Staff Cost and TA/DA auto-compute from the
   site's PO engineers.
5. Engineer logs manpower, material, machinery, contractors, safety, next-day plan,
   hindrances. If it's a loss day, category + reason are required.
6. Submit → DPR saved with computed `grand_total_a/b` and `profit_loss`.
7. Approver opens the DPR, sets `approval_status` = approved/rejected and may flip
   `billing_ready = 1`.
8. A `billing_ready` DPR becomes the reference for the **Type-3 Installation** sales
   bill (§5.5).

### Automations / crons / statuses

- **DPR auto-prompt cron** nudges engineers to submit (the `/dpr/admin/trigger-prompt`
  endpoint can fire it on demand).
- Statuses: `approval_status` (`pending`/`approved`/`rejected`), `billing_ready`
  (0/1), `overall_status`.
- **Loss dashboard** aggregates `profit_loss < 0`; `/dpr/:id/loss-addressed` lets
  management mark a loss as addressed.
- **Engineer compliance** (`/dpr/engineer-compliance`) scores on-time / complete
  submissions per engineer.

### Print outputs

The DPR detail modal renders the SEPL DPR format (Table A / Table B / Profit-Loss
banner). There is no separate standalone PDF route; printing is via the browser from
the detail view.

### API endpoints (selected)

All under `/api/dpr`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/sites` | Site list |
| POST | `/sites` | Create site |
| PUT | `/sites/:id` | Update site |
| DELETE | `/sites/:id` | Delete site |
| GET | `/sites/:site_id/po-items` | PO/BOQ items for Table A (with SITC rates) |
| GET | `/sites/:site_id/staff-cost` | Auto staff-cost (Σ engineer salary ÷ 30) |
| GET | `/sites/:site_id/ta-da-cost` | Auto TA/DA cost |
| GET | `/` | DPR list (date / filter params) |
| GET | `/summary` | Dashboard KPIs |
| GET | `/week-view` | 7-day plan + actuals for a site (`site_id`, `week_start`) |
| POST | `/plan-week` | Upsert the 7-day plan (stub rows) |
| POST | `/` | Submit a DPR (header + work_items + manpower + machinery + contractors) |
| GET | `/:id` | One DPR with children |
| PUT | `/:id/approve` | Approve/reject + set `billing_ready` |
| DELETE | `/:id` | Delete DPR |
| GET | `/progress` | BOQ progress rollup |
| GET | `/loss-dashboard` | Loss-making DPRs |
| PATCH | `/:id/loss-addressed` | Mark loss addressed |
| GET | `/engineer-compliance` | Engineer compliance scores |
| GET | `/payment-check/:site_id` | Payment check for a site |
| POST | `/admin/trigger-prompt` | Fire the auto-prompt manually |

### DB tables

`sites`, `dpr`, `dpr_work_items` (Table A), `dpr_manpower` (Table B / trade),
`dpr_material`, `dpr_machinery`, `dpr_contractors`.

---

## 5.3 Snags

### Business purpose

A **snag** is a defect or pending item found during inspection/handover that must be
fixed and proven fixed before sign-off. The module is a maker-checker punch-list:
someone **raises** a snag with a photo, the **assignee** fixes it and **uploads
proof**, and an **approver** approves or rejects the proof.

### Who uses it

- **Raiser** (anyone with `snags.create`) — logs the snag with site, location,
  description, photo, priority, assignee, target date.
- **Assignee** — uploads the fix proof.
- **Approver** (`snags` approve permission / admin) — approves or rejects the proof.

Gated by the `snags` module (`view` / `create` / `edit` / `delete`).

### Main screen / columns

The Snags page is a single filterable list (filters: status, priority, search,
scope). Columns/CSV: `snag_no`, site name, location, description, **priority**,
**status**, raised-by, assigned-to, target date, raised-at. Action buttons appear
conditionally based on the viewer's role and the snag status.

### Key fields (`snags`)

`snag_no` (`SNAG-YYYY-####`), `site_id` + `site_name` (snapshot), `location`,
`description`, `photo_url` (raised photo), `priority` (`low`/`medium`/`high`/
`critical`), `status`, `assigned_to`(+name), `raised_by` / `raised_at`,
`target_date`, `proof_url` / `proof_notes` / `proof_submitted_at` / `_by`,
`approved_by` / `approved_at`, `reject_reason` / `rejected_at`.

### Status lifecycle

```
open ──submit proof──▶ submitted ──approve──▶ approved   (terminal)
                            │
                            └────reject────▶ rejected ──resubmit──▶ submitted
```

- **open** — raised, awaiting a fix.
- **submitted** — proof uploaded, awaiting approval.
- **approved** — proof accepted; snag closed.
- **rejected** — proof rejected (with `reject_reason`); assignee can resubmit.

### Step-by-step workflow

1. Raiser creates the snag (site, location, description, photo, priority, assignee,
   target date) → status **open**.
2. Assignee (or approver/admin) uploads fix proof (photo/PDF + notes) → **submitted**.
3. Approver reviews:
   - **Approve** → **approved**, stamps `approved_by`/`approved_at`.
   - **Reject** → **rejected** with reason; goes back for **resubmit** → **submitted**.

### Automations / statuses

No cron. The `submit`/`approve`/`reject` endpoints carry their own in-handler
permission checks (they are not wrapped in `requirePermission` because the actor may
be the assignee rather than a permission-holder). A `/stats` endpoint feeds counts.

### API endpoints

All under `/api/snags`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List snags (status/priority/search/scope filters) |
| GET | `/stats` | Counts by status/priority |
| POST | `/` | Raise a snag |
| PUT | `/:id` | Edit snag (while not approved) |
| POST | `/:id/submit` | Upload fix proof → submitted |
| POST | `/:id/approve` | Approve proof → approved |
| POST | `/:id/reject` | Reject proof (reason) → rejected |
| DELETE | `/:id` | Delete snag |

### DB tables

`snags` (single table; FKs to `sites` and `users`).

---

## 5.4 Fire NOC Renewal

### Business purpose

A full **T-180 → T+30** funnel that auto-pilots the statutory **Fire No-Objection
Certificate renewal** for every building SEPL services. Each building's NOC has an
expiry; the system computes how many days remain, walks a renewal cycle through a
fixed stage sequence (alert → qualify → quote → site visit → PO → dept filing →
inspection → NOC issued → final pay → upsell → close), and advances stages
automatically as the calendar moves — so the team only has to act, not remember.

Spec: `docs/FIRE_NOC.md` (mam's brief, 2026-05-16). Money is in **rupees REAL**
(column `amount`, not paise) to match the other ERP modules.

### Who uses it

Sales / Sales-Head team. RBAC adds two permission modules: `fire_noc`
(view / create=advance-stage / edit / approve=approve-quote) and `fire_noc_master_db`
(view / create=ingest). Default mapping: Admin → all; Sales Head → most; Sales →
view/edit/advance/master-db.view.

### Main screen / tabs

| Tab | Content |
|---|---|
| **Dashboard** | KPI tiles + per-stage funnel counts + next-7-days expiries |
| **Cycles** | Searchable cycle list with state / stage / status filters; create + import |
| **State Rules** | The state × building-type × cycle-years renewal-period lookup |

Cycle list columns/CSV: building name, customer, state, building type, expiry date,
days-to-expiry, current stage, status. A cycle drawer shows stage history and lets a
user **advance the stage** or add a **free-text note**.

### The stage state-machine

Internal stage codes (DB enum) with human labels (mam: *"t is time, t-30 means
required 30 days — don't show t-30"*, so labels read "30 days before · …"):

```
T-180  (180 days before · Auto Alert)
T-150  (150 days before · Qualify)
T-120  (120 days before · Quote v1)
RESPONSE_CHECK · REENGAGE
T-90   (90 days before · Site Visit)
CONVERT_CHECK · LOST_POOL (Lost · Win-Back)
T-60   (60 days before · PO + 30%)
T-45   (45 days before · Dept Filing)
T-30   (30 days before · Inspection)
INSPECTION_CHECK · COMPLIANCE_FIX
T-15   (15 days before · NOC Issued)
T-0    (Expiry day · Final Pay)
T+30   (30 days after · Upsell)
CYCLE_CLOSE
```

### Renewal-period lookup (formula)

The cycle length (how often a NOC must be renewed) comes from
`fire_noc_state_cycle_rule`, resolved **most-specific-first**:

1. match `(state, building_type)`,
2. else `(state, NULL)`,
3. else the `__DEFAULT__` row (5 years, low-risk).

Seeded rules: UP & Maharashtra hospital/school = **1 year**; Karnataka = **2 years**;
Delhi / Gujarat / Tamil Nadu = **3 years**; default = **5 years**.

### Key fields

- **Property** (`fire_noc_property`): building registry (FK customers), inline
  `decision_maker_*` contact columns.
- **Cycle** (`fire_noc_cycle`): `current_stage`, `status` (`active` → `lapsed`),
  `expiry_date`, `days_to_expiry`. Indexed on expiry/stage/status.
- **Stage history** (`fire_noc_stage_history`): every transition with `triggered_by`;
  `UNIQUE(cycle_id, to_stage, entered_at)` so the cron can re-fire idempotently.
- **Master DB** (`master_noc_database`): RTI / past-client / broker / field-scrape
  lead pool (sources: `rti`, `past_client`, `broker`, `field_scrape`, `manual`).

### Step-by-step workflow

1. Create a cycle (state, district, building type/name, address, pincode, expiry
   date, source) — or **bulk import** via CSV (with Levenshtein-style dedup helper).
2. The cycle enters at the stage matching its days-to-expiry.
3. Each hour the **auto-pilot cron** recomputes `days_to_expiry` and advances the
   stage when a threshold is crossed, logging the change with
   `trigger='hourly_cron'`.
4. The team works the funnel: quote (maker-checker), site visit, PO + 30% advance,
   department filing, inspection (pass → NOC issued; fail → compliance-fix tickets),
   final payment, then **T+30 upsell** (AMC / Annual Audit / Refilling / Training).
5. When expiry passes, status flips `active → lapsed`. Cycle ends at `CYCLE_CLOSE`.

### Automations / crons / statuses

- **`server/scripts/fireNocCron.js` — hourly auto-pilot.** First run 60 s after boot,
  then every hour. For every non-terminal cycle it recomputes days-to-expiry,
  advances the stage across thresholds, flips `active → lapsed` on expiry, and logs to
  `fire_noc_stage_history`. Disable with `ERP_DISABLE_FIRE_NOC_CRON=1`.
- **Boot-time backfill** (`backfillOnceOnBoot`) runs the sync once for the 100+ rows
  imported before auto-sync existed (guarded by `app_settings.fire_noc_autosync_backfilled_v1`).
- The real advancement logic lives in `server/lib/fireNocSync.js` (`syncAllActiveCycles`).

### Print outputs

Quotes print as an HTML view → browser **Save-as-PDF** (same pattern as Salary Slip /
Vendor PO), per `docs/FIRE_NOC.md` (`/fire-noc/quote/:id/print`).

### API endpoints

All under `/api/fire-noc`, guarded by `fire_noc`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/dashboard` | KPI tiles + funnel + upcoming expiries |
| GET | `/cycles` | Cycle list (state/stage/status/q filters) |
| GET | `/cycles/:id` | One cycle + stage history |
| POST | `/cycles` | Create a cycle |
| GET | `/cycles/import/template` | CSV import template |
| POST | `/cycles/import` | Bulk import (multipart upload) |
| POST | `/cycles/:id/advance` | Manually advance a cycle to a stage |
| PATCH | `/cycles/:id` | Edit cycle fields |
| POST | `/cycles/:id/note` | Add a free-text note |
| GET | `/state-rules` | State × building-type × cycle-years rules |

### DB tables

11 tables (idempotent `CREATE TABLE IF NOT EXISTS`), defined in
`server/db/fireNocSchema.js`: `fire_noc_property`, `fire_noc_cycle`,
`fire_noc_stage_history`, `fire_noc_outreach`, `fire_noc_quote`, `fire_noc_document`,
`fire_noc_inspection`, `fire_noc_compliance_ticket`, `fire_noc_upsell`,
`master_noc_database`, `fire_noc_state_cycle_rule`.

---

## 5.5 Sales Billing

There are **two** sales-bill flows, both writing to `sales_bills`. They are described
separately below.

### 5.5.1 The 4-type sequential module (`/installation`)

#### Business purpose

Generate client sales bills in **four sequential stages** that mirror the real
project workflow, ending in a Final bill against which payment is received. The order
is picked from the **Business Book** (customer + items auto-fill as reference); the
**amounts are typed manually** on each bill. Design source: `SALES-BILLING-MODULE.md`.

The page **replaces the old Installation tracker** and is mounted at the `/installation`
route (`App.jsx` renders `<SalesBilling/>` for `module="installation"`), so it reuses
the `installation` permission for RBAC (Admin + Accounts: anyone with installation
create/edit, or admin).

#### The 4 bill types

| # | Name | Trigger | Auto-filled (reference) | You type | Status set |
|---|---|---|---|---|---|
| 1 | **Sales Order Bill** | Order booked | Customer, items, ordered qty, rate (Business Book) | Bill amount, GST, date | ORDER BOOKED |
| 2 | **Material Delivery Bill** | Material delivered | Type-1 items + delivery challan | Delivered qty, amount (≤ Type 1), GST | MATERIAL DELIVERED |
| 3 | **Installation Bill** | DPR approved (`billing_ready`) | The approved DPR ref | Installation charges, GST | INSTALLATION COMPLETE |
| 4 | **Final / Commissioning Bill** | Testing & commissioning signed off | Testing/handover ref | Commissioning charges, GST, final total | READY FOR PAYMENT |

> **In-module sequence is `1 → 3 → 4`.** The create endpoint explicitly **rejects
> Type 2** with *"Type 2 (material delivery) is billed in Dispatch, not here."* — so
> in this page material-delivery billing is handled by the Dispatch/delivery-note
> flow (§5.5.2), and the chain enforced here is 1 → 3 → 4. Each type requires every
> earlier type in the sequence to exist, and links to the previous via
> `previous_bill_id`.

#### Page tabs

`Dashboard`, `Sales Order Bills`, `Material · PO vs Bill`, `DPR / Installation Bills`.
The DPR tab has a **Generate Installation Bills** button (creates Type-3 bills from
approved DPRs). The list shows bill number, type, customer, project, amount, GST
(`gst_amount @ gst_rate%`), total, status, approval status.

#### Numbering

```
SEPL/SB/26-27/001
```

Company format, **financial-year aware** (26-27 = FY Apr 2026 – Mar 2027), sequence
**resets per FY**, zero-padded to 3. Generated by `nextBillNumber()` which scans
existing `SEPL/SB/<FY>/%` numbers and increments.

#### GST formula (single rate per bill)

```
gst_amount   = round2(amount × gst_rate / 100)
total_amount = round2(amount + gst_amount)
```

One GST % per bill (default 18). The auto-generated installation bills hard-code
`gst_rate = 18` (installation service GST).

#### Type-4 auto-sum

When creating the **Type-4 Final** bill, the amount is **pre-filled with the sum of
the prior bills in the chain** (T1+T3) and the user adds the commissioning charge on
top — the field stays **editable**.

#### Payment → Receivables

When a **Type-4** bill is approved, a `receivables` row is auto-created (invoice =
Type-4 total, `invoice_number` = the bill number, deduped against existing). Payments
are then entered against it and tracked by the existing receivables ageing screen —
no new payment screen. Payment entry is only enabled on Type 4.

#### Validation rules

- Can't create Type N without the earlier types in the `1→3→4` sequence.
- Type 2 is rejected here (Dispatch handles it).
- A bill can't be deleted if a later-type bill in its chain exists.
- A bill is `draft → approved` (single-step, Admin + Accounts).

#### Step-by-step workflow

1. **New Sales Bill** → pick a Business Book order → the system offers the next
   allowed type in that order's chain.
2. Reference fields auto-fill from the order/DPR; you type amount + GST + date.
3. Save → bill created as `draft` with computed GST/total and a status-log row.
4. Admin/Accounts **approve** (`draft → approved`).
5. For Type-3, DPRs flagged `billing_ready` can be swept into bills via **Generate
   Installation Bills** (also runs fortnightly via cron, below).
6. On Type-4 approval → receivables row created → payments tracked downstream.

#### Automations / crons

- **`server/scripts/installationBillingCron.js` — fortnightly (1st & 16th).**
  Auto-generates Type-3 installation bills from approved/`billing_ready` DPRs.
  Disable with `ERP_DISABLE_INSTALL_BILLING=1`.

#### API endpoints

All under `/api/sales-billing` (guarded by `installation`).

| Method | Path | Purpose |
|---|---|---|
| GET | `/orders` | Business Book orders pickable for billing |
| GET | `/orders/:bbId` | One order (items/rates for reference) |
| GET | `/` | Bill list |
| GET | `/pending` | Pending bills |
| GET | `/material` | Material PO-vs-bill view |
| GET | `/:id` | One bill |
| POST | `/` | Create a bill (type 1/3/4; chain-validated) |
| PUT | `/:id/approve` | Approve (`draft → approved`); Type-4 spawns receivable |
| DELETE | `/:id` | Delete bill (blocked if a later type exists) |
| PUT | `/:id/sent` | Mark bill sent |
| POST | `/:id/payment` | Record payment (Type-4) |
| POST | `/generate-installation` | Sweep approved DPRs into Type-3 bills |

#### DB tables

`sales_bills` (master — the 4-type columns `bill_type`, `business_book_id`,
`customer_name`, `bill_status`, `previous_bill_id`, `reference_doc_type/_no`,
`approval_status`, `payment_status`, `project_name`, `gst_rate` are added by
migration so legacy rows still work), `sales_bill_items` (line snapshot),
`sales_bill_status_log` (audit trail). Reuses `business_book` + `po_items`,
`delivery_notes`, `dpr`/`billing_ready`, `receivables` + `payments`.

---

### 5.5.2 The delivery-note-driven Sales Bill / Tax Invoice (procurement.js)

#### Business purpose

This is the flow that produces the **actual printable SEPL Tax Invoice** to the
client. A delivery note is converted into a sales bill; the printable invoice carries
the GST split (CGST+SGST vs IGST) and the **Against-Delivery "Payment Due"** line.
Recent work made the print **recover the client from the Business Book order via PO
items** for the BILL-TO / SHIP-TO block and dropped the redundant "Taxable Value"
column.

#### GST split formula (CGST+SGST vs IGST)

The split is decided by **place of supply vs SEPL's Punjab GSTIN**:

```
intra-state (client state blank or Punjab)  → CGST 9% + SGST/UTGST 9%, IGST 0
inter-state (a known other state)           → CGST 0 + SGST 0, IGST 18%
```

(SEPL GSTIN `03AASCS7836D2Z3` — state code 03 = Punjab.) For sales bills the percent
is **recomputed at print time** from the client state so only the correct lines show:

```
cgst = subtotal × cgstPct / 100
sgst = subtotal × sgstPct / 100
igst = subtotal × igstPct / 100
grandTotal = subtotal + cgst + sgst + igst + freight + roundOff
```

#### Against-Delivery "Payment Due" formula

The order's **Against-Delivery %** comes from `business_book.payment_against_delivery`
(parsed to a number). The print adds a highlighted line:

```
Payment Due (Against Delivery <pct>%) = Grand Total × pct / 100
```

For generated sales-bill line rates, mam's rule (2026-06-15) is **"BOQ item rate ×
against-delivery terms %"** when generating against delivery; the MD later directed
that the printed sales bill bills the **full BOQ rate** (the Against-Delivery % then
only drives the Payment-Due line, not the line rate). The client + Against-Delivery %
are recovered from the **Business Book order** that the delivery note's PO items
belong to.

#### Key endpoints (under `/api/procurement`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/delivery-notes` | Delivery-note list |
| POST | `/delivery-notes` | Create a delivery note (multipart) |
| POST | `/delivery-notes/:id/sales-bill` | Attach/raise a sales bill on a DN |
| POST | `/delivery-notes/:id/generate-sales-bill` | Generate a sales bill from a DN |
| POST | `/auto-sales-bills/sweep` | Bulk auto-create sales bills |
| GET | `/delivery-notes/:id/print` | Printable Delivery Note / **Sales Bill (Tax Invoice)** HTML |
| GET | `/sales-bills` | Sales-bill list |
| POST | `/sales-bills` | Create a sales bill |

#### Print output

`GET /api/procurement/delivery-notes/:id/print` renders the full SEPL HTML invoice:
GSTIN/PAN header, company block (Ludhiana HO + Noida + pan-India presence), BILL-TO /
SHIP-TO recovered from the Business Book order, line items, subtotal, the
conditional CGST/SGST/IGST rows, freight, round-off, Grand Total, and the
Against-Delivery **Payment Due** line. Output to PDF via the browser.

#### DB tables / columns

Shares `sales_bills` (the procurement flow uses columns such as `cgst_pct`,
`sgst_pct`, `igst_pct`, `freight_amount`, `round_off_amount`, `place_of_supply`,
`state_code`, `reverse_charge`, `subtotal`, `grand_total_amount`, `items_json`,
`sales_bill_number`, `sales_bill_pending`, added by migration), plus `delivery_notes`
and `business_book` / `po_items` for the BILL-TO/SHIP-TO and Against-Delivery lookup.
