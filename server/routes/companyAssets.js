// Company Assets — IT / office equipment register: laptops, phones, SIMs,
// chargers, monitors, etc. Permission-gated under the 'company_assets'
// module. Movements (issue / return / maintenance / scrap) are logged
// for audit.

const express = require('express');
const pg = require('../db/pg');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// ============= LIST =============
router.get('/', requirePermission('company_assets', 'view'), async (req, res) => {
  try {
    const { category, status, search, current_user_id } = req.query;
    let sql = `
      SELECT a.*,
             u.name as current_user_live_name,
             cb.name as created_by_name
      FROM company_assets a
      LEFT JOIN users u ON u.id = a.current_user_id
      LEFT JOIN users cb ON cb.id = a.created_by
      WHERE 1=1
    `;
    const params = [];
    if (category) { sql += ' AND a.category = ?'; params.push(category); }
    if (status) { sql += ' AND a.status = ?'; params.push(status); }
    if (current_user_id) { sql += ' AND a.current_user_id = ?'; params.push(current_user_id); }
    if (search) {
      sql += ` AND (a.name ILIKE ? OR a.brand ILIKE ? OR a.model ILIKE ?
                    OR a.serial_no ILIKE ? OR a.imei ILIKE ? OR a.ip_address ILIKE ?
                    OR a.mobile_number ILIKE ? OR a.asset_no ILIKE ?)`;
      const q = `%${search}%`;
      params.push(q, q, q, q, q, q, q, q);
    }
    sql += ' ORDER BY a.created_at DESC';
    res.json(await pg.all(sql, ...params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/stats', requirePermission('company_assets', 'view'), async (req, res) => {
  try {
    const total = (await pg.get('SELECT COUNT(*) as c FROM company_assets')).c;
    const available = (await pg.get("SELECT COUNT(*) as c FROM company_assets WHERE status='available'")).c;
    const issued = (await pg.get("SELECT COUNT(*) as c FROM company_assets WHERE status='issued'")).c;
    const maintenance = (await pg.get("SELECT COUNT(*) as c FROM company_assets WHERE status='maintenance'")).c;
    const lost = (await pg.get("SELECT COUNT(*) as c FROM company_assets WHERE status='lost'")).c;
    const scrapped = (await pg.get("SELECT COUNT(*) as c FROM company_assets WHERE status='scrapped'")).c;
    const totalValue = (await pg.get("SELECT COALESCE(SUM(purchase_price),0) as v FROM company_assets WHERE status NOT IN ('lost','scrapped')")).v;
    const monthlyRecurring = (await pg.get("SELECT COALESCE(SUM(monthly_cost),0) as v FROM company_assets WHERE status NOT IN ('lost','scrapped')")).v;
    const byCategory = await pg.all("SELECT category, COUNT(*) as count FROM company_assets WHERE category IS NOT NULL GROUP BY category ORDER BY count DESC");
    res.json({ total, available, issued, maintenance, lost, scrapped, total_value: totalValue, monthly_recurring: monthlyRecurring, by_category: byCategory });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', requirePermission('company_assets', 'view'), async (req, res) => {
  try {
    const asset = await pg.get(`
      SELECT a.*, u.name as current_user_live_name
      FROM company_assets a
      LEFT JOIN users u ON u.id = a.current_user_id
      WHERE a.id = ?
    `, req.params.id);
    if (!asset) return res.status(404).json({ error: 'Not found' });
    asset.movements = await pg.all(`
      SELECT m.*,
             fu.name as from_user_name,
             tu.name as to_user_name,
             pb.name as performed_by_name
      FROM company_asset_movements m
      LEFT JOIN users fu ON fu.id = m.from_user_id
      LEFT JOIN users tu ON tu.id = m.to_user_id
      LEFT JOIN users pb ON pb.id = m.performed_by
      WHERE m.asset_id = ?
      ORDER BY m.performed_at DESC
    `, req.params.id);
    res.json(asset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============= CREATE =============
router.post('/', requirePermission('company_assets', 'create'), async (req, res) => {
  try {
    const b = req.body;
    if (!b.name || !String(b.name).trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const { nextSequencePg } = require('../db/nextSequence');
    const yr = new Date().getFullYear();
    const assetNo = await nextSequencePg(pg, 'company_assets', 'asset_no', `AST-${yr}-`, { startFrom: 0, pad: 4 });

    const cond = ['new','good','fair','poor','damaged','scrap'].includes(b.condition) ? b.condition : 'good';
    const stat = ['available','issued','maintenance','lost','scrapped'].includes(b.status) ? b.status : 'available';

    let assigneeName = b.current_user_name || null;
    if (!assigneeName && b.current_user_id) {
      const u = await pg.get('SELECT name FROM users WHERE id=?', b.current_user_id);
      assigneeName = u?.name || null;
    }

    const r = await pg.run(`
      INSERT INTO company_assets (
        asset_no, category, name, brand, model, serial_no, imei, ip_address,
        mobile_number, carrier, monthly_cost,
        purchase_date, purchase_price, vendor, warranty_till,
        condition, status, current_user_id, current_user_name, issued_at,
        photo_url, notes, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `,
      assetNo, b.category || null, b.name, b.brand || null, b.model || null, b.serial_no || null,
      b.imei || null, b.ip_address || null,
      b.mobile_number || null, b.carrier || null, +b.monthly_cost || 0,
      b.purchase_date || null, +b.purchase_price || 0, b.vendor || null, b.warranty_till || null,
      cond, stat, b.current_user_id || null, assigneeName,
      stat === 'issued' && b.current_user_id ? new Date().toISOString() : null,
      b.photo_url || null, b.notes || null, req.user.id
    );

    // If created already issued, log the issue movement.
    if (stat === 'issued' && b.current_user_id) {
      await pg.run(`
        INSERT INTO company_asset_movements (asset_id, movement_type, to_user_id, notes, performed_by)
        VALUES (?, 'issue', ?, ?, ?)
      `, r.lastInsertRowid, b.current_user_id, 'Initial assignment at creation', req.user.id);
    }

    res.status(201).json({ id: r.lastInsertRowid, asset_no: assetNo });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============= EDIT =============
router.put('/:id', requirePermission('company_assets', 'edit'), async (req, res) => {
  try {
    const b = req.body;
    const cur = await pg.get('SELECT * FROM company_assets WHERE id=?', req.params.id);
    if (!cur) return res.status(404).json({ error: 'Not found' });

    const fields = ['category','name','brand','model','serial_no','imei','ip_address',
                    'mobile_number','carrier','monthly_cost',
                    'purchase_date','purchase_price','vendor','warranty_till',
                    'condition','status','current_user_id','current_user_name',
                    'photo_url','notes'];
    const sets = []; const vals = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f}=?`); vals.push(b[f]); }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    vals.push(req.params.id);
    await pg.run(`UPDATE company_assets SET ${sets.join(', ')} WHERE id=?`, ...vals);
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============= ACTIONS — issue / return / maintenance / scrap =============

router.post('/:id/issue', requirePermission('company_assets', 'edit'), async (req, res) => {
  try {
    const { user_id, notes } = req.body;
    if (!user_id) return res.status(400).json({ error: 'Pick the employee to issue this asset to' });
    const a = await pg.get('SELECT * FROM company_assets WHERE id=?', req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.status === 'lost' || a.status === 'scrapped') {
      return res.status(400).json({ error: `Cannot issue — asset is ${a.status}` });
    }
    if (a.status === 'issued') {
      return res.status(400).json({ error: `Already issued to ${a.current_user_name || 'someone'}. Return it first.` });
    }
    const u = await pg.get('SELECT name FROM users WHERE id=?', user_id);
    if (!u) return res.status(404).json({ error: 'User not found' });

    await pg.run(`
      UPDATE company_assets
         SET status='issued', current_user_id=?, current_user_name=?,
             issued_at=CURRENT_TIMESTAMP, returned_at=NULL
       WHERE id=?
    `, user_id, u.name, req.params.id);

    await pg.run(`
      INSERT INTO company_asset_movements (asset_id, movement_type, from_user_id, to_user_id, notes, performed_by)
      VALUES (?, 'issue', ?, ?, ?, ?)
    `, req.params.id, a.current_user_id || null, user_id, notes || null, req.user.id);

    res.json({ message: `Issued to ${u.name}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/return', requirePermission('company_assets', 'edit'), async (req, res) => {
  try {
    const { notes, condition } = req.body;
    const a = await pg.get('SELECT * FROM company_assets WHERE id=?', req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.status !== 'issued') return res.status(400).json({ error: 'Asset is not currently issued' });

    const newCond = ['new','good','fair','poor','damaged','scrap'].includes(condition) ? condition : a.condition;

    await pg.run(`
      UPDATE company_assets
         SET status='available', current_user_id=NULL, current_user_name=NULL,
             returned_at=CURRENT_TIMESTAMP, condition=?
       WHERE id=?
    `, newCond, req.params.id);

    await pg.run(`
      INSERT INTO company_asset_movements (asset_id, movement_type, from_user_id, notes, performed_by)
      VALUES (?, 'return', ?, ?, ?)
    `, req.params.id, a.current_user_id || null, notes || null, req.user.id);

    res.json({ message: 'Returned to inventory' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/maintenance', requirePermission('company_assets', 'edit'), async (req, res) => {
  try {
    const { notes } = req.body;
    const a = await pg.get('SELECT * FROM company_assets WHERE id=?', req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });

    await pg.run(`
      UPDATE company_assets
         SET status='maintenance', current_user_id=NULL, current_user_name=NULL
       WHERE id=?
    `, req.params.id);

    await pg.run(`
      INSERT INTO company_asset_movements (asset_id, movement_type, from_user_id, notes, performed_by)
      VALUES (?, 'maintenance', ?, ?, ?)
    `, req.params.id, a.current_user_id || null, notes || null, req.user.id);

    res.json({ message: 'Sent for maintenance' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/scrap', requirePermission('company_assets', 'edit'), async (req, res) => {
  try {
    const { notes, lost } = req.body;
    const a = await pg.get('SELECT * FROM company_assets WHERE id=?', req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });

    const newStatus = lost ? 'lost' : 'scrapped';
    await pg.run(`
      UPDATE company_assets
         SET status=?, current_user_id=NULL, current_user_name=NULL
       WHERE id=?
    `, newStatus, req.params.id);

    await pg.run(`
      INSERT INTO company_asset_movements (asset_id, movement_type, from_user_id, notes, performed_by)
      VALUES (?, 'scrap', ?, ?, ?)
    `, req.params.id, a.current_user_id || null, notes || null, req.user.id);

    res.json({ message: `Marked ${newStatus}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', requirePermission('company_assets', 'delete'), async (req, res) => {
  try {
    await pg.run('DELETE FROM company_assets WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
