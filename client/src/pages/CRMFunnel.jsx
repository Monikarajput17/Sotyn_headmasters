import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { FiPlus, FiEdit2, FiEye, FiTrash2, FiExternalLink, FiTarget, FiDownload } from 'react-icons/fi';
import ResponsibilityTab from '../components/ResponsibilityTab';
import { exportCsv } from '../utils/exportCsv';

const fmt = (n) => 'Rs ' + Math.abs(Math.round(+n || 0)).toLocaleString('en-IN');
import { useAuth } from '../context/AuthContext';
import { STATES, DISTRICTS_BY_STATE } from '../data/indiaLocations';

// CRM Sales Funnel FMS — flat 3-step tracker. Step 1: Quotation submit.
// Step 2: Negotiation. Step 3: Win/Loss. Mam's columns from her sheet:
// Lead Number, Client, Company, Mobile, Email, Source, Address, State,
// Remarks, Category, Type, Cust BOQ, Quotation Link, Amount, Submit Y/N,
// Negotiation Status, Amount, Win/Loss, Reason if Loss.

const CATEGORIES = ['Hospital', 'Hotel', 'Office', 'Industrial', 'Residential', 'Retail', 'Educational', 'Government', 'Other'];
// MD's TOC v3 spec (2026-05-15): canonical 5 lead sources — block free
// text and any legacy label.  The backend validator enforces the same
// whitelist server-side via validateFunnelSource().
const SOURCES = ['Tenders', 'Referral', 'Direct', 'Website', 'Channel'];
const TYPES = ['Private', 'Government'];
const NEG_STATUSES = [
  { v: 'in_progress', l: 'In Progress' },
  { v: 'hold', l: 'On Hold' },
  { v: 'done', l: 'Done' },
  { v: 'dropped', l: 'Dropped' },
];

const LEAD_TYPES = ['New', 'Extra Enquiry'];

const blank = () => ({
  client_name: '', company_name: '', mobile: '', email: '', source: '',
  address: '', state: '', district: '', remarks: '', category: '', type: '',
  lead_type: 'New', boq_file_link: '', boq_file: null,
  cust_boq_link: '', quotation_link: '', quotation_amount: 0, quotation_submitted: false,
  negotiation_status: '', negotiation_amount: 0, negotiation_remarks: '',
  final_status: '', loss_reason: '',
});

