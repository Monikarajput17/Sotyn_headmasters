const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { fireEmailEvent } = require('../lib/emailRules');
const { getEmailConfig } = require('../lib/email');
// Shared geofence math + the "is this punch on-site?" decision. Single source
// of truth for punch-in, punch-out, live tracking AND the audit endpoint so
// they can never drift apart. See server/lib/geofence.js for the rule that
// stops weak indoor phone-GPS from falsely blocking on-site staff.
const { haversine, evaluateGeofence, geoSettings } = require('../lib/geofence');
const atUserEmail = (db, id) => { try { return db.prepare('SELECT email FROM users WHERE id=?').get(id)?.email || null; } catch { return null; } };
const atDirector = () => { try { return getEmailConfig().director; } catch { return null; } };
const router = express.Router();
router.use(authMiddleware);

// Late detection — read cutoff from payroll_settings (admin-tunable), fall
// back to 09:46 IST. Returns true if `whenIso` (ISO string in UTC) lies
// AFTER the IST cutoff for that day.
//
// The original implementation called new Date().getHours() which returns
// UTC hours. On a UTC-running VPS this meant 10:23 IST = 04:53 UTC, so
// `4 > 9` was false → no one got flagged late before 15:15 IST. Bug
// affected every attendance row since deploy.
function isPunchLate(db, whenIso) {
  let cutoffMin = 9 * 60 + 46; // default 09:46 IST
  try {
    const ps = db.prepare('SELECT late_after_time FROM payroll_settings WHERE id=1').get();
    if (ps?.late_after_time) {
      const [h, m] = String(ps.late_after_time).split(':').map(Number);
      cutoffMin = h * 60 + (m || 0);
    }
  } catch {}
  // Shift UTC → IST by adding 5h30m, then read 'UTC' hours/minutes from
  // the shifted Date — those values are now the actual IST time-of-day.
  const ist = new Date(new Date(whenIso || Date.now()).getTime() + 5.5 * 60 * 60 * 1000);
  const istMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return istMin > cutoffMin;
}

// GET today's attendance for current user.
// Manual admin back-fills DO show on the user's own view now (mam 2026-05-30:
// "i marked previous attendance but not show") — so a day an admin marked
// present/half-day appears on the employee's calendar. Only the silent
// auto-mark allow-list rows stay hidden (they're a convenience flag, not a
// real presence the user should see).
router.get('/my-today', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const record = getDb().prepare(
    `SELECT * FROM attendance WHERE user_id=? AND date=?
        AND NOT (COALESCE(admin_marked,0)=1 AND COALESCE(remarks,'')='Auto-marked (allow-list)')`
  ).get(req.user.id, today);
  res.json(record || null);
});

