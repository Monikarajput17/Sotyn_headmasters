# 8. Inventory & Assets

This section documents the five physical-stock and equipment modules of the SEPL ERP:

| Module | Page | Route prefix | What it tracks |
| --- | --- | --- | --- |
| **Tool Rentals** | `RentalTools.jsx` | `/api/rental-tools` | Renting in tools/machinery from outside vendors (scissor lifts, drills, etc.) through a 4-stage enquiry → rate → received → returned workflow with an auto-generated PO |
| **Company Assets** | `CompanyAssets.jsx` | `/api/company-assets` | IT / office equipment register (laptops, phones, SIMs, monitors), issued to employees |
| **Inventory** | `Inventory.jsx` | `/api/inventory` | Warehouse / site-store consumable stock with IN/OUT/transfer movements, valuation, and barcode scanning |
| **Tools** | `Tools.jsx` | `/api/tools` | Returnable company-owned tool catalog (serial, calibration, condition) issued to sites or people |
| **Room Rentals** | `Rentals.jsx` | `/api/rentals` | Staff/labour accommodation: rented properties/rooms, bookings, and the "Raise Rent" payment-request workflow |

All five are permission-gated through the standard `requirePermission(module, action)` middleware (`view` / `create` / `edit` / `delete`, and `approve` where applicable). Source files:

- `client/src/pages/RentalTools.jsx`, `client/src/pages/RentalPOPrint.jsx`, `server/routes/rentalTools.js`
- `client/src/pages/CompanyAssets.jsx`, `server/routes/companyAssets.js`
- `client/src/pages/Inventory.jsx`, `client/src/components/BarcodeScanner.jsx`, `server/routes/inventory.js`
- `client/src/pages/Tools.jsx`, `server/routes/tools.js`
- `client/src/pages/Rentals.jsx`, `server/routes/rentals.js`

---

## 8.1 Tool Rentals

### Business purpose

