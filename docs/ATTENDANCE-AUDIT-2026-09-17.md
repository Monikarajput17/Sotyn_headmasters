# Attendance assessment for salon and spa operations

Assessment date: 17 September 2026. Repository: `Sotyn_headmasters`. **Assessment only; no application fixes, schema changes, configuration changes, migrations, real attendance submissions, notifications or payroll runs were performed.**

## A. Executive summary

**The existing module is a useful foundation, but is not ready for a salon pilot that treats its attendance results or salary calculations as authoritative.** A demonstration with synthetic records is appropriate. A real attendance pilot should follow the first-release safeguards in section F and a reviewed acceptance run.

Already present: employee records, two reporting-manager links, employee-specific shift start/end times and one repeating weekly-off day, effective-from history, GPS/selfie punch screens, geofence maintenance, leave requests/decisions, manual missing-day marks, attendance grids/reports/CSV exports, role permissions, payroll settings and saved payroll snapshots. These are existing components to extend, not a reason to replace the ERP.

The strongest verified working pieces are the **date-effective shift resolver** and basic geofence decision logic. Isolated tests confirmed that a future assignment does not change the shift returned for an earlier date, and that precise onsite versus clearly remote GPS readings are distinguished. These helper tests do not establish that the complete UI/API/database workflow is production-ready.

Business users can already enter employee shift times, one weekly-off weekday and an effective-from date. Administrators can maintain geofence coordinates/radius/active status and several global payroll rules. Designation is separate from shift. However, there is no reusable shift-template master, date-wise roster, assignment end date, rotating/multiple-off pattern, shift/off swap approval or either requested assignment/roster Excel workflow.

The principal release risks are:

1. **Incorrect attendance/pay outcomes.** An on-time 11 AM shift can be treated as half-day by the global 10 AM payroll cutoff. A missing checkout can receive a full day. Sunday bonuses still apply to employees whose off day is Tuesday. Partial leave and attendance have inconsistent precedence across screens and payroll.
2. **Insufficient access boundaries.** Administrator status bypasses configured permissions. Several attendance, employee and tracking APIs return all records without branch/team scope. Approval and self-approval safeguards are incomplete.
3. **History is not protected.** Settings are mutable, original attendance rows can be deleted, and attendance/leave/assignment changes ignore payroll closing. Finalized payroll detail recalculates live; finalization can overwrite a snapshot; reopening deletes snapshots.
4. **Capture and exception gaps.** No work-session model for overnight shifts or breaks; no offline submission queue or idempotency; no unique employee-login/date attendance constraint locally. Weak GPS can allow a punch from any distance, with a flag but no required exception approval.
5. **Local verification limitation.** The isolated database has no employees, shifts, attendance, leaves, geofences or payroll settings. Its generated schema also stores leave days as an integer, incompatible with a half-day request. Hosted production schema/deployment parity was not assessed.

### Scope, methods and confidence

The active path inspected is React/Vite → `/api` client → Supabase Edge Function API → shared PostgreSQL adapter → attendance/HR/payroll tables. The mounted Deno routes under `supabase/functions/api` are authoritative for this assessment. Similar Express files under `server/routes` are legacy evidence, not proof that a feature runs in the current backend.

Verification consisted of repository inspection, two explicit **read-only PostgreSQL transactions against `127.0.0.1:54322`**, and **20 isolated checks of the existing TypeScript logic**. The test harness transpiled source in memory, supplied synthetic August 2026 records through mocked database reads, prohibited database writes, and had no network access. The private payroll arithmetic function was exercised in isolation; no payroll endpoint, finalization or real payroll processing was invoked. The audit-only harness is retained at `.local/attendance-audit.cjs` and is not application code.

All 20 final checks reproduced their stated outcomes, including defects. This is not a claim that 20 business acceptance scenarios passed. The unpaid-Sunday check specifically confirmed that `sundays_paid=0` is respected for an unworked Sunday; the defect is the separate hardcoded Sunday-work bonus and Sunday-only sandwich processing.

Read-only metadata showed zero rows in `employees`, `employee_shifts`, `attendance`, `leave_requests`, `geofence_settings`, `payroll_settings` and `payroll_runs`. Existing local tracking rows were not changed. The audit did not seed records or open authenticated attendance/payroll screens: those screens can write tracking data, auto-mark attendance or initialize payroll settings merely by loading. Existing broad smoke tests were inspected but not run because they traverse GET routes with side effects and target the legacy server.

Not verified: a complete punch/leave/import/save workflow, real phones/cameras/GPS, concurrent requests, realistic-volume performance, production data/schema/RLS, hosted cron jobs, external notification delivery, production release configuration or owner-approved business policy. No claim about live production behavior relies on accessing production. Pre-existing workspace changes from local-environment setup were preserved.

### Evidence index

Line numbers refer to the inspected working tree. API paths below omit the local Supabase `/functions/v1/api` prefix.

| Ref | Evidence |
|---|---|
| E01 | [Active API entry](../supabase/functions/api/index.ts), [staff mounts](../supabase/functions/api/routes/staff.mounts.ts), [HR mounts](../supabase/functions/api/routes/hr.mounts.ts), [client routes](../client/src/App.jsx), attendance route around line 196 |
| E02 | [Attendance UI](../client/src/pages/Attendance.jsx): permissions 25–29; loading 81–126; GPS/tracking 128–247; punches 272–301; grid 305–344; tabs 383–397; exports 775/914; geofences 1191/1486/1554; leaves 1213/1435 |
| E03 | [Employees UI](../client/src/pages/Employees.jsx): shift editor 26–55 and 430–480; separate employee/shift writes 128–159; CSV import/export 169–255; free-text designation/department 383–384 |
| E04 | [Active HR API](../supabase/functions/api/routes/hr.ts): employee list/salary visibility 95–139; shift history/write 143–162; create/bulk/update 164–255; deletion safeguards 264 onward |
| E05 | [Shift resolver](../supabase/functions/_shared/lib/shifts.ts): ordered history 13; resolver 22/34; time parsing 42; cutoff 53; off fallback 60; user link 66 |
| E06 | [Attendance API](../supabase/functions/api/routes/attendance.ts): self views 67–285; all-record list 287; dashboard auto-mark 310–356; individual/grid/bulk marks 361–566; login linkage 568 |
| E07 | [Attendance capture/location API](../supabase/functions/api/routes/attendance.ts): punch-in 582; punch-out 636; tracking 691; user tracking read 723; geofence read/audit/write 735–910; report 913 |
| E08 | [Leave/correction-related API](../supabase/functions/api/routes/attendance.ts): manager resolution 936; request 958; list 993; approve 1033; edit/delete 1063–1087; disabled auto-punch helper 1095–1157; email stubs 14–20 |
| E09 | [Geofence helper](../supabase/functions/_shared/lib/geofence.ts): defaults 38; database settings 46; evaluator 103; coarse allowance and 300 m buffer near end |
| E10 | [Payroll UI](../client/src/pages/Payroll.jsx): settings 20–76; load/calculate 114–119; settings save/finalize/unlock/detail 252–280; CSV 353; balances/eligibility 679–725 |
| E11 | [Payroll API and calculator](../supabase/functions/api/routes/payroll.ts): settings 27–109; exempt branch 133; auto-link 195–209; daily calculation 215–394; penalties 395–419; Sunday rules 424–481; rate/OT 483–530; list/detail 603–649; finalize/paid/unlock 651–731; adjustments 734–829; balances/eligibility/rollover 906–978 |
| E12 | [Backend auth](../supabase/functions/_shared/auth.ts): `adminOnly`, `requirePermission`, `getUserPermissions`; [frontend auth helpers](../client/src/context/AuthContext.jsx) 123–145; [role editor](../client/src/pages/admin/RolesPermissions.jsx); [auth routes](../supabase/functions/api/routes/auth.ts) 175–191 and 410–445 |
| E13 | [Schema source](../server/db/schema.js): employees 1089; attendance 1521; geofences 1544; tracking 1566; leaves 1579; shifts 1601; settings 1616; payroll runs 1647; geo columns 2934–2943; indexes 5106–5114. [Local generator](../scripts/local/schema.js) maps integer declarations to PostgreSQL bigint. Hosted migrations available in [migrations](../supabase/migrations) contain the realtime-chat policy migration, not a complete attendance baseline. |
| E14 | [Global tracking UI](../client/src/components/Layout.jsx) 272–321; [admin locations API](../supabase/functions/api/routes/locations.ts), including display filters for `track_location`; [push worker](../client/public/sw.js) |
| E15 | [Generic audit middleware](../supabase/functions/_shared/audit.ts), [admin audit API](../supabase/functions/api/routes/audit.ts), [legacy HR scheduler](../server/scripts/hrAutomationsCron.js), [legacy smoke script](../scripts/smoke-test-pg.js) |
| DB | Read-only local metadata/constraints/counts: attendance indexes on `(user_id,date)`, date and status are nonunique; shift index `(employee_id,effective_from)` is nonunique; employees have no unique login-link index; payroll runs do have unique `(month,employee_id)`; leave `days` is bigint. Table-name inspection for branches/rosters/holidays/policies/designations/departments found only `employee_shifts` among those attendance-related masters. |
| T01–T20 | Isolated verification results described in section E; no real API mutations. |

