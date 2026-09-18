import {useEffect,useState} from 'react';
import api from '../api';
import toast from 'react-hot-toast';

export default function AttendanceAccessSetup(){
 const [data,setData]=useState(null),[code,setCode]=useState(''),[name,setName]=useState(''),[employee,setEmployee]=useState(null),[location,setLocation]=useState(null);
 const load=()=>api.get('/auth/foundation-access').then(r=>setData(r.data)).catch(e=>toast.error(e.response?.data?.error||'Could not load access relationships'));
 useEffect(()=>{load();},[]);
 if(!data)return null;
 const save=async()=>{try{await api.put(`/auth/foundation-access/employees/${employee.id}`,employee);toast.success('Access relationships saved');load();}catch(e){toast.error(e.response?.data?.error||'Save failed');}};
 return <div className="card space-y-3">
  <h4 className="font-semibold">Team and branch setup</h4>
  <p className="text-sm text-gray-600">These assignments describe where employees work and who they report to. Permissions come from their roles. Team scope includes the employee and their direct reports; branch scope includes the branches selected in the role's permissions.</p>
  <div className="flex gap-2 flex-wrap"><input aria-label="Branch code" className="input" placeholder="Branch code" value={code} onChange={e=>setCode(e.target.value.toUpperCase())}/><input aria-label="Branch name" className="input" placeholder="Branch name" value={name} onChange={e=>setName(e.target.value)}/><button className="btn btn-secondary" onClick={async()=>{try{await api.post('/auth/foundation-access/branches',{code,name});setCode('');setName('');load();}catch(e){toast.error(e.response?.data?.error||'Could not create branch');}}}>Add branch</button></div>
  <p className="text-sm">Branch IDs: {data.branches.map(b=>`${b.id}: ${b.code} (${b.name})`).join(' · ')||'No branches configured'}</p>
  <select aria-label="Employee access assignment" className="select" value={employee?.id||''} onChange={e=>setEmployee({...data.employees.find(v=>v.id===Number(e.target.value))})}><option value="">Select employee</option>{data.employees.map(e=><option key={e.id} value={e.id}>{e.id}: {e.name}</option>)}</select>
  {employee?.id&&<div className="flex flex-wrap gap-2">
   <select aria-label="Employee branch" className="select" value={employee.attendance_branch_id||''} onChange={e=>setEmployee({...employee,attendance_branch_id:e.target.value||null})}><option value="">Unassigned branch</option>{data.branches.map(b=><option key={b.id} value={b.id}>{b.code}</option>)}</select>
   {['reporting_manager_id_1','reporting_manager_id_2'].map((key,i)=><select key={key} aria-label={`Reporting manager ${i+1}`} className="select" value={employee[key]||''} onChange={e=>setEmployee({...employee,[key]:e.target.value||null})}><option value="">No reporting manager {i+1}</option>{data.employees.filter(e=>e.id!==employee.id).map(e=><option key={e.id} value={e.id}>{e.id}: {e.name}</option>)}</select>)}
   <button className="btn btn-primary" onClick={save}>Save team and branch</button>
  </div>}
  <p className="text-sm text-gray-600">Assign a location to a branch to scope who can maintain it. Attendance Policies determines whether staff may use any active location or only locations in their assigned branch.</p>
  <select aria-label="Location access assignment" className="select" value={location?.id||''} onChange={e=>setLocation({...data.locations.find(v=>v.id===Number(e.target.value))})}><option value="">Select location</option>{data.locations.map(v=><option key={v.id} value={v.id}>{v.id}: {v.site_name}</option>)}</select>
  {location?.id&&<div className="flex gap-2">
   <select aria-label="Location branch" className="select" value={location.attendance_branch_id||''} onChange={e=>setLocation({...location,attendance_branch_id:e.target.value})}><option value="">Select branch</option>{data.branches.map(b=><option key={b.id} value={b.id}>{b.code}</option>)}</select>
   <button className="btn btn-primary" disabled={!location.attendance_branch_id} onClick={async()=>{try{await api.put(`/auth/foundation-access/locations/${location.id}`,{attendance_branch_id:location.attendance_branch_id});toast.success('Location branch saved');load();}catch(e){toast.error(e.response?.data?.error||'Save failed');}}}>Save location scope</button>
  </div>}
  <details><summary>Identity and attendance conflicts ({data.conflicts.length})</summary><p className="text-sm">Resolve by stable employee and login IDs. Existing records are retained; no name matching is performed.</p><pre className="text-xs overflow-auto max-h-56">{JSON.stringify(data.conflicts,null,2)}</pre></details>
 </div>;
}
