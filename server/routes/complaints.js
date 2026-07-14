const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { fireEmailEvent } = require('../lib/emailRules');
const { getEmailConfig } = require('../lib/email');
// Email-trigger helpers (recipient resolution). Best-effort.
const ceUserEmail = (db, id) => { try { return db.prepare('SELECT email FROM users WHERE id=?').get(id)?.email || null; } catch { return null; } };
const ceDirector = () => { try { return getEmailConfig().director; } catch { return null; } };
const {
  whatsappLink,
  generateOtp,
  complaintRegisterMsg,
  complaintAssignedToEngineerMsg,
  complaintAssignedToClientMsg,
} = require('../utils/whatsapp');
// Twilio-backed WhatsApp + SMS sender.  Sends a confirmation to the
// customer immediately after their complaint is saved.  Wrapped in
// fire-and-forget at call sites so a Twilio outage never blocks the
// complaint INSERT (see callers below).
const { sendComplaintRegistered } = require('../services/notify');
const router = express.Router();

// ── Idempotent migrations for the OTP-gated resolution flow ─────
// Mam (2026-05-21): "resolved it by otp" — added per-complaint OTP,
// engineer-user-id link, and message-log timestamps.  These ALTERs
// are wrapped in try/catch so re-runs are no-ops.
(function migrateComplaintsForOtp() {
  try {
    const db = getDb();
    const newCols = [
      'assigned_engineer_id INTEGER REFERENCES users(id)',
      'resolution_otp TEXT',
      'otp_generated_at DATETIME',
      'otp_verified_at DATETIME',
      'otp_attempts INTEGER DEFAULT 0',
      'client_register_msg_sent_at DATETIME',
      'engineer_assign_msg_sent_at DATETIME',
      'client_assign_msg_sent_at DATETIME',
    ];
    newCols.forEach(col => {
      try { db.exec(`ALTER TABLE complaints ADD COLUMN ${col}`); } catch (_) { /* exists */ }
    });
  } catch (e) {
    console.warn('[complaints] OTP migration skipped:', e.message);
  }
})();

// Build the WhatsApp ack package returned to the frontend after
// registration so the form / admin list can render a one-click
// "Send WhatsApp" button.
function buildClientRegisterAck(complaint) {
  if (!complaint.mobile_number) return null;
  const msg = complaintRegisterMsg(complaint);
  const link = whatsappLink(complaint.mobile_number, msg);
  return link ? { phone: complaint.mobile_number, message: msg, link } : null;
}

