# 4. Procurement

The Procurement module is the largest functional area of the SEPL ERP. It covers the
full life of a material requirement — from defining what an item *is* (Item Master),
to discovering its price (RFQ Queue), to who can supply it (Vendors), to the end-to-end
purchasing engine (**Indent → Dispatch**), and finally to the planning and timing layers
(**Order to Planning** and the **Schedule / Gantt**).

Frontend pages live under `client/src/pages/`; backend routes under `server/routes/`.
The two heaviest files are `client/src/pages/Procurement.jsx` (~485 KB) and
`server/routes/procurement.js` (~300 KB) — both implement the Indent → Dispatch flow.

| Concern | Frontend page | Backend route file | API base |
|---|---|---|---|
| Items (Item Master) | `ItemMaster.jsx` | `itemMaster.js`, `pipeweights.js` | `/api/item-master`, `/api/pipe-weights` |
| RFQ Queue (Price Required) | `PriceRequired.jsx` | `pricerequests.js` | `/api/price-requests` |
| Vendors | `Vendors.jsx` | `procurement.js` (vendor sub-routes) | `/api/procurement/vendors` |
| Indent → Dispatch | `Procurement.jsx` | `procurement.js` | `/api/procurement/*` |
| Order to Planning | `Orders.jsx` | `orders.js` | `/api/orders/*` |
| Schedule (Gantt) | `ProcurementSchedule.jsx` | `procurementSchedule.js` | `/api/procurement-schedule/*` |

> Note on the canonical process documents: the repo ships two living specs for the
> purchasing engine — `INDENT-TO-DISPATCH.md` (the 18-step automation status grid) and
> `INDENT-TO-DISPATCH-PROCESS.md` (the stage-by-stage "how it works today" walk-through).
> This section consolidates and expands on both.

---

## 4.1 Items — Item Master

### Business purpose
The Item Master is the single catalogue of every purchasable / issuable thing in the
business: hydrant valves, cables, pipes, tools, etc. Every BOQ line, indent line,
vendor PO line, and sales-bill line ultimately resolves back to an Item Master record
(its name, unit, GST slab, HSN/spec, and current price). It is the source of truth for
unit of measure, tax slab, and the latest known rate.

### Who uses it
- **Purchase team / Item-master maintainers** — create and edit items, set GST slab,
  set the current price, maintain the Pipe Weight conversion master.
- **Site engineers** — read-only consumers (item dropdowns when raising indents); they
  request *new* items via the RFQ Queue rather than creating them directly.

Access is gated by the permissions system: `requirePermission('item_master', 'view' |
'create' | 'edit' | 'delete')` on the backend.

### Main screen, columns and fields
The list groups items by **department** and shows: item code, department, item name,
specification, size, UOM, GST slab, type, and current price. A row's identity is
de-duplicated on `MIN(id)` so duplicate codes collapse to one display row.

Key fields on the item form (`ItemMaster.jsx`):

