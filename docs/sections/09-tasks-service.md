# 9. Tasks & Service Desk

This section documents the five modules that make up the **Tasks & Service Desk** area of the SEPL ERP: **Delegations**, **PMS Tasks**, **Checklists**, **Complaints**, and **Help Tickets**. Together they cover internal task delegation, project-tied tasks, recurring routine checks, customer service complaints, and the in-app support desk that every staff member can reach.

All five share a common philosophy:

- A **task / item** is raised by one person, **assigned to** another, and moves through a **status pipeline**.
- Most are gated by the **role-permission matrix** (`role_permissions` joined via `user_roles`); `role = 'admin'` always bypasses.
- A **scope model** (`mine` / `given` / `all`, plus `followup` for PMS) controls which slice of rows a user sees.
- Push notifications, WhatsApp links, and email-rule events fire on key transitions.

| Module | Page (client) | Route (server) | API base | Primary table |
|---|---|---|---|---|
| Delegations | `pages/Delegation.jsx` | `routes/delegations.js` | `/api/delegations` | `delegations` |
| PMS Tasks | `pages/PMSTasks.jsx` | `routes/pmstasks.js` | `/api/pms-tasks` | `pms_tasks` |
| Checklists | `pages/Checklists.jsx` | `routes/hr.js` | `/api/hr/checklists` | `checklists`, `checklist_completions` |
| Complaints | `pages/Complaints.jsx` | `routes/complaints.js` | `/api/complaints` | `complaints` |
| Help Tickets | `pages/HelpTickets.jsx` + `components/HelpTicket.jsx` | `routes/support.js` | `/api/support` | `support_tickets` |

---

## 9.1 Delegations

### Business purpose

Delegations are free-form **internal tasks** that a senior person assigns to a team member, with a due date, an optional project tag, and a **proof-of-completion** requirement. The assignee uploads proof; an admin reviews and approves or rejects. It replaces the "I told them on WhatsApp and forgot" problem with an auditable task list and a per-person workload view.

### Who uses it

- **Admin** and any user whose role matrix grants `delegations.create` or `delegations.can_approve` can **raise** tasks. (The MD, Ankur Kaplesh, is on a non-admin role but has full delegation rights via the matrix.)
- **Any user** can be an assignee and is the default recipient view.
- An **EA / supervisor** — defined as anyone with `can_approve` on the `delegations` module — gets the **"All tasks"** tab across every user and may upload proof on anyone's behalf.

### Main screen, tabs & columns

The page opens on a **Workload Dashboard** (one row per person) followed by the task list.

**Scope tabs** (top of list):

- `Assigned to me` (`mine`) — default for everyone.
- `All tasks` (`all`) — shown only to admin / EA.

Filters: status dropdown, assignee name (admin/EA only), and a due-date range (`date_from` / `date_to`).

**Task-list columns:** S.No. · Task ID (`TSK-####`) · Description · Project · Assigned To · Due / Completed · Status · Upload Proof · Extension · Actions.

**Workload Dashboard columns** (`GET /dashboard`): Person · Total · Active · Completed · Delayed · Avg Delay (Days) · WIP Limit · Status.

- **WIP Limit** defaults to **5** per person.
- **Status** is derived:
  - `Overloaded` — active tasks > WIP limit.
  - `Constraint` — ≥ 25 % of tasks delayed **or** average delay > 5 days.
  - `OK` — neither.
- "Active" counts statuses `pending`, `submitted`, `rejected`; "delayed" = `pending`/`submitted` with a past due date.

### Key fields

| Field | Notes |
|---|---|
| `title` | Auto-derived from first line of the description (first 80 chars); the UI no longer asks for it separately. |
| `description` | Required. |
| `assigned_by` / `assigned_to` | User IDs. |
| `due_date` | Optional. |
| `project_name` | Free text; not tied to any master list. Editable inline via `PATCH /:id/project`. |
| `attachment_url` | Optional brief/reference attached at creation. |
| `proof_url` | Uploaded on submission. |
| `status` | `pending` → `submitted` → `approved` / `rejected`. |
| Extension fields | `requested_due_date`, `extension_reason`, `extension_status`, `extension_reviewed_at/by`. |

### Step-by-step workflow

