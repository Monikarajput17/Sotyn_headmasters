// Salon Stylists — staff who perform services (+ commission %).
const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const M = 'salon_stylists';

router.get('/', requirePermission(M, 'view'), (req, res) => {
  const { search, active } = req.query;
  let sql = 'SELECT * FROM stylists WHERE 1=1';
  const p = [];
  if (active !== undefined) { sql += ' AND active=?'; p.push(active === '1' || active === 'true' ? 1 : 0); }
  if (search) { sql += ' AND (name LIKE ? OR phone LIKE ? OR specialization LIKE ?)'; const q = `%${search}%`; p.push(q, q, q); }
  sql += ' ORDER BY active DESC, name';
  res.json(getDb().prepare(sql).all(...p));
});

router.get('/:id', requirePermission(M, 'view'), (req, res) => {
  const row = getDb().prepare('SELECT * FROM stylists WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/', requirePermission(M, 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'Stylist name required' });
  const r = getDb().prepare(
    'INSERT INTO stylists (name, phone, email, specialization, commission_pct, employee_id, active) VALUES (?,?,?,?,?,?,?)'
  ).run(b.name.trim(), b.phone || '', b.email || '', b.specialization || '', b.commission_pct || 0, b.employee_id || null, b.active === 0 ? 0 : 1);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/:id', requirePermission(M, 'edit'), (req, res) => {
  const b = req.body || {};
  getDb().prepare(
    'UPDATE stylists SET name=?, phone=?, email=?, specialization=?, commission_pct=?, employee_id=?, active=? WHERE id=?'
  ).run(b.name || '', b.phone || '', b.email || '', b.specialization || '', b.commission_pct || 0, b.employee_id || null, b.active === 0 ? 0 : 1, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/:id', requirePermission(M, 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM stylists WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