| Field | Notes |
|---|---|
| Item code | Auto-prefixed from department (first 3 letters, e.g. `FF0100`) on create if blank |
| Department | Free category used for grouping (FF, ELE, LV, HVAC, Plumbing, INTERIOR, …) |
| Item name / Specification / Size | Descriptive |
| UOM | Defaults to `PCS` |
| **GST slab** | Dropdown: `0% · 5% · 12% · 18% · 28%` (defaults to `18%`); a non-standard saved value is preserved as an extra option |
| **Type** | Dropdown: `PO · FOC · RGP · RENTAL`. `PO` = bought on a purchase order; `FOC` = free-of-cost (no rate/GST line); `RGP` = Returnable Gate Pass (contractor's own tools sent to site and returned); `RENTAL` = rented tool |
| Make / Model number | Brand + model |
| Source type | `PO · Quote · Manual · Online` — where the price came from |
| Current price | Latest rate; has a dedicated price-history trail |
| **Pipe weight (kg / meter)** | Optional, pipes only — see Pipe MTR→KG below |

### Pipe MTR → KG conversion
Pipes are indented in **meters** but bought from vendors by **weight (kg)**. The Item
Master form has an optional **Pipe weight (kg/meter)** field. There is a separate
**Pipe Weights master** (the 🪈 *Pipe Weights* button, backed by `pipeweights.js`) that
stores standard `pipe_class × size → kg_per_meter` rows. Picking a class/size in the
item form auto-fills `weight_per_meter`. When the item is set with kg/m, an item
indented in MTR is converted to KG for the **vendor enquiry and the PO**
(`qty_kg = mtr × kg/m`), and both meters and kg are shown.

> Open decision (per project memory): whether the *client* Sales Bill / Delivery Note
> should print in meters or kg is still being decided by management; the vendor side is
> already kg.

### Bulk upload
Items can be bulk-created from an Excel/CSV template (sample column order:
`item_code, department, item_name, specification, size, uom, gst, type, make, price,
vendor, source_type, bill_po_number, bill_po_date`). Backend route `POST
/item-master/bulk`.

### API endpoints — Item Master
| Method & path | Purpose |
|---|---|
| `GET /api/item-master` | List (filter by `department`, `type`, `search`, `status`) |
| `GET /api/item-master/dropdown` | Lightweight list for selects |
| `GET /api/item-master/:id` | Single item |
| `GET /api/item-master/:id/price-history` | Price-change trail |
| `PATCH /api/item-master/:id/price` | Update current price |
| `POST /api/item-master` | Create |
| `PUT /api/item-master/:id` | Edit |
| `DELETE /api/item-master/:id` | Delete |
| `POST /api/item-master/bulk` | Bulk create from template |

### API endpoints — Pipe Weights
| Method & path | Purpose |
|---|---|
| `GET /api/pipe-weights/lookup` | Class/size/kg-per-meter list for the item-form dropdown |
| `GET /api/pipe-weights` | List master rows |
| `POST /api/pipe-weights` | Add a row |
| `PUT /api/pipe-weights/:id` | Edit a row |
| `DELETE /api/pipe-weights/:id` | Delete a row |

### DB tables
- `item_master` — columns include `item_code, department, item_name, specification,
  size, uom, gst, type, make, model_number, current_price, weight_per_meter`.
- `pipe_weights` — `pipe_class, size, kg_per_meter`.

---

## 4.2 RFQ Queue — Price Required

### Business purpose
A lightweight queue for **items that are not yet in the Item Master** and have no known
price. A site engineer raises a "I need a price for this" request; the purchase team
collects up to three vendor quotes, picks a winner, and the system then **auto-creates
the Item Master entry** with that finalised rate. It is the on-ramp that keeps the Item
Master clean and priced.

### Who uses it
- **Site engineers / requesters** — raise requests (the *Raise* tab).
- **Quoters** (admins, or anyone with approve rights on `procurement` or `item_master`)
  — see the *Quotes* tab, enter vendor rates and finalise.

### Screen / tabs
Title: **Price Required**. Two tabs:
1. **Quotes** (quoters only) — grouped cards of merged requests, each with up to three
   vendor rate inputs and a finalise action.
2. **Raise / All requests** — requesters raise a new item and watch its status; an
   Excel template download + bulk upload is available to raise many at once.

### Step-by-step workflow
1. Site engineer raises a request for a new item (name, size, spec, make, UOM, type).
2. **Identical requests merge** on `(name + size + spec + make + uom + type)` so the same
   need from two sites becomes one card.
3. Purchase team enters **up to 3 vendor rates** per merged item.
4. Purchase team **finalises** the chosen vendor + rate.
5. The system **auto-creates an Item Master entry** with that rate and links the request
   to it (status becomes `added`).

### Statuses
`pending` → (rates being entered) → `final_rate` chosen → `added` (Item Master row
created and linked).

### API endpoints — Price Requests
| Method & path | Purpose |
|---|---|
| `GET /api/price-requests` | List all requests |
| `GET /api/price-requests/grouped` | Merged groups for the Quotes tab |
| `POST /api/price-requests` | Raise a request |
| `PUT /api/price-requests/:id` | Edit a request |
| `DELETE /api/price-requests/:id` | Delete |
| `PUT /api/price-requests/:id/rate` | Enter / update a vendor rate |
| `POST /api/price-requests/:id/finalize` | Pick winner → auto-create Item Master row |
| `GET /api/price-requests/template` | Blank Excel template |
| `POST /api/price-requests/bulk-upload` | Bulk-raise from filled template |

---

## 4.3 Vendors

### Business purpose
The vendor master — the directory of suppliers, who they are, what trades and brands
they cover, their tax identity, and their default commercial terms. Vendors are
referenced when entering quotes, finalising rates, and raising POs.

### Who uses it
Purchase team and admins (vendor master maintenance).

### Categories and key fields
Vendor **categories** are a fixed list (`Vendors.jsx`):
`FF, ELE, LV, Solar, HVAC, **Plumbing**, INTERIOR, OTHER` — each colour-coded in the
list.

Key fields:

| Field | Notes |
|---|---|
| Vendor code / Name / Firm name | Identity |
| **Category** (required) | One of the fixed list above |
| Sub category | Optional |
| Deals in / Type | Free description |
| **Make / Brand** | Repeatable — up to ~10 brands this vendor deals in, stored in `vendors.makes` (CSV) |
| GSTIN | Validated against the GSTIN regex; state code + PAN are parsed out of it to pre-fill |
| District / State | Address |
| Authorized dealer / Turnover | Qualification info |
| **Payment Terms** (required) + **Credit days** | Default commercial terms (credit days optional) |
| Phone / Email | Contact |

GSTIN parsing: the format `2-digit state + 10-char PAN + entity + Z + checksum` is
validated, and the state/PAN are extracted to reduce manual entry.

### Rate comparison
Vendors feed the **Vendor Rates** comparison in the Indent → Dispatch flow (up to three
quotes side by side); their default **payment terms** are surfaced there as a suggestion.

### API endpoints — Vendors (under procurement)
| Method & path | Purpose |
|---|---|
| `GET /api/procurement/vendors` | List vendors |
| `POST /api/procurement/vendors` | Create |
| `PUT /api/procurement/vendors/:id` | Edit |
| `DELETE /api/procurement/vendors/:id` | Delete |

### DB tables
- `vendors` — `vendor_code, name, firm_name, category, sub_category, deals_in, type,
  makes, gstin, district, state, authorized_dealer, turnover, payment_terms,
  credit_days, phone, email`.

---

## 4.4 Indent → Dispatch (the purchasing engine)

This is the core of the module: the single page `Procurement.jsx` with a tab strip, and
the route file `procurement.js`. It takes an approved requirement and drives it through
quoting, PO creation, payment, billing, dispatch/receiving, and debit notes — with
auto-numbering and notifications along the way.

> Document numbers you will see throughout: Indent `IND-####` · Stock Issue Note
> `SI/YYYY/####` · Delivery Challan `DC/YYYY/####` · RGP gate pass `RGP/YYYY/####` ·
> Vendor PO `VPO/YYYY/####` · Debit Note `DBN/YYYY/####` · Sales Bill (client invoice)
> `INV/YYYY/####` (current series `GST/26-26/##`).

### 4.4.1 Tabs (top-level navigation)
Defined in `Procurement.jsx`:

| Tab id | Label | Visible to |
|---|---|---|
| `indents` | **Raise Indent** | users who can raise indents |
| `rates` | **Vendor Rates** | purchase-ops users |
| `vendorpo` | **Vendor PO** | purchase-ops users |
| `payment` | **Payment** | purchase-ops users |
| `bills` | **Purchase Bills** | purchase-ops users |
| `delivery` | **Dispatch & Receiving** | purchase-ops users |
| `debitnotes` | **Debit Notes** | purchase-ops users |
| `pipeline` | **PO Pipeline** | purchase-ops users |

A single **Export Excel** button (top right) exports the *current tab's* data as CSV
(see Export section).

### 4.4.2 Indent categories
When raising an indent the user picks a **category**, which controls BOQ caps, stock
behaviour, and the approval policy:

| Category | Meaning |
|---|---|
| **Material** | BOQ items (PO + FOC). RGP hidden. |
| **RGP** | Returnable Gate Pass — no BOQ; picked directly from Item Master where `type = RGP`. |
| **Extra · Schedule** | BOQ item exists but the qty cap is removed (over-BOQ). Client-billable. |
| **Extra · Non-Schedule** | Item outside the BOQ — picked freely from Item Master (PO + FOC). Client-billable. |
| **Rental** | Rented tool — `Days × Rate/Day`. Blocks if renting ≥ buying outright (the 2× buy-vs-rent guard). |

### 4.4.3 Approval levels (L1 / L2 / CRM)
The approval policy is decided at indent creation (`procurement.js`, `POST /indents`):

- **Cutoff:** indents raised **on or after 2026-05-25** use the two-level chain
  (`approval_policy = 'two_level'`); older indents stay on the legacy `single` policy.
- **Material / RGP / Rental** → `two_level`: **L1 → L2** (the same person cannot do both).
  (RGP was briefly a single-HR sign-off `hr_single`, then reverted to the normal L1→L2
  chain per management on 2026-06-06.)
- **Extra · Schedule / Extra · Non-Schedule** (client-billable) → `crm_two_level`: **CRM
  approves first** (revenue gatekeeper), then **L1 → L2**.

Status progression for two-level:
`submitted → l1_approved → approved`. For the CRM chain:
`submitted → crm_approved → l1_approved → approved`. Each step fires approval
emails/events (`fireIndent(...)`).

#### Free-stock check + allocate (at approval)
At the approval screen the approver can **adjust quantity per line** and **allocate
"From Store"**: each item shows **"📦 N available"** office stock with a one-tap *use*
button; the remainder shows as **"To Procure"**. When store stock is used:
- a **Stock Issue Note `SI/YYYY/####`** and a **store Delivery Challan `DC/…`** are
  created and **office stock is reduced**;
- **RGP** items get an auto **gate-pass challan `RGP/YYYY/####`** and stock is reduced;
- **billable extra** items create a billing line and update the CRM funnel.
- Only the **shortfall** continues into purchasing.

This is the "free stock check + allocate" behaviour (step S2 in the automation grid) — it
*suggests* availability and the approver decides; it does not auto-allocate.

### 4.4.4 The tab flow, step by step

#### Stage 1 — Raise Indent (tab: Raise Indent)
1. Pick a site / planning, select BOQ items + quantity, choose category, submit.
2. An indent number `IND-####` is created (`nextSequence(... 'IND-', pad:4)`); status =
   **Submitted**; an "indent raised" email goes out; it routes by the policy above.
3. Quantities are checked against the BOQ cap (except Extra-Schedule, which lifts the cap).

#### Stage 2 — Approval (tab: Raise Indent → open the indent)
L1 clicks **Approve L1**, then L2 clicks **Approve L2** (CRM first for extra items). The
From-Store/To-Procure allocation and stock/SI/RGP side-effects (Stage 1 above) happen
here.

#### Stage 3 — Vendor Rates & Finalise (tab: Vendor Rates)
1. Purchase team picks an approved indent and enters **up to 3 vendor quotes** per item
   (name, rate, terms = Advance/Credit, credit days).
2. **Finalise** the chosen vendor + rate per line (`POST /item-rates/:id/finalize`).
   Finalisation is blocked if the parent indent is not fully approved
   (`assertIndentApprovedByRate`).
3. *(Not yet built: auto-emailed RFQs and auto-highlight of the cheapest vendor — quotes
   are typed in and the winner is chosen by hand.)*

#### Stage 4 — Create Vendor PO (tab: Vendor PO)
1. Pick the indent + finalised items, optionally attach the signed PO, click **Create
   Vendor PO**.
2. A PO number **`VPO/YYYY/####`** is created (`nextSequence(... 'VPO/{yr}/', pad:4)`);
   total is computed from the finalised rates; indent status → **PO Sent**.
3. The PO can be **printed to PDF** (`GET /vendor-po/:id/print`). A PO can be cancelled /
   uncancelled. *(Auto-emailing the PO PDF to the vendor is planned, not built.)*

#### Stage 5 — Vendor Payment / Advance (tab: Payment)
For advance-required POs a payment request runs through the standard approval chain
(HR/Accounts → Billing Engineer → Release). The tab buckets POs by urgency:

| Bucket | Meaning |
|---|---|
| 🚨 **Payment Urgent** | Vendor won't ship — Accounts must clear advance / old dues |
| ✓ **Recently Cleared** | Payment done — Purchase team can chase the bill in the next tab |

Each PO carries a payment posture chosen at creation: **No advance** (ships on credit —
default), **Advance required** (vendor wants ₹X first), or **Old payment hold** (old dues
must clear before shipment). `PATCH /vendor-po/:id/clear-payment` records the clearance.
*(Auto-pay below a threshold is intentionally manual — no payment gateway.)*

#### Stage 6 — Purchase Bill + MTC (tab: Purchase Bills)
1. When material arrives, upload the vendor's **bill (PDF/photo)**, enter bill no / date /
   amount / GST, and mark material **Approved / Reject** (`POST /purchase-bills`).
2. If no challan exists yet, a placeholder `DC/YYYY/####` is auto-created so the row shows
   in Dispatch.
3. The screen shows an **item-wise variance** (ordered vs received). If a line is short
   or at an extra rate, a **short-supply / extra-rate debit note `DBN/YYYY/####`** is
   auto-raised and the vendor can be emailed.
   *(OCR pre-fill of the bill and auto-booking of matched bills are not built — fields are
   typed.)*

#### Stage 7 — Dispatch & Receiving (tab: Dispatch & Receiving)
**7a. Dispatch to site** — create a **Delivery Challan `DC/YYYY/####`** with vehicle /
driver / LR details (`POST /delivery-notes`). *(SMS/WhatsApp to the transporter is not
built.)*

**7b. Receive (GRN)** — `PATCH /delivery-notes/:id/receive`:
- Requires a **receiver name** and a **photo of the stamped/signed GRN** (both
  mandatory; the receipt photo is saved under `/uploads`).
- Accepts **per-line received quantity** (`items_received` JSON: `vendor_po_item_id,
  ordered_qty, received_qty, short_reason`); received qty (not ordered qty) is what credits
  stock, so partial receipts don't over-credit.
- If a **warehouse** is selected, items **auto-land as stock IN** (`stock_movements`,
  `reference_type='RECEIVE'`, idempotent on `DN-<id>`).
- **Short supply → auto debit note:** if any `received_qty < ordered_qty`, a
  `short_supply` debit note `DBN/YYYY/####` is auto-raised (value = shortfall × PO rate),
  one per delivery note (guarded by a `[DN-<id>]` marker in the reason).
- **Engineer alert on mismatch (S16):** *only* when a short-supply debit was raised, the
  **site engineer (the indent raiser)** is notified by WhatsApp + SMS + email, all
  best-effort (never blocks the receipt). A clean, fully-matched receipt sends nothing.
- **Auto Sales Bill on receive:** when a **challan** with billable `PO`-type items is
  received and the PO has no Sales Bill yet, an **`INV/`** Sales Bill is auto-generated
  from the BOQ selling rates. It is flagged **draft** when the client GSTIN or any selling
  rate is missing. FOC/RGP-only challans get **no** sales bill (the challan *is* the
  delivery note).

#### Stage 8 — Debit / Credit Notes (tab: Debit Notes)
Review auto-raised short-supply debits or create one by hand. Debit **types** include
`short_supply`, rejected, and extra-rate. Each is numbered `DBN/YYYY/####`, can be emailed
to the vendor, printed (`GET /debit-notes/:id/print`), and settled.
*(A credit-note type — money owed back to the vendor — is not built.)*

#### Stage 9 — Client Sales Bill & Collections (auto on receive)
The Sales Bill `INV/…` is generated automatically on receive (Stage 7b) from BOQ selling
rates and flagged **draft** if the client GSTIN or rates are missing. Staff complete /
print the invoice; the DSO dashboard shows outstanding amounts and ageing per site.
(Detailed billing logic lives in the Sales Billing section.) A
`POST /auto-sales-bills/sweep` endpoint can back-fill any received challans that didn't
get a bill. *(Automatic client payment-reminder emails are not built.)*

#### Stage 10 — PO Pipeline (tab: PO Pipeline)
A single read-only tracking view of all POs across their stages
(`GET /po-pipeline`).

### 4.4.5 Auto-numbering
All document numbers come from the shared `nextSequence(db, table, column, prefix,
{startFrom, pad})` helper, giving a single authoritative source per series:

| Document | Series | Where generated |
|---|---|---|
| Indent | `IND-####` | `POST /indents` |
| Stock Issue Note | `SI/YYYY/####` | indent approval (store issue) |
| RGP gate pass | `RGP/YYYY/####` | indent approval (RGP items) |
| Vendor PO | `VPO/YYYY/####` | `POST /vendor-po` |
| Delivery Challan | `DC/YYYY/####` | `POST /delivery-notes`, auto on bill, store issue |
| Debit Note | `DBN/YYYY/####` | bill entry + receive (auto) and manual |
| Sales Bill (invoice) | `INV/YYYY/####` → current `GST/26-26/##` (started at 61, 2026-06-15) | auto on receive |

### 4.4.6 Short-supply debit notes + engineer alerts (summary)
Two automatic triggers raise a `short_supply` `DBN/…`:
1. **At bill entry** (Stage 6) — when item-wise variance shows received < ordered.
2. **On receive / GRN** (Stage 7b) — when per-line `received_qty < ordered_qty`; value =
   shortfall × PO rate; guarded by `[DN-<id>]` so it fires once.

On the receive trigger only, the **site engineer who raised the indent** is alerted via
WhatsApp + SMS + email. The notify path resolves the engineer through
`delivery_notes → vendor_pos → indents → users (created_by)` and is wrapped in try/catch so
it never blocks the receipt; it silently skips if Twilio/email is not configured.

### 4.4.7 Prints
| Document | Endpoint |
|---|---|
| Indent | `GET /api/procurement/indents/:id/print` |
| Vendor PO (SEPL-format PDF) | `GET /api/procurement/vendor-po/:id/print` |
| Delivery Note / Challan / Sales Bill | `GET /api/procurement/delivery-notes/:id/print` |
| Debit Note | `GET /api/procurement/debit-notes/:id/print` |
| Delivery-note data (for the dispatch view) | `GET /api/procurement/vendor-po/:id/delivery-note-data` |

### 4.4.8 Export (Excel / CSV)
The single **Export Excel** button exports whatever tab is active, via the
`exportCsv(name, headers, rows)` utility (`client/src/utils/exportCsv`):

| Active tab | File / columns |
|---|---|
| Raise Indent | `indents` — Indent No, Date, Site, Raised By, Status, Items |
| Vendor PO | `vendor-pos` — PO Number, PO Date, Vendor, Amount, Status |
| Purchase Bills | `purchase-bills` — Bill No, Vendor, Date, Amount, GST, Total, Payment |
| Dispatch | `dispatch` — ID, Type, Doc No, PO, Date, Received By, Received On, Status |
| Vendor Rates | `vendor-rates` — Item, Vendor 1/Rate 1 … Vendor 3/Rate 3, Final |

### 4.4.9 API endpoints — Indent → Dispatch (selected)
All under `/api/procurement`.

| Method & path | Purpose |
|---|---|
| `GET /vendors`, `POST /vendors`, `PUT /vendors/:id`, `DELETE /vendors/:id` | Vendor master |
| `GET /sites` | Sites/planning list for raising indents |
| `GET /boq-items`, `GET /boq-items-by-bb` | BOQ lines (by site / business book) |
| `GET /indents` | List indents |
| `POST /indents` | Raise indent (sets approval policy) |
| `PUT /indents/:id` | Approve (L1/L2/CRM), reject, edit, allocate stock |
| `GET /indents/:id` / `GET /indents/:id/print` | View / print |
| `POST /indents/:id/reset-store-issue` | Undo a store allocation |
| `DELETE /indents/:id` | Delete |
| `GET /indents/:id/items-for-po` | Finalised lines ready for a PO |
| `GET /indents/:id/quotation` | Auto-quotation feed |
| `GET /vendor-rates`, `POST /vendor-rates`, `DELETE /vendor-rates/:id`, `PUT /vendor-rates/:id/approve` | Vendor quote rows |
| `GET /item-rates`, `POST /item-rates`, `POST /item-rates/:id/finalize`, `DELETE /item-rates/:rate_id` | Per-item rates + finalise winner |
| `GET /pending-po-items` | Items finalised but not yet on a PO |
| `GET /vendor-po` | List POs |
| `POST /vendor-po` | Create PO (`VPO/…`) |
| `PUT /vendor-po/:id`, `DELETE /vendor-po/:id` | Edit / delete |
| `POST /vendor-po/:id/cancel`, `POST /vendor-po/:id/uncancel` | Cancel toggle |
| `PATCH /vendor-po/:id/clear-payment` | Mark advance/dues cleared |
| `GET /vendor-po/:id/print` | PO PDF |
| `GET /vendor-po/:id/with-items`, `GET /vendor-po/:id/bill-items`, `GET /vendor-po/:id/debit-source` | PO detail feeds |
| `GET /purchase-bills`, `POST /purchase-bills`, `DELETE /purchase-bills/:id` | Purchase bills (+ auto debit) |
| `GET /delivery-notes`, `POST /delivery-notes`, `PUT /delivery-notes/:id`, `DELETE /delivery-notes/:id` | Challans / dispatches |
| `PATCH /delivery-notes/:id/receive` | GRN: receive, stock-IN, auto debit, auto sales bill, engineer alert |
| `POST /delivery-notes/:id/sales-bill`, `POST /delivery-notes/:id/generate-sales-bill` | Attach / generate sales bill |
| `GET /delivery-notes/:id/print` | Challan / DN / sales-bill print |
| `POST /auto-sales-bills/sweep` | Back-fill missing sales bills |
| `GET /debit-notes`, `POST /debit-notes`, `PATCH /debit-notes/:id`, `DELETE /debit-notes/:id`, `GET /debit-notes/:id/print` | Debit notes |
| `GET /po-pipeline` | Cross-stage PO overview |
| `GET /sales-bills`, `POST /sales-bills`, `DELETE /sales-bills/:id` | Sales-bill rows |
| `POST /admin/wipe-indents-pos` | Admin clean-slate wipe (double-confirmed) |

### 4.4.10 DB tables (Indent → Dispatch)
- `indents` — header: `indent_number, status, planning_id, site_name, raised_by_name,
  client_name, created_by, approval_policy, l1_status/l1_by/l1_at, l2_status/l2_by/l2_at,
  crm_status, indent_category`.
- `indent_items` — lines: `description, unit, item_type (PO/FOC/RGP/RENTAL),
  item_master_id, po_item_id, indent_item_id linkage`.
- `indent_item_rates` — per-item vendor quotes + finalised winner (`final_rate,
  final_vendor_name, final_terms, final_credit_days, status='finalized'`).
- `vendor_pos` / `vendor_po_items` — PO header + lines (`po_number, vendor_id,
  total_amount, status`).
- `purchase_bills` — vendor bills.
- `delivery_notes` — multi-purpose: challan / RGP gate pass / sales bill (distinguished by
  `document_type`), plus receive fields (`received_by_name, received_at,
  receipt_file_path, items_json, warehouse_id, sales_bill_pending, sales_bill_number`).
- `debit_notes` — `dn_number, type, vendor_po_id, vendor_id, amount, reason, items_json,
  status`.
- `stock_issue_notes` — `SI/…` headers for store issues.
- `stock_movements` — inventory ledger (auto-IN on receive).

---

## 4.5 Order to Planning

### Business purpose
The bridge between a won deal (Business Book) and execution. It records the **Client
Purchase Order** (with payment-term milestones) and the **Order Planning** that links a PO
to a delivery window — the data that downstream procurement (BOQ, schedule) builds on.

### Who uses it
CRM / project planners and admins (`requirePermission('orders', …)`).

### Screen / tabs
Page title with two tabs (`Orders.jsx`):
1. **Client Purchase Orders** (`po`) — capture the client PO.
2. **Order Planning** (`planning`) — create a plan linking a PO/business-book to a
   window.

### Key fields
**Client PO** form: business book entry, PO number, PO date, total amount, advance amount,
PO copy link, BOQ file link, **payment-term milestones** (`pt_advance, pt_delivery,
pt_installation, pt_commissioning, pt_retention`), site engineer(s), CRM name, and status
(`received, booked, planning, in_progress, completed`). Selecting a business book
pre-fills the amount from `po_amount` / `sale_amount_without_gst`.

**Order Planning** form: PO, business book, planned start / end, notes.

### BOQ upload
A Client PO's BOQ can be uploaded from Excel (`po-template` download +
`po-upload-excel`), and labour rates separately (`labour-upload-excel`). These BOQ items
(`po_items`) are what the Schedule/Gantt and indents draw from.