## B. Requirement matrix

Status abbreviations map exactly to the requested classifications:

- **V — Implemented and functionally verified**, limited to the explicitly tested unit/behavior.
- **C — Present in code, not functionally verified**; complete saved workflow not exercised.
- **P — Partially implemented**; identifiable pieces exist but the requirement is incomplete or inconsistent.
- **M — Missing** from the inspected active implementation and available schema.
- **U — Unable to assess from available access**.

`Dxx` identifies a defect in section B2. Missing features are identified separately as capability gaps and mapped to backlog items `AT-xx`.

| Requirement | Status | Existing behaviour | File/API/database evidence | Verification performed | Gap or defect | Business impact |
|---|---|---|---|---|---|---|
| Employee/login and manager records | P | Employees link to users; two employee reporting managers; other user hierarchy also exists | E03/E04; `employees.user_id`, manager IDs | Source + DB | No unique employee/login linkage; read-time name auto-link D13; no branch or exit date | Wrong-person attendance/pay linkage; ambiguous team hierarchy |
| Designation independent of shift | C | Free-text designation/department saved separately; shifts in own table | E03/E04/E13; PUT employee vs POST employee shifts | Full source trace | Separation exists; controlled code masters missing | Same designation can have different shifts; uploads cannot validate master codes |
| Branch/company attendance organization | M | Legacy sites/geofences exist, not branch employment/attendance scope | E04/E07/E13/DB; no branch columns in relevant tables | Source/schema searches | Branch memberships, transfers, hierarchy missing | Cross-branch controls/reporting unavailable |
| Unlimited reusable shift templates | M | Raw per-employee times only | E03/E04; `employee_shifts` | Source + DB | No shift code/name/master/active flag | Repetitive edits; requested arbitrary template catalog unavailable |
| Per-employee start/end times | P | UI saves any entered start/end with effective date | POST `/hr/employees/:id/shifts`; E03–E05 | Source + DB + T01/T03 | End stored but not used by calculation; malformed times accepted | Cannot enforce actual shift duration/end |
| Applicable assignment on work date | V | Latest effective-from not later than date; ordered ID breaks ties | E05 | T01/T02 | Core resolver verified; conflicting rows silently win | Good reuse point; needs conflict protection |
| Default assignment start and end | P | Effective-from; lasts until next row | E04/E05/DB | Source + T01 | No effective-to; blanks reset to fallback | Cannot express bounded temporary assignment directly |
| Future permanent assignment and history | P | Append-only API history; future row starts on date | E03–E05 | T01 + source | Backdating not locked; current UI uses last history row including future D12 | Historical changes/UI confusion possible |
| Temporary/date-specific/rotating/split shift | M | One resolved row/day | E04/E05/E07 | Source + schema search | No roster/segments/temporary override layer | Cannot support changing salon schedules safely |
| Assignment conflict detection | M | No duplicate/effective overlap validation | E04/DB | T02 + source | Same-day last ID wins; no overlap constraint | Conflicting edits silently change schedule |
| Overnight shift and work date | P | Start/end can be entered across midnight | E05/E07; punch lookup uses current UTC date | Source | No overnight session resolution; timezone D07 | Checkout can miss prior work session |
| Paid/unpaid breaks and net hours | M | Elapsed first-in/last-out hours only | E07/E11 | Source | No breaks or multiple sessions | Break time counted as work/possible OT |
| Required hours separate from shift duration | P | Global minimum fields; one used by payroll | E10/E11 | T15 | `min_hours_full_day` unused; punch-out hardcodes 4 D01 | Configured rules do not produce consistent results |
| Late grace / early departure / partial thresholds | P | Shift start overrides late cutoff; global half-day clock and monthly free-late count | E05/E10/E11 | T09/T15/T16 | No per-shift grace minutes or early-departure rule; D01 | Different salon shifts incorrectly penalized |
| OT eligibility/rate and approval | P | Employee flag, global daily hours and multiplier | E10/E11; PUT leave-balance | T17 + source | No approved-extra-hours request; no effective history | Unapproved elapsed time can generate pay |
| Template/policy activation and versioning | M | Geofences have active flag; shift policies do not | E04/E09/E11/DB | Source/schema | No policy draft/publish/effective versions | Settings changes can change old results |
| Employee repeating weekly off | P | One weekday 0–6 per effective shift row | E03–E06/E11 | T01/T03/T12/T13 | Default Sunday; downstream Sunday assumptions D02 | Basic individual off works incompletely |
| Rotating/date-specific/multiple offs | M | One weekday, no pattern/date roster | E03–E05/DB | Source/schema | No pattern cycle or date-level override | Monday-this-week/Thursday-next needs manual history workarounds |
| Moving/swapping an off with approval | M | Can append another repeating weekday | E04/E05 | Source | No paired old/new-date transaction, swap request or approval | May create two offs or none in a transition week |
| Working scheduled off, leave/holiday interaction | P | Attendance/leave/off precedence varies; Sunday bonus | E06/E08/E11 | T11–T13/T18 | D02/D03; holiday calendar missing | Incorrect pay and inconsistent explanations |
| Branch holiday calendar/work policy | M | Manual `holiday` status exists only | E06/E11/E13 | Source/schema | No holiday master, branch/date assignment or holiday-work rule | Holiday planning/payment manual |
| Coordinate/radius/active geofence maintenance | C | Add/edit/delete locations in UI/API | E02/E07/E09; `geofence_settings` | Full source trace + DB | Not branch-scoped; hard delete allowed; numeric validation weak | Admin can define zones but not employee permissions |
| Precise onsite/outside location decision | V | Haversine + uncertainty; far precise fix blocked | E09 | T04/T05 | Helper only; actual phone/GPS workflow unverified | Useful reusable validation component |
| Multiple permitted/temporary locations per employee | M | Every active geofence applies to every user | E07; queries all active geofences | Source | No employee-location association or validity dates | Staff can punch at unauthorized business locations |
| Capture methods/selfie enforcement | P | Browser GPS + selfie UI; server timestamps | E02/E07 | Source | Server accepts missing photo; no method policy D08 | API bypass of intended evidence requirement |
| Accuracy/staleness/missing GPS exceptions | P | Accuracy stored at punches; weak fixes allowed, GPS_OFF pings | E02/E07/E09 | T06/T07 | No server reading-age validation, approved exception workflow or accuracy controls in ERP | False assurance, failed capture can become apparent absence |
| Continuous tracking distinct from punching | P | Layout and attendance page both send 30-second pings | E02/E14; POST track-location | Source + pre-existing local rows | Opt-out filters display, not collection D09 | Unrequested collection/load continues outside punch workflow |
| Offline/delayed sync/retry protection | M | Errors/toasts and status polling; push-only worker | E02/E07/E14 | Source | No offline event queue, event ID or reconciliation | Lost/duplicate submissions; delayed work time unrecoverable |
| Duplicate/concurrent punch protection | P | Pre-insert SELECT and already-out check | E07/DB | Source + indexes | Nonunique attendance/day; update lacks conditional state D06 | Races can duplicate or overwrite evidence |
| Correction request/approval/apply workflow | M | Admin direct marks for missing rows; attendance delete | E06/E08 | Source | No employee correction request, immutable amendment or maker/checker | Technical exceptions cannot be resolved traceably |
| Manual missing-day marks | P | Individual/month bulk marks; real row protected by individual mark handler | E06; admin-mark/bulk | Source | Bulk ignores leave D10; hours stale on mark edit; self/closed-period checks absent | Wrong records/summary hours; uncontrolled backfill |
| Full and half-day leave with approval | P | Request form; manager/approver/admin decisions | E02/E08/E13/DB | Source + T11 + read-only type check | Half-day/pay treatment D03; local integer defect D17; self approval D04 | Leave/pay integrity incomplete |
| Requested assignment Excel workflow A | M | Existing employee CSV creates employees only | E03/E04; `/hr/employees/bulk` | Parser/API/schema trace | No stable-ID updates, code mapping, shifts/offs/branch/end-date columns | Does not satisfy assignment import |
| Requested date-wise roster Excel workflow B | M | No roster model/route/template | E03–E05/DB | Searches + trace | Work-date/day-type/shift/branch import missing | Scheduling remains manual |
| Import template and preview | P | Generic employee CSV examples and parsed-row preview | E03 186–244 | Source | No previous/proposed values; CSV parser breaks quoted commas D14 | Preview can misrepresent data; cannot review assignment changes |
| Import identity/code/date/duplicate validation | M | Generic bulk validates mainly name and DB constraints | E04 205–223 | Source | No assignment validation, stable ID match, conflicts or deduplication | Repeat upload creates duplicates; spelling errors remain free text |
| Import blank/end-date semantics | M | Generic CSV blanks become empty text/zero salary | E03/E04 | Source | No patch semantics; assignment end-date absent | Cannot safely clear/retain bounded assignments |
| Import approval/atomicity/results/reversal/lock | P | Generic bulk reports added/total/errors; partial processing | E04; E03 toast | Source | No approval, durable job/row report, retry ID, reversal or period protection | Not suitable for controlled bulk attendance changes |
| Owner-granted granular action permissions | P | Module CRUD/approve/see-all flags | E12/DB | T19/T20 + source | Admin bypass, coupled actions, inconsistent role merging D04/D05 | Owner cannot enforce requested delegation model |
| Company/branch/team/employee data scopes | P | Self routes and direct-manager leave links exist | E04/E06–E08/E11/E12 | Source | Most shared reads/writes lack scopes D04 | Rows, totals, photos and exports expose broader data |
| Self-approval/self-correction prevention | M | Admin or broad approver may act on own records | E06/E08 | Source | No explicit requester/subject/approver separation | Personal attendance/pay can be self-authorized |
| Master/policy/event/correction/result separation | P | Different tables for shifts/settings/attendance/payroll | E13 | Source + DB | Attendance row mixes events/result; no correction/policy version tables | Cannot reconstruct an approved outcome reliably |
| Policy precedence/conflict/impact preview | M | Shift-start fallback over global late time; separate global payroll clock | E05/E11 | T09/T16 + source | No company/branch/team/employee hierarchy or publish preview | Inconsistent and retroactive outcomes |
| Original evidence preservation | P | Individual manual mark rejects actual punch overwrite | E06/E08/E15 | Source | Delete API removes originals; generic log not immutable ledger D11 | Disputes cannot rely on complete evidence |
| Locked attendance periods/recalculation | M | Payroll finalization exists separately | E06/E08/E11 | Source | No attendance period guard, controlled recalc or adjustment ledger D11 | Closed pay and editable attendance diverge |
| Payroll saved snapshots/reopening | P | Monthly rows unique per employee/month | E11/DB | Source + DB | Live detail; overwrite finalization; delete reopening D11 | Paid/finalized history can be lost or inconsistent |
| Deactivate referenced masters | P | Employee statuses and geofence active status | E03/E04/E07 | Source | Geofence hard delete; no template master lifecycle | Historical geofence audit reinterprets old evidence |
| Employee everyday/mobile view | P | Punch card, camera, location status, history/calendar, leave status; responsive markup | E02 | Source only | No assigned-shift/location-entitlement explanation or correction status; D08/D15 | Staff cannot understand/resubmit many exceptions |
| Manager pending work/team exceptions | P | Leave records tied to direct managers in backend | E02/E08 | Source | UI loads leaves under see-all; ordinary manager may lack screen access; no exceptions queue | Team workflow incomplete despite approval endpoint |
| HR administration and owner overview | P | Employee shifts, admin grids/dashboard and payroll settings | E02–E04/E10 | Source | Admin-only panels, no branch staffing scope/roster/attendance close | Not an owner-controlled salon operations console |
| Attendance/payroll exports | P | Client CSV exports labeled Excel; printable payroll views | E02/E03/E10 | Source | No independent export permission, scoped server export, stable closed result guarantee | Spreadsheet download inherits data/scope/calculation defects |
| Leave notifications and recurring attendance jobs | P | Active leave email functions are stubs; old auto-punch helper disabled; other push infrastructure exists | E08/E14/E15 | Source | Attendance notification execution/retry not wired; hosted jobs unknown | Do not promise automated reminders/approval delivery |
| Audit history | P | Generic mutation logs and admin paginated viewer | E15 | Source + DB schema | Fire-and-forget request log; incomplete before/after; GET writes not logged as mutations | Weak reconstruction of bulk/policy/correction changes |
| Backend pagination/search/sort/filter | P | Date/user/status attendance SQL filters; employees and month grids return all rows | E04/E06/E07/E11 | Query inspection | Attendance/employee lists lack paging and scalable search/sort | Large datasets and selfie payloads increase load |
| Scoped totals and staffing summaries | P | Dashboard counts users/attendance/leave | E06/E07 | Query inspection | D15: ignores scopes/off/join dates; dashboard GET writes D13 | Misleading absenteeism and unsafe report loading |
| Query indexes and concurrency | P | Attendance/date/user, shifts/employee/date, leave/user/status indexes | E13/DB | Actual local indexes | No unique punch/day or assignment conflict constraint; no branch keys | Index presence helps reads but does not ensure integrity |
| Realistic volume/jobs/retry verification | U | Sequential payroll per employee; grids scan all histories; generic audit API is paginated | E06/E11/E15 | Source risk analysis only | No load/concurrency benchmark; no hosted job access | No supported response-time/capacity claim |
| Deployed production schema and functional parity | U | Local generated baseline available | E13/DB | Local read-only only | Hosted attendance migrations/constraints not verified | Local findings require controlled migration/parity review |

