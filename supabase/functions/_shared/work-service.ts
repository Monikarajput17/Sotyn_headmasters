import pg,{type Db} from './pg.ts';
import {allowed,activeUser,branch,checkVersion,dateValue,grants,instant,kindOf,record,requireValue,textValue} from './work-access.ts';

export async function settings(db:Db=pg){return (await db.get('SELECT * FROM work_settings WHERE id=1')).value;}
export async function event(db:Db,req:any,kind:string,row:any,action:string,detail:any={},internal=false){
 const e=await db.get('INSERT INTO work_events(kind,record_id,actor_id,action,detail,internal) VALUES(?,?,?,?,?::text::jsonb,?) RETURNING id',kind,row.id,req.user.id,action,JSON.stringify(detail),internal);
 if(!(await settings(db)).notifications_enabled)return;
 const k=kindOf(kind),recipients=new Set<number>([row.assigned_to,row[k.owner],...(row.work_meta?.collaborators||[]),...(action==='submitted'?[row.work_meta?.reviewer_id]:[])].filter(Boolean).map(Number));
 if(kind==='tickets'&&action==='opened'&&!row.assigned_to){
  const triage=await db.all("SELECT DISTINCT ur.user_id FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE rp.module='help_tickets' AND rp.can_approve=1");
  for(const candidate of triage){const roles=await db.all('SELECT rp.* FROM role_permissions rp JOIN user_roles ur ON ur.role_id=rp.role_id WHERE ur.user_id=?',candidate.user_id);if(await allowed(db,{user:{id:candidate.user_id},workGrants:roles},'tickets','approve',row))recipients.add(candidate.user_id);}
 }
 for(const uid of recipients){
  if(uid===req.user.id||(internal&&uid===row[k.owner]))continue;
  const permissionRows=await db.all('SELECT rp.* FROM role_permissions rp JOIN user_roles ur ON ur.role_id=rp.role_id JOIN users u ON u.id=ur.user_id WHERE ur.user_id=? AND u.active=1 AND COALESCE(u.archived,0)=0',uid);
  if(!await allowed(db,{user:{id:uid},workGrants:permissionRows},kind,'view',row))continue;
  // Same transaction as the action: an acknowledged change always has its in-app notification.
  await db.run("INSERT INTO notifications(user_id,type,title,body,link_url,channel_sent,dedupe_key) VALUES(?,'generic',?,?,?,'in_app',?)",uid,`${kind==='tasks'?'Task':kind==='tickets'?'Ticket':'Checklist'}: ${action.replaceAll('_',' ')}`,row[k.title],`/${kind==='tasks'?'delegations':kind==='tickets'?'help-tickets':'checklists'}?record=${row.id}`,`work:${e.id}:${uid}`);
 }
}
export async function once(req:any,fn:(db:Db)=>Promise<any>){
 const key=req.headers['idempotency-key']||req.body?.request_id;
 requireValue(typeof key==='string'&&/^[a-zA-Z0-9_-]{16,100}$/.test(key),'A unique Idempotency-Key (16–100 characters) is required');
 const fingerprint=JSON.stringify([req.method,req.path,req.body]);
 return pg.tx(async db=>{
  await db.get('SELECT pg_advisory_xact_lock(7821,?)',req.user.id);
  const old=await db.get('SELECT * FROM work_requests WHERE user_id=? AND request_id=?',req.user.id,key);
  if(old){requireValue(old.fingerprint===fingerprint,'This request key was already used for different input',409);const kind=req.path.split('/')[1];if(['tasks','tickets','templates','occurrences'].includes(kind)&&old.response?.id)await record(db,req,kind,old.response.id);return old.response;}
  const result=await fn(db);
  await db.run('INSERT INTO work_requests(user_id,request_id,fingerprint,response) VALUES(?,?,?,?::text::jsonb)',req.user.id,key,fingerprint,JSON.stringify(result));
  return result;
 });
}
export async function evidence(db:Db,req:any,kind:string,id:number,ids:any){
 requireValue(Array.isArray(ids)&&ids.length<=20,'Select up to 20 evidence files');
 const result=[...new Set(ids)];
 for(const fileId of result)requireValue(typeof fileId==='string'&&/^[0-9a-f-]{36}$/.test(fileId)&&await db.get('SELECT id FROM work_files WHERE id=? AND kind=? AND record_id=? AND internal=false',fileId,kind,id),'Evidence must be a private file attached to this record');
 return result;
}
export async function saveMeta(db:Db,kind:string,row:any,status=row.status){
 const k=kindOf(kind);
 await db.run(`UPDATE ${k.table} SET work_meta=?::text::jsonb,status=?,work_version=work_version+1 WHERE id=?`,JSON.stringify(row.work_meta),status,row.id);
 return {...row,status,work_version:row.work_version+1};
}
async function assignable(db:Db,req:any,kind:string,action:string,id:any,branchId:any,collaborator=false){
 const uid=await activeUser(db,id),k=kindOf(kind);
 const employee=await db.get('SELECT attendance_branch_id FROM employees WHERE user_id=?',uid);
 requireValue(employee&&Number(employee.attendance_branch_id)===Number(branchId),'Assignee must have an employee record in the selected branch');
 requireValue(await allowed(db,req,kind,action,{assigned_to:uid,[k.owner]:req.user.id,branch_id:branchId},true),'Assignee is outside your permission scope',403);
 const targetGrants=await db.all('SELECT rp.* FROM role_permissions rp JOIN user_roles ur ON ur.role_id=rp.role_id WHERE ur.user_id=?',uid);
 const context={user:{id:uid},workGrants:targetGrants},candidate={assigned_to:uid,[k.owner]:req.user.id,branch_id:branchId};
 requireValue(await allowed(db,context,kind,'view',candidate)&&(collaborator||await allowed(db,context,kind,'edit',candidate)),'Assignee needs role permissions to view and carry out this work');
 return uid;
}
export async function createTask(db:Db,req:any,b:any){
 const config=await settings(db),branchId=await branch(db,b.branch_id),uid=await assignable(db,req,'tasks','create',b.assigned_to,branchId);
 const priority=textValue(b.priority||'medium','Priority',50);requireValue(config.priorities.some((p:any)=>p.id===priority&&p.active),'Choose an active priority');
 const review=b.review_required??config.task_review_required;requireValue(typeof review==='boolean'&&(b.evidence_required===undefined||typeof b.evidence_required==='boolean'),'Review and evidence requirements must be true or false');
 const reviewer=review?await activeUser(db,b.reviewer_id||req.user.id):null;
 if(review){requireValue(reviewer!==uid,'Reviewer must be different from the accountable assignee');await reviewerAllowed(db,reviewer,'delegations',uid,branchId);}
 const collaborators:number[]=[];requireValue(!b.collaborators||Array.isArray(b.collaborators)&&b.collaborators.length<=20,'Up to 20 collaborators allowed');
 for(const c of b.collaborators||[])collaborators.push(await assignable(db,req,'tasks','create',c,branchId,true));
 const meta={priority,due_at:instant(b.due_at),review_required:!!review,evidence_required:!!(b.evidence_required??config.task_evidence_required),reviewer_id:reviewer,collaborators:[...new Set(collaborators)],evidence:[]};
 const row=await db.get(`INSERT INTO delegations(title,description,assigned_by,assigned_to,due_date,branch_id,work_meta) VALUES(?,?,?,?,?,?,?::text::jsonb) RETURNING *`,textValue(b.title,'Title',200),textValue(b.description,'Instructions',10000),req.user.id,uid,meta.due_at.slice(0,10),branchId,JSON.stringify(meta));
 await event(db,req,'tasks',row,'assigned',{assignee:uid,deadline:meta.due_at});return row;
}
export async function reviewerAllowed(db:Db,uid:number,module:string,assignee:number,branchId:number){
 const rows=await db.all('SELECT rp.* FROM role_permissions rp JOIN user_roles ur ON ur.role_id=rp.role_id WHERE ur.user_id=?',uid);
 const kind=module==='delegations'?'tasks':'occurrences';
 requireValue(await allowed(db,{user:{id:uid},workGrants:rows},kind,'approve',{assigned_to:assignee,assigned_by:null,created_by:null,branch_id:branchId}),'Reviewer needs Approve permission for this assignee and branch');
}
export async function taskAction(db:Db,req:any,id:any,b:any){
 let row=await record(db,req,'tasks',id,'view',true);checkVersion(row,b);
 const a=b.action,meta=row.work_meta||{},note=textValue(b.note,'Note',10000,true);
 const approved=['approve','return','approve_extension','reject_extension'].includes(a);
 requireValue(await allowed(db,req,'tasks',approved?'approve':'edit',row),'Action is outside your permission scope',403);
 let next=row.status,detail:any={note};
 if(['start','block','submit','request_extension'].includes(a))requireValue(row.assigned_to===req.user.id,'Only the accountable assignee can change work progress',403);
 if(a==='start'){requireValue(['pending','blocked','rejected'].includes(row.status),'Task cannot start from this status',409);next='in_progress';meta.blocker=null;}
 else if(a==='block'){requireValue(['pending','in_progress','rejected'].includes(row.status)&&note,'A blocker reason is required for active work');next='blocked';meta.blocker=note;}
 else if(a==='submit'){
  requireValue(['in_progress','rejected'].includes(row.status),'Start work before submitting',409);
  meta.evidence=await evidence(db,req,'tasks',row.id,b.evidence||[]);requireValue(!(meta.evidence_required??true)||meta.evidence.length,'Completion evidence is required');
  requireValue(note,'A completion note is required');meta.completion_note=note;meta.submitted_by=req.user.id;
  next=(meta.review_required??true)?'submitted':'approved';meta.submitted_at=new Date().toISOString();
  if(next==='submitted'){requireValue(meta.reviewer_id,'Select an authorized reviewer before submission');await reviewerAllowed(db,meta.reviewer_id,'delegations',row.assigned_to,row.branch_id);}
  await db.run('UPDATE delegations SET submitted_at=?,reject_reason=NULL WHERE id=?',meta.submitted_at,row.id);
 }else if(a==='approve'||a==='return'){
  requireValue(row.status==='submitted','Only submitted work can be reviewed',409);requireValue(row.assigned_to!==req.user.id&&meta.submitted_by!==req.user.id,'A different person must review completion',403);
  requireValue(a!=='return'||note,'Give a reason for returning work');next=a==='approve'?'approved':'rejected';
  await db.run('UPDATE delegations SET reviewer_id=?,reviewed_at=?,reject_reason=? WHERE id=?',req.user.id,new Date().toISOString(),a==='return'?note:null,row.id);
 }else if(a==='update'){
  requireValue(grants(req,'delegations','create').length,'Task management requires Create as well as Edit permission',403);
  requireValue(!['approved','cancelled','submitted'].includes(row.status),'Reassignment and deadline changes require active, unsubmitted work',409);
  requireValue(note,'Explain the reassignment or deadline change');
  const branchId=row.branch_id||await branch(db,b.branch_id);
  const uid=await assignable(db,req,'tasks','edit',b.assigned_to||row.assigned_to,branchId);
  const due=b.due_at?instant(b.due_at):meta.due_at;requireValue(due,'A deadline is required');
  detail={note,before:{assignee:row.assigned_to,due_at:meta.due_at},after:{assignee:uid,due_at:due}};
  if(b.reviewer_id)meta.reviewer_id=await activeUser(db,b.reviewer_id);
  if(meta.review_required??true){requireValue(meta.reviewer_id!==uid,'Reviewer must differ from assignee');await reviewerAllowed(db,meta.reviewer_id,'delegations',uid,branchId);}
  await db.run('UPDATE delegations SET assigned_to=?,due_date=?,branch_id=? WHERE id=?',uid,due.slice(0,10),branchId,row.id);row.assigned_to=uid;row.branch_id=branchId;meta.due_at=due;
 }else if(a==='request_extension'){
  requireValue(!['approved','cancelled','submitted'].includes(row.status)&&note,'Active work and an extension reason are required');meta.extension={due_at:instant(b.due_at),reason:note,status:'pending'};
 }else if(a==='approve_extension'||a==='reject_extension'){
  requireValue(meta.extension?.status==='pending'&&row.assigned_to!==req.user.id,'A pending extension and independent reviewer are required');
  if(a==='approve_extension'){meta.due_at=meta.extension.due_at;await db.run('UPDATE delegations SET due_date=?,extension_count=COALESCE(extension_count,0)+1 WHERE id=?',meta.due_at.slice(0,10),row.id);}
  else requireValue(note,'Explain why the extension is declined');meta.extension.status=a;
 }else if(a==='comment')requireValue(note,'A progress update is required');
 else requireValue(false,'Unknown task action');
 row.work_meta=meta;row=await saveMeta(db,'tasks',row,next);await event(db,req,'tasks',row,a,detail);return row;
}

