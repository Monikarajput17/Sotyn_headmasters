// Port of server/db/nextSequence.js (nextSequencePg) — max numeric suffix + 1.
// Call inside the same transaction as the insert; the UNIQUE constraint on the
// column is the final guarantee against a race.
import type { Db } from "./pg.ts";

export async function nextSequencePg(t: Db, table: string, column: string, prefix: string,
  { startFrom = 0, pad = 0 }: { startFrom?: number; pad?: number } = {}) {
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rows = await t.all(`SELECT ${column} as v FROM ${table} WHERE ${column} IS NOT NULL AND ${column} LIKE ?`, prefix + "%");
  const re = new RegExp("^" + esc + "(\\d+)");
  let maxNum = startFrom;
  for (const r of rows) {
    const m = String(r.v || "").match(re);
    if (m) { const n = parseInt(m[1], 10); if (!isNaN(n) && n > maxNum) maxNum = n; }
  }
  const next = maxNum + 1;
  return pad > 0 ? `${prefix}${String(next).padStart(pad, "0")}` : `${prefix}${next}`;
}