### B1. Important end-to-end interpretations

**Shift resolution.** Employee editing writes raw `shift_start`, `shift_end`, `week_off_day`, `effective_from` into `employee_shifts`. Reads order by effective date and ID. The latest row whose start date is on/before the work date wins; there is no end date. A row with blank start reverts to the current global late cutoff, and blank off reverts to Sunday; it does not inherit the preceding row. The start is used for lateness, the off for calendars/payroll, and the end is not used for required hours or early departure. Designation changes use a different employee endpoint and do not automatically change these shift records.

**Off changes.** A Monday-to-Thursday permanent change can be represented by appending history. To approximate a temporary week, an operator would need a change plus a restoration row. That is not a roster or swap: there is no operation that checks and updates both the old Monday and new Thursday, prevents conflicts, limits the number of offs, obtains approval or ensures the change does not reach a closed period. Do not describe that workaround as supported rotating/date-wise off management.

**Calculation paths diverge.** Punch-in stores a status; punch-out stores elapsed hours and a hardcoded partial status. Self month view can reclassify present rows against current settings; the grid and aggregate report predominantly use stored status. Payroll recomputes using its own leave/off/late/hour rules. Leave takes precedence over attendance in payroll, while attendance wins in the month/grid view. A shared resolver/result service is needed so all screens and exports explain the same day.

**Import reuse.** The current CSV template is `Name,Phone,Email,Designation,Department,Join Date (YYYY-MM-DD),Salary`. It creates employees, rather than matching existing employee IDs and updating assignments. It supplies a basic preview and explicitly reports partial creation counts. It has no assignment codes or roster dates. Existing XLSX functionality elsewhere in HR concerns checklist templates, not either required attendance workflow. Reuse upload/download components and transaction support, not the employee-creation endpoint's semantics.

**History.** Future shift history is a useful partial solution. It does not version global rules, preserve a calculation's selected policy, prevent backdated inserts, protect approved leave edits, or lock attendance. A saved payroll row is not a complete closed attendance period.

### B2. Defect register — separate from missing capabilities

