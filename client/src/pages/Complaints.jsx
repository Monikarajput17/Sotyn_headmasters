import { useEffect, useState } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiEye, FiSearch, FiAlertCircle, FiClock, FiCheckCircle, FiList, FiEdit2, FiTrash2, FiDownload, FiMessageSquare, FiUserCheck, FiKey, FiCopy, FiSend } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { STATES } from '../data/indiaLocations';

// Matches mam's "Complaint Register Form 24-25" Google Form. Categories are
// the SEPL service lines; Customer Type is Old Site / Running Site (not
// New/Existing); Complaint Type is Paid / Free. State + Remarks are new.
const CATEGORY_OPTIONS = ['Fire Fighting', 'Electrical', 'Low Voltage', 'HVAC', 'MEPF', 'Solar', 'Plumbing', 'Other'];
const CUSTOMER_TYPES = ['Old Site', 'Running Site'];
const COMPLAINT_TYPES = ['Paid', 'Free'];

const emptyForm = {
  client_name:'', company_name:'', mobile_number:'', category:'', state:'',
  problem_detail:'', customer_type:'Running Site', complaint_type:'Free',
  emp_name:'', remarks:'',
  step1_planned_date:'', step1_actual_date:'', step1_assigned_to:'',
  step2_planned_date:'', step2_actual_date:'', step2_assigned_to:'',
  service_report:'', status:'open', priority:'normal'
};

// Tab-based workflow — same design pattern as Indent to Dispatch.
// Each tab filters the list by stage so users focus on one workflow step.
const TABS = [
  { id: 'all', label: 'All Complaints' },
  { id: 'register', label: '+ Register New' },
  { id: 'step1', label: 'Step 1 — Assign' },
  { id: 'step2', label: 'Step 2 — Resolve' },
  { id: 'resolved', label: 'Resolved' },
];

