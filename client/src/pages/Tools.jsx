// Tools Management — catalog every returnable asset (drills, ladders,
// multimeters, safety gear) with its current location (site / user),
// condition, and movement history. Plus weekly tools-list submission
// per site that powers the Supervisor MIS scorecard KPI.

import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiTool, FiTruck, FiArrowDownCircle, FiAlertCircle, FiEdit2, FiTrash2, FiSearch, FiCalendar, FiClipboard } from 'react-icons/fi';
import { fmtDateTime } from '../utils/datetime';

const CATEGORIES = ['Drilling', 'Cutting', 'Measurement', 'Safety', 'Power', 'Hand', 'Lifting', 'Electrical', 'Other'];
const STATUSES = ['available', 'in_use', 'maintenance', 'lost', 'scrapped'];
const STATUS_PILL = {
  available: 'bg-emerald-100 text-emerald-700',
  in_use: 'bg-blue-100 text-blue-700',
  maintenance: 'bg-amber-100 text-amber-700',
  lost: 'bg-red-100 text-red-700',
  scrapped: 'bg-gray-200 text-gray-600',
};

const CONDITION_PILL = {
  new: 'bg-emerald-50 text-emerald-700 border-emerald-300',
  good: 'bg-blue-50 text-blue-700 border-blue-300',
  fair: 'bg-amber-50 text-amber-700 border-amber-300',
  poor: 'bg-orange-50 text-orange-700 border-orange-300',
  scrap: 'bg-red-50 text-red-700 border-red-300',
};

