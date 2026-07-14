// HR System — Phase 1 (MVP)
//
// Mam (2026-05-22) shared a 15-module spec for an HR operating system.
// This file is the foundation: schema for all priority tables +
// REST endpoints for Hiring Requests, Candidates ATS, Interviews,
// Offers, Onboarding, Training, and a Dashboard.  The frontend
// (HRSystem.jsx) consumes everything from here.
//
// Priority order (from mam's spec):
//   1 ATS · 2 Hiring Request · 3 JD · 4 Interview · 5 Screening
//   6 Offer · 7 Onboarding · 8 Training · 9 Employee Profiles · 10 Dashboard
//
// Phase 1 deliberately omits: payroll, attendance, full appraisals,
// AI scoring, multi-company, ERP integrations.

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { logAuditEvent } = require('../middleware/audit');

const router = express.Router();
router.use(authMiddleware);

// Resume / offer-letter / training video uploads land here.
const uploadDir = path.join(__dirname, '..', '..', 'data', 'uploads', 'hr');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '.bin');
      cb(null, `hr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ── Idempotent migrations ───────────────────────────────────────
try {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_hiring_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_no TEXT UNIQUE,
      department TEXT,
      position_title TEXT NOT NULL,
      openings INTEGER DEFAULT 1,
      salary_min REAL,
      salary_max REAL,
      experience_required TEXT,
      employment_type TEXT,
      hiring_deadline DATE,
      reporting_manager TEXT,
      raised_by INTEGER REFERENCES users(id),
      approved_by INTEGER REFERENCES users(id),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','closed')),
      reject_reason TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_hr_hr_status ON hr_hiring_requests(status)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_jds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hiring_request_id INTEGER REFERENCES hr_hiring_requests(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      department TEXT,
      experience TEXT,
      education TEXT,
      responsibilities TEXT,
      required_skills TEXT,
      good_to_have TEXT,
      is_public INTEGER DEFAULT 0,
      template_name TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_no TEXT UNIQUE,
      full_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      current_company TEXT,
      current_role TEXT,
      current_salary REAL,
      expected_salary REAL,
      notice_period TEXT,
      experience_years REAL,
      location TEXT,
      source TEXT,
      hiring_request_id INTEGER REFERENCES hr_hiring_requests(id) ON DELETE SET NULL,
      resume_url TEXT,
      status TEXT DEFAULT 'applied' CHECK(status IN ('applied','screening','interview','final_round','selected','rejected','on_hold','offered','joined')),
      tags TEXT,
      notes TEXT,
      rejected_reason TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_hr_cand_status ON hr_candidates(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_hr_cand_email ON hr_candidates(email)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_hr_cand_phone ON hr_candidates(phone)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_candidate_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL REFERENCES hr_candidates(id) ON DELETE CASCADE,
      activity_type TEXT,
      from_status TEXT,
      to_status TEXT,
      note TEXT,
      by_user_id INTEGER REFERENCES users(id),
      by_user_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_interviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL REFERENCES hr_candidates(id) ON DELETE CASCADE,
      round_name TEXT,
      scheduled_at DATETIME,
      duration_min INTEGER DEFAULT 60,
      mode TEXT,
      location_or_link TEXT,
      interviewer_ids TEXT,
      interviewer_names TEXT,
      status TEXT DEFAULT 'scheduled' CHECK(status IN ('scheduled','completed','no_show','cancelled')),
      outcome TEXT,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_interview_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      interview_id INTEGER NOT NULL REFERENCES hr_interviews(id) ON DELETE CASCADE,
      interviewer_id INTEGER REFERENCES users(id),
      technical_score INTEGER,
      communication_score INTEGER,
      culture_score INTEGER,
      problem_solving_score INTEGER,
      overall_rating INTEGER,
      recommendation TEXT,
      feedback_notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL REFERENCES hr_candidates(id) ON DELETE CASCADE,
      offered_position TEXT,
      offered_salary REAL,
      joining_date DATE,
      offer_letter_url TEXT,
      accept_token TEXT UNIQUE,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','sent','accepted','declined','expired','withdrawn')),
      sent_at DATETIME,
      responded_at DATETIME,
      expiry_date DATE,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_onboarding_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER REFERENCES hr_candidates(id) ON DELETE CASCADE,
      task_name TEXT NOT NULL,
      task_type TEXT,
      due_date DATE,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','submitted','completed','overdue')),
      document_url TEXT,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_training_videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT,
      video_url TEXT,
      duration_min INTEGER,
      is_mandatory INTEGER DEFAULT 0,
      for_role TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_training_completion (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER REFERENCES hr_training_videos(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      candidate_id INTEGER REFERENCES hr_candidates(id),
      watched_pct INTEGER DEFAULT 0,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
} catch (e) {
  console.warn('[hr_system] schema init skipped:', e.message);
}

// ── Helpers ─────────────────────────────────────────────────────
function nextNo(db, table, col, prefix, pad = 4) {
  const last = db.prepare(`SELECT ${col} FROM ${table} WHERE ${col} LIKE ? ORDER BY id DESC LIMIT 1`).get(`${prefix}%`);
  let n = 1;
  if (last?.[col]) {
    const m = new RegExp(`${prefix}(\\d+)`).exec(last[col]);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `${prefix}${String(n).padStart(pad, '0')}`;
}

function recordActivity(db, candidate_id, type, from_status, to_status, note, user) {
  try {
    db.prepare(`
      INSERT INTO hr_candidate_activity (candidate_id, activity_type, from_status, to_status, note, by_user_id, by_user_name)
      VALUES (?,?,?,?,?,?,?)
    `).run(candidate_id, type, from_status || null, to_status || null, note || null, user?.id || null, user?.name || null);
  } catch (e) {
    console.warn('[hr_system] activity log skipped:', e.message);
  }
}

// ════════════════════════════════════════════════════════════════
// HIRING REQUESTS
// ════════════════════════════════════════════════════════════════
router.get('/hiring-requests', requirePermission('hr_system', 'view'), (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT hr.*, u.name AS raised_by_name, au.name AS approved_by_name,
             (SELECT COUNT(*) FROM hr_candidates c WHERE c.hiring_request_id = hr.id) AS candidate_count
      FROM hr_hiring_requests hr
      LEFT JOIN users u ON u.id = hr.raised_by
      LEFT JOIN users au ON au.id = hr.approved_by
      ORDER BY hr.created_at DESC
    `).all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/hiring-requests', requirePermission('hr_system', 'create'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  if (!b.position_title) return res.status(400).json({ error: 'Position title required' });
  try {
    const request_no = nextNo(db, 'hr_hiring_requests', 'request_no', 'HR-', 4);
    const r = db.prepare(`
      INSERT INTO hr_hiring_requests (request_no, department, position_title, openings, salary_min, salary_max,
        experience_required, employment_type, hiring_deadline, reporting_manager, raised_by, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(request_no, b.department || null, b.position_title, +b.openings || 1,
      +b.salary_min || null, +b.salary_max || null, b.experience_required || null,
      b.employment_type || null, b.hiring_deadline || null, b.reporting_manager || null,
      req.user.id, b.notes || null);
    logAuditEvent({ user: req.user, action: 'CREATE', entity_type: 'hr_hiring_request',
      entity_id: r.lastInsertRowid, entity_label: request_no });
    res.json({ id: r.lastInsertRowid, request_no });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/hiring-requests/:id', requirePermission('hr_system', 'edit'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  try {
    const existing = db.prepare('SELECT * FROM hr_hiring_requests WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    db.prepare(`
      UPDATE hr_hiring_requests SET
        department=COALESCE(?,department), position_title=COALESCE(?,position_title),
        openings=COALESCE(?,openings), salary_min=?, salary_max=?,
        experience_required=COALESCE(?,experience_required), employment_type=COALESCE(?,employment_type),
        hiring_deadline=?, reporting_manager=COALESCE(?,reporting_manager), notes=COALESCE(?,notes),
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(b.department, b.position_title, b.openings != null ? +b.openings : null,
      b.salary_min != null ? +b.salary_min : existing.salary_min,
      b.salary_max != null ? +b.salary_max : existing.salary_max,
      b.experience_required, b.employment_type,
      b.hiring_deadline !== undefined ? b.hiring_deadline : existing.hiring_deadline,
      b.reporting_manager, b.notes, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/hiring-requests/:id/approve', requirePermission('hr_system', 'approve'), (req, res) => {
  const db = getDb();
  try {
    // Separation of duties — same rule as Indents: creator can't approve their own request
    const cur = db.prepare('SELECT raised_by FROM hr_hiring_requests WHERE id=?').get(req.params.id);
    if (cur && cur.raised_by === req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You cannot approve a hiring request you raised yourself. Ask another approver.' });
    }
    db.prepare(`UPDATE hr_hiring_requests SET status='approved', approved_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/hiring-requests/:id/reject', requirePermission('hr_system', 'approve'), (req, res) => {
  const db = getDb();
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Reason required' });
  try {
    db.prepare(`UPDATE hr_hiring_requests SET status='rejected', reject_reason=?, approved_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(reason, req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/hiring-requests/:id', requirePermission('hr_system', 'delete'), (req, res) => {
  const db = getDb();
  try {
    db.prepare('DELETE FROM hr_hiring_requests WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
// CANDIDATES (ATS)
// ════════════════════════════════════════════════════════════════
router.get('/candidates', requirePermission('hr_system', 'view'), (req, res) => {
  const db = getDb();
  const { status, hiring_request_id, search } = req.query;
  let sql = `
    SELECT c.*, hr.position_title AS hr_position, hr.request_no AS hr_request_no,
           (SELECT COUNT(*) FROM hr_interviews i WHERE i.candidate_id = c.id) AS interview_count
    FROM hr_candidates c
    LEFT JOIN hr_hiring_requests hr ON hr.id = c.hiring_request_id
    WHERE 1=1
  `;
  const params = [];
  if (status) { sql += ' AND c.status = ?'; params.push(status); }
  if (hiring_request_id) { sql += ' AND c.hiring_request_id = ?'; params.push(+hiring_request_id); }
  if (search) {
    sql += ' AND (c.full_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.candidate_no LIKE ?)';
    const q = `%${search}%`; params.push(q, q, q, q);
  }
  sql += ' ORDER BY c.created_at DESC';
  try {
    res.json(db.prepare(sql).all(...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/candidates/:id', requirePermission('hr_system', 'view'), (req, res) => {
  const db = getDb();
  try {
    const c = db.prepare(`
      SELECT c.*, hr.position_title AS hr_position, hr.request_no AS hr_request_no
      FROM hr_candidates c LEFT JOIN hr_hiring_requests hr ON hr.id = c.hiring_request_id
      WHERE c.id = ?
    `).get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    c.activity = db.prepare(`
      SELECT * FROM hr_candidate_activity WHERE candidate_id=? ORDER BY created_at DESC
    `).all(req.params.id);
    c.interviews = db.prepare(`
      SELECT * FROM hr_interviews WHERE candidate_id=? ORDER BY scheduled_at DESC
    `).all(req.params.id);
    c.offers = db.prepare(`
      SELECT * FROM hr_offers WHERE candidate_id=? ORDER BY created_at DESC
    `).all(req.params.id);
    res.json(c);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/candidates', requirePermission('hr_system', 'create'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  if (!b.full_name) return res.status(400).json({ error: 'Candidate name required' });
  try {
    // Duplicate guard — same email OR same phone = same candidate
    const { findDuplicate, sendDuplicate } = require('../utils/duplicateGuard');
    if (b.email) {
      const dup = findDuplicate(db, { table: 'hr_candidates', fields: { email: b.email }, codeColumn: 'candidate_no' });
      if (sendDuplicate(res, dup, `Candidate with email ${b.email}`)) return;
    }
    if (b.phone) {
      const dup = findDuplicate(db, { table: 'hr_candidates', fields: { phone: b.phone }, codeColumn: 'candidate_no' });
      if (sendDuplicate(res, dup, `Candidate with phone ${b.phone}`)) return;
    }

    const candidate_no = nextNo(db, 'hr_candidates', 'candidate_no', 'CND-', 5);
    const r = db.prepare(`
      INSERT INTO hr_candidates (candidate_no, full_name, email, phone, current_company, current_role,
        current_salary, expected_salary, notice_period, experience_years, location, source,
        hiring_request_id, resume_url, tags, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(candidate_no, b.full_name, b.email || null, b.phone || null, b.current_company || null,
      b.current_role || null, +b.current_salary || null, +b.expected_salary || null,
      b.notice_period || null, +b.experience_years || null, b.location || null,
      b.source || null, b.hiring_request_id || null, b.resume_url || null,
      b.tags || null, b.notes || null, req.user.id);
    recordActivity(db, r.lastInsertRowid, 'created', null, 'applied', `Candidate added (source: ${b.source || '—'})`, req.user);
    logAuditEvent({ user: req.user, action: 'CREATE', entity_type: 'hr_candidate',
      entity_id: r.lastInsertRowid, entity_label: candidate_no });
    res.json({ id: r.lastInsertRowid, candidate_no });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/candidates/:id', requirePermission('hr_system', 'edit'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  try {
    const existing = db.prepare('SELECT * FROM hr_candidates WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    db.prepare(`
      UPDATE hr_candidates SET
        full_name=COALESCE(?,full_name), email=COALESCE(?,email), phone=COALESCE(?,phone),
        current_company=COALESCE(?,current_company), current_role=COALESCE(?,current_role),
        current_salary=?, expected_salary=?, notice_period=COALESCE(?,notice_period),
        experience_years=?, location=COALESCE(?,location), source=COALESCE(?,source),
        hiring_request_id=?, resume_url=COALESCE(?,resume_url), tags=COALESCE(?,tags),
        notes=COALESCE(?,notes), updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(b.full_name, b.email, b.phone, b.current_company, b.current_role,
      b.current_salary != null ? +b.current_salary : existing.current_salary,
      b.expected_salary != null ? +b.expected_salary : existing.expected_salary,
      b.notice_period,
      b.experience_years != null ? +b.experience_years : existing.experience_years,
      b.location, b.source,
      b.hiring_request_id !== undefined ? b.hiring_request_id : existing.hiring_request_id,
      b.resume_url, b.tags, b.notes, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/candidates/:id/status', requirePermission('hr_system', 'edit'), (req, res) => {
  const db = getDb();
  const { status, note } = req.body || {};
  const allowed = ['applied','screening','interview','final_round','selected','rejected','on_hold','offered','joined'];
  if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });
  try {
    const cur = db.prepare('SELECT status FROM hr_candidates WHERE id=?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Not found' });
    db.prepare(`UPDATE hr_candidates SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(status, req.params.id);
    recordActivity(db, req.params.id, 'status_change', cur.status, status, note || null, req.user);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/candidates/:id/resume', requirePermission('hr_system', 'edit'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `/uploads/hr/${path.basename(req.file.path)}`;
  const db = getDb();
  try {
    db.prepare('UPDATE hr_candidates SET resume_url=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(url, req.params.id);
    recordActivity(db, req.params.id, 'resume_uploaded', null, null, `Resume: ${req.file.originalname}`, req.user);
    res.json({ ok: true, resume_url: url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/candidates/:id/note', requirePermission('hr_system', 'edit'), (req, res) => {
  const db = getDb();
  const note = String(req.body?.note || '').trim();
  if (!note) return res.status(400).json({ error: 'Note text required' });
  try {
    recordActivity(db, req.params.id, 'note', null, null, note, req.user);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/candidates/:id', requirePermission('hr_system', 'delete'), (req, res) => {
  const db = getDb();
  try {
    db.prepare('DELETE FROM hr_candidates WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
// INTERVIEWS
// ════════════════════════════════════════════════════════════════
router.get('/interviews', requirePermission('hr_system', 'view'), (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT i.*, c.full_name AS candidate_name, c.candidate_no, c.status AS candidate_status
      FROM hr_interviews i
      JOIN hr_candidates c ON c.id = i.candidate_id
      ORDER BY i.scheduled_at DESC
    `).all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/interviews', requirePermission('hr_system', 'create'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  if (!b.candidate_id || !b.scheduled_at) return res.status(400).json({ error: 'Candidate + scheduled_at required' });
  try {
    const r = db.prepare(`
      INSERT INTO hr_interviews (candidate_id, round_name, scheduled_at, duration_min, mode,
        location_or_link, interviewer_ids, interviewer_names, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(b.candidate_id, b.round_name || 'Round', b.scheduled_at, +b.duration_min || 60,
      b.mode || 'Video', b.location_or_link || null,
      b.interviewer_ids || null, b.interviewer_names || null, b.notes || null, req.user.id);
    recordActivity(db, b.candidate_id, 'interview_scheduled', null, null,
      `${b.round_name || 'Round'} scheduled for ${b.scheduled_at}`, req.user);
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/interviews/:id/feedback', requirePermission('hr_system', 'edit'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  try {
    db.prepare(`
      INSERT INTO hr_interview_feedback (interview_id, interviewer_id, technical_score,
        communication_score, culture_score, problem_solving_score, overall_rating,
        recommendation, feedback_notes)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(req.params.id, req.user.id, +b.technical_score || null, +b.communication_score || null,
      +b.culture_score || null, +b.problem_solving_score || null, +b.overall_rating || null,
      b.recommendation || null, b.feedback_notes || null);
    db.prepare(`UPDATE hr_interviews SET status='completed', outcome=COALESCE(?,outcome) WHERE id=?`)
      .run(b.recommendation || null, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
// OFFERS
// ════════════════════════════════════════════════════════════════
router.get('/offers', requirePermission('hr_system', 'view'), (req, res) => {
  const db = getDb();
  try {
    res.json(db.prepare(`
      SELECT o.*, c.full_name AS candidate_name, c.candidate_no, c.email AS candidate_email
      FROM hr_offers o JOIN hr_candidates c ON c.id = o.candidate_id
      ORDER BY o.created_at DESC
    `).all());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/offers', requirePermission('hr_system', 'create'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  if (!b.candidate_id) return res.status(400).json({ error: 'candidate_id required' });
  try {
    const accept_token = require('crypto').randomBytes(16).toString('hex');
    const r = db.prepare(`
      INSERT INTO hr_offers (candidate_id, offered_position, offered_salary, joining_date,
        offer_letter_url, accept_token, expiry_date, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(b.candidate_id, b.offered_position || null, +b.offered_salary || null,
      b.joining_date || null, b.offer_letter_url || null, accept_token,
      b.expiry_date || null, b.notes || null, req.user.id);
    recordActivity(db, b.candidate_id, 'offer_created', null, 'offered',
      `Offer drafted (₹${b.offered_salary || '—'})`, req.user);
    res.json({ id: r.lastInsertRowid, accept_token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/offers/:id/send', requirePermission('hr_system', 'edit'), (req, res) => {
  const db = getDb();
  try {
    db.prepare(`UPDATE hr_offers SET status='sent', sent_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.params.id);
    const off = db.prepare('SELECT * FROM hr_offers WHERE id=?').get(req.params.id);
    if (off) db.prepare('UPDATE hr_candidates SET status=? WHERE id=?').run('offered', off.candidate_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public offer-accept endpoint — candidate clicks the wa.me / email link.
router.post('/offers/accept/:token', (req, res) => {
  const db = getDb();
  const accepted = !!req.body?.accepted;
  try {
    const off = db.prepare('SELECT * FROM hr_offers WHERE accept_token=?').get(req.params.token);
    if (!off) return res.status(404).json({ error: 'Invalid offer link' });
    if (off.status !== 'sent') return res.status(400).json({ error: 'Offer is not awaiting response' });
    const newStatus = accepted ? 'accepted' : 'declined';
    db.prepare(`UPDATE hr_offers SET status=?, responded_at=CURRENT_TIMESTAMP WHERE id=?`).run(newStatus, off.id);
    if (accepted) db.prepare('UPDATE hr_candidates SET status=? WHERE id=?').run('joined', off.candidate_id);
    res.json({ ok: true, status: newStatus });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
// DASHBOARD KPIs
// ════════════════════════════════════════════════════════════════
router.get('/dashboard', requirePermission('hr_system', 'view'), (req, res) => {
  const db = getDb();
  try {
    const openPositions = db.prepare(`SELECT COUNT(*) c FROM hr_hiring_requests WHERE status IN ('approved','pending')`).get().c;
    const pipelineByStatus = db.prepare(`
      SELECT status, COUNT(*) c FROM hr_candidates
      WHERE status NOT IN ('rejected','joined')
      GROUP BY status
    `).all();
    const offerStats = db.prepare(`
      SELECT
        SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) accepted,
        SUM(CASE WHEN status='declined' THEN 1 ELSE 0 END) declined,
        SUM(CASE WHEN status='sent'     THEN 1 ELSE 0 END) pending,
        COUNT(*) total
      FROM hr_offers
    `).get();
    const pendingInterviews = db.prepare(`
      SELECT COUNT(*) c FROM hr_interviews
      WHERE status='scheduled' AND DATE(scheduled_at) >= DATE('now','localtime')
    `).get().c;
    // Average time-to-hire — created_at (candidate) → joined activity (best effort)
    const ttHire = db.prepare(`
      SELECT AVG(JULIANDAY(c.updated_at) - JULIANDAY(c.created_at)) days
      FROM hr_candidates c WHERE c.status='joined'
    `).get().days;

    res.json({
      open_positions: openPositions,
      pipeline_by_status: pipelineByStatus,
      offers: offerStats,
      pending_interviews: pendingInterviews,
      avg_time_to_hire_days: ttHire ? Math.round(ttHire) : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