### API endpoints — Orders
| Method & path | Purpose |
|---|---|
| `GET /api/orders/business-book-entries` | Won deals to attach a PO to |
| `GET /api/orders/po`, `POST /api/orders/po`, `PUT /api/orders/po/:id`, `DELETE /api/orders/po/:id` | Client POs |
| `GET /api/orders/po/:id/items`, `POST /api/orders/po/:id/items` | PO BOQ items |
| `GET /api/orders/po/:id/boq-items` | BOQ feed |
| `POST /api/orders/po/:id/labour-rates`, `POST /api/orders/po/:id/labour-rates/reset` | Labour rates |
| `GET /api/orders/po-template`, `POST /api/orders/po-upload-excel` | BOQ Excel template / upload |
| `POST /api/orders/labour-upload-excel` | Labour Excel upload |
| `GET /api/orders/planning`, `POST /api/orders/planning`, `PUT /api/orders/planning/:id`, `DELETE /api/orders/planning/:id` | Order planning |
| `GET /api/orders/bb/:bbId/items` | Items for a business book |

### DB tables
- `purchase_orders` — client PO header (incl. `pt_*` milestones, `business_book_id`).
- `po_items` — BOQ lines (`description, unit, quantity, rate, item_master_id, hsn_code`).
- `order_planning` — links PO/business book to a delivery window.

