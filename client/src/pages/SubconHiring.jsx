// Sub-contractor Hiring workflow tracker (mam 2026-05-28).
// Phase A: manual step tracker, file uploads, vendor candidate list,
// award flow, two PASS gates (Pre-Qualify + Docs Complete) with the
// loop-back arrows from mam's flowchart wired into the server.
//
// Two views in one page:
//   - List   : every workflow, current step + phase badge, open/delete
//   - Detail : 14-step vertical stepper with notes, uploads, candidates

import { useEffect, useState, useCallback } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import ResponsibilityTab from '../components/ResponsibilityTab';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { fmtDateTime } from '../utils/datetime';
import {
  FiPlus, FiTrash2, FiArrowLeft, FiUpload, FiDownload, FiPaperclip,
  FiUserPlus, FiCheckCircle, FiAlertTriangle, FiClock, FiAward, FiX,
  FiFolder, FiPlayCircle, FiChevronDown,
} from 'react-icons/fi';

const PHASE_LABEL = { pre_award: 'Phase 1 · Pre-Award', onboarding: 'Phase 2 · Onboarding', done: 'Done' };
const STATUS_LABEL = { pending: 'Pending', in_progress: 'In Progress', done: 'Done', blocked: 'Blocked' };
const STATUS_CLS = {
  pending:     'bg-gray-100 text-gray-600 border-gray-200',
  in_progress: 'bg-amber-50 text-amber-700 border-amber-300',
  done:        'bg-emerald-50 text-emerald-700 border-emerald-300',
  blocked:     'bg-red-50 text-red-700 border-red-300',
};

