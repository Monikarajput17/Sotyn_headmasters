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

 const account=await ok(owner,'/auth/register','POST',{name:'Synthetic Sessions '+tag,email:tag+'sessions@example.test',username:tag+'sessions',password,role:'user'});
 const uid=account.user.id,token=(await ok(null,'/auth/login','POST',{username:tag+'sessions',password})).token;
 const e=await ok(owner,'/hr/employees','POST',{name:'Synthetic Sessions '+tag,user_id:uid,join_date:'2026-09-01',salary:0});
 const today=workDate(),yesterday=new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10);
 const policy=(await q("SELECT * FROM attendance_policy_versions WHERE effective_from='2099-01-01' AND jsonb_typeof(rules)='object' ORDER BY id DESC LIMIT 1"))[0];assert.ok(policy,'Run operations suite first');
 const overnight=(await q("INSERT INTO attendance(user_id,employee_id,date,punch_in_time,capture_session,capture_state,policy_version_id,review_state) VALUES($1,$2,$3,$4,1,'open',$5,'accepted') RETURNING id",uid,e.id,yesterday,yesterday+'T22:00:00+05:30',policy.id))[0];
 const b=()=>({request_id:crypto.randomUUID(),latitude:28.6,longitude:77.2,accuracy:10,photo,captured_at:new Date().toISOString()});
 await test('Overnight checkout keeps original work date and missing evidence enters review',async()=>{
  const ctx=await ok(token,'/attendance/my-capture-context');assert.equal(ctx.capture_exception,'review');
  assert.equal((await request(token,'/attendance/punch-out','POST',{request_id:crypto.randomUUID()})).status,409);
  const body={request_id:crypto.randomUUID(),exception_reason:'Synthetic camera and GPS unavailable',captured_at:new Date().toISOString()};
  const out=await ok(token,'/attendance/punch-out','POST',body);assert.equal(out.work_date,yesterday);assert.equal(out.review_state,'pending');assert.equal((await ok(token,'/attendance/punch-out','POST',body)).replayed,true);
  const requestRow=(await ok(token,'/attendance-ops/requests')).find(r=>r.kind==='capture_exception');assert.ok(requestRow);assert.equal(requestRow.capture_evidence[0].evidence.photo,null);
  await ok(owner,'/attendance-ops/requests/'+requestRow.id+'/decision','PUT',{status:'approved',reason:'Synthetic exception accepted'});
  assert.equal((await q('SELECT review_state FROM attendance WHERE id=$1',overnight.id))[0].review_state,'accepted');
 });
 await test('Split roster supports two independent sessions without overwriting first checkout',async()=>{
  const t=await ok(owner,'/attendance-ops/templates','POST',{code:tag.toUpperCase(),name:'Synthetic split',segments:[{start:'09:00',end:'13:00'},{start:'17:00',end:'21:00'}],week_off_days:[]});
  const p=await ok(owner,'/attendance-ops/roster/preview','POST',{rows:[{employee_id:e.id,work_date:today,day_type:'work',template_id:t.id,reason:'Synthetic split test'}]});assert.equal(p.ready,true);
  await ok(owner,'/attendance-ops/roster/commit','POST',{rows:p.rows,request_id:crypto.randomUUID()});
  const first=await ok(token,'/attendance/punch-in','POST',b());await ok(token,'/attendance/punch-out','POST',b());
  const original=(await q('SELECT punch_out_time FROM attendance WHERE id=$1',first.id))[0].punch_out_time;
  const second=await ok(token,'/attendance/punch-in','POST',b());assert.notEqual(second.id,first.id);await ok(token,'/attendance/punch-out','POST',b());
  assert.equal((await q('SELECT punch_out_time FROM attendance WHERE id=$1',first.id))[0].punch_out_time,original);
  const sessions=await q('SELECT capture_session FROM attendance WHERE user_id=$1 AND date=$2 ORDER BY capture_session',uid,today);assert.deepEqual(sessions.map(s=>s.capture_session),[1,2]);
 });
 await test('Leave amendment approval retains original record and checks decision identity',async()=>{
  const leave=(await q("INSERT INTO leave_requests(user_id,leave_type,from_date,to_date,days,status) VALUES($1,'half_day','2026-09-10','2026-09-10',0.5,'approved') RETURNING id",uid))[0];
  const r=await ok(token,'/attendance-ops/requests','POST',{kind:'leave_amendment',employee_id:e.id,request_id:crypto.randomUUID(),reason:'Synthetic cancel approved half-day',proposed:{leave_id:Number(leave.id),action:'cancel'}});
  await ok(owner,'/attendance-ops/requests/'+r.id+'/decision','PUT',{status:'approved',reason:'Synthetic independent cancellation review'});
  assert.equal((await q('SELECT status FROM leave_requests WHERE id=$1',leave.id))[0].status,'approved');await assert.rejects(q("UPDATE leave_requests SET days=1 WHERE id=$1",leave.id),/immutable/);
 });
 fs.writeFileSync(path.join(root,'.local/attendance-sessions-results.json'),JSON.stringify({at:new Date().toISOString(),tag,username:tag+'sessions',employeeId:e.id,userId:uid,results},null,2));console.log(JSON.stringify({passed:results.length,tag}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(db)await db.end();});
