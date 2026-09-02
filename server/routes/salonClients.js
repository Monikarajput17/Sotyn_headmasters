// Salon Clients — individual clients, visit history, loyalty balance.
const express = require('express');
const pg = require('../db/pg');
const { nextSequencePg } = require('../db/nextSequence');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const M = 'salon_clients';

router.get('/', requirePermission(M, 'view'), async (req, res) => {
  try {
    const { search } = req.query;
    let sql = 'SELECT * FROM salon_clients WHERE 1=1';
    const p = [];
    if (search) {
      sql += ' AND (name ILIKE ? OR phone ILIKE ? OR email ILIKE ? OR client_code ILIKE ?)';
      const q = `%${search}%`; p.push(q, q, q, q);
    }
    sql += ' ORDER BY last_visit DESC, created_at DESC';
    res.json(await pg.all(sql, ...p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', requirePermission(M, 'view'), async (req, res) => {
  try {
    const row = await pg.get('SELECT * FROM salon_clients WHERE id=?', req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    row.appointments = await pg.all(
      `SELECT a.*, st.name AS stylist_name FROM appointments a
       LEFT JOIN stylists st ON st.id = a.stylist_id
       WHERE a.client_id=? ORDER BY a.appt_date DESC, a.start_time DESC LIMIT 50`, req.params.id);
    row.sales = await pg.all(
      'SELECT id, invoice_no, total, payment_mode, created_at FROM pos_sales WHERE client_id=? ORDER BY created_at DESC LIMIT 50', req.params.id);
    row.memberships = await pg.all(
      'SELECT * FROM client_memberships WHERE client_id=? ORDER BY created_at DESC', req.params.id);
    row.loyalty = await pg.all(
      'SELECT * FROM loyalty_ledger WHERE client_id=? ORDER BY created_at DESC LIMIT 50', req.params.id);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requirePermission(M, 'create'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'Client name required' });
    if (b.phone && String(b.phone).trim()) {
      const dup = await pg.get('SELECT id, name FROM salon_clients WHERE phone=?', String(b.phone).trim());
      if (dup) return res.status(409).json({ error: `Client with phone ${b.phone} already exists (${dup.name})`, existingId: dup.id });
    }
    const code = await nextSequencePg(pg, 'salon_clients', 'client_code', 'CL-', { startFrom: 1000, pad: 4 });
    const r = await pg.run(
      'INSERT INTO salon_clients (client_code, name, phone, email, gender, dob, notes) VALUES (?,?,?,?,?,?,?)',
      code, b.name.trim(), b.phone || '', b.email || '', b.gender || '', b.dob || '', b.notes || '');
    res.status(201).json({ id: r.lastInsertRowid, client_code: code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', requirePermission(M, 'edit'), async (req, res) => {
  try {
    const b = req.body || {};
    await pg.run(
      'UPDATE salon_clients SET name=?, phone=?, email=?, gender=?, dob=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
      b.name || '', b.phone || '', b.email || '', b.gender || '', b.dob || '', b.notes || '', req.params.id);
    res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requirePermission(M, 'delete'), async (req, res) => {
  try {
    await pg.run('DELETE FROM salon_clients WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
