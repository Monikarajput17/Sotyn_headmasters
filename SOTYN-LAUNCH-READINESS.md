# Sotyn.ai — ERP SaaS Launch Readiness Assessment

**Prepared for:** Director / MD review
**Date:** 27 June 2026
**Subject:** Can we launch our ERP publicly as "Sotyn.ai"? What is blocking it, and what is the path?
**Status of product today:** Mature single-company internal ERP (Secured Engineers / SEPL). NOT yet a multi-customer SaaS platform.

---

## 1. The one-paragraph answer

We have an **excellent product** but a **single-company architecture**. The ERP works beautifully for *one* organisation — ours. To sell it to outside contractors as "Sotyn.ai", three platform capabilities that a SaaS *must* have are simply not built yet: (1) **multi-tenancy** — the ability to keep each customer's data separate and invisible to every other customer; (2) **self-serve billing & sign-up** — taking money and creating accounts without us doing it by hand; and (3) **public-internet security hardening** — the system today carries default secrets and credentials that are safe behind our office but unsafe for paying strangers. None of these are small. **The good news:** the hard 90% — the actual ERP with its ~150 tables, 32 modules, and real workflows — is done and proven. We are not rebuilding the product; we are wrapping a platform shell around it.

> **Important distinction.** "Launch" can mean two different things, and only one of them is blocked:
> - **Marketing / webinar launch (demo our own live instance, collect interested leads):** ✅ **Ready now.** We can absolutely run the 1 July webinar, demo the real system, and take sign-up interest.
> - **Onboarding paying customers onto the platform (their own logins, their own data):** ⛔ **Not ready.** This needs the work below.

---

## 2. Verdict at a glance

| # | Blocker | For a live demo? | For real paying tenants? | Severity |
|---|---------|------------------|--------------------------|----------|
| B1 | **No multi-tenancy** (every customer would share one database with no separation) | OK | ⛔ Showstopper | 🔴 Critical |
| B2 | **Security hardening** (default JWT secret, secrets in deploy script, default admin login) | OK | ⛔ Showstopper | 🔴 Critical |
| B3 | **No billing / subscription / sign-up** (no way to charge or self-provision) | OK | ⛔ Showstopper | 🔴 Critical |
| B4 | **Hardcoded SEPL branding** (our name, GST, address baked into every printout) | OK | 🟠 Major | 🟠 High |
| B5 | **Single-VPS + SQLite infrastructure** (one server, one file DB, single point of failure) | OK | 🟠 Major | 🟠 High |

**Bottom line:** Run the launch event. Do **not** put a paying customer's data into the live system until B1, B2, and B3 are done.

---

## 3. The blockers in detail (with evidence from our own code)

### 🔴 B1 — There is no multi-tenancy. This is the #1 structural blocker.

A SaaS keeps every customer's data in separate, isolated compartments. Customer A must never be able to see Customer B's leads, payroll, or vendors. Our database has **no such boundary at all.**

- A search of the entire server for any tenancy column — `tenant_id`, `company_id`, `org_id`, `workspace_id` — returns **zero matches.**
- Every one of our ~150 tables is **global**. Queries look like `SELECT * FROM customers WHERE 1=1` ([routes/customers.js](server/routes/customers.js)) — there is no "...and only this customer's company" filter, because the concept does not exist.
- Our `users` table has no company column. Roles are global (`admin` / `manager` / `user`), not per-customer.

**What this means in plain terms:** if we onboarded a second company onto the system today, **both companies would see each other's entire business** — clients, prices, salaries, everything. That is a data-breach and a lawsuit, not a feature gap.

**Fix:** Introduce a `tenants` table, add a `tenant_id` to every business table, stamp the logged-in user's tenant onto every read and write, and migrate our existing data into a "SEPL tenant". This is the single largest piece of work and must be done with extreme care — *one missed query leaks data across customers.*

---

### 🔴 B2 — Security is tuned for our office, not the public internet.

The system is currently protected mainly by being on our own VPS. Several items that are tolerable internally become unacceptable the moment outsiders can reach the login page:

