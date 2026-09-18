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
 const prior=JSON.parse(fs.readFileSync(path.join(root,'.local/attendance-foundation-results.json'),'utf8'));
 const ids=[],eids=[],b={uid:prior.fixtureUsers[0]};
 const halfLeave=(await q("SELECT id FROM leave_requests WHERE status='approved' LIMIT 1"))[0];assert.ok(halfLeave,'Run the foundation fixture suite first');
 const body=()=>({request_id:crypto.randomUUID(),latitude:28.6,longitude:77.2,accuracy:10,photo,captured_at:new Date().toISOString()});
 let selfService, selfToken, selfRole;
 await test('New staff login receives only own attendance and capture defaults',async()=>{
  selfService=(await ok(owner,'/auth/register','POST',{name:'Synthetic Self Service',email:tag+'self@example.test',username:tag+'self',password,role:'user'})).user;
  ids.push(selfService.id);
  selfToken=(await ok(null,'/auth/login','POST',{username:tag+'self',password})).token;
  const me=await ok(selfToken,'/auth/me');assert.equal(me.permissions.attendance.can_view,1);assert.equal(me.permissions.attendance.can_view_others,0);assert.equal(me.permissions.attendance_capture.can_create,1);
  const ctx=await ok(selfToken,'/attendance/my-capture-context');assert.equal(ctx.employee_link_ready,false);assert.match(ctx.setup_message,/not linked/);assert.ok(ctx.locations.length);
  assert.equal((await request(selfToken,'/attendance/punch-in','POST',body())).status,409);
  selfRole=(await q("SELECT id FROM roles WHERE name='Employee attendance self-service'"))[0].id;
 });
 await test('Linked self-service employee can punch in/out and read own history',async()=>{
  const employee=await ok(owner,'/hr/employees','POST',{name:'Synthetic Self Service',user_id:selfService.id,salary:0});eids.push(employee.id);
  assert.equal((await ok(selfToken,'/attendance/my-capture-context')).employee_link_ready,true);
  await ok(selfToken,'/attendance/punch-in','POST',body());await ok(selfToken,'/attendance/punch-out','POST',body());
  const rows=await ok(selfToken,`/attendance/my-history?from=${workDate()}&to=${workDate()}&user_id=${b.uid}`);
  assert.equal(rows.length,1);assert.ok(rows.every(r=>Number(r.user_id)===Number(selfService.id)&&r.punch_in_time&&r.punch_out_time));
 });
 await test('Self-service grants no other-person access or management actions',async()=>{
  for(const route of [`/attendance?user_id=${b.uid}`,'/attendance/geofence','/hr/employees','/payroll/settings','/auth/foundation-access'])assert.equal((await request(selfToken,route)).status,403,route);
  assert.equal((await request(selfToken,'/attendance/admin-mark','POST',{user_id:b.uid,date:'2026-08-01',status:'present'})).status,403);
  assert.equal((await request(selfToken,`/attendance/leave/${halfLeave.id}/approve`,'PUT',{status:'approved'})).status,403);
  assert.equal((await ok(selfToken,'/attendance/leaves')).length,0);
 });
 await test('Owner can revoke self-service; login and GET do not restore it',async()=>{
  const profile={...selfService,active:1,role_ids:[]};
  await ok(owner,`/auth/users/${selfService.id}`,'PUT',profile);
  await ok(selfToken,'/auth/me');
  const refreshed=(await ok(null,'/auth/login','POST',{username:tag+'self',password})).token;
  assert.equal((await request(refreshed,'/attendance/my-today')).status,403);
  await ok(owner,`/auth/users/${selfService.id}`,'PUT',{...profile,role_ids:[selfRole]});
 });
 const output={at:new Date().toISOString(),tag,selfServiceUsername:tag+'self',results,fixtureUsers:ids,fixtureEmployees:eids,productionAccess:false};
 fs.writeFileSync(path.join(root,'.local/attendance-self-service-results.json'),JSON.stringify(output,null,2));
 console.log(JSON.stringify({passed:results.length,tag}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(db)await db.end();});
