const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const ALLOWED_SOURCES = ['PO', 'Quote', 'Manual', 'Online'];

// MD Phase 1: "Right now Price is just a number — no date, no vendor,
// no bill. We can't trust it for tenders." Every Item Master row now
// surfaces:
//   - age_days     — days since the ACTUAL rate date (bill_po_date),
//                    NOT since the row was typed into ERP. Mam: "u
//                    pick its from when we enter in erp itemwise
//                    sheet" — a 2-year-old rate imported today should
//                    NOT show as 0 days. Falls back to priced_at /
//                    updated_at only when no bill_po_date is set.
//   - age_status   — green ≤30 / yellow 31-60 / red 60+ / never (no
//                    price set yet) so the UI can colour the row.
// And the filter param accepts status=expired|ageing|fresh|never|
// make_blank|no_vendor for the top-row filter pills.
function ageStatus(days) {
  if (days == null) return 'never';
  if (days <= 30) return 'green';
  if (days <= 60) return 'yellow';
  return 'red';
}

// SQL snippet that picks the right "rate date" to age from. Bill/PO
// date is the real-world evidence date; we fall back to priced_at
// (when staff captured it) only if no bill date was recorded. Returns
// NULL when no price/bill is set so the row shows NEVER.
const AGE_DATE_EXPR = `COALESCE(im.bill_po_date, im.priced_at, CASE WHEN im.current_price > 0 THEN im.updated_at END)`;

// Speed-up indexes for the filter pills (mam, 2026-05-28: "items wise
// master takes time to open like hang" — 2,385 rows × 5 filter columns
// without indexes meant each click did a full scan).
try { getDb().exec(`CREATE INDEX IF NOT EXISTS idx_im_department    ON item_master(department)`); } catch (_) {}
try { getDb().exec(`CREATE INDEX IF NOT EXISTS idx_im_vendor_id     ON item_master(vendor_id)`); } catch (_) {}
try { getDb().exec(`CREATE INDEX IF NOT EXISTS idx_im_make          ON item_master(make)`); } catch (_) {}
try { getDb().exec(`CREATE INDEX IF NOT EXISTS idx_im_bill_po_date  ON item_master(bill_po_date)`); } catch (_) {}
try { getDb().exec(`CREATE INDEX IF NOT EXISTS idx_im_item_code     ON item_master(item_code)`); } catch (_) {}
try { getDb().exec(`CREATE INDEX IF NOT EXISTS idx_im_approval       ON item_master(approval_status)`); } catch (_) {}

// Guarantee the pricing/approval columns the list query joins on actually
// exist (mam 2026-06-16: "data is missing"). The central migration adds these
// with a "REFERENCES users(id)" clause, which some SQLite builds reject in an
// ALTER ... ADD COLUMN — and since that migration is wrapped in a silent
// try/catch, the column ends up missing on those servers. The Item Master list
// JOINs on approved_by / priced_by, so a missing column made the WHOLE list
// 500 and show "0 items / No items found", while the completion dashboard
// (which never touches these columns) kept reporting the real count. Re-adding
// them here with a plain ADD COLUMN (no REFERENCES) is idempotent and safe.
for (const col of [
  'priced_at DATETIME',
  'priced_by INTEGER',
  'approved_by INTEGER',
  'approved_at DATETIME',
  "approval_status TEXT DEFAULT 'approved'",
]) {
  try { getDb().exec(`ALTER TABLE item_master ADD COLUMN ${col}`); } catch (_) {}
}

// One-time backfill (mam 2026-06-16): flag items added in the LAST 2 DAYS
// (i.e. "yesterday's new entries") as pending so an Admin reviews them;
// everything older stays approved (the column default already grandfathered
// every existing row to 'approved'). Guarded by an app_settings sentinel so
// it runs exactly once per deploy of this rule.
try {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)`);
  const flag = db.prepare(`SELECT value FROM app_settings WHERE key='item_master_recent_pending_v1'`).get();
  if (!flag) {
    const r = db.prepare(`
      UPDATE item_master
         SET approval_status = 'pending', approved_by = NULL, approved_at = NULL
       WHERE COALESCE(approval_status, 'approved') = 'approved'
         AND created_at >= datetime('now', 'localtime', '-2 days')
    `).run();
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('item_master_recent_pending_v1', '1')`).run();
    console.log(`[item_master] recent-pending backfill: ${r.changes} item(s) flagged for approval`);
  }
} catch (e) {
  console.warn('[item_master] recent-pending backfill skipped:', e.message);
}

