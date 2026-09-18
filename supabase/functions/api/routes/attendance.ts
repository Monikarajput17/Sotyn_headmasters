// deno-lint-ignore-file no-explicit-any
// Attendance — punch in/out, geofence, leaves, monthly grid, admin marks.
// Ported from server/routes/attendance.js (Phase-3 Postgres version).
import { Router } from "../../_shared/express-lite.ts";
import pg from "../../_shared/pg.ts";
import {calculateAttendanceMonth,resolveDuty,assertOpen,writeLock,hashPayload,AttendanceError} from '../../_shared/attendance-operations.ts';
import {monthDays,jsonValue,validMonth,addDays} from '../../_shared/attendance-engine.ts';
import { scopeSql, branchSql, hasPermission, linkEmployee } from "../../_shared/attendance-access.ts";
import { attendanceGuard } from "../../_shared/attendance-guards.ts";
import { capture, workDate, validDate } from "../../_shared/attendance-capture.ts";
import { authMiddleware, requirePermission } from "../../_shared/auth.ts";
// Shared geofence math + the "is this punch on-site?" decision. Single source
// of truth for punch-in, punch-out, live tracking AND the audit endpoint so
// they can never drift apart. See _shared/lib/geofence.ts for the rule that
// stops weak indoor phone-GPS from falsely blocking on-site staff.
import { evaluateGeofence, geoSettings, haversine } from "../../_shared/lib/geofence.ts";
import { employeeIdForUser, getShiftHistory, lateCutoffMinutes, resolveShift, resolveShiftForDate, weekOffDow } from "../../_shared/lib/shifts.ts";

// ── Deferred integrations (no-op stubs) ─────────────────────────────────────
// The Express server fired email rules (lib/emailRules.fireEmailEvent) and
// looked up the director's address (lib/email.getDirectorEmail) on leave
// events. Outbound email is not wired into the Edge Function yet, so these
// degrade gracefully: the leave flow works, the notification is simply skipped.
const fireEmailEvent = (_event: string, _vars: Record<string, any>) => { /* deferred: email rules */ };
const getDirectorEmail = (): string | null => null; // deferred: lib/email

const atUserEmail = async (id: any) => { try { return (await pg.get("SELECT email FROM users WHERE id=?", id))?.email || null; } catch { return null; } };
const atDirector = () => { try { return getDirectorEmail(); } catch { return null; } };
const router = Router();
router.use(authMiddleware);
router.use(attendanceGuard);
router.get('/tracking-preference',async(req,res)=>{const u=await pg.get('SELECT track_location FROM users WHERE id=?',req.user.id);res.json({enabled:!!u?.track_location});});

// Late detection — cutoff is the punching employee's OWN shift start (as
// effective on the punch date), falling back to payroll_settings.late_after_time
// (admin-tunable global default, 09:46 IST) when that employee has no shift
// configured yet. Returns true if `whenIso` (ISO string in UTC) lies AFTER
// the IST cutoff for that day.
//
// The original implementation called new Date().getHours() which returns
// UTC hours. On a UTC-running VPS this meant 10:23 IST = 04:53 UTC, so
// `4 > 9` was false → no one got flagged late before 15:15 IST. Bug
// affected every attendance row since deploy.
async function isPunchLate(whenIso: string, userId: any) {
  let cutoffMin = 9 * 60 + 46; // default 09:46 IST
  try {
    const ps = await pg.get("SELECT late_after_time FROM payroll_settings WHERE id=1");
    if (ps?.late_after_time) {
      const [h, m] = String(ps.late_after_time).split(":").map(Number);
      cutoffMin = h * 60 + (m || 0);
    }
  } catch { /* stale DB */ }
  // Shift UTC → IST by adding 5h30m, then read 'UTC' hours/minutes from
  // the shifted Date — those values are now the actual IST time-of-day.
  const ist = new Date(new Date(whenIso || Date.now()).getTime() + 5.5 * 60 * 60 * 1000);
  const istMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const dateStr = ist.toISOString().slice(0, 10);
  try {
    const empId = await employeeIdForUser(pg, userId);
    if (empId) {
      const shift = await resolveShiftForDate(pg, empId, dateStr);
      cutoffMin = lateCutoffMinutes(shift, cutoffMin);
    }
  } catch { /* no shift configured */ }
  return istMin > cutoffMin;
}

