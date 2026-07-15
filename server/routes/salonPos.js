// Salon POS / Billing — the invoice engine.
//
// Creating a sale, in one transaction:
//   - snapshots each line's stylist commission %
//   - applies an active membership discount (or a manual discount)
//   - redeems loyalty points (₹ value from salon_settings.point_value)
//   - accrues new loyalty points (points_per_currency × net)
//   - rolls up the client's total_visits / total_spent / last_visit
//   - marks a linked appointment completed
const express = require('express');
const { getDb } = require('../db/schema');
const { nextSequence } = require('../db/nextSequence');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const M = 'salon_pos';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

router.get('/', requirePermission(M, 'view'), (req, res) => {
  const { from, to, client_id, payment_mode } = req.query;
  let sql = `SELECT p.*, c.name AS client_name, c.phone AS client_phone
             FROM pos_sales p LEFT JOIN salon_clients c ON c.id = p.client_id WHERE 1=1`;
  const pa = [];
  if (from) { sql += ' AND date(p.created_at)>=?'; pa.push(from); }
  if (to) { sql += ' AND date(p.created_at)<=?'; pa.push(to); }
  if (client_id) { sql += ' AND p.client_id=?'; pa.push(client_id); }
  if (payment_mode) { sql += ' AND p.payment_mode=?'; pa.push(payment_mode); }
  sql += ' ORDER BY p.created_at DESC LIMIT 500';
  res.json(getDb().prepare(sql).all(...pa));
});

router.get('/settings', requirePermission(M, 'view'), (req, res) => {
  res.json(getDb().prepare('SELECT * FROM salon_settings WHERE id=1').get() || {});
});
router.put('/settings', requirePermission(M, 'edit'), (req, res) => {
  const b = req.body || {};
  getDb().prepare(
    'UPDATE salon_settings SET salon_name=?, currency=?, default_tax_pct=?, points_per_currency=?, point_value=?, updated_at=CURRENT_TIMESTAMP WHERE id=1'
  ).run(b.salon_name || 'Headmasters Ludhiana', b.currency || '₹', b.default_tax_pct || 0, b.points_per_currency || 0, b.point_value || 1);
  res.json({ message: 'Updated' });
});

router.get('/:id', requirePermission(M, 'view'), (req, res) => {
  const db = getDb();
  const sale = db.prepare(
    `SELECT p.*, c.name AS client_name, c.phone AS client_phone, c.client_code
     FROM pos_sales p LEFT JOIN salon_clients c ON c.id = p.client_id WHERE p.id=?`
  ).get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Not found' });
  sale.items = db.prepare(
    `SELECT i.*, st.name AS stylist_name FROM pos_sale_items i
     LEFT JOIN stylists st ON st.id = i.stylist_id WHERE i.sale_id=?`
  ).all(req.params.id);
  res.json(sale);
});

