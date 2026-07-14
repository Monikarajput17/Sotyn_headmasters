import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { FiSun, FiX, FiAlertTriangle, FiCheckCircle, FiTrash2, FiTool } from 'react-icons/fi';
import api from '../api';
import { num as fmt, inr } from '../lib/solar/format';

const cr = (v) => `₹${fmt((v || 0) / 1e7, 2)} Cr`;

export default function SolarProjects() {
  const [stages, setStages] = useState([]);
  const [projects, setProjects] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [tab, setTab] = useState('pipeline');
  const [modal, setModal] = useState(null);

  const load = () => {
    api.get('/solar/projects').then((r) => setProjects(r.data || [])).catch(() => toast.error('Could not load projects'));
    api.get('/solar/projects/stats/analytics').then((r) => setAnalytics(r.data)).catch(() => {});
  };
  useEffect(() => { api.get('/solar/projects/config').then((r) => setStages(r.data.stages || [])); load(); }, []); // eslint-disable-line

  const byStage = useMemo(() => {
    const m = {}; stages.forEach((s) => (m[s.key] = []));
    projects.forEach((p) => { (m[p.stage] = m[p.stage] || []).push(p); });
    return m;
  }, [projects, stages]);

  const move = async (p, stage) => { if (stage === p.stage) return; try { await api.post(`/solar/projects/${p.id}/move`, { stage }); load(); } catch { toast.error('Move failed'); } };
  const open = (id) => api.get(`/solar/projects/${id}`).then((r) => setModal(r.data));
  const T = analytics?.totals;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FiTool className="text-amber-600" /> Solar Projects — Execution &amp; AMC</h1>
          <p className="text-xs text-gray-500">Every won deal from Order → Design/Approvals → Procurement → Installation → Commissioning → Handover → AMC, with payment milestones and stuck-stage alerts.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setTab('pipeline')} className={`px-4 py-2 rounded-full text-sm font-semibold border ${tab === 'pipeline' ? 'bg-blue-800 text-white border-blue-800' : 'bg-white text-gray-600 border-gray-200'}`}>Pipeline</button>
          <button onClick={() => setTab('cash')} className={`px-4 py-2 rounded-full text-sm font-semibold border ${tab === 'cash' ? 'bg-blue-800 text-white border-blue-800' : 'bg-white text-gray-600 border-gray-200'}`}>Cash &amp; Stages</button>
        </div>
      </div>

      {T && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="card p-3"><p className="text-[10px] text-gray-500 uppercase">Active projects</p><p className="text-xl font-bold">{T.active}</p></div>
          <div className="card p-3"><p className="text-[10px] text-gray-500 uppercase">Order value</p><p className="text-xl font-bold text-indigo-700">{cr(T.value)}</p></div>
          <div className="card p-3"><p className="text-[10px] text-gray-500 uppercase">Cash collected</p><p className="text-xl font-bold text-emerald-600">{cr(T.collected)}</p></div>
          <div className="card p-3"><p className="text-[10px] text-gray-500 uppercase">Cash pending</p><p className="text-xl font-bold text-amber-600">{cr(T.pending)}</p></div>
          <div className="card p-3"><p className="text-[10px] text-gray-500 uppercase">Stuck (constraint)</p><p className={`text-xl font-bold ${T.stuck ? 'text-rose-600' : ''}`}>{T.stuck}</p></div>
        </div>
      )}

      {analytics?.amcDue?.length > 0 && (
        <div className="card p-3 border-l-4 border-amber-400 bg-amber-50/50 text-xs">
          <p className="font-bold text-amber-700 flex items-center gap-1 mb-1"><FiAlertTriangle size={13} /> {analytics.amcDue.length} AMC service(s) due within 30 days</p>
          <div className="flex flex-wrap gap-2">{analytics.amcDue.map((a) => <button key={a.id} onClick={() => open(a.id)} className="bg-white border border-amber-200 rounded-full px-2 py-1 hover:bg-amber-100">{a.project_no} · {a.client_name} — due {a.amc_next_due}</button>)}</div>
        </div>
      )}

      {tab === 'pipeline' ? (
        <div className="overflow-x-auto pb-2">
          <div className="flex gap-3 min-w-max">
            {stages.map((s) => (
              <div key={s.key} className="w-64 flex-shrink-0">
                <div className="rounded-t-lg bg-blue-900 text-white px-3 py-2 flex items-center justify-between">
                  <span className="text-xs font-semibold">{s.label}</span><span className="text-[10px] bg-white/20 rounded-full px-2">{(byStage[s.key] || []).length}</span>
                </div>
                <div className="bg-gray-50 rounded-b-lg p-2 space-y-2 min-h-[120px]">
                  {(byStage[s.key] || []).map((p) => (
                    <div key={p.id} className={`bg-white rounded-lg border p-2 shadow-sm cursor-pointer ${p.stuck ? 'border-rose-300 ring-1 ring-rose-200' : ''}`} onClick={() => open(p.id)}>
                      <div className="flex items-center justify-between"><span className="text-[11px] font-semibold text-blue-900">{p.project_no}</span>{p.stuck && <FiAlertTriangle className="text-rose-500" size={12} />}</div>
                      <p className="text-xs font-medium truncate">{p.client_name}</p>
                      <p className="text-[10px] text-gray-500">{fmt(p.capacity_kw)} kW · {inr(p.value)}</p>
                      <p className="text-[10px] mt-0.5"><span className="text-emerald-600">{inr(p.collected)}</span> <span className="text-gray-400">/ {inr(p.pending)} due</span></p>
                      {p.next_action && <p className="text-[10px] text-gray-600 mt-1 truncate">→ {p.next_action}</p>}
                      <select onClick={(e) => e.stopPropagation()} onChange={(e) => move(p, e.target.value)} value={p.stage} className="text-[9px] border rounded px-1 py-0.5 bg-white mt-1 w-full">
                        {stages.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                      </select>
                    </div>))}
                  {!(byStage[s.key] || []).length && <p className="text-[10px] text-gray-300 text-center py-4">—</p>}
                </div>
              </div>))}
          </div>
        </div>
      ) : (
        <div className="card p-4">
          <p className="font-semibold text-sm mb-3">Order value by stage · cash position</p>
          <div className="space-y-1.5 mb-4">
            {(analytics?.byStage || []).map((s) => {
              const max = Math.max(...(analytics.byStage.map((x) => x.value)), 1);
              return (
                <div key={s.key} className="flex items-center gap-3 text-xs">
                  <div className="w-36 text-right text-gray-600">{s.label}</div>
                  <div className="flex-1 bg-gray-100 rounded h-6"><div className="h-6 bg-blue-700/80 rounded flex items-center px-2 text-white text-[11px]" style={{ width: `${Math.max(4, s.value / max * 100)}%` }}>{s.count}</div></div>
                  <div className="w-28 text-right text-gray-600">{cr(s.value)}</div>
                </div>);
            })}
          </div>
          {T && (
            <div className="flex gap-4 text-xs border-t pt-3">
              <div>Collected <b className="text-emerald-600">{cr(T.collected)}</b></div>
              <div>Pending <b className="text-amber-600">{cr(T.pending)}</b></div>
              <div className="flex-1 bg-gray-100 rounded h-4 self-center max-w-md"><div className="h-4 bg-emerald-500 rounded" style={{ width: `${T.value ? T.collected / T.value * 100 : 0}%` }} /></div>
            </div>)}
        </div>
      )}

      {modal && <ProjectModal project={modal} stages={stages} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} reopen={open} />}
    </div>
  );
}

