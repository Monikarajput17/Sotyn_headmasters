import pg from './pg.ts';
import type {Handler} from './express-lite.ts';
import {permissionRows,inScope,branchSql,hasPermission,idNumber,isPermissionManager} from './attendance-access.ts';
import {validDate} from './attendance-capture.ts';

export const attendanceGuard:Handler=async(req,res,next)=>{
 const p=req.path, read=req.method==='GET';
 let module='attendance',action=read?'view':req.method==='DELETE'?'delete':req.method==='POST'?'create':'edit';
 if(p.startsWith('/punch-')){module='attendance_capture';action='create';}
 else if(p==='/my-capture-context'){module='attendance_capture';action='view';}
 else if(p.startsWith('/admin-mark')){module='attendance_corrections';action='approve';}
 else if(p==='/link-login'){module='employee_links';action='edit';}
 else if(p.startsWith('/geofence'))module='attendance_locations';
 else if(p.startsWith('/track')||p.startsWith('/audit/'))module='attendance_tracking';
 else if(p.endsWith('/approve'))action='approve';
 else if(req.method==='DELETE'&&!p.startsWith('/leave'))module='attendance_corrections';
 const grants=await permissionRows(req.user.id,module,action);
 if(!grants.length)return res.status(403).json({error:`${module}.${action} permission required`});
 if(p.startsWith('/admin-mark')&&(!idNumber(req.body?.user_id)||!['present','half_day','short_day','absent','leave','holiday','clear'].includes(req.body?.status)))return res.status(400).json({error:'Valid user ID and explicit attendance status required'});
 req.attendanceModule=module;req.attendanceAction=action;
 let target=req.query.user_id||req.body?.user_id||req.params.userId;
 if(p.startsWith('/my-')||p.startsWith('/punch-')||p==='/track-location'||p==='/leave')target=req.user.id;
 if(req.params.id&&!p.startsWith('/geofence')){
  const row=await pg.get(`SELECT user_id FROM ${p.startsWith('/leave')?'leave_requests':'attendance'} WHERE id=?`,req.params.id);
  if(!row)return res.status(404).json({error:'Record not found'});target=row.user_id;
 }
 if(p.startsWith('/leave/')&&!read&&!p.endsWith('/approve')){
  if(Number(target)===Number(req.user.id))return res.status(403).json({error:'Self correction of submitted leave is not permitted'});
  const leave=await pg.get('SELECT status FROM leave_requests WHERE id=?',req.params.id);
  if(leave?.status!=='pending')return res.status(409).json({error:'Decided leave must be preserved until the authorized amendment workflow is available'});
 }
 if(target&&!await inScope(req,module,action,target))return res.status(403).json({error:'Employee outside permitted scope'});
 if((p.startsWith('/admin-mark')||p.endsWith('/approve')||module==='attendance_corrections')&&!read&&Number(target)===Number(req.user.id))return res.status(403).json({error:'Self approval/correction is not permitted'});
 if(p==='/link-login'){
  if(!grants.some(r=>r.scope_mode==='all'))return res.status(403).json({error:'Global explicit linking authority is required for currently unassigned logins'});
  if(!idNumber(req.body?.employee_id)||!idNumber(req.body?.user_id))return res.status(400).json({error:'Stable employee_id and user_id required'});
 }
 if(p.startsWith('/geofence')&&['POST','PUT'].includes(req.method)){
  const b=req.body,lat=Number(b.latitude),lng=Number(b.longitude),radius=Number(b.radius_meters??200);
  if(!b.site_name?.trim()||b.latitude==null||b.latitude===''||b.longitude==null||b.longitude===''||!Number.isFinite(lat)||Math.abs(lat)>90||!Number.isFinite(lng)||Math.abs(lng)>180||!Number.isFinite(radius)||radius<=0)return res.status(400).json({error:'Site name, valid coordinates and a positive radius are required'});
 }
 if(p.startsWith('/geofence')&&!read){
  if(req.params.id&&!await pg.get(`SELECT id FROM geofence_settings WHERE id=? AND ${await branchSql(req,module,action)}`,req.params.id))return res.status(403).json({error:'Location outside permitted branches'});
  if(!req.params.id&&!grants.some(r=>r.scope_mode==='all'))return res.status(403).json({error:'New legacy locations require explicit global location-create authority'});
 }
 if(p==='/track-location'){
  const user=await pg.get('SELECT track_location FROM users WHERE id=?',req.user.id);
  if(!user?.track_location)return res.status(403).json({error:'Tracking collection disabled for this user'});
 }
 if(p.startsWith('/admin-mark')&&req.body?.date&&!validDate(req.body.date))return res.status(400).json({error:'Valid work date required'});
 if(p.endsWith('/approve')&&!['approved','rejected'].includes(req.body?.status))return res.status(400).json({error:'Decision must be approved or rejected'});
 if(req.method==='DELETE'&&!p.startsWith('/geofence')&&!p.startsWith('/leave')){
  const row=await pg.get('SELECT punch_in_time FROM attendance WHERE id=?',req.params.id);
  if(row?.punch_in_time)return res.status(409).json({error:'Original punch evidence cannot be deleted; an approved correction workflow is required'});
 }
 next();
};