// GET today's attendance for current user.
// Manual admin back-fills DO show on the user's own view now (mam 2026-05-30:
// "i marked previous attendance but not show") — so a day an admin marked
// present/half-day appears on the employee's calendar. Only the silent
// auto-mark allow-list rows stay hidden (they're a convenience flag, not a
// real presence the user should see).
// Capture locations are read-only employee information, not location maintenance.
// Match the current capture handler's active-zone eligibility without granting edits.
router.get('/my-capture-context',async(req,res)=>{
  const employees=await pg.all('SELECT * FROM employees WHERE user_id=?',req.user.id);
  const open=await pg.get("SELECT date,policy_version_id FROM attendance WHERE user_id=? AND punch_in_time IS NOT NULL AND punch_out_time IS NULL AND COALESCE(capture_state,'open')<>'review_closed' ORDER BY id DESC LIMIT 1",req.user.id);
  const duty=employees.length===1?await resolveDuty(pg,employees[0],open?.date||workDate()):null;
  const policy=jsonValue(open?.policy_version_id?(await pg.get('SELECT rules FROM attendance_policy_versions WHERE id=?',open.policy_version_id))?.rules:duty?.policy?.rules);
  const locations=await pg.all(`SELECT id,site_name,latitude,longitude,radius_meters,active FROM geofence_settings WHERE active=1 ${policy?.location_scope==='branch'?'AND attendance_branch_id=?':''} ORDER BY site_name`,...(policy?.location_scope==='branch'?[employees[0]?.attendance_branch_id||0]:[]));
  res.json({employee_link_ready:employees.length===1,employee_id:employees.length===1?employees[0].id:null,plan:duty?.plan||null,geo_settings:await geoSettings(pg),capture_exception:policy?.capture_exception||'reject',can_start_another_session:!!(policy?.allow_multiple_sessions||duty?.plan?.segments.length>1),
    setup_message:employees.length===0?'Your login is not linked to an employee. Ask the owner to select your login in Employees.':employees.length>1?'Your login is linked to more than one employee. Ask the owner to resolve the duplicate link.':null,
    locations});
});

router.get("/my-today", async (req, res) => {
  try {
    const today = workDate();
    const record = await pg.get(
      `SELECT * FROM attendance WHERE user_id=? AND (date=? OR (punch_in_time IS NOT NULL AND punch_out_time IS NULL AND COALESCE(capture_state,'open')<>'review_closed')) ORDER BY CASE WHEN punch_out_time IS NULL AND punch_in_time IS NOT NULL THEN 0 ELSE 1 END,id DESC LIMIT 1`,req.user.id,today);
    res.json(record || null);
  } catch (e) { res.status(e instanceof AttendanceError?e.status:(e as any).code==='P0001'?409:500).json({ error: (e as Error).message }); }
});

// GET current month's attendance for the logged-in user — used by the
// dashboard card so employees can see their month at a glance. Optional
// query param ?month=YYYY-MM lets them view a different month.
router.get('/my-month',async(req,res)=>{
 try{const employees=await pg.all('SELECT * FROM employees WHERE user_id=?',req.user.id);if(employees.length!==1)return res.status(409).json({error:'Exactly one employee/login link required'});
 const month=req.query.month||workDate().slice(0,7),r=await calculateAttendanceMonth(pg,employees[0],month);
 const days=r.breakdown.map((d:any)=>({...d,status:d.label==='weekly_off'?'weekend':d.label,punch_in_time:d.punch_in,punch_out_time:d.punch_out,total_hours:d.hours}));
 res.json({month,days,summary:{present:days.filter((d:any)=>d.status==='present').length,late:r.late_marks,half_day:r.half_days,absent:r.absent_days,total_hours:r.total_hours,review_required:r.exceptions.length},ready:r.ready,exceptions:r.exceptions});
 }catch(e){res.status(400).json({error:(e as Error).message});}
});

