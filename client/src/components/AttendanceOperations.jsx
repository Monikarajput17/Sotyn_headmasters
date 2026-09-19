import {useCallback,useEffect,useState} from 'react';
import api from '../api';
import {useAuth} from '../context/AuthContext';
import toast from 'react-hot-toast';
import Modal from './Modal';
import { FiCheck, FiX, FiCalendar, FiClock, FiCheckCircle, FiAlertCircle } from 'react-icons/fi';

const today=()=>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
const readable=s=>String(s||'').toLowerCase().replaceAll('_',' ');
const numbers={grace_minutes:'Grace after shift start (minutes)',full_day_hours:'Minimum full-day hours',half_day_hours:'Minimum half-day hours',late_half_day_minutes:'Late minutes triggering half day (0 = disabled)',late_grace_count:'Late days without a penalty',late_per_minute_rate:'Penalty per late minute',lates_to_absent:'Late days per absent day (0 = disabled)',ot_threshold_hours:'Daily overtime threshold (hours)',ot_rate_multiplier:'Overtime rate multiplier',cl_per_month:'Monthly casual/full-day leave allowance',sl_per_month:'Monthly sick leave allowance',pl_per_month:'Monthly earned leave allowance'};
const choices={missing_checkout:['review','absent'],half_day_leave:['review','combine'],off_work:['review','normal','extra_day','comp_off'],sandwich:['none','both_absent'],short_leave:['review','credit_hours'],below_half_day:['review','absent'],capture_exception:['review','reject'],location_scope:['branch','any_active']};
const fmt=t=>t?new Date(t).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}):'—';
const Field=({label,children})=><label className="block text-sm"><span className="block text-gray-600 mb-1">{label}</span>{children}</label>;

const DEFAULT_SALON_RULES = {
  grace_minutes: '15',
  full_day_hours: '8',
  half_day_hours: '4',
  late_half_day_minutes: '0',
  late_grace_count: '3',
  late_per_minute_rate: '0',
  lates_to_absent: '3',
  ot_threshold_hours: '9',
  ot_rate_multiplier: '1.5',
  cl_per_month: '1',
  sl_per_month: '1',
  pl_per_month: '1.5',
  missing_checkout: 'review',
  half_day_leave: 'combine',
  off_work: 'extra_day',
  sandwich: 'none',
  short_leave: 'credit_hours',
  below_half_day: 'absent',
  capture_exception: 'review',
  location_scope: 'branch',
  weekly_off_paid: 'true',
  allow_multiple_sessions: 'true',
};

