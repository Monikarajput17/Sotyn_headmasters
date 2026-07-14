# 3. Quotes & Orders

This section documents the modules that turn a sales lead into a priced quotation and, ultimately, a booked order. It covers five closely related screens:

1. **Quotations (BOQ / Drawings + Quotations)** — the classic, manual flow: build a Bill of Quantities, then issue a numbered quotation against it.
2. **AI Auto-Quotation (Estimator)** — upload a client BOQ (Excel / PDF / Word), let the AI match each line to the Item Master, and build a sale price automatically (PP → ACC → LAB → margin → SP).
3. **PO/FOC Stripped** — define each saleable PO item together with its free-of-cost (FOC) accessory kit, labour and margin, and run it through an approval workflow.
4. **Labour Rate** — the master sheet of item-wise labour / sub-contractor rates that feed PO/FOC and the Estimator.
5. **Extra-indent Auto-Quotation** — for Extra (Schedule / Non-Schedule) indents, auto-generate a SEPL-format client quotation priced from previous BOQs.

All quotation, BOQ, PO/FOC, labour and estimate endpoints live under the `/quotations` router (`server/routes/quotations.js`), except the Extra-indent quotation which lives under `/procurement` (`server/routes/procurement.js`). The whole router requires authentication (`authMiddleware`).

---

## 3.1 Quotations (BOQ & Quotations)

**File(s):** `client/src/pages/Quotations.jsx`, `server/routes/quotations.js`

### Business purpose

The original, manual quote flow. The sales team records what the client asked for as a **Bill of Quantities (BOQ)** — a list of items, quantities and rates — and then raises a formal, auto-numbered **Quotation** against that BOQ with an optional discount.

### Who uses it

Sales / estimation staff who own a lead. Deletion of BOQs and quotations is gated behind the `quotations` delete permission (`canDelete('quotations')`).

### Main screen — two tabs

The page is a single screen with two toolbar tabs (URL-synced via `useUrlTab`, default `boq`):

| Tab | Purpose |
|-----|---------|
| **BOQ / Drawings** | List + create Bills of Quantities |
| **Quotations** | List + create numbered quotations |

#### BOQ tab columns

| Column | Source |
|--------|--------|
| Title | `boq.title` |
| Client | `leads.company_name` (joined) |
| Drawing | `drawing_required` (Yes/No) |
| Total | `boq.total_amount` |
| Status | `boq.status` (`draft` / `submitted` / `approved`) |
| Date | `boq.created_at` |
| Actions | Delete (permission-gated) |

#### Quotations tab columns

| Column | Source |
|--------|--------|
| Number | `quotation_number` (e.g. `QTN-0001`) |
| Client | `leads.company_name` |
| Total | `total_amount` |
| Discount | `discount` |
| Final | `final_amount` |
| Status | `status` (`draft` / `sent` / `negotiation` / `accepted` / `rejected`) |
| Actions | Status dropdown (inline update) + Delete |

Both tabs have an **Export Excel** button (client-side CSV via `exportCsv`).

### Key fields

- **BOQ:** Lead/Client, Title (required), Drawing Required (checkbox), plus a repeating item grid of `{ description, quantity, unit, rate, item_id }`.
- **BOQ item:** picked from the Item Master via a `SearchableSelect` (`/item-master/dropdown`), or typed as free text. Picking a catalogue item auto-fills description, unit and the rate from `current_price`.
- **Quotation:** Lead/Client, BOQ Reference, Total Amount, Discount, Final Amount (read-only, auto = total − discount), Valid Until, Notes.

### Workflow — manual quote

1. Open **BOQ / Drawings → Create BOQ**.
2. Pick the Lead/Client and enter a Title; tick **Drawing Required** if applicable.
3. Add item rows. For each, either pick an Item Master entry (rate auto-fills from `current_price`) or type a free-text description.
4. When an item is picked, the **AI rate suggestion** panel appears (see below) showing the last rate quoted to this client and a 6-month avg/low/high; click **Use this** to adopt a rate.
5. Save — `POST /quotations/boq`. The total is computed server-side as `Σ (quantity × rate)`.
6. Switch to **Quotations → Create Quotation**. Pick the client and the BOQ reference, set Total/Discount (Final auto-computes), Valid Until and Notes.
7. Save — `POST /quotations` mints the next `QTN-####` number via `nextSequence`.
8. Drive the quotation through its lifecycle using the inline status dropdown (`draft → sent → negotiation → accepted / rejected`).

