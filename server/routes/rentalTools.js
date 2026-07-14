// Rental Tools — REST routes.
//
// Mam (2026-05-16) spec recap:
//   Enquiry → Rate Finalised → Material Received → Returned
//   Stage 1 (rate): Ajmer only.  Target = enquiry + 5 BUSINESS hours.
//                   On completion: auto-create a draft PO.
//   Stage 2 (material): Site engineer uploads live photo + GPS.
//                       Alert if no movement 1 day past date of req.
//   Stage 3 (return):  Ajmer signs.  Target = material_received +
//                      days_required (business days, Sunday-skipped).
//
// Ajmer is identified by app_settings.rental_approver_user_id —
// admin sets it once from the Rental Tools page (top-right gear).
// If unset, any user with rental_tools.can_approve permission can
// perform Stage 1 / Stage 3 actions.

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { logAuditEvent } = require('../middleware/audit');
const { addBusinessHours, addBusinessDays } = require('../lib/businessHours');

const router = express.Router();
router.use(authMiddleware);

// Photo upload for Stage 2 — mam picked "Live camera + GPS lat/lng"
const photoDir = path.join(__dirname, '..', '..', 'data', 'uploads', 'rental-tools');
if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: photoDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '.jpg');
      cb(null, `rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },  // 10 MB
});

// ── Helpers ────────────────────────────────────────────────────
function nextEnquiryNo(db) {
  const yr = new Date().getFullYear();
  const last = db.prepare(`SELECT enquiry_no FROM rental_tool_enquiry WHERE enquiry_no LIKE ? ORDER BY id DESC LIMIT 1`).get(`RT-${yr}-%`);
  let n = 1;
  if (last?.enquiry_no) {
    const m = /RT-\d{4}-(\d+)/.exec(last.enquiry_no);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `RT-${yr}-${String(n).padStart(4, '0')}`;
}

function getApproverId(db) {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key='rental_approver_user_id'`).get();
  return row?.value ? parseInt(row.value, 10) : null;
}

// Stage labels — admin-editable (mam, 2026-05-16: "i need in setting
// all stages name and show only admin").  Stored as a single JSON
// blob in app_settings; falls back to the hard-coded English
// defaults if unset.  Keys must match the DB enum exactly:
// enquiry / rate_finalised / material_received / returned / cancelled.
const DEFAULT_STAGE_LABELS = {
  enquiry:            'Stage 1 — Enquiry Raised',
  rate_finalised:     'Stage 2 — Rate Finalised',
  material_received:  'Stage 3 — Material at Site',
  returned:           'Stage 4 — Returned · Closed',
  cancelled:          'Cancelled',
};
function getStageLabels(db) {
  try {
    const row = db.prepare(`SELECT value FROM app_settings WHERE key='rental_tools_stage_labels'`).get();
    if (!row?.value) return DEFAULT_STAGE_LABELS;
    const saved = JSON.parse(row.value);
    return { ...DEFAULT_STAGE_LABELS, ...saved };  // override only what's set
  } catch (_) {
    return DEFAULT_STAGE_LABELS;
  }
}

// Gate Stage 1 + Stage 3 to Ajmer (if configured) or to anyone with
// can_approve on the module.
function canApprove(db, userId) {
  const approverId = getApproverId(db);
  if (approverId) return userId === approverId;
  // Fallback: any user whose role has can_approve = 1 on rental_tools
  const r = db.prepare(`
    SELECT MAX(rp.can_approve) ok FROM user_roles ur
    JOIN role_permissions rp ON rp.role_id = ur.role_id
    WHERE ur.user_id = ? AND rp.module = 'rental_tools'
  `).get(userId);
  return r?.ok === 1;
}

