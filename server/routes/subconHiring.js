// Sub-contractor Hiring workflow tracker — Phase A (mam 2026-05-28).
//
// Spec: mam shared a 14-step / 2-phase flowchart per site. This file
// implements the manual tracker, file uploads, vendor candidate list,
// award flow, and the two PASS gates with loop-back behaviour:
//
//   Phase 1 — PRE-AWARD (Steps 1-7, owner: PM + Procurement)
//     1  Project Kickoff
//     2  BOQ Scope Split
//     3  Source Vendors
//     4  Pre-Qualify         ← gate: score ≥ 7 → 5, else loop to 3
//     5  RFQ & Negotiate
//     6  Award Decision
//     7  LOI to Vendor       → triggers Phase 2
//
//   Phase 2 — ONBOARDING (Steps 8-14, owner: Legal + HR + PM)
//     8  KYC & Vendor Master
//     9  MSA + NDA
//    10  Safety Induction
//    11  Mobilization Plan    ← gate: docs complete → 12, else loop to 8
//    12  Issue Work Order
//    13  Mobilization Advance
//    14  Site Entry & Setup
//
// Integrations (AI ranker · DocuSign · auto-WO PDF · geo-attendance
// enrol) are out of scope for Phase A and tracked as separate work.

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// ── Schema (idempotent) ───────────────────────────────────────────
try {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS subcon_hiring (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES sites(id),
      scope_description TEXT,
      current_step INTEGER NOT NULL DEFAULT 1,
      phase TEXT NOT NULL DEFAULT 'pre_award',  -- 'pre_award' | 'onboarding' | 'done'
      status TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'cancelled' | 'completed'
      awarded_vendor_id INTEGER REFERENCES sub_contractors(id),
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sch_site   ON subcon_hiring(site_id);
    CREATE INDEX IF NOT EXISTS idx_sch_status ON subcon_hiring(status);

    CREATE TABLE IF NOT EXISTS subcon_hiring_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hiring_id INTEGER NOT NULL REFERENCES subcon_hiring(id) ON DELETE CASCADE,
      step_no INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'in_progress' | 'done' | 'blocked'
      notes TEXT,
      decision_value REAL,                      -- e.g. vendor score on Step 4
      completed_by INTEGER REFERENCES users(id),
      completed_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(hiring_id, step_no)
    );

    CREATE TABLE IF NOT EXISTS subcon_hiring_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hiring_id INTEGER NOT NULL REFERENCES subcon_hiring(id) ON DELETE CASCADE,
      step_no INTEGER NOT NULL,
      filename TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      file_type TEXT,
      file_size INTEGER,
      uploaded_by INTEGER REFERENCES users(id),
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_schf_hiring_step ON subcon_hiring_files(hiring_id, step_no);

    CREATE TABLE IF NOT EXISTS subcon_hiring_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hiring_id INTEGER NOT NULL REFERENCES subcon_hiring(id) ON DELETE CASCADE,
      vendor_id INTEGER NOT NULL REFERENCES sub_contractors(id),
      quote_amount REAL,
      qualification_score REAL,                 -- 0-10, drives Step 4 gate
      status TEXT NOT NULL DEFAULT 'shortlisted', -- 'shortlisted' | 'rejected' | 'awarded'
      notes TEXT,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(hiring_id, vendor_id)
    );
    CREATE INDEX IF NOT EXISTS idx_schc_hiring ON subcon_hiring_candidates(hiring_id);
  `);
} catch (e) {
  console.error('[subcon-hiring] schema init failed:', e.message);
}

// ── File upload setup ─────────────────────────────────────────────
const uploadDir = path.join(__dirname, '..', '..', 'data', 'uploads', 'subcon-hiring');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const safe = (file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `sch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ── Step metadata (for UI labelling) ──────────────────────────────
const STEP_META = [
  { no: 1,  phase: 'pre_award',   label: 'Project Kickoff',     owner: 'PM + Procurement' },
  { no: 2,  phase: 'pre_award',   label: 'BOQ Scope Split',     owner: 'PM + Procurement' },
  { no: 3,  phase: 'pre_award',   label: 'Source Vendors',      owner: 'PM + Procurement' },
  { no: 4,  phase: 'pre_award',   label: 'Pre-Qualify',         owner: 'PM + Procurement', gate: 'prequalify' },
  { no: 5,  phase: 'pre_award',   label: 'RFQ & Negotiate',     owner: 'PM + Procurement' },
  { no: 6,  phase: 'pre_award',   label: 'Award Decision',      owner: 'PM + Procurement' },
  { no: 7,  phase: 'pre_award',   label: 'LOI to Vendor',       owner: 'PM + Procurement' },
  { no: 8,  phase: 'onboarding',  label: 'KYC & Vendor Master', owner: 'Legal + HR + PM' },
  { no: 9,  phase: 'onboarding',  label: 'MSA + NDA',           owner: 'Legal + HR + PM' },
  { no: 10, phase: 'onboarding',  label: 'Safety Induction',    owner: 'Legal + HR + PM' },
  { no: 11, phase: 'onboarding',  label: 'Mobilization Plan',   owner: 'Legal + HR + PM', gate: 'docs' },
  { no: 12, phase: 'onboarding',  label: 'Issue Work Order',    owner: 'Legal + HR + PM' },
  { no: 13, phase: 'onboarding',  label: 'Mobilization Advance', owner: 'Legal + HR + PM' },
  { no: 14, phase: 'onboarding',  label: 'Site Entry & Setup',  owner: 'Legal + HR + PM' },
];

