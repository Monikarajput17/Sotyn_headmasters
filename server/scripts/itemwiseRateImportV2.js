// Item Master rate import — v2 (mam 2026-06-01): "update rate in
// erp" — second pass with the much larger item-master export.
//
// v1 (server/scripts/itemwiseRateImport.js) applied 140 rows from
// itemwise.xls.  This v2 applies 2,496 rows from the broader CSV
// export and uses a SEPARATE app_settings flag so:
//   - v1 won't re-run (its flag is set after first deploy).
//   - v2 runs exactly once after THIS deploy.
//   - Both can coexist in the boot sequence without stepping on
//     each other's data.
//
// Apart from the JSON path + flag key + log prefix, behaviour is
// identical to v1: code-match first → name-match fallback → write
// to item_master + item_price_history, wrapped in a transaction
// so partial failure leaves the flag unset for safe retry.

const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/schema');

const FLAG_KEY = 'itemwise_rates_2026_06_01_v2_imported';
const JSON_PATH = path.join(__dirname, 'data', 'itemwise-rates-2026-06-01-v2.json');

function runOnce() {
  if (process.env.ERP_DISABLE_ITEM_RATE_IMPORT === '1') return;
  const db = getDb();
  try { db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)`); } catch (_) {}
  const flag = db.prepare('SELECT value FROM app_settings WHERE key=?').get(FLAG_KEY);
  if (flag) return;

  if (!fs.existsSync(JSON_PATH)) {
    console.warn('[itemwise-rate-import-v2] data file missing — skipping:', JSON_PATH);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));
  } catch (e) {
    console.error('[itemwise-rate-import-v2] bad JSON — skipping:', e.message);
    return;
  }
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  if (rows.length === 0) {
    console.warn('[itemwise-rate-import-v2] no rows — flagging anyway');
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
      .run(FLAG_KEY, new Date().toISOString());
    return;
  }

  const findByCode = db.prepare('SELECT id, item_code, current_price FROM item_master WHERE item_code = ?');
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

  const stats = { hits_by_code: 0, hits_by_name: 0, ambiguous_name: 0, no_match: 0, unchanged: 0, updated: 0 };
  const sampleMisses = [];

  const tx = db.transaction(() => {
    for (const r of rows) {
      const code = String(r.item_code || '').trim();
      const name = String(r.item_name || '').trim();
      const newRate = Number(r.rate);
      if (!code || !Number.isFinite(newRate) || newRate <= 0) continue;

      let hit = code ? findByCode.get(code) : null;
      let matchKind = 'code';
      if (!hit && name) {
        const nameRows = findByName.all(name);
        if (nameRows.length === 1) { hit = nameRows[0]; matchKind = 'name'; }
        else if (nameRows.length > 1) { stats.ambiguous_name++; if (sampleMisses.length < 10) sampleMisses.push({ code, name, reason: 'ambiguous_name' }); continue; }
      }
      if (!hit) {
        stats.no_match++;
        if (sampleMisses.length < 10) sampleMisses.push({ code, name, reason: 'no_match' });
        continue;
      }

      if (Number(hit.current_price) === newRate) {
        stats.unchanged++;
        if (matchKind === 'code') stats.hits_by_code++; else stats.hits_by_name++;
        continue;
      }
      updateRate.run(newRate, hit.id);
      if (matchKind === 'code') stats.hits_by_code++; else stats.hits_by_name++;
      stats.updated++;
      if (insertHistory) {
        try { insertHistory.run(hit.id, newRate, 'item-master CSV import 2026-06-01 v2'); }
        catch (_) { /* best-effort */ }
      }
    }
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
      .run(FLAG_KEY, new Date().toISOString());
  });

  try {
    tx();
    console.log(`[itemwise-rate-import-v2] DONE · ${stats.updated} prices updated of ${rows.length} input rows`);
    console.log(`[itemwise-rate-import-v2]   by code: ${stats.hits_by_code} · by name: ${stats.hits_by_name} · unchanged: ${stats.unchanged} · ambiguous: ${stats.ambiguous_name} · no-match: ${stats.no_match}`);
    if (sampleMisses.length) {
      console.log('[itemwise-rate-import-v2] sample misses (admin to reconcile):');
      sampleMisses.forEach(m => console.log(`  - [${m.reason}] ${m.code} :: ${m.name}`));
    }
  } catch (e) {
    console.error('[itemwise-rate-import-v2] FAILED — flag NOT set, will retry next boot:', e.message);
  }
}

module.exports = { runOnce };
