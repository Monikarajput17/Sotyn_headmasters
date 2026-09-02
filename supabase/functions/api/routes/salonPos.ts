// deno-lint-ignore-file no-explicit-any
// Salon POS / Billing — the invoice engine.
// Ported from server/routes/salonPos.js (Phase-3 Postgres version).
//
// Creating a sale, in one transaction:
//   - snapshots each line's stylist commission %
//   - applies an active membership discount (or a manual discount)
//   - redeems loyalty points (₹ value from salon_settings.point_value)
//   - accrues new loyalty points (points_per_currency × net)
//   - rolls up the client's total_visits / total_spent / last_visit
//   - marks a linked appointment completed
import { Router } from "../../_shared/express-lite.ts";
import pg from "../../_shared/pg.ts";
import { nextSequencePg } from "../../_shared/nextSequence.ts";
import { authMiddleware, requirePermission } from "../../_shared/auth.ts";
const router = Router();
router.use(authMiddleware);

const M = 'salon_pos';

const round2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;
const todayStr = () => new Date().toISOString().slice(0, 10);   // UTC, matches SQLite date('now')

router.get('/', requirePermission(M, 'view'), async (req, res) => {
  try {
    const { from, to, client_id, payment_mode } = req.query;
    let sql = `SELECT p.*, c.name AS client_name, c.phone AS client_phone
               FROM pos_sales p LEFT JOIN salon_clients c ON c.id = p.client_id WHERE 1=1`;
    const pa: any[] = [];
    if (from) { sql += ' AND LEFT(p.created_at,10)>=?'; pa.push(from); }
    if (to) { sql += ' AND LEFT(p.created_at,10)<=?'; pa.push(to); }
    if (client_id) { sql += ' AND p.client_id=?'; pa.push(client_id); }
    if (payment_mode) { sql += ' AND p.payment_mode=?'; pa.push(payment_mode); }
    sql += ' ORDER BY p.created_at DESC LIMIT 500';
    res.json(await pg.all(sql, ...pa));
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.get('/settings', requirePermission(M, 'view'), async (_req, res) => {
  try {
    res.json(await pg.get('SELECT * FROM salon_settings WHERE id=1') || {});
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});
router.put('/settings', requirePermission(M, 'edit'), async (req, res) => {
  try {
    const b = req.body || {};
    await pg.run(
      'UPDATE salon_settings SET salon_name=?, currency=?, default_tax_pct=?, points_per_currency=?, point_value=?, updated_at=CURRENT_TIMESTAMP WHERE id=1',
      b.salon_name || 'Headmasters Ludhiana', b.currency || '₹', b.default_tax_pct || 0, b.points_per_currency || 0, b.point_value || 1);
    res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.get('/:id', requirePermission(M, 'view'), async (req, res) => {
  try {
    const sale = await pg.get(
      `SELECT p.*, c.name AS client_name, c.phone AS client_phone, c.client_code
       FROM pos_sales p LEFT JOIN salon_clients c ON c.id = p.client_id WHERE p.id=?`, req.params.id);
    if (!sale) return res.status(404).json({ error: 'Not found' });
    sale.items = await pg.all(
      `SELECT i.*, st.name AS stylist_name FROM pos_sale_items i
       LEFT JOIN stylists st ON st.id = i.stylist_id WHERE i.sale_id=?`, req.params.id);
    res.json(sale);
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Create a sale
router.post('/', requirePermission(M, 'create'), async (req, res) => {
  try {
    const b = req.body || {};
    const items: any[] = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return res.status(400).json({ error: 'At least one line item required' });
    const settings = await pg.get('SELECT * FROM salon_settings WHERE id=1') || { default_tax_pct: 0, points_per_currency: 0, point_value: 1 };

    // Snapshot stylist commission % once per stylist
    const styCache: Record<string, any> = {};
    const getSty = async (id: any) => {
      if (id == null) return null;
      if (!(id in styCache)) styCache[id] = await pg.get('SELECT * FROM stylists WHERE id=?', id) || null;
      return styCache[id];
    };

    const lines: any[] = [];
    for (const it of items) {
      const qty = Number(it.qty) || 1;
      const unit = Number(it.unit_price) || 0;
      const lineTotal = round2(qty * unit);
      const sty = await getSty(it.stylist_id);
      const pct = sty ? Number(sty.commission_pct) || 0 : 0;
      lines.push({
        item_type: it.item_type === 'product' ? 'product' : 'service',
        service_id: it.service_id || null,
        product_id: it.product_id || null,
        name: it.name || '',
        stylist_id: it.stylist_id || null,
        qty, unit_price: unit, line_total: lineTotal,
        commission_pct: pct,
        commission_amount: round2(lineTotal * pct / 100),
      });
    }

    // Validate retail stock before charging — don't let a sale oversell a product.
    for (const l of lines) {
      if (l.product_id) {
        const prod = await pg.get('SELECT name, stock_qty FROM salon_products WHERE id=?', l.product_id);
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
      const cm = await pg.get(
        "SELECT * FROM client_memberships WHERE client_id=? AND status='active' AND plan_type='membership' AND (end_date IS NULL OR end_date>=?) ORDER BY discount_pct DESC LIMIT 1",
        b.client_id, todayStr());
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
    const client = b.client_id ? await pg.get('SELECT * FROM salon_clients WHERE id=?', b.client_id) : null;
    if (client) redeemPoints = Math.min(redeemPoints, client.loyalty_points || 0);
    const netAfterDiscount = round2(subtotal - discount);
    let redeemValue = round2(redeemPoints * pointValue);
    if (redeemValue > netAfterDiscount) { redeemValue = netAfterDiscount; redeemPoints = Math.floor(redeemValue / pointValue); }

    const taxable = round2(netAfterDiscount - redeemValue);
    const taxPct = b.tax_pct != null ? Number(b.tax_pct) : Number(settings.default_tax_pct) || 0;
    const tax = round2(taxable * taxPct / 100);
    const total = round2(taxable + tax);
    const pointsEarned = client ? Math.round(netAfterDiscount * (Number(settings.points_per_currency) || 0)) : 0;

    const { saleId, invoiceNo } = await pg.tx(async (t) => {
      const inv = await nextSequencePg(t, 'pos_sales', 'invoice_no', 'INV-', { startFrom: 1000, pad: 5 });
      const r = await t.run(
        `INSERT INTO pos_sales (invoice_no, client_id, appointment_id, client_membership_id, subtotal, discount, discount_reason, tax_pct, tax, total, payment_mode, points_earned, points_redeemed, status, notes, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        inv, b.client_id || null, b.appointment_id || null, membershipId, subtotal, discount, discountReason,
        taxPct, tax, total, b.payment_mode || 'cash', pointsEarned, redeemPoints, b.status || 'paid', b.notes || '', req.user.id);
      const sid = r.lastInsertRowid;
      for (const l of lines) {
        await t.run(
          'INSERT INTO pos_sale_items (sale_id, item_type, service_id, product_id, name, stylist_id, qty, unit_price, line_total, commission_pct, commission_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          sid, l.item_type, l.service_id, l.product_id, l.name, l.stylist_id, l.qty, l.unit_price, l.line_total, l.commission_pct, l.commission_amount);
        if (l.product_id) {
          await t.run('UPDATE salon_products SET stock_qty = stock_qty - ?, updated_at=CURRENT_TIMESTAMP WHERE id=?', l.qty, l.product_id);   // auto-deduct retail stock
        }
      }

      if (client) {
        let bal = client.loyalty_points || 0;
        if (redeemPoints > 0) {
          bal -= redeemPoints;
          await t.run('INSERT INTO loyalty_ledger (client_id, delta, balance, reason, sale_id) VALUES (?,?,?,?,?)',
            client.id, -redeemPoints, bal, `Redeemed on ${inv}`, sid);
        }
        if (pointsEarned > 0) {
          bal += pointsEarned;
          await t.run('INSERT INTO loyalty_ledger (client_id, delta, balance, reason, sale_id) VALUES (?,?,?,?,?)',
            client.id, pointsEarned, bal, `Earned on ${inv}`, sid);
        }
        await t.run(
          'UPDATE salon_clients SET loyalty_points=?, total_visits=total_visits+1, total_spent=total_spent+?, last_visit=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?',
          bal, total, client.id);
      }

      if (b.appointment_id) {
        await t.run("UPDATE appointments SET status='completed', sale_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", sid, b.appointment_id);
      }
      return { saleId: sid, invoiceNo: inv };
    });

    res.status(201).json({ id: saleId, invoice_no: invoiceNo, subtotal, discount, tax, total, points_earned: pointsEarned, points_redeemed: redeemPoints });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.delete('/:id', requirePermission(M, 'delete'), async (req, res) => {
  try {
    await pg.run('DELETE FROM pos_sales WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

export default router;
