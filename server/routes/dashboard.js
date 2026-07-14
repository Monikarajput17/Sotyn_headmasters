const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

router.get('/', (req, res) => {
  const db = getDb();
  const stats = {
    leads: {
      total: db.prepare('SELECT COUNT(*) as c FROM leads').get().c,
      new: db.prepare("SELECT COUNT(*) as c FROM leads WHERE status='new'").get().c,
      qualified: db.prepare("SELECT COUNT(*) as c FROM leads WHERE status='qualified'").get().c,
      won: db.prepare("SELECT COUNT(*) as c FROM leads WHERE status='won'").get().c,
    },
    orders: {
      total: db.prepare('SELECT COUNT(*) as c FROM purchase_orders').get().c,
      totalValue: db.prepare('SELECT COALESCE(SUM(total_amount),0) as s FROM purchase_orders').get().s,
      inProgress: db.prepare("SELECT COUNT(*) as c FROM purchase_orders WHERE status='in_progress'").get().c,
    },
    installations: {
      total: db.prepare('SELECT COUNT(*) as c FROM installations').get().c,
      pending: db.prepare("SELECT COUNT(*) as c FROM installations WHERE status='pending'").get().c,
      inProgress: db.prepare("SELECT COUNT(*) as c FROM installations WHERE status='in_progress'").get().c,
      completed: db.prepare("SELECT COUNT(*) as c FROM installations WHERE status='completed'").get().c,
    },
    complaints: {
      open: db.prepare("SELECT COUNT(*) as c FROM complaints WHERE status='open'").get().c,
      inProgress: db.prepare("SELECT COUNT(*) as c FROM complaints WHERE status='in_progress'").get().c,
    },
    hr: {
      employees: db.prepare("SELECT COUNT(*) as c FROM employees WHERE status='active'").get().c,
      candidates: db.prepare('SELECT COUNT(*) as c FROM candidates').get().c,
      subContractors: db.prepare("SELECT COUNT(*) as c FROM sub_contractors WHERE status='active'").get().c,
    },
    expenses: {
      pending: db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM expenses WHERE status='pending'").get().s,
      approved: db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM expenses WHERE status='approved'").get().s,
    },
    recentLeads: db.prepare('SELECT id, company_name, status, created_at FROM leads ORDER BY created_at DESC LIMIT 5').all(),
    recentOrders: db.prepare('SELECT id, po_number, total_amount, status FROM purchase_orders ORDER BY created_at DESC LIMIT 5').all(),
    recentComplaints: db.prepare('SELECT id, complaint_number, description, status, priority FROM complaints ORDER BY created_at DESC LIMIT 5').all(),
  };
  res.json(stats);
});

module.exports = router;
