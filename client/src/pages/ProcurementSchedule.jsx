// Procurement Schedule — Phase A Gantt (mam 2026-05-28).
// Custom SVG Gantt (no npm dependency added). Two-tier rows: a trade
// header summarises its category, click to expand the BOQ items under
// it. Bars are coloured by phase. "Today" line drawn in red. Hover
// gives item description + phase + dates.

import { useState, useEffect, useMemo, useCallback } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { fmtDateTime } from '../utils/datetime';
import { useUrlTab } from '../hooks/useUrlTab';
import {
  FiCalendar, FiRefreshCw, FiSettings, FiChevronDown, FiChevronRight,
  FiAlertTriangle, FiClock, FiFlag, FiX, FiCpu, FiCheck,
  FiUpload, FiPaperclip, FiSave, FiFileText, FiArchive, FiDownload, FiEye, FiTrash2,
} from 'react-icons/fi';

const PHASES = ['indent', 'quotes', 'po', 'dispatch', 'receive', 'install'];
const PHASE_LABEL = {
  indent:   'Indent raise',
  quotes:   'Vendor quotes',
  po:       'PO sent',
  dispatch: 'Vendor dispatch',
  receive:  'Site receive',
  install:  'Install',
};
// Distinct colour per phase so a single bar reads at a glance.
const PHASE_COLOR = {
  indent:   { bg: '#fef3c7', border: '#f59e0b', text: '#92400e' },  // amber
  quotes:   { bg: '#e0e7ff', border: '#6366f1', text: '#3730a3' },  // indigo
  po:       { bg: '#dbeafe', border: '#3b82f6', text: '#1e40af' },  // blue
  dispatch: { bg: '#fce7f3', border: '#ec4899', text: '#9d174d' },  // pink
  receive:  { bg: '#d1fae5', border: '#10b981', text: '#065f46' },  // green
  install:  { bg: '#fed7aa', border: '#ea580c', text: '#7c2d12' },  // orange
};

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
};
const daysBetween = (a, b) => {
  const da = new Date(a + 'T00:00:00').getTime();
  const db = new Date(b + 'T00:00:00').getTime();
  return Math.round((db - da) / (1000 * 60 * 60 * 24));
};

