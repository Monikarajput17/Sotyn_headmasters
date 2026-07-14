# 11. Administration & Settings

This section documents the administrative and configuration surface of the SEPL
ERP: the **Activity Log** (per-user keystroke tracking), **Location Tracking**
(GPS geofence sites), **Database Backups**, the **AI Agent** (Claude-powered
"Ask ERP" assistant + settings), **Email (SMTP)** configuration, **Email
Triggers** (rule-based automated mails), and the **Audit Log** (every mutating
request).

Every screen described here is **admin-only**. The relevant API routers each
call `authMiddleware` followed by an `adminOnly` guard (or an equivalent
`req.user.role !== 'admin'` check), so non-admin users cannot reach them even
by hitting the API directly. The one partial exception is the AI Agent, whose
read-only `/ask` and `/status` endpoints are gated by a granular
`ai_agent.view` permission so non-admins can use the chatbot if granted — but
the API-key settings page itself stays admin-only.

> **Users, Roles & Permissions** are covered in detail in **Section 1**. This
> section only cross-references them where another feature depends on them (for
> example, Email Triggers resolving recipients "by role", or the
> `track_location` opt-out flag set from User Management). See Section 1 for the
> full account-management, role, and permission model.

---

## 11.1 Activity Log (Daily Activity / Word Count)

### Business purpose

Lets management measure how much real data-entry work each employee did on a
given day. The metric is **total characters typed** into the ERP (the spec mam
gave: typing `monika` counts as 6 characters). It answers questions like "who
actually entered data today, and in which modules" and doubles as a
fraud/attribution investigation tool.

### Who uses it

Admin only (and, in practice, the MD reviewing daily output). Frontend:
`client/src/pages/admin/WordCount.jsx`. API: `server/routes/wordcount.js`
(mounted at `/api/admin/word-count`, `adminOnly`).

### How it works (what is automated)

There is **no separate tracking table** — the Activity Log is derived entirely
from the existing **`audit_log`** rows. For the chosen date (or date range) the
server:

1. Selects every `audit_log` row in the window with
   `action IN ('CREATE','UPDATE','DELETE')`.
2. Parses each row's `body_summary` (a compact JSON copy of the request body)
   and walks it recursively.
3. Counts the **characters** in every string value, after filtering out
   non-content noise: pure numbers, URLs, file paths, ISO dates, hex/UUID-ish
   strings, `[REDACTED]` secrets, and identifier/metadata keys (`id`,
   `user_id`, `created_at`, `rate`, `amount`, `latitude`, etc. — see
   `SKIP_KEYS`).
4. Aggregates the totals by user, by module (`entity_type`), and by action.

Because `body_summary` is capped at 2000 chars by the audit middleware, very
large submissions undercount; such rows are flagged `truncated` and the UI
shows an amber "lower bound" caveat banner.

### Main screen / fields

- **Hero card** — total characters entered for the selected date, plus entries,
  active users, and modules-used counters.
- **Date / range picker** — single day or `date_from`→`date_to`.
- **By User** table — characters + entries per user; **click a row** to open the
  drill-down.
- **By Module** table — characters + entries per ERP module (friendly labels
  from `MODULE_LABELS`, e.g. `quotations` → "BOQ & Quotations").
- **By Action** pill row — CREATE / UPDATE / DELETE breakdown.
- **"What's New in ERP" changelog** — auto-pulled from the deploy git log for
  the same date range (via `/api/admin/changelog`), so the MD can see which new
  features/fixes shipped each day. This is a sibling admin endpoint, not part of
  the word-count router.

### Drill-down & verification tools

Clicking a user opens a modal listing every entry they made that day with:
time (forced to **Asia/Kolkata**), **Δ gap** from the previous action (red
`<60s`, amber `<5m`), action, module, entry label, **IP**, and **device**
(shortened user-agent). A **burst detector** flags rapid-fire runs (`<60s`
gaps) to surface batch-click / automation patterns.

