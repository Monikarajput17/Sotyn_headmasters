const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Use the same shared uploads dir Procurement uses, so the file name
// goes through Multer's tempfile handling and then we read it back.
const uploadDir = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const bulkUpload = multer({ dest: uploadDir, limits: { fileSize: 5 * 1024 * 1024 } });

// Anyone with item-master view permission (or admin) can also approve /
// finalize price requests — same gate as Procurement uses for vendor rates.
const canQuote = (req) => req.user.role === 'admin' || (() => {
  const db = getDb();
  const row = db.prepare(`
    SELECT MAX(rp.can_approve) as ok
    FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
    WHERE ur.user_id = ? AND rp.module IN ('procurement','item_master')
  `).get(req.user.id);
  return !!row?.ok;
})();

// ------- LIST -------
// scope=mine | all   (non-quoters always see their own; quoters see all by default)
// status=open|quoted|finalized|added
router.get('/', (req, res) => {
  const db = getDb();
  const isQuoter = canQuote(req);
  const { status, scope } = req.query;
  const where = []; const params = [];
  // Regular users only see what they raised. Quoters see everything by default
  // but can switch to "mine" to focus on their own raises.
  if (!isQuoter || scope === 'mine') { where.push('p.raised_by = ?'); params.push(req.user.id); }
  if (status) { where.push('p.status = ?'); params.push(status); }
  // JOIN item_master so the All Requests list can display the auto-generated
  // item_code (e.g. PO-0042) right next to the "in Master" badge — saves
  // mam from having to flip over to the Item Master page to look it up.
  const sql = `
    SELECT p.*,
           u.name as raised_by_name,
           fu.name as finalized_by_name,
           im.item_code as master_item_code
      FROM price_requests p
      LEFT JOIN users u  ON u.id  = p.raised_by
      LEFT JOIN users fu ON fu.id = p.finalized_by
      LEFT JOIN item_master im ON im.id = p.item_master_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY p.status='added' ASC, p.created_at DESC
  `;
  res.json(db.prepare(sql).all(...params));
});

