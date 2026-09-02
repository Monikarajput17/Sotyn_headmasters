// Postgres (Supabase) adapter — the async replacement for better-sqlite3.
//
// Route code migrates from:   db.prepare(sql).get(a, b)      (sync)
// to:                         await pg.get(sql, a, b)        (async)
//
// Contract kept close to better-sqlite3 so diffs stay small:
//   pg.get(sql, ...params)  -> first row or undefined
//   pg.all(sql, ...params)  -> array of rows
//   pg.run(sql, ...params)  -> { changes, lastInsertRowid }
//   pg.query(sql, params[]) -> raw pg result
//   pg.tx(async t => { ... t.get/all/run/savepoint ... })  -> transaction
//
// Differences handled here so routes don't have to care:
//   - '?' placeholders are translated to $1..$n (string literals,
//     quoted identifiers and -- comments are skipped).
//   - int8/numeric come back as JS numbers, not strings (this app's ids
//     and amounts all fit; better-sqlite3 returned numbers too).
//   - lastInsertRowid: INSERTs without RETURNING get ' RETURNING id'
//     appended; tables without an id column fall back to a plain run.
//   - UNIQUE violations (23505) are re-worded to include the string
//     'UNIQUE' + the constraint name, so existing
//     `e.message.includes('UNIQUE')` checks keep working.
//   - Unlike SQLite, an error inside a Postgres transaction poisons it;
//     t.savepoint(fn) wraps fn so a failure rolls back just that step.
require('dotenv').config();
const { Pool, types } = require('pg');

// int8 (OID 20) and numeric (OID 1700) arrive as strings by default.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    });
    pool.on('error', (e) => console.error('[pg] idle client error:', e.message));
  }
  return pool;
}

// '?' -> $1..$n, skipping '…', "…" and -- comments.
function toPositional(sql) {
  let out = '';
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const q = ch;
      out += ch;
      i++;
      for (; i < sql.length; i++) {
        out += sql[i];
        if (sql[i] === q) {
          if (sql[i + 1] === q) { out += sql[i + 1]; i++; } // escaped '' or ""
          else break;
        }
      }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      for (; i < sql.length && sql[i] !== '\n'; i++) out += sql[i];
      if (i < sql.length) out += '\n';
      continue;
    }
    if (ch === '?') { out += '$' + (++n); continue; }
    out += ch;
  }
  // SQLite let `SET some_text_col = CURRENT_TIMESTAMP` slide; Postgres
  // refuses timestamptz→text assignment. All migrated datetime columns are
  // text, so rewrite the keyword to the same UTC text the schema defaults
  // produce ('YYYY-MM-DD HH:MM:SS', matching SQLite's format exactly).
  return out.replace(/\bCURRENT_TIMESTAMP\b/gi, "to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')");
}

function normalize(e) {
  if (e && e.code === '23505') {
    const what = [e.constraint, e.detail].filter(Boolean).join(' — ');
    e.message = `UNIQUE constraint failed: ${what || e.message}`;
  }
  return e;
}

let spCounter = 0;

// Builds the get/all/run/query surface bound to either the pool or a
// transaction client. inTx toggles savepoint protection.
function makeApi(runner, inTx) {
  const q = async (sql, params = []) => {
    try { return await runner.query(toPositional(sql), params); }
    catch (e) { throw normalize(e); }
  };
  const self = {
    query: q,
    all: async (sql, ...params) => (await q(sql, params)).rows,
    get: async (sql, ...params) => (await q(sql, params)).rows[0],
    run: async (sql, ...params) => {
      const wantsId = /^\s*insert\b/i.test(sql) && !/\breturning\b/i.test(sql);
      if (wantsId) {
        const attempt = async () => {
          const r = await q(sql + ' RETURNING id', params);
          return { changes: r.rowCount, lastInsertRowid: r.rows[0] ? r.rows[0].id : undefined };
        };
        try {
          return inTx ? await self.savepoint(attempt) : await attempt();
        } catch (e) {
          if (e.code !== '42703') throw e; // 42703 = no "id" column → plain run below
        }
      }
      const r = await q(sql, params);
      return { changes: r.rowCount, lastInsertRowid: undefined };
    },
    // Inside a transaction: run fn under a SAVEPOINT so its failure doesn't
    // poison the whole tx (SQLite behaved that way natively). Outside a
    // transaction it just runs fn.
    savepoint: async (fn) => {
      if (!inTx) return fn();
      const name = 'sp_' + (++spCounter);
      await runner.query(`SAVEPOINT ${name}`);
      try {
        const r = await fn();
        await runner.query(`RELEASE SAVEPOINT ${name}`);
        return r;
      } catch (e) {
        await runner.query(`ROLLBACK TO SAVEPOINT ${name}`);
        await runner.query(`RELEASE SAVEPOINT ${name}`).catch(() => {});
        throw e;
      }
    },
  };
  return self;
}

const rootApi = makeApi({ query: (text, params) => getPool().query(text, params) }, false);

async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(makeApi(client, true));
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  getPool,
  tx,
  query: rootApi.query,
  get: rootApi.get,
  all: rootApi.all,
  run: rootApi.run,
};