A **Verify user** button (`/user-check/:user_id`) opens an account-forensics
panel: the `users` row (including `created_at`), audit footprint (total
actions, first/last action, distinct IPs, active days), the IPs that used the
account, and the last 30 login events. This was built to investigate
"this user entered rows before their account existed" complaints (shared-session
/ reused-JWT scenarios).

### API endpoints

| Method & path | Purpose |
|---|---|
| `GET /api/admin/word-count` | Aggregates for a date/range (`?date=` or `?date_from=&date_to=`, optional `?user_id=`) — totals + `by_user` / `by_module` / `by_action`. |
| `GET /api/admin/word-count/detail` | Per-record breakdown for the drill-down (adds `ip`, `user_agent`, `body_preview`). |
| `GET /api/admin/word-count/user-check/:user_id` | Account-vs-audit forensic check: user row, audit summary, IPs, recent logins. |
| `GET /api/admin/changelog` | (Sibling endpoint) git-log changelog for the same date range. |

### DB tables

- **`audit_log`** — the sole data source (read-only here).
- **`users`** — joined by the Verify-user check.

---

## 11.2 Location Tracking

### Business purpose

Shows where each employee is, using the GPS pings already collected by the
Attendance page. Two questions it answers: "where is everyone **right now**"
(Live) and "where did one person go **between punch-in and punch-out**"
(Timeline).

### Who uses it

Admin only. Frontend: `client/src/pages/admin/Locations.jsx`. API:
`server/routes/locations.js` (mounted at `/api/admin/locations`, `adminOnly`).

### Data source (what is automated)

No new write path. The Attendance page pings
`/attendance/track-location` every ~30 seconds while open, inserting into the
**`location_tracking`** table. These admin views are **read-only** over that
data. Users can be excluded via `users.track_location = 0` (set from User
Management; admins and named excludes opt out). `COALESCE(track_location, 1)`
means legacy users default to tracked.

### Geofence sites

Registered sites (office / project geofences) live in **`geofence_settings`**
(`site_name`, `latitude`, `longitude`, `radius_meters` default 200, `active`).
A ping's `site_name` is resolved against these circles by the attendance write
path; the Timeline view overlays active geofences as faint blue circles on the
route map.

### Live tab

One card per user showing their **most recent** ping inside a staleness window
(5 min – 12 hours; default 30, auto-refresh every 60 s). Each card classifies
the user:

- **Site name (green)** — pinging now, inside a registered site.
- **Outside any site (amber)** — pinging now, not in any geofence.
- **OFFLINE — last at X (grey)** — no ping for 15+ min (`FRESH_MAX_MIN`); the
  cached site label is shown as stale so a green pill doesn't "lie" that they're
  still there.
- **GPS OFF (red)** — network reached the server but no GPS fix (permission
  denied / timed out); stored as `site_name = 'GPS_OFF'`.

Status chips count and filter each bucket. Each card links to **Google Maps**
and to that user's **Today's Timeline**.

### Timeline tab

Pick an employee + date. Shows punch-in/out times & addresses, hours worked,
total distance moved, and ping count, plus an embedded **route map** (red
polyline, green start / red last-seen markers, blue geofence circles) and a
movement table. Each ping is tagged by **phase** — `before` in / `during` work
/ `after` out — based on the attendance punch times, and carries the
straight-line distance from the previous ping (Haversine).

A **teleport detector** flags any ping requiring sustained travel above
**120 km/h** (`SUSPICIOUS_KMH`) as `suspicious` (likely fake-GPS app or
cell-tower glitch). Suspicious pings are tagged ⚠ FAKE, **excluded from total
distance**, and dropped from the drawn route. A "Draw Route on Google Maps"
button down-samples to ≤11 points (Google free-tier waypoint limit).

### API endpoints

