// Hiring Requests — the requisition side of the ATS funnel.
//
// Mam (2026-05-22 Phase 1 spec): a manager raises a hiring request
// (Department / Position / # openings / Salary range / Experience /
// Employment type / Hiring deadline / Reporting manager) → HR reviews
// and approves or rejects → the request becomes an open position →
// candidates can be tagged back to it from the Candidates tab.
//
// This sits as a TAB inside /hr (not a separate sidebar entry — per
// mam's "duplicated" rule).  Imports cleanly into HR.jsx.

import { useEffect, useState } from 'react';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';
import {
  FiPlus, FiEdit2, FiTrash2, FiCheckCircle, FiXCircle, FiBriefcase,
  FiUsers, FiCalendar, FiLock,
} from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';

const EMPLOYMENT_TYPES = [
  { v: 'full_time',  l: 'Full-time' },
  { v: 'part_time',  l: 'Part-time' },
  { v: 'contract',   l: 'Contract'  },
  { v: 'internship', l: 'Internship'},
  { v: 'freelance',  l: 'Freelance' },
];

const STATUS_PILLS = [
  { id: 'pending',  label: 'Pending',  bg: 'bg-amber-500' },
  { id: 'approved', label: 'Approved', bg: 'bg-emerald-500' },
  { id: 'rejected', label: 'Rejected', bg: 'bg-rose-500' },
  { id: 'closed',   label: 'Closed',   bg: 'bg-gray-500' },
];

