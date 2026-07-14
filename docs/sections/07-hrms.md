# 7. HRMS (Human Resources)

The HRMS is the people-side of the SEPL ERP. It runs end-to-end: raise a
hiring requirement, source and screen candidates, interview, generate an
offer, onboard, induct, train, track attendance on-site by GPS geofence,
run monthly payroll with attendance-driven day rules, manage the employee
master, score weekly performance (MIS scorecards), and maintain the
sub-contractor hiring workflow + sub-contractor master.

There are **two parallel hiring stacks** in the codebase:

| Stack | Frontend | Backend | Mount | Status |
|-------|----------|---------|-------|--------|
| **HR (Phase-1 ATS)** — the live, full-featured hiring/onboarding/training system | `client/src/pages/HR.jsx` | `server/routes/hr.js` | `/api/hr` | Active, complete |
| **HR System (legacy funnel)** — an earlier candidate-funnel prototype | `client/src/pages/HRSystem.jsx` | `server/routes/hrSystem.js` | `/api/hr-system` | Partial (onboarding + training tabs are stubs) |

This section documents both but treats **HR.jsx / hr.js** as the canonical
hiring system. Each module below is its own `##` heading.

Source files referenced:

- Hiring (ATS): `client/src/pages/HR.jsx` (~115 KB), `server/routes/hr.js` (~137 KB)
- Hiring (legacy funnel): `client/src/pages/HRSystem.jsx`, `server/routes/hrSystem.js`
- Public offer accept: `server/routes/publicHr.js`, `client/src/pages/PublicOffer.jsx`
- Print: `client/src/pages/OfferLetterPrint.jsx`, `NDAPrint.jsx`, `EmploymentAgreementPrint.jsx`
- Sub-contractor hiring: `client/src/pages/SubconHiring.jsx`, `server/routes/subconHiring.js`
- Onboarding: `client/src/pages/Induction.jsx` (+ Induction tab in HR.jsx)
- Training: `client/src/pages/Training.jsx` (+ Training tab in HR.jsx)
- Attendance: `client/src/pages/Attendance.jsx` (~95 KB), `server/routes/attendance.js` (~51 KB)
- Payroll: `client/src/pages/Payroll.jsx`, `server/routes/payroll.js`, `client/src/pages/SalarySlipPrint.jsx`
- Employees: `client/src/pages/Employees.jsx`
- Performance: `client/src/pages/Scorecard.jsx`, `server/routes/scoring.js`, `server/db/seedScoring.js`
- Sub-contractor master: `client/src/pages/SubContractors.jsx`, `server/routes/subcontractors.js`
- HR automations cron: `server/scripts/hrAutomationsCron.js`

---

## 7.1 Hiring — Applicant Tracking System (ATS)

### Business purpose

Run the full recruitment funnel in one place: a manager raises a hiring
request, HR approves it and opens the position, candidates are added and
screened (with optional auto-reject rules), interviewed by an employee
panel, sent to an MD final round, and finally issued an auto-generated
offer letter the candidate can accept online without logging in.

### Who uses it

- **Hiring managers** — raise hiring requests.
- **HR** — approve requests, manage candidates, schedule interviews, run
  screening, generate offers, manage JD/screening/final-round content.
- **Interviewers (employees)** — receive scheduled interviews and submit
  scorecards.
- **MD** — runs the final round and the shortlist/reject + offer decision.
- **Candidates** — receive offer link, accept/decline via public page.

### Main screen & tabs

`HR.jsx` renders a top tab bar (all server-backed):

| Tab | Purpose |
|-----|---------|
| **Dashboard** | Funnel counts, open positions, pipeline summary |
| **Manpower Plan** | Required vs actual manpower per project (see 7.1.7) |
| **Candidates (ATS)** | Kanban-style pipeline by stage |
| **Hiring Requests** | Manager-raised requirements + approvals |
| **Job Descriptions** | JD templates + per-position JDs |
| **Screening Qs** | Per-position / global screening question bank |
| **Final-Round Qs** | MD final-round question bank |
| **Induction Content** | Onboarding content manager (see 7.4) |
| **Training Library** | Training videos + assignments (see 7.5) |

The **Candidates** tab groups candidates into pipeline columns:

| Column | Label |
|--------|-------|
| applied | 1 · APPLIED |
| screening | 2 · SCREENING |
| interview | 3 · INTERVIEW |
| final_round | 4 · FINAL ROUND |
| selected | 5 · SELECTED |
| rejected | REJECTED |
| on_hold | ON HOLD |

### 7.1.1 Candidate stages (status machine)

The `candidates.status` column is a CHECK-constrained enum. The
HR.jsx status badges map raw status → human label:

| `status` value | UI label | Next action |
|----------------|----------|-------------|
| `lead` | New Lead | schedule_interview |
| `called` | Called | screening |
| `interview_scheduled` | Interview Scheduled | interview_done |
| `interview_done` | Interview Done · pending decision | interview_decision |
| `qualified` (no MD date) | Shortlisted · MD round pending | schedule_md |
| `qualified` (MD date set) | MD Interview Scheduled | md_decision |
| `offer_sent` | Offer Sent | finalize |
| `accepted` | Offer Accepted | finalize |
| `onboarded` | Onboarded ✓ | — |
| `rejected` | Rejected | — |

An overlay flag `is_on_hold` (+ `hold_reason`) can be toggled at **any**
pipeline stage without changing `status`.

### 7.1.2 Step-by-step hiring workflow

1. **Raise hiring request** — manager `POST /hr/hiring-requests` with
   department, position_title, num_openings, salary range, experience,
   employment_type, hiring_deadline, reporting_manager_id, JD blurb.
   Status starts `pending`.
2. **HR approves / rejects** — `POST /hr/hiring-requests/:id/approve`
   (or `/reject`). Separation of duties: the cron will not nudge the
   requester to approve their own request.
3. **Add candidate** — `POST /hr/candidates` (optionally linked back to a
   `hiring_request_id`). Resume can be auto-parsed first via
   `POST /hr/candidates/parse-resume` (file upload → text extraction →
   pre-filled fields; file is saved even if parse fails).