export default function ProcurementSchedule() {
  const { isAdmin, canEdit } = useAuth();
  const [tab, setTab] = useUrlTab('gantt');                 // gantt | records | holidays
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useUrlTab('', 'project'); // ?project=42 persists across reloads
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [detail, setDetail] = useState(null);

  // AI draft state — kept in this top-level component so the user can
  // toggle to the Holidays tab and back without losing their AI run.
  const [aiSuggesting, setAiSuggesting] = useState(false);
  const [aiDraft, setAiDraft] = useState(null);   // { suggestions, model, input_tokens, output_tokens }
  const [aiApproving, setAiApproving] = useState(false);
  // Bundle A meta — start/end dates, client requirements text, drawings.
  // Loaded per project, defaults to business_book's committed_* columns.
  const [meta, setMeta] = useState(null);
  const [metaDirty, setMetaDirty] = useState(false);
  // Bundle B (mam 2026-05-28) — vision API on by default. Mam can opt out
  // to keep the regenerate cheap (~₹2-5/call without drawings vs ~₹15-100
  // when 5+ pages of PDFs are read).
  const [skipDrawings, setSkipDrawings] = useState(false);

  const loadProjects = useCallback(() => {
    api.get('/procurement-schedule/projects').then(r => setProjects(r.data || [])).catch(() => {});
  }, []);
  useEffect(() => { loadProjects(); }, [loadProjects]);

  const loadSchedule = useCallback(() => {
    if (!projectId) { setData(null); setAiDraft(null); return; }
    setLoading(true);
    api.get(`/procurement-schedule/${projectId}`)
      .then(r => setData(r.data))
      .catch(err => toast.error(err.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [projectId]);
  useEffect(() => { loadSchedule(); setAiDraft(null); }, [loadSchedule]);

  const loadMeta = useCallback(() => {
    if (!projectId) { setMeta(null); return; }
    api.get(`/procurement-schedule/${projectId}/meta`)
      .then(r => { setMeta(r.data); setMetaDirty(false); })
      .catch(() => setMeta(null));
  }, [projectId]);
  useEffect(() => { loadMeta(); }, [loadMeta]);

  const saveMeta = async () => {
    if (!projectId || !meta) return;
    try {
      await api.put(`/procurement-schedule/${projectId}/meta`, {
        start_date: meta.start_date || null,
        end_date:   meta.end_date   || null,
        client_requirements: meta.client_requirements || '',
      });
      toast.success('Setup saved');
      setMetaDirty(false);
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };

  const askAi = async () => {
    if (!projectId) { toast.error('Pick a project first'); return; }
    if (metaDirty) await saveMeta();        // auto-save meta before AI call
    setAiSuggesting(true);
    setAiDraft(null);
    try {
      const r = await api.post(`/procurement-schedule/${projectId}/ai-suggest`, {
        start_date: meta?.start_date || null,
        end_date:   meta?.end_date   || null,
        client_requirements: meta?.client_requirements || '',
        skip_drawings: skipDrawings,
      });
      setAiDraft(r.data);
      toast.success(`AI proposed lead times for ${r.data.suggestions.length} items — review below`);
    } catch (e) {
      toast.error(e.response?.data?.error || 'AI call failed');
    } finally {
      setAiSuggesting(false);
    }
  };

  const approveAiDraft = async (editedSuggestions) => {
    if (!projectId || !editedSuggestions) return;
    setAiApproving(true);
    try {
      const r = await api.post(`/procurement-schedule/${projectId}/regenerate`, {
        suggestions: editedSuggestions,
        end_date: meta?.end_date || null,
      });
      toast.success(`Generated ${r.data.rows_written} bars across ${r.data.items_scheduled} items`);
      setAiDraft(null);
      loadSchedule();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Generate failed');
    } finally {
      setAiApproving(false);
    }
  };

  const uploadDrawing = async (file) => {
    if (!projectId || !file) return;
    const fd = new FormData(); fd.append('file', file);
    try {
      await api.post(`/procurement-schedule/${projectId}/drawings`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success('Drawing uploaded');
      loadMeta();
    } catch (e) { toast.error(e.response?.data?.error || 'Upload failed'); }
  };

  const deleteDrawing = async (id) => {
    if (!confirm('Remove this drawing?')) return;
    try { await api.delete(`/procurement-schedule/drawing/${id}`); toast.success('Removed'); loadMeta(); }
    catch { toast.error('Failed'); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2"><FiCalendar className="text-red-600" /> Procurement Schedule</h1>
          <p className="text-xs text-gray-500">AI generates lead times from your BOQ; you review and approve; the Gantt then surfaces the date you MUST raise each indent so the project finishes on time.</p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-200">
        {[
          { id: 'gantt',    label: 'Schedule (Gantt)', icon: FiCalendar },
          { id: 'records',  label: 'Records (saved)',  icon: FiArchive },
          { id: 'holidays', label: 'Holidays',         icon: FiFlag },
        ].map(t => {
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2 text-sm border-b-2 -mb-px transition ${
                active ? 'border-red-600 text-red-700 font-semibold' : 'border-transparent text-gray-600 hover:text-red-700'
              }`}>
              <t.icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'gantt' && (
        <>
          {/* Project picker */}
          <div className="card p-3">
            <label className="text-[10px] font-bold uppercase text-gray-500 mb-1 block">Project</label>
            <SearchableSelect
              options={projects.map(p => ({
                id: p.id,
                label: `${p.company_name}${p.client_name ? ' · ' + p.client_name : ''} — completes ${fmtDate(p.completion_date)}${p.scheduled_rows > 0 ? ' · scheduled' : ''}`,
              }))}
              value={projectId ? +projectId : null}
              valueKey="id" displayKey="label"
              placeholder="Pick a project…"
              onChange={v => setProjectId(v?.id ? String(v.id) : '')}
            />
          </div>

          {/* SETUP CARD — Bundle A inputs that flow into the AI prompt
              (mam 2026-05-28). Start/end default from business_book's
              committed dates but the user can override. Client
              requirements + drawings let the AI see context beyond just
              the BOQ list. */}
          {projectId && meta && (
            <div className="card p-3 space-y-3 bg-blue-50/40 border border-blue-100">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-sm flex items-center gap-2"><FiSettings className="text-blue-700" size={14} /> Setup — feeds the AI</h3>
                {metaDirty && canEdit('procurement_schedule') && (
                  <button onClick={saveMeta} className="btn btn-secondary text-xs flex items-center gap-1"><FiSave size={12} /> Save</button>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold uppercase text-gray-500 mb-1 block">Project start date</label>
                  <input type="date" className="input text-sm"
                    value={meta.start_date || ''}
                    disabled={!canEdit('procurement_schedule')}
                    onChange={e => { setMeta(m => ({ ...m, start_date: e.target.value })); setMetaDirty(true); }}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold uppercase text-gray-500 mb-1 block">End / completion date *</label>
                  <input type="date" className="input text-sm"
                    value={meta.end_date || ''}
                    disabled={!canEdit('procurement_schedule')}
                    onChange={e => { setMeta(m => ({ ...m, end_date: e.target.value })); setMetaDirty(true); }}
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] font-bold uppercase text-gray-500 mb-1 block">Client / project requirements (free text)</label>
                <textarea
                  className="input text-sm"
                  rows="3"
                  placeholder="e.g. Phase 2 handover required by 15 May; AHUs imported from Malaysia; rooftop access restricted on Sundays; client has fire NOC inspection on 1 May…"
                  value={meta.client_requirements || ''}
                  disabled={!canEdit('procurement_schedule')}
                  onChange={e => { setMeta(m => ({ ...m, client_requirements: e.target.value })); setMetaDirty(true); }}
                />
                <p className="text-[10px] text-gray-500 mt-0.5">Free-form text — mention urgency, phasing, milestones, vendor preferences. AI reads this to adjust lead times.</p>
              </div>

              <div>
                <label className="text-[10px] font-bold uppercase text-gray-500 mb-1 block">Drawings + reference docs</label>
                {meta.drawings && meta.drawings.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {meta.drawings.map(d => (
                      <span key={d.id} className="inline-flex items-center gap-1 text-xs bg-white border border-blue-200 rounded px-2 py-1">
                        <FiFileText size={11} className="text-blue-600" />
                        <a href={`/api/procurement-schedule/drawing/${d.id}`} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline truncate max-w-[220px]">{d.filename}</a>
                        <span className="text-[9px] text-gray-400">{(d.file_size/1024).toFixed(0)} KB</span>
                        {canEdit('procurement_schedule') && (
                          <button onClick={() => deleteDrawing(d.id)} className="text-gray-400 hover:text-red-600"><FiX size={11} /></button>
                        )}
                      </span>
                    ))}
                  </div>
                )}
                {canEdit('procurement_schedule') && (
                  <label className="btn btn-secondary text-xs flex items-center gap-1 cursor-pointer w-fit mb-0">
                    <FiUpload size={12} /> Attach drawing / spec PDF
                    <input type="file" className="hidden" accept="application/pdf,image/*" onChange={e => { uploadDrawing(e.target.files?.[0]); e.target.value = ''; }} />
                  </label>
                )}
                <p className="text-[10px] text-gray-500 mt-1">
                  <b>AI reads drawing contents now.</b> PDF pages / images are sent to Claude's vision API so the model can cross-check the BOQ against the layout, spot missing items, and refine lead times. Cost: ~₹2–5 per page.
                </p>
                {meta.drawings && meta.drawings.length > 0 && canEdit('procurement_schedule') && (
                  <label className="text-[11px] flex items-center gap-1.5 mt-2 cursor-pointer">
                    <input type="checkbox" checked={skipDrawings} onChange={e => setSkipDrawings(e.target.checked)} />
                    <span>Skip drawings this run (save tokens — filenames only, no vision)</span>
                  </label>
                )}
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-blue-100">
                <p className="text-[11px] text-gray-600">
                  {data?.project && (
                    <>Current anchor: <b className="text-red-700">{fmtDate(meta.end_date || data.project.completion_date)}</b></>
                  )}
                </p>
                {canEdit('procurement_schedule') && (
                  <button onClick={askAi} disabled={aiSuggesting || !meta.end_date} className="btn btn-primary text-sm flex items-center gap-1 disabled:opacity-40">
                    <FiCpu size={14} /> {aiSuggesting ? 'AI thinking…' : (data?.rows?.length ? 'Re-ask AI with this context' : 'Generate with AI')}
                  </button>
                )}
              </div>
            </div>
          )}

          {!projectId && (
            <div className="card p-8 text-center text-gray-400">
              <FiCalendar size={36} className="mx-auto mb-2 opacity-30" />
              Pick a project above to view or generate its procurement schedule.
            </div>
          )}

          {projectId && aiSuggesting && (
            <div className="card p-8 text-center">
              <FiCpu size={32} className="mx-auto mb-2 text-red-500 animate-pulse" />
              <p className="font-semibold mb-1">AI is analysing your BOQ…</p>
              <p className="text-xs text-gray-500">Predicting vendor lead times for each item. This takes 5–20 seconds depending on BOQ size.</p>
            </div>
          )}

          {projectId && !aiSuggesting && aiDraft && (
            <AiDraftReview
              draft={aiDraft}
              onApprove={approveAiDraft}
              onCancel={() => setAiDraft(null)}
              approving={aiApproving}
              canEdit={canEdit('procurement_schedule')}
            />
          )}

          {projectId && !aiSuggesting && !aiDraft && loading && (
            <div className="card p-6 text-center text-gray-400">Loading existing schedule…</div>
          )}

          {projectId && !aiSuggesting && !aiDraft && !loading && data && data.rows.length === 0 && (
            <div className="card p-8 text-center">
              <FiAlertTriangle size={32} className="mx-auto mb-2 text-amber-500" />
              <p className="font-semibold mb-1">No schedule yet</p>
              <p className="text-xs text-gray-500 mb-3">Click <b>Generate with AI</b> above. AI will predict vendor lead times for each BOQ item; you review and approve before the Gantt is created.</p>
            </div>
          )}

          {projectId && !aiSuggesting && !aiDraft && !loading && data && data.rows.length > 0 && (
            <GanttView data={data} expanded={expanded} setExpanded={setExpanded} onPickBar={setDetail} />
          )}
        </>
      )}

      {tab === 'records'  && <RecordsTab projects={projects} canDelete={canEdit('procurement_schedule')} />}
      {tab === 'holidays' && <HolidaysEditor canEdit={canEdit('procurement_schedule')} />}

      <Modal isOpen={!!detail} onClose={() => setDetail(null)} title={detail ? `${PHASE_LABEL[detail.phase]} · ${detail.item_description || 'Item'}` : 'Detail'}>
        {detail && <BarDetail row={detail} />}
      </Modal>
    </div>
  );
}

// ─── AI DRAFT REVIEW (mam 2026-05-28: AI proposes, mam approves) ──
// Shows the model's per-item predictions. User can edit any number or
// trade before clicking Approve. Each row carries the AI's reasoning
// so mam knows WHY 14 days vs 7 days for similar-looking items.
function AiDraftReview({ draft, onApprove, onCancel, approving, canEdit }) {
  const [rows, setRows] = useState(draft.suggestions);
  useEffect(() => { setRows(draft.suggestions); }, [draft]);

  const update = (idx, key, value) => {
    setRows(r => r.map((x, i) => i === idx ? { ...x, [key]: value } : x));
  };

  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-3 py-2 bg-red-50 border-b border-red-100 flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="font-semibold text-sm flex items-center gap-1"><FiCpu className="text-red-600" /> AI Draft — review & approve</h3>
          <p className="text-[11px] text-gray-600">
            {rows.length} item{rows.length === 1 ? '' : 's'} · model: <code className="text-[10px]">{draft.model}</code>
            {draft.input_tokens && draft.output_tokens && (
              <> · {draft.input_tokens.toLocaleString('en-IN')} in + {draft.output_tokens.toLocaleString('en-IN')} out tokens</>
            )}
          </p>
          {draft.vision && (
            <p className="text-[10px] text-gray-500 mt-0.5">
              {draft.vision.used
                ? <>📐 AI saw <b>{draft.vision.sent}</b> drawing{draft.vision.sent === 1 ? '' : 's'} ({(draft.vision.bytes_used/1024/1024).toFixed(1)} MB){draft.vision.skipped?.length > 0 && <> · skipped {draft.vision.skipped.length}: {draft.vision.skipped.map(s => s.filename).join(', ')}</>}</>
                : <>Vision skipped — AI saw filenames only</>
              }
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={onCancel} disabled={approving} className="btn btn-secondary text-xs disabled:opacity-40">Cancel</button>
          <button onClick={() => onApprove(rows)} disabled={approving || !canEdit}
            className="btn btn-success text-xs flex items-center gap-1 disabled:opacity-40">
            <FiCheck size={12} /> {approving ? 'Generating…' : 'Approve & Generate Schedule'}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 text-[10px] uppercase text-gray-500">
            <tr>
              <th className="text-left p-2">Item</th>
              <th className="text-center p-2 w-32">Trade</th>
              <th className="text-center p-2 w-28">Dispatch (days)</th>
              <th className="text-left p-2">AI Reasoning</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.item_id} className="border-t border-gray-100">
                <td className="p-2">
                  <div className="font-medium">{r.item_description}</div>
                  <div className="text-[10px] text-gray-500 font-mono">
                    {r.item_code || '—'} · {r.item_qty} {r.item_unit || ''}
                  </div>
                </td>
                <td className="p-1 text-center">
                  <select className="select text-xs"
                    value={r.trade}
                    disabled={!canEdit}
                    onChange={e => update(i, 'trade', e.target.value)}>
                    {['Fire Fighting','Plumbing','Electrical','HVAC','Solar','Networking','CCTV','Cable','Civil','Other'].map(t =>
                      <option key={t} value={t}>{t}</option>
                    )}
                  </select>
                </td>
                <td className="p-1 text-center">
                  <input type="number" min="1" max="120"
                    className="input text-xs w-20 text-center mx-auto"
                    value={r.dispatch_days}
                    disabled={!canEdit}
                    onChange={e => update(i, 'dispatch_days', Math.max(1, Math.min(120, +e.target.value || 1)))}
                  />
                </td>
                <td className="p-2 text-gray-700 italic">{r.reasoning || <span className="text-gray-300">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-gray-500 px-3 py-2 border-t border-gray-100">
        Edit any value above before clicking <b>Approve</b>. Approving runs the backward-pass with these per-item lead times and writes the Gantt bars.
      </p>
    </div>
  );
}

// ─── GANTT VIEW (custom SVG) ──────────────────────────────────────
// Bundle C addition (mam 2026-05-28): a week-row underneath the month
// axis showing W1 / W2 / W3 + Monday start dates. Download-PDF button
// triggers a browser print with a tailored stylesheet so the chart
// drops onto landscape A3/A4 cleanly.
function GanttView({ data, expanded, setExpanded, onPickBar }) {
  // Bucket rows by trade then item
  const grouped = useMemo(() => {
    const out = {};
    for (const r of data.rows) {
      const t = r.trade || 'Other';
      if (!out[t]) out[t] = {};
      const key = r.item_id ?? 'rollup';
      if (!out[t][key]) out[t][key] = { item_id: r.item_id, item_description: r.item_description, item_code: r.item_code, phases: {} };
      out[t][key].phases[r.phase] = r;
    }
    return out;
  }, [data]);

  // Time scale — fit the chart from earliest start to latest end
  const { minDate, maxDate, totalDays } = useMemo(() => {
    let mn = null, mx = null;
    for (const r of data.rows) {
      if (!mn || r.start_date < mn) mn = r.start_date;
      if (!mx || r.end_date   > mx) mx = r.end_date;
    }
    const total = mn && mx ? daysBetween(mn, mx) + 1 : 0;
    return { minDate: mn, maxDate: mx, totalDays: total };
  }, [data]);

  const PX_PER_DAY = totalDays > 180 ? 5 : totalDays > 90 ? 8 : 14;
  const CHART_W = Math.max(800, totalDays * PX_PER_DAY);
  const ROW_H = 28;
  const LEFT_LABEL_W = 280;

  // Build row list — trade headers + (if expanded) item rows
  const rowList = [];
  Object.keys(grouped).sort().forEach(trade => {
    const items = Object.values(grouped[trade]);
    rowList.push({ kind: 'trade', trade, items, expanded: !!expanded[trade] });
    if (expanded[trade]) {
      items.forEach(it => rowList.push({ kind: 'item', trade, ...it }));
    }
  });

  const today = new Date().toISOString().slice(0, 10);
  const todayOffsetDays = today >= minDate && today <= maxDate ? daysBetween(minDate, today) : null;

  return (
    <div className="card p-0 overflow-hidden" id="procurement-gantt-printable">
      {/* Legend — simplified to indent-only (mam 2026-05-28). The five
          downstream phases (Quotes / PO / Dispatch / Receive / Install)
          are still computed for the math but hidden from the chart so
          mam sees only the action she has to take. */}
      <div className="px-3 py-2 border-b border-gray-100 flex flex-wrap items-center gap-3 bg-gray-50 print:hidden">
        <span className="text-[10px] flex items-center gap-1.5">
          <span className="w-3 h-3 rounded" style={{ background: PHASE_COLOR.indent.bg, border: `1px solid ${PHASE_COLOR.indent.border}` }} />
          <b>Indent raise window</b> — bar shows the date range by which each indent MUST be raised
        </span>
        {data.generated_at && (
          <span className="text-[10px] text-gray-400 ml-auto">
            Last generated: {fmtDateTime(data.generated_at)}
          </span>
        )}
        <button onClick={() => window.print()} className="btn btn-secondary text-xs flex items-center gap-1 ml-2"
          title="Open browser print dialog → Save as PDF">
          <FiDownload size={12} /> Download PDF
        </button>
      </div>

      <div className="overflow-x-auto" style={{ maxHeight: '70vh' }}>
        <div className="relative" style={{ width: LEFT_LABEL_W + CHART_W }}>
          {/* Sticky left label column */}
          <div className="absolute top-0 left-0 z-10 bg-white border-r border-gray-200" style={{ width: LEFT_LABEL_W }}>
            <div className="h-8 px-3 flex items-center text-[10px] font-bold uppercase text-gray-500 border-b border-gray-200 bg-gray-50">
              Trade / Item
            </div>
            {rowList.map((r, i) => (
              <div key={i}
                className={`h-7 px-3 flex items-center text-xs border-b border-gray-100 ${r.kind === 'trade' ? 'bg-gray-50 font-semibold cursor-pointer hover:bg-gray-100' : ''}`}
                onClick={() => r.kind === 'trade' ? setExpanded(prev => ({ ...prev, [r.trade]: !prev[r.trade] })) : null}
              >
                {r.kind === 'trade' ? (
                  <>
                    {r.expanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                    <span className="ml-1">{r.trade}</span>
                    <span className="ml-auto text-[10px] font-normal text-gray-500">{r.items.length} item{r.items.length === 1 ? '' : 's'}</span>
                  </>
                ) : (
                  <>
                    <span className="text-gray-400 ml-3 mr-1.5 text-[10px]">{r.item_code || '—'}</span>
                    <span className="truncate" title={r.item_description}>{r.item_description || '(no description)'}</span>
                  </>
                )}
              </div>
            ))}
          </div>

          {/* Chart area */}
          <div className="ml-[280px]">
            {/* Date axis (month labels) */}
            <DateAxis minDate={minDate} totalDays={totalDays} pxPerDay={PX_PER_DAY} />

            {/* Today line — top offset matches DateAxis height (28 month row +
                20 week row when week ticks render). */}
            {todayOffsetDays !== null && (
              <div className="absolute pointer-events-none" style={{
                top: PX_PER_DAY * 7 >= 28 ? 48 : 28,
                left: LEFT_LABEL_W + todayOffsetDays * PX_PER_DAY,
                width: 2,
                height: rowList.length * 28,
                background: 'rgba(220, 38, 38, 0.6)',
              }} title={`Today · ${fmtDate(today)}`}>
                <div className="absolute -top-3 -left-4 text-[9px] font-bold text-red-600 whitespace-nowrap">TODAY</div>
              </div>
            )}

            {/* Bars — mam 2026-05-28: 'only indent raise'. The other 5
                phases still get computed + stored (the backward-pass needs
                them) but we hide them so the Gantt is the single source of
                truth for the only action the user takes: raising indents. */}
            {rowList.map((r, i) => (
              <div key={i} className="h-7 border-b border-gray-100 relative" style={{ width: CHART_W }}>
                {r.kind === 'item' && (() => {
                  const ph = r.phases.indent;
                  if (!ph) return null;
                  const startOffset = daysBetween(minDate, ph.start_date);
                  const widthDays = daysBetween(ph.start_date, ph.end_date) + 1;
                  const c = PHASE_COLOR.indent;
                  return (
                    <button
                      onClick={() => onPickBar({ ...ph, item_description: r.item_description })}
                      title={`Raise indent · ${fmtDate(ph.start_date)} → ${fmtDate(ph.end_date)} (${widthDays}d window)`}
                      className="absolute top-1 h-5 rounded text-[10px] font-bold flex items-center justify-center px-1 truncate hover:brightness-95"
                      style={{
                        left: startOffset * PX_PER_DAY,
                        width: Math.max(20, widthDays * PX_PER_DAY - 1),
                        background: c.bg, border: `1px solid ${c.border}`, color: c.text,
                      }}
                    >
                      {widthDays * PX_PER_DAY > 60 ? `Raise by ${fmtDate(ph.end_date)}` : 'Indent'}
                    </button>
                  );
                })()}
                {/* Trade rollup — span across the trade's earliest →
                    latest INDENT window only (matches the item-row scope). */}
                {r.kind === 'trade' && (() => {
                  let mn = null, mx = null;
                  for (const it of r.items) {
                    const p = it.phases.indent; if (!p) continue;
                    if (!mn || p.start_date < mn) mn = p.start_date;
                    if (!mx || p.end_date   > mx) mx = p.end_date;
                  }
                  if (!mn || !mx) return null;
                  const startOffset = daysBetween(minDate, mn);
                  const widthDays = daysBetween(mn, mx) + 1;
                  return (
                    <div className="absolute top-2 h-3 rounded bg-amber-200/40 border border-amber-300"
                      title={`${r.trade} indents window: ${fmtDate(mn)} → ${fmtDate(mx)}`}
                      style={{
                        left: startOffset * PX_PER_DAY,
                        width: Math.max(8, widthDays * PX_PER_DAY - 1),
                      }} />
                  );
                })()}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── DATE AXIS HEADER (two-row: months + weeks) ──────────────────
// Bundle C (mam 2026-05-28): added a second row below the month ticks
// with the Monday-start date of each week ("3 Mar", "10 Mar", …). This
// is what mam meant by "show dates also week wise" — gives a finer
// readout than just the month, especially for short-window projects.
function DateAxis({ minDate, totalDays, pxPerDay }) {
  // Row 1 — month ticks
  const monthTicks = [];
  let lastMonth = '';
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(minDate + 'T00:00:00');
    d.setDate(d.getDate() + i);
    const m = d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
    if (m !== lastMonth) {
      monthTicks.push({ offset: i * pxPerDay, label: m });
      lastMonth = m;
    }
  }

  // Row 2 — week ticks (every Monday). Skip if zoom is so dense that
  // ticks would overlap (< 28 px between consecutive Mondays).
  const weekTicks = [];
  const pxPerWeek = pxPerDay * 7;
  if (pxPerWeek >= 28) {
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(minDate + 'T00:00:00');
      d.setDate(d.getDate() + i);
      // Mon = 1 in JS
      if (d.getDay() === 1 || i === 0) {
        const label = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
        weekTicks.push({ offset: i * pxPerDay, label });
      }
    }
  }

  return (
    <div className="relative border-b border-gray-200 bg-gray-50">
      <div className="h-7 relative">
        {monthTicks.map((t, i) => (
          <div key={i} className="absolute top-0 text-[10px] font-semibold text-gray-700 border-l border-gray-300 pl-1 leading-7" style={{ left: t.offset, height: '100%' }}>
            {t.label}
          </div>
        ))}
      </div>
      {weekTicks.length > 0 && (
        <div className="h-5 relative border-t border-gray-200 bg-white">
          {weekTicks.map((t, i) => (
            <div key={i} className="absolute top-0 text-[9px] text-gray-500 border-l border-gray-200 pl-0.5 leading-5" style={{ left: t.offset, height: '100%' }}>
              {t.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── BAR DETAIL PANEL ─────────────────────────────────────────────
function BarDetail({ row }) {
  return (
    <div className="space-y-2 text-sm">
      <div className="grid grid-cols-2 gap-2">
        <div><span className="text-gray-500 text-[10px] uppercase block">Phase</span><b>{PHASE_LABEL[row.phase] || row.phase}</b></div>
        <div><span className="text-gray-500 text-[10px] uppercase block">Trade</span><b>{row.trade}</b></div>
        <div><span className="text-gray-500 text-[10px] uppercase block">Start</span><b>{fmtDate(row.start_date)}</b></div>
        <div><span className="text-gray-500 text-[10px] uppercase block">End</span><b>{fmtDate(row.end_date)}</b></div>
        <div><span className="text-gray-500 text-[10px] uppercase block">Duration</span><b>{row.lead_days} business day{row.lead_days === 1 ? '' : 's'}</b></div>
        <div><span className="text-gray-500 text-[10px] uppercase block">Status</span><b className="uppercase">{row.status}</b></div>
      </div>
      {row.item_description && (
        <div className="bg-gray-50 rounded p-2 text-xs">
          <div className="text-[10px] uppercase text-gray-500">Item</div>
          <div>{row.item_description}</div>
          {row.boq_qty && <div className="text-[10px] text-gray-500 mt-0.5">BOQ qty: {row.boq_qty} {row.unit || ''}</div>}
        </div>
      )}
      {row.phase === 'indent' && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          <FiAlertTriangle className="inline mr-1" size={12} />
          This is the "must raise indent by" window. Slipping past <b>{fmtDate(row.end_date)}</b> will cascade delays through every later phase.
        </p>
      )}
    </div>
  );
}

// PhaseRulesEditor removed (mam 2026-05-28). AI now infers lead times
// per item via /ai-suggest, so the manual category × phase matrix is
// no longer surfaced. The seeded fallback values still live in the DB
// for any item the AI can't classify, but the UI doesn't expose them.

// ─── HOLIDAYS EDITOR (admin) ──────────────────────────────────────
// ─── RECORDS TAB — saved schedule snapshots + PDF download ────────
// Bundle C (mam 2026-05-28: "one tab when i approved saved and show
// here where i can download pdf also"). Lists every snapshot ever
// approved, across all projects. Click a row to open the historical
// Gantt in the modal. Download triggers a print dialog with a print
// stylesheet (see index.css's @media print rules) so the chart drops
// onto landscape A3 cleanly without a heavy jsPDF dependency.
function RecordsTab({ projects, canDelete }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [pickedProjectId, setPickedProjectId] = useState('');
  const [viewing, setViewing] = useState(null);
  const [viewData, setViewData] = useState(null);
  const [expanded, setExpanded] = useState({});

  const load = useCallback(() => {
    if (!pickedProjectId) { setList([]); return; }
    setLoading(true);
    api.get(`/procurement-schedule/${pickedProjectId}/snapshots`)
      .then(r => setList(r.data || []))
      .catch(() => setList([]))
      .finally(() => setLoading(false));
  }, [pickedProjectId]);
  useEffect(() => { load(); }, [load]);

  const openSnapshot = async (snap) => {
    try {
      const r = await api.get(`/procurement-schedule/snapshot/${snap.id}`);
      // Reshape for GanttView. steps_meta + project shape matches a
      // live schedule payload exactly so we reuse the same component.
      setViewData(r.data);
      setViewing(snap);
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to load snapshot'); }
  };

  const del = async (snap) => {
    if (!confirm(`Delete this snapshot from ${fmtDate(snap.generated_at)}?`)) return;
    try { await api.delete(`/procurement-schedule/snapshot/${snap.id}`); toast.success('Deleted'); load(); }
    catch { toast.error('Failed'); }
  };

  return (
    <div className="space-y-3">
      <div className="card p-3">
        <label className="text-[10px] font-bold uppercase text-gray-500 mb-1 block">Project</label>
        <SearchableSelect
          options={projects.map(p => ({ id: p.id, label: `${p.company_name}${p.client_name ? ' · ' + p.client_name : ''}` }))}
          value={pickedProjectId ? +pickedProjectId : null}
          valueKey="id" displayKey="label"
          placeholder="Pick a project to see its saved Gantts…"
          onChange={v => setPickedProjectId(v?.id ? String(v.id) : '')}
        />
      </div>

      {!pickedProjectId && (
        <div className="card p-8 text-center text-gray-400">
          <FiArchive size={36} className="mx-auto mb-2 opacity-30" />
          Pick a project above to see its saved schedule history.
        </div>
      )}

      {pickedProjectId && loading && <div className="card p-6 text-center text-gray-400">Loading…</div>}

      {pickedProjectId && !loading && list.length === 0 && (
        <div className="card p-8 text-center text-gray-400">
          <FiArchive size={32} className="mx-auto mb-2 opacity-30" />
          No saved schedules for this project yet. Every time you click <b>Approve & Generate</b> on the Gantt tab, a snapshot is saved automatically.
        </div>
      )}

      {pickedProjectId && !loading && list.length > 0 && (
        <div className="card p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-[10px] uppercase text-gray-500">
              <tr>
                <th className="text-left p-2">When generated</th>
                <th className="text-left p-2">By</th>
                <th className="text-center p-2">Items</th>
                <th className="text-center p-2">Earliest indent</th>
                <th className="text-center p-2">Completion anchor</th>
                <th className="text-center p-2 w-32">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map(r => (
                <tr key={r.id} className="border-t border-gray-100 hover:bg-gray-50/60">
                  <td className="p-2 font-mono text-xs">{fmtDateTime(r.generated_at)}</td>
                  <td className="p-2 text-xs">{r.generated_by_name || '—'}</td>
                  <td className="p-2 text-center font-semibold">{r.items_scheduled}</td>
                  <td className="p-2 text-center text-xs text-red-700">{fmtDate(r.earliest_indent_date)}</td>
                  <td className="p-2 text-center text-xs">{fmtDate(r.anchor_date)}</td>
                  <td className="p-2 text-center">
                    <div className="flex justify-center gap-1">
                      <button onClick={() => openSnapshot(r)} className="btn btn-secondary text-xs flex items-center gap-1"><FiEye size={11} /> Open</button>
                      {canDelete && <button onClick={() => del(r)} className="p-1.5 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={12} /></button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[10px] text-gray-500 p-2 border-t border-gray-100">
            Click <b>Open</b> to view a historical Gantt — same chart, same colours. <b>Download PDF</b> button at the top of the chart triggers your browser's print dialog (choose "Save as PDF" as the destination).
          </p>
        </div>
      )}

      {/* Snapshot view modal — reuses GanttView for visual parity */}
      <Modal isOpen={!!viewing} onClose={() => { setViewing(null); setViewData(null); }} title={viewing ? `Saved schedule · ${fmtDateTime(viewing.generated_at)}` : 'Snapshot'} wide>
        {viewData && (
          <div className="space-y-2">
            <div className="text-xs text-gray-600">
              <b>{viewData.project.project_name}</b> · {viewData.snapshot.items_scheduled} items · anchor <b>{fmtDate(viewData.snapshot.anchor_date)}</b> · earliest indent <b className="text-red-700">{fmtDate(viewData.snapshot.earliest_indent_date)}</b>
            </div>
            <GanttView data={viewData} expanded={expanded} setExpanded={setExpanded} onPickBar={() => {}} />
          </div>
        )}
      </Modal>
    </div>
  );
}

function HolidaysEditor({ canEdit }) {
  const [list, setList] = useState([]);
  const [date, setDate] = useState('');
  const [label, setLabel] = useState('');

  const load = useCallback(() => {
    api.get('/procurement-schedule/holidays').then(r => setList(r.data || [])).catch(()=>{});
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!date) { toast.error('Pick a date'); return; }
    try {
      await api.post('/procurement-schedule/holidays', { holiday_date: date, label });
      toast.success('Added'); setDate(''); setLabel(''); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  const del = async (id) => {
    if (!confirm('Remove this holiday from the calendar?')) return;
    try { await api.delete(`/procurement-schedule/holidays/${id}`); toast.success('Removed'); load(); }
    catch { toast.error('Failed'); }
  };

  return (
    <div className="card p-3 space-y-3">
      <h3 className="font-semibold text-sm">Holiday Calendar — dates skipped by lead-time math</h3>
      {canEdit && (
        <div className="flex flex-wrap gap-2 items-end border-b border-gray-100 pb-3">
          <div>
            <label className="text-[10px] font-bold uppercase text-gray-500 block">Date</label>
            <input type="date" className="input text-sm" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="text-[10px] font-bold uppercase text-gray-500 block">Label (optional)</label>
            <input className="input text-sm" value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Diwali" />
          </div>
          <button onClick={add} className="btn btn-primary text-sm">Add holiday</button>
        </div>
      )}
      <div className="space-y-1">
        {list.length === 0 && <p className="text-xs text-gray-400 italic">No holidays — only Sundays will be skipped.</p>}
        {list.map(h => (
          <div key={h.id} className="flex items-center gap-2 text-xs py-1 border-b border-gray-50">
            <span className="font-mono w-24">{h.holiday_date}</span>
            <span className="flex-1">{h.label || <em className="text-gray-400">no label</em>}</span>
            {canEdit && <button onClick={() => del(h.id)} className="text-gray-400 hover:text-red-600"><FiX size={14} /></button>}
          </div>
        ))}
      </div>
    </div>
  );
}