1. **Raise** — admin/EA fills description + assignee (+ optional due date, project, attachment). A duplicate guard blocks an identical *description + assignee + due-date* and points to the existing `TSK-` code. A push notification fires to the assignee.
2. **Work & submit proof** — the assignee uploads a proof file (`POST /:id/submit`). Status becomes `submitted`. Admin or EA can submit on the assignee's behalf (mam's EA uploads photos/PDFs received over WhatsApp).
3. **Review** — **admin only** approves (`approved`) or rejects with a mandatory reason (`rejected`). Rejected tasks resurface at the top of the assignee's list.
4. **(Optional) Extension** — the assignee requests a new due date with a reason (`POST /:id/request-extension`); **admin** approves (updates `due_date`) or rejects.

### Assignment & status pipeline

```
pending ──submit proof──▶ submitted ──approve──▶ approved
   ▲                          │
   └──────── reject ──────────┘   (status = rejected, then can re-submit)
```

- **Who can submit proof:** assignee, admin, or EA.
- **Who can approve/reject:** admin only.
- **Who can edit/delete:** the original assigner or admin (any status).

### Recurrence / scheduling

Delegations have **no recurrence** — each is a one-off task. (Recurring routine work is handled by Checklists, §9.3.)

### Notifications

- On **create**: web-push to the assignee ("📋 New Delegation").
- No email events are wired for delegations (unlike complaints / tickets).

### API endpoints

| Method | Path | Purpose | Who |
|---|---|---|---|
| GET | `/api/delegations` | List; `?scope=mine\|given\|all`, `?status`, `?assignee_id`, `?date_from/to` | Auth (scope gated) |
| GET | `/api/delegations/dashboard` | Per-person workload | Auth |
| GET | `/api/delegations/stats` | Homepage widget counts for current user | Auth |
| POST | `/api/delegations` | Create task | admin or `create`/`approve` perm |
| PUT | `/api/delegations/:id` | Full edit | assigner / admin |
| PATCH | `/api/delegations/:id/project` | Inline edit project tag | assigner / admin |
| POST | `/api/delegations/:id/submit` | Upload proof | assignee / admin / EA |
| POST | `/api/delegations/:id/approve` | Approve | admin |
| POST | `/api/delegations/:id/reject` | Reject (reason required) | admin |
| POST | `/api/delegations/:id/request-extension` | Request new due date | assignee / admin |
| POST | `/api/delegations/:id/approve-extension` | Approve extension | admin |
| POST | `/api/delegations/:id/reject-extension` | Reject extension | admin |
| DELETE | `/api/delegations/:id` | Delete | assigner / admin |

### DB table — `delegations`

`id`, `title`, `description`, `assigned_by`, `assigned_to`, `due_date`, `status` (`pending`/`submitted`/`approved`/`rejected`), `proof_url`, `submitted_at`, `reviewed_at`, `reviewer_id`, `reject_reason`, `created_at`. Migration-added columns: `project_name`, `attachment_url`, `requested_due_date`, `extension_reason`, `extension_status`, `extension_reviewed_at`, `extension_reviewed_by`.

---

## 9.2 PMS Tasks

### Business purpose

PMS (Project Management System) Tasks are **delegations tied to a specific Business Book project**. The creator (typically CRM) picks a project; the task automatically captures the project's name and its **CRM owner** (read from the latest Client PO upload). The lifecycle mirrors delegations, but approval rights extend to the project's CRM owner so they can sign off on work for "their" site.

### Who uses it

- **CRM executives** and anyone with `pms_tasks.create` raise tasks; admin bypasses all gates.
- **Assignees** carry out the task and submit proof.
- **Approvers:** the original assigner, the **project's CRM owner** (matched by name), or admin.

### Main screen, tabs & columns

**Scope tabs:**

- `My Tasks` (`mine`) — default.
- `Given by me` (`given`).
- `Followup (all active)` (`followup`) — everyone's non-approved tasks.
- `All (admin)` (`all`) — admin / `pms_tasks.approve` only.

The selected scope is **persisted to the URL** (`?scope=…`) so a page refresh keeps the follow-up view.

Filters: status, CRM (assigner), assignee, and a date range (on `COALESCE(due_date, created_at)`).

**Columns:** Task ID · Project · Created By · Description · Assigned To · Due · Status.

### Key fields

