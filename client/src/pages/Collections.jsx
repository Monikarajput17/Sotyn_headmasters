import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import ResponsibilityTab from '../components/ResponsibilityTab';
import { useUrlTab } from '../hooks/useUrlTab';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiEdit2, FiPhoneCall, FiAlertTriangle, FiRefreshCw, FiTrash2, FiDownload, FiFileText } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { LuIndianRupee } from 'react-icons/lu';

export default function Collections() {
  const { canDelete } = useAuth();
  const [tab, setTab] = useUrlTab('list');
  const [receivables, setReceivables] = useState([]);
  const [summary, setSummary] = useState(null);
  const [targetSummary, setTargetSummary] = useState(null);
  const [users, setUsers] = useState([]);
  const [modal, setModal] = useState(false);
  const [editModal, setEditModal] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [editSaving, setEditSaving] = useState(false);
  const [followUpModal, setFollowUpModal] = useState(false);
  const [collectModal, setCollectModal] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [followUps, setFollowUps] = useState([]);
  const [form, setForm] = useState({});
  const [filter, setFilter] = useState('');

  const [sites, setSites] = useState([]);
  const load = () => {
    api.get('/collections', { params: filter ? { status: filter } : {} }).then(r => setReceivables(r.data));
    api.get('/collections/summary').then(r => setSummary(r.data));
    api.get('/collections/target-summary').then(r => setTargetSummary(r.data)).catch(() => setTargetSummary(null));
    api.get('/collections/sites').then(r => setSites(r.data || [])).catch(() => setSites([]));
    // Mam (2026-05-22): hide inactive ex-employees from the collector picker.
    api.get('/auth/users?active_only=1').then(r => setUsers(r.data));
  };
  useEffect(() => { load(); }, [filter]);

  const createReceivable = async (e) => {
    e.preventDefault();
    // Mam (2026-05-20): "site name is required from business book
    // company name unique".  Hard-require a BB-picked site — free-text
    // fallback (`client_name only`) used to slip through.
    if (!form.site_name || !String(form.site_name).trim()) {
      return toast.error('Pick a site from Business Book (Site Name is mandatory)');
    }
    if (!(+form.invoice_amount > 0)) return toast.error('Target amount must be greater than 0');
    try {
      await api.post('/collections', form);
      toast.success('Receivable added');
      setModal(false);
      setForm({});
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  };

  // Same site-pick → CRM autofill helper as openEdit, but for the Add form.
  const onPickAddSite = (siteOpt) => {
    if (!siteOpt) {
      setForm(f => ({ ...f, site_name: '', site_id: '', client_name: '', crm_name: '' }));
      return;
    }
    setForm(f => ({
      ...f,
      site_name: siteOpt.name,
      site_id: siteOpt.id,
      client_name: siteOpt.name, // keep legacy column populated for old reports
      crm_name: siteOpt.crm_name || f.crm_name,
      invoice_amount: (f.invoice_amount && +f.invoice_amount > 0) ? f.invoice_amount : (siteOpt.latest_po_value || 0),
      invoice_number: f.invoice_number || siteOpt.latest_po_number || '',
    }));
  };

  const addFollowUp = async (e) => {
    e.preventDefault();
    await api.post(`/collections/${selectedId}/follow-up`, form);
    toast.success('Follow-up recorded');
    setFollowUpModal(false); load();
  };

  const recordCollection = async (e) => {
    e.preventDefault();
    const amt = +form.amount;
    if (!amt || amt <= 0) { toast.error('Enter a valid amount greater than 0'); return; }
    await api.post(`/collections/${selectedId}/collect`, form);
    toast.success('Collection recorded & linked to Cash Flow!');
    setCollectModal(false); load();
  };

  const refreshAgeing = async () => {
    await api.post('/collections/refresh-ageing');
    toast.success('Ageing refreshed');
    load();
  };

  const openEdit = (r) => {
    setEditForm({
      site_name: r.site_name || r.client_name || '',
      site_id: r.site_id || '',
      crm_name: r.crm_name || '',
      invoice_amount: r.invoice_amount || 0,    // Target Payment
      invoice_number: r.invoice_number || '',
      invoice_date: r.invoice_date || '',
      due_date: r.due_date || '',
      next_planned_date: r.next_planned_date || '',
      last_discussion: r.last_discussion || '',
      owner_id: r.owner_id || '',
    });
    setEditModal(r);
  };

  // When mam picks a site, auto-fill CRM + suggest target payment from
  // the latest PO of that site. She can still override the amount.
  const onPickSite = (siteOpt) => {
    if (!siteOpt) {
      setEditForm(f => ({ ...f, site_name: '', site_id: '', crm_name: '' }));
      return;
    }
    setEditForm(f => ({
      ...f,
      site_name: siteOpt.name,
      site_id: siteOpt.id,
      crm_name: siteOpt.crm_name || f.crm_name,
      // Only suggest the PO value if mam hasn't entered an amount yet —
      // otherwise we don't overwrite her PDF-driven number.
      invoice_amount: (f.invoice_amount && +f.invoice_amount > 0)
        ? f.invoice_amount
        : (siteOpt.latest_po_value || 0),
      invoice_number: f.invoice_number || siteOpt.latest_po_number || '',
    }));
  };
  const saveEdit = async (e) => {
    e.preventDefault();
    // v2: site_name (project from BB) is the primary identifier. Keep
    // client_name in sync so existing reports / search keep working.
    if (!editForm.site_name || !String(editForm.site_name).trim()) return toast.error('Site name required');
    if (!(+editForm.invoice_amount > 0)) return toast.error('Target amount must be greater than 0');
    setEditSaving(true);
    try {
      const payload = { ...editForm, client_name: editForm.site_name };
      await api.put(`/collections/${editModal.id}`, payload);
      toast.success('Receivable updated');
      setEditModal(null); setEditForm({}); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update');
    }
    setEditSaving(false);
  };

  const openFollowUps = async (id) => {
    setSelectedId(id);
    const { data } = await api.get(`/collections/${id}/follow-ups`);
    setFollowUps(data);
    setForm({ follow_up_date: new Date().toISOString().split('T')[0], contact_method: 'call', response: '', promised_date: '', promised_amount: 0 });
    setFollowUpModal(true);
  };

  const statusBg = { green: 'bg-emerald-100 text-emerald-800 border-emerald-300', yellow: 'bg-amber-100 text-amber-800 border-amber-300', red: 'bg-red-100 text-red-800 border-red-300' };

  if (!summary) return <div className="text-center py-10">Loading...</div>;

  return (
    <div className="space-y-6">
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setTab('list')} className={`btn ${tab === 'responsible' ? 'btn-secondary' : 'btn-primary'}`}>Receivables</button>
        <button onClick={() => setTab('responsible')} className={`btn ${tab === 'responsible' ? 'btn-primary' : 'btn-secondary'}`}>⚙ Responsible</button>
      </div>
      {tab === 'responsible' ? (
        <ResponsibilityTab module="collections" title="Collections (Receivables)" />
      ) : (
      <>
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="card text-center border-l-4 border-red-500">
          <div className="text-3xl font-bold text-red-600">Rs {(summary.totalOutstanding / 100000).toFixed(2)}L</div>
          <div className="text-sm text-gray-500">Total Outstanding</div>
        </div>
        {summary.byBucket.map(b => (
          <div key={b.ageing_bucket} className="card text-center">
            <div className="text-2xl font-bold text-gray-800">Rs {(b.total / 100000).toFixed(2)}L</div>
            <div className="text-sm text-gray-500">{b.ageing_bucket} Days ({b.count})</div>
          </div>
        ))}
        <div className="card text-center border-l-4 border-amber-500">
          <div className="text-2xl font-bold text-amber-600">Rs {(summary.overdue.total / 100000).toFixed(2)}L</div>
          <div className="text-sm text-gray-500">Overdue ({summary.overdue.count})</div>
        </div>
      </div>

      {/* Filters & Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          {['', 'red', 'yellow', 'green'].map(s => (
            <button key={s} onClick={() => setFilter(s)} className={`btn text-xs ${filter === s ? 'btn-primary' : 'btn-secondary'}`}>
              {s === '' ? 'All' : s === 'red' ? '🔴 Red' : s === 'yellow' ? '🟡 Yellow' : '🟢 Green'}
            </button>
          ))}
          <button onClick={refreshAgeing} className="btn btn-secondary text-xs flex items-center gap-1"><FiRefreshCw size={12} /> Refresh Ageing</button>
        </div>
        <div className="flex gap-2">
          <button onClick={() => exportCsv('receivables',
            ['Client','Project','Invoice #','Invoice Date','Invoice Amount','Received','Outstanding','Due Date','Ageing','Bucket','Status','Follow-up Status','Owner'],
            receivables.map(r => [r.client_name, r.project_name, r.invoice_number, r.invoice_date, r.invoice_amount, r.received_amount, r.outstanding_amount, r.due_date, r.ageing_days, r.ageing_bucket, r.status, r.follow_up_status, r.owner_name]))}
            className="btn btn-secondary flex items-center gap-2"><FiDownload /> Export Excel</button>
          <button onClick={() => { setForm({ client_name: '', project_name: '', invoice_number: '', invoice_date: '', invoice_amount: 0, due_date: '', owner_id: '' }); setModal(true); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Receivable</button>
        </div>
      </div>

      {/* Payment Target vs Received (with Ageing) — top-line numbers
          plus a per-bucket breakdown so mam can see where collection is
          lagging. */}
      {targetSummary && (
        <div className="card p-0 overflow-hidden">
          <div className="px-4 py-3 border-b bg-gradient-to-r from-blue-50 to-white">
            <h4 className="font-semibold text-gray-700">Payment Target vs Received <span className="text-xs text-gray-400 font-normal">(with ageing)</span></h4>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 p-4">
            <div className="card p-3 border-l-4 border-blue-500">
              <div className="text-[10px] uppercase text-gray-500 font-semibold">Target (Total Invoiced)</div>
              <div className="text-2xl font-bold text-gray-800 mt-0.5">Rs {(targetSummary.overall.target / 100000).toFixed(2)}L</div>
              <div className="text-[10px] text-gray-400">{targetSummary.overall.count} invoices</div>
            </div>
            <div className="card p-3 border-l-4 border-emerald-500">
              <div className="text-[10px] uppercase text-gray-500 font-semibold">Received</div>
              <div className="text-2xl font-bold text-emerald-700 mt-0.5">Rs {(targetSummary.overall.received / 100000).toFixed(2)}L</div>
              <div className="text-[10px] text-gray-400">cleared so far</div>
            </div>
            <div className="card p-3 border-l-4 border-red-500">
              <div className="text-[10px] uppercase text-gray-500 font-semibold">Outstanding</div>
              <div className="text-2xl font-bold text-red-700 mt-0.5">Rs {(targetSummary.overall.outstanding / 100000).toFixed(2)}L</div>
              <div className="text-[10px] text-gray-400">still to collect</div>
            </div>
            <div className="card p-3 border-l-4 border-amber-500">
              <div className="text-[10px] uppercase text-gray-500 font-semibold">Collection %</div>
              <div className="text-2xl font-bold text-amber-700 mt-0.5">{targetSummary.overall.collection_pct}%</div>
              <div className="text-[10px] text-gray-400">received vs target</div>
            </div>
          </div>
          {targetSummary.by_bucket.length > 0 && (
            <div className="overflow-x-auto border-t">
              <table className="text-sm w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Ageing Bucket</th>
                    <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Invoices</th>
                    <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Target</th>
                    <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Received</th>
                    <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Outstanding</th>
                    <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Collection %</th>
                  </tr>
                </thead>
                <tbody>
                  {targetSummary.by_bucket.map(b => (
                    <tr key={b.ageing_bucket} className={`border-t ${b.ageing_bucket === '90+' ? 'bg-red-50/40' : b.ageing_bucket === '60-90' ? 'bg-amber-50/30' : ''}`}>
                      <td className="px-3 py-2 font-medium text-gray-800">
                        <span className={`px-2 py-0.5 rounded text-[11px] ${b.ageing_bucket === '0-30' ? 'bg-emerald-100 text-emerald-800' : b.ageing_bucket === '30-60' ? 'bg-blue-100 text-blue-800' : b.ageing_bucket === '60-90' ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800'}`}>
                          {b.ageing_bucket} days
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{b.count}</td>
                      <td className="px-3 py-2 text-right tabular-nums">Rs {(b.target / 100000).toFixed(2)}L</td>
                      <td className="px-3 py-2 text-right text-emerald-700 tabular-nums">Rs {(b.received / 100000).toFixed(2)}L</td>
                      <td className="px-3 py-2 text-right text-red-700 font-semibold tabular-nums">Rs {(b.outstanding / 100000).toFixed(2)}L</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">{b.collection_pct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}


      {/* Receivables Table */}
      <div className="card p-0">
        <div>
          <table className="freeze-head">
            <thead>
              <tr>
                <th>Site / Client</th>
                <th>CRM</th>
                <th>Target</th>
                <th>Received</th>
                <th>Outstanding</th>
                <th>Ageing</th>
                <th>Status</th>
                <th>Next Planned</th>
                <th>PMS Tasks</th>
                <th>Owner</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {receivables.map(r => (
                <tr key={r.id}>
                  <td className="font-medium">
                    {/* Show business_book.project_name first (true site name),
                        fall back to receivable.site_name, then client_name.
                        bb_project_name is auto-resolved on the backend by
                        matching r.client_name / r.site_name against BB. */}
                    {r.bb_project_name || r.site_name || r.client_name}
                    {/* Show client_name as a small subtitle when we resolved
                        a different bb_project_name — keeps the linkage visible
                        without mam losing the original client label. */}
                    {r.bb_project_name && r.client_name && r.bb_project_name !== r.client_name && (
                      <div className="text-[10px] text-gray-400 mt-0.5">{r.client_name}</div>
                    )}
                    {r.invoice_number && <div className="text-[10px] text-gray-400 font-mono">{r.invoice_number}</div>}
                    {r.last_discussion && <div className="text-[10px] text-amber-700 italic mt-0.5 max-w-[200px] truncate" title={r.last_discussion}>💬 {r.last_discussion}</div>}
                  </td>
                  <td className="text-xs">{r.crm_name || <span className="text-gray-300">—</span>}</td>
                  <td className="font-semibold tabular-nums">Rs {(+r.invoice_amount||0).toLocaleString('en-IN')}</td>
                  <td className="text-emerald-600 tabular-nums">
                    Rs {(+r.received_amount||0).toLocaleString('en-IN')}
                    {r.payments && r.payments.length > 0 && (
                      <div className="text-[10px] text-gray-400">{r.payments.length} installment{r.payments.length === 1 ? '' : 's'}</div>
                    )}
                  </td>
                  <td className="font-bold text-red-600 tabular-nums">Rs {(+r.outstanding_amount||0).toLocaleString('en-IN')}</td>
                  <td><span className={`badge ${r.ageing_days > 60 ? 'badge-red' : r.ageing_days > 30 ? 'badge-yellow' : 'badge-green'}`}>{r.ageing_days}d</span></td>
                  <td><span className={`px-2 py-1 rounded-full text-xs font-bold border ${statusBg[r.status]}`}>{r.status === 'red' ? '🔴' : r.status === 'yellow' ? '🟡' : '🟢'}</span></td>
                  <td className="text-xs">{r.next_planned_date || <span className="text-gray-300">—</span>}</td>
                  <td className="text-center">
                    {r.pms_tasks_count > 0
                      ? <span className="badge badge-purple text-xs">{r.pms_tasks_count}</span>
                      : <span className="text-gray-300 text-xs">0</span>}
                  </td>
                  <td className="text-xs">{r.owner_name || <span className="text-gray-300">—</span>}</td>
                  <td>
                    <div className="flex gap-1">
                      <button onClick={() => {
                        // Payment Advice (mam 2026-06-04): per-client outstanding statement.
                        const q = r.business_book_id ? `bbid=${encodeURIComponent(r.business_book_id)}` : `client=${encodeURIComponent(r.client_name || r.site_name || '')}`;
                        window.open(`/payment-advice/print?${q}`, '_blank');
                      }} className="p-1 hover:bg-indigo-50 rounded text-indigo-600" title="Payment Advice (outstanding statement)"><FiFileText size={14} /></button>
                      <button onClick={() => openEdit(r)} className="p-1 hover:bg-blue-50 rounded text-blue-600" title="Edit"><FiEdit2 size={14} /></button>
                      <button onClick={() => openFollowUps(r.id)} className="p-1 hover:bg-red-50 rounded text-red-600" title="Follow-up"><FiPhoneCall size={14} /></button>
                      <button onClick={() => { setSelectedId(r.id); setForm({ amount: 0, collection_date: new Date().toISOString().split('T')[0], payment_mode: '', transaction_ref: '', notes: '' }); setCollectModal(true); }} className="p-1 hover:bg-emerald-50 rounded text-emerald-600" title="Record Collection"><LuIndianRupee size={14} /></button>
                      {canDelete('collections') && <button onClick={async () => {
                        if (!confirm(`Delete receivable "${r.invoice_number || r.client_name}"?`)) return;
                        try { await api.delete(`/collections/${r.id}`); toast.success('Deleted'); load(); }
                        catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                      }} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}
                    </div>
                  </td>
                </tr>
              ))}
              {receivables.length === 0 && <tr><td colSpan="11" className="text-center py-8 text-gray-400">No receivables found</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit Receivable Modal — v2 layout per mam's spec:
          Site Name (unique picker) -> auto-fills CRM + suggests target.
          Target & Received are explicit. CRM logs next planned date +
          discussion. Payment installments shown beneath. */}
      <Modal isOpen={!!editModal} onClose={() => { setEditModal(null); setEditForm({}); }} title={editModal ? `Edit Receivable #${editModal.id}` : 'Edit Receivable'} wide>
        {editModal && (
          <form onSubmit={saveEdit} className="space-y-4">
            {/* SITE + CRM — site is locked when editing an existing
                row (mam, 2026-05-16: "every time ask enter to site
                name where it will auto fetch").  Editing a
                receivable shouldn't reassign it to a different site;
                that's a delete-and-recreate.  Shown as read-only
                text + a "Change site" link for the rare case. */}
            <div className="card p-3 bg-gray-50/60">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Site Name</label>
                  {editForm._allowSiteEdit ? (
                    <SearchableSelect
                      options={sites.map(s => ({ ...s, label: s.name }))}
                      value={editForm.site_name || null}
                      valueKey="name" displayKey="label"
                      placeholder="Pick site (unique from your sites/POs)"
                      onChange={onPickSite}
                    />
                  ) : (
                    <div className="input bg-white text-gray-800 font-medium flex items-center justify-between">
                      <span>{editForm.site_name || <span className="text-gray-400 italic">— not set —</span>}</span>
                      <button type="button" onClick={() => setEditForm(f => ({ ...f, _allowSiteEdit: true }))}
                              className="text-[10px] text-blue-600 hover:text-blue-800 underline">
                        Change
                      </button>
                    </div>
                  )}
                  <p className="text-[10px] text-gray-400 mt-0.5">
                    {editForm._allowSiteEdit
                      ? 'Pick a different site to re-assign this receivable.'
                      : 'Locked to this row. Click "Change" only if the original entry was wrong.'}
                  </p>
                </div>
                <div>
                  <label className="label">CRM Name <span className="text-[10px] text-gray-400 font-normal">(auto from PO)</span></label>
                  <input className="input" value={editForm.crm_name || ''} onChange={e => setEditForm(f => ({ ...f, crm_name: e.target.value }))} placeholder="Auto-fills when site picked" />
                </div>
              </div>
            </div>

            {/* MONEY */}
            <div className="card p-3">
              <h5 className="text-xs font-semibold text-gray-500 uppercase mb-2">Payment</h5>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="label">Target Payment <span className="text-red-500">*</span></label>
                  <input className="input text-right tabular-nums" type="number" step="any" min="0" value={editForm.invoice_amount || 0} onChange={e => setEditForm(f => ({ ...f, invoice_amount: +e.target.value }))} required />
                  <p className="text-[10px] text-gray-400 mt-0.5">From your PDF / latest PO.</p>
                </div>
                <div>
                  {/* Mam (2026-05-16): "can edit here payment rec." —
                      Received So Far is now editable.  Use the ₹ button
                      on the row for proper installment tracking
                      (preferred path), but this field lets mam correct
                      historical mistakes without rebuilding payment
                      history. */}
                  <label className="label">Received So Far <span className="text-[10px] text-amber-700 font-normal">(direct edit)</span></label>
                  <input
                    className="input text-right tabular-nums"
                    type="number" step="any" min="0"
                    value={editForm.received_amount ?? editModal.received_amount ?? 0}
                    onChange={e => setEditForm(f => ({ ...f, received_amount: +e.target.value }))}
                  />
                  <p className="text-[10px] text-gray-500 mt-0.5">
                    Use the ₹ button on the row to add a tracked installment.
                    Editing here overrides the auto-sum.
                  </p>
                </div>
                <div>
                  <label className="label">Outstanding</label>
                  <div className="input text-right tabular-nums bg-red-50 border-red-200 text-red-700 font-bold">
                    Rs {Math.max(0, (+editForm.invoice_amount || 0) - (+(editForm.received_amount ?? editModal.received_amount) || 0)).toLocaleString('en-IN')}
                  </div>
                </div>
                <div>
                  <label className="label">Invoice Number</label>
                  <input className="input" value={editForm.invoice_number || ''} onChange={e => setEditForm(f => ({ ...f, invoice_number: e.target.value }))} />
                </div>
                <div>
                  <label className="label">Invoice Date</label>
                  <input className="input" type="date" value={editForm.invoice_date || ''} onChange={e => setEditForm(f => ({ ...f, invoice_date: e.target.value }))} />
                </div>
                <div>
                  <label className="label">Due Date</label>
                  <input className="input" type="date" value={editForm.due_date || ''} onChange={e => setEditForm(f => ({ ...f, due_date: e.target.value }))} />
                </div>
              </div>
            </div>

            {/* CRM FOLLOW-UP */}
            <div className="card p-3 bg-amber-50/40 border-l-4 border-amber-400">
              <h5 className="text-xs font-semibold text-amber-900 uppercase mb-2">CRM Follow-up</h5>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Next Planned Date <span className="text-[10px] text-gray-400 font-normal">(when payment expected)</span></label>
                  <input className="input" type="date" value={editForm.next_planned_date || ''} onChange={e => setEditForm(f => ({ ...f, next_planned_date: e.target.value }))} />
                </div>
                <div>
                  <label className="label">Owner (Aanchal / collection person)</label>
                  <select className="select" value={editForm.owner_id || ''} onChange={e => setEditForm(f => ({ ...f, owner_id: e.target.value }))}>
                    <option value="">—</option>
                    {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="label">Last Discussion with Client</label>
                  <textarea className="input" rows="3" value={editForm.last_discussion || ''} onChange={e => setEditForm(f => ({ ...f, last_discussion: e.target.value }))} placeholder="What did the client say? When will they pay? Any escalation?" />
                </div>
              </div>
            </div>

            {/* PAYMENT INSTALLMENTS HISTORY */}
            {editModal.payments && editModal.payments.length > 0 && (
              <div className="card p-3">
                <h5 className="text-xs font-semibold text-gray-500 uppercase mb-2">Payment History ({editModal.payments.length} installment{editModal.payments.length === 1 ? '' : 's'})</h5>
                <table className="text-xs w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left px-2 py-1.5 text-gray-500">Date</th>
                      <th className="text-right px-2 py-1.5 text-gray-500">Amount</th>
                      <th className="text-left px-2 py-1.5 text-gray-500">Mode</th>
                      <th className="text-left px-2 py-1.5 text-gray-500">Ref / Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {editModal.payments.map((p, i) => (
                      <tr key={i} className="border-t">
                        <td className="px-2 py-1.5 text-gray-700">{p.collection_date}</td>
                        <td className="px-2 py-1.5 text-right text-emerald-700 font-semibold tabular-nums">Rs {(+p.amount || 0).toLocaleString('en-IN')}</td>
                        <td className="px-2 py-1.5 text-gray-500">{p.payment_mode || '—'}</td>
                        <td className="px-2 py-1.5 text-gray-500">{p.transaction_ref || p.notes || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-[10px] text-gray-400 mt-1">Add new installment via the ₹ button on the row (closes this modal first).</p>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => { setEditModal(null); setEditForm({}); }} className="btn btn-secondary">Cancel</button>
              <button type="submit" disabled={editSaving} className="btn btn-primary">{editSaving ? 'Saving…' : 'Save Changes'}</button>
            </div>
          </form>
        )}
      </Modal>

      {/* Add Receivable Modal — v2 layout (matches Edit modal): pick site
          first, CRM auto-fills, target/dates/follow-up captured together. */}
      <Modal isOpen={modal} onClose={() => { setModal(false); setForm({}); }} title="Add Receivable" wide>
        <form onSubmit={createReceivable} className="space-y-4">
          {/* SITE + CRM */}
          <div className="card p-3 bg-gray-50/60">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Site Name <span className="text-red-500">*</span></label>
                <SearchableSelect
                  options={sites.map(s => ({ ...s, label: s.name }))}
                  value={form.site_name || null}
                  valueKey="name" displayKey="label"
                  placeholder="Pick site (unique from your sites/POs)"
                  onChange={onPickAddSite}
                />
                <p className="text-[10px] text-gray-400 mt-0.5">Auto-fills CRM + suggests target from the latest PO of this site.</p>
              </div>
              <div>
                <label className="label">CRM Name <span className="text-[10px] text-gray-400 font-normal">(auto from PO)</span></label>
                <input className="input" value={form.crm_name || ''} onChange={e => setForm({...form, crm_name: e.target.value})} placeholder="Auto-fills when site picked" />
              </div>
            </div>
          </div>

          {/* MONEY */}
          <div className="card p-3">
            <h5 className="text-xs font-semibold text-gray-500 uppercase mb-2">Payment</h5>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="label">Target Payment <span className="text-red-500">*</span></label>
                <input className="input text-right tabular-nums" type="number" step="any" min="0" value={form.invoice_amount || 0} onChange={e => setForm({...form, invoice_amount: +e.target.value})} required />
                <p className="text-[10px] text-gray-400 mt-0.5">From your PDF / latest PO.</p>
              </div>
              <div>
                <label className="label">Invoice Number</label>
                <input className="input" value={form.invoice_number || ''} onChange={e => setForm({...form, invoice_number: e.target.value})} />
              </div>
              <div>
                <label className="label">Invoice Date</label>
                <input className="input" type="date" value={form.invoice_date || ''} onChange={e => setForm({...form, invoice_date: e.target.value})} />
              </div>
              <div>
                <label className="label">Due Date</label>
                <input className="input" type="date" value={form.due_date || ''} onChange={e => setForm({...form, due_date: e.target.value})} />
              </div>
            </div>
          </div>

          {/* CRM FOLLOW-UP */}
          <div className="card p-3 bg-amber-50/40 border-l-4 border-amber-400">
            <h5 className="text-xs font-semibold text-amber-900 uppercase mb-2">CRM Follow-up <span className="text-gray-400 font-normal normal-case">(optional)</span></h5>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Next Planned Date <span className="text-[10px] text-gray-400 font-normal">(when payment expected)</span></label>
                <input className="input" type="date" value={form.next_planned_date || ''} onChange={e => setForm({...form, next_planned_date: e.target.value})} />
              </div>
              <div>
                <label className="label">Owner (Aanchal / collection person)</label>
                <SearchableSelect
                  options={users.map(u => ({ ...u, label: u.name + (u.username ? ' (@' + u.username + ')' : '') }))}
                  value={form.owner_id || null}
                  valueKey="id" displayKey="label"
                  placeholder="Search user…"
                  onChange={(u) => setForm({ ...form, owner_id: u?.id || '' })}
                />
              </div>
              <div className="col-span-2">
                <label className="label">Last Discussion with Client</label>
                <textarea className="input" rows="2" value={form.last_discussion || ''} onChange={e => setForm({...form, last_discussion: e.target.value})} placeholder="What did the client say? When will they pay?" />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={() => { setModal(false); setForm({}); }} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Add Receivable</button>
          </div>
        </form>
      </Modal>

      {/* Follow-up Modal */}
      <Modal isOpen={followUpModal} onClose={() => setFollowUpModal(false)} title="Follow-up & Escalation" wide>
        <div className="space-y-4">
          {followUps.length > 0 && (
            <div className="max-h-48 overflow-y-auto border rounded-lg p-3 bg-gray-50">
              <h5 className="font-semibold text-xs text-gray-500 mb-2">Previous Follow-ups</h5>
              {followUps.map(f => (
                <div key={f.id} className="border-b last:border-0 py-2 text-sm">
                  <span className="font-medium">{f.follow_up_date}</span> via <span className="capitalize">{f.contact_method}</span> by {f.followed_by_name}
                  <br/><span className="text-gray-600">{f.response}</span>
                  {f.promised_date && <span className="text-red-600 ml-2">Promised: {f.promised_date} (Rs {f.promised_amount?.toLocaleString()})</span>}
                </div>
              ))}
            </div>
          )}
          <form onSubmit={addFollowUp} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div><label className="label">Follow-up Date</label><input className="input" type="date" value={form.follow_up_date || ''} onChange={e => setForm({...form, follow_up_date: e.target.value})} /></div>
              <div><label className="label">Contact Method</label><select className="select" value={form.contact_method || ''} onChange={e => setForm({...form, contact_method: e.target.value})}><option value="call">Phone Call</option><option value="email">Email</option><option value="visit">Site Visit</option><option value="whatsapp">WhatsApp</option><option value="legal_notice">Legal Notice</option></select></div>
            </div>
            <div><label className="label">Response / Notes</label><textarea className="input" rows="2" value={form.response || ''} onChange={e => setForm({...form, response: e.target.value})} /></div>
            <div className="grid grid-cols-2 gap-4">
              <div><label className="label">Promised Date</label><input className="input" type="date" value={form.promised_date || ''} onChange={e => setForm({...form, promised_date: e.target.value})} /></div>
              <div><label className="label">Promised Amount</label><input className="input" type="number" min="0" step="0.01" value={form.promised_amount ?? ''} onChange={e => setForm({...form, promised_amount: e.target.value === '' ? '' : +e.target.value})} placeholder="Enter amount" /></div>
            </div>
            <div className="flex justify-end gap-3"><button type="button" onClick={() => setFollowUpModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Record Follow-up</button></div>
          </form>
        </div>
      </Modal>

      {/* Collection Modal */}
      <Modal isOpen={collectModal} onClose={() => setCollectModal(false)} title="Record Collection Payment">
        <form onSubmit={recordCollection} className="space-y-4">
          <p className="text-xs text-red-600 bg-red-50 p-2 rounded">This collection will auto-link to Cash Flow System as an inflow entry.</p>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="label">Amount *</label><input className="input" type="number" min="0" step="0.01" value={form.amount ?? ''} onChange={e => setForm({...form, amount: e.target.value === '' ? '' : +e.target.value})} placeholder="Enter amount" required /></div>
            <div><label className="label">Date</label><input className="input" type="date" value={form.collection_date || ''} onChange={e => setForm({...form, collection_date: e.target.value})} /></div>
            <div><label className="label">Payment Mode</label><select className="select" value={form.payment_mode || ''} onChange={e => setForm({...form, payment_mode: e.target.value})}><option value="">Select</option><option value="Cash">Cash</option><option value="Bank Transfer">Bank Transfer</option><option value="UPI">UPI</option><option value="Cheque">Cheque</option><option value="NEFT">NEFT</option><option value="RTGS">RTGS</option></select></div>
            <div><label className="label">Transaction Ref</label><input className="input" value={form.transaction_ref || ''} onChange={e => setForm({...form, transaction_ref: e.target.value})} /></div>
          </div>
          <div><label className="label">Notes</label><textarea className="input" rows="2" value={form.notes || ''} onChange={e => setForm({...form, notes: e.target.value})} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setCollectModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-success">Record Collection</button></div>
        </form>
      </Modal>
      </>
      )}
    </div>
  );
}