// GET current month's attendance for the logged-in user — used by the
// dashboard card so employees can see their month at a glance. Optional
// query param ?month=YYYY-MM lets them view a different month.
router.get('/my-month', (req, res) => {
  const db = getDb();
  const now = new Date();
  const monthParam = (req.query.month || '').match(/^\d{4}-\d{2}$/) ? req.query.month : null;
  const year = monthParam ? parseInt(monthParam.slice(0, 4), 10) : now.getFullYear();
  const month = monthParam ? parseInt(monthParam.slice(5, 7), 10) : now.getMonth() + 1;
  const pad = n => String(n).padStart(2, '0');
  const monthStart = `${year}-${pad(month)}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const monthEnd = `${year}-${pad(month)}-${pad(lastDay)}`;

  // Pull attendance + leave records for this user, this month.
  // Manual admin back-fills are included so they show on the calendar
  // (mam 2026-05-30: "i marked previous attendance but not show").
  // Only the silent auto-mark allow-list rows stay hidden.
  const attendance = db.prepare(
    `SELECT date, status, punch_in_time, punch_out_time, total_hours
       FROM attendance
      WHERE user_id=? AND date BETWEEN ? AND ?
        AND NOT (COALESCE(admin_marked,0)=1 AND COALESCE(remarks,'')='Auto-marked (allow-list)')
      ORDER BY date`
  ).all(req.user.id, monthStart, monthEnd);

  const leaves = db.prepare(
    `SELECT leave_type, from_date, to_date, from_time, to_time, status, hours, days
     FROM leave_requests
     WHERE user_id=? AND status='approved'
       AND NOT (to_date < ? OR from_date > ?)`
  ).all(req.user.id, monthStart, monthEnd);

  // Pull configured late-cutoff from payroll_settings so the dashboard
  // late-count reflects mam's actual policy (e.g. 09:30) instead of the
  // hard-coded 09:45 from the punch-in flow. Falls back to 09:45 if the
  // settings table doesn't exist yet on a stale DB.
  let lateCutoffMin = 9 * 60 + 46;
  try {
    const ps = db.prepare(`SELECT late_after_time FROM payroll_settings WHERE id=1`).get();
    if (ps?.late_after_time) {
      const [h, m] = ps.late_after_time.split(':').map(Number);
      lateCutoffMin = h * 60 + (m || 0);
    }
  } catch {}

  // Build a per-day map of status. Key = YYYY-MM-DD.
  // Order of precedence: attendance row wins; else leave; else (past weekdays) absent; future = blank.
  const today = new Date().toISOString().slice(0, 10);
  const todayObj = new Date(today);
  const days = [];
  const byStatus = { present: 0, late: 0, half_day: 0, short_day: 0, absent: 0, on_leave: 0, weekend: 0, future: 0 };
  let totalHours = 0;

  for (let d = 1; d <= lastDay; d++) {
    const dateStr = `${year}-${pad(month)}-${pad(d)}`;
    const dObj = new Date(dateStr);
    const dow = dObj.getDay(); // 0=Sun 6=Sat
    const isWeekend = dow === 0;
    const att = attendance.find(a => a.date === dateStr);
    // Is this day inside any approved leave range?
    const onLeave = leaves.find(l => dateStr >= l.from_date && dateStr <= l.to_date && l.leave_type !== 'short_leave');
    let status;
    if (att) {
      status = att.status;
      totalHours += +att.total_hours || 0;
      // Re-classify as 'late' based on the configured late_after_time.
      // CRITICAL: punch_in_time is stored as UTC ISO. To compare against
      // the IST cutoff (09:45 IST), shift to IST first. Bug before this
      // fix: getHours() returned UTC hours so 10:23 IST (= 04:53 UTC)
      // was read as '4:53', never exceeded the 9:45 cutoff, dashboard
      // showed Late=0 for everyone in the morning shift.
      if (status === 'present' && att.punch_in_time) {
        const piIst = new Date(new Date(att.punch_in_time).getTime() + 5.5 * 60 * 60 * 1000);
        if (!isNaN(piIst)) {
          const piMin = piIst.getUTCHours() * 60 + piIst.getUTCMinutes();
          if (piMin > lateCutoffMin) status = 'late';
        }
      }
    } else if (onLeave) {
      status = 'on_leave';
    } else if (isWeekend) {
      status = 'weekend';
    } else if (dObj > todayObj) {
      status = 'future';
    } else {
      status = 'absent';
    }
    if (byStatus[status] !== undefined) byStatus[status]++;
    // Include punch-in/out times and total hours so the dashboard can
    // render a per-day timeline. Also embed any approved leave that
    // covers this date (short_leave or full-day) for at-a-glance audit.
    const dayLeave = leaves.find(l => dateStr >= l.from_date && dateStr <= l.to_date);
    days.push({
      date: dateStr,
      day: d,
      dow,
      status,
      punch_in_time: att?.punch_in_time || null,
      punch_out_time: att?.punch_out_time || null,
      total_hours: att?.total_hours || 0,
      leave: dayLeave ? {
        leave_type: dayLeave.leave_type,
        from_time: dayLeave.from_time || null,
        to_time: dayLeave.to_time || null,
        hours: dayLeave.hours || 0,
      } : null,
    });
  }

  // Short leave summary — count and sum hours across this month's
  // approved short_leave entries. Mam: 'not like which I fill shortleave
  // mins/hours according to month current'.
  const shortLeaves = leaves.filter(l => l.leave_type === 'short_leave');
  const shortLeaveCount = shortLeaves.length;
  const shortLeaveHours = shortLeaves.reduce((s, l) => s + (+l.hours || 0), 0);

  // Current-week summary (Mon-Sun of the week containing today). If the user
  // is viewing a different month via ?month=, still compute the week relative
  // to today so the "this week" section always reflects reality.
  const weekStart = new Date(); // today
  // Start week on Monday: shift back to most recent Monday
  const dow = weekStart.getDay(); // 0 Sun..6 Sat
  const shift = (dow === 0 ? 6 : dow - 1); // days since Monday
  weekStart.setDate(weekStart.getDate() - shift);
  weekStart.setHours(0, 0, 0, 0);
  const weekStartStr = weekStart.toISOString().slice(0, 10);
  const weekEndDate = new Date(weekStart);
  weekEndDate.setDate(weekEndDate.getDate() + 6);
  const weekEndStr = weekEndDate.toISOString().slice(0, 10);

  const weekAttendance = db.prepare(
    'SELECT date, status, total_hours FROM attendance WHERE user_id=? AND date BETWEEN ? AND ?'
  ).all(req.user.id, weekStartStr, weekEndStr);
  const weekLeaves = db.prepare(
    `SELECT from_date, to_date FROM leave_requests
     WHERE user_id=? AND status='approved' AND NOT (to_date < ? OR from_date > ?)`
  ).all(req.user.id, weekStartStr, weekEndStr);
  const weekSummary = { present: 0, late: 0, half_day: 0, short_day: 0, absent: 0, on_leave: 0, weekend: 0, future: 0, total_hours: 0 };
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart); d.setDate(d.getDate() + i);
    const ds = d.toISOString().slice(0, 10);
    const dObj = new Date(ds);
    const isWeekend = d.getDay() === 0;
    const att = weekAttendance.find(a => a.date === ds);
    const leave = weekLeaves.find(l => ds >= l.from_date && ds <= l.to_date);
    let status;
    if (att) { status = att.status; weekSummary.total_hours += +att.total_hours || 0; }
    else if (leave) status = 'on_leave';
    else if (isWeekend) status = 'weekend';
    else if (dObj > todayObj) status = 'future';
    else status = 'absent';
    if (weekSummary[status] !== undefined) weekSummary[status]++;
  }
  weekSummary.total_hours = Math.round(weekSummary.total_hours * 100) / 100;

  res.json({
    month: `${year}-${pad(month)}`,
    days,
    summary: {
      ...byStatus,
      total_hours: Math.round(totalHours * 100) / 100,
      short_leave_count: shortLeaveCount,
      short_leave_hours: Math.round(shortLeaveHours * 100) / 100,
    },
    week: {
      start: weekStartStr,
      end: weekEndStr,
      summary: weekSummary,
    },
    leaves,
  });
});

// GET the logged-in user's OWN attendance over a start→end date range
// (mam 2026-06-12: "someone show their own previous attendance ... start to
// end date").  Self-service — no admin permission needed; always scoped to
// req.user.id so a user can only ever see their own rows.  Silent auto-mark
// allow-list rows stay hidden, same as /my-today and /my-month.
router.get('/my-history', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const ok = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  let from = ok(req.query.from) ? req.query.from : today;
  let to   = ok(req.query.to)   ? req.query.to   : today;
  if (from > to) { const t = from; from = to; to = t; }   // tolerate swapped range
  const rows = db.prepare(
    `SELECT * FROM attendance
       WHERE user_id=? AND date BETWEEN ? AND ?
         AND NOT (COALESCE(admin_marked,0)=1 AND COALESCE(remarks,'')='Auto-marked (allow-list)')
       ORDER BY date DESC, punch_in_time DESC`
  ).all(req.user.id, from, to);
  res.json(rows);
});

// GET attendance list (admin view) with filters
router.get('/', requirePermission('attendance', 'view'), (req, res) => {
  const { date, user_id, status, date_from, date_to } = req.query;
  // COALESCE to the snapshot so a deleted user's KEPT attendance rows still
  // show who they belonged to (user_id is nulled on force-delete but the name
  // snapshot stays) — mam 2026-07-06 "old attendance data don't delete".
  let sql = `SELECT a.*, COALESCE(u.name, a.user_name_snapshot) as user_name, u.department, u.phone FROM attendance a LEFT JOIN users u ON a.user_id=u.id WHERE 1=1`;
  const params = [];
  if (date) { sql += ' AND a.date=?'; params.push(date); }
  if (user_id) { sql += ' AND a.user_id=?'; params.push(user_id); }
  if (status) { sql += ' AND a.status=?'; params.push(status); }
  if (date_from) { sql += ' AND a.date >= ?'; params.push(date_from); }
  if (date_to) { sql += ' AND a.date <= ?'; params.push(date_to); }
  sql += ' ORDER BY a.date DESC, a.punch_in_time DESC';
  res.json(getDb().prepare(sql).all(...params));
});

// GET admin dashboard stats
// Auto-mark today's allow-list users as present (admin_marked=1) so they
// don't show up in the 'Not Punched In Today' panel. Idempotent — only
// inserts where no row exists for the user today. Called lazily from the
// admin dashboard so we don't need a cron.
function syncAutoMarkPresent(db, today, byUserId) {
  try {
    const list = db.prepare("SELECT id FROM users WHERE active=1 AND COALESCE(auto_mark_present,0)=1").all();
    if (!list.length) return;
    const exists = db.prepare('SELECT 1 FROM attendance WHERE user_id=? AND date=?');
    const insert = db.prepare(
      `INSERT INTO attendance (user_id, date, status, admin_marked, marked_by, total_hours, remarks)
       VALUES (?,?,?,1,?,?,?)`
    );
    for (const u of list) {
      if (exists.get(u.id, today)) continue;
      insert.run(u.id, today, 'present', byUserId || null, 8, 'Auto-marked (allow-list)');
    }
  } catch (e) { /* never block dashboard on this */ }
}

router.get('/dashboard', requirePermission('attendance', 'view'), (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  // Auto-mark allow-list before computing today's stats.
  syncAutoMarkPresent(db, today, req.user.id);
  const totalUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE active=1").get();
  // Count admin-marked rows as present too — they're a deliberate override
  // by admin / HR for users who didn't punch.
  const presentToday = db.prepare(
    "SELECT COUNT(DISTINCT user_id) as c FROM attendance WHERE date=? AND (punch_in_time IS NOT NULL OR COALESCE(admin_marked,0)=1)"
  ).get(today);
  const absentToday = totalUsers.c - presentToday.c;
  const lateToday = db.prepare("SELECT COUNT(*) as c FROM attendance WHERE date=? AND status='late'").get(today);
  const onLeave = db.prepare("SELECT COUNT(*) as c FROM leave_requests WHERE status='approved' AND from_date <= ? AND to_date >= ?").get(today, today);

  const todayRecords = db.prepare(`SELECT a.*, u.name as user_name, u.department FROM attendance a
    LEFT JOIN users u ON a.user_id=u.id WHERE a.date=? ORDER BY a.punch_in_time DESC`).all(today);

  // Users who haven't punched in. Keep only real integer ids — a stray
  // NULL user_id would otherwise produce `IN (5,,8)` and 500 the dashboard.
  const punchedUserIds = todayRecords.map(r => r.user_id).filter(id => Number.isInteger(id));
  const notPunched = db.prepare(`SELECT id, name, department, phone FROM users WHERE active=1 ${punchedUserIds.length > 0 ? 'AND id NOT IN (' + punchedUserIds.join(',') + ')' : ''}`).all();

  // Geofence settings
  const geofences = db.prepare('SELECT * FROM geofence_settings WHERE active=1').all();

  res.json({
    totalUsers: totalUsers.c, present: presentToday.c, absent: absentToday, late: lateToday.c, onLeave: onLeave.c,
    todayRecords, notPunched, geofences
  });
});

// ADMIN MARK PRESENT — admin override for users who didn't punch (phone
// dead / no network / forgot). Creates an attendance row flagged
// admin_marked=1 so the user's own dashboard / month view skips it.
// Restricted to admins or roles with attendance.approve.
router.post('/admin-mark', (req, res) => {
  const { user_id, date, status, remarks } = req.body;
  if (!user_id || !date) return res.status(400).json({ error: 'user_id and date are required' });

  // Admin may backfill any PAST date, but never a future one.
  const todayStr = new Date().toISOString().split('T')[0];
  if (date > todayStr) return res.status(400).json({ error: 'Cannot mark a future date' });

  // Permission gate: admin OR a role with attendance.approve
  const db = getDb();
  if (req.user.role !== 'admin') {
    const ok = db.prepare(`
      SELECT MAX(CASE WHEN rp.can_approve = 1 THEN 1 ELSE 0 END) as ok
      FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = ? AND rp.module = 'attendance'
    `).get(req.user.id);
    if (!ok?.ok) return res.status(403).json({ error: 'Forbidden' });
  }

  // "clear" removes an admin mark, reverting the day to no-record (implicit
  // absent / whatever the punch was).  Never touches a real punch row.
  if (status === 'clear') {
    const ex = db.prepare('SELECT id, admin_marked FROM attendance WHERE user_id=? AND date=?').get(user_id, date);
    if (ex && ex.admin_marked) db.prepare('DELETE FROM attendance WHERE id=?').run(ex.id);
    return res.json({ message: 'Cleared' });
  }
  const finalStatus = ['present','half_day','short_day','absent','leave','holiday'].includes(status) ? status : 'present';

  // If a real attendance row already exists (user actually punched), don't
  // overwrite it. Admin-mark is meant for the missing-row case only.
  const existing = db.prepare('SELECT id, admin_marked FROM attendance WHERE user_id=? AND date=?').get(user_id, date);
  if (existing && !existing.admin_marked) {
    return res.status(400).json({ error: 'User already has an attendance record for this date' });
  }
  if (existing && existing.admin_marked) {
    db.prepare(
      `UPDATE attendance SET status=?, remarks=?, marked_by=? WHERE id=?`
    ).run(finalStatus, remarks || null, req.user.id, existing.id);
    return res.json({ message: 'Updated', id: existing.id });
  }

  const r = db.prepare(
    `INSERT INTO attendance (user_id, date, status, remarks, admin_marked, marked_by, total_hours)
     VALUES (?,?,?,?,1,?, ?)`
  ).run(user_id, date, finalStatus, remarks || null, req.user.id, finalStatus === 'half_day' ? 4 : finalStatus === 'present' ? 8 : 0);
  res.status(201).json({ id: r.lastInsertRowid, message: 'Marked' });
});

// ── Monthly Attendance Grid (mam 2026-06-13: "make automatic salary") ────
// Admin marks present/absent/half/leave for everyone in one screen so the
// no-punch days that drag payroll down get corrected fast.  All writes go
// through admin-mark (admin_marked=1) so real punches are never overwritten.

// Admin OR attendance.approve may use the grid.
function canMarkAttendance(db, req) {
  if (req.user.role === 'admin') return true;
  try {
    const ok = db.prepare(`
      SELECT MAX(CASE WHEN rp.can_approve = 1 THEN 1 ELSE 0 END) AS ok
      FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = ? AND rp.module = 'attendance'`).get(req.user.id);
    return !!ok?.ok;
  } catch { return false; }
}
const gpad = n => String(n).padStart(2, '0');

// GET /attendance/grid?month=YYYY-MM — per-employee per-day status for the
// month, plus the "no login linked" employees with suggested user matches.
router.get('/grid', (req, res) => {
  const db = getDb();
  if (!canMarkAttendance(db, req)) return res.status(403).json({ error: 'Forbidden' });
  const month = String(req.query.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const start = `${month}-01`, end = `${month}-${gpad(lastDay)}`;
  const todayStr = new Date(new Date().getTime() + 5.5 * 3600 * 1000).toISOString().split('T')[0]; // IST today

  const days = [];
  for (let d = 1; d <= lastDay; d++) {
    const dateStr = `${month}-${gpad(d)}`;
    const dow = new Date(y, m - 1, d).getDay();
    days.push({ date: dateStr, d, dow, sunday: dow === 0, future: dateStr > todayStr });
  }

  const employees = db.prepare(
    `SELECT id, name, user_id FROM employees WHERE (status IS NULL OR status='active') ORDER BY name`
  ).all();
  const activeUsers = db.prepare(`SELECT id, name FROM users WHERE active=1`).all();
  const usersById = new Map(activeUsers.map(u => [u.id, u]));
  const linkedUserIds = new Set(employees.map(e => e.user_id).filter(Boolean));
  const tokens = s => String(s || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const suggestFor = (name) => {
    const set = new Set(tokens(name)); const first = [...set][0] || '';
    return activeUsers
      .filter(u => !linkedUserIds.has(u.id))
      .map(u => ({ u, overlap: tokens(u.name).filter(t => set.has(t)).length, first: tokens(u.name)[0] === first }))
      .filter(c => c.overlap > 0 || c.first)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 4)
      .map(c => ({ user_id: c.u.id, name: c.u.name }));
  };

  const userIds = [...linkedUserIds];
  let attByUserDate = new Map(), leavesByUser = new Map();
  if (userIds.length) {
    const ph = userIds.map(() => '?').join(',');
    for (const a of db.prepare(
      `SELECT user_id, date, status, admin_marked, punch_in_time FROM attendance
        WHERE user_id IN (${ph}) AND date BETWEEN ? AND ?`).all(...userIds, start, end)) {
      attByUserDate.set(`${a.user_id}|${a.date}`, a);
    }
    for (const lr of db.prepare(
      `SELECT user_id, leave_type, from_date, to_date FROM leave_requests
        WHERE status='approved' AND user_id IN (${ph}) AND NOT (to_date < ? OR from_date > ?)`).all(...userIds, start, end)) {
      if (!leavesByUser.has(lr.user_id)) leavesByUser.set(lr.user_id, []);
      leavesByUser.get(lr.user_id).push(lr);
    }
  }

  const rows = employees.map(e => {
    const cells = {};
    if (e.user_id) {
      const leaves = leavesByUser.get(e.user_id) || [];
      for (const day of days) {
        const att = attByUserDate.get(`${e.user_id}|${day.date}`);
        let status = '', source = '';
        if (att) {
          status = String(att.status || '').toLowerCase();
          source = att.admin_marked ? 'admin' : 'punch';
        } else if (leaves.some(l => day.date >= l.from_date && day.date <= l.to_date)) {
          status = 'leave'; source = 'leave';
        } else if (day.sunday) {
          status = 'sunday'; source = 'auto';
        } else if (!day.future) {
          status = 'absent'; source = 'implicit';
        } else {
          status = ''; source = 'future';
        }
        cells[day.date] = { status, source };
      }
    }
    return {
      employee_id: e.id,
      name: e.name,
      user_id: e.user_id || null,
      no_login: !e.user_id,
      suggestions: e.user_id ? [] : suggestFor(e.name),
      cells,
    };
  });

  res.json({ month, today: todayStr, days, employees: rows });
});

// POST /attendance/admin-mark-bulk — mark every BLANK (no record) non-Sunday
// past day of a month for one user as `status` (default present).  The fast
// "mark this person present for the month" button.
router.post('/admin-mark-bulk', (req, res) => {
  const db = getDb();
  if (!canMarkAttendance(db, req)) return res.status(403).json({ error: 'Forbidden' });
  const { user_id, month } = req.body;
  if (!user_id || !/^\d{4}-\d{2}$/.test(String(month || ''))) return res.status(400).json({ error: 'user_id and month=YYYY-MM required' });
  const status = ['present', 'half_day', 'absent'].includes(req.body.status) ? req.body.status : 'present';
  const [y, m] = String(month).split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const todayStr = new Date(new Date().getTime() + 5.5 * 3600 * 1000).toISOString().split('T')[0];
  const existing = new Set(
    db.prepare(`SELECT date FROM attendance WHERE user_id=? AND date BETWEEN ? AND ?`)
      .all(user_id, `${month}-01`, `${month}-${gpad(lastDay)}`).map(r => r.date)
  );
  const ins = db.prepare(
    `INSERT INTO attendance (user_id, date, status, admin_marked, marked_by, total_hours) VALUES (?,?,?,1,?,?)`
  );
  const hrs = status === 'half_day' ? 4 : status === 'present' ? 8 : 0;
  let marked = 0;
  const tx = db.transaction(() => {
    for (let d = 1; d <= lastDay; d++) {
      const dateStr = `${month}-${gpad(d)}`;
      if (dateStr > todayStr) continue;
      if (new Date(y, m - 1, d).getDay() === 0) continue;   // skip Sundays (auto-paid)
      if (existing.has(dateStr)) continue;                  // never overwrite a punch/admin row
      ins.run(user_id, dateStr, status, req.user.id, hrs);
      marked++;
    }
  });
  tx();
  res.json({ message: `Marked ${marked} day(s)`, marked });
});

// POST /attendance/link-login — link an employee to a login user so their
// attendance can be read (fixes the "⚠ no login" near-zero salaries).
router.post('/link-login', (req, res) => {
  const db = getDb();
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const employee_id = +req.body.employee_id, user_id = +req.body.user_id;
  if (!employee_id || !user_id) return res.status(400).json({ error: 'employee_id and user_id required' });
  const emp = db.prepare('SELECT id FROM employees WHERE id=?').get(employee_id);
  const usr = db.prepare('SELECT id, name FROM users WHERE id=?').get(user_id);
  if (!emp || !usr) return res.status(404).json({ error: 'Employee or user not found' });
  db.prepare('UPDATE employees SET user_id=? WHERE id=?').run(user_id, employee_id);
  res.json({ message: `Linked to ${usr.name}`, user_id });
});

// PUNCH IN
router.post('/punch-in', (req, res) => {
  const { latitude, longitude, address, photo, site_name } = req.body;
  if (!latitude || !longitude) return res.status(400).json({ error: 'Location required. Please enable GPS.' });

  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();

  // Check if already punched in today
  const existing = db.prepare('SELECT id FROM attendance WHERE user_id=? AND date=?').get(req.user.id, today);
  if (existing) return res.status(400).json({ error: 'Already punched in today' });

  // Check geofence — MANDATORY, must be inside a site area. The decision is
  // delegated to the shared, uncertainty-honest rule in lib/geofence.js:
  // a weak indoor phone-GPS fix can NEVER block someone who might be on-site;
  // only a GOOD GPS lock that is confidently outside is rejected. Coarse fixes
  // are allowed but tagged location_verified=0 for admin audit.
  const geofences = db.prepare('SELECT * FROM geofence_settings WHERE active=1').all();
  if (geofences.length === 0) {
    return res.status(400).json({ error: 'No site locations configured. Contact admin to add geofence areas.' });
  }
  const accuracy = +req.body?.accuracy || 0;
  const geo = evaluateGeofence(latitude, longitude, accuracy, geofences, geoSettings(db));
  if (!geo.allow) {
    // Only reached on a trustworthy GPS lock that is genuinely off-site, so the
    // distance we quote is real (no more false "you are 3km away" on weak GPS).
    return res.status(400).json({
      error: `You appear to be about ${geo.nearestDist}m from the nearest site (${geo.nearestSite}). Your GPS lock is precise (±${geo.accuracyUsed}m), so this reads as off-site. Go to your assigned site to punch in, or ask your admin to mark you present.`,
      distance_m: geo.nearestDist, nearest_site: geo.nearestSite,
    });
  }
  const matchedSite = geo.matchedSite || site_name || geo.nearestSite || '';

  // Check if late — uses IST timezone + payroll_settings.late_after_time.
  // Fixes the UTC-vs-IST bug where 10:23 IST (04:53 UTC) was treated as
  // not-late because getHours() on UTC-running VPS returned 4.
  const isLate = isPunchLate(db, now);

  const r = db.prepare(`INSERT INTO attendance (user_id, date, punch_in_time, punch_in_lat, punch_in_lng, punch_in_address, punch_in_photo, site_name, status, punch_in_accuracy, location_verified)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(req.user.id, today, now, latitude, longitude, address, photo, matchedSite, isLate ? 'late' : 'present', accuracy || null, geo.verified);

  res.status(201).json({
    id: r.lastInsertRowid,
    message: isLate ? 'Punched In (Late)' : 'Punched In',
    site: matchedSite, isLate,
    location_verified: !!geo.verified,
    // When the fix was too weak to confirm, tell the user it was recorded for
    // review rather than silently passing — keeps it honest both ways.
    note: geo.verified ? undefined : 'Location could not be precisely verified (weak GPS) — punch recorded and flagged for admin review.',
  });
});

