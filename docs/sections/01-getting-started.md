# 1. Getting Started

This section covers how to sign in to the SEPL ERP, how administrators create and manage user accounts, how the role-and-permission model controls what each user can see and do, and how to find your way around the application. It is written for three audiences at once: the everyday end user who just needs to log in, the manager who wants to understand who can access what, and the developer who needs the technical reference (endpoints, JWT, database tables).

The product is a Node/Express + React single-page application for **Secured Engineers Pvt Ltd (SEPL)**. The backend stores everything in a SQLite database; the frontend is a React app that talks to the API under `/api`.

---

## 1.1 Logging In

### The login screen

The login page is the first thing every user sees when they are not authenticated. It is a two-panel layout: a sign-in form on the left and an SEPL brand panel ("Build secure. Track smart.") on the right. The SEPL logo is served from `/sepl-logo.webp`, with an inline SVG shield fallback if that image is ever missing, so the page never shows a broken image.

### How to sign in

1. Open the ERP URL in a browser (or the installed PWA — see [1.6](#16-mobile--pwa-behavior)).
2. In **Email / Username**, type either your email address **or** your username. The system matches against both, case-insensitively.
3. Type your **Password**. Use the eye icon to reveal/hide what you typed.
4. Optionally tick **Remember me** — this only saves your *username* on this device (in `localStorage` under `sepl_remember_identifier`); it does **not** save your password or keep you logged in.
5. Click **Sign in**. On success you get a "Welcome back, *name*!" toast and land on the Dashboard.

> If you don't have credentials, the page tells you to **contact your admin**. There is no public self-registration — only an admin can create accounts (see [1.3](#13-users-administration)).

### What happens on a successful login (session model)

On a correct username/email + password, the backend issues a **JWT (JSON Web Token)** and returns it together with your user profile, your effective permissions, and your assigned role names. The frontend stores the token in `localStorage` under the key `token` and attaches it as a `Bearer` token on every subsequent API request.

| Login outcome | What the user sees |
|---|---|
| Correct credentials | Logged in, redirected to Dashboard |
| Wrong password / unknown user | "Invalid credentials" (deliberately generic) |
| Account disabled (`active = 0`) | "Your account is disabled. Please contact admin." |
| Missing username or password | "Username/email and password required" |

Every login attempt — success or failure — is written to the **audit log** with the IP address and user-agent, so admins can spot brute-force patterns and review session history. Disabled-account and bad-password attempts are logged distinctly.

### Staying logged in (sliding session)

The JWT has a base lifetime of **7 days**. The session is a **sliding** session: while you are actively using the app, the middleware silently hands back a fresh token (via the `X-Refresh-Token` response header) once the current token is more than a day old, and the client swaps it in. The practical effect is that an active user is never kicked out mid-work; only a session left completely idle for the full 7-day lifetime expires.

### Change password (self-service)

Any logged-in user can change their own password from the sidebar footer:

1. Click your name area at the bottom of the sidebar, then **Change Password**.
2. Enter **Current Password**, then **New Password** and **Confirm New Password**.
3. The new password must be **at least 4 characters** and the two new-password fields must match.
4. Click **Change Password**.

The server verifies the current password before accepting the new one. Passwords are stored only as **bcrypt hashes** — the plain text is never kept and cannot be recovered.

### Forgot password (recovery code)

The system supports self-service password reset without involving an admin, using a personal **recovery code** that each user sets for themselves:

- A user sets a memorable recovery code (any phrase, min 4 characters). It is stored as a bcrypt hash, so even database access cannot reveal it.
- On the forgot-password flow, the user supplies their **username**, their **recovery code**, and a **new password**. If the code matches, the password is reset — and the account is also re-activated if it had been disabled.
- There is also an **owner-only emergency code** (stored hashed in `app_settings` under `emergency_reset_hash`) that works for *any* user, so management can unlock an employee who never set a personal code.

Forgot-password failures use deliberately vague error text ("Username or recovery code is incorrect, or no recovery code is set") so the system never reveals which usernames exist.

---

## 1.2 Roles & Permissions — the Access Model

Access in the ERP is governed by two independent concepts that work together:

1. **System role** — a single coarse tier on the user record: `user`, `manager`, or `admin`.
2. **Permission roles** — one or more named roles (e.g. "Site Engineer", "Accountant") assigned to the user. Each permission role carries a grid of per-module permissions.

### Admin bypass

A user whose **system role is `admin` always has full access to everything** — every module, every action — regardless of permission roles. This bypass is enforced in three places so it is consistent end-to-end:

- the backend permission middleware (`requirePermission`),
- the `getUserPermissions()` helper, which returns a complete all-modules grant for admins,
- the frontend `can()` helper in `AuthContext`.

### The permission grid

For every (role × module) pair the system stores six boolean flags:

| Flag | Meaning |
|---|---|
| `can_view` | See the module at all (gates the sidebar link and read APIs) |
| `can_create` | Add new records |
| `can_edit` | Modify existing records |
| `can_delete` | Remove records |
| `can_approve` | Approve records (for workflows with sign-off) |
| `can_see_all` | Scope override: see **every** record in the module, not just the ones the user raised/owns |

`can_see_all` is decoupled from `can_approve`. It is meant for auditor-style roles that need full read visibility across all records but no approval power. When it is OFF (the default), a user only sees records they own; when ON, they see everything in that module.

When a user has **multiple permission roles**, the effective permission for each flag is the **highest privilege** across all their roles (logical OR per flag).

### How a module stays hidden until granted

A key behavior (added after "when I create new module it shows to everyone"): **a module is hidden by default until access is explicitly granted.** In the sidebar, an item is visible only if:

- it is explicitly flagged `open: true` — the handful of features open to all staff (Help Tickets, Onboarding, Training, RFQ Queue), **or**
- the user's role can view that item's `module` key (admins pass everything).

An item with no `open` flag and no/unknown module key is hidden for non-admins. So forgetting to wire up a permission key fails *safe* — it hides the feature rather than leaking it.

### Live permission refresh

Permissions used to be read only at login, which meant a grant didn't take effect until the user logged out and back in ("if I give permission, not working proper"). Now the frontend re-pulls the user's permissions from `/auth/me` whenever the browser tab regains focus and every 2 minutes while active (debounced). The backend always enforces permissions live, so a freshly granted module appears without a re-login.

### Module keys (reference)

These are the module keys used by the `role_permissions` table and shown in the Roles & Permissions matrix. Renaming a label in the UI (e.g. "Procurement" → "Indent to Dispatch") does not change the underlying key. Grouped here the way the admin matrix groups them:

| Group | Module keys |
|---|---|
| Finance & Daily Ops | `dashboard`, `cashflow`, `cheques`, `payment_required`, `attendance`, `collections`, `dpr`, `delegations`, `pms_tasks`, `checklists` |
| Sales & CRM | `leads`, `crm_funnel`, `fire_noc`, `rental_tools`, `influencers`, `crm_kitting`, `quotations`, `business_book` |
| Materials / Vendors / Procurement | `item_master`, `orders`, `vendors`, `sub_contractors`, `customers`, `procurement`, `procurement_schedule`, `indent_fms`, `inventory` |
| Execution / Site | `installation`, `billing`, `complaints`, `snags`, `company_assets`, `help_tickets` |
| HR / People | `hr_system`, `subcon_hiring`, `hr`, `payroll`, `scoring`, `tools`, `rentals`, `employees`, `expenses` |
| Platform | `ai_agent`, `users` |

> Note: the all-modules grant the backend hands to admins uses a slightly different internal list; the table above reflects the admin-facing **Roles & Permissions** matrix, which is the authoritative list of what can be granted/revoked.

### Indent approval roles (separate from permissions)

In addition to permission roles, a user can be tagged with an **indent approval role** that gates the multi-level indent (procurement) sign-off, set on the user record as `approval_role`:

| `approval_role` | Meaning |
|---|---|
| `l1` | L1 Approver — first sign-off |
| `l2` | L2 Approver — final sign-off |
| `hr` | HR Approver — single sign-off for RGP indents |
| *(none)* | Ordinary user, cannot approve indents |

Admins always pass either gate as a safety net. This tag is independent of the `can_approve` permission flag.

---

## 1.3 Users Administration

User management lives at **Settings → Users** (`/admin/users`) and is **admin-only**. The page shows summary cards (Total / Active / Inactive / Admins) and a table of every user (including inactive ex-employees, which stay visible to admins so their historical records remain intact, but are excluded from assignment pickers elsewhere).

The table shows: Name, Username, Email, Phone, System Role (with L1/L2/HR badges if tagged), Assigned permission Roles, Department, and Status (Active/Inactive).

### Create a user

1. Click **Add User**.
2. Fill in **Full Name** (required) and **Email** (required).
3. Optionally set a **Username** (spaces are auto-converted to dots, e.g. `Monika.devi`). Leave blank to log in by email only.
4. Set **Phone**, **Department** (optional).
5. Set a **Password** (required for new users).
6. Choose the **System Role**: User / Manager / Admin.
7. Optionally choose an **Indent Approval Role** (L1 / L2 / HR).
8. Under **Assign Permission Roles**, tick the permission roles this user should have.
9. Click **Create User**.

### Edit a user

Open a user with the edit (pencil) icon. You can change every field above. The password field reads "New Password (leave blank to keep)" — leaving it empty preserves the current password. Role assignments are replaced with whatever is ticked at save time.

### Reset a password (admin)

Because stored passwords are bcrypt-hashed and cannot be read back, an admin **sets a new one** rather than viewing the old:

1. Click the key icon on a user row.
2. Either type a custom new password, or leave it blank to auto-generate a 10-character mixed-case + digit password (ambiguous characters like 0/O and 1/l are excluded).
3. Click **Reset & Show Once**. The new password is displayed **once** with a copy button — share it with the user through a secure channel; it is not shown again.

Custom admin-set passwords must be at least 3 characters (relaxed so short office defaults work); the reset modal recommends 6+.

### Activate / deactivate

The user/user-check icon toggles a user's `active` flag. **Deactivating is the recommended, reversible way to stop someone logging in** — their historical records stay linked. A deactivated user gets the "Your account is disabled" message at login.

### Delete a user

The trash icon hard-deletes a user. This is guarded:

- It is a **two-step confirmation** — a dialog, then you must type `DELETE <name>` exactly.
- You cannot delete **your own** account, and you cannot delete the **last active admin**.
- If the user is referenced elsewhere (e.g. as `created_by` on indents, candidates, payment approvals), a plain delete is blocked. The UI then offers **Force Delete** (`?force=1`), which nulls every foreign-key reference pointing at the user across all tables, then deletes the row. Denormalized audit-trail snapshots (the saved `user_name` fields) stay intact, so old rows keep working — they just lose the "created by" link.

### Location-tracking opt-out

A map-pin / eye-off toggle per user controls whether they appear in **Admin → Location** tracking. This flips the user's `track_location` flag; office staff or anyone management doesn't want on the live map can be hidden here. (For how the GPS pings are produced, see [1.5](#gps-location-tracking).)

### Bulk import users

**Bulk Import** accepts a CSV with columns **Name, Email, Phone, Department, Role Name** (a downloadable template is provided). Imported users get the default password **`sepl@123`** unless specified, and are matched to an existing permission role by name. A preview table shows the rows before you confirm the import; duplicates (by email) are skipped.

---

## 1.4 Roles & Permissions Administration

Role administration lives at **Settings → Roles & Permissions** (`/admin/roles`), also admin-only. The screen is a two-pane layout: the list of roles on the left, and the permission matrix for the selected role on the right.

### Create / edit / delete a role

- **Create**: click the **+** in the Roles panel header, give it a **Name** (required) and an optional **Description**.
- **Edit**: hover a role and click the pencil icon.
- **Delete**: hover a role and click the trash icon. **System roles (`is_system`) cannot be deleted.** Deleting a role removes its permissions; any user holding it loses those permissions.

### Edit a role's permissions

1. Click a role in the left panel — the matrix loads on the right.
2. The matrix lists every module as a row and the six permission flags as columns: **View, Create, Edit, Delete, Approve, See All**.
3. Click any cell to toggle it. Helpful rules built into the grid:
   - Enabling any action (Create/Edit/etc.) **auto-enables View** for that module.
   - Disabling **View** clears all the other flags for that module.
   - Clicking a **column header** toggles that action for **all** modules at once.
4. Click **Save Permissions**. Changes take effect live for affected users (no re-login needed — see live refresh in [1.2](#live-permission-refresh)).

---

## 1.5 Navigation

Once logged in, every page renders inside a common **Layout**: a left sidebar, a top header, the page content, and two floating helpers (a Help Ticket button and the AI Agent chat).

### Sidebar structure

- **Dashboard** sits standalone at the very top (single link).
- Everything else is organized into **collapsible accordion groups**. Groups are independently expandable (more than one can be open at once); the open/closed set is remembered per browser via `localStorage` (`sidebar_open_groups`). Landing on a deep route (e.g. `/cashflow`) auto-expands the group that contains it.
- **Settings** is pinned to the bottom of the nav.

The groups (and a sample of what lives under each):

| Group | Examples of items |
|---|---|
| CRM | Partners, CRM Sales Funnel, Sales Funnel, Business Book, Customers, Full Kitting |
| Quotes & Orders | Quotations, AI Auto-Quotation, PO/FOC Stripped, Labour Rate |
| Procurement | Items, RFQ Queue, Vendors, Indent to Dispatch, Order to Planning, Schedule (Gantt) |
| Projects | Indent Labour Payment, Daily Reports (DPR), Snags, Fire NOC Renewal, Sales Billing |
| Finance | Cheques, Payables, Collections, Invoices, Cash Flow, Expenses |
| HRMS | Hiring, Sub-contractor Hiring, Onboarding, Training, Attendance, Payroll, Employees, Performance, Sub-contractor Master |
| Inventory | Tool Rentals, Assets, Inventory, Tools, Room Rentals |
| Tasks | Delegations, PMS Tasks, Checklists |
| Service Desk | Complaints, Help Tickets |
| Executive *(admin only)* | War Room, Operating Console, TOC View |
| Admin *(admin only)* | Activity Log, Location |
| Settings *(admin only)* | Backups, AI, Email, Email Triggers, Users, Roles & Permissions, Audit Log |

Each link is only shown if the current user may view its module (admins see all) or it is flagged open-to-all; whole groups marked admin-only are hidden from non-admins. See [1.2](#how-a-module-stays-hidden-until-granted).

### Menu search

A **search box** at the top of the sidebar ("Search menu… (e.g. attendance)") lets you jump to any item without remembering which group it lives in. It is a case-insensitive substring match on menu labels. While the box has text, every group with a matching child is force-expanded and non-matching items/groups are hidden; clearing the box (or pressing **Escape** inside it) restores the saved accordion state. If nothing matches you get a "No menu items match" message.

### Sidebar footer

The footer shows the logged-in user's name, `@username`, email, and their assigned role chips, plus the **Change Password** and **Logout** buttons.

### Header

The top header contains:

- A **hamburger / expand** button that hides or shows the sidebar. On desktop, hiding the sidebar reclaims its 256px and a floating "Menu" tab appears at the left edge to bring it back.
- The **page title**, derived from the current route's sidebar label.
- A **push-notification toggle** (`EnablePushButton`) — each device (phone, laptop, desktop) must be enabled separately.
- An **announcement bell** (`AnnouncementBell`) — a single unified inbox with two tabs: HR/system notifications (interview reminders, offer expiries, pending approvals) and company announcements. This replaced an earlier confusing three-bell layout.
- A **build stamp** chip (e.g. `v…`) showing the build timestamp, so you can confirm which deploy is currently loaded (especially useful on the iPhone PWA).

### GPS location tracking

Location tracking runs **globally from the Layout**, not just on the Attendance page. As long as any ERP page (or the installed PWA) is open and the user is logged in:

- The browser requests GPS and **pings the backend every 30 seconds** (`POST /attendance/track-location`) with latitude, longitude, and accuracy.
- Each ping doubles as a **heartbeat for backend auto-punch** (attendance).
- The app requests a best-effort **screen wake lock** so the tab/phone is less likely to suspend mid-day.
- GPS accuracy (uncertainty radius, in meters) is sent so the backend can apply tolerance to geofence checks and not wrongly tag an on-site user as "Outside".

Permission denial or timeout is handled silently. A fully closed browser cannot ping — true 24/7 tracking would require a native wrapper. Per-user opt-out is managed in User Management (see [1.3](#location-tracking-opt-out)).

---

## 1.6 Mobile / PWA Behavior

The app is responsive and installable as a PWA:

- Below 768px the layout switches to **mobile mode**: the sidebar becomes a slide-in overlay (with a dark backdrop) instead of a fixed column, and it auto-closes when you navigate to a new route.
- The header and content respect iOS **safe-area insets** (`env(safe-area-inset-top/bottom)`) so the hamburger button isn't buried under the status bar / Dynamic Island when running as a full-screen installed app, and content isn't hidden behind the home indicator.
- The build-stamp chip is rendered in a compact form on small screens to help verify the PWA has the freshest bundle.

---

## 1.7 Technical Reference

### Auth endpoints

All live under `/api/auth`. "Auth" = requires a valid Bearer token; "Admin" = also requires system role `admin`.

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /auth/login` | — | Authenticate by username **or** email + password; returns `{ token, user, permissions, userRoles }` |
| `GET /auth/me` | Auth | Current user profile + live permissions + role names |
| `POST /auth/change-password` | Auth | Self-service change (verifies current password; new min 4 chars) |
| `POST /auth/recovery-code` | Auth | Set/replace personal recovery code (stored hashed) |
| `POST /auth/forgot-password` | — | Reset password via personal or emergency recovery code |
| `GET /auth/my-permissions` | Auth | Effective permissions for the current user |
| `POST /auth/register` | Admin | Create a user (+ optional role assignments) |
| `GET /auth/users` | Auth | List users (`?active_only=1` to exclude inactive) |
| `PUT /auth/users/:id` | Admin | Update a user, roles, and/or password |
| `PATCH /auth/users/:id/track-location` | Admin | Toggle a user's location-tracking opt-out |
| `POST /auth/users/:id/reset-password` | Admin | Reset a user's password; returns the new password once |
| `DELETE /auth/users/:id` | Admin | Delete a user (`?force=1` nulls FK refs first) |
| `POST /auth/bulk-import` | Admin | Bulk create users from parsed CSV rows |
| `GET /auth/roles` | Auth | List roles |
| `POST /auth/roles` | Admin | Create a role |
| `PUT /auth/roles/:id` | Admin | Rename / re-describe a role |
| `DELETE /auth/roles/:id` | Admin | Delete a non-system role |
| `GET /auth/roles/:id/permissions` | Auth | Get a role's permission rows |
| `PUT /auth/roles/:id/permissions` | Admin | Bulk-replace a role's permission matrix |

### JWT and middleware

- Tokens are signed with `jsonwebtoken` using `process.env.JWT_SECRET` (falling back to a hard-coded dev secret — **set a real secret in production**).
- The token payload carries `{ id, email, role, name }`, with a base lifetime of **7 days**.
- `authMiddleware` reads the `Authorization: Bearer <token>` header, verifies it, attaches `req.user`, and performs the sliding-session refresh (issues `X-Refresh-Token` when the token is more than ~1 day old).
- `adminOnly` requires `req.user.role === 'admin'`.
- `requirePermission(module, action)` is the per-route gate: admins pass automatically; otherwise it looks up the user's role permissions for that module and checks the mapped flag (`view`→`can_view`, etc.), returning 403 if missing.
- `getUserPermissions(userId)` builds the effective permission map the frontend consumes — full grant for admins, otherwise the OR-merge of all the user's roles.

### Where roles & permissions live (database)

| Table | Holds |
|---|---|
| `users` | Account record: `name`, `email`, `username`, bcrypt `password`, system `role`, `department`, `phone`, `active`, `approval_role`, `recovery_code_hash`, `track_location` |
| `roles` | Named permission roles (`name`, `description`, `is_system`) |
| `user_roles` | Many-to-many join of users ↔ roles (cascades on user delete) |
| `role_permissions` | One row per (role, module): `can_view`, `can_create`, `can_edit`, `can_delete`, `can_approve`, `can_see_all` |
| `app_settings` | Misc settings incl. `emergency_reset_hash` for owner-only password recovery |

### Frontend auth state

`AuthContext` (`client/src/context/AuthContext.jsx`) is the single source of auth truth on the client. It exposes `user`, `token`, `permissions`, `userRoles`, the `login`/`logout` actions, and the permission helpers `can`, `canView`, `canCreate`, `canEdit`, `canDelete`, `canApprove`, `canSeeAll`, and `isAdmin`. On mount it validates the stored token via `/auth/me`; it also re-pulls permissions on tab focus and every 2 minutes so admin grants apply without a re-login.