4. **Screening** — HR submits screening answers
   `POST /hr/candidates/:id/screening-answers`. Auto-reject rules
   evaluate each answer; a tripped rule sets `eligibility_status` /
   `eligibility_reason` and can flag the candidate as ineligible.
5. **Schedule interview** — `POST /hr/candidates/:id/schedule-interview`
   with `interviewer_id` (an employee) + `interview_date`. Status →
   `interview_scheduled`. Writes a `candidate_events` timeline row.
6. **Interview decision** — `POST /hr/candidates/:id/interview-done` with
   decision:
   - `shortlisted` → status `qualified` (waiting for MD round)
   - `rejected` → status `rejected`
   - `on_hold` → status `interview_done` (HR returns later)
   - Interviewer may also file a scorecard (see 7.1.4).
7. **Schedule MD round** — `POST /hr/candidates/:id/schedule-md-interview`
   sets `md_interview_date`; status stays `qualified` (the date being set
   marks the final round).
8. **MD decision** — `POST /hr/candidates/:id/md-decision` with decision:
   - `shortlisted` → status `offer_sent`; the offer letter is
     **auto-generated** from `offered_position` (required), `offered_salary`,
     `joining_date`, `reporting_to`, optional `salary_breakup` JSON. A
     single-use **offer_token** (32 random bytes, base64url ≈ 43 chars) is
     generated and `offer_sent_at` is stamped. Re-saving the decision
     preserves the existing token so already-shared accept links keep working.
     There is **no upload path** — letters are always system-generated.
   - `rejected` → status `rejected`.
9. **Candidate accepts/declines** — via the public link (see 7.2), or HR
   marks final state via `POST /hr/candidates/:id/finalize`
   (`accepted` / `onboarded` / `rejected`).

Every transition writes to `candidate_events` (`GET /hr/candidates/:id/timeline`
returns the chronological audit log). Free-form CSV tags
(`PUT /hr/candidates/:id/tags`) and the hold toggle
(`POST /hr/candidates/:id/hold`) are also logged.

### 7.1.3 Hiring requests & approvals

`hiring_requests` holds: department, position_title, num_openings,
salary_min/max, experience_required, employment_type
(`full_time | part_time | contract | internship | freelance`),
hiring_deadline, reporting_manager_id, job_description, status
(`pending | approved | rejected | closed`), approval_notes, requested_by
(+ denormalised requested_by_name), approved_by/approved_at, closed_at.

Approval is a single HR/admin action — there is no multi-level chain on
hiring requests (unlike Payment Required, which uses L1→L2→L3).

### 7.1.4 Job descriptions, screening, scorecards, final-round bank

- **JD templates** (`jd_templates`) — reusable skeletons (Site Engineer,
  Sales Executive, etc.), `template_content` is a JSON blob, `is_default`.
- **Job descriptions** (`job_descriptions`) — one JD per position, can be
  derived from a template and linked to the hiring_request. Stores two
  flavours side by side: `internal_jd` (full HR/manager detail) and
  `public_job_post` (sanitised for Naukri / LinkedIn). Status:
  `draft | published | archived`.
- **Screening questions** (`screening_questions`) — per-position
  (hiring_request_id set) or global (NULL). Types: `mcq | descriptive |
  yes_no | number`. Optional **auto-reject rules engine**:
  `auto_reject_op` ∈ `gt, lt, gte, lte, eq, neq, contains, not_contains,
  in, not_in`, with `auto_reject_value` and `auto_reject_reason`. A NULL op
  means info-only. Submitting a screening form deletes-and-reinserts the
  candidate's answers so re-screening doesn't double-count.
- **Interview scorecards** (`interview_scorecards`) — one row per
  (candidate × interviewer × stage). Stage = `first` (interviewer round)
  or `final` (MD round). Four 1–5 dimension scores (technical,
  communication, culture_fit, problem_solving) plus an explicit verdict
  `overall_recommend` ∈ `strong_yes, yes, maybe, no, strong_no`, and
  strengths/weaknesses/overall_feedback.
- **Final-round question bank** (`final_round_questions`) — curated MD/panel
  questions by category (Leadership / Ownership / Decision Making / Conflict
  Management / Team Handling), `for_role` free-text tag, difficulty
  (`easy | medium | hard`). `GET /hr/final-round-questions/pick` pulls a set.

### 7.1.5 Pre-onboarding document checklist

`candidate_docs` tracks one row per (candidate × doc_type). Standard
doc_type values: `aadhaar, pan, resume, experience, bank, photo,
education, other` (free-text, so admin can add custom). Status:
`pending | received | verified | rejected`, with verified_at/verified_by.
Managed via `GET/POST /hr/candidates/:id/docs`, `PUT/DELETE /hr/docs/:id`.

### 7.1.6 Notifications

`notifications` rows are created both by direct admin actions and by the
HR automations cron (7.1.8). Fields: user_id (recipient), type
(`interview_reminder | offer_expiry | approval_pending | training_assigned
| generic`), title, body, link_url, channel_sent (CSV `in_app,email`),
dedupe_key, read_at. Read/clear via `GET /hr/my-notifications`,
`PUT /hr/notifications/:id/read`, `POST /hr/notifications/mark-all-read`.

### 7.1.7 Manpower Plan tab

`GET /hr/manpower-plan` joins `business_book` (projects), `sites`, and DPR
manpower (`dpr_contractors.manpower`, falling back to legacy
`dpr.contractor_manpower`) to show **required vs actual** manpower per
project. Required is driven by a per-project value slab; admins can
override required (`PUT /hr/manpower-plan/required`) and category
(`PUT /hr/manpower-plan/category`). Stored in `manpower_required_overrides`
and `manpower_project_settings`.

### 7.1.8 Automation — HR automations cron (every 30 min)

`server/scripts/hrAutomationsCron.js` runs 10 s after boot then every
**30 minutes** (`setInterval`, 30·60·1000 ms). Disabled via
`ERP_DISABLE_HR_CRON=1`. Each run scans three triggers and creates in-app
notifications (+ best-effort email via `server/lib/email.js`), with a
`dedupe_key` so re-runs don't spam:

| Scanner | Trigger | Recipient | dedupe_key |
|---------|---------|-----------|------------|
| Interview Reminder | candidate `interview_scheduled` with `interview_date` in next 24 h | the interviewer (employee→user) | `interview_reminder:<cand>:<date>` |
| Offer Expiry Reminder | `offer_sent`, `offer_sent_at` ≥ 7 days old, no accept/decline | all HR users (re-triggers daily) | `offer_expiry:<cand>:<dayBucket>` |
| Approval Pending Alert | `hiring_requests` still `pending` > 24 h | all HR users **except the requester** | `approval_pending:<req>:<dayBucket>` |

"HR users" = active users where role is `admin`, or department/role name
contains `hr`. Email send failures never block the in-app notification.

### 7.1.9 ATS API endpoints (`/api/hr`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/manpower-plan` | Required vs actual manpower |
| PUT | `/manpower-plan/required` | Override required count |
| PUT | `/manpower-plan/category` | Override category settings |
| POST | `/candidates/parse-resume` | Upload + parse resume |
| GET | `/candidates` | List candidates |
| POST | `/candidates/check-duplicates` | Dedupe check |
| POST | `/candidates` | Create candidate |
| PUT/DELETE | `/candidates/:id` | Edit / delete |
| POST | `/candidates/:id/schedule-interview` | Stage 1 interview |
| POST | `/candidates/:id/interview-done` | Interview decision |
| POST | `/candidates/:id/schedule-md-interview` | Schedule MD round |
| POST | `/candidates/:id/md-decision` | MD decision + auto-offer |
| GET | `/candidates/:id` | Candidate detail (offer print) |
| POST | `/candidates/:id/finalize` | Final accepted/onboarded/rejected |
| GET | `/candidates/:id/timeline` | Audit timeline |
| PUT | `/candidates/:id/tags` | Tags |
| POST | `/candidates/:id/hold` | Toggle on-hold |
| GET | `/candidates/stats` | Funnel stats |
| GET/POST | `/hiring-requests` | List / create |
| GET | `/hiring-requests/:id` | Detail |
| PUT/DELETE | `/hiring-requests/:id` | Edit / delete |
| POST | `/hiring-requests/:id/approve` | Approve |
| POST | `/hiring-requests/:id/reject` | Reject |
| POST | `/hiring-requests/:id/close` | Close position |
| GET/POST/PUT/DELETE | `/jd-templates[/:id]` | JD templates |
| GET/POST/PUT/DELETE | `/job-descriptions[/:id]` | Job descriptions |
| GET/POST | `/candidates/:id/scorecards` · `/scorecard` | Interview scorecards |
| DELETE | `/scorecards/:id` | Remove scorecard |
| GET | `/final-round-questions` · `/pick` | Final-round bank |
| POST/PUT/DELETE | `/final-round-questions[/:id]` | Manage bank |
| GET/POST/PUT/DELETE | `/screening-questions[/:id]` | Screening bank |
| POST/GET | `/candidates/:id/screening-answers` | Submit / read answers |
| GET/POST | `/candidates/:id/docs` | Doc checklist |
| PUT/DELETE | `/docs/:id` | Update / delete doc |
| GET | `/my-notifications` | My notifications |
| PUT | `/notifications/:id/read` | Mark read |
| POST | `/notifications/mark-all-read` | Mark all read |
| GET | `/dashboard` | HR dashboard counts |

(Note: `hr.js` also hosts employees, sub-contractors, expenses, and
checklists routes — covered in their own sections.)

### 7.1.10 ATS DB tables

`candidates`, `candidate_events`, `candidate_docs`, `hiring_requests`,
`jd_templates`, `job_descriptions`, `interview_scorecards`,
`screening_questions`, `screening_answers`, `final_round_questions`,
`notifications`. (Plus `induction_items`, `training_videos`,
`training_assignments` — see 7.4 / 7.5.)

Key `candidates` columns (base + migrations): name, phone, email, source
(`facebook | naukri | linkedin | reference | other`), position, status,
resume_file, address, linkedin_url, tags, is_on_hold/hold_reason,
hiring_request_id, interviewer_id, interview_date/notes/decision,
md_interview_date/notes/decision, eligibility_status/reason/screened_at,
offered_position, offered_salary, joining_date, reporting_to,
salary_breakup, offer_letter_file, offer_sent_at, offer_token,
offer_accepted_at, offer_declined_at, offer_response_note.

---

## 7.2 Public offer-accept (no-login) & print outputs

### Public offer flow

When the MD shortlists a candidate, a single-use `offer_token` is minted.
The candidate receives a link to `/offer/:token` (rendered by
`PublicOffer.jsx`). This path is served by `server/routes/publicHr.js`,
mounted at `/api/public/offer/*` **before** the global auth middleware, so
it needs no SEPL login.

Security model:

- Token = 32 random bytes (base64url, ≈ 256 bits) → not brute-forceable.
- Single-use: response only allowed while status is `offer_sent`; once
  accepted/declined the POST returns `409` with the prior decision.
- Token length must be ≥ 16 chars to be accepted.
- Sensitive offer fields (salary, joining, breakup) ARE returned — that's
  the point — but no other candidate's data is exposed.

| Method | Path | Body | Effect |
|--------|------|------|--------|
| GET | `/api/public/offer/:token` | — | Returns offer for inline render |
| POST | `/api/public/offer/:token/respond` | `{decision:'accept'\|'decline', note?}` | `accept` → status `accepted` + `offer_accepted_at`; `decline` → status `rejected` + `offer_declined_at`; logs a `candidate_events` row (user_name = candidate via link) |

`hrSystem.js` has its own variant: `POST /api/hr-system/offers/:id/send`
(stamps offer_sent_at + token) and `POST /api/hr-system/offers/accept/:token`.

### Print pages

| Page | Source | Notes |
|------|--------|-------|
| **Offer Letter** | `OfferLetterPrint.jsx` | Auto-generated from candidate fields. SEPL template: subject line, body, and a CTC table (Basic Pay / Conveyance Allowance / HRA / …). `salary_breakup` JSON overrides the default split; otherwise Basic = total and allowances render as "As per actual". Reads `GET /hr/candidates/:id`. |
| **NDA** | `NDAPrint.jsx` | Standard non-disclosure agreement print. |
| **Employment Agreement** | `EmploymentAgreementPrint.jsx` | Standard employment agreement print. |

These are print-ready (browser print → PDF) standalone pages.