export default function SubconHiring() {
  const { canEdit, canDelete, canCreate } = useAuth();
  const [list, setList] = useState([]);
  const [openId, setOpenId] = useState(null);          // null = list view
  const [view, setView] = useState('list');            // 'list' | 'responsible'
  const [createOpen, setCreateOpen] = useState(false);
  const [sites, setSites] = useState([]);

  const load = useCallback(() => {
    api.get('/subcon-hiring').then(r => setList(r.data || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/dpr/sites').then(r => setSites(r.data || [])).catch(() => setSites([]));
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => { setView('list'); setOpenId(null); }} className={`btn ${view === 'list' ? 'btn-primary' : 'btn-secondary'}`}>Hiring List</button>
        <button onClick={() => setView('responsible')} className={`btn ${view === 'responsible' ? 'btn-primary' : 'btn-secondary'}`}>⚙ Responsible</button>
      </div>

      {view === 'responsible' && <ResponsibilityTab module="subcon_hiring" title="Hiring (Sub-contractor)" />}

      {view === 'list' && openId == null && (
        <ListView
          list={list}
          onOpen={setOpenId}
          onCreate={() => setCreateOpen(true)}
          onReload={load}
          canCreate={canCreate('subcon_hiring')}
          canDelete={canDelete('subcon_hiring')}
        />
      )}
      {view === 'list' && openId != null && (
        <DetailView
          id={openId}
          onBack={() => { setOpenId(null); load(); }}
          canEdit={canEdit('subcon_hiring')}
        />
      )}

      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title="Start new sub-contractor hiring">
        <CreateForm sites={sites} onDone={(id) => { setCreateOpen(false); load(); setOpenId(id); }} />
      </Modal>
    </div>
  );
}

// ─── LIST VIEW ────────────────────────────────────────────────────
function ListView({ list, onOpen, onCreate, onReload, canCreate, canDelete }) {
  const del = async (row) => {
    if (!confirm(`Delete hiring workflow for "${row.site_name}"? This removes all steps, candidates, files.`)) return;
    try { await api.delete(`/subcon-hiring/${row.id}`); toast.success('Deleted'); onReload(); }
    catch { toast.error('Delete failed'); }
  };
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2"><FiAward className="text-red-600" /> Sub-contractor Hiring</h2>
          <p className="text-xs text-gray-500">14-step workflow per site · Pre-Award → Onboarding</p>
        </div>
        {canCreate && (
          <button onClick={onCreate} className="btn btn-primary flex items-center gap-2"><FiPlus size={14} /> New Hiring</button>
        )}
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-[10px] text-gray-500 uppercase">
            <tr>
              <th className="text-left p-2">Site</th>
              <th className="text-left p-2">Scope</th>
              <th className="text-center p-2">Phase</th>
              <th className="text-center p-2">Current Step</th>
              <th className="text-left p-2">Awarded Vendor</th>
              <th className="text-left p-2">Raised By</th>
              <th className="text-center p-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {list.map(r => (
              <tr key={r.id} className="hover:bg-red-50/30">
                <td className="p-2 font-semibold">{r.site_name}</td>
                <td className="p-2 text-xs text-gray-600 truncate max-w-[260px]">{r.scope_description || <em className="text-gray-400">—</em>}</td>
                <td className="p-2 text-center">
                  <span className={`inline-block text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                    r.status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                    r.phase === 'pre_award' ? 'bg-sky-100 text-sky-700' :
                    'bg-purple-100 text-purple-700'}`}>
                    {r.status === 'completed' ? 'Completed' : PHASE_LABEL[r.phase] || r.phase}
                  </span>
                </td>
                <td className="p-2 text-center font-mono text-xs">Step {r.current_step} / 14</td>
                <td className="p-2 text-xs">{r.awarded_vendor_name || <em className="text-gray-400">— not yet —</em>}</td>
                <td className="p-2 text-xs text-gray-600">{r.created_by_name || '—'}</td>
                <td className="p-2 text-center">
                  <div className="flex justify-center gap-1">
                    <button onClick={() => onOpen(r.id)} className="btn btn-secondary text-xs">Open</button>
                    {canDelete && <button onClick={() => del(r)} className="p-1.5 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}
                  </div>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr><td colSpan="7" className="text-center py-10 text-gray-400 text-sm">
                <FiAward size={32} className="mx-auto mb-2 opacity-30" />
                No hiring workflows yet. Click <b>New Hiring</b> to start one.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─── CREATE FORM ──────────────────────────────────────────────────
function CreateForm({ sites, onDone }) {
  const [siteId, setSiteId] = useState('');
  const [scope, setScope] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!siteId) { toast.error('Pick a site'); return; }
    setSaving(true);
    try {
      const r = await api.post('/subcon-hiring', { site_id: siteId, scope_description: scope });
      toast.success('Workflow created');
      onDone(r.data.id);
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
    setSaving(false);
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className="label">Site *</label>
        <SearchableSelect
          options={sites.map(s => ({ id: s.id, label: `${s.name}${s.client_name ? ` · ${s.client_name}` : ''}` }))}
          value={siteId}
          valueKey="id"
          displayKey="label"
          placeholder="Pick a project / site…"
          onChange={v => setSiteId(v?.id || '')}
        />
      </div>
      <div>
        <label className="label">Scope description</label>
        <input className="input" value={scope} onChange={e => setScope(e.target.value)}
               placeholder="e.g. Plumbing trade for HERO Homes, Phase 2" />
        <p className="text-[11px] text-gray-500 mt-1">Free-text — what's the sub-let scope? Trade name, area, etc.</p>
      </div>
      <div className="flex justify-end gap-2">
        <button type="submit" disabled={saving} className="btn btn-primary disabled:opacity-40">{saving ? 'Creating…' : 'Create & Open'}</button>
      </div>
    </form>
  );
}

// ─── DETAIL VIEW (wizard, mam 2026-05-28: "one step at a time") ──
// Layout:
//   1. Header card — site, scope, phase + step pill, awarded vendor
//   2. BIG progress stepper — 14 circles with labels under each;
//      click to jump. Two-row wrap on smaller screens.
//   3. Wizard step card — ONE step at a time, full-width, all
//      controls visible inline (no Edit-Notes click first), with
//      ← Prev / Next → navigation in the footer.
//   4. Collapsible Candidates section
//   5. Collapsible Files section
function DetailView({ id, onBack, canEdit }) {
  const [data, setData] = useState(null);
  const [vendors, setVendors] = useState([]);
  const [activeStep, setActiveStep] = useState(null); // 1..14
  const [showCandidates, setShowCandidates] = useState(false);
  const [showFiles, setShowFiles] = useState(false);

  const load = useCallback(() => {
    api.get(`/subcon-hiring/${id}`).then(r => setData(r.data)).catch(() => toast.error('Failed to load'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/sub-contractors').then(r => setVendors(r.data || [])).catch(() => setVendors([]));
  }, []);

  // First load → land on whatever step the workflow is currently on.
  useEffect(() => {
    if (data && activeStep === null) setActiveStep(data.current_step);
  }, [data, activeStep]);

  if (!data) return <div className="card p-6 text-center text-gray-400">Loading…</div>;

  const meta = data.steps_meta.find(m => m.no === activeStep) || data.steps_meta[0];
  const step = data.steps.find(s => s.step_no === activeStep);
  const stepFiles = data.files.filter(f => f.step_no === activeStep);

  const goPrev = () => setActiveStep(s => Math.max(1, s - 1));
  const goNext = () => setActiveStep(s => Math.min(14, s + 1));

  return (
    <div className="space-y-3">
      {/* Header card */}
      <div className="card p-3 flex flex-wrap items-start justify-between gap-3 bg-gradient-to-r from-red-50 to-amber-50 border border-red-100">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={onBack} className="btn btn-secondary text-xs flex items-center gap-1 flex-shrink-0"><FiArrowLeft size={14} /> Back</button>
          <div className="min-w-0">
            <h2 className="text-lg font-bold truncate">{data.site_name}</h2>
            <p className="text-xs text-gray-600 truncate">{data.scope_description || <em className="text-gray-400">No scope set</em>} · {data.client_name || '—'}</p>
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-[10px] uppercase font-semibold text-gray-500">{PHASE_LABEL[data.phase]}</div>
          <div className="text-2xl font-bold text-red-700 leading-tight">Step {data.current_step} <span className="text-sm text-gray-400 font-normal">/ 14</span></div>
          {data.awarded_vendor_name && (
            <div className="text-xs mt-0.5"><FiAward className="inline text-amber-600 mr-1" size={12} />Awarded: <b>{data.awarded_vendor_name}</b></div>
          )}
        </div>
      </div>

      {/* BIG progress stepper */}
      <ProgressStepper data={data} activeStep={activeStep} onJump={setActiveStep} />

      {/* Wizard — one step at a time */}
      <StepWizardPanel
        meta={meta}
        step={step}
        hiringId={id}
        files={stepFiles}
        canEdit={canEdit}
        onReload={load}
        onPrev={activeStep > 1 ? goPrev : null}
        onNext={activeStep < 14 ? goNext : null}
        currentStepNo={data.current_step}
      />

      {/* Collapsible Candidates + Files */}
      <CollapsibleSection
        title="Candidate Vendors"
        icon={FiUserPlus}
        subtitle="Used by Steps 3 (Source) → 4 (Pre-Qualify) → 5 (RFQ) → 6 (Award)"
        count={data.candidates.length}
        open={showCandidates}
        onToggle={() => setShowCandidates(v => !v)}
      >
        <CandidatesPanel hiringId={id} data={data} vendors={vendors} canEdit={canEdit} onReload={load} />
      </CollapsibleSection>

      <CollapsibleSection
        title="All Files"
        icon={FiFolder}
        subtitle="Every upload across all 14 steps, grouped"
        count={data.files.length}
        open={showFiles}
        onToggle={() => setShowFiles(v => !v)}
      >
        <FilesPanel data={data} hiringId={id} canEdit={canEdit} onReload={load} />
      </CollapsibleSection>
    </div>
  );
}

// ─── BIG PROGRESS STEPPER (mam: was too small/unclear) ────────────
// 14 circles with the step label written under each one. Active step
// is bigger + ringed in red. Done = green check. Click any to jump.
function ProgressStepper({ data, activeStep, onJump }) {
  return (
    <div className="card p-3 overflow-x-auto">
      <div className="flex items-start gap-1 min-w-fit pb-1">
        {data.steps_meta.map((meta, idx) => {
          const step = data.steps.find(s => s.step_no === meta.no);
          const isDone = step?.status === 'done';
          const isInProgress = step?.status === 'in_progress';
          const isBlocked = step?.status === 'blocked';
          const isGate = !!meta.gate;
          const isActive = activeStep === meta.no;

          // Visual state for the bubble
          const bubbleCls = isActive
            ? 'bg-red-600 text-white border-red-600 ring-4 ring-red-200 scale-110'
            : isDone
              ? 'bg-emerald-500 text-white border-emerald-500'
              : isInProgress
                ? 'bg-amber-400 text-white border-amber-500 ring-2 ring-amber-200'
                : isBlocked
                  ? 'bg-red-500 text-white border-red-500'
                  : 'bg-white text-gray-500 border-gray-300';

          return (
            <div key={meta.no} className="flex items-start gap-0 flex-shrink-0">
              <button
                onClick={() => onJump(meta.no)}
                className="flex flex-col items-center w-[88px] sm:w-[100px] group"
                title={`Step ${meta.no} · ${meta.label} · ${STATUS_LABEL[step?.status || 'pending']}`}
              >
                <div className={`w-11 h-11 rounded-full flex items-center justify-center font-bold border-2 transition-all ${bubbleCls}`}>
                  {isDone ? <FiCheckCircle size={20} /> : <span className="text-base">{meta.no}</span>}
                </div>
                {isGate && (
                  <span className="text-[9px] font-bold uppercase text-purple-600 mt-0.5 leading-none">GATE</span>
                )}
                <span className={`text-[10px] font-medium mt-1.5 leading-tight text-center px-1 ${
                  isActive ? 'text-red-700' : isDone ? 'text-emerald-700' : 'text-gray-600'
                }`}>
                  {meta.label}
                </span>
              </button>
              {idx < data.steps_meta.length - 1 && (
                <div className={`h-0.5 w-3 sm:w-4 mt-[22px] flex-shrink-0 ${
                  isDone ? 'bg-emerald-400' : 'bg-gray-200'
                }`} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── COLLAPSIBLE SECTION (used for Candidates + Files) ───────────
function CollapsibleSection({ title, icon: Icon, subtitle, count, open, onToggle, children }) {
  return (
    <div className="card p-0 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full px-3 py-2.5 flex items-center justify-between hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Icon size={16} className="text-red-600" />
          <div className="text-left">
            <div className="font-semibold text-sm flex items-center gap-2">
              {title}
              {count > 0 && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">{count}</span>}
            </div>
            <div className="text-[11px] text-gray-500">{subtitle}</div>
          </div>
        </div>
        <FiChevronDown size={18} className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-3 pb-3 border-t border-gray-100">
          {children}
        </div>
      )}
    </div>
  );
}

// ─── STEP WIZARD PANEL — full-width single step ──────────────────
// All controls inline (no Edit-Notes click first). Footer holds
// Prev/Next navigation so user walks through the workflow.
function StepWizardPanel({ meta, step, hiringId, files, canEdit, onReload, onPrev, onNext, currentStepNo }) {
  const [notes, setNotes] = useState(step?.notes || '');
  const [statusDraft, setStatusDraft] = useState(step?.status || 'pending');
  const [decisionVal, setDecisionVal] = useState(step?.decision_value ?? '');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Sync local state when the active step changes
  useEffect(() => {
    setNotes(step?.notes || '');
    setStatusDraft(step?.status || 'pending');
    setDecisionVal(step?.decision_value ?? '');
  }, [meta.no, step?.notes, step?.status, step?.decision_value]);

  const isGate = !!meta.gate;
  const status = step?.status || 'pending';
  const isCurrentStep = meta.no === currentStepNo;

  const save = async () => {
    setSaving(true);
    try {
      await api.post(`/subcon-hiring/${hiringId}/step/${meta.no}`, {
        status: statusDraft, notes, decision_value: decisionVal === '' ? null : +decisionVal,
      });
      toast.success(`Step ${meta.no} saved`);
      onReload();
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
    setSaving(false);
  };

  const decideGate = async (pass) => {
    const reason = pass ? null : prompt('Reason for failing this gate (loops back to earlier step)?');
    if (!pass && reason === null) return;
    try {
      await api.post(`/subcon-hiring/${hiringId}/gate/${meta.gate}`, {
        pass, decision_value: decisionVal === '' ? null : +decisionVal,
        notes: reason ? `LOOP-BACK: ${reason}` : 'PASS',
      });
      toast.success(pass ? 'Gate passed — advanced' : 'Looped back to earlier step');
      onReload();
    } catch (e) { toast.error(e.response?.data?.error || 'Gate failed'); }
  };

  const upload = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    setUploading(true);
    try {
      await api.post(`/subcon-hiring/${hiringId}/step/${meta.no}/upload`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success('Uploaded'); onReload();
    } catch { toast.error('Upload failed'); }
    setUploading(false); e.target.value = '';
  };

  const delFile = async (fileId) => {
    if (!confirm('Delete this file?')) return;
    try { await api.delete(`/subcon-hiring/file/${fileId}`); toast.success('Deleted'); onReload(); }
    catch { toast.error('Failed'); }
  };

  return (
    <div className="card p-0 overflow-hidden">
      {/* Header strip — gradient with step number + label */}
      <div className={`px-4 py-3 border-b border-gray-200 flex items-center justify-between gap-3 ${
        status === 'done'        ? 'bg-emerald-50' :
        status === 'in_progress' ? 'bg-amber-50' :
        status === 'blocked'     ? 'bg-red-50' :
        'bg-gray-50'
      }`}>
        <div className="flex items-center gap-3 min-w-0">
          <div className={`w-12 h-12 rounded-full flex items-center justify-center text-base font-bold flex-shrink-0 ${
            status === 'done' ? 'bg-emerald-600 text-white' :
            status === 'in_progress' ? 'bg-amber-500 text-white' :
            status === 'blocked' ? 'bg-red-500 text-white' :
            'bg-white text-gray-500 border-2 border-gray-300'
          }`}>
            {status === 'done' ? <FiCheckCircle size={22} /> : meta.no}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-base font-bold text-gray-900">{meta.label}</h3>
              {isGate && <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-purple-100 text-purple-700 border border-purple-300">GATE</span>}
              {isCurrentStep && <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-blue-100 text-blue-700 border border-blue-300">CURRENT</span>}
            </div>
            <div className="text-[11px] text-gray-500 uppercase tracking-wide">{meta.owner} · {PHASE_LABEL[meta.phase]}</div>
          </div>
        </div>
        <span className={`text-xs font-bold uppercase px-3 py-1 rounded-full border ${STATUS_CLS[status]}`}>
          {STATUS_LABEL[status]}
        </span>
      </div>

      {/* Body — controls always visible (no Edit-Notes click first) */}
      <div className="p-4 space-y-3">
        {step?.completed_by_name && step?.completed_at && (
          <p className="text-[11px] text-gray-500">
            <FiCheckCircle className="inline text-emerald-600 mr-1" size={11} />
            Marked done by <b>{step.completed_by_name}</b> · {fmtDateTime(step.completed_at)}
          </p>
        )}

        {canEdit && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-bold uppercase text-gray-500 mb-1">Status</label>
              <select className="select text-sm" value={statusDraft} onChange={e => setStatusDraft(e.target.value)} disabled={!canEdit}>
                <option value="pending">Pending</option>
                <option value="in_progress">In Progress</option>
                <option value="done">Done</option>
                <option value="blocked">Blocked</option>
              </select>
            </div>
            {isGate && (
              <div>
                <label className="block text-[10px] font-bold uppercase text-gray-500 mb-1">
                  {meta.gate === 'prequalify' ? 'Vendor score (0–10)' : 'Docs % complete'}
                </label>
                <input type="number" min="0" max="10" step="0.1" className="input text-sm"
                  value={decisionVal} onChange={e => setDecisionVal(e.target.value)} placeholder="e.g. 7.5" />
              </div>
            )}
          </div>
        )}

        <div>
          <label className="block text-[10px] font-bold uppercase text-gray-500 mb-1">Notes</label>
          <textarea
            className="input text-sm"
            rows="3"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="What happened on this step?"
            disabled={!canEdit}
          />
        </div>

        {/* Files for this step */}
        <div>
          <label className="block text-[10px] font-bold uppercase text-gray-500 mb-1">Files ({files.length})</label>
          {files.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {files.map(f => (
                <span key={f.id} className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded px-2 py-1">
                  <FiPaperclip size={12} />
                  <a href={`/api/subcon-hiring/file/${f.id}`} target="_blank" rel="noreferrer" className="hover:underline truncate max-w-[200px]">{f.filename}</a>
                  {canEdit && <button onClick={() => delFile(f.id)} className="text-blue-400 hover:text-red-600 ml-0.5"><FiX size={12} /></button>}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-400 italic mb-2">No files attached.</p>
          )}
          {canEdit && (
            <label className="btn btn-secondary text-xs flex items-center gap-1 cursor-pointer w-fit mb-0">
              <FiUpload size={12} />{uploading ? 'Uploading…' : 'Attach file'}
              <input type="file" className="hidden" onChange={upload} disabled={uploading} />
            </label>
          )}
        </div>

        {/* Action row: save + gate buttons */}
        {canEdit && (
          <div className="flex flex-wrap gap-2 items-center pt-2 border-t border-gray-100">
            <button onClick={save} disabled={saving} className="btn btn-primary text-sm disabled:opacity-40">
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            {isGate && status !== 'done' && (
              <>
                <button onClick={() => decideGate(true)} className="btn btn-success text-sm">PASS → advance</button>
                <button onClick={() => decideGate(false)} className="btn btn-danger text-sm">FAIL → loop back</button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Wizard navigation footer */}
      <div className="px-4 py-2.5 bg-gray-50 border-t border-gray-200 flex items-center justify-between">
        <button
          onClick={onPrev}
          disabled={!onPrev}
          className="btn btn-secondary text-sm flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <FiArrowLeft size={14} /> Prev step
        </button>
        <span className="text-xs text-gray-500">Step <b>{meta.no}</b> of 14</span>
        <button
          onClick={onNext}
          disabled={!onNext}
          className="btn btn-secondary text-sm flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Next step <FiChevronDown size={14} className="-rotate-90" />
        </button>
      </div>
    </div>
  );
}

// ─── FILES PANEL — all uploads, grouped by step ───────────────────
function FilesPanel({ data, hiringId, canEdit, onReload }) {
  const filesByStep = {};
  for (const f of data.files) {
    (filesByStep[f.step_no] = filesByStep[f.step_no] || []).push(f);
  }
  const stepsWithFiles = Object.keys(filesByStep).map(Number).sort((a, b) => a - b);

  const delFile = async (fileId) => {
    if (!confirm('Delete this file?')) return;
    try { await api.delete(`/subcon-hiring/file/${fileId}`); toast.success('Deleted'); onReload(); }
    catch { toast.error('Failed'); }
  };

  if (stepsWithFiles.length === 0) {
    return (
      <div className="text-center py-10 text-gray-400 text-sm">
        <FiFolder size={32} className="mx-auto mb-2 opacity-30" />
        No files uploaded yet. Use the <b>Upload File</b> button on any step to attach evidence (photos, PDFs, KYC docs, MSA, etc.).
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {stepsWithFiles.map(stepNo => {
        const meta = data.steps_meta.find(m => m.no === stepNo);
        return (
          <div key={stepNo} className="border border-gray-200 rounded-lg overflow-hidden">
            <div className="bg-gray-50 px-3 py-1.5 border-b border-gray-200">
              <span className="text-xs font-bold text-gray-700">Step {stepNo} · {meta?.label || 'Unknown'}</span>
              <span className="text-[10px] text-gray-500 ml-2">{filesByStep[stepNo].length} file{filesByStep[stepNo].length === 1 ? '' : 's'}</span>
            </div>
            <div className="p-2 flex flex-wrap gap-1.5">
              {filesByStep[stepNo].map(f => (
                <span key={f.id} className="inline-flex items-center gap-1 text-[11px] bg-blue-50 text-blue-700 border border-blue-200 rounded px-2 py-1">
                  <FiPaperclip size={11} />
                  <a href={`/api/subcon-hiring/file/${f.id}`} target="_blank" rel="noreferrer" className="hover:underline truncate max-w-[260px]">{f.filename}</a>
                  <span className="text-[9px] text-blue-400 ml-1">· {f.uploaded_by_name || '—'}</span>
                  {canEdit && <button onClick={() => delFile(f.id)} className="text-blue-400 hover:text-red-600 ml-0.5"><FiX size={11} /></button>}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── CANDIDATES PANEL (Steps 3-6 supporting data) ────────────────
function CandidatesPanel({ hiringId, data, vendors, canEdit, onReload }) {
  const [vendorId, setVendorId] = useState('');
  const [quote, setQuote] = useState('');
  const [score, setScore] = useState('');

  const add = async () => {
    if (!vendorId) { toast.error('Pick a vendor'); return; }
    try {
      await api.post(`/subcon-hiring/${hiringId}/candidate`, {
        vendor_id: vendorId, quote_amount: quote ? +quote : null, qualification_score: score ? +score : null,
      });
      toast.success('Vendor shortlisted');
      setVendorId(''); setQuote(''); setScore(''); onReload();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  const award = async (cid) => {
    if (!confirm('Award the work to this vendor? This sets them as the winner of this hiring.')) return;
    try { await api.post(`/subcon-hiring/${hiringId}/award/${cid}`); toast.success('Awarded'); onReload(); }
    catch { toast.error('Failed'); }
  };

  const remove = async (cid) => {
    if (!confirm('Remove this candidate from the shortlist?')) return;
    try { await api.delete(`/subcon-hiring/candidate/${cid}`); toast.success('Removed'); onReload(); }
    catch { toast.error('Failed'); }
  };

  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm flex items-center gap-2"><FiUserPlus className="text-red-600" /> Candidate Vendors</h3>
        <span className="text-[10px] text-gray-500">Used by Steps 3 (Source) → 4 (Pre-Qualify) → 5 (RFQ) → 6 (Award)</span>
      </div>

      {data.candidates.length === 0 && (
        <p className="text-xs text-gray-400 italic">No candidates yet. Add at least 3 vendors per mam's flowchart spec.</p>
      )}
      {data.candidates.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-[10px] text-gray-500 uppercase">
              <tr>
                <th className="text-left p-1.5">Vendor</th>
                <th className="text-left p-1.5">Trade</th>
                <th className="text-right p-1.5">Quote (₹)</th>
                <th className="text-center p-1.5">Score / 10</th>
                <th className="text-center p-1.5">Status</th>
                {canEdit && <th className="text-center p-1.5">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.candidates.map(c => (
                <tr key={c.id} className={c.status === 'awarded' ? 'bg-amber-50' : ''}>
                  <td className="p-1.5 font-medium">{c.vendor_name}</td>
                  <td className="p-1.5 text-gray-600">{c.specialization || '—'}</td>
                  <td className="p-1.5 text-right">{c.quote_amount ? `Rs ${(+c.quote_amount).toLocaleString('en-IN')}` : '—'}</td>
                  <td className="p-1.5 text-center">{c.qualification_score ?? '—'}</td>
                  <td className="p-1.5 text-center">
                    {c.status === 'awarded' && <span className="text-[10px] font-bold text-amber-700"><FiAward className="inline" size={11} /> AWARDED</span>}
                    {c.status === 'rejected' && <span className="text-[10px] text-red-600">Rejected</span>}
                    {c.status === 'shortlisted' && <span className="text-[10px] text-gray-600">Shortlisted</span>}
                  </td>
                  {canEdit && (
                    <td className="p-1.5 text-center">
                      <div className="flex justify-center gap-1">
                        {c.status !== 'awarded' && !data.awarded_vendor_id && (
                          <button onClick={() => award(c.id)} className="btn btn-success text-[10px] py-0.5 px-1.5" title="Award">Award</button>
                        )}
                        <button onClick={() => remove(c.id)} className="p-1 text-gray-400 hover:text-red-600" title="Remove"><FiX size={12} /></button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && (
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto] gap-2 items-end pt-2 border-t border-gray-100">
          <div>
            <label className="text-[10px] font-semibold uppercase text-gray-500">Add vendor from Master Detail</label>
            <SearchableSelect
              options={vendors.map(v => ({ id: v.id, label: `${v.name}${v.specialization ? ` · ${v.specialization}` : ''}` }))}
              value={vendorId}
              valueKey="id"
              displayKey="label"
              placeholder="Pick a sub-contractor…"
              onChange={v => setVendorId(v?.id || '')}
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold uppercase text-gray-500">Quote ₹</label>
            <input type="number" className="input text-xs w-28" value={quote} onChange={e => setQuote(e.target.value)} placeholder="0" />
          </div>
          <div>
            <label className="text-[10px] font-semibold uppercase text-gray-500">Score /10</label>
            <input type="number" min="0" max="10" step="0.1" className="input text-xs w-20" value={score} onChange={e => setScore(e.target.value)} placeholder="0.0" />
          </div>
          <button onClick={add} className="btn btn-primary text-xs flex items-center gap-1"><FiPlus size={12} /> Add</button>
        </div>
      )}
    </div>
  );
}
