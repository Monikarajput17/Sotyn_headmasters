// Surgical restore of ONE deleted Business Book order (and everything the
// cascade-delete removed: sites, DPRs + DPR work-items/manpower/machinery,
// attendance, po_items, order_planning, project_finance, purchase_orders,
// receivables, geofence_settings) from a backup DB — WITHOUT overwriting any
// current data.  Use when a Business Book row was deleted by mistake.
//
// Usage (run on the VPS, app STOPPED so nothing writes mid-restore):
//   pm2 stop erp
//   node server/scripts/restore-business-book.js <backup.db path> "HERO HOMES"
//   pm2 start erp
//
// It:
//   1. makes a safety copy of the CURRENT live DB (rollback point),
//   2. finds the matching business_book id(s) in the backup by name keyword,
//   3. INSERT-OR-IGNOREs that order + all its child rows back (original ids,
//      so the DPRs re-link) — never deletes/overwrites anything.
// Column-safe: copies only columns present in BOTH the backup and live schema.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const backupPath = process.argv[2];
const keyword = (process.argv[3] || 'HERO HOMES').toUpperCase();
const LIVE = process.env.ERP_RESTORE_LIVE || path.join(__dirname, '..', '..', 'data', 'erp.db');

if (!backupPath || !fs.existsSync(backupPath)) {
  console.error('Backup DB not found. Usage: node restore-business-book.js <backup.db> "<NAME KEYWORD>"');
  process.exit(1);
}

// Tables to restore, in FK-dependency order, with the SELECT scope that ties
// each child back to the matched business_book id(s).
function restore() {
  // 1) safety copy of the current live DB
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safety = LIVE + `.before-restore-${stamp}`;
  fs.copyFileSync(LIVE, safety);
  console.log('Safety copy of live DB →', safety);

  const db = new Database(LIVE);
  db.pragma('foreign_keys = OFF');
  db.exec(`ATTACH '${backupPath.replace(/'/g, "''")}' AS bak`);

  const bbIds = db.prepare(
    `SELECT id FROM bak.business_book
      WHERE UPPER(COALESCE(company_name,'')||' '||COALESCE(project_name,'')||' '||COALESCE(client_name,'')) LIKE ?`
  ).all('%' + keyword + '%').map(r => r.id);

  if (!bbIds.length) {
    console.error(`No business_book in the backup matches "${keyword}". Nothing to restore.`);
    db.close();
    return;
  }
  const inList = bbIds.join(',');
  console.log(`Matched business_book id(s) in backup: ${inList}`);

  // column intersection (backup ∩ live) so a schema that grew since the backup
  // still inserts cleanly.
  const cols = (table) => {
    const live = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    return db.prepare(`PRAGMA bak.table_info(${table})`).all()
      .map(c => c.name).filter(n => live.has(n));
  };
  const copy = (table, whereScope) => {
    let c;
    try { c = cols(table); } catch (e) { console.log(`  ${table}: skip (${e.message})`); return; }
    if (!c.length) { console.log(`  ${table}: skip (no columns)`); return; }
    const colList = c.map(n => `"${n}"`).join(', ');
    try {
      const r = db.prepare(
        `INSERT OR IGNORE INTO ${table} (${colList}) SELECT ${colList} FROM bak.${table} WHERE ${whereScope}`
      ).run();
      console.log(`  ${table}: +${r.changes}`);
    } catch (e) { console.log(`  ${table}: skip (${e.message})`); }
  };

  const siteScope = `business_book_id IN (${inList})`;
  const siteSub = `SELECT id FROM bak.sites WHERE business_book_id IN (${inList})`;
  const dprSub = `SELECT id FROM bak.dpr WHERE site_id IN (${siteSub})`;
  const poSub = `SELECT id FROM bak.purchase_orders WHERE business_book_id IN (${inList})`;

  const tx = db.transaction(() => {
    copy('business_book', `id IN (${inList})`);
    copy('sites', siteScope);
    copy('po_items', siteScope);
    copy('order_planning', siteScope);
    copy('project_finance', siteScope);
    copy('purchase_orders', siteScope);
    copy('receivables', `po_id IN (${poSub})`);
    copy('dpr', `site_id IN (${siteSub})`);
    copy('dpr_work_items', `dpr_id IN (${dprSub})`);
    copy('dpr_manpower', `dpr_id IN (${dprSub})`);
    copy('dpr_machinery', `dpr_id IN (${dprSub})`);
    copy('dpr_material', `dpr_id IN (${dprSub})`);       // material lines
    copy('dpr_contractors', `dpr_id IN (${dprSub})`);    // subcontractor lines
    copy('attendance', `site_id IN (${siteSub})`);
    copy('geofence_settings', `site_id IN (${siteSub})`);
  });
  tx();

  db.pragma('foreign_keys = ON');
  db.close();
  console.log('Restore complete. Restart the app: pm2 start erp');
}

restore();