// ── Helpers ───────────────────────────────────────────────────────
function phaseForStep(stepNo) {
  return stepNo <= 7 ? 'pre_award' : 'onboarding';
}
function recomputePhase(db, hiringId) {
  const r = db.prepare('SELECT current_step FROM subcon_hiring WHERE id=?').get(hiringId);
  if (!r) return;
  db.prepare('UPDATE subcon_hiring SET phase=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(phaseForStep(r.current_step), hiringId);
}

// ── ROUTES ────────────────────────────────────────────────────────

// GET /api/subcon-hiring — list all workflows (with site + awarded vendor names)
router.get('/', requirePermission('subcon_hiring', 'view'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT sh.*,
           s.name AS site_name,
           v.name AS awarded_vendor_name,
           u.name AS created_by_name
      FROM subcon_hiring sh
      LEFT JOIN sites s ON s.id = sh.site_id
      LEFT JOIN sub_contractors v ON v.id = sh.awarded_vendor_id
      LEFT JOIN users u ON u.id = sh.created_by
     ORDER BY sh.created_at DESC
  `).all();
  res.json(rows);
});

// GET /api/subcon-hiring/steps-meta — UI uses this to render labels + gates
router.get('/steps-meta', (req, res) => res.json(STEP_META));

// GET /api/subcon-hiring/:id — detail (workflow + steps + candidates + files)
router.get('/:id', requirePermission('subcon_hiring', 'view'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const hiring = db.prepare(`
    SELECT sh.*, s.name AS site_name, s.address AS site_address, s.client_name,
           v.name AS awarded_vendor_name, u.name AS created_by_name
      FROM subcon_hiring sh
      LEFT JOIN sites s ON s.id = sh.site_id
      LEFT JOIN sub_contractors v ON v.id = sh.awarded_vendor_id
      LEFT JOIN users u ON u.id = sh.created_by
     WHERE sh.id = ?
  `).get(id);
  if (!hiring) return res.status(404).json({ error: 'Workflow not found' });

  const steps = db.prepare(`
    SELECT s.*, u.name AS completed_by_name
      FROM subcon_hiring_steps s
      LEFT JOIN users u ON u.id = s.completed_by
     WHERE s.hiring_id = ?
     ORDER BY s.step_no
  `).all(id);
  const candidates = db.prepare(`
    SELECT c.*, v.name AS vendor_name, v.phone AS vendor_phone, v.specialization
      FROM subcon_hiring_candidates c
      JOIN sub_contractors v ON v.id = c.vendor_id
     WHERE c.hiring_id = ?
     ORDER BY c.qualification_score DESC NULLS LAST, c.added_at
  `).all(id);
  const files = db.prepare(`
    SELECT f.*, u.name AS uploaded_by_name
      FROM subcon_hiring_files f
      LEFT JOIN users u ON u.id = f.uploaded_by
     WHERE f.hiring_id = ?
     ORDER BY f.step_no, f.uploaded_at DESC
  `).all(id);

  res.json({ ...hiring, steps, candidates, files, steps_meta: STEP_META });
});

// POST /api/subcon-hiring — create new workflow for a site
router.post('/', requirePermission('subcon_hiring', 'create'), (req, res) => {
  const db = getDb();
  const { site_id, scope_description } = req.body || {};
  if (!site_id) return res.status(400).json({ error: 'site_id is required' });
  const site = db.prepare('SELECT id FROM sites WHERE id=?').get(+site_id);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const tx = db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO subcon_hiring (site_id, scope_description, current_step, phase, created_by)
      VALUES (?, ?, 1, 'pre_award', ?)
    `).run(+site_id, scope_description || null, req.user.id);
    const hiringId = r.lastInsertRowid;
    // Seed 14 step rows; step 1 starts as 'in_progress' so the UI
    // immediately shows where to act.
    const ins = db.prepare(`INSERT INTO subcon_hiring_steps (hiring_id, step_no, status) VALUES (?, ?, ?)`);
    for (let i = 1; i <= 14; i++) ins.run(hiringId, i, i === 1 ? 'in_progress' : 'pending');
    return hiringId;
  });
  const id = tx();
  res.status(201).json({ id });
});

