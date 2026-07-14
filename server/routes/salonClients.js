// Salon Clients — individual clients, visit history, loyalty balance.
const express = require('express');
const { getDb } = require('../db/schema');
const { nextSequence } = require('../db/nextSequence');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const M = 'salon_clients';

router.get('/', requirePermission(M, 'view'), (req, res) => {
  const { search } = req.query;
  let sql = 'SELECT * FROM salon_clients WHERE 1=1';
  const p = [];
  if (search) {
    sql += ' AND (name LIKE ? OR phone LIKE ? OR email LIKE ? OR client_code LIKE ?)';
    const q = `%${search}%`; p.push(q, q, q, q);
  }
  sql += ' ORDER BY last_visit DESC, created_at DESC';
  res.json(getDb().prepare(sql).all(...p));
});

router.get('/:id', requirePermission(M, 'view'), (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM salon_clients WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  row.appointments = db.prepare(
    `SELECT a.*, st.name AS stylist_name FROM appointments a
     LEFT JOIN stylists st ON st.id = a.stylist_id
     WHERE a.client_id=? ORDER BY a.appt_date DESC, a.start_time DESC LIMIT 50`
  ).all(req.params.id);
  row.sales = db.prepare(
    'SELECT id, invoice_no, total, payment_mode, created_at FROM pos_sales WHERE client_id=? ORDER BY created_at DESC LIMIT 50'
  ).all(req.params.id);
  row.memberships = db.prepare(
    'SELECT * FROM client_memberships WHERE client_id=? ORDER BY created_at DESC'
  ).all(req.params.id);
  row.loyalty = db.prepare(
    'SELECT * FROM loyalty_ledger WHERE client_id=? ORDER BY created_at DESC LIMIT 50'
  ).all(req.params.id);
  res.json(row);
});

router.post('/', requirePermission(M, 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'Client name required' });
  const db = getDb();
  if (b.phone && String(b.phone).trim()) {
    const dup = db.prepare('SELECT id, name FROM salon_clients WHERE phone=?').get(String(b.phone).trim());
    if (dup) return res.status(409).json({ error: `Client with phone ${b.phone} already exists (${dup.name})`, existingId: dup.id });
  }
  const code = nextSequence(db, 'salon_clients', 'client_code', 'CL-', { startFrom: 1000, pad: 4 });
  const r = db.prepare(
    'INSERT INTO salon_clients (client_code, name, phone, email, gender, dob, notes) VALUES (?,?,?,?,?,?,?)'
  ).run(code, b.name.trim(), b.phone || '', b.email || '', b.gender || '', b.dob || '', b.notes || '');
  res.status(201).json({ id: r.lastInsertRowid, client_code: code });
});

router.put('/:id', requirePermission(M, 'edit'), (req, res) => {
  const b = req.body || {};
  getDb().prepare(
    'UPDATE salon_clients SET name=?, phone=?, email=?, gender=?, dob=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
  ).run(b.name || '', b.phone || '', b.email || '', b.gender || '', b.dob || '', b.notes || '', req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/:id', requirePermission(M, 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM salon_clients WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
