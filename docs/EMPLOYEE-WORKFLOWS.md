# Delegation, Checklists and Help Tickets

Implementation review: 18 September 2026. Local development only; nothing in this
change deploys code, applies hosted migrations or sends external notifications.

## Existing implementation and gaps

The active backend is `supabase/functions/api`, not `server/routes`. The original
React pages called `/delegations`, `/hr/checklists` and `/support`. Their existing
PostgreSQL tables already persisted task assignments, deadlines, submission and
review fields; recurring checklist definitions and completions; and basic help
ticket creation, assignment and a single response field. The system also already
had users, employee/login links, branch and reporting relationships, role grants,
an in-app notification bell, shared API/authentication, and modal/form styling.

Code tracing found these gaps:

- Task review permission implied global access, and dashboard queries were not
  scoped. Progress, blockers, configurable review, concurrency and durable
  reassignment history were missing.
- Checklist completion did not verify the assignee. Completions could be
  overwritten; templates had no item/version snapshots or durable occurrences.
  Different reads calculated recurrence differently and used UTC calendar dates.
  The local legacy completion table also lacks approval columns expected by the
  old handlers. History now displays those rows without inventing review status.
- An unrecognized support `scope` query could bypass its list filter. Read-all
  permission also granted triage powers. Arbitrary transitions, overwritten
  responses and incomplete closure history made the lifecycle unreliable.
- Proof was uploaded to the shared public bucket. Notifications were mostly
  best-effort external hooks rather than part of the workflow transaction.

These findings describe the earlier source paths, not a claim that every old
feature passed an independent baseline test.

## What changed

The current routes remain `/delegations`, `/checklists` and `/help-tickets` in the
frontend. They now use `Workflows.jsx` and the authenticated `/work` API. Existing
task, ticket and template IDs and source rows are retained. Checklist versions,
occurrences, file metadata, request deduplication and append-only events are
additive tables. Earlier checklist completions remain in `checklist_completions`
and are available through the template's **View earlier submissions** action.

The earlier UI source remains in the repository for comparison. Old API reads
used by dashboard consumers are permission-filtered. Old unversioned writes
return 409 and direct the caller to refresh; they cannot bypass the new workflow.
Older dedicated workload/follow-up reports and the old checklist Excel bulk
interface are not connected to the new versioned editor. They require a separate
compatibility pass before a production replacement is accepted.

### Shared access and reliability

- Permissions are stored once per role using the existing role matrix. There is
  no implicit admin-label bypass for these modules. `self`, `team` (direct
  reports), `branch` and `all` are evaluated separately for each action. A broad
  View grant cannot broaden a narrower Edit or Approve grant.
- The shared **Employee work self-service** role allows own task/checklist
  progress and own ticket creation/replies. It is not automatically assigned.
  **Workflows owner** is assigned only to the existing nominated permission
  managers by the migration. Owner authority can delegate explicit roles.
- Users need stable login/employee links and branch/reporting assignments.
  Branch scope uses the record's saved branch. Assignment validates the selected
  employee and branch; collaborators cannot take over accountable completion.
  Execution requires View/Edit; management requires Create as well as Edit;
  reviews and ticket triage require Approve. The new work API has no destructive
  Delete operation, regardless of the generic matrix's Delete checkbox.
- Mutations use row locks, expected versions and request keys. A stale update
  returns 409. Reusing a key with different input is rejected. Retries do not
  create duplicate records or notifications.
- New attachments use a private `work-evidence` bucket: PNG, JPEG, PDF and text,
  maximum 5 MB, with extension/content checks. Files belong to one work record;
  other records cannot reuse them as evidence. Downloads require current record
  access and use 60-second signed links. Earlier public URLs are not automatically
  privatized by this migration; they need a reviewed migration before claiming
  all historical evidence is private.
- Workflow events and notifications are committed with the record change.
  The existing notification bell displays them. No email, SMS or browser push
  is sent by the new workflow services. Internal ticket notes/files are excluded
  from requester responses and requester notifications.
- Lists have backend pagination (maximum 100), title search, status, scope,
  branch and priority filters and allowlisted sorting. Task/checklist lists
  support overdue filters. Activity has a paginated API and recent events in UI.
- **My work** and the salon dashboard reuse the same scoped lists. Opening work
  screens does not generate occurrences, complete work or mutate business data.

### Delegation

Create a titled task with instructions, accountable employee, branch, priority,
deadline, optional collaborators and reviewer. Review and file requirements have
owner-configured defaults and can be chosen per task. Add supporting attachments
after creation. The employee starts work, records progress, reports a blocker,
or submits completion evidence and a note. Submission either completes the task
or sends it for independent review. An approver can return it with a reason;
returned work can resume and be resubmitted. Completed work cannot be overwritten.

