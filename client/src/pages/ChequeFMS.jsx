import { useEffect, useState, useMemo } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import ResponsibilityTab from '../components/ResponsibilityTab';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiEdit2, FiTrash2, FiClock, FiCheck, FiAlertTriangle, FiPaperclip, FiEye, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { fmtDateTime } from '../utils/datetime';
import { useUrlTab } from '../hooks/useUrlTab';

// Cheque FMS — 3-stage cheque workflow.
//   Stage 1: raise/issue a cheque (this page's "+ Issue Cheque" button)
//   Stage 2: on/after cheque_date → log an action (clear/hold/bounce/stopped)
//   Stage 3: on/after hold_until (for held cheques) → log a follow-up action
// Mam's spec: "stage 1 given cheque date according to that date need
// stage 2 action , same as hold date give in stage 2".

const BANKS = ['HDFC', 'ICICI', 'SBI', 'PNB CC', 'PNB Saving', 'Other'];

// Pretty status badge — colour-coded so the list scans fast.
function StatusBadge({ status, dueDate }) {
  const map = {
    pending: 'bg-yellow-100 text-yellow-800 border-yellow-300',
    clear: 'bg-emerald-100 text-emerald-700 border-emerald-300',
    hold: 'bg-amber-100 text-amber-800 border-amber-300',
    bounce: 'bg-red-100 text-red-700 border-red-300',
    stopped: 'bg-gray-200 text-gray-700 border-gray-300',
    cancel: 'bg-gray-100 text-gray-500 border-gray-200',
  };
  return (
    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${map[status] || ''}`}>
      {status}{dueDate ? ` · ${dueDate}` : ''}
    </span>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

export default function ChequeFMS() {
  const { canCreate, canEdit, canDelete } = useAuth();
  // Tab persisted in URL ?tab=... so a refresh keeps the user where
  // they were (mam 2026-05-28: "when i refresh it it goes on first").
  const [tab, setTab] = useUrlTab(
    ['action_due', 'pending', 'hold', 'clear', 'bounce', 'all', 'responsible'],
    'action_due',
  );
  const [cheques, setCheques] = useState([]);
  const [stats, setStats] = useState({ by_status: [], action_due_count: 0 });
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');   // cheque-date range filter (from)
  const [dateTo, setDateTo] = useState('');       // cheque-date range filter (to)

  const [modal, setModal] = useState(null); // 'issue' | 'edit' | 'action' | 'view'
  const [form, setForm] = useState({});
  const [actionForm, setActionForm] = useState({ action: '', remarks: '', next_date: '' });
  const [selected, setSelected] = useState(null);
  const [history, setHistory] = useState([]);
  const [vendors, setVendors] = useState([]);

  const load = () => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (tab === 'action_due') params.set('action_due', '1');
    else if (tab !== 'all') params.set('status', tab);
    api.get(`/cheques?${params}`).then(r => setCheques(r.data || [])).catch(() => setCheques([]));
    api.get('/cheques/stats/summary').then(r => setStats(r.data || { by_status: [], action_due_count: 0 })).catch(() => {});
  };
  useEffect(load, [tab, search]);
  // Vendor suggestions for the Payee field (mam 2026-06-15 automation).
  useEffect(() => { api.get('/procurement/vendors').then(r => setVendors(r.data || [])).catch(() => {}); }, []);

  // STAGE 1 — open the issue modal with sensible defaults.
  const openIssue = () => {
    setSelected(null);
    setForm({
      cheque_number: '',
      payee_to: '',
      bank_name: 'HDFC',
      bank_other: '',
      cheque_date: today(),
      amount: '',
      issue_status: 'approved',
      photo: null,
    });
    setModal('issue');
  };

  const openEdit = (c) => {
    setSelected(c);
    setForm({
      cheque_number: c.cheque_number,
      payee_to: c.payee_to,
      bank_name: c.bank_name || 'HDFC',
      bank_other: c.bank_other || '',
      cheque_date: c.cheque_date,
      amount: c.amount || '',
      issue_status: c.issue_status || 'approved',
      photo: null,
    });
    setModal('edit');
  };

  // STAGE 2 / 3 — both use the same action modal.
  const openAction = (c) => {
    setSelected(c);
    setActionForm({ action: '', remarks: '', next_date: '' });
    setModal('action');
  };

  const openView = (c) => {
    setSelected(c);
    api.get(`/cheques/${c.id}`).then(r => setHistory(r.data?.actions || []));
    setModal('view');
  };

  const saveIssue = async (e) => {
    e.preventDefault();
    if (!form.cheque_number || !form.cheque_number.trim()) return toast.error('Cheque Number is required');
    if (!form.payee_to || !form.payee_to.trim()) return toast.error('Payee To is required');
    if (!form.cheque_date) return toast.error('Cheque Date is required');
    const fd = new FormData();
    fd.append('cheque_number', form.cheque_number.trim());
    fd.append('payee_to', form.payee_to.trim());
    fd.append('bank_name', form.bank_name || '');
    if (form.bank_name === 'Other') fd.append('bank_other', form.bank_other || '');
    fd.append('cheque_date', form.cheque_date);
    fd.append('amount', form.amount || 0);
    fd.append('issue_status', form.issue_status || 'approved');
    if (form.photo) fd.append('photo', form.photo);
    try {
      if (modal === 'edit' && selected) {
        await api.put(`/cheques/${selected.id}`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        toast.success('Cheque updated');
      } else {
        await api.post('/cheques', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        toast.success('Cheque issued');
      }
      setModal(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const saveAction = async (e) => {
    e.preventDefault();
    if (!actionForm.action) return toast.error('Pick an action');
    if (!actionForm.remarks || !actionForm.remarks.trim()) return toast.error('Remarks are required');
    if (actionForm.action === 'hold' && !actionForm.next_date) return toast.error('Hold action needs a next date');
    try {
      await api.post(`/cheques/${selected.id}/action`, actionForm);
      toast.success('Action logged');
      setModal(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const remove = async (c) => {
    if (!window.confirm(`Delete cheque ${c.cheque_number}? Only allowed when no action has been logged.`)) return;
    try { await api.delete(`/cheques/${c.id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Client-side cheque-date range filter. cheque_date is an ISO 'YYYY-MM-DD'
  // string, so a plain string compare gives a correct date range.
  const visible = useMemo(() => {
    if (!dateFrom && !dateTo) return cheques;
    return cheques.filter(c => {
      const d = c.cheque_date || '';
      if (dateFrom && d < dateFrom) return false;
      if (dateTo && d > dateTo) return false;
      return true;
    });
  }, [cheques, dateFrom, dateTo]);

  const counts = useMemo(() => {
    const m = { pending: 0, clear: 0, hold: 0, bounce: 0, stopped: 0, cancel: 0 };
    // Parallel amount-sum map so the Total Value tile can switch
    // per tab (mam, 2026-05-21: "both same total value why").
    const amt = { pending: 0, clear: 0, hold: 0, bounce: 0, stopped: 0, cancel: 0 };
    let totalAmount = 0;
    for (const row of stats.by_status) {
      m[row.current_status] = row.count;
      amt[row.current_status] = +row.total_amount || 0;
      totalAmount += +row.total_amount || 0;
    }
    return { m, amt, totalAmount };
  }, [stats]);

  // Total Value shown in the KPI tile — recomputes when the active
  // tab changes so the headline number actually matches what's in
  // the list below it.
  const tabTotalValue = (() => {
    switch (tab) {
      case 'action_due': return +stats.action_due_total_amount || 0;
      case 'pending':    return counts.amt.pending;
      case 'hold':       return counts.amt.hold;
      case 'clear':      return counts.amt.clear;
      case 'bounce':     return counts.amt.bounce;
      default:           return counts.totalAmount;  // 'all'
    }
  })();

  const tabs = [
    { id: 'action_due', label: 'Action Due', count: stats.action_due_count, color: 'red' },
    { id: 'pending', label: 'Pending Issue', count: counts.m.pending, color: 'yellow' },
    { id: 'hold', label: 'On Hold', count: counts.m.hold, color: 'amber' },
    { id: 'clear', label: 'Cleared', count: counts.m.clear, color: 'emerald' },
    { id: 'bounce', label: 'Bounced', count: counts.m.bounce, color: 'red' },
    { id: 'all', label: 'All', count: null, color: 'gray' },
    { id: 'responsible', label: '⚙ Responsible', count: null, color: 'gray' },
  ];

  return (
    <div className="space-y-4">
      <div className="sticky-toolbar">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div>
            <h3 className="text-xl font-bold text-gray-800">Cheque FMS</h3>
            <p className="text-sm text-gray-500">
              Issue a cheque, then log its outcome (clear / hold / bounce / stopped) once the cheque date arrives. Hold cheques get a follow-up action on the next date.
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => exportCsv('cheques',
              ['Cheque #','Payee','Bank','Date','Amount','Status','Hold Until','Raised By'],
              visible.map(c => [c.cheque_number, c.payee_to, c.bank_name || c.bank_other, c.cheque_date, c.amount, c.current_status, c.hold_until, c.raised_by_name]))}
              className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload /> Export Excel</button>
            {canCreate('cheques') && (
              <button onClick={openIssue} className="btn btn-primary flex items-center gap-2 justify-center">
                <FiPlus /> Issue Cheque
              </button>
            )}
          </div>
        </div>

        {/* Tabs / counts — royal-blue active state (mam, 2026-05-21:
            "actual due also why red ???").  Red previously, swept to
            brand blue. */}
        <div className="flex gap-2 flex-wrap">
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${tab === t.id
                ? `bg-blue-800 text-white border-blue-800`
                : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300 hover:text-blue-700'}`}>
              {t.label}{t.count != null ? ` (${t.count})` : ''}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input text-sm flex-1 min-w-[200px]"
            placeholder="Search cheque no, payee, bank…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {/* Cheque-date range filter (mam 2026-06-22: "need date filter from to") */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] font-semibold text-gray-500 uppercase">From</label>
            <input type="date" className="input text-sm w-[150px]" value={dateFrom} max={dateTo || undefined} onChange={e => setDateFrom(e.target.value)} />
            <label className="text-[11px] font-semibold text-gray-500 uppercase">To</label>
            <input type="date" className="input text-sm w-[150px]" value={dateTo} min={dateFrom || undefined} onChange={e => setDateTo(e.target.value)} />
            {(dateFrom || dateTo) && (
              <button onClick={() => { setDateFrom(''); setDateTo(''); }} className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50">Clear</button>
            )}
          </div>
        </div>

        {/* Stats cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="card p-3"><div className="text-[10px] uppercase text-gray-500">Action Due</div><div className="text-xl font-bold text-blue-800">{stats.action_due_count}</div></div>
          <div className="card p-3"><div className="text-[10px] uppercase text-gray-500">On Hold</div><div className="text-xl font-bold text-amber-700">{counts.m.hold}</div></div>
          <div className="card p-3"><div className="text-[10px] uppercase text-gray-500">Cleared</div><div className="text-xl font-bold text-emerald-700">{counts.m.clear}</div></div>
          <div className="card p-3">
            <div className="text-[10px] uppercase text-gray-500">
              Total Value
              <span className="ml-1 text-gray-400 font-normal normal-case text-[10px]">
                ({tabs.find(t => t.id === tab)?.label || 'All'})
              </span>
            </div>
            <div className="text-base font-bold text-blue-800">Rs {tabTotalValue.toLocaleString('en-IN')}</div>
          </div>
        </div>
      </div>

      {tab === 'responsible' && <ResponsibilityTab module="cheques" title="Cheques" />}

      {/* List */}
      {tab !== 'responsible' && (
      <div className="card p-0">
        <table className="w-full text-xs freeze-head">
          <thead className="bg-gray-50 text-gray-600 uppercase">
            <tr>
              <th className="px-2 py-2 text-left">Cheque #</th>
              <th className="px-2 py-2 text-left">Payee</th>
              <th className="px-2 py-2 text-left">Bank</th>
              <th className="px-2 py-2 text-right">Date</th>
              <th className="px-2 py-2 text-right">Amount</th>
              <th className="px-2 py-2 text-center">Status</th>
              <th className="px-2 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && <tr><td colSpan="7" className="text-center py-8 text-gray-400">{(dateFrom || dateTo) ? 'No cheques in this date range' : 'No cheques in this tab'}</td></tr>}
            {visible.map(c => {
              const due = c.action_due === 1;
              return (
                <tr key={c.id} className={`border-b ${due ? 'bg-red-50/40' : ''}`}>
                  <td className="px-2 py-1.5 font-mono">{c.cheque_number}</td>
                  <td className="px-2 py-1.5">{c.payee_to}</td>
                  <td className="px-2 py-1.5">{c.bank_name === 'Other' ? c.bank_other : c.bank_name}</td>
                  <td className="px-2 py-1.5 text-right">{c.cheque_date}</td>
                  <td className="px-2 py-1.5 text-right font-semibold">Rs {(+c.amount || 0).toLocaleString('en-IN')}</td>
                  <td className="px-2 py-1.5 text-center">
                    <StatusBadge status={c.current_status} dueDate={c.current_status === 'hold' ? c.hold_until : null} />
                    {due && <div className="text-[9px] text-red-600 font-bold mt-0.5 flex items-center justify-center gap-0.5"><FiAlertTriangle size={9} /> ACTION DUE</div>}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <div className="inline-flex gap-1">
                      <button onClick={() => openView(c)} className="text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50" title="View history"><FiEye size={11} /></button>
                      {c.photo_url && <a href={c.photo_url} target="_blank" rel="noreferrer" className="text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50" title="Open cheque photo"><FiPaperclip size={11} /></a>}
                      {canEdit('cheques') && c.action_count === 0 && (
                        <button onClick={() => openEdit(c)} className="text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50" title="Edit details"><FiEdit2 size={11} /></button>
                      )}
                      {canEdit('cheques') && !['clear', 'bounce', 'stopped', 'cancel'].includes(c.current_status) && (
                        <button onClick={() => openAction(c)} className="text-[10px] px-2 py-0.5 rounded bg-blue-800 text-white hover:bg-blue-900 inline-flex items-center gap-1">
                          {c.current_status === 'hold' ? <><FiClock size={10} />Hold Action</> : <><FiCheck size={10} />Take Action</>}
                        </button>
                      )}
                      {canDelete('cheques') && c.action_count === 0 && (
                        <button onClick={() => remove(c)} className="text-xs px-2 py-0.5 rounded border border-red-300 text-red-700 hover:bg-red-50" title="Delete"><FiTrash2 size={11} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}

      {/* STAGE 1 — Issue / Edit modal */}
      <Modal isOpen={modal === 'issue' || modal === 'edit'} onClose={() => setModal(null)} title={modal === 'edit' ? 'Edit Cheque Details' : 'Issue Cheque'}>
        <form onSubmit={saveIssue} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><label className="label">Cheque Number *</label><input className="input" value={form.cheque_number || ''} onChange={e => setForm({ ...form, cheque_number: e.target.value })} required /></div>
            <div><label className="label">Payee To *</label><input className="input" list="chqVendorsDL" value={form.payee_to || ''} onChange={e => setForm({ ...form, payee_to: e.target.value })} placeholder="Pick vendor or type" required /><datalist id="chqVendorsDL">{vendors.map(v => <option key={v.id} value={v.name} />)}</datalist></div>
            <div>
              <label className="label">Bank Name *</label>
              <select className="select" value={form.bank_name || ''} onChange={e => setForm({ ...form, bank_name: e.target.value })} required>
                {BANKS.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
            {form.bank_name === 'Other' && (
              <div><label className="label">Other Bank Name</label><input className="input" value={form.bank_other || ''} onChange={e => setForm({ ...form, bank_other: e.target.value })} /></div>
            )}
            <div><label className="label">Cheque Date *</label><input className="input" type="date" value={form.cheque_date || ''} onChange={e => setForm({ ...form, cheque_date: e.target.value })} required /></div>
            <div><label className="label">Amount (Rs) *</label><input className="input" type="number" step="0.01" min="0" value={form.amount || ''} onChange={e => setForm({ ...form, amount: e.target.value })} required /></div>
            <div className="sm:col-span-2">
              <label className="label">Cheque Photo</label>
              <input className="input" type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={e => setForm({ ...form, photo: e.target.files?.[0] || null })} />
              {form.photo && <p className="text-[10px] text-emerald-600 mt-0.5">Selected: {form.photo.name}</p>}
            </div>
            <div className="sm:col-span-2">
              <label className="label">Status</label>
              <div className="flex gap-3">
                <label className="flex items-center gap-1.5 text-sm"><input type="radio" name="iss" value="approved" checked={form.issue_status === 'approved'} onChange={() => setForm({ ...form, issue_status: 'approved' })} /> Approved</label>
                <label className="flex items-center gap-1.5 text-sm"><input type="radio" name="iss" value="cancel" checked={form.issue_status === 'cancel'} onChange={() => setForm({ ...form, issue_status: 'cancel' })} /> Cancel</label>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2"><button type="button" onClick={() => setModal(null)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">{modal === 'edit' ? 'Save Changes' : 'Issue Cheque'}</button></div>
        </form>
      </Modal>

      {/* STAGE 2 / 3 — Action modal (clear / hold / bounce / stopped). */}
      <Modal isOpen={modal === 'action'} onClose={() => setModal(null)} title={selected ? `Log Action — ${selected.cheque_number} · Rs ${(+selected.amount || 0).toLocaleString('en-IN')}` : 'Log Action'}>
        <form onSubmit={saveAction} className="space-y-3">
          {selected && (
            <div className="bg-gray-50 border border-gray-200 rounded p-2.5 text-xs space-y-0.5">
              <div><b>Payee:</b> {selected.payee_to}</div>
              <div><b>Bank:</b> {selected.bank_name === 'Other' ? selected.bank_other : selected.bank_name}</div>
              <div><b>Cheque Date:</b> {selected.cheque_date}</div>
              {selected.current_status === 'hold' && (
                <div className="text-amber-700 font-semibold"><b>On hold until:</b> {selected.hold_until || '—'}</div>
              )}
              <div><b>Current status:</b> <StatusBadge status={selected.current_status} /></div>
            </div>
          )}
          <div>
            <label className="label">Action *</label>
            <select className="select" value={actionForm.action} onChange={e => setActionForm({ ...actionForm, action: e.target.value })} required>
              <option value="">-- Pick an action --</option>
              <option value="clear">Clear (cheque cleared at bank)</option>
              {/* Hold is only valid out of "pending" — once it's already hold,
                  the next move should be clear / bounce / stopped. */}
              {selected?.current_status === 'pending' && <option value="hold">Hold (defer to a later date)</option>}
              <option value="bounce">Bounce</option>
              <option value="stopped">Stopped (stop-payment)</option>
              {selected?.current_status === 'hold' && <option value="re_issue">Re-Issue (back to pending)</option>}
            </select>
          </div>
          {actionForm.action === 'hold' && (
            <div>
              <label className="label">Next Date *</label>
              <input className="input" type="date" min={today()} value={actionForm.next_date} onChange={e => setActionForm({ ...actionForm, next_date: e.target.value })} required />
              <p className="text-[10px] text-amber-700 mt-0.5">Cheque will move to On Hold. Action will be due again on this date.</p>
            </div>
          )}
          <div>
            <label className="label">Remarks *</label>
            <textarea className="input" rows="3" value={actionForm.remarks} onChange={e => setActionForm({ ...actionForm, remarks: e.target.value })} placeholder={actionForm.action === 'bounce' ? 'Reason for bounce (insufficient funds, signature mismatch, etc.)' : actionForm.action === 'hold' ? 'Why are we holding it?' : 'Any context for this action'} required />
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(null)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Log Action</button></div>
        </form>
      </Modal>

      {/* History viewer */}
      <Modal isOpen={modal === 'view'} onClose={() => setModal(null)} title={selected ? `Cheque ${selected.cheque_number} — Action History` : 'History'}>
        {selected && (
          <div className="space-y-3">
            <div className="bg-gray-50 border border-gray-200 rounded p-2.5 text-xs grid grid-cols-2 gap-1">
              <div><b>Payee:</b> {selected.payee_to}</div>
              <div><b>Bank:</b> {selected.bank_name === 'Other' ? selected.bank_other : selected.bank_name}</div>
              <div><b>Cheque Date:</b> {selected.cheque_date}</div>
              <div><b>Amount:</b> Rs {(+selected.amount || 0).toLocaleString('en-IN')}</div>
              <div className="col-span-2"><b>Current:</b> <StatusBadge status={selected.current_status} dueDate={selected.current_status === 'hold' ? selected.hold_until : null} /></div>
            </div>
            <h5 className="font-semibold text-sm text-gray-700">Action Trail</h5>
            {history.length === 0 ? (
              <p className="text-xs text-gray-400 italic">No actions logged yet.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-gray-50"><tr><th className="px-2 py-1 text-left">Date</th><th className="px-2 py-1 text-left">Action</th><th className="px-2 py-1 text-left">Remarks</th><th className="px-2 py-1 text-left">By</th></tr></thead>
                <tbody>
                  {history.map(h => (
                    <tr key={h.id} className="border-b">
                      <td className="px-2 py-1 whitespace-nowrap">{fmtDateTime(h.action_at)}</td>
                      <td className="px-2 py-1"><StatusBadge status={h.action === 're_issue' ? 'pending' : h.action} dueDate={h.next_date} /></td>
                      <td className="px-2 py-1">{h.remarks}</td>
                      <td className="px-2 py-1 text-gray-500">{h.action_by_name || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="flex justify-end"><button onClick={() => setModal(null)} className="btn btn-secondary">Close</button></div>
          </div>
        )}
      </Modal>
    </div>
  );
}
