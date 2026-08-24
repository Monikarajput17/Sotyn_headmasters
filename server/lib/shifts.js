// Per-employee shift start/end + weekly off day, resolved DATE-EFFECTIVELY.
// employee_shifts is a history table (one row per change, never edited in
// place) — resolving "what applied on date X" means picking the row with
// the latest effective_from <= X. This is what lets an admin change
// someone's shift or week-off from today onward without retroactively
// reclassifying attendance that already happened under the old shift.

// All history rows for one employee, oldest first.
function getShiftHistory(db, employeeId) {
  if (!employeeId) return [];
  return db.prepare(
    `SELECT * FROM employee_shifts WHERE employee_id=? ORDER BY effective_from ASC, id ASC`
  ).all(employeeId);
}

// Given history sorted ascending by effective_from, return the row that
// applied on dateStr ('YYYY-MM-DD'), or null if none existed yet that day.
function resolveShift(historyAsc, dateStr) {
  let applicable = null;
  for (const row of historyAsc) {
    if (row.effective_from <= dateStr) applicable = row; else break;
  }
  return applicable;
}

// Single-lookup convenience for call sites that only need one date (e.g.
// punch-in "is this late right now"). Prefer getShiftHistory + resolveShift
// when resolving many dates for the same employee (payroll's day loop, the
// monthly grid) to avoid one query per day.
function resolveShiftForDate(db, employeeId, dateStr) {
  if (!employeeId) return null;
  return db.prepare(
    `SELECT * FROM employee_shifts WHERE employee_id=? AND effective_from<=? ORDER BY effective_from DESC, id DESC LIMIT 1`
  ).get(employeeId, dateStr) || null;
}

function timeToMinutes(t) {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  if (Number.isNaN(h)) return null;
  return h * 60 + (m || 0);
}

// Resolve the late-cutoff (minutes since midnight IST) for an employee on a
// given date. Falls back to the global cutoff when no shift is configured
// yet for that employee/date.
function lateCutoffMinutes(shiftRow, fallbackMin) {
  const m = timeToMinutes(shiftRow?.shift_start);
  return m != null ? m : fallbackMin;
}

// Resolve the weekly-off day-of-week (0=Sun..6=Sat) for an employee on a
// given date. Falls back to Sunday when no shift/week-off is configured.
function weekOffDow(shiftRow) {
  return (shiftRow && shiftRow.week_off_day != null) ? shiftRow.week_off_day : 0;
}

// employee.id for a given user_id, or null. Small helper so callers don't
// each repeat the same lookup.
function employeeIdForUser(db, userId) {
  if (!userId) return null;
  const row = db.prepare('SELECT id FROM employees WHERE user_id=?').get(userId);
  return row ? row.id : null;
}

module.exports = {
  getShiftHistory, resolveShift, resolveShiftForDate,
  timeToMinutes, lateCutoffMinutes, weekOffDow, employeeIdForUser,
};
