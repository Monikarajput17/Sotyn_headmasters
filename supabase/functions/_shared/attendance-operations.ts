import pg,{type Db} from './pg.ts';
import {ENGINE_VERSION,jsonValue,addDays,evaluateDay,isoDay,monthDays,round,shiftPlan,validDay,validMonth} from './attendance-engine.ts';

export class AttendanceError extends Error{constructor(public status:number,message:string){super(message);}}
export const fail=(message:string,status=400):never=>{throw new AttendanceError(status,message);};
export async function writeLock(db:Db){await db.get('SELECT pg_advisory_xact_lock(7430,1)');}
export async function assertOpen(db:Db,date:string){
 if(!validDay(date))fail('Valid work date required');
 await writeLock(db);
 if(await db.get("SELECT month FROM attendance_periods WHERE month=? AND state='closed'",date.slice(0,7)))fail('This period is closed. An authorized approver must reopen it before changes.',409);
}
export async function hashPayload(value:any){const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));return [...new Uint8Array(d)].map(n=>n.toString(16).padStart(2,'0')).join('');}
export async function resolveDuty(db:Db,employee:any,date:string){
 const roster=await db.get(`SELECT r.*,t.name,t.segments,t.week_off_days FROM attendance_roster_entries r LEFT JOIN attendance_shift_templates t ON t.id=r.template_id WHERE r.employee_id=? AND r.work_date=? ORDER BY r.id DESC LIMIT 1`,employee.id,date);
 const legacy=roster?null:await db.get('SELECT * FROM employee_shifts WHERE employee_id=? AND effective_from<=? ORDER BY effective_from DESC,id DESC LIMIT 1',employee.id,date);
 const weekday=new Date(date+'T00:00:00Z').getUTCDay();
 const off=roster?roster.day_type==='off':legacy?.week_off_day!=null&&Number(legacy.week_off_day)===weekday;
 const shift=roster?.day_type==='work'?roster:legacy;
 const plan=shift?shiftPlan(date,shift):null;
 const policy=await db.get('SELECT * FROM attendance_policy_versions WHERE effective_from<=? ORDER BY effective_from DESC,id DESC LIMIT 1',date);
 if(policy)policy.rules=jsonValue(policy.rules);
 return {date,off,plan,policy,roster_id:roster?.id||null};
}
export async function calculateAttendanceMonth(db:Db,employee:any,month:string,options:{live?:boolean}={}){
 if(!validMonth(month))fail('Valid YYYY-MM month required');
 const period=await db.get('SELECT * FROM attendance_periods WHERE month=?',month);
 if(!options.live&&period?.state==='closed'){
  const frozen=await db.get('SELECT payload FROM attendance_month_snapshots WHERE month=? AND revision=? AND employee_id=?',month,period.revision,employee.id);
  if(frozen)return {...jsonValue(frozen.payload),locked:true};
  // Legacy closed payroll may have no attendance snapshot. Never silently rebuild it.
  return {employee_id:employee.id,employee_name:employee.name,month,locked:true,breakdown:[],exceptions:[{code:'LEGACY_HISTORY_UNAVAILABLE'}],ready:false,paid_days:0,total_hours:0};
 }
 const dates=monthDays(month),start=addDays(dates[0],-1),end=addDays(dates.at(-1)!,1),today=isoDay();
 const records=await db.all('SELECT * FROM attendance WHERE (employee_id=? OR (employee_id IS NULL AND user_id=?)) AND date BETWEEN ? AND ? ORDER BY date,id',employee.id,employee.user_id||null,start,end);
 let leaves=employee.user_id?await db.all("SELECT * FROM leave_requests WHERE user_id=? AND status='approved' AND from_date<=? AND to_date>=?",employee.user_id,end,start):[];
 const shifts=await db.all('SELECT * FROM employee_shifts WHERE employee_id=? AND effective_from<=? ORDER BY effective_from,id',employee.id,end);
 const rosters=await db.all('SELECT r.*,t.name,t.segments,t.week_off_days FROM attendance_roster_entries r LEFT JOIN attendance_shift_templates t ON t.id=r.template_id WHERE r.employee_id=? AND r.work_date BETWEEN ? AND ? ORDER BY r.id',employee.id,start,end);
 const policies=await db.all('SELECT * FROM attendance_policy_versions WHERE effective_from<=? ORDER BY effective_from,id',end);
 const corrections=await db.all("SELECT * FROM attendance_requests WHERE employee_id=? ORDER BY decided_at NULLS FIRST,id",employee.id);
 for(const p of policies)p.rules=jsonValue(p.rules);
 for(const r of corrections)r.proposed=jsonValue(r.proposed);
 for(const r of records)r.shift_snapshot=jsonValue(r.shift_snapshot);
 const amendedIds=new Set(corrections.filter((r:any)=>r.kind==='leave_amendment'&&r.status==='approved').map((r:any)=>r.proposed.leave_id));
 for(const id of amendedIds){const amendment=corrections.filter((r:any)=>r.kind==='leave_amendment'&&r.status==='approved'&&r.proposed.leave_id===id).at(-1);leaves=leaves.filter((l:any)=>Number(l.id)!==Number(id));if(amendment.proposed.action==='replace')leaves.push({...amendment.proposed,id:'amendment-'+amendment.id});}
 const allDates=[start,...dates,end],rulesByDate:any={};
 const breakdown=allDates.map(date=>{
  const rows=records.filter((r:any)=>r.date===date),roster=rosters.filter((r:any)=>r.work_date===date).at(-1),legacy=shifts.filter((r:any)=>r.effective_from<=date).at(-1);
  const captured=rows.find((r:any)=>r.shift_snapshot)?.shift_snapshot;
  const plan=captured||(roster?.day_type==='work'?shiftPlan(date,roster):!roster&&legacy?shiftPlan(date,legacy):null);
  const policyId=rows.find((r:any)=>r.policy_version_id)?.policy_version_id;
  const policy=policyId?policies.find((p:any)=>p.id===policyId):policies.filter((p:any)=>p.effective_from<=date).at(-1);
  const weekday=new Date(date+'T00:00:00Z').getUTCDay();
  const off=roster?roster.day_type==='off':legacy?.week_off_day!=null&&Number(legacy.week_off_day)===weekday;
  rulesByDate[date]=policy?.rules;
  const evaluated=evaluateDay({date,employee,policy:policy?.rules,policyId:policy?.id,plan,weeklyOff:off,attendance:rows,leaves:leaves.filter((l:any)=>l.from_date<=date&&l.to_date>=date),correction:corrections.filter((r:any)=>r.work_date===date&&r.kind==='correction'&&r.status==='approved').at(-1),today});
  if(new Set(rows.map((r:any)=>r.policy_version_id).filter(Boolean)).size>1){evaluated.exceptions.push('MIXED_POLICY_SESSIONS');evaluated.pay=null;evaluated.label='review_required';}
  if(corrections.some((r:any)=>r.status==='pending'&&(r.work_date===date||r.kind==='leave_amendment'&&(r.proposed.original_from<=date&&r.proposed.original_to>=date||r.proposed.from_date<=date&&r.proposed.to_date>=date)))){evaluated.exceptions.push('REQUEST_PENDING_REVIEW');evaluated.pay=null;evaluated.label='review_required';}
  return evaluated;
 });
 // Apply leave allowances once, chronologically, to fractional leave quantities.
 const used:any={casual:0,sick:0,earned:0};
 for(const d of breakdown){
  if(!dates.includes(d.date)||d.pay==null||!d.paid_leave)continue;
  const rule=rulesByDate[d.date],type=d.leave_type,key=['full_day','half_day'].includes(type)?'casual':type;
  if(['casual','sick','earned'].includes(key)){
   const cap=Number(rule?.[key==='casual'?'cl_per_month':key==='sick'?'sl_per_month':'pl_per_month']||0),available=Math.max(0,cap-used[key]);
   const paid=Math.min(available,d.paid_leave);used[key]+=paid;d.pay-=d.paid_leave-paid;d.unpaid_leave=d.paid_leave-paid;d.paid_leave=paid;
  }else if(['unpaid','lwp'].includes(type)){d.pay-=d.paid_leave;d.unpaid_leave=d.paid_leave;d.paid_leave=0;}
 }
 for(let i=1;i<breakdown.length-1;i++){
  const d=breakdown[i],r=rulesByDate[d.date];
  if(d.label==='weekly_off'&&r?.sandwich==='both_absent'){
   const a=breakdown[i-1],b=breakdown[i+1];
   if(a.pay===null||b.pay===null||b.label==='future'){d.pay=null;d.exceptions.push('SANDWICH_NEIGHBOUR_UNRESOLVED');d.label='review_required';}
   else if(a.label==='absent'&&b.label==='absent'){d.pay=0;d.label='weekly_off_sandwich';}
  }
 }
 const days=breakdown.filter((d:any)=>dates.includes(d.date));
 const exceptions=days.flatMap((d:any)=>d.exceptions.map((code:string)=>({date:d.date,code})));
 return {employee_id:employee.id,employee_name:employee.name,month,engine_version:ENGINE_VERSION,breakdown:days,exceptions,ready:exceptions.length===0,locked:false,
  paid_days:round(days.reduce((n:number,d:any)=>n+(d.pay??0),0)),total_hours:round(days.reduce((n:number,d:any)=>n+d.hours,0)),
  late_marks:days.filter((d:any)=>d.late_minutes>0).length,half_days:days.filter((d:any)=>d.pay===.5).length,absent_days:days.filter((d:any)=>d.label==='absent').length,
  paid_leaves:round(days.reduce((n:number,d:any)=>n+d.paid_leave,0)),unpaid_leaves:round(days.reduce((n:number,d:any)=>n+(d.unpaid_leave||0),0)),
  weekly_off_days:days.filter((d:any)=>d.label==='weekly_off'&&d.pay>0).length,off_worked:days.filter((d:any)=>d.weekly_off&&d.worked_fraction>0).length,off_bonus:round(days.reduce((n:number,d:any)=>n+d.off_bonus,0)),
  comp_off_credit:round(days.reduce((n:number,d:any)=>n+d.comp_off_credit,0)),rules_by_date:rulesByDate,leave_used:used,
  source:{employee:{id:employee.id,user_id:employee.user_id,name:employee.name,salary:employee.salary,join_date:employee.join_date,employment_end_date:employee.employment_end_date},attendance_ids:records.map((r:any)=>r.id),roster_ids:rosters.map((r:any)=>r.id),policy_ids:policies.map((r:any)=>r.id),correction_ids:corrections.map((r:any)=>r.id)}};
}
export async function payrollFromAttendance(db:Db,settings:any,employee:any,month:string){
 const existing=await db.get("SELECT * FROM payroll_runs WHERE employee_id=? AND month=? AND (status IN ('finalised','disbursed') OR paid=1)",employee.id,month);
 if(existing){
  if(existing.snapshot_json)return {...jsonValue(existing.snapshot_json),paid:existing.paid,paid_at:existing.paid_at,paid_by:existing.paid_by,status:existing.status,locked:true};
  let breakdown:any[]=[];try{breakdown=JSON.parse(existing.breakdown_json||'[]');}catch{}
  return {...existing,breakdown,locked:true,history_provenance:'legacy_saved_snapshot',sunday_count:existing.sundays};
 }
 const report=await calculateAttendanceMonth(db,employee,month),days=report.breakdown,total=monthDays(month).length;
 const adj=await db.get('SELECT * FROM payroll_advances WHERE employee_id=? AND month=?',employee.id,month)||{};
 const pendingAdjustments=await db.all("SELECT id FROM payroll_attendance_adjustments WHERE employee_id=? AND target_month=? AND status='pending'",employee.id,month);
 if(pendingAdjustments.length){report.ready=false;report.exceptions.push({code:'PAYROLL_ADJUSTMENT_PENDING'});}
 const adjustments=await db.all("SELECT id,amount FROM payroll_attendance_adjustments WHERE employee_id=? AND target_month=? AND status='approved'",employee.id,month);
 let paidDays=report.paid_days,latePenalty=0,lateIndex=0,otHours=0,latesAsAbsent=0;
 for(const d of days){
  const rule=report.rules_by_date?.[d.date];if(!rule||d.pay==null)continue;
  if(d.late_minutes>0){lateIndex++;if(lateIndex>rule.late_grace_count)latePenalty+=d.late_minutes*rule.late_per_minute_rate;if(rule.lates_to_absent>0&&lateIndex>rule.late_grace_count&&(lateIndex-rule.late_grace_count)%rule.lates_to_absent===0)latesAsAbsent++;}
  if(employee.ot_eligible)otHours+=Math.max(0,d.hours-rule.ot_threshold_hours);
 }
 paidDays=Math.max(0,paidDays-latesAsAbsent);
 const counted=days.filter((d:any)=>!['future','outside_employment'].includes(d.label)).length;
 if(employee.salary_exempt)paidDays=counted;
 const autoDays=paidDays,paidLeaves=adj.cl_override??report.paid_leaves;
 if(adj.paid_days_override!=null)paidDays=Number(adj.paid_days_override);else paidDays+=paidLeaves-report.paid_leaves;
 if(adj.late_penalty_override!=null)latePenalty=Number(adj.late_penalty_override);
 const salary=Number(employee.salary||0),rate=salary/total,gross=round(rate*paidDays),advance=Number(adj.amount||0),food=Number(adj.food||0);
 let otPay=0;for(const d of days){const r=report.rules_by_date?.[d.date];if(employee.ot_eligible&&r&&d.pay!=null)otPay+=Math.max(0,d.hours-r.ot_threshold_hours)*(rate/r.ot_threshold_hours)*r.ot_rate_multiplier;}
 const adjustmentAmount=adjustments.reduce((n:number,a:any)=>n+Number(a.amount),0),deductions=round(latePenalty+advance);
 const components:any={};for(const [field,setting] of [['basic_pay','basic_pct'],['conveyance','conveyance_pct'],['hra','hra_pct'],['adhoc','adhoc_pct'],['misc','misc_pct']])components[field]=round(gross*Number(settings[setting]||0)/100);
 return {...report,...components,employee_id:employee.id,employee_name:employee.name,department:employee.department,designation:employee.designation,join_date:employee.join_date,
  base_salary:salary,total_days_in_month:total,working_days:total,days_counted:counted,is_current_month:isoDay().startsWith(month),is_future_month:month>isoDay().slice(0,7),user_id:employee.user_id,user_linked:!!employee.user_id,salary_exempt:employee.salary_exempt,
  per_day_rate:round(rate),paid_days:round(paidDays),paid_days_auto:round(autoDays),paid_days_overridden:adj.paid_days_override!=null,paid_leaves:paidLeaves,paid_leaves_auto:report.paid_leaves,cl_overridden:adj.cl_override!=null,
  present_days:round(days.reduce((n:number,d:any)=>n+d.worked_fraction,0)),sunday_count:report.weekly_off_days,sunday_worked:report.off_worked,sunday_worked_pay:report.off_bonus,
  late_penalty:round(latePenalty),late_penalty_auto:round(latePenalty),late_penalty_overridden:adj.late_penalty_override!=null,lates_converted_absent:latesAsAbsent,late_days:days.filter((d:any)=>d.late_minutes>0),
  gross:gross,gross_earned:gross,cl_used:report.leave_used?.casual||0,sl_used:report.leave_used?.sick||0,pl_used:report.leave_used?.earned||0,short_leave_used:days.filter((d:any)=>d.leave_type==='short_leave').length,ot_hours:round(otHours),ot_pay:round(otPay),advance,food,attendance_adjustment:round(adjustmentAmount),adjustment_ids:adjustments.map((a:any)=>a.id),
  total_deductions:deductions,deductions:round(salary-gross+deductions),net_before_ot:round(gross-deductions+food+adjustmentAmount),net_pay:round(gross+otPay-deductions+food+adjustmentAmount),total_earnings:round(gross+otPay),
  breakdown:days,settings_snapshot:settings};
}