Tool Rentals manages **renting equipment IN from external vendors** — scissor lifts, drilling rigs, welding sets and similar machinery the company needs on site for a fixed number of days but does not own. It is a SLA-tracked, four-stage workflow (mam's spec, 2026-05-16) that ends with the rented item being returned to the vendor. A vendor **Purchase Order is auto-created** the moment the rate is finalised, so the rental itself becomes the procurement artifact.

### Who uses it

- **Site engineers** raise the enquiry (Stage 1) and confirm material received on site (Stage 3) with a live photo + GPS.
- **Ajmer** (the designated rental approver) finalises the vendor rate (Stage 2, which auto-creates the PO) and signs off the return (Stage 4).
- The approver is identified by `app_settings.rental_approver_user_id`, set once by an admin from the page's top-right gear. If unset, any user whose role has `can_approve = 1` on the `rental_tools` module may perform the approver-gated steps (`canApprove()` in `rentalTools.js`).

### The four stages

The internal DB enum is `enquiry → rate_finalised → material_received → returned` (plus `cancelled`). The display labels are admin-renamable (stored as a single JSON blob in `app_settings.rental_tools_stage_labels`, defaults below):

| Stage enum | Default label | Owner | SLA target |
| --- | --- | --- | --- |
| `enquiry` | Stage 1 — Enquiry Raised | Site engineer | created_at + **5 business hours** (`stage1_target_at`) |
| `rate_finalised` | Stage 2 — Rate Finalised | Ajmer (approver) | date_of_requirement + **1 business day** (`stage2_target_at`) |
| `material_received` | Stage 3 — Material at Site | Site engineer | material_received + **days_required** business days (`return_target_date`) |
| `returned` | Stage 4 — Returned · Closed | Ajmer (approver) | — (closes the enquiry) |
| `cancelled` | Cancelled | any editor | — |

SLA breaches are flagged per stage on transition (`stage1_breached`, `stage2_breached`, `stage3_breached`), and the dashboard counts open overdues per stage. Business-hour/day maths use `server/lib/businessHours.js` (`addBusinessHours`, `addBusinessDays`, Sunday-skipped).

### Main screen / tabs

`RentalTools.jsx` uses `useUrlTab('dashboard')`. The dashboard shows per-stage chip counts, breach counts, open total, total in-flight value (`SUM(vendor_rate * days_required)`), and this-month enquiry count. The enquiry list is filterable by `stage`, `status`, and free-text `q` (site / enquiry no / tool / vendor). List columns: **Enquiry · Site · Tool · Days · Site Eng · Stage · Status · Vendor · Rate · PO**.

### Key fields (table `rental_tool_enquiry`)

- `enquiry_no` — auto-numbered `RT-YYYY-####`
- `site_id` / `site_name`, `tool_description`, `date_of_requirement`, `days_required`
- `site_engineer_id` / `site_engineer_name`
- `vendor_id`, `vendor_name`, `vendor_rate`, `vendor_rate_unit` (default `per_day`)
- `po_id`, `po_number` (links the auto-created `purchase_orders` row)
- `material_received_photo`, `material_received_lat`, `material_received_lng`, `return_target_date`
- `current_stage`, `status` (`open` / `closed` / `cancelled`), breach flags, audit timestamps, `created_by` / `rate_finalised_by` / `return_signed_by`

### Step-by-step workflow

1. **Raise enquiry** — `POST /enquiries`. Requires `site_name`, `date_of_requirement`, `days_required (> 0)`. Sets `current_stage='enquiry'`, computes `stage1_target_at = now + 5 business hours`, writes a `rental_tool_history` row.
2. **Finalise rate** (Ajmer) — `POST /enquiries/:id/finalise-rate`. Requires `vendor_id`, `vendor_name`, `vendor_rate`, `po_number`, `po_date`, `total_amount`. In one transaction it **inserts a `purchase_orders` row** (business_book_id NULL — rentals are operational, not tied to a sale) and updates the enquiry to `rate_finalised`, locking vendor + rate + PO and computing `stage2_target_at`.
3. **Material received** (site engineer) — `POST /enquiries/:id/material-received` (multipart). Requires a live `photo` upload **and** `latitude` + `longitude`. Stores the photo under `/uploads/rental-tools/`, sets `return_target_date = today + days_required` business days, moves to `material_received`.
4. **Return** (Ajmer) — `POST /enquiries/:id/return`. Sets `returned_at`, `return_signed_by`, optional `return_notes`; moves to `returned`, `status='closed'`, stamps `stage3_breached`.
5. **Cancel** — `POST /enquiries/:id/cancel` at any open stage sets `status='cancelled'`.

### PO numbering & print

The PO number is **entered by the approver** at Finalise-Rate (not auto-sequenced here), along with `po_date`, `advance_amount`, and `total_amount`. The PO row is created directly in the shared `purchase_orders` table. `RentalPOPrint.jsx` (route `/rental-po/:enquiryId/print`) renders a print-styled vendor PO from a single `GET /enquiries/:id` fetch (which joins vendor-master fields + the linked `purchase_orders` row). It uses the same SEPL company header as `VendorPOPrint.jsx` with a slim rental-specific terms list, and relies on the browser's Print → Save-as-PDF (no server PDF library).

### API endpoints — `/api/rental-tools`

| Method | Path | Purpose | Permission |
| --- | --- | --- | --- |
| GET | `/dashboard` | Stage counts, breaches, value, approver, labels | view |
| GET | `/settings/stage-labels` | Defaults + current labels | view |
| PUT | `/settings/stage-labels` | Rename stage labels (admin only) | edit |
| PUT | `/settings/approver` | Set/clear `rental_approver_user_id` (admin only) | edit |
| GET | `/enquiries` | List (filters: stage, status, q) | view |
| GET | `/enquiries/:id` | Single enquiry + history + linked PO | view |
| POST | `/enquiries` | Raise enquiry (Stage 1) | create |
| POST | `/enquiries/:id/finalise-rate` | Lock rate + auto-create PO (Stage 2) | create + approver |
| POST | `/enquiries/:id/material-received` | Live photo + GPS (Stage 3) | edit |
| POST | `/enquiries/:id/return` | Sign return / close (Stage 4) | edit + approver |
| POST | `/enquiries/:id/cancel` | Cancel an open enquiry | edit |

### DB tables

- `rental_tool_enquiry` — the workflow record
- `rental_tool_history` — per-transition log (`from_stage`, `to_stage`, `triggered_by`, `notes`, `entered_at`)
- `purchase_orders` — the auto-created PO (shared table)
- `app_settings` — `rental_approver_user_id`, `rental_tools_stage_labels`

---

## 8.2 Company Assets

### Business purpose

A register of **IT / office equipment** — laptops, desktops, mobiles, tablets, SIM cards, monitors, routers, printers, etc. — with full issue/return/maintenance/scrap movement history per asset for audit. SIMs and subscriptions carry a `monthly_cost` so the dashboard can show recurring spend.

### Who uses it

IT / admin staff with the `company_assets` permission. Assets are issued to **employees** (`users`), not sites.

### Main screen / columns

Single-table page (`CompanyAssets.jsx`). Category options: **Laptop, Desktop, Mobile, Tablet, SIM Card, Monitor, Router, Printer, Charger, Other** (and more). Stat cards include total value and **Monthly Recurring** (SIM/subscription). Table columns: **Asset No · Category · Name/Model · Serial/IMEI · SIM/Mobile · Issued To · Condition · Status · Value · Actions**. Filters: category, status, search (matches name/brand/model/serial/imei/ip/mobile/asset_no). The add form shows category-specific fields — IP address for Laptop/Desktop/Monitor/Router/Printer; SIM number/ICCID, mobile number, carrier, and monthly cost for SIM Card / Mobile.

### Key fields (table `company_assets`)

`asset_no` (auto `AST-YYYY-####`), `category`, `name`, `brand`, `model`, `serial_no`, `imei`, `ip_address`, `mobile_number`, `carrier`, `monthly_cost`, `purchase_date`, `purchase_price`, `vendor`, `warranty_till`, `condition` (`new`/`good`/`fair`/`poor`/`damaged`/`scrap`), `status` (`available`/`issued`/`maintenance`/`lost`/`scrapped`), `current_user_id` / `current_user_name`, `issued_at`, `returned_at`, `photo_url`, `notes`.

> There is **no automatic depreciation** — `purchase_price` is stored as-is and the dashboard sums it as `total_value` (excluding lost/scrapped). Depreciation is not computed.

### Workflow & movements

1. **Create** (`POST /`) — auto-assigns `asset_no`. If created already `issued` with a `current_user_id`, an initial `issue` movement is logged.
2. **Issue** (`POST /:id/issue`, body `user_id`, `notes`) — must be `available`; sets status `issued`, stamps `issued_at`, logs an `issue` movement (from→to user).
3. **Return** (`POST /:id/return`, body `notes`, `condition`) — must be `issued`; sets `available`, clears user, stamps `returned_at`, optionally updates condition, logs a `return` movement.
4. **Maintenance** (`POST /:id/maintenance`) — sets `maintenance`, clears user, logs a `maintenance` movement.
5. **Scrap / Lost** (`POST /:id/scrap`, body `lost` boolean) — sets `scrapped` or `lost`, logs a `scrap` movement.

Movement types: `issue`, `return`, `maintenance`, `scrap`. Each row records `from_user_id`, `to_user_id`, `notes`, `performed_by`, `performed_at` in `company_asset_movements`.

### API endpoints — `/api/company-assets`

| Method | Path | Purpose | Permission |
| --- | --- | --- | --- |
| GET | `/` | List (filters: category, status, search, current_user_id) | view |
| GET | `/stats` | Counts by status/category, total value, monthly recurring | view |
| GET | `/:id` | Asset + movement history | view |
| POST | `/` | Create asset | create |
| PUT | `/:id` | Edit asset fields | edit |
| POST | `/:id/issue` | Issue to employee | edit |
| POST | `/:id/return` | Return to inventory | edit |
| POST | `/:id/maintenance` | Send for maintenance | edit |
| POST | `/:id/scrap` | Mark scrapped / lost | edit |
| DELETE | `/:id` | Delete asset | delete |

### DB tables

- `company_assets`
- `company_asset_movements`

---

## 8.3 Inventory

### Business purpose

The core **consumable-stock** system. Tracks quantities and valuation of material across **warehouses**, supporting opening balances, GRN/purchase receipts (IN), site issues and inter-warehouse transfers (OUT), and a full movement journal. Stock valuation uses a **moving weighted average** on IN movements.

### Who uses it

Store keepers / procurement / project staff with the `inventory` permission. The most important consumer of inventory data, however, is the **Procurement indent-approval flow** (see 8.3.7), which reads free office stock to allocate "from-store" against indented quantities.

### Warehouse vs site stock

There are two warehouse `type`s:

- **`office`** — head-office store(s). This is the free stock the procurement approver can draw from.
- **`site_store`** — a per-site store, linked to a `sites` row via `site_id` (required on create).

The dashboard and per-line stock visibility split totals by `warehouse.type` into **Office stock** vs **Site stock**.

### Main screen / tabs

`Inventory.jsx` (`useUrlTab('stock')`) exposes these tabs:

| Tab | What it does |
| --- | --- |
| **Stock** | Current balances per (warehouse × item) with effective rate, value, condition; inline edit/delete |
| **Opening Stock (item-wise)** | Enter opening balances item-by-item (create-only) |
| **Receive (IN)** | Record a GRN/purchase/opening/adjust IN movement into one warehouse, multiple lines, with optional per-line photo and **barcode scan** |
| **Issue / Transfer (OUT)** | Issue stock to a site (consumption) or transfer to another warehouse, with **barcode scan** |
| **Movements** | Filterable journal of all IN/OUT movements |
| **Reports & Valuation** | Per-warehouse roll-up |
| **Warehouses** | Create / rename / activate-deactivate warehouses |

The IN/OUT/opening tabs are gated on `create` permission; warehouse edit/create gated accordingly.

### Stock balance, rate & valuation

Each `stock_balance` row is a unique (warehouse_id × item_master_id) with `quantity`, `avg_rate`, `reorder_level`, and a `condition` column (`Used` / `Unused` / `Scrap`; added 2026-05-29 so balances can be flipped inline without forcing a movement). Legacy rows with no condition were one-time backfilled to `Used` (guarded by `app_settings.stock_condition_used_backfill_v1`).

**Effective rate / value** (in `GET /stock`): use `avg_rate` when > 0, otherwise fall back to `item_master.current_price`; `rate_source` is tagged `movements` / `master` / `none` so the UI can show a "from master" hint. `value = effective_rate × quantity`.

### Stock movements (IN / OUT / transfer / issue / adjust)

All quantity changes go through `applyMovement()` inside a SQLite transaction so the balance and the journal stay consistent:

- **IN** — new qty = prev + qty; `avg_rate` recomputed as weighted average `((prevQty·prevRate)+(qty·inRate))/newQty`.
- **OUT** — decrement; **throws if it would go negative** (no negative stock allowed); `avg_rate` unchanged.

Reference types seen in `stock_movements.reference_type`: `OPENING`, `PURCHASE`, `GRN`, `ISSUE`, `TRANSFER`, `ADJUST`, `RGP`, `ISSUE_REVERSAL`.

**Receive (`POST /receive`)** — body `{ warehouse_id, items:[{item_master_id, quantity, rate, photo_url?, item_condition?}], reference_type, reference_id, notes }`. Each line becomes one IN movement.

**Issue / Transfer (`POST /issue`)** — body `{ from_warehouse_id, items:[{item_master_id, quantity}], destination_type ('site'|'warehouse'), destination_id, reference_type, reference_id, notes }`.
- **Issue to site** (`destination_type='site'`) — one OUT movement per line, `site_id` set, `reference_type='ISSUE'`.
- **Transfer** (`destination_type='warehouse'`) — writes **two** halves sharing one `reference_id` (`XFR-<timestamp>` if not supplied): an OUT from the source and an IN into the destination, both carrying the source's current avg rate. Source and destination must differ.

**Manual adjust (`PATCH /stock/:id`)** — edit qty, avg_rate, and/or condition for one balance row. A condition-only edit is handled inline. A qty change records an `ADJUST` movement (IN if up, OUT if down). **Delete (`DELETE /stock/:id`)** writes a final OUT `ADJUST` for the remaining qty, then removes the balance row.

### Barcode scanning

`client/src/components/BarcodeScanner.jsx` is a camera modal wrapping **`html5-qrcode`** (lazy-imported to keep the page bundle small). It prefers the rear camera (`/back|rear|environment/`), scans at 10 fps, and on the first successful read calls `onScan(decoded)` and closes. The Receive and Issue tabs each render a per-line "Scan" button (`setScanFor(index)`); `onScanResult` matches the decoded text against `item_master.item_code` (case-insensitive) or the numeric id and auto-fills that line, toasting success or "No item with code …". Falls back gracefully with an instructions panel when camera permission is denied.

### Reorder / low stock

`reorder_level` per balance row drives the low-stock view (`GET /low-stock`, and `low_only=1` on `/stock`): rows where `reorder_level > 0 AND quantity <= reorder_level`, ordered by how far below the level they are. `PUT /reorder/:warehouse_id/:item_master_id` upserts the level even before any stock exists.

### How Inventory free-stock feeds Procurement indent approval allocation

This is the key cross-module integration (in `server/routes/procurement.js`):

1. **Stock visibility at approval** — when an indent is opened for approval, for every line linked to an `item_master_id` the system sums `stock_balance.quantity` grouped by `warehouse.type` (active warehouses only) and attaches `office_stock` and `site_stock` to the line. Office = head-office store; Site = total across **all** site stores (so the approver can see "send from another site"). Lines with no `item_master_id` get 0/0.
2. **Allocate "from store"** — at approval the approver can take part/all of a line's quantity from existing office stock. The line is split into a **parent** row (`source='procure'`, qty = approved − from_store, continues to vendor PO) and a **child** row (`source='store'`, qty = from_store), tied by `parent_item_id`.
3. **Atomic stock-out** — `from_store` is validated against `SUM(stock_balance.quantity)` across **office** warehouses. On approval the system greedy-decrements `stock_balance` across office warehouses (smallest warehouse id first / FIFO), writes one `stock_movements` OUT (`reference_type='ISSUE'`) per warehouse touched, and creates one `stock_issue_notes` header (`SI/YYYY/####`) the storekeeper can print as a challan.
4. **RGP** — approved RGP-from-store lines similarly greedy-decrement office stock (`reference_type='RGP'`), best-effort and non-blocking (never go negative / never block approval).
5. **Reversal** — un-approving / reversing an issue note reads the `ISSUE` OUT movements by `reference_id` and adds the qty back, logging `ISSUE_REVERSAL` IN movements.

So free **office** stock directly reduces the quantity that flows to a vendor PO, and the deduction is journaled as ISSUE movements with a printable SI note.

### API endpoints — `/api/inventory`

| Method | Path | Purpose | Permission |
| --- | --- | --- | --- |
| GET | `/warehouses` | List warehouses + item count + total value | view |
| POST | `/warehouses` | Create warehouse (office / site_store) | create |
| PUT | `/warehouses/:id` | Rename / activate / deactivate | edit |
| GET | `/stock` | Balances (filters: warehouse_id, search, low_only) | view |
| GET | `/summary` | Per-warehouse roll-up | view |
| GET | `/low-stock` | Items at/below reorder level | view |
| POST | `/receive` | IN movement (one warehouse, many items) | create |
| POST | `/issue` | OUT — issue to site or transfer to warehouse | create |
| GET | `/movements` | Journal (filters: warehouse, item, type, ref, dates, limit) | view |
| PUT | `/reorder/:warehouse_id/:item_master_id` | Set reorder level | edit |
| PATCH | `/stock/:id` | Adjust qty / avg_rate / condition | edit |
| DELETE | `/stock/:id` | Zero out + delete balance row | delete |

### DB tables

- `warehouses` (`type` = `office` / `site_store`, `site_id`, `active`, `in_charge`, `location`)
- `stock_balance` (per warehouse × item: `quantity`, `avg_rate`, `reorder_level`, `condition`)
- `stock_movements` (IN/OUT journal with `reference_type`, `reference_id`, `from_warehouse_id`, `to_warehouse_id`, `site_id`, `item_condition`, `photo_url`)
- `item_master` (catalog: `item_code`, `item_name`, `uom`, `current_price`, …)
- `stock_issue_notes` (SI/YYYY/#### challan headers created by procurement allocation)
- `sites` (for site_store warehouses and issue destinations)

---

## 8.4 Tools

### Business purpose

A catalog of **returnable, company-owned tools** — drills, ladders, multimeters, safety gear — tracked separately from consumable inventory. Each tool is a unique item with serial, condition, calibration dates, and a current location (a site **or** a person). Distinct from Company Assets (8.2), which is IT/office equipment issued only to employees; Tools can be issued to **sites**.

### Who uses it

Site supervisors / stores staff with the `tools` permission. A weekly per-site **tool-count submission** feeds the Supervisor MIS KPI.

### Main screen / columns

`Tools.jsx` single-table page. Categories: **Drilling, Cutting, Measurement, Safety, Power, Hand, Lifting, Electrical, Other**. Statuses: **available, in_use, maintenance, lost, scrapped**. Stat cards include **Calibration Due (30 days)** and total value. Columns: **Code · Name · Category · Brand/Model · Serial · Cond. · Status · Current Site/User · Actions**. Filters: category, status, site_id, user_id, search (name/tool_code/serial/brand).

### Key fields (table `tools`)

`tool_code` (auto `T-YYYY-####`), `name`, `category`, `brand`, `model`, `serial_no`, `purchase_date`, `purchase_price`, `condition` (default `good`), `status` (default `available`), `current_site_id`, `current_user_id`, `last_calibration_date`, `next_calibration_date`, `photo_url`, `notes`.

### Movements

Issue/return/transfer/scrap/maintenance all log a `tool_movements` row (`action`, from/to site + user, `expected_return_date`, `actual_return_date`, `condition_at_action`, `notes`, `photo_url`).

1. **Issue** (`POST /:id/issue`) — body must give `to_site_id` **or** `to_user_id` (plus optional expected return date, condition, notes, photo). Sets status `in_use` and the new location. A re-issue to a different site/user is effectively a **transfer** (the `from_*` is the previous location).
2. **Return** (`POST /:id/return`) — clears location, sets `available`, stamps `actual_return_date`, optionally updates condition.
3. **Scrap** (`POST /:id/scrap`) — status `scrapped`, condition `scrap`.
4. **Maintenance** (`POST /:id/maintenance`) — status `maintenance`.

### Calibration

`next_calibration_date` drives the "Calibration Due (30 days)" stat (`next_calibration_date <= date('now','+30 days')`).

### Weekly submissions (Supervisor KPI)

`POST /submissions` upserts (on `site_id + submitted_by + week_start`) a `tools_list_submissions` row holding `tools_count` (summed from a `tools_json` array), an optional photo, and notes — powering a supervisor MIS metric. `GET /submissions/list` lists them filtered by week/site/submitter.

### API endpoints — `/api/tools`

| Method | Path | Purpose | Permission |
| --- | --- | --- | --- |
| GET | `/` | List (filters: category, status, site_id, user_id, search) | view |
| GET | `/stats` | Counts by status/category, calibration-due, value | view |
| GET | `/:id` | Tool + movement history | view |
| POST | `/` | Create tool | create |
| PUT | `/:id` | Edit | edit |
| DELETE | `/:id` | Delete tool + its movements | delete |
| POST | `/:id/issue` | Issue / transfer to site or user | edit |
| POST | `/:id/return` | Return | edit |
| POST | `/:id/scrap` | Scrap | edit |
| POST | `/:id/maintenance` | Mark for maintenance | edit |
| GET | `/submissions/list` | Weekly submissions list | view |
| POST | `/submissions` | Upsert weekly tool count | create |

### DB tables

- `tools` (catalog)
- `tool_movements` (issue/return/transfer/scrap/maintenance log)
- `tools_list_submissions` (weekly per-site count, unique on site_id+submitted_by+week_start)
- `sites`, `users` (current location targets)

---

## 8.5 Room Rentals

### Business purpose

Tracks **staff/labour accommodation** rented across project sites. Two layers exist in code:

1. A full **property → room → booking → payment** model (rented flats/houses, rooms within them, which employee stays where, and monthly rent paid to the landlord).
2. The **"Raise Rent" request workflow** (mam's primary flow) — a per-month rent request with approval and payment-release tracking. This is the workflow surfaced in the current UI.

### Who uses it

Site/admin staff raise rent requests; users with `rentals.approve` (and admins) approve/reject; finance marks them paid. Anyone with `rentals` permission can view.

### Main screen / tabs

`Rentals.jsx` (`useUrlTab('requests')`) currently exposes only **two** tabs in the UI:

- **Raise Rent** (`requests`) — the rent-request workflow with stat cards (Pending / Approved / Paid / Rejected / amounts).
- **Payments Log** (`payments`) — the property-level monthly rent payment ledger.

> The property/rooms/bookings management blocks and their backend endpoints still exist (legacy), but the **properties** and **bookings** tab buttons are no longer rendered in the current UI — the "Raise Rent" request flow superseded them.

### Raise Rent workflow (table `rent_requests`)

Status lifecycle: `pending → approved → paid` (or `rejected`); requests can also be flagged **inactive** (rental relationship ended / room vacated — no more rent expected, and "when we inactive not payment log").

**Key fields:** `request_no` (auto `RR-YYYY-####`), `site_id` / `site_name`, `arrange_for` (**`SEPL`** or **`Contractor`**), `contractor_name`, `employee_user_id` / `employee_name`, `owner_name` / `owner_phone` / `owner_aadhar_url`, `room_photo_url` + `photo_taken_at` + `photo_lat`/`photo_lng` (live proof), `payment_mode` (**`Bank`** / **`UPI`** / **`Scanner`** — only the relevant sub-fields `bank_account`+`ifsc_code` / `upi_id` / `scanner_url` are kept), `rent_month`, `rent_amount`, `pay_by_day` (default 10), `status`, `inactive`.

**Steps:**

1. **Raise** (`POST /rent-requests`) — requires `owner_name`, `rent_month`, `arrange_for`. Auto-numbers `RR-YYYY-####`, validates payment mode and clears non-relevant payment fields, then push-notifies approvers (admins + anyone with `rentals.approve`).
2. **Approve / Reject** (`POST /rent-requests/:id/approve` | `/reject`, `rentals.approve`) — reject requires a reason (min 5 chars). Both push-notify the creator.
3. **Mark paid** (`POST /rent-requests/:id/mark-paid`) — records `paid_via`, `transaction_ref`, `receipt_url`; sets `status='paid'`, stamps `paid_by`/`paid_at`; notifies the creator.
4. **Mark inactive / active** (`/mark-inactive` | `/mark-active`) — toggle the inactive flag.

`GET /rent-requests/stats` gives counts (pending/approved/paid/rejected/inactive) and amounts (total paid, pending amount).

### Properties / rooms / bookings / payments (model)

- **Properties** (`rental_properties`) — name, address, city/state/pincode, landlord contact, `monthly_rent`, `deposit_paid`, agreement start/end + file, bedrooms, capacity, amenities, `status` (`active`…), `site_id`. Dashboard stats: active properties, rooms (total/occupied/vacant), monthly burn, deposit locked, agreements expiring in 30 days, active bookings.
- **Rooms** (`rental_rooms`) — `room_name`, `capacity`, `status` (`available`/`occupied`), per property.
- **Bookings** (`rental_bookings`) — which `occupant_user_id`/`occupant_name` stays in which room, check-in/out dates, `rent_share`, `deposit_collected`, `status` (`active`/`completed`). Creating a booking marks the room **occupied** (transactional) and notifies the occupant; check-out marks it `completed` and frees the room if no other active bookings remain.
- **Payments** (`rental_payments`) — monthly rent to landlord, upserted on `property_id + period_month` (amount, paid date, mode, ref, receipt).

### API endpoints — `/api/rentals`

| Method | Path | Purpose | Permission |
| --- | --- | --- | --- |
| GET | `/stats` | Property/room/booking dashboard | view |
| GET | `/properties` `/properties/:id` | List / detail (rooms, bookings, payments) | view |
| POST/PUT/DELETE | `/properties[/:id]` | Manage properties | create/edit/delete |
| POST | `/properties/:property_id/rooms` | Add room | create |
| PUT/DELETE | `/rooms/:id` | Manage room | edit/delete |
| GET | `/bookings` | List bookings | view |
| POST/PUT/DELETE | `/bookings[/:id]` | Manage bookings | create/edit/delete |
| POST | `/bookings/:id/check-out` | Check out an occupant | edit |
| GET | `/payments` | Property monthly payment log | view |
| POST/DELETE | `/payments[/:id]` | Record / delete payment | create/delete |
| GET | `/rent-requests` `/rent-requests/stats` | Rent-request list / stats | view |
| POST/PUT/DELETE | `/rent-requests[/:id]` | Manage rent requests | create/edit/delete |
| POST | `/rent-requests/:id/approve` `/reject` | Approve / reject | approve |
| POST | `/rent-requests/:id/mark-paid` | Mark paid | edit |
| POST | `/rent-requests/:id/mark-inactive` `/mark-active` | Toggle inactive | edit |

### DB tables

- `rent_requests` — the "Raise Rent" workflow record (primary)
- `rental_properties`, `rental_rooms`, `rental_bookings`, `rental_payments` — the property model
- `sites`, `users` — site + occupant/employee references

---

## 8.6 Cross-module summary

| Concern | Tool Rentals | Company Assets | Inventory | Tools | Room Rentals |
| --- | --- | --- | --- | --- | --- |
| Direction | Rent **in** from vendor | Own (IT/office) | Own (consumable) | Own (returnable) | Rent **in** (housing) |
| Assigned to | Site (via vendor) | Employee | Warehouse / Site | Site **or** Person | Employee / Contractor |
| Movement log | `rental_tool_history` | `company_asset_movements` | `stock_movements` | `tool_movements` | booking + payment rows |
| Auto-numbering | `RT-YYYY-####` | `AST-YYYY-####` | — | `T-YYYY-####` | `RR-YYYY-####` |
| Approval gate | Ajmer (Stage 2 & 4) | — | — | — | `rentals.approve` (rent requests) |
| Auto PO | Yes (Stage 2) | No | Feeds vendor PO via store allocation | No | No |
| Valuation | rate × days | purchase_price (no depreciation) | moving weighted avg | purchase_price | rent_amount / monthly_rent |

Key integration: **Inventory office free-stock is consumed by the Procurement indent-approval flow** — the approver sees per-line office/site stock, can allocate "from store" (splitting the indent line into a store child + procure parent), and the system journals `ISSUE` OUT movements plus a printable `SI/YYYY/####` stock-issue note, reducing the quantity sent to the vendor PO.