- **Default JWT signing secret.** The token secret falls back to the public string `'erp-secret-key-change-in-production'` if no override is set, and it is then **persisted permanently on first boot** ([middleware/auth.js:16-24](server/middleware/auth.js:16)). If the server ever started without an explicit secret, that publicly-known value is now baked in — and anyone who knows it can **forge a login token for any user.** (This is a known item; it must be rotated deliberately because rotation logs everyone out once.)
- **Secrets committed in deploy scripts.** `deploy-vps.sh:45` hardcodes `JWT_SECRET=sepl-erp-secret-key-2026`, and `deploy-vps.sh:94` prints the default login `admin@erp.com / admin123`. These files are tracked in git — anyone with repo access has the production secret and the admin password.
- **No rate limiting on login.** Nothing stops automated password-guessing against `/api/auth/login`.
- **No security headers (Helmet) and weak password policy** (4-character minimum).
- **Emergency password-reset endpoint.** There is an owner-only "reset any user" code. *To its credit*, it is stored as a **bcrypt hash** in the DB and the plaintext lives in `data/RECOVERY.txt`, which is **gitignored (server-only, not in the repo)** ([schema.js:5336-5337](server/db/schema.js:5336)). This is acceptable for internal use but is a powerful endpoint that needs review and rate-limiting before public exposure.

**What's already good:** passwords are properly hashed with **bcrypt** (10 rounds); Sentry error tracking is wired in (just needs activation); a JWT-rotation script already exists.

**Fix:** Rotate the JWT secret to a real random value (env-only, never in a script); remove all hardcoded secrets/credentials from tracked files; force a strong password reset for the seed admin; add rate limiting + Helmet; review the emergency-reset endpoint. This is roughly **1–2 weeks** of focused work, not months.

---

### 🔴 B3 — There is no way to take money or create accounts.

A SaaS needs a customer to be able to find a pricing page, pay, and get a working account — without us touching anything. We have **none** of that chain:

- **No payment integration.** No Stripe, no Razorpay, no subscription or invoice tables for the *platform* (our customer-facing invoicing is unrelated). Search returns nothing.
- **No self-serve sign-up.** New users can only be created by an existing admin: the `/register` route requires `authMiddleware + adminOnly` ([routes/auth.js](server/routes/auth.js)). There is no public sign-up page, no email verification, no trial flow.
- **No plan/tier enforcement.** Our intended tiers (₹14,999 / ₹39,999 / ₹89,999 per month) have no `subscription_plans` table and nothing that maps a plan to a set of enabled modules.

**What's already good — and genuinely valuable:** we *already* have a **role → module permission system** with per-module `can_view / create / edit / delete / approve` flags ([schema.js role_permissions](server/db/schema.js)) covering all 32 modules. That is about 60% of what tier-gating needs — we map each price tier to a module set and reuse this engine.

**Fix:** Add `subscription_plans` + `tenant_subscriptions` tables, integrate **Razorpay** (best for India / ₹ / GST), build a pricing + sign-up page, and gate module access by the tenant's plan. Roughly **4–6 weeks.**

---

### 🟠 B4 — Our identity is hardcoded into the product.

To white-label for a customer, their printouts must show *their* company — not ours. Right now "SECURED ENGINEERS PVT. LTD", our GST `03AASCS7836D2Z3`, PAN, and office addresses are **hardcoded directly into the print/PDF templates** — e.g. the `COMPANY = {...}` block in [VendorPOPrint.jsx:30](client/src/pages/VendorPOPrint.jsx:30), plus Quotation, Delivery Note, Salary Slip, Offer Letter, NDA and ~15 other templates. The string "SEPL" appears across 150+ locations.

**What this means:** a new customer's purchase orders and quotations would print *our* company header and GST number. Unusable for them, and a compliance problem.

**Fix:** Create a per-tenant `company_config` (name, logo, GST, addresses, T&Cs), upload logos to storage, and refactor every template to read from it instead of the hardcoded constants. Roughly **3–4 weeks** (tedious but low-risk).

---

### 🟠 B5 — The infrastructure is a single server with a single-file database.

- **SQLite** (`better-sqlite3`) is a single-writer, in-process database. It is fast and reliable for one organisation (realistically ~15–30 concurrent users), but it cannot be shared, replicated, or scaled horizontally. Multiple paying companies will exceed it.
- **One Hostinger VPS** runs everything (Node + Nginx + DB). It is a **single point of failure** with no failover, and it is memory-starved — it **cannot even build the frontend** (we commit a prebuilt `client/dist` to work around OOM).
- **Backups are automated nightly** (good — uses the safe `.backup()` API, keeps 30 copies) but they sit **on the same VPS**. If that server is lost, both the live data and every backup are lost together.

**Fix:** Migrate SQLite → **PostgreSQL** (required for multi-tenancy anyway), move to a properly-sized host with off-site/object-storage backups, and add real monitoring/alerting (activate the Sentry DSN we already have). Roughly **3–5 weeks**, overlapping with B1.

---

## 4. What we already have going for us (the honest other side)

