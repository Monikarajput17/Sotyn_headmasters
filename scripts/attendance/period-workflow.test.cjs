// Shared attendance/payroll service against a transaction-isolated PostgreSQL schema.
// Entire schema and fixtures roll back, including the synthetic policy.
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),{Client}=require('pg');
const root=path.resolve(__dirname,'../..'),esbuild=require(path.join(root,'client/node_modules/esbuild'));
const compiled=esbuild.buildSync({entryPoints:[path.join(root,'supabase/functions/_shared/attendance-operations.ts')],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
const m={exports:{}};new Function('module','exports','require',compiled)(m,m.exports,require);
const {calculateAttendanceMonth,payrollFromAttendance}=m.exports;
const c=new Client({connectionString:'postgresql://postgres:postgres@127.0.0.1:54322/postgres'});
const results=[];async function test(name,fn){await fn();results.push(name);console.log('PASS',name);}
(async()=>{
 await c.connect();assert.equal((await c.query("SELECT value FROM app_settings WHERE key='local_environment'")).rows[0]?.value,'sotyn-headmasters-local');await c.query('BEGIN');
 const schema='attendance_test_'+Date.now();await c.query('CREATE SCHEMA '+schema);await c.query('SET LOCAL search_path TO '+schema+', public');
 for(const t of ['employees','attendance','leave_requests','employee_shifts','attendance_roster_entries','attendance_shift_templates','attendance_policy_versions','attendance_requests','attendance_periods','attendance_month_snapshots','payroll_runs','payroll_advances','payroll_attendance_adjustments','payroll_snapshot_history','attendance_period_events','payroll_settings'])await c.query(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
 const query=async(sql,args)=>{let i=0;return c.query(sql.replace(/\?/g,()=>'$'+(++i)),args);};
 const db={all:async(sql,...args)=>(await query(sql,args)).rows,get:async(sql,...args)=>(await query(sql,args)).rows[0],run:async(sql,...args)=>{if(/^\s*insert/i.test(sql)&&!/returning/i.test(sql)&&!/^\s*insert into attendance_periods[ (]/i.test(sql))sql+=' RETURNING id';const r=await query(sql,args);return {changes:r.rowCount,lastInsertRowid:r.rows[0]?.id};}};
 // Match Edge's numeric values.
 require('pg').types.setTypeParser(20,Number);require('pg').types.setTypeParser(1700,Number);
 const rules={grace_minutes:10,full_day_hours:8,half_day_hours:4,late_half_day_minutes:0,late_grace_count:0,late_per_minute_rate:5,lates_to_absent:0,ot_threshold_hours:9,ot_rate_multiplier:1,cl_per_month:1,sl_per_month:1,pl_per_month:1,missing_checkout:'review',half_day_leave:'combine',off_work:'normal',sandwich:'none',short_leave:'review',below_half_day:'absent',capture_exception:'review',location_scope:'branch',weekly_off_paid:true,allow_multiple_sessions:true};
 await db.run("INSERT INTO attendance_policy_versions(id,effective_from,rules,reason) VALUES(1,'2026-01-01',?,'Synthetic rolled-back rule')",rules);
 await db.run("INSERT INTO employees(id,user_id,name,status,join_date,salary) VALUES(1,1,'Synthetic month','active','2026-08-01',31000)");
 const employee=await db.get('SELECT * FROM employees WHERE id=1');
 await db.run("INSERT INTO employee_shifts(employee_id,effective_from,shift_start,shift_end,week_off_day) VALUES(1,'2026-08-01','11:00','19:00',2)");
 await db.run("INSERT INTO attendance(user_id,employee_id,date,punch_in_time,punch_out_time,capture_session) VALUES(1,1,'2026-08-03','2026-08-03T11:11:00+05:30','2026-08-03T19:11:00+05:30',1),(1,1,'2026-08-05','2026-08-05T11:00:00+05:30','2026-08-05T15:00:00+05:30',1)");
 await db.run("INSERT INTO leave_requests(id,user_id,leave_type,from_date,to_date,days,status) VALUES(1,1,'half_day','2026-08-05','2026-08-05',0.5,'approved')");

 let serial=0;db.tx=async fn=>{const save='route_'+(++serial);await c.query('SAVEPOINT '+save);try{const r=await fn(db);await c.query('RELEASE SAVEPOINT '+save);return r;}catch(e){await c.query('ROLLBACK TO SAVEPOINT '+save);await c.query('RELEASE SAVEPOINT '+save);throw e;}};
 for(const t of ['attendance','attendance_requests','attendance_policy_versions','attendance_month_snapshots','attendance_period_events','payroll_snapshot_history','payroll_attendance_adjustments','payroll_runs']){
  const triggers=(await c.query('SELECT pg_get_triggerdef(oid) AS ddl FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal',['public.'+t])).rows;
  for(const r of triggers)await c.query(r.ddl.replace(' ON public.'+t+' ',' ON '+schema+'.'+t+' '));
 }
 await db.run('INSERT INTO payroll_settings(id,basic_pct,conveyance_pct,hra_pct,adhoc_pct,misc_pct) VALUES(1,100,0,0,0,0)');
 await db.run("INSERT INTO employees(id,user_id,name,status,join_date,salary) VALUES(2,2,'Synthetic unpaid','active','2026-08-01',31000)");
 await db.run("INSERT INTO employee_shifts(employee_id,effective_from,shift_start,shift_end,week_off_day) VALUES(2,'2026-08-01','11:00','19:00',2)");
 global.__attendanceTestDb=db;
 const built=await esbuild.build({stdin:{contents:"export {default as ops} from './supabase/functions/api/routes/attendance-operations.ts'; export {default as payroll} from './supabase/functions/api/routes/payroll.ts'; export {App} from './supabase/functions/_shared/express-lite.ts';",resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'isolated-db-and-authorized-test-identities',setup(build){
  build.onResolve({filter:/\/(pg|auth|attendance-access)\.ts$/},args=>({path:args.path.split('/').pop(),namespace:'attendance-test'}));
  build.onLoad({filter:/.*/,namespace:'attendance-test'},args=>({contents:args.path==='pg.ts'?'export default globalThis.__attendanceTestDb;':args.path==='auth.ts'?"export const authMiddleware=(req,res,next)=>{req.user={id:Number(req.headers['x-test-user']||900)};next();};export const requirePermission=()=>authMiddleware;export const adminOnly=authMiddleware;":"export const permissionRows=async()=>[{scope_mode:'all'}];export const inScope=async()=>true;export const scopeSql=async()=> 'TRUE';export const idNumber=v=>Number(v)||null;",loader:'js'}));
 }}]});
 const bundle={exports:{}};new Function('module','exports','require',built.outputFiles[0].text)(bundle,bundle.exports,require);
 const {App,ops,payroll}=bundle.exports,app=new App();app.use('/attendance-ops',ops);app.use('/payroll',payroll);
 async function call(route,method='GET',body,actor=900){const response=await app.handle(new Request('http://localhost/api'+route,{method,headers:{'content-type':'application/json','x-test-user':String(actor)},body:body===undefined?undefined:JSON.stringify(body)}));return {status:response.status,data:await response.json()};}
 async function ok(route,method='GET',body,actor){const r=await call(route,method,body,actor);assert.ok(r.status<300,route+' '+JSON.stringify(r));return r.data;}
 await test('Close and finalize save immutable attendance and payroll snapshots',async()=>{
  const closed=await ok('/attendance-ops/periods/close','POST',{month:'2026-08',reason:'Synthetic close'});assert.equal(closed.count,2);
  const finalized=await ok('/payroll/finalise','POST',{month:'2026-08'});assert.equal(finalized.count,2);
  const first=await ok('/payroll/calculate/1?month=2026-08');assert.equal(first.net_pay,5995);assert.equal(first.locked,true);
  await assert.rejects(db.tx(db=>db.run("UPDATE attendance SET status='absent' WHERE employee_id=1")),/closed|evidence/);
 });
 await test('Mark paid cannot be reversed or overwritten',async()=>{
  await ok('/payroll/paid/1','PUT',{month:'2026-08',paid:true});assert.equal((await call('/payroll/paid/1','PUT',{month:'2026-08',paid:false})).status,409);
  await assert.rejects(db.tx(db=>db.run("UPDATE payroll_runs SET net_pay=1 WHERE employee_id=1 AND month='2026-08'")),/immutable/);
 });
 await test('Historical corrections require reopen and independent approval',async()=>{
  const body={employee_id:1,work_date:'2026-08-06',proposed:{pay_fraction:1,hours:8,late_minutes:0},request_id:crypto.randomUUID(),reason:'Synthetic correction'};
  assert.equal((await call('/attendance-ops/requests','POST',body)).status,409);
  await ok('/attendance-ops/periods/reopen','POST',{month:'2026-08',reason:'Synthetic historical amendment'});
  for(const employee_id of [1,2]){const r=await ok('/attendance-ops/requests','POST',{...body,employee_id,request_id:crypto.randomUUID()});assert.equal((await call('/attendance-ops/requests/'+r.id+'/decision','PUT',{status:'approved',reason:'Cannot self approve'})).status,403);await ok('/attendance-ops/requests/'+r.id+'/decision','PUT',{status:'approved',reason:'Independent review'},901);}
  const closed=await ok('/attendance-ops/periods/close','POST',{month:'2026-08',reason:'Synthetic corrected close'});assert.equal(closed.revision,2);
  assert.equal((await db.get("SELECT count(*)::int n FROM attendance_month_snapshots WHERE month='2026-08'")).n,4);
 });
 await test('Refinalization preserves paid salary and versions revised unpaid salary',async()=>{
  assert.equal((await ok('/payroll/finalise','POST',{month:'2026-08'})).count,1);
  assert.equal((await ok('/payroll/calculate/1?month=2026-08')).net_pay,5995);assert.equal((await ok('/payroll/calculate/2?month=2026-08')).net_pay,5000);
  const list=await ok('/payroll/calculate?month=2026-08');assert.equal(list.employees.find(e=>e.employee_id===1).net_pay,5995);
  assert.ok((await db.get('SELECT count(*)::int n FROM payroll_snapshot_history WHERE employee_id=2')).n>=3);
 });
 await test('Later adjustment needs a second approver and only affects its target month',async()=>{
  const a=await ok('/attendance-ops/adjustments','POST',{employee_id:1,source_month:'2026-08',target_month:'2026-09',amount:1000,reason:'Synthetic source revision difference'});
  assert.equal((await call('/attendance-ops/adjustments/'+a.id+'/decision','PUT',{status:'approved',reason:'Self approval attempt'})).status,403);
  const pending=await ok('/payroll/calculate/1?month=2026-09');assert.ok(pending.exceptions.some(e=>e.code==='PAYROLL_ADJUSTMENT_PENDING'));
  await ok('/attendance-ops/adjustments/'+a.id+'/decision','PUT',{status:'approved',reason:'Independent amount verification'},901);
  assert.equal((await ok('/payroll/calculate/1?month=2026-09')).attendance_adjustment,1000);assert.equal((await ok('/payroll/calculate/1?month=2026-08')).net_pay,5995);
 });
 fs.writeFileSync(path.join(root,'.local/attendance-period-workflow-results.json'),JSON.stringify({passed:results.length,results,at:new Date().toISOString(),database:'transaction-isolated local schema',identity:'authorized synthetic actors injected; real authorization tested separately',transactionRolledBack:true},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await c.query('ROLLBACK').catch(()=>{});await c.end();});
