// Email Triggers — CRUD for dynamic email rules + the event catalog + a
// per-rule "send test" (renders with sample data). Admin-only.
// Engine: server/lib/emailRules.js  ·  Catalog: server/lib/emailEvents.js

const express = require('express');
const pg = require('../db/pg');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { listEvents, EVENTS, SAMPLE_CONTEXT } = require('../lib/emailEvents');
const { runRulesForEvent } = require('../lib/emailRules');

const router = express.Router();
router.use(authMiddleware);

// Catalog of fireable events + their variables / dynamic recipients, plus
// the roles the UI can offer for by-role recipients.
router.get('/events', async (req, res) => {
  let roles = [];
  try { roles = (await pg.all('SELECT name FROM roles ORDER BY name')).map(r => r.name); }
  catch { roles = []; }
  res.json({ events: listEvents(), roles, sample: SAMPLE_CONTEXT });
});

// List all rules (admin).
router.get('/', adminOnly, async (req, res) => {
  try {
    const rows = await pg.all('SELECT * FROM email_rules ORDER BY event_key, id');
    res.json(rows.map(parseRow));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', adminOnly, async (req, res) => {
  try {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Rule name is required' });
  if (!b.event_key || !EVENTS[b.event_key]) return res.status(400).json({ error: 'Pick a valid event' });
  const r = await pg.run(
    `INSERT INTO email_rules (name, event_key, enabled, conditions, recipients, from_addr, subject_tpl, body_tpl, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    String(b.name).trim(), b.event_key,
    b.enabled === false ? 0 : 1,
    JSON.stringify(b.conditions || []),
    JSON.stringify(b.recipients || {}),
    b.from_addr || '',
    b.subject_tpl || '', b.body_tpl || '',
    req.user.id,
  );
  res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', adminOnly, async (req, res) => {
  try {
  const b = req.body || {};
  const existing = await pg.get('SELECT id FROM email_rules WHERE id=?', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Rule not found' });
  await pg.run(
    `UPDATE email_rules SET name=?, event_key=?, enabled=?, conditions=?, recipients=?,
                            from_addr=?, subject_tpl=?, body_tpl=?, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
    String(b.name || '').trim(), b.event_key,
    b.enabled === false ? 0 : 1,
    JSON.stringify(b.conditions || []),
    JSON.stringify(b.recipients || {}),
    b.from_addr || '',
    b.subject_tpl || '', b.body_tpl || '',
    req.params.id,
  );
  res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Quick enable/disable toggle.
router.put('/:id/toggle', adminOnly, async (req, res) => {
  try {
    const row = await pg.get('SELECT enabled FROM email_rules WHERE id=?', req.params.id);
    if (!row) return res.status(404).json({ error: 'Rule not found' });
    const next = row.enabled ? 0 : 1;
    await pg.run('UPDATE email_rules SET enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', next, req.params.id);
    res.json({ enabled: next });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', adminOnly, async (req, res) => {
  try {
    await pg.run('DELETE FROM email_rules WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send a test of THIS rule using sample data + an optional override recipient.
router.post('/:id/test', adminOnly, async (req, res) => {
  try {
  const rule = await pg.get('SELECT * FROM email_rules WHERE id=?', req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  // Build a sample context; let the tester force a To address so they can
  // send the preview to themselves regardless of the rule's recipients.
  const ctx = { ...SAMPLE_CONTEXT };
  const overrideTo = String(req.body?.to || '').trim();
  if (overrideTo) {
    // Inject the override as every dynamic-people slot so it always resolves.
    for (const p of (EVENTS[rule.event_key]?.people || [])) ctx[p.key] = overrideTo;
  }
  try {
    const out = await runRulesForEvent(rule.event_key, ctx, { onlyRuleId: rule.id });
    res.json({ results: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function parseRow(r) {
  let conditions = [], recipients = {};
  try { conditions = JSON.parse(r.conditions || '[]'); } catch {}
  try { recipients = JSON.parse(r.recipients || '{}'); } catch {}
  return { ...r, enabled: !!r.enabled, conditions, recipients };
}

module.exports = router;