---

## 4.6 Schedule (Gantt) — Procurement Schedule

### Business purpose
A **backward-pass scheduler** that answers the single most important procurement question:
*"By what date must I raise the indent for each item so the project still finishes on
time?"* Starting from the project's committed completion date and working **backwards**
through six phases (install → receive → dispatch → PO → quotes → indent), subtracting each
phase's lead time in **business days**, it produces a Gantt and the must-raise-indent date
per BOQ item. AI predicts the per-item trade and dispatch lead time; a human reviews and
approves before the Gantt is generated.

### Who uses it
Project planners / procurement leads (`requirePermission('procurement_schedule', …)`).

### Screen / tabs
Page title **Procurement Schedule** (`ProcurementSchedule.jsx`). A custom SVG Gantt (no
chart library) with two-tier rows (a trade row, expandable to its items), bars coloured by
phase, and a red "Today" line. Tabs include **Schedule (Gantt)** and an AI/Setup area.

The six phases and colours:
`indent` (amber) → `quotes` → `po` → `dispatch` → `receive` → `install`.

### Backward-pass logic
`POST /:project_id/regenerate` (`procurementSchedule.js`):
1. Anchor on an end date — body `end_date` → saved meta → business-book
   `committed_completion_date` (user override always wins).
2. Pull BOQ items from `purchase_orders → po_items` for the project.
3. Load **holidays** and the **phase lead-time rules** map (per trade, in business days).
4. For each item, optionally apply AI overrides (`trade`, `dispatch_days`, `reasoning`),
   then compute backwards with `subBusinessDays(...)` (skips weekends + holidays):
   - `installEnd = completion_date`
   - `installStart = subBusinessDays(installEnd, install_days)`
   - `receiveEnd = installStart − 1`, `receiveStart = subBusinessDays(receiveEnd, receive_days)`
   - `dispatchEnd = receiveStart − 1`, `dispatchStart = subBusinessDays(dispatchEnd, dispatch_days)`
   - `poEnd = dispatchStart − 1`, `poStart = subBusinessDays(poEnd, po_days)`
   - `quotesEnd = poStart − 1`, `quotesStart = subBusinessDays(quotesEnd, quotes_days)`
   - `indentEnd = quotesStart − 1`, `indentStart = subBusinessDays(indentEnd, indent_days)`
