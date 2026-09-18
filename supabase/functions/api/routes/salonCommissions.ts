// deno-lint-ignore-file no-explicit-any
// Salon Commissions + dashboard stats — computed on read from live sales.
// Ported from server/routes/salonCommissions.js (Phase-3 Postgres version).
import { Router } from "../../_shared/express-lite.ts";
import pg from "../../_shared/pg.ts";
import { authMiddleware, requirePermission } from "../../_shared/auth.ts";
import {stylistScope,hasAllSalonAccess} from '../../_shared/salon-access.ts';
const router = Router();
router.use(authMiddleware);

const M = 'salon_commissions';

// Commission report — grouped by stylist over a date range.
router.get('/', requirePermission(M, 'view'), async (req, res) => {
  try {
    const { from, to, stylist_id } = req.query;
    let sql = `
      SELECT st.id AS stylist_id, st.name AS stylist_name, st.commission_pct,
             COUNT(i.id) AS line_count,
             COALESCE(SUM(i.line_total),0) AS revenue,
             COALESCE(SUM(i.commission_amount),0) AS commission
      FROM pos_sale_items i
      JOIN pos_sales p ON p.id = i.sale_id
      JOIN stylists st ON st.id = i.stylist_id
      WHERE i.stylist_id IS NOT NULL AND p.status='paid'`;
    sql += ` AND ${await stylistScope(req,M,'i.stylist_id')}`;
    const pa: any[] = [];
    if (from) { sql += " AND (p.created_at::timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date>=?"; pa.push(from); }
    if (to) { sql += " AND (p.created_at::timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date<=?"; pa.push(to); }
    if (stylist_id) { sql += ' AND i.stylist_id=?'; pa.push(stylist_id); }
    sql += ' GROUP BY st.id ORDER BY commission DESC';
    const rows = await pg.all(sql, ...pa);
    const totals = rows.reduce((a: any, r: any) => ({
      revenue: a.revenue + r.revenue, commission: a.commission + r.commission, lines: a.lines + r.line_count,
    }), { revenue: 0, commission: 0, lines: 0 });
    res.json({ rows, totals });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Per-stylist line detail
router.get('/:stylistId/detail', requirePermission(M, 'view'), async (req, res) => {
  try {
    const { from, to } = req.query;
    let sql = `
      SELECT i.*, p.invoice_no, p.created_at, c.name AS client_name
      FROM pos_sale_items i
      JOIN pos_sales p ON p.id = i.sale_id
      LEFT JOIN salon_clients c ON c.id = p.client_id
      WHERE i.stylist_id=? AND p.status='paid'`;
    sql += ` AND ${await stylistScope(req,M,'i.stylist_id')}`;
    const pa: any[] = [req.params.stylistId];
    if (from) { sql += " AND (p.created_at::timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date>=?"; pa.push(from); }
    if (to) { sql += " AND (p.created_at::timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date<=?"; pa.push(to); }
    sql += ' ORDER BY p.created_at DESC LIMIT 500';
    res.json(await pg.all(sql, ...pa));
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Salon dashboard KPI tiles
router.get('/dashboard/stats', requirePermission('dashboard', 'view'), async (req, res) => {
  try {
    if(!await hasAllSalonAccess(req,'dashboard'))return res.status(403).json({error:'Salon-wide dashboard permission required'});
    for(const module of ['salon_pos','salon_commissions','salon_clients','salon_appointments','salon_memberships','salon_services'])if(!await hasAllSalonAccess(req,module))return res.status(403).json({error:'The legacy salon-wide report requires all source-module permissions. Use your personal dashboard.'});
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 7) + '-01';
    const one = async (sql: string, ...p: any[]) => (await pg.get(sql, ...p)) || {};
    res.json({
      today: {
        appointments: (await one('SELECT COUNT(*)::int c FROM appointments WHERE appt_date=?', today)).c || 0,
        sales: await one("SELECT COALESCE(SUM(total),0) v, COUNT(*)::int c FROM pos_sales WHERE LEFT(created_at,10)=? AND status='paid'", today),
      },
      month: {
        revenue: (await one("SELECT COALESCE(SUM(total),0) v FROM pos_sales WHERE LEFT(created_at,10)>=? AND status='paid'", monthStart)).v || 0,
        bills: (await one("SELECT COUNT(*)::int c FROM pos_sales WHERE LEFT(created_at,10)>=? AND status='paid'", monthStart)).c || 0,
        commission: (await one("SELECT COALESCE(SUM(i.commission_amount),0) v FROM pos_sale_items i JOIN pos_sales p ON p.id=i.sale_id WHERE (p.created_at::timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date>=? AND p.status='paid'", monthStart)).v || 0,
      },
      clients: (await one('SELECT COUNT(*)::int c FROM salon_clients')).c || 0,
      active_memberships: (await one("SELECT COUNT(*)::int c FROM client_memberships WHERE status='active' AND (end_date IS NULL OR end_date>=?)", today)).c || 0,
      upcoming: await pg.all(
        `SELECT a.id, a.appt_no, a.appt_date, a.start_time, a.status, c.name AS client_name, st.name AS stylist_name
         FROM appointments a LEFT JOIN salon_clients c ON c.id=a.client_id LEFT JOIN stylists st ON st.id=a.stylist_id
         WHERE a.appt_date>=? AND a.status IN ('booked','confirmed') ORDER BY a.appt_date, a.start_time LIMIT 10`, today),
      top_services: await pg.all(
        `SELECT name, COUNT(*)::int c, COALESCE(SUM(line_total),0) revenue FROM pos_sale_items
         WHERE item_type='service' AND name<>'' GROUP BY name ORDER BY c DESC LIMIT 5`),
    });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

export default router;