export default function HiringRequestsTab({ employees = [] }) {
  const { user, canDelete } = useAuth();
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('all');
  const [modal, setModal] = useState(false);    // false | 'form' | 'approve' | 'reject'
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [actionRow, setActionRow] = useState(null);
  const [reason, setReason] = useState('');

  const load = () =>
    api.get('/hr/hiring-requests')
      .then(r => setRows(r.data || []))
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load hiring requests'));
  useEffect(() => { load(); }, []);

  const fmtDate = (s) => {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  const openCreate = () => {
    setEditing(null);
    setForm({
      department: user?.department || '',
      position_title: '', num_openings: 1,
      salary_min: '', salary_max: '',
      experience_required: '', employment_type: 'full_time',
      hiring_deadline: '', reporting_manager_id: '',
      job_description: '',
    });
    setModal('form');
  };

  const openEdit = (row) => {
    if (row.status !== 'pending') return toast.error(`Cannot edit a ${row.status} request`);
    setEditing(row);
    setForm({ ...row });
    setModal('form');
  };

  const save = async (e) => {
    e.preventDefault();
    try {
      if (editing) await api.put(`/hr/hiring-requests/${editing.id}`, form);
      else         await api.post('/hr/hiring-requests', form);
      toast.success(editing ? 'Updated' : 'Hiring request raised — waiting for HR approval');
      setModal(false); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    }
  };

  const approve = async () => {
    try {
      await api.post(`/hr/hiring-requests/${actionRow.id}/approve`, { notes: reason || null });
      toast.success('Approved — position is now open for sourcing');
      setModal(false); setActionRow(null); setReason(''); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Approve failed');
    }
  };

  const reject = async () => {
    if (!reason.trim()) return toast.error('Give a rejection reason');
    try {
      await api.post(`/hr/hiring-requests/${actionRow.id}/reject`, { reason });
      toast.success('Rejected');
      setModal(false); setActionRow(null); setReason(''); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Reject failed');
    }
  };

  const close = async (row) => {
    if (!confirm(`Close hiring request for ${row.position_title}? (No more candidates can be linked to it.)`)) return;
    try {
      await api.post(`/hr/hiring-requests/${row.id}/close`);
      toast.success('Closed');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Close failed');
    }
  };

  const remove = async (row) => {
    if (!confirm(`Delete hiring request "${row.position_title}"? Any linked candidates will be unlinked.`)) return;
    try {
      await api.delete(`/hr/hiring-requests/${row.id}`);
      toast.success('Deleted');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Delete failed');
    }
  };

  // Status counts for the pill bar
  const counts = STATUS_PILLS.reduce((acc, s) => {
    acc[s.id] = rows.filter(r => r.status === s.id).length;
    return acc;
  }, {});
  const visible = filter === 'all' ? rows : rows.filter(r => r.status === filter);

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div>
          <h3 className="font-semibold flex items-center gap-2"><FiBriefcase /> Hiring Requests</h3>
          <p className="text-[11px] text-gray-500">Manager → HR approval → open position → candidates link back to the requisition</p>
        </div>
        <button onClick={openCreate} className="btn btn-primary flex items-center gap-2"><FiPlus /> Raise Hiring Request</button>
      </div>

      {/* Status filter pills */}
      <div className="flex gap-2 flex-wrap items-center">
        <button
          onClick={() => setFilter('all')}
          className={`btn ${filter === 'all' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}
        >
          All
          <span className={`px-1.5 rounded-full text-[10px] font-bold min-w-[22px] text-center ${filter === 'all' ? 'bg-white/30 text-white' : 'text-white bg-gray-500'}`}>
            {rows.length}
          </span>
        </button>
        {STATUS_PILLS.map(s => {
          const active = filter === s.id;
          return (
            <button
              key={s.id}
              onClick={() => setFilter(s.id)}
              className={`btn ${active ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}
            >
              {s.label}
              <span className={`px-1.5 rounded-full text-[10px] font-bold min-w-[22px] text-center ${active ? 'bg-white/30 text-white' : `text-white ${s.bg}`}`}>
                {counts[s.id] || 0}
              </span>
            </button>
          );
        })}
      </div>

      {/* List */}
      <div className="card p-0 overflow-x-auto">
        <table className="text-sm w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Position / Dept</th>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Salary / Exp / Type</th>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Deadline / Reporting</th>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Status</th>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Candidates</th>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(r => (
              <tr key={r.id} className="border-t hover:bg-gray-50/60 align-top">
                <td className="px-3 py-2">
                  <div className="font-medium text-gray-900">{r.position_title}</div>
                  <div className="text-[11px] text-gray-500">{r.department} · {r.num_openings} opening{r.num_openings > 1 ? 's' : ''}</div>
                  <div className="text-[10px] text-gray-400">By {r.requested_by_name || `#${r.requested_by}`}</div>
                </td>
                <td className="px-3 py-2 text-[11px] space-y-0.5">
                  {(r.salary_min || r.salary_max) && (
                    <div>₹{(r.salary_min || 0).toLocaleString('en-IN')} – ₹{(r.salary_max || 0).toLocaleString('en-IN')}</div>
                  )}
                  {r.experience_required && <div className="text-gray-500">Exp: {r.experience_required}</div>}
                  <div className="text-[10px] text-gray-400 uppercase">{(r.employment_type || 'full_time').replace(/_/g, '-')}</div>
                </td>
                <td className="px-3 py-2 text-[11px]">
                  {r.hiring_deadline && <div><FiCalendar className="inline mr-1 text-gray-400" size={11}/>{fmtDate(r.hiring_deadline)}</div>}
                  {r.reporting_manager_name && <div className="text-gray-500"><FiUsers className="inline mr-1 text-gray-400" size={11}/>{r.reporting_manager_name}</div>}
                </td>
                <td className="px-3 py-2">
                  {(() => {
                    const sp = STATUS_PILLS.find(s => s.id === r.status);
                    return <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded text-white ${sp?.bg || 'bg-gray-400'}`}>{sp?.label || r.status}</span>;
                  })()}
                  {r.approval_notes && <div className="text-[10px] text-gray-500 mt-0.5 italic">"{r.approval_notes}"</div>}
                </td>
                <td className="px-3 py-2 text-[12px]">
                  <span className="font-semibold text-gray-700">{r.candidates_count || 0}</span>
                  <span className="text-[10px] text-gray-400"> linked</span>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {r.status === 'pending' && (
                      <>
                        <button
                          onClick={() => { setActionRow(r); setReason(''); setModal('approve'); }}
                          className="btn btn-primary text-[11px] py-1 px-2 bg-emerald-600 hover:bg-emerald-700 border-emerald-600">
                          <FiCheckCircle size={11} className="inline mr-1"/>Approve
                        </button>
                        <button
                          onClick={() => { setActionRow(r); setReason(''); setModal('reject'); }}
                          className="btn btn-secondary text-[11px] py-1 px-2 text-red-600">
                          <FiXCircle size={11} className="inline mr-1"/>Reject
                        </button>
                      </>
                    )}
                    {r.status === 'approved' && (
                      <button onClick={() => close(r)} className="btn btn-secondary text-[11px] py-1 px-2">
                        <FiLock size={11} className="inline mr-1"/>Close
                      </button>
                    )}
                    <button
                      onClick={() => openEdit(r)}
                      disabled={r.status !== 'pending'}
                      className="p-1 text-gray-400 hover:text-blue-600 disabled:opacity-30 disabled:cursor-not-allowed"
                      title={r.status === 'pending' ? 'Edit' : 'Frozen after approval — admin only'}>
                      <FiEdit2 size={14} />
                    </button>
                    {canDelete('hr') && (
                      <button onClick={() => remove(r)} className="p-1 text-gray-400 hover:text-red-600" title="Delete">
                        <FiTrash2 size={14} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan="6" className="text-center py-8 text-gray-400">
                {rows.length === 0
                  ? 'No hiring requests yet — click "Raise Hiring Request" to start'
                  : `No ${filter} hiring requests`}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* CREATE / EDIT MODAL */}
      <Modal isOpen={modal === 'form'} onClose={() => setModal(false)} title={editing ? 'Edit Hiring Request' : 'Raise Hiring Request'} wide>
        <form onSubmit={save} className="space-y-3">
          <p className="text-[11px] text-blue-700 bg-blue-50 border border-blue-100 rounded px-3 py-2">
            Submit a requisition for HR to review. Once approved, this becomes an open position and candidates can be linked to it from the Candidates tab.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Department *</label>
              <input className="input" required placeholder="e.g. Engineering / Civil / Sales"
                value={form.department || ''} onChange={e => setForm({ ...form, department: e.target.value })} />
            </div>
            <div>
              <label className="label">Position Title *</label>
              <input className="input" required placeholder="e.g. Site Engineer"
                value={form.position_title || ''} onChange={e => setForm({ ...form, position_title: e.target.value })} />
            </div>
            <div>
              <label className="label">Number of Openings</label>
              <input className="input" type="number" min="1"
                value={form.num_openings ?? 1} onChange={e => setForm({ ...form, num_openings: +e.target.value })} />
            </div>
            <div>
              <label className="label">Employment Type</label>
              <select className="select" value={form.employment_type || 'full_time'} onChange={e => setForm({ ...form, employment_type: e.target.value })}>
                {EMPLOYMENT_TYPES.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Salary Min (₹/month)</label>
              <input className="input" type="number" placeholder="25000"
                value={form.salary_min ?? ''} onChange={e => setForm({ ...form, salary_min: e.target.value })} />
            </div>
            <div>
              <label className="label">Salary Max (₹/month)</label>
              <input className="input" type="number" placeholder="40000"
                value={form.salary_max ?? ''} onChange={e => setForm({ ...form, salary_max: e.target.value })} />
            </div>
            <div>
              <label className="label">Experience Required</label>
              <input className="input" placeholder="e.g. 2-4 years / Fresher"
                value={form.experience_required || ''} onChange={e => setForm({ ...form, experience_required: e.target.value })} />
            </div>
            <div>
              <label className="label">Hiring Deadline</label>
              <input className="input" type="date"
                value={form.hiring_deadline || ''} onChange={e => setForm({ ...form, hiring_deadline: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <label className="label">Reporting Manager</label>
              <select className="select" value={form.reporting_manager_id || ''} onChange={e => setForm({ ...form, reporting_manager_id: e.target.value })}>
                <option value="">— Pick employee —</option>
                {employees.map(e => <option key={e.id} value={e.id}>{e.name}{e.designation ? ` (${e.designation})` : ''}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="label">Job Description / Notes <span className="text-gray-400 font-normal text-[10px]">(full JD module comes in Batch B)</span></label>
              <textarea className="input" rows="3" placeholder="Brief about the role, key responsibilities, must-have skills…"
                value={form.job_description || ''} onChange={e => setForm({ ...form, job_description: e.target.value })} />
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Submit for HR Approval'}</button>
          </div>
        </form>
      </Modal>

      {/* APPROVE MODAL */}
      <Modal isOpen={modal === 'approve'} onClose={() => setModal(false)} title={`Approve — ${actionRow?.position_title || ''}`}>
        <div className="space-y-3">
          <p className="text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-100 rounded px-3 py-2">
            This will open the position for sourcing. Candidates can then be linked to this requisition.
          </p>
          <div>
            <label className="label">Approval Notes <span className="text-gray-400 font-normal text-[10px]">(optional)</span></label>
            <textarea className="input" rows="2" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Approved with reduced budget — target ₹35k upper limit" />
          </div>
          <div className="flex justify-end gap-3">
            <button onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button onClick={approve} className="btn btn-primary bg-emerald-600 hover:bg-emerald-700 border-emerald-600">Approve & Open Position</button>
          </div>
        </div>
      </Modal>

      {/* REJECT MODAL */}
      <Modal isOpen={modal === 'reject'} onClose={() => setModal(false)} title={`Reject — ${actionRow?.position_title || ''}`}>
        <div className="space-y-3">
          <p className="text-[11px] text-red-700 bg-red-50 border border-red-100 rounded px-3 py-2">
            Reject this hiring request. The requester will see the reason on their side.
          </p>
          <div>
            <label className="label">Rejection Reason *</label>
            <textarea className="input" rows="2" required value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Headcount frozen this quarter — reapply in Q3" />
          </div>
          <div className="flex justify-end gap-3">
            <button onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button onClick={reject} className="btn btn-primary bg-red-600 hover:bg-red-700 border-red-600">Reject Request</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