5. Wipe old rows for the project and insert the six phase rows per item; the **earliest
   `indent.start_date`** is the headline "raise indent by" date.
6. A **snapshot** of the full row dump + meta is saved each time (browse history / restore
   without re-running AI).

The AI step (`POST /:project_id/ai-suggest`) calls Claude with the BOQ (and any attached
drawings) to predict each item's trade + dispatch lead time + reasoning, which the user
reviews before regenerating.

### 1-day-before reminder cron
A weekday cron (`server/scripts/procurementReminderCron.js`, wired up in
`server/index.js`, ~09:00 plus a boot catch-up):
1. Computes **tomorrow's business day**.
2. Scans `procurement_schedule` for live `phase = 'indent'` rows whose `end_date` equals
   that day.
3. Posts an **announcement + push notification** per item:
   *"⏰ Raise indent tomorrow: {item} … vendor lead time builds in from tomorrow."*
4. Dedups via a `procurement_schedule_reminders` table so nothing double-posts.
   Disabled with `ERP_DISABLE_PROCSCH_REMINDER=1`; an admin can also trigger the run
   on demand.

### API endpoints — Procurement Schedule
All under `/api/procurement-schedule`.

| Method & path | Purpose |
|---|---|
| `GET /phase-rules`, `PUT /phase-rules` | Per-trade lead-time table |
| `GET /holidays`, `POST /holidays`, `DELETE /holidays/:id` | Holiday list (business-day math) |
| `GET /projects` | Projects with a schedule |
| `GET /:project_id` | A project's schedule rows |
| `GET /:project_id/meta`, `PUT /:project_id/meta` | Setup card (start/end, client requirements) |
| `POST /:project_id/drawings`, `GET /drawing/:fileId`, `DELETE /drawing/:fileId` | Drawing attachments for AI |
| `POST /:project_id/ai-suggest` | Claude predicts trade + dispatch lead time per item |
| `POST /:project_id/regenerate` | Run the backward pass + write rows + snapshot |
| `GET /:project_id/snapshots`, `GET /snapshot/:id`, `DELETE /snapshot/:id` | Snapshot history |

