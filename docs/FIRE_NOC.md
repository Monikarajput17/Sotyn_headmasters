# Fire NOC Renewal Module — SEPL ERP

Internal module for the full T-180 → T+30 NOC renewal funnel.
Spec source: mam's `Fire NOC` task brief 2026-05-16.

## Build status

| PR | Scope | Status |
|---|---|---|
| **PR1** | Migrations + data model + seed | **shipped** (this commit) |
| PR2 | Service layer + REST endpoints `/api/fire-noc/*` | pending |
| PR3 | Hourly cron stage-advancement engine | pending |
| PR4 | UI · Dashboard + Cycles list | pending |
| PR5 | UI · Cycle detail | pending |
| PR6 | Master DB viewer + CSV import (Levenshtein dedup) | pending |
| PR7 | Maker-checker enforcement + test suite (vitest) | pending |

## Decisions baked into this build (mam, 2026-05-16)

| # | Question | Answer |
|---|---|---|
| Q1 | Money convention | **rupees REAL** (match existing 39 ERP modules) — column is `amount` not `amount_paise` |
| Q2 | Invoice integration | thin `lib/invoice.js` service shim wrapping `sales_bills` POST |
| Q3 | PDF generation | HTML print view (`/fire-noc/quote/:id/print` → browser Save-as-PDF) — same pattern as Salary Slip / Vendor PO / Indent |
| Q4 | Outreach channels v1 | **Email + in-app push only**. `channel` column still accepts `sms`/`whatsapp` for the day Twilio/Gupshup keys arrive — no migration needed then. |
| Q5 | Contacts | inline `decision_maker_*` columns on `fire_noc_property`. Future Contacts master is a separate refactor. |
| Q6 | Tests | `vitest` for unit + integration; lands in PR7 |

## PR1 — what shipped

### Tables (11 total, idempotent `CREATE TABLE IF NOT EXISTS`)

1. `fire_noc_property` — building registry (FK customers)
2. `fire_noc_cycle` — renewal cycles with stage state-machine
3. `fire_noc_stage_history` — every transition logged with `triggered_by`
4. `fire_noc_outreach` — multi-channel send log
5. `fire_noc_quote` — quotes with `maker_user_id` + `checker_user_id` (PR7 enforces same-user rejection at service layer)
6. `fire_noc_document` — file uploads per cycle (drawings / applications / inspection reports / NOC cert / etc.)
7. `fire_noc_inspection` — dept inspections with pass/fail
8. `fire_noc_compliance_ticket` — per-item fix tickets when inspection fails
9. `fire_noc_upsell` — AMC / Annual Audit / Refilling / Training quotes at T+30
10. `master_noc_database` — RTI / past-client / broker / field-scrape lead pool
11. `fire_noc_state_cycle_rule` — state × building-type × cycle_years lookup (seeded below)

### Mandatory indexes (per spec)

- `idx_fnc_expiry_date` on `fire_noc_cycle(expiry_date)`
- `idx_fnc_stage_expiry` on `fire_noc_cycle(current_stage, expiry_date)`
- `idx_fnc_status_expiry` on `fire_noc_cycle(status, expiry_date)`
- `idx_mnd_state_expiry` on `master_noc_database(state, current_noc_expiry)`
- `idx_fno_cycle_sent` on `fire_noc_outreach(cycle_id, sent_at)`
- `idx_fnsh_cycle_entered` on `fire_noc_stage_history(cycle_id, entered_at)`

### Idempotency constraint

`fire_noc_stage_history (cycle_id, to_stage, entered_at)` is `UNIQUE` so the hourly cron can re-fire the same stage advancement for the same cycle without duplicating rows. Side-effect tables (`fire_noc_outreach`, `fire_noc_quote`) similarly use `UNIQUE(cycle_id, expected_stage)` where the cron is the trigger.

### Seeds (guarded by `app_settings.fire_noc_seed_v1`)

**`fire_noc_state_cycle_rule`** — 8 rows covering the spec's 7 cases:
```
Uttar Pradesh   · hospital     · 1 year
Uttar Pradesh   · school       · 1 year
Maharashtra     · hospital     · 1 year
Maharashtra     · school       · 1 year
Karnataka       · (all)        · 2 years
Delhi           · (all)        · 3 years
Gujarat         · (all)        · 3 years
Tamil Nadu      · (all)        · 3 years
__DEFAULT__     · (low-risk)   · 5 years    ← fallback
```

Lookup rule in service layer (PR2): most-specific row wins. Match `(state, building_type)` first; if none, match `(state, NULL)`; if none, fall back to `__DEFAULT__` row.

**`role_permissions`** — 6 permission keys mapped to the existing `(module, action)` schema:

| Spec key | DB row |
|---|---|
| `fire_noc.view` | `module='fire_noc'`, `can_view=1` |
| `fire_noc.edit` | `module='fire_noc'`, `can_edit=1` |
| `fire_noc.advance_stage` | `module='fire_noc'`, `can_create=1` (we treat stage advancement as a CREATE of a stage-history row) |
| `fire_noc.approve_quote` | `module='fire_noc'`, `can_approve=1` |
| `fire_noc.master_db.view` | `module='fire_noc_master_db'`, `can_view=1` |
| `fire_noc.master_db.ingest` | `module='fire_noc_master_db'`, `can_create=1` |

Default role mapping (only seeded if the role exists):
- Admin → all 6
- Sales Head → view, edit, advance_stage, approve_quote, master_db.view
- Sales → view, edit, advance_stage, master_db.view

If `Sales` and `Sales Head` roles don't exist yet, the seed only writes admin row — mam can create the roles via Admin → Roles & Permissions and the seed re-runs on next deploy to fill them.

## Out of scope for PR1

- Service layer (`server/routes/fireNoc.js`) — PR2
- Hourly cron stage advancement — PR3
- All five UI pages — PR4 / PR5 / PR6
- Maker-checker enforcement (columns exist; logic in PR7)
- Test suite — PR7

## How to verify PR1 after deploy

```bash
# On the VPS, after pm2 restart:
pm2 logs erp --lines 50 --nostream | grep -E "fire_noc|seed"
# Expected: "[migration] fire_noc_seed_v1: seeded 8 state-cycle rules + 6 permission keys"

# Or query the DB directly:
sqlite3 /root/erp/data/erp.db "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fire_noc%' OR name='master_noc_database';"
# Expected: 11 lines

sqlite3 /root/erp/data/erp.db "SELECT state, building_type_filter, cycle_years FROM fire_noc_state_cycle_rule;"
# Expected: 9 rows (8 specific + 1 __DEFAULT__)
```

## RBAC integration

Module appears in **Admin → Roles & Permissions** as two rows:
- `fire_noc` — view / create (advance) / edit / delete / approve / see_all
- `fire_noc_master_db` — view / create (ingest) / edit / delete / approve / see_all

Existing UI already supports adding modules dynamically once permissions are seeded — no UI change needed in PR1.