| Method & path | Purpose |
|---|---|
| `GET /api/admin/locations/live` | Latest ping per user within `?stale_minutes=` (1–720, default 30); skips opted-out users; sorts GPS-off first, then in-site, then most-recent. |
| `GET /api/admin/locations/timeline` | `?user_id=&date=YYYY-MM-DD` — all pings for one user/day with distance-from-previous, phase tags, suspicious flags, attendance punches, and active geofences. |
| `GET /api/admin/locations/users` | Picker list — distinct users who have any ping and haven't opted out. |

### DB tables

- **`location_tracking`** — GPS pings (read here, written by Attendance).
- **`geofence_settings`** — registered site circles.
- **`attendance`** — punch in/out times & addresses for phase tagging.
- **`users`** — names, departments, `track_location` opt-out.

---

## 11.3 Database Backups

### Business purpose

Protects the single-file SQLite database against corruption / accidental wipes.
A consistent snapshot is taken automatically every night, the last 30 are kept
on disk, and admin can download any of them (or trigger one on demand) before a
risky operation.

### Who uses it

Admin only. Frontend: `client/src/pages/admin/DatabaseBackups.jsx`. API:
`server/routes/backups.js` (mounted at `/api/admin/backups`, `adminOnly`).
Backup engine: `server/scripts/backup-db.js`.

### How it works (what is automated)

- **Safe snapshots.** Uses `better-sqlite3`'s native `.backup()` API rather
  than a file copy. SQLite runs in WAL mode, so a plain `cp` could grab the DB
  mid-write and corrupt it; the backup API produces a guaranteed-consistent copy
  even while the server is writing.
- **Nightly schedule.** `scheduleNightly()` (started from `server/index.js` on
  boot) runs a backup at **02:00 local time** using a self-rescheduling
  one-shot `setTimeout` (so DST/timezone shifts are picked up each day). Can be
  disabled with `ERP_DISABLE_BACKUP_SCHEDULER=1`.
- **Retention.** Keeps the most recent **30** backups (`KEEP_COUNT`); older
  files are deleted on each run.
- **Storage location.** `ERP_BACKUP_DIR` env override, else `/root/erp-backups`
  on the VPS or `../../backups` on Windows — deliberately **outside** the
  `data/` folder so a data wipe doesn't also nuke the backup history.
- **Filenames.** `erp-YYYY-MM-DD_HH-mm-ss.db`.

### Main screen / fields

- Summary cards: total backups, latest-backup age + timestamp, storage path.
- A blue recommendation banner nudging mam to **Download** the latest backup
  weekly to a cloud-synced laptop folder (VPS backups don't survive losing the
  VPS itself).
- Backup table: filename (latest tagged), created time, size, and a per-row
  **Download** button.
- **Backup Now** button for ad-hoc snapshots.

### API endpoints

| Method & path | Purpose |
|---|---|
| `GET /api/admin/backups` | List backups (filename, size, created_at) + the backup directory. |
| `POST /api/admin/backups/run` | Trigger a backup immediately; returns the new filename + size. |
| `GET /api/admin/backups/:file/download` | Stream a backup file for download. Filename is validated against the strict `erp-…​.db` pattern so the route can't be abused to read arbitrary VPS files. |

### DB tables

None — backups operate on the database **file** (`data/erp.db`), not on a
table. The list is built from the filesystem.

---

## 11.4 AI Agent ("Ask ERP" assistant)

### Business purpose

A floating "Ask ERP" chat bubble available on every page that answers natural-
language questions about SEPL's own data, searches the live web for market
prices, and trains staff through built-in module guides — in English or Hindi.
mam's framing: *"real ai agent which scan from all over not only from my ERP."*

### Who uses it

- The **chat bubble** is shown to any user with the `ai_agent.view` permission
  (component `client/src/components/AIAgentChat.jsx`); it checks
  `/api/ai-agent/status` to render only when configured.
