// CRM Full Kitting — multi-project matrix tracker.
//
// Mam (2026-05-21) shared 3 master-sheet screenshots showing:
//   Rows  = projects (one per Business Book company_name)
//   Cols  = 131 checkpoints in 3 stages
//           Stage 1 · PRE-START   55 items in 10 sections
//           Stage 2 · EXECUTION   35 items in  6 sections
//           Stage 3 · HANDOVER    41 items in  7 sections
//   Plus per-project meta columns: CRM owner (Sushila / Lovely / …),
//   Phase or Zone, PM Owner, Target Start.
//
// Each cell shows a colored status chip — Y green, N red, E (Partially)
// amber, N/A grey, blank when no entry exists.  Click the cell to
// open the existing update modal (status + photo + observation date
// + remarks).  A small camera icon overlays the chip when a photo
// is attached.  History (N) drawer reachable from the modal.
//
// 3 stage tabs at the top swap which checkpoint columns are visible.
// Left columns (Sr, Project Name, CRM, Phase, PM, Target Start) stay
// sticky so they're always readable as you scroll right through 131
// columns.

import { useState, useEffect, useMemo, useCallback } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import {
  FiCheckCircle, FiXCircle, FiAlertCircle, FiMinusCircle,
  FiCamera, FiClock, FiSettings, FiPlus, FiTrash2, FiEdit2,
  FiPackage, FiX, FiCalendar, FiUser, FiSearch, FiRefreshCw,
} from 'react-icons/fi';
import { fmtDateTime, fmtDate } from '../utils/datetime';

// ── Status meta ────────────────────────────────────────────────
const STATUS_META = {
  yes:       { label: 'Yes',       short: 'Y', chip: 'bg-emerald-500 text-white',  icon: FiCheckCircle },
  no:        { label: 'No',        short: 'N', chip: 'bg-rose-500 text-white',     icon: FiXCircle },
  partially: { label: 'Partially', short: 'E', chip: 'bg-amber-500 text-white',    icon: FiAlertCircle },
  na:        { label: 'N/A',       short: '–', chip: 'bg-slate-300 text-slate-700',icon: FiMinusCircle },
};

const STAGE_META = {
  1: { title: 'PRE-START',  accent: 'from-blue-800 to-blue-900',     headerBg: 'bg-blue-950',     tabBadge: 'bg-blue-500'    },
  2: { title: 'EXECUTION',  accent: 'from-orange-700 to-amber-700',  headerBg: 'bg-amber-900',    tabBadge: 'bg-amber-500'   },
  3: { title: 'HANDOVER',   accent: 'from-emerald-700 to-emerald-800', headerBg: 'bg-emerald-900', tabBadge: 'bg-emerald-500' },
};

