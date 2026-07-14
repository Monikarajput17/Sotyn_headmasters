# 6. Finance

The Finance domain of the SEPL ERP covers everything that moves money in or out of the company and everything that tracks money the company is owed or owes. It is implemented as six largely independent modules, each with its own React page, Express route file, and database tables, but they are wired together by a small set of shared helpers (`server/lib/cashSync.js`) and crons so that one user action (e.g. recording a client collection) ripples into the receivables ledger, the sales-bill payment status, and the daily cash-flow ledger without any manual reconciliation.

The six modules documented here are:

| # | Module | React page | Route file | Primary tables |
|---|--------|-----------|-----------|----------------|
| 6.1 | Cheques (Cheque FMS) | `client/src/pages/ChequeFMS.jsx` | `server/routes/cheques.js` | `cheques`, `cheque_actions` |
| 6.2 | Payables (Payment Required) | `client/src/pages/PaymentRequired.jsx` | `server/routes/paymentrequired.js` | `payment_requests`, `payment_approvals`, `payment_approval_overrides` |
| 6.3 | Collections (Receivables) | `client/src/pages/Collections.jsx`, `client/src/pages/admin/CollectionsMD.jsx` | `server/routes/collections.js` | `receivables`, `collections`, `collection_follow_ups` |
| 6.4 | Invoices / Billing | `client/src/pages/Billing.jsx` | `server/routes/installation.js` (+ `salesBilling.js` for sales bills) | `ra_bills`, `mb_bills`, `installation_bills`, `sales_bills` |
| 6.5 | Cash Flow | `client/src/pages/CashFlow.jsx` | `server/routes/cashflow.js` | `cash_flow_daily`, `cash_flow_entries`, `project_finance` |
| 6.6 | Expenses | `client/src/pages/Expenses.jsx` | (expenses route) | `expenses` |

All Express routers in this domain mount `authMiddleware` (every endpoint requires a valid session) and most enforce a per-module `requirePermission(module, action)` check, where `action` is one of `view / create / edit / approve / delete`. The module keys used by the permission system are `cheques`, `payment_required`, `collections`, `cashflow`, `billing`, `installation`, and `expenses`.

A cross-cutting design principle visible throughout this domain is **audit fidelity**: rows that have downstream effects (a cheque with a logged action, a receivable with a recorded collection, an installation with bills) cannot be casually deleted — the API returns a `409 Conflict` and tells the user to cancel/reverse instead. Money amounts are stored in **raw rupees** (no lakh conversion) after the `pf_amounts_raw_rupees_v1` migration; only the display layer divides by 100000 when it wants "lakhs".

---

## 6.1 Cheques (Cheque FMS)

### Business purpose

The Cheque Financial Management System tracks the full life-cycle of every physical cheque the company issues — from the moment it is raised, through the date it is presented, to its final outcome (cleared, bounced, stopped) or its post-dated hold and follow-up. It gives Finance a single register of cheques in flight, with action-due alerts so nothing is forgotten on the day a cheque becomes presentable.

### Who uses it

Finance / accounts staff with the `cheques` permission. `view` to read the register, `create` to issue a cheque, `edit` to log actions, `delete` only for cheques that have no action history.

### The 3-stage workflow

The module is built around a deliberate three-stage flow (documented at the top of both the route file and the page):

1. **Stage 1 — Raise / Issue.** Capture the cheque's core details: cheque number, payee, bank, cheque date, amount, optional photo of the cheque. The cheque enters `current_status = 'pending'` (or `'cancel'` if issued cancelled).
2. **Stage 2 — Action on/after the cheque date.** Once `cheque_date <= today`, the user logs an outcome via a dropdown: `clear`, `hold`, `bounce`, `stopped` (also `cancel`, `re_issue`). Every action requires **remarks**. A `hold` action additionally requires a **Next Date** (`next_date`), which is written to `cheques.hold_until`.
3. **Stage 3 — Follow-up on/after the hold date.** For held cheques, when `hold_until <= today` the cheque re-appears as "action due" and the user logs the next action (clear it, hold again, bounce, etc.).

### Statuses

| `current_status` | Meaning | Terminal? |
|------------------|---------|-----------|
| `pending` | Issued, awaiting its cheque date / presentation | No |
| `hold` | Post-dated / held until `hold_until` | No |
| `clear` | Cleared by the bank | Yes |
| `bounce` | Bounced | Yes |
| `stopped` | Payment stopped | Yes |
| `cancel` | Cancelled | Yes |

Once a cheque is in a terminal state (`clear / bounce / stopped / cancel`) the `/:id/action` endpoint refuses further actions. `re_issue` re-opens a held cheque back to `pending` (rare).

### Key fields

- `cheque_number`, `payee_to`, `cheque_date`, `amount` (all required at creation).
- `bank_name` — constrained to an allow-list: `HDFC`, `ICICI`, `SBI`, `PNB CC`, `PNB Saving`, `Other`; free-text `bank_other` when "Other".
- `photo_url` — optional uploaded image, stored under the shared `/data/uploads` dir (same one POs and Sales Bills use), served at `/uploads/...`.
- `issue_status` — `approved` (default) or `cancel`.
- `hold_until` — set when an action is `hold`, cleared otherwise.
- `raised_by` — FK to `users`.