export default function CRMFunnel() {
  const { canCreate, canEdit, canDelete } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ q: '', step: 'all', state: '', type: '' });
  const [view, setView] = useState('funnel');   // 'funnel' | 'responsible'
  const [modal, setModal] = useState(false);
  // Read-only view modal (mam, 2026-05-16: "action as eye" on the
  // CRM funnel list).  Holds the row being inspected; null = closed.
  const [viewRow, setViewRow] = useState(null);
  // Stage-aware quick-update form inside the view modal.  Pre-fills
  // from viewRow when the modal opens; Save patches just these
  // fields via the existing PUT /crm-funnel/:id endpoint so the
  // user doesn't have to open the full edit modal for routine
  // stage advancement.
  const [stageForm, setStageForm] = useState({});
  const [stageSaving, setStageSaving] = useState(false);

  // Current step inference — mirrors stepBadge's logic so the view
  // modal shows the right action panel.
  const currentStep = (r) => {
    if (!r) return null;
    if (r.final_status === 'win' || r.final_status === 'loss') return 'done';
    if (r.quotation_submitted) return 'step2';
    return 'step1';
  };

  // Quick-save just the stage fields.  Uses the same PUT endpoint as
  // the full edit form — we just don't touch fields the user hasn't
  // changed.
  const saveStage = async () => {
    if (!viewRow?.id) return;
    setStageSaving(true);
    try {
      const fd = new FormData();
      // Carry the row's existing data so the backend doesn't null-out
      // unrelated fields.  Then overlay the stage-form changes.
      Object.entries(viewRow).forEach(([k, v]) => {
        if (v === null || v === undefined) return;
        if (typeof v === 'boolean') fd.append(k, v ? '1' : '0');
        else fd.append(k, v);
      });
      Object.entries(stageForm).forEach(([k, v]) => {
        if (v === null || v === undefined) return;
        if (typeof v === 'boolean') fd.set(k, v ? '1' : '0');
        else fd.set(k, v);
      });
      await api.put(`/crm-funnel/${viewRow.id}`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success('Stage updated');
      setViewRow(null);
      setStageForm({});
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Update failed');
    } finally {
      setStageSaving(false);
    }
  };

  // Reset stage form whenever a different lead is opened in the
  // view modal — prevents leaked state across rows.
  useEffect(() => {
    if (viewRow) {
      setStageForm({
        quotation_amount: viewRow.quotation_amount || '',
        quotation_submitted: !!viewRow.quotation_submitted,
        negotiation_status: viewRow.negotiation_status || '',
        negotiation_amount: viewRow.negotiation_amount || '',
        negotiation_remarks: viewRow.negotiation_remarks || '',
        final_status: viewRow.final_status || '',
        loss_reason: viewRow.loss_reason || '',
      });
    }
  }, [viewRow?.id]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(blank());
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    const params = {};
    if (filter.q) params.q = filter.q;
    if (filter.step !== 'all') params.step = filter.step;
    if (filter.state) params.state = filter.state;
    if (filter.type) params.type = filter.type;
    api.get('/crm-funnel', { params }).then(r => setRows(r.data))
      .catch(e => toast.error(e.response?.data?.error || 'Load failed'))
      .finally(() => setLoading(false));
  };
  useEffect(load, [filter.q, filter.step, filter.state, filter.type]);

  const openAdd = () => { setEditing(null); setForm(blank()); setModal(true); };
  const openEdit = (row) => {
    setEditing(row);
    setForm({ ...row, quotation_submitted: !!row.quotation_submitted });
    setModal(true);
  };
  const districtOptions = form.state ? (DISTRICTS_BY_STATE[form.state] || []) : [];

  const save = async (e) => {
    e.preventDefault();
    if (!form.client_name?.trim()) { toast.error('Client name is required'); return; }
    setSaving(true);
    try {
      // Build a multipart form so the BOQ file can ride along when picked.
      // Server accepts either multipart with `boq_file` or plain JSON for
      // backwards compatibility — using multipart always keeps it simple.
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => {
        if (k === 'boq_file') return;                // file appended separately
        if (v === null || v === undefined) return;
        if (typeof v === 'boolean') fd.append(k, v ? '1' : '0');
        else fd.append(k, v);
      });
      if (form.boq_file instanceof File) fd.append('boq_file', form.boq_file);
      const opts = { headers: { 'Content-Type': 'multipart/form-data' } };
      if (editing) {
        await api.put(`/crm-funnel/${editing.id}`, fd, opts);
        toast.success('Updated');
      } else {
        await api.post('/crm-funnel', fd, opts);
        toast.success('Added');
      }
      setModal(false); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  };

  const remove = async (row) => {
    if (!confirm(`Delete "${row.client_name}" (${row.lead_no})?`)) return;
    try {
      await api.delete(`/crm-funnel/${row.id}`);
      toast.success('Deleted'); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
  };

  const stepBadge = (r) => {
    if (r.final_status === 'win') return <span className="px-2 py-0.5 text-[10px] rounded font-medium bg-emerald-100 text-emerald-800">WIN</span>;
    if (r.final_status === 'loss') return <span className="px-2 py-0.5 text-[10px] rounded font-medium bg-red-100 text-red-700">LOSS</span>;
    if (r.quotation_submitted) return <span className="px-2 py-0.5 text-[10px] rounded font-medium bg-amber-100 text-amber-800">STEP 2 · NEGOTIATION</span>;
    return <span className="px-2 py-0.5 text-[10px] rounded font-medium bg-blue-100 text-blue-700">STEP 1 · QUOTATION</span>;
  };

  // Metrics — counts mirror the existing 11-stage Sales Funnel dashboard so
  // mam recognises the layout. Win/Loss/Win-rate use final_status; This
  // Month uses created_at falling in the current calendar month.
  const now = new Date();
  const thisMonth = rows.filter(r => {
    if (!r.created_at) return false;
    const d = new Date(r.created_at.replace(' ', 'T'));
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }).length;
  const won = rows.filter(r => r.final_status === 'win');
  const lost = rows.filter(r => r.final_status === 'loss');
  const winAmount = won.reduce((s, r) => s + (+r.negotiation_amount || +r.quotation_amount || 0), 0);
  const winRate = rows.length > 0 ? Math.round((won.length / rows.length) * 100) : 0;
  const stepCount = (key) => key === 'all' ? rows.length :
    key === '1' ? rows.filter(r => !r.quotation_submitted).length :
    key === '2' ? rows.filter(r => r.quotation_submitted && !r.final_status).length :
    rows.filter(r => r.final_status === 'win' || r.final_status === 'loss').length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-gray-800 flex items-center gap-2"><FiTarget /> CRM Sales Funnel</h3>
          <p className="text-xs text-gray-500">Flat 3-step tracker: Quotation → Negotiation → Win/Loss</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => exportCsv('crm-funnel',
            ['Lead #','Client','Company','Mobile','Source','Type','Category','State','Stage','Quote Amount','Neg Status','Neg Amount','Final Status'],
            rows.map(r => [r.lead_no, r.client_name, r.company_name, r.mobile, r.source, r.type, r.category, r.state, r.final_status || (r.quotation_submitted ? 'Negotiation' : 'Quote'), r.quotation_amount, r.negotiation_status, r.negotiation_amount, r.final_status]))}
            className="btn btn-secondary flex items-center gap-2"><FiDownload /> Export Excel</button>
          {canCreate('crm_funnel') && (
            <button onClick={openAdd} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Lead</button>
          )}
        </div>
      </div>

      {/* Step pill tabs — same visual style as the existing Sales Funnel
          stage tabs. Each pill is a step + count chip; click to filter. */}
      <div className="flex gap-2 flex-wrap items-center">
        {[
          { key: 'all', label: 'All Leads', chipCls: 'bg-gray-500' },
          { key: '1', label: 'Step 1 — Quotation', chipCls: 'bg-blue-500' },
          { key: '2', label: 'Step 2 — Negotiation', chipCls: 'bg-amber-500' },
          { key: '3', label: 'Step 3 — Win / Loss', chipCls: 'bg-emerald-500' },
        ].map(s => {
          const isActive = view === 'funnel' && filter.step === s.key;
          return (
            <button
              key={s.key}
              onClick={() => { setView('funnel'); setFilter(f => ({ ...f, step: s.key })); }}
              className={`btn ${isActive ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}
            >
              {s.label}
              <span className={`px-1.5 rounded-full text-[10px] font-bold min-w-[18px] text-center text-white ${isActive ? 'bg-white/30' : s.chipCls}`}>
                {stepCount(s.key)}
              </span>
            </button>
          );
        })}
        {/* Responsible (RACI + time) pill — who owns each step & how long it took */}
        <button
          onClick={() => setView('responsible')}
          className={`btn ${view === 'responsible' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}
        >
          ⚙ Responsible
        </button>
      </div>

      {view === 'responsible' ? (
        <ResponsibilityTab module="crm_funnel" title="CRM Sales Funnel" />
      ) : (<>
      {/* Metric cards — match the existing Sales Funnel dashboard 5-card
          layout (Total / This Month / Won / Lost / Win Rate). */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="card p-4 border-l-4 border-red-500"><p className="text-[10px] text-gray-500 font-bold uppercase">Total Leads</p><p className="text-3xl font-extrabold text-red-600">{rows.length}</p></div>
        <div className="card p-4 border-l-4 border-purple-500"><p className="text-[10px] text-gray-500 font-bold uppercase">This Month</p><p className="text-3xl font-extrabold text-purple-600">{thisMonth}</p></div>
        <div className="card p-4 border-l-4 border-emerald-500"><p className="text-[10px] text-gray-500 font-bold uppercase">Won Deals</p><p className="text-3xl font-extrabold text-emerald-600">{won.length}</p>{winAmount > 0 && <p className="text-xs text-emerald-500">{fmt(winAmount)}</p>}</div>
        <div className="card p-4 border-l-4 border-red-500"><p className="text-[10px] text-gray-500 font-bold uppercase">Lost</p><p className="text-3xl font-extrabold text-red-600">{lost.length}</p></div>
        <div className="card p-4 border-l-4 border-amber-500"><p className="text-[10px] text-gray-500 font-bold uppercase">Win Rate</p><p className="text-3xl font-extrabold text-amber-600">{winRate}%</p></div>
      </div>

      <div className="card p-3 grid grid-cols-1 sm:grid-cols-4 gap-2">
        <input className="input text-sm" placeholder="Search client / company / mobile / lead#"
          value={filter.q} onChange={e => setFilter(f => ({ ...f, q: e.target.value }))} />
        <select className="select text-sm" value={filter.state} onChange={e => setFilter(f => ({ ...f, state: e.target.value }))}>
          <option value="">All states</option>
          {STATES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="select text-sm" value={filter.type} onChange={e => setFilter(f => ({ ...f, type: e.target.value }))}>
          <option value="">All types</option>
          {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="select text-sm" value={filter.step} onChange={e => setFilter(f => ({ ...f, step: e.target.value }))}>
          <option value="all">All steps</option>
          <option value="1">Step 1 — Quotation</option>
          <option value="2">Step 2 — Negotiation</option>
          <option value="3">Step 3 — Win/Loss</option>
        </select>
      </div>

      <div className="card p-0">
        <table className="freeze-head">
          <thead>
            <tr>
              <th>Lead #</th><th>Client</th><th>Company</th><th>Mobile</th><th>Source</th>
              <th>Type</th><th>Category</th><th>State</th>
              <th>BOQ</th><th>Quote</th><th>Qty Amount</th>
              <th>Neg Status</th><th>Neg Amount</th>
              <th>Stage</th><th>Loss Reason</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan="16" className="text-center py-8 text-gray-400">Loading…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan="16" className="text-center py-8 text-gray-400">
                No leads yet. Click <b>+ Add Lead</b>.
              </td></tr>
            )}
            {rows.map(r => (
              <tr key={r.id}>
                <td className="font-mono text-xs">{r.lead_no}</td>
                <td className="font-medium">
                  {r.client_name}
                  {r.requirement_items && (
                    <div className="text-[10px] text-gray-500 font-normal max-w-[220px] truncate" title={r.requirement_items}>🧾 {r.requirement_items}</div>
                  )}
                </td>
                <td>{r.company_name || '-'}</td>
                <td>{r.mobile || '-'}</td>
                <td>{r.source || '-'}</td>
                <td>{r.type || '-'}</td>
                <td>{r.category === 'extra_non_schedule' ? 'Extra · Non-Schedule' : r.category === 'extra_schedule' ? 'Extra · Schedule' : (r.category || '-')}</td>
                <td>{r.state || '-'}</td>
                <td>
                  {r.cust_boq_link ? (
                    <a className="text-red-600 hover:underline" href={r.cust_boq_link} target="_blank" rel="noreferrer"><FiExternalLink size={12} className="inline" /></a>
                  ) : r.source_indent_id ? (
                    <a href={`/indent/${r.source_indent_id}/print`} target="_blank" rel="noreferrer" className="text-[10px] text-blue-600 hover:underline inline-flex items-center gap-0.5 whitespace-nowrap" title="View indent requirement"><FiExternalLink size={11} /> View indent</a>
                  ) : '-'}
                </td>
                <td>
                  {r.quotation_link ? (
                    <a className="text-red-600 hover:underline" href={r.quotation_link} target="_blank" rel="noreferrer"><FiExternalLink size={12} className="inline" /></a>
                  ) : (r.source_indent_id && r.category === 'extra_schedule') ? (
                    <a href={`/quotation/${r.source_indent_id}/print`} target="_blank" rel="noreferrer" className="text-[10px] text-emerald-700 hover:underline inline-flex items-center gap-0.5 whitespace-nowrap font-semibold" title="Auto-priced quotation from previous BOQ rates"><FiExternalLink size={11} /> Make quotation</a>
                  ) : '-'}
                </td>
                <td>{r.quotation_amount ? `Rs ${(+r.quotation_amount).toLocaleString('en-IN')}` : '-'}</td>
                <td>{NEG_STATUSES.find(s => s.v === r.negotiation_status)?.l || '-'}</td>
                <td>{r.negotiation_amount ? `Rs ${(+r.negotiation_amount).toLocaleString('en-IN')}` : '-'}</td>
                <td>{stepBadge(r)}</td>
                <td className="text-xs text-gray-600 max-w-[180px] truncate" title={r.loss_reason}>{r.loss_reason || '-'}</td>
                <td>
                  <div className="flex gap-1">
                    {/* View (eye) — works for everyone with view
                        access, including roles that can't edit.
                        Mam wanted a consistent eye-button shape
                        across CRM Funnel, Sales Funnel, BB,
                        Rental, etc. */}
                    <button onClick={() => setViewRow(r)} className="p-1 text-gray-400 hover:text-red-600" title="View lead"><FiEye size={14} /></button>
                    {canEdit('crm_funnel') && <button onClick={() => openEdit(r)} className="p-1 text-gray-500 hover:text-red-600" title="Edit"><FiEdit2 size={14} /></button>}
                    {canDelete('crm_funnel') && <button onClick={() => remove(r)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>)}

      <Modal isOpen={modal} onClose={() => setModal(false)} title={editing ? `Edit Lead — ${editing.lead_no}` : 'Add CRM Lead'} wide>
        <form onSubmit={save} className="space-y-4">
          {/* Lead capture */}
          <div className="border-b pb-2"><h4 className="font-semibold text-sm text-red-700">Lead Details</h4></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Client Name <span className="text-red-500">*</span></label>
              <input className="input" value={form.client_name} onChange={e => setForm({ ...form, client_name: e.target.value })} required />
            </div>
            <div>
              <label className="label">Company Name</label>
              <input className="input" value={form.company_name} onChange={e => setForm({ ...form, company_name: e.target.value })} />
            </div>
            <div>
              <label className="label">Mobile Number</label>
              <input className="input" type="tel" value={form.mobile} onChange={e => setForm({ ...form, mobile: e.target.value })} />
            </div>
            <div>
              <label className="label">Email</label>
              <input className="input" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
            </div>
            <div>
              <label className="label">Source of Enquiry</label>
              <select className="select" value={form.source} onChange={e => setForm({ ...form, source: e.target.value })}>
                <option value="">Select</option>
                {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Type</label>
              <select className="select" value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
                <option value="">Select</option>
                {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Category</label>
              <select className="select" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                <option value="">Select</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {/* Lead Type — mam: "add lead type :- new , extra enquiry".
                Independent from the existing Private/Government Type. */}
            <div className="sm:col-span-2">
              <label className="label">Lead Type</label>
              <div className="flex gap-3 mt-1">
                {LEAD_TYPES.map(lt => (
                  <label key={lt} className={`flex-1 border rounded-lg px-3 py-2 cursor-pointer flex items-center gap-2 ${form.lead_type === lt ? 'border-red-400 bg-red-50' : 'border-gray-200 hover:border-red-200'}`}>
                    <input type="radio" name="lead_type" value={lt} checked={form.lead_type === lt} onChange={() => setForm({ ...form, lead_type: lt })} />
                    <span className="text-sm font-medium">{lt}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="label">Address</label>
              <input className="input" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} />
            </div>
            <div>
              <label className="label">State</label>
              <SearchableSelect options={STATES.map(s => ({ value: s, label: s }))}
                value={form.state} valueKey="value" displayKey="label"
                placeholder="Pick state"
                onChange={(opt) => setForm({ ...form, state: opt?.value || '', district: '' })} />
            </div>
            <div>
              <label className="label">District</label>
              <SearchableSelect options={districtOptions.map(d => ({ value: d, label: d }))}
                value={form.district} valueKey="value" displayKey="label"
                placeholder={form.state ? 'Pick district' : 'Pick a state first'}
                onChange={(opt) => setForm({ ...form, district: opt?.value || '' })} />
            </div>
            {/* BOQ file upload — Excel / PDF / image at lead-capture time so
                the client's BOQ stays attached from day one. Optional. */}
            <div className="sm:col-span-2">
              <label className="label">Customer BOQ File <span className="text-gray-400 font-normal">(optional)</span></label>
              <input
                className="input"
                type="file"
                accept=".xlsx,.xls,.pdf,.doc,.docx,.jpg,.jpeg,.png"
                onChange={e => setForm({ ...form, boq_file: e.target.files?.[0] || null })}
              />
              {form.boq_file && <p className="text-[10px] text-emerald-600 mt-0.5">Selected: {form.boq_file.name}</p>}
              {!form.boq_file && form.boq_file_link && (
                <p className="text-[10px] text-gray-500 mt-0.5">
                  Attached: <a href={form.boq_file_link} target="_blank" rel="noreferrer" className="text-red-600 underline">{form.boq_file_link.split('/').pop()}</a>
                  {' '}<button type="button" className="text-[10px] text-red-500 hover:underline" onClick={() => setForm({ ...form, boq_file_link: '' })}>remove</button>
                </p>
              )}
            </div>
            <div className="sm:col-span-2">
              <label className="label">Remarks</label>
              <textarea className="input" rows="2" value={form.remarks} onChange={e => setForm({ ...form, remarks: e.target.value })} />
            </div>
          </div>

          {/* Steps 1/2/3 only show when editing an existing lead. On Add,
              mam doesn't yet have a quotation, negotiation, or final
              status — she'll fill those in later by editing the row.
              Mam: "dont here entry step 1 step 2 step 3". */}
          {editing && (
            <>
              {/* Step 1 */}
              <div className="border-b pb-2"><h4 className="font-semibold text-sm text-red-700">Step 1 — Quotation</h4></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Customer BOQ Link</label>
                  <input className="input text-sm" placeholder="https://…" value={form.cust_boq_link} onChange={e => setForm({ ...form, cust_boq_link: e.target.value })} />
                </div>
                <div>
                  <label className="label">Quotation Link</label>
                  <input className="input text-sm" placeholder="https://…" value={form.quotation_link} onChange={e => setForm({ ...form, quotation_link: e.target.value })} />
                </div>
                <div>
                  <label className="label">Quotation Amount (Rs)</label>
                  <input className="input" type="number" min="0" value={form.quotation_amount} onChange={e => setForm({ ...form, quotation_amount: +e.target.value })} />
                </div>
                <div>
                  <label className="label">Quotation Submitted?</label>
                  <label className="flex items-center gap-2 mt-2 cursor-pointer">
                    <input type="checkbox" checked={!!form.quotation_submitted} onChange={e => setForm({ ...form, quotation_submitted: e.target.checked })} className="w-4 h-4" />
                    <span className="text-sm">Yes — submitted to client</span>
                  </label>
                </div>
              </div>

              {/* Step 2 */}
              <div className="border-b pb-2"><h4 className="font-semibold text-sm text-red-700">Step 2 — Negotiation</h4></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Negotiation Status</label>
                  <select className="select" value={form.negotiation_status} onChange={e => setForm({ ...form, negotiation_status: e.target.value })}>
                    <option value="">Not started</option>
                    {NEG_STATUSES.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Negotiation Amount (Rs)</label>
                  <input className="input" type="number" min="0" value={form.negotiation_amount} onChange={e => setForm({ ...form, negotiation_amount: +e.target.value })} />
                </div>
                <div className="sm:col-span-2">
                  <label className="label">Negotiation Remarks</label>
                  <textarea className="input" rows="2" value={form.negotiation_remarks} onChange={e => setForm({ ...form, negotiation_remarks: e.target.value })} />
                </div>
              </div>

              {/* Step 3 */}
              <div className="border-b pb-2"><h4 className="font-semibold text-sm text-red-700">Step 3 — Win / Loss</h4></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Final Status</label>
                  <select className="select" value={form.final_status} onChange={e => setForm({ ...form, final_status: e.target.value })}>
                    <option value="">Still open</option>
                    <option value="win">Win</option>
                    <option value="loss">Loss</option>
                  </select>
                </div>
                {form.final_status === 'loss' && (
                  <div>
                    <label className="label">Reason if Loss</label>
                    <input className="input" value={form.loss_reason} onChange={e => setForm({ ...form, loss_reason: e.target.value })} placeholder="e.g. price, timeline, scope mismatch" />
                  </div>
                )}
              </div>
            </>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={saving} className="btn btn-primary">{saving ? 'Saving…' : (editing ? 'Update' : 'Add')}</button>
          </div>
        </form>
      </Modal>

      {/* ─── Read-only view modal (eye button) ─────────────────
          Same layout as the edit modal, but with disabled fields
          so users without edit permission can still inspect a
          lead's full data + loss reason.  Switch to Edit button
          at the bottom for users who do have edit rights. */}
      {viewRow && (
        <Modal isOpen={true} onClose={() => setViewRow(null)} title={`Lead · ${viewRow.lead_no || viewRow.client_name || '—'}`} wide>
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Field label="Lead #">{viewRow.lead_no || '—'}</Field>
              <Field label="Client">{viewRow.client_name || '—'}</Field>
              <Field label="Company">{viewRow.company_name || '—'}</Field>
              <Field label="Mobile">{viewRow.mobile || '—'}</Field>
              <Field label="Source">{viewRow.source || '—'}</Field>
              <Field label="Type">{viewRow.type || '—'}</Field>
              <Field label="Category">{viewRow.category || '—'}</Field>
              <Field label="Lead Type">{viewRow.lead_type || '—'}</Field>
              <Field label="State">{viewRow.state || '—'}</Field>
              <Field label="District">{viewRow.district || '—'}</Field>
              <Field label="BOQ">{viewRow.boq_status || '—'}</Field>
              <Field label="Quote">{viewRow.quote_status || '—'}</Field>
              <Field label="Qty Amount">{viewRow.qty_amount ? `Rs ${(+viewRow.qty_amount).toLocaleString('en-IN')}` : '—'}</Field>
              <Field label="Neg Status">{NEG_STATUSES.find(s => s.v === viewRow.negotiation_status)?.l || '—'}</Field>
              <Field label="Neg Amount">{viewRow.negotiation_amount ? `Rs ${(+viewRow.negotiation_amount).toLocaleString('en-IN')}` : '—'}</Field>
              <Field label="Final Status">{viewRow.final_status || '—'}</Field>
            </div>
            {viewRow.loss_reason && (
              <Field label="Loss Reason"><span className="text-red-700">{viewRow.loss_reason}</span></Field>
            )}
            {viewRow.notes && <Field label="Notes">{viewRow.notes}</Field>}

            {/* ─── Stage-aware quick-update card ────────────────────
                Shows only the fields relevant to the current step so
                the team can advance leads from the eye modal without
                opening the full edit form.  Mam (2026-05-16): "when
                eye open update according to stage". */}
            {canEdit('crm_funnel') && currentStep(viewRow) && (
              <div className="border-2 border-blue-200 bg-blue-50/40 rounded p-3 space-y-3">
                <div className="text-xs font-semibold uppercase text-blue-700 flex items-center gap-2">
                  <FiTarget size={12} /> Stage Action — {currentStep(viewRow) === 'step1' ? 'Step 1 · Quotation' : currentStep(viewRow) === 'step2' ? 'Step 2 · Negotiation' : 'Step 3 · Win / Loss'}
                </div>

                {/* STEP 1 → STEP 2 · submit quotation */}
                {currentStep(viewRow) === 'step1' && (
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="space-y-1">
                      <label className="text-gray-600">Quotation Amount (₹)</label>
                      <input type="number" className="input w-full" value={stageForm.quotation_amount || ''}
                        onChange={e => setStageForm({ ...stageForm, quotation_amount: e.target.value })}
                        placeholder="e.g. 5143320" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-gray-600">Quotation submitted?</label>
                      <select className="select w-full" value={stageForm.quotation_submitted ? '1' : '0'}
                        onChange={e => setStageForm({ ...stageForm, quotation_submitted: e.target.value === '1' })}>
                        <option value="0">No — still preparing</option>
                        <option value="1">Yes — submitted (move to Step 2)</option>
                      </select>
                    </div>
                    <p className="col-span-2 text-[10px] text-gray-500">
                      Marking <strong>Yes</strong> here moves the lead to Step 2 · Negotiation. The submit date is stamped automatically.
                    </p>
                  </div>
                )}

                {/* STEP 2 · negotiation */}
                {currentStep(viewRow) === 'step2' && (
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="space-y-1">
                      <label className="text-gray-600">Negotiation status</label>
                      <select className="select w-full" value={stageForm.negotiation_status || ''}
                        onChange={e => setStageForm({ ...stageForm, negotiation_status: e.target.value })}>
                        <option value="">— Pick —</option>
                        {NEG_STATUSES.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-gray-600">Negotiation Amount (₹)</label>
                      <input type="number" className="input w-full" value={stageForm.negotiation_amount || ''}
                        onChange={e => setStageForm({ ...stageForm, negotiation_amount: e.target.value })}
                        placeholder="Counter-offered / agreed amount" />
                    </div>
                    <div className="col-span-2 space-y-1">
                      <label className="text-gray-600">Negotiation remarks</label>
                      <input className="input w-full" value={stageForm.negotiation_remarks || ''}
                        onChange={e => setStageForm({ ...stageForm, negotiation_remarks: e.target.value })}
                        placeholder="Notes from last call / meeting…" />
                    </div>
                    <div className="col-span-2 space-y-1 pt-2 border-t border-blue-200">
                      <label className="text-gray-600 font-semibold">Outcome — set when deal is closed</label>
                      <div className="flex gap-2">
                        <select className="select flex-1" value={stageForm.final_status || ''}
                          onChange={e => setStageForm({ ...stageForm, final_status: e.target.value })}>
                          <option value="">— Still in negotiation —</option>
                          <option value="win">Won 🎉</option>
                          <option value="loss">Lost</option>
                        </select>
                        {stageForm.final_status === 'loss' && (
                          <input className="input flex-1" value={stageForm.loss_reason || ''}
                            onChange={e => setStageForm({ ...stageForm, loss_reason: e.target.value })}
                            placeholder="Loss reason (price / timeline / scope…)" />
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* STEP 3 · closed — read-only summary, with option to re-open */}
                {currentStep(viewRow) === 'done' && (
                  <div className="text-xs space-y-2">
                    <div className={`px-3 py-2 rounded font-semibold text-center ${viewRow.final_status === 'win' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700'}`}>
                      {viewRow.final_status === 'win'
                        ? `Won — Rs ${(+viewRow.negotiation_amount || +viewRow.quotation_amount || 0).toLocaleString('en-IN')}`
                        : `Lost — ${viewRow.loss_reason || 'no reason given'}`}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <select className="select" value={stageForm.final_status || ''}
                        onChange={e => setStageForm({ ...stageForm, final_status: e.target.value })}>
                        <option value="">Re-open (move back to Step 2)</option>
                        <option value="win">Keep as Won</option>
                        <option value="loss">Keep as Lost</option>
                      </select>
                      {stageForm.final_status === 'loss' && (
                        <input className="input" value={stageForm.loss_reason || ''}
                          onChange={e => setStageForm({ ...stageForm, loss_reason: e.target.value })}
                          placeholder="Loss reason" />
                      )}
                    </div>
                  </div>
                )}

                <button onClick={saveStage} disabled={stageSaving}
                  className="btn btn-primary text-sm w-full">
                  {stageSaving ? 'Saving…' : 'Save Stage Update'}
                </button>
              </div>
            )}

            <div className="flex items-center justify-between pt-3 border-t text-xs text-gray-500">
              <span>Created {viewRow.created_at?.slice(0, 10) || ''} {viewRow.created_by_name ? `· by ${viewRow.created_by_name}` : ''}</span>
              <div className="flex gap-2">
                <button onClick={() => setViewRow(null)} className="btn btn-secondary text-sm">Close</button>
                {canEdit('crm_funnel') && (
                  <button onClick={() => { const r = viewRow; setViewRow(null); openEdit(r); }} className="btn btn-primary text-sm flex items-center gap-1.5">
                    <FiEdit2 size={12} /> Full Edit
                  </button>
                )}
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Tiny read-only field renderer for the view modal.  Kept local to
// this file because it's only used here and reads better than
// inline grid markup at every cell.
function Field({ label, children }) {
  return (
    <div className="bg-gray-50 border rounded p-2">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className="font-medium break-words">{children}</div>
    </div>
  );
}