| Field | Notes |
|---|---|
| `project_id` | Required; references `business_book(id)`. |
| `project_name_snapshot` | Captured server-side at create (site name → project name fallback). |
| `crm_name` | Captured from the **most recent** Client PO's `crm_name` for that project. |
| `description` / `title` | Title derived from first line of description. |
| `assigned_by` / `assigned_to`, `due_date`, `attachment_url`, `proof_url` | As in delegations. |
| `status`, extension fields | Identical to delegations. |

The create form's project picker is fed by `GET /projects`, which returns each Business Book row with its latest `crm_name` pre-joined and de-duplicated on project/company/client.

### Step-by-step workflow

1. **Pick project** — the creator selects a project; the CRM name and project label auto-fill (and cannot be spoofed by the client because they are re-derived on the server at insert).
2. **Create** — description + assignee (+ optional due date / attachment). Push to assignee ("📌 PMS — <project>").
3. **Submit proof** — assignee (or a PMS executive with `approve`, or admin) uploads proof → `submitted`.
4. **Approve / reject** — assigner, **CRM owner**, or admin. CRM-owner matching is name-based: exact match or first-token match (e.g. task CRM "Sushila" matches user "Sushila Kumari").
5. **(Optional) Extension** — same request/approve cycle as delegations (extension approval is admin-only).

### Assignment & status pipeline

Identical states to delegations (`pending → submitted → approved/rejected`). The distinction is **who may approve**: `canApprovePmsTask` = admin **or** assigner **or** CRM owner (`isCrmOwner` name match).

### Recurrence / scheduling

None — one-off, like delegations.

### Notifications

- Web-push to the assignee on create. No email events.

### API endpoints

| Method | Path | Purpose | Who |
|---|---|---|---|
| GET | `/api/pms-tasks/projects` | Project dropdown w/ CRM pre-join | Auth |
| GET | `/api/pms-tasks` | List; `?scope`, `?status`, `?crm_id`, `?assignee_id`, `?date_from/to` | Auth (scope gated) |
| POST | `/api/pms-tasks` | Create (server captures project + CRM) | `create` perm |
| PUT | `/api/pms-tasks/:id` | Edit (may re-target project) | assigner / admin |
| POST | `/api/pms-tasks/:id/submit` | Submit proof | assignee / `approve` / admin |
| POST | `/api/pms-tasks/:id/approve` | Approve | assigner / CRM owner / admin |
| POST | `/api/pms-tasks/:id/reject` | Reject (reason required) | assigner / CRM owner / admin |
| POST | `/api/pms-tasks/:id/request-extension` | Request extension | assignee / `approve` / admin |
| POST | `/api/pms-tasks/:id/approve-extension` | Approve extension | admin |
| POST | `/api/pms-tasks/:id/reject-extension` | Reject extension | admin |
| DELETE | `/api/pms-tasks/:id` | Delete | assigner / admin |

### DB table — `pms_tasks`

`id`, `title`, `description`, `project_id`, `project_name_snapshot`, `crm_name`, `assigned_by`, `assigned_to`, `due_date`, `status`, `proof_url`, `submitted_at`, `reviewed_at`, `reviewer_id`, `reject_reason`, `requested_due_date`, `extension_reason`, `extension_status`, `extension_reviewed_at`, `extension_reviewed_by`, `created_at`. (`attachment_url` added by migration.)

---

## 9.3 Checklists

### Business purpose

Checklists are **recurring routine tasks** (daily / weekly / fortnightly / monthly / quarterly / yearly / once) assigned to a person or department. Each occurrence requires a proof — a photo, PDF, file, a text note, or nothing — and every completion goes into an **admin approval queue**. This gives mam a day-by-day view of which routine work was done, by whom, with proof, and whether she has signed it off.

> Note: Checklists live under the **HR** route file (`routes/hr.js`) and are served from `/api/hr/checklists`, even though the UI is its own page.

### Who uses it

- **Admin** creates, edits, deletes, bulk-uploads checklists, and approves/rejects completions.
- **Every user** sees the checklists assigned to them (or unassigned ones, which apply to everyone) and marks them done.

### Main screen, tabs & columns

Three views (toggle buttons):