export default function AttendanceOperations({mode,employeeId}){
 const {user,canView,canCreate,canEdit,canApprove}=useAuth();
 const [month,setMonth]=useState(today().slice(0,7)),[data,setData]=useState([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [employees,setEmployees]=useState([]),[templates,setTemplates]=useState([]),[selectedEmployee,setSelectedEmployee]=useState(employeeId||'');
 const [form,setForm]=useState({work_date:today(),pay_fraction:1,hours:'',reason:''});
 const [shift,setShift]=useState({code:'',name:'',week_off_days:[],segments:[{start:'',end:'',start_day:0,end_day:0}]});
 const [rules,setRules]=useState(DEFAULT_SALON_RULES),[effective,setEffective]=useState('2024-01-01'),[reason,setReason]=useState('Standard Headmasters salon attendance policy');
 const [range,setRange]=useState({from:today(),to:today()}),[cycle,setCycle]=useState([{day_type:'work',template_id:''}]),[preview,setPreview]=useState(null),[requestId,setRequestId]=useState(()=>crypto.randomUUID());
 const [leaves,setLeaves]=useState([]),[amend,setAmend]=useState({leave_id:'',action:'cancel',from_date:today(),to_date:today(),leave_type:'full_day',reason:''}),[adjust,setAdjust]=useState({source_month:'',target_month:today().slice(0,7),amount:'',reason:''});
 const [periodReason,setPeriodReason]=useState(''),[history,setHistory]=useState([]);
 const [decisionModal,setDecisionModal]=useState(null);

 const confirmDecision = async () => {
   if (!decisionModal?.request?.id) return;
   const why = decisionModal.reason?.trim() || (decisionModal.status === 'approved' ? 'Approved' : 'Rejected');
   run(async () => {
     await api.put(`/attendance-ops/requests/${decisionModal.request.id}/decision`, {
       status: decisionModal.status,
       reason: why
     });
     toast.success(`Request ${decisionModal.status}`);
     setDecisionModal(null);
     load();
   });
 };

 const run=async(fn)=>{setBusy(true);setError('');try{await fn();}catch(e){const msg=e.response?.data?.error||e.message;setError(msg);toast.error(msg);}finally{setBusy(false);}};
 const load=useCallback(async()=>{
  setError('');try{
   if(mode==='schedule')setData((await api.get('/attendance-ops/my-schedule',{params:{month}})).data);
   if(mode==='results')setData((await api.get('/attendance-ops/my-month',{params:{month}})).data);
   if(mode==='requests'){if(canCreate('attendance_requests'))setEmployees((await api.get('/attendance-ops/request-employees')).data);setData((await api.get('/attendance-ops/requests')).data);setLeaves((await api.get('/attendance/leaves')).data.filter(l=>l.status==='approved'&&Number(l.user_id)===Number(user.id)));}
   if(mode==='rosters'){
    const [r,t,e]=await Promise.all([api.get('/attendance-ops/roster',{params:{month}}),api.get('/attendance-ops/templates'),api.get('/attendance-ops/employees')]);setData(r.data);setTemplates(t.data);setEmployees(e.data);
   }
   if(mode==='policies')setData((await api.get('/attendance-ops/policies')).data);
   if(mode==='periods')setData((await api.get('/attendance-ops/periods')).data);
   if(mode==='adjustments'){setData((await api.get('/attendance-ops/adjustments')).data);setEmployees((await api.get('/attendance-ops/adjustment-employees')).data);}
  }catch(e){setError(e.response?.data?.error||'Could not load attendance information');}
 },[mode,month]);
 useEffect(()=>{load();},[load]);
 useEffect(()=>{if(employeeId)setSelectedEmployee(employeeId);},[employeeId]);
 const downloadTemplate=()=>{const blob=new Blob(['employee_id,work_date,day_type,template_id,reason\r\n'],{type:'text/csv'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='attendance-roster-template.csv';a.click();URL.revokeObjectURL(url);};
 return <section className="space-y-4" aria-label={`Attendance ${mode}`}>
  <div className="flex gap-3 items-center flex-wrap"><h2 className="text-xl font-semibold">{({schedule:'My Schedule',results:'Daily Results',requests:'Requests & Reviews',rosters:'Shifts & Rosters',policies:'Attendance Policies',periods:'Attendance Periods',adjustments:'Payroll Adjustments'})[mode]}</h2>
   {['schedule','results','rosters','periods'].includes(mode)&&<input aria-label="Attendance month" type="month" className="input" value={month} onChange={e=>setMonth(e.target.value)}/>}
   <button className="btn btn-secondary" onClick={load}>Refresh</button>
  </div>
  {error&&<p role="alert" className="p-3 bg-red-50 text-red-700 rounded">{error}</p>}
  {mode==='schedule'&&<div className="card overflow-auto"><table><thead><tr><th>Work date</th><th>Shift</th><th>Sessions (IST)</th></tr></thead><tbody>{Array.isArray(data)&&data.map(d=><tr key={d.date}><td>{d.date}</td><td>{d.off?'Weekly off':d.plan?.name||'Not assigned'}</td><td>{d.plan?.windows.map((w,i)=><div key={i}>{fmt(w.start)} — {fmt(w.end)}</div>)}</td></tr>)}</tbody></table></div>}
  {mode==='results'&&data.breakdown&&<>
   <p className={`card ${data.ready?'bg-green-50':'bg-amber-50'}`}>{data.locked?'Saved closed-period results. ':''}{data.ready?'Attendance has no unresolved exceptions.':`${data.exceptions.length} exception(s) need review before finalization.`}</p>
   <div className="card overflow-auto"><table><thead><tr><th>Date</th><th>Result</th><th>Hours</th><th>Late minutes</th><th>Paid-day fraction</th><th>Comp-off earned</th><th>Review reason</th></tr></thead><tbody>{data.breakdown.map(d=><tr key={d.date}><td>{d.date}</td><td>{readable(d.label)}</td><td>{d.hours}</td><td>{d.late_minutes}</td><td>{d.pay??'Pending review'}</td><td>{d.comp_off_credit||0}</td><td>{d.exceptions.map(readable).join(', ')}</td></tr>)}</tbody></table></div>
  </>}
  {mode==='requests'&&<>
   {canCreate('attendance_requests')&&<form className="card space-y-3" onSubmit={e=>{e.preventDefault();run(async()=>{await api.post('/attendance-ops/requests',{employee_id:Number(selectedEmployee||employeeId),work_date:form.work_date,reason:form.reason,request_id:requestId||crypto.randomUUID(),proposed:{pay_fraction:Number(form.pay_fraction),hours:Number(form.hours),late_minutes:0}});setRequestId(crypto.randomUUID());toast.success('Submitted for review');load();});}}>
    <h3 className="font-semibold">Request an attendance correction</h3><Field label="Employee"><select className="select" value={selectedEmployee} onChange={e=>{setSelectedEmployee(e.target.value);setRequestId(crypto.randomUUID());}}><option value="">Choose employee</option>{employees.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></Field><p className="text-sm text-gray-500">Your original punches remain unchanged. An authorized person must review this request.</p>
    <div className="grid md:grid-cols-3 gap-3"><Field label="Work date"><input className="input" type="date" max={today()} value={form.work_date} onChange={e=>{setRequestId(crypto.randomUUID());setForm({...form,work_date:e.target.value});}}/></Field>
     <Field label="Requested attendance"><select className="select" value={form.pay_fraction} onChange={e=>{setRequestId(crypto.randomUUID());setForm({...form,pay_fraction:e.target.value});}}>{[[0,'Absent'],[.5,'Half day'],[1,'Full day'],[1.5,'One and a half days'],[2,'Two day-equivalents']].map(([v,l])=><option value={v} key={v}>{l}</option>)}</select></Field>
     <Field label="Actual hours worked"><input className="input" type="number" min="0" max="48" step="0.01" value={form.hours} required onChange={e=>{setRequestId(crypto.randomUUID());setForm({...form,hours:e.target.value});}}/></Field></div>
    <Field label="Reason / missing-punch explanation"><textarea className="input w-full" required value={form.reason} onChange={e=>{setRequestId(crypto.randomUUID());setForm({...form,reason:e.target.value});}}/></Field>
    <button disabled={busy||!selectedEmployee||form.hours===''} className="btn btn-primary">Submit correction</button>
   </form>}
   {canCreate('attendance_requests')&&leaves.length>0&&<details className="card"><summary>Amend or cancel my approved leave</summary><form className="space-y-3 mt-3" onSubmit={e=>{e.preventDefault();run(async()=>{await api.post('/attendance-ops/requests',{kind:'leave_amendment',employee_id:employeeId,request_id:requestId,reason:amend.reason,proposed:{...amend,leave_id:Number(amend.leave_id)}});setRequestId(crypto.randomUUID());toast.success('Leave amendment submitted for independent review');load();});}}>
    <Field label="Original approved leave"><select className="select" required value={amend.leave_id} onChange={e=>{setRequestId(crypto.randomUUID());setAmend({...amend,leave_id:e.target.value});}}><option value="">Choose leave</option>{leaves.map(l=><option key={l.id} value={l.id}>{l.from_date} to {l.to_date}: {readable(l.leave_type)}</option>)}</select></Field>
    <select aria-label="Leave amendment action" className="select" value={amend.action} onChange={e=>{setRequestId(crypto.randomUUID());setAmend({...amend,action:e.target.value});}}><option value="cancel">Cancel leave</option><option value="replace">Replace dates / type</option></select>
    {amend.action==='replace'&&<div className="flex gap-3">{['from_date','to_date'].map(k=><Field key={k} label={readable(k)}><input className="input" type="date" value={amend[k]} onChange={e=>{setRequestId(crypto.randomUUID());setAmend({...amend,[k]:e.target.value});}}/></Field>)}<Field label="Leave type"><select className="select" value={amend.leave_type} onChange={e=>{setRequestId(crypto.randomUUID());setAmend({...amend,leave_type:e.target.value});}}><option value="full_day">Full day</option><option value="half_day">Half day (same date)</option></select></Field></div>}
    <Field label="Amendment reason"><input className="input w-full" required value={amend.reason} onChange={e=>{setRequestId(crypto.randomUUID());setAmend({...amend,reason:e.target.value});}}/></Field><button disabled={busy||!employeeId} className="btn btn-primary">Submit leave amendment</button>
   </form></details>}
   <div className="card p-4 space-y-4">
     <div className="flex justify-between items-center flex-wrap gap-2 pb-2 border-b border-gray-100">
      <div>
       <h3 className="font-semibold text-gray-800">Submitted Requests & Reviews</h3>
       <p className="text-xs text-gray-500">Attendance corrections and leave amendments awaiting manager approval.</p>
      </div>
      <span className="text-xs text-gray-600 bg-gray-100 px-2.5 py-1 rounded-full font-medium">
       {Array.isArray(data) ? data.length : 0} request(s)
      </span>
     </div>

     {/* Desktop Table */}
     <div className="hidden md:block overflow-x-auto">
      <table className="w-full text-left text-xs">
       <thead>
        <tr className="border-b text-gray-500 font-semibold uppercase tracking-wider text-[11px] bg-gray-50/50">
         <th className="py-2.5 px-3">Employee & Date</th>
         <th className="py-2.5 px-3">Request</th>
         <th className="py-2.5 px-3">Reason / Evidence</th>
         <th className="py-2.5 px-3">Status</th>
         <th className="py-2.5 px-3 text-right">Decision</th>
        </tr>
       </thead>
       <tbody className="divide-y divide-gray-100">
        {Array.isArray(data) && data.length > 0 ? (
         data.map(r => (
          <tr key={r.id} className="hover:bg-gray-50/60 transition-colors">
           <td className="py-3 px-3">
            <div className="flex items-center gap-2.5">
             <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-600 text-white flex items-center justify-center font-bold text-xs shadow-sm flex-shrink-0">
              {r.employee_name?.slice(0, 1) || 'E'}
             </div>
             <div>
              <div className="font-semibold text-gray-800 text-sm">{r.employee_name}</div>
              <div className="text-[11px] text-gray-500 flex items-center gap-1 mt-0.5">
               <FiCalendar size={11} className="text-gray-400" /> {r.work_date}
              </div>
             </div>
            </div>
           </td>
           <td className="py-3 px-3">
            <span className="font-semibold text-gray-800 capitalize">{readable(r.kind)}</span>
            {r.kind === 'correction' && (
             <div className="text-[11px] text-gray-600 mt-0.5 font-medium">
              {r.proposed?.hours} hrs · <span className="text-indigo-600 font-semibold">{r.proposed?.pay_fraction} day</span>
             </div>
            )}
           </td>
           <td className="py-3 px-3 max-w-xs">
            <p className="text-gray-700 text-xs leading-relaxed">{r.reason}</p>
            {r.capture_evidence?.map((c, i) => (
             <details key={i} className="mt-1 text-[11px] text-indigo-600 cursor-pointer">
              <summary className="hover:underline font-medium">{c.kind === 'in' ? 'Check-in' : 'Checkout'} evidence</summary>
              <div className="p-2 bg-gray-50 rounded-lg mt-1 text-gray-600 space-y-1 border border-gray-100">
               <div>Time: {fmt(c.received_at)}</div>
               <div>GPS: ±{c.evidence?.accuracy ?? '?'}m ({readable(c.evidence?.geofence?.decision)})</div>
               {c.evidence?.photo && (
                <img src={c.evidence.photo} alt="Punch evidence" className="w-28 rounded-lg mt-1 border shadow-sm" />
               )}
              </div>
             </details>
            ))}
            {r.kind === 'leave_amendment' && (
             <p className="text-[11px] text-blue-700 mt-0.5">{r.proposed.action} leave #{r.proposed.leave_id}: {r.proposed.from_date} to {r.proposed.to_date}</p>
            )}
           </td>
           <td className="py-3 px-3">
            {r.status === 'pending' ? (
             <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
              Pending
             </span>
            ) : r.status === 'approved' ? (
             <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
              <FiCheck size={12} className="stroke-[2.5]" /> Approved
             </span>
            ) : (
             <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-50 text-rose-800 border border-rose-200">
              <FiX size={12} className="stroke-[2.5]" /> Rejected
             </span>
            )}
            {r.decision_reason && (
             <div className="text-[10px] text-gray-500 mt-1 italic line-clamp-1">"{r.decision_reason}"</div>
            )}
           </td>
           <td className="py-3 px-3 text-right">
            {r.status === 'pending' && canApprove('attendance_requests') && r.requested_by !== user.id && r.employee_user_id !== user.id ? (
             <div className="inline-flex items-center gap-2 justify-end">
              <button
               disabled={busy}
               onClick={() => setDecisionModal({ isOpen: true, request: r, status: 'approved', reason: 'Approved based on shift record' })}
               className="bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white font-medium text-xs px-3.5 py-1.5 rounded-lg shadow-sm flex items-center gap-1.5 transition-all hover:shadow hover:-translate-y-0.5"
              >
               <FiCheck size={13} className="stroke-[2.5]" />
               Approve
              </button>
              <button
               disabled={busy}
               onClick={() => setDecisionModal({ isOpen: true, request: r, status: 'rejected', reason: 'Incomplete hours / unable to verify' })}
               className="bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 font-medium text-xs px-3.5 py-1.5 rounded-lg shadow-sm flex items-center gap-1.5 transition-all hover:shadow hover:-translate-y-0.5"
              >
               <FiX size={13} className="stroke-[2.5]" />
               Reject
              </button>
             </div>
            ) : r.status === 'pending' ? (
             <span className="text-[11px] text-gray-400 italic">Self-approval restricted</span>
            ) : null}
           </td>
          </tr>
         ))
        ) : (
         <tr>
          <td colSpan={5} className="py-8 text-center text-gray-400 text-xs">
           No attendance requests found
          </td>
         </tr>
        )}
       </tbody>
      </table>
     </div>

     {/* Mobile Cards View */}
     <div className="block md:hidden space-y-3">
      {Array.isArray(data) && data.length > 0 ? (
       data.map(r => (
        <div key={r.id} className="p-3.5 bg-gray-50/80 rounded-xl border border-gray-200/80 space-y-2.5">
         <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
           <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-600 text-white flex items-center justify-center font-bold text-xs shadow-sm flex-shrink-0">
            {r.employee_name?.slice(0, 1) || 'E'}
           </div>
           <div>
            <div className="font-semibold text-gray-800 text-sm">{r.employee_name}</div>
            <div className="text-xs text-gray-500 flex items-center gap-1">
             <FiCalendar size={10} /> {r.work_date}
            </div>
           </div>
          </div>
          {r.status === 'pending' ? (
           <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            Pending
           </span>
          ) : r.status === 'approved' ? (
           <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
            <FiCheck size={12} className="stroke-[2.5]" /> Approved
           </span>
          ) : (
           <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-50 text-rose-800 border border-rose-200">
            <FiX size={12} className="stroke-[2.5]" /> Rejected
           </span>
          )}
         </div>

         <div className="text-xs text-gray-700 bg-white p-2.5 rounded-lg border border-gray-100 space-y-1">
          <div className="font-semibold text-indigo-700 capitalize">
           {readable(r.kind)} {r.kind === 'correction' && `· ${r.proposed?.hours} hrs (${r.proposed?.pay_fraction} day)`}
          </div>
          <p className="text-gray-600">{r.reason}</p>
          {r.decision_reason && <p className="text-[11px] text-gray-500 italic border-t pt-1 mt-1">Decision: "{r.decision_reason}"</p>}
         </div>

         {r.status === 'pending' && canApprove('attendance_requests') && r.requested_by !== user.id && r.employee_user_id !== user.id && (
          <div className="grid grid-cols-2 gap-2 pt-1">
           <button
            disabled={busy}
            onClick={() => setDecisionModal({ isOpen: true, request: r, status: 'approved', reason: 'Approved based on shift record' })}
            className="bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white font-medium text-xs py-2 rounded-lg shadow-sm flex items-center justify-center gap-1.5"
           >
            <FiCheck size={14} className="stroke-[2.5]" />
            Approve
           </button>
           <button
            disabled={busy}
            onClick={() => setDecisionModal({ isOpen: true, request: r, status: 'rejected', reason: 'Incomplete hours / unable to verify' })}
            className="bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 font-medium text-xs py-2 rounded-lg shadow-sm flex items-center justify-center gap-1.5"
           >
            <FiX size={14} className="stroke-[2.5]" />
            Reject
           </button>
          </div>
         )}
        </div>
       ))
      ) : (
       <p className="text-center text-gray-400 py-6 text-xs">No attendance requests found</p>
      )}
     </div>
    </div>
   </>}
  {mode==='rosters'&&<>
   {canCreate('attendance_rosters')&&<details className="card"><summary className="font-semibold cursor-pointer">Create a shift template / new version</summary><form className="space-y-3 mt-3" onSubmit={e=>{e.preventDefault();run(async()=>{await api.post('/attendance-ops/templates',shift);toast.success('New immutable shift version saved');load();});}}>
    <div className="flex gap-3"><Field label="Shift code"><input className="input" value={shift.code} onChange={e=>setShift({...shift,code:e.target.value.toUpperCase()})}/></Field><Field label="Shift name"><input className="input" value={shift.name} onChange={e=>setShift({...shift,name:e.target.value})}/></Field></div>
    {shift.segments.map((s,i)=><div key={i} className="flex flex-wrap gap-2 items-end"><Field label={`Session ${i+1} start`}><input className="input" type="time" value={s.start} onChange={e=>setShift({...shift,segments:shift.segments.map((v,j)=>j===i?{...v,start:e.target.value}:v)})}/></Field><Field label="End"><input className="input" type="time" value={s.end} onChange={e=>setShift({...shift,segments:shift.segments.map((v,j)=>j===i?{...v,end:e.target.value}:v)})}/></Field>{['start_day','end_day'].map(k=><Field key={k} label={k==='start_day'?'Start day':'End day'}><select className="select" value={s[k]} onChange={e=>setShift({...shift,segments:shift.segments.map((v,j)=>j===i?{...v,[k]:Number(e.target.value)}:v)})}><option value={0}>Work date</option><option value={1}>Next day</option></select></Field>)}<button type="button" className="btn btn-secondary" disabled={shift.segments.length===1} onClick={()=>setShift({...shift,segments:shift.segments.filter((_,j)=>j!==i)})}>Remove</button></div>)}
    <button type="button" className="btn btn-secondary" onClick={()=>setShift({...shift,segments:[...shift.segments,{start:'',end:'',start_day:0,end_day:0}]})}>Add split session</button>
    <div className="flex gap-3 flex-wrap"><span>Usual weekly offs (reference; assign Off in the roster cycle):</span>{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d,i)=><label key={d}><input type="checkbox" checked={shift.week_off_days.includes(i)} onChange={e=>setShift({...shift,week_off_days:e.target.checked?[...shift.week_off_days,i]:shift.week_off_days.filter(v=>v!==i)})}/> {d}</label>)}</div><button disabled={busy} className="btn btn-primary">Save shift version</button>
   </form></details>}
   {canEdit('attendance_rosters')&&<div className="card space-y-3"><h3 className="font-semibold">Assign a repeating roster or import assignments</h3>
    <div className="grid md:grid-cols-3 gap-3"><Field label="Employee"><select className="select" value={selectedEmployee} onChange={e=>{setSelectedEmployee(e.target.value);setPreview(null);}}><option value="">Choose employee</option>{employees.map(e=><option key={e.id} value={e.id}>{e.id}: {e.name}</option>)}</select></Field>{['from','to'].map(k=><Field key={k} label={k==='from'?'From date':'To date'}><input className="input" type="date" value={range[k]} onChange={e=>{setRange({...range,[k]:e.target.value});setPreview(null);}}/></Field>)}</div>
    <p className="text-sm text-gray-500">The cycle starts on the From date and repeats. Include off days explicitly; a two-day preview/commit can swap a weekly off while retaining the old assignments.</p>
    <div className="flex gap-2 flex-wrap">{cycle.map((c,i)=><Field key={i} label={`Cycle day ${i+1}`}><select className="select" value={c.day_type==='off'?'off':c.template_id} onChange={e=>{setCycle(cycle.map((v,j)=>j===i?e.target.value==='off'?{day_type:'off',template_id:null}:{day_type:'work',template_id:Number(e.target.value)}:v));setPreview(null);}}><option value="">Choose shift</option><option value="off">Weekly off</option>{templates.map(t=><option value={t.id} key={t.id}>#{t.id} {t.name} v{t.version}</option>)}</select></Field>)}</div>
    <div className="flex flex-wrap gap-2"><button className="btn btn-secondary" onClick={()=>{setCycle([...cycle,{day_type:'off',template_id:null}]);setPreview(null);}}>Add cycle day</button><button className="btn btn-secondary" disabled={cycle.length<2} onClick={()=>{setCycle(cycle.slice(0,-1));setPreview(null);}}>Remove last day</button></div>
    <Field label="Assignment reason"><input className="input w-full" value={reason} onChange={e=>setReason(e.target.value)}/></Field>
    <button className="btn btn-secondary" disabled={busy||!selectedEmployee} onClick={()=>run(async()=>{setPreview((await api.post('/attendance-ops/roster/pattern',{...range,employee_ids:[Number(selectedEmployee)],cycle,reason})).data);setRequestId(crypto.randomUUID());})}>Preview rotation</button>
    <div className="border-t pt-3 space-y-2"><button className="btn btn-secondary" onClick={downloadTemplate}>Download CSV column template</button><p className="text-sm">Import XLSX or CSV with employee_id, work_date (YYYY-MM-DD text), day_type (work/off), template_id and reason. Template IDs are shown in the shift selector. Up to 1,000 rows. Preview must pass before any rows are saved.</p><input aria-label="Import roster file" type="file" accept=".xlsx,.csv" onChange={e=>{const file=e.target.files?.[0];if(!file)return;run(async()=>{const body=new FormData();body.append('file',file);setPreview((await api.post('/attendance-ops/roster/import',body)).data);setRequestId(crypto.randomUUID());});}}/></div>
    {preview&&<div className="space-y-2"><p>{preview.rows.length} valid row(s); {preview.errors.length} error(s).</p>{preview.errors.map((e,i)=><p className="text-red-700 text-sm" key={i}>Row {e.row}: {e.error}</p>)}<div className="max-h-56 overflow-auto"><table><thead><tr><th>Employee ID</th><th>Work date</th><th>Type</th><th>Shift ID</th></tr></thead><tbody>{preview.rows.map((r,i)=><tr key={i}><td>{r.employee_id}</td><td>{r.work_date}</td><td>{r.day_type}</td><td>{r.template_id||'Off'}</td></tr>)}</tbody></table></div><button disabled={busy||!preview.ready} className="btn btn-primary" onClick={()=>run(async()=>{await api.post('/attendance-ops/roster/commit',{rows:preview.rows,request_id:requestId});toast.success('Roster saved');setPreview(null);load();})}>Confirm preview and save</button></div>}
   </div>}
   <div className="card overflow-auto"><table><thead><tr><th>Employee</th><th>Work date</th><th>Assignment</th><th>Reason / history</th></tr></thead><tbody>{Array.isArray(data)&&data.map(r=><tr key={r.id}><td>{r.employee_name}</td><td>{r.work_date}</td><td>{r.day_type==='off'?'Weekly off':r.shift_name}</td><td>{r.reason}<button className="btn btn-secondary ml-2" onClick={()=>run(async()=>setHistory((await api.get('/attendance-ops/roster/history',{params:{employee_id:r.employee_id,date:r.work_date}})).data))}>History</button></td></tr>)}</tbody></table>{history.map(h=><p key={h.id} className="text-sm py-1">{h.work_date}: {h.day_type==='off'?'Weekly off':h.shift_name} - {h.reason} ({fmt(h.created_at)})</p>)}</div>
  </>}
  {mode==='policies'&&<>
   <p className="card bg-amber-50">Choose the business rules explicitly. Published versions are retained; changes apply from their effective date. Closed periods require an authorized reopen. “Review” keeps uncertain days out of finalization.</p>
   {canCreate('attendance_policies')&&<form className="card space-y-4" onSubmit={e=>{e.preventDefault();run(async()=>{const parsed={...rules};Object.keys(numbers).forEach(k=>parsed[k]=rules[k]===''||rules[k]===undefined?null:Number(rules[k]));for(const k of ['weekly_off_paid','allow_multiple_sessions'])parsed[k]=rules[k]==='true'?true:rules[k]==='false'?false:null;await api.post('/attendance-ops/policies',{effective_from:effective,rules:parsed,reason});toast.success('Policy version published');load();});}}>
     <div className="flex flex-wrap justify-between items-center gap-2 pb-2 border-b">
      <div>
        <h3 className="font-semibold text-gray-800">Salon Attendance Policy</h3>
        <p className="text-xs text-gray-500">Configure attendance thresholds, shift rules, and leave allowances.</p>
      </div>
      <button type="button" className="btn btn-secondary text-xs" onClick={()=>{setRules({...DEFAULT_SALON_RULES});setEffective('2024-01-01');setReason('Standard Headmasters salon attendance policy');toast.success('Loaded recommended salon defaults');}}>
        ✨ Load Recommended Salon Defaults
      </button>
     </div>
     <Field label="Effective from"><input className="input" type="date" value={effective} onChange={e=>setEffective(e.target.value)}/></Field>
    <div className="grid md:grid-cols-3 gap-3">{Object.entries(numbers).map(([key,label])=><Field key={key} label={label}><input className="input w-full" type="number" step="any" min="0" value={rules[key]??''} onChange={e=>setRules({...rules,[key]:e.target.value})}/></Field>)}{Object.entries(choices).map(([key,values])=><Field key={key} label={readable(key)}><select className="select w-full" value={rules[key]||''} onChange={e=>setRules({...rules,[key]:e.target.value})}><option value="">Choose a rule</option>{values.map(v=><option key={v} value={v}>{readable(v)}</option>)}</select></Field>)}{['weekly_off_paid','allow_multiple_sessions'].map(key=><Field key={key} label={readable(key)}><select className="select" value={rules[key]??''} onChange={e=>setRules({...rules,[key]:e.target.value})}><option value="">Choose</option><option value="true">Yes</option><option value="false">No</option></select></Field>)}</div>
    <Field label="Reason for publishing"><input className="input w-full" value={reason} onChange={e=>setReason(e.target.value)}/></Field><button disabled={busy} className="btn btn-primary">Publish new version</button>
   </form>}
   <div className="card space-y-2">{Array.isArray(data)&&data.map(p=><details key={p.id}><summary>Version #{p.id} — effective {p.effective_from} — {p.reason}</summary><dl className="grid md:grid-cols-2 text-sm gap-2 p-3">{Object.entries(p.rules).map(([k,v])=><div key={k}><dt className="font-medium">{numbers[k]||readable(k)}</dt><dd>{readable(v)}</dd></div>)}</dl></details>)}</div>
  </>}
  {mode==='adjustments'&&<>
   <p className="card bg-amber-50">A paid salary stays unchanged. After source attendance is reopened, corrected and closed, request the reviewed difference for a later open payroll month. Enter a positive amount for extra payment or negative for recovery. Another authorized person must approve.</p>
   {canEdit('payroll')&&<form className="card space-y-3" onSubmit={e=>{e.preventDefault();run(async()=>{await api.post('/attendance-ops/adjustments',{...adjust,employee_id:Number(selectedEmployee),amount:Number(adjust.amount)});toast.success('Adjustment submitted');load();});}}>
    <Field label="Employee"><select className="select" value={selectedEmployee} onChange={e=>setSelectedEmployee(e.target.value)}><option value="">Choose employee</option>{employees.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
    <div className="grid md:grid-cols-3 gap-3">{['source_month','target_month','amount'].map(k=><Field key={k} label={readable(k)}><input className="input" required type={k==='amount'?'number':'month'} step={k==='amount'?'0.01':undefined} value={adjust[k]} onChange={e=>setAdjust({...adjust,[k]:e.target.value})}/></Field>)}</div>
    <Field label="Reason and calculation of the difference"><textarea className="input w-full" required value={adjust.reason} onChange={e=>setAdjust({...adjust,reason:e.target.value})}/></Field><button disabled={busy||!selectedEmployee} className="btn btn-primary">Request adjustment</button>
   </form>}
   <div className="card overflow-auto"><table><thead><tr><th>Employee</th><th>Source / target month</th><th>Amount</th><th>Reason</th><th>Status / review</th></tr></thead><tbody>{Array.isArray(data)&&data.map(r=><tr key={r.id}><td>{r.employee_name}</td><td>{r.source_month} (revision {r.source_revision})<br/>{r.target_month}</td><td>{r.amount}</td><td>{r.reason}<br/>{r.decision_reason}</td><td>{r.status}{r.status==='pending'&&canApprove('payroll')&&r.created_by!==user.id&&['approved','rejected'].map(status=><button key={status} disabled={busy} className="btn btn-secondary" onClick={()=>{const why=prompt('Reason for this decision');if(why)run(async()=>{await api.put('/attendance-ops/adjustments/'+r.id+'/decision',{status,reason:why});load();});}}>{status==='approved'?'Approve':'Reject'}</button>)}</td></tr>)}</tbody></table></div>
  </>}
  {mode==='periods'&&<>
   <p className="card bg-amber-50">Close only after every employee's exceptions are resolved. Closing saves immutable results. Reopening preserves prior snapshots and paid payroll; paid differences require a later approved adjustment.</p>
   {canApprove('attendance_periods')&&<div className="card flex flex-wrap gap-3"><input aria-label="Period action reason" className="input flex-1" placeholder="Reason for closing / reopening" value={periodReason} onChange={e=>setPeriodReason(e.target.value)}/>{['close','reopen'].map(action=><button disabled={busy} key={action} className="btn btn-primary" onClick={()=>run(async()=>{await api.post('/attendance-ops/periods/'+action,{month,reason:periodReason});toast.success('Period '+action+' recorded');load();})}>{action==='close'?'Close attendance':'Reopen for amendment'}</button>)}</div>}
   <div className="card"><table><thead><tr><th>Month</th><th>State</th><th>Revision</th><th>History</th></tr></thead><tbody>{Array.isArray(data)&&data.map(p=><tr key={p.month}><td>{p.month}</td><td>{p.state}</td><td>{p.revision}</td><td><button className="btn btn-secondary" onClick={()=>run(async()=>setHistory((await api.get(`/attendance-ops/periods/${p.month}/history`)).data))}>View history</button></td></tr>)}</tbody></table>{history.map(h=><p key={h.id} className="text-sm py-1">{h.month} — {h.action}, revision {h.revision}: {h.reason} ({fmt(h.created_at)})</p>)}</div>
  </>}

   {decisionModal?.isOpen && (
    <Modal
      isOpen={true}
      onClose={() => setDecisionModal(null)}
      title={decisionModal.status === 'approved' ? 'Approve Attendance Request' : 'Reject Attendance Request'}
    >
      <div className="space-y-4">
        <div className="p-3 bg-gray-50 rounded-xl text-xs space-y-1.5 border border-gray-100">
          <div className="font-semibold text-gray-800 text-sm flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-indigo-600"></span>
            {decisionModal.request.employee_name}
          </div>
          <div className="text-gray-600">
            Work Date: <span className="font-semibold text-gray-800">{decisionModal.request.work_date}</span>
          </div>
          <div className="text-gray-600">
            Request: <span className="font-semibold text-gray-800 capitalize">{readable(decisionModal.request.kind)}</span>
            {decisionModal.request.kind === 'correction' && ` · ${decisionModal.request.proposed?.hours} hrs (${decisionModal.request.proposed?.pay_fraction} day)`}
          </div>
          <div className="text-gray-700 bg-white p-2 rounded border border-gray-100 mt-1">
            <span className="text-gray-400 font-medium">Employee reason: </span>
            <span className="italic">"{decisionModal.request.reason}"</span>
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1.5">Decision note / reason (required):</label>
          <div className="flex flex-wrap gap-1.5 mb-2.5">
            {(decisionModal.status === 'approved' ? [
              'Approved based on shift record',
              'Verified with floor manager',
              'Camera/punch issue verified',
              'Approved as requested'
            ] : [
              'Incomplete hours / unable to verify',
              'Duplicate request',
              'Punch records conflict',
              'Please discuss with floor manager'
            ]).map((msg) => (
              <button
                type="button"
                key={msg}
                onClick={() => setDecisionModal(prev => ({ ...prev, reason: msg }))}
                className={`text-[11px] px-2.5 py-1 rounded-lg border transition-all ${decisionModal.reason === msg ? 'bg-indigo-50 border-indigo-300 text-indigo-700 font-semibold shadow-xs' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}
              >
                {msg}
              </button>
            ))}
          </div>
          <input
            type="text"
            className="input w-full text-xs"
            placeholder="Enter reason for decision (min 3 chars)"
            value={decisionModal.reason}
            onChange={e => setDecisionModal(prev => ({ ...prev, reason: e.target.value }))}
          />
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-gray-100">
          <button type="button" className="btn btn-secondary text-xs px-4" onClick={() => setDecisionModal(null)}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !decisionModal.reason || decisionModal.reason.trim().length < 3}
            onClick={confirmDecision}
            className={decisionModal.status === 'approved' 
              ? 'bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white font-medium text-xs px-4 py-2 rounded-lg flex items-center gap-1.5 shadow transition-all disabled:opacity-50'
              : 'bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white font-medium text-xs px-4 py-2 rounded-lg flex items-center gap-1.5 shadow transition-all disabled:opacity-50'}
          >
            {decisionModal.status === 'approved' ? <FiCheck size={14} className="stroke-[2.5]" /> : <FiX size={14} className="stroke-[2.5]" />}
            {decisionModal.status === 'approved' ? 'Confirm Approval' : 'Confirm Rejection'}
          </button>
        </div>
      </div>
    </Modal>
   )}
 </section>;
}
