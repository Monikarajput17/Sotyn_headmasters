const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { parseResume } = require('../utils/resumeParser');
const router = express.Router();
router.use(authMiddleware);

// ── Project-wise manpower plan (mam 2026-06-12) ─────────────────────
// For each UNIQUE project (business_book grouped by project / company
// name) show the total project value, the REQUIRED manpower from the
// value slab, the ACTUAL manpower from the latest DPR, and the gap — so
// HR can see shortages at a glance and hire / redeploy.
//
//   Project value → required manpower:
//     ≤ 5 L → 4 | ≤ 25 L → 6 | ≤ 50 L → 8 | ≤ 1 Cr → 10
//     ≤ 5 Cr → 15 | ≤ 10 Cr → 25 | > 10 Cr → 40
const LAKH = 100000, CRORE = 10000000;
function requiredManpower(value) {
  const v = +value || 0;
  if (v <= 5 * LAKH)  return 4;
  if (v <= 25 * LAKH) return 6;
  if (v <= 50 * LAKH) return 8;
  if (v <= 1 * CRORE) return 10;
  if (v <= 5 * CRORE) return 15;
  if (v <= 10 * CRORE) return 25;
  return 40;
}

// Required Site Eng / Jr. Site Eng / Foreman per project (mam 2026-06-13):
// every project needs 1 Jr. Site Eng + 1 Foreman; a senior Site Engineer is
// only needed once the project crosses ₹1.5 Cr.  Each is editable per project
// with the ✏️ if a project needs more.
const ENG_THRESHOLD = 1.5 * CRORE;
function requiredEngineers(value) {
  const big = (+value || 0) >= ENG_THRESHOLD;
  return { se: big ? 1 : 0, jr: 1, fm: 1 };
}

// Classify a PO-linked person by their assigned ROLE(S) — the same role badges
// shown in User Management (e.g. "Jr. Site Eng", "Site Engineer", "Foreman") —
// into one bucket: 'fm' · 'jr' · 'se'.  role_names is the comma-joined list of
// the user's roles.  Foreman wins, then junior; anyone else (incl. a plain
// "Site Engineer" or no matching role) counts as a senior Site Engineer.
function classifyRole(roleNames) {
  const d = String(roleNames || '').toLowerCase();
  if (d.includes('foreman')) return 'fm';
  if (/\b(jr|jnr|junior|trainee|gte|asst|assistant)\b/.test(d) || d.includes('junior')) return 'jr';
  return 'se';
}

router.get('/manpower-plan', (req, res) => {
  const db = getDb();
  const bbs = db.prepare(
    `SELECT id, lead_no, project_name, company_name, client_name, po_amount, status
       FROM business_book`
  ).all();
  const sites = db.prepare(`SELECT id, business_book_id FROM sites`).all();
  // Manpower per DPR: prefer the sum of dpr_contractors.manpower, else the
  // legacy dpr.contractor_manpower.  One row per DPR.
  const dprRows = db.prepare(
    `SELECT d.id, d.site_id, d.report_date,
            CASE WHEN COALESCE(SUM(dc.manpower), 0) > 0 THEN SUM(dc.manpower)
                 ELSE COALESCE(d.contractor_manpower, 0) END AS mp
       FROM dpr d
       LEFT JOIN dpr_contractors dc ON dc.dpr_id = d.id
      GROUP BY d.id`
  ).all();
  // Group business_book rows into unique projects by normalized name.
  const norm = s => String(s || '').trim();
  const keyOf = bb => (norm(bb.project_name) || norm(bb.company_name) || norm(bb.client_name)
    || (bb.lead_no ? `Lead ${bb.lead_no}` : `BB#${bb.id}`)).toLowerCase();
  const groupByBB = new Map();   // business_book_id → group key
  const groups = new Map();      // key → { project, value, mpSum, mpCount, last_dpr_date }
  for (const bb of bbs) {
    const key = keyOf(bb);
    groupByBB.set(bb.id, key);
    const display = norm(bb.project_name) || norm(bb.company_name) || norm(bb.client_name)
      || (bb.lead_no ? `Lead ${bb.lead_no}` : `BB#${bb.id}`);
    if (!groups.has(key)) groups.set(key, { key, project: display, value: 0, mpSum: 0, mpCount: 0, last_dpr_date: null, engUserIds: new Set() });
    groups.get(key).value += +bb.po_amount || 0;
  }
  const siteToBB = new Map();
  for (const s of sites) siteToBB.set(s.id, s.business_book_id);
  // Actual = AVERAGE manpower across the project's DPRs (mam 2026-06-12:
  // "actual from dpr average").  Only DPRs that actually recorded manpower
  // (mp > 0) count toward the average, so unrecorded days don't drag it to 0.
  for (const r of dprRows) {
    const bbId = siteToBB.get(r.site_id);
    if (bbId == null) continue;
    const g = groups.get(groupByBB.get(bbId));
    if (!g) continue;
    const mp = +r.mp || 0;
    if (mp > 0) { g.mpSum += mp; g.mpCount += 1; }
    if (r.report_date && (!g.last_dpr_date || r.report_date > g.last_dpr_date)) g.last_dpr_date = r.report_date;
  }

  // Actual Site Eng / Jr. Site Eng / Foreman per project (mam 2026-06-13):
  // the site engineers attached to each project's POs, classified by their
  // assigned ROLE (same badge shown in User Management), counting only ACTIVE
  // users.  So someone whose role is "Jr. Site Eng" lands in Jr, not Site Eng.
  try {
    const pos = db.prepare(
      `SELECT business_book_id, site_engineer_id, site_engineer_ids FROM purchase_orders`
    ).all();
    for (const po of pos) {
      const g = groups.get(groupByBB.get(po.business_book_id));
      if (!g) continue;
      if (po.site_engineer_id) g.engUserIds.add(po.site_engineer_id);
      if (po.site_engineer_ids) {
        String(po.site_engineer_ids).split(',').map(s => parseInt(s, 10))
          .filter(Boolean).forEach(i => g.engUserIds.add(i));
      }
    }
    const allEngIds = [...new Set([...groups.values()].flatMap(g => [...g.engUserIds]))];
    if (allEngIds.length) {
      const ph = allEngIds.map(() => '?').join(',');
      // Active users only, each with the comma-joined list of their role names.
      const userMap = new Map(
        db.prepare(
          `SELECT u.id, u.name, GROUP_CONCAT(r.name) AS role_names
             FROM users u
             LEFT JOIN user_roles ur ON ur.user_id = u.id
             LEFT JOIN roles r ON r.id = ur.role_id
            WHERE u.id IN (${ph}) AND u.active = 1
            GROUP BY u.id`
        ).all(...allEngIds).map(u => [u.id, u])
      );
      for (const g of groups.values()) {
        const seN = [], jrN = [], fmN = [];
        for (const uid of g.engUserIds) {
          const u = userMap.get(uid);
          if (!u) continue;            // inactive or missing user → not counted
          const nm = (u.name || '').trim();
          const bucket = classifyRole(u.role_names);
          if (bucket === 'fm') fmN.push(nm); else if (bucket === 'jr') jrN.push(nm); else seN.push(nm);
        }
        g.seActual = seN.length; g.jrActual = jrN.length; g.fmActual = fmN.length;
        g.seNames = seN; g.jrNames = jrN; g.fmNames = fmN;
      }
    }
  } catch (e) { /* purchase_orders / roles tables may be absent on a stale DB */ }

  // Per-project settings — category + required override, keyed by project key.
  const settings = new Map();
  try {
    for (const s of db.prepare(`SELECT project_key, required_override, category, site_eng_override, jr_site_eng_override, foreman_override FROM manpower_project_settings`).all()) {
      settings.set(s.project_key, s);
    }
  } catch (e) { /* table may not exist on a very stale DB */ }

  const projects = [...groups.values()].map(g => {
    const s = settings.get(g.key) || {};
    const category = s.category || '';
    const isHandover = category === 'Handover';           // no team required, no planning
    const requiredAuto = requiredManpower(g.value);
    const ov = s.required_override;
    const overridden = !isHandover && ov != null && ov >= 0;
    const required = isHandover ? 0 : (overridden ? ov : requiredAuto);
    const actual = g.mpCount > 0 ? Math.round(g.mpSum / g.mpCount) : 0;
    // Site Eng / Jr. Site Eng / Foreman — required from the value rule, with
    // optional per-project override.  Handover projects need none.
    const engAuto = requiredEngineers(g.value);
    const seOv = s.site_eng_override, jrOv = s.jr_site_eng_override, fmOv = s.foreman_override;
    const seOverridden = !isHandover && seOv != null && seOv >= 0;
    const jrOverridden = !isHandover && jrOv != null && jrOv >= 0;
    const fmOverridden = !isHandover && fmOv != null && fmOv >= 0;
    const seRequired = isHandover ? 0 : (seOverridden ? seOv : engAuto.se);
    const jrRequired = isHandover ? 0 : (jrOverridden ? jrOv : engAuto.jr);
    const fmRequired = isHandover ? 0 : (fmOverridden ? fmOv : engAuto.fm);
    const seActual = g.seActual || 0;
    const jrActual = g.jrActual || 0;
    const fmActual = g.fmActual || 0;
    return {
      key: g.key,
      project: g.project,
      value: Math.round(g.value),
      category,
      is_handover: isHandover,
      required,
      required_auto: requiredAuto,
      required_overridden: overridden,
      actual,
      gap: required - actual,            // > 0 = short (hire), < 0 = surplus
      // Site Engineers
      se_required: seRequired,
      se_required_auto: engAuto.se,
      se_required_overridden: seOverridden,
      se_actual: seActual,
      se_gap: seRequired - seActual,
      se_names: g.seNames || [],
      // Jr. Site Engineers
      jr_required: jrRequired,
      jr_required_auto: engAuto.jr,
      jr_required_overridden: jrOverridden,
      jr_actual: jrActual,
      jr_gap: jrRequired - jrActual,
      jr_names: g.jrNames || [],
      // Foreman
      fm_required: fmRequired,
      fm_required_auto: engAuto.fm,
      fm_required_overridden: fmOverridden,
      fm_actual: fmActual,
      fm_gap: fmRequired - fmActual,
      fm_names: g.fmNames || [],
      last_dpr_date: g.last_dpr_date,
    };
  }).sort((a, b) => b.gap - a.gap || b.value - a.value);
  res.json(projects);
});

