// Inventory Management — Phase 1 MVP.
//
// Endpoints:
//   GET  /warehouses                         - list (active by default)
//   POST /warehouses                         - create custom warehouse
//   PUT  /warehouses/:id                     - rename / activate / deactivate
//
//   GET  /stock                              - current balance (filterable)
//   GET  /summary                            - per-warehouse roll-up
//   GET  /low-stock                          - items at or below reorder level
//
//   POST /receive                            - record IN movement (one warehouse, multiple items)
//   POST /issue                              - record OUT movement; either to a site (consumption) or to another warehouse (transfer)
//
//   GET  /movements                          - history with filters
//
// Stock balance is updated INSIDE a SQLite transaction with the movement
// insert, so qty + journal stay consistent. Rate uses moving average on IN
// movements; OUT movements use the current avg.

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// Idempotent column add (mam 2026-05-29: 'unable to edit used, unused').
// Lets us mutate condition on an existing balance row without forcing a
// new IN/OUT movement (movements require qty > 0 by CHECK constraint).
// GET /stock prefers this column; legacy rows where it's NULL fall back
// to deriving from the last IN movement.
try { getDb().exec(`ALTER TABLE stock_balance ADD COLUMN condition TEXT`); } catch (_) {}

// Mam 2026-05-29: 'this all black is used so how can edit other you do
// used'. Legacy stock has no condition flag anywhere — neither on
// stock_balance.condition nor any IN movement's item_condition — so the
// UI shows '—' and there's no obvious starting point for her to flip
// individual items to Unused/Scrap. Backfill those rows to 'Used' so the
// default is meaningful; she can then edit specific rows as needed.
// Tracked via app_settings flag so this runs EXACTLY ONCE — a re-run
// after mam manually flips a row would NOT clobber her edits because
// the condition would no longer be NULL, but the flag adds a safety net
// against accidental re-execution.
try {
  const db = getDb();
  const done = db.prepare("SELECT value FROM app_settings WHERE key='stock_condition_used_backfill_v1'").get();
  if (!done) {
    const r = db.prepare(`
      UPDATE stock_balance
         SET condition = 'Used'
       WHERE condition IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM stock_movements sm
            WHERE sm.warehouse_id = stock_balance.warehouse_id
              AND sm.item_master_id = stock_balance.item_master_id
              AND sm.type = 'IN'
              AND sm.item_condition IS NOT NULL
         )`).run();
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('stock_condition_used_backfill_v1', '1')").run();
    if (r.changes > 0) console.log(`[inventory] backfilled ${r.changes} legacy stock rows to condition='Used'`);
  }
} catch (e) { console.error('[inventory] condition backfill failed:', e.message); }

// ---------- INVENTORY OPENING DATE ----------
// The baseline date from which automated stock movements count (mam
// 2026-06-23: "select opening date so automation starts after that").
// Opening stock is set manually as of this date; documents dated before it
// should not drive automation. Stored as a single app_setting.
// Opening date is now PER WAREHOUSE (mam 2026-06-25: "site wise date opening").
// GET ?warehouse_id=X → that site's opening date. POST { warehouse_id,
// opening_date } sets it on the warehouse. (The /warehouses list also returns
// opening_date via w.*, so the UI usually reads it from there.)
router.get('/opening-date', requirePermission('inventory', 'view'), (req, res) => {
  const wid = +req.query.warehouse_id;
  if (!wid) return res.json({ warehouse_id: null, opening_date: null });
  const row = getDb().prepare('SELECT opening_date FROM warehouses WHERE id=?').get(wid);
  res.json({ warehouse_id: wid, opening_date: row?.opening_date || null });
});
router.post('/opening-date', requirePermission('inventory', 'edit'), (req, res) => {
  const wid = +req.body?.warehouse_id;
  if (!wid) return res.status(400).json({ error: 'warehouse_id is required' });
  const d = String(req.body?.opening_date || '').trim();
  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
  const ex = getDb().prepare('SELECT id FROM warehouses WHERE id=?').get(wid);
  if (!ex) return res.status(404).json({ error: 'Warehouse not found' });
  getDb().prepare('UPDATE warehouses SET opening_date=? WHERE id=?').run(d || null, wid);
  res.json({ warehouse_id: wid, opening_date: d || null });
});

