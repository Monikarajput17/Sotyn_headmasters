# 2. CRM

The **CRM** sidebar group contains six modules that, together, cover the full
pre-sales and order-booking journey at SEPL — from first touch with a referral
partner, through lead qualification and quotation, to the moment an order is
**booked** in the Business Book and starts feeding procurement, project, and
billing modules. Two of the six are project-tracking aids that live under CRM
because the CRM/PMC team owns them (Customers master, Full Kitting checklist).

| # | Sidebar item | Purpose (one line) | Primary table |
|---|--------------|--------------------|---------------|
| 2.1 | Partners | Influencer / referral-partner master (architects, designers, channel partners) | `influencers` |
| 2.2 | CRM Sales Funnel | Flat 3-step spreadsheet-style tracker (Quotation → Negotiation → Win/Loss) | `crm_funnel` |
| 2.3 | Sales Funnel (Leads) | 11-stage governed pipeline with SLAs, gates, MOM, BOQ, follow-ups | `sales_funnel` |
| 2.4 | Business Book | Booked orders ledger; the hand-off point into procurement / DPR / billing | `business_book` |
| 2.5 | Customers | Lightweight customer/company master with codes | `customers` |
| 2.6 | Full Kitting | 3-stage project readiness checklist (131 checkpoints) with photo evidence | `crm_kitting_*` |

> There are **two parallel funnels** by design. `crm_funnel` (2.2) is the simple
> flat tracker the sales team used in a Google Sheet before the ERP. `sales_funnel`
> (2.3) is the full 11-stage governed pipeline built to mam's
> *SEPL_Sales_Funnel_ERP_Build_Spec*. They are independent tables and screens; do
> not confuse them. A third legacy table, `leads`, still backs a small
> `/api/leads` CRUD endpoint but is largely superseded by `sales_funnel`.

---

## 2.1 Partners (Influencers / Referral Partners)

**Files:** `client/src/pages/Influencers.jsx`, `server/routes/influencers.js`
**Mounted at:** `/api/influencers`
**Permission key:** `influencers`

### What it is / business purpose

A master of **referral partners and influencers** — architects, interior
designers, MEP consultants, builders/developers, channel partners, vendors — who
bring SEPL business. It mirrors the 6-section "Influencer Enquiry Form" Excel mam
shared, and supports bulk Excel import/export so the sales team can migrate or
mass-update partner data.

The most important downstream use is the **Source → Partner dropdown** on the
Lead Capture form (Sales Funnel, 2.3): when a lead's source is *Influencer*, the
rep picks the partner from this master.

### Who uses it

CRM / business-development team and admins. Full view/create/edit/delete is
admin-gated through the `influencers` permission. A separate lightweight
`GET /lookup` endpoint is open to any authenticated user so sales reps can fill
the partner dropdown without holding the admin-only `influencers:view`
permission.

### Main screen, columns

A single searchable table with Template / Import Excel / Export Excel buttons
(import flow modelled on the Fire-NOC import). Filters: search box, Primary
Category, Relationship Stage, City.

Table columns: **Form ID · Name · Category · Company · Mobile · City · …**
(plus Actions). Each row is `INF-####` auto-numbered.

### Key fields (6 sections)

The form/record carries 35+ fields grouped into six sections:

| Section | Representative fields |
|---------|-----------------------|
| 1. Basic Identity | salutation, **full_name\***, date_of_birth, anniversary_date, gender, hometown |
| 2. Professional Category | **primary_category**, primary_category_other, years_in_industry, decision_making_role |
| 3. Company / Firm Details | company_name, designation, company_size, year_established, office_address, city, pincode, gst_number, website |
| 4. Contact Information | **primary_mobile\***, secondary_mobile, whatsapp_number, office_landline, personal_email, office_email, preferred_contact_method, best_time_to_call |
| 5. Digital / Social Presence | linkedin_url, facebook_url, instagram_handle, twitter_handle, youtube_channel, google_business_profile, other_listings |
| 6. Relationship & Business Intelligence | source_of_contact, referred_by, first_meeting_date, **relationship_stage**, typical_project_type, typical_project_value_range, past_projects_count, past_projects_total_value, ongoing_projects_with_us, client_payment_behavior, commission_terms, competitors |

Plus audit fields: `form_id`, `date_of_entry`, `entered_by`,
`assigned_relationship_manager`, `created_by`, timestamps.

