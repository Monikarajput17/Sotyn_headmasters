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
const pg = require('../db/pg');
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

// ── Schema ─────────────────────────────────────────────────────
// Tables (crm_kitting_checkpoint / crm_kitting_entry /
// crm_kitting_project_meta / app_settings) and the v2 master-sheet seed
// (PRE-START 55 / EXECUTION 35 / HANDOVER 41 checkpoints, guarded by the
// app_settings 'crm_kitting_seed_v2' sentinel) live in the migrated
// Postgres schema — the old idempotent SQLite bootstrap was removed in
// the better-sqlite3 → pg conversion.
//
// Entries are keyed by `project_key` (= business_book.company_name)
// to match Cash Flow's grouping convention.  mam (2026-05-21):
// "project name accordially pick from business book like cash flow
// example".  A project in Cash Flow = unique bb.company_name.  Same
// company_name can have many BB rows (multiple POs / milestones);
// they all share one set of kitting checkpoints here.

// ── Helpers ────────────────────────────────────────────────────
const STATUSES = ['yes', 'no', 'partially', 'na'];

function isAdmin(req) {
  return !!(req.user && (req.user.is_admin || req.user.role === 'admin'));
}

// ── GET /api/crm-kitting/checkpoints ────────────────────────────
router.get('/checkpoints', requirePermission('crm_kitting', 'view'), async (req, res) => {
  try {
    const rows = await pg.all(`
      SELECT id, stage_no, section, sort_order, label, description, is_active
      FROM crm_kitting_checkpoint
      WHERE is_active = 1
      ORDER BY stage_no, sort_order, id
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/crm-kitting/checkpoints ────────────────────────────
router.post('/checkpoints', requirePermission('crm_kitting', 'create'), async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const { stage_no, section, sort_order, label, description } = req.body || {};
  if (![1, 2, 3].includes(Number(stage_no))) return res.status(400).json({ error: 'stage_no must be 1/2/3' });
  if (!label || !String(label).trim()) return res.status(400).json({ error: 'label required' });
  try {
    const r = await pg.run(`
      INSERT INTO crm_kitting_checkpoint (stage_no, section, sort_order, label, description)
      VALUES (?,?,?,?,?)
    `, Number(stage_no), section ? String(section).trim() : null, Number(sort_order) || 0,
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
router.put('/checkpoints/:id', requirePermission('crm_kitting', 'edit'), async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const id = Number(req.params.id);
  const { stage_no, section, sort_order, label, description, is_active } = req.body || {};
  try {
    const existing = await pg.get(`SELECT * FROM crm_kitting_checkpoint WHERE id=?`, id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    await pg.run(`
      UPDATE crm_kitting_checkpoint
      SET stage_no = ?, section = ?, sort_order = ?, label = ?, description = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
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
router.delete('/checkpoints/:id', requirePermission('crm_kitting', 'delete'), async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const id = Number(req.params.id);
  try {
    await pg.run(`UPDATE crm_kitting_checkpoint SET is_active = 0 WHERE id = ?`, id);
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
router.get('/projects', requirePermission('crm_kitting', 'view'), async (req, res) => {
  try {
    const rows = await pg.all(`
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
    `);
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
router.get('/project', requirePermission('crm_kitting', 'view'), async (req, res) => {
  const projectKey = String(req.query.key || '').trim();
  if (!projectKey) return res.status(400).json({ error: 'key (project_key / company_name) required' });
  try {
    const project = await pg.get(`
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
    `, projectKey);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const checkpoints = await pg.all(`
      SELECT id, stage_no, sort_order, label, description
      FROM crm_kitting_checkpoint
      WHERE is_active = 1
      ORDER BY stage_no, sort_order, id
    `);

    const latestSql = `
      SELECT e.id, e.status, e.photo_path, e.remarks, e.observation_date,
             e.uploaded_at, e.uploaded_by, u.name AS uploaded_by_name,
             (SELECT COUNT(*) FROM crm_kitting_entry e2
              WHERE e2.project_key = e.project_key AND e2.checkpoint_id = e.checkpoint_id) AS history_count
      FROM crm_kitting_entry e
      LEFT JOIN users u ON u.id = e.uploaded_by
      WHERE e.project_key = ? AND e.checkpoint_id = ?
      ORDER BY e.uploaded_at DESC, e.id DESC
      LIMIT 1
    `;

    const withEntries = [];
    for (const cp of checkpoints) {
      withEntries.push({
        ...cp,
        latest: await pg.get(latestSql, projectKey, cp.id) || null,
      });
    }

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
  async (req, res) => {
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
      const projExists = await pg.get(`
        SELECT 1 FROM business_book
        WHERE COALESCE(NULLIF(TRIM(company_name),''), client_name) = ?
        LIMIT 1
      `, projectKey);
      if (!projExists) return res.status(404).json({ error: 'project not found in business book' });

      const cp = await pg.get(`SELECT id FROM crm_kitting_checkpoint WHERE id = ?`, cpId);
      if (!cp) return res.status(404).json({ error: 'checkpoint not found' });

      const photoPath = req.file ? `/uploads/crm-kitting/${path.basename(req.file.path)}` : null;
      const r = await pg.run(`
        INSERT INTO crm_kitting_entry
          (project_key, checkpoint_id, status, photo_path, remarks, observation_date, uploaded_by)
        VALUES (?,?,?,?,?,?,?)
      `, projectKey, cpId, String(status), photoPath, remarks || null, observation_date, req.user?.id || null);

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
  async (req, res) => {
    const projectKey = String(req.query.key || '').trim();
    const cpId = Number(req.query.cp);
    if (!projectKey || !cpId) return res.status(400).json({ error: 'key + cp required' });
    try {
      const rows = await pg.all(`
        SELECT e.id, e.status, e.photo_path, e.remarks, e.observation_date,
               e.uploaded_at, e.uploaded_by, u.name AS uploaded_by_name
        FROM crm_kitting_entry e
        LEFT JOIN users u ON u.id = e.uploaded_by
        WHERE e.project_key = ? AND e.checkpoint_id = ?
        ORDER BY e.uploaded_at DESC, e.id DESC
      `, projectKey, cpId);
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
router.get('/matrix', requirePermission('crm_kitting', 'view'), async (req, res) => {
  try {
    const projects = await pg.all(`
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
    `);

    const checkpoints = await pg.all(`
      SELECT id, stage_no, section, sort_order, label, description
      FROM crm_kitting_checkpoint
      WHERE is_active = 1
      ORDER BY stage_no, sort_order, id
    `);

    const metaRows = await pg.all(`SELECT * FROM crm_kitting_project_meta`);
    const metaByKey = {};
    for (const m of metaRows) metaByKey[m.project_key] = m;

    // Pull latest entry per (project_key, checkpoint_id) in one query.
    // Emulated with a join on (project_key, checkpoint_id, uploaded_at = MAX)
    // — same shape as the original SQLite query.
    const latestRows = await pg.all(`
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
    `);

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
router.put('/project-meta', requirePermission('crm_kitting', 'edit'), async (req, res) => {
  const { project_key, crm_owner, phase_zone, pm_owner, target_start } = req.body || {};
  if (!project_key || !String(project_key).trim()) {
    return res.status(400).json({ error: 'project_key required' });
  }
  try {
    await pg.run(`
      INSERT INTO crm_kitting_project_meta (project_key, crm_owner, phase_zone, pm_owner, target_start, updated_by, updated_at)
      VALUES (?,?,?,?,?,?, CURRENT_TIMESTAMP)
      ON CONFLICT(project_key) DO UPDATE SET
        crm_owner    = COALESCE(excluded.crm_owner, crm_kitting_project_meta.crm_owner),
        phase_zone   = COALESCE(excluded.phase_zone, crm_kitting_project_meta.phase_zone),
        pm_owner     = COALESCE(excluded.pm_owner, crm_kitting_project_meta.pm_owner),
        target_start = COALESCE(excluded.target_start, crm_kitting_project_meta.target_start),
        updated_by   = excluded.updated_by,
        updated_at   = CURRENT_TIMESTAMP
    `,
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
