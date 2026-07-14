// Tools management module — catalogs returnable assets (drills, ladders,
// multimeters, safety gear) separately from consumable stock. Three
// pieces:
//   1. tools          - master catalog with serial / condition / current
//                       location (site or user)
//   2. tool_movements - log of every issue / return / transfer / scrap
//   3. tools_list_submissions - weekly per-site tool count submission
//                              (powers Supervisor MIS KPI)

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission, adminOnly } = require('../middleware/auth');
const { nextSequence } = require('../db/nextSequence');

router.use(authMiddleware);

// ---------- TOOLS CATALOG ----------

router.get('/', requirePermission('tools', 'view'), (req, res) => {
  try {
    const db = getDb();
    const { category, status, site_id, user_id, search } = req.query;
    let sql = `
      SELECT t.*,
             s.name as current_site_name,
             u.name as current_user_name,
             cu.name as created_by_name
      FROM tools t
      LEFT JOIN sites s ON s.id = t.current_site_id
      LEFT JOIN users u ON u.id = t.current_user_id
      LEFT JOIN users cu ON cu.id = t.created_by
      WHERE 1=1
    `;
    const params = [];
    if (category) { sql += ' AND t.category = ?'; params.push(category); }
    if (status) { sql += ' AND t.status = ?'; params.push(status); }
    if (site_id) { sql += ' AND t.current_site_id = ?'; params.push(site_id); }
    if (user_id) { sql += ' AND t.current_user_id = ?'; params.push(user_id); }
    if (search) {
      sql += ` AND (LOWER(t.name) LIKE ? OR LOWER(t.tool_code) LIKE ? OR LOWER(t.serial_no) LIKE ? OR LOWER(t.brand) LIKE ?)`;
      const q = `%${search.toLowerCase()}%`;
      params.push(q, q, q, q);
    }
    sql += ' ORDER BY t.created_at DESC';
    res.json(db.prepare(sql).all(...params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', requirePermission('tools', 'view'), (req, res) => {
  try {
    const db = getDb();
    const total = db.prepare('SELECT COUNT(*) as c FROM tools').get().c;
    const byStatus = db.prepare(`SELECT status, COUNT(*) as c FROM tools GROUP BY status`).all();
    const byCategory = db.prepare(`SELECT COALESCE(category, '—') as category, COUNT(*) as c FROM tools GROUP BY category`).all();
    const calibrationDue = db.prepare(`SELECT COUNT(*) as c FROM tools WHERE next_calibration_date IS NOT NULL AND next_calibration_date <= date('now', '+30 days')`).get().c;
    const totalValue = db.prepare(`SELECT COALESCE(SUM(purchase_price), 0) as s FROM tools WHERE status != 'scrapped'`).get().s;
    res.json({ total, by_status: byStatus, by_category: byCategory, calibration_due_30d: calibrationDue, total_value: totalValue });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', requirePermission('tools', 'view'), (req, res) => {
  const db = getDb();
  const tool = db.prepare(`
    SELECT t.*, s.name as current_site_name, u.name as current_user_name
    FROM tools t
    LEFT JOIN sites s ON s.id = t.current_site_id
    LEFT JOIN users u ON u.id = t.current_user_id
    WHERE t.id = ?
  `).get(req.params.id);
  if (!tool) return res.status(404).json({ error: 'Not found' });
  const movements = db.prepare(`
    SELECT tm.*,
           fs.name as from_site_name, ts.name as to_site_name,
           fu.name as from_user_name, tu.name as to_user_name,
           cb.name as created_by_name
    FROM tool_movements tm
    LEFT JOIN sites fs ON fs.id = tm.from_site_id
    LEFT JOIN sites ts ON ts.id = tm.to_site_id
    LEFT JOIN users fu ON fu.id = tm.from_user_id
    LEFT JOIN users tu ON tu.id = tm.to_user_id
    LEFT JOIN users cb ON cb.id = tm.created_by
    WHERE tm.tool_id = ?
    ORDER BY tm.created_at DESC
  `).all(req.params.id);
  res.json({ ...tool, movements });
});

router.post('/', requirePermission('tools', 'create'), (req, res) => {
  try {
    const b = req.body;
    if (!b.name) return res.status(400).json({ error: 'Name is required' });
    const db = getDb();
    const yr = new Date().getFullYear();
    const tool_code = b.tool_code || nextSequence(db, 'tools', 'tool_code', `T-${yr}-`, { startFrom: 0, pad: 4 });
    const r = db.prepare(`
      INSERT INTO tools (
        tool_code, name, category, brand, model, serial_no,
        purchase_date, purchase_price, condition, status,
        current_site_id, current_user_id,
        last_calibration_date, next_calibration_date,
        photo_url, notes, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      tool_code, b.name, b.category || null, b.brand || null, b.model || null, b.serial_no || null,
      b.purchase_date || null, b.purchase_price || 0, b.condition || 'good', b.status || 'available',
      b.current_site_id || null, b.current_user_id || null,
      b.last_calibration_date || null, b.next_calibration_date || null,
      b.photo_url || null, b.notes || null, req.user.id
    );
    res.status(201).json({ id: r.lastInsertRowid, tool_code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requirePermission('tools', 'edit'), (req, res) => {
  try {
    const b = req.body;
    const db = getDb();
    const fields = ['name','category','brand','model','serial_no','purchase_date','purchase_price','condition','status','current_site_id','current_user_id','last_calibration_date','next_calibration_date','photo_url','notes'];
    const sets = [];
    const vals = [];
    for (const f of fields) {
      if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    sets.push('updated_at = CURRENT_TIMESTAMP');
    vals.push(req.params.id);
    db.prepare(`UPDATE tools SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', requirePermission('tools', 'delete'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM tool_movements WHERE tool_id=?').run(req.params.id);
  db.prepare('DELETE FROM tools WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ---------- MOVEMENTS (issue / return / transfer / scrap / maintenance) ----------

router.post('/:id/issue', requirePermission('tools', 'edit'), (req, res) => {
  try {
    const db = getDb();
    const { to_site_id, to_user_id, expected_return_date, condition, notes, photo_url } = req.body;
    if (!to_site_id && !to_user_id) return res.status(400).json({ error: 'Pick a site or a person to issue this tool to' });
    const tool = db.prepare('SELECT * FROM tools WHERE id=?').get(req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    if (tool.status === 'scrapped' || tool.status === 'lost') return res.status(400).json({ error: `Tool is ${tool.status}` });
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO tool_movements (tool_id, action, from_site_id, from_user_id, to_site_id, to_user_id, expected_return_date, condition_at_action, notes, photo_url, created_by)
        VALUES (?, 'issue', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.params.id, tool.current_site_id || null, tool.current_user_id || null, to_site_id || null, to_user_id || null, expected_return_date || null, condition || tool.condition, notes || null, photo_url || null, req.user.id);
      db.prepare(`UPDATE tools SET current_site_id=?, current_user_id=?, status='in_use', updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(to_site_id || null, to_user_id || null, req.params.id);
    });
    tx();
    res.json({ message: 'Issued' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/return', requirePermission('tools', 'edit'), (req, res) => {
  try {
    const db = getDb();
    const { condition, notes, photo_url } = req.body;
    const tool = db.prepare('SELECT * FROM tools WHERE id=?').get(req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO tool_movements (tool_id, action, from_site_id, from_user_id, actual_return_date, condition_at_action, notes, photo_url, created_by)
        VALUES (?, 'return', ?, ?, date('now'), ?, ?, ?, ?)
      `).run(req.params.id, tool.current_site_id || null, tool.current_user_id || null, condition || tool.condition, notes || null, photo_url || null, req.user.id);
      db.prepare(`UPDATE tools SET current_site_id=NULL, current_user_id=NULL, status='available', condition=COALESCE(?, condition), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(condition || null, req.params.id);
    });
    tx();
    res.json({ message: 'Returned' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/scrap', requirePermission('tools', 'edit'), (req, res) => {
  try {
    const db = getDb();
    const { notes, photo_url } = req.body;
    const tool = db.prepare('SELECT * FROM tools WHERE id=?').get(req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO tool_movements (tool_id, action, from_site_id, from_user_id, condition_at_action, notes, photo_url, created_by)
        VALUES (?, 'scrap', ?, ?, 'scrap', ?, ?, ?)
      `).run(req.params.id, tool.current_site_id || null, tool.current_user_id || null, notes || null, photo_url || null, req.user.id);
      db.prepare(`UPDATE tools SET status='scrapped', condition='scrap', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.params.id);
    });
    tx();
    res.json({ message: 'Scrapped' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/maintenance', requirePermission('tools', 'edit'), (req, res) => {
  try {
    const db = getDb();
    const { notes, photo_url } = req.body;
    const tool = db.prepare('SELECT * FROM tools WHERE id=?').get(req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO tool_movements (tool_id, action, condition_at_action, notes, photo_url, created_by)
                  VALUES (?, 'maintenance', ?, ?, ?, ?)`).run(req.params.id, tool.condition, notes || null, photo_url || null, req.user.id);
      db.prepare(`UPDATE tools SET status='maintenance', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.params.id);
    });
    tx();
    res.json({ message: 'Marked for maintenance' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- WEEKLY SUBMISSIONS (Supervisor KPI) ----------

router.get('/submissions/list', requirePermission('tools', 'view'), (req, res) => {
  try {
    const db = getDb();
    const { week_start, site_id, submitted_by } = req.query;
    let sql = `
      SELECT tls.*, s.name as site_name, u.name as submitted_by_name
      FROM tools_list_submissions tls
      LEFT JOIN sites s ON s.id = tls.site_id
      LEFT JOIN users u ON u.id = tls.submitted_by
      WHERE 1=1
    `;
    const params = [];
    if (week_start) { sql += ' AND tls.week_start = ?'; params.push(week_start); }
    if (site_id) { sql += ' AND tls.site_id = ?'; params.push(site_id); }
    if (submitted_by) { sql += ' AND tls.submitted_by = ?'; params.push(submitted_by); }
    sql += ' ORDER BY tls.week_start DESC, tls.created_at DESC';
    res.json(db.prepare(sql).all(...params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/submissions', requirePermission('tools', 'create'), (req, res) => {
  try {
    const { site_id, week_start, tools_json, photo_url, notes } = req.body;
    if (!site_id || !week_start) return res.status(400).json({ error: 'site_id and week_start required' });
    const tools = Array.isArray(tools_json) ? tools_json : [];
    const tools_count = tools.reduce((s, t) => s + (Number(t.qty) || 1), 0);
    const db = getDb();
    db.prepare(`
      INSERT INTO tools_list_submissions (site_id, submitted_by, week_start, tools_count, tools_json, photo_url, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(site_id, submitted_by, week_start) DO UPDATE SET
        tools_count=excluded.tools_count,
        tools_json=excluded.tools_json,
        photo_url=excluded.photo_url,
        notes=excluded.notes
    `).run(site_id, req.user.id, week_start, tools_count, JSON.stringify(tools), photo_url || null, notes || null);
    res.json({ message: 'Submitted', tools_count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
