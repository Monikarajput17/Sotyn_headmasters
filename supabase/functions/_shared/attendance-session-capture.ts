import pg from './pg.ts';
import type {Handler} from './express-lite.ts';
import {evaluateGeofence,geoSettings} from './lib/geofence.ts';
import {addDays,isoDay,validDay,jsonValue} from './attendance-engine.ts';
import {AttendanceError,assertOpen,hashPayload,resolveDuty,writeLock} from './attendance-operations.ts';
export const workDate=isoDay;
export const validDate=validDay;
class CaptureError extends Error{constructor(public status:number,public code:string,message:string){super(message);}}
export function capture(kind:'in'|'out'):Handler{return async(req,res)=>{
 try{
  const b=req.body||{},received=new Date(),today=workDate(received);
  if(typeof b.request_id!=='string'||!/^[-a-zA-Z0-9]{16,100}$/.test(b.request_id))throw new CaptureError(400,'REQUEST_ID_REQUIRED','Stable request_id required; reuse it for retries');
  const coordinate=(key:string,max:number)=>{
   if(b[key]==null||b[key]==='')return null;
   if(typeof b[key]==='boolean'||!Number.isFinite(Number(b[key]))||Math.abs(Number(b[key]))>max)throw new CaptureError(400,'INVALID_LOCATION',`Valid ${key} required`);
   return Number(b[key]);
  };
  const latitude=coordinate('latitude',90),longitude=coordinate('longitude',180),accuracy=b.accuracy==null||b.accuracy===''?null:Number(b.accuracy);
  if(accuracy!==null&&(typeof b.accuracy==='boolean'||!Number.isFinite(accuracy)||accuracy<0))throw new CaptureError(400,'INVALID_ACCURACY','Nonnegative location accuracy required');
  const photo=b.photo||null;
  if(photo!==null){
   if(typeof photo!=='string'||photo.length>600000||!/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(photo))throw new CaptureError(400,'INVALID_PHOTO','JPEG/PNG selfie must be under 600 KB encoded');
   let bytes='';try{bytes=atob(photo.split(',')[1]);}catch{}
   if(!(bytes.startsWith('\x89PNG\r\n\x1a\n')||bytes.startsWith('\xff\xd8\xff')))throw new CaptureError(400,'INVALID_PHOTO','Malformed image content');
  }
  const evidence={latitude,longitude,accuracy,photo,address:String(b.address||'').slice(0,1000),captured_at:b.captured_at||null,exception_reason:String(b.exception_reason||'').trim().slice(0,2000),kind};
  const hash=await hashPayload(evidence);
  const result=await pg.tx(async db=>{
   await writeLock(db);await db.get('SELECT pg_advisory_xact_lock(?::bigint)',740000000000+Number(req.user.id));
   const replay=await db.get('SELECT * FROM attendance_capture_events WHERE user_id=? AND request_id=?',req.user.id,b.request_id);
   if(replay){if(replay.payload_hash!==hash)throw new CaptureError(409,'IDEMPOTENCY_CONFLICT','Request ID was used with different evidence');return {id:replay.attendance_id,replayed:true,message:'Submission already recorded'};}
   if(b.captured_at&&(!Number.isFinite(Date.parse(b.captured_at))||Math.abs(received.getTime()-Date.parse(b.captured_at))>300000))throw new CaptureError(409,'CAPTURE_TIME_INVALID','Online capture must be recent. Submit delayed attendance through a correction request.');
   const employees=await db.all('SELECT * FROM employees WHERE user_id=?',req.user.id);
   if(employees.length!==1)throw new CaptureError(409,'EMPLOYEE_LINK_REQUIRED','Exactly one employee/login link is required; ask the owner to resolve it');
   const employee=employees[0];
   const open=await db.all("SELECT * FROM attendance WHERE user_id=? AND punch_in_time IS NOT NULL AND punch_out_time IS NULL AND COALESCE(capture_state,'open')<>'review_closed' ORDER BY id FOR UPDATE",req.user.id);
   if(open.length>1)throw new CaptureError(409,'ATTENDANCE_CONFLICT','Multiple open legacy records require review');
   let date=today,duty=await resolveDuty(db,employee,today),record=kind==='out'?open[0]:null;
   if(kind==='out'){
    if(!record||record.admin_marked)throw new CaptureError(409,'CHECK_IN_REQUIRED','No open genuine check-in. An earlier checkout may already be recorded.');
    date=record.date;duty=await resolveDuty(db,employee,date);
    if(record.shift_snapshot)duty.plan=jsonValue(record.shift_snapshot);
    if(record.policy_version_id)duty.policy=await db.get('SELECT * FROM attendance_policy_versions WHERE id=?',record.policy_version_id);
    if(received.getTime()-Date.parse(record.punch_in_time)>48*3600000)throw new CaptureError(409,'INCOMPLETE_SESSION','This old open session requires a correction request');
   }else{
    if(open.length)throw new CaptureError(409,'INCOMPLETE_SESSION','An open session needs checkout or an approved correction first');
    const prior=await resolveDuty(db,employee,addDays(today,-1));
    if(prior.plan&&Date.parse(prior.plan.start)<=received.getTime()&&Date.parse(prior.plan.end)>=received.getTime()){duty=prior;date=prior.date;}
   }
   await assertOpen(db,date);
   if(employee.join_date&&date<employee.join_date||employee.employment_end_date&&date>employee.employment_end_date)throw new CaptureError(409,'OUTSIDE_EMPLOYMENT','Work date falls outside employment dates');
   const rows=await db.all('SELECT * FROM attendance WHERE user_id=? AND date=? ORDER BY id FOR UPDATE',req.user.id,date);
   if(rows.filter((r:any)=>r.capture_session==null).length>1)throw new CaptureError(409,'ATTENDANCE_CONFLICT','Duplicate legacy records require review');
   const policy=jsonValue(duty.policy?.rules);
   if(kind==='in'&&rows.length&&(!policy?.allow_multiple_sessions&&!(duty.plan?.segments.length>1)||rows.some((r:any)=>r.admin_marked||r.capture_session==null)))throw new CaptureError(409,'ALREADY_RECORDED','Attendance exists; additional sessions require an enabled policy or split shift');
   const zones=await db.all(`SELECT * FROM geofence_settings WHERE active=1 ${policy?.location_scope==='branch'?'AND attendance_branch_id=?':''}`,...(policy?.location_scope==='branch'?[employee.attendance_branch_id||0]:[]));
   const limits=await geoSettings(db);
   const missing=latitude===null||longitude===null||accuracy===null;
   const geo=missing?{allow:false,verified:0,matchedSite:'',nearestDist:null,decision:'missing_location'}:evaluateGeofence(latitude,longitude,accuracy,zones,limits);
   const needsReview=!photo||missing||!zones.length||!geo.verified,review=needsReview&&policy?.capture_exception==='review';
   if(!photo&&!review)throw new CaptureError(400,'PHOTO_REQUIRED','A selfie is required; use an authorized exception request if unavailable');
   if(missing&&!review)throw new CaptureError(400,'LOCATION_REQUIRED','Location and accuracy required');
   if(!zones.length&&!review)throw new CaptureError(409,'LOCATION_NOT_CONFIGURED','No permitted attendance location is configured');
   if(policy?.capture_exception==='reject'&&needsReview)throw new CaptureError(400,'LOCATION_UNVERIFIED','Location/selfie could not be verified; submit a correction request');
   if(!geo.allow&&!review)throw new CaptureError(400,'OUTSIDE_LOCATION','Outside configured attendance locations');
   if(review&&evidence.exception_reason.length<3)throw new CaptureError(409,'EXCEPTION_REASON_REQUIRED','This capture needs review. Enter a reason and submit it as an exception.');
   let id:number,totalHours:number|undefined;
   if(kind==='in'){
    const sequence=Math.max(0,...rows.map((r:any)=>r.capture_session||0))+1,late=duty.plan&&received.getTime()>Date.parse(duty.plan.start)+(policy?.grace_minutes||0)*60000;
    const r=await db.run(`INSERT INTO attendance(user_id,employee_id,date,punch_in_time,punch_in_lat,punch_in_lng,punch_in_address,punch_in_photo,site_name,status,punch_in_accuracy,location_verified,capture_session,capture_state,shift_snapshot,policy_version_id,review_state)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?::jsonb,?,?)`,req.user.id,employee.id,date,received.toISOString(),latitude,longitude,evidence.address,photo,geo.matchedSite,late?'late':'present',accuracy,geo.verified,sequence,duty.plan,duty.policy?.id||null,review?'pending':'accepted');
    id=r.lastInsertRowid!;
   }else{
    id=record.id;totalHours=Math.round((received.getTime()-Date.parse(record.punch_in_time))/36000)/100;
    if(!Number.isFinite(totalHours)||totalHours<0)throw new CaptureError(409,'INVALID_SESSION','Original check-in time requires review');
    const r=await db.run(`UPDATE attendance SET punch_out_time=?,punch_out_lat=?,punch_out_lng=?,punch_out_address=?,punch_out_photo=?,punch_out_accuracy=?,total_hours=?,capture_state='closed',review_state=? WHERE id=? AND punch_out_time IS NULL`,received.toISOString(),latitude,longitude,evidence.address,photo,accuracy,totalHours,review?'pending':record.review_state,id);
    if(!r.changes)throw new CaptureError(409,'ALREADY_CLOSED','Checkout already completed; evidence preserved');
   }
   await db.run('INSERT INTO attendance_capture_events(user_id,request_id,attendance_id,kind,captured_at,received_at,payload_hash,evidence) VALUES(?,?,?,?,?::timestamptz,?::timestamptz,?,?::jsonb)',req.user.id,b.request_id,id,kind,b.captured_at||received.toISOString(),received.toISOString(),hash,{...evidence,geofence:geo,geo_settings:limits,locations:zones.map((z:any)=>({id:z.id,site_name:z.site_name,latitude:z.latitude,longitude:z.longitude,radius_meters:z.radius_meters,attendance_branch_id:z.attendance_branch_id}))});
   if(review)await db.run("INSERT INTO attendance_requests(request_id,payload_hash,employee_id,work_date,kind,proposed,reason,requested_by) VALUES(?,?,?,?,'capture_exception',?::jsonb,?,?)",b.request_id,hash,employee.id,date,{attendance_id:id,kind,geofence:geo,missing_selfie:!photo},evidence.exception_reason,req.user.id);
   return {id,totalHours,work_date:date,review_state:review?'pending':record?.review_state||'accepted',message:review?'Recorded pending manager review':kind==='in'?'Punched In':'Punched Out',replayed:false};
  });res.json(result);
 }catch(e){if(e instanceof CaptureError)return res.status(e.status).json({error:e.message,code:e.code});if(e instanceof AttendanceError)return res.status(e.status).json({error:e.message});console.error('attendance capture',e);res.status(['23505','P0001'].includes((e as any).code)?409:500).json({error:'Could not record capture. Retry with the same request ID or check your attendance status.'});}
};}
