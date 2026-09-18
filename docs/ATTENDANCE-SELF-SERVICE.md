# Staff attendance self-service

Local follow-up requested on 17 September 2026. No production deployment or production migration was performed.

Every existing active, nonarchived ERP login received the explicit **Employee attendance self-service** role through migration `20260917000200_attendance_self_service.sql`. New staff logins created through owner registration or bulk account creation also receive it. This role grants only:

- `attendance.view`, scope **self**: personal attendance and leave records.
- `attendance_capture.view` and `attendance_capture.create`, scope **self**: punch setup information and own punch-in/out.

Other roles may explicitly add team/branch visibility or management actions. The owner can edit or remove the default role in Roles & Permissions / Users. Login and GET requests do not restore revoked permissions or assign roles. Reactivated older accounts that were inactive at migration time need an explicit role assignment. Leave application, approvals, corrections, employee administration, payroll and location maintenance are not granted by this new role.

## Staff flow

1. Sign in using the employee's own login.
   Staff without dashboard permission land directly on Attendance.
2. Choose **My Attendance** from the account/profile menu, or Attendance in the sidebar.
3. Capture a selfie and location, then Punch In; capture a fresh selfie/location for Punch Out.
4. Use **My History** for date-range records and **Leaves** for permitted leave records. Management tabs appear only with their corresponding permissions.

The owner must first explicitly link the login to exactly one employee using Employees, and configure attendance locations and any supported same-day shift. Missing/ambiguous links show a setup message and disable punch submission. The system never guesses identity by name or creates an employee as a side effect of viewing a page.

`GET /attendance/my-capture-context` returns the employee's linkage readiness and the active punch locations already accepted by the capture handler. It requires self-scoped capture view permission and performs no writes. This separates the employee punch screen from the location-maintenance API; staff do not need geofence management permission to punch. Location-maintenance data and action flags remain separate in the UI. Existing any-active-zone eligibility is unchanged; branch-specific punch eligibility remains pending AT-06.

## Validation and rollout

The local integration suite covers default account grants, missing-link rejection, explicit linking, successful own punch-in/out, personal history, cross-user denial, blocked management actions, and owner revocation surviving subsequent login/GET. Browser checks cover personal tabs and the profile menu shortcut. The tests retain synthetic accounts and events locally.

Run `node scripts/attendance/self-service.test.cjs` after the foundation fixture suite, then `node scripts/attendance/self-service-browser.test.cjs` while the local frontend is running. The focused API run passed all four checks. Results are retained in `.local/attendance-self-service-results.json` and `.local/attendance-self-service-browser-results.json`. Expanded foundation reruns were interrupted by the local Edge CPU limit (HTTP 546); they are not reported as new full-suite passes. The focused new workflow is tested independently of that limit. The earlier 35-test foundation result remains the baseline, not a claim that the expanded run completed.

For an authorized future rollout, apply the foundation migration first, then this migration, then the matching Edge API and frontend. Do not rerun this migration to fix a login: it is an initial assignment, and rerunning it could restore deliberately revoked memberships. To reverse permission assignment, review and remove role memberships; do not delete attendance events or historical records. If the default role name already exists in a target database, inspect its permissions before migration; existing role/permission rows are preserved by conflict handling.

## Still pending

- AT-05: closed/paid period protection, controlled corrections and amendments, immutable payroll snapshots and historical policy/shift versions.
- AT-04: shift-relative lateness, missing checkout, half-day leave/work composition, correct weekly-off handling, joiner/leaver rules and consistent totals/pay calculations.
- AT-06: agreed weak-GPS/exception behavior, branch-specific punch eligibility and physical device validation.
- Later stages: overnight/split/multiple sessions, rotating rosters, weekly-off swaps and roster/assignment imports.

These changes enable personal self-service; they do not make salary calculations or historical payroll behavior production-ready. The earlier authorized foundation and its limits remain documented in [the implementation report](ATTENDANCE-FOUNDATION-IMPLEMENTATION.md).