**Required:** `full_name` and `primary_mobile`. The frontend Category dropdown
offers: *Architect, Interior Designer, MEP Consultant, Builder / Developer,
Channel Partner, Influencer, Vendor, Others.*

### Workflow

1. CRM user opens **Partners** and clicks **Add** (or **Import Excel** for bulk).
2. Fills the 6-section form. `form_id` auto-generates as `INF-0001`,
   `INF-0002`… if left blank.
3. On save, the row is created (`POST /api/influencers`) and an audit event is
   written.
4. For bulk loads: download the **Template** (`.xlsx` with all fields + a sample
   row), fill it, and **Import**. The importer maps human headers back to field
   keys case-insensitively, converts Excel date serials to `YYYY-MM-DD`, coerces
   int/number fields, auto-assigns `form_id` when blank, and returns a
   per-row created/failed report.
5. The partner is now selectable in the Sales-Funnel Lead Capture form's
   **Source = Influencer → Partner** dropdown (via `/lookup`).

### Automations / notes

- `form_id` auto-numbering (`INF-####`).
- Excel **import** (header-mapped, date/number normalised) and **export**
  (full dataset, dated filename) and a downloadable **template**.
- Schema is created idempotently at module load.

### API endpoints

| Method & Path | Purpose | Permission |
|---------------|---------|-----------|
| GET `/api/influencers/lookup` | id / name / company / category for dropdowns | any auth user |
| GET `/api/influencers` | List with `search`, `primary_category`, `relationship_stage`, `city` filters | view |
| GET `/api/influencers/:id` | Single record | view |
| POST `/api/influencers` | Create (auto `form_id`) | create |
| PUT `/api/influencers/:id` | Update | edit |
| DELETE `/api/influencers/:id` | Delete | delete |
| GET `/api/influencers/import/template` | Download `.xlsx` template | view |
| GET `/api/influencers/export` | Download all rows as `.xlsx` | view |
| POST `/api/influencers/import` | Bulk Excel upload | create |

### DB tables touched

- `influencers` (created/owned here), `users` (FK `created_by`), audit log.

---

## 2.2 CRM Sales Funnel

**Files:** `client/src/pages/CRMFunnel.jsx`, `server/routes/crmFunnel.js`
**Mounted at:** `/api/crm-funnel`
**Permission key:** `crm_funnel`

### What it is / business purpose

A **flat, spreadsheet-style FMS** (Funnel Management Sheet) that reproduces the
simple workflow the sales team filled in a Google Sheet before the ERP:

> **Step 1 — Quotation submit → Step 2 — Negotiation → Step 3 — Win/Loss.**

It is intentionally simpler than the 11-stage governed pipeline (2.3) and runs
in parallel to it. Each row is one enquiry/opportunity tracked through three
steps on one screen.

### Who uses it

Sales team and sales head for day-to-day, low-ceremony tracking and quick
win-rate reporting.

### Main screen, steps, columns

Top of the page shows three step chips and KPI cards (Won Deals + amount, Win
Rate %). Step filter chips:

| Step chip | Meaning | Filter logic (`?step=`) |
|-----------|---------|-------------------------|
| Step 1 | Quotation not yet submitted | `quotation_submitted=0` |
| Step 2 | Quotation submitted, not closed | `quotation_submitted=1 AND final_status empty` |
| Step 3 | Closed | `final_status IN ('win','loss')` |
| (open) | Any not-yet-closed | `final_status` empty |

Table columns: **Lead # · Client · Company · Mobile · Source · Type · Category ·
State · BOQ · Quote · Qty Amount · Neg Status · Neg Amount · Stage · Loss Reason
· Actions.** Win/Loss render as coloured badges.

### Key fields & dropdowns

- **Identity:** client_name\*, company_name, mobile, email, address, state,
  district, remarks.
- **Classification dropdowns:**
  - **Source** (enforced): *Tenders, Referral, Direct, Website, Channel*
    (free-text blocked server-side via `validateFunnelSource`; blank allowed for
    legacy rows).
  - **Type:** *Private, Government.*
  - **Category:** *Hospital, Hotel, Office, Industrial, Residential, Retail,
    Educational, Government, Other.*
  - **Lead Type:** *New, Extra Enquiry* (server whitelists these two).
- **Step 1 (Quotation):** boq_file_link (file upload, ≤15 MB), cust_boq_link,
  quotation_link, quotation_amount, quotation_submitted (Y/N),
  quotation_submit_date.
- **Step 2 (Negotiation):** negotiation_status, negotiation_amount,
  negotiation_remarks.
