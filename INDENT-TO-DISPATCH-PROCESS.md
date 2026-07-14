# Indent → Dispatch — Full Process (read & check)

_How the flow works today, stage by stage: **where** you act, **what you do**, **what the system does automatically**, and **what it changes**. Mark anything that doesn't match your real process with ✏️._

**Document numbers you'll see:** Indent `IND-…` · Stock Issue Note `SI/…` · Delivery Challan `DC/YYYY/####` · RGP gate pass `RGP/YYYY/####` · Vendor PO `VPO/YYYY/####` · Debit Note `DBN/YYYY/####` · Sales Bill (client invoice) `INV/YYYY/####`.

Legend: 👤 = you/staff act · 🤖 = automatic · 📦 = what it changes · ✅ built · 🟡 partial · ❌ missing

---

## Stage 1 — Raise Indent  (Tab: **Raise Indent**)
- 👤 You pick a site/planning, select BOQ items + quantity, choose category (Material / RGP / Extra-Schedule / Extra-Non-Schedule / Rental), and submit.
- 🤖 An indent number `IND-…` is created; status = **Submitted**; an email "indent raised" goes out; it's routed for approval by policy (single / L1+L2 / CRM+L1+L2 for extra items).
- 📦 Creates the indent + its item lines. Quantities are checked against the BOQ cap.
- Status: ✅ Built. (Auto-create from low stock = ❌ not built — S1, future.)
- ✏️ Check: are the categories and the BOQ qty-cap correct for your work?

## Stage 2 — Approval: L1 → L2 (and CRM first for extra items)  (Tab: **Raise Indent** → open the indent)
- 👤 The L1 approver clicks **Approve L1**, then the L2 approver clicks **Approve L2**. For Extra-Schedule / Extra-Non-Schedule, **CRM approves first**. The same person can't do both L1 and L2.
- 👤 At approval you can **adjust quantity** per line and **allocate "From Store"** — each item shows **"📦 N available"** office stock with a one-tap "use" button; the rest shows as **"To Procure"**.
- 🤖 Status moves Submitted → L1-approved → **Approved**. Approval emails fire.
- 🤖 **If you take stock from store:** a **Stock Issue Note `SI/…`** + a **store Delivery Challan `DC/…`** are created and **office stock is reduced**. **RGP** items get an auto **gate-pass challan `RGP/…`** and stock is reduced too. **Billable extra** items create a billing line + update the CRM funnel.
- 📦 Indent approved; stock deducted for store/RGP; challans created; only the **shortfall** continues to purchasing.
- Status: ✅ Built — **this is the "free stock check + allocate" (S2)**: it shows availability, you decide.
- ✏️ Check: is the **From Store / To Procure** split working the way you want? Idle-approval auto-reminder (S3/S4 escalation) is ❌ not built yet.

## Stage 3 — Vendor Rates & Finalise  (Tab: **Vendor Rates**)
- 👤 Purchase team picks an approved indent and enters up to **3 vendor quotes** (name, rate, terms = Advance/Credit, credit days) per item, then **Finalises** the chosen vendor + rate.
- 🤖 Stores the quotes and the finalised rate (used later for the PO).
- 📦 Each item gets a final vendor + rate.
- Status: 🟡 Partial. ❌ Auto-send RFQ to vendors (S5) and ❌ auto-flag the lowest (S6) are **not built** — quotes are typed in and the winner is chosen by hand.
- ✏️ Check: do you want the system to **email RFQs automatically** and **highlight the cheapest** vendor?

## Stage 4 — Create Vendor PO  (Tab: **Vendor PO**)
- 👤 You pick the indent + finalised items, (optionally) attach the signed PO, and click **Create Vendor PO**.
- 🤖 A PO number `VPO/YYYY/####` is created, total is computed from the finalised rates; indent status → **PO Sent**. You can print the PO to PDF.
- 📦 Creates the vendor PO + its lines.
- Status: 🟡 Partial. ❌ **Auto-email the PO PDF to the vendor (S7) is not built** — today you print/send it yourself.
- ✏️ Check: want the PO to **auto-email to the vendor** on creation? (Next planned build.)

## Stage 5 — Vendor Payment / Advance  (Tab: **Payment**)
- 👤 For advance-required POs, a payment request goes through approvals (HR → Accounts → Billing Engineer → Release).
- 🤖 Tracks each approval step; amounts can be adjusted.
- 📦 Records the payment request + approvals.
- Status: 🟡 Built as a **manual** approval chain. ❌ Auto-pay below a threshold (S18) is **not built** (no payment gateway) — kept manual on purpose.
- ✏️ Check: are the payment approval steps right for each category?

