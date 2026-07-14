// Salon Commissions + dashboard stats — computed on read from live sales.
const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const M = 'salon_commissions';

// Commission report — grouped by stylist over a date range.
router.get('/', requirePermission(M, 'view'), (req, res) => {
  const { from, to, stylist_id } = req.query;
  const db = getDb();
  let sql = `
    SELECT st.id AS stylist_id, st.name AS stylist_name, st.commission_pct,
           COUNT(i.id) AS line_count,
           COALESCE(SUM(i.line_total),0) AS revenue,
           COALESCE(SUM(i.commission_amount),0) AS commission
    FROM pos_sale_items i
    JOIN pos_sales p ON p.id = i.sale_id
    JOIN stylists st ON st.id = i.stylist_id
    WHERE i.stylist_id IS NOT NULL AND p.status='paid'`;
  const pa = [];
  if (from) { sql += ' AND date(p.created_at)>=?'; pa.push(from); }
  if (to) { sql += ' AND date(p.created_at)<=?'; pa.push(to); }
  if (stylist_id) { sql += ' AND i.stylist_id=?'; pa.push(stylist_id); }
  sql += ' GROUP BY st.id ORDER BY commission DESC';
  const rows = db.prepare(sql).all(...pa);
  const totals = rows.reduce((a, r) => ({
    revenue: a.revenue + r.revenue, commission: a.commission + r.commission, lines: a.lines + r.line_count,
  }), { revenue: 0, commission: 0, lines: 0 });
  res.json({ rows, totals });
});

// Per-stylist line detail
router.get('/:stylistId/detail', requirePermission(M, 'view'), (req, res) => {
  const { from, to } = req.query;
  const db = getDb();
  let sql = `
    SELECT i.*, p.invoice_no, p.created_at, c.name AS client_name
    FROM pos_sale_items i
    JOIN pos_sales p ON p.id = i.sale_id
    LEFT JOIN salon_clients c ON c.id = p.client_id
    WHERE i.stylist_id=? AND p.status='paid'`;
  const pa = [req.params.stylistId];
  if (from) { sql += ' AND date(p.created_at)>=?'; pa.push(from); }
  if (to) { sql += ' AND date(p.created_at)<=?'; pa.push(to); }
  sql += ' ORDER BY p.created_at DESC LIMIT 500';
  res.json(db.prepare(sql).all(...pa));
});

// Salon dashboard KPI tiles
router.get('/dashboard/stats', requirePermission(M, 'view'), (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';
  const one = (sql, ...p) => (db.prepare(sql).get(...p) || {});
  res.json({
    today: {
      appointments: one("SELECT COUNT(*) c FROM appointments WHERE appt_date=?", today).c || 0,
      sales: one("SELECT COALESCE(SUM(total),0) v, COUNT(*) c FROM pos_sales WHERE date(created_at)=? AND status='paid'", today),
    },
    month: {
      revenue: one("SELECT COALESCE(SUM(total),0) v FROM pos_sales WHERE date(created_at)>=? AND status='paid'", monthStart).v || 0,
      bills: one("SELECT COUNT(*) c FROM pos_sales WHERE date(created_at)>=? AND status='paid'", monthStart).c || 0,
      commission: one("SELECT COALESCE(SUM(i.commission_amount),0) v FROM pos_sale_items i JOIN pos_sales p ON p.id=i.sale_id WHERE date(p.created_at)>=? AND p.status='paid'", monthStart).v || 0,
    },
    clients: one("SELECT COUNT(*) c FROM salon_clients").c || 0,
    active_memberships: one("SELECT COUNT(*) c FROM client_memberships WHERE status='active' AND (end_date IS NULL OR end_date>=date('now'))").c || 0,
    upcoming: db.prepare(
      `SELECT a.id, a.appt_no, a.appt_date, a.start_time, a.status, c.name AS client_name, st.name AS stylist_name
       FROM appointments a LEFT JOIN salon_clients c ON c.id=a.client_id LEFT JOIN stylists st ON st.id=a.stylist_id
       WHERE a.appt_date>=? AND a.status IN ('booked','confirmed') ORDER BY a.appt_date, a.start_time LIMIT 10`
    ).all(today),
    top_services: db.prepare(
      `SELECT name, COUNT(*) c, COALESCE(SUM(line_total),0) revenue FROM pos_sale_items
       WHERE item_type='service' AND name<>'' GROUP BY name ORDER BY c DESC LIMIT 5`
    ).all(),
  });
});

module.exports = router;
