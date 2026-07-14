// Influencer / Referral Partner module — mam (2026-05-20):
// "make new influencer Sheet add fields according to sheet.  and
// same as upload can bulk and can download also".
//
// Fields mirror the 6-section Influencer Enquiry Form Excel mam
// shared:
//   1. Basic Identity
//   2. Professional Category
//   3. Company / Firm Details
//   4. Contact Information
//   5. Digital / Social Presence
//   6. Relationship & Business Intelligence
//
// Endpoints:
//   GET    /api/influencers                — list with filters/search
//   POST   /api/influencers                — create
//   PUT    /api/influencers/:id            — update
//   DELETE /api/influencers/:id            — delete
//   GET    /api/influencers/import/template  — .xlsx template
//   POST   /api/influencers/import         — bulk upload
//   GET    /api/influencers/export         — .xlsx download

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { logAuditEvent } = require('../middleware/audit');

const router = express.Router();
router.use(authMiddleware);

const uploadDir = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

// Idempotent migration — runs at module load
try {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS influencers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      form_id TEXT UNIQUE,
      date_of_entry DATE,
      entered_by TEXT,
      assigned_relationship_manager TEXT,
      -- 1. Basic Identity
      salutation TEXT,
      full_name TEXT NOT NULL,
      date_of_birth DATE,
      anniversary_date DATE,
      gender TEXT,
      hometown TEXT,
      -- 2. Professional Category
      primary_category TEXT,
      primary_category_other TEXT,
      years_in_industry INTEGER,
      decision_making_role TEXT,
      -- 3. Company / Firm Details
      company_name TEXT,
      designation TEXT,
      company_size TEXT,
      year_established INTEGER,
      office_address TEXT,
      city TEXT,
      pincode TEXT,
      gst_number TEXT,
      website TEXT,
      -- 4. Contact Information
      primary_mobile TEXT NOT NULL,
      secondary_mobile TEXT,
      whatsapp_number TEXT,
      office_landline TEXT,
      personal_email TEXT,
      office_email TEXT,
      preferred_contact_method TEXT,
      best_time_to_call TEXT,
      -- 5. Digital / Social Presence
      linkedin_url TEXT,
      facebook_url TEXT,
      instagram_handle TEXT,
      twitter_handle TEXT,
      youtube_channel TEXT,
      google_business_profile TEXT,
      other_listings TEXT,
      -- 6. Relationship & Business Intelligence
      source_of_contact TEXT,
      referred_by TEXT,
      first_meeting_date DATE,
      relationship_stage TEXT,
      typical_project_type TEXT,
      typical_project_value_range TEXT,
      past_projects_count INTEGER DEFAULT 0,
      past_projects_total_value REAL DEFAULT 0,
      ongoing_projects_with_us INTEGER DEFAULT 0,
      client_payment_behavior TEXT,
      commission_terms TEXT,
      competitors TEXT,
      -- Audit
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  getDb().exec(`CREATE INDEX IF NOT EXISTS idx_influencers_form_id ON influencers(form_id)`);
  getDb().exec(`CREATE INDEX IF NOT EXISTS idx_influencers_full_name ON influencers(full_name)`);
  getDb().exec(`CREATE INDEX IF NOT EXISTS idx_influencers_mobile ON influencers(primary_mobile)`);
} catch (e) {
  console.warn('[influencers] schema init failed:', e.message);
}

// Form ID auto-generator — INF-0001, INF-0002, ...
function nextFormId(db) {
  try {
    const last = db.prepare(`SELECT form_id FROM influencers WHERE form_id LIKE 'INF-%' ORDER BY id DESC LIMIT 1`).get();
    const lastNum = last ? parseInt(String(last.form_id).replace('INF-', ''), 10) : 0;
    return `INF-${String(lastNum + 1).padStart(4, '0')}`;
  } catch (_) {
    return `INF-${Date.now().toString().slice(-6)}`;
  }
}