const lastMonday = () => {
  const d = new Date();
  const dow = d.getDay();
  const offset = dow === 0 ? -6 : (1 - dow);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

export default function Tools() {
  const { canCreate, canEdit, canDelete, isAdmin } = useAuth();
  const [tab, setTab] = useUrlTab('catalog');
  const [tools, setTools] = useState([]);
  const [stats, setStats] = useState(null);
  const [sites, setSites] = useState([]);
  const [users, setUsers] = useState([]);
  const [filters, setFilters] = useState({ category: '', status: '', search: '' });
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [actionTool, setActionTool] = useState(null);
  const [actionType, setActionType] = useState(null);
  const [actionForm, setActionForm] = useState({});
  const [historyTool, setHistoryTool] = useState(null);
  const [submissions, setSubmissions] = useState([]);
  const [submissionWeek, setSubmissionWeek] = useState(lastMonday());
  const [submitForm, setSubmitForm] = useState({ site_id: '', week_start: lastMonday(), tools_json: [], notes: '' });

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (filters.category) params.set('category', filters.category);
    if (filters.status) params.set('status', filters.status);
    if (filters.search) params.set('search', filters.search);
    api.get(`/tools?${params}`).then(r => setTools(r.data)).catch(() => {});
    api.get('/tools/stats').then(r => setStats(r.data)).catch(() => {});
  }, [filters]);

  useEffect(() => {
    if (tab === 'catalog' || tab === 'dashboard') load();
    if (tab === 'submissions') {
      api.get(`/tools/submissions/list?week_start=${submissionWeek}`).then(r => setSubmissions(r.data)).catch(() => {});
    }
    api.get('/dpr/sites?all=1').then(r => setSites(r.data)).catch(() => {});
    api.get('/auth/users').then(r => setUsers((r.data || []).filter(u => u.active !== 0))).catch(() => {});
  }, [tab, load, submissionWeek]);

  const save = async (e) => {
    e.preventDefault();
    try {
      if (form.id) {
        await api.put(`/tools/${form.id}`, form);
        toast.success('Updated');
      } else {
        const r = await api.post('/tools', form);
        toast.success(`Added ${r.data.tool_code}`);
      }
      setModal(null);
      setForm({});
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const del = async (t) => {
    if (!confirm(`Delete tool "${t.name}" (${t.tool_code})?`)) return;
    try { await api.delete(`/tools/${t.id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const doAction = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/tools/${actionTool.id}/${actionType}`, actionForm);
      toast.success(`${actionType.charAt(0).toUpperCase() + actionType.slice(1)}d`);
      setActionTool(null);
      setActionType(null);
      setActionForm({});
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const submitWeekly = async (e) => {
    e.preventDefault();
    if (!submitForm.site_id || submitForm.tools_json.length === 0) {
      return toast.error('Pick a site and at least one tool');
    }
    try {
      const r = await api.post('/tools/submissions', submitForm);
      toast.success(`Submitted — ${r.data.tools_count} tools logged`);
      setModal(null);
      setSubmitForm({ site_id: '', week_start: lastMonday(), tools_json: [], notes: '' });
      api.get(`/tools/submissions/list?week_start=${submissionWeek}`).then(r => setSubmissions(r.data));
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FiTool className="text-blue-600" /> Tools Management</h1>
          <p className="text-sm text-gray-500">Returnable assets — catalog, issue, return, weekly site submissions.</p>
        </div>
        {canCreate('tools') && tab === 'catalog' && (
          <button onClick={() => { setForm({ condition: 'good', status: 'available' }); setModal('add'); }} className="btn btn-primary flex items-center gap-1"><FiPlus size={14} /> Add Tool</button>
        )}
        {canCreate('tools') && tab === 'submissions' && (
          <button onClick={() => { setSubmitForm({ site_id: '', week_start: lastMonday(), tools_json: [], notes: '' }); setModal('submit'); }} className="btn btn-primary flex items-center gap-1"><FiClipboard size={14} /> Submit Weekly List</button>
        )}
      </div>

      <div className="flex gap-2 flex-wrap text-sm">
        {['dashboard', 'catalog', 'submissions'].map(t => (
          <button key={t} onClick={() => setTab(t)} className={`btn ${tab === t ? 'btn-primary' : 'btn-secondary'}`}>
            {t === 'dashboard' ? 'Dashboard' : t === 'catalog' ? 'All Tools' : 'Weekly Submissions'}
          </button>
        ))}
      </div>

      {/* Dashboard */}
      {tab === 'dashboard' && stats && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="card p-4 border-l-4 border-blue-500"><p className="text-xs text-gray-500">Total Tools</p><p className="text-2xl font-bold">{stats.total}</p></div>
            <div className="card p-4 border-l-4 border-emerald-500"><p className="text-xs text-gray-500">Total Value</p><p className="text-xl font-bold text-emerald-700">Rs {(stats.total_value || 0).toLocaleString('en-IN')}</p></div>
            <div className="card p-4 border-l-4 border-amber-500"><p className="text-xs text-gray-500">Calibration Due (30 days)</p><p className="text-2xl font-bold text-amber-600">{stats.calibration_due_30d}</p></div>
            {stats.by_status?.slice(0, 2).map(s => (
              <div key={s.status} className="card p-4 border-l-4 border-gray-300">
                <p className="text-xs text-gray-500">{s.status.replace('_', ' ')}</p>
                <p className="text-2xl font-bold">{s.c}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="card p-4">
              <h3 className="font-bold text-sm mb-3">By Status</h3>
              {stats.by_status.map(s => (
                <div key={s.status} className="flex justify-between text-sm py-1.5 border-b last:border-0">
                  <span className={`px-2 py-0.5 rounded text-[10px] ${STATUS_PILL[s.status] || 'bg-gray-100'}`}>{s.status.replace('_', ' ')}</span>
                  <span className="font-semibold">{s.c}</span>
                </div>
              ))}
            </div>
            <div className="card p-4">
              <h3 className="font-bold text-sm mb-3">By Category</h3>
              {stats.by_category.map(c => (
                <div key={c.category} className="flex justify-between text-sm py-1.5 border-b last:border-0">
                  <span>{c.category}</span>
                  <span className="font-semibold">{c.c}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Catalog */}
      {tab === 'catalog' && (
        <>
          <div className="card p-3 flex flex-wrap gap-2 items-end">
            <div className="relative flex-1 min-w-[200px]">
              <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
              <input className="input pl-9 text-sm" placeholder="Search by name / code / serial / brand…" value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} />
            </div>
            <select className="select text-sm w-40" value={filters.category} onChange={e => setFilters(f => ({ ...f, category: e.target.value }))}>
              <option value="">All categories</option>
              {CATEGORIES.map(c => <option key={c}>{c}</option>)}
            </select>
            <select className="select text-sm w-40" value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}>
              <option value="">All statuses</option>
              {STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </select>
          </div>

          <div className="card p-0 overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Category</th>
                  <th>Brand / Model</th>
                  <th>Serial</th>
                  <th>Cond.</th>
                  <th>Status</th>
                  <th>Current Site / User</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tools.length === 0 && <tr><td colSpan="9" className="text-center py-8 text-gray-400">No tools yet — click "Add Tool" to start the catalog</td></tr>}
                {tools.map(t => (
                  <tr key={t.id} className="hover:bg-gray-50">
                    <td className="font-bold text-blue-700 text-xs">{t.tool_code}</td>
                    <td className="font-medium">{t.name}</td>
                    <td className="text-xs">{t.category || '—'}</td>
                    <td className="text-xs">{[t.brand, t.model].filter(Boolean).join(' / ') || '—'}</td>
                    <td className="text-xs text-gray-500">{t.serial_no || '—'}</td>
                    <td><span className={`text-[10px] px-1.5 py-0.5 rounded border ${CONDITION_PILL[t.condition] || 'bg-gray-50'}`}>{t.condition}</span></td>
                    <td><span className={`text-[10px] px-2 py-0.5 rounded font-bold ${STATUS_PILL[t.status]}`}>{t.status.replace('_', ' ')}</span></td>
                    <td className="text-xs">
                      {t.current_user_name && <div>👤 {t.current_user_name}</div>}
                      {t.current_site_name && <div>📍 {t.current_site_name}</div>}
                      {!t.current_user_name && !t.current_site_name && <span className="text-gray-300">Stored</span>}
                    </td>
                    <td className="whitespace-nowrap">
                      <div className="flex gap-1">
                        {canEdit('tools') && t.status === 'available' && (
                          <button onClick={() => { setActionTool(t); setActionType('issue'); setActionForm({}); }} className="btn btn-success text-[10px] px-2 py-1" title="Issue"><FiTruck size={11} /></button>
                        )}
                        {canEdit('tools') && t.status === 'in_use' && (
                          <button onClick={() => { setActionTool(t); setActionType('return'); setActionForm({}); }} className="btn btn-secondary text-[10px] px-2 py-1" title="Return"><FiArrowDownCircle size={11} /></button>
                        )}
                        {canEdit('tools') && t.status !== 'scrapped' && (
                          <>
                            <button onClick={() => { setActionTool(t); setActionType('maintenance'); setActionForm({}); }} className="btn btn-secondary text-[10px] px-2 py-1" title="Maintenance"><FiAlertCircle size={11} /></button>
                          </>
                        )}
                        <button onClick={() => setHistoryTool(t)} className="btn btn-secondary text-[10px] px-2 py-1" title="History">📜</button>
                        {canEdit('tools') && (
                          <button onClick={() => { setForm(t); setModal('add'); }} className="p-1 text-gray-400 hover:text-blue-600"><FiEdit2 size={12} /></button>
                        )}
                        {canDelete('tools') && (
                          <button onClick={() => del(t)} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={12} /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Weekly Submissions */}
      {tab === 'submissions' && (
        <>
          <div className="card p-3 flex items-center gap-3">
            <FiCalendar className="text-gray-400" />
            <div>
              <label className="label">Week starting (Monday)</label>
              <input type="date" className="input" value={submissionWeek} onChange={e => setSubmissionWeek(e.target.value)} />
            </div>
          </div>
          <div className="card p-0 overflow-x-auto">
            <table>
              <thead><tr><th>Week</th><th>Site</th><th>Submitted By</th><th className="text-right">Tools Count</th><th>Photo</th><th>Notes</th></tr></thead>
              <tbody>
                {submissions.length === 0 && <tr><td colSpan="6" className="text-center py-8 text-gray-400">No submissions for this week</td></tr>}
                {submissions.map(s => (
                  <tr key={s.id}>
                    <td className="text-xs">{s.week_start}</td>
                    <td className="font-medium">{s.site_name || '—'}</td>
                    <td className="text-xs">{s.submitted_by_name}</td>
                    <td className="text-right font-bold text-blue-700">{s.tools_count}</td>
                    <td>{s.photo_url ? <a href={s.photo_url} target="_blank" rel="noreferrer" className="text-blue-600 underline text-xs">📎 view</a> : <span className="text-gray-300 text-xs">—</span>}</td>
                    <td className="text-xs text-gray-500 max-w-xs truncate">{s.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Add / Edit Tool Modal */}
      <Modal isOpen={modal === 'add'} onClose={() => { setModal(null); setForm({}); }} title={form.id ? `Edit ${form.tool_code}` : 'Add Tool'} wide>
        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Name *</label><input className="input" required value={form.name || ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Bosch GBM 350 drill" /></div>
            <div>
              <label className="label">Category</label>
              <select className="select" value={form.category || ''} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
                <option value="">— pick —</option>
                {CATEGORIES.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div><label className="label">Brand</label><input className="input" value={form.brand || ''} onChange={e => setForm(f => ({ ...f, brand: e.target.value }))} placeholder="Bosch / Makita / DeWalt…" /></div>
            <div><label className="label">Model</label><input className="input" value={form.model || ''} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} placeholder="GBM 350 RE" /></div>
            <div><label className="label">Serial No.</label><input className="input" value={form.serial_no || ''} onChange={e => setForm(f => ({ ...f, serial_no: e.target.value }))} /></div>
            <div><label className="label">Purchase Date</label><input type="date" className="input" value={form.purchase_date || ''} onChange={e => setForm(f => ({ ...f, purchase_date: e.target.value }))} /></div>
            <div><label className="label">Purchase Price (Rs)</label><input type="number" className="input" value={form.purchase_price || 0} onChange={e => setForm(f => ({ ...f, purchase_price: +e.target.value }))} /></div>
            <div>
              <label className="label">Condition</label>
              <select className="select" value={form.condition || 'good'} onChange={e => setForm(f => ({ ...f, condition: e.target.value }))}>
                {['new','good','fair','poor','scrap'].map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Status</label>
              <select className="select" value={form.status || 'available'} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                {STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
              </select>
            </div>
            <div><label className="label">Last Calibration</label><input type="date" className="input" value={form.last_calibration_date || ''} onChange={e => setForm(f => ({ ...f, last_calibration_date: e.target.value }))} /></div>
            <div><label className="label">Next Calibration</label><input type="date" className="input" value={form.next_calibration_date || ''} onChange={e => setForm(f => ({ ...f, next_calibration_date: e.target.value }))} /></div>
            {/* Site / user assignment — mam: lets her correct where a tool
                is parked without going through the Issue / Return flow. */}
            <div>
              <label className="label">Current Site</label>
              <SearchableSelect
                options={sites}
                value={form.current_site_id || null}
                valueKey="id"
                displayKey="name"
                placeholder="Pick site…"
                onChange={(s) => setForm(f => ({ ...f, current_site_id: s?.id || '' }))}
              />
            </div>
            <div>
              <label className="label">Issued To <span className="text-gray-400 font-normal text-[10px]">(employee)</span></label>
              <SearchableSelect
                options={users.map(u => ({ ...u, label: u.name + (u.department ? ` — ${u.department}` : '') }))}
                value={form.current_user_id || null}
                valueKey="id"
                displayKey="label"
                placeholder="Pick employee…"
                onChange={(u) => setForm(f => ({ ...f, current_user_id: u?.id || '' }))}
              />
            </div>
            <div className="col-span-2"><label className="label">Notes</label><textarea className="input" rows="2" value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></div>
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t">
            <button type="button" onClick={() => { setModal(null); setForm({}); }} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{form.id ? 'Save' : 'Add Tool'}</button>
          </div>
        </form>
      </Modal>

      {/* Action Modal (issue / return / maintenance / scrap) */}
      <Modal isOpen={!!actionTool} onClose={() => { setActionTool(null); setActionType(null); }} title={actionTool && actionType ? `${actionType.charAt(0).toUpperCase() + actionType.slice(1)} — ${actionTool.name}` : ''}>
        {actionTool && actionType && (
          <form onSubmit={doAction} className="space-y-3">
            {actionType === 'issue' && (
              <>
                <div>
                  <label className="label">Issue to Site</label>
                  <SearchableSelect options={sites} value={actionForm.to_site_id || null} valueKey="id" displayKey="name" placeholder="Pick a site…" onChange={(s) => setActionForm(f => ({ ...f, to_site_id: s?.id || '' }))} />
                </div>
                <div>
                  <label className="label">Issue to Person <span className="text-gray-400 font-normal">(optional)</span></label>
                  <SearchableSelect options={users.map(u => ({ ...u, label: u.name + (u.department ? ` — ${u.department}` : '') }))} value={actionForm.to_user_id || null} valueKey="id" displayKey="label" placeholder="Pick a user…" onChange={(u) => setActionForm(f => ({ ...f, to_user_id: u?.id || '' }))} />
                </div>
                <div><label className="label">Expected Return</label><input type="date" className="input" value={actionForm.expected_return_date || ''} onChange={e => setActionForm(f => ({ ...f, expected_return_date: e.target.value }))} /></div>
              </>
            )}
            {actionType === 'return' && (
              <div>
                <label className="label">Condition on Return</label>
                <select className="select" value={actionForm.condition || actionTool.condition} onChange={e => setActionForm(f => ({ ...f, condition: e.target.value }))}>
                  {['new','good','fair','poor','scrap'].map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
            )}
            <div><label className="label">Notes</label><textarea className="input" rows="2" value={actionForm.notes || ''} onChange={e => setActionForm(f => ({ ...f, notes: e.target.value }))} /></div>
            <div className="flex justify-end gap-2 pt-2 border-t">
              <button type="button" onClick={() => { setActionTool(null); setActionType(null); }} className="btn btn-secondary">Cancel</button>
              <button type="submit" className="btn btn-primary">{actionType.charAt(0).toUpperCase() + actionType.slice(1)}</button>
            </div>
          </form>
        )}
      </Modal>

      {/* History Modal */}
      <Modal isOpen={!!historyTool} onClose={() => setHistoryTool(null)} title={historyTool ? `History — ${historyTool.name} (${historyTool.tool_code})` : ''} wide>
        {historyTool && <ToolHistory id={historyTool.id} />}
      </Modal>

      {/* Weekly Submission Modal */}
      <Modal isOpen={modal === 'submit'} onClose={() => setModal(null)} title="Submit Weekly Tools List" wide>
        <form onSubmit={submitWeekly} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Site *</label>
              <SearchableSelect options={sites} value={submitForm.site_id || null} valueKey="id" displayKey="name" placeholder="Pick a site…" onChange={(s) => setSubmitForm(f => ({ ...f, site_id: s?.id || '' }))} />
            </div>
            <div><label className="label">Week starting</label><input type="date" className="input" value={submitForm.week_start} onChange={e => setSubmitForm(f => ({ ...f, week_start: e.target.value }))} /></div>
          </div>
          <div>
            <label className="label">Tools at site (pick from catalog)</label>
            <select multiple size="8" className="input w-full" value={submitForm.tools_json.map(t => t.tool_id)} onChange={e => {
              const ids = Array.from(e.target.selectedOptions).map(o => +o.value);
              const items = tools.filter(t => ids.includes(t.id)).map(t => ({ tool_id: t.id, name: t.name, qty: 1, condition: t.condition }));
              setSubmitForm(f => ({ ...f, tools_json: items }));
            }}>
              {tools.filter(t => t.status !== 'scrapped').map(t => (
                <option key={t.id} value={t.id}>{t.tool_code} — {t.name} ({t.condition})</option>
              ))}
            </select>
            <p className="text-[10px] text-gray-500 mt-1">Hold Ctrl / Cmd to multi-select. {submitForm.tools_json.length} tool(s) selected.</p>
          </div>
          <div><label className="label">Notes</label><textarea className="input" rows="2" value={submitForm.notes} onChange={e => setSubmitForm(f => ({ ...f, notes: e.target.value }))} /></div>
          <div className="flex justify-end gap-2 pt-2 border-t">
            <button type="button" onClick={() => setModal(null)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Submit</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function ToolHistory({ id }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.get(`/tools/${id}`).then(r => setData(r.data)); }, [id]);
  if (!data) return <div className="text-gray-400 text-center py-6">Loading…</div>;
  const acts = {
    issue: { color: 'bg-blue-100 text-blue-700', icon: '📤' },
    return: { color: 'bg-emerald-100 text-emerald-700', icon: '📥' },
    maintenance: { color: 'bg-amber-100 text-amber-700', icon: '🔧' },
    repair: { color: 'bg-amber-100 text-amber-700', icon: '🔧' },
    scrap: { color: 'bg-red-100 text-red-700', icon: '🗑️' },
    transfer: { color: 'bg-purple-100 text-purple-700', icon: '🔄' },
    calibration: { color: 'bg-indigo-100 text-indigo-700', icon: '📏' },
  };
  return (
    <div className="space-y-2 max-h-[60vh] overflow-y-auto">
      {data.movements.length === 0 && <div className="text-center py-6 text-gray-400">No movements yet — issue this tool to start the trail.</div>}
      {data.movements.map(m => (
        <div key={m.id} className="border rounded p-3 text-sm">
          <div className="flex items-start justify-between gap-2">
            <div>
              <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${acts[m.action]?.color || 'bg-gray-100'}`}>{acts[m.action]?.icon} {m.action}</span>
              <span className="text-[11px] text-gray-500 ml-2">by {m.created_by_name || 'unknown'} · {fmtDateTime(m.created_at)}</span>
            </div>
          </div>
          <div className="text-xs text-gray-700 mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1">
            {m.from_site_name && <div>From site: <b>{m.from_site_name}</b></div>}
            {m.to_site_name && <div>To site: <b>{m.to_site_name}</b></div>}
            {m.from_user_name && <div>From user: <b>{m.from_user_name}</b></div>}
            {m.to_user_name && <div>To user: <b>{m.to_user_name}</b></div>}
            {m.expected_return_date && <div>Expected return: <b>{m.expected_return_date}</b></div>}
            {m.actual_return_date && <div>Actual return: <b>{m.actual_return_date}</b></div>}
            {m.condition_at_action && <div>Condition: <b>{m.condition_at_action}</b></div>}
          </div>
          {m.notes && <p className="text-xs text-gray-600 mt-1.5 italic">"{m.notes}"</p>}
          {m.photo_url && <a href={m.photo_url} target="_blank" rel="noreferrer" className="text-blue-600 text-xs underline mt-1 inline-block">📎 photo</a>}
        </div>
      ))}
    </div>
  );
}
