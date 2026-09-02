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
const pg = require('../db/pg');
const { authMiddleware, requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// ── Schema ────────────────────────────────────────────────────────
// The four tables (subcon_hiring, subcon_hiring_steps,
// subcon_hiring_files, subcon_hiring_candidates) now live in the
// migrated Postgres schema — the old idempotent CREATE-IF-NOT-EXISTS
// block ran here at module load in the SQLite days.
// Status enums (unchanged):
//   subcon_hiring.phase   'pre_award' | 'onboarding' | 'done'
//   subcon_hiring.status  'active' | 'cancelled' | 'completed'
//   steps.status          'pending' | 'in_progress' | 'done' | 'blocked'
//   candidates.status     'shortlisted' | 'rejected' | 'awarded'
//   steps.decision_value  e.g. vendor score on Step 4 (drives the gate)

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
async function recomputePhase(db, hiringId) {
  const r = await db.get('SELECT current_step FROM subcon_hiring WHERE id=?', hiringId);
  if (!r) return;
  await db.run('UPDATE subcon_hiring SET phase=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
    phaseForStep(r.current_step), hiringId);
}

// ── ROUTES ────────────────────────────────────────────────────────

// GET /api/subcon-hiring — list all workflows (with site + awarded vendor names)
router.get('/', requirePermission('subcon_hiring', 'view'), async (req, res) => {
  try {
    const rows = await pg.all(`
      SELECT sh.*,
             s.name AS site_name,
             v.name AS awarded_vendor_name,
             u.name AS created_by_name
        FROM subcon_hiring sh
        LEFT JOIN sites s ON s.id = sh.site_id
        LEFT JOIN sub_contractors v ON v.id = sh.awarded_vendor_id
        LEFT JOIN users u ON u.id = sh.created_by
       ORDER BY sh.created_at DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/subcon-hiring/steps-meta — UI uses this to render labels + gates
router.get('/steps-meta', (req, res) => res.json(STEP_META));

// GET /api/subcon-hiring/:id — detail (workflow + steps + candidates + files)
router.get('/:id', requirePermission('subcon_hiring', 'view'), async (req, res) => {
  try {
    const id = +req.params.id;
    const hiring = await pg.get(`
      SELECT sh.*, s.name AS site_name, s.address AS site_address, s.client_name,
             v.name AS awarded_vendor_name, u.name AS created_by_name
        FROM subcon_hiring sh
        LEFT JOIN sites s ON s.id = sh.site_id
        LEFT JOIN sub_contractors v ON v.id = sh.awarded_vendor_id
        LEFT JOIN users u ON u.id = sh.created_by
       WHERE sh.id = ?
    `, id);
    if (!hiring) return res.status(404).json({ error: 'Workflow not found' });

    const steps = await pg.all(`
      SELECT s.*, u.name AS completed_by_name
        FROM subcon_hiring_steps s
        LEFT JOIN users u ON u.id = s.completed_by
       WHERE s.hiring_id = ?
       ORDER BY s.step_no
    `, id);
    const candidates = await pg.all(`
      SELECT c.*, v.name AS vendor_name, v.phone AS vendor_phone, v.specialization
        FROM subcon_hiring_candidates c
        JOIN sub_contractors v ON v.id = c.vendor_id
       WHERE c.hiring_id = ?
       ORDER BY c.qualification_score DESC NULLS LAST, c.added_at
    `, id);
    const files = await pg.all(`
      SELECT f.*, u.name AS uploaded_by_name
        FROM subcon_hiring_files f
        LEFT JOIN users u ON u.id = f.uploaded_by
       WHERE f.hiring_id = ?
       ORDER BY f.step_no, f.uploaded_at DESC
    `, id);

    res.json({ ...hiring, steps, candidates, files, steps_meta: STEP_META });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/subcon-hiring — create new workflow for a site
router.post('/', requirePermission('subcon_hiring', 'create'), async (req, res) => {
  try {
    const { site_id, scope_description } = req.body || {};
    if (!site_id) return res.status(400).json({ error: 'site_id is required' });
    const site = await pg.get('SELECT id FROM sites WHERE id=?', +site_id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const id = await pg.tx(async (t) => {
      const r = await t.run(`
        INSERT INTO subcon_hiring (site_id, scope_description, current_step, phase, created_by)
        VALUES (?, ?, 1, 'pre_award', ?)
      `, +site_id, scope_description || null, req.user.id);
      const hiringId = r.lastInsertRowid;
      // Seed 14 step rows; step 1 starts as 'in_progress' so the UI
      // immediately shows where to act.
      for (let i = 1; i <= 14; i++) {
        await t.run(`INSERT INTO subcon_hiring_steps (hiring_id, step_no, status) VALUES (?, ?, ?)`,
          hiringId, i, i === 1 ? 'in_progress' : 'pending');
      }
      return hiringId;
    });
    res.status(201).json({ id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/subcon-hiring/:id/step/:no — update a single step (notes/status/decision_value)
router.post('/:id/step/:no', requirePermission('subcon_hiring', 'edit'), async (req, res) => {
  try {
    const id = +req.params.id, no = +req.params.no;
    if (!(no >= 1 && no <= 14)) return res.status(400).json({ error: 'step_no must be 1..14' });
    const { status, notes, decision_value } = req.body || {};
    const VALID_STATUS = ['pending', 'in_progress', 'done', 'blocked'];
    if (status && !VALID_STATUS.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${VALID_STATUS.join(', ')}` });
    }

    const existing = await pg.get('SELECT id FROM subcon_hiring_steps WHERE hiring_id=? AND step_no=?', id, no);
    if (!existing) return res.status(404).json({ error: 'Step not found' });

    const completedAt = status === 'done' ? new Date().toISOString() : null;
    const completedBy = status === 'done' ? req.user.id : null;
    await pg.run(`
      UPDATE subcon_hiring_steps
         SET status = COALESCE(?, status),
             notes = COALESCE(?, notes),
             decision_value = COALESCE(?, decision_value),
             completed_by = CASE WHEN ?='done' THEN ? ELSE completed_by END,
             completed_at = CASE WHEN ?='done' THEN ? ELSE completed_at END,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `,
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
        await pg.run(`
          UPDATE subcon_hiring_steps SET status='in_progress', updated_at=CURRENT_TIMESTAMP
           WHERE hiring_id=? AND step_no=? AND status='pending'
        `, id, no + 1);
        await pg.run('UPDATE subcon_hiring SET current_step=GREATEST(current_step, ?), updated_at=CURRENT_TIMESTAMP WHERE id=?',
          no + 1, id);
      }
      if (no === 14) {
        await pg.run(`UPDATE subcon_hiring SET status='completed', updated_at=CURRENT_TIMESTAMP WHERE id=?`, id);
      }
      await recomputePhase(pg, id);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/subcon-hiring/:id/gate/:gate — decide a PASS gate
//   :gate = 'prequalify' (Step 4 → 5 if score≥7 else loop to 3)
//   :gate = 'docs'       (Step 11 → 12 if pass else loop to 8)
// Body: { pass: true|false, decision_value?: number, notes?: string }
router.post('/:id/gate/:gate', requirePermission('subcon_hiring', 'edit'), async (req, res) => {
  try {
    const id = +req.params.id;
    const gate = req.params.gate;
    const { pass, decision_value, notes } = req.body || {};
    if (typeof pass !== 'boolean') return res.status(400).json({ error: 'pass:boolean required' });

    let stepNo, advanceTo, loopBackTo;
    if (gate === 'prequalify') { stepNo = 4;  advanceTo = 5;  loopBackTo = 3; }
    else if (gate === 'docs')  { stepNo = 11; advanceTo = 12; loopBackTo = 8; }
    else return res.status(400).json({ error: 'gate must be prequalify or docs' });

    await pg.tx(async (t) => {
      // Mark gate step itself
      await t.run(`
        UPDATE subcon_hiring_steps
           SET status='done', notes=COALESCE(?, notes), decision_value=COALESCE(?, decision_value),
               completed_by=?, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
         WHERE hiring_id=? AND step_no=?
      `, notes ?? null, decision_value ?? null, req.user.id, id, stepNo);

      if (pass) {
        await t.run(`
          UPDATE subcon_hiring_steps SET status='in_progress', updated_at=CURRENT_TIMESTAMP
           WHERE hiring_id=? AND step_no=?
        `, id, advanceTo);
        await t.run(`UPDATE subcon_hiring SET current_step=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
          advanceTo, id);
      } else {
        // Loop back: reset every step from loopBackTo..stepNo to pending,
        // then mark loopBackTo as in_progress so it's the active step.
        await t.run(`
          UPDATE subcon_hiring_steps SET status='pending', completed_by=NULL, completed_at=NULL,
                                         updated_at=CURRENT_TIMESTAMP
           WHERE hiring_id=? AND step_no BETWEEN ? AND ?
        `, id, loopBackTo, stepNo);
        await t.run(`
          UPDATE subcon_hiring_steps SET status='in_progress', updated_at=CURRENT_TIMESTAMP
           WHERE hiring_id=? AND step_no=?
        `, id, loopBackTo);
        await t.run(`UPDATE subcon_hiring SET current_step=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
          loopBackTo, id);
      }
      await recomputePhase(t, id);
    });
    res.json({ ok: true, looped_back: !pass });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/subcon-hiring/:id/step/:no/upload — multipart file upload
router.post('/:id/step/:no/upload', requirePermission('subcon_hiring', 'edit'),
  upload.single('file'), async (req, res) => {
  try {
    const id = +req.params.id, no = +req.params.no;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!(no >= 1 && no <= 14)) return res.status(400).json({ error: 'step_no must be 1..14' });
    const exists = await pg.get('SELECT id FROM subcon_hiring WHERE id=?', id);
    if (!exists) return res.status(404).json({ error: 'Workflow not found' });

    const r = await pg.run(`
      INSERT INTO subcon_hiring_files (hiring_id, step_no, filename, storage_path, file_type, file_size, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, id, no, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.user.id);
    res.status(201).json({ id: r.lastInsertRowid, filename: req.file.originalname });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/subcon-hiring/file/:fileId — serve the uploaded file
router.get('/file/:fileId', requirePermission('subcon_hiring', 'view'), async (req, res) => {
  try {
    const f = await pg.get('SELECT filename, storage_path, file_type FROM subcon_hiring_files WHERE id=?',
      +req.params.fileId);
    if (!f) return res.status(404).json({ error: 'File not found' });
    const fullPath = path.join(uploadDir, f.storage_path);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File missing on disk' });
    res.setHeader('Content-Type', f.file_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.filename)}"`);
    res.sendFile(fullPath);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/subcon-hiring/file/:fileId
router.delete('/file/:fileId', requirePermission('subcon_hiring', 'edit'), async (req, res) => {
  try {
    const f = await pg.get('SELECT storage_path FROM subcon_hiring_files WHERE id=?', +req.params.fileId);
    if (!f) return res.status(404).json({ error: 'File not found' });
    try { fs.unlinkSync(path.join(uploadDir, f.storage_path)); } catch (e) { /* file already gone */ }
    await pg.run('DELETE FROM subcon_hiring_files WHERE id=?', +req.params.fileId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/subcon-hiring/:id/candidate — add a vendor to the shortlist
// Body: { vendor_id, quote_amount?, qualification_score?, notes? }
router.post('/:id/candidate', requirePermission('subcon_hiring', 'edit'), async (req, res) => {
  try {
    const id = +req.params.id;
    const { vendor_id, quote_amount, qualification_score, notes } = req.body || {};
    if (!vendor_id) return res.status(400).json({ error: 'vendor_id required' });
    const v = await pg.get('SELECT id FROM sub_contractors WHERE id=?', +vendor_id);
    if (!v) return res.status(404).json({ error: 'Vendor not found in Sub-contractor Master' });
    try {
      const r = await pg.run(`
        INSERT INTO subcon_hiring_candidates (hiring_id, vendor_id, quote_amount, qualification_score, notes)
        VALUES (?, ?, ?, ?, ?)
      `, id, +vendor_id, quote_amount || null, qualification_score || null, notes || null);
      res.status(201).json({ id: r.lastInsertRowid });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Vendor already shortlisted' });
      throw e;
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/subcon-hiring/candidate/:cid — update a candidate row
router.patch('/candidate/:cid', requirePermission('subcon_hiring', 'edit'), async (req, res) => {
  try {
    const { quote_amount, qualification_score, notes, status } = req.body || {};
    const VALID = ['shortlisted', 'rejected', 'awarded'];
    if (status && !VALID.includes(status)) return res.status(400).json({ error: 'bad status' });
    await pg.run(`
      UPDATE subcon_hiring_candidates
         SET quote_amount = COALESCE(?, quote_amount),
             qualification_score = COALESCE(?, qualification_score),
             notes = COALESCE(?, notes),
             status = COALESCE(?, status)
       WHERE id = ?
    `, quote_amount ?? null, qualification_score ?? null, notes ?? null, status ?? null, +req.params.cid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/subcon-hiring/candidate/:cid
router.delete('/candidate/:cid', requirePermission('subcon_hiring', 'edit'), async (req, res) => {
  try {
    await pg.run('DELETE FROM subcon_hiring_candidates WHERE id=?', +req.params.cid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/subcon-hiring/:id/award/:cid — pick a winning vendor
// Marks the candidate as 'awarded' (others stay 'shortlisted'), sets
// awarded_vendor_id on the workflow. Doesn't auto-advance steps —
// the user still has to mark Step 6 / 7 done explicitly.
router.post('/:id/award/:cid', requirePermission('subcon_hiring', 'edit'), async (req, res) => {
  try {
    const id = +req.params.id, cid = +req.params.cid;
    const cand = await pg.get('SELECT vendor_id, hiring_id FROM subcon_hiring_candidates WHERE id=?', cid);
    if (!cand || cand.hiring_id !== id) return res.status(404).json({ error: 'Candidate not found' });
    await pg.tx(async (t) => {
      await t.run(`UPDATE subcon_hiring_candidates SET status='awarded' WHERE id=?`, cid);
      await t.run(`UPDATE subcon_hiring SET awarded_vendor_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        cand.vendor_id, id);
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/subcon-hiring/:id — admin / hr only
router.delete('/:id', requirePermission('subcon_hiring', 'delete'), async (req, res) => {
  try {
    await pg.run('DELETE FROM subcon_hiring WHERE id=?', +req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
