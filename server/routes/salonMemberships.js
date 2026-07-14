// Salon Memberships & Packages — plans + assigning them to clients.
const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const M = 'salon_memberships';

// ─── Plans ───────────────────────────────────────────────────────────
router.get('/plans', requirePermission(M, 'view'), (req, res) => {
  res.json(getDb().prepare('SELECT * FROM membership_plans ORDER BY plan_type, price').all());
});
router.post('/plans', requirePermission(M, 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'Plan name required' });
  const servicesJson = b.services ? JSON.stringify(b.services) : (b.services_json || null);
  const r = getDb().prepare(
    'INSERT INTO membership_plans (name, plan_type, price, validity_days, discount_pct, services_json, description, active) VALUES (?,?,?,?,?,?,?,?)'
  ).run(b.name.trim(), b.plan_type || 'membership', b.price || 0, b.validity_days || 365, b.discount_pct || 0, servicesJson, b.description || '', b.active === 0 ? 0 : 1);
  res.status(201).json({ id: r.lastInsertRowid });
});
router.put('/plans/:id', requirePermission(M, 'edit'), (req, res) => {
  const b = req.body || {};
  const servicesJson = b.services ? JSON.stringify(b.services) : (b.services_json || null);
  getDb().prepare(
    'UPDATE membership_plans SET name=?, plan_type=?, price=?, validity_days=?, discount_pct=?, services_json=?, description=?, active=? WHERE id=?'
  ).run(b.name || '', b.plan_type || 'membership', b.price || 0, b.validity_days || 365, b.discount_pct || 0, servicesJson, b.description || '', b.active === 0 ? 0 : 1, req.params.id);
  res.json({ message: 'Updated' });
});
router.delete('/plans/:id', requirePermission(M, 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM membership_plans WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ─── Client memberships (sold to a client) ──────────────────────────
router.get('/client-memberships', requirePermission(M, 'view'), (req, res) => {
  const { client_id, status } = req.query;
  let sql = `SELECT cm.*, c.name AS client_name, c.phone AS client_phone
             FROM client_memberships cm LEFT JOIN salon_clients c ON c.id = cm.client_id WHERE 1=1`;
  const p = [];
  if (client_id) { sql += ' AND cm.client_id=?'; p.push(client_id); }
  if (status) { sql += ' AND cm.status=?'; p.push(status); }
  sql += ' ORDER BY cm.created_at DESC';
  res.json(getDb().prepare(sql).all(...p));
});

// Assign / sell a plan to a client
router.post('/client-memberships', requirePermission(M, 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.client_id || !b.plan_id) return res.status(400).json({ error: 'Client and plan required' });
  const db = getDb();
  const plan = db.prepare('SELECT * FROM membership_plans WHERE id=?').get(b.plan_id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  const start = b.start_date || new Date().toISOString().slice(0, 10);
  const end = new Date(Date.now() + (plan.validity_days || 365) * 86400000).toISOString().slice(0, 10);
  let remaining = null;
  if (plan.plan_type === 'package' && plan.services_json) {
    try {
      const svcs = JSON.parse(plan.services_json);
      const named = svcs.map(s => {
        const svc = db.prepare('SELECT name FROM services WHERE id=?').get(s.service_id);
        return { service_id: s.service_id, name: svc ? svc.name : '', remaining: s.qty || 0 };
      });
      remaining = JSON.stringify(named);
    } catch (_) { remaining = null; }
  }
  const r = db.prepare(
    'INSERT INTO client_memberships (client_id, plan_id, plan_name, plan_type, discount_pct, start_date, end_date, remaining_json, status) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(b.client_id, b.plan_id, plan.name, plan.plan_type, plan.discount_pct, start, end, remaining, 'active');
  res.status(201).json({ id: r.lastInsertRowid, end_date: end });
});

router.delete('/client-memberships/:id', requirePermission(M, 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM client_memberships WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
