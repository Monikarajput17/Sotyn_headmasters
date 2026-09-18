const fs=require('fs'),assert=require('assert/strict');
const {chromium}=require('../../.local/validation/node_modules/playwright');
const sessions=JSON.parse(fs.readFileSync('.local/dashboard-sessions.json','utf8'));
const results=[],errors=[];let browser;
(async()=>{
 browser=await chromium.launch({channel:'msedge',headless:true});
 for(const [name,session] of Object.entries(sessions)){
  const ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await ctx.route('**/*',r=>['localhost','127.0.0.1'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());
  await ctx.addInitScript(s=>{localStorage.setItem('token',s.token);if(s.refresh_token)localStorage.setItem('refresh_token',s.refresh_token)},session);
  const p=await ctx.newPage();p.setDefaultTimeout(60000);p.on('pageerror',e=>errors.push(name+': '+e.message));
  let expectedFailure=false;p.on('response',r=>{if(r.status()>=500&&r.url().includes('/api/')&&!expectedFailure)errors.push(name+': '+r.status()+' '+r.url());});
  await p.goto('http://127.0.0.1:3055/');await p.locator('[data-card="attendance"]').waitFor();
  assert.equal(new URL(p.url()).pathname,'/');assert.ok(await p.getByRole('heading',{name:/Welcome,/}).isVisible());
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Mobile overflow '+name);
  if(!['admin','manager'].includes(name))assert.equal(await p.locator('[data-card="revenue"]').count(),0);
  if(['employee','viewer','stylist'].includes(name))assert.equal(await p.locator('[data-card="sales"]').count(),0);
  if(name==='employee'){
   await p.screenshot({path:'.local/dashboard-employee.png',fullPage:true});
   await p.locator('[data-card="tasks"]').click();await p.getByText('Showing unfinished work.',{exact:false}).waitFor();assert.equal(await p.getByLabel('View',{exact:true}).inputValue(),'all');
   await p.goto('http://127.0.0.1:3055/');await p.locator('[data-card="attendance"]').click();await p.getByRole('button',{name:'Punch In/Out',exact:true}).waitFor();
  }else if(name==='manager'){
   await p.screenshot({path:'.local/dashboard-manager.png',fullPage:true});
   await p.locator('[data-card="tasks-review"]').click();await p.getByText('Showing submissions you can review.',{exact:false}).waitFor();assert.equal(await p.getByLabel('Status',{exact:true}).inputValue(),'submitted');
  }else if(name==='cashier'||name==='admin'){
   await p.locator(`[data-card="${name==='admin'?'revenue':'bills'}"]`).click();await p.getByRole('heading',{name:'Paid bills',exact:true}).waitFor();
   await p.getByText(/\d+ paid bills/).waitFor();assert.ok(await p.locator('input[type="date"]').first().inputValue());
   const invoices=p.locator('button.card');if(await invoices.count()){await invoices.first().click();await p.locator('h3').filter({hasText:/ROLE-|Bill|INV|POS/}).first().waitFor();}
  }else if(name==='stylist'){
   await p.locator('[data-card="commissions"]').click();await p.getByRole('heading',{name:'Stylist Commissions'}).waitFor();assert.ok(await p.getByLabel('From',{exact:true}).inputValue());
  }else if(name==='receptionist'){
   await p.locator('[data-card="appointments"]').click();await p.getByRole('heading',{name:'Appointments',level:1}).waitFor();assert.equal(new URL(p.url()).searchParams.get('date'),await p.locator('input[type="date"]').inputValue());
  }else if(name==='viewer'){
   await p.locator('[data-card="services"]').click();await p.waitForURL('**/salon/services');
  }
  // Also validate a wider layout and a genuine error/retry flow without fake zeros.
  if(name==='employee'){
   expectedFailure=true;let simulateFailure=true;
   await p.route('**/api/dashboard',r=>simulateFailure?r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Simulated dashboard failure'})}):r.continue());
   await p.goto('http://127.0.0.1:3055/');await p.getByRole('alert').filter({hasText:'Simulated dashboard failure'}).waitFor();assert.equal(await p.locator('[data-card]').count(),0);
   simulateFailure=false;await p.getByRole('button',{name:'Retry dashboard',exact:true}).click();await p.locator('[data-card="attendance"]').waitFor();expectedFailure=false;
   await p.setViewportSize({width:1440,height:1000});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   results.push('Dashboard loading/error/retry and desktop layout');console.log('PASS '+results.at(-1));
  }
  results.push(name+': dashboard landing, mobile visibility and working detail link');console.log('PASS '+results.at(-1));await ctx.close();
 }
 assert.deepEqual(errors,[]);
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{fs.writeFileSync('.local/dashboard-browser-results.json',JSON.stringify({passed:results,errors,failed:!!process.exitCode},null,2));if(browser)await browser.close()});
