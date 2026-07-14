// HR System — Phase 1 (MVP).
//
// Mam (2026-05-22) shared a 15-module HR-operating-system spec.
// This page is the foundation: 8 tabs covering Dashboard / Hiring
// Requests / Candidates ATS / Interviews / Offers / Onboarding /
// Training / Employees.  Hiring Requests + Candidates + Interviews
// + Offers are fully functional today; the rest are scaffolded for
// the next sprint.
//
// Priority order from mam:
//   1 ATS · 2 Hiring Request · 3 JD · 4 Interview · 5 Screening
//   6 Offer · 7 Onboarding · 8 Training · 9 Employee Profiles · 10 Dashboard

import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import {
  FiPlus, FiUsers, FiBriefcase, FiCalendar, FiFileText, FiCheckCircle,
  FiXCircle, FiClock, FiUpload, FiEye, FiEdit2, FiTrash2, FiAward,
  FiDownload, FiSearch, FiBarChart2, FiVideo, FiUserCheck, FiTrendingUp,
} from 'react-icons/fi';
// Mam (2026-05-30): "Performance is in under HRMS".  Engineer
// Performance was the old "Engineer Compliance" tab on the DPR
// page; moved here so HR has one home for headcount + performance.
import EngineerPerformance from '../components/EngineerPerformance';
import { LuIndianRupee } from 'react-icons/lu';
import { fmtIST, fmtDateIST } from '../utils/dateIST';

const STAGES = [
  { key: 'applied',      label: 'Applied',      chip: 'bg-gray-100 text-gray-700' },
  { key: 'screening',    label: 'Screening',    chip: 'bg-blue-100 text-blue-700' },
  { key: 'interview',    label: 'Interview',    chip: 'bg-indigo-100 text-indigo-700' },
  { key: 'final_round',  label: 'Final Round',  chip: 'bg-violet-100 text-violet-700' },
  { key: 'offered',      label: 'Offered',      chip: 'bg-amber-100 text-amber-800' },
  { key: 'selected',     label: 'Selected',     chip: 'bg-emerald-100 text-emerald-700' },
  { key: 'joined',       label: 'Joined',       chip: 'bg-emerald-200 text-emerald-900' },
  { key: 'on_hold',      label: 'On Hold',      chip: 'bg-yellow-100 text-yellow-800' },
  { key: 'rejected',     label: 'Rejected',     chip: 'bg-rose-100 text-rose-700' },
];
const STAGE_BY_KEY = Object.fromEntries(STAGES.map(s => [s.key, s]));

const HR_REQ_STATUS = {
  pending:  'bg-amber-100 text-amber-800',
  approved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-rose-100 text-rose-700',
  closed:   'bg-gray-200 text-gray-700',
};

const TABS = [
  { id: 'dashboard',   label: 'Dashboard',         icon: FiBarChart2 },
  { id: 'performance', label: 'Performance',       icon: FiTrendingUp },
  { id: 'hiring',      label: 'Hiring Requests',   icon: FiBriefcase },
  { id: 'candidates',  label: 'Candidates (ATS)',  icon: FiUsers },
  { id: 'interviews',  label: 'Interviews',        icon: FiCalendar },
  { id: 'offers',      label: 'Offers',            icon: FiFileText },
  { id: 'onboarding',  label: 'Onboarding',        icon: FiCheckCircle },
  { id: 'training',    label: 'Training',          icon: FiVideo },
  { id: 'employees',   label: 'Employees',         icon: FiUserCheck },
];

const fmtMoney = (n) => n != null ? `Rs ${(+n || 0).toLocaleString('en-IN')}` : '—';