// PUNCH OUT
router.post('/punch-out', (req, res) => {
  const { latitude, longitude, address, photo } = req.body;
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();

  const record = db.prepare('SELECT * FROM attendance WHERE user_id=? AND date=?').get(req.user.id, today);
  if (!record) return res.status(400).json({ error: 'You have not punched in today' });
  if (record.punch_out_time) return res.status(400).json({ error: 'Already punched out today' });

  // PUNCH-OUT GEOFENCE (mam, 2026-05-16: "out attendance ... punch out is
  // also need according to geofencing"). Same uncertainty-honest rule as
  // punch-in: a weak fix never blocks an on-site person; only a precise lock
  // that is confidently off-site is rejected. No permissive walk-away
  // allowance — if staff want to step off-site they punch out FIRST.
  if (latitude == null || longitude == null) {
    return res.status(400).json({ error: 'Location required to punch out.' });
  }
  const accuracy = +req.body?.accuracy || 0;
  {
    const geofences = db.prepare('SELECT * FROM geofence_settings WHERE active=1').all();
    if (geofences.length === 0) {
      return res.status(400).json({ error: 'No site locations configured. Contact admin.' });
    }
    const geo = evaluateGeofence(latitude, longitude, accuracy, geofences, geoSettings(db));
    if (!geo.allow) {
      return res.status(400).json({
        error: `Punch-out blocked: GPS shows you about ${geo.nearestDist}m from the nearest site (${geo.nearestSite}) with a precise lock (±${geo.accuracyUsed}m). Go back to site to punch out, or ask your admin.`,
        distance_m: geo.nearestDist,
        nearest_site: geo.nearestSite,
      });
    }
  }

  // Calculate total hours
  const punchIn = new Date(record.punch_in_time);
  const punchOut = new Date(now);
  const totalHours = Math.round((punchOut - punchIn) / (1000 * 60 * 60) * 100) / 100;
  const status = totalHours < 4 ? 'half_day' : record.status;

  db.prepare(`UPDATE attendance SET punch_out_time=?, punch_out_lat=?, punch_out_lng=?, punch_out_address=?, punch_out_photo=?, total_hours=?, status=?, punch_out_accuracy=? WHERE id=?`)
    .run(now, latitude, longitude, address, photo, totalHours, status, accuracy || null, record.id);

  res.json({ message: `Punched Out. Total: ${totalHours} hours`, totalHours });
});

