// Fire NOC Renewal Module — main page (PR2+PR4 shell).
//
// Tabs:
//   Dashboard  — KPI tiles + per-stage funnel + next 7 days expiries
//   Cycles     — searchable list with stage/state/status filters
//   Create     — quick "+ New Cycle" modal (Master DB import comes in PR6)
//
// All numbers pulled from /api/fire-noc/dashboard and /api/fire-noc/cycles.
// Reuses the same UI conventions as the other 39 modules (card/p-0,
// freeze-head pattern, sticky toolbar disabled per mam's earlier
// rollback, Export Excel button, etc.).

import { useState, useEffect } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import {
  FiTarget, FiPlus, FiDownload, FiUpload, FiRefreshCw, FiEye, FiCalendar,
  FiAlertTriangle, FiCheckCircle, FiClock,
} from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { fmtDateTime } from '../utils/datetime';
import SearchableSelect from '../components/SearchableSelect';
import { STATES, DISTRICTS_BY_STATE } from '../data/indiaLocations';

const STAGE_ORDER = [
  'T-180','T-150','T-120','RESPONSE_CHECK','REENGAGE',
  'T-90','CONVERT_CHECK','LOST_POOL',
  'T-60','T-45','T-30','INSPECTION_CHECK','COMPLIANCE_FIX',
  'T-15','T-0','T+30','CYCLE_CLOSE',
];

// Stage labels — mam (2026-05-16): "t is time t-30 mean required 30
// days dont mention t-30".  Renamed every T-XX / T+XX stage to plain
// "<N> days before/after · <action>" so users see the time meaning
// directly without decoding "T-30".  Internal stage codes (the keys
// here) stay as T-180 etc. — they're the DB enum and changing them
// would need a migration; only the human-facing labels changed.
const STAGE_LABEL = {
  'T-180': '180 days before · Auto Alert',
  'T-150': '150 days before · Qualify',
  'T-120': '120 days before · Quote v1',
  'RESPONSE_CHECK': 'Response Check',
  'REENGAGE': 'Re-Engage',
  'T-90':  '90 days before · Site Visit',
  'CONVERT_CHECK': 'Convert?',
  'LOST_POOL': 'Lost · Win-Back',
  'T-60':  '60 days before · PO + 30%',
  'T-45':  '45 days before · Dept Filing',
  'T-30':  '30 days before · Inspection',
  'INSPECTION_CHECK': 'Inspection?',
  'COMPLIANCE_FIX':   'Compliance Fix',
  'T-15':  '15 days before · NOC Issued',
  'T-0':   'Expiry day · Final Pay',
  'T+30':  '30 days after · Upsell',
  'CYCLE_CLOSE': 'Closed',
};

const STAGE_COLOR = {
  'T-180': 'bg-blue-100 text-blue-700',
  'T-150': 'bg-blue-100 text-blue-700',
  'T-120': 'bg-blue-100 text-blue-700',
  'RESPONSE_CHECK': 'bg-amber-100 text-amber-700',
  'REENGAGE': 'bg-amber-100 text-amber-700',
  'T-90':  'bg-violet-100 text-violet-700',
  'CONVERT_CHECK': 'bg-amber-100 text-amber-700',
  'LOST_POOL': 'bg-red-100 text-red-700',
  'T-60':  'bg-emerald-100 text-emerald-700',
  'T-45':  'bg-emerald-100 text-emerald-700',
  'T-30':  'bg-emerald-100 text-emerald-700',
  'INSPECTION_CHECK': 'bg-amber-100 text-amber-700',
  'COMPLIANCE_FIX':   'bg-red-100 text-red-700',
  'T-15':  'bg-emerald-100 text-emerald-700',
  'T-0':   'bg-emerald-100 text-emerald-700',
  'T+30':  'bg-purple-100 text-purple-700',
  'CYCLE_CLOSE': 'bg-gray-100 text-gray-600',
};

