const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'../..'),{chromium}=require(path.join(root,'.local/validation/node_modules/playwright'));
let browser;
(async()=>{
 const fixture=JSON.parse(fs.readFileSync(path.join(root,'.local/attendance-sessions-results.json'),'utf8'));
 browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 async function open(credentials,mobile=false){
  const r=await fetch('http://127.0.0.1:54321/functions/v1/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});const session=await r.json();assert.ok(r.ok,session.error);
  const ctx=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:900},geolocation:{latitude:28.6,longitude:77.2,accuracy:10},permissions:['camera','geolocation']});
  await ctx.route('**/*',r=>['127.0.0.1','localhost'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());
  await ctx.addInitScript(token=>localStorage.setItem('token',token),session.token);
  const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(20000);
  await page.goto('http://127.0.0.1:3055/attendance');await page.getByRole('main').getByRole('button',{name:'Punch In/Out',exact:true}).waitFor();return {ctx,page,errors};
 }
 let v=await open({username:fixture.username,password:'SyntheticTest-2026!'},true),main=v.page.getByRole('main');
 await v.page.evaluate(()=>window.attendanceDocument='same-document');
 for(const label of ['Shifts & Rosters','Policies','Periods','Payroll Adjustments'])assert.equal(await main.getByRole('button',{name:label,exact:true}).count(),0,label);
 for(const [label,heading] of [['My Schedule','My Schedule'],['Daily Results','Daily Results'],['Requests & Reviews','Requests & Reviews']]){
  await main.getByRole('button',{name:label,exact:true}).click();await main.getByRole('heading',{name:heading,exact:true}).waitFor();await v.page.waitForTimeout(250);
 }
 assert.equal(await v.page.evaluate(()=>window.attendanceDocument),'same-document');
 await main.getByRole('button',{name:'Punch In/Out',exact:true}).click();await main.getByRole('button',{name:'Take Selfie',exact:true}).click();
 await v.page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
 await main.getByRole('button',{name:/Capture/}).click();
 const punch=main.getByRole('button',{name:'PUNCH IN - NEXT SESSION',exact:true});await punch.waitFor();assert.equal(await punch.isEnabled(),true);
 await Promise.all([v.page.waitForResponse(r=>r.url().includes('/attendance/punch-in')&&r.request().method()==='POST'&&r.ok()),punch.click()]);
 await main.getByRole('button',{name:'Take Selfie',exact:true}).click();await v.page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);await main.getByRole('button',{name:/Capture/}).click();
 await Promise.all([v.page.waitForResponse(r=>r.url().includes('/attendance/punch-out')&&r.request().method()==='POST'&&r.ok()),main.getByRole('button',{name:'PUNCH OUT',exact:true}).click()]);
 assert.deepEqual(v.errors,[]);await v.ctx.close();console.log('PASS mobile viewport: personal tabs, simulated camera/GPS punch in/out, no page errors');
 v=await open(JSON.parse(fs.readFileSync(path.join(root,'.local/test-login.json'),'utf8')));main=v.page.getByRole('main');
 for(const [label,heading] of [['Shifts & Rosters','Shifts & Rosters'],['Policies','Attendance Policies'],['Periods','Attendance Periods'],['Payroll Adjustments','Payroll Adjustments'],['Requests & Reviews','Requests & Reviews']]){
  await main.getByRole('button',{name:label,exact:true}).click();await main.getByRole('heading',{name:heading,exact:true}).waitFor();await v.page.waitForTimeout(500);
  assert.equal(await main.getByRole('alert').count(),0,label);
 }
 assert.deepEqual(v.errors,[]);await v.ctx.close();console.log('PASS authorized management screens load without page errors');
 fs.writeFileSync(path.join(root,'.local/attendance-operations-browser-results.json'),JSON.stringify({passed:2,at:new Date().toISOString(),cameraAndGps:'simulated',physicalPhoneTested:false,externalNetworkBlocked:true},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();});