// ── GET /api/rental-tools/dashboard ────────────────────────────
router.get('/dashboard', requirePermission('rental_tools', 'view'), (req, res) => {
  const db = getDb();
  // Per-stage counts.  enquiry / rate_finalised / material_received
  // are reported for OPEN status only (so cancelled enquiries don't
  // inflate the in-flight numbers).  'returned' counts all returned
  // (status=closed) for the running historical total.  Cancelled is
  // its own bucket so the Lost-style chip can show it.
  const counts = {
    enquiry:           db.prepare(`SELECT COUNT(*) c FROM rental_tool_enquiry WHERE current_stage='enquiry' AND status='open'`).get().c,
    rate_finalised:    db.prepare(`SELECT COUNT(*) c FROM rental_tool_enquiry WHERE current_stage='rate_finalised' AND status='open'`).get().c,
    material_received: db.prepare(`SELECT COUNT(*) c FROM rental_tool_enquiry WHERE current_stage='material_received' AND status='open'`).get().c,
    returned:          db.prepare(`SELECT COUNT(*) c FROM rental_tool_enquiry WHERE current_stage='returned'`).get().c,
    cancelled:         db.prepare(`SELECT COUNT(*) c FROM rental_tool_enquiry WHERE status='cancelled'`).get().c,
    all:               db.prepare(`SELECT COUNT(*) c FROM rental_tool_enquiry`).get().c,
  };
  const now = new Date().toISOString();
  const breaches = {
    stage1_overdue: db.prepare(`SELECT COUNT(*) c FROM rental_tool_enquiry WHERE current_stage='enquiry' AND stage1_target_at < ?`).get(now).c,
    stage2_overdue: db.prepare(`SELECT COUNT(*) c FROM rental_tool_enquiry WHERE current_stage='rate_finalised' AND stage2_target_at < ?`).get(now).c,
    stage3_overdue: db.prepare(`SELECT COUNT(*) c FROM rental_tool_enquiry WHERE current_stage='material_received' AND DATE(return_target_date) < DATE('now')`).get().c,
  };
  const open_total = counts.enquiry + counts.rate_finalised + counts.material_received;
  const total_value = db.prepare(`SELECT COALESCE(SUM(vendor_rate * days_required),0) v FROM rental_tool_enquiry WHERE status='open' AND vendor_rate IS NOT NULL`).get().v;
  // This-month enquiry count
  const thisMonth = db.prepare(`SELECT COUNT(*) c FROM rental_tool_enquiry WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`).get().c;
  res.json({
    counts, breaches, open_total, total_value, this_month: thisMonth,
    approver_user_id: getApproverId(db),
    stage_labels: getStageLabels(db),
  });
});

// ── GET / PUT /api/rental-tools/settings/stage-labels ──────────
router.get('/settings/stage-labels', requirePermission('rental_tools', 'view'), (req, res) => {
  res.json({
    defaults: DEFAULT_STAGE_LABELS,
    current: getStageLabels(getDb()),
  });
});

