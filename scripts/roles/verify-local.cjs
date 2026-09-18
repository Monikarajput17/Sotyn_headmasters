const fs=require('fs'),assert=require('assert/strict'),crypto=require('crypto'),{Client}=require('pg');
const {defaults}=require('./defaults.cjs');
require('pg').types.setTypeParser(20,Number);
const db=new Client({connectionString:'postgresql://postgres:postgres@127.0.0.1:54322/postgres'}),base='http://127.0.0.1:54321/functions/v1/api';
const passed=[],accounts={},password='SyntheticTest-2026!';
async function request(token,path,method='GET',body){
 const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID(),...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
 const raw=await r.text();let data;try{data=JSON.parse(raw)}catch{throw Error(path+' '+r.status+' '+raw.slice(0,120))}return {status:r.status,data};
}
async function ok(token,path,method,body){const r=await request(token,path,method,body);assert.ok(r.status<300,path+' '+JSON.stringify(r));return r.data;}
const q=async(sql,...args)=>(await db.query(sql,args)).rows;
const pass=name=>{passed.push(name);console.log('PASS '+name)};
(async()=>{
 await db.connect();assert.equal((await q("SELECT value FROM app_settings WHERE key='local_environment'"))[0].value,'sotyn-headmasters-local');
 for(const role of defaults){const rows=await q('SELECT p.* FROM role_permissions p JOIN roles r ON r.id=p.role_id WHERE r.name=$1',role.name);for(const p of role.permissions){const actual=rows.find(r=>r.module===p.module);for(const key of Object.keys(p))assert.equal(String(actual[key]),String(p[key]),role.name+' '+p.module+' '+key);}}
 pass('All 10 shared role defaults match saved permission ticks and scopes');
 const fixture=JSON.parse(fs.readFileSync('.local/workflow-fixtures.json','utf8'));
 const owner=await ok(null,'/auth/login','POST',JSON.parse(fs.readFileSync('.local/test-login.json','utf8')));
 const config=await ok(owner.token,'/work/settings');
 const priority=config.value.priorities.find(p=>p.active).id;
 const category=config.value.categories.find(c=>c.active&&!c.assignee_id).id;
 for(const [key,role] of Object.entries({receptionist:'Receptionist',cashier:'Cashier',stylist:'Stylist',viewer:'Viewer'})){
  const username='local-role-'+key;let u=(await q('SELECT id FROM users WHERE username=$1',username))[0];
  if(!u){const rid=(await q('SELECT id FROM roles WHERE name=$1',role))[0].id;u=(await ok(owner.token,'/auth/register','POST',{name:'Local Test '+role,username,email:username+'@example.test',password,role:'user',role_ids:[rid]})).user;}
  let e=(await q('SELECT id FROM employees WHERE user_id=$1',u.id))[0];
  if(!e)e=(await q("INSERT INTO employees(user_id,name,status,salary,attendance_branch_id,reporting_manager_id_1) VALUES($1,$2,'active',0,$3,$4) RETURNING id",u.id,'Local Test '+role,fixture.branchA,(await q('SELECT id FROM employees WHERE user_id=$1',fixture.manager.uid))[0].id))[0];
  const login=await ok(null,'/auth/login','POST',{username,password});accounts[key]={username,uid:Number(u.id),eid:e.id,token:login.token};
 }
 accounts.employee={...fixture.a,...await ok(null,'/auth/login','POST',{username:fixture.a.username,password:fixture.password})};
 accounts.manager={...fixture.manager,...await ok(null,'/auth/login','POST',{username:fixture.manager.username,password:fixture.password})};
 for(const key of ['employee','manager','receptionist','cashier','stylist']){
  const me=await ok(accounts[key].token,'/auth/me');assert.equal(me.permissions.attendance_capture.can_create,1,key);assert.equal(me.permissions.help_tickets.can_create,1,key);
  assert.ok(!me.permissions.permission_admin?.can_view,key);assert.ok(!me.permissions.payroll?.can_view,key);assert.ok(!me.permissions.work_settings?.can_view,key);
  assert.equal((await request(accounts[key].token,'/auth/roles')).status,403,key);
  assert.equal((await request(accounts[key].token,'/work/settings')).status,403,key);
  await ok(accounts[key].token,'/attendance/my-capture-context');await ok(accounts[key].token,'/work/tasks?scope=all');
 }
 pass('Five staff roles receive self-service and cannot administer roles, workflow settings or payroll');
 const viewer=await ok(accounts.viewer.token,'/auth/me');assert.ok(!viewer.permissions.attendance_capture?.can_create);assert.ok(!viewer.permissions.help_tickets?.can_create);
 assert.equal((await request(accounts.viewer.token,'/work/tickets','POST',{title:'Viewer must not create',description:'Synthetic denied action',branch_id:fixture.branchA,category,priority})).status,403);
 pass('New Viewer login remains read-only without automatic staff write grants');
 for(const key of ['receptionist','cashier','manager'])for(const url of ['/salon/appointments','/salon/clients','/salon/pos','/salon/services','/salon/products','/salon/stylists','/salon/memberships/plans'])await ok(accounts[key].token,url);
 for(const key of ['employee','receptionist','cashier','stylist','viewer'])assert.equal((await request(accounts[key].token,'/salon/commissions/dashboard/stats')).status,403,key);
 await ok(accounts.manager.token,'/salon/commissions/dashboard/stats');
 pass('Salon operations load for front desk/cashier/manager; financial dashboard is restricted');
 const team=(await ok(accounts.manager.token,'/hr/employees'));assert.ok(team.some(e=>e.user_id===fixture.a.uid));assert.ok(!team.some(e=>e.user_id===fixture.b.uid));assert.ok(team.every(e=>!Object.hasOwn(e,'salary')));
 assert.equal((await request(accounts.employee.token,'/hr/employees')).status,403);
 const work=await ok(accounts.manager.token,'/work/tasks?scope=all');assert.ok(work.rows.some(r=>r.id===fixture.task_id));
 const other=await ok((await ok(null,'/auth/login','POST',{username:fixture.b.username,password})).token,'/work/tasks?scope=all');assert.ok(!other.rows.some(r=>r.id===fixture.task_id));
 pass('Manager sees direct-report work and staff without salaries; unrelated employees remain excluded');
 const ticket=await ok(accounts.employee.token,'/work/tickets','POST',{title:'Local default-role triage check',description:'Synthetic role verification',branch_id:fixture.branchA,category,priority});
 await ok(accounts.manager.token,`/work/tickets/${ticket.id}`);
 pass('Manager can see an unassigned ticket raised by a direct report');
 let own=(await q('SELECT id FROM stylists WHERE employee_id=$1',accounts.stylist.eid))[0];
 if(!own)own=(await q('INSERT INTO stylists(name,employee_id,commission_pct) VALUES($1,$2,10) RETURNING id','Local Role Test Stylist',accounts.stylist.eid))[0];
 let outsider=(await q("SELECT id FROM stylists WHERE name='Local Role Other Stylist'"))[0];
 if(!outsider)outsider=(await q("INSERT INTO stylists(name,employee_id,commission_pct) SELECT 'Local Role Other Stylist',id,10 FROM employees WHERE user_id=$1 RETURNING id",fixture.b.uid))[0];
 const ownAppt=(await q("INSERT INTO appointments(appt_no,stylist_id,appt_date,start_time) VALUES($1,$2,CURRENT_DATE,'10:00') RETURNING id",'ROLE-'+Date.now(),own.id))[0];
 const otherAppt=(await q("INSERT INTO appointments(appt_no,stylist_id,appt_date,start_time) VALUES($1,$2,CURRENT_DATE,'11:00') RETURNING id",'ROLE-OTHER-'+Date.now(),outsider.id))[0];
 const sales=(await q("INSERT INTO pos_sales(invoice_no,total,notes) VALUES($1,200,'Synthetic role isolation sale') RETURNING id",'ROLE-'+Date.now()))[0];
 for(const st of [own,outsider])await q("INSERT INTO pos_sale_items(sale_id,name,stylist_id,line_total,commission_amount) VALUES($1,'Synthetic role test service',$2,100,10)",sales.id,st.id);
 const apps=await ok(accounts.stylist.token,'/salon/appointments');assert.ok(apps.some(a=>a.id===ownAppt.id));assert.ok(apps.every(a=>a.stylist_id===own.id));
 assert.equal((await request(accounts.stylist.token,`/salon/appointments/${otherAppt.id}`)).status,404);
 assert.equal((await request(accounts.stylist.token,`/salon/appointments?stylist_id=${outsider.id}`)).data.length,0);
 const commissions=await ok(accounts.stylist.token,'/salon/commissions');assert.ok(commissions.rows.length);assert.ok(commissions.rows.every(r=>r.stylist_id===own.id));
 assert.equal((await ok(accounts.stylist.token,`/salon/commissions/${outsider.id}/detail`)).length,0);
 assert.equal((await request(accounts.stylist.token,`/salon/appointments/${ownAppt.id}/status`,'PATCH',{status:'completed'})).status,403);
 pass('Stylist lists, direct URLs, filters and commissions enforce employee-linked ownership');
 await ok(accounts.manager.token,'/salon/appointments','POST',{appt_date:new Date().toISOString().slice(0,10),start_time:'12:00',stylist_id:own.id,notes:'Synthetic manager permission check',services:[]});
 pass('Manager can create a salon booking with the saved shared-calendar permission');
 // Only ignored local fixtures contain tokens; no credentials are committed.
 fs.writeFileSync('.local/role-demo-accounts.json',JSON.stringify({password,accounts},null,2));
 const rows=Object.entries(accounts).map(([k,v])=>`| ${k} | ${v.username} | ${password} |`).join('\n');
 fs.writeFileSync('.local/ROLE-DEMO.md',`# Local role testing\n\nhttp://127.0.0.1:3055\n\n| Role | Username | Password |\n|---|---|---|\n| Admin | local-admin | LocalTest123! |\n${rows}\n\nManager staff/work access follows direct reporting relationships. Salon booking, client and billing access is shared across the salon. No payroll or permission administration for staff.\n`);
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{fs.writeFileSync('.local/role-verification.json',JSON.stringify({passed,failed:!!process.exitCode,at:new Date().toISOString()},null,2));await db.end()});