- **Step 3 (Final):** final_status (*win* / *loss*), loss_reason (shown when
  loss), closed_at.

### Workflow

1. Sales user creates a row (`POST`) with client + classification. `lead_no`
   auto-generates as `CRM-0001`… The server validates `client_name` and the
   `source` value, and persists any uploaded BOQ to `/uploads/...`.
2. The row sits in **Step 1** until a quotation is submitted.
3. User edits the row, attaches the quotation, sets **Quotation submitted = Y**.
   The server stamps `quotation_submit_date` on that first transition; the row
   moves to **Step 2**.
4. During negotiation, user records negotiation status/amount/remarks.
5. User sets **final_status = win or loss**. On the first close, the server
   stamps `closed_at`. Loss requires a reason. Row is now **Step 3**.

### Automations / statuses

- `lead_no` auto-numbering (`CRM-####`).
- **Transition date-stamping:** `quotation_submit_date` and `closed_at` are set
  only on the first Y/close transition (not overwritten on later edits).
- **Source whitelist** enforced on both create and edit.
- BOQ file upload persisted to the shared `/uploads` directory.
- KPIs (Won, Win Rate, win amount = negotiation_amount || quotation_amount) are
  computed on the client.

### API endpoints

| Method & Path | Purpose | Permission |
|---------------|---------|-----------|
| GET `/api/crm-funnel` | List; filters `q`, `step`, `state`, `source`, `type` | view |
| GET `/api/crm-funnel/:id` | Single row | view |
| POST `/api/crm-funnel` | Create (multipart, optional `boq_file`) | create |
| PUT `/api/crm-funnel/:id` | Update (multipart, optional `boq_file`) | edit |
| DELETE `/api/crm-funnel/:id` | Delete | delete |

### DB tables touched

- `crm_funnel` only (self-contained). Uses `nextSequence` for `lead_no`.

---

## 2.3 Sales Funnel (Leads)

**Files:** `client/src/pages/Leads.jsx`, `server/routes/salesfunnel.js`
(11-stage pipeline); plus a separate legacy `server/routes/leads.js`
(`/api/leads`).
**Mounted at:** `/api/sales-funnel`
**Permission key:** `leads` (the sales funnel reuses the `leads` permission set).

### What it is / business purpose

The **full governed sales pipeline** built to mam's
*SEPL_Sales_Funnel_ERP_Build_Spec*: an 11-stage funnel (plus a terminal *Lost*)
with per-stage SLAs, approval **gates**, role ownership, an immutable audit
trail, BOQ history, and follow-ups. This is where a serious opportunity is
worked end to end before it becomes a booked order in the Business Book.

### Who uses it

Cross-functional: BD captures leads, Sales Head qualifies, Site Engineer
surveys, Designer drafts, Estimation costs the BOQ, CFO/Sales Head gate pricing,
Sales submits the bid, and Legal+CFO gate the contract — each stage's `who` is
declared in code.

### Stage pipeline

`GET /api/sales-funnel/stages` returns the canonical list:

| # | Stage key | Label | Owner | SLA (hrs) | Gate |
|---|-----------|-------|-------|-----------|------|
| 1 | lead_capture | Lead/Tender Capture | BD | 1 | — |
| 2 | qualification | Qualified or Not | Sales Head | 24 | — |
| 3 | site_survey | Site Survey + Feasibility | Site Eng | 72 | — |
| 4 | concept_design | Concept Design / Drawings | Designer | 168 | — |
| 5 | boq_costing | BOQ + Vendor Costing | Estimation | 168 | — |
| 6 | pricing_review | Internal Pricing Review | CFO | 24 | **gate** |
| 7 | quote_submitted | Quote / Bid Submission | Sales | — | — |
| 8 | technical_clarification | Technical Clarification | Sales + Tech | 24 | — |
| 9 | commercial_negotiation | Commercial Negotiation | Sales Head | — | — |
| 10 | contract_signed | Contract + LOI / PO | Legal + CFO | — | **gate** |
| 11 | project_kickoff | Project Kickoff | PM | — | — |
| — | lost | Lost (terminal) | — | — | — |

Legacy stage keys (`new_lead`, `qualified`, `meeting_assigned`, `mom_uploaded`,
`drawing_uploaded`, `boq_created`, `quotation_sent`, `won`) are transparently
mapped to the new keys via `LEGACY_STAGE_MAP` so older clients keep working.

### Main screen, tabs, columns