// ---------- WAREHOUSES ----------

router.get('/warehouses', requirePermission('inventory', 'view'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT w.*, s.name as site_name,
            (SELECT COUNT(*) FROM stock_balance sb WHERE sb.warehouse_id = w.id AND sb.quantity > 0) as item_count,
            (SELECT COALESCE(SUM(sb.quantity * (CASE WHEN sb.avg_rate > 0 THEN sb.avg_rate
                                                      ELSE COALESCE(im.current_price, 0) END)), 0)
               FROM stock_balance sb
               LEFT JOIN item_master im ON im.id = sb.item_master_id
              WHERE sb.warehouse_id = w.id) as total_value
       FROM warehouses w
       LEFT JOIN sites s ON s.id = w.site_id
      ORDER BY w.type='office' DESC, w.name`
  ).all();
  res.json(rows);
});

router.post('/warehouses', requirePermission('inventory', 'create'), (req, res) => {
  const { name, type, site_id, location, in_charge } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const t = type === 'site_store' ? 'site_store' : 'office';
  if (t === 'site_store' && !site_id) return res.status(400).json({ error: 'site_id required for site_store' });
  try {
    const r = getDb().prepare(
      `INSERT INTO warehouses (name, type, site_id, location, in_charge) VALUES (?,?,?,?,?)`
    ).run(name.trim(), t, t === 'site_store' ? +site_id : null, location || null, in_charge || null);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/warehouses/:id', requirePermission('inventory', 'edit'), (req, res) => {
  const { name, location, in_charge, active } = req.body || {};
  getDb().prepare(
    `UPDATE warehouses SET name=COALESCE(?,name), location=COALESCE(?,location),
       in_charge=COALESCE(?,in_charge), active=COALESCE(?,active)
     WHERE id=?`
  ).run(name || null, location ?? null, in_charge ?? null, active != null ? (active ? 1 : 0) : null, req.params.id);
  res.json({ message: 'Updated' });
});

// ---------- STOCK BALANCE ----------

router.get('/stock', requirePermission('inventory', 'view'), (req, res) => {
  const db = getDb();
  const { warehouse_id, search, low_only } = req.query;
  // Parens are REQUIRED — without them SQLite's OR/AND precedence makes
  // `quantity > 0 OR reorder_level > 0 AND search_match` evaluate as
  // `quantity > 0 OR (reorder_level > 0 AND search_match)` and every
  // row with stock comes back regardless of the search/warehouse
  // filters. Mam 2026-05-29: 'search item is not working'.
  const where = ['(sb.quantity > 0 OR sb.reorder_level > 0)'];
  const params = [];
  if (warehouse_id) { where.push('sb.warehouse_id = ?'); params.push(+warehouse_id); }
  if (search) {
    where.push('(im.item_name LIKE ? OR im.item_code LIKE ? OR im.specification LIKE ?)');
    const q = `%${search}%`; params.push(q, q, q);
  }
  if (low_only === '1') where.push('sb.quantity <= sb.reorder_level AND sb.reorder_level > 0');

  const rows = db.prepare(
    `SELECT sb.id, sb.warehouse_id, sb.item_master_id, sb.quantity, sb.avg_rate, sb.reorder_level, sb.updated_at,
            w.name as warehouse_name, w.type as warehouse_type,
            im.item_code, im.item_name, im.specification, im.size, im.uom, im.make, im.type as item_type,
            im.current_price as master_price,
            -- Condition (Used / Unused / Scrap). Prefer the explicit column on
            -- stock_balance (added 2026-05-29 so mam can edit inline); fall
            -- back to the last IN movement's item_condition for legacy rows
            -- where the column is still NULL.
            COALESCE(sb.condition,
              (SELECT sm.item_condition FROM stock_movements sm
                WHERE sm.warehouse_id = sb.warehouse_id
                  AND sm.item_master_id = sb.item_master_id
                  AND sm.type = 'IN'
                  AND sm.item_condition IS NOT NULL
                ORDER BY sm.created_at DESC LIMIT 1)) AS latest_condition
       FROM stock_balance sb
       JOIN warehouses w ON w.id = sb.warehouse_id
       JOIN item_master im ON im.id = sb.item_master_id
      WHERE ${where.join(' AND ')}
      ORDER BY w.type='office' DESC, w.name, im.item_name`
  ).all(...params);
  // Effective rate: avg_rate from movements if > 0, otherwise the
  // Item Master current_price so the Value column always reflects
  // something meaningful even when opening stock was entered with
  // no rate. Tag rate_source so the UI can show "from master" hint.
  res.json(rows.map(r => {
    const eff = (+r.avg_rate > 0) ? +r.avg_rate : (+r.master_price || 0);
    const src = (+r.avg_rate > 0) ? 'movements' : (+r.master_price > 0 ? 'master' : 'none');
    return { ...r, effective_rate: eff, rate_source: src, value: +(eff * (+r.quantity || 0)).toFixed(2) };
  }));
});

router.get('/summary', requirePermission('inventory', 'view'), (req, res) => {
  const db = getDb();
  // Total value uses moving-avg rate where available, else falls back
  // to item_master.current_price — same logic as /stock so the dashboard
  // and the table are consistent.
  const rows = db.prepare(
    `SELECT w.id, w.name, w.type, w.site_id,
            COUNT(CASE WHEN sb.quantity > 0 THEN 1 END) as items_in_stock,
            COALESCE(SUM(sb.quantity * (CASE WHEN sb.avg_rate > 0 THEN sb.avg_rate
                                              ELSE COALESCE(im.current_price, 0) END)), 0) as total_value,
            COUNT(CASE WHEN sb.reorder_level > 0 AND sb.quantity <= sb.reorder_level THEN 1 END) as low_stock_items
       FROM warehouses w
       LEFT JOIN stock_balance sb ON sb.warehouse_id = w.id
       LEFT JOIN item_master im ON im.id = sb.item_master_id
      WHERE w.active = 1
      GROUP BY w.id
      ORDER BY w.type='office' DESC, w.name`
  ).all();
  res.json(rows);
});

router.get('/low-stock', requirePermission('inventory', 'view'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT sb.*, w.name as warehouse_name, im.item_code, im.item_name, im.uom
       FROM stock_balance sb
       JOIN warehouses w ON w.id = sb.warehouse_id
       JOIN item_master im ON im.id = sb.item_master_id
      WHERE sb.reorder_level > 0 AND sb.quantity <= sb.reorder_level
      ORDER BY (sb.quantity / NULLIF(sb.reorder_level,0)) ASC`
  ).all();
  res.json(rows);
});

