// CRM Sales Funnel FMS — mam's spreadsheet-style flat tracker:
//   Step 1 Quotation submit → Step 2 Negotiation → Step 3 Win/Loss.
// Parallel to the existing 11-stage /sales-funnel module; this is the
// simpler workflow her sales team filled in a Google Sheet before.

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pg = require('../db/pg');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { nextSequencePg } = require('../db/nextSequence');
const { validateFunnelSource } = require('../utils/validate');
const router = express.Router();
router.use(authMiddleware);

// BOQ file upload — same /uploads directory the rest of the ERP uses.
const uploadDir = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const boqUpload = multer({ dest: uploadDir, limits: { fileSize: 15 * 1024 * 1024 } });

const ALLOWED_LEAD_TYPES = ['New', 'Extra Enquiry'];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// If an upload landed, rename it to a readable path and return /uploads/...
function persistBoqFile(req) {
  if (!req.file) return null;
  try {
    const safeName = (req.file.originalname || 'boq').replace(/[^a-zA-Z0-9._-]/g, '_');
    const newName = `${Date.now()}-${safeName}`;
    fs.renameSync(req.file.path, path.join(uploadDir, newName));
    return `/uploads/${newName}`;
  } catch (_) {
    return `/uploads/${req.file.filename}`;
  }
}