// Builds the WHERE clause + params shared by the list endpoint and the
// COUNT(*) for the paginator. Keeping them in one place ensures the
// "Showing X-Y of Z" total always matches what the table shows.
function buildItemFilters(query) {
  const { department, type, search, status, approval } = query;
  const clauses = [];
  const params = [];
  if (department) { clauses.push('im.department=?'); params.push(department); }
  if (type) { clauses.push('im.type=?'); params.push(type); }
  // Approval filter (mam 2026-06-16): pending | approved | rejected.
  // Treat a missing/NULL status as 'approved' (grandfathered rows).
  if (approval === 'pending')  clauses.push(`im.approval_status = 'pending'`);
  if (approval === 'approved') clauses.push(`COALESCE(im.approval_status, 'approved') = 'approved'`);
  if (approval === 'rejected') clauses.push(`im.approval_status = 'rejected'`);
  if (search) {
    clauses.push('(im.item_name LIKE ? OR im.specification LIKE ? OR im.size LIKE ? OR im.item_code LIKE ? OR im.make LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q, q, q);
  }
  if (status === 'expired')    clauses.push(`(julianday('now','localtime') - julianday(${AGE_DATE_EXPR})) > 60`);
  if (status === 'ageing')     clauses.push(`(julianday('now','localtime') - julianday(${AGE_DATE_EXPR})) BETWEEN 31 AND 60`);
  if (status === 'fresh')      clauses.push(`(julianday('now','localtime') - julianday(${AGE_DATE_EXPR})) <= 30 AND ${AGE_DATE_EXPR} IS NOT NULL`);
  if (status === 'never')      clauses.push(`(${AGE_DATE_EXPR} IS NULL OR im.current_price = 0)`);
  if (status === 'make_blank') clauses.push(`(im.make IS NULL OR TRIM(im.make) = '')`);
  if (status === 'no_vendor')  clauses.push('im.vendor_id IS NULL');
  return { where: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', params };
}

// GET items, paginated. Response: { items, total, limit, offset }.
// Defaults to 100 per page so the client doesn't paint 2,385 rows at
// once (which is what was hanging the browser). Pass ?limit=99999 if
// you genuinely need everything (export, scripts).
router.get('/', requirePermission('item_master', 'view'), (req, res) => {
  const { where, params } = buildItemFilters(req.query);
  const limit  = Math.max(1, Math.min(99999, +req.query.limit  || 100));
  const offset = Math.max(0, +req.query.offset || 0);

  const sql = `
    SELECT im.*,
           v.name AS vendor_name,
           u.name AS priced_by_name,
           au.name AS approved_by_name,
           CASE WHEN ${AGE_DATE_EXPR} IS NULL THEN NULL
                ELSE CAST((julianday('now','localtime') - julianday(${AGE_DATE_EXPR})) AS INTEGER)
           END AS age_days
      FROM item_master im
      LEFT JOIN vendors v ON v.id = im.vendor_id
      LEFT JOIN users u ON u.id = im.priced_by
      LEFT JOIN users au ON au.id = im.approved_by
    ${where}
    ORDER BY im.item_code
    LIMIT ? OFFSET ?
  `;
  const countSql = `SELECT COUNT(*) AS n FROM item_master im ${where}`;

  const db = getDb();
  try {
    const rows  = db.prepare(sql).all(...params, limit, offset);
    const total = db.prepare(countSql).get(...params).n;
    res.json({
      items: rows.map(r => ({ ...r, age_status: ageStatus(r.age_days) })),
      total, limit, offset,
    });
  } catch (e) {
    // Never let a schema hiccup (e.g. a column an older server failed to add)
    // blank out the entire Item Master. Log it, then fall back to a query that
    // only touches base columns + the vendor name so the list still loads.
    console.error('[item_master] list query failed, using degraded fallback:', e.message);
    try {
      const fbSql = `
        SELECT im.*, v.name AS vendor_name,
               CASE WHEN ${AGE_DATE_EXPR} IS NULL THEN NULL
                    ELSE CAST((julianday('now','localtime') - julianday(${AGE_DATE_EXPR})) AS INTEGER)
               END AS age_days
          FROM item_master im
          LEFT JOIN vendors v ON v.id = im.vendor_id
        ${where}
        ORDER BY im.item_code
        LIMIT ? OFFSET ?`;
      const rows  = db.prepare(fbSql).all(...params, limit, offset);
      const total = db.prepare(countSql).get(...params).n;
      res.json({
        items: rows.map(r => ({ ...r, age_status: ageStatus(r.age_days) })),
        total, limit, offset,
      });
    } catch (e2) {
      console.error('[item_master] list fallback also failed:', e2.message);
      res.status(500).json({ error: 'Could not load items', detail: e2.message });
    }
  }
});

// Data-completion dashboard (mam 2026-06-15): across ALL items, how many of
// the required fields are filled — overall %, count of fully-complete items,
// and per-field missing counts. Each item has N required fields, so the
// denominator is items × N.
router.get('/completion', requirePermission('item_master', 'view'), (req, res) => {
  const db = getDb();
  const F = (expr) => `SUM(CASE WHEN ${expr} THEN 1 ELSE 0 END)`;
  const COND = {
    item_name: "TRIM(COALESCE(item_name,''))<>''",
    type: "TRIM(COALESCE(type,''))<>''",
    specification: "TRIM(COALESCE(specification,''))<>''",
    size: "TRIM(COALESCE(size,''))<>''",
    uom: "TRIM(COALESCE(uom,''))<>''",
    gst: "TRIM(COALESCE(gst,''))<>''",
    make: "TRIM(COALESCE(make,''))<>''",
    rate: "COALESCE(current_price,0)>0",
    vendor: "vendor_id IS NOT NULL",
    source_type: "TRIM(COALESCE(source_type,''))<>''",
    bill_po_number: "TRIM(COALESCE(bill_po_number,''))<>''",
    bill_po_date: "TRIM(COALESCE(bill_po_date,''))<>''",
  };
  const keys = Object.keys(COND);
  const selects = keys.map(k => `${F(COND[k])} AS ${k}`).join(', ');
  const allFilled = keys.map(k => `(${COND[k]})`).join(' AND ');
  const row = db.prepare(
    `SELECT COUNT(*) AS total, ${selects}, ${F(allFilled)} AS complete_items FROM item_master`
  ).get();
  const total = row.total || 0;
  const per_field = keys.map(k => ({ key: k, filled: row[k] || 0, missing: total - (row[k] || 0) }));
  const filled_total = per_field.reduce((s, x) => s + x.filled, 0);
  res.json({
    total_items: total,
    field_count: keys.length,
    required_total: total * keys.length,
    filled_total,
    complete_items: row.complete_items || 0,
    per_field,
  });
});

// Lightweight dropdown — unchanged shape so callers don't break.
router.get('/dropdown', (req, res) => {
  const { type } = req.query;
  // Dedupe make-variants (mam 2026-06-09): the same item in 2-3 makes shows
  // as identical rows. Group to ONE row per unique item_name + specification
  // + size — make is irrelevant in pickers. Representative id = lowest; price
  // = any non-zero (reference only).
  // Use a SINGLE aggregate (MIN id) so SQLite returns item_code, uom,
  // current_price etc. from the SAME row as that min id — with two
  // aggregates the bare columns came from indeterminate rows, so the shown
  // code/unit didn't match the item (mam 2026-06-10).
  // `type` may be a single value or a comma list (e.g. 'PO,POC').
  const types = type ? String(type).split(',').map(s => s.trim()).filter(Boolean) : [];
  const where = types.length ? `WHERE type IN (${types.map(() => '?').join(',')})` : '';
  // Age the material price so the Estimator can show "rate N days old" (mam #4
  // "PP rate age"). Same rate-date logic as the Item Master list (bill/PO date,
  // else priced_at, else updated_at when a price exists). Bare-column / single
  // MIN(id) aggregate so the date comes from the same representative row.
  const ageExpr = `COALESCE(bill_po_date, priced_at, CASE WHEN current_price > 0 THEN updated_at END)`;
  const sql = `SELECT MIN(id) AS id, item_code, department, item_name, specification, size, uom, gst, type, make, current_price,
                      COALESCE(approval_status, 'approved') AS approval_status,
                      CASE WHEN ${ageExpr} IS NULL THEN NULL
                           ELSE CAST((julianday('now','localtime') - julianday(${ageExpr})) AS INTEGER) END AS age_days
                 FROM item_master ${where}
                GROUP BY LOWER(TRIM(item_name)), LOWER(TRIM(COALESCE(specification, ''))), LOWER(TRIM(COALESCE(size, '')))
                ORDER BY department, item_name`;
  const stmt = getDb().prepare(sql);
  const items = types.length ? stmt.all(...types) : stmt.all();
  res.json(items.map(i => {
    const base = [i.item_name, i.specification, i.size].filter(Boolean).join(' / ');
    // Pending items stay selectable but are flagged so pickers can show
    // they're awaiting approval (mam 2026-06-16).
    const pending = i.approval_status === 'pending';
    return { ...i, display_name: pending ? `${base} (Pending approval)` : base, age_status: ageStatus(i.age_days) };
  }));
});

// Single item — same shape as list, including age.
router.get('/:id', requirePermission('item_master', 'view'), (req, res) => {
  const item = getDb().prepare(`
    SELECT im.*, v.name AS vendor_name, u.name AS priced_by_name,
           CASE WHEN ${AGE_DATE_EXPR} IS NULL THEN NULL
                ELSE CAST((julianday('now','localtime') - julianday(${AGE_DATE_EXPR})) AS INTEGER)
           END AS age_days
      FROM item_master im
      LEFT JOIN vendors v ON v.id = im.vendor_id
      LEFT JOIN users u ON u.id = im.priced_by
     WHERE im.id = ?
  `).get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json({ ...item, age_status: ageStatus(item.age_days) });
});

// Price history for a single item — every prior captured price plus the
// vendor / source / bill that justified it.
router.get('/:id/price-history', requirePermission('item_master', 'view'), (req, res) => {
  const rows = getDb().prepare(`
    SELECT iph.*, v.name AS vendor_name
      FROM item_price_history iph
      LEFT JOIN vendors v ON v.id = iph.vendor_id
     WHERE iph.item_id = ?
     ORDER BY iph.created_at DESC
  `).all(req.params.id);
  res.json(rows);
});

// Helper — when the price (or its provenance) changes, snapshot the
// OLD row into item_price_history before overwriting. Never deletes.
function snapshotCurrentPrice(db, oldRow, actor) {
  if (!oldRow) return;
  // Only snapshot if there's a meaningful current price worth keeping.
  if (!(oldRow.current_price > 0)) return;
  db.prepare(`
    INSERT INTO item_price_history
      (item_id, rate, quantity, source, source_type, vendor_id,
       bill_po_number, bill_po_date, created_by, created_by_name, created_at)
    VALUES (?, ?, 0, 'item_master_edit', ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
  `).run(
    oldRow.id,
    +oldRow.current_price || 0,
    oldRow.source_type || null,
    oldRow.vendor_id || null,
    oldRow.bill_po_number || null,
    oldRow.bill_po_date || null,
    oldRow.priced_by || actor?.id || null,
    actor?.name || null,
    oldRow.priced_at || oldRow.updated_at || null,
  );
}

// Update just the item identity (name / specification / make) — a SAFE partial
// update for the Inventory row edit (mam 2026-06-30: "edit item name also").
// Avoids the full PUT /:id, which would blank the other columns when not sent.
router.patch('/:id/identity', requirePermission('item_master', 'edit'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const cur = db.prepare('SELECT item_name, specification, make FROM item_master WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Item not found' });
  const item_name = (b.item_name != null && String(b.item_name).trim()) ? String(b.item_name).trim() : cur.item_name;
  const specification = (b.specification !== undefined) ? String(b.specification || '') : cur.specification;
  const make = (b.make !== undefined) ? String(b.make || '') : cur.make;
  db.prepare('UPDATE item_master SET item_name=?, specification=?, make=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(item_name, specification, make, req.params.id);
  res.json({ ok: true });
});

// Inline price patch (Inventory page uses this). Snapshots history.
router.patch('/:id/price', requirePermission('item_master', 'edit'), (req, res) => {
  const db = getDb();
  const old = db.prepare('SELECT * FROM item_master WHERE id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: 'Not found' });
  const price = +req.body?.current_price;
  if (!(price >= 0)) return res.status(400).json({ error: 'Price must be a positive number' });
  snapshotCurrentPrice(db, old, req.user);
  db.prepare(`
    UPDATE item_master
       SET current_price = ?,
           source_type = COALESCE(?, source_type, 'Manual'),
           priced_at = CURRENT_TIMESTAMP,
           priced_by = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(price, req.body?.source_type || null, req.user.id, req.params.id);
  res.json({ message: 'Price updated', current_price: price });
});

// ─── Item approval (mam 2026-06-16) ───────────────────────────────────
// Only an Admin (e.g. Ankur Kaplesh) can approve / reject a pending item.
// Approving stamps who & when; rejecting keeps the row (filterable) so it
// can be corrected or deleted, but it's flagged out of the trusted set.
const adminOnly = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an Admin can approve items' });
  next();
};

// Count of pending items — lets the page show a badge without fetching all.
router.get('/approval/pending-count', (req, res) => {
  const n = getDb().prepare(`SELECT COUNT(*) AS n FROM item_master WHERE approval_status='pending'`).get().n;
  res.json({ pending: n });
});

// Approve everything currently pending — convenience for clearing a backlog.
router.post('/approval/approve-all', adminOnly, (req, res) => {
  const r = getDb().prepare(`UPDATE item_master
       SET approval_status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
     WHERE approval_status='pending'`).run(req.user.id);
  res.json({ message: `Approved ${r.changes} item(s)`, approved: r.changes });
});

router.post('/:id/approve', adminOnly, (req, res) => {
  const db = getDb();
  const item = db.prepare('SELECT id FROM item_master WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE item_master
                 SET approval_status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
               WHERE id=?`).run(req.user.id, req.params.id);
  res.json({ message: 'Item approved', approval_status: 'approved' });
});

router.post('/:id/reject', adminOnly, (req, res) => {
  const db = getDb();
  const item = db.prepare('SELECT id FROM item_master WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE item_master
                 SET approval_status='rejected', approved_by=?, approved_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
               WHERE id=?`).run(req.user.id, req.params.id);
  res.json({ message: 'Item rejected', approval_status: 'rejected' });
});

router.post('/', requirePermission('item_master', 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.item_name) return res.status(400).json({ error: 'Item name required' });

  // Mam (2026-05-21): same item name + size + spec = same item.  This
  // matches the dedupe rule the master-sheet cleanup script used
  // (server/scripts/itemMasterCleanup.js).  Catches "MS PIPE 25mm
  // C-CLASS" being added twice with slight whitespace differences.
  const { findDuplicate, sendDuplicate } = require('../utils/duplicateGuard');
  const dup = findDuplicate(getDb(), {
    table: 'item_master',
    fields: {
      item_name: b.item_name,
      size: b.size || '',
      specification: b.specification || '',
    },
    codeColumn: 'item_code',
  });
  if (sendDuplicate(res, dup, `Item "${b.item_name}"${b.size ? ' · ' + b.size : ''}`)) return;

  let code = b.item_code;
  if (!code) {
    const { nextSequence } = require('../db/nextSequence');
    const dept = (b.department || 'GEN').toUpperCase().substring(0, 3);
    code = nextSequence(getDb(), 'item_master', 'item_code', dept, { startFrom: 0, pad: 4 });
  }
  const sourceType = ALLOWED_SOURCES.includes(b.source_type) ? b.source_type : 'Manual';
  const price = +b.current_price || 0;
  // Mam (2026-06-16): a new item entered from anywhere starts as PENDING
  // and must be approved by an Admin before it counts as "correct".
  // Admins who add an item approve it on the spot (no point making them
  // approve their own entry).
  const isAdmin = req.user.role === 'admin';
  const r = getDb().prepare(`
    INSERT INTO item_master
      (item_code, department, item_name, specification, size, uom, gst, type, make, model_number,
       current_price, catalogue_link, photo_link,
       vendor_id, source_type, bill_po_number, bill_po_date,
       weight_per_meter, weight_per_pipe, pipe_length_m,
       priced_at, priced_by,
       approval_status, approved_by, approved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    code, b.department, b.item_name, b.specification, b.size,
    b.uom || 'PCS', b.gst || '18%', b.type || 'PO', b.make, b.model_number,
    price, b.catalogue_link, b.photo_link,
    b.vendor_id || null, sourceType, b.bill_po_number || null, b.bill_po_date || null,
    (b.weight_per_meter === '' || b.weight_per_meter == null) ? null : (+b.weight_per_meter || null),
    (b.weight_per_pipe === '' || b.weight_per_pipe == null) ? null : (+b.weight_per_pipe || null),
    (b.pipe_length_m === '' || b.pipe_length_m == null) ? null : (+b.pipe_length_m || null),
    price > 0 ? new Date().toISOString() : null,
    price > 0 ? req.user.id : null,
    isAdmin ? 'approved' : 'pending',
    isAdmin ? req.user.id : null,
    isAdmin ? new Date().toISOString() : null,
  );
  res.status(201).json({ id: r.lastInsertRowid, item_code: code, approval_status: isAdmin ? 'approved' : 'pending' });
});

router.put('/:id', requirePermission('item_master', 'edit'), (req, res) => {
  const db = getDb();
  const old = db.prepare('SELECT * FROM item_master WHERE id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const newPrice = +b.current_price || 0;
  const newVendor = b.vendor_id || null;
  const newSource = ALLOWED_SOURCES.includes(b.source_type) ? b.source_type : (old.source_type || 'Manual');
  const newBillNo = b.bill_po_number || null;
  const newBillDate = b.bill_po_date || null;
  // Detect "price provenance changed" — any of: rate, vendor, source,
  // bill number, bill date. If yes, snapshot old + bump priced_at.
  const priceProvenanceChanged =
    (+old.current_price || 0) !== newPrice ||
    (old.vendor_id || null) !== newVendor ||
    (old.source_type || null) !== newSource ||
    (old.bill_po_number || null) !== newBillNo ||
    (old.bill_po_date || null) !== newBillDate;
  if (priceProvenanceChanged) snapshotCurrentPrice(db, old, req.user);
  db.prepare(`
    UPDATE item_master
       SET item_code = ?, department = ?, item_name = ?, specification = ?, size = ?,
           uom = ?, gst = ?, type = ?, make = ?, model_number = ?,
           current_price = ?, catalogue_link = ?, photo_link = ?,
           vendor_id = ?, source_type = ?, bill_po_number = ?, bill_po_date = ?,
           weight_per_meter = ?, weight_per_pipe = ?, pipe_length_m = ?,
           priced_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE priced_at END,
           priced_by = CASE WHEN ? THEN ? ELSE priced_by END,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(
    b.item_code, b.department, b.item_name, b.specification, b.size,
    b.uom, b.gst, b.type, b.make, b.model_number,
    newPrice, b.catalogue_link, b.photo_link,
    newVendor, newSource, newBillNo, newBillDate,
    (b.weight_per_meter === '' || b.weight_per_meter == null) ? null : (+b.weight_per_meter || null),
    (b.weight_per_pipe === '' || b.weight_per_pipe == null) ? null : (+b.weight_per_pipe || null),
    (b.pipe_length_m === '' || b.pipe_length_m == null) ? null : (+b.pipe_length_m || null),
    priceProvenanceChanged ? 1 : 0,
    priceProvenanceChanged ? 1 : 0, req.user.id,
    req.params.id,
  );
  res.json({ message: 'Updated', price_history_snapshot: priceProvenanceChanged });
});

router.delete('/:id', requirePermission('item_master', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM item_master WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Bulk import — extended CSV header so MD's CSV template can carry
// vendor + source + bill data. New columns are optional; old templates
// still work.
router.post('/bulk', requirePermission('item_master', 'create'), (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'No data' });
  const db = getDb();
  // Resolve vendor name → id at import time so the CSV can carry a name.
  const vendorByName = new Map(
    db.prepare('SELECT id, LOWER(TRIM(name)) AS k FROM vendors').all().map(r => [r.k, r.id])
  );
  const insert = db.prepare(`
    INSERT OR IGNORE INTO item_master
      (item_code, department, item_name, specification, size, uom, gst, type, make,
       current_price, vendor_id, source_type, bill_po_number, bill_po_date,
       priced_at, priced_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let added = 0;
  const errors = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.item_name || !String(it.item_name).trim()) { errors.push(`Row ${i + 1}: Item name required`); continue; }
    try {
      const vendorId = it.vendor_id != null
        ? +it.vendor_id || null
        : (it.vendor_name ? vendorByName.get(String(it.vendor_name).trim().toLowerCase()) || null : null);
      const source = ALLOWED_SOURCES.includes(it.source_type) ? it.source_type : (it.source_type ? null : 'Manual');
      const price = +it.current_price || 0;
      insert.run(
        it.item_code || '', it.department || '', String(it.item_name).trim(),
        it.specification || '', it.size || '', it.uom || 'PCS',
        it.gst || '18%', it.type || 'PO', it.make || '',
        price, vendorId, source, it.bill_po_number || null, it.bill_po_date || null,
        price > 0 ? new Date().toISOString() : null,
        price > 0 ? req.user.id : null,
      );
      added++;
    } catch (err) { errors.push(`Row ${i + 1}: ${err.message}`); }
  }
  res.json({ added, errors, total: items.length });
});

module.exports = router;