router.put('/settings/stage-labels', requirePermission('rental_tools', 'edit'), (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const db = getDb();
  const body = req.body || {};
  // Whitelist keys so a malicious payload can't poison the JSON
  const cleaned = {};
  Object.keys(DEFAULT_STAGE_LABELS).forEach(k => {
    if (typeof body[k] === 'string' && body[k].trim()) {
      cleaned[k] = body[k].trim().slice(0, 80);  // 80 char cap
    }
  });
  db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`)
    .run('rental_tools_stage_labels', JSON.stringify(cleaned));
  logAuditEvent({
    user: req.user, action: 'UPDATE', entity_type: 'app_settings',
    entity_label: 'rental_tools_stage_labels',
    method: 'PUT', path: '/api/rental-tools/settings/stage-labels',
    body: cleaned,
  });
  res.json({ current: getStageLabels(db) });
});

// ── GET /api/rental-tools/enquiries ────────────────────────────
router.get('/enquiries', requirePermission('rental_tools', 'view'), (req, res) => {
  const db = getDb();
  const { stage, status, q } = req.query;
  let sql = `
    SELECT e.*, u.name as created_by_name,
           ap.name as rate_finalised_by_name,
           rb.name as return_signed_by_name
    FROM rental_tool_enquiry e
    LEFT JOIN users u  ON e.created_by = u.id
    LEFT JOIN users ap ON e.rate_finalised_by = ap.id
    LEFT JOIN users rb ON e.return_signed_by = rb.id
    WHERE 1=1
  `;
  const params = [];
  // Special chip "cancelled" filters by status; everything else
  // filters by current_stage.  Open-status enquiries default into
  // their stage chip, cancelled ones live in the Cancelled chip.
  if (stage === 'cancelled') {
    sql += " AND e.status = 'cancelled'";
  } else if (stage) {
    sql += ' AND e.current_stage = ? AND e.status != ?';
    params.push(stage, 'cancelled');
  }
  if (status) { sql += ' AND e.status = ?'; params.push(status); }
  if (q) {
    sql += ' AND (e.site_name LIKE ? OR e.enquiry_no LIKE ? OR e.tool_description LIKE ? OR e.vendor_name LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  sql += ' ORDER BY e.id DESC LIMIT 500';
  res.json(db.prepare(sql).all(...params));
});

// ── GET /api/rental-tools/enquiries/:id ────────────────────────
router.get('/enquiries/:id', requirePermission('rental_tools', 'view'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const enquiry = db.prepare(`
    SELECT e.*, u.name as created_by_name,
           ap.name as rate_finalised_by_name,
           rb.name as return_signed_by_name,
           se.name as site_engineer_user_name,
           v.name as vendor_official_name,
           v.firm_name   as vendor_firm_name,
           v.contact_person as vendor_contact_person,
           v.phone       as vendor_phone,
           v.email       as vendor_email,
           v.address     as vendor_address,
           v.district    as vendor_district,
           v.state       as vendor_state
    FROM rental_tool_enquiry e
    LEFT JOIN users u   ON e.created_by = u.id
    LEFT JOIN users ap  ON e.rate_finalised_by = ap.id
    LEFT JOIN users rb  ON e.return_signed_by = rb.id
    LEFT JOIN users se  ON e.site_engineer_id = se.id
    LEFT JOIN vendors v ON e.vendor_id = v.id
    WHERE e.id = ?
  `).get(id);
  if (!enquiry) return res.status(404).json({ error: 'Enquiry not found' });
  const history = db.prepare(`
    SELECT id, from_stage, to_stage, triggered_by, notes, entered_at
    FROM rental_tool_history WHERE enquiry_id = ? ORDER BY entered_at ASC
  `).all(id);
  // Linked PO record (auto-created at Stage 1 rate finalisation).
  // Used by the rental PO print page so we have one fetch instead
  // of two from the print view.
  let po = null;
  if (enquiry.po_id) {
    po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(enquiry.po_id) || null;
  }
  res.json({ ...enquiry, history, po });
});

// ── POST /api/rental-tools/enquiries ───────────────────────────
// Raise a new enquiry.  Stage 1 target = now + 5 business hours.
router.post('/enquiries', requirePermission('rental_tools', 'create'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  if (!b.site_name || !b.date_of_requirement || !b.days_required) {
    return res.status(400).json({ error: 'site_name, date_of_requirement, and days_required are required' });
  }
  if (+b.days_required <= 0) {
    return res.status(400).json({ error: 'days_required must be > 0' });
  }
  const now = new Date();
  const stage1Target = addBusinessHours(now, 5);
  const enquiry_no = nextEnquiryNo(db);

  let id;
  try {
    const r = db.prepare(`
      INSERT INTO rental_tool_enquiry (
        enquiry_no, site_id, site_name, tool_description,
        date_of_requirement, days_required,
        site_engineer_id, site_engineer_name,
        current_stage, status,
        stage1_target_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'enquiry', 'open', ?, ?)
    `).run(
      enquiry_no, b.site_id || null, b.site_name, b.tool_description || null,
      b.date_of_requirement, +b.days_required,
      b.site_engineer_id || null, b.site_engineer_name || null,
      stage1Target.toISOString(), req.user.id,
    );
    id = r.lastInsertRowid;
    db.prepare(`INSERT INTO rental_tool_history (enquiry_id, from_stage, to_stage, triggered_by, notes) VALUES (?, NULL, 'enquiry', ?, ?)`)
      .run(id, String(req.user.id), `enquiry raised · stage 1 target ${stage1Target.toLocaleString('en-IN')}`);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  logAuditEvent({
    user: req.user, action: 'CREATE', entity_type: 'rental_tool_enquiry',
    entity_id: id, entity_label: enquiry_no,
    method: 'POST', path: '/api/rental-tools/enquiries',
    body: { site_name: b.site_name, days: b.days_required },
  });
  res.status(201).json({ id, enquiry_no, stage1_target_at: stage1Target.toISOString() });
});

// ── POST /api/rental-tools/enquiries/:id/finalise-rate ─────────
// Stage 1 → Stage 2.  Locks vendor + rate; creates a draft PO.
// Gate = canApprove() (designated approver, else can_approve role) —
// requiring the create/edit bit here 403'd approvers whose role
// happened to lack that unrelated bit.
router.post('/enquiries/:id/finalise-rate', requirePermission('rental_tools', 'view'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  if (!canApprove(db, req.user.id)) {
    return res.status(403).json({ error: 'Only the designated rental approver (Ajmer) can finalise rates. Ask admin to set rental_approver_user_id in app settings.' });
  }
  const b = req.body || {};
  const required = ['vendor_id', 'vendor_name', 'vendor_rate', 'po_number', 'po_date', 'total_amount'];
  for (const f of required) {
    if (b[f] === undefined || b[f] === '' || b[f] === null) {
      return res.status(400).json({ error: `${f} is required` });
    }
  }
  const enquiry = db.prepare(`SELECT * FROM rental_tool_enquiry WHERE id=?`).get(id);
  if (!enquiry) return res.status(404).json({ error: 'Enquiry not found' });
  if (enquiry.current_stage !== 'enquiry') {
    return res.status(400).json({ error: `Enquiry is at stage ${enquiry.current_stage}, not 'enquiry'` });
  }

  // Stage 2 target — date_of_requirement + 1 business day (alert
  // window if material not yet received).
  const reqDate = new Date(enquiry.date_of_requirement + 'T09:00:00');
  const stage2Target = addBusinessHours(reqDate, 8);  // 1 working day

  const txn = db.transaction(() => {
    // Auto-create PO — mam (2026-05-16): the PO IS the artifact
    // created here, so po_copy_link is null (no external copy to
    // link to).  business_book_id stays NULL since rentals are
    // operational expenses, not tied to a sale.
    const poRes = db.prepare(`
      INSERT INTO purchase_orders (
        business_book_id, po_number, po_date, total_amount, advance_amount,
        po_copy_link, boq_file_link, crm_name, created_by
      ) VALUES (NULL, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `).run(
      b.po_number, b.po_date, +b.total_amount, +(b.advance_amount || 0),
      b.crm_name || req.user.name || 'Rental', req.user.id,
    );
    const poId = poRes.lastInsertRowid;

    db.prepare(`
      UPDATE rental_tool_enquiry SET
        vendor_id = ?, vendor_name = ?, vendor_rate = ?, vendor_rate_unit = ?,
        po_id = ?, po_number = ?,
        rate_finalised_at = CURRENT_TIMESTAMP, rate_finalised_by = ?,
        current_stage = 'rate_finalised',
        stage2_target_at = ?,
        stage1_breached = CASE WHEN stage1_target_at < CURRENT_TIMESTAMP THEN 1 ELSE 0 END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      +b.vendor_id, b.vendor_name, +b.vendor_rate, b.vendor_rate_unit || 'per_day',
      poId, b.po_number,
      req.user.id,
      stage2Target.toISOString(),
      id,
    );
    db.prepare(`INSERT INTO rental_tool_history (enquiry_id, from_stage, to_stage, triggered_by, notes) VALUES (?, 'enquiry', 'rate_finalised', ?, ?)`)
      .run(id, String(req.user.id), `vendor=${b.vendor_name} · rate=₹${b.vendor_rate}/${b.vendor_rate_unit || 'per_day'} · PO ${b.po_number} (₹${b.total_amount}) · stage 2 target ${stage2Target.toLocaleString('en-IN')}`);
    return poId;
  });

  let poId;
  try { poId = txn(); } catch (e) { return res.status(500).json({ error: e.message }); }

  logAuditEvent({
    user: req.user, action: 'UPDATE', entity_type: 'rental_tool_enquiry',
    entity_id: id, entity_label: enquiry.enquiry_no,
    method: 'POST', path: '/api/rental-tools/enquiries/:id/finalise-rate',
    body: { vendor: b.vendor_name, po: b.po_number, amount: b.total_amount },
  });
  res.json({ id, po_id: poId, current_stage: 'rate_finalised' });
});