| ID / severity | Defect, evidence and confidence | Consequence |
|---|---|---|
| D01 / Critical | Global half-day clock ignores employee shift start. T09: assigned 11:00–21:00, punctual 11:00 and 10 hours → `half_day_late`, pay 0.5. `min_hours_full_day` has no calculator read; punch-out fixes cutoff at 4. E05/E07/E11, T15. | Wrong pay for normal salon shifts; advertised settings inconsistent. |
| D02 / Critical | Scheduled off is employee-specific initially, but sandwich and extra-work bonus explicitly test `Sun`. T12/T13: Tuesday-off worker gets +1 day-equivalent Sunday, no corresponding Tuesday bonus. E11 424–481. | Weekday-dependent pay unrelated to assigned off. Owner should decide the intended off-work benefit before correction. |
| D03 / High | Missing checkout with 0 hours is exempt from `hours > 0 && hours < minimum`, so receives full day (T10). Half-day leave unconditionally gives full paid day even without work (T11); payroll ignores that day's punches. E11 292–384. | Unresolved or partial attendance can be paid as complete. The existing half-day policy is explicit legacy behavior, but does not implement the requested partial-leave/work composition. |
| D04 / Critical | Shared attendance/employee/tracking/report reads and many writes lack record scopes; admins bypass permissions; approvers can act on self. E04/E06–E08/E12, T20. | Owner cannot restrict branch/team access or self-authorized changes. |
| D05 / High | `getUserPermissions` ORs all roles, while `requirePermission` reads one matching role row with no aggregation/order. T19 gives UI permission=1 but guard=403 with first role denied. E12. | Multi-role users have inconsistent/row-order-dependent authorization. |
| D06 / High | Punch-in SELECT then INSERT has no atomic uniqueness guard; local `(user_id,date)` index is nonunique. Punch-out checks then updates by ID without requiring an open session. E07/DB. | Simultaneous/retried requests can duplicate rows or overwrite checkout. Race risk proven structurally, not reproduced against a real database. |
| D07 / High | Punch day and self-today use UTC date; lateness/payroll/bulk marking use IST; browser dates use local time. Checkout selects current UTC date, not an open work session. E02/E06/E07/E11. | Early-morning and overnight attendance can be assigned to different dates or fail checkout. |
| D08 / High | Server photo is optional despite selfie-required UI. Unknown/coarse client accuracy permits remote punch: T06 allowed an unverified fix 111,195 m away. Frontend omits server's 300 m borderline buffer: T07 server allows at 445 m while UI algorithm says outside. Geofence UI says no sites allows anywhere, backend blocks. E02/E07/E09. | Capture evidence and user explanations disagree; a flag alone is not an approved exception. This does not prove GPS spoofing occurred. |
| D09 / High | `track_location=0` filters admin location lists; Layout, Attendance and POST tracking do not enforce opt-out. Two 30-second producers may run on the attendance page. E02/E07/E12/E14. | Opt-out is not a collection control; duplicate load and unexpected continuous tracking. |
| D10 / High | Bulk admin marking skips existing records/off/future days but not approved leave. Individual mark edit changes status without recomputing its 8/4/0 stored hours. E06 361–566. | Leave can acquire conflicting marks; stored hours/report totals stale. No actual backfill was submitted. |
| D11 / Critical | Attendance/delete, leave edit/delete and shift history writes ignore closed periods. Finalized list uses snapshot but detail recalculates; finalization upserts over prior snapshot. Unlock deletes all nondisbursed rows, while paid flag does not set `status=disbursed`. E04/E06/E08/E11. | Approved/paid history can diverge or disappear; period closing does not provide the promised protection. |
| D12 / High | Global mutable settings and backdated assignments change past live results (T16). Employee UI labels the last shift row current even if future. Geofence audit applies current active zones to old evidence. E03/E05/E07/E11. | Staff and reviewers can see history change without a controlled amendment or accurate effective-state display. |
| D13 / High | GET attendance dashboard calls auto-mark and inserts 8-hour present rows for allowlisted users. Payroll GET initializes settings and can persist employee-user links by name. E06 310–356; E11 27–35/195–209. | Merely reading pages writes business data; name matching can link the wrong person. These GETs were deliberately not executed. |
| D14 / Medium | CSV parser splits each line on commas, unlike the exporter which quotes values. No stable ID/reupload guard; bulk creates each row independently. E03/E04. | Export/reimport of quoted commas is not safe; reupload duplicates employees. Missing roster/assignment import is a separate capability gap. |
| D15 / High | Dashboard subtracts recorded presence from all active users without off/leave/employment bounds; leave count is request count. Report counts stored absent rows, not implicit missing workdays. Self month/grid/payroll use different precedence. E06/E07/E11. | Different totals for the same day/month; no trustworthy scoped staffing summary. |
| D16 / High | Monthly payroll list projection omits `salary_exempt` although calculator checks it; detail/finalize select all fields. Join date does not bound calculation (T14), and list excludes currently inactive/terminated staff even for historical months. E11 133/263/603/635/651. | Different list/detail/final salary and incomplete leaver/joiner history. |
| D17 / High, local confirmed | Local `leave_requests.days` is bigint; half-day API sends 0.5. Read-only `SELECT $1::bigint` with 0.5 fails PostgreSQL `22P02`. E08/E13/DB. Hosted column type not inspected. | Local half-day workflow is not ready for an end-to-end test. Do not infer the same schema defect exists in production without checking. |
| D18 / High | Settings/shift APIs lack range, time, date and cross-field validation; T03 parses `24:99` as 1539 minutes. Leave update can modify approved dates/type without resetting decision; request API lacks date-order/overlap checks. E04/E05/E08/E11. | Invalid policies and approved-request edits affect results without review. UI validation alone is insufficient. |

## C. Hardcoded-setting register

This register covers business decisions in the active attendance/shift/leave/payroll paths and capture UI. Configurable defaults are explicitly distinguished from fixed behavior. Technical conversion constants, image dimensions and generic transport-cache intervals are not business policies. Values in disabled legacy auto-punch code are listed separately so they are not presented as active rules.

| Setting | Current location | Current value/behaviour | Proposed configurable control | Historical-data considerations |
|---|---|---|---|---|
| Shift options | E03/E04 | Arbitrary raw employee start/end, no named list; not a fixed list of the five examples | Shift code/name master with any number of templates | Preserve raw legacy assignments when linking to versioned templates |
| Default off and number of offs | E03/E05/E06/E11 | Sunday/0 when unconfigured; single integer weekday | Explicit employee/branch default, no silent compulsory Sunday; repeating pattern and dated overrides | Store resolved roster/version; do not rewrite old implicit defaults blindly |
| Assignment duration/tie precedence | E04/E05 | Starts on effective-from; indefinite until replacement; latest ID wins same date | Start/end, precedence and conflict validation | Review duplicate effective dates and old backdating before migration |
| Blank shift/off meaning | E04/E05 | Blank start → global cutoff; blank off → Sunday, not retain prior value | Explicit inherit/clear/no-change semantics by form/import | Import preview must show resulting resolved rules |
| Shift lateness | E05/E07/E11 | Late after shift start, no per-shift grace; global fallback 09:46 | Shift start plus grace minutes and boundary rule | Version grace/cutoff; preserve approved calculations |
| Half-day arrival clock | E10/E11; default E13 | Global 10:00, editable now; independent of shift start | Per-shift relative lateness/partial-day rule | Existing results must not silently change on migration |
| Required hours | E07/E10/E11/E13 | Payroll uses min-hours-half-day default4; full-day field default8 unused; punch-out hardcodes4 | Separate net-work full/partial thresholds, explicit missing-checkout outcome | Recompute only authorized open periods with preview |
| Early departure | E05/E11 | Shift end unused; no grace or early-leave decision | Shift end/early-leave grace and approval policy | Record version and original times |
| Breaks/session limits | E07/E13 | One in/out row per date; no break deduction or session model | Paid/unpaid scheduled or recorded breaks; allowed sessions | Retain legacy pair as imported original session |
| Timezone/work-date boundary | E02/E06/E07/E11 | Fixed +05:30 in some code, UTC date elsewhere, browser-local display | Company/branch IANA timezone and work-date rule | Never reinterpret stored UTC evidence destructively |
| Late penalties | E10/E11/E13 | Editable 3 free late marks/month, 20 currency units/minute, lates-to-absent default0; both penalty models can apply | Versioned mutually compatible penalty policy; separate minute grace | Existing month totals remain tied to approved version |
| Paid weekly off | E10/E11 | Editable `sundays_paid` default1 applies to resolved off; wording says Sunday | Rename to scheduled-off pay rule, with migration mapping | Preserve setting meaning for existing employees |
| Sandwich deduction | E11 424–458 | Always-enabled algorithm; only Sunday, both adjacent in-month days unpaid | Owner-selected applicability, adjacency and month-boundary rules | Do not assume deduction is desired; preserve historical policy |
| Off-day work benefit | E11 461–481 | Sunday work adds worked pay fraction again (1 or0.5); no approval/config switch | Scheduled-off work approval and pay/comp-off options | Distinguish past paid bonuses from future policy |
| Holiday work | E06/E11 | Manual holiday mark; no holiday calendar/benefit rule | Branch holiday dates and approved holiday-work compensation | Snapshot calendar version and work-date classification |
| Full/partial pay fractions | E06/E11 | Present1, half/short0.5, absent0; admin hours8/4/0; auto-allowlist8 | Configurable status/pay mapping separate from measured hours | Manual status should not fabricate original work duration |
| Leave types | E02/E08 | New requests restricted to full_day/half_day; legacy types remain calculated/editable | Approved leave-type definitions and allowed employee categories | Retain old type codes and original decisions |
| Half-day and comp-off pay | E11 292–319 | Always full paid day, independently of actual remaining work | Segment-based paid leave/work composition and allowances | Owner policy decision; preview monetary changes |
| Leave allowances | E10/E11/E13 | Editable CL1, SL1, PL1.5/month; short-leave count2 stored but not enforced by calculator; allowances not full accrual policy | Versioned entitlement/accrual/carry-forward rules, partial units | Year/month balances need dated ledger, not mutable opening only |
| Short-leave exemption | E10/E11 | Editable skip-half-day flag default1; acts on existing short_leave records although new request form cannot create them | Type-specific approved time exemption | Preserve legacy requests; avoid broad all-day waiver |
| Overtime | E10/E11/E13 | Editable threshold9 and multiplier1; employee eligibility flag; no approval; not awarded in half-day branch | Versioned required-hours/OT threshold, approval and rounding/caps | Store approved extra time and rule; effective-date eligibility |
| Salary daily divisor | E10/E11 | UI says configurable26/30; normal calculator always actual calendar days; exempt path uses setting | Clearly selected divisor/calendar basis | Compare old/new pay; no silent retroactive change |
| Pay cycle | E11/E13 | `pay_cycle_start_day` stored/default1 and API-writable but calculator always calendar month; no current UI field | Actual cycle definition only after cycle-aware calculation | Migration of period keys/snapshots required |
| Earnings percentages | E10/E11/E13 | Editable56.5/22.6/5.9/15/0 for basic/conveyance/HRA/adhoc/misc; sum/range validation absent | Validated versioned component breakdown | Keep approved slip values/snapshot |
| Salary-exempt / CL / OT flags | E04/E10/E11/E13 | Mutable employee flags; exempt branch pays full monthly salary | Explicit authorized employee policy with effective dates | List/detail consistency first; preserve join/exit and past eligibility |
| Geofence radius | E02/E07/E09/E13 | Editable radius; fallback200 m duplicated in UI/server/schema; zero replaced by200 | Validated location/version radius and default | Punch retains location/radius/policy snapshot |
| Accuracy floor/ceiling/trust | E02/E09/E13 | Defaults50/3000/200 m; DB fields read by helper; **not in ERP settings UI or PUT allowlist**; frontend duplicates constants | ERP-managed accuracy policy returned to client | Store decision inputs and applied policy; DB editing is not business configurability |
| Borderline buffer | E09 | Extra300 m with `||300`; frontend has no matching rule | Validated business-approved tolerance, including meaningful zero | Preserve original decision, do not reevaluate old punches as original truth |
| Weak/missing accuracy action | E09 | Always allow unverified at any distance | Approved capture exception policy with evidence and decision queue | Flag remains attached; no conversion to confirmed absence automatically |
| No locations / zero coordinates | E07/E02 | No active zone blocks; UI says allow; truthy checks reject valid latitude/longitude0 on some routes | Explicit no-zone policy, numeric coordinate validation | Record which policy governed accepted events |
| Selfie / allowed punch method | E02/E07 | UI requires selfie, backend does not; GPS/browser route assumed | Server-enforced method/evidence policy | Avoid inventing photos for existing records |
| Reading freshness | E02/E07 | Punch acquisition max-age0, wait15s, good-accuracy40m; no server reading timestamp/age | Maximum accepted reading age and evidence retry/exception rules | Preserve capture and receive timestamps separately |
| Continuous tracking | E02/E14 | Two potential30s loops; global UI requests wake lock; page stops after checkout but Layout continues | Separate explicit feature/collection permission; retention and interval if owner actually needs it | Do not equate tracking opt-out with map hiding; define retention for old pings |
| Auto-mark allowlist | E06/E13 | `users.auto_mark_present`, GET dashboard creates present8h | Remove read side effects; if retained, explicit approved attendance exemption rule | Preserve provenance; never present synthetic marks as real punches |
| Self-approval/admin override | E06/E08/E12 | Admin bypass; approval by manager or global approver without subject exclusion | Owner grants scoped actions; maker/checker and audited emergency access | Record authority/policy used for every decision |
| Salary visibility | E04/E03 | Admin or department/role name containing `hr` | Explicit compensation-view permission separate from employee edits | Audit access-policy migration without exposing historical salary |
| Closed-period/reopening rules | E11 | Mutable marks allowed; snapshot overwrite; unlock deletes nondisbursed rows | Attendance and payroll period states, authorized amendments/reopen | Keep previous approved/paid versions, never delete payment history |
| Employment bounds | E06/E11 | Current active status filters and full elapsed month; join date not applied; no exit date | Effective employment interval | Preserve leavers in historical results |
| Money/hour rounding | E07/E11 | Elapsed hours and monetary outputs rounded2 decimals; whole late-count conversion | Defined rounding stage/precision where owner needs variation | Version calculation semantics to avoid penny/hour drift |
| Disabled auto-punch legacy rules | E08 1095–1157 | Uninvoked helper includes rolling5min and4/8h thresholds; UI still describes auto punches | Remove misleading descriptions or explicitly scope any future automation | Do not reactivate as part of ordinary settings work |