export default function HRSystem() {
  const { user, isAdmin, canCreate, canEdit, canDelete, canApprove } = useAuth();
  const [tab, setTab] = useUrlTab('dashboard');

  return (
    <div className="space-y-3 p-3 sm:p-4">
      {/* Header */}
      <div className="bg-gradient-to-br from-blue-900 to-blue-950 text-white rounded-xl p-4 shadow-lg">
        <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2"><FiUsers /> HR System</h1>
        <p className="text-blue-200 text-xs sm:text-sm mt-0.5">
          Recruitment → Hiring → Onboarding · Phase 1 MVP
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 flex-wrap">
        {TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`btn ${active ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}
            >
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'dashboard'   && <DashboardTab />}
      {tab === 'performance' && <EngineerPerformance />}
      {tab === 'hiring'      && <HiringRequestsTab user={user} isAdmin={isAdmin} canCreate={canCreate} canEdit={canEdit} canDelete={canDelete} canApprove={canApprove} />}
      {tab === 'candidates' && <CandidatesTab user={user} isAdmin={isAdmin} canCreate={canCreate} canEdit={canEdit} canDelete={canDelete} />}
      {tab === 'interviews' && <InterviewsTab user={user} canCreate={canCreate} canEdit={canEdit} />}
      {tab === 'offers'     && <OffersTab user={user} canCreate={canCreate} canEdit={canEdit} />}
      {tab === 'onboarding' && <StubTab title="Onboarding" message="Document collection, BG verification, joining checklist — wiring in the next sprint." />}
      {tab === 'training'   && <StubTab title="Training (LMS)" message="Video upload + role-based assignments + completion tracking — wiring in the next sprint." />}
      {tab === 'employees'  && <StubTab title="Employee Profiles" message="Already live under the legacy Employees module. Phase 1 deepening (skills, reporting tree, joining date) lands here next sprint." />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════════════
function DashboardTab() {
  const [k, setK] = useState(null);
  useEffect(() => {
    api.get('/hr-system/dashboard').then(r => setK(r.data)).catch(() => {});
  }, []);
  if (!k) return <div className="card p-6 text-center text-gray-400">Loading…</div>;
  const offerRate = k.offers?.total ? Math.round((k.offers.accepted / k.offers.total) * 100) : 0;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <KpiTile label="Open Positions"      value={k.open_positions}      tint="blue" />
        <KpiTile label="Pending Interviews"  value={k.pending_interviews}  tint="indigo" />
        <KpiTile label="Avg Time to Hire"    value={k.avg_time_to_hire_days != null ? k.avg_time_to_hire_days + ' d' : '—'} tint="amber" />
        <KpiTile label="Offer Accept Rate"   value={k.offers?.total ? offerRate + '%' : '—'} tint="emerald" />
      </div>

      <div className="card p-3">
        <div className="text-sm font-semibold text-gray-800 mb-2">Candidates in Pipeline</div>
        <div className="flex flex-wrap gap-2">
          {STAGES.filter(s => !['rejected','joined'].includes(s.key)).map(s => {
            const row = (k.pipeline_by_status || []).find(p => p.status === s.key);
            return (
              <div key={s.key} className={`px-3 py-1.5 rounded ${s.chip} text-xs flex items-center gap-1.5`}>
                <span className="font-semibold">{row?.c || 0}</span>
                <span>{s.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card p-3">
        <div className="text-sm font-semibold text-gray-800 mb-2">Offers</div>
        <div className="grid grid-cols-4 gap-2 text-xs">
          <div className="bg-amber-50 border border-amber-200 rounded p-2"><div className="text-gray-500">Pending</div><div className="text-lg font-bold text-amber-700">{k.offers?.pending || 0}</div></div>
          <div className="bg-emerald-50 border border-emerald-200 rounded p-2"><div className="text-gray-500">Accepted</div><div className="text-lg font-bold text-emerald-700">{k.offers?.accepted || 0}</div></div>
          <div className="bg-rose-50 border border-rose-200 rounded p-2"><div className="text-gray-500">Declined</div><div className="text-lg font-bold text-rose-700">{k.offers?.declined || 0}</div></div>
          <div className="bg-gray-50 border border-gray-200 rounded p-2"><div className="text-gray-500">Total</div><div className="text-lg font-bold text-gray-700">{k.offers?.total || 0}</div></div>
        </div>
      </div>
    </div>
  );
}
function KpiTile({ label, value, tint }) {
  const t = {
    blue:    'border-l-blue-500 text-blue-700',
    indigo:  'border-l-indigo-500 text-indigo-700',
    amber:   'border-l-amber-500 text-amber-700',
    emerald: 'border-l-emerald-500 text-emerald-700',
  }[tint];
  return (
    <div className={`card p-3 border-l-4 ${t.split(' ')[0]}`}>
      <div className="text-[10px] uppercase text-gray-500">{label}</div>
      <div className={`text-2xl font-bold ${t.split(' ')[1]}`}>{value}</div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// HIRING REQUESTS
// ════════════════════════════════════════════════════════════════
function HiringRequestsTab({ user, isAdmin, canCreate, canEdit, canDelete, canApprove }) {
  const [rows, setRows] = useState([]);
  const [modal, setModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({});
  const load = useCallback(() => {
    api.get('/hr-system/hiring-requests').then(r => setRows(r.data)).catch(e => toast.error(e.response?.data?.error || 'Failed'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setEditingId(null);
    setForm({ position_title: '', department: '', openings: 1, employment_type: 'Full-time' });
    setModal(true);
  };
  const openEdit = (r) => {
    setEditingId(r.id);
    setForm({ ...r });
    setModal(true);
  };
  const save = async (e) => {
    e.preventDefault();
    if (!form.position_title?.trim()) return toast.error('Position title required');
    try {
      if (editingId) await api.put(`/hr-system/hiring-requests/${editingId}`, form);
      else           await api.post('/hr-system/hiring-requests', form);
      toast.success(editingId ? 'Updated' : 'Hiring request raised');
      setModal(false); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const approve = async (r) => {
    if (!window.confirm(`Approve ${r.request_no}?`)) return;
    try { await api.post(`/hr-system/hiring-requests/${r.id}/approve`); toast.success('Approved'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const reject = async (r) => {
    const reason = window.prompt(`Reject ${r.request_no}. Reason?`);
    if (!reason) return;
    try { await api.post(`/hr-system/hiring-requests/${r.id}/reject`, { reason }); toast.success('Rejected'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const del = async (r) => {
    if (!window.confirm(`Delete ${r.request_no}?`)) return;
    try { await api.delete(`/hr-system/hiring-requests/${r.id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div className="text-sm text-gray-600">{rows.length} hiring request{rows.length === 1 ? '' : 's'}</div>
        {canCreate('hr_system') && (
          <button onClick={openCreate} className="btn btn-primary flex items-center gap-1.5"><FiPlus size={14} /> Raise Hiring Request</button>
        )}
      </div>

      <div className="card p-0 overflow-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 text-gray-600 uppercase text-[10px]">
            <tr>
              <th className="px-2 py-2 text-left">Req #</th>
              <th className="px-2 py-2 text-left">Position</th>
              <th className="px-2 py-2 text-left">Dept</th>
              <th className="px-2 py-2 text-right">Openings</th>
              <th className="px-2 py-2 text-right">Salary Range</th>
              <th className="px-2 py-2 text-left">Deadline</th>
              <th className="px-2 py-2 text-left">Status</th>
              <th className="px-2 py-2 text-left">Raised By</th>
              <th className="px-2 py-2 text-right">Candidates</th>
              <th className="px-2 py-2 text-center">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan="10" className="text-center text-gray-400 py-8">No hiring requests yet</td></tr>}
            {rows.map(r => (
              <tr key={r.id} className="border-t hover:bg-blue-50/30">
                <td className="px-2 py-2 font-mono text-red-700 whitespace-nowrap">{r.request_no}</td>
                <td className="px-2 py-2 font-semibold">{r.position_title}</td>
                <td className="px-2 py-2">{r.department || '—'}</td>
                <td className="px-2 py-2 text-right tabular-nums">{r.openings}</td>
                <td className="px-2 py-2 text-right tabular-nums text-[10px]">
                  {r.salary_min || r.salary_max ? `${fmtMoney(r.salary_min)} – ${fmtMoney(r.salary_max)}` : '—'}
                </td>
                <td className="px-2 py-2 text-[10px]">{fmtDateIST(r.hiring_deadline)}</td>
                <td className="px-2 py-2">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${HR_REQ_STATUS[r.status] || ''}`}>{r.status}</span>
                </td>
                <td className="px-2 py-2 text-[10px]">{r.raised_by_name || '—'}</td>
                <td className="px-2 py-2 text-right tabular-nums">{r.candidate_count || 0}</td>
                <td className="px-2 py-2">
                  <div className="flex gap-1 justify-center">
                    {r.status === 'pending' && (canApprove('hr_system') || isAdmin()) && r.raised_by !== user?.id && (
                      <>
                        <button onClick={() => approve(r)} className="text-[10px] text-emerald-700 font-bold hover:underline">Approve</button>
                        <button onClick={() => reject(r)} className="text-[10px] text-red-600 font-bold hover:underline">Reject</button>
                      </>
                    )}
                    {r.status === 'pending' && r.raised_by === user?.id && (
                      <span className="text-[10px] text-gray-500 italic">Awaiting approval</span>
                    )}
                    {(canEdit('hr_system') || isAdmin()) && (
                      <button onClick={() => openEdit(r)} className="p-1 text-gray-400 hover:text-blue-700" title="Edit"><FiEdit2 size={12} /></button>
                    )}
                    {canDelete('hr_system') && (
                      <button onClick={() => del(r)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={12} /></button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={modal} onClose={() => setModal(false)} title={editingId ? 'Edit Hiring Request' : 'Raise Hiring Request'} wide>
        <form onSubmit={save} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <F label="Position Title *"><input className="input" required value={form.position_title || ''} onChange={e => setForm({ ...form, position_title: e.target.value })} /></F>
          <F label="Department"><input className="input" value={form.department || ''} onChange={e => setForm({ ...form, department: e.target.value })} /></F>
          <F label="Openings"><input className="input" type="number" min="1" value={form.openings || 1} onChange={e => setForm({ ...form, openings: +e.target.value })} /></F>
          <F label="Employment Type">
            <select className="input" value={form.employment_type || 'Full-time'} onChange={e => setForm({ ...form, employment_type: e.target.value })}>
              <option>Full-time</option><option>Part-time</option><option>Contract</option><option>Internship</option>
            </select>
          </F>
          <F label="Salary Min (Rs)"><input className="input" type="number" value={form.salary_min ?? ''} onChange={e => setForm({ ...form, salary_min: e.target.value })} /></F>
          <F label="Salary Max (Rs)"><input className="input" type="number" value={form.salary_max ?? ''} onChange={e => setForm({ ...form, salary_max: e.target.value })} /></F>
          <F label="Experience Required"><input className="input" placeholder="e.g. 3-5 years" value={form.experience_required || ''} onChange={e => setForm({ ...form, experience_required: e.target.value })} /></F>
          <F label="Hiring Deadline"><input className="input" type="date" value={form.hiring_deadline || ''} onChange={e => setForm({ ...form, hiring_deadline: e.target.value })} /></F>
          <F label="Reporting Manager"><input className="input" value={form.reporting_manager || ''} onChange={e => setForm({ ...form, reporting_manager: e.target.value })} /></F>
          <div className="sm:col-span-2"><F label="Notes"><textarea className="input" rows="2" value={form.notes || ''} onChange={e => setForm({ ...form, notes: e.target.value })} /></F></div>
          <div className="sm:col-span-2 flex justify-end gap-2 border-t pt-3">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{editingId ? 'Save' : 'Raise Request'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// CANDIDATES (ATS)
// ════════════════════════════════════════════════════════════════
function CandidatesTab({ user, isAdmin, canCreate, canEdit, canDelete }) {
  const [rows, setRows] = useState([]);
  const [hiringReqs, setHiringReqs] = useState([]);
  const [filters, setFilters] = useState({ status: '', search: '' });
  const [modal, setModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({});
  const [moveModal, setMoveModal] = useState(null);
  const [moveStatus, setMoveStatus] = useState('');
  const [moveNote, setMoveNote] = useState('');
  const [view, setView] = useState(null);

  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (filters.status) p.set('status', filters.status);
    if (filters.search) p.set('search', filters.search);
    api.get(`/hr-system/candidates?${p}`).then(r => setRows(r.data)).catch(e => toast.error(e.response?.data?.error || 'Failed'));
  }, [filters]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/hr-system/hiring-requests').then(r => setHiringReqs(r.data)).catch(() => {}); }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm({ full_name: '', email: '', phone: '', source: '', status: 'applied' });
    setModal(true);
  };
  const openEdit = (r) => { setEditingId(r.id); setForm({ ...r }); setModal(true); };
  const save = async (e) => {
    e.preventDefault();
    if (!form.full_name?.trim()) return toast.error('Name required');
    try {
      if (editingId) await api.put(`/hr-system/candidates/${editingId}`, form);
      else           await api.post('/hr-system/candidates', form);
      toast.success(editingId ? 'Updated' : 'Candidate added');
      setModal(false); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const moveStage = async () => {
    if (!moveModal || !moveStatus) return;
    try {
      await api.post(`/hr-system/candidates/${moveModal.id}/status`, { status: moveStatus, note: moveNote });
      toast.success(`Moved to ${moveStatus}`);
      setMoveModal(null); setMoveStatus(''); setMoveNote(''); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const openView = async (r) => {
    try { const { data } = await api.get(`/hr-system/candidates/${r.id}`); setView(data); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const uploadResume = async (id, file) => {
    if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    try {
      await api.post(`/hr-system/candidates/${id}/resume`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success('Resume uploaded'); load();
      if (view?.id === id) openView({ id });
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const del = async (r) => {
    if (!window.confirm(`Delete candidate ${r.candidate_no}?`)) return;
    try { await api.delete(`/hr-system/candidates/${r.id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="space-y-3">
      {/* Stage chips */}
      <div className="flex flex-wrap gap-1.5">
        <button onClick={() => setFilters(f => ({ ...f, status: '' }))} className={`btn text-xs ${filters.status === '' ? 'btn-primary' : 'btn-secondary'}`}>
          All ({rows.length})
        </button>
        {STAGES.map(s => (
          <button key={s.key} onClick={() => setFilters(f => ({ ...f, status: s.key }))}
            className={`btn text-xs ${filters.status === s.key ? 'btn-primary' : 'btn-secondary'}`}>
            {s.label}
          </button>
        ))}
      </div>

      <div className="flex gap-2 items-center flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <FiSearch className="absolute left-3 top-2.5 text-gray-400" size={14} />
          <input className="input pl-9" placeholder="Search by name / email / phone / candidate no…" value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} />
        </div>
        {canCreate('hr_system') && (
          <button onClick={openCreate} className="btn btn-primary flex items-center gap-1.5"><FiPlus size={14} /> Add Candidate</button>
        )}
      </div>

      <div className="card p-0 overflow-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 text-gray-600 uppercase text-[10px]">
            <tr>
              <th className="px-2 py-2 text-left">Cand #</th>
              <th className="px-2 py-2 text-left">Name</th>
              <th className="px-2 py-2 text-left">Contact</th>
              <th className="px-2 py-2 text-left">For Position</th>
              <th className="px-2 py-2 text-left">Experience</th>
              <th className="px-2 py-2 text-right">Expected ₹</th>
              <th className="px-2 py-2 text-left">Source</th>
              <th className="px-2 py-2 text-left">Stage</th>
              <th className="px-2 py-2 text-center">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan="9" className="text-center text-gray-400 py-8">No candidates</td></tr>}
            {rows.map(c => {
              const stage = STAGE_BY_KEY[c.status];
              return (
                <tr key={c.id} className="border-t hover:bg-blue-50/30">
                  <td className="px-2 py-2 font-mono text-red-700 whitespace-nowrap">{c.candidate_no}</td>
                  <td className="px-2 py-2">
                    <div className="font-semibold">{c.full_name}</div>
                    <div className="text-[10px] text-gray-500">{c.current_role || ''} {c.current_company ? `@ ${c.current_company}` : ''}</div>
                  </td>
                  <td className="px-2 py-2 text-[10px]">
                    {c.email && <div>{c.email}</div>}
                    {c.phone && <div className="text-gray-500">{c.phone}</div>}
                  </td>
                  <td className="px-2 py-2 text-[10px]">{c.hr_position ? `${c.hr_request_no} · ${c.hr_position}` : <span className="text-gray-300">—</span>}</td>
                  <td className="px-2 py-2 text-[10px]">{c.experience_years != null ? `${c.experience_years} yr` : '—'}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-[10px]">{fmtMoney(c.expected_salary)}</td>
                  <td className="px-2 py-2 text-[10px]">{c.source || '—'}</td>
                  <td className="px-2 py-2">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${stage?.chip || ''}`}>{stage?.label || c.status}</span>
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex gap-1 justify-center">
                      <button onClick={() => openView(c)} className="p-1 text-gray-400 hover:text-blue-700" title="View"><FiEye size={12} /></button>
                      {(canEdit('hr_system') || isAdmin()) && (
                        <>
                          <button onClick={() => { setMoveModal(c); setMoveStatus(c.status); }} className="p-1 text-gray-400 hover:text-emerald-700" title="Move stage"><FiUserCheck size={12} /></button>
                          <button onClick={() => openEdit(c)} className="p-1 text-gray-400 hover:text-blue-700" title="Edit"><FiEdit2 size={12} /></button>
                        </>
                      )}
                      {canDelete('hr_system') && (
                        <button onClick={() => del(c)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={12} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Add / Edit Candidate */}
      <Modal isOpen={modal} onClose={() => setModal(false)} title={editingId ? 'Edit Candidate' : 'Add Candidate'} wide>
        <form onSubmit={save} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <F label="Full Name *"><input className="input" required value={form.full_name || ''} onChange={e => setForm({ ...form, full_name: e.target.value })} /></F>
          <F label="Email"><input className="input" type="email" value={form.email || ''} onChange={e => setForm({ ...form, email: e.target.value })} /></F>
          <F label="Phone"><input className="input" value={form.phone || ''} onChange={e => setForm({ ...form, phone: e.target.value })} maxLength={15} /></F>
          <F label="For Hiring Request">
            <select className="input" value={form.hiring_request_id || ''} onChange={e => setForm({ ...form, hiring_request_id: e.target.value ? +e.target.value : null })}>
              <option value="">— None —</option>
              {hiringReqs.filter(h => h.status === 'approved' || h.status === 'pending').map(h => (
                <option key={h.id} value={h.id}>{h.request_no} · {h.position_title}</option>
              ))}
            </select>
          </F>
          <F label="Current Company"><input className="input" value={form.current_company || ''} onChange={e => setForm({ ...form, current_company: e.target.value })} /></F>
          <F label="Current Role"><input className="input" value={form.current_role || ''} onChange={e => setForm({ ...form, current_role: e.target.value })} /></F>
          <F label="Experience (years)"><input className="input" type="number" step="0.5" value={form.experience_years ?? ''} onChange={e => setForm({ ...form, experience_years: e.target.value })} /></F>
          <F label="Notice Period"><input className="input" placeholder="e.g. 30 days" value={form.notice_period || ''} onChange={e => setForm({ ...form, notice_period: e.target.value })} /></F>
          <F label="Current Salary"><input className="input" type="number" value={form.current_salary ?? ''} onChange={e => setForm({ ...form, current_salary: e.target.value })} /></F>
          <F label="Expected Salary"><input className="input" type="number" value={form.expected_salary ?? ''} onChange={e => setForm({ ...form, expected_salary: e.target.value })} /></F>
          <F label="Location"><input className="input" value={form.location || ''} onChange={e => setForm({ ...form, location: e.target.value })} /></F>
          <F label="Source">
            <select className="input" value={form.source || ''} onChange={e => setForm({ ...form, source: e.target.value })}>
              <option value="">—</option>
              <option>LinkedIn</option><option>Naukri</option><option>Indeed</option>
              <option>Referral</option><option>Walk-in</option><option>Consultant</option><option>Other</option>
            </select>
          </F>
          <div className="sm:col-span-2"><F label="Tags (comma-separated)"><input className="input" value={form.tags || ''} onChange={e => setForm({ ...form, tags: e.target.value })} placeholder="e.g. urgent, fresher, top-3" /></F></div>
          <div className="sm:col-span-2"><F label="Notes"><textarea className="input" rows="2" value={form.notes || ''} onChange={e => setForm({ ...form, notes: e.target.value })} /></F></div>
          <div className="sm:col-span-2 flex justify-end gap-2 border-t pt-3">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{editingId ? 'Save' : 'Add Candidate'}</button>
          </div>
        </form>
      </Modal>

      {/* Move-stage modal */}
      <Modal isOpen={!!moveModal} onClose={() => setMoveModal(null)} title={moveModal ? `Move stage — ${moveModal.full_name}` : 'Move stage'}>
        {moveModal && (
          <div className="space-y-3">
            <div className="text-xs text-gray-600">Current: <span className={`px-2 py-0.5 rounded ${STAGE_BY_KEY[moveModal.status]?.chip || ''}`}>{STAGE_BY_KEY[moveModal.status]?.label || moveModal.status}</span></div>
            <F label="Move to">
              <select className="input" value={moveStatus} onChange={e => setMoveStatus(e.target.value)}>
                {STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </F>
            <F label="Reason / note (optional)"><textarea className="input" rows="2" value={moveNote} onChange={e => setMoveNote(e.target.value)} /></F>
            <div className="flex justify-end gap-2">
              <button onClick={() => setMoveModal(null)} className="btn btn-secondary">Cancel</button>
              <button onClick={moveStage} className="btn btn-primary">Move</button>
            </div>
          </div>
        )}
      </Modal>

      {/* View / detail */}
      <Modal isOpen={!!view} onClose={() => setView(null)} title={view ? `${view.candidate_no} · ${view.full_name}` : 'Candidate'} wide>
        {view && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
              <Info k="Email" v={view.email} /><Info k="Phone" v={view.phone} /><Info k="Location" v={view.location} />
              <Info k="Current Company" v={view.current_company} /><Info k="Current Role" v={view.current_role} /><Info k="Experience" v={view.experience_years != null ? `${view.experience_years} yr` : null} />
              <Info k="Current Salary" v={view.current_salary != null ? fmtMoney(view.current_salary) : null} />
              <Info k="Expected Salary" v={view.expected_salary != null ? fmtMoney(view.expected_salary) : null} />
              <Info k="Notice Period" v={view.notice_period} />
              <Info k="Source" v={view.source} /><Info k="Tags" v={view.tags} />
              <Info k="For Position" v={view.hr_position ? `${view.hr_request_no} · ${view.hr_position}` : null} />
            </div>
            {view.notes && <div className="bg-amber-50 border border-amber-200 rounded p-2 text-xs"><b>Notes:</b> {view.notes}</div>}
            <div>
              <div className="text-xs font-semibold text-gray-700 mb-1">Resume</div>
              {view.resume_url
                ? <a href={view.resume_url} target="_blank" rel="noreferrer" className="text-xs text-blue-700 hover:underline">View resume</a>
                : <input type="file" accept=".pdf,.doc,.docx" className="text-xs" onChange={e => uploadResume(view.id, e.target.files?.[0])} />}
            </div>
            <div>
              <div className="text-xs font-semibold text-gray-700 mb-1">Timeline</div>
              <div className="space-y-1 max-h-48 overflow-y-auto border rounded p-2 bg-gray-50">
                {(view.activity || []).length === 0 && <div className="text-[11px] text-gray-400">No activity yet.</div>}
                {(view.activity || []).map(a => (
                  <div key={a.id} className="text-[11px] text-gray-700 border-b last:border-0 pb-1">
                    <span className="text-gray-400 font-mono">{fmtIST(a.created_at)}</span>
                    <span className="ml-1 font-semibold">{a.activity_type}</span>
                    {a.from_status && a.to_status && <span> · {a.from_status} → {a.to_status}</span>}
                    {a.note && <span className="text-gray-600"> · {a.note}</span>}
                    {a.by_user_name && <span className="text-gray-400"> · by {a.by_user_name}</span>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// INTERVIEWS
// ════════════════════════════════════════════════════════════════
function InterviewsTab({ user, canCreate, canEdit }) {
  const [rows, setRows] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({});
  const [feedbackModal, setFeedbackModal] = useState(null);
  const [feedback, setFeedback] = useState({});
  const load = useCallback(() => {
    api.get('/hr-system/interviews').then(r => setRows(r.data)).catch(e => toast.error(e.response?.data?.error || 'Failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/hr-system/candidates').then(r => setCandidates(r.data)).catch(() => {}); }, []);

  const save = async (e) => {
    e.preventDefault();
    if (!form.candidate_id || !form.scheduled_at) return toast.error('Candidate + date/time required');
    try {
      await api.post('/hr-system/interviews', form);
      toast.success('Interview scheduled');
      setModal(false); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const saveFeedback = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/hr-system/interviews/${feedbackModal.id}/feedback`, feedback);
      toast.success('Feedback submitted');
      setFeedbackModal(null); setFeedback({}); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div className="text-sm text-gray-600">{rows.length} interview{rows.length === 1 ? '' : 's'}</div>
        {canCreate('hr_system') && (
          <button onClick={() => { setForm({ scheduled_at: '', round_name: 'Screening', mode: 'Video', duration_min: 60 }); setModal(true); }} className="btn btn-primary flex items-center gap-1.5"><FiPlus size={14} /> Schedule Interview</button>
        )}
      </div>

      <div className="card p-0 overflow-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 text-gray-600 uppercase text-[10px]">
            <tr>
              <th className="px-2 py-2 text-left">When</th>
              <th className="px-2 py-2 text-left">Candidate</th>
              <th className="px-2 py-2 text-left">Round</th>
              <th className="px-2 py-2 text-left">Mode</th>
              <th className="px-2 py-2 text-left">Location / Link</th>
              <th className="px-2 py-2 text-left">Interviewer(s)</th>
              <th className="px-2 py-2 text-left">Status</th>
              <th className="px-2 py-2 text-center">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan="8" className="text-center text-gray-400 py-8">No interviews scheduled</td></tr>}
            {rows.map(i => (
              <tr key={i.id} className="border-t hover:bg-blue-50/30">
                <td className="px-2 py-2 text-[11px]">{fmtIST(i.scheduled_at)}</td>
                <td className="px-2 py-2 text-[11px]">
                  <div className="font-semibold">{i.candidate_name}</div>
                  <div className="text-[10px] text-gray-500 font-mono">{i.candidate_no}</div>
                </td>
                <td className="px-2 py-2">{i.round_name || '—'}</td>
                <td className="px-2 py-2 text-[11px]">{i.mode || '—'}</td>
                <td className="px-2 py-2 text-[11px] max-w-[200px] truncate" title={i.location_or_link}>
                  {i.location_or_link?.startsWith('http') ? <a href={i.location_or_link} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">Join link</a> : i.location_or_link || '—'}
                </td>
                <td className="px-2 py-2 text-[11px]">{i.interviewer_names || '—'}</td>
                <td className="px-2 py-2">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${i.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : i.status === 'scheduled' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-700'}`}>{i.status}</span>
                  {i.outcome && <div className="text-[10px] text-gray-500 mt-0.5">{i.outcome}</div>}
                </td>
                <td className="px-2 py-2 text-center">
                  {i.status === 'scheduled' && canEdit('hr_system') && (
                    <button onClick={() => { setFeedbackModal(i); setFeedback({}); }} className="btn btn-primary text-[10px] px-2 py-1">Feedback</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Schedule modal */}
      <Modal isOpen={modal} onClose={() => setModal(false)} title="Schedule Interview" wide>
        <form onSubmit={save} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <F label="Candidate *">
            <select className="input" required value={form.candidate_id || ''} onChange={e => setForm({ ...form, candidate_id: +e.target.value })}>
              <option value="">— Pick —</option>
              {candidates.map(c => <option key={c.id} value={c.id}>{c.candidate_no} · {c.full_name}</option>)}
            </select>
          </F>
          <F label="Round Name">
            <select className="input" value={form.round_name || 'Screening'} onChange={e => setForm({ ...form, round_name: e.target.value })}>
              <option>Screening</option><option>Technical</option><option>HR</option><option>Final</option><option>Culture Fit</option>
            </select>
          </F>
          <F label="Date / Time *"><input className="input" required type="datetime-local" value={form.scheduled_at || ''} onChange={e => setForm({ ...form, scheduled_at: e.target.value })} /></F>
          <F label="Duration (min)"><input className="input" type="number" value={form.duration_min || 60} onChange={e => setForm({ ...form, duration_min: +e.target.value })} /></F>
          <F label="Mode">
            <select className="input" value={form.mode || 'Video'} onChange={e => setForm({ ...form, mode: e.target.value })}>
              <option>Video</option><option>In-person</option><option>Phone</option>
            </select>
          </F>
          <F label="Location / Meet Link"><input className="input" value={form.location_or_link || ''} onChange={e => setForm({ ...form, location_or_link: e.target.value })} placeholder="https://meet.google.com/... or office address" /></F>
          <F label="Interviewers (names)"><input className="input" value={form.interviewer_names || ''} onChange={e => setForm({ ...form, interviewer_names: e.target.value })} placeholder="Comma-separated" /></F>
          <div className="sm:col-span-2"><F label="Notes"><textarea className="input" rows="2" value={form.notes || ''} onChange={e => setForm({ ...form, notes: e.target.value })} /></F></div>
          <div className="sm:col-span-2 flex justify-end gap-2 border-t pt-3">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Schedule</button>
          </div>
        </form>
      </Modal>

      {/* Feedback modal */}
      <Modal isOpen={!!feedbackModal} onClose={() => setFeedbackModal(null)} title="Interview Feedback" wide>
        {feedbackModal && (
          <form onSubmit={saveFeedback} className="space-y-3">
            <div className="bg-blue-50 border border-blue-200 rounded p-2 text-xs">
              <b>{feedbackModal.candidate_name}</b> · {feedbackModal.round_name} · {fmtIST(feedbackModal.scheduled_at)}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <ScoreInput label="Technical" v={feedback.technical_score} onChange={v => setFeedback({ ...feedback, technical_score: v })} />
              <ScoreInput label="Communication" v={feedback.communication_score} onChange={v => setFeedback({ ...feedback, communication_score: v })} />
              <ScoreInput label="Culture Fit" v={feedback.culture_score} onChange={v => setFeedback({ ...feedback, culture_score: v })} />
              <ScoreInput label="Problem Solving" v={feedback.problem_solving_score} onChange={v => setFeedback({ ...feedback, problem_solving_score: v })} />
            </div>
            <F label="Overall Rating (1-5)">
              <input className="input" type="number" min="1" max="5" value={feedback.overall_rating ?? ''} onChange={e => setFeedback({ ...feedback, overall_rating: +e.target.value })} />
            </F>
            <F label="Recommendation">
              <select className="input" value={feedback.recommendation || ''} onChange={e => setFeedback({ ...feedback, recommendation: e.target.value })}>
                <option value="">—</option>
                <option>Strong Yes</option><option>Yes</option><option>Maybe</option><option>No</option><option>Strong No</option>
              </select>
            </F>
            <F label="Notes"><textarea className="input" rows="3" value={feedback.feedback_notes || ''} onChange={e => setFeedback({ ...feedback, feedback_notes: e.target.value })} /></F>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setFeedbackModal(null)} className="btn btn-secondary">Cancel</button>
              <button type="submit" className="btn btn-primary">Submit Feedback</button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
function ScoreInput({ label, v, onChange }) {
  return (
    <div>
      <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">{label}</label>
      <select className="input" value={v ?? ''} onChange={e => onChange(+e.target.value)}>
        <option value="">—</option>
        {[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}
      </select>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// OFFERS
// ════════════════════════════════════════════════════════════════
function OffersTab({ user, canCreate, canEdit }) {
  const [rows, setRows] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({});
  const load = useCallback(() => {
    api.get('/hr-system/offers').then(r => setRows(r.data)).catch(e => toast.error(e.response?.data?.error || 'Failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/hr-system/candidates').then(r => setCandidates(r.data)).catch(() => {}); }, []);

  const create = async (e) => {
    e.preventDefault();
    if (!form.candidate_id) return toast.error('Pick a candidate');
    try {
      await api.post('/hr-system/offers', form);
      toast.success('Offer drafted'); setModal(false); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const sendOffer = async (o) => {
    if (!window.confirm(`Send this offer to ${o.candidate_name}?`)) return;
    try { await api.post(`/hr-system/offers/${o.id}/send`); toast.success('Marked as sent'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const copyLink = (o) => {
    const url = `${window.location.origin}/offer/${o.accept_token}`;
    navigator.clipboard.writeText(url);
    toast.success('Accept link copied — paste into email / WhatsApp');
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div className="text-sm text-gray-600">{rows.length} offer{rows.length === 1 ? '' : 's'}</div>
        {canCreate('hr_system') && (
          <button onClick={() => { setForm({ candidate_id: '', offered_position: '', offered_salary: '' }); setModal(true); }} className="btn btn-primary flex items-center gap-1.5"><FiPlus size={14} /> Draft Offer</button>
        )}
      </div>

      <div className="card p-0 overflow-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 text-gray-600 uppercase text-[10px]">
            <tr>
              <th className="px-2 py-2 text-left">Candidate</th>
              <th className="px-2 py-2 text-left">Position</th>
              <th className="px-2 py-2 text-right">Salary</th>
              <th className="px-2 py-2 text-left">Joining</th>
              <th className="px-2 py-2 text-left">Status</th>
              <th className="px-2 py-2 text-left">Sent</th>
              <th className="px-2 py-2 text-center">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan="7" className="text-center text-gray-400 py-8">No offers</td></tr>}
            {rows.map(o => (
              <tr key={o.id} className="border-t hover:bg-blue-50/30">
                <td className="px-2 py-2">
                  <div className="font-semibold">{o.candidate_name}</div>
                  <div className="text-[10px] text-gray-500 font-mono">{o.candidate_no}</div>
                </td>
                <td className="px-2 py-2">{o.offered_position || '—'}</td>
                <td className="px-2 py-2 text-right tabular-nums">{fmtMoney(o.offered_salary)}</td>
                <td className="px-2 py-2 text-[11px]">{fmtDateIST(o.joining_date)}</td>
                <td className="px-2 py-2">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                    o.status === 'accepted' ? 'bg-emerald-100 text-emerald-700' :
                    o.status === 'sent'     ? 'bg-blue-100 text-blue-700' :
                    o.status === 'declined' ? 'bg-rose-100 text-rose-700' :
                    o.status === 'draft'    ? 'bg-gray-100 text-gray-700' :
                                              'bg-amber-100 text-amber-700'
                  }`}>{o.status}</span>
                </td>
                <td className="px-2 py-2 text-[10px]">{fmtIST(o.sent_at)}</td>
                <td className="px-2 py-2 text-center">
                  <div className="flex gap-1 justify-center">
                    {o.status === 'draft' && canEdit('hr_system') && (
                      <button onClick={() => sendOffer(o)} className="btn btn-success text-[10px] px-2 py-1">Send</button>
                    )}
                    {o.status === 'sent' && (
                      <button onClick={() => copyLink(o)} className="btn btn-secondary text-[10px] px-2 py-1">Copy Accept Link</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={modal} onClose={() => setModal(false)} title="Draft Offer" wide>
        <form onSubmit={create} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <F label="Candidate *">
            <select className="input" required value={form.candidate_id || ''} onChange={e => setForm({ ...form, candidate_id: +e.target.value })}>
              <option value="">—</option>
              {candidates.filter(c => ['selected','final_round','interview'].includes(c.status)).map(c => (
                <option key={c.id} value={c.id}>{c.candidate_no} · {c.full_name}</option>
              ))}
            </select>
          </F>
          <F label="Position"><input className="input" value={form.offered_position || ''} onChange={e => setForm({ ...form, offered_position: e.target.value })} /></F>
          <F label="Offered Salary (Rs/month)"><input className="input" type="number" value={form.offered_salary || ''} onChange={e => setForm({ ...form, offered_salary: e.target.value })} /></F>
          <F label="Joining Date"><input className="input" type="date" value={form.joining_date || ''} onChange={e => setForm({ ...form, joining_date: e.target.value })} /></F>
          <F label="Expiry Date"><input className="input" type="date" value={form.expiry_date || ''} onChange={e => setForm({ ...form, expiry_date: e.target.value })} /></F>
          <F label="Offer Letter URL"><input className="input" value={form.offer_letter_url || ''} onChange={e => setForm({ ...form, offer_letter_url: e.target.value })} placeholder="/uploads/... or external link" /></F>
          <div className="sm:col-span-2"><F label="Notes"><textarea className="input" rows="2" value={form.notes || ''} onChange={e => setForm({ ...form, notes: e.target.value })} /></F></div>
          <div className="sm:col-span-2 flex justify-end gap-2 border-t pt-3">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Draft Offer</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// SHARED MICRO-COMPONENTS
// ════════════════════════════════════════════════════════════════
function F({ label, children }) {
  return (
    <div>
      <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">{label}</label>
      {children}
    </div>
  );
}
function Info({ k, v }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-gray-500">{k}</div>
      <div className="text-sm text-gray-800">{v || '—'}</div>
    </div>
  );
}
function StubTab({ title, message }) {
  return (
    <div className="card p-8 text-center">
      <div className="text-lg font-bold text-gray-700">{title}</div>
      <div className="text-sm text-gray-500 mt-2">{message}</div>
      <div className="text-[11px] text-gray-400 mt-3">Schema + endpoints are already in place — say the word and I'll wire the UI in the next sprint.</div>
    </div>
  );
}