const BUILDING_TYPES = ['hospital','school','commercial','industrial','residential','hotel','mall','other'];
const TICKET_BANDS   = ['under_5L','5L_to_25L','25L_to_1Cr','over_1Cr'];
const SOURCES        = ['rti','past_client','broker','field_scrape','manual'];

const fmt = (n) => `Rs ${(n || 0).toLocaleString('en-IN')}`;

export default function FireNoc() {
  const { canCreate } = useAuth();
  const [tab, setTab] = useUrlTab('dashboard');
  const [dashboard, setDashboard] = useState(null);
  const [cycles, setCycles] = useState([]);
  const [filters, setFilters] = useState({ state: '', stage: '', status: 'active', q: '' });
  const [loading, setLoading] = useState(false);
  const [createModal, setCreateModal] = useState(false);
  const [form, setForm] = useState({
    state: '', district: '', building_type: 'commercial', building_name: '', address: '',
    pincode: '', expiry_date: '', source: 'manual',
    decision_maker_name: '', decision_maker_phone: '', decision_maker_email: '',
    ticket_size_band: '',
  });
  const [saving, setSaving] = useState(false);

  // Bulk import (mam, 2026-05-16: "for import bulk data give option
  // excel").  importResult holds the parsed server response so we can
  // show how many rows succeeded / failed without auto-dismissing —
  // mam needs to see the failures to fix them in the next batch.
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);

  // Cycle detail drawer (mam, 2026-05-16: "if we take action on it
  // where see").  Opens on row click, shows full cycle detail +
  // timeline + action buttons (status change, owner reassign,
  // stage advance, free-text note).  PR5-lite — full Quote /
  // Inspection / Document panes still pending.
  const [drawerCycle, setDrawerCycle] = useState(null); // full detail object
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerSaving, setDrawerSaving] = useState(false);
  const [usersList, setUsersList] = useState([]);
  const [noteText, setNoteText] = useState('');

  const openCycleDrawer = async (id) => {
    setDrawerLoading(true);
    setDrawerCycle({ id, loading: true });
    try {
      const r = await api.get(`/fire-noc/cycles/${id}`);
      setDrawerCycle(r.data);
      // Lazy-load users list once for the owner dropdown
      if (usersList.length === 0) {
        try { setUsersList((await api.get('/auth/users')).data.filter(u => u.active !== 0)); } catch {}
      }
    } catch (e) {
      toast.error('Could not load cycle');
      setDrawerCycle(null);
    } finally {
      setDrawerLoading(false);
    }
  };
  const closeDrawer = () => { setDrawerCycle(null); setNoteText(''); };

  const patchCycle = async (patch) => {
    if (!drawerCycle?.id) return;
    setDrawerSaving(true);
    try {
      const r = await api.patch(`/fire-noc/cycles/${drawerCycle.id}`, patch);
      if (r.data.changes?.length) toast.success(r.data.changes.join(' · '));
      else toast('No changes', { icon: 'ℹ️' });
      await openCycleDrawer(drawerCycle.id);  // refresh
      loadCycles();  // refresh table behind
    } catch (e) {
      toast.error(e.response?.data?.error || 'Save failed');
    } finally {
      setDrawerSaving(false);
    }
  };

  const advanceStage = async (toStage) => {
    if (!drawerCycle?.id) return;
    setDrawerSaving(true);
    try {
      await api.post(`/fire-noc/cycles/${drawerCycle.id}/advance`, { to_stage: toStage });
      toast.success(`Stage → ${toStage}`);
      await openCycleDrawer(drawerCycle.id);
      loadCycles();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Advance failed');
    } finally {
      setDrawerSaving(false);
    }
  };

  const addNote = async () => {
    const n = noteText.trim();
    if (!n) return;
    setDrawerSaving(true);
    try {
      await api.post(`/fire-noc/cycles/${drawerCycle.id}/note`, { note: n });
      toast.success('Note added');
      setNoteText('');
      await openCycleDrawer(drawerCycle.id);
    } catch (e) {
      toast.error('Could not add note');
    } finally {
      setDrawerSaving(false);
    }
  };

  const downloadTemplate = async () => {
    try {
      const r = await api.get('/fire-noc/cycles/import/template', { responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url; a.download = 'fire-noc-cycles-template.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error('Could not download template');
    }
  };

  const handleImportFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';  // reset input so picking same file again re-triggers
    if (!f) return;
    setImporting(true);
    setImportResult(null);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const r = await api.post('/fire-noc/cycles/import', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setImportResult(r.data);
      const { created_count, failed_count, total_rows } = r.data;
      if (failed_count === 0) {
        toast.success(`Imported ${created_count}/${total_rows} cycles`);
      } else {
        toast(`Imported ${created_count}/${total_rows} · ${failed_count} skipped — see details`, { icon: '⚠️' });
      }
      loadDashboard(); loadCycles();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const loadDashboard = async () => {
    setLoading(true);
    try { setDashboard((await api.get('/fire-noc/dashboard')).data); }
    catch (e) { toast.error(e.response?.data?.error || 'Could not load dashboard'); }
    finally { setLoading(false); }
  };
  const loadCycles = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
      setCycles((await api.get(`/fire-noc/cycles?${params}`)).data);
    } catch (e) { toast.error('Could not load cycles'); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadDashboard(); loadCycles(); }, []);
  useEffect(() => { if (tab === 'cycles') loadCycles(); }, [filters]);

  const create = async (e) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      await api.post('/fire-noc/cycles', form);
      toast.success('Fire NOC cycle created');
      setCreateModal(false);
      setForm({ ...form, state: '', building_name: '', address: '', expiry_date: '' });
      loadDashboard();
      if (tab === 'cycles') loadCycles();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <FiTarget className="text-red-600" /> Fire NOC Renewal
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            180 days before → 30 days after · auto-pilot funnel · state-aware cycle rules · maker-checker on quotes
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => exportCsv('fire-noc-cycles',
            ['Building','Customer','State','Type','Expiry','Days Left','Stage','Status'],
            cycles.map(c => [c.building_name, c.customer_name, c.state, c.building_type, c.expiry_date, c.days_to_expiry, c.current_stage, c.status]))}
            className="btn btn-secondary flex items-center gap-2 text-sm">
            <FiDownload size={14} /> Export Excel
          </button>
          {canCreate('fire_noc') && (
            <>
              <button onClick={downloadTemplate}
                className="btn btn-secondary flex items-center gap-2 text-sm"
                title="Download .xlsx template with required columns + sample row">
                <FiDownload size={14} /> Template
              </button>
              <label className={`btn btn-secondary flex items-center gap-2 text-sm cursor-pointer ${importing ? 'opacity-50 pointer-events-none' : ''}`}
                title="Bulk import cycles from an Excel file">
                <FiUpload size={14} /> {importing ? 'Importing…' : 'Import Excel'}
                <input type="file" accept=".xlsx,.xls,.csv" onChange={handleImportFile} className="hidden" />
              </label>
              <button onClick={() => setCreateModal(true)} className="btn btn-primary flex items-center gap-2 text-sm">
                <FiPlus size={14} /> New Cycle
              </button>
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        {[
          { id: 'dashboard', label: 'Dashboard' },
          { id: 'cycles',    label: 'Cycles' },
          { id: 'rules',     label: 'State Rules' },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`btn ${tab === t.id ? 'btn-primary' : 'btn-secondary'} text-sm`}>
            {t.label}
          </button>
        ))}
        <button onClick={() => { loadDashboard(); loadCycles(); }} className="btn btn-secondary text-sm flex items-center gap-1">
          <FiRefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* ============ DASHBOARD TAB ============ */}
      {tab === 'dashboard' && dashboard && (<>
        {dashboard.kpi.active_cycles === 0 && (
          <div className="card bg-amber-50 border-l-4 border-amber-500 p-4">
            <div className="text-sm font-semibold text-amber-800">
              No Fire NOC cycles in the database yet.
            </div>
            <div className="text-xs text-amber-700 mt-1">
              Tables seeded, 9 state-cycle rules loaded, RBAC keys registered.
              Click <strong>+ New Cycle</strong> top right to create the first one,
              OR wait for PR6 (Master DB CSV import) to bulk-load from RTI / past clients.
            </div>
          </div>
        )}

        {/* KPI tiles */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="card border-l-4 border-emerald-500">
            <div className="text-[10px] uppercase text-gray-500 font-semibold">Active Cycles</div>
            <div className="text-2xl font-bold text-emerald-600 mt-1">{dashboard.kpi.active_cycles}</div>
          </div>
          <div className="card border-l-4 border-blue-500">
            <div className="text-[10px] uppercase text-gray-500 font-semibold">Pipeline Value</div>
            <div className="text-2xl font-bold text-blue-600 mt-1">{fmt(dashboard.kpi.pipeline_value)}</div>
            <div className="text-[10px] text-gray-400">stages T-120 → T-60</div>
          </div>
          <div className="card border-l-4 border-red-500">
            <div className="text-[10px] uppercase text-gray-500 font-semibold">Failed Inspections</div>
            <div className="text-2xl font-bold text-red-600 mt-1">{dashboard.kpi.failed_inspections_awaiting_fix}</div>
            <div className="text-[10px] text-gray-400">awaiting compliance fix</div>
          </div>
          <div className="card border-l-4 border-purple-500">
            <div className="text-[10px] uppercase text-gray-500 font-semibold">Renewed (lifetime)</div>
            <div className="text-2xl font-bold text-purple-600 mt-1">{dashboard.kpi.renewed_cycles}</div>
            <div className="text-[10px] text-gray-400">{dashboard.kpi.lost_cycles} lost</div>
          </div>
        </div>

        {/* Funnel — counts per stage */}
        <div className="card">
          <h3 className="font-bold text-sm text-gray-800 mb-3">Pipeline by stage</h3>
          {dashboard.kpi.active_cycles === 0 ? (
            <div className="text-xs text-gray-400 text-center py-6">Stages will populate once cycles exist.</div>
          ) : (
            <div className="space-y-1">
              {STAGE_ORDER.map(s => {
                const count = dashboard.by_stage.find(r => r.stage === s)?.cnt || 0;
                const max = Math.max(...dashboard.by_stage.map(r => r.cnt), 1);
                const width = (count / max) * 100;
                return (
                  <div key={s} className="flex items-center gap-2 text-xs">
                    <span className="w-40 text-gray-600">{STAGE_LABEL[s]}</span>
                    <div className="flex-1 bg-gray-100 rounded-full h-5 overflow-hidden">
                      <div className={`h-full ${count > 0 ? 'bg-red-500' : ''} transition-all`} style={{ width: `${width}%` }} />
                    </div>
                    <span className="w-10 text-right font-semibold tabular-nums">{count}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Next 7 days expiries */}
        <div className="card p-0">
          <div className="p-3 border-b bg-gradient-to-r from-blue-50 to-amber-50">
            <h4 className="font-bold text-blue-900">Next 7 days expiries</h4>
            <p className="text-[11px] text-gray-500">cycles whose NOC expires this week — call today</p>
          </div>
          <table>
            <thead><tr>
              <th>Building</th><th>State</th><th>Type</th><th>Customer</th>
              <th>Expiry</th><th>Days</th><th>Stage</th>
            </tr></thead>
            <tbody>
              {dashboard.next_7_days_expiries.length === 0 ? (
                <tr><td colSpan="7" className="text-center text-gray-400 py-6">Nothing expiring this week.</td></tr>
              ) : dashboard.next_7_days_expiries.map(e => {
                const days = Math.ceil((new Date(e.expiry_date) - new Date()) / 86400000);
                return (
                  <tr key={e.id}>
                    <td className="font-medium">{e.building_name || '—'}</td>
                    <td className="text-xs">{e.state}</td>
                    <td className="text-xs uppercase">{e.building_type}</td>
                    <td className="text-xs">{e.customer_name || '—'}</td>
                    <td className="text-xs font-mono">{e.expiry_date}</td>
                    <td className={`text-xs font-bold ${days < 0 ? 'text-red-600' : days < 3 ? 'text-amber-600' : 'text-gray-700'}`}>{days}d</td>
                    <td><span className={`badge ${STAGE_COLOR[e.current_stage] || 'bg-gray-100'}`}>{STAGE_LABEL[e.current_stage] || e.current_stage}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </>)}

      {/* ============ CYCLES TAB ============ */}
      {tab === 'cycles' && (<>
        <div className="card p-3 grid grid-cols-1 sm:grid-cols-5 gap-2">
          <input className="input text-sm" placeholder="Search building / address / customer..."
            value={filters.q} onChange={e => setFilters(f => ({ ...f, q: e.target.value }))} />
          <select className="select text-sm" value={filters.state} onChange={e => setFilters(f => ({ ...f, state: e.target.value }))}>
            <option value="">All states</option>
            {[...new Set(cycles.map(c => c.state))].sort().map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="select text-sm" value={filters.stage} onChange={e => setFilters(f => ({ ...f, stage: e.target.value }))}>
            <option value="">All stages</option>
            {STAGE_ORDER.map(s => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
          </select>
          <select className="select text-sm" value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="lost">Lost</option>
            <option value="renewed">Renewed</option>
            <option value="archived">Archived</option>
          </select>
          <button onClick={() => setFilters({ state: '', stage: '', status: '', q: '' })}
            className="btn btn-secondary text-sm">Clear</button>
        </div>

        <div className="card p-0">
          <table>
            <thead><tr>
              <th>Building</th><th>Customer</th><th>State</th><th>Type</th>
              <th>Expiry</th><th>Days</th><th>Stage</th><th>Status</th><th>Owner</th>
            </tr></thead>
            <tbody>
              {cycles.length === 0 ? (
                <tr><td colSpan="9" className="text-center text-gray-400 py-8">
                  {filters.q || filters.state || filters.stage ? 'No cycles match these filters.' : 'No cycles yet — click "New Cycle" to add one.'}
                </td></tr>
              ) : cycles.map(c => (
                <tr key={c.id}
                    onClick={() => openCycleDrawer(c.id)}
                    className="cursor-pointer hover:bg-red-50/40"
                    title="Click to view / edit this cycle">
                  <td className="font-medium text-blue-700 hover:underline">{c.building_name || '—'}</td>
                  <td className="text-xs">{c.customer_name || '—'}</td>
                  <td className="text-xs">{c.state}</td>
                  <td className="text-xs uppercase">{c.building_type}</td>
                  <td className="text-xs font-mono">{c.expiry_date}</td>
                  <td className={`text-xs font-bold ${c.days_to_expiry < 0 ? 'text-red-600' : c.days_to_expiry < 30 ? 'text-amber-600' : 'text-gray-700'}`}>{c.days_to_expiry}d</td>
                  <td><span className={`badge ${STAGE_COLOR[c.current_stage] || 'bg-gray-100'}`}>{STAGE_LABEL[c.current_stage] || c.current_stage}</span></td>
                  <td><span className={`badge ${c.status === 'active' ? 'badge-gray' : c.status === 'lost' ? 'bg-red-100 text-red-700' : c.status === 'renewed' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{c.status === 'archived' ? 'lapsed' : c.status}</span></td>
                  <td className="text-xs">{c.owner_name || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>)}

      {/* ============ STATE RULES TAB ============ */}
      {tab === 'rules' && dashboard && (
        <div className="card p-0">
          <div className="p-3 border-b">
            <h4 className="font-semibold text-sm">State cycle-year rules</h4>
            <p className="text-[11px] text-gray-500">Regulatory — not editable from UI. Most-specific match wins; fallback is __DEFAULT__ 5 years.</p>
          </div>
          <table>
            <thead><tr><th>State</th><th>Building type filter</th><th>Cycle years</th></tr></thead>
            <tbody>
              {dashboard.state_rules.map((r, i) => (
                <tr key={i}>
                  <td>{r.state === '__DEFAULT__' ? <em className="text-gray-500">__DEFAULT__ (fallback)</em> : r.state}</td>
                  <td>{r.building_type_filter || <span className="text-gray-400">all</span>}</td>
                  <td className="font-bold">{r.cycle_years}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* CREATE MODAL */}
      <Modal isOpen={createModal} onClose={() => setCreateModal(false)} title="New Fire NOC Cycle" wide>
        <form onSubmit={create} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">State *</label>
              <SearchableSelect
                options={STATES.map(s => ({ value: s, label: s }))}
                value={form.state} valueKey="value" displayKey="label"
                placeholder="Pick state"
                onChange={(opt) => setForm({ ...form, state: opt?.value || '', district: '' })}
              />
            </div>
            <div>
              <label className="label">Building type *</label>
              <select className="select" required value={form.building_type} onChange={e => setForm({ ...form, building_type: e.target.value })}>
                {BUILDING_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="label">District</label>
              <SearchableSelect
                options={(form.state ? (DISTRICTS_BY_STATE[form.state] || []) : []).map(d => ({ value: d, label: d }))}
                value={form.district || ''} valueKey="value" displayKey="label"
                placeholder={form.state ? 'Pick district' : 'Pick a state first'}
                onChange={(opt) => setForm({ ...form, district: opt?.value || '' })}
              />
            </div>
            <div>
              <label className="label">Building name</label>
              <input className="input" value={form.building_name} onChange={e => setForm({ ...form, building_name: e.target.value })} />
            </div>
            <div>
              <label className="label">Pincode</label>
              <input className="input" value={form.pincode} onChange={e => setForm({ ...form, pincode: e.target.value })} />
            </div>
            <div className="col-span-2">
              <label className="label">Address</label>
              <input className="input" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} />
            </div>
            <div>
              <label className="label">NOC Expiry Date *</label>
              <input type="date" className="input" required value={form.expiry_date} onChange={e => setForm({ ...form, expiry_date: e.target.value })} />
            </div>
            <div>
              <label className="label">Source</label>
              <select className="select" value={form.source} onChange={e => setForm({ ...form, source: e.target.value })}>
                {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Decision-maker name</label>
              <input className="input" value={form.decision_maker_name} onChange={e => setForm({ ...form, decision_maker_name: e.target.value })} />
            </div>
            <div>
              <label className="label">Decision-maker phone</label>
              <input className="input" value={form.decision_maker_phone} onChange={e => setForm({ ...form, decision_maker_phone: e.target.value })} />
            </div>
            <div>
              <label className="label">Decision-maker email</label>
              <input className="input" value={form.decision_maker_email} onChange={e => setForm({ ...form, decision_maker_email: e.target.value })} />
            </div>
            <div>
              <label className="label">Ticket size band</label>
              <select className="select" value={form.ticket_size_band} onChange={e => setForm({ ...form, ticket_size_band: e.target.value })}>
                <option value="">—</option>
                {TICKET_BANDS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div className="text-[11px] text-gray-500 italic bg-amber-50 border border-amber-200 rounded p-2">
            Cycle starts at the stage matching its days-to-expiry: 180-days-before stage if &gt;150d, 150-days-before if 121-150d, 120-days-before if 91-120d, etc.
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setCreateModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={saving} className="btn btn-primary">{saving ? 'Creating…' : 'Create Cycle'}</button>
          </div>
        </form>
      </Modal>

      {/* ============ CYCLE DETAIL DRAWER ============
          Slides in from the right on row click.  Action surface for
          a single cycle: change status, reassign owner, advance
          stage, add timeline note, see history. */}
      {drawerCycle && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={closeDrawer}></div>
          <div className="fixed top-0 right-0 h-full w-full sm:w-[520px] bg-white shadow-2xl z-50 overflow-y-auto">
            <div className="sticky top-0 bg-gradient-to-r from-blue-800 to-blue-950 text-white p-4 flex items-center justify-between">
              <div className="min-w-0">
                <div className="text-xs opacity-80 uppercase tracking-wider">Fire NOC Cycle #{drawerCycle.id}</div>
                <div className="font-semibold truncate" title={drawerCycle.building_name}>{drawerCycle.building_name || drawerCycle.state + ' · ' + drawerCycle.building_type}</div>
              </div>
              <button onClick={closeDrawer} className="p-2 hover:bg-white/10 rounded text-xl">×</button>
            </div>

            {drawerLoading || drawerCycle.loading ? (
              <div className="p-8 text-center text-gray-400">Loading…</div>
            ) : (
              <div className="p-4 space-y-4">
                {/* Snapshot card */}
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="bg-gray-50 border rounded p-2">
                    <div className="text-gray-500 uppercase text-[10px]">Expiry</div>
                    <div className="font-mono font-semibold">{drawerCycle.expiry_date}</div>
                    <div className={`${drawerCycle.days_to_expiry < 0 ? 'text-red-600' : drawerCycle.days_to_expiry < 30 ? 'text-amber-600' : 'text-gray-700'} font-bold`}>{drawerCycle.days_to_expiry}d</div>
                  </div>
                  <div className="bg-gray-50 border rounded p-2">
                    <div className="text-gray-500 uppercase text-[10px]">Current Stage</div>
                    <div className="font-semibold">{STAGE_LABEL[drawerCycle.current_stage] || drawerCycle.current_stage}</div>
                  </div>
                  <div className="bg-gray-50 border rounded p-2 col-span-2">
                    <div className="text-gray-500 uppercase text-[10px]">Property</div>
                    <div>{drawerCycle.address || '—'}</div>
                    <div className="text-gray-500">{drawerCycle.state} · {drawerCycle.building_type} · {drawerCycle.pincode || ''}</div>
                  </div>
                  <div className="bg-gray-50 border rounded p-2 col-span-2">
                    <div className="text-gray-500 uppercase text-[10px]">Decision Maker</div>
                    <div>{drawerCycle.decision_maker_name || '—'} · {drawerCycle.decision_maker_phone || '—'}</div>
                    <div className="text-gray-500">{drawerCycle.decision_maker_email || ''}</div>
                  </div>
                </div>

                {/* Actions */}
                <div className="border rounded p-3 space-y-3">
                  <div className="text-xs font-semibold text-gray-700 uppercase">Actions</div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <label className="space-y-1">
                      <span className="text-gray-600">Status</span>
                      <select className="select w-full" value={drawerCycle.status || 'active'} disabled={drawerSaving}
                              onChange={e => patchCycle({ status: e.target.value })}>
                        <option value="active">Active</option>
                        <option value="lost">Lost</option>
                        <option value="renewed">Renewed</option>
                        <option value="archived">Lapsed (past expiry)</option>
                      </select>
                    </label>
                    <label className="space-y-1">
                      <span className="text-gray-600">Owner</span>
                      <select className="select w-full" value={drawerCycle.owner_user_id || ''} disabled={drawerSaving}
                              onChange={e => patchCycle({ owner_user_id: e.target.value || null })}>
                        <option value="">— Unassigned —</option>
                        {usersList.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </select>
                    </label>
                    <label className="space-y-1 col-span-2">
                      <span className="text-gray-600">Advance to stage</span>
                      <select className="select w-full" value="" disabled={drawerSaving}
                              onChange={e => { if (e.target.value) advanceStage(e.target.value); }}>
                        <option value="">— Pick a stage —</option>
                        {STAGE_ORDER.map(s => <option key={s} value={s} disabled={s === drawerCycle.current_stage}>{STAGE_LABEL[s] || s}{s === drawerCycle.current_stage ? ' · current' : ''}</option>)}
                      </select>
                    </label>
                  </div>
                  <div className="space-y-1">
                    <span className="text-xs text-gray-600">Add note (free text)</span>
                    <div className="flex gap-2">
                      <input type="text" className="input flex-1 text-xs" value={noteText} placeholder="e.g. called customer, will revert next week"
                             onChange={e => setNoteText(e.target.value)}
                             onKeyDown={e => { if (e.key === 'Enter') addNote(); }} disabled={drawerSaving} />
                      <button onClick={addNote} disabled={drawerSaving || !noteText.trim()} className="btn btn-secondary text-xs">Add</button>
                    </div>
                  </div>
                </div>

                {/* Timeline */}
                <div>
                  <div className="text-xs font-semibold text-gray-700 uppercase mb-2">Timeline ({drawerCycle.history?.length || 0})</div>
                  {(!drawerCycle.history || drawerCycle.history.length === 0) ? (
                    <div className="text-xs text-gray-400 text-center py-4">No history yet</div>
                  ) : (
                    <div className="space-y-2">
                      {[...drawerCycle.history].reverse().map(h => (
                        <div key={h.id} className="border-l-2 border-red-300 pl-3 py-1 text-xs">
                          <div className="text-gray-500 text-[10px]">{fmtDateTime(h.entered_at)}</div>
                          <div className="font-medium">
                            {h.from_stage === h.to_stage
                              ? <span className="text-gray-600">{h.notes || `stayed at ${h.to_stage}`}</span>
                              : <><span className="text-gray-400">{h.from_stage || '—'} → </span><span className="text-red-700">{h.to_stage}</span></>
                            }
                          </div>
                          {h.from_stage !== h.to_stage && h.notes && <div className="text-gray-500 italic">{h.notes}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Bulk import result — opens automatically when the import POST
          returns.  Shows total / created / failed counts plus the
          first 50 failed rows so mam can fix and re-upload.  Does
          NOT auto-dismiss: failures need attention. */}
      {importResult && (
        <Modal isOpen={true} onClose={() => setImportResult(null)} title="Import result" wide>
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-gray-50 border border-gray-200 rounded p-3 text-center">
                <div className="text-2xl font-bold text-gray-700">{importResult.total_rows}</div>
                <div className="text-[10px] uppercase text-gray-500 mt-1">Total rows</div>
              </div>
              <div className="bg-emerald-50 border border-emerald-200 rounded p-3 text-center">
                <div className="text-2xl font-bold text-emerald-700">{importResult.created_count}</div>
                <div className="text-[10px] uppercase text-emerald-600 mt-1">Created</div>
              </div>
              <div className="bg-red-50 border border-red-200 rounded p-3 text-center">
                <div className="text-2xl font-bold text-red-700">{importResult.failed_count}</div>
                <div className="text-[10px] uppercase text-red-600 mt-1">Failed</div>
              </div>
            </div>

            {importResult.failed_count > 0 && (
              <div>
                <div className="text-xs font-semibold text-red-700 mb-1">Failed rows (first 50)</div>
                <div className="overflow-x-auto border rounded">
                  <table className="w-full text-xs">
                    <thead className="bg-red-50 text-red-700">
                      <tr>
                        <th className="px-2 py-1.5 text-left">Excel Row</th>
                        <th className="px-2 py-1.5 text-left">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importResult.failed.slice(0, 50).map((f, i) => (
                        <tr key={i} className="border-t">
                          <td className="px-2 py-1.5 font-mono">{f.row}</td>
                          <td className="px-2 py-1.5">{f.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <p className="text-[10px] text-gray-500">
              Fix the failed rows in the same Excel and upload again — the successful rows already created
              won't be touched. Use the <strong>Template</strong> button for the exact column format.
            </p>
            <div className="flex justify-end">
              <button onClick={() => setImportResult(null)} className="btn btn-primary text-sm">Done</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
