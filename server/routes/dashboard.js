const express = require('express');
const pg = require('../db/pg');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const stats = {
      leads: {
        total: (await pg.get('SELECT COUNT(*) as c FROM leads')).c,
        new: (await pg.get("SELECT COUNT(*) as c FROM leads WHERE status='new'")).c,
        qualified: (await pg.get("SELECT COUNT(*) as c FROM leads WHERE status='qualified'")).c,
        won: (await pg.get("SELECT COUNT(*) as c FROM leads WHERE status='won'")).c,
      },
      orders: {
        total: (await pg.get('SELECT COUNT(*) as c FROM purchase_orders')).c,
        totalValue: (await pg.get('SELECT COALESCE(SUM(total_amount),0) as s FROM purchase_orders')).s,
        inProgress: (await pg.get("SELECT COUNT(*) as c FROM purchase_orders WHERE status='in_progress'")).c,
      },
      installations: {
        total: (await pg.get('SELECT COUNT(*) as c FROM installations')).c,
        pending: (await pg.get("SELECT COUNT(*) as c FROM installations WHERE status='pending'")).c,
        inProgress: (await pg.get("SELECT COUNT(*) as c FROM installations WHERE status='in_progress'")).c,
        completed: (await pg.get("SELECT COUNT(*) as c FROM installations WHERE status='completed'")).c,
      },
      complaints: {
        open: (await pg.get("SELECT COUNT(*) as c FROM complaints WHERE status='open'")).c,
        inProgress: (await pg.get("SELECT COUNT(*) as c FROM complaints WHERE status='in_progress'")).c,
      },
      hr: {
        employees: (await pg.get("SELECT COUNT(*) as c FROM employees WHERE status='active'")).c,
        candidates: (await pg.get('SELECT COUNT(*) as c FROM candidates')).c,
        subContractors: (await pg.get("SELECT COUNT(*) as c FROM sub_contractors WHERE status='active'")).c,
      },
      expenses: {
        pending: (await pg.get("SELECT COALESCE(SUM(amount),0) as s FROM expenses WHERE status='pending'")).s,
        approved: (await pg.get("SELECT COALESCE(SUM(amount),0) as s FROM expenses WHERE status='approved'")).s,
      },
      recentLeads: await pg.all('SELECT id, company_name, status, created_at FROM leads ORDER BY created_at DESC LIMIT 5'),
      recentOrders: await pg.all('SELECT id, po_number, total_amount, status FROM purchase_orders ORDER BY created_at DESC LIMIT 5'),
      recentComplaints: await pg.all('SELECT id, complaint_number, description, status, priority FROM complaints ORDER BY created_at DESC LIMIT 5'),
    };
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