### AI rate suggestion (price intelligence)

When a catalogue item is selected on a BOQ row, the page calls `GET /ai-agent/rate-suggestion?item_id=…&lead_id=…`. The `RateSuggestion` component renders:

- **Last quoted to this client** (rate + who + how long ago), or
- **Last quoted (any client)** as a fallback, plus
- **Last 6 months** stats: count, average, low, high.

Each line has a one-click **Use this** to copy the suggested rate into the row. This keeps the team quoting consistently and prevents accidental underselling.

### Price-history side effect (the "AI Agent")

On `POST /quotations/boq`, for every line that is **linked to a catalogue item AND has rate > 0**, the server:

1. Inserts a row into `item_price_history` (`source = 'boq'`, with lead/company/boq context and who created it).
2. Updates `item_master.current_price` to that rate — so the newest quoted rate becomes the default suggestion everywhere.

### Print / PDF outputs

The manual Quotations page itself has no PDF; it offers **Export Excel** (CSV) for both BOQs and quotations. (The SEPL-format printable quotation is the Extra-indent auto-quotation in §3.5.)

### Delete guards

- `DELETE /quotations/:id` is refused (409) if any `purchase_orders` reference the quotation.
- `DELETE /quotations/boq/:id` is refused (409) if any `quotations` reference the BOQ; otherwise it cascades the BOQ items.

### API endpoints

| Method & path | Purpose |
|---------------|---------|
| `GET /quotations/boq` | List BOQs (with client + creator names) |
| `POST /quotations/boq` | Create a BOQ + items; logs price history |
| `GET /quotations/boq/:id` | One BOQ with its items |
| `DELETE /quotations/boq/:id` | Delete BOQ (blocked if quotations reference it) |
| `GET /quotations` | List quotations |
| `POST /quotations` | Create quotation (auto `QTN-####`) |
| `PUT /quotations/:id` | Update totals / status / notes |
| `DELETE /quotations/:id` | Delete (blocked if POs reference it) |

### DB tables

- **`boq`** — `id, lead_id, title, drawing_required, drawing_file, total_amount, status, created_by, created_at`.
- **`boq_items`** — `id, boq_id, description, quantity, unit, rate, amount` (the route also writes `item_id`).
- **`quotations`** — `id, lead_id, boq_id, quotation_number (UNIQUE), total_amount, discount, final_amount, status, valid_until, notes, created_by, created_at`.
- **`item_price_history`** — `id, item_id, rate, quantity, lead_id, company_name, boq_id, source, created_by, created_by_name, created_at`.

---

## 3.2 AI Auto-Quotation (Estimator)

**File(s):** `client/src/pages/Estimator.jsx` (UI) and `server/routes/quotations.js` (`/auto-match-boq`, `/estimates`, `/estimate-export`).

### Business purpose

A from-scratch (or BOQ-driven) **sale-price builder** that mirrors SEPL's own quotation spreadsheet. Pick items, the material rate auto-fills, add labour, set a margin **per category**, and the sale price is computed line by line. The big differentiator: you can **upload the client's BOQ** (Excel / PDF / Word) and AI matches every line to your Item Master and fills in the rates.

### Who uses it

Estimation staff preparing client quotations. Saved estimates are organised **by client**.

### Main screen

A header bar with **Build** / **Saved (by client)** toggle plus a **New** button. Build view sections:

1. **Header inputs:** Client/Lead, Quotation Title, **Accessories %** (a % of material applied to every line).
2. **Auto-build from Client BOQ:** an upload box accepting `.xlsx/.xls/.csv/.pdf/.doc/.docx`.
3. **Margin % per category:** one input per distinct category present in the rows.
4. **Items table** (the core grid).
5. **Manpower / Additional Cost** block (feeds the Excel SUMMARY sheet).
6. Action bar: Add Item, Save / Update, **Export Quotation (Excel)**, and a running Cost / Margin / Sale Price summary.