export async function createTicket(db:Db,req:any,b:any){
 const config=await settings(db),branchId=await branch(db,b.branch_id);
 requireValue(await allowed(db,req,'tickets','create',{assigned_to:req.user.id,user_id:req.user.id,branch_id:branchId}),'No Create permission in this branch',403);
 const emp=await db.get('SELECT attendance_branch_id FROM employees WHERE user_id=?',req.user.id);
 if(!grants(req,'help_tickets','create').some((r:any)=>r.scope_mode==='all'||r.scope_mode==='branch'))requireValue(Number(emp?.attendance_branch_id)===branchId,'Choose your employee branch');
 const cat=config.categories.find((c:any)=>c.id===b.category&&c.active);requireValue(cat,'Choose an active category');
 const priority=b.priority||'medium';requireValue(config.priorities.some((p:any)=>p.id===priority&&p.active),'Choose an active priority');
 let assignee=cat.assignee_id?await activeUser(db,cat.assignee_id):null;
 if(b.assigned_to){requireValue(grants(req,'help_tickets','approve').length,'Routing override requires Approve permission',403);assignee=await assignable(db,req,'tickets','approve',b.assigned_to,branchId);}
 if(assignee){const roles=await db.all('SELECT rp.* FROM role_permissions rp JOIN user_roles ur ON ur.role_id=rp.role_id WHERE ur.user_id=?',assignee);const context={user:{id:assignee},workGrants:roles},candidate={assigned_to:assignee,user_id:req.user.id,branch_id:branchId};requireValue(await allowed(db,context,'tickets','view',candidate)&&await allowed(db,context,'tickets','edit',candidate),'The category route has no support access in this branch; ask the owner to update routing');}
 const now=new Date().toISOString();
 const meta:any={response_minutes:cat.response_minutes,resolution_minutes:cat.resolution_minutes,escalation_ids:cat.escalation_ids||[],pause_waiting:config.pause_waiting,opened_at:now,paused_ms:0,sla_cycle:1};
 if(b.link){
  requireValue(['tasks','occurrences'].includes(b.link.kind),'Tickets can link to a task or checklist occurrence');
  const source=await record(db,req,b.link.kind,b.link.id,'view',true);
  requireValue(source.branch_id===branchId,'Linked work must be in the same branch');
  requireValue(b.link.kind!=='tasks'||source.status==='blocked','Block the task with a reason before raising its issue');meta.link={kind:b.link.kind,id:source.id};
 }
 const row=await db.get(`INSERT INTO support_tickets(ticket_no,user_id,subject,description,category,priority,assigned_to,status,branch_id,work_meta) VALUES(?,?,?,?,?,?,?,?,?,?::text::jsonb) RETURNING *`,'TK-'+crypto.randomUUID().slice(0,12),req.user.id,textValue(b.title||b.subject,'Subject',200),textValue(b.description,'Description',10000),cat.id,priority,assignee,assignee?'assigned':'open',branchId,JSON.stringify(meta));
 await event(db,req,'tickets',row,'opened',{category:cat.id,assignee});
 if(meta.link){const source=await record(db,req,meta.link.kind,meta.link.id);await event(db,req,meta.link.kind,source,'ticket_linked',{ticket_id:row.id});}
 return row;
}
export async function ticketAction(db:Db,req:any,id:any,b:any){
 let row=await record(db,req,'tickets',id,'view',true);checkVersion(row,b);
 const a=b.action,meta=row.work_meta||{},note=textValue(b.note,'Reply or reason',10000,true),config=await settings(db);
 const manager=await allowed(db,req,'tickets','approve',row),editor=await allowed(db,req,'tickets','edit',row),requester=row.user_id===req.user.id;
 const support=manager||(row.assigned_to===req.user.id&&editor&&!requester);
 let next=row.status,internal=!!b.internal;
 requireValue(editor||manager,'Edit or Approve permission is required',403);
 if(a==='reply'){
  requireValue(note,'Reply text is required');requireValue(!internal||support,'Only support may add internal notes',403);
  requireValue(row.status!=='closed','Reopen the ticket before replying',409);
  const files=await evidence(db,req,'tickets',row.id,b.evidence||[]);
  if(requester&&row.status==='waiting'){next='in_progress';}
  if(support&&!internal&&!meta.first_response_at)meta.first_response_at=new Date().toISOString();
  b._files=files;
 }else if(a==='assign'){
  requireValue(manager,'Approve permission is required for routing',403);requireValue(!['closed','resolved'].includes(row.status),'Reopen before reassigning',409);
  const branchId=row.branch_id||await branch(db,b.branch_id),uid=await assignable(db,req,'tickets','approve',b.assigned_to,branchId);
  await db.run('UPDATE support_tickets SET assigned_to=?,branch_id=? WHERE id=?',uid,branchId,row.id);row.assigned_to=uid;row.branch_id=branchId;next='assigned';
 }else if(a==='start'){requireValue(support&&['open','assigned','waiting'].includes(row.status),'Only support can start active tickets',403);requireValue(row.assigned_to,'Assign a responsible person first');next='in_progress';}
 else if(a==='wait'){requireValue(support&&['assigned','in_progress'].includes(row.status)&&note,'Support must explain what information is needed');next='waiting';if(!meta.first_response_at)meta.first_response_at=new Date().toISOString();}
 else if(a==='resolve'){requireValue(support&&['assigned','in_progress','waiting'].includes(row.status)&&note,'Support must enter a resolution for active work');next='resolved';meta.resolution=note;meta.resolved_at=new Date().toISOString();if(!meta.first_response_at)meta.first_response_at=meta.resolved_at;}
 else if(a==='close'){requireValue(manager||(requester&&config.requester_can_close),'You cannot close this ticket',403);requireValue(row.status==='resolved','Only resolved tickets can be closed',409);next='closed';}
 else if(a==='reopen'){
  requireValue(manager||(requester&&config.requester_can_reopen),'You cannot reopen this ticket',403);requireValue(['resolved','closed'].includes(row.status)&&note,'Reopen a resolved or closed ticket with a reason');next=row.assigned_to?'assigned':'open';
  meta.opened_at=new Date().toISOString();meta.paused_ms=0;meta.first_response_at=null;meta.resolved_at=null;meta.pause_started=null;meta.sla_cycle=(meta.sla_cycle||1)+1;
 }else requireValue(false,'Unknown ticket action');
 requireValue(!internal||a==='reply','Internal notes cannot change workflow status');
 if(next==='waiting'&&row.status!=='waiting'&&meta.pause_waiting)meta.pause_started=new Date().toISOString();
 if(row.status==='waiting'&&next!=='waiting'&&meta.pause_started){meta.paused_ms=(meta.paused_ms||0)+Date.now()-Date.parse(meta.pause_started);meta.pause_started=null;}
 row.work_meta=meta;row=await saveMeta(db,'tickets',row,next);
 if(a==='resolve'||a==='reopen')await db.run('UPDATE support_tickets SET resolved_by=?,resolved_at=? WHERE id=?',a==='resolve'?req.user.id:null,meta.resolved_at||null,row.id);
 await db.run('UPDATE support_tickets SET updated_at=? WHERE id=?',new Date().toISOString(),row.id);
 await event(db,req,'tickets',row,a,{note,assignee:row.assigned_to,evidence:b._files||[]},internal);return row;
}

