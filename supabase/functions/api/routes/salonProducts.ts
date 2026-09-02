// deno-lint-ignore-file no-explicit-any
// Salon Retail Products — counter products with simple stock (deducted by POS).
// Ported from server/routes/salonProducts.js (Phase-3 Postgres version).
import { Router } from "../../_shared/express-lite.ts";
import pg from "../../_shared/pg.ts";
import { authMiddleware, requirePermission } from "../../_shared/auth.ts";
const router = Router();
router.use(authMiddleware);

const M = 'salon_products';

router.get('/', requirePermission(M, 'view'), async (req, res) => {
  try {
    const { search, active, low_only } = req.query;
    let sql = 'SELECT * FROM salon_products WHERE 1=1';
    const p: any[] = [];
    if (active !== undefined) { sql += ' AND active=?'; p.push(active === '1' || active === 'true' ? 1 : 0); }
    if (low_only === '1') sql += ' AND reorder_level > 0 AND stock_qty <= reorder_level';
    if (search) { sql += ' AND (name ILIKE ? OR sku ILIKE ? OR brand ILIKE ?)'; const q = `%${search}%`; p.push(q, q, q); }
    sql += ' ORDER BY active DESC, name';
    res.json(await pg.all(sql, ...p));
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.get('/:id', requirePermission(M, 'view'), async (req, res) => {
  try {
    const row = await pg.get('SELECT * FROM salon_products WHERE id=?', req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.post('/', requirePermission(M, 'create'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'Product name required' });
    const r = await pg.run(
      'INSERT INTO salon_products (name, sku, brand, price, cost, stock_qty, reorder_level, active) VALUES (?,?,?,?,?,?,?,?)',
      b.name.trim(), b.sku || '', b.brand || '', b.price || 0, b.cost || 0, b.stock_qty || 0, b.reorder_level || 0, b.active === 0 ? 0 : 1);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.put('/:id', requirePermission(M, 'edit'), async (req, res) => {
  try {
    const b = req.body || {};
    await pg.run(
      'UPDATE salon_products SET name=?, sku=?, brand=?, price=?, cost=?, stock_qty=?, reorder_level=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
      b.name || '', b.sku || '', b.brand || '', b.price || 0, b.cost || 0, b.stock_qty || 0, b.reorder_level || 0, b.active === 0 ? 0 : 1, req.params.id);
    res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Quick restock — adds delta to stock_qty (positive = received, negative = adjustment).
router.post('/:id/restock', requirePermission(M, 'edit'), async (req, res) => {
  try {
    const delta = Number(req.body?.delta) || 0;
    const row = await pg.get('SELECT stock_qty FROM salon_products WHERE id=?', req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    await pg.run('UPDATE salon_products SET stock_qty = stock_qty + ?, updated_at=CURRENT_TIMESTAMP WHERE id=?', delta, req.params.id);
    res.json({ message: 'Stock updated', stock_qty: (row.stock_qty || 0) + delta });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.delete('/:id', requirePermission(M, 'delete'), async (req, res) => {
  try {
    await pg.run('DELETE FROM salon_products WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

export default router;