// GET the logged-in user's OWN attendance over a start→end date range
// (mam 2026-06-12: "someone show their own previous attendance ... start to
// end date").  Self-service — no admin permission needed; always scoped to
// req.user.id so a user can only ever see their own rows.  Silent auto-mark
// allow-list rows stay hidden, same as /my-today and /my-month.
router.get("/my-history", async (req, res) => {
  try {
    const today = workDate();
    const ok = (s: any) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
    let from = ok(req.query.from) ? req.query.from : today;
    let to = ok(req.query.to) ? req.query.to : today;
    if (from > to) { const t = from; from = to; to = t; }   // tolerate swapped range
    const rows = await pg.all(
      `SELECT * FROM attendance
         WHERE user_id=? AND date BETWEEN ? AND ?
           AND NOT (COALESCE(admin_marked,0)=1 AND COALESCE(remarks,'')='Auto-marked (allow-list)')
         ORDER BY date DESC, punch_in_time DESC`,
      req.user.id, from, to);
    res.json(rows);
  } catch (e) { res.status(e instanceof AttendanceError?e.status:(e as any).code==='P0001'?409:500).json({ error: (e as Error).message }); }
});

// GET attendance list (admin view) with filters
router.get("/", requirePermission("attendance", "view"), async (req, res) => {
  try {
    const { date, user_id, status, date_from, date_to } = req.query;
    // COALESCE to the snapshot so a deleted user's KEPT attendance rows still
    // show who they belonged to (user_id is nulled on force-delete but the name
    // snapshot stays) — mam 2026-07-06 "old attendance data don't delete".
    let sql = `SELECT a.*, false AS can_delete, COALESCE(u.name, a.user_name_snapshot) as user_name, u.department, u.phone FROM attendance a LEFT JOIN users u ON a.user_id=u.id WHERE ${await scopeSql(req,"attendance","view","a.user_id")}`;
    const params: any[] = [];
    if (date) { sql += " AND a.date=?"; params.push(date); }
    if (user_id) { sql += " AND a.user_id=?"; params.push(user_id); }
    if (status) { sql += " AND a.status=?"; params.push(status); }
    if (date_from) { sql += " AND a.date >= ?"; params.push(date_from); }
    if (date_to) { sql += " AND a.date <= ?"; params.push(date_to); }
    sql += " ORDER BY a.date DESC, a.punch_in_time DESC";
    res.json(await pg.all(sql, ...params));
  } catch (e) { res.status(e instanceof AttendanceError?e.status:(e as any).code==='P0001'?409:500).json({ error: (e as Error).message }); }
});

// Read-only dashboard; attendance exemptions require an explicit authorized write.
router.get("/dashboard", requirePermission("attendance", "view"), async (req, res) => {
  try {
    const today = workDate();

    const totalUsers = await pg.get(`SELECT COUNT(*) as c FROM users WHERE active=1 AND ${await scopeSql(req,"attendance","view","users.id")}`);
    // Count admin-marked rows as present too — they're a deliberate override
    // by admin / HR for users who didn't punch.
    const presentToday = await pg.get(
      `SELECT COUNT(DISTINCT user_id) as c FROM attendance WHERE date=? AND ${await scopeSql(req,"attendance","view","attendance.user_id")} AND (punch_in_time IS NOT NULL OR COALESCE(admin_marked,0)=1)`,
      today);
    const absentToday = totalUsers.c - presentToday.c;
    const lateToday = await pg.get(`SELECT COUNT(*) as c FROM attendance WHERE date=? AND status='late' AND ${await scopeSql(req,"attendance","view","attendance.user_id")}`, today);
    const onLeave = await pg.get(`SELECT COUNT(*) as c FROM leave_requests WHERE status='approved' AND from_date <= ? AND to_date >= ? AND ${await scopeSql(req,"attendance","view","leave_requests.user_id")}`, today, today);

    const todayRecords = await pg.all(`SELECT a.*, u.name as user_name, u.department FROM attendance a
      LEFT JOIN users u ON a.user_id=u.id WHERE a.date=? AND ${await scopeSql(req,"attendance","view","a.user_id")} ORDER BY a.punch_in_time DESC`, today);

    // Users who haven't punched in. Keep only real integer ids — a stray
    // NULL user_id would otherwise produce `IN (5,,8)` and 500 the dashboard.
    const punchedUserIds = todayRecords.map((r: any) => r.user_id).filter((id: any) => Number.isInteger(id));
    const notPunched = await pg.all(`SELECT id, name, department, phone, (id<>${Number(req.user.id)} AND ${await scopeSql(req,'attendance_corrections','approve','users.id')}) AS can_correct FROM users WHERE active=1 AND ${await scopeSql(req,"attendance","view","users.id")} ${punchedUserIds.length > 0 ? "AND id NOT IN (" + punchedUserIds.join(",") + ")" : ""}`);

    // Geofence settings
    const geofences = await pg.all("SELECT * FROM geofence_settings WHERE active=1");

    res.json({
      totalUsers: totalUsers.c, present: presentToday.c, absent: absentToday, late: lateToday.c, onLeave: onLeave.c,
      todayRecords, notPunched, geofences,
    });
  } catch (e) { res.status(e instanceof AttendanceError?e.status:(e as any).code==='P0001'?409:500).json({ error: (e as Error).message }); }
});

