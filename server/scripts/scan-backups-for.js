// Scan every nightly backup and report which ones still contain a given
// Business Book order (by name keyword) and HOW MUCH of its data survives —
// DPRs, DPR work-items, attendance, sites.  Use this when you DON'T know the
// date something was deleted: run it, then restore from the NEWEST backup
// that still shows the data (that's the closest-to-delete, most complete copy).
//
// Usage (on the VPS):
//   node server/scripts/scan-backups-for.js "HERO HOMES"
//
// Backups are read-only here — this NEVER writes anything.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const keyword = (process.argv[2] || 'HERO HOMES').toUpperCase();

// Same backup-dir rule as backup-db.js: ~/erp-backups on the VPS,
// ../../backups locally, overridable via ERP_BACKUP_DIR.
const BACKUP_DIR = process.env.ERP_BACKUP_DIR
  || (process.env.NODE_ENV !== 'production'
      ? path.join(__dirname, '..', '..', 'backups')
      : path.join('/root', 'erp-backups'));

if (!fs.existsSync(BACKUP_DIR)) {
  console.error(`Backup dir not found: ${BACKUP_DIR}`);
  process.exit(1);
}

const files = fs.readdirSync(BACKUP_DIR)
  .filter(f => f.endsWith('.db'))
  .map(f => path.join(BACKUP_DIR, f))
  .sort()              // names are erp-YYYY-MM-DD_HH-mm-ss.db → lexical = chronological
  .reverse();          // newest first

if (!files.length) {
  console.error(`No .db backups in ${BACKUP_DIR}`);
  process.exit(1);
}

console.log(`Scanning ${files.length} backup(s) in ${BACKUP_DIR} for "${keyword}"\n`);
console.log('NEWEST → OLDEST.  Restore from the FIRST line that shows DPRs > 0.\n');

let best = null;
for (const f of files) {
  let line;
  try {
    const db = new Database(f, { readonly: true });
    const bb = db.prepare(
      `SELECT id FROM business_book
        WHERE UPPER(COALESCE(company_name,'')||' '||COALESCE(project_name,'')||' '||COALESCE(client_name,'')) LIKE ?`
    ).all('%' + keyword + '%');
    if (!bb.length) {
      line = `  ${path.basename(f)}   ${keyword}: not present`;
    } else {
      const ids = bb.map(r => r.id).join(',');
      const sites = db.prepare(`SELECT id FROM sites WHERE business_book_id IN (${ids})`).all().map(r => r.id);
      const inSites = sites.length ? sites.join(',') : '-1';
      const dpr = db.prepare(`SELECT COUNT(*) c FROM dpr WHERE site_id IN (${inSites})`).get().c;
      const dprIds = db.prepare(`SELECT id FROM dpr WHERE site_id IN (${inSites})`).all().map(r => r.id);
      const inDpr = dprIds.length ? dprIds.join(',') : '-1';
      let wi = 0, att = 0;
      try { wi = db.prepare(`SELECT COUNT(*) c FROM dpr_work_items WHERE dpr_id IN (${inDpr})`).get().c; } catch (_) {}
      try { att = db.prepare(`SELECT COUNT(*) c FROM attendance WHERE site_id IN (${inSites})`).get().c; } catch (_) {}
      line = `  ${path.basename(f)}   ${keyword}: FOUND  · sites=${sites.length} · DPRs=${dpr} · work-items=${wi} · attendance=${att}`;
      if (!best && dpr > 0) best = f;   // newest backup that still has DPRs
    }
    db.close();
  } catch (e) {
    line = `  ${path.basename(f)}   (read error: ${e.message})`;
  }
  console.log(line);
}

console.log('');
if (best) {
  console.log('✅ RECOMMENDED — newest backup that still has the DPRs:');
  console.log(`   ${best}\n`);
  console.log('Restore with:');
  console.log('   pm2 stop erp');
  console.log(`   node server/scripts/restore-business-book.js "${best}" "${keyword}"`);
  console.log('   pm2 start erp');
} else {
  console.log(`⚠️  No backup contains "${keyword}" with any DPRs.`);
  console.log('   Either the keyword is different, or all backups are from AFTER the delete');
  console.log('   (older ones may have rotated out — only the last 30 are kept).');
}
