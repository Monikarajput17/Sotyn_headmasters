# SEPL ERP — Complete Guide (User + Technical)

**Secured Engineers Pvt. Ltd. — Enterprise Resource Planning system**
Built by **SOTYN.AI** · Live at **securederp.in**

This is the master guide. It covers (1) the technology and languages the ERP is built with, (2) how it is put together, and (3) step-by-step instructions for every module.

---

## Table of Contents

1. [What this ERP is](#1-what-this-erp-is)
2. [Technology & Languages Used](#2-technology--languages-used)
3. [Architecture (how it fits together)](#3-architecture)
4. [Getting Started — login & roles](#4-getting-started)
5. [Navigation & common controls](#5-navigation--common-controls)
6. [Sales & CRM](#6-sales--crm)
7. [Procurement (Indent → Dispatch)](#7-procurement)
8. [Client Purchase Orders & Planning](#8-client-purchase-orders--planning)
9. [Projects & Site Execution](#9-projects--site-execution)
10. [Finance](#10-finance)
11. [HRMS (People)](#11-hrms)
12. [Inventory](#12-inventory)
13. [Tasks & Service Desk](#13-tasks--service-desk)
14. [WhatsApp — internal chat & calls](#14-whatsapp)
15. [Executive Dashboards](#15-executive-dashboards)
16. [Admin & Settings](#16-admin--settings)
17. [Cross-cutting concepts](#17-cross-cutting-concepts)
18. [Deployment & Operations](#18-deployment--operations)

---

## 1. What this ERP is

A single web application that runs the whole business end-to-end: sales enquiries → quotations → client purchase orders → material indents → vendor rates & POs → dispatch → site execution (DPR, labour) → billing → collections → finance, plus HR/payroll, inventory, tasks, an internal WhatsApp-style chat with voice/video calls, an AI assistant that reads your data, dashboards, and full role-based permissions.

Everything is **visible end-to-end**: every site, every order, every rupee.

---

## 2. Technology & Languages Used

**Programming language:** JavaScript (Node.js on the server, React in the browser). No TypeScript — plain modern JavaScript (ES modules/JSX on the client, CommonJS on the server).

### Frontend (what runs in the browser)
| Area | Technology |
|---|---|
| Language | JavaScript (JSX) |
| UI framework | **React 18** |
| Build tool / dev server | **Vite** |
| Styling | **Tailwind CSS** (+ @tailwindcss/forms, PostCSS, Autoprefixer) |
| Routing | **react-router-dom** |
| HTTP calls | **axios** |
| Charts | **Recharts** |
| Icons | **react-icons** |
| Toasts/alerts | **react-hot-toast** |
| Real-time | **socket.io-client** |
| Maps | **Leaflet** (location features) |
| QR scanning | **html5-qrcode** |
| Error monitoring | **@sentry/react** |
| Calls | **WebRTC** (browser-native, for voice/video) |

### Backend (what runs on the server)
| Area | Technology |
|---|---|
| Language | JavaScript (Node.js) |
| Web framework | **Express** |
| Database | **SQLite** via **better-sqlite3** (file: `data/erp.db`; chat in a separate `data/chat.db`) |
| Auth | **JSON Web Tokens (jsonwebtoken)** + **bcryptjs** password hashing |
| Real-time | **Socket.IO** (chat + call signalling) |
| File uploads | **multer** |
| Excel / BOQ parsing | **xlsx (SheetJS)** |
| Word / PDF reading | **mammoth**, **pdf-parse** |
| Email | **nodemailer** |
| SMS / WhatsApp gateway | **twilio** |
| Web push notifications | **web-push** |
| AI assistant | **@anthropic-ai/sdk** (Claude) |
| Compression / CORS / config | compression, cors, dotenv |
| Error monitoring | **@sentry/node** |

### Hosting / Operations
- **Hostinger VPS (Ubuntu)** running **nginx** as the reverse proxy in front of the Node app.
- **PM2** keeps the Node process alive (`pm2 restart erp`).
- Source control: **Git / GitHub**; deploy = `git pull` → `npm install` → `npm run build` → `pm2 restart erp`.
- Nightly **database backups** (better-sqlite3 online backup API) for both `erp.db` and `chat.db`.

---

## 3. Architecture

```
Browser (React + Vite build)  ──HTTPS──▶  nginx  ──▶  Node/Express API (PM2)
        │  axios (REST /api/*)                              │
        │  socket.io-client (real-time)                     ├─▶ SQLite  data/erp.db   (all ERP data)
        └  WebRTC (peer-to-peer media) ◀── signalling ──────┤        ▶ data/chat.db  (WhatsApp chat)
                                                            ├─▶ Anthropic Claude API (AI assistant + rate suggestions)
                                                            ├─▶ Email (SMTP) / Twilio / Web Push
                                                            └─▶ /uploads (files, photos, BOQs, bills)
```

- **REST API** under `/api/...` for all data operations.
- **Socket.IO** for live chat, read receipts, notifications, and call signalling (per-group rooms `g:<id>`, per-user rooms `u:<id>`).
- **WebRTC** carries call audio/video directly peer-to-peer; only tiny control messages go through the server. A STUN server is used by default; a TURN server (self-hosted `coturn`) is configurable for calls across different networks.
- **Role-based permissions** gate every module (view / create / edit / delete / approve / see-all).

---

## 4. Getting Started

1. Open **securederp.in** → the **Sign in** screen appears.
2. Enter your **Email/Username** and **Password** (provided by your admin). Tick **Remember me** to save the username on that device.
3. Click **Sign in**. You land on the dashboard.
4. **Change your password:** bottom-left of the sidebar → **Change Password**.
5. **Roles:** what you see is controlled by your role. **Admin** sees and can do everything (and can save forms even with blank mandatory fields). Other roles see only the modules granted to them.

---

## 5. Navigation & common controls

- **Left sidebar:** grouped menu (Procurement, Projects, Finance, HRMS, Inventory, Tasks, Service Desk, Executive, Admin, Settings). Click a group to expand. **WhatsApp** is pinned at the bottom. Use the sidebar **search** box to jump to a screen.
- **Top bar:** notifications bell, your name/avatar menu (Change Password / Logout).
- **Tables** typically have: a **search** box, **filters/chips**, **Export Excel**, and **Add** buttons (shown only if you have create permission).
- **Mandatory fields** are marked `*`. If a required field is empty you can't save — **except Admin**, who can save partial records anywhere.
- **Dates/times** are shown on the India clock (IST) everywhere.

---

## 6. Sales & CRM

### 6.1 Sales Funnel (Leads)
Track enquiries from first contact to won/lost.
**Steps:** open **Sales Funnel** → **Add Lead** → fill client, contact, source, category, value → save → move the lead through stages as it progresses.

### 6.2 Business Book
The master list of confirmed clients/projects and their order values; feeds Orders, AR/AP, and dashboards.

### 6.3 BOQ & Quotations
Build priced quotations (Bill of Quantities).
**Steps:** open **Quotations** → create a quote → add line items (description, qty, unit, rate) → the total computes → save/print. AI auto-quotation can pre-price extra-schedule items from the most recent matching BOQ.

### 6.4 Labour Rate Sheet
A master of labour rates per task (its own permission module `labour_rates`).
**Steps:** open **Labour Rate** → **Add** an item (name, specification, size, rate, UOM, category) → or **Import** an Excel sheet → use **Duplicates → Merge** to clean repeated rows.

---

## 7. Procurement

The procurement spine is **Indent → Dispatch**, with these tabs: **Raise Indent · Vendor Rates · Vendor PO · Payment · Purchase Bills · Dispatch & Receiving · Debit Notes · PO Pipeline**. Supporting masters: **Item Master** and **Vendors**.

### 7.1 Item Master
Every purchasable item with full pricing traceability.
**Steps:** **Items** → **Add Item** → fill Item Name, Type, Specification, Size, UOM, GST, Make, Rate, and the pricing source (Vendor, Source Type, Bill/PO Number, Bill/PO Date) → save. Changing rate/vendor/source automatically saves the old price to history (never deleted). Bulk import via CSV is available.

### 7.2 Vendors
Vendor master with full details and rate comparison.
**Steps:** **Vendors** → **Add Vendor** → fill Vendor Name, **Firm Name**, Category, Type, Deals In, Make/Brand, Contact, Phone, Email, State, District, GST, Payment Terms, Address. Search matches **vendor name and firm name** (and code/district/phone). Each row shows the firm name and a **Last Updated** timestamp. **Bulk Import** adds/updates many vendors from CSV. **Rate Comparison** tab compares up to 3 vendors per item.

### 7.3 Raise Indent
Site/engineer requests material.
**Steps:** **Raise Indent** → pick site → add items (from Item Master) with quantities → submit → it goes for **L1 + L2 approval**. Only indents that clear both approvals flow into Vendor Rates.

### 7.4 Vendor Rates (item-wise)
Collect up to **3 vendor quotes** per item, then finalize the best.
**Steps:**
1. Each approved item appears as a row. For **Vendor 1/2/3** pick the vendor (dropdown searchable by **name and firm name**), enter the **Rate** and **Terms**.
2. **Suggestion columns (reference only, never change your rates):**
   - **PP Rate** — the purchase price pulled from the linked Order-to-Planning BOQ item.
   - **Mktg Rate (AI · min market)** — auto-filled in the background by AI with the estimated **minimum** market rate (no clicking; a ↻ button re-estimates).
3. Use **Bulk fill** to apply one vendor + terms to many ticked rows.
4. **Finalize** the chosen vendor/rate → the item is ready for a PO.

### 7.5 Vendor PO + 2-level approval
**Steps:** **Vendor PO** → **Create Vendor PO** → pick vendor, link indent items, set qty/rate, payment & freight terms → create. A new PO starts **Pending L1 (Nitin Jain)** → after L1 approves → **Pending L2 (Ankur Kaplesh)** → after L2 approves → **Approved/Sent**. The right approver (or Admin/COO) sees **✓ Approve / ✕ Reject** (reject needs a reason). View/Print PO and Delivery Note from each row.

### 7.6 Payment, Purchase Bills, Dispatch & Receiving, Debit Notes, PO Pipeline
- **Payment** — flags POs needing advance / old-payment-clear before material; "Mark Cleared" unblocks.
- **Purchase Bills** — record the vendor's bill against a PO (vendor dropdown searchable by firm name).
- **Dispatch & Receiving** — track material going out / received; delivery notes.
- **Debit Notes** — post-PO adjustments.
- **PO Pipeline** — overview of where each PO stands.

---

## 8. Client Purchase Orders & Planning

### 8.1 Upload Client Purchase Order (Orders)
**Steps:** **Order to Planning** → **Upload Client Purchase Order** → choose the CRM, upload the PO copy → **Upload BOQ & Fetch Items** (Excel auto-fills the items; PDF/Word/image just attaches). For each BOQ line you have **Qty · Unit · Rate (SITC) · PP (Purchase Price) · Labour · Amount**.
- **Download blank BOQ format:** a button gives a ready Excel template (SN, Description, Specification, Size, Qty, Unit, SITC Rate, Purchase Price, Labour Rate, Amount, HSN). Fill data in this template so uploads import cleanly — **PP and Labour Rate are also auto-filled from the Excel** when those columns are present.
- Click **Create Purchase Order**.

### 8.2 Order Planning & Schedule (Gantt)
Plan execution dates; **Schedule (Gantt)** computes the "must raise indent by" date per BOQ item via a backward pass.

---

## 9. Projects & Site Execution

- **Indent Labour Payment** — full project execution + billing pipeline (project → budget → work order → muster → DPR link → measurement book → contractor RA → client RA → payment received).
- **Daily Reports (DPR)** — daily site progress; Table A labour rate = 11% of SITC.
- **Snags** — snag/defect list per site.
- **Fire NOC Renewal** — track fire NOC renewals.
- **Sales Billing** — 4-type sequential client bills (replaces the old Installations page); payments flow to receivables.

---

## 10. Finance

- **Cheques** — cheque financial management.
- **Payables (Payment Required)** — standard approval flow **L1 Accountant → L2 Nitin Jain → L3 MD (Ankur Kaplesh) → Release (Aanchal)**. Approving needs no remark; **rejecting requires a remark**. Named approvers resolve by name; Admin/COO can stand in.
- **Collections** — money received from clients.
- **Invoices (Billing)** — client invoices.
- **Cash Flow** — cash position.
- **AR/AP Tracker** — rolling 13-week cash-flow forecast (receivables vs payables by party × week, in Lakhs). AR auto-rolls on Mon/Thu, AP on Tue/Fri (unpaid entries move to the next collection day). Excel/bulk/paste inputs; a summary box shows where the running cycle goes negative.
- **Expenses** — company expenses.

---

## 11. HRMS

- **Hiring** — recruitment / ATS / interviews / offers.
- **Sub-contractor Hiring** — 14-step pre-award + onboarding tracker per site.
- **Onboarding / Training** — induction and training records.
- **Attendance** — daily attendance (already on IST).
- **Payroll** — salary processing with the confirmed day rules (late grace 09:46–10:00 with 3 free then ₹20/min, >10:00 = half day, ≥4h = full, <4h = half, short-leave/CL/Sunday handling, OT >9h at straight per-hour rate).
- **Employees** — employee master.
- **Performance** — weekly KPI scorecard.
- **Sub-contractor Master** — sub-contractor details.

---

## 12. Inventory

- **Tool Rentals** — rented tools (buy-vs-rent guidance at 2× threshold).
- **Assets** — company assets.
- **Inventory** — stock.
- **Tools** — tools management.
- **Room Rentals** — accommodation/rooms with monthly due dates and payment modes (Bank/UPI/Scanner).

---

## 13. Tasks & Service Desk

- **Delegations** — assign and track delegated tasks (with voice-note upload transcribed on the server).
- **PMS Tasks / Checklists** — recurring tasks and checklists.
- **Complaints** — customer/site complaints.
- **Help Tickets** — internal support tickets (reachable from the sidebar; the floating "?" bubble was removed).

---

## 14. WhatsApp

An internal, WhatsApp-styled team chat (separate `chat.db`, real-time via Socket.IO). Pinned at the bottom of the sidebar; shown to every signed-in user.

**Group chat**
1. Tap **+** → **New group** → name it, tick members → **Create group**. (Creating groups & managing members needs the `site_chat` Create permission.)
2. Anyone **added to a group can chat** (read, reply, voice notes, files) — **no extra permission needed**.
3. **Rename:** tap the group header → edit **Group name** → **Rename**.

**Direct messages (private)**
1. Tap the **person+ icon** → pick a person → a private 1-on-1 opens.
2. **DMs are private** — only the two people can read them; **even Admin/COO cannot see others' DMs**. (Admin still oversees group chats.)

**Messaging features**
- Text, **photos/files** (drag-and-drop onto the thread), **voice messages** (mic button → record → send, plays inline).
- **@mention:** type `@` → pick a member → inserts `@Name`; mentions are highlighted.
- **Read receipts:** ✓ sent, ✓✓ delivered, ✓✓ blue read-by-all; **Message Info** (hover → ⓘ) shows who read it / who it's delivered to, with times.
- **Profile photos:** tap your avatar (top-right of the WhatsApp page) to upload; photos show in chat list, headers, bubbles, member lists.
- **Notifications:** new messages pop a top-center banner + browser notification + an unread badge on the sidebar link — anywhere in the app.

**Voice & video calls (1-on-1)**
1. Open a **DM** → in the header tap **📞 (voice)** or **🎥 (video)**.
2. The other person gets a ringing **incoming-call** screen → **Accept** or **Decline**.
3. During a call: **mute**, **camera on/off** (video), **hang up**.
4. Calls use **WebRTC** (peer-to-peer). STUN works on the same network; for reliable calls across different networks a **TURN server** is needed (self-hosted `coturn`; set `turn_url`/`turn_username`/`turn_password` in settings).

---

## 15. Executive Dashboards

- **War Room**, **Operating Console (CMD)**, **TOC View** — admin-only executive dashboards summarising operations, cash, and throughput.

---

## 16. Admin & Settings

- **Users** — create/manage users, assign roles, toggle location tracking.
- **Roles & Permissions** — per-role matrix of **View / Create / Edit / Delete / Approve / See-All** for **every module** (including Labour Rate Sheet, Labour Payment, WhatsApp, etc.).
- **Backups** — run/download DB backups (nightly auto-backup keeps the last 30 of `erp.db` and `chat.db`).
- **AI Settings** — paste the Claude API key + pick the model; powers the AI assistant and the market-rate suggestions.
- **Email / Email Triggers** — SMTP config and automated email rules.
- **Audit Log / Activity Log** — who did what.
- **Location** — site/location master and map.

---

## 17. Cross-cutting concepts

- **Permissions:** every module is gated; shared read endpoints (dropdowns/dashboards) stay open. Grant changes apply live on tab focus.
- **Admin mandatory-bypass:** Admin can save forms even with blank required fields, app-wide (a global rule disables native required-field blocking for Admin; custom JS checks on Vendors & Item Master also exempt Admin). Non-admins keep full validation. (Payment Required is intentionally kept strict.)
- **Approvals:** Vendor PO (L1 Nitin → L2 Ankur), Payment Required (L1→L2→L3→Release), Indents (L1+L2). Named approvers resolve by name; Admin/COO can stand in.
- **AI assistant ("Ask ERP"):** reads your ERP data to answer questions; also powers minimum-market-rate suggestions. Rate-limited per the org's token/min — heavy AI features (auto-rate) are throttled so the chat keeps working.
- **IST timestamps:** all timestamps display on the India clock.

---

## 18. Deployment & Operations

**Stack on the VPS:** Ubuntu + nginx (reverse proxy) + Node (Express) under PM2 + SQLite files.

**Standard deploy (from the Hostinger browser terminal):**
```bash
cd /root/erp && git pull && npm install && cd client && npm install && npm run build && cd .. && pm2 restart erp
```
- Backend-only changes can skip the client build.
- If `git pull` is blocked by the server-side `package-lock.json`, run `git stash` first (or once: `git update-index --assume-unchanged client/package-lock.json package-lock.json`).
- After deploy, hard-refresh the browser (Ctrl+Shift+R) / reopen the PWA.

**Health & recovery:**
- `pm2 status` (should show `erp` **online**), `pm2 logs erp --err --lines 50` to diagnose a 502.
- A 502 = Node is down; `pm2 restart erp` brings the API back.
- On small VPSes, build out-of-memory can occur — add swap or build with `NODE_OPTIONS=--max-old-space-size=2048`.

**Backups:** automatic nightly (02:00) to `/root/erp-backups/` (last 30 kept) for both `erp.db` and `chat.db`; also runnable from **Settings → Backups**.

---

*Document generated for SEPL ERP. For the older, exhaustive section-by-section manual see `docs/ERP-COMPLETE-DOCUMENTATION.md` (and the Word/PDF/PPTX in `docs/`).*
