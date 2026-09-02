// Salon Services — the price menu (categories + services).
const express = require('express');
const pg = require('../db/pg');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const M = 'salon_services';

// ─── Categories ──────────────────────────────────────────────────────
router.get('/categories', requirePermission(M, 'view'), async (req, res) => {
  try {
    res.json(await pg.all('SELECT * FROM service_categories ORDER BY sort_order, name'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/categories', requirePermission(M, 'create'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'Category name required' });
    const r = await pg.run('INSERT INTO service_categories (name, sort_order, active) VALUES (?,?,?)',
      b.name.trim(), b.sort_order || 0, b.active === 0 ? 0 : 1);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/categories/:id', requirePermission(M, 'edit'), async (req, res) => {
  try {
    const b = req.body || {};
    await pg.run('UPDATE service_categories SET name=?, sort_order=?, active=? WHERE id=?',
      b.name || '', b.sort_order || 0, b.active === 0 ? 0 : 1, req.params.id);
    res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/categories/:id', requirePermission(M, 'delete'), async (req, res) => {
  try {
    await pg.run('DELETE FROM service_categories WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Services ────────────────────────────────────────────────────────
router.get('/', requirePermission(M, 'view'), async (req, res) => {
  try {
    const { search, category_id, active } = req.query;
    let sql = `SELECT s.*, c.name AS category_name FROM services s
               LEFT JOIN service_categories c ON c.id = s.category_id WHERE 1=1`;
    const p = [];
    if (category_id) { sql += ' AND s.category_id=?'; p.push(category_id); }
    if (active !== undefined) { sql += ' AND s.active=?'; p.push(active === '1' || active === 'true' ? 1 : 0); }
    if (search) { sql += ' AND (s.name ILIKE ? OR s.code ILIKE ?)'; const q = `%${search}%`; p.push(q, q); }
    sql += ' ORDER BY c.sort_order, s.name';
    res.json(await pg.all(sql, ...p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/:id', requirePermission(M, 'view'), async (req, res) => {
  try {
    const row = await pg.get('SELECT * FROM services WHERE id=?', req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/', requirePermission(M, 'create'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'Service name required' });
    const r = await pg.run(
      'INSERT INTO services (category_id, name, code, duration_min, price, description, active) VALUES (?,?,?,?,?,?,?)',
      b.category_id || null, b.name.trim(), b.code || '', b.duration_min || 30, b.price || 0, b.description || '', b.active === 0 ? 0 : 1);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/:id', requirePermission(M, 'edit'), async (req, res) => {
  try {
    const b = req.body || {};
    await pg.run(
      'UPDATE services SET category_id=?, name=?, code=?, duration_min=?, price=?, description=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
      b.category_id || null, b.name || '', b.code || '', b.duration_min || 30, b.price || 0, b.description || '', b.active === 0 ? 0 : 1, req.params.id);
    res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/:id', requirePermission(M, 'delete'), async (req, res) => {
  try {
    await pg.run('DELETE FROM services WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
