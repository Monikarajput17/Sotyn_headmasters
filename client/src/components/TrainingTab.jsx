// Training LMS Admin Tab — manage videos + per-employee assignments.
//
// Mam (2026-05-22 Phase 1 Batch E, module #12): admin adds videos
// (YouTube/Vimeo/direct URL), tags them with target dept/role and
// training_type, then assigns to one or more employees.  Per-video
// progress (assigned / completed) shown at a glance.  Employee-facing
// view lives at /training (separate page).

import { useEffect, useState } from 'react';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';
import {
  FiPlus, FiEdit2, FiTrash2, FiPlayCircle, FiUsers, FiToggleLeft,
  FiToggleRight, FiCheckCircle, FiClock,
} from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';

const TYPES = [
  { v: 'product',       l: 'Product Training',      color: 'bg-purple-500' },
  { v: 'process',       l: 'Process Training',      color: 'bg-blue-500' },
  { v: 'communication', l: 'Communication',         color: 'bg-emerald-500' },
  { v: 'sop',           l: 'SOP',                    color: 'bg-amber-500' },
  { v: 'other',         l: 'Other',                  color: 'bg-gray-500' },
];

export default function TrainingTab() {
  const { canDelete } = useAuth();
  const [videos, setVideos] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [filterType, setFilterType] = useState('all');
  const [showInactive, setShowInactive] = useState(false);

  const [modal, setModal] = useState(false);            // false | 'form' | 'assign' | 'assignmentsList'
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});

  // Assignment modal state
  const [assignTarget, setAssignTarget] = useState(null);
  const [pickedEmps, setPickedEmps] = useState([]);

  // Assignments-list modal state
  const [listTarget, setListTarget] = useState(null);
  const [assignmentsList, setAssignmentsList] = useState([]);

  const load = async () => {
    try {
      const [v, e] = await Promise.all([
        api.get('/hr/training/videos'),
        api.get('/hr/employees'),
      ]);
      setVideos(v.data || []);
      setEmployees(e.data || []);
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({
      title: '', description: '', video_url: '', training_type: 'sop',
      duration_minutes: '', target_dept: '', target_role: '', is_mandatory: false,
    });
    setModal('form');
  };
  const openEdit = (v) => { setEditing(v); setForm({ ...v, is_mandatory: !!v.is_mandatory, is_active: !!v.is_active }); setModal('form'); };
  const save = async (e) => {
    e.preventDefault();
    try {
      if (editing) await api.put(`/hr/training/videos/${editing.id}`, form);
      else         await api.post('/hr/training/videos', form);
      toast.success(editing ? 'Updated' : 'Added');
      setModal(false); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Save failed'); }
  };
  const toggleActive = async (v) => {
    try { await api.put(`/hr/training/videos/${v.id}`, { is_active: !v.is_active }); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const remove = async (v) => {
    if (!confirm(`Delete "${v.title}"? All assignments will be deleted too.`)) return;
    try { await api.delete(`/hr/training/videos/${v.id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
  };

  // ── Assignment flow
  const openAssign = (v) => {
    setAssignTarget(v); setPickedEmps([]); setModal('assign');
  };
  const togglePick = (eid) => {
    setPickedEmps(p => p.includes(eid) ? p.filter(x => x !== eid) : [...p, eid]);
  };
  const submitAssign = async () => {
    if (pickedEmps.length === 0) return toast.error('Pick at least one employee');
    try {
      const r = await api.post(`/hr/training/videos/${assignTarget.id}/assign`, { employee_ids: pickedEmps });
      toast.success(`Assigned to ${r.data.assigned}${r.data.skipped ? ` (${r.data.skipped} already had it)` : ''}`);
      setModal(false); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // ── View assignments for a video
  const openAssignmentsList = async (v) => {
    setListTarget(v); setAssignmentsList([]);
    try {
      const r = await api.get(`/hr/training/videos/${v.id}/assignments`);
      setAssignmentsList(r.data || []);
      setModal('assignmentsList');
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const unassign = async (a) => {
    if (!confirm(`Unassign ${a.employee_name || 'this employee'} from this video?`)) return;
    try { await api.delete(`/hr/training/assignments/${a.id}`); openAssignmentsList(listTarget); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const counts = TYPES.reduce((acc, t) => {
    acc[t.v] = videos.filter(v => v.training_type === t.v && (showInactive || v.is_active)).length;
    return acc;
  }, {});
  const visible = videos.filter(v =>
    (showInactive || v.is_active) &&
    (filterType === 'all' || v.training_type === filterType)
  );

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div>
          <h3 className="font-semibold flex items-center gap-2"><FiPlayCircle /> Training Library</h3>
          <p className="text-[11px] text-gray-500">
            Manage video library + per-employee assignments · employees view their list at <code className="bg-gray-100 px-1 rounded">/training</code>
          </p>
        </div>
        <button onClick={openCreate} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Video</button>
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        <button onClick={() => setFilterType('all')} className={`btn ${filterType === 'all' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}>
          All <span className={`px-1.5 rounded-full text-[10px] font-bold min-w-[22px] text-center ${filterType === 'all' ? 'bg-white/30 text-white' : 'text-white bg-gray-500'}`}>{videos.length}</span>
        </button>
        {TYPES.map(t => {
          const active = filterType === t.v;
          return (
            <button key={t.v} onClick={() => setFilterType(t.v)}
              className={`btn ${active ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}>
              {t.l}
              <span className={`px-1.5 rounded-full text-[10px] font-bold min-w-[22px] text-center ${active ? 'bg-white/30 text-white' : `text-white ${t.color}`}`}>{counts[t.v] || 0}</span>
            </button>
          );
        })}
        <label className="flex items-center gap-1.5 text-[12px] text-gray-600">
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="text-sm w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Video / Type</th>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase w-[180px]">Target</th>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase w-[140px]">Progress</th>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase w-[180px]">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(v => {
              const tp = TYPES.find(t => t.v === v.training_type);
              const pct = v.assigned_count ? Math.round((v.completed_count / v.assigned_count) * 100) : 0;
              return (
                <tr key={v.id} className={`border-t hover:bg-gray-50/60 align-top ${!v.is_active ? 'opacity-50' : ''}`}>
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-900 flex items-center gap-1.5">
                      {v.title}
                      {!!v.is_mandatory && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-100 text-red-700">Mandatory</span>}
                    </div>
                    <a href={v.video_url} target="_blank" rel="noreferrer" className="text-[11px] text-blue-700 hover:underline break-all">
                      {v.video_url.slice(0, 60)}{v.video_url.length > 60 ? '…' : ''}
                    </a>
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded text-white ${tp?.color || 'bg-gray-400'}`}>{tp?.l || v.training_type}</span>
                      {v.duration_minutes && <span className="text-[10px] text-gray-500 flex items-center gap-0.5"><FiClock size={10}/>{v.duration_minutes}min</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-[11px]">
                    {v.target_dept && <div><b>Dept:</b> {v.target_dept}</div>}
                    {v.target_role && <div><b>Role:</b> {v.target_role}</div>}
                    {!v.target_dept && !v.target_role && <span className="text-gray-400">Any</span>}
                  </td>
                  <td className="px-3 py-2 text-[11px]">
                    <div className="flex justify-between mb-0.5">
                      <span className="text-gray-700">{v.completed_count || 0}/{v.assigned_count || 0}</span>
                      <span className="text-gray-500">{pct}%</span>
                    </div>
                    <div className="bg-gray-100 rounded-full h-1.5 overflow-hidden">
                      <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }}/>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      <button onClick={() => openAssign(v)} className="btn btn-primary text-[11px] py-1 px-2"><FiUsers size={11} className="inline mr-1"/>Assign</button>
                      <button onClick={() => openAssignmentsList(v)} className="btn btn-secondary text-[11px] py-1 px-2">View ({v.assigned_count || 0})</button>
                      <button onClick={() => toggleActive(v)} className={`p-1 ${v.is_active ? 'text-emerald-600' : 'text-gray-400'} hover:text-emerald-700`}>
                        {v.is_active ? <FiToggleRight size={16}/> : <FiToggleLeft size={16}/>}
                      </button>
                      <button onClick={() => openEdit(v)} className="p-1 text-gray-400 hover:text-blue-600"><FiEdit2 size={14}/></button>
                      {canDelete('hr') && <button onClick={() => remove(v)} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14}/></button>}
                    </div>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr><td colSpan="4" className="text-center py-8 text-gray-400">
                {videos.length === 0 ? 'No videos yet — add the first one' : 'No videos match this filter'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* CREATE / EDIT VIDEO MODAL */}
      <Modal isOpen={modal === 'form'} onClose={() => setModal(false)} title={editing ? 'Edit Video' : 'Add Training Video'} wide>
        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Title *</label>
              <input className="input" required value={form.title || ''} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g. SEPL Site Safety Walkthrough" />
            </div>
            <div>
              <label className="label">Training Type *</label>
              <select className="select" required value={form.training_type || 'sop'} onChange={e => setForm({ ...form, training_type: e.target.value })}>
                {TYPES.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="label">Video URL *</label>
            <input className="input" required value={form.video_url || ''} onChange={e => setForm({ ...form, video_url: e.target.value })}
              placeholder="https://youtube.com/watch?v=... or direct MP4 URL" />
          </div>
          <div>
            <label className="label">Description</label>
            <textarea className="input" rows="2" value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="What this video covers · who it's for · key learnings" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="label">Duration (min)</label>
              <input className="input" type="number" value={form.duration_minutes || ''} onChange={e => setForm({ ...form, duration_minutes: e.target.value })} placeholder="15" />
            </div>
            <div>
              <label className="label">Target Department(s)</label>
              <input className="input" value={form.target_dept || ''} onChange={e => setForm({ ...form, target_dept: e.target.value })} placeholder="csv: Engineering, Sales" />
            </div>
            <div>
              <label className="label">Target Role(s)</label>
              <input className="input" value={form.target_role || ''} onChange={e => setForm({ ...form, target_role: e.target.value })} placeholder="csv: Manager, Engineer" />
            </div>
          </div>
          <label className="flex items-center gap-2 text-[12px]">
            <input type="checkbox" checked={!!form.is_mandatory} onChange={e => setForm({ ...form, is_mandatory: e.target.checked })} />
            <span>Mandatory <span className="text-gray-500">(shown at top of employee's list with red badge)</span></span>
          </label>
          {editing && (
            <label className="flex items-center gap-2 text-[12px]">
              <input type="checkbox" checked={!!form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} />
              <span>Active (assignable + shown to employees)</span>
            </label>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Add Video'}</button>
          </div>
        </form>
      </Modal>

      {/* ASSIGN MODAL */}
      <Modal isOpen={modal === 'assign'} onClose={() => setModal(false)} title={`Assign "${assignTarget?.title || ''}" to Employees`} wide>
        <div className="space-y-3 max-h-[70vh] overflow-y-auto">
          <p className="text-[11px] text-blue-700 bg-blue-50 border border-blue-100 rounded px-3 py-2">
            Pick the employees who need to complete this training. Already-assigned employees will be skipped.
          </p>
          <div className="border border-gray-200 rounded-lg">
            {employees.map(e => (
              <label key={e.id} className="flex items-center gap-3 px-3 py-2 border-b last:border-b-0 hover:bg-gray-50 cursor-pointer">
                <input type="checkbox" checked={pickedEmps.includes(e.id)} onChange={() => togglePick(e.id)} />
                <div className="flex-1">
                  <div className="text-[13px] font-medium">{e.name}</div>
                  <div className="text-[11px] text-gray-500">{e.designation || ''}{e.department ? ` · ${e.department}` : ''}</div>
                </div>
              </label>
            ))}
            {employees.length === 0 && <div className="px-3 py-4 text-center text-gray-400">No employees</div>}
          </div>
          <div className="flex justify-between items-center">
            <span className="text-[12px] text-gray-500">{pickedEmps.length} selected</span>
            <div className="flex gap-2">
              <button onClick={() => setPickedEmps(employees.map(e => e.id))} className="btn btn-secondary text-[11px] py-1 px-2">Select All</button>
              <button onClick={() => setPickedEmps([])} className="btn btn-secondary text-[11px] py-1 px-2">Clear</button>
              <button onClick={submitAssign} className="btn btn-primary">Assign to {pickedEmps.length || 0}</button>
            </div>
          </div>
        </div>
      </Modal>

      {/* ASSIGNMENTS LIST MODAL */}
      <Modal isOpen={modal === 'assignmentsList'} onClose={() => setModal(false)} title={`Assignments — ${listTarget?.title || ''}`} wide>
        <div className="space-y-2 max-h-[70vh] overflow-y-auto">
          {assignmentsList.length === 0 ? (
            <p className="text-center py-6 text-gray-400 text-[13px]">No employees assigned yet</p>
          ) : (
            <table className="text-[12px] w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-2 py-1.5 text-[10px] font-semibold text-gray-500 uppercase">Employee</th>
                  <th className="text-left px-2 py-1.5 text-[10px] font-semibold text-gray-500 uppercase">Status</th>
                  <th className="text-left px-2 py-1.5 text-[10px] font-semibold text-gray-500 uppercase">Assigned</th>
                  <th className="text-left px-2 py-1.5 text-[10px] font-semibold text-gray-500 uppercase">Completed</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {assignmentsList.map(a => (
                  <tr key={a.id} className="border-t">
                    <td className="px-2 py-1.5">
                      <div className="font-medium">{a.employee_name || `#${a.employee_id}`}</div>
                      <div className="text-[10px] text-gray-500">{a.employee_department || ''}</div>
                    </td>
                    <td className="px-2 py-1.5">
                      {a.completed_at
                        ? <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">✓ Completed</span>
                        : a.started_at
                          ? <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">In Progress</span>
                          : <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-gray-100 text-gray-700">Not Started</span>}
                    </td>
                    <td className="px-2 py-1.5 text-gray-500">{a.assigned_at?.slice(0, 10)}</td>
                    <td className="px-2 py-1.5 text-gray-500">{a.completed_at?.slice(0, 10) || '—'}</td>
                    <td className="px-2 py-1.5"><button onClick={() => unassign(a)} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={12}/></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Modal>
    </div>
  );
}