// ── POST /api/rental-tools/enquiries/:id/material-received ─────
// Stage 2 → Stage 3.  Site engineer uploads live photo + GPS;
// return target date = today + days_required (business days).
router.post('/enquiries/:id/material-received', requirePermission('rental_tools', 'edit'), photoUpload.single('photo'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const enquiry = db.prepare(`SELECT * FROM rental_tool_enquiry WHERE id=?`).get(id);
  if (!enquiry) return res.status(404).json({ error: 'Enquiry not found' });
  if (enquiry.current_stage !== 'rate_finalised') {
    return res.status(400).json({ error: `Enquiry is at stage ${enquiry.current_stage}, not 'rate_finalised'` });
  }
  if (!req.file) return res.status(400).json({ error: 'photo is required (live camera shot)' });

  const lat = req.body.latitude ? +req.body.latitude : null;
  const lng = req.body.longitude ? +req.body.longitude : null;
  if (lat === null || lng === null) {
    // Clean up uploaded file since we're rejecting
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(400).json({ error: 'latitude + longitude are required (allow GPS in browser)' });
  }
  const photoUrl = `/uploads/rental-tools/${req.file.filename}`;
  const now = new Date();
  const returnTarget = addBusinessDays(now, enquiry.days_required);

  try {
    db.prepare(`
      UPDATE rental_tool_enquiry SET
        material_received_at = CURRENT_TIMESTAMP,
        material_received_photo = ?,
        material_received_lat = ?, material_received_lng = ?,
        return_target_date = ?,
        current_stage = 'material_received',
        stage2_breached = CASE WHEN stage2_target_at < CURRENT_TIMESTAMP THEN 1 ELSE 0 END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(photoUrl, lat, lng, returnTarget.toISOString().slice(0, 10), id);
    db.prepare(`INSERT INTO rental_tool_history (enquiry_id, from_stage, to_stage, triggered_by, notes) VALUES (?, 'rate_finalised', 'material_received', ?, ?)`)
      .run(id, String(req.user.id), `material received · photo uploaded · GPS ${lat.toFixed(5)},${lng.toFixed(5)} · return target ${returnTarget.toISOString().slice(0, 10)}`);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  logAuditEvent({
    user: req.user, action: 'UPDATE', entity_type: 'rental_tool_enquiry',
    entity_id: id, entity_label: enquiry.enquiry_no,
    method: 'POST', path: '/api/rental-tools/enquiries/:id/material-received',
    body: { photo: photoUrl, lat, lng, return_target: returnTarget.toISOString().slice(0, 10) },
  });
  res.json({ id, current_stage: 'material_received', return_target_date: returnTarget.toISOString().slice(0, 10), photo_url: photoUrl });
});

// ── POST /api/rental-tools/enquiries/:id/return ────────────────
// Stage 3 closure.  Ajmer signs off.  Same canApprove() gate as
// finalise-rate — the edit bit is not required to approve.
router.post('/enquiries/:id/return', requirePermission('rental_tools', 'view'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  if (!canApprove(db, req.user.id)) {
    return res.status(403).json({ error: 'Only the designated rental approver (Ajmer) can sign returns.' });
  }
  const enquiry = db.prepare(`SELECT * FROM rental_tool_enquiry WHERE id=?`).get(id);
  if (!enquiry) return res.status(404).json({ error: 'Enquiry not found' });
  if (enquiry.current_stage !== 'material_received') {
    return res.status(400).json({ error: `Enquiry is at stage ${enquiry.current_stage}, not 'material_received'` });
  }
  const notes = (req.body?.notes || '').trim();

  try {
    db.prepare(`
      UPDATE rental_tool_enquiry SET
        returned_at = CURRENT_TIMESTAMP,
        return_signed_by = ?,
        return_signed_at = CURRENT_TIMESTAMP,
        return_notes = ?,
        current_stage = 'returned',
        status = 'closed',
        stage3_breached = CASE WHEN DATE(return_target_date) < DATE('now') THEN 1 ELSE 0 END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.user.id, notes || null, id);
    db.prepare(`INSERT INTO rental_tool_history (enquiry_id, from_stage, to_stage, triggered_by, notes) VALUES (?, 'material_received', 'returned', ?, ?)`)
      .run(id, String(req.user.id), `returned to vendor · signed by ${req.user.name}${notes ? ' · ' + notes : ''}`);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  logAuditEvent({
    user: req.user, action: 'UPDATE', entity_type: 'rental_tool_enquiry',
    entity_id: id, entity_label: enquiry.enquiry_no,
    method: 'POST', path: '/api/rental-tools/enquiries/:id/return',
    body: { notes },
  });
  res.json({ id, current_stage: 'returned', status: 'closed' });
});

// ── POST /api/rental-tools/enquiries/:id/cancel ────────────────
router.post('/enquiries/:id/cancel', requirePermission('rental_tools', 'edit'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const enquiry = db.prepare(`SELECT * FROM rental_tool_enquiry WHERE id=?`).get(id);
  if (!enquiry) return res.status(404).json({ error: 'Enquiry not found' });
  if (enquiry.status !== 'open') return res.status(400).json({ error: `Already ${enquiry.status}` });
  const notes = (req.body?.notes || '').trim();
  db.prepare(`UPDATE rental_tool_enquiry SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(id);
  db.prepare(`INSERT INTO rental_tool_history (enquiry_id, from_stage, to_stage, triggered_by, notes) VALUES (?, ?, ?, ?, ?)`)
    .run(id, enquiry.current_stage, enquiry.current_stage, String(req.user.id), `cancelled${notes ? ' · ' + notes : ''}`);
  logAuditEvent({
    user: req.user, action: 'UPDATE', entity_type: 'rental_tool_enquiry',
    entity_id: id, entity_label: enquiry.enquiry_no,
    method: 'POST', path: '/api/rental-tools/enquiries/:id/cancel',
    body: { notes },
  });
  res.json({ id, status: 'cancelled' });
});

// ── PUT /api/rental-tools/settings/approver ────────────────────
// Admin-only.  Sets app_settings.rental_approver_user_id (Ajmer).
router.put('/settings/approver', requirePermission('rental_tools', 'edit'), (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const db = getDb();
  const userId = req.body?.user_id ? +req.body.user_id : null;
  if (!userId) {
    db.prepare(`DELETE FROM app_settings WHERE key='rental_approver_user_id'`).run();
    return res.json({ user_id: null });
  }
  const u = db.prepare(`SELECT id, name FROM users WHERE id=? AND active != 0`).get(userId);
  if (!u) return res.status(400).json({ error: 'User not found or inactive' });
  db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`).run('rental_approver_user_id', String(userId));
  res.json({ user_id: userId, name: u.name });
});

module.exports = router;
