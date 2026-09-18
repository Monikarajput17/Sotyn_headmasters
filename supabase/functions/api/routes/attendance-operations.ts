import * as XLSX from 'xlsx';
import {Router,upload} from '../../_shared/express-lite.ts';
import {authMiddleware} from '../../_shared/auth.ts';
import pg from '../../_shared/pg.ts';
import {idNumber,inScope,permissionRows,scopeSql} from '../../_shared/attendance-access.ts';
import {addDays,isoDay,jsonValue,monthDays,shiftPlan,validDay,validMonth,validatePolicy,validateSegments} from '../../_shared/attendance-engine.ts';
import {AttendanceError,assertOpen,calculateAttendanceMonth,fail,hashPayload,resolveDuty,writeLock} from '../../_shared/attendance-operations.ts';
const router=Router();router.use(authMiddleware);
const action=(module:string,verb:string,fn:any,global=false)=>async(req:any,res:any)=>{
 try{const grants=await permissionRows(req.user.id,module,verb);if(!grants.length||global&&!grants.some(r=>r.scope_mode==='all'))return res.status(403).json({error:`Explicit ${module}.${verb}${global?' with all scope':''} required`});await fn(req,res);}
 catch(e){res.status(e instanceof AttendanceError?e.status:(e as any).code==='P0001'||(e as any).code==='23505'?409:400).json({error:(e as Error).message});}
};
const target=async(req:any,module:string,verb:string,id:any)=>{if(!await inScope(req,module,verb,id,true))fail('Employee outside permitted scope',403);return await pg.get('SELECT * FROM employees WHERE id=?',id);};
const decoded=(rows:any[])=>rows.map(r=>{for(const k of ['rules','segments','week_off_days','proposed'])if(r[k]!=null)r[k]=jsonValue(r[k]);if(r.capture_evidence)r.capture_evidence=r.capture_evidence.map((c:any)=>({...c,evidence:jsonValue(c.evidence)}));return r;});
const reason=(v:any)=>{if(typeof v!=='string'||v.trim().length<3||v.length>2000)fail('A reason of 3 to 2000 characters is required');return v.trim();};
router.get('/employees',action('attendance_rosters','view',async(req,res)=>{res.json(await pg.all(`SELECT id,name,user_id,attendance_branch_id FROM employees WHERE ${await scopeSql(req,'attendance_rosters','view','employees.id',true)} ORDER BY name`));}));
router.get('/templates',action('attendance_rosters','view',async(_req,res)=>res.json(decoded(await pg.all('SELECT * FROM attendance_shift_templates ORDER BY code,version DESC')))));
router.post('/templates',action('attendance_rosters','create',async(req,res)=>{
 const b=req.body;if(!/^[A-Z0-9_-]{1,40}$/.test(b.code)||!b.name?.trim())fail('Code (A-Z, digits, _ or -) and name required');
 const segments=validateSegments(b.segments),off=b.week_off_days;
 if(!Array.isArray(off)||off.some((n:any)=>!Number.isInteger(n)||n<0||n>6))fail('Weekly offs must be weekday numbers 0 to 6');
 const result=await pg.tx(async db=>{await writeLock(db);const row=await db.get('SELECT COALESCE(MAX(version),0)+1 AS version FROM attendance_shift_templates WHERE code=?',b.code);
 return db.run('INSERT INTO attendance_shift_templates(code,version,name,segments,week_off_days,created_by) VALUES(?,?,?,?::jsonb,?::jsonb,?)',b.code,row.version,b.name.trim(),segments,[...new Set(off)],req.user.id);});
 res.status(201).json({id:result.lastInsertRowid});
},true));
router.get('/policies',action('attendance_policies','view',async(_req,res)=>res.json(decoded(await pg.all('SELECT * FROM attendance_policy_versions ORDER BY effective_from DESC,id DESC')))));
router.post('/policies',action('attendance_policies','create',async(req,res)=>{
 const b=req.body;if(!validDay(b.effective_from))fail('Valid effective date required');validatePolicy(b.rules);
 const r=await pg.tx(async db=>{await assertOpen(db,b.effective_from);return db.run('INSERT INTO attendance_policy_versions(effective_from,rules,reason,created_by) VALUES(?,?::jsonb,?,?)',b.effective_from,b.rules,reason(b.reason),req.user.id);});
 res.status(201).json({id:r.lastInsertRowid});
},true));