1. **By Date** (`by-date`, default) — pick a date; see every checklist active that day with its completion + approval status. Includes a per-person summary and a "Today" jump.
2. **Manage / Current** (`current`, admin) — the master list grouped by assignee, plus Add / Bulk-add / Edit / Delete.
3. **Followup** (`followup`) — a back/forward window (default ±7 days) showing missed / today / done-pending / done-rejected rows so nothing slips.

Per-row completion states surfaced in Followup: `missed`, `today`, `done_rejected` count as still-pending.

### Key fields

| Field | Notes |
|---|---|
| `title` / `description` | Title derived from description. |
| `frequency` | `daily`, `weekly`, `fortnightly`, `monthly`, `quarterly`, `yearly`, `once`. |
| `due_date` | Anchor date; recurrence is computed from it (see below). |
| `due_time` | Optional HH:MM slot. |
| `assigned_to` | Person; `NULL` = applies to everyone. |
| `department` | Auto-filled from the assignee's `users.department` if not supplied. |
| `recurrence_start_date` / `recurrence_end_date` | Window; non-admins cannot complete outside it. |
| `proof_type` | One of `photo` / `pdf` / `file` / `text` / `none` (default `photo`); enforced on completion. |
| `proof_label` | Free-text hint of *what* to attach. |
| `fortnight_days` | For `fortnightly`, the two days of month (default `1,15`). |

**Completion** (`checklist_completions`): `checklist_id`, `user_id`, `completion_date`, `proof_url`, `notes`, `submitted_at`, plus approval columns `approval_status` (default `pending`), `approved_by`, `approved_at`, `approval_note`. Unique per `(checklist, user, date)`.

### Step-by-step workflow

1. **Create** (admin) — single task, or **Bulk add**: paste many lines that share frequency / assignee(s) / dates / proof type. Bulk supports per-line overrides via `|` or tab — `description | proof_label | proof_type | time` — and a comma-separated **time** column expands into one row per time slot. Bulk can also assign to multiple users at once. A separate **Excel** path (`bulk-template.xlsx` → `parse-excel` → `bulk`) lets admin upload a spreadsheet.
2. **See today's tasks** — each user's dashboard widget / By-Date view lists checklists due that day, computed by frequency (below).
3. **Mark done** — the user attaches the required proof (photo/pdf/file) or note (text), optionally back-dating within the recurrence window. Re-submitting overwrites the proof (UPSERT) and resets approval to `pending`.
4. **Approve / reject** (admin) — each completion is decided via `…/completions/:id/decision` with `approved` or `rejected` + optional note.

### "Due today" computation (`/my-today`)

| Frequency | Due when |
|---|---|
| `daily` | every day |
| `weekly` | same weekday as `due_date` |
| `monthly` | same day-of-month as `due_date` |
| `quarterly` | every 3rd month on the `due_date` day |
| `yearly` | same month-and-day as `due_date` |
| `once` | exactly `due_date` |

(`fortnightly` rows are created as fixed day-of-month occurrences via `fortnight_days`.)

### Assignment & status pipeline

```
checklist (template) ──occurs on date──▶ user marks done (proof) ──▶ completion: pending
                                                                        │
                                                          admin decision ┤──▶ approved
                                                                        └──▶ rejected (user re-does)
```

The checklist row itself carries a `status` (`pending`/`in_progress`/`completed`/`overdue`) used for the master list; the live per-day state comes from the completion's `approval_status`.

### Notifications

No push/email events are wired on checklist actions; visibility is via the dashboard widget and the Followup view.

### API endpoints (all under `/api/hr`)

| Method | Path | Purpose | Who |
|---|---|---|---|
| GET | `/checklists` | List master checklists | Auth (own / all) |
| POST | `/checklists` | Create one | admin |
| POST | `/checklists/bulk` | Bulk create (multi-line, multi-user) | admin |
| GET | `/checklists/bulk-template.xlsx` | Download Excel template | Auth |
| POST | `/checklists/parse-excel` | Parse uploaded Excel (no writes) | Auth |
| PUT | `/checklists/:id` | Edit | admin |
| DELETE | `/checklists/:id` | Delete | admin |
| GET | `/checklists/my-today` | Today's due tasks for current user | Auth |
| POST | `/checklists/:id/complete` | Mark done (proof/notes, optional back-date) | Auth (assignee) |
| GET | `/checklists/by-date?date=` | All tasks + completion status on a date | Auth (own / all) |
| GET | `/checklists/followup?back=&forward=` | Missed/upcoming window | Auth |
| POST | `/checklists/completions/:id/decision` | Approve / reject a completion | admin |