---

## 7.3 Sub-contractor Hiring (14-step / 2-phase tracker)

### Business purpose

Track, per site, the journey of awarding work to a sub-contractor: from
project kickoff and BOQ scope split, through vendor sourcing, pre-qualify,
RFQ/negotiate, award, to onboarding (KYC, MSA+NDA, safety induction, work
order, mobilization, site entry). A manual workflow tracker with per-step
file uploads, a vendor candidate list, an award action, and two
"PASS" gates with loop-back.

### Who uses it

- **Phase 1 (Pre-Award, steps 1–7)** — owner: **PM + Procurement**.
- **Phase 2 (Onboarding, steps 8–14)** — owner: **Legal + HR + PM**.

### The 14 steps / 2 phases (`STEP_META`)

| # | Phase | Step | Gate |
|---|-------|------|------|
| 1 | pre_award | Project Kickoff | |
| 2 | pre_award | BOQ Scope Split | |
| 3 | pre_award | Source Vendors | |
| 4 | pre_award | Pre-Qualify | **gate: prequalify** — vendor score ≥ 7 → step 5, else loop to 3 |
| 5 | pre_award | RFQ & Negotiate | |
| 6 | pre_award | Award Decision | |
| 7 | pre_award | LOI to Vendor | → triggers Phase 2 |
| 8 | onboarding | KYC & Vendor Master | |
| 9 | onboarding | MSA + NDA | |
| 10 | onboarding | Safety Induction | |
| 11 | onboarding | Mobilization Plan | **gate: docs** — docs complete → 12, else loop to 8 |
| 12 | onboarding | Issue Work Order | |
| 13 | onboarding | Mobilization Advance | |
| 14 | onboarding | Site Entry & Setup | |

`phase` is derived: step ≤ 7 = `pre_award`, else `onboarding`. A workflow's
`phase` auto-recomputes from `current_step`.

### Workflow steps

1. **Create workflow** — `POST /api/subcon-hiring` with site_id +
   scope_description. Starts at step 1, phase `pre_award`, status `active`.
2. **Advance a step** — `POST /:id/step/:no` to set per-step status
   (`pending | in_progress | done | blocked`), notes, and a numeric
   `decision_value` (e.g. the Step-4 vendor score).
3. **Add vendor candidates** — `POST /:id/candidate` (vendor from the
   sub-contractor master, quote_amount, qualification_score 0–10).
   Edit/remove via `PATCH/DELETE /candidate/:cid`.
4. **Run a gate** — `POST /:id/gate/:gate` (`prequalify` or `docs`). Pass
   advances; fail loops back per the table above.
5. **Upload files per step** — `POST /:id/step/:no/upload` (max 20 MB,
   stored under `data/uploads/subcon-hiring/`). List/serve/delete via
   `/file/:fileId`.
6. **Award** — `POST /:id/award/:cid` sets `awarded_vendor_id` and marks the
   winning candidate `awarded`.
7. **Delete** — `DELETE /:id`.

### API endpoints (`/api/subcon-hiring`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | List workflows (with site + awarded vendor names) |
| GET | `/steps-meta` | STEP_META for UI labelling |
| GET | `/:id` | Detail (workflow + steps + candidates + files) |
| POST | `/` | Create workflow |
| POST | `/:id/step/:no` | Update a step |
| POST | `/:id/gate/:gate` | Run a gate (prequalify/docs) |
| POST | `/:id/step/:no/upload` | Upload a step file |
| GET/DELETE | `/file/:fileId` | Serve / delete a file |
| POST | `/:id/candidate` | Add vendor candidate |
| PATCH/DELETE | `/candidate/:cid` | Edit / remove candidate |
| POST | `/:id/award/:cid` | Award to a candidate |
| DELETE | `/:id` | Delete workflow |

All routes require `subcon_hiring` permission (view/create/edit/delete).

### DB tables

`subcon_hiring` (site_id, scope_description, current_step, phase, status,
awarded_vendor_id), `subcon_hiring_steps` (step_no, status,
decision_value, completed_by/at), `subcon_hiring_files` (per step file
metadata), `subcon_hiring_candidates` (vendor_id, quote_amount,
qualification_score 0–10, status `shortlisted | rejected | awarded`).

---

## 7.4 Onboarding / Induction

### Business purpose

Give new joiners a structured induction: founder message, company culture,
HR policies, IT-security, and SOPs, delivered as text blocks, videos, PDFs,
or links. Admin curates the content; new employees consume it.

### Screen

`Induction.jsx` (standalone page) plus the **Induction Content** tab inside
HR.jsx. Content is grouped by `section`:
`founder | culture | hr_policies | it_security | sop` (free-text, so custom
sections are possible).

### Key fields (`induction_items`)

section, title, content_type (`text | video | pdf | link`), content_url
(for video/pdf/link), content_text (body for text), order_index, is_active,
created_by.

### API (`/api/hr`)

| Method | Path |
|--------|------|
| GET | `/induction` |
| POST | `/induction` |
| PUT | `/induction/:id` |
| DELETE | `/induction/:id` |