- The **AI Settings** page is **admin-only**: `client/src/pages/AISettings.jsx`,
  backed by `server/routes/aiAgent.js`.

### What the assistant can do

The `/ask` endpoint gives Claude **three tools**:

1. **`query_database`** — runs a single **read-only** SQL query (`SELECT`/`WITH`
   only) against an allow-listed set of business tables (`READABLE_TABLES` —
   leads, customers, item_master, quotations, POs, payments, DPR, attendance,
   employees, etc.; sensitive auth tables are excluded). A `validateSelect`
   filter rejects multiple statements and any mutating keyword
   (`INSERT/UPDATE/DELETE/DROP/ALTER/PRAGMA/…`), and a `capSql` guard auto-adds
   `LIMIT 501` when a query has none (max 500 rows returned). The schema digest
   is injected into the system prompt.
2. **`web_search`** — Anthropic server-side web search, used proactively for
   material/commodity prices, GST lookups, vendor details, etc. The assistant
   presents the ERP's stored rate **and** today's market rate side by side.
3. **`get_module_guide`** — returns built-in step-by-step guides for major
   workflows (DPR, Indent, Price Required, Vendor PO, Purchase Bill, Sales Bill,
   Delivery Challan, Order Planning, Business Book, Quotation, Cash Flow,
   Expense, Attendance, DPR loss alert) so the bot can train staff when asked
   "how to…" / "kaise karte hai…".

The assistant **can only READ** — it cannot edit, delete, or send anything. The
system prompt also injects the **current user's identity** (name, role,
designation) so "who am I / show my attendance" works without re-asking, and
instructs Hindi/Roman-Hindi replies for training questions while keeping module
and button names in English.

The agent loops up to `MAX_TOOL_ITER` (5) tool rounds. Responses are streamed
with a 12 s whitespace **heartbeat** (and `X-Accel-Buffering: no`) so nginx's
60 s `proxy_read_timeout` doesn't kill long Opus + web-search calls; the overall
Anthropic timeout is 150 s. Errors ride back in the JSON body (status is locked
to 200 once streaming starts) and the frontend checks `data.error` before
`data.answer`.

### Where the API key is set, and the model

- The **Anthropic API key** is pasted in **Admin → AI Settings** and stored
  server-side in the **`app_settings`** key-value table under `ai_api_key`
  (no `.env` edit, no SSH). `GET /settings` only returns a **masked** key
  (`sk-ant-…​abcd`) and an `api_key_set` flag — the secret is never sent back to
  a browser.
- **Provider** (`ai_provider`) is `anthropic` (the only option).
- **Model** (`ai_model`) is selectable in the UI. Adaptive thinking +
  `effort: high` + web search are enabled for Opus / Sonnet-4.6-class models
  (`supportsAdaptive` regex); the default stored model id is `claude-opus-4-7`.
  (Note: the in-product UI model picker labels may lag the deployed default —
  the authoritative default is whatever `app_settings.ai_model` holds, falling
  back to `claude-opus-4-7`.)

There is also a **rate-intelligence** feature on this router (used inside the
BOQ form, gated by `quotations.view`): `/rate-suggestion` and `/item-history`
surface the last rate quoted to a client + 6-month stats from
`item_price_history`.

### API endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/ai-agent/settings` | admin | Provider, model, `api_key_set`, masked key. |
| `PUT /api/ai-agent/settings` | admin | Save provider / model / API key. |
| `GET /api/ai-agent/status` | `ai_agent.view` | Whether the chatbot is configured (so the bubble renders). |
| `POST /api/ai-agent/ask` | `ai_agent.view` | The chatbot — `{ question, history? }` → `{ answer, sql_runs, … }`. |
| `GET /api/ai-agent/rate-suggestion` | `quotations.view` | Last-quoted + 6-month rate stats for a BOQ item. |
| `GET /api/ai-agent/item-history` | `quotations.view` | Full price history for an item. |

(The same router also hosts the **Email Settings** endpoints — see §11.5.)

