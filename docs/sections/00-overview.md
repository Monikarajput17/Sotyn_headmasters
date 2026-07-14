# SEPL ERP — Complete System Documentation

**Secured Engineers Pvt. Ltd. (SEPL) — Enterprise Resource Planning System**

| | |
|---|---|
| **Product** | SEPL ERP (internal name: `business-erp`) |
| **Owner** | Secured Engineers Pvt. Ltd. |
| **Document type** | Complete reference — User Manual + Management Overview + Technical Reference |
| **Scope** | All modules, all screens, all automations |
| **Platform** | Web application (browser) + installable PWA (phone / laptop / desktop) |
| **Technology** | React + Vite front-end · Node.js / Express API · SQLite (better-sqlite3) database |

---

## How to read this document

This manual is written for **three audiences at once**, so each module is described
from three angles:

1. **End users** (CRM staff, accountants, site engineers, HR, store keepers) — *what
   the screen does and the step-by-step way to use it.*
2. **Management / MD** (for demos and review) — *what the module is for, the workflow
   it enforces, and the value it delivers.*
3. **Developers / administrators** — *the API endpoints, database tables, automations
   and formulas behind each screen.*

You can read it front-to-back, or jump straight to the module you need using the
**Table of Contents**. Every chapter is self-contained.

- **Sections 1–11** follow the application's own left-hand menu, group by group.
- **Section 12** documents every background automation, scheduled job and outside
  integration (email, WhatsApp, push, AI).
- **Section 13** is the technical reference (architecture, data model, deployment).

---

## About the SEPL ERP

The SEPL ERP is a **single, integrated business system** that runs the whole company —
from the first sales enquiry to the final payment collected, and everything in
between: buying material, executing projects on site, paying staff and vendors,
tracking tools and stock, and giving management a live picture of the business.

It replaces a scattered set of spreadsheets and WhatsApp messages with **one source
of truth**, shared by every department, with role-based access so each person sees
only what they should.

The system is purpose-built for SEPL's line of work — **fire-fighting, MEP and
allied engineering contracts** — so it understands the things a generic ERP does
not: BOQs (Bills of Quantity), SITC (Supply, Installation, Testing & Commissioning)
line items, Fire NOC renewals, site DPRs (Daily Progress Reports), labour-rate
costing, and milestone-based client billing.

### The business in one line

> **Lead → Quotation → Order (Business Book) → Procurement (Indent → Dispatch) →
> Project Execution (DPR) → Sales Billing → Collections**

Around that core sales-to-cash spine sit the supporting functions: **HR & Payroll,
Finance, Inventory & Assets, Tasks, Service Desk,** and **Executive Dashboards**.

---

## End-to-end business flow

The modules are not islands — data flows from one to the next automatically. The
typical journey of a job through the ERP:

| Stage | Module(s) | What happens |
|---|---|---|
| 1. **Find the work** | CRM → Partners, CRM Sales Funnel, Sales Funnel (Leads) | A referral partner or enquiry creates a lead; it is qualified through a staged pipeline. |
| 2. **Price the work** | Quotes & Orders → Quotations / AI Auto-Quotation | A BOQ is priced (material + labour + margin) into a client quotation. |
| 3. **Win & book the order** | CRM → Business Book | The won order is recorded with client, PO, value, GST and project details. It becomes the anchor every later module links to. |
| 4. **Plan & buy material** | Procurement → Items, RFQ Queue, Vendors, **Indent → Dispatch**, Schedule | Indents are raised, approved (L1/L2/CRM), quoted by vendors, turned into POs, received, and dispatched to site. |
| 5. **Execute on site** | Projects → DPR, Snags, Indent Labour Payment, Fire NOC | Daily progress, manpower, labour cost and quality snags are tracked against the project. |
| 6. **Bill the client** | Projects → Sales Billing · Finance → Invoices | Sequential bills (Order → Material → Installation → Final) are raised with correct GST. |
| 7. **Collect the money** | Finance → Collections, Cash Flow | Receivables are aged and chased; cash position and runway are tracked. |
| 8. **Pay vendors & staff** | Finance → Payables, Cheques · HRMS → Payroll | Vendor payments run through a multi-level approval; staff are paid via attendance-driven payroll. |
| Throughout | HRMS, Inventory, Tasks, Service Desk, Dashboards, Admin | Hiring, attendance, tools/stock, delegated tasks, complaints and the executive view run continuously. |