### Duplicate guard

On create, the module calls `utils/duplicateGuard` to block re-entry of the same physical cheque: a duplicate is defined as **same cheque number + same bank**. If a match is found the API returns a duplicate error instead of inserting.

### Screen (ChequeFMS.jsx)

Filter tabs / status tiles at the top: **All**, **Action Due** (red — pending whose cheque date has arrived OR hold whose hold date has arrived), **Pending**, **On Hold**, **Cleared**, **Bounced**. Each tile shows a count; the "Total Value" tile changes to the action-due amount sum when Action Due is selected. A colour-coded `StatusBadge` renders each cheque's status (with the due date appended). The "+ Issue Cheque" button opens the Stage-1 form; a per-row action button opens the Stage-2/3 action modal (dropdown + remarks + conditional next-date).

### Automations / computed fields

- `action_due` flag (computed in SQL on every list query): `1` when a `pending` cheque's `cheque_date <= today` OR a `hold` cheque's `hold_until <= today`. Drives the red "Action Due" highlight.
- `action_count` per cheque (sub-select count of `cheque_actions`).
- The audit report (`auditReport.js`) counts open cheques (`pending` + `hold`) as a finance exception metric.

### Endpoints

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/api/cheques` | cheques.view | List with filters: `status`, `bank`, `search`, `action_due=1`. Returns `action_due` flag + `action_count`. |
| GET | `/api/cheques/:id` | cheques.view | One cheque with its full `cheque_actions` history. |
| POST | `/api/cheques` | cheques.create | Stage 1 — raise/issue (multipart, optional photo). Duplicate-guarded. |
| PUT | `/api/cheques/:id` | cheques.edit | Edit Stage-1 details — **only while no action is logged** (audit integrity). |
| DELETE | `/api/cheques/:id` | cheques.delete | Delete — **only while no action is logged**; else returns 400 (cancel instead). |
| POST | `/api/cheques/:id/action` | cheques.edit | Stage 2 + Stage 3 — log an action (clear/hold/bounce/stopped/cancel/re_issue). Remarks required; hold requires next_date. |
| GET | `/api/cheques/stats/summary` | cheques.view | Dashboard cards: per-status count + amount totals, plus action-due count and amount. |

### DB tables

- **`cheques`** — `id`, `cheque_number`, `payee_to`, `bank_name`, `bank_other`, `cheque_date`, `amount`, `photo_url`, `issue_status`, `current_status`, `hold_until`, `raised_by`, `created_at` (`raised_at`), `updated_at`.
- **`cheque_actions`** — `id`, `cheque_id` (FK), `action`, `remarks`, `next_date`, `action_by` (FK), `action_at`. One row per logged action; provides the immutable audit trail.

---

## 6.2 Payables — Payment Required

### Business purpose

Payment Required is the company's outbound-payment approval engine. Any employee who needs the company to pay money — a vendor purchase, a labour bill, transport, a salary advance, TA/DA travel reimbursement, a compliance fee — raises a **payment request** here. The request then walks a fixed multi-level approval chain. Only after the final release step is the payment booked as a cash-flow outflow.

### Who uses it

- **Requesters** — any employee with `payment_required.create` (site engineers, purchase staff, etc.). A requester who is not an approver sees only their own requests.
- **Approvers** — the four named/role-based approvers in the standard flow (see below), who have `payment_required.approve`.
- **Admin** — sees everything and can override routing.

Scope rule: a user "sees all" requests iff they are admin OR one of their roles has `can_approve=1` or `can_see_all=1` on `payment_required`; otherwise the list, stats, and single-GET are filtered to `created_by = self`.

### The standard approval flow (mam 2026-06-11)

As of June 2026 **every category uses one standard chain** (the old per-category chains — HR / Purchase-head / Site-engineer plus an automatic Velocity Check and Billing Engineer — were retired). The chain is:

| Step | Stage name | Approver | Type |
|------|-----------|----------|------|
| 1 | L1 Approval (Accountant) | anyone holding the **Accountant** role | role-based |
| 2 | L2 Approval (Nitin Jain) | **Nitin Jain** | named person |
| 3 | L3 Approval (MD – Ankur Kaplesh) | **Ankur Kaplesh** (MD) | named person |
| 5 | Payment Release (Aanchal) | **Aanchal** | named person |

Step numbers are deliberately `1, 2, 3, 5` (not `1,2,3,4`) so requests already in flight on the legacy steps keep flowing; the retired Billing-Engineer step 4 was migrated to step 5. The same `STANDARD_FLOW` array is assigned to every category in the `WORKFLOW` map: `TA/DA`, `Purchase`, `Labour`, `Transport`, `Salary`, `Compliance`.

Named approvers are resolved to a live `users` row by name (exact match first, then a loose `LIKE`) via `resolveUserByName()`, so the flow survives across the local and production databases without hard-coded user ids.

A guarded one-time migration `pr_standard_flow_v1` runs at module load: it clears all old per-category routing overrides (so they don't shadow the new named approvers) and moves any request parked on retired step 4 to step 5. It is recorded in `app_migrations` so it executes exactly once.

### Per-step routing overrides

Admins can re-route any `(category, step)` to a specific user via the **Approval Routing** matrix (a table at the bottom of the page). Overrides live in `payment_approval_overrides (category, step, user_id)`. When an override exists, **only** that user (or admin) can approve that step — there is no fallback to the role. Clearing an override (user_id = null) returns the step to its role/named default.

The function `canUserApproveStep(db, userId, category, step)` decides authority in this order:
1. Admin → always allowed.
2. Explicit override set → only the assigned user.
3. Named approver on the step (`approver_name`) → only the resolved user.
4. Otherwise role-based → any user whose role matches `approver_role`.

### Step-by-step workflow

1. **Create** (`POST /`): requester fills the form. Required: employee name, category, amount, purpose. Category-specific mandatory fields/proofs are enforced:
   - **Purchase** → `vendor_name` required; `quotation_link` (Quotation / PO) required.
   - **TA/DA** → if mode is Bus/Train/Flight, a travel ticket upload is required; if Car/Bike, both Start KM and End KM photos are required.
   - **Required By Date** (if given) must be at least **today + 5 days** (no same-day payouts).
   - A request number `PR-<year>-NNNN` is generated via `nextSequence`. Push notifications fire to all approvers; an email event `payment.requested` is fired.
2. **Approve** (`PUT /:id/approve`): the current-step approver supplies **remarks (min 5 chars)** and optionally an **approved_amount**. The amount is **decrease-only** — it must be `> 0` and `<= original requested amount` (an approver can pay less, never more). Each approval writes a `payment_approvals` row with `step_amount` (what this step agreed) and updates `payment_requests.approved_amount` to the latest agreed figure.
3. **Advance** (`advanceToNextStep`): on approval the request moves to the next step in the chain. When the **last** step (Payment Release) is approved, `status` becomes `final_approved` AND a cash-flow **outflow** entry is auto-created in `cash_flow_daily` / `cash_flow_entries` for `COALESCE(approved_amount, amount)` — i.e. the latest approver-agreed figure, not the original request.
4. **Reject** (`PUT /:id/reject`): any current-step approver can reject with remarks; `status` → `rejected`, with `rejected_by`/`rejected_at`/`rejection_remarks` recorded. An email event `payment.rejected` fires.

Email events `payment.approved` are fired per step. All emails route to the requester and the director (best-effort recipient resolution).

### Status column

`Pending → Approved → Paid` as seen by the user, mapped from the underlying state:
- **Pending** — `status NOT IN ('final_approved','rejected')`, i.e. still walking the chain (the Step column shows which level it is parked on).
- **Approved / Paid** — `status = 'final_approved'` (all four sign-offs done; outflow booked).
- **Rejected** — `status = 'rejected'`.

### Per-level "Approved by L1 / L2 / L3" views (mam 2026-06-15)

Beyond the standard tabs (**Dashboard**, **All Requests**, **Pending**, **Approved**, **Rejected**), the page offers per-level filters **Approved by L1 / L2 / L3**. Selecting one shows the requests that level has signed off, and the **Approval Amt** column shows the specific amount **that level** approved (from `payment_approvals.step_amount`, keyed by step). The list responses enrich each row with a `step_amounts` map `{ step: amount }`. The Approval Amt column shows the agreed amount once any level approves, otherwise the requested amount greyed out.

The Dashboard tab always renders the full standard flow (L1 → L2 → L3 → Release) as stages, even a stage with zero rows, so L3 (Ankur Kaplesh) is never hidden.

### My Inbox

`GET /my-inbox` returns the pending requests whose **current step's approver is the logged-in user** (via override or role/named match), enriched with the workflow progress. `GET /my-inbox-count` returns just `{ count }` and is polled every 60s by the header bell badge. (The Inbox tab itself was removed from the page UI but the endpoints remain.)

### Vendor pickers & request detail fields

The create form carries category-specific fields stored on `payment_requests`: travel (`travel_from_to`, `travel_dates`, `mode_of_travel`, `stay_details`, `ticket_upload`, `start_km`/`end_km` + photos), purchase (`indent_number`, `item_description`, `vendor_name`, `quotation_link`), labour (`labour_type`, `number_of_workers`, `work_duration`, `site_engineer_name`), transport (`vehicle_type`, `from_to_location`, `material_description`, `driver_vendor_name`), plus `site_id`/`site_name`, `department`, `contact_number`, `payment_mode`. Proofs missed at submit time can be attached later via `PATCH /:id/proof` (fields: `ticket_upload`, `km_photo`, `end_km_photo`, `quotation_link`, `attachment_link`).

### Cash-flow integration & velocity helper

The route file also contains `isInTop3Velocity()` (cash-velocity ranking of projects) used historically by the retired auto Velocity Check; with the standard flow there is no longer any auto-advance or auto-reject. The cashflow tracker reads "Purchase value" from `payment_requests WHERE category='Purchase'` for a site (see 6.5).

### Endpoints

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/api/payment-required` | view | List w/ filters: `status`, `category`, `step`, `search`, `date_from`, `date_to`. Scope-filtered. Enriched with `current_step_name`, `next_approver_name/role`, `last_approved_*`, `approvals_count/total`, `step_amounts`. |
| GET | `/api/payment-required/stats` | view | Counts + amounts (total / pending / approved / rejected, by category, by step). Scope-filtered. |
| GET | `/api/payment-required/my-inbox` | view | Requests awaiting **this user's** action. |
| GET | `/api/payment-required/my-inbox-count` | view | `{ count }` for the bell badge (60s poll). |
| GET | `/api/payment-required/:id` | view | Single request + `approvals[]` + `workflow` + `can_approve_current`. Ownership-checked. |
| POST | `/api/payment-required` | create | Create a request (validates proofs, vendor, +5-day rule). |
| PUT | `/api/payment-required/:id/approve` | approve | Approve current step (remarks ≥5 chars; optional decrease-only approved_amount). |
| PUT | `/api/payment-required/:id/reject` | approve | Reject current step (remarks required). |
| DELETE | `/api/payment-required/:id` | delete | Delete request + its approvals. |
| PATCH | `/api/payment-required/:id/proof` | view | Attach a proof URL after the fact. |
| GET | `/api/payment-required/approval-routing` | (auth) | Routing matrix: every category × step with default + override assignee. |
| PUT | `/api/payment-required/approval-routing` | admin only | Set/clear a `(category, step)` override. |

