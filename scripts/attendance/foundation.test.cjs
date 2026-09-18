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
 const branchA=(await q('INSERT INTO attendance_branches(code,name) VALUES($1,$2) RETURNING id',tag+'A','Synthetic Branch A'))[0].id;
 const branchB=(await q('INSERT INTO attendance_branches(code,name) VALUES($1,$2) RETURNING id',tag+'B','Synthetic Branch B'))[0].id;
 async function person(label,branch,admin=false){
  const email=tag+label+'@example.test';
  const response=await fetch(config.API_URL+'/auth/v1/admin/users',{method:'POST',headers:{Authorization:'Bearer '+config.SERVICE_ROLE_KEY,apikey:config.SERVICE_ROLE_KEY,'Content-Type':'application/json'},body:JSON.stringify({email,password,email_confirm:true})});
  const account=await response.json();assert.ok(response.ok,JSON.stringify(account));
  const uid=Number((await q('INSERT INTO users(name,username,email,password,role,active,archived,track_location,auth_user_id) VALUES($1,$2,$3,$4,$5,1,0,0,$6) RETURNING id','Synthetic '+label,tag+label,email,require('bcryptjs').hashSync(password,4),admin?'admin':'user',account.id))[0].id);
  const eid=Number((await q('INSERT INTO employees(user_id,name,status,salary,attendance_branch_id) VALUES($1,$2,$3,0,$4) RETURNING id',uid,'Synthetic '+label,'active',branch))[0].id);
  await q("INSERT INTO employee_shifts(employee_id,effective_from,shift_start,shift_end,week_off_day) VALUES($1,'2026-01-01','09:00','19:00',1)",eid);
  return {uid,eid,username:tag+label};
 }
 const a=await person('employeeA',branchA),b=await person('employeeB',branchB),manager=await person('manager',branchA),admin=await person('deniedAdmin',branchA,true),multi=await person('multi',branchA),branchUser=await person('branchViewer',branchA);
 await q('UPDATE employees SET reporting_manager_id_1=$1 WHERE id=$2',manager.eid,a.eid);
 async function role(person,label,module,scope='self',actions=['view'],branches=[]){
  const id=(await q('INSERT INTO roles(name,description) VALUES($1,$2) RETURNING id',tag+label+module,'Synthetic fixture'))[0].id;
  await q('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',person.uid,id);
  await q('INSERT INTO role_permissions(role_id,module,can_view,can_create,can_edit,can_delete,can_approve,can_see_all,scope_mode,scope_branches) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',id,module,...['view','create','edit','delete','approve'].map(x=>actions.includes(x)?1:0),scope==='all'?1:0,scope,JSON.stringify(branches));
  return id;
 }
 for(const p of [a,b,manager,multi,branchUser]){
  const scope=p===manager?'team':p===branchUser?'branch':'self';
  for(const m of ['attendance','employees','employee_shifts','attendance_tracking'])await role(p,p.username,m,scope,['view',...(p===manager&&m==='attendance'?['approve']:[])],p===branchUser?[Number(branchA)]:[]);
 }
 for(const p of [a,b])await role(p,p.username,'attendance_capture','self',['view','create']);
 await role(a,'leaveRequest','attendance','self',['create']);
 await role(manager,'managerCorrections','attendance_corrections','team',['approve']);
 await role(manager,'managerShifts','employee_shifts','team',['view','edit']);
 await role(manager,'ownLeave','attendance','team',['create']);
 await role(multi,'denyRole','attendance','all',[]);
 await role(multi,'allowRole','attendance','self',['view']);
 await role(multi,'noScopeBorrow','employee_shifts','all',[]);
 for(const p of [a,b,manager,admin,multi,branchUser])p.token=(await ok(null,'/auth/login','POST',{username:p.username,password})).token;
 const ids=[a,b,manager,admin,multi,branchUser].map(p=>p.uid);
 const eids=[a,b,manager,admin,multi,branchUser].map(p=>p.eid);
 for(const p of [a,b,manager,multi,branchUser])await q("INSERT INTO attendance(user_id,date,status,admin_marked) VALUES($1,'2026-08-03','present',1)",p.uid);
 await q('INSERT INTO geofence_settings(site_name,latitude,longitude,radius_meters,active,attendance_branch_id) VALUES($1,28.6,77.2,200,1,$2)',tag+' Synthetic Salon',branchA);
 await test('Owner permission-management recovery path',async()=>{const me=await ok(owner,'/auth/me');assert.equal(me.permissions.permission_admin.can_view,1);await ok(owner,'/auth/foundation-access');});
 await test('Only permission owner can configure location branch access',async()=>{
  const setup=await ok(owner,'/auth/foundation-access');const site=setup.locations.find(v=>v.site_name===tag+' Synthetic Salon');assert.ok(site);
  assert.equal((await request(manager.token,`/auth/foundation-access/locations/${site.id}`,'PUT',{attendance_branch_id:branchB})).status,403);
  await ok(owner,`/auth/foundation-access/locations/${site.id}`,'PUT',{attendance_branch_id:branchA});
  assert.equal(Number((await q('SELECT attendance_branch_id FROM geofence_settings WHERE id=$1',site.id))[0].attendance_branch_id),Number(branchA));
 });
 await test('Employee list and attendance return own rows only',async()=>{const emps=await ok(a.token,'/hr/employees');assert.deepEqual(emps.map(x=>Number(x.id)),[a.eid]);const rows=await ok(a.token,'/attendance?date=2026-08-03');assert.deepEqual(rows.map(x=>Number(x.user_id)),[a.uid]);});
 await test('Employee cannot select another user or employee shift',async()=>{assert.equal((await request(a.token,'/attendance?user_id='+b.uid)).status,403);assert.equal((await request(a.token,`/hr/employees/${b.eid}/shifts`)).status,403);assert.equal((await request(a.token,`/attendance/track/${b.uid}/2026-08-03`)).status,403);});
 await test('Manager sees own employee and direct team only',async()=>{const emps=await ok(manager.token,'/hr/employees');assert.deepEqual(emps.map(x=>Number(x.id)).sort(),[a.eid,manager.eid].sort());assert.equal((await request(manager.token,'/attendance?user_id='+b.uid)).status,403);});
 await test('Branch scope is enforced by backend',async()=>{const rows=await ok(branchUser.token,'/hr/employees');assert.ok(rows.some(e=>Number(e.id)===a.eid));assert.ok(!rows.some(e=>Number(e.id)===b.eid));assert.equal((await request(branchUser.token,`/hr/employees/${b.eid}/shifts`)).status,403);});
 await test('Shift writes enforce team scope and input validation',async()=>{
  const shift={effective_from:'2026-11-01',shift_start:'10:00',shift_end:'20:00',week_off_day:2};
  await ok(manager.token,`/hr/employees/${a.eid}/shifts`,'POST',shift);
  assert.equal((await request(manager.token,`/hr/employees/${b.eid}/shifts`,'POST',shift)).status,403);
  assert.equal((await request(manager.token,`/hr/employees/${a.eid}/shifts`,'POST',{...shift,shift_start:'24:99'})).status,400);
  assert.equal((await request(manager.token,`/hr/employees/${a.eid}/shifts`,'POST',{...shift,shift_start:'22:00',shift_end:'06:00'})).status,409);
 });
 await test('Employee directory and hierarchy cannot bypass record scopes',async()=>{for(const route of ['/auth/users','/auth/users/hierarchy']){const rows=await ok(a.token,route);assert.deepEqual(rows.map(u=>Number(u.id)),[a.uid]);}});
 await test('Multiple roles aggregate consistently without scope borrowing',async()=>{const me=await ok(multi.token,'/auth/me');assert.equal(me.permissions.attendance.can_view,1);assert.equal(me.permissions.attendance.can_see_all,0);await ok(multi.token,'/attendance');assert.equal((await request(multi.token,`/hr/employees/${b.eid}/shifts`)).status,403);});
 await test('Admin label cannot bypass business permissions or manage roles',async()=>{for(const route of ['/attendance','/hr/employees','/payroll/settings','/admin/locations/live','/auth/foundation-access'])assert.equal((await request(admin.token,route)).status,403,route);assert.equal((await request(admin.token,'/auth/roles','POST',{name:tag+'Unauthorized'})).status,403);});
 let halfLeave;
 await test('Half-day leave persists exactly 0.5 through active API',async()=>{halfLeave=await ok(a.token,'/attendance/leave','POST',{leave_type:'half_day',from_date:'2026-08-04',reason:'Synthetic test'});assert.equal(Number((await q('SELECT days FROM leave_requests WHERE id=$1',halfLeave.id))[0].days),0.5);});
 await test('Manager approves permitted leave and cannot decide it twice',async()=>{await ok(manager.token,`/attendance/leave/${halfLeave.id}/approve`,'PUT',{status:'approved'});assert.equal((await request(manager.token,`/attendance/leave/${halfLeave.id}/approve`,'PUT',{status:'rejected'})).status,409);});
 await test('Decided leave cannot be edited or deleted',async()=>{assert.equal((await request(owner,`/attendance/leave/${halfLeave.id}`,'PUT',{days:1})).status,409);assert.equal((await request(owner,`/attendance/leave/${halfLeave.id}`,'DELETE')).status,409);assert.equal(Number((await q('SELECT days FROM leave_requests WHERE id=$1',halfLeave.id))[0].days),0.5);});
 await test('Self leave approval and manual correction rejected',async()=>{const l=await ok(manager.token,'/attendance/leave','POST',{leave_type:'half_day',from_date:'2026-08-05'});assert.equal((await request(manager.token,`/attendance/leave/${l.id}/approve`,'PUT',{status:'approved'})).status,403);assert.equal((await request(manager.token,'/attendance/admin-mark','POST',{user_id:manager.uid,date:'2026-08-06',status:'present'})).status,403);});
 await test('Scoped manager correction still works for direct report',async()=>{await ok(manager.token,'/attendance/admin-mark','POST',{user_id:a.uid,date:'2026-08-06',status:'present'});assert.equal((await request(manager.token,'/attendance/admin-mark','POST',{user_id:b.uid,date:'2026-08-06',status:'present'})).status,403);});
 const unlinked=Number((await q('INSERT INTO employees(name,status,salary) VALUES($1,$2,0) RETURNING id','Synthetic employeeA','active'))[0].id);eids.push(unlinked);
 await test('Name/email auto-link endpoint does not guess identity',async()=>{assert.equal((await request(owner,'/hr/employees/auto-link','POST',{})).status,410);assert.equal((await q('SELECT user_id FROM employees WHERE id=$1',unlinked))[0].user_id,null);});
 await test('Employee create with matching email does not auto-link',async()=>{const e=await ok(owner,'/hr/employees','POST',{name:'Synthetic matching name',email:tag+'employeeA@example.test',salary:0});eids.push(e.id);assert.equal((await q('SELECT user_id FROM employees WHERE id=$1',e.id))[0].user_id,null);});
 await test('Employee creation cannot bypass compensation or relationship authority',async()=>{
  await role(multi,'creator','employees','all',['create']);
  assert.equal((await request(multi.token,'/hr/employees','POST',{name:'Synthetic forbidden pay',salary:100})).status,403);
  assert.equal((await request(multi.token,'/hr/employees/bulk','POST',{employees:[{name:'Synthetic forbidden bulk pay',salary:100}]})).status,403);
  assert.equal((await request(multi.token,'/hr/employees','POST',{name:'Synthetic forbidden manager',salary:0,reporting_manager_id_1:manager.eid})).status,403);
 });
 await test('Explicit stable linking and employee update preserve identity',async()=>{
  const isolated=await person('unassignedLogin',branchA);ids.push(isolated.uid);eids.push(isolated.eid);
  await q('UPDATE employees SET user_id=NULL WHERE id=$1',isolated.eid);
  await ok(owner,'/attendance/link-login','POST',{employee_id:isolated.eid,user_id:isolated.uid});
  await ok(owner,`/hr/employees/${isolated.eid}`,'PUT',{name:'Synthetic changed name'});
  assert.equal(Number((await q('SELECT user_id FROM employees WHERE id=$1',isolated.eid))[0].user_id),isolated.uid);
 });
 await test('Explicit login linking rejects existing assigned or invalid login',async()=>{assert.equal((await request(owner,'/attendance/link-login','POST',{employee_id:unlinked,user_id:a.uid})).status,409);assert.equal((await request(owner,'/attendance/link-login','POST',{employee_id:unlinked,user_id:99999999})).status,403);});
 const snapshot=async()=>JSON.stringify(await Promise.all([
  q('SELECT * FROM employees WHERE id=ANY($1::bigint[]) ORDER BY id',eids),q('SELECT * FROM attendance WHERE user_id=ANY($1::bigint[]) ORDER BY id',ids),q('SELECT * FROM leave_requests WHERE user_id=ANY($1::bigint[]) ORDER BY id',ids),q('SELECT * FROM employee_shifts WHERE employee_id=ANY($1::bigint[]) ORDER BY id',eids),q('SELECT * FROM payroll_settings ORDER BY id'),q('SELECT * FROM payroll_runs ORDER BY id')]));
 await test('Relevant GETs leave business data unchanged',async()=>{await q('UPDATE users SET auto_mark_present=1 WHERE id=$1',b.uid);const before=await snapshot();for(const route of ['/attendance/dashboard','/attendance/grid?month=2026-08','/attendance/report?month=8&year=2026','/attendance/leaves','/hr/employees','/payroll/settings',`/payroll/calculate/${unlinked}?month=2026-08`,'/payroll/leave-balances?year=2026'])await ok(owner,route);assert.equal(await snapshot(),before);});
 const body=()=>({request_id:crypto.randomUUID(),latitude:28.6,longitude:77.2,accuracy:10,photo,captured_at:new Date().toISOString()});
 await test('Invalid capture rejected before writing',async()=>{for(const patch of [{latitude:91},{photo:''},{accuracy:-1},{request_id:''}])assert.equal((await request(a.token,'/attendance/punch-in','POST',{...body(),...patch})).status,400);});
 const punch=body();let attendanceId;
 await test('Concurrent identical punch-in is idempotent',async()=>{const responses=await Promise.all(Array.from({length:6},()=>request(a.token,'/attendance/punch-in','POST',punch)));assert.ok(responses.every(r=>r.status===200),JSON.stringify(responses));attendanceId=responses[0].data.id;assert.ok(responses.every(r=>r.data.id===attendanceId));assert.equal(Number((await q('SELECT count(*) n FROM attendance_capture_events WHERE user_id=$1 AND kind=$2',a.uid,'in'))[0].n),1);});
 await test('Concurrent different request IDs cannot create another session',async()=>{const rows=await Promise.all([request(a.token,'/attendance/punch-in','POST',body()),request(a.token,'/attendance/punch-in','POST',body())]);assert.ok(rows.every(r=>r.status===409));assert.equal(Number((await q('SELECT count(*) n FROM attendance WHERE user_id=$1 AND date=$2',a.uid,workDate()))[0].n),1);});
 await test('Reused request ID cannot replace evidence',async()=>{assert.equal((await request(a.token,'/attendance/punch-in','POST',{...punch,latitude:28.601})).status,409);});
 const checkout=body();
 await test('Concurrent checkout records one original event',async()=>{const responses=await Promise.all(Array.from({length:5},()=>request(a.token,'/attendance/punch-out','POST',checkout)));assert.ok(responses.every(r=>r.status===200),JSON.stringify(responses));assert.equal(Number((await q('SELECT count(*) n FROM attendance_capture_events WHERE attendance_id=$1',attendanceId))[0].n),2);});
 await test('Fresh checkout retry cannot overwrite original evidence',async()=>{const before=JSON.stringify(await q('SELECT * FROM attendance WHERE id=$1',attendanceId));assert.equal((await request(a.token,'/attendance/punch-out','POST',body())).status,409);assert.equal(JSON.stringify(await q('SELECT * FROM attendance WHERE id=$1',attendanceId)),before);await ok(a.token,'/attendance/punch-out','POST',checkout);});
 await test('Captured events keep capture and receipt timestamps',async()=>{const events=await q('SELECT * FROM attendance_capture_events WHERE attendance_id=$1',attendanceId);assert.ok(events.every(e=>e.captured_at&&e.received_at&&e.payload_hash));assert.equal((await ok(a.token,'/attendance/my-today')).date,workDate());});
 await test('Original punch cannot be deleted through legacy route',async()=>{assert.equal((await request(owner,'/attendance/'+attendanceId,'DELETE')).status,409);});
 await test('Missing check-in produces explicit exception',async()=>{const r=await request(b.token,'/attendance/punch-out','POST',body());assert.equal(r.status,409);assert.equal(r.data.code,'CHECK_IN_REQUIRED');});
 await test('Legacy duplicates retained and flagged, not auto-deleted',async()=>{await q('INSERT INTO attendance(user_id,date,status) VALUES($1,$2,$3),($1,$2,$3)',b.uid,workDate(),'present');const r=await request(b.token,'/attendance/punch-in','POST',body());assert.equal(r.status,409);assert.equal(r.data.code,'ATTENDANCE_CONFLICT');assert.equal(Number((await q('SELECT count(*) n FROM attendance WHERE user_id=$1 AND date=$2',b.uid,workDate()))[0].n),2);});
 await test('Scoped totals and tracking directory exclude other branch',async()=>{const r=await ok(branchUser.token,'/attendance/dashboard');assert.ok(!r.todayRecords.some(x=>Number(x.user_id)===b.uid));assert.ok(!r.notPunched.some(x=>Number(x.id)===b.uid));const tr=await ok(manager.token,'/admin/locations/users');assert.ok(!tr.some(x=>Number(x.id)===b.uid));});
 await test('Owner can save role scopes without dropping unrelated grants',async()=>{
  const rid=await role(multi,'scopeEditor','employee_shifts','self',['view']);
  await ok(owner,`/auth/roles/${rid}/permissions`,'PUT',{permissions:[{module:'attendance',can_view:1,scope_mode:'branch',scope_branches:[Number(branchA)]}]});
  const saved=await ok(owner,`/auth/roles/${rid}/permissions`);assert.ok(saved.some(r=>r.module==='employee_shifts'));
  const rows=await ok(multi.token,'/attendance?date=2026-08-03');assert.ok(rows.some(r=>Number(r.user_id)===a.uid));assert.ok(!rows.some(r=>Number(r.user_id)===b.uid));
 });
 await test('Permission manager can operate without admin status or attendance grants',async()=>{
  const delegate=await person('permissionDelegate',branchA);ids.push(delegate.uid);eids.push(delegate.eid);
  await q('INSERT INTO attendance_permission_managers(user_id) VALUES($1)',delegate.uid);
  const login=await ok(null,'/auth/login','POST',{username:delegate.username,password});assert.equal(login.user.role,'user');
  await ok(login.token,'/auth/foundation-access');await ok(login.token,'/auth/roles');
  assert.equal((await request(login.token,'/attendance')).status,403);
  assert.equal((await request(owner,`/auth/users/${delegate.uid}/archive`,'PATCH',{archived:1})).status,409);
 });
 await test('Server action hints match scoped and self-approval restrictions',async()=>{
  const grid=await ok(manager.token,'/attendance/grid?month=2026-08');
  assert.equal(grid.employees.find(e=>Number(e.employee_id)===a.eid).can_correct,true);
  assert.equal(grid.employees.find(e=>Number(e.employee_id)===manager.eid).can_correct,false);
  const employees=await ok(manager.token,'/hr/employees');assert.equal(employees.find(e=>Number(e.id)===a.eid).can_assign_shift,true);
 });
 const output={at:new Date().toISOString(),tag,method:'Local Supabase Auth -> Edge API -> PostgreSQL',results,fixtureUsers:ids,fixtureEmployees:eids,branches:[branchA,branchB],productionAccess:false};
 fs.mkdirSync(path.join(root,'.local'),{recursive:true});fs.writeFileSync(path.join(root,'.local/attendance-foundation-results.json'),JSON.stringify(output,null,2));
 console.log(JSON.stringify({passed:results.length,tag,fixtureUsers:ids}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(db)await db.end();});
