import {useEffect,useMemo,useState} from 'react';
import {Link} from 'react-router-dom';
import {FiArrowUpRight,FiArrowRight,FiRefreshCw,FiClock,FiCheckSquare,FiCalendar,FiDollarSign,FiAlertCircle,FiCheckCircle,FiUsers,FiPackage,FiScissors,FiMessageSquare,FiGrid,FiFilter,FiX,FiSun} from 'react-icons/fi';
import {useAuth} from '../context/AuthContext';
import api from '../api';
import './SalonDashboard.css';
const money=n=>'₹'+Number(n).toLocaleString('en-IN',{maximumFractionDigits:2});
const status=s=>s?.replaceAll('_',' ');
const workIds=new Set(['attendance','attendance-review','employees','tasks','tasks-overdue','tasks-review','occurrences','occurrences-overdue','occurrences-review','tickets']);
const category=id=>workIds.has(id)?'work':'salon';
const urgent=c=>(c.id.includes('overdue')||c.id.includes('review')||c.id==='stock')&&Number(c.value)>0;
const needsAction=item=>['submitted','blocked','waiting'].includes(item.status)||(item.due_at&&Date.parse(item.due_at)<Date.now());
const icons={attendance:FiClock,appointments:FiCalendar,employees:FiUsers,clients:FiUsers,stock:FiPackage,services:FiScissors,tickets:FiMessageSquare,occurrences:FiCheckSquare};
function iconFor(c){return urgent(c)?FiAlertCircle:c.format==='money'?FiDollarSign:icons[c.id]||FiCheckSquare;}
function toneFor(c){return urgent(c)?'amber':c.format==='money'?'green':['attendance','appointments'].includes(c.id)?'blue':['occurrences','services'].includes(c.id)?'violet':'blue';}
export default function SalonDashboard(){
 const {user,userRoles,permissions,can,canView}=useAuth();
 const [data,setData]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
 const [section,setSection]=useState('all'),[attention,setAttention]=useState(false);
 const permissionKey=JSON.stringify(permissions);
 useEffect(()=>{let cancelled=false;setLoading(true);setError('');setData(null);
  api.get('/dashboard').then(r=>{if(!cancelled)setData(r.data);}).catch(e=>{if(!cancelled)setError(e.response?.data?.error||'Could not load your dashboard. Please retry.');}).finally(()=>{if(!cancelled)setLoading(false);});
  return()=>{cancelled=true;};
 },[permissionKey,revision,user?.id]);
 useEffect(()=>{setSection('all');setAttention(false);},[user?.id,permissionKey]);
 useEffect(()=>{let last=Date.now();const refresh=()=>{if(document.visibilityState==='visible'&&Date.now()-last>60000){last=Date.now();setRevision(v=>v+1);}};window.addEventListener('focus',refresh);return()=>window.removeEventListener('focus',refresh);},[]);
 const ordered=useMemo(()=>{
  const management=can('delegations','approve')||can('checklists','approve');
  const operational=can('salon_appointments','create')||can('salon_pos','create');
  const priorities=management?['tasks-review','occurrences-review','attendance-review','tasks-overdue','occurrences-overdue','appointments','attendance']:operational?['appointments','bills','sales','stock','attendance']:canView('salon_commissions')?['appointments','commissions','attendance','tasks','occurrences']:['attendance','tasks','occurrences','tickets','tasks-overdue','occurrences-overdue'];
  const rank=id=>priorities.includes(id)?priorities.indexOf(id):100;
  return [...(data?.cards||[])].sort((a,b)=>rank(a.id)-rank(b.id));
 },[data,permissionKey]);
 const focused=ordered.find(urgent)||ordered.find(c=>c.id==='appointments'&&Number(c.value)>0)||ordered.find(c=>c.id==='attendance')||ordered[0];
 const visible=ordered.filter(c=>(section==='all'||category(c.id)===section)&&(!attention||urgent(c)));
 const queues=(data?.queues||[]).filter(q=>section==='all'||(q.id==='appointments'?'salon':'work')===section).map(q=>({...q,items:attention?q.items.filter(needsAction):q.items}));
 const roles=userRoles.map(r=>typeof r==='string'?r:r.name).filter(Boolean);
 const date=data?.today?new Date(data.today+'T12:00:00').toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long'}):'Your daily workspace';
 const reset=()=>{setSection('all');setAttention(false);};
 return <div className="role-dashboard">
  <header className="dash-hero">
   <div className="dash-hero-main"><div className="dash-eyebrow"><FiSun aria-hidden="true"/> HEADMASTERS <span>YOUR WORKSPACE</span></div>
    <h1>Welcome, {user?.name||'there'}</h1><p>A clear view of your day. Start with what matters.</p>
    <div className="dash-role-tags">{roles.slice(0,2).map(r=><span key={r}>{r}</span>)}{roles.length>2&&<details><summary>+{roles.length-2} roles</summary><div>{roles.slice(2).map(r=><p key={r}>{r}</p>)}</div></details>}</div>
   </div>
   <div className="dash-hero-side"><div className="dash-date"><FiCalendar aria-hidden="true"/>{date}</div>
    {data&&focused&&<Link to={focused.href} className="dash-focus" aria-label={`Open ${focused.label}`}><span className="dash-focus-label">{urgent(focused)?'NEEDS YOUR ATTENTION':'YOUR NEXT STOP'}</span><strong>{focused.format==='text'?focused.value:focused.label}</strong><span>{urgent(focused)?`${focused.value} to review`:'Open details and take the next step'}<FiArrowRight aria-hidden="true"/></span></Link>}
   </div>
  </header>
  <div className="dash-toolbar"><span className="dash-updated"><span className={`dash-update-dot ${loading?'is-loading':''}`}/>{loading?'Updating your workspace…':data?`Updated ${new Date(data.generated_at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'})} IST`:'Your workspace'}</span>
   <button className="dash-button" disabled={loading} onClick={()=>setRevision(v=>v+1)}><FiRefreshCw className={loading?'dash-spin':''} aria-hidden="true"/>Refresh dashboard</button>
  </div>
  {loading&&<div role="status" aria-live="polite"><span className="sr-only">Loading your dashboard…</span><div className="dash-summary-grid dash-skeletons" aria-hidden="true">{[0,1,2,3].map(i=><div key={i}><i/><b/><span/></div>)}</div></div>}
  {error&&<div role="alert" className="dash-error"><FiAlertCircle aria-hidden="true"/><div><h2>Your dashboard couldn't load</h2><p>{error}</p><button className="dash-button" onClick={()=>setRevision(v=>v+1)}>Retry dashboard</button></div></div>}
  {data&&<>
   <nav className="dash-shortcuts" aria-label="Dashboard shortcuts"><span>QUICK ACCESS</span><div>{data.links.map(l=><Link key={l.href} to={l.href}>{l.label}<FiArrowUpRight aria-hidden="true"/></Link>)}</div></nav>
   <section aria-labelledby="dash-overview-title"><div className="dash-section-heading"><div><h2 id="dash-overview-title">At a glance</h2><p>Your latest numbers, with a direct path to the details.</p></div><span className="dash-scope-label">Personalised to your access</span></div>
    <div className="dash-filterbar"><div className="dash-segments" aria-label="Dashboard view">{[['all','Overview',FiGrid],['work','Work & attendance',FiCheckSquare],['salon','Salon & billing',FiScissors]].filter(([id])=>id==='all'||ordered.some(c=>category(c.id)===id)).map(([id,label,Icon])=><button key={id} aria-pressed={section===id} onClick={()=>setSection(id)}><Icon aria-hidden="true"/>{label}</button>)}</div>
     <button className={`dash-attention-filter ${attention?'is-active':''}`} aria-pressed={attention} onClick={()=>setAttention(v=>!v)}><FiFilter aria-hidden="true"/>Needs attention{attention&&<FiX aria-hidden="true"/>}</button>
    </div>
    <div className="dash-summary-grid" aria-label="Dashboard summaries">{visible.map(c=>{const Icon=iconFor(c);return <Link data-card={c.id} data-tone={toneFor(c)} className="dash-metric" to={c.href} key={c.id}>
     <div className="dash-metric-top"><span className="dash-metric-icon"><Icon aria-hidden="true"/></span>{urgent(c)?<span className="dash-urgent-tag">Action needed</span>:<FiArrowUpRight className="dash-card-arrow" aria-hidden="true"/>}</div>
     <div className={`dash-metric-value ${c.format==='text'?'is-text':''}`}>{c.format==='money'?money(c.value):c.value}</div><h3>{c.label}</h3><p>{c.detail}</p><span className="dash-card-bottom">View details<FiArrowRight aria-hidden="true"/></span>
    </Link>;})}</div>
    {!visible.length&&<div className="dash-empty"><span><FiCheckCircle aria-hidden="true"/></span><h3>{attention?'Nothing flagged in this view':'No summaries in this view'}</h3><p>{attention?'Try another view or return to your full overview.':'Your summaries will appear when work modules are assigned to your role.'}</p>{ordered.length>0&&<button className="dash-button" onClick={reset}>Show overview</button>}</div>}
   </section>
   {!!queues.length&&<section aria-labelledby="dash-activity-title"><div className="dash-section-heading"><div><h2 id="dash-activity-title">{attention?'Items to look at':'Keep things moving'}</h2><p>{attention?'Flagged items among your dashboard previews. Open a list to see all records.':'Upcoming bookings and unfinished work, ready to open.'}</p></div></div>
    <div className="dash-queue-grid">{queues.map(q=>{const Icon=icons[q.id]||FiCheckSquare;return <section className="dash-queue" key={q.id} aria-label={q.label}><div className="dash-queue-heading"><div><span className="dash-queue-icon"><Icon aria-hidden="true"/></span><h3>{q.label}</h3></div><Link to={q.href}>View all<FiArrowUpRight aria-hidden="true"/></Link></div>
     {!q.items.length?<div className="dash-queue-empty"><FiCheckCircle aria-hidden="true"/><p>{attention?'No flagged items in this preview.':'Nothing pending in this view.'}</p><span>You can still open the full list.</span></div>:q.items.map(item=><Link key={item.id} to={item.href} className="dash-queue-row"><span className={`dash-row-marker ${needsAction(item)?'is-urgent':''}`}/><div className="dash-row-content"><strong>{item.title}</strong><div className="dash-row-meta"><span className={`dash-status status-${item.status}`}>{status(item.status)}</span>{item.appt_date&&<span>{new Date(item.appt_date+'T12:00:00').toLocaleDateString('en-IN',{day:'numeric',month:'short'})} · {item.start_time||'Time not set'}</span>}</div>{item.due_at&&<span className="dash-due"><FiClock aria-hidden="true"/>Due {new Date(item.due_at).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</span>}</div><FiArrowUpRight className="dash-row-arrow" aria-hidden="true"/></Link>)}
    </section>;})}</div>
   </section>}
  </>}
 </div>;
}
