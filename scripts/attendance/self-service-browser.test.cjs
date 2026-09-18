// Optional local UI smoke checks. Uses the local-only Playwright installation from setup.
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'../..');
const {chromium}=require(path.join(root,'.local/validation/node_modules/playwright'));
let browser;
(async()=>{
 const staff=JSON.parse(fs.readFileSync(path.join(root,'.local/attendance-self-service-results.json'),'utf8'));
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
 let v=await open({username:staff.selfServiceUsername,password:'SyntheticTest-2026!'},'/');
 assert.equal(new URL(v.page.url()).pathname,'/attendance');
 const main=v.page.getByRole('main');
 await main.getByRole('button',{name:'My History',exact:true}).waitFor();
 assert.equal(await main.getByRole('button',{name:'Leaves',exact:true}).count(),1);
 for(const name of ['Dashboard','Records','By User','Monthly Grid','Geofence'])assert.equal(await main.getByRole('button',{name,exact:true}).count(),0,name);
 await main.getByRole('button',{name:'My History',exact:true}).click();
 await main.getByRole('heading',{name:/My Attendance/}).waitFor();
 await v.page.getByRole('button',{name:'Account menu',exact:true}).click();
 await v.page.getByRole('link',{name:'My Attendance',exact:true}).click();
 await main.getByRole('button',{name:'Punch In/Out',exact:true}).waitFor();
 assert.equal(new URL(v.page.url()).pathname,'/attendance');
 assert.equal(new URL(v.page.url()).search,'');
 assert.deepEqual(v.errors,[]);assert.deepEqual(v.writes,[]);
 await v.context.close();console.log('PASS staff sees personal attendance/history without management tabs');
 fs.writeFileSync(path.join(root,'.local/attendance-self-service-browser-results.json'),JSON.stringify({passed:1,at:new Date().toISOString(),externalNetworkBlocked:true},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();});
