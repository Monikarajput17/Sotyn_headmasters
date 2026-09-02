// Salon Stylists — staff who perform services (+ commission %).
const express = require('express');
const pg = require('../db/pg');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const M = 'salon_stylists';

router.get('/', requirePermission(M, 'view'), async (req, res) => {
  try {
    const { search, active } = req.query;
    let sql = 'SELECT * FROM stylists WHERE 1=1';
    const p = [];
    if (active !== undefined) { sql += ' AND active=?'; p.push(active === '1' || active === 'true' ? 1 : 0); }
    if (search) { sql += ' AND (name ILIKE ? OR phone ILIKE ? OR specialization ILIKE ?)'; const q = `%${search}%`; p.push(q, q, q); }
    sql += ' ORDER BY active DESC, name';
    res.json(await pg.all(sql, ...p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', requirePermission(M, 'view'), async (req, res) => {
  try {
    const row = await pg.get('SELECT * FROM stylists WHERE id=?', req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requirePermission(M, 'create'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'Stylist name required' });
    const r = await pg.run(
      'INSERT INTO stylists (name, phone, email, specialization, commission_pct, employee_id, active) VALUES (?,?,?,?,?,?,?)',
      b.name.trim(), b.phone || '', b.email || '', b.specialization || '', b.commission_pct || 0, b.employee_id || null, b.active === 0 ? 0 : 1);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', requirePermission(M, 'edit'), async (req, res) => {
  try {
    const b = req.body || {};
    await pg.run(
      'UPDATE stylists SET name=?, phone=?, email=?, specialization=?, commission_pct=?, employee_id=?, active=? WHERE id=?',
      b.name || '', b.phone || '', b.email || '', b.specialization || '', b.commission_pct || 0, b.employee_id || null, b.active === 0 ? 0 : 1, req.params.id);
    res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requirePermission(M, 'delete'), async (req, res) => {
  try {
    await pg.run('DELETE FROM stylists WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
