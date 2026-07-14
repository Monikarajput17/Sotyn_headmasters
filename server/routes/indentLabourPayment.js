// Indent Labour Payment — full project execution + billing pipeline.
// Mam (2026-06-01, amended 2026-06-02 — "it create wrong project …
// first amend it"): Projects are MANUALLY entered (unique name, no
// PO column).  Each project has three labour spend streams:
//   L1 Salary       (proj_salary_entries)
//   L2 Daily Wages  (proj_daily_wage_entries)
//   L3 Sub-contract (proj_work_orders + amount_paid running total)
// Budget = SUM of all three.
//
// Legacy capture: old (pre-ERP) projects get one-off 'legacy' rows
// for L1 + L2 to record what was already spent before the ERP came
// online.  For L3 the WO row itself carries amount_paid which can
// include legacy payment.

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ─── helper: per-project rollups ────────────────────────────────
// Returns { l1, l2, l3, budget } for a single project_id.  L3
// budget contribution is the running amount_paid against WOs (not
// the planned_value).
function projectRollup(db, projectId) {
  const l1 = num(db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM proj_salary_entries WHERE project_id = ?`
  ).get(projectId)?.s);
  const l2 = num(db.prepare(
    `SELECT COALESCE(SUM(total_amount), 0) AS s FROM proj_daily_wage_entries WHERE project_id = ?`
  ).get(projectId)?.s);
  const l3 = num(db.prepare(
    `SELECT COALESCE(SUM(amount_paid), 0) AS s FROM proj_work_orders WHERE project_id = ?`
  ).get(projectId)?.s);
  return { l1, l2, l3, budget: l1 + l2 + l3 };
}

// ════════════════════════════════════════════════════════════════
// PROJECT CRUD
// ════════════════════════════════════════════════════════════════
router.get('/projects', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  const { q, owner } = req.query;
  let sql = `
    SELECT p.id, p.name, COALESCE(p.owner, 'Aanchal') AS owner, p.notes,
           p.created_at, p.updated_at,
           (SELECT COALESCE(SUM(amount), 0)       FROM proj_salary_entries     WHERE project_id = p.id) AS l1,
           (SELECT COALESCE(SUM(total_amount), 0) FROM proj_daily_wage_entries WHERE project_id = p.id) AS l2,
           (SELECT COALESCE(SUM(amount_paid), 0)  FROM proj_work_orders        WHERE project_id = p.id) AS l3,
           (SELECT COUNT(*)                       FROM proj_work_orders        WHERE project_id = p.id) AS work_order_count
      FROM proj_projects p
     WHERE 1=1
  `;
  const params = [];
  if (q) {
    sql += ` AND (LOWER(p.name) LIKE ? OR LOWER(COALESCE(p.notes,'')) LIKE ?)`;
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like);
  }
  if (owner) {
    sql += ` AND COALESCE(p.owner, 'Aanchal') = ?`;
    params.push(owner);
  }
  sql += ` ORDER BY p.created_at DESC`;
  const rows = db.prepare(sql).all(...params).map(r => ({ ...r, budget: r.l1 + r.l2 + r.l3 }));
  res.json(rows);
});

router.get('/projects/:id', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  const row = db.prepare(
    `SELECT id, name, COALESCE(owner, 'Aanchal') AS owner, notes, created_at, updated_at
       FROM proj_projects WHERE id = ?`
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Project not found' });
  res.json({ ...row, ...projectRollup(db, row.id) });
});

router.post('/projects', requirePermission('indent_labour_payment', 'create'), (req, res) => {
  const db = getDb();
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Project name is required' });
  // Uniqueness — surface as a friendly error instead of the raw
  // SQLITE_CONSTRAINT.  Case-insensitive check.
  const dup = db.prepare(`SELECT id FROM proj_projects WHERE LOWER(TRIM(name)) = LOWER(?)`).get(name);
  if (dup) return res.status(409).json({ error: 'A project with this name already exists' });
  const owner = String(req.body?.owner || 'Aanchal').trim() || 'Aanchal';
  const notes = req.body?.notes || null;
  const r = db.prepare(
    `INSERT INTO proj_projects (name, owner, notes, created_by) VALUES (?, ?, ?, ?)`
  ).run(name, owner, notes, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/projects/:id', requirePermission('indent_labour_payment', 'edit'), (req, res) => {
  const db = getDb();
  const cur = db.prepare(`SELECT id FROM proj_projects WHERE id = ?`).get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Project not found' });
  const name = req.body?.name != null ? String(req.body.name).trim() : null;
  if (name === '') return res.status(400).json({ error: 'Project name cannot be blank' });
  if (name) {
    const dup = db.prepare(
      `SELECT id FROM proj_projects WHERE LOWER(TRIM(name)) = LOWER(?) AND id <> ?`
    ).get(name, req.params.id);
    if (dup) return res.status(409).json({ error: 'Another project already uses this name' });
  }
  db.prepare(
    `UPDATE proj_projects
        SET name = COALESCE(?, name),
            owner = COALESCE(?, owner),
            notes = COALESCE(?, notes),
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(name, req.body?.owner ?? null, req.body?.notes ?? null, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/projects/:id', requirePermission('indent_labour_payment', 'edit'), (req, res) => {
  const db = getDb();
  const cur = db.prepare(`SELECT id FROM proj_projects WHERE id = ?`).get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Project not found' });
  // CASCADE on the FKs handles salary / daily-wage / WOs.
  db.prepare(`DELETE FROM proj_projects WHERE id = ?`).run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ─── owners list (filter dropdown) ──────────────────────────────
router.get('/owners', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT COALESCE(owner, 'Aanchal') AS owner, COUNT(*) AS project_count
       FROM proj_projects
      GROUP BY COALESCE(owner, 'Aanchal')
      ORDER BY (CASE WHEN COALESCE(owner,'Aanchal')='Aanchal' THEN 0 ELSE 1 END), owner`
  ).all();
  res.json(rows);
});

// ════════════════════════════════════════════════════════════════
// L1 SALARY ENTRIES
// ════════════════════════════════════════════════════════════════
router.get('/projects/:pid/salary', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  res.json(db.prepare(
    `SELECT id, kind, employee_name, period_month, amount, notes, created_at
       FROM proj_salary_entries
      WHERE project_id = ?
      ORDER BY (CASE kind WHEN 'legacy' THEN 0 ELSE 1 END), period_month DESC, id DESC`
  ).all(req.params.pid));
});

router.post('/projects/:pid/salary', requirePermission('indent_labour_payment', 'create'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const kind = b.kind === 'legacy' ? 'legacy' : 'monthly';
  const amount = num(b.amount);
  if (amount <= 0) return res.status(400).json({ error: 'Amount must be > 0' });
  if (kind === 'monthly' && !b.period_month) {
    return res.status(400).json({ error: 'period_month (YYYY-MM) required for monthly entries' });
  }
  // Legacy is a single bulk row per project — block duplicates so
  // mam can't accidentally enter the legacy carry twice.
  if (kind === 'legacy') {
    const exists = db.prepare(
      `SELECT id FROM proj_salary_entries WHERE project_id=? AND kind='legacy'`
    ).get(req.params.pid);
    if (exists) return res.status(409).json({ error: 'Legacy salary already captured for this project. Edit it instead of adding a second.' });
  }
  const r = db.prepare(
    `INSERT INTO proj_salary_entries (project_id, kind, employee_name, period_month, amount, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.params.pid, kind, b.employee_name || null,
    kind === 'monthly' ? b.period_month : null,
    amount, b.notes || null, req.user.id,
  );
  res.status(201).json({ id: r.lastInsertRowid });
});

router.delete('/salary/:id', requirePermission('indent_labour_payment', 'edit'), (req, res) => {
  const r = getDb().prepare(`DELETE FROM proj_salary_entries WHERE id=?`).run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Deleted' });
});

// ════════════════════════════════════════════════════════════════
// L2 DAILY WAGE ENTRIES
// ════════════════════════════════════════════════════════════════
router.get('/projects/:pid/daily-wages', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  res.json(db.prepare(
    `SELECT id, kind, description, per_day_rate, days_required, total_amount, notes, created_at
       FROM proj_daily_wage_entries
      WHERE project_id = ?
      ORDER BY (CASE kind WHEN 'legacy' THEN 0 ELSE 1 END), id DESC`
  ).all(req.params.pid));
});

router.post('/projects/:pid/daily-wages', requirePermission('indent_labour_payment', 'create'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const kind = b.kind === 'legacy' ? 'legacy' : 'entry';
  const perDay = num(b.per_day_rate);
  const days = num(b.days_required);
  // For 'entry', compute total from rate × days; for 'legacy', use
  // explicit total_amount (the bulk pre-ERP carry).
  let total = num(b.total_amount);
  if (kind === 'entry') {
    if (perDay <= 0 || days <= 0) return res.status(400).json({ error: 'Per-day rate and days required must be > 0' });
    total = perDay * days;
  } else {
    if (total <= 0) return res.status(400).json({ error: 'Legacy bulk amount must be > 0' });
  }
  if (kind === 'legacy') {
    const exists = db.prepare(
      `SELECT id FROM proj_daily_wage_entries WHERE project_id=? AND kind='legacy'`
    ).get(req.params.pid);
    if (exists) return res.status(409).json({ error: 'Legacy daily wages already captured. Edit instead of adding a second.' });
  }
  const r = db.prepare(
    `INSERT INTO proj_daily_wage_entries
       (project_id, kind, description, per_day_rate, days_required, total_amount, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.params.pid, kind, b.description || null,
    kind === 'entry' ? perDay : 0,
    kind === 'entry' ? days : 0,
    total, b.notes || null, req.user.id,
  );
  res.status(201).json({ id: r.lastInsertRowid });
});

router.delete('/daily-wages/:id', requirePermission('indent_labour_payment', 'edit'), (req, res) => {
  const r = getDb().prepare(`DELETE FROM proj_daily_wage_entries WHERE id=?`).run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Deleted' });
});

// ════════════════════════════════════════════════════════════════
// L3 WORK ORDERS (sub-contract)
// ════════════════════════════════════════════════════════════════
router.get('/projects/:pid/work-orders', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  // Phase 4 (mam 2026-06-02): each WO row now carries a rollup of the
  // DPR work items that have been logged against it:
  //   dpr_linked_count    — distinct DPR submissions touching this WO
  //   dpr_linked_amount   — Σ(actual_qty × labour rate) across those rows
  //   dpr_linked_qty      — Σ actual_qty (raw quantity claim, no rate)
  //   dpr_progress_pct    — dpr_linked_amount / planned_value × 100,
  //                         capped at 999 so a runaway claim doesn't
  //                         break the badge UI.
  // Mam sees this on the L3 Work Orders tab as a "Linked DPRs · X%"
  // badge; if amount_paid lags progress, that's the cue to release
  // the next contractor payment.
  res.json(db.prepare(
    `SELECT wo.id, wo.wo_number, wo.sub_contractor_id, wo.sub_contractor_name,
            wo.scope, wo.planned_value, COALESCE(wo.amount_paid, 0) AS amount_paid,
            (COALESCE(wo.planned_value, 0) - COALESCE(wo.amount_paid, 0)) AS balance,
            wo.work_order_file_url, wo.planned_start, wo.planned_end, wo.status,
            wo.created_at, wo.updated_at,
            COALESCE((
              SELECT COUNT(DISTINCT dwi.dpr_id) FROM dpr_work_items dwi
               WHERE dwi.work_order_id = wo.id
            ), 0) AS dpr_linked_count,
            COALESCE((
              SELECT SUM(dwi.amount) FROM dpr_work_items dwi
               WHERE dwi.work_order_id = wo.id
            ), 0) AS dpr_linked_amount,
            COALESCE((
              SELECT SUM(dwi.actual_qty) FROM dpr_work_items dwi
               WHERE dwi.work_order_id = wo.id
            ), 0) AS dpr_linked_qty,
            CASE
              WHEN COALESCE(wo.planned_value, 0) <= 0 THEN 0
              ELSE MIN(999,
                ROUND(
                  COALESCE((
                    SELECT SUM(dwi.amount) FROM dpr_work_items dwi
                     WHERE dwi.work_order_id = wo.id
                  ), 0) * 100.0 / wo.planned_value,
                  1
                )
              )
            END AS dpr_progress_pct
       FROM proj_work_orders wo
      WHERE wo.project_id = ?
      ORDER BY wo.created_at DESC`
  ).all(req.params.pid));
});

// Phase 4 · All active Work Orders across every project — used by the
// DPR form's per-line Work Order picker.  Site engineer raises a daily
// report and tags each work line against the WO the sub-contractor is
// performing.  Inactive / closed / cancelled WOs are filtered out so
// the picker stays short.
router.get('/active-work-orders', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  res.json(getDb().prepare(
    `SELECT wo.id, wo.wo_number, wo.sub_contractor_name, wo.scope,
            wo.planned_value, wo.status,
            p.name as project_name
       FROM proj_work_orders wo
       LEFT JOIN proj_projects p ON p.id = wo.project_id
      WHERE COALESCE(wo.status, 'active') NOT IN ('closed','cancelled')
      ORDER BY wo.wo_number, wo.id DESC`
  ).all());
});

// Phase 4 · DPR breakdown per Work Order — mam clicks a WO row and
// sees every DPR line that's been logged against it (date, site,
// qty, amount, who submitted) so she can audit the progress claim
// before releasing the next contractor payment.
router.get('/work-orders/:id/dpr-items', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  res.json(db.prepare(
    `SELECT dwi.id, dwi.dpr_id, dwi.description, dwi.unit, dwi.floor_zone,
            dwi.actual_qty, dwi.planned_qty, dwi.rate, dwi.amount, dwi.remarks,
            d.report_date, d.site_id,
            s.name as site_name,
            u.name as submitted_by_name
       FROM dpr_work_items dwi
       LEFT JOIN dpr d  ON d.id = dwi.dpr_id
       LEFT JOIN sites s ON s.id = d.site_id
       LEFT JOIN users u ON u.id = d.submitted_by
      WHERE dwi.work_order_id = ?
      ORDER BY d.report_date DESC, dwi.id DESC`
  ).all(req.params.id));
});

router.post('/projects/:pid/work-orders', requirePermission('indent_labour_payment', 'create'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  if (!b.wo_number && !b.sub_contractor_name && !b.scope) {
    return res.status(400).json({ error: 'Provide at least WO number, sub-contractor name, or scope' });
  }
  const planned = num(b.planned_value);
  const paid = num(b.amount_paid);
  if (planned > 0 && paid > planned) {
    return res.status(400).json({ error: 'Amount paid cannot exceed WO value' });
  }
  const r = db.prepare(
    `INSERT INTO proj_work_orders
       (project_id, wo_number, sub_contractor_id, sub_contractor_name, scope,
        planned_value, amount_paid, work_order_file_url, planned_start, planned_end,
        status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.params.pid, b.wo_number || null,
    b.sub_contractor_id || null, b.sub_contractor_name || null,
    b.scope || null, planned, paid,
    b.work_order_file_url || null,
    b.planned_start || null, b.planned_end || null,
    b.status || 'active',
    req.user.id,
  );
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/work-orders/:id', requirePermission('indent_labour_payment', 'edit'), (req, res) => {
  const db = getDb();
  const cur = db.prepare(`SELECT planned_value FROM proj_work_orders WHERE id=?`).get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const newPaid = b.amount_paid != null ? num(b.amount_paid) : null;
  const newPlanned = b.planned_value != null ? num(b.planned_value) : null;
  if (newPaid != null && newPlanned != null && newPlanned > 0 && newPaid > newPlanned) {
    return res.status(400).json({ error: 'Amount paid cannot exceed WO value' });
  }
  if (newPaid != null && newPlanned == null && cur.planned_value > 0 && newPaid > cur.planned_value) {
    return res.status(400).json({ error: 'Amount paid cannot exceed WO value' });
  }
  db.prepare(
    `UPDATE proj_work_orders SET
       wo_number            = COALESCE(?, wo_number),
       sub_contractor_id    = COALESCE(?, sub_contractor_id),
       sub_contractor_name  = COALESCE(?, sub_contractor_name),
       scope                = COALESCE(?, scope),
       planned_value        = COALESCE(?, planned_value),
       amount_paid          = COALESCE(?, amount_paid),
       work_order_file_url  = COALESCE(?, work_order_file_url),
       planned_start        = COALESCE(?, planned_start),
       planned_end          = COALESCE(?, planned_end),
       status               = COALESCE(?, status),
       updated_at           = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    b.wo_number ?? null,
    b.sub_contractor_id ?? null,
    b.sub_contractor_name ?? null,
    b.scope ?? null,
    newPlanned,
    newPaid,
    b.work_order_file_url ?? null,
    b.planned_start ?? null,
    b.planned_end ?? null,
    b.status ?? null,
    req.params.id,
  );
  res.json({ message: 'Updated' });
});

router.delete('/work-orders/:id', requirePermission('indent_labour_payment', 'edit'), (req, res) => {
  const r = getDb().prepare(`DELETE FROM proj_work_orders WHERE id=?`).run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Deleted' });
});

module.exports = router;