// ------- CREATE (Stage 1) -------
// Any authenticated user. Site engineer raises a request for a new item.
router.post('/', (req, res) => {
  const b = req.body || {};
  if (!b.item_name || !String(b.item_name).trim()) {
    return res.status(400).json({ error: 'Item name is required' });
  }
  // Mam (2026-05-25): "HERE DEPARTMENT IS MEDATORY AND ACCORDING TO THAT
  // ITEM NAME CREATE AT PLACE OF PO" — department must be filled so the
  // auto-generated item_code can use the right prefix (FF / ELV / ELE...).
  if (!b.department || !String(b.department).trim()) {
    return res.status(400).json({ error: 'Department is required (drives the item_code prefix when promoted to Item Master)' });
  }
  const allowedTypes = ['PO', 'FOC', 'RGP'];
  const itemType = allowedTypes.includes(String(b.item_type || '').toUpperCase())
    ? String(b.item_type).toUpperCase() : 'PO';
  const r = getDb().prepare(`
    INSERT INTO price_requests
      (site_name, item_name, size, specification, make, uom, item_type, department, notes, raised_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    b.site_name || null,
    String(b.item_name).trim(),
    b.size || null,
    b.specification || null,
    b.make || null,
    b.uom || 'PCS',
    itemType,
    b.department ? String(b.department).trim().toUpperCase() : null,
    b.notes || null,
    req.user.id,
  );
  res.status(201).json({ id: r.lastInsertRowid });
});

// ------- EDIT request details (raiser or admin) -------
// Only the item-description fields can be changed here — vendor quotes and
// finalize state have their own endpoints. Locked after the item has been
// promoted to Item Master so the master row's source-of-truth doesn't drift.
router.put('/:id', (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT raised_by, status FROM price_requests WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const isOwner = cur.raised_by === req.user.id;
  if (!(req.user.role === 'admin' || isOwner)) return res.status(403).json({ error: 'Not allowed' });
  if (cur.status === 'added') return res.status(400).json({ error: 'Cannot edit after item promoted to master' });

  const b = req.body || {};
  if (b.item_name !== undefined && !String(b.item_name).trim()) {
    return res.status(400).json({ error: 'Item name is required' });
  }
  // Pull current row to preserve fields the form didn't send.
  const full = db.prepare('SELECT * FROM price_requests WHERE id=?').get(req.params.id);
  db.prepare(`UPDATE price_requests SET
      site_name=?, item_name=?, size=?, specification=?, make=?, uom=?, item_type=?, department=?, notes=?
    WHERE id=?`).run(
    b.site_name !== undefined ? b.site_name : full.site_name,
    b.item_name !== undefined ? String(b.item_name).trim() : full.item_name,
    b.size !== undefined ? b.size : full.size,
    b.specification !== undefined ? b.specification : full.specification,
    b.make !== undefined ? b.make : full.make,
    b.uom !== undefined ? b.uom : full.uom,
    b.item_type !== undefined ? b.item_type : full.item_type,
    b.department !== undefined ? b.department : full.department,
    b.notes !== undefined ? b.notes : full.notes,
    req.params.id,
  );
  res.json({ message: 'Updated' });
});

// ------- DELETE (raiser or admin) -------
router.delete('/:id', (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT raised_by, status FROM price_requests WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const isOwner = cur.raised_by === req.user.id;
  if (!(req.user.role === 'admin' || isOwner)) return res.status(403).json({ error: 'Not allowed' });
  if (cur.status === 'added') return res.status(400).json({ error: 'Cannot delete after item promoted to master' });
  db.prepare('DELETE FROM price_requests WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ------- GROUPED VIEW (Stage 2 — for the quoting team) -------
// Identical items raised by multiple sites collapse into one row so vendor
// rates are entered once. Group key: lower(item_name, size, spec, make, uom, item_type).
// One representative request id is returned to act as the "merge anchor".
router.get('/grouped', (req, res) => {
  if (!canQuote(req)) return res.status(403).json({ error: 'Quoting permission required' });
  const db = getDb();
  // Pull every non-added request and group in JS — small dataset, easier to reason about.
  const rows = db.prepare(`
    SELECT p.*, u.name as raised_by_name
      FROM price_requests p
      LEFT JOIN users u ON u.id = p.raised_by
     WHERE p.status IN ('open','quoted')
     ORDER BY p.created_at ASC
  `).all();
  const norm = (s) => String(s || '').trim().toLowerCase();
  const map = new Map();
  for (const r of rows) {
    const key = [r.item_name, r.size, r.specification, r.make, r.uom, r.item_type].map(norm).join('|');
    if (!map.has(key)) {
      map.set(key, {
        anchor_id: r.id,
        item_name: r.item_name, size: r.size, specification: r.specification,
        make: r.make, uom: r.uom, item_type: r.item_type,
        request_ids: [],
        sites: [],
        // vendor + final fields are taken from the anchor (first request) so
        // updates always target a single canonical id.
        vendor1_name: r.vendor1_name, vendor1_rate: r.vendor1_rate, vendor1_terms: r.vendor1_terms,
        vendor2_name: r.vendor2_name, vendor2_rate: r.vendor2_rate, vendor2_terms: r.vendor2_terms,
        vendor3_name: r.vendor3_name, vendor3_rate: r.vendor3_rate, vendor3_terms: r.vendor3_terms,
        final_vendor_name: r.final_vendor_name, final_rate: r.final_rate, final_terms: r.final_terms,
        status: r.status,
      });
    }
    const g = map.get(key);
    g.request_ids.push(r.id);
    if (r.site_name && !g.sites.includes(r.site_name)) g.sites.push(r.site_name);
  }
  res.json([...map.values()]);
});

// ------- UPDATE VENDOR RATE (Stage 2) -------
// Patch one or more vendor fields on the anchor. The status auto-flips to
// 'quoted' once any vendor has a positive rate.
router.put('/:id/rate', (req, res) => {
  if (!canQuote(req)) return res.status(403).json({ error: 'Quoting permission required' });
  const db = getDb();
  const cur = db.prepare('SELECT * FROM price_requests WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  if (cur.status === 'added') return res.status(400).json({ error: 'Already promoted to master' });

  const b = req.body || {};
  const sets = []; const params = [];
  const set = (k, v) => { sets.push(`${k}=?`); params.push(v); };
  for (const n of [1, 2, 3]) {
    if (b[`vendor${n}_name`] !== undefined)  set(`vendor${n}_name`,  b[`vendor${n}_name`] || null);
    if (b[`vendor${n}_rate`] !== undefined)  set(`vendor${n}_rate`,  b[`vendor${n}_rate`] === '' ? null : +b[`vendor${n}_rate`]);
    if (b[`vendor${n}_terms`] !== undefined) set(`vendor${n}_terms`, b[`vendor${n}_terms`] || null);
  }
  // Bump status to 'quoted' once at least one vendor has rate > 0
  const nextRow = { ...cur };
  for (const k of sets) {} // (no-op — sets is array of strings)
  // Re-derive from the patch + cur
  const merged = { ...cur };
  if (b.vendor1_rate !== undefined) merged.vendor1_rate = +b.vendor1_rate || 0;
  if (b.vendor2_rate !== undefined) merged.vendor2_rate = +b.vendor2_rate || 0;
  if (b.vendor3_rate !== undefined) merged.vendor3_rate = +b.vendor3_rate || 0;
  const anyRate = [merged.vendor1_rate, merged.vendor2_rate, merged.vendor3_rate].some(v => +v > 0);
  if (cur.status !== 'finalized' && anyRate) set('status', 'quoted');

  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  sets.push('updated_at=CURRENT_TIMESTAMP');
  params.push(req.params.id);
  db.prepare(`UPDATE price_requests SET ${sets.join(', ')} WHERE id=?`).run(...params);
  res.json({ message: 'Rate updated' });
});

// ------- FINALIZE + PROMOTE TO ITEM MASTER (Stages 3 + 4) -------
// Body: { final_vendor_name, final_rate, final_terms, propagate_to_group: bool }
// If propagate_to_group is true (default), the finalize is also written to all
// other requests sharing the same item identity, AND a single item_master entry
// is created and linked to every one of them.
router.post('/:id/finalize', (req, res) => {
  if (!canQuote(req)) return res.status(403).json({ error: 'Quoting permission required' });
  const db = getDb();
  const cur = db.prepare('SELECT * FROM price_requests WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  if (cur.status === 'added') return res.status(400).json({ error: 'Already promoted to master' });

  const { final_vendor_name, final_rate, final_terms, propagate_to_group } = req.body || {};
  if (!final_vendor_name || !(+final_rate > 0)) {
    return res.status(400).json({ error: 'Final vendor name and a positive final rate are required' });
  }

  // Find sibling requests (same item identity) when propagation is on
  const propagate = propagate_to_group !== false;
  const norm = (s) => String(s || '').trim().toLowerCase();
  const myKey = [cur.item_name, cur.size, cur.specification, cur.make, cur.uom, cur.item_type].map(norm).join('|');
  const allOpen = db.prepare(`SELECT * FROM price_requests WHERE status IN ('open','quoted')`).all();
  const siblings = propagate
    ? allOpen.filter(r => [r.item_name, r.size, r.specification, r.make, r.uom, r.item_type].map(norm).join('|') === myKey)
    : [cur];
  // Always include `cur` even if it's already 'finalized'
  if (!siblings.find(s => s.id === cur.id)) siblings.push(cur);

  // 1) Auto-generate item_code with a DEPARTMENT-driven prefix (mam
  //    2026-05-25: "ITEM NAME CREATE AT PLACE OF PO IF DEPARTMENT FF
  //    THEN FF IF SELECT ELV THEN START FRO ELV").  Matches the
  //    convention already in the master sheet (FF1806, ELV0986, ELE0034,
  //    OTH0006...) — no hyphen, 4-digit sequence, per-department counter.
  //
  //    Map common SEPL department names to their established prefixes;
  //    fall back to first 3 alpha chars of the dept name for anything
  //    we don't know about.  Sequence is the max existing numeric suffix
  //    for that prefix + 1, so we never collide with legacy codes.
  const DEPT_PREFIX = {
    'fire fighting': 'FF', 'fire': 'FF', 'ff': 'FF',
    'elv': 'ELV', 'extra low voltage': 'ELV',
    'electrical': 'ELE', 'ele': 'ELE', 'electric': 'ELE',
    'lv': 'LV', 'low voltage': 'LV',
    'civil': 'CIV',
    'mep': 'MEP',
    'hvac': 'HVAC',
    'plumbing': 'PLM',
    'general': 'GEN', 'gen': 'GEN',
    'other': 'OTH', 'others': 'OTH',
  };
  const deptKey = String(cur.department || '').trim().toLowerCase();
  let codePrefix = DEPT_PREFIX[deptKey];
  if (!codePrefix) {
    const cleaned = deptKey.replace(/[^a-z]/g, '');
    codePrefix = (cleaned.slice(0, 3) || 'GEN').toUpperCase();
  }
  // Find the highest existing suffix for this prefix → next is +1.  Uses
  // LIKE to scope to the prefix; the regex on the matched code extracts
  // the numeric tail safely even if the suffix length differs.
  const topRow = db.prepare(
    `SELECT item_code FROM item_master
      WHERE item_code LIKE ?
      ORDER BY LENGTH(item_code) DESC, item_code DESC
      LIMIT 1`
  ).get(codePrefix + '%');
  let nextSeq = 1;
  if (topRow?.item_code) {
    const m = String(topRow.item_code).match(/(\d+)$/);
    if (m) nextSeq = (+m[1] || 0) + 1;
  }
  const itemCode = `${codePrefix}${String(nextSeq).padStart(4, '0')}`;
  const itemMasterIns = db.prepare(`
    INSERT INTO item_master
      (item_code, item_name, specification, size, uom, type, make, current_price, gst, department)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const r = itemMasterIns.run(
    itemCode,
    cur.item_name,
    cur.specification || '',
    cur.size || '',
    cur.uom || 'PCS',
    cur.item_type || 'PO',
    final_vendor_name || cur.make || '',
    +final_rate || 0,
    '18%',
    cur.department || null,
  );
  const newMasterId = r.lastInsertRowid;

  // 2) Update every sibling request: set final fields, status='added', link to master.
  const upd = db.prepare(`
    UPDATE price_requests
       SET final_vendor_name = ?,
           final_rate        = ?,
           final_terms       = ?,
           finalized_by      = ?,
           finalized_at      = CURRENT_TIMESTAMP,
           status            = 'added',
           item_master_id    = ?,
           updated_at        = CURRENT_TIMESTAMP
     WHERE id = ?
  `);
  for (const s of siblings) {
    upd.run(final_vendor_name, +final_rate, final_terms || null, req.user.id, newMasterId, s.id);
  }

  res.json({
    message: 'Rate finalized and item added to Item Master',
    item_master_id: newMasterId,
    item_code: itemCode,
    propagated_count: siblings.length,
  });
});

// ------- BULK ENTRY: TEMPLATE DOWNLOAD -------
// Mam: "give above excel template to raise price required so that can do
// easily in bulk". Returns an XLSX with the right columns + one example
// row + a "Notes" sheet explaining the allowed values. Mam fills it in,
// hits Bulk Upload, and every row becomes a price_requests entry.
router.get('/template', (req, res) => {
  const wb = XLSX.utils.book_new();
  // Sheet 1: the entry grid the user fills in.
  const header = [
    'Site Name',          // optional — which site the item is needed for
    'Item Name *',        // required — e.g. "Fire Door"
    'Size',               // e.g. "h-2330mm w-2025mm"
    'Specification',      // e.g. "SS 304"
    'Make',               // preferred brand, e.g. "Trdt"
    'UOM',                // PCS / KG / MTR / SET / NOS (default PCS)
    'Item Type',          // PO / FOC / RGP (default PO)
    'Department',         // ELECTRICAL / HVAC / FF / PLUMBING / ELV / SOLAR / CIVIL
    'Notes',              // any extra detail for purchase team
  ];
  // One illustrative row so mam can see the expected format.
  const sample = [
    'CONSERN PHARMA',
    'Fire Door',
    'h-2330mm w-2025mm',
    'SS 304',
    'Trdt',
    'PCS',
    'PO',
    'FIRE FIGHTING',
    'Urgent — needed for site walkthrough',
  ];
  const sheet1 = XLSX.utils.aoa_to_sheet([header, sample, [], []]);
  // Set sensible column widths so the template is readable on first open.
  sheet1['!cols'] = [
    { wch: 22 }, { wch: 30 }, { wch: 22 }, { wch: 22 }, { wch: 14 },
    { wch: 8 },  { wch: 10 }, { wch: 18 }, { wch: 40 },
  ];
  XLSX.utils.book_append_sheet(wb, sheet1, 'Price Requests');
  // Sheet 2: instructions + allowed values, so mam doesn't have to ask.
  const instructions = [
    ['SEPL ERP — Price Request Bulk Template'],
    [''],
    ['HOW TO USE'],
    ['1. Fill one row per item below the "Sample row" on the "Price Requests" sheet.'],
    ['2. Leave the Sample row in place (the importer skips it). Or delete it — both work.'],
    ['3. Save the file, then click "Bulk Upload" on the Price Required page.'],
    ['4. Each row becomes an Open price request. Purchase team will quote the rates.'],
    [''],
    ['FIELD RULES'],
    ['Item Name (required)', 'Must not be blank. Free text. Keep it short and clean.'],
    ['UOM',  'Defaults to PCS if blank. Common: PCS, NOS, KG, MTR, SET, LTR, BOX.'],
    ['Item Type', 'Must be one of: PO, FOC, RGP. Defaults to PO if blank.'],
    ['Department', 'Free text but use one of: ELECTRICAL, HVAC, FIRE FIGHTING, PLUMBING, SOLAR, ELV, CIVIL.'],
    ['Site Name', 'Optional. If filled it should match a site from Business Book.'],
    [''],
    ['DEDUPLICATION'],
    ['Identical items (Name + Size + Spec + Make + UOM + Type) merge into one request when shown to the purchase team — no need to worry about duplicates across sites.'],
  ];
  const sheet2 = XLSX.utils.aoa_to_sheet(instructions);
  sheet2['!cols'] = [{ wch: 32 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(wb, sheet2, 'Instructions');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', 'attachment; filename="SEPL_PriceRequired_Template.xlsx"');
  res.send(buf);
});

// ------- BULK ENTRY: UPLOAD -------
// Accepts the filled template (or any compatible xlsx/csv). Parses each
// row, validates Item Name is present, and inserts a price_requests row
// per item attributed to the current user. Returns summary + per-row
// errors so the UI can show what failed.
router.post('/bulk-upload', bulkUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload an .xlsx or .csv file' });
  let rows = [];
  try {
    const wb = XLSX.readFile(req.file.path);
    // Prefer a sheet named "Price Requests"; otherwise use the first.
    const sheetName = wb.SheetNames.find(n => /price/i.test(n)) || wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    if (!ws) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ error: 'No usable sheet found in the file' });
    }
    rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(400).json({ error: 'Could not read the file: ' + e.message });
  }
  try { fs.unlinkSync(req.file.path); } catch (_) {}

  // Header normalizer — accept "Item Name *", "ITEM NAME", "item_name" etc.
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s_*]+/g, '');
  const pick = (row, ...keys) => {
    for (const k of keys) {
      const wanted = norm(k);
      const hit = Object.keys(row).find(rk => norm(rk) === wanted);
      if (hit && String(row[hit]).trim() !== '') return String(row[hit]).trim();
    }
    return '';
  };

  const allowedTypes = ['PO', 'FOC', 'RGP'];
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO price_requests
      (site_name, item_name, size, specification, make, uom, item_type, department, notes, raised_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);

  const inserted = [];
  const skipped = [];
  const tx = db.transaction((rows) => {
    rows.forEach((row, idx) => {
      const item_name = pick(row, 'Item Name', 'item_name');
      // Detect & silently skip the sample row from the template so it
      // doesn't pollute the live list.
      const isSample = pick(row, 'Item Name').toLowerCase() === 'fire door'
        && pick(row, 'Notes').toLowerCase().includes('site walkthrough');
      if (!item_name) {
        // Skip totally blank rows without flagging them as errors.
        const anyVal = Object.values(row).some(v => String(v || '').trim() !== '');
        if (anyVal) skipped.push({ row: idx + 2, reason: 'Item Name is required' });
        return;
      }
      if (isSample) { skipped.push({ row: idx + 2, reason: 'Sample row skipped' }); return; }

      const rawType = pick(row, 'Item Type', 'item_type').toUpperCase();
      const item_type = allowedTypes.includes(rawType) ? rawType : 'PO';

      const r = insert.run(
        pick(row, 'Site Name', 'site_name') || null,
        item_name,
        pick(row, 'Size') || null,
        pick(row, 'Specification', 'spec') || null,
        pick(row, 'Make') || null,
        pick(row, 'UOM') || 'PCS',
        item_type,
        (pick(row, 'Department') || '').toUpperCase() || null,
        pick(row, 'Notes') || null,
        req.user.id,
      );
      inserted.push({ row: idx + 2, id: r.lastInsertRowid, item_name });
    });
  });
  try {
    tx(rows);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  res.json({
    message: `Imported ${inserted.length} price request${inserted.length === 1 ? '' : 's'}${skipped.length ? ` (${skipped.length} skipped)` : ''}`,
    inserted_count: inserted.length,
    skipped_count: skipped.length,
    inserted,
    skipped,
  });
});

module.exports = router;