// Create a sale
router.post('/', requirePermission(M, 'create'), (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return res.status(400).json({ error: 'At least one line item required' });
  const db = getDb();
  const settings = db.prepare('SELECT * FROM salon_settings WHERE id=1').get() || { default_tax_pct: 0, points_per_currency: 0, point_value: 1 };

  // Snapshot stylist commission % once per stylist
  const styCache = {};
  const getSty = (id) => {
    if (id == null) return null;
    if (!(id in styCache)) styCache[id] = db.prepare('SELECT * FROM stylists WHERE id=?').get(id) || null;
    return styCache[id];
  };

  const lines = items.map(it => {
    const qty = Number(it.qty) || 1;
    const unit = Number(it.unit_price) || 0;
    const lineTotal = round2(qty * unit);
    const sty = getSty(it.stylist_id);
    const pct = sty ? Number(sty.commission_pct) || 0 : 0;
    return {
      item_type: it.item_type === 'product' ? 'product' : 'service',
      service_id: it.service_id || null,
      product_id: it.product_id || null,
      name: it.name || '',
      stylist_id: it.stylist_id || null,
      qty, unit_price: unit, line_total: lineTotal,
      commission_pct: pct,
      commission_amount: round2(lineTotal * pct / 100),
    };
  });

  // Validate retail stock before charging — don't let a sale oversell a product.
  for (const l of lines) {
    if (l.product_id) {
      const prod = db.prepare('SELECT name, stock_qty FROM salon_products WHERE id=?').get(l.product_id);
      if (prod && (prod.stock_qty ?? 0) < l.qty) {
        return res.status(400).json({ error: `Insufficient stock for "${prod.name}" — ${prod.stock_qty} left, ${l.qty} requested` });
      }
    }
  }

  const subtotal = round2(lines.reduce((s, l) => s + l.line_total, 0));

  // Membership discount (auto from active membership, or manual override)
  let discount = round2(b.discount || 0);
  let membershipId = b.client_membership_id || null;
  let discountReason = b.discount_reason || '';
  if (!discount && b.client_id) {
    const cm = db.prepare(
      "SELECT * FROM client_memberships WHERE client_id=? AND status='active' AND plan_type='membership' AND (end_date IS NULL OR end_date>=date('now')) ORDER BY discount_pct DESC LIMIT 1"
    ).get(b.client_id);
    if (cm && cm.discount_pct) {
      discount = round2(subtotal * cm.discount_pct / 100);
      membershipId = cm.id;
      discountReason = `${cm.plan_name} (${cm.discount_pct}% member discount)`;
    }
  }
  if (discount > subtotal) discount = subtotal;

  // Loyalty redemption
  let redeemPoints = Math.max(0, parseInt(b.redeem_points || 0, 10) || 0);
  const pointValue = Number(settings.point_value) || 1;
  let client = b.client_id ? db.prepare('SELECT * FROM salon_clients WHERE id=?').get(b.client_id) : null;
  if (client) redeemPoints = Math.min(redeemPoints, client.loyalty_points || 0);
  const netAfterDiscount = round2(subtotal - discount);
  let redeemValue = round2(redeemPoints * pointValue);
  if (redeemValue > netAfterDiscount) { redeemValue = netAfterDiscount; redeemPoints = Math.floor(redeemValue / pointValue); }

  const taxable = round2(netAfterDiscount - redeemValue);
  const taxPct = b.tax_pct != null ? Number(b.tax_pct) : Number(settings.default_tax_pct) || 0;
  const tax = round2(taxable * taxPct / 100);
  const total = round2(taxable + tax);
  const pointsEarned = client ? Math.round(netAfterDiscount * (Number(settings.points_per_currency) || 0)) : 0;

  const invoiceNo = nextSequence(db, 'pos_sales', 'invoice_no', 'INV-', { startFrom: 1000, pad: 5 });

  const tx = db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO pos_sales (invoice_no, client_id, appointment_id, client_membership_id, subtotal, discount, discount_reason, tax_pct, tax, total, payment_mode, points_earned, points_redeemed, status, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(invoiceNo, b.client_id || null, b.appointment_id || null, membershipId, subtotal, discount, discountReason,
          taxPct, tax, total, b.payment_mode || 'cash', pointsEarned, redeemPoints, b.status || 'paid', b.notes || '', req.user.id);
    const saleId = r.lastInsertRowid;
    const ins = db.prepare(
      'INSERT INTO pos_sale_items (sale_id, item_type, service_id, product_id, name, stylist_id, qty, unit_price, line_total, commission_pct, commission_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    );
    const deduct = db.prepare('UPDATE salon_products SET stock_qty = stock_qty - ?, updated_at=CURRENT_TIMESTAMP WHERE id=?');
    for (const l of lines) {
      ins.run(saleId, l.item_type, l.service_id, l.product_id, l.name, l.stylist_id, l.qty, l.unit_price, l.line_total, l.commission_pct, l.commission_amount);
      if (l.product_id) deduct.run(l.qty, l.product_id);   // auto-deduct retail stock
    }

    if (client) {
      let bal = client.loyalty_points || 0;
      if (redeemPoints > 0) {
        bal -= redeemPoints;
        db.prepare('INSERT INTO loyalty_ledger (client_id, delta, balance, reason, sale_id) VALUES (?,?,?,?,?)')
          .run(client.id, -redeemPoints, bal, `Redeemed on ${invoiceNo}`, saleId);
      }
      if (pointsEarned > 0) {
        bal += pointsEarned;
        db.prepare('INSERT INTO loyalty_ledger (client_id, delta, balance, reason, sale_id) VALUES (?,?,?,?,?)')
          .run(client.id, pointsEarned, bal, `Earned on ${invoiceNo}`, saleId);
      }
      db.prepare(
        'UPDATE salon_clients SET loyalty_points=?, total_visits=total_visits+1, total_spent=total_spent+?, last_visit=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?'
      ).run(bal, total, client.id);
    }

    if (b.appointment_id) {
      db.prepare("UPDATE appointments SET status='completed', sale_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(saleId, b.appointment_id);
    }
    return saleId;
  });

  const id = tx();
  res.status(201).json({ id, invoice_no: invoiceNo, subtotal, discount, tax, total, points_earned: pointsEarned, points_redeemed: redeemPoints });
});

router.delete('/:id', requirePermission(M, 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM pos_sales WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