// Live location tracking — site engineer sends location periodically.
// GPS accuracy buffer: phone GPS readings can be off by 50-200m+ indoors
// or under cloud cover. Without a buffer, users physically on site
// frequently get tagged "Outside" because the noisy GPS pin lands just
// past the geofence radius. We subtract the reported accuracy from the
// haversine distance — i.e. if dist=250m, accuracy=100m, radius=200m,
// the true position could be anywhere from 150m to 350m away, so we give
// the benefit of the doubt and treat it as inside (150 <= 200).
router.post('/track-location', (req, res) => {
  const { latitude, longitude, address, accuracy, gps_off, reason } = req.body;
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();

  // Heartbeat with gps_off=true → user is online (page is open, network
  // alive) but their browser couldn't get a GPS fix. Mam: 'can show me
  // here like some off GPS even network is good'. Stored with NULL
  // lat/lng + site_name='GPS_OFF' so the admin Location Tracking page
  // can surface them as a distinct red card.
  if (gps_off) {
    db.prepare('INSERT INTO location_tracking (user_id, date, time, latitude, longitude, address, site_name) VALUES (?,?,?,NULL,NULL,?,?)')
      .run(req.user.id, today, now, reason || null, 'GPS_OFF');
    return res.json({ site: 'GPS_OFF', recorded: true });
  }

  if (!latitude || !longitude) return res.status(400).json({ error: 'Location required' });
  const geofences = db.prepare('SELECT * FROM geofence_settings WHERE active=1').all();
  // Same uncertainty-honest rule as the punch endpoints so the live map and the
  // punch UI agree. We mark the ping as on-site only when the GPS uncertainty
  // actually overlaps a site (decision='inside'); a coarse fix that can't be
  // confirmed shows as 'Outside' on the admin map (honest "unconfirmed").
  const geo = geofences.length ? evaluateGeofence(latitude, longitude, accuracy, geofences, geoSettings(db)) : null;
  const siteName = geo && geo.decision === 'inside' ? geo.matchedSite : 'Outside';
  db.prepare('INSERT INTO location_tracking (user_id, date, time, latitude, longitude, address, site_name) VALUES (?,?,?,?,?,?,?)')
    .run(req.user.id, today, now, latitude, longitude, address, siteName);
  res.json({ site: siteName });
});

