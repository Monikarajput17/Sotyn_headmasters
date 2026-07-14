const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

router.get('/sources', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM lead_sources ORDER BY name').all());
});

router.get('/', requirePermission('leads', 'view'), (req, res) => {
  const { status, source_id, search } = req.query;
  let sql = `SELECT l.*, ls.name as source_name, u.name as assigned_to_name
    FROM leads l LEFT JOIN lead_sources ls ON l.source_id=ls.id LEFT JOIN users u ON l.assigned_to=u.id WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND l.status=?'; params.push(status); }
  if (source_id) { sql += ' AND l.source_id=?'; params.push(source_id); }
  if (search) { sql += ' AND (l.company_name LIKE ? OR l.contact_person LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  sql += ' ORDER BY l.created_at DESC';
  res.json(getDb().prepare(sql).all(...params));
});

router.get('/stats', (req, res) => {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as count FROM leads').get();
  const byStatus = db.prepare('SELECT status, COUNT(*) as count FROM leads GROUP BY status').all();
  const bySource = db.prepare('SELECT ls.name, COUNT(*) as count FROM leads l JOIN lead_sources ls ON l.source_id=ls.id GROUP BY ls.name').all();
  res.json({ total: total.count, byStatus, bySource });
});

router.get('/:id', (req, res) => {
  const lead = getDb().prepare(`SELECT l.*, ls.name as source_name, u.name as assigned_to_name
    FROM leads l LEFT JOIN lead_sources ls ON l.source_id=ls.id LEFT JOIN users u ON l.assigned_to=u.id WHERE l.id=?`).get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json(lead);
});

router.post('/', requirePermission('leads', 'create'), (req, res) => {
  const { company_name, contact_person, phone, email, source_id, status, assigned_to, notes } = req.body;
  if (!company_name) return res.status(400).json({ error: 'Company name required' });
  const result = getDb().prepare(
    'INSERT INTO leads (company_name, contact_person, phone, email, source_id, status, assigned_to, notes) VALUES (?,?,?,?,?,?,?,?)'
  ).run(company_name, contact_person, phone, email, source_id, status || 'new', assigned_to, notes);
  res.status(201).json({ id: result.lastInsertRowid, message: 'Lead created' });
});

router.put('/:id', requirePermission('leads', 'edit'), (req, res) => {
  const { company_name, contact_person, phone, email, source_id, status, assigned_to, notes } = req.body;
  getDb().prepare(
    'UPDATE leads SET company_name=?, contact_person=?, phone=?, email=?, source_id=?, status=?, assigned_to=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
  ).run(company_name, contact_person, phone, email, source_id, status, assigned_to, notes, req.params.id);
  res.json({ message: 'Lead updated' });
});

router.delete('/:id', requirePermission('leads', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM leads WHERE id=?').run(req.params.id);
  res.json({ message: 'Lead deleted' });
});

module.exports = router;
