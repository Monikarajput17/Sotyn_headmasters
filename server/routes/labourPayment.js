// Labour Payment Indents — mam (2026-05-30): "create a module labour
// indent-Payment under Projects".  Site engineer raises a payment
// request for sub-contractor labour worked over a period; manager
// approves (with optional amount adjustment); accounts pays.
//
// Workflow:
//   pending → approved → paid
//   pending → rejected (terminal; recoverable only by raising a new one)
//
// Sub-contractor name comes from the sub_contractors master via the
// /api/sub-contractors/lookup endpoint already used by the DPR form.
// Off-master names are accepted (sub_contractor_id NULL, name typed)
// so a one-off labour gang can still be paid without polluting the
// master with single-use entries.

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Auto-generate indent_no on insert: LPI-YYYY-#### where #### is the
// next sequence within the current calendar year.  Stays unique via
// the table's UNIQUE constraint; race-safe because we do it inside the
// same transaction as the INSERT.
function nextIndentNo(db) {
  const year = new Date().getFullYear();
  const row = db.prepare(
    `SELECT indent_no FROM labour_payment_indents
       WHERE indent_no LIKE ?
       ORDER BY id DESC LIMIT 1`
  ).get(`LPI-${year}-%`);
  let n = 1;
  if (row && row.indent_no) {
    const m = row.indent_no.match(/-(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `LPI-${year}-${String(n).padStart(4, '0')}`;
}

// ─── LIST ─────────────────────────────────────────────────────────────
// Filters: status, site_id, sub_contractor_id, date_from / date_to
// (on created_at), q (free text on indent_no / sub_contractor_name /
// site_name).  Non-admin / non-approver users see only their own.
router.get('/', requirePermission('labour_payment', 'view'), (req, res) => {
  const db = getDb();
  const { status, site_id, sub_contractor_id, date_from, date_to, q } = req.query;
  let sql = `
    SELECT lpi.*, u.name AS raised_by_name_live
      FROM labour_payment_indents lpi
      LEFT JOIN users u ON u.id = lpi.raised_by
     WHERE 1=1
  `;
  const params = [];
  if (status) { sql += ' AND lpi.status = ?'; params.push(status); }
  if (site_id) { sql += ' AND lpi.site_id = ?'; params.push(site_id); }
  if (sub_contractor_id) { sql += ' AND lpi.sub_contractor_id = ?'; params.push(sub_contractor_id); }
  if (date_from) { sql += ' AND DATE(lpi.created_at) >= ?'; params.push(String(date_from).slice(0, 10)); }
  if (date_to)   { sql += ' AND DATE(lpi.created_at) <= ?'; params.push(String(date_to).slice(0, 10)); }
  if (q) {
    sql += ' AND (lpi.indent_no LIKE ? OR lpi.sub_contractor_name LIKE ? OR lpi.site_name LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  // Engineers see only their own raises; admins/approvers see all.
  // Mirrors the gate the existing /dpr endpoint uses.
  const isAdmin = req.user.role === 'admin';
  const canApprove = isAdmin || db.prepare(
    `SELECT 1 FROM role_permissions rp
       JOIN user_roles ur ON ur.role_id = rp.role_id
      WHERE ur.user_id=? AND rp.module='labour_payment' AND rp.can_approve=1`
  ).get(req.user.id);
  if (!canApprove) { sql += ' AND lpi.raised_by = ?'; params.push(req.user.id); }
  sql += ' ORDER BY lpi.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// ─── STATUS COUNTS ────────────────────────────────────────────────────
// Quick aggregate for the tile strip — same filter shape as list but
// without status (we want counts PER status).  Returns
// { pending, approved, rejected, paid, total_amount, paid_amount }.
router.get('/summary', requirePermission('labour_payment', 'view'), (req, res) => {
  const db = getDb();
  const { site_id, sub_contractor_id, date_from, date_to } = req.query;
  const isAdmin = req.user.role === 'admin';
  const canApprove = isAdmin || db.prepare(
    `SELECT 1 FROM role_permissions rp
       JOIN user_roles ur ON ur.role_id = rp.role_id
      WHERE ur.user_id=? AND rp.module='labour_payment' AND rp.can_approve=1`
  ).get(req.user.id);

  let where = ' WHERE 1=1';
  const params = [];
  if (site_id) { where += ' AND site_id=?'; params.push(site_id); }
  if (sub_contractor_id) { where += ' AND sub_contractor_id=?'; params.push(sub_contractor_id); }
  if (date_from) { where += ' AND DATE(created_at) >= ?'; params.push(String(date_from).slice(0, 10)); }
  if (date_to)   { where += ' AND DATE(created_at) <= ?'; params.push(String(date_to).slice(0, 10)); }
  if (!canApprove) { where += ' AND raised_by=?'; params.push(req.user.id); }

  const rows = db.prepare(
    `SELECT status, COUNT(*) AS c, COALESCE(SUM(amount), 0) AS amt
       FROM labour_payment_indents${where} GROUP BY status`
  ).all(...params);
  const out = { pending: 0, approved: 0, rejected: 0, paid: 0, total_amount: 0, paid_amount: 0 };
  for (const r of rows) {
    if (r.status in out) out[r.status] = r.c;
    out.total_amount += r.amt;
    if (r.status === 'paid') out.paid_amount = r.amt;
  }
  res.json(out);
});

// ─── DETAIL ───────────────────────────────────────────────────────────
router.get('/:id', requirePermission('labour_payment', 'view'), (req, res) => {
  const db = getDb();
  const row = db.prepare(
    `SELECT lpi.*,
            ru.name AS raised_by_name_live,
            au.name AS approved_by_name,
            pu.name AS paid_by_name
       FROM labour_payment_indents lpi
       LEFT JOIN users ru ON ru.id = lpi.raised_by
       LEFT JOIN users au ON au.id = lpi.approved_by
       LEFT JOIN users pu ON pu.id = lpi.paid_by
      WHERE lpi.id = ?`
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  // Engineers may only see their own.
  const isAdmin = req.user.role === 'admin';
  const canApprove = isAdmin || db.prepare(
    `SELECT 1 FROM role_permissions rp
       JOIN user_roles ur ON ur.role_id = rp.role_id
      WHERE ur.user_id=? AND rp.module='labour_payment' AND rp.can_approve=1`
  ).get(req.user.id);
  if (!canApprove && row.raised_by !== req.user.id) {
    return res.status(403).json({ error: 'You can only view your own labour payment indents' });
  }
  res.json(row);
});

// ─── CREATE ───────────────────────────────────────────────────────────
router.post('/', requirePermission('labour_payment', 'create'), (req, res) => {
  const db = getDb();
  const b = req.body || {};

  if (!b.sub_contractor_name || !String(b.sub_contractor_name).trim()) {
    return res.status(400).json({ error: 'Sub-contractor name is required' });
  }
  if (!b.period_from || !b.period_to) {
    return res.status(400).json({ error: 'Period (from / to) is required' });
  }
  if (b.period_from > b.period_to) {
    return res.status(400).json({ error: 'Period start must be on or before end' });
  }
  if (num(b.amount) <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than zero' });
  }

  // Resolve site_name from site_id if not provided (denormalized for
  // the list view so we don't pay a JOIN on every read).
  let siteName = b.site_name || null;
  if (b.site_id && !siteName) {
    const s = db.prepare('SELECT name FROM sites WHERE id=?').get(b.site_id);
    if (s) siteName = s.name;
  }

  const indentNo = nextIndentNo(db);
  const r = db.prepare(`
    INSERT INTO labour_payment_indents
      (indent_no, site_id, site_name, sub_contractor_id, sub_contractor_name,
       trade, work_description, period_from, period_to,
       manpower_count, man_days, rate, amount, attachment_url,
       raised_by, raised_by_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    indentNo,
    b.site_id || null, siteName,
    b.sub_contractor_id || null, String(b.sub_contractor_name).trim(),
    b.trade || null, b.work_description || null,
    String(b.period_from).slice(0, 10), String(b.period_to).slice(0, 10),
    num(b.manpower_count) | 0, num(b.man_days), num(b.rate), num(b.amount),
    b.attachment_url || null,
    req.user.id, req.user.name || null,
  );
  res.status(201).json({ id: r.lastInsertRowid, indent_no: indentNo });
});

// ─── APPROVE ──────────────────────────────────────────────────────────
// Body: { approved_amount?, approval_remarks? }.  Default approved_amount
// = the original amount (mam's existing Payment Required pattern lets the
// approver tweak it; mirroring here).
router.post('/:id/approve', requirePermission('labour_payment', 'approve'), (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM labour_payment_indents WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  if (cur.status !== 'pending') {
    return res.status(409).json({ error: `Cannot approve a ${cur.status} indent` });
  }
  const approved = req.body?.approved_amount != null ? num(req.body.approved_amount) : cur.amount;
  if (approved <= 0) return res.status(400).json({ error: 'Approved amount must be > 0' });
  db.prepare(`
    UPDATE labour_payment_indents
       SET status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP,
           approved_amount=?, approval_remarks=?, updated_at=CURRENT_TIMESTAMP
     WHERE id=?
  `).run(req.user.id, approved, req.body?.approval_remarks || null, req.params.id);
  res.json({ message: 'Approved' });
});

// ─── REJECT ───────────────────────────────────────────────────────────
router.post('/:id/reject', requirePermission('labour_payment', 'approve'), (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT status FROM labour_payment_indents WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  if (cur.status === 'paid') {
    return res.status(409).json({ error: 'Already paid — cannot reject' });
  }
  db.prepare(`
    UPDATE labour_payment_indents
       SET status='rejected', rejected_reason=?,
           approved_by=?, approved_at=CURRENT_TIMESTAMP,
           updated_at=CURRENT_TIMESTAMP
     WHERE id=?
  `).run(req.body?.rejected_reason || null, req.user.id, req.params.id);
  res.json({ message: 'Rejected' });
});

// ─── MARK PAID ────────────────────────────────────────────────────────
// Body: { payment_ref? } — UTR / cheque / cash voucher reference.
router.post('/:id/mark-paid', requirePermission('labour_payment', 'approve'), (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT status FROM labour_payment_indents WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  if (cur.status !== 'approved') {
    return res.status(409).json({ error: `Only approved indents can be marked paid (current: ${cur.status})` });
  }
  db.prepare(`
    UPDATE labour_payment_indents
       SET status='paid', paid_by=?, paid_at=CURRENT_TIMESTAMP,
           payment_ref=?, updated_at=CURRENT_TIMESTAMP
     WHERE id=?
  `).run(req.user.id, req.body?.payment_ref || null, req.params.id);
  res.json({ message: 'Marked paid' });
});

// ─── DELETE ───────────────────────────────────────────────────────────
// Only pending indents can be deleted, and only by the raiser or an admin.
router.delete('/:id', requirePermission('labour_payment', 'edit'), (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT raised_by, status FROM labour_payment_indents WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const isAdmin = req.user.role === 'admin';
  if (!isAdmin && cur.raised_by !== req.user.id) {
    return res.status(403).json({ error: 'Only the raiser or an admin can delete' });
  }
  if (cur.status !== 'pending' && !isAdmin) {
    return res.status(409).json({ error: 'Only pending indents can be deleted' });
  }
  db.prepare('DELETE FROM labour_payment_indents WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