### DB tables

- **`payment_requests`** — the request header: `request_no`, `employee_name`, `site_id/site_name`, `department`, `category`, `amount`, `approved_amount`, `purpose`, `payment_mode`, `required_by_date`, `current_step`, `status` (`pending…`/`final_approved`/`rejected`), `rejection_remarks`/`rejected_by`/`rejected_at`, `created_by`, plus the category-specific columns listed above.
- **`payment_approvals`** — one row per approval/rejection: `request_id`, `step`, `step_name`, `action` (`approved`/`rejected`), `remarks`, `step_amount`, `approved_by`, `approved_at`. The per-step audit trail (Original 600 → L1 500 → …).
- **`payment_approval_overrides`** — `(category, step)` PK → `user_id`, `updated_at`, `updated_by`. Routing overrides.
- **`app_migrations`** — `key` PK, `applied_at`. Guards one-time migrations like `pr_standard_flow_v1`.

---

## 6.3 Collections (Receivables)

### Business purpose

Collections manages money the company is **owed** by clients — the accounts-receivable ledger. Each receivable is an outstanding invoice (or advance) against a client/site. The module tracks the billed amount, what has been received, what remains outstanding, how overdue it is (ageing), and the CRM follow-up activity behind each unpaid balance. Recording a collection here automatically updates the receivable, syncs the linked sales bill's payment status, and posts an inflow to cash flow.

