const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Installations
router.get('/', (req, res) => {
  res.json(getDb().prepare(`SELECT i.*, po.po_number, u.name as assigned_to_name FROM installations i
    LEFT JOIN purchase_orders po ON i.po_id=po.id LEFT JOIN users u ON i.assigned_to=u.id ORDER BY i.created_at DESC`).all());
});

router.post('/', (req, res) => {
  const { po_id, site_address, start_date, end_date, assigned_to, notes } = req.body;
  const r = getDb().prepare('INSERT INTO installations (po_id,site_address,start_date,end_date,assigned_to,notes) VALUES (?,?,?,?,?,?)')
    .run(po_id, site_address, start_date, end_date, assigned_to, notes);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const { status, start_date, end_date, assigned_to, notes } = req.body;
  getDb().prepare('UPDATE installations SET status=?,start_date=?,end_date=?,assigned_to=?,notes=? WHERE id=?')
    .run(status, start_date, end_date, assigned_to, notes, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/:id', (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const ra = db.prepare('SELECT COUNT(*) as c FROM ra_bills WHERE installation_id=?').get(id).c;
  const mb = db.prepare('SELECT COUNT(*) as c FROM mb_bills WHERE installation_id=?').get(id).c;
  const hc = db.prepare('SELECT COUNT(*) as c FROM handover_certificates WHERE installation_id=?').get(id).c;
  if (ra > 0 || mb > 0 || hc > 0) return res.status(409).json({ error: 'Cannot delete: RA/MB bills or handover certificates reference this installation' });
  db.prepare('DELETE FROM installations WHERE id=?').run(id);
  res.json({ message: 'Deleted' });
});

// RA Bills
router.get('/ra-bills', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM ra_bills ORDER BY created_at DESC').all());
});

