import { useState, useEffect } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { FiPlus, FiTrendingUp, FiTrendingDown, FiCalendar, FiTrash2, FiSearch, FiEdit2, FiCheck, FiX, FiDownload } from 'react-icons/fi';
import { LuIndianRupee } from 'react-icons/lu';
import { useAuth } from '../context/AuthContext';
import { exportCsv } from '../utils/exportCsv';

export default function CashFlow() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useUrlTab('projects');
  const [projects, setProjects] = useState([]);
  const [summary, setSummary] = useState(null);
  const [dailySummary, setDailySummary] = useState(null);
  const [entries, setEntries] = useState([]);
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [editingOpening, setEditingOpening] = useState(false);   // inline-edit the day's opening balance
  const [openingInput, setOpeningInput] = useState('');
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ date: '', type: 'inflow', category: '', description: '', amount: 0, payment_mode: '', party_name: '' });
  const [search, setSearch] = useState('');
  const [crmFilter, setCrmFilter] = useState('');
  // Last-payment-date filter — buckets projects by how stale their last
  // received payment is. Useful for chasing collections (90+ days = call
  // first). 'never' = no payment ever received (no Inv Days, no Total Days).
  const [pmtAgeFilter, setPmtAgeFilter] = useState('');
  // Date-range filter on Last Payment Date — mam: 'filter from to date as
  // per last payment date'. Both buckets above and date-range below can
  // coexist (AND filter); empty = no constraint.
  const [pmtFromDate, setPmtFromDate] = useState('');
  const [pmtToDate, setPmtToDate] = useState('');
  const [editRow, setEditRow] = useState(null);
  const [editForm, setEditForm] = useState({});

  // Project breakdown drawer — mam (2026-05-16): "look business book
  // sardareshahar total amount and cash flow amount check correct
  // this error".  Click the "N BB entries summed" badge on any row
  // to see the exact BB rows feeding into that project's totals.
  // Lets her spot accidental client_name collisions before they
  // distort the dashboard.
  const [breakdownFor, setBreakdownFor] = useState(null);
  const [breakdownData, setBreakdownData] = useState(null);
  const openBreakdown = async (companyName) => {
    setBreakdownFor(companyName);
    setBreakdownData(null);
    try {
      const r = await api.get('/cashflow/project-breakdown', { params: { company_name: companyName } });
      setBreakdownData(r.data);
    } catch (e) {
      toast.error('Failed to load breakdown');
      setBreakdownFor(null);
    }
  };

  const load = () => {
    api.get('/cashflow/projects').then(r => { setProjects(r.data.projects); setSummary(r.data.summary); }).catch(() => {});
    api.get('/cashflow/summary', { params: { date: selectedDate } }).then(r => setDailySummary(r.data)).catch(() => {});
    api.get(`/cashflow/entries/${selectedDate}`).then(r => setEntries(r.data)).catch(() => {});
  };
  useEffect(() => { load(); }, [selectedDate]);

  const saveEntry = async (e) => {
    e.preventDefault();
    await api.post('/cashflow/entry', { ...form, date: form.date || selectedDate });
    toast.success('Entry added'); setModal(false); load();
  };

  // Edit the Opening balance for the selected date. The server cascades the new
  // opening through all following days (mam 2026-06-27).
  const saveOpening = async () => {
    const v = +openingInput;
    if (!Number.isFinite(v)) return toast.error('Enter a valid amount');
    try {
      await api.post('/cashflow/opening-balance', { date: selectedDate, opening_balance: v });
      toast.success('Opening updated');
      setEditingOpening(false);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to update opening'); }
  };

  const deleteEntry = async (id) => {
    if (!confirm('Delete?')) return;
    await api.delete(`/cashflow/entry/${id}`); toast.success('Deleted'); load();
  };

  const inflowCategories = ['Collection', 'Advance Received', 'Milestone Payment', 'Handover Payment', 'Delivery Payment', 'Refund', 'Other Income'];
  const outflowCategories = ['Indent Payment', 'Vendor Payment', 'Salary', 'Rent', 'Transport', 'TA/DA', 'Labour', 'Office Expense', 'Tax', 'EMI', 'Other'];
  const fmt = (n) => `Rs ${(n || 0).toLocaleString('en-IN')}`;

  // Strip CSV-import quote artifacts ("""M/s X""") and trailing
  // whitespace from project names so the tracker reads clean.
  const cleanName = (s) => (s || '').replace(/^[\s"'`]+|[\s"'`]+$/g, '').replace(/\s+/g, ' ').trim();
  // Compact date: '2026-05-05' → '5 May'
  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${d.getDate()} ${months[d.getMonth()]}`;
  };
  // Soft dash for empty cells
  const dash = <span className="text-gray-300">—</span>;
  // Mam wants amounts shown in full Indian-format rupees (e.g. 40,00,000)
  // not the compact "40.00L" lakh form. Keeping fmtL as an alias of fmt
  // so existing call sites work without churn — every amount renders the
  // same way: comma-separated full number.
  const fmtL = (n) => fmt(n);

  // Compute days-since-last-payment for a project — same logic as the
  // 'Last Pmt Date' column. Returns null if no Inv Days and no Total Days.
  const daysSinceLastPmt = (p) => {
    const live = p.live_date ? new Date(p.live_date) : null;
    if (!live || isNaN(live)) return null;
    const days = +p.payment_investment_days > 0
      ? +p.payment_investment_days
      : (+p.total_days > 0 ? +p.total_days : null);
    return days;
  };

  // The actual Last Payment Date as YYYY-MM-DD (or null), reusing the
  // same calc shown in the 'Last Pmt Date' column. Used by the From/To
  // filter so what mam sees in the column matches what the filter uses.
  const lastPmtDateIso = (p) => {
    const live = p.live_date ? new Date(p.live_date) : null;
    if (!live || isNaN(live)) return null;
    const d = daysSinceLastPmt(p);
    if (!d) return null;
    return new Date(live.getTime() - d * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  };

  const filtered = projects.filter(p => {
    if (crmFilter && !(p.crm_person || '').toLowerCase().includes(crmFilter.toLowerCase())) return false;
    if (search && !(p.project_name || '').toLowerCase().includes(search.toLowerCase()) && !(p.crm_person || '').toLowerCase().includes(search.toLowerCase())) return false;
    if (pmtAgeFilter) {
      const d = daysSinceLastPmt(p);
      if (pmtAgeFilter === 'never' && d !== null) return false;
      if (pmtAgeFilter === 'recent' && (d === null || d > 30)) return false;
      if (pmtAgeFilter === '30-60' && (d === null || d <= 30 || d > 60)) return false;
      if (pmtAgeFilter === '60-90' && (d === null || d <= 60 || d > 90)) return false;
      if (pmtAgeFilter === '90plus' && (d === null || d <= 90)) return false;
    }
    // Date-range filter: keep only rows whose computed Last Payment Date
    // falls inside [pmtFromDate, pmtToDate]. Either bound is optional.
    if (pmtFromDate || pmtToDate) {
      const lpd = lastPmtDateIso(p);
      if (!lpd) return false;
      if (pmtFromDate && lpd < pmtFromDate) return false;
      if (pmtToDate && lpd > pmtToDate) return false;
    }
    return true;
  });

  const saveManualFields = async (projectId) => {
    try {
      await api.post(`/cashflow/projects/${projectId}/update`, editForm);
      toast.success('Updated'); setEditRow(null); load();
    } catch { toast.error('Failed'); }
  };

  // Get unique CRM persons
  const crmPersons = [...new Set(projects.map(p => p.crm_person).filter(Boolean))];

  return (
    <div className="space-y-4">
      {/* Sticky toolbar — keeps tabs / cards / filters visible while
          scrolling the project list. Styles live in `.sticky-toolbar`
          (index.css) so every page can opt in with one class. */}
      <div className="sticky-toolbar">
        <div className="flex gap-2 flex-wrap items-center justify-between">
          <div className="flex gap-2 flex-wrap">
            <button onClick={() => setTab('projects')} className={`btn ${tab === 'projects' ? 'btn-primary' : 'btn-secondary'} text-sm`}>Project Finance</button>
            <button onClick={() => setTab('daily')} className={`btn ${tab === 'daily' ? 'btn-primary' : 'btn-secondary'} text-sm`}>Daily Cash Flow</button>
          </div>
          {/* Export current tab to CSV (opens in Excel).  Project tab
              dumps the tracker; Daily tab dumps today's entries. */}
          <button onClick={() => {
            if (tab === 'projects') {
              exportCsv('cashflow-projects',
                ['Sr','Project','CRM','Sale (with GST)','Received','Milestone','AR Cleared','Aanchal','Purchase','Velocity','Live','Inv Days','Compl','Pmt','Total'],
                filtered.map(p => [p.sr_no, p.project_name, p.crm_person, (p.po_amount || (p.sale_amount || 0) * 1.18), p.amount_received, p.milestone_name, p.ar_cleared_value, p.aanchal_value, p.purchase_value, p.cash_velocity, p.live_date, p.payment_investment_days, p.completion_days, p.payment_days, p.total_days]));
            } else {
              exportCsv(`cashflow-entries-${selectedDate}`,
                ['Type','Category','Description','Party','Amount'],
                entries.map(e => [e.type, e.category, e.description, e.party_name, e.amount]));
            }
          }} className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload /> Export Excel</button>
        </div>
        {tab === 'projects' && (
          <>
            {summary && (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                <div className="card p-3 border-l-4 border-red-500"><p className="text-xs text-gray-500">Total Projects</p><p className="text-2xl font-bold">{summary.projectCount}</p></div>
                <div className="card p-3 border-l-4 border-emerald-500"><p className="text-xs text-gray-500" title="Sum of Sale ₹ (with GST) across all projects — matches the Sale ₹ column total">Total Sale Value (with GST)</p><p className="text-xl font-bold text-emerald-600">{fmtL(summary.totalSale)}</p></div>
                <div className="card p-3 border-l-4 border-amber-500"><p className="text-xs text-gray-500">Total Received</p><p className="text-xl font-bold text-amber-600">{fmtL(summary.totalReceived)}</p></div>
                {/* Mam (2026-05-22): new AR Cleared tile — sum of the
                    new ar_cleared_value column across all projects. */}
                <div className="card p-3 border-l-4 border-cyan-500"><p className="text-xs text-gray-500" title="Sum of AR Cleared values entered by CRM on each row">Total AR Cleared</p><p className="text-xl font-bold text-cyan-600">{fmtL(summary.totalArCleared || 0)}</p></div>
                {/* Total Value = sum of Aanchal Values across all projects.
                    Comes from the backend already pre-multiplied to rupees. */}
                <div className="card p-3 border-l-4 border-blue-500"><p className="text-xs text-gray-500">Total Value</p><p className="text-xl font-bold text-blue-600">{fmtL(summary.totalValue)}</p></div>
                <div className="card p-3 border-l-4 border-red-500"><p className="text-xs text-gray-500">Total Purchase</p><p className="text-xl font-bold text-red-600">{fmtL(summary.totalPurchase)}</p></div>
              </div>
            )}
            {/* CRM Filter — admin only. Non-admin CRM users see just their own projects (backend-scoped). */}
            {isAdmin() && (
              <div className="flex gap-2 flex-wrap items-center">
                <button onClick={() => setCrmFilter('')} className={`btn ${!crmFilter ? 'btn-primary' : 'btn-secondary'} text-xs`}>All ({projects.length})</button>
                {crmPersons.map(c => (
                  <button key={c} onClick={() => setCrmFilter(c)} className={`btn ${crmFilter === c ? 'btn-primary' : 'btn-secondary'} text-xs`}>{c} ({projects.filter(p => (p.crm_person || '').toLowerCase() === c.toLowerCase()).length})</button>
                ))}
              </div>
            )}
            {/* Search + Last-Payment-Date filters row */}
            <div className="flex flex-wrap gap-3 items-end">
              <div className="relative flex-1 min-w-[260px]">
                <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                <input className="input pl-10" placeholder="Search project..." value={search} onChange={e => setSearch(e.target.value)} />
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <div>
                  <label className="text-[10px] text-gray-500 uppercase block mb-0.5">Bucket</label>
                  <select className="select text-sm" value={pmtAgeFilter} onChange={e => setPmtAgeFilter(e.target.value)}>
                    <option value="">All</option>
                    <option value="recent">≤ 30 days</option>
                    <option value="30-60">31–60 days</option>
                    <option value="60-90">61–90 days</option>
                    <option value="90plus">90+ days (overdue)</option>
                    <option value="never">Never received</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-gray-500 uppercase block mb-0.5">From</label>
                  <input type="date" className="input text-sm" value={pmtFromDate} onChange={e => setPmtFromDate(e.target.value)} title="Last Payment Date — from" />
                </div>
                <div>
                  <label className="text-[10px] text-gray-500 uppercase block mb-0.5">To</label>
                  <input type="date" className="input text-sm" value={pmtToDate} onChange={e => setPmtToDate(e.target.value)} title="Last Payment Date — to" />
                </div>
                {(pmtAgeFilter || pmtFromDate || pmtToDate) && (
                  <button
                    onClick={() => { setPmtAgeFilter(''); setPmtFromDate(''); setPmtToDate(''); }}
                    className="text-[11px] text-gray-500 hover:text-red-600 underline self-end mb-1"
                    title="Clear all Last-Payment filters"
                  >clear</button>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {tab === 'projects' && (
        <>
          <div className="card p-0 overflow-hidden">
            <div className="p-3 border-b bg-gradient-to-r from-blue-50 to-amber-50 flex items-center justify-between">
              <div>
                <h4 className="font-bold text-red-800">All New Projects · Financial Tracker</h4>
                <p className="text-[11px] text-gray-500 mt-0.5">Click any row's pencil to edit · totals auto-update at bottom</p>
              </div>
              <div className="text-[11px] text-gray-500">{filtered.length} projects</div>
            </div>
            {/* Bounded scroll wrapper so the column header can stay
                pinned while the user scrolls through 30+ projects.
                Mam (2026-05-13): "look at when header is hide its not
                good user interface".  Local to this one table — no
                global sticky/freeze classes (those caused the layered
                jumble that got rolled back in f8360e1). */}
            <div className="overflow-auto max-h-[70vh] border-t border-gray-200"><table className="min-w-[1200px] text-xs cf-tracker-table">
              <thead className="sticky top-0 z-10">
                <tr className="bg-gray-100 text-[10px] uppercase text-gray-600">
                  <th className="px-2 py-2 bg-gray-100">Sr</th>
                  <th className="px-2 py-2 text-left bg-gray-100 min-w-[200px]">Project</th>
                  <th className="px-2 py-2 text-left">CRM</th>
                  <th className="px-2 py-2 text-right" title="Sale value with 18% GST — auto-computed from Business Book (Sale × 1.18)">Sale ₹ (with GST)</th>
                  <th className="px-2 py-2 text-right" title="Amount actually received from client so far">Received ₹</th>
                  <th className="px-2 py-2 text-center" title="Current milestone — handover / delivery / etc.">Milestone</th>
                  {/* Mam (2026-05-22): AR Cleared column between
                      Milestone and Aanchal — CRM enters how much
                      receivable has been cleared per project. */}
                  <th className="px-2 py-2 text-right" title="AR Cleared — how much of the receivable has been cleared (raw rupees)">AR Cleared ₹</th>
                  <th className="px-2 py-2 text-right" title="Aanchal value — enter the exact rupee figure (no lakhs conversion)">Aanchal ₹</th>
                  <th className="px-2 py-2 text-right" title="Total purchase / cost spent on this project">Purchase ₹</th>
                  <th className="px-2 py-2 text-right" title="Cash velocity = received ÷ purchase. ≥1 means we're cash-positive">Velocity</th>
                  <th className="px-2 py-2 text-center" title="Project go-live date">Live</th>
                  <th className="px-2 py-2 text-right" title="Payment-investment days (manual)">Inv Days</th>
                  <th className="px-2 py-2 text-right" title="Completion days (manual override available)">Compl.</th>
                  <th className="px-2 py-2 text-right" title="Payment days (manual)">Pmt</th>
                  <th className="px-2 py-2 text-right font-bold" title="Total = Completion + Payment">Total</th>
                  <th className="px-2 py-2 text-center" title="Last payment received date — auto-calculated as Live - Inv Days. Updates the moment you save Inv Days / Completion / Payment days.">Last Pmt Date</th>
                  <th className="px-2 py-2 text-center w-16"></th>
                </tr>
              </thead>
              <tbody>{filtered.map(p => {
                const editing = editRow === p.id;
                return (
                <tr key={p.id} className={`border-b transition-colors ${editing ? 'bg-amber-50' : 'bg-white hover:bg-red-50/40'}`}>
                  <td className={`px-2 py-2 font-bold text-gray-400 ${editing ? 'bg-amber-50' : 'bg-white'}`}>{p.sr_no}</td>
                  <td className={`px-2 py-2 font-semibold text-red-700 max-w-[260px] ${editing ? 'bg-amber-50' : 'bg-white'}`} title={`${cleanName(p.project_name)}${p.bb_entry_count > 1 ? ` — sum of ${p.bb_entry_count} Business Book entries` : ''}`}>
                    <div className="truncate">{cleanName(p.project_name)}</div>
                    {p.bb_entry_count > 1 && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); openBreakdown(p.project_name); }}
                        className="text-[9px] font-normal text-blue-600 hover:text-blue-800 underline normal-case"
                        title="Click to see which BB rows feed this total"
                      >
                        {p.bb_entry_count} BB entries summed → drill-down
                      </button>
                    )}
                  </td>
                  {editing ? (
                    <td className="px-1 py-1"><input className="input text-xs w-24" value={editForm.crm_person||''} onChange={e=>setEditForm({...editForm,crm_person:e.target.value})} /></td>
                  ) : (
                    <td className="px-2 py-2">{p.crm_person ? (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${(p.crm_person).toLowerCase().includes('sushila') ? 'bg-gray-800 text-white' : (p.crm_person).toLowerCase().includes('lovely') ? 'bg-amber-500 text-white' : 'bg-gray-200 text-gray-700'}`}>{p.crm_person}</span>
                    ) : dash}</td>
                  )}
                  {/* Sale ₹ now shows the PO-with-GST amount directly
                      (mam, 2026-05-21: "on sales amt i need po with gst
                      amount you create extra column" — drop the extra
                      column, fold its value into Sale).  Falls back to
                      sale_amount × 1.18 if bb.po_amount is missing on
                      legacy rows. */}
                  <td className="px-2 py-2 text-right font-semibold text-red-600 tabular-nums" title="Sale × 1.18 (with GST), source: Business Book">
                    {p.po_amount > 0
                      ? fmtL(p.po_amount)
                      : p.sale_amount > 0
                        ? fmtL(Math.round(p.sale_amount * 1.18 * 100) / 100)
                        : dash}
                  </td>
                  {editing ? (<>
                    <td className="px-1 py-1"><input className="input text-xs w-24" type="number" value={editForm.amount_received||''} onChange={e=>setEditForm({...editForm,amount_received:+e.target.value})} /></td>
                    <td className="px-1 py-1"><select className="input text-xs w-24" value={editForm.milestone_name||''} onChange={e=>setEditForm({...editForm,milestone_name:e.target.value})}><option value="">—</option><option>milestone</option><option>handover</option><option>delivery</option></select></td>
                    {/* Mam (2026-05-22): AR Cleared edit input */}
                    <td className="px-1 py-1"><input className="input text-xs w-20" type="number" value={editForm.ar_cleared_value||''} onChange={e=>setEditForm({...editForm,ar_cleared_value:+e.target.value})} placeholder="₹ amount" /></td>
                    <td className="px-1 py-1"><input className="input text-xs w-20" type="number" value={editForm.aanchal_value||''} onChange={e=>setEditForm({...editForm,aanchal_value:+e.target.value})} placeholder="₹ amount" /></td>
                  </>) : (<>
                    <td className="px-2 py-2 text-right font-medium text-emerald-700 tabular-nums">{p.amount_received > 0 ? fmt(p.amount_received) : dash}</td>
                    <td className="px-2 py-2 text-center">{p.milestone_name ? (
                      <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">{p.milestone_name}</span>
                    ) : dash}</td>
                    {/* Mam (2026-05-22): AR Cleared cell — raw rupees */}
                    <td className="px-2 py-2 text-right font-medium text-cyan-700 tabular-nums">{p.ar_cleared_value > 0 ? fmt(p.ar_cleared_value) : dash}</td>
                    {/* Aanchal — stored as raw rupees from 2026-05-15 onwards.
                        Mam: "if i enter 10 then 10". Multiplier × 1,00,000
                        was removed so input and display match 1:1.  Any
                        historical rows that were stored in lakhs will look
                        small now; mam can re-edit them with the actual
                        rupee figure. */}
                    <td className="px-2 py-2 text-right font-semibold tabular-nums">{p.aanchal_value > 0 ? fmt(p.aanchal_value) : dash}</td>
                  </>)}
                  {editing ? (
                    <td className="px-1 py-1"><input className="input text-xs w-24" type="number" value={editForm.manual_purchase_value||''} onChange={e=>setEditForm({...editForm,manual_purchase_value:+e.target.value})} /></td>
                  ) : (
                    <td className="px-2 py-2 text-right font-semibold text-red-600 tabular-nums">{p.purchase_value > 0 ? fmtL(p.purchase_value) : dash}</td>
                  )}
                  <td className={`px-2 py-2 text-right font-bold tabular-nums ${p.cash_velocity >= 1 ? 'text-emerald-600' : p.cash_velocity > 0 ? 'text-amber-600' : 'text-gray-300'}`}>
                    {p.cash_velocity > 0 ? (
                      <span className="inline-flex items-center gap-1">
                        <span className={`w-1.5 h-1.5 rounded-full ${p.cash_velocity >= 1 ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
                        {p.cash_velocity.toFixed(2)}
                      </span>
                    ) : dash}
                  </td>
                  <td className="px-2 py-2 text-center text-[10px] text-gray-500 whitespace-nowrap" title={p.live_date}>{fmtDate(p.live_date)}</td>
                  {editing ? (
                    <td className="px-1 py-1"><input className="input text-xs w-14" type="number" value={editForm.payment_investment_days||''} onChange={e=>setEditForm({...editForm,payment_investment_days:+e.target.value})} /></td>
                  ) : (
                    <td className="px-2 py-2 text-right tabular-nums">{p.payment_investment_days || dash}</td>
                  )}
                  {editing ? (
                    <td className="px-1 py-1"><input className="input text-xs w-14" type="number" value={editForm.manual_completion_days||''} onChange={e=>setEditForm({...editForm,manual_completion_days:+e.target.value})} /></td>
                  ) : (
                    <td className="px-2 py-2 text-right tabular-nums">{p.completion_days || dash}</td>
                  )}
                  {editing ? (
                    <td className="px-1 py-1"><input className="input text-xs w-14" type="number" value={editForm.payment_days||''} onChange={e=>setEditForm({...editForm,payment_days:+e.target.value})} /></td>
                  ) : (
                    <td className="px-2 py-2 text-right tabular-nums">{p.payment_days || dash}</td>
                  )}
                  <td className="px-2 py-2 text-right font-bold text-base text-gray-800 tabular-nums">{p.total_days || dash}</td>
                  {/* Last Payment Date — FROZEN on entry (Option A,
                      mam's pick 2026-05-15).  Stored as
                      project_finance.last_payment_target_date in the
                      backend; locked the moment Compl + Pmt days are
                      saved and never auto-shifts with the calendar.
                      Only recomputes when mam re-edits Compl/Pmt days.
                      Falls back to legacy inline compute for legacy
                      rows missing the column (one-time backfill on
                      first load via GET /projects/dashboard). */}
                  <td className="px-2 py-2 text-center text-[11px] text-blue-700 font-semibold whitespace-nowrap">
                    {(() => {
                      if (p.last_payment_target_date) {
                        return fmtDate(p.last_payment_target_date);
                      }
                      // Legacy fallback (should rarely fire — backend backfills on read)
                      const live = p.live_date ? new Date(p.live_date) : null;
                      if (!live || isNaN(live)) return dash;
                      const daysForward = +p.payment_investment_days > 0
                        ? +p.payment_investment_days
                        : (+p.total_days > 0 ? +p.total_days : 0);
                      if (!daysForward) return dash;
                      const expected = new Date(live.getTime() + daysForward * 24 * 60 * 60 * 1000);
                      return fmtDate(expected.toISOString().slice(0, 10));
                    })()}
                  </td>
                  <td className="px-1 py-1 text-center">{editing ? (
                    <div className="flex gap-1 justify-center">
                      <button onClick={()=>saveManualFields(p.id)} className="p-1.5 bg-emerald-100 text-emerald-700 hover:bg-emerald-200 rounded" title="Save"><FiCheck size={14} /></button>
                      <button onClick={()=>setEditRow(null)} className="p-1.5 bg-gray-100 text-gray-500 hover:bg-gray-200 rounded" title="Cancel"><FiX size={14} /></button>
                    </div>
                  ) : (
                    <button onClick={()=>{setEditRow(p.id);setEditForm({crm_person:p.crm_person,amount_received:p.amount_received,milestone_name:p.milestone_name,ar_cleared_value:p.ar_cleared_value,aanchal_value:p.aanchal_value,payment_investment_days:p.payment_investment_days,payment_days:p.payment_days,manual_purchase_value:p.purchase_value,manual_completion_days:p.completion_days});}}
                            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="Edit row"><FiEdit2 size={13} /></button>
                  )}</td>
                </tr>
              );})}</tbody>
              <tfoot><tr className="bg-gray-100 font-bold text-xs border-t-2 border-gray-300">
                <td className="px-2 py-3 bg-gray-100" colSpan="3">TOTAL · {filtered.length} project{filtered.length !== 1 ? 's' : ''}</td>
                {/* Sale ₹ (with GST) total — uses bb.po_amount sum, with the
                    sale × 1.18 fallback identical to the row cell. */}
                <td className="px-2 py-3 text-right text-red-700 tabular-nums">
                  {fmtL(filtered.reduce((s, p) => s + (p.po_amount || (p.sale_amount || 0) * 1.18), 0))}
                </td>
                <td className="px-2 py-3 text-right text-emerald-700 tabular-nums">{fmt(filtered.reduce((s, p) => s + p.amount_received, 0))}</td>
                <td></td>
                {/* Mam (2026-05-22): AR Cleared total cell */}
                <td className="px-2 py-3 text-right text-cyan-700 tabular-nums">{fmt(filtered.reduce((s, p) => s + (p.ar_cleared_value || 0), 0))}</td>
                <td className="px-2 py-3 text-right tabular-nums">{fmt(filtered.reduce((s, p) => s + (p.aanchal_value || 0), 0))}</td>
                <td className="px-2 py-3 text-right text-red-700 tabular-nums">{fmtL(filtered.reduce((s, p) => s + p.purchase_value, 0))}</td>
                <td colSpan="8"></td>
              </tr></tfoot>
            </table></div>
          </div>
        </>
      )}

      {tab === 'daily' && dailySummary && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="card p-3"><LuIndianRupee className="text-red-600 inline mr-1" /><span className="text-xs text-gray-500">Opening</span>
              {editingOpening ? (
                <div className="flex items-center gap-1 mt-1">
                  <input type="number" autoFocus className="input text-sm py-1 w-28" value={openingInput}
                    onChange={e => setOpeningInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveOpening(); if (e.key === 'Escape') setEditingOpening(false); }} />
                  <button onClick={saveOpening} className="p-1 text-emerald-600 hover:bg-emerald-50 rounded" title="Save"><FiCheck size={15} /></button>
                  <button onClick={() => setEditingOpening(false)} className="p-1 text-gray-400 hover:bg-gray-100 rounded" title="Cancel"><FiX size={15} /></button>
                </div>
              ) : (
                <p className="text-lg font-bold flex items-center gap-1">{fmt(dailySummary.today.opening_balance)}
                  <button onClick={() => { setOpeningInput(String(dailySummary.today.opening_balance || 0)); setEditingOpening(true); }}
                    className="text-gray-300 hover:text-blue-600" title="Edit opening balance for this date"><FiEdit2 size={13} /></button>
                </p>
              )}
            </div>
            <div className="card p-3"><FiTrendingUp className="text-emerald-600 inline mr-1" /><span className="text-xs text-gray-500">Inflows</span><p className="text-lg font-bold text-emerald-600">+{fmt(dailySummary.today.total_inflows)}</p></div>
            <div className="card p-3"><FiTrendingDown className="text-red-600 inline mr-1" /><span className="text-xs text-gray-500">Outflows</span><p className="text-lg font-bold text-red-600">-{fmt(dailySummary.today.total_outflows)}</p></div>
            <div className="card p-3"><LuIndianRupee className="text-purple-600 inline mr-1" /><span className="text-xs text-gray-500">Closing</span><p className="text-lg font-bold text-purple-600">{fmt(dailySummary.today.closing_balance)}</p></div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2"><FiCalendar className="text-gray-400" /><input type="date" className="input w-48" value={selectedDate} onChange={e => setSelectedDate(e.target.value)} /></div>
            <button onClick={() => { setForm({ date: selectedDate, type: 'inflow', category: '', description: '', amount: 0, payment_mode: '', party_name: '' }); setModal(true); }} className="btn btn-primary flex items-center gap-2 text-sm"><FiPlus /> Add Entry</button>
          </div>
          <div className="card p-0"><table className="text-sm freeze-head"><thead><tr><th>Date</th><th>Opening</th><th className="text-emerald-600">Inflows</th><th className="text-red-600">Outflows</th><th className="text-purple-600">Closing</th></tr></thead>
            <tbody>{dailySummary.last7Days.map(d => (
              <tr key={d.id} className={d.date === selectedDate ? 'bg-red-50' : ''} onClick={() => setSelectedDate(d.date)} style={{ cursor: 'pointer' }}>
                <td className="font-medium">{d.date}</td><td>{fmt(d.opening_balance)}</td>
                <td className="text-emerald-600 font-semibold">+{fmt(d.total_inflows)}</td><td className="text-red-600 font-semibold">-{fmt(d.total_outflows)}</td>
                <td className="font-bold text-purple-600">{fmt(d.closing_balance)}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <div className="card p-0"><div className="p-3 border-b"><h4 className="font-semibold text-sm">Entries - {selectedDate}</h4></div><table className="text-sm freeze-head"><thead><tr><th>Type</th><th>Category</th><th>Description</th><th>Party</th><th>Amount</th><th></th></tr></thead>
            <tbody>{entries.map(e => (
              <tr key={e.id}><td><span className={`badge ${e.type === 'inflow' ? 'badge-green' : 'badge-red'}`}>{e.type}</span></td>
                <td>{e.category}</td><td>{e.description}</td><td>{e.party_name}</td>
                <td className={`font-semibold ${e.type === 'inflow' ? 'text-emerald-600' : 'text-red-600'}`}>{e.type === 'inflow' ? '+' : '-'}{fmt(e.amount)}</td>
                <td><button onClick={() => deleteEntry(e.id)} className="p-1 hover:bg-red-50 rounded text-red-500"><FiTrash2 size={14} /></button></td>
              </tr>
            ))}{entries.length === 0 && <tr><td colSpan="6" className="text-center py-4 text-gray-400">No entries</td></tr>}</tbody>
          </table></div>
        </>
      )}

      <Modal isOpen={modal} onClose={() => setModal(false)} title="Add Cash Flow Entry">
        <form onSubmit={saveEntry} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div><label className="label">Date</label><input className="input" type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} /></div>
            <div><label className="label">Type</label><select className="select" value={form.type} onChange={e => setForm({ ...form, type: e.target.value, category: '' })}><option value="inflow">Inflow</option><option value="outflow">Outflow</option></select></div>
            <div><label className="label">Category *</label><select className="select" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} required><option value="">Select</option>{(form.type === 'inflow' ? inflowCategories : outflowCategories).map(c => <option key={c}>{c}</option>)}</select></div>
            <div><label className="label">Amount *</label><input className="input" type="number" value={form.amount} onChange={e => setForm({ ...form, amount: +e.target.value })} required /></div>
          </div>
          <div><label className="label">Description *</label><input className="input" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} required /></div>
          <div className="grid grid-cols-2 gap-4">
            {/* Party Name — dropdown sourced from Business Book project /
                client names so every cash entry links back to a known
                project. Mam (2026-05-16): "so that last last we can
                integrate everything". Implemented as a combobox
                (input + datalist) so users can either pick from the
                list OR type free-text for non-project parties like
                Salary / Rent / Tax / Landlord. Project names are
                de-duped + sorted; sourced from the same /cashflow/projects
                feed that powers the Projects tab. */}
            <div>
              <label className="label">Party Name *</label>
              <input
                className="input"
                list="cf-party-options"
                value={form.party_name}
                onChange={e => setForm({ ...form, party_name: e.target.value })}
                placeholder="Pick project or type…"
                autoComplete="off"
                required
              />
              <datalist id="cf-party-options">
                {Array.from(new Set(
                  projects
                    .map(p => cleanName(p.project_name || p.client_name))
                    .filter(Boolean)
                )).sort((a, b) => a.localeCompare(b)).map(name => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
            <div><label className="label">Payment Mode</label><select className="select" value={form.payment_mode} onChange={e => setForm({ ...form, payment_mode: e.target.value })}><option value="">Select</option><option>Cash</option><option>Bank Transfer</option><option>UPI</option><option>Cheque</option><option>NEFT</option></select></div>
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Add</button></div>
        </form>
      </Modal>

      {/* BB Breakdown modal — opens when mam clicks "N BB entries summed"
          on a Cash Flow project row.  Lists every BB row that contributes
          to that project's totals, with sale + PO amounts + client +
          lead_no.  Flags rows where client_name differs across the
          rollup (the "company_name collides distinct clients" case
          that mam caught on SAEL today). */}
      {breakdownFor && (
        <Modal
          isOpen={true}
          onClose={() => { setBreakdownFor(null); setBreakdownData(null); }}
          title={`Breakdown · ${breakdownFor}`}
        >
          {!breakdownData ? (
            <div className="text-center py-8 text-gray-400">Loading…</div>
          ) : (
            <div className="space-y-4">
              {/* Mam (2026-05-16): "dont add po amount only business
                  order sales amt sum here".  Only the Sale total is
                  surfaced in the summary; PO / Advance columns dropped
                  from the row table too so this view stays focused on
                  what mam is reconciling — the Business Book sale
                  amount sum that feeds Cash Flow's Sale Value. */}
              <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-gray-700">
                <strong>{breakdownData.row_count} BB row{breakdownData.row_count !== 1 ? 's' : ''}</strong> roll up into this Cash Flow project.
                {breakdownData.distinct_clients > 1 && (
                  <span className="ml-2 px-2 py-0.5 bg-red-100 text-red-700 rounded text-[10px] font-semibold uppercase">
                    {breakdownData.distinct_clients} distinct clients — collision
                  </span>
                )}
                <div className="mt-1 text-gray-900 font-semibold">
                  Sale Total: {fmt(breakdownData.totals.sale)}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs border">
                  <thead className="bg-gray-100 text-gray-600">
                    <tr>
                      <th className="px-2 py-1.5 text-left">Lead</th>
                      <th className="px-2 py-1.5 text-left">Client</th>
                      <th className="px-2 py-1.5 text-right">Sale (no GST)</th>
                      <th className="px-2 py-1.5 text-left">CRM</th>
                      <th className="px-2 py-1.5 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdownData.rows.map(r => (
                      <tr key={r.id} className="border-t hover:bg-blue-50/40">
                        <td className="px-2 py-1.5 font-mono">{r.lead_no || '—'}</td>
                        <td className="px-2 py-1.5">{r.client_name || '—'}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{fmt(r.sale_amount_without_gst)}</td>
                        <td className="px-2 py-1.5 text-[10px]">{r.employee_assigned || '—'}</td>
                        <td className="px-2 py-1.5 text-[10px]">{r.status || '—'}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 bg-gray-50 font-bold">
                      <td className="px-2 py-1.5" colSpan="2">TOTAL · {breakdownData.row_count} row{breakdownData.row_count !== 1 ? 's' : ''}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-red-700">{fmt(breakdownData.totals.sale)}</td>
                      <td className="px-2 py-1.5" colSpan="2"></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-gray-500 leading-relaxed">
                Cash Flow groups BB rows by <code className="bg-gray-100 px-1">company_name</code>. If these rows look like
                <em> different </em> projects rather than one, edit them in Business Book to give each a unique company_name
                — Cash Flow will then show them as separate rows and the Sale Total mismatch goes away.
              </p>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
