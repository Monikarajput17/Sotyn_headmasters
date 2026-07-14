// Item Master rate import — v3 (mam 2026-06-01): "according to item
// name and code update rate in erp in item master".  101 daybook-
// matched rates from final item.xlsx — every row has Old Rate=0 and
// a new positive rate from a real PO/bill.
//
// v1 (140 rows, itemwise.xls)            → flag: ..._imported
// v2 (2496 rows, item-master CSV)        → flag: ..._v2_imported
// v3 (this, 101 rows, final item.xlsx)   → flag: ..._v3_imported
// All three coexist; whichever flag is unset fires its import.
// After a redeploy with all three running, every flag is set and
// subsequent boots skip the imports entirely.
//
// Behaviour mirrors v1/v2: code-match first, name-match fallback,
// updates item_master.current_price + writes item_price_history,
// wrapped in a transaction so partial failure leaves the flag
// unset for safe retry.  Skip via ERP_DISABLE_ITEM_RATE_IMPORT=1.

const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/schema');

const FLAG_KEY = 'itemwise_rates_2026_06_01_v3_imported';
const JSON_PATH = path.join(__dirname, 'data', 'itemwise-rates-2026-06-01-v3.json');

function runOnce() {
  if (process.env.ERP_DISABLE_ITEM_RATE_IMPORT === '1') return;
  const db = getDb();
  try { db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)`); } catch (_) {}
  const flag = db.prepare('SELECT value FROM app_settings WHERE key=?').get(FLAG_KEY);
  if (flag) return;

  if (!fs.existsSync(JSON_PATH)) {
    console.warn('[itemwise-rate-import-v3] data file missing — skipping:', JSON_PATH);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));
  } catch (e) {
    console.error('[itemwise-rate-import-v3] bad JSON — skipping:', e.message);
    return;
  }
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  if (rows.length === 0) {
    console.warn('[itemwise-rate-import-v3] no rows — flagging anyway');
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
      .run(FLAG_KEY, new Date().toISOString());
    return;
  }

  const findByCode = db.prepare('SELECT id, item_code, current_price FROM item_master WHERE item_code = ?');
  const findByCodeCi = db.prepare(
    `SELECT id, item_code, current_price FROM item_master
       WHERE LOWER(TRIM(item_code)) = LOWER(TRIM(?))
       LIMIT 2`
  );
  const findByName = db.prepare(
    `SELECT id, item_code, current_price FROM item_master
       WHERE LOWER(TRIM(item_name)) = LOWER(TRIM(?))
       LIMIT 2`
  );
  const updateRate = db.prepare(
    `UPDATE item_master
        SET current_price = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  );
  let insertHistory = null;
  try {
    insertHistory = db.prepare(
      `INSERT INTO item_price_history (item_master_id, price, source, recorded_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)`
    );
  } catch (_) { insertHistory = null; }

  const stats = { hits_by_code: 0, hits_by_code_ci: 0, hits_by_name: 0, ambiguous: 0, no_match: 0, unchanged: 0, updated: 0 };
  const sampleMisses = [];

  const tx = db.transaction(() => {
    for (const r of rows) {
      const code = String(r.item_code || '').trim();
      const name = String(r.item_name || '').trim();
      const newRate = Number(r.rate);
      if (!code || !Number.isFinite(newRate) || newRate <= 0) continue;

      // 1) Exact code (case-sensitive, indexed via UNIQUE constraint)
      let hit = findByCode.get(code);
      let kind = 'code';
      // 2) Case-insensitive code — Excel sometimes mixes case
      //    ("Ele0739" vs "ELE0739").  Fall back to a LOWER() compare
      //    only when the exact match misses.
      if (!hit) {
        const ci = findByCodeCi.all(code);
        if (ci.length === 1) { hit = ci[0]; kind = 'code_ci'; }
        else if (ci.length > 1) { stats.ambiguous++; if (sampleMisses.length<10) sampleMisses.push({code, name, reason:'ambiguous_code_ci'}); continue; }
      }
      // 3) Name match
      if (!hit && name) {
        const ni = findByName.all(name);
        if (ni.length === 1) { hit = ni[0]; kind = 'name'; }
        else if (ni.length > 1) { stats.ambiguous++; if (sampleMisses.length<10) sampleMisses.push({code, name, reason:'ambiguous_name'}); continue; }
      }
      if (!hit) {
        stats.no_match++;
        if (sampleMisses.length < 10) sampleMisses.push({ code, name, reason: 'no_match' });
        continue;
      }

      if (Number(hit.current_price) === newRate) {
        stats.unchanged++;
        stats[`hits_by_${kind}`]++;
        continue;
      }
      updateRate.run(newRate, hit.id);
      stats[`hits_by_${kind}`]++;
      stats.updated++;
      if (insertHistory) {
        try { insertHistory.run(hit.id, newRate, 'final item.xlsx import 2026-06-01 v3'); } catch (_) {}
      }
    }
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
      .run(FLAG_KEY, new Date().toISOString());
  });

  try {
    tx();
    console.log(`[itemwise-rate-import-v3] DONE · ${stats.updated} prices updated of ${rows.length} input rows`);
    console.log(`[itemwise-rate-import-v3]   by code: ${stats.hits_by_code} · code-ci: ${stats.hits_by_code_ci} · by name: ${stats.hits_by_name} · unchanged: ${stats.unchanged} · ambiguous: ${stats.ambiguous} · no-match: ${stats.no_match}`);
    if (sampleMisses.length) {
      console.log('[itemwise-rate-import-v3] sample misses (admin to reconcile):');
      sampleMisses.forEach(m => console.log(`  - [${m.reason}] ${m.code} :: ${m.name}`));
    }
  } catch (e) {
    console.error('[itemwise-rate-import-v3] FAILED — flag NOT set, will retry next boot:', e.message);
  }
}

module.exports = { runOnce };
