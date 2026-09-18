const fs=require('fs'),assert=require('assert/strict'),crypto=require('crypto'),{Client,types}=require('pg');types.setTypeParser(20,Number);
const db=new Client({connectionString:'postgresql://postgres:postgres@127.0.0.1:54322/postgres'}),base='http://127.0.0.1:54321/functions/v1/api',f=JSON.parse(fs.readFileSync('.local/workflow-fixtures.json','utf8')),tag='reliability'+Date.now(),passed=[];
let owner,manager,employee,other,original;
const q=async(s,...p)=>(await db.query(s,p)).rows;
async function req(token,path,method='GET',body,key=crypto.randomUUID()){const r=await fetch(base+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});return {status:r.status,data:await r.json()};}
async function ok(...args){const r=await req(...args);assert.ok(r.status<300,JSON.stringify(r));return r.data;}
async function test(name,fn){await fn();passed.push(name);console.log('PASS '+name);}
const day=n=>new Date(Date.now()+330*60000+n*86400000).toISOString().slice(0,10);
(async()=>{
 await db.connect();assert.equal((await q("SELECT value FROM app_settings WHERE key='local_environment'"))[0].value,'sotyn-headmasters-local');
 owner=(await ok('','/auth/login','POST',JSON.parse(fs.readFileSync('.local/test-login.json','utf8')))).token;
 await test('Cross-origin retry headers and lazy-route parity preserve the API contract',async()=>{
  const r=await fetch(base+'/work/tasks',{method:'OPTIONS',headers:{Origin:'https://frontend.example.test','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type,idempotency-key'}});assert.equal(r.status,200);assert.ok(r.headers.get('access-control-allow-headers').includes('idempotency-key'));
  const mounts=['salon','chat','staff','hr','ops'].flatMap(name=>[...fs.readFileSync(`supabase/functions/api/routes/${name}.mounts.ts`,'utf8').matchAll(/\["(\/[^"\s]+)",/g)].map(m=>m[1]));
  const expected=[...mounts,'/auth','/upload','/salon/services','/announcements','/attendance-ops','/work'].sort();
  const actual=[...fs.readFileSync('supabase/functions/api/routes/lazy-mounts.ts','utf8').matchAll(/\['(\/[^'\s]+)',lazy/g)].map(m=>m[1]).sort();assert.deepEqual(actual,expected);
 });
 for(const [key,person] of [['manager',f.manager],['employee',f.a],['other',f.b]]){const token=(await ok('','/auth/login','POST',{username:person.username,password:f.password})).token;if(key==='manager')manager=token;else if(key==='employee')employee=token;else other=token;}
 await test('All-record View does not lend its scope to branch-limited Edit',async()=>{
  const role=(await q("INSERT INTO roles(name,description) VALUES($1,'Synthetic fixture') RETURNING id",'af'+Date.now()+'readonly'))[0].id;
  await q('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',f.manager.uid,role);
  await q("INSERT INTO role_permissions(role_id,module,can_view,scope_mode) VALUES($1,'delegations',1,'all')",role);
  const ownerId=(await ok(owner,'/auth/me')).id;
  const t=await ok(owner,'/work/tasks','POST',{title:tag+' restricted',description:'Other branch only',assigned_to:f.b.uid,branch_id:f.branchB,due_at:new Date(Date.now()+86400000).toISOString(),reviewer_id:ownerId,review_required:true,evidence_required:false,priority:'medium'});
  await ok(manager,`/work/tasks/${t.id}`);
  assert.equal((await req(manager,`/work/tasks/${t.id}/actions`,'POST',{action:'update',version:t.work_version,note:'Unauthorized',assigned_to:f.b.uid,due_at:new Date(Date.now()+172800000).toISOString()})).status,403);
  await q('DELETE FROM user_roles WHERE user_id=$1 AND role_id=$2',f.manager.uid,role);
 });
 await test('Server pagination, search and explicit filter scopes remain bounded',async()=>{
  const r=await ok(employee,'/work/tasks?limit=1&sort=oldest&scope=all');assert.equal(r.rows.length,1);assert.ok(r.total>=1);
  const next=await ok(employee,'/work/tasks?limit=1&page=2&sort=oldest&scope=all');if(next.rows.length)assert.notEqual(r.rows[0].id,next.rows[0].id);
  const absent=await ok(employee,'/work/tasks?search=nonexistent_'+tag);assert.equal(absent.total,0);
 });
 async function oldTemplate(missed){
  // Seed historical synthetic configuration to simulate a scheduler outage.
  const id=(await q("INSERT INTO checklists(title,assigned_to,created_by,branch_id,frequency) VALUES($1,$2,$3,$4,'daily') RETURNING id",tag+missed,f.a.uid,f.manager.uid,f.branchA))[0].id;
  const definition={title:tag+missed,branch_id:f.branchA,instructions:'Historical outage fixture',assignees:[f.a.uid],effective_from:day(-2),review_required:false,items:[{id:'one',label:'Fixture',required:true,evidence:'none'}],schedule:{frequency:'daily',start:day(-2),due_time:'09:00',timezone:'Asia/Kolkata',missed}};
  const vid=(await q('INSERT INTO work_checklist_versions(checklist_id,version,definition,created_by) VALUES($1,1,$2::jsonb,$3) RETURNING id',id,JSON.stringify(definition),f.manager.uid))[0].id;
  await q('UPDATE checklists SET work_meta=$1::jsonb WHERE id=$2',JSON.stringify({state:'active',definition,template_version_id:vid}),id);return id;
 }
 await test('Missed-run catch-up and skip policies generate correct dates without duplicates',async()=>{
  const catchup=await oldTemplate('catch_up'),skip=await oldTemplate('skip');await ok(owner,'/work/jobs/run','POST',{});await ok(owner,'/work/jobs/run','POST',{});
  const days=await q("SELECT to_char(work_date,'YYYY-MM-DD') AS day FROM work_occurrences WHERE checklist_id=$1 ORDER BY work_date",catchup);assert.deepEqual(days.map(x=>x.day),[day(-2),day(-1),day(0)]);
  assert.equal((await q('SELECT count(*) AS c FROM work_occurrences WHERE checklist_id=$1',skip))[0].c,1);
  await q("UPDATE checklists SET work_meta=jsonb_set(work_meta,'{state}','\"retired\"') WHERE id IN($1,$2)",catchup,skip);
 });
 await test('Escalations retry once and waiting-for-information pauses the timers',async()=>{
  original=await ok(owner,'/work/settings');
  const category={id:tag,label:'Synthetic escalation',active:true,assignee_id:f.manager.uid,response_minutes:1,resolution_minutes:2,escalation_ids:[f.manager.uid]};
  await ok(owner,'/work/settings','PUT',{version:original.version,value:{...original.value,escalations_enabled:true,categories:[...original.value.categories,category]}});
  let t=await ok(employee,'/work/tickets','POST',{title:tag,description:'Synthetic SLA check',branch_id:f.branchA,category:tag,priority:'medium'});
  await q("UPDATE support_tickets SET work_meta=jsonb_set(work_meta,'{opened_at}',to_jsonb((now()-interval '10 minutes')::text)) WHERE id=$1",t.id);
  await ok(owner,'/work/jobs/run','POST',{});await ok(owner,'/work/jobs/run','POST',{});
  assert.equal((await q("SELECT count(*) AS c FROM notifications WHERE dedupe_key LIKE $1",`work:sla:${t.id}:1:%`))[0].c,2);
  t=await ok(manager,`/work/tickets/${t.id}/actions`,'POST',{action:'start',version:t.work_version});t=await ok(manager,`/work/tickets/${t.id}/actions`,'POST',{action:'wait',version:t.work_version,note:'Need information'});
  await q("UPDATE support_tickets SET work_meta=jsonb_set(work_meta,'{sla_cycle}','2') WHERE id=$1",t.id);await ok(owner,'/work/jobs/run','POST',{});
  assert.equal((await q("SELECT count(*) AS c FROM notifications WHERE dedupe_key LIKE $1",`work:sla:${t.id}:2:%`))[0].c,0);
 });
 await test('Monthly shorter-month rules and timezone conversion at DST boundaries',async()=>{
  const {buildSync}=require('../../client/node_modules/esbuild');const out=buildSync({entryPoints:['supabase/functions/_shared/work-jobs.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['./pg.ts','./work-service.ts','./work-access.ts']});
  // Exercise the pure recurrence predicate from the same active implementation.
  const module={exports:{}};new Function('require','module','exports',out.outputFiles[0].text)(name=>({}),module,module.exports);
  const d={effective_from:'2026-01-01',schedule:{start:'2026-01-01',frequency:'monthly',month_day:31}};
  assert.equal(module.exports.scheduled(d,'2026-02-28'),true);assert.equal(module.exports.scheduled(d,'2026-02-27'),false);
  const rows=await q("SELECT ('2026-03-08 09:00'::timestamp AT TIME ZONE 'America/New_York') AS after,('2026-03-07 09:00'::timestamp AT TIME ZONE 'America/New_York') AS before");assert.equal(rows[0].before.toISOString(),'2026-03-07T14:00:00.000Z');assert.equal(rows[0].after.toISOString(),'2026-03-08T13:00:00.000Z');
 });
 await test('Unassigned tickets notify scoped triage; internal text stays out of generic audit',async()=>{
  let ticket=await ok(employee,'/work/tickets','POST',{title:tag+' triage',description:'Synthetic unassigned ticket',branch_id:f.branchA,category:'general',priority:'medium'});
  const rows=await q("SELECT user_id,channel_sent FROM notifications WHERE link_url=$1 AND dedupe_key LIKE 'work:%'",`/help-tickets?record=${ticket.id}`);assert.ok(rows.some(r=>r.user_id===f.manager.uid));assert.ok(!rows.some(r=>r.user_id===f.b.uid));assert.ok(rows.every(r=>r.channel_sent==='in_app'));
  const note=tag+' internal detail';ticket=await ok(manager,`/work/tickets/${ticket.id}/actions`,'POST',{action:'reply',version:ticket.work_version,note,internal:true});
  assert.equal((await q('SELECT count(*) AS c FROM audit_log WHERE body_summary LIKE $1','%'+note+'%'))[0].c,0);
  assert.ok(!(await ok(employee,`/work/tickets/${ticket.id}`)).events.some(e=>e.detail.note===note));
 });
 await test('Earlier checklist submissions remain readable only within record scope',async()=>{
  await q("INSERT INTO checklist_completions(checklist_id,user_id,completion_date,notes) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",f.template_id,f.a.uid,day(-5),'Synthetic historical completion');
  const history=await ok(manager,`/work/templates/${f.template_id}/legacy-history`);assert.ok(history.rows.some(r=>r.notes==='Synthetic historical completion'));
  assert.equal((await req(other,`/work/templates/${f.template_id}/legacy-history`)).status,404);
 });
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
 if(original){try{const now=await ok(owner,'/work/settings');await ok(owner,'/work/settings','PUT',{version:now.version,value:{...original.value,categories:now.value.categories.map(c=>c.id===tag?{...c,active:false}:c)}});}catch(e){console.error(e);process.exitCode=1;}}
 fs.writeFileSync('.local/workflow-reliability-results.json',JSON.stringify({passed,failed:!!process.exitCode,at:new Date().toISOString()},null,2));await db.end();
});
