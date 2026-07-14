// CRM Full Kitting — mam (2026-05-21):
// "3 stages of crm full kitting of project which i need in erp.
//  drop down is :- Yes, No, Partially, N/A with upload photo of every
//  points.  and this also happen today upload photo after 5 days also
//  can upload photo but we see prvious history photo also".
//
// Data model:
//   crm_kitting_checkpoint   master list of checkpoints, grouped by
//                            stage_no (1..3).  Editable by admin.
//   crm_kitting_entry        append-only history — every dropdown
//                            change + photo upload creates a new
//                            row.  The "current" status is the most
//                            recent row per (project_id, checkpoint_id).
//
// Endpoints:
//   GET    /api/crm-kitting/checkpoints                  list master
//   POST   /api/crm-kitting/checkpoints                  add (admin)
//   PUT    /api/crm-kitting/checkpoints/:id              edit (admin)
//   DELETE /api/crm-kitting/checkpoints/:id              soft-delete
//   GET    /api/crm-kitting/projects                     BB-derived project list
//   GET    /api/crm-kitting/project/:projectId           checkpoints + latest entry
//   POST   /api/crm-kitting/project/:projectId/entry     new entry (multipart for photo)
//   GET    /api/crm-kitting/project/:projectId/checkpoint/:cpId/history
//
// 5-day late uploads:  mam wants someone in the field to be able to
// upload yesterday's / 5-days-ago's photo with a back-dated
// observation_date.  We accept any observation_date <= today and
// >= today-5d (configurable via UPLOAD_BACK_DAYS).  uploaded_at is
// always now() — that's the audit timestamp.  observation_date is
// what the user is *claiming* the photo was taken on.

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { logAuditEvent } = require('../middleware/audit');

const router = express.Router();
router.use(authMiddleware);

const UPLOAD_BACK_DAYS = 5;

