const express = require('express');
const pg = require('../db/pg');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { fireEmailEvent } = require('../lib/emailRules');
const { getEmailConfig } = require('../lib/email');
const { getRaciForRecords } = require('./raci');
const router = express.Router();
router.use(authMiddleware);

// Parse a stored UTC timestamp ('YYYY-MM-DD HH:MM:SS') to epoch ms.
const tsMs = (s) => s ? new Date(String(s).replace(' ', 'T') + 'Z').getTime() : null;

// Resolve a user's email by id (for email-trigger recipients). Best-effort.
async function userEmail(dbx, id) {
  try { return (await dbx.get('SELECT email FROM users WHERE id=?', id))?.email || null; }
  catch { return null; }
}
function directorEmail() { try { return require('../lib/email').getDirectorEmail(); } catch { return null; } }

// Approver-side amount adjustment (mam 2026-05-28: "at approval amount
// can be changed by approver like if some one fill 600 at approval
// approved amount 500").
//   payment_requests.approved_amount — latest amount agreed by approvers;
//     NULL until first override. COALESCE(approved_amount, amount) is
//     the figure used at final payment-release time.
//   payment_approvals.step_amount    — what THIS step's approver agreed.
//     Builds the per-step audit trail (Original 600 → HR 500 → Acct 500).
// (Both columns live in the migrated Postgres schema now — the old
// idempotent ALTER TABLE guards are no longer needed.)

// Helper: does the user see EVERY payment request, or only their own?
// Admin always sees all. Otherwise the user sees all iff one of their
// roles has either can_approve=1 OR can_see_all=1 on payment_required.
// can_see_all is the explicit "scope=ALL" toggle mam can flip in
// Roles & Permissions UI, decoupled from approval power.
const seesAll = async (req) => {
  if (req.user.role === 'admin') return true;
  const row = await pg.get(`
    SELECT MAX(CASE WHEN rp.can_approve = 1 OR rp.can_see_all = 1 THEN 1 ELSE 0 END) as ok
    FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
    WHERE ur.user_id = ? AND rp.module = 'payment_required'
  `, req.user.id);
  return !!row?.ok;
};

// One standard approval flow for EVERY category (mam 2026-06-11): instead of
// the old per-category chains (HR / Purchase-head / Site-engineer + auto
// Velocity Check + Billing Engineer), every payment now runs:
//   L1 Approval → Accountant (role)
//   L2 Approval → Nitin Jain (named person)
//   L3 Approval → Ankur Kaplesh (named person)
//   Payment Release → Aanchal (named person)
// Step numbers stay 1, 2, 3, 5 so the in-flight requests (parked on the old
// step 1/2/5) keep flowing; step 4 (retired Billing Engineer) is migrated to 5.
const STANDARD_FLOW = [
  { step: 1, name: 'L1 Approval (Accountant)', approver_role: 'Accountant' },
  { step: 2, name: 'L2 Approval (Nitin Jain)', approver_name: 'Nitin Jain' },
  { step: 3, name: 'L3 Approval (MD - Ankur Kaplesh)', approver_name: 'Ankur Kaplesh' },
  { step: 5, name: 'Payment Release (Aanchal)', approver_name: 'Aanchal' },
];
// TA/DA pre-approval (mam 2026-06-17): from 15/06/2026 every NEW TA/DA request
// must clear HR (Prabhdeep Singh) BEFORE L1 Accountant. Step 0 is prepended so
// it always sorts ahead of L1. Existing in-flight requests keep their current
// step (1+) and simply never visit step 0 — i.e. only new requests get HR.
const TADA_FLOW = [
  { step: 0, name: 'HR Approval (Prabhdeep Singh)', approver_name: 'Prabhdeep Singh' },
  ...STANDARD_FLOW,
];
const WORKFLOW = {
  'TA/DA': TADA_FLOW,
  'Purchase': STANDARD_FLOW,
  'Labour': STANDARD_FLOW,
  'Transport': STANDARD_FLOW,
  'Salary': STANDARD_FLOW,
  'Compliance': STANDARD_FLOW,
  // mam 2026-06-29: new "Manpower Advance" category — standard L1→L2→L3→Release
  // flow, plus a mandatory proof upload enforced at create time (below).
  'Manpower Advance': STANDARD_FLOW,
};

// Resolve a named approver (the standard flow pins specific people) to an
// active user record — exact name first, then a loose LIKE — so it survives
// across the local/production DBs without hard-coded user ids.
async function resolveUserByName(dbx, name) {
  if (!name) return null;
  try {
    return (await dbx.get('SELECT id, name FROM users WHERE active=1 AND LOWER(TRIM(name))=LOWER(TRIM(?)) LIMIT 1', name))
      || (await dbx.get('SELECT id, name FROM users WHERE active=1 AND LOWER(name) LIKE LOWER(?) ORDER BY id LIMIT 1', '%' + name + '%'));
  } catch (_) { return null; }
}