export const employeeGuard:Handler=async(req,res,next)=>{
 if(!req.path.startsWith('/employees'))return next();
 const module=req.path.endsWith('/shifts')?'employee_shifts':'employees';
 const action=req.method==='GET'?'view':req.method==='DELETE'?'delete':req.method==='POST'?(module==='employee_shifts'?'edit':'create'):'edit';
 if(!await hasPermission(req.user.id,module,action))return res.status(403).json({error:`${module}.${action} permission required`});
 if(req.params.id&&!await inScope(req,module,action,req.params.id,true))return res.status(403).json({error:'Employee outside permitted scope'});
 if(req.method==='POST'&&!req.params.id){
  if(!(await permissionRows(req.user.id,module,action)).some(r=>r.scope_mode==='all'))return res.status(403).json({error:'Employee creation requires explicit all-employee scope in this stage'});
  const inputs=req.path.endsWith('/bulk')?(Array.isArray(req.body.employees)?req.body.employees:[]):[req.body];
  if(inputs.some((b:any)=>Number(b.salary||0)!==0)&&!(await permissionRows(req.user.id,'payroll','edit')).some(r=>r.scope_mode==='all'))return res.status(403).json({error:'Compensation initialization requires explicit all-employee payroll edit authority'});
  if(inputs.some((b:any)=>b.reporting_manager_id_1||b.reporting_manager_id_2)&&!await isPermissionManager(req.user.id))return res.status(403).json({error:'A permission manager must assign reporting relationships'});
 }
 if(req.method==='POST'&&req.path.endsWith('/shifts')){
  const b=req.body;
  if(!validDate(b.effective_from)||[b.shift_start,b.shift_end].some(v=>v!=null&&v!==''&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(v))||b.week_off_day!=null&&b.week_off_day!==''&&(!Number.isInteger(Number(b.week_off_day))||Number(b.week_off_day)<0||Number(b.week_off_day)>6))return res.status(400).json({error:'Valid effective date, HH:MM times and weekly-off weekday (0–6) required'});
  if(b.shift_start&&b.shift_end&&b.shift_end===b.shift_start)return res.status(400).json({error:'Shift start and end must differ; use templates for split shifts'});
 }
 if(req.method==='PUT'&&req.params.id){
  const old=await pg.get('SELECT * FROM employees WHERE id=?',req.params.id);
  if(!old)return res.status(404).json({error:'Employee not found'});
  req.existingEmployee=old;
  if(req.body.salary!==undefined && Number(req.body.salary)!==Number(old.salary) && !await inScope(req,'payroll','edit',req.params.id,true))return res.status(403).json({error:'Compensation edit permission required for this employee'});
  if(['reporting_manager_id_1','reporting_manager_id_2'].some(k=>req.body[k]!==undefined&&Number(req.body[k]||0)!==Number(old[k]||0))&&!await isPermissionManager(req.user.id))return res.status(403).json({error:'Reporting relationships define access scope; a permission manager must change them'});
  if(req.body.user_id!==undefined&&Number(req.body.user_id||0)!==Number(old.user_id||0)){
   if(!(await permissionRows(req.user.id,'employee_links','edit')).some(r=>r.scope_mode==='all'))return res.status(403).json({error:'Explicit global employee linking authority required'});
  }
  const start=req.body.join_date??old.join_date,end=req.body.employment_end_date??old.employment_end_date;
  if(start&&!validDate(start)||end&&(!validDate(end)||start&&end<start))return res.status(400).json({error:'Valid ordered employment start/end dates required'});
  req.body={...old,...req.body};
 }
 next();
};