### DB tables

- **`checklists`** — `id`, `title`, `description`, `frequency`, `due_date`, `status`, `assigned_to`, `created_by`, `created_at`; migration-added: `due_time`, `department`, `recurrence_start_date`, `recurrence_end_date`, `proof_type`, `proof_label`, `fortnight_days`.
- **`checklist_completions`** — `id`, `checklist_id`, `user_id`, `completion_date`, `proof_url`, `notes`, `submitted_at`, `UNIQUE(checklist_id, user_id, completion_date)`; migration-added: `approval_status`, `approved_by`, `approved_at`, `approval_note`.

---

## 9.4 Complaints

### Business purpose

The Complaints module is the **customer service desk**. Customers (or CRM on their behalf) register a complaint; CRM/admin assigns a **site engineer**; the client receives a **4-digit OTP** over WhatsApp; the engineer closes the complaint only after entering the OTP the client reads back — proving the customer actually confirmed the fix. The flow is structured as **Step 1 (Assign)** and **Step 2 (Resolve)**, with planned-vs-actual dates that compute a delay.

### Who uses it

- **Customers** register via a **public, unauthenticated** form.
- **CRM / admin** (`complaints.create` / `edit`) register internally, assign engineers, and run the OTP/WhatsApp center.
- **Site engineers** (any user, picked from the engineer dropdown) carry out the fix and verify the OTP.

### Main screen, tabs & columns

**Tabs:**

- `All Complaints` (`all`)
- `+ Register New` (`register`)
- `Step 1 — Assign` (`step1`) — open complaints with no `step1_assigned_to`.
- `Step 2 — Resolve` (`step2`) — open/in-progress complaints that are assigned but have no `service_report`.
- `Resolved` (`resolved`) — status `resolved` or legacy `closed`.

The list supports search (name / complaint no / company / mobile) and category/status filters. Each row opens an **OTP / WhatsApp Center** modal driving the assign → OTP → verify flow.

**Stat tiles** (`/stats`): Total · Open · In Progress · Resolved (counts `resolved` + legacy `closed`) · by category.

### Key fields

| Field | Notes |
|---|---|
| `complaint_number` | Auto sequence `CMP-#####` (starts at 1000). |
| `client_name`, `company_name`, `mobile_number` | Registration; name + mobile + problem are required. |
| `category`, `customer_type`, `complaint_type`, `state`, `emp_name` | Classification. |
| `problem_detail` | Required; mirrored into legacy `description`. |
| `step1_planned_date` / `_actual_date` / `_time_delay` / `_assigned_to` | Step 1 (assign). Delay = actual − planned in days. |
| `step2_*` | Step 2 (resolve) equivalents. |
| `service_report` | Engineer's closure note. |
| `assigned_engineer_id` | The locked engineer user (migration-added). |
| `resolution_otp`, `otp_generated_at`, `otp_verified_at`, `otp_attempts` | OTP state (migration-added). |
| `priority` | `low`/`medium`/`high`/`critical`. |
| `status` | `open` → `in_progress` → `resolved` (`closed` legacy). |

### Step-by-step workflow

1. **Register** — public (`POST /public`) or internal (`POST /`). A `CMP-` number is generated and a **Twilio WhatsApp + SMS confirmation** is auto-sent to the customer (fire-and-forget). Internal create also fires the `complaint.created` email rule and returns a click-to-send `wa.me` registration link as a fallback.
2. **Assign engineer (Step 1)** — `POST /:id/assign` with `engineer_user_id`. This locks the engineer, flips status `open → in_progress`, generates a fresh **4-digit OTP**, and returns **two WhatsApp links**: one to the engineer (job details, **no OTP**) and one to the client (carrying the OTP). Fires the `complaint.assigned` email rule.
3. **Dispatch WhatsApp** — when an admin clicks a link, `POST /:id/whatsapp/sent` timestamps which message (`register` / `engineer_assign` / `client_assign`) was sent — pure audit trail.
4. **Resolve (Step 2)** — the engineer enters the OTP the client reads off WhatsApp: `POST /:id/verify-otp`. On match → status `resolved`, `resolved_date` set, OTP wiped, `complaint.resolved` email fired. On mismatch → `otp_attempts++` with remaining-attempts feedback; locked out after 5 attempts.
5. **Resend OTP** — `POST /:id/resend-otp` issues a fresh OTP + new client WhatsApp link and resets the attempt counter.

