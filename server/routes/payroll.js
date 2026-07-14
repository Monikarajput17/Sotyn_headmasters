// Payroll auto-calculator. Reads rules from the payroll_settings table and
// computes per-employee monthly salary by walking each day of the month
// and applying:
//   - Sunday handling (paid / unpaid per setting)
//   - Approved leaves (CL / SL / PL paid up to allowance, LWP unpaid)
//   - Short leave (skips half-day deduction if setting enabled)
//   - Attendance (no punch = absent; punch 09:46–10:00 = late mark on a
//     full day; punch after 10:00 = half day; under 4h worked = half day;
//     4h+ = full day; overtime hours)
//   - N lates → 1 absent (configurable)
// Everything is recalculated live unless a run is "finalised" — then we
// return the snapshot from payroll_runs so historical slips don't drift.

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission, adminOnly } = require('../middleware/auth');

router.use(authMiddleware);

// ---------- helpers ----------

function ensureSettingsRow(db) {
  const row = db.prepare('SELECT id FROM payroll_settings WHERE id=1').get();
  if (!row) {
    db.prepare(`INSERT INTO payroll_settings (id) VALUES (1)`).run();
  }
}

function getSettings(db) {
  ensureSettingsRow(db);
  return db.prepare('SELECT * FROM payroll_settings WHERE id=1').get();
}

