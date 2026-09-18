# Attendance operations — local implementation

Implemented on 17 September 2026 in the active Supabase Edge API and React client. Nothing in this work deploys or migrates production. Migrations `20260917000300` through `20260917000500` extend the earlier access/capture foundation and were applied only to the isolated local database.

## Available workflows

- **Punch In/Out:** linked staff can capture their own attendance. An overnight checkout closes its original work-date session. Split shifts and explicitly permitted multiple sessions retain separate check-ins and checkouts. Retries reuse request IDs. Original evidence cannot be overwritten or deleted.
- **My Schedule / Daily Results:** staff see their own dated assignments, hours, late minutes through the evaluated result, paid-day fractions, calculated comp-off credits and unresolved exceptions. Viewing attendance does not expose salary inputs.
- **Requests & Reviews:** staff or authorized managers submit attendance corrections; another authorized person approves or rejects them. Approved leave can be cancelled or replaced through an amendment while retaining the original approved request. Missing checkout is resolved by an explicit correction, without inventing an original checkout time. Pending requests block finalization.
- **Shifts & Rosters:** immutable shift versions support overnight and multiple ordered work segments. Dated work/off assignments support rotating patterns and weekly-off swaps. CSV/XLSX imports are previewed, validated and committed together. Stable employee/template IDs, ISO date text, duplicate checks, overlap checks and stale-preview checks protect imports. Assignment history remains available.
- **Policies:** effective-dated versions configure grace, full/half-day hours, lateness penalties, leave allowances, missing-checkout outcomes, weekly-off payment/work, sandwich rules, overtime and location exceptions. Existing capture policy/shift snapshots are retained. Conflicting per-minute and late-to-absence penalties are rejected.
- **Periods / Payroll:** closing a completed month requires resolved attendance and saves immutable results. Payroll finalization requires that closed attendance. Reopening retains earlier revisions. Paid payroll is immutable; revised unpaid payroll is versioned on refinalization. A difference relating to a paid source month is requested for a later open payroll month and independently approved. Pending adjustments prevent payroll finalization.
- **Location exceptions:** a published policy chooses branch-only or any active location and review or rejection of unverified evidence. Review requires a reason; the punch is pending until decided. Reviewers can inspect submitted GPS/selfie evidence. Audits use the stored capture decision; legacy records without the original policy remain unverified instead of being reclassified with current locations.

## Setup before real business testing

1. In **Employees**, verify each employee's unique login link and employment dates. Set the last employment date for leavers. A login with attendance history cannot simply be reassigned to another employee.
2. In **Roles & Permissions**, assign the new roster, policy, correction-request and period permissions to the appropriate people. Grant only the required employee/team/branch/all scope. A second authorized person is required for approvals. Branch assignments and location branches are managed through the existing attendance access setup.
3. In **Attendance → Policies**, publish the business-approved rules with an effective date and reason. No current business policy was guessed or published by this implementation. Without one, uncertain dates deliberately show **Review required**, and a period cannot close.
4. Assign each employee a shift or dated roster. Off days in a rotation are explicit; the template's usual weekly-off list is reference information. Import the downloadable CSV columns with dates stored as `YYYY-MM-DD` text.
5. Configure active attendance locations, then test with a staff login and a separate reviewer login.

The automated API tests retain clearly named synthetic accounts, rosters and policies dated **2099** in the local database. These are test fixtures, not approved company rules. Monthly/payroll workflow tests use a separate transaction-isolated schema and roll back their policies and financial records. No actual current-period payroll was finalized or paid by the tests.

## Suggested acceptance test

1. Log in as an employee. Check My Schedule, punch in, punch out and verify My History and Daily Results. Confirm other employees and manager controls are inaccessible.
2. Test a late arrival, exact half/full-hour boundaries, a half-day leave plus work, a missed checkout, and the employee's actual weekly off. Verify the result against your published policy.
3. Assign an overnight or split shift. Verify the checkout work date and that another session keeps the previous checkout unchanged.
4. Submit an incorrect import, correct its errors, preview and commit. Try a stale preview and inspect roster history.
5. Submit a correction or leave amendment. Verify self-approval fails and a second reviewer can decide it while the original remains visible.
6. With a completed synthetic month, resolve exceptions, close attendance, finalize payroll and mark one test salary paid. Reopen and correct attendance. Confirm the paid slip is unchanged and a later approved adjustment carries the difference.

## Verification scripts

Run from the project root against local services only:

```powershell
node --test scripts/attendance/helpers.test.cjs scripts/attendance/engine.test.cjs
node scripts/attendance/monthly.test.cjs
node scripts/attendance/period-workflow.test.cjs
node scripts/attendance/operations.test.cjs
node scripts/attendance/sessions.test.cjs
node scripts/attendance/operations-browser.test.cjs
node scripts/attendance/navigation.test.cjs
```

The operations API tests use actual local Auth, the mounted Edge API and PostgreSQL. The period-workflow test executes the actual route handlers and database triggers in a rolled-back schema; it injects authorized synthetic identities, so it does not replace the real authorization tests. Browser tests block external network access. The mobile-sized browser uses simulated camera and GPS.

Verified results for this implementation: 14 calculation/date tests, 7 monthly service tests, 5 period/payroll workflow tests, 8 mounted API tests, 3 overnight/split/exception/amendment API tests, 2 browser scenarios, and 3 navigation checks passed. A separate XLSX upload preview also passed. The frontend production build (written only to ignored local validation output), API bundle compile and whitespace checks passed. Intermediate failures in JSON storage and CSV date coercion were corrected and their tests rerun successfully.

## Acceptance limits

- **Physical phone camera/GPS testing remains required.** Browser simulation cannot verify a particular phone's permissions, camera hardware, indoor accuracy, background/resume behavior or network interruptions. Use a locally served secure origin reachable from the device and the local test database; do not use production as the test target.
- **Business-policy approval remains required.** The implementation exposes the choices rather than assuming salary-affecting rules. Monthly payroll currently uses calendar days as its divisor. Comp-off credits are calculated and shown; automatic redemption/carry-forward is not a new leave ledger in this change. The existing annual leave-balance screen is separate from the versioned monthly attendance allowance calculation.
- Historical data with missing login links, employment dates, shifts, checkout or policy provenance requires review. Existing legacy closed payroll is returned as stored; missing historical attendance inputs are not fabricated.
- These tests cover defined cases, not a guarantee of zero errors. Production rollout still needs a reviewed migration/deployment and business acceptance; it has not been performed.