// ADMIN MARK PRESENT — admin override for users who didn't punch (phone
// dead / no network / forgot). Creates an attendance row flagged
// admin_marked=1 so the user's own dashboard / month view skips it.
// Restricted to admins or roles with attendance.approve.
router.post('/admin-mark',async(_req,res)=>res.status(409).json({error:'Use Attendance > Requests to submit a reasoned correction for approval. Original records are retained.'}));



// ── Monthly Attendance Grid (mam 2026-06-13: "make automatic salary") ────
// Admin marks present/absent/half/leave for everyone in one screen so the
// no-punch days that drag payroll down get corrected fast.  All writes go
// through admin-mark (admin_marked=1) so real punches are never overwritten.

// Admin OR attendance.approve may use the grid.
const gpad = (n: number) => String(n).padStart(2, "0");

// GET /attendance/grid?month=YYYY-MM — per-employee per-day status for the
// month, plus the "no login linked" employees with suggested user matches.
router.get('/grid',async(req,res)=>{
 try{const month=req.query.month,dates=monthDays(month),today=workDate(),employees=await pg.all(`SELECT * FROM employees WHERE ${await scopeSql(req,'attendance','view','employees.id',true)} ORDER BY name`),rows=[];
 for(const e of employees){const r=await calculateAttendanceMonth(pg,e,month),cells:any={};for(const d of r.breakdown)cells[d.date]={status:d.label,source:'evaluated',pay:d.pay,exceptions:d.exceptions};rows.push({employee_id:e.id,name:e.name,user_id:e.user_id,no_login:!e.user_id,can_correct:false,suggestions:[],cells});}
 res.json({month,today,days:dates.map(date=>({date,d:Number(date.slice(8)),future:date>today,sunday:false})),employees:rows});
 }catch(e){res.status(400).json({error:(e as Error).message});}
});

// POST /attendance/admin-mark-bulk — mark every BLANK (no record) non-Sunday
// past day of a month for one user as `status` (default present).  The fast
// "mark this person present for the month" button.
router.post('/admin-mark-bulk',async(_req,res)=>res.status(409).json({error:'Bulk present backfills are disabled. Use reviewed correction requests; leave and original evidence must be preserved.'}));

// POST /attendance/link-login — link an employee to a login user so their
// attendance can be read (fixes the "⚠ no login" near-zero salaries).
router.post('/link-login',async(req,res)=>{try{
 const employee=await pg.get('SELECT id FROM employees WHERE id=?',req.body.employee_id);
 if(!employee)return res.status(404).json({error:'Employee not found'});
 await pg.tx(t=>linkEmployee(t,Number(req.body.employee_id),Number(req.body.user_id)));
 res.json({message:'Explicit login link saved'});
}catch(e){res.status(409).json({error:(e as Error).message});}});

router.post('/punch-in',capture('in'));
router.post('/punch-out',capture('out'));