export async function validateDefinition(db:Db,req:any,b:any,action='create'){
 const branchId=await branch(db,b.branch_id),d=structuredClone(b.definition||{});
 d.title=textValue(d.title,'Template title',200);d.instructions=textValue(d.instructions,'Instructions',10000,true);
 requireValue(Array.isArray(d.items)&&d.items.length>0&&d.items.length<=100,'A template needs 1–100 items');
 const ids=new Set();for(const item of d.items){item.id=textValue(item.id,'Item ID',80);requireValue(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(item.id)&&!ids.has(item.id),'Item IDs must be unique alphanumeric identifiers');ids.add(item.id);item.label=textValue(item.label,'Item label',300);item.section=textValue(item.section,'Section',150,true);item.instructions=textValue(item.instructions,'Item instructions',2000,true);requireValue(['none','note','file'].includes(item.evidence||'none'),'Choose none, note or file evidence');item.required=!!item.required;item.allow_na=!!item.allow_na;}
 const s=d.schedule||{};requireValue(['daily','weekly','monthly','selected_days','once'].includes(s.frequency),'Select a supported schedule');
 s.start=dateValue(s.start,'Start date');s.end=s.end?dateValue(s.end,'End date'):null;requireValue(!s.end||s.end>=s.start,'End must be on or after start');
 requireValue(/^([01]\d|2[0-3]):[0-5]\d$/.test(s.due_time),'Choose a valid due time');
 requireValue(typeof s.timezone==='string'&&await db.get('SELECT name FROM pg_timezone_names WHERE name=?',s.timezone),'Choose a valid IANA timezone');
 requireValue(['catch_up','skip'].includes(s.missed),'Choose catch_up or skip for missed runs');
 if(['selected_days','weekly'].includes(s.frequency))requireValue(Array.isArray(s.days)&&s.days.length&&s.days.every((n:any)=>Number.isInteger(n)&&n>=0&&n<=6),'Choose weekdays (Sunday=0)');
 if(s.frequency==='monthly')requireValue(Number.isInteger(s.month_day)&&s.month_day>=1&&s.month_day<=31,'Choose a day from 1 to 31');
 requireValue(Array.isArray(d.assignees)&&d.assignees.length<=100,'Choose up to 100 accountable employees');
 if(d.team_manager_id){await activeUser(db,d.team_manager_id);const team=await db.all('SELECT e.user_id FROM employees e JOIN employees m ON m.id IN(e.reporting_manager_id_1,e.reporting_manager_id_2) WHERE m.user_id=? AND e.user_id IS NOT NULL',d.team_manager_id);d.assignees.push(...team.map((u:any)=>u.user_id));}
 d.assignees=[...new Set(d.assignees.map(Number))];requireValue(d.assignees.length&&d.assignees.length<=100,'At least one accountable employee is required');
 for(const uid of d.assignees){await assignable(db,req,'templates',action,uid,branchId);if(d.review_required){requireValue(Number(d.reviewer_id)!==uid,'Reviewer must differ from assignees');await activeUser(db,d.reviewer_id);await reviewerAllowed(db,Number(d.reviewer_id),'checklists',uid,branchId);}}
 d.branch_id=branchId;d.schedule=s;d.effective_from=dateValue(d.effective_from||s.start,'Version effective date');
 const today=(await db.get("SELECT to_char(now() AT TIME ZONE ?,'YYYY-MM-DD') AS day",s.timezone)).day;
 requireValue(d.effective_from>=today,'New template versions cannot change past dates');
 return d;
}
export async function templateSave(db:Db,req:any,id:any,b:any){
 requireValue(grants(req,'checklists','create').length,'Template management requires Create permission',403);
 let row=id?await record(db,req,'templates',id,'edit',true):null;if(row)checkVersion(row,b);
 const d=await validateDefinition(db,req,b,row?'edit':'create');
 if(!row)row=await db.get('INSERT INTO checklists(title,description,assigned_to,created_by,branch_id,frequency,work_meta) VALUES(?,?,?,?,?,\'once\',\'{}\') RETURNING *',d.title,d.instructions,d.assignees[0],req.user.id,d.branch_id);
 requireValue(row.work_meta.state!=='retired','Retired templates cannot be revised');
 requireValue(!row.branch_id||row.branch_id===d.branch_id,'Retain the branch; create another template for a different branch');
 if(row.work_meta.definition)requireValue(d.effective_from>=row.work_meta.definition.effective_from,'New versions cannot precede the previous version effective date');
 const v=await db.get('INSERT INTO work_checklist_versions(checklist_id,version,definition,created_by) VALUES(?,?,?::text::jsonb,?) RETURNING id',row.id,row.work_version,JSON.stringify(d),req.user.id);
 row.work_meta={...row.work_meta,state:row.work_meta.state||'active',definition:d,template_version_id:v.id};row.branch_id=d.branch_id;
 await db.run('UPDATE checklists SET title=?,description=?,assigned_to=?,branch_id=?,created_by=COALESCE(created_by,?) WHERE id=?',d.title,d.instructions,d.assignees[0],d.branch_id,req.user.id,row.id);row.title=d.title;row.created_by=row.created_by||req.user.id;
 row=await saveMeta(db,'templates',row);await event(db,req,'templates',row,'template_published',{version_id:v.id,definition:d});return row;
}
export async function occurrenceAction(db:Db,req:any,id:any,b:any){
 let row=await record(db,req,'occurrences',id,'view',true);checkVersion(row,b);
 const meta=row.work_meta,def=(await db.get('SELECT definition FROM work_checklist_versions WHERE id=?',row.template_version_id)).definition;
 const a=b.action,note=textValue(b.note,'Note',10000,true);let next=row.status;
 if(a==='save'||a==='submit'){
  requireValue(row.assigned_to===req.user.id&&await allowed(db,req,'occurrences','edit',row),'Only the accountable employee can complete this occurrence',403);
  requireValue(['pending','in_progress','rejected'].includes(row.status),'Submitted or completed occurrences are locked',409);
  requireValue(b.answers&&typeof b.answers==='object'&&!Array.isArray(b.answers),'Item answers are required');
  const answers:any={};for(const item of def.items){const answer=b.answers[item.id]||{status:'todo'};requireValue(['todo','done','na'].includes(answer.status),'Choose a valid item status');
   answer.note=textValue(answer.note,'Item note',4000,true);answer.evidence=await evidence(db,req,'occurrences',row.id,answer.evidence||[]);
   if(answer.status==='na')requireValue(item.allow_na&&answer.note,'Not applicable requires permission and a reason');
   if(a==='submit'){
    if(item.required)requireValue(answer.status!=='todo',`Complete required item: ${item.label}`);
    if(answer.status==='done'&&item.evidence==='file')requireValue(answer.evidence.length,`Attach evidence for: ${item.label}`);
    if(answer.status==='done'&&item.evidence==='note')requireValue(answer.note,`Add a note for: ${item.label}`);
   }answers[item.id]=answer;
  }
  meta.answers=answers;next=a==='save'?'in_progress':def.review_required?'submitted':'approved';
  if(a==='submit'){meta.submitted_at=new Date().toISOString();meta.submitted_by=req.user.id;if(def.review_required)await reviewerAllowed(db,Number(def.reviewer_id),'checklists',row.assigned_to,row.branch_id);}
 }else if(a==='approve'||a==='return'){
  requireValue(await allowed(db,req,'occurrences','approve',row)&&row.assigned_to!==req.user.id,'Independent Approve permission is required',403);
  requireValue(row.status==='submitted','Only submitted checklists can be reviewed',409);requireValue(a!=='return'||note,'Explain why work is returned');next=a==='approve'?'approved':'rejected';
 }else requireValue(false,'Unknown checklist action');
 row=await saveMeta(db,'occurrences',row,next);await event(db,req,'occurrences',row,a,{note,answers:meta.answers});return row;
}
