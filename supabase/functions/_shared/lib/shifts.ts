// deno-lint-ignore-file no-explicit-any
// Per-employee shift start/end + weekly off day, resolved DATE-EFFECTIVELY.
// employee_shifts is a history table (one row per change, never edited in
// place) — resolving "what applied on date X" means picking the row with
// the latest effective_from <= X. This is what lets an admin change
// someone's shift or week-off from today onward without retroactively
// reclassifying attendance that already happened under the old shift.
// Ported from server/lib/shifts.js — exported names unchanged; DB helpers are
// async with `(db, …)` first arg.
import type { Db } from "../pg.ts";

// All history rows for one employee, oldest first.
export async function getShiftHistory(db: Db, employeeId: any): Promise<any[]> {
  if (!employeeId) return [];
  return db.all(
    `SELECT * FROM employee_shifts WHERE employee_id=? ORDER BY effective_from ASC, id ASC`, employeeId,
  );
}

// Given history sorted ascending by effective_from, return the row that
// applied on dateStr ('YYYY-MM-DD'), or null if none existed yet that day.
export function resolveShift(historyAsc: any[], dateStr: string): any | null {
  let applicable: any = null;
  for (const row of historyAsc) {
    if (row.effective_from <= dateStr) applicable = row; else break;
  }
  return applicable;
}

// Single-lookup convenience for call sites that only need one date (e.g.
// punch-in "is this late right now"). Prefer getShiftHistory + resolveShift
// when resolving many dates for the same employee (payroll's day loop, the
// monthly grid) to avoid one query per day.
export async function resolveShiftForDate(db: Db, employeeId: any, dateStr: string): Promise<any | null> {
  if (!employeeId) return null;
  return (await db.get(
    `SELECT * FROM employee_shifts WHERE employee_id=? AND effective_from<=? ORDER BY effective_from DESC, id DESC LIMIT 1`,
    employeeId, dateStr,
  )) || null;
}

export function timeToMinutes(t: any): number | null {
  if (!t) return null;
  const [h, m] = String(t).split(":").map(Number);
  if (Number.isNaN(h)) return null;
  return h * 60 + (m || 0);
}

// Resolve the late-cutoff (minutes since midnight IST) for an employee on a
// given date. Falls back to the global cutoff when no shift is configured
// yet for that employee/date. (Generic so a `number` fallback yields `number`
// and a nullable fallback yields `number | null` — both call styles exist.)
export function lateCutoffMinutes<T extends number | null>(shiftRow: any, fallbackMin: T): number | T {
  const m = timeToMinutes(shiftRow?.shift_start);
  return m != null ? m : fallbackMin;
}

// Resolve the weekly-off day-of-week (0=Sun..6=Sat) for an employee on a
// given date. Falls back to Sunday when no shift/week-off is configured.
export function weekOffDow(shiftRow: any): number {
  return (shiftRow && shiftRow.week_off_day != null) ? shiftRow.week_off_day : 0;
}

// employee.id for a given user_id, or null. Small helper so callers don't
// each repeat the same lookup.
export async function employeeIdForUser(db: Db, userId: any): Promise<number | null> {
  if (!userId) return null;
  const row = await db.get("SELECT id FROM employees WHERE user_id=?", userId);
  return row ? row.id : null;
}
