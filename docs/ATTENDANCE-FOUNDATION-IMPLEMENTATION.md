# Attendance foundation: local implementation and verification

Date: 17 September 2026. Scope: AT-01, AT-02, and the read-safety/capture safeguards of AT-03 in [the audit](ATTENDANCE-AUDIT-2026-09-17.md).

Subsequent owner-requested staff access defaults and the profile-menu flow are documented in [Attendance self-service](ATTENDANCE-SELF-SERVICE.md). That follow-up adds a separate migration without granting management access or starting AT-04/05.

The authorized foundation is implemented in the active Supabase Edge API and React client, with an incremental migration applied only to the isolated local database. No production schema or employee data was accessed, no production migration or deployment was performed, and no merge was made. Pre-existing local-environment work was retained. No real payroll was finalized, notifications sent, or employee attendance submitted. Payroll read verification used synthetic employees only.

**This foundation does not make attendance or payroll production-ready. Calculation and historical-record defects remain, including incorrect pay classifications and unsafe closed-period/finalization behavior.**

## Completed against the authorized scope

| Stage | Delivered |
| --- | --- |
| AT-01 | Rechecked the audit against the active Edge routes and local schema; preserved existing uncommitted work; created synthetic logins, employees, reporting relationships, branches, roles, shifts, attendance, leave and conflict fixtures. Migrated local integer leave days to numeric without replacing existing values. Hosted column type remains unverified. |
| AT-02 | Explicit action permissions and backend self/team/branch/all scopes for attendance, employee/shift access, tracking, payroll access and related maintenance. Multiple roles aggregate consistently; a broader scope from a role that denies the requested action cannot be borrowed. The admin label no longer bypasses these business permissions. Self-approval/manual self-correction is rejected. Added owner controls for scopes, employee relationships, branch creation and location branch assignment. |
| AT-03 reads | Removed dashboard auto-marking, payroll GET initialization and employee/login matching by name/email. Removed automatic tracking writes caused by opening Layout/Attendance. Relevant GETs are verified against before/after business-data snapshots. Explicit linking uses validated login IDs and rejects an already-linked login. Ambiguous existing data is listed without guessing or deletion. |
| AT-03 capture | Validated inputs; stable request IDs; database transactions, per-user locks and session/event uniqueness; replay-safe capture; checkout updates only an open record; original evidence retained. Capture time and server receipt time are separate. Supported online same-day sessions consistently use IST work dates. Duplicate legacy rows, missing check-in/check-out, and unsupported overnight assignments produce explicit errors. |

The small history prerequisite implemented here is a pending-only leave decision/edit/delete guard. A decided leave cannot be edited/deleted, and the database rechecks pending status at write time. Original punch deletion is blocked. These protections are necessary for capture/self-approval safety; they are not a complete amendment or period-closing workflow.

## Changed source files

Paths below are relative to the repository root; pre-existing environment changes are excluded from this list.

| Files | Purpose |
| --- | --- |
| `supabase/migrations/20260917000100_attendance_foundation.sql` | Incremental schema, initialization, permission mapping and conflict review view. |
| `supabase/functions/_shared/attendance-access.ts` | Per-action role scopes, permission-manager authority and serialized stable-ID linking. |
| `supabase/functions/_shared/attendance-guards.ts` | Route/action/target authorization and minimum shift/input/history guards. |
| `supabase/functions/_shared/attendance-capture.ts` | Transactional capture, idempotency, input checks, original events and work dates. |
| `supabase/functions/_shared/auth.ts` | Consistent permission aggregation; no attendance admin bypass; explicit owner capability. |
| `supabase/functions/api/routes/{attendance,hr,payroll,auth,locations}.ts` | Apply checks to actual Edge routes, scope queries/totals, remove read mutations and automatic linking, expose per-row UI action hints. Account/role mutation is protected to prevent indirect permission escalation. |
| `supabase/functions/api/routes/foundation-access.ts` | Owner-only scope relationships, branches, location assignments and conflict review. |
| `client/src/context/AuthContext.jsx`, `client/src/App.jsx`, `client/src/components/Layout.jsx` | Capability-based navigation and action checks; remove page-load tracking writes. |
| `client/src/pages/{Attendance,Employees,Payroll}.jsx` | Permission-aware actions, backend per-row hints, capture retry IDs, explicit login selection and effective current shift display. |
| `client/src/pages/admin/RolesPermissions.jsx`, `client/src/components/AttendanceAccessSetup.jsx` | Role scope editor and minimal owner setup. |
| `scripts/attendance/{foundation,helpers,browser}.test.cjs` | Active local API/database integration, isolated helpers and browser checks. |
| This document | Delivery, results, limitations and migration/recovery instructions. |

