// Postgres adapter for Edge Functions — SAME contract as server/db/pg.js so
// the Phase-3 route modules port verbatim:
//   pg.get(sql, ...params) / pg.all / pg.run -> { changes, lastInsertRowid }
//   pg.tx(async (t) => { t.get/all/run, t.savepoint(fn) })
// '?' placeholders → $n; int8/numeric → JS numbers; bare CURRENT_TIMESTAMP →
// UTC text (all migrated datetime columns are TEXT); 23505 → message that
// includes 'UNIQUE constraint failed' so existing checks keep working.
//
// Connection: the Supavisor TRANSACTION pooler (port 6543) — required for
// serverless; prepared statements are disabled accordingly.
import postgres from "postgres";
import { isLocalDevelopment } from "./environment.ts";

const url = Deno.env.get("DB_POOL_URL") ?? Deno.env.get("SUPABASE_DB_URL") ?? "";
if (!url) console.error("[pg] DB_POOL_URL / SUPABASE_DB_URL not set");

// Concurrency gate. postgres.js on Deno loses queued queries when more
// simple-protocol (parameter-less) queries are in flight than there are
// connections (verified 2026-09-02: 14 parallel `select … limit 3` with
// max=4 → only 4–10 ever resolve; forcing the extended protocol is 14/14).
// So we never let it queue: at most POOL_MAX queries/transactions run at
// once and the rest wait here, in our own FIFO, until a slot frees.
// Keep this SMALL: Supabase runs many short-lived isolates of this function,
// each with its own pool, and the pooler caps the project at 200 client
// connections (Free tier) — verified 2026-09-02: 6/isolate + 20 s idle hold
// → "EMAXCONN max client connections reached" under bursts. 2 per isolate,
// released after 3 s idle, keeps a page load fast while staying far under cap.
const POOL_MAX = 2;
let slots = POOL_MAX;
const waiters: Array<() => void> = [];
async function acquire(): Promise<() => void> {
  if (slots > 0) { slots--; }
  else await new Promise<void>((resolve) => waiters.push(resolve)).then(() => { slots--; });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    slots++;
    const next = waiters.shift();
    if (next) next();
  };
}

const sql = postgres(url, {
  prepare: false,           // transaction pooler
  max: POOL_MAX,
  idle_timeout: 3,          // give connections back to the pooler quickly
  max_lifetime: 300,
  connect_timeout: 10,
  ssl: isLocalDevelopment ? false : "require",
  types: {
    int8: { to: 20, from: [20], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
    numeric: { to: 1700, from: [1700], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
  },
});

export function toPositional(input: string): string {
  let out = "";
  let n = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'" || ch === '"') {
      const q = ch;
      out += ch;
      i++;
      for (; i < input.length; i++) {
        out += input[i];
        if (input[i] === q) {
          if (input[i + 1] === q) { out += input[i + 1]; i++; } else break;
        }
      }
      continue;
    }
    if (ch === "-" && input[i + 1] === "-") {
      for (; i < input.length && input[i] !== "\n"; i++) out += input[i];
      if (i < input.length) out += "\n";
      continue;
    }
    if (ch === "?") { out += "$" + (++n); continue; }
    out += ch;
  }
  return out.replace(/\bCURRENT_TIMESTAMP\b/gi, "to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')");
}

// deno-lint-ignore no-explicit-any
function normalize(e: any) {
  if (e && e.code === "23505") {
    const what = [e.constraint_name, e.detail].filter(Boolean).join(" — ");
    e.message = `UNIQUE constraint failed: ${what || e.message}`;
  }
  return e;
}

// Rows are intentionally `any`: the ported route modules were written in
// loosely-typed JS and access columns freely.
// deno-lint-ignore no-explicit-any
type Row = any;
export interface RunResult { changes: number; lastInsertRowid?: number }
export interface Db {
  // deno-lint-ignore no-explicit-any
  get(sqlText: string, ...params: any[]): Promise<Row | undefined>;
  // deno-lint-ignore no-explicit-any
  all(sqlText: string, ...params: any[]): Promise<Row[]>;
  // deno-lint-ignore no-explicit-any
  run(sqlText: string, ...params: any[]): Promise<RunResult>;
  savepoint<T>(fn: () => Promise<T>): Promise<T>;
  tx<T>(fn: (t: Db) => Promise<T>): Promise<T>;
}

let spCounter = 0;

// deno-lint-ignore no-explicit-any
function makeApi(runner: any, inTx: boolean): Db {
  // deno-lint-ignore no-explicit-any
  const q = async (text: string, params: any[] = []) => {
    // Inside a transaction the runner is a dedicated connection — no gate.
    const release = inTx ? null : await acquire();
    try {
      return await runner.unsafe(toPositional(text), params.map((p) => (p === undefined ? null : p)));
    } catch (e) { throw normalize(e); }
    finally { if (release) release(); }
  };
  const self: Db = {
    all: async (text, ...params) => Array.from(await q(text, params)),
    get: async (text, ...params) => (await q(text, params))[0],
    run: async (text, ...params) => {
      const wantsId = /^\s*insert\b/i.test(text) && !/\breturning\b/i.test(text);
      if (wantsId) {
        const attempt = async () => {
          const r = await q(text + " RETURNING id", params);
          return { changes: r.count ?? r.length, lastInsertRowid: r[0] ? r[0].id : undefined };
        };
        try {
          return inTx ? await self.savepoint(attempt) : await attempt();
        } catch (e) {
          // deno-lint-ignore no-explicit-any
          if ((e as any).code !== "42703") throw e; // no "id" column → plain run below
        }
      }
      const r = await q(text, params);
      return { changes: r.count ?? 0, lastInsertRowid: undefined };
    },
    savepoint: async (fn) => {
      if (!inTx) return fn();
      const name = "sp_" + (++spCounter);
      await runner.unsafe(`SAVEPOINT ${name}`);
      try {
        const r = await fn();
        await runner.unsafe(`RELEASE SAVEPOINT ${name}`);
        return r;
      } catch (e) {
        await runner.unsafe(`ROLLBACK TO SAVEPOINT ${name}`);
        await runner.unsafe(`RELEASE SAVEPOINT ${name}`).catch(() => {});
        throw e;
      }
    },
    tx: async (fn) => {
      if (inTx) return fn(self); // nested → same tx
      const release = await acquire();   // a tx holds one connection for its whole life
      try {
        // deno-lint-ignore no-explicit-any
        return await sql.begin(async (t: any) => fn(makeApi(t, true))) as Awaited<ReturnType<typeof fn>>;
      } finally { release(); }
    },
  };
  return self;
}

const pg: Db = makeApi(sql, false);
export default pg;
export { sql as rawSql };