### DB tables

- **`app_settings`** — stores `ai_provider`, `ai_api_key`, `ai_model`.
- **`item_price_history`**, `item_master`, `leads` — rate-intelligence reads.
- All `READABLE_TABLES` — read at query time by the chatbot's SQL tool.

---

## 11.5 Email (SMTP) Settings

### Business purpose

Holds the outbound SMTP credentials the ERP uses to send automated mail — the
DPR loss-streak alert to the director and, more broadly, every Email Trigger
(§11.6). Like the AI key, it's configured inside the ERP so mam can paste Gmail
/ SendGrid / Mailgun credentials without touching `.env`.

### Who uses it

Admin only. Frontend: `client/src/pages/EmailSettings.jsx`. API: the
`server/routes/aiAgent.js` router (`/api/ai-agent/email-settings`, `adminOnly`).
Sending helper: `server/lib/email.js`.

### Main screen / fields

| Field | Setting key | Notes |
|---|---|---|
| SMTP Host | `email_smtp_host` | e.g. `smtp.gmail.com` |
| Port | `email_smtp_port` | default `587` |
| Use TLS/SSL | `email_smtp_secure` | `'1'` for 465/TLS, blank for STARTTLS |
| Username (full email) | `email_smtp_user` | |
| Password / App Password | `email_smtp_pass` | never echoed back; only a masked tail is returned. **Gmail needs a 16-char App Password** — a normal password will not work |
| From address | `email_from` | optional display From; falls back to the SMTP user |
| Director email | `email_director_to` | default alert recipient; falls back to `director@securedengineers.com` |

A status banner shows configured / not-configured, and a **Send test** button
mails a confirmation to a chosen address.

### How it works (what is automated)

`lib/email.js` builds a `nodemailer` transport from the `app_settings` keys.
`sendEmail()` is **graceful**: if host/user/pass aren't all set it returns
`{ skipped: true }` instead of throwing, so callers (loss-streak alert, email
triggers) never break their own request path when SMTP is unconfigured.
`nodemailer` is lazy-required so the server still boots without it in dev. A
per-call `from` override is supported (used by per-rule dynamic senders), though
Gmail/most providers only honour a From that matches the authenticated account
or a verified alias.

### API endpoints

| Method & path | Purpose |
|---|---|
| `GET /api/ai-agent/email-settings` | Return SMTP config (password masked, `pass_set` flag). |
| `PUT /api/ai-agent/email-settings` | Save SMTP config. |
| `POST /api/ai-agent/email-test` | Send a test email (defaults to the director address). |

### DB tables

- **`app_settings`** — all `email_*` keys.

---

## 11.6 Email Triggers (rule-based automated emails)

### Business purpose

Lets admin build **dynamic email rules**: *when `<event>` fires AND
`<conditions>` match, email `<recipients>` using a `{{variable}}` template.*
This generalises one-off alerts into a configurable engine
(mam 2026-06-03: *"lots of email with trigger and pattern, dynamic"*).

### Who uses it

Admin only (rule CRUD). Frontend: `client/src/pages/EmailTriggers.jsx`. API:
`server/routes/emailRules.js` (`/api/email-rules`). Engine:
`server/lib/emailRules.js`. Event catalog: `server/lib/emailEvents.js`. It sends
through the same SMTP transport as §11.5.

### Main screen / fields

The page lists existing rules (name, event, recipients summary, ON/OFF toggle,
last-fired + fire count, and test/edit/delete actions). The rule editor modal
captures:

- **Event** — chosen from a grouped catalog (Indent, DPR & Site, Payments &
  Bills, Complaints & Support, HR).
- **Recipients** — any combination of: **from the record** (dynamic people such
  as the indent raiser, project CRM owner, director); **by role** (every active
  user holding the role, resolved live from `users`/`user_roles`/`roles`); and a
  **fixed** comma/newline list.
