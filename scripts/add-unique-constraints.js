// Phase 1 follow-up: carry over UNIQUE constraints the schema migrator missed.
//
// SQLite implements inline `UNIQUE` column constraints as auto-indexes
// (sqlite_autoindex_*) whose sqlite_master.sql is NULL — the migrator only
// copied explicit indexes, so e.g. users.email / roles.name lost their
// uniqueness in Postgres. This reads PRAGMA index_list (origin 'u') and
// creates the equivalent UNIQUE indexes. Data already satisfies them
// (SQLite enforced them at the source).
//
// Usage: node scripts/add-unique-constraints.js
require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');
const { Client } = require('pg');

const sq = new Database(path.join(__dirname, '..', 'data', 'erp.db'), { readonly: true });
const q = (n) => '"' + String(n).toLowerCase().replace(/"/g, '""') + '"';

const tables = sq
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);

const stmts = [];
for (const table of tables) {
  let list = [];
  try { list = sq.prepare(`PRAGMA index_list(${JSON.stringify(table)})`).all(); } catch (_) { continue; }
  for (const idx of list.filter((i) => i.origin === 'u' && i.unique)) {
    const cols = sq.prepare(`PRAGMA index_info(${JSON.stringify(idx.name)})`).all();
    if (!cols.length || cols.some((c) => c.name == null)) continue;
    const colNames = cols.map((c) => c.name);
    const idxName = `uq_${table}_${colNames.join('_')}`.toLowerCase().slice(0, 63);
    stmts.push(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${q(idxName)} ON ${q(table)} (${colNames.map(q).join(', ')})`
    );
  }
}

(async () => {
  console.log(`${stmts.length} UNIQUE constraints to restore`);
  const pgc = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pgc.connect();
  let ok = 0, fail = 0;
  for (const s of stmts) {
    try { await pgc.query(s); ok++; }
    catch (e) { fail++; console.error(`  FAILED: ${s}\n    ${e.message}`); }
  }
  console.log(`restored: ${ok}, failed: ${fail}`);
  await pgc.end();
  sq.close();
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