// GET location history for a user (admin)
router.get('/track/:userId/:date', requirePermission('attendance', 'view'), (req, res) => {
  res.json(getDb().prepare('SELECT * FROM location_tracking WHERE user_id=? AND date=? ORDER BY time').all(req.params.userId, req.params.date));
});

// GET geofence settings
// Shared READ — EVERY employee's punch screen needs the site list to show the
// geofence status; gating it behind attendance:view made non-admin staff get a
// 403 → empty list → the false "No site locations configured" warning even when
// standing in the office (mam 2026-07-01). Only authenticated; edits (POST/PUT/
// DELETE below) stay permission-gated.
router.get('/geofence', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM geofence_settings ORDER BY site_name').all());
});

// GEOFENCE AUDIT — mam (2026-05-16): "just a audit our staff says we
// are away from office 3km attendance is punched is it true?"
//
// For every attendance row in the requested date range, compute the
// distance from punch_in (and punch_out) coordinates to the NEAREST
// active geofence.  Flag rows where punch was outside the geofence
// radius.  Returns:
//   - violations[] — rows where distance > radius (with how far)
//   - allowed_buffer_explanation — server allows up to +500m via the
//     GPS-accuracy buffer at punch-in; punch-out has NO geofence
//     check at all (potential abuse vector)
//   - totals — counts by category for the period
//
// Default range: last 30 days.  Admin only.
//
// URL: /attendance/audit/geofence-violations?from=YYYY-MM-DD&to=YYYY-MM-DD
//      /attendance/audit/geofence-violations?days=7
router.get('/audit/geofence-violations', requirePermission('attendance', 'view'), (req, res) => {
  const db = getDb();
  // Admin / can-see-all only — never let a normal employee scan
  // colleagues' coordinates.
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  let { from, to, days } = req.query;
  if (!from || !to) {
    const d = +days > 0 ? +days : 30;
    const end = new Date();
    const start = new Date(); start.setDate(start.getDate() - d);
    from = start.toISOString().slice(0, 10);
    to   = end.toISOString().slice(0, 10);
  }

  const geofences = db.prepare('SELECT * FROM geofence_settings WHERE active=1').all();
  if (geofences.length === 0) {
    return res.json({ from, to, geofences: [], rows: [], violations: [], note: 'No active geofences configured.' });
  }

  const rows = db.prepare(`
    SELECT a.id, a.user_id, a.date, a.punch_in_time, a.punch_out_time,
           a.punch_in_lat, a.punch_in_lng, a.punch_in_address,
           a.punch_out_lat, a.punch_out_lng, a.punch_out_address,
           a.punch_in_accuracy, a.punch_out_accuracy, a.location_verified,
           a.site_name, a.status,
           u.name as employee_name
    FROM attendance a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.date BETWEEN ? AND ?
    ORDER BY a.date DESC, a.punch_in_time DESC
  `).all(from, to);

  // For each row, find distance to nearest geofence at IN and OUT
  const enrich = (lat, lng) => {
    if (lat == null || lng == null) return { nearest_site: null, distance_m: null };
    let best = { dist: Infinity, site: null };
    for (const gf of geofences) {
      const d = haversine(+lat, +lng, gf.latitude, gf.longitude);
      if (d < best.dist) { best = { dist: d, site: gf.site_name }; }
    }
    return { nearest_site: best.site, distance_m: Math.round(best.dist) };
  };
  const radius = geofences[0]?.radius_meters || 200;
  const { trust } = geoSettings(db);

  // A row is a REAL off-site violation only when the fix was a precise GPS lock
  // (accuracy <= trust) AND the distance is beyond the geofence radius. A weak
  // fix (accuracy > trust, or unknown on historical rows) is NOT a violation —
  // it's surfaced as "unverified" so admin can eyeball the selfie instead.
  const isOutside = (distance_m, accuracy) => {
    if (distance_m == null) return false;
    if (accuracy != null) return accuracy <= trust && distance_m > radius;
    return distance_m > radius + 500; // historical rows w/o stored accuracy: old buffer
  };

  const enriched = rows.map(r => {
    const inInfo  = enrich(r.punch_in_lat,  r.punch_in_lng);
    const outInfo = enrich(r.punch_out_lat, r.punch_out_lng);
    const punchInOutside  = isOutside(inInfo.distance_m,  r.punch_in_accuracy);
    const punchOutOutside = isOutside(outInfo.distance_m, r.punch_out_accuracy);
    return {
      id: r.id,
      date: r.date,
      employee: r.employee_name || `user#${r.user_id}`,
      site_assigned: r.site_name,
      location_verified: r.location_verified == null ? null : !!r.location_verified,
      punch_in: {
        time: r.punch_in_time,
        lat: r.punch_in_lat, lng: r.punch_in_lng,
        address: r.punch_in_address,
        accuracy_m: r.punch_in_accuracy != null ? Math.round(r.punch_in_accuracy) : null,
        nearest_site: inInfo.nearest_site,
        distance_m: inInfo.distance_m,
        outside_geofence: punchInOutside,
        beyond_3km: inInfo.distance_m != null && inInfo.distance_m > 3000,
      },
      punch_out: r.punch_out_time ? {
        time: r.punch_out_time,
        lat: r.punch_out_lat, lng: r.punch_out_lng,
        address: r.punch_out_address,
        accuracy_m: r.punch_out_accuracy != null ? Math.round(r.punch_out_accuracy) : null,
        nearest_site: outInfo.nearest_site,
        distance_m: outInfo.distance_m,
        outside_geofence: punchOutOutside,
        beyond_3km: outInfo.distance_m != null && outInfo.distance_m > 3000,
      } : null,
    };
  });

  const violations = enriched.filter(r =>
    r.punch_in.outside_geofence || r.punch_in.beyond_3km ||
    (r.punch_out && (r.punch_out.outside_geofence || r.punch_out.beyond_3km))
  );
  // Punches allowed despite a weak/unconfirmed GPS fix — review the selfie.
  const unverified = enriched.filter(r => r.location_verified === false);

  res.json({
    from, to,
    geofence_radius_meters: radius,
    geofence_trust_accuracy_m: trust,
    geofence_count: geofences.length,
    geofences: geofences.map(g => ({ site_name: g.site_name, lat: g.latitude, lng: g.longitude, radius_m: g.radius_meters })),
    totals: {
      total_attendance_rows: enriched.length,
      punch_in_outside_geofence: enriched.filter(r => r.punch_in.outside_geofence).length,
      punch_in_beyond_3km:       enriched.filter(r => r.punch_in.beyond_3km).length,
      punch_out_outside_geofence: enriched.filter(r => r.punch_out?.outside_geofence).length,
      punch_out_beyond_3km:       enriched.filter(r => r.punch_out?.beyond_3km).length,
      location_unverified:        unverified.length,
    },
    enforcement_notes: {
      rule: `Uncertainty-honest (from 2026-06-29). A punch is INSIDE when distance - GPS_accuracy <= radius (${radius}m). Staff are only BLOCKED when a precise GPS lock (accuracy <= ${trust}m) puts them confidently outside. Weak/coarse fixes are allowed but tagged location_verified=0 for review — they CANNOT falsely block an on-site person.`,
      punch_out: 'Same uncertainty-honest rule as punch-in (strict-but-fair). Server rejects with 400 only on a precise off-site lock.',
      gps_spoof: 'A user with mock-location apps can fake their coordinates. This audit catches obvious cases (large distance with a precise lock) but cannot detect a well-crafted spoof reporting site lat/lng directly. The selfie is the backstop.',
    },
    violations,
    unverified,
  });
});