// ─── GET /api/influencers/lookup ─────────────────────────────────
// Mam (2026-06-01): "SOURCE :- INFLUCER ADD AND IF IT SELECT NAME
// DROP DOWN FROM PARTNERS".  Sales reps need to fill the partner
// dropdown on the Lead Capture form without having full
// influencers:view permission (which is admin-only).  This
// lightweight endpoint returns just id / name / company / primary
// category for active rows.  MUST be registered above /:id so the
// id-matcher doesn't eat the path.
router.get('/lookup', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, full_name, company_name, primary_category
       FROM influencers
      ORDER BY full_name COLLATE NOCASE`
  ).all();
  res.json(rows);
});

// ─── GET /api/influencers ────────────────────────────────────────
router.get('/', requirePermission('influencers', 'view'), (req, res) => {
  const db = getDb();
  const { search, primary_category, relationship_stage, city } = req.query;
  let sql = 'SELECT * FROM influencers WHERE 1=1';
  const params = [];
  if (search) {
    sql += ` AND (
      LOWER(full_name) LIKE ? OR
      LOWER(COALESCE(company_name,'')) LIKE ? OR
      primary_mobile LIKE ? OR
      LOWER(COALESCE(form_id,'')) LIKE ? OR
      LOWER(COALESCE(personal_email,'')) LIKE ?
    )`;
    const term = `%${search.toLowerCase()}%`;
    params.push(term, term, term, term, term);
  }
  if (primary_category)   { sql += ' AND primary_category = ?';   params.push(primary_category); }
  if (relationship_stage) { sql += ' AND relationship_stage = ?'; params.push(relationship_stage); }
  if (city)               { sql += ' AND city = ?';               params.push(city); }
  sql += ' ORDER BY id DESC';
  res.json(db.prepare(sql).all(...params));
});

// ─── GET /api/influencers/:id ────────────────────────────────────
router.get('/:id', requirePermission('influencers', 'view'), (req, res) => {
  const r = getDb().prepare('SELECT * FROM influencers WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Influencer not found' });
  res.json(r);
});

// Helper — all writable columns in canonical order.
// Used by INSERT / UPDATE / template / export so the field list
// stays in lockstep across the codebase.
const FIELDS = [
  'salutation','full_name','date_of_birth','anniversary_date','gender','hometown',
  'primary_category','primary_category_other','years_in_industry','decision_making_role',
  'company_name','designation','company_size','year_established','office_address','city','pincode','gst_number','website',
  'primary_mobile','secondary_mobile','whatsapp_number','office_landline','personal_email','office_email','preferred_contact_method','best_time_to_call',
  'linkedin_url','facebook_url','instagram_handle','twitter_handle','youtube_channel','google_business_profile','other_listings',
  'source_of_contact','referred_by','first_meeting_date','relationship_stage','typical_project_type','typical_project_value_range','past_projects_count','past_projects_total_value','ongoing_projects_with_us','client_payment_behavior','commission_terms','competitors',
  'date_of_entry','entered_by','assigned_relationship_manager',
];
// Human-readable headers — also drives the Excel template + export
const HEADERS = {
  form_id: 'Form ID',
  date_of_entry: 'Date of Entry',
  entered_by: 'Entered By',
  assigned_relationship_manager: 'Assigned Relationship Manager',
  salutation: 'Salutation',
  full_name: 'Full Name*',
  date_of_birth: 'Date of Birth',
  anniversary_date: 'Anniversary Date',
  gender: 'Gender',
  hometown: 'Hometown / Native Place',
  primary_category: 'Primary Category*',
  primary_category_other: "If 'Others' — Specify",
  years_in_industry: 'Years in Industry',
  decision_making_role: 'Decision-Making Role',
  company_name: 'Company / Firm Name',
  designation: 'Designation',
  company_size: 'Company Size',
  year_established: 'Year Established',
  office_address: 'Office Address',
  city: 'City',
  pincode: 'Pincode',
  gst_number: 'GST Number',
  website: 'Website',
  primary_mobile: 'Primary Mobile*',
  secondary_mobile: 'Secondary Mobile',
  whatsapp_number: 'WhatsApp Number',
  office_landline: 'Office Landline',
  personal_email: 'Personal Email',
  office_email: 'Office Email',
  preferred_contact_method: 'Preferred Contact Method',
  best_time_to_call: 'Best Time to Call',
  linkedin_url: 'LinkedIn Profile URL',
  facebook_url: 'Facebook Profile / Page',
  instagram_handle: 'Instagram Handle',
  twitter_handle: 'Twitter / X Handle',
  youtube_channel: 'YouTube Channel',
  google_business_profile: 'Google Business Profile',
  other_listings: 'IndiaMART / Justdial / Other Listings',
  source_of_contact: 'Source of Contact',
  referred_by: 'Referred By',
  first_meeting_date: 'First Meeting Date',
  relationship_stage: 'Relationship Stage',
  typical_project_type: 'Typical Project Type',
  typical_project_value_range: 'Typical Project Value Range',
  past_projects_count: 'Past Projects Given (Count)',
  past_projects_total_value: 'Total Value of Past Projects (₹)',
  ongoing_projects_with_us: 'Ongoing Projects with Us',
  client_payment_behavior: 'Client Payment Behavior',
  commission_terms: 'Commission / Referral Terms (Confidential)',
  competitors: 'Competitors They Also Work With',
};

// ─── POST /api/influencers ───────────────────────────────────────
router.post('/', requirePermission('influencers', 'create'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  if (!b.full_name || !String(b.full_name).trim()) return res.status(400).json({ error: 'Full Name is required' });
  if (!b.primary_mobile || !String(b.primary_mobile).trim()) return res.status(400).json({ error: 'Primary Mobile is required' });

  const formId = b.form_id || nextFormId(db);
  const values = FIELDS.map(f => b[f] ?? null);
  const cols = ['form_id', ...FIELDS, 'created_by'].join(',');
  const placeholders = Array(FIELDS.length + 2).fill('?').join(',');
  try {
    const r = db.prepare(`INSERT INTO influencers (${cols}) VALUES (${placeholders})`).run(formId, ...values, req.user.id);
    logAuditEvent({
      user: req.user, action: 'CREATE', entity_type: 'influencer',
      entity_id: r.lastInsertRowid, entity_label: b.full_name,
      method: 'POST', path: '/api/influencers',
      body: { form_id: formId, full_name: b.full_name },
    });
    res.status(201).json({ id: r.lastInsertRowid, form_id: formId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /api/influencers/:id ────────────────────────────────────
router.put('/:id', requirePermission('influencers', 'edit'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const cur = db.prepare('SELECT id FROM influencers WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Influencer not found' });
  const sets = []; const params = [];
  for (const f of FIELDS) {
    if (b[f] !== undefined) { sets.push(`${f} = ?`); params.push(b[f]); }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
  sets.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);
  db.prepare(`UPDATE influencers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json({ message: 'Updated' });
});

