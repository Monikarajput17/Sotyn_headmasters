// Fire NOC Renewal Module — REST routes (PR2 + minimal PR4 UI shell).
//
// Minimum surface needed for the Fire NOC sidebar entry to be a real,
// clickable module:
//   GET  /api/fire-noc/dashboard        → KPI tiles + counts per stage
//   GET  /api/fire-noc/cycles           → list with filters
//   GET  /api/fire-noc/cycles/:id       → cycle detail + history
//   POST /api/fire-noc/cycles           → manual create (no Master DB yet)
//   POST /api/fire-noc/cycles/:id/advance → manual stage advancement
//   GET  /api/fire-noc/state-rules      → seeded cycle-year lookup
//
// Cron-driven auto-advance, quote generation, maker-checker
// enforcement, Master DB CSV import, inspection workflow, and
// upsell generation all land in subsequent PRs.

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { logAuditEvent } = require('../middleware/audit');
const { syncCycle, expectedStageAndStatus, daysToExpiry } = require('../lib/fireNocSync');

const router = express.Router();
router.use(authMiddleware);

// Bulk-import uploads.  Reuses the same data/uploads dir + 10 MB
// limit as customers.js / orders.js so admin only has one path to
// clear/rotate.
const uploadDir = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

// ── Stage helpers (pure functions; will move to lib/ in PR3) ────
// Maps days-to-expiry → expected stage.  Used by both the manual
// advance endpoint and the future hourly cron.
function stageForDays(days) {
  if (days === null || days === undefined) return 'T-180';
  if (days <= -30)  return 'CYCLE_CLOSE';
  if (days <= 0)    return 'T-0';
  if (days <= 15)   return 'T-15';
  if (days <= 30)   return 'T-30';
  if (days <= 45)   return 'T-45';
  if (days <= 60)   return 'T-60';
  if (days <= 90)   return 'T-90';
  if (days <= 120)  return 'T-120';
  if (days <= 150)  return 'T-150';
  return 'T-180';
}

// State + building → cycle_years.  Most-specific match wins:
// (state, type) → (state, NULL) → __DEFAULT__ row.
function cycleYearsFor(db, state, buildingType) {
  let row = db.prepare(
    'SELECT cycle_years FROM fire_noc_state_cycle_rule WHERE state=? AND building_type_filter=?'
  ).get(state, buildingType);
  if (row) return row.cycle_years;
  row = db.prepare(
    'SELECT cycle_years FROM fire_noc_state_cycle_rule WHERE state=? AND building_type_filter IS NULL'
  ).get(state);
  if (row) return row.cycle_years;
  row = db.prepare(
    'SELECT cycle_years FROM fire_noc_state_cycle_rule WHERE state=? AND building_type_filter IS NULL'
  ).get('__DEFAULT__');
  return row?.cycle_years || 5;
}

