// Sub-contractor master list. Brings mam's "Sub-Contractor Form"
// Google-Form workflow into the ERP so 47+ subcontractor entries can
// be filtered/searched alongside the rest of the data.

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Lightweight picker endpoint — any authenticated user can use it,
// no sub_contractors:view permission required.  Mam (2026-05-30):
// the DPR submission form needs site engineers to pick from the
// master, but engineers don't (and shouldn't) have full master
// access.  Returns just id / name / type / district so dropdowns
// stay small.  MUST be registered above the `/:id` route so the
// id-matcher doesn't eat it.
router.get('/lookup', (req, res) => {
  // De-dupe by name (case-insensitive): the master can hold several
  // rows sharing a name (e.g. four "Raj" plumbing gangs), but the DPR
  // picker binds by name string and uses it as the React key, so the
  // duplicates collapse into one another and silently drop from the
  // list.  GROUP BY name → one entry per distinct name; keep the
  // lowest id (earliest master record) as the representative.
  const rows = getDb().prepare(
    `SELECT MIN(id) AS id, name, contractor_type, district
       FROM sub_contractors
      WHERE active = 1
      GROUP BY name COLLATE NOCASE
      ORDER BY name COLLATE NOCASE`
  ).all();
  res.json(rows);
});

// GET list — optional filters: q (name/number/type search), state,
// contractor_type, active=0|1 (default: active only).
router.get('/', requirePermission('sub_contractors', 'view'), (req, res) => {
  const { q, state, contractor_type, active } = req.query;
  let sql = 'SELECT * FROM sub_contractors WHERE 1=1';
  const params = [];

  if (active !== 'all') {
    sql += ' AND active=?';
    params.push(active === '0' ? 0 : 1);
  }
  if (state) { sql += ' AND state=?'; params.push(state); }
  if (contractor_type) { sql += ' AND contractor_type=?'; params.push(contractor_type); }
  if (q) {
    sql += ' AND (name LIKE ? OR phone LIKE ? OR contractor_type LIKE ? OR district LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  sql += ' ORDER BY name COLLATE NOCASE';
  res.json(getDb().prepare(sql).all(...params));
});

router.get('/:id', requirePermission('sub_contractors', 'view'), (req, res) => {
  const row = getDb().prepare('SELECT * FROM sub_contractors WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const bool01 = (v) => (v === true || v === 1 || v === '1' || v === 'yes' || v === 'Yes') ? 1 : 0;

router.post('/', requirePermission('sub_contractors', 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Name is required' });
  const r = getDb().prepare(
    `INSERT INTO sub_contractors
     (name, phone, state, district, location_extra, contractor_type,
      experience_years, manpower, with_tools, has_gst, gst_number, rate_in_budget,
      start_within_days, notes, active, work_order_file, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    String(b.name).trim(),
    b.phone || null,
    b.state || null,
    b.district || null,
    b.location_extra || null,
    b.contractor_type || null,
    num(b.experience_years),
    num(b.manpower),
    bool01(b.with_tools),
    bool01(b.has_gst),
    b.gst_number || null,
    b.rate_in_budget || null,
    num(b.start_within_days),
    b.notes || null,
    b.active === false || b.active === 0 ? 0 : 1,
    b.work_order_file || null,
    req.user.id,
  );
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/:id', requirePermission('sub_contractors', 'edit'), (req, res) => {
  const b = req.body || {};
  const existing = getDb().prepare('SELECT id FROM sub_contractors WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Name is required' });

  getDb().prepare(
    `UPDATE sub_contractors SET
       name=?, phone=?, state=?, district=?, location_extra=?, contractor_type=?,
       experience_years=?, manpower=?, with_tools=?, has_gst=?, gst_number=?, rate_in_budget=?,
       start_within_days=?, notes=?, active=?, work_order_file=?, updated_at=CURRENT_TIMESTAMP
     WHERE id=?`
  ).run(
    String(b.name).trim(),
    b.phone || null,
    b.state || null,
    b.district || null,
    b.location_extra || null,
    b.contractor_type || null,
    num(b.experience_years),
    num(b.manpower),
    bool01(b.with_tools),
    bool01(b.has_gst),
    b.gst_number || null,
    b.rate_in_budget || null,
    num(b.start_within_days),
    b.notes || null,
    b.active === false || b.active === 0 ? 0 : 1,
    b.work_order_file || null,
    req.params.id,
  );
  res.json({ message: 'Updated' });
});

// Toggle active (soft-delete pattern — preserves historical references).
router.patch('/:id/active', requirePermission('sub_contractors', 'edit'), (req, res) => {
  const next = req.body?.active ? 1 : 0;
  const r = getDb().prepare('UPDATE sub_contractors SET active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(next, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: next ? 'Activated' : 'Deactivated' });
});

router.delete('/:id', requirePermission('sub_contractors', 'delete'), (req, res) => {
  const r = getDb().prepare('DELETE FROM sub_contractors WHERE id=?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Deleted' });
});

module.exports = router;