// Live location tracking — site engineer sends location periodically.
// GPS accuracy buffer: phone GPS readings can be off by 50-200m+ indoors
// or under cloud cover. Without a buffer, users physically on site
// frequently get tagged "Outside" because the noisy GPS pin lands just
// past the geofence radius. We subtract the reported accuracy from the
// haversine distance — i.e. if dist=250m, accuracy=100m, radius=200m,
// the true position could be anywhere from 150m to 350m away, so we give
// the benefit of the doubt and treat it as inside (150 <= 200).
router.post("/track-location", async (req, res) => {
  try {
    const { latitude, longitude, address, accuracy, gps_off, reason } = req.body;
    const today = workDate();
    const now = new Date().toISOString();

    // Heartbeat with gps_off=true → user is online (page is open, network
    // alive) but their browser couldn't get a GPS fix. Mam: 'can show me
    // here like some off GPS even network is good'. Stored with NULL
    // lat/lng + site_name='GPS_OFF' so the admin Location Tracking page
    // can surface them as a distinct red card.
    if (gps_off) {
      await pg.run("INSERT INTO location_tracking (user_id, date, time, latitude, longitude, address, site_name) VALUES (?,?,?,NULL,NULL,?,?)",
        req.user.id, today, now, reason || null, "GPS_OFF");
      return res.json({ site: "GPS_OFF", recorded: true });
    }

    if (!latitude || !longitude) return res.status(400).json({ error: "Location required" });
    const geofences = await pg.all("SELECT * FROM geofence_settings WHERE active=1");
    // Same uncertainty-honest rule as the punch endpoints so the live map and the
    // punch UI agree. We mark the ping as on-site only when the GPS uncertainty
    // actually overlaps a site (decision='inside'); a coarse fix that can't be
    // confirmed shows as 'Outside' on the admin map (honest "unconfirmed").
    const geo = geofences.length ? evaluateGeofence(latitude, longitude, accuracy, geofences, await geoSettings(pg)) : null;
    const siteName = geo && geo.decision === "inside" ? geo.matchedSite : "Outside";
    await pg.run("INSERT INTO location_tracking (user_id, date, time, latitude, longitude, address, site_name) VALUES (?,?,?,?,?,?,?)",
      req.user.id, today, now, latitude, longitude, address, siteName);
    res.json({ site: siteName });
  } catch (e) { res.status(e instanceof AttendanceError?e.status:(e as any).code==='P0001'?409:500).json({ error: (e as Error).message }); }
});

// GET location history for a user (admin)
router.get("/track/:userId/:date", requirePermission("attendance_tracking", "view"), async (req, res) => {
  try {
    res.json(await pg.all("SELECT * FROM location_tracking WHERE user_id=? AND date=? ORDER BY time", req.params.userId, req.params.date));
  } catch (e) { res.status(e instanceof AttendanceError?e.status:(e as any).code==='P0001'?409:500).json({ error: (e as Error).message }); }
});

