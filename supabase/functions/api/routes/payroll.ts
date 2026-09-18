// Shared attendance calculations feed draft payroll; finalized and paid results use saved snapshots.
import { Router } from "../../_shared/express-lite.ts";
import pg from "../../_shared/pg.ts";
import {AttendanceError,assertOpen,payrollFromAttendance,writeLock} from '../../_shared/attendance-operations.ts';
import {isoDay,validMonth} from '../../_shared/attendance-engine.ts';
import { scopeSql, permissionRows, inScope } from "../../_shared/attendance-access.ts";
import { adminOnly, authMiddleware, requirePermission } from "../../_shared/auth.ts";
import { getShiftHistory, lateCutoffMinutes, resolveShift, weekOffDow } from "../../_shared/lib/shifts.ts";

const router = Router();
router.use(authMiddleware);
router.use(async(req,res,next)=>{
 const action=req.method==='GET'?'view':req.path==='/finalise'?'approve':'edit';
 const module=req.path==='/settings'?'attendance_rules':'payroll';
 const grants=await permissionRows(req.user.id,module,action);
 if(!grants.length)return res.status(403).json({error:module+'.'+action+' permission required'});
 if(req.params.employee_id&&!await inScope(req,module,action,req.params.employee_id,true))return res.status(403).json({error:'Employee outside permitted scope'});
 if(req.method!=='GET'&&!req.params.employee_id&&!grants.some(r=>r.scope_mode==='all'))return res.status(403).json({error:'This global operation requires explicit all-employee scope'});
 next();
});

// ---------- helpers ----------

async function getSettings(){
 const row=await pg.get('SELECT * FROM payroll_settings WHERE id=1');
 if(!row)throw new Error('Payroll settings have not been initialized. Apply the reviewed foundation migration.');
 return row;
}

