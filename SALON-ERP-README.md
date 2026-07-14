# Sotyn.Headmasters — Salon & Spa ERP

A fork of the business ERP, re-purposed from **MEP construction** to a **salon & spa** business.
Same tech stack (Node/Express + better-sqlite3 backend, React + Vite + Tailwind frontend),
rebranded to **Sotyn.Headmasters**, with the construction modules removed from the navigation and a
full salon suite added.

## What's new (salon modules)

| Module | Route | Backend | What it does |
|---|---|---|---|
| Dashboard | `/` | `salonCommissions` `/dashboard/stats` | Today's sales, month revenue, commission, upcoming appts, top services |
| Appointments | `/salon/appointments` | `salonAppointments` | Day-view booking calendar, status flow (booked→confirmed→completed/cancelled/no-show), WhatsApp/SMS reminders |
| Billing / POS | `/salon/billing` | `salonPos` | Cart of services + retail products, per-line stylist, auto membership discount, loyalty redeem/earn, tax, invoice |
| Clients | `/salon/clients` | `salonClients` | Client profiles + visit history, spend, loyalty balance & ledger |
| Service Menu | `/salon/services` | `salonServices` | Categories + services (duration, price) |
| Stylists | `/salon/stylists` | `salonStylists` | Staff + per-stylist commission % |
| Memberships | `/salon/memberships` | `salonMemberships` | Membership (% off) & prepaid package plans; sell to a client |
| Commissions | `/salon/commissions` | `salonCommissions` | Per-stylist commission report, computed from paid sales |

Kept from the base ERP (generic business plumbing): Users/Roles/Permissions, Attendance, Payroll,
Employees, Hiring, Performance/Champions, Inventory, Assets, Invoices, Cash Flow, Cheques, Payables,
Tasks, Complaints/Help Tickets, internal team chat (rebranded "Salon Chat").

## Data model

`server/db/salonSchema.js` (idempotent, guarded demo seed): `service_categories`, `services`,
`stylists`, `salon_clients`, `appointments` (+ `appointment_services`), `membership_plans`,
`client_memberships`, `pos_sales` (+ `pos_sale_items`), `loyalty_ledger`, `salon_settings`.
Wired into boot from `server/db/schema.js` (`runSalonMigrations`). Module permission keys
(`salon_*`) are registered in `ALL_MODULES` and the Roles & Permissions screen.

The seed creates 5 categories / 17 services, 4 stylists, and 2 membership plans on first boot.

## Run it locally

```bash
npm install            # root deps
cd client && npm install && cd ..
npm run dev            # server (:5055) + vite (:3055) together
```

Or separately: `npm run server` and (in `client/`) `npm run dev`.
Ports are set to **5055 (API)** / **3055 (web)** to avoid clashing with the base ERP.
Change them in `.env` (`PORT`) and `client/vite.config.js` (proxy target + `server.port`).

Default login: **`admin` / `admin123`** (change immediately).

## Deploy

`npm run build` produces `client/dist`. Same deploy pattern as the base ERP
(commit prebuilt `client/dist`, then `git reset --hard origin/main && pm2 restart`).

## Optional: WhatsApp/SMS reminders

Appointment reminders use the shared `server/services/notify.js` (Twilio). Without Twilio
credentials in `.env` the reminder is logged (message previewed) but not delivered — add
`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_WHATSAPP_FROM` / `TWILIO_SMS_FROM` to send for real.