- **Conditions** (optional, AND-combined) — `field op value` rows with operators
  `equals / not equals / contains / > / <`. Empty = always send.
- **Template** — optional per-rule **From**, a **Subject** template, and a
  **Body** template, all with click-to-insert `{{variable}}` tokens drawn from
  the selected event's `vars`.
- **Enabled** checkbox (pause without deleting).

A **Send test** action renders the rule with realistic `SAMPLE_CONTEXT` data and
can force a recipient so the admin previews it on themselves.

### How it works (what is automated)

Server code calls `fireEmailEvent(eventKey, context)` at the relevant moment
(e.g. `indent.approved`, `dpr.loss_streak`, `payment.requested`,
`complaint.created`, `leave.requested`). This is **fire-and-forget**
(`setImmediate`, never throws into the request path). The engine then, for each
**enabled** rule on that event:

1. Evaluates conditions against the context (all must pass).
2. Resolves recipients (dynamic-from-record emails + fixed list + by-role
   users); skips if none resolve.
3. Renders the subject/body/From templates (`{{var}}` substitution, case- and
   space-tolerant; body escaped to minimal HTML preserving line breaks).
4. Sends via `lib/email.sendEmail`, then stamps `last_fired_at` and increments
   `fire_count`.

Events are **wired in across the codebase** — `fireEmailEvent` is called from
`procurement.js`, `paymentrequired.js`, `dpr.js`, `attendance.js`, `support.js`,
`complaints.js`, and `index.js`. Adding a new trigger source = (1) add an entry
to `emailEvents.js`, (2) call `fireEmailEvent(key, context)` with the documented
`vars` and `*_email` people; the UI and engine pick it up automatically.

### Event catalog (live events)

| Group | Event key | Fires on |
|---|---|---|
| Indent | `indent.raised`, `indent.crm_approved`, `indent.l1_approved`, `indent.approved`, `indent.rejected` | Indent lifecycle stages |
| DPR & Site | `dpr.loss_streak` | 3+ consecutive site loss days |
| Payments & Bills | `payment.requested`, `payment.approved`, `payment.rejected`, `bill.uploaded` | Payment approval flow & purchase bills |
| Complaints & Support | `complaint.created`, `complaint.assigned`, `complaint.resolved`, `ticket.created`, `ticket.resolved` | Complaint / help-ticket lifecycle |
| HR | `leave.requested`, `leave.decided`, `task.assigned` | Leave & delegation events |

Each event declares its `vars` (template variables), `people` (dynamic
recipient emails resolvable from context), and condition-able `fields`.

### API endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/email-rules/events` | auth | Event catalog + role list + sample context (drives the editor). |
| `GET /api/email-rules` | admin | List all rules. |
| `POST /api/email-rules` | admin | Create a rule. |
| `PUT /api/email-rules/:id` | admin | Update a rule. |
| `PUT /api/email-rules/:id/toggle` | admin | Enable/disable. |
| `DELETE /api/email-rules/:id` | admin | Delete. |
| `POST /api/email-rules/:id/test` | admin | Send a test render of one rule. |

### DB tables

- **`email_rules`** — one row per rule (`event_key`, `enabled`, `conditions`
  JSON, `recipients` JSON, `from_addr`, `subject_tpl`, `body_tpl`,
  `last_fired_at`, `fire_count`).
- **`users` / `user_roles` / `roles`** — recipient resolution "by role".
- **`app_settings`** — SMTP credentials used to actually send (via §11.5).

---

## 11.7 Audit Log

### Business purpose

A tamper-evidence trail of **every mutating request** (create / update / delete,
plus custom actions like login). It's both a compliance/forensics record and the
raw data behind the Activity Log (§11.1).

### Who uses it

Admin only. Frontend: `client/src/pages/admin/AuditLog.jsx`. Query API:
`server/routes/audit.js` (`/api/admin/audit`, `adminOnly`). Capture:
`server/middleware/audit.js`.

