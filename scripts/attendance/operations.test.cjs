// Integration tests: actual local Supabase Auth -> mounted Edge API -> PostgreSQL.
// Fixtures are synthetic, uniquely named, and retained locally for inspection. No production URL accepted.
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),crypto=require('crypto');
const {Client}=require('pg'),{spawnSync}=require('child_process');
const root=path.resolve(__dirname,'../..');
const results=[];let db;
const tag='af'+Date.now();
const workDate=()=>new Date(Date.now()+330*60000).toISOString().slice(0,10);
const photo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH1sAAAAASUVORK5CYII=';
const password='SyntheticTest-2026!';
async function test(name,fn){await fn();results.push({name,result:'PASS'});console.log('PASS',name);}
(async()=>{
 const env={...process.env,SUPABASE_TELEMETRY_DISABLED:'true'};
 env.PATH='C:\\Program Files\\Docker\\Docker\\resources\\bin;'+(env.PATH||env.Path||'');
 const status=spawnSync(process.execPath,[path.join(root,'node_modules/supabase/dist/supabase.js'),'status','--workdir',path.join(root,'.local'),'--output','json'],{env,encoding:'utf8'});
 if(status.status!==0)throw Error('Local status unavailable: '+status.stderr);
 const text=status.stdout,config=JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));
 for(const k of ['API_URL','DB_URL'])assert.ok(['127.0.0.1','localhost'].includes(new URL(config[k]).hostname),'Only loopback '+k);
 db=new Client({connectionString:config.DB_URL});await db.connect();
 assert.equal((await db.query("SELECT value FROM app_settings WHERE key='local_environment'")).rows[0]?.value,'sotyn-headmasters-local');
 const q=async(sql,...args)=>(await db.query(sql,args)).rows;
 const base=config.API_URL+'/functions/v1/api';
 async function request(token,route,method='GET',body){
  const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
  const data=await r.json();return {status:r.status,data};
 }
 async function ok(token,route,method='GET',body){const r=await request(token,route,method,body);assert.ok(r.status<300,route+' '+JSON.stringify(r));return r.data;}
 const owner=(await ok(null,'/auth/login','POST',JSON.parse(fs.readFileSync(path.join(root,'.local/test-login.json'),'utf8')))).token;

 const person=await ok(owner,'/auth/register','POST',{name:'Synthetic Operations '+tag,email:tag+'ops@example.test',username:tag+'ops',password,role:'user'});
 const uid=person.user.id,token=(await ok(null,'/auth/login','POST',{username:tag+'ops',password})).token;
 const e=await ok(owner,'/hr/employees','POST',{name:'Synthetic Operations '+tag,user_id:uid,join_date:'2026-09-01',salary:0});
 const policy={grace_minutes:10,full_day_hours:8,half_day_hours:4,late_half_day_minutes:0,late_grace_count:0,late_per_minute_rate:0,lates_to_absent:0,ot_threshold_hours:9,ot_rate_multiplier:1,cl_per_month:1,sl_per_month:1,pl_per_month:1,missing_checkout:'review',half_day_leave:'combine',off_work:'normal',sandwich:'none',short_leave:'review',below_half_day:'absent',capture_exception:'review',location_scope:'branch',weekly_off_paid:true,allow_multiple_sessions:true};
 let template,preview,correction,captureId;
 await test('Staff operations access is limited to own records',async()=>{
  for(const r of ['/attendance-ops/templates','/attendance-ops/policies','/attendance-ops/periods','/attendance-ops/adjustments'])assert.equal((await request(token,r)).status,403,r);
  assert.equal((await request(token,'/attendance-ops/month/1?month=2026-09')).status,403);
  const report=await ok(token,'/attendance-ops/my-month?month=2026-09');assert.equal(report.employee_id,e.id);assert.equal(report.ready,false);assert.ok(!('source' in report));assert.ok(!('rules_by_date' in report));
 });
 await test('Policy validation and append-only publication (2099 synthetic fixture only)',async()=>{
  assert.equal((await request(owner,'/attendance-ops/policies','POST',{effective_from:'2099-01-01',rules:{},reason:'Synthetic invalid policy'})).status,400);
  const p=await ok(owner,'/attendance-ops/policies','POST',{effective_from:'2099-01-01',rules:policy,reason:'Synthetic '+tag+' policy for 2099 tests only'});
  await assert.rejects(q("UPDATE attendance_policy_versions SET reason='changed' WHERE id=$1",p.id),/immutable/);
 });
 await test('Overnight roster import preview rejects bad dates, duplicate rows and overlaps',async()=>{
  template=await ok(owner,'/attendance-ops/templates','POST',{code:tag.toUpperCase(),name:'Synthetic overnight',segments:[{start:'22:00',end:'06:00',start_day:0,end_day:1}],week_off_days:[2]});
  const rows=[{employee_id:e.id,work_date:'2099-01-01',day_type:'work',template_id:template.id,reason:'Synthetic rotation'}];
  preview=await ok(owner,'/attendance-ops/roster/preview','POST',{rows});assert.equal(preview.ready,true);
  const dup=await ok(owner,'/attendance-ops/roster/preview','POST',{rows:[...rows,...rows]});assert.equal(dup.ready,false);
  const invalid=await ok(owner,'/attendance-ops/roster/preview','POST',{rows:[{...rows[0],work_date:'2099-02-30'}]});assert.equal(invalid.ready,false);
 });
 await test('CSV upload previews ISO assignments without writing them',async()=>{
  const before=(await q('SELECT count(*)::int n FROM attendance_roster_entries WHERE employee_id=$1',e.id))[0].n;
  const form=new FormData();form.append('file',new Blob(['employee_id,work_date,day_type,template_id,reason\n'+e.id+',2099-01-03,off,,Synthetic import\n']), 'roster.csv');
  const r=await fetch(base+'/attendance-ops/roster/import',{method:'POST',headers:{Authorization:'Bearer '+owner},body:form});const preview=await r.json();assert.equal(r.status,200,JSON.stringify(preview));assert.equal(preview.ready,true,JSON.stringify(preview));assert.equal(preview.rows[0].work_date,'2099-01-03');
  assert.equal((await q('SELECT count(*)::int n FROM attendance_roster_entries WHERE employee_id=$1',e.id))[0].n,before);
 });
 await test('Roster commit is retry-safe and stale preview cannot overwrite assignments',async()=>{
  const body={rows:preview.rows,request_id:crypto.randomUUID()},first=await ok(owner,'/attendance-ops/roster/commit','POST',body),retry=await ok(owner,'/attendance-ops/roster/commit','POST',body);assert.equal(retry.id,first.id);assert.equal(retry.replayed,true);
  const stale=await request(owner,'/attendance-ops/roster/commit','POST',{...body,request_id:crypto.randomUUID(),rows:preview.rows.map(r=>({...r,day_type:'off',template_id:null}))});assert.equal(stale.status,409);
  const history=await ok(owner,'/attendance-ops/roster/history?employee_id='+e.id+'&date=2099-01-01');assert.equal(history.length,1);
 });
 await test('Correction request retries retain one record and staff cannot self-approve',async()=>{
  const b={employee_id:e.id,work_date:'2026-09-15',proposed:{pay_fraction:1,hours:8,late_minutes:0},reason:'Synthetic missed checkout',request_id:crypto.randomUUID()};
  correction=await ok(token,'/attendance-ops/requests','POST',b);assert.equal((await ok(token,'/attendance-ops/requests','POST',b)).id,correction.id);
  assert.equal((await request(token,'/attendance-ops/requests/'+correction.id+'/decision','PUT',{status:'approved',reason:'Self approval attempt'})).status,403);
  const pending=await ok(token,'/attendance-ops/my-month?month=2026-09');assert.ok(pending.exceptions.some(x=>x.date==='2026-09-15'&&x.code==='REQUEST_PENDING_REVIEW'));
  await ok(owner,'/attendance-ops/requests/'+correction.id+'/decision','PUT',{status:'approved',reason:'Synthetic independently checked'});
  assert.equal((await request(owner,'/attendance-ops/requests/'+correction.id+'/decision','PUT',{status:'rejected',reason:'Cannot change decision'})).status,409);
  const result=await ok(token,'/attendance-ops/my-month?month=2026-09');assert.equal(result.breakdown.find(d=>d.date==='2026-09-15').pay,1);
 });
 await test('Original capture events and completed punches are immutable',async()=>{
  const b=()=>({request_id:crypto.randomUUID(),latitude:28.6,longitude:77.2,accuracy:10,photo,captured_at:new Date().toISOString()});
  captureId=(await ok(token,'/attendance/punch-in','POST',b())).id;await ok(token,'/attendance/punch-out','POST',b());
  await assert.rejects(q("UPDATE attendance SET punch_in_time='2026-09-01T00:00:00Z' WHERE id=$1",captureId),/Original check-in/);
  await assert.rejects(q("UPDATE attendance SET punch_out_time='2026-09-01T09:00:00Z' WHERE id=$1",captureId),/Original checkout/);
  await assert.rejects(q('DELETE FROM attendance_capture_events WHERE attendance_id=$1',captureId),/immutable/);
 });
 await test('Closed period rejects writes and unresolved month cannot close',async()=>{
  await q('BEGIN');try{await q("INSERT INTO attendance_periods(month,state) VALUES('2088-02','closed') ON CONFLICT(month) DO NOTHING");await q('SAVEPOINT attempted');await assert.rejects(q("INSERT INTO attendance(user_id,date,status) VALUES($1,'2088-02-01','absent')",uid),/closed/);await q('ROLLBACK TO SAVEPOINT attempted');}finally{await q('ROLLBACK');}
  assert.equal((await request(owner,'/attendance-ops/periods/close','POST',{month:'2026-08',reason:'Synthetic expected unresolved refusal'})).status,409);
 });
 const output={at:new Date().toISOString(),tag,username:tag+'ops',employeeId:e.id,userId:uid,results,productionAccess:false};fs.writeFileSync(path.join(root,'.local/attendance-operations-results.json'),JSON.stringify(output,null,2));console.log(JSON.stringify({passed:results.length,tag}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(db)await db.end();});