Management reassignment/deadline changes require Create and scoped Edit, a reason,
and active unsubmitted work. Extension requests and independent extension review
are supported. Changes preserve before/after assignment and deadline events.
For older unconfigured tasks, an owner supplies the missing branch, deadline and
reviewer before using the new completion flow.

### Checklists

Templates contain sections, instructions, required/optional items, note/file
evidence and optional not-applicable answers with reasons. Choose named employees
or include a manager's direct team. Publishing captures the team membership;
future roster changes require publishing an updated assignment version.

Supported schedules: daily, selected weekdays, weekly, monthly and once; explicit
IANA timezone, due time, start/end and version effective date. Monthly dates clamp
to the last day of shorter months. PostgreSQL timezone conversion handles DST;
ambiguous/nonexistent local times follow PostgreSQL's timezone rules. There are
no invented salon holiday, payroll or staffing policies.

Every occurrence references its immutable template version and one accountable
employee. Employees can save drafts and resume after refresh. Submission validates
required items, evidence and NA rules against that saved version. Optional
independent review is available. Pausing/retiring stops future generation while
retaining versions and submissions. Publishing cannot rewrite past dates.

The job creates unique `(template, employee, local date)` occurrences and can
retry safely. Missed-run choices are **catch up** with original due dates or
**skip** earlier dates. Catch-up is bounded to 31 dates per template and 100 new
occurrences per run; later runs continue from the saved cursor. Paused days are
skipped on resume. A revised version does not recreate an already-generated
occurrence for that date. Editable opening, hygiene and closing examples are
offered in the form; they are not mandatory policies or automatic assignments.

### Help Tickets

Employees create categorized, prioritized tickets with branch and attachments.
Categories can route to an accountable support employee; unassigned work appears
in authorized branch/all views for triage and notifies authorized scoped triagers.
Support can assign, start, request
information, reply, resolve with a resolution, and close/reopen according to role
and settings. Closure requires resolution first. Requester close/reopen can be
disabled. Reopening requires a reason and starts a fresh target cycle.

Public replies are append-only events. Support-only internal notes/files are
separate. First response is recorded for a public support reply, information
request or resolution. Timers use elapsed clock minutes, not business hours;
waiting pauses/resumes when configured. Targets are optional, snapshotted for
each new ticket, and escalations are in-app, permission-checked and deduplicated
once per target/recipient/cycle. Resolving a linked ticket never completes its
task or checklist. A blocked task or checklist issue can create a linked ticket.

## Owner setup

1. Verify employee/login links, active branches and reporting managers using the
   existing employee and role setup. Reuse the attendance branch directory.
2. In **Users**, assign **Employee work self-service** to participating staff.
   Create/choose shared manager/support roles in **Roles & Permissions**. Grant
   View/Edit for work execution, Create for assignment/template management,
   Approve for review/triage, and the correct team/branch/all scope. Scope cannot
   be substituted by a user being labelled `admin`.
3. Grant `work_settings` View and all-scope Edit only to configuration operators.
   Permission editing still requires the existing nominated permission authority.
4. In **Work settings**, confirm category names and routing, priorities, default
   task review/file requirements, requester closure/reopening, timer pausing,
   response/resolution minutes and escalation recipients. Targets start unset;
   escalations start disabled. Archive unused options rather than removing IDs.
5. Publish reviewed checklist templates, assignees, independent reviewers,
   schedule/timezone, evidence/NA rules and missed-run policy. Review the editable
   samples rather than assuming they are Headmasters policy.
6. Configure a recurring authorized job. **Run scheduled work now** is available
   for an owner demonstration. The local-only runner is:

   ```powershell
   node scripts/workflows/local-scheduler.cjs --once
   node scripts/workflows/local-scheduler.cjs
   ```

   The continuous runner runs once per minute, validates the local database
   marker, and uses only `.local/test-login.json` and loopback URLs. It is not a
   production service. Production needs a separately provisioned scheduled caller
   with a dedicated authorized login, session refresh, monitoring/retries and
   alarms for missing runs. Its deployment and credentials require owner review;
   none have been provisioned remotely. Job receipts appear in Work settings.
7. Review older records with missing branch, reviewer or structured template
   details; publish a version for each legacy checklist that should recur. No
   automatic name-based migration or retrospective occurrence generation occurs.

Settings support the options described above, not arbitrary new workflows.
Additional statuses, multi-stage approvals, support-team queues with round-robin
routing, business-hours/holiday SLA calendars, external delivery channels,
quarterly/yearly/fortnightly template schedules, bulk Excel migration and fully
historical attachment privatization require further implementation/review.

## Deployment preparation

Review these migrations after the existing attendance migration chain:

- `20260918000100_employee_workflows.sql`
- `20260918000200_workflow_file_retries.sql`

Do not apply the generated `.local` baseline to a hosted project. Review existing
role grants and nominated permission managers before migration, back up live data,
and coordinate API/frontend rollout: older clients cannot use unversioned writes
after this upgrade. Deploy neither code nor SQL without the owner's authorization.