Note: the legacy `HRSystem.jsx` Onboarding tab is a stub ("Document
collection, BG verification, joining checklist — wiring in the next
sprint"). The live onboarding doc-collection is the `candidate_docs`
checklist (7.1.5) plus this induction content.

---

## 7.5 Training (LMS)

### Business purpose

A lightweight learning library: admin uploads training videos categorised
by type, optionally targeting departments/roles and marking some mandatory;
videos are assigned to employees and completion is tracked.

### Screen

`Training.jsx` + the **Training Library** tab in HR.jsx. "My Training"
view shows an employee's assigned videos.

### Key fields

- **`training_videos`** — title, description, video_url (YouTube/Vimeo
  embed or direct file), training_type (`product | process | communication
  | sop | other`), duration_minutes, target_dept (CSV, NULL = any),
  target_role (CSV), is_mandatory, is_active, created_by.
- **`training_assignments`** — one row per (employee × video), UNIQUE.
  Status flow: assigned → started → completed (or skipped), with
  assigned_at / started_at / completed_at / completion_note / assigned_by.

### Workflow

1. Admin adds a video (`POST /hr/training/videos`).
2. Admin assigns to an employee (`POST /hr/training/videos/:id/assign`) —
   may also create a `training_assigned` notification.
3. Employee opens "My Training" (`GET /hr/training/mine`), starts
   (`POST /hr/training/assignments/:id/start`) and completes
   (`POST /hr/training/assignments/:id/complete`).

### API (`/api/hr`)

| Method | Path |
|--------|------|
| GET/POST | `/training/videos` |
| PUT/DELETE | `/training/videos/:id` |
| POST | `/training/videos/:id/assign` |
| GET | `/training/videos/:id/assignments` |
| DELETE | `/training/assignments/:id` |
| GET | `/training/mine` |
| POST | `/training/assignments/:id/start` |
| POST | `/training/assignments/:id/complete` |

---

## 7.6 Attendance

### Business purpose

GPS-geofenced, photo-stamped punch in/out for site staff, plus live
location tracking throughout the day, leave requests/approvals, an admin
attendance grid, and a geofence-violation audit. Attendance is the raw
input the payroll engine consumes.

### Who uses it

- **Site staff / engineers** — punch in/out from their assigned site; the
  app sends live location pings while open.
- **HR / admins** — admin-mark days, manage geofences, approve leaves,
  view the grid, dashboard, and geofence audit.

### Punch-in rules (geofence)

`POST /attendance/punch-in` requires `latitude`/`longitude` (GPS must be on)
and is **mandatory geofenced**:

1. At least one active `geofence_settings` row must exist (else punch is
   blocked with "Contact admin to add geofence areas").
2. The haversine distance from each active geofence centre is computed.
   **GPS-accuracy tolerance**: the reported `accuracy` is clamped to ≤ 500 m
   and subtracted from the raw distance — `dist - accuracy ≤ radius_meters`
   counts as on-site (default radius 200 m). This stops indoor/cloudy GPS
   noise from blocking genuinely-on-site staff.
3. If outside all geofences, the punch is rejected with the metres-to-nearest
   site and the radius, plus a hint to move outdoors if accuracy is poor.
4. **Late check** uses IST (UTC+5:30) + `payroll_settings.late_after_time`
   (default `09:46`). If late, the row's status is stored as `late`.
   (Fixes a UTC-vs-IST bug where 10:23 IST = 04:53 UTC looked not-late.)

Already punched in today → `400 Already punched in today`.

### Punch-out rules (strict geofence)

`POST /attendance/punch-out` is **equally strict** (mam: out-punch must
also obey geofencing). Same accuracy-buffered radius test; if off-site the
punch-out is blocked with metres-from-site. There is no walk-away
allowance — staff must punch out **first**, then leave. Total hours =
(punch_out − punch_in); a day under **4 h** is downgraded to `half_day`.

### Live location tracking (30-second pings)

The Attendance page calls `trackLocation` on a `setInterval` of
**30 seconds** (`30 * 1000`). Each ping `POST /attendance/track-location`:

- Same accuracy buffer (clamped 500 m); if inside a geofence the ping is
  tagged with that `site_name`, else `Outside`.
- A `gps_off=true` heartbeat (page open, network alive, but no GPS fix) is
  stored with NULL lat/lng and `site_name='GPS_OFF'` so the admin tracking
  page shows it as a distinct red card.

Admin views history via `GET /attendance/track/:userId/:date`. Rows land in
`location_tracking` (user_id, date, time, lat/lng, address, site_name).

### Geofence settings & audit

- `GET/POST /attendance/geofence`, `PUT/DELETE /attendance/geofence/:id` —
  manage `geofence_settings` (site_id, site_name, latitude, longitude,
  radius_meters default 200, active).
- `GET /attendance/audit/geofence-violations` — surfaces punches/pings that
  fell outside, for the "are staff really at site?" audit.

### Admin marking & grid

- `POST /attendance/admin-mark` and `/admin-mark-bulk` set a day's status
  directly (sets `admin_marked=1`, no punch time). Payroll honours this
  over punch logic.
- `GET /attendance/grid` — month grid for all users.
- `GET /attendance/`, `/dashboard`, `/report` — list, dashboard, reports.
- `GET /attendance/my-today`, `/my-month`, `/my-history` — self views.
- `POST /attendance/link-login` — links an attendance/employee record to a
  user login.

### Leave rules

`POST /attendance/leave` creates a `leave_requests` row. Leave types:
`casual | sick | earned | half_day | short_leave | comp_off`.

- **Multi-day leave** — `days = ceil(to_date − from_date) + 1`.
- **Short leave** — requires `from_time`/`to_time`; hours are computed;
  **monthly cap is 4 hours** (sum of non-rejected short leaves in the
  month). Exceeding it is rejected with remaining-hours feedback. `days = 0`.
- A `leave.requested` email event fires to the requester + director.

Approval: `PUT /attendance/leave/:id/approve` (`status` =
approved/rejected + remarks) requires `attendance:approve`. Visibility
scope: approvers/admins (or roles with can_approve/can_see_all on
`attendance`) see all leaves; plain users see only their own.

### API endpoints (`/api/attendance`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/my-today` `/my-month` `/my-history` | Self views |
| GET | `/` `/dashboard` `/grid` `/report` | Admin views |
| POST | `/punch-in` `/punch-out` | Geofenced punch |
| POST | `/track-location` | Live 30 s ping |
| GET | `/track/:userId/:date` | Location history |
| POST | `/admin-mark` `/admin-mark-bulk` | Manual marking |
| POST | `/link-login` | Link record → user |
| GET/POST | `/geofence` | List / add geofence |
| PUT/DELETE | `/geofence/:id` | Edit / delete geofence |
| GET | `/audit/geofence-violations` | Violation audit |
| POST | `/leave` | Request leave |
| GET | `/leaves` | List leaves (scoped) |
| PUT | `/leave/:id/approve` | Approve / reject |
| PUT/DELETE | `/leave/:id` | Edit / delete leave |
| DELETE | `/:id` | Delete attendance row |

### DB tables

`attendance` (punch in/out time, lat/lng, address, photo, site, total_hours,
status `present | half_day | short_day | absent | late | leave | holiday`,
admin_marked), `geofence_settings`, `location_tracking`, `leave_requests`.

---

## 7.7 Payroll

### Business purpose

Compute monthly salary per employee from attendance + leaves using
admin-tunable day rules, split into SEPL salary components, apply late
penalties / advances / food allowance / overtime, and lock a finalised
snapshot so historical payslips don't drift when attendance is later edited.

### Who uses it

- **Payroll admins** — review the monthly run, set advances/food/overrides,
  finalise the month, mark paid.
- **Employees** — view their salary slip.

### Screen / tabs (`Payroll.jsx`)

- **Monthly** — per-employee salary table for a chosen `YYYY-MM`.
- **Leaves** — leave-balance view.
- **Settings** — admin-only editor for every payroll rule (single-row
  `payroll_settings`, id=1) grouped into: Attendance rules, Penalty,
  Working days/leaves, Overtime, and Salary component %s.

### Settings (rules, all admin-tunable)

| Setting | Default | Meaning |
|---------|---------|---------|
| `late_after_time` | `09:46` | Punch after this = late mark (full day, counts toward grace) |
| `half_day_after_time` | `10:00` | Punch after this = half day, no grace |
| `min_hours_half_day` | 4 | Work ≥ this = full day; less = half day |
| `min_hours_full_day` | 8 | (legacy; current rule uses the 4 h floor) |
| `skip_half_day_if_short_leave` | 1 | Short leave that day cancels late/half-day docking |
| `late_grace_count` | 3 | First N late marks/month are free |
| `late_per_minute_rate` | 20 | After grace, ₹/min × minutes-late |
| `lates_to_absent` | 0 | Legacy "N lates = 1 absent" (0 disables) |
| `basic_pct` | 56.5 | Salary split — Basic |
| `conveyance_pct` | 22.6 | Conveyance |
| `hra_pct` | 5.9 | HRA |
| `adhoc_pct` | 15.0 | Adhoc |
| `misc_pct` | 0 | Misc (the five should sum to 100) |
| `working_days_per_month` | 26 | Shown as divisor (UI) |
| `sundays_paid` | 1 | Sundays paid for monthly staff |
| `cl_per_month` | 1 | Paid casual leave allowance |
| `sl_per_month` | 1 | Paid sick leave allowance |
| `pl_per_month` | 1.5 | Paid privilege/earned leave |
| `short_leave_per_month` | 2 | Allowed short-leave count |
| `ot_threshold_hours` | 9 | Hours/day before OT |
| `ot_rate_multiplier` | 1 | OT pay multiplier |

### Day rules (the core calculator — confirmed with mam)

`calculateForEmployee(db, settings, employee, month)` walks each day of the
month (up to **today** for the current month — future days aren't counted as
absent; uses IST to avoid the VPS-UTC off-by-5.5 h bug; future months return
zero) and assigns each day a `pay` of 1 / 0.5 / 0:

1. **Sunday** (no leave, no punch) — paid 1 if `sundays_paid`, labelled
   `sunday_paid`; else `sunday_unpaid`.
2. **Approved leave that day**:
   - casual → paid while `cl_used < cl_per_month` (1/mo)
   - sick → paid while `sl_used < sl_per_month`
   - earned → paid while `pl_used < pl_per_month` (1.5/mo)
   - comp_off / half_day leave → always a full paid day
   - Beyond allowance → unpaid leave (pay 0).
3. **Admin-marked day** (admin_mark, no punch) — honoured directly over
   punch logic: present/late → 1; half_day/short_day → 0.5; leave/holiday →
   1 (paid leave); absent/other → 0.
4. **Punched day**:
   - **Half day (pay 0.5)** if punch-in is **after 10:00**
     (`half_day_after_time`, no grace) **or** total hours **< 4**
     (`min_hours_half_day`) — *unless* a short leave was applied that day and
     `skip_half_day_if_short_leave` is on.
   - Otherwise **full day (pay 1)**. If punch-in is in the **09:46–10:00**
     window it's a **late mark** on an otherwise full day (recorded, not
     docked here). A 4–8 h day is a **full day** (mam dropped the old 8 h
     half-day docking).
   - If `ot_eligible` and hours > `ot_threshold_hours` (9), the excess
     accrues OT hours.