## D. Permissions matrix

All listed routes require authentication unless otherwise stated. That is not equivalent to action authorization or record scope. Current permission vocabulary is module `view/create/edit/delete/approve/see_all`; it has no company/branch/team relationship model. The table reports source enforcement, not completed adversarial end-to-end testing.

| Action | Existing restriction | Backend enforcement | Branch/team scope | Gap |
|---|---|---|---|---|
| View own attendance/history | Attendance page requires module view; self APIs | Self routes use token user | Own records | UI may deny self-service while API permits; no complete employee policy |
| View other attendance/grid/totals | UI see-all or admin; grid admin UI | List/report/dashboard require attendance.view; grid checks approve/admin | All rows; no matching see-all scope | UI hiding does not protect shared API data |
| View employees/shift history | Employee page module view | GET employees and shift history authenticate only | All employees | Missing backend employees.view/subject scope |
| Create/edit/deactivate shift templates | No feature | No route/permission | None | Separate owner-granted master actions needed |
| Assign shifts/manage weekly offs | Employee edit UI | employees.edit | Any employee ID | Coupled employee edit; no roster/assignment-specific scope |
| Manage date rosters/swaps | No feature | No route | None | Request/approve/apply actions missing |
| Upload assignment/roster Excel | No feature; generic employee bulk | employees.create on generic bulk | All created rows | Separate upload/validate permissions and target scope missing |
| Approve/apply bulk changes | No feature | No staged import state | None | Maker/checker and apply separation missing |
| Manage designation definitions | Free text/datalist | No designation master | None | Dedicated owner-controlled master permission missing |
| Change employee designation | Employee edit | employees.edit | Any employee | Should be separate from shift/compensation authority where required |
| Configure geofences | Admin-only tab | attendance.create/edit/delete | All locations | UI/backend grants differ; no location-specific permission/branch scope |
| Configure attendance/payroll rules | Admin payroll settings UI | `adminOnly` for settings; GET auth only | Global single row | Cannot delegate narrowly or restrict admin by owner policy |
| Punch in/out | Self screen | Authentication, token user; no attendance.create check | Own user; all active geofences | No capture entitlement/method/employee-location enforcement |
| Request attendance correction | Missing | Missing | None | Direct marks do not constitute employee request workflow |
| Approve/apply manual correction | Admin grid UI | attendance.approve or admin for manual marks | All users; self allowed | No distinct approve/apply, reason policy or closed guard |
| Delete attendance/original evidence | Delete controls | attendance.delete | Any ID | Hard deletion instead of controlled amendment |
| Request leave | Self form full/half | Auth only; user from token | Self | Eligibility/overlap/date validation incomplete |
| View leave queue | UI mostly see-all | attendance.view then admin/approve/see-all gets all; others own+direct reports | Partial team scope | Global approve implies all; manager UI loading not aligned |
| Approve leave | Admin/manager/approver | Admin OR direct manager OR attendance.approve | Manager direct reports or unrestricted approver | No self exclusion or pending-only transition policy |
| Edit/delete leave | Edit/delete controls | attendance.edit/delete | Any request | Approved edits keep decision; no scoped permission or period protection |
| Export attendance/payroll | Download buttons/client CSV | Underlying read route only | Inherits unscoped data | No independent export authority or server-controlled scoped export |
| Close attendance period | Missing | Missing | None | Payroll finalize is not attendance close |
| Finalize payroll | Payroll approve UI | payroll.approve | All active paid employees | No branch scope; repeated finalize overwrites |
| Reopen period/payroll | Admin unlock | `adminOnly`; deletes nondisbursed snapshots | Entire month | No separate owner grant, reason or retained prior version |
| View audit | Admin screen | `adminOnly` on audit router | All audit rows | Cannot delegate scoped audit review |
| View tracking | Admin location UI; attendance tracking routes | Admin for live map; attendance.view for per-user/date tracking | No branch/team restriction on attendance tracking endpoint | Sensitive evidence access broader than map UI |
| Disable tracking collection | User management toggle | Admin changes `users.track_location` | User filter only in location display APIs | Collection continues D09 |
| Manage permissions | Admin roles screen | `adminOnly` mutations | Global | No explicit owner/permission-management grant; admin cannot be restricted |

## E. Scenario results

“Verified in isolation” means the unchanged calculation/helper was executed with synthetic in-memory records. “Code only” means the behavior was traced but no corresponding user/API mutation was performed. Expected outcomes involving pay are requirements for consistency/control; detailed owner policy remains to be agreed, not assumed.