`PUT /:id` is the general editor used to progress Step-1/Step-2 dates, assignment text, service report, status, and priority; it computes `step1_time_delay` / `step2_time_delay` automatically.

### Assignment & status pipeline

```
open ──assign engineer──▶ in_progress ──verify OTP──▶ resolved
                                  ▲ (resend OTP)
```

- **Assign / edit / OTP actions:** `complaints.edit`.
- **Create:** `complaints.create`. **Delete:** `complaints.delete`. **View:** `complaints.view`.

### Recurrence / scheduling

None — complaints are one-off, but they carry **planned vs actual dates** for both steps to measure SLA delay.

### Notifications

- **WhatsApp / SMS:** auto Twilio confirmation on register; click-to-send `wa.me` links to engineer and client on assign (OTP only to client).
- **Email rules:** `complaint.created`, `complaint.assigned`, `complaint.resolved` (recipients resolved to creator, engineer, and director).

### API endpoints

| Method | Path | Purpose | Who |
|---|---|---|---|
| POST | `/api/complaints/public` | Public customer registration | none (public) |
| GET | `/api/complaints` | List (`?status`, `?category`, `?search`) | `view` |
| GET | `/api/complaints/stats` | Tiles | `view` |
| GET | `/api/complaints/:id` | One complaint | `view` |
| POST | `/api/complaints` | Internal create | `create` |
| PUT | `/api/complaints/:id` | Update (Step 1 / 2 progression) | `edit` |
| DELETE | `/api/complaints/:id` | Delete | `delete` |
| POST | `/api/complaints/:id/assign` | Assign engineer, mint OTP, return WA links | `edit` |
| POST | `/api/complaints/:id/whatsapp/sent` | Timestamp a sent message | `edit` |
| POST | `/api/complaints/:id/verify-otp` | Engineer verifies → resolve | `edit` |
| POST | `/api/complaints/:id/resend-otp` | New OTP + client link | `edit` |

### DB table — `complaints`

`id`, `complaint_number`, `client_name`, `company_name`, `mobile_number`, `category`, `problem_detail`, `customer_type`, `complaint_type`, `emp_name`, `step1_planned_date/_actual_date/_time_delay/_assigned_to`, `step2_planned_date/_actual_date/_time_delay/_assigned_to`, `service_report`, legacy `installation_id`/`po_id`/`description`, `priority`, `status` (`open`/`in_progress`/`resolved`/`closed`), `resolved_date`, `resolution_notes`, `created_by`. Migration-added: `state`, `remarks`, `updated_at`, `assigned_engineer_id`, `resolution_otp`, `otp_generated_at`, `otp_verified_at`, `otp_attempts`, `client_register_msg_sent_at`, `engineer_assign_msg_sent_at`, `client_assign_msg_sent_at`.

---

## 9.5 Help Tickets

### Business purpose

Help Tickets are the **in-app support desk** for staff. Any user can raise a ticket about a bug, a how-to question, an access issue, or a request, optionally directed at a specific colleague. There is a full **Help Tickets page** for triage and a **floating Help widget** (drag-to-move button, bottom-right) that is available on every screen.

### Who uses it

- **Every staff member** can raise tickets (from the floating widget or the page).
- **Assignees** work the ticket and respond.
- **Raisers** decide when their own issue is closed.
- A **follow-up role** — anyone with `help_tickets.can_see_all` or `help_tickets.can_approve` — gets admin-like triage powers (see/close/reassign/respond on any ticket) without being a full admin. This is how mam gives one PC the job of chasing every ticket.

### Main screen, tabs & columns

**Help Tickets page tabs** (with count badges):

- `Assigned to me` (`mine`) — default.
- `Raised by me` (`given`).
- `All tickets` (`all`) — labelled "(admin)" or "(follow-up)"; shown only to admin / follow-up role.

Filters: status dropdown + search (ticket no / subject / person).