function ProjectModal({ project, stages, onClose, onSaved, reopen }) {
  const [p, setP] = useState({ ...project });
  const ms = p.milestones || [];
  const cl = p.checklist || [];

  const saveField = async (patch) => { try { await api.put(`/solar/projects/${p.id}`, patch); setP((x) => ({ ...x, ...patch })); } catch { toast.error('Save failed'); } };
  const toggleMs = async (i) => {
    const next = ms.map((m, idx) => idx === i ? { ...m, status: m.status === 'collected' ? 'pending' : 'collected', collected_on: m.status === 'collected' ? null : new Date().toISOString().slice(0, 10) } : m);
    await saveField({ milestones: next });
  };
  const toggleCl = async (i) => { const next = cl.map((c, idx) => idx === i ? { ...c, done: !c.done } : c); await saveField({ checklist: next }); };
  const move = async (stage) => { try { await api.post(`/solar/projects/${p.id}/move`, { stage }); toast.success('Moved'); onSaved(); } catch { toast.error('Move failed'); } };
  const del = async () => { if (!confirm('Delete this project?')) return; try { await api.delete(`/solar/projects/${p.id}`); onSaved(); } catch { toast.error('Failed'); } };
  const collected = ms.filter((m) => m.status === 'collected').reduce((a, m) => a + (m.amount || 0), 0);

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center overflow-y-auto p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl my-8">
        <div className="px-5 py-3 border-b flex items-center justify-between">
          <h3 className="font-bold">{p.project_no} · {p.client_name} <span className="text-xs font-normal text-gray-500">· {fmt(p.capacity_kw)} kW · {inr(p.value)}</span></h3>
          <button onClick={onClose}><FiX /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="label">Stage:</span>
            {stages.map((s) => <button key={s.key} onClick={() => move(s.key)} className={`text-[11px] px-2 py-1 rounded border ${s.key === p.stage ? 'bg-blue-800 text-white border-blue-800' : 'bg-white border-gray-200'}`}>{s.label}</button>)}
          </div>

          <div>
            <p className="font-semibold text-xs mb-1">Payment milestones — collected {inr(collected)} / {inr(p.value)}</p>
            <table className="w-full text-xs">
              <tbody>{ms.map((m, i) => (
                <tr key={i} className="border-t">
                  <td className="p-1">{m.label} <span className="text-gray-400">({m.pct}%)</span></td>
                  <td className="p-1 text-right">{inr(m.amount)}</td>
                  <td className="p-1 text-right w-28">
                    <button onClick={() => toggleMs(i)} className={`px-2 py-0.5 rounded text-[11px] ${m.status === 'collected' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                      {m.status === 'collected' ? `✓ ${m.collected_on || ''}` : 'Mark collected'}</button>
                  </td>
                </tr>))}</tbody>
            </table>
          </div>

          <div>
            <p className="font-semibold text-xs mb-1">Execution checklist</p>
            <div className="grid md:grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
              {cl.map((c, i) => (
                <label key={i} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={!!c.done} onChange={() => toggleCl(i)} />
                  <span className={c.done ? 'line-through text-gray-400' : ''}>{c.item}</span>
                  <span className="text-[9px] text-gray-300 ml-auto">{c.stage}</span>
                </label>))}
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs border-t pt-3">
            <label className="block"><span className="label">AMC annual fee ₹</span><input className="input-compact w-full" type="number" defaultValue={p.amc_annual_fee} onBlur={(e) => saveField({ amc_annual_fee: e.target.value })} /></label>
            <label className="block"><span className="label">AMC free until</span><input className="input-compact w-full" type="date" defaultValue={(p.amc_free_until || '').slice(0, 10)} onBlur={(e) => saveField({ amc_free_until: e.target.value })} /></label>
            <label className="block"><span className="label">AMC next due</span><input className="input-compact w-full" type="date" defaultValue={(p.amc_next_due || '').slice(0, 10)} onBlur={(e) => saveField({ amc_next_due: e.target.value })} /></label>
            <label className="block"><span className="label">Target handover</span><input className="input-compact w-full" type="date" defaultValue={(p.target_handover || '').slice(0, 10)} onBlur={(e) => saveField({ target_handover: e.target.value })} /></label>
          </div>

          {p.events?.length > 0 && (
            <details className="text-xs"><summary className="cursor-pointer text-gray-500">Activity ({p.events.length})</summary>
              <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto">{p.events.map((e) => <li key={e.id} className="text-gray-600">• <b>{e.type}</b> {e.from_stage ? `${e.from_stage}→${e.to_stage}` : (e.to_stage || '')} {e.note ? `· ${e.note}` : ''} <span className="text-gray-400">— {(e.created_at || '').slice(0, 16)} {e.by_name || ''}</span></li>)}</ul></details>)}
        </div>
        <div className="px-5 py-3 border-t flex items-center justify-between">
          <button onClick={del} className="text-sm text-gray-400"><FiTrash2 size={14} /></button>
          <button onClick={onClose} className="btn btn-primary text-sm">Done</button>
        </div>
      </div>
    </div>);
}
