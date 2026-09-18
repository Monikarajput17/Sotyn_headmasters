// Local-only job runner. No production URLs, credentials, email, SMS or push.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{Client}=require('pg');
const root=path.resolve(__dirname,'../..'),base='http://127.0.0.1:54321/functions/v1/api';
async function run(){
 const db=new Client({connectionString:'postgresql://postgres:postgres@127.0.0.1:54322/postgres',connectionTimeoutMillis:10000});
 try{await db.connect();const r=await db.query("SELECT value FROM app_settings WHERE key='local_environment'");if(r.rows[0]?.value!=='sotyn-headmasters-local')throw Error('Local database marker missing');}finally{await db.end();}
 const credentials=JSON.parse(fs.readFileSync(path.join(root,'.local/test-login.json'),'utf8'));
 const login=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials),signal:AbortSignal.timeout(30000)});
 if(!login.ok)throw Error('Local job login failed: '+login.status);const session=await login.json();
 const r=await fetch(base+'/work/jobs/run',{method:'POST',headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:'{}',signal:AbortSignal.timeout(60000)});
 const result=await r.json();if(!r.ok)throw Error(result.error||'Local scheduled run failed');console.log(new Date().toISOString(),JSON.stringify(result));
}
async function main(){do{try{await run();}catch(e){console.error(new Date().toISOString(),e.message);if(process.argv.includes('--once')){process.exitCode=1;break;}}if(process.argv.includes('--once'))break;await new Promise(resolve=>setTimeout(resolve,60000));}while(true);}
main();