// ── GET /api/fire-noc/dashboard ─────────────────────────────────
// One call returns everything the Fire NOC landing page needs:
// stage-bucketed counts, KPI tiles, upcoming expiries.
router.get('/dashboard', requirePermission('fire_noc', 'view'), (req, res) => {
  const db = getDb();

  // Per-stage counts (only active cycles)
  const byStage = db.prepare(`
    SELECT current_stage stage, COUNT(*) cnt
    FROM fire_noc_cycle WHERE status='active'
    GROUP BY current_stage
  `).all();

  // KPI tiles
  const activeCount = db.prepare(`SELECT COUNT(*) c FROM fire_noc_cycle WHERE status='active'`).get().c;
  const lostCount = db.prepare(`SELECT COUNT(*) c FROM fire_noc_cycle WHERE status='lost'`).get().c;
  const renewedCount = db.prepare(`SELECT COUNT(*) c FROM fire_noc_cycle WHERE status='renewed'`).get().c;

  // Pipeline value = sum of latest quote amount on cycles in
  // stages T-120 to T-60 (per spec dashboard definition).
  const pipelineValue = db.prepare(`
    SELECT COALESCE(SUM(q.amount), 0) total FROM fire_noc_cycle c
    JOIN fire_noc_quote q ON q.cycle_id = c.id
    WHERE c.status='active'
      AND c.current_stage IN ('T-120','T-90','CONVERT_CHECK','LOST_POOL','T-60')
      AND q.version = (
        SELECT MAX(version) FROM fire_noc_quote WHERE cycle_id = c.id
      )
  `).get().total;

  // Inspections with open compliance fixes
  const failedInspectionsAwaiting = db.prepare(`
    SELECT COUNT(*) c FROM fire_noc_inspection
    WHERE result='fail'
      AND id IN (
        SELECT inspection_id FROM fire_noc_compliance_ticket
        WHERE status != 'verified'
      )
  `).get().c;

  // Next 7 days expiries
  const nextWeekExpiries = db.prepare(`
    SELECT c.id, c.expiry_date, c.current_stage,
           p.building_name, p.state, p.building_type,
           cust.company_name customer_name
    FROM fire_noc_cycle c
    JOIN fire_noc_property p ON c.property_id = p.id
    LEFT JOIN customers cust ON p.customer_id = cust.id
    WHERE c.status='active'
      AND date(c.expiry_date) BETWEEN date('now') AND date('now', '+7 days')
    ORDER BY c.expiry_date ASC
    LIMIT 20
  `).all();

  // State-cycle rules — for the front-end to know what cycle_years
  // a new property would inherit.
  const stateRules = db.prepare(
    'SELECT state, building_type_filter, cycle_years FROM fire_noc_state_cycle_rule ORDER BY state, building_type_filter'
  ).all();

  res.json({
    spec_version: 'v1',
    generated_at: new Date().toISOString(),
    kpi: {
      active_cycles: activeCount,
      lost_cycles: lostCount,
      renewed_cycles: renewedCount,
      pipeline_value: pipelineValue,
      failed_inspections_awaiting_fix: failedInspectionsAwaiting,
    },
    by_stage: byStage,
    next_7_days_expiries: nextWeekExpiries,
    state_rules: stateRules,
  });
});

