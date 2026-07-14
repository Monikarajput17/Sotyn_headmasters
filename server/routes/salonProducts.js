// Salon Retail Products — counter products with simple stock (deducted by POS).
const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const M = 'salon_products';

router.get('/', requirePermission(M, 'view'), (req, res) => {
  const { search, active, low_only } = req.query;
  let sql = 'SELECT * FROM salon_products WHERE 1=1';
  const p = [];
  if (active !== undefined) { sql += ' AND active=?'; p.push(active === '1' || active === 'true' ? 1 : 0); }
  if (low_only === '1') sql += ' AND reorder_level > 0 AND stock_qty <= reorder_level';
  if (search) { sql += ' AND (name LIKE ? OR sku LIKE ? OR brand LIKE ?)'; const q = `%${search}%`; p.push(q, q, q); }
  sql += ' ORDER BY active DESC, name';
  res.json(getDb().prepare(sql).all(...p));
});

router.get('/:id', requirePermission(M, 'view'), (req, res) => {
  const row = getDb().prepare('SELECT * FROM salon_products WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/', requirePermission(M, 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'Product name required' });
  const r = getDb().prepare(
    'INSERT INTO salon_products (name, sku, brand, price, cost, stock_qty, reorder_level, active) VALUES (?,?,?,?,?,?,?,?)'
  ).run(b.name.trim(), b.sku || '', b.brand || '', b.price || 0, b.cost || 0, b.stock_qty || 0, b.reorder_level || 0, b.active === 0 ? 0 : 1);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/:id', requirePermission(M, 'edit'), (req, res) => {
  const b = req.body || {};
  getDb().prepare(
    'UPDATE salon_products SET name=?, sku=?, brand=?, price=?, cost=?, stock_qty=?, reorder_level=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
  ).run(b.name || '', b.sku || '', b.brand || '', b.price || 0, b.cost || 0, b.stock_qty || 0, b.reorder_level || 0, b.active === 0 ? 0 : 1, req.params.id);
  res.json({ message: 'Updated' });
});

// Quick restock — adds delta to stock_qty (positive = received, negative = adjustment).
router.post('/:id/restock', requirePermission(M, 'edit'), (req, res) => {
  const delta = Number(req.body?.delta) || 0;
  const db = getDb();
  const row = db.prepare('SELECT stock_qty FROM salon_products WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE salon_products SET stock_qty = stock_qty + ?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(delta, req.params.id);
  res.json({ message: 'Stock updated', stock_qty: (row.stock_qty || 0) + delta });
});

router.delete('/:id', requirePermission(M, 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM salon_products WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
