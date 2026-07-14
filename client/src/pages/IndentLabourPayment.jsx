// Indent Labour Payment — full project execution + billing pipeline.
// Mam (2026-06-01, amended 2026-06-02): Projects are manually entered
// with a unique name.  Each project owns three labour spend streams:
//   L1 Salary       — legacy bulk + ongoing monthly entries
//   L2 Daily Wages  — legacy bulk + per_day_rate × days_required entries
//   L3 Sub-contract — Work Orders with file upload + value + amount paid
// Budget = L1 + L2 + L3 running total per project.

import { useState, useEffect, useMemo } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import {
  FiClipboard, FiSearch, FiBriefcase, FiUsers, FiTool, FiBookOpen,
  FiDollarSign, FiTrendingUp, FiPlus, FiTrash2, FiEdit2, FiUpload,
  FiExternalLink,
} from 'react-icons/fi';
import { fmtDate } from '../utils/datetime';

const fmtINR = (n) => {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1e7) return `${v < 0 ? '-' : ''}₹${(Math.abs(v) / 1e7).toFixed(2)} cr`;
  if (Math.abs(v) >= 1e5) return `${v < 0 ? '-' : ''}₹${(Math.abs(v) / 1e5).toFixed(2)} L`;
  if (Math.abs(v) >= 1e3) return `${v < 0 ? '-' : ''}₹${(Math.abs(v) / 1e3).toFixed(1)} K`;
  return `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
};
const fmtINRFull = (n) => `₹${Math.round(Number(n || 0)).toLocaleString('en-IN')}`;

const TABS = [
  { id: 'projects',  label: 'Projects',     icon: FiBriefcase, phase: 1 },
  { id: 'mb',        label: 'MB / CDPR',    icon: FiBookOpen,  phase: 5 },
  { id: 'rabills',   label: 'RA Bills',     icon: FiDollarSign, phase: 6 },
  { id: 'dashboard', label: 'Dashboard',    icon: FiTrendingUp, phase: 6 },
];

export default function IndentLabourPayment() {
  const [tab, setTab] = useUrlTab('projects');

  return (
    <div className="space-y-4 p-3 sm:p-4">
      <div className="bg-gradient-to-br from-indigo-900 to-indigo-950 text-white rounded-xl p-4 shadow-lg">
        <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
          <FiClipboard /> Indent Labour Payment
        </h1>
        <p className="text-indigo-200 text-xs sm:text-sm mt-0.5">
          Project Execution &amp; Billing — each project owns Salary (L1) + Daily Wages (L2) + Sub-contract WOs (L3).
        </p>
      </div>

      <div className="flex gap-2 flex-wrap">
        {TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`btn ${active ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5 text-sm`}>
              <Icon size={14} /> {t.label}
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
                active ? 'bg-white text-indigo-700' : 'bg-gray-200 text-gray-600'
              }`}>P{t.phase}</span>
            </button>
          );
        })}
      </div>

      {tab === 'projects' && <ProjectsTab />}
      {tab !== 'projects' && (
        <PhaseStub
          phase={TABS.find(t => t.id === tab)?.phase}
          label={TABS.find(t => t.id === tab)?.label}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// PROJECTS TAB — list + create + click-into detail
// ═══════════════════════════════════════════════════════════════
function ProjectsTab() {
  const [rows, setRows] = useState([]);
  const [owners, setOwners] = useState([]);
  const [q, setQ] = useState('');
  const [owner, setOwner] = useState('');
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);

  const load = () => {
    setLoading(true);
    api.get('/indent-labour-payment/projects', { params: { q: q || undefined, owner: owner || undefined } })
      .then(r => setRows(r.data || []))
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load projects'))
      .finally(() => setLoading(false));
    api.get('/indent-labour-payment/owners').then(r => setOwners(r.data || [])).catch(() => {});
  };
  useEffect(load, [q, owner]);

  const totals = useMemo(() => rows.reduce((acc, r) => {
    acc.l1 += Number(r.l1 || 0);
    acc.l2 += Number(r.l2 || 0);
    acc.l3 += Number(r.l3 || 0);
    acc.work_orders += Number(r.work_order_count || 0);
    return acc;
  }, { l1: 0, l2: 0, l3: 0, work_orders: 0 }), [rows]);
  const totalBudget = totals.l1 + totals.l2 + totals.l3;

  return (
    <div className="space-y-3">
      {/* Filter + add */}
      <div className="card p-3 flex gap-3 flex-wrap items-end">
        <div className="flex-1 min-w-[220px]">
          <label className="text-xs text-gray-600 block mb-1">Search project / notes</label>
          <div className="relative">
            <FiSearch size={12} className="absolute left-2 top-2.5 text-gray-400" />
            <input value={q} onChange={e => setQ(e.target.value)}
              placeholder="Start typing…"
              className="border rounded pl-7 pr-2 py-1.5 text-sm w-full" />
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-600 block mb-1">Owner</label>
          <select value={owner} onChange={e => setOwner(e.target.value)}
            className="border rounded px-2 py-1.5 text-sm">
            <option value="">All owners</option>
            {owners.map(o => <option key={o.owner} value={o.owner}>{o.owner} ({o.project_count})</option>)}
          </select>
        </div>
        <button onClick={load} className="btn btn-secondary">Refresh</button>
        <button onClick={() => setCreateOpen(true)} className="btn btn-primary flex items-center gap-1.5">
          <FiPlus size={14} /> New Project
        </button>
      </div>

      {/* Roll-up tiles — L1 + L2 + L3 + Total Budget */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Tile label="Projects"          value={rows.length}             color="indigo" />
        <Tile label="L1 Salary"         value={fmtINR(totals.l1)}       color="emerald" />
        <Tile label="L2 Daily Wages"    value={fmtINR(totals.l2)}       color="amber" />
        <Tile label="L3 Sub-contract"   value={fmtINR(totals.l3)}       color="blue" />
        <Tile label="Total Budget"      value={fmtINR(totalBudget)}     color="violet" />
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="freeze-head w-full text-sm">
          <thead>
            <tr>
              <th className="text-left">Project</th>
              <th className="text-left">Owner</th>
              <th className="text-right">L1 Salary</th>
              <th className="text-right">L2 Daily</th>
              <th className="text-right">L3 Sub-con</th>
              <th className="text-right">Budget</th>
              <th className="text-right">WOs</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (<tr><td colSpan={8} className="text-center py-6 text-gray-400">Loading…</td></tr>)}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={8} className="text-center py-8 text-gray-400">
                No projects yet — click <strong>New Project</strong> to create one.
              </td></tr>
            )}
            {!loading && rows.map(r => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="font-semibold">{r.name}</td>
                <td>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-semibold">
                    {r.owner}
                  </span>
                </td>
                <td className="text-right text-emerald-700">{fmtINR(r.l1)}</td>
                <td className="text-right text-amber-700">{fmtINR(r.l2)}</td>
                <td className="text-right text-blue-700">{fmtINR(r.l3)}</td>
                <td className="text-right font-bold text-violet-700">{fmtINR(r.budget)}</td>
                <td className="text-right">{r.work_order_count}</td>
                <td>
                  <button onClick={() => setDetailId(r.id)} className="text-xs text-blue-600 hover:underline">
                    Open →
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {createOpen && (
        <CreateProjectModal
          onClose={() => setCreateOpen(false)}
          onCreated={(newId) => { setCreateOpen(false); load(); setDetailId(newId); }}
        />
      )}

      {detailId && (
        <ProjectDetailModal
          projectId={detailId}
          onClose={() => { setDetailId(null); load(); }}
        />
      )}
    </div>
  );
}

function Tile({ label, value, color }) {
  const colors = {
    indigo:  { border: 'border-indigo-500',  text: 'text-indigo-700'  },
    emerald: { border: 'border-emerald-500', text: 'text-emerald-700' },
    amber:   { border: 'border-amber-500',   text: 'text-amber-700'   },
    blue:    { border: 'border-blue-500',    text: 'text-blue-700'    },
    violet:  { border: 'border-violet-500',  text: 'text-violet-700'  },
  };
  const c = colors[color] || colors.indigo;
  return (
    <div className={`card text-center border-l-4 py-2 ${c.border}`}>
      <div className={`text-xl font-bold ${c.text}`}>{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

// ─── Create Project modal ──────────────────────────────────────
function CreateProjectModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', owner: 'Aanchal', notes: '' });
  const [saving, setSaving] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { toast.error('Project name is required'); return; }
    setSaving(true);
    try {
      const r = await api.post('/indent-labour-payment/projects', form);
      toast.success('Project created');
      onCreated(r.data.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Create failed');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal isOpen={true} onClose={onClose} title="New Project">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">Project Name *</label>
          <input className="input" value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. GADVASU HVAC · Phase 2"
            required autoFocus />
          <div className="text-[10px] text-gray-500 mt-1">Must be unique across all projects.</div>
        </div>
        <div>
          <label className="label">Owner</label>
          <input className="input" value={form.owner}
            onChange={e => setForm({ ...form, owner: e.target.value })}
            placeholder="Aanchal (default)" />
        </div>
        <div>
          <label className="label">Notes</label>
          <textarea className="input" rows={2} value={form.notes}
            onChange={e => setForm({ ...form, notes: e.target.value })} />
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t">
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn btn-primary">
            {saving ? 'Saving…' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════
// PROJECT DETAIL MODAL — 3 sub-tabs for L1 / L2 / L3
// ═══════════════════════════════════════════════════════════════
function ProjectDetailModal({ projectId, onClose }) {
  const [project, setProject] = useState(null);
  const [sub, setSub] = useState('l1');

  const reload = () => {
    api.get(`/indent-labour-payment/projects/${projectId}`).then(r => setProject(r.data));
  };
  useEffect(reload, [projectId]);

  if (!project) return (
    <Modal isOpen={true} onClose={onClose} title="Loading…" wide>
      <div className="text-center py-6 text-gray-400 text-sm">Loading project…</div>
    </Modal>
  );

  return (
    <Modal isOpen={true} onClose={onClose} title={project.name} wide>
      <div className="space-y-3">
        {/* Header strip */}
        <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 grid grid-cols-2 md:grid-cols-5 gap-2 text-center">
          <div>
            <div className="text-[10px] text-gray-500 uppercase">Owner</div>
            <div className="font-semibold text-indigo-700">{project.owner}</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500 uppercase">L1 Salary</div>
            <div className="font-bold text-emerald-700">{fmtINR(project.l1)}</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500 uppercase">L2 Daily</div>
            <div className="font-bold text-amber-700">{fmtINR(project.l2)}</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500 uppercase">L3 Sub-con</div>
            <div className="font-bold text-blue-700">{fmtINR(project.l3)}</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500 uppercase">Budget</div>
            <div className="font-extrabold text-violet-700">{fmtINR(project.budget)}</div>
          </div>
        </div>

        <div className="flex gap-1.5">
          {[
            { id: 'l1', label: 'L1 Salary', icon: FiUsers },
            { id: 'l2', label: 'L2 Daily Wages', icon: FiTool },
            { id: 'l3', label: 'L3 Work Orders', icon: FiDollarSign },
          ].map(t => (
            <button key={t.id} onClick={() => setSub(t.id)}
              className={`px-3 py-1.5 rounded-lg text-sm font-semibold border ${
                sub === t.id ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200'
              }`}>
              {t.label}
            </button>
          ))}
        </div>

        {sub === 'l1' && <L1Salary projectId={projectId} onChange={reload} />}
        {sub === 'l2' && <L2DailyWages projectId={projectId} onChange={reload} />}
        {sub === 'l3' && <L3WorkOrders projectId={projectId} onChange={reload} />}

        <div className="flex justify-end pt-2 border-t">
          <button onClick={onClose} className="btn btn-secondary">Close</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── L1 Salary sub-section ─────────────────────────────────────
function L1Salary({ projectId, onChange }) {
  const [rows, setRows] = useState([]);
  const [adding, setAdding] = useState(null); // null | 'legacy' | 'monthly'

  const load = () => {
    api.get(`/indent-labour-payment/projects/${projectId}/salary`).then(r => setRows(r.data || []));
  };
  useEffect(load, [projectId]);

  const remove = async (id) => {
    if (!confirm('Delete this salary entry?')) return;
    try {
      await api.delete(`/indent-labour-payment/salary/${id}`);
      toast.success('Deleted'); load(); onChange();
    } catch (e) { toast.error(e.response?.data?.error || 'Delete failed'); }
  };

  const hasLegacy = rows.some(r => r.kind === 'legacy');

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button onClick={() => setAdding('legacy')} disabled={hasLegacy}
          className="btn btn-secondary text-xs flex items-center gap-1"
          title={hasLegacy ? 'Legacy already captured' : 'One-off pre-Sotyn.Headmasters salary spend'}>
          <FiPlus size={12} /> {hasLegacy ? '✓ Legacy captured' : 'Add Legacy Salary'}
        </button>
        <button onClick={() => setAdding('monthly')} className="btn btn-primary text-xs flex items-center gap-1">
          <FiPlus size={12} /> Add Monthly Entry
        </button>
      </div>

      <div className="overflow-x-auto border rounded">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-2 py-1.5">Kind</th>
              <th className="text-left px-2 py-1.5">Employee</th>
              <th className="text-left px-2 py-1.5">Month</th>
              <th className="text-right px-2 py-1.5">Amount</th>
              <th className="text-left px-2 py-1.5">Notes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} className="text-center py-4 text-gray-400">No salary entries yet</td></tr>}
            {rows.map(r => (
              <tr key={r.id} className="border-t">
                <td className="px-2 py-1.5">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
                    r.kind === 'legacy' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'
                  }`}>{r.kind}</span>
                </td>
                <td className="px-2 py-1.5">{r.employee_name || '—'}</td>
                <td className="px-2 py-1.5">{r.period_month || '—'}</td>
                <td className="px-2 py-1.5 text-right font-semibold">{fmtINRFull(r.amount)}</td>
                <td className="px-2 py-1.5 text-xs text-gray-600">{r.notes || '—'}</td>
                <td className="px-2 py-1.5 text-right">
                  <button onClick={() => remove(r.id)} className="text-red-500 hover:text-red-700"><FiTrash2 size={12} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding && (
        <AddSalaryEntry kind={adding} projectId={projectId}
          onClose={() => setAdding(null)}
          onSaved={() => { setAdding(null); load(); onChange(); }} />
      )}
    </div>
  );
}

function AddSalaryEntry({ kind, projectId, onClose, onSaved }) {
  const [form, setForm] = useState({
    employee_name: '',
    period_month: kind === 'monthly' ? new Date().toISOString().slice(0, 7) : '',
    amount: '',
    notes: '',
  });
  const submit = async (e) => {
    e.preventDefault();
    if (!Number(form.amount) || Number(form.amount) <= 0) { toast.error('Amount must be > 0'); return; }
    if (kind === 'monthly' && !form.period_month) { toast.error('Month required'); return; }
    try {
      await api.post(`/indent-labour-payment/projects/${projectId}/salary`, { ...form, kind, amount: Number(form.amount) });
      toast.success('Saved'); onSaved();
    } catch (err) { toast.error(err.response?.data?.error || 'Save failed'); }
  };
  return (
    <Modal isOpen={true} onClose={onClose} title={kind === 'legacy' ? 'Legacy Salary (pre-Sotyn.Headmasters carry)' : 'Monthly Salary Entry'}>
      <form onSubmit={submit} className="space-y-3">
        {kind === 'legacy' && (
          <div className="text-xs bg-amber-50 border-l-2 border-amber-400 p-2 rounded">
            One-off bulk capture of salary already spent on this project before the Sotyn.Headmasters went live.  Only one legacy row per project.
          </div>
        )}
        <div>
          <label className="label">Employee Name {kind === 'monthly' && '*'}</label>
          <input className="input" value={form.employee_name}
            onChange={e => setForm({ ...form, employee_name: e.target.value })}
            placeholder={kind === 'legacy' ? '(optional — bulk row)' : 'Staff member'} />
        </div>
        {kind === 'monthly' && (
          <div>
            <label className="label">Month *</label>
            <input type="month" className="input" value={form.period_month}
              onChange={e => setForm({ ...form, period_month: e.target.value })} required />
          </div>
        )}
        <div>
          <label className="label">Amount (₹) *</label>
          <input type="number" min="0" step="1" className="input" value={form.amount}
            onChange={e => setForm({ ...form, amount: e.target.value })} required autoFocus />
        </div>
        <div>
          <label className="label">Notes</label>
          <textarea className="input" rows={2} value={form.notes}
            onChange={e => setForm({ ...form, notes: e.target.value })} />
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t">
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

// ─── L2 Daily Wages sub-section ────────────────────────────────
function L2DailyWages({ projectId, onChange }) {
  const [rows, setRows] = useState([]);
  const [adding, setAdding] = useState(null);

  const load = () => {
    api.get(`/indent-labour-payment/projects/${projectId}/daily-wages`).then(r => setRows(r.data || []));
  };
  useEffect(load, [projectId]);

  const remove = async (id) => {
    if (!confirm('Delete this daily wage entry?')) return;
    try {
      await api.delete(`/indent-labour-payment/daily-wages/${id}`);
      toast.success('Deleted'); load(); onChange();
    } catch (e) { toast.error(e.response?.data?.error || 'Delete failed'); }
  };

  const hasLegacy = rows.some(r => r.kind === 'legacy');

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button onClick={() => setAdding('legacy')} disabled={hasLegacy}
          className="btn btn-secondary text-xs flex items-center gap-1">
          <FiPlus size={12} /> {hasLegacy ? '✓ Legacy captured' : 'Add Legacy Daily Wages'}
        </button>
        <button onClick={() => setAdding('entry')} className="btn btn-primary text-xs flex items-center gap-1">
          <FiPlus size={12} /> Add Entry (rate × days)
        </button>
      </div>

      <div className="overflow-x-auto border rounded">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-2 py-1.5">Kind</th>
              <th className="text-left px-2 py-1.5">Description</th>
              <th className="text-right px-2 py-1.5">Per Day ₹</th>
              <th className="text-right px-2 py-1.5">Days</th>
              <th className="text-right px-2 py-1.5">Total</th>
              <th className="text-left px-2 py-1.5">Notes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7} className="text-center py-4 text-gray-400">No daily wage entries yet</td></tr>}
            {rows.map(r => (
              <tr key={r.id} className="border-t">
                <td className="px-2 py-1.5">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
                    r.kind === 'legacy' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'
                  }`}>{r.kind}</span>
                </td>
                <td className="px-2 py-1.5">{r.description || '—'}</td>
                <td className="px-2 py-1.5 text-right">{r.kind === 'entry' ? fmtINRFull(r.per_day_rate) : '—'}</td>
                <td className="px-2 py-1.5 text-right">{r.kind === 'entry' ? r.days_required : '—'}</td>
                <td className="px-2 py-1.5 text-right font-semibold">{fmtINRFull(r.total_amount)}</td>
                <td className="px-2 py-1.5 text-xs text-gray-600">{r.notes || '—'}</td>
                <td className="px-2 py-1.5 text-right">
                  <button onClick={() => remove(r.id)} className="text-red-500 hover:text-red-700"><FiTrash2 size={12} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding && (
        <AddDailyWage kind={adding} projectId={projectId}
          onClose={() => setAdding(null)}
          onSaved={() => { setAdding(null); load(); onChange(); }} />
      )}
    </div>
  );
}

function AddDailyWage({ kind, projectId, onClose, onSaved }) {
  const [form, setForm] = useState({
    description: '', per_day_rate: '', days_required: '', total_amount: '', notes: '',
  });
  const computed = kind === 'entry'
    ? (Number(form.per_day_rate) || 0) * (Number(form.days_required) || 0)
    : Number(form.total_amount) || 0;
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/indent-labour-payment/projects/${projectId}/daily-wages`, {
        ...form, kind,
        per_day_rate: Number(form.per_day_rate) || 0,
        days_required: Number(form.days_required) || 0,
        total_amount: kind === 'legacy' ? Number(form.total_amount) || 0 : 0,
      });
      toast.success('Saved'); onSaved();
    } catch (err) { toast.error(err.response?.data?.error || 'Save failed'); }
  };
  return (
    <Modal isOpen={true} onClose={onClose} title={kind === 'legacy' ? 'Legacy Daily Wages (pre-Sotyn.Headmasters)' : 'Daily Wage Entry'}>
      <form onSubmit={submit} className="space-y-3">
        {kind === 'legacy' && (
          <div className="text-xs bg-amber-50 border-l-2 border-amber-400 p-2 rounded">
            One-off bulk capture of daily wages paid before the Sotyn.Headmasters went live.
          </div>
        )}
        <div>
          <label className="label">Description</label>
          <input className="input" value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
            placeholder="e.g. Mason gang · structural work" />
        </div>
        {kind === 'entry' ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Per Day Rate ₹ *</label>
                <input type="number" min="0" step="1" className="input" value={form.per_day_rate}
                  onChange={e => setForm({ ...form, per_day_rate: e.target.value })} required autoFocus />
              </div>
              <div>
                <label className="label">Days Required *</label>
                <input type="number" min="0" step="0.5" className="input" value={form.days_required}
                  onChange={e => setForm({ ...form, days_required: e.target.value })} required />
              </div>
            </div>
            <div className="bg-violet-50 border border-violet-200 p-2 rounded text-sm">
              Computed total: <strong className="text-violet-700">{fmtINRFull(computed)}</strong>
            </div>
          </>
        ) : (
          <div>
            <label className="label">Bulk Amount (₹) *</label>
            <input type="number" min="0" step="1" className="input" value={form.total_amount}
              onChange={e => setForm({ ...form, total_amount: e.target.value })} required autoFocus />
          </div>
        )}
        <div>
          <label className="label">Notes</label>
          <textarea className="input" rows={2} value={form.notes}
            onChange={e => setForm({ ...form, notes: e.target.value })} />
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t">
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

// ─── L3 Work Orders sub-section ────────────────────────────────
function L3WorkOrders({ projectId, onChange }) {
  const [rows, setRows] = useState([]);
  const [editing, setEditing] = useState(null); // null | { id?: number, ... }
  // Phase 4 (mam 2026-06-02): when mam clicks the "Linked DPRs" badge
  // on a WO row we open a slide-out / modal listing every DPR work
  // line that referenced that WO — site, date, qty, amount, who
  // submitted.  Lets her audit the progress claim before releasing
  // the next payment.
  const [dprLinksFor, setDprLinksFor] = useState(null); // { wo, items: [] }

  const load = () => {
    api.get(`/indent-labour-payment/projects/${projectId}/work-orders`).then(r => setRows(r.data || []));
  };
  useEffect(load, [projectId]);

  const openDprLinks = async (wo) => {
    setDprLinksFor({ wo, items: null });  // null = loading
    try {
      const r = await api.get(`/indent-labour-payment/work-orders/${wo.id}/dpr-items`);
      setDprLinksFor({ wo, items: r.data || [] });
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not load linked DPRs');
      setDprLinksFor({ wo, items: [] });
    }
  };

  const remove = async (id) => {
    if (!confirm('Delete this Work Order?')) return;
    try {
      await api.delete(`/indent-labour-payment/work-orders/${id}`);
      toast.success('Deleted'); load(); onChange();
    } catch (e) { toast.error(e.response?.data?.error || 'Delete failed'); }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2 items-center">
        <button onClick={() => setEditing({})} className="btn btn-primary text-xs flex items-center gap-1">
          <FiPlus size={12} /> Add Work Order
        </button>
        <div className="text-[10px] text-gray-500 ml-2">Count is dynamic — add as many WOs as the project needs.</div>
      </div>

      <div className="overflow-x-auto border rounded">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-2 py-1.5">WO #</th>
              <th className="text-left px-2 py-1.5">Sub-contractor</th>
              <th className="text-left px-2 py-1.5">Scope</th>
              <th className="text-right px-2 py-1.5">Value</th>
              <th className="text-right px-2 py-1.5">Paid</th>
              <th className="text-right px-2 py-1.5">Balance</th>
              {/* Phase 4 — DPR progress badge column */}
              <th className="text-center px-2 py-1.5">DPR Progress</th>
              <th className="text-left px-2 py-1.5">File</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={9} className="text-center py-4 text-gray-400">No work orders yet</td></tr>}
            {rows.map(r => {
              const pct = +r.dpr_progress_pct || 0;
              const cnt = +r.dpr_linked_count || 0;
              // Colour the chip by claim health vs payment:
              //   green   — claim ≤ paid (you're ahead, fully paid)
              //   amber   — claim > paid (sub-con has earned more, release)
              //   red     — claim > 110% of WO value (sanity warn)
              //   gray    — no DPR yet
              let chipCls = 'bg-gray-100 text-gray-500 border-gray-200';
              if (cnt > 0) {
                if (pct > 110) chipCls = 'bg-red-100 text-red-700 border-red-300';
                else if ((+r.dpr_linked_amount || 0) > (+r.amount_paid || 0)) chipCls = 'bg-amber-100 text-amber-700 border-amber-300';
                else chipCls = 'bg-emerald-100 text-emerald-700 border-emerald-300';
              }
              return (
                <tr key={r.id} className="border-t">
                  <td className="px-2 py-1.5 font-mono text-xs">{r.wo_number || '—'}</td>
                  <td className="px-2 py-1.5">{r.sub_contractor_name || '—'}</td>
                  <td className="px-2 py-1.5 text-xs">{r.scope || '—'}</td>
                  <td className="px-2 py-1.5 text-right">{fmtINRFull(r.planned_value)}</td>
                  <td className="px-2 py-1.5 text-right text-emerald-700 font-semibold">{fmtINRFull(r.amount_paid)}</td>
                  <td className={`px-2 py-1.5 text-right font-semibold ${r.balance > 0 ? 'text-amber-700' : 'text-gray-400'}`}>
                    {fmtINRFull(r.balance)}
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    {cnt > 0 ? (
                      <button
                        onClick={() => openDprLinks(r)}
                        className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border ${chipCls} hover:shadow-sm`}
                        title="Click to see each DPR line that contributed to this %"
                      >
                        {pct.toFixed(1)}% · {cnt} DPR{cnt === 1 ? '' : 's'}
                      </button>
                    ) : (
                      <span className="text-[10px] text-gray-400 italic">no DPR yet</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {r.work_order_file_url
                      ? <a href={r.work_order_file_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline flex items-center gap-1 text-xs">
                          <FiExternalLink size={11} /> View
                        </a>
                      : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                  <td className="px-2 py-1.5 text-right flex gap-2 justify-end">
                    <button onClick={() => setEditing(r)} className="text-blue-500 hover:text-blue-700"><FiEdit2 size={12} /></button>
                    <button onClick={() => remove(r.id)} className="text-red-500 hover:text-red-700"><FiTrash2 size={12} /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <AddOrEditWorkOrder wo={editing} projectId={projectId}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); onChange(); }} />
      )}

      {dprLinksFor && (
        <DprLinksModal data={dprLinksFor} onClose={() => setDprLinksFor(null)} />
      )}
    </div>
  );
}

// Phase 4 modal — shows every DPR work line that touched this WO.
// Each row is the contractor's claim of work-done that mam is verifying.
function DprLinksModal({ data, onClose }) {
  const { wo, items } = data;
  const totalAmount = (items || []).reduce((s, it) => s + (+it.amount || 0), 0);
  return (
    <Modal isOpen={true} onClose={onClose} title={`Linked DPRs — ${wo.wo_number || `WO #${wo.id}`}`} wide>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3 text-xs">
          <div className="bg-gray-50 rounded p-2">
            <div className="text-[10px] text-gray-500 uppercase">Sub-contractor</div>
            <div className="font-semibold">{wo.sub_contractor_name || '—'}</div>
          </div>
          <div className="bg-gray-50 rounded p-2">
            <div className="text-[10px] text-gray-500 uppercase">WO Value</div>
            <div className="font-semibold text-gray-800">{fmtINRFull(wo.planned_value)}</div>
          </div>
          <div className="bg-gray-50 rounded p-2">
            <div className="text-[10px] text-gray-500 uppercase">Already Paid</div>
            <div className="font-semibold text-emerald-700">{fmtINRFull(wo.amount_paid)}</div>
          </div>
        </div>
        {items === null && <div className="text-center py-6 text-gray-400 text-sm">Loading linked DPRs…</div>}
        {items && items.length === 0 && (
          <div className="text-center py-6 text-gray-400 text-sm">
            No DPR work items linked to this WO yet.
            <div className="text-[10px] text-gray-400 mt-1">Once site engineers tag work lines against this WO in their DPRs, they'll show up here.</div>
          </div>
        )}
        {items && items.length > 0 && (
          <div className="overflow-x-auto border rounded">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-2 py-1.5">Date</th>
                  <th className="text-left px-2 py-1.5">Site</th>
                  <th className="text-left px-2 py-1.5">Description</th>
                  <th className="text-left px-2 py-1.5">Location</th>
                  <th className="text-right px-2 py-1.5">Qty</th>
                  <th className="text-left px-2 py-1.5">Unit</th>
                  <th className="text-right px-2 py-1.5">Rate</th>
                  <th className="text-right px-2 py-1.5">Amount</th>
                  <th className="text-left px-2 py-1.5">By</th>
                </tr>
              </thead>
              <tbody>
                {items.map(it => (
                  <tr key={it.id} className="border-t">
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {it.report_date ? fmtDate(it.report_date, { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                    </td>
                    <td className="px-2 py-1.5">{it.site_name || '—'}</td>
                    <td className="px-2 py-1.5">{it.description || '—'}</td>
                    <td className="px-2 py-1.5 text-gray-500">{it.floor_zone || '—'}</td>
                    <td className="px-2 py-1.5 text-right font-semibold">{(+it.actual_qty || 0).toLocaleString('en-IN')}</td>
                    <td className="px-2 py-1.5">{it.unit || '—'}</td>
                    <td className="px-2 py-1.5 text-right">₹{(+it.rate || 0).toLocaleString('en-IN')}</td>
                    <td className="px-2 py-1.5 text-right font-semibold text-emerald-700">{fmtINRFull(it.amount)}</td>
                    <td className="px-2 py-1.5 text-[10px] text-gray-500">{it.submitted_by_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-emerald-50 font-semibold">
                <tr>
                  <td colSpan={7} className="px-2 py-2 text-right">Total claimed via DPR →</td>
                  <td className="px-2 py-2 text-right text-emerald-700">{fmtINRFull(totalAmount)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <div className="flex justify-end pt-2 border-t">
          <button onClick={onClose} className="btn btn-secondary">Close</button>
        </div>
      </div>
    </Modal>
  );
}

function AddOrEditWorkOrder({ wo, projectId, onClose, onSaved }) {
  const isEdit = !!wo.id;
  const [form, setForm] = useState({
    wo_number: wo.wo_number || '',
    sub_contractor_name: wo.sub_contractor_name || '',
    scope: wo.scope || '',
    planned_value: wo.planned_value || '',
    amount_paid: wo.amount_paid || '',
    work_order_file_url: wo.work_order_file_url || '',
    planned_start: wo.planned_start || '',
    planned_end: wo.planned_end || '',
  });
  const [uploading, setUploading] = useState(false);

  const upload = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setForm(f => ({ ...f, work_order_file_url: r.data.url }));
      toast.success('Uploaded');
    } catch (e) { toast.error('Upload failed'); }
    finally { setUploading(false); }
  };

  const submit = async (e) => {
    e.preventDefault();
    const payload = {
      ...form,
      planned_value: Number(form.planned_value) || 0,
      amount_paid: Number(form.amount_paid) || 0,
    };
    try {
      if (isEdit) await api.put(`/indent-labour-payment/work-orders/${wo.id}`, payload);
      else        await api.post(`/indent-labour-payment/projects/${projectId}/work-orders`, payload);
      toast.success('Saved'); onSaved();
    } catch (err) { toast.error(err.response?.data?.error || 'Save failed'); }
  };

  return (
    <Modal isOpen={true} onClose={onClose} title={isEdit ? `Edit ${wo.wo_number || 'Work Order'}` : 'New Work Order'} wide>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">WO Number</label>
            <input className="input" value={form.wo_number}
              onChange={e => setForm({ ...form, wo_number: e.target.value })}
              placeholder="WO/2026/SEPL/0023" />
          </div>
          <div>
            <label className="label">Sub-contractor</label>
            <input className="input" value={form.sub_contractor_name}
              onChange={e => setForm({ ...form, sub_contractor_name: e.target.value })}
              placeholder="Company / name" />
          </div>
        </div>
        <div>
          <label className="label">Scope</label>
          <textarea className="input" rows={2} value={form.scope}
            onChange={e => setForm({ ...form, scope: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">WO Value (₹) *</label>
            <input type="number" min="0" step="1" className="input" value={form.planned_value}
              onChange={e => setForm({ ...form, planned_value: e.target.value })} required />
          </div>
          <div>
            <label className="label">Amount Paid (₹)</label>
            <input type="number" min="0" step="1" className="input" value={form.amount_paid}
              onChange={e => setForm({ ...form, amount_paid: e.target.value })} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Planned Start</label>
            <input type="date" className="input" value={form.planned_start}
              onChange={e => setForm({ ...form, planned_start: e.target.value })} />
          </div>
          <div>
            <label className="label">Planned End</label>
            <input type="date" className="input" value={form.planned_end}
              onChange={e => setForm({ ...form, planned_end: e.target.value })} />
          </div>
        </div>
        <div>
          <label className="label">Work Order File</label>
          <div className="flex items-center gap-2">
            <input type="file" onChange={e => upload(e.target.files[0])} className="text-xs" />
            {uploading && <span className="text-xs text-gray-500">Uploading…</span>}
            {form.work_order_file_url && (
              <a href={form.work_order_file_url} target="_blank" rel="noreferrer"
                 className="text-xs text-blue-600 underline flex items-center gap-1">
                <FiExternalLink size={11} /> View uploaded
              </a>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t">
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Phase stub for later-phase tabs ───────────────────────────
function PhaseStub({ phase, label }) {
  return (
    <div className="card p-6 text-center space-y-2">
      <div className="text-lg font-bold text-gray-700">{label}</div>
      <div className="text-sm text-gray-500">Coming in <span className="font-semibold text-indigo-700">Phase {phase}</span>.</div>
      <div className="text-xs text-gray-400 max-w-md mx-auto">
        Schema tables landed today.  Endpoint + UI work scheduled per the plan.
      </div>
    </div>
  );
}