### How it works (what is automated)

`auditMiddleware` runs **after** `authMiddleware` (so `req.user` is set) and, on
response `finish`, inserts a row into **`audit_log`**. Key behaviours:

- **Non-blocking** — logging is fire-and-forget; any exception inside the
  middleware is swallowed so it can never crash or slow the real request.
- **Mutating methods only** — POST/PUT/PATCH/DELETE; the action is auto-derived
  (`POST→CREATE`, `PUT/PATCH→UPDATE`, `DELETE→DELETE`).
- **Secret stripping** — body keys `password`, `current_password`,
  `new_password`, `token`, `authorization`, `secret` are `[REDACTED]` before the
  body is summarised; the summary is capped at 2000 chars.
- **Entity inference** — `entity_type` is the path segment after `/api/`;
  `entity_id` is the last numeric path segment.
- **Captured context** — user id/name/role, method, path, query, body summary,
  status code, **IP** (`x-forwarded-for` first hop), and **user-agent**.
- **Noise filter** — `SKIP_PATH_PREFIXES` excludes high-frequency / read-y
  endpoints (location pings, `/api/dashboard`, `/api/audit` itself, uploads,
  `/api/auth/me`, `/api/auth/login`). Login is logged by the login route itself
  (with proper attribution and `LOGIN_FAIL` rows), avoiding `(unknown)`
  duplicates.
- **Opt-out / debug** — `ERP_DISABLE_AUDIT=1` disables capture;
  `ERP_AUDIT_DEBUG=1` logs each step.

A helper **`logAuditEvent()`** lets routes record richer entries manually —
friendly `entity_label`, custom actions (`APPROVE` / `REJECT` / `LOGIN` /
`LOGIN_FAIL`), and `before_json` / `after_json` snapshots.

### Main screen / fields

- Summary strip: total entries, unique users, modules logged, action types.
- Filters: free-text search (path / body / label / user), user, module
  (`entity_type`), action, and date range; paginated (default 50, max 500/page).
- Action pills are colour-coded (CREATE green, UPDATE blue, DELETE red, LOGIN
  violet, LOGIN_FAIL red); status code coloured by HTTP class.
- Click a row to view its full body and optional before/after snapshot.

### API endpoints

| Method & path | Purpose |
|---|---|
| `GET /api/admin/audit` | Filtered, paginated list (`user_id`, `entity_type`, `action`, `date_from`, `date_to`, `q`, `page`, `limit`). |
| `GET /api/admin/audit/meta` | Distinct users / entity types / actions for the filter dropdowns. |
| `GET /api/admin/audit/:id` | One entry with full before/after JSON. |

> Note: there is a separate **`/audit`** (no `/api` prefix, `routes/auditReport.js`)
> that serves the external "CMD Audit" KPI/exception report for the scheduled
> daily-audit email — that is a reporting endpoint, distinct from this
> activity Audit Log.

### DB tables

- **`audit_log`** — the single capture table (`at`, `user_id`, `user_name`,
  `user_role`, `action`, `entity_type`, `entity_id`, `entity_label`, `method`,
  `path`, `query`, `body_summary`, `status_code`, `ip`, `user_agent`,
  `before_json`, `after_json`). Indexed post-migration.

---

## 11.8 Users, Roles & Permissions (cross-reference)

User accounts, the role catalogue, and the granular module-level
view/create/edit/approve permission grid are managed under
**Administration** as well, but are documented in full in **Section 1**. They
intersect with this section in three places:

- **Email Triggers** resolve "by role" recipients from `users` / `user_roles` /
  `roles` (§11.6).
- **Location Tracking** honours the per-user `users.track_location` opt-out flag
  set from User Management (§11.2).
- The **AI chatbot** is gated by the `ai_agent.view` permission, while the AI
  key settings page is admin-only (§11.4).

See **Section 1** for the complete user/role/permission model.
