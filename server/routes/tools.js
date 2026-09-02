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
const pg = require('../db/pg');
const { authMiddleware, requirePermission, adminOnly } = require('../middleware/auth');
const { nextSequencePg } = require('../db/nextSequence');

router.use(authMiddleware);

// UTC calendar date, exact parity with SQLite date('now').
const todayStr = () => new Date().toISOString().slice(0, 10);

// ---------- TOOLS CATALOG ----------

router.get('/', requirePermission('tools', 'view'), async (req, res) => {
  try {
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
    res.json(await pg.all(sql, ...params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', requirePermission('tools', 'view'), async (req, res) => {
  try {
    const total = (await pg.get('SELECT COUNT(*) as c FROM tools')).c;
    const byStatus = await pg.all(`SELECT status, COUNT(*) as c FROM tools GROUP BY status`);
    const byCategory = await pg.all(`SELECT COALESCE(category, '—') as category, COUNT(*) as c FROM tools GROUP BY category`);
    // date('now','+30 days') computed in JS (UTC parity with SQLite)
    const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const calibrationDue = (await pg.get(`SELECT COUNT(*) as c FROM tools WHERE next_calibration_date IS NOT NULL AND next_calibration_date <= ?`, in30)).c;
    const totalValue = (await pg.get(`SELECT COALESCE(SUM(purchase_price), 0) as s FROM tools WHERE status != 'scrapped'`)).s;
    res.json({ total, by_status: byStatus, by_category: byCategory, calibration_due_30d: calibrationDue, total_value: totalValue });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', requirePermission('tools', 'view'), async (req, res) => {
  try {
    const tool = await pg.get(`
      SELECT t.*, s.name as current_site_name, u.name as current_user_name
      FROM tools t
      LEFT JOIN sites s ON s.id = t.current_site_id
      LEFT JOIN users u ON u.id = t.current_user_id
      WHERE t.id = ?
    `, req.params.id);
    if (!tool) return res.status(404).json({ error: 'Not found' });
    const movements = await pg.all(`
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
    `, req.params.id);
    res.json({ ...tool, movements });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requirePermission('tools', 'create'), async (req, res) => {
  try {
    const b = req.body;
    if (!b.name) return res.status(400).json({ error: 'Name is required' });
    const yr = new Date().getFullYear();
    const tool_code = b.tool_code || await nextSequencePg(pg, 'tools', 'tool_code', `T-${yr}-`, { startFrom: 0, pad: 4 });
    const r = await pg.run(`
      INSERT INTO tools (
        tool_code, name, category, brand, model, serial_no,
        purchase_date, purchase_price, condition, status,
        current_site_id, current_user_id,
        last_calibration_date, next_calibration_date,
        photo_url, notes, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `,
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

router.put('/:id', requirePermission('tools', 'edit'), async (req, res) => {
  try {
    const b = req.body;
    const fields = ['name','category','brand','model','serial_no','purchase_date','purchase_price','condition','status','current_site_id','current_user_id','last_calibration_date','next_calibration_date','photo_url','notes'];
    const sets = [];
    const vals = [];
    for (const f of fields) {
      if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    sets.push('updated_at = CURRENT_TIMESTAMP');
    vals.push(req.params.id);
    await pg.run(`UPDATE tools SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', requirePermission('tools', 'delete'), async (req, res) => {
  try {
    await pg.run('DELETE FROM tool_movements WHERE tool_id=?', req.params.id);
    await pg.run('DELETE FROM tools WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- MOVEMENTS (issue / return / transfer / scrap / maintenance) ----------

router.post('/:id/issue', requirePermission('tools', 'edit'), async (req, res) => {
  try {
    const { to_site_id, to_user_id, expected_return_date, condition, notes, photo_url } = req.body;
    if (!to_site_id && !to_user_id) return res.status(400).json({ error: 'Pick a site or a person to issue this tool to' });
    const tool = await pg.get('SELECT * FROM tools WHERE id=?', req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    if (tool.status === 'scrapped' || tool.status === 'lost') return res.status(400).json({ error: `Tool is ${tool.status}` });
    await pg.tx(async (t) => {
      await t.run(`
        INSERT INTO tool_movements (tool_id, action, from_site_id, from_user_id, to_site_id, to_user_id, expected_return_date, condition_at_action, notes, photo_url, created_by)
        VALUES (?, 'issue', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, req.params.id, tool.current_site_id || null, tool.current_user_id || null, to_site_id || null, to_user_id || null, expected_return_date || null, condition || tool.condition, notes || null, photo_url || null, req.user.id);
      await t.run(`UPDATE tools SET current_site_id=?, current_user_id=?, status='in_use', updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        to_site_id || null, to_user_id || null, req.params.id);
    });
    res.json({ message: 'Issued' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/return', requirePermission('tools', 'edit'), async (req, res) => {
  try {
    const { condition, notes, photo_url } = req.body;
    const tool = await pg.get('SELECT * FROM tools WHERE id=?', req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    await pg.tx(async (t) => {
      await t.run(`
        INSERT INTO tool_movements (tool_id, action, from_site_id, from_user_id, actual_return_date, condition_at_action, notes, photo_url, created_by)
        VALUES (?, 'return', ?, ?, ?, ?, ?, ?, ?)
      `, req.params.id, tool.current_site_id || null, tool.current_user_id || null, todayStr(), condition || tool.condition, notes || null, photo_url || null, req.user.id);
      await t.run(`UPDATE tools SET current_site_id=NULL, current_user_id=NULL, status='available', condition=COALESCE(?, condition), updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        condition || null, req.params.id);
    });
    res.json({ message: 'Returned' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/scrap', requirePermission('tools', 'edit'), async (req, res) => {
  try {
    const { notes, photo_url } = req.body;
    const tool = await pg.get('SELECT * FROM tools WHERE id=?', req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    await pg.tx(async (t) => {
      await t.run(`
        INSERT INTO tool_movements (tool_id, action, from_site_id, from_user_id, condition_at_action, notes, photo_url, created_by)
        VALUES (?, 'scrap', ?, ?, 'scrap', ?, ?, ?)
      `, req.params.id, tool.current_site_id || null, tool.current_user_id || null, notes || null, photo_url || null, req.user.id);
      await t.run(`UPDATE tools SET status='scrapped', condition='scrap', updated_at=CURRENT_TIMESTAMP WHERE id=?`, req.params.id);
    });
    res.json({ message: 'Scrapped' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/maintenance', requirePermission('tools', 'edit'), async (req, res) => {
  try {
    const { notes, photo_url } = req.body;
    const tool = await pg.get('SELECT * FROM tools WHERE id=?', req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    await pg.tx(async (t) => {
      await t.run(`INSERT INTO tool_movements (tool_id, action, condition_at_action, notes, photo_url, created_by)
                  VALUES (?, 'maintenance', ?, ?, ?, ?)`, req.params.id, tool.condition, notes || null, photo_url || null, req.user.id);
      await t.run(`UPDATE tools SET status='maintenance', updated_at=CURRENT_TIMESTAMP WHERE id=?`, req.params.id);
    });
    res.json({ message: 'Marked for maintenance' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- WEEKLY SUBMISSIONS (Supervisor KPI) ----------

router.get('/submissions/list', requirePermission('tools', 'view'), async (req, res) => {
  try {
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
    res.json(await pg.all(sql, ...params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/submissions', requirePermission('tools', 'create'), async (req, res) => {
  try {
    const { site_id, week_start, tools_json, photo_url, notes } = req.body;
    if (!site_id || !week_start) return res.status(400).json({ error: 'site_id and week_start required' });
    const tools = Array.isArray(tools_json) ? tools_json : [];
    const tools_count = tools.reduce((s, t) => s + (Number(t.qty) || 1), 0);
    await pg.run(`
      INSERT INTO tools_list_submissions (site_id, submitted_by, week_start, tools_count, tools_json, photo_url, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(site_id, submitted_by, week_start) DO UPDATE SET
        tools_count=excluded.tools_count,
        tools_json=excluded.tools_json,
        photo_url=excluded.photo_url,
        notes=excluded.notes
    `, site_id, req.user.id, week_start, tools_count, JSON.stringify(tools), photo_url || null, notes || null);
    res.json({ message: 'Submitted', tools_count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