async function checkLeaveAmendmentPeriods(db:any,original:any,proposed:any){
 const ranges=[[original.from_date,original.to_date]];if(proposed.action==='replace')ranges.push([proposed.from_date,proposed.to_date]);
 // A later amendment must also unlock the dates of an earlier approved replacement.
 const prior=await db.get("SELECT proposed FROM attendance_requests WHERE kind='leave_amendment' AND status='approved' AND proposed->>'leave_id'=? ORDER BY id DESC LIMIT 1",String(original.id));
 if(prior?.proposed.action==='replace')ranges.push([prior.proposed.from_date,prior.proposed.to_date]);
 for(const [start,end] of ranges){if(Date.parse(end)-Date.parse(start)>366*86400000)fail('Leave range cannot exceed one year');for(let d=start;d<=end;d=addDays(d,1))await assertOpen(db,d);}
}
async function validateRoster(req:any,rows:any[]){
 if(!Array.isArray(rows)||!rows.length||rows.length>1000)fail('Provide 1 to 1000 roster rows');
 const seen=new Set(),valid:any[]=[],errors:any[]=[];
 for(let i=0;i<rows.length;i++){
  try{
   const r=rows[i],employee_id=idNumber(r.employee_id),work_date=String(r.work_date||''),day_type=String(r.day_type||'work'),template_id=day_type==='off'?null:idNumber(r.template_id);
   if(!employee_id||!validDay(work_date)||!['off','work'].includes(day_type))fail('Stable employee_id, YYYY-MM-DD work_date, and work/off required');
   await target(req,'attendance_rosters','edit',employee_id);
   if(day_type==='work'&&!await pg.get('SELECT id FROM attendance_shift_templates WHERE id=?',template_id))fail('Existing shift template ID required');
   const key=employee_id+':'+work_date;if(seen.has(key))fail('Duplicate employee/date in this batch');seen.add(key);
   if(await pg.get("SELECT month FROM attendance_periods WHERE month=? AND state='closed'",work_date.slice(0,7)))fail('Date is in a closed period');
   const current=await pg.get('SELECT id FROM attendance_roster_entries WHERE employee_id=? AND work_date=? ORDER BY id DESC LIMIT 1',employee_id,work_date);
   valid.push({employee_id,work_date,day_type,template_id,expected_id:r.expected_id===undefined?current?.id||null:r.expected_id,reason:reason(r.reason||req.body.reason||'Roster assignment')});
  }catch(e){errors.push({row:i+1,error:(e as Error).message});}
 }
 if(!errors.length)errors.push(...await rosterOverlaps(pg,valid));
 return {rows:valid,errors,ready:errors.length===0};
}
async function rosterOverlaps(db:any,rows:any[]){
 const errors=[];
 for(const r of rows){if(r.day_type==='off')continue;
  const plan=shiftPlan(r.work_date,await db.get('SELECT * FROM attendance_shift_templates WHERE id=?',r.template_id))!;
  for(const delta of [-1,1]){const date=addDays(r.work_date,delta),proposed=rows.find(v=>v.employee_id===r.employee_id&&v.work_date===date);let neighbour:any=null;
   if(proposed?.day_type==='work')neighbour=shiftPlan(date,await db.get('SELECT * FROM attendance_shift_templates WHERE id=?',proposed.template_id));
   else if(!proposed){const duty=await resolveDuty(db,{id:r.employee_id},date);if(!duty.off)neighbour=duty.plan;}
   if(neighbour&&plan.windows.some((w:any)=>neighbour.windows.some((n:any)=>Date.parse(w.start)<Date.parse(n.end)&&Date.parse(n.start)<Date.parse(w.end))))errors.push({row:rows.indexOf(r)+1,error:'Duty overlaps the adjacent work date'});
  }
 }
 return errors;
}
router.post('/roster/preview',action('attendance_rosters','edit',async(req,res)=>res.json(await validateRoster(req,req.body.rows))));
router.post('/roster/import',upload.single('file'),action('attendance_rosters','edit',async(req,res)=>{
 if(!req.file||req.file.buffer.length>2000000)fail('Choose an XLSX or CSV file under 2 MB');
 const workbook=XLSX.read(req.file.buffer,{type:'array',cellDates:false,raw:true,sheetRows:1002});
 const rows:any[]=XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]],{defval:''});
 // Require ISO text dates to avoid locale/date-serial ambiguity in attendance assignments.
 res.json(await validateRoster(req,rows));
}));
router.post('/roster/pattern',action('attendance_rosters','edit',async(req,res)=>{
 const b=req.body;if(!validDay(b.from)||!validDay(b.to)||b.from>b.to||!Array.isArray(b.employee_ids)||!Array.isArray(b.cycle)||!b.cycle.length||b.cycle.length>31)fail('Employees, ordered date range and a cycle of 1 to 31 days required');
 const rows:any[]=[];let index=0;for(let date=b.from;date<=b.to;date=addDays(date,1),index++){for(const employee_id of b.employee_ids){rows.push({employee_id,work_date:date,...b.cycle[index%b.cycle.length],reason:b.reason});if(rows.length>1000)fail('Pattern exceeds 1000 assignments');}}
 res.json(await validateRoster(req,rows));
}));
router.post('/roster/commit',action('attendance_rosters','edit',async(req,res)=>{
 const b=req.body;if(!/^[-\w]{16,100}$/.test(b.request_id||''))fail('Stable request_id required');
 const preview=await validateRoster(req,b.rows);if(!preview.ready)return res.status(400).json(preview);
 const hash=await hashPayload(preview.rows);
 const result=await pg.tx(async db=>{
  await writeLock(db);const prior=await db.get('SELECT * FROM attendance_roster_batches WHERE request_id=?',b.request_id);
  if(prior){if(prior.payload_hash!==hash||prior.created_by!==req.user.id)fail('Request ID already used with different assignments',409);return {id:prior.id,replayed:true};}
  // Validation must be repeated under the write lock; conflict tokens protect previews.
  for(const r of preview.rows){await assertOpen(db,r.work_date);const old=await db.get('SELECT id FROM attendance_roster_entries WHERE employee_id=? AND work_date=? ORDER BY id DESC LIMIT 1',r.employee_id,r.work_date);if((old?.id||null)!==r.expected_id)fail('Roster changed after preview; preview again',409);}
  if((await rosterOverlaps(db,preview.rows)).length)fail('Adjacent duty changed and now overlaps; preview again',409);
  const batch=await db.run('INSERT INTO attendance_roster_batches(request_id,payload_hash,created_by,row_count) VALUES(?,?,?,?)',b.request_id,hash,req.user.id,preview.rows.length);
  for(const r of preview.rows)await db.run('INSERT INTO attendance_roster_entries(employee_id,work_date,day_type,template_id,reason,batch_id,created_by) VALUES(?,?,?,?,?,?,?)',r.employee_id,r.work_date,r.day_type,r.template_id,r.reason,batch.lastInsertRowid,req.user.id);
  return {id:batch.lastInsertRowid,count:preview.rows.length};
 });res.json(result);
}));
router.get('/roster',action('attendance_rosters','view',async(req,res)=>{
 if(!validMonth(req.query.month))fail('Valid month required');
 res.json(await pg.all(`SELECT DISTINCT ON(r.employee_id,r.work_date) r.*,e.name AS employee_name,t.name AS shift_name FROM attendance_roster_entries r JOIN employees e ON e.id=r.employee_id LEFT JOIN attendance_shift_templates t ON t.id=r.template_id WHERE left(r.work_date,7)=? AND ${await scopeSql(req,'attendance_rosters','view','e.id',true)} ORDER BY r.employee_id,r.work_date,r.id DESC`,req.query.month));
}));
router.get('/my-schedule',action('attendance','view',async(req,res)=>{
 const links=await pg.all('SELECT * FROM employees WHERE user_id=?',req.user.id);if(links.length!==1)fail('Exactly one employee/login link is required',409);const e=links[0];
 const dates=monthDays(req.query.month||isoDay().slice(0,7)),out=[];for(const date of dates){const d=await resolveDuty(pg,e,date);out.push({date,off:d.off,plan:d.plan});}res.json(out);
}));
router.get('/month/:employee_id',action('attendance','view',async(req,res)=>{
 const e=await target(req,'attendance','view',req.params.employee_id);const result=await calculateAttendanceMonth(pg,e,req.query.month);
 // Attendance consumers must not receive salary or financial configuration from snapshots.
 const {source,rules_by_date,...safe}=result;res.json(safe);
}));
router.get('/my-month',action('attendance','view',async(req,res)=>{
 const links=await pg.all('SELECT * FROM employees WHERE user_id=?',req.user.id);if(links.length!==1)fail('Exactly one employee/login link is required',409);
 const {source,rules_by_date,...safe}=await calculateAttendanceMonth(pg,links[0],req.query.month||isoDay().slice(0,7));res.json(safe);
}));
router.get('/request-employees',action('attendance_requests','create',async(req,res)=>res.json(await pg.all(`SELECT id,name FROM employees WHERE ${await scopeSql(req,'attendance_requests','create','employees.id',true)} ORDER BY name`))));
router.get('/requests',action('attendance_requests','view',async(req,res)=>{
 res.json(decoded(await pg.all(`SELECT r.*,e.name AS employee_name,e.user_id AS employee_user_id,(SELECT jsonb_agg(jsonb_build_object('kind',c.kind,'received_at',c.received_at,'evidence',c.evidence)) FROM attendance_capture_events c WHERE c.attendance_id=(r.proposed->>'attendance_id')::bigint) AS capture_evidence FROM attendance_requests r JOIN employees e ON e.id=r.employee_id WHERE ${await scopeSql(req,'attendance_requests','view','e.id',true)} ORDER BY r.id DESC LIMIT 300`)));
}));
router.post('/requests',action('attendance_requests','create',async(req,res)=>{
 const b=req.body,employee=await target(req,'attendance_requests','create',idNumber(b.employee_id));
 if(b.kind!=='leave_amendment'&&(!validDay(b.work_date)||b.work_date>isoDay()))fail('A current or past work date is required');
 const proposed=b.proposed;
 if(b.kind==='leave_amendment'){
  const original=await pg.get("SELECT * FROM leave_requests WHERE id=? AND user_id=? AND status='approved'",proposed?.leave_id,employee.user_id);
  if(!original)fail('Choose an approved leave belonging to this employee');
  if(!['cancel','replace'].includes(proposed.action))fail('Choose cancel or replace');
  if(proposed.action==='replace'&&(!validDay(proposed.from_date)||!validDay(proposed.to_date)||proposed.to_date<proposed.from_date||!['full_day','half_day'].includes(proposed.leave_type)||proposed.leave_type==='half_day'&&proposed.from_date!==proposed.to_date))fail('Valid replacement leave dates/type required');
  const why=reason(b.reason);if(!/^[-\w]{16,100}$/.test(b.request_id||''))fail('Stable request ID required');
  const hash=await hashPayload({employee_id:employee.id,proposed,reason:why});
  const result=await pg.tx(async db=>{await writeLock(db);
   const prior=await db.get('SELECT * FROM attendance_requests WHERE requested_by=? AND request_id=?',req.user.id,b.request_id);if(prior){if(prior.payload_hash!==hash)fail('Request ID has different content',409);return {lastInsertRowid:prior.id};}
   await checkLeaveAmendmentPeriods(db,original,proposed);
   return db.run("INSERT INTO attendance_requests(request_id,payload_hash,employee_id,work_date,kind,proposed,reason,requested_by) VALUES(?,?,?,?,'leave_amendment',?::jsonb,?,?)",b.request_id,hash,employee.id,original.from_date,{...proposed,original_from:original.from_date,original_to:original.to_date},why,req.user.id);
  });return res.status(201).json({id:result.lastInsertRowid});
 }

 if(!proposed||![0,.5,1,1.5,2].includes(proposed.pay_fraction)||!Number.isFinite(proposed.hours)||proposed.hours<0||proposed.hours>48||!Number.isFinite(Number(proposed.late_minutes||0))||Number(proposed.late_minutes||0)<0)fail('Correction needs explicit pay fraction, hours (0-48), and nonnegative late minutes');
 const why=reason(b.reason);if(!/^[-\w]{16,100}$/.test(b.request_id||''))fail('Stable request ID required');
 const hash=await hashPayload({employee_id:employee.id,work_date:b.work_date,proposed,reason:why});
 const r=await pg.tx(async db=>{await assertOpen(db,b.work_date);const old=await db.get('SELECT * FROM attendance_requests WHERE requested_by=? AND request_id=?',req.user.id,b.request_id);if(old){if(old.payload_hash!==hash)fail('Request ID has different evidence',409);return {lastInsertRowid:old.id};}
 return db.run("INSERT INTO attendance_requests(request_id,payload_hash,employee_id,work_date,kind,proposed,reason,requested_by) VALUES(?,?,?,?,'correction',?::jsonb,?,?)",b.request_id,hash,employee.id,b.work_date,proposed,why,req.user.id);});res.status(201).json({id:r.lastInsertRowid});
}));
router.put('/requests/:id/decision',action('attendance_requests','approve',async(req,res)=>{
 const b=req.body;if(!['approved','rejected'].includes(b.status))fail('Approve or reject required');
 const request=await pg.get('SELECT * FROM attendance_requests WHERE id=?',req.params.id);if(!request)fail('Request not found',404);request.proposed=jsonValue(request.proposed);
 const employee=await target(req,'attendance_requests','approve',request.employee_id);
 if(request.requested_by===req.user.id||employee.user_id===req.user.id)fail('Self approval is not allowed',403);
 await pg.tx(async db=>{await assertOpen(db,request.work_date);
  if(request.kind==='leave_amendment'){
   const original=await db.get('SELECT * FROM leave_requests WHERE id=?',request.proposed.leave_id);
   await checkLeaveAmendmentPeriods(db,original,request.proposed);
  }
  const r=await db.run("UPDATE attendance_requests SET status=?,decided_by=?,decided_at=now(),decision_reason=? WHERE id=? AND status='pending'",b.status,req.user.id,reason(b.reason),request.id);if(!r.changes)fail('Request was already decided',409);
  if(request.kind==='capture_exception'){
   const states=await db.all("SELECT status FROM attendance_requests WHERE kind='capture_exception' AND proposed->>'attendance_id'=?",String(request.proposed.attendance_id));
   const state=states.some((s:any)=>s.status==='pending')?'pending':states.some((s:any)=>s.status==='rejected')?'rejected':'accepted';
   await db.run('UPDATE attendance SET review_state=? WHERE id=?',state,request.proposed.attendance_id);
  }else if(request.kind==='correction'&&b.status==='approved')await db.run("UPDATE attendance SET capture_state='review_closed' WHERE user_id=? AND date=? AND punch_in_time IS NOT NULL AND punch_out_time IS NULL",employee.user_id,request.work_date);
 });res.json({message:'Decision recorded; original evidence retained'});
}));