// POST /api/subcon-hiring/:id/step/:no — update a single step (notes/status/decision_value)
router.post('/:id/step/:no', requirePermission('subcon_hiring', 'edit'), (req, res) => {
  const db = getDb();
  const id = +req.params.id, no = +req.params.no;
  if (!(no >= 1 && no <= 14)) return res.status(400).json({ error: 'step_no must be 1..14' });
  const { status, notes, decision_value } = req.body || {};
  const VALID_STATUS = ['pending', 'in_progress', 'done', 'blocked'];
  if (status && !VALID_STATUS.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${VALID_STATUS.join(', ')}` });
  }

  const existing = db.prepare('SELECT id FROM subcon_hiring_steps WHERE hiring_id=? AND step_no=?').get(id, no);
  if (!existing) return res.status(404).json({ error: 'Step not found' });

  const completedAt = status === 'done' ? new Date().toISOString() : null;
  const completedBy = status === 'done' ? req.user.id : null;
  db.prepare(`
    UPDATE subcon_hiring_steps
       SET status = COALESCE(?, status),
           notes = COALESCE(?, notes),
           decision_value = COALESCE(?, decision_value),
           completed_by = CASE WHEN ?='done' THEN ? ELSE completed_by END,
           completed_at = CASE WHEN ?='done' THEN ? ELSE completed_at END,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(
    status ?? null, notes ?? null, decision_value ?? null,
    status, completedBy, status, completedAt, existing.id
  );

  // When a step is marked 'done' and there's no explicit current_step
  // beyond it, advance the workflow to the next step (in_progress).
  // Skipped for gate steps — those advance via the /gate endpoint.
  if (status === 'done') {
    const meta = STEP_META.find(s => s.no === no);
    const isGate = !!meta?.gate;
    if (!isGate && no < 14) {
      db.prepare(`
        UPDATE subcon_hiring_steps SET status='in_progress', updated_at=CURRENT_TIMESTAMP
         WHERE hiring_id=? AND step_no=? AND status='pending'
      `).run(id, no + 1);
      db.prepare('UPDATE subcon_hiring SET current_step=MAX(current_step, ?), updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(no + 1, id);
    }
    if (no === 14) {
      db.prepare(`UPDATE subcon_hiring SET status='completed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(id);
    }
    recomputePhase(db, id);
  }
  res.json({ ok: true });
});

// POST /api/subcon-hiring/:id/gate/:gate — decide a PASS gate
//   :gate = 'prequalify' (Step 4 → 5 if score≥7 else loop to 3)
//   :gate = 'docs'       (Step 11 → 12 if pass else loop to 8)
// Body: { pass: true|false, decision_value?: number, notes?: string }
router.post('/:id/gate/:gate', requirePermission('subcon_hiring', 'edit'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const gate = req.params.gate;
  const { pass, decision_value, notes } = req.body || {};
  if (typeof pass !== 'boolean') return res.status(400).json({ error: 'pass:boolean required' });

  let stepNo, advanceTo, loopBackTo;
  if (gate === 'prequalify') { stepNo = 4;  advanceTo = 5;  loopBackTo = 3; }
  else if (gate === 'docs')  { stepNo = 11; advanceTo = 12; loopBackTo = 8; }
  else return res.status(400).json({ error: 'gate must be prequalify or docs' });

  const tx = db.transaction(() => {
    // Mark gate step itself
    db.prepare(`
      UPDATE subcon_hiring_steps
         SET status='done', notes=COALESCE(?, notes), decision_value=COALESCE(?, decision_value),
             completed_by=?, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
       WHERE hiring_id=? AND step_no=?
    `).run(notes ?? null, decision_value ?? null, req.user.id, id, stepNo);

    if (pass) {
      db.prepare(`
        UPDATE subcon_hiring_steps SET status='in_progress', updated_at=CURRENT_TIMESTAMP
         WHERE hiring_id=? AND step_no=?
      `).run(id, advanceTo);
      db.prepare(`UPDATE subcon_hiring SET current_step=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(advanceTo, id);
    } else {
      // Loop back: reset every step from loopBackTo..stepNo to pending,
      // then mark loopBackTo as in_progress so it's the active step.
      db.prepare(`
        UPDATE subcon_hiring_steps SET status='pending', completed_by=NULL, completed_at=NULL,
                                       updated_at=CURRENT_TIMESTAMP
         WHERE hiring_id=? AND step_no BETWEEN ? AND ?
      `).run(id, loopBackTo, stepNo);
      db.prepare(`
        UPDATE subcon_hiring_steps SET status='in_progress', updated_at=CURRENT_TIMESTAMP
         WHERE hiring_id=? AND step_no=?
      `).run(id, loopBackTo);
      db.prepare(`UPDATE subcon_hiring SET current_step=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(loopBackTo, id);
    }
    recomputePhase(db, id);
  });
  tx();
  res.json({ ok: true, looped_back: !pass });
});

// POST /api/subcon-hiring/:id/step/:no/upload — multipart file upload
router.post('/:id/step/:no/upload', requirePermission('subcon_hiring', 'edit'),
  upload.single('file'), (req, res) => {
  const db = getDb();
  const id = +req.params.id, no = +req.params.no;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!(no >= 1 && no <= 14)) return res.status(400).json({ error: 'step_no must be 1..14' });
  const exists = db.prepare('SELECT id FROM subcon_hiring WHERE id=?').get(id);
  if (!exists) return res.status(404).json({ error: 'Workflow not found' });

  const r = db.prepare(`
    INSERT INTO subcon_hiring_files (hiring_id, step_no, filename, storage_path, file_type, file_size, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, no, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid, filename: req.file.originalname });
});

// GET /api/subcon-hiring/file/:fileId — serve the uploaded file
router.get('/file/:fileId', requirePermission('subcon_hiring', 'view'), (req, res) => {
  const db = getDb();
  const f = db.prepare('SELECT filename, storage_path, file_type FROM subcon_hiring_files WHERE id=?')
    .get(+req.params.fileId);
  if (!f) return res.status(404).json({ error: 'File not found' });
  const fullPath = path.join(uploadDir, f.storage_path);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File missing on disk' });
  res.setHeader('Content-Type', f.file_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.filename)}"`);
  res.sendFile(fullPath);
});

// DELETE /api/subcon-hiring/file/:fileId
router.delete('/file/:fileId', requirePermission('subcon_hiring', 'edit'), (req, res) => {
  const db = getDb();
  const f = db.prepare('SELECT storage_path FROM subcon_hiring_files WHERE id=?').get(+req.params.fileId);
  if (!f) return res.status(404).json({ error: 'File not found' });
  try { fs.unlinkSync(path.join(uploadDir, f.storage_path)); } catch (e) { /* file already gone */ }
  db.prepare('DELETE FROM subcon_hiring_files WHERE id=?').run(+req.params.fileId);
  res.json({ ok: true });
});

// POST /api/subcon-hiring/:id/candidate — add a vendor to the shortlist
// Body: { vendor_id, quote_amount?, qualification_score?, notes? }
router.post('/:id/candidate', requirePermission('subcon_hiring', 'edit'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const { vendor_id, quote_amount, qualification_score, notes } = req.body || {};
  if (!vendor_id) return res.status(400).json({ error: 'vendor_id required' });
  const v = db.prepare('SELECT id FROM sub_contractors WHERE id=?').get(+vendor_id);
  if (!v) return res.status(404).json({ error: 'Vendor not found in Sub-contractor Master' });
  try {
    const r = db.prepare(`
      INSERT INTO subcon_hiring_candidates (hiring_id, vendor_id, quote_amount, qualification_score, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, +vendor_id, quote_amount || null, qualification_score || null, notes || null);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Vendor already shortlisted' });
    throw e;
  }
});

// PATCH /api/subcon-hiring/candidate/:cid — update a candidate row
router.patch('/candidate/:cid', requirePermission('subcon_hiring', 'edit'), (req, res) => {
  const db = getDb();
  const { quote_amount, qualification_score, notes, status } = req.body || {};
  const VALID = ['shortlisted', 'rejected', 'awarded'];
  if (status && !VALID.includes(status)) return res.status(400).json({ error: 'bad status' });
  db.prepare(`
    UPDATE subcon_hiring_candidates
       SET quote_amount = COALESCE(?, quote_amount),
           qualification_score = COALESCE(?, qualification_score),
           notes = COALESCE(?, notes),
           status = COALESCE(?, status)
     WHERE id = ?
  `).run(quote_amount ?? null, qualification_score ?? null, notes ?? null, status ?? null, +req.params.cid);
  res.json({ ok: true });
});

// DELETE /api/subcon-hiring/candidate/:cid
router.delete('/candidate/:cid', requirePermission('subcon_hiring', 'edit'), (req, res) => {
  getDb().prepare('DELETE FROM subcon_hiring_candidates WHERE id=?').run(+req.params.cid);
  res.json({ ok: true });
});

// POST /api/subcon-hiring/:id/award/:cid — pick a winning vendor
// Marks the candidate as 'awarded' (others stay 'shortlisted'), sets
// awarded_vendor_id on the workflow. Doesn't auto-advance steps —
// the user still has to mark Step 6 / 7 done explicitly.
router.post('/:id/award/:cid', requirePermission('subcon_hiring', 'edit'), (req, res) => {
  const db = getDb();
  const id = +req.params.id, cid = +req.params.cid;
  const cand = db.prepare('SELECT vendor_id, hiring_id FROM subcon_hiring_candidates WHERE id=?').get(cid);
  if (!cand || cand.hiring_id !== id) return res.status(404).json({ error: 'Candidate not found' });
  const tx = db.transaction(() => {
    db.prepare(`UPDATE subcon_hiring_candidates SET status='awarded' WHERE id=?`).run(cid);
    db.prepare(`UPDATE subcon_hiring SET awarded_vendor_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(cand.vendor_id, id);
  });
  tx();
  res.json({ ok: true });
});

// DELETE /api/subcon-hiring/:id — admin / hr only
router.delete('/:id', requirePermission('subcon_hiring', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM subcon_hiring WHERE id=?').run(+req.params.id);
  res.json({ ok: true });
});

module.exports = router;
