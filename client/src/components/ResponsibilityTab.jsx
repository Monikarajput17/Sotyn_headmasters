// Reusable "Responsible" tab — drop <ResponsibilityTab module="crm_funnel" />
// into any module page to get the per-record RACI + SLA time-tracking board
// (mam 2026-06-27). Per step you pick Responsible / Accountable / Consulted /
// Informed + the target time (SLA hours); the board shows the actual time each
// step took and who ran late, plus a By-Person performance summary. Backed by
// /api/raci/board/:module + /api/raci/record/:module/:id (shared engine).
import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';

// hours → compact "2.5h" / "1d 3h" / "—"
function fmtDur(h) {
  if (h == null) return '—';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 24) return `${Math.round(h * 10) / 10}h`;
  const d = Math.floor(h / 24); const rem = Math.round(h - d * 24);
  return rem ? `${d}d ${rem}h` : `${d}d`;
}

const RACI_FIELDS = [
  ['responsible_id', 'Responsible', 'text-emerald-600'],
  ['accountable_id', 'Accountable', 'text-blue-600'],
  ['consulted_id', 'Consulted', 'text-amber-600'],
  ['informed_id', 'Informed', 'text-gray-500'],
];

export default function ResponsibilityTab({ module, title }) {
  const [data, setData] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState('grid');         // 'grid' | 'summary'
  const [q, setQ] = useState('');
  // The per-record board loads ALL records × steps — heavy enough to hang big
  // modules on the small VPS (mam 2026-06-29: "per enquiry no need to show — it
  // takes data and hangs; only need Set RACI for whole module"). So it's now
  // opt-in: the tab opens straight to the whole-module RACI setter and the board
  // loads only when the user clicks "Show per-record board".
  const [showBoard, setShowBoard] = useState(false);

  // Editor modal
  const [editRec, setEditRec] = useState(null);      // record being edited
  const [editSteps, setEditSteps] = useState([]);
  const [busy, setBusy] = useState(false);

  // Users for the R/A/C/I dropdowns — light; always loaded so the whole-module
  // editor works without pulling the heavy board.
  useEffect(() => {
    api.get('/auth/users').then(u => setUsers((u.data || []).filter(x => x.active !== 0))).catch(() => {});
  }, []);

  // Heavy per-record board — loaded only on demand (see showBoard note above).
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const b = await api.get(`/raci/board/${module}`);
      setData(b.data);
      setShowBoard(true);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not load the Responsible board');
    } finally { setLoading(false); }
  }, [module]);

  const openEditor = async (rec) => {
    setEditRec(rec); setBusy(true);
    try {
      const cfg = await api.get(`/raci/record/${module}/${rec.id}`);
      setEditSteps(cfg.data.steps || []);
    } catch { toast.error('Could not load RACI for this record'); }
    finally { setBusy(false); }
  };
  const setField = (i, k, v) => setEditSteps(s => s.map((x, idx) => idx === i ? { ...x, [k]: v } : x));
  const save = async () => {
    if (!editRec) return;
    setBusy(true);
    try {
      await api.put(`/raci/record/${module}/${editRec.id}`, {
        steps: editSteps.map(s => ({
          step_key: s.key,
          responsible_id: s.responsible_id || null, accountable_id: s.accountable_id || null,
          consulted_id: s.consulted_id || null, informed_id: s.informed_id || null,
          sla_hours: s.sla_hours === '' || s.sla_hours == null ? null : +s.sla_hours,
          weight: s.weight === '' || s.weight == null ? null : +s.weight,
          commitment: s.commitment && String(s.commitment).trim() !== '' ? s.commitment : null,
        })),
      });
      toast.success('Saved'); setEditRec(null); if (showBoard) load();
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
    finally { setBusy(false); }
  };

  // Quick "mark done" (or reopen) for one step — stamps the completion date the
  // scoring view uses for elapsed/late time. value = 'YYYY-MM-DD' to set, null to
  // reopen. This is the "time" half of mam's "person name + time" per step.
  const stampStep = async (rec, step, value) => {
    try {
      await api.put(`/raci/step-done/${module}/${rec.id}`, { step_key: step.key, done_at: value || null });
      toast.success(value ? `${step.label} marked done` : `${step.label} reopened`);
      if (showBoard) load();
    } catch (e) { toast.error(e.response?.data?.error || 'Could not update the step'); }
  };
  const todayStr = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

  const rows = (data?.rows || []).filter(r => {
    if (!q.trim()) return true;
    const s = (r.title + ' ' + (r.subtitle || '')).toLowerCase();
    return s.includes(q.trim().toLowerCase());
  });
  const summary = data?.summary || [];

  return (
    <div className="space-y-3">
      {/* Header / controls */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-gray-800">{title || data?.label || 'Responsible'} — who owns each step & how long it took</h3>
          <p className="text-[11px] text-gray-500">Assign R / A / C / I + target time per step on each record. Red = ran past the target (late).</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Set RACI ONCE for the whole module (default for every record, mam
              2026-06-27: "whole module raci one"). Each record inherits it unless
              it has its own override. Stored under record_id 0. */}
          <button
            onClick={() => openEditor({ id: 0, title: 'Whole module — default for all records' })}
            className="text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded px-2.5 h-8">
            ⚙ Set RACI for whole module
          </button>
          {!showBoard ? (
            <button onClick={load} disabled={loading} className="btn btn-secondary h-8 text-xs">
              {loading ? 'Loading…' : 'Show per-record board'}
            </button>
          ) : (
            <>
              <input className="input text-xs h-8 w-44" placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} />
              <div className="flex rounded-lg overflow-hidden border border-gray-300 text-xs">
                <button onClick={() => setView('grid')} className={`px-3 py-1.5 ${view === 'grid' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600'}`}>Per record</button>
                <button onClick={() => setView('summary')} className={`px-3 py-1.5 ${view === 'summary' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600'}`}>By person</button>
              </div>
              <button onClick={load} className="btn btn-secondary h-8 text-xs">↻</button>
            </>
          )}
        </div>
      </div>

      {!showBoard ? (
        <div className="py-8 px-4 text-center text-gray-500 text-sm border rounded-lg bg-white">
          Use <b>⚙ Set RACI for whole module</b> to assign Responsible / Accountable / Consulted / Informed, SLA, weight &amp; commitment once — it applies to every record.
          <div className="text-xs text-gray-400 mt-1">The per-record list is hidden for speed. Click <b>Show per-record board</b> above only if you need to assign or mark steps on individual records.</div>
        </div>
      ) : loading && !data ? (
        <div className="py-12 text-center text-gray-400 text-sm">Loading…</div>
      ) : view === 'summary' ? (
        // ── By-person performance summary ──
        <div className="overflow-x-auto border rounded-lg bg-white">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="text-left p-2">Person</th>
                <th className="text-right p-2">Steps owned</th>
                <th className="text-right p-2">Avg time / step</th>
                <th className="text-right p-2">Total time</th>
                <th className="text-right p-2">Late steps</th>
                <th className="text-right p-2">Late %</th>
                <th className="text-right p-2">Late hours</th>
              </tr>
            </thead>
            <tbody>
              {summary.length === 0 ? (
                <tr><td colSpan="7" className="text-center p-6 text-gray-400">No responsible assignments yet. Assign people per step in the “Per record” view.</td></tr>
              ) : summary.map(p => (
                <tr key={p.name} className="border-t">
                  <td className="p-2 font-semibold text-gray-800">{p.name}</td>
                  <td className="p-2 text-right">{p.steps}</td>
                  <td className="p-2 text-right">{fmtDur(p.avg_hours)}</td>
                  <td className="p-2 text-right">{fmtDur(p.total_hours)}</td>
                  <td className={`p-2 text-right font-semibold ${p.late_count ? 'text-rose-600' : 'text-emerald-600'}`}>{p.late_count}</td>
                  <td className={`p-2 text-right ${p.late_pct >= 30 ? 'text-rose-600' : p.late_pct > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>{p.late_pct}%</td>
                  <td className="p-2 text-right text-rose-600">{p.late_hours ? fmtDur(p.late_hours) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        // ── Per-record grid ──
        <div className="space-y-2">
          {rows.length === 0 ? (
            <div className="py-10 text-center text-gray-400 text-sm">No records.</div>
          ) : rows.map(r => (
            <div key={r.id} className="border rounded-lg bg-white p-2.5">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <span className="font-semibold text-sm text-gray-800">{r.title}</span>
                  <span className="text-xs text-gray-500"> · {r.subtitle}</span>
                </div>
                <button onClick={() => openEditor(r)}
                  className="shrink-0 text-[11px] font-semibold text-indigo-700 hover:text-white hover:bg-indigo-600 border border-indigo-300 rounded px-2 py-0.5 transition">
                  ⚙ Assign R/A/C/I + time
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {r.steps.map(s => {
                  const late = s.late_hours > 0;
                  const tint = s.status === 'done' ? 'bg-emerald-50 border-emerald-200'
                    : s.status === 'current' ? 'bg-amber-50 border-amber-200'
                    : 'bg-gray-50 border-gray-200';
                  return (
                    <div key={s.key} className={`border rounded-md px-2 py-1 text-[11px] min-w-[148px] ${tint}`} title={s.at ? `Completed: ${s.at}` : (s.status === 'current' ? 'In progress' : 'Not started')}>
                      <div className="font-semibold text-gray-700">{s.label}</div>
                      <div className="text-gray-600">
                        {s.responsible
                          ? <span className="text-emerald-700">R: {s.responsible}{s.responsible_default && <span className="text-gray-400 font-normal"> ·owner</span>}</span>
                          : <span className="text-gray-400">unassigned</span>}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-gray-500">⏱ {fmtDur(s.elapsed_hours)}</span>
                        {s.sla_hours != null && <span className="text-gray-400">/ {fmtDur(s.sla_hours)}</span>}
                        {late && <span className="text-rose-600 font-semibold">⚠ {fmtDur(s.late_hours)} late</span>}
                      </div>
                      {/* Mark-done date — the "time" half of person + time, fed to scoring.
                          Works even for steps with no native date (e.g. Negotiation). */}
                      <div className="mt-1 pt-1 border-t border-black/5 flex items-center gap-1">
                        {s.done_at ? (
                          <>
                            <span className="text-emerald-700 font-semibold">✓ {String(s.done_at).slice(0, 10)}</span>
                            <button onClick={() => stampStep(r, s, null)} title="Reopen step" className="ml-auto text-gray-400 hover:text-rose-600">✕</button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => stampStep(r, s, todayStr())} className="px-1.5 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-700 text-[10px] font-semibold">✓ done</button>
                            <input type="date" onChange={e => e.target.value && stampStep(r, s, e.target.value)} title="or pick the date it was done" className="text-[10px] border border-gray-300 rounded px-1 py-0.5 text-gray-600 w-[110px]" />
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Per-record editor */}
      <Modal isOpen={!!editRec} onClose={() => setEditRec(null)} title={`Responsible & time — ${editRec?.title || ''}`} wide>
        <div className="space-y-3">
          <p className="text-xs text-gray-500">Pick the <b>R</b>esponsible / <b>A</b>ccountable / <b>C</b>onsulted / <b>I</b>nformed person, the target time (SLA hours), the <b>Weight %</b> (makes the scorecard step-wise % weighted) and a <b>Commitment</b> for next week — for each step of <b>this</b> record.</p>
          {busy && editSteps.length === 0 ? (
            <div className="py-8 text-center text-gray-400 text-sm">Loading…</div>
          ) : (
            <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
              {editSteps.map((s, i) => (
                <div key={s.key} className="border rounded-lg p-3 bg-white">
                  <div className="font-semibold text-sm mb-2 text-gray-800">{s.label}</div>
                  <div className="grid grid-cols-2 sm:grid-cols-7 gap-2">
                    {RACI_FIELDS.map(([field, label, tint]) => (
                      <div key={field}>
                        <label className={`label text-[10px] ${tint}`}>{label}</label>
                        <select className="input text-xs" value={s[field] || ''} onChange={e => setField(i, field, e.target.value ? +e.target.value : null)}>
                          <option value="">— pick —</option>
                          {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                      </div>
                    ))}
                    <div>
                      <label className="label text-[10px] text-rose-600">SLA (hours)</label>
                      <input type="number" min="0" step="any" className="input text-xs" placeholder="e.g. 24" value={s.sla_hours ?? ''} onChange={e => setField(i, 'sla_hours', e.target.value === '' ? '' : +e.target.value)} />
                    </div>
                    <div>
                      <label className="label text-[10px] text-indigo-600">Weight %</label>
                      <input type="number" min="0" step="any" className="input text-xs" placeholder="e.g. 20" value={s.weight ?? ''} onChange={e => setField(i, 'weight', e.target.value === '' ? '' : +e.target.value)} />
                    </div>
                    <div>
                      <label className="label text-[10px] text-amber-600">Commitment (next wk)</label>
                      <input type="text" className="input text-xs" placeholder="for next week" value={s.commitment ?? ''} onChange={e => setField(i, 'commitment', e.target.value)} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2 border-t">
            <button onClick={() => setEditRec(null)} className="btn btn-secondary">Cancel</button>
            <button onClick={save} disabled={busy || editSteps.length === 0} className="btn btn-primary">{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
