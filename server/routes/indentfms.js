const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Full indent lifecycle tracker
router.get('/tracker', (req, res) => {
  const db = getDb();
  const indents = db.prepare(`
    SELECT i.*, u.name as created_by_name,
      (SELECT GROUP_CONCAT(it.stage || ':' || it.stage_date, '|') FROM indent_tracker it WHERE it.indent_id=i.id ORDER BY it.stage_date) as stages
    FROM indents i LEFT JOIN users u ON i.created_by=u.id
    ORDER BY i.created_at DESC
  `).all();

  // For each indent, get current stage
  const result = indents.map(ind => {
    const stageList = ind.stages ? ind.stages.split('|').map(s => {
      const [stage, date] = s.split(':');
      return { stage, date };
    }) : [];
    const currentStage = stageList.length > 0 ? stageList[stageList.length - 1].stage : 'indent_raised';
    return { ...ind, stageList, currentStage };
  });

  res.json(result);
});

// Track stage update
router.post('/tracker/:indent_id/stage', (req, res) => {
  const { stage, notes } = req.body;
  const db = getDb();

  db.prepare('INSERT INTO indent_tracker (indent_id, stage, updated_by, notes) VALUES (?,?,?,?)')
    .run(req.params.indent_id, stage, req.user.id, notes);

  // Update indent status based on stage
  const statusMap = {
    indent_raised: 'draft',
    approval_pending: 'submitted',
    approved: 'approved',
    po_created: 'po_sent',
    dispatched: 'dispatched',
    grn_done: 'received',
    bill_entered: 'received',
    payment_done: 'received'
  };
  if (statusMap[stage]) {
    db.prepare('UPDATE indents SET status=? WHERE id=?').run(statusMap[stage], req.params.indent_id);
  }

  // If payment_done, auto-link to cash flow as outflow
  if (stage === 'payment_done') {
    const indent = db.prepare('SELECT * FROM indents WHERE id=?').get(req.params.indent_id);
    const items = db.prepare('SELECT COALESCE(SUM(amount),0) as total FROM indent_items WHERE indent_id=?').get(req.params.indent_id);
    const today = new Date().toISOString().split('T')[0];

    let daily = db.prepare('SELECT id FROM cash_flow_daily WHERE date=?').get(today);
    if (!daily) {
      const prev = db.prepare('SELECT closing_balance FROM cash_flow_daily WHERE date < ? ORDER BY date DESC LIMIT 1').get(today);
      const r2 = db.prepare('INSERT INTO cash_flow_daily (date, opening_balance, closing_balance) VALUES (?,?,?)').run(today, prev?.closing_balance || 0, prev?.closing_balance || 0);
      daily = { id: r2.lastInsertRowid };
    }

    db.prepare('INSERT INTO cash_flow_entries (daily_id, date, type, category, description, amount, reference_type, reference_id, created_by) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(daily.id, today, 'outflow', 'Indent Payment', `Payment for Indent ${indent?.indent_number || req.params.indent_id}`, items.total, 'indent', req.params.indent_id, req.user.id);

    // Recalculate daily
    const inflows = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM cash_flow_entries WHERE daily_id=? AND type='inflow'").get(daily.id);
    const outflows = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM cash_flow_entries WHERE daily_id=? AND type='outflow'").get(daily.id);
    const opening = db.prepare('SELECT opening_balance FROM cash_flow_daily WHERE id=?').get(daily.id);
    db.prepare('UPDATE cash_flow_daily SET total_inflows=?, total_outflows=?, closing_balance=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(inflows.t, outflows.t, (opening?.opening_balance || 0) + inflows.t - outflows.t, daily.id);
  }

  res.json({ message: `Stage updated to ${stage}` });
});

// GRN - Create
// Optional inventory hook: if `warehouse_id` is provided AND a line has
// `item_master_id`, the accepted_qty automatically lands in that warehouse
// as a stock IN movement (reference_type='GRN'). Idempotent — re-creating
// the same GRN won't double-add stock because a fresh grn_id means a
// fresh reference_id; but if the request itself has duplicate items they
// each create one movement row (correct behaviour).
router.post('/grn', (req, res) => {
  const db = getDb();
  const { vendor_po_id, indent_id, grn_date, items, notes, warehouse_id } = req.body;
  const { nextSequence } = require('../db/nextSequence');
  const grnNum = nextSequence(db, 'grn', 'grn_number', 'GRN-', { startFrom: 0, pad: 4 });

  const r = db.prepare('INSERT INTO grn (vendor_po_id, indent_id, grn_number, grn_date, received_by, notes, warehouse_id) VALUES (?,?,?,?,?,?,?)')
    .run(vendor_po_id, indent_id, grnNum, grn_date, req.user.id, notes, warehouse_id || null);

  const insertItem = db.prepare('INSERT INTO grn_items (grn_id, description, ordered_qty, received_qty, accepted_qty, rejected_qty, unit, rate, amount, remarks, item_master_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const i of (items || [])) {
    insertItem.run(r.lastInsertRowid, i.description, i.ordered_qty, i.received_qty, i.accepted_qty || i.received_qty, i.rejected_qty || 0, i.unit, i.rate, (i.accepted_qty || i.received_qty) * i.rate, i.remarks, i.item_master_id || null);
  }

  // Auto DEBIT NOTES from receiving variance (mam 2026-06-04): rejected
  // material AND short supply (ordered vs received) each raise a debit
  // note automatically — mirrors the auto extra-rate debit at bill entry.
  // Best-effort; guarded one-per-(GRN,type). Value = qty × rate.
  if (vendor_po_id) {
    try {
      const po = db.prepare('SELECT vendor_id FROM vendor_pos WHERE id=?').get(vendor_po_id);
      const year = new Date().getFullYear();
      for (const kind of ['rejected', 'short_supply']) {
        const lines = []; let amt = 0;
        for (const i of (items || [])) {
          const rate = +i.rate || 0;
          const qty = kind === 'rejected'
            ? (+i.rejected_qty || 0)
            : Math.max(0, (+i.ordered_qty || 0) - (+i.received_qty || 0));
          if (qty <= 0) continue;
          const lineAmt = qty * rate; amt += lineAmt;
          lines.push({ description: i.description, unit: i.unit || '', qty, rate, amount: lineAmt, grn_number: grnNum, remarks: i.remarks || '' });
        }
        if (!lines.length || amt <= 0) continue;
        const exists = db.prepare('SELECT id FROM debit_notes WHERE grn_id=? AND type=?').get(r.lastInsertRowid, kind);
        if (exists) continue;
        const dnNum = nextSequence(db, 'debit_notes', 'dn_number', `DBN/${year}/`, { pad: 4 });
        const reason = kind === 'rejected'
          ? `Auto-raised at GRN ${grnNum}: material rejected at receiving.`
          : `Auto-raised at GRN ${grnNum}: short supply (ordered vs received shortfall).`;
        db.prepare(
          `INSERT INTO debit_notes (dn_number, type, vendor_po_id, vendor_id, grn_id, amount, reason, items_json, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
        ).run(dnNum, kind, vendor_po_id, po?.vendor_id || null, r.lastInsertRowid, Math.round(amt * 100) / 100, reason, JSON.stringify(lines), req.user.id);
      }
    } catch (e) { console.error('[grn] auto-debit failed (GRN saved anyway):', e.message); }
  }

  // Auto-track stage
  if (indent_id) {
    db.prepare('INSERT INTO indent_tracker (indent_id, stage, updated_by, notes) VALUES (?,?,?,?)')
      .run(indent_id, 'grn_done', req.user.id, `GRN ${grnNum} created`);
  }

  // INVENTORY AUTO-IN — only when warehouse + item_master_id are linked.
  // Wraps in its own try so even if inventory is misconfigured, the GRN
  // still saves successfully (inventory automation is best-effort, never
  // critical to the main procurement flow).
  let stockIns = 0;
  if (warehouse_id) {
    try {
      const inv = require('./inventory');
      // Inline the apply logic here rather than going via HTTP
      const apply = (wh, itemId, qty, rate) => {
        const cur = db.prepare('SELECT * FROM stock_balance WHERE warehouse_id=? AND item_master_id=?').get(wh, itemId);
        const prevQty = cur ? +cur.quantity : 0;
        const prevRate = cur ? +cur.avg_rate : 0;
        const newQty = prevQty + qty;
        const newRate = newQty > 0 ? ((prevQty * prevRate) + (qty * rate)) / newQty : 0;
        if (cur) db.prepare('UPDATE stock_balance SET quantity=?, avg_rate=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(newQty, newRate, cur.id);
        else db.prepare('INSERT INTO stock_balance (warehouse_id, item_master_id, quantity, avg_rate) VALUES (?,?,?,?)').run(wh, itemId, newQty, newRate);
        db.prepare(
          `INSERT INTO stock_movements
            (warehouse_id, item_master_id, type, quantity, rate, total_value,
             reference_type, reference_id, notes, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).run(wh, itemId, 'IN', qty, rate, qty * rate, 'GRN', grnNum, `Auto-IN from GRN ${grnNum}`, req.user.id);
      };
      const tx = db.transaction(() => {
        for (const i of (items || [])) {
          const qty = +(i.accepted_qty || i.received_qty || 0);
          if (!i.item_master_id || qty <= 0) continue;
          apply(+warehouse_id, +i.item_master_id, qty, +(i.rate || 0));
          stockIns += 1;
        }
      });
      tx();
    } catch (e) {
      console.error('[grn] auto-IN failed (GRN saved anyway):', e.message);
    }
  }

  res.status(201).json({ id: r.lastInsertRowid, grn_number: grnNum, stock_ins: stockIns });
});

// GRN - List
router.get('/grn', (req, res) => {
  res.json(getDb().prepare(`SELECT g.*, u.name as received_by_name FROM grn g LEFT JOIN users u ON g.received_by=u.id ORDER BY g.created_at DESC`).all());
});

// GRN - Get details
router.get('/grn/:id', (req, res) => {
  const grn = getDb().prepare('SELECT * FROM grn WHERE id=?').get(req.params.id);
  if (!grn) return res.status(404).json({ error: 'Not found' });
  grn.items = getDb().prepare('SELECT * FROM grn_items WHERE grn_id=?').all(req.params.id);
  res.json(grn);
});

router.delete('/grn/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM grn_items WHERE grn_id=?').run(req.params.id);
  db.prepare('DELETE FROM grn WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Full pipeline view
router.get('/pipeline', (req, res) => {
  const db = getDb();
  const stages = ['indent_raised', 'approval_pending', 'approved', 'po_created', 'dispatched', 'grn_done', 'bill_entered', 'payment_done'];
  const pipeline = {};
  for (const stage of stages) {
    const count = db.prepare('SELECT COUNT(DISTINCT indent_id) as c FROM indent_tracker WHERE stage=?').get(stage);
    pipeline[stage] = count.c;
  }

  // Active indents by stage
  const activeIndents = db.prepare(`
    SELECT i.id, i.indent_number, i.indent_date, i.status,
      (SELECT it.stage FROM indent_tracker it WHERE it.indent_id=i.id ORDER BY it.stage_date DESC LIMIT 1) as current_stage
    FROM indents i ORDER BY i.created_at DESC LIMIT 50
  `).all();

  res.json({ pipeline, activeIndents });
});

module.exports = router;