This is **not** a weak product. Re-launching it as a platform is realistic precisely because the foundation is strong:

- A **mature, battle-tested ERP**: ~150 tables, 32 modules, real workflows used daily — CRM, quotations, procurement/indents, billing, HR/payroll, projects/DPR, inventory, rentals, gamification, internal chat.
- A **role/module permission engine** that becomes our tier-gating system almost for free.
- **Proper password hashing** (bcrypt), a **sliding-session auth** design already thought through, **Sentry** integration ready to switch on, **automated backups**, and a **JWT-rotation script**.
- Some **AI surface already exists** (configurable AI key/model, voice-note transcription) — which matters for a ".ai" brand (see §6).

The expensive, risky part of any ERP — getting the business logic right — is **done**. What remains is platform plumbing, which is well-understood work.

---

## 5. The roadmap to launch (phased)

Estimates assume a small focused team (≈1 strong full-stack dev + part-time QA). Treat as planning ranges, not commitments.

| Phase | Goal | Scope | Rough effort |
|-------|------|-------|--------------|
| **Phase 0** | **Webinar-safe hygiene** (do before 1 July) | Rotate JWT secret to a real value; remove hardcoded secrets/admin password from tracked scripts; force-reset the demo admin password; confirm we only demo *our* instance | **2–4 days** |
| **Phase 1** | **Security hardening** | Rate limiting, Helmet, strong password policy, review emergency-reset, activate Sentry, add off-site backup | **1–2 weeks** |
| **Phase 2** | **Multi-tenancy** (the big one) | `tenants` table, `tenant_id` everywhere, tenant-scoped queries, migrate SEPL data, PostgreSQL migration | **6–10 weeks** |
| **Phase 3** | **Billing & self-serve onboarding** | Razorpay, plan/subscription tables, pricing + sign-up page, trial flow, tier→module gating | **4–6 weeks** |
| **Phase 4** | **White-label & scale** | Per-tenant `company_config`, de-hardcode all print templates, proper hosting + monitoring | **3–5 weeks** |

**Realistic calendar:** a credible **paid-customer launch is ~3–4 months out** with focused effort (phases overlap). The **marketing launch can happen on schedule** — we lead with the demo, collect interested contractors, and onboard them as a controlled early-access cohort once Phase 2–3 land.

**Recommended sequencing:** Phase 0 → 1 → 2 → 3 → 4. Multi-tenancy (Phase 2) is the critical path and gates everything that touches real customer data; start it first and treat its data-isolation testing as non-negotiable.

---

## 6. On the name "Sotyn.ai"

The name itself is not a technical blocker, but as a director-level decision it carries three checks worth doing before we print it on collateral:

1. **Domain & handles.** Confirm `sotyn.ai` (and ideally `sotyn.com` defensively) plus social handles are available and acquired. A `.ai`-only brand is fine, but owning the `.com` prevents a competitor or squatter sitting on it.
2. **Trademark.** A quick India trademark (and ideally a knock-out global) search on "Sotyn" before we commit to printing, so we don't build equity in a name we have to abandon. This is cheap insurance.
3. **The ".ai" promise.** A `.ai` domain sets an expectation that the product is AI-forward. We already have some AI surface (configurable model key, voice-note transcription). To make the name honest and marketable, we should foreground 1–2 visible AI features at launch — e.g. AI-assisted quotation drafting, auto-summarised DPRs, or a natural-language "ask your ERP" query box over the data we already hold. This turns the name from a label into a differentiator.

> Note: this supersedes the earlier working title "SecuredERP". If we adopt "Sotyn.ai", the de-branding work in **B4** is the same work that removes "SEPL/SecuredERP" from the platform — so the rename and the white-labelling are one effort, not two.

---

## 7. Recommendation

1. **Proceed with the 1 July launch as a demo + lead-generation event**, after the 2–4 day Phase 0 hygiene pass. Demoing our own live, working instance is safe and impressive.
2. **Do not onboard any external customer's real data** until multi-tenancy (B1/Phase 2) and security (B2/Phase 1) are complete and tested. Position early interest as a **waitlist / early-access** cohort.
3. **Greenlight the platform build** (Phases 1–4) as a defined ~3–4 month project. The product risk is low because the ERP itself is proven; the remaining work is well-scoped platform engineering.
4. **Decide the name now** (run the domain + trademark checks) so the de-branding and white-label work in Phase 4 targets the final name once.

*This document is an engineering readiness assessment based on a direct review of the current codebase. Effort figures are planning estimates and should be confirmed against the team that will execute them.*