### Who uses it

- **CRM / collections staff** with the `collections` permission — create receivables, edit them, log follow-ups, record collections.
- **MD / management** — the read-only **Collections MD** dashboard (`CollectionsMD.jsx`) correlates outstanding money with chasing activity per site.

### Main screen (Collections.jsx)

- **Ageing-bucket summary tiles** across the top — count + total per bucket.
- **Payment Target vs Received (with ageing)** panel — per-bucket Target / Received / Outstanding / Collection % (from `/target-summary`).
- **Receivables table** — columns: Site/Client, CRM, Invoice #, Invoice Date, Invoice Amount, Received, Outstanding, Due Date, Ageing (days), Bucket, Status, Follow-up Status, Owner. Each row exposes its individual collection installments (`payments[]`) and a `pms_tasks_count`.
- **Refresh Ageing** button → `POST /refresh-ageing` (same code path as the 01:00 cron).
- **Follow-up** modal — log a contact attempt; **Collect** modal — record a payment.

### Ageing & status formulas (`server/lib/cashSync.js`)

**Ageing** (`calculateAgeing(dueDate)`):
```
days   = max(0, floor((today − due_date) / 1 day))
bucket = '0-30'   if days ≤ 30
         '31-60'  if 30 < days ≤ 60
         '61-90'  if 60 < days ≤ 90
         '90+'    if days > 90
```
(No due date → `{ days: 0, bucket: '0-30' }`.)

**Status colour** (`getStatusColor(outstanding, ageingDays)`):
```
green   if outstanding ≤ 0           (fully collected)
red     if ageingDays > 60
yellow  if ageingDays > 30
green   otherwise
```

**Collection %** (per bucket and overall): `received / target × 100`, where target = `SUM(invoice_amount)`, received = `SUM(received_amount)`.

### Step-by-step: recording a collection (`POST /:id/collect`)

