// Guard older API paths as well as the new UI. Retain read compatibility for
// dashboard consumers; stale clients cannot bypass the versioned write contract.
import type {Handler} from './express-lite.ts';
import {loadWorkGrants,WorkError} from './work-access.ts';
import {listWork} from '../api/routes/work.ts';
export function legacyWork(kind:string):Handler{return async(req,res,_next)=>{
 try{
  await loadWorkGrants(req);
  if(req.method!=='GET')return res.status(409).json({error:'Refresh the application and use the current work screen. Changes require a record version and request key.'});
  const p=req.path;
  if(p==='/'||p==='/checklists'){const result=await listWork(req,kind);return res.json(result.rows);}
  if(p==='/checklists/my-today'){const result=await listWork({...req,query:{scope:'mine',today:'1'}},'occurrences');return res.json(result.rows.map((r:any)=>({...r,completion_id:r.status==='approved'?r.id:null})));}
  if(p==='/mine'){const result=await listWork({...req,query:{scope:'mine',limit:100}},kind);const recent=result.rows.filter((r:any)=>!['resolved','closed'].includes(r.status));return res.json({active:recent.length,recent:recent.slice(0,5)});}
  if(p==='/stats'){const result=await listWork(req,kind);return res.json({total:result.total,pending_mine:result.rows.filter((r:any)=>r.assigned_to===req.user.id&&['pending','rejected'].includes(r.status)).length});}
  return res.status(410).json({error:'This report has moved to the current work screen with scoped pagination.'});
 }catch(e){return res.status(e instanceof WorkError?e.status:500).json({error:(e as Error).message});}
};}
export const legacyChecklists:Handler=(req,res,next)=>req.path.startsWith('/checklists')?legacyWork('templates')(req,res,next):next();