| Scenario | Expected outcome | Observed outcome or code evidence | Verified/unverified | Issue |
|---|---|---|---|---|
| Normal 09:00 shift, 9h work | Complete workday recognized | 3 Aug synthetic record → present/pay1 | T08, verified in isolation; punch flow unverified | Basic arithmetic reusable |
| Future shift change | Earlier date retains prior assignment | August row1; September row2 | T01, verified in isolation | Resolver works; write/history controls incomplete |
| Same-date assignment conflict | Reject or explicitly supersede with audit | Last sorted ID silently wins | T02, verified in isolation | Conflict handling missing |
| Unconfigured off / malformed time | Explicit default; invalid time rejected | No row→Sunday; `24:99`→1539 minutes | T03, verified in isolation | D18; compulsory fallback risk |
| Precise onsite GPS | Allow with verified evidence | At zone center, accuracy10→allow/verified | T04, verified in isolation | Real GPS/camera unverified |
| Precise distant GPS | Reject or route authorized exception | 111,195m away, accuracy10→blocked | T05, verified in isolation | Intended helper behavior |
| Unknown accuracy far away | Clearly flagged unresolved evidence with policy-controlled decision | Same distance, accuracy0→allow/unverified | T06, verified in isolation | No approval queue D08 |
| Borderline outside zone | UI/server agree on policy | At445m, radius200/accuracy10: server allows flagged due buffer; UI algorithm says outside | T07 verified server; UI source only | D08 |
| Assigned11:00 start, arrives11:00, works10h | On-time scheduled shift not globally late | `half_day_late`, pay0.5 | T09, verified in isolation | D01 |
| Missing checkout | Incomplete-session exception; controlled pay decision |09:00, hours0, no out→present/pay1 | T10, verified in isolation | D03 |
| Missing check-in | Exception, distinct from confirmed absence | No record→implicit absence in month/payroll; no correction request | Code only E06/E11 | Exception workflow missing |
| Half-day leave with no work | Apply approved half-day policy, evaluate remaining segment | Approved half-day→full paid day | T11, verified in isolation | D03; owner policy required |
| Half-day leave plus actual work | Combine segments without double counting; show same result everywhere | Payroll leaves override punches; calendar punches override leave | Code only E06/E11 | D03/D15 |
| Tuesday-off employee works Sunday | Ordinary work unless explicit special policy | Sunday bonus+1 day-equivalent | T12, verified in isolation | D02 |
| Tuesday-off employee works Tuesday | Apply configured scheduled-off work rule | Present, no off-work bonus | T13, verified in isolation | D02 |
| Sunday configured unpaid | Unworked Sunday unpaid | `sunday_unpaid`, pay0 | T18, verified in isolation | Setting does work for this case |
| Off changes Monday→Thursday | Review both dates and weekly off count | Repeating history can change; no swap object/paired update | Code only E04/E05 | Date roster/swap capability missing |
| Overnight22:00–06:00 | Checkout closes same assigned work session | Current-UTC-date lookup can lose previous day's punch | Code only E07 | D07; actual overnight execution unverified |
| Second session / split shift | Additional in/out pairs, net sum | Existing daily punch rejects second in; one pair only | Code only E07/DB | Sessions missing |
| Paid/unpaid breaks | Net hours use configured treatment | All elapsed time counted | Code only E07/E11 | Break model missing |
| Cross-branch/temporary location | Only assigned approved location/date accepted | All active geofences apply to everyone | Code only E07 | Entitlements/transfers missing |
| Holiday work | Calendar + approved work compensation | Manual holiday status only; no holiday policy | Code only E06/E11 | Calendar/holiday-work capability missing |
| Late and early departure | Shift-relative grace and end rule | Start used for lateness; end ignored; payroll global clock remains | T09/T16 + source | D01 |
| Extra hours awaiting approval | No payable approved OT until policy conditions met |11h with eligibility gives2h OT,222.22 at synthetic salary31000 | T17, verified in isolation | Approval capability missing |
| Joining15August | Pre-employment days excluded |3August labelled `absent_no_punch` | T14, verified in isolation | D16 |
| Leaving mid-month/historical report | Keep earlier employed dates and employee in historical output | Active-now filter; no exit-date boundary | Code only E11 | D16 |
| Change full-day minimum/divisor | Controls change the advertised calculation |5h still full with min-full8 vs12; divisor26 vs30 still1000/day | T15, verified in isolation | D01/configuration mismatch |
| Change future grace/cutoff | Published future rule does not alter approved history | Same old09:30 record changes present→late when current fallback changes09:46→09:00 | T16, verified in isolation | D12; no future policy publish model |
| Closed-period correction/detail | Reject ordinary edit or authorized versioned amendment; show snapshot consistently | Writes unguarded, detail live, repeated finalize overwrites, unlock deletes | Code only E04/E06/E08/E11 | D11 |
| Offline/retry/parallel punches | Persist pending event; deduplicate/reconcile | No offline queue; SELECT/INSERT race; no unique date key | Code + actual local indexes; concurrency unverified | D06 |
| Bulk month mark with approved leave | Preserve or explicitly review leave conflict | Bulk loads existing attendance and offs, not leaves | Code only E06 | D10 |
| Upload quoted CSV / same file twice | Correct parsing; known duplicate result | Comma splitting; employee creation repeated | Code only E03/E04 | D14; not a roster import |
| Multiple roles | Same effective permissions in UI and API | UI aggregation allows; single-row guard denies403 | T19, verified in isolation | D05 |
| Owner restricts administrator | Explicit grants remain enforceable | Admin delete passes without permission lookup | T20, verified in isolation | D04 |
| Approver requests own leave/correction | Prevent unauthorized self decision | No subject/requester exclusion | Code only E06/E08 | D04 |
| Tracking opt-out | Stop collecting when collection disabled | Flag applied to admin display, not sender/ingestion | Code only E02/E07/E14 | D09 |
| Half-day storage locally | Persist0.5 day without rounding/loss | Local bigint parameter cast fails22P02 | Read-only DB type/cast verified; request not submitted | D17; hosted type unknown |
| Mobile permission denial/device clock | Clear exception; server time protects receipt time | GPS/camera errors shown; GPS_OFF ping; server timestamps; no offline capture time or verified-device evidence | Code only E02/E07 | Real devices unverified; no exception workflow |
| Large export/many employees | Scoped/paged queries and bounded memory | Full arrays; sequential payroll reads; original photos in attendance rows | Code only E04/E06/E11 | No benchmark or capacity assertion |

### Performance and data observations

Attendance list SQL does filter user/date/status and has supporting local indexes. The month self endpoints are naturally date-bounded. This is useful existing work. Nevertheless, shared attendance lists have no page size, unrestricted date ranges can fetch many rows, `a.*` includes photo/evidence payloads, employees are fetched in full and filtered in the browser, and the grid loads all active employees plus their shift histories. Payroll iterates employees sequentially with repeated adjustment/attendance/leave/history queries. These are concrete query-shape risks; no latency or throughput was measured.

The local indexes inspected are **nonunique** on attendance `(user_id,date)` and employee shifts `(employee_id,effective_from)`. They speed lookup but do not stop duplicate punches or conflicting assignments. Employee `user_id` is also not unique. Payroll `(month,employee_id)` uniqueness prevents duplicate snapshots, but its upsert intentionally overwrites them. There can be no appropriate branch/date composite index until the branch relationship exists. Audit browsing already uses server pagination and can serve as a pattern for attendance APIs.

Before sizing a production rollout, agree target branches, employees, history years, punch/photo size, simultaneous shift-start users and export size. Use synthetic data to test those targets, query plans and p95 response/queue times. Proposed future tests must cover retry/idempotency and locking, not just successful single requests. No benchmark numbers are inferred here.

## F. Prioritized implementation backlog

Effort is relative, not a delivery commitment: **S** = narrow change in an established flow; **M** = several coordinated UI/API/data changes; **L** = new workflow or major cross-cutting work; **XL** = multiple workflows plus migration and concurrency testing. Estimates assume the existing React/Supabase/PostgreSQL architecture, one agreed attendance-policy vocabulary, access to a staging environment and sanitized production schema metadata. New payroll-provider integrations, biometric hardware and statutory advice are outside these estimates.

### 1. Required before the first attendance release

**AT-01 — Establish a trustworthy assessment/staging baseline. Effort M.**

- Change/why: reconcile deployed attendance schema with version-controlled migrations; resolve local fractional leave storage; establish reusable synthetic fixtures and acceptance tests. Prevent local-only schema assumptions from being deployed.
- Reuse: existing local Supabase setup, schema generator, shift/geofence helpers and audit harness observations.
- Frontend/backend/database: no feature UI initially; test actual mounted APIs; add reviewed incremental migrations only after authorization, using a decimal day unit where required.
- Dependencies: read-only hosted metadata access and owner confirmation of first-release scope, timezone, partial-day/off/OT rules.
- Compatibility: preserve records/IDs; review duplicate attendance, employee-login links and old leave units before constraints. Never deploy the generated local baseline to production.
- Acceptance: local/staging schema parity for relevant tables documented; half-day storage works; synthetic complete UI/API/database scenarios run without live services; existing working flows retained.

**AT-02 — Enforce owner-controlled actions and scopes. Effort L.**