1. Insert a `collections` row (amount, date, payment_mode, transaction_ref, notes, collected_by).
2. Update the parent `receivables` row: `received_amount += amount`, `outstanding_amount = invoice_amount − received`, and recompute ageing/bucket/status.
3. **A9 sync** — if `receivables.invoice_number` matches a `sales_bills.bill_number`, recompute that bill's `payment_status` (`pending` / `partial` / `paid`) from received vs total.
4. **A14 cash-flow link** — ensure today's `cash_flow_daily` row exists (opening = yesterday's closing), then insert an **inflow** `cash_flow_entries` row tagged `reference_type='collection'`, and recompute the day's totals/closing balance.

### Follow-ups

`POST /:id/follow-up` records a `collection_follow_ups` row (date, contact method, response, promised date/amount) and bumps the receivable's follow-up status to `contacted`. `GET /:id/follow-ups` lists them.

### Collections MD dashboard (CollectionsMD.jsx + `/md-dashboard`)

One row **per site**, sorted by outstanding DESC, joining money with activity:
- target / received / outstanding / invoice_count / oldest_ageing,
- `pms_tasks_count` (CRM follow-up tasks raised for the site),
- `location_pings_7d` (GPS pings to the site in the last 7 days — proxy for "is anyone visiting"),
- `last_follow_up`, `next_planned_date`, `last_discussion`,
- `indents_count` / `indents_30d`, `materials_value_sent`, `dpr_count_30d`.

**Silent Overdue Sites** callout — flags rows where `outstanding > 0 AND oldest_ageing > 30 AND pms_tasks_count = 0 AND location_pings_7d = 0` (significant overdue money with zero recent chasing). MD can click the tile to filter to just those sites. Overall **Collection %** = `100 × received / target`.

### DSO (Days Sales Outstanding)

DSO is surfaced on the CMD/Finance dashboards (`DashboardCMD*.jsx`, fed by `computeKpiPayload` in `auditReport.js`), not on the Collections page itself:
```
DSO = round( AR_outstanding / sales_in_window × window_days )
```
where `AR_outstanding = SUM(receivables.outstanding_amount)` and `sales_in_window = SUM(sales_bills.total_amount)` over the window (default 30 days, clamped 7–365). It feeds the Cash Conversion Cycle `CCC = DSO + DIO − DPO`. The CMD War Room shows DSO as a lever: "Drop DSO to 60d → estimated cash unlock …".

### Receivable sources & pickers

The Add/Edit modal's site dropdown lists **unique project names from the Business Book** (`/sites`), since "site name is project name". Creating a receivable auto-derives `client_name` from `site_name` when missing. Editing recomputes outstanding/ageing/status when amount or due date changes, and defensively coerces stale `owner_id`/`site_id` FKs to NULL to avoid FK-constraint failures on save.

### Payment Advice print output

`GET /payment-advice?client=<name>&bbid=<id>` builds an **outstanding statement** for one client — every invoice with billed / received / pending, plus totals, and the client's company/address/GSTIN/state pulled from `business_book`. Rendered by the `PaymentAdvicePrint` page. (A separate **Debit Note** / Short Supply Notice print exists under Procurement — `DebitNotePrint.jsx`, `/debit-note/:id/print` — for rejected material / excess rate / short supply; it is procurement-owned, not part of the receivables ledger.)

### Endpoints

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/api/collections` | view | Receivables list (filters: `status`, `ageing_bucket`, `client`, `search`) + per-row `payments[]` + `pms_tasks_count`. |
| GET | `/api/collections/md-dashboard` | view | Per-site money ↔ activity dashboard + silent-overdue flag. |
| GET | `/api/collections/sites` | view | Unique Business-Book project names for the site dropdown. |
| GET | `/api/collections/summary` | view | Totals: outstanding, by bucket, by status, top 10 clients, overdue (>30d). |
| GET | `/api/collections/payment-advice` | view | Client outstanding statement (Payment Advice print). |
| POST | `/api/collections` | create | Create a receivable. |
| PUT | `/api/collections/:id` | edit | Quick or full edit (recomputes ageing/outstanding). |
| GET | `/api/collections/target-summary` | view | Target vs Received vs Outstanding + Collection %, overall and per bucket. |
| DELETE | `/api/collections/:id` | delete | Delete — **blocked (409)** if any collection has been recorded. |
| POST | `/api/collections/:id/follow-up` | edit | Add a follow-up. |
| GET | `/api/collections/:id/follow-ups` | view | List follow-ups. |
| POST | `/api/collections/:id/collect` | edit | Record a payment received (updates receivable, sales bill, cash flow). |
| POST | `/api/collections/refresh-ageing` | edit | Recompute ageing for all outstanding receivables (manual trigger of the daily cron). |

### DB tables

- **`receivables`** — `id`, `client_name`, `project_name`, `po_id`, `business_book_id`, `invoice_number`, `invoice_date`, `invoice_amount`, `received_amount`, `outstanding_amount`, `due_date`, `ageing_days`, `ageing_bucket`, `status` (colour), `follow_up_status`/`follow_up_date`/`follow_up_notes`, `escalation_level`, `owner_id`, `site_id`, `site_name`, `crm_name`, `next_planned_date`, `last_discussion`, `created_by`, timestamps.
- **`collections`** — `id`, `receivable_id` (FK), `amount`, `collection_date`, `payment_mode`, `transaction_ref`, `notes`, `collected_by`, `created_at`. One row per installment received.
- **`collection_follow_ups`** — `id`, `receivable_id` (FK), `follow_up_date`, `contact_method`, `response`, `promised_date`, `promised_amount`, `followed_by`, `created_at`.

---

## 6.4 Invoices / Billing

### Business purpose

The Billing page is the construction/installation billing workflow: it tracks the progressive bills raised against an installation job (RA → MB → Installation bills) and the outbound Sales Bills issued to the client. It is the bridge between "work done on site" and "money invoiced to the client". The legacy Installations page was superseded by the dedicated Sales Billing module (4-type sequential bills), but the RA/MB/Installation-bill scaffolding still lives in `installation.js` and is surfaced in the Billing page's tabs.

### Who uses it

Billing / projects staff with `billing` / `installation` permissions.

### Tabs (Billing.jsx)

| Tab | Source | Key columns |
|-----|--------|-------------|
| **Sales Bills** | `/procurement/sales-bills` | Bill No, PO, Date, Amount, **GST**, **Total**, Payment status |
| **RA Bills** | `/installation/ra-bills` | Bill No, Date, Work Done, Previous, Current, Status |
| **MB Bills** | `/installation/mb-bills` | Bill No, Amount, Status |
| **Installation Bills** | `/installation/inst-bills` | Bill No, Amount, Payment status |

### The progressive-bill chain

These bills form a referential hierarchy enforced by the delete guards in `installation.js`:

```
Installation (job)
   └── RA Bill        (Running Account — work_done / previous / current amounts)
         └── MB Bill  (Measurement Book — measurements + total)
               └── Installation Bill (final amount)
