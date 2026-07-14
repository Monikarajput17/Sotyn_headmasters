# Indent → Dispatch — Automation Plan & Changes

_Scope: the Procurement "Indent to Dispatch" module only (ederp.in/procurement)._
_Prepared 2026-06-09. Goal: raise automation from ~45% to ~80%; humans stay only on physical receipts and value approvals._

---

## 1. The 18 steps — what is Built / Partial / Missing

| Step | What it should do | Status today |
|---|---|---|
| S1 | Auto-create indents when stock is low (reorder) | ❌ Missing — only the manual "Raise Indent" button |
| S2 | Check free stock + allocate, send only the shortfall to buy | ✅ Already built (option B) — approval screen shows "N avail" office stock + one-tap allocate + To-Procure split |
| S3/S4 | L1 / L2 / CRM one-click approvals | ✅ Built — only auto-escalation (idle reminder) is missing |
| S5 | Auto-send RFQ to mapped vendors | ❌ Missing — quotes entered by hand |
| S6 | Rank vendors by rate, flag the lowest | 🟡 Partial — shown side by side, no auto-pick |
| S7 | Auto-make PO + email PDF to vendor | 🟡 Partial — PO auto-made; email NOT sent |
| S8 | SMS/WhatsApp dispatch alert to transporter | ❌ Missing |
| S9 | Bill + MTC upload, with OCR to pre-fill | 🟡 Partial — upload works; no OCR |
| S10 | Item-wise variance, auto-book matched bills | 🟡 Partial — variance shown; no auto-book |
| S11 | Debit/credit note from shortfall | ✅ Built (debit) — only credit-note type missing |
| S12 | Auto delivery challan on dispatch | ✅ Already built (DC/####) |
| S13 | Auto RA bill from challan | ❌ Missing — needs your definition of "RA bill" |
| S14 | Auto sales bill | ✅ Already built (INV/#### on receive) |
| S15 | GRN stamp/sign + photo upload | ✅ Built |
| S16 | Auto-reconcile received vs PO + alert engineer on mismatch | 🟡 → now improved (see section 3) |
| S17 | Client payment reminders + DSO widget | 🟡 Partial — DSO dashboard exists; no client reminders |
| S18 | Auto-pay below a threshold | ❌ Missing (kept as manual — no payment gateway) |

> **Important correction:** Steps **S12 and S14 are already built** — we will REUSE them, not rebuild.
> **Note on S2:** stock IS deducted at *approval* today (store-issue + RGP). S2 only adds an *automatic check at submit* on top of that — we will not rebuild the existing part.

---

## 2. What is already built (we will NOT touch)
- The full tab flow: Raise Indent · Vendor Rates · Vendor PO · Payment · Purchase Bills · Dispatch & Receiving · Debit Notes · PO Pipeline · Export Excel.
- L1/L2/CRM approvals, PO auto-numbering (VPO/####), delivery challan (DC/####), sales bill (INV/####), GRN with receipt photo, auto short-supply debit notes.

---

## 3. What I have CHANGED so far — only ONE thing (S16)
**Alert the site engineer when material is received short.**
- When you mark a delivery **Received** and the quantity is **short**, the system already raises a short-supply debit note. **Now it also alerts the site engineer** (the person who raised the indent).
- Sent by **WhatsApp + SMS + email**, automatically.
- Fires **only on a mismatch** — a correct receipt sends nothing (no spam).
- It is invisible on screen — it works inside "Mark Received". That's why the tabs look the same.
- Safe: never blocks the receipt; skips quietly if Twilio/email isn't configured.
- **Needs from you:** Twilio credentials on the server for SMS/WhatsApp to actually send.

---

## 4. Build order agreed (P1 first)
**P1 status:**
- **S2** — ✅ already built (option B: approval screen shows free office stock + one-tap allocate; approver decides). Reused, not rebuilt.
- **S16** — ✅ done (engineer alert on mismatch). Ready to deploy.
- **S12 / S14** — ✅ reuse (already built).
- **S13** — on hold until you define what an "RA bill" is.
- → P1 is essentially complete. Next: P2 quick wins using your Email + Twilio (S7 PO email, S8 transporter alert, S5 auto-RFQ).

**P2 — finish the automation (later):** S1 reorder job, S5 auto-RFQ, S6 auto-rank lowest, S7 PO email, S8 transporter alert, S10 auto-book, S11 credit note, S17 client reminders, S18 (kept manual).

**P3 — verify / light touches:** S3/S4 add idle auto-escalation, S9 add OCR (using your existing Claude AI), S15 add mobile photo.

---

## 5. Integrations you are providing
- ✅ **Email (SMTP)** — drives RFQ, PO email, reminders, mismatch alerts.
- ✅ **Twilio (SMS/WhatsApp)** — drives transporter + engineer alerts.
- ✅ **Claude AI** — will be used for OCR (reading uploaded bills).
- ❌ **Payment gateway** — not provided, so **S18 auto-pay stays manual** (human release).

---

## 6. S2 decision — RESOLVED
You chose **(B) Only suggest** — and that is exactly what already exists on the approval screen ("N avail" + one-tap allocate; approver decides). So S2 is **done / reused**, nothing to build.
