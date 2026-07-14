# SEPL ERP — Sales Billing Module (4-Type Sequential) — Design v1

Status: **DRAFT for mam's approval.** No code beyond the menu rename until this is signed off.

## 1. Goal
Generate client sales bills in **4 sequential stages** that follow the real workflow, ending in a Final bill against which payment is received. Reuse what's already in the ERP; **amounts are typed manually on each bill**; the **order is picked from Business Book** (customer + items auto-fill as reference).

## 2. Decisions locked (mam, 2026-06-13)
- Build after this **design doc is approved** (not code-first).
- Type 1 is created from an **existing Business Book order** (auto-fills customer, items, ordered qty, rate).
- **Amounts are entered manually** on each bill (the order figures are shown only as reference).
- **GST = one rate per bill** (single % applied to the typed amount).
- **Type 4 final total = auto-sum of Types 1+2+3 + the commissioning charge** (shown, editable).
- **Approval = Admin + Accounts** (anyone with accounts/payroll edit, or admin), single-step Draft → Approved.
- **Bill numbering = `SEPL/SB/26-27/001`** (company format, financial-year aware).
- **Creating bills** = same as approving (Admin + Accounts).
- **Retention / discount** = not auto-applied for now; the bill uses the amount you type. (Can add milestone retention later if needed.)

## 3. The 4 bill types

| # | Name | Trigger | Auto-filled (reference) | You type | Status set |
|---|------|---------|-------------------------|----------|------------|
| 1 | Sales Order Bill | Order booked | Customer, items, ordered qty, rate (from Business Book) | Bill amount, GST, bill date | ORDER BOOKED |
| 2 | Material Delivery Bill | Material delivered | Type-1 items + the delivery note/challan | Delivered qty, amount (≤ Type 1), GST | MATERIAL DELIVERED |
| 3 | Installation Bill | DPR approved (`billing_ready`) | The approved DPR ref | Installation charges, GST | INSTALLATION COMPLETE |
| 4 | Final / Commissioning Bill | Testing & commissioning signed off | Testing/handover ref | Commissioning charges, GST, final total | READY FOR PAYMENT |

**Sequence rule:** Type 2 needs Type 1, Type 3 needs Type 2, Type 4 needs Type 3. All four share one chain (linked by `previous_bill_id`) and one Business Book order. **Payment is recorded only against Type 4.**

## 4. Data model (new tables)

**sales_bills** (master — one row per bill)
```
id, bill_number (unique), bill_type (1-4),
business_book_id, customer_name (snapshot), customer_gstin (snapshot),
bill_date, amount_without_gst, gst_rate, gst_amount, total_amount,
status (ORDER BOOKED / MATERIAL DELIVERED / INSTALLATION COMPLETE / READY FOR PAYMENT),
previous_bill_id (links the chain),
reference_doc_type (SO/DC/DPR/Commissioning), reference_doc_no, reference_id,
approval_status (draft/approved), payment_status (pending/partial/paid),
created_by, created_at
```

**sales_bill_items** (line items)
```
id, sales_bill_id, description, qty_ordered, qty_delivered, unit, rate, amount
```

**sales_bill_status_log** (audit trail)
```
id, sales_bill_id, status, changed_by, changed_at, notes
```

**Reused, not duplicated:** `business_book` + `po_items` (order/items), `delivery_notes` (Type 2 ref), `dpr` + `billing_ready` (Type 3 ref), `testing_commissioning` + `handover_certificates` (Type 4 ref), `receivables` + `payments` (money).

## 5. Numbering
**`SEPL/SB/26-27/001`** — company format, financial-year aware (26-27 = FY Apr 2026–Mar 2027), sequence resets per FY, zero-padded to 3.

## 6. Validation rules
- Can't create Type N without Type N-1 existing for the same order.
- Type 2 total should be **≤ Type 1** (warn, don't hard-block — partial deliveries).
- Payment entry only enabled on Type 4.
- A bill can't be deleted if a later-type bill in its chain exists.

## 7. Payment linkage
When **Type 4** is approved → auto-create a `receivables` row (invoice = Type 4 total). Payments are entered against it (`payments` table, `reference_type='sales_bill'`). Your existing receivables ageing / follow-up screen then tracks it. No new payment screen needed.

## 8. Screen (Sales Billing page — replaces the installation tracker)
- **Bill list**: number, type, customer, amount, status, date + filters (type / status / customer).
- **New Bill** → pick a Business Book order → system offers the next allowed type in that order's chain → form (reference auto-filled, you type amounts).
- **Order chain view**: for one order, see Type 1→4 as a progress strip, with each bill's status and amount.

## 9. OPEN QUESTIONS — RESOLVED (see §2)
1. Numbering → `SEPL/SB/26-27/001`. ✓
2. Approver → Admin + Accounts, single step. ✓
3. GST → one rate per bill. ✓
4. Retention / discount → not auto-applied; typed amount only (revisit later). ✓
5. Type 4 final total → auto-sum 1-3 + commissioning, editable. ✓
6. Who can create → Admin + Accounts. ✓

All inputs received — design is ready to lock on mam's go-ahead.

## 10. Build phases (after approval)
- **Phase 0**: schema + numbering.
- **Phase 1**: Type 1 Sales Order Bill (list + create from Business Book order).
- **Phase 2**: Type 2 Material Delivery Bill.
- **Phase 3**: Type 3 Installation Bill (from DPR).
- **Phase 4**: Type 4 Final Bill + receivables/payment link.

Each phase is deployed for your review before the next.