5. **No punch, no leave, not Sunday** → absent (pay 0).

**Late penalty (current model):** the first `late_grace_count` (3) late
marks per month are free; every late day after that is charged
`late_per_minute_rate` (₹20) × `minutes_late` (punch-in minus the 09:46
late-zone start). The legacy "N lates → 1 absent" model is off by default.

**Sandwich rule (revised):** a weekly-off Sunday is paid **unless BOTH the
Saturday before AND the Monday after are absent** — only then is the
sandwiched Sunday deducted (`sunday_sandwich_break`). If either neighbour
is worked/paid (full, half, or paid leave), the Sunday stays paid.

**Sunday-worked bonus:** if the person actually works a Sunday, they get an
**extra** full (or half) day's pay on top of the already-paid weekly off, so
net pay can exceed base salary.

### Salary formula

- `per_day_rate = base_salary / total_days_in_month` (actual calendar days,
  28–31 — Sundays are already paid via the sandwich rule, so the month is
  covered evenly).
- `gross_earned = per_day_rate × paid_days`.
- **Component split** of gross: basic = gross×basic_pct/100, conveyance,
  hra, adhoc, misc (matching SEPL's Tally slip).
- **OT pay** = `ot_hours × (base_salary / (total_days × ot_threshold)) ×
  ot_rate_multiplier` (≈ salary ÷ days ÷ 9 per hour at default settings).
- **Deductions** = late penalty (override-aware) + advance taken this month.
- `net_before_ot = gross − deductions + food`;
  `net_pay = gross + ot_pay − deductions + food`.

### Manual monthly overrides & adjustments

Stored on `payroll_advances` (one row per month × employee): `amount`
(advance, deducted), `food` (allowance, added), and three hand-set
overrides — `paid_days_override`, `cl_override`, `late_penalty_override`
(NULL = use auto). These let admin pay salary now while attendance is being
corrected. Set via `PUT /payroll/advance/:employee_id`,
`/food/:employee_id`, `/override/:employee_id`.

### Salary-exempt employees (full salary)

When `employees.salary_exempt = 1` (mam's directive — e.g. Parul Goyal,
Rajat Sir, Nitin Jain, Ankur Kaplesh, Pooja Kaplesh, D.S Kaplesh, Soma
Kaplesh), the calculator **short-circuits**: it bypasses every attendance /
late / leave deduction and returns the **full base salary** as gross (still
split into Basic/Conveyance/HRA/Adhoc/Misc so the slip stays compliant).
Advances are still deducted; future months still return 0.

### Finalise & disburse

- `GET /payroll/calculate` (all) / `/calculate/:employee_id` (one) — live
  calc for a month.
- `POST /payroll/finalise` — snapshots the month into `payroll_runs`
  (status `draft → finalised`), locking historical payslips.
- `PUT /payroll/paid/:employee_id` — mark disbursed.
- `POST /payroll/unlock` (admin) — reopen a finalised month.
- Leave balances: `GET /payroll/leave-balances`,
  `PUT /payroll/leave-balance/:employee_id`,
  `POST /payroll/leave-balances/rollover`.

### Print output

`SalarySlipPrint.jsx` — print-ready monthly salary slip showing the SEPL
component breakdown (Basic / Conveyance / HRA / Adhoc / Misc), paid days,
deductions, advance, food, OT, and net pay.

### API endpoints (`/api/payroll`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/settings` | Read settings |
| PUT | `/settings` | Update settings (admin) |
| GET | `/calculate` | All-employee month calc |
| GET | `/calculate/:employee_id` | One-employee calc |
| POST | `/finalise` | Finalise month |
| PUT | `/paid/:employee_id` | Mark paid |
| POST | `/unlock` | Unlock month (admin) |
| PUT | `/advance/:employee_id` | Set advance (admin) |
| PUT | `/food/:employee_id` | Set food allowance (admin) |
| PUT | `/override/:employee_id` | Manual paid-days/CL/late overrides |
| GET | `/leave-balances` | Leave balances |
| PUT | `/leave-balance/:employee_id` | Set balance (admin) |
| POST | `/leave-balances/rollover` | Roll over (admin) |

### DB tables

`payroll_settings` (single row id=1), `payroll_runs` (finalised monthly
snapshot, UNIQUE month+employee, status `draft | finalised | disbursed`,
breakdown_json per-day), `payroll_advances` (advance/food/overrides per
month × employee). Reads `attendance`, `leave_requests`, `employees`.

---

## 7.8 Employees (master)

### Business purpose

The employee master: who works here, their designation/department,
reporting line, join date, salary, and login linkage. It is the spine the
rest of HRMS hangs off — payroll, scorecards, training assignments, DPR
staff-cost auto-calc, and interview panels all reference `employees`.

### Screen & columns

`Employees.jsx` — searchable table (by name/phone/email/designation/
department). Columns: **Name, Phone, Email, Designation, Department, Join
Date, Linked User, [Salary], Status, Actions**. The Salary column is gated
(only visible to roles that may see salary). A mobile card layout mirrors
the table.

The **Linked User** column shows whether the employee row is connected to a
login user — required for DPR Staff Cost auto-calc and for payroll
attendance lookups. Where unlinked, payroll falls back to matching by name
(case-insensitive) and persists the link once found.

### Key fields (`employees` + migrations)

user_id (login link), name, phone, email, designation, department,
join_date, salary, status (`active | training | inactive | terminated`),
aadhar_file / pan_file / qualification_file, **salary_exempt** (full-salary
flag), cl_eligible, **ot_eligible**, cl_opening_balance.

Bulk add and auto-link helpers exist (`POST /hr/employees/bulk`,
`/employees/auto-link`).

### Reporting-to / hierarchy

Reporting line is expressed through hiring (`reporting_manager_id` on
`hiring_requests`, `reporting_to` on offers) and the org structure; the
employee master itself stores designation + department as the primary
grouping.

### API endpoints (under `/api/hr`)

| Method | Path | Permission |
|--------|------|-----------|
| GET | `/employees` | open (dropdowns/dashboards) |
| POST | `/employees` | `employees:create` |
| POST | `/employees/auto-link` | `employees:edit` |
| POST | `/employees/bulk` | `employees:create` |
| PUT | `/employees/:id` | `employees:edit` |
| DELETE | `/employees/:id` | `employees:delete` |

### DB table

`employees`.

---

## 7.9 Performance — MIS Scorecards

### Business purpose

A weekly MIS scorecard per role: each role has a template of weighted KPIs
(summing to 100%), with weekly planned-vs-actual entries. Some KPIs pull
their actuals automatically from other ERP modules (DPR, PMS, checklists,
tickets, delegations, indents, stock, billing); the rest are entered
manually. Produces a weekly score per user.

### Who uses it

- **Admins / managers** — manage templates + KPIs, assign templates to
  users, set per-user KPI targets, review the weekly board.
- **Employees** — fill their weekly actuals/commitments.

### Templates (20 seeded)

`server/db/seedScoring.js` seeds **20 role templates** into
`score_templates` / `score_kpis`. The full set:

Site Engineer · Supervisor · Aanchal — Finance Executive · Monika — AI
Implementation Head · Anmol — DPR / Score Card · Ankush — HR Ops + Marketing
· Ajmer — Procurement Lead · Gaganpreet — Cash Flow Manager · Indresh —
Billing Engineer · Lovely — Sales Coordinator · Nancy — Estimation & Costing
Head · Nitin Sir — MD · Parul — Compliance & Tender · Pradeep Panda —
Operations Lead · Raj Kumar — Procurement Manager · Rajeev Sood — Quotation
· Riti — Sales Coordinator (Sales Side) · Ruksana — HR Hiring · Shubham —
Accounts · Sushila — Sales Coordinator.

Each KPI (`score_kpis`) has: group_name (`Basic | Weekly | Monthly`),
metric_name, weightage (0–100), direction (`higher_better | lower_better`),
`data_source` (`manual` or `auto:…` such as `auto:dpr_profit`,
`auto:indents_in_week`, `auto:mb_signed`, `auto:pms`, `auto:checklists`,
`auto:tickets`, `auto:delegations`, `auto:stock_at_site`, …), display_order,
default_planned (fixed weekly target).

### Assignment & per-user targets

- Each user is bound to one template via `score_user_template`.
- `score_user_kpi_target` overrides a KPI's `default_planned` **per user**
  (e.g. Ajmer's "Indent vs Bill" target = 5 while Aakash's = 3, same KPI).
  The scorecard reads the override first, then falls back to the KPI default.

### Weekly entries & scoring

`score_entries` holds one row per (user, kpi, week_start = Monday): planned,
actual, actual_pct, last_week_pct, total_uptodate, pending_uptodate,
pending_work, pending_pct, commitment, notes.

`GET /scoring/weekly` walks active users and, for each, computes
given-vs-done counts for the auto KPIs over the week window: delegations,
PMS tasks, checklists (assigned × 6 weekdays vs completion rows), help
tickets, plus DPR/indent/stock/billing-derived metrics. The weighted roll-up
of KPI percentages × weightage produces the user's weekly score.
`GET /scoring/weekly/detail` returns the per-KPI breakdown.

### API endpoints (`/api/scoring`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/templates` `/templates/:id` | List / detail templates |
| POST/PUT/DELETE | `/templates[/:id]` | Manage templates (admin) |
| POST | `/templates/:id/kpis` | Add KPI (admin) |
| PUT/DELETE | `/kpis/:id` | Edit / delete KPI (admin) |
| GET | `/users/:user_id/kpi-targets` | Per-user targets |
| PUT | `/users/:user_id/kpi-targets/:kpi_id` | Set target (admin) |
| GET | `/assignments` | Template assignments |
| PUT | `/assignments/:user_id` | Assign template (admin) |
| GET | `/scorecard` | A user's scorecard |
| PUT | `/scorecard/entry` | Save a weekly entry |
| GET | `/weekly` | Weekly board (all users) |
| GET | `/weekly/detail` | Per-KPI weekly detail |

### DB tables

`score_templates`, `score_kpis`, `score_user_template`,
`score_user_kpi_target`, `score_entries`.

---

## 7.10 Sub-contractor Master

### Business purpose

The persistent directory of sub-contractors (mam's "Sub-Contractor Form"
Google-Form workflow brought into the ERP — 47+ entries), searchable and
filterable alongside the rest of the data, and used as the vendor pool for
the sub-contractor hiring tracker (7.3) and the DPR contractor picker.

### Screen & columns

`SubContractors.jsx` — table columns: **Name, Type, Contact, Location,
Exp., Manpower, Tools, GST, Rate vs Budget, Start (days), Status, Actions**.
Filters by search text, state, and contractor_type; defaults to active-only.
A "+ Add Sub-Contractor" modal captures the full form.

### Key fields (`sub_contractors` + migrations)

name, phone, email, **contractor_type**, state / district / location_extra,
**experience_years**, **manpower** (strength), with_tools, has_gst /
gst_number, rate_in_budget, start_within_days, specialization, rate /
rate_unit, status (`qualified | negotiation | onboarded | active |
inactive`), active flag, work_order_file, notes, created_by/updated_at.

### Lookup endpoint

`GET /api/sub-contractors/lookup` is open to any authenticated user (site
engineers don't get full master access) and returns a de-duped
id/name/type/district list for dropdowns — it GROUPs BY name (NOCASE,
keeping the lowest id) so duplicate-named gangs collapse to one picker entry.

### API endpoints (`/api/sub-contractors`)

| Method | Path | Permission |
|--------|------|-----------|
| GET | `/lookup` | any authenticated |
| GET | `/` | `sub_contractors:view` (filters: q, state, contractor_type, active) |
| GET | `/:id` | `sub_contractors:view` |
| POST | `/` | `sub_contractors:create` |
| PUT | `/:id` | `sub_contractors:edit` |
| PATCH | `/:id/active` | `sub_contractors:edit` (toggle active) |
| DELETE | `/:id` | `sub_contractors:delete` |

(A simpler `/hr/sub-contractors` set also exists in `hr.js` against the same
table.)

### DB table

`sub_contractors`.

---

## 7.11 Permissions & cross-module notes

- HRMS modules are guarded by `requirePermission(module, action)` with
  modules: `hr`, `hr_system`, `employees`, `expenses`, `attendance`,
  `payroll`, `scoring`, `subcon_hiring`, `sub_contractors`. Settings/unlock
  endpoints add an extra admin gate.
- **Shared READ endpoints stay open** so dropdowns/dashboards keep working
  (e.g. `GET /hr/employees`, `GET /sub-contractors/lookup`).
- Payroll attendance lookups depend on the **employee↔user** link; payroll
  name-matches and persists the link when `employees.user_id` is NULL.
- The only HRMS cron is the **HR automations cron (every 30 min)** in
  `hrAutomationsCron.js` (7.1.8). Attendance has no cron — geofence + the
  30 s in-browser location ping handle live tracking.

---

### Module map (quick reference)

| Module | Frontend | Backend | Mount | Main tables |
|--------|----------|---------|-------|-------------|
| Hiring (ATS) | HR.jsx | hr.js | /api/hr | candidates, candidate_events, candidate_docs, hiring_requests, jd_templates, job_descriptions, interview_scorecards, screening_*, final_round_questions, notifications |
| Hiring (legacy) | HRSystem.jsx | hrSystem.js | /api/hr-system | (own funnel tables) |
| Public offer | PublicOffer.jsx | publicHr.js | /api/public/offer | candidates |
| Sub-con Hiring | SubconHiring.jsx | subconHiring.js | /api/subcon-hiring | subcon_hiring(+_steps/_files/_candidates) |
| Onboarding | Induction.jsx + HR tab | hr.js | /api/hr | induction_items |
| Training | Training.jsx + HR tab | hr.js | /api/hr | training_videos, training_assignments |
| Attendance | Attendance.jsx | attendance.js | /api/attendance | attendance, geofence_settings, location_tracking, leave_requests |
| Payroll | Payroll.jsx, SalarySlipPrint.jsx | payroll.js | /api/payroll | payroll_settings, payroll_runs, payroll_advances |
| Employees | Employees.jsx | hr.js | /api/hr | employees |
| Performance | Scorecard.jsx | scoring.js | /api/scoring | score_templates, score_kpis, score_user_template, score_user_kpi_target, score_entries |
| Sub-con Master | SubContractors.jsx | subcontractors.js | /api/sub-contractors | sub_contractors |
