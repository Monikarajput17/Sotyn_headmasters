# Sotyn.Headmasters — Supabase-native backend (no Express server)

Decision (mam, 2026-09-02): replace the Express server with Supabase so the
salon runs at ₹0/month with nothing to host except static files.

## Target architecture

| Concern | Supabase piece |
|---|---|
| Database | Postgres (already migrated — Phase 1-3) |
| API (business logic) | **Edge Function `api`** — one Deno function, Hono-free: a tiny Express-compatible router (`_shared/express-lite.ts`) so the Phase-3 route modules port almost verbatim |
| DB access from functions | `_shared/pg.ts` — same `get/all/run/tx/savepoint` contract as `server/db/pg.js`, on `npm:postgres` via the **transaction pooler** (aws-0-ap-south-1:6543) |
| Login / sessions | **Supabase Auth** (email+password). `users.auth_user_id` links profile rows. Existing bcrypt hashes imported with `auth.admin.createUser({ password_hash })`. Username login = look up email by username first |
| Permissions | unchanged tables `roles / user_roles / role_permissions`; `requirePermission` ported into the shim's auth middleware |
| Chat realtime | Supabase Realtime private broadcast channels (`chat:group:<id>`), authorised by a policy on `realtime.messages` via `chat_group_members` |
| File uploads | Supabase Storage bucket `uploads` (public-read, like today's `/uploads/*`) |
| Crons | `pg_cron` (only what the salon needs) |
| Frontend | unchanged pages; `client/src/api.js` baseURL → `${VITE_SUPABASE_URL}/functions/v1/api`, plus refresh-token handling; host on Cloudflare Pages / Vercel |

## Scope = exactly what the Headmasters nav exposes
Salon ×9 (services, stylists, clients, appointments, POS, products, memberships,
commissions, public booking) + salon dashboard · Staff: attendance, payroll,
employees(+shifts), checklists, induction, training, delegations, help tickets ·
Admin: users/roles/permissions, audit, word-count/changelog, locations,
email settings/triggers, AI settings, backups (stub → managed) · site chat ·
upload · push (best-effort).

Explicitly NOT ported: procurement, DPR, fire NOC, solar, orders, leads, CRM,
scorecard/champions, rentals, tools, inventory, item master, cashflow,
collections, AR/AP, payment-required, complaints, snags, installation, billing,
sales-funnel, subcontractors, influencers, business-book (→ `[]`).

## Sessions / no-logout rule
Supabase access tokens expire (set project JWT expiry to the max, 604800 s).
Client stores `refresh_token`; `/auth/me` is called with `X-Refresh-Token`; the
function rotates the pair when < 2 days remain and returns
`X-Refresh-Token` / `X-New-Refresh-Token` headers (same sliding contract as
before). Only a rejected `/auth/me` may log out — unchanged policy.

## Work packages
- WP1 scaffold: `supabase init`, `functions/api/index.ts`, `_shared/{express-lite,pg,auth,storage}.ts`, `deno.json`
- WP2 port modules (agents, from `server/routes/*.js` Phase-3 versions → ESM/TS under `functions/api/routes/`)
- WP3 SQL: `users.auth_user_id`, realtime policy, storage bucket, pg_cron
- WP4 users → Supabase Auth (bcrypt import script)
- WP5 frontend: api.js base URL + refresh, chat/calls → Realtime, uploads URL
- WP6 deploy (`supabase functions deploy api`), smoke test against
  `https://kxwejphtauqjxsruojwo.supabase.co/functions/v1/api/...`, browser verification
- WP7 static hosting of `client/dist` (Cloudflare Pages / Vercel)

## Needed from mam
1. Supabase **personal access token** (dashboard → Account → Access Tokens) for CLI link/deploy
2. **service_role** key (Settings → API Keys) — local Auth-import script
3. **anon** key (same page) — frontend + Realtime
4. Auth settings: JWT expiry 604800; email confirmations off
