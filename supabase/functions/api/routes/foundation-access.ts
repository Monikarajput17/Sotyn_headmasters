import {authMiddleware} from '../../_shared/auth.ts';
import {permissionManager,idNumber} from '../../_shared/attendance-access.ts';
import pg from '../../_shared/pg.ts';
import type {RouterImpl} from '../../_shared/express-lite.ts';

export function mountFoundationAccess(router:RouterImpl){
 router.get('/foundation-access',authMiddleware,permissionManager,async(_req,res)=>{
  res.json({branches:await pg.all('SELECT * FROM attendance_branches ORDER BY name'),
   employees:await pg.all('SELECT id,name,user_id,attendance_branch_id,reporting_manager_id_1,reporting_manager_id_2 FROM employees ORDER BY name'),
   users:await pg.all('SELECT id,name,username FROM users WHERE active=1 ORDER BY name'),
   locations:await pg.all('SELECT id,site_name,attendance_branch_id FROM geofence_settings ORDER BY site_name'),
   conflicts:await pg.all('SELECT * FROM attendance_foundation_conflicts ORDER BY kind,subject'),
   roleAssignments:await pg.all('SELECT user_id,role_id FROM user_roles')});
 });
 router.post('/foundation-access/branches',authMiddleware,permissionManager,async(req,res)=>{
  const {code,name}=req.body;
  if(!/^[A-Z0-9_-]{1,30}$/.test(code)||typeof name!=='string'||!name.trim())return res.status(400).json({error:'Branch code (A-Z, digits, _ or -) and name required'});
  try{const r=await pg.run('INSERT INTO attendance_branches(code,name) VALUES(?,?)',code,name.trim());res.status(201).json({id:r.lastInsertRowid});}
  catch{return res.status(409).json({error:'Branch code already exists'});}
 });
 router.put('/foundation-access/employees/:id',authMiddleware,permissionManager,async(req,res)=>{
  const id=idNumber(req.params.id),b=req.body;
  if(!await pg.get('SELECT id FROM employees WHERE id=?',id))return res.status(404).json({error:'Employee not found'});
  const branch=b.attendance_branch_id? idNumber(b.attendance_branch_id):null;
  if(branch&&!await pg.get('SELECT id FROM attendance_branches WHERE id=? AND active=1',branch))return res.status(400).json({error:'Unknown active branch'});
  for(const k of ['reporting_manager_id_1','reporting_manager_id_2']){
   if(b[k]&&(Number(b[k])===id||!await pg.get('SELECT id FROM employees WHERE id=?',idNumber(b[k]))))return res.status(400).json({error:'Valid different reporting-manager employee required'});
  }
  await pg.run('UPDATE employees SET attendance_branch_id=?,reporting_manager_id_1=?,reporting_manager_id_2=? WHERE id=?',branch,b.reporting_manager_id_1||null,b.reporting_manager_id_2||null,id);
  res.json({message:'Employee access relationships saved'});
 });
 router.put('/foundation-access/locations/:id',authMiddleware,permissionManager,async(req,res)=>{
  const branch=idNumber(req.body.attendance_branch_id);
  if(!branch||!await pg.get('SELECT id FROM attendance_branches WHERE id=?',branch))return res.status(400).json({error:'Valid branch ID required'});
  const r=await pg.run('UPDATE geofence_settings SET attendance_branch_id=? WHERE id=?',branch,req.params.id);
  return r.changes?res.json({message:'Location branch saved'}):res.status(404).json({error:'Location not found'});
 });
}