```

- An **RA Bill** captures running-account progress: `work_done_amount`, `previous_amount`, `current_amount` (the new claim this period). Status is updatable.
- An **MB Bill** references an RA bill and records `measurements` + `total_amount`.
- An **Installation Bill** references an MB bill and carries the final `amount`.
- **Sales Bills** (issued to the client) carry `amount`, `gst_amount`, `total_amount`, `payment_status` and are produced by the Sales Billing module (`salesBilling.js`); the Billing page reads them for display/export.

### GST split

Sales Bills store amount, GST, and total as separate columns (`amount` / `gst_amount` / `total_amount`). Across the ERP the standard GST rate is **18%** (the Business Book and Cash Flow tracker compute PO/Sale "with GST" as `Sale × 1.18`). For the receivables link, a sales bill is marked `paid` / `partial` / `pending` by comparing collected receipts to `total_amount` (the GST-inclusive figure).

### Bill numbering

Bill numbers for complaints and handover certificates use the shared `nextSequence` helper (`CMP-NNNN`, `HC-NNNN`). RA/MB/Installation bill numbers are supplied by the caller on create; Sales Bills are numbered by the Sales Billing module (4-type sequential bill numbering — see the Sales Billing module docs).

### Delete safety

Deletes cascade-guard up the chain (all return 409 when referenced):
- An installation cannot be deleted if RA/MB bills or handover certificates reference it.
- An RA bill cannot be deleted if MB bills reference it.
- An MB bill cannot be deleted if installation bills reference it.

### Related sub-modules in `installation.js`

The same router also serves **Testing & Commissioning** (`/testing`), **Complaints** (`/complaints`, numbered `CMP-`), **Handover Certificates** (`/handover`, numbered `HC-`), and a generic **Payments** ledger (`/payments` — `type`, `reference_type`, `reference_id`, amount, mode, ref).

### Automation — fortnightly installation billing cron

`server/scripts/installationBillingCron.js` (scheduled from `index.js`) runs on the **1st and 16th** of each month to auto-generate Type-3 installation Sales Bills, so progressive installation billing happens on a fixed fortnightly cadence without manual triggering.

### Endpoints (installation.js)

| Method | Path | Purpose |
|--------|------|---------|
| GET/POST/PUT/DELETE | `/api/installation` | Installations (jobs). |
| GET/POST/PUT/DELETE | `/api/installation/ra-bills` | RA bills. |
| GET/POST/PUT/DELETE | `/api/installation/mb-bills` | MB bills. |
| GET/POST/DELETE | `/api/installation/inst-bills` | Installation bills. |
| GET/POST/DELETE | `/api/installation/testing` | Testing & commissioning records. |
| GET/POST/PUT | `/api/installation/complaints` | Complaints (`CMP-` numbered). |
| GET/POST/PUT/DELETE | `/api/installation/handover` | Handover certificates (`HC-` numbered). |
| GET/POST | `/api/installation/payments` | Generic payments ledger. |

Sales Bills are served by `/api/sales-billing` and read via `/api/procurement/sales-bills`.

### DB tables

- **`installations`** — `po_id`, `site_address`, `start_date`, `end_date`, `assigned_to`, `status`, `notes`.
- **`ra_bills`** — `installation_id`, `bill_number`, `bill_date`, `work_done_amount`, `previous_amount`, `current_amount`, `status`.
- **`mb_bills`** — `ra_bill_id`, `installation_id`, `bill_number`, `measurements`, `total_amount`, `status`.
- **`installation_bills`** — `installation_id`, `mb_bill_id`, `bill_number`, `amount`, `payment_status`.
- **`sales_bills`** — `bill_number`, `po_id`, `bill_date`, `amount`, `gst_amount`, `total_amount`, `payment_status` (synced from collections).
- **`payments`** — generic `type`, `reference_type`, `reference_id`, `amount`, `payment_date`, `payment_mode`, `transaction_ref`, `notes`, `created_by`.
- Plus `testing_commissioning`, `complaints`, `handover_certificates`.

---

## 6.5 Cash Flow

### Business purpose

The Cash Flow module has two faces: a **daily cash ledger** (opening/inflows/outflows/closing per day, like a running cash book) and a **project financial tracker** (per-project sale value, received, purchase, cash velocity, payment days, and the locked last-payment-date). Together they answer "how much cash do we have, how is it moving day-to-day, and which projects are draining vs filling the tank".

### Who uses it

Finance staff and management with the `cashflow` permission. Non-admin users see only the projects where they are the assigned CRM, **unless** their role has `can_approve=1` or `can_see_all=1` on `cashflow` (then they see all, like Accountant/Auditor).

### Tabs (CashFlow.jsx)

1. **Project Finance** — the per-project tracker (default).
2. **Daily Cash Flow** — the daily ledger.

### Daily Cash Flow

Top cards for the selected date: **Opening**, **Inflows** (green, +), **Outflows** (red, −), **Closing** (purple). A last-7-days table and a per-date entries list. Add-entry form: type (inflow/outflow), category, description, amount, payment_mode, and **party_name (mandatory** — every entry must be tied to a counterparty for audit/BB linking).

Rollover logic (`cash_flow_daily`): each day's row carries `opening_balance`, `total_inflows`, `total_outflows`, `closing_balance`. When a date has no row, the system derives `opening = closing of the most recent prior day`. Adding or deleting an entry recomputes `closing = opening + inflows − outflows` for that day.

`closing_balance = opening_balance + total_inflows − total_outflows`

Entries arrive from three sources: manual entry, collections (inflows, tagged `reference_type='collection'`), and Payment Required final-release (outflows, paid at `COALESCE(approved_amount, amount)`).

### Project Finance tracker

One row **per project** (grouped by `business_book.company_name`), with columns: Sr, Project, CRM, **Sale ₹ (with GST)**, **Received ₹**, **Milestone**, **AR Cleared ₹**, **Aanchal ₹**, **Purchase ₹**, **Velocity**, **Live** (today), **Inv Days**, **Compl.**, **Pmt**, **Total**, **Last Pmt Date**.

Sources & formulas:
- **Sale (with GST)** = `bb.po_amount` (enforced as Sale × 1.18), summed across all BB rows of the project. (A critical fix dropped a `sites` JOIN that was inflating SUMs when a BB row had >1 site.)
- **Received** = sum of `cash_flow_entries` inflows whose `party_name` matches the client (or manual `amount_received`).
- **Purchase** = sum of `payment_requests WHERE category='Purchase'` for the site (or a manual override `manual_purchase_value`).
- **Aanchal / AR Cleared / Milestone / Inv Days / Completion / Payment days** = manual fields stored in `project_finance` (raw rupees, no lakh conversion).
- **Total days (R)** = effective completion days (P) + payment days (Q).
- **Cash Velocity (M)** = `(Aanchal − Purchase) / Total Days / 100000` (displayed in lakhs/day). The page's column tooltip frames velocity as "received ÷ purchase, ≥1 = cash-positive".
- **Last Pmt Date** — **Option A locked target**: computed once as `today + total_days` and written to `project_finance.last_payment_target_date`; it does **not** drift as the calendar moves. It is re-locked only when the user saves new days. Legacy rows are backfilled once on first read.

The page also exposes a **project breakdown** diagnostic (`/project-breakdown?company_name=…`) listing exactly which BB rows roll up into one project's totals, so management can audit a surprising sum (distinct clients sharing one company name).

### Runway formula

Runway is shown on the CMD/War Room dashboards (computed in `server/utils/cmdDashboard.js`), not on the Cash Flow page itself:
```
dailyBurn   = SUM(outflows over last 30 days) / 30
runway_days = round(cashOnHand / dailyBurn)      (null if burn = 0)
```
`cashOnHand` is the latest `cash_flow_daily.closing_balance`. The War Room colours the cash light green if runway > 90d, amber 30–90d, red < 30d.

### Automations / crons

`server/scripts/cashFidelityCron.js` (audit items A7 + A14; disable with `ERP_DISABLE_CASH_CRON=1`) runs two daily jobs via drift-corrected `setTimeout`:
- **00:00 — cash_flow_daily rollover** (`ensureTodayCashFlowDaily`): create today's row with `opening = yesterday's closing`, so runway/dashboards don't show wrong numbers on zero-collection days.
- **01:00 — receivables ageing refresh** (`refreshAllAgeing`): recompute ageing_days / bucket / status for every outstanding receivable (same code as the on-demand Refresh Ageing button).

