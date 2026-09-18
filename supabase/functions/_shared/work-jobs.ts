import {type Db} from './pg.ts';
import {event,settings} from './work-service.ts';
import {allowed} from './work-access.ts';
export const addDay=(day:string,n:number)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
export function scheduled(d:any,day:string){
 const s=d.schedule;if(day<s.start||(s.end&&day>s.end)||day<d.effective_from)return false;
 const date=new Date(day+'T00:00:00Z');
 if(s.frequency==='daily')return true;
 if(s.frequency==='once')return day===s.start;
 if(s.frequency==='weekly'||s.frequency==='selected_days')return s.days.includes(date.getUTCDay());
 // Explicit monthly rule: clamp to the last day of shorter months.
 if(s.frequency==='monthly'){const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();return date.getUTCDate()===Math.min(last,s.month_day);}
 return false;
}
export async function runJobs(db:Db,req:any){
 await db.get('SELECT pg_advisory_xact_lock(7822,1)');
 const run=await db.get('INSERT INTO work_job_runs(actor_id) VALUES(?) RETURNING id',req.user.id);
 let generated=0,escalated=0,remaining=0;
 const rows=await db.all("SELECT * FROM checklists WHERE work_meta->>'state'='active' ORDER BY id FOR UPDATE");
 for(const row of rows){
  if(generated>=100){remaining++;continue;}
  const versions=await db.all('SELECT * FROM work_checklist_versions WHERE checklist_id=? ORDER BY version DESC',row.id);if(!versions.length)continue;
  const latest=versions[0].definition,s=latest.schedule;
  const today=(await db.get("SELECT to_char(now() AT TIME ZONE ?,'YYYY-MM-DD') AS day",s.timezone)).day;
  let first=row.work_meta.generated_through?addDay(row.work_meta.generated_through,1):versions[versions.length-1].definition.effective_from;
  if(s.missed==='skip'&&first<today)first=today;
  if(first>today)continue;
  const last=addDay(first,30)<today?addDay(first,30):today;
  let through=addDay(first,-1);
  dateLoop: for(let day=first;day<=last;day=addDay(day,1)){
   const version=versions.find((v:any)=>v.definition.effective_from<=day);if(!version||!scheduled(version.definition,day)){through=day;continue;}
   const d=version.definition;
   for(const uid of d.assignees){
    if(generated>=100)break dateLoop;
    // Inactive accounts do not receive new work. Existing occurrences are preserved.
    if(!await db.get('SELECT id FROM users WHERE id=? AND active=1 AND COALESCE(archived,0)=0',uid))continue;
    const occurrence=await db.get(`INSERT INTO work_occurrences(checklist_id,template_version_id,title,description,assigned_to,created_by,branch_id,work_date,due_at,work_meta)
     VALUES(?,?,?,?,?,?,?,?,((? || ' ' || ?)::timestamp AT TIME ZONE ?),?::text::jsonb)
     ON CONFLICT(checklist_id,assigned_to,work_date) DO NOTHING RETURNING *`,row.id,version.id,d.title,d.instructions,uid,row.created_by,d.branch_id,day,day,d.schedule.due_time,d.schedule.timezone,JSON.stringify({answers:{},reviewer_id:d.reviewer_id||null}));
    if(occurrence){generated++;await event(db,req,'occurrences',occurrence,'assigned',{template_version:version.id,work_date:day});}
   }
   through=day;
  }
  row.work_meta.generated_through=through;
  await db.run('UPDATE checklists SET work_meta=?::text::jsonb WHERE id=?',JSON.stringify(row.work_meta),row.id);
  if(through<today)remaining++;
 }
 const config=await settings(db);
 if(config.escalations_enabled&&config.notifications_enabled){
  const tickets=await db.all("SELECT * FROM support_tickets WHERE status NOT IN('resolved','closed') AND work_meta->>'opened_at' IS NOT NULL FOR UPDATE");
  for(const t of tickets){
   const m=t.work_meta;if(m.pause_started)continue;
   const elapsed=Date.now()-Date.parse(m.opened_at)-(m.paused_ms||0);
   for(const phase of ['response','resolution']){
    const minutes=m[phase+'_minutes'];if(!minutes||(phase==='response'&&m.first_response_at)||elapsed<minutes*60000)continue;
    for(const uid of m.escalation_ids||[]){
     const grants=await db.all('SELECT rp.* FROM role_permissions rp JOIN user_roles ur ON ur.role_id=rp.role_id JOIN users u ON u.id=ur.user_id WHERE ur.user_id=? AND u.active=1 AND COALESCE(u.archived,0)=0',uid);
     if(!await allowed(db,{user:{id:uid},workGrants:grants},'tickets','view',t))continue;
     const key=`work:sla:${t.id}:${m.sla_cycle||1}:${phase}:${uid}`;
     if(await db.get('SELECT id FROM notifications WHERE dedupe_key=?',key))continue;
     await db.run("INSERT INTO notifications(user_id,type,title,body,link_url,channel_sent,dedupe_key) VALUES(?,'generic',?,?,?,'in_app',?)",uid,`Ticket ${phase} target exceeded`,t.subject,`/help-tickets?record=${t.id}`,key);escalated++;
    }
   }
  }
 }
 const result={generated,escalated,catch_up_pending:remaining,run_id:run.id};
 await db.run('UPDATE work_job_runs SET finished_at=now(),result=?::text::jsonb WHERE id=?',JSON.stringify(result),run.id);return result;
}