Legacy `server/routes/*` Express handlers are not the active local/test backend and were not rewritten. Do not run them concurrently against this migrated database; their old write paths do not enforce the new safeguards.

## Database structures and permission mapping

| Structure | Change and preservation behavior |
| --- | --- |
| `leave_requests.days` | Integer types widen to `numeric USING days::numeric`. An existing hosted decimal type is left unchanged. No rounding or historical recalculation. |
| `attendance_permission_managers` | Explicit login IDs allowed to manage accounts/roles/access relationships. Protected from account delete/disable/archive through ordinary account routes. Membership is provisioned by a reviewed database operator, not inferred from `users.role`. |
| `attendance_branches` | Minimal branch ID/code/name/active master. Not a tenant system or complete branch administration module. |
| `employees.attendance_branch_id`, `geofence_settings.attendance_branch_id` | Nullable branch references. Existing records remain unassigned until explicitly mapped. Existing two reporting-manager employee IDs define direct team scope. |
| `role_permissions.scope_mode`, `scope_branches` | `self`, `team`, `branch`, `all`; branch IDs stored as JSON text. Existing `can_see_all=1` maps to `all`; other rows default to `self`. No automatic inference of manager scope. |
| New action modules | Explicit stored grants copied from attendance into `attendance_capture`, `attendance_corrections`, `attendance_locations`, `attendance_tracking`; from employees into `employee_shifts`, `employee_links`; from payroll into `attendance_rules`. Existing destination grants are preserved. |
| Owner role | `Attendance foundation owner` initially grants all supported attendance actions to explicitly nominated permission managers only. Owner authority and business grants are separate: removing business grants does not remove the recovery path or restore an admin bypass. |
| `payroll_settings` | Singleton initialized during migration only if absent. GET returns settings without creating them. Existing settings preserved. |
| `attendance.capture_session`, `capture_state` | Nullable additions. Unique `(user_id,date,capture_session)` only for numbered sessions; at most one `open` session per user. Legacy rows remain null and untouched. Current API creates session 1; future code can add numbered/split/overnight sessions without removing a permanent user/day unique key. |
| `attendance_capture_events` | Original evidence, normalized payload hash, stable request ID, capture/receipt timestamps, event kind and attendance reference. Unique user/request and attendance/kind. No application event rewrite/delete endpoint. Database operators retain their normal privileged capabilities; this is not a cryptographically immutable archive. |
| `attendance_foundation_conflicts` | Review queue for duplicate attendance days, ambiguous employee/login links and unlinked employees. No automatic deduplication. |

New tables use RLS with no public client write policy; the conflict view is revoked from anon/authenticated roles. The Edge backend's privileged SQL access is protected by application checks. Existing table-level public API exposure was not comprehensively reassessed in this bounded stage.

The owner uses **Settings > Roles & Permissions** to grant supported action flags and scopes, create branches, assign employee branches/managers and associate locations with branches; **Users** assigns roles to logins. **Employees** links a verified login ID explicitly. Team includes the login's employee record plus direct reports in either manager slot, not recursive descendants. Branch scope is the selected branch IDs, not a browser filter. Multiple granting roles union their own scopes. `all` means this ERP database, not a separate company tenant.

Employee creation/bulk creation and linking an unassigned login currently require explicit all-employee/global linking authority. Global payroll/settings operations also require explicit all scope. Location maintenance can be branch-scoped, but creating an unassigned legacy location requires all scope. Full delegation of branch-only employee onboarding is pending. An unassigned employee is excluded from branch scope. The owner must review existing roles after migration because implicit admin access is deliberately not carried forward as business grants.

## Migration order and recovery

Local migration version `20260917000100` is applied. Local setup copies repository migrations into `.local/supabase/migrations` and applies them with `migration up --local`. Never apply the generated local baseline or test fixtures to a hosted database.

Any later deployment requires separate authorization and a coordinated schema/API/client rollout:

1. Inspect hosted schema, existing constraints, migration history, permission rows and conflicts in a staging copy first. Back up the database and verify restoration. Confirm one active, nonarchived owner's stable login ID and its working Supabase Auth login. Identify integrations/old clients writing attendance; suspend them during cutover.
2. Inspect duplicates and ambiguous links **before** applying constraints. Existing duplicates must remain available for review. Confirm current payroll settings defaults and hosted `leave_requests.days` type; do not infer that production has the local bigint defect.
3. Apply only the reviewed incremental migration with the nominated owner setting on the **same database session/transaction** as the SQL. The migration fails if no explicit owner exists. The automatic `local-admin` bootstrap requires the special isolated-local database marker and must never be enabled on production.
4. Release matching Edge routes and frontend, refresh owner login/permissions, then verify self/team/branch access and the permission-management recovery path. Keep application writes paused if API and schema versions do not match. Production build uses production configuration; do not copy `.local`, test credentials or test records.
5. Review conflict queue, map branches/managers and narrow migrated grants before any pilot. Calculation/history issues in the audit remain release blockers for payroll reliance.

