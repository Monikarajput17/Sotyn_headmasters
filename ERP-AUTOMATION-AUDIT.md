# ERP Audit — manual fields → dropdown / automatic (2026-06-15)

Goal (mam): go field-by-field across the ERP and find what is typed by hand today
but could be a **dropdown** (pick from existing master data) or **automatic**
(computed/looked-up). Below, grouped by pattern (biggest wins first).

Legend — Effort: S = small, M = medium, L = large.

---

## PATTERN 1 — Auto-calculate tax (GST % + State Code)  ★ highest impact
A wrong manual entry here = a wrong tax invoice.

| Where | Field | Now | Fix |
|---|---|---|---|
| Procurement → Sales Bill | CGST / SGST / IGST % | typed | AUTO: Punjab client → 9+9, else IGST 18. Rule already written in code. (S) |
| Procurement → Sales Bill | State Code | typed "03" | AUTO from State (state→GST-code map). (S) |
| Business Book | State Code | typed | AUTO from the State dropdown. (S) |
| Procurement → Place of Supply | client state | typed | DROPDOWN of states / auto from client. (S) |

## PATTERN 2 — Pick the CLIENT from the customer master, auto-fill the rest  ★
Client name, company, contact, email, GSTIN, billing/shipping address are retyped
in 3 places. A `customers` master already exists.

| Where | Fields | Fix |
|---|---|---|
| Business Book | Client/Company/Contact/Email/GSTIN/Address | DROPDOWN pick customer → AUTO-fill all + code. (L) |
| CRM Funnel (Add Lead) | Company/Mobile/Email/State | DROPDOWN pick customer → auto-fill. (M) |
| Leads | client identity fields | reuse same customer picker. (M) |

## PATTERN 3 — Pick the VENDOR from the vendor master (not typed)
Same vendor list (`/procurement/vendors`) should feed every vendor field.

| Where | Field | Effort |
|---|---|---|
| Payment Required | Vendor Name (Purchase) | S |
| Payment Required | Driver / Vendor (Transport) | S |
| Cheque FMS | Payee To | M (combobox) |
| Company Assets | Vendor | S |
| Rental Tools | Vendor Rate default | M |

## PATTERN 4 — Pick the PERSON from employees/users (not typed)
Every "who" field should pick from the staff list (stores the ID, shows the name).

| Where | Field | Effort |
|---|---|---|
| DPR (Site) | Supervisor | S |
| Employees / HR System | Reporting To / Manager | S |
| Payment Required | Site Engineer | S |
| Complaints | Assigned To (Step 1 & 2), EMP who received | S |
| Leads | SC / Meeting Scheduled By | S |
| Collections / Cash Flow | CRM Name | S |
| HR System | Interviewers (multi-pick) | M |
| Orders | CRM (hardcoded 2 names → role-based list) | M |

## PATTERN 5 — Auto-fill item details from Item Master on pick
Unit, Make, HSN, GST already live in `item_master` but are retyped per line.

| Where | Field | Fix |
|---|---|---|
| Procurement (Indent) | Unit / Make | AUTO from picked item's uom/make. (S) |
| Procurement (Sales Bill / DN line) | HSN / Unit | AUTO from item_master. (S–M) |
| Item Master | GST | DROPDOWN of slabs {0,5,12,18,28}%. (S) |
| Item Master | Make | DROPDOWN from vendor `makes`. (M) |

## PATTERN 6 — Auto-compute numbers (stop hand-keying)
| Where | Field | Formula |
|---|---|---|
| Billing | RA/MB/Installation **Bill Number** | auto-sequence (collision risk today). (M) |
| Billing | GST amount | = amount × GST% (use a % dropdown). (S) |
| Attendance (Apply Leave) | Days | = to − from + 1. (S) |
| Attendance (Apply Leave) | Hours | = to_time − from_time. (S) |
| Payroll (Settings) | Misc Allowance % | = 100 − (basic+conv+HRA+adhoc). (S) |
| Vendors (Rate Compare) | Final Rate | = selected vendor's rate / lowest. (S) |
| Orders (PO) | Total Amount | read-only = BB / line sum. (S) |
| Quotations | Total Amount | from selected BOQ reference. (S) |
| Rental Tools | PO Number | server auto-sequence. (M) |

## PATTERN 7 — Fixed-list dropdowns (typo-proofing)
| Where | Field | List |
|---|---|---|
| Multiple (Quotations, Price Required, Procurement) | UOM | nos/mtr/kg/sqm/rft/set/lot… (unify) |
| Employees | Department / Designation | distinct existing values + free fallback |
| Business Book | Customer Type / Client Type | fixed lists |
| Billing | Test Type | Insulation/Earthing/HV/Continuity/Functional |
| Sub-Contractors | Rate vs Budget | In/Above/Below budget |
| Tools / Company Assets | Brand | distinct existing brands (datalist) |

---

## Suggested order (quick wins first)
1. **Tax auto-calc** (Pattern 1) — biggest correctness win, all Small.
2. **Vendor picker** everywhere (Pattern 3) — all Small, one shared component.
3. **Person picker** everywhere (Pattern 4) — all Small, one shared component.
4. **Item Master auto-fill** (Pattern 5) — kills repetitive typing.
5. **Auto-compute numbers** (Pattern 6) — esp. Billing bill-number + GST.
6. **Customer master reuse** (Pattern 2) — highest value but largest effort.
7. **Fixed-list dropdowns** (Pattern 7) — cheap polish.

Already done well (skipped): LabourRate UOM/Category, Inventory warehouse/site
selects, Procurement vendor SearchableSelects, Purchase-Bill auto Total,
"Received By" datalist, SalesBilling GST%, Payroll computed slip lines,
DPR contractor/work-order pickers, most status/category/state selects.