- **Tabs / chips:** *Dashboard*, *All Leads (list)*, and one chip **per stage**
  (each showing the count in that stage).
- **Dashboard:** funnel bar chart by stage, Won/Lost tiles, this-month count,
  by-category and by-SC breakdowns, recent leads, today/overdue follow-up counts.
- **List columns:** **Lead No · Client · Company · Category · Location · SC
  (sales coordinator) · Stage · SLA · Date · Actions.** SLA renders as
  "due in N min / overdue" using `stage_entered_at + sla_hours`.
- **View modal:** a clickable stage rail; selecting a future stage opens that
  stage's fields to advance; past stages are read-only. Includes BOQ history and
  follow-ups panels.

### Key fields & dropdowns

- **Lead kind (radio):** *Private (Quote)* vs *Government (Tender)*.
- **Source** dropdown; when *Influencer*, a **Partner** picker appears, lazy-fed
  from `/api/influencers/lookup` (stores `influencer_id` + denormalised
  `influencer_name`).
- **Category:** Low Voltage, Fire Fighting, Fire NOC, Electrical, SOLAR, MEP,
  HVAC, Plumbing. Plus a separate **Building Category** list.
- **Stage-1 capture fields:** client_name\*, company_name, phone, email,
  project_name\*, project_location, pin_code, estimated_value,
  tentative_timeline, sub_trades_scope (M/E/P/F/BMS/ELV/Solar), assigned_sc /
  assigned_asm, remarks, state/district/city/address.
- **Government-only:** tender_id\*, bid_deadline (must be ≥ today), emd_amount,
  pbg_required.
- **Per-stage fields:** qualification (score/remarks), site_survey
  (date/location/surveyor + MOM: purpose, pain_points, requirements,
  action_planned, file), concept_design (3 drawing slots), boq_costing
  (boq_file_link, boq_amount), quote_submitted (quotation_number/file/amount),
  contract_signed (won_amount, result_remarks).

### Workflow

1. **Stage 1 — Capture.** BD creates the lead (`POST /`). `lead_no` =
   `SEPL9000+`. Stage-1 validation runs: GST/PAN format (when present),
   estimated_value ≥ 0, and for Government leads a Tender ID + a future bid
   deadline. `stage_entered_at` is stamped so the 1-hour first-call SLA starts;
   an audit row is written.