### DB tables
- `procurement_schedule` — `project_id, item_id, trade, phase, start_date, end_date,
  status, lead_days, ai_reasoning`.
- `procurement_schedule_meta` — `project_id, start_date, end_date, client_requirements`.
- `procurement_schedule_snapshots` — full approved-Gantt dumps for history/restore.
- `procurement_schedule_reminders` — dedup ledger for the 1-day-before cron.
- Phase-rule and holiday tables back `/phase-rules` and `/holidays`.

---

## 4.7 Automation status (cross-reference)

Per `INDENT-TO-DISPATCH.md`, the 18-step automation grid currently stands roughly at:

- **Built / reused:** free-stock check + allocate (S2), L1/L2/CRM approvals (S3/S4),
  PO auto-number (S7 partial), auto delivery challan (S12), auto sales bill on receive
  (S14), GRN photo (S15), short-supply debit + engineer mismatch alert (S11/S16),
  PO Pipeline overview.
- **Partial:** vendor-rate side-by-side without auto-rank (S6), PO email not sent (S7),
  bill upload without OCR (S9), variance shown but no auto-book (S10), DSO dashboard
  without client reminders (S17).
- **Not built (by design or future):** low-stock auto-indent (S1), auto-RFQ email (S5),
  transporter SMS/WhatsApp (S8), RA-bill (S13, awaiting definition), credit-note type
  (S11 credit), auto-pay (S18 — kept manual, no payment gateway).

Integrations the flow leans on: **SMTP email** (RFQ/PO/reminders/alerts), **Twilio**
(SMS/WhatsApp engineer + transporter alerts), and **Claude AI** (Gantt lead-time
prediction, planned OCR).
