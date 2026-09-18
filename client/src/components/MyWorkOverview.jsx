import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {useAuth} from '../context/AuthContext';
import api from '../api';
const cards=[['tasks','delegations','My tasks','Tasks','/delegations'],['occurrences','checklists',"Today's checklists","Today's checklists",'/checklists'],['tickets','help_tickets','My tickets','Tickets','/help-tickets']];
export default function MyWorkOverview(){
 const {permissions,canView,canViewOthers}=useAuth(),[groups,setGroups]=useState([]),[scope,setScope]=useState('mine');
 const canSupervise=cards.some(([,m])=>canViewOthers(m));
 const effectiveScope=canSupervise?scope:'mine';
 useEffect(()=>{let cancelled=false;
  Promise.all(cards.filter(([,m])=>permissions[m]?.can_view).map(async([kind,module,own,label,path])=>{
   const card={kind,module,label:effectiveScope==='mine'?own:label,path};
   try{const r=await api.get(`/work/${kind}`,{params:{scope:effectiveScope,limit:5,...(kind==='occurrences'?{today:'1'}:{})}});return {...card,...r.data};}
   catch{return {...card,error:true,rows:[]};}
  })).then(r=>{if(!cancelled)setGroups(r);});return()=>{cancelled=true;};
 },[permissions,effectiveScope]);
 return <div className="space-y-4">
  <div className="flex flex-wrap gap-3 items-center">
   {canView('attendance')&&<Link className="btn btn-secondary" to="/attendance">My attendance / Punch in-out</Link>}
   {canSupervise&&<label className="text-sm">Show <select aria-label="Work overview scope" className="select" value={effectiveScope} onChange={e=>setScope(e.target.value)}><option value="mine">My work</option><option value="all">All permitted work</option></select></label>}
  </div>
  <div className="grid md:grid-cols-3 gap-4">{groups.map(g=><section key={g.kind} className="card">
   <Link className="font-semibold text-blue-700" to={`${g.path}?scope=${effectiveScope}`}>{g.label} ({g.total||0})</Link>
   {g.error?<p>Could not load work. Open the module to retry.</p>:!g.rows.length?<p className="text-sm text-gray-500">Nothing in this view.</p>:g.rows.map(r=><Link className="block border-b py-2" key={r.id} to={`${g.path}?record=${r.id}`}><p className="text-sm font-medium">{r.title}</p><p className="text-xs">{r.status.replaceAll('_',' ')}{r.overdue?' · Overdue':''}{r.status==='submitted'?' · Awaiting review':''}</p></Link>)}
  </section>)}</div>
 </div>;
}