function daysInMonth(month) {
  // month = "YYYY-MM"
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function isSunday(year, month, day) {
  return new Date(year, month - 1, day).getDay() === 0;
}

function pad(n) { return String(n).padStart(2, '0'); }

// Parse "HH:MM" / "HH:MM:SS" / ISO datetime → minutes since midnight
function timeToMinutes(t) {
  if (!t) return null;
  // ISO datetime? punch_in_time is stored as UTC; the production VPS also
  // runs in UTC, so d.getHours() would return UTC hours — a 10:15 IST punch
  // (04:45Z) read as 04:45 and NEVER crosses the 09:46/10:00 late cutoffs,
  // so nobody was ever marked late. Convert to IST (+5:30) explicitly and
  // read UTC parts so the result is correct regardless of server timezone
  // (matches the attendance month-view logic).
  if (t.includes('T') || t.includes(' ')) {
    const d = new Date(t);
    if (isNaN(d)) return null;
    const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
    return ist.getUTCHours() * 60 + ist.getUTCMinutes();
  }
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

// ---------- routes ----------

// GET current settings
router.get('/settings', (req, res) => {
  try {
    res.json(getSettings(getDb()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update settings (admin only)
router.put('/settings', adminOnly, (req, res) => {
  const db = getDb();
  ensureSettingsRow(db);
  const fields = [
    'late_after_time','half_day_after_time','min_hours_full_day','min_hours_half_day',
    'skip_half_day_if_short_leave','lates_to_absent','late_grace_count','late_per_minute_rate',
    'working_days_per_month','sundays_paid',
    'cl_per_month','sl_per_month','pl_per_month','short_leave_per_month',
    'ot_threshold_hours','ot_rate_multiplier','pay_cycle_start_day',
    'basic_pct','conveyance_pct','hra_pct','adhoc_pct','misc_pct'
  ];
  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      sets.push(`${f} = ?`);
      vals.push(req.body[f]);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
  sets.push('updated_at = CURRENT_TIMESTAMP', 'updated_by = ?');
  vals.push(req.user.id);
  db.prepare(`UPDATE payroll_settings SET ${sets.join(', ')} WHERE id = 1`).run(...vals);
  res.json({ message: 'Settings updated', settings: getSettings(db) });
});

// Core calculator — runs for one employee for one month, returns full breakdown.
function calculateForEmployee(db, settings, employee, month) {
  const [year, mm] = month.split('-').map(Number);
  const totalDays = daysInMonth(month);

  // Advance salary taken this month (deducted from net pay) + a food
  // allowance (ADDED to net pay) — both entered by admin on the payroll
  // screen and stored on the same monthly row (mam 2026-06-12).
  const adjRow = db.prepare('SELECT amount, food, paid_days_override, cl_override, late_penalty_override FROM payroll_advances WHERE month=? AND employee_id=?')
    .get(month, employee.id) || {};
  const advance = round2(adjRow.amount || 0);
  const food = round2(adjRow.food || 0);

  // ─── Salary-exempt short-circuit (mam 2026-06-01) ────────────────
  // "this person every month make salary full" — Parul Goyal, Rajat
  // Sir, Nitin Jain, Ankur Kaplesh, Pooja Kaplesh, D.S Kaplesh, Soma
  // Kaplesh.  When employees.salary_exempt=1, we bypass every
  // attendance / late / leave deduction and return the full base
  // salary as net pay.  Earnings split still respects the BASIC /
  // CONVEYANCE / HRA / Adhoc / Misc percentages from settings so the
  // slip stays compliant.  Future months still return 0 — no advance
  // payout — admin-marked exempt rows still respect time.
  if (employee.salary_exempt) {
    const istNow = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
    const tY = istNow.getUTCFullYear(), tM = istNow.getUTCMonth() + 1;
    const isFuture = year > tY || (year === tY && mm > tM);
    const baseSalary = employee.salary || 0;
    const grossEarned = isFuture ? 0 : baseSalary;
    const basicPay  = round2(grossEarned * (settings.basic_pct       || 0) / 100);
    const conveyance = round2(grossEarned * (settings.conveyance_pct || 0) / 100);
    const hra       = round2(grossEarned * (settings.hra_pct         || 0) / 100);
    const adhoc     = round2(grossEarned * (settings.adhoc_pct       || 0) / 100);
    const misc      = round2(grossEarned * (settings.misc_pct        || 0) / 100);
    return {
      employee_id: employee.id,
      employee_name: employee.name,
      department: employee.department,
      designation: employee.designation,
      join_date: employee.join_date,
      base_salary: baseSalary,
      per_day_rate: round2(settings.working_days_per_month > 0 ? baseSalary / settings.working_days_per_month : 0),
      working_days: settings.working_days_per_month,
      total_days_in_month: totalDays,
      days_counted: totalDays,
      is_current_month: (year === tY && mm === tM),
      is_future_month: isFuture,
      user_linked: !!employee.user_id,
      user_id: employee.user_id || null,
      salary_exempt: 1,
      salary_exempt_reason: 'Full salary regardless of attendance (mam directive)',
      paid_days: isFuture ? 0 : settings.working_days_per_month,
      half_days: 0, absent_days: 0,
      late_marks: 0, lates_converted_absent: 0, late_penalty: 0, late_days: [],
      paid_leaves: 0, unpaid_leaves: 0, sunday_count: 0,
      ot_hours: 0, ot_pay: 0,
      gross_earned: grossEarned,
      basic_pay: basicPay, conveyance, hra, adhoc, misc,
      total_earnings: round2(basicPay + conveyance + hra + adhoc + misc),
      advance,
      total_deductions: advance, deductions: advance,
      net_pay: round2(grossEarned - advance),
      cl_used: 0, sl_used: 0, pl_used: 0, short_leave_used: 0,
      breakdown: [{ date: month + '-01', day: '—', label: 'salary_exempt', pay: 0, note: 'Flat monthly salary; daily breakdown not applicable' }],
    };
  }

  // Don't penalise employees for days that haven't happened yet. For the
  // CURRENT month, stop the day-loop at today's date so May 5-31 (still in
  // the future on May 4) aren't counted as absent. Past months use all
  // days. Future months return zero everything.
  // Use IST (UTC+5:30) regardless of server timezone — Hostinger VPS runs
  // UTC by default, which would mark days as 'future' for ~5.5 hours after
  // midnight IST.
  const istNow = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
  const todayY = istNow.getUTCFullYear();
  const todayM = istNow.getUTCMonth() + 1;
  const todayD = istNow.getUTCDate();
  let lastDay = totalDays;
  if (year > todayY || (year === todayY && mm > todayM)) {
    lastDay = 0; // future month — nothing to calc yet
  } else if (year === todayY && mm === todayM) {
    lastDay = todayD; // current month — only up to today
  }

  // Resolve the user_id for this employee. Many HR employee rows were
  // created from candidates / manual entry without a login linkage, so
  // employee.user_id is NULL. Without a user_id, attendance / leaves
  // can't be looked up and every day looks 'absent'. Fall back to matching
  // by name (case-insensitive, trimmed) — and once found, persist the
  // linkage so the next run is fast.
  let userId = employee.user_id;
  if (!userId && employee.name) {
    const nameMatch = db.prepare(
      `SELECT id FROM users WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND active != 0 LIMIT 1`
    ).get(employee.name);
    if (nameMatch) {
      userId = nameMatch.id;
      try { db.prepare('UPDATE employees SET user_id = ? WHERE id = ?').run(userId, employee.id); } catch (e) { /* ignore */ }
    }
  }

  // Pull all attendance rows for this month at once
  const startDate = `${month}-01`;
  const endDate = `${month}-${pad(totalDays)}`;
  const attRows = userId
    ? db.prepare(`SELECT date, punch_in_time, punch_out_time, total_hours, status, admin_marked
                  FROM attendance WHERE user_id = ? AND date BETWEEN ? AND ?`).all(userId, startDate, endDate)
    : [];
  const attByDate = {};
  for (const r of attRows) attByDate[r.date] = r;

  // Pull approved leaves overlapping this month
  const leaveRows = userId
    ? db.prepare(`SELECT leave_type, from_date, to_date, days, hours
                  FROM leave_requests
                  WHERE user_id = ? AND status='approved'
                    AND NOT (to_date < ? OR from_date > ?)`).all(userId, startDate, endDate)
    : [];

  // Track allowance usage
  let clUsed = 0, slUsed = 0, plUsed = 0, shortLeaveUsed = 0;

  // Build per-day map of leave type
  const leaveByDate = {}; // date → leave_type ('casual','sick','earned','short_leave','comp_off')
  const shortLeaveByDate = {}; // date → true if short leave applied that day
  for (const lr of leaveRows) {
    const from = new Date(lr.from_date);
    const to = new Date(lr.to_date);
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      if (dateStr < startDate || dateStr > endDate) continue;
      if (lr.leave_type === 'short_leave') {
        shortLeaveByDate[dateStr] = true;
      } else {
        leaveByDate[dateStr] = lr.leave_type;
      }
    }
  }

  let paidDays = 0, halfDays = 0, absentDays = 0, lateMarks = 0;
  let paidLeaves = 0, unpaidLeaves = 0, sundayCount = 0, otHours = 0;
  let latePenalty = 0; // accumulated Rs deduction for late punches over grace
  const breakdown = []; // per-day for slip
  const lateDays = []; // [{date, minutes_late, applies_penalty: bool}]

  const lateAfter = timeToMinutes(settings.late_after_time);
  const halfDayAfter = timeToMinutes(settings.half_day_after_time);

  for (let day = 1; day <= lastDay; day++) {
    const dateStr = `${year}-${pad(mm)}-${pad(day)}`;
    const sun = isSunday(year, mm, day);
    const att = attByDate[dateStr];
    const leaveType = leaveByDate[dateStr];
    const isShortLeave = !!shortLeaveByDate[dateStr];

    let dayLabel = 'absent';
    let dayPay = 0; // 1 = full, 0.5 = half, 0 = absent

    // Sunday
    if (sun && !leaveType && !att) {
      if (settings.sundays_paid) {
        dayPay = 1;
        sundayCount += 1;
        dayLabel = 'sunday_paid';
      } else {
        dayLabel = 'sunday_unpaid';
      }
      breakdown.push({ date: dateStr, day: 'Sun', label: dayLabel, pay: dayPay });
      paidDays += dayPay;
      continue;
    }

    // Approved leave that day
    if (leaveType) {
      let paid = false;
      if (leaveType === 'casual') {
        // 1 paid casual leave per month per staff (mam 2026-06-09).
        if ((settings.cl_per_month || 0) > 0 && clUsed < settings.cl_per_month) { paid = true; clUsed += 1; }
      } else if (leaveType === 'sick') {
        if ((settings.sl_per_month || 0) > 0 && slUsed < settings.sl_per_month) { paid = true; slUsed += 1; }
      } else if (leaveType === 'earned') {
        if ((settings.pl_per_month || 0) > 0 && plUsed < settings.pl_per_month) { paid = true; plUsed += 1; }
      } else if (leaveType === 'comp_off' || leaveType === 'half_day') {
        paid = true; // comp-off & half-day leave → full paid day (mam 2026-06-09)
      }
      if (paid) {
        dayPay = 1;
        paidLeaves += 1;
        dayLabel = `paid_${leaveType}_leave`;
      } else {
        unpaidLeaves += 1;
        dayLabel = `unpaid_${leaveType}_leave`;
      }
      breakdown.push({ date: dateStr, day: dayName(year, mm, day), label: dayLabel, pay: dayPay });
      paidDays += dayPay;
      continue;
    }

    // Admin-marked override (admin-mark sets status + admin_marked=1 but
    // NO punch_in_time, so the punch-based logic below would wrongly count
    // it absent). When an admin manually marks a day, honour that status
    // directly — this is what makes "admin updates present/absent" flow
    // through to the payroll counts. Wins over the punch logic.
    if (att && att.admin_marked) {
      const s = String(att.status || '').toLowerCase();
      if (s === 'present' || s === 'late') {
        dayPay = 1;
        dayLabel = s === 'late' ? 'admin_late' : 'admin_present';
      } else if (s === 'half_day' || s === 'short_day') {
        dayPay = 0.5; halfDays += 1;
        dayLabel = 'admin_' + s;
      } else if (s === 'leave' || s === 'on_leave' || s === 'holiday') {
        dayPay = 1; paidLeaves += 1;
        dayLabel = 'admin_' + s;
      } else { // 'absent' or anything unrecognised
        dayPay = 0; absentDays += 1;
        dayLabel = 'admin_absent';
      }
      paidDays += dayPay;
      breakdown.push({ date: dateStr, day: dayName(year, mm, day), label: dayLabel, pay: dayPay, admin_marked: true });
      continue;
    }

    // Attendance row
    if (att && att.punch_in_time) {
      const punchInMin = timeToMinutes(att.punch_in_time);
      const hours = att.total_hours || 0;

      // Half-day triggers (mam 2026-06-09):
      //   - punched in AFTER 10:00 (half_day_after_time) → half day, no grace
      //   - worked UNDER min_hours_half_day (4h) → half day (NOT absent)
      // A day with 4h+ of work counts as a FULL day even if it's under 8h —
      // mam dropped the old 8h-minimum half-day docking ("Full day" for the
      // 4–8h case). Coming in during the 09:46–10:00 window is only a late
      // MARK on an otherwise full day, handled in the else branch below.
      const veryLate = punchInMin !== null && halfDayAfter !== null && punchInMin > halfDayAfter;
      const lowHoursHalf = hours > 0 && hours < settings.min_hours_half_day;

      // Skip half-day if short leave was applied that day (and setting enabled)
      const shortLeaveSavesIt = isShortLeave && settings.skip_half_day_if_short_leave;

      if ((veryLate || lowHoursHalf) && !shortLeaveSavesIt) {
        halfDays += 1;
        dayPay = 0.5;
        dayLabel = veryLate ? 'half_day_late' : 'half_day_low_hours';
      } else {
        // Late mark check (between late_after and half_day_after)
        if (punchInMin !== null && lateAfter !== null && punchInMin > lateAfter) {
          if (!shortLeaveSavesIt) {
            lateMarks += 1;
            lateDays.push({ date: dateStr, minutes_late: punchInMin - lateAfter });
          }
          dayLabel = 'late';
        } else {
          dayLabel = 'present';
        }
        dayPay = 1;
        // Overtime — only for employees explicitly marked OT-eligible.
        if (employee.ot_eligible && hours > settings.ot_threshold_hours) {
          otHours += hours - settings.ot_threshold_hours;
        }
      }
      paidDays += dayPay;
      breakdown.push({ date: dateStr, day: dayName(year, mm, day), label: dayLabel, pay: dayPay, punch_in: att.punch_in_time, hours });
      continue;
    }

    // No attendance, no leave, not Sunday → absent
    absentDays += 1;
    dayLabel = 'absent_no_punch';
    breakdown.push({ date: dateStr, day: dayName(year, mm, day), label: dayLabel, pay: 0 });
  }

  // N lates → 1 absent conversion (legacy model — disabled by default when 0)
  let latesAsAbsent = 0;
  if (settings.lates_to_absent > 0 && lateMarks >= settings.lates_to_absent) {
    latesAsAbsent = Math.floor(lateMarks / settings.lates_to_absent);
    paidDays = Math.max(0, paidDays - latesAsAbsent);
  }

  // Per-minute late penalty (current model): first N late marks per month
  // are free, every late day after that is charged Rs/min × minutes_late.
  const grace = settings.late_grace_count || 0;
  const perMin = settings.late_per_minute_rate || 0;
  for (let i = 0; i < lateDays.length; i++) {
    const d = lateDays[i];
    if (i < grace) {
      d.applies_penalty = false;
    } else {
      d.applies_penalty = true;
      const dayPenalty = (d.minutes_late || 0) * perMin;
      latePenalty += dayPenalty;
      d.penalty_amount = round2(dayPenalty);
      // tag the breakdown row with the penalty
      const br = breakdown.find(b => b.date === d.date);
      if (br) {
        br.late_minutes = d.minutes_late;
        br.late_penalty = round2(dayPenalty);
      }
    }
  }

  // ─── Sandwich rule (mam 2026-06-08, revised) ─────────────────────
  // Sunday is ALWAYS paid, EXCEPT when BOTH the Saturday before AND the
  // Monday after are absent (no pay) — only then is the sandwiched
  // Sunday deducted. If either side is a worked/paid day (full, half,
  // or paid leave) the Sunday stays paid. (Previous rule deducted when
  // EITHER side was off; mam softened it to BOTH.)
  //
  // Only the weekly-off Sunday rows are touched — a Sunday the person
  // actually worked or took leave on keeps its own outcome.
  // Walk post-loop because we need each neighbouring day's pay first.
  for (let i = 0; i < breakdown.length; i++) {
    const b = breakdown[i];
    if (b.day !== 'Sun') continue;
    if (!(b.label && b.label.startsWith('sunday'))) continue;
    const prev = i > 0 ? breakdown[i - 1] : null;
    const next = i < breakdown.length - 1 ? breakdown[i + 1] : null;
    const prevAbsent = !!prev && prev.pay === 0; // Saturday absent (no pay)
    const nextAbsent = !!next && next.pay === 0; // Monday absent (no pay)
    if (prevAbsent && nextAbsent) {
      // Both neighbours absent → Sunday deducted.
      if (b.pay > 0) {
        paidDays -= b.pay;
        sundayCount -= 1;
        b.pay = 0;
        b.label = 'sunday_sandwich_break';
      }
    } else if (settings.sundays_paid) {
      // At least one neighbour worked/paid → Sunday paid.
      if (b.pay < 1) {
        paidDays += (1 - b.pay);
        sundayCount += 1;
        b.pay = 1;
        b.label = 'sunday_paid';
      }
    }
  }

  // ─── Sunday-worked bonus (mam 2026-06-09) ────────────────────────
  // Sunday is a paid weekly-off already built into the monthly salary.
  // If the person ALSO works that Sunday, mam gives an EXTRA full day's
  // pay on top — so net can exceed base salary. The worked Sunday has
  // already counted as one normal day (folded into the 'att'/present
  // count); here we add the extra day-equivalent (full worked Sunday →
  // +1, half → +0.5).  Weekly-off (unworked) Sundays are untouched.
  let sundayWorked = 0;     // # of Sundays actually worked
  let sundayWorkedPay = 0;  // extra day-equivalents credited
  const SUN_WORK_LABELS = new Set([
    'present', 'late', 'half_day_late', 'half_day_low_hours',
    'admin_present', 'admin_late', 'admin_half_day', 'admin_short_day',
  ]);
  for (const b of breakdown) {
    if (b.day !== 'Sun' || !SUN_WORK_LABELS.has(b.label) || !(b.pay > 0)) continue;
    sundayWorked += 1;
    sundayWorkedPay += b.pay;
    b.sunday_worked = true;
    b.sunday_bonus = b.pay;
  }
  paidDays += sundayWorkedPay;

  // ─── Per-day rate (mam 2026-06-01) ───────────────────────────────
  // "one per day we count = full salary / total days in month".
  // Switched from working_days_per_month (typically 26) to the actual
  // calendar days (28/29/30/31).  Sundays are already paid via the
  // sandwich rule above, so the salary covers the full month evenly.
  // ─── Manual monthly overrides (mam 2026-06-13) ───────────────────
  // Admin can hand-set Paid Days, CL (paid leaves) and the Late ₹ penalty for
  // this month to pay salary now while attendance is being corrected.  NULL =
  // use auto.  CL is part of paid days, so a CL edit shifts the auto paid-days;
  // a manual Paid Days is the final word for what's paid.
  const clOv = adjRow.cl_override, pdOv = adjRow.paid_days_override, lpOv = adjRow.late_penalty_override;
  const clOverridden = clOv != null && clOv >= 0;
  const pdOverridden = pdOv != null && pdOv >= 0;
  const lpOverridden = lpOv != null && lpOv >= 0;
  const effPaidLeaves = clOverridden ? round2(clOv) : paidLeaves;
  let effPaidDays = round2(paidDays - paidLeaves + effPaidLeaves);
  if (pdOverridden) effPaidDays = round2(pdOv);
  const effLatePenalty = lpOverridden ? round2(lpOv) : latePenalty;

  const baseSalary = employee.salary || 0;
  const perDayRate = totalDays > 0 ? baseSalary / totalDays : 0;
  const grossEarned = perDayRate * effPaidDays;

  // Overtime pay — hourly rate derived from the same monthly base so
  // it stays consistent with the new per-day formula.
  const perHourRate = totalDays > 0
    ? baseSalary / (totalDays * settings.ot_threshold_hours)
    : 0;
  const otPay = otHours * perHourRate * (settings.ot_rate_multiplier || 1);

  // Salary breakdown — split the prorated gross into Basic / Conveyance /
  // HRA / Adhoc / Misc using the percentages in settings (matches mam's
  // SEPL Tally slip format).
  const basicPay = round2(grossEarned * (settings.basic_pct || 0) / 100);
  const conveyance = round2(grossEarned * (settings.conveyance_pct || 0) / 100);
  const hra = round2(grossEarned * (settings.hra_pct || 0) / 100);
  const adhoc = round2(grossEarned * (settings.adhoc_pct || 0) / 100);
  const misc = round2(grossEarned * (settings.misc_pct || 0) / 100);

  // Deductions = late penalty (override-aware) + any advance taken this month.
  const totalDeductions = round2(effLatePenalty + advance);
  // Salary BEFORE overtime = earned-for-days minus deductions PLUS the food
  // allowance (mam wants base earning and the OT add-on shown separately).
  // Net pay then = before-OT + OT.
  const netBeforeOt = round2(grossEarned - totalDeductions + food);
  const netPay = round2(grossEarned + otPay - totalDeductions + food);
  const deductions = baseSalary - grossEarned + totalDeductions; // informational

  return {
    employee_id: employee.id,
    employee_name: employee.name,
    department: employee.department,
    designation: employee.designation,
    join_date: employee.join_date,
    base_salary: baseSalary,
    per_day_rate: round2(perDayRate),
    working_days: settings.working_days_per_month,
    total_days_in_month: totalDays,
    days_counted: lastDay,
    is_current_month: (year === todayY && mm === todayM),
    is_future_month: (year > todayY || (year === todayY && mm > todayM)),
    user_linked: !!userId,
    user_id: userId || null,
    paid_days: round2(effPaidDays),
    paid_days_auto: round2(paidDays),                 // before any manual override
    paid_days_overridden: pdOverridden,
    // Components of paid_days, so the UI can show "attendance + Sunday + CL"
    // (mam 2026-06-08). present_days = the REAL worked-day equivalents from
    // attendance (full=1, half=0.5) — always the auto figure so a manual Paid
    // Days override doesn't distort the "att" breakdown.
    present_days: round2(paidDays - sundayCount - paidLeaves - sundayWorkedPay),
    sunday_worked: sundayWorked,            // # of Sundays the person worked
    sunday_worked_pay: round2(sundayWorkedPay), // extra day-equivalents paid for them
    half_days: halfDays,
    absent_days: absentDays,
    late_marks: lateMarks,
    lates_converted_absent: latesAsAbsent,
    late_penalty: round2(effLatePenalty),
    late_penalty_auto: round2(latePenalty),           // before any manual override
    late_penalty_overridden: lpOverridden,
    late_days: lateDays,
    paid_leaves: effPaidLeaves,
    paid_leaves_auto: paidLeaves,                     // before any manual override
    cl_overridden: clOverridden,
    unpaid_leaves: unpaidLeaves,
    sunday_count: sundayCount,
    ot_hours: round2(otHours),
    ot_threshold: settings.ot_threshold_hours,            // hours/day before OT (= 9)
    ot_per_hour_rate: round2(perHourRate * (settings.ot_rate_multiplier || 1)), // = salary/days/9
    gross_earned: round2(grossEarned),
    ot_pay: round2(otPay),
    net_before_ot: netBeforeOt,   // salary before overtime is added
    // Earnings breakdown (Basic + Conveyance + HRA + Adhoc + Misc = gross)
    basic_pay: basicPay,
    conveyance: conveyance,
    hra: hra,
    adhoc: adhoc,
    misc: misc,
    total_earnings: round2(basicPay + conveyance + hra + adhoc + misc),
    advance,
    food,
    late_penalty_only: round2(effLatePenalty),
    total_deductions: totalDeductions,
    deductions: round2(deductions),
    net_pay: netPay,
    cl_used: clUsed,
    sl_used: slUsed,
    pl_used: plUsed,
    short_leave_used: Object.keys(shortLeaveByDate).length,
    breakdown,
  };
}

function round2(n) { return Math.round((n || 0) * 100) / 100; }

function dayName(y, m, d) {
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(y, m - 1, d).getDay()];
}

// GET monthly payroll for ALL employees
router.get('/calculate', requirePermission('payroll', 'view'), (req, res) => {
  try {
    const month = req.query.month;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const db = getDb();
    const settings = getSettings(db);
    const employees = db.prepare(`SELECT id, user_id, name, department, designation, join_date, salary, ot_eligible, cl_eligible, cl_opening_balance FROM employees WHERE status='active' AND salary > 0`).all();
    // Active employees with NO salary set are silently excluded from payroll —
    // surface them so admin knows who's missing and why (mam 2026-06-12:
    // "X not in payroll even they present").  Salary, not attendance, gates
    // inclusion.
    const excludedNoSalary = db.prepare(
      `SELECT id, name FROM employees WHERE status='active' AND (salary IS NULL OR salary <= 0) ORDER BY name COLLATE NOCASE`
    ).all();

    // If a run is finalised for this month, return saved snapshots; else live-calc
    const finalised = db.prepare('SELECT COUNT(*) as c FROM payroll_runs WHERE month=? AND status=?').get(month, 'finalised').c;
    const out = employees.map(emp => {
      if (finalised) {
        const snap = db.prepare('SELECT * FROM payroll_runs WHERE month=? AND employee_id=?').get(month, emp.id);
        if (snap) return { ...snap, locked: true };
      }
      return calculateForEmployee(db, settings, emp, month);
    });

    res.json({ month, settings, employees: out, excluded_no_salary: excludedNoSalary });
  } catch (err) {
    console.error('payroll calc error', err);
    res.status(500).json({ error: err.message });
  }
});

// GET single employee detail (with breakdown)
router.get('/calculate/:employee_id', requirePermission('payroll', 'view'), (req, res) => {
  try {
    const month = req.query.month;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const db = getDb();
    const settings = getSettings(db);
    const emp = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.employee_id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const result = calculateForEmployee(db, settings, emp, month);
    res.json({ month, settings, ...result });
  } catch (err) {
    console.error('payroll detail error', err);
    res.status(500).json({ error: err.message });
  }
});

// POST finalise a month — locks the snapshot for all employees
router.post('/finalise', requirePermission('payroll', 'approve'), (req, res) => {
  try {
    const { month } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month required' });
    const db = getDb();
    const settings = getSettings(db);
    const employees = db.prepare(`SELECT * FROM employees WHERE status='active' AND salary > 0`).all();

    const ins = db.prepare(`INSERT OR REPLACE INTO payroll_runs (
      month, employee_id, employee_name, base_salary, working_days, paid_days, half_days,
      absent_days, late_marks, lates_converted_absent, late_penalty, paid_leaves, unpaid_leaves, sundays,
      ot_hours, gross_earned, ot_pay, deductions, net_pay,
      basic_pay, conveyance, hra, adhoc, misc, advance,
      breakdown_json, status, finalised_by, finalised_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`);

    const tx = db.transaction(() => {
      for (const emp of employees) {
        const r = calculateForEmployee(db, settings, emp, month);
        ins.run(
          month, emp.id, emp.name, r.base_salary, r.working_days, r.paid_days, r.half_days,
          r.absent_days, r.late_marks, r.lates_converted_absent, r.late_penalty, r.paid_leaves, r.unpaid_leaves, r.sunday_count,
          r.ot_hours, r.gross_earned, r.ot_pay, r.deductions, r.net_pay,
          r.basic_pay, r.conveyance, r.hra, r.adhoc, r.misc, r.advance,
          JSON.stringify(r.breakdown), 'finalised', req.user.id
        );
      }
    });
    tx();
    res.json({ message: `Payroll finalised for ${month}`, count: employees.length });
  } catch (err) {
    console.error('payroll finalise error', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT mark an employee Paid / unpaid for a finalised month (mam 2026-06-13:
// "after account will give option paid ... if we dont pay someone that is in
// our record").  Only works once the month is finalised — the snapshot row
// must exist.  Gated by payroll edit (Accounts); admins always pass.
router.put('/paid/:employee_id', requirePermission('payroll', 'edit'), (req, res) => {
  try {
    const db = getDb();
    const { month } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const paid = req.body.paid ? 1 : 0;
    const row = db.prepare('SELECT id FROM payroll_runs WHERE month=? AND employee_id=?').get(month, req.params.employee_id);
    if (!row) return res.status(409).json({ error: `Finalise ${month} first — you can only mark salary paid after it's finalised.` });
    if (paid) {
      db.prepare('UPDATE payroll_runs SET paid=1, paid_at=CURRENT_TIMESTAMP, paid_by=? WHERE id=?').run(req.user.id, row.id);
    } else {
      db.prepare('UPDATE payroll_runs SET paid=0, paid_at=NULL, paid_by=NULL WHERE id=?').run(row.id);
    }
    res.json({ message: paid ? 'Marked paid' : 'Marked unpaid', paid: !!paid });
  } catch (err) {
    console.error('payroll paid update error', err);
    res.status(500).json({ error: err.message });
  }
});

// POST unlock a finalised month (admin only — for corrections)
router.post('/unlock', adminOnly, (req, res) => {
  const { month } = req.body;
  const db = getDb();
  db.prepare('DELETE FROM payroll_runs WHERE month=? AND status != ?').run(month, 'disbursed');
  res.json({ message: `Unlocked ${month}` });
});

// PUT an employee's advance-salary amount for a month (admin). Deducted
// from that month's net pay. Blocked once the month is finalised.
router.put('/advance/:employee_id', adminOnly, (req, res) => {
  try {
    const db = getDb();
    const { month } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amount must be a non-negative number' });

    const emp = db.prepare('SELECT id FROM employees WHERE id=?').get(req.params.employee_id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const locked = db.prepare('SELECT COUNT(*) AS c FROM payroll_runs WHERE month=? AND status=?').get(month, 'finalised').c;
    if (locked) return res.status(409).json({ error: `${month} is finalised — unlock it first to change an advance.` });

    db.prepare(
      `INSERT INTO payroll_advances (month, employee_id, amount, updated_by, updated_at)
       VALUES (?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(month, employee_id) DO UPDATE SET
         amount = excluded.amount, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`
    ).run(month, emp.id, round2(amount), req.user.id);

    res.json({ message: 'Advance saved', amount: round2(amount) });
  } catch (err) {
    console.error('advance update error', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT an employee's food allowance for a month (admin). ADDED to that
// month's net pay. Blocked once the month is finalised. Stored on the same
// payroll_advances row as the advance (mam 2026-06-12).
router.put('/food/:employee_id', adminOnly, (req, res) => {
  try {
    const db = getDb();
    const { month } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amount must be a non-negative number' });

    const emp = db.prepare('SELECT id FROM employees WHERE id=?').get(req.params.employee_id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const locked = db.prepare('SELECT COUNT(*) AS c FROM payroll_runs WHERE month=? AND status=?').get(month, 'finalised').c;
    if (locked) return res.status(409).json({ error: `${month} is finalised — unlock it first to change food.` });

    db.prepare(
      `INSERT INTO payroll_advances (month, employee_id, food, updated_by, updated_at)
       VALUES (?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(month, employee_id) DO UPDATE SET
         food = excluded.food, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`
    ).run(month, emp.id, round2(amount), req.user.id);

    res.json({ message: 'Food saved', amount: round2(amount) });
  } catch (err) {
    console.error('food update error', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT a manual monthly override for Paid Days / CL / Late ₹ (admin, mam
// 2026-06-13: "give me edit option on days, CL, late so i can give salary
// now").  field ∈ paid_days | cl | late_penalty.  A blank / null value RESETS
// to the auto-calculated number.  Blocked once the month is finalised.
router.put('/override/:employee_id', adminOnly, (req, res) => {
  try {
    const db = getDb();
    const { month, field } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const COLS = { paid_days: 'paid_days_override', cl: 'cl_override', late_penalty: 'late_penalty_override' };
    const col = COLS[field];
    if (!col) return res.status(400).json({ error: 'field must be paid_days, cl or late_penalty' });

    const raw = req.body.value;
    const reset = raw === '' || raw === null || raw === undefined;
    let value = null;
    if (!reset) {
      value = Number(raw);
      if (!Number.isFinite(value) || value < 0) return res.status(400).json({ error: 'value must be a non-negative number' });
      // Paid days can exceed the calendar days — worked Sundays add bonus days
      // on top (mam 2026-06-13: Manoj = 34). CL stays within the month.
      const dayMax = field === 'cl' ? 31 : 60;
      if (field !== 'late_penalty' && value > dayMax) {
        return res.status(400).json({ error: `${field === 'cl' ? 'CL' : 'days'} cannot exceed ${dayMax}` });
      }
      value = round2(value);
    }

    const emp = db.prepare('SELECT id FROM employees WHERE id=?').get(req.params.employee_id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const locked = db.prepare('SELECT COUNT(*) AS c FROM payroll_runs WHERE month=? AND status=?').get(month, 'finalised').c;
    if (locked) return res.status(409).json({ error: `${month} is finalised — unlock it first to edit it.` });

    db.prepare(
      `INSERT INTO payroll_advances (month, employee_id, ${col}, updated_by, updated_at)
       VALUES (?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(month, employee_id) DO UPDATE SET
         ${col} = excluded.${col}, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`
    ).run(month, emp.id, value, req.user.id);

    res.json({ message: reset ? 'Reset to auto' : 'Override saved', value });
  } catch (err) {
    console.error('override update error', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── CL Leave Balances (annual, with carry-forward) ────────────────────
// Mam: "show me we give CL to someone and carry forward, where i can show".
// Model (decided 2026-06-08): the monthly CL allowance is the same for
// everyone (payroll_settings.cl_per_month); each person accrues it month
// by month across the YEAR, CL taken is deducted, and whatever is left at
// year-end is carried into next year as their opening balance.
//
//   remaining(year) = cl_opening_balance            (carried from prev year)
//                   + cl_per_month × months_elapsed  (accrued this year)
//                   − CL days taken this year        (approved casual leaves)
//
// months_elapsed = 12 for a past year, current calendar month for the
// running year, 0 for a future year. Per-employee cl_eligible=0 → no accrual.

function computeLeaveBalances(db, year) {
  const settings = getSettings(db);
  const clPerMonth = +settings.cl_per_month || 0;

  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1; // 1-12
  const monthsElapsed = year < curYear ? 12 : (year > curYear ? 0 : curMonth);

  const yStart = `${year}-01-01`;
  const yEnd = `${year}-12-31`;

  const employees = db.prepare(
    `SELECT id, user_id, name, department, designation,
            COALESCE(cl_eligible, 1) AS cl_eligible,
            COALESCE(ot_eligible, 0) AS ot_eligible,
            COALESCE(cl_opening_balance, 0) AS cl_opening_balance
       FROM employees WHERE status='active' ORDER BY name COLLATE NOCASE`
  ).all();

  // CL days taken this year per user (approved casual leaves whose start
  // falls in the year). days defaults to 1 when the column is null.
  const usedStmt = db.prepare(
    `SELECT COALESCE(SUM(COALESCE(days, 1)), 0) AS used
       FROM leave_requests
      WHERE user_id = ? AND leave_type = 'casual' AND status = 'approved'
        AND from_date BETWEEN ? AND ?`
  );

  return employees.map(e => {
    const eligible = e.cl_eligible ? 1 : 0;
    const opening = round2(e.cl_opening_balance);
    const accrued = eligible ? round2(clPerMonth * monthsElapsed) : 0;
    const used = e.user_id ? round2(usedStmt.get(e.user_id, yStart, yEnd).used) : 0;
    const remaining = round2(opening + accrued - used);
    return {
      employee_id: e.id,
      employee_name: e.name,
      department: e.department || null,
      designation: e.designation || null,
      cl_eligible: eligible,
      ot_eligible: e.ot_eligible ? 1 : 0,
      opening_balance: opening,
      cl_per_month: clPerMonth,
      months_elapsed: monthsElapsed,
      accrued,
      used,
      remaining,
      user_linked: !!e.user_id,
    };
  });
}

// GET annual CL balance sheet for all employees.
router.get('/leave-balances', requirePermission('payroll', 'view'), (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const db = getDb();
    res.json({ year, cl_per_month: +getSettings(db).cl_per_month || 0, rows: computeLeaveBalances(db, year) });
  } catch (err) {
    console.error('leave-balances error', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT one employee's carry-forward opening balance + CL eligibility (admin).
router.put('/leave-balance/:employee_id', adminOnly, (req, res) => {
  try {
    const db = getDb();
    const emp = db.prepare('SELECT id FROM employees WHERE id=?').get(req.params.employee_id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const sets = [];
    const vals = [];
    if (req.body.cl_opening_balance !== undefined) {
      const v = Number(req.body.cl_opening_balance);
      if (!Number.isFinite(v)) return res.status(400).json({ error: 'cl_opening_balance must be a number' });
      sets.push('cl_opening_balance = ?'); vals.push(v);
    }
    if (req.body.cl_eligible !== undefined) {
      sets.push('cl_eligible = ?'); vals.push(req.body.cl_eligible ? 1 : 0);
    }
    if (req.body.ot_eligible !== undefined) {
      sets.push('ot_eligible = ?'); vals.push(req.body.ot_eligible ? 1 : 0);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(emp.id);
    db.prepare(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    res.json({ message: 'Updated' });
  } catch (err) {
    console.error('leave-balance update error', err);
    res.status(500).json({ error: err.message });
  }
});

// POST roll a year's leftover CL into next year's opening balance (admin).
// Sets each employee's cl_opening_balance = remaining(year). Idempotent in
// effect only if re-run on the SAME source year — re-running after CL is
// taken in the new year would double count, so the UI guards it to the
// completed year.
router.post('/leave-balances/rollover', adminOnly, (req, res) => {
  try {
    const year = parseInt(req.body.year, 10);
    if (!year) return res.status(400).json({ error: 'year required' });
    const db = getDb();
    const rows = computeLeaveBalances(db, year);
    const upd = db.prepare('UPDATE employees SET cl_opening_balance = ? WHERE id = ?');
    const tx = db.transaction(() => {
      for (const r of rows) upd.run(Math.max(0, r.remaining), r.employee_id);
    });
    tx();
    res.json({ message: `Rolled ${year} leftover CL into opening balance for ${rows.length} employees`, count: rows.length });
  } catch (err) {
    console.error('leave-balances rollover error', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