function daysInMonth(month: string) {
  // month = "YYYY-MM"
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function _isSunday(year: number, month: number, day: number) {
  return new Date(year, month - 1, day).getDay() === 0;
}

function pad(n: number) { return String(n).padStart(2, '0'); }

// Parse "HH:MM" / "HH:MM:SS" / ISO datetime → minutes since midnight
function timeToMinutes(t: any): number | null {
  if (!t) return null;
  // ISO datetime? punch_in_time is stored as UTC; the production VPS also
  // runs in UTC, so d.getHours() would return UTC hours — a 10:15 IST punch
  // (04:45Z) read as 04:45 and NEVER crosses the 09:46/10:00 late cutoffs,
  // so nobody was ever marked late. Convert to IST (+5:30) explicitly and
  // read UTC parts so the result is correct regardless of server timezone
  // (matches the attendance month-view logic).
  if (t.includes('T') || t.includes(' ')) {
    const d = new Date(t);
    if (isNaN(d.getTime())) return null;
    const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
    return ist.getUTCHours() * 60 + ist.getUTCMinutes();
  }
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

// ---------- routes ----------

// GET current settings
router.get('/settings', async (_req, res) => {
  try {
    res.json(await getSettings());
  } catch (err) {
    res.status(err instanceof AttendanceError?err.status:(err as any).code==='P0001'?409:500).json({ error: (err as Error).message });
  }
});

// PUT update settings (admin only)
router.put('/settings', requirePermission('attendance_rules','edit'), async (req, res) => {
  try {

    const fields = ['basic_pct','conveyance_pct','hra_pct','adhoc_pct','misc_pct'];
    const previous=await getSettings();
    if(Object.keys(req.body).some(k=>!fields.includes(k)&&k in previous&&!['id','updated_at','updated_by'].includes(k)&&String(req.body[k])!==String(previous[k])))return res.status(409).json({error:'Attendance rules must be published as a new version in Attendance > Policies'});
    if(fields.some(k=>!Number.isFinite(Number(req.body[k]??previous[k]))||Number(req.body[k]??previous[k])<0)||Math.abs(fields.reduce((n,k)=>n+Number(req.body[k]??previous[k]),0)-100)>.01)return res.status(400).json({error:'Salary component percentages must be nonnegative and total 100'});
    const sets: string[] = [];
    const vals: any[] = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        sets.push(`${f} = ?`);
        vals.push(req.body[f]);
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    sets.push('updated_at = CURRENT_TIMESTAMP', 'updated_by = ?');
    vals.push(req.user.id);
    await pg.run(`UPDATE payroll_settings SET ${sets.join(', ')} WHERE id = 1`, ...vals);
    res.json({ message: 'Settings updated', settings: await getSettings() });
  } catch (err) {
    res.status(err instanceof AttendanceError?err.status:(err as any).code==='P0001'?409:500).json({ error: (err as Error).message });
  }
});

// Core calculator — runs for one employee for one month, returns full breakdown.
async function calculateForEmployee(settings:any,employee:any,month:string){return payrollFromAttendance(pg,settings,employee,month);}

function round2(n: number) { return Math.round((n || 0) * 100) / 100; }

function dayName(y: number, m: number, d: number) {
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(y, m - 1, d).getDay()];
}

// GET monthly payroll for ALL employees
router.get('/calculate', requirePermission('payroll', 'view'), async (req, res) => {
  try {
    const month = req.query.month;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const settings = await getSettings();
    const employees=await pg.all(`SELECT * FROM employees WHERE ${await scopeSql(req,'payroll','view','employees.id',true)} AND ((salary>0 AND (join_date IS NULL OR join_date='' OR left(join_date,7)<=?) AND (employment_end_date IS NULL OR employment_end_date='' OR left(employment_end_date,7)>=?)) OR EXISTS(SELECT 1 FROM payroll_runs pr WHERE pr.employee_id=employees.id AND pr.month=?)) ORDER BY name`,month,month,month);
    const excludedNoSalary=await pg.all(`SELECT id,name FROM employees WHERE status='active' AND COALESCE(salary,0)<=0 AND ${await scopeSql(req,'payroll','view','employees.id',true)}`);
    const out=[];for(const emp of employees)out.push(await calculateForEmployee(settings,emp,month));
    res.json({ month, settings, employees: out, excluded_no_salary: excludedNoSalary });
  } catch (err) {
    console.error('payroll calc error', err);
    res.status(err instanceof AttendanceError?err.status:(err as any).code==='P0001'?409:500).json({ error: (err as Error).message });
  }
});

// GET single employee detail (with breakdown)
router.get('/calculate/:employee_id', requirePermission('payroll', 'view'), async (req, res) => {
  try {
    const month = req.query.month;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const settings = await getSettings();
    const emp = await pg.get('SELECT * FROM employees WHERE id=?', req.params.employee_id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const result = await calculateForEmployee(settings, emp, month);
    res.json({ month, settings, ...result });
  } catch (err) {
    console.error('payroll detail error', err);
    res.status(err instanceof AttendanceError?err.status:(err as any).code==='P0001'?409:500).json({ error: (err as Error).message });
  }
});

// POST finalise a month — locks the snapshot for all employees
router.post('/finalise',requirePermission('payroll','approve'),async(req,res)=>{
 try{
  const {month}=req.body;if(!validMonth(month)||month>=isoDay().slice(0,7))return res.status(400).json({error:'Only a completed month can be finalised'});
  const result=await pg.tx(async db=>{
   await writeLock(db);const period=await db.get("SELECT * FROM attendance_periods WHERE month=? AND state='closed'",month);
   if(!period)throw new AttendanceError(409,'Close attendance and resolve its exceptions before payroll finalization');
   const settings=await db.get('SELECT * FROM payroll_settings WHERE id=1');
   const employees=await db.all("SELECT * FROM employees WHERE salary>0 AND (join_date IS NULL OR join_date='' OR left(join_date,7)<=?) AND (employment_end_date IS NULL OR employment_end_date='' OR left(employment_end_date,7)>=?)",month,month);
   let count=0;
   for(const employee of employees){
    const old=await db.get('SELECT * FROM payroll_runs WHERE month=? AND employee_id=?',month,employee.id);
    if(old?.paid||old?.status==='disbursed'||old?.status==='finalised'&&old.attendance_revision===period.revision)continue;
    if(old?.status==='finalised'){
     await db.run('INSERT INTO payroll_snapshot_history(payroll_run_id,month,employee_id,payload,provenance,actor_id) VALUES(?,?,?,?::jsonb,?,?)',old.id,month,employee.id,old,'Superseded after authorized attendance reopen',req.user.id);
     await db.run("UPDATE payroll_runs SET status='draft' WHERE id=?",old.id);
    }
    const r=await payrollFromAttendance(db,settings,employee,month);
    if(!r.ready)throw new AttendanceError(409,employee.name+': unresolved attendance exceptions');
    const fields=['month','employee_id','employee_name','base_salary','working_days','paid_days','half_days','absent_days','late_marks','lates_converted_absent','late_penalty','paid_leaves','unpaid_leaves','sundays','ot_hours','gross_earned','ot_pay','deductions','net_pay','basic_pay','conveyance','hra','adhoc','misc','advance','breakdown_json','status','finalised_by','snapshot_json','attendance_revision'];
    const values=[month,employee.id,employee.name,r.base_salary,r.working_days,r.paid_days,r.half_days,r.absent_days,r.late_marks,r.lates_converted_absent,r.late_penalty,r.paid_leaves,r.unpaid_leaves,r.sunday_count,r.ot_hours,r.gross_earned,r.ot_pay,r.deductions,r.net_pay,r.basic_pay,r.conveyance,r.hra,r.adhoc,r.misc,r.advance,JSON.stringify(r.breakdown),'finalised',req.user.id,r,period.revision];
    const inserted=await db.run(`INSERT INTO payroll_runs(${fields.join(',')},finalised_at) VALUES(${fields.map(()=>'?').join(',')},CURRENT_TIMESTAMP) ON CONFLICT(month,employee_id) DO UPDATE SET ${fields.filter(v=>!['month','employee_id'].includes(v)).map(v=>v+'=EXCLUDED.'+v).join(',')},finalised_at=CURRENT_TIMESTAMP`,...values);
    const run=await db.get('SELECT id FROM payroll_runs WHERE month=? AND employee_id=?',month,employee.id);
    await db.run('INSERT INTO payroll_snapshot_history(payroll_run_id,month,employee_id,payload,provenance,actor_id) VALUES(?,?,?,?::jsonb,?,?)',run.id,month,employee.id,r,'attendance-v2 finalization',req.user.id);count++;
   }return {count};
  });res.json({message:'Payroll snapshots finalized; prior snapshots retained',...result});
 }catch(e){res.status(e instanceof AttendanceError?e.status:409).json({error:(e as Error).message});}
});

// PUT mark an employee Paid / unpaid for a finalised month (mam 2026-06-13:
// "after account will give option paid ... if we dont pay someone that is in
// our record").  Only works once the month is finalised — the snapshot row
// must exist.  Gated by payroll edit (Accounts); admins always pass.
router.put('/paid/:employee_id', requirePermission('payroll', 'edit'), async (req, res) => {
  try {
    const { month } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const paid = req.body.paid ? 1 : 0;
    await pg.tx(async db=>{await writeLock(db);
      const row=await db.get('SELECT * FROM payroll_runs WHERE month=? AND employee_id=? FOR UPDATE',month,req.params.employee_id);
      if(!row)throw new AttendanceError(409,'Finalize this month before marking paid');
      if(row.paid||row.status==='disbursed'){if(!paid)throw new AttendanceError(409,'Paid history cannot be reversed; use a later approved adjustment');return;}
      if(row.status!=='finalised')throw new AttendanceError(409,'Finalize before marking paid');
      const period=await db.get('SELECT * FROM attendance_periods WHERE month=?',month);
      if(period?.state!=='closed'||row.attendance_revision!==period.revision)throw new AttendanceError(409,'Close attendance and finalize the current revision before paying');
      if(paid)await db.run("UPDATE payroll_runs SET paid=1,status='disbursed',paid_at=CURRENT_TIMESTAMP,paid_by=? WHERE id=?",req.user.id,row.id);
    });
    res.json({ message: paid ? 'Marked paid' : 'Marked unpaid', paid: !!paid });
  } catch (err) {
    console.error('payroll paid update error', err);
    res.status(err instanceof AttendanceError?err.status:(err as any).code==='P0001'?409:500).json({ error: (err as Error).message });
  }
});

// POST unlock a finalised month (admin only — for corrections)
router.post('/unlock',requirePermission('payroll','edit'),async(req,res)=>{
 try{
  const {month,reason}=req.body;if(!validMonth(month)||typeof reason!=='string'||reason.trim().length<3)return res.status(400).json({error:'Month and reason required'});
  if(!(await permissionRows(req.user.id,'attendance_periods','approve')).some(r=>r.scope_mode==='all'))return res.status(403).json({error:'Explicit period approval authority required'});
  await pg.tx(async db=>{await writeLock(db);
   if(await db.get("SELECT month FROM attendance_periods WHERE month=? AND state='closed'",month))throw new AttendanceError(409,'Reopen attendance first. Paid payroll remains immutable.');
   const rows=await db.all("SELECT * FROM payroll_runs WHERE month=? AND status='finalised' AND COALESCE(paid,0)=0",month);
   for(const row of rows){await db.run('INSERT INTO payroll_snapshot_history(payroll_run_id,month,employee_id,payload,provenance,actor_id) VALUES(?,?,?,?::jsonb,?,?)',row.id,month,row.employee_id,row,'Reopened: '+reason,req.user.id);await db.run("UPDATE payroll_runs SET status='draft' WHERE id=?",row.id);}
  });res.json({message:'Unpaid runs reopened; every original snapshot and paid run retained'});
 }catch(e){res.status(e instanceof AttendanceError?e.status:409).json({error:(e as Error).message});}
});

// PUT an employee's advance-salary amount for a month (admin). Deducted
// from that month's net pay. Blocked once the month is finalised.
router.put('/advance/:employee_id', requirePermission('payroll','edit'), async (req, res) => {
  try {
    const { month } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amount must be a non-negative number' });

    const emp = await pg.get('SELECT id FROM employees WHERE id=?', req.params.employee_id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const locked = (await pg.get('SELECT COUNT(*) AS c FROM payroll_runs WHERE month=? AND status=?', month, 'finalised')).c;
    if (locked) return res.status(409).json({ error: `${month} is finalised — unlock it first to change an advance.` });

    await pg.run(
      `INSERT INTO payroll_advances (month, employee_id, amount, updated_by, updated_at)
       VALUES (?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(month, employee_id) DO UPDATE SET
         amount = excluded.amount, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
      month, emp.id, round2(amount), req.user.id);

    res.json({ message: 'Advance saved', amount: round2(amount) });
  } catch (err) {
    console.error('advance update error', err);
    res.status(err instanceof AttendanceError?err.status:(err as any).code==='P0001'?409:500).json({ error: (err as Error).message });
  }
});

// PUT an employee's food allowance for a month (admin). ADDED to that
// month's net pay. Blocked once the month is finalised. Stored on the same
// payroll_advances row as the advance (mam 2026-06-12).
router.put('/food/:employee_id', requirePermission('payroll','edit'), async (req, res) => {
  try {
    const { month } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amount must be a non-negative number' });

    const emp = await pg.get('SELECT id FROM employees WHERE id=?', req.params.employee_id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const locked = (await pg.get('SELECT COUNT(*) AS c FROM payroll_runs WHERE month=? AND status=?', month, 'finalised')).c;
    if (locked) return res.status(409).json({ error: `${month} is finalised — unlock it first to change food.` });

    await pg.run(
      `INSERT INTO payroll_advances (month, employee_id, food, updated_by, updated_at)
       VALUES (?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(month, employee_id) DO UPDATE SET
         food = excluded.food, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
      month, emp.id, round2(amount), req.user.id);

    res.json({ message: 'Food saved', amount: round2(amount) });
  } catch (err) {
    console.error('food update error', err);
    res.status(err instanceof AttendanceError?err.status:(err as any).code==='P0001'?409:500).json({ error: (err as Error).message });
  }
});

// PUT a manual monthly override for Paid Days / CL / Late ₹ (admin, mam
// 2026-06-13: "give me edit option on days, CL, late so i can give salary
// now").  field ∈ paid_days | cl | late_penalty.  A blank / null value RESETS
// to the auto-calculated number.  Blocked once the month is finalised.
router.put('/override/:employee_id', requirePermission('payroll','edit'), async (req, res) => {
  try {
    const { month, field } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const COLS: Record<string, string> = { paid_days: 'paid_days_override', cl: 'cl_override', late_penalty: 'late_penalty_override' };
    const col = COLS[field];
    if (!col) return res.status(400).json({ error: 'field must be paid_days, cl or late_penalty' });

    const raw = req.body.value;
    const reset = raw === '' || raw === null || raw === undefined;
    let value: number | null = null;
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

    const emp = await pg.get('SELECT id FROM employees WHERE id=?', req.params.employee_id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const locked = (await pg.get('SELECT COUNT(*) AS c FROM payroll_runs WHERE month=? AND status=?', month, 'finalised')).c;
    if (locked) return res.status(409).json({ error: `${month} is finalised — unlock it first to edit it.` });

    await pg.run(
      `INSERT INTO payroll_advances (month, employee_id, ${col}, updated_by, updated_at)
       VALUES (?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(month, employee_id) DO UPDATE SET
         ${col} = excluded.${col}, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
      month, emp.id, value, req.user.id);

    res.json({ message: reset ? 'Reset to auto' : 'Override saved', value });
  } catch (err) {
    console.error('override update error', err);
    res.status(err instanceof AttendanceError?err.status:(err as any).code==='P0001'?409:500).json({ error: (err as Error).message });
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

async function computeLeaveBalances(year: number, req:any) {
  const settings = await getSettings();
  const clPerMonth = +settings.cl_per_month || 0;

  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1; // 1-12
  const monthsElapsed = year < curYear ? 12 : (year > curYear ? 0 : curMonth);

  const yStart = `${year}-01-01`;
  const yEnd = `${year}-12-31`;

  const employees = await pg.all(
    `SELECT id, user_id, name, department, designation,
            COALESCE(cl_eligible, 1) AS cl_eligible,
            COALESCE(ot_eligible, 0) AS ot_eligible,
            COALESCE(cl_opening_balance, 0) AS cl_opening_balance
       FROM employees WHERE status='active' AND ${await scopeSql(req,'payroll',req.method==='GET'?'view':'edit','employees.id',true)} ORDER BY LOWER(name)`);

  // CL days taken this year per user (approved casual leaves whose start
  // falls in the year). days defaults to 1 when the column is null.
  const usedSql =
    `SELECT COALESCE(SUM(COALESCE(days, 1)), 0) AS used
       FROM leave_requests
      WHERE user_id = ? AND leave_type = 'casual' AND status = 'approved'
        AND from_date BETWEEN ? AND ?`;

  const out: any[] = [];
  for (const e of employees) {
    const eligible = e.cl_eligible ? 1 : 0;
    const opening = round2(e.cl_opening_balance);
    const accrued = eligible ? round2(clPerMonth * monthsElapsed) : 0;
    const used = e.user_id ? round2((await pg.get(usedSql, e.user_id, yStart, yEnd)).used) : 0;
    const remaining = round2(opening + accrued - used);
    out.push({
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
    });
  }
  return out;
}

// GET annual CL balance sheet for all employees.
router.get('/leave-balances', requirePermission('payroll', 'view'), async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    res.json({ year, cl_per_month: +(await getSettings()).cl_per_month || 0, rows: await computeLeaveBalances(year,req) });
  } catch (err) {
    console.error('leave-balances error', err);
    res.status(err instanceof AttendanceError?err.status:(err as any).code==='P0001'?409:500).json({ error: (err as Error).message });
  }
});

// PUT one employee's carry-forward opening balance + CL eligibility (admin).
router.put('/leave-balance/:employee_id', requirePermission('payroll','edit'), async (req, res) => {
  try {
    const emp = await pg.get('SELECT id FROM employees WHERE id=?', req.params.employee_id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const sets: string[] = [];
    const vals: any[] = [];
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
    await pg.run(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    res.json({ message: 'Updated' });
  } catch (err) {
    console.error('leave-balance update error', err);
    res.status(err instanceof AttendanceError?err.status:(err as any).code==='P0001'?409:500).json({ error: (err as Error).message });
  }
});

// POST roll a year's leftover CL into next year's opening balance (admin).
// Sets each employee's cl_opening_balance = remaining(year). Idempotent in
// effect only if re-run on the SAME source year — re-running after CL is
// taken in the new year would double count, so the UI guards it to the
// completed year.
router.post('/leave-balances/rollover', requirePermission('payroll','edit'), async (req, res) => {
  try {
    const year = parseInt(req.body.year, 10);
    if (!year) return res.status(400).json({ error: 'year required' });
    const rows = await computeLeaveBalances(year,req);
    await pg.tx(async (t) => {
      for (const r of rows) await t.run('UPDATE employees SET cl_opening_balance = ? WHERE id = ?', Math.max(0, r.remaining), r.employee_id);
    });
    res.json({ message: `Rolled ${year} leftover CL into opening balance for ${rows.length} employees`, count: rows.length });
  } catch (err) {
    console.error('leave-balances rollover error', err);
    res.status(err instanceof AttendanceError?err.status:(err as any).code==='P0001'?409:500).json({ error: (err as Error).message });
  }
});

export default router;