// Public endpoint for client complaint registration (no auth)
router.post('/public', (req, res) => {
  const b = req.body;
  if (!b.client_name || !b.mobile_number || !b.problem_detail) return res.status(400).json({ error: 'Name, mobile, problem required' });
  const db = getDb();

  // Safe migrations (legacy — kept for older deploys)
  const newCols = ['client_name TEXT','company_name TEXT','mobile_number TEXT','category TEXT','problem_detail TEXT','customer_type TEXT','complaint_type TEXT','emp_name TEXT','step1_planned_date DATE','step1_actual_date DATE','step1_time_delay INTEGER','step1_assigned_to TEXT','step2_planned_date DATE','step2_actual_date DATE','step2_time_delay INTEGER','step2_assigned_to TEXT','service_report TEXT','updated_at DATETIME'];
  newCols.forEach(col => { try { db.exec(`ALTER TABLE complaints ADD COLUMN ${col}`); } catch(e){} });

  const { nextSequence } = require('../db/nextSequence');
  const cn = nextSequence(db, 'complaints', 'complaint_number', 'CMP-', { startFrom: 1000, pad: 5 });
  const r = db.prepare(
    `INSERT INTO complaints
      (complaint_number, client_name, company_name, mobile_number, category, state,
       problem_detail, customer_type, complaint_type, emp_name, remarks, description, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(cn, b.client_name, b.company_name, b.mobile_number, b.category, b.state || null,
    b.problem_detail, b.customer_type, b.complaint_type, b.emp_name, b.remarks || null,
    b.problem_detail, 'open');

  // Fire-and-forget: send Twilio WhatsApp + SMS confirmation.  Wrapped
  // in try/catch + .catch so any failure stays out of the response path.
  // sendComplaintRegistered itself never throws but we belt-and-brace
  // here because this endpoint is PUBLIC and must always complete.
  try {
    sendComplaintRegistered({
      complaintNo: cn,
      clientName: b.client_name,
      mobile: b.mobile_number,
    }).catch(err => console.error('[complaints/public] notify failed:', err.message || err));
  } catch (err) {
    console.error('[complaints/public] notify dispatch failed:', err.message || err);
  }

  res.status(201).json({ id: r.lastInsertRowid, complaint_number: cn, message: 'Complaint registered. Our team will contact you soon.' });
});

// All routes below require auth
router.use(authMiddleware);

router.get('/', requirePermission('complaints', 'view'), (req, res) => {
  const { status, search, category } = req.query;
  let sql = `SELECT c.*, u.name as assigned_to_name,
                    eng.name as assigned_engineer_name, eng.phone as assigned_engineer_phone
               FROM complaints c
               LEFT JOIN users u   ON c.assigned_to = u.id
               LEFT JOIN users eng ON c.assigned_engineer_id = eng.id
              WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND c.status=?'; params.push(status); }
  if (category) { sql += ' AND c.category=?'; params.push(category); }
  if (search) { sql += ' AND (c.client_name LIKE ? OR c.complaint_number LIKE ? OR c.company_name LIKE ? OR c.mobile_number LIKE ?)'; params.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`); }
  sql += ' ORDER BY c.created_at DESC';
  res.json(getDb().prepare(sql).all(...params));
});

router.get('/stats', requirePermission('complaints', 'view'), (req, res) => {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as c FROM complaints').get();
  const open = db.prepare("SELECT COUNT(*) as c FROM complaints WHERE status='open'").get();
  const inProgress = db.prepare("SELECT COUNT(*) as c FROM complaints WHERE status='in_progress'").get();
  // Mam (2026-05-22 audit fix): UI treats both 'resolved' AND legacy
  // 'closed' as done (Complaints.jsx:161 OR check) but stats only
  // counted 'resolved' → tile undershoot.  Match the UI's union.
  const resolved = db.prepare("SELECT COUNT(*) as c FROM complaints WHERE status IN ('resolved','closed')").get();
  const byCategory = db.prepare("SELECT category, COUNT(*) as count FROM complaints WHERE category IS NOT NULL GROUP BY category").all();
  res.json({ total: total.c, open: open.c, inProgress: inProgress.c, resolved: resolved.c, byCategory });
});

router.get('/:id', requirePermission('complaints', 'view'), (req, res) => {
  const c = getDb().prepare(`
    SELECT c.*, eng.name as assigned_engineer_name, eng.phone as assigned_engineer_phone
    FROM complaints c LEFT JOIN users eng ON c.assigned_engineer_id = eng.id
    WHERE c.id=?
  `).get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});

// Admin/CRM create
router.post('/', requirePermission('complaints', 'create'), (req, res) => {
  const b = req.body;
  const db = getDb();
  const { nextSequence } = require('../db/nextSequence');
  const cn = nextSequence(db, 'complaints', 'complaint_number', 'CMP-', { startFrom: 1000, pad: 5 });
  const r = db.prepare(
    `INSERT INTO complaints
      (complaint_number, client_name, company_name, mobile_number, category, state,
       problem_detail, customer_type, complaint_type, emp_name, remarks,
       step1_planned_date, step1_assigned_to, description, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(cn, b.client_name, b.company_name, b.mobile_number, b.category, b.state || null,
    b.problem_detail, b.customer_type, b.complaint_type, b.emp_name, b.remarks || null,
    b.step1_planned_date, b.step1_assigned_to, b.problem_detail, 'open', req.user.id);

  // Build the click-to-send WhatsApp wa.me link for the OLD flow
  // (frontend surfaces a "Send Registration Message" button).  This
  // is kept as a safety net even though Twilio now sends automatically.
  // Mam (2026-05-21): "when complaint register send mesage to client
  // that complaint is register".
  const created = { complaint_number: cn, client_name: b.client_name, company_name: b.company_name, mobile_number: b.mobile_number };
  const wa = buildClientRegisterAck(created);

  // AUTO-SEND via Twilio (mam 2026-05-25): fire WhatsApp + SMS
  // confirmation the moment the complaint saves.  Fire-and-forget so
  // any Twilio outage doesn't block the response.  sendComplaintRegistered
  // returns a never-rejecting promise; the .catch is a belt-and-brace.
  try {
    sendComplaintRegistered({
      complaintNo: cn,
      clientName: b.client_name,
      mobile: b.mobile_number,
    }).catch(err => console.error('[complaints] notify failed:', err.message || err));
  } catch (err) {
    console.error('[complaints] notify dispatch failed:', err.message || err);
  }

  fireEmailEvent('complaint.created', {
    complaint_no: cn,
    client: b.client_name || '',
    category: b.category || '',
    problem: b.problem_detail || '',
    created_by: req.user.name || '',
    date: new Date().toISOString().slice(0, 10),
    creator_email: req.user.email || ceUserEmail(db, req.user.id),
    director_email: ceDirector(),
  });
  res.status(201).json({ id: r.lastInsertRowid, complaint_number: cn, whatsapp_client_register: wa });
});

// Update (Step 1 / Step 2 progression)
router.put('/:id', requirePermission('complaints', 'edit'), (req, res) => {
  const b = req.body;
  const db = getDb();

  // Calculate time delays
  const calcDelay = (planned, actual) => {
    if (!planned || !actual) return 0;
    const diff = (new Date(actual) - new Date(planned)) / (1000 * 60 * 60 * 24);
    return Math.round(diff);
  };

  const s1Delay = calcDelay(b.step1_planned_date, b.step1_actual_date);
  const s2Delay = calcDelay(b.step2_planned_date, b.step2_actual_date);

  db.prepare(`UPDATE complaints SET
    client_name=COALESCE(?,client_name), company_name=COALESCE(?,company_name), mobile_number=COALESCE(?,mobile_number),
    category=COALESCE(?,category), problem_detail=COALESCE(?,problem_detail), customer_type=COALESCE(?,customer_type),
    complaint_type=COALESCE(?,complaint_type), emp_name=COALESCE(?,emp_name),
    step1_planned_date=COALESCE(?,step1_planned_date), step1_actual_date=COALESCE(?,step1_actual_date), step1_time_delay=?, step1_assigned_to=COALESCE(?,step1_assigned_to),
    step2_planned_date=COALESCE(?,step2_planned_date), step2_actual_date=COALESCE(?,step2_actual_date), step2_time_delay=?, step2_assigned_to=COALESCE(?,step2_assigned_to),
    service_report=COALESCE(?,service_report), status=COALESCE(?,status), priority=COALESCE(?,priority),
    updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
    b.client_name, b.company_name, b.mobile_number, b.category, b.problem_detail, b.customer_type, b.complaint_type, b.emp_name,
    b.step1_planned_date, b.step1_actual_date, s1Delay, b.step1_assigned_to,
    b.step2_planned_date, b.step2_actual_date, s2Delay, b.step2_assigned_to,
    b.service_report, b.status, b.priority, req.params.id
  );
  res.json({ message: 'Updated' });
});

router.delete('/:id', requirePermission('complaints', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM complaints WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ── POST /complaints/:id/assign ─────────────────────────────────
// Mam (2026-05-21): "when assign whatsapp message also send with our
// team and number who assigned the complaint and send with client to
// whatsapp number which only client show".
//
// Body: { engineer_user_id }
// Effect: locks the engineer, generates a fresh 4-digit OTP, and
// returns two ready-to-send WhatsApp links (one to the engineer,
// one to the client carrying the OTP).  The OTP itself is NEVER sent
// to the engineer — only to the client.
router.post('/:id/assign', requirePermission('complaints', 'edit'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const engId = +req.body.engineer_user_id;
  if (!engId) return res.status(400).json({ error: 'engineer_user_id required' });

  const c = db.prepare('SELECT * FROM complaints WHERE id=?').get(id);
  if (!c) return res.status(404).json({ error: 'Complaint not found' });
  const eng = db.prepare('SELECT id, name, phone FROM users WHERE id=?').get(engId);
  if (!eng) return res.status(404).json({ error: 'Engineer not found' });

  const otp = generateOtp();

  db.prepare(`
    UPDATE complaints
       SET assigned_engineer_id = ?,
           assigned_to          = ?,
           step1_assigned_to    = COALESCE(step1_assigned_to, ?),
           resolution_otp       = ?,
           otp_generated_at     = CURRENT_TIMESTAMP,
           otp_verified_at      = NULL,
           otp_attempts         = 0,
           status               = CASE WHEN status='open' THEN 'in_progress' ELSE status END,
           updated_at           = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(engId, engId, eng.name, otp, id);

  const engineer_msg = complaintAssignedToEngineerMsg({
    engineer_name: eng.name,
    complaint_number: c.complaint_number,
    client_name: c.client_name,
    company_name: c.company_name,
    mobile_number: c.mobile_number,
    category: c.category,
    problem_detail: c.problem_detail || c.description,
  });
  const client_msg = complaintAssignedToClientMsg({
    client_name: c.client_name,
    complaint_number: c.complaint_number,
    engineer_name: eng.name,
    engineer_phone: eng.phone,
    otp,
  });

  fireEmailEvent('complaint.assigned', {
    complaint_no: c.complaint_number,
    client: c.client_name || '',
    engineer: eng.name || '',
    date: new Date().toISOString().slice(0, 10),
    engineer_email: ceUserEmail(db, engId),
    creator_email: ceUserEmail(db, c.created_by),
    director_email: ceDirector(),
  });
  res.json({
    ok: true,
    otp,                                        // returned ONLY to admin caller for verification UI
    engineer: {
      name: eng.name, phone: eng.phone,
      whatsapp: eng.phone ? { phone: eng.phone, message: engineer_msg, link: whatsappLink(eng.phone, engineer_msg) } : null,
    },
    client: {
      name: c.client_name, phone: c.mobile_number,
      whatsapp: c.mobile_number ? { phone: c.mobile_number, message: client_msg, link: whatsappLink(c.mobile_number, client_msg) } : null,
    },
  });
});

// ── POST /complaints/:id/whatsapp/sent ──────────────────────────
// Frontend pings this after mam clicks a WhatsApp link so we can
// timestamp which messages have been dispatched.  Pure audit-trail.
// Body: { kind: 'register' | 'engineer_assign' | 'client_assign' }
router.post('/:id/whatsapp/sent', requirePermission('complaints', 'edit'), (req, res) => {
  const map = {
    register:        'client_register_msg_sent_at',
    engineer_assign: 'engineer_assign_msg_sent_at',
    client_assign:   'client_assign_msg_sent_at',
  };
  const col = map[req.body.kind];
  if (!col) return res.status(400).json({ error: 'invalid kind' });
  getDb().prepare(`UPDATE complaints SET ${col}=CURRENT_TIMESTAMP WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ── POST /complaints/:id/verify-otp ─────────────────────────────
// Site engineer enters the OTP the client read off WhatsApp.  Match →
// complaint marked resolved, OTP wiped, verification timestamped.
// Mismatch → attempts++ and return remaining attempts so the UI can
// shame the engineer into asking the client again.
router.post('/:id/verify-otp', requirePermission('complaints', 'edit'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const given = String(req.body.otp || '').trim();
  if (!/^\d{4}$/.test(given)) return res.status(400).json({ error: 'OTP must be 4 digits' });

  const c = db.prepare('SELECT id, resolution_otp, otp_attempts, status FROM complaints WHERE id=?').get(id);
  if (!c) return res.status(404).json({ error: 'Complaint not found' });
  if (!c.resolution_otp) return res.status(400).json({ error: 'No active OTP — assign an engineer first' });
  if (c.status === 'resolved' || c.status === 'closed') return res.status(409).json({ error: 'Already resolved' });
  if ((c.otp_attempts || 0) >= 5) return res.status(429).json({ error: 'Too many attempts — ask admin to re-generate the OTP' });

  if (given !== String(c.resolution_otp).trim()) {
    db.prepare('UPDATE complaints SET otp_attempts = COALESCE(otp_attempts,0) + 1 WHERE id=?').run(id);
    const remaining = 5 - ((c.otp_attempts || 0) + 1);
    return res.status(400).json({ error: `Wrong OTP. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`, remaining });
  }

  db.prepare(`
    UPDATE complaints
       SET status            = 'resolved',
           resolved_date     = DATE('now'),
           step2_actual_date = COALESCE(step2_actual_date, DATE('now')),
           otp_verified_at   = CURRENT_TIMESTAMP,
           resolution_otp    = NULL,
           updated_at        = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(id);

  const full = db.prepare('SELECT complaint_number, client_name, assigned_engineer_id, created_by FROM complaints WHERE id=?').get(id);
  fireEmailEvent('complaint.resolved', {
    complaint_no: full?.complaint_number || '',
    client: full?.client_name || '',
    engineer: db.prepare('SELECT name FROM users WHERE id=?').get(full?.assigned_engineer_id)?.name || '',
    date: new Date().toISOString().slice(0, 10),
    creator_email: ceUserEmail(db, full?.created_by),
    engineer_email: ceUserEmail(db, full?.assigned_engineer_id),
    director_email: ceDirector(),
  });
  res.json({ ok: true, status: 'resolved' });
});

// ── POST /complaints/:id/resend-otp ─────────────────────────────
// If the client lost the original WhatsApp / mam re-sent the wrong
// number, generate a fresh OTP and return the new client-side
// WhatsApp link.  Resets the attempts counter.
router.post('/:id/resend-otp', requirePermission('complaints', 'edit'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const c = db.prepare(`
    SELECT c.*, eng.name as eng_name, eng.phone as eng_phone
      FROM complaints c LEFT JOIN users eng ON c.assigned_engineer_id = eng.id
     WHERE c.id = ?
  `).get(id);
  if (!c) return res.status(404).json({ error: 'Complaint not found' });
  if (!c.assigned_engineer_id) return res.status(400).json({ error: 'Assign an engineer first' });
  if (c.status === 'resolved') return res.status(409).json({ error: 'Already resolved' });

  const otp = generateOtp();
  db.prepare(`
    UPDATE complaints
       SET resolution_otp    = ?,
           otp_generated_at  = CURRENT_TIMESTAMP,
           otp_verified_at   = NULL,
           otp_attempts      = 0,
           updated_at        = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(otp, id);

  const client_msg = complaintAssignedToClientMsg({
    client_name: c.client_name,
    complaint_number: c.complaint_number,
    engineer_name: c.eng_name,
    engineer_phone: c.eng_phone,
    otp,
  });
  res.json({
    ok: true,
    otp,
    client: c.mobile_number ? { phone: c.mobile_number, message: client_msg, link: whatsappLink(c.mobile_number, client_msg) } : null,
  });
});

module.exports = router;