router.get('/periods',action('attendance_periods','view',async(_req,res)=>res.json(await pg.all('SELECT * FROM attendance_periods ORDER BY month DESC'))));
router.post('/periods/close',action('attendance_periods','approve',async(req,res)=>{
 const b=req.body;if(!validMonth(b.month)||b.month>=isoDay().slice(0,7))fail('Only a completed calendar month can be closed');const why=reason(b.reason);
 const result=await pg.tx(async db=>{await writeLock(db);const prior=await db.get('SELECT * FROM attendance_periods WHERE month=?',b.month);if(prior?.state==='closed')fail('Already closed',409);
  const revision=prior?.revision||1;const employees=await db.all("SELECT * FROM employees WHERE (join_date IS NULL OR join_date='' OR left(join_date,7)<=?) AND (employment_end_date IS NULL OR employment_end_date='' OR left(employment_end_date,7)>=?)",b.month,b.month);
  const snapshots=[];for(const e of employees){const report=await calculateAttendanceMonth(db,e,b.month,{live:true});if(!report.ready)fail(`${e.name}: ${report.exceptions.length} unresolved attendance exceptions`,409);snapshots.push(report);}
  for(const r of snapshots)await db.run('INSERT INTO attendance_month_snapshots(month,revision,employee_id,payload,created_by) VALUES(?,?,?,?::jsonb,?)',b.month,revision,r.employee_id,r,req.user.id);
  await db.run("INSERT INTO attendance_periods(month,state,revision,changed_by) VALUES(?,'closed',?,?) ON CONFLICT(month) DO UPDATE SET state='closed',changed_by=excluded.changed_by,changed_at=now()",b.month,revision,req.user.id);
  await db.run("INSERT INTO attendance_period_events(month,revision,action,reason,actor_id) VALUES(?,?,'close',?,?)",b.month,revision,why,req.user.id);return {month:b.month,revision,count:snapshots.length};});res.json(result);
},true));
router.post('/periods/reopen',action('attendance_periods','approve',async(req,res)=>{
 const b=req.body;if(!validMonth(b.month))fail('Valid month required');
 await pg.tx(async db=>{await writeLock(db);const p=await db.get('SELECT * FROM attendance_periods WHERE month=?',b.month);if(p?.state!=='closed')fail('Period is not closed',409);
  await db.run("UPDATE attendance_periods SET state='open',revision=revision+1,changed_by=?,changed_at=now() WHERE month=?",req.user.id,b.month);
  await db.run("INSERT INTO attendance_period_events(month,revision,action,reason,actor_id) VALUES(?,?,'reopen',?,?)",b.month,p.revision+1,reason(b.reason),req.user.id);
 });res.json({message:'Reopened for amendments; previous snapshots and paid payroll remain preserved'});
},true));
router.get('/periods/:month/history',action('attendance_periods','view',async(req,res)=>res.json(await pg.all('SELECT * FROM attendance_period_events WHERE month=? ORDER BY id',req.params.month))));

