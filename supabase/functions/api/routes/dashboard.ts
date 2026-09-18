import {Router} from '../../_shared/express-lite.ts';
import {authMiddleware,requirePermission} from '../../_shared/auth.ts';
import pg from '../../_shared/pg.ts';
import {scopeSql} from '../../_shared/attendance-access.ts';
import {loadWorkGrants,scope} from '../../_shared/work-access.ts';
import {stylistScope} from '../../_shared/salon-access.ts';
const router=Router();
router.use(authMiddleware,requirePermission('dashboard','view'));
router.get('/',async(req,res)=>{
 try{
  const rows=await loadWorkGrants(req);
  const can=(module:string,action='view')=>rows.some((r:any)=>r.module===module&&r['can_'+action]===1);
  const all=(module:string)=>rows.some((r:any)=>r.module===module&&r.can_view===1&&r.scope_mode==='all');
  const wider=(module:string)=>rows.some((r:any)=>r.module===module&&r.can_view===1&&r.scope_mode!=='self');
  const dates=await pg.get("SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS today,to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM-01') AS month");
  const {today,month}=dates,cards:any[]=[],queues:any[]=[],links:any[]=[];
  const card=(id:string,label:string,value:any,href:string,detail:string,format='number')=>cards.push({id,label,value,href,detail,format});
  for(const [kind,module,path,label] of [['tasks','delegations','/delegations','tasks'],['occurrences','checklists','/checklists','checklists'],['tickets','help_tickets','/help-tickets','tickets']]){
   if(!can(module))continue;
   const predicate=scope(req,kind,'view'),review=can(module,'approve')?`(${scope(req,kind,'approve')})`:'FALSE';
   const table=kind==='tasks'?'delegations':kind==='occurrences'?'work_occurrences':'support_tickets';
   const due=kind==='tasks'?"NULLIF(w.work_meta->>'due_at','')::timestamptz":kind==='occurrences'?'w.due_at':'NULL::timestamptz';
   const closed=kind==='tickets'?"('closed','resolved','cancelled')":"('approved','cancelled')";
   const todayCheck=kind==='occurrences'?"w.work_date=(now() AT TIME ZONE (SELECT definition->'schedule'->>'timezone' FROM work_checklist_versions WHERE id=w.template_version_id))::date":'TRUE';
   const c=await pg.get(`SELECT count(*) FILTER(WHERE w.status NOT IN ${closed} AND ${todayCheck}) AS open,
    count(*) FILTER(WHERE w.status NOT IN ${closed} AND ${due}<now()) AS overdue,
    count(*) FILTER(WHERE w.status='submitted' AND ${review} AND w.assigned_to<>?) AS review
    FROM ${table} w WHERE ${predicate}`,req.user.id);
   const prefix=wider(module)?'Permitted':'My';
   card(kind,`${prefix} ${kind==='occurrences'?"checklists today":'open '+label}`,c.open,`${path}?scope=all&active=1${kind==='occurrences'?'&today=1':''}`,wider(module)?'Within your team / branch / role scope':'Your assigned or own records');
   if(kind!=='tickets'){
    card(kind+'-overdue',`Overdue ${label}`,c.overdue,`${path}?scope=all&overdue=1&today=0`,'Unfinished work past its deadline');
    if(can(module,'approve'))card(kind+'-review',`${label==='tasks'?'Task':'Checklist'} reviews`,c.review,`${path}?scope=all&status=submitted&review=1&today=0`,'Submissions you can review');
   }
   const title=kind==='tickets'?'subject':'title';
   const items=await pg.all(`SELECT w.id,w.${title} AS title,w.status,${due} AS due_at FROM ${table} w
    WHERE ${predicate} AND w.status NOT IN ${closed}
    ORDER BY CASE WHEN ${due}<now() THEN 0 WHEN w.status='submitted' THEN 1 ELSE 2 END,${due} ASC NULLS LAST,w.id DESC LIMIT 5`);
   queues.push({id:kind,label:prefix+' '+label,href:`${path}?scope=all&active=1&today=0`,items:items.map((r:any)=>({...r,href:`${path}?record=${r.id}`}))});
  }
  if(can('attendance')){
   const a=await pg.get("SELECT punch_in_time,punch_out_time FROM attendance WHERE user_id=? AND (date=? OR (punch_in_time IS NOT NULL AND punch_out_time IS NULL AND COALESCE(capture_state,'open')<>'review_closed')) ORDER BY CASE WHEN punch_in_time IS NOT NULL AND punch_out_time IS NULL THEN 0 ELSE 1 END,id DESC LIMIT 1",req.user.id,today);
   card('attendance','My attendance',!a?.punch_in_time?'Not punched in':!a.punch_out_time?'Punched in':'Punched out','/attendance?tab=punch',can('attendance_capture','create')?'Open attendance to punch or view history':'View your attendance history','text');
  }
  if(can('attendance')&&can('attendance_requests')&&can('attendance_requests','approve')){
   const c=await pg.get(`SELECT count(*) AS n FROM attendance_requests r WHERE r.status='pending' AND r.requested_by<>? AND ${await scopeSql(req,'attendance_requests','view','r.employee_id',true)} AND ${await scopeSql(req,'attendance_requests','approve','r.employee_id',true)}`,req.user.id);
   card('attendance-review','Attendance requests',c.n,'/attendance?tab=requests','Pending requests within your review scope');
  }
  if(can('salon_appointments')){
   const allowed=await stylistScope(req,'salon_appointments','a.stylist_id');
   const c=await pg.get(`SELECT count(*) AS n FROM appointments a WHERE ${allowed} AND a.appt_date=? AND a.status NOT IN ('cancelled','no_show')`,today);
   card('appointments',wider('salon_appointments')?"Today's appointments":"My appointments today",c.n,`/salon/appointments?date=${today}`,'Bookings for today');
   const appointments=await pg.all(`SELECT a.id,a.appt_date,a.start_time,a.status,COALESCE(c.name,'Walk-in') AS title FROM appointments a LEFT JOIN salon_clients c ON c.id=a.client_id WHERE ${allowed} AND a.appt_date>=? AND a.status IN ('booked','confirmed') ORDER BY a.appt_date,a.start_time,a.id LIMIT 5`,today);
   queues.unshift({id:'appointments',label:'Upcoming appointments',href:`/salon/appointments?date=${today}`,items:appointments.map((a:any)=>({...a,href:`/salon/appointments?date=${a.appt_date}&record=${a.id}`}))});
  }
  if(all('salon_pos')){
   const billingDate="(p.created_at::timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date";
   const sales=await pg.get(`SELECT count(*) AS n,COALESCE(sum(total),0) AS amount FROM pos_sales p WHERE p.status='paid' AND ${billingDate}=?::date`,today);
   card('bills',"Today's paid bills",sales.n,`/salon/billing?view=history&from=${today}&to=${today}`,'Open the matching bills');
   card('sales',"Today's sales",sales.amount,`/salon/billing?view=history&from=${today}&to=${today}`,'Paid bills only','money');
   if(all('dashboard')){
    const monthSales=await pg.get(`SELECT COALESCE(sum(total),0) AS amount FROM pos_sales p WHERE p.status='paid' AND ${billingDate} BETWEEN ?::date AND ?::date`,month,today);
    card('revenue','Revenue this month',monthSales.amount,`/salon/billing?view=history&from=${month}&to=${today}`,'Paid bills this month','money');
   }
  }
  if(can('salon_commissions')){
   const c=await pg.get(`SELECT COALESCE(sum(i.commission_amount),0) AS amount FROM pos_sale_items i JOIN pos_sales p ON p.id=i.sale_id WHERE p.status='paid' AND ${await stylistScope(req,'salon_commissions','i.stylist_id')} AND (p.created_at::timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ?::date AND ?::date`,month,today);
   card('commissions',wider('salon_commissions')?'Commission this month':'My commission this month',c.amount,`/salon/commissions?from=${month}&to=${today}`,'From paid sales in your scope','money');
  }
  if(all('salon_clients'))card('clients','Clients',(await pg.get('SELECT count(*) AS n FROM salon_clients')).n,'/salon/clients','Open the client directory');
  if(all('salon_products'))card('stock','Low stock products',(await pg.get('SELECT count(*) AS n FROM salon_products WHERE reorder_level>0 AND stock_qty<=reorder_level')).n,'/salon/products?low_only=1','Products at or below reorder level');
  if(can('salon_services'))card('services','Service menu',(await pg.get('SELECT count(*) AS n FROM services WHERE active=1')).n,'/salon/services','Browse available services');
  if(can('employees'))card('employees','Staff in your scope',(await pg.get(`SELECT count(*) AS n FROM employees e WHERE ${await scopeSql(req,'employees','view','e.id',true)}`)).n,'/employees','Open permitted staff records');
  for(const [module,label,href] of [['attendance','My attendance','/attendance'],['salon_appointments','Appointments','/salon/appointments'],['salon_pos','Billing / POS','/salon/billing'],['salon_clients','Clients','/salon/clients'],['delegations','Tasks','/delegations'],['checklists','Checklists','/checklists'],['help_tickets','Help Tickets','/help-tickets'],['salon_services','Service menu','/salon/services'],['payroll','Payroll','/payroll'],['work_settings','Work settings','/work-settings']])if(can(module))links.push({label,href});
  res.setHeader('Cache-Control','no-store');res.json({today,timezone:'Asia/Kolkata',generated_at:new Date().toISOString(),cards,queues,links});
 }catch(e){console.error('Dashboard load failed',e);res.status(503).json({error:'Dashboard could not load. Please retry.'});}
});
export default router;
