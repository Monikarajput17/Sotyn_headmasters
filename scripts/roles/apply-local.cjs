// Deliberately local-only. Run manually once; never runs during login or startup.
const fs=require('fs'),path=require('path'),{Client}=require('pg');
const {defaults}=require('./defaults.cjs');
(async()=>{
 const db=new Client({connectionString:'postgresql://postgres:postgres@127.0.0.1:54322/postgres'});
 await db.connect();
 try{
  await db.query('BEGIN');
  const marker=(await db.query("SELECT value FROM app_settings WHERE key='local_environment'")).rows[0]?.value;
  if(marker!=='sotyn-headmasters-local')throw Error('Local database marker missing');
  const before={at:new Date().toISOString()};
  for(const table of ['roles','role_permissions','user_roles'])before[table]=(await db.query(`SELECT * FROM ${table}`)).rows;
  fs.mkdirSync('.local',{recursive:true});
  fs.writeFileSync(path.join('.local',`role-defaults-before-${Date.now()}.json`),JSON.stringify(before,null,2));
  const ids={};
  for(const role of defaults){
   const existing=(await db.query('SELECT id FROM roles WHERE name=$1',[role.name])).rows[0];
   if(!existing)throw Error('Missing shared role: '+role.name);
   ids[role.name]=existing.id;
   await db.query('UPDATE roles SET description=$1 WHERE id=$2',[role.description,existing.id]);
   // Remove obsolete construction-era grants, too; keep rows for review/history.
   await db.query("UPDATE role_permissions SET can_view=0,can_create=0,can_edit=0,can_delete=0,can_approve=0,can_see_all=0,scope_mode='self',scope_branches='[]' WHERE role_id=$1",[existing.id]);
   for(const p of role.permissions)await db.query(`INSERT INTO role_permissions(role_id,module,can_view,can_create,can_edit,can_delete,can_approve,can_see_all,scope_mode,scope_branches)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(role_id,module) DO UPDATE SET can_view=EXCLUDED.can_view,can_create=EXCLUDED.can_create,can_edit=EXCLUDED.can_edit,can_delete=EXCLUDED.can_delete,can_approve=EXCLUDED.can_approve,can_see_all=EXCLUDED.can_see_all,scope_mode=EXCLUDED.scope_mode,scope_branches=EXCLUDED.scope_branches`,[existing.id,p.module,p.can_view,p.can_create,p.can_edit,p.can_delete,p.can_approve,p.can_see_all,p.scope_mode,p.scope_branches]);
  }
  // Existing ordinary active employees receive the employee baseline. Isolated
  // authorization fixtures keep their deliberately unusual roles for regression tests.
  await db.query(`INSERT INTO user_roles(user_id,role_id) SELECT DISTINCT u.id,$1::bigint FROM users u JOIN employees e ON e.user_id=u.id
   WHERE u.active=1 AND COALESCE(u.archived,0)=0 AND e.status='active' AND NOT EXISTS
   (SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id AND (r.description ILIKE '%synthetic%' OR r.name='Viewer'))
   AND u.username !~ '^(af|reliability)[0-9]' ON CONFLICT DO NOTHING`,[ids['Employee work self-service']]);
  const fixture=JSON.parse(fs.readFileSync('.local/workflow-fixtures.json','utf8'));
  // Upgrade only the three documented demo logins; replace the manager fixture
  // role with the shared business role, not a role unique to this employee.
  await db.query("DELETE FROM user_roles WHERE user_id=$1 AND role_id IN(SELECT id FROM roles WHERE description ILIKE '%synthetic%')",[fixture.manager.uid]);
  for(const [uid,name] of [[fixture.manager.uid,'Salon Manager'],[fixture.a.uid,'Employee work self-service'],[fixture.b.uid,'Employee work self-service']]){
   await db.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[uid,ids[name]]);
  }
  await db.query('COMMIT');
  console.log('Applied local defaults to '+defaults.length+' shared roles; employee and manager demo logins updated. Backup saved in .local.');
 }catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
