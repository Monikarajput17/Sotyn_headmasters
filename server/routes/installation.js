const express = require('express');
const pg = require('../db/pg');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Installations
router.get('/', async (req, res) => {
  try {
    res.json(await pg.all(`SELECT i.*, po.po_number, u.name as assigned_to_name FROM installations i
      LEFT JOIN purchase_orders po ON i.po_id=po.id LEFT JOIN users u ON i.assigned_to=u.id ORDER BY i.created_at DESC`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { po_id, site_address, start_date, end_date, assigned_to, notes } = req.body;
    const r = await pg.run('INSERT INTO installations (po_id,site_address,start_date,end_date,assigned_to,notes) VALUES (?,?,?,?,?,?)',
      po_id, site_address, start_date, end_date, assigned_to, notes);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const { status, start_date, end_date, assigned_to, notes } = req.body;
    await pg.run('UPDATE installations SET status=?,start_date=?,end_date=?,assigned_to=?,notes=? WHERE id=?',
      status, start_date, end_date, assigned_to, notes, req.params.id);
    res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const ra = (await pg.get('SELECT COUNT(*) as c FROM ra_bills WHERE installation_id=?', id)).c;
    const mb = (await pg.get('SELECT COUNT(*) as c FROM mb_bills WHERE installation_id=?', id)).c;
    const hc = (await pg.get('SELECT COUNT(*) as c FROM handover_certificates WHERE installation_id=?', id)).c;
    if (ra > 0 || mb > 0 || hc > 0) return res.status(409).json({ error: 'Cannot delete: RA/MB bills or handover certificates reference this installation' });
    await pg.run('DELETE FROM installations WHERE id=?', id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// RA Bills
router.get('/ra-bills', async (req, res) => {
  try {
    res.json(await pg.all('SELECT * FROM ra_bills ORDER BY created_at DESC'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/ra-bills', async (req, res) => {
  try {
    const { installation_id, bill_number, bill_date, work_done_amount, previous_amount, current_amount } = req.body;
    const r = await pg.run('INSERT INTO ra_bills (installation_id,bill_number,bill_date,work_done_amount,previous_amount,current_amount) VALUES (?,?,?,?,?,?)',
      installation_id, bill_number, bill_date, work_done_amount, previous_amount, current_amount);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/ra-bills/:id', async (req, res) => {
  try {
    await pg.run('UPDATE ra_bills SET status=? WHERE id=?', req.body.status, req.params.id);
    res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/ra-bills/:id', async (req, res) => {
  try {
    const mb = (await pg.get('SELECT COUNT(*) as c FROM mb_bills WHERE ra_bill_id=?', req.params.id)).c;
    if (mb > 0) return res.status(409).json({ error: 'Cannot delete: MB bills reference this RA bill' });
    await pg.run('DELETE FROM ra_bills WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// MB Bills
router.get('/mb-bills', async (req, res) => {
  try {
    res.json(await pg.all('SELECT * FROM mb_bills ORDER BY created_at DESC'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/mb-bills', async (req, res) => {
  try {
    const { ra_bill_id, installation_id, bill_number, measurements, total_amount } = req.body;
    const r = await pg.run('INSERT INTO mb_bills (ra_bill_id,installation_id,bill_number,measurements,total_amount) VALUES (?,?,?,?,?)',
      ra_bill_id, installation_id, bill_number, measurements, total_amount);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/mb-bills/:id', async (req, res) => {
  try {
    await pg.run('UPDATE mb_bills SET status=? WHERE id=?', req.body.status, req.params.id);
    res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/mb-bills/:id', async (req, res) => {
  try {
    const ib = (await pg.get('SELECT COUNT(*) as c FROM installation_bills WHERE mb_bill_id=?', req.params.id)).c;
    if (ib > 0) return res.status(409).json({ error: 'Cannot delete: Installation bills reference this MB bill' });
    await pg.run('DELETE FROM mb_bills WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Installation Bills
router.get('/inst-bills', async (req, res) => {
  try {
    res.json(await pg.all('SELECT * FROM installation_bills ORDER BY created_at DESC'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/inst-bills', async (req, res) => {
  try {
    const { installation_id, mb_bill_id, bill_number, amount } = req.body;
    const r = await pg.run('INSERT INTO installation_bills (installation_id,mb_bill_id,bill_number,amount) VALUES (?,?,?,?)',
      installation_id, mb_bill_id, bill_number, amount);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/inst-bills/:id', async (req, res) => {
  try {
    await pg.run('DELETE FROM installation_bills WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Testing & Commissioning
router.get('/testing', async (req, res) => {
  try {
    res.json(await pg.all(`SELECT tc.*, u.name as tested_by_name FROM testing_commissioning tc
      LEFT JOIN users u ON tc.tested_by=u.id ORDER BY tc.created_at DESC`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/testing', async (req, res) => {
  try {
    const { installation_id, test_date, test_type, result, notes } = req.body;
    const r = await pg.run('INSERT INTO testing_commissioning (installation_id,test_date,test_type,result,notes,tested_by) VALUES (?,?,?,?,?,?)',
      installation_id, test_date, test_type, result, notes, req.user.id);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Complaints
router.get('/complaints', async (req, res) => {
  try {
    res.json(await pg.all(`SELECT c.*, u1.name as created_by_name, u2.name as assigned_to_name FROM complaints c
      LEFT JOIN users u1 ON c.created_by=u1.id LEFT JOIN users u2 ON c.assigned_to=u2.id ORDER BY c.created_at DESC`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/complaints', async (req, res) => {
  try {
    const { installation_id, po_id, description, priority, assigned_to } = req.body;
    const { nextSequencePg } = require('../db/nextSequence');
    const cNum = await nextSequencePg(pg, 'complaints', 'complaint_number', 'CMP-', { startFrom: 0, pad: 4 });
    const r = await pg.run('INSERT INTO complaints (installation_id,po_id,complaint_number,description,priority,assigned_to,created_by) VALUES (?,?,?,?,?,?,?)',
      installation_id, po_id, cNum, description, priority, assigned_to, req.user.id);
    res.status(201).json({ id: r.lastInsertRowid, complaint_number: cNum });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/complaints/:id', async (req, res) => {
  try {
    const { status, resolution_notes } = req.body;
    const resolved_date = status === 'resolved' ? new Date().toISOString().split('T')[0] : null;
    await pg.run('UPDATE complaints SET status=?, resolution_notes=?, resolved_date=? WHERE id=?',
      status, resolution_notes, resolved_date, req.params.id);
    res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/testing/:id', async (req, res) => {
  try {
    await pg.run('DELETE FROM testing_commissioning WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Handover Certificates
router.get('/handover', async (req, res) => {
  try {
    res.json(await pg.all('SELECT * FROM handover_certificates ORDER BY created_at DESC'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/handover', async (req, res) => {
  try {
    const { installation_id, po_id, handover_date, client_signatory, company_signatory, notes } = req.body;
    const { nextSequencePg } = require('../db/nextSequence');
    const certNum = await nextSequencePg(pg, 'handover_certificates', 'certificate_number', 'HC-', { startFrom: 0, pad: 4 });
    const r = await pg.run('INSERT INTO handover_certificates (installation_id,po_id,certificate_number,handover_date,client_signatory,company_signatory,notes) VALUES (?,?,?,?,?,?,?)',
      installation_id, po_id, certNum, handover_date, client_signatory, company_signatory, notes);
    res.status(201).json({ id: r.lastInsertRowid, certificate_number: certNum });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/handover/:id', async (req, res) => {
  try {
    await pg.run('UPDATE handover_certificates SET status=? WHERE id=?', req.body.status, req.params.id);
    res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/handover/:id', async (req, res) => {
  try {
    await pg.run('DELETE FROM handover_certificates WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Payments
router.get('/payments', async (req, res) => {
  try {
    res.json(await pg.all('SELECT * FROM payments ORDER BY created_at DESC'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/payments', async (req, res) => {
  try {
    const { type, reference_type, reference_id, amount, payment_date, payment_mode, transaction_ref, notes } = req.body;
    const r = await pg.run('INSERT INTO payments (type,reference_type,reference_id,amount,payment_date,payment_mode,transaction_ref,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?)',
      type, reference_type, reference_id, amount, payment_date, payment_mode, transaction_ref, notes, req.user.id);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