// ── GET /api/fire-noc/cycles ────────────────────────────────────
router.get('/cycles', requirePermission('fire_noc', 'view'), (req, res) => {
  const db = getDb();
  const { state, stage, status, owner, q } = req.query;
  const where = ['1=1'];
  const params = [];
  if (state)  { where.push('p.state = ?');               params.push(state); }
  if (stage)  { where.push('c.current_stage = ?');       params.push(stage); }
  if (status) { where.push('c.status = ?');              params.push(status); }
  if (owner)  { where.push('c.owner_user_id = ?');       params.push(+owner); }
  if (q) {
    where.push('(p.building_name LIKE ? OR p.address LIKE ? OR cust.company_name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const rows = db.prepare(`
    SELECT c.id, c.cycle_no, c.expiry_date, c.current_stage, c.status,
           c.stage_entered_at, c.owner_user_id,
           CAST(julianday(c.expiry_date) - julianday('now') AS INTEGER) days_to_expiry,
           p.id property_id, p.state, p.building_type, p.building_name,
           p.address, p.decision_maker_name,
           cust.company_name customer_name,
           u.name owner_name
    FROM fire_noc_cycle c
    JOIN fire_noc_property p ON c.property_id = p.id
    LEFT JOIN customers cust ON p.customer_id = cust.id
    LEFT JOIN users u ON c.owner_user_id = u.id
    WHERE ${where.join(' AND ')}
    ORDER BY c.expiry_date ASC
  `).all(...params);
  res.json(rows);
});

// ── GET /api/fire-noc/cycles/:id ────────────────────────────────
router.get('/cycles/:id', requirePermission('fire_noc', 'view'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const cycle = db.prepare(`
    SELECT c.*,
           p.state, p.building_type, p.building_name, p.address,
           p.pincode, p.decision_maker_name, p.decision_maker_phone,
           p.decision_maker_email, p.ticket_size_band, p.source,
           cust.company_name customer_name,
           u.name owner_name,
           CAST(julianday(c.expiry_date) - julianday('now') AS INTEGER) days_to_expiry
    FROM fire_noc_cycle c
    JOIN fire_noc_property p ON c.property_id = p.id
    LEFT JOIN customers cust ON p.customer_id = cust.id
    LEFT JOIN users u ON c.owner_user_id = u.id
    WHERE c.id = ?
  `).get(id);
  if (!cycle) return res.status(404).json({ error: 'Cycle not found' });

  const history = db.prepare(`
    SELECT id, from_stage, to_stage, entered_at, exited_at, triggered_by, notes
    FROM fire_noc_stage_history WHERE cycle_id=? ORDER BY entered_at ASC
  `).all(id);
  const outreach = db.prepare(`
    SELECT * FROM fire_noc_outreach WHERE cycle_id=? ORDER BY created_at DESC LIMIT 50
  `).all(id);
  const quotes = db.prepare(`
    SELECT * FROM fire_noc_quote WHERE cycle_id=? ORDER BY version ASC
  `).all(id);
  const documents = db.prepare(`
    SELECT * FROM fire_noc_document WHERE cycle_id=? ORDER BY uploaded_at DESC
  `).all(id);
  const inspections = db.prepare(`
    SELECT * FROM fire_noc_inspection WHERE cycle_id=? ORDER BY scheduled_at DESC
  `).all(id);
  const tickets = db.prepare(`
    SELECT * FROM fire_noc_compliance_ticket WHERE cycle_id=? ORDER BY opened_at DESC
  `).all(id);
  const upsells = db.prepare(`
    SELECT * FROM fire_noc_upsell WHERE cycle_id=?
  `).all(id);

  res.json({ ...cycle, history, outreach, quotes, documents, inspections, tickets, upsells });
});

// ── POST /api/fire-noc/cycles ───────────────────────────────────
// Manual create (no Master DB match yet — that's PR6).
router.post('/cycles', requirePermission('fire_noc', 'create'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  if (!b.state || !b.building_type || !b.expiry_date) {
    return res.status(400).json({ error: 'state, building_type, and expiry_date are required' });
  }
  const allowedBuildings = ['hospital','school','commercial','industrial','residential','hotel','mall','other'];
  if (!allowedBuildings.includes(b.building_type)) {
    return res.status(400).json({ error: `building_type must be one of: ${allowedBuildings.join(', ')}` });
  }

  const txn = db.transaction(() => {
    // 1. Insert property
    const propRes = db.prepare(`
      INSERT INTO fire_noc_property (
        customer_id, state, building_type, building_name, address, pincode,
        decision_maker_name, decision_maker_phone, decision_maker_email,
        ticket_size_band, source, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.customer_id || null, b.state, b.building_type,
      b.building_name || null, b.address || null, b.pincode || null,
      b.decision_maker_name || null, b.decision_maker_phone || null,
      b.decision_maker_email || null, b.ticket_size_band || null,
      b.source || 'manual', req.user.id, req.user.id,
    );
    const propertyId = propRes.lastInsertRowid;

    // 2. Compute current stage from days-to-expiry
    const daysToExpiry = Math.ceil(
      (new Date(b.expiry_date) - new Date()) / 86400000
    );
    const startStage = stageForDays(daysToExpiry);

    // 3. Insert cycle
    const cycRes = db.prepare(`
      INSERT INTO fire_noc_cycle (
        property_id, cycle_no, expiry_date, current_stage,
        status, owner_user_id
      ) VALUES (?, 1, ?, ?, 'active', ?)
    `).run(propertyId, b.expiry_date, startStage, b.owner_user_id || req.user.id);
    const cycleId = cycRes.lastInsertRowid;

    // 4. Stage history first row
    db.prepare(`
      INSERT INTO fire_noc_stage_history
        (cycle_id, from_stage, to_stage, triggered_by, notes)
      VALUES (?, NULL, ?, ?, 'cycle created')
    `).run(cycleId, startStage, String(req.user.id));

    return { propertyId, cycleId, startStage };
  });

  try {
    const { propertyId, cycleId, startStage } = txn();
    logAuditEvent({
      user: req.user,
      action: 'CREATE', entity_type: 'fire_noc_cycle', entity_id: cycleId,
      entity_label: b.building_name || `${b.state} · ${b.building_type}`,
      method: 'POST', path: '/api/fire-noc/cycles',
      body: { state: b.state, building_type: b.building_type, expiry_date: b.expiry_date, startStage },
    });
    res.status(201).json({ id: cycleId, property_id: propertyId, current_stage: startStage });
  } catch (e) {
    console.error('[fire-noc/cycles POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/fire-noc/cycles/import/template ────────────────────
// Mam (2026-05-16): "for import bulk data give option excel".  This
// returns an .xlsx template with the expected column headers (+ a
// sample row) so users don't have to guess the schema.  Required
// columns marked with *; everything else optional.
router.get('/cycles/import/template', requirePermission('fire_noc', 'view'), (req, res) => {
  const headers = [
    'state*', 'building_type*', 'expiry_date* (YYYY-MM-DD)',
    'building_name', 'address', 'pincode',
    'decision_maker_name', 'decision_maker_phone', 'decision_maker_email',
    'ticket_size_band', 'source',
  ];
  const sample = [
    'Rajasthan', 'hospital', '2026-12-15',
    'M/s Apollo Hospital — Jaipur', 'Plot 12, JLN Marg, Jaipur', '302017',
    'Dr. Sharma', '9876543210', 'sharma@apollo.in',
    'medium', 'manual',
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, sample]);
  ws['!cols'] = headers.map(h => ({ wch: Math.max(20, h.length + 2) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Fire NOC Cycles');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="fire-noc-cycles-template.xlsx"');
  res.send(buf);
});

// ── POST /api/fire-noc/cycles/import ────────────────────────────
// Bulk import cycles from an uploaded .xlsx / .xls / .csv file.
// Each row becomes a property + cycle + stage_history entry in a
// single transaction.  Partial-success model: if any row fails
// validation, that row is skipped and reported in the response,
// but valid rows still import successfully.
//
// Accepted column names (case-insensitive, * = required):
//   state*, building_type*, expiry_date* (Excel date OR YYYY-MM-DD)
//   building_name, address, pincode,
//   decision_maker_name, decision_maker_phone, decision_maker_email,
//   ticket_size_band, source
const ALLOWED_BUILDINGS = ['hospital','school','commercial','industrial','residential','hotel','mall','other'];

// Excel stores dates as serial numbers (days since 1900-01-01).
// Convert if numeric; otherwise pass through assuming YYYY-MM-DD.
function normalizeDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    // Excel epoch quirk: 1900-01-00 + serial days, 1-indexed
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Try parsing things like "15/12/2026" or "15-Dec-2026"
  const dd = new Date(s);
  if (!isNaN(dd)) return dd.toISOString().slice(0, 10);
  return null;
}

router.post('/cycles/import', requirePermission('fire_noc', 'create'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const db = getDb();
  let wb, rows;
  try {
    wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(400).json({ error: 'Could not parse the file. Expected .xlsx / .xls / .csv', detail: e.message });
  }
  try { fs.unlinkSync(req.file.path); } catch (_) {}

  if (!rows.length) {
    return res.status(400).json({ error: 'No data rows found. The first row must be column headers; data starts on row 2.' });
  }

  // Normalize header keys — strip *, anything in parens, lowercase, trim
  const cleanKey = (k) => String(k || '')
    .toLowerCase()
    .replace(/\*/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const created = [];
  const failed = [];

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const r = {};
    Object.entries(raw).forEach(([k, v]) => { r[cleanKey(k)] = typeof v === 'string' ? v.trim() : v; });

    const state = r['state'];
    const building_type = String(r['building_type'] || '').toLowerCase();
    const expiry_date = normalizeDate(r['expiry_date']);

    if (!state || !building_type || !expiry_date) {
      failed.push({ row: i + 2, reason: 'Missing required field (state / building_type / expiry_date)', raw });
      continue;
    }
    if (!ALLOWED_BUILDINGS.includes(building_type)) {
      failed.push({ row: i + 2, reason: `building_type "${building_type}" not in allowed list: ${ALLOWED_BUILDINGS.join(', ')}`, raw });
      continue;
    }

    try {
      const txn = db.transaction(() => {
        const propRes = db.prepare(`
          INSERT INTO fire_noc_property (
            customer_id, state, building_type, building_name, address, pincode,
            decision_maker_name, decision_maker_phone, decision_maker_email,
            ticket_size_band, source, created_by, updated_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          null, state, building_type,
          r['building_name'] || null, r['address'] || null, r['pincode'] || null,
          r['decision_maker_name'] || null, r['decision_maker_phone'] || null,
          r['decision_maker_email'] || null, r['ticket_size_band'] || null,
          r['source'] || 'bulk_import', req.user.id, req.user.id,
        );
        const propertyId = propRes.lastInsertRowid;
        // AUTO-STATUS at create time — past-expiry rows come in as
        // 'lapsed' / LOST_POOL instead of 'active' / CYCLE_CLOSE
        // (mam, 2026-05-16: do the work automatically, don't make
        // me click).  Falls back to the legacy values if the helper
        // returns null (terminal status — can't happen on create
        // but defensive).
        const days = daysToExpiry(expiry_date);
        const exp = expectedStageAndStatus(days, 'active') || { stage: stageForDays(days), status: 'active' };
        const cycRes = db.prepare(`
          INSERT INTO fire_noc_cycle (
            property_id, cycle_no, expiry_date, current_stage,
            status, owner_user_id
          ) VALUES (?, 1, ?, ?, ?, ?)
        `).run(propertyId, expiry_date, exp.stage, exp.status, req.user.id);
        const cycleId = cycRes.lastInsertRowid;
        db.prepare(`
          INSERT INTO fire_noc_stage_history (cycle_id, from_stage, to_stage, triggered_by, notes)
          VALUES (?, NULL, ?, ?, ?)
        `).run(cycleId, exp.stage, String(req.user.id),
               `cycle created via bulk import · days_to_expiry=${days}${exp.status === 'archived' ? ' · auto-archived (past expiry)' : ''}`);
        return { propertyId, cycleId, startStage: exp.stage };
      });
      const out = txn();
      created.push({
        row: i + 2,
        cycle_id: out.cycleId,
        property_id: out.propertyId,
        stage: out.startStage,
        building: r['building_name'] || `${state} · ${building_type}`,
      });
    } catch (e) {
      failed.push({ row: i + 2, reason: e.message, raw });
    }
  }

  // Single audit log entry for the whole batch (saves DB churn vs one
  // event per row).
  logAuditEvent({
    user: req.user,
    action: 'BULK_IMPORT', entity_type: 'fire_noc_cycle',
    entity_label: `${created.length} created, ${failed.length} failed`,
    method: 'POST', path: '/api/fire-noc/cycles/import',
    body: { rows_total: rows.length, created: created.length, failed: failed.length },
  });

  res.json({
    total_rows: rows.length,
    created_count: created.length,
    failed_count: failed.length,
    created, failed,
  });
});

// ── POST /api/fire-noc/cycles/:id/advance ───────────────────────
router.post('/cycles/:id/advance', requirePermission('fire_noc', 'create'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const { to_stage, notes } = req.body || {};
  if (!to_stage) return res.status(400).json({ error: 'to_stage is required' });

  const cycle = db.prepare('SELECT current_stage FROM fire_noc_cycle WHERE id=?').get(id);
  if (!cycle) return res.status(404).json({ error: 'Cycle not found' });
  if (cycle.current_stage === to_stage) {
    return res.status(400).json({ error: `Cycle is already at stage ${to_stage}` });
  }

  const txn = db.transaction(() => {
    db.prepare(`UPDATE fire_noc_cycle SET current_stage=?, stage_entered_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(to_stage, id);
    db.prepare(`UPDATE fire_noc_stage_history SET exited_at=CURRENT_TIMESTAMP WHERE cycle_id=? AND to_stage=? AND exited_at IS NULL`).run(id, cycle.current_stage);
    try {
      db.prepare(`INSERT INTO fire_noc_stage_history (cycle_id, from_stage, to_stage, triggered_by, notes) VALUES (?, ?, ?, ?, ?)`)
        .run(id, cycle.current_stage, to_stage, String(req.user.id), notes || null);
    } catch (e) {
      // UNIQUE(cycle_id, to_stage, entered_at) — same-second dup.
      // Idempotent: swallow but log.
      if (!String(e.message).includes('UNIQUE')) throw e;
    }
  });
  txn();

  logAuditEvent({
    user: req.user, action: 'UPDATE', entity_type: 'fire_noc_cycle',
    entity_id: id, method: 'POST', path: '/api/fire-noc/cycles/:id/advance',
    body: { from: cycle.current_stage, to: to_stage, notes },
  });
  res.json({ id, current_stage: to_stage });
});

// ── PATCH /api/fire-noc/cycles/:id ──────────────────────────────
// Partial update for the cycle detail drawer (PR5-lite, mam asked
// for it on 2026-05-16 after seeing bulk-imported cycles with no
// place to act).  Accepts any subset of:
//   { status, owner_user_id, decision_maker_name, decision_maker_phone,
//     decision_maker_email, ticket_size_band }
// Property-level fields update fire_noc_property; cycle-level fields
// update fire_noc_cycle.  Every change is mirrored into stage_history
// as a note so the timeline shows what changed and when.
router.patch('/cycles/:id', requirePermission('fire_noc', 'edit'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const b = req.body || {};
  const cycle = db.prepare('SELECT c.*, p.id property_id FROM fire_noc_cycle c JOIN fire_noc_property p ON c.property_id=p.id WHERE c.id=?').get(id);
  if (!cycle) return res.status(404).json({ error: 'Cycle not found' });

  // Matches the CHECK constraint on fire_noc_cycle.status.  UI may
  // display 'archived' as "Lapsed" — storage stays 'archived'.
  const allowedStatuses = ['active', 'lost', 'renewed', 'archived'];
  const changes = [];
  const txn = db.transaction(() => {
    if (b.status !== undefined) {
      if (!allowedStatuses.includes(b.status)) {
        throw new Error(`status must be one of: ${allowedStatuses.join(', ')}`);
      }
      if (b.status !== cycle.status) {
        db.prepare(`UPDATE fire_noc_cycle SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(b.status, id);
        changes.push(`status: ${cycle.status} → ${b.status}`);
      }
    }
    if (b.owner_user_id !== undefined) {
      const newOwnerId = b.owner_user_id ? +b.owner_user_id : null;
      if (newOwnerId !== cycle.owner_user_id) {
        db.prepare(`UPDATE fire_noc_cycle SET owner_user_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(newOwnerId, id);
        const newName = newOwnerId ? (db.prepare('SELECT name FROM users WHERE id=?').get(newOwnerId)?.name || `user#${newOwnerId}`) : '—';
        changes.push(`owner → ${newName}`);
      }
    }
    // Property-level edits
    const propFields = ['decision_maker_name', 'decision_maker_phone', 'decision_maker_email', 'ticket_size_band'];
    const propUpdates = [];
    const propParams = [];
    propFields.forEach(f => {
      if (b[f] !== undefined && b[f] !== cycle[f]) {
        propUpdates.push(`${f}=?`);
        propParams.push(b[f] || null);
        changes.push(`${f}: ${cycle[f] || '—'} → ${b[f] || '—'}`);
      }
    });
    if (propUpdates.length) {
      propParams.push(cycle.property_id);
      db.prepare(`UPDATE fire_noc_property SET ${propUpdates.join(', ')}, updated_at=CURRENT_TIMESTAMP, updated_by=? WHERE id=?`)
        .run(...propParams.slice(0, -1), req.user.id, propParams[propParams.length - 1]);
    }
    // Timeline note so the change is visible in the drawer
    if (changes.length) {
      try {
        db.prepare(`INSERT INTO fire_noc_stage_history (cycle_id, from_stage, to_stage, triggered_by, notes) VALUES (?, ?, ?, ?, ?)`)
          .run(id, cycle.current_stage, cycle.current_stage, String(req.user.id), `EDIT · ${changes.join(' · ')}`);
      } catch (e) {
        if (!String(e.message).includes('UNIQUE')) throw e;
      }
    }
  });

  try {
    txn();
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  logAuditEvent({
    user: req.user, action: 'UPDATE', entity_type: 'fire_noc_cycle',
    entity_id: id, method: 'PATCH', path: '/api/fire-noc/cycles/:id',
    body: { changes },
  });
  res.json({ id, changes });
});

// ── POST /api/fire-noc/cycles/:id/note ──────────────────────────
// Free-text note that lands in stage_history without changing the
// stage — for "called customer, will revert next week" type entries.
router.post('/cycles/:id/note', requirePermission('fire_noc', 'edit'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const note = (req.body?.note || '').trim();
  if (!note) return res.status(400).json({ error: 'note is required' });
  const cycle = db.prepare('SELECT current_stage FROM fire_noc_cycle WHERE id=?').get(id);
  if (!cycle) return res.status(404).json({ error: 'Cycle not found' });
  try {
    db.prepare(`INSERT INTO fire_noc_stage_history (cycle_id, from_stage, to_stage, triggered_by, notes) VALUES (?, ?, ?, ?, ?)`)
      .run(id, cycle.current_stage, cycle.current_stage, String(req.user.id), `NOTE · ${note}`);
  } catch (e) {
    if (!String(e.message).includes('UNIQUE')) throw e;
  }
  logAuditEvent({
    user: req.user, action: 'CREATE', entity_type: 'fire_noc_cycle_note',
    entity_id: id, method: 'POST', path: '/api/fire-noc/cycles/:id/note',
    body: { note: note.slice(0, 200) },
  });
  res.json({ id });
});

// ── GET /api/fire-noc/state-rules ───────────────────────────────
router.get('/state-rules', requirePermission('fire_noc', 'view'), (req, res) => {
  const rows = getDb().prepare(
    'SELECT state, building_type_filter, cycle_years FROM fire_noc_state_cycle_rule ORDER BY state, building_type_filter'
  ).all();
  res.json(rows);
});

module.exports = router;
