// One-time Item Master rate update — mam (2026-06-01): "according
// to this excel update rate in item wise in erp".  Mam handed over
// itemwise.xls with 140 (item_code, rate) updates; the file is
// committed to git as data/itemwise-rates-2026-06-01.json so the
// import is auditable and reproducible.
//
// Behaviour on boot (idempotent):
//   1. Check app_settings.itemwise_rates_2026_06_01_imported flag.
//   2. If unset: walk the JSON, UPDATE item_master.current_price by
//      item_code (exact match).  Fallback: try LOWER(TRIM(item_name))
//      when no item_code match — useful if codes differ in prod.
//   3. For every successful update, also INSERT a row into
//      item_price_history so the AI Agent's "last rate / 6-month
//      avg" suggestions still surface the new price.
//   4. Set the flag.  Subsequent boots skip this script entirely.
//   5. Logs a CSV-style summary line per row (hit / name-match /
//      miss) so mam can review what landed and what didn't.
//
// Skip via ERP_DISABLE_ITEM_RATE_IMPORT=1.

const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/schema');

const FLAG_KEY = 'itemwise_rates_2026_06_01_imported';
// data/ at repo root is gitignored (runtime snapshots).  Keep the
// import payload alongside the script under server/scripts/data/
// so it ships in git and lands on the VPS via `git pull`.
const JSON_PATH = path.join(__dirname, 'data', 'itemwise-rates-2026-06-01.json');

function runOnce() {
  if (process.env.ERP_DISABLE_ITEM_RATE_IMPORT === '1') return;
  const db = getDb();
  // Belt-and-braces flag table check.
  try { db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)`); } catch (_) {}
  const flag = db.prepare('SELECT value FROM app_settings WHERE key=?').get(FLAG_KEY);
  if (flag) return;  // already done

  if (!fs.existsSync(JSON_PATH)) {
    console.warn('[itemwise-rate-import] data file missing — skipping:', JSON_PATH);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));
  } catch (e) {
    console.error('[itemwise-rate-import] bad JSON — skipping:', e.message);
    return;
  }
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  if (rows.length === 0) {
    console.warn('[itemwise-rate-import] no rows in JSON — marking flag anyway to avoid retries');
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
  // item_price_history insert — schema (id, item_master_id, price,
  // source, recorded_by, recorded_at).  Catch any column mismatch
  // so legacy DBs that haven't migrated the table still let the
  // master update through.
  let insertHistory = null;
  try {
    insertHistory = db.prepare(
      `INSERT INTO item_price_history (item_master_id, price, source, recorded_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)`
    );
  } catch (_) { insertHistory = null; }

  const stats = { hits_by_code: 0, hits_by_name: 0, ambiguous_name: 0, no_match: 0, unchanged: 0, updated: 0 };
  const sampleMisses = [];

  // Wrap in a transaction — 140 rows is trivial but the bundle should
  // be atomic so a partial failure doesn't leave half the catalogue
  // re-priced.
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
        else if (nameRows.length > 1) { stats.ambiguous_name++; sampleMisses.push({ code, name, reason: 'ambiguous_name' }); continue; }
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
        try { insertHistory.run(hit.id, newRate, 'itemwise.xls import 2026-06-01'); }
        catch (e) { /* history insert is best-effort */ }
      }
    }
    // Stamp the flag inside the same transaction so a crash leaves
    // us re-runnable, but success guarantees we never repeat.
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
      .run(FLAG_KEY, new Date().toISOString());
  });

  try {
    tx();
    console.log(`[itemwise-rate-import] DONE · ${stats.updated} prices updated of ${rows.length} rows`);
    console.log(`[itemwise-rate-import]   by code: ${stats.hits_by_code} · by name: ${stats.hits_by_name} · unchanged: ${stats.unchanged} · ambiguous: ${stats.ambiguous_name} · no-match: ${stats.no_match}`);
    if (sampleMisses.length) {
      console.log('[itemwise-rate-import] sample misses (admin to reconcile):');
      sampleMisses.forEach(m => console.log(`  - [${m.reason}] ${m.code} :: ${m.name}`));
    }
  } catch (e) {
    console.error('[itemwise-rate-import] FAILED — flag NOT set, will retry next boot:', e.message);
  }
}

module.exports = { runOnce };
