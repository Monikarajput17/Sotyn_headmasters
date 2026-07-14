// Pipe Weight master (mam 2026-06-06). Pipes are indented in METERS but
// enquired to vendors and PO'd in KG — this master holds the kg-per-meter
// conversion keyed by pipe Class + Size. Editable so mam maintains it like
// her Excel (C-class is seeded; she adds B-class etc.).

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Lightweight lookup — any authed user (used to fill kg/m on an item / indent).
router.get('/lookup', (req, res) => {
  res.json(getDb().prepare(
    "SELECT id, pipe_class, size, kg_per_meter, weight_per_pipe, pipe_length_m FROM pipe_weights WHERE active=1 ORDER BY pipe_class, kg_per_meter DESC"
  ).all());
});

// Full list (master screen). Optional filters: q (class/size), active.
router.get('/', requirePermission('item_master', 'view'), (req, res) => {
  const { q, active } = req.query;
  let sql = 'SELECT * FROM pipe_weights WHERE 1=1';
  const params = [];
  if (active !== 'all') { sql += ' AND active=?'; params.push(active === '0' ? 0 : 1); }
  if (q) { sql += ' AND (pipe_class LIKE ? OR size LIKE ?)'; const l = `%${q}%`; params.push(l, l); }
  sql += ' ORDER BY pipe_class, kg_per_meter DESC';
  res.json(getDb().prepare(sql).all(...params));
});

// Derive kg_per_meter: explicit value wins; else weight_per_pipe / length.
const deriveKgPerM = (b) => {
  if (num(b.kg_per_meter) > 0) return Math.round(num(b.kg_per_meter) * 1000) / 1000;
  const wpp = num(b.weight_per_pipe), len = num(b.pipe_length_m) || 6;
  return wpp > 0 && len > 0 ? Math.round((wpp / len) * 1000) / 1000 : 0;
};

router.post('/', requirePermission('item_master', 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.pipe_class || !String(b.pipe_class).trim()) return res.status(400).json({ error: 'Class is required' });
  if (!b.size || !String(b.size).trim()) return res.status(400).json({ error: 'Size is required' });
  const kgm = deriveKgPerM(b);
  if (!(kgm > 0)) return res.status(400).json({ error: 'Enter kg/meter (or weight per pipe + length)' });
  const r = getDb().prepare(
    `INSERT INTO pipe_weights (pipe_class, size, kg_per_meter, weight_per_pipe, pipe_length_m, active)
     VALUES (?,?,?,?,?,?)`
  ).run(String(b.pipe_class).trim().toUpperCase(), String(b.size).trim(), kgm,
        num(b.weight_per_pipe) || null, num(b.pipe_length_m) || 6,
        b.active === false || b.active === 0 ? 0 : 1);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/:id', requirePermission('item_master', 'edit'), (req, res) => {
  const b = req.body || {};
  const existing = getDb().prepare('SELECT id FROM pipe_weights WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!b.pipe_class || !String(b.pipe_class).trim()) return res.status(400).json({ error: 'Class is required' });
  if (!b.size || !String(b.size).trim()) return res.status(400).json({ error: 'Size is required' });
  const kgm = deriveKgPerM(b);
  if (!(kgm > 0)) return res.status(400).json({ error: 'Enter kg/meter (or weight per pipe + length)' });
  getDb().prepare(
    `UPDATE pipe_weights SET pipe_class=?, size=?, kg_per_meter=?, weight_per_pipe=?, pipe_length_m=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
  ).run(String(b.pipe_class).trim().toUpperCase(), String(b.size).trim(), kgm,
        num(b.weight_per_pipe) || null, num(b.pipe_length_m) || 6,
        b.active === false || b.active === 0 ? 0 : 1, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/:id', requirePermission('item_master', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM pipe_weights WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