// GET geofence settings
// Shared READ — EVERY employee's punch screen needs the site list to show the
// geofence status; gating it behind attendance:view made non-admin staff get a
// 403 → empty list → the false "No site locations configured" warning even when
// standing in the office (mam 2026-07-01). Only authenticated; edits (POST/PUT/
// DELETE below) stay permission-gated.
router.get("/geofence", async (req, res) => {
  try {
    res.json(await pg.all(`SELECT *, (${await branchSql(req,'attendance_locations','edit')}) AS can_edit, (${await branchSql(req,'attendance_locations','delete')}) AS can_delete FROM geofence_settings WHERE ${await branchSql(req,"attendance_locations","view")} ORDER BY site_name`));
  } catch (e) { res.status(e instanceof AttendanceError?e.status:(e as any).code==='P0001'?409:500).json({ error: (e as Error).message }); }
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
router.get("/audit/geofence-violations", requirePermission("attendance_tracking", "view"), async (req, res) => {
  try {
    let { from, to } = req.query;
    const { days } = req.query;
    if (!from || !to) {
      const d = +days > 0 ? +days : 30;
      const end = new Date();
      const start = new Date(); start.setDate(start.getDate() - d);
      from = start.toISOString().slice(0, 10);
      to = end.toISOString().slice(0, 10);
    }

    const rows=await pg.all(`SELECT a.*,u.name AS employee_name,
      (SELECT evidence FROM attendance_capture_events WHERE attendance_id=a.id AND kind='in' ORDER BY id LIMIT 1) AS in_evidence,
      (SELECT evidence FROM attendance_capture_events WHERE attendance_id=a.id AND kind='out' ORDER BY id LIMIT 1) AS out_evidence
      FROM attendance a LEFT JOIN users u ON u.id=a.user_id WHERE a.date BETWEEN ? AND ? AND ${await scopeSql(req,'attendance_tracking','view','a.user_id')} ORDER BY a.date DESC,a.id DESC`,from,to);
    const enriched=rows.map((r:any)=>{
      const proof=(kind:string)=>{const ev=jsonValue(r[kind==='in'?'in_evidence':'out_evidence']),geo=ev?.geofence,prefix=kind==='in'?'punch_in':'punch_out';return {
       time:r[prefix+'_time'],lat:r[prefix+'_lat'],lng:r[prefix+'_lng'],address:r[prefix+'_address'],accuracy_m:r[prefix+'_accuracy'],
       nearest_site:geo?.nearestSite||geo?.matchedSite||null,distance_m:geo?.nearestDist??null,
       outside_geofence:geo?geo.decision==='outside':null,beyond_3km:geo?.nearestDist!=null?geo.nearestDist>3000:null,
       verified:geo?.verified??null,provenance:geo?'stored_capture_decision':'legacy_location_policy_unavailable'};};
      const pi=proof('in'),po=r.punch_out_time?proof('out'):null;return {id:r.id,date:r.date,employee:r.employee_name||r.user_name_snapshot,site_assigned:r.site_name,review_state:r.review_state,
       location_verified:pi.verified==null?null:!!pi.verified&&(!po||!!po.verified),punch_in:pi,punch_out:po};
    });
    const violations=enriched.filter((r:any)=>r.punch_in.outside_geofence||r.punch_out?.outside_geofence),unverified=enriched.filter((r:any)=>r.location_verified!==true);
    res.json({from,to,rows:enriched,violations,unverified,totals:{total_attendance_rows:enriched.length,punch_in_outside_geofence:enriched.filter((r:any)=>r.punch_in.outside_geofence).length,punch_out_outside_geofence:enriched.filter((r:any)=>r.punch_out?.outside_geofence).length,location_unverified:unverified.length},enforcement_notes:{rule:'Uses the original capture decision. Legacy records without saved policy evidence remain unverified; current site settings do not reclassify history.'}});
  } catch (e) { res.status(e instanceof AttendanceError?e.status:(e as any).code==='P0001'?409:500).json({ error: (e as Error).message }); }
});

// POST add geofence
router.post("/geofence", requirePermission("attendance_locations", "create"), async (req, res) => {
  try {
    const { site_name, latitude, longitude, radius_meters } = req.body;
    if (!latitude || !longitude || !site_name) return res.status(400).json({ error: "Site name and location required" });
    const r = await pg.run("INSERT INTO geofence_settings (site_name, latitude, longitude, radius_meters) VALUES (?,?,?,?)",
      site_name, latitude, longitude, radius_meters || 200);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { res.status(e instanceof AttendanceError?e.status:(e as any).code==='P0001'?409:500).json({ error: (e as Error).message }); }
});

// PUT edit geofence
router.put("/geofence/:id", requirePermission("attendance_locations", "edit"), async (req, res) => {
  try {
    const { site_name, latitude, longitude, radius_meters, active } = req.body;
    await pg.run("UPDATE geofence_settings SET site_name=?, latitude=?, longitude=?, radius_meters=?, active=? WHERE id=?",
      site_name, latitude, longitude, radius_meters || 200, active !== undefined ? (active ? 1 : 0) : 1, req.params.id);
    res.json({ message: "Updated" });
  } catch (e) { res.status(e instanceof AttendanceError?e.status:(e as any).code==='P0001'?409:500).json({ error: (e as Error).message }); }
});

// DELETE geofence
router.delete("/geofence/:id", requirePermission("attendance_locations", "delete"), async (req, res) => {
  try {
    await pg.run("DELETE FROM geofence_settings WHERE id=?", req.params.id);
    res.json({ message: "Deleted" });
  } catch (e) { res.status(e instanceof AttendanceError?e.status:(e as any).code==='P0001'?409:500).json({ error: (e as Error).message }); }
});

// GET monthly report
router.get('/report',requirePermission('attendance','view'),async(req,res)=>{
 try{const month=`${req.query.year||workDate().slice(0,4)}-${String(req.query.month||workDate().slice(5,7)).padStart(2,'0')}`;monthDays(month);
 const employees=await pg.all(`SELECT * FROM employees WHERE ${await scopeSql(req,'attendance','view','employees.id',true)} ORDER BY name`),out=[];
 for(const e of employees){const r=await calculateAttendanceMonth(pg,e,month);out.push({user_id:e.user_id,name:e.name,department:e.department,present_days:r.breakdown.filter((d:any)=>d.label==='present').length,late_days:r.late_marks,half_days:r.half_days,absent_days:r.absent_days,avg_hours:r.breakdown.length?r.total_hours/r.breakdown.length:0,review_required:r.exceptions.length});}res.json(out);
 }catch(e){res.status(400).json({error:(e as Error).message});}
});

// user_ids of the employees who report to managerUserId (via
// reporting_manager_id_1/_2, resolved through employees.user_id).
async function getDirectReportUserIds(managerUserId: any): Promise<any[]> {
  if (!managerUserId) return [];
  const mgrEmp = await pg.get("SELECT id FROM employees WHERE user_id=?", managerUserId);
  if (!mgrEmp) return [];
  return (await pg.all(
    `SELECT user_id FROM employees WHERE user_id IS NOT NULL AND (reporting_manager_id_1=? OR reporting_manager_id_2=?)`,
    mgrEmp.id, mgrEmp.id)).map((r: any) => r.user_id);
}

async function canApproveLeaves(userId: any) {
  const r = await pg.get(`
    SELECT MAX(CASE WHEN rp.can_approve = 1 THEN 1 ELSE 0 END) as ok
    FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
    WHERE ur.user_id = ? AND rp.module = 'attendance'
  `, userId);
  return !!r?.ok;
}

// Leave requests — simplified to Full Day / Half Day only (mam: "no casual
// leave, no earned leave, no short leave. leave is only full day or half
// day"). Historical rows of the old types stay untouched; new requests only
// ever use these two.
router.post("/leave", async (req, res) => {
  try {
    const { leave_type, from_date, reason } = req.body;
    let { to_date } = req.body;
    if (!validDate(from_date) || (to_date && (!validDate(to_date) || to_date < from_date))) return res.status(400).json({ error: "Valid ordered leave dates required" });
    if (!["full_day", "half_day"].includes(leave_type)) {
      return res.status(400).json({ error: "Leave type must be Full Day or Half Day" });
    }

    let days: number;
    if (leave_type === "half_day") {
      to_date = from_date; // half day is always a single day
      days = 0.5;
    } else {
      if (!to_date) return res.status(400).json({ error: "To date required" });
      days = Math.ceil((new Date(to_date).getTime() - new Date(from_date).getTime()) / (1000 * 60 * 60 * 24)) + 1;
    }

    const r = await pg.run("INSERT INTO leave_requests (user_id, leave_type, from_date, to_date, days, hours, reason) VALUES (?,?,?,?,?,0,?)",
      req.user.id, leave_type, from_date, to_date, days, reason);
    fireEmailEvent("leave.requested", {
      employee: req.user.name || "",
      leave_type,
      from_date: from_date,
      to_date: to_date,
      days: String(days),
      reason: reason || "",
      date: new Date().toISOString().slice(0, 10),
      requester_email: req.user.email || await atUserEmail(req.user.id),
      director_email: atDirector(),
    });
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { res.status(e instanceof AttendanceError?e.status:(e as any).code==='P0001'?409:500).json({ error: (e as Error).message }); }
});

router.get("/leaves", requirePermission("attendance", "view"), async (req, res) => {
  try {
    const where='WHERE '+await scopeSql(req,'attendance','view','lr.user_id');
    const params:any[]=[];
    res.json(await pg.all(`
      SELECT lr.*, u.name as user_name,
       (${await scopeSql(req,'attendance','approve','lr.user_id')} AND lr.user_id<>${Number(req.user.id)} AND lr.status='pending') AS can_approve,
       (${await scopeSql(req,'attendance','edit','lr.user_id')} AND lr.user_id<>${Number(req.user.id)} AND lr.status='pending') AS can_edit,
       (${await scopeSql(req,'attendance','delete','lr.user_id')} AND lr.user_id<>${Number(req.user.id)} AND lr.status='pending') AS can_delete
        FROM leave_requests lr
        LEFT JOIN users u ON lr.user_id=u.id
       ${where}
       ORDER BY lr.created_at DESC
    `, ...params));
  } catch (e) { res.status(e instanceof AttendanceError?e.status:(e as any).code==='P0001'?409:500).json({ error: (e as Error).message }); }
});

router.put("/leave/:id/approve", async (req, res) => {
  try {
    const { status, remarks } = req.body;
    const lr = await pg.get("SELECT lr.user_id, lr.leave_type, u.name FROM leave_requests lr LEFT JOIN users u ON u.id=lr.user_id WHERE lr.id=?", req.params.id);
    if (!lr) return res.status(404).json({ error: "Leave request not found" });

    const updated=await pg.run("UPDATE leave_requests SET status=?, approved_by=?, remarks=? WHERE id=? AND status='pending'",
      status, req.user.id, remarks, req.params.id);
    if(!updated.changes)return res.status(409).json({error:"Leave already decided; submit an explicit leave amendment under Requests & Reviews"});
    fireEmailEvent("leave.decided", {
      employee: lr?.name || "",
      leave_type: lr?.leave_type || "",
      status: status || "",
      decided_by: req.user.name || "",
      date: new Date().toISOString().slice(0, 10),
      requester_email: await atUserEmail(lr?.user_id),
      director_email: atDirector(),
    });
    res.json({ message: `Leave ${status}` });
  } catch (e) { res.status(e instanceof AttendanceError?e.status:(e as any).code==='P0001'?409:500).json({ error: (e as Error).message }); }
});

// Full edit — admin / approver fixes typos, wrong dates, wrong hours,
// rounding errors. Mam: 'edit option'. Doesn't change status (use the
// approve route for that).
router.put("/leave/:id", requirePermission("attendance", "edit"), async (req, res) => {
  try {
    const previous=await pg.get('SELECT * FROM leave_requests WHERE id=?',req.params.id);
    const b={...previous,...req.body};
    if(!['full_day','half_day'].includes(b.leave_type)||!validDate(b.from_date)||!validDate(b.to_date)||b.from_date>b.to_date)return res.status(400).json({error:'Valid leave type and ordered dates required'});
    if(b.leave_type==='half_day')b.to_date=b.from_date;
    b.days=b.leave_type==='half_day'?.5:Math.round((Date.parse(b.to_date)-Date.parse(b.from_date))/86400000)+1;b.hours=0;
    const fields = ["leave_type", "from_date", "to_date", "from_time", "to_time", "days", "hours", "reason"];
    const sets: string[] = []; const vals: any[] = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f}=?`); vals.push(b[f]); }
    if (!sets.length) return res.status(400).json({ error: "No fields to update" });
    vals.push(req.params.id);
    const changed = await pg.run(`UPDATE leave_requests SET ${sets.join(", ")} WHERE id=? AND status='pending'`, ...vals);
    if (!changed.changes) return res.status(409).json({error:'Leave was decided or removed; refresh before editing'});
    res.json({ message: "Updated" });
  } catch (err) { res.status(err instanceof AttendanceError?err.status:(err as any).code==='P0001'?409:500).json({ error: (err as Error).message }); }
});

router.delete("/leave/:id", requirePermission("attendance", "delete"), async (req, res) => {
  try {
    const changed = await pg.run("DELETE FROM leave_requests WHERE id=? AND status='pending'", req.params.id);
    if (!changed.changes) return res.status(409).json({error:'Leave was decided or removed; original decision is preserved'});
    res.json({ message: "Deleted" });
  } catch (e) { res.status(e instanceof AttendanceError?e.status:(e as any).code==='P0001'?409:500).json({ error: (e as Error).message }); }
});

router.delete("/:id", requirePermission("attendance_corrections", "delete"), async (req, res) => {
  try {
    const changed = await pg.run("DELETE FROM attendance WHERE id=? AND punch_in_time IS NULL AND punch_out_time IS NULL", req.params.id);
    if (!changed.changes) return res.status(409).json({error:'Original punch evidence cannot be deleted or the record no longer exists'});
    res.json({ message: "Deleted" });
  } catch (e) { res.status(e instanceof AttendanceError?e.status:(e as any).code==='P0001'?409:500).json({ error: (e as Error).message }); }
});

// All attendance capture is an explicit authenticated submission.
export default router;
