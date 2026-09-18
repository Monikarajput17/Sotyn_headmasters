const fs=require('fs'),assert=require('assert/strict'),{Client}=require('pg');
const base='http://127.0.0.1:54321/functions/v1/api',fixtures=JSON.parse(fs.readFileSync('.local/role-demo-accounts.json','utf8'));
const passed=[],sessions={};
async function call(token,path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});const raw=await r.text();let data;try{data=JSON.parse(raw)}catch{throw Error(path+' '+r.status+' '+raw.slice(0,150))}return {status:r.status,data};}
async function ok(token,path,body){const r=await call(token,path,body);assert.equal(r.status,200,path+' '+JSON.stringify(r));return r.data;}
const pass=s=>{passed.push(s);console.log('PASS '+s)};
(async()=>{
 const db=new Client({connectionString:'postgresql://postgres:postgres@127.0.0.1:54322/postgres'});await db.connect();
 assert.equal((await db.query("SELECT value FROM app_settings WHERE key='local_environment'")).rows[0].value,'sotyn-headmasters-local');
 assert.equal(Number((await db.query("SELECT count(*) FROM roles r WHERE NOT EXISTS(SELECT 1 FROM role_permissions p WHERE p.role_id=r.id AND p.module='dashboard' AND p.can_view=1)")).rows[0].count),0);await db.end();
 assert.equal((await call(null,'/dashboard')).status,401);pass('Every existing role has Dashboard View; anonymous access is denied');
 const expected={employee:['attendance','tasks','occurrences','tickets','services'],manager:['attendance','tasks-review','attendance-review','employees','appointments','sales','revenue','commissions'],receptionist:['appointments','bills','sales','attendance'],cashier:['bills','sales','attendance'],stylist:['appointments','commissions','attendance'],viewer:['attendance','tasks','services'],admin:['revenue','commissions','employees','attendance-review']};
 for(const name of [...Object.keys(fixtures.accounts),'admin']){
  const login=name==='admin'?JSON.parse(fs.readFileSync('.local/test-login.json','utf8')):{username:fixtures.accounts[name].username,password:fixtures.password};
  const session=await ok(null,'/auth/login',login);sessions[name]=session;
  const data=await ok(session.token,'/dashboard');const ids=data.cards.map(c=>c.id);for(const id of expected[name])assert.ok(ids.includes(id),name+' missing '+id);
  if(!['manager','admin'].includes(name))assert.ok(!ids.includes('revenue'),name+' revenue leak');
  if(['employee','viewer','stylist'].includes(name))for(const id of ['sales','bills','clients','employees','stock'])assert.ok(!ids.includes(id),name+' leaked '+id);
  if(['employee','viewer','receptionist','cashier'].includes(name))assert.ok(!ids.includes('commissions'));
  for(const c of data.cards)assert.ok(c.href.startsWith('/')&&!c.href.startsWith('//'));
  for(const [kind,path] of [['tasks','/delegations'],['occurrences','/checklists'],['tickets','/help-tickets']]){
   const c=data.cards.find(c=>c.id===kind);if(!c)continue;const params=new URL('http://local'+c.href).search;
   assert.equal(Number(c.value),Number((await ok(session.token,`/work/${kind}${params}`)).total),name+' '+kind+' count');
   for(const suffix of ['overdue','review']){const card=data.cards.find(c=>c.id===kind+'-'+suffix);if(card)assert.equal(Number(card.value),Number((await ok(session.token,`/work/${kind}${new URL('http://local'+card.href).search}`)).total),name+' '+kind+' '+suffix);}
  }
  if(ids.includes('bills')){const c=data.cards.find(c=>c.id==='bills');const query=new URL('http://local'+c.href).searchParams;query.set('page','1');query.set('status','paid');assert.equal(Number(c.value),Number((await ok(session.token,'/salon/pos?'+query)).total));}
  if(name==='stylist'){
   const c=data.cards.find(c=>c.id==='commissions');assert.equal(Number(c.value),Number((await ok(session.token,'/salon/commissions'+new URL('http://local'+c.href).search)).totals.commission));
   for(const a of data.queues.find(q=>q.id==='appointments').items)assert.equal((await call(session.token,'/salon/appointments/'+a.id)).status,200);
  }
  if(name==='employee'){
   const forged=await ok(session.token,'/dashboard?scope=all&user_id=1&role=admin');assert.deepEqual(forged.cards,data.cards);
   assert.equal((await call(session.token,'/salon/commissions/dashboard/stats')).status,403);
  }
  pass(name+': permitted cards and matching detail counts; restricted data absent');
 }
 fs.writeFileSync('.local/dashboard-sessions.json',JSON.stringify(sessions));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.writeFileSync('.local/dashboard-api-results.json',JSON.stringify({passed,failed:!!process.exitCode,at:new Date().toISOString()},null,2)));
