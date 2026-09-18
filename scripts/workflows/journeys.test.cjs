// Real local Auth -> mounted Edge API -> PostgreSQL + private Storage journeys.
const fs=require('fs'),assert=require('assert/strict'),crypto=require('crypto'),{Client}=require('pg');
require('pg').types.setTypeParser(20,Number);
const base='http://127.0.0.1:54321/functions/v1/api',tag='af'+Date.now(),password='SyntheticTest-2026!';
const db=new Client({connectionString:'postgresql://postgres:postgres@127.0.0.1:54322/postgres'});
const passed=[],fixture={tag,password};let originalSettings,owner;
async function request(token,path,method='GET',body,key=crypto.randomUUID()){
 const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json','Idempotency-Key':key,...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
 const raw=await r.text();let data;try{data=JSON.parse(raw);}catch{throw Error(`${method} ${path}: HTTP ${r.status}; non-JSON response ${raw.slice(0,200)}`);}return {status:r.status,data};
}
async function ok(token,path,method='GET',body,key){const r=await request(token,path,method,body,key);assert.ok(r.status<300,`${method} ${path}: ${JSON.stringify(r)}`);return r.data;}
const q=async(sql,...args)=>(await db.query(sql,args)).rows;
async function test(name,fn){await fn();passed.push(name);console.log('PASS '+name);}
(async()=>{
 await db.connect();assert.equal((await q("SELECT value FROM app_settings WHERE key='local_environment'"))[0]?.value,'sotyn-headmasters-local');
 owner=(await ok(null,'/auth/login','POST',JSON.parse(fs.readFileSync('.local/test-login.json','utf8')))).token;
 const ba=(await q('INSERT INTO attendance_branches(code,name) VALUES($1,$2) RETURNING id',tag+'A','Workflow test salon A'))[0].id;
 const bb=(await q('INSERT INTO attendance_branches(code,name) VALUES($1,$2) RETURNING id',tag+'B','Workflow test salon B'))[0].id;
 async function person(label,branch){
  const uid=(await q("INSERT INTO users(name,username,email,password,role,active,archived,track_location) VALUES($1,$2,$3,$4,'user',1,0,0) RETURNING id",'Workflow test '+label,tag+label,tag+label+'@example.test',require('bcryptjs').hashSync(password,4)))[0].id;
  const eid=(await q("INSERT INTO employees(user_id,name,status,salary,attendance_branch_id) VALUES($1,$2,'active',0,$3) RETURNING id",uid,'Workflow test '+label,branch))[0].id;
  const token=(await ok(null,'/auth/login','POST',{username:tag+label,password})).token;
  return {uid,eid,username:tag+label,token};
 }
 const a=await person('employee',ba),b=await person('other',bb),manager=await person('manager',ba);
 await q('UPDATE employees SET reporting_manager_id_1=$1 WHERE id=$2',manager.eid,a.eid);
 const employeeRole=(await q("SELECT id FROM roles WHERE name='Employee work self-service'"))[0].id;
 for(const p of [a,b])await q('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',p.uid,employeeRole);
 const role=(await q("INSERT INTO roles(name,description) VALUES($1,'Synthetic fixture') RETURNING id",tag+'workmanager'))[0].id;
 await q('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',manager.uid,role);
 for(const module of ['delegations','checklists','help_tickets'])await q("INSERT INTO role_permissions(role_id,module,can_view,can_create,can_edit,can_approve,scope_mode,scope_branches) VALUES($1,$2,1,1,1,1,'branch',$3)",role,module,JSON.stringify([ba]));
 originalSettings=await ok(owner,'/work/settings');
 const cat={id:tag.toLowerCase(),label:'Synthetic equipment support',active:true,assignee_id:manager.uid,response_minutes:5,resolution_minutes:20,escalation_ids:[manager.uid]};
 await ok(owner,'/work/settings','PUT',{version:originalSettings.version,value:{...originalSettings.value,categories:[...originalSettings.value.categories,cat],escalations_enabled:true}});
 Object.assign(fixture,{a:{uid:a.uid,username:a.username},b:{uid:b.uid,username:b.username},manager:{uid:manager.uid,username:manager.username},branchA:ba,branchB:bb,category:cat.id});
 let task,proof,ticket,template,occurrence;
 const create={title:'Synthetic opening task '+tag,description:'Prepare the reception; attach a completion note file.',assigned_to:a.uid,branch_id:ba,due_at:new Date(Date.now()+86400000).toISOString(),priority:'high',review_required:true,evidence_required:true,reviewer_id:manager.uid};
 await test('Role-based assignment, creation retry and scoped direct reads',async()=>{
  const key=crypto.randomUUID();task=await ok(manager.token,'/work/tasks','POST',create,key);const retry=await ok(manager.token,'/work/tasks','POST',create,key);assert.equal(task.id,retry.id);
  assert.equal((await request(manager.token,'/work/tasks','POST',{...create,title:'Different'},key)).status,409);
  assert.equal((await request(b.token,`/work/tasks/${task.id}`)).status,404);
  assert.equal((await request(manager.token,'/work/tasks','POST',{...create,branch_id:bb,assigned_to:b.uid})).status,403);
  const own=await ok(a.token,'/work/tasks?scope=all');assert.ok(own.rows.some(t=>t.id===task.id));assert.ok(own.rows.every(t=>t.assigned_to===a.uid));
 });
 const act=async(p,kind,row,action,extra={})=>ok(p.token,`/work/${kind}/${row.id}/actions`,'POST',{action,version:row.work_version,...extra});
 await test('Concurrent updates reject stale writes and invalid transitions',async()=>{
  assert.equal((await request(manager.token,`/work/tasks/${task.id}/actions`,'POST',{action:'approve',version:task.work_version})).status,409);
  const r=await Promise.all([request(a.token,`/work/tasks/${task.id}/actions`,'POST',{action:'start',version:task.work_version}),request(a.token,`/work/tasks/${task.id}/actions`,'POST',{action:'start',version:task.work_version})]);
  assert.deepEqual(r.map(x=>x.status).sort(),[200,409]);task=r.find(x=>x.status===200).data;
 });
 async function upload(token,kind,id,key=crypto.randomUUID(),type='text/plain',name='evidence.txt',content='Synthetic completion evidence'){
  const fd=new FormData();fd.append('file',new Blob([content],{type}),name);
  const r=await fetch(`${base}/work/${kind}/${id}/files`,{method:'POST',headers:{Authorization:'Bearer '+token,'Idempotency-Key':key},body:fd});const data=await r.json();return {status:r.status,data};
 }
 await test('Private evidence validates content, ownership and retry identity',async()=>{
  assert.equal((await upload(b.token,'tasks',task.id)).status,404);
  assert.equal((await upload(a.token,'tasks',task.id,crypto.randomUUID(),'image/png','fake.png','not an image')).status,400);
  const key=crypto.randomUUID(),r=await upload(a.token,'tasks',task.id,key);assert.equal(r.status,200,JSON.stringify(r));proof=r.data;
  assert.equal((await upload(a.token,'tasks',task.id,key)).data.id,proof.id);
  const url=await ok(a.token,`/work/files/${proof.id}/download`);assert.equal((await fetch(url.url)).status,200);
  assert.equal((await request(b.token,`/work/files/${proof.id}/download`)).status,404);
 });
 await test('Employee submits; manager returns; corrected evidence is approved with history',async()=>{
  task=await act(a,'tasks',task,'submit',{note:'Ready for inspection',evidence:[proof.id]});assert.equal(task.status,'submitted');
  assert.equal((await request(a.token,`/work/tasks/${task.id}/actions`,'POST',{action:'approve',version:task.work_version})).status,403);
  task=await act(manager,'tasks',task,'return',{note:'Add confirmation of reception cleaning'});assert.equal(task.status,'rejected');
  task=await act(a,'tasks',task,'start');task=await act(a,'tasks',task,'submit',{note:'Reception cleaned and checked',evidence:[proof.id]});task=await act(manager,'tasks',task,'approve');assert.equal(task.status,'approved');
  const persisted=await ok(a.token,`/work/tasks/${task.id}`);assert.equal(persisted.status,'approved');assert.ok(persisted.events.some(e=>e.action==='return'));
 });
 await test('Blocked task links to a ticket without changing task state',async()=>{
  task=await ok(manager.token,'/work/tasks','POST',{...create,title:'Synthetic blocked task '+tag});task=await act(a,'tasks',task,'block',{note:'Sterilizer does not start'});
  ticket=await ok(a.token,'/work/tickets','POST',{title:'Sterilizer issue '+tag,description:'Power switch does not respond',branch_id:ba,category:cat.id,priority:'high',link:{kind:'tasks',id:task.id}});
  assert.equal(ticket.assigned_to,manager.uid);assert.equal((await ok(a.token,`/work/tasks/${task.id}`)).status,'blocked');
  assert.ok((await ok(a.token,`/work/tasks/${task.id}`)).events.some(e=>e.action==='ticket_linked'));
 });
 await test('Internal notes stay private; requester information resumes paused timers',async()=>{
  ticket=await act(manager,'tickets',ticket,'reply',{note:'Synthetic internal technician note',internal:true});
  assert.ok(!(await ok(a.token,`/work/tickets/${ticket.id}`)).events.some(e=>e.detail.note==='Synthetic internal technician note'));
  assert.ok((await ok(manager.token,`/work/tickets/${ticket.id}`)).events.some(e=>e.internal));
  ticket=await act(manager,'tickets',ticket,'start');ticket=await act(manager,'tickets',ticket,'wait',{note:'Please provide the error light code'});assert.ok(ticket.work_meta.pause_started);
  ticket=await act(a,'tickets',ticket,'reply',{note:'The red light flashes twice'});assert.equal(ticket.status,'in_progress');assert.equal(ticket.work_meta.pause_started,null);
 });
 await test('Support resolves; requester closes/reopens; linked task remains blocked',async()=>{
  ticket=await act(manager,'tickets',ticket,'resolve',{note:'Replaced the test fuse'});assert.equal(ticket.status,'resolved');
  ticket=await act(a,'tickets',ticket,'close');assert.equal(ticket.status,'closed');
  ticket=await act(a,'tickets',ticket,'reopen',{note:'Fault reappeared'});assert.equal(ticket.status,'assigned');assert.equal(ticket.work_meta.sla_cycle,2);
  assert.equal((await ok(a.token,`/work/tasks/${task.id}`)).status,'blocked');
  assert.equal((await request(b.token,`/work/tickets/${ticket.id}/actions`,'POST',{action:'close',version:ticket.work_version})).status,404);
 });
 const today=new Date(Date.now()+330*60000).toISOString().slice(0,10);
 const def={title:'Synthetic hygiene checklist '+tag,instructions:'Editable salon example',effective_from:today,assignees:[a.uid],review_required:false,schedule:{frequency:'daily',start:today,end:null,due_time:'18:00',timezone:'Asia/Kolkata',missed:'catch_up'},items:[{id:'clean',section:'Hygiene',label:'Sanitize station',required:true,evidence:'note',allow_na:false},{id:'towels',section:'Supplies',label:'Check towels',required:true,evidence:'none',allow_na:true}]};
 await test('Template scheduling retries create exactly one occurrence with correct timezone',async()=>{
  template=await ok(manager.token,'/work/templates','POST',{branch_id:ba,definition:def});
  await ok(owner,'/work/jobs/run','POST',{});await ok(owner,'/work/jobs/run','POST',{});
  const rows=(await ok(a.token,'/work/occurrences?today=1')).rows.filter(o=>o.checklist_id===template.id);assert.equal(rows.length,1);occurrence=rows[0];assert.equal(new Date(occurrence.due_at).toISOString(),today+'T12:30:00.000Z');
 });
 await test('Checklist drafts persist, required evidence and NA rules are enforced',async()=>{
  assert.equal((await request(b.token,`/work/occurrences/${occurrence.id}`)).status,404);
  assert.equal((await request(a.token,`/work/occurrences/${occurrence.id}/actions`,'POST',{action:'submit',version:occurrence.work_version,answers:{}})).status,400);
  occurrence=await act(a,'occurrences',occurrence,'save',{answers:{clean:{status:'done',note:'Disinfectant applied'},towels:{status:'todo'}}});
  assert.equal((await ok(a.token,`/work/occurrences/${occurrence.id}`)).work_meta.answers.clean.note,'Disinfectant applied');
  assert.equal((await request(a.token,`/work/occurrences/${occurrence.id}/actions`,'POST',{action:'submit',version:occurrence.work_version,answers:{clean:{status:'na',note:'cannot'},towels:{status:'done'}}})).status,400);
  occurrence=await act(a,'occurrences',occurrence,'submit',{answers:{clean:{status:'done',note:'Disinfectant applied'},towels:{status:'na',note:'No towel service today'}}});assert.equal(occurrence.status,'approved');
 });
 await test('Template edits and pause/retire preserve submitted snapshots',async()=>{
  template=await ok(manager.token,`/work/templates/${template.id}`,'PUT',{version:template.work_version,branch_id:ba,definition:{...def,title:'Revised synthetic hygiene',items:[...def.items,{id:'extra',label:'New requirement',required:true,evidence:'none'}]}});
  const historical=await ok(a.token,`/work/occurrences/${occurrence.id}`);assert.equal(historical.definition.items.length,2);assert.equal(historical.status,'approved');
  template=await act(manager,'templates',template,'pause');await ok(owner,'/work/jobs/run','POST',{});template=await act(manager,'templates',template,'retire');
  assert.equal((await request(manager.token,`/work/templates/${template.id}/actions`,'POST',{action:'resume',version:template.work_version})).status,400);
 });
 await test('Legacy APIs, role configuration and settings cannot bypass access',async()=>{
  const rows=await ok(b.token,'/support?scope=unexpected');assert.ok(!rows.some(t=>t.id===ticket.id));
  assert.equal((await request(b.token,`/hr/checklists/${template.id}/complete`,'POST',{notes:'unauthorized'})).status,409);
  assert.equal((await request(a.token,'/work/settings')).status,403);assert.equal((await request(manager.token,'/work/jobs/run','POST',{})).status,403);
  assert.equal((await request(a.token,'/auth/roles')).status,403);
 });
 await test('In-app notifications persist once and opening screens creates no work records',async()=>{
  const notifications=await q("SELECT * FROM notifications WHERE user_id IN($1,$2) AND dedupe_key LIKE 'work:%'",a.uid,manager.uid);assert.ok(notifications.length>0);assert.ok(notifications.every(n=>n.channel_sent==='in_app'));
  assert.equal(new Set(notifications.map(n=>n.dedupe_key)).size,notifications.length);
  const before=(await q('SELECT count(*) AS c FROM work_events'))[0].c;
  await ok(a.token,`/work/tasks/${task.id}`);await ok(a.token,'/work/occurrences?today=1');await ok(a.token,`/work/tickets/${ticket.id}`);
  assert.equal((await q('SELECT count(*) AS c FROM work_events'))[0].c,before);
 });
 Object.assign(fixture,{task_id:task.id,ticket_id:ticket.id,template_id:template.id,occurrence_id:occurrence.id});
 fs.writeFileSync('.local/workflow-fixtures.json',JSON.stringify(fixture,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
 if(owner&&originalSettings){try{const current=await ok(owner,'/work/settings');await ok(owner,'/work/settings','PUT',{version:current.version,value:{...originalSettings.value,categories:current.value.categories.map(c=>c.id===tag?{...c,active:false}:c)}});}catch(e){console.error('Settings restore failed',e.message);process.exitCode=1;}}
 fs.writeFileSync('.local/workflow-test-results.json',JSON.stringify({passed,failed:process.exitCode?true:false,at:new Date().toISOString()},null,2));await db.end();
});