Read-only preflight SQL (examples to adapt during an authorized release):

```sql
SELECT data_type, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema='public' AND table_name='leave_requests' AND column_name='days';
SELECT user_id, date, count(*) FROM attendance
GROUP BY user_id, date HAVING count(*) > 1;
SELECT user_id, count(*) FROM employees WHERE user_id IS NOT NULL
GROUP BY user_id HAVING count(*) > 1;
SELECT id, username, active, archived FROM users WHERE id = :verified_owner_id;
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname='public' AND tablename IN ('attendance','employees','role_permissions');
```

Owner nomination pattern (a reviewed database runner must bind the placeholder and execute the migration file in the same transaction; this was not run against production):

```sql
BEGIN;
SELECT set_config('attendance.bootstrap_user_id', :verified_owner_id_as_text, true);
-- Execute 20260917000100_attendance_foundation.sql here in this same session.
COMMIT;
```

Do not rerun the migration as a routine permission reset: it contains bootstrap/mapping operations. If a transaction fails, roll it back and resolve the schema/owner preflight issue. If deployment fails after database commit, pause writes and prefer a forward fix while retaining numeric leave values and capture evidence. Do not narrow `days` back to integer after storing half days, drop event tables, or delete duplicates to force migration success. Restoring a backup after new capture requires reconciling all later events; a blanket restore can discard attendance. Reverting only to old API/client code reintroduces the old permission and mutation problems.

For loss of permission-manager access, a separately authorized database operator verifies an active login and inserts its ID into `attendance_permission_managers` in a reviewed transaction. Verify that login can reach Roles & Permissions before removing any obsolete manager membership. Grant business permissions separately through the role editor. Do not set every admin as manager or use a blanket bypass. The local tests verify an ordinary `role='user'` manager can manage permissions while still receiving 403 for attendance without a business grant.

## Verification results

Final API run: **35 passed**, fixture tag `af1789632848508`, local user IDs 57-64. The fixture JSON records additional employee/branch IDs. Older synthetic runs are retained, including deliberate conflict rows; no fixture cleanup or real data import occurred.

| Verification | Actual result and limits |
| --- | --- |
| Active Supabase Auth -> mounted Edge API -> PostgreSQL | 35 passed: self/team/branch scope, cross-user denial, multi-role behavior, ungranted admin, owner recovery and assignments, shift validation, self-approval rejection, half-day 0.5 persistence, explicit links, compensation/relationship authority on employee creation, read snapshots, capture validation, concurrent/retry safety, original evidence, conflict reporting and action hints. |
| Capture concurrency | Six identical simultaneous check-ins return one recorded event; two fresh check-in IDs are rejected once the day exists. Five identical checkout requests record one checkout event. A changed payload reusing an ID and a fresh checkout after close return 409; original evidence stays unchanged. |
| GET snapshots | Employee, attendance, leave, shift, payroll settings and payroll run data compared before/after relevant reads, including a user with auto-mark enabled. No business-data changes. Authentication session behavior is separate from business records. |
| Real frontend in headless Microsoft Edge | Four scenarios: owner scope/setup UI, manager attendance, multi-role attendance viewer without capture authority, ungranted admin denied. Browser external requests blocked; no page-load attendance/employee/payroll writes or page errors. This is a UI smoke check, not a real camera/phone capture test. |
| Isolated helper tests | Two passed: IST date boundaries (midnight/month/year) and strict calendar validation including leap dates. |
| Vite production-mode compilation | Passed, 1,253 modules. Output placed in ignored `.local/attendance-build`; tracked `client/dist` left unchanged and nothing deployed. |
| Patch hygiene | `git diff --check` passed. |

Reproduction from this configured local workspace:

```powershell
npm.cmd run local:start
# Keep npm.cmd run dev running in another terminal for browser checks.
node scripts/attendance/foundation.test.cjs
node scripts/attendance/helpers.test.cjs
node scripts/attendance/browser.test.cjs
npm.cmd --prefix client run build -- --outDir ../.local/attendance-build
```

