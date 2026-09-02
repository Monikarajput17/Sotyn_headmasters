const express = require('express');
const pg = require('../db/pg');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

router.get('/sources', async (req, res) => {
  try {
    res.json(await pg.all('SELECT * FROM lead_sources ORDER BY name'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/', requirePermission('leads', 'view'), async (req, res) => {
  try {
    const { status, source_id, search } = req.query;
    let sql = `SELECT l.*, ls.name as source_name, u.name as assigned_to_name
      FROM leads l LEFT JOIN lead_sources ls ON l.source_id=ls.id LEFT JOIN users u ON l.assigned_to=u.id WHERE 1=1`;
    const params = [];
    if (status) { sql += ' AND l.status=?'; params.push(status); }
    if (source_id) { sql += ' AND l.source_id=?'; params.push(source_id); }
    if (search) { sql += ' AND (l.company_name ILIKE ? OR l.contact_person ILIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY l.created_at DESC';
    res.json(await pg.all(sql, ...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/stats', async (req, res) => {
  try {
    const total = await pg.get('SELECT COUNT(*) as count FROM leads');
    const byStatus = await pg.all('SELECT status, COUNT(*) as count FROM leads GROUP BY status');
    const bySource = await pg.all('SELECT ls.name, COUNT(*) as count FROM leads l JOIN lead_sources ls ON l.source_id=ls.id GROUP BY ls.name');
    res.json({ total: total.count, byStatus, bySource });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const lead = await pg.get(`SELECT l.*, ls.name as source_name, u.name as assigned_to_name
      FROM leads l LEFT JOIN lead_sources ls ON l.source_id=ls.id LEFT JOIN users u ON l.assigned_to=u.id WHERE l.id=?`, req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(lead);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requirePermission('leads', 'create'), async (req, res) => {
  try {
    const { company_name, contact_person, phone, email, source_id, status, assigned_to, notes } = req.body;
    if (!company_name) return res.status(400).json({ error: 'Company name required' });
    const result = await pg.run(
      'INSERT INTO leads (company_name, contact_person, phone, email, source_id, status, assigned_to, notes) VALUES (?,?,?,?,?,?,?,?)',
      company_name, contact_person, phone, email, source_id, status || 'new', assigned_to, notes);
    res.status(201).json({ id: result.lastInsertRowid, message: 'Lead created' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', requirePermission('leads', 'edit'), async (req, res) => {
  try {
    const { company_name, contact_person, phone, email, source_id, status, assigned_to, notes } = req.body;
    await pg.run(
      'UPDATE leads SET company_name=?, contact_person=?, phone=?, email=?, source_id=?, status=?, assigned_to=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
      company_name, contact_person, phone, email, source_id, status, assigned_to, notes, req.params.id);
    res.json({ message: 'Lead updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requirePermission('leads', 'delete'), async (req, res) => {
  try {
    await pg.run('DELETE FROM leads WHERE id=?', req.params.id);
    res.json({ message: 'Lead deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
