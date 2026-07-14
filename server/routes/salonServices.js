// Salon Services — the price menu (categories + services).
const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const M = 'salon_services';

// ─── Categories ──────────────────────────────────────────────────────
router.get('/categories', requirePermission(M, 'view'), (req, res) => {
  res.json(getDb().prepare('SELECT * FROM service_categories ORDER BY sort_order, name').all());
});
router.post('/categories', requirePermission(M, 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'Category name required' });
  const r = getDb().prepare('INSERT INTO service_categories (name, sort_order, active) VALUES (?,?,?)')
    .run(b.name.trim(), b.sort_order || 0, b.active === 0 ? 0 : 1);
  res.status(201).json({ id: r.lastInsertRowid });
});
router.put('/categories/:id', requirePermission(M, 'edit'), (req, res) => {
  const b = req.body || {};
  getDb().prepare('UPDATE service_categories SET name=?, sort_order=?, active=? WHERE id=?')
    .run(b.name || '', b.sort_order || 0, b.active === 0 ? 0 : 1, req.params.id);
  res.json({ message: 'Updated' });
});
router.delete('/categories/:id', requirePermission(M, 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM service_categories WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ─── Services ────────────────────────────────────────────────────────
router.get('/', requirePermission(M, 'view'), (req, res) => {
  const { search, category_id, active } = req.query;
  let sql = `SELECT s.*, c.name AS category_name FROM services s
             LEFT JOIN service_categories c ON c.id = s.category_id WHERE 1=1`;
  const p = [];
  if (category_id) { sql += ' AND s.category_id=?'; p.push(category_id); }
  if (active !== undefined) { sql += ' AND s.active=?'; p.push(active === '1' || active === 'true' ? 1 : 0); }
  if (search) { sql += ' AND (s.name LIKE ? OR s.code LIKE ?)'; const q = `%${search}%`; p.push(q, q); }
  sql += ' ORDER BY c.sort_order, s.name';
  res.json(getDb().prepare(sql).all(...p));
});
router.get('/:id', requirePermission(M, 'view'), (req, res) => {
  const row = getDb().prepare('SELECT * FROM services WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});
router.post('/', requirePermission(M, 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'Service name required' });
  const r = getDb().prepare(
    'INSERT INTO services (category_id, name, code, duration_min, price, description, active) VALUES (?,?,?,?,?,?,?)'
  ).run(b.category_id || null, b.name.trim(), b.code || '', b.duration_min || 30, b.price || 0, b.description || '', b.active === 0 ? 0 : 1);
  res.status(201).json({ id: r.lastInsertRowid });
});
router.put('/:id', requirePermission(M, 'edit'), (req, res) => {
  const b = req.body || {};
  getDb().prepare(
    'UPDATE services SET category_id=?, name=?, code=?, duration_min=?, price=?, description=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
  ).run(b.category_id || null, b.name || '', b.code || '', b.duration_min || 30, b.price || 0, b.description || '', b.active === 0 ? 0 : 1, req.params.id);
  res.json({ message: 'Updated' });
});
router.delete('/:id', requirePermission(M, 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM services WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