// Photo uploads
const photoDir = path.join(__dirname, '..', '..', 'data', 'uploads', 'crm-kitting');
if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: photoDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '.jpg');
      cb(null, `kit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },  // 10 MB
});

// ── Idempotent schema migration ────────────────────────────────
try {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_kitting_checkpoint (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stage_no INTEGER NOT NULL CHECK(stage_no IN (1,2,3)),
      section TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      label TEXT NOT NULL,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_kit_cp_stage ON crm_kitting_checkpoint(stage_no, sort_order)`);
  // Defensive ALTER for prior installs that lacked the `section` col.
  try {
    const cols = db.prepare(`PRAGMA table_info(crm_kitting_checkpoint)`).all();
    if (!cols.find(c => c.name === 'section')) {
      db.exec(`ALTER TABLE crm_kitting_checkpoint ADD COLUMN section TEXT`);
    }
  } catch (e) {
    console.warn('[crm_kitting] section column migration skipped:', e.message);
  }

  // Entries are keyed by `project_key` (= business_book.company_name)
  // to match Cash Flow's grouping convention.  mam (2026-05-21):
  // "project name accordially pick from business book like cash flow
  // example".  A project in Cash Flow = unique bb.company_name.  Same
  // company_name can have many BB rows (multiple POs / milestones);
  // they all share one set of kitting checkpoints here.
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_kitting_entry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_key TEXT NOT NULL,
      checkpoint_id INTEGER NOT NULL REFERENCES crm_kitting_checkpoint(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('yes','no','partially','na')),
      photo_path TEXT,
      remarks TEXT,
      observation_date DATE,
      uploaded_by INTEGER REFERENCES users(id),
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Defensive migration: earlier deploys of this module had a
  // `project_id INTEGER FK business_book(id)` column.  If we find that
  // shape, add the new project_key column + backfill from BB.
  try {
    const cols = db.prepare(`PRAGMA table_info(crm_kitting_entry)`).all();
    const hasKey = cols.find(c => c.name === 'project_key');
    const hasId  = cols.find(c => c.name === 'project_id');
    if (!hasKey) {
      db.exec(`ALTER TABLE crm_kitting_entry ADD COLUMN project_key TEXT`);
    }
    if (hasId) {
      db.exec(`
        UPDATE crm_kitting_entry
        SET project_key = (SELECT company_name FROM business_book WHERE id = crm_kitting_entry.project_id)
        WHERE project_key IS NULL OR project_key = ''
      `);
    }
  } catch (e) {
    console.warn('[crm_kitting] project_key migration skipped:', e.message);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_kit_entry_proj ON crm_kitting_entry(project_key, checkpoint_id, uploaded_at DESC)`);

  // Project metadata (per logical project = project_key = bb.company_name)
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_kitting_project_meta (
      project_key  TEXT PRIMARY KEY,
      crm_owner    TEXT,
      phase_zone   TEXT,
      pm_owner     TEXT,
      target_start DATE,
      updated_by   INTEGER REFERENCES users(id),
      updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Stage-name override (admin-editable like rental_tools stage labels)
  db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)`);

  // Idempotent v2 seed — mam (2026-05-21) shared 3 master-sheet
  // screenshots: PRE-START (55) / EXECUTION (35) / HANDOVER (41) with
  // sub-sections (DRAWINGS, SITE, CORE MAT, ... etc).  The v1 seed had
  // 18 generic placeholders; we replace it.  Sentinel app_settings
  // flag guards against re-running.  Old placeholders are soft-deleted
  // (is_active=0) so any history rows pointing at them survive.
  const flag = db.prepare(`SELECT value FROM app_settings WHERE key='crm_kitting_seed_v2'`).get();
  if (!flag) {
    db.exec(`UPDATE crm_kitting_checkpoint SET is_active = 0 WHERE section IS NULL`);

    const SEED = [
      // ── Stage 1 — PRE-START (55 items) ──────────────────────────
      // DRAWINGS (7)
      [1, 'DRAWINGS', 'GFC uploaded'],
      [1, 'DRAWINGS', 'Client approved'],
      [1, 'DRAWINGS', 'Last revision locked'],
      [1, 'DRAWINGS', 'BOQ vs method'],
      [1, 'DRAWINGS', 'Chain dependency check'],
      [1, 'DRAWINGS', 'Shop drawings issued'],
      [1, 'DRAWINGS', 'Specs / WLT confirmed'],
      // SITE (7)
      [1, 'SITE', 'Site access cleared'],
      [1, 'SITE', 'Civil ready'],
      [1, 'SITE', 'Space cleared'],
      [1, 'SITE', 'Power available'],
      [1, 'SITE', 'Safety drawing'],
      [1, 'SITE', 'Storage allocated'],
      [1, 'SITE', 'Survey done'],
      // CORE MAT (6)
      [1, 'CORE MAT', 'Identified'],
      [1, 'CORE MAT', 'Ordered'],
      [1, 'CORE MAT', 'Delivered'],
      [1, 'CORE MAT', 'All delivered'],
      [1, 'CORE MAT', 'QC done'],
      [1, 'CORE MAT', 'To start'],
      // LONG-LEAD (5)
      [1, 'LONG-LEAD', 'List final'],
      [1, 'LONG-LEAD', 'Qty verified'],
      [1, 'LONG-LEAD', 'All ordered'],
      [1, 'LONG-LEAD', 'All delivered'],
      [1, 'LONG-LEAD', 'To start'],
      // CONSUMABLES (5)
      [1, 'CONSUMABLES', 'Identified'],
      [1, 'CONSUMABLES', 'Ordered'],
      [1, 'CONSUMABLES', 'Delivered'],
      [1, 'CONSUMABLES', 'Imports cleared'],
      [1, 'CONSUMABLES', 'PPE issued'],
      // PROCUREMENT (5)
      [1, 'PROCUREMENT', 'PO issued'],
      [1, 'PROCUREMENT', 'Vendor confirmed'],
      [1, 'PROCUREMENT', 'Schedule OK'],
      [1, 'PROCUREMENT', 'Backup vendor'],
      [1, 'PROCUREMENT', 'Advance paid'],
      // RESOURCES (5)
      [1, 'RESOURCES', 'Labour'],
      [1, 'RESOURCES', 'Supervisor'],
      [1, 'RESOURCES', 'Sequence'],
      [1, 'RESOURCES', 'Equipment'],
      [1, 'RESOURCES', 'Liaison'],
      // PLAN (6)
      [1, 'PLAN', 'Work plan'],
      [1, 'PLAN', 'Targets'],
      [1, 'PLAN', 'Dependencies'],
      [1, 'PLAN', 'Risks'],
      [1, 'PLAN', 'GC points'],
      [1, 'PLAN', 'Hold points'],
      // COMMERCIAL (5)
      [1, 'COMMERCIAL', 'Rate final'],
      [1, 'COMMERCIAL', 'Client PO'],
      [1, 'COMMERCIAL', 'Milestones'],
      [1, 'COMMERCIAL', 'Insurance'],
      [1, 'COMMERCIAL', 'Work permit'],
      // PERMITS (4)
      [1, 'PERMITS', 'Hot work'],
      [1, 'PERMITS', 'Height'],
      [1, 'PERMITS', 'Confined space'],
      [1, 'PERMITS', 'Client OK'],

      // ── Stage 2 — EXECUTION (35 items) ──────────────────────────
      // DAILY (5)
      [2, 'DAILY', 'Manpower'],
      [2, 'DAILY', 'Material'],
      [2, 'DAILY', 'Output'],
      [2, 'DAILY', 'Toolbox'],
      [2, 'DAILY', 'Housekeeping'],
      // WEEKLY (4)
      [2, 'WEEKLY', 'Quality'],
      [2, 'WEEKLY', 'Permits'],
      [2, 'WEEKLY', 'Progress'],
      [2, 'WEEKLY', 'Backlog'],
      // QC (7)
      [2, 'QC', 'KPIs'],
      [2, 'QC', 'Vendor'],
      [2, 'QC', 'Edicon'],
      [2, 'QC', 'Cost'],
      [2, 'QC', 'Risk register'],
      [2, 'QC', 'ITP'],
      [2, 'QC', 'Hold imp'],
      // SAFETY (9)
      [2, 'SAFETY', 'Reports'],
      [2, 'SAFETY', 'Audit'],
      [2, 'SAFETY', 'Picture'],
      [2, 'SAFETY', 'IR test'],
      [2, 'SAFETY', 'PPE'],
      [2, 'SAFETY', 'Near miss'],
      [2, 'SAFETY', 'Fire ext'],
      [2, 'SAFETY', 'Electrical'],
      [2, 'SAFETY', 'Scaffold'],
      // MAT TRACK (5)
      [2, 'MAT TRACK', 'Opens'],
      [2, 'MAT TRACK', 'Vintage'],
      [2, 'MAT TRACK', 'Surplus'],
      [2, 'MAT TRACK', 'Damaged'],
      [2, 'MAT TRACK', 'Reorder'],
      // CHANGES (5)
      [2, 'CHANGES', 'VO doc'],
      [2, 'CHANGES', 'Delight'],
      [2, 'CHANGES', 'Cost impact'],
      [2, 'CHANGES', 'Approved'],
      [2, 'CHANGES', 'Schedule impact'],

      // ── Stage 3 — HANDOVER (41 items) ───────────────────────────
      // TECHNICAL (7)
      [3, 'TECHNICAL', 'Pre / dyn test'],
      [3, 'TECHNICAL', 'Snag list'],
      [3, 'TECHNICAL', 'Snag closed'],
      [3, 'TECHNICAL', 'T & C'],
      [3, 'TECHNICAL', 'Performance test'],
      [3, 'TECHNICAL', 'Prototype test'],
      [3, 'TECHNICAL', 'BMS'],
      // DOCS (6)
      [3, 'DOCS', 'As-built'],
      [3, 'DOCS', 'O & M'],
      [3, 'DOCS', 'Warranty'],
      [3, 'DOCS', 'Datasheet'],
      [3, 'DOCS', 'Spares'],
      [3, 'DOCS', 'Training'],
      // QC SIGN (3)
      [3, 'QC SIGN', 'Final QC'],
      [3, 'QC SIGN', 'Client inspection'],
      [3, 'QC SIGN', '3rd party'],
      // COMMERCIAL (6)
      [3, 'COMMERCIAL', 'Statutory'],
      [3, 'COMMERCIAL', 'Cert issued'],
      [3, 'COMMERCIAL', 'Final invoice'],
      [3, 'COMMERCIAL', 'Variations'],
      [3, 'COMMERCIAL', 'Retention'],
      [3, 'COMMERCIAL', 'Final payment'],
      // DEMOB (7)
      [3, 'DEMOB', 'No claims'],
      [3, 'DEMOB', 'BG release'],
      [3, 'DEMOB', 'Temp removed'],
      [3, 'DEMOB', 'Site clean'],
      [3, 'DEMOB', 'Surplus material'],
      [3, 'DEMOB', 'Tool return'],
      [3, 'DEMOB', 'Account settled'],
      // DLP (5)
      [3, 'DLP', 'Start date'],
      [3, 'DLP', 'End date'],
      [3, 'DLP', 'Inspection schedule'],
      [3, 'DLP', 'Emergency'],
      [3, 'DLP', 'DLP period'],
      // FINAL (7)
      [3, 'FINAL', 'Key handover'],
      [3, 'FINAL', 'Training'],
      [3, 'FINAL', 'Meeting'],
      [3, 'FINAL', 'Cert signed'],
      [3, 'FINAL', 'Closure report'],
      [3, 'FINAL', 'Lessons learnt'],
      [3, 'FINAL', 'Site sign-off'],
    ];

    const insert = db.prepare(
      `INSERT INTO crm_kitting_checkpoint (stage_no, section, sort_order, label) VALUES (?,?,?,?)`
    );
    let i = 0;
    for (const [stage_no, section, label] of SEED) {
      i += 1;
      insert.run(stage_no, section, i * 10, label);
    }
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('crm_kitting_seed_v2','1')`).run();
    console.log(`[crm_kitting] v2 seed inserted: ${SEED.length} checkpoints`);
  }
} catch (e) {
  console.warn('[crm_kitting] schema init failed:', e.message);
}

// ── Helpers ────────────────────────────────────────────────────
const STATUSES = ['yes', 'no', 'partially', 'na'];

function isAdmin(req) {
  return !!(req.user && (req.user.is_admin || req.user.role === 'admin'));
}

// ── GET /api/crm-kitting/checkpoints ────────────────────────────
router.get('/checkpoints', requirePermission('crm_kitting', 'view'), (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT id, stage_no, section, sort_order, label, description, is_active
      FROM crm_kitting_checkpoint
      WHERE is_active = 1
      ORDER BY stage_no, sort_order, id
    `).all();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/crm-kitting/checkpoints ────────────────────────────