---

## Complete module map

The application's left sidebar organises **all modules into ten groups plus a
Settings group**. This is the same structure used by the chapters that follow.

| Group | Modules (menu items) | Documented in |
|---|---|---|
| **(top)** | Dashboard (home) | §10 |
| **CRM** | Partners · CRM Sales Funnel · Sales Funnel · Business Book · Customers · Full Kitting | §2 |
| **Quotes & Orders** | Quotations · AI Auto-Quotation · PO/FOC Stripped · Labour Rate | §3 |
| **Procurement** | Items · RFQ Queue · Vendors · Indent to Dispatch · Order to Planning · Schedule (Gantt) | §4 |
| **Projects** | Indent Labour Payment · Daily Reports (DPR) · Snags · Fire NOC Renewal · Sales Billing | §5 |
| **Finance** | Cheques · Payables · Collections · Invoices · Cash Flow · Expenses | §6 |
| **HRMS** | Hiring · Sub-contractor Hiring · Onboarding · Training · Attendance · Payroll · Employees · Performance · Sub-contractor Master | §7 |
| **Inventory** | Tool Rentals · Assets · Inventory · Tools · Room Rentals | §8 |
| **Tasks** | Delegations · PMS Tasks · Checklists | §9 |
| **Service Desk** | Complaints · Help Tickets | §9 |
| **Executive** *(admin)* | War Room · Operating Console · TOC View | §10 |
| **Admin / Settings** *(admin)* | Activity Log · Location · Backups · AI · Email · Email Triggers · Users · Roles & Permissions · Audit Log | §11 |

> **Visibility rule:** a module is hidden from a user until their role is granted
> permission to it (admin sees everything). A handful of items are open to all staff
> (Help Tickets, Onboarding, Training, RFQ Queue). See §1 for the permission model.

---

## Who uses what (typical roles)

| Role | Primary modules |
|---|---|
| **CRM / Sales** | Partners, Sales Funnel, CRM Sales Funnel, Business Book, Quotations, Collections |
| **Estimation** | AI Auto-Quotation, Labour Rate, PO/FOC Stripped, Item Master |
| **Procurement / Stores** | Indent to Dispatch, RFQ Queue, Vendors, Items, Inventory, Tools, Schedule |
| **Site Engineer** | DPR, Snags, Indent Labour Payment, Attendance, Full Kitting |
| **Accounts / Finance** | Payables, Cheques, Collections, Invoices, Cash Flow, Expenses |
| **HR** | Hiring, Sub-contractor Hiring, Onboarding, Training, Attendance, Payroll, Employees, Performance |
| **Management / MD** | Executive dashboards, all approvals (L3 / release), Audit Log |
| **Administrator** | Users, Roles & Permissions, Backups, AI, Email, Locations |

---

## Key system-wide concepts

A few ideas appear across many modules — understanding them once makes the rest of
the manual easier:

- **Business Book order = the anchor.** Almost every downstream document (PO, DPR
  site, sales bill, receivable, cash-flow entry) links back to a Business Book order.
- **Multi-level approvals.** Money-out flows (vendor payments, indents) pass through
  named approval levels — e.g. **L1 Accountant → L2 Nitin Jain → L3 MD (Ankur
  Kaplesh) → Release (Aanchal)** for Payables.
- **GST is computed, not typed.** Local/Punjab clients get **CGST + SGST**; others
  get **IGST** — the split is derived from the client's state, with the state code
  auto-filled.
- **Everything is audited.** Every create/update/delete is written to an audit log
  with the user, time and change (see §11).
- **Automations run in the background.** Nightly backups, daily DPR prompts, the
  09:00 CMD email, fortnightly installation billing, Fire NOC auto-advance, and more
  run on schedule without anyone clicking a button (see §12).
- **Works on phones.** The ERP installs as a PWA; site staff punch attendance and
  the app pings GPS every 30 seconds for geofenced attendance and location tracking.

---

*The chapters that follow document each module in full. Section numbers match the
Table of Contents.*