// Helper: apply ONE movement inside a transaction. Updates stock_balance
// using a moving average for IN, and a simple decrement for OUT.
// Throws if OUT would push qty below 0 (we don't allow negative stock).
function applyMovement(db, m) {
  const { warehouse_id, item_master_id, type, quantity, rate, reference_type, reference_id,
          from_warehouse_id, to_warehouse_id, site_id, notes, user_id, photo_url, item_condition } = m;
  const qty = Number(quantity);
  if (!warehouse_id || !item_master_id || !qty || qty <= 0) throw new Error('warehouse_id, item_master_id and positive quantity required');

  const cur = db.prepare('SELECT * FROM stock_balance WHERE warehouse_id=? AND item_master_id=?')
    .get(warehouse_id, item_master_id);
  let newQty, newAvgRate;
  if (type === 'IN') {
    const prevQty = cur ? +cur.quantity : 0;
    const prevRate = cur ? +cur.avg_rate : 0;
    newQty = prevQty + qty;
    // Weighted avg: (prevQty * prevRate + qty * inRate) / newQty
    const inRate = Number(rate) || 0;
    newAvgRate = newQty > 0 ? ((prevQty * prevRate) + (qty * inRate)) / newQty : 0;
  } else if (type === 'OUT') {
    const prevQty = cur ? +cur.quantity : 0;
    if (prevQty < qty) throw new Error(`Insufficient stock: have ${prevQty}, need ${qty}`);
    newQty = prevQty - qty;
    newAvgRate = cur ? +cur.avg_rate : 0;  // avg unchanged on OUT
  } else {
    throw new Error('type must be IN or OUT');
  }

  if (cur) {
    db.prepare('UPDATE stock_balance SET quantity=?, avg_rate=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(newQty, newAvgRate, cur.id);
  } else {
    db.prepare('INSERT INTO stock_balance (warehouse_id, item_master_id, quantity, avg_rate) VALUES (?,?,?,?)')
      .run(warehouse_id, item_master_id, newQty, newAvgRate);
  }

  const r = db.prepare(
    `INSERT INTO stock_movements
       (warehouse_id, item_master_id, type, quantity, rate, total_value,
        reference_type, reference_id, from_warehouse_id, to_warehouse_id, site_id, notes, created_by, photo_url, item_condition)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    warehouse_id, item_master_id, type, qty, rate || 0, qty * (rate || 0),
    reference_type || null, reference_id || null,
    from_warehouse_id || null, to_warehouse_id || null, site_id || null,
    notes || null, user_id || null, photo_url || null, item_condition || null,
  );
  return r.lastInsertRowid;
}

// ---------- RECEIVE (Stock IN) ----------
// Body: { warehouse_id, items: [{ item_master_id, quantity, rate }],
//         reference_type ('GRN'|'OPENING'|'PURCHASE'|'ADJUST'), reference_id, notes }

router.post('/receive', requirePermission('inventory', 'create'), (req, res) => {
  const db = getDb();
  const { warehouse_id, items, reference_type, reference_id, notes } = req.body || {};
  if (!warehouse_id) return res.status(400).json({ error: 'warehouse_id required' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item required' });

  const movementIds = [];
  try {
    db.transaction(() => {
      for (const it of items) {
        if (!it.item_master_id || !(+it.quantity > 0)) continue;
        const id = applyMovement(db, {
          warehouse_id: +warehouse_id, item_master_id: +it.item_master_id, type: 'IN',
          quantity: +it.quantity, rate: +(it.rate || 0),
          reference_type: reference_type || 'PURCHASE', reference_id: reference_id || null,
          notes, user_id: req.user.id,
          photo_url: it.photo_url || null,           // optional per-line photo (opening balance proof, etc.)
          item_condition: it.item_condition || null, // Used / Unused / Scrap — captured for OPENING entries
        });
        movementIds.push(id);
      }
    })();
    res.status(201).json({ message: 'Stock received', movement_ids: movementIds });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- ISSUE (Stock OUT — to site OR transfer to another warehouse) ----------
// Body: { from_warehouse_id, items: [{ item_master_id, quantity }],
//         destination_type ('site'|'warehouse'), destination_id, notes,
//         reference_type ('ISSUE'|'TRANSFER'|'ADJUST'), reference_id }

router.post('/issue', requirePermission('inventory', 'create'), (req, res) => {
  const db = getDb();
  const { from_warehouse_id, items, destination_type, destination_id, reference_type, reference_id, notes } = req.body || {};
  if (!from_warehouse_id) return res.status(400).json({ error: 'from_warehouse_id required' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item required' });
  const isTransfer = destination_type === 'warehouse';
  if (isTransfer && !destination_id) return res.status(400).json({ error: 'destination_id (warehouse) required for transfer' });
  if (isTransfer && +destination_id === +from_warehouse_id) return res.status(400).json({ error: 'Source and destination warehouse must differ' });

  // Single shared reference_id pairs the two halves of a transfer
  const sharedRef = reference_id || `XFR-${Date.now()}`;
  const refType = isTransfer ? 'TRANSFER' : (reference_type || 'ISSUE');

  const result = { out_ids: [], in_ids: [] };
  try {
    db.transaction(() => {
      for (const it of items) {
        if (!it.item_master_id || !(+it.quantity > 0)) continue;
        // Look up current avg rate so the transfer's IN side carries value
        const cur = db.prepare('SELECT avg_rate FROM stock_balance WHERE warehouse_id=? AND item_master_id=?')
          .get(+from_warehouse_id, +it.item_master_id);
        const rate = cur ? +cur.avg_rate : 0;

        const outId = applyMovement(db, {
          warehouse_id: +from_warehouse_id, item_master_id: +it.item_master_id, type: 'OUT',
          quantity: +it.quantity, rate,
          reference_type: refType, reference_id: sharedRef,
          to_warehouse_id: isTransfer ? +destination_id : null,
          site_id: !isTransfer && destination_type === 'site' ? +destination_id : null,
          notes, user_id: req.user.id,
        });
        result.out_ids.push(outId);

        if (isTransfer) {
          const inId = applyMovement(db, {
            warehouse_id: +destination_id, item_master_id: +it.item_master_id, type: 'IN',
            quantity: +it.quantity, rate,
            reference_type: refType, reference_id: sharedRef,
            from_warehouse_id: +from_warehouse_id,
            notes, user_id: req.user.id,
          });
          result.in_ids.push(inId);
        }
      }
    })();
    res.status(201).json({ message: isTransfer ? 'Stock transferred' : 'Stock issued', ...result, reference_id: sharedRef });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- MOVEMENTS HISTORY ----------

router.get('/movements', requirePermission('inventory', 'view'), (req, res) => {
  const db = getDb();
  const { warehouse_id, item_master_id, type, reference_type, date_from, date_to } = req.query;
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const where = [];
  const params = [];
  if (warehouse_id) { where.push('sm.warehouse_id = ?'); params.push(+warehouse_id); }
  if (item_master_id) { where.push('sm.item_master_id = ?'); params.push(+item_master_id); }
  if (type) { where.push('sm.type = ?'); params.push(type); }
  if (reference_type) { where.push('sm.reference_type = ?'); params.push(reference_type); }
  if (date_from) { where.push('sm.created_at >= ?'); params.push(date_from + ' 00:00:00'); }
  if (date_to) { where.push('sm.created_at <= ?'); params.push(date_to + ' 23:59:59'); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(
    `SELECT sm.*,
            w.name as warehouse_name,
            fw.name as from_warehouse_name,
            tw.name as to_warehouse_name,
            s.name  as site_name,
            im.item_code, im.item_name, im.uom,
            u.name as created_by_name
       FROM stock_movements sm
       JOIN warehouses w  ON w.id = sm.warehouse_id
       LEFT JOIN warehouses fw ON fw.id = sm.from_warehouse_id
       LEFT JOIN warehouses tw ON tw.id = sm.to_warehouse_id
       LEFT JOIN sites s  ON s.id  = sm.site_id
       JOIN item_master im ON im.id = sm.item_master_id
       LEFT JOIN users u ON u.id = sm.created_by
      ${whereSql}
      ORDER BY sm.created_at DESC, sm.id DESC
      LIMIT ?`
  ).all(...params, limit);
  res.json(rows);
});

// ---------- REORDER LEVEL (small helper) ----------
router.put('/reorder/:warehouse_id/:item_master_id', requirePermission('inventory', 'edit'), (req, res) => {
  const lvl = +(req.body?.reorder_level || 0);
  const db = getDb();
  // Upsert the row so reorder can be set even before any stock arrives
  const cur = db.prepare('SELECT id FROM stock_balance WHERE warehouse_id=? AND item_master_id=?')
    .get(+req.params.warehouse_id, +req.params.item_master_id);
  if (cur) {
    db.prepare('UPDATE stock_balance SET reorder_level=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(lvl, cur.id);
  } else {
    db.prepare('INSERT INTO stock_balance (warehouse_id, item_master_id, quantity, reorder_level) VALUES (?,?,0,?)')
      .run(+req.params.warehouse_id, +req.params.item_master_id, lvl);
  }
  res.json({ message: 'Reorder level set' });
});

// ---------- EDIT STOCK ROW (quantity / avg_rate adjustment) ----------
// Edits the on-hand qty or avg rate for one (warehouse × item).
// Records an ADJUST movement (IN if qty went up, OUT if down) so the
// audit trail stays consistent. If only rate changed, updates the
// avg_rate on stock_balance and writes a zero-qty IN ADJUST entry as
// a paper trail (rate=newRate, qty=0 is illegal in applyMovement,
// so we skip the movement when qty is unchanged).
router.patch('/stock/:id', requirePermission('inventory', 'edit'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const newQty = req.body?.quantity != null ? +req.body.quantity : null;
  const newRate = req.body?.avg_rate != null ? +req.body.avg_rate : null;
  const newCondition = req.body?.condition !== undefined ? req.body.condition : null;
  const notes = req.body?.notes || 'Manual stock adjustment';
  if (newQty == null && newRate == null && newCondition === null) {
    return res.status(400).json({ error: 'quantity, avg_rate or condition required' });
  }
  if (newQty != null && newQty < 0) return res.status(400).json({ error: 'Quantity cannot be negative' });
  if (newRate != null && newRate < 0) return res.status(400).json({ error: 'Rate cannot be negative' });
  const VALID_CONDITIONS = ['Used', 'Unused', 'Scrap', null, ''];
  if (newCondition !== null && !VALID_CONDITIONS.includes(newCondition)) {
    return res.status(400).json({ error: 'condition must be Used, Unused, or Scrap' });
  }

  const sb = db.prepare('SELECT * FROM stock_balance WHERE id=?').get(id);
  if (!sb) return res.status(404).json({ error: 'Stock row not found' });
  // Condition-only edit (no qty / rate change) is the most common path
  // for mam — handle it inline and skip the qty-movement bookkeeping.
  if (newQty == null && newRate == null && newCondition !== null) {
    db.prepare('UPDATE stock_balance SET condition=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(newCondition || null, id);
    return res.json({ message: 'Condition updated', condition: newCondition || null });
  }
  // For combined qty/rate + condition edits, write the condition first so
  // the transactional block below doesn't need to know about it.
  if (newCondition !== null) {
    db.prepare('UPDATE stock_balance SET condition=? WHERE id=?').run(newCondition || null, id);
  }

  try {
    db.transaction(() => {
      const finalQty = newQty != null ? newQty : +sb.quantity;
      const finalRate = newRate != null ? newRate : +sb.avg_rate;
      const delta = finalQty - (+sb.quantity);

      db.prepare('UPDATE stock_balance SET quantity=?, avg_rate=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(finalQty, finalRate, id);

      // Record a movement only when qty actually changed (CHECK constraint
      // allows IN/OUT only — zero-qty rows would violate quantity > 0 invariant
      // we want to maintain in the journal).
      if (Math.abs(delta) > 1e-9) {
        const moveType = delta > 0 ? 'IN' : 'OUT';
        const moveQty = Math.abs(delta);
        db.prepare(`INSERT INTO stock_movements
          (warehouse_id, item_master_id, type, quantity, rate, total_value, reference_type, notes, created_by)
          VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(sb.warehouse_id, sb.item_master_id, moveType, moveQty, finalRate, moveQty * finalRate,
               'ADJUST', notes, req.user.id);
      }
    })();
    res.json({ message: 'Stock updated' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- DELETE STOCK ROW ----------
// Zero out a stock_balance row and record a final OUT ADJUST movement
// for the audit trail. The balance row is then physically removed.
router.delete('/stock/:id', requirePermission('inventory', 'delete'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const sb = db.prepare('SELECT * FROM stock_balance WHERE id=?').get(id);
  if (!sb) return res.status(404).json({ error: 'Stock row not found' });

  try {
    db.transaction(() => {
      // Audit-trail OUT for the full remaining qty (skip if already zero)
      if (+sb.quantity > 0) {
        db.prepare(`INSERT INTO stock_movements
          (warehouse_id, item_master_id, type, quantity, rate, total_value, reference_type, notes, created_by)
          VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(sb.warehouse_id, sb.item_master_id, 'OUT', +sb.quantity, +sb.avg_rate,
               (+sb.quantity) * (+sb.avg_rate), 'ADJUST',
               req.body?.notes || 'Stock row deleted by user', req.user.id);
      }
      db.prepare('DELETE FROM stock_balance WHERE id=?').run(id);
    })();
    res.json({ message: 'Stock row deleted' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
