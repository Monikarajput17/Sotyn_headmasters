// One-shot importer for the Stock Sheet.xlsx opening-balance dump.
//
// Reads server/db/stock_sheet_import.json (588 rows: location/item/qty/unit/rate)
// and seeds inventory:
//
//   1. Resolve each Location to a warehouse (existing site-store match,
//      or auto-create a new site + site_store warehouse).
//   2. Resolve each Item to item_master (case-insensitive name match;
//      auto-create with department='GEN' if missing).
//   3. Apply IN movements with reference_type='OPENING' and a stable
//      reference_id 'OPENING-XLSX-<row>' so re-runs skip already-imported rows.
//
// Usage:
//   node server/scripts/import-stock-sheet.js            # dry-run (no writes)
//   node server/scripts/import-stock-sheet.js --apply    # actually write

const path = require('path');
const fs = require('fs');
const { getDb, initializeDatabase } = require('../db/schema');

const APPLY = process.argv.includes('--apply');
initializeDatabase();
const db = getDb();

const dataPath = path.join(__dirname, '..', 'db', 'stock_sheet_import.json');
const rows = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

const norm = s => (s || '').toString().trim().replace(/\s+/g, ' ').toUpperCase();

// ---------- Resolve / create WAREHOUSES ----------
function getOrCreateWarehouse(locationName, ledger) {
  const loc = locationName.trim();
  // Try exact warehouse name (handles 'Office Store')
  let wh = db.prepare('SELECT id, name, type FROM warehouses WHERE LOWER(name) = LOWER(?)').get(loc);
  if (wh) return { id: wh.id, status: 'matched-warehouse', name: wh.name };
  // Try '<loc> Store'
  wh = db.prepare('SELECT id, name FROM warehouses WHERE LOWER(name) = LOWER(?)').get(loc + ' Store');
  if (wh) return { id: wh.id, status: 'matched-warehouse-store', name: wh.name };
  // Try matching against sites + grabbing the matching site_store warehouse
  const site = db.prepare('SELECT id, name FROM sites WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1').get(loc);
  if (site) {
    wh = db.prepare("SELECT id, name FROM warehouses WHERE site_id=? AND type='site_store' LIMIT 1").get(site.id);
    if (wh) return { id: wh.id, status: 'matched-via-site', name: wh.name };
    // Site exists but no warehouse — create one
    if (!APPLY) return { id: null, status: 'WOULD-CREATE-WH-FOR-SITE', name: `${site.name} Store` };
    const r = db.prepare("INSERT INTO warehouses (name, type, site_id, location) VALUES (?, 'site_store', ?, ?)")
      .run(`${site.name} Store`, site.id, site.name);
    ledger.warehousesCreated += 1;
    return { id: r.lastInsertRowid, status: 'created-warehouse-only', name: `${site.name} Store` };
  }
  // No site, no warehouse — create both
  if (!APPLY) return { id: null, status: 'WOULD-CREATE-SITE+WH', name: `${loc} Store` };
  const sr = db.prepare('INSERT INTO sites (name) VALUES (?)').run(loc);
  const wr = db.prepare("INSERT INTO warehouses (name, type, site_id, location) VALUES (?, 'site_store', ?, ?)")
    .run(`${loc} Store`, sr.lastInsertRowid, loc);
  ledger.sitesCreated += 1;
  ledger.warehousesCreated += 1;
  return { id: wr.lastInsertRowid, status: 'created-site+wh', name: `${loc} Store` };
}

// ---------- Parse item name into (name, spec, size, make) when "/"-separated ----------
function parseItemName(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  const parts = s.split('/').map(p => p.trim());
  if (parts.length >= 4) {
    return {
      item_name: parts[0] || s,
      specification: parts[1] || '',
      size: parts[2] || '',
      make: parts[3] || '',
    };
  }
  return { item_name: s, specification: '', size: '', make: '' };
}

