import {permissionRows, scopeSql} from './attendance-access.ts';

// Stylist records have an explicit employee link. Never infer identity from names.
export async function stylistScope(req:any,module:string,column:string){
 const rows=await permissionRows(req.user.id,module,'view');
 if(rows.some((r:any)=>r.scope_mode==='all'))return 'TRUE';
 return `EXISTS (SELECT 1 FROM stylists access_st WHERE access_st.id=${column} AND ${await scopeSql(req,module,'view','access_st.employee_id',true)})`;
}
export async function hasAllSalonAccess(req:any,module:string,action='view'){
 return (await permissionRows(req.user.id,module,action)).some((r:any)=>r.scope_mode==='all');
}
