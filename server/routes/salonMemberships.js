// Salon Memberships & Packages — plans + assigning them to clients.
const express = require('express');
const pg = require('../db/pg');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const M = 'salon_memberships';

// ─── Plans ───────────────────────────────────────────────────────────
router.get('/plans', requirePermission(M, 'view'), async (req, res) => {
  try {
    res.json(await pg.all('SELECT * FROM membership_plans ORDER BY plan_type, price'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/plans', requirePermission(M, 'create'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'Plan name required' });
    const servicesJson = b.services ? JSON.stringify(b.services) : (b.services_json || null);
    const r = await pg.run(
      'INSERT INTO membership_plans (name, plan_type, price, validity_days, discount_pct, services_json, description, active) VALUES (?,?,?,?,?,?,?,?)',
      b.name.trim(), b.plan_type || 'membership', b.price || 0, b.validity_days || 365, b.discount_pct || 0, servicesJson, b.description || '', b.active === 0 ? 0 : 1);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/plans/:id', requirePermission(M, 'edit'), async (req, res) => {
  try {
    const b = req.body || {};
    const servicesJson = b.services ? JSON.stringify(b.services) : (b.services_json || null);
    await pg.run(
      'UPDATE membership_plans SET name=?, plan_type=?, price=?, validity_days=?, discount_pct=?, services_json=?, description=?, active=? WHERE id=?',
      b.name || '', b.plan_type || 'membership', b.price || 0, b.validity_days || 365, b.discount_pct || 0, servicesJson, b.description || '', b.active === 0 ? 0 : 1, req.params.id);
    res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/plans/:id', requirePermission(M, 'delete'), async (req, res) => {
  try {
    await pg.run('DELETE FROM membership_plans WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Client memberships (sold to a client) ──────────────────────────
router.get('/client-memberships', requirePermission(M, 'view'), async (req, res) => {
  try {
    const { client_id, status } = req.query;
    let sql = `SELECT cm.*, c.name AS client_name, c.phone AS client_phone
               FROM client_memberships cm LEFT JOIN salon_clients c ON c.id = cm.client_id WHERE 1=1`;
    const p = [];
    if (client_id) { sql += ' AND cm.client_id=?'; p.push(client_id); }
    if (status) { sql += ' AND cm.status=?'; p.push(status); }
    sql += ' ORDER BY cm.created_at DESC';
    res.json(await pg.all(sql, ...p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Assign / sell a plan to a client
router.post('/client-memberships', requirePermission(M, 'create'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.client_id || !b.plan_id) return res.status(400).json({ error: 'Client and plan required' });
    const plan = await pg.get('SELECT * FROM membership_plans WHERE id=?', b.plan_id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const start = b.start_date || new Date().toISOString().slice(0, 10);
    const end = new Date(Date.now() + (plan.validity_days || 365) * 86400000).toISOString().slice(0, 10);
    let remaining = null;
    if (plan.plan_type === 'package' && plan.services_json) {
      try {
        const svcs = JSON.parse(plan.services_json);
        const named = [];
        for (const s of svcs) {
          const svc = await pg.get('SELECT name FROM services WHERE id=?', s.service_id);
          named.push({ service_id: s.service_id, name: svc ? svc.name : '', remaining: s.qty || 0 });
        }
        remaining = JSON.stringify(named);
      } catch (_) { remaining = null; }
    }
    const r = await pg.run(
      'INSERT INTO client_memberships (client_id, plan_id, plan_name, plan_type, discount_pct, start_date, end_date, remaining_json, status) VALUES (?,?,?,?,?,?,?,?,?)',
      b.client_id, b.plan_id, plan.name, plan.plan_type, plan.discount_pct, start, end, remaining, 'active');
    res.status(201).json({ id: r.lastInsertRowid, end_date: end });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client-memberships/:id', requirePermission(M, 'delete'), async (req, res) => {
  try {
    await pg.run('DELETE FROM client_memberships WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
