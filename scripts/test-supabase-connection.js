// One-off connectivity check for the Supabase Postgres instance.
// Tries the direct connection first, then the session pooler.
require('dotenv').config();
const { Client } = require('pg');

const candidates = [
  ['direct', process.env.DATABASE_URL],
  ['pooler', process.env.DATABASE_URL_POOLER],
].filter(([, url]) => url);

(async () => {
  for (const [label, url] of candidates) {
    const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    try {
      await client.connect();
      const { rows } = await client.query(
        "select version() as v, current_database() as db, (select count(*) from information_schema.tables where table_schema='public') as tables"
      );
      console.log(`[${label}] CONNECTED`);
      console.log(`[${label}] ${rows[0].v.split(',')[0]} | db=${rows[0].db} | public tables=${rows[0].tables}`);
      await client.end();
      process.exit(0);
    } catch (err) {
      console.error(`[${label}] FAILED: ${err.message}`);
      try { await client.end(); } catch {}
    }
  }
  process.exit(1);
})();