router.get('/roster/history',action('attendance_rosters','view',async(req,res)=>{
 await target(req,'attendance_rosters','view',req.query.employee_id);if(!validDay(req.query.date))fail('Valid date required');
 res.json(await pg.all('SELECT r.*,t.name AS shift_name FROM attendance_roster_entries r LEFT JOIN attendance_shift_templates t ON t.id=r.template_id WHERE employee_id=? AND work_date=? ORDER BY r.id DESC',req.query.employee_id,req.query.date));
}));
router.get('/adjustments',action('payroll','view',async(req,res)=>res.json(await pg.all(`SELECT a.*,e.name AS employee_name FROM payroll_attendance_adjustments a JOIN employees e ON e.id=a.employee_id WHERE ${await scopeSql(req,'payroll','view','e.id',true)} ORDER BY a.id DESC LIMIT 300`))));
router.get('/adjustment-employees',action('payroll','view',async(req,res)=>res.json(await pg.all(`SELECT id,name FROM employees WHERE ${await scopeSql(req,'payroll','view','employees.id',true)} ORDER BY name`))));
router.post('/adjustments',action('payroll','edit',async(req,res)=>{
 const b=req.body,e=await target(req,'payroll','edit',b.employee_id),why=reason(b.reason);
 if(!validMonth(b.source_month)||!validMonth(b.target_month)||b.target_month<=b.source_month||!Number.isFinite(b.amount)||b.amount===0||Math.abs(b.amount)>10000000)fail('Valid source and later target month, and a nonzero amount required');
 const r=await pg.tx(async db=>{await assertOpen(db,b.target_month+'-01');
  const original=await db.get("SELECT * FROM payroll_runs WHERE employee_id=? AND month=? AND (paid=1 OR status='disbursed')",e.id,b.source_month);
  if(!original)fail('Source must be a saved paid payroll run',409);
  const period=await db.get('SELECT * FROM attendance_periods WHERE month=?',b.source_month);
  if(period?.state!=='closed'||period.revision<=original.attendance_revision)fail('Reopen, correct and close source attendance first',409);
  if(await db.get("SELECT id FROM payroll_runs WHERE employee_id=? AND month=? AND (status IN ('finalised','disbursed') OR paid=1)",e.id,b.target_month))fail('Target payroll is already finalized',409);
  return db.run('INSERT INTO payroll_attendance_adjustments(employee_id,source_month,source_revision,target_month,amount,reason,created_by) VALUES(?,?,?,?,?,?,?)',e.id,b.source_month,period.revision,b.target_month,b.amount,why,req.user.id);
 });res.status(201).json({id:r.lastInsertRowid});
}));
router.put('/adjustments/:id/decision',action('payroll','approve',async(req,res)=>{
 const row=await pg.get('SELECT * FROM payroll_attendance_adjustments WHERE id=?',req.params.id);if(!row)fail('Adjustment not found',404);
 const e=await target(req,'payroll','approve',row.employee_id);if(row.created_by===req.user.id||e.user_id===req.user.id)fail('Self approval is not allowed',403);
 if(!['approved','rejected'].includes(req.body.status))fail('Approve or reject required');const why=reason(req.body.reason);
 await pg.tx(async db=>{await assertOpen(db,row.target_month+'-01');
  if(await db.get("SELECT id FROM payroll_runs WHERE employee_id=? AND month=? AND (status IN ('finalised','disbursed') OR paid=1)",row.employee_id,row.target_month))fail('Target payroll is already finalized',409);
  const r=await db.run("UPDATE payroll_attendance_adjustments SET status=?,decided_by=?,decided_at=now(),decision_reason=? WHERE id=? AND status='pending'",req.body.status,req.user.id,why,row.id);if(!r.changes)fail('Already decided',409);
 });res.json({message:'Adjustment decision saved; original paid salary is unchanged'});
}));
export default router;
