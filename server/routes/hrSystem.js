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
const pg = require('../db/pg');
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

// ── Schema ──────────────────────────────────────────────────────
// The hr_* tables (hr_hiring_requests / hr_jds / hr_candidates /
// hr_candidate_activity / hr_interviews / hr_interview_feedback /
// hr_offers / hr_onboarding_tasks / hr_training_videos /
// hr_training_completion) live in the migrated Postgres schema — the
// old idempotent SQLite bootstrap was removed in the better-sqlite3 →
// pg conversion.

// ── Helpers ─────────────────────────────────────────────────────
async function nextNo(db, table, col, prefix, pad = 4) {
  const last = await db.get(`SELECT ${col} FROM ${table} WHERE ${col} LIKE ? ORDER BY id DESC LIMIT 1`, `${prefix}%`);
  let n = 1;
  if (last?.[col]) {
    const m = new RegExp(`${prefix}(\\d+)`).exec(last[col]);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `${prefix}${String(n).padStart(pad, '0')}`;
}

async function recordActivity(db, candidate_id, type, from_status, to_status, note, user) {
  try {
    await db.run(`
      INSERT INTO hr_candidate_activity (candidate_id, activity_type, from_status, to_status, note, by_user_id, by_user_name)
      VALUES (?,?,?,?,?,?,?)
    `, candidate_id, type, from_status || null, to_status || null, note || null, user?.id || null, user?.name || null);
  } catch (e) {
    console.warn('[hr_system] activity log skipped:', e.message);
  }
}

// ════════════════════════════════════════════════════════════════
// HIRING REQUESTS
// ════════════════════════════════════════════════════════════════
router.get('/hiring-requests', requirePermission('hr_system', 'view'), async (req, res) => {
  try {
    const rows = await pg.all(`
      SELECT hr.*, u.name AS raised_by_name, au.name AS approved_by_name,
             (SELECT COUNT(*) FROM hr_candidates c WHERE c.hiring_request_id = hr.id) AS candidate_count
      FROM hr_hiring_requests hr
      LEFT JOIN users u ON u.id = hr.raised_by
      LEFT JOIN users au ON au.id = hr.approved_by
      ORDER BY hr.created_at DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/hiring-requests', requirePermission('hr_system', 'create'), async (req, res) => {
  const b = req.body || {};
  if (!b.position_title) return res.status(400).json({ error: 'Position title required' });
  try {
    const request_no = await nextNo(pg, 'hr_hiring_requests', 'request_no', 'HR-', 4);
    const r = await pg.run(`
      INSERT INTO hr_hiring_requests (request_no, department, position_title, openings, salary_min, salary_max,
        experience_required, employment_type, hiring_deadline, reporting_manager, raised_by, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `, request_no, b.department || null, b.position_title, +b.openings || 1,
      +b.salary_min || null, +b.salary_max || null, b.experience_required || null,
      b.employment_type || null, b.hiring_deadline || null, b.reporting_manager || null,
      req.user.id, b.notes || null);
    logAuditEvent({ user: req.user, action: 'CREATE', entity_type: 'hr_hiring_request',
      entity_id: r.lastInsertRowid, entity_label: request_no });
    res.json({ id: r.lastInsertRowid, request_no });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/hiring-requests/:id', requirePermission('hr_system', 'edit'), async (req, res) => {
  const b = req.body || {};
  try {
    const existing = await pg.get('SELECT * FROM hr_hiring_requests WHERE id=?', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await pg.run(`
      UPDATE hr_hiring_requests SET
        department=COALESCE(?,department), position_title=COALESCE(?,position_title),
        openings=COALESCE(?,openings), salary_min=?, salary_max=?,
        experience_required=COALESCE(?,experience_required), employment_type=COALESCE(?,employment_type),
        hiring_deadline=?, reporting_manager=COALESCE(?,reporting_manager), notes=COALESCE(?,notes),
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `, b.department, b.position_title, b.openings != null ? +b.openings : null,
      b.salary_min != null ? +b.salary_min : existing.salary_min,
      b.salary_max != null ? +b.salary_max : existing.salary_max,
      b.experience_required, b.employment_type,
      b.hiring_deadline !== undefined ? b.hiring_deadline : existing.hiring_deadline,
      b.reporting_manager, b.notes, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/hiring-requests/:id/approve', requirePermission('hr_system', 'approve'), async (req, res) => {
  try {
    // Separation of duties — same rule as Indents: creator can't approve their own request
    const cur = await pg.get('SELECT raised_by FROM hr_hiring_requests WHERE id=?', req.params.id);
    if (cur && cur.raised_by === req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You cannot approve a hiring request you raised yourself. Ask another approver.' });
    }
    await pg.run(`UPDATE hr_hiring_requests SET status='approved', approved_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/hiring-requests/:id/reject', requirePermission('hr_system', 'approve'), async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Reason required' });
  try {
    await pg.run(`UPDATE hr_hiring_requests SET status='rejected', reject_reason=?, approved_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      reason, req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/hiring-requests/:id', requirePermission('hr_system', 'delete'), async (req, res) => {
  try {
    await pg.run('DELETE FROM hr_hiring_requests WHERE id=?', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
// CANDIDATES (ATS)
// ════════════════════════════════════════════════════════════════
router.get('/candidates', requirePermission('hr_system', 'view'), async (req, res) => {
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
    sql += ' AND (c.full_name ILIKE ? OR c.email ILIKE ? OR c.phone ILIKE ? OR c.candidate_no ILIKE ?)';
    const q = `%${search}%`; params.push(q, q, q, q);
  }
  sql += ' ORDER BY c.created_at DESC';
  try {
    res.json(await pg.all(sql, ...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/candidates/:id', requirePermission('hr_system', 'view'), async (req, res) => {
  try {
    const c = await pg.get(`
      SELECT c.*, hr.position_title AS hr_position, hr.request_no AS hr_request_no
      FROM hr_candidates c LEFT JOIN hr_hiring_requests hr ON hr.id = c.hiring_request_id
      WHERE c.id = ?
    `, req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    c.activity = await pg.all(`
      SELECT * FROM hr_candidate_activity WHERE candidate_id=? ORDER BY created_at DESC
    `, req.params.id);
    c.interviews = await pg.all(`
      SELECT * FROM hr_interviews WHERE candidate_id=? ORDER BY scheduled_at DESC
    `, req.params.id);
    c.offers = await pg.all(`
      SELECT * FROM hr_offers WHERE candidate_id=? ORDER BY created_at DESC
    `, req.params.id);
    res.json(c);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/candidates', requirePermission('hr_system', 'create'), async (req, res) => {
  const b = req.body || {};
  if (!b.full_name) return res.status(400).json({ error: 'Candidate name required' });
  try {
    // Duplicate guard — same email OR same phone = same candidate
    const { findDuplicate, sendDuplicate } = require('../utils/duplicateGuard');
    if (b.email) {
      const dup = await findDuplicate(pg, { table: 'hr_candidates', fields: { email: b.email }, codeColumn: 'candidate_no' });
      if (sendDuplicate(res, dup, `Candidate with email ${b.email}`)) return;
    }
    if (b.phone) {
      const dup = await findDuplicate(pg, { table: 'hr_candidates', fields: { phone: b.phone }, codeColumn: 'candidate_no' });
      if (sendDuplicate(res, dup, `Candidate with phone ${b.phone}`)) return;
    }

    const candidate_no = await nextNo(pg, 'hr_candidates', 'candidate_no', 'CND-', 5);
    const r = await pg.run(`
      INSERT INTO hr_candidates (candidate_no, full_name, email, phone, current_company, current_role,
        current_salary, expected_salary, notice_period, experience_years, location, source,
        hiring_request_id, resume_url, tags, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, candidate_no, b.full_name, b.email || null, b.phone || null, b.current_company || null,
      b.current_role || null, +b.current_salary || null, +b.expected_salary || null,
      b.notice_period || null, +b.experience_years || null, b.location || null,
      b.source || null, b.hiring_request_id || null, b.resume_url || null,
      b.tags || null, b.notes || null, req.user.id);
    await recordActivity(pg, r.lastInsertRowid, 'created', null, 'applied', `Candidate added (source: ${b.source || '—'})`, req.user);
    logAuditEvent({ user: req.user, action: 'CREATE', entity_type: 'hr_candidate',
      entity_id: r.lastInsertRowid, entity_label: candidate_no });
    res.json({ id: r.lastInsertRowid, candidate_no });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/candidates/:id', requirePermission('hr_system', 'edit'), async (req, res) => {
  const b = req.body || {};
  try {
    const existing = await pg.get('SELECT * FROM hr_candidates WHERE id=?', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await pg.run(`
      UPDATE hr_candidates SET
        full_name=COALESCE(?,full_name), email=COALESCE(?,email), phone=COALESCE(?,phone),
        current_company=COALESCE(?,current_company), current_role=COALESCE(?,current_role),
        current_salary=?, expected_salary=?, notice_period=COALESCE(?,notice_period),
        experience_years=?, location=COALESCE(?,location), source=COALESCE(?,source),
        hiring_request_id=?, resume_url=COALESCE(?,resume_url), tags=COALESCE(?,tags),
        notes=COALESCE(?,notes), updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `, b.full_name, b.email, b.phone, b.current_company, b.current_role,
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

router.post('/candidates/:id/status', requirePermission('hr_system', 'edit'), async (req, res) => {
  const { status, note } = req.body || {};
  const allowed = ['applied','screening','interview','final_round','selected','rejected','on_hold','offered','joined'];
  if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });
  try {
    const cur = await pg.get('SELECT status FROM hr_candidates WHERE id=?', req.params.id);
    if (!cur) return res.status(404).json({ error: 'Not found' });
    await pg.run(`UPDATE hr_candidates SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, status, req.params.id);
    await recordActivity(pg, req.params.id, 'status_change', cur.status, status, note || null, req.user);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/candidates/:id/resume', requirePermission('hr_system', 'edit'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `/uploads/hr/${path.basename(req.file.path)}`;
  try {
    await pg.run('UPDATE hr_candidates SET resume_url=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', url, req.params.id);
    await recordActivity(pg, req.params.id, 'resume_uploaded', null, null, `Resume: ${req.file.originalname}`, req.user);
    res.json({ ok: true, resume_url: url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/candidates/:id/note', requirePermission('hr_system', 'edit'), async (req, res) => {
  const note = String(req.body?.note || '').trim();
  if (!note) return res.status(400).json({ error: 'Note text required' });
  try {
    await recordActivity(pg, req.params.id, 'note', null, null, note, req.user);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/candidates/:id', requirePermission('hr_system', 'delete'), async (req, res) => {
  try {
    await pg.run('DELETE FROM hr_candidates WHERE id=?', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
// INTERVIEWS
// ════════════════════════════════════════════════════════════════
router.get('/interviews', requirePermission('hr_system', 'view'), async (req, res) => {
  try {
    const rows = await pg.all(`
      SELECT i.*, c.full_name AS candidate_name, c.candidate_no, c.status AS candidate_status
      FROM hr_interviews i
      JOIN hr_candidates c ON c.id = i.candidate_id
      ORDER BY i.scheduled_at DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/interviews', requirePermission('hr_system', 'create'), async (req, res) => {
  const b = req.body || {};
  if (!b.candidate_id || !b.scheduled_at) return res.status(400).json({ error: 'Candidate + scheduled_at required' });
  try {
    const r = await pg.run(`
      INSERT INTO hr_interviews (candidate_id, round_name, scheduled_at, duration_min, mode,
        location_or_link, interviewer_ids, interviewer_names, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `, b.candidate_id, b.round_name || 'Round', b.scheduled_at, +b.duration_min || 60,
      b.mode || 'Video', b.location_or_link || null,
      b.interviewer_ids || null, b.interviewer_names || null, b.notes || null, req.user.id);
    await recordActivity(pg, b.candidate_id, 'interview_scheduled', null, null,
      `${b.round_name || 'Round'} scheduled for ${b.scheduled_at}`, req.user);
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/interviews/:id/feedback', requirePermission('hr_system', 'edit'), async (req, res) => {
  const b = req.body || {};
  try {
    await pg.run(`
      INSERT INTO hr_interview_feedback (interview_id, interviewer_id, technical_score,
        communication_score, culture_score, problem_solving_score, overall_rating,
        recommendation, feedback_notes)
      VALUES (?,?,?,?,?,?,?,?,?)
    `, req.params.id, req.user.id, +b.technical_score || null, +b.communication_score || null,
      +b.culture_score || null, +b.problem_solving_score || null, +b.overall_rating || null,
      b.recommendation || null, b.feedback_notes || null);
    await pg.run(`UPDATE hr_interviews SET status='completed', outcome=COALESCE(?,outcome) WHERE id=?`,
      b.recommendation || null, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
// OFFERS
// ════════════════════════════════════════════════════════════════
router.get('/offers', requirePermission('hr_system', 'view'), async (req, res) => {
  try {
    res.json(await pg.all(`
      SELECT o.*, c.full_name AS candidate_name, c.candidate_no, c.email AS candidate_email
      FROM hr_offers o JOIN hr_candidates c ON c.id = o.candidate_id
      ORDER BY o.created_at DESC
    `));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/offers', requirePermission('hr_system', 'create'), async (req, res) => {
  const b = req.body || {};
  if (!b.candidate_id) return res.status(400).json({ error: 'candidate_id required' });
  try {
    const accept_token = require('crypto').randomBytes(16).toString('hex');
    const r = await pg.run(`
      INSERT INTO hr_offers (candidate_id, offered_position, offered_salary, joining_date,
        offer_letter_url, accept_token, expiry_date, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)
    `, b.candidate_id, b.offered_position || null, +b.offered_salary || null,
      b.joining_date || null, b.offer_letter_url || null, accept_token,
      b.expiry_date || null, b.notes || null, req.user.id);
    await recordActivity(pg, b.candidate_id, 'offer_created', null, 'offered',
      `Offer drafted (₹${b.offered_salary || '—'})`, req.user);
    res.json({ id: r.lastInsertRowid, accept_token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/offers/:id/send', requirePermission('hr_system', 'edit'), async (req, res) => {
  try {
    await pg.run(`UPDATE hr_offers SET status='sent', sent_at=CURRENT_TIMESTAMP WHERE id=?`, req.params.id);
    const off = await pg.get('SELECT * FROM hr_offers WHERE id=?', req.params.id);
    if (off) await pg.run('UPDATE hr_candidates SET status=? WHERE id=?', 'offered', off.candidate_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public offer-accept endpoint — candidate clicks the wa.me / email link.
router.post('/offers/accept/:token', async (req, res) => {
  const accepted = !!req.body?.accepted;
  try {
    const off = await pg.get('SELECT * FROM hr_offers WHERE accept_token=?', req.params.token);
    if (!off) return res.status(404).json({ error: 'Invalid offer link' });
    if (off.status !== 'sent') return res.status(400).json({ error: 'Offer is not awaiting response' });
    const newStatus = accepted ? 'accepted' : 'declined';
    await pg.run(`UPDATE hr_offers SET status=?, responded_at=CURRENT_TIMESTAMP WHERE id=?`, newStatus, off.id);
    if (accepted) await pg.run('UPDATE hr_candidates SET status=? WHERE id=?', 'joined', off.candidate_id);
    res.json({ ok: true, status: newStatus });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
// DASHBOARD KPIs
// ════════════════════════════════════════════════════════════════
router.get('/dashboard', requirePermission('hr_system', 'view'), async (req, res) => {
  try {
    const openPositions = (await pg.get(`SELECT COUNT(*) c FROM hr_hiring_requests WHERE status IN ('approved','pending')`)).c;
    const pipelineByStatus = await pg.all(`
      SELECT status, COUNT(*) c FROM hr_candidates
      WHERE status NOT IN ('rejected','joined')
      GROUP BY status
    `);
    const offerStats = await pg.get(`
      SELECT
        SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) accepted,
        SUM(CASE WHEN status='declined' THEN 1 ELSE 0 END) declined,
        SUM(CASE WHEN status='sent'     THEN 1 ELSE 0 END) pending,
        COUNT(*) total
      FROM hr_offers
    `);
    // Server-local "today" (SQLite used DATE('now','localtime')).
    const nowD = new Date();
    const localToday = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`;
    const pendingInterviews = (await pg.get(`
      SELECT COUNT(*) c FROM hr_interviews
      WHERE status='scheduled' AND LEFT(scheduled_at,10) >= ?
    `, localToday)).c;
    // Average time-to-hire — created_at (candidate) → joined activity (best effort)
    const ttHire = (await pg.get(`
      SELECT AVG(LEFT(c.updated_at,10)::date - LEFT(c.created_at,10)::date) days
      FROM hr_candidates c WHERE c.status='joined'
    `)).days;

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
