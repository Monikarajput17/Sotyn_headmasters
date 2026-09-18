# Role dashboards

Every existing role now has Dashboard View. The home page `/` is the dashboard
after login instead of redirecting employees to attendance. New custom roles
also start with Dashboard View; they receive no other grants automatically from
role creation. An owner may subsequently revoke Dashboard View.

The authenticated `GET /dashboard` endpoint builds one response from current
role grants. Opening Dashboard does not create tasks, checklist occurrences,
attendance records or notifications. It does not accept another user's identity
or a scope override. No result is cached across users.

| Role | Main dashboard information |
|---|---|
| Employee | Own punch status, unfinished tasks, today's checklists, overdue work and tickets |
| Manager | Permitted team work, review queues, attendance requests, staff count, bookings, paid sales and monthly revenue |
| Receptionist | Today's bookings, upcoming appointments, paid bills/sales, clients, stock and own work |
| Cashier | Today's paid bills/sales, booking/client information, stock and own work |
| Stylist | Own linked appointments and commission, attendance and assigned work |
| Viewer | Read-only service catalog and own permitted attendance/work |
| Admin | Authorized operational, staff, financial and review summaries |
| Specialist owner roles | Only summaries and shortcuts for their granted attendance/payroll or workflow modules |

Cards are selected by permissions, not by a hard-coded role name, so combined
roles/custom scopes work too. Team/branch/self restrictions use the same backend
scope helpers as the detail pages. Reviews additionally require Approve and
exclude the user's own submissions. Employee/stylist/viewer payloads do not
contain hidden salon sales or other employees' records.

Dashboard View alone grants **no source data access**. Monthly revenue requires
all-scope Dashboard View plus all-scope Billing View. Front-desk/cashier daily
billing figures are allowed by their existing shared Billing View. The legacy
salon-wide statistics endpoint now requires all its source-module grants, too.

## Navigation

- Task/checklist/ticket cards open the matching active, overdue or review filter.
  Queue rows open the specific record. Dashboard filters have a clear control.
- Attendance opens the punch/history page; attendance approvals open Requests.
- Appointment cards open the correct day. Upcoming records are highlighted on
  that day's appointment list.
- Paid bills/revenue open a new paginated, read-only invoice history with the
  matching date range. An invoice opens its line details. Billing dates use
  India time consistently in counts and this detail list.
- Commissions open the matching month; filters use the same India-time dates.
- Low-stock cards open the filtered product list; service/client/staff cards
  open the corresponding permitted modules.

One summary request replaces the dashboard's separate financial/work requests.
Loading, empty and failed states are distinct; a failed load does not display
misleading zero totals. Refresh and retry are available. Returning to the browser
after a minute refreshes the view. This is not continuous real-time reporting.

## Local validation and deployment

`scripts/roles/dashboard.test.cjs` checks all seven demo roles, every existing
role's Dashboard View, denied anonymous access, forged identity/scope parameters,
source/detail count agreement, review filters and stylist ownership.
`scripts/roles/dashboard-browser.cjs` checks role landing, mobile layout, detail
navigation, desktop layout and a deliberately simulated load-error/retry flow.
Results are in `.local/dashboard-*-results.json`; screenshots are in `.local/`.

Validation completed: **8 API/database checks and 8 browser checks passed**,
covering all seven logins and the error/retry case. The browser run recorded no
unexpected server errors or runtime exceptions. Frontend build, API bundling and
the whitespace check passed. An initial test mocked only one failed request;
React's repeated development load required holding the simulated outage until
Retry. The corrected browser suite passed in full.

Migration `20260918000300_role_dashboards.sql` was applied locally only. It changes
only Dashboard View and preserves each role's existing source-module grants and
dashboard scope. For deployment, review and apply that migration together with
the API/frontend changes. Local role defaults from the earlier setup still need
their own production review; no production roles or deployment were changed.

Use the existing logins in `.local/ROLE-DEMO.md`. Physical phone GPS/camera and
production performance are not part of dashboard validation.
