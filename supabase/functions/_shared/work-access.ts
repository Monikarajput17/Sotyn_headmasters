import pg, {type Db} from './pg.ts';
import {idNumber} from './attendance-access.ts';
export const WORK_MODULES=new Set(['delegations','checklists','help_tickets','work_settings']);
export const kinds:any={tasks:{table:'delegations',module:'delegations',owner:'assigned_by',title:'title'},tickets:{table:'support_tickets',module:'help_tickets',owner:'user_id',title:'subject'},templates:{table:'checklists',module:'checklists',owner:'created_by',title:'title'},occurrences:{table:'work_occurrences',module:'checklists',owner:'created_by',title:'title'}};
export class WorkError extends Error {constructor(public status:number,message:string){super(message);}}
export function requireValue(ok:any,message:string,status=400):asserts ok {if(!ok)throw new WorkError(status,message);}
export const kindOf=(kind:string)=>{requireValue(Object.hasOwn(kinds,kind),'Unknown work module',404);return kinds[kind];};
export async function loadWorkGrants(req:any){
 if(!req.workGrants) req.workGrants=await pg.all('SELECT rp.* FROM role_permissions rp JOIN user_roles ur ON ur.role_id=rp.role_id WHERE ur.user_id=?',req.user.id);
 return req.workGrants;
}
export function grants(req:any,module:string,action:string){return (req.workGrants||[]).filter((r:any)=>r.module===module&&r['can_'+action]===1);}
export function scope(req:any,kind:string,action:string,alias='w',assignment=false){
 const k=kindOf(kind),uid=idNumber(req.user.id),clauses:string[]=[];
 for(const r of grants(req,k.module,action)){
  if(r.scope_mode==='all')return 'TRUE';
  const self=assignment?`${alias}.assigned_to=${uid}`:`(${alias}.assigned_to=${uid} OR ${alias}.${k.owner}=${uid}${kind==='tasks'?` OR ${alias}.work_meta->'collaborators' @> '[${uid}]'::jsonb`:''})`;
  if(r.scope_mode==='self')clauses.push(self);
  if(r.scope_mode==='team')clauses.push(`(${self} OR EXISTS(SELECT 1 FROM employees e JOIN employees m ON m.id IN(e.reporting_manager_id_1,e.reporting_manager_id_2) WHERE (e.user_id=${alias}.assigned_to${kind==='tickets'&&!assignment?` OR e.user_id=${alias}.user_id`:''}) AND m.user_id=${uid}))`);
  if(r.scope_mode==='branch'){
   let ids:number[]=[];try{ids=JSON.parse(r.scope_branches||'[]').map(idNumber).filter(Boolean);}catch{}
   if(ids.length)clauses.push(`${alias}.branch_id IN(${ids.join(',')})`);
  }
 }
 return clauses.length?`(${clauses.join(' OR ')})`:'FALSE';
}
export async function allowed(db:Db,req:any,kind:string,action:string,row:any,assignment=false){
 const k=kindOf(kind);
 return !!await db.get(`SELECT 1 FROM (SELECT ?::bigint AS assigned_to,?::bigint AS ${k.owner},?::bigint AS branch_id,?::text::jsonb AS work_meta) w WHERE ${scope(req,kind,action,'w',assignment)}`,row.assigned_to,row[k.owner],row.branch_id,JSON.stringify(row.work_meta||{}));
}
export async function record(db:Db,req:any,kind:string,id:any,action='view',lock=false){
 const k=kindOf(kind);requireValue(idNumber(id),'Invalid record ID');
 const r=await db.get(`SELECT w.* FROM ${k.table} w WHERE w.id=? AND ${scope(req,kind,action)}${lock?' FOR UPDATE':''}`,id);
 requireValue(r,'Record unavailable in your permitted scope',404);return r;
}
export const textValue=(value:any,label:string,max=4000,optional=false)=>{
 const s=String(value??'').trim();requireValue((optional||s.length>0)&&s.length<=max,`${label} ${optional?'must be':'is required and must be'} at most ${max} characters`);return s;
};
export function dateValue(value:any,label='Date'){const s=String(value||'');requireValue(/^\d{4}-\d{2}-\d{2}$/.test(s)&&!isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s,`${label} must be a valid YYYY-MM-DD date`);return s;}
export function instant(value:any){requireValue(typeof value==='string'&&/T.*(Z|[+-]\d\d:\d\d)$/.test(value)&&!isNaN(Date.parse(value)),'Deadline must include a timezone');return new Date(value).toISOString();}
export async function activeUser(db:Db,id:any){requireValue(idNumber(id)&&await db.get('SELECT id FROM users WHERE id=? AND active=1 AND COALESCE(archived,0)=0',id),'An active assignee is required');return Number(id);}
export async function branch(db:Db,id:any){requireValue(idNumber(id)&&await db.get('SELECT id FROM attendance_branches WHERE id=? AND active=1',id),'An active branch is required');return Number(id);}
export function checkVersion(row:any,body:any){requireValue(Number.isInteger(body.version)&&body.version===row.work_version,'This record changed. Refresh before saving your changes.',409);}