## Stage 6 — Purchase Bill + MTC  (Tab: **Purchase Bills**)
- 👤 When material arrives, you upload the vendor's **bill (PDF/photo)** + enter bill no / date / amount / GST, and mark material **Approved / Reject**.
- 🤖 If no challan exists yet it makes a placeholder one. **If received short, it auto-raises a short-supply debit note and emails the vendor.**
- 📦 Records the bill; shows an item-wise variance (ordered vs received).
- Status: 🟡 Partial. ❌ **OCR to auto-fill the bill (S9)** and ❌ **auto-book matched bills (S10)** are not built — fields are typed in.
- ✏️ Check: want the system to **read the bill image** (OCR via your AI) and pre-fill the numbers?

## Stage 7 — Dispatch & Receiving  (Tab: **Dispatch & Receiving**)
**7a. Dispatch to site**
- 👤 Create a **Delivery Challan `DC/…`** with vehicle / driver / LR details.
- Status: ✅ Challan auto-numbers (S12). ❌ **SMS/WhatsApp to the transporter (S8) is not built.**
- ✏️ Check: want the **driver/transporter to get an auto WhatsApp/SMS** on dispatch?

**7b. Receive (GRN)**
- 👤 Click **Mark Received** with the **receiver's name + a photo of the stamped GRN**, and the **received quantity per line**.
- 🤖 Saves the receipt photo; **adds the received qty into store stock**; **if short, auto-raises a debit note**; **auto-creates the client Sales Bill `INV/…`** for billable items; **and NOW alerts the site engineer (WhatsApp+SMS+email) ONLY when there's a shortfall** _(this is the new S16 change — pending deploy)_.
- 📦 Stock goes up by received qty; debit note on shortfall; sales bill created; engineer alerted on mismatch only.
- Status: ✅ GRN photo (S15), ✅ reconcile + auto-debit, ✅ engineer alert (S16, new). ❌ Mobile signature pad (future).
- ✏️ Check: is the **received-short → debit + engineer alert** behaviour correct? Who exactly should the alert go to — only the indent raiser, or also a manager?

## Stage 8 — Debit / Credit Notes  (Tab: **Debit Notes**)
- 👤 Review the auto-raised short-supply debits, or create one by hand (rejected / extra-rate / short-supply); then settle.
- 🤖 Numbers each as `DBN/…`; can email the vendor.
- 📦 Records the debit against the PO/vendor.
- Status: ✅ Debit notes built (auto + manual). ❌ A **credit note** type (S11) is not built.
- ✏️ Check: do you ever need a **credit note** (e.g. you owe the vendor back)?

## Stage 9 — Client Sales Bill & Collections  (auto on receive; **Collections** for follow-up)
- 🤖 The Sales Bill `INV/…` is generated automatically when goods are received (from BOQ selling rates); flagged **draft** if client GSTIN or rates are missing.
- 👤 You complete/print the invoice; the **DSO dashboard** shows outstanding amounts and ageing per site.
- 📦 Creates the client invoice; feeds receivables/ageing.
- Status: ✅ Sales bill auto (S14), ✅ DSO dashboard. ❌ **Auto payment-reminder emails to clients (S17) not built.**
- ✏️ Check: want **automatic payment-reminder emails** to clients on overdue invoices?

## Stage 10 — PO Pipeline (overview)  (Tab: **PO Pipeline**)
- 👤 A single tracking view of all POs across their stages.
- Status: ✅ Built (read-only overview).

---

## Quick "where might I need a change?" checklist
- [ ] Stage 2: From-Store / To-Procure split correct? Want idle-approval reminders?
- [ ] Stage 3: Auto-email RFQs + auto-highlight cheapest vendor?
- [ ] Stage 4: Auto-email PO to vendor? **(next build — S7)**
- [ ] Stage 6: OCR to read the bill and pre-fill?
- [ ] Stage 7a: Auto WhatsApp/SMS to transporter on dispatch?
- [ ] Stage 7b: Engineer mismatch alert — right person? (deploy pending + Twilio creds)
- [ ] Stage 8: Need credit notes too?
- [ ] Stage 9: Auto payment reminders to clients?

_What's changed by me so far in this module: **only Stage 7b** — the engineer mismatch alert (S16). Everything else above is existing behaviour._
