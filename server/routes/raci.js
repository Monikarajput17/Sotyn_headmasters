// RACI + SLA, PER RECORD (mam 2026-06-25: "RACI should be per-record, not a
// fixed template"). On each individual record (a payment request, indent, DPR,
// …) the user picks the Responsible / Accountable / Consulted / Informed
// employee for each step and sets the expected time (SLA hours); the system
// then tracks how long each step actually took and flags who is late and by
// how much. Generic + module-keyed so every module plugs in the same way.
const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const { MODULE_DEFS, tsMs } = require('../utils/raciModules');
const router = express.Router();
router.use(authMiddleware);

// Per-record RACI assignment: one row per (module, record, step).
try {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS raci_assignment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module TEXT NOT NULL,
      record_id INTEGER NOT NULL,
      step_key TEXT NOT NULL,
      responsible_id INTEGER, accountable_id INTEGER,
      consulted_id INTEGER, informed_id INTEGER,
      sla_hours REAL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(module, record_id, step_key)
    );
  `);
} catch (e) { /* ignore */ }

// done_at / done_by — a manual per-step completion stamp (mam 2026-06-27:
// "by default I add person name with time"). Steps like CRM-funnel Negotiation
// have no date column of their own, so the user marks the step done and the
// board uses this timestamp to compute elapsed time + late-by for scoring.
// Guarded ALTERs so they run once on existing databases without a migration.
// weight (per-step weightage %, makes the scorecard step-wise % weighted) and
// commitment (a free-text "for next week" note per step) — mam 2026-06-29.
for (const col of ['done_at DATETIME', 'done_by INTEGER', 'weight REAL', 'commitment TEXT']) {
  try { getDb().exec(`ALTER TABLE raci_assignment ADD COLUMN ${col}`); } catch (e) { /* already exists */ }
}

// The steps each module exposes come from the shared MODULE_DEFS catalogue
// (server/utils/raciModules.js) so the editor, the board and the timing logic
// all agree. Adding a module = adding one entry there, not here.
const MODULE_STEPS = Object.fromEntries(
  Object.entries(MODULE_DEFS).map(([key, m]) => [key, { label: m.label, steps: m.steps }])
);

// All RACI rows for ONE record → { step_key: row }. One query, no N+1.
function getRecordRaci(db, module, recordId) {
  const map = {};
  try {
    for (const r of db.prepare('SELECT * FROM raci_assignment WHERE module=? AND record_id=?').all(module, recordId)) map[r.step_key] = r;
  } catch (_) {}
  return map;
}
// Batch: all RACI rows for MANY records → { record_id: { step_key: row } }.
function getRaciForRecords(db, module, ids) {
  const out = {};
  if (!ids || !ids.length) return out;
  try {
    for (let i = 0; i < ids.length; i += 900) {
      const chunk = ids.slice(i, i + 900);
      const ph = chunk.map(() => '?').join(',');
      for (const r of db.prepare(`SELECT * FROM raci_assignment WHERE module=? AND record_id IN (${ph})`).all(module, ...chunk)) {
        (out[r.record_id] = out[r.record_id] || {})[r.step_key] = r;
      }
    }
  } catch (_) {}
  return out;
}

// Module + step list (so the editor knows the steps to show).
router.get('/modules', (req, res) => {
  res.json(Object.entries(MODULE_STEPS).map(([key, m]) => ({ key, label: m.label, steps: m.steps })));
});

// Per-record RACI for the editor — step list merged with this record's saved
// assignment + resolved employee names.
router.get('/record/:module/:recordId', (req, res) => {
  const db = getDb();
  const mod = MODULE_STEPS[req.params.module];
  if (!mod) return res.status(404).json({ error: 'Unknown module' });
  const saved = getRecordRaci(db, req.params.module, +req.params.recordId);
  const nm = (id) => { if (!id) return null; const u = db.prepare('SELECT id, name FROM users WHERE id=?').get(id); return u || null; };
  res.json({
    module: req.params.module, record_id: +req.params.recordId, label: mod.label,
    steps: mod.steps.map(s => {
      const c = saved[s.key] || {};
      return {
        ...s,
        responsible_id: c.responsible_id || null, responsible: nm(c.responsible_id),
        accountable_id: c.accountable_id || null, accountable: nm(c.accountable_id),
        consulted_id: c.consulted_id || null, consulted: nm(c.consulted_id),
        informed_id: c.informed_id || null, informed: nm(c.informed_id),
        sla_hours: c.sla_hours != null ? +c.sla_hours : null,
        weight: c.weight != null ? +c.weight : null,
        commitment: c.commitment || null,
      };
    }),
  });
});

// Save this record's RACI (any user who can see the module can set it).
router.put('/record/:module/:recordId', (req, res) => {
  const db = getDb();
  const mod = MODULE_STEPS[req.params.module];
  if (!mod) return res.status(404).json({ error: 'Unknown module' });
  const validKeys = new Set(mod.steps.map(s => s.key));
  const rows = Array.isArray(req.body.steps) ? req.body.steps : [];
  const up = db.prepare(`
    INSERT INTO raci_assignment (module, record_id, step_key, responsible_id, accountable_id, consulted_id, informed_id, sla_hours, weight, commitment, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(module, record_id, step_key) DO UPDATE SET
      responsible_id=excluded.responsible_id, accountable_id=excluded.accountable_id,
      consulted_id=excluded.consulted_id, informed_id=excluded.informed_id,
      sla_hours=excluded.sla_hours, weight=excluded.weight, commitment=excluded.commitment, updated_at=CURRENT_TIMESTAMP`);
  const id = (v) => { const n = +v; return Number.isFinite(n) && n > 0 ? n : null; };
  const sla = (v) => (v != null && v !== '' && +v >= 0) ? +v : null;
  const wt = (v) => (v != null && v !== '' && Number.isFinite(+v) && +v >= 0) ? +v : null;
  const txt = (v) => (v != null && String(v).trim() !== '') ? String(v).trim() : null;
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!validKeys.has(String(r.step_key))) continue;
      up.run(req.params.module, +req.params.recordId, String(r.step_key),
        id(r.responsible_id), id(r.accountable_id), id(r.consulted_id), id(r.informed_id), sla(r.sla_hours), wt(r.weight), txt(r.commitment));
    }
  });
  tx();
  res.json({ message: 'RACI saved' });
});

// Mark ONE step done (stamp its completion time, used for elapsed + scoring) or
// clear it. One-click action from the board; it never touches the step's
// R/A/C/I or SLA. Body: { step_key, done_at } — a 'YYYY-MM-DD' / ISO string, or
// null/'' to re-open the step.
router.put('/step-done/:module/:recordId', (req, res) => {
  const db = getDb();
  const mod = MODULE_STEPS[req.params.module];
  if (!mod) return res.status(404).json({ error: 'Unknown module' });
  const stepKey = String(req.body.step_key || '');
  if (!mod.steps.some(s => s.key === stepKey)) return res.status(400).json({ error: 'Unknown step' });

  // Normalise done_at: a bare date is stored at local-noon so a day-only stamp
  // doesn't slide to the previous day when re-read as UTC.
  let doneAt = req.body.done_at;
  if (doneAt === '' || doneAt == null) doneAt = null;
  else { doneAt = String(doneAt).trim(); if (/^\d{4}-\d{2}-\d{2}$/.test(doneAt)) doneAt += ' 12:00:00'; }
  const doneBy = doneAt ? (req.user?.id || null) : null;

  db.prepare(`
    INSERT INTO raci_assignment (module, record_id, step_key, done_at, done_by, updated_at)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(module, record_id, step_key) DO UPDATE SET
      done_at=excluded.done_at, done_by=excluded.done_by, updated_at=CURRENT_TIMESTAMP
  `).run(req.params.module, +req.params.recordId, stepKey, doneAt, doneBy);

  res.json({ message: doneAt ? 'Step marked done' : 'Step reopened', done_at: doneAt });
});

// Set ONE step's "for next week" commitment in place (mam 2026-06-29: editable
// straight from the scorecard step-wise breakdown). Touches ONLY commitment, so
// it never wipes the step's R/A/C/I, SLA or weight. recordId 0 = module default.
// Body: { step_key, commitment } — empty/null clears it.
router.put('/step-commitment/:module/:recordId', (req, res) => {
  const db = getDb();
  const mod = MODULE_STEPS[req.params.module];
  if (!mod) return res.status(404).json({ error: 'Unknown module' });
  const stepKey = String(req.body.step_key || '');
  if (!mod.steps.some(s => s.key === stepKey)) return res.status(400).json({ error: 'Unknown step' });
  const commitment = (req.body.commitment != null && String(req.body.commitment).trim() !== '')
    ? String(req.body.commitment).trim() : null;
  db.prepare(`
    INSERT INTO raci_assignment (module, record_id, step_key, commitment, updated_at)
    VALUES (?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(module, record_id, step_key) DO UPDATE SET
      commitment=excluded.commitment, updated_at=CURRENT_TIMESTAMP
  `).run(req.params.module, +req.params.recordId, stepKey, commitment);
  res.json({ message: 'Commitment saved', commitment });
});

// Build the "Responsible" board for ONE module: every record with each step's
// assigned R/A/C/I, SLA, actual time taken (elapsed) and how late it ran, plus
// a per-person summary. Shared by GET /board/:module and the cross-module
// /performance scorecard so the timing logic lives in exactly one place
// (mam 2026-06-27: judge people on quality·quantity·time).
function buildBoard(db, moduleKey) {
  const def = MODULE_DEFS[moduleKey];
  if (!def) return null;
  const recs = def.rows(db) || [];
  const raci = getRaciForRecords(db, moduleKey, recs.map(r => r.id));
  // Module-wide DEFAULT RACI (stored under the sentinel record_id = 0). It fills
  // in any step a record hasn't been given its own R/A/C/I/SLA for, so mam can
  // set the module's RACI once instead of on all N records (mam 2026-06-27:
  // "whole module raci one"). A per-record assignment always overrides it.
  const md = getRecordRaci(db, moduleKey, 0);

  const nameCache = {};
  const nm = (id) => { if (!id) return null; if (!(id in nameCache)) nameCache[id] = db.prepare('SELECT name FROM users WHERE id=?').get(id)?.name || null; return nameCache[id]; };

  const HOUR = 3600000, now = Date.now();
  const people = {};
  const bump = (name, hrs, late) => {
    if (!name) return;
    const p = people[name] || (people[name] = { name, steps: 0, total_hours: 0, late_count: 0, late_hours: 0 });
    p.steps += 1;
    if (hrs != null) p.total_hours += hrs;
    if (late > 0) { p.late_count += 1; p.late_hours += late; }
  };

  const rows = recs.map(rec => {
    const recRaci = raci[rec.id] || {};
    const stampOf = (k) => (recRaci[k] && recRaci[k].done_at) || rec.stamps[k] || null;
    const anyManual = def.steps.some(s => recRaci[s.key] && recRaci[s.key].done_at);
    const useMerged = anyManual || rec.owner_id != null;
    const currentKey = useMerged
      ? (rec.current_key == null ? null : ((def.steps.find(s => !stampOf(s.key)) || {}).key || null))
      : rec.current_key;

    let prev = tsMs(rec.created_at);
    const steps = def.steps.map(s => {
      const cfg = recRaci[s.key] || {};
      const m = md[s.key] || {};        // module-wide default for this step
      const sla = cfg.sla_hours != null ? +cfg.sla_hours
        : (m.sla_hours != null ? +m.sla_hours : (s.default_sla != null ? +s.default_sla : null));
      const stampRaw = stampOf(s.key);
      const atMs = stampRaw ? tsMs(stampRaw) : null;
      const isCurrent = !atMs && s.key === currentKey;
      let elapsed = null;
      if (atMs != null && prev != null) { elapsed = Math.max(0, (atMs - prev) / HOUR); prev = atMs; }
      else if (isCurrent && prev != null) { elapsed = Math.max(0, (now - prev) / HOUR); }
      const late = (elapsed != null && sla != null && elapsed > sla) ? elapsed - sla : 0;
      // Precedence: per-record explicit → module default → step owner → record owner.
      const responsible_id = cfg.responsible_id || m.responsible_id || (rec.step_owners && rec.step_owners[s.key]) || rec.owner_id || null;
      const accountable_id = cfg.accountable_id || m.accountable_id || null;
      const consulted_id = cfg.consulted_id || m.consulted_id || null;
      const informed_id = cfg.informed_id || m.informed_id || null;
      const responsible = nm(responsible_id);
      bump(responsible, atMs != null ? elapsed : null, atMs != null ? late : 0);
      return {
        key: s.key, label: s.label,
        status: atMs ? 'done' : (isCurrent ? 'current' : 'pending'),
        at: stampRaw || null,
        done_at: cfg.done_at || null,
        responsible_id, responsible,
        responsible_default: !cfg.responsible_id && !!responsible_id,
        accountable_id, accountable: nm(accountable_id),
        consulted_id, consulted: nm(consulted_id),
        informed_id, informed: nm(informed_id),
        sla_hours: sla,
        elapsed_hours: elapsed != null ? Math.round(elapsed * 10) / 10 : null,
        late_hours: late > 0 ? Math.round(late * 10) / 10 : 0,
      };
    });
    return { id: rec.id, title: rec.title, subtitle: rec.subtitle, created_at: rec.created_at, steps };
  });

  const summary = Object.values(people)
    .map(p => ({
      name: p.name, steps: p.steps,
      total_hours: Math.round(p.total_hours * 10) / 10,
      avg_hours: p.steps ? Math.round((p.total_hours / p.steps) * 10) / 10 : 0,
      late_count: p.late_count,
      late_hours: Math.round(p.late_hours * 10) / 10,
      late_pct: p.steps ? Math.round((p.late_count / p.steps) * 100) : 0,
    }))
    .sort((a, b) => b.steps - a.steps);

  return { module: moduleKey, label: def.label, steps: def.steps, rows, summary };
}

// GET /api/raci/board/:module — one module's Responsible board.
router.get('/board/:module', (req, res) => {
  if (!MODULE_DEFS[req.params.module]) return res.status(404).json({ error: 'Unknown module' });
  try { res.json(buildBoard(getDb(), req.params.module)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/raci/performance — CONSOLIDATED cross-module performance scorecard.
// One row per person aggregated over ALL modules, scored on three equal pillars
// (mam 2026-06-27, "evaluate performance of Quality, Quantity, Time" for the
// Monday management review):
//   • Quantity = how many steps they completed (volume, normalised to the top
//     performer so the best = 100).
//   • Time     = punctuality = % of their completed steps that were on time
//     (not past the step's SLA).
//   • Quality  = thoroughness = % of the steps they OWN that they've actually
//     completed (low = lots of their work left hanging).
//   Score = simple average of the three (each 0–100), equal weight.
router.get('/performance', (req, res) => {
  const db = getDb();
  const agg = {};   // name -> tallies
  const moduleKeys = Object.keys(MODULE_DEFS);
  try {
    for (const key of moduleKeys) {
      const board = buildBoard(db, key);
      if (!board) continue;
      for (const rec of board.rows) {
        for (const s of rec.steps) {
          const name = s.responsible;
          if (!name) continue;
          const p = agg[name] || (agg[name] = { name, owned: 0, completed: 0, on_time: 0, late: 0, total_hours: 0, late_hours: 0, by_module: {} });
          p.owned += 1;
          p.by_module[key] = (p.by_module[key] || 0) + 1;
          if (s.status === 'done') {
            p.completed += 1;
            if (s.late_hours > 0) { p.late += 1; p.late_hours += s.late_hours; } else { p.on_time += 1; }
            if (s.elapsed_hours != null) p.total_hours += s.elapsed_hours;
          }
        }
      }
    }
  } catch (e) { return res.status(500).json({ error: e.message }); }

  const list = Object.values(agg);
  const maxCompleted = Math.max(1, ...list.map(p => p.completed));
  const people = list.map(p => {
    const quantity = Math.round((p.completed / maxCompleted) * 100);
    const time = p.completed ? Math.round((p.on_time / p.completed) * 100) : 0;
    const quality = p.owned ? Math.round((p.completed / p.owned) * 100) : 0;
    const score = Math.round((quantity + time + quality) / 3);
    return {
      name: p.name,
      owned: p.owned, completed: p.completed, on_time: p.on_time, late: p.late,
      total_hours: Math.round(p.total_hours * 10) / 10,
      avg_hours: p.completed ? Math.round((p.total_hours / p.completed) * 10) / 10 : 0,
      late_hours: Math.round(p.late_hours * 10) / 10,
      quantity_score: quantity, time_score: time, quality_score: quality, score,
      modules: Object.keys(p.by_module).length,
      by_module: p.by_module,
    };
  }).sort((a, b) => b.score - a.score || b.completed - a.completed);

  res.json({
    generated_at: new Date().toISOString(),
    module_labels: Object.fromEntries(moduleKeys.map(k => [k, MODULE_DEFS[k].label])),
    people,
  });
});

module.exports = { router, getRecordRaci, getRaciForRecords };