The browser runner uses the local-only Playwright installation at `.local/validation/node_modules/playwright` and installed Microsoft Edge. To provision that runner on another workstation: `npm.cmd install --prefix .local/validation --no-save playwright`. The integration runner requires Docker/local Supabase, verifies loopback API/DB URLs and the database isolation marker, and creates only synthetic accounts using the local service key. It does not print keys. Windows process restrictions may require permission to run esbuild/Edge/Docker. A nonfatal pg driver deprecation warning appeared because snapshot queries share one client; all assertions completed.

If the local Edge runtime still serves cached code after a backend edit, restart only `supabase_edge_runtime_sotyn-headmasters-local` before testing. Test summaries are in `.local/attendance-foundation-results.json` and `.local/attendance-browser-results.json`. See [local development instructions](LOCAL-DEVELOPMENT.md) for startup and local addresses.

## Remaining risks and intentionally pending defects

- **D01-D03, D10, D15-D16:** Shared calculation correction is not implemented. Late/half-day policy can conflict with assigned shifts; off-work and sandwich logic still has Sunday assumptions; missing checkout and half-day leave pay composition remain wrong/ambiguous. Manual mark stored hours, bulk marks versus leave, totals/precedence, joiners/leavers and salary-exempt list/detail differences remain. The legacy checkout under-four-hour classification was retained, not endorsed as a new policy.
- **D11-D12:** Closed periods, immutable payroll snapshots, amendments, finalization/reopen/paid-history protection, historical settings and assignment versions remain incomplete. The new capture event and pending-leave guards do not fix the complete history model. Current-zone geofence audit of past evidence also remains.
- **D07-D08:** Scope is online, same-day Asia/Kolkata attendance. Overnight/split/multiple sessions and delayed offline submissions are explicitly unsupported. A client timestamp must be within five minutes of server receipt for a new online event; original identical retries bypass freshness checks. Receipt time governs the recorded punch/work date. This is an engineering acceptance boundary, not a salary policy. Repeated retries survive within the current page lifecycle; reload recovery can read status but does not persist a pending selfie locally.
- Photo validation requires PNG/JPEG base64, a matching image signature and at most 600,000 encoded characters. It does not prove image authenticity/liveness or fully decode every malformed image. Coordinates/accuracy are client evidence, not spoofing-proof. Existing weak-GPS/geofence acceptance remains; employee-specific punch-location entitlement and UI/server geofence alignment need AT-06. Branch assignment currently scopes location maintenance, not punch eligibility.
- **D09:** Automatic page-load continuous tracking is removed; the legacy explicit tracking POST checks permission, target scope and the stored collection flag. No new continuous tracking feature was added. Operational continuous tracking requires a separate approved interaction/lifecycle design.
- **D14/D18:** Existing employee CSV import quoting/reupload issues, full leave overlap/date rules and payroll policy validation remain. Minimum shift date/time/range and same-day validation is included; full assignment overlap/versioning and policy publishing are not. Reporting-team scope is direct only; arbitrary management graph cycle validation is not implemented.
- Hosted schema compatibility, production role mapping, all unrelated ERP modules, physical GPS/camera/mobile behavior, load/security penetration tests and real payroll outcomes are unverified. Existing unrelated module admin behavior remains outside this scope. No broad organization/tenant isolation or public-table access audit is claimed.

## Recommended next bounded stage: approval required

Start **AT-05 history protection**, then **AT-04 calculation corrections**, with a shared result/version contract agreed first. Do not start templates, rotating rosters or imports yet.

1. AT-05: define the attendance period and amendment lifecycle; preserve original events and correction actors/reasons; protect closed/paid periods across every relevant writer; version the calculation inputs needed by AT-04; make finalized list/detail/export read the same stored snapshot; preserve prior snapshots/payments on a controlled reopen. Inventory existing history/provenance and flag gaps instead of manufacturing it.
2. AT-04: implement one shared day evaluator using those versioned inputs. Correct shift-relative lateness, actual scheduled off, leave/work composition, missing punches, manual-hour consistency, employment bounds and list/detail/report totals. Compare old/new results on synthetic/open-period cases; never silently recalculate paid historical records.

Before calculation acceptance, the owner must decide expected outcomes for half-day leave plus work, missing checkout, late/grace thresholds, short-day hours, paid off/sandwich/off-day work or comp-off, overtime/rounding, joining/leaving dates, and who may reopen/amend a closed period. Confirm the supported timezone and whether overnight sessions enter the following scope. AT-06 GPS/exception decisions are a dependency for trusting capture in an operational pilot. These business decisions are not invented in this implementation.

No work in this next stage has started. Await separate approval.
