// Load only the requested module. Cold workers serving a notification or login
// must not initialize every ERP module and spreadsheet parser.
import {Router,type RouterImpl} from '../../_shared/express-lite.ts';
function lazy(load:()=>Promise<{default:RouterImpl}>){
 const router=Router();let pending:Promise<{default:RouterImpl}>|null=null;
 router.handle=async(req,res,path)=>{
  if(!pending)pending=load().catch(e=>{pending=null;throw e;});
  return (await pending).default.handle(req,res,path);
 };return router;
}
export const lazyMounts:Array<[string,RouterImpl]>=[
 ['/dashboard',lazy(()=>import('./dashboard.ts'))],
 ['/auth',lazy(()=>import('./auth.ts'))],
 ['/upload',lazy(()=>import('./upload.ts'))],
 ['/salon/services',lazy(()=>import('./salonServices.ts'))],
 ['/salon/stylists',lazy(()=>import('./salonStylists.ts'))],
 ['/salon/clients',lazy(()=>import('./salonClients.ts'))],
 ['/salon/products',lazy(()=>import('./salonProducts.ts'))],
 ['/salon/appointments',lazy(()=>import('./salonAppointments.ts'))],
 ['/salon/pos',lazy(()=>import('./salonPos.ts'))],
 ['/salon/memberships',lazy(()=>import('./salonMemberships.ts'))],
 ['/salon/commissions',lazy(()=>import('./salonCommissions.ts'))],
 ['/salon/public',lazy(()=>import('./salonPublic.ts'))],
 ['/site-chat',lazy(()=>import('./siteChat.ts'))],
 ['/attendance',lazy(()=>import('./attendance.ts'))],
 ['/admin/locations',lazy(()=>import('./locations.ts'))],
 ['/admin/word-count',lazy(()=>import('./wordcount.ts'))],
 ['/admin/changelog',lazy(()=>import('./changelog.ts'))],
 ['/payroll',lazy(()=>import('./payroll.ts'))],
 ['/hr',lazy(()=>import('./hr.ts'))],
 ['/delegations',lazy(()=>import('./delegations.ts'))],
 ['/support',lazy(()=>import('./support.ts'))],
 ['/admin/audit',lazy(()=>import('./audit.ts'))],
 ['/email-rules',lazy(()=>import('./emailRules.ts'))],
 ['/ai-agent',lazy(()=>import('./aiAgent.ts'))],
 ['/push',lazy(()=>import('./push.ts'))],
 ['/admin/backups',lazy(()=>import('./backups.ts'))],
 ['/business-book',lazy(()=>import('./businessBook.ts'))],
 ['/announcements',lazy(()=>import('./announcements.ts'))],
 ['/attendance-ops',lazy(()=>import('./attendance-operations.ts'))],
 ['/work',lazy(()=>import('./work.ts'))],
];