**Columns:** Ticket (`TK-#####`) · Subject · Raised By · Assigned To · Priority · Status · When · (actions).

**Floating widget** (`components/HelpTicket.jsx`) has two tabs: **Tickets** (list of your tickets + "Raise New Ticket") and **Learner** (built-in how-to guides for common tasks like adding a Business Book entry or requesting a payment).

### Key fields

| Field | Notes |
|---|---|
| `ticket_no` | Auto sequence `TK-#####` (starts at 1000). |
| `subject`, `description` | Both required. |
| `category` | `bug` (default), `feature_request`, `how_to`, `access_issue`, `data_issue`, `manpower`, `material`, `payment`, `other`. |
| `priority` | `low` / `medium` (default) / `high` / `urgent`. |
| `module` | Optional tag for which ERP area the ticket concerns. |
| `attachment_link` | Optional uploaded file. |
| `assigned_to` | Optional; when set, that user gets it on their dashboard. |
| `admin_response` | Reply from assignee / admin. |
| `status` | `open` → `in_progress` → `resolved` / `closed`. |
| `resolved_by`, `resolved_at` | Stamped on close. |

### Step-by-step workflow

1. **Raise** — from the widget or page, fill subject + description (+ category, priority, module, optional assignee and attachment). `POST /support`.
   - If **assigned**, push goes to that user; if **unassigned**, push goes to every active admin. The `ticket.created` email rule fires.
2. **Work it** — the **assignee** marks `in_progress` and adds an `admin_response`. (`PUT /:id`.)
3. **Close** — only the **raiser**, admin, or follow-up role may set `resolved` / `closed`; the `ticket.resolved` email rule fires. Reassignment is admin / follow-up-role only.

### Assignment & status pipeline

```
open ──assignee works──▶ in_progress ──raiser/admin closes──▶ resolved / closed
```

Permission rules enforced server-side in `PUT /:id`:

- **Admin / follow-up role:** anything (status, priority, response, reassign).
- **Raiser** (`user_id`): may close their own ticket; **cannot** reassign.
- **Assignee** (`assigned_to`): may set `in_progress` + respond; **cannot** close.

### Recurrence / scheduling

None.

### Notifications

- **Push:** to the assignee on create, or to all admins if unassigned ("🆘 …").
- **Email rules:** `ticket.created` and `ticket.resolved` (recipients: creator, assignee, director).

### API endpoints

| Method | Path | Purpose | Who |
|---|---|---|---|
| GET | `/api/support` | List; `?scope=mine\|given\|all`, `?status` | Auth (scope/see-all gated) |
| GET | `/api/support/mine` | "Assigned to me" widget (active count + recent 5) | Auth |
| GET | `/api/support/stats` | Admin dashboard counts | Auth |
| POST | `/api/support` | Raise ticket | Auth |
| PUT | `/api/support/:id` | Update status / response / priority / assignee | raiser / assignee / admin / follow-up (rules above) |
| DELETE | `/api/support/:id` | Delete | admin |

### DB table — `support_tickets`

`id`, `ticket_no`, `user_id` (raiser), `subject`, `description`, `category`, `priority`, `status` (`open`/`in_progress`/`resolved`/`closed`), `attachment_link`, `module`, `admin_response`, `resolved_by`, `resolved_at`, `created_at`, `updated_at`. (`assigned_to` added by migration.)

---

## 9.6 Cross-module summary

| Concern | Delegations | PMS Tasks | Checklists | Complaints | Help Tickets |
|---|---|---|---|---|---|
| Code prefix | `TSK-` | (numeric id) | (numeric id) | `CMP-` | `TK-` |
| Scopes | mine / all | mine / given / followup / all | by-date / current / followup | tab-by-stage | mine / given / all |
| Recurrence | no | no | **yes** (7 frequencies) | no | no |
| Proof required | yes (file) | yes (file) | yes (photo/pdf/file/text/none) | OTP confirmation | optional attachment |
| Approver | admin | assigner / CRM owner / admin | admin (per completion) | engineer via OTP | raiser / admin / follow-up |
| Push | yes | yes | no | — | yes |
| WhatsApp / SMS | no | no | no | **yes** (Twilio + links) | no |
| Email rules | no | no | no | created/assigned/resolved | created/resolved |
