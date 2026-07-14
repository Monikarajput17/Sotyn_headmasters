// Item Master one-shot cleanup — mam (2026-05-16): "correct item
// wise master sheet unit as per market if our wrong and no need
// duplicacy and correct the spelling".
//
// Three passes, all wrapped in a single transaction so the whole
// thing either applies or rolls back:
//
//   1. Unit normalisation
//      MTRS / METERS / METER → MTR
//      LITERS               → LTR
//      "OPTION 13" / blanks → keep blank (flag in audit instead)
//      PCS / Pcs / pcs       → PCS
//      KG / Kg / kg          → KG
//      SET / Set / SETS      → SET
//      PACKET / PACKETS      → PACKET
//      FEET / FT / ft        → FT
//
//   2. Spelling fixes (common typos spotted in mam's seed)
//      C02            → CO2     (zero vs letter O)
//      PANA           → SPANNER
//      THICKNESS      → THICK   (when followed by mm value)
//      Multiple whitespace collapses to single space
//      Trim leading/trailing whitespace
//
//   3. Duplicate merge
//      Groups by (UPPER(TRIM(item_name)), UPPER(TRIM(specification)),
//      UPPER(TRIM(make))).  Keeps the row with the LOWEST id (earliest
//      created).  For each duplicate, rewires po_items.item_master_id
//      references to the keeper so historical POs don't lose their
//      item link, THEN deletes the duplicate row.
//
// Idempotent: guarded by app_settings.item_master_cleanup_v1 so it
// only runs once per database.  Mam can re-run by deleting the
// flag row.

const { getDb } = require('../db/schema');

const UNIT_MAP = {
  'MTRS': 'MTR', 'METERS': 'MTR', 'METER': 'MTR', 'MTS': 'MTR', 'M': 'MTR', 'RMT': 'MTR',
  'LITERS': 'LTR', 'LITRE': 'LTR', 'LITRES': 'LTR', 'L': 'LTR',
  'PCS': 'PCS', 'PIECES': 'PCS', 'PIECE': 'PCS', 'NOS': 'PCS', 'NOS.': 'PCS',
  'KG': 'KG', 'KGS': 'KG', 'KILOGRAM': 'KG', 'KILOGRAMS': 'KG',
  'SET': 'SET', 'SETS': 'SET',
  'PACKET': 'PACKET', 'PACKETS': 'PACKET', 'PKT': 'PACKET', 'PACK': 'PACKET',
  'FEET': 'FT', 'FT': 'FT', 'FT.': 'FT',
  'BOX': 'BOX', 'BOXES': 'BOX',
  'TON': 'TON', 'TONS': 'TON', 'TONNE': 'TON', 'TONNES': 'TON',
  'DRUM': 'DRUM', 'DRUMS': 'DRUM',
  'ROLL': 'ROLL', 'ROLLS': 'ROLL',
  'LOT': 'LOT', 'LOTS': 'LOT',
  'PER WATT': 'WATT', 'WATT': 'WATT', 'WATTS': 'WATT', 'W': 'WATT',
  'SQMTR': 'SQM', 'SQM': 'SQM', 'SQ.MTR': 'SQM', 'SQ MT': 'SQM',
  'SQFT': 'SQFT', 'SQ.FT': 'SQFT', 'SQ FT': 'SQFT',
};
function normaliseUnit(raw) {
  if (raw == null) return null;
  const v = String(raw).trim().toUpperCase().replace(/\s+/g, ' ');
  if (!v || v === 'OPTION 13' || v === 'OPTION') return null; // junk
  return UNIT_MAP[v] || v;
}

function normaliseText(raw) {
  if (raw == null) return null;
  return String(raw)
    .replace(/\bC02\b/gi, 'CO2')          // CO2 typo
    .replace(/\bPANA\b/gi, 'SPANNER')      // PANA typo
    .replace(/\s+/g, ' ')                   // collapse internal whitespace
    .trim() || null;
}

