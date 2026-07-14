const express = require('express');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const multer = require('multer');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { nextSequence } = require('../db/nextSequence');
const { fireEmailEvent } = require('../lib/emailRules');
const { getEmailConfig } = require('../lib/email');
const router = express.Router();
router.use(authMiddleware);

// Build the merge context for an indent email event (mam 2026-06-03 email
// triggers). Resolves the dynamic recipient emails (raiser / CRM owner /
// director) + the {{variables}} used in templates. Best-effort, never throws.
function buildIndentContext(db, indentId, extra = {}) {
  try {
    const row = db.prepare(`
      SELECT i.indent_number, i.indent_category, i.site_name,
             cu.email AS raiser_email, cu.name AS raised_by_name,
             opb.owner AS planning_owner, opo.crm_name AS planning_crm_name,
             COALESCE((SELECT SUM(amount) FROM indent_items WHERE indent_id = i.id), 0) AS amount
        FROM indents i
        LEFT JOIN users cu ON cu.id = i.created_by
        LEFT JOIN order_planning op ON op.id = i.planning_id
        LEFT JOIN business_book opb ON opb.id = op.business_book_id
        LEFT JOIN purchase_orders opo ON opo.id = op.po_id
       WHERE i.id = ?`).get(indentId);
    if (!row) return null;
    // Resolve the CRM owner's email by matching the PO crm_name / BB owner
    // (a name) to an active user's name. Best-effort; may be null.
    let crmOwnerEmail = null;
    const ownerName = String(row.planning_crm_name || row.planning_owner || '').trim();
    if (ownerName) {
      const u = db.prepare(
        "SELECT email FROM users WHERE active=1 AND email IS NOT NULL AND email!='' AND LOWER(name) LIKE ? LIMIT 1"
      ).get('%' + ownerName.toLowerCase() + '%');
      crmOwnerEmail = u?.email || null;
    }
    let director = null;
    try { director = getEmailConfig().director; } catch {}
    return {
      indent_no: row.indent_number,
      category: row.indent_category,
      site: row.site_name,
      amount: Math.round(+row.amount || 0).toLocaleString('en-IN'),
      raised_by: row.raised_by_name,
      date: new Date().toISOString().slice(0, 10),
      raiser_email: row.raiser_email,
      crm_owner_email: crmOwnerEmail,
      director_email: director,
      ...extra,
    };
  } catch (e) { return null; }
}

// Load context + fire an indent email event (fire-and-forget).
function fireIndent(db, indentId, eventKey, extra = {}) {
  const ctx = buildIndentContext(db, indentId, extra);
  if (ctx) fireEmailEvent(eventKey, ctx);
}

// Gate the high-trust procurement actions (Vendor Rates entry, Vendor PO
// upload, Purchase Bill, Dispatch) behind procurement.approve permission.
// Site engineers with only procurement.create can still raise indents —
// they just can't touch vendor-facing or financial steps. This matches
// mam's requirement (2026-04-23): site can create indent, nothing else.
const needsApprove = requirePermission('procurement', 'approve');

// Match a Business Book row by company / client name (mam 2026-06-06: Extra
// indents not linked to a project should still pull client + mobile + state +
// district from the Business Book "according to company name"). Returns the
// row with bb_* aliases (same shape as the planning-based lookup) or {}.
// Prefers a BB row that actually has a contact number.
function bbByName(db, name) {
  if (!name || !String(name).trim()) return {};
  return db.prepare(
    `SELECT bb.company_name AS bb_company, bb.client_name AS bb_client,
            bb.client_contact AS bb_mobile,
            COALESCE(NULLIF(TRIM(bb.client_email),''), NULLIF(TRIM(bb.email_address),'')) AS bb_email,
            bb.billing_address AS bb_address, bb.source_of_enquiry AS bb_source,
            bb.state AS bb_state, bb.district AS bb_district, bb.owner AS bb_owner
       FROM business_book bb
      WHERE LOWER(TRIM(bb.company_name)) = LOWER(TRIM(?))
         OR LOWER(TRIM(bb.client_name))  = LOWER(TRIM(?))
      ORDER BY (bb.client_contact IS NOT NULL AND TRIM(bb.client_contact) <> '') DESC, bb.id DESC
      LIMIT 1`
  ).get(name, name) || {};
}
// Merge name-matched BB fields into a (possibly thin) planning-based result,
// filling only the keys that are still empty.
function fillBbBlanks(fi, byName) {
  const out = { ...(fi || {}) };
  for (const k of Object.keys(byName || {})) {
    if ((out[k] == null || out[k] === '') && byName[k] != null && byName[k] !== '') out[k] = byName[k];
  }
  return out;
}

// Build the auto-quotation data for an Extra indent (mam 2026-06-06). Each
// chargeable (PO-type) line is priced from the MOST RECENT previous BOQ
// (po_items) whose description EXACTLY matches (case/space-insensitive) the
// item's BOQ name × the indent qty. FOC / RGP / from-store lines are excluded.
// Returns { company, client, items[], supply_total, ... } or null if no indent.
function buildExtraQuotation(db, indentId) {
  const ind = db.prepare('SELECT * FROM indents WHERE id=?').get(indentId);
  if (!ind) return null;
  // Client — planning BB first, else match BB by the indent's site name.
  let cli = ind.planning_id
    ? db.prepare(`SELECT bb.* FROM order_planning op JOIN business_book bb ON bb.id=op.business_book_id WHERE op.id=?`).get(ind.planning_id)
    : null;
  if (!cli || !cli.client_contact) {
    const byName = db.prepare(
      `SELECT * FROM business_book
        WHERE LOWER(TRIM(company_name))=LOWER(TRIM(?)) OR LOWER(TRIM(client_name))=LOWER(TRIM(?))
        ORDER BY (client_contact IS NOT NULL AND TRIM(client_contact)<>'') DESC, id DESC LIMIT 1`
    ).get(ind.site_name, ind.site_name);
    if (byName) cli = { ...(byName), ...(cli || {}) };  // planning values win where present
  }
  cli = cli || {};
  // Chargeable lines = everything EXCEPT free items (FOC / RGP) and
  // from-store lines. Includes PO and untyped items so older Extra indents
  // (where item_type was never set) still get quoted. (mam 2026-06-06:
  // "where is qty rate amount" — the strict PO-only filter hid them.)
  const rows = db.prepare(
    `SELECT ii.id, ii.description, ii.quantity, ii.unit, ii.po_item_id, ii.item_type,
            poi.description AS boq_description, poi.unit AS boq_unit
       FROM indent_items ii
       LEFT JOIN po_items poi ON poi.id = ii.po_item_id
      WHERE ii.indent_id=?
        AND UPPER(COALESCE(ii.item_type,'')) NOT IN ('FOC','RGP')
        AND (ii.source IS NULL OR ii.source<>'store')
      ORDER BY ii.id`
  ).all(indentId);
  // BOQ rate for an EXACT item-name match (rate>0), most recent first.
  // Includes the indent's own BOQ line — for Extra-Schedule the rate lives
  // on that project's BOQ line for the item (mam 2026-06-06: it was being
  // excluded, so a priced BOQ line showed ₹0).
  const rateStmt = db.prepare(
    `SELECT rate FROM po_items
      WHERE LOWER(TRIM(description))=LOWER(TRIM(?)) AND COALESCE(rate,0)>0
      ORDER BY id DESC LIMIT 1`
  );
  let supplyTotal = 0;
  const items = rows.map((it, idx) => {
    const name = (it.boq_description && it.boq_description.trim()) ? it.boq_description : (it.description || '');
    const found = rateStmt.get(name);
    const rate = found ? +found.rate : 0;
    const qty = +it.quantity || 0;
    const amount = Math.round(qty * rate * 100) / 100;
    supplyTotal += amount;
    return { sno: idx + 1, description: name, unit: it.unit || it.boq_unit || 'Nos', qty, rate, amount, rate_found: !!found };
  });
  return {
    company: {
      name: 'SECURED ENGINEERS PVT. LTD',
      ho: '2480/1, B.K. Towers, Janta Nagar, Gill Road, Ludhiana',
      co: '58/A/1, First Floor, Kalu Sarai, New Delhi - 110016',
      website: 'www.securedengineers.com',
    },
    quotation: {
      no: `SEPL/QTN/${ind.indent_number || indentId}`,
      date: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }),
    },
    client: {
      name: cli.client_name || ind.site_name || '',
      company: cli.company_name || ind.site_name || '',
      address: cli.billing_address || cli.shipping_address || '',
      mobile: cli.client_contact || '',
      state: cli.state || '',
      district: cli.district || '',
      gstin: cli.gstin || '',
    },
    indent_number: ind.indent_number || null,
    items,
    supply_total: Math.round(supplyTotal * 100) / 100,
    basic_amount: Math.round(supplyTotal * 100) / 100,
  };
}

// Shared upload directory (served statically by server/index.js at /uploads).
// Used by both the Tally PO upload and the BOQ bulk upload lower in this file.
const uploadDir = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Multer for Vendor PO file uploads (PDF / images / Excel), up to 10 MB.
const vendorPoUpload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

// Same lenient Excel-BOQ parser the Orders upload uses — kept in sync here
// so we can fall back to the raw file when po_items is empty.
const parseBoqExcel = (filePath) => {
  try {
    const wb = XLSX.readFile(filePath);
    const parseNum = (v) => {
      if (v === null || v === undefined || v === '') return 0;
      if (typeof v === 'number') return v;
      const c = String(v).replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/);
      return c ? parseFloat(c[0]) : 0;
    };
    const HEADER_KW = ['item name', 'description', 'particulars', 'work', 'item', 'qty', 'qnty', 'quantity', 'sitc', 'rate', 'amount', 's/n', 's.no'];
    const parseSheet = (sn) => {
      const ws = wb.Sheets[sn];
      if (!ws) return [];
      const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
      let headerIdx = -1;
      for (let i = 0; i < Math.min(20, data.length); i++) {
        const row = (data[i] || []).map(c => String(c || '').toLowerCase().trim());
        const m = HEADER_KW.filter(k => row.some(c => c === k || c.includes(k))).length;
        if (m >= 2) { headerIdx = i; break; }
      }
      if (headerIdx === -1) return [];
      const headers = (data[headerIdx] || []).map(h => String(h || '').toLowerCase().trim());
      const colMap = {};
      headers.forEach((h, i) => {
        if (colMap.name === undefined && (h.includes('item name') || h.includes('description') || h.includes('particulars') || h === 'work' || h.includes('work description') || h === 'item' || h === 'items')) colMap.name = i;
        if (colMap.qty === undefined && (h === 'qty' || h === 'quantity' || h === 'qnty' || h.includes('qty') || h.includes('qnty') || h.includes('quantity') || h === 'nos')) colMap.qty = i;
        if (colMap.unit === undefined && (h === 'unit' || h === 'uom' || h.includes('unit') || h === 'units')) colMap.unit = i;
      });
      if (colMap.qty !== undefined && colMap.unit === undefined) {
        const uc = colMap.qty + 1;
        const UL = /^(mtr|nos|set|kg|sqm|rft|pair|pcs?|no|lot|unit|ltr|ton|bag|rmt|cum|sft|box|roll|feet|ft|mm|inch)\.?$/i;
        let matches = 0;
        for (let i = headerIdx + 1; i < Math.min(headerIdx + 40, data.length); i++) {
          const v = String((data[i] || [])[uc] || '').trim();
          if (v && UL.test(v)) matches++;
        }
        if (matches >= 2) colMap.unit = uc;
      }
      if (colMap.name === undefined) return [];
      const out = [];
      let sr = 1;
      for (let i = headerIdx + 1; i < data.length; i++) {
        const row = data[i] || [];
        const name = String(row[colMap.name] || '').trim();
        if (!name || name.length < 3) continue;
        const qty = colMap.qty !== undefined ? parseNum(row[colMap.qty]) : 0;
        if (qty === 0) continue;
        const unit = colMap.unit !== undefined ? String(row[colMap.unit] || 'Nos').trim() : 'Nos';
        out.push({ id: `fallback-${sn}-${sr}`, description: name, unit: unit || 'nos', boq_qty: qty, item_master_id: null, item_code: null, item_type: null, item_make: null, indented_qty: 0, remaining_qty: qty, is_foc: false });
        sr++;
      }
      return out;
    };
    // Pick the sheet that yields most rows (offer Excels often put BOQ in sheet 2)
    let best = [];
    for (const sn of wb.SheetNames) {
      const rows = parseSheet(sn);
      if (rows.length > best.length) best = rows;
    }
    return best;
  } catch (e) { return []; }
};

// Vendors
// Mam (2026-06-15): per-vendor list of brands / makes the vendor deals in
// (up to 10), entered with a "+ Add" on the form. Stored comma-joined.
try { getDb().exec('ALTER TABLE vendors ADD COLUMN makes TEXT'); } catch (_) {}
// Normalise the form's makes (array OR string) → a clean comma-joined string
// capped at 10 brands.
function normaliseMakes(m) {
  const arr = Array.isArray(m) ? m : (m == null ? [] : String(m).split(','));
  const clean = arr.map(s => String(s || '').trim()).filter(Boolean).slice(0, 10);
  return clean.length ? clean.join(', ') : null;
}
router.get('/vendors', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM vendors WHERE active=1 ORDER BY name').all());
});

router.post('/vendors', (req, res) => {
  const b = req.body;
  if (!b.name) return res.status(400).json({ error: 'Vendor name required' });
  const db = getDb();

  // Mam (2026-05-21): block duplicate vendors.  A vendor is the same
  // entity if EITHER its phone OR its GSTIN matches an existing row.
  // Phone-only or GST-only matches are also caught; if both blank we
  // skip the guard (legit edge case: pre-onboarding vendors with no
  // contact details yet).
  const { findDuplicate, sendDuplicate } = require('../utils/duplicateGuard');
  if (b.gst_number && String(b.gst_number).trim()) {
    const dup = findDuplicate(db, {
      table: 'vendors', fields: { gst_number: b.gst_number },
      codeColumn: 'vendor_code',
    });
    if (sendDuplicate(res, dup, `Vendor with GSTIN ${b.gst_number}`)) return;
  }
  if (b.phone && String(b.phone).trim()) {
    const dup = findDuplicate(db, {
      table: 'vendors', fields: { phone: b.phone },
      codeColumn: 'vendor_code',
    });
    if (sendDuplicate(res, dup, `Vendor with phone ${b.phone}`)) return;
  }

  // Auto-generate vendor code if empty. Uses nextSequence so deletes don't
  // cause UNIQUE-constraint collisions.
  let code = b.vendor_code;
  if (!code) {
    const { nextSequence } = require('../db/nextSequence');
    code = nextSequence(db, 'vendors', 'vendor_code', 'SEVC', { startFrom: 1999, pad: 4 });
  }
  // Vendor rating: optional score clamped to 0–10 (mam 2026-06-03).
  const clampRating = (v) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(10, n));
  };
  const r = db.prepare('INSERT OR IGNORE INTO vendors (vendor_code,name,firm_name,contact_person,phone,email,district,state,address,category,deals_in,authorized_dealer,type,turnover,team_size,payment_terms,credit_days,gst_number,source,category_wise,sub_category,existing_vendor,rating,makes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(code, b.name, b.firm_name, b.contact_person, b.phone, b.email, b.district, b.state, b.address, b.category, b.deals_in, b.authorized_dealer, b.type, b.turnover, b.team_size, b.payment_terms, b.credit_days, b.gst_number, b.source, b.category_wise, b.sub_category, b.existing_vendor, clampRating(b.rating), normaliseMakes(b.makes));
  res.status(201).json({ id: r.lastInsertRowid, vendor_code: code });
});

// Bulk vendor upsert (mam 2026-06-16: "add bulk with full details in excel" +
// "bulk vendor details update"). One import does BOTH:
//   - matches an EXISTING vendor by Vendor Code (exact), else phone, else GSTIN
//     → UPDATES it, overwriting ONLY the columns the sheet actually fills in.
//     Blank cells are left untouched, so a partial sheet enriches a vendor
//     without wiping the rest of its details.
//   - no match → INSERTS a new vendor (auto-codes a blank Vendor Code).
// Excel users save the sheet as CSV; the client parses it (quote-aware) and
// posts the rows here.
router.post('/vendors/bulk', (req, res) => {
  const rows = Array.isArray(req.body?.vendors) ? req.body.vendors : [];
  if (!rows.length) return res.status(400).json({ error: 'No vendors to import' });
  const db = getDb();
  const { nextSequence } = require('../db/nextSequence');
  const clampRating = (v) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(10, n));
  };
  const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
  const filled = (v) => v !== undefined && v !== null && String(v).trim() !== '';

  // Lookup maps so we can resolve each row to an existing vendor id without a
  // per-row query: by code, by phone, by GSTIN.
  const allVendors = db.prepare(`SELECT id, vendor_code, phone, gst_number FROM vendors`).all();
  const byCode = new Map(), byPhone = new Map(), byGst = new Map();
  for (const v of allVendors) {
    if (filled(v.vendor_code)) byCode.set(norm(v.vendor_code), v.id);
    if (filled(v.phone)) byPhone.set(norm(v.phone), v.id);
    if (filled(v.gst_number)) byGst.set(norm(v.gst_number), v.id);
  }

  const insert = db.prepare('INSERT OR IGNORE INTO vendors (vendor_code,name,firm_name,contact_person,phone,email,district,state,address,category,deals_in,authorized_dealer,type,turnover,team_size,payment_terms,credit_days,gst_number,source,category_wise,sub_category,existing_vendor,rating,makes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');

  // Columns the sheet can fill. makes/rating are normalised separately.
  const PLAIN = ['name','firm_name','contact_person','phone','email','district','state','address','category','deals_in','authorized_dealer','type','turnover','team_size','payment_terms','credit_days','gst_number','source','category_wise','sub_category','existing_vendor'];

  let added = 0, updated = 0;
  const skipped = [];
  const errors = [];
  const run = db.transaction(() => {
    for (let i = 0; i < rows.length; i++) {
      const b = rows[i] || {};
      const rowNo = i + 1;
      if (!filled(b.name)) { errors.push(`Row ${rowNo}: Vendor name required`); continue; }
      const codeKey = norm(b.vendor_code), phoneKey = norm(b.phone), gstKey = norm(b.gst_number);
      const existingId =
        (codeKey && byCode.get(codeKey)) ||
        (phoneKey && byPhone.get(phoneKey)) ||
        (gstKey && byGst.get(gstKey)) || null;
      try {
        if (existingId) {
          // UPDATE — only the columns the sheet actually fills in.
          const sets = [], vals = [];
          for (const k of PLAIN) { if (filled(b[k])) { sets.push(`${k}=?`); vals.push(String(b[k]).trim()); } }
          if (Array.isArray(b.makes) ? b.makes.length : filled(b.makes)) { sets.push('makes=?'); vals.push(normaliseMakes(b.makes)); }
          if (filled(b.rating)) { sets.push('rating=?'); vals.push(clampRating(b.rating)); }
          if (!sets.length) { skipped.push(`Row ${rowNo}: ${b.name} — nothing to update (all cells blank)`); continue; }
          sets.push('updated_at=CURRENT_TIMESTAMP');   // stamp last-edited on bulk update too
          db.prepare(`UPDATE vendors SET ${sets.join(',')} WHERE id=?`).run(...vals, existingId);
          updated++;
          // Keep maps fresh so later rows can match newly-set phone/GST.
          if (phoneKey) byPhone.set(phoneKey, existingId);
          if (gstKey) byGst.set(gstKey, existingId);
        } else {
          const code = filled(b.vendor_code)
            ? String(b.vendor_code).trim()
            : nextSequence(db, 'vendors', 'vendor_code', 'SEVC', { startFrom: 1999, pad: 4 });
          const r = insert.run(
            code, b.name, b.firm_name, b.contact_person, b.phone, b.email, b.district, b.state,
            b.address, b.category, b.deals_in, b.authorized_dealer, b.type, b.turnover, b.team_size,
            b.payment_terms, b.credit_days, b.gst_number, b.source, b.category_wise, b.sub_category,
            b.existing_vendor, clampRating(b.rating), normaliseMakes(b.makes),
          );
          added++;
          const newId = r.lastInsertRowid;
          if (codeKey) byCode.set(codeKey, newId);
          if (phoneKey) byPhone.set(phoneKey, newId);
          if (gstKey) byGst.set(gstKey, newId);
        }
      } catch (err) { errors.push(`Row ${rowNo}: ${err.message}`); }
    }
  });
  run();
  res.json({ added, updated, skipped, errors, total: rows.length });
});

router.put('/vendors/:id', (req, res) => {
  const b = req.body;
  const rating = (b.rating === '' || b.rating === null || b.rating === undefined)
    ? null
    : Math.max(0, Math.min(10, Number(b.rating) || 0));
  getDb().prepare('UPDATE vendors SET vendor_code=?,name=?,firm_name=?,contact_person=?,phone=?,email=?,district=?,state=?,address=?,category=?,deals_in=?,authorized_dealer=?,type=?,turnover=?,team_size=?,payment_terms=?,credit_days=?,gst_number=?,source=?,sub_category=?,rating=?,makes=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(b.vendor_code, b.name, b.firm_name, b.contact_person, b.phone, b.email, b.district, b.state, b.address, b.category, b.deals_in, b.authorized_dealer, b.type, b.turnover, b.team_size, b.payment_terms, b.credit_days, b.gst_number, b.source, b.sub_category, rating, normaliseMakes(b.makes), b.active !== undefined ? (b.active ? 1 : 0) : 1, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/vendors/:id', (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const uses = db.prepare(`SELECT
    (SELECT COUNT(*) FROM vendor_pos WHERE vendor_id=?) +
    (SELECT COUNT(*) FROM purchase_bills WHERE vendor_id=?) +
    (SELECT COUNT(*) FROM indent_items WHERE vendor_id=?) +
    (SELECT COUNT(*) FROM vendor_rates WHERE vendor1_id=? OR vendor2_id=? OR vendor3_id=? OR selected_vendor_id=?) as c`
  ).get(id, id, id, id, id, id, id).c;
  if (uses > 0) return res.status(409).json({ error: 'Cannot delete: vendor is referenced by POs, bills, indents or rate comparisons' });
  db.prepare('DELETE FROM vendors WHERE id=?').run(id);
  res.json({ message: 'Deleted' });
});

// Vendor Rate Comparison
router.get('/vendor-rates', (req, res) => {
  const { planning_id } = req.query;
  let sql = `SELECT vr.*, v1.name as vendor1_name, v2.name as vendor2_name, v3.name as vendor3_name, sv.name as selected_vendor_name
    FROM vendor_rates vr LEFT JOIN vendors v1 ON vr.vendor1_id=v1.id LEFT JOIN vendors v2 ON vr.vendor2_id=v2.id
    LEFT JOIN vendors v3 ON vr.vendor3_id=v3.id LEFT JOIN vendors sv ON vr.selected_vendor_id=sv.id`;
  const params = [];
  if (planning_id) { sql += ' WHERE vr.planning_id=?'; params.push(+planning_id || 0); }
  sql += ' ORDER BY vr.created_at DESC';
  res.json(getDb().prepare(sql).all(...params));
});

router.post('/vendor-rates', (req, res) => {
  const { planning_id, item_description, vendor1_id, vendor1_rate, vendor2_id, vendor2_rate, vendor3_id, vendor3_rate, final_rate, selected_vendor_id } = req.body;
  const r = getDb().prepare(
    'INSERT INTO vendor_rates (planning_id,item_description,vendor1_id,vendor1_rate,vendor2_id,vendor2_rate,vendor3_id,vendor3_rate,final_rate,selected_vendor_id) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(planning_id, item_description, vendor1_id, vendor1_rate, vendor2_id, vendor2_rate, vendor3_id, vendor3_rate, final_rate, selected_vendor_id);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.delete('/vendor-rates/:id', (req, res) => {
  getDb().prepare('DELETE FROM vendor_rates WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

router.put('/vendor-rates/:id/approve', (req, res) => {
  const { approval_status, approved_by } = req.body;
  getDb().prepare('UPDATE vendor_rates SET approval_status=?, approved_by=? WHERE id=?')
    .run(approval_status, approved_by || req.user.name, req.params.id);
  res.json({ message: 'Updated' });
});

// Indents
// Sites for the indent "Site Name" dropdown. mam's rule: show each company
// exactly once (CONSERN PHARMA even though there are 10 BB entries for it).
// The BOQ/PO-items lookup aggregates across ALL matching BBs for that name,
// so picking "CONSERN PHARMA" pulls items from every project with that
// company/site/project name. We return a representative lead_no (the latest)
// just so the dropdown can show '[SEPL20227] CONSERN PHARMA' as a hint.
router.get('/sites', (req, res) => {
  // `category` (Business Book division — Fire Fighting / Solar / Electrical …) is
  // returned so the indent Sub-Item picker can scope Item Master to the project's
  // division when a BOQ line isn't linked to a master item (mam 2026-06-27).
  const rows = getDb().prepare(
    `SELECT name, MAX(lead_no) as lead_no, MAX(category) as category
     FROM (
       SELECT COALESCE(s.name, bb.project_name, bb.company_name) as name,
              bb.lead_no as lead_no, bb.category as category
       FROM business_book bb
       LEFT JOIN sites s ON s.business_book_id = bb.id
       WHERE COALESCE(s.name, bb.project_name, bb.company_name) IS NOT NULL
         AND TRIM(COALESCE(s.name, bb.project_name, bb.company_name)) != ''
     )
     GROUP BY LOWER(TRIM(name))
     ORDER BY name COLLATE NOCASE`
  ).all();
  res.json(rows);
});

// BOQ items by business_book_id — used when the indent raiser picks a
// specific project row (preferred over site_name because names collide
// when mam has multiple projects for the same client).
// BOQ items for a specific project (business_book). Tries, in order:
//   1. po_items saved for this exact bb_id
//   2. Parse boq_file_link of this project's PO from disk
//   3. po_items saved for another project with the SAME company name / project
//      (mam has 10+ CONSERN PHARMA projects and often uploads BOQ once,
//       uses it for all — so we auto-borrow from a sibling project)
//   4. Parse boq_file_link of any sibling project's PO
// Returns { items, diagnostic } — diagnostic is optional when items load
// from the happy path, and informational (e.g. 'borrowed_from') when
// items come from a sibling so the UI can show it clearly.
router.get('/boq-items-by-bb', (req, res) => {
  const bbId = parseInt(req.query.bb_id, 10);
  if (!bbId) return res.status(400).json({ error: 'bb_id is required' });
  const db = getDb();

  const decorate = (rows) => rows.map(r => {
    const isFoc = String(r.item_type || '').toUpperCase() === 'FOC';
    return { ...r, is_foc: isFoc, remaining_qty: isFoc ? null : Math.max(0, (r.boq_qty || 0) - (r.indented_qty || 0)) };
  });
  const fetchPoItems = (bb) => db.prepare(
    `SELECT pi.id, pi.description, pi.unit, pi.quantity as boq_qty, pi.rate as boq_rate,
            pi.item_master_id, im.item_code, im.type as item_type, im.make as item_make,
            COALESCE((SELECT SUM(ii.quantity) FROM indent_items ii WHERE ii.po_item_id = pi.id), 0) as indented_qty
     FROM po_items pi
     LEFT JOIN item_master im ON im.id = pi.item_master_id
     WHERE pi.business_book_id = ?
     ORDER BY pi.id`
  ).all(bb);
  const latestPoFor = (bb) => db.prepare(
    `SELECT id, po_number, boq_file_link FROM purchase_orders
     WHERE business_book_id = ? ORDER BY created_at DESC LIMIT 1`
  ).get(bb);
  const tryFileParse = (po) => {
    if (!po?.boq_file_link) return null;
    const filename = path.basename(po.boq_file_link);
    const diskPath = path.join(__dirname, '..', '..', 'data', 'uploads', filename);
    if (!fs.existsSync(diskPath)) return null;
    const parsed = parseBoqExcel(diskPath);
    return parsed.length > 0 ? parsed : null;
  };

  // 1. This project's po_items
  const own = fetchPoItems(bbId);
  if (own.length > 0) return res.json({ items: decorate(own) });

  // 2. This project's BOQ Excel on disk
  const ownPo = latestPoFor(bbId);
  const ownParsed = tryFileParse(ownPo);
  if (ownParsed) return res.json({ items: ownParsed, diagnostic: { reason: 'fallback_parsed', po_number: ownPo.po_number, message: 'Items loaded from this project\'s BOQ file.' } });

  // 3. Sibling project's po_items (same company/project name)
  const meta = db.prepare('SELECT company_name, project_name, lead_no FROM business_book WHERE id=?').get(bbId);
  if (meta) {
    const sibling = db.prepare(
      `SELECT bb.id, bb.lead_no, bb.project_name, bb.company_name, COUNT(pi.id) as item_count
       FROM business_book bb
       JOIN po_items pi ON pi.business_book_id = bb.id
       WHERE bb.id != ?
         AND (LOWER(TRIM(bb.company_name)) = LOWER(TRIM(?))
           OR LOWER(TRIM(bb.project_name)) = LOWER(TRIM(?)))
       GROUP BY bb.id
       ORDER BY item_count DESC
       LIMIT 1`
    ).get(bbId, meta.company_name || '', meta.project_name || '');
    if (sibling) {
      const borrowed = fetchPoItems(sibling.id);
      return res.json({
        items: decorate(borrowed),
        diagnostic: {
          reason: 'borrowed_from_sibling',
          source_lead_no: sibling.lead_no,
          source_project: sibling.project_name || sibling.company_name,
          message: `No BOQ uploaded for this project yet — showing ${borrowed.length} items from sibling project [${sibling.lead_no}] ${sibling.project_name || sibling.company_name}. Upload this project's own BOQ to override.`,
        },
      });
    }

    // 4. Sibling project's BOQ Excel on disk
    const siblingWithFile = db.prepare(
      `SELECT bb.id, bb.lead_no, bb.project_name, bb.company_name, po.po_number, po.boq_file_link
       FROM business_book bb
       JOIN purchase_orders po ON po.business_book_id = bb.id
       WHERE bb.id != ?
         AND po.boq_file_link IS NOT NULL AND po.boq_file_link != ''
         AND (LOWER(TRIM(bb.company_name)) = LOWER(TRIM(?))
           OR LOWER(TRIM(bb.project_name)) = LOWER(TRIM(?)))
       ORDER BY po.created_at DESC LIMIT 1`
    ).get(bbId, meta.company_name || '', meta.project_name || '');
    const siblingParsed = tryFileParse(siblingWithFile);
    if (siblingParsed) {
      return res.json({
        items: siblingParsed,
        diagnostic: {
          reason: 'borrowed_from_sibling_file',
          source_lead_no: siblingWithFile.lead_no,
          source_project: siblingWithFile.project_name || siblingWithFile.company_name,
          message: `Items loaded from sibling project [${siblingWithFile.lead_no}] ${siblingWithFile.project_name || siblingWithFile.company_name}'s BOQ file.`,
        },
      });
    }
  }

  // Nothing found anywhere
  return res.json({
    items: [],
    diagnostic: {
      reason: ownPo ? (ownPo.boq_file_link ? 'boq_parse_empty' : 'no_boq_file') : 'no_po',
      po_number: ownPo?.po_number,
      message: ownPo
        ? (ownPo.boq_file_link
          ? `PO ${ownPo.po_number} has a BOQ file but parsing returned no items.`
          : `No BOQ uploaded yet for this project or any sibling project with the same name.`)
        : 'No BOQ uploaded yet for this project or any sibling project with the same name.',
    },
  });
});

// BOQ items for a given site — the "item wise sheet" mam referred to.
// Lookup order so BOQs are found even when the sites row isn't explicitly
// linked to a business_book (DPR can create sites without that FK):
//   1. sites.business_book_id where sites.name = X
//   2. business_book rows whose project_name / company_name = X
// For each BOQ line we compute:
//   - boq_qty       = po_items.quantity
//   - indented_qty  = sum of qty already indented against this line
//   - remaining_qty = boq_qty − indented_qty, but null for FOC items so
//                     the UI can hide the number (free items don't track)
router.get('/boq-items', (req, res) => {
  const siteName = String(req.query.site_name || '').trim();
  if (!siteName) return res.status(400).json({ error: 'site_name is required' });
  const db = getDb();

  // Case-insensitive, whitespace-tolerant matching — mam's names often differ
  // by case ('CONSERN PHARMA' in sites vs 'Consern Pharma' in business_book).
  const bbIds = new Set();
  db.prepare(
    `SELECT DISTINCT s.business_book_id FROM sites s
     WHERE LOWER(TRIM(s.name)) = LOWER(TRIM(?)) AND s.business_book_id IS NOT NULL`
  ).all(siteName).forEach(r => bbIds.add(r.business_book_id));
  db.prepare(
    `SELECT id FROM business_book
     WHERE LOWER(TRIM(project_name)) = LOWER(TRIM(?))
        OR LOWER(TRIM(company_name)) = LOWER(TRIM(?))
        OR LOWER(TRIM(client_name))  = LOWER(TRIM(?))`
  ).all(siteName, siteName, siteName).forEach(r => bbIds.add(r.id));

  if (bbIds.size === 0) {
    return res.json({
      items: [],
      diagnostic: { site_name: siteName, reason: 'no_business_book', message: `No Business Book entry matches "${siteName}". Check the site name in Business Book.` },
    });
  }
  const idList = [...bbIds];
  const placeholders = idList.map(() => '?').join(',');
  const items = db.prepare(
    `SELECT pi.id, pi.description, pi.unit, pi.quantity as boq_qty, pi.rate as boq_rate,
            pi.item_master_id, im.item_code, im.type as item_type, im.make as item_make,
            COALESCE((SELECT SUM(ii.quantity) FROM indent_items ii WHERE ii.po_item_id = pi.id), 0) as indented_qty
     FROM po_items pi
     LEFT JOIN item_master im ON im.id = pi.item_master_id
     WHERE pi.business_book_id IN (${placeholders})
     ORDER BY pi.id`
  ).all(...idList);

  // Fallback — if no po_items rows but the PO has a BOQ file attached, parse
  // that Excel on the fly. Lets mam pick BOQ items even when the save-to-DB
  // step was skipped during PO creation.
  if (items.length === 0) {
    const po = db.prepare(
      `SELECT id, po_number, boq_file_link FROM purchase_orders
       WHERE business_book_id IN (${placeholders})
       ORDER BY created_at DESC LIMIT 1`
    ).get(...idList);
    if (!po) {
      return res.json({ items: [], diagnostic: { site_name: siteName, reason: 'no_po', message: `Business Book entry matched but no PO exists yet. Create a PO in Orders first.` } });
    }
    if (!po.boq_file_link) {
      return res.json({ items: [], diagnostic: { site_name: siteName, reason: 'no_boq_file', po_number: po.po_number, message: `PO ${po.po_number} found but no BOQ file was attached. Open that PO in Orders and upload a BOQ.` } });
    }
    const filename = path.basename(po.boq_file_link);
    const diskPath = path.join(__dirname, '..', '..', 'data', 'uploads', filename);
    if (!fs.existsSync(diskPath)) {
      return res.json({ items: [], diagnostic: { site_name: siteName, reason: 'boq_file_missing', po_number: po.po_number, path: po.boq_file_link, message: `PO ${po.po_number} references ${po.boq_file_link} but the file is missing on the server. Re-upload the BOQ on that PO.` } });
    }
    const parsed = parseBoqExcel(diskPath);
    if (parsed.length === 0) {
      return res.json({ items: [], diagnostic: { site_name: siteName, reason: 'boq_parse_empty', po_number: po.po_number, message: `BOQ file was read but no items could be parsed. Re-open the PO, click "Upload BOQ & Fetch Items" and save.` } });
    }
    return res.json({ items: parsed, diagnostic: { site_name: siteName, reason: 'fallback_parsed', po_number: po.po_number, message: `Items loaded from BOQ file (not yet saved to DB).` } });
  }

  const result = items.map(r => {
    const isFoc = String(r.item_type || '').toUpperCase() === 'FOC';
    return {
      ...r,
      is_foc: isFoc,
      remaining_qty: isFoc ? null : Math.max(0, (r.boq_qty || 0) - (r.indented_qty || 0)),
    };
  });
  res.json({ items: result });
});

// List indents with a BOQ file link derived from the site's Client PO.
// The mapping is: indent.site_name → sites.business_book_id → purchase_orders.
// boq_file_link (pick the most recent PO for that business_book).
router.get('/indents', (req, res) => {
  const db = getDb();
  // Scope filter: anyone with 'approve' permission on procurement (or admin)
  // sees ALL indents. Plain users (site engineers with only view + create)
  // see only the ones they raised. Mam toggles this by checking / unchecking
  // 'approve' on the role's procurement permissions.
  const isAdmin = req.user.role === 'admin';
  const canSeeAll = isAdmin || (() => {
    const r = db.prepare(`
      SELECT MAX(CASE WHEN rp.can_approve = 1 OR rp.can_see_all = 1 THEN 1 ELSE 0 END) as ok
      FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = ? AND rp.module = 'procurement'
    `).get(req.user.id);
    return !!r?.ok;
  })();
  // Mam (2026-06-02): "gurcharan fill indent when i open his id he
  // is not showing his own filled indent please dont do this type
  // blunder".  The old filter only checked created_by — so any indent
  // whose created_by got set wrong (legacy rows where the column was
  // NULL, sessions where the form was filled via a shared device, or
  // accounts that were re-created with a new user.id) became invisible
  // to its actual raiser.  Now we OR-in a name match on the
  // raised_by_name field — set by the same form that captured the
  // indent — so engineers always see what they put their name on.
  const where = canSeeAll
    ? ''
    : `WHERE (i.created_by = ?
             OR (i.raised_by_name IS NOT NULL
                 AND LENGTH(TRIM(i.raised_by_name)) > 0
                 AND LOWER(TRIM(i.raised_by_name)) = LOWER(TRIM(?))))`;
  const params = canSeeAll ? [] : [req.user.id, req.user.name || ''];
  const indents = db.prepare(
    `SELECT i.*, u.name as created_by_name,
            au.name as approved_by_name,
            ru.name as rejected_by_name,
            l1u.name as l1_by_name,
            l2u.name as l2_by_name,
            cu.name as crm_by_name,
            -- Order Planning context (mam 2026-06-03): for Extra-item CRM
            -- approval, surface which project/site this indent belongs to
            -- via planning_id → order_planning → business_book, plus the
            -- CRM owner.  Display-only; does NOT restrict who can approve.
            COALESCE(NULLIF(TRIM(opb.project_name), ''),
                     NULLIF(TRIM(opb.company_name), ''),
                     NULLIF(TRIM(opb.client_name), '')) as planning_project,
            opb.owner as planning_owner,
            -- CRM person assigned on the linked Client PO (Sushila/Lovely).
            -- The frontend lets this person act on the CRM stage even without
            -- crm_funnel role access — must agree with the server gate.
            opo.crm_name as planning_crm_name,
            -- Billable preview (mam 2026-06-16): the order's Business Book and
            -- its Against-Delivery % so the list can show BOQ-sale value and
            -- the delivery-billable slice next to the internal Budget.
            op.business_book_id AS business_book_id,
            opb.payment_against_delivery AS bb_delivery_terms
     FROM indents i
     LEFT JOIN users u ON i.created_by = u.id
     LEFT JOIN users au ON i.approved_by = au.id
     LEFT JOIN users ru ON i.rejected_by = ru.id
     LEFT JOIN users l1u ON i.l1_by = l1u.id
     LEFT JOIN users l2u ON i.l2_by = l2u.id
     LEFT JOIN users cu ON i.crm_by = cu.id
     LEFT JOIN order_planning op ON op.id = i.planning_id
     LEFT JOIN business_book opb ON opb.id = op.business_book_id
     LEFT JOIN purchase_orders opo ON opo.id = op.po_id
     ${where}
     ORDER BY i.created_at DESC`
  ).all(...params);

  // Pull every indent_item in one query and group client-side so the
  // listing can show what was raised without a per-row API call.
  // Also pulls item_master.item_code / specification / size so the expanded
  // view can show the actual Sub-Item (Item Master entry) alongside the
  // BOQ description — the BOQ description is often very long and identical
  // across rows of the same BOQ, so the sub-item column is what tells the
  // rows apart at a glance.
  //
  // Budget rate resolution (mam 2026-05-25 follow-up):
  //   1. Prefer im.current_price (the item-wise master sheet rate)
  //   2. If that's 0 or NULL, fall back to the MOST RECENT rate from
  //      item_price_history for the same item_master_id — covers older
  //      items that haven't been re-priced into the master yet
  //   3. Otherwise 0  →  UI shows "—"
  // rate_source tells the UI which fallback hit so mam knows whether the
  // displayed rate came from master or history.
  const allItems = db.prepare(
    `SELECT ii.id, ii.indent_id, ii.description, ii.make, ii.quantity, ii.po_item_id,
            -- Show the CURRENT Item Master UOM for linked items so a later
            -- unit change in Item Master reflects here (mam 2026-06-10);
            -- manual lines keep their own stored unit. EXCEPTION: a per-line
            -- unit override set by the approver (unit_overridden=1, e.g. MTR→KG
            -- at approval) WINS over the master UOM — otherwise the master UOM
            -- masks it (mam 2026-07-01: "changed to KG but BoQ still showed MTR").
            CASE WHEN COALESCE(ii.unit_overridden, 0) = 1 AND TRIM(COALESCE(ii.unit, '')) <> ''
                   THEN ii.unit ELSE COALESCE(NULLIF(im.uom, ''), ii.unit) END AS unit, ii.item_type, ii.item_master_id,
            ii.is_extra_schedule, ii.is_extra_non_schedule,
            ii.rental_days, ii.rental_rate_per_day,
            -- Source split (mam 2026-06-02): 'store' lines came from
            -- existing office inventory at approval; 'procure' lines
            -- continue through the normal vendor PO flow. parent_item_id
            -- ties a 'store' child to its 'procure' sibling on the same
            -- BOQ line.  sin.note_number is the printable SI/####.
            ii.source, ii.parent_item_id, ii.stock_issue_note_id,
            sin.note_number as stock_issue_number,
            sin.issued_at as stock_issued_at,
            im.item_code, im.item_name as master_name,
            im.specification as master_specification, im.size as master_size,
            COALESCE(
              NULLIF(im.current_price, 0),
              (SELECT iph.rate
                 FROM item_price_history iph
                WHERE iph.item_id = ii.item_master_id
                ORDER BY iph.created_at DESC
                LIMIT 1),
              0
            ) as master_price,
            CASE
              WHEN COALESCE(im.current_price, 0) > 0 THEN 'master'
              WHEN (SELECT iph.rate FROM item_price_history iph
                     WHERE iph.item_id = ii.item_master_id
                     ORDER BY iph.created_at DESC LIMIT 1) > 0 THEN 'history'
              ELSE 'none'
            END as rate_source,
            COALESCE(
              NULLIF(im.current_price, 0),
              (SELECT iph.rate
                 FROM item_price_history iph
                WHERE iph.item_id = ii.item_master_id
                ORDER BY iph.created_at DESC
                LIMIT 1),
              0
            ) * COALESCE(ii.quantity, 0) as line_budget,
            -- PO coverage (mam 2026-06-23): how much of this indent line is
            -- already on a (non-cancelled) Vendor PO. The UI shows the
            -- still-pending qty = indent qty − po_qty (e.g. 100 indent, 70
            -- on a PO → 30 pending).
            COALESCE((
              SELECT SUM(vpi.quantity)
                FROM vendor_po_items vpi
                JOIN vendor_pos vp ON vp.id = vpi.vendor_po_id
               WHERE vpi.indent_item_id = ii.id
                 AND COALESCE(vp.cancelled, 0) = 0
            ), 0) as po_qty
     FROM indent_items ii
     LEFT JOIN item_master im ON ii.item_master_id = im.id
     LEFT JOIN stock_issue_notes sin ON sin.id = ii.stock_issue_note_id
     ORDER BY ii.id`
  ).all();
  const itemsByIndent = new Map();
  const budgetByIndent = new Map();
  for (const it of allItems) {
    if (!itemsByIndent.has(it.indent_id)) itemsByIndent.set(it.indent_id, []);
    itemsByIndent.get(it.indent_id).push(it);
    budgetByIndent.set(it.indent_id, (budgetByIndent.get(it.indent_id) || 0) + (+it.line_budget || 0));
  }

  // ── Billable + Delivery-Bill preview (mam 2026-06-16) ───────────────
  // Billable = Σ (BOQ item rate × indent qty). The BOQ rate is the CLIENT
  // SALE rate from the priced BOQ (po_items), resolved EXACTLY like the
  // Sales Bill: the line's po_item link first, then a description match
  // within the same order's BOQ. We deliberately DON'T require the indent
  // to have a planning→Business Book link — in practice most indents reach
  // their BOQ purely through indent_items.po_item_id (planning_id is often
  // unset), so keying off that link directly is what makes the numbers
  // appear. Delivery Bill = Billable × the order's Against-Delivery %.
  // Both fall back to 0 → UI shows "—" when the BOQ rate or % is missing.

  // Global po_item lookup: id → { rate, business_book }. One pass, reused
  // for every indent so we never query per line.
  const poItemById = new Map();
  for (const p of db.prepare('SELECT id, business_book_id, rate FROM po_items').all()) {
    poItemById.set(p.id, { rate: +p.rate || 0, bb: p.business_book_id });
  }
  // Lazy per-Business-Book description→rate map (the fallback the Sales
  // Bill uses when a line has no usable po_item rate) — only priced rows.
  const bbDescCache = new Map();
  const bbDescMap = (bbId) => {
    if (bbDescCache.has(bbId)) return bbDescCache.get(bbId);
    const m = new Map();
    for (const p of db.prepare('SELECT description, rate FROM po_items WHERE business_book_id=?').all(bbId)) {
      if (p.description && +p.rate > 0) m.set(String(p.description).toLowerCase().trim(), +p.rate || 0);
    }
    bbDescCache.set(bbId, m);
    return m;
  };
  // Lazy Business-Book against-delivery % (used when the planning join
  // didn't carry the term — e.g. the bb was inferred from a po_item).
  const bbPctCache = new Map();
  const bbPct = (bbId) => {
    if (bbPctCache.has(bbId)) return bbPctCache.get(bbId);
    const row = db.prepare('SELECT payment_against_delivery FROM business_book WHERE id=?').get(bbId);
    const pct = parseFloat(String((row && row.payment_against_delivery) || '').replace(/[^0-9.]/g, '')) || 0;
    bbPctCache.set(bbId, pct);
    return pct;
  };
  // Planning-derived Business Book + % per indent (primary, from the join).
  const planBbByIndent = new Map();
  const planPctByIndent = new Map();
  for (const i of indents) {
    if (i.business_book_id) planBbByIndent.set(i.id, i.business_book_id);
    planPctByIndent.set(i.id, parseFloat(String(i.bb_delivery_terms || '').replace(/[^0-9.]/g, '')) || 0);
  }
  // Indent site (name) — the most reliable bridge to the Order-to-Planning
  // order when neither a planning link nor a po_item link is present.
  const siteByIndent = new Map();
  for (const i of indents) siteByIndent.set(i.id, i.site_name || i.client_name || '');
  // site/project name → business_book_id, resolved the same way findBoq
  // links a site to its order (sites.business_book_id, else a project /
  // company name match on business_book). Cached per name.
  const bbIdBySiteCache = new Map();
  const bbIdForSite = (siteName) => {
    if (!siteName) return null;
    if (bbIdBySiteCache.has(siteName)) return bbIdBySiteCache.get(siteName);
    const row = db.prepare(
      `SELECT id FROM business_book
        WHERE id IN (SELECT DISTINCT business_book_id FROM sites
                      WHERE name = ? AND business_book_id IS NOT NULL)
           OR project_name = ? OR company_name = ?
        ORDER BY id DESC LIMIT 1`
    ).get(siteName, siteName, siteName);
    const id = row?.id || null;
    bbIdBySiteCache.set(siteName, id);
    return id;
  };
  const billableByIndent = new Map();
  const deliveryByIndent = new Map();
  const pctByIndent = new Map();
  for (const [indentId, its] of itemsByIndent) {
    // Resolve the order's Business Book (the Order-to-Planning order the
    // BOQ rate is picked from): planning link first, else the first line's
    // po_item link, else the indent's site → order mapping.
    let bbId = planBbByIndent.get(indentId) || null;
    if (!bbId) {
      for (const it of its) {
        const po = it.po_item_id != null ? poItemById.get(it.po_item_id) : null;
        if (po && po.bb) { bbId = po.bb; break; }
      }
    }
    if (!bbId) bbId = bbIdForSite(siteByIndent.get(indentId));
    const descMap = bbId ? bbDescMap(bbId) : null;
    let billable = 0;
    for (const it of its) {
      let rate = 0;
      // FOC = Free Of Cost, RGP = returnable — NOT billed to the client, so
      // their sale rate is 0 (mam 2026-06-24: "sale bill is wrong" — FOC lines
      // were wrongly inheriting the parent BOQ rate). Only PO lines bill.
      const t = String(it.item_type || '').toUpperCase();
      if (t !== 'FOC' && t !== 'RGP') {
        const po = it.po_item_id != null ? poItemById.get(it.po_item_id) : null;
        if (po && po.rate > 0) rate = po.rate;
        if (!rate && descMap) rate = descMap.get(String(it.description || '').toLowerCase().trim()) || 0;
      }
      // Attach the BOQ SALE rate + billable per line so the expanded indent
      // can show "indent vs sales bill per BOQ" for estimation (mam 2026-06-24).
      it.boq_sale_rate = +rate.toFixed(2);
      it.billable_line = +(rate * (+it.quantity || 0)).toFixed(2);
      billable += rate * (+it.quantity || 0);
    }
    // Against-delivery %: planning value first, else the resolved bb's.
    let pct = planPctByIndent.get(indentId) || 0;
    if (!pct && bbId) pct = bbPct(bbId);
    billableByIndent.set(indentId, billable);
    pctByIndent.set(indentId, pct);
    deliveryByIndent.set(indentId, pct > 0 ? billable * pct / 100 : 0);
  }

  // One BOQ-link lookup per unique site_name — cached in the loop so we
  // don't hit the DB once per indent when many share the same site.
  const boqCache = new Map();
  const findBoq = (siteName) => {
    if (!siteName) return null;
    if (boqCache.has(siteName)) return boqCache.get(siteName);
    const row = db.prepare(
      `SELECT po.boq_file_link
       FROM purchase_orders po
       WHERE po.boq_file_link IS NOT NULL AND po.boq_file_link != ''
         AND po.business_book_id IN (
           SELECT DISTINCT s.business_book_id FROM sites s
             WHERE s.name = ? AND s.business_book_id IS NOT NULL
           UNION
           SELECT id FROM business_book
             WHERE project_name = ? OR company_name = ?
         )
       ORDER BY po.created_at DESC LIMIT 1`
    ).get(siteName, siteName, siteName);
    const link = row?.boq_file_link || null;
    boqCache.set(siteName, link);
    return link;
  };

  // Names of the currently-designated L1 / L2 approvers — surfaced so the
  // UI can show "Awaiting Nitin Jain ji" on rows where nobody has acted
  // yet. Pulled once per request, not per row.
  const l1User = db.prepare("SELECT name FROM users WHERE approval_role='l1' AND active=1 LIMIT 1").get();
  const l2User = db.prepare("SELECT name FROM users WHERE approval_role='l2' AND active=1 LIMIT 1").get();
  const approverNames = {
    l1: l1User?.name || 'L1 approver',
    l2: l2User?.name || 'L2 approver',
  };

  res.json(indents.map(i => ({
    ...i,
    boq_file_link: findBoq(i.site_name || i.client_name),
    items: itemsByIndent.get(i.id) || [],
    budget_amount: +(budgetByIndent.get(i.id) || 0).toFixed(2),
    billable_amount: +(billableByIndent.get(i.id) || 0).toFixed(2),
    delivery_bill_amount: +(deliveryByIndent.get(i.id) || 0).toFixed(2),
    delivery_pct: pctByIndent.get(i.id) || 0,
    approver_names: approverNames,
  })));
});

// ─── Indent raising window (mam 2026-06-16) ──────────────────────────
// Indents may be raised ONLY on Saturday. For a mid-week emergency an
// admin flips a one-day override: app_settings.indent_emergency_date holds
// the IST date (YYYY-MM-DD) for which raising is open to everyone. It
// lapses on its own the next day — the stored date no longer equals today,
// so nobody can leave indents open forever. All dates computed in IST so
// the rule follows India's calendar regardless of server timezone.
function indentRaiseWindow(db) {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const todayStr = `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, '0')}-${String(ist.getDate()).padStart(2, '0')}`;
  const isSaturday = ist.getDay() === 6;
  const row = db.prepare("SELECT value FROM app_settings WHERE key='indent_emergency_date'").get();
  const emergencyDate = (row && row.value) || '';
  const emergencyActive = !!emergencyDate && emergencyDate === todayStr;
  return { todayStr, isSaturday, emergencyDate, emergencyActive, allowed: isSaturday || emergencyActive };
}

// Raise-window status — read by the Raise Indent screen to show whether
// indents are open today and to drive the admin emergency toggle.
router.get('/indent-raise-window', (req, res) => {
  res.json(indentRaiseWindow(getDb()));
});

// Admin-only: open ("enable") or close emergency raising for TODAY. Stores
// today's IST date so it auto-expires tomorrow.
router.put('/indent-raise-window', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only — only an admin can open emergency indent raising.' });
  const db = getDb();
  const win = indentRaiseWindow(db);
  const val = req.body && req.body.enable ? win.todayStr : '';
  const exists = db.prepare("SELECT 1 FROM app_settings WHERE key='indent_emergency_date'").get();
  if (exists) db.prepare("UPDATE app_settings SET value=?, updated_at=CURRENT_TIMESTAMP WHERE key='indent_emergency_date'").run(val);
  else db.prepare("INSERT INTO app_settings (key, value) VALUES ('indent_emergency_date', ?)").run(val);
  res.json(indentRaiseWindow(db));
});

router.post('/indents', (req, res) => {
  const db = getDb();
  const { planning_id, items, notes, site_name, raised_by_name, business_book_id, indent_category } = req.body;
  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'At least one item is required' });
  }
  // Day gate (mam 2026-06-16): indents only on Saturday, unless an admin
  // has opened today for an emergency. Applies to everyone (admin included
  // — the admin opens the day via the toggle, then raises).
  const win = indentRaiseWindow(db);
  if (!win.allowed) {
    return res.status(403).json({
      error: 'Indents can be raised only on Saturday. For a weekday emergency, ask an admin to enable emergency raising for today.',
      code: 'INDENT_DAY_BLOCKED',
    });
  }
  // ─── Indent Category (mam's spec 2026-05-26) ─────────────────────────
  // Validate and normalise the category. Default 'material' so any
  // pre-existing client that doesn't send the field keeps working.
  //   material           — BOQ PO + FOC rows (RGP excluded)
  //   rgp                — BOQ RGP rows only
  //   extra_schedule     — BOQ + Sub-Item required, qty cap dropped
  //   extra_non_schedule — No BOQ, Sub-Item from Item Master (PO+FOC only)
  //   rental             — No BOQ, Item Master + days + rate/day,
  //                         total rental MUST stay below qty × current_price
  const VALID_CATEGORIES = ['material', 'rgp', 'extra_schedule', 'extra_non_schedule', 'rental'];
  const category = VALID_CATEGORIES.includes(indent_category) ? indent_category : 'material';
  const isExtraSchedule    = category === 'extra_schedule';
  const isExtraNonSchedule = category === 'extra_non_schedule';
  const isRental           = category === 'rental';
  const isRgp              = category === 'rgp';
  // Master-price lookup reused by the rental block check. Returns
  // 0 if no rate has ever been recorded, which triggers a clear error
  // instead of silently letting the indent through.
  const getMasterPrice = db.prepare(`
    SELECT COALESCE(NULLIF(im.current_price, 0), (
      SELECT iph.rate FROM item_price_history iph
        WHERE iph.item_id = im.id ORDER BY iph.created_at DESC LIMIT 1
    ), 0) as price
    FROM item_master im WHERE im.id=?
  `);
  // Per-row validation. Two valid modes:
  //   1) BOQ-linked: BOTH po_item_id AND item_master_id are picked
  //      (the normal flow when the site has a Client PO BOQ uploaded)
  //   2) Manual:     it.manual === true OR it.description is non-empty
  //      (the fallback when the site has no BOQ yet or mam wants
  //       to enter a free-text item — same flow as the old code)
  // Quantity must always be > 0.
  //
  // Mam (2026-05-25): "po item can raise one and not above quantity from
  // boq and also add with foc and rgp items".  Adds a qty cap rule:
  //   - PO type items: indented qty + already-existing indented qty must
  //     NOT exceed the BOQ row's quantity (po_items.quantity).
  //   - FOC / RGP: no cap, unlimited (free-of-cost / returnable items
  //     don't consume BOQ quantity).
  //   - Multiple PO indents per BOQ are allowed AS LONG AS total stays
  //     within BOQ.  Mam's "raise one" was about not blowing past the
  //     BOQ cap, not preventing additional indents.
  const getPoItemQty = db.prepare('SELECT quantity FROM po_items WHERE id=?');
  const getIndentedSum = db.prepare(
    `SELECT COALESCE(SUM(ii.quantity), 0) as already
       FROM indent_items ii
       JOIN indents i ON ii.indent_id = i.id
      WHERE ii.po_item_id = ?
        AND COALESCE(ii.item_type, '') NOT IN ('FOC', 'RGP')
        AND i.status <> 'rejected'`
  );
  const getMasterType = db.prepare('SELECT type FROM item_master WHERE id=?');

  // PO sub-item rules per BOQ (mam 2026-05-25 + 2026-05-27 follow-up):
  //   - A BOQ row is EITHER a PO line (exactly ONE PO sub-item + optional
  //     FOC) OR a FOC-only line (no PO — free of cost, not billed to the
  //     client) (mam 2026-06-26 BOQ-level PO/FOC toggle). Max ONE PO either way.
  //   - A BOQ with neither PO nor FOC (untyped) is rejected — pick one.
  //   - Only applies to BOQ-linked categories (material + extra_schedule).
  //     Off-BOQ categories (rgp / extra_non_schedule / rental) skip this.
  if (!isRgp && !isExtraNonSchedule && !isRental) {
    const subItemsPerBoq = new Map(); // poId → { po: n, foc: n, rgp: n }
    for (const it of items) {
      const poId = Number.isInteger(+it.po_item_id) && +it.po_item_id > 0 ? +it.po_item_id : null;
      if (!poId) continue;  // manual entries don't have a BOQ link
      const t = String(it.item_type || '').toUpperCase();
      const bucket = subItemsPerBoq.get(poId) || { po: 0, foc: 0, rgp: 0 };
      if (t === 'PO')       bucket.po++;
      else if (t === 'FOC') bucket.foc++;
      else if (t === 'RGP') bucket.rgp++;
      subItemsPerBoq.set(poId, bucket);
    }
    for (const [poId, b] of subItemsPerBoq) {
      if (b.po > 1) {
        return res.status(400).json({
          error: `Only ONE PO sub-item allowed per BOQ row.  BOQ #${poId} has ${b.po} PO lines — keep one and convert the others to FOC or RGP if they're not chargeable.`
        });
      }
      if (b.po === 0 && b.foc === 0) {
        return res.status(400).json({
          error: `BOQ #${poId} has no PO or FOC sub-item.  Choose PO (chargeable — needs a Vendor PO) or FOC (free of cost) for the sub-item.`
        });
      }
    }
  }

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const hasBoq = !!it.po_item_id;
    const hasSub = !!it.item_master_id;
    const isManual = it.manual === true || !!String(it.description || '').trim();
    const qtyOk = +it.quantity > 0;
    if (!qtyOk) return res.status(400).json({ error: `Row ${i + 1}: Quantity must be greater than 0` });

    // ─── Per-category validation (mam's spec 2026-05-26) ───
    // RGP joined the no-BOQ group on 2026-05-27: returnable material has no
    // Client PO BOQ counterpart; user picks straight from Item Master
    // (filtered to type='RGP' on the client).
    if (isRgp || isExtraNonSchedule || isRental) {
      // No BOQ link required. Sub-Item REQUIRED so the catalogue / pricing
      // trail is intact. No qty cap (these are by definition off-BOQ).
      const flowLabel = isRental ? 'Rental' : isRgp ? 'RGP' : 'Non-Schedule';
      if (!hasSub) return res.status(400).json({ error: `Row ${i + 1}: pick a Sub-Item (Item Master) — ${flowLabel} indents don't use BOQ` });

      // RGP enforces type=RGP on the picked Item Master (the client filters
      // the picker to RGP-only, but a tampered API call could still send a
      // non-RGP master_id — defense in depth).
      if (isRgp) {
        const mt = String(getMasterType.get(+it.item_master_id)?.type || '').toUpperCase();
        if (mt !== 'RGP') {
          return res.status(400).json({ error: `Row ${i + 1}: Item Master type must be RGP for an RGP indent (got '${mt || 'unknown'}')` });
        }
      }

      // Rental-only: days, rate/day, and the rent-vs-buy block check.
      if (isRental) {
        // Defense in depth (mam 2026-05-27): client filters Item Master
        // to type='RENTAL' but a tampered API call could still send a PO
        // master_id — block at the server too. Mirrors the RGP guard.
        const mt = String(getMasterType.get(+it.item_master_id)?.type || '').toUpperCase();
        if (mt !== 'RENTAL') {
          return res.status(400).json({ error: `Row ${i + 1}: Item Master type must be RENTAL for a Rental indent (got '${mt || 'unknown'}')` });
        }
        const days = +it.rental_days || 0;
        const ratePerDay = +it.rental_rate_per_day || 0;
        const qty = +it.quantity || 0;
        if (days <= 0) return res.status(400).json({ error: `Row ${i + 1}: Days must be greater than 0 for a rental` });
        if (ratePerDay <= 0) return res.status(400).json({ error: `Row ${i + 1}: Rate per day must be greater than 0 for a rental` });
        const totalRental = qty * days * ratePerDay;
        const masterPrice = +getMasterPrice.get(+it.item_master_id)?.price || 0;
        if (masterPrice <= 0) {
          return res.status(400).json({
            error: `Row ${i + 1}: Cannot validate rental cost — Item Master rate missing for this item. Set the master rate first.`
          });
        }
        const buyCost = qty * masterPrice;
        // Buy-vs-rent threshold — mam (2026-06-04 workflow chart):
        // "if higher on buying (2 times of tools) buy, otherwise rent".
        // Renting is allowed up to 2× the outright buy cost; only force a
        // purchase when the rental would cost MORE than twice buying.
        const RENT_LIMIT_MULTIPLE = 2;
        const buyThreshold = RENT_LIMIT_MULTIPLE * buyCost;
        if (totalRental >= buyThreshold) {
          return res.status(400).json({
            error: `Row ${i + 1}: Rental cost ₹${Math.round(totalRental).toLocaleString('en-IN')} ≥ ${RENT_LIMIT_MULTIPLE}× buying outright (₹${Math.round(buyThreshold).toLocaleString('en-IN')}). Buy instead of renting.`
          });
        }
      }
      continue; // Skip BOQ + qty-cap checks below for these three categories
    }

    // For Material and Extra-Schedule: BOQ row required (unless manual).
    // BOQ-qty cap applies to Material only; Extra-Schedule explicitly drops
    // the cap (that's the whole point of "extra qty beyond BOQ").
    if (hasBoq && hasSub && Number.isInteger(+it.po_item_id) && +it.po_item_id > 0 && !isExtraSchedule) {
      const masterType = String(it.item_type || getMasterType.get(+it.item_master_id)?.type || '').toUpperCase();
      // FOC and RGP are unlimited — skip cap check
      if (masterType !== 'FOC' && masterType !== 'RGP') {
        const boq = getPoItemQty.get(+it.po_item_id);
        const boqQty = +boq?.quantity || 0;
        if (boqQty > 0) {
          const already = +getIndentedSum.get(+it.po_item_id).already || 0;
          const thisLine = +it.quantity || 0;
          // Also include any OTHER lines in the same submission that
          // point at the same BOQ + are PO type (multi-row case)
          const sameBoqLines = items.filter((other, idx) =>
            idx !== i &&
            +other.po_item_id === +it.po_item_id &&
            String(other.item_type || '').toUpperCase() !== 'FOC' &&
            String(other.item_type || '').toUpperCase() !== 'RGP'
          ).reduce((s, x) => s + (+x.quantity || 0), 0);
          const total = already + thisLine + sameBoqLines;
          if (total > boqQty) {
            return res.status(400).json({
              error: `Row ${i + 1}: PO qty exceeds BOQ. BOQ has ${boqQty}, already indented ${already}, this submission adds ${thisLine + sameBoqLines}. Reduce qty, split into FOC/RGP, or use Extra Item · Schedule for over-BOQ qty.`
            });
          }
        }
      }
    }

    if (isManual) continue;                              // manual entry — skip BOQ/sub checks
    if (hasBoq && hasSub) continue;                      // BOQ-linked entry — both present, OK
    if (!hasBoq) return res.status(400).json({ error: `Row ${i + 1}: pick a BOQ Item (or type a description for manual entry)` });
    if (!hasSub) return res.status(400).json({ error: `Row ${i + 1}: pick a Sub-Item (Item Master)` });
  }
  const { nextSequence } = require('../db/nextSequence');
  const indentNum = nextSequence(db, 'indents', 'indent_number', 'IND-', { startFrom: 0, pad: 4 });
  // Resolve planning_id from business_book_id if one exists (for downstream
  // vendor-PO / GRN flows that key off planning rows).
  let resolvedPlanningId = planning_id || null;
  if (!resolvedPlanningId && business_book_id) {
    const plan = db.prepare('SELECT id FROM order_planning WHERE business_book_id=? ORDER BY id DESC LIMIT 1').get(business_book_id);
    if (plan) resolvedPlanningId = plan.id;
  }
  // status='submitted' (not 'draft') — mam's flow: every Raise Purchase Indent
  // submission goes straight to the approval queue, no draft state in between.
  // Approver then either Approves (→ 'approved') or Rejects (→ 'rejected') from
  // the indent list.
  //
  // 2-level approval policy (mam 2026-05-26): indents raised ON OR AFTER
  // 2026-05-25 go through L1 (Nitin Jain ji) then L2 (Nitin Sir). Older
  // indents stay on the legacy single-approval flow.
  //
  // Mam (2026-06-02): "in extra item crm will approv first indent after
  // then l1, l2" — Extra-Schedule / Extra-Non-Schedule indents are
  // CLIENT-BILLABLE so they route through CRM first (revenue gatekeeper)
  // before L1/L2 sign off on the spend.  Policy becomes 'crm_two_level'.
  // Material / RGP / Rental keep the existing two_level path.
  const TWO_LEVEL_CUTOFF = '2026-05-25';
  const today = new Date().toISOString().slice(0, 10);
  const isBillable = category === 'extra_schedule' || category === 'extra_non_schedule';
  const basePolicy = today >= TWO_LEVEL_CUTOFF ? 'two_level' : 'single';
  // RGP now follows the normal L1 → L2 chain like Material (mam 2026-06-06:
  // "rgp approval like as material l1,l2" — reverses the earlier hr_single).
  const policy = isBillable && basePolicy === 'two_level' ? 'crm_two_level' : basePolicy;
  const r = db.prepare(
    `INSERT INTO indents
       (planning_id, indent_number, status, notes, site_name, raised_by_name, client_name, created_by,
        approval_policy, l1_status, l2_status, indent_category, crm_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    resolvedPlanningId, indentNum, 'submitted',
    notes || '', site_name || '', raised_by_name || '', site_name || '', req.user.id,
    policy,
    // l1_status — pending for two_level / crm_two_level AND hr_single
    // (the single HR gate is tracked on l1_*).
    policy === 'two_level' || policy === 'crm_two_level' || policy === 'hr_single' ? 'pending' : null,
    // l2_status — only the two-level chains have an L2 stage; hr_single has none.
    policy === 'two_level' || policy === 'crm_two_level' ? 'pending' : null,
    category,
    policy === 'crm_two_level' ? 'pending' : 'n/a',
  );

  // Seed the indent_tracker with the approval_pending stage so the IndentFMS
  // pipeline view immediately reflects "this indent is waiting for approval".
  // The 'indent_raised' stage is implicit (any indent without a tracker entry
  // is considered at that stage), so we jump straight to approval_pending.
  try {
    db.prepare('INSERT INTO indent_tracker (indent_id, stage, updated_by, notes) VALUES (?,?,?,?)')
      .run(r.lastInsertRowid, 'approval_pending', req.user.id, 'Awaiting approval');
  } catch (e) { /* tracker is best-effort; never block indent creation */ }

  // Pull description/unit/type from item_master on the server so the
  // classification flags (PO / FOC / RGP) are authoritative and can't be
  // forged by the client. Vendor/make/rate are NOT captured at indent stage
  // — the purchase team sets them later via vendor-rates.
  // Indent items are now picked from the site BOQ (po_items). We look that
  // row up on the server to derive authoritative description/unit, and fall
  // back to item_master if the BOQ row was linked to the catalogue.
  const getPoItem = db.prepare('SELECT description, unit, quantity as boq_qty, item_master_id FROM po_items WHERE id=?');
  const getMaster = db.prepare('SELECT item_name, specification, size, uom, type, make, weight_per_meter FROM item_master WHERE id=?');
  const insertItem = db.prepare(
    `INSERT INTO indent_items
      (indent_id, po_item_id, item_master_id, description, make, quantity, unit, rate, amount,
       item_type, is_foc, is_tool, required_date,
       is_extra_schedule, is_extra_non_schedule, rental_days, rental_rate_per_day, weight_per_meter, unit_overridden)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const i of (items || [])) {
    let desc = i.description || '';
    let unit = i.unit || 'nos';
    // mam (2026-07-01): honour a unit the raiser deliberately changed on the
    // form. Extra-Non / RGP / Rental rows (no BOQ po_item) pre-fill the unit
    // from the Item-Master UOM, so a DIFFERENT sent unit = a real override
    // (e.g. MTR→KG) and is kept. BOQ lines stay master-authoritative as before.
    let unitWasOverridden = false;
    let itemType = null;
    let make = i.make || '';
    let masterId = i.item_master_id || null;
    let wpm = null;   // pipe kg/meter — snapshot from item_master for MTR→KG

    // Only integer po_item_ids correspond to real po_items rows. Strings like
    // 'fallback-Sheet2-3' come from the on-the-fly BOQ Excel parser and
    // should NOT be persisted (no FK exists for them).
    const poItemId = Number.isInteger(+i.po_item_id) && +i.po_item_id > 0 ? +i.po_item_id : null;
    if (poItemId) {
      const p = getPoItem.get(poItemId);
      if (p) {
        desc = p.description || desc;
        unit = p.unit || unit;
        if (!masterId && p.item_master_id) masterId = p.item_master_id;
      }
    }
    if (masterId) {
      const m = getMaster.get(masterId);
      if (m) {
        itemType = m.type || itemType;
        if (!make && m.make) make = m.make;
        // Item Master UOM is the authoritative unit (mam, 2026-05-16:
        // "automatic uom pick from itemwise master as per subitem").
        // Overrides whatever the BOQ row said because the master sheet
        // is the source of truth post-cleanup.
        if (m.uom) {
          const sent = String(i.unit || '').trim().toLowerCase();
          const masterU = String(m.uom).trim().toLowerCase();
          // Non-BOQ line (no po_item) whose sent unit differs from the master
          // UOM → the raiser deliberately changed it on the form → keep it.
          if (!poItemId && sent && sent !== 'nos' && sent !== masterU) { unit = sent; unitWasOverridden = true; }
          else unit = masterU;
        }
        if (m.weight_per_meter > 0) wpm = +m.weight_per_meter;
      }
    }

    const qty = +i.quantity || 0;
    // Keep legacy is_foc / is_tool in sync with the new item_type so older
    // reports still work.
    const foc = String(itemType || '').toUpperCase() === 'FOC' ? 1 : 0;
    const tool = String(itemType || '').toUpperCase() === 'RGP' ? 1 : 0;
    // Per-line category flags + rental fields (mam's spec 2026-05-26).
    // Stamped per-row so reports / downstream views can tell extras and
    // rentals apart without re-deriving from indents.indent_category.
    const extraSch = isExtraSchedule ? 1 : 0;
    const extraNon = isExtraNonSchedule ? 1 : 0;
    const rentDays = isRental ? (+i.rental_days || null) : null;
    const rentRate = isRental ? (+i.rental_rate_per_day || null) : null;
    insertItem.run(
      r.lastInsertRowid, poItemId, masterId, desc, make, qty, unit, 0, 0, itemType, foc, tool,
      i.required_date || null,
      extraSch, extraNon, rentDays, rentRate, wpm, unitWasOverridden ? 1 : 0,
    );
  }
  // CRM funnel "requirement" at RAISE time (mam 2026-06-06: "if extra
  // schedule also go in crm funnel and show requirement"). Extra-Schedule /
  // Extra-Non-Schedule indents are client-billable, so the moment they're
  // raised we drop a CRM funnel lead listing the requirement (items) + a
  // link back to the indent, so the sales team can start quoting before CRM
  // approval. On CRM approval the same entry is updated with the billable
  // amount. Deduped by a [auto-indent:<id>] marker. Best-effort.
  if (isBillable && policy === 'crm_two_level') {
    try {
      const { nextSequence } = require('../db/nextSequence');
      const reqItems = db.prepare('SELECT description, quantity, unit FROM indent_items WHERE indent_id=?').all(r.lastInsertRowid);
      const reqText = reqItems
        .map(it => `${(+it.quantity || 0).toLocaleString('en-IN')}${it.unit ? ' ' + it.unit : ''} × ${it.description || 'item'}`)
        .join('; ');
      let fi = db.prepare(
        `SELECT bb.company_name AS bb_company, bb.client_name AS bb_client,
                bb.client_contact AS bb_mobile,
                COALESCE(NULLIF(TRIM(bb.client_email),''), NULLIF(TRIM(bb.email_address),'')) AS bb_email,
                bb.billing_address AS bb_address, bb.source_of_enquiry AS bb_source,
                bb.state AS bb_state, bb.district AS bb_district, bb.owner AS bb_owner
           FROM order_planning op LEFT JOIN business_book bb ON bb.id = op.business_book_id
          WHERE op.id = ?`
      ).get(resolvedPlanningId) || {};
      // No project link (or thin data)? Match the Business Book by name.
      if (!fi.bb_mobile) fi = fillBbBlanks(fi, bbByName(db, site_name));
      // Auto-priced quotation total — ONLY for Extra-Schedule (its items come
      // from the BOQ, so previous rates exist). Extra-Non-Schedule is quoted
      // MANUALLY (mam 2026-06-06), so its amount is left blank.
      let quoteAmt = 0;
      if (category === 'extra_schedule') {
        try { quoteAmt = buildExtraQuotation(db, r.lastInsertRowid)?.supply_total || 0; } catch (_) {}
      }
      const marker = `[auto-indent:${r.lastInsertRowid}]`;
      const already = db.prepare('SELECT id FROM crm_funnel WHERE source_indent_id=? OR remarks LIKE ?')
        .get(r.lastInsertRowid, `%${marker}%`);
      if (!already) {
        // Prefer the Business Book client/company; fall back to the indent's
        // own site name only when there's no BB link.
        const clientName = String(fi.bb_client || fi.bb_company || site_name || 'Extra item').trim() || 'Extra item';
        const companyName = fi.bb_company || fi.bb_client || site_name || null;
        const funnelLeadNo = nextSequence(db, 'crm_funnel', 'lead_no', 'CRM-', { startFrom: 0, pad: 4 });
        db.prepare(
          `INSERT INTO crm_funnel
             (lead_no, client_name, company_name, mobile, email, source, address,
              state, district, remarks, category, type, lead_type, quotation_amount,
              requirement_items, source_indent_id, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          funnelLeadNo, clientName, companyName,
          fi.bb_mobile || null, fi.bb_email || null, fi.bb_source || 'Extra Indent', fi.bb_address || null,
          fi.bb_state || null, fi.bb_district || null,
          `Requirement from Extra indent ${indentNum} (awaiting CRM approval)`
            + (fi.bb_owner ? ` · owner ${fi.bb_owner}` : '') + ` ${marker}`,
          category, 'Extra Item', 'Extra Enquiry', quoteAmt,
          reqText || null, r.lastInsertRowid, req.user.id,
        );
      }
    } catch (e) { console.error('[indent] CRM funnel requirement-at-raise failed (indent saved anyway):', e.message); }
  }

  fireIndent(db, r.lastInsertRowid, 'indent.raised');
  res.status(201).json({ id: r.lastInsertRowid, indent_number: indentNum });
});

// PUT supports two modes:
//   1. Approve / reject — body has { status } only.
//   2. Full edit (mam: site engineers in training submit wrong indents,
//      should be able to fix instead of delete + re-create) — body has
//      items[] and the header fields. Allowed only while the indent is
//      still in 'submitted', 'draft' or 'rejected' state AND no active
//      Vendor PO has been created against it. Once approved or POed,
//      it's frozen.
router.put('/indents/:id', (req, res) => {
  const { status, items, site_name, raised_by_name, notes, reason, quantity_overrides, store_qty_per_item, unit_overrides, crm_margin_pct } = req.body;
  const db = getDb();
  const id = req.params.id;

  // Approve / reject path.
  if (status && !items) {
    // ─── 2-Level approval routing (mam 2026-05-26) ────────────────────
    // For indents with approval_policy='two_level', the flow is:
    //   submitted  --(L1 approve)-->  l1_approved  --(L2 approve)-->  approved
    //        \--(L1 reject)--> rejected      \--(L2 reject)--> rejected
    //
    // Guards on top of the existing separation-of-duties + reject-reason:
    //   - L1 actions require users.approval_role='l1' (or admin)
    //   - L2 actions require users.approval_role='l2' (or admin)
    //   - L2 cannot fire until L1 is approved (server-side sequence guard)
    //   - Same user cannot do BOTH levels of the same indent (no self-double-sign)
    //
    // Strategy: detect two_level state, do the per-level update, then either
    //   - L1 approve → set l1_*, flip status='l1_approved', return (don't fall through)
    //   - L2 approve → set l2_*, then FALL THROUGH to the existing approve
    //                  path so quantity_overrides + approved_by/at still apply
    //   - Reject at L1 or L2 → set l*_status='rejected', then FALL THROUGH
    //                  to the existing reject path so rejection_reason + the
    //                  legacy Approval-column display keep working.
    // Declared at handler scope so the later self-creator-check + legacy
    // approve path can also see it (re-approve skips those gates).
    let isReapprove = false;
    if (status === 'approved' || status === 'rejected') {
      const cur2 = db.prepare(
        `SELECT created_by, approval_policy, status, l1_status, l2_status, l1_by,
                crm_status, indent_category, planning_id
           FROM indents WHERE id=?`
      ).get(id);

      // ── Re-approve / Re-reject of a FINAL indent (mam 2026-06-04) ──
      // Allowed for ADMIN or the L2 approver (mam's MD).  Re-approve flips a
      // REJECTED indent back to approved (revoke the rejection) without
      // re-raising it; all approval levels are marked approved.
      const actorRow = db.prepare('SELECT role, approval_role FROM users WHERE id=?').get(req.user.id) || {};
      const isAdminActor = actorRow.role === 'admin' || req.user.role === 'admin';
      const canRevoke = isAdminActor || actorRow.approval_role === 'l2';
      // Re-approve fires for a REJECTED indent (revoke the rejection) OR an
      // already-APPROVED one (re-confirm — mam 2026-06-04 wanted it on
      // approved indents too).  mam (2026-06-04 follow-up): a re-approve can
      // ALSO edit order qty + from-store qty, so we mark all approval levels
      // approved here and then FALL THROUGH to the legacy approve path, which
      // applies quantity_overrides / store_qty_per_item and flips status.
      if (status === 'approved' && cur2 && (cur2.status === 'rejected' || cur2.status === 'approved' || cur2.status === 'po_sent')) {
        // po_sent included (mam 2026-06-23): admin/MD reopens a PO-sent indent
        // to issue items from store. Re-approve flips it back to 'approved'
        // and applies the from-store split; the already-sent vendor PO must be
        // reduced/cancelled separately for the store-issued qty.
        if (!canRevoke) return res.status(403).json({ error: 'Only an admin or the L2 approver (MD) can re-approve this indent.' });
        isReapprove = true;
        db.prepare(
          `UPDATE indents SET
               l1_status='approved', l1_at=COALESCE(l1_at, CURRENT_TIMESTAMP), l1_by=COALESCE(l1_by, ?),
               l2_status=CASE WHEN approval_policy IN ('two_level','crm_two_level') THEN 'approved' ELSE l2_status END,
               l2_at=CASE WHEN approval_policy IN ('two_level','crm_two_level') THEN COALESCE(l2_at, CURRENT_TIMESTAMP) ELSE l2_at END,
               l2_by=CASE WHEN approval_policy IN ('two_level','crm_two_level') THEN COALESCE(l2_by, ?) ELSE l2_by END,
               crm_status=CASE WHEN approval_policy='crm_two_level' THEN 'approved' ELSE crm_status END
           WHERE id=?`
        ).run(req.user.id, req.user.id, id);
        // do NOT return — fall through to the legacy approve path below.
      }
      // Re-reject: revoking an ALREADY-APPROVED indent is limited to admin or
      // the L2 approver (MD) — hard server gate, not just the hidden UI button.
      if (status === 'rejected' && cur2 && cur2.status === 'approved' && !canRevoke) {
        return res.status(403).json({ error: 'Only an admin or the L2 approver (MD) can revoke (re-reject) an already-approved indent.' });
      }

      if (!isReapprove && cur2 && (cur2.approval_policy === 'two_level' || cur2.approval_policy === 'crm_two_level')) {
        const actor = db.prepare('SELECT id, role, approval_role FROM users WHERE id=?').get(req.user.id) || req.user;
        const isAdminUser = actor.role === 'admin';
        const canActL1 = isAdminUser || actor.approval_role === 'l1';
        const canActL2 = isAdminUser || actor.approval_role === 'l2';
        // Mam (2026-06-02): "anyone with CRM module access" can approve
        // Extra indents at the CRM stage.  We check the runtime permission
        // via the same requirePermission helper used elsewhere — but
        // because middleware was already passed, we re-check here using
        // the cached user.permissions / module_permissions if available,
        // OR fall through to admin gate.  In practice the canApproveCrm
        // role is set on Aanchal + sales staff so they can sign off
        // billable indents.
        // Permissions live in role_permissions (joined via user_roles), not a
        // standalone user_permissions table.  Mam's rule is "anyone with CRM
        // module access" can sign off Extra indents at the CRM stage — and
        // "access" = can_view on the crm_funnel module (sales/CRM roles get
        // view; only admin gets edit/approve).  This MUST match the frontend
        // gate canView('crm_funnel') so the button and the API agree.
        // (Previous code queried a non-existent user_permissions table /
        // 'crm' module, which threw "no such table" AND blocked every
        // two-level L2 approval — mam 2026-06-03.)
        const crmPerm = db.prepare(
          `SELECT MAX(rp.can_view) AS can_view
             FROM role_permissions rp
             JOIN user_roles ur ON ur.role_id = rp.role_id
            WHERE ur.user_id = ? AND rp.module = 'crm_funnel'`
        ).get(actor.id) || {};
        // ALSO allow the CRM person actually ASSIGNED to this project on the
        // Client PO (purchase_orders.crm_name, e.g. "Sushila"/"Lovely") to
        // approve their own Extra indents even if their role lacks crm_funnel
        // access — mam 2026-06-03: "sushila is the PO's CRM but can't approve".
        // Match on name, case-insensitive, via planning_id → order_planning →
        // purchase_orders.
        const poCrm = db.prepare(
          `SELECT po.crm_name
             FROM indents i
             LEFT JOIN order_planning op ON op.id = i.planning_id
             LEFT JOIN purchase_orders po ON po.id = op.po_id
            WHERE i.id = ?`
        ).get(id);
        const actorName = String(
          db.prepare('SELECT name FROM users WHERE id=?').get(actor.id)?.name || req.user.name || ''
        ).trim().toLowerCase();
        // The PO dropdown stores a first name ("Sushila"); a user account may
        // be "Sushila Sharma".  Match if the names are equal OR the CRM name
        // appears as a whitespace token in the user's name (and vice-versa).
        const crmNameNorm = String(poCrm?.crm_name || '').trim().toLowerCase();
        const nameMatches = (a, b) =>
          a.length > 0 && b.length > 0 &&
          (a === b || a.split(/\s+/).includes(b) || b.split(/\s+/).includes(a));
        const isAssignedCrm = nameMatches(actorName, crmNameNorm);
        const canActCrm = isAdminUser || crmPerm.can_view === 1 || isAssignedCrm;

        // CRM stage — only for crm_two_level policy.  Must complete BEFORE
        // L1 can act.  When CRM approves, auto-INSERT a po_items row on
        // the linked Client PO so the billable line tracks in the project's
        // revenue pipeline.
        if (status === 'approved' && cur2.approval_policy === 'crm_two_level'
            && cur2.crm_status === 'pending') {
          if (!canActCrm) {
            const actorName = db.prepare('SELECT name FROM users WHERE id=?').get(actor.id)?.name || 'unknown';
            return res.status(403).json({
              error: `Extra-Schedule / Extra-Non-Schedule indents require CRM approval first. You're signed in as "${actorName}" — no CRM module access. Admin → User Management → grant CRM access.`,
            });
          }
          // Margin (mam 2026-06-10): CRM can add a client-quotation margin on
          // BOTH Extra-Schedule and Extra-Non-Schedule billable lines. (Was
          // Non-Schedule only — CRM couldn't price Extra-Schedule items.)
          const marginPct = ((cur2.indent_category === 'extra_non_schedule' || cur2.indent_category === 'extra_schedule') && +crm_margin_pct > 0)
            ? +crm_margin_pct : 0;
          // Resolve the linked Client PO via planning_id → order_planning → purchase_orders.
          // We add the Extra item as a new billable po_items row with item_type='extra'
          // so collections + DPR + Sales Bill rates auto-pick it up.
          let billablePoItemId = null;
          try {
            const indentRow = db.prepare(
              `SELECT i.planning_id, op.po_id
                 FROM indents i
                 LEFT JOIN order_planning op ON op.id = i.planning_id
                WHERE i.id = ?`
            ).get(id);
            const clientPoId = indentRow?.po_id || null;
            if (clientPoId) {
              // Sum the indent_items for this indent → total billable
              // amount.  Auto-line carries indent's total qty (or 1 if
              // multi-line) + the total amount as rate.  mam can refine
              // later via the Client PO BoQ editor.
              const items = db.prepare(
                `SELECT description, SUM(quantity) as qty, SUM(amount) as amount,
                        AVG(NULLIF(rate, 0)) as avg_rate, MIN(unit) as unit
                   FROM indent_items WHERE indent_id = ?`
              ).get(id);
              const totalAmt = +items?.amount || 0;
              const totalQty = +items?.qty || 1;
              // Extra-NON-Schedule adds margin on the client quotation;
              // Extra-Schedule bills at the BOQ rate (marginPct computed above).
              const baseRate = totalQty > 0 ? totalAmt / totalQty : totalAmt;
              const billRate = baseRate * (1 + marginPct / 100);
              const billAmt = billRate * totalQty;
              const ins = db.prepare(
                `INSERT INTO po_items (po_id, description, quantity, unit, rate, amount, item_type)
                 VALUES (?, ?, ?, ?, ?, ?, 'extra')`
              ).run(
                clientPoId,
                `[EXTRA · ${cur2.indent_category}${marginPct ? ` · +${marginPct}% margin` : ''}] from indent ${id}`,
                totalQty,
                items?.unit || 'nos',
                billRate,
                billAmt,
              );
              billablePoItemId = ins.lastInsertRowid;
            }
          } catch (e) {
            console.error('[crm-approve] auto-billable line failed (CRM approval saved anyway):', e.message);
          }
          // Mam (2026-06-03): "after crm approval indent go to crm funnel
          // automatically".  Create one CRM Sales Funnel entry per
          // CRM-approved Extra indent so the sales team tracks the billable
          // enquiry without re-keying.  A [auto-indent:<id>] marker in
          // remarks dedups in case the path is ever re-entered.
          try {
            let fi = db.prepare(
              `SELECT i.indent_number, i.client_name, i.site_name,
                      bb.company_name AS bb_company, bb.client_name AS bb_client,
                      bb.client_contact AS bb_mobile,
                      COALESCE(NULLIF(TRIM(bb.client_email),''), NULLIF(TRIM(bb.email_address),'')) AS bb_email,
                      bb.billing_address AS bb_address, bb.source_of_enquiry AS bb_source,
                      bb.state AS bb_state, bb.district AS bb_district, bb.owner AS bb_owner,
                      COALESCE((SELECT SUM(amount) FROM indent_items WHERE indent_id = i.id), 0) AS total_amt
                 FROM indents i
                 LEFT JOIN order_planning op ON op.id = i.planning_id
                 LEFT JOIN business_book bb ON bb.id = op.business_book_id
                WHERE i.id = ?`
            ).get(id);
            // No project link (or thin data)? Match the Business Book by name.
            if (fi && !fi.bb_mobile) fi = fillBbBlanks(fi, bbByName(db, fi.site_name || fi.client_name));
            const marker = `[auto-indent:${id}]`;
            // The requirement entry was already created when the indent was
            // raised (mam 2026-06-06).  On CRM approval, UPDATE it with the
            // now-known billable amount instead of creating a duplicate.
            const already = db.prepare(
              `SELECT id FROM crm_funnel WHERE source_indent_id=? OR remarks LIKE ?`
            ).get(id, `%${marker}%`);
            // Prefer the Business Book client/company; site name is the fallback.
            const clientName = String(
              fi?.bb_client || fi?.bb_company || fi?.client_name || fi?.site_name || 'Extra item'
            ).trim() || 'Extra item';
            // Auto-priced quotation total — ONLY Extra-Schedule (BOQ-priced).
            // Extra-Non-Schedule is quoted manually, so its amount stays blank.
            let quoteAmt = 0;
            if (cur2.indent_category === 'extra_schedule') {
              try { quoteAmt = buildExtraQuotation(db, id)?.supply_total || 0; } catch (_) {}
              if (!quoteAmt) quoteAmt = +fi?.total_amt || 0;
            }
            if (already) {
              db.prepare(
                `UPDATE crm_funnel
                    SET quotation_amount = ?,
                        remarks = REPLACE(remarks, '(awaiting CRM approval)', '(CRM approved)'),
                        updated_at = CURRENT_TIMESTAMP
                  WHERE id = ?`
              ).run(quoteAmt, already.id);
            } else {
              const reqItems = db.prepare('SELECT description, quantity, unit FROM indent_items WHERE indent_id=?').all(id);
              const reqText = reqItems
                .map(it => `${(+it.quantity || 0).toLocaleString('en-IN')}${it.unit ? ' ' + it.unit : ''} × ${it.description || 'item'}`)
                .join('; ');
              const funnelLeadNo = nextSequence(db, 'crm_funnel', 'lead_no', 'CRM-', { startFrom: 0, pad: 4 });
              db.prepare(
                `INSERT INTO crm_funnel
                   (lead_no, client_name, company_name, mobile, email, source, address,
                    state, district, remarks, category, type, lead_type, quotation_amount,
                    requirement_items, source_indent_id, created_by)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
              ).run(
                funnelLeadNo,
                clientName,
                fi?.bb_company || fi?.bb_client || fi?.site_name || null,
                fi?.bb_mobile || null, fi?.bb_email || null, fi?.bb_source || 'Extra Indent', fi?.bb_address || null,
                fi?.bb_state || null,
                fi?.bb_district || null,
                `Auto-created from Extra indent ${fi?.indent_number || id} on CRM approval`
                  + (fi?.bb_owner ? ` · owner ${fi.bb_owner}` : '') + ` ${marker}`,
                cur2.indent_category || null,
                'Extra Item',
                'Extra Enquiry',
                quoteAmt,
                reqText || null,
                id,
                actor.id,
              );
            }
          } catch (e) {
            console.error('[crm-approve] auto crm_funnel entry failed (CRM approval saved anyway):', e.message);
          }
          db.prepare(
            `UPDATE indents
               SET crm_status='approved',
                   crm_by=?,
                   crm_at=CURRENT_TIMESTAMP,
                   crm_billable_po_item_id=?,
                   crm_margin_pct=?,
                   status='crm_approved'
             WHERE id=?`
          ).run(actor.id, billablePoItemId, marginPct, id);
          fireIndent(db, id, 'indent.crm_approved', { crm_by: actor.name || actor.email || '' });
          return res.json({
            message: 'CRM approved — awaiting L1 sign-off',
            stage: 'crm_done',
            billable_po_item_id: billablePoItemId,
          });
        }
        // Once CRM is approved the row is in status='crm_approved' AND
        // crm_status='approved'.  L1 acts next — treat it the same as
        // the two_level path's "submitted → l1_approved" branch.
        // We normalise status here so the existing L1 branch below
        // matches without duplication.
        const effectiveStatus = (cur2.approval_policy === 'crm_two_level' && cur2.status === 'crm_approved')
          ? 'submitted'  // L1 branch expects 'submitted' as its trigger
          : cur2.status;

        if (status === 'approved') {
          // Which level are we acting on? Drive off the current status.
          // For crm_two_level we mapped crm_approved → submitted above so
          // the L1 branch reuses without changes.
          if (effectiveStatus === 'submitted' && cur2.l1_status === 'pending'
              && (cur2.approval_policy !== 'crm_two_level' || cur2.crm_status === 'approved')) {
            // L1 approve — gate by role, then write l1_* and flip status='l1_approved'.
            if (!canActL1) {
              // Surface WHO is blocked and WHY so admin can fix it from
              // User Management without SSHing into the box (mam 2026-05-28).
              const actorName = db.prepare('SELECT name FROM users WHERE id=?').get(actor.id)?.name || 'unknown';
              return res.status(403).json({
                error: `Not authorised for L1 approval. You're signed in as "${actorName}" (approval_role=${actor.approval_role || 'none'}). Admin → User Management → edit your user → set Indent Approval Role = L1.`,
              });
            }
            db.prepare(
              `UPDATE indents SET l1_status='approved', l1_by=?, l1_at=CURRENT_TIMESTAMP,
                                  status='l1_approved'
                 WHERE id=?`
            ).run(actor.id, id);
            fireIndent(db, id, 'indent.l1_approved', { l1_by: actor.name || actor.email || '' });
            return res.json({ message: 'L1 approved — awaiting L2 sign-off', stage: 'l1_done' });
          }
          if (cur2.status === 'l1_approved' && cur2.l2_status !== 'rejected') {
            // L2 approve — gate by role + sequence + self-double-sign block.
            // NOTE: l2_status may already be 'approved' here. The L2 sign-off
            // and the final status flip (in the approve transaction below) are
            // NOT atomic: if that transaction bounced on a validation error
            // (e.g. a store-issue qty check) AFTER l2_status was written, the
            // row gets stuck at status='l1_approved' + l2_status='approved'.
            // Accepting l2_status != 'rejected' (instead of == 'pending') makes
            // this branch idempotent so a retry self-heals the stuck row and
            // finally flips status='approved'. mam (2026-06-04).
            if (!canActL2) {
              const actorName = db.prepare('SELECT name FROM users WHERE id=?').get(actor.id)?.name || 'unknown';
              return res.status(403).json({
                error: `Not authorised for L2 approval. You're signed in as "${actorName}" (approval_role=${actor.approval_role || 'none'}). Admin → User Management → edit your user → set Indent Approval Role = L2.`,
              });
            }
            // Self-double-sign block keys off who did L1. On a recovery retry
            // l2_by is already set to the original L2 approver, so guard against
            // the L1 approver only. Admin is exempt — the super-user can sign
            // both levels (mam 2026-06-06: "admin do everything l1,l2").
            if (cur2.l1_by && cur2.l1_by === actor.id && !isAdminUser) {
              return res.status(400).json({ error: 'Same user cannot do both L1 and L2 — get a second pair of eyes' });
            }
            db.prepare(
              `UPDATE indents SET l2_status='approved', l2_by=?, l2_at=CURRENT_TIMESTAMP
                 WHERE id=?`
            ).run(actor.id, id);
            // Fall through to the existing approve path → it sets status='approved',
            // approved_by, approved_at, and applies quantity_overrides.
          } else if (cur2.status !== 'submitted' && cur2.status !== 'crm_approved') {
            // Trying to "approve" a row that isn't waiting for CRM / L1 / L2
            // (e.g. already approved, rejected, po_sent, or stuck in an exotic
            // state like l1_approved + l2_rejected). Reject the call so the
            // legacy approve path can't accidentally bulldoze a final state.
            // crm_approved is intentionally allowed-through so the L1 branch
            // (which keys on effectiveStatus='submitted') can fire next.
            return res.status(400).json({ error: `Cannot approve from status='${cur2.status}' (crm=${cur2.crm_status}, l1=${cur2.l1_status}, l2=${cur2.l2_status})` });
          }
        }

        if (status === 'rejected') {
          // Either L1 or L2 can reject. Validate the reject reason FIRST
          // (mirroring the legacy check below) so a bad-reason call can't
          // half-mutate l*_status before bouncing. THEN gate by role, THEN
          // tag the level, THEN fall through to the legacy reject path
          // (which writes rejection_reason + status='rejected').
          const reasonStr = String(reason || '').trim();
          if (reasonStr.length < 3) {
            return res.status(400).json({ error: 'Rejection reason is required (at least 3 characters).' });
          }
          if (cur2.l1_status === 'pending') {
            if (!canActL1) {
              return res.status(403).json({ error: 'Only the designated L1 approver (Nitin Jain ji) can reject L1' });
            }
            db.prepare('UPDATE indents SET l1_status=?, l1_by=?, l1_at=CURRENT_TIMESTAMP WHERE id=?')
              .run('rejected', actor.id, id);
          } else if (cur2.l2_status === 'pending' && cur2.l1_status === 'approved') {
            if (!canActL2) {
              return res.status(403).json({ error: 'Only the designated L2 approver (Nitin Sir) can reject L2' });
            }
            db.prepare('UPDATE indents SET l2_status=?, l2_by=?, l2_at=CURRENT_TIMESTAMP WHERE id=?')
              .run('rejected', actor.id, id);
          }
          // (No 'else' branch — admin Re-reject on an already-approved indent
          // skips the L1/L2 tagging entirely and falls straight through to
          // the legacy reject path, which is what mam wants.)
        }
      }

      // ── RGP single HR sign-off (mam 2026-06-04 chart) ──────────────
      // RGP indents (policy 'hr_single') need ONE approval from an
      // HR-role user — no L1/L2.  Gate by role here, record the sign-off
      // on l1_* for the audit trail, then fall through to the legacy
      // approve / reject path which finalises status + applies any qty
      // overrides / from-store issue.
      if (!isReapprove && cur2 && cur2.approval_policy === 'hr_single') {
        const actor = db.prepare('SELECT id, role, approval_role FROM users WHERE id=?').get(req.user.id) || req.user;
        const isAdminUser = actor.role === 'admin';
        const canActHr = isAdminUser || actor.approval_role === 'hr';
        const whoami = () => db.prepare('SELECT name FROM users WHERE id=?').get(actor.id)?.name || 'unknown';
        if (status === 'approved') {
          if (cur2.status !== 'submitted') {
            return res.status(400).json({ error: `Cannot approve from status='${cur2.status}'` });
          }
          if (!canActHr) {
            return res.status(403).json({
              error: `RGP indents need HR approval. You're signed in as "${whoami()}" (approval_role=${actor.approval_role || 'none'}). Admin → User Management → set Indent Approval Role = HR.`,
            });
          }
          db.prepare(`UPDATE indents SET l1_status='approved', l1_by=?, l1_at=CURRENT_TIMESTAMP WHERE id=?`).run(actor.id, id);
          // fall through → legacy approve path sets status='approved'
        }
        if (status === 'rejected') {
          const reasonStr = String(reason || '').trim();
          if (reasonStr.length < 3) {
            return res.status(400).json({ error: 'Rejection reason is required (at least 3 characters).' });
          }
          if (!canActHr) {
            return res.status(403).json({ error: `RGP indents need HR to reject. You're signed in as "${whoami()}".` });
          }
          db.prepare(`UPDATE indents SET l1_status='rejected', l1_by=?, l1_at=CURRENT_TIMESTAMP WHERE id=?`).run(actor.id, id);
          // fall through → legacy reject path writes rejection_reason + status
        }
      }
    }

    // Separation of duties — mam (2026-05-21): "how can if user fill
    // that indent how can he she approved and reject their indent".
    // Block the creator from approving / rejecting their own indent.
    // Site engineers / data-entry users can still flip status from
    // 'draft' → 'submitted' on their own row (that's the submit step,
    // not an approval).  Admin bypasses (handles corner cases where
    // mam herself raised an indent and needs to push it through).
    if ((status === 'approved' || status === 'rejected') && !isReapprove) {
      const cur = db.prepare('SELECT created_by FROM indents WHERE id=?').get(id);
      if (cur && cur.created_by === req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({
          error: 'You cannot approve or reject an indent you raised yourself. Ask another approver.',
        });
      }
    }

    // Reject path — mam (2026-05-25): "if reject then reason mandatory".
    // Enforce a non-empty reason (≥ 3 chars after trim).  Saved to
    // indents.rejection_reason + rejected_by + rejected_at for audit.
    if (status === 'rejected') {
      const r = String(reason || '').trim();
      if (r.length < 3) {
        return res.status(400).json({ error: 'Rejection reason is required (at least 3 characters).' });
      }
      db.prepare(
        `UPDATE indents
           SET status = 'rejected',
               approved_by = NULL,
               approved_at = NULL,
               rejected_by = ?,
               rejected_at = CURRENT_TIMESTAMP,
               rejection_reason = ?
         WHERE id = ?`
      ).run(req.user.id, r, id);
      fireIndent(db, id, 'indent.rejected', { rejected_by: req.user.name || '', reason: r });
      return res.json({ message: 'Rejected', reason: r });
    }

    // Approve path — mam (2026-05-25): "can edit qty at approval time".
    // quantity_overrides is an optional { indent_item_id: new_qty } map.
    // store_qty_per_item is an optional { indent_item_id: from_store_qty }
    // map — mam (2026-06-02): "if one item required 20 pc 5 in from
    // store approved and 15 new to buy how much we match".  When an
    // approver issues from existing office stock, we split the indent
    // line into:
    //   - parent row: source='procure', quantity = approved - from_store
    //   - child  row: source='store',   quantity = from_store
    // and atomically:
    //   - decrement stock_balance across office warehouses (FIFO by id)
    //   - log stock_movements OUT rows (reference_type='ISSUE')
    //   - create one stock_issue_notes header (SI/YYYY/####) that the
    //     storekeeper can print as a challan
    // Everything goes in ONE transaction with the approve flip so a
    // partial failure can't half-issue from stock.
    if (status === 'approved') {
      const overrides = quantity_overrides && typeof quantity_overrides === 'object' ? quantity_overrides : {};
      const storeQtys = store_qty_per_item && typeof store_qty_per_item === 'object' ? store_qty_per_item : {};
      const valid = [];
      for (const [k, v] of Object.entries(overrides)) {
        const itemId = +k;
        const qty = +v;
        if (!Number.isFinite(itemId) || itemId <= 0) continue;
        // qty 0 is allowed — the approver did NOT approve that line (mam
        // 2026-06-06: "L2 want enter approved qty 0"). Negative is invalid.
        if (!Number.isFinite(qty) || qty < 0) {
          return res.status(400).json({ error: `Quantity for item #${itemId} cannot be negative.` });
        }
        valid.push([itemId, qty]);
      }

      // ── Validate store-issue requests up front ────────────────────────
      // Each entry must reference an indent_item that:
      //   1. Belongs to THIS indent
      //   2. Has an item_master_id (manual entries cannot draw from stock)
      //   3. Has enough stock in office warehouses across SUM(stock_balance)
      // We compute the FINAL approved qty (post-override) to validate
      // from_store <= approved.
      const storePlans = [];   // [{ itemId, fromStore, finalQty, masterId, rate }]
      for (const [k, v] of Object.entries(storeQtys)) {
        const itemId = +k;
        const fromStore = +v;
        if (!Number.isFinite(itemId) || itemId <= 0) continue;
        if (!Number.isFinite(fromStore) || fromStore < 0) {
          return res.status(400).json({ error: `From-store quantity for item #${itemId} must be ≥ 0.` });
        }
        if (fromStore === 0) continue;
        const row = db.prepare(
          `SELECT ii.id, ii.indent_id, ii.item_master_id, ii.quantity, ii.unit, ii.rate,
                  COALESCE(NULLIF(TRIM(ii.description), ''), NULLIF(TRIM(im.item_name), ''),
                           NULLIF(TRIM(im.specification), '')) AS description,
                  im.specification AS specification, im.size AS size,
                  COALESCE(NULLIF(TRIM(ii.make), ''), NULLIF(TRIM(im.make), '')) AS make,
                  im.item_code AS item_code,
                  ii.item_type
             FROM indent_items ii
             LEFT JOIN item_master im ON im.id = ii.item_master_id
            WHERE ii.id = ?`
        ).get(itemId);
        if (!row || +row.indent_id !== +id) {
          return res.status(400).json({ error: `Item #${itemId} does not belong to this indent.` });
        }
        if (!row.item_master_id) {
          return res.status(400).json({ error: `Cannot issue from store: item "${row.description}" has no Item Master link.` });
        }
        // Final approved qty = override (if any) else current quantity
        const finalQty = valid.find(([id]) => id === itemId)?.[1] ?? +row.quantity;
        if (fromStore > finalQty) {
          return res.status(400).json({
            error: `From-store qty (${fromStore}) exceeds approved qty (${finalQty}) for "${row.description}".`,
          });
        }
        // From-store cannot exceed the recorded office stock (mam 2026-06-27:
        // "editable according to stock, not above" — reverses the 2026-06-23
        // over-stock allowance). Same office-stock source the approval modal shows.
        const officeStock = +((db.prepare(
          `SELECT COALESCE(SUM(sb.quantity),0) q FROM stock_balance sb
             JOIN warehouses w ON w.id = sb.warehouse_id AND COALESCE(w.active,1)=1 AND w.type='office'
            WHERE sb.item_master_id = ?`
        ).get(row.item_master_id) || {}).q || 0);
        if (fromStore > officeStock + 0.0001) {
          return res.status(400).json({
            error: `From-store qty (${fromStore}) exceeds office stock (${officeStock}) for "${row.description}". Correct the inventory or reduce the from-store qty.`,
          });
        }
        storePlans.push({ itemId, fromStore, finalQty, masterId: row.item_master_id, rate: +row.rate || 0,
          description: row.description, specification: row.specification, size: row.size,
          make: row.make, item_code: row.item_code, unit: row.unit, item_type: row.item_type });
      }

      try {
        let issueNoteId = null;
        let issueNoteNumber = null;
        let storeChallanId = null;   // auto delivery_notes challan for store issue
        let totalStoreQty = 0;
        let totalStoreValue = 0;

        const tx = db.transaction(() => {
          // 1. Apply non-split quantity overrides first.
          if (valid.length) {
            const upd = db.prepare('UPDATE indent_items SET quantity = ? WHERE id = ? AND indent_id = ?');
            for (const [itemId, qty] of valid) upd.run(qty, itemId, id);
          }

          // 1b. Apply per-line UNIT overrides (mam 2026-06-06: L2 fixes a wrong
          // Item-Master UOM at approval). { indent_item_id: 'KG' }.
          if (unit_overrides && typeof unit_overrides === 'object') {
            const updUnit = db.prepare('UPDATE indent_items SET unit = ?, unit_overridden = 1 WHERE id = ? AND indent_id = ?');
            for (const [k, v] of Object.entries(unit_overrides)) {
              const itemId = +k;
              const unit = String(v || '').trim().slice(0, 20);
              if (Number.isFinite(itemId) && itemId > 0 && unit) updUnit.run(unit, itemId, id);
            }
          }

          // 2. Execute each store-split: decrement stock, log movements,
          //    split or convert the indent_items row.
          if (storePlans.length) {
            // Generate SI number first (used as reference on movements).
            const yr = new Date().getFullYear();
            const lastNum = db.prepare(
              `SELECT note_number FROM stock_issue_notes
                WHERE note_number LIKE ?
                ORDER BY id DESC LIMIT 1`
            ).get(`SI/${yr}/%`);
            let seq = 1;
            if (lastNum && lastNum.note_number) {
              const m = lastNum.note_number.match(/(\d+)$/);
              if (m) seq = parseInt(m[1], 10) + 1;
            }
            issueNoteNumber = `SI/${yr}/${String(seq).padStart(4, '0')}`;

            // Pull the indent's destination site (for the note header).
            // indents has no site_id FK — only the free-text site_name — so
            // resolve the site by matching site_name → sites.name.
            const indentSite = db.prepare(
              `SELECT s.id as site_id FROM indents i
                 LEFT JOIN sites s ON LOWER(TRIM(s.name)) = LOWER(TRIM(i.site_name))
                WHERE i.id = ?`
            ).get(id) || {};

            // Insert placeholder header — totals updated at the end.
            const noteRes = db.prepare(
              `INSERT INTO stock_issue_notes
                  (note_number, indent_id, from_warehouse_id, to_site_id, total_qty, total_value, issued_by)
               VALUES (?, ?, NULL, ?, 0, 0, ?)`
            ).run(issueNoteNumber, id, indentSite.site_id || null, req.user.id);
            issueNoteId = noteRes.lastInsertRowid;

            // For each split:
            //   a. Greedy-decrement stock_balance across office warehouses (smallest id first)
            //   b. Write one stock_movements OUT row per warehouse touched
            //   c. Split indent_items: parent stays procure with remaining qty,
            //      child created with source='store' (or convert parent if 100% from store)
            const balRows = db.prepare(
              `SELECT sb.id, sb.warehouse_id, sb.quantity, sb.avg_rate
                 FROM stock_balance sb
                 JOIN warehouses w ON w.id = sb.warehouse_id AND COALESCE(w.active, 1) = 1
                WHERE sb.item_master_id = ? AND w.type='office' AND sb.quantity > 0
                ORDER BY sb.warehouse_id ASC`
            );
            const decBal = db.prepare('UPDATE stock_balance SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
            const insertMv = db.prepare(
              `INSERT INTO stock_movements
                  (warehouse_id, item_master_id, type, quantity, rate, total_value,
                   reference_type, reference_id, site_id, notes, created_by)
               VALUES (?, ?, 'OUT', ?, ?, ?, 'ISSUE', ?, ?, ?, ?)`
            );
            // Read the full parent row so the child can inherit columns.
            const getItem = db.prepare('SELECT * FROM indent_items WHERE id=?');
            const updateParent = db.prepare(
              `UPDATE indent_items SET quantity = ?, source = 'procure' WHERE id = ?`
            );
            const convertParent = db.prepare(
              `UPDATE indent_items
                  SET source = 'store',
                      stock_issue_note_id = ?
                WHERE id = ?`
            );
            const insertChild = db.prepare(
              `INSERT INTO indent_items
                  (indent_id, description, quantity, unit, rate, amount, vendor_id,
                   item_master_id, make, is_foc, is_tool, item_type, po_item_id,
                   required_date, source, parent_item_id, stock_issue_note_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'store', ?, ?)`
            );
            // The store child copies FK columns from the parent. If the parent
            // carries a STALE reference (e.g. po_item_id whose po_items row was
            // deleted when the Business Book order was re-saved), copying it into
            // a fresh INSERT fails the FK check and rolls back the whole approval
            // ("FOREIGN KEY constraint failed").  Null any dangling FK first.
            const fkCheck = {
              vendors: db.prepare('SELECT 1 FROM vendors WHERE id=?'),
              po_items: db.prepare('SELECT 1 FROM po_items WHERE id=?'),
              item_master: db.prepare('SELECT 1 FROM item_master WHERE id=?'),
            };
            const safeFk = (val, table) => (val != null && fkCheck[table].get(val)) ? val : null;
            // Default office warehouse to absorb any shortfall when recorded
            // stock is less than what's physically issued (mam 2026-06-23 —
            // inventory pending correction). Its balance is allowed to go
            // negative so the gap is visible for later reconciliation.
            const defaultOfficeWh = db.prepare(
              "SELECT id FROM warehouses WHERE type='office' AND COALESCE(active,1)=1 ORDER BY id ASC LIMIT 1"
            ).get()?.id || null;
            const getBalByWh = db.prepare('SELECT id FROM stock_balance WHERE item_master_id=? AND warehouse_id=?');
            const insertBalNeg = db.prepare('INSERT INTO stock_balance (warehouse_id, item_master_id, quantity, avg_rate) VALUES (?,?,?,?)');
            let lastWarehouseId = null;
            for (const plan of storePlans) {
              const bal = balRows.all(plan.masterId);
              let remaining = plan.fromStore;
              let valueOut = 0;
              for (const b of bal) {
                if (remaining <= 0) break;
                const take = Math.min(remaining, +b.quantity);
                if (take <= 0) continue;
                const rate = +b.avg_rate || plan.rate || 0;
                decBal.run(take, b.id);
                insertMv.run(
                  b.warehouse_id, plan.masterId, take, rate, take * rate,
                  issueNoteNumber, indentSite.site_id || null,
                  `Issued for indent #${id} (${issueNoteNumber})`,
                  req.user.id,
                );
                valueOut += take * rate;
                remaining -= take;
                lastWarehouseId = b.warehouse_id;
              }
              // Shortfall — recorded stock didn't cover the issued qty.
              // Issue it anyway against the default office store: record the
              // OUT movement and let that balance go negative so the item is
              // flagged to reconcile (mam 2026-06-23). Only abort if there is
              // no office warehouse at all to attach the movement to.
              if (remaining > 0.0001) {
                if (!defaultOfficeWh) {
                  throw new Error(`No office warehouse exists to issue "${plan.description}" from — create one in Inventory → Warehouses first.`);
                }
                const rate = plan.rate || 0;
                const existing = getBalByWh.get(plan.masterId, defaultOfficeWh);
                if (existing) decBal.run(remaining, existing.id);
                else insertBalNeg.run(defaultOfficeWh, plan.masterId, -remaining, rate);
                insertMv.run(
                  defaultOfficeWh, plan.masterId, remaining, rate, remaining * rate,
                  issueNoteNumber, indentSite.site_id || null,
                  `Issued for indent #${id} (${issueNoteNumber}) — over recorded stock; reconcile inventory`,
                  req.user.id,
                );
                valueOut += remaining * rate;
                lastWarehouseId = lastWarehouseId || defaultOfficeWh;
                remaining = 0;
              }
              totalStoreQty += plan.fromStore;
              totalStoreValue += valueOut;

              // Split or convert the indent_items row.
              const remainProcure = plan.finalQty - plan.fromStore;
              const parent = getItem.get(plan.itemId);
              if (remainProcure <= 0.0001) {
                // 100% from store — just flip the row's source.
                convertParent.run(issueNoteId, plan.itemId);
              } else {
                // Partial — shrink parent to remaining procure qty + add a
                // store child carrying the from-store qty.
                updateParent.run(remainProcure, plan.itemId);
                insertChild.run(
                  parent.indent_id, parent.description, plan.fromStore,
                  parent.unit, parent.rate, plan.fromStore * (+parent.rate || 0),
                  safeFk(parent.vendor_id, 'vendors'), safeFk(parent.item_master_id, 'item_master'), parent.make,
                  parent.is_foc, parent.is_tool, parent.item_type,
                  safeFk(parent.po_item_id, 'po_items'), parent.required_date,
                  parent.id, issueNoteId,
                );
              }
            }
            // Update the header with rollup + source warehouse (last used).
            db.prepare(
              `UPDATE stock_issue_notes
                  SET total_qty = ?, total_value = ?, from_warehouse_id = ?
                WHERE id = ?`
            ).run(totalStoreQty, totalStoreValue, lastWarehouseId, issueNoteId);

            // Auto DELIVERY CHALLAN for the store-issued material (mam
            // 2026-06-04): store material has no Vendor PO, so its challan
            // links to the indent + Stock Issue Note.  Appears in Dispatch
            // & Receiving for printing + (billable items) a Sales Bill.
            // sales_bill_pending=1 when any line is a billable PO item.
            const storeItems = storePlans.map(p => ({
              description: p.description, specification: p.specification || '', size: p.size || '',
              make: p.make || '', item_code: p.item_code || '',
              qty: p.fromStore, unit: p.unit || '',
              rate: +p.rate || 0, amount: p.fromStore * (+p.rate || 0),
              item_type: p.item_type || '',
            }));
            const billable = storePlans.some(p => String(p.item_type || '').toUpperCase() === 'PO');
            const today = new Date().toISOString().slice(0, 10);
            const chRes = db.prepare(
              `INSERT INTO delivery_notes
                 (vendor_po_id, indent_id, stock_issue_note_id, source, delivery_date,
                  document_type, document_number, status, sales_bill_pending, items_json, notes)
               VALUES (NULL, ?, ?, 'store', ?, 'challan', ?, 'pending', ?, ?, ?)`
            ).run(id, issueNoteId, today, issueNoteNumber, billable ? 1 : 0,
                  JSON.stringify(storeItems), 'Material issued from store');
            // Remember the challan id so the approval response can hand it
            // back and the approver can print the Store Issue Challan straight
            // from the approval step (mam 2026-06-23).
            storeChallanId = chRes.lastInsertRowid;

            // NOTE (mam 2026-06-06): we DON'T auto-cut the Sales Bill here
            // anymore.  For billable (PO) store items the challan is left
            // sales_bill_pending=1 (see INSERT above) so it surfaces in the
            // "Ready to Dispatch" sub-tab's "From-Store · Sales Bill pending"
            // card — mam creates the Sales Bill there herself via the
            // "Add Sales Bill" button (generate-sales-bill endpoint).  FOC/RGP
            // store items are not billable, so their challan is not pending.
          }

          // 3. Flip the indent to approved.
          db.prepare(
            `UPDATE indents
               SET status = 'approved',
                   approved_by = ?,
                   approved_at = CURRENT_TIMESTAMP,
                   rejected_by = NULL,
                   rejected_at = NULL,
                   rejection_reason = NULL
             WHERE id = ?`
          ).run(req.user.id, id);

          // 4. RGP gate-pass Delivery Challan (mam 2026-06-06: "rgp delivery
          // challan automatically generate, rec. also required"). RGP is
          // returnable material that goes to site and comes back — no purchase.
          // On approval, auto-create a Delivery Challan listing the RGP lines so
          // it appears in Dispatch & Receiving for the signed Mark-Received.
          // Not billable (sales_bill_pending=0). Guarded one-per-indent.
          try {
            const rgpRows = db.prepare(
              `SELECT ii.quantity AS qty, ii.unit, ii.item_master_id,
                      COALESCE(NULLIF(TRIM(ii.description), ''), NULLIF(TRIM(im.item_name), ''), 'Item') AS name,
                      im.size, im.specification, im.make, im.item_code
                 FROM indent_items ii
                 LEFT JOIN item_master im ON im.id = ii.item_master_id
                WHERE ii.indent_id=? AND UPPER(COALESCE(ii.item_type,''))='RGP'
                  AND COALESCE(ii.quantity,0) > 0 AND (ii.source IS NULL OR ii.source<>'store')`
            ).all(id);
            if (rgpRows.length) {
              const exists = db.prepare("SELECT id FROM delivery_notes WHERE indent_id=? AND source='rgp'").get(id);
              if (!exists) {
                const { nextSequence } = require('../db/nextSequence');
                const gpDate = new Date().toISOString().slice(0, 10);
                const gpNum = nextSequence(db, 'delivery_notes', 'document_number', `RGP/${new Date().getFullYear()}/`, { pad: 4 });
                const gpItems = rgpRows.map(r => ({
                  description: [r.name, r.size, r.specification].filter(Boolean).join(' / '),
                  qty: +r.qty || 0, unit: r.unit || '', rate: 0, amount: 0,
                  item_code: r.item_code || '', make: r.make || '', item_type: 'RGP',
                }));
                db.prepare(
                  `INSERT INTO delivery_notes
                     (vendor_po_id, indent_id, source, delivery_date, document_type,
                      document_number, status, sales_bill_pending, items_json, notes)
                   VALUES (NULL, ?, 'rgp', ?, 'challan', ?, 'pending', 0, ?, ?)`
                ).run(id, gpDate, gpNum, JSON.stringify(gpItems),
                      'RGP returnable gate pass — auto-generated on approval');

                // Deduct RGP material from office stock (mam 2026-06-06: "if
                // approved rgp from store then why not decrease"). Greedy across
                // active office warehouses; log a stock_movements OUT
                // (reference_type='RGP'). Best-effort, non-blocking — if an item
                // isn't tracked in inventory or is short, deduct what's there
                // and move on (never block the approval / go negative).
                const balRgp = db.prepare(
                  `SELECT sb.id, sb.warehouse_id, sb.quantity, sb.avg_rate
                     FROM stock_balance sb
                     JOIN warehouses w ON w.id = sb.warehouse_id AND COALESCE(w.active,1)=1
                    WHERE sb.item_master_id = ? AND w.type='office' AND sb.quantity > 0
                    ORDER BY sb.warehouse_id ASC`
                );
                const decRgp = db.prepare('UPDATE stock_balance SET quantity = quantity - ?, updated_at=CURRENT_TIMESTAMP WHERE id=?');
                const mvRgp = db.prepare(
                  `INSERT INTO stock_movements
                     (warehouse_id, item_master_id, type, quantity, rate, total_value,
                      reference_type, reference_id, notes, created_by)
                   VALUES (?, ?, 'OUT', ?, ?, ?, 'RGP', ?, ?, ?)`
                );
                for (const r of rgpRows) {
                  if (!r.item_master_id) continue;
                  let remaining = +r.qty || 0;
                  for (const b of balRgp.all(r.item_master_id)) {
                    if (remaining <= 0) break;
                    const take = Math.min(remaining, +b.quantity);
                    if (take <= 0) continue;
                    const rate = +b.avg_rate || 0;
                    decRgp.run(take, b.id);
                    mvRgp.run(b.warehouse_id, r.item_master_id, take, rate, take * rate,
                              gpNum, `RGP issued to site for indent #${id} (${gpNum})`, req.user.id);
                    remaining -= take;
                  }
                }
              }
            }
          } catch (e) { console.error('[approve] RGP challan/stock failed (approval saved anyway):', e.message); }
        });
        tx();

        fireIndent(db, id, 'indent.approved', { approved_by: req.user.name || '' });
        return res.json({
          message: 'Approved',
          qty_changes: valid.length,
          stock_issued: storePlans.length,
          stock_issue_note: issueNoteNumber,
          store_challan_id: storeChallanId,
          stock_qty: totalStoreQty,
        });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // Any other status flip (draft → submitted, etc.) — keep legacy behaviour.
    db.prepare('UPDATE indents SET status=?, approved_by=? WHERE id=?')
      .run(status, null, id);
    return res.json({ message: 'Updated' });
  }

  // Full edit path
  if (items) {
    const cur = db.prepare('SELECT status, indent_category FROM indents WHERE id=?').get(id);
    if (!cur) return res.status(404).json({ error: 'Indent not found' });
    if (cur.status === 'approved') {
      return res.status(400).json({ error: 'Cannot edit an approved indent' });
    }
    const vpoCount = db.prepare(
      'SELECT COUNT(*) as c FROM vendor_pos WHERE indent_id=? AND COALESCE(cancelled, 0) = 0'
    ).get(id).c;
    if (vpoCount > 0) {
      return res.status(400).json({ error: `Cannot edit — ${vpoCount} active Vendor PO(s) reference this indent` });
    }

    // Same per-row validation as POST — including PO qty cap (mam 2026-05-25).
    // On edit, exclude the CURRENT indent's own rows from the already-indented
    // sum so we don't double-count the lines we're about to replace.
    const getPoItemQtyEdit = db.prepare('SELECT quantity FROM po_items WHERE id=?');
    const getIndentedSumEdit = db.prepare(
      `SELECT COALESCE(SUM(ii.quantity), 0) as already
         FROM indent_items ii
         JOIN indents i ON ii.indent_id = i.id
        WHERE ii.po_item_id = ?
          AND i.id <> ?
          AND COALESCE(ii.item_type, '') NOT IN ('FOC', 'RGP')
          AND i.status <> 'rejected'`
    );
    const getMasterTypeEdit = db.prepare('SELECT type FROM item_master WHERE id=?');

    // PO sub-item rules per BOQ (Edit path).  Same rule as POST:
    //   exactly 1 PO sub-item per BOQ row, FOC/RGP can be multiple
    //   (mam 2026-05-25 + 2026-05-27 follow-up). Off-BOQ categories
    //   (rgp / extra_non_schedule / rental) skip this check.
    const editCat = String(cur.indent_category || 'material').toLowerCase();
    const editSkipBoqCheck = editCat === 'rgp' || editCat === 'extra_non_schedule' || editCat === 'rental';
    if (!editSkipBoqCheck) {
      const subItemsPerBoqEdit = new Map();
      for (const it of items) {
        const poId = Number.isInteger(+it.po_item_id) && +it.po_item_id > 0 ? +it.po_item_id : null;
        if (!poId) continue;
        const t = String(it.item_type || '').toUpperCase();
        const b = subItemsPerBoqEdit.get(poId) || { po: 0, foc: 0 };
        if (t === 'PO') b.po++;
        else if (t === 'FOC') b.foc++;
        subItemsPerBoqEdit.set(poId, b);
      }
      for (const [poId, b] of subItemsPerBoqEdit) {
        if (b.po > 1) {
          return res.status(400).json({
            error: `Only ONE PO sub-item allowed per BOQ row.  BOQ #${poId} has ${b.po} PO lines — keep one and convert the others to FOC if they're not chargeable.`
          });
        }
        // A BOQ may be FOC-only (no PO) — free of cost, not billed (mam
        // 2026-06-26). Reject only when there is neither a PO nor a FOC line.
        if (b.po === 0 && b.foc === 0) {
          return res.status(400).json({
            error: `BOQ #${poId} has no PO or FOC sub-item.  Choose PO (chargeable) or FOC (free) for the sub-item.`
          });
        }
      }
    }

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const hasBoq = !!it.po_item_id;
      const hasSub = !!it.item_master_id;
      const isManual = it.manual === true || !!String(it.description || '').trim();
      const qtyOk = +it.quantity > 0;
      if (!qtyOk) return res.status(400).json({ error: `Row ${i + 1}: Quantity must be greater than 0` });

      // BOQ-qty cap for PO type (FOC/RGP unlimited)
      if (hasBoq && hasSub && Number.isInteger(+it.po_item_id) && +it.po_item_id > 0) {
        const masterType = String(it.item_type || getMasterTypeEdit.get(+it.item_master_id)?.type || '').toUpperCase();
        if (masterType !== 'FOC' && masterType !== 'RGP') {
          const boq = getPoItemQtyEdit.get(+it.po_item_id);
          const boqQty = +boq?.quantity || 0;
          if (boqQty > 0) {
            const already = +getIndentedSumEdit.get(+it.po_item_id, id).already || 0;
            const thisLine = +it.quantity || 0;
            const sameBoqLines = items.filter((other, idx) =>
              idx !== i &&
              +other.po_item_id === +it.po_item_id &&
              String(other.item_type || '').toUpperCase() !== 'FOC' &&
              String(other.item_type || '').toUpperCase() !== 'RGP'
            ).reduce((s, x) => s + (+x.quantity || 0), 0);
            const total = already + thisLine + sameBoqLines;
            if (total > boqQty) {
              return res.status(400).json({
                error: `Row ${i + 1}: PO qty exceeds BOQ. BOQ has ${boqQty}, already indented elsewhere ${already}, this indent adds ${thisLine + sameBoqLines}.`
              });
            }
          }
        }
      }

      if (isManual) continue;
      // RGP / Extra-Non-Schedule / Rental pick straight from Item Master — no
      // BOQ link required (mam 2026-06-06: editing an RGP indent wrongly
      // demanded a BOQ Item). editSkipBoqCheck was computed but not applied here.
      if (editSkipBoqCheck && hasSub) continue;
      if (hasBoq && hasSub) continue;
      if (!hasBoq) return res.status(400).json({ error: `Row ${i + 1}: pick a BOQ Item (or type a description for manual entry)` });
      if (!hasSub) return res.status(400).json({ error: `Row ${i + 1}: pick a Sub-Item (Item Master)` });
    }

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE indents SET site_name=?, raised_by_name=?, client_name=?, notes=?,
                            status = CASE WHEN status='rejected' THEN 'submitted' ELSE status END
         WHERE id=?`
      ).run(site_name || '', raised_by_name || '', site_name || '', notes || '', id);

      db.prepare('DELETE FROM indent_items WHERE indent_id=?').run(id);

      const getPoItem = db.prepare('SELECT description, unit, quantity as boq_qty, item_master_id FROM po_items WHERE id=?');
      const getMaster = db.prepare('SELECT item_name, specification, size, uom, type, make FROM item_master WHERE id=?');
      const insertItem = db.prepare(
        `INSERT INTO indent_items
          (indent_id, po_item_id, item_master_id, description, make, quantity, unit, rate, amount, item_type, is_foc, is_tool, required_date)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const i of items) {
        let desc = i.description || '';
        let unit = i.unit || 'nos';
        let itemType = null;
        let make = i.make || '';
        let masterId = i.item_master_id || null;

        const poItemId = Number.isInteger(+i.po_item_id) && +i.po_item_id > 0 ? +i.po_item_id : null;
        if (poItemId) {
          const p = getPoItem.get(poItemId);
          if (p) {
            desc = p.description || desc;
            // Respect the user's chosen unit on the line — that's the
            // whole point of the unit dropdown. Only fall back to the
            // BOQ's unit if the user didn't pick one.
            if (!i.unit) unit = p.unit || unit;
            if (!masterId && p.item_master_id) masterId = p.item_master_id;
          }
        }
        if (masterId) {
          const m = getMaster.get(masterId);
          if (m) {
            itemType = m.type || itemType;
            if (!make && m.make) make = m.make;
            // Item Master UOM wins (mam, 2026-05-16: "automatic uom
            // pick from itemwise master as per subitem").  Same rule
            // as POST handler — only override if the user explicitly
            // typed a different unit on this edit, else use master's.
            if (m.uom && !i.unit) unit = String(m.uom).toLowerCase();
          }
        }

        const qty = +i.quantity || 0;
        const foc = String(itemType || '').toUpperCase() === 'FOC' ? 1 : 0;
        const tool = String(itemType || '').toUpperCase() === 'RGP' ? 1 : 0;
        insertItem.run(id, poItemId, masterId, desc, make, qty, unit, 0, 0, itemType, foc, tool, i.required_date || null);
      }
    });
    try {
      tx();
      return res.json({ message: 'Indent updated' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Nothing to update' });
});

// POST /indents/:id/reset-store-issue — mam (2026-06-04): "by mistake i
// entered store qty 10, store had 1000 — on re-approve let me edit qty".
// Reverses ALL prior store issues on this indent so the approve modal can
// re-enter the From-Store / Procure split from scratch:
//   1. re-credit the issued qty back to stock (+ a reversing IN movement)
//   2. delete the Stock Issue Note(s)
//   3. merge each store child back into its parent line at full qty
//      (or flip a 100%-from-store line back to source='procure')
// Admin or L2 (MD) only — same gate as re-approve. Idempotent: a no-op
// when the indent has no store issues.
router.post('/indents/:id/reset-store-issue', (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const actorRow = db.prepare('SELECT role, approval_role FROM users WHERE id=?').get(req.user.id) || {};
  const canRevoke = actorRow.role === 'admin' || req.user.role === 'admin' || actorRow.approval_role === 'l2';
  if (!canRevoke) return res.status(403).json({ error: 'Only an admin or the L2 approver (MD) can reset a store issue.' });

  const children = db.prepare("SELECT * FROM indent_items WHERE indent_id=? AND source='store'").all(id);
  if (!children.length) return res.json({ message: 'No store issues to reset', reversed: 0, reversed_qty: 0 });

  let reversedQty = 0;
  try {
    const tx = db.transaction(() => {
      // 1. Reverse stock once per unique Stock Issue Note (avoid double-credit
      //    when several lines share the same note).
      const noteIds = [...new Set(children.map(c => c.stock_issue_note_id).filter(Boolean))];
      for (const noteId of noteIds) {
        const note = db.prepare('SELECT note_number FROM stock_issue_notes WHERE id=?').get(noteId);
        const noteNumber = note?.note_number;
        if (!noteNumber) continue;
        const movements = db.prepare(
          "SELECT warehouse_id, item_master_id, quantity, rate FROM stock_movements WHERE reference_type='ISSUE' AND reference_id=? AND type='OUT'"
        ).all(noteNumber);
        for (const mv of movements) {
          const cur = db.prepare('SELECT id FROM stock_balance WHERE warehouse_id=? AND item_master_id=?').get(mv.warehouse_id, mv.item_master_id);
          if (cur) db.prepare('UPDATE stock_balance SET quantity = quantity + ?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(+mv.quantity, cur.id);
          else db.prepare('INSERT INTO stock_balance (warehouse_id, item_master_id, quantity, avg_rate) VALUES (?,?,?,?)').run(mv.warehouse_id, mv.item_master_id, +mv.quantity, +mv.rate);
          db.prepare(
            `INSERT INTO stock_movements (warehouse_id, item_master_id, type, quantity, rate, total_value, reference_type, reference_id, notes, created_by)
             VALUES (?,?,'IN',?,?,?,'ISSUE_REVERSAL',?,?,?)`
          ).run(mv.warehouse_id, mv.item_master_id, +mv.quantity, +mv.rate, +mv.quantity * +mv.rate, noteNumber,
                `Reversed store issue ${noteNumber} — re-approve of indent #${id}`, req.user.id);
        }
      }
      // 2. Merge each store child back into its parent (or flip a converted
      //    100%-from-store line back to procure).  MUST run before deleting
      //    the notes — children reference stock_issue_note_id (FK).
      for (const ch of children) {
        if (ch.parent_item_id) {
          db.prepare('UPDATE indent_items SET quantity = quantity + ? WHERE id=?').run(+ch.quantity, ch.parent_item_id);
          db.prepare('DELETE FROM indent_items WHERE id=?').run(ch.id);
        } else {
          db.prepare("UPDATE indent_items SET source='procure', stock_issue_note_id=NULL WHERE id=?").run(ch.id);
        }
        reversedQty += +ch.quantity;
      }
      // 3. Now safe to delete the Stock Issue Note(s) — nothing references them.
      for (const noteId of noteIds) db.prepare('DELETE FROM stock_issue_notes WHERE id=?').run(noteId);
    });
    tx();
    res.json({ message: 'Store issue reset — qty returned to stock', reversed: children.length, reversed_qty: reversedQty });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /indents/:id — soft-reject when downstream records would be
// orphaned, hard-delete only when nothing references the indent.
// FK children of indents:
//   indent_items     → CASCADE in schema, automatic
//   vendor_pos       → no cascade, check + soft-reject if any active
//   grn              → no cascade, check + soft-reject if any (mam wouldn't
//                      want received-goods records cut loose from their indent)
//   indent_tracker   → audit-only, safe to delete alongside (mam 2026-05-25
//                      "73 indent approved but now admin is unable to delete"
//                      — the FK constraint failed BECAUSE of this table)
router.delete('/indents/:id', (req, res) => {
  const db = getDb();
  const id = req.params.id;

  // Block hard delete if active Vendor POs reference this indent.
  const vpoCount = db.prepare(
    'SELECT COUNT(*) as c FROM vendor_pos WHERE indent_id=? AND COALESCE(cancelled, 0) = 0'
  ).get(id).c;
  if (vpoCount > 0) {
    db.prepare("UPDATE indents SET status='rejected', rejected_by=?, rejected_at=CURRENT_TIMESTAMP, rejection_reason=COALESCE(rejection_reason, 'Auto-rejected on delete attempt') WHERE id=?")
      .run(req.user?.id || null, id);
    return res.json({ message: `Indent rejected (cannot hard-delete — ${vpoCount} active Vendor PO(s) reference it). Indent kept for audit.`, soft: true });
  }

  // Block hard delete if GRN rows reference this indent.
  const grnCount = db.prepare('SELECT COUNT(*) as c FROM grn WHERE indent_id=?').get(id).c;
  if (grnCount > 0) {
    db.prepare("UPDATE indents SET status='rejected', rejected_by=?, rejected_at=CURRENT_TIMESTAMP, rejection_reason=COALESCE(rejection_reason, 'Auto-rejected on delete attempt') WHERE id=?")
      .run(req.user?.id || null, id);
    return res.json({ message: `Indent rejected (cannot hard-delete — ${grnCount} GRN record(s) reference it). Indent kept for audit.`, soft: true });
  }

  // Safe to hard-delete.  Wrap in a tx so a mid-flight FK failure rolls
  // back the indent_items + indent_tracker cleanup instead of leaving
  // half-deleted state.
  try {
    const tx = db.transaction(() => {
      // indent_tracker has no CASCADE → delete explicitly to satisfy FK
      db.prepare('DELETE FROM indent_tracker WHERE indent_id=?').run(id);
      // indent_items DOES cascade but explicit is harmless + clearer
      db.prepare('DELETE FROM indent_items WHERE indent_id=?').run(id);
      db.prepare('DELETE FROM indents WHERE id=?').run(id);
    });
    tx();
    return res.json({ message: 'Deleted', soft: false });
  } catch (err) {
    // Last-ditch fallback: if some OTHER FK we don't know about fires,
    // fall back to soft-reject instead of returning a 500.  Mam's UI
    // gets the indent out of active queues either way.
    console.error('[indents/delete] FK fallback for indent', id, ':', err.message);
    db.prepare("UPDATE indents SET status='rejected', rejected_by=?, rejected_at=CURRENT_TIMESTAMP, rejection_reason=COALESCE(rejection_reason, 'Auto-rejected on delete attempt') WHERE id=?")
      .run(req.user?.id || null, id);
    return res.json({ message: `Indent rejected (delete blocked by downstream records: ${err.message.replace(/^SqliteError:\s*/, '')}). Indent kept for audit.`, soft: true });
  }
});

// Print-friendly payload for the indent — same shape mam uses on the
// indent page expanded view (BoQ description + sub-item from item
// master + make + qty + unit + type), plus site + raised-by info
// for the page header. Mam: 'where 19 items show able to download pdf'.
router.get('/indents/:id/print', (req, res) => {
  const db = getDb();
  const indent = db.prepare(`
    SELECT i.*, u.name as created_by_name
    FROM indents i LEFT JOIN users u ON i.created_by = u.id
    WHERE i.id = ?
  `).get(req.params.id);
  if (!indent) return res.status(404).json({ error: 'Indent not found' });
  const items = db.prepare(`
    SELECT ii.*,
           im.item_code, im.item_name as master_name, im.size as master_size, im.uom as master_uom,
           v.name as vendor_name,
           poi.description as boq_description
      FROM indent_items ii
      LEFT JOIN item_master im ON im.id = ii.item_master_id
      LEFT JOIN vendors v ON v.id = ii.vendor_id
      LEFT JOIN po_items poi ON poi.id = ii.po_item_id
     WHERE ii.indent_id = ?
     ORDER BY ii.id
  `).all(req.params.id);
  res.json({ indent, items });
});

router.get('/indents/:id', (req, res) => {
  const db = getDb();
  const indent = db.prepare(
    `SELECT i.*, u.name as created_by_name FROM indents i LEFT JOIN users u ON i.created_by=u.id WHERE i.id=?`
  ).get(req.params.id);
  if (!indent) return res.status(404).json({ error: 'Not found' });

  // Pull each line + the same budget rate resolution used in the list
  // endpoint (master → history fallback) so the Approve modal sees
  // consistent numbers.
  indent.items = db.prepare(
    `SELECT ii.*,
            v.name as vendor_name,
            im.item_code, im.item_name as master_name,
            im.specification as master_specification, im.size as master_size,
            -- Mam (2026-06-02): expose SI number on store-source rows so
            -- the approve modal + dispatch view can show "Issued SI/####".
            sin.note_number as stock_issue_number,
            sin.issued_at as stock_issued_at,
            COALESCE(
              NULLIF(im.current_price, 0),
              (SELECT iph.rate FROM item_price_history iph
                WHERE iph.item_id = ii.item_master_id
                ORDER BY iph.created_at DESC LIMIT 1),
              0
            ) as master_price,
            CASE
              WHEN COALESCE(im.current_price, 0) > 0 THEN 'master'
              WHEN (SELECT iph.rate FROM item_price_history iph
                     WHERE iph.item_id = ii.item_master_id
                     ORDER BY iph.created_at DESC LIMIT 1) > 0 THEN 'history'
              ELSE 'none'
            END as rate_source
     FROM indent_items ii
     LEFT JOIN vendors v ON ii.vendor_id = v.id
     LEFT JOIN item_master im ON ii.item_master_id = im.id
     LEFT JOIN stock_issue_notes sin ON sin.id = ii.stock_issue_note_id
     WHERE ii.indent_id = ?`
  ).all(req.params.id);

  // ── Stock visibility per line (mam 2026-05-25 follow-up) ──────────
  // "at approval time i need to show over office stock and stock at site".
  // For every line that's linked to item_master, sum stock_balance by
  // warehouse.type so the approver knows what's already on hand before
  // they sign off on more procurement.  Office stock = head office store,
  // Site stock = sum across all site_store warehouses (we don't filter to
  // *this* indent's site because mam wants total available across sites
  // — covers the "send from another site" case).
  const stockStmt = db.prepare(
    `SELECT w.type, COALESCE(SUM(sb.quantity), 0) as qty
       FROM stock_balance sb
       JOIN warehouses w ON w.id = sb.warehouse_id AND COALESCE(w.active, 1) = 1
      WHERE sb.item_master_id = ?
      GROUP BY w.type`
  );
  for (const it of indent.items) {
    if (!it.item_master_id) {
      it.office_stock = 0;
      it.site_stock = 0;
      continue;
    }
    const rows = stockStmt.all(it.item_master_id);
    let office = 0, site = 0;
    for (const r of rows) {
      if (r.type === 'office') office += +r.qty || 0;
      else if (r.type === 'site_store') site += +r.qty || 0;
    }
    it.office_stock = office;
    it.site_stock = site;
  }

  res.json(indent);
});

// Vendor PO
// GET returns the extra upload fields (po_date, file_path, remarks) too.
// GET /vendor-po list
// Mam (2026-05-16): "look at actual amount and 2. photo what show" —
// PO print page showed Rs 3,05,208 but the Follow-up: POs awaiting
// Purchase Bill table showed Rs 4,34,043 for the SAME PO.  Root
// cause: vendor_pos.total_amount can drift from the actual sum of
// line items (saved at create time; not auto-updated if items were
// edited).  The print page recomputes live from items + GST, so it's
// always right; the list endpoint was naively returning the stale
// header value.
//
// Fix: compute display_total live from vendor_po_items + 18% GST
// (matches the print logic).  Store side-by-side with the original
// total_amount so admins can see drift.  Frontend uses display_total
// for the Amount column.  Drift > ₹1 also surfaces in /audit later
// as its own exception type (TODO).
router.get('/vendor-po', (req, res) => {
  const db = getDb();
  // Mam (2026-05-20): "show here also indent number so that easily
  // can see".  Added LEFT JOIN indents so each row carries
  // indent_number + site_name for the Follow-up table.
  const rows = db.prepare(`
    SELECT vp.*, v.name as vendor_name,
           ind.indent_number, ind.site_name as indent_site_name,
           pcu.name as payment_cleared_by_name,
           l1u.name as po_l1_by_name, l2u.name as po_l2_by_name, rju.name as po_reject_by_name,
           COALESCE((
             SELECT ROUND(SUM(vpi.amount) * 1.18, 2)
             FROM vendor_po_items vpi
             WHERE vpi.vendor_po_id = vp.id
           ), vp.total_amount) as display_total
    FROM vendor_pos vp
    LEFT JOIN vendors v ON vp.vendor_id = v.id
    LEFT JOIN indents ind ON vp.indent_id = ind.id
    LEFT JOIN users pcu ON vp.payment_cleared_by = pcu.id
    LEFT JOIN users l1u ON vp.po_l1_by = l1u.id
    LEFT JOIN users l2u ON vp.po_l2_by = l2u.id
    LEFT JOIN users rju ON vp.po_reject_by = rju.id
    ORDER BY vp.created_at DESC
  `).all();
  // Who the PO is waiting on right now (for the list badge / approve gating).
  const PO_NEXT = { pending_l1: 'Nitin Jain', pending_l2: 'Ankur Kaplesh' };
  for (const r of rows) r.po_pending_approver = PO_NEXT[r.po_approval] || null;
  // Surface drift so the frontend can show a small warning chip if
  // the stored header total disagrees with the items sum.
  for (const r of rows) {
    const stored = +r.total_amount || 0;
    const live = +r.display_total || 0;
    r.total_amount_drift = Math.round(Math.abs(stored - live));
  }
  res.json(rows);
});

// Full Vendor PO payload for the print/share page — includes vendor
// contact details, indent info, and every line item with item_master
// fields (code, description, spec, make, uom). Used by /vendor-po/:id/print
// in the client to render a print-friendly PO that mam can save as PDF
// or share to vendor.
router.get('/vendor-po/:id/print', (req, res) => {
  const db = getDb();
  // vendor_pos has no created_by column (verified in schema), so the
  // print page falls back to "Authorized Signatory" when the creator
  // can't be looked up. Indent.created_by is available via the indent
  // join below if mam ever wants the raiser's name on the PO instead.
  // Mam (2026-05-16): the print page must auto-fill Vendor Code,
  // Contact Person, Contact No, and SEPL Lead No from existing
  // masters — NOT leave them blank.  Added v.vendor_code to the
  // SELECT; lead_no resolved via a separate BB lookup below
  // because indents store site_name as free text (no FK).
  const po = db.prepare(`
    SELECT vp.*, v.name as vendor_name, v.firm_name, v.vendor_code,
           v.contact_person,
           v.phone as vendor_phone, v.email as vendor_email,
           v.gst_number, v.address as vendor_address,
           v.district, v.state, v.payment_terms as vendor_payment_terms,
           v.credit_days as vendor_credit_days,
           i.indent_number, i.site_name, i.raised_by_name,
           cu.name as creator_name, cu.phone as creator_phone
      FROM vendor_pos vp
      LEFT JOIN vendors v ON vp.vendor_id = v.id
      LEFT JOIN indents i ON vp.indent_id = i.id
      LEFT JOIN users cu ON cu.id = i.created_by
     WHERE vp.id = ?
  `).get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Vendor PO not found' });

  // SEPL Lead No. lookup — match indent.site_name against the
  // business_book project_name (preferred) or company_name (fallback).
  // Case + whitespace insensitive so "M/s SAEL" matches " m/s sael ".
  // Takes the most recent match — older BB rows for the same site
  // share the lead_no anyway.
  if (po.site_name) {
    try {
      const bb = db.prepare(`
        SELECT lead_no, project_name, company_name, client_name,
               billing_address, shipping_address
        FROM business_book
        WHERE LOWER(TRIM(COALESCE(project_name, ''))) = LOWER(TRIM(?))
           OR LOWER(TRIM(COALESCE(company_name, ''))) = LOWER(TRIM(?))
        ORDER BY id DESC LIMIT 1
      `).get(po.site_name, po.site_name);
      if (bb) {
        po.sepl_lead_no = bb.lead_no || null;
        po.project_name_bb = bb.project_name || bb.company_name || null;
        po.client_name_bb = bb.client_name || null;
        // mam (2026-06-04): show the client's billing address (from
        // Business Book) on the PO Consignee block.  Falls back to the
        // shipping address when billing isn't filled.
        po.client_address_bb = bb.billing_address || bb.shipping_address || null;
      }
    } catch (_) { /* non-fatal */ }
  }

  // Site engineer + mobile — mam (2026-06-04): the indent's site
  // engineer and HIS number should appear on the PO so the vendor can
  // coordinate delivery.  raised_by_name is free text typed on the
  // indent form; match it to a User Management record (users.name) to
  // pull the phone.  When raised_by_name is blank or unmatched, fall
  // back to the indent's creator (indents.created_by) — the user who
  // actually filled the indent — for both the displayed name and phone.
  if (po.raised_by_name && /[a-zA-Z]/.test(String(po.raised_by_name))) {
    try {
      const u = db.prepare(`
        SELECT phone FROM users
        WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
          AND phone IS NOT NULL AND TRIM(phone) <> ''
        ORDER BY active DESC, id ASC LIMIT 1
      `).get(po.raised_by_name);
      if (u) po.raised_by_phone = u.phone;
    } catch (_) { /* non-fatal */ }
  }
  // Displayed engineer name: prefer the typed site-engineer name, else
  // the indent creator's name.
  po.site_engineer_name = (po.raised_by_name && /[a-zA-Z]/.test(String(po.raised_by_name)))
    ? po.raised_by_name
    : (po.creator_name || null);
  // Phone fallback: matched-by-name phone, else the creator's phone.
  if (!po.raised_by_phone) po.raised_by_phone = po.creator_phone || null;

  const items = db.prepare(`
    SELECT vpi.id, vpi.quantity, vpi.rate, vpi.amount, vpi.terms, vpi.credit_days,
           vpi.weight_per_meter, vpi.original_qty_mtr,
           ii.description, ii.make as ii_make, ii.unit, ii.required_date,
           ii.item_type,
           im.item_code, im.item_name as master_name, im.specification, im.size, im.uom, im.make as im_make,
           im.type as im_type,
           poi.description as boq_description,
           -- Mam (2026-05-21): "update here if i update rate in 3
           -- vendor".  Pull the LATEST finalised rate from the
           -- 3-vendor quote table.  Print page prefers this over the
           -- frozen vendor_po_items.rate so editing the rate later
           -- (in Vendor Rates step) is reflected on every fresh print.
           ir.final_rate as latest_rate,
           ir.final_vendor_name as latest_vendor,
           -- Payment terms negotiated at the Finalise-Rate step (mam
           -- 2026-06-04: "or may be enter in finalise rate").  Per-item;
           -- the print picks the first non-empty one for the PO header.
           ir.final_terms as final_terms,
           ir.final_credit_days as final_credit_days
      FROM vendor_po_items vpi
      LEFT JOIN indent_items ii ON ii.id = vpi.indent_item_id
      LEFT JOIN item_master im ON im.id = ii.item_master_id
      LEFT JOIN po_items poi ON poi.id = ii.po_item_id
      -- indent_item_rates has no UNIQUE(indent_item_id), so an item can carry
      -- more than one rate row — a plain join then DOUBLES every PO line
      -- (mam 2026-06-23: "in po double double item"). Join only the LATEST
      -- (max-id) rate row per item so each line prints exactly once.
      LEFT JOIN indent_item_rates ir
        ON ir.id = (SELECT MAX(ir2.id) FROM indent_item_rates ir2
                     WHERE ir2.indent_item_id = vpi.indent_item_id)
     WHERE vpi.vendor_po_id = ?
     ORDER BY vpi.id
  `).all(req.params.id);

  res.json({ po, items });
});

// ── Delivery Note data for a Vendor PO (mam 2026-05-22) ──────────
// Given a vendor_po id, returns ALL the data needed to render an
// SEPL Delivery Note: PO + vendor + indent + business_book client
// info + items.  Print-on-demand from the existing PO data — no
// delivery_notes table row required.  Client renders the template
// at /vendor-po/:id/delivery-note.
//
// Mam's spec — fields the DN template needs (extracted from
// SEPL_Delivery_Note_Template.pdf she shared):
//   Header meta:    DN No (auto-suggest), Date (today), SEPL PO No, Indent No
//   Client block:   Company name (M/s ...), Billing address, GSTIN
//   Site block:     Site name, Shipping address, Site engineer/contact
//   Items table:    SL · Description / Spec / Make · HSN · Qty · UOM · Remarks
//   Transport box:  Vehicle No · Driver Name & Mobile · LR/Challan No · Total Packages
//                   (these are filled in by HAND at dispatch time — left blank in print)
router.get('/vendor-po/:id/delivery-note-data', (req, res) => {
  const db = getDb();
  const data = db.prepare(`
    SELECT vp.id as po_id, vp.po_number, vp.po_date,
           v.name as vendor_name, v.gst_number as vendor_gstin,
           v.address as vendor_address, v.phone as vendor_phone,
           v.contact_person as vendor_contact,
           i.indent_number, i.site_name as indent_site_name,
           i.client_name as indent_client_name,
           i.raised_by_name as site_engineer_name,
           bb.company_name as client_company,
           bb.client_name as client_person_name,
           bb.client_contact as client_phone, bb.client_email,
           bb.billing_address as client_address,
           bb.shipping_address as site_address,
           bb.state as client_state, bb.district as client_district,
           bb.gstin as client_gstin, bb.state_code as client_state_code,
           bb.project_name as bb_project_name,
           bb.lead_no as bb_lead_no
      FROM vendor_pos vp
      LEFT JOIN vendors v ON vp.vendor_id = v.id
      LEFT JOIN indents i ON vp.indent_id = i.id
      LEFT JOIN order_planning op ON op.id = i.planning_id
      LEFT JOIN business_book bb ON bb.id = op.business_book_id
     WHERE vp.id = ?
  `).get(req.params.id);
  if (!data) return res.status(404).json({ error: 'Vendor PO not found' });

  // Fallback business_book lookup — mam (2026-05-25, DN-260526-VPO20260001):
  // "CLIENT/COMPANY NAME IS FROM BUSINESS BOOK ADDRESS BILLING TO AND
  // DELIVERY SITE SHIIPING TO".  The DN was blank because the indent had
  // planning_id = NULL → order_planning JOIN failed → business_book never
  // reached.  Try 3 fallback paths to recover the link:
  //   1. sites.business_book_id where sites.name = indent.site_name
  //   2. business_book where company_name = indent.site_name (or client_name)
  //   3. business_book where project_name = indent.site_name
  // First non-empty match wins.  Only fires when client_company is missing.
  // Fill client/site address + GSTIN from business_book. Fires when ANY of
  // company / GSTIN / address is missing — the primary JOIN can land on an
  // INCOMPLETE bb (company set but GSTIN/address blank) or fail entirely when
  // indent.planning_id is null, leaving the DN blank even though a complete bb
  // exists by name (mam 2026-06-30: "address, GSTIN missing"). Only fills the
  // gaps and prefers a bb that actually has a GSTIN / address.
  if ((!data.client_company || !data.client_gstin || !data.client_address) &&
      (data.indent_site_name || data.indent_client_name || data.client_company)) {
    const tryNames = [data.client_company, data.indent_site_name, data.indent_client_name].filter(Boolean);
    const findBb = db.prepare(`
      SELECT bb.company_name, bb.client_name, bb.client_contact, bb.client_email,
             bb.billing_address, bb.shipping_address, bb.state, bb.district,
             bb.gstin, bb.state_code, bb.project_name, bb.lead_no
        FROM business_book bb
       WHERE bb.id IN (
         SELECT DISTINCT s.business_book_id FROM sites s
          WHERE s.name = ? AND s.business_book_id IS NOT NULL
         UNION
         SELECT id FROM business_book
          WHERE company_name = ? OR project_name = ? OR client_name = ?
       )
       ORDER BY (CASE WHEN COALESCE(bb.gstin,'') <> '' THEN 1 ELSE 0 END) DESC,
                (CASE WHEN COALESCE(bb.billing_address,'') <> '' THEN 1 ELSE 0 END) DESC,
                bb.id DESC
       LIMIT 1
    `);
    for (const name of tryNames) {
      const bb = findBb.get(name, name, name, name);
      if (bb && bb.company_name) {
        data.client_company     = data.client_company     || bb.company_name;
        data.client_person_name = data.client_person_name || bb.client_name;
        data.client_phone       = data.client_phone       || bb.client_contact;
        data.client_email       = data.client_email       || bb.client_email;
        data.client_address     = data.client_address     || bb.billing_address;
        data.site_address       = data.site_address       || bb.shipping_address;
        data.client_state       = data.client_state       || bb.state;
        data.client_district    = data.client_district    || bb.district;
        data.client_gstin       = data.client_gstin       || bb.gstin;
        data.client_state_code  = data.client_state_code  || bb.state_code;
        data.bb_project_name    = data.bb_project_name    || bb.project_name;
        data.bb_lead_no         = data.bb_lead_no         || bb.lead_no;
        if (data.client_gstin && data.client_address) break;
      }
    }
  }

  // Items — only the columns the DN template shows.  Pull from
  // indent_items via vendor_po_items (the items actually purchased
  // under THIS PO, not the full indent).
  // HSN lives on po_items (Client PO line), not item_master — so we
  // join through indent_items.po_item_id to get it.  item_master only
  // has the gst % (e.g. "18%") which we use as a fallback.
  const items = db.prepare(`
    SELECT vpi.id, vpi.quantity,
           COALESCE(NULLIF(TRIM(im.item_name), ''), ii.description) as description,
           im.specification, im.size,
           COALESCE(im.make, ii.make) as make,
           CASE WHEN COALESCE(ii.unit_overridden, 0) = 1 AND TRIM(COALESCE(ii.unit, '')) <> ''
                  THEN ii.unit ELSE COALESCE(im.uom, ii.unit) END as uom,
           im.item_code,
           poi.hsn_code as hsn_code,
           im.gst as gst_text
      FROM vendor_po_items vpi
      LEFT JOIN indent_items ii ON ii.id = vpi.indent_item_id
      LEFT JOIN item_master im ON im.id = ii.item_master_id
      LEFT JOIN po_items poi ON poi.id = ii.po_item_id
     WHERE vpi.vendor_po_id = ?
     ORDER BY vpi.id
  `).all(req.params.id);

  // mam 2026-06-30: show the RECEIVED quantity (entered on the purchase bill, saved
  // onto the auto-created challan's items_json) instead of the full ordered qty.
  // Matched by vendor_po_item_id (exact). Lines with no received record keep the
  // ordered qty, so an un-received PO prints as before.
  const recvByVpi = {};
  for (const dn of db.prepare("SELECT items_json FROM delivery_notes WHERE vendor_po_id=? AND items_json IS NOT NULL").all(req.params.id)) {
    try {
      for (const x of (JSON.parse(dn.items_json) || [])) {
        if (x && x.vendor_po_item_id != null && x.received_qty != null) {
          recvByVpi[x.vendor_po_item_id] = (+x.received_qty || 0);
        }
      }
    } catch (_) { /* ignore malformed items_json */ }
  }
  if (Object.keys(recvByVpi).length) {
    for (const it of items) {
      if (Object.prototype.hasOwnProperty.call(recvByVpi, it.id)) it.quantity = recvByVpi[it.id];
    }
  }

  // Pre-compute a suggested DN number — mam can override on print
  // but most of the time today's date + PO number is enough.
  const today = new Date();
  const yy = String(today.getFullYear()).slice(2);
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  data.dn_number_suggested = `DN-${yy}${mm}${dd}-${data.po_number?.replace(/\W+/g, '') || data.po_id}`;

  res.json({ po: data, items });
});

// Items of a given indent, with finalized rate info and whether each item is
// already covered by a Vendor PO. Used to populate the item-checkbox grid in
// the Create Vendor PO modal.
router.get('/indents/:id/items-for-po', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT ii.id as indent_item_id, ii.description, ii.make, ii.quantity, ii.unit, ii.item_type,
            ii.item_master_id, ii.required_date,
            COALESCE(ii.weight_per_meter, im.weight_per_meter) as weight_per_meter,
            im.item_code, im.item_name as master_name, im.specification, im.size, im.uom,
            r.final_rate, r.final_vendor_name, r.final_terms, r.final_credit_days, r.status as rate_status,
            (SELECT COUNT(*) FROM vendor_po_items vpi
              JOIN vendor_pos vp_check ON vp_check.id = vpi.vendor_po_id
              WHERE vpi.indent_item_id = ii.id AND COALESCE(vp_check.cancelled, 0) = 0) as in_po_count,
            -- Quantity already placed on (non-cancelled) Vendor POs, so the
            -- modal can default to the PENDING qty (mam 2026-06-23).
            (SELECT COALESCE(SUM(vpi2.quantity), 0) FROM vendor_po_items vpi2
              JOIN vendor_pos vp_q ON vp_q.id = vpi2.vendor_po_id
              WHERE vpi2.indent_item_id = ii.id AND COALESCE(vp_q.cancelled, 0) = 0) as ordered_qty
     FROM indent_items ii
     -- Join only ONE rate row per item — the finalised (highest non-zero rate)
     -- one, else the latest — so a duplicate rate record can't double the line
     -- (mam 2026-06-23: "why this duplically").
     LEFT JOIN indent_item_rates r ON r.id = (
       SELECT r2.id FROM indent_item_rates r2
        WHERE r2.indent_item_id = ii.id
        -- Prefer the FINALISED rate row (mam 2026-07-02: a finalised item didn't
        -- flow to Vendor PO because a duplicate rate row with a higher final_rate
        -- was picked instead of the finalised one). Then highest rate, then latest.
        ORDER BY CASE WHEN r2.status = 'finalized' THEN 0 ELSE 1 END,
                 COALESCE(r2.final_rate, 0) DESC, r2.id DESC LIMIT 1
     )
     LEFT JOIN item_master im ON im.id = ii.item_master_id
     WHERE ii.indent_id = ?
       -- Exclude from-store lines — they're fulfilled from stock, not a PO.
       AND (ii.source IS NULL OR ii.source <> 'store')
       -- Lines the approver zeroed out (approved qty 0) aren't procured.
       AND COALESCE(ii.quantity, 0) > 0
     ORDER BY ii.id`
  ).all(req.params.id);
  res.json(rows);
});

// GET /procurement/indents/:id/billable-print — item-wise BILLABLE (sale)
// statement for an indent: each BOQ line at its sale rate × qty, with totals
// + GST, as a printable HTML page (Ctrl+P → PDF) for showing / auditing
// (mam 2026-06-24: "sales bill itemwise pdf so can show and audit easily").
router.get('/indents/:id/billable-print', (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const indent = db.prepare('SELECT * FROM indents WHERE id=?').get(id);
  if (!indent) return res.status(404).send('Indent not found');
  const items = db.prepare(`
    SELECT ii.id, ii.description, ii.quantity, ii.unit, ii.po_item_id, ii.item_type,
           im.item_code, im.item_name AS master_name, im.size, im.specification,
           poi.description AS boq_name, poi.quantity AS po_qty, poi.unit AS po_unit, poi.rate AS po_rate
      FROM indent_items ii
      LEFT JOIN item_master im ON im.id = ii.item_master_id
      LEFT JOIN po_items poi ON poi.id = ii.po_item_id
     WHERE ii.indent_id=? AND COALESCE(ii.quantity,0) > 0 ORDER BY ii.id`).all(id);
  // Resolve the order (business_book) the BOQ sale rate comes from: planning,
  // else a line's po_item, else the site name — exactly like the list's billable.
  let bbId = null;
  if (indent.planning_id) bbId = db.prepare('SELECT business_book_id FROM order_planning WHERE id=?').get(indent.planning_id)?.business_book_id || null;
  if (!bbId) for (const it of items) { if (it.po_item_id) { const p = db.prepare('SELECT business_book_id FROM po_items WHERE id=?').get(it.po_item_id); if (p && p.business_book_id) { bbId = p.business_book_id; break; } } }
  if (!bbId && indent.site_name) bbId = db.prepare(`SELECT id FROM business_book WHERE id IN (SELECT DISTINCT business_book_id FROM sites WHERE name=? AND business_book_id IS NOT NULL) OR project_name=? OR company_name=? ORDER BY id DESC LIMIT 1`).get(indent.site_name, indent.site_name, indent.site_name)?.id || null;
  const descMap = new Map();
  if (bbId) for (const p of db.prepare('SELECT description, rate FROM po_items WHERE business_book_id=?').all(bbId)) { if (p.description && +p.rate > 0) descMap.set(String(p.description).toLowerCase().trim(), +p.rate); }
  const poRate = (poid) => poid ? (+(db.prepare('SELECT rate FROM po_items WHERE id=?').get(poid) || {}).rate || 0) : 0;
  const bb = bbId ? db.prepare('SELECT company_name, client_name, billing_address, gstin, project_name FROM business_book WHERE id=?').get(bbId) : null;
  // Build one row per CLIENT BOQ line. Several indent sub-items (a PO item +
  // its FOC accessories) can map to the SAME po_item — the client is billed for
  // that BOQ line ONCE, so dedupe by po_item_id (mam 2026-06-24: "double not").
  // Non-BOQ-linked lines show individually; FOC/RGP among those stay free.
  // Bill on the INDENT qty (mam 2026-06-24: "according to indent") — NOT the
  // full client-BOQ po_items qty — so this statement matches the indent's own
  // Billable column. Sub-items that map to the SAME BOQ line (a PO line + its
  // accessories) collapse into one row, but ONLY the chargeable PO qty is
  // billed: every NON-PO sub-item under that BOQ line — FOC, RGP, or untyped
  // accessories (e.g. a CIVIL consumable) — rides FREE and adds 0 to the
  // billable quantity (mam 2026-06-25: "only pick PO item, not add FOC qty …
  // sales bill 6 qty is correct but u add 10 of FOC which is wrong"). The
  // qty/unit shown is the PO sub-item's.
  //
  // Pre-scan which BOQ lines actually HAVE a PO sub-item. Only those lines
  // switch to PO-only billing; a line with no PO sub-item at all keeps the
  // old "any non-FOC/RGP qty" rule so untyped standalone lines still bill.
  const poLineHasPO = new Set();
  for (const it of items) {
    if (it.po_item_id != null && String(it.item_type || '').toUpperCase() === 'PO') poLineHasPO.add(it.po_item_id);
  }
  let total = 0;
  const rows = [];
  const poRow = new Map();     // po_item_id → its row, to sum the chargeable qty
  let sn = 0;
  for (const it of items) {
    const t = String(it.item_type || '').toUpperCase();
    const isFree = (t === 'FOC' || t === 'RGP');
    // When this BOQ line has a PO sub-item, ONLY 'PO' sub-items are chargeable
    // (accessories of any other type bill 0). Otherwise fall back to the old
    // rule (anything not FOC/RGP bills its qty).
    const billQty = (it.po_item_id != null && poLineHasPO.has(it.po_item_id))
      ? (t === 'PO' ? (+it.quantity || 0) : 0)
      : (isFree ? 0 : (+it.quantity || 0));
    if (it.po_item_id != null) {
      const rate = +it.po_rate || 0;               // the BOQ line's sale rate
      if (poRow.has(it.po_item_id)) {
        const row = poRow.get(it.po_item_id);
        if (!isFree) {
          // First chargeable sub-item sets the billable unit/qty; later ones add.
          if (row.qty === 0) row.unit = it.po_unit || it.unit || row.unit;
          row.qty += billQty;
          row.amt = row.rate * row.qty;
        }
      } else {
        const desc = (it.boq_name && String(it.boq_name).trim())
          ? it.boq_name
          : [it.master_name || it.description, it.size, it.specification].filter(Boolean).join(' / ');
        const row = { sn: ++sn, code: it.item_code || '', desc, qty: billQty, poQty: (+it.po_qty || 0), unit: it.po_unit || it.unit || '', type: '', rate, amt: rate * billQty };
        poRow.set(it.po_item_id, row);
        rows.push(row);
      }
    } else {
      const desc = [it.master_name || it.description, it.size, it.specification].filter(Boolean).join(' / ');
      const rate = isFree ? 0 : (descMap.get(String(it.description || '').toLowerCase().trim()) || 0);
      rows.push({ sn: ++sn, code: it.item_code || '', desc, qty: (+it.quantity || 0), poQty: null, unit: it.unit || '', type: t, rate, amt: rate * (+it.quantity || 0) });
    }
  }
  total = rows.reduce((s, r) => s + (+r.amt || 0), 0);
  // Sales Bill BUDGET (mam 2026-06-26: "boq item = po qty * sales rate") — the
  // full-BOQ value: PO item qty × sale rate per line. For BOQ-linked rows that's
  // poQty × rate; non-BOQ lines (no poQty) fall back to their own billable amt.
  const budgetOf = (r) => (r.poQty != null ? (+r.poQty || 0) * (+r.rate || 0) : (+r.amt || 0));
  const budgetTotal = rows.reduce((s, r) => s + budgetOf(r), 0);
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inr = n => (+n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const gst = Math.round(total * 0.18);
  const gstBudget = Math.round(budgetTotal * 0.18);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Billable ${esc(indent.indent_number)}</title>
  <style>
    body{font-family:Arial,Helvetica,sans-serif;color:#222;margin:0;padding:24px;font-size:12px}
    .hdr{text-align:center;border-bottom:3px solid #1e40af;padding-bottom:8px;margin-bottom:10px}
    .hdr h1{margin:0;color:#1e40af;font-size:18px}
    .meta{display:flex;justify-content:space-between;font-size:11px;color:#555;margin:8px 0;flex-wrap:wrap;gap:6px}
    .box{border:1px solid #ddd;border-radius:6px;padding:8px 10px;margin:8px 0;font-size:11px}
    table{width:100%;border-collapse:collapse;margin-top:8px}
    th,td{border:1px solid #ccc;padding:6px 8px}
    th{background:#e8eefc;color:#1e40af;text-align:left;font-size:11px}
    td.r,th.r{text-align:right}
    tfoot td{font-weight:bold;background:#f4f7fe}
    .title{text-align:center;background:#1e40af;color:#fff;font-weight:bold;padding:6px;border-radius:4px;letter-spacing:1px;margin:6px 0}
    .pbtn{position:fixed;top:12px;right:12px;background:#1e40af;color:#fff;border:none;border-radius:4px;padding:8px 14px;cursor:pointer}
    @media print{.pbtn{display:none}}
  </style></head><body>
  <button class="pbtn" onclick="window.print()">🖨 Print / Save PDF</button>
  <div class="hdr"><h1>SECURED ENGINEERS PVT. LTD</h1><div style="font-size:11px">GSTIN: 03AASCS7836D2Z3 · PAN: AASCS7836D</div></div>
  <div class="title">BILLABLE STATEMENT (ITEM-WISE)</div>
  <div class="meta">
    <div><b>Indent No:</b> ${esc(indent.indent_number)}<br><b>Site / Project:</b> ${esc(indent.site_name || (bb && bb.project_name) || '—')}</div>
    <div><b>Date:</b> ${esc(String(indent.indent_date || indent.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10))}<br><b>Client:</b> ${esc((bb && (bb.company_name || bb.client_name)) || '—')}</div>
  </div>
  ${bb && bb.billing_address ? `<div class="box"><b>Client Address:</b> ${esc(bb.billing_address)}${bb.gstin ? ` &nbsp; <b>GSTIN:</b> ${esc(bb.gstin)}` : ''}</div>` : ''}
  <table>
    <thead><tr><th style="width:32px">SN</th><th>BOQ Description</th><th class="r" style="width:66px">PO Item Qty</th><th class="r" style="width:66px">Billable Qty</th><th style="width:50px">Unit</th><th class="r" style="width:90px">Sale Rate ₹</th><th class="r" style="width:110px">Budget ₹<br><span style="font-weight:400;font-size:9px;color:#9a6e12">PO qty × rate</span></th><th class="r" style="width:110px">Billable ₹</th></tr></thead>
    <tbody>
    ${rows.map(r => { const diff = r.poQty != null && +r.poQty !== +r.qty; const bud = budgetOf(r); return `<tr><td>${r.sn}</td><td>${r.code ? `<span style="color:#888;font-family:monospace">[${esc(r.code)}]</span> ` : ''}${esc(r.desc)}${(r.type === 'FOC' || r.type === 'RGP') ? ` <span style="color:#9a8;font-size:9px">(${r.type} — free)</span>` : ''}</td><td class="r">${r.poQty != null ? inr(r.poQty) : '—'}</td><td class="r"${diff ? ' style="color:#b00"' : ''}>${inr(r.qty)}</td><td>${esc(r.unit)}</td><td class="r">${r.rate > 0 ? inr(r.rate) : '—'}</td><td class="r" style="font-weight:600">${bud > 0 ? inr(bud) : '—'}</td><td class="r">${r.amt > 0 ? inr(r.amt) : '—'}</td></tr>`; }).join('')}
    </tbody>
    <tfoot>
      <tr><td colspan="6" class="r">Total (Sale value)</td><td class="r">₹ ${inr(budgetTotal)}</td><td class="r">₹ ${inr(total)}</td></tr>
      <tr><td colspan="6" class="r">GST @18%</td><td class="r">₹ ${inr(gstBudget)}</td><td class="r">₹ ${inr(gst)}</td></tr>
      <tr><td colspan="6" class="r">Grand Total (incl GST)</td><td class="r">₹ ${inr(budgetTotal + gstBudget)}</td><td class="r">₹ ${inr(total + gst)}</td></tr>
    </tfoot>
  </table>
  <p style="font-size:10px;color:#888;margin-top:10px"><b>PO Item Qty</b> = full client-BOQ quantity for the line (po_items). <b>Billable Qty</b> = chargeable indent qty actually billed (FOC / RGP / free accessories excluded) — shown in red when it differs from the PO item qty. <b>Budget ₹</b> = BOQ sale rate × PO item qty (full client-BOQ scope — the Sales Bill budget). <b>Billable ₹</b> = BOQ sale rate × billable qty. For internal estimation / audit — not a tax invoice.</p>
  </body></html>`;
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(Buffer.from(html, 'utf8'));
});

// GET /procurement/vendor-po/:id/budget-print — per-VENDOR-PO Sales Bill BUDGET
// statement (mam 2026-06-26: "according to sales bill make budget pdf"). Lists
// the lines actually on THIS Vendor PO (vendor_po_items), each at its BOQ SALE
// rate, so the total ties EXACTLY to the War Room "Sales Bill (budget)" for the
// row: Σ (vendor_po_items qty × po_items.rate) over PO-type lines. Unlike the
// indent billable statement, this is scoped to one Vendor PO, so an indent
// split across several POs prints one budget per PO (no whole-indent repeat).
router.get('/vendor-po/:id/budget-print', (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const vp = db.prepare(`
    SELECT vp.id, vp.po_number, vp.po_date, vp.created_at, vp.indent_id,
           i.planning_id, v.name AS vendor_name, i.indent_number, i.site_name, i.indent_date
      FROM vendor_pos vp
      LEFT JOIN vendors v ON v.id = vp.vendor_id
      LEFT JOIN indents i ON i.id = vp.indent_id
     WHERE vp.id=?`).get(id);
  if (!vp) return res.status(404).send('Vendor PO not found');

  const items = db.prepare(`
    SELECT vpi.id, vpi.quantity AS po_qty, ii.po_item_id, ii.item_type,
           ii.description AS ii_desc, ii.unit AS ii_unit,
           im.item_code, im.item_name AS master_name, im.size, im.specification,
           poi.description AS boq_name, poi.unit AS po_unit, poi.rate AS sale_rate,
           poi.business_book_id AS bb_id
      FROM vendor_po_items vpi
      JOIN indent_items ii ON ii.id = vpi.indent_item_id
      LEFT JOIN item_master im ON im.id = ii.item_master_id
      LEFT JOIN po_items poi   ON poi.id = ii.po_item_id
     WHERE vpi.vendor_po_id=?
     ORDER BY vpi.id`).all(id);

  // Resolve the client (business_book) for the header — planning, else a line's
  // po_item, else the indent site name (same chain as the indent statement).
  let bbId = null;
  if (vp.planning_id) bbId = db.prepare('SELECT business_book_id FROM order_planning WHERE id=?').get(vp.planning_id)?.business_book_id || null;
  if (!bbId) for (const it of items) { if (it.bb_id) { bbId = it.bb_id; break; } }
  if (!bbId && vp.site_name) bbId = db.prepare(`SELECT id FROM business_book WHERE id IN (SELECT DISTINCT business_book_id FROM sites WHERE name=? AND business_book_id IS NOT NULL) OR project_name=? OR company_name=? ORDER BY id DESC LIMIT 1`).get(vp.site_name, vp.site_name, vp.site_name)?.id || null;
  const bb = bbId ? db.prepare('SELECT company_name, client_name, billing_address, gstin, project_name FROM business_book WHERE id=?').get(bbId) : null;

  let sn = 0, total = 0;
  const rows = items.map(it => {
    // Only PO-type, BOQ-priced lines are billable to the client (FOC / non-PO
    // accessories ride free) — matches the War Room budget exactly.
    const chargeable = it.po_item_id != null && String(it.item_type || '').toUpperCase() === 'PO';
    const qty = +it.po_qty || 0;
    const rate = chargeable ? (+it.sale_rate || 0) : 0;
    const amt = qty * rate;
    total += amt;
    const t = String(it.item_type || '').toUpperCase();
    const desc = (it.boq_name && String(it.boq_name).trim())
      ? it.boq_name
      : [it.master_name || it.ii_desc, it.size, it.specification].filter(Boolean).join(' / ');
    return { sn: ++sn, code: it.item_code || '', desc, qty, unit: it.po_unit || it.ii_unit || '', rate, amt, free: !chargeable, type: t };
  });
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inr = n => (+n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const gst = Math.round(total * 0.18);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Budget ${esc(vp.po_number)}</title>
  <style>
    body{font-family:Arial,Helvetica,sans-serif;color:#222;margin:0;padding:24px;font-size:12px}
    .hdr{text-align:center;border-bottom:3px solid #1e40af;padding-bottom:8px;margin-bottom:10px}
    .hdr h1{margin:0;color:#1e40af;font-size:18px}
    .meta{display:flex;justify-content:space-between;font-size:11px;color:#555;margin:8px 0;flex-wrap:wrap;gap:6px}
    .box{border:1px solid #ddd;border-radius:6px;padding:8px 10px;margin:8px 0;font-size:11px}
    table{width:100%;border-collapse:collapse;margin-top:8px}
    th,td{border:1px solid #ccc;padding:6px 8px}
    th{background:#e8eefc;color:#1e40af;text-align:left;font-size:11px}
    td.r,th.r{text-align:right}
    tfoot td{font-weight:bold;background:#f4f7fe}
    .title{text-align:center;background:#1e40af;color:#fff;font-weight:bold;padding:6px;border-radius:4px;letter-spacing:1px;margin:6px 0}
    .pbtn{position:fixed;top:12px;right:12px;background:#1e40af;color:#fff;border:none;border-radius:4px;padding:8px 14px;cursor:pointer}
    @media print{.pbtn{display:none}}
  </style></head><body>
  <button class="pbtn" onclick="window.print()">🖨 Print / Save PDF</button>
  <div class="hdr"><h1>SECURED ENGINEERS PVT. LTD</h1><div style="font-size:11px">GSTIN: 03AASCS7836D2Z3 · PAN: AASCS7836D</div></div>
  <div class="title">SALES BILL BUDGET — VENDOR PO</div>
  <div class="meta">
    <div><b>Vendor PO:</b> ${esc(vp.po_number)}<br><b>Vendor:</b> ${esc(vp.vendor_name || '—')}<br><b>Indent No:</b> ${esc(vp.indent_number || '—')}</div>
    <div><b>Date:</b> ${esc(String(vp.po_date || vp.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10))}<br><b>Site / Project:</b> ${esc(vp.site_name || (bb && bb.project_name) || '—')}<br><b>Client:</b> ${esc((bb && (bb.company_name || bb.client_name)) || '—')}</div>
  </div>
  ${bb && bb.billing_address ? `<div class="box"><b>Client Address:</b> ${esc(bb.billing_address)}${bb.gstin ? ` &nbsp; <b>GSTIN:</b> ${esc(bb.gstin)}` : ''}</div>` : ''}
  <table>
    <thead><tr><th style="width:32px">SN</th><th>BOQ Description</th><th class="r" style="width:80px">PO Qty</th><th style="width:50px">Unit</th><th class="r" style="width:100px">Sale Rate ₹</th><th class="r" style="width:120px">Budget ₹<br><span style="font-weight:400;font-size:9px;color:#9a6e12">PO qty × sale rate</span></th></tr></thead>
    <tbody>
    ${rows.map(r => `<tr><td>${r.sn}</td><td>${r.code ? `<span style="color:#888;font-family:monospace">[${esc(r.code)}]</span> ` : ''}${esc(r.desc)}${r.free ? ` <span style="color:#9a8;font-size:9px">(${r.type || 'free'} — not billable)</span>` : ''}</td><td class="r">${inr(r.qty)}</td><td>${esc(r.unit)}</td><td class="r">${r.rate > 0 ? inr(r.rate) : '—'}</td><td class="r" style="font-weight:600">${r.amt > 0 ? inr(r.amt) : '—'}</td></tr>`).join('')}
    </tbody>
    <tfoot>
      <tr><td colspan="5" class="r">Sales Bill Budget</td><td class="r">₹ ${inr(total)}</td></tr>
      <tr><td colspan="5" class="r">GST @18%</td><td class="r">₹ ${inr(gst)}</td></tr>
      <tr><td colspan="5" class="r">Grand Total (incl GST)</td><td class="r">₹ ${inr(total + gst)}</td></tr>
    </tfoot>
  </table>
  <p style="font-size:10px;color:#888;margin-top:10px"><b>Budget ₹</b> = BOQ sale rate × this Vendor PO's item qty (PO-type lines only; FOC / non-PO accessories are not billable). This total matches the War Room "Sales Bill (budget)" for this Vendor PO. For internal estimation / audit — not a tax invoice.</p>
  </body></html>`;
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(Buffer.from(html, 'utf8'));
});

// Auto-quotation data for an Extra indent (mam 2026-06-06). Prices each
// chargeable line from the most-recent matching previous BOQ × indent qty.
// Rendered client-side at /quotation/:indentId/print in the SEPL format.
router.get('/indents/:id/quotation', (req, res) => {
  const data = buildExtraQuotation(getDb(), req.params.id);
  if (!data) return res.status(404).json({ error: 'Indent not found' });
  res.json(data);
});

// Indent items not yet covered by a Vendor PO — the 'pending for PO' list
// on top of the Vendor PO tab. Joins item_master so the Pending table can
// show item_code + full master name (mam's ask: 'no item of item master
// which I fill in indent').
router.get('/pending-po-items', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT ii.id as indent_item_id, ii.description, ii.make, ii.quantity, ii.unit, ii.item_type,
            ii.item_master_id, im.item_code, im.item_name as master_name, im.specification, im.size, im.uom,
            COALESCE(ii.weight_per_meter, im.weight_per_meter) as weight_per_meter,
            i.id as indent_id, i.indent_number, i.site_name, i.raised_by_name,
            r.final_rate, r.final_vendor_name, r.final_terms, r.final_credit_days, r.status as rate_status
     FROM indent_items ii
     JOIN indents i ON ii.indent_id = i.id
     -- One rate row per item, FINALISED first (mam 2026-07-02: a finalised item
     -- must reliably reach the Vendor PO step; a plain join both duplicated the
     -- line and could surface a non-finalised duplicate rate row).
     LEFT JOIN indent_item_rates r ON r.id = (
       SELECT r2.id FROM indent_item_rates r2
        WHERE r2.indent_item_id = ii.id
        ORDER BY CASE WHEN r2.status = 'finalized' THEN 0 ELSE 1 END,
                 COALESCE(r2.final_rate, 0) DESC, r2.id DESC LIMIT 1
     )
     LEFT JOIN item_master im ON im.id = ii.item_master_id
     WHERE NOT EXISTS (
       SELECT 1 FROM vendor_po_items vpi
         JOIN vendor_pos vp ON vp.id = vpi.vendor_po_id
        WHERE vpi.indent_item_id = ii.id
          AND COALESCE(vp.cancelled, 0) = 0
     )
       -- Exclude from-store lines — fulfilled from stock, not pending for PO.
       AND (ii.source IS NULL OR ii.source <> 'store')
       -- Lines the approver zeroed out (approved qty 0) aren't procured.
       AND COALESCE(ii.quantity, 0) > 0
     ORDER BY
       CASE WHEN r.status = 'finalized' THEN 0 ELSE 1 END,
       i.created_at DESC, ii.id`
  ).all();
  res.json(rows);
});

// Upload a Vendor PO that was created in Tally.
//
// This is a multipart/form-data endpoint — the client sends metadata fields
// plus an optional file (PDF / image / xlsx). Items linking back to indent
// lines are optional and come in as a JSON-stringified `items` field.
//
// Why a JSON string for items? multer parses the multipart body into
// req.body where each field is a string. Passing a nested array requires
// encoding it as JSON on the client and decoding here.
router.post('/vendor-po', needsApprove, vendorPoUpload.single('file'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const vendor_id = +b.vendor_id;
  const indent_id = b.indent_id ? +b.indent_id : null;
  if (!vendor_id) return res.status(400).json({ error: 'Vendor is required' });
  // PO file is now OPTIONAL — mam's flow: the PO is created in the ERP itself,
  // there's no Tally PDF to upload anymore. Users can still attach a file
  // (e.g. a signed scan once printed) but it's no longer required.

  // Parse optional line items (JSON string in multipart form)
  let items = [];
  if (b.items) {
    try { items = JSON.parse(b.items); } catch (e) { return res.status(400).json({ error: 'items must be valid JSON' }); }
  }
  const lines = Array.isArray(items) ? items.filter(i => i.indent_item_id && +i.quantity > 0 && +i.rate > 0) : [];

  // PO number is always auto-generated with a year-stamped pattern
  // VPO/YYYY/#### (e.g. VPO/2026/0001) — mam's "professional behaviour"
  // requirement. Any po_number sent by the client is ignored so we have
  // a single authoritative numbering source.
  const { nextSequence } = require('../db/nextSequence');
  const yr = new Date().getFullYear();
  const poNum = nextSequence(db, 'vendor_pos', 'po_number', `VPO/${yr}/`, { startFrom: 0, pad: 4 });

  // Freight terms + charge (mam 2026-06-12). 'Ex-Works' / 'FOR' instruct
  // who bears freight; freight_amount (₹) is a flat charge added to the PO
  // value (and prints as its own line on the PDF).
  const VALID_FREIGHT = ['Ex-Works', 'FOR'];
  const freight_terms = VALID_FREIGHT.includes(b.freight_terms) ? b.freight_terms : null;
  const freight_amount = +b.freight_amount > 0 ? Math.round(+b.freight_amount * 100) / 100 : 0;

  // Total: prefer what the user typed (matches the Tally printout). Fall back
  // to the computed sum of line items if blank.  Freight is always added on
  // top of either base so the stored total reflects the full PO value.
  const typedTotal = Number(b.total_amount);
  const computedTotal = lines.reduce((s, i) => s + (+i.quantity * +i.rate), 0);
  const baseTotal = Number.isFinite(typedTotal) && typedTotal > 0 ? typedTotal : computedTotal;
  const totalAmount = baseTotal + freight_amount;

  // Move uploaded file to a readable name so downloads show the original
  // filename, and save /uploads/<name> as the file_path.
  let filePath = null;
  if (req.file) {
    try {
      const safeName = (req.file.originalname || 'vendor-po').replace(/[^a-zA-Z0-9._-]/g, '_');
      const newName = `${Date.now()}-${safeName}`;
      const newPath = path.join(path.dirname(req.file.path), newName);
      fs.renameSync(req.file.path, newPath);
      filePath = `/uploads/${newName}`;
    } catch (e) {
      filePath = `/uploads/${req.file.filename}`;
    }
  }

  const po_date = b.po_date || null;
  const remarks = b.remarks || null;
  const expected_receipt_date = b.expected_receipt_date || null;

  // Vendor-facing Payment Terms entered on the Create PO modal (mam
  // 2026-06-04).  Printed on the PO.  credit_days is optional and only
  // meaningful for credit-type terms.
  const payment_terms = b.payment_terms ? String(b.payment_terms).trim().slice(0, 60) : null;
  const credit_days = (b.credit_days !== undefined && b.credit_days !== '' && +b.credit_days >= 0)
    ? Math.round(+b.credit_days) : null;

  // ─── Payment-before-material (INTERNAL ONLY — mam 2026-05-27) ───
  // Captures whether the vendor needs advance / wants old dues cleared
  // before shipping, or is fine to ship on credit. Never printed on the
  // vendor PO; surfaces only on the internal Vendor PO list/detail. NULL
  // when the user doesn't pick (= legacy/unset, not "no_advance").
  const VALID_BLOCK_TYPES = ['advance', 'old_payment_clear', 'no_advance'];
  const pmtType = VALID_BLOCK_TYPES.includes(b.payment_block_type) ? b.payment_block_type : null;
  const pmtAmount = (pmtType === 'advance' || pmtType === 'old_payment_clear') && +b.payment_block_amount > 0
    ? +b.payment_block_amount : null;
  const pmtNotes = b.payment_block_notes ? String(b.payment_block_notes).trim().slice(0, 500) : null;
  // Status auto-derives: 'no_advance' or NULL → 'na' (nothing to clear);
  // 'advance' or 'old_payment_clear' → 'pending' until Mark Cleared is hit.
  const pmtStatus = (pmtType === 'advance' || pmtType === 'old_payment_clear') ? 'pending' : 'na';

  try {
    const tx = db.transaction(() => {
      const r = db.prepare(
        `INSERT INTO vendor_pos
           (indent_id, vendor_id, po_number, total_amount, advance_required, po_date, file_path, remarks, expected_receipt_date,
            payment_block_type, payment_block_amount, payment_block_notes, payment_block_status,
            payment_terms, credit_days, freight_terms, freight_amount, po_approval)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_l1')`
      ).run(indent_id, vendor_id, poNum, Math.round(totalAmount * 100) / 100, po_date, filePath, remarks, expected_receipt_date,
            pmtType, pmtAmount, pmtNotes, pmtStatus,
            payment_terms, credit_days, freight_terms, freight_amount);
      const vpoId = r.lastInsertRowid;

      // Only write line items if the uploader chose to link indent lines.
      // Terms + credit_days are deliberately null — PO terms now live on the
      // uploaded Tally PO itself.
      const insItem = db.prepare(
        `INSERT INTO vendor_po_items (vendor_po_id, indent_item_id, quantity, rate, amount, terms, credit_days, weight_per_meter, original_qty_mtr)
         VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)`
      );
      for (const i of lines) {
        // For pipe lines the client sends quantity already in KG (mtr × kg/m),
        // rate in ₹/kg, plus weight_per_meter + original_qty_mtr for display.
        const wpm = +i.weight_per_meter > 0 ? +i.weight_per_meter : null;
        const mtr = +i.original_qty_mtr > 0 ? +i.original_qty_mtr : null;
        insItem.run(vpoId, i.indent_item_id, +i.quantity, +i.rate, +i.quantity * +i.rate, wpm, mtr);
      }
      if (indent_id) db.prepare('UPDATE indents SET status=? WHERE id=?').run('po_sent', indent_id);
      return vpoId;
    });
    const vpoId = tx();
    res.status(201).json({ id: vpoId, po_number: poNum, total_amount: totalAmount, lines: lines.length, file_path: filePath });
  } catch (err) {
    // Clean up orphaned upload if the DB insert failed (e.g. unique-constraint on po_number)
    if (filePath) { try { fs.unlinkSync(path.join(uploadDir, path.basename(filePath))); } catch (e) {} }
    if (String(err.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: `PO Number "${poNum}" already exists` });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── Vendor PO 2-level approval (mam 2026-06-19) ──────────────────────────
// A new PO must be signed off L1 → L2 before it's live. L1 = Nitin Jain,
// L2 = Ankur Kaplesh (resolved by name so it survives across local/prod DBs).
// Admin and the COO (coo@… login) can stand in for either level.
const PO_APPROVERS = { 1: 'Nitin Jain', 2: 'Ankur Kaplesh' };
function resolvePoUserByName(db, name) {
  if (!name) return null;
  try {
    return db.prepare('SELECT id, name FROM users WHERE active=1 AND LOWER(TRIM(name))=LOWER(TRIM(?)) LIMIT 1').get(name)
      || db.prepare('SELECT id, name FROM users WHERE active=1 AND LOWER(name) LIKE LOWER(?) ORDER BY id LIMIT 1').get('%' + name + '%');
  } catch (_) { return null; }
}
function canApprovePoLevel(db, userId, level) {
  const u = db.prepare('SELECT role, email, username FROM users WHERE id=?').get(userId);
  if (u?.role === 'admin') return true;
  const isCoo = (v) => String(v || '').trim().toLowerCase().startsWith('coo@');
  if (isCoo(u?.email) || isCoo(u?.username)) return true;          // COO can stand in
  const approver = resolvePoUserByName(db, PO_APPROVERS[level]);
  return !!approver && approver.id === userId;
}
const poLevelOf = (s) => (s === 'pending_l1' ? 1 : s === 'pending_l2' ? 2 : null);

// Approve the current pending level (L1 → L2 → approved).
router.post('/vendor-po/:id/po-approve', (req, res) => {
  const db = getDb(); const id = +req.params.id;
  const po = db.prepare('SELECT id, po_approval FROM vendor_pos WHERE id=?').get(id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  const level = poLevelOf(po.po_approval);
  if (!level) return res.status(400).json({ error: 'This PO is not pending approval' });
  if (!canApprovePoLevel(db, req.user.id, level)) {
    return res.status(403).json({ error: `Only ${PO_APPROVERS[level]} (L${level}) or admin can approve this step` });
  }
  if (level === 1) db.prepare("UPDATE vendor_pos SET po_approval='pending_l2', po_l1_by=?, po_l1_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user.id, id);
  else             db.prepare("UPDATE vendor_pos SET po_approval='approved',  po_l2_by=?, po_l2_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user.id, id);
  res.json({ ok: true, po_approval: level === 1 ? 'pending_l2' : 'approved' });
});

// Reject at the current pending level (reason required).
router.post('/vendor-po/:id/po-reject', (req, res) => {
  const db = getDb(); const id = +req.params.id;
  const po = db.prepare('SELECT id, po_approval FROM vendor_pos WHERE id=?').get(id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  const level = poLevelOf(po.po_approval);
  if (!level) return res.status(400).json({ error: 'This PO is not pending approval' });
  if (!canApprovePoLevel(db, req.user.id, level)) {
    return res.status(403).json({ error: `Only ${PO_APPROVERS[level]} (L${level}) or admin can reject this step` });
  }
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 3) return res.status(400).json({ error: 'A rejection reason is required' });
  db.prepare("UPDATE vendor_pos SET po_approval='rejected', po_reject_by=?, po_reject_at=CURRENT_TIMESTAMP, po_reject_reason=? WHERE id=?").run(req.user.id, reason, id);
  res.json({ ok: true });
});

// PUT /vendor-po/:id  —  status / advance OR full header edit.
// Mam (2026-05-20): "how can i edit po after creation because
// some time need".  Same endpoint handles both legacy callers
// (status / advance_paid only) and the new full-edit modal
// (po_date, expected_receipt_date, total_amount, advance_required,
// remarks, vendor_id).  po_number stays immutable.
//
// Guards:
//   - Cancelled POs must be uncancelled before editing.
//   - PO with linked Purchase Bills can edit dates / remarks but
//     NOT total_amount / vendor_id (those would invalidate the bill).
router.put('/vendor-po/:id', (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const b = req.body || {};
  const cur = db.prepare('SELECT * FROM vendor_pos WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'Vendor PO not found' });
  if (cur.cancelled) return res.status(400).json({ error: 'PO is cancelled — restore it before editing.' });

  const billCount = db.prepare('SELECT COUNT(*) as c FROM purchase_bills WHERE vendor_po_id=?').get(id).c;
  const sets = []; const params = [];
  const set = (k, v) => { sets.push(`${k}=?`); params.push(v); };

  // Legacy fields (kept for backwards compat with status / advance toggle)
  if (b.status !== undefined)        set('status', b.status);
  if (b.advance_paid !== undefined)  set('advance_paid', b.advance_paid ? 1 : 0);

  // New editable header fields (mam's full-edit modal)
  if (b.po_date !== undefined)               set('po_date', b.po_date || null);
  if (b.expected_receipt_date !== undefined) set('expected_receipt_date', b.expected_receipt_date || null);
  if (b.remarks !== undefined)               set('remarks', b.remarks || null);
  if (b.advance_required !== undefined)      set('advance_required', +b.advance_required || 0);

  // Payment-before-material (internal — mam 2026-05-27). Edited via the
  // same form; if the user switches type from 'advance' → 'no_advance'
  // we reset status to 'na' and zero the amount so the chip doesn't
  // dangle. Clearing happens via the dedicated PATCH endpoint below.
  if (b.payment_block_type !== undefined) {
    const VALID = ['advance', 'old_payment_clear', 'no_advance'];
    const pmtType = VALID.includes(b.payment_block_type) ? b.payment_block_type : null;
    set('payment_block_type', pmtType);
    set('payment_block_status', (pmtType === 'advance' || pmtType === 'old_payment_clear') ? 'pending' : 'na');
    if (!(pmtType === 'advance' || pmtType === 'old_payment_clear')) {
      set('payment_block_amount', null);
      set('payment_cleared_at', null);
      set('payment_cleared_by', null);
    }
  }
  if (b.payment_block_amount !== undefined) set('payment_block_amount', +b.payment_block_amount > 0 ? +b.payment_block_amount : null);
  if (b.payment_block_notes !== undefined)  set('payment_block_notes', b.payment_block_notes ? String(b.payment_block_notes).trim().slice(0, 500) : null);

  // Freight terms + charge (mam 2026-06-12) — printed on the PO and folded
  // into the recomputed total below.
  if (b.freight_terms !== undefined) {
    const VALID_FREIGHT = ['Ex-Works', 'FOR'];
    set('freight_terms', VALID_FREIGHT.includes(b.freight_terms) ? b.freight_terms : null);
  }
  if (b.freight_amount !== undefined) set('freight_amount', +b.freight_amount > 0 ? Math.round(+b.freight_amount * 100) / 100 : 0);
  // Freight value to use when recomputing the total: the new amount if the
  // caller sent one, else whatever is currently stored on the PO.
  const freightForTotal = (b.freight_amount !== undefined)
    ? (+b.freight_amount > 0 ? Math.round(+b.freight_amount * 100) / 100 : 0)
    : (+cur.freight_amount || 0);

  // High-impact edits: blocked when bills exist (would invalidate them)
  if (b.total_amount !== undefined) {
    if (billCount > 0) {
      return res.status(409).json({ error: `Cannot change total_amount — ${billCount} purchase bill(s) reference this PO. Cancel the bill first or use Restore-then-recreate.` });
    }
    set('total_amount', +b.total_amount || 0);
  }
  if (b.vendor_id !== undefined) {
    if (billCount > 0) {
      return res.status(409).json({ error: `Cannot change vendor — ${billCount} purchase bill(s) reference this PO. Cancel the bill first.` });
    }
    set('vendor_id', +b.vendor_id || null);
  }

  // Line items edit (mam 2026-05-25: "i want edit the po after creation
  // so that after correct").  Body.items[] = array of { id, quantity,
  // rate, description, hsn_code }.  Only patches fields that are
  // present on each row; id is required to match an existing
  // vendor_po_items row.  Total is auto-recomputed at the end.
  let itemUpdates = 0;
  if (Array.isArray(b.items) && b.items.length) {
    // Block line-item edits when bills exist — they invalidate the bill
    // amount + GST tracking.  Mam should cancel the bill first.
    if (billCount > 0) {
      return res.status(409).json({ error: `Cannot edit line items — ${billCount} purchase bill(s) reference this PO. Cancel the bill first or restore-then-recreate.` });
    }
    const dnCount = db.prepare('SELECT COUNT(*) as c FROM delivery_notes WHERE vendor_po_id=?').get(id).c;
    if (dnCount > 0) {
      return res.status(409).json({ error: `Cannot edit line items — ${dnCount} delivery note(s) reference this PO. Cancel them first.` });
    }
    const updLine = db.prepare(
      `UPDATE vendor_po_items
         SET quantity    = COALESCE(?, quantity),
             rate        = COALESCE(?, rate),
             amount      = COALESCE(?, amount),
             description = COALESCE(?, description),
             hsn_code    = COALESCE(?, hsn_code)
       WHERE id = ? AND vendor_po_id = ?`
    );
    const tx = db.transaction(() => {
      for (const it of b.items) {
        const itemId = +it.id;
        if (!itemId) continue;
        const qty = it.quantity !== undefined && it.quantity !== null && it.quantity !== '' ? +it.quantity : null;
        const rate = it.rate !== undefined && it.rate !== null && it.rate !== '' ? +it.rate : null;
        const amount = qty != null && rate != null ? +(qty * rate).toFixed(2) : null;
        const desc = it.description !== undefined ? String(it.description || '') : null;
        const hsn = it.hsn_code !== undefined ? String(it.hsn_code || '') : null;
        const r = updLine.run(qty, rate, amount, desc, hsn, itemId, id);
        itemUpdates += r.changes;
      }
      // Auto-recompute total_amount = sum(line amounts) × 1.18 (GST) + freight.
      // Skips if caller explicitly set total_amount above (avoid double-set).
      if (b.total_amount === undefined) {
        const newTotal = db.prepare(
          'SELECT COALESCE(ROUND(SUM(amount) * 1.18, 2), 0) as t FROM vendor_po_items WHERE vendor_po_id=?'
        ).get(id).t;
        db.prepare('UPDATE vendor_pos SET total_amount=? WHERE id=?').run(+(newTotal + freightForTotal).toFixed(2), id);
      }
    });
    try { tx(); }
    catch (err) { return res.status(500).json({ error: 'Line items update failed: ' + err.message }); }
  } else if (b.freight_amount !== undefined && b.total_amount === undefined && billCount === 0) {
    // Freight changed without touching line items — refresh the stored total
    // so the Vendor PO list reflects the new freight (sum × 1.18 + freight).
    const newTotal = db.prepare(
      'SELECT COALESCE(ROUND(SUM(amount) * 1.18, 2), 0) as t FROM vendor_po_items WHERE vendor_po_id=?'
    ).get(id).t;
    db.prepare('UPDATE vendor_pos SET total_amount=? WHERE id=?').run(+(newTotal + freightForTotal).toFixed(2), id);
  }

  if (sets.length === 0 && itemUpdates === 0) return res.status(400).json({ error: 'No fields to update' });
  if (sets.length > 0) db.prepare(`UPDATE vendor_pos SET ${sets.join(', ')} WHERE id=?`).run(...params, id);
  res.json({ message: 'Updated', header_changed: sets.length, items_changed: itemUpdates });
});

// PATCH /vendor-po/:id/clear-payment — internal Mark Payment Cleared
// action (mam 2026-05-27). One-click flip of payment_block_status from
// 'pending' → 'cleared' + audit stamp (who clicked, when). Lets the
// purchase team know material is unblocked. Re-runnable: if already
// cleared, returns the existing cleared row unchanged.
router.patch('/vendor-po/:id/clear-payment', (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const cur = db.prepare('SELECT id, payment_block_type, payment_block_status FROM vendor_pos WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'Vendor PO not found' });
  if (cur.payment_block_type !== 'advance' && cur.payment_block_type !== 'old_payment_clear') {
    return res.status(400).json({ error: 'No payment block on this PO to clear' });
  }
  if (cur.payment_block_status === 'cleared') {
    return res.json({ message: 'Already cleared', already: true });
  }
  db.prepare(
    `UPDATE vendor_pos
       SET payment_block_status='cleared',
           payment_cleared_at=CURRENT_TIMESTAMP,
           payment_cleared_by=?
     WHERE id=?`
  ).run(req.user.id, id);
  res.json({ message: 'Payment marked cleared' });
});

// GET single Vendor PO with its line items — used by the Edit PO modal
// to pre-fill editable rows (mam 2026-05-25: "i want edit the po after
// creation so that after correct").
router.get('/vendor-po/:id/with-items', (req, res) => {
  const db = getDb();
  const po = db.prepare(`
    SELECT vp.*, v.name as vendor_name
      FROM vendor_pos vp
      LEFT JOIN vendors v ON v.id = vp.vendor_id
     WHERE vp.id = ?
  `).get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Vendor PO not found' });
  let items = db.prepare(`
    SELECT vpi.id, vpi.quantity, vpi.rate, vpi.amount, vpi.description, vpi.hsn_code,
           ii.description as indent_description, ii.unit,
           im.item_code, im.item_name as master_name, im.specification, im.size
      FROM vendor_po_items vpi
      LEFT JOIN indent_items ii ON ii.id = vpi.indent_item_id
      LEFT JOIN item_master im ON im.id = ii.item_master_id
     WHERE vpi.vendor_po_id = ?
     ORDER BY vpi.id
  `).all(req.params.id);

  // Mam (2026-06-02): "item wise not showing" — legacy POs created
  // before vendor_po_items was populated have an empty items array.
  // Fall back to the linked indent's items so the Mark Received modal
  // still shows per-line qty for those POs.  Each indent_items row
  // becomes a synthetic "vpi" with id = `ind-<indent_item_id>` so the
  // frontend can still address it; backend ignores these synthetic
  // ids on stock-IN (vendor_po_item_id won't be found → falls back to
  // ordered qty).
  if (items.length === 0 && po.indent_id) {
    items = db.prepare(`
      SELECT 'ind-' || ii.id as id, ii.quantity, ii.rate, ii.amount,
             ii.description, NULL as hsn_code,
             ii.description as indent_description, ii.unit,
             im.item_code, im.item_name as master_name,
             im.specification, im.size
        FROM indent_items ii
        LEFT JOIN item_master im ON im.id = ii.item_master_id
       WHERE ii.indent_id = ?
       ORDER BY ii.id
    `).all(po.indent_id);
  }
  // Block-edit warnings — surface bill / DN count so the UI can disable
  // line-item editing fields when downstream documents already reference
  // this PO.
  const billCount = db.prepare('SELECT COUNT(*) as c FROM purchase_bills WHERE vendor_po_id=?').get(req.params.id).c;
  const dnCount = db.prepare('SELECT COUNT(*) as c FROM delivery_notes WHERE vendor_po_id=?').get(req.params.id).c;
  res.json({ po, items, bill_count: billCount, dn_count: dnCount, edit_locked: billCount > 0 || dnCount > 0 });
});

router.delete('/vendor-po/:id', (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const billCount = db.prepare('SELECT COUNT(*) as c FROM purchase_bills WHERE vendor_po_id=?').get(id).c;
  const dnCount = db.prepare('SELECT COUNT(*) as c FROM delivery_notes WHERE vendor_po_id=?').get(id).c;
  // Hard delete is only allowed when nothing references this PO. Otherwise
  // the user should use POST /vendor-po/:id/cancel which is a soft-delete
  // that preserves the audit trail + linked bills / delivery notes.
  if (billCount > 0 || dnCount > 0) return res.status(409).json({ error: `Cannot delete — ${billCount} bill(s) and ${dnCount} delivery note(s) reference this PO. Use Cancel PO instead.` });
  db.prepare('DELETE FROM vendor_pos WHERE id=?').run(id);
  res.json({ message: 'Deleted' });
});

// Soft-cancel a Vendor PO. Hides it from "Pending for PO" / "Awaiting Bill" /
// "Ready to Dispatch" follow-up lists while preserving the row + every
// linked bill / delivery note for audit. Reversible via /uncancel.
router.post('/vendor-po/:id/cancel', needsApprove, (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const { reason } = req.body || {};
  const cur = db.prepare('SELECT id, cancelled FROM vendor_pos WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'Vendor PO not found' });
  if (cur.cancelled) return res.status(400).json({ error: 'PO is already cancelled' });
  db.prepare(`
    UPDATE vendor_pos
       SET cancelled = 1,
           cancelled_at = CURRENT_TIMESTAMP,
           cancelled_by = ?,
           cancel_reason = ?
     WHERE id = ?
  `).run(req.user.id, String(reason || '').trim() || null, id);
  res.json({ message: 'PO cancelled' });
});

router.post('/vendor-po/:id/uncancel', needsApprove, (req, res) => {
  const db = getDb();
  db.prepare(`
    UPDATE vendor_pos
       SET cancelled = 0, cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL
     WHERE id = ?
  `).run(req.params.id);
  res.json({ message: 'PO restored' });
});

// Admin-only: clear an item-rate row entirely. Wipes the 3 vendor quotes +
// any finalize fields. Indent_item itself stays intact so the row reappears
// in the Vendor Rates list as "Pending" — admin can re-quote from scratch.
router.delete('/item-rates/:rate_id', needsApprove, (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT id, indent_item_id FROM indent_item_rates WHERE id=?').get(req.params.rate_id);
  if (!cur) return res.status(404).json({ error: 'Rate not found' });
  db.prepare('DELETE FROM indent_item_rates WHERE id=?').run(req.params.rate_id);
  res.json({ message: 'Rate cleared' });
});

// Purchase Bills
router.get('/purchase-bills', (req, res) => {
  // debit_total = sum of non-cancelled debit notes on this bill's PO.
  // net_payable = bill total − debits (mam 2026-06-04: the auto extra-rate
  // debit deducts from what we pay the vendor).
  res.json(getDb().prepare(`SELECT pb.*, v.name as vendor_name,
      COALESCE((SELECT SUM(d.amount) FROM debit_notes d
                 WHERE d.vendor_po_id = pb.vendor_po_id
                   AND d.status <> 'cancelled'), 0) AS debit_total
    FROM purchase_bills pb
    LEFT JOIN vendors v ON pb.vendor_id=v.id ORDER BY pb.created_at DESC`).all());
});

// Per-item PO qty vs RECEIVED qty for a Vendor PO — feeds the Bill-upload
// modal (mam 2026-06-04): show ordered vs received per line so the user
// can spot a short before saving the bill, and suggest the bill amount.
// Received qty is summed from delivery_notes.items_json (per
// vendor_po_item_id).  received_qty stays null when nothing's been
// received yet, so the UI doesn't flag "short" prematurely.
router.get('/vendor-po/:id/bill-items', (req, res) => {
  const db = getDb();
  const poId = +req.params.id;
  const items = db.prepare(`
    SELECT vpi.id as vpi_id, vpi.quantity as ordered_qty, vpi.rate,
           COALESCE(im.item_name, ii.description) as description,
           im.uom, ii.unit, ii.item_type
      FROM vendor_po_items vpi
      LEFT JOIN indent_items ii ON ii.id = vpi.indent_item_id
      LEFT JOIN item_master im ON im.id = ii.item_master_id
     WHERE vpi.vendor_po_id = ?
     ORDER BY vpi.id
  `).all(poId);

  const receivedByVpi = {};
  let anyReceipt = false;
  const dns = db.prepare("SELECT items_json FROM delivery_notes WHERE vendor_po_id=? AND items_json IS NOT NULL").all(poId);
  for (const dn of dns) {
    try {
      const arr = JSON.parse(dn.items_json);
      for (const r of (arr || [])) {
        if (r.vendor_po_item_id != null) {
          anyReceipt = true;
          receivedByVpi[r.vendor_po_item_id] = (receivedByVpi[r.vendor_po_item_id] || 0) + (+r.received_qty || 0);
        }
      }
    } catch (_) { /* ignore bad json */ }
  }

  const rows = items.map(it => {
    const recorded = Object.prototype.hasOwnProperty.call(receivedByVpi, it.vpi_id);
    const received = recorded ? receivedByVpi[it.vpi_id] : null;
    const ordered = +it.ordered_qty || 0;
    return {
      vpi_id: it.vpi_id, description: it.description || '—',
      unit: it.uom || it.unit || '', item_type: it.item_type || '',
      ordered_qty: ordered, received_qty: received,
      rate: +it.rate || 0,
      short_qty: received != null ? Math.max(0, ordered - received) : 0,
      ordered_value: ordered * (+it.rate || 0),
    };
  });
  const orderedTotal = rows.reduce((s, r) => s + r.ordered_value, 0);
  res.json({ items: rows, ordered_total: Math.round(orderedTotal * 100) / 100, any_receipt: anyReceipt });
});

// Purchase bill creation supports an optional file upload (PDF / image / xlsx)
// via multipart/form-data, the same pattern as Vendor PO upload. If no file
// is attached it still works — mam sometimes captures a bill without a scan.
router.post('/purchase-bills', needsApprove, vendorPoUpload.single('file'), (req, res) => {
  const b = req.body || {};
  if (!req.file) return res.status(400).json({ error: 'Bill file is required — upload the vendor bill' });
  const vendor_po_id = b.vendor_po_id ? +b.vendor_po_id : null;
  const vendor_id = b.vendor_id ? +b.vendor_id : null;
  const bill_number = b.bill_number || null;
  const bill_date = b.bill_date || null;
  const amount = +b.amount || 0;
  const gst_amount = +b.gst_amount || 0;
  const total_amount = +b.total_amount || 0;
  // Material acceptance (mam 2026-06-04): 'approved' (default) or 'reject'.
  const materialStatus = b.material_status === 'reject' ? 'reject' : 'approved';

  // Rename uploaded file to "<timestamp>-<original>" so the /uploads link
  // shows the real filename, same convention as Vendor PO upload.
  let filePath = null;
  if (req.file) {
    try {
      const safeName = (req.file.originalname || 'purchase-bill').replace(/[^a-zA-Z0-9._-]/g, '_');
      const newName = `${Date.now()}-${safeName}`;
      const newPath = path.join(path.dirname(req.file.path), newName);
      fs.renameSync(req.file.path, newPath);
      filePath = `/uploads/${newName}`;
    } catch (e) {
      filePath = `/uploads/${req.file.filename}`;
    }
  }

  try {
    const db = getDb();
    const r = db.prepare(
      `INSERT INTO purchase_bills (vendor_po_id, vendor_id, bill_number, bill_date, amount, gst_amount, total_amount, file_path, material_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(vendor_po_id, vendor_id, bill_number, bill_date, amount, gst_amount, total_amount, filePath, materialStatus);

    // Mam (2026-06-02): "in rec. against delivery note show here ok
    // site name also show here delivery note number and against it
    // we will upload receiving".  As soon as a Purchase Bill is
    // uploaded for a PO, auto-create a placeholder Challan Delivery
    // Note (status='pending', auto DC/YYYY/####) so the row appears in
    // Dispatch & Receiving with a real DN number that mam can:
    //   - see in the list straight away (no more "—" doc-no column),
    //   - hand to the storekeeper as the printable challan, and
    //   - upload the signed receipt against without an extra Dispatch
    //     click.
    // Guarded so re-uploading a bill on the same PO doesn't spawn
    // duplicate DN rows.
    // Per-line received qty from the bill modal (mam 2026-06-30): store it on the
    // challan's items_json so the Delivery Challan shows RECEIVED, not full ordered
    // qty. quantity == received_qty so the DN template (which renders it.quantity)
    // shows the received amount; received_qty also feeds the ordered-vs-received
    // variance. Matched downstream by vendor_po_item_id (exact).
    let receivedItems = [];
    try { receivedItems = JSON.parse(b.received_items || '[]'); } catch (_) { receivedItems = []; }
    const recvJson = receivedItems.length ? JSON.stringify(receivedItems.map(it => ({
      vendor_po_item_id: it.vendor_po_item_id,
      description: it.description || '', unit: it.unit || '', hsn_code: it.hsn_code || '',
      quantity: +it.received_qty || 0, received_qty: +it.received_qty || 0,
      ordered_qty: +it.ordered_qty || 0, rate: +it.rate || 0,
    }))) : null;

    let autoDnId = null, autoDnNumber = null;
    const { nextSequence } = require('../db/nextSequence');
    const dnYear = new Date().getFullYear();
    const dnToday = new Date().toISOString().slice(0, 10);
    if (vendor_po_id) {
      const existingDn = db.prepare(
        'SELECT id, document_number FROM delivery_notes WHERE vendor_po_id = ? LIMIT 1'
      ).get(vendor_po_id);
      if (existingDn) {
        autoDnId = existingDn.id;
        autoDnNumber = existingDn.document_number;
        // Refresh the received quantities from this bill onto the existing challan.
        if (recvJson) db.prepare('UPDATE delivery_notes SET items_json=? WHERE id=?').run(recvJson, existingDn.id);
      } else {
        autoDnNumber = nextSequence(db, 'delivery_notes', 'document_number', `DC/${dnYear}/`, { pad: 4 });
        const ins = db.prepare(
          `INSERT INTO delivery_notes
              (vendor_po_id, delivery_date, document_type, document_number, status, notes, items_json)
           VALUES (?, ?, 'challan', ?, 'pending', ?, ?)`
        ).run(vendor_po_id, dnToday, autoDnNumber, `Auto-created from Purchase Bill ${bill_number || '#' + r.lastInsertRowid}`, recvJson);
        autoDnId = ins.lastInsertRowid;
      }
    } else {
      // mam 2026-06-30: EVERY purchase bill creates a Delivery Challan — including
      // direct bills with no Vendor PO. No PO means no line data to pull, so this
      // is a header challan the user fills/receives manually; the vendor name goes
      // in the notes so it's identifiable in Dispatch & Receiving.
      const vName = vendor_id ? (db.prepare('SELECT name FROM vendors WHERE id=?').get(vendor_id)?.name || '') : '';
      autoDnNumber = nextSequence(db, 'delivery_notes', 'document_number', `DC/${dnYear}/`, { pad: 4 });
      const ins = db.prepare(
        `INSERT INTO delivery_notes
            (vendor_po_id, delivery_date, document_type, document_number, status, notes, items_json)
         VALUES (NULL, ?, 'challan', ?, 'pending', ?, ?)`
      ).run(dnToday, autoDnNumber, `Auto-created from Purchase Bill ${bill_number || '#' + r.lastInsertRowid}${vName ? ' · Vendor: ' + vName : ''}`, recvJson);
      autoDnId = ins.lastInsertRowid;
    }

    // Material REJECTED at bill entry (mam 2026-06-04): raise a rejected
    // debit note for the full taxable value.  When rejected we skip the
    // extra-rate / short-supply checks (nothing was accepted).
    let autoRejectDebit = null;
    if (materialStatus === 'reject' && vendor_po_id) {
      try {
        const po = db.prepare('SELECT vendor_id FROM vendor_pos WHERE id=?').get(vendor_po_id);
        const billVal = amount > 0 ? amount : (total_amount - gst_amount);
        if (billVal > 0) {
          const { nextSequence } = require('../db/nextSequence');
          const year = new Date().getFullYear();
          const dnNum = nextSequence(db, 'debit_notes', 'dn_number', `DBN/${year}/`, { pad: 4 });
          const items = [{ description: `Material rejected (Bill ${bill_number || '#' + r.lastInsertRowid})`, unit: '', qty: 1, rate: billVal, amount: billVal, purchase_bill_id: r.lastInsertRowid }];
          const dr = db.prepare(
            `INSERT INTO debit_notes (dn_number, type, vendor_po_id, vendor_id, purchase_bill_id, amount, reason, items_json, status, created_by)
             VALUES (?, 'rejected', ?, ?, ?, ?, ?, ?, 'open', ?)`
          ).run(dnNum, vendor_po_id, vendor_id || po?.vendor_id || null, r.lastInsertRowid, Math.round(billVal * 100) / 100,
                'Auto-raised on bill entry: material REJECTED.', JSON.stringify(items), req.user?.id || null);
          autoRejectDebit = { id: dr.lastInsertRowid, dn_number: dnNum, amount: Math.round(billVal * 100) / 100 };
        }
      } catch (e) { console.error('[auto-reject-debit] failed (bill saved anyway):', e.message); }
    }

    // Auto extra-rate DEBIT NOTE (mam 2026-06-04): when the vendor bills
    // MORE than the PO value, raise a debit note for the difference
    // automatically — it then deducts from the net payable.  Compares the
    // bill's TAXABLE value (amount, pre-GST) against the PO subtotal
    // (vendor_pos.total_amount, also pre-GST) so GST never creates a false
    // variance.  One auto extra-rate debit per bill (guarded).  Skipped when
    // the material was rejected.
    let autoDebit = null;
    if (materialStatus === 'approved' && vendor_po_id) {
      try {
        const po = db.prepare('SELECT total_amount, vendor_id FROM vendor_pos WHERE id=?').get(vendor_po_id);
        const poVal = +po?.total_amount || 0;
        const billVal = amount > 0 ? amount : (total_amount - gst_amount);  // taxable value
        const variance = Math.round((billVal - poVal) * 100) / 100;
        const already = db.prepare("SELECT id FROM debit_notes WHERE purchase_bill_id=? AND type='extra_rate'").get(r.lastInsertRowid);
        if (poVal > 0 && variance > 1 && !already) {
          const { nextSequence } = require('../db/nextSequence');
          const year = new Date().getFullYear();
          const dnNum = nextSequence(db, 'debit_notes', 'dn_number', `DBN/${year}/`, { pad: 4 });
          const items = [{ description: `Excess over PO value (Bill ${bill_number || '#' + r.lastInsertRowid})`, unit: '', qty: 1, rate: variance, amount: variance, purchase_bill_id: r.lastInsertRowid }];
          const dr = db.prepare(
            `INSERT INTO debit_notes (dn_number, type, vendor_po_id, vendor_id, purchase_bill_id, amount, reason, items_json, status, created_by)
             VALUES (?, 'extra_rate', ?, ?, ?, ?, ?, ?, 'open', ?)`
          ).run(dnNum, vendor_po_id, vendor_id || po.vendor_id || null, r.lastInsertRowid, variance,
                `Auto-raised on bill entry: vendor billed ₹${Math.round(billVal).toLocaleString('en-IN')} vs PO ₹${Math.round(poVal).toLocaleString('en-IN')} (excess ₹${Math.round(variance).toLocaleString('en-IN')}).`,
                JSON.stringify(items), req.user?.id || null);
          autoDebit = { id: dr.lastInsertRowid, dn_number: dnNum, amount: variance };
        }
      } catch (e) { console.error('[auto-debit] failed (bill saved anyway):', e.message); }
    }

    // Auto SHORT-SUPPLY debit from the bill (mam 2026-06-04): if items were
    // received SHORT (received < ordered), raise a short-supply debit — but
    // only when one doesn't already exist for this PO (the receiving flow
    // may have created it).  Short comes from delivery_notes received qty
    // vs the PO ordered qty; value = shortfall × PO rate.
    let autoShortDebit = null;
    let vendorMailed = false;
    if (materialStatus === 'approved' && vendor_po_id) {
      try {
        const existingShort = db.prepare("SELECT id FROM debit_notes WHERE vendor_po_id=? AND type='short_supply'").get(vendor_po_id);
        if (!existingShort) {
          const poItems = db.prepare(
            `SELECT vpi.id, vpi.quantity, vpi.rate, COALESCE(im.item_name, ii.description) as description, ii.unit
               FROM vendor_po_items vpi
               LEFT JOIN indent_items ii ON ii.id = vpi.indent_item_id
               LEFT JOIN item_master im ON im.id = ii.item_master_id
              WHERE vpi.vendor_po_id = ?`
          ).all(vendor_po_id);
          const recv = {};
          for (const dn of db.prepare("SELECT items_json FROM delivery_notes WHERE vendor_po_id=? AND items_json IS NOT NULL").all(vendor_po_id)) {
            try { for (const x of (JSON.parse(dn.items_json) || [])) if (x.vendor_po_item_id != null) recv[x.vendor_po_item_id] = (recv[x.vendor_po_item_id] || 0) + (+x.received_qty || 0); } catch (_) {}
          }
          const lines = []; let amt = 0;
          for (const it of poItems) {
            if (!(it.id in recv)) continue;  // only lines that were actually received
            const short = Math.max(0, (+it.quantity || 0) - (+recv[it.id] || 0));
            if (short <= 0) continue;
            const lineAmt = short * (+it.rate || 0); amt += lineAmt;
            lines.push({ description: it.description || 'Item', unit: it.unit || '', qty: short, rate: +it.rate || 0, amount: lineAmt });
          }
          if (lines.length && amt > 0) {
            const { nextSequence } = require('../db/nextSequence');
            const year = new Date().getFullYear();
            const dnNum = nextSequence(db, 'debit_notes', 'dn_number', `DBN/${year}/`, { pad: 4 });
            const po2 = db.prepare('SELECT vendor_id FROM vendor_pos WHERE id=?').get(vendor_po_id);
            const dr = db.prepare(
              `INSERT INTO debit_notes (dn_number, type, vendor_po_id, vendor_id, purchase_bill_id, amount, reason, items_json, status, created_by)
               VALUES (?, 'short_supply', ?, ?, ?, ?, ?, ?, 'open', ?)`
            ).run(dnNum, vendor_po_id, vendor_id || po2?.vendor_id || null, r.lastInsertRowid, Math.round(amt * 100) / 100,
                  'Auto-raised on bill entry: short supply (received less than ordered).', JSON.stringify(lines), req.user?.id || null);
            autoShortDebit = { id: dr.lastInsertRowid, dn_number: dnNum, amount: Math.round(amt * 100) / 100 };

            // Email the vendor about the short supply (mam 2026-06-04).
            // Fire-and-forget; sendEmail no-ops gracefully if SMTP is off.
            try {
              const { sendEmail } = require('../lib/email');
              const vend = db.prepare('SELECT name, email FROM vendors WHERE id=?').get(vendor_id || po2?.vendor_id);
              const po3 = db.prepare('SELECT po_number FROM vendor_pos WHERE id=?').get(vendor_po_id);
              if (vend?.email) {
                const rowsHtml = lines.map(l => `<tr><td>${l.description}</td><td align="right">${l.qty} ${l.unit || ''}</td></tr>`).join('');
                sendEmail({
                  to: vend.email,
                  subject: `Short Supply against PO ${po3?.po_number || ''} — please supply the balance`,
                  html: `<p>Dear ${vend.name || 'Sir/Madam'},</p>
                    <p>The following material against our PO <b>${po3?.po_number || ''}</b> was received <b>short</b> of the ordered quantity. Please arrange to supply the shortfall at the earliest, or confirm a credit.</p>
                    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse"><tr><th align="left">Item</th><th align="right">Short Qty</th></tr>${rowsHtml}</table>
                    <p>Regards,<br/>Secured Engineers Pvt. Ltd.</p>`,
                }).catch(() => {});
                vendorMailed = true;
              }
            } catch (_) { /* email is best-effort */ }
          }
        }
      } catch (e) { console.error('[auto-short-debit] failed (bill saved anyway):', e.message); }
    }

    // Auto SALES BILL (mam 2026-06-15: "i dont want to dispatch button click
    // auto generated"): the moment a Purchase Bill is uploaded and the
    // material is accepted, raise the client Sales Bill automatically
    // (BOQ×delivery% rates + client GST).  Idempotent + skips POs with no
    // rates.  Failure never blocks the bill upload.
    let autoSalesBill = null;
    if (materialStatus === 'approved' && vendor_po_id) {
      try {
        const sb = autoGenerateSalesBillForPO(db, vendor_po_id, req.user?.id);
        if (sb && sb.id) autoSalesBill = { id: sb.id, document_number: sb.document_number };
      } catch (e) { console.error('[auto-sales-bill] failed (bill saved anyway):', e.message); }
    }

    res.status(201).json({
      id: r.lastInsertRowid,
      file_path: filePath,
      delivery_note_id: autoDnId,
      delivery_note_number: autoDnNumber,
      auto_debit: autoDebit,
      auto_short_debit: autoShortDebit,
      auto_reject_debit: autoRejectDebit,
      auto_sales_bill: autoSalesBill,
      material_status: materialStatus,
      vendor_mailed: vendorMailed,
    });
  } catch (err) {
    if (filePath) { try { fs.unlinkSync(path.join(uploadDir, path.basename(filePath))); } catch (e) {} }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/purchase-bills/:id', (req, res) => {
  getDb().prepare('DELETE FROM purchase_bills WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ─────────────────────────────────────────────────────────────────────
// DEBIT NOTES (mam 2026-06-04 post-PO chart, stage 7)
// Three types, one table:
//   rejected     — material rejected at GRN (grn_items.rejected_qty)
//   short_supply — ordered vs received shortfall (a "short material" notice)
//   extra_rate   — vendor billed above the PO value (bill total − PO total)
// ─────────────────────────────────────────────────────────────────────

// Suggest the line items + amount for a debit note of a given type, drawn
// from the PO's GRNs / latest Purchase Bill.  The Raise-Debit-Note form
// pre-fills from this; the user can still edit before saving.
router.get('/vendor-po/:id/debit-source', (req, res) => {
  const db = getDb();
  const poId = +req.params.id;
  const type = String(req.query.type || 'rejected');
  const po = db.prepare(
    `SELECT vp.id, vp.po_number, vp.total_amount, vp.vendor_id,
            v.name as vendor_name, v.gst_number, v.address as vendor_address
       FROM vendor_pos vp LEFT JOIN vendors v ON v.id = vp.vendor_id
      WHERE vp.id = ?`
  ).get(poId);
  if (!po) return res.status(404).json({ error: 'Vendor PO not found' });

  let items = [], amount = 0, note = '';
  try {
    if (type === 'rejected' || type === 'short_supply') {
      // Pull GRN lines for this PO. rejected → rejected_qty; short_supply
      // → ordered − received (when positive).
      const rows = db.prepare(
        `SELECT gi.description, gi.unit, gi.rate,
                gi.ordered_qty, gi.received_qty, gi.rejected_qty, gi.remarks,
                g.grn_number, g.id as grn_id
           FROM grn_items gi JOIN grn g ON g.id = gi.grn_id
          WHERE g.vendor_po_id = ?`
      ).all(poId);
      for (const r of rows) {
        const qty = type === 'rejected'
          ? (+r.rejected_qty || 0)
          : Math.max(0, (+r.ordered_qty || 0) - (+r.received_qty || 0));
        if (qty <= 0) continue;
        const rate = +r.rate || 0;
        const amt = qty * rate;
        amount += amt;
        items.push({ description: r.description, unit: r.unit || '', qty, rate, amount: amt, grn_number: r.grn_number, remarks: r.remarks || '' });
      }
      note = type === 'rejected'
        ? 'Material rejected at receiving — debit raised to recover value.'
        : 'Short supply — ordered quantity not fully received.';
    } else if (type === 'extra_rate') {
      // Vendor billed more than the PO value.  Latest Purchase Bill total
      // vs the PO total.  Positive difference is the debit.
      const bill = db.prepare(
        `SELECT id, bill_number, total_amount FROM purchase_bills
          WHERE vendor_po_id = ? ORDER BY id DESC LIMIT 1`
      ).get(poId);
      const poTotal = +po.total_amount || 0;
      const billTotal = +bill?.total_amount || 0;
      const diff = billTotal - poTotal;
      if (bill && diff > 0) {
        amount = diff;
        items.push({ description: `Excess over PO ${po.po_number} (Bill ${bill.bill_number || '#' + bill.id})`, unit: '', qty: 1, rate: diff, amount: diff, purchase_bill_id: bill.id });
        note = `Vendor billed ₹${Math.round(billTotal).toLocaleString('en-IN')} vs PO ₹${Math.round(poTotal).toLocaleString('en-IN')} — excess debited.`;
      } else {
        note = bill ? 'Bill does not exceed the PO value — no extra-rate debit.' : 'No Purchase Bill on this PO yet.';
      }
    }
  } catch (e) { /* table may be empty — return zero */ }

  res.json({ po, type, amount: Math.round(amount * 100) / 100, items, note });
});

router.get('/debit-notes', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT dn.*, vp.po_number, v.name as vendor_name
       FROM debit_notes dn
       LEFT JOIN vendor_pos vp ON vp.id = dn.vendor_po_id
       LEFT JOIN vendors v ON v.id = dn.vendor_id
      ORDER BY dn.id DESC`
  ).all();
  res.json(rows);
});

router.post('/debit-notes', (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const VALID = ['rejected', 'extra_rate', 'short_supply'];
  const type = VALID.includes(b.type) ? b.type : 'rejected';
  const vendor_po_id = b.vendor_po_id ? +b.vendor_po_id : null;
  if (!vendor_po_id) return res.status(400).json({ error: 'Vendor PO is required' });
  const po = db.prepare('SELECT vendor_id FROM vendor_pos WHERE id=?').get(vendor_po_id);
  if (!po) return res.status(404).json({ error: 'Vendor PO not found' });
  const items = Array.isArray(b.items) ? b.items : [];
  const amount = b.amount != null ? +b.amount
    : items.reduce((s, it) => s + (+it.amount || (+it.qty || 0) * (+it.rate || 0)), 0);
  const { nextSequence } = require('../db/nextSequence');
  const year = new Date().getFullYear();
  const dnNum = nextSequence(db, 'debit_notes', 'dn_number', `DBN/${year}/`, { pad: 4 });
  const r = db.prepare(
    `INSERT INTO debit_notes
       (dn_number, type, vendor_po_id, vendor_id, grn_id, purchase_bill_id, amount, reason, items_json, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
  ).run(dnNum, type, vendor_po_id, po.vendor_id, b.grn_id || null, b.purchase_bill_id || null,
        Math.round(amount * 100) / 100, b.reason || null, JSON.stringify(items), req.user?.id || null);
  res.status(201).json({ id: r.lastInsertRowid, dn_number: dnNum, amount });
});

router.patch('/debit-notes/:id', (req, res) => {
  const db = getDb();
  const b = req.body || {};
  if (b.status && ['open', 'sent', 'settled', 'cancelled'].includes(b.status)) {
    db.prepare('UPDATE debit_notes SET status=? WHERE id=?').run(b.status, req.params.id);
  }
  res.json({ message: 'Updated' });
});

router.delete('/debit-notes/:id', (req, res) => {
  getDb().prepare('DELETE FROM debit_notes WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Print data for a debit note — self-contained from items_json + vendor/PO.
router.get('/debit-notes/:id/print', (req, res) => {
  const db = getDb();
  const dn = db.prepare(
    `SELECT dn.*, vp.po_number, vp.po_date, v.name as vendor_name, v.gst_number,
            v.address as vendor_address, v.district, v.state, v.phone as vendor_phone
       FROM debit_notes dn
       LEFT JOIN vendor_pos vp ON vp.id = dn.vendor_po_id
       LEFT JOIN vendors v ON v.id = dn.vendor_id
      WHERE dn.id = ?`
  ).get(req.params.id);
  if (!dn) return res.status(404).json({ error: 'Debit note not found' });
  let items = [];
  try { items = JSON.parse(dn.items_json || '[]'); } catch (_) {}
  res.json({ dn, items });
});

// ─────────────────────────────────────────────────────────────────────
// POST-PO PIPELINE (mam 2026-06-04 chart): one row per Vendor PO showing
// how far it has progressed: PO → Delivery Note → Received(GRN) →
// Purchase Bill → Vendor Paid, plus a debit-note flag.  Pure read of the
// existing tables — no new data captured.
// ─────────────────────────────────────────────────────────────────────
router.get('/po-pipeline', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT vp.id, vp.po_number, vp.po_date, vp.total_amount, vp.status,
           vp.payment_block_status,
           v.name as vendor_name,
           i.indent_number, i.site_name,
           (SELECT COUNT(*) FROM delivery_notes dn WHERE dn.vendor_po_id = vp.id) as dn_count,
           (SELECT COUNT(*) FROM delivery_notes dn WHERE dn.vendor_po_id = vp.id AND dn.status='received') as dn_received,
           (SELECT COUNT(*) FROM purchase_bills pb WHERE pb.vendor_po_id = vp.id) as bill_count,
           (SELECT pb.payment_status FROM purchase_bills pb WHERE pb.vendor_po_id = vp.id ORDER BY pb.id DESC LIMIT 1) as bill_payment_status,
           (SELECT COUNT(*) FROM grn g WHERE g.vendor_po_id = vp.id) as grn_count,
           (SELECT COUNT(*) FROM debit_notes d WHERE d.vendor_po_id = vp.id) as debit_count
      FROM vendor_pos vp
      LEFT JOIN vendors v ON v.id = vp.vendor_id
      LEFT JOIN indents i ON i.id = vp.indent_id
     WHERE COALESCE(vp.cancelled, 0) = 0
     ORDER BY vp.id DESC
  `).all();
  res.json(rows);
});

// Dispatch (delivery_notes) — a dispatch entry is either a Sales Bill
// (for PO items sold to client) or a Delivery Challan (FOC / RGP items).
// After dispatch, mam records who received it via the /receive endpoint.
router.get('/delivery-notes', (req, res) => {
  // Mam (2026-06-02 follow-up): "company name also show which we fill
  // indent which is our site name".  Use the indent's own site_name
  // text (what mam typed when raising the indent — e.g. "Emerald land
  // india pvt ltd (Imperial Golf)") as the primary label, falling back
  // to sites.name (short master name) only if the indent didn't snapshot
  // a value.  COALESCE picks the first non-NULL non-empty option.
  res.json(getDb().prepare(`
    SELECT dn.*,
      u.name as received_by_user_name,
      vp.po_number as vendor_po_number,
      vp.indent_id as vendor_po_indent_id,
      v.name as vendor_name,
      i.indent_number as indent_number,
      NULLIF(TRIM(i.raised_by_name), '') as raised_by_name,
      NULLIF(TRIM(i.site_name), '') as site_name
    FROM delivery_notes dn
    LEFT JOIN users u ON dn.received_by = u.id
    LEFT JOIN vendor_pos vp ON dn.vendor_po_id = vp.id
    LEFT JOIN vendors v ON vp.vendor_id = v.id
    -- Resolve the indent from the Vendor PO, OR (for from-store challans
    -- with no PO) directly from delivery_notes.indent_id.  No sites JOIN:
    -- it matched site_name to itself (circular) and fanned out into
    -- DUPLICATE rows when a site name wasn't unique (mam 2026-06-04).
    LEFT JOIN indents i ON i.id = COALESCE(vp.indent_id, dn.indent_id)
    ORDER BY dn.created_at DESC
  `).all());
});

// Create a dispatch entry. Multipart/form-data so we can carry the
// sales-bill/challan PDF as an optional upload. Document type is required
// (sales_bill | challan) so the list can show the right label.
// Edit received qty on an EXISTING purchase bill (mam 2026-06-30): update the
// auto-created challan's items_json so the Delivery Challan reflects the corrected
// received quantities. Same shape the purchase-bill POST writes.
router.put('/vendor-po/:id/received-qty', needsApprove, (req, res) => {
  const db = getDb();
  const vendor_po_id = +req.params.id;
  let receivedItems = [];
  try { receivedItems = Array.isArray(req.body?.received_items) ? req.body.received_items : JSON.parse(req.body?.received_items || '[]'); } catch (_) { receivedItems = []; }
  if (!receivedItems.length) return res.status(400).json({ error: 'No received items provided' });
  const recvJson = JSON.stringify(receivedItems.map(it => ({
    vendor_po_item_id: it.vendor_po_item_id,
    description: it.description || '', unit: it.unit || '', hsn_code: it.hsn_code || '',
    quantity: +it.received_qty || 0, received_qty: +it.received_qty || 0,
    ordered_qty: +it.ordered_qty || 0, rate: +it.rate || 0,
  })));
  const dn = db.prepare('SELECT id FROM delivery_notes WHERE vendor_po_id=? LIMIT 1').get(vendor_po_id);
  if (dn) {
    db.prepare('UPDATE delivery_notes SET items_json=? WHERE id=?').run(recvJson, dn.id);
    return res.json({ ok: true, delivery_note_id: dn.id });
  }
  const { nextSequence } = require('../db/nextSequence');
  const year = new Date().getFullYear();
  const dnNum = nextSequence(db, 'delivery_notes', 'document_number', `DC/${year}/`, { pad: 4 });
  const today = new Date().toISOString().slice(0, 10);
  const ins = db.prepare(`INSERT INTO delivery_notes (vendor_po_id, delivery_date, document_type, document_number, status, notes, items_json) VALUES (?, ?, 'challan', ?, 'pending', 'Received qty edited', ?)`).run(vendor_po_id, today, dnNum, recvJson);
  res.json({ ok: true, delivery_note_id: ins.lastInsertRowid, document_number: dnNum });
});

router.post('/delivery-notes', needsApprove, vendorPoUpload.single('file'), (req, res) => {
  const b = req.body || {};
  // File is OPTIONAL on create. Mam's flow: ERP generates the document
  // (Delivery Note / Sales Bill PDF via the new print endpoint), staff
  // print it, get it signed at delivery, then upload the signed copy.
  // The signed copy can be added later via PUT /dispatches/:id.
  const vendor_po_id = b.vendor_po_id ? +b.vendor_po_id : null;
  const delivery_date = b.delivery_date || null;
  const notes = b.notes || null;
  const document_type = b.document_type || null;     // 'sales_bill' or 'challan'
  if (!document_type || !['sales_bill', 'challan'].includes(document_type)) {
    return res.status(400).json({ error: 'Dispatch type (Sales Bill or Challan) is required' });
  }
  // Auto-generate the document number when not supplied so mam doesn't
  // have to think up a unique INV/DC number herself. Format:
  //   Sales Bill -> INV/{year}/{0001+}   e.g. INV/2026/0042
  //   Challan    -> DC/{year}/{0001+}    e.g. DC/2026/0042
  // The nextSequence helper scans existing rows for the same prefix and
  // returns max+1, so deleting a row doesn't break uniqueness.
  let document_number = b.document_number && String(b.document_number).trim();
  if (!document_number) {
    const { nextSequence } = require('../db/nextSequence');
    const year = new Date().getFullYear();
    // Sales-bill series GST/26-26/NN starting at 61 (mam 2026-06-15); challans keep DC/.
    document_number = document_type === 'sales_bill'
      ? nextSequence(getDb(), 'delivery_notes', 'document_number', 'GST/26-26/', { startFrom: 60, pad: 2 })
      : nextSequence(getDb(), 'delivery_notes', 'document_number', `DC/${year}/`, { pad: 4 });
  }

  let filePath = null;
  if (req.file) {
    try {
      const safeName = (req.file.originalname || 'dispatch').replace(/[^a-zA-Z0-9._-]/g, '_');
      const newName = `${Date.now()}-${safeName}`;
      const newPath = path.join(path.dirname(req.file.path), newName);
      fs.renameSync(req.file.path, newPath);
      filePath = `/uploads/${newName}`;
    } catch (e) {
      filePath = `/uploads/${req.file.filename}`;
    }
  }

  const num = (v) => { const n = +v; return Number.isFinite(n) ? n : 0; };
  // Per-line-item overrides — JSON array of {description, hsn, unit, qty,
  // rate, disc_pct, amount, include}. Defaults to whatever Client PO had;
  // the form lets mam tweak qty/rate/disc per row before generating.
  let itemsJson = null;
  if (Array.isArray(b.items) && b.items.length) {
    try { itemsJson = JSON.stringify(b.items.filter(it => it && it.include !== false)); } catch (_) {}
  } else if (typeof b.items === 'string' && b.items.trim()) {
    itemsJson = b.items;
  }
  const fields = {
    // Delivery-Note extras
    vehicle_no: b.vehicle_no || null,
    driver_name: b.driver_name || null,
    driver_mobile: b.driver_mobile || null,
    lr_challan_no: b.lr_challan_no || null,
    total_packages: b.total_packages || null,
    // Sales-Bill extras
    place_of_supply: b.place_of_supply || null,
    state_code: b.state_code || null,
    reverse_charge: b.reverse_charge ? 1 : 0,
    e_way_bill_no: b.e_way_bill_no || null,
    cgst_pct: num(b.cgst_pct),
    sgst_pct: num(b.sgst_pct),
    igst_pct: num(b.igst_pct),
    freight_amount: num(b.freight_amount),
    round_off_amount: num(b.round_off_amount),
    subtotal_amount: num(b.subtotal_amount),
    grand_total_amount: num(b.grand_total_amount),
    items_json: itemsJson,
  };

  // sales_bill_pending — mam (2026-05-25): when dispatching with a
  // Challan only, mam can tick "Sales Bill pending" to flag that the
  // formal Sales Bill will be uploaded later via /sales-bill endpoint.
  // Only meaningful for Challan dispatches — sales_bill dispatches
  // already HAVE the Sales Bill (this row IS the SB).
  const salesBillPending = (document_type === 'challan' && (b.sales_bill_pending === '1' || b.sales_bill_pending === 1 || b.sales_bill_pending === true)) ? 1 : 0;

  try {
    const r = getDb().prepare(
      `INSERT INTO delivery_notes (vendor_po_id, delivery_date, received_by, notes,
                                    document_type, document_number, file_path,
                                    vehicle_no, driver_name, driver_mobile, lr_challan_no, total_packages,
                                    place_of_supply, state_code, reverse_charge, e_way_bill_no,
                                    cgst_pct, sgst_pct, igst_pct, freight_amount, round_off_amount,
                                    subtotal_amount, grand_total_amount, items_json, sales_bill_pending)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(vendor_po_id, delivery_date, req.user.id, notes, document_type, document_number, filePath,
      fields.vehicle_no, fields.driver_name, fields.driver_mobile, fields.lr_challan_no, fields.total_packages,
      fields.place_of_supply, fields.state_code, fields.reverse_charge, fields.e_way_bill_no,
      fields.cgst_pct, fields.sgst_pct, fields.igst_pct, fields.freight_amount, fields.round_off_amount,
      fields.subtotal_amount, fields.grand_total_amount, fields.items_json, salesBillPending);
    res.status(201).json({ id: r.lastInsertRowid, file_path: filePath, document_number, document_type, sales_bill_pending: salesBillPending });
  } catch (err) {
    if (filePath) { try { fs.unlinkSync(path.join(uploadDir, path.basename(filePath))); } catch (e) {} }
    res.status(500).json({ error: err.message });
  }
});

// Upload the formal Sales Bill for a Challan-only dispatch that was
// previously marked sales_bill_pending=1.  Mam (2026-05-25): "rec is
// against some time delivery note so can upload but show sales bill is
// pending" — this is the late-add endpoint that clears the pending flag.
router.post('/delivery-notes/:id/sales-bill', needsApprove, vendorPoUpload.single('file'), (req, res) => {
  const b = req.body || {};
  const db = getDb();
  const dn = db.prepare('SELECT id, document_type, sales_bill_pending FROM delivery_notes WHERE id=?').get(req.params.id);
  if (!dn) return res.status(404).json({ error: 'Dispatch not found' });
  if (!dn.sales_bill_pending) {
    return res.status(400).json({ error: 'This dispatch is not marked sales_bill_pending. Nothing to add.' });
  }
  const sales_bill_number = String(b.sales_bill_number || '').trim();
  if (!sales_bill_number) {
    return res.status(400).json({ error: 'Sales Bill number is required' });
  }
  let sbFilePath = null;
  if (req.file) {
    try {
      const safeName = (req.file.originalname || 'sales-bill').replace(/[^a-zA-Z0-9._-]/g, '_');
      const newName = `${Date.now()}-${safeName}`;
      const newPath = path.join(path.dirname(req.file.path), newName);
      fs.renameSync(req.file.path, newPath);
      sbFilePath = `/uploads/${newName}`;
    } catch (e) {
      sbFilePath = `/uploads/${req.file.filename}`;
    }
  }
  db.prepare(
    `UPDATE delivery_notes
       SET sales_bill_pending = 0,
           sales_bill_number = ?,
           sales_bill_file_path = COALESCE(?, sales_bill_file_path),
           sales_bill_uploaded_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(sales_bill_number, sbFilePath, req.params.id);
  res.json({ ok: true, sales_bill_number, sales_bill_file_path: sbFilePath });
});

// GENERATE a Sales Bill (invoice) from a challan — mam (2026-06-04):
// "sales bill generate, not upload".  Builds a new sales_bill delivery
// note from the challan's items (from-store challan → its items_json;
// PO challan → the BOQ items at selling rates), links it back to the
// challan, and flags is_draft when client GSTIN / rates are missing.
// Returns the new sales bill id so the client can open its printable
// invoice.  Idempotent: returns the existing one if already generated.
router.post('/delivery-notes/:id/generate-sales-bill', needsApprove, (req, res) => {
  const db = getDb();
  const challan = db.prepare('SELECT * FROM delivery_notes WHERE id=?').get(req.params.id);
  if (!challan) return res.status(404).json({ error: 'Dispatch not found' });

  // Already generated?  Return the linked Sales Bill.
  if (challan.sales_bill_number) {
    const existing = db.prepare("SELECT id, document_number, is_draft FROM delivery_notes WHERE document_type='sales_bill' AND document_number=?").get(challan.sales_bill_number);
    if (existing) return res.json({ id: existing.id, document_number: existing.document_number, is_draft: existing.is_draft, existing: true });
  }

  let items = [];
  let indentId = challan.indent_id || null;
  if (challan.source === 'store') {
    try {
      const arr = JSON.parse(challan.items_json || '[]');
      items = (arr || []).map(it => ({
        description: it.description || '', qty: +it.qty || +it.quantity || 0, unit: it.unit || '',
        rate: +it.rate || 0, amount: (+it.qty || +it.quantity || 0) * (+it.rate || 0),
        hsn: it.hsn || '', item_code: it.item_code || '',
      }));
    } catch (_) {}
  } else if (challan.vendor_po_id) {
    const billable = db.prepare(`
      SELECT vpi.quantity,
             COALESCE(NULLIF(TRIM(im.item_name), ''), NULLIF(TRIM(ii.description), ''), poi.description) as description,
             COALESCE(ii.unit, poi.unit, im.uom) as unit, COALESCE(poi.rate, 0) as rate, poi.hsn_code, im.item_code
        FROM vendor_po_items vpi
        LEFT JOIN indent_items ii ON ii.id = vpi.indent_item_id
        LEFT JOIN po_items poi ON poi.id = ii.po_item_id
        LEFT JOIN item_master im ON im.id = ii.item_master_id
       WHERE vpi.vendor_po_id = ? AND UPPER(COALESCE(ii.item_type, '')) = 'PO'
    `).all(challan.vendor_po_id);
    items = billable.map(it => ({
      description: it.description || '', qty: +it.quantity || 0, unit: it.unit || '',
      rate: +it.rate || 0, amount: (+it.quantity || 0) * (+it.rate || 0), hsn: it.hsn_code || '', item_code: it.item_code || '',
    }));
    if (!indentId) indentId = db.prepare('SELECT indent_id FROM vendor_pos WHERE id=?').get(challan.vendor_po_id)?.indent_id || null;
  }
  if (!items.length) return res.status(400).json({ error: 'No billable items found on this challan to generate a Sales Bill.' });

  const client = db.prepare(`SELECT bb.gstin FROM indents i LEFT JOIN order_planning op ON op.id=i.planning_id LEFT JOIN business_book bb ON bb.id=op.business_book_id WHERE i.id=?`).get(indentId) || {};
  const isDraft = (items.some(it => !(it.rate > 0)) || !client.gstin) ? 1 : 0;
  const { nextSequence } = require('../db/nextSequence');
  const year = new Date().getFullYear();
  const invNum = nextSequence(db, 'delivery_notes', 'document_number', 'GST/26-26/', { startFrom: 60, pad: 2 });
  const today = new Date().toISOString().slice(0, 10);
  const sb = db.prepare(`
    INSERT INTO delivery_notes (vendor_po_id, indent_id, source, delivery_date, document_type, document_number, status, is_draft, items_json, notes)
    VALUES (?, ?, ?, ?, 'sales_bill', ?, 'pending', ?, ?, ?)
  `).run(challan.vendor_po_id || null, indentId, challan.source || 'po', today, invNum, isDraft, JSON.stringify(items),
         isDraft ? 'Generated Sales Bill — DRAFT (fill client GSTIN / selling rates before sending)' : 'Generated Sales Bill');
  db.prepare("UPDATE delivery_notes SET sales_bill_pending=0, sales_bill_number=? WHERE id=?").run(invNum, req.params.id);
  res.json({ id: sb.lastInsertRowid, document_number: invNum, is_draft: isDraft, items: items.length });
});

// Edit the SELLING rate per line on a generated Sales Bill (mam 2026-06-30: "also
// with rate"). Updates items_json (rate + amount = qty × rate) and clears the
// DRAFT flag once every line has a rate, so the Tax Invoice shows real amounts.
// Writes both qty + quantity so whichever field the print reads is populated.
router.put('/delivery-notes/:id/rates', needsApprove, (req, res) => {
  const db = getDb();
  const dn = db.prepare("SELECT * FROM delivery_notes WHERE id=? AND document_type='sales_bill'").get(req.params.id);
  if (!dn) return res.status(404).json({ error: 'Sales bill not found' });
  let items = [];
  try { items = JSON.parse(dn.items_json || '[]'); } catch (_) { items = []; }
  if (!items.length) return res.status(400).json({ error: 'No items on this sales bill' });
  const rates = Array.isArray(req.body?.rates) ? req.body.rates : [];
  const updated = items.map((it, i) => {
    const r = (rates[i] != null && rates[i] !== '') ? +rates[i] : (+it.rate || 0);
    const qty = +it.qty || +it.quantity || 0;
    return { ...it, qty, quantity: qty, rate: r, amount: Math.round(qty * r * 100) / 100 };
  });
  const allRated = updated.every(it => (+it.rate || 0) > 0);
  db.prepare('UPDATE delivery_notes SET items_json=?, is_draft=? WHERE id=?')
    .run(JSON.stringify(updated), allRated ? 0 : 1, dn.id);
  res.json({ ok: true, is_draft: allRated ? 0 : 1, lines: updated.length });
});

// Mark a dispatch as "Received by <name> on <date>" and attach the stamped +
// signed receipt photo as proof. Mam flagged this as business-critical: without
// the signed proof, clients sometimes deny receipt and SEPL eats the loss.
// Multipart so the receipt photo can ride along with the metadata.
router.patch('/delivery-notes/:id/receive', needsApprove, vendorPoUpload.single('file'), (req, res) => {
  const b = req.body || {};
  const received_by_name = b.received_by_name;
  const received_at = b.received_at;
  if (!received_by_name || !String(received_by_name).trim()) {
    return res.status(400).json({ error: 'Received-by name is required' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Receipt proof photo is required — attach the stamped + signed document' });
  }
  const db = getDb();
  const existing = db.prepare('SELECT id FROM delivery_notes WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Dispatch not found' });

  // Rename + persist the uploaded receipt photo under /uploads
  let receiptPath = null;
  if (req.file) {
    try {
      const safeName = (req.file.originalname || 'receipt').replace(/[^a-zA-Z0-9._-]/g, '_');
      const newName = `${Date.now()}-${safeName}`;
      const newPath = path.join(path.dirname(req.file.path), newName);
      fs.renameSync(req.file.path, newPath);
      receiptPath = `/uploads/${newName}`;
    } catch (e) {
      receiptPath = `/uploads/${req.file.filename}`;
    }
  }

  // Optional inventory hook — if mam picked a warehouse_id, the items
  // from the linked vendor_po auto-land as stock IN. Skipped silently if
  // no warehouse selected (legacy behavior).
  const warehouseId = b.warehouse_id ? +b.warehouse_id : null;

  // sales_bill_pending — mam (2026-05-25): when the receipt is a DN
  // and the Sales Bill is still pending.  Stored on the dispatch row
  // so the amber "📋 SB PENDING" chip shows in the list until SB
  // arrives via /sales-bill endpoint.
  const sbPendingFlag = (b.sales_bill_pending === '1' || b.sales_bill_pending === 1 || b.sales_bill_pending === true) ? 1 : null;

  // Mam (2026-06-02): "according to delivery note all items and qty
  // show here may delivery note item of qty 10 but when erec its 9".
  // The receive form now sends `items_received` — a JSON array per
  // line with { vendor_po_item_id, ordered_qty, received_qty,
  // short_reason }.  We persist it to delivery_notes.items_json for
  // the audit trail (claim vs received) AND use received_qty as the
  // stock-IN amount instead of vendor_po_items.quantity, so partial
  // receipts (delivery short by 1) don't over-credit inventory.
  let itemsReceivedJson = null;
  let itemsReceivedArr = null;
  if (b.items_received) {
    try {
      const raw = typeof b.items_received === 'string' ? JSON.parse(b.items_received) : b.items_received;
      if (Array.isArray(raw)) {
        // Coerce and clamp received_qty: must be ≥ 0 and ≤ ordered_qty.
        itemsReceivedArr = raw.map(r => ({
          vendor_po_item_id: r.vendor_po_item_id ? +r.vendor_po_item_id : null,
          ordered_qty:       Number.isFinite(+r.ordered_qty) ? +r.ordered_qty : 0,
          received_qty:      Number.isFinite(+r.received_qty) ? Math.max(0, +r.received_qty) : 0,
          short_reason:      r.short_reason ? String(r.short_reason).slice(0, 200) : null,
          description:       r.description || null,
        }));
        itemsReceivedJson = JSON.stringify(itemsReceivedArr);
      }
    } catch (e) {
      // Bad JSON — ignore silently and fall back to ordered qty stock-IN.
    }
  }

  try {
    db.prepare(
      `UPDATE delivery_notes
         SET received_by_name = ?,
             received_at = COALESCE(?, CURRENT_TIMESTAMP),
             receipt_file_path = COALESCE(?, receipt_file_path),
             status = 'received',
             warehouse_id = COALESCE(?, warehouse_id),
             sales_bill_pending = COALESCE(?, sales_bill_pending),
             items_json = COALESCE(?, items_json)
       WHERE id = ?`
    ).run(String(received_by_name).trim(), received_at || null, receiptPath, warehouseId, sbPendingFlag, itemsReceivedJson, req.params.id);

    // INVENTORY AUTO-IN — best effort; never blocks the receipt save.
    let stockIns = 0;
    if (warehouseId) {
      try {
        // Pull the line items via vendor_po → vendor_po_items → indent_items.
        // When mam sent per-line received_qty (items_received), build a
        // {vendor_po_item_id → received_qty} map and use it for stock IN.
        // Falls back to ordered qty (vpi.quantity) if no override sent.
        const dn = db.prepare('SELECT vendor_po_id FROM delivery_notes WHERE id=?').get(req.params.id);
        if (dn?.vendor_po_id) {
          const items = db.prepare(
            `SELECT vpi.id as vpi_id, vpi.quantity, vpi.rate, ii.item_master_id, ii.description
               FROM vendor_po_items vpi
               LEFT JOIN indent_items ii ON ii.id = vpi.indent_item_id
              WHERE vpi.vendor_po_id = ?`
          ).all(dn.vendor_po_id);

          const receivedByVpi = new Map();
          if (Array.isArray(itemsReceivedArr)) {
            for (const r of itemsReceivedArr) {
              if (r.vendor_po_item_id != null) receivedByVpi.set(+r.vendor_po_item_id, +r.received_qty);
            }
          }

          // Idempotency: skip if movements for this delivery_note already exist
          const refId = `DN-${req.params.id}`;
          const existingMv = db.prepare(
            `SELECT 1 FROM stock_movements WHERE reference_type='RECEIVE' AND reference_id=? LIMIT 1`
          ).get(refId);
          if (!existingMv) {
            const tx = db.transaction(() => {
              for (const i of items) {
                if (!i.item_master_id) continue;
                // Prefer per-line received qty when mam supplied it; else
                // ordered qty.  Skip rows that ended up at 0 (e.g. 10
                // ordered, 0 received → don't increment stock).
                const recOverride = receivedByVpi.has(i.vpi_id) ? receivedByVpi.get(i.vpi_id) : null;
                const qty = recOverride != null ? +recOverride : +i.quantity;
                if (!(qty > 0)) continue;
                const cur = db.prepare('SELECT * FROM stock_balance WHERE warehouse_id=? AND item_master_id=?').get(warehouseId, i.item_master_id);
                const prevQty = cur ? +cur.quantity : 0;
                const prevRate = cur ? +cur.avg_rate : 0;
                const rate = +(i.rate || 0);
                const newQty = prevQty + qty;
                const newAvg = newQty > 0 ? ((prevQty * prevRate) + (qty * rate)) / newQty : 0;
                if (cur) db.prepare('UPDATE stock_balance SET quantity=?, avg_rate=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(newQty, newAvg, cur.id);
                else db.prepare('INSERT INTO stock_balance (warehouse_id, item_master_id, quantity, avg_rate) VALUES (?,?,?,?)').run(warehouseId, i.item_master_id, newQty, newAvg);
                const noteSuffix = recOverride != null && recOverride < +i.quantity
                  ? ` (short receipt: ${recOverride}/${i.quantity})`
                  : '';
                db.prepare(
                  `INSERT INTO stock_movements
                    (warehouse_id, item_master_id, type, quantity, rate, total_value,
                     reference_type, reference_id, notes, created_by)
                   VALUES (?,?,?,?,?,?,?,?,?,?)`
                ).run(warehouseId, i.item_master_id, 'IN', qty, rate, qty * rate, 'RECEIVE', refId, `Auto-IN from delivery note #${req.params.id}${noteSuffix}`, req.user.id);
                stockIns += 1;
              }
            });
            tx();
          }
        }
      } catch (e) {
        console.error('[receive] auto-IN failed (receipt saved anyway):', e.message);
      }
    }

    // Auto SHORT-SUPPLY DEBIT NOTE (mam 2026-06-04): when material is
    // received SHORT (received < ordered), raise a short-supply debit
    // automatically — mirrors the auto extra-rate debit at bill entry.
    // Value = shortfall qty × PO rate. One per delivery note (guarded via
    // a [DN-<id>] marker in the reason).
    let autoDebit = null;
    try {
      if (Array.isArray(itemsReceivedArr) && itemsReceivedArr.some(r => +r.received_qty < +r.ordered_qty)) {
        const dnRow = db.prepare('SELECT vendor_po_id FROM delivery_notes WHERE id=?').get(req.params.id);
        const poId = dnRow?.vendor_po_id || null;
        if (poId) {
          const po = db.prepare('SELECT vendor_id FROM vendor_pos WHERE id=?').get(poId);
          const rateByVpi = new Map();
          for (const it of db.prepare('SELECT id, rate FROM vendor_po_items WHERE vendor_po_id=?').all(poId)) rateByVpi.set(it.id, +it.rate || 0);
          const lines = []; let amt = 0;
          for (const r of itemsReceivedArr) {
            const shortQty = Math.max(0, (+r.ordered_qty || 0) - (+r.received_qty || 0));
            if (shortQty <= 0) continue;
            const rate = r.vendor_po_item_id != null ? (rateByVpi.get(+r.vendor_po_item_id) || 0) : 0;
            const lineAmt = shortQty * rate;
            amt += lineAmt;
            lines.push({ description: r.description || 'Item', unit: '', qty: shortQty, rate, amount: lineAmt, remarks: r.short_reason || '' });
          }
          const marker = `[DN-${req.params.id}]`;
          const exists = db.prepare("SELECT id FROM debit_notes WHERE vendor_po_id=? AND type='short_supply' AND reason LIKE ?").get(poId, '%' + marker + '%');
          if (lines.length && amt > 0 && !exists) {
            const { nextSequence } = require('../db/nextSequence');
            const year = new Date().getFullYear();
            const dnNum = nextSequence(db, 'debit_notes', 'dn_number', `DBN/${year}/`, { pad: 4 });
            const dr = db.prepare(
              `INSERT INTO debit_notes (dn_number, type, vendor_po_id, vendor_id, amount, reason, items_json, status, created_by)
               VALUES (?, 'short_supply', ?, ?, ?, ?, ?, 'open', ?)`
            ).run(dnNum, poId, po?.vendor_id || null, Math.round(amt * 100) / 100,
              `Auto-raised on receiving: short supply (ordered vs received shortfall). ${marker}`,
              JSON.stringify(lines), req.user.id);
            autoDebit = { id: dr.lastInsertRowid, dn_number: dnNum, type: 'short_supply', amount: Math.round(amt * 100) / 100 };
          }
        }
      }
    } catch (e) { console.error('[receive] auto short-supply debit failed (receipt saved anyway):', e.message); }

    // S16 (mam 2026-06-09): notify the site engineer (the indent raiser)
    // ONLY when there's a receiving MISMATCH (a short-supply debit was
    // auto-raised). WhatsApp + SMS + email, all best-effort — never blocks
    // the receipt. No notification on a clean, fully-matched receipt.
    if (autoDebit) {
      try {
        const eng = db.prepare(`
          SELECT u.name, u.email, u.phone
            FROM delivery_notes dn
            JOIN vendor_pos vp ON vp.id = dn.vendor_po_id
            JOIN indents i ON i.id = vp.indent_id
            JOIN users u ON u.id = i.created_by
           WHERE dn.id = ?`).get(req.params.id);
        if (eng) {
          const msg = `Material received SHORT on receiving. Debit note ${autoDebit.dn_number} (Rs ${autoDebit.amount}) auto-raised — please verify physically. — Secured Engineers`;
          if (eng.phone) require('../services/notify').sendText({ mobile: eng.phone, body: msg }).catch(() => {});
          if (eng.email) {
            const { sendEmail } = require('../lib/email');
            sendEmail({ to: eng.email, subject: `Short supply on receiving — ${autoDebit.dn_number}`, html: `<p>Hi ${eng.name || ''},</p><p>${msg}</p>` }).catch(() => {});
          }
        }
      } catch (e) { console.error('[receive] S16 engineer mismatch notify failed:', e.message); }
    }

    // Auto SALES BILL on receive (mam 2026-06-04): when a CHALLAN is marked
    // received and its PO has billable PO-type items, auto-generate a Sales
    // Bill (INV/) from the BOQ items at their selling rates.  FOC/RGP-only
    // challans get NO sales bill — the challan IS the delivery note.  The
    // bill is flagged is_draft when client GSTIN or any selling rate is
    // missing.  Skipped if a Sales Bill already exists for the PO.
    let autoSalesBill = null;
    try {
      const dnRow = db.prepare("SELECT vendor_po_id, indent_id, document_type, sales_bill_number FROM delivery_notes WHERE id=?").get(req.params.id);
      if (dnRow && dnRow.document_type === 'challan' && dnRow.vendor_po_id && !dnRow.sales_bill_number) {
        const billable = db.prepare(`
          SELECT vpi.quantity,
                 COALESCE(NULLIF(TRIM(im.item_name), ''), NULLIF(TRIM(ii.description), ''), poi.description) as description,
                 COALESCE(ii.unit, poi.unit, im.uom) as unit,
                 COALESCE(poi.rate, 0) as rate, poi.hsn_code, im.item_code
            FROM vendor_po_items vpi
            LEFT JOIN indent_items ii ON ii.id = vpi.indent_item_id
            LEFT JOIN po_items poi ON poi.id = ii.po_item_id
            LEFT JOIN item_master im ON im.id = ii.item_master_id
           WHERE vpi.vendor_po_id = ? AND UPPER(COALESCE(ii.item_type, '')) = 'PO'
        `).all(dnRow.vendor_po_id);
        const existingSB = db.prepare("SELECT id FROM delivery_notes WHERE vendor_po_id=? AND document_type='sales_bill'").get(dnRow.vendor_po_id);
        if (billable.length && !existingSB) {
          const client = db.prepare(`
            SELECT bb.gstin FROM indents i
              LEFT JOIN order_planning op ON op.id = i.planning_id
              LEFT JOIN business_book bb ON bb.id = op.business_book_id
             WHERE i.id = ?`).get(dnRow.indent_id) || {};
          const items = billable.map(it => ({
            description: it.description || '', qty: +it.quantity || 0, unit: it.unit || '',
            rate: +it.rate || 0, amount: (+it.quantity || 0) * (+it.rate || 0),
            hsn: it.hsn_code || '', item_code: it.item_code || '',
          }));
          const isDraft = (items.some(it => !(it.rate > 0)) || !client.gstin) ? 1 : 0;
          const { nextSequence } = require('../db/nextSequence');
          const year = new Date().getFullYear();
          const invNum = nextSequence(db, 'delivery_notes', 'document_number', 'GST/26-26/', { startFrom: 60, pad: 2 });
          const today = new Date().toISOString().slice(0, 10);
          const sb = db.prepare(`
            INSERT INTO delivery_notes (vendor_po_id, indent_id, source, delivery_date, document_type, document_number, status, is_draft, items_json, notes)
            VALUES (?, ?, 'po', ?, 'sales_bill', ?, 'pending', ?, ?, ?)
          `).run(dnRow.vendor_po_id, dnRow.indent_id, today, invNum, isDraft, JSON.stringify(items),
                 isDraft ? 'Auto-generated on receive — DRAFT (fill client GSTIN / selling rates before sending)' : 'Auto-generated Sales Bill on receive');
          db.prepare("UPDATE delivery_notes SET sales_bill_pending=0, sales_bill_number=? WHERE id=?").run(invNum, req.params.id);
          autoSalesBill = { id: sb.lastInsertRowid, document_number: invNum, is_draft: isDraft, items: items.length };
        }
      }
    } catch (e) { console.error('[receive] auto sales bill failed (receipt saved anyway):', e.message); }

    res.json({ message: 'Marked as received', receipt_file_path: receiptPath, stock_ins: stockIns, auto_debit: autoDebit, auto_sales_bill: autoSalesBill });
  } catch (err) {
    if (receiptPath) { try { fs.unlinkSync(path.join(uploadDir, path.basename(receiptPath))); } catch (e) {} }
    res.status(500).json({ error: err.message });
  }
});

router.put('/delivery-notes/:id', (req, res) => {
  const { status, notes } = req.body;
  getDb().prepare('UPDATE delivery_notes SET status=?, notes=? WHERE id=?').run(status, notes, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/delivery-notes/:id', (req, res) => {
  getDb().prepare('DELETE FROM delivery_notes WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Pre-fill items for the Sales Bill / Delivery Note modal. Mam picks a
// vendor PO; the modal needs the Client PO line items (po_items) so she
// can tweak qty / rate / disc % per row before generating. We resolve
// the same chain the print endpoint uses:
//   vendor_pos.indent_id → indents.planning_id → order_planning.business_book_id
//   → po_items.business_book_id
// Returns the po_items in the order they were entered. Client-side falls
// back to vendor_po_items if nothing comes back.
// Resolve "Bill To" client info for a Vendor PO — used by the
// Create Sales Bill modal to pre-fill the customer block.  Same
// chain the print endpoint uses (vendor_pos → indents →
// order_planning → business_book) plus the linked client PO if any.
// Mam (2026-05-16): "no client / bill-to block" was issue #1 on
// the modal review.
router.get('/vendor-pos/:id/bill-to', (req, res) => {
  const db = getDb();
  const r = db.prepare(`
    SELECT bb.id as business_book_id, bb.lead_no,
           bb.company_name AS client_company,
           bb.client_name  AS client_person_name,
           bb.project_name,
           bb.client_contact AS client_phone, bb.client_email,
           bb.billing_address AS client_address,
           bb.shipping_address AS site_address,
           bb.state AS client_state,
           bb.district AS client_district,
           bb.gstin AS client_gstin,
           bb.state_code AS client_state_code,
           po.po_number AS client_po_number, po.po_date AS client_po_date,
           v.name AS vendor_name, vp.po_number AS vendor_po_no,
           COALESCE(NULLIF(TRIM(ind.site_name), ''), bb.project_name) AS site_name
    FROM vendor_pos vp
    LEFT JOIN vendors v ON vp.vendor_id = v.id
    LEFT JOIN indents ind ON vp.indent_id = ind.id
    LEFT JOIN order_planning op ON ind.planning_id = op.id
    LEFT JOIN business_book bb ON bb.id = op.business_book_id
    LEFT JOIN purchase_orders po ON op.po_id = po.id
    WHERE vp.id = ?
  `).get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Vendor PO not found' });
  res.json(r);
});

// Shared core for the client-facing line items of a Vendor PO. Used by
// GET /vendor-pos/:id/client-po-items AND the server-side auto-sales-bill
// generator below, so both produce identical items + rates.  For a sales
// bill, rate = BOQ SITC rate × the order's Against-Delivery %.
function computeClientPoItems(db, vendorPoId, isSalesBill) {
  // Scope to THIS Vendor PO's items (mam 2026-05-25: "you pick all not
  // pick all boq boq fill indent so here is indent wise").
  const rows = db.prepare(`
    SELECT vpi.id,
           COALESCE(NULLIF(TRIM(im.item_name), ''),
                    NULLIF(TRIM(ii.description), ''),
                    poi.description) as description,
           vpi.quantity,
           COALESCE(ii.unit, poi.unit, im.uom) as unit,
           COALESCE(poi.rate, 0) as rate,
           COALESCE(poi.amount, 0) as amount,
           poi.hsn_code,
           im.item_code, im.specification, im.size, im.gst AS gst_text,
           COALESCE(NULLIF(TRIM(im.item_name), ''), NULLIF(TRIM(ii.description), '')) as item_name,
           vpi.rate as vendor_rate,
           poi.id as po_item_id
      FROM vendor_po_items vpi
      LEFT JOIN indent_items ii ON ii.id = vpi.indent_item_id
      LEFT JOIN po_items poi ON poi.id = ii.po_item_id
      LEFT JOIN item_master im ON im.id = ii.item_master_id
     WHERE vpi.vendor_po_id = ?
     ORDER BY vpi.id
  `).all(vendorPoId);

  if (isSalesBill) {
    // Sales-bill RATE = the FULL BOQ SITC rate (MD 2026-06-15: "sales bill
    // rate full is ok ... dont change it" — do NOT reduce by Against-Delivery
    // %). The delivery % is still read + returned for reference only.
    let pct = 0; const byId = new Map(), byDesc = new Map();
    try {
      const bbRow = db.prepare(
        `SELECT op.business_book_id AS bb FROM vendor_pos vp
           LEFT JOIN indents i ON i.id = vp.indent_id
           LEFT JOIN order_planning op ON op.id = i.planning_id
          WHERE vp.id = ?`
      ).get(vendorPoId);
      const bbId = bbRow && bbRow.bb;
      if (bbId) {
        const bb = db.prepare('SELECT payment_against_delivery FROM business_book WHERE id=?').get(bbId);
        pct = parseFloat(String((bb && bb.payment_against_delivery) || '').replace(/[^0-9.]/g, '')) || 0;
        for (const it of db.prepare('SELECT id, description, rate FROM po_items WHERE business_book_id=?').all(bbId)) {
          byId.set(it.id, +it.rate || 0);
          if (it.description) byDesc.set(String(it.description).toLowerCase().trim(), +it.rate || 0);
        }
      }
    } catch (_) {}
    const r2 = n => Math.round((+n || 0) * 100) / 100;
    for (const r of rows) {
      let boq = +r.rate || 0;
      if (!boq && r.po_item_id != null && byId.has(r.po_item_id)) boq = byId.get(r.po_item_id);
      if (!boq) boq = byDesc.get(String(r.description || '').toLowerCase().trim()) || 0;
      r.boq_rate = boq;
      r.rate = boq;                    // full BOQ SITC rate — no delivery-% reduction
      r.amount = r2(boq * (+r.quantity || 0));
    }
    const withRate = rows.filter(r => +r.rate > 0).length;
    const noRate = rows.length - withRate;
    return {
      items: rows,
      source: 'vendor_po_items',
      rate_source: noRate === 0 ? 'boq_sitc' : (withRate > 0 ? 'boq_sitc_partial' : 'rate_missing'),
      delivery_pct: pct,
      warning: noRate === 0 ? null
        : `${noRate} of ${rows.length} line(s) have no BOQ SITC rate — fill the selling rate before saving.`,
      rated_count: withRate,
      total_count: rows.length,
    };
  }

  // Challan / non-billable doc — vendor cost is fine for internal docs.
  const vpRowsWithCost = rows.map(r => ({ ...r, rate: +r.rate > 0 ? r.rate : (+r.vendor_rate || 0) }));
  return { items: vpRowsWithCost, source: 'vendor_po_items', rate_source: 'mixed' };
}

// Auto-generate the client SALES BILL for a Vendor PO, server-side, with no
// human click (mam 2026-06-15: "i dont want to dispatch button click auto
// generated").  Idempotent (skips if a sales bill already exists) and SAFE
// (only bills when EVERY line has a rate — partial/unrated POs are left for
// manual handling so we never bill a wrong amount).  Returns {id,
// document_number} on create, or {skipped:<reason>}.
function autoGenerateSalesBillForPO(db, vendorPoId, userId) {
  if (!vendorPoId) return { skipped: 'no_po' };
  const existing = db.prepare(
    `SELECT id, document_number FROM delivery_notes WHERE vendor_po_id=? AND document_type='sales_bill' LIMIT 1`
  ).get(vendorPoId);
  if (existing) return { skipped: 'exists', id: existing.id, document_number: existing.document_number };

  const data = computeClientPoItems(db, vendorPoId, true);
  // Rate = full BOQ SITC rate (MD 2026-06-15: bill the full rate, no
  // Against-Delivery % reduction).
  const items = (data.items || []).filter(r => (r.description && String(r.description).trim()) || +r.quantity > 0 || +r.rate > 0);
  if (!items.length) return { skipped: 'no_items' };
  if (items.some(r => !(+r.rate > 0))) return { skipped: 'unrated' };

  const bt = db.prepare(`
    SELECT bb.state AS client_state, bb.state_code AS client_state_code
      FROM vendor_pos vp
      LEFT JOIN indents i ON i.id = vp.indent_id
      LEFT JOIN order_planning op ON op.id = i.planning_id
      LEFT JOIN business_book bb ON bb.id = op.business_book_id
     WHERE vp.id = ?`).get(vendorPoId) || {};
  const sameState = String(bt.client_state || '').toLowerCase() === 'punjab';
  const cgst_pct = sameState ? 9 : 0, sgst_pct = sameState ? 9 : 0, igst_pct = sameState ? 0 : 18;

  const r2 = n => Math.round((+n || 0) * 100) / 100;
  const payloadItems = items.map(it => {
    const qty = +it.quantity || 0, rate = +it.rate || 0;
    return {
      description: [it.description, it.specification, it.size].filter(Boolean).join(' / ') || it.item_name || '',
      hsn: it.hsn_code || '', unit: it.unit || '',
      quantity: qty, rate, disc_pct: 0, amount: r2(qty * rate),
      item_code: it.item_code || '', specification: it.specification || '', size: it.size || '', item_name: it.item_name || '',
    };
  });
  const subtotal = r2(payloadItems.reduce((s, it) => s + (it.amount || 0), 0));
  const grand = r2(subtotal + subtotal * (cgst_pct + sgst_pct + igst_pct) / 100);

  const { nextSequence } = require('../db/nextSequence');
  const document_number = nextSequence(db, 'delivery_notes', 'document_number', 'GST/26-26/', { startFrom: 60, pad: 2 });

  const ins = db.prepare(
    `INSERT INTO delivery_notes (vendor_po_id, delivery_date, received_by, document_type, document_number,
        place_of_supply, state_code, reverse_charge, cgst_pct, sgst_pct, igst_pct,
        freight_amount, round_off_amount, subtotal_amount, grand_total_amount, items_json, sales_bill_pending)
     VALUES (?, ?, ?, 'sales_bill', ?, ?, ?, 0, ?, ?, ?, 0, 0, ?, ?, ?, 0)`
  ).run(vendorPoId, new Date().toISOString().slice(0, 10), userId || null, document_number,
        bt.client_state || null, bt.client_state_code || null,
        cgst_pct, sgst_pct, igst_pct, subtotal, grand, JSON.stringify(payloadItems));
  return { id: ins.lastInsertRowid, document_number };
}

router.get('/vendor-pos/:id/client-po-items', (req, res) => {
  const db = getDb();
  // Sales Bill must always quote the BOQ SITC rate (mam, 2026-05-16:
  // "if sales bill we enter BOQ SITC rate which you can now according
  // BOQ rate").  Pass ?doc_type=sales_bill to disable the vendor-cost
  // fallback — better empty + clear warning than wrong rate billed.
  const docType = String(req.query.doc_type || '').toLowerCase();
  const isSalesBill = docType === 'sales_bill';
  return res.json(computeClientPoItems(db, req.params.id, isSalesBill));
});

// Sweep: auto-generate the client Sales Bill for every PO that's ready to
// dispatch (has a Purchase Bill, no sales bill yet) — fired automatically
// when mam opens the Dispatch tab so bills appear with NO click.
router.post('/auto-sales-bills/sweep', needsApprove, (req, res) => {
  const db = getDb();
  let candidates = [];
  try {
    candidates = db.prepare(`
      SELECT DISTINCT vp.id AS id
        FROM vendor_pos vp
        JOIN purchase_bills pb ON pb.vendor_po_id = vp.id
       WHERE vp.id NOT IN (
               SELECT vendor_po_id FROM delivery_notes
                WHERE document_type='sales_bill' AND vendor_po_id IS NOT NULL)
    `).all();
  } catch (e) { return res.status(500).json({ error: e.message }); }
  const generated = [], skipped = [];
  for (const c of candidates) {
    try {
      const r = autoGenerateSalesBillForPO(db, c.id, req.user?.id);
      if (r && r.id) generated.push({ vendor_po_id: c.id, ...r });
      else skipped.push({ vendor_po_id: c.id, reason: r?.skipped || 'unknown' });
    } catch (e) { skipped.push({ vendor_po_id: c.id, reason: e.message }); }
  }
  res.json({ generated_count: generated.length, generated, skipped });
});

// Legacy alias retained for clarity — original inline body kept below was
// replaced by computeClientPoItems(); guard block left intentionally blank.
function _clientPoItemsUnusedTail() {
  const db = getDb();
  const isSalesBill = false;
  // Scope to THIS Vendor PO's items (mam 2026-05-25: "you pick all not
  // pick all boq boq fill indent so here is indent wise").  Earlier
  // version loaded the entire Client PO BOQ (~all items for the
  // business_book) which dumped 15+ unrelated lines into the Sales
  // Bill.  Correct path:
  //   vendor_po_items → indent_items (their qty + linkage) → po_items
  //   (the BOQ row that supplies the SITC rate).
  // Returns ONE row per vendor_po_item, with:
  //   - quantity from vendor_po_items (the qty actually PO'd, not the
  //     full BOQ qty)
  //   - rate from po_items (BOQ SITC rate — what we BILL the client)
  //   - description + spec + size from item_master where possible,
  //     fallback to po_items.description, then indent_items.description
  //   - HSN from po_items
  // This way the Sales Bill is exactly the items in THIS PO at the
  // client-facing rates.
  const rows = db.prepare(`
    SELECT vpi.id,
           -- Description = the INDENT-wise item name (mam 2026-06-04):
           -- item-master name first, then the indent line's own
           -- description, and only fall back to the verbose BOQ SITC text.
           COALESCE(NULLIF(TRIM(im.item_name), ''),
                    NULLIF(TRIM(ii.description), ''),
                    poi.description) as description,
           vpi.quantity,
           COALESCE(ii.unit, poi.unit, im.uom) as unit,
           COALESCE(poi.rate, 0) as rate,
           COALESCE(poi.amount, 0) as amount,
           poi.hsn_code,
           im.item_code, im.specification, im.size, im.gst AS gst_text,
           -- A clear item label for the UI even when there's no master link.
           COALESCE(NULLIF(TRIM(im.item_name), ''), NULLIF(TRIM(ii.description), '')) as item_name,
           vpi.rate as vendor_rate,
           poi.id as po_item_id
      FROM vendor_po_items vpi
      LEFT JOIN indent_items ii ON ii.id = vpi.indent_item_id
      LEFT JOIN po_items poi ON poi.id = ii.po_item_id
      LEFT JOIN item_master im ON im.id = ii.item_master_id
     WHERE vpi.vendor_po_id = ?
     ORDER BY vpi.id
  `).all(req.params.id);

  if (isSalesBill) {
    // Sales-bill RATE = BOQ SITC rate × the order's Against-Delivery %
    // (mam 2026-06-15: "boq item rate × against delivery terms %"). Resolve
    // this PO's Business Book order, then the BOQ rate per line (po_item link
    // first, then a description match), then apply the %.
    let pct = 0; const byId = new Map(), byDesc = new Map();
    try {
      const bbRow = db.prepare(
        `SELECT op.business_book_id AS bb FROM vendor_pos vp
           LEFT JOIN indents i ON i.id = vp.indent_id
           LEFT JOIN order_planning op ON op.id = i.planning_id
          WHERE vp.id = ?`
      ).get(req.params.id);
      const bbId = bbRow && bbRow.bb;
      if (bbId) {
        const bb = db.prepare('SELECT payment_against_delivery FROM business_book WHERE id=?').get(bbId);
        pct = parseFloat(String((bb && bb.payment_against_delivery) || '').replace(/[^0-9.]/g, '')) || 0;
        for (const it of db.prepare('SELECT id, description, rate FROM po_items WHERE business_book_id=?').all(bbId)) {
          byId.set(it.id, +it.rate || 0);
          if (it.description) byDesc.set(String(it.description).toLowerCase().trim(), +it.rate || 0);
        }
      }
    } catch (_) {}
    const r2 = n => Math.round((+n || 0) * 100) / 100;
    for (const r of rows) {
      let boq = +r.rate || 0;
      if (!boq && r.po_item_id != null && byId.has(r.po_item_id)) boq = byId.get(r.po_item_id);
      if (!boq) boq = byDesc.get(String(r.description || '').toLowerCase().trim()) || 0;
      r.boq_rate = boq;
      r.rate = pct > 0 ? r2(boq * pct / 100) : boq;
      r.amount = r2(r.rate * (+r.quantity || 0));
    }
    const withRate = rows.filter(r => +r.rate > 0).length;
    const noRate = rows.length - withRate;
    return res.json({
      items: rows,
      source: 'vendor_po_items',
      rate_source: noRate === 0 ? 'boq_sitc' : (withRate > 0 ? 'boq_sitc_partial' : 'rate_missing'),
      delivery_pct: pct,
      warning: noRate === 0
        ? (pct > 0 ? `Rate = BOQ SITC × ${pct}% (Against Delivery).` : null)
        : `${noRate} of ${rows.length} line(s) have no BOQ SITC rate — fill the selling rate before saving.${pct > 0 ? ` Rate shown = BOQ × ${pct}%.` : ''}`,
      rated_count: withRate,
      total_count: rows.length,
    });
  }

  // Challan / non-billable doc — vendor cost is fine for internal docs.
  const vpRowsWithCost = rows.map(r => ({ ...r, rate: +r.rate > 0 ? r.rate : (+r.vendor_rate || 0) }));
  return res.json({ items: vpRowsWithCost, source: 'vendor_po_items', rate_source: 'mixed' });

  if (rows.length) {
    // Count rows with usable rates — surfaces a warning when BOQ was
    // uploaded but rates are all zero (i.e. BOQ stub, not priced yet).
    const ratedCount = rows.filter(r => +r.rate > 0).length;
    return res.json({
      items: rows,
      source: 'po_items',
      rate_source: 'boq_sitc',
      rated_count: ratedCount,
      total_count: rows.length,
    });
  }

  // Empty-PO edge case: no vendor_po_items rows at all.  Return empty
  // list with a clear message so the UI shows the friendly empty-state
  // instead of a vague spinner.
  return res.json({
    items: [],
    source: 'empty',
    rate_source: 'none',
    warning: 'No items found on this Vendor PO. Check the source indent has BOQ-linked items.',
    rated_count: 0,
    total_count: 0,
  });
}

// Print-page renderer for a dispatch row. Returns a self-contained HTML
// page styled to match mam's SEPL Delivery Note / Sales Bill templates
// (red header, two-column blocks, 8-row item table, totals + bank +
// terms for SB, transport + receipt block for DN). The page is intended
// to be opened in a new tab; user hits Ctrl+P → prints to A4.
router.get('/delivery-notes/:id/print', (req, res) => {
  const db = getDb();
  // Resolve client + site info through:
  //   delivery_notes → vendor_pos → indents → order_planning → business_book
  // Joining business_book directly via op.business_book_id is the most
  // reliable path — going through purchase_orders.business_book_id used
  // to leave bb fields null when op.po_id was absent. mam's screenshot
  // showed empty CLIENT / COMPANY + DELIVERY SITE blocks for that
  // reason. Also prefer ind.site_name over bb.project_name when set,
  // since one BB record can have multiple indent sites.
  const dn = db.prepare(`
    SELECT dn.*, vp.po_number AS vendor_po_no,
           v.name AS vendor_name, v.gst_number AS vendor_gstin, v.address AS vendor_address,
           v.phone AS vendor_phone, v.email AS vendor_email,
           po.po_number AS client_po_no, po.po_date AS client_po_date,
           bb.company_name AS client_company, bb.client_name AS client_person_name,
           bb.client_contact AS client_phone, bb.client_email,
           bb.billing_address AS client_address, bb.shipping_address AS site_address,
           bb.state AS client_state, bb.district AS client_district,
           bb.gstin AS client_gstin, bb.state_code AS client_state_code,
           bb.payment_against_delivery AS bb_delivery_terms,
           COALESCE(NULLIF(TRIM(ind.site_name), ''), bb.project_name) AS site_name,
           ind.indent_number,
           bb.lead_no AS bb_lead_no
    FROM delivery_notes dn
    LEFT JOIN vendor_pos vp ON dn.vendor_po_id = vp.id
    LEFT JOIN vendors v ON vp.vendor_id = v.id
    -- Resolve the indent via the vendor PO, OR the DN's own indent_id for
    -- store-issue / RGP challans that have no vendor PO (mam 2026-06-15:
    -- store Delivery Note showed empty CLIENT / SITE because vp was NULL).
    LEFT JOIN indents ind ON ind.id = COALESCE(vp.indent_id, dn.indent_id)
    LEFT JOIN order_planning op ON ind.planning_id = op.id
    LEFT JOIN business_book bb ON bb.id = op.business_book_id
    LEFT JOIN purchase_orders po ON op.po_id = po.id
    WHERE dn.id = ?
  `).get(req.params.id);
  if (!dn) return res.status(404).send('Dispatch not found');

  // CLIENT + Against-Delivery % come from the Business Book ORDER the bill
  // belongs to. Resolve it robustly (mam 2026-06-15):
  //   1) the order the BILLED ITEMS belong to (po_items.business_book_id) —
  //      authoritative; the indent→order_planning path can point at the wrong
  //      order (GRA showed 40% but SEPL20175 is 60%).
  //   2) failing that, match the order by client / site NAME (Emerald bill
  //      had no BOQ-linked items, so address/order came up blank).
  // Also run for STORE / RGP challans (mam 2026-06-23: store challan showed
  // blank CLIENT address + GSTIN). They have no vendor PO and EXTRA indents
  // have no order_planning link, so the join can't reach the business book —
  // fall back to matching it by client/site name below. Vendor challans
  // (source NULL) keep their join-resolved values untouched.
  const needsBbFallback = dn.document_type === 'sales_bill'
    || (dn.document_type === 'challan' && (dn.source === 'store' || dn.source === 'rgp'));
  if (needsBbFallback) {
    let bb = null;
    if (dn.vendor_po_id) {
      try {
        const bbRow = db.prepare(`
          SELECT poi.business_book_id AS id, COUNT(*) AS n
            FROM vendor_po_items vpi
            JOIN indent_items ii ON ii.id = vpi.indent_item_id
            JOIN po_items poi ON poi.id = ii.po_item_id
           WHERE vpi.vendor_po_id = ? AND poi.business_book_id IS NOT NULL
           GROUP BY poi.business_book_id
           ORDER BY n DESC LIMIT 1`).get(dn.vendor_po_id);
        if (bbRow && bbRow.id) bb = db.prepare('SELECT * FROM business_book WHERE id=?').get(bbRow.id);
      } catch (_) {}
    }
    if (!bb) {
      const nm = String(dn.client_company || dn.site_name || '').replace(/^\s*M\/?s\.?\s*/i, '').trim();
      if (nm) {
        try {
          bb = db.prepare(`
            SELECT * FROM business_book
             WHERE UPPER(TRIM(COALESCE(company_name,''))) = UPPER(?)
                OR UPPER(TRIM(COALESCE(project_name,''))) = UPPER(?)
                OR UPPER(TRIM(COALESCE(client_name,'')))  = UPPER(?)
             ORDER BY id DESC LIMIT 1`).get(nm, nm, nm);
        } catch (_) {}
      }
    }
    if (bb) {
      // Order wins; keep existing value only where the order's field is blank.
      dn.bb_delivery_terms  = bb.payment_against_delivery;
      dn.client_company     = bb.company_name   || dn.client_company;
      dn.client_person_name = bb.client_name    || dn.client_person_name;
      dn.client_phone       = bb.client_contact || dn.client_phone;
      dn.client_email       = bb.client_email   || dn.client_email;
      dn.client_address     = bb.billing_address|| dn.client_address;
      dn.site_address       = bb.shipping_address || dn.site_address;
      dn.client_state       = bb.state          || dn.client_state;
      dn.client_state_code  = bb.state_code      || dn.client_state_code;
      dn.client_gstin       = bb.gstin          || dn.client_gstin;
      dn.bb_lead_no         = bb.lead_no         || dn.bb_lead_no;
      if (!dn.site_name)    dn.site_name = bb.project_name;
    }
  }

  // Resolve items in priority order:
  //   1) dn.items_json — per-row overrides the user tweaked in the create
  //      modal (qty / rate / disc % / include flag). Authoritative when set.
  //   2) po_items — the Client PO line items (selling price). For a SALES
  //      BILL this is what mam actually invoices; vendor cost would be wrong.
  //   3) vendor_po_items — vendor cost fallback. Used when there's no
  //      Client PO link (rare edge case for FOC challans, etc.).
  let items = [];
  let itemsSource = 'vendor_po';
  if (dn.items_json) {
    try {
      const parsed = JSON.parse(dn.items_json);
      if (Array.isArray(parsed) && parsed.length) {
        items = parsed
          .filter(it => it && it.include !== false)
          .map(it => ({
            description: it.description || '',
            // Store-issue challans write `qty`; the create-modal writes
            // `quantity` — accept either (mam 2026-06-04: store DN showed 0).
            quantity: +it.quantity || +it.qty || 0,
            unit: it.unit || '',
            rate: +it.rate || 0,
            disc_pct: +it.disc_pct || 0,
            amount: +it.amount || ((+it.quantity || +it.qty || 0) * (+it.rate || 0) * (1 - (+it.disc_pct || 0) / 100)),
            item_code: it.item_code || it.hsn || '',
            specification: it.specification || '',
            size: it.size || '',
            gst_text: it.hsn || it.gst_text || '',
            item_name: it.item_name || '',
          }));
        itemsSource = 'overrides';
      }
    } catch (_) { /* fall through to po_items */ }
  }
  // (MD 2026-06-15: sales bill bills the FULL BOQ rate — no Against-Delivery
  // % recompute. The stored items_json / po_items fallback below already
  // carry the full BOQ rate.)
  if (!items.length) {
    // Client PO line items via the chain:
    //   delivery_notes.vendor_po_id → vendor_pos.indent_id
    //   → indents.planning_id → order_planning.business_book_id
    //   → po_items.business_book_id
    const poItems = db.prepare(`
      SELECT pi.description, pi.quantity, pi.unit, pi.rate, pi.amount,
             pi.hsn_code,
             im.item_code, im.specification, im.size, im.gst AS gst_text, im.item_name
      FROM po_items pi
      LEFT JOIN item_master im ON pi.item_master_id = im.id
      WHERE pi.business_book_id = (
        SELECT op.business_book_id
        FROM vendor_pos vp
        JOIN indents ind ON ind.id = vp.indent_id
        JOIN order_planning op ON op.id = ind.planning_id
        WHERE vp.id = ?
      )
      ORDER BY pi.id
    `).all(dn.vendor_po_id);
    if (poItems.length) {
      items = poItems.map(it => ({
        description: it.description || '',
        quantity: +it.quantity || 0,
        unit: it.unit || '',
        rate: +it.rate || 0,
        disc_pct: 0,
        amount: +it.amount || ((+it.quantity || 0) * (+it.rate || 0)),
        item_code: it.item_code || '',
        specification: it.specification || '',
        size: it.size || '',
        gst_text: it.hsn_code || it.gst_text || '',
        item_name: it.item_name || '',
      }));
      itemsSource = 'po_items';
    }
  }
  if (!items.length) {
    // Last-resort fallback — vendor cost. Used only when no Client PO row
    // can be located (e.g. FOC challan from a stand-alone indent).
    const vpItems = db.prepare(`
      SELECT ii.description, vpi.quantity, ii.unit, vpi.rate, vpi.amount,
             im.item_code, im.specification, im.size, im.gst AS gst_text, im.item_name
      FROM vendor_po_items vpi
      LEFT JOIN indent_items ii ON vpi.indent_item_id = ii.id
      LEFT JOIN item_master im ON ii.item_master_id = im.id
      WHERE vpi.vendor_po_id = ?
      ORDER BY vpi.id
    `).all(dn.vendor_po_id);
    items = vpItems.map(it => ({
      description: it.description || '',
      quantity: +it.quantity || 0,
      unit: it.unit || '',
      rate: +it.rate || 0,
      disc_pct: 0,
      amount: +it.amount || ((+it.quantity || 0) * (+it.rate || 0)),
      item_code: it.item_code || '',
      specification: it.specification || '',
      size: it.size || '',
      gst_text: it.gst_text || '',
      item_name: it.item_name || '',
    }));
  }

  const isSalesBill = dn.document_type === 'sales_bill';
  // Ship the HTML as a UTF-8 Buffer so the ₹ / em-dash / 🖨 emoji
  // round-trip cleanly through proxies that otherwise re-encode the
  // body as Latin-1. Earlier mam saw mojibake on the printed bill
  // ("â¹" instead of "₹") — explicit Buffer encoding is the fix.
  const html = renderDispatchHTML({ dn, items, isSalesBill, itemsSource });
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(Buffer.from(html, 'utf8'));
});

// HTML template renderer — kept inline so it stays self-contained and
// matches the PDFs mam supplied. All styling is inline / in a <style>
// block; no external assets. Tested on Chrome/Edge → A4 portrait.
function renderDispatchHTML({ dn, items, isSalesBill }) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmt = (n) => (+n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const numToWords = (() => {
    // Compact Indian-number-to-words for invoice amounts.
    const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const two = (n) => n < 20 ? a[n] : `${b[Math.floor(n / 10)]}${n % 10 ? ' ' + a[n % 10] : ''}`;
    const three = (n) => n >= 100 ? `${a[Math.floor(n / 100)]} Hundred${n % 100 ? ' ' + two(n % 100) : ''}` : two(n);
    return (n) => {
      n = Math.floor(+n || 0);
      if (!n) return 'Zero';
      const parts = [];
      const crore = Math.floor(n / 10000000); n %= 10000000;
      const lakh = Math.floor(n / 100000); n %= 100000;
      const thousand = Math.floor(n / 1000); n %= 1000;
      const hundred = n;
      if (crore) parts.push(`${two(crore)} Crore`);
      if (lakh) parts.push(`${two(lakh)} Lakh`);
      if (thousand) parts.push(`${two(thousand)} Thousand`);
      if (hundred) parts.push(three(hundred));
      return parts.join(' ').trim();
    };
  })();

  // On a material Supply sales bill the line scope must read "Supply of …".
  // BOQ text is written for the FULL scope ("S/I/T & commisioning of …",
  // "Supplying installing testing & commissioning of …"), which can't be billed
  // on a goods invoice — so on a sales bill we strip the Installation / Testing /
  // Commissioning scope and lead with "Supply of" (mam 2026-06-16, auto by bill
  // type). Installation/DPR bills don't print through here, so they keep their
  // full wording. Lines with nothing to strip are left untouched.
  const toSupplyDescription = (raw) => {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return s;
    // The scope prefix sits before the FIRST " of " (e.g. "S/I/T & commisioning of").
    const m = s.match(/^(.*?)\bof\b\s+/i);
    if (!m) return s;
    const prefix = m[1];
    const hasScope = /\binstall|\btest|commiss?ion/i.test(prefix)        // install / testing / commission(ing)
      || /\bs\s*[\/.\-]?\s*i\s*[\/.\-]?\s*t\b/i.test(prefix)              // S/I/T abbreviation
      || /\bsitc\b/i.test(prefix);                                       // SITC abbreviation
    if (!hasScope) return s;                                             // already supply-only — leave as-is
    return ('Supply of ' + s.slice(m[0].length)).replace(/\s+/g, ' ').trim();
  };

  // Build items rows (pad to 8 like the template)
  const padCount = Math.max(0, 8 - items.length);
  const rowsHtml = items.map((it, idx) => {
    const rawDesc = [it.description, it.specification, it.size].filter(Boolean).join(' / ');
    const desc = isSalesBill ? toSupplyDescription(rawDesc) : rawDesc;
    const qty = +it.quantity || 0;
    const rate = +it.rate || 0;
    const discPct = +it.disc_pct || 0;
    const gross = qty * rate;
    // Taxable = gross - line discount. If amount was stored we trust it;
    // otherwise compute from the disc %.
    const taxable = +it.amount || (gross * (1 - discPct / 100));
    if (isSalesBill) {
      return `<tr><td class="num">${idx + 1}</td><td>${esc(desc)}</td><td class="num">${esc(it.gst_text || '')}</td><td class="num">${fmt(qty)}</td><td>${esc(it.unit || '')}</td><td class="num">${fmt(rate)}</td><td class="num">${discPct ? fmt(discPct) : '0'}</td><td class="num">${fmt(taxable)}</td></tr>`;
    }
    return `<tr><td class="num">${idx + 1}</td><td>${esc(desc)}</td><td class="num">${esc(it.gst_text || '')}</td><td class="num">${fmt(qty)}</td><td>${esc(it.unit || '')}</td><td></td></tr>`;
  }).join('') + Array.from({ length: padCount }, (_, i) => {
    const idx = items.length + i + 1;
    return isSalesBill
      ? `<tr><td class="num">${idx}</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`
      : `<tr><td class="num">${idx}</td><td></td><td></td><td></td><td></td><td></td></tr>`;
  }).join('');

  const css = `
    @page { size: A4; margin: 12mm 10mm; }
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #1a1a1a; margin: 0; padding: 0; }
    /* Browser preview: render the document as an A4 "paper" centered on
       a grey background so what mam sees on screen matches what comes
       out of the printer. The @page rule above governs the actual print
       so we don't double-up margins. */
    @media screen {
      html { background: #e5e5e5; }
      body { width: 210mm; min-height: 297mm; margin: 8mm auto; padding: 12mm 10mm; background: white; box-shadow: 0 2px 12px rgba(0,0,0,0.15); }
    }
    /* Underline placeholder for empty fillable values — makes the
       generated bill look like the printed template ("M/s ______") when
       a field isn't filled in the source data yet. */
    .blank { display: inline-block; min-width: 140px; border-bottom: 1px dotted #999; height: 1em; vertical-align: bottom; }
    .header { background: #1e40af; color: #fff; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; }
    .header .gstin, .header .pan { font-size: 10px; }
    .header .title { font-size: 18px; font-weight: bold; letter-spacing: 1px; }
    .companyblock { text-align: center; padding: 6px; }
    .companyblock h1 { font-size: 16px; margin: 0 0 4px 0; color: #1e40af; }
    .companyblock .addr { font-size: 9.5px; color: #444; }
    .companyblock .tag { font-size: 9.5px; color: #444; margin-top: 2px; }
    table.meta, table.parties, table.items, table.totals, table.foot { width: 100%; border-collapse: collapse; }
    table.meta td, table.parties td { border: 1px solid #e7d4d4; padding: 6px 8px; vertical-align: top; }
    table.meta .lbl, table.parties .lbl { background: #f8efef; color: #1e40af; font-weight: bold; font-size: 9.5px; text-transform: uppercase; }
    table.items { margin-top: 6px; border: 1px solid #e7d4d4; }
    table.items th { background: #f8efef; color: #1e40af; font-size: 10px; padding: 6px 4px; border: 1px solid #e7d4d4; text-transform: uppercase; }
    table.items td { border: 1px solid #e7d4d4; padding: 5px 4px; font-size: 10px; min-height: 18px; }
    table.items td.num { text-align: right; }
    table.totals { margin-top: 6px; }
    table.totals td { padding: 4px 8px; font-size: 11px; }
    table.totals .label { text-align: right; color: #444; }
    table.totals .val { text-align: right; width: 130px; }
    table.totals .grand { background: #f8efef; color: #1e40af; font-weight: bold; font-size: 13px; }
    .bank, .terms { border: 1px solid #e7d4d4; padding: 6px 8px; font-size: 10px; margin-top: 6px; }
    .bank .hdr, .terms .hdr { background: #f8efef; color: #1e40af; font-weight: bold; padding: 4px 6px; margin: -6px -8px 6px -8px; text-transform: uppercase; font-size: 10px; }
    .signblk { border: 1px solid #e7d4d4; margin-top: 6px; padding: 6px 8px; }
    .signblk .hdr { background: #f8efef; color: #1e40af; font-weight: bold; padding: 4px 6px; margin: -6px -8px 6px -8px; text-transform: uppercase; font-size: 10px; text-align: center; }
    .signblk .row { display: flex; gap: 16px; margin-top: 18px; }
    .signblk .row > div { flex: 1; border-top: 1px solid #888; padding-top: 4px; font-size: 10px; text-align: center; }
    .notice { margin-top: 6px; padding: 6px 8px; background: #f8efef; color: #1e40af; font-weight: bold; text-align: center; font-size: 10px; border: 1px solid #e7d4d4; }
    ul.checklist { font-size: 9.5px; padding-left: 16px; margin: 4px 0; color: #444; }
    .footnote { text-align: center; font-size: 9.5px; color: #888; padding: 8px; border-top: 1px dashed #ccc; margin-top: 10px; }
    .print-btn { position: fixed; top: 10px; right: 10px; padding: 8px 14px; background: #1e40af; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; box-shadow: 0 2px 6px rgba(0,0,0,0.2); }
    @media print { .print-btn { display: none; } }
  `;

  // Store-issued material and RGP gate-passes get their own heading so the
  // printed challan is visibly different from a vendor Delivery Note
  // (mam 2026-06-23: "store different challan show").
  const docTitle = isSalesBill
    ? 'TAX INVOICE / SALES BILL'
    : dn.source === 'store' ? 'STORE ISSUE CHALLAN'
    : dn.source === 'rgp' ? 'RGP GATE PASS — DELIVERY CHALLAN'
    : 'DELIVERY NOTE';
  // Use the stored document_number (auto-generated INV/YYYY/#### or
  // DC/YYYY/####); only fall back to id-based if somehow blank.
  const docNo = dn.document_number || (isSalesBill ? `GST/26-26/${dn.id}` : `DN/${new Date().getFullYear()}/${dn.id}`);
  const dnNum = dn.document_number || docNo;

  // Best-effort state-name → GST state code lookup. Used when business_book
  // doesn't have an explicit state_code saved (legacy rows). Punjab=03 etc.
  const stateCodeFor = (name) => {
    const map = {
      'jammu and kashmir': '01', 'himachal pradesh': '02', 'punjab': '03',
      'chandigarh': '04', 'uttarakhand': '05', 'haryana': '06', 'delhi': '07',
      'rajasthan': '08', 'uttar pradesh': '09', 'bihar': '10', 'sikkim': '11',
      'arunachal pradesh': '12', 'nagaland': '13', 'manipur': '14',
      'mizoram': '15', 'tripura': '16', 'meghalaya': '17', 'assam': '18',
      'west bengal': '19', 'jharkhand': '20', 'odisha': '21', 'chhattisgarh': '22',
      'madhya pradesh': '23', 'gujarat': '24', 'daman and diu': '25',
      'dadra and nagar haveli': '26', 'maharashtra': '27', 'andhra pradesh': '28',
      'karnataka': '29', 'goa': '30', 'lakshadweep': '31', 'kerala': '32',
      'tamil nadu': '33', 'puducherry': '34', 'andaman and nicobar islands': '35',
      'telangana': '36', 'andhra pradesh (new)': '37', 'ladakh': '38',
    };
    return map[String(name || '').trim().toLowerCase()] || '';
  };
  const clientStateCode = dn.client_state_code || stateCodeFor(dn.client_state);

  // Compute totals for sales bill — honour per-line discount % so the
  // taxable value matches what mam tweaked in the create-modal.
  let subtotal = 0;
  for (const it of items) {
    const qty = +it.quantity || 0;
    const rate = +it.rate || 0;
    const discPct = +it.disc_pct || 0;
    subtotal += +it.amount || (qty * rate * (1 - discPct / 100));
  }
  // GST split is decided by place of supply vs SEPL's Punjab GSTIN: intra-state
  // (blank or Punjab) → CGST + SGST 9% each; a KNOWN other state → IGST 18%.
  // Recompute for sales bills so only the right lines show (mam 2026-06-15:
  // "CGST 9% SGST 9% ... 18% not need remove here").
  let cgstPct = +dn.cgst_pct || 0, sgstPct = +dn.sgst_pct || 0, igstPct = +dn.igst_pct || 0;
  if (isSalesBill) {
    const cs = String(dn.client_state || '').trim().toLowerCase();
    const interState = cs && cs !== 'punjab';
    if (interState) { cgstPct = 0; sgstPct = 0; igstPct = 18; }
    else { cgstPct = 9; sgstPct = 9; igstPct = 0; }
  }
  const cgst = subtotal * cgstPct / 100;
  const sgst = subtotal * sgstPct / 100;
  const igst = subtotal * igstPct / 100;
  const freight = +dn.freight_amount || 0;
  const roundOff = +dn.round_off_amount || 0;
  const grandTotal = subtotal + cgst + sgst + igst + freight + roundOff;

  // Shared brand logo (mam 2026-06-17: "old also change") — the real SE
  // lockup embedded as a data URI, used by BOTH the Delivery Note and the
  // Sales Bill so every printed document carries the logo. Null until the
  // file (client/public/sepl-logo.png) is present.
  let logoDataUri = null;
  try {
    for (const lp of [
      path.join(__dirname, '..', '..', 'client', 'public', 'sepl-logo.png'),
      path.join(__dirname, '..', '..', 'client', 'dist', 'sepl-logo.png'),
    ]) { if (fs.existsSync(lp)) { logoDataUri = `data:image/png;base64,${fs.readFileSync(lp).toString('base64')}`; break; } }
  } catch (_) {}

  const headerBlock = `
    <div class="header">
      <div class="gstin">GSTIN : 03AASCS7836D2Z3</div>
      <div class="title">${docTitle}</div>
      <div class="pan">PAN : AASCS7836D</div>
    </div>
    <div class="companyblock">
      ${logoDataUri
        ? `<img src="${logoDataUri}" alt="Secured Engineers Pvt. Ltd." style="height:46px;width:auto;display:block;margin:0 auto 4px" />`
        : `<h1>SECURED ENGINEERS PVT. LTD - 24-25</h1>`}
      <div class="addr"><b>HO:</b> 2480/1, B.K Tower, 1st Floor, Near Grewal Hospital, Gill Road, LUDHIANA, Punjab - 141003 &nbsp;|&nbsp; <b>Noida:</b> 91, Springboard, Sector 2, Noida (UP)</div>
      <div class="tag">PAN-INDIA PRESENCE : <b>LUDHIANA | NOIDA | BANGALORE | MUMBAI</b> — ELECTRICAL | HVAC | FIRE SAFETY | PLUMBING | SOLAR | ELV</div>
    </div>
  `;

  // Display "DD / MM / YYYY" for any ISO date string. Used by both Sales
  // Bill and Delivery Note. Returns empty when no date is provided.
  const dispDate = (d) => {
    if (!d) return '';
    const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]} / ${m[2]} / ${m[1]}` : esc(d);
  };

  // Helper — if a field has no value, render an underline placeholder
  // so the document looks like the printed fill-in template.
  const fill = (v, w) => {
    const s = (v == null ? '' : String(v)).trim();
    if (s) return esc(s);
    return `<span class="blank"${w ? ` style="min-width:${w}"` : ''}></span>`;
  };

  if (isSalesBill) {
    // Tax Invoice redesigned to match the format mam supplied
    // (Tax Invoice — Secured Engineers Pvt. Ltd_.pdf, 2026-06-16): monogram
    // header + "ORIGINAL FOR RECIPIENT" GSTIN/PAN, meta grid with Financial
    // Yr / Place of Supply (+ code) / Supply Type / Reverse Charge / E-Way
    // Bill, Bill To + Ship To, items WITHOUT a discount column, amount + tax
    // in words, "Payable on Delivery = basic × % + 100% GST", an e-Invoice /
    // IRN block, bank details, T&C, and dual acknowledgement.
    const stripMs = (s) => String(s || '').replace(/^\s*M\/?s\.?\s*/i, '').trim();
    // Strip any leading "M/s" from the source so the template's own "M/s "
    // prefix doesn't double up ("M/s M/s GRA Spinning Mill").
    const billToName = stripMs(dn.client_company || dn.site_name || dn.client_person_name || '');
    const billToAddr = dn.client_address || dn.site_address || '';
    const shipAddr = dn.site_address || dn.client_address || '';
    const interState = igstPct > 0;

    // Financial year (India, Apr–Mar) derived from the invoice date.
    const fyOf = (d) => { const m = String(d || '').match(/^(\d{4})-(\d{2})/); if (!m) return ''; const y = +m[1], mo = +m[2]; const s = mo >= 4 ? y : y - 1; return `${s}-${String(s + 1).slice(2)}`; };

    // Auto-round the grand total to the whole rupee (matches the supplied
    // PDF's "Round Off (–) 0.17 → 1,44,053.00").
    const taxTotal = cgst + sgst + igst;
    const rawTotal = subtotal + taxTotal + freight;
    const grand = Math.round(rawTotal);
    const round = grand - rawTotal;

    // Amount-in-words; the tax line carries paise like the PDF.
    const rupeesWhole = (amt) => `Rupees ${numToWords(Math.floor(+amt || 0))} Only`;
    const rupeesPaise = (amt) => { const r = Math.round((+amt || 0) * 100); const ru = Math.floor(r / 100), pa = r % 100; return `Rupees ${numToWords(ru)}${pa ? ` and ${numToWords(pa)} Paise` : ''} Only`; };

    // Payable on delivery = basic value × against-delivery % + 100% of GST.
    // Round each part to paise before adding (matches the supplied PDF).
    const r2 = (n) => Math.round((+n || 0) * 100) / 100;
    const dpct = parseFloat(String(dn.bb_delivery_terms || '').replace(/[^0-9.]/g, '')) || 0;
    const payable = dpct ? (r2(subtotal * dpct / 100) + r2(taxTotal)) : 0;

    // Item rows — no discount column (SL / DESC / HSN / QTY / UOM / RATE / AMOUNT).
    const sbRows = items.map((it, idx) => {
      // v7 layout: description (SITC→Supply normalised) on the first line,
      // the size / spec on its own muted sub-line beneath it
      // (e.g. "Supply of cabling…" then "4C × 25 SQMM (CU)").
      let desc = toSupplyDescription(it.description || '');
      const specParts = [];
      // The ERP item often carries the cable size INSIDE the description
      // text (e.g. "…control panels 4CX25 SQMM(CU)"). Lift it onto its own
      // line — and likewise a trailing "(set of …)" note — to match the
      // supplied template (mam 2026-06-18). Falls back to the dedicated
      // specification/size fields when present.
      const cm = desc.match(/[-–,]?\s*(\d+)\s*C\s*[×xX]\s*([\d.]+)\s*SQ\.?\s*MM\s*\(\s*CU\s*\)\.?\s*$/i);
      if (cm) { specParts.push(`${cm[1]}C × ${cm[2]} SQMM (CU)`); desc = desc.slice(0, cm.index).replace(/[,;\s]+$/, '').trim(); }
      const pm = desc.match(/\(\s*(set of [^)]+?)\s*\)\.?\s*$/i);
      if (pm) { specParts.push(pm[1].charAt(0).toUpperCase() + pm[1].slice(1)); desc = desc.slice(0, pm.index).replace(/[,;\s]+$/, '').trim(); }
      for (const s of [it.specification, it.size]) if (s) specParts.push(String(s));
      const specLine = specParts.join(' · ');
      const qty = +it.quantity || 0, rate = +it.rate || 0, discPct = +it.disc_pct || 0;
      const amount = +it.amount || (qty * rate * (1 - discPct / 100));
      return `<tr><td class="c">${idx + 1}</td><td>${esc(desc)}${specLine ? `<div class="spec">${esc(specLine)}</div>` : ''}</td><td class="c">${esc(it.gst_text || '')}</td><td class="r">${fmt(qty)}</td><td class="c">${esc(it.unit || '')}</td><td class="r">${fmt(rate)}</td><td class="r">${fmt(amount)}</td></tr>`;
    }).join('');

    const sbCss = `
      .sb { color:#1C2333; }
      /* Royal-blue brand theme (mam 2026-06-16). */
      .print-btn { background:#13318C; }
      /* Vertical spacing tightened (mam 2026-06-16: "set it best way") so
         a typical bill lands cleanly on one A4 page. */
      .sb .top { display:flex; justify-content:space-between; align-items:flex-start; padding-bottom:2px; }
      .sb .brand { display:flex; align-items:center; gap:10px; }
      /* Brand badge — filled royal-blue "SE" mark recreated as vector
         CSS (mam 2026-06-16) so it prints razor-sharp in the html2canvas
         PDF with no external image / CORS dependency. */
      .sb .mono { width:58px; height:40px; background:#fff; border:2px solid #13318C; color:#13318C; font-weight:900; font-style:italic; font-size:19px; display:flex; align-items:center; justify-content:center; border-radius:50%; letter-spacing:-1px; box-shadow:0 1px 3px rgba(30,64,175,.25); flex-shrink:0; }
      .sb .cn { font-size:18px; font-weight:800; color:#13318C; line-height:1.1; }
      .sb .tag { font-size:8px; letter-spacing:1.5px; color:#13318C; text-transform:uppercase; margin-top:2px; font-weight:600; }
      .sb .haddr { font-size:8.5px; color:#5D6B85; line-height:1.6; text-align:center; margin:4px 0 0; padding-bottom:6px; border-bottom:2px solid #13318C; }
      .sb .hr { text-align:right; min-width:185px; padding-left:12px; }
      .sb .origpill { display:inline-block; background:#eef3ff; color:#13318C; border:1px solid #c9d8f5; border-radius:11px; padding:2px 12px; font-size:8px; font-weight:700; letter-spacing:1px; text-transform:uppercase; }
      .sb .invtitle { display:inline-block; font-size:27px; font-weight:800; letter-spacing:2px; color:#13318C; margin:8px 0 4px; border-bottom:3px solid #13318C; padding-bottom:3px; }
      .sb .gp { font-size:9px; color:#5D6B85; }
      .sb .gp b { color:#13318C; }
      .sb table { width:100%; border-collapse:collapse; }
      .sb .meta td { border:1px solid #c9d8f5; padding:4px 8px; font-size:10px; vertical-align:top; width:33.33%; }
      .sb .meta .lbl { display:block; font-size:7.5px; letter-spacing:1px; color:#8a93a6; text-transform:uppercase; font-weight:700; margin-bottom:1px; }
      .sb .parties td { border:1px solid #c9d8f5; padding:5px 8px; font-size:9.5px; vertical-align:top; width:50%; }
      .sb .parties .h { background:#13318C; color:#fff; font-weight:700; text-transform:uppercase; font-size:9px; padding:4px 8px; letter-spacing:1px; }
      .sb .items { margin-top:5px; }
      /* Borderless line-items table (mam 2026-06-18: "their table has no
         lines") — keep only the blue header bar and a faint row separator,
         no cell grid, to match the supplied invoice format. */
      .sb .items th { background:#13318C; color:#fff; font-size:9px; text-transform:uppercase; padding:5px; border:none; }
      .sb .items td { border:none; border-bottom:1px solid #eaf0fb; padding:5px 6px; font-size:9.5px; vertical-align:top; }
      .sb .items tbody tr:last-child td { border-bottom:none; }
      .sb .items td.c { text-align:center; } .sb .items td.r { text-align:right; }
      .sb .items td .spec { font-size:8.5px; color:#13318C; font-weight:600; margin-top:2px; }
      .sb .lower { display:flex; gap:8px; margin-top:5px; align-items:flex-start; }
      .sb .words { flex:1; border:1px solid #c9d8f5; padding:5px 8px; font-size:9.5px; }
      .sb .words .k { color:#13318C; font-weight:700; text-transform:uppercase; font-size:8.5px; margin-top:4px; }
      .sb .words .pod { margin-top:5px; background:#eef3ff; padding:5px 7px; border-radius:4px; }
      .sb .tot { width:46%; }
      .sb .tot td { padding:3px 8px; font-size:10px; border-bottom:1px solid #e8eefb; }
      .sb .tot .lab { text-align:right; color:#5D6B85; } .sb .tot .v { text-align:right; white-space:nowrap; }
      .sb .tot .grand td { background:#13318C; color:#fff; font-weight:800; font-size:12px; }
      .sb .tot .podr td { color:#13318C; font-weight:700; }
      .sb .cols { display:flex; gap:8px; margin-top:5px; }
      .sb .box { flex:1; border:1px solid #c9d8f5; padding:5px 8px; font-size:9px; line-height:1.45; }
      .sb .box .h { color:#13318C; font-weight:700; text-transform:uppercase; font-size:8.5px; margin-bottom:3px; }
      .sb .sign { display:flex; gap:8px; margin-top:5px; }
      .sb .sign .b { flex:1; border:1px solid #c9d8f5; padding:6px 9px; min-height:54px; font-size:9px; position:relative; }
      .sb .sign .b .h { color:#13318C; font-weight:700; text-transform:uppercase; font-size:8.5px; }
      .sb .sign .b .ln { position:absolute; bottom:16px; left:9px; right:9px; border-top:1px solid #999; }
      .sb .sign .b .cap { position:absolute; bottom:5px; left:9px; right:9px; text-align:center; color:#5D6B85; }
      .sb .foot { text-align:center; font-size:8.5px; color:#5D6B85; border-top:1px dashed #ccc; margin-top:8px; padding-top:6px; }
      .sb .logo-img { height:54px; width:auto; display:block; }
      .sb .promo2 { display:flex; gap:8px; margin-top:5px; }
      .sb .promo2 .pb { flex:1; background:#eef3ff; border:1px solid #c9d8f5; border-radius:4px; padding:4px 10px; font-size:8.5px; color:#13318C; font-style:italic; }
      .sb .words .wv { color:#13318C; font-weight:600; }
    `;
    // Brand block (mam 2026-06-17): prefer the real lockup logo
    // (client/public/sepl-logo.png — also copied to dist on build), embedded
    // as a data URI so it prints sharp with no network/CORS dependency. The
    // lockup ALREADY contains the company name, so we don't repeat it — just
    // add the service tagline under it. Falls back to the CSS "SE" badge +
    // name + tagline if the file isn't present.
    const TAGLINE = 'Electrical · HVAC · Fire Safety · Plumbing · Solar · EPC';
    const brandInner = logoDataUri
      ? `<div><img class="logo-img" src="${logoDataUri}" alt="Secured Engineers Pvt. Ltd." /><div class="tag" style="margin-top:3px">${TAGLINE}</div></div>`
      : `<div class="mono">SE</div><div><div class="cn">Secured Engineers Pvt. Ltd.</div><div class="tag">${TAGLINE}</div></div>`;
    return `<!doctype html><html><head><meta charset="UTF-8"><title>${esc(docNo)}</title><style>${css}${sbCss}</style></head><body>
      <button class="print-btn" onclick="window.print()">🖨 Print</button>
      <div id="pdfgen" style="position:fixed;inset:0;background:rgba(255,255,255,.94);display:flex;align-items:center;justify-content:center;font:600 15px Arial,sans-serif;color:#13318C;z-index:99999">Generating PDF, please wait…</div>
      <script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js"></script>
      <script>
      (function(){
        // The bill page renders itself to a PDF (html2canvas + jsPDF) and
        // shows it in the browser's PDF viewer; falls back to printable HTML
        // if the libs can't load.
        var btn=null;
        function showHtml(){ var o=document.getElementById('pdfgen'); if(o)o.remove(); if(btn)btn.style.display=''; }
        window.addEventListener('load', function(){
          setTimeout(function(){
            try{
              btn=document.querySelector('.print-btn'); if(btn)btn.style.display='none';
              if(!window.html2canvas||!window.jspdf){ showHtml(); return; }
              html2canvas(document.body,{scale:2,backgroundColor:'#ffffff',useCORS:true,windowWidth:document.body.scrollWidth,
                ignoreElements:function(el){ return el.id==='pdfgen' || (el.classList && el.classList.contains('print-btn')); }}).then(function(canvas){
                var jsPDF=window.jspdf.jsPDF;
                var img=canvas.toDataURL('image/jpeg',0.95);
                var pdf=new jsPDF({unit:'pt',format:'a4',compress:true});
                var pw=pdf.internal.pageSize.getWidth();
                var ph=pdf.internal.pageSize.getHeight();
                var imgH=canvas.height*pw/canvas.width;
                if(imgH<=ph+2){
                  pdf.addImage(img,'JPEG',0,0,pw,imgH,'','FAST');
                } else if(imgH<=ph*1.12){
                  var w2=pw*ph/imgH;
                  pdf.addImage(img,'JPEG',(pw-w2)/2,0,w2,ph,'','FAST');
                } else {
                  var left=imgH,pos=0;
                  pdf.addImage(img,'JPEG',0,pos,pw,imgH,'','FAST'); left-=ph;
                  while(left>0){ pos-=ph; pdf.addPage(); pdf.addImage(img,'JPEG',0,pos,pw,imgH,'','FAST'); left-=ph; }
                }
                window.location.replace(URL.createObjectURL(pdf.output('blob')));
              }).catch(function(){ showHtml(); });
            }catch(e){ showHtml(); }
          }, 400);
        });
      })();
      </script>
      <div class="sb">
        <div class="top">
          <div class="hl">
            <div class="brand">${brandInner}</div>
          </div>
          <div class="hr">
            <div class="origpill">Original for Recipient</div>
            <div class="invtitle">TAX INVOICE</div>
            <div class="gp"><b>GSTIN:</b> 03AASCS7836D2Z3 &nbsp; <b>PAN:</b> AASCS7836D</div>
          </div>
        </div>
        <div class="haddr">
          <div>HO: 2480/1, B.K Tower, 1st Floor, Near Grewal Hospital, Gill Road, Ludhiana, Punjab – 141003</div>
          <div>Noida: 91, Springboard, Sector 2, Noida (UP)</div>
          <div>Pan-India: Ludhiana · Noida · Bangalore · Mumbai</div>
        </div>

        <table class="meta" style="margin-top:9px">
          <tr>
            <td><span class="lbl">Invoice No.</span><b>${esc(docNo)}</b></td>
            <td><span class="lbl">Invoice Date</span><b>${dispDate(dn.delivery_date)}</b></td>
            <td><span class="lbl">Sales Order</span><b>${fill(dn.bb_lead_no)}</b></td>
          </tr>
          <tr>
            <td><span class="lbl">Financial Year</span><b>${esc(fyOf(dn.delivery_date))}</b></td>
            <td><span class="lbl">Client PO No.</span>${fill(dn.client_po_no)}</td>
            <td><span class="lbl">E-Way Bill</span>${esc(dn.e_way_bill_no || 'As applicable')}</td>
          </tr>
        </table>

        <table class="parties" style="margin-top:7px">
          <tr><td class="h">Bill To</td><td class="h">Ship To / Site</td></tr>
          <tr>
            <td>
              <div><b>M/s ${fill(billToName)}</b></div>
              <div style="margin-top:2px">${fill(billToAddr)}</div>
              <div style="margin-top:2px"><b>GSTIN:</b> ${fill(dn.client_gstin)} &nbsp; <b>State:</b> ${fill(dn.client_state)} · Code ${fill(clientStateCode)}</div>
            </td>
            <td>
              <div><b>${fill(stripMs(dn.site_name) || billToName)} (Site)</b></div>
              <div style="margin-top:2px">${fill(shipAddr)}</div>
              <div style="margin-top:2px"><b>GSTIN:</b> ${fill(dn.client_gstin)} &nbsp; <b>State:</b> ${fill(dn.client_state)} · Code ${fill(dn.state_code || clientStateCode)}</div>
            </td>
          </tr>
        </table>

        <table class="items">
          <thead><tr><th style="width:26px">SL</th><th>Description of Goods &amp; Accessories</th><th style="width:52px">HSN</th><th style="width:44px">Qty</th><th style="width:40px">UOM</th><th style="width:74px">Rate (₹)</th><th style="width:90px">Amount (₹)</th></tr></thead>
          <tbody>${sbRows}</tbody>
        </table>

        <div class="promo2">
          <div class="pb">＋ Our crews handle turnkey MEPF · Fire-Safety · Solar EPC · HVAC. Get a same-site quote.</div>
          <div class="pb">★ Add an AMC in future &amp; save up to 15%.</div>
        </div>

        <div class="lower">
          <div class="words">
            <div class="k" style="margin-top:0">Amount Chargeable (in words)</div>
            <div class="wv">${esc(rupeesWhole(grand))}</div>
            <div class="k">${interState ? 'IGST' : 'CGST + SGST'} (in words)</div>
            <div class="wv">${esc(rupeesPaise(taxTotal))}</div>
            ${dpct ? `<div class="k">Payable on Delivery (in words)</div><div class="wv">${esc(rupeesPaise(payable))}</div><div class="pod"><b>Basis:</b> ${dpct}% of basic value + 100% GST = ₹ ${fmt(payable)} (≈ ₹ ${fmt(Math.round(payable))})</div>` : ''}
          </div>
          <table class="tot">
            <tr><td class="lab">Sub Total (Taxable Value)</td><td class="v">₹ ${fmt(subtotal)}</td></tr>
            ${cgstPct > 0 ? `<tr><td class="lab">Add: CGST @ ${cgstPct}%</td><td class="v">₹ ${fmt(cgst)}</td></tr>` : ''}
            ${sgstPct > 0 ? `<tr><td class="lab">Add: SGST @ ${sgstPct}%</td><td class="v">₹ ${fmt(sgst)}</td></tr>` : ''}
            ${igstPct > 0 ? `<tr><td class="lab">Add: IGST @ ${igstPct}%</td><td class="v">₹ ${fmt(igst)}</td></tr>` : ''}
            <tr><td class="lab">Freight / Packing / Other</td><td class="v">₹ ${fmt(freight)}</td></tr>
            <tr><td class="lab">Round Off</td><td class="v">${round < 0 ? '(–) ' : ''}₹ ${fmt(Math.abs(round))}</td></tr>
            <tr class="grand"><td class="lab" style="color:#fff">Grand Total (₹)</td><td class="v">₹ ${fmt(grand)}</td></tr>
            ${dpct ? `<tr class="podr"><td class="lab">Payable on Delivery (${dpct}% + GST)</td><td class="v">₹ ${fmt(payable)}</td></tr>` : ''}
          </table>
        </div>

        <div class="cols">
          <div class="box">
            <div class="h">e-Invoice details (mandatory — turnover &gt; ₹5 Cr)</div>
            <div>IRN: ____________________________________</div>
            <div>Ack No.: ______________ &nbsp; Ack Date: ____________</div>
            <div style="color:#5D6B85">Generate IRN + signed QR on the IRP before issuing.</div>
          </div>
          <div class="box">
            <div class="h">Bank Details for Payment</div>
            <div><b>Beneficiary:</b> Secured Engineers Pvt. Ltd.</div>
            <div><b>Bank:</b> Punjab National Bank · Sarabha Nagar, Ludhiana</div>
            <div><b>A/c No.:</b> 02054011000748 &nbsp; <b>IFSC:</b> PUNB0020510</div>
          </div>
        </div>

        <div class="box" style="margin-top:7px">
          <div class="h">Terms &amp; Conditions</div>
          <ol style="margin:0;padding-left:16px;line-height:1.5">
            <li>${dpct ? `${dpct}% of basic value + 100% GST due on delivery; balance per agreed terms.` : 'Payment per agreed terms.'}</li>
            <li>Interest @ 18% p.a. on overdue amounts.</li>
            <li>Goods once sold are not taken back / exchanged.</li>
            <li>Subject to Ludhiana jurisdiction.</li>
            <li>Cheque / DD in favour of "Secured Engineers Pvt. Ltd."; quote Invoice No. on payment.</li>
          </ol>
        </div>

        <div class="sign">
          <div class="b"><div class="h">Receiver's Acknowledgement</div><div style="color:#5D6B85">Received the above goods / services in good condition.</div><div class="ln"></div><div class="cap">Name, Signature &amp; Stamp with Date</div></div>
          <div class="b"><div class="h">For Secured Engineers Pvt. Ltd.</div><div class="ln"></div><div class="cap">Authorised Signatory</div></div>
        </div>

        <div class="foot">This is a Computer-Generated Tax Invoice and is valid with the IRN / signed QR code. E. &amp; O.E. · Certified that the particulars given above are true and correct.</div>
      </div>
    </body></html>`;
  }

  // Delivery Note — matches the SEPL Delivery Note template 1:1.
  // Items table is 6 columns (SL / DESCRIPTION / HSN / QUANTITY / UOM /
  // REMARKS) padded to 8 rows. Vehicle / Transport details get their
  // own banner-headed section; the two notices ("IMPORTANT" and
  // "RECEIVED IN GOOD CONDITION") use red banner headers like the
  // template; footer text sits inside a red-bordered banner.
  return `<!doctype html><html><head><meta charset="UTF-8"><title>${esc(docNo)}</title><style>${css}</style></head><body>
    <button class="print-btn" onclick="window.print()">🖨 Print</button>
    ${headerBlock}
    <table class="meta">
      <tr>
        <td class="lbl">Delivery Note No.</td><td>${esc(docNo)}</td>
        <td class="lbl">Date</td><td>${dispDate(dn.delivery_date)}</td>
        <td class="lbl">SEPL PO No.</td><td>${esc(dn.vendor_po_no || '')}</td>
        <td class="lbl">Indent No.</td><td>${esc(dn.indent_number || '')}</td>
      </tr>
    </table>
    ${(() => {
      // Same Business-Book fallbacks as the sales bill (mam 2026-06-15
      // "not showing proper data"): client name falls back to the site /
      // project field (minus leading "M/s"), addresses cross-fall-back.
      const stripMs = (s) => String(s || '').replace(/^\s*M\/?s\.?\s*/i, '').trim();
      var clientName = dn.client_company || stripMs(dn.site_name) || dn.client_person_name || '';
      var clientAddr = dn.client_address || dn.site_address || '';
      var siteAddr = dn.site_address || dn.client_address || '';
      return `
    <table class="parties">
      <tr>
        <td class="lbl" style="width:50%">Client / Company</td>
        <td class="lbl">Delivery Site</td>
      </tr>
      <tr>
        <td style="width:50%">
          <div><b>M/s</b> ${fill(clientName, '220px')}</div>
          <div style="margin-top:4px"><b>Address:</b></div>
          <div style="margin-left:4px">${fill(clientAddr, '260px')}</div>
          <div style="margin-top:4px"><b>GSTIN:</b> ${fill(dn.client_gstin, '180px')}</div>
        </td>
        <td>
          <div><b>Site Name:</b> ${fill(dn.site_name || clientName, '220px')}</div>
          <div style="margin-top:4px"><b>Address:</b></div>
          <div style="margin-left:4px">${fill(siteAddr, '260px')}</div>
          <div style="margin-top:4px"><b>Site Engineer / Contact:</b> ${fill(dn.client_phone, '180px')}</div>
        </td>
      </tr>
    </table>`;
    })()}
    <table class="items">
      <thead><tr><th style="width:30px">SL NO.</th><th>DESCRIPTION OF MATERIAL / WORK</th><th style="width:80px">HSN / CODE</th><th style="width:70px">QUANTITY</th><th style="width:50px">UOM</th><th style="width:130px">REMARKS</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div style="margin-top:6px;border:1px solid #e7d4d4">
      <div style="background:#f8efef;color:#1e40af;font-weight:bold;padding:4px 8px;font-size:10px;text-transform:uppercase">Vehicle / Transport Details</div>
      <table class="parties" style="border-top:0"><tr>
        <td class="lbl" style="border-top:0">Vehicle No.</td>
        <td class="lbl" style="border-top:0">Driver Name &amp; Mobile</td>
        <td class="lbl" style="border-top:0">LR / Challan No.</td>
        <td class="lbl" style="border-top:0">Total Packages</td>
      </tr><tr>
        <td>${esc(dn.vehicle_no || '')}</td>
        <td>${esc([dn.driver_name, dn.driver_mobile].filter(Boolean).join(' · '))}</td>
        <td>${esc(dn.lr_challan_no || '')}</td>
        <td>${esc(dn.total_packages || '')}</td>
      </tr></table>
    </div>
    <div class="notice" style="margin-top:6px">IMPORTANT — RECEIVING IS VALID ONLY ON THIS DELIVERY NOTE</div>
    <div style="font-size:9.5px;color:#444;border:1px solid #e7d4d4;border-top:0;padding:6px 8px">
      It is the supplier's responsibility to obtain dated signature, name and stamp of Secured Engineers' authorised site representative on this Delivery Note. Receiving acknowledged on the supplier's bill / invoice / challan shall <b>NOT</b> be treated as proof of delivery and may lead to non-payment.
    </div>
    <div class="notice" style="margin-top:6px">Received in Good Condition (to be filled by SEPL site representative)</div>
    <table class="parties" style="border-top:0">
      <tr>
        <td class="lbl">Name of Receiver</td>
        <td class="lbl">Designation</td>
        <td class="lbl">Date &amp; Time</td>
      </tr>
      <tr>
        <td style="height:30px"></td><td></td><td></td>
      </tr>
      <tr>
        <td class="lbl">Signature</td>
        <td class="lbl">Site Stamp</td>
        <td class="lbl">Mobile No.</td>
      </tr>
      <tr>
        <td style="height:40px"></td><td></td><td></td>
      </tr>
    </table>
    <ul class="checklist">
      <li>Please verify quantity, description and condition of material BEFORE signing this Delivery Note.</li>
      <li>Mention shortage / damage / wrong-supply (if any) clearly under <b>REMARKS</b> column. Once signed without remark, supply shall be deemed accepted in full.</li>
      <li>Receiving on this Delivery Note is the <b>only</b> recognised proof of delivery. Bills / Invoices are for accounting only.</li>
      <li>Original copy to be retained by Secured Engineers' site office; duplicate copy may be returned to the supplier for billing reference.</li>
      <li>For any clarification, contact the Stores / Project Department of Secured Engineers Pvt. Ltd., Ludhiana.</li>
    </ul>
    <div style="margin-top:6px;border:1px solid #1e40af;background:#f4f7fe;color:#1e40af;font-weight:bold;text-align:center;padding:6px 8px;font-size:10.5px">
      This is a Computer Generated Delivery Note. Valid only when received and signed at the designated SEPL site.
    </div>
  </body></html>`;
}

// Sales Bills
router.get('/sales-bills', (req, res) => {
  res.json(getDb().prepare(`SELECT sb.*, po.po_number FROM sales_bills sb
    LEFT JOIN purchase_orders po ON sb.po_id=po.id ORDER BY sb.created_at DESC`).all());
});

router.post('/sales-bills', (req, res) => {
  const db = getDb();
  const { po_id, bill_date, amount, gst_amount, total_amount } = req.body;
  const { nextSequence } = require('../db/nextSequence');
  const billNum = nextSequence(db, 'sales_bills', 'bill_number', 'SB-', { startFrom: 0, pad: 4 });
  const r = db.prepare('INSERT INTO sales_bills (po_id,bill_number,bill_date,amount,gst_amount,total_amount) VALUES (?,?,?,?,?,?)')
    .run(po_id, billNum, bill_date, amount, gst_amount, total_amount);
  res.status(201).json({ id: r.lastInsertRowid, bill_number: billNum });
});

router.delete('/sales-bills/:id', (req, res) => {
  getDb().prepare('DELETE FROM sales_bills WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ITEM-WISE VENDOR RATES — each indent item gets up to 3 vendor quotes,
// then one is finalized. This is the "Step 1 + Step 2" of mam's workflow
// sheet: (1) 3 Vendors Rate, (2) Final Rate.

// List all indent items (not yet fully converted to vendor PO) with their
// current rates row (one per item, joined). An item shows here once the
// indent is submitted/approved.
// Gate: an indent must be fully approved (status='approved' — which
// requires BOTH L1 and L2 sign-offs in two-level mode, or the single
// approval in legacy mode) before its items can flow into the 3-vendor
// rate step. Mam (2026-05-28): "from now without approvals data dont
// go to next step like 3 vendors rate". Returns null if OK, or an
// {status,error} object the caller can hand to res.status(...).json(...).
const APPROVED_FOR_RATES = "('approved','po_sent')";
function assertIndentApprovedByItem(db, indentItemId) {
  const row = db.prepare(
    `SELECT i.indent_number, i.status, i.l1_status, i.l2_status
       FROM indent_items ii
       JOIN indents i ON i.id = ii.indent_id
      WHERE ii.id = ?`
  ).get(indentItemId);
  if (!row) return { status: 404, error: 'Indent item not found' };
  const fullyApproved = row.status === 'approved' || row.status === 'po_sent'
    || (row.l1_status === 'approved' && row.l2_status === 'approved');
  if (!fullyApproved) {
    return { status: 403, error: `Indent ${row.indent_number} is not fully approved yet (current: ${row.status}). Vendor rates can only be entered after L1 + L2 approval.` };
  }
  return null;
}
function assertIndentApprovedByRate(db, rateId) {
  const row = db.prepare(
    `SELECT i.indent_number, i.status, i.l1_status, i.l2_status
       FROM indent_item_rates r
       JOIN indent_items ii ON ii.id = r.indent_item_id
       JOIN indents i ON i.id = ii.indent_id
      WHERE r.id = ?`
  ).get(rateId);
  if (!row) return { status: 404, error: 'Rate row not found' };
  const fullyApproved = row.status === 'approved' || row.status === 'po_sent'
    || (row.l1_status === 'approved' && row.l2_status === 'approved');
  if (!fullyApproved) {
    return { status: 403, error: `Indent ${row.indent_number} is not fully approved yet (current: ${row.status}). Cannot finalize until L1 + L2 approve.` };
  }
  return null;
}

router.get('/item-rates', (req, res) => {
  const db = getDb();
  // Also pull the parent BOQ item (po_items) so the UI can render
  // "BOQ: <parent description>" as a sub-category above the actual
  // sub-item — mam wants both visible per row.
  const rows = db.prepare(
    // Mam (2026-05-16): "not change according to itemwise" — UOM
    // was showing the stale stored ii.unit ("Each", "Metre", etc.)
    // even when the linked item_master had a clean uom.  The SELECT
    // now exposes both: `unit` is the effective UOM (master.uom
    // wins, falling back to ii.unit when no master link), `unit_raw`
    // is the original ii.unit preserved for any audit needs.
    `SELECT ii.id as indent_item_id, ii.description, ii.make, ii.quantity as qty,
            LOWER(CASE WHEN COALESCE(ii.unit_overridden, 0) = 1 AND TRIM(COALESCE(ii.unit, '')) <> ''
                       THEN ii.unit
                       ELSE COALESCE(NULLIF(TRIM(im.uom), ''), NULLIF(TRIM(ii.unit), ''), 'nos') END) as unit,
            ii.unit as unit_raw,
            ii.item_type, ii.item_master_id, ii.po_item_id,
            COALESCE(ii.weight_per_meter, im.weight_per_meter) as weight_per_meter,
            im.item_code, im.item_name as master_name, im.specification, im.size, im.uom,
            poi.description as boq_description, poi.quantity as boq_qty, poi.part_price as pp_rate,
            r.marketing_rate,
            i.indent_number, i.id as indent_id,
            i.site_name, i.raised_by_name, i.status as indent_status,
            bb.lead_no,
            r.id as rate_id,
            r.vendor1_name, r.vendor1_rate, r.vendor1_terms, r.vendor1_credit_days,
            r.vendor2_name, r.vendor2_rate, r.vendor2_terms, r.vendor2_credit_days,
            r.vendor3_name, r.vendor3_rate, r.vendor3_terms, r.vendor3_credit_days,
            r.final_rate, r.final_vendor_name, r.final_terms, r.final_credit_days,
            r.status as rate_status, r.finalized_at, fu.name as finalized_by_name
     FROM indent_items ii
     JOIN indents i ON ii.indent_id = i.id
     LEFT JOIN item_master im ON im.id = ii.item_master_id
     LEFT JOIN po_items poi ON poi.id = ii.po_item_id
     LEFT JOIN indent_item_rates r ON r.indent_item_id = ii.id
     LEFT JOIN users fu ON fu.id = r.finalized_by
     LEFT JOIN order_planning op ON op.id = i.planning_id
     LEFT JOIN business_book bb ON bb.id = op.business_book_id
     -- Show fully-approved indents. Besides status IN ('approved','po_sent'),
     -- also accept any indent whose L1 AND L2 are both signed off — some rows
     -- get "stuck" at status='l1_approved' even though l2_status='approved'
     -- (mam 2026-06-22: "after approval all indent not show"). Both signatures
     -- present = ready for rates, regardless of the status column.
     WHERE (i.status IN ${APPROVED_FOR_RATES}
            OR (i.l1_status='approved' AND i.l2_status='approved'))
       -- From-store lines are fulfilled from stock — they don't need a
       -- vendor rate / PO, so only the PROCURE portion shows here.  mam
       -- (2026-06-04): a 1000 line approved as 10-store + 990-procure
       -- must show 990 in Vendor Rates, not 1000.
       AND (ii.source IS NULL OR ii.source <> 'store')
       -- RGP from SEPL's own returnable stock (source='rgp') goes to site and
       -- comes back — never purchased — so it stays out of Vendor Rates. BUT
       -- RGP marked source='procure' is NOT in stock and must be bought/rented,
       -- so it DOES need 3-vendor rates (mam 2026-06-22: "not go to 3 vendor
       -- even it is not in stock"). Only keep the returnable-stock RGP out.
       AND NOT (UPPER(COALESCE(ii.item_type, '')) = 'RGP'
                AND LOWER(COALESCE(ii.source, '')) <> 'procure')
       -- Lines the approver zeroed out (approved qty 0) aren't procured.
       AND COALESCE(ii.quantity, 0) > 0
     ORDER BY i.created_at DESC, ii.id`
  ).all();
  res.json(rows);
});

// Upsert a rate row for an indent item. Any of the 3 vendors (or the
// finalization fields) may be updated in one call.
router.post('/item-rates', needsApprove, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const iiId = parseInt(b.indent_item_id, 10);
  if (!iiId) return res.status(400).json({ error: 'indent_item_id is required' });

  // Belt-and-suspenders gate: even if the UI didn't filter, refuse to
  // write vendor rates for an indent that isn't fully approved yet.
  const block = assertIndentApprovedByItem(db, iiId);
  if (block) return res.status(block.status).json({ error: block.error });

  const existing = db.prepare('SELECT id FROM indent_item_rates WHERE indent_item_id=?').get(iiId);
  const fields = ['vendor1_name','vendor1_rate','vendor1_terms','vendor1_credit_days',
                  'vendor2_name','vendor2_rate','vendor2_terms','vendor2_credit_days',
                  'vendor3_name','vendor3_rate','vendor3_terms','vendor3_credit_days'];
  // Mark status 'quoted' once any vendor rate is set
  const anyRate = [b.vendor1_rate, b.vendor2_rate, b.vendor3_rate].some(v => Number(v) > 0);

  if (existing) {
    const sets = fields.map(f => `${f} = COALESCE(?, ${f})`).join(', ');
    const vals = fields.map(f => b[f] !== undefined ? b[f] : null);
    db.prepare(
      `UPDATE indent_item_rates
       SET ${sets}, status = COALESCE(?, status), updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(...vals, anyRate ? 'quoted' : null, existing.id);
    res.json({ id: existing.id, updated: true });
  } else {
    const cols = ['indent_item_id', ...fields, 'status', 'entered_by'];
    const vals = [iiId, ...fields.map(f => b[f] ?? null), anyRate ? 'quoted' : 'pending', req.user.id];
    const r = db.prepare(
      `INSERT INTO indent_item_rates (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    ).run(...vals);
    res.status(201).json({ id: r.lastInsertRowid, created: true });
  }
});

// AI "marketing rate" suggestion (mam 2026-06-19) — on-demand per item. Asks
// the configured AI model to estimate the current market PURCHASE rate for the
// item. Suggestion ONLY: saved to indent_item_rates.marketing_rate, never the
// 3 vendor rates. Gated to whoever can edit rates (procurement approve).
router.post('/item-rates/ai-suggest', needsApprove, async (req, res) => {
  const db = getDb();
  const iiId = parseInt(req.body?.indent_item_id, 10);
  if (!iiId) return res.status(400).json({ error: 'indent_item_id required' });
  const item = db.prepare(`
    SELECT ii.description, ii.make,
           LOWER(COALESCE(NULLIF(TRIM(im.uom),''), NULLIF(TRIM(ii.unit),''), 'nos')) AS unit
    FROM indent_items ii LEFT JOIN item_master im ON im.id = ii.item_master_id WHERE ii.id=?`).get(iiId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const apiKey = db.prepare('SELECT value FROM app_settings WHERE key=?').get('ai_api_key')?.value;
  if (!apiKey) return res.status(400).json({ error: 'AI not configured — add an API key in Admin → AI Settings' });
  const model = db.prepare('SELECT value FROM app_settings WHERE key=?').get('ai_model')?.value || 'claude-opus-4-7';
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); }
  catch (e) { return res.status(500).json({ error: 'AI SDK not installed on the server (run npm install on the VPS)' }); }
  try {
    const client = new Anthropic.default({ apiKey, timeout: 45000 });
    const prompt = `You estimate procurement market rates for an Indian electrical / fire-fighting / construction contractor. Give the LOWEST (minimum) current market PURCHASE rate in INR, per ${item.unit}, for the item below — the cheapest realistic price a buyer could get in the open market. Reply with ONLY a plain number in rupees — no currency symbol, no commas, no words.\n\nItem: ${item.description}${item.make ? `\nMake/Brand: ${item.make}` : ''}\nUnit: ${item.unit}`;
    const resp = await client.messages.create({ model, max_tokens: 40, messages: [{ role: 'user', content: prompt }] });
    const text = (resp?.content || []).map(c => c.text || '').join(' ');
    const m = String(text).replace(/[,\s₹]/g, '').match(/\d+(\.\d+)?/);
    const rate = m ? Math.round(parseFloat(m[0]) * 100) / 100 : 0;
    if (!rate) return res.status(422).json({ error: 'AI could not estimate a rate for this item' });
    db.prepare('INSERT OR IGNORE INTO indent_item_rates (indent_item_id, status) VALUES (?, ?)').run(iiId, 'pending');
    db.prepare('UPDATE indent_item_rates SET marketing_rate=?, updated_at=CURRENT_TIMESTAMP WHERE indent_item_id=?').run(rate, iiId);
    res.json({ marketing_rate: rate, model });
  } catch (err) {
    res.status(500).json({ error: 'AI request failed: ' + (err.message || 'error') });
  }
});

// AI "marketing rate" — BULK auto-suggest (mam 2026-06-19 "don't need to click,
// automatically rate here"). Estimates many items in ONE AI call. Only the ids
// passed are processed; the frontend sends just the ones still missing a rate,
// so it converges and never recomputes. Suggestion ONLY.
router.post('/item-rates/ai-suggest-bulk', needsApprove, async (req, res) => {
  const db = getDb();
  const ids = Array.isArray(req.body?.indent_item_ids)
    ? req.body.indent_item_ids.map(n => parseInt(n, 10)).filter(Boolean).slice(0, 40) : [];
  if (!ids.length) return res.json({ results: [] });
  const apiKey = db.prepare('SELECT value FROM app_settings WHERE key=?').get('ai_api_key')?.value;
  if (!apiKey) return res.status(400).json({ error: 'AI not configured — add an API key in Admin → AI Settings' });
  const model = db.prepare('SELECT value FROM app_settings WHERE key=?').get('ai_model')?.value || 'claude-opus-4-7';
  const ph = ids.map(() => '?').join(',');
  const items = db.prepare(`
    SELECT ii.id, ii.description, ii.make,
           LOWER(COALESCE(NULLIF(TRIM(im.uom),''), NULLIF(TRIM(ii.unit),''), 'nos')) AS unit
    FROM indent_items ii LEFT JOIN item_master im ON im.id = ii.item_master_id WHERE ii.id IN (${ph})`).all(...ids);
  if (!items.length) return res.json({ results: [] });
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); }
  catch (e) { return res.status(500).json({ error: 'AI SDK not installed on the server (run npm install on the VPS)' }); }
  try {
    const client = new Anthropic.default({ apiKey, timeout: 90000 });
    const list = items.map(it => `${it.id}|${it.description}${it.make ? ` (Make: ${it.make})` : ''}|per ${it.unit}`).join('\n');
    const prompt = `You estimate procurement market rates for an Indian electrical / fire-fighting / construction contractor. For EACH item below, give the LOWEST (minimum) current market PURCHASE rate in INR per its unit — the cheapest realistic open-market price a buyer could get. Each line is "id|description|unit". Reply with ONLY a JSON array of objects like [{"id":123,"rate":450}] — one per item, rate a plain number, no commas, no other text.\n\n${list}`;
    const resp = await client.messages.create({ model, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] });
    const text = (resp?.content || []).map(c => c.text || '').join(' ');
    const jm = text.match(/\[[\s\S]*\]/);
    let arr = [];
    try { arr = JSON.parse(jm ? jm[0] : text); } catch (_) { arr = []; }
    const ins = db.prepare('INSERT OR IGNORE INTO indent_item_rates (indent_item_id, status) VALUES (?, ?)');
    const upd = db.prepare('UPDATE indent_item_rates SET marketing_rate=?, updated_at=CURRENT_TIMESTAMP WHERE indent_item_id=?');
    const idSet = new Set(ids);
    const results = [];
    db.transaction(() => {
      for (const o of (Array.isArray(arr) ? arr : [])) {
        const id = parseInt(o?.id, 10);
        const rate = Math.round((+o?.rate || 0) * 100) / 100;
        if (id && rate > 0 && idSet.has(id)) { ins.run(id, 'pending'); upd.run(rate, id); results.push({ id, rate }); }
      }
    })();
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: 'AI request failed: ' + (err.message || 'error') });
  }
});

// Finalize — admin / approver picks one of the three vendors (or enters a
// custom final rate). After this, downstream steps (Vendor PO, Bill) use
// the final_* columns.
router.post('/item-rates/:id/finalize', needsApprove, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const { final_rate, final_vendor_name, final_terms, final_credit_days } = b;
  if (!final_vendor_name || !final_rate) return res.status(400).json({ error: 'final_vendor_name and final_rate are required' });

  // Same gate as the upsert — block finalization if the parent indent
  // isn't fully approved (defends against direct API calls).
  const block = assertIndentApprovedByRate(db, req.params.id);
  if (block) return res.status(block.status).json({ error: block.error });
  db.prepare(
    `UPDATE indent_item_rates
     SET final_rate=?, final_vendor_name=?, final_terms=?, final_credit_days=?,
         status='finalized', finalized_by=?, finalized_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
     WHERE id=?`
  ).run(+final_rate, final_vendor_name, final_terms || null, +final_credit_days || 0, req.user.id, req.params.id);
  res.json({ message: 'Finalized' });
});

// ADMIN ONLY — wipe all dispatches/indents, vendor POs, purchase bills,
// delivery notes and vendor rate rows. Used when mam wants a clean slate.
// Irreversible; the UI protects with a double confirmation.
router.post('/admin/wipe-indents-pos', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const db = getDb();
  const counts = {
    indents: db.prepare('SELECT COUNT(*) as c FROM indents').get().c,
    vendor_pos: db.prepare('SELECT COUNT(*) as c FROM vendor_pos').get().c,
    purchase_bills: db.prepare('SELECT COUNT(*) as c FROM purchase_bills').get().c,
    delivery_notes: db.prepare('SELECT COUNT(*) as c FROM delivery_notes').get().c,
  };
  // Delete child rows first to avoid FK issues (SQLite isn't enforcing by
  // default here but this keeps things tidy either way).
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM grn_items').run();
    db.prepare('DELETE FROM grn').run();
    db.prepare('DELETE FROM indent_tracker').run();
    db.prepare('DELETE FROM delivery_notes').run();
    db.prepare('DELETE FROM purchase_bills').run();
    db.prepare('DELETE FROM vendor_rates').run();
    db.prepare('DELETE FROM vendor_pos').run();
    db.prepare('DELETE FROM indent_items').run();
    db.prepare('DELETE FROM indents').run();
  });
  tx();
  res.json({ message: 'Wiped', counts });
});

// Upload / replace the BOQ for the currently-selected site directly from
// the Raise Indent modal. Creates a stub PO if none exists yet, so a user
// can start indenting immediately without bouncing to Orders. Replaces
// existing po_items for that business_book and saves the file link to the
// PO's boq_file_link.
// BOQ bulk upload (Raise Indent tab). Reuses the shared uploadDir defined
// at the top of this file — no need to re-require multer.
const bulkUpload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

// Fetch items from the BOQ that's ALREADY attached somewhere (PO file link,
// BOQ module via quotation, etc.) — no re-upload needed. Mam's usual case:
// BOQ was uploaded during PO creation; items either weren't saved to po_items
// or were never saved because the final 'Update Purchase Order' step was
// skipped. This endpoint fishes the items out and persists them to po_items.
router.post('/fetch-existing-boq', (req, res) => {
  const siteName = String(req.body?.site_name || '').trim();
  if (!siteName) return res.status(400).json({ error: 'site_name is required' });
  const db = getDb();

  // 1. Resolve business_book_id (same tolerant matcher)
  let bbId = null;
  const viaSite = db.prepare(
    `SELECT DISTINCT s.business_book_id FROM sites s
     WHERE LOWER(TRIM(s.name)) = LOWER(TRIM(?)) AND s.business_book_id IS NOT NULL LIMIT 1`
  ).get(siteName);
  if (viaSite?.business_book_id) bbId = viaSite.business_book_id;
  if (!bbId) {
    const viaBB = db.prepare(
      `SELECT id FROM business_book
       WHERE LOWER(TRIM(project_name)) = LOWER(TRIM(?))
          OR LOWER(TRIM(company_name)) = LOWER(TRIM(?))
          OR LOWER(TRIM(client_name))  = LOWER(TRIM(?))
       LIMIT 1`
    ).get(siteName, siteName, siteName);
    if (viaBB?.id) bbId = viaBB.id;
  }
  if (!bbId) return res.status(404).json({ error: `No Business Book entry matches "${siteName}"` });

  // 2. Try each source in order and return the first that yields items.
  const sources = [];

  // 2a. Parse PO's boq_file_link from disk
  const po = db.prepare(
    `SELECT id, po_number, boq_file_link FROM purchase_orders
     WHERE business_book_id=? AND boq_file_link IS NOT NULL AND boq_file_link != ''
     ORDER BY created_at DESC LIMIT 1`
  ).get(bbId);
  if (po?.boq_file_link) {
    const filename = path.basename(po.boq_file_link);
    const diskPath = path.join(__dirname, '..', '..', 'data', 'uploads', filename);
    if (fs.existsSync(diskPath)) {
      const parsed = parseBoqExcel(diskPath);
      if (parsed.length > 0) sources.push({ name: 'po_file', items: parsed, po_number: po.po_number });
    }
  }

  // 2b. boq_items via quotations tied to this project's lead
  if (sources.length === 0) {
    const leadRows = db.prepare(
      `SELECT DISTINCT lead_id FROM business_book WHERE id=? AND lead_id IS NOT NULL`
    ).all(bbId);
    const leadIds = leadRows.map(r => r.lead_id);
    if (leadIds.length > 0) {
      const leadPH = leadIds.map(() => '?').join(',');
      const boqRows = db.prepare(
        `SELECT bi.description, bi.quantity, bi.unit, bi.rate, bi.amount
         FROM boq_items bi
         JOIN boq b ON b.id = bi.boq_id
         WHERE b.lead_id IN (${leadPH})`
      ).all(...leadIds);
      if (boqRows.length > 0) {
        sources.push({
          name: 'boq_module',
          items: boqRows.map((r, i) => ({
            description: r.description, unit: r.unit || 'nos', boq_qty: r.quantity,
          })),
        });
      }
    }
  }

  if (sources.length === 0) {
    return res.status(404).json({
      error: po?.boq_file_link
        ? `BOQ file is attached to PO ${po.po_number} but could not be read or parsed.`
        : 'No BOQ file attached to the PO, and no BOQ items in the BOQ module for this project.',
    });
  }

  // 3. Persist into po_items so Remaining tracking works across indents
  const src = sources[0];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM po_items WHERE business_book_id=?').run(bbId);
    const ins = db.prepare('INSERT INTO po_items (business_book_id, description, quantity, unit, rate, amount) VALUES (?,?,?,?,?,?)');
    for (const it of src.items) {
      ins.run(bbId, it.description, it.boq_qty || it.quantity || 0, it.unit || 'nos', it.rate || 0, it.amount || 0);
    }
  });
  tx();

  res.json({ message: 'Items fetched', items_saved: src.items.length, source: src.name, po_number: src.po_number || null });
});

router.post('/upload-boq-for-site', bulkUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const siteName = String(req.body?.site_name || '').trim();
  if (!siteName) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    return res.status(400).json({ error: 'site_name is required' });
  }

  const db = getDb();
  // Resolve business_book id (case-insensitive, tolerant)
  let bbId = null;
  const viaSite = db.prepare(
    `SELECT DISTINCT s.business_book_id FROM sites s
     WHERE LOWER(TRIM(s.name)) = LOWER(TRIM(?)) AND s.business_book_id IS NOT NULL LIMIT 1`
  ).get(siteName);
  if (viaSite?.business_book_id) bbId = viaSite.business_book_id;
  if (!bbId) {
    const viaBB = db.prepare(
      `SELECT id FROM business_book
       WHERE LOWER(TRIM(project_name)) = LOWER(TRIM(?))
          OR LOWER(TRIM(company_name)) = LOWER(TRIM(?))
          OR LOWER(TRIM(client_name))  = LOWER(TRIM(?))
       LIMIT 1`
    ).get(siteName, siteName, siteName);
    if (viaBB?.id) bbId = viaBB.id;
  }
  if (!bbId) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    return res.status(404).json({ error: `No Business Book entry found matching "${siteName}"` });
  }

  // Rename file to something readable + served from /uploads
  const safeName = (req.file.originalname || 'boq.xlsx').replace(/[^a-zA-Z0-9._-]/g, '_');
  const newName = `${Date.now()}-${safeName}`;
  const newPath = path.join(uploadDir, newName);
  try { fs.renameSync(req.file.path, newPath); } catch (e) { /* fall through */ }
  const fileUrl = `/uploads/${newName}`;

  // Parse items — only meaningful for Excel; PDFs just attach the link.
  const isExcel = /\.(xlsx|xls)$/i.test(req.file.originalname || '');
  let parsedItems = [];
  if (isExcel) parsedItems = parseBoqExcel(fs.existsSync(newPath) ? newPath : req.file.path);

  // Ensure a PO exists for this business_book so boq_file_link can be stored
  let po = db.prepare(
    'SELECT id, boq_file_link FROM purchase_orders WHERE business_book_id=? ORDER BY created_at DESC LIMIT 1'
  ).get(bbId);
  if (!po) {
    const stubNum = `AUTO-${bbId}-${Date.now().toString().slice(-6)}`;
    const r = db.prepare(
      `INSERT INTO purchase_orders (business_book_id, po_number, po_date, boq_file_link, site_engineer_id, site_engineer_ids, crm_name, created_by)
       VALUES (?, ?, DATE('now'), ?, ?, ?, ?, ?)`
    ).run(bbId, stubNum, fileUrl, req.user.id, String(req.user.id), 'Auto', req.user.id);
    po = { id: r.lastInsertRowid, boq_file_link: fileUrl };
  } else {
    db.prepare('UPDATE purchase_orders SET boq_file_link=? WHERE id=?').run(fileUrl, po.id);
  }

  // Replace po_items for this business_book with the parsed set
  let savedCount = 0;
  if (parsedItems.length > 0) {
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM po_items WHERE business_book_id=?').run(bbId);
      const ins = db.prepare(
        'INSERT INTO po_items (business_book_id, description, quantity, unit, rate, amount) VALUES (?,?,?,?,?,?)'
      );
      for (const it of parsedItems) {
        ins.run(bbId, it.description, it.boq_qty, it.unit || 'nos', 0, 0);
        savedCount++;
      }
    });
    tx();
  }

  res.json({ message: 'BOQ saved', file_url: fileUrl, items_saved: savedCount, parsed_items_count: parsedItems.length, business_book_id: bbId, po_id: po.id });
});

module.exports = router;
