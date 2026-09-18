import {Router} from '../../_shared/express-lite.ts';
import {authMiddleware,adminClient} from '../../_shared/auth.ts';
import pg from '../../_shared/pg.ts';
import {allowed,branch,checkVersion,grants,kindOf,kinds,loadWorkGrants,record,requireValue,scope,textValue,WorkError,activeUser} from '../../_shared/work-access.ts';
import {createTask,createTicket,event,occurrenceAction,once,saveMeta,settings,taskAction,templateSave,ticketAction} from '../../_shared/work-service.ts';
import {runJobs,addDay} from '../../_shared/work-jobs.ts';
import {isLocalDevelopment,requireLocalEndpoint} from '../../_shared/environment.ts';
const router=Router();router.use(authMiddleware);router.use(async(req,_res,next)=>{await loadWorkGrants(req);next();});
const handle=(fn:any)=>async(req:any,res:any)=>{try{res.json(await fn(req,res));}catch(e){res.status(e instanceof WorkError?e.status:500).json({error:e instanceof WorkError?e.message:'The change could not be saved. Please retry.',...(isLocalDevelopment?{detail:String((e as Error).message)}:{})});}};
function manager(req:any){requireValue(grants(req,'work_settings','edit').some((g:any)=>g.scope_mode==='all'),'All-scope Work settings Edit permission is required',403);}
export async function listWork(req:any,kind:string){
 const k=kindOf(kind),q=req.query||{},where=[scope(req,kind,'view')],params:any[]=[];
 const page=Math.max(1,Math.min(100000,Math.floor(Number(q.page)||1))),limit=Math.max(1,Math.min(100,Math.floor(Number(q.limit)||25)));
 if(q.search){where.push(`w.${k.title} ILIKE ?`);params.push('%'+String(q.search).slice(0,100)+'%');}
 if(q.status){where.push('w.status=?');params.push(q.status);}
 if(q.active==='1')where.push(kind==='tickets'?"w.status NOT IN ('resolved','closed','cancelled')":"w.status NOT IN ('approved','cancelled')");
 if(q.review==='1'){where.push(`(${scope(req,kind,'approve')}) AND w.assigned_to<>?`);params.push(req.user.id);}
 if(q.branch_id){where.push('w.branch_id=?');params.push(Number(q.branch_id)||0);}
 if(q.scope==='mine'){where.push(kind==='tickets'?'(w.assigned_to=? OR w.user_id=?)':'w.assigned_to=?');params.push(req.user.id);if(kind==='tickets')params.push(req.user.id);}
 if(q.scope==='given'){where.push(`w.${k.owner}=?`);params.push(req.user.id);}
 if(q.date&&kind==='occurrences'){where.push('w.work_date=?');params.push(q.date);}
 if(q.today==='1'&&kind==='occurrences')where.push("w.work_date=(now() AT TIME ZONE (SELECT definition->'schedule'->>'timezone' FROM work_checklist_versions WHERE id=w.template_version_id))::date");
 const due=kind==='occurrences'?'w.due_at':kind==='tasks'?"NULLIF(w.work_meta->>'due_at','')::timestamptz":'NULL';
 if(q.overdue==='1'){requireValue(['tasks','occurrences'].includes(kind),'Overdue filter applies to tasks and checklists');where.push(`${due}<now() AND w.status NOT IN ('approved','cancelled')`);}
 if(q.priority){where.push(kind==='tickets'?'w.priority=?':"w.work_meta->>'priority'=?");params.push(q.priority);}
 const order:any={newest:'w.id DESC',oldest:'w.id ASC',title:`w.${k.title} ASC,w.id ASC`,due:`${due} ASC NULLS LAST,w.id ASC`};
 const sort=Object.hasOwn(order,q.sort)?q.sort:'newest';
 const count=await pg.get(`SELECT count(*) AS total FROM ${k.table} w WHERE ${where.join(' AND ')}`,...params);
 const rows=await pg.all(`SELECT w.*,u.name AS assigned_to_name,o.name AS owner_name,b.name AS branch_name FROM ${k.table} w LEFT JOIN users u ON u.id=w.assigned_to LEFT JOIN users o ON o.id=w.${k.owner} LEFT JOIN attendance_branches b ON b.id=w.branch_id WHERE ${where.join(' AND ')} ORDER BY ${order[sort]} LIMIT ? OFFSET ?`,...params,limit,(page-1)*limit);
 return {rows:rows.map((r:any)=>({...r,title:r[k.title],overdue:!!(kind==='occurrences'?r.due_at:r.work_meta?.due_at)&&Date.parse(kind==='occurrences'?r.due_at:r.work_meta.due_at)<Date.now()&&!['approved','cancelled'].includes(r.status)})),total:count.total,page,limit};
}
router.get('/settings',handle(async(req:any)=>{requireValue(grants(req,'work_settings','view').length,'Work settings View permission required',403);return pg.get('SELECT * FROM work_settings WHERE id=1');}));
router.put('/settings',handle((req:any)=>{manager(req);return once(req,async db=>{
 const old=await db.get('SELECT * FROM work_settings WHERE id=1 FOR UPDATE');requireValue(req.body.version===old.version,'Settings changed; refresh first',409);
 const b=req.body.value;requireValue(b&&Array.isArray(b.categories)&&b.categories.length>0&&b.categories.length<=50&&Array.isArray(b.priorities)&&b.priorities.length>0&&b.priorities.length<=20,'Categories and priorities are required');
 for(const group of ['categories','priorities']){
  const seen=new Set();for(const option of b[group]){requireValue(/^[a-z][a-z0-9_]{0,49}$/.test(option.id)&&!seen.has(option.id),'Option IDs must be unique lowercase identifiers');seen.add(option.id);option.label=textValue(option.label,'Option label',100);requireValue(typeof option.active==='boolean','Each option needs active true or false');}
  for(const previous of old.value[group])requireValue(seen.has(previous.id),'Archive existing options; do not remove or rename their IDs');
  requireValue(b[group].some((o:any)=>o.active),'Keep at least one active option');
 }
 for(const c of b.categories){if(c.assignee_id)await activeUser(db,c.assignee_id);for(const key of ['response_minutes','resolution_minutes'])requireValue(c[key]==null||Number.isInteger(c[key])&&c[key]>0&&c[key]<=525600,'Targets must be positive minutes or unset');requireValue(Array.isArray(c.escalation_ids)&&c.escalation_ids.length<=20,'Select up to 20 escalation recipients');for(const uid of c.escalation_ids)await activeUser(db,uid);}
 for(const key of ['task_review_required','task_evidence_required','requester_can_close','requester_can_reopen','pause_waiting','notifications_enabled','escalations_enabled'])requireValue(typeof b[key]==='boolean',`${key} must be true or false`);
 await db.run('UPDATE work_settings SET value=?::text::jsonb,version=version+1,updated_by=?,updated_at=now() WHERE id=1',JSON.stringify(b),req.user.id);
 await db.run("INSERT INTO work_events(kind,record_id,actor_id,action,detail) VALUES('settings',1,?,'settings_updated',?::text::jsonb)",req.user.id,JSON.stringify({before:old.value,after:b}));return {version:old.version+1,value:b};
});}));
router.get('/options',handle(async(req:any)=>{
 const kind=String(req.query.kind||'tasks'),k=kindOf(kind);requireValue(grants(req,k.module,'view').length,'View permission required',403);
 const config=await settings(),employee=await pg.get('SELECT attendance_branch_id FROM employees WHERE user_id=?',req.user.id);
 const users=await pg.all(`SELECT w.id,w.name,w.branch_id FROM (SELECT u.id,u.name,u.id AS assigned_to,?::bigint AS ${k.owner},'{}'::jsonb AS work_meta,e.attendance_branch_id AS branch_id FROM users u LEFT JOIN employees e ON e.user_id=u.id WHERE u.active=1 AND COALESCE(u.archived,0)=0) w WHERE w.id=? OR ${scope(req,kind,'create','w',true)} OR ${scope(req,kind,'approve','w',true)} ORDER BY w.name LIMIT 1000`,req.user.id,req.user.id);
 const branches=await pg.all('SELECT id,name,code FROM attendance_branches WHERE active=1 ORDER BY name');
 return {priorities:config.priorities,categories:config.categories.map((c:any)=>({id:c.id,label:c.label,active:c.active})),users,branches:branches.filter((b:any)=>b.id===employee?.attendance_branch_id||(req.workGrants||[]).some((r:any)=>r.module===k.module&&(r.scope_mode==='all'||r.scope_mode==='branch'&&JSON.parse(r.scope_branches||'[]').includes(b.id)))),own_branch:employee?.attendance_branch_id,defaults:{review_required:config.task_review_required,evidence_required:config.task_evidence_required}};
}));
router.post('/jobs/run',handle((req:any)=>{manager(req);return once(req,db=>runJobs(db,req));}));
router.get('/jobs/status',handle((req:any)=>{manager(req);return pg.all('SELECT * FROM work_job_runs ORDER BY id DESC LIMIT 10');}));
router.get('/templates/:id/legacy-history',handle(async(req:any)=>{
 const row=await record(pg,req,'templates',req.params.id);
 const page=Math.max(1,Math.floor(Number(req.query.page)||1));
 const predicate=scope(req,'occurrences','view');
 const rows=await pg.all(`SELECT w.* FROM (SELECT cc.*,cc.user_id AS assigned_to,?::bigint AS created_by,?::bigint AS branch_id,'{}'::jsonb AS work_meta FROM checklist_completions cc WHERE cc.checklist_id=?) w WHERE ${predicate} ORDER BY w.id DESC LIMIT 25 OFFSET ?`,row.created_by,row.branch_id,row.id,(page-1)*25);
 return {rows,page};
}));
router.get('/:kind/:id/history',handle(async(req:any)=>{
 const {kind,id}=req.params,row=await record(pg,req,kind,id),page=Math.max(1,Math.floor(Number(req.query.page)||1));
 const internal=kind==='tickets'&&row.user_id!==req.user.id&&(row.assigned_to===req.user.id||await allowed(pg,req,kind,'approve',row));
 const rows=await pg.all(`SELECT e.*,u.name AS actor_name FROM work_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.kind=? AND e.record_id=? ${internal?'':'AND e.internal=false'} ORDER BY e.id DESC LIMIT 25 OFFSET ?`,kind,id,(page-1)*25);
 return {rows,page};
}));
router.get('/:kind',handle((req:any)=>listWork(req,req.params.kind)));
router.get('/:kind/:id',handle(async(req:any)=>{
 const {kind,id}=req.params,k=kindOf(kind),row=await record(pg,req,kind,id);
 const internal=kind==='tickets'&&row.user_id!==req.user.id&&(row.assigned_to===req.user.id||await allowed(pg,req,kind,'approve',row));
 const events=await pg.all(`SELECT e.*,u.name AS actor_name FROM work_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.kind=? AND e.record_id=? ${internal?'':'AND e.internal=false'} ORDER BY e.id DESC LIMIT 100`,kind,id);
 const files=await pg.all(`SELECT id,name,mime,size,internal,created_at FROM work_files WHERE kind=? AND record_id=? ${internal?'':'AND internal=false'} ORDER BY created_at DESC`,kind,id);
 const definition=kind==='occurrences'?(await pg.get('SELECT definition FROM work_checklist_versions WHERE id=?',row.template_version_id)).definition:row.work_meta?.definition;
 return {...row,title:row[k.title],events,files,definition,access:{edit:await allowed(pg,req,kind,'edit',row),approve:await allowed(pg,req,kind,'approve',row),manage:!!grants(req,k.module,'create').length,internal}};
}));
router.post('/:kind',handle((req:any)=>once(req,db=>{
 if(req.params.kind==='tasks')return createTask(db,req,req.body);
 if(req.params.kind==='tickets')return createTicket(db,req,req.body);
 if(req.params.kind==='templates')return templateSave(db,req,null,req.body);
 throw new WorkError(400,'Occurrences are created only by the scheduled job');
})));
router.put('/templates/:id',handle((req:any)=>once(req,db=>templateSave(db,req,req.params.id,req.body))));
router.post('/:kind/:id/actions',handle((req:any)=>once(req,async db=>{
 const {kind,id}=req.params,b=req.body;
 if(kind==='tasks')return taskAction(db,req,id,b);
 if(kind==='tickets')return ticketAction(db,req,id,b);
 if(kind==='occurrences')return occurrenceAction(db,req,id,b);
 requireValue(kind==='templates'&&['pause','resume','retire'].includes(b.action),'Unknown action');
 requireValue(grants(req,'checklists','create').length,'Template management requires Create permission',403);
 let row=await record(db,req,kind,id,'edit',true);checkVersion(row,b);
 requireValue(row.work_meta.state!=='retired','Retired templates cannot resume');
 row.work_meta.state={pause:'paused',resume:'active',retire:'retired'}[b.action];
 if(b.action==='resume'){const tz=row.work_meta.definition.schedule.timezone;const today=(await db.get("SELECT to_char(now() AT TIME ZONE ?,'YYYY-MM-DD') AS day",tz)).day;row.work_meta.generated_through=addDay(today,-1);}
 row=await saveMeta(db,kind,row);await event(db,req,kind,row,b.action);return row;
})));
router.post('/:kind/:id/files',handle(async(req:any)=>{
 const {kind,id}=req.params;kindOf(kind);const row=await record(pg,req,kind,id,'view');
 requireValue(await allowed(pg,req,kind,'edit',row),'Edit permission is required to attach files',403);
 requireValue(!['approved','cancelled','closed','submitted'].includes(row.status),'Reopen or return the work before adding files',409);
 const internal=req.body?.internal==='true';requireValue(!internal||kind==='tickets'&&row.user_id!==req.user.id&&(row.assigned_to===req.user.id||await allowed(pg,req,kind,'approve',row)),'Internal attachments are for support only',403);
 const f=req.file;requireValue(f&&f.size>0&&f.size<=5242880,'Choose a file up to 5 MB');
 const bytes=f.buffer,head=Array.from(bytes.slice(0,8)),ext=f.originalname.toLowerCase().split('.').pop();
 const valid=(f.mimetype==='image/png'&&ext==='png'&&head.join(',')==='137,80,78,71,13,10,26,10')||(f.mimetype==='image/jpeg'&&['jpg','jpeg'].includes(ext)&&head[0]===255&&head[1]===216&&head[2]===255)||(f.mimetype==='application/pdf'&&ext==='pdf'&&new TextDecoder().decode(bytes.slice(0,5))==='%PDF-')||(f.mimetype==='text/plain'&&ext==='txt'&&!bytes.includes(0));
 requireValue(valid,'Supported files: PNG, JPEG, PDF or plain text with matching file content');
 const fileId=req.headers['idempotency-key'];requireValue(typeof fileId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(fileId),'Upload requires a UUID Idempotency-Key');
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(n=>n.toString(16).padStart(2,'0')).join('');
 const previous=await pg.get('SELECT * FROM work_files WHERE id=?',fileId);
 if(previous){requireValue(previous.uploaded_by===req.user.id&&previous.kind===kind&&String(previous.record_id)===id&&previous.payload_hash===hash&&previous.internal===internal,'Upload key already used for another file',409);return {id:previous.id,name:previous.name,mime:previous.mime,size:previous.size,internal:previous.internal};}
 const path=`${kind}/${id}/${fileId}.${ext}`,bucket=adminClient().storage.from('work-evidence');
 const upload=await bucket.upload(path,bytes,{contentType:f.mimetype,upsert:false});requireValue(!upload.error,'Private upload failed',503);
 try{return await pg.tx(async db=>{
  const current=await record(db,req,kind,id,'edit',true);requireValue(!['approved','cancelled','closed','submitted'].includes(current.status),'Work changed before upload finished; refresh',409);
  const file=await db.get('INSERT INTO work_files(id,kind,record_id,uploaded_by,name,mime,size,storage_path,internal,payload_hash) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id,name,mime,size,internal',fileId,kind,id,req.user.id,f.originalname.replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,150),f.mimetype,f.size,path,internal,hash);
  await event(db,req,kind,current,'file_added',{file_id:fileId,name:file.name},internal);return file;
 });}catch(e){await bucket.remove([path]);throw e;}
}));
router.get('/files/:id/download',handle(async(req:any)=>{
 const file=await pg.get('SELECT * FROM work_files WHERE id::text=?',req.params.id);requireValue(file,'File not found',404);
 const row=await record(pg,req,file.kind,file.record_id);
 if(file.internal)requireValue(row.user_id!==req.user.id&&(row.assigned_to===req.user.id||await allowed(pg,req,'tickets','approve',row)),'File not found',404);
 const r=await adminClient().storage.from('work-evidence').createSignedUrl(file.storage_path,60,{download:file.name});requireValue(!r.error,'Could not open private file',503);
 let url=r.data.signedUrl;if(isLocalDevelopment)url=requireLocalEndpoint(Deno.env.get('LOCAL_PUBLIC_SUPABASE_URL')||'http://127.0.0.1:54321','Local storage')+new URL(url).pathname+new URL(url).search;
 return {url,expires_in:60};
}));
export default router;
