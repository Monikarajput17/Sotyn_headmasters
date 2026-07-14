// Business-hour / business-day arithmetic — used by Rental Tools
// SLA calculations and (in future) any module that needs to compute
// targets in "working time" rather than wall-clock.
//
// Rules (mam, 2026-05-16: "not time after 5pm count next day, if
// sunday then on monday"):
//   - Working hours: 09:00 – 17:00 IST (8 hrs / day).
//   - Anything after 17:00 rolls to the next working day's 09:00.
//   - Anything before 09:00 rolls forward to today's 09:00.
//   - Sundays are not working days; targets land on Monday instead.
//   - Saturdays count as working (Indian construction industry norm —
//     mam runs Mon-Sat ops, not 5-day weeks).  Toggle later if needed.
//
// All inputs/outputs are JS Date objects.  No timezone offsetting —
// the host runs IST (or the offset is wrapped by the caller).

const WORK_START_HOUR = 9;
const WORK_END_HOUR   = 17;   // 5 PM cutoff per mam
const HOURS_PER_DAY   = WORK_END_HOUR - WORK_START_HOUR;
const SUNDAY = 0;

function isSunday(d) { return d.getDay() === SUNDAY; }

// Roll a Date forward to the next business moment.  If it's already
// inside business hours on a working day, returns as-is.
function clampToBusinessMoment(d) {
  const r = new Date(d);
  // Skip Sunday → Monday 9:00
  while (isSunday(r)) {
    r.setDate(r.getDate() + 1);
    r.setHours(WORK_START_HOUR, 0, 0, 0);
  }
  // Before 9 AM → 9 AM today
  if (r.getHours() < WORK_START_HOUR) {
    r.setHours(WORK_START_HOUR, 0, 0, 0);
  }
  // At or after 5 PM → 9 AM next working day
  if (r.getHours() >= WORK_END_HOUR) {
    r.setDate(r.getDate() + 1);
    r.setHours(WORK_START_HOUR, 0, 0, 0);
    while (isSunday(r)) {
      r.setDate(r.getDate() + 1);
    }
  }
  return r;
}

// Add N business hours to `start`.  Counts only time inside the
// 9-17 window on non-Sunday days.  Carries the leftover into the
// next working day's 9 AM.
function addBusinessHours(start, hours) {
  let cur = clampToBusinessMoment(start);
  let left = hours;
  while (left > 0) {
    const minsLeftToday = (WORK_END_HOUR - cur.getHours()) * 60 - cur.getMinutes();
    const minsToAdd = Math.min(left * 60, minsLeftToday);
    cur = new Date(cur.getTime() + minsToAdd * 60 * 1000);
    left -= minsToAdd / 60;
    if (left > 0) {
      // Roll to next working day at 9 AM
      cur.setDate(cur.getDate() + 1);
      cur.setHours(WORK_START_HOUR, 0, 0, 0);
      while (isSunday(cur)) cur.setDate(cur.getDate() + 1);
    }
  }
  return cur;
}

// Add N business days to a date (Sundays skipped).  Returns the
// SAME wall-clock time of day on day N — used when only the date
// matters (e.g. return target date).  If start is Sunday, treats
// Monday as day 0.
function addBusinessDays(start, days) {
  const r = new Date(start);
  while (isSunday(r)) r.setDate(r.getDate() + 1);   // start clamp
  let added = 0;
  while (added < days) {
    r.setDate(r.getDate() + 1);
    if (!isSunday(r)) added++;
  }
  return r;
}

// Convenience: business hours BETWEEN two Date objects.  Returns a
// float (e.g. 2.5 hrs).  Used to compute SLA elapsed time.
function businessHoursBetween(start, end) {
  if (end <= start) return 0;
  let cur = clampToBusinessMoment(start);
  let mins = 0;
  const stop = end;
  while (cur < stop) {
    const dayEnd = new Date(cur);
    dayEnd.setHours(WORK_END_HOUR, 0, 0, 0);
    const segmentEnd = stop < dayEnd ? stop : dayEnd;
    mins += Math.max(0, (segmentEnd - cur) / 60000);
    if (segmentEnd >= stop) break;
    cur.setDate(cur.getDate() + 1);
    cur.setHours(WORK_START_HOUR, 0, 0, 0);
    while (isSunday(cur)) cur.setDate(cur.getDate() + 1);
  }
  return mins / 60;
}

module.exports = {
  WORK_START_HOUR,
  WORK_END_HOUR,
  HOURS_PER_DAY,
  clampToBusinessMoment,
  addBusinessHours,
  addBusinessDays,
  businessHoursBetween,
  isSunday,
};