#### Items table columns

| Column | Meaning |
|--------|---------|
| # | row index |
| Item (from Item Master) | searchable picker + free-text description + AI badges + accessory/FOC sub-rows |
| Category | the item's department (drives the margin) |
| Qty | quantity |
| PP ₹ | **P**urchase **P**rice = material rate (auto from Item Master `current_price`) |
| ACC ₹ | accessories total (computed) |
| LAB ₹ | labour rate (manual, or from PO/FOC kit) |
| TP ₹ | per-unit base = PP + LAB |
| TPA ₹ | line total (cost) |
| Margin | category margin % |
| SP ₹ | sale price (computed) |
| Rate ₹ | sale rate per unit = SP ÷ Qty |

### Auto-pricing formula

Per row, computed in `calc()`:

```
subsCharged = Σ (sub.rate × sub.qty)  for each accessory/FOC sub that is NOT marked FOC
ACC         = subsCharged + PP × Qty × (Accessories% / 100)
TP          = PP + LAB                       (per-unit base: material + labour)
TPA         = TP × Qty + ACC                 (line cost)
SP          = TPA × (1 + categoryMargin% / 100)
Rate        = SP ÷ Qty                       (sale rate per unit)
```

Totals: `cost = Σ TPA`, `sp = Σ SP`, `marginAmt = sp − cost`.

Notes:
- **FOC sub-items** are listed but priced at ₹0 (they don't add to cost). A **non-FOC accessory** adds `rate × qty` to ACC.
- **Margin is per category** (`margins[category]`), not per line.
- All money is rounded to 2 decimals (`r2`).

### PO/FOC kit integration

On load, the page fetches `GET /quotations/po-foc` and indexes kits by `po_item_id` (approved kits win over drafts). When you pick an item that has a kit (`kitFields`), the row's **PP, labour (LAB) and FOC sub-items** are pulled from the PO/FOC kit (a 🔗 PO/FOC badge appears). This links the Estimator directly to the approved PO/FOC pricing in §3.3.

### Auto-build from a client BOQ — matching logic

`uploadBoq` posts the file to `POST /quotations/auto-match-boq` (multipart). The server:

1. **Extracts line items** by file type:
   - **PDF** → `pdf-parse` text → AI extraction (`llmExtractItems`) or fallback `textToLines` heuristic.
   - **Word (.doc/.docx)** → `mammoth` raw text → same AI / fallback path.
   - **Excel/CSV** → finds the header row (≥2 keyword matches among `description/qty/unit/rate/...`), reads the Description/Qty/Unit columns from each sheet; uses the sheet with the most rows.
2. **Loads candidates** = Item Master rows of `type='PO'` only (the things actually quoted), plus their PO/FOC kits keyed by `po_item_id`.
3. **Fuzzy-scores** each BOQ line against the catalogue (`scoreMatch`): tokenises descriptions (drops stop-words), scores by coverage of the item's keywords, weighted down hard for thin evidence (a single common material word can't score high; needs ~3 matched keywords for full weight).
4. **AI refinement** (`llmRefine`, best-effort): for each line it hands the top-8 fuzzy candidates to Claude, which picks the one true match or `null` for composite WORK lines (e.g. "construct brick masonry manhole"). Falls back to pure fuzzy if AI isn't configured or errors.
5. **Decides confidence** per line: a very strong fuzzy match (≥85 %) is auto-applied; otherwise the AI's pick (high ≥70, medium ≥40, low <40) or the fuzzy best (high ≥0.6, medium ≥0.3, low <0.3, none = 0).
6. Returns `{ count, rows[], matched_by: 'ai' | 'keyword' }`. Each row has `description, qty, unit, confidence, match, alternatives[]`. A matched item carries `kit_pp`, `kit_labour`, `kit_focs` from its PO/FOC kit.