router.post('/checkpoints', requirePermission('crm_kitting', 'create'), (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const { stage_no, section, sort_order, label, description } = req.body || {};
  if (![1, 2, 3].includes(Number(stage_no))) return res.status(400).json({ error: 'stage_no must be 1/2/3' });
  if (!label || !String(label).trim()) return res.status(400).json({ error: 'label required' });
  const db = getDb();
  try {
    const r = db.prepare(`
      INSERT INTO crm_kitting_checkpoint (stage_no, section, sort_order, label, description)
      VALUES (?,?,?,?,?)
    `).run(Number(stage_no), section ? String(section).trim() : null, Number(sort_order) || 0,
           String(label).trim(), description || null);
    logAuditEvent({
      user: req.user, action: 'CREATE', entity_type: 'crm_kitting_checkpoint',
      entity_id: r.lastInsertRowid, entity_label: label,
      method: 'POST', path: '/api/crm-kitting/checkpoints', body: { stage_no, section, label },
    });
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/crm-kitting/checkpoints/:id ────────────────────────
router.put('/checkpoints/:id', requirePermission('crm_kitting', 'edit'), (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const id = Number(req.params.id);
  const { stage_no, section, sort_order, label, description, is_active } = req.body || {};
  const db = getDb();
  try {
    const existing = db.prepare(`SELECT * FROM crm_kitting_checkpoint WHERE id=?`).get(id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    db.prepare(`
      UPDATE crm_kitting_checkpoint
      SET stage_no = ?, section = ?, sort_order = ?, label = ?, description = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      stage_no != null ? Number(stage_no) : existing.stage_no,
      section !== undefined ? (section ? String(section).trim() : null) : existing.section,
      sort_order != null ? Number(sort_order) : existing.sort_order,
      label != null ? String(label).trim() : existing.label,
      description !== undefined ? description : existing.description,
      is_active != null ? (is_active ? 1 : 0) : existing.is_active,
      id
    );
    logAuditEvent({
      user: req.user, action: 'UPDATE', entity_type: 'crm_kitting_checkpoint',
      entity_id: id, entity_label: existing.label,
      method: 'PUT', path: `/api/crm-kitting/checkpoints/${id}`,
      before: existing, after: req.body,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/crm-kitting/checkpoints/:id ─────────────────────
// Soft delete — keep entry history intact.
router.delete('/checkpoints/:id', requirePermission('crm_kitting', 'delete'), (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const id = Number(req.params.id);
  const db = getDb();
  try {
    db.prepare(`UPDATE crm_kitting_checkpoint SET is_active = 0 WHERE id = ?`).run(id);
    logAuditEvent({
      user: req.user, action: 'DELETE', entity_type: 'crm_kitting_checkpoint',
      entity_id: id, method: 'DELETE', path: `/api/crm-kitting/checkpoints/${id}`,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/crm-kitting/projects ───────────────────────────────
// Distinct projects from business_book — grouped by company_name to
// match Cash Flow's project-list convention (mam: "project name
// accordially pick from business book like cash flow example").  One
// row per unique company_name; bb_entry_count tells admin how many
// underlying BB rows roll up.  Rows with NULL/blank company_name are
// folded under the client_name so legacy entries still show up.
router.get('/projects', requirePermission('crm_kitting', 'view'), (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT
        COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name) AS project_key,
        COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name) AS project_name,
        MIN(bb.id)              AS bb_id,
        MAX(bb.lead_no)         AS lead_no,
        MAX(bb.client_name)     AS client_name,
        MAX(bb.state)           AS state,
        MAX(bb.district)        AS district,
        MAX(bb.employee_assigned) AS crm_person,
        COALESCE(SUM(bb.sale_amount_without_gst), 0) AS sale_amount_without_gst,
        COALESCE(SUM(bb.po_amount), 0)               AS po_amount,
        COUNT(bb.id)            AS bb_entry_count,
        MIN(bb.committed_start_date)      AS committed_start_date,
        MAX(bb.committed_completion_date) AS committed_completion_date
      FROM business_book bb
      WHERE COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name) IS NOT NULL
      GROUP BY COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name)
      ORDER BY project_name
    `).all();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/crm-kitting/project?key=<company_name> ─────────────
// Returns the rolled-up project + checkpoint list with the latest
// entry per checkpoint.  Keyed on project_key (= bb.company_name) so
// multiple BB rows for the same logical project share one kitting
// state — mirrors Cash Flow's grouping (mam, 2026-05-21).
router.get('/project', requirePermission('crm_kitting', 'view'), (req, res) => {
  const db = getDb();
  const projectKey = String(req.query.key || '').trim();
  if (!projectKey) return res.status(400).json({ error: 'key (project_key / company_name) required' });
  try {
    const project = db.prepare(`
      SELECT
        COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name) AS project_key,
        COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name) AS project_name,
        MIN(bb.id) AS bb_id,
        MAX(bb.lead_no) AS lead_no,
        MAX(bb.client_name) AS client_name,
        MAX(bb.state) AS state,
        MAX(bb.district) AS district,
        MAX(bb.employee_assigned) AS crm_person,
        COALESCE(SUM(bb.sale_amount_without_gst), 0) AS sale_amount_without_gst,
        COALESCE(SUM(bb.po_amount), 0) AS po_amount,
        COUNT(bb.id) AS bb_entry_count
      FROM business_book bb
      WHERE COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name) = ?
      GROUP BY COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name)
    `).get(projectKey);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const checkpoints = db.prepare(`
      SELECT id, stage_no, sort_order, label, description
      FROM crm_kitting_checkpoint
      WHERE is_active = 1
      ORDER BY stage_no, sort_order, id
    `).all();

    const latestStmt = db.prepare(`
      SELECT e.id, e.status, e.photo_path, e.remarks, e.observation_date,
             e.uploaded_at, e.uploaded_by, u.name AS uploaded_by_name,
             (SELECT COUNT(*) FROM crm_kitting_entry e2
              WHERE e2.project_key = e.project_key AND e2.checkpoint_id = e.checkpoint_id) AS history_count
      FROM crm_kitting_entry e
      LEFT JOIN users u ON u.id = e.uploaded_by
      WHERE e.project_key = ? AND e.checkpoint_id = ?
      ORDER BY e.uploaded_at DESC, e.id DESC
      LIMIT 1
    `);

    const withEntries = checkpoints.map(cp => ({
      ...cp,
      latest: latestStmt.get(projectKey, cp.id) || null,
    }));

    const summary = { 1: { yes: 0, no: 0, partially: 0, na: 0, pending: 0, total: 0 },
                      2: { yes: 0, no: 0, partially: 0, na: 0, pending: 0, total: 0 },
                      3: { yes: 0, no: 0, partially: 0, na: 0, pending: 0, total: 0 } };
    for (const cp of withEntries) {
      const s = summary[cp.stage_no];
      if (!s) continue;
      s.total += 1;
      if (cp.latest && cp.latest.status) s[cp.latest.status] += 1;
      else s.pending += 1;
    }

    res.json({ project, checkpoints: withEntries, summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/crm-kitting/entry ─────────────────────────────────
// Multipart: project_key, checkpoint_id, status, observation_date,
// remarks, photo (file).  Key in body (not URL) so company_names
// containing slashes / dots work without URL-encoding gymnastics.
router.post('/entry',
  requirePermission('crm_kitting', 'edit'),
  photoUpload.single('photo'),
  (req, res) => {
    const db = getDb();
    const projectKey = String(req.body?.project_key || '').trim();
    const { checkpoint_id, status, remarks } = req.body || {};
    let { observation_date } = req.body || {};

    if (!projectKey) return res.status(400).json({ error: 'project_key required' });
    if (!STATUSES.includes(String(status))) {
      return res.status(400).json({ error: `status must be one of ${STATUSES.join(',')}` });
    }
    const cpId = Number(checkpoint_id);
    if (!cpId) return res.status(400).json({ error: 'checkpoint_id required' });

    // observation_date validation — defaults to today, max 5 days back.
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const minDate = new Date(today); minDate.setDate(minDate.getDate() - UPLOAD_BACK_DAYS);
    let obs = today;
    if (observation_date) {
      const d = new Date(observation_date);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'invalid observation_date' });
      d.setHours(0, 0, 0, 0);
      if (d.getTime() > today.getTime()) return res.status(400).json({ error: 'observation_date cannot be in the future' });
      if (d.getTime() < minDate.getTime()) return res.status(400).json({ error: `observation_date cannot be more than ${UPLOAD_BACK_DAYS} days in the past` });
      obs = d;
    }
    observation_date = obs.toISOString().slice(0, 10);

    try {
      // Confirm the project_key still maps to at least one BB row.
      const projExists = db.prepare(`
        SELECT 1 FROM business_book
        WHERE COALESCE(NULLIF(TRIM(company_name),''), client_name) = ?
        LIMIT 1
      `).get(projectKey);
      if (!projExists) return res.status(404).json({ error: 'project not found in business book' });

      const cp = db.prepare(`SELECT id FROM crm_kitting_checkpoint WHERE id = ?`).get(cpId);
      if (!cp) return res.status(404).json({ error: 'checkpoint not found' });

      const photoPath = req.file ? `/uploads/crm-kitting/${path.basename(req.file.path)}` : null;
      const r = db.prepare(`
        INSERT INTO crm_kitting_entry
          (project_key, checkpoint_id, status, photo_path, remarks, observation_date, uploaded_by)
        VALUES (?,?,?,?,?,?,?)
      `).run(projectKey, cpId, String(status), photoPath, remarks || null, observation_date, req.user?.id || null);

      logAuditEvent({
        user: req.user, action: 'CREATE', entity_type: 'crm_kitting_entry',
        entity_id: r.lastInsertRowid, entity_label: `${projectKey} · cp=${cpId} · ${status}`,
        method: 'POST', path: '/api/crm-kitting/entry',
        body: { project_key: projectKey, checkpoint_id: cpId, status, observation_date },
      });
      res.json({ id: r.lastInsertRowid, photo_path: photoPath });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// ── GET /api/crm-kitting/history?key=...&cp=... ─────────────────
router.get('/history',
  requirePermission('crm_kitting', 'view'),
  (req, res) => {
    const db = getDb();
    const projectKey = String(req.query.key || '').trim();
    const cpId = Number(req.query.cp);
    if (!projectKey || !cpId) return res.status(400).json({ error: 'key + cp required' });
    try {
      const rows = db.prepare(`
        SELECT e.id, e.status, e.photo_path, e.remarks, e.observation_date,
               e.uploaded_at, e.uploaded_by, u.name AS uploaded_by_name
        FROM crm_kitting_entry e
        LEFT JOIN users u ON u.id = e.uploaded_by
        WHERE e.project_key = ? AND e.checkpoint_id = ?
        ORDER BY e.uploaded_at DESC, e.id DESC
      `).all(projectKey, cpId);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// ── GET /api/crm-kitting/matrix ─────────────────────────────────
// One round-trip for the matrix grid: returns project rows (rolled-up
// by company_name like Cash Flow), checkpoint columns grouped by
// stage + section, project meta (CRM owner / Phase / PM / Target
// Start), and the latest entry per (project_key, checkpoint_id).
router.get('/matrix', requirePermission('crm_kitting', 'view'), (req, res) => {
  const db = getDb();
  try {
    const projects = db.prepare(`
      SELECT
        COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name) AS project_key,
        COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name) AS project_name,
        MIN(bb.id)              AS bb_id,
        MAX(bb.lead_no)         AS lead_no,
        MAX(bb.client_name)     AS client_name,
        MAX(bb.state)           AS state,
        MAX(bb.employee_assigned) AS crm_person,
        COALESCE(SUM(bb.sale_amount_without_gst), 0) AS sale_amount_without_gst,
        COUNT(bb.id)            AS bb_entry_count
      FROM business_book bb
      WHERE COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name) IS NOT NULL
      GROUP BY COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name)
      ORDER BY project_name
    `).all();

    const checkpoints = db.prepare(`
      SELECT id, stage_no, section, sort_order, label, description
      FROM crm_kitting_checkpoint
      WHERE is_active = 1
      ORDER BY stage_no, sort_order, id
    `).all();

    const metaRows = db.prepare(`SELECT * FROM crm_kitting_project_meta`).all();
    const metaByKey = {};
    for (const m of metaRows) metaByKey[m.project_key] = m;

    // Pull latest entry per (project_key, checkpoint_id) in one query.
    // SQLite supports SELECT ... GROUP BY with MAX() aggregation on
    // the same row only via window functions — emulate with a join on
    // (project_key, checkpoint_id, uploaded_at = MAX).
    const latestRows = db.prepare(`
      SELECT e.project_key, e.checkpoint_id, e.status, e.photo_path,
             e.observation_date, e.uploaded_at, e.uploaded_by,
             u.name AS uploaded_by_name,
             (SELECT COUNT(*) FROM crm_kitting_entry e2
              WHERE e2.project_key = e.project_key AND e2.checkpoint_id = e.checkpoint_id) AS history_count
      FROM crm_kitting_entry e
      JOIN (
        SELECT project_key, checkpoint_id, MAX(uploaded_at) AS max_uploaded_at
        FROM crm_kitting_entry
        GROUP BY project_key, checkpoint_id
      ) lm ON lm.project_key = e.project_key
          AND lm.checkpoint_id = e.checkpoint_id
          AND lm.max_uploaded_at = e.uploaded_at
      LEFT JOIN users u ON u.id = e.uploaded_by
    `).all();

    // Index entries by `${project_key}::${checkpoint_id}` for fast UI lookup
    const entries = {};
    for (const r of latestRows) {
      entries[`${r.project_key}::${r.checkpoint_id}`] = r;
    }

    res.json({ projects, checkpoints, meta: metaByKey, entries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/crm-kitting/project-meta ───────────────────────────
// Upsert per-project metadata: CRM owner (Sushila/Lovely/...), Phase
// or Zone, PM Owner, Target Start.  Mam (2026-05-21): rows in the
// matrix screenshot show these four columns to the left of the
// checkpoint grid.
router.put('/project-meta', requirePermission('crm_kitting', 'edit'), (req, res) => {
  const db = getDb();
  const { project_key, crm_owner, phase_zone, pm_owner, target_start } = req.body || {};
  if (!project_key || !String(project_key).trim()) {
    return res.status(400).json({ error: 'project_key required' });
  }
  try {
    db.prepare(`
      INSERT INTO crm_kitting_project_meta (project_key, crm_owner, phase_zone, pm_owner, target_start, updated_by, updated_at)
      VALUES (?,?,?,?,?,?, CURRENT_TIMESTAMP)
      ON CONFLICT(project_key) DO UPDATE SET
        crm_owner    = COALESCE(excluded.crm_owner, crm_owner),
        phase_zone   = COALESCE(excluded.phase_zone, phase_zone),
        pm_owner     = COALESCE(excluded.pm_owner, pm_owner),
        target_start = COALESCE(excluded.target_start, target_start),
        updated_by   = excluded.updated_by,
        updated_at   = CURRENT_TIMESTAMP
    `).run(
      String(project_key).trim(),
      crm_owner != null ? String(crm_owner) : null,
      phase_zone != null ? String(phase_zone) : null,
      pm_owner != null ? String(pm_owner) : null,
      target_start || null,
      req.user?.id || null,
    );
    logAuditEvent({
      user: req.user, action: 'UPSERT', entity_type: 'crm_kitting_project_meta',
      entity_id: project_key, entity_label: project_key,
      method: 'PUT', path: '/api/crm-kitting/project-meta',
      body: { crm_owner, phase_zone, pm_owner, target_start },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