// GET list — filters: q (search), step (1|2|3|all|open), state, source, type
router.get('/', requirePermission('crm_funnel', 'view'), async (req, res) => {
  try {
    const { q, step, state, source, type } = req.query;
    let sql = 'SELECT * FROM crm_funnel WHERE 1=1';
    const params = [];

    if (step === 'open') { sql += " AND (final_status IS NULL OR final_status='')"; }
    if (step === '1') { sql += ' AND quotation_submitted=0'; }
    if (step === '2') { sql += " AND quotation_submitted=1 AND (final_status IS NULL OR final_status='')"; }
    if (step === '3') { sql += " AND final_status IN ('win','loss')"; }
    if (state) { sql += ' AND state=?'; params.push(state); }
    if (source) { sql += ' AND source=?'; params.push(source); }
    if (type) { sql += ' AND type=?'; params.push(type); }
    if (q) {
      sql += ' AND (client_name ILIKE ? OR company_name ILIKE ? OR mobile ILIKE ? OR lead_no ILIKE ?)';
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    sql += ' ORDER BY created_at DESC';
    res.json(await pg.all(sql, ...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', requirePermission('crm_funnel', 'view'), async (req, res) => {
  try {
    const row = await pg.get('SELECT * FROM crm_funnel WHERE id=?', req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requirePermission('crm_funnel', 'create'), boqUpload.single('boq_file'), async (req, res) => {
  try {
  const b = req.body || {};
  if (!b.client_name || !String(b.client_name).trim()) {
    return res.status(400).json({ error: 'Client name is required' });
  }
  // Block free-text lead sources per TOC v3 P0 #2.  Allowed values:
  // Tenders / Referral / Direct / Website / Channel.  Blank = OK (legacy rows).
  const srcErr = validateFunnelSource(b.source);
  if (srcErr) return res.status(400).json({ error: srcErr });
  const leadNo = await nextSequencePg(pg, 'crm_funnel', 'lead_no', 'CRM-', { startFrom: 0, pad: 4 });
  const leadType = ALLOWED_LEAD_TYPES.includes(b.lead_type) ? b.lead_type : null;
  const boqFileLink = persistBoqFile(req) || b.boq_file_link || null;
  const r = await pg.run(`INSERT INTO crm_funnel
    (lead_no, client_name, company_name, mobile, email, source, address, state, district,
     remarks, category, type, lead_type, boq_file_link,
     cust_boq_link, quotation_link, quotation_amount, quotation_submitted, quotation_submit_date,
     negotiation_status, negotiation_amount, negotiation_remarks,
     final_status, loss_reason, closed_at, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    leadNo,
    String(b.client_name).trim(),
    b.company_name || null, b.mobile || null, b.email || null, b.source || null,
    b.address || null, b.state || null, b.district || null,
    b.remarks || null, b.category || null, b.type || null,
    leadType, boqFileLink,
    b.cust_boq_link || null, b.quotation_link || null,
    num(b.quotation_amount), b.quotation_submitted == '1' || b.quotation_submitted === true ? 1 : 0,
    (b.quotation_submitted == '1' || b.quotation_submitted === true) ? (b.quotation_submit_date || new Date().toISOString()) : null,
    b.negotiation_status || null, num(b.negotiation_amount), b.negotiation_remarks || null,
    b.final_status || null, b.loss_reason || null,
    b.final_status ? (b.closed_at || new Date().toISOString()) : null,
    req.user.id,
  );
  res.status(201).json({ id: r.lastInsertRowid, lead_no: leadNo, boq_file_link: boqFileLink });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', requirePermission('crm_funnel', 'edit'), boqUpload.single('boq_file'), async (req, res) => {
  try {
  const b = req.body || {};
  // Same source enforcement on edit so historical rows can't be saved
  // with a free-text source value.
  if (b.source !== undefined) {
    const srcErr = validateFunnelSource(b.source);
    if (srcErr) return res.status(400).json({ error: srcErr });
  }
  const existing = await pg.get('SELECT * FROM crm_funnel WHERE id=?', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  // Stamp dates on the transition (Y/N → Y or final_status set the first time).
  const isSubmittedNow = b.quotation_submitted == '1' || b.quotation_submitted === true || b.quotation_submitted === 1;
  const becomingSubmitted = !existing.quotation_submitted && isSubmittedNow;
  const becomingClosed = !existing.final_status && b.final_status;
  const leadType = b.lead_type !== undefined
    ? (ALLOWED_LEAD_TYPES.includes(b.lead_type) ? b.lead_type : null)
    : existing.lead_type;
  const boqFileLink = persistBoqFile(req) ||
    (b.boq_file_link !== undefined ? (b.boq_file_link || null) : existing.boq_file_link);

  await pg.run(`UPDATE crm_funnel SET
    client_name=?, company_name=?, mobile=?, email=?, source=?, address=?, state=?, district=?,
    remarks=?, category=?, type=?, lead_type=?, boq_file_link=?,
    cust_boq_link=?, quotation_link=?, quotation_amount=?, quotation_submitted=?, quotation_submit_date=?,
    negotiation_status=?, negotiation_amount=?, negotiation_remarks=?,
    final_status=?, loss_reason=?, closed_at=?,
    updated_at=CURRENT_TIMESTAMP
    WHERE id=?`,
    b.client_name !== undefined ? String(b.client_name).trim() : existing.client_name,
    b.company_name !== undefined ? b.company_name : existing.company_name,
    b.mobile !== undefined ? b.mobile : existing.mobile,
    b.email !== undefined ? b.email : existing.email,
    b.source !== undefined ? b.source : existing.source,
    b.address !== undefined ? b.address : existing.address,
    b.state !== undefined ? b.state : existing.state,
    b.district !== undefined ? b.district : existing.district,
    b.remarks !== undefined ? b.remarks : existing.remarks,
    b.category !== undefined ? b.category : existing.category,
    b.type !== undefined ? b.type : existing.type,
    leadType, boqFileLink,
    b.cust_boq_link !== undefined ? b.cust_boq_link : existing.cust_boq_link,
    b.quotation_link !== undefined ? b.quotation_link : existing.quotation_link,
    b.quotation_amount !== undefined ? num(b.quotation_amount) : existing.quotation_amount,
    b.quotation_submitted !== undefined ? (isSubmittedNow ? 1 : 0) : existing.quotation_submitted,
    becomingSubmitted ? (b.quotation_submit_date || new Date().toISOString()) : existing.quotation_submit_date,
    b.negotiation_status !== undefined ? b.negotiation_status : existing.negotiation_status,
    b.negotiation_amount !== undefined ? num(b.negotiation_amount) : existing.negotiation_amount,
    b.negotiation_remarks !== undefined ? b.negotiation_remarks : existing.negotiation_remarks,
    b.final_status !== undefined ? b.final_status : existing.final_status,
    b.loss_reason !== undefined ? b.loss_reason : existing.loss_reason,
    becomingClosed ? (b.closed_at || new Date().toISOString()) : existing.closed_at,
    req.params.id,
  );
  res.json({ message: 'Updated', boq_file_link: boqFileLink });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requirePermission('crm_funnel', 'delete'), async (req, res) => {
  try {
    const r = await pg.run('DELETE FROM crm_funnel WHERE id=?', req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
