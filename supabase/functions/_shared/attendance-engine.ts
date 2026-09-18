// Pure, shared attendance evaluation. Undecided policy outcomes stay unresolved.
export const ENGINE_VERSION='attendance-v2';
export const jsonValue=(v:any)=>{if(typeof v!=='string')return v;try{return JSON.parse(v);}catch{return null;}};
export const isoDay=(d=new Date())=>new Date(d.getTime()+330*60000).toISOString().slice(0,10);
export const validDay=(v:any)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
export const validMonth=(v:any)=>typeof v==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(v);
export const addDays=(d:string,n:number)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
export const minutes=(v:any)=>typeof v==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(v)?Number(v.slice(0,2))*60+Number(v.slice(3)):null;
export const round=(v:number)=>Math.round((v+Number.EPSILON)*100)/100;
export function monthDays(month:string){
 if(!validMonth(month))throw Error('Valid YYYY-MM month required');
 const end=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).getUTCDate();
 return Array.from({length:end},(_,i)=>`${month}-${String(i+1).padStart(2,'0')}`);
}
export function validateSegments(segments:any){
 if(!Array.isArray(segments)||!segments.length||segments.length>8)throw Error('A shift needs 1 to 8 ordered work segments');
 let priorEnd=-1;
 for(const s of segments){
  const start=minutes(s.start),end=minutes(s.end),sd=Number(s.start_day??0),ed=Number(s.end_day??(end!==null&&start!==null&&end<=start?1:0));
  if(start===null||end===null||![0,1].includes(sd)||![0,1].includes(ed))throw Error('Segments require HH:MM times and day offsets 0 or 1');
  const a=start+sd*1440,b=end+ed*1440;
  if(b<=a||a<priorEnd)throw Error('Shift segments must be ordered, non-overlapping and have a positive duration');
  s.start_day=sd;s.end_day=ed;priorEnd=b;
 }
 return segments;
}
export function shiftPlan(date:string,shift:any){
 if(!shift)return null;
 const segments=jsonValue(shift.segments)||[{start:shift.shift_start,end:shift.shift_end}];
 if(!segments[0]?.start||!segments[0]?.end)return null;
 validateSegments(segments);
 const base=Date.parse(date+'T00:00:00+05:30');
 const windows=segments.map((s:any)=>({start:new Date(base+(minutes(s.start)!+s.start_day*1440)*60000).toISOString(),end:new Date(base+(minutes(s.end)!+s.end_day*1440)*60000).toISOString()}));
 return {template_id:shift.template_id||shift.id||null,name:shift.name||'Employee shift',segments,windows,start:windows[0].start,end:windows.at(-1).end,scheduled_minutes:windows.reduce((n:number,w:any)=>n+(Date.parse(w.end)-Date.parse(w.start))/60000,0)};
}
export function validatePolicy(r:any){
 const ranges:any={grace_minutes:[0,1440],full_day_hours:[0.01,48],half_day_hours:[0,48],late_half_day_minutes:[0,2880],late_grace_count:[0,31],late_per_minute_rate:[0,100000],lates_to_absent:[0,31],ot_threshold_hours:[0.01,48],ot_rate_multiplier:[0,100],cl_per_month:[0,31],sl_per_month:[0,31],pl_per_month:[0,31]};
 for(const [key,range] of Object.entries(ranges) as any){if(!Number.isFinite(r[key])||r[key]<range[0]||r[key]>range[1])throw Error(`Valid ${key} required (${range[0]} to ${range[1]})`);}
 if(!Number.isInteger(r.late_grace_count)||!Number.isInteger(r.lates_to_absent))throw Error('Late count thresholds must be whole numbers');
 if(r.half_day_hours>r.full_day_hours)throw Error('Half-day hours cannot exceed full-day hours');
 for(const [k,values] of Object.entries({missing_checkout:['review','absent'],half_day_leave:['review','combine'],off_work:['review','normal','extra_day','comp_off'],sandwich:['none','both_absent'],short_leave:['review','credit_hours'],below_half_day:['review','absent'],capture_exception:['review','reject'],location_scope:['branch','any_active']})){
  if(!values.includes(r[k]))throw Error(`Choose ${k}: ${values.join(', ')}`);
 }
 if(typeof r.weekly_off_paid!=='boolean'||typeof r.allow_multiple_sessions!=='boolean')throw Error('Choose weekly-off payment and multiple-session settings');
 if(r.lates_to_absent>0&&r.late_per_minute_rate>0)throw Error('Choose either absence conversion or per-minute lateness deduction, not both');
 return r;
}
export function evaluateDay(input:any){
 const {date,employee,plan,weeklyOff=false,attendance=[],leaves=[],correction=null,today=isoDay()}=input;
 const policy=jsonValue(input.policy);
 if(correction)correction.proposed=jsonValue(correction.proposed);
 const out:any={date,day:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(date+'T00:00:00Z').getUTCDay()],label:'absent',pay:null,hours:0,late_minutes:0,weekly_off:weeklyOff,paid_leave:0,worked_fraction:0,off_bonus:0,comp_off_credit:0,exceptions:[],engine_version:ENGINE_VERSION,policy_version_id:input.policyId||null,plan};
 if(date>today){return {...out,label:'future',pay:0};}
 if((employee.join_date&&date<employee.join_date)||(employee.employment_end_date&&date>employee.employment_end_date)){return {...out,label:'outside_employment',pay:0};}
 if(!employee.join_date)out.exceptions.push('EMPLOYMENT_START_REQUIRED');
 if(employee.status && employee.status!=='active' && !employee.employment_end_date)out.exceptions.push('EMPLOYMENT_END_REQUIRED');
 if(!policy){out.exceptions.push('POLICY_NOT_CONFIGURED');}
 if(!employee.user_id)out.exceptions.push('EMPLOYEE_LOGIN_REQUIRED');
 if(!plan&&!weeklyOff)out.exceptions.push('SHIFT_NOT_CONFIGURED');
 let intervals:any[]=[];
 for(const row of attendance){
  if(row.review_state==='rejected')continue;
  if(row.review_state==='pending'){out.exceptions.push('CAPTURE_PENDING_REVIEW');continue;}
  if(row.admin_marked){out.exceptions.push('LEGACY_MANUAL_MARK_REQUIRES_REVIEW');continue;}
  if(!row.punch_in_time){out.exceptions.push('MISSING_CHECK_IN');continue;}
  if(!row.punch_out_time){out.exceptions.push('MISSING_CHECK_OUT');continue;}
  const a=Date.parse(row.punch_in_time),b=Date.parse(row.punch_out_time);
  if(!Number.isFinite(a)||!Number.isFinite(b)||b<=a){out.exceptions.push('INVALID_PUNCH_INTERVAL');continue;}
  intervals.push({a,b});
 }
 intervals.sort((a,b)=>a.a-b.a);
 for(let i=1;i<intervals.length;i++)if(intervals[i].a<intervals[i-1].b)out.exceptions.push('OVERLAPPING_SESSIONS');
 if(attendance.filter((a:any)=>a.capture_session==null).length>1)out.exceptions.push('LEGACY_DUPLICATE_RECORDS');
 const merged:any[]=[];for(const x of intervals){const last=merged.at(-1);if(last&&x.a<=last.b)last.b=Math.max(last.b,x.b);else merged.push({...x});}
 out.hours=round(merged.reduce((n,x)=>n+(x.b-x.a)/3600000,0));
 out.punch_in=intervals[0]?new Date(intervals[0].a).toISOString():null;
 out.punch_out=merged.at(-1)?new Date(merged.at(-1).b).toISOString():null;
 if(plan&&intervals.length){
  if(plan.windows?.length>1)out.late_minutes=plan.windows.reduce((total:number,w:any)=>{const start=Date.parse(w.start),end=Date.parse(w.end),first=intervals.find(x=>x.b>start&&x.a<end);return total+(first?Math.max(0,Math.ceil((first.a-start)/60000)-(policy?.grace_minutes||0)):0);},0);
  else out.late_minutes=Math.max(0,Math.ceil((intervals[0].a-Date.parse(plan.start))/60000)-(policy?.grace_minutes||0));
 }
 if(leaves.length>1)out.exceptions.push('OVERLAPPING_LEAVE');
 let worked=0,leaveFraction=0;
 if(policy){
  if(out.hours>=policy.full_day_hours)worked=1;
  else if(out.hours>=policy.half_day_hours&&out.hours>0)worked=.5;
  else if(out.hours>0&&policy.below_half_day==='review')out.exceptions.push('BELOW_HALF_DAY_REVIEW');
  if(policy.late_half_day_minutes>0&&out.late_minutes>policy.late_half_day_minutes)worked=Math.min(.5,worked);
  const leave=weeklyOff?null:leaves[0];
  if(leave){
   const half=leave.leave_type==='half_day',short=leave.leave_type==='short_leave';
   if(half&&policy.half_day_leave==='review')out.exceptions.push('HALF_DAY_LEAVE_REVIEW');
   if(short&&policy.short_leave==='review')out.exceptions.push('SHORT_LEAVE_REVIEW');
   if(!half&&!short&&intervals.length)out.exceptions.push('WORK_AND_FULL_LEAVE_CONFLICT');
   if(short&&policy.short_leave==='credit_hours'){
    const credited=out.hours+Number(leave.hours||0);
    worked=credited>=policy.full_day_hours?1:credited>=policy.half_day_hours?.5:0;
   }else if(!short){leaveFraction=half?.5:1;out.leave_type=leave.leave_type;}
  }
  out.worked_fraction=worked;
  out.paid_leave=Math.min(leaveFraction,Math.max(0,1-worked));
  if(weeklyOff&&!intervals.length&&!leave){out.pay=policy.weekly_off_paid?1:0;out.label='weekly_off';}
  else{
   out.pay=Math.min(1,worked+leaveFraction);
   out.label=leaveFraction?(worked?'leave_and_work':'leave'):worked===1?(out.late_minutes?'late':'present'):worked===.5?'half_day':'absent';
   if(weeklyOff&&intervals.length){
    if(policy.off_work==='review')out.exceptions.push('WEEKLY_OFF_WORK_REVIEW');
    if(policy.off_work==='extra_day')out.off_bonus=worked;
    if(policy.off_work==='comp_off')out.comp_off_credit=worked;
    out.pay+=out.off_bonus;
   }
  }
  if(policy.missing_checkout==='absent'&&out.exceptions.includes('MISSING_CHECK_OUT')){
   out.exceptions=out.exceptions.filter((e:string)=>e!=='MISSING_CHECK_OUT');out.pay=0;out.label='missing_checkout_absent';
  }
 }
 if(correction){
  out.label='corrected';out.pay=correction.proposed.pay_fraction;out.hours=correction.proposed.hours;out.worked_fraction=Math.min(1,out.pay);out.paid_leave=0;out.off_bonus=0;out.comp_off_credit=0;
  out.correction_id=correction.id;out.exceptions=[];out.late_minutes=Number(correction.proposed.late_minutes||0);
 }
 if(out.exceptions.length){out.exceptions=[...new Set(out.exceptions)];out.label='review_required';out.pay=null;}
 return out;
}
