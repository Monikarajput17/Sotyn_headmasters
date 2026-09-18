import pg, { type Db } from './pg.ts';
import type { Handler } from './express-lite.ts';

export const FOUNDATION_MODULES = new Set(['attendance','employees','payroll','attendance_capture','attendance_corrections','attendance_locations','attendance_tracking','employee_shifts','employee_links','attendance_rules','attendance_rosters','attendance_policies','attendance_requests','attendance_periods']);
const fields: Record<string,string> = {view:'can_view',create:'can_create',edit:'can_edit',delete:'can_delete',approve:'can_approve'};
export async function assignAttendanceSelfService(userId:number){
  if(await pg.get("SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=? AND r.name='Viewer'",userId))return;
  const role=await pg.get("SELECT id FROM roles WHERE name='Employee attendance self-service'");
  if(!role)throw new Error('Apply the attendance self-service migration before creating staff logins');
  await pg.run('INSERT INTO user_roles(user_id,role_id) VALUES(?,?) ON CONFLICT DO NOTHING',userId,role.id);
  // New staff logins also start with shared employee work permissions. This
  // runs on account creation/import only; it never restores a revoked grant.
  const work=await pg.get("SELECT id FROM roles WHERE name='Employee work self-service'");
  if(work)await pg.run('INSERT INTO user_roles(user_id,role_id) VALUES(?,?) ON CONFLICT DO NOTHING',userId,work.id);
}
export const idNumber = (v: unknown) => Number.isSafeInteger(Number(v)) && Number(v)>0 ? Number(v) : 0;
export async function permissionRows(userId: number, module: string, action: string) {
  const f=fields[action];
  if (!f) return [];
  return pg.all(`SELECT rp.* FROM role_permissions rp JOIN user_roles ur ON ur.role_id=rp.role_id WHERE ur.user_id=? AND rp.module=? AND rp.${f}=1`,userId,module);
}
export async function hasPermission(userId: number,module: string,action: string) { return (await permissionRows(userId,module,action)).length>0; }
export async function isPermissionManager(userId: number) { return !!await pg.get('SELECT user_id FROM attendance_permission_managers WHERE user_id=?',userId); }
export const permissionManager: Handler = async(req,res,next)=>{
  if (!await isPermissionManager(req.user.id)) return res.status(403).json({error:'Explicit permission-management authority required'});
  next();
};
// Scope is evaluated per action and per role, never combined with an unrelated role's broader scope.
// SQL identifiers are internal constants; all interpolated IDs originate from validated numbers.
export async function scopeSql(req: any,module: string,action: string,column: string,employee=false): Promise<string> {
  const uid=idNumber(req.user.id), rows=await permissionRows(uid,module,action);
  const clauses: string[]=[];
  for(const r of rows){
    if(r.scope_mode==='all') return 'TRUE';
    if(r.scope_mode==='self') clauses.push(`se.user_id=${uid}`);
    if(r.scope_mode==='team') clauses.push(`(se.user_id=${uid} OR EXISTS (SELECT 1 FROM employees sm WHERE sm.user_id=${uid} AND sm.id IN (se.reporting_manager_id_1,se.reporting_manager_id_2)))`);
    if(r.scope_mode==='branch'){
      let ids: number[]=[];try{ids=JSON.parse(r.scope_branches||'[]').map(idNumber).filter(Boolean);}catch{/* fail closed */}
      if(ids.length) clauses.push(`se.attendance_branch_id IN (${ids.join(',')})`);
    }
  }
  const selfWithoutEmployee=rows.some(r=>['self','team'].includes(r.scope_mode)) && !employee ? `${column}=${uid} OR ` : '';
  return clauses.length ? `(${selfWithoutEmployee}EXISTS (SELECT 1 FROM employees se WHERE se.${employee?'id':'user_id'}=${column} AND (${clauses.join(' OR ')})))` : 'FALSE';
}
export async function inScope(req:any,module:string,action:string,id:unknown,employee=false){
  const n=idNumber(id); if(!n)return false;
  const table=employee?'employees':'users';
  return !!await pg.get(`SELECT id FROM ${table} WHERE id=? AND ${await scopeSql(req,module,action,`${table}.id`,employee)}`,n);
}
export async function branchSql(req:any,module:string,action:string,column='attendance_branch_id'){
  const rows=await permissionRows(req.user.id,module,action);if(rows.some(r=>r.scope_mode==='all'))return 'TRUE';
  const ids:number[]=[];for(const r of rows){if(r.scope_mode==='branch'){try{ids.push(...JSON.parse(r.scope_branches||'[]').map(idNumber).filter(Boolean));}catch{}}}
  const branches=ids.length?`${column} IN (${ids.join(',')})`:'FALSE';
  if(action==='view'&&rows.some(r=>['self','team'].includes(r.scope_mode)))return `(${branches} OR ${column} IS NULL OR ${column} IN (SELECT attendance_branch_id FROM employees WHERE user_id=${idNumber(req.user.id)}))`;
  return branches;
}
export async function linkEmployee(db:Db,employeeId:number,userId:number|null){
  // Serialize all link changes, including legacy endpoints; validate the actual stable login ID.
  await db.get('SELECT pg_advisory_xact_lock(7430,1)');
  await db.get('SELECT pg_advisory_xact_lock(7419,1)');
  const existing=await db.get('SELECT user_id FROM employees WHERE id=?',employeeId);
  if(existing?.user_id && Number(existing.user_id)!==Number(userId||0)){
    if(await db.get('SELECT id FROM attendance WHERE user_id=? LIMIT 1',existing.user_id)||await db.get('SELECT id FROM leave_requests WHERE user_id=? LIMIT 1',existing.user_id))throw new Error('This login has attendance history. Preserve its employee link; archive the login instead of reassigning historical records.');
  }
  if(userId&&await db.get('SELECT id FROM attendance WHERE user_id=? AND employee_id IS NOT NULL AND employee_id<>? LIMIT 1',userId,employeeId))throw new Error('This login has attendance belonging to another employee');
  if(userId){
    if(!await db.get('SELECT id FROM users WHERE id=? AND active=1 AND COALESCE(archived,0)=0',userId)) throw new Error('Active login ID required');
    const conflict=await db.get('SELECT id FROM employees WHERE user_id=? AND id<>?',userId,employeeId);
    if(conflict)throw new Error('Login already linked; resolve the existing link explicitly');
  }
  await db.run('UPDATE employees SET user_id=? WHERE id=?',userId,employeeId);
}