### Endpoints

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/api/cashflow/projects` | view | Per-project tracker (CRM-scoped unless can_see_all). Returns projects[] + summary KPIs. |
| POST | `/api/cashflow/projects/:id/update` | edit | Save manual project-finance fields; re-locks last-payment date. |
| GET | `/api/cashflow/project-breakdown` | view | Which BB rows feed one project's roll-up. |
| GET | `/api/cashflow/daily` | (auth) | Daily ledger rows (date range filter). |
| GET | `/api/cashflow/today` | (auth) | Today's row (auto-creates with rolled-over opening). |
| GET | `/api/cashflow/summary` | (auth) | Selected-date opening/in/out/closing, last 7 days, MTD inflow/outflow. |
| POST | `/api/cashflow/entry` | (auth) | Add an inflow/outflow entry (party_name mandatory). |
| GET | `/api/cashflow/entries/:date` | (auth) | Entries for a date. |
| DELETE | `/api/cashflow/entry/:id` | (auth) | Delete an entry (recomputes the day). |
| POST | `/api/cashflow/opening-balance` | (auth) | Set/override a day's opening balance. |

### DB tables

- **`cash_flow_daily`** — `id`, `date` (unique), `opening_balance`, `total_inflows`, `total_outflows`, `closing_balance`, `created_by`, timestamps. One row per day.
- **`cash_flow_entries`** — `id`, `daily_id` (FK), `date`, `type` (`inflow`/`outflow`), `category`, `description`, `amount`, `payment_mode`, `party_name`, `reference_type`, `reference_id`, `created_by`, `created_at`.
- **`project_finance`** — `business_book_id` (FK), `amount_received`, `milestone_name`, `ar_cleared_value`, `aanchal_value`, `payment_investment_days`, `payment_days`, `manual_purchase_value`, `manual_completion_days`, `last_payment_target_date`, `updated_at`. Manual per-project overrides (idempotent `ALTER TABLE … ADD COLUMN` migrations add late columns).

---

## 6.6 Expenses

### Business purpose

Expenses is a lightweight petty-cash / operational-expense register — small spends (cylinder purchase, site sundries, etc.) recorded with a category, amount, date, and an approval status. It is distinct from Payment Required (which is the formal multi-level outbound-payment chain); Expenses is for already-incurred or low-ceremony spends.

### Who uses it

Staff with the `expenses` permission record their own spends; the page shows who submitted each and its status.

### Main screen (Expenses.jsx)

- **Status summary tiles** at the top, each summing the amount of expenses in that status (the page filters `expenses` by `status` and sums `amount`).
- **Table** (bounded scroll, sticky header) — columns: Description, Category, Amount, Date, Submitted By, Status, Actions.
- **Add/Edit modal** — fields: Category (required, from a dropdown), Description/Title (e.g. "Manga – Cylinder purchase"), Amount (₹, required), Date (required).

### Key fields

`title`/`description`, `category`, `amount`, `expense_date`, `status`, `submitted_by` (resolved to `submitted_by_name` for display).

### Workflow

1. Submit an expense (category + amount + date required).
2. The expense appears in the register with a status; status tiles aggregate amounts per state.
3. Expenses can be edited; export to CSV is available (Description, Category, Amount, Date, Submitted By, Status).

### DB table

- **`expenses`** — `id`, `title`/`description`, `category`, `amount`, `expense_date`, `status`, `submitted_by`, timestamps.

---

## 6.7 How the Finance modules interconnect

The chain below (mam's audit asks A7 / A9 / A14, implemented in `server/lib/cashSync.js`) makes the modules a single ledger rather than six silos:

```
Sales Bill (Billing)  ──bill_number──►  Receivable (Collections)
        ▲ payment_status synced (A9)            │
        │                                       │ collect (A9 + A14)
        └───────────────────────────────────────┤
                                                 ▼
Payment Required (final release) ──outflow──►  cash_flow_daily / cash_flow_entries  ◄──inflow── Collection
                                                 │
                                                 ▼
                                         Runway (CMD dashboard, burn-rate based)

Receivables.outstanding ──► DSO ──► CCC (Finance/CMD dashboard, computeKpiPayload)
Cheques ──► open-cheque exception count (audit report)
```

- **Recording a collection** updates the receivable, syncs the matching sales bill's `payment_status`, and posts a cash-flow **inflow** — in one transaction.
- **Final-approving a Payment Required** posts a cash-flow **outflow** at the approver-agreed amount.
- The **00:00 cron** rolls `cash_flow_daily` forward (so runway is correct on quiet days); the **01:00 cron** re-ages all receivables (so DSO/ageing buckets are correct).
- **Runway** (burn-rate) reads the latest cash-flow closing balance; **DSO/CCC** read receivables outstanding vs sales-bill turnover; **open cheques** feed the daily audit exception report.