// ─── DELETE /api/influencers/:id ─────────────────────────────────
router.delete('/:id', requirePermission('influencers', 'delete'), (req, res) => {
  const db = getDb();
  const r = db.prepare('DELETE FROM influencers WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Influencer not found' });
  res.json({ message: 'Deleted' });
});

// ─── GET /api/influencers/import/template ────────────────────────
router.get('/import/template', requirePermission('influencers', 'view'), (req, res) => {
  const headerKeys = ['form_id', ...FIELDS];
  const headers = headerKeys.map(k => HEADERS[k] || k);
  const sample = [
    'INF-0001 (auto if blank)',
    'Mr', 'Rajesh Kumar', '1985-06-12', '2010-02-14', 'Male', 'Ludhiana',
    'Architect', '', 12, 'Decision Maker',
    'Kumar & Associates', 'Principal Architect', '10-50', 2010,
    '12 Mall Road, Ludhiana', 'Ludhiana', '141001', '03AAAPK1234A1Z5', 'kumar-arch.in',
    '9876543210', '', '9876543210', '', 'rajesh@kumar-arch.in', 'office@kumar-arch.in', 'WhatsApp', 'Mon-Fri 10am-5pm',
    'linkedin.com/in/rajeshkumar', 'fb.com/kumararch', '@kumar.architects', '', 'youtube.com/c/kumarArch', '', '',
    'Referral', 'Mr Singh', '2026-01-15', 'Active', 'Commercial Interiors', '50 L - 2 Cr', 5, 12500000, 2, 'Prompt',
    '2% on completion', 'Patel Designs, M+R Studio',
    new Date().toISOString().slice(0,10), 'Admin', '',
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, sample]);
  ws['!cols'] = headers.map(h => ({ wch: Math.max(18, Math.min(40, h.length + 4)) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Influencers');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="influencers-template.xlsx"');
  res.send(buf);
});

// ─── GET /api/influencers/export ─────────────────────────────────
router.get('/export', requirePermission('influencers', 'view'), (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM influencers ORDER BY id DESC').all();
  const headerKeys = ['form_id', ...FIELDS];
  const headers = headerKeys.map(k => HEADERS[k] || k);
  const data = [headers, ...rows.map(r => headerKeys.map(k => r[k] ?? ''))];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = headers.map(h => ({ wch: Math.max(18, Math.min(40, h.length + 4)) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Influencers');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="influencers-export-${new Date().toISOString().slice(0,10)}.xlsx"`);
  res.send(buf);
});

// ─── POST /api/influencers/import (bulk Excel upload) ────────────
router.post('/import', requirePermission('influencers', 'create'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const db = getDb();
  let rows = [];
  try {
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(400).json({ error: 'Could not parse the file. Expected .xlsx/.xls/.csv', detail: e.message });
  }
  try { fs.unlinkSync(req.file.path); } catch (_) {}
  if (!rows.length) return res.status(400).json({ error: 'No data rows found. First row must be headers; data starts on row 2.' });

  // Build header → field-key reverse map (case-insensitive, *-stripped)
  const headerToKey = {};
  Object.entries(HEADERS).forEach(([k, h]) => {
    const norm = String(h).replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    headerToKey[norm] = k;
  });
  const normalizeKey = (raw) => {
    const norm = String(raw || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    return headerToKey[norm] || null;
  };
  // Excel date serial → YYYY-MM-DD
  const dateFields = new Set(['date_of_birth','anniversary_date','first_meeting_date','date_of_entry']);
  const intFields  = new Set(['years_in_industry','year_established','past_projects_count','ongoing_projects_with_us']);
  const numFields  = new Set(['past_projects_total_value']);
  const normalizeDate = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') {
      const d = XLSX.SSF.parse_date_code(v);
      if (!d) return null;
      return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
    }
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const dd = new Date(s);
    return isNaN(dd) ? null : dd.toISOString().slice(0,10);
  };

  const created = []; const failed = [];
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const r = {};
    for (const [hdr, val] of Object.entries(raw)) {
      const key = normalizeKey(hdr);
      if (!key) continue;  // unknown column — ignore
      if (val === '' || val == null) continue;
      if (dateFields.has(key))      r[key] = normalizeDate(val);
      else if (intFields.has(key))  r[key] = parseInt(val, 10) || 0;
      else if (numFields.has(key))  r[key] = parseFloat(val) || 0;
      else                          r[key] = typeof val === 'string' ? val.trim() : val;
    }
    if (!r.full_name || !String(r.full_name).trim()) {
      failed.push({ row: i + 2, reason: 'Missing Full Name' });
      continue;
    }
    if (!r.primary_mobile || !String(r.primary_mobile).trim()) {
      failed.push({ row: i + 2, reason: 'Missing Primary Mobile' });
      continue;
    }
    try {
      const formId = (typeof r.form_id === 'string' && r.form_id.trim() && !/auto/i.test(r.form_id)) ? r.form_id.trim() : nextFormId(db);
      const values = FIELDS.map(f => r[f] ?? null);
      const cols = ['form_id', ...FIELDS, 'created_by'].join(',');
      const placeholders = Array(FIELDS.length + 2).fill('?').join(',');
      const ins = db.prepare(`INSERT INTO influencers (${cols}) VALUES (${placeholders})`).run(formId, ...values, req.user.id);
      created.push({ row: i + 2, id: ins.lastInsertRowid, form_id: formId, full_name: r.full_name });
    } catch (e) {
      failed.push({ row: i + 2, reason: e.message });
    }
  }
  logAuditEvent({
    user: req.user, action: 'BULK_IMPORT', entity_type: 'influencer',
    entity_label: `${created.length} created, ${failed.length} failed`,
    method: 'POST', path: '/api/influencers/import',
    body: { rows_total: rows.length, created: created.length, failed: failed.length },
  });
  res.json({ total_rows: rows.length, created_count: created.length, failed_count: failed.length, created, failed });
});

module.exports = router;