export default function Complaints() {
  const { canEdit, canDelete, isAdmin } = useAuth();
  const [list, setList] = useState([]);
  const [stats, setStats] = useState({ total:0, open:0, inProgress:0, resolved:0, byCategory:[] });
  const [q, setQ] = useState({ search:'', status:'', category:'' });
  const [tab, setTab] = useUrlTab('all');
  const [showAdd, setShowAdd] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  // OTP / WhatsApp center — per-row modal showing the assign / resolve flow.
  // `otpCenter` is the complaint object being acted on; null = closed.
  // `engineers` is the user list for the engineer-picker dropdown.
  // `assignResult` caches the server response after a successful assign
  // (carries WhatsApp links + OTP).  `otpEntry` is the digits the engineer
  // typed when verifying.
  const [otpCenter, setOtpCenter] = useState(null);
  const [engineers, setEngineers] = useState([]);
  const [assignResult, setAssignResult] = useState(null);
  const [otpEntry, setOtpEntry] = useState('');
  const [registerAck, setRegisterAck] = useState(null);  // wa link surfaced right after Register

  const load = async () => {
    const params = new URLSearchParams(Object.entries(q).filter(([,v]) => v)).toString();
    const [l, s] = await Promise.all([
      api.get('/complaints' + (params ? '?'+params : '')),
      api.get('/complaints/stats'),
    ]);
    setList(l.data);
    setStats(s.data);
  };

  useEffect(() => { load(); }, [q]);
  // Best-effort load of the engineer/user list on mount so the "Assigned To"
  // fields can suggest names (mam 2026-06-15 automation). Admins-only
  // endpoint — silently empty for others, fields stay free-text.
  useEffect(() => { api.get('/users').then(({ data }) => setEngineers(Array.isArray(data) ? data : (data?.users || []))).catch(() => {}); }, []);

  const create = async (e) => {
    e.preventDefault();
    const { data } = await api.post('/complaints', form);
    setShowAdd(false);
    // Surface the registration-ack WhatsApp link in a small banner.
    // Mam (2026-05-21): "when complaint register send mesage to client".
    if (data?.whatsapp_client_register?.link) {
      setRegisterAck({ ...data.whatsapp_client_register, complaint_id: data.id, complaint_number: data.complaint_number });
    }
    setTab('step1');
    setForm(emptyForm);
    load();
  };

  // ── OTP / WhatsApp Center helpers ───────────────────────────────
  const openOtpCenter = async (c) => {
    setOtpCenter(c);
    setAssignResult(null);
    setOtpEntry('');
    // Pull users for the engineer picker (only when no engineer yet)
    if (!c.assigned_engineer_id && engineers.length === 0) {
      try {
        const { data } = await api.get('/users');
        setEngineers(Array.isArray(data) ? data : (data?.users || []));
      } catch (_) { /* admins-only endpoint — non-fatal */ }
    }
  };
  const assignEngineer = async (engId) => {
    try {
      const { data } = await api.post(`/complaints/${otpCenter.id}/assign`, { engineer_user_id: engId });
      setAssignResult(data);
      toast.success(`Engineer assigned. OTP ${data.otp} sent to client.`);
      load();
    } catch (e) { toast.error(e.response?.data?.error || 'Assign failed'); }
  };
  const sendRegisterAck = async () => {
    if (!registerAck) return;
    window.open(registerAck.link, '_blank');
    try { await api.post(`/complaints/${registerAck.complaint_id}/whatsapp/sent`, { kind: 'register' }); } catch (_) {}
    setRegisterAck(null);
  };
  const sendWhatsapp = async (link, kind) => {
    window.open(link, '_blank');
    try { await api.post(`/complaints/${otpCenter.id}/whatsapp/sent`, { kind }); } catch (_) {}
  };
  const verifyOtp = async () => {
    if (!/^\d{4}$/.test(otpEntry)) return toast.error('Enter the 4-digit code');
    try {
      await api.post(`/complaints/${otpCenter.id}/verify-otp`, { otp: otpEntry });
      toast.success('Complaint marked resolved ✓');
      setOtpCenter(null);
      load();
    } catch (e) { toast.error(e.response?.data?.error || 'Wrong OTP'); }
  };
  const resendOtp = async () => {
    try {
      const { data } = await api.post(`/complaints/${otpCenter.id}/resend-otp`);
      setAssignResult(prev => ({ ...(prev || {}), otp: data.otp, client: data.client }));
      toast.success(`New OTP ${data.otp} generated — send to client again`);
      load();
    } catch (e) { toast.error(e.response?.data?.error || 'Resend failed'); }
  };

  const save = async () => {
    await api.put(`/complaints/${viewing.id}`, viewing);
    setViewing(null);
    load();
  };

  // Open the view modal in edit mode (same modal — already has all the
  // fields editable, just opens it directly so the row's pencil = same
  // experience as the eye icon, but communicates intent to edit).
  const startEdit = (c) => setViewing({ ...c });

  const remove = async (c) => {
    if (!confirm(`Delete complaint ${c.complaint_number} (${c.client_name})?\n\nThis cannot be undone.`)) return;
    try {
      await api.delete(`/complaints/${c.id}`);
      toast.success(`Deleted ${c.complaint_number}`);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
  };

  const badge = (s) => ({
    open: 'bg-yellow-100 text-yellow-700',
    in_progress: 'bg-red-100 text-red-700',
    resolved: 'bg-green-100 text-green-700',
  }[s] || 'bg-gray-100 text-gray-700');

  // Tab-based filter — subset of the full list for each tab
  const visibleList = (() => {
    if (tab === 'step1') return list.filter(c => c.status === 'open' && !c.step1_assigned_to);
    if (tab === 'step2') return list.filter(c => (c.status === 'open' || c.status === 'in_progress') && c.step1_assigned_to && !c.service_report);
    if (tab === 'resolved') return list.filter(c => c.status === 'resolved' || c.status === 'closed');
    return list;
  })();
  const tabCount = (id) => {
    if (id === 'step1') return list.filter(c => c.status === 'open' && !c.step1_assigned_to).length;
    if (id === 'step2') return list.filter(c => (c.status === 'open' || c.status === 'in_progress') && c.step1_assigned_to && !c.service_report).length;
    if (id === 'resolved') return list.filter(c => c.status === 'resolved' || c.status === 'closed').length;
    if (id === 'all') return list.length;
    return null;
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <h1 className="text-xl font-bold text-gray-800">Complaint Register</h1>
        <button onClick={() => exportCsv('complaints',
          ['Complaint #','Client','Company','Mobile','Category','Problem','Status','Priority','Assigned To (Step1)','Created'],
          list.map(c => [c.complaint_number, c.client_name, c.company_name, c.mobile_number, c.category, c.problem_detail, c.status, c.priority, c.step1_assigned_to, c.created_at]))}
          className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload size={14} /> Export Excel</button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={<FiList />} label="Total" value={stats.total} color="slate" />
        <StatCard icon={<FiAlertCircle />} label="Open" value={stats.open} color="yellow" />
        <StatCard icon={<FiClock />} label="In Progress" value={stats.inProgress} color="blue" />
        <StatCard icon={<FiCheckCircle />} label="Resolved" value={stats.resolved} color="green" />
      </div>

      {/* Tabs — same design as Indent to Dispatch. Each tab is a workflow
          stage; count badge shows how many rows that tab contains. */}
      <div className="flex flex-wrap gap-2">
        {TABS.map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); if (t.id === 'register') setShowAdd(true); }}
            className={`px-4 py-2 rounded-lg font-semibold text-sm border transition-all ${tab === t.id && t.id !== 'register' ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
            {t.label}
            {tabCount(t.id) !== null && <span className={`ml-2 text-xs ${tab === t.id && t.id !== 'register' ? 'opacity-90' : 'text-gray-400'}`}>({tabCount(t.id)})</span>}
          </button>
        ))}
      </div>

      {/* Search / status / category — shown on every tab except the register
          tab (which opens the create modal directly). */}
      {tab !== 'register' && (
      <div className="bg-white rounded-xl p-3 flex flex-wrap gap-2 border">
        <div className="relative flex-1 min-w-[200px]">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input placeholder="Search client / mobile / number / company" value={q.search}
            onChange={e => setQ({ ...q, search: e.target.value })}
            className="w-full pl-9 pr-3 py-2 border rounded-lg text-sm" />
        </div>
        {tab === 'all' && (
          <>
            <select value={q.status} onChange={e => setQ({ ...q, status: e.target.value })} className="border rounded-lg px-3 py-2 text-sm">
              <option value="">All Statuses</option>
              <option value="open">Open</option>
              <option value="in_progress">In Progress</option>
              <option value="resolved">Resolved</option>
            </select>
            <select value={q.category} onChange={e => setQ({ ...q, category: e.target.value })} className="border rounded-lg px-3 py-2 text-sm">
              <option value="">All Categories</option>
              {CATEGORY_OPTIONS.map(c => <option key={c}>{c}</option>)}
            </select>
          </>
        )}
      </div>
      )}

      {/* Per-tab intro banner explaining what this stage means */}
      {tab === 'step1' && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
          <b>Step 1 — Assign:</b> CRM assigns these complaints to the right technical team (LV / Electrical / Fire Fighting etc.) within 1 day. Click a row to open and set the assignee + planned date.
        </div>
      )}
      {tab === 'step2' && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800">
          <b>Step 2 — Resolve:</b> Assigned person visits / calls the client, resolves the issue, and uploads a service report within 3 days. Click a row to open and submit resolution.
        </div>
      )}
      {tab === 'resolved' && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-800">
          <b>Resolved:</b> Complaints that have been fully closed with a service report.
        </div>
      )}

      <div className="bg-white rounded-xl border">
        <table className="w-full text-sm freeze-head">
          <thead className="bg-slate-50 text-slate-600 text-xs uppercase">
            <tr>
              <th className="text-left px-3 py-2">Complaint #</th>
              <th className="text-left px-3 py-2">Client</th>
              <th className="text-left px-3 py-2">Mobile</th>
              <th className="text-left px-3 py-2">Category</th>
              <th className="text-left px-3 py-2">Type</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">S1 Delay</th>
              <th className="text-left px-3 py-2">S2 Delay</th>
              <th className="text-left px-3 py-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {visibleList.map(c => (
              <tr key={c.id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2 font-mono text-xs">{c.complaint_number}</td>
                <td className="px-3 py-2">{c.client_name}<div className="text-xs text-gray-500">{c.company_name}</div></td>
                <td className="px-3 py-2">{c.mobile_number}</td>
                <td className="px-3 py-2">{c.category}</td>
                <td className="px-3 py-2">{c.complaint_type}</td>
                <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded text-xs ${badge(c.status)}`}>{c.status}</span></td>
                <td className="px-3 py-2">{c.step1_time_delay ?? '-'} d</td>
                <td className="px-3 py-2">{c.step2_time_delay ?? '-'} d</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <button onClick={() => setViewing({ ...c })} className="text-red-600 hover:text-red-800" title="View"><FiEye /></button>
                    {(canEdit('complaints') || isAdmin()) && (
                      <button onClick={() => startEdit(c)} className="text-blue-600 hover:text-blue-800" title="Edit"><FiEdit2 size={14} /></button>
                    )}
                    {/* WhatsApp / OTP centre — assign engineer + push OTP to
                        client + verify on resolution.  Mam (2026-05-21). */}
                    {(canEdit('complaints') || isAdmin()) && c.status !== 'resolved' && c.status !== 'closed' && (
                      <button onClick={() => openOtpCenter(c)} className="text-emerald-700 hover:text-emerald-900" title={c.assigned_engineer_id ? 'Verify OTP to resolve' : 'Assign engineer + send OTP'}>
                        {c.assigned_engineer_id ? <FiKey size={14} /> : <FiUserCheck size={14} />}
                      </button>
                    )}
                    {(canDelete('complaints') || isAdmin()) && (
                      <button onClick={() => remove(c)} className="text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {visibleList.length === 0 && <tr><td colSpan="9" className="text-center text-gray-400 py-8">
              {tab === 'step1' ? 'No complaints waiting for assignment — all set!'
                : tab === 'step2' ? 'No complaints in resolution — team is caught up.'
                : tab === 'resolved' ? 'No resolved complaints yet.'
                : 'No complaints found.'}
            </td></tr>}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <Modal onClose={() => { setShowAdd(false); setTab('all'); }} title="Complaint Register Form">
          <form onSubmit={create} className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Client Name *"><input required value={form.client_name} onChange={e=>setForm({...form, client_name:e.target.value})} className="inp" /></Field>
            <Field label="Company Name *"><input required value={form.company_name} onChange={e=>setForm({...form, company_name:e.target.value})} className="inp" /></Field>
            <Field label="Mobile Number *"><input required value={form.mobile_number} onChange={e=>setForm({...form, mobile_number:e.target.value})} className="inp" /></Field>
            <Field label="Category *">
              <select required value={form.category} onChange={e=>setForm({...form, category:e.target.value})} className="inp">
                <option value="">Select</option>
                {CATEGORY_OPTIONS.map(c => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="State *">
              <select required value={form.state} onChange={e=>setForm({...form, state:e.target.value})} className="inp">
                <option value="">Pick state</option>
                {STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="EMP Name"><input list="cmpEngDL1" value={form.emp_name} onChange={e=>setForm({...form, emp_name:e.target.value})} className="inp" placeholder="Who received the complaint" /><datalist id="cmpEngDL1">{engineers.map(u => <option key={u.id} value={u.name} />)}</datalist></Field>
            <Field label="Complaint Type *">
              <div className="flex gap-2">
                {COMPLAINT_TYPES.map(t => (
                  <label key={t} className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border rounded text-sm cursor-pointer ${form.complaint_type===t?'border-red-500 bg-red-50 text-red-700 font-bold':'border-gray-200 hover:bg-gray-50'}`}>
                    <input type="radio" name="complaint_type" value={t} checked={form.complaint_type===t} onChange={()=>setForm({...form, complaint_type:t})} />
                    {t}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Customer Type *">
              <div className="flex gap-2">
                {CUSTOMER_TYPES.map(t => (
                  <label key={t} className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border rounded text-sm cursor-pointer ${form.customer_type===t?'border-red-500 bg-red-50 text-red-700 font-bold':'border-gray-200 hover:bg-gray-50'}`}>
                    <input type="radio" name="customer_type" value={t} checked={form.customer_type===t} onChange={()=>setForm({...form, customer_type:t})} />
                    {t}
                  </label>
                ))}
              </div>
            </Field>
            <div className="md:col-span-2">
              <Field label="Problem Detail *"><textarea required rows="3" value={form.problem_detail} onChange={e=>setForm({...form, problem_detail:e.target.value})} className="inp" placeholder="Describe the issue in detail" /></Field>
            </div>
            <div className="md:col-span-2">
              <Field label="Remarks"><textarea rows="2" value={form.remarks} onChange={e=>setForm({...form, remarks:e.target.value})} className="inp" placeholder="Any additional notes" /></Field>
            </div>
            <div className="md:col-span-2 flex justify-end gap-2">
              <button type="button" onClick={()=>{ setShowAdd(false); setTab('all'); }} className="px-4 py-2 border rounded-lg text-sm">Cancel</button>
              <button className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm">Register Complaint</button>
            </div>
          </form>
        </Modal>
      )}

      {viewing && (() => {
        // Step 1 is "done" once CRM has assigned AND stamped the actual date.
        // Until then, Step 2 stays locked — you can't resolve a complaint
        // that hasn't even been assigned to a technician yet.
        const step1Done = !!(viewing.step1_assigned_to && viewing.step1_actual_date);
        const step2Done = !!(viewing.step2_actual_date && viewing.service_report);
        return (
        <Modal onClose={() => setViewing(null)} title={`Complaint ${viewing.complaint_number}`}>
          <div className="space-y-5">
            {/* Registration details — read-only context (captured at create time) */}
            <Section title="Complaint Details">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div><span className="text-gray-400">Client:</span> <b>{viewing.client_name}</b></div>
                <div><span className="text-gray-400">Company:</span> <b>{viewing.company_name||'-'}</b></div>
                <div><span className="text-gray-400">Mobile:</span> {viewing.mobile_number}</div>
                <div><span className="text-gray-400">Category:</span> {viewing.category}</div>
                <div><span className="text-gray-400">State:</span> {viewing.state||'-'}</div>
                <div><span className="text-gray-400">Customer Type:</span> {viewing.customer_type}</div>
                <div><span className="text-gray-400">Complaint Type:</span> {viewing.complaint_type}</div>
                <div><span className="text-gray-400">EMP Name:</span> {viewing.emp_name||'-'}</div>
                <div className="md:col-span-2"><span className="text-gray-400">Problem:</span> <span className="whitespace-pre-wrap">{viewing.problem_detail}</span></div>
                {viewing.remarks && <div className="md:col-span-2"><span className="text-gray-400">Remarks:</span> <span className="whitespace-pre-wrap">{viewing.remarks}</span></div>}
              </div>
            </Section>

            {/* STEP 1 — Assign to team */}
            <div className={`border-2 rounded-xl p-4 ${step1Done ? 'border-emerald-200 bg-emerald-50/30' : 'border-amber-300 bg-amber-50/30'}`}>
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-bold text-sm flex items-center gap-2">
                  <span className={`w-6 h-6 rounded-full flex items-center justify-center text-white text-xs ${step1Done ? 'bg-emerald-500' : 'bg-amber-500'}`}>1</span>
                  Step 1 — Assign to Team
                </h4>
                {step1Done && <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-100 text-emerald-700">DONE</span>}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Assigned To (name / team) *">
                  <input list="cmpEngDL2" value={viewing.step1_assigned_to||''} onChange={e=>setViewing({...viewing, step1_assigned_to:e.target.value})} className="inp" placeholder="e.g. LV Team / Himank / Gagan" /><datalist id="cmpEngDL2">{engineers.map(u => <option key={u.id} value={u.name} />)}</datalist>
                </Field>
                <Field label="Planned Date">
                  <input type="date" value={viewing.step1_planned_date||''} onChange={e=>setViewing({...viewing, step1_planned_date:e.target.value})} className="inp" />
                </Field>
                <Field label="Actual Assignment Date *">
                  <input type="date" value={viewing.step1_actual_date||''} onChange={e=>setViewing({...viewing, step1_actual_date:e.target.value})} className="inp" />
                </Field>
                <Field label="Time Delay (auto)">
                  <input disabled value={`${viewing.step1_time_delay ?? 0} day(s)`} className="inp bg-slate-50" />
                </Field>
              </div>
              {!step1Done && (
                <p className="text-[11px] text-amber-700 mt-2">
                  ⚠️ Fill <b>Assigned To</b> and <b>Actual Date</b> to complete Step 1 — then Step 2 will unlock.
                </p>
              )}
            </div>

            {/* STEP 2 — Resolution (unlocks only after Step 1 is done) */}
            {step1Done ? (
              <div className={`border-2 rounded-xl p-4 ${step2Done ? 'border-emerald-200 bg-emerald-50/30' : 'border-blue-300 bg-blue-50/30'}`}>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-bold text-sm flex items-center gap-2">
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-white text-xs ${step2Done ? 'bg-emerald-500' : 'bg-blue-500'}`}>2</span>
                    Step 2 — Resolution
                  </h4>
                  {step2Done && <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-100 text-emerald-700">RESOLVED</span>}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Field label="Assigned To (resolver)">
                    <input list="cmpEngDL3" value={viewing.step2_assigned_to||''} onChange={e=>setViewing({...viewing, step2_assigned_to:e.target.value})} className="inp" placeholder="Technician / engineer name" /><datalist id="cmpEngDL3">{engineers.map(u => <option key={u.id} value={u.name} />)}</datalist>
                  </Field>
                  <Field label="Planned Date">
                    <input type="date" value={viewing.step2_planned_date||''} onChange={e=>setViewing({...viewing, step2_planned_date:e.target.value})} className="inp" />
                  </Field>
                  <Field label="Actual Resolution Date">
                    <input type="date" value={viewing.step2_actual_date||''} onChange={e=>setViewing({...viewing, step2_actual_date:e.target.value})} className="inp" />
                  </Field>
                  <Field label="Time Delay (auto)">
                    <input disabled value={`${viewing.step2_time_delay ?? 0} day(s)`} className="inp bg-slate-50" />
                  </Field>
                  <Field label="Status">
                    <select value={viewing.status||'open'} onChange={e=>setViewing({...viewing, status:e.target.value})} className="inp">
                      <option value="open">Open</option>
                      <option value="in_progress">In Progress</option>
                      <option value="resolved">Resolved</option>
                      <option value="closed">Closed</option>
                    </select>
                  </Field>
                  <div className="md:col-span-2">
                    <Field label="Service Report *">
                      <textarea rows="3" value={viewing.service_report||''} onChange={e=>setViewing({...viewing, service_report:e.target.value})} className="inp" placeholder="What was done to resolve the complaint" />
                    </Field>
                  </div>
                </div>
              </div>
            ) : (
              <div className="border-2 border-dashed border-gray-200 rounded-xl p-4 bg-gray-50 text-center">
                <div className="flex items-center justify-center gap-2 mb-1">
                  <span className="w-6 h-6 rounded-full flex items-center justify-center bg-gray-300 text-white text-xs">2</span>
                  <h4 className="font-bold text-sm text-gray-400">Step 2 — Resolution</h4>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-gray-200 text-gray-500">LOCKED</span>
                </div>
                <p className="text-xs text-gray-500">Complete Step 1 above first — once the complaint is assigned, this section will unlock for the resolver.</p>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button onClick={() => setViewing(null)} className="px-4 py-2 border rounded-lg text-sm">Close</button>
              <button onClick={save} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm">Save</button>
            </div>
          </div>
        </Modal>
        );
      })()}

      {/* Register-success banner — surfaces a click-to-send WhatsApp link
          to the client so mam can immediately fire the registration
          acknowledgement.  Mam (2026-05-21). */}
      {registerAck && (
        <div className="fixed bottom-5 right-5 z-50 bg-white border-2 border-emerald-500 rounded-xl shadow-2xl p-4 max-w-md">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div>
              <div className="text-sm font-bold text-emerald-700 flex items-center gap-1.5"><FiMessageSquare /> Send registration ack</div>
              <div className="text-xs text-gray-500 mt-0.5">{registerAck.complaint_number} → {registerAck.phone}</div>
            </div>
            <button onClick={() => setRegisterAck(null)} className="text-gray-400 hover:text-gray-700">✕</button>
          </div>
          <div className="text-[11px] text-gray-700 bg-gray-50 border rounded p-2 max-h-32 overflow-y-auto whitespace-pre-wrap font-mono">{registerAck.message}</div>
          <div className="flex justify-end gap-2 mt-2">
            <button onClick={() => setRegisterAck(null)} className="px-3 py-1.5 text-xs border rounded-lg">Skip</button>
            <a href={registerAck.link} target="_blank" rel="noreferrer" onClick={sendRegisterAck} className="px-3 py-1.5 text-xs bg-emerald-600 text-white rounded-lg flex items-center gap-1 hover:bg-emerald-700">
              <FiSend size={12} /> Open WhatsApp
            </a>
          </div>
        </div>
      )}

      {/* OTP / WhatsApp Center — assign engineer + push OTP + verify */}
      {otpCenter && (
        <Modal onClose={() => setOtpCenter(null)} title={`WhatsApp / OTP · ${otpCenter.complaint_number}`}>
          <OtpCenter
            complaint={otpCenter}
            engineers={engineers}
            assignResult={assignResult}
            otpEntry={otpEntry}
            setOtpEntry={setOtpEntry}
            onAssign={assignEngineer}
            onSendWa={sendWhatsapp}
            onVerify={verifyOtp}
            onResend={resendOtp}
            onClose={() => setOtpCenter(null)}
          />
        </Modal>
      )}

      <style>{`.inp{width:100%;border:1px solid #e5e7eb;border-radius:0.5rem;padding:0.5rem 0.75rem;font-size:0.875rem}`}</style>
    </div>
  );
}

// ── OTP / WhatsApp Center modal contents ──────────────────────────
// Three states based on the complaint:
//   1. Not yet assigned       → engineer picker
//   2. Assigned, OTP pending  → 2 WhatsApp buttons + OTP entry
//   3. Already resolved       → "Already resolved" view
function OtpCenter({ complaint, engineers, assignResult, otpEntry, setOtpEntry, onAssign, onSendWa, onVerify, onResend, onClose }) {
  const hasEng = !!complaint.assigned_engineer_id || !!assignResult;
  const eng = assignResult?.engineer || (complaint.assigned_engineer_id ? {
    name: complaint.assigned_engineer_name || complaint.step1_assigned_to,
    phone: complaint.assigned_engineer_phone,
  } : null);
  const otp = assignResult?.otp || (complaint.resolution_otp ? '••••' : null);

  if (!hasEng) {
    // Stage 1 — pick the engineer
    return (
      <div className="space-y-3">
        <div className="bg-amber-50 border border-amber-200 rounded p-2.5 text-xs text-amber-800">
          <b>Step 1 — Assign Engineer.</b> When you pick someone, the system generates a 4-digit OTP, builds two WhatsApp messages (one to the engineer with the job details, one to the client with the engineer's contact + OTP), and surfaces both as click-to-send links on the next screen.
        </div>
        <div>
          <label className="text-xs font-semibold text-gray-600">Pick engineer</label>
          <select className="inp mt-1" onChange={e => e.target.value && onAssign(+e.target.value)} defaultValue="">
            <option value="" disabled>— Select —</option>
            {engineers.map(u => (
              <option key={u.id} value={u.id}>
                {u.name}{u.phone ? ` · ${u.phone}` : ''}{u.department ? ` · ${u.department}` : ''}
              </option>
            ))}
          </select>
          {engineers.length === 0 && (
            <div className="text-[11px] text-gray-500 mt-1">No engineers loaded — you may need admin access to /users.</div>
          )}
        </div>
      </div>
    );
  }

  // Stage 2 — WhatsApp send + OTP verify
  return (
    <div className="space-y-3">
      <div className="bg-blue-50 border border-blue-200 rounded p-2.5 text-xs text-blue-800">
        <b>Engineer:</b> {eng?.name}{eng?.phone ? ` · ${eng.phone}` : ''}<br />
        <b>Client OTP:</b> {assignResult?.otp ? <span className="font-mono text-emerald-700 text-base">{assignResult.otp}</span> : <span className="italic">already generated · ask admin to resend if needed</span>}
        <div className="text-[10px] text-blue-600 mt-1">(The engineer must obtain this 4-digit code from the client after the work is complete.)</div>
      </div>

      {/* Two WhatsApp send buttons */}
      {assignResult?.engineer?.whatsapp?.link && (
        <a href={assignResult.engineer.whatsapp.link} target="_blank" rel="noreferrer"
           onClick={() => onSendWa(assignResult.engineer.whatsapp.link, 'engineer_assign')}
           className="flex items-center justify-between gap-2 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100">
          <span className="text-sm font-medium text-emerald-800 flex items-center gap-2"><FiSend size={14} /> Open WhatsApp · {eng?.name} ({assignResult.engineer.whatsapp.phone})</span>
          <span className="text-[10px] text-emerald-700">Job details (no OTP)</span>
        </a>
      )}
      {assignResult?.client?.whatsapp?.link && (
        <a href={assignResult.client.whatsapp.link} target="_blank" rel="noreferrer"
           onClick={() => onSendWa(assignResult.client.whatsapp.link, 'client_assign')}
           className="flex items-center justify-between gap-2 px-3 py-2 bg-amber-50 border border-amber-300 rounded-lg hover:bg-amber-100">
          <span className="text-sm font-medium text-amber-800 flex items-center gap-2"><FiSend size={14} /> Open WhatsApp · client ({assignResult.client.whatsapp.phone})</span>
          <span className="text-[10px] text-amber-700">Engineer contact + OTP</span>
        </a>
      )}

      {/* OTP entry */}
      <div className="border-t pt-3">
        <div className="text-xs font-semibold text-gray-700 mb-1.5">Verify OTP to resolve</div>
        <div className="flex gap-2">
          <input
            type="text"
            inputMode="numeric"
            pattern="\d{4}"
            maxLength={4}
            value={otpEntry}
            onChange={e => setOtpEntry(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="4-digit code"
            className="inp text-center text-lg tracking-[0.4em] font-mono"
          />
          <button onClick={onVerify} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm flex items-center gap-1.5"><FiKey size={14} /> Verify</button>
        </div>
        <div className="flex justify-between items-center mt-2">
          <button onClick={onResend} className="text-[11px] text-amber-700 hover:text-amber-900 underline">
            Regenerate OTP &amp; re-send to client
          </button>
          <button onClick={onClose} className="text-[11px] text-gray-500 hover:text-gray-800">Close</button>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, color }) {
  const map = { slate:'text-slate-600 bg-slate-100', yellow:'text-yellow-600 bg-yellow-100', blue:'text-red-600 bg-red-100', green:'text-green-600 bg-green-100' };
  return (
    <div className="bg-white rounded-xl p-4 border flex items-center gap-3">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${map[color]}`}>{icon}</div>
      <div>
        <div className="text-xs text-gray-500">{label}</div>
        <div className="text-xl font-bold text-gray-800">{value}</div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (<div><label className="text-xs font-semibold text-gray-600 block mb-1">{label}</label>{children}</div>);
}

function Section({ title, children }) {
  return (
    <div className="border rounded-xl p-4">
      <div className="text-sm font-bold text-gray-700 mb-3 pb-2 border-b">{title}</div>
      {children}
    </div>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center px-5 py-3 border-b sticky top-0 bg-white">
          <div className="font-bold text-gray-800">{title}</div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">✕</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}