// Same Cash-Flow-style ₹ formatter as before.
const fmtINRShort = (v) => {
  const n = Number(v) || 0;
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${n.toLocaleString('en-IN')}`;
};

const todayISO = () => new Date().toISOString().slice(0, 10);
const minObsISO = () => {
  const d = new Date(); d.setDate(d.getDate() - 5);
  return d.toISOString().slice(0, 10);
};
const fmtDt = (iso) => iso ? fmtDateTime(iso, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const fmtD  = (iso) => iso ? fmtDate(iso, { dateStyle: 'medium' }) : '—';

// CRM owner options — taken from mam's screenshot.  Anyone can add
// more by typing in the picklist field; values are stored as plain
// text so the list isn't a hard constraint.
const CRM_OWNERS = ['Sushila', 'Lovely'];

export default function CRMKitting() {
  const { user, isAdmin, canEdit } = useAuth();

  const [matrix, setMatrix] = useState({ projects: [], checkpoints: [], meta: {}, entries: {} });
  const [loading, setLoading] = useState(false);
  const [activeStage, setActiveStage] = useState(1);
  const [filter, setFilter] = useState('');

  // Update modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalCp, setModalCp] = useState(null);              // checkpoint object
  const [modalProject, setModalProject] = useState(null);    // project object
  const [modalStatus, setModalStatus] = useState('yes');
  const [modalObsDate, setModalObsDate] = useState(todayISO());
  const [modalRemarks, setModalRemarks] = useState('');
  const [modalPhoto, setModalPhoto] = useState(null);
  const [saving, setSaving] = useState(false);

  // History drawer state
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyCp, setHistoryCp] = useState(null);
  const [historyProject, setHistoryProject] = useState(null);
  const [historyRows, setHistoryRows] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Manage Checkpoints drawer (admin)
  const [manageOpen, setManageOpen] = useState(false);
  const [adminCps, setAdminCps] = useState([]);
  const [draftCp, setDraftCp] = useState({ stage_no: 1, section: '', sort_order: 9999, label: '', description: '' });

  // Meta editor drawer (per-project)
  const [metaOpen, setMetaOpen] = useState(false);
  const [metaProject, setMetaProject] = useState(null);
  const [metaDraft, setMetaDraft] = useState({});

  const editAllowed = canEdit ? canEdit('crm_kitting') : true;

  // ── Fetch matrix ───────────────────────────────────────────────
  const loadMatrix = useCallback(() => {
    setLoading(true);
    api.get('/crm-kitting/matrix')
      .then(r => setMatrix(r.data || { projects: [], checkpoints: [], meta: {}, entries: {} }))
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load matrix'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { loadMatrix(); }, [loadMatrix]);

  // ── Checkpoints grouped by stage, then section ────────────────
  const stageColumns = useMemo(() => {
    // { 1: [{ section, items: [...] }], 2: [...], 3: [...] }
    const out = { 1: [], 2: [], 3: [] };
    const cur = { 1: null, 2: null, 3: null };
    for (const cp of matrix.checkpoints) {
      const s = cp.stage_no;
      if (!cur[s] || cur[s].section !== cp.section) {
        cur[s] = { section: cp.section || 'OTHER', items: [] };
        out[s].push(cur[s]);
      }
      cur[s].items.push(cp);
    }
    return out;
  }, [matrix.checkpoints]);

  const stageTotals = useMemo(() => ({
    1: stageColumns[1].reduce((a, g) => a + g.items.length, 0),
    2: stageColumns[2].reduce((a, g) => a + g.items.length, 0),
    3: stageColumns[3].reduce((a, g) => a + g.items.length, 0),
  }), [stageColumns]);

  // ── Filtered project rows ──────────────────────────────────────
  const filteredProjects = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return matrix.projects;
    return matrix.projects.filter(p =>
      (p.project_name || '').toLowerCase().includes(q) ||
      (p.client_name || '').toLowerCase().includes(q) ||
      (p.lead_no || '').toLowerCase().includes(q) ||
      (matrix.meta[p.project_key]?.pm_owner || '').toLowerCase().includes(q) ||
      (matrix.meta[p.project_key]?.crm_owner || '').toLowerCase().includes(q)
    );
  }, [matrix.projects, matrix.meta, filter]);

  // ── Cell helpers ───────────────────────────────────────────────
  const getEntry = (projectKey, cpId) => matrix.entries[`${projectKey}::${cpId}`];

  const openCell = (project, cp) => {
    if (!editAllowed) return;
    const cur = getEntry(project.project_key, cp.id);
    setModalProject(project);
    setModalCp(cp);
    setModalStatus(cur?.status || 'yes');
    setModalObsDate(todayISO());
    setModalRemarks('');
    setModalPhoto(null);
    setModalOpen(true);
  };

  const saveEntry = async () => {
    if (!modalCp || !modalProject) return;
    if (modalObsDate > todayISO()) { toast.error('Observation date cannot be in the future'); return; }
    if (modalObsDate < minObsISO()) { toast.error('Observation date cannot be more than 5 days in the past'); return; }
    if (!modalPhoto) { toast.error('Please upload a file (photo or PDF) as evidence'); return; }
    setSaving(true);
    // Snapshot the projectKey + cpId BEFORE the modal closes so the
    // optimistic update below can still address the right cell.
    const projectKey = modalProject.project_key;
    const cpId       = modalCp.id;
    const newStatus  = modalStatus;
    const newObsDate = modalObsDate;
    const newRemarks = modalRemarks;
    try {
      const fd = new FormData();
      fd.append('project_key', projectKey);
      fd.append('checkpoint_id', cpId);
      fd.append('status', newStatus);
      fd.append('observation_date', newObsDate);
      if (newRemarks) fd.append('remarks', newRemarks);
      if (modalPhoto) fd.append('photo', modalPhoto);
      const res = await api.post('/crm-kitting/entry', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success('Saved');
      setModalOpen(false);
      // Mam (2026-06-02): "when i update after proof upload go to top
      // which is bad".  Don't call loadMatrix() — refetching repaints
      // the whole 36×131 matrix which forces the page back to scroll
      // top.  Patch matrix.entries locally with the new row instead
      // so the cell badge flips colour immediately without any
      // layout rebuild.  Field shape matches what /crm-kitting/matrix
      // returns (project_key, checkpoint_id, status, photo_path,
      // remarks, observation_date, uploaded_at, uploaded_by,
      // uploaded_by_name, history_count).
      const key = `${projectKey}::${cpId}`;
      setMatrix(prev => {
        const existing = prev.entries?.[key] || {};
        return {
          ...prev,
          entries: {
            ...(prev.entries || {}),
            [key]: {
              ...existing,
              project_key: projectKey,
              checkpoint_id: cpId,
              status: newStatus,
              photo_path: res?.data?.photo_path ?? existing.photo_path ?? null,
              remarks: newRemarks || null,
              observation_date: newObsDate,
              uploaded_at: new Date().toISOString(),
              uploaded_by: user?.id ?? existing.uploaded_by ?? null,
              uploaded_by_name: user?.name ?? existing.uploaded_by_name ?? null,
              history_count: (+existing.history_count || 0) + 1,
            },
          },
        };
      });
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const openHistory = () => {
    if (!modalCp || !modalProject) return;
    setHistoryProject(modalProject);
    setHistoryCp(modalCp);
    setHistoryOpen(true);
    setHistoryRows([]);
    setHistoryLoading(true);
    api.get('/crm-kitting/history', { params: { key: modalProject.project_key, cp: modalCp.id } })
      .then(r => setHistoryRows(r.data || []))
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load history'))
      .finally(() => setHistoryLoading(false));
  };

  // ── Project meta editor ────────────────────────────────────────
  const openMeta = (p) => {
    setMetaProject(p);
    setMetaDraft({ ...(matrix.meta[p.project_key] || {}), project_key: p.project_key });
    setMetaOpen(true);
  };
  const saveMeta = async () => {
    try {
      await api.put('/crm-kitting/project-meta', metaDraft);
      toast.success('Saved');
      setMetaOpen(false);
      loadMatrix();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to save');
    }
  };

  // ── Admin manage checkpoints ───────────────────────────────────
  const loadAdminCps = () => {
    api.get('/crm-kitting/checkpoints')
      .then(r => setAdminCps(r.data || []))
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load checkpoints'));
  };
  const openManage = () => { loadAdminCps(); setManageOpen(true); };
  const addCheckpoint = async () => {
    if (!draftCp.label.trim()) return toast.error('Label required');
    try {
      await api.post('/crm-kitting/checkpoints', draftCp);
      toast.success('Added');
      setDraftCp({ stage_no: draftCp.stage_no, section: draftCp.section, sort_order: 9999, label: '', description: '' });
      loadAdminCps(); loadMatrix();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to add'); }
  };
  const updateCp = async (id, patch) => {
    try { await api.put(`/crm-kitting/checkpoints/${id}`, patch); toast.success('Updated'); loadAdminCps(); loadMatrix(); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  const deleteCp = async (id) => {
    if (!window.confirm('Disable this checkpoint? Existing history is preserved.')) return;
    try { await api.delete(`/crm-kitting/checkpoints/${id}`); toast.success('Disabled'); loadAdminCps(); loadMatrix(); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  // ── Cell renderer ──────────────────────────────────────────────
  const renderCell = (project, cp) => {
    const entry = getEntry(project.project_key, cp.id);
    if (!entry) {
      return (
        <button
          onClick={() => openCell(project, cp)}
          disabled={!editAllowed}
          className="w-7 h-7 rounded border border-gray-200 bg-white hover:bg-blue-50 disabled:cursor-not-allowed transition"
          title={`${project.project_name} · ${cp.label} — not set`}
        />
      );
    }
    const m = STATUS_META[entry.status] || STATUS_META.na;
    return (
      <button
        onClick={() => openCell(project, cp)}
        disabled={!editAllowed}
        className={`relative w-7 h-7 rounded ${m.chip} font-bold text-[11px] flex items-center justify-center shadow-sm hover:scale-110 transition disabled:cursor-not-allowed`}
        title={`${project.project_name} · ${cp.label}\n${m.label} · ${fmtD(entry.observation_date)} · ${entry.uploaded_by_name || '—'}`}
      >
        {m.short}
        {entry.photo_path && (
          <span className="absolute -bottom-1 -right-1 w-3 h-3 bg-white rounded-full flex items-center justify-center shadow border border-gray-200">
            <FiCamera size={8} className="text-blue-700" />
          </span>
        )}
      </button>
    );
  };

  // ── Per-stage rollup % for a single project ────────────────────
  const stagePctFor = (projectKey, stageNo) => {
    const cps = matrix.checkpoints.filter(c => c.stage_no === stageNo);
    if (cps.length === 0) return 0;
    let done = 0;
    for (const cp of cps) {
      const e = matrix.entries[`${projectKey}::${cp.id}`];
      if (e && (e.status === 'yes' || e.status === 'na')) done += 1;
    }
    return Math.round((done / cps.length) * 100);
  };

  return (
    <div className="p-3 sm:p-4">
      {/* Header */}
      <div className="bg-gradient-to-br from-blue-900 to-blue-950 text-white rounded-xl p-4 sm:p-5 mb-3 shadow-lg">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
              <FiPackage /> CRM Full Kitting Tracker
            </h1>
            <p className="text-blue-200 text-xs sm:text-sm mt-1">
              Multi-project matrix · {matrix.checkpoints.length} checkpoints across 3 stages · click any cell to set Yes / No / Partially / N/A + upload photo · history retained
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={loadMatrix}
              className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-xs flex items-center gap-1.5"
              title="Reload"
            >
              <FiRefreshCw /> Refresh
            </button>
            {isAdmin && isAdmin() && (
              <button
                onClick={openManage}
                className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-xs flex items-center gap-1.5"
              >
                <FiSettings /> Manage Checkpoints
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Stage tabs — same Sales Funnel pill style: btn + count chip.
          Each stage tab also gets a tiny rollup chip showing how many
          checkpoints across ALL projects are still pending in that
          stage, so mam sees where the work is concentrated. */}
      <div className="flex gap-2 flex-wrap items-center mb-3">
        {[1, 2, 3].map(sn => {
          const active = activeStage === sn;
          return (
            <button
              key={sn}
              onClick={() => setActiveStage(sn)}
              className={`btn ${active ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}
              title={`Stage ${sn} — ${STAGE_META[sn].title}`}
            >
              Stage {sn} — {STAGE_META[sn].title}
              <span
                className={`px-1.5 rounded-full text-[10px] font-bold min-w-[22px] text-center ${
                  active ? 'bg-white/30 text-white' : `text-white ${STAGE_META[sn].tabBadge}`
                }`}
              >
                {stageTotals[sn]}
              </span>
            </button>
          );
        })}
        <div className="relative ml-auto">
          <FiSearch className="absolute left-2.5 top-2 text-gray-400" size={14} />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter projects…"
            className="pl-8 pr-2 py-1.5 border rounded-lg text-sm w-64"
          />
        </div>
      </div>

      {/* Loaded-state indicator — surfaces matrix payload at a glance.
          Mam saw an empty render previously; this makes "did the data
          arrive?" answerable without DevTools. */}
      <div className="text-[11px] text-gray-500 mb-1.5 px-1">
        {loading
          ? 'Loading…'
          : `${matrix.projects.length} projects · ${matrix.checkpoints.length} checkpoints loaded · showing ${filteredProjects.length} on Stage ${activeStage}`}
      </div>

      {/* Matrix — single table with `table-layout: fixed` + explicit
          colgroup widths.  This is the most reliable layout: column
          widths come from the colgroup (not from cell content), so
          long project names can't expand a column and break the
          sticky-left math for the next column over. */}
      <div className="bg-white border rounded-xl shadow-sm overflow-auto max-h-[78vh]">
        {loading && (
          <div className="p-6 text-center text-sm text-gray-500">Loading matrix…</div>
        )}
        {!loading && matrix.projects.length === 0 && (
          <div className="p-6 text-center text-sm text-gray-500">
            No projects in Business Book yet. Add one there first.
          </div>
        )}
        {!loading && matrix.projects.length > 0 && (() => {
          const dataCols = stageColumns[activeStage].flatMap(g => g.items);
          // Sticky-left pixel offsets — must match the colgroup widths
          // below exactly, otherwise sticky cells will overlap.
          const W = { sr: 36, name: 200, crm: 80, phase: 90, pm: 110, target: 90 };
          const L = {
            sr:     0,
            name:   W.sr,                                                // 36
            crm:    W.sr + W.name,                                        // 236
            phase:  W.sr + W.name + W.crm,                                // 316
            pm:     W.sr + W.name + W.crm + W.phase,                      // 406
            target: W.sr + W.name + W.crm + W.phase + W.pm,               // 516
          };
          // The right edge of the sticky meta area — used to anchor a
          // shadow on the last sticky cell so the boundary is obvious.
          const stickyShadow = 'shadow-[4px_0_6px_-2px_rgba(0,0,0,0.15)]';
          return (
            <table className="border-collapse text-xs" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: W.sr }} />
                <col style={{ width: W.name }} />
                <col style={{ width: W.crm }} />
                <col style={{ width: W.phase }} />
                <col style={{ width: W.pm }} />
                <col style={{ width: W.target }} />
                {dataCols.map(cp => (
                  <col key={cp.id} style={{ width: 32 }} />
                ))}
              </colgroup>

              <thead>
                {/* Section band row */}
                <tr>
                  <th
                    colSpan={6}
                    className={`sticky left-0 top-0 z-40 bg-slate-900 text-white text-[11px] font-semibold px-3 py-2 text-left border-b border-slate-700 ${stickyShadow}`}
                    style={{ height: 38 }}
                  >
                    PROJECT INFO
                  </th>
                  {stageColumns[activeStage].map((g, gi) => (
                    <th
                      key={gi}
                      colSpan={g.items.length}
                      className={`sticky top-0 z-20 ${STAGE_META[activeStage].headerBg} text-white text-[11px] font-bold px-2 text-center border-l border-r border-b border-slate-700 uppercase tracking-wide`}
                      style={{ height: 38 }}
                    >
                      {g.section} <span className="text-[9px] opacity-75">({g.items.length})</span>
                    </th>
                  ))}
                </tr>
                {/* Column label row — sticky-left for the meta block,
                    sticky-top for the rotated checkpoint headers. */}
                <tr>
                  <th className="sticky top-[38px] z-30 bg-slate-800 text-white text-[10px] px-1 text-center border-r border-b border-slate-700" style={{ left: L.sr, height: 120, position: 'sticky' }}>Sr</th>
                  <th className="sticky top-[38px] z-30 bg-slate-800 text-white text-[10px] px-2 text-left border-r border-b border-slate-700" style={{ left: L.name, height: 120, position: 'sticky' }}>Project Name</th>
                  <th className="sticky top-[38px] z-30 bg-slate-800 text-white text-[10px] px-1 text-center border-r border-b border-slate-700" style={{ left: L.crm, height: 120, position: 'sticky' }}>CRM</th>
                  <th className="sticky top-[38px] z-30 bg-slate-800 text-white text-[10px] px-1 text-center border-r border-b border-slate-700" style={{ left: L.phase, height: 120, position: 'sticky' }}>Phase / Zone</th>
                  <th className="sticky top-[38px] z-30 bg-slate-800 text-white text-[10px] px-1 text-center border-r border-b border-slate-700" style={{ left: L.pm, height: 120, position: 'sticky' }}>PM Owner</th>
                  <th className={`sticky top-[38px] z-30 bg-slate-800 text-white text-[10px] px-1 text-center border-r border-b border-slate-700 ${stickyShadow}`} style={{ left: L.target, height: 120, position: 'sticky' }}>Target Start</th>
                  {dataCols.map(cp => (
                    <th
                      key={cp.id}
                      className="sticky top-[38px] z-10 bg-slate-700 text-white text-[10px] font-medium border-r border-b border-slate-600 align-bottom overflow-hidden"
                      style={{ height: 120 }}
                      title={cp.label}
                    >
                      <div className="whitespace-nowrap mx-auto py-2" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                        {cp.label}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {filteredProjects.map((p, idx) => {
                  const meta = matrix.meta[p.project_key] || {};
                  const pct = stagePctFor(p.project_key, activeStage);
                  return (
                    <tr key={p.project_key} className="hover:bg-blue-50/40" style={{ height: 44 }}>
                      <td className="sticky z-10 bg-white border-r border-b text-center text-gray-500 text-[10px]" style={{ left: L.sr, position: 'sticky' }}>{idx + 1}</td>
                      <td className="sticky z-10 bg-white border-r border-b px-2 overflow-hidden" style={{ left: L.name, position: 'sticky' }}>
                        <div className="font-medium text-gray-900 text-[11px] truncate" title={p.project_name}>{p.project_name}</div>
                        <div className="text-[9px] text-gray-500 flex items-center gap-1 truncate">
                          {p.lead_no && <span className="font-mono">{p.lead_no}</span>}
                          {p.bb_entry_count > 1 && <span className="text-amber-700">· {p.bb_entry_count} BB</span>}
                          <span className="ml-auto inline-flex items-center gap-0.5 whitespace-nowrap">
                            <span className={`inline-block w-1.5 h-1.5 rounded-full ${pct >= 100 ? 'bg-emerald-500' : pct >= 50 ? 'bg-amber-500' : 'bg-gray-300'}`} />
                            {pct}%
                          </span>
                        </div>
                      </td>
                      <td
                        onClick={() => editAllowed && openMeta(p)}
                        className={`sticky z-10 bg-white border-r border-b text-center text-[10px] px-1 ${editAllowed ? 'cursor-pointer hover:bg-blue-50' : ''}`}
                        style={{ left: L.crm, position: 'sticky' }}
                      >
                        {meta.crm_owner ? (
                          <span className={`inline-block px-1.5 py-0.5 rounded ${
                            meta.crm_owner === 'Sushila' ? 'bg-violet-100 text-violet-700' :
                            meta.crm_owner === 'Lovely'  ? 'bg-orange-100 text-orange-700' :
                            'bg-slate-100 text-slate-700'
                          }`}>{meta.crm_owner}</span>
                        ) : <span className="text-gray-300">—</span>}
                      </td>
                      <td
                        onClick={() => editAllowed && openMeta(p)}
                        className={`sticky z-10 bg-white border-r border-b text-center text-[10px] px-1 overflow-hidden ${editAllowed ? 'cursor-pointer hover:bg-blue-50' : ''}`}
                        style={{ left: L.phase, position: 'sticky' }}
                      >
                        <div className="truncate" title={meta.phase_zone || ''}>
                          {meta.phase_zone || <span className="text-gray-300">—</span>}
                        </div>
                      </td>
                      <td
                        onClick={() => editAllowed && openMeta(p)}
                        className={`sticky z-10 bg-white border-r border-b text-center text-[10px] px-1 overflow-hidden ${editAllowed ? 'cursor-pointer hover:bg-blue-50' : ''}`}
                        style={{ left: L.pm, position: 'sticky' }}
                      >
                        <div className="truncate" title={meta.pm_owner || ''}>
                          {meta.pm_owner || <span className="text-gray-300">—</span>}
                        </div>
                      </td>
                      <td
                        onClick={() => editAllowed && openMeta(p)}
                        className={`sticky z-10 bg-white border-r border-b text-center text-[10px] px-1 ${editAllowed ? 'cursor-pointer hover:bg-blue-50' : ''} ${stickyShadow}`}
                        style={{ left: L.target, position: 'sticky' }}
                      >
                        {meta.target_start ? fmtD(meta.target_start) : <span className="text-gray-300">—</span>}
                      </td>
                      {dataCols.map(cp => (
                        <td key={cp.id} className="border-r border-b text-center p-0.5">
                          {renderCell(p, cp)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          );
        })()}
      </div>

      {/* Update modal */}
      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title={modalCp && modalProject ? `${modalProject.project_name} · ${modalCp.label}` : 'Update'}>
        {modalCp && modalProject && (
          <div className="space-y-3">
            <div className="text-[11px] text-gray-500 bg-gray-50 border rounded p-2">
              Stage <strong>{modalCp.stage_no}</strong> · Section <strong>{modalCp.section}</strong>
            </div>

            <div>
              <label className="text-xs font-semibold text-gray-700">Status</label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-1">
                {Object.keys(STATUS_META).map(k => {
                  const m = STATUS_META[k];
                  const active = modalStatus === k;
                  return (
                    <button
                      key={k}
                      onClick={() => setModalStatus(k)}
                      className={`px-2 py-2 rounded-lg border text-sm flex items-center justify-center gap-1.5 transition ${
                        active ? `${m.chip} border-transparent font-semibold shadow-sm` : 'border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      <m.icon size={14} /> {m.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-gray-700">Observation date</label>
                <input
                  type="date"
                  value={modalObsDate}
                  onChange={e => setModalObsDate(e.target.value)}
                  min={minObsISO()}
                  max={todayISO()}
                  className="w-full mt-1 px-2 py-1.5 border rounded-lg text-sm"
                />
                <p className="text-[10px] text-gray-500 mt-0.5">Today or up to 5 days back</p>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-700">Upload File <span className="text-red-600">*</span></label>
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  capture="environment"
                  required
                  onChange={e => setModalPhoto(e.target.files?.[0] || null)}
                  className="w-full mt-1 text-xs"
                />
                <p className="text-[10px] text-gray-500 mt-0.5">Photo or PDF — required as evidence</p>
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-gray-700">Remarks (optional)</label>
              <textarea
                value={modalRemarks}
                onChange={e => setModalRemarks(e.target.value)}
                rows={2}
                className="w-full mt-1 px-2 py-1.5 border rounded-lg text-sm"
                placeholder="Notes, blockers, who confirmed…"
              />
            </div>

            {/* Current value preview */}
            {(() => {
              const cur = getEntry(modalProject.project_key, modalCp.id);
              if (!cur) return null;
              const m = STATUS_META[cur.status] || STATUS_META.na;
              return (
                <div className="border-t pt-2 text-[11px] text-gray-600">
                  <span className="font-semibold">Current: </span>
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${m.chip}`}>
                    <m.icon size={10} /> {m.label}
                  </span>
                  <span className="ml-2">on {fmtD(cur.observation_date)} by {cur.uploaded_by_name || '—'}</span>
                  {cur.photo_path && (
                    <a href={cur.photo_path} target="_blank" rel="noreferrer" className="ml-2 text-blue-700 hover:underline">view photo</a>
                  )}
                  {cur.history_count > 1 && (
                    <button onClick={openHistory} className="ml-2 text-blue-700 hover:underline">history ({cur.history_count})</button>
                  )}
                </div>
              );
            })()}

            <div className="flex justify-end gap-2 pt-2 border-t">
              <button onClick={() => setModalOpen(false)} className="px-3 py-2 text-sm rounded-lg border hover:bg-gray-50">Cancel</button>
              <button
                onClick={saveEntry}
                disabled={saving}
                className="px-3 py-2 text-sm rounded-lg bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save entry'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Meta editor modal */}
      <Modal isOpen={metaOpen} onClose={() => setMetaOpen(false)} title={metaProject ? `Project info — ${metaProject.project_name}` : 'Project info'}>
        {metaProject && (
          <div className="space-y-3">
            <div>
              <label className="text-xs font-semibold text-gray-700">CRM Owner</label>
              <div className="flex gap-1.5 mt-1">
                {CRM_OWNERS.map(name => (
                  <button
                    key={name}
                    onClick={() => setMetaDraft(d => ({ ...d, crm_owner: name }))}
                    className={`px-2.5 py-1.5 text-xs rounded border ${
                      metaDraft.crm_owner === name
                        ? (name === 'Sushila' ? 'bg-violet-100 border-violet-300 text-violet-700' : 'bg-orange-100 border-orange-300 text-orange-700')
                        : 'border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {name}
                  </button>
                ))}
                <input
                  value={CRM_OWNERS.includes(metaDraft.crm_owner) ? '' : (metaDraft.crm_owner || '')}
                  onChange={e => setMetaDraft(d => ({ ...d, crm_owner: e.target.value }))}
                  placeholder="Or type custom…"
                  className="flex-1 px-2 py-1 border rounded text-xs"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-semibold text-gray-700">Phase / Zone</label>
                <input
                  value={metaDraft.phase_zone || ''}
                  onChange={e => setMetaDraft(d => ({ ...d, phase_zone: e.target.value }))}
                  className="w-full mt-1 px-2 py-1.5 border rounded text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-700">PM Owner</label>
                <input
                  value={metaDraft.pm_owner || ''}
                  onChange={e => setMetaDraft(d => ({ ...d, pm_owner: e.target.value }))}
                  className="w-full mt-1 px-2 py-1.5 border rounded text-sm"
                />
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-700">Target Start</label>
              <input
                type="date"
                value={metaDraft.target_start || ''}
                onChange={e => setMetaDraft(d => ({ ...d, target_start: e.target.value }))}
                className="w-full mt-1 px-2 py-1.5 border rounded text-sm"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t">
              <button onClick={() => setMetaOpen(false)} className="px-3 py-2 text-sm rounded-lg border hover:bg-gray-50">Cancel</button>
              <button onClick={saveMeta} className="px-3 py-2 text-sm rounded-lg bg-blue-700 hover:bg-blue-800 text-white">Save</button>
            </div>
          </div>
        )}
      </Modal>

      {/* History drawer */}
      {historyOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setHistoryOpen(false)}>
          <div className="bg-white w-full sm:max-w-md h-full overflow-y-auto shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="bg-gradient-to-r from-blue-900 to-blue-950 text-white p-4 flex items-center justify-between sticky top-0 z-10">
              <div>
                <div className="text-xs opacity-80">{historyProject?.project_name}</div>
                <div className="font-semibold">{historyCp?.label}</div>
              </div>
              <button onClick={() => setHistoryOpen(false)} className="p-1 hover:bg-white/10 rounded"><FiX size={20} /></button>
            </div>
            <div className="p-3 space-y-3">
              {historyLoading && <div className="text-sm text-gray-500">Loading…</div>}
              {!historyLoading && historyRows.length === 0 && <div className="text-sm text-gray-500">No history yet.</div>}
              {historyRows.map(e => {
                const m = STATUS_META[e.status] || STATUS_META.na;
                return (
                  <div key={e.id} className="border rounded-lg p-2.5 bg-gray-50">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded ${m.chip}`}>
                        <m.icon size={11} /> {m.label}
                      </span>
                      <span className="text-[11px] text-gray-500">{fmtDt(e.uploaded_at)}</span>
                    </div>
                    <div className="text-[11px] text-gray-600 mt-1.5 flex items-center gap-3 flex-wrap">
                      <span className="inline-flex items-center gap-1"><FiCalendar size={10} /> {fmtD(e.observation_date)}</span>
                      {e.uploaded_by_name && <span className="inline-flex items-center gap-1"><FiUser size={10} /> {e.uploaded_by_name}</span>}
                    </div>
                    {e.remarks && <div className="text-xs italic text-gray-700 mt-1">"{e.remarks}"</div>}
                    {e.photo_path && (
                      <a href={e.photo_path} target="_blank" rel="noreferrer" className="block mt-2">
                        <img src={e.photo_path} alt="entry" className="w-full max-h-60 object-cover rounded border" />
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Manage Checkpoints drawer (admin) */}
      {manageOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setManageOpen(false)}>
          <div className="bg-white w-full sm:max-w-lg h-full overflow-y-auto shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="bg-gradient-to-r from-blue-900 to-blue-950 text-white p-4 flex items-center justify-between sticky top-0 z-10">
              <div className="font-semibold">Manage Checkpoints</div>
              <button onClick={() => setManageOpen(false)} className="p-1 hover:bg-white/10 rounded"><FiX size={20} /></button>
            </div>
            <div className="p-3 space-y-3">
              <div className="border rounded-lg p-3 bg-blue-50/60">
                <div className="text-sm font-semibold text-blue-900 mb-2">Add checkpoint</div>
                <div className="grid grid-cols-3 gap-2">
                  <select
                    value={draftCp.stage_no}
                    onChange={e => setDraftCp(d => ({ ...d, stage_no: Number(e.target.value) }))}
                    className="px-2 py-1.5 border rounded text-sm"
                  >
                    <option value={1}>Stage 1 · PRE-START</option>
                    <option value={2}>Stage 2 · EXECUTION</option>
                    <option value={3}>Stage 3 · HANDOVER</option>
                  </select>
                  <input
                    value={draftCp.section}
                    onChange={e => setDraftCp(d => ({ ...d, section: e.target.value.toUpperCase() }))}
                    placeholder="Section (e.g. DRAWINGS)"
                    className="px-2 py-1.5 border rounded text-sm"
                  />
                  <button
                    onClick={addCheckpoint}
                    className="px-2 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded text-sm flex items-center justify-center gap-1"
                  >
                    <FiPlus size={14} /> Add
                  </button>
                </div>
                <input
                  value={draftCp.label}
                  onChange={e => setDraftCp(d => ({ ...d, label: e.target.value }))}
                  placeholder="Label"
                  className="w-full px-2 py-1.5 border rounded text-sm mt-2"
                />
              </div>

              {[1, 2, 3].map(sn => {
                const cps = adminCps.filter(c => c.stage_no === sn);
                // Group by section for display
                const bySection = {};
                for (const c of cps) {
                  const k = c.section || 'OTHER';
                  if (!bySection[k]) bySection[k] = [];
                  bySection[k].push(c);
                }
                return (
                  <div key={sn} className="border rounded-lg overflow-hidden">
                    <div className={`bg-gradient-to-r ${STAGE_META[sn].accent} text-white px-3 py-2 text-sm font-semibold`}>
                      Stage {sn} · {STAGE_META[sn].title} <span className="text-[10px] opacity-80">({cps.length})</span>
                    </div>
                    {Object.entries(bySection).map(([sec, items]) => (
                      <div key={sec}>
                        <div className="bg-slate-100 px-3 py-1 text-[10px] font-bold uppercase text-slate-700">{sec}</div>
                        <div className="divide-y">
                          {items.map(c => (
                            <AdminCheckpointRow key={c.id} row={c} onSave={p => updateCp(c.id, p)} onDelete={() => deleteCp(c.id)} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Inline admin row ──────────────────────────────────────────────
function AdminCheckpointRow({ row, onSave, onDelete }) {
  const [edit, setEdit] = useState(false);
  const [d, setD] = useState({ label: row.label, section: row.section || '', sort_order: row.sort_order, stage_no: row.stage_no });
  useEffect(() => setD({ label: row.label, section: row.section || '', sort_order: row.sort_order, stage_no: row.stage_no }), [row]);
  if (!edit) {
    return (
      <div className="px-3 py-1.5 flex items-center justify-between gap-2 hover:bg-gray-50">
        <div className="flex-1 min-w-0 text-xs text-gray-800 truncate">
          <span className="text-[9px] font-mono bg-gray-100 px-1 rounded mr-1">#{row.sort_order}</span>
          {row.label}
        </div>
        <div className="flex gap-1">
          <button onClick={() => setEdit(true)} className="p-1 hover:bg-blue-100 text-blue-700 rounded" title="Edit"><FiEdit2 size={12} /></button>
          <button onClick={onDelete} className="p-1 hover:bg-rose-100 text-rose-700 rounded" title="Disable"><FiTrash2 size={12} /></button>
        </div>
      </div>
    );
  }
  return (
    <div className="px-3 py-2 bg-blue-50/40 space-y-1.5">
      <div className="grid grid-cols-3 gap-1.5">
        <select value={d.stage_no} onChange={e => setD(x => ({ ...x, stage_no: Number(e.target.value) }))} className="px-1.5 py-1 border rounded text-[11px]">
          <option value={1}>Stage 1</option><option value={2}>Stage 2</option><option value={3}>Stage 3</option>
        </select>
        <input value={d.section} onChange={e => setD(x => ({ ...x, section: e.target.value.toUpperCase() }))} placeholder="Section" className="px-1.5 py-1 border rounded text-[11px]" />
        <input type="number" value={d.sort_order} onChange={e => setD(x => ({ ...x, sort_order: Number(e.target.value) }))} className="px-1.5 py-1 border rounded text-[11px]" />
      </div>
      <input value={d.label} onChange={e => setD(x => ({ ...x, label: e.target.value }))} className="w-full px-2 py-1 border rounded text-sm" />
      <div className="flex gap-1.5 justify-end">
        <button onClick={() => setEdit(false)} className="px-2 py-1 text-[11px] border rounded hover:bg-gray-100">Cancel</button>
        <button onClick={() => { onSave(d); setEdit(false); }} className="px-2 py-1 text-[11px] bg-blue-700 hover:bg-blue-800 text-white rounded">Save</button>
      </div>
    </div>
  );
}