In the UI, each row shows a confidence badge (✅ high / ⚠️ medium / ❗ low / ❗ no match) and a **try:** list of alternative matches that can be applied with one click. Low/none rows are highlighted red for quick review.

The AI key/model are read from `app_settings` (`ai_api_key`, `ai_model`, default `claude-opus-4-7`), set via the AI Settings UI. No key → matching silently degrades to keyword fuzzy.

### Saved estimates (by client)

- **Save / Update:** `POST /quotations/estimates` (or `PUT …/:id` when editing). Stores title, lead, client name, `acc_pct`, margins, full rows (with subs), manpower, and totals (`cost`, `sp`).
- **Saved view:** lists estimates grouped by client (`GET /quotations/estimates`), each with title, SP and date; **Edit** loads it back into Build, **Delete** removes it.

### Print / PDF / Excel outputs

Two Excel exports:

1. **Export (client-side CSV)** — `exportSheet`, a flat sheet with S.NO / Description / Unit / Qty / Rate / Amount / PP / ACC / LAB / TP / TPA / MARGIN % / SP / CATEGORY + a TOTAL line. (FOC sub-items are not listed separately.)
2. **Export Quotation (Excel)** — `exportXlsx` posts to `POST /quotations/estimate-export`, which builds a **multi-sheet workbook (SEPL "saizar" format)**:
   - One sheet **per category** (S.NO / DESCRIPTION / MAKE / UNIT / QTY / RATE / AMOUNT / PP / ACCESS / LAB / TP / TPA / MARGIN / SP + category TOTAL).
   - A **SUMMARY** sheet (placed first) with the SEPL letterhead, client/quotation meta, per-category SP subtotal, a **Manpower** block (`qty × monthly_cost × months`) and a GRAND TOTAL (= subtotal + manpower).

### API endpoints

| Method & path | Purpose |
|---------------|---------|
| `POST /quotations/auto-match-boq` | Upload client BOQ → matched lines + rates |
| `GET /quotations/estimates` | List saved estimates (by client) |
| `GET /quotations/estimates/:id` | One estimate (parsed margins/rows/manpower) |
| `POST /quotations/estimates` | Save a new estimate |
| `PUT /quotations/estimates/:id` | Update a saved estimate |
| `DELETE /quotations/estimates/:id` | Delete a saved estimate |
| `POST /quotations/estimate-export` | Multi-sheet quotation Excel (SUMMARY + per-category) |
| `GET /ai-agent/rate-suggestion` | (shared) last-quoted + 6-month rate stats |

### DB table

- **`estimate_quotations`** — `id, title, lead_id, client_name, acc_pct, margins_json ({category: marginPct}), rows_json (full estimator rows incl subs), manpower_json, cost, sp, created_by, created_at, updated_at`.

---

## 3.3 PO/FOC Stripped

**File(s):** `client/src/pages/PoFocStripped.jsx`, `client/src/pages/PoFocPrint.jsx`, `server/routes/quotations.js` (`/po-foc*`).

### Business purpose

Each saleable item (a **PO item**, `type='PO'` in the Item Master) is sold together with a **FOC kit** — free-of-cost accessories/consumables — plus **labour** and a **margin**. This module is where that bundle ("kit") is defined, costed and approved. The resulting kit feeds directly into the Estimator (§3.2) and the BOQ auto-match (§3.2 step 2).

### Who uses it

Estimation / pricing staff (define kits) and an approver (approve them). The list can hold 800+ kits, so the screen is performance-tuned (in-memory rate maps server-side, in-place approve client-side, capped/searchable lists).

### Main screen — three status tabs

| Tab | Status | Colour |
|-----|--------|--------|
| **Non-Approved** | `non_approved` | amber |
| **Approved** | `approved` | emerald |
| **Re-Approved** | `re_approved` | blue |

