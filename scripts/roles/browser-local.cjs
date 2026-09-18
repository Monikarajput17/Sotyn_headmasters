const fs=require('fs'),assert=require('assert/strict');
const {chromium}=require('../../.local/validation/node_modules/playwright');
const {accounts}=JSON.parse(fs.readFileSync('.local/role-demo-accounts.json','utf8'));
const results=[],errors=[];let browser;
const expected={
 employee:['/attendance','/delegations','/checklists','/help-tickets','/salon/services'],
 manager:['/','/attendance','/employees','/delegations','/checklists','/help-tickets','/salon/appointments','/salon/billing','/salon/commissions'],
 receptionist:['/attendance','/salon/appointments','/salon/billing','/salon/clients','/help-tickets'],
 cashier:['/attendance','/salon/billing','/salon/clients','/help-tickets'],
 stylist:['/attendance','/salon/appointments','/salon/commissions','/help-tickets'],
 viewer:['/attendance','/salon/services','/delegations','/checklists','/help-tickets']
};
(async()=>{
 browser=await chromium.launch({channel:'msedge',headless:true});
 for(const [name,account] of Object.entries(accounts)){
  const ctx=await browser.newContext({viewport:{width:1440,height:1000}});
  await ctx.route('**/*',r=>['localhost','127.0.0.1'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());
  await ctx.addInitScript(t=>localStorage.setItem('token',t),account.token);
  const p=await ctx.newPage();p.setDefaultTimeout(45000);p.on('pageerror',e=>errors.push(name+': '+e.message));
  p.on('response',r=>{if(r.url().includes('/functions/v1/api')&&r.status()>=500)errors.push(name+': HTTP '+r.status()+' '+r.url())});
  await p.goto('http://127.0.0.1:3055/my-work');await p.getByText(/My tasks \(/).waitFor();
  const collapsed=await p.locator('button[title^="Expand "]').evaluateAll(nodes=>nodes.map(n=>n.title));
  for(const title of collapsed)await p.getByTitle(title,{exact:true}).click();
  const links=await p.locator('aside a').evaluateAll(nodes=>nodes.map(a=>a.getAttribute('href')));
  for(const href of expected[name])assert.ok(links.includes(href),name+' missing menu '+href+' got '+links.join(','));
  for(const href of ['/payroll','/admin/roles','/admin/users','/work-settings'])assert.ok(!links.includes(href),name+' leaked '+href);
  assert.ok(links.includes('/'),name+' personal dashboard should be visible');
  if(name==='manager'){
   await p.getByLabel('Work overview scope').selectOption('all');await p.getByRole('link',{name:/^Tasks \([1-9]/}).waitFor();
   await p.getByRole('link',{name:/^Tasks \(/}).click();await p.getByLabel('View',{exact:true}).waitFor();assert.equal(await p.getByLabel('View',{exact:true}).inputValue(),'all');
  }
  if(name==='employee'){
   await p.getByRole('link',{name:/^My tickets \(/}).click();await p.waitForURL('**/help-tickets*');
   await p.getByRole('button',{name:'Create ticket',exact:true}).waitFor();
  }
  if(['employee','manager'].includes(name)){
   await p.goto('http://127.0.0.1:3055/attendance');await p.getByRole('button',{name:'Punch In/Out',exact:true}).waitFor();
   assert.ok(!(await p.locator('body').innerText()).includes('Punching is not enabled'));
  }
  if(name==='stylist'){
   await p.goto('http://127.0.0.1:3055/salon/appointments');await p.getByRole('heading',{name:'Appointments',level:1}).waitFor();
   await p.goto('http://127.0.0.1:3055/salon/commissions');await p.getByRole('heading',{name:'Stylist Commissions'}).waitFor();
  }
  results.push(name+' menu visibility and allowed screens');console.log('PASS '+results.at(-1));await ctx.close();
 }
 const ownerResponse=await fetch('http://127.0.0.1:54321/functions/v1/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:fs.readFileSync('.local/test-login.json','utf8')});
 const owner=await ownerResponse.json();assert.ok(owner.token);
 const admin=await browser.newContext();await admin.route('**/*',r=>['localhost','127.0.0.1'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());
 await admin.addInitScript(t=>localStorage.setItem('token',t),owner.token);
 const p=await admin.newPage();p.setDefaultTimeout(45000);await p.goto('http://127.0.0.1:3055/admin/roles');
 await p.getByText('Employee work self-service',{exact:true}).click();
 await p.waitForFunction(()=>document.querySelector('[aria-label="Attendance capture: Create"]')?.getAttribute('aria-pressed')==='true');
 assert.equal(await p.getByRole('button',{name:'Payroll: View',exact:true}).getAttribute('aria-pressed'),'false');
 await p.getByText('Salon Manager',{exact:true}).click();
 await p.waitForFunction(()=>document.querySelector('[aria-label="Delegations scope"]')?.value==='team');
 assert.equal(await p.getByRole('button',{name:'Help Tickets: Approve',exact:true}).getAttribute('aria-pressed'),'true');
 results.push('Admin role editor shows saved employee ticks and manager team defaults');console.log('PASS '+results.at(-1));await admin.close();
 assert.deepEqual(errors,[]);
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{fs.writeFileSync('.local/role-browser-results.json',JSON.stringify({passed:results,errors,failed:!!process.exitCode},null,2));if(browser)await browser.close()});