// ---------- Resolve / create ITEM MASTER ----------
function getOrCreateItem(itemRaw, uom, rate, ledger) {
  const parsed = parseItemName(itemRaw);
  if (!parsed) return null;

  // Strategy 1 — match on full structured key (name+spec+size+make) when we have all 4
  if (parsed.specification && parsed.size && parsed.make) {
    const m = db.prepare(`
      SELECT id, item_code, item_name FROM item_master
       WHERE LOWER(TRIM(item_name)) = LOWER(TRIM(?))
         AND LOWER(TRIM(COALESCE(specification,''))) = LOWER(TRIM(?))
         AND LOWER(TRIM(COALESCE(size,''))) = LOWER(TRIM(?))
         AND LOWER(TRIM(COALESCE(make,''))) = LOWER(TRIM(?))
       LIMIT 1
    `).get(parsed.item_name, parsed.specification, parsed.size, parsed.make);
    if (m) return { id: m.id, status: 'matched-strict', name: m.item_name, code: m.item_code };
  }
  // Strategy 2 — match on raw full string against item_name
  let m = db.prepare('SELECT id, item_code, item_name FROM item_master WHERE LOWER(TRIM(item_name)) = LOWER(TRIM(?)) LIMIT 1').get(itemRaw);
  if (m) return { id: m.id, status: 'matched-raw-name', name: m.item_name, code: m.item_code };
  // Strategy 3 — name only
  m = db.prepare('SELECT id, item_code, item_name FROM item_master WHERE LOWER(TRIM(item_name)) = LOWER(TRIM(?)) LIMIT 1').get(parsed.item_name);
  if (m) return { id: m.id, status: 'matched-name-only', name: m.item_name, code: m.item_code };

  // Auto-create
  const u = (uom || 'PCS').toString().toUpperCase().trim();
  if (!APPLY) return { id: null, status: 'WOULD-CREATE-ITEM', name: parsed.item_name };
  const { nextSequence } = require('../db/nextSequence');
  const code = nextSequence(db, 'item_master', 'item_code', 'GEN', { startFrom: 0, pad: 4 });
  const r = db.prepare(`INSERT INTO item_master
    (item_code, department, item_name, specification, size, uom, gst, type, make, current_price)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(code, 'GEN', parsed.item_name, parsed.specification, parsed.size, u, '18%', 'PO', parsed.make, rate || 0);
  ledger.itemsCreated += 1;
  return { id: r.lastInsertRowid, status: 'created-item', name: parsed.item_name, code };
}

// ---------- Apply IN movement (skip if reference_id already exists) ----------
function applyOpeningRow(warehouseId, itemId, qty, rate, refId, ledger) {
  const exists = db.prepare("SELECT id FROM stock_movements WHERE reference_type='OPENING' AND reference_id=? LIMIT 1").get(refId);
  if (exists) { ledger.skippedDup += 1; return 'skipped-already-imported'; }
  if (!APPLY) return 'would-insert';

  const cur = db.prepare('SELECT * FROM stock_balance WHERE warehouse_id=? AND item_master_id=?').get(warehouseId, itemId);
  const prevQty = cur ? +cur.quantity : 0;
  const prevRate = cur ? +cur.avg_rate : 0;
  const newQty = prevQty + qty;
  const inRate = +rate || 0;
  const newAvgRate = newQty > 0 ? ((prevQty * prevRate) + (qty * inRate)) / newQty : 0;

  if (cur) {
    db.prepare('UPDATE stock_balance SET quantity=?, avg_rate=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(newQty, newAvgRate, cur.id);
  } else {
    db.prepare('INSERT INTO stock_balance (warehouse_id, item_master_id, quantity, avg_rate) VALUES (?,?,?,?)')
      .run(warehouseId, itemId, newQty, newAvgRate);
  }
  db.prepare(`INSERT INTO stock_movements
    (warehouse_id, item_master_id, type, quantity, rate, total_value, reference_type, reference_id, notes)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(warehouseId, itemId, 'IN', qty, inRate, qty * inRate, 'OPENING', refId, 'Excel: Stock Sheet import');
  ledger.movementsInserted += 1;
  return 'inserted';
}

// ---------- Run ----------
const ledger = {
  total: rows.length,
  warehousesCreated: 0, sitesCreated: 0,
  itemsCreated: 0,
  movementsInserted: 0, skippedDup: 0, errors: [],
};
const breakdown = { whStatus: {}, itemStatus: {}, byLoc: {} };

const tx = db.transaction(() => {
  for (const r of rows) {
    try {
      const wh = getOrCreateWarehouse(r.location, ledger);
      breakdown.whStatus[wh.status] = (breakdown.whStatus[wh.status] || 0) + 1;
      const it = getOrCreateItem(r.item, r.unit, r.rate || 0, ledger);
      breakdown.itemStatus[it.status] = (breakdown.itemStatus[it.status] || 0) + 1;
      breakdown.byLoc[r.location] = (breakdown.byLoc[r.location] || 0) + 1;
      const refId = `OPENING-XLSX-R${r.row}`;
      if (APPLY) applyOpeningRow(wh.id, it.id, r.qty, r.rate || 0, refId, ledger);
    } catch (e) {
      ledger.errors.push({ row: r.row, item: r.item, err: e.message });
    }
  }
});

if (APPLY) tx(); else {
  // dry-run: still iterate but don't actually write
  for (const r of rows) {
    try {
      const wh = getOrCreateWarehouse(r.location, ledger);
      breakdown.whStatus[wh.status] = (breakdown.whStatus[wh.status] || 0) + 1;
      const it = getOrCreateItem(r.item, r.unit, r.rate || 0, ledger);
      breakdown.itemStatus[it.status] = (breakdown.itemStatus[it.status] || 0) + 1;
      breakdown.byLoc[r.location] = (breakdown.byLoc[r.location] || 0) + 1;
    } catch (e) {
      ledger.errors.push({ row: r.row, item: r.item, err: e.message });
    }
  }
}

console.log('\n========================================');
console.log(`  Stock Sheet Import — ${APPLY ? 'APPLIED' : 'DRY-RUN'}`);
console.log('========================================');
console.log(`Total Excel rows : ${ledger.total}`);
console.log(`\nWarehouse resolution:`);
for (const [k, v] of Object.entries(breakdown.whStatus)) console.log(`  ${v.toString().padStart(4)}  ${k}`);
console.log(`\nItem resolution:`);
for (const [k, v] of Object.entries(breakdown.itemStatus)) console.log(`  ${v.toString().padStart(4)}  ${k}`);
console.log(`\nBy location (rows):`);
for (const [k, v] of Object.entries(breakdown.byLoc).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${v.toString().padStart(4)}  ${k}`);
}
if (APPLY) {
  console.log(`\nWrites:`);
  console.log(`  Sites created           : ${ledger.sitesCreated}`);
  console.log(`  Warehouses created      : ${ledger.warehousesCreated}`);
  console.log(`  Items created in master : ${ledger.itemsCreated}`);
  console.log(`  Movements inserted      : ${ledger.movementsInserted}`);
  console.log(`  Already-imported skips  : ${ledger.skippedDup}`);
}
if (ledger.errors.length) {
  console.log(`\nErrors (${ledger.errors.length}):`);
  ledger.errors.slice(0, 20).forEach(e => console.log(`  row ${e.row}: ${e.err} — ${e.item}`));
}
console.log('========================================\n');