// PUT a manual override of a project's required manpower (mam 2026-06-12:
// "admin wants to edit required manpower give then access").  Gated by hr
// EDIT permission (admins always pass).  Body { key, required }.  A blank /
// 0 / null required RESETS the project back to the auto value-slab number.
router.put('/manpower-plan/required', requirePermission('hr', 'edit'), (req, res) => {
  const db = getDb();
  const key = String(req.body?.key || '').trim();
  if (!key) return res.status(400).json({ error: 'project key is required' });
  // role selects which target is being edited: manpower (default), Site
  // Engineers, or Jr. Site Engineers — all stored on the same settings row.
  const COLS = { manpower: 'required_override', site_eng: 'site_eng_override', jr_site_eng: 'jr_site_eng_override', foreman: 'foreman_override' };
  const col = COLS[req.body?.role] || COLS.manpower;
  const raw = req.body?.required;
  const reset = raw === '' || raw === null || raw === undefined || +raw <= 0;
  try {
    if (reset) {
      // Clear this override but keep the rest of the row.
      db.prepare(`UPDATE manpower_project_settings SET ${col}=NULL, updated_at=CURRENT_TIMESTAMP WHERE project_key=?`).run(key);
      return res.json({ ok: true, reset: true });
    }
    const required = Math.round(+raw);
    if (!Number.isFinite(required) || required > 100000) return res.status(400).json({ error: 'required must be a positive number' });
    db.prepare(
      `INSERT INTO manpower_project_settings (project_key, ${col}, updated_by, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(project_key) DO UPDATE SET ${col}=excluded.${col}, updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`
    ).run(key, required, req.user.id);
    res.json({ ok: true, required });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT a project's category (mam 2026-06-12): Live / Old / Service Team /
// Handover.  Handover means no team required + no planning.  Gated by hr
// edit permission; an empty / unknown value clears the category.
router.put('/manpower-plan/category', requirePermission('hr', 'edit'), (req, res) => {
  const db = getDb();
  const key = String(req.body?.key || '').trim();
  if (!key) return res.status(400).json({ error: 'project key is required' });
  const ALLOWED = ['Live', 'Hold', 'Service Team', 'Handover'];
  const category = ALLOWED.includes(req.body?.category) ? req.body.category : null;
  try {
    db.prepare(
      `INSERT INTO manpower_project_settings (project_key, category, updated_by, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(project_key) DO UPDATE SET category=excluded.category, updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`
    ).run(key, category, req.user.id);
    res.json({ ok: true, category });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mam (2026-05-22): bulk Excel upload for checklists.  Re-uses the
// /data/uploads dir + 10MB cap so behaviour matches the PO/BOQ
// upload flow.  File is deleted after parsing to avoid junk.
//
// Wrap mkdir in try/catch so a bad uploads dir / perm issue can't
// crash the whole hr.js require — that would 502 the entire ERP.
// If the dir can't be created we fall back to multer's default
// (OS temp dir) so the route still works.
const checklistsExcelDir = path.join(__dirname, '..', '..', 'data', 'uploads', 'checklists-excel');
let checklistsExcelUpload;
try {
  if (!fs.existsSync(checklistsExcelDir)) fs.mkdirSync(checklistsExcelDir, { recursive: true });
  checklistsExcelUpload = multer({ dest: checklistsExcelDir, limits: { fileSize: 10 * 1024 * 1024 } });
} catch (e) {
  console.warn('[hr] checklistsExcelDir setup failed, falling back to OS temp:', e.message);
  checklistsExcelUpload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });
}

// ── Candidate timeline helper (mam 2026-05-22 ATS spec) ─────────
// Every status-change / decision / tag-edit / hold-toggle calls this
// so the candidate detail view shows a chronological audit log
// without scattering INSERT statements through every route.
// Fails silently — a missing timeline row should NEVER block the
// underlying business action (the actual candidate update is what
// HR cares about).
function logEvent(db, candidateId, eventType, opts = {}) {
  try {
    db.prepare(`INSERT INTO candidate_events
                  (candidate_id, event_type, from_status, to_status, note, user_id, user_name)
                VALUES (?,?,?,?,?,?,?)`)
      .run(
        +candidateId,
        eventType,
        opts.from_status || null,
        opts.to_status   || null,
        opts.note        || null,
        opts.user_id     || null,
        opts.user_name   || null,
      );
  } catch (e) {
    console.warn('[hr/logEvent] failed:', e.message);
  }
}

// Resume uploads land here so we can parse + retain.  Same /uploads
// static handler serves them back.
const resumeDir = path.join(__dirname, '..', '..', 'data', 'uploads', 'hr-resumes');
if (!fs.existsSync(resumeDir)) fs.mkdirSync(resumeDir, { recursive: true });
const resumeUpload = multer({
  storage: multer.diskStorage({
    destination: resumeDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '.pdf');
      cb(null, `cv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ── POST /hr/candidates/parse-resume ───────────────────────────
// Mam (2026-05-22): "when upload resume name, mobile number,
// email-id, address, automatically fill here".  Frontend sends the
// file BEFORE the candidate is created.  We:
//   1. Save it under /uploads/hr-resumes/...
//   2. Parse it (pdf-parse / mammoth / txt) via resumeParser.
//   3. Return parsed fields + the saved file URL.
// Frontend pre-fills the form fields and stores resume_file so when
// admin clicks Add Candidate the URL is sent along.
router.post('/candidates/parse-resume', resumeUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `/uploads/hr-resumes/${path.basename(req.file.path)}`;
  try {
    const parsed = await parseResume(req.file.path, req.file.mimetype || '');
    res.json({ ok: true, resume_url: url, parsed });
  } catch (e) {
    // Even if parsing failed, the file was saved — let admin proceed.
    console.warn('[hr/parse-resume] failed:', e.message);
    res.json({ ok: true, resume_url: url, parsed: null, error: e.message });
  }
});

// Candidates
router.get('/candidates', (req, res) => {
  const { status, source } = req.query;
  // Join employees so the row carries the interviewer's name. md_decision /
  // interview_decision / file fields come along with the SELECT * so the
  // pipeline UI can decide which action button to show next.
  let sql = `SELECT c.*, e.name as interviewer_name
               FROM candidates c
               LEFT JOIN employees e ON e.id = c.interviewer_id
              WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND c.status=?'; params.push(status); }
  if (source) { sql += ' AND c.source=?'; params.push(source); }
  sql += ' ORDER BY c.created_at DESC';
  res.json(getDb().prepare(sql).all(...params));
});

// ── Duplicate-detection helper (mam 2026-05-22 ATS spec) ─────────
// "Candidate duplicate detection" — match on normalised email OR last-10-
// digit phone.  Returns an array of {id, name, status, created_at} the
// frontend can show in a warning dialog before letting admin save.
function findDuplicates(db, { email, phone, excludeId } = {}) {
  const dups = [];
  const seen = new Set();
  const push = (rows) => {
    for (const r of rows) {
      if (excludeId && r.id === +excludeId) continue;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      dups.push(r);
    }
  };
  if (email && String(email).trim()) {
    push(db.prepare(
      `SELECT id, name, status, phone, email, position, created_at
         FROM candidates WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))`
    ).all(email));
  }
  if (phone && String(phone).trim()) {
    const last10 = String(phone).replace(/\D/g, '').slice(-10);
    if (last10.length === 10) {
      push(db.prepare(
        `SELECT id, name, status, phone, email, position, created_at
           FROM candidates
          WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'+',''),'(','') LIKE '%' || ? || '%'`
      ).all(last10));
    }
  }
  return dups;
}

// Preflight duplicate check — frontend calls this before opening the
// Add Candidate modal to warn early.  Returns { duplicates: [...] }.
router.post('/candidates/check-duplicates', (req, res) => {
  const { email, phone, excludeId } = req.body || {};
  res.json({ duplicates: findDuplicates(getDb(), { email, phone, excludeId }) });
});

router.post('/candidates', (req, res) => {
  try {
    const { name, phone, email, source, position, notes, resume_file,
            address, linkedin_url, tags, hiring_request_id } = req.body;
    const force = req.query.force === '1' || req.body.force === true;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
    // SQLite CHECK on source must match one of the allowed values, else the
    // row is rejected with a cryptic constraint error. Validate up-front so
    // HR sees a clean message ('Source must be one of...') instead of a 500.
    const allowedSources = ['facebook','naukri','linkedin','reference','other'];
    const src = source && allowedSources.includes(source) ? source : 'other';
    const db = getDb();
    // Mam (2026-05-22): duplicate detection BEFORE insert — if email or
    // phone already exists on another candidate, refuse with 409 +
    // duplicates list so frontend can show "Existing candidate found —
    // open existing / save anyway".  Pass ?force=1 to bypass.
    if (!force) {
      const dups = findDuplicates(db, { email, phone });
      if (dups.length) {
        return res.status(409).json({
          error: 'Duplicate candidate found',
          duplicates: dups,
          hint: 'Re-submit with ?force=1 to save anyway, or open the existing candidate from the list.',
        });
      }
    }
    const r = db.prepare(
      `INSERT INTO candidates (name, phone, email, source, position, notes, resume_file, address, linkedin_url, tags, hiring_request_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(name, phone || null, email || null, src, position || null, notes || null,
          resume_file || null, address || null, linkedin_url || null,
          tags || null, hiring_request_id ? +hiring_request_id : null);
    logEvent(db, r.lastInsertRowid, 'created', {
      to_status: 'lead', user_id: req.user.id, user_name: req.user.name,
      note: force ? 'Created (duplicate check bypassed)' : 'Candidate created',
    });
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (err) {
    console.error('POST /hr/candidates error', err);
    res.status(500).json({ error: err.message || 'Failed to add candidate' });
  }
});

router.put('/candidates/:id', (req, res) => {
  const { name, phone, email, source, position, status, notes, resume_file,
          address, linkedin_url } = req.body;
  getDb().prepare(
    `UPDATE candidates SET name=?, phone=?, email=?, source=?, position=?, status=?, notes=?,
       resume_file = COALESCE(?, resume_file),
       address = COALESCE(?, address),
       linkedin_url = COALESCE(?, linkedin_url)
     WHERE id=?`
  ).run(name, phone, email, source, position, status, notes,
        resume_file || null, address || null, linkedin_url || null, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/candidates/:id', (req, res) => {
  getDb().prepare('DELETE FROM candidates WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ---------- HIRING PIPELINE STAGE ACTIONS ----------
// mam's flow:
//  Stage 1 — Schedule first interview: HR picks interviewer (from employees) +
//            date/time + uploads resume (file URL from /upload). status moves
//            to 'interview_scheduled'.
//  Stage 2 — Mark interview done: interviewer records decision +
//            notes. status moves to 'interview_done', then 'qualified' if
//            shortlisted or 'rejected' if not.
//  Stage 3 — Schedule MD interview: HR picks date for MD round.
//            status stays 'qualified' (now means "MD round pending").
//  Stage 4 — MD decision: shortlisted → 'offer_sent' + offer_letter_file
//            uploaded; rejected → 'rejected'.
//  Stage 5 — Mark accepted / onboarded as the candidate joins.

router.post('/candidates/:id/schedule-interview', (req, res) => {
  const { interviewer_id, interview_date, resume_file, notes } = req.body;
  if (!interviewer_id) return res.status(400).json({ error: 'Pick an interviewer (employee)' });
  if (!interview_date) return res.status(400).json({ error: 'Interview date required' });
  const db = getDb();
  const before = db.prepare('SELECT status FROM candidates WHERE id=?').get(req.params.id);
  db.prepare(`UPDATE candidates SET
                interviewer_id = ?,
                interview_date = ?,
                resume_file    = COALESCE(?, resume_file),
                notes          = COALESCE(?, notes),
                status         = 'interview_scheduled'
              WHERE id = ?`)
    .run(+interviewer_id, interview_date, resume_file || null, notes || null, req.params.id);
  const intvName = db.prepare('SELECT name FROM employees WHERE id=?').get(+interviewer_id)?.name || '?';
  logEvent(db, req.params.id, 'interview_scheduled', {
    from_status: before?.status, to_status: 'interview_scheduled',
    note: `Interview with ${intvName} on ${interview_date}`,
    user_id: req.user.id, user_name: req.user.name,
  });
  res.json({ message: 'Interview scheduled' });
});

router.post('/candidates/:id/interview-done', (req, res) => {
  const { decision, notes } = req.body;
  if (!['shortlisted','rejected','on_hold'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be shortlisted / rejected / on_hold' });
  }
  // shortlisted → 'qualified' (waiting for MD round)
  // rejected    → 'rejected'
  // on_hold     → stays 'interview_done' for HR to come back later
  const newStatus = decision === 'shortlisted' ? 'qualified'
                  : decision === 'rejected'    ? 'rejected'
                  :                              'interview_done';
  const db = getDb();
  const before = db.prepare('SELECT status FROM candidates WHERE id=?').get(req.params.id);
  db.prepare(`UPDATE candidates SET
                     interview_decision = ?,
                     interview_notes    = COALESCE(?, interview_notes),
                     status             = ?
                   WHERE id = ?`)
    .run(decision, notes || null, newStatus, req.params.id);
  logEvent(db, req.params.id, 'interview_done', {
    from_status: before?.status, to_status: newStatus,
    note: `Interview decision: ${decision}${notes ? ' — ' + notes : ''}`,
    user_id: req.user.id, user_name: req.user.name,
  });
  res.json({ message: 'Interview decision recorded' });
});

router.post('/candidates/:id/schedule-md-interview', (req, res) => {
  const { md_interview_date, notes } = req.body;
  if (!md_interview_date) return res.status(400).json({ error: 'MD interview date required' });
  // Status stays 'qualified' — md_interview_date being set marks the MD round.
  const db = getDb();
  db.prepare(`UPDATE candidates SET
                     md_interview_date = ?,
                     notes             = COALESCE(?, notes)
                   WHERE id = ?`)
    .run(md_interview_date, notes || null, req.params.id);
  logEvent(db, req.params.id, 'md_scheduled', {
    note: `Final round (MD) scheduled on ${md_interview_date}`,
    user_id: req.user.id, user_name: req.user.name,
  });
  res.json({ message: 'MD interview scheduled' });
});

router.post('/candidates/:id/md-decision', (req, res) => {
  const { decision, notes, offer_letter_file,
          offered_position, offered_salary, joining_date, reporting_to,
          salary_breakup } = req.body;
  if (!['shortlisted','rejected'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be shortlisted or rejected' });
  }
  // Mam (2026-05-22): offer letter is ALWAYS auto-generated from
  // these fields using SEPL's standard template — upload path
  // removed.  Position is the minimum required field; salary and
  // joining date come along with it.
  if (decision === 'shortlisted' && !offered_position) {
    return res.status(400).json({ error: 'Position is required so the system can generate the offer letter' });
  }
  const newStatus = decision === 'shortlisted' ? 'offer_sent' : 'rejected';
  const offerSentAt = decision === 'shortlisted' ? new Date().toISOString() : null;
  // Mam (2026-05-22 Batch D): generate a one-shot URL-safe token so
  // the candidate can accept / decline via the public /offer/:token
  // page without logging in.  32 random bytes → ~43 char base64url.
  const offerToken = decision === 'shortlisted'
    ? require('crypto').randomBytes(32).toString('base64url')
    : null;
  const db = getDb();
  const before = db.prepare('SELECT status, offer_token FROM candidates WHERE id=?').get(req.params.id);
  // Preserve existing token if MD re-saves the decision (don't break
  // already-shared accept links).
  const finalToken = offerToken && !before?.offer_token ? offerToken : before?.offer_token;
  db.prepare(`UPDATE candidates SET
                     md_decision        = ?,
                     md_interview_notes = COALESCE(?, md_interview_notes),
                     offer_letter_file  = COALESCE(?, offer_letter_file),
                     offer_sent_at      = COALESCE(?, offer_sent_at),
                     offered_position   = COALESCE(?, offered_position),
                     offered_salary     = COALESCE(?, offered_salary),
                     joining_date       = COALESCE(?, joining_date),
                     reporting_to       = COALESCE(?, reporting_to),
                     salary_breakup     = COALESCE(?, salary_breakup),
                     offer_token        = ?,
                     status             = ?
                   WHERE id = ?`)
    .run(decision, notes || null, offer_letter_file || null, offerSentAt,
         offered_position || null, offered_salary != null ? +offered_salary : null,
         joining_date || null, reporting_to || null,
         salary_breakup ? (typeof salary_breakup === 'string' ? salary_breakup : JSON.stringify(salary_breakup)) : null,
         finalToken,
         newStatus, req.params.id);
  logEvent(db, req.params.id, decision === 'shortlisted' ? 'offer_generated' : 'md_decision', {
    from_status: before?.status, to_status: newStatus,
    note: decision === 'shortlisted'
      ? `MD shortlisted — offer for ${offered_position} @ ₹${offered_salary}/mo, joining ${joining_date}`
      : `MD rejected${notes ? ' — ' + notes : ''}`,
    user_id: req.user.id, user_name: req.user.name,
  });
  res.json({ message: decision === 'shortlisted' ? 'Offer letter ready' : 'Candidate rejected by MD' });
});

// ── GET /hr/candidates/:id ──────────────────────────────────────
// Used by the OfferLetterPrint page to render the auto-generated
// letter.  Lightweight read of all fields the template needs.
router.get('/candidates/:id', (req, res) => {
  const c = getDb().prepare('SELECT * FROM candidates WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Candidate not found' });
  res.json(c);
});

router.post('/candidates/:id/finalize', (req, res) => {
  // Mark candidate as 'accepted' (offer accepted) or 'onboarded' (joined).
  const { final_status, notes } = req.body;
  if (!['accepted','onboarded','rejected'].includes(final_status)) {
    return res.status(400).json({ error: 'final_status must be accepted / onboarded / rejected' });
  }
  const db = getDb();
  const before = db.prepare('SELECT status FROM candidates WHERE id=?').get(req.params.id);
  db.prepare(`UPDATE candidates SET status = ?, notes = COALESCE(?, notes) WHERE id = ?`)
    .run(final_status, notes || null, req.params.id);
  logEvent(db, req.params.id, 'finalised', {
    from_status: before?.status, to_status: final_status,
    note: `Final status: ${final_status}${notes ? ' — ' + notes : ''}`,
    user_id: req.user.id, user_name: req.user.name,
  });
  res.json({ message: 'Status updated' });
});

// ── HR Phase 1 (mam 2026-05-22 spec) — extras on the candidate row ───
//
// GET  /candidates/:id/timeline  → chronological audit log for one candidate.
// PUT  /candidates/:id/tags      → save free-form CSV tag chips.
// POST /candidates/:id/hold      → toggle is_on_hold (any pipeline stage).
//
router.get('/candidates/:id/timeline', (req, res) => {
  const rows = getDb().prepare(
    `SELECT id, event_type, from_status, to_status, note, user_id, user_name, created_at
       FROM candidate_events WHERE candidate_id = ? ORDER BY created_at DESC, id DESC`
  ).all(req.params.id);
  res.json(rows);
});

router.put('/candidates/:id/tags', (req, res) => {
  const { tags } = req.body || {};
  // Normalise: split on comma, trim, drop empties, re-join.
  const csv = String(tags || '')
    .split(',').map(s => s.trim()).filter(Boolean).join(',') || null;
  const db = getDb();
  db.prepare('UPDATE candidates SET tags = ? WHERE id = ?').run(csv, req.params.id);
  logEvent(db, req.params.id, 'tags_updated', {
    note: csv ? `Tags: ${csv}` : 'Tags cleared',
    user_id: req.user.id, user_name: req.user.name,
  });
  res.json({ ok: true, tags: csv });
});

router.post('/candidates/:id/hold', (req, res) => {
  const { is_on_hold, reason } = req.body || {};
  const flag = is_on_hold ? 1 : 0;
  const db = getDb();
  db.prepare('UPDATE candidates SET is_on_hold = ?, hold_reason = ? WHERE id = ?')
    .run(flag, flag ? (reason || null) : null, req.params.id);
  logEvent(db, req.params.id, flag ? 'hold_on' : 'hold_off', {
    note: flag ? `On hold: ${reason || '(no reason given)'}` : 'Hold removed',
    user_id: req.user.id, user_name: req.user.name,
  });
  res.json({ ok: true, is_on_hold: flag });
});

router.get('/candidates/stats', (req, res) => {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as count FROM candidates').get();
  const byStatus = db.prepare('SELECT status, COUNT(*) as count FROM candidates GROUP BY status').all();
  const bySource = db.prepare('SELECT source, COUNT(*) as count FROM candidates GROUP BY source').all();
  res.json({ total: total.count, byStatus, bySource });
});

// Employees — salary is confidential; strip it from the response unless the
// requester is an admin or on the HR team (by role name or department).
// JWT only carries { id, role, name, email }, so we look up HR role + dept
// from the DB on each request. The DPR staff-cost endpoint works independently
// via a server-side aggregate, so non-HR users never see individual figures
// even if they are site engineers.
const canSeeSalary = (userId, userRole) => {
  if (userRole === 'admin') return true;
  const db = getDb();
  const u = db.prepare('SELECT department FROM users WHERE id=?').get(userId);
  if (u?.department && String(u.department).toLowerCase().includes('hr')) return true;
  const roles = db.prepare(
    `SELECT r.name FROM user_roles ur JOIN roles r ON ur.role_id=r.id WHERE ur.user_id=?`
  ).all(userId);
  return roles.some(r => String(r.name || '').toLowerCase().includes('hr'));
};

router.get('/employees', (req, res) => {
  const rows = getDb().prepare(
    `SELECT e.*, u.name as linked_user_name, u.username as linked_username
     FROM employees e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.name COLLATE NOCASE`
  ).all();
  if (canSeeSalary(req.user.id, req.user.role)) return res.json(rows);
  // Redact salary for everyone else
  res.json(rows.map(({ salary, ...rest }) => rest));
});

router.post('/employees', requirePermission('employees', 'create'), (req, res) => {
  const { name, phone, email, designation, department, join_date, salary,
          aadhar_file, pan_file, qualification_file } = req.body;
  let { user_id } = req.body;
  const db = getDb();
  // Auto-link by email if user_id wasn't explicitly set
  if (!user_id && email) {
    const u = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email);
    if (u) user_id = u.id;
  }
  // Mandatory documents for NEW employees (not enforced on bulk import or
  // legacy edits — those keep working without docs).
  if (!aadhar_file)        return res.status(400).json({ error: 'Aadhar card is required' });
  if (!pan_file)           return res.status(400).json({ error: 'PAN card is required' });
  if (!qualification_file) return res.status(400).json({ error: 'Highest qualification certificate is required' });
  const r = db.prepare(`
    INSERT INTO employees (user_id,name,phone,email,designation,department,join_date,salary,
                           aadhar_file, pan_file, qualification_file)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(user_id || null, name, phone, email, designation, department, join_date, salary,
        aadhar_file || null, pan_file || null, qualification_file || null);
  res.status(201).json({ id: r.lastInsertRowid, linked_user_id: user_id || null });
});

// Auto-link existing employees to users by matching email (case-insensitive).
// Safe to run any time — only fills rows where user_id IS NULL.
router.post('/employees/auto-link', requirePermission('employees', 'edit'), (req, res) => {
  const db = getDb();
  const candidates = db.prepare(
    `SELECT e.id, u.id as user_id FROM employees e
     JOIN users u ON LOWER(u.email) = LOWER(e.email)
     WHERE e.user_id IS NULL AND e.email IS NOT NULL AND e.email != ''`
  ).all();
  const upd = db.prepare('UPDATE employees SET user_id = ? WHERE id = ?');
  let linked = 0;
  for (const c of candidates) { upd.run(c.user_id, c.id); linked++; }
  res.json({ linked, scanned: candidates.length });
});

// Bulk import employees
router.post('/employees/bulk', requirePermission('employees', 'create'), (req, res) => {
  const { employees } = req.body;
  if (!employees || !Array.isArray(employees) || employees.length === 0) {
    return res.status(400).json({ error: 'No employee data provided' });
  }
  const db = getDb();
  const insert = db.prepare('INSERT INTO employees (name,phone,email,designation,department,join_date,salary) VALUES (?,?,?,?,?,?,?)');
  let added = 0, errors = [];
  for (let i = 0; i < employees.length; i++) {
    const e = employees[i];
    if (!e.name || !e.name.trim()) { errors.push(`Row ${i + 1}: Name is required`); continue; }
    try {
      insert.run(e.name?.trim(), e.phone?.trim() || '', e.email?.trim() || '', e.designation?.trim() || '', e.department?.trim() || '', e.join_date || '', e.salary || 0);
      added++;
    } catch (err) { errors.push(`Row ${i + 1}: ${err.message}`); }
  }
  res.json({ added, errors, total: employees.length });
});

router.put('/employees/:id', requirePermission('employees', 'edit'), (req, res) => {
  const { name, phone, email, designation, department, salary, status, user_id,
          aadhar_file, pan_file, qualification_file } = req.body;
  // COALESCE so passing undefined for a doc field doesn't wipe the existing
  // upload — frontend can edit other fields without re-uploading docs.
  getDb().prepare(`
    UPDATE employees
       SET name=?, phone=?, email=?, designation=?, department=?, salary=?, status=?, user_id=?,
           aadhar_file        = COALESCE(?, aadhar_file),
           pan_file           = COALESCE(?, pan_file),
           qualification_file = COALESCE(?, qualification_file)
     WHERE id=?
  `).run(name, phone, email, designation, department, salary, status, user_id || null,
        aadhar_file || null, pan_file || null, qualification_file || null, req.params.id);
  res.json({ message: 'Updated' });
});

// Delete an employee. Robust like the user delete (auth.js): a bare
// `DELETE FROM employees` used to throw an uncaught FOREIGN KEY error whenever
// the person had payroll or interview history — the admin just saw "Delete
// failed" / "FOREIGN KEY constraint failed" with no reason and no way forward
// (mam 2026-07-06: "not able to delete old employees"). Now:
//   • Payroll history → BLOCK (400) and tell them to deactivate — nulling or
//     deleting salary rows corrupts payroll (same rule as users + attendance).
//   • Interview / hiring links (interviewer, reporting-manager) → these are
//     nullable soft references; a normal delete surfaces a clear 409, and
//     ?force=1 unlinks them first, then deletes.
router.delete('/employees/:id', requirePermission('employees', 'delete'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const force = req.query.force === '1';
  const emp = db.prepare('SELECT id, name, status FROM employees WHERE id=?').get(id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  // Salary safety — an employee with ANY payroll history must never be
  // hard-deleted; deactivate (Status → inactive/terminated) instead so every
  // salary record stays intact. Blocks normal AND force delete.
  const payTotal =
    db.prepare('SELECT COUNT(*) c FROM payroll_runs WHERE employee_id=?').get(id).c +
    db.prepare('SELECT COUNT(*) c FROM payroll_advances WHERE employee_id=?').get(id).c;
  if (payTotal > 0) {
    return res.status(400).json({
      error: `"${emp.name}" has ${payTotal} salary/payroll record${payTotal === 1 ? '' : 's'} — deleting would break payroll. Set their Status to "inactive" or "terminated" instead (Edit → Status): all salary history stays intact and they drop off the active list.`,
      payroll_count: payTotal,
      suggest: 'deactivate',
    });
  }

  // Nullable interview/hiring links that FK-block the delete. Safe to unlink on
  // force (they only record "who interviewed / who was reporting manager").
  // training_assignments is ON DELETE CASCADE, so it clears itself.
  const SOFT_REFS = [
    ['candidates', 'interviewer_id'],
    ['hiring_requests', 'reporting_manager_id'],
    ['interview_scorecards', 'interviewer_id'],
  ];

  if (force) {
    try {
      const cleared = {};
      db.transaction(() => {
        for (const [t, c] of SOFT_REFS) {
          try {
            const r = db.prepare(`UPDATE "${t}" SET "${c}"=NULL WHERE "${c}"=?`).run(id);
            if (r.changes > 0) cleared[`${t}.${c}`] = r.changes;
          } catch (e) { console.warn('[emp-delete] could not clear', `${t}.${c}`, '-', e.message); }
        }
        db.prepare('DELETE FROM employees WHERE id=?').run(id);
      })();
      return res.json({ message: `Employee "${emp.name}" force-deleted`, cleared });
    } catch (e) {
      console.error('[emp-delete force] failed:', e.message);
      return res.status(500).json({ error: `Force-delete failed: ${e.message}` });
    }
  }

  try {
    db.prepare('DELETE FROM employees WHERE id=?').run(id);
    res.json({ message: 'Deleted' });
  } catch (e) {
    let refCount = 0;
    for (const [t, c] of SOFT_REFS) {
      try { refCount += db.prepare(`SELECT COUNT(*) c FROM "${t}" WHERE "${c}"=?`).get(id).c; } catch (_) {}
    }
    res.status(409).json({
      error: `Delete blocked: "${emp.name}" is still linked to ${refCount || 'other'} interview/hiring record${refCount === 1 ? '' : 's'}.`,
      reference_count: refCount,
      hint: 'Force Delete unlinks those (interviewer / reporting-manager) then deletes. Or set Status to inactive/terminated to keep the record.',
    });
  }
});

// Sub-Contractors
router.get('/sub-contractors', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM sub_contractors ORDER BY name').all());
});

router.post('/sub-contractors', (req, res) => {
  const { name, phone, email, specialization, rate, rate_unit, notes } = req.body;
  const r = getDb().prepare('INSERT INTO sub_contractors (name,phone,email,specialization,rate,rate_unit,notes) VALUES (?,?,?,?,?,?,?)')
    .run(name, phone, email, specialization, rate, rate_unit, notes);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/sub-contractors/:id', (req, res) => {
  const { name, phone, email, specialization, rate, rate_unit, status, notes } = req.body;
  getDb().prepare('UPDATE sub_contractors SET name=?,phone=?,email=?,specialization=?,rate=?,rate_unit=?,status=?,notes=? WHERE id=?')
    .run(name, phone, email, specialization, rate, rate_unit, status, notes, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/sub-contractors/:id', (req, res) => {
  getDb().prepare('DELETE FROM sub_contractors WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Expenses
router.get('/expenses', (req, res) => {
  res.json(getDb().prepare(`SELECT e.*, u1.name as submitted_by_name, u2.name as approved_by_name FROM expenses e
    LEFT JOIN users u1 ON e.submitted_by=u1.id LEFT JOIN users u2 ON e.approved_by=u2.id ORDER BY e.created_at DESC`).all());
});

router.post('/expenses', requirePermission('expenses', 'create'), (req, res) => {
  const { title, description, amount, category, expense_date } = req.body;
  const db = getDb();
  // Server-side dedup — mam: "entry one time but showing data 4 to 5
  // times". A fast double-click + flaky network was firing 2-4 POSTs
  // before the modal could close, each writing an identical row. We
  // reject any insert that exactly matches the same user's most-recent
  // submission in the last 2 minutes. Returns the existing row so the
  // client still gets a success-style response (idempotent).
  const recent = db.prepare(`
    SELECT id FROM expenses
     WHERE submitted_by = ?
       AND COALESCE(title, '') = COALESCE(?, '')
       AND COALESCE(description, '') = COALESCE(?, '')
       AND amount = ?
       AND COALESCE(category, '') = COALESCE(?, '')
       AND COALESCE(expense_date, '') = COALESCE(?, '')
       AND created_at >= datetime('now', '-2 minutes')
     ORDER BY id DESC LIMIT 1
  `).get(req.user.id, title, description, +amount || 0, category, expense_date);
  if (recent) {
    return res.status(200).json({ id: recent.id, deduped: true, message: 'Identical entry already submitted in the last 2 minutes — kept original.' });
  }
  const r = db.prepare('INSERT INTO expenses (title,description,amount,category,expense_date,submitted_by) VALUES (?,?,?,?,?,?)')
    .run(title, description, +amount || 0, category, expense_date, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/expenses/:id', requirePermission('expenses', 'edit'), (req, res) => {
  // Two flows mam uses, both go through this endpoint:
  //   (1) edit the expense details (title/description/amount/category/date)
  //   (2) change status (approve / reject / mark paid / un-mark paid)
  // Body may contain any subset; missing fields are preserved.
  const { title, description, amount, category, expense_date, status } = req.body;
  const db = getDb();
  const existing = db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const next = {
    title: title !== undefined ? title : existing.title,
    description: description !== undefined ? description : existing.description,
    amount: amount !== undefined ? +amount : existing.amount,
    category: category !== undefined ? category : existing.category,
    expense_date: expense_date !== undefined ? expense_date : existing.expense_date,
    status: status !== undefined ? status : existing.status,
    approved_by: existing.approved_by,
    paid_date: existing.paid_date,
  };

  if (status !== undefined && status !== existing.status) {
    // Forward transitions stamp; reverse transitions clear so audit isn't misleading.
    if (status === 'approved') {
      next.approved_by = req.user.id;
      if (existing.status === 'paid') next.paid_date = null; // un-mark paid
    } else if (status === 'paid') {
      next.paid_date = new Date().toISOString().split('T')[0];
    } else if (status === 'pending') {
      next.approved_by = null;
      next.paid_date = null;
    } else if (status === 'rejected') {
      next.approved_by = req.user.id;
      next.paid_date = null;
    }
  }

  db.prepare(`UPDATE expenses SET title=?, description=?, amount=?, category=?, expense_date=?, status=?, approved_by=?, paid_date=? WHERE id=?`)
    .run(next.title, next.description, next.amount, next.category, next.expense_date, next.status, next.approved_by, next.paid_date, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/expenses/:id', requirePermission('expenses', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM expenses WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Checklists
// List checklists. Admin sees all; regular users see only the ones assigned
// to them so they don't read each other's tasks. Ordered by assignee name
// so the frontend can group the rows under each person.
router.get('/checklists', (req, res) => {
  const db = getDb();
  const isAdmin = req.user.role === 'admin';
  const base = `SELECT c.*, u1.name as assigned_to_name, u2.name as created_by_name
    FROM checklists c
    LEFT JOIN users u1 ON c.assigned_to=u1.id
    LEFT JOIN users u2 ON c.created_by=u2.id`;
  const order = ` ORDER BY u1.name COLLATE NOCASE, c.frequency, c.due_time, c.created_at DESC`;
  if (isAdmin) {
    res.json(db.prepare(base + order).all());
  } else {
    res.json(db.prepare(base + ' WHERE c.assigned_to=?' + order).all(req.user.id));
  }
});

// Title is derived from the first line (80 chars) of the description since
// the UI no longer asks for it separately.
const deriveTitle = (title, description) => {
  if (title && title.trim()) return title.trim();
  const d = String(description || '').trim();
  return d.split(/\r?\n/)[0].slice(0, 80).trim() || 'Checklist';
};

// Only admins can create / edit / delete checklists. Regular users can read
// and complete (upload proof for) the ones assigned to them.
const adminGuard = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can manage checklists' });
  next();
};

// Mam (2026-05-22): proof_type values accepted by POST + PUT.
// Default 'photo' keeps existing rows working (column default).
const ALLOWED_PROOF_TYPES = ['photo', 'pdf', 'file', 'text', 'none'];

// ═════════════════════════════════════════════════════════════════
// Bulk Excel upload for checklists (mam 2026-05-22)
// ═════════════════════════════════════════════════════════════════
// Admin uploads an .xlsx with one row per task.  Recognised columns
// (case-insensitive, in any order, any subset):
//
//   Description / Task             — required, the task text
//   Proof Name / Label             — optional friendly name
//   Proof Type                     — optional; photo/pdf/file/text/none
//
// We return the parsed rows as JSON so the client can stuff them into
// the Bulk Add modal's textarea (formatted as "Task | Label | Type")
// for the admin to review + tweak + submit via the existing
// /checklists/bulk endpoint.  No DB writes here.

// Download a sample template the admin can fill in.
router.get('/checklists/bulk-template.xlsx', (req, res) => {
  const wb = XLSX.utils.book_new();
  const aoa = [
    ['Description',                                'Proof Name',          'Proof Type', 'Time'],
    ['File monthly GST return',                    'GST File',            'pdf',        '11:00'],
    ['Daily attendance + no-show alerts',          'Attendance Report',   'photo',      '10:30'],
    ['Exit checklist + Day-1 joiner verification', 'Joining Form',        'pdf',        '17:00'],
    ['Send daily WhatsApp report to MD',           'Screenshot',          'photo',      '18:00'],
    ['Reconcile petty cash closing',               'Cash Closing Note',   'text',       '19:30'],
    // Mam (2026-05-22): comma-separated times = one row per slot.
    ['Stock recon + items below ROL',              'Stock Photo',         'photo',      '09:00,13:00,17:00'],
    ['Mark vendor master sheet reviewed',          '',                    'none',       ''],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 50 }, { wch: 24 }, { wch: 12 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Checklists');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="checklists-bulk-template.xlsx"');
  res.send(buf);
});

// Parse an uploaded .xlsx and return the rows as JSON.
// (Client decides whether to commit them via /checklists/bulk.)
router.post('/checklists/parse-excel', checklistsExcelUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  let wb;
  try { wb = XLSX.readFile(req.file.path); }
  catch (e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: 'Could not read the Excel file: ' + e.message });
  }
  // Clean up the temp file regardless of success — we don't keep it
  // around once parsed (admin will edit and resubmit via /bulk).
  const cleanup = () => { try { fs.unlinkSync(req.file.path); } catch {} };

  const sheetName = wb.SheetNames[0];
  if (!sheetName) { cleanup(); return res.status(400).json({ error: 'Excel file has no sheets' }); }
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (rows.length === 0) { cleanup(); return res.status(400).json({ error: 'Sheet is empty' }); }

  // ── Locate the header row.  Most files put it on row 1, but some
  // people leave 1-2 blank lines or a title at the top.  Scan the
  // first 5 rows for any keyword we know how to map.
  const HEADER_KEYWORDS = ['description', 'task', 'proof name', 'proof', 'name', 'label', 'type', 'proof type', 'time', 'time of day', 'due time'];
  let headerIdx = -1;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const cells = (rows[i] || []).map(c => String(c || '').toLowerCase().trim());
    const matches = HEADER_KEYWORDS.filter(k => cells.some(c => c === k || c.includes(k))).length;
    if (matches >= 1) { headerIdx = i; break; }
  }
  // If no headers, treat row 0 as data with column order [desc, label, type, time]
  let descCol = 0, labelCol = 1, typeCol = 2, timeCol = 3;
  if (headerIdx >= 0) {
    const headers = (rows[headerIdx] || []).map(c => String(c || '').toLowerCase().trim());
    const findCol = (...keys) => headers.findIndex(h => keys.some(k => h === k || h.includes(k)));
    const di = findCol('description', 'task');
    const li = findCol('proof name', 'label');
    const ti = findCol('proof type', 'type');
    const tmi = findCol('time of day', 'due time', 'time');
    if (di >= 0) descCol = di;
    if (li >= 0) labelCol = li; else labelCol = -1;
    if (ti >= 0) typeCol = ti; else typeCol = -1;
    if (tmi >= 0) timeCol = tmi; else timeCol = -1;
  } else {
    headerIdx = -1;  // start reading from row 0
  }

  // Excel stores time-of-day cells as fractional Date numbers (0.5 =
  // noon) when the user formats the cell as Time.  Convert to HH:MM
  // 24h.  Also accept plain strings ("14:30", "2:30 PM") and pre-
  // formatted Excel strings like "14:30:00".
  const formatExcelTime = (v) => {
    if (v == null || v === '') return '';
    if (typeof v === 'number') {
      // Fractional part = time of day; ignore integer part (date)
      const frac = v - Math.floor(v);
      const totalMins = Math.round(frac * 24 * 60);
      const h = Math.floor(totalMins / 60) % 24;
      const m = totalMins % 60;
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
    }
    return String(v).trim();
  };

  const dataStart = headerIdx >= 0 ? headerIdx + 1 : 0;
  const parsed = [];
  const seen = new Set();
  for (let i = dataStart; i < rows.length; i++) {
    const row = rows[i] || [];
    const description = String(row[descCol] || '').trim();
    if (!description) continue;
    const key = description.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const proof_label = labelCol >= 0 ? String(row[labelCol] || '').trim() || null : null;
    const rawType = typeCol >= 0 ? String(row[typeCol] || '').trim().toLowerCase() : '';
    const proof_type = ALLOWED_PROOF_TYPES.includes(rawType) ? rawType : null;
    const due_time = timeCol >= 0 ? formatExcelTime(row[timeCol]) || null : null;
    parsed.push({ description, proof_label, proof_type, due_time });
  }

  cleanup();
  if (parsed.length === 0) {
    return res.status(400).json({ error: 'No task rows found in the file. The first column should contain task descriptions.' });
  }
  res.json({
    ok: true,
    sheet: sheetName,
    header_row: headerIdx >= 0 ? headerIdx + 1 : null,
    rows: parsed,
    count: parsed.length,
  });
});

// Mam (2026-05-22): normalise fortnight_days CSV input.
// Accepts "5,20" / "5 & 20" / "5;20" / [5,20] — outputs canonical
// "5,20".  Empty / invalid → null (server falls back to "1,15"
// inside applies()).
function normaliseFortnightDays(v) {
  if (!v) return null;
  const arr = (Array.isArray(v) ? v : String(v).split(/[,;|&]| and /i))
    .map(s => parseInt(String(s).trim(), 10))
    .filter(n => Number.isFinite(n) && n >= 1 && n <= 31);
  if (arr.length === 0) return null;
  // Dedupe + sort + cap at 2 (it's FORTnightly, not weekly).
  return [...new Set(arr)].sort((a, b) => a - b).slice(0, 2).join(',');
}

router.post('/checklists', requirePermission('checklists', 'create'), (req, res) => {
  const { title, description, frequency, due_date, due_time, assigned_to, department,
          recurrence_start_date, recurrence_end_date, proof_type, proof_label,
          fortnight_days } = req.body;
  const t = deriveTitle(title, description);
  const desc = String(description || '').trim();
  if (!desc && !title) return res.status(400).json({ error: 'Description is required' });
  if (!assigned_to) return res.status(400).json({ error: 'Assigned To is required' });
  // Mam (2026-05-22): if the caller didn't supply a department, fall
  // back to the assignee's own users.department so the row is
  // automatically tagged with the right team.
  let dept = department && String(department).trim() ? String(department).trim() : null;
  if (!dept) {
    try {
      const u = getDb().prepare('SELECT department FROM users WHERE id=?').get(assigned_to);
      dept = u?.department || null;
    } catch (_) {}
  }
  const pt = ALLOWED_PROOF_TYPES.includes(proof_type) ? proof_type : 'photo';
  const pl = proof_label && String(proof_label).trim() ? String(proof_label).trim() : null;
  const fd = frequency === 'fortnightly' ? (normaliseFortnightDays(fortnight_days) || '1,15') : null;
  const r = getDb().prepare(
    `INSERT INTO checklists
       (title, description, frequency, due_date, due_time, assigned_to, department,
        recurrence_start_date, recurrence_end_date, proof_type, proof_label, fortnight_days, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(t, desc, frequency, due_date, due_time || null, assigned_to, dept,
        recurrence_start_date || null, recurrence_end_date || null, pt, pl, fd, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});

// Mam (2026-05-22): "give me checklist bulk" — admin pastes many
// task lines at once, all sharing the same frequency / assignee /
// dept / dates / proof_type.  Reduces 30 single-task adds down to
// one form fill.
router.post('/checklists/bulk', requirePermission('checklists', 'create'), (req, res) => {
  const { tasks, frequency, due_date, due_time, assigned_to, assigned_to_ids, department,
          recurrence_start_date, recurrence_end_date, proof_type, proof_label,
          fortnight_days } = req.body || {};
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return res.status(400).json({ error: 'tasks array required' });
  }
  // Mam (2026-05-22): "multiple name mean assign one or multiple
  // user one time" — accept either an array (new shape) or a
  // single id (legacy).  Normalise into one array.
  const assigneeIds = Array.isArray(assigned_to_ids) && assigned_to_ids.length
    ? assigned_to_ids.map(x => +x).filter(Boolean)
    : (assigned_to ? [+assigned_to] : []);
  if (assigneeIds.length === 0) return res.status(400).json({ error: 'At least one assignee is required' });

  // Department auto-fill — if not explicitly set, take it from the
  // FIRST picked user.  All N tasks × M users get the same dept tag.
  let dept = department && String(department).trim() ? String(department).trim() : null;
  if (!dept) {
    try {
      const u = getDb().prepare('SELECT department FROM users WHERE id=?').get(assigneeIds[0]);
      dept = u?.department || null;
    } catch (_) {}
  }
  const defaultPt = ALLOWED_PROOF_TYPES.includes(proof_type) ? proof_type : 'photo';
  const defaultPl = proof_label && String(proof_label).trim() ? String(proof_label).trim() : null;

  // Mam (2026-05-22): per-line overrides via pipe or tab separator:
  //   Pay GST           | GST File       | pdf | 10:00
  //   Reconcile cash    | Bank Statement | pdf
  //   Take site photo                               | 17:30
  // Column 1 = description (required)
  // Column 2 = proof_label override (optional — falls back to shared)
  // Column 3 = proof_type override  (optional, must be in whitelist)
  // Column 4 = due_time override    (optional, HH:MM 24h; falls back to shared)
  // Lines with NO separator just use the shared bulk settings.
  const normaliseTime = (s) => {
    if (!s) return null;
    const t = String(s).trim();
    // Accept HH:MM 24h, H:MM AM/PM, and Excel's HH:MM:SS (drop seconds).
    let m;
    if ((m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*$/))) {
      const h = +m[1], mn = +m[2];
      if (h >= 0 && h <= 23 && mn >= 0 && mn <= 59) return `${String(h).padStart(2,'0')}:${String(mn).padStart(2,'0')}`;
    }
    if ((m = t.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i))) {
      let h = +m[1]; const mn = +m[2]; const ap = m[3].toLowerCase();
      if (h === 12) h = 0;
      if (ap === 'pm') h += 12;
      if (h >= 0 && h <= 23 && mn >= 0 && mn <= 59) return `${String(h).padStart(2,'0')}:${String(mn).padStart(2,'0')}`;
    }
    return null;
  };
  const defaultDueTime = due_time && normaliseTime(due_time);

  const rows = [];
  const seen = new Set();
  for (const raw of tasks) {
    if (raw == null) continue;
    const line = String(raw).trim();
    if (!line) continue;
    // Split on tab OR pipe (Excel paste vs typed-in syntax)
    const parts = line.split(/\s*[|\t]\s*/);
    const description = parts[0]?.trim();
    if (!description) continue;
    const dupKey = description.toLowerCase();
    if (seen.has(dupKey)) continue;
    seen.add(dupKey);
    const rowLabel = parts[1] && parts[1].trim() ? parts[1].trim() : defaultPl;
    const rawType = parts[2] && parts[2].trim().toLowerCase();
    const rowType = rawType && ALLOWED_PROOF_TYPES.includes(rawType) ? rawType : defaultPt;
    // Mam (2026-05-22): "can add multiple time names also" — the
    // Time column accepts a comma-separated list (09:00, 13:00,
    // 17:00) which expands into one checklist row per time.  Useful
    // for tasks that fire multiple times per day at fixed slots
    // (attendance checks, stock recon, etc.).
    let rowTimes = [];
    if (parts[3] && /[,;]/.test(parts[3])) {
      rowTimes = parts[3]
        .split(/[,;]/)
        .map(t => normaliseTime(t))
        .filter(Boolean);
    } else {
      const single = normaliseTime(parts[3]) || defaultDueTime || null;
      rowTimes = [single];
    }
    // Emit one row per time slot.  Description gets an "@ HH:MM"
    // suffix when more than one slot so the rows don't collapse
    // into duplicates of each other in the dedup set.
    for (const t of rowTimes) {
      const desc = rowTimes.length > 1 && t
        ? `${description} @ ${t}`
        : description;
      rows.push({ description: desc, proof_label: rowLabel, proof_type: rowType, due_time: t });
    }
  }
  if (rows.length === 0) return res.status(400).json({ error: 'All task lines were empty' });

  const db = getDb();
  // Mam (2026-05-22): fortnight_days defaults to "1,15" when frequency
  // is fortnightly AND admin didn't pick days.  Same for every task
  // in the batch.
  const fdBulk = frequency === 'fortnightly'
    ? (normaliseFortnightDays(fortnight_days) || '1,15')
    : null;
  const ins = db.prepare(`INSERT INTO checklists
      (title, description, frequency, due_date, due_time, assigned_to, department,
       recurrence_start_date, recurrence_end_date, proof_type, proof_label, fortnight_days, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  // Mam (2026-05-22): emit one INSERT per (task × assignee) so a
  // batch of 3 tasks × 2 users creates 6 rows in a single atomic tx.
  const tx = db.transaction((items) => {
    let added = 0;
    for (const r of items) {
      const title = deriveTitle(null, r.description);
      for (const uid of assigneeIds) {
        ins.run(title, r.description, frequency || 'monthly', due_date || null,
                r.due_time || null,
                uid, dept,
                recurrence_start_date || null, recurrence_end_date || null,
                r.proof_type, r.proof_label, fdBulk, req.user.id);
        added++;
      }
    }
    return added;
  });
  const added = tx(rows);
  res.status(201).json({ added, total: rows.length });
});

router.put('/checklists/:id', requirePermission('checklists', 'edit'), (req, res) => {
  const { status, title, description, frequency, due_date, due_time, assigned_to, department,
          recurrence_start_date, recurrence_end_date, proof_type, proof_label,
          fortnight_days } = req.body;
  const t = deriveTitle(title, description);
  if (!assigned_to) return res.status(400).json({ error: 'Assigned To is required' });
  let dept = department && String(department).trim() ? String(department).trim() : null;
  if (!dept) {
    try {
      const u = getDb().prepare('SELECT department FROM users WHERE id=?').get(assigned_to);
      dept = u?.department || null;
    } catch (_) {}
  }
  const pt = ALLOWED_PROOF_TYPES.includes(proof_type) ? proof_type : null;
  // proof_label uses COALESCE-like behaviour: passing undefined keeps
  // existing; passing '' clears it; passing a string sets/replaces.
  const pl = proof_label === undefined ? null
           : proof_label && String(proof_label).trim() ? String(proof_label).trim()
           : '';
  // Same COALESCE-vs-empty trick for fortnight_days as proof_label
  // so passing '' clears, undefined keeps existing, value sets.
  const fdEdit = fortnight_days === undefined ? null
              : fortnight_days && normaliseFortnightDays(fortnight_days)
                ? normaliseFortnightDays(fortnight_days)
                : '';
  getDb().prepare(
    `UPDATE checklists SET status=?, title=?, description=?, frequency=?, due_date=?, due_time=?,
       assigned_to=?, department=?, recurrence_start_date=?, recurrence_end_date=?,
       proof_type = COALESCE(?, proof_type),
       proof_label = CASE WHEN ? IS NULL THEN proof_label
                          WHEN ? = '' THEN NULL
                          ELSE ? END,
       fortnight_days = CASE WHEN ? IS NULL THEN fortnight_days
                             WHEN ? = '' THEN NULL
                             ELSE ? END
     WHERE id=?`
  ).run(status, t, description, frequency, due_date, due_time || null, assigned_to, dept,
        recurrence_start_date || null, recurrence_end_date || null, pt,
        pl, pl, pl,
        fdEdit, fdEdit, fdEdit,
        req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/checklists/:id', requirePermission('checklists', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM checklists WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Today's checklists for the logged-in user — used by the dashboard widget.
// Returns active checklists that are due today based on frequency:
//   daily       → every day
//   weekly      → same weekday as the checklist's due_date
//   monthly     → same day-of-month as the checklist's due_date
//   quarterly   → once every 3 months on the due_date's day
//   yearly      → same month-and-day as the due_date
//   once        → exact due_date match
// Each entry is joined with today's completion row (if any) so the UI knows
// whether proof has been uploaded.
router.get('/checklists/my-today', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const d = new Date(today + 'T00:00:00');
  const todayDow = d.getDay();            // 0..6
  const todayDom = d.getDate();           // 1..31
  const todayMonth = d.getMonth() + 1;    // 1..12

  const uid = req.user.id;

  // Pull checklists assigned to this user OR unassigned (applies to everyone)
  const rows = db.prepare(
    `SELECT c.*, cc.id as completion_id, cc.proof_url, cc.submitted_at, cc.notes
     FROM checklists c
     LEFT JOIN checklist_completions cc
       ON cc.checklist_id = c.id AND cc.user_id = ? AND cc.completion_date = ?
     WHERE (c.assigned_to = ? OR c.assigned_to IS NULL)
       AND (c.status IS NULL OR c.status = 'pending' OR c.status = 'active' OR c.status = '')`
  ).all(uid, today, uid);

  const out = rows.filter(c => {
    const f = String(c.frequency || '').toLowerCase();
    if (!c.due_date && f !== 'daily') return f === 'daily';
    const due = c.due_date ? new Date(c.due_date + 'T00:00:00') : null;
    if (f === 'daily') return true;
    if (f === 'weekly') return due && due.getDay() === todayDow;
    if (f === 'monthly') return due && due.getDate() === todayDom;
    if (f === 'quarterly') {
      if (!due) return false;
      const monthDiff = (todayMonth - (due.getMonth() + 1) + 12) % 3;
      return monthDiff === 0 && due.getDate() === todayDom;
    }
    if (f === 'yearly') return due && due.getMonth() + 1 === todayMonth && due.getDate() === todayDom;
    if (f === 'once') return c.due_date === today;
    return false;
  });

  res.json(out);
});

// Approval columns — mam (2026-05-16): "after need to approval".
// Idempotent ALTER TABLE.  approval_status defaults to 'pending'
// so every new completion shows up in the admin's approval queue.
try { getDb().exec(`ALTER TABLE checklist_completions ADD COLUMN approval_status TEXT DEFAULT 'pending'`); } catch (_) {}
try { getDb().exec(`ALTER TABLE checklist_completions ADD COLUMN approved_by INTEGER REFERENCES users(id)`); } catch (_) {}
try { getDb().exec(`ALTER TABLE checklist_completions ADD COLUMN approved_at DATETIME`); } catch (_) {}
try { getDb().exec(`ALTER TABLE checklist_completions ADD COLUMN approval_note TEXT`); } catch (_) {}

// Mark a checklist as done for a given date (with optional proof_url
// + notes).  Mam (2026-05-22): users need to back-date submissions
// — e.g. upload Monday morning the proof for the Saturday daily
// task.  Optional body.completion_date defaults to today; admin can
// always back-date, non-admins are clamped to the task's recurrence
// window so they can't fabricate completions for days the task
// didn't even apply.
//
// Uses UPSERT so re-submitting overwrites the proof.  Resets the
// approval status to 'pending' on re-submit so the admin re-reviews.
router.post('/checklists/:id/complete', (req, res) => {
  const { proof_url, notes } = req.body;
  let date = req.body.completion_date && String(req.body.completion_date).trim()
    ? String(req.body.completion_date).trim().slice(0, 10)
    : new Date().toISOString().split('T')[0];

  const db = getDb();
  const c = db.prepare('SELECT * FROM checklists WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Checklist not found' });

  // Non-admin clamp: must be inside the recurrence window if one is set.
  if (req.user.role !== 'admin') {
    if (c.recurrence_start_date && date < c.recurrence_start_date) {
      return res.status(400).json({ error: 'Date is before this task\'s Start Date' });
    }
    if (c.recurrence_end_date && date > c.recurrence_end_date) {
      return res.status(400).json({ error: 'Date is after this task\'s End Date' });
    }
  }

  // Mam (2026-05-22): enforce proof_type on completion so admins can
  // trust that whoever marked it done actually attached what was asked.
  const pt = c.proof_type || 'photo';
  if (pt === 'text' && (!notes || !String(notes).trim())) {
    return res.status(400).json({ error: 'This checklist needs a text note to complete' });
  }
  if (['photo','pdf','file'].includes(pt) && !proof_url) {
    return res.status(400).json({ error: `This checklist needs a ${pt === 'photo' ? 'photo' : pt === 'pdf' ? 'PDF' : 'file'} attached to complete` });
  }
  // pt === 'none' → no requirement (just mark done)

  db.prepare(
    `INSERT INTO checklist_completions (checklist_id, user_id, completion_date, proof_url, notes, approval_status)
     VALUES (?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(checklist_id, user_id, completion_date) DO UPDATE SET
       proof_url = excluded.proof_url,
       notes = excluded.notes,
       submitted_at = CURRENT_TIMESTAMP,
       approval_status = 'pending',
       approved_by = NULL, approved_at = NULL, approval_note = NULL`
  ).run(req.params.id, req.user.id, date, proof_url || null, notes || null);
  res.json({ message: `Checklist marked complete for ${date} — pending admin approval`, date });
});

// ── GET /hr/checklists/by-date?date=YYYY-MM-DD ──────────────────
// Mam (2026-05-16): "where i can check as per daily and previous
// check list done or not done".  Returns every checklist active
// on that date with its completion status (if any), proof URL,
// and approval status.  Admin sees all; non-admin sees only their
// own assignments.
router.get('/checklists/by-date', (req, res) => {
  const db = getDb();
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  let canManage = req.user.role === 'admin';
  if (!canManage) {
    const _cp = db.prepare("SELECT rp.can_see_all, rp.can_edit, rp.can_create FROM role_permissions rp JOIN user_roles ur ON rp.role_id = ur.role_id WHERE ur.user_id = ? AND rp.module = 'checklists'").get(req.user.id);
    canManage = !!(_cp && (_cp.can_see_all || _cp.can_edit || _cp.can_create));
  }
  const scope = canManage ? '' : 'AND c.assigned_to = ?';
  // Build args in the exact order placeholders appear in the SQL.
  // Was previously buggy (legacy `params = [date]` was duplicating the
  // first arg → "Too many parameter values were provided").  Mam saw
  // the error after the recurrence-window fields were added.
  const args = [date];                          // for the JOIN ON ... = ?
  if (!canManage) args.push(req.user.id);         // for the scope ... = ?
  args.push(date, date);                        // start ≤ ? and end ≥ ?

  const rows = db.prepare(`
    SELECT c.id, c.description, c.title, c.frequency, c.due_date, c.due_time,
           c.department, c.recurrence_start_date, c.recurrence_end_date,
           c.fortnight_days,
           c.assigned_to, u.name as assigned_to_name,
           comp.id as completion_id,
           comp.proof_url, comp.notes, comp.submitted_at,
           comp.approval_status, comp.approved_at, comp.approval_note,
           au.name as approved_by_name
    FROM checklists c
    LEFT JOIN users u  ON c.assigned_to = u.id
    LEFT JOIN checklist_completions comp
      ON comp.checklist_id = c.id AND comp.user_id = c.assigned_to AND comp.completion_date = ?
    LEFT JOIN users au ON comp.approved_by = au.id
    WHERE 1=1 ${scope}
      AND (c.recurrence_start_date IS NULL OR c.recurrence_start_date <= ?)
      AND (c.recurrence_end_date   IS NULL OR c.recurrence_end_date   >= ?)
    ORDER BY u.name, c.department, c.description
  `).all(...args);
  // Mam (2026-05-22): post-filter so each frequency only fires on its
  // intended day(s).  Uses due_date as the recurrence anchor for
  // monthly / quarterly / yearly — matches the followup's applies()
  // logic so by-date + followup stay in sync.
  const todayDate = new Date(date + 'T00:00:00');
  const dom = todayDate.getDate();
  const filtered = rows.filter(r => {
    const f = String(r.frequency || '').toLowerCase();
    if (f === 'fortnightly') {
      const csv = r.fortnight_days && String(r.fortnight_days).trim() ? r.fortnight_days : '1,15';
      const days = csv.split(/[,;|]/).map(s => parseInt(String(s).trim(), 10)).filter(d => d >= 1 && d <= 31);
      return days.includes(dom);
    }
    if (!r.due_date) return true;                  // legacy: keep generous
    const due = new Date(String(r.due_date).slice(0, 10) + 'T00:00:00');
    if (f === 'monthly')   return dom === due.getDate();
    if (f === 'quarterly') {
      if (dom !== due.getDate()) return false;
      const diff = ((todayDate.getMonth() - due.getMonth()) % 3 + 3) % 3;
      return diff === 0;
    }
    if (f === 'yearly') return todayDate.getMonth() === due.getMonth() && dom === due.getDate();
    if (f === 'once')   return String(r.due_date).slice(0, 10) === date;
    return true;                                    // daily / weekly / unknown
  });
  res.json({ date, rows: filtered });
});

// ── GET /hr/checklists/followup?back=7&forward=7 ────────────────
// Mam (2026-05-22): "i need followup checklist where all record
// mention previous, present, future".  Returns one row per checklist
// task with a horizontal timeline of dates (back N → today → forward
// N).  Each cell carries the status for that date:
//   'done_approved' | 'done_pending' | 'done_rejected'
//   'missed'  (past + frequency-applicable + no completion)
//   'today'   (current day, no completion yet)
//   'future'  (upcoming + frequency-applicable)
//   'na'      (frequency says this task doesn't apply on that date)
router.get('/checklists/followup', (req, res) => {
  const db = getDb();
  const back = Math.min(30, Math.max(0, parseInt(req.query.back || '7', 10)));
  const forward = Math.min(30, Math.max(0, parseInt(req.query.forward || '7', 10)));
  let isAdmin = req.user.role === 'admin';
  if (!isAdmin) { const _cp = db.prepare("SELECT rp.can_see_all, rp.can_edit, rp.can_create FROM role_permissions rp JOIN user_roles ur ON rp.role_id = ur.role_id WHERE ur.user_id = ? AND rp.module = 'checklists'").get(req.user.id); isAdmin = !!(_cp && (_cp.can_see_all || _cp.can_edit || _cp.can_create)); }

  // Build the date window (ISO YYYY-MM-DD strings, IST).
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dates = [];
  for (let i = -back; i <= forward; i += 1) {
    const d = new Date(today); d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const fromDate = dates[0];
  const toDate = dates[dates.length - 1];

  // Pull the candidate task list (admin sees all, others only their own).
  const taskSql = isAdmin
    ? `SELECT c.id, c.description, c.title, c.frequency, c.due_date, c.due_time,
              c.department, c.assigned_to, u.name AS assigned_to_name,
              c.recurrence_start_date, c.recurrence_end_date, c.fortnight_days
       FROM checklists c LEFT JOIN users u ON c.assigned_to = u.id
       ORDER BY u.name COLLATE NOCASE, c.department, c.description`
    : `SELECT c.id, c.description, c.title, c.frequency, c.due_date, c.due_time,
              c.department, c.assigned_to, u.name AS assigned_to_name,
              c.recurrence_start_date, c.recurrence_end_date, c.fortnight_days
       FROM checklists c LEFT JOIN users u ON c.assigned_to = u.id
       WHERE c.assigned_to = ?
       ORDER BY c.department, c.description`;
  const tasks = isAdmin ? db.prepare(taskSql).all() : db.prepare(taskSql).all(req.user.id);

  // Pull ALL completions in the window (one query, then bucket
  // client-side by checklist_id + date).
  const compRows = db.prepare(`
    SELECT checklist_id, user_id, completion_date, proof_url,
           approval_status, submitted_at
    FROM checklist_completions
    WHERE completion_date BETWEEN ? AND ?
  `).all(fromDate, toDate);
  const compMap = {};
  for (const r of compRows) {
    compMap[`${r.checklist_id}::${r.completion_date}`] = r;
  }

  // Frequency → "does this date apply to this task?" helper.  Now
  // also respects mam's (2026-05-22) start/end recurrence window:
  // out-of-window dates ALWAYS return false so the cell renders as
  // N/A in the grid and doesn't count as "missed".
  function applies(task, dateStr) {
    if (task.recurrence_start_date && dateStr < task.recurrence_start_date) return false;
    if (task.recurrence_end_date   && dateStr > task.recurrence_end_date)   return false;
    if (!task.frequency) return true;
    const f = task.frequency.toLowerCase();
    if (f === 'daily') return true;
    if (f === 'weekly') {
      if (!task.due_date) return true;
      return new Date(task.due_date).getDay() === new Date(dateStr).getDay();
    }
    // Mam (2026-05-22): fortnightly = twice a month on the two day-of-
    // month slots stored in fortnight_days ("5,20"; default "1,15").
    // Cell is "applicable" only when the date's day-of-month matches.
    if (f === 'fortnightly') {
      const csv = task.fortnight_days && String(task.fortnight_days).trim()
        ? task.fortnight_days : '1,15';
      const days = csv.split(/[,;|]/).map(s => parseInt(String(s).trim(), 10)).filter(d => d >= 1 && d <= 31);
      if (days.length === 0) return false;
      const dom = new Date(dateStr + 'T00:00:00').getDate();
      return days.includes(dom);
    }
    // Mam (2026-05-22): "if here is month then you dont think selection
    // of month if quartly" — use due_date as the recurrence anchor:
    //   monthly   → fires on same DAY-of-MONTH as due_date, every month
    //   quarterly → fires on same DAY-of-MONTH AND every 3rd month
    //               offset from the due_date month
    //   yearly    → fires on same MONTH + DAY as due_date, every year
    // No due_date set → legacy generous behaviour (matches any day) so
    // existing rows don't suddenly disappear from the grid.
    const d = new Date(dateStr + 'T00:00:00');
    const dueIso = task.due_date ? String(task.due_date).slice(0, 10) : null;
    if (f === 'monthly') {
      if (!dueIso) return true;     // legacy: keep generous
      return d.getDate() === new Date(dueIso + 'T00:00:00').getDate();
    }
    if (f === 'quarterly') {
      if (!dueIso) return true;
      const due = new Date(dueIso + 'T00:00:00');
      if (d.getDate() !== due.getDate()) return false;
      // Same month-of-quarter: (d.month - due.month) divisible by 3
      const diff = ((d.getMonth() - due.getMonth()) % 3 + 3) % 3;
      return diff === 0;
    }
    if (f === 'yearly') {
      if (!dueIso) return true;
      const due = new Date(dueIso + 'T00:00:00');
      return d.getMonth() === due.getMonth() && d.getDate() === due.getDate();
    }
    if (f === 'once') {
      if (!dueIso) return true;
      return dueIso === dateStr;
    }
    return true;
  }

  const rows = tasks.map(t => {
    const cells = dates.map(d => {
      const comp = compMap[`${t.id}::${d}`];
      const isPast   = d < dates[back];
      const isToday  = d === dates[back];
      const inScope  = applies(t, d);
      let status;
      if (!inScope) status = 'na';
      else if (comp) {
        if (comp.approval_status === 'approved')      status = 'done_approved';
        else if (comp.approval_status === 'rejected') status = 'done_rejected';
        else                                          status = 'done_pending';
      } else if (isPast)  status = 'missed';
      else if (isToday)   status = 'today';
      else                status = 'future';
      return { date: d, status, proof_url: comp?.proof_url || null, submitted_at: comp?.submitted_at || null };
    });
    return {
      id: t.id,
      description: t.description || t.title,
      frequency: t.frequency,
      department: t.department,
      assigned_to: t.assigned_to,
      assigned_to_name: t.assigned_to_name,
      cells,
    };
  });

  res.json({ from: fromDate, to: toDate, dates, today_index: back, rows });
});

// ── POST /hr/checklists/completions/:id/decision (admin only) ───
// Approve or reject a checklist completion.  Body: { status, note }.
router.post('/checklists/completions/:id/decision', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { status, note } = req.body || {};
  if (status !== 'approved' && status !== 'rejected') {
    return res.status(400).json({ error: 'status must be "approved" or "rejected"' });
  }
  const db = getDb();
  const r = db.prepare(`
    UPDATE checklist_completions
    SET approval_status = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP, approval_note = ?
    WHERE id = ?
  `).run(status, req.user.id, note || null, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Completion not found' });
  res.json({ message: `Marked ${status}` });
});

// ═════════════════════════════════════════════════════════════════
// HIRING REQUESTS (mam 2026-05-22 Phase 1 spec, module #2 in priority)
// ═════════════════════════════════════════════════════════════════
//
// Manager raises a requisition → HR approves → position opens →
// candidates link back via candidates.hiring_request_id.
//
// Workflow:
//   pending  → approve  → approved (open for sourcing)
//   pending  → reject   → rejected
//   approved → close    → closed   (filled / cancelled)
//
// All routes are mounted under /api/hr/hiring-requests.

// Helper — only admin / HR can approve or reject.  Hiring manager who
// raised the request CANNOT approve their own (separation of duties,
// same rule we enforce on Indent).
function isHrOrAdmin(req) {
  if (req.user.role === 'admin') return true;
  const db = getDb();
  const u = db.prepare('SELECT department FROM users WHERE id=?').get(req.user.id);
  if (u?.department && String(u.department).toLowerCase().includes('hr')) return true;
  const roles = db.prepare(
    `SELECT r.name FROM user_roles ur JOIN roles r ON ur.role_id=r.id WHERE ur.user_id=?`
  ).all(req.user.id);
  return roles.some(r => String(r.name || '').toLowerCase().includes('hr'));
}

router.get('/hiring-requests', (req, res) => {
  const { status, department } = req.query;
  let sql = `SELECT hr.*, e.name AS reporting_manager_name,
                    (SELECT COUNT(*) FROM candidates c WHERE c.hiring_request_id = hr.id) AS candidates_count
               FROM hiring_requests hr
               LEFT JOIN employees e ON e.id = hr.reporting_manager_id
              WHERE 1=1`;
  const args = [];
  if (status)     { sql += ' AND hr.status = ?';     args.push(status); }
  if (department) { sql += ' AND hr.department = ?'; args.push(department); }
  sql += ' ORDER BY hr.created_at DESC';
  res.json(getDb().prepare(sql).all(...args));
});

router.get('/hiring-requests/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare(
    `SELECT hr.*, e.name AS reporting_manager_name
       FROM hiring_requests hr
       LEFT JOIN employees e ON e.id = hr.reporting_manager_id
      WHERE hr.id = ?`
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Hiring request not found' });
  // Inline candidate list — manager wants to see "X applied for this role".
  row.candidates = db.prepare(
    `SELECT id, name, phone, email, status, created_at
       FROM candidates WHERE hiring_request_id = ? ORDER BY created_at DESC`
  ).all(req.params.id);
  res.json(row);
});

router.post('/hiring-requests', (req, res) => {
  try {
    const { department, position_title, num_openings, salary_min, salary_max,
            experience_required, employment_type, hiring_deadline,
            reporting_manager_id, job_description } = req.body || {};
    if (!department || !String(department).trim()) return res.status(400).json({ error: 'Department is required' });
    if (!position_title || !String(position_title).trim()) return res.status(400).json({ error: 'Position title is required' });
    const allowedTypes = ['full_time','part_time','contract','internship','freelance'];
    const empType = allowedTypes.includes(employment_type) ? employment_type : 'full_time';
    const db = getDb();
    const r = db.prepare(`
      INSERT INTO hiring_requests
        (department, position_title, num_openings, salary_min, salary_max,
         experience_required, employment_type, hiring_deadline,
         reporting_manager_id, job_description,
         status, requested_by, requested_by_name)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?)
    `).run(
      department.trim(), position_title.trim(),
      num_openings ? +num_openings : 1,
      salary_min != null && salary_min !== '' ? +salary_min : null,
      salary_max != null && salary_max !== '' ? +salary_max : null,
      experience_required || null, empType, hiring_deadline || null,
      reporting_manager_id ? +reporting_manager_id : null,
      job_description || null,
      req.user.id, req.user.name || null,
    );
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (err) {
    console.error('POST /hr/hiring-requests error', err);
    res.status(500).json({ error: err.message || 'Failed to create hiring request' });
  }
});

router.put('/hiring-requests/:id', (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM hiring_requests WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  // Approved / closed / rejected rows are frozen — admin override only.
  if (cur.status !== 'pending' && req.user.role !== 'admin') {
    return res.status(403).json({ error: `Cannot edit a ${cur.status} request — admin only` });
  }
  const { department, position_title, num_openings, salary_min, salary_max,
          experience_required, employment_type, hiring_deadline,
          reporting_manager_id, job_description } = req.body || {};
  db.prepare(`
    UPDATE hiring_requests SET
      department = COALESCE(?, department),
      position_title = COALESCE(?, position_title),
      num_openings = COALESCE(?, num_openings),
      salary_min = ?,
      salary_max = ?,
      experience_required = COALESCE(?, experience_required),
      employment_type = COALESCE(?, employment_type),
      hiring_deadline = ?,
      reporting_manager_id = ?,
      job_description = COALESCE(?, job_description)
    WHERE id = ?
  `).run(
    department || null, position_title || null,
    num_openings != null ? +num_openings : null,
    salary_min != null && salary_min !== '' ? +salary_min : null,
    salary_max != null && salary_max !== '' ? +salary_max : null,
    experience_required || null, employment_type || null,
    hiring_deadline || null,
    reporting_manager_id ? +reporting_manager_id : null,
    job_description || null,
    req.params.id,
  );
  res.json({ message: 'Updated' });
});

router.post('/hiring-requests/:id/approve', (req, res) => {
  if (!isHrOrAdmin(req)) return res.status(403).json({ error: 'HR or Admin only' });
  const db = getDb();
  const cur = db.prepare('SELECT * FROM hiring_requests WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  if (cur.status !== 'pending') return res.status(409).json({ error: `Already ${cur.status}` });
  // Separation of duties — the requester cannot approve their own request.
  if (cur.requested_by === req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'You raised this request; another HR must approve it' });
  }
  const { notes } = req.body || {};
  db.prepare(`UPDATE hiring_requests
                 SET status='approved', approval_notes=?, approved_by=?, approved_at=CURRENT_TIMESTAMP
               WHERE id=?`)
    .run(notes || null, req.user.id, req.params.id);
  res.json({ message: 'Hiring request approved — position is now open for sourcing' });
});

router.post('/hiring-requests/:id/reject', (req, res) => {
  if (!isHrOrAdmin(req)) return res.status(403).json({ error: 'HR or Admin only' });
  const db = getDb();
  const cur = db.prepare('SELECT * FROM hiring_requests WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  if (cur.status !== 'pending') return res.status(409).json({ error: `Already ${cur.status}` });
  const { reason } = req.body || {};
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'Rejection reason required' });
  db.prepare(`UPDATE hiring_requests
                 SET status='rejected', approval_notes=?, approved_by=?, approved_at=CURRENT_TIMESTAMP
               WHERE id=?`)
    .run(reason, req.user.id, req.params.id);
  res.json({ message: 'Hiring request rejected' });
});

router.post('/hiring-requests/:id/close', (req, res) => {
  if (!isHrOrAdmin(req)) return res.status(403).json({ error: 'HR or Admin only' });
  const db = getDb();
  const cur = db.prepare('SELECT * FROM hiring_requests WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  if (cur.status === 'closed') return res.json({ message: 'Already closed' });
  db.prepare(`UPDATE hiring_requests
                 SET status='closed', closed_at=CURRENT_TIMESTAMP
               WHERE id=?`).run(req.params.id);
  res.json({ message: 'Hiring request closed' });
});

router.delete('/hiring-requests/:id', (req, res) => {
  if (!isHrOrAdmin(req)) return res.status(403).json({ error: 'HR or Admin only' });
  const db = getDb();
  // Don't orphan candidates — null out their hiring_request_id first.
  db.prepare('UPDATE candidates SET hiring_request_id = NULL WHERE hiring_request_id = ?').run(req.params.id);
  const r = db.prepare('DELETE FROM hiring_requests WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Deleted' });
});

// ═════════════════════════════════════════════════════════════════
// JOB DESCRIPTIONS (mam 2026-05-22 Phase 1 Batch B, module #3)
// ═════════════════════════════════════════════════════════════════
//
// JD templates → JD records (linked optionally to a hiring_request).
// Each JD carries both internal_jd (full detail) and public_job_post
// (sanitised for external boards).  Status: draft → published → archived.

// ── JD TEMPLATES ──
router.get('/jd-templates', (req, res) => {
  const rows = getDb().prepare(
    `SELECT id, name, description, template_content, is_default, created_at
       FROM jd_templates ORDER BY is_default DESC, name`
  ).all();
  // Parse JSON content for the client.
  res.json(rows.map(r => ({ ...r, template_content: safeParseJson(r.template_content) })));
});

router.post('/jd-templates', (req, res) => {
  try {
    const { name, description, template_content, is_default } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Template name is required' });
    const db = getDb();
    if (is_default) db.prepare('UPDATE jd_templates SET is_default = 0').run();
    const r = db.prepare(`
      INSERT INTO jd_templates (name, description, template_content, is_default, created_by)
      VALUES (?,?,?,?,?)
    `).run(
      name.trim(), description || null,
      template_content ? JSON.stringify(template_content) : null,
      is_default ? 1 : 0,
      req.user.id,
    );
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (err) {
    console.error('POST /hr/jd-templates error', err);
    res.status(500).json({ error: err.message || 'Failed to save template' });
  }
});

router.put('/jd-templates/:id', (req, res) => {
  const { name, description, template_content, is_default } = req.body || {};
  const db = getDb();
  if (is_default) db.prepare('UPDATE jd_templates SET is_default = 0 WHERE id != ?').run(req.params.id);
  db.prepare(`
    UPDATE jd_templates SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      template_content = COALESCE(?, template_content),
      is_default = COALESCE(?, is_default)
    WHERE id = ?
  `).run(
    name || null, description || null,
    template_content ? JSON.stringify(template_content) : null,
    is_default != null ? (is_default ? 1 : 0) : null,
    req.params.id,
  );
  res.json({ message: 'Updated' });
});

router.delete('/jd-templates/:id', (req, res) => {
  const r = getDb().prepare('DELETE FROM jd_templates WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Deleted' });
});

// ── JOB DESCRIPTIONS ──
router.get('/job-descriptions', (req, res) => {
  const { hiring_request_id, status } = req.query;
  let sql = `SELECT jd.*, hr.position_title AS hiring_request_position,
                    hr.department AS hiring_request_department,
                    t.name AS template_name
               FROM job_descriptions jd
               LEFT JOIN hiring_requests hr ON hr.id = jd.hiring_request_id
               LEFT JOIN jd_templates    t  ON t.id  = jd.template_id
              WHERE 1=1`;
  const args = [];
  if (hiring_request_id) { sql += ' AND jd.hiring_request_id = ?'; args.push(+hiring_request_id); }
  if (status)            { sql += ' AND jd.status = ?';            args.push(status); }
  sql += ' ORDER BY jd.created_at DESC';
  res.json(getDb().prepare(sql).all(...args));
});

router.get('/job-descriptions/:id', (req, res) => {
  const row = getDb().prepare(
    `SELECT jd.*, hr.position_title AS hiring_request_position,
            hr.department AS hiring_request_department,
            t.name AS template_name
       FROM job_descriptions jd
       LEFT JOIN hiring_requests hr ON hr.id = jd.hiring_request_id
       LEFT JOIN jd_templates    t  ON t.id  = jd.template_id
      WHERE jd.id = ?`
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'JD not found' });
  res.json(row);
});

router.post('/job-descriptions', (req, res) => {
  try {
    const { hiring_request_id, template_id, title, description, responsibilities,
            required_skills, required_experience, education_required,
            internal_jd, public_job_post, status } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required' });
    const st = ['draft','published','archived'].includes(status) ? status : 'draft';
    const r = getDb().prepare(`
      INSERT INTO job_descriptions
        (hiring_request_id, template_id, title, description, responsibilities,
         required_skills, required_experience, education_required,
         internal_jd, public_job_post, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      hiring_request_id ? +hiring_request_id : null,
      template_id ? +template_id : null,
      title.trim(), description || null, responsibilities || null,
      required_skills || null, required_experience || null, education_required || null,
      internal_jd || null, public_job_post || null,
      st, req.user.id,
    );
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (err) {
    console.error('POST /hr/job-descriptions error', err);
    res.status(500).json({ error: err.message || 'Failed to save JD' });
  }
});

router.put('/job-descriptions/:id', (req, res) => {
  const { hiring_request_id, template_id, title, description, responsibilities,
          required_skills, required_experience, education_required,
          internal_jd, public_job_post, status } = req.body || {};
  getDb().prepare(`
    UPDATE job_descriptions SET
      hiring_request_id = ?,
      template_id = ?,
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      responsibilities = COALESCE(?, responsibilities),
      required_skills = COALESCE(?, required_skills),
      required_experience = COALESCE(?, required_experience),
      education_required = COALESCE(?, education_required),
      internal_jd = COALESCE(?, internal_jd),
      public_job_post = COALESCE(?, public_job_post),
      status = COALESCE(?, status),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    hiring_request_id ? +hiring_request_id : null,
    template_id ? +template_id : null,
    title || null, description || null, responsibilities || null,
    required_skills || null, required_experience || null, education_required || null,
    internal_jd || null, public_job_post || null,
    status || null, req.params.id,
  );
  res.json({ message: 'Updated' });
});

router.delete('/job-descriptions/:id', (req, res) => {
  const r = getDb().prepare('DELETE FROM job_descriptions WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Deleted' });
});

// ═════════════════════════════════════════════════════════════════
// INTERVIEW SCORECARDS (mam 2026-05-22 Phase 1 Batch B, module #7)
// ═════════════════════════════════════════════════════════════════
// One scorecard per (candidate × interviewer × stage).  Stage is
// 'first' (interviewer round) or 'final' (MD round).  Saved alongside
// the existing interview_decision so legacy data is untouched.

router.get('/candidates/:id/scorecards', (req, res) => {
  const rows = getDb().prepare(
    `SELECT * FROM interview_scorecards
      WHERE candidate_id = ? ORDER BY created_at DESC`
  ).all(req.params.id);
  res.json(rows);
});

router.post('/candidates/:id/scorecard', (req, res) => {
  try {
    const { interviewer_id, stage, technical_score, communication_score,
            culture_fit_score, problem_solving_score, overall_recommend,
            strengths, weaknesses, overall_feedback } = req.body || {};
    const st = ['first','final'].includes(stage) ? stage : 'first';
    const rec = ['strong_yes','yes','maybe','no','strong_no'].includes(overall_recommend)
                ? overall_recommend : null;
    // Constrain scores to 1-5 (null allowed).
    const score = (v) => {
      if (v == null || v === '') return null;
      const n = +v;
      if (isNaN(n)) return null;
      return Math.min(5, Math.max(1, Math.round(n)));
    };
    const db = getDb();
    const intvName = interviewer_id
      ? (db.prepare('SELECT name FROM employees WHERE id=?').get(+interviewer_id)?.name || null)
      : null;
    const r = db.prepare(`
      INSERT INTO interview_scorecards
        (candidate_id, interviewer_id, interviewer_name, stage,
         technical_score, communication_score, culture_fit_score, problem_solving_score,
         overall_recommend, strengths, weaknesses, overall_feedback, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      +req.params.id,
      interviewer_id ? +interviewer_id : null,
      intvName, st,
      score(technical_score), score(communication_score),
      score(culture_fit_score), score(problem_solving_score),
      rec, strengths || null, weaknesses || null, overall_feedback || null,
      req.user.id,
    );
    logEvent(db, req.params.id, 'scorecard_added', {
      note: `Scorecard (${st}) by ${intvName || `#${interviewer_id}`} — ${rec || 'no overall rating'}`,
      user_id: req.user.id, user_name: req.user.name,
    });
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (err) {
    console.error('POST /hr/candidates/:id/scorecard error', err);
    res.status(500).json({ error: err.message || 'Failed to save scorecard' });
  }
});

router.delete('/scorecards/:id', (req, res) => {
  const r = getDb().prepare('DELETE FROM interview_scorecards WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Deleted' });
});

// ═════════════════════════════════════════════════════════════════
// FINAL-ROUND QUESTION BANK (mam 2026-05-22 Phase 1 Batch B, module #8)
// ═════════════════════════════════════════════════════════════════
// Curated questions for the MD / final round, organised by category.
// 25 starter questions seeded in schema.js (seed_final_round_questions_v1).

router.get('/final-round-questions', (req, res) => {
  const { category, for_role, difficulty, active } = req.query;
  let sql = 'SELECT * FROM final_round_questions WHERE 1=1';
  const args = [];
  if (category)   { sql += ' AND category = ?';   args.push(category); }
  if (for_role)   { sql += ' AND (for_role = ? OR for_role = "Any" OR for_role IS NULL)'; args.push(for_role); }
  if (difficulty) { sql += ' AND difficulty = ?'; args.push(difficulty); }
  if (active === '1') sql += ' AND is_active = 1';
  sql += ' ORDER BY category, id';
  res.json(getDb().prepare(sql).all(...args));
});

// Pick N random ACTIVE questions, optionally filtered by category /
// role / difficulty.  Used by the "Random pick" button before an MD
// round so the panel has a starting set without scrolling.
router.get('/final-round-questions/pick', (req, res) => {
  const n = Math.min(20, Math.max(1, +req.query.n || 5));
  const { category, for_role, difficulty } = req.query;
  let sql = 'SELECT * FROM final_round_questions WHERE is_active = 1';
  const args = [];
  if (category)   { sql += ' AND category = ?';   args.push(category); }
  if (for_role)   { sql += ' AND (for_role = ? OR for_role = "Any" OR for_role IS NULL)'; args.push(for_role); }
  if (difficulty) { sql += ' AND difficulty = ?'; args.push(difficulty); }
  sql += ' ORDER BY RANDOM() LIMIT ?';
  args.push(n);
  res.json(getDb().prepare(sql).all(...args));
});

router.post('/final-round-questions', (req, res) => {
  try {
    const { category, question_text, for_role, difficulty, notes, is_active } = req.body || {};
    if (!category || !String(category).trim())       return res.status(400).json({ error: 'Category is required' });
    if (!question_text || !String(question_text).trim()) return res.status(400).json({ error: 'Question text is required' });
    const diff = ['easy','medium','hard'].includes(difficulty) ? difficulty : 'medium';
    const r = getDb().prepare(`
      INSERT INTO final_round_questions
        (category, question_text, for_role, difficulty, notes, is_active, created_by)
      VALUES (?,?,?,?,?,?,?)
    `).run(
      category.trim(), question_text.trim(),
      for_role || null, diff, notes || null,
      is_active === false ? 0 : 1,
      req.user.id,
    );
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (err) {
    console.error('POST /hr/final-round-questions error', err);
    res.status(500).json({ error: err.message || 'Failed to save question' });
  }
});

router.put('/final-round-questions/:id', (req, res) => {
  const { category, question_text, for_role, difficulty, notes, is_active } = req.body || {};
  getDb().prepare(`
    UPDATE final_round_questions SET
      category = COALESCE(?, category),
      question_text = COALESCE(?, question_text),
      for_role = ?,
      difficulty = COALESCE(?, difficulty),
      notes = ?,
      is_active = COALESCE(?, is_active)
    WHERE id = ?
  `).run(
    category || null, question_text || null,
    for_role || null, difficulty || null, notes || null,
    is_active == null ? null : (is_active ? 1 : 0),
    req.params.id,
  );
  res.json({ message: 'Updated' });
});

router.delete('/final-round-questions/:id', (req, res) => {
  const r = getDb().prepare('DELETE FROM final_round_questions WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Deleted' });
});

// ═════════════════════════════════════════════════════════════════
// INDUCTION (mam 2026-05-22 Phase 1 Batch E, module #11)
// ═════════════════════════════════════════════════════════════════
// Admin manages content under 5 standard sections (Founder Message /
// Company Culture / HR Policies / IT-Security / SOPs).  Employees
// view a read-only digest at /induction (separate page wired in App.jsx).

router.get('/induction', (req, res) => {
  const { active } = req.query;
  let sql = `SELECT * FROM induction_items WHERE 1=1`;
  if (active === '1') sql += ' AND is_active = 1';
  sql += ' ORDER BY section, order_index, id';
  res.json(getDb().prepare(sql).all());
});

router.post('/induction', (req, res) => {
  try {
    const { section, title, content_type, content_url, content_text, order_index } = req.body || {};
    if (!section || !title) return res.status(400).json({ error: 'Section and title required' });
    const ct = ['text','video','pdf','link'].includes(content_type) ? content_type : 'text';
    const r = getDb().prepare(`
      INSERT INTO induction_items (section, title, content_type, content_url, content_text, order_index, is_active, created_by)
      VALUES (?,?,?,?,?,?, 1, ?)
    `).run(section.trim(), title.trim(), ct, content_url || null, content_text || null,
           order_index != null ? +order_index : 0, req.user.id);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (err) {
    console.error('POST /hr/induction error', err);
    res.status(500).json({ error: err.message || 'Failed to save' });
  }
});

router.put('/induction/:id', (req, res) => {
  const { section, title, content_type, content_url, content_text, order_index, is_active } = req.body || {};
  getDb().prepare(`
    UPDATE induction_items SET
      section = COALESCE(?, section),
      title = COALESCE(?, title),
      content_type = COALESCE(?, content_type),
      content_url = ?,
      content_text = ?,
      order_index = COALESCE(?, order_index),
      is_active = COALESCE(?, is_active)
    WHERE id = ?
  `).run(
    section || null, title || null, content_type || null,
    content_url || null, content_text || null,
    order_index != null ? +order_index : null,
    is_active != null ? (is_active ? 1 : 0) : null,
    req.params.id,
  );
  res.json({ message: 'Updated' });
});

router.delete('/induction/:id', (req, res) => {
  const r = getDb().prepare('DELETE FROM induction_items WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Deleted' });
});

// ═════════════════════════════════════════════════════════════════
// TRAINING LIBRARY + ASSIGNMENTS (mam 2026-05-22 Phase 1 Batch E, #12)
// ═════════════════════════════════════════════════════════════════

router.get('/training/videos', (req, res) => {
  const { active, type } = req.query;
  let sql = `SELECT v.*,
                    (SELECT COUNT(*) FROM training_assignments a WHERE a.video_id = v.id) AS assigned_count,
                    (SELECT COUNT(*) FROM training_assignments a WHERE a.video_id = v.id AND a.completed_at IS NOT NULL) AS completed_count
               FROM training_videos v WHERE 1=1`;
  const args = [];
  if (active === '1') sql += ' AND v.is_active = 1';
  if (type)           { sql += ' AND v.training_type = ?'; args.push(type); }
  sql += ' ORDER BY v.created_at DESC';
  res.json(getDb().prepare(sql).all(...args));
});

router.post('/training/videos', (req, res) => {
  try {
    const { title, description, video_url, training_type, duration_minutes,
            target_dept, target_role, is_mandatory } = req.body || {};
    if (!title || !video_url) return res.status(400).json({ error: 'Title and video URL required' });
    const tt = ['product','process','communication','sop','other'].includes(training_type) ? training_type : 'sop';
    const r = getDb().prepare(`
      INSERT INTO training_videos
        (title, description, video_url, training_type, duration_minutes,
         target_dept, target_role, is_mandatory, is_active, created_by)
      VALUES (?,?,?,?,?,?,?,?, 1, ?)
    `).run(title.trim(), description || null, video_url.trim(), tt,
           duration_minutes ? +duration_minutes : null,
           target_dept || null, target_role || null,
           is_mandatory ? 1 : 0, req.user.id);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (err) {
    console.error('POST /hr/training/videos error', err);
    res.status(500).json({ error: err.message || 'Failed to save' });
  }
});

router.put('/training/videos/:id', (req, res) => {
  const { title, description, video_url, training_type, duration_minutes,
          target_dept, target_role, is_mandatory, is_active } = req.body || {};
  getDb().prepare(`
    UPDATE training_videos SET
      title = COALESCE(?, title),
      description = ?,
      video_url = COALESCE(?, video_url),
      training_type = COALESCE(?, training_type),
      duration_minutes = ?,
      target_dept = ?,
      target_role = ?,
      is_mandatory = COALESCE(?, is_mandatory),
      is_active = COALESCE(?, is_active)
    WHERE id = ?
  `).run(
    title || null, description || null, video_url || null,
    training_type || null,
    duration_minutes ? +duration_minutes : null,
    target_dept || null, target_role || null,
    is_mandatory != null ? (is_mandatory ? 1 : 0) : null,
    is_active != null ? (is_active ? 1 : 0) : null,
    req.params.id,
  );
  res.json({ message: 'Updated' });
});

router.delete('/training/videos/:id', (req, res) => {
  const r = getDb().prepare('DELETE FROM training_videos WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Deleted' });
});

// Assign a video to one or more employees (bulk).
// Body: { employee_ids: [...] }  → upserts (UNIQUE on employee_id+video_id)
router.post('/training/videos/:id/assign', (req, res) => {
  const { employee_ids } = req.body || {};
  if (!Array.isArray(employee_ids) || employee_ids.length === 0) {
    return res.status(400).json({ error: 'employee_ids required' });
  }
  const db = getDb();
  const ins = db.prepare(`
    INSERT OR IGNORE INTO training_assignments (employee_id, video_id, assigned_by)
    VALUES (?,?,?)
  `);
  let added = 0;
  for (const eid of employee_ids) {
    const r = ins.run(+eid, +req.params.id, req.user.id);
    if (r.changes) added++;
  }
  res.json({ assigned: added, skipped: employee_ids.length - added });
});

// Pull assignments for a specific video (admin view)
router.get('/training/videos/:id/assignments', (req, res) => {
  const rows = getDb().prepare(
    `SELECT a.*, e.name AS employee_name, e.department AS employee_department
       FROM training_assignments a
       LEFT JOIN employees e ON e.id = a.employee_id
      WHERE a.video_id = ?
      ORDER BY a.assigned_at DESC`
  ).all(req.params.id);
  res.json(rows);
});

router.delete('/training/assignments/:id', (req, res) => {
  const r = getDb().prepare('DELETE FROM training_assignments WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Unassigned' });
});

// "My Training" — what's assigned to the logged-in user (via their
// employees.user_id link).  Used by the employee-facing /training page.
router.get('/training/mine', (req, res) => {
  const db = getDb();
  const emp = db.prepare('SELECT id FROM employees WHERE user_id = ?').get(req.user.id);
  if (!emp) return res.json([]);
  const rows = db.prepare(
    `SELECT a.*, v.title, v.description, v.video_url, v.training_type, v.duration_minutes, v.is_mandatory
       FROM training_assignments a
       JOIN training_videos v ON v.id = a.video_id
      WHERE a.employee_id = ? AND v.is_active = 1
      ORDER BY v.is_mandatory DESC, a.assigned_at DESC`
  ).all(emp.id);
  res.json(rows);
});

router.post('/training/assignments/:id/start', (req, res) => {
  getDb().prepare(`UPDATE training_assignments
                     SET started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
                   WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

router.post('/training/assignments/:id/complete', (req, res) => {
  const { note } = req.body || {};
  getDb().prepare(`UPDATE training_assignments
                     SET completed_at = CURRENT_TIMESTAMP,
                         completion_note = ?,
                         started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
                   WHERE id = ?`).run(note || null, req.params.id);
  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════
// NOTIFICATIONS (mam 2026-05-22 Phase 1 Batch E, module #15)
// ═════════════════════════════════════════════════════════════════
// Created by routes (manual) + the hrAutomationsCron scanner.
// Bell-icon in the Layout polls /my-notifications every 60 sec.

router.get('/my-notifications', (req, res) => {
  const { unread } = req.query;
  let sql = 'SELECT * FROM notifications WHERE user_id = ?';
  if (unread === '1') sql += ' AND read_at IS NULL';
  sql += ' ORDER BY created_at DESC LIMIT 50';
  res.json(getDb().prepare(sql).all(req.user.id));
});

router.put('/notifications/:id/read', (req, res) => {
  getDb().prepare(
    `UPDATE notifications SET read_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND read_at IS NULL`
  ).run(req.params.id, req.user.id);
  res.json({ ok: true });
});

router.post('/notifications/mark-all-read', (req, res) => {
  getDb().prepare(
    `UPDATE notifications SET read_at = CURRENT_TIMESTAMP
     WHERE user_id = ? AND read_at IS NULL`
  ).run(req.user.id);
  res.json({ ok: true });
});

// JSON helper — never throws.
function safeParseJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { return s; }
}

// ═════════════════════════════════════════════════════════════════
// SCREENING QUESTIONS + ELIGIBILITY ENGINE
// (mam 2026-05-22 Phase 1 Batch C, modules #5 + #6)
// ═════════════════════════════════════════════════════════════════
//
// Per-position screening forms (hiring_request_id set) or GLOBAL
// (hiring_request_id NULL) for HR to fill during phone screening.
// On submit, the engine evaluates auto-reject rules and stamps the
// candidate with eligibility_status: eligible | partial | rejected.

// ── QUESTIONS CRUD ──
router.get('/screening-questions', (req, res) => {
  const { hiring_request_id, active } = req.query;
  let sql = `SELECT * FROM screening_questions WHERE 1=1`;
  const args = [];
  if (hiring_request_id === 'global') {
    sql += ' AND hiring_request_id IS NULL';
  } else if (hiring_request_id) {
    // Both this position's questions AND any global ones apply.
    sql += ' AND (hiring_request_id = ? OR hiring_request_id IS NULL)';
    args.push(+hiring_request_id);
  }
  if (active === '1') sql += ' AND is_active = 1';
  sql += ' ORDER BY hiring_request_id NULLS FIRST, order_index, id';
  const rows = getDb().prepare(sql).all(...args);
  res.json(rows.map(r => ({ ...r, options: safeParseJson(r.options) })));
});

router.post('/screening-questions', (req, res) => {
  try {
    const { hiring_request_id, question_text, question_type, options,
            is_mandatory, auto_reject_op, auto_reject_value,
            auto_reject_reason, order_index } = req.body || {};
    if (!question_text || !String(question_text).trim()) return res.status(400).json({ error: 'Question text is required' });
    const allowedTypes = ['mcq','descriptive','yes_no','number'];
    const qt = allowedTypes.includes(question_type) ? question_type : 'descriptive';
    const allowedOps = ['gt','lt','gte','lte','eq','neq','contains','not_contains','in','not_in'];
    const op = auto_reject_op && allowedOps.includes(auto_reject_op) ? auto_reject_op : null;
    const r = getDb().prepare(`
      INSERT INTO screening_questions
        (hiring_request_id, question_text, question_type, options,
         is_mandatory, auto_reject_op, auto_reject_value, auto_reject_reason,
         order_index, is_active, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,1,?)
    `).run(
      hiring_request_id ? +hiring_request_id : null,
      question_text.trim(), qt,
      options ? (typeof options === 'string' ? options : JSON.stringify(options)) : null,
      is_mandatory ? 1 : 0,
      op, op ? (auto_reject_value == null ? null : String(auto_reject_value)) : null,
      op ? (auto_reject_reason || null) : null,
      order_index != null ? +order_index : 0,
      req.user.id,
    );
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (err) {
    console.error('POST /hr/screening-questions error', err);
    res.status(500).json({ error: err.message || 'Failed to save question' });
  }
});

router.put('/screening-questions/:id', (req, res) => {
  const { hiring_request_id, question_text, question_type, options,
          is_mandatory, auto_reject_op, auto_reject_value,
          auto_reject_reason, order_index, is_active } = req.body || {};
  getDb().prepare(`
    UPDATE screening_questions SET
      hiring_request_id = ?,
      question_text = COALESCE(?, question_text),
      question_type = COALESCE(?, question_type),
      options = ?,
      is_mandatory = COALESCE(?, is_mandatory),
      auto_reject_op = ?,
      auto_reject_value = ?,
      auto_reject_reason = ?,
      order_index = COALESCE(?, order_index),
      is_active = COALESCE(?, is_active)
    WHERE id = ?
  `).run(
    hiring_request_id != null ? (hiring_request_id ? +hiring_request_id : null) : null,
    question_text || null, question_type || null,
    options != null ? (typeof options === 'string' ? options : JSON.stringify(options)) : null,
    is_mandatory != null ? (is_mandatory ? 1 : 0) : null,
    auto_reject_op || null,
    auto_reject_value != null ? String(auto_reject_value) : null,
    auto_reject_reason || null,
    order_index != null ? +order_index : null,
    is_active != null ? (is_active ? 1 : 0) : null,
    req.params.id,
  );
  res.json({ message: 'Updated' });
});

router.delete('/screening-questions/:id', (req, res) => {
  const db = getDb();
  // Cascade deletes answers via ON DELETE CASCADE.
  const r = db.prepare('DELETE FROM screening_questions WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Deleted' });
});

// ── EVALUATION HELPERS ──
//
// evalRule(answer, op, value) → boolean (true = AUTO-REJECT TRIGGERED)
// Handles numeric coercion for gt/lt/gte/lte, CSV split for in/not_in,
// case-insensitive contains for descriptive answers.
function evalRule(answerRaw, op, value) {
  if (!op) return false;
  const a = answerRaw == null ? '' : String(answerRaw).trim();
  const v = value == null ? '' : String(value).trim();
  if (!a && a !== '0') return false;  // unanswered — handled by 'partial', not 'rejected'
  switch (op) {
    case 'eq':            return a.toLowerCase() === v.toLowerCase();
    case 'neq':           return a.toLowerCase() !== v.toLowerCase();
    case 'gt':            return Number(a) >  Number(v);
    case 'lt':            return Number(a) <  Number(v);
    case 'gte':           return Number(a) >= Number(v);
    case 'lte':           return Number(a) <= Number(v);
    case 'contains':      return a.toLowerCase().includes(v.toLowerCase());
    case 'not_contains':  return !a.toLowerCase().includes(v.toLowerCase());
    case 'in': {
      const list = v.split(/[,;|]/).map(s => s.trim().toLowerCase()).filter(Boolean);
      return list.includes(a.toLowerCase());
    }
    case 'not_in': {
      const list = v.split(/[,;|]/).map(s => s.trim().toLowerCase()).filter(Boolean);
      return !list.includes(a.toLowerCase());
    }
    default: return false;
  }
}

// ── ANSWER SUBMIT + AUTO-EVALUATE ──
router.post('/candidates/:id/screening-answers', (req, res) => {
  try {
    const candidateId = +req.params.id;
    const { answers } = req.body || {};        // [{ question_id, answer_text }]
    if (!Array.isArray(answers)) return res.status(400).json({ error: 'answers must be an array' });

    const db = getDb();
    const candidate = db.prepare('SELECT id, hiring_request_id FROM candidates WHERE id=?').get(candidateId);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

    // Pull applicable questions (this position + globals)
    let qSql = `SELECT * FROM screening_questions WHERE is_active = 1`;
    const qArgs = [];
    if (candidate.hiring_request_id) {
      qSql += ' AND (hiring_request_id = ? OR hiring_request_id IS NULL)';
      qArgs.push(candidate.hiring_request_id);
    } else {
      qSql += ' AND hiring_request_id IS NULL';
    }
    const questions = db.prepare(qSql).all(...qArgs);

    // Delete + reinsert the candidate's answers (re-screening is allowed)
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM screening_answers WHERE candidate_id = ?').run(candidateId);
      const ins = db.prepare(
        `INSERT INTO screening_answers (candidate_id, question_id, answer_text, auto_rejected, created_by)
         VALUES (?,?,?,?,?)`
      );

      // Build a quick lookup of submitted answers
      const ansByQ = {};
      for (const a of answers) {
        if (a && a.question_id != null) ansByQ[+a.question_id] = a.answer_text;
      }

      // Evaluate each applicable question
      let firstRejectReason = null;
      let firstMissingMandatory = null;
      for (const q of questions) {
        const ans = ansByQ[q.id];
        const rejected = evalRule(ans, q.auto_reject_op, q.auto_reject_value);
        if (rejected && !firstRejectReason) {
          firstRejectReason = q.auto_reject_reason ||
            `Auto-rejected: "${q.question_text}" answer (${ans}) failed rule ${q.auto_reject_op} ${q.auto_reject_value}`;
        }
        if (q.is_mandatory && (ans == null || String(ans).trim() === '') && !firstMissingMandatory) {
          firstMissingMandatory = `Missing mandatory: "${q.question_text}"`;
        }
        // Save the answer (only for questions the user actually answered)
        if (ans != null && String(ans).trim() !== '') {
          ins.run(candidateId, q.id, String(ans), rejected ? 1 : 0, req.user.id);
        }
      }

      // Stamp eligibility
      let status, reason;
      if (firstRejectReason) {
        status = 'rejected';
        reason = firstRejectReason;
      } else if (firstMissingMandatory) {
        status = 'partial';
        reason = firstMissingMandatory;
      } else {
        status = 'eligible';
        reason = null;
      }
      db.prepare(`UPDATE candidates
                     SET eligibility_status = ?,
                         eligibility_reason = ?,
                         screened_at = CURRENT_TIMESTAMP
                   WHERE id = ?`).run(status, reason, candidateId);

      logEvent(db, candidateId, 'screening_done', {
        note: `Screening: ${status}${reason ? ' — ' + reason : ''}`,
        user_id: req.user.id, user_name: req.user.name,
      });

      return { status, reason };
    });

    const out = tx();
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error('POST /hr/candidates/:id/screening-answers error', err);
    res.status(500).json({ error: err.message || 'Failed to save screening answers' });
  }
});

router.get('/candidates/:id/screening-answers', (req, res) => {
  const rows = getDb().prepare(
    `SELECT a.*, q.question_text, q.question_type, q.options, q.is_mandatory,
            q.auto_reject_op, q.auto_reject_value, q.auto_reject_reason
       FROM screening_answers a
       JOIN screening_questions q ON q.id = a.question_id
      WHERE a.candidate_id = ?
      ORDER BY q.order_index, q.id`
  ).all(req.params.id);
  res.json(rows.map(r => ({ ...r, options: safeParseJson(r.options) })));
});

// ═════════════════════════════════════════════════════════════════
// PRE-ONBOARDING DOCS (mam 2026-05-22 Phase 1 Batch D, module #10)
// ═════════════════════════════════════════════════════════════════
// Standard checklist: Aadhaar / PAN / Resume / Experience / Bank +
// admin-added custom items.  Status flow: pending → received →
// verified (or rejected).  File URL stored when received.

// Default checklist items seeded on-demand when admin first opens
// the docs modal for a candidate.  Idempotent — only inserts items
// the candidate doesn't already have.
const DEFAULT_DOC_TYPES = [
  { type: 'aadhaar',     label: 'Aadhaar Card' },
  { type: 'pan',         label: 'PAN Card' },
  { type: 'resume',      label: 'Resume / CV' },
  { type: 'experience',  label: 'Experience Letter(s)' },
  { type: 'bank',        label: 'Cancelled Cheque / Bank Details' },
  { type: 'photo',       label: 'Passport-size Photo' },
  { type: 'education',   label: 'Education Certificates' },
];

router.get('/candidates/:id/docs', (req, res) => {
  const db = getDb();
  const cid = +req.params.id;
  // Guard against a bad/non-numeric id — otherwise the seed INSERT below
  // trips a FOREIGN KEY / NOT NULL constraint and 500s instead of 404ing.
  if (!Number.isInteger(cid) || cid <= 0) {
    return res.status(400).json({ error: 'invalid candidate id' });
  }
  if (!db.prepare('SELECT 1 FROM candidates WHERE id = ?').get(cid)) {
    return res.status(404).json({ error: 'candidate not found' });
  }
  // Seed defaults if nothing exists yet for this candidate.
  const existing = db.prepare('SELECT doc_type FROM candidate_docs WHERE candidate_id = ?').all(cid);
  if (existing.length === 0) {
    const ins = db.prepare(
      `INSERT INTO candidate_docs (candidate_id, doc_type, doc_label, status)
       VALUES (?,?,?, 'pending')`
    );
    for (const d of DEFAULT_DOC_TYPES) ins.run(cid, d.type, d.label);
  }
  // If the candidate has a resume_file on the candidate row, mark
  // the 'resume' doc as received automatically (one-time convenience
  // — admin can always override).
  const cand = db.prepare('SELECT resume_file FROM candidates WHERE id=?').get(cid);
  if (cand?.resume_file) {
    db.prepare(
      `UPDATE candidate_docs
          SET file_url   = COALESCE(file_url, ?),
              status     = CASE WHEN status = 'pending' THEN 'received' ELSE status END,
              uploaded_at = COALESCE(uploaded_at, CURRENT_TIMESTAMP)
        WHERE candidate_id = ? AND doc_type = 'resume'`
    ).run(cand.resume_file, cid);
  }
  const rows = db.prepare(
    `SELECT * FROM candidate_docs WHERE candidate_id = ? ORDER BY id`
  ).all(cid);
  res.json(rows);
});

router.post('/candidates/:id/docs', (req, res) => {
  const { doc_type, doc_label, file_url, status, notes } = req.body || {};
  if (!doc_type || !String(doc_type).trim()) return res.status(400).json({ error: 'doc_type is required' });
  const st = ['pending','received','verified','rejected'].includes(status) ? status : 'pending';
  const r = getDb().prepare(`
    INSERT INTO candidate_docs (candidate_id, doc_type, doc_label, file_url, status, notes, uploaded_at)
    VALUES (?,?,?,?,?,?, CASE WHEN ? IS NOT NULL THEN CURRENT_TIMESTAMP ELSE NULL END)
  `).run(+req.params.id, doc_type.trim(), doc_label || null, file_url || null, st, notes || null, file_url || null);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/docs/:id', (req, res) => {
  const { doc_label, file_url, status, notes } = req.body || {};
  const db = getDb();
  const cur = db.prepare('SELECT * FROM candidate_docs WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const verifying = status === 'verified' && cur.status !== 'verified';
  // First file upload → stamp uploaded_at
  const willUpload = file_url && !cur.file_url;
  db.prepare(`
    UPDATE candidate_docs SET
      doc_label = COALESCE(?, doc_label),
      file_url = COALESCE(?, file_url),
      status = COALESCE(?, status),
      notes = ?,
      uploaded_at = COALESCE(uploaded_at, CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END),
      verified_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE verified_at END,
      verified_by = CASE WHEN ? THEN ?               ELSE verified_by END
    WHERE id = ?
  `).run(
    doc_label || null,
    file_url || null,
    status || null,
    notes != null ? notes : null,
    willUpload ? 1 : 0,
    verifying ? 1 : 0,
    verifying ? 1 : 0,
    req.user.id,
    req.params.id,
  );
  res.json({ message: 'Updated' });
});

router.delete('/docs/:id', (req, res) => {
  const r = getDb().prepare('DELETE FROM candidate_docs WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Deleted' });
});

// ═════════════════════════════════════════════════════════════════
// HR DASHBOARD — 6 KPIs (mam 2026-05-22 Phase 1 Batch C, module #14)
// ═════════════════════════════════════════════════════════════════
//
// Single endpoint that powers the Dashboard tab inside /hr.  Cheap
// aggregates over candidates + hiring_requests; runs in <50ms even
// at a few thousand rows since SQLite indexes the candidate.status
// column implicitly via the CHECK constraint.

router.get('/dashboard', (req, res) => {
  const db = getDb();

  // ── 1. Open positions: approved + not closed
  const openPositions = db.prepare(
    `SELECT COUNT(*) AS c FROM hiring_requests WHERE status = 'approved'`
  ).get().c;

  // ── 2. Candidates in pipeline: NOT rejected/onboarded
  const inPipeline = db.prepare(
    `SELECT COUNT(*) AS c FROM candidates
      WHERE status NOT IN ('rejected','onboarded')`
  ).get().c;

  // ── 3. Time to hire: avg(joining_date - created_at) for onboarded
  //
  // Mam (2026-05-22 audit fix): the COALESCE(joining_date, DATE('now'))
  // fallback was wrong — when status='onboarded' the candidate MUST
  // have a joining_date.  If joining_date is NULL it's a data bug;
  // we should exclude that row from the average, not substitute today
  // (which gives a misleadingly small number for "missing data" rows).
  const tth = db.prepare(`
    SELECT AVG(julianday(joining_date) - julianday(DATE(created_at))) AS days,
           COUNT(*) AS n
    FROM candidates
   WHERE status = 'onboarded' AND joining_date IS NOT NULL
  `).get();
  const timeToHireDays = tth.days != null ? Math.round(tth.days) : null;

  // ── 4. Offer acceptance rate: accepted+onboarded / (offer_sent+accepted+onboarded)
  //     "rejected after offer" isn't tracked separately yet, so we
  //     approximate using post-offer statuses.
  const offers = db.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('accepted','onboarded') THEN 1 ELSE 0 END) AS accepted_count,
      SUM(CASE WHEN status IN ('offer_sent','accepted','onboarded') THEN 1 ELSE 0 END) AS offer_count
    FROM candidates
  `).get();
  const offerAcceptRate = offers.offer_count > 0
    ? Math.round((offers.accepted_count / offers.offer_count) * 1000) / 10   // 1-decimal %
    : null;

  // ── 5. Joining status: candidates with offers accepted (joining pending)
  //     Split into "this month" vs "later" for the dashboard tile.
  const joining = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'onboarded' THEN 1 ELSE 0 END) AS onboarded,
      SUM(CASE WHEN status = 'accepted' AND joining_date IS NOT NULL
                AND joining_date BETWEEN DATE('now') AND DATE('now','+30 days')
               THEN 1 ELSE 0 END) AS joining_next_30
    FROM candidates
  `).get();

  // ── 6. Pending interviews: scheduled and date is today or future
  const pendingInterviews = db.prepare(`
    SELECT COUNT(*) AS c FROM candidates
     WHERE status = 'interview_scheduled'
       AND (interview_date IS NULL OR DATE(interview_date) >= DATE('now'))
  `).get().c;

  // ── Extras for the dashboard charts
  const byStage = db.prepare(`
    SELECT status, COUNT(*) AS c FROM candidates
     WHERE is_on_hold = 0 OR is_on_hold IS NULL
     GROUP BY status
  `).all();

  const bySource = db.prepare(`
    SELECT source, COUNT(*) AS c FROM candidates
     WHERE source IS NOT NULL GROUP BY source
  `).all();

  const newThisMonth = db.prepare(`
    SELECT COUNT(*) AS c FROM candidates
     WHERE created_at >= DATE('now','start of month')
  `).get().c;

  const eligibility = db.prepare(`
    SELECT
      SUM(CASE WHEN eligibility_status = 'eligible' THEN 1 ELSE 0 END) AS eligible,
      SUM(CASE WHEN eligibility_status = 'partial' THEN 1 ELSE 0 END) AS partial,
      SUM(CASE WHEN eligibility_status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN eligibility_status IS NULL THEN 1 ELSE 0 END) AS not_screened
    FROM candidates
  `).get();

  // ── Hiring requests by status (for the dashboard's "open" tile drill-down)
  const reqsByStatus = db.prepare(`
    SELECT status, COUNT(*) AS c FROM hiring_requests GROUP BY status
  `).all();

  res.json({
    kpis: {
      open_positions:        openPositions || 0,
      candidates_in_pipeline: inPipeline || 0,
      time_to_hire_days:      timeToHireDays,                 // null if no onboarded yet
      offer_acceptance_rate:  offerAcceptRate,                // % (1 decimal)
      joining_pending:        joining.pending || 0,
      joining_next_30:        joining.joining_next_30 || 0,
      pending_interviews:     pendingInterviews || 0,
      new_this_month:         newThisMonth || 0,
    },
    eligibility:    eligibility,
    by_stage:       byStage,
    by_source:      bySource,
    reqs_by_status: reqsByStatus,
  });
});

module.exports = router;