- Change/why: unify multiple-role aggregation; separate attendance actions from employee CRUD; implement employee/team/branch/company predicates, export scope and maker/checker checks; remove unconditional operational admin bypass in favor of explicit grants.
- Reuse: roles/user_roles/role_permissions, auth middleware and employee manager relationships.
- Frontend/backend/database: permission editor/scoped selectors; one effective-permission/scoping service applied to every route and totals; grants plus scope relationships and clear canonical manager model.
- Dependencies: AT-01; define owner authority and minimal branch/team organization. Use explicit single-branch membership for an initially limited pilot.
- Compatibility: map existing grants into a reviewed permission migration; preserve authorized owner recovery with auditable explicit authority; do not silently expand every administrator's grants.
- Acceptance: direct API and export tests deny unrelated employees/branches; UI and API agree for multi-role users; self-approval denied; row totals respect the same predicates.

**AT-03 — Secure capture and work-session integrity. Effort L.**

- Change/why: use one timezone/work-date rule and session identity; atomic/idempotent punches; enforce required evidence; distinguish missing checkout/GPS failures from approved attendance; make dashboard/read endpoints side-effect-free.
- Reuse: punch UI, shared geofence evaluator, attendance queries and PostgreSQL transactions.
- Frontend/backend/database: show open/pending/failed state; shared event validation and receipt/capture time handling; event/session IDs, appropriate unique/conditional constraints. Remove automatic name-link mutation from payroll reads and route linkage through explicit authorized employee maintenance.
- Dependencies: AT-01/02; agreed same-day/overnight pilot scope. Either support overnight safely or explicitly reject unsupported assignments until AT-09.
- Compatibility: retain original punches/photos; investigate duplicates before deduplication; import legacy daily pairs with provenance; keep legacy read responses during transition where needed.
- Acceptance: repeated event returns same result, parallel punches cannot duplicate/overwrite, early-morning/overnight boundaries are tested, no GET writes attendance/settings/linkage, missing checkout produces an exception rather than automatic full-day approval.

**AT-04 — Unify day calculation and fix incorrect outcomes. Effort L.**

- Change/why: share one date result across punch status, self month, grid, report and payroll; use assigned shift/off; honor validated thresholds; combine approved partial leave/work; apply employment intervals and approved OT.
- Reuse: date-effective shift resolver, payroll day breakdown and existing settings UI.
- Frontend/backend/database: display policy explanation; shared evaluator with validated inputs; result/provenance records and effective employment bounds. Fix salary-exempt list/detail projection mismatch and manual-hours reporting.
- Dependencies: AT-01/03 and owner approval of sandwich/off-work/partial-leave pay semantics; integrate AT-05 version IDs.
- Compatibility: preserve existing finalized pay; compare proposed versus previous results before applying to open periods; map renamed off settings without changing historical Sunday payments silently.
- Acceptance: T09–T16 failure cases meet approved expected rules; all views/export agree; no special Sunday branch unless owner explicitly publishes one; no pre-join/post-exit absences; missing work does not silently count as complete.

**AT-05 — Preserve evidence, policies and closed periods. Effort XL.**

- Change/why: separate immutable events, correction requests/decisions and derived results; introduce versioned effective rules and attendance period close/reopen; enforce locks on every affected mutation.
- Reuse: employee shift history, audit UI, payroll_runs and transactions.
- Frontend/backend/database: correction request/approval/apply and close/reopen screens; centralized period guards and snapshot reads; policy versions, corrections, period states, retained result/snapshot revisions with actor/reason. Replace attendance hard delete with controlled void/amendment.
- Dependencies: AT-02/03; shared result contract AT-04. Introduce schema incrementally before wiring all screens.
- Compatibility: mark legacy provenance explicitly where unknown; keep old approved/paid snapshots; reopening creates an auditable version, not deletion; fix paid-vs-disbursed mismatch. Existing finalized rows must remain readable.
- Acceptance: closed-period shift/leave/import/punch correction blocked unless authorized amendment; finalized list/detail/export match; repeat finalize cannot overwrite without controlled transition; new-month settings never change approved prior results; self decisions rejected.

**AT-06 — Correct location entitlement and exception behavior. Effort M–L.**

- Change/why: validate coordinates/accuracy; distinguish permitted punch locations from continuous tracking; enforce method requirements and weak-GPS exception decisions; make UI/server rules agree.
- Reuse: geofence CRUD, evaluator, accuracy columns and mobile capture UI.
- Frontend/backend/database: permitted-location/exception explanation and policy controls; employee/location/date checks and reading-age validation; effective entitlements and location-policy snapshot. Honor tracking opt-out at collection/ingestion, and eliminate duplicate polling if tracking is retained.
- Dependencies: AT-02/03/05; minimal branch identity. Continuous tracking remains a separate owner decision, not a prerequisite for attendance.
- Compatibility: migrate existing sites without reinterpreting old coordinates; label historical verification status honestly; deactivate referenced zones instead of destroying evidence.
- Acceptance: unauthorized branch zone rejected/exception-routed; stale or weak reading has visible unresolved status; no-site behavior is consistent; photo requirement enforced in API; opted-out tracking is not collected.

**AT-07 — Make release reports and APIs bounded and consistent. Effort M.**

- Change/why: server pagination/search/sorting, scoped totals and projected list fields; server-controlled exports from shared results; trustworthy employee/manager exception views.
- Reuse: audit pagination pattern, CSV components, date filters, existing indexes and grid components.
- Frontend/backend/database: page/filter controls and simple employee punch card; paged list/summary/export APIs; reviewed indexes after scopes/work-date model exist. Avoid loading photos in summary rows.
- Dependencies: AT-02/04/05; server export job can be synchronous only within an explicit safe limit.
- Compatibility: maintain current download column meanings or publish a versioned export; provide detail evidence on demand to authorized users.
- Acceptance: rows/totals/export agree for scope and period; no full-table client filtering for principal lists; realistic synthetic-volume and simultaneous-punch tests meet agreed targets; employee/manager/HR/owner acceptance scenarios pass.

### 2. Required for complete configurable attendance

**AT-08 — Versioned shift templates and controlled organization masters. Effort L.**

- Change/why: create unlimited shift code/name templates with start/end, overnight flag, break/required hours, grace/early departure/full/partial/OT rules, active status and effective versions; add stable branch/designation/department definitions.
- Reuse: Employees shift editor/history, payroll controls, geofence master and permissions foundation.
- Frontend/backend/database: template/master maintenance and reference selectors; validated template-version APIs; stable master IDs/codes and published policy versions with branch/timezone references.
- Dependencies: AT-02/04/05; explicit owner rules and AT-09 session support for overnight/break policies.
- Compatibility: retain free-text values during mapping review; never silently create master records from upload spelling; preserve existing employee shift times as legacy versions; designation changes remain independent.
- Acceptance: authorized user can create all five example shifts and additional arbitrary shifts without deployment; reuse one template across employees; deactivate without losing references; future changes preserve historical results.

**AT-09 — Sessions, breaks and complete shift semantics. Effort L.**

- Change/why: support overnight/split sessions and paid/unpaid breaks, required net hours, early departure and approved extra hours.
- Reuse: event/session foundation AT-03 and shared evaluator AT-04.
- Frontend/backend/database: minimal employee break/second-session controls where permitted; segment validation/overlap reconciliation; session/break/extra-hours records tied to work date and shift version.
- Dependencies: AT-05/08 and owner decisions on break capture versus scheduled deductions.
- Compatibility: legacy single pairs remain valid; do not fabricate historical breaks; explicitly record unknown legacy deductions.
- Acceptance: 22:00–06:00 belongs to one work date; split-shift overlaps rejected; unpaid break reduces net hours while paid break follows policy; raw events remain unchanged; only authorized extra hours become payable.

**AT-10 — Effective assignments, date rosters and weekly-off swaps. Effort XL.**

- Change/why: default from/to assignments, future/permanent/temporary overrides, repeating/rotating patterns, multiple offs, cross-branch transfers and atomic approved swaps.
- Reuse: employee shift history, date resolver, manager links, grids and location entitlements.
- Frontend/backend/database: roster calendar/diff and swap approval; explicit precedence and conflict detection; assignment intervals, date roster versions, pattern cycles and swap old/new date linkage.
- Dependencies: AT-02/05/08/09; agreed company→branch→team→employee precedence with date overrides explicit, not inferred.
- Compatibility: translate current one-weekday rows to baseline repeating patterns, retaining historical effective dates; review same-date conflicts; blank end means indefinite until valid supersession and must be shown in preview.
- Acceptance: Monday-this-week/Thursday-next and multiple offs work; moved old date becomes working when intended; both dates updated atomically; overlapping work/off or shift segments rejected; closed dates protected; designation change cannot alter assignment implicitly.

**AT-11 — Controlled Excel assignment and roster imports. Effort XL.**

- Change/why: implement both requested workflows with stable IDs/codes, validated dates, previous/proposed preview, role/branch scope, configurable approval and auditable apply.
- Reuse: existing upload/template/download UI patterns, XLSX handling elsewhere in HR, transactions and permissions. Keep employee creation separate.
- Frontend/backend/database: two documented XLSX templates and preview/result downloads; validate→stage→approve→apply APIs; durable import jobs/rows, file idempotency and resulting assignment/roster revision IDs.
- Dependencies: AT-02/05/08/10; define blank/no-change/clear/error semantics per column and blank-end behavior in template instructions.
- Compatibility: leave legacy employee-create CSV available with corrected parser and clear label; no silent master creation; support preview-only revalidation when target records change after upload.
- Acceptance: exact workflow A and B columns or documented equivalents accepted; unknown codes/duplicates/overlaps reported per row; unauthorized targets rejected server-side; approval by different authorized actor where configured; transactional apply or explicit authorized partial strategy; repeat file cannot duplicate changes; downloadable results and controlled reversal preserve history/period locks.

