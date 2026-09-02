const express = require('express');
const pg = require('../db/pg');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { fireEmailEvent } = require('../lib/emailRules');
const { getEmailConfig } = require('../lib/email');
// Email-trigger helpers (recipient resolution). Best-effort.
const ceUserEmail = async (db, id) => { try { return (await db.get('SELECT email FROM users WHERE id=?', id))?.email || null; } catch { return null; } };
const ceDirector = () => { try { return require('../lib/email').getDirectorEmail(); } catch { return null; } };
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

// ── OTP-gated resolution flow columns ───────────────────────────
// Mam (2026-05-21): "resolved it by otp" — per-complaint OTP,
// engineer-user-id link, and message-log timestamps.  The columns
// (assigned_engineer_id, resolution_otp, otp_generated_at,
// otp_verified_at, otp_attempts, client_register_msg_sent_at,
// engineer_assign_msg_sent_at, client_assign_msg_sent_at) live in the
// migrated Postgres schema — the old idempotent ALTER guards are gone.

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
router.post('/public', async (req, res) => {
  try {
    const b = req.body;
    if (!b.client_name || !b.mobile_number || !b.problem_detail) return res.status(400).json({ error: 'Name, mobile, problem required' });

    const { nextSequencePg } = require('../db/nextSequence');
    const cn = await nextSequencePg(pg, 'complaints', 'complaint_number', 'CMP-', { startFrom: 1000, pad: 5 });
    const r = await pg.run(
      `INSERT INTO complaints
        (complaint_number, client_name, company_name, mobile_number, category, state,
         problem_detail, customer_type, complaint_type, emp_name, remarks, description, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      cn, b.client_name, b.company_name, b.mobile_number, b.category, b.state || null,
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// All routes below require auth
router.use(authMiddleware);

router.get('/', requirePermission('complaints', 'view'), async (req, res) => {
  try {
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
    if (search) { sql += ' AND (c.client_name ILIKE ? OR c.complaint_number ILIKE ? OR c.company_name ILIKE ? OR c.mobile_number ILIKE ?)'; params.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`); }
    sql += ' ORDER BY c.created_at DESC';
    res.json(await pg.all(sql, ...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/stats', requirePermission('complaints', 'view'), async (req, res) => {
  try {
    const total = await pg.get('SELECT COUNT(*) as c FROM complaints');
    const open = await pg.get("SELECT COUNT(*) as c FROM complaints WHERE status='open'");
    const inProgress = await pg.get("SELECT COUNT(*) as c FROM complaints WHERE status='in_progress'");
    // Mam (2026-05-22 audit fix): UI treats both 'resolved' AND legacy
    // 'closed' as done (Complaints.jsx:161 OR check) but stats only
    // counted 'resolved' → tile undershoot.  Match the UI's union.
    const resolved = await pg.get("SELECT COUNT(*) as c FROM complaints WHERE status IN ('resolved','closed')");
    const byCategory = await pg.all("SELECT category, COUNT(*) as count FROM complaints WHERE category IS NOT NULL GROUP BY category");
    res.json({ total: total.c, open: open.c, inProgress: inProgress.c, resolved: resolved.c, byCategory });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', requirePermission('complaints', 'view'), async (req, res) => {
  try {
    const c = await pg.get(`
      SELECT c.*, eng.name as assigned_engineer_name, eng.phone as assigned_engineer_phone
      FROM complaints c LEFT JOIN users eng ON c.assigned_engineer_id = eng.id
      WHERE c.id=?
    `, req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json(c);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin/CRM create
router.post('/', requirePermission('complaints', 'create'), async (req, res) => {
  try {
    const b = req.body;
    const { nextSequencePg } = require('../db/nextSequence');
    const cn = await nextSequencePg(pg, 'complaints', 'complaint_number', 'CMP-', { startFrom: 1000, pad: 5 });
    const r = await pg.run(
      `INSERT INTO complaints
        (complaint_number, client_name, company_name, mobile_number, category, state,
         problem_detail, customer_type, complaint_type, emp_name, remarks,
         step1_planned_date, step1_assigned_to, description, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      cn, b.client_name, b.company_name, b.mobile_number, b.category, b.state || null,
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
      creator_email: req.user.email || await ceUserEmail(pg, req.user.id),
      director_email: ceDirector(),
    });
    res.status(201).json({ id: r.lastInsertRowid, complaint_number: cn, whatsapp_client_register: wa });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update (Step 1 / Step 2 progression)
router.put('/:id', requirePermission('complaints', 'edit'), async (req, res) => {
  try {
    const b = req.body;

    // Calculate time delays
    const calcDelay = (planned, actual) => {
      if (!planned || !actual) return 0;
      const diff = (new Date(actual) - new Date(planned)) / (1000 * 60 * 60 * 24);
      return Math.round(diff);
    };

    const s1Delay = calcDelay(b.step1_planned_date, b.step1_actual_date);
    const s2Delay = calcDelay(b.step2_planned_date, b.step2_actual_date);

    await pg.run(`UPDATE complaints SET
      client_name=COALESCE(?,client_name), company_name=COALESCE(?,company_name), mobile_number=COALESCE(?,mobile_number),
      category=COALESCE(?,category), problem_detail=COALESCE(?,problem_detail), customer_type=COALESCE(?,customer_type),
      complaint_type=COALESCE(?,complaint_type), emp_name=COALESCE(?,emp_name),
      step1_planned_date=COALESCE(?,step1_planned_date), step1_actual_date=COALESCE(?,step1_actual_date), step1_time_delay=?, step1_assigned_to=COALESCE(?,step1_assigned_to),
      step2_planned_date=COALESCE(?,step2_planned_date), step2_actual_date=COALESCE(?,step2_actual_date), step2_time_delay=?, step2_assigned_to=COALESCE(?,step2_assigned_to),
      service_report=COALESCE(?,service_report), status=COALESCE(?,status), priority=COALESCE(?,priority),
      updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      b.client_name, b.company_name, b.mobile_number, b.category, b.problem_detail, b.customer_type, b.complaint_type, b.emp_name,
      b.step1_planned_date, b.step1_actual_date, s1Delay, b.step1_assigned_to,
      b.step2_planned_date, b.step2_actual_date, s2Delay, b.step2_assigned_to,
      b.service_report, b.status, b.priority, req.params.id
    );
    res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requirePermission('complaints', 'delete'), async (req, res) => {
  try {
    await pg.run('DELETE FROM complaints WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
router.post('/:id/assign', requirePermission('complaints', 'edit'), async (req, res) => {
  try {
    const id = +req.params.id;
    const engId = +req.body.engineer_user_id;
    if (!engId) return res.status(400).json({ error: 'engineer_user_id required' });

    const c = await pg.get('SELECT * FROM complaints WHERE id=?', id);
    if (!c) return res.status(404).json({ error: 'Complaint not found' });
    const eng = await pg.get('SELECT id, name, phone FROM users WHERE id=?', engId);
    if (!eng) return res.status(404).json({ error: 'Engineer not found' });

    const otp = generateOtp();

    await pg.run(`
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
    `, engId, engId, eng.name, otp, id);

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
      engineer_email: await ceUserEmail(pg, engId),
      creator_email: await ceUserEmail(pg, c.created_by),
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /complaints/:id/whatsapp/sent ──────────────────────────
// Frontend pings this after mam clicks a WhatsApp link so we can
// timestamp which messages have been dispatched.  Pure audit-trail.
// Body: { kind: 'register' | 'engineer_assign' | 'client_assign' }
router.post('/:id/whatsapp/sent', requirePermission('complaints', 'edit'), async (req, res) => {
  try {
    const map = {
      register:        'client_register_msg_sent_at',
      engineer_assign: 'engineer_assign_msg_sent_at',
      client_assign:   'client_assign_msg_sent_at',
    };
    const col = map[req.body.kind];
    if (!col) return res.status(400).json({ error: 'invalid kind' });
    await pg.run(`UPDATE complaints SET ${col}=CURRENT_TIMESTAMP WHERE id=?`, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /complaints/:id/verify-otp ─────────────────────────────
// Site engineer enters the OTP the client read off WhatsApp.  Match →
// complaint marked resolved, OTP wiped, verification timestamped.
// Mismatch → attempts++ and return remaining attempts so the UI can
// shame the engineer into asking the client again.
router.post('/:id/verify-otp', requirePermission('complaints', 'edit'), async (req, res) => {
  try {
    const id = +req.params.id;
    const given = String(req.body.otp || '').trim();
    if (!/^\d{4}$/.test(given)) return res.status(400).json({ error: 'OTP must be 4 digits' });

    const c = await pg.get('SELECT id, resolution_otp, otp_attempts, status FROM complaints WHERE id=?', id);
    if (!c) return res.status(404).json({ error: 'Complaint not found' });
    if (!c.resolution_otp) return res.status(400).json({ error: 'No active OTP — assign an engineer first' });
    if (c.status === 'resolved' || c.status === 'closed') return res.status(409).json({ error: 'Already resolved' });
    if ((c.otp_attempts || 0) >= 5) return res.status(429).json({ error: 'Too many attempts — ask admin to re-generate the OTP' });

    if (given !== String(c.resolution_otp).trim()) {
      await pg.run('UPDATE complaints SET otp_attempts = COALESCE(otp_attempts,0) + 1 WHERE id=?', id);
      const remaining = 5 - ((c.otp_attempts || 0) + 1);
      return res.status(400).json({ error: `Wrong OTP. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`, remaining });
    }

    const today = new Date().toISOString().slice(0, 10);   // UTC, parity with SQLite DATE('now')
    await pg.run(`
      UPDATE complaints
         SET status            = 'resolved',
             resolved_date     = ?,
             step2_actual_date = COALESCE(step2_actual_date, ?),
             otp_verified_at   = CURRENT_TIMESTAMP,
             resolution_otp    = NULL,
             updated_at        = CURRENT_TIMESTAMP
       WHERE id = ?
    `, today, today, id);

    const full = await pg.get('SELECT complaint_number, client_name, assigned_engineer_id, created_by FROM complaints WHERE id=?', id);
    fireEmailEvent('complaint.resolved', {
      complaint_no: full?.complaint_number || '',
      client: full?.client_name || '',
      engineer: (await pg.get('SELECT name FROM users WHERE id=?', full?.assigned_engineer_id))?.name || '',
      date: new Date().toISOString().slice(0, 10),
      creator_email: await ceUserEmail(pg, full?.created_by),
      engineer_email: await ceUserEmail(pg, full?.assigned_engineer_id),
      director_email: ceDirector(),
    });
    res.json({ ok: true, status: 'resolved' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /complaints/:id/resend-otp ─────────────────────────────
// If the client lost the original WhatsApp / mam re-sent the wrong
// number, generate a fresh OTP and return the new client-side
// WhatsApp link.  Resets the attempts counter.
router.post('/:id/resend-otp', requirePermission('complaints', 'edit'), async (req, res) => {
  try {
    const id = +req.params.id;
    const c = await pg.get(`
      SELECT c.*, eng.name as eng_name, eng.phone as eng_phone
        FROM complaints c LEFT JOIN users eng ON c.assigned_engineer_id = eng.id
       WHERE c.id = ?
    `, id);
    if (!c) return res.status(404).json({ error: 'Complaint not found' });
    if (!c.assigned_engineer_id) return res.status(400).json({ error: 'Assign an engineer first' });
    if (c.status === 'resolved') return res.status(409).json({ error: 'Already resolved' });

    const otp = generateOtp();
    await pg.run(`
      UPDATE complaints
         SET resolution_otp    = ?,
             otp_generated_at  = CURRENT_TIMESTAMP,
             otp_verified_at   = NULL,
             otp_attempts      = 0,
             updated_at        = CURRENT_TIMESTAMP
       WHERE id = ?
    `, otp, id);

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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