// Per-step approver override table (mam, 2026-05-16: "i want hr
// approval will give to anchal how can be it dynamic all steps").
// Idempotent migration — admin can now route any (category, step)
// to a specific user, bypassing the role-based default.  Empty row
// or no row at all = fall back to role-based check (old behaviour).
//
// One-time standardization (mam 2026-06-11): every category now uses the named
// L1→L2→L3→Release flow, so the OLD per-category routing overrides (e.g. step 1
// HR → Ruksana) would shadow the new named approvers — clear them once. Also
// move any request parked on the retired Billing-Engineer step (4) to Payment
// Release (5) so it isn't stuck on a step that no longer exists. Guarded by a
// marker row so it runs exactly once (won't wipe future manual overrides).
//
// One-time TA/DA → HR backfill (mam 2026-06-17): TA/DA raised on/after
// 15/06/2026 that are still waiting at L1 (not yet approved / not finalised)
// move to the new HR step (0) so they show on Prabhdeep's HR dashboard.
// Guarded so it runs exactly once; only touches in-flight, at-L1, dated rows.
(async () => {
  try {
    await ensureOverrideTable(pg);
  } catch (_) {}
  try {
    await pg.run(`CREATE TABLE IF NOT EXISTS app_migrations (key TEXT PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    if (!(await pg.get(`SELECT 1 FROM app_migrations WHERE key='pr_standard_flow_v1'`))) {
      await pg.run(`DELETE FROM payment_approval_overrides`);
      await pg.run(`UPDATE payment_requests SET current_step=5 WHERE current_step=4 AND status NOT IN ('final_approved','rejected')`);
      await pg.run(`INSERT INTO app_migrations (key) VALUES ('pr_standard_flow_v1')`);
      console.log('[migration] Payment Required standardized: L1 Accountant → L2 Nitin Jain → L3 Ankur Kaplesh → Release Aanchal');
    }
  } catch (e) { console.error('[migration] PR standardize failed:', e.message); }
  try {
    if (!(await pg.get(`SELECT 1 FROM app_migrations WHERE key='pr_tada_hr_backfill_v1'`))) {
      const r = await pg.run(`UPDATE payment_requests SET current_step=0, updated_at=CURRENT_TIMESTAMP
         WHERE category='TA/DA' AND current_step=1
           AND status NOT IN ('final_approved','rejected')
           AND LEFT(created_at,10) >= '2026-06-15'`);
      await pg.run(`INSERT INTO app_migrations (key) VALUES ('pr_tada_hr_backfill_v1')`);
      console.log('[migration] TA/DA HR backfill: moved', r.changes, 'pending TA/DA (≥15/06) to HR step 0');
    }
  } catch (e) { console.error('[migration] TA/DA HR backfill failed:', e.message); }
})();

async function getApprovalRoutingFor(dbx, category, step) {
  try {
    const row = await dbx.get(`SELECT user_id FROM payment_approval_overrides WHERE category=? AND step=?`, category, step);
    return row?.user_id || null;
  } catch (_) { return null; }
}

async function canUserApproveStep(dbx, userId, category, step) {
  const workflow = WORKFLOW[category];
  if (!workflow) return false;
  const stepInfo = workflow.find(w => w.step === step);
  if (!stepInfo) return false;
  const user = await dbx.get('SELECT role FROM users WHERE id=?', userId);
  if (user?.role === 'admin') return true;
  // Explicit override wins.  Only the assigned user (or admin) can
  // approve when an override is set.  No fallback to role-based —
  // that's the point of the override.
  const overrideUserId = await getApprovalRoutingFor(dbx, category, step);
  if (overrideUserId) {
    return overrideUserId === userId;
  }
  // COO escalation (mam 2026-06-18: "coo@securedengineers unable to approve").
  // The COO may clear the L2 and L3 sign-offs. Matched by EMAIL (the `coo@`
  // login is unique) rather than the display name "Nitin Jain", so a
  // duplicate / differently-spelled name account can never block them, and
  // the COO can stand in for the MD at L3. Skipped when an explicit
  // Approval-Routing override is set (handled above — the override wins).
  if (stepInfo.step === 2 || stepInfo.step === 3) {
    const me = await dbx.get('SELECT email, username FROM users WHERE id=?', userId);
    const isCoo = (v) => String(v || '').trim().toLowerCase().startsWith('coo@');
    if (isCoo(me?.email) || isCoo(me?.username)) return true;
  }
  // Named approver (the standard flow pins L2/L3/Release to a person).
  if (stepInfo.approver_name) {
    const u = await resolveUserByName(dbx, stepInfo.approver_name);
    return !!u && u.id === userId;
  }
  // No override → role-based fallback (the original behaviour).
  const userRoles = await dbx.all(`SELECT r.name FROM user_roles ur JOIN roles r ON ur.role_id=r.id WHERE ur.user_id=?`, userId);
  return userRoles.some(r => r.name === stepInfo.approver_role);
}

// Check if project/site is in top 3 by cash velocity (z-a)
async function isInTop3Velocity(dbx, siteName) {
  if (!siteName) return false;
  try {
    // Get all projects with their velocity calculated
    // (DISTINCT ON keeps one row per company_name — same effect as the old
    // SQLite GROUP BY bb.company_name that picked an arbitrary row.)
    const projects = await dbx.all(`SELECT DISTINCT ON (bb.company_name) bb.company_name, bb.sale_amount_without_gst,
      (SELECT COALESCE(SUM(amount),0) FROM cash_flow_entries WHERE type='inflow' AND party_name LIKE '%' || bb.client_name || '%') as received,
      (SELECT COALESCE(SUM(amount),0) FROM payment_requests WHERE status='final_approved' AND site_name LIKE '%' || bb.company_name || '%') as purchase,
      (SELECT COALESCE(aanchal_value*100000, 0) FROM project_finance WHERE business_book_id=bb.id) as aanchal,
      (SELECT COALESCE(payment_days, 0) FROM project_finance WHERE business_book_id=bb.id) as pdays
      FROM business_book bb ORDER BY bb.company_name`);

    const withVelocity = projects.map(p => {
      const totalDays = (p.pdays || 0) + 30; // approx completion
      const velocity = totalDays > 0 ? (p.aanchal - p.purchase) / totalDays : 0;
      return { name: p.company_name, velocity };
    });

    // Sort descending (z-a by velocity)
    withVelocity.sort((a, b) => b.velocity - a.velocity);
    const top3 = withVelocity.slice(0, 3);
    return top3.some(t => (siteName || '').toLowerCase().includes((t.name || '').toLowerCase()) || (t.name || '').toLowerCase().includes((siteName || '').toLowerCase()));
  } catch (e) { return false; }
}

// GET all with filters
router.get('/', requirePermission('payment_required', 'view'), async (req, res) => {
  try {
    const { status, category, search, step, date_from, date_to } = req.query;
    let sql = `SELECT pr.*, u.name as created_by_name FROM payment_requests pr LEFT JOIN users u ON pr.created_by=u.id WHERE 1=1`;
    const params = [];
    // Scope filter: non-approvers (e.g. site engineers) only see their own
    // requests. Approvers / admin see everything.
    if (!(await seesAll(req))) { sql += ' AND pr.created_by = ?'; params.push(req.user.id); }
    if (status) { sql += ' AND pr.status=?'; params.push(status); }
    if (category) { sql += ' AND pr.category=?'; params.push(category); }
    if (step) { sql += ' AND pr.current_step=?'; params.push(step); }
    // Mam 2026-05-29: date range filter on created_at so she can scope
    // 'show me what came in last week' without scrolling the full list.
    // Both bounds inclusive; partial spec OK (only from, only to, or both).
    if (date_from) { sql += ' AND LEFT(pr.created_at,10) >= ?'; params.push(date_from); }
    if (date_to)   { sql += ' AND LEFT(pr.created_at,10) <= ?'; params.push(date_to); }
    if (search) {
      sql += ' AND (pr.employee_name ILIKE ? OR pr.request_no ILIKE ? OR pr.purpose ILIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    sql += ' ORDER BY pr.created_at DESC';
    const rows = await pg.all(sql, ...params);

    // Mam (2026-05-22): "user can show their if aanchal approve the
    // payment and next step show the user so that they easy show
    // where is stuck their payment".  Enrich every row with:
    //   • current_step_name        — e.g. "Accountant Approval"
    //   • next_approver_name       — who's blocking (override user OR
    //                                "any <Role>" when no override set)
    //   • last_approved_step_name  — e.g. "HR Approval"
    //   • last_approved_by_name    — e.g. "Aanchal"
    //   • last_approved_at         — when (so user sees freshness)
    //   • approvals_count          — how many steps cleared so far
    //   • approvals_total          — workflow length (denominator)
    // All best-effort — wrap in try/catch so a missing column doesn't
    // break the whole list.
    //
    // PERF (mam 2026-06-25 "reload time it hangs"): this used to run ~4 DB
    // queries PER row. Over 900+ rows that was thousands of queries on every
    // reload → the page hung. Now we pre-fetch all 'approved' approvals in
    // ONE (chunked) query and memoize the routing / name lookups by their
    // handful of distinct keys.
    const ids = rows.map(r => r.id);
    const apprByReq = new Map();        // request_id -> [approval rows], step-ordered
    for (let i = 0; i < ids.length; i += 900) {
      const chunk = ids.slice(i, i + 900);
      const ph = chunk.map(() => '?').join(',');
      for (const a of await pg.all(`
        SELECT pa.request_id, pa.step, pa.step_name, pa.approved_at, pa.step_amount, u.name AS by_name
          FROM payment_approvals pa LEFT JOIN users u ON u.id = pa.approved_by
         WHERE pa.action = 'approved' AND pa.request_id IN (${ph})
         ORDER BY pa.step, pa.id`, ...chunk)) {
        if (!apprByReq.has(a.request_id)) apprByReq.set(a.request_id, []);
        apprByReq.get(a.request_id).push(a);
      }
    }
    // Memoized lookups — only a few distinct (category, step) and names exist.
    const routeMemo = new Map();
    const routeFor = async (cat, step) => { const k = cat + '|' + step; if (!routeMemo.has(k)) routeMemo.set(k, (await getApprovalRoutingFor(pg, cat, step)) || null); return routeMemo.get(k); };
    const idNameMemo = new Map();
    const nameById = async (uid) => { if (!idNameMemo.has(uid)) idNameMemo.set(uid, (await pg.get('SELECT name FROM users WHERE id=?', uid))?.name || null); return idNameMemo.get(uid); };
    const byNameMemo = new Map();
    const userForName = async (nm) => { if (!byNameMemo.has(nm)) byNameMemo.set(nm, (await resolveUserByName(pg, nm)) || null); return byNameMemo.get(nm); };

    for (const row of rows) {
      try {
        const workflow = WORKFLOW[row.category] || [];
        row.approvals_total = workflow.length || null;
        const curStep = workflow.find(w => w.step === row.current_step);
        row.current_step_name = curStep?.name || null;
        if (curStep) {
          const overrideUserId = await routeFor(row.category, row.current_step);
          if (overrideUserId) row.next_approver_name = await nameById(overrideUserId);
          else if (curStep.approver_name) { const u = await userForName(curStep.approver_name); row.next_approver_name = u?.name || curStep.approver_name; }
          else row.next_approver_name = null;
          row.next_approver_role = curStep.approver_role || null;
        }
        const appr = apprByReq.get(row.id) || [];
        if (appr.length) {
          const last = appr[appr.length - 1];          // highest step, latest id
          row.last_approved_step_name = last.step_name;
          row.last_approved_by_name   = last.by_name;
          row.last_approved_at        = last.approved_at;
        }
        row.approvals_count = new Set(appr.map(a => a.step)).size;
        // mam 2026-06-30: a request marked final_approved ("Paid") that never got
        // L2 (Nitin) / L3 (MD) was wrongly released under the old flow. Flag it so
        // the UI shows it as NOT actually paid (display only — data untouched).
        {
          const names = appr.map(a => String(a.step_name || '').toLowerCase());
          const flow = WORKFLOW[row.category] || [];
          const needsL2 = flow.some(w => /\bL2\b|nitin/i.test(w.name));
          const needsL3 = flow.some(w => /\bL3\b|ankur/i.test(w.name));
          const hasL2 = !needsL2 || names.some(n => n.includes('l2') || n.includes('nitin'));
          const hasL3 = !needsL3 || names.some(n => n.includes('l3') || n.includes('ankur'));
          row.l3_missing = (row.status === 'final_approved') && (!hasL2 || !hasL3);
        }
        row.step_amounts = {};
        for (const a of appr) row.step_amounts[a.step] = (a.step_amount != null ? +a.step_amount : (+row.approved_amount || +row.amount || 0));
      } catch (e) {
        console.warn('[payment-required GET] enrich failed for row', row.id, e.message);
      }
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET stats — scoped same way as the list. A site engineer's "totals"
// reflect only their own requests so the cards don't expose other users'
// activity.
router.get('/stats', requirePermission('payment_required', 'view'), async (req, res) => {
  try {
    const all = await seesAll(req);
    const where = all ? '' : ' WHERE created_by = ?';
    const args = all ? [] : [req.user.id];
    const total = await pg.get(`SELECT COUNT(*) as c FROM payment_requests${where}`, ...args);
    const totalAmount = await pg.get(`SELECT COALESCE(SUM(amount),0) as t FROM payment_requests${where}`, ...args);
    const pending = await pg.get(`SELECT COUNT(*) as c FROM payment_requests WHERE status NOT IN ('final_approved','rejected')${all ? '' : ' AND created_by = ?'}`, ...args);
    const approved = await pg.get(`SELECT COUNT(*) as c FROM payment_requests WHERE status='final_approved'${all ? '' : ' AND created_by = ?'}`, ...args);
    const rejected = await pg.get(`SELECT COUNT(*) as c FROM payment_requests WHERE status='rejected'${all ? '' : ' AND created_by = ?'}`, ...args);
    const byCategory = await pg.all(`SELECT category, COUNT(*) as count, COALESCE(SUM(amount),0) as amount FROM payment_requests${where} GROUP BY category`, ...args);
    const byStep = await pg.all(`SELECT current_step, COUNT(*) as count FROM payment_requests WHERE status NOT IN ('final_approved','rejected')${all ? '' : ' AND created_by = ?'} GROUP BY current_step`, ...args);
    res.json({ total: total.c, totalAmount: totalAmount.t, pending: pending.c, approved: approved.c, rejected: rejected.c, byCategory, byStep });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── My Inbox (mam 2026-05-22) ─────────────────────────────────────
// Returns the payment requests where the CURRENT step's approver is
// the logged-in user.  Aanchal logs in → sees only step-1 HR rows
// where she has the override (or has the matching role).  Once she
// approves, the row moves to the next step and vanishes from her
// inbox; if that step's approver = Shubham, it appears in his.
//
// Two sources merged:
//   1. Explicit override — payment_approval_overrides row points at
//      this user for (category, current_step).
//   2. Role-based — no override set AND user's role matches the
//      workflow step's approver_role (e.g. "Accountant").
//
// Admin sees their own inbox too (when assigned) — not the whole
// firehose; for that they have All Requests / Pending tabs.
router.get('/my-inbox', requirePermission('payment_required', 'view'), async (req, res) => {
  try {
    const uid = req.user.id;

    // Pull every pending row in one shot; filter for "is mine" in JS
    // because the "next approver" logic spans 6 workflows × overrides
    // table — a single SQL with all the unions/joins would be hairy.
    const rows = await pg.all(`
      SELECT pr.*, u.name AS created_by_name
        FROM payment_requests pr
        LEFT JOIN users u ON pr.created_by = u.id
       WHERE pr.status NOT IN ('final_approved','rejected')
       ORDER BY pr.created_at DESC
    `);

    // What roles does this user have? (matches canUserApproveStep logic)
    const myRoles = (await pg.all(
      `SELECT r.name FROM user_roles ur JOIN roles r ON ur.role_id=r.id WHERE ur.user_id=?`, uid
    )).map(r => r.name);
    const isAdmin = req.user.role === 'admin';

    // Per-record RACI for payables — all assignments for the inbox records in
    // one batched query (mam 2026-06-25 RACI + late-tracking, per record).
    const raciByRecord = await getRaciForRecords(pg, 'payables', rows.map(r => r.id));
    const _nameCache = {};
    const nameById = async (id) => { if (!id) return null; if (!(id in _nameCache)) _nameCache[id] = (await pg.get('SELECT name FROM users WHERE id=?', id))?.name || null; return _nameCache[id]; };

    const inbox = [];
    for (const row of rows) {
      const workflow = WORKFLOW[row.category];
      if (!workflow) continue;
      const stepInfo = workflow.find(w => w.step === row.current_step);
      if (!stepInfo) continue;
      // System steps (Velocity Check) never go to a human inbox.
      if (stepInfo.approver_role === 'System') continue;

      const overrideUserId = await getApprovalRoutingFor(pg, row.category, row.current_step);
      let isMine = false;
      if (overrideUserId) {
        // Explicit override — ONLY the assigned user (or admin) is "next".
        isMine = overrideUserId === uid || isAdmin;
      } else {
        // No override — any user with the matching role is "next".
        isMine = myRoles.includes(stepInfo.approver_role) || isAdmin;
        // Also surface steps pinned to a NAMED approver (L2/L3/Release) and
        // the COO escalation, using the same check the approve action uses —
        // the role-only test above misses those (mam 2026-06-18).
        if (!isMine) isMine = await canUserApproveStep(pg, uid, row.category, row.current_step);
      }
      if (!isMine) continue;

      // Enrich the same way the list endpoint does so the UI can show
      // "✓ HR Approval by Aanchal · ⏳ Waiting on you" cleanly.
      try {
        row.approvals_total = workflow.length;
        row.current_step_name = stepInfo.name;
        row.next_approver_role = stepInfo.approver_role;
        const lastApproval = await pg.get(`
          SELECT pa.step_name, pa.approved_at, u.name AS approved_by_name
            FROM payment_approvals pa
            LEFT JOIN users u ON u.id = pa.approved_by
           WHERE pa.request_id = ? AND pa.action = 'approved'
           ORDER BY pa.step DESC, pa.id DESC LIMIT 1
        `, row.id);
        if (lastApproval) {
          row.last_approved_step_name = lastApproval.step_name;
          row.last_approved_by_name   = lastApproval.approved_by_name;
          row.last_approved_at        = lastApproval.approved_at;
        }
        const cleared = await pg.get(
          `SELECT COUNT(DISTINCT step) AS c FROM payment_approvals
            WHERE request_id = ? AND action = 'approved'`, row.id
        );
        row.approvals_count = cleared?.c || 0;
        // Per-step approved amount (mam 2026-06-15: per-level Pending/Approved
        // views — "when I select Approved on L1 then show how much amount").
        // step_amounts = { <step>: <amount approved at that step> }.
        row.step_amounts = {};
        for (const s of await pg.all(
          `SELECT step, step_amount FROM payment_approvals
            WHERE request_id = ? AND action = 'approved'`, row.id
        )) {
          row.step_amounts[s.step] = (s.step_amount != null ? +s.step_amount : (+row.approved_amount || +row.amount || 0));
        }
        // Full step pipeline for the rich bulk-approve card (mam 2026-06-25):
        // each workflow step with done / current / pending + who cleared it.
        const apprByStep = {};
        for (const a of await pg.all(
          `SELECT pa.step, pa.approved_at, u.name AS by_name
             FROM payment_approvals pa LEFT JOIN users u ON u.id = pa.approved_by
            WHERE pa.request_id = ? AND pa.action = 'approved'`, row.id
        )) { apprByStep[a.step] = a; }
        // RACI + timing per step: elapsed = time from the previous step's clear
        // (or the request creation) to this step; for the CURRENT step it's how
        // long it's been waiting NOW. late = elapsed beyond the step's SLA hours.
        const HOUR = 3600000, nowMs = Date.now();
        let prevTime = tsMs(row.created_at);
        row.steps = [];
        for (const w of workflow) {
          const done = apprByStep[w.step];
          const isCurrent = !done && w.step === row.current_step;
          const cfg = (raciByRecord[row.id] || {})[String(w.step)];
          const sla = cfg && cfg.sla_hours != null ? +cfg.sla_hours : null;
          let elapsed = null;
          const atMs = done ? tsMs(done.approved_at) : null;
          if (done && prevTime != null && atMs != null) { elapsed = Math.max(0, (atMs - prevTime) / HOUR); prevTime = atMs; }
          else if (isCurrent && prevTime != null) { elapsed = Math.max(0, (nowMs - prevTime) / HOUR); }
          const late = (elapsed != null && sla != null && elapsed > sla) ? elapsed - sla : 0;
          row.steps.push({
            step: w.step, name: w.name,
            status: done ? 'done' : (isCurrent ? 'current' : 'pending'),
            by_name: done ? done.by_name : null,
            at: done ? done.approved_at : null,
            raci: cfg ? { responsible: await nameById(cfg.responsible_id), accountable: await nameById(cfg.accountable_id), consulted: await nameById(cfg.consulted_id), informed: await nameById(cfg.informed_id), sla_hours: sla } : null,
            elapsed_hours: elapsed != null ? Math.round(elapsed * 10) / 10 : null,
            late_hours: late > 0 ? Math.round(late * 10) / 10 : 0,
          });
        }
      } catch (_) {}
      inbox.push(row);
    }
    res.json(inbox);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lightweight inbox count for the bell badge — same logic as
// /my-inbox but only returns { count }.  Polled by the header every
// 60s so we don't ship the full request list each time.
router.get('/my-inbox-count', requirePermission('payment_required', 'view'), async (req, res) => {
  try {
    const uid = req.user.id;
    const isAdmin = req.user.role === 'admin';
    const myRoles = (await pg.all(
      `SELECT r.name FROM user_roles ur JOIN roles r ON ur.role_id=r.id WHERE ur.user_id=?`, uid
    )).map(r => r.name);
    const rows = await pg.all(`
      SELECT id, category, current_step FROM payment_requests
       WHERE status NOT IN ('final_approved','rejected')
    `);
    let count = 0;
    for (const row of rows) {
      const workflow = WORKFLOW[row.category];
      if (!workflow) continue;
      const stepInfo = workflow.find(w => w.step === row.current_step);
      if (!stepInfo || stepInfo.approver_role === 'System') continue;
      const overrideUserId = await getApprovalRoutingFor(pg, row.category, row.current_step);
      if (overrideUserId) {
        if (overrideUserId === uid || isAdmin) count++;
      } else {
        if (myRoles.includes(stepInfo.approver_role) || isAdmin) count++;
      }
    }
    res.json({ count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET single with workflow
// Numeric-only param so '/approval-routing' (declared below) isn't swallowed —
// Postgres rejects a non-numeric id cast where SQLite just returned nothing.
router.get('/:id(\\d+)', requirePermission('payment_required', 'view'), async (req, res, next) => {
  try {
    // Mam (2026-05-22): a numeric-id route at /:id was greedily matching
    // sibling routes like /approval-routing (registered later) because
    // Express matches in registration order.  Skip to next() when the
    // path component is clearly not a numeric ID so Express can find
    // the right handler.
    if (!/^\d+$/.test(String(req.params.id || ''))) return next();
    // Defensive ownership check — even if an approver-only ID leaks into
    // another user's URL, the GET must respect the scope rule.
    const ownRow = await pg.get('SELECT created_by FROM payment_requests WHERE id=?', req.params.id);
    if (!ownRow) return res.status(404).json({ error: 'Not found' });
    if (!(await seesAll(req)) && ownRow.created_by !== req.user.id) {
      return res.status(403).json({ error: 'You can only view your own requests' });
    }
    const request = await pg.get('SELECT pr.*, u.name as created_by_name FROM payment_requests pr LEFT JOIN users u ON pr.created_by=u.id WHERE pr.id=?', req.params.id);
    if (!request) return res.status(404).json({ error: 'Not found' });
    request.approvals = await pg.all(`SELECT pa.*, u.name as approved_by_name FROM payment_approvals pa LEFT JOIN users u ON pa.approved_by=u.id WHERE pa.request_id=? ORDER BY pa.step`, req.params.id);
    request.workflow = WORKFLOW[request.category] || [];
    request.can_approve_current = await canUserApproveStep(pg, req.user.id, request.category, request.current_step);
    // Mam (2026-05-22): same next-approver enrichment as the list
    // endpoint, so the detail modal's workflow strip can show
    // "WAITING ON: <name>" on the current step.
    try {
      const curStep = request.workflow.find(w => w.step === request.current_step);
      if (curStep) {
        const overrideUserId = await getApprovalRoutingFor(pg, request.category, request.current_step);
        if (overrideUserId) {
          const u = await pg.get('SELECT name FROM users WHERE id=?', overrideUserId);
          request.next_approver_name = u?.name || null;
        }
        request.next_approver_role = curStep.approver_role;
        request.current_step_name = curStep.name;
      }
    } catch (_) {}
    res.json(request);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST create
router.post('/', requirePermission('payment_required', 'create'), async (req, res) => {
  try {
    const b = req.body;
    if (!b.employee_name || !b.category || !b.amount || !b.purpose) {
      return res.status(400).json({ error: 'Employee, category, amount, purpose required' });
    }
    if (!WORKFLOW[b.category]) return res.status(400).json({ error: 'Invalid category' });
    // Vendor Name is mandatory for Purchase category (who are we paying?).
    if (b.category === 'Purchase' && !String(b.vendor_name || '').trim()) {
      return res.status(400).json({ error: 'Vendor name is required for Purchase requests' });
    }
    // Mandatory proofs by category + mode — keeps the audit trail clean.
    // Mam's rule: 'proofs must be uploaded at request time, not after'.
    const missingProofs = [];
    if (b.category === 'TA/DA') {
      if (['Bus','Train','Flight'].includes(b.mode_of_travel) && !b.ticket_upload) {
        missingProofs.push('Travel Ticket');
      }
      if (['Car','Bike'].includes(b.mode_of_travel)) {
        if (!b.km_photo) missingProofs.push('Start KM Photo');
        if (!b.end_km_photo) missingProofs.push('End KM Photo');
      }
    }
    if (b.category === 'Purchase' && !b.quotation_link) {
      missingProofs.push('Quotation / Purchase Order');
    }
    // Manpower Advance: at least one proof document is mandatory (mam 2026-06-29).
    if (b.category === 'Manpower Advance' && !b.advance_proof) {
      missingProofs.push('Proof / Document');
    }
    if (missingProofs.length > 0) {
      return res.status(400).json({ error: `Upload required proof${missingProofs.length > 1 ? 's' : ''} before submitting: ${missingProofs.join(', ')}` });
    }
    // Required By Date must be at least 5 days out — immediate payouts aren't possible.
    if (b.required_by_date) {
      const minDate = new Date(); minDate.setHours(0,0,0,0); minDate.setDate(minDate.getDate() + 5);
      const reqDate = new Date(b.required_by_date);
      if (reqDate < minDate) {
        return res.status(400).json({ error: `Required By Date must be on or after ${minDate.toISOString().split('T')[0]} (today + 5 days)` });
      }
    }

    // Duplicate guard (mam 2026-06-27): a double-clicked Submit on a slow
    // connection was creating 3-4 identical PRs at the same minute (e.g.
    // PR-2026-1044..1047, Vivek Kumar Rs 210). Reject an identical request —
    // same employee + category + amount + purpose + site — created in the last
    // 90 seconds. The frontend also disables the button while submitting; this
    // is the server-side safety net for genuine races / repeated API posts.
    try {
      // 90 seconds ago, as the same UTC text the created_at column stores.
      const cutoff90 = new Date(Date.now() - 90 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      const dup = await pg.get(`
        SELECT request_no FROM payment_requests
         WHERE employee_name = ? AND category = ? AND amount = ?
           AND COALESCE(purpose,'') = COALESCE(?, '')
           AND COALESCE(site_name,'') = COALESCE(?, '')
           AND status != 'rejected'
           AND created_at >= ?
         ORDER BY id DESC LIMIT 1
      `, b.employee_name, b.category, +b.amount, b.purpose || '', b.site_name || '', cutoff90);
      if (dup) {
        return res.status(409).json({ error: `Duplicate request — an identical payment request (${dup.request_no}) was just created. It's already in the queue; no need to submit again.` });
      }
    } catch (_) { /* if the guard query fails, fall through and create normally */ }

    const { nextSequencePg } = require('../db/nextSequence');
    const yr = new Date().getFullYear();
    // Schema column is `request_no` (NOT request_number) — earlier mismatch
    // crashed the create with "no such column: request_number" on the live VPS.
    const requestNo = await nextSequencePg(pg, 'payment_requests', 'request_no', `PR-${yr}-`, { startFrom: 0, pad: 4 });

    // (The old idempotent ALTER TABLE column adds — ticket_upload / start_km /
    // end_km / km_photo / end_km_photo / advance_proof — are gone: the columns
    // live in the migrated Postgres schema.)

    // Starting step: TA/DA now begins at the HR step (0); every other category
    // still begins at L1 (1). This is what makes only NEW TA/DA requests require
    // HR before L1 — existing rows are untouched.
    const startStep = (b.category === 'TA/DA') ? TADA_FLOW[0].step : 1;
    const r = await pg.run(`INSERT INTO payment_requests (
      request_no, employee_name, site_id, site_name, department, contact_number, category, amount, purpose,
      payment_mode, required_by_date,
      travel_from_to, travel_dates, mode_of_travel, stay_details, ticket_upload, start_km, end_km, km_photo, end_km_photo,
      indent_number, item_description, vendor_name, quotation_link, advance_proof,
      labour_type, number_of_workers, work_duration, site_engineer_name,
      vehicle_type, from_to_location, material_description, driver_vendor_name,
      created_by, current_step
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      requestNo, b.employee_name, b.site_id || null, b.site_name, b.department, b.contact_number,
      b.category, b.amount, b.purpose, b.payment_mode || 'Bank', b.required_by_date || null,
      b.travel_from_to, b.travel_dates, b.mode_of_travel, b.stay_details,
      b.ticket_upload, b.start_km || 0, b.end_km || 0, b.km_photo, b.end_km_photo,
      b.indent_number, b.item_description, b.vendor_name, b.quotation_link, b.advance_proof || null,
      b.labour_type, b.number_of_workers || 0, b.work_duration, b.site_engineer_name,
      b.vehicle_type, b.from_to_location, b.material_description, b.driver_vendor_name,
      req.user.id, startStep
    );
    // Push to step-1 approvers (everyone with payment_required.approve permission)
    try {
      const { notifyMany } = require('../lib/push');
      const approvers = (await pg.all(`
        SELECT DISTINCT u.id FROM users u
        LEFT JOIN user_roles ur ON ur.user_id = u.id
        LEFT JOIN role_permissions rp ON rp.role_id = ur.role_id
        WHERE COALESCE(u.active,1)=1
          AND (u.role='admin' OR (rp.module='payment_required' AND rp.can_approve=1))
      `)).map(x => x.id);
      notifyMany(approvers, {
        title: `💸 ${requestNo} — ${b.category} Rs ${(b.amount || 0).toLocaleString('en-IN')}`,
        body: `${b.employee_name}: ${b.purpose}`.slice(0, 180),
        url: '/payment-required',
        tag: `payment-${r.lastInsertRowid}`,
      });
    } catch {}
    // Mam (2026-05-22): removed the in-app bell ping on create.
    // My Inbox tab + 60s badge poll already surface what each
    // approver needs to act on without bell noise.
    fireEmailEvent('payment.requested', {
      amount: Math.round(+b.amount || 0).toLocaleString('en-IN'),
      party: b.vendor_name || '',
      category: b.category || '',
      site: b.site_name || '',
      purpose: b.purpose || '',
      requested_by: b.employee_name || req.user.name || '',
      date: new Date().toISOString().slice(0, 10),
      requester_email: req.user.email || await userEmail(pg, req.user.id),
      director_email: directorEmail(),
    });
    res.status(201).json({ id: r.lastInsertRowid, request_no: requestNo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Returns the flow step a request must go BACK to before it can be released, or
// null if it's clear. Enforces L2 (Nitin) + L3 (MD) before Payment Release — old
// TA/DA requests had jumped from Accountant straight to Release, getting marked
// "Paid" without Nitin/MD sign-off (mam 2026-06-30: "these records are wrong —
// fix flow"). Matched by step NAME, because old records used different step
// NUMBERS for the same role (e.g. old "step 2 = Accountant", new "step 2 = L2").
async function preReleaseGap(dbx, request) {
  const flow = WORKFLOW[request.category] || STANDARD_FLOW;
  const releaseStep = flow[flow.length - 1].step;
  if (request.current_step !== releaseStep) return null;
  const names = (await dbx.all("SELECT step_name FROM payment_approvals WHERE request_id=? AND action='approved'", request.id))
    .map(a => String(a.step_name || '').toLowerCase());
  const needL2 = flow.find(w => /\bL2\b|nitin/i.test(w.name));
  const needL3 = flow.find(w => /\bL3\b|ankur/i.test(w.name));
  if (needL2 && !names.some(n => n.includes('l2') || n.includes('nitin'))) return needL2;
  if (needL3 && !names.some(n => n.includes('l3') || n.includes('ankur'))) return needL3;
  return null;
}

// Helper: advance to next step
async function advanceToNextStep(dbx, request, approvedBy) {
  const workflow = WORKFLOW[request.category];
  const currentStepIdx = workflow.findIndex(w => w.step === request.current_step);
  const nextStepInfo = workflow[currentStepIdx + 1];

  if (!nextStepInfo) {
    // Don't finalize / mark Paid if L2 (Nitin) or L3 (MD) was skipped — route it
    // back to the missing step instead (mam 2026-06-30). Backstop for any path
    // (incl. bulk approve) that reaches finalize with a gap.
    const gap = await preReleaseGap(dbx, request);
    if (gap) {
      await dbx.run('UPDATE payment_requests SET current_step=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', gap.step, 'pending', request.id);
      return 'redirected';
    }
    // Last step - final approved
    await dbx.run('UPDATE payment_requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', 'final_approved', request.id);
    // Add to cash flow outflow
    // (Best-effort like before — when we're running inside a Postgres
    // transaction the whole block sits under a savepoint so a failure here
    // can't poison the surrounding tx.)
    const bestEffort = dbx.savepoint ? (fn) => dbx.savepoint(fn) : (fn) => fn();
    try {
      await bestEffort(async () => {
        const today = new Date().toISOString().split('T')[0];
        let daily = await dbx.get('SELECT id FROM cash_flow_daily WHERE date=?', today);
        if (!daily) {
          const prev = await dbx.get('SELECT closing_balance FROM cash_flow_daily WHERE date < ? ORDER BY date DESC LIMIT 1', today);
          const dr = await dbx.run('INSERT INTO cash_flow_daily (date, opening_balance, closing_balance) VALUES (?,?,?)', today, prev?.closing_balance || 0, prev?.closing_balance || 0);
          daily = { id: dr.lastInsertRowid };
        }
        // Pay out the latest approver-agreed amount, not the original
        // request (mam 2026-05-28). Falls back to the original when no
        // approver ever overrode.
        const payoutAmount = (request.approved_amount != null) ? +request.approved_amount : +request.amount;
        await dbx.run('INSERT INTO cash_flow_entries (daily_id, date, type, category, description, amount, party_name, created_by) VALUES (?,?,?,?,?,?,?,?)',
          daily.id, today, 'outflow', request.category, `Payment: ${request.request_no} - ${request.purpose}`, payoutAmount, request.employee_name, approvedBy);
      });
    } catch (e) {}
    return 'final_approved';
  }

  // Move to next step
  await dbx.run('UPDATE payment_requests SET current_step=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', nextStepInfo.step, request.id);

  // Mam (2026-05-22): removed the in-app bell ping on step advance.
  // The 📥 My Inbox tab + 60s badge poll already surface what each
  // approver needs to act on; bells were too noisy.
  // (mam 2026-06-11: the auto Velocity Check at step 3 was retired when every
  // category moved to the standard L1→L2→L3→Release flow — step 3 is now the
  // manual L3 Approval, so there is no auto-advance/auto-reject here anymore.)

  return 'step_advanced';
}

// Separation of duties (mam 2026-07-08 bug: an admin who FILLED a payable could
// approve every step himself in seconds → instant "Final Approved / Paid",
// bypassing L1 Accountant → L2 Nitin → L3 MD → Release Aanchal). Rule, applied to
// EVERYONE including admin/COO: the person who RAISED the request can't approve
// it — the whole point of the chain is that someone else signs off. Returns a
// reason string, or null if OK.
// NOTE: we deliberately do NOT block a user from approving two DIFFERENT steps of
// the same request — the COO is meant to stand in for both L2 and L3 (see the
// payment-approval-flow note). Blocking that would break intentional coverage.
function sodBlockReason(dbx, request, userId) {
  if (request.created_by === userId) return 'you raised this request';
  return null;
}

// PUT approve
// Authorisation here is the STEP-APPROVER check below (canUserApproveStep:
// admin / routing override / named approver / matching role / COO), NOT the
// generic module 'approve' permission — that toggle was wrongly blocking the
// designated approvers (e.g. L2 Nitin Jain) whose role didn't have it ticked
// (mam 2026-06-18). authMiddleware still requires a logged-in user.
router.put('/:id/approve', async (req, res) => {
  try {
    const { remarks, approved_amount } = req.body;
    // Remarks are OPTIONAL on approval (mam 2026-06-18). Only rejection
    // demands a reason — see the /reject handler below.
    const request = await pg.get('SELECT * FROM payment_requests WHERE id=?', req.params.id);
    if (!request) return res.status(404).json({ error: 'Not found' });
    if (request.status === 'final_approved' || request.status === 'rejected') return res.status(400).json({ error: 'Already ' + request.status });

    if (!(await canUserApproveStep(pg, req.user.id, request.category, request.current_step))) {
      const workflow = WORKFLOW[request.category];
      const stepInfo = workflow?.find(w => w.step === request.current_step);
      return res.status(403).json({ error: `Not authorized. This step requires: ${stepInfo?.approver_role}` });
    }

    // Separation of duties — the person who raised the request can't approve it.
    const sod = sodBlockReason(pg, request, req.user.id);
    if (sod) return res.status(403).json({ error: `Separation of duties: ${sod}, so a different person must approve this step.` });

    // Block a release that skipped L2 (Nitin) / L3 (MD) — route it back to the
    // missing step with a clear message, before recording any approval (mam
    // 2026-06-30: "these records are wrong — fix flow"). Existing Paid records are
    // untouched (the final_approved check above returns first).
    const gap = await preReleaseGap(pg, request);
    if (gap) {
      await pg.run('UPDATE payment_requests SET current_step=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', gap.step, 'pending', request.id);
      return res.status(409).json({ error: `This ${request.category} skipped ${gap.name}. It can't be released without it — sent back to ${gap.name} for approval first.`, redirected_to: gap.step });
    }

    // Resolve the amount this step is approving.
    //  - approved_amount omitted → carry forward current approved amount
    //    (or original if no prior override).
    //  - approved_amount provided → validate: > 0 and ≤ original requested.
    //    Decrease-only guard prevents an approver paying out MORE than
    //    the requester asked for.
    const currentApproved = (request.approved_amount != null) ? +request.approved_amount : +request.amount;
    let stepAmount = currentApproved;
    if (approved_amount !== undefined && approved_amount !== null && approved_amount !== '') {
      const n = +approved_amount;
      if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'Approved amount must be a positive number' });
      if (n > +request.amount) return res.status(400).json({ error: `Approved amount cannot exceed the original request (Rs ${(+request.amount).toLocaleString('en-IN')})` });
      stepAmount = n;
    }

    const workflow = WORKFLOW[request.category];
    const stepInfo = workflow.find(w => w.step === request.current_step);
    await pg.run('INSERT INTO payment_approvals (request_id, step, step_name, action, remarks, step_amount, approved_by) VALUES (?,?,?,?,?,?,?)',
      request.id, request.current_step, stepInfo.name, 'approved', remarks || null, stepAmount, req.user.id);

    // Persist the new approved amount on the request itself so the next
    // approver (and the final cash-flow entry) see the latest figure.
    if (stepAmount !== currentApproved || request.approved_amount == null) {
      await pg.run('UPDATE payment_requests SET approved_amount=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', stepAmount, request.id);
      request.approved_amount = stepAmount;
    }

    const result = await advanceToNextStep(pg, request, req.user.id);
    fireEmailEvent('payment.approved', {
      amount: Math.round(stepAmount || 0).toLocaleString('en-IN'),
      party: request.vendor_name || '',
      category: request.category || '',
      step: stepInfo.name || '',
      approved_by: req.user.name || '',
      date: new Date().toISOString().slice(0, 10),
      requester_email: await userEmail(pg, request.created_by),
      director_email: directorEmail(),
    });
    res.json({ message: `${stepInfo.name} approved`, result, approved_amount: stepAmount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk approve — approve many requests at once at the current step (mam
// 2026-06-25: "approving one by one is very difficult; show all of a person's
// pending with proof and tick-tick approve"). Each id is gated by the SAME
// per-step authorisation as the single /approve; ones the caller can't approve
// (wrong step / already done) are skipped and reported, never error the batch.
// No per-item email (a 50-item batch would spam) — the step still advances.
router.post('/bulk-approve', async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.map(Number).filter(Boolean))] : [];
    if (!ids.length) return res.status(400).json({ error: 'No requests selected' });
    const approved = [], skipped = [];
    await pg.tx(async (t) => {
      for (const id of ids) {
        const request = await t.get('SELECT * FROM payment_requests WHERE id=?', id);
        if (!request) { skipped.push({ id, reason: 'not found' }); continue; }
        if (request.status === 'final_approved' || request.status === 'rejected') { skipped.push({ id, reason: 'already ' + request.status }); continue; }
        if (!(await canUserApproveStep(t, req.user.id, request.category, request.current_step))) { skipped.push({ id, reason: 'not your step' }); continue; }
        const sod = sodBlockReason(t, request, req.user.id);
        if (sod) { skipped.push({ id, reason: sod }); continue; }
        const workflow = WORKFLOW[request.category];
        const stepInfo = workflow && workflow.find(w => w.step === request.current_step);
        if (!stepInfo) { skipped.push({ id, reason: 'no workflow step' }); continue; }
        const stepAmount = (request.approved_amount != null) ? +request.approved_amount : +request.amount;
        await t.run('INSERT INTO payment_approvals (request_id, step, step_name, action, remarks, step_amount, approved_by) VALUES (?,?,?,?,?,?,?)',
          request.id, request.current_step, stepInfo.name, 'approved', req.body.remarks || null, stepAmount, req.user.id);
        if (request.approved_amount == null) {
          await t.run('UPDATE payment_requests SET approved_amount=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', stepAmount, request.id);
          request.approved_amount = stepAmount;
        }
        await advanceToNextStep(t, request, req.user.id);
        approved.push(id);
      }
    });
    res.json({ message: `Approved ${approved.length}${skipped.length ? `, skipped ${skipped.length}` : ''}`, approved, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk reject — reject many at once at the current step, one shared reason
// (mam 2026-06-25: "bulk approval along with rejection also"). Same per-step
// gate as single reject; reason required; skips ones not at the caller's step.
router.post('/bulk-reject', async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.map(Number).filter(Boolean))] : [];
    const remarks = String(req.body.remarks || '').trim();
    if (!ids.length) return res.status(400).json({ error: 'No requests selected' });
    if (remarks.length < 5) return res.status(400).json({ error: 'A rejection reason (min 5 characters) is required' });
    const rejected = [], skipped = [];
    await pg.tx(async (t) => {
      for (const id of ids) {
        const request = await t.get('SELECT * FROM payment_requests WHERE id=?', id);
        if (!request) { skipped.push({ id, reason: 'not found' }); continue; }
        if (request.status === 'final_approved' || request.status === 'rejected') { skipped.push({ id, reason: 'already ' + request.status }); continue; }
        if (!(await canUserApproveStep(t, req.user.id, request.category, request.current_step))) { skipped.push({ id, reason: 'not your step' }); continue; }
        const stepInfo = WORKFLOW[request.category]?.find(w => w.step === request.current_step);
        await t.run('INSERT INTO payment_approvals (request_id, step, step_name, action, remarks, approved_by) VALUES (?,?,?,?,?,?)',
          request.id, request.current_step, stepInfo?.name || 'Unknown', 'rejected', remarks, req.user.id);
        await t.run('UPDATE payment_requests SET status=?, rejection_remarks=?, rejected_by=?, rejected_at=CURRENT_TIMESTAMP WHERE id=?',
          'rejected', remarks, req.user.id, request.id);
        rejected.push(id);
      }
    });
    res.json({ message: `Rejected ${rejected.length}${skipped.length ? `, skipped ${skipped.length}` : ''}`, rejected, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT reject
// Same as /approve — gated by the step-approver check inside, not the
// generic module permission (mam 2026-06-18).
router.put('/:id/reject', async (req, res) => {
  try {
    const { remarks } = req.body;
    if (!remarks || remarks.trim().length < 5) return res.status(400).json({ error: 'Remarks required' });
    const request = await pg.get('SELECT * FROM payment_requests WHERE id=?', req.params.id);
    if (!request) return res.status(404).json({ error: 'Not found' });
    if (!(await canUserApproveStep(pg, req.user.id, request.category, request.current_step))) return res.status(403).json({ error: 'Not authorized' });

    const stepInfo = WORKFLOW[request.category]?.find(w => w.step === request.current_step);
    await pg.run('INSERT INTO payment_approvals (request_id, step, step_name, action, remarks, approved_by) VALUES (?,?,?,?,?,?)',
      request.id, request.current_step, stepInfo?.name || 'Unknown', 'rejected', remarks, req.user.id);
    await pg.run('UPDATE payment_requests SET status=?, rejection_remarks=?, rejected_by=?, rejected_at=CURRENT_TIMESTAMP WHERE id=?',
      'rejected', remarks, req.user.id, request.id);
    fireEmailEvent('payment.rejected', {
      amount: Math.round(+request.amount || 0).toLocaleString('en-IN'),
      party: request.vendor_name || '',
      category: request.category || '',
      rejected_by: req.user.name || '',
      reason: remarks,
      date: new Date().toISOString().slice(0, 10),
      requester_email: await userEmail(pg, request.created_by),
      director_email: directorEmail(),
    });
    res.json({ message: 'Rejected' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requirePermission('payment_required', 'delete'), async (req, res) => {
  try {
    await pg.run('DELETE FROM payment_approvals WHERE request_id=?', req.params.id);
    await pg.run('DELETE FROM payment_requests WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin-only: edit the request amount (mam 2026-06-17, e.g. a salary increase).
// Unlike the approver decrease-only guard, the admin can set ANY positive
// amount. We sync approved_amount to the new figure so the rest of the chain
// (and the final payout) use it, and log an audit line. Not allowed once the
// request is finalised / rejected.
router.patch('/:id/amount', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can edit the amount' });
    const request = await pg.get('SELECT * FROM payment_requests WHERE id=?', req.params.id);
    if (!request) return res.status(404).json({ error: 'Not found' });
    if (request.status === 'final_approved' || request.status === 'rejected') {
      return res.status(400).json({ error: 'Cannot edit the amount of a finalised / rejected request' });
    }
    const n = +req.body?.amount;
    if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'Amount must be a positive number' });
    const old = +request.amount;
    await pg.run('UPDATE payment_requests SET amount=?, approved_amount=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
      n, n, req.params.id);
    try {
      await pg.run('INSERT INTO payment_approvals (request_id, step, step_name, action, remarks, step_amount, approved_by) VALUES (?,?,?,?,?,?,?)',
        request.id, request.current_step, 'Amount edited (admin)', 'amount_edit',
        `Amount changed from Rs ${old.toLocaleString('en-IN')} to Rs ${n.toLocaleString('en-IN')} by ${req.user.name || 'admin'}`,
        n, req.user.id);
    } catch (_) {}
    res.json({ message: 'Amount updated', amount: n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH attach a proof URL to an existing request. Some users miss the
// upload step on the form and the approver only sees "No proofs uploaded"
// — this endpoint lets the original creator OR an approver fix it after
// the fact, before the request is finalised.
//   field options: ticket_upload | km_photo | end_km_photo | quotation_link | attachment_link
router.patch('/:id/proof', requirePermission('payment_required', 'view'), async (req, res) => {
  try {
    const { field, url } = req.body;
    const allowed = ['ticket_upload', 'km_photo', 'end_km_photo', 'quotation_link', 'attachment_link'];
    if (!allowed.includes(field)) return res.status(400).json({ error: 'Invalid proof field' });
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL required' });
    const request = await pg.get('SELECT created_by, status, category FROM payment_requests WHERE id=?', req.params.id);
    if (!request) return res.status(404).json({ error: 'Not found' });
    if (request.status === 'final_approved' || request.status === 'rejected') {
      return res.status(400).json({ error: 'Cannot edit proofs on finalised request' });
    }
    // Permission: admin, original creator, OR anyone who can approve this category
    const isOwner = request.created_by === req.user.id;
    const isAdmin = req.user.role === 'admin';
    const canApprove = (await canUserApproveStep(pg, req.user.id, request.category, 0)) ||
                       (await canUserApproveStep(pg, req.user.id, request.category, 1)) ||
                       (await canUserApproveStep(pg, req.user.id, request.category, 2)) ||
                       (await canUserApproveStep(pg, req.user.id, request.category, 4)) ||
                       (await canUserApproveStep(pg, req.user.id, request.category, 5));
    if (!isOwner && !isAdmin && !canApprove) {
      return res.status(403).json({ error: 'Only the request creator or an approver can attach proofs' });
    }
    await pg.run(`UPDATE payment_requests SET ${field} = ? WHERE id = ?`, url, req.params.id);
    res.json({ message: 'Proof attached', field, url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET / PUT approval routing ─────────────────────────────────
// Returns the full matrix of categories × steps with current
// assignee (override if set, else NULL = role-based fallback).
// Used by the admin UI to render the routing table.
// Helper: make sure the override table exists.  Module-load CREATE
// can race with DB init on fresh boots, so we self-heal here.
async function ensureOverrideTable(dbx) {
  try {
    await dbx.run(`
      CREATE TABLE IF NOT EXISTS payment_approval_overrides (
        category TEXT NOT NULL,
        step INTEGER NOT NULL,
        user_id INTEGER REFERENCES users(id),
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_by INTEGER REFERENCES users(id),
        PRIMARY KEY (category, step)
      )
    `);
  } catch (_) { /* fine — table already exists or db locked momentarily */ }
}

router.get('/approval-routing', async (req, res) => {
  try {
    await ensureOverrideTable(pg);
    let overrides = [];
    try {
      overrides = await pg.all(`
        SELECT o.category, o.step, o.user_id, u.name as user_name
        FROM payment_approval_overrides o
        LEFT JOIN users u ON o.user_id = u.id
      `);
    } catch (e) {
      // Table genuinely missing (fresh DB) — fall through with empty map
      console.warn('[payment-required/approval-routing] overrides table read failed:', e.message);
    }
    const map = {};
    for (const o of overrides) {
      map[`${o.category}_${o.step}`] = { user_id: o.user_id, user_name: o.user_name };
    }
    // Build the response by walking the static WORKFLOW so admin sees
    // every step that exists per category, with the current assignee
    // (override > NULL).
    const matrix = {};
    for (const [category, steps] of Object.entries(WORKFLOW)) {
      matrix[category] = steps.map(s => {
        const o = map[`${category}_${s.step}`];
        return {
          step: s.step,
          name: s.name,
          role_default: s.approver_role || (s.approver_name ? `${s.approver_name} (named)` : null),
          override_user_id: o?.user_id || null,
          override_user_name: o?.user_name || null,
        };
      });
    }
    res.json({ matrix });
  } catch (e) {
    console.error('[payment-required/approval-routing GET] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.put('/approval-routing', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    await ensureOverrideTable(pg);
    const { category, step, user_id } = req.body || {};
    if (!category || !step) return res.status(400).json({ error: 'category and step required' });
    if (!WORKFLOW[category]) return res.status(400).json({ error: 'unknown category' });
    if (!WORKFLOW[category].find(s => s.step === +step)) return res.status(400).json({ error: 'unknown step for that category' });

    // user_id = null clears the override (returns to role-based)
    if (user_id == null || user_id === '' || user_id === 0) {
      await pg.run(`DELETE FROM payment_approval_overrides WHERE category=? AND step=?`, category, +step);
      return res.json({ cleared: true });
    }
    // Validate user exists
    const u = await pg.get(`SELECT id, name FROM users WHERE id=?`, +user_id);
    if (!u) return res.status(400).json({ error: 'unknown user_id' });
    await pg.run(`
      INSERT INTO payment_approval_overrides (category, step, user_id, updated_at, updated_by)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(category, step) DO UPDATE SET user_id=excluded.user_id,
        updated_at=CURRENT_TIMESTAMP, updated_by=excluded.updated_by
    `, category, +step, +user_id, req.user.id);
    res.json({ category, step: +step, user_id: u.id, user_name: u.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