router.post('/ra-bills', (req, res) => {
  const { installation_id, bill_number, bill_date, work_done_amount, previous_amount, current_amount } = req.body;
  const r = getDb().prepare('INSERT INTO ra_bills (installation_id,bill_number,bill_date,work_done_amount,previous_amount,current_amount) VALUES (?,?,?,?,?,?)')
    .run(installation_id, bill_number, bill_date, work_done_amount, previous_amount, current_amount);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/ra-bills/:id', (req, res) => {
  getDb().prepare('UPDATE ra_bills SET status=? WHERE id=?').run(req.body.status, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/ra-bills/:id', (req, res) => {
  const mb = getDb().prepare('SELECT COUNT(*) as c FROM mb_bills WHERE ra_bill_id=?').get(req.params.id).c;
  if (mb > 0) return res.status(409).json({ error: 'Cannot delete: MB bills reference this RA bill' });
  getDb().prepare('DELETE FROM ra_bills WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// MB Bills
router.get('/mb-bills', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM mb_bills ORDER BY created_at DESC').all());
});

router.post('/mb-bills', (req, res) => {
  const { ra_bill_id, installation_id, bill_number, measurements, total_amount } = req.body;
  const r = getDb().prepare('INSERT INTO mb_bills (ra_bill_id,installation_id,bill_number,measurements,total_amount) VALUES (?,?,?,?,?)')
    .run(ra_bill_id, installation_id, bill_number, measurements, total_amount);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/mb-bills/:id', (req, res) => {
  getDb().prepare('UPDATE mb_bills SET status=? WHERE id=?').run(req.body.status, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/mb-bills/:id', (req, res) => {
  const ib = getDb().prepare('SELECT COUNT(*) as c FROM installation_bills WHERE mb_bill_id=?').get(req.params.id).c;
  if (ib > 0) return res.status(409).json({ error: 'Cannot delete: Installation bills reference this MB bill' });
  getDb().prepare('DELETE FROM mb_bills WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Installation Bills
router.get('/inst-bills', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM installation_bills ORDER BY created_at DESC').all());
});

router.post('/inst-bills', (req, res) => {
  const { installation_id, mb_bill_id, bill_number, amount } = req.body;
  const r = getDb().prepare('INSERT INTO installation_bills (installation_id,mb_bill_id,bill_number,amount) VALUES (?,?,?,?)')
    .run(installation_id, mb_bill_id, bill_number, amount);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.delete('/inst-bills/:id', (req, res) => {
  getDb().prepare('DELETE FROM installation_bills WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Testing & Commissioning
router.get('/testing', (req, res) => {
  res.json(getDb().prepare(`SELECT tc.*, u.name as tested_by_name FROM testing_commissioning tc
    LEFT JOIN users u ON tc.tested_by=u.id ORDER BY tc.created_at DESC`).all());
});

router.post('/testing', (req, res) => {
  const { installation_id, test_date, test_type, result, notes } = req.body;
  const r = getDb().prepare('INSERT INTO testing_commissioning (installation_id,test_date,test_type,result,notes,tested_by) VALUES (?,?,?,?,?,?)')
    .run(installation_id, test_date, test_type, result, notes, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});

// Complaints
router.get('/complaints', (req, res) => {
  res.json(getDb().prepare(`SELECT c.*, u1.name as created_by_name, u2.name as assigned_to_name FROM complaints c
    LEFT JOIN users u1 ON c.created_by=u1.id LEFT JOIN users u2 ON c.assigned_to=u2.id ORDER BY c.created_at DESC`).all());
});

router.post('/complaints', (req, res) => {
  const db = getDb();
  const { installation_id, po_id, description, priority, assigned_to } = req.body;
  const { nextSequence } = require('../db/nextSequence');
  const cNum = nextSequence(db, 'complaints', 'complaint_number', 'CMP-', { startFrom: 0, pad: 4 });
  const r = db.prepare('INSERT INTO complaints (installation_id,po_id,complaint_number,description,priority,assigned_to,created_by) VALUES (?,?,?,?,?,?,?)')
    .run(installation_id, po_id, cNum, description, priority, assigned_to, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid, complaint_number: cNum });
});

router.put('/complaints/:id', (req, res) => {
  const { status, resolution_notes } = req.body;
  const resolved_date = status === 'resolved' ? new Date().toISOString().split('T')[0] : null;
  getDb().prepare('UPDATE complaints SET status=?, resolution_notes=?, resolved_date=? WHERE id=?')
    .run(status, resolution_notes, resolved_date, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/testing/:id', (req, res) => {
  getDb().prepare('DELETE FROM testing_commissioning WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Handover Certificates
router.get('/handover', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM handover_certificates ORDER BY created_at DESC').all());
});

router.post('/handover', (req, res) => {
  const db = getDb();
  const { installation_id, po_id, handover_date, client_signatory, company_signatory, notes } = req.body;
  const { nextSequence } = require('../db/nextSequence');
  const certNum = nextSequence(db, 'handover_certificates', 'certificate_number', 'HC-', { startFrom: 0, pad: 4 });
  const r = db.prepare('INSERT INTO handover_certificates (installation_id,po_id,certificate_number,handover_date,client_signatory,company_signatory,notes) VALUES (?,?,?,?,?,?,?)')
    .run(installation_id, po_id, certNum, handover_date, client_signatory, company_signatory, notes);
  res.status(201).json({ id: r.lastInsertRowid, certificate_number: certNum });
});

router.put('/handover/:id', (req, res) => {
  getDb().prepare('UPDATE handover_certificates SET status=? WHERE id=?').run(req.body.status, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/handover/:id', (req, res) => {
  getDb().prepare('DELETE FROM handover_certificates WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Payments
router.get('/payments', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM payments ORDER BY created_at DESC').all());
});

router.post('/payments', (req, res) => {
  const { type, reference_type, reference_id, amount, payment_date, payment_mode, transaction_ref, notes } = req.body;
  const r = getDb().prepare('INSERT INTO payments (type,reference_type,reference_id,amount,payment_date,payment_mode,transaction_ref,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(type, reference_type, reference_id, amount, payment_date, payment_mode, transaction_ref, notes, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});

module.exports = router;