// POST add geofence
router.post('/geofence', requirePermission('attendance', 'create'), (req, res) => {
  const { site_name, latitude, longitude, radius_meters } = req.body;
  if (!latitude || !longitude || !site_name) return res.status(400).json({ error: 'Site name and location required' });
  const r = getDb().prepare('INSERT INTO geofence_settings (site_name, latitude, longitude, radius_meters) VALUES (?,?,?,?)')
    .run(site_name, latitude, longitude, radius_meters || 200);
  res.status(201).json({ id: r.lastInsertRowid });
});

// PUT edit geofence
router.put('/geofence/:id', requirePermission('attendance', 'edit'), (req, res) => {
  const { site_name, latitude, longitude, radius_meters, active } = req.body;
  getDb().prepare('UPDATE geofence_settings SET site_name=?, latitude=?, longitude=?, radius_meters=?, active=? WHERE id=?')
    .run(site_name, latitude, longitude, radius_meters || 200, active !== undefined ? (active ? 1 : 0) : 1, req.params.id);
  res.json({ message: 'Updated' });
});

// DELETE geofence
router.delete('/geofence/:id', requirePermission('attendance', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM geofence_settings WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// GET monthly report
router.get('/report', requirePermission('attendance', 'view'), (req, res) => {
  const { month, year } = req.query;
  const m = month || (new Date().getMonth() + 1);
  const y = year || new Date().getFullYear();
  const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
  const endDate = `${y}-${String(m).padStart(2, '0')}-31`;

  const report = getDb().prepare(`SELECT u.id as user_id, u.name, u.department,
    COUNT(CASE WHEN a.status='present' THEN 1 END) as present_days,
    COUNT(CASE WHEN a.status='late' THEN 1 END) as late_days,
    COUNT(CASE WHEN a.status='half_day' THEN 1 END) as half_days,
    COUNT(CASE WHEN a.status='absent' THEN 1 END) as absent_days,
    ROUND(AVG(a.total_hours),1) as avg_hours
    FROM users u LEFT JOIN attendance a ON u.id=a.user_id AND a.date BETWEEN ? AND ?
    WHERE u.active=1 GROUP BY u.id ORDER BY u.name`).all(startDate, endDate);

  res.json(report);
});

// Leave requests (with short leave timing + monthly 4hr limit)
router.post('/leave', (req, res) => {
  const { leave_type, from_date, to_date, from_time, to_time, reason } = req.body;
  if (!from_date) return res.status(400).json({ error: 'Date required' });
  const db = getDb();

  let days = 1;
  let hours = 0;
  if (leave_type === 'short_leave') {
    if (!from_time || !to_time) return res.status(400).json({ error: 'Time required for short leave' });
    // Calculate hours
    const [fh, fm] = from_time.split(':').map(Number);
    const [th, tm] = to_time.split(':').map(Number);
    hours = (th + tm / 60) - (fh + fm / 60);
    if (hours <= 0) return res.status(400).json({ error: 'Invalid time range' });

    // Check monthly limit (4 hours)
    const monthStart = from_date.substring(0, 7) + '-01';
    const monthEnd = from_date.substring(0, 7) + '-31';
    const used = db.prepare("SELECT COALESCE(SUM(hours),0) as total FROM leave_requests WHERE user_id=? AND leave_type='short_leave' AND status != 'rejected' AND from_date BETWEEN ? AND ?")
      .get(req.user.id, monthStart, monthEnd);
    if ((used.total + hours) > 4) {
      return res.status(400).json({ error: `Monthly short leave limit is 4 hours. You have used ${used.total}h. Remaining: ${Math.max(0, 4 - used.total)}h` });
    }
    days = 0;
  } else {
    if (!to_date) return res.status(400).json({ error: 'To date required' });
    days = Math.ceil((new Date(to_date) - new Date(from_date)) / (1000 * 60 * 60 * 24)) + 1;
  }

  const r = db.prepare('INSERT INTO leave_requests (user_id, leave_type, from_date, to_date, days, hours, from_time, to_time, reason) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(req.user.id, leave_type || 'casual', from_date, to_date || from_date, days, hours, from_time, to_time, reason);
  fireEmailEvent('leave.requested', {
    employee: req.user.name || '',
    leave_type: leave_type || 'casual',
    from_date: from_date,
    to_date: to_date || from_date,
    days: String(days),
    reason: reason || '',
    date: new Date().toISOString().slice(0, 10),
    requester_email: req.user.email || atUserEmail(db, req.user.id),
    director_email: atDirector(),
  });
  res.status(201).json({ id: r.lastInsertRowid });
});

router.get('/leaves', requirePermission('attendance', 'view'), (req, res) => {
  // Scope rule: approver / admin sees every leave request. Plain users
  // (no can_approve on attendance) see only their own. Mam toggles this
  // via "approve" checkbox in Roles & Permissions for the role.
  const db = getDb();
  const isAdmin = req.user.role === 'admin';
  const canSeeAll = isAdmin || (() => {
    const r = db.prepare(`
      SELECT MAX(CASE WHEN rp.can_approve = 1 OR rp.can_see_all = 1 THEN 1 ELSE 0 END) as ok
      FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = ? AND rp.module = 'attendance'
    `).get(req.user.id);
    return !!r?.ok;
  })();
  const where = canSeeAll ? '' : 'WHERE lr.user_id = ?';
  const params = canSeeAll ? [] : [req.user.id];
  res.json(db.prepare(`
    SELECT lr.*, u.name as user_name
      FROM leave_requests lr
      LEFT JOIN users u ON lr.user_id=u.id
     ${where}
     ORDER BY lr.created_at DESC
  `).all(...params));
});

router.put('/leave/:id/approve', requirePermission('attendance', 'approve'), (req, res) => {
  const { status, remarks } = req.body;
  const db = getDb();
  db.prepare('UPDATE leave_requests SET status=?, approved_by=?, remarks=? WHERE id=?')
    .run(status, req.user.id, remarks, req.params.id);
  const lr = db.prepare('SELECT lr.user_id, lr.leave_type, u.name FROM leave_requests lr LEFT JOIN users u ON u.id=lr.user_id WHERE lr.id=?').get(req.params.id);
  fireEmailEvent('leave.decided', {
    employee: lr?.name || '',
    leave_type: lr?.leave_type || '',
    status: status || '',
    decided_by: req.user.name || '',
    date: new Date().toISOString().slice(0, 10),
    requester_email: atUserEmail(db, lr?.user_id),
    director_email: atDirector(),
  });
  res.json({ message: `Leave ${status}` });
});

// Full edit — admin / approver fixes typos, wrong dates, wrong hours,
// rounding errors. Mam: 'edit option'. Doesn't change status (use the
// approve route for that).
router.put('/leave/:id', requirePermission('attendance', 'edit'), (req, res) => {
  try {
    const b = req.body;
    const fields = ['leave_type','from_date','to_date','from_time','to_time','days','hours','reason'];
    const sets = []; const vals = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f}=?`); vals.push(b[f]); }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    vals.push(req.params.id);
    getDb().prepare(`UPDATE leave_requests SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/leave/:id', requirePermission('attendance', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM leave_requests WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

router.delete('/:id', requirePermission('attendance', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM attendance WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// -------------------- Auto punch-in / punch-out --------------------
// Runs every 60s. Uses the last 5 minutes of /attendance/track-location
// samples to decide if a user has been continuously inside a geofence
// (→ auto punch-in) or continuously outside all geofences (→ auto
// punch-out). Flag columns let admins spot auto-marked rows.
function runAutoPunchCheck() {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const recentUsers = db.prepare(
    'SELECT DISTINCT user_id FROM location_tracking WHERE date=? AND time >= ?'
  ).all(today, fiveMinAgo);

  for (const { user_id } of recentUsers) {
    const updates = db.prepare(
      'SELECT * FROM location_tracking WHERE user_id=? AND date=? AND time >= ? ORDER BY time DESC'
    ).all(user_id, today, fiveMinAgo);

    if (updates.length < 2) continue; // need at least 2 pings in the window

    const allInside = updates.every(u => u.site_name && u.site_name !== 'Outside');
    const allOutside = updates.every(u => !u.site_name || u.site_name === 'Outside');
    if (!allInside && !allOutside) continue; // mixed — still transitioning

    const attendance = db.prepare('SELECT * FROM attendance WHERE user_id=? AND date=?').get(user_id, today);
    const latest = updates[0];

    if (!attendance && allInside) {
      // Same IST-aware late check as manual punch-in.
      const isLate = isPunchLate(db, now);
      try {
        db.prepare(`INSERT INTO attendance
          (user_id, date, punch_in_time, punch_in_lat, punch_in_lng, punch_in_address, site_name, status, auto_punched_in)
          VALUES (?,?,?,?,?,?,?,?,1)`).run(
          user_id, today, now, latest.latitude, latest.longitude, latest.address || '',
          latest.site_name, isLate ? 'late' : 'present'
        );
        console.log(`[auto-punch] IN user=${user_id} site=${latest.site_name} late=${isLate}`);
      } catch (e) { console.error('[auto-punch] IN failed:', e.message); }
    } else if (attendance && attendance.punch_in_time && !attendance.punch_out_time && allOutside) {
      const punchIn = new Date(attendance.punch_in_time);
      const totalHours = Math.round((new Date(now) - punchIn) / (1000 * 60 * 60) * 100) / 100;
      const status = totalHours < 4 ? 'half_day' : (totalHours < 8 ? 'short_day' : attendance.status);
      try {
        db.prepare(`UPDATE attendance
          SET punch_out_time=?, punch_out_lat=?, punch_out_lng=?, punch_out_address=?,
              total_hours=?, status=?, auto_punched_out=1 WHERE id=?`).run(
          now, latest.latitude, latest.longitude, latest.address || '',
          totalHours, status, attendance.id
        );
        console.log(`[auto-punch] OUT user=${user_id} hours=${totalHours}`);
      } catch (e) { console.error('[auto-punch] OUT failed:', e.message); }
    }
  }
}

// Auto-punch disabled per mam's request (2026-04-23) — every punch must be
// manual + selfie-backed so there's clear accountability. The runAutoPunchCheck
// function above is kept as a reference in case the behaviour is ever wanted
// back; simply re-enable the setInterval below to bring it back.
//
// if (process.env.NODE_ENV !== 'test') {
//   setInterval(() => {
//     try { runAutoPunchCheck(); } catch (e) { console.error('[auto-punch] tick error:', e.message); }
//   }, 60 * 1000);
// }

module.exports = router;