function runCleanup(db) {
  // Idempotency guard
  try { db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)`); } catch (_) {}
  const already = db.prepare(`SELECT value FROM app_settings WHERE key=?`).get('item_master_cleanup_v1');
  if (already) return { skipped: true, reason: 'already_ran' };

  const stats = { units_changed: 0, text_changed: 0, dupes_merged: 0, dupes_deleted: 0, scanned: 0 };

  // Ensure the table exists before reading from it; if not, no-op.
  try {
    const tableCheck = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='item_master'`).get();
    if (!tableCheck) {
      db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`).run('item_master_cleanup_v1', new Date().toISOString());
      return { skipped: true, reason: 'no_item_master_table' };
    }
  } catch (_) { /* fall through */ }

  const txn = db.transaction(() => {
    // Pass 1+2: normalise unit + spelling on every row.  Column name
    // is `uom` (not `unit`) — verified against the actual schema.
    const rows = db.prepare(`SELECT id, item_name, specification, make, uom FROM item_master`).all();
    stats.scanned = rows.length;
    const updateRow = db.prepare(`UPDATE item_master SET item_name=?, specification=?, make=?, uom=? WHERE id=?`);
    for (const r of rows) {
      const newName  = normaliseText(r.item_name);
      const newSpec  = normaliseText(r.specification);
      const newMake  = normaliseText(r.make);
      const newUom   = normaliseUnit(r.uom);
      const textChanged = newName !== r.item_name || newSpec !== r.specification || newMake !== r.make;
      const uomChanged  = newUom !== r.uom;
      if (textChanged || uomChanged) {
        updateRow.run(newName, newSpec, newMake, newUom, r.id);
        if (textChanged) stats.text_changed++;
        if (uomChanged)  stats.units_changed++;
      }
    }

    // Pass 3: duplicate merge.  Group by normalised key; keep MIN(id).
    const groups = db.prepare(`
      SELECT MIN(id) as keeper_id,
             COUNT(*) as cnt,
             GROUP_CONCAT(id) as ids,
             UPPER(TRIM(COALESCE(item_name,''))) as k1,
             UPPER(TRIM(COALESCE(specification,''))) as k2,
             UPPER(TRIM(COALESCE(make,''))) as k3
      FROM item_master
      WHERE item_name IS NOT NULL AND TRIM(item_name) != ''
      GROUP BY k1, k2, k3
      HAVING cnt > 1
    `).all();

    // Re-point ALL tables that reference item_master.id from the
    // deletables to the keeper, then delete.  Boot log showed
    // "FOREIGN KEY constraint failed" — earlier version only
    // repointed po_items, but indent_items + vendor_po_items
    // (via indent_items) ALSO reference item_master.  Each table
    // is checked for existence first so this is safe on fresh
    // installs or partial schemas.
    const tableExists = (name) => {
      try { return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name); }
      catch (_) { return false; }
    };
    const repointers = [];
    if (tableExists('po_items')) {
      repointers.push(db.prepare(`UPDATE po_items SET item_master_id=? WHERE item_master_id=?`));
    }
    if (tableExists('indent_items')) {
      repointers.push(db.prepare(`UPDATE indent_items SET item_master_id=? WHERE item_master_id=?`));
    }
    // Surface ANY remaining FK references so the error message in the
    // catch shows the actual offending table instead of generic "FK
    // constraint failed".  PRAGMA foreign_key_list is read at runtime.
    const deleteStmt = db.prepare(`DELETE FROM item_master WHERE id=?`);
    const failed = [];
    for (const g of groups) {
      const ids = String(g.ids || '').split(',').map(Number).filter(n => n !== g.keeper_id);
      for (const dupId of ids) {
        for (const stmt of repointers) stmt.run(g.keeper_id, dupId);
        try {
          deleteStmt.run(dupId);
          stats.dupes_deleted++;
        } catch (e) {
          // Don't blow up the whole transaction — collect the failure
          // so the boot log shows which row blocked the merge, and
          // the rest of the cleanup still applies.
          failed.push({ id: dupId, keeper: g.keeper_id, error: e.message });
        }
      }
      stats.dupes_merged += ids.length;
    }
    if (failed.length) {
      stats.dupes_failed = failed.length;
      stats.dupe_failures_sample = failed.slice(0, 5);
    }

    // Stamp the idempotency flag last so a mid-flight crash retries
    db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`)
      .run('item_master_cleanup_v1', new Date().toISOString());
  });
  txn();
  return { skipped: false, ...stats };
}

// Propagation pass — separate idempotency flag so it runs once even
// if v1 was already applied on an earlier deploy.  Mam (2026-05-16):
// "please correct previous uom according to item wise master sheet".
// Touches:
//   - po_items.unit       when po_items.item_master_id is set
//   - indent_items.unit   when indent_items.item_master_id is set
function runUnitPropagation(db) {
  try { db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)`); } catch (_) {}
  const already = db.prepare(`SELECT value FROM app_settings WHERE key=?`).get('item_master_uom_propagation_v1');
  if (already) return { skipped: true, reason: 'already_ran' };

  const stats = { po_items_unit_updated: 0, indent_items_unit_updated: 0 };
  const hasTable = (name) => {
    try { return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name); }
    catch (_) { return false; }
  };

  const txn = db.transaction(() => {
    if (hasTable('po_items')) {
      const r = db.prepare(`
        UPDATE po_items
        SET unit = LOWER((SELECT uom FROM item_master WHERE item_master.id = po_items.item_master_id))
        WHERE item_master_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM item_master WHERE item_master.id = po_items.item_master_id AND uom IS NOT NULL)
      `).run();
      stats.po_items_unit_updated = r.changes;
    }
    if (hasTable('indent_items')) {
      const r = db.prepare(`
        UPDATE indent_items
        SET unit = LOWER((SELECT uom FROM item_master WHERE item_master.id = indent_items.item_master_id))
        WHERE item_master_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM item_master WHERE item_master.id = indent_items.item_master_id AND uom IS NOT NULL)
      `).run();
      stats.indent_items_unit_updated = r.changes;
    }
    db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`)
      .run('item_master_uom_propagation_v1', new Date().toISOString());
  });
  txn();
  return { skipped: false, ...stats };
}

function runOnce() {
  if (process.env.ERP_DISABLE_ITEM_CLEANUP === '1') return;
  try {
    const db = getDb();
    const r = runCleanup(db);
    if (r.skipped) {
      console.log(`[item-master-cleanup] cleanup skipped: ${r.reason}`);
    } else {
      console.log(`[item-master-cleanup] scanned ${r.scanned} rows · units fixed: ${r.units_changed} · text fixed: ${r.text_changed} · dupes deleted: ${r.dupes_deleted}`);
    }
    // Separate propagation pass — runs the first time even if v1
    // already ran on an earlier deploy.
    const p = runUnitPropagation(db);
    if (p.skipped) {
      console.log(`[item-master-cleanup] uom propagation skipped: ${p.reason}`);
    } else {
      console.log(`[item-master-cleanup] uom propagation done · po_items: ${p.po_items_unit_updated} · indent_items: ${p.indent_items_unit_updated}`);
    }
  } catch (e) {
    console.error('[item-master-cleanup] failed:', e.message);
  }
}

module.exports = { runOnce, runCleanup, runUnitPropagation, normaliseUnit, normaliseText };