Above the tabs is a **Category filter** (the PO item's Item Master department, e.g. Fire Fighting) that applies to every tab.

**Non-Approved tab** is special: besides showing saved draft kits (searchable, capped at 30), it lists **PO items that still need a FOC kit** (capped at 50, searchable) with a **Define FOC** button each — so you can systematically work through every uncovered PO item.

### Each kit (card) shows

PO item name + status badge; Qty, PO ₹, Margin %, FOC count, labour (name, rate × qty, labour margin); the FOC list; and on the right the **TPA** and **cost**. Approved/Re-Approved cards have a **View PDF** link.

### Key fields (the edit modal)

| Field | Notes |
|-------|-------|
| PO Item | `SearchableSelect` over Item Master `type=PO`; picking it sets `po_rate` from `current_price`. An ✎ opens that item in Item Master in a new tab. |
| Qty | shows the item's UOM next to the label |
| PO Rate ₹ | per the item's UOM |
| Margin % | dropdown: 10/20/30/40/50/75/100; applies to PO + FOC |
| Labour Item | from the Labour Rate sheet; ✎ edits it, ➕ adds a new one |
| Labour Rate ₹ | per labour UOM |
| Labour Margin % | own margin, default 50 % |
| FOC Items | up to **10** items (Item Master `type=FOC`), each with qty (1–10), UOM and rate |

### Auto-pricing formula

Computed both client-side (`calc`) and server-side (`computePoFoc`):

```
poAmt    = poRate × qty
focAmt   = Σ (foc.rate × foc.qty)
labourAmt= labour × qty                         (labour RATE × PO qty)
cost     = poAmt + focAmt + labourAmt
TPA      = (poAmt + focAmt) × (1 + margin% / 100)
         + labourAmt × (1 + labourMargin% / 100)
```

So PO + FOC carry the item margin, while labour carries its own (default 50 %).

### Workflow & approval state machine

1. Open **New PO/FOC** (or **Define FOC** for a pending PO item).
2. Pick the PO item (rate auto-fills), set Qty and Margin.
3. Optionally pick a Labour item (rate auto-fills) and its margin.
4. Add up to 10 FOC items.
5. **Save (keep pending)** → status `non_approved`, or **Approve** → save then `POST …/approve` → `approved`.
6. Editing an **approved** kit moves it to **`re_approved`** (server rule in `PUT`); re-approving it sends it back to `approved`.
7. **Approve** from a card flips it in place (no full reload) for speed.

### Live rates (important behaviour)

`GET /po-foc` resolves every entry **live** against the Item Master and Labour Rate sheet (`liveResolvePoFoc` + `buildLiveMaps`): PO rate, FOC rates/names/UOM and labour rate are re-read by id on every load, and **cost/TPA are recomputed** from those live rates. Stored values are only a fallback for deleted or manually-typed items. So editing an item's rate in the master automatically updates all kits that reference it. The two bulk reads (items + labour into Maps) replaced thousands of per-row queries to keep the 800-kit page fast.

### Print / PDF output

`PoFocPrint.jsx` at **`/po-foc/:id/print`** (linked from approved cards) renders a printable **PO / FOC SHEET** with the SEPL letterhead: a header table (PO item, status, qty, PO rate, margin, labour), a line table (the PO line + each FOC line + a labour line), and a footer showing **Cost (PO + FOC + Labour)** and **TPA**. Print/Save-as-PDF via the browser.

### API endpoints

| Method & path | Purpose |
|---------------|---------|
| `GET /quotations/po-foc` | All kits (live-resolved) + status counts |
| `GET /quotations/po-foc/:id` | One kit (live-resolved) |
| `POST /quotations/po-foc` | Create kit (`non_approved`) |
| `PUT /quotations/po-foc/:id` | Update (approved→re_approved) |
| `POST /quotations/po-foc/:id/approve` | Approve |
| `DELETE /quotations/po-foc/:id` | Delete kit |

### DB table

- **`po_foc_entries`** — `id, po_item_id, po_name, po_rate, qty, labour (rate), labour_item_id, labour_name, labour_margin (default 50), margin (default 30), focs_json ([{item_id,name,qty,rate}]), cost, tpa, status (non_approved/approved/re_approved), created_by, approved_by, approved_at, created_at, updated_at`.

---

## 3.4 Labour Rate

**File(s):** `client/src/pages/LabourRate.jsx`, `server/routes/quotations.js` (`/labour-rates*`). (`server/routes/labourPayment.js` is a separate payroll concern and not part of this sheet.)

### Business purpose

The master sheet of **item-wise labour / sub-contractor rates** by UOM and category. These rates are the source for the **Labour Item** picker in PO/FOC (§3.3) and, transitively, the Estimator's LAB column. Seeded from SEPL's uploaded sheet.

### Who uses it

Estimation / pricing staff. It can be opened deep-linked from PO/FOC (the labour ✎ / ➕ buttons) via URL params:
- `?edit=<name>` auto-opens that item's edit modal,
- `?add=1` opens a blank add modal,
- `?search=<text>` pre-filters the list.

### Main screen

A toolbar (Duplicates, Import, Export Excel, Add Labour Item), category pill filters (**All / Low Voltage / ELECTRICAL / Fire Fighting**) + a search box, and the table (capped at 200 rows rendered, search/filter to narrow).

#### Columns

| Column | Source |
|--------|--------|
| Task ID | `LR-<id>` |
| Item Name | `item_name / specification / size` |
| Rate ₹ | `rate` (purchase / sub-contractor rate) |
| UOM | `uom` |
| Category | `category` |
| (actions) | Edit / Delete |

### Key fields

Item Name (required), Specification, Size, Rate ₹, UOM (Kg, PCS, Nos, Each, Per Ltr, mtrs, RMT, RFT, R mtr, Per Point), Category (Low Voltage / ELECTRICAL / Fire Fighting).

### Workflow

1. **Add Labour Item** (or Edit) → fill the form → Save (`POST` / `PUT /labour-rates`).
2. **Export Excel** downloads the filtered set as a real `.xlsx` (respects search/category).
3. **Import** opens a modal with a downloadable template; upload `.xlsx/.xls/.csv` (header row 1, `Item Name` required). Rows are **added** (existing items untouched); skipped rows are reported.
4. **Duplicates** scans for labour items sharing the same name (case/space-insensitive) — these splinter one task across rows and break the live link from PO/FOC kits. Pick the row to **keep** (the one used by kits is pre-selected and badged), then **Merge**: any PO/FOC kits using the removed rows are repointed to the kept row in one transaction, then the duplicates are deleted.

### Print / PDF outputs

No PDF; Excel **export** + a blank **template** are provided. Downloads go through axios as a blob so the JWT header is sent.

### API endpoints

| Method & path | Purpose |
|---------------|---------|
| `GET /quotations/labour-rates` | List (filters: `search`, `category`) |
| `POST /quotations/labour-rates` | Add a labour item |
| `PUT /quotations/labour-rates/:id` | Update |
| `DELETE /quotations/labour-rates/:id` | Delete |
| `GET /quotations/labour-rates/export` | Download as `.xlsx` (respects filters) |
| `GET /quotations/labour-rates/template` | Blank import template `.xlsx` |
| `GET /quotations/labour-rates/duplicates` | Same-name groups + kit-usage count |
| `POST /quotations/labour-rates/merge` | Merge dupes (repoint kits, delete others) |
| `POST /quotations/labour-rates/import` | Bulk import from uploaded file |

### DB table

- **`labour_rates`** — `id, item_name (required), specification, size, rate, uom, category, created_by, created_at, updated_at`. Referenced by `po_foc_entries.labour_item_id`.

---

## 3.5 Extra-indent Auto-Quotation (SEPL format)

**File(s):** `client/src/pages/QuotationPrint.jsx`, `server/routes/procurement.js` (`buildExtraQuotation` + `GET /procurement/indents/:id/quotation`).

### Business purpose

For **Extra (Schedule / Non-Schedule)** indents — additional work beyond the original order — the system auto-generates a printable client quotation in SEPL's BARAWARE format, so the team can quickly bill extras.

- **Extra-Schedule:** auto-priced (each chargeable line is priced from a previous BOQ — see below).
- **Extra-Non-Schedule:** quotation is prepared **manually** (no schedule rate exists for those items).

### Who uses it

Procurement / billing staff handling extra-work indents. Opened at **`/quotation/:indentId/print`**.

### Auto-pricing logic (`buildExtraQuotation`)

1. Load the indent; resolve the **client** from the linked planning Business Book, else match a Business Book row by the indent's site name.
2. Select **chargeable lines** = all indent items EXCEPT free items (`item_type` FOC / RGP) and from-store lines.
3. For each line, take the BOQ name (the linked `po_items.description` if present, else the line description) and look up its **rate**:

   > the MOST RECENT previous BOQ (`po_items`) row whose `description` **exactly** matches (case/space-insensitive) the item name, with `rate > 0` — ordered by `id DESC LIMIT 1`.

4. Compute `amount = qty × rate` (rounded 2 dp) and sum to `supply_total`. Lines with no matching previous BOQ rate get **rate 0** and a `rate_found: false` flag.

The endpoint returns `{ company, quotation {no, date}, client, items[], supply_total, basic_amount, indent_number }`, where the quotation number is `SEPL/QTN/<indent_number or id>`.

### Print layout (`QuotationPrint.jsx`)

A royal-blue SEPL-branded printable page:

- Header: SE logo box, company name, Head Office / Corporate Office / Website.
- Client + quotation meta grid (Name/Client, Address, GSTIN; Date, Quotation No, Prep By = SEPL, Revision No = 0, Ref Indent).
- **CHAPTER-1 : SUPPLY** table — S.No / Description / Unit / Qty / Rate / Amount + TOTAL. Lines with no previous BOQ rate are tagged "(no previous BOQ rate — fill manually)".
- **BASIC AMOUNT** total + "Taxes extra as per actual government rates."
- A full **Terms & Conditions** list (validity 10 days, 50/40/10 payment terms, warranty, completion 90 days, scope splits, etc.).
- Footer tagline and "For SECURED ENGINEERS PVT. LTD."

A toolbar (hidden on print) offers **Back** and **Print / Save PDF**; an amber banner warns if any line was priced at ₹0.

### API endpoint

| Method & path | Purpose |
|---------------|---------|
| `GET /procurement/indents/:id/quotation` | Auto-quotation data for an Extra indent |

### DB tables (read)

- **`indents`**, **`indent_items`** — the indent and its lines (with `po_item_id`, `item_type`, `source`).
- **`po_items`** — previous BOQ lines (the rate source for exact-name matching).
- **`business_book`**, **`order_planning`** — to resolve the client.

---

## 3.6 Relationship: Quotation → Business Book order

The quotation modules sit at the **front** of the order lifecycle, and several lines of evidence link a quotation to a booked order:

1. **Lead → BOQ → Quotation.** A quotation references both a `lead_id` and a `boq_id`. The lead is the prospect; the BOQ is the scoped item list; the quotation is the priced offer (`quotations.quotation_number`, e.g. `QTN-0001`).
2. **Quotation → Purchase Order.** When the client accepts, a **Purchase Order** is recorded that references the quotation (`purchase_orders.quotation_id`). The delete guard on `DELETE /quotations/:id` (409 if any PO references it) enforces this dependency.
3. **PO/Order → Business Book.** The accepted order is booked into the **Business Book** (`business_book`) — SEPL's master "New Business Booked" sheet — which then drives `order_planning`, indents and downstream procurement. The Extra-indent auto-quotation (§3.5) closes the loop: it reads back from `business_book`/`order_planning` (to identify the client) and from previous BOQs (`po_items`) to price extra work.
4. **Pricing memory loops back.** Rates quoted in BOQs are written to `item_price_history` and `item_master.current_price`, so the AI rate suggestion and the Estimator's PP column reflect the most recent real quotes — every order's pricing informs the next quotation.

In short: **Lead → BOQ → Quotation → (accepted) → Purchase Order → Business Book order → Order Planning / Indents**, with the Estimator and PO/FOC modules supplying the sale-price intelligence that feeds the quotations at the start of that chain.
