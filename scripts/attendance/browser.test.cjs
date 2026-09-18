// Optional local UI smoke checks. Uses the local-only Playwright installation from setup.
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'../..');
const {chromium}=require(path.join(root,'.local/validation/node_modules/playwright'));
let browser;
(async()=>{
 const run=JSON.parse(fs.readFileSync(path.join(root,'.local/attendance-foundation-results.json'),'utf8'));
 const owner=JSON.parse(fs.readFileSync(path.join(root,'.local/test-login.json'),'utf8'));
 browser=await chromium.launch({channel:'msedge',headless:true});
 async function open(credentials,route){
  const response=await fetch('http://127.0.0.1:54321/functions/v1/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});
  const session=await response.json();assert.ok(response.ok,session.error);
  const context=await browser.newContext();
  await context.route('**/*',r=>['127.0.0.1','localhost'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());
  await context.addInitScript(token=>localStorage.setItem('token',token),session.token);
  const page=await context.newPage(),errors=[],writes=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(['POST','PUT','PATCH','DELETE'].includes(r.method()) && /\/(attendance|hr\/employees|payroll)\b/.test(r.url()))writes.push(r.url());});
  await page.goto('http://127.0.0.1:3055'+route);
  await page.waitForLoadState('networkidle');
  return {context,page,errors,writes};
 }
 let v=await open(owner,'/admin/roles');
 await v.page.getByRole('main').getByText('Attendance foundation owner',{exact:true}).click();
 await v.page.getByLabel('Attendance / leave scope',{exact:true}).waitFor();
 assert.equal(await v.page.getByLabel('Attendance / leave scope',{exact:true}).inputValue(),'all');
 assert.equal(await v.page.getByLabel('Branch code',{exact:true}).count(),0);
 await v.page.getByRole('main').locator('summary').filter({hasText:'Team and branch assignments'}).click();
 await v.page.getByLabel('Branch code',{exact:true}).waitFor();
 assert.equal(await v.page.getByLabel('Branch code',{exact:true}).count(),1);
 assert.equal(await v.page.getByLabel('Location access assignment',{exact:true}).count(),1);
 assert.deepEqual(v.errors,[]);assert.deepEqual(v.writes,[]);
 await v.context.close();console.log('PASS owner role/scope controls render with no page-load business writes');
 v=await open({username:run.tag+'manager',password:'SyntheticTest-2026!'},'/attendance?tab=leaves');
 await v.page.getByRole('button',{name:'Leaves',exact:true}).waitFor();
 assert.deepEqual(v.errors,[]);assert.deepEqual(v.writes,[]);
 await v.context.close();console.log('PASS manager attendance renders with no page-load business writes');
 v=await open({username:run.tag+'multi',password:'SyntheticTest-2026!'},'/attendance');
 await v.page.getByRole('button',{name:'Leaves',exact:true}).waitFor();
 assert.equal(await v.page.getByRole('button',{name:'PUNCH IN',exact:true}).isDisabled(),true);
 assert.deepEqual(v.errors,[]);assert.deepEqual(v.writes,[]);
 await v.context.close();console.log('PASS multiple-role viewer can read attendance without capture authority');
 v=await open({username:run.tag+'deniedAdmin',password:'SyntheticTest-2026!'},'/attendance');
 assert.match(await v.page.locator('body').innerText(),/access|permission/i);
 assert.equal(await v.page.getByRole('button',{name:'PUNCH IN',exact:true}).count(),0);
 assert.deepEqual(v.errors,[]);assert.deepEqual(v.writes,[]);
 await v.context.close();console.log('PASS ungranted admin has no attendance capture UI');
 fs.writeFileSync(path.join(root,'.local/attendance-browser-results.json'),JSON.stringify({passed:4,at:new Date().toISOString(),externalNetworkBlocked:true},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();});