**AT-12 — Leave, holidays and complete policy publishing. Effort L–XL.**

- Change/why: branch holidays, segment-aware leave, owner-defined entitlement rules, policy draft/publish conflicts and impact preview; controlled historical recalculation and off/holiday-work compensation.
- Reuse: leave requests/approvals, settings controls, shared results and policy/period foundation.
- Frontend/backend/database: calendar/leave-type/policy editor and impact comparison; precedence validation/publish and scoped recalculation; holiday calendars, entitlement ledger and policy-result linkage.
- Dependencies: AT-04/05/08/10; policy decisions on paid off, sandwich, comp-off, leave accrual and rounding.
- Compatibility: preserve approved old leaves/payments; do not reset approval silently; reopen/amend through AT-05 when an approved request changes; migrate opening balances with provenance.
- Acceptance: holiday work, half-day leave+work, multiple/rotating offs and policy boundary scenarios agree across attendance/payroll; unpublished rules never apply; changes show affected employees/dates/pay deltas before publication.

**AT-13 — Notifications, exception operations and retry-safe jobs. Effort M–L.**

- Change/why: replace active leave stubs with actual scoped notification events; manager exception/pending queues; safe scheduled reminders, recalculation and large export jobs.
- Reuse: existing notification/push infrastructure, audit viewer and existing HR job patterns after verifying active hosting support.
- Frontend/backend/database: delivery/status views and manager queues; transactional outbox, deduplicated workers/retries and failure visibility; job/event keys, attempts and retention.
- Dependencies: AT-02/05/07/10–12 as relevant. A manual in-app exception queue from AT-05/07 is required before first release; external messaging automation can follow.
- Compatibility: no retroactive notification flood; explicit cutover cursor and event ownership; do not activate old auto-punch helper accidentally.
- Acceptance: repeated event/job delivers/applies once logically; crashes recover; retries cannot duplicate roster/results; failed notifications visible without rolling back attendance; scoped recipients only.

### 3. Optional enhancements or external integrations

**AT-14 — Offline mobile capture and trusted device integrations. Effort L–XL.**

- Change/why: optional durable offline queue and kiosk/biometric/provider adapters if operationally required; replay and suspicious-device evidence review.
- Reuse: idempotent events, approved exceptions, capture UI and session model.
- Frontend/backend/database: pending-sync display/device enrollment; signed/enrolled-device adapter validation and delayed-event reconciliation; device/event receipt/evidence records with retention policy.
- Dependencies: AT-03/05/06/09, owner selection of supported methods and offline time limits.
- Compatibility: do not treat client device time or GPS alone as trusted truth; retain capture and receipt timestamps and require review where needed; online punching continues to work.
- Acceptance: network loss preserves event; repeated sync applies once; stale/clock-skew/closed-period submission is reviewed rather than silently inserted; each external integration tested in its sandbox.
- Scope note: basic duplicate handling and clear online failure/exception behavior are mandatory in AT-03. If offline attendance is essential for the first salon pilot, move this item into the first-release scope.

**AT-15 — Advanced staffing views and external payroll export adapters. Effort M–L per integration.**

- Change/why: optional coverage forecasts, richer cross-branch staffing analytics or provider-specific payroll exports after attendance becomes trustworthy.
- Reuse: scoped roster/result APIs, approved snapshots and export jobs.
- Frontend/backend/database: owner coverage dashboards and mapping UI; versioned integration adapters/reconciliation; integration job IDs and export checksums where needed.
- Dependencies: AT-07/10/12/13 and named provider format/access.
- Compatibility: existing CSV remains available; exported approved-period snapshot recorded; corrections create adjustment exports rather than overwriting history.
- Acceptance: permitted-branch totals reconcile to approved day results; repeat export is identifiable; provider acknowledgment/error rows are auditable. Continuous tracking is not assumed or added by this item.

## G. Recommended implementation order

Each stage should be a separate review with its own migration, compatibility notes and acceptance evidence. The backlog items are larger outcomes; they should not be merged as one broad change.

1. **Baseline and policy decisions:** AT-01; document active schema, synthetic fixtures, employee/login duplicates and owner decisions. Resolve the local half-day schema mismatch in a separately authorized change. No operational rollout yet.
2. **Authorization first:** split AT-02 into permission aggregation, explicit actions and scoped query/write predicates. Prove negative API tests for employee/manager/HR/owner and multi-role users.
3. **Read safety and capture integrity:** remove GET mutations; implement explicit identity linking; add event idempotency/conditional updates and consistent work dates from AT-03. Preserve legacy display contracts while introducing new internal records.
4. **History foundation:** add policy versions, evidence/correction records and period guards from AT-05 before introducing more mutable settings. Make saved payroll detail/export consistently read the approved snapshot and preserve paid history on reopen.
5. **Calculation correction:** AT-04 with AT-06; resolve late/off/partial leave/missing checkout/joiner cases against owner-approved expectations. Compare old/new open-period results and surface exceptions, not silent historical rewrites.
6. **First-release operations and pilot gate:** AT-07 plus mandatory in-app correction/approval views. Run full synthetic UI/API/database, scope, concurrency and realistic-volume tests. Only then conduct a constrained salon pilot with explicit supported shifts/locations and reviewed payroll reconciliation. It is not yet the complete requested configurable release.
7. **Templates and organization masters:** AT-08, then session/break semantics AT-09. Review migration from raw employee times and free-text designations separately from UI rollout.
8. **Rosters and offs:** introduce AT-10 in slices—bounded defaults, date overrides, patterns, paired swaps and cross-branch work—with conflict/history tests at each slice.
9. **Imports:** AT-11 first as validate/preview/download-errors, then approval/apply/idempotency, then controlled reversal. Do not add direct upload-to-update shortcuts.
10. **Complete policy/calendar and operations:** AT-12 and AT-13, followed only by explicitly selected optional AT-14/15 capabilities. Re-run cross-screen/payroll reconciliation at each policy expansion.

A first release must not advertise unsupported overnight, split, roster import or rotating-off workflows. If those capabilities are required for the actual pilot employees, stages 7–9 become pilot prerequisites rather than later enhancements.

## H. Direct conclusions

**1. What is already done?** Employee records and separate shift history; one employee-specific off weekday with effective-from; browser punch/geofence/selfie screens; leave/manual marking; grids/reports/CSV; module permissions; payroll rules and saved monthly rows. The date resolver, basic geofence logic and selected arithmetic were exercised safely in isolation. Most complete saved workflows remain code-present or partial, not functionally certified.

**2. What remains?** Correct the listed defects; enforce scoped permissions and self-approval rules; protect events/closed periods; unify calculations; implement template masters, complete sessions/breaks, rosters/off swaps, approved exceptions, branch entitlements, both Excel import workflows and effective policy publishing. Then verify real UI/API/database behavior and devices in a safe test environment.

**3. Which settings can change without code today?** Through the existing ERP: employee raw shift start/end, one off weekday and effective-from; free-text designation/department and reporting managers; geofence name/coordinates/radius/active flag; module permission flags; global late and half-day clocks, payroll's used minimum-hour field, free late marks/per-minute penalties, lates-to-absence conversion, paid-off toggle, CL/SL/PL allowance amounts, short-leave exemption, OT hours/multiplier, salary component percentages and employee CL/OT eligibility. These controls exist in source; write flows were not exercised in this audit. Several have inconsistent downstream behavior, so changing them is not proof of correctness or historical safety.

**4. Which need development?** Named reusable/versioned shifts; end dates/temporary/rotating/split assignments; multiple/date-wise offs and swaps; branch-scoped permissions/locations; per-shift grace/early departure/break/net-hour rules; approved OT/corrections; both controlled Excel imports; policy previews/closed attendance periods; genuine offline sync. Geo accuracy tolerances are database fields without ERP controls, so they are not currently business-manageable. `min_hours_full_day`, `pay_cycle_start_day`, `short_leave_per_month` and the normal-pay divisor control require wiring/correction before being described as effective configuration. Fixing current defects also requires development, even where an existing settings field can be edited.

**5. What should be implemented first?** Approve a small foundation scope covering **AT-01/02 and the read-safety/capture safeguards in AT-03**, followed by the history/calculation work in AT-04/05. This addresses incorrect pay, unauthorized changes and damaged history before expanding bulk configuration. Do not begin with a large Excel upload feature against the current unprotected assignment model.

**Assessment ends here. No fixes have been implemented. Implementation remains pending your review and authorization of the scope.**
