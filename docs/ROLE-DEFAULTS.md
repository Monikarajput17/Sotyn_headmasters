# Local shared-role defaults — 18 September 2026

These defaults were reviewed and applied to the **local database only**. They
are saved role permissions, so the existing Roles & Permissions screen shows
the ticks and owners can change them. They are not re-applied at login/startup.
Custom roles and isolated authorization-test roles were not reset.

Dashboard access was subsequently expanded to every role through migration
`20260918000300_role_dashboards.sql`. See `docs/ROLE-DASHBOARDS.md`: staff now
receive their own dashboard, while restricted financial data stays unavailable.
References below to no financial dashboard mean no salon-wide monthly reporting;
front-desk/cashier users may see daily bill summaries already allowed by Billing.

| Shared role | Default access |
|---|---|
| Admin | All salon modules, staff, payroll, attendance and workflow configuration. Permission management still requires explicit owner nomination. |
| Salon Manager | Shared salon calendar, clients, catalogs, memberships, billing creation, commissions and business dashboard. Own punch in/out; attendance, leave/correction-request approval, staff viewing and workflow management for self/direct reports. No payroll, salary visibility, user/role administration, period reopening, tracking, manual attendance rewrites or default deletion. |
| Receptionist | Create/update bookings and client records; create bills; read service/product/stylist/membership catalogs; employee self-service. No financial dashboard, commissions or payroll. |
| Cashier | Create bills and client records; read booking/client/catalog information; employee self-service. No bill deletion, POS configuration, financial dashboard or payroll. |
| Stylist | Read own employee-linked appointments and commissions; service catalog; employee self-service. No other stylist's records, client directory or business dashboard. |
| Viewer | Read service catalog and own attendance/tasks/checklists/tickets. No writes or financial/staff-wide access. |
| Employee work self-service | Own attendance/history, punch in/out, correction requests, task/checklist progress and submissions, ticket creation/replies, service catalog. No approvals, work assignment, other employees' records or administration. |
| Employee attendance self-service | Own attendance/history, punch in/out and correction requests only. |
| Attendance foundation owner | Explicit specialist role for attendance settings, staff and payroll across all records. |
| Workflows owner | Explicit specialist role for all tasks/checklists/tickets and workflow settings/jobs. |

Staff roles have no default Delete permission. Permissions from multiple roles
are additive; Viewer does not cancel a separate write-granting role. New Viewer
accounts do not automatically receive the employee write baseline. New staff
accounts/imports receive the shared attendance/work baseline at creation only.
An owner can remove or modify those grants afterward without login restoring them.

The regular Salon Manager role uses **team** scope for staff/attendance/work,
following `reporting_manager_id_1` and `_2`; it does not assume every employee
in the same branch reports to that manager. Team tickets include tickets raised
by direct reports even before assignment. Branch-wide access can be configured
by the owner using a shared branch role with its allowed branch IDs.

Salon bookings, clients, POS and catalogs are shared salon resources. Their
front-desk/manager defaults explicitly use all-record access; these permissions
do **not** promise branch isolation. Stylist appointment/commission reads now
enforce their employee link on lists, filters and direct URLs. An unlinked stylist
sees no personal appointment/commission records. Booking mutations require an
all-scope action grant. Dashboard statistics require the separate Dashboard grant.

Payroll and confidential salary fields remain inaccessible to the manager default.
Receptionist/Cashier membership access is read-only because the existing Create
permission also creates pricing plans; selling memberships separately needs a
separate action before it can safely be delegated without plan authoring.

The obsolete construction-module permissions on these named shared roles were
cleared. The Viewer role previously had extremely broad read access; it is now
a conservative viewer, not an organization-wide financial auditor.

## Local setup and review

`node scripts/roles/apply-local.cjs` applies the checked-in policy from
`scripts/roles/defaults.cjs`. It verifies the local database marker, uses a
transaction and saves a before-image of roles/permissions/assignments under
`.local/role-defaults-before-*.json`. It intentionally has no remote URL option.
Re-running it resets these defaults; use the owner screen for subsequent edits.

The documented manager demo account now uses the shared Salon Manager role;
its old synthetic role was unassigned. Employee demo accounts retain the shared
Employee work self-service role. Ordinary active linked local employees receive
that baseline; isolated synthetic authorization fixtures remain unchanged.

Use `.local/ROLE-DEMO.md` for employee, manager, receptionist, cashier, stylist,
viewer and admin logins. The role verification script creates synthetic salon
records for isolation checks, retained locally for inspection.

In My work, managers can switch **Show → All permitted work**. Personal cards
still show only personally assigned work. The attendance shortcut leads to
punch/history. Ticket card links now use the correct Help Tickets route.

## Validation

Run `node scripts/roles/verify-local.cjs` for saved-default consistency, new
account defaults, positive and denied API access, staff/salary isolation,
unassigned team-ticket visibility, stylist ownership and shared booking creation.
Results are saved in `.local/role-verification.json`.

Latest role checks: all **8 API/database checks passed**, and all **7 browser
checks passed** (six staff/viewer menus plus the admin role editor's saved ticks).
The browser run recorded no runtime exceptions or API server errors. The frontend
build, API bundle, diff whitespace check and both environment-isolation tests
passed. Browser selectors and a test priority assumption were corrected during
verification; the complete role checks were rerun successfully.

An additional two-session mobile workflow regression did **not** pass: the local
Supabase runtime logged `InvalidWorkerCreation: worker did not respond in time`,
including a chat unread-count HTTP 503, and an employee task reload exceeded the
test timeout after the manager returned the task. The task remained correctly
assigned to the employee in the database. The local API was restarted afterward.
This is a separate local runtime reliability limitation; the earlier seven role
browser checks passed, but this run is not evidence of error-free mobile operation.
After restart, both employee and manager work-list requests returned HTTP 200
with five permitted tasks each (approximately 4 and 7 seconds respectively).

Browser verification and the frontend build are checked separately. Phone
camera/GPS operation and production deployment are outside this role-default
verification. Attendance permissions do not bypass configured location, shift,
employee-link, evidence or closed-period rules.

No production permission changes or migrations were applied. Deployment must
include a separately reviewed production role configuration; pushing frontend
code alone does not copy the local database's permission ticks.
