// Centralised date/time formatting for the whole Sotyn.Headmasters.
//
// Every timestamp in the DB is stored in UTC — either as a SQLite
// CURRENT_TIMESTAMP string ("2026-06-17 07:12:21" — a space, no zone
// marker) or via new Date().toISOString() ("2026-06-17T07:12:21.000Z").
// Rendering those with a plain `new Date(x).toLocaleString()` shows the
// raw UTC clock (5½ h behind IST) — e.g. an indent raised at 12:42 pm
// showed 07:12 am. Attendance looked right only because it manually added
// 5.5 h. These helpers do that conversion in ONE place and pin the output
// to Asia/Kolkata, so times match the office wall clock for every user,
// regardless of the viewer's own browser timezone.

const IST = 'Asia/Kolkata';

const DEFAULT_DATETIME = { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };
const DEFAULT_DATE     = { day: '2-digit', month: 'short', year: 'numeric' };
const DEFAULT_TIME     = { hour: '2-digit', minute: '2-digit' };

// Turn any stored value into a real Date instant, treating bare (zone-less)
// timestamps as UTC. Returns null for empty / unparseable input.
export function parseUTC(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  let s = String(v).trim();
  // "YYYY-MM-DD HH:MM:SS" (SQLite, no zone) → mark it as UTC.
  // A value that already has a 'T' is an ISO string from toISOString()
  // (always carries 'Z'), so leave it untouched. A bare "YYYY-MM-DD"
  // date is left as-is (JS reads date-only as UTC midnight).
  if (!s.includes('T') && s.includes(' ')) s = s.replace(' ', 'T') + 'Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// "17 Jun 2026, 12:42 pm" — date + time on the India clock.
export function fmtDateTime(v, opts) {
  const d = parseUTC(v);
  return d ? d.toLocaleString('en-IN', { timeZone: IST, ...(opts || DEFAULT_DATETIME) }) : '';
}

// "17 Jun 2026" — date only, India clock.
export function fmtDate(v, opts) {
  const d = parseUTC(v);
  return d ? d.toLocaleDateString('en-IN', { timeZone: IST, ...(opts || DEFAULT_DATE) }) : '';
}

// "12:42 pm" — time only, India clock.
export function fmtTime(v, opts) {
  const d = parseUTC(v);
  return d ? d.toLocaleTimeString('en-IN', { timeZone: IST, ...(opts || DEFAULT_TIME) }) : '';
}
