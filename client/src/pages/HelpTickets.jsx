// Dedicated Help Tickets page — full-screen version of the floating
// HelpTicket panel. Adds tabs (Assigned to me / Assigned by me / All)
// per mam's spec, plus the same close-by-raiser permission applied
// on the server.

import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiHelpCircle, FiPlus, FiCheckCircle, FiClock, FiAlertTriangle, FiEdit2, FiTrash2, FiSearch, FiUser, FiTag, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { fmtDate } from '../utils/datetime';

const STATUS_COLORS = {
  open: 'bg-red-100 text-red-700',
  in_progress: 'bg-amber-100 text-amber-700',
  resolved: 'bg-emerald-100 text-emerald-700',
  closed: 'bg-gray-100 text-gray-500',
};
const PRIORITY_COLORS = {
  low: 'text-gray-500 bg-gray-50',
  medium: 'text-blue-700 bg-blue-50',
  high: 'text-amber-700 bg-amber-50',
  urgent: 'text-red-700 bg-red-50 font-bold',
};
const CATEGORIES = ['bug', 'feature_request', 'how_to', 'access_issue', 'data_issue', 'manpower', 'material', 'payment', 'other'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

export default function HelpTickets() {
  const { user, isAdmin, canSeeAll } = useAuth();
  // Mam: 'help tickets also permission one PC we need to followup all
  // help tickets'. Anyone with help_tickets.see_all (or admin) can see
  // every ticket and triage them.
  const canFollowAll = isAdmin() || canSeeAll('help_tickets');
  const [scope, setScope] = useState('mine');     // mine | given | all
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [tickets, setTickets] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [createModal, setCreateModal] = useState(false);
  const [viewModal, setViewModal] = useState(null);
  const [form, setForm] = useState({ subject: '', description: '', category: 'bug', priority: 'medium', module: '', assigned_to: '' });
  const [response, setResponse] = useState('');
  const [reassign, setReassign] = useState('');

  const load = () => {
    const params = new URLSearchParams({ scope });
    if (statusFilter) params.set('status', statusFilter);
    api.get('/support?' + params.toString()).then(r => setTickets(r.data || [])).catch(() => setTickets([]));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [scope, statusFilter]);
  useEffect(() => {
    api.get('/auth/users').then(r => setEmployees((r.data || []).filter(u => u.active !== 0))).catch(() => setEmployees([]));
  }, []);

  // Counts for the tab badges
  const [counts, setCounts] = useState({ mine: 0, given: 0, all: 0 });
  useEffect(() => {
    Promise.all([
      api.get('/support?scope=mine').then(r => r.data?.length || 0).catch(() => 0),
      api.get('/support?scope=given').then(r => r.data?.length || 0).catch(() => 0),
      canFollowAll ? api.get('/support?scope=all').then(r => r.data?.length || 0).catch(() => 0) : Promise.resolve(0),
    ]).then(([m, g, a]) => setCounts({ mine: m, given: g, all: a }));
  }, [tickets.length, canFollowAll]);

  const submit = async (e) => {
    e.preventDefault();
    // Upload optional attachment first (screenshot, log, PDF) and stash
    // its URL on attachment_link so admin / assignee can see the proof.
    let payload = { ...form };
    delete payload._file;
    if (form._file) {
      try {
        const fd = new FormData();
        fd.append('file', form._file);
        const up = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        payload.attachment_link = up.data?.url || null;
      } catch (err) {
        toast.error(`Attachment upload failed: ${err.response?.data?.error || err.message} — submitting without file`, { duration: 5000 });
      }
    }
    try {
      const r = await api.post('/support', payload);
      toast.success(`Ticket ${r.data.ticket_no} created`);
      setCreateModal(false);
      setForm({ subject: '', description: '', category: 'bug', priority: 'medium', module: '', assigned_to: '', _file: null });
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const update = async (id, payload) => {
    try {
      await api.put(`/support/${id}`, payload);
      toast.success('Updated');
      setViewModal(null); setResponse(''); setReassign('');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const del = async (t) => {
    if (!confirm(`Delete ticket ${t.ticket_no}?`)) return;
    try { await api.delete(`/support/${t.id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const filtered = !search ? tickets : tickets.filter(t => {
    const q = search.toLowerCase();
    return (t.ticket_no || '').toLowerCase().includes(q)
      || (t.subject || '').toLowerCase().includes(q)
      || (t.description || '').toLowerCase().includes(q)
      || (t.user_name || '').toLowerCase().includes(q)
      || (t.assigned_to_name || '').toLowerCase().includes(q);
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h3 className="text-xl font-bold text-gray-800 flex items-center gap-2"><FiHelpCircle className="text-red-600" /> Help Tickets</h3>
          <p className="text-sm text-gray-500">Raise a ticket, follow up on what you've raised, or work on what's been assigned to you.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => exportCsv('help-tickets',
            ['Ticket #','Subject','Raised By','Assigned To','Priority','Status','When'],
            tickets.map(t => [t.ticket_no, t.subject, t.raised_by_name, t.assigned_to_name, t.priority, t.status, t.created_at]))}
            className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload size={14} /> Export Excel</button>
          <button onClick={() => setCreateModal(true)} className="btn btn-primary flex items-center gap-2"><FiPlus size={14} /> Raise New Ticket</button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2">
        {[
          { id: 'mine',  label: 'Assigned to me',  count: counts.mine },
          { id: 'given', label: 'Raised by me',    count: counts.given },
          ...(canFollowAll ? [{ id: 'all', label: isAdmin() ? 'All tickets (admin)' : 'All tickets (follow-up)', count: counts.all }] : []),
        ].map(t => (
          <button key={t.id} onClick={() => setScope(t.id)}
            className={`px-4 py-2 rounded-lg text-sm font-medium border ${scope === t.id ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}>
            {t.label} <span className={`ml-1 text-[10px] px-1.5 py-0.5 rounded ${scope === t.id ? 'bg-white/20' : 'bg-gray-100 text-gray-500'}`}>{t.count}</span>
          </button>
        ))}
        <select className="select w-44 text-sm" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="in_progress">In Progress</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
        </select>
        <div className="relative flex-1 min-w-[200px]">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
          <input className="input pl-9" placeholder="Search ticket no / subject / person…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      </div>

      {/* Tickets list — bounded scroll + sticky thead.  Mam, 2026-05-13. */}
      <div className="card p-0 overflow-auto max-h-[70vh]">
        <table className="text-sm w-full">
          <thead className="sticky top-0 z-10 bg-gray-50">
            <tr>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Ticket</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Subject</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Raised By</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Assigned To</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Priority</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Status</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">When</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && <tr><td colSpan="8" className="text-center py-8 text-gray-400 text-sm">No tickets {scope === 'mine' ? 'assigned to you' : scope === 'given' ? 'raised by you' : ''} yet.</td></tr>}
            {filtered.map(t => {
              const isRaiser = t.user_id === user?.id;
              const isAssignee = t.assigned_to === user?.id;
              const canClose = canFollowAll || isRaiser;
              return (
                <tr key={t.id} className="border-t hover:bg-gray-50 cursor-pointer" onClick={() => { setViewModal(t); setResponse(t.admin_response || ''); setReassign(t.assigned_to || ''); }}>
                  <td className="px-3 py-2 font-mono text-xs text-red-700 font-semibold">{t.ticket_no}</td>
                  <td className="px-3 py-2 text-gray-800 max-w-[260px] truncate" title={t.subject}>{t.subject}</td>
                  <td className="px-3 py-2 text-gray-600">{t.user_name}{isRaiser && <span className="text-[10px] text-red-600 ml-1">(you)</span>}</td>
                  <td className="px-3 py-2 text-gray-600">{t.assigned_to_name || <span className="text-gray-300">—</span>}{isAssignee && <span className="text-[10px] text-red-600 ml-1">(you)</span>}</td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded text-[10px] uppercase ${PRIORITY_COLORS[t.priority] || ''}`}>{t.priority}</span></td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded text-[10px] uppercase ${STATUS_COLORS[t.status] || ''}`}>{t.status?.replace('_', ' ')}</span></td>
                  <td className="px-3 py-2 text-[11px] text-gray-500 whitespace-nowrap">{fmtDate(t.created_at, { day: '2-digit', month: 'short' })}</td>
                  <td className="px-3 py-2 text-right" onClick={e => e.stopPropagation()}>
                    {/* Quick close button only for the raiser / admin */}
                    {canClose && t.status !== 'resolved' && t.status !== 'closed' && (
                      <button onClick={() => update(t.id, { status: 'resolved' })} className="text-[10px] text-emerald-700 font-bold hover:underline mr-2" title="Mark resolved">Close</button>
                    )}
                    {(canFollowAll || isRaiser) && (
                      <button onClick={() => del(t)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={12} /></button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Create Ticket Modal */}
      <Modal isOpen={createModal} onClose={() => setCreateModal(false)} title="Raise New Ticket">
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="label">Subject *</label>
            <input className="input" required value={form.subject} onChange={e => setForm({ ...form, subject: e.target.value })} placeholder="Short title — e.g. Cannot upload PO file" />
          </div>
          <div>
            <label className="label">Description *</label>
            <textarea className="input" rows="4" required value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="What happened, what you expected, what module you were on" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Category</label>
              <select className="select" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                {CATEGORIES.map(c => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Priority</label>
              <select className="select" value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}>
                {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <label className="label">Module (optional)</label>
              <input className="input" value={form.module} onChange={e => setForm({ ...form, module: e.target.value })} placeholder="e.g. Procurement, Delegations, Inventory" />
            </div>
            <div className="col-span-2">
              <label className="label">Assign To (optional)</label>
              <SearchableSelect
                options={employees.map(e => ({ ...e, label: e.name + (e.department ? ' (' + e.department + ')' : '') }))}
                value={form.assigned_to || null}
                valueKey="id" displayKey="label"
                placeholder="Pick someone or leave blank for admin to triage"
                onChange={(emp) => setForm(f => ({ ...f, assigned_to: emp?.id || '' }))}
              />
            </div>
            <div className="col-span-2">
              <label className="label">Attachment <span className="text-gray-400 font-normal text-[10px]">(optional · screenshot, log, PDF)</span></label>
              <input
                className="input"
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.webp,.gif,.txt,.log,.xlsx,.xls,.csv,.doc,.docx"
                onChange={e => setForm(f => ({ ...f, _file: e.target.files?.[0] || null }))}
              />
              {form._file && (
                <p className="text-[10px] text-blue-600 mt-1">Selected: {form._file.name} ({(form._file.size / 1024).toFixed(1)} KB)</p>
              )}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => setCreateModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Raise Ticket</button>
          </div>
        </form>
      </Modal>

      {/* View / Update Ticket Modal */}
      <Modal isOpen={!!viewModal} onClose={() => setViewModal(null)} title={viewModal ? `${viewModal.ticket_no} — ${viewModal.subject}` : 'Ticket'} wide>
        {viewModal && (() => {
          const isRaiser = viewModal.user_id === user?.id;
          const isAssignee = viewModal.assigned_to === user?.id;
          const canClose = canFollowAll || isRaiser;
          const canRespond = canFollowAll || isAssignee || isRaiser;
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-gray-400 text-xs">Raised by:</span> <b>{viewModal.user_name}</b></div>
                <div><span className="text-gray-400 text-xs">Assigned to:</span> <b>{viewModal.assigned_to_name || '—'}</b></div>
                <div><span className="text-gray-400 text-xs">Category:</span> {viewModal.category?.replace('_', ' ')}</div>
                <div><span className="text-gray-400 text-xs">Priority:</span> <span className={`px-1.5 py-0.5 rounded text-[10px] ${PRIORITY_COLORS[viewModal.priority] || ''}`}>{viewModal.priority}</span></div>
                <div><span className="text-gray-400 text-xs">Status:</span> <span className={`px-1.5 py-0.5 rounded text-[10px] ${STATUS_COLORS[viewModal.status] || ''}`}>{viewModal.status?.replace('_', ' ')}</span></div>
                <div><span className="text-gray-400 text-xs">Module:</span> {viewModal.module || '—'}</div>
              </div>
              <div>
                <label className="label">Description</label>
                <div className="bg-gray-50 border rounded p-3 text-sm whitespace-pre-wrap">{viewModal.description}</div>
              </div>
              {viewModal.attachment_link && (
                <div>
                  <a href={viewModal.attachment_link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline text-sm font-semibold">
                    📎 View attachment
                  </a>
                </div>
              )}
              {viewModal.admin_response && (
                <div>
                  <label className="label">Latest Response</label>
                  <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm whitespace-pre-wrap text-blue-900">{viewModal.admin_response}</div>
                </div>
              )}
              {canRespond && (
                <div>
                  <label className="label">Add / Update Response</label>
                  <textarea className="input" rows="3" value={response} onChange={e => setResponse(e.target.value)} placeholder="What's the status, plan, or fix..." />
                </div>
              )}
              {canFollowAll && (
                <div>
                  <label className="label">Reassign To</label>
                  <SearchableSelect
                    options={employees.map(e => ({ ...e, label: e.name + (e.department ? ' (' + e.department + ')' : '') }))}
                    value={reassign || null}
                    valueKey="id" displayKey="label"
                    placeholder="Pick assignee"
                    onChange={(emp) => setReassign(emp?.id || '')}
                  />
                </div>
              )}
              <div className="flex flex-wrap justify-end gap-2 pt-2 border-t">
                <button onClick={() => setViewModal(null)} className="btn btn-secondary">Close</button>
                {canRespond && viewModal.status !== 'resolved' && viewModal.status !== 'closed' && (
                  <button onClick={() => update(viewModal.id, { status: 'in_progress', admin_response: response, ...(canFollowAll && reassign !== viewModal.assigned_to ? { assigned_to: reassign || null } : {}) })} className="btn btn-secondary text-amber-700">Mark In Progress</button>
                )}
                {canRespond && (
                  <button onClick={() => update(viewModal.id, { admin_response: response, ...(canFollowAll && reassign !== viewModal.assigned_to ? { assigned_to: reassign || null } : {}) })} className="btn btn-primary">Save Response</button>
                )}
                {canClose && viewModal.status !== 'resolved' && viewModal.status !== 'closed' && (
                  <button onClick={() => update(viewModal.id, { status: 'resolved', admin_response: response || viewModal.admin_response })} className="btn btn-success flex items-center gap-1"><FiCheckCircle size={12} /> Mark Resolved</button>
                )}
                {!canClose && viewModal.status !== 'resolved' && viewModal.status !== 'closed' && (
                  <span className="text-[11px] text-gray-500 italic self-center">Only the person who raised this ticket can close it.</span>
                )}
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}
