// Company Assets — IT / office equipment register: laptops, phones, SIMs,
// chargers, monitors, etc. Permission-gated under the 'company_assets'
// module. Movements (issue / return / maintenance / scrap) are logged
// for audit.

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// ============= LIST =============
router.get('/', requirePermission('company_assets', 'view'), (req, res) => {
  try {
    const db = getDb();
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
      sql += ` AND (a.name LIKE ? OR a.brand LIKE ? OR a.model LIKE ?
                    OR a.serial_no LIKE ? OR a.imei LIKE ? OR a.ip_address LIKE ?
                    OR a.mobile_number LIKE ? OR a.asset_no LIKE ?)`;
      const q = `%${search}%`;
      params.push(q, q, q, q, q, q, q, q);
    }
    sql += ' ORDER BY a.created_at DESC';
    res.json(db.prepare(sql).all(...params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/stats', requirePermission('company_assets', 'view'), (req, res) => {
  try {
    const db = getDb();
    const total = db.prepare('SELECT COUNT(*) as c FROM company_assets').get().c;
    const available = db.prepare("SELECT COUNT(*) as c FROM company_assets WHERE status='available'").get().c;
    const issued = db.prepare("SELECT COUNT(*) as c FROM company_assets WHERE status='issued'").get().c;
    const maintenance = db.prepare("SELECT COUNT(*) as c FROM company_assets WHERE status='maintenance'").get().c;
    const lost = db.prepare("SELECT COUNT(*) as c FROM company_assets WHERE status='lost'").get().c;
    const scrapped = db.prepare("SELECT COUNT(*) as c FROM company_assets WHERE status='scrapped'").get().c;
    const totalValue = db.prepare("SELECT COALESCE(SUM(purchase_price),0) as v FROM company_assets WHERE status NOT IN ('lost','scrapped')").get().v;
    const monthlyRecurring = db.prepare("SELECT COALESCE(SUM(monthly_cost),0) as v FROM company_assets WHERE status NOT IN ('lost','scrapped')").get().v;
    const byCategory = db.prepare("SELECT category, COUNT(*) as count FROM company_assets WHERE category IS NOT NULL GROUP BY category ORDER BY count DESC").all();
    res.json({ total, available, issued, maintenance, lost, scrapped, total_value: totalValue, monthly_recurring: monthlyRecurring, by_category: byCategory });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', requirePermission('company_assets', 'view'), (req, res) => {
  try {
    const db = getDb();
    const asset = db.prepare(`
      SELECT a.*, u.name as current_user_live_name
      FROM company_assets a
      LEFT JOIN users u ON u.id = a.current_user_id
      WHERE a.id = ?
    `).get(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Not found' });
    asset.movements = db.prepare(`
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
    `).all(req.params.id);
    res.json(asset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============= CREATE =============
router.post('/', requirePermission('company_assets', 'create'), (req, res) => {
  try {
    const b = req.body;
    if (!b.name || !String(b.name).trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const db = getDb();
    const { nextSequence } = require('../db/nextSequence');
    const yr = new Date().getFullYear();
    const assetNo = nextSequence(db, 'company_assets', 'asset_no', `AST-${yr}-`, { startFrom: 0, pad: 4 });

    const cond = ['new','good','fair','poor','damaged','scrap'].includes(b.condition) ? b.condition : 'good';
    const stat = ['available','issued','maintenance','lost','scrapped'].includes(b.status) ? b.status : 'available';

    let assigneeName = b.current_user_name || null;
    if (!assigneeName && b.current_user_id) {
      const u = db.prepare('SELECT name FROM users WHERE id=?').get(b.current_user_id);
      assigneeName = u?.name || null;
    }

    const r = db.prepare(`
      INSERT INTO company_assets (
        asset_no, category, name, brand, model, serial_no, imei, ip_address,
        mobile_number, carrier, monthly_cost,
        purchase_date, purchase_price, vendor, warranty_till,
        condition, status, current_user_id, current_user_name, issued_at,
        photo_url, notes, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
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
      db.prepare(`
        INSERT INTO company_asset_movements (asset_id, movement_type, to_user_id, notes, performed_by)
        VALUES (?, 'issue', ?, ?, ?)
      `).run(r.lastInsertRowid, b.current_user_id, 'Initial assignment at creation', req.user.id);
    }

    res.status(201).json({ id: r.lastInsertRowid, asset_no: assetNo });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============= EDIT =============
router.put('/:id', requirePermission('company_assets', 'edit'), (req, res) => {
  try {
    const b = req.body;
    const db = getDb();
    const cur = db.prepare('SELECT * FROM company_assets WHERE id=?').get(req.params.id);
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
    db.prepare(`UPDATE company_assets SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============= ACTIONS — issue / return / maintenance / scrap =============

router.post('/:id/issue', requirePermission('company_assets', 'edit'), (req, res) => {
  try {
    const { user_id, notes } = req.body;
    if (!user_id) return res.status(400).json({ error: 'Pick the employee to issue this asset to' });
    const db = getDb();
    const a = db.prepare('SELECT * FROM company_assets WHERE id=?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.status === 'lost' || a.status === 'scrapped') {
      return res.status(400).json({ error: `Cannot issue — asset is ${a.status}` });
    }
    if (a.status === 'issued') {
      return res.status(400).json({ error: `Already issued to ${a.current_user_name || 'someone'}. Return it first.` });
    }
    const u = db.prepare('SELECT name FROM users WHERE id=?').get(user_id);
    if (!u) return res.status(404).json({ error: 'User not found' });

    db.prepare(`
      UPDATE company_assets
         SET status='issued', current_user_id=?, current_user_name=?,
             issued_at=CURRENT_TIMESTAMP, returned_at=NULL
       WHERE id=?
    `).run(user_id, u.name, req.params.id);

    db.prepare(`
      INSERT INTO company_asset_movements (asset_id, movement_type, from_user_id, to_user_id, notes, performed_by)
      VALUES (?, 'issue', ?, ?, ?, ?)
    `).run(req.params.id, a.current_user_id || null, user_id, notes || null, req.user.id);

    res.json({ message: `Issued to ${u.name}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/return', requirePermission('company_assets', 'edit'), (req, res) => {
  try {
    const { notes, condition } = req.body;
    const db = getDb();
    const a = db.prepare('SELECT * FROM company_assets WHERE id=?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.status !== 'issued') return res.status(400).json({ error: 'Asset is not currently issued' });

    const newCond = ['new','good','fair','poor','damaged','scrap'].includes(condition) ? condition : a.condition;

    db.prepare(`
      UPDATE company_assets
         SET status='available', current_user_id=NULL, current_user_name=NULL,
             returned_at=CURRENT_TIMESTAMP, condition=?
       WHERE id=?
    `).run(newCond, req.params.id);

    db.prepare(`
      INSERT INTO company_asset_movements (asset_id, movement_type, from_user_id, notes, performed_by)
      VALUES (?, 'return', ?, ?, ?)
    `).run(req.params.id, a.current_user_id || null, notes || null, req.user.id);

    res.json({ message: 'Returned to inventory' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/maintenance', requirePermission('company_assets', 'edit'), (req, res) => {
  try {
    const { notes } = req.body;
    const db = getDb();
    const a = db.prepare('SELECT * FROM company_assets WHERE id=?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });

    db.prepare(`
      UPDATE company_assets
         SET status='maintenance', current_user_id=NULL, current_user_name=NULL
       WHERE id=?
    `).run(req.params.id);

    db.prepare(`
      INSERT INTO company_asset_movements (asset_id, movement_type, from_user_id, notes, performed_by)
      VALUES (?, 'maintenance', ?, ?, ?)
    `).run(req.params.id, a.current_user_id || null, notes || null, req.user.id);

    res.json({ message: 'Sent for maintenance' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/scrap', requirePermission('company_assets', 'edit'), (req, res) => {
  try {
    const { notes, lost } = req.body;
    const db = getDb();
    const a = db.prepare('SELECT * FROM company_assets WHERE id=?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });

    const newStatus = lost ? 'lost' : 'scrapped';
    db.prepare(`
      UPDATE company_assets
         SET status=?, current_user_id=NULL, current_user_name=NULL
       WHERE id=?
    `).run(newStatus, req.params.id);

    db.prepare(`
      INSERT INTO company_asset_movements (asset_id, movement_type, from_user_id, notes, performed_by)
      VALUES (?, 'scrap', ?, ?, ?)
    `).run(req.params.id, a.current_user_id || null, notes || null, req.user.id);

    res.json({ message: `Marked ${newStatus}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', requirePermission('company_assets', 'delete'), (req, res) => {
  try {
    getDb().prepare('DELETE FROM company_assets WHERE id=?').run(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