2. **Advance stage** via `POST /:id/stage` with the target `stage` key and its
   fields. A big `switch` applies stage-specific updates, re-stamps
   `stage_entered_at` (resetting that stage's SLA), and writes an
   `enter_stage` audit row.
3. **Qualification (Stage 2)** sets GO/NO-GO; *not_qualified* / first-call
   *not interested* drops the lead to terminal **lost**.
4. **Site Survey (Stage 3)** records the survey/meeting; an MOM submit
   (`mom_uploaded`) advances the lead to **Concept Design**.
5. **BOQ (Stage 5)** updates the latest BOQ columns and **also appends to
   `sales_funnel_boqs`** so every re-sent BOQ is retained (clients re-send BOQs
   over time). A standalone `POST /:id/boq` can add a BOQ at any stage.
6. **Pricing review (6)** and **Contract (10)** are **gates** (no auto-advance;
   require explicit approval; slab-based routing noted in spec — currently
   advance + remarks).
7. **Contract signed (10)** records `won_amount`; the dashboard counts both
   `contract_signed` and legacy `won` as Won.
8. **Drop:** `POST /:id/drop` closes a lead with a mandatory reason → stage
   `lost`, audited.
9. **Follow-ups:** add (`POST /:id/followup`), log outcome
   (`PUT /followup/:fid`, optionally auto-scheduling the next one), and
   today/overdue lists feed the dashboard.

### Automations / statuses

- `lead_no` auto-numbering (`SEPL9000+`).
- **SLA engine** (`withSla`): computes `sla_due_at`, `sla_minutes_left`,
  `sla_overdue` per row from the owning stage's `sla_hours`.
- **Gates:** stages 6 and 10 flagged `gate: true`.
- **Audit trail:** every create/edit/stage/drop/add-boq writes to
  `sales_funnel_audit` (read back via `GET /:id/audit`).
- **BOQ history** in `sales_funnel_boqs`.
- **Follow-up auto-scheduling** when a `next_followup_date` is set.
- Legacy-key translation for backward compatibility.

### API endpoints (sales-funnel)

| Method & Path | Purpose |
|---------------|---------|
| GET `/api/sales-funnel` | List; filters `stage`, `search`, `assigned_sc`, `category` (with SLA) |
| GET `/api/sales-funnel/stages` | Stage definitions |
| GET `/api/sales-funnel/meta` | Sources / categories / sub-trades / stages |
| GET `/api/sales-funnel/dashboard` | Pipeline KPIs |
| GET `/api/sales-funnel/:id` | Single lead (with SLA) |
| GET `/api/sales-funnel/:id/audit` | Audit timeline |
| POST `/api/sales-funnel` | Create (Stage 1 capture) |
| PUT `/api/sales-funnel/:id` | Edit Stage-1 fields |
| POST `/api/sales-funnel/:id/stage` | Advance to a stage |
| POST `/api/sales-funnel/:id/drop` | Drop with reason |
| GET `/api/sales-funnel/:id/boqs` · POST `/api/sales-funnel/:id/boq` | BOQ history list / add |
| GET `/api/sales-funnel/:id/followups` · POST `/api/sales-funnel/:id/followup` | Follow-ups |
| PUT `/api/sales-funnel/followup/:fid` | Log follow-up outcome |
| GET `/api/sales-funnel/followups/today` · `/overdue` | Follow-up queues |
| DELETE `/api/sales-funnel/:id` | Delete |

### Legacy `/api/leads` endpoint

`server/routes/leads.js` backs an older, simpler `leads` table
(company_name, contact_person, phone, email, source_id → `lead_sources`,
status, assigned_to, notes) with `GET /sources`, list/stats CRUD. It is largely
superseded by the sales_funnel pipeline but remains mounted.

### DB tables touched

- `sales_funnel`, `sales_funnel_audit`, `sales_funnel_boqs`, `lead_followups`,
  `users`, `influencers` (via lookup). Legacy: `leads`, `lead_sources`.

---

## 2.4 Business Book

**Files:** `client/src/pages/BusinessBook.jsx`, `server/routes/businessbook.js`
**Mounted at:** `/api/business-book`
**Permission key:** `business_book`

### What it is / business purpose

The **Business Book is the central ledger of booked orders** — the
"Master Business Sheet". When a deal is won, its full commercial + project detail
is recorded here, and creating a Business Book entry is the **hand-off point**
that wires the order into the rest of the ERP: it auto-creates Order Planning, a
DPR site, a cash-flow inflow for any advance, and a receivable for the balance.
The Business Book also feeds **procurement** (PO items / purchase orders keyed by
`business_book_id`) and **Sales Billing** (the sales bill recovers client + GST
detail from the Business Book). Each entry gets a `SEPL20000+` Lead No.

### Who uses it

Sales/operations who book the order, plus finance and project teams who consume
the auto-created downstream records. Read endpoints feed dashboards and dropdowns
across the app.

### Main screen, columns

A searchable, filterable table with summary stats. Filters: search (client,
company, project, lead no, PO number, customer code), Status, Category, Order
Type, Lead Type, date range. A footer shows the **Sale Total** (sum of
`sale_amount_without_gst`) to match Cash Flow.

Table columns: **Lead No · Type · Client Name · Project / Location · Category ·
Order · PO Number · Sale Amt · Advance · Balance · Employee · Status · Actions.**

Dropdown vocabularies (frontend):
- **Status:** booked, advance_received, planning, execution, completed.
- **Category:** Low Voltage, Fire Fighting, Fire NOC, Fire Alarm, CCTV, Access
  Control, PA System, Networking, Solar, Other.
- **Order Type:** Supply, SITC, AMC, Service.
- **Lead Type:** Private, Government.
- **Source of enquiry:** Inbound Enquiry, Indiamart, WhatsApp, LinkedIn,
  Reference, Tender, Other.

### Key fields

The record carries ~70 fields. Notable groups:

- **Client / location:** client_name\*, company_name, project_name, contacts,
  emails, source_of_enquiry, **district, state, state_code, gstin**,
  billing_address, shipping_address.
- **Commercial:** sale_amount_without_gst, **po_amount (computed)**,
  guarantee_required/percentage, order_type, penalty_clause(+date),
  committed_start/delivery/completion dates, freight_extra.
- **Payment terms:** payment_advance / against_delivery / against_installation /
  against_commissioning / retention / credit %, credit_days, advance_received,
  **balance_amount (computed)**.
- **People:** employee_assigned/id, lead_by, and management / operations / PMC /
  architect / accounts person name+contact.
- **TPA & margin:** tpa_items_count/qty, tpa_material_amount, tpa_labour_amount,
  accessory_amount, required_labour_per_day, actual_margin_pct.
- **PO & documents:** po_number, po_date, po_copy_link, boq/tpa/drawing/working
  sheet links (and signed variants).

### GST / State auto-fill

On the form, selecting a **State** (from `STATES`) automatically:
1. clears the district, and
2. sets **State Code** via `gstStateCode(state)` (e.g. Punjab → `03`).

District options then come from `DISTRICTS_BY_STATE[state]`. The **State Code**
and **GSTIN** flow into the auto-generated **Sales Bill / Tax Invoice** (the
GSTIN field placeholder is `e.g. 03AABCS1234A1Z5`, a 15-char GSTIN whose first 2
digits are the state code).

### PO Amount rule (with GST)

Per mam (2026-05-21): **PO Amount (with GST) is always `Sale × 1.18`** (18% GST).
This is non-negotiable and enforced in three places:
1. A one-time, idempotent **backfill** at module load (guarded by an
   `app_settings` sentinel `bb_po_eq_sale_x118_v1`) recomputes `po_amount` and
   `balance_amount` for all existing rows.
2. **Force-compute on every INSERT** (`computePoAmount` overrides any client
   value).
3. **Force-compute on every UPDATE** (same).
`balance_amount = po_amount − advance_received`.

### Workflow

1. User clicks **Add**, fills the form. State selection auto-fills State Code;
   GSTIN entered manually.
2. On save (`POST /`):
   - `client_name` required; if a `po_number` is given it's validated against a
     regex/junk blocklist (`validatePoNumber`).
   - **Duplicate guard:** rejects same PO number, and same client + project
     (same opportunity).
   - `lead_no` auto = `SEPL20000+`.
   - `po_amount` forced to `Sale × 1.18`; `balance_amount` computed.
   - The row is inserted, then **auto-links are created** (see below).
3. **Edit** (`PUT /:id`) re-applies the PO-amount rule and PO validation.
4. **Delete** (`DELETE /:id`) cascades to linked records — but is **guarded**:
   if the order's sites have any DPRs or attendance, it returns `409` and
   requires `?force=1` (after a mistaken delete once cascade-wiped a client's
   DPRs).

### Automations (the hand-off)

On create, the Business Book entry **feeds other modules**:

| Auto-created | Where | Detail |
|--------------|-------|--------|
| Order Planning row | `order_planning` | planned start/end from committed dates; note tags lead_no/project/category |
| DPR Site | `sites` | name from company/project; address from shipping/billing; linked via `business_book_id` |
| Cash-flow inflow | `cash_flow_daily` + `cash_flow_entries` | only if `advance_received > 0`; "Advance Received" inflow; daily totals recomputed |
| Receivable | `receivables` | only if `po_amount > advance_received`; outstanding = balance; due in `credit_days` (default 30); status `green` |

Downstream consumers (not created here, but keyed to it): **procurement**
(`po_items`, `purchase_orders` with `business_book_id`), **project finance**
(`project_finance`), **DPR** (via the auto-created site), and **Sales Billing**
(recovers client/GST from the Business Book). Full Kitting (2.6) also groups its
projects by `business_book.company_name`.

### API endpoints

| Method & Path | Purpose | Permission |
|---------------|---------|-----------|
| GET `/api/business-book` | List; filters status/category/order_type/lead_type/search/date range | view |
| GET `/api/business-book/stats/summary` | Totals + by status/category/order-type | view |
| GET `/api/business-book/:id` | Single entry (+ employee name) | view |
| POST `/api/business-book` | Create (forces PO=Sale×1.18, auto-links) | create |
| PUT `/api/business-book/:id` | Update (re-forces PO rule) | edit |
| DELETE `/api/business-book/:id` | Delete (guarded; `?force=1` to cascade DPRs) | delete |

### DB tables touched

- **Owns:** `business_book`. **Writes on create/delete:** `order_planning`,
  `sites`, `cash_flow_daily`, `cash_flow_entries`, `receivables`,
  `project_finance`, `po_items`, `purchase_orders`, and (on delete) DPR family
  (`dpr`, `dpr_work_items`, `dpr_manpower`, `dpr_machinery`, `attendance`,
  `geofence_settings`). Reads `users`. Uses `app_settings` (backfill sentinel)
  and `nextSequence`.

---

## 2.5 Customers

**Files:** `client/src/pages/Customers.jsx`, `server/routes/customers.js`
**Mounted at:** `/api/customers`
**Permission key:** `customers`

### What it is / business purpose

A **lightweight customer / company master** with auto-generated customer codes
(`CUST-01000+`). It is a simple reference list of companies and their concern
persons, separate from the heavier Business Book — useful for category-based
filtering and bulk import of an existing customer list.

### Who uses it

CRM / sales for maintaining the company directory.

### Main screen, columns

A searchable table with a Category filter and category counts, plus Excel
bulk-import and CSV export. Columns: **Customer Code · Company Name · Sub Company
· Category · Contact No · Email · Concern Person · Actions.** Category renders as
a coloured chip.

**Category dropdown:** FF, ELE, LV, Solar, HVAC, INTERIOR, Govt, Private, OTHER.

### Key fields

customer_code (auto, read-only), category, company_name\*, sub_company_name,
company_registration_address, contact_no, email, concern_person_name,
concern_person_email, concern_person_address.

### Workflow

1. **Add** a customer — company_name required. On `POST`:
   - **Duplicate guard:** rejects same company_name; also flags same contact_no.
   - `customer_code` auto-generates (`CUST-01000`, `CUST-01001`…).
2. **Edit** updates all fields except the read-only `customer_code`.
3. **Bulk import:** upload an Excel file. The importer auto-detects the header
   row (scans first 10 rows for a "company/customer/name" column), fuzzy-maps
   columns (company, sub-company, category, registration address, contact,
   email, concern person fields), generates a code per row, and returns
   `{added, errors, total}`. Rows without a company name are skipped.

### Automations / notes

- `customer_code` auto-numbering via `nextSequence`.
- Duplicate detection on company name and phone.
- Header-detecting, fuzzy-mapped Excel bulk import.

### API endpoints

| Method & Path | Purpose | Permission |
|---------------|---------|-----------|
| GET `/api/customers` | List; filters `search`, `category` | view |
| GET `/api/customers/:id` | Single | view |
| POST `/api/customers` | Create (auto code, dup guard) | create |
| PUT `/api/customers/:id` | Update (code read-only) | edit |
| DELETE `/api/customers/:id` | Delete | delete |
| POST `/api/customers/bulk-import` | Excel upload | create |

### DB tables touched

- `customers` only. Uses `nextSequence` and `duplicateGuard`.

---

## 2.6 Full Kitting (CRM Full Kitting)

**Files:** `client/src/pages/CRMKitting.jsx`, `server/routes/crmKitting.js`
**Mounted at:** `/api/crm-kitting`
**Permission key:** `crm_kitting`

### What it is / business purpose

A **3-stage project-readiness checklist** ("full kitting") that tracks, for each
project, whether 131 readiness checkpoints across **Pre-Start → Execution →
Handover** are done — with a **photo per checkpoint** and full history. Field
staff can upload **today's or a back-dated photo (up to 5 days)** and still see
all previous photos for that checkpoint. Projects are derived from the Business
Book (grouped by `company_name`, mirroring Cash Flow's project grouping).

### Who uses it

CRM owners, PMs, and site staff. Admins manage the checkpoint master; field
staff record statuses + photos.

### Stages & checkpoints

Checkpoints live in `crm_kitting_checkpoint`, grouped by `stage_no` (1–3) and a
`section`, seeded (v2, guarded by `crm_kitting_seed_v2`) to:

| Stage | Name | Items | Sections (examples) |
|-------|------|-------|---------------------|
| 1 | PRE-START | 55 | DRAWINGS, SITE, CORE MAT, LONG-LEAD, CONSUMABLES, PROCUREMENT, RESOURCES, PLAN, COMMERCIAL, PERMITS |
| 2 | EXECUTION | 35 | DAILY, WEEKLY, QC, SAFETY, MAT TRACK, CHANGES |
| 3 | HANDOVER | 41 | TECHNICAL, DOCS, QC SIGN, COMMERCIAL, DEMOB, DLP, FINAL |

Each checkpoint status is one of the dropdown values **Yes / No / Partially /
N/A**.

### Main screen

A single **matrix** screen (`table-layout: fixed`): rows = projects
(rolled up by company_name), columns = the 131 checkpoints grouped by stage +
section, with left-hand project-meta columns (**CRM Owner, Phase/Zone, PM Owner,
Target Start**). A stage selector switches which stage's columns are shown. Each
cell shows the latest status (coloured) + a history-count badge; clicking a cell
opens a panel to set status, add remarks, set observation date, and upload a
photo. The whole grid loads in one round-trip via `/matrix`.

### Data model

- `crm_kitting_checkpoint` — master checkpoint list (stage_no, section,
  sort_order, label, is_active). Admin-editable; **soft-deleted** (`is_active=0`)
  to preserve history.
- `crm_kitting_entry` — **append-only history**; every dropdown change / photo
  upload inserts a new row. The "current" status is the most recent row per
  `(project_key, checkpoint_id)`. Keyed by `project_key` = Business Book
  `company_name` (so multiple BB rows / POs for the same company share one
  kitting state).
- `crm_kitting_project_meta` — per-project CRM owner / phase / PM / target start.

### Workflow

1. Admin reviews/edits the **checkpoint master** (`/checkpoints` CRUD;
   create/edit/delete are admin-only inside the handler).
2. The **project list** comes from `business_book` grouped by company_name
   (`/projects`), with rolled-up sale/PO amounts and a `bb_entry_count`.
3. For a project, the matrix shows each checkpoint with its latest entry
   (`/matrix` or `/project?key=`), plus a per-stage summary
   (yes/no/partially/na/pending counts).
4. Field user clicks a cell and submits a new entry
   (`POST /entry`, multipart): chooses status (one of the four), optional
   remarks, an **observation_date** (defaults to today; validated to be
   **not future and at most 5 days back**, `UPLOAD_BACK_DAYS=5`), and an optional
   **photo** (≤10 MB, stored under `/uploads/crm-kitting/`). `uploaded_at` is
   always the real now() (the audit timestamp); `observation_date` is what the
   user claims.
5. Previous photos/statuses for a checkpoint are viewable via
   `/history?key=&cp=`.
6. Project-meta (CRM owner / phase / PM / target start) is upserted via
   `/project-meta`.

### Automations / statuses

- **Append-only history** — never overwrites; latest row wins.
- **Back-dated uploads** allowed up to 5 days; future dates rejected.
- **Soft-delete** of checkpoints keeps historical entries valid.
- **Project derivation** from Business Book by `company_name` (Cash-Flow-style
  grouping); entries validate the project_key still maps to a BB row.
- Idempotent schema + v2 seed (131 checkpoints) at module load, with defensive
  `ALTER`/backfill migrations for older installs (e.g. `project_id` →
  `project_key`).
- Audit events on checkpoint and entry writes via `logAuditEvent`.

### API endpoints

| Method & Path | Purpose | Permission |
|---------------|---------|-----------|
| GET `/api/crm-kitting/checkpoints` | Active checkpoint master | view |
| POST `/api/crm-kitting/checkpoints` | Add checkpoint (admin) | create |
| PUT `/api/crm-kitting/checkpoints/:id` | Edit checkpoint (admin) | edit |
| DELETE `/api/crm-kitting/checkpoints/:id` | Soft-delete (admin) | delete |
| GET `/api/crm-kitting/projects` | BB-derived project list | view |
| GET `/api/crm-kitting/project?key=` | Project + checkpoints + latest entries + summary | view |
| GET `/api/crm-kitting/matrix` | Whole grid in one payload | view |
| POST `/api/crm-kitting/entry` | New status/photo entry (multipart) | edit |
| GET `/api/crm-kitting/history?key=&cp=` | Full history for one checkpoint | view |
| PUT `/api/crm-kitting/project-meta` | Upsert CRM owner / phase / PM / target start | edit |

### DB tables touched

- `crm_kitting_checkpoint`, `crm_kitting_entry`, `crm_kitting_project_meta`,
  `app_settings` (seed/migration sentinels), `business_book` (project source),
  `users` (uploader names).

---

## Cross-module relationships (summary)

- **Partners → Sales Funnel:** influencer master feeds the *Source = Influencer*
  partner dropdown on lead capture (`/influencers/lookup`).
- **Sales Funnel → Business Book:** a won lead is booked as a Business Book
  entry (separate tables; the funnel does not auto-create the BB row).
- **Business Book → everything downstream:** on create it auto-creates Order
  Planning, a DPR Site, a cash-flow advance inflow, and a receivable; it is the
  FK anchor (`business_book_id`) for procurement (PO items / purchase orders),
  project finance, and DPR; and it supplies client + **GSTIN/State** to Sales
  Billing.
- **Business Book → Full Kitting:** kitting projects are the distinct
  `business_book.company_name` values.
- **Customers** is an independent directory used for reference/filtering; it is
  not the FK source for orders (that is the Business Book).