Local runtime now uses `edge_runtime.policy="oneshot"`, the development mode in
the [Supabase CLI reference](https://supabase.com/docs/guides/local-development/cli/config).
The prior reused worker hit cumulative CPU limits during multi-page tests. This
local change does not alter hosted limits. Hosted cold-start, load and scheduled
batch behavior remain deployment acceptance checks.

The API entrypoint now loads route modules on demand, preserving the original
mount prefixes. User export loads its spreadsheet library only on export, rather
than on every login. CORS explicitly permits `Idempotency-Key` for a separate
Vercel frontend. Generic audit logs omit work payloads so internal ticket notes
remain in their scoped history rather than leaking through a broad audit role.

## Verification and demonstration

Run against the isolated local stack:

```powershell
node scripts/workflows/journeys.test.cjs
node scripts/workflows/reliability.test.cjs
node scripts/workflows/mobile.test.cjs
npm.cmd --prefix client run build -- --outDir ../.local/workflow-build
```

Tests create synthetic accounts and retain fixtures for inspection. They never
use live URLs. Browser tests block external requests. Result files and demo
accounts are saved under ignored `.local/workflow-*.json`. The role fixture marker
keeps test manager roles out of the normal local role list.

Demonstration:

1. Manager opens Delegation, selects **Created by me** or **All permitted work**
   to follow assigned work, creates a task, selects an employee/reviewer, and
   chooses review/evidence requirements. Employee opens My work, starts the task,
   attaches a text/photo/PDF file, selects that evidence and submits a note.
   Manager returns it with a reason, then approves the corrected submission.
2. Manager publishes a hygiene template with a required note and an optional NA
   item, assigns an employee and runs the scheduler. Employee opens Today's
   checklists, saves progress, refreshes, resumes and completes it. Manager revises
   the template and opens the earlier occurrence to verify the original items.
3. Employee reports a task blocker and raises a linked ticket. Support starts the
   ticket, adds an internal note, requests information and resolves it. Employee
   replies, closes or reopens it as allowed. Reopen the task to show that it is
   still blocked until the employee explicitly resumes work.

### Verified results

- 12 mounted API business journeys passed (`.local/workflow-test-results.json`).
- 8 reliability checks passed (`.local/workflow-reliability-results.json`):
  cross-origin headers and mount parity; action-specific scope isolation;
  pagination/search; missed-run catch-up/skip; escalation deduplication/pause;
  monthly/DST calculations; unassigned triage/private audit; legacy history scope.
- 4 mobile browser journeys passed (`.local/workflow-mobile-results.json`),
  including task creation/evidence/return/approval, template authoring and
  checklist draft/resume/completion, ticket assignment/resolution/close/reopen,
  and My work. The final run asserts no API server errors or browser exceptions.
- 2 additional browser smoke checks passed for employee landing on My work and
  owner-only settings/job controls. Employee-only accounts do not need financial
  dashboard permission to reach their work.
- 2 local/production isolation tests passed. Existing local API, login, session,
  salon reads and test-client CRUD checks passed. Frontend build and API bundle
  checks passed; validation outputs remain in ignored `.local/`.

Earlier runs failed on JSON parameter serialization, form-label/save-state
handling, local worker resource limits, and a historical-schema test assumption.
Those findings were corrected and affected checks rerun. These are local results,
not production acceptance. Phone hardware, real client records, hosted performance,
failure recovery at production scale and a deployed scheduler remain untested.

The monthly predicate and DST boundary check include a helper/database calculation
check; the scheduling, submission, security and retry journeys call the mounted
authenticated API. No physical phone or real external notification was used.

### Readiness

| Module | Current conclusion | What still gates broader use |
|---|---|---|
| Delegation | Ready for local demo of the new lifecycle | Owner roles/branches/review policy, legacy-record mapping, earlier workload/report compatibility and hosted acceptance |
| Checklists | Ready for local demo of versioned recurring work | Owner schedules/assignments, legacy template conversion, production scheduler/monitoring; older bulk and additional recurrence features are not delivered in this editor |
| Help Tickets | Ready for local demo of requester/support lifecycle | Owner routing/targets/escalations, permission acceptance, historical attachment handling and hosted acceptance |

Client acceptance can use the synthetic local accounts after reviewing the setup
above. None of the three modules is declared production-ready. Existing advanced
legacy report/bulk features, historical attachment privatization and a production
scheduler are explicitly unfinished deployment work, not silently assumed done.

Role configuration was subsequently expanded for the full salon experience;
see `docs/ROLE-DEFAULTS.md` and `.local/ROLE-DEMO.md` for the current shared roles
and test accounts. The original workflow-only manager role is no longer assigned
to the documented manager demo login.

Local demonstration credentials: `.local/WORKFLOW-DEMO.md`. The local job runner
was started for this session; its PID and logs are in `.local/workflow-scheduler.*`.
