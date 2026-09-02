// Phase 2 of the Supabase migration: copy all rows SQLite -> Postgres.
//
// Re-runnable: TRUNCATEs every table first, so it can be run again right
// before cutover to pick up fresh data. FK ordering is sidestepped with
// session_replication_role=replica (FK triggers off for this session only).
// Afterwards every identity sequence is bumped past MAX(id) and per-table
// row counts are verified SQLite vs Postgres.
//
// Usage: node scripts/copy-data-to-supabase.js
require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');
const { Client } = require('pg');

const SQLITE_PATH = path.join(__dirname, '..', 'data', 'erp.db');
const sq = new Database(SQLITE_PATH, { readonly: true });

const tables = sq
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);

const q = (n) => '"' + String(n).toLowerCase().replace(/"/g, '""') + '"';

(async () => {
  const pgc = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pgc.connect();
  const failures = [];
  try {
    await pgc.query('SET session_replication_role = replica');

    console.log(`Truncating ${tables.length} tables…`);
    await pgc.query(`TRUNCATE ${tables.map(q).join(', ')} RESTART IDENTITY`);

    let grandTotal = 0;
    for (const table of tables) {
      const cols = sq.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((c) => c.name);
      const total = sq.prepare(`SELECT COUNT(*) n FROM ${JSON.stringify(table)}`).get().n;
      if (!total) continue;

      const colList = cols.map(q).join(', ');
      const batchSize = Math.max(1, Math.floor(20000 / cols.length));
      let batch = [];
      let inserted = 0;

      const flush = async () => {
        if (!batch.length) return;
        const values = [];
        const params = [];
        let p = 1;
        for (const row of batch) {
          values.push('(' + cols.map(() => '$' + p++).join(',') + ')');
          for (const c of cols) params.push(row[c] === undefined ? null : row[c]);
        }
        try {
          await pgc.query(`INSERT INTO ${q(table)} (${colList}) VALUES ${values.join(',')}`, params);
          inserted += batch.length;
        } catch (e) {
          // fall back row-by-row so one bad row doesn't sink the batch
          for (const row of batch) {
            try {
              await pgc.query(
                `INSERT INTO ${q(table)} (${colList}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})`,
                cols.map((c) => (row[c] === undefined ? null : row[c]))
              );
              inserted++;
            } catch (e2) {
              failures.push({ table, error: e2.message, row: JSON.stringify(row).slice(0, 200) });
            }
          }
        }
        batch = [];
      };

      for (const row of sq.prepare(`SELECT * FROM ${JSON.stringify(table)}`).iterate()) {
        batch.push(row);
        if (batch.length >= batchSize) await flush();
      }
      await flush();
      grandTotal += inserted;
      console.log(`  ${table}: ${inserted}/${total}`);
    }
    console.log(`Copied ~${grandTotal} rows total.`);

    // Bump identity sequences past MAX(id)
    console.log('Fixing identity sequences…');
    const { rows: idCols } = await pgc.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='public' AND is_identity='YES'`);
    for (const { table_name, column_name } of idCols) {
      await pgc.query(
        `SELECT setval(pg_get_serial_sequence($1,$2), COALESCE((SELECT MAX(${q(column_name)}) FROM ${q(table_name)}), 0) + 1, false)`,
        [`public.${table_name}`, column_name]
      );
    }
    console.log(`  ${idCols.length} sequences aligned.`);

    // Verify counts
    console.log('Verifying row counts…');
    let mismatches = 0;
    for (const table of tables) {
      const a = sq.prepare(`SELECT COUNT(*) n FROM ${JSON.stringify(table)}`).get().n;
      const b = (await pgc.query(`SELECT COUNT(*)::int n FROM ${q(table)}`)).rows[0].n;
      if (a !== b) {
        mismatches++;
        console.error(`  MISMATCH ${table}: sqlite=${a} pg=${b}`);
      }
    }
    console.log(mismatches ? `${mismatches} table(s) mismatched.` : 'All table counts MATCH ✔');
    if (failures.length) {
      console.error(`\n${failures.length} row(s) failed to insert:`);
      for (const f of failures.slice(0, 20)) console.error(`  [${f.table}] ${f.error}\n    ${f.row}`);
    }
  } finally {
    await pgc.end();
    sq.close();
  }
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
