import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiSun, FiPlus, FiX, FiTrendingUp, FiAlertTriangle, FiFileText, FiTrash2, FiPhoneCall, FiMapPin } from 'react-icons/fi';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import ResponsibilityTab from '../components/ResponsibilityTab';
import { num as fmt, inr } from '../lib/solar/format';
import { PROJECT_TYPES } from '../lib/solar/engine';
import { STATES, DISTRICTS_BY_STATE } from '../data/indiaLocations';
import QualificationChat from './QualificationChat';

const cr = (v) => `₹${fmt((v || 0) / 1e7, 2)} Cr`;

// The concrete action that gates each funnel stage — you can't advance without it.
const STAGE_ACTIONS = {
  inquiry: { kind: 'qualify', label: 'Qualify the lead on the call', gate: (sd, d) => Object.keys(d.qualification || {}).length > 0 },
  qualification: { kind: 'form', group: 'survey', label: 'Schedule the site survey',
    fields: [{ k: 'scheduled_date', label: 'Survey date', type: 'date' }, { k: 'surveyor', label: 'Surveyor / engineer' }],
    gate: (sd) => !!sd.survey?.scheduled_date },
  survey: { kind: 'form', group: 'survey', doneFlag: 'completed', label: 'Complete the site-survey report',
    fields: [{ k: 'area_sqft', label: 'Shadow-free area (sq ft)', type: 'number' }, { k: 'roof_type', label: 'Roof / surface' }, { k: 'shadow', label: 'Shading observed' }, { k: 'notes', label: 'Survey notes' }],
    gate: (sd) => !!(sd.survey?.completed && sd.survey?.area_sqft) },
  design: { kind: 'form', group: 'design', doneFlag: 'confirmed', label: 'Finalize design & BOQ',
    fields: [{ k: 'note', label: 'Design note (layout / inverter / structure)' }],
    extra: (d) => (d.capacity_kw > 0 ? null : 'Set the system capacity (kW) on the lead first.'),
    gate: (sd, d) => !!(d.capacity_kw > 0 && sd.design?.confirmed) },
  quotation: { kind: 'quote', group: 'quotation', doneFlag: 'sent', label: 'Create & send the quotation',
    gate: (sd, d, quotes) => !!(quotes.length > 0 && sd.quotation?.sent) },
  negotiation: { kind: 'form', group: 'negotiation', label: 'Log the client response',
    fields: [{ k: 'note', label: 'Client response / negotiation' }, { k: 'preferred_option', label: 'Preferred quote option' }],
    gate: (sd) => !!sd.negotiation?.note },
  approval: { kind: 'form', group: 'approval', doneFlag: 'confirmed', label: 'Confirm the order',
    fields: [{ k: 'po_number', label: 'PO number / reference' }, { k: 'advance_amount', label: 'Advance received ₹', type: 'number' }],
    gate: (sd) => !!sd.approval?.confirmed },
  won: { kind: 'done', label: 'Order won — execution project created' },
};

export default function SolarFunnel() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [stages, setStages] = useState([]);
  const [deals, setDeals] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [leads, setLeads] = useState([]);
  const [tab, setTab] = useState('pipeline');
  const [modal, setModal] = useState(null); // null | {} (new) | deal (edit)

  const load = () => {
    api.get('/solar/deals').then((r) => setDeals(r.data || [])).catch(() => toast.error('Could not load deals'));
    api.get('/solar/funnel/analytics').then((r) => setAnalytics(r.data)).catch(() => {});
  };
  useEffect(() => {
    api.get('/solar/funnel/config').then((r) => setStages(r.data.stages || [])).catch(() => {});
    api.get('/leads').then((r) => setLeads(r.data || [])).catch(() => {});
    load();
  }, []); // eslint-disable-line

  const byStage = useMemo(() => {
    const m = {}; stages.forEach((s) => (m[s.key] = []));
    deals.forEach((d) => { (m[d.stage] = m[d.stage] || []).push(d); });
    return m;
  }, [deals, stages]);
  const conv = useMemo(() => {
    const m = {}; (analytics?.byStage || []).forEach((s) => (m[s.key] = s)); return m;
  }, [analytics]);

  const move = async (deal, stage) => {
    if (stage === deal.stage) return;
    try { await api.post(`/solar/deals/${deal.id}/move`, { stage }); load(); } catch { toast.error('Move failed'); }
  };

  const T = analytics?.totals;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FiSun className="text-amber-500" /> Solar Sales Funnel</h1>
          <p className="text-xs text-gray-500">Every solar opportunity, stage by stage — with conversion, next actions and stuck-deal alerts driving each step.</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setTab('pipeline')} className={`px-4 py-2 rounded-full text-sm font-semibold border ${tab === 'pipeline' ? 'bg-blue-800 text-white border-blue-800' : 'bg-white text-gray-600 border-gray-200'}`}>Pipeline</button>
          <button onClick={() => setTab('analytics')} className={`px-4 py-2 rounded-full text-sm font-semibold border ${tab === 'analytics' ? 'bg-blue-800 text-white border-blue-800' : 'bg-white text-gray-600 border-gray-200'}`}><FiTrendingUp className="inline mr-1" />Conversion</button>
          <button onClick={() => setTab('responsible')} className={`px-4 py-2 rounded-full text-sm font-semibold border ${tab === 'responsible' ? 'bg-blue-800 text-white border-blue-800' : 'bg-white text-gray-600 border-gray-200'}`}>⚙ Responsible</button>
          <button onClick={() => setModal({ owner_name: user?.name || '', stage: 'inquiry', project_type: 'ongrid' })} className="btn btn-primary text-sm flex items-center gap-1"><FiPlus size={14} /> New Deal</button>
        </div>
      </div>

      {/* KPI strip */}
      {T && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="card p-3"><p className="text-[10px] text-gray-500 uppercase">Open deals</p><p className="text-xl font-bold">{T.open}</p></div>
          <div className="card p-3"><p className="text-[10px] text-gray-500 uppercase">Open pipeline</p><p className="text-xl font-bold text-indigo-700">{cr(T.open_value)}</p></div>
          <div className="card p-3"><p className="text-[10px] text-gray-500 uppercase">Won</p><p className="text-xl font-bold text-emerald-600">{T.won} · {cr(T.won_value)}</p></div>
          <div className="card p-3"><p className="text-[10px] text-gray-500 uppercase">Overall conversion</p><p className="text-xl font-bold">{T.overall_conversion}%</p></div>
          <div className="card p-3"><p className="text-[10px] text-gray-500 uppercase">Lost</p><p className="text-xl font-bold text-rose-500">{T.lost}</p></div>
        </div>
      )}

      {/* Stuck alerts */}
      {analytics?.stuck?.length > 0 && (
        <div className="card p-3 border-l-4 border-rose-400 bg-rose-50/50">
          <p className="text-xs font-bold text-rose-700 flex items-center gap-1 mb-1"><FiAlertTriangle size={13} /> {analytics.stuck.length} deal(s) stuck past their stage SLA — act now to keep them converting</p>
          <div className="flex flex-wrap gap-2">
            {analytics.stuck.map((s) => (
              <button key={s.id} onClick={() => api.get(`/solar/deals/${s.id}`).then((r) => setModal(r.data))} className="text-[11px] bg-white border border-rose-200 rounded-full px-2 py-1 hover:bg-rose-100">
                {s.deal_no} · {s.client_name} — {s.stage_label} · <b>{s.days_in_stage}d</b> (SLA {s.sla}d)</button>))}
          </div>
        </div>
      )}

      {tab === 'responsible' ? (
        <ResponsibilityTab module="solar_funnel" title="Solar Sales Funnel" />
      ) : tab === 'pipeline' ? (
        <div className="overflow-x-auto pb-2">
          <div className="flex gap-3 min-w-max">
            {stages.map((s) => {
              const list = byStage[s.key] || [];
              const stat = conv[s.key] || {};
              return (
                <div key={s.key} className="w-64 flex-shrink-0">
                  <div className="rounded-t-lg bg-blue-900 text-white px-3 py-2">
                    <div className="flex items-center justify-between"><span className="text-xs font-semibold">{s.label}</span><span className="text-[10px] bg-white/20 rounded-full px-2">{list.length}</span></div>
                    <div className="flex items-center justify-between text-[10px] text-blue-200 mt-0.5">
                      <span>{cr(stat.value)}</span><span>conv {stat.conversion ?? '—'}%</span></div>
                  </div>
                  <div className="bg-gray-50 rounded-b-lg p-2 space-y-2 min-h-[120px]">
                    {list.map((d) => (
                      <div key={d.id} className={`bg-white rounded-lg border p-2 shadow-sm cursor-pointer ${d.stuck ? 'border-rose-300 ring-1 ring-rose-200' : ''}`}
                        onClick={() => api.get(`/solar/deals/${d.id}`).then((r) => setModal(r.data))}>
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-semibold text-blue-900">{d.deal_no}</span>
                          {d.stuck && <FiAlertTriangle className="text-rose-500" size={12} />}
                        </div>
                        <p className="text-xs font-medium truncate">{d.client_name || '—'}</p>
                        <p className="text-[10px] text-gray-500">{fmt(d.capacity_kw)} kW · {inr(d.value)}</p>
                        {d.next_action && <p className="text-[10px] text-gray-600 mt-1 truncate">→ {d.next_action}</p>}
                        <div className="flex items-center justify-between mt-1">
                          <span className="text-[9px] text-gray-400">{d.owner_name || ''}</span>
                          <span className="text-[9px] text-blue-600 font-semibold">open to act ›</span>
                        </div>
                      </div>))}
                    {!list.length && <p className="text-[10px] text-gray-300 text-center py-4">—</p>}
                  </div>
                </div>);
            })}
          </div>
        </div>
      ) : (
        <div className="card p-4">
          <p className="font-semibold text-sm mb-3">Conversion funnel</p>
          <div className="space-y-1.5">
            {(analytics?.byStage || []).map((s, i) => {
              const max = analytics.byStage[0]?.reached || 1;
              return (
                <div key={s.key} className="flex items-center gap-3 text-xs">
                  <div className="w-32 text-right text-gray-600">{s.label}</div>
                  <div className="flex-1 bg-gray-100 rounded h-6 relative overflow-hidden">
                    <div className="h-6 bg-blue-700/80 rounded flex items-center px-2 text-white text-[11px]" style={{ width: `${Math.max(6, s.reached / max * 100)}%` }}>{s.reached}</div>
                  </div>
                  <div className="w-16 text-center">{i === 0 ? '—' : <span className={s.conversion < 50 ? 'text-rose-600 font-semibold' : 'text-emerald-600'}>{s.conversion}%</span>}</div>
                  <div className="w-20 text-gray-400">drop {s.dropoff}</div>
                  <div className="w-20 text-gray-400">{s.avg_days}d avg</div>
                  <div className="w-24 text-right text-gray-600">{cr(s.value)}</div>
                </div>);
            })}
          </div>
          <p className="text-[10px] text-gray-400 mt-3">Conversion = % of deals that reached the previous stage which advanced to this one. Drop = deals lost between stages. Avg-days = time deals currently sit in each stage.</p>
        </div>
      )}

      {modal && <DealModal deal={modal} stages={stages} leads={leads} deals={deals} user={user} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} nav={nav} />}
    </div>
  );
}

function DealModal({ deal, stages, leads, deals, user, onClose, onSaved, nav }) {
  const [d, setD] = useState({ ...deal });
  const [showQual, setShowQual] = useState(false);
  const [aForm, setAForm] = useState({});
  const isNew = !deal.id;
  const set = (k, v) => setD((p) => ({ ...p, [k]: v }));
  const F = (k, label, props = {}) => (
    <label className="block"><span className="label">{label}</span>
      <input className="input-compact w-full" value={d[k] ?? ''} onChange={(e) => set(k, e.target.value)} {...props} /></label>);

  // "From Lead" combobox source — UNIQUE client names from existing CRM leads
  // and past solar deals, so mam can pick an old client OR type a brand-new one
  // (mam: "from lead show old client name unique from suggestion and can enter
  // new also"). leadByName lets a picked name auto-fill that lead's details.
  const leadByName = useMemo(() => {
    const m = new Map();
    (leads || []).forEach((l) => { const nm = (l.company_name || l.client_name || '').trim(); if (nm) m.set(nm.toLowerCase(), l); });
    return m;
  }, [leads]);
  const clientSuggestions = useMemo(() => {
    const names = new Map();
    (leads || []).forEach((l) => { const nm = (l.company_name || l.client_name || '').trim(); if (nm) names.set(nm.toLowerCase(), nm); });
    (deals || []).forEach((x) => { const nm = (x.client_name || x.company || '').trim(); if (nm && !names.has(nm.toLowerCase())) names.set(nm.toLowerCase(), nm); });
    return [...names.values()].sort((a, b) => a.localeCompare(b));
  }, [leads, deals]);

  const refresh = async () => { try { const r = await api.get(`/solar/deals/${d.id}`); setD(r.data); } catch { /* */ } };
  const save = async () => {
    if (!d.client_name) return toast.error('Client name required');
    try {
      if (isNew) await api.post('/solar/deals', d);
      else await api.put(`/solar/deals/${d.id}`, d);
      toast.success('Saved'); onSaved();
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };
  const move = async (stage) => { try { await api.post(`/solar/deals/${d.id}/move`, { stage }); toast.success('Moved'); onSaved(); } catch { toast.error('Move failed'); } };
  const lose = async () => { const reason = prompt('Reason for losing this deal?'); if (reason === null) return; try { await api.post(`/solar/deals/${d.id}/lose`, { reason }); toast.success('Marked lost'); onSaved(); } catch { toast.error('Failed'); } };
  const del = async () => { if (!confirm('Delete this deal?')) return; try { await api.delete(`/solar/deals/${d.id}`); onSaved(); } catch { toast.error('Failed'); } };
  const toQuote = (variant) => nav(`/solar-quotation?deal=${d.id}&client=${encodeURIComponent(d.client_name || '')}&kw=${d.capacity_kw || ''}&conn=${d.project_type || 'ongrid'}&state=${encodeURIComponent(d.state || '')}&variant=${encodeURIComponent(variant || '')}`);

  // Save qualification → store answers, set recommended system, advance to Qualified.
  const onQualDone = async (ans, rec) => {
    setShowQual(false);
    try {
      await api.put(`/solar/deals/${d.id}`, { qualification: ans, capacity_kw: rec.kw, project_type: rec.conn, phone: ans.phone || d.phone });
      await api.post(`/solar/deals/${d.id}/move`, { stage: 'qualification', note: `Qualified on call → ${rec.kw} kW ${rec.conn}` });
      toast.success(`Qualified — ${rec.kw} kW ${rec.conn}`);
      await refresh(); onSaved && onSaved.silent !== true;
    } catch (e) { toast.error('Could not save qualification'); }
  };

  const districts = DISTRICTS_BY_STATE[d.state] || [];
  const mapQ = (d.lat && d.lng) ? `${d.lat},${d.lng}` : [d.location, d.district, d.state, d.pincode].filter(Boolean).join(', ') || d.client_name;
  const qual = d.qualification && Object.keys(d.qualification).length ? d.qualification : null;
  const quotes = d.quotes || [];

  // ── Gated stage flow: each stage has a required action to advance ──
  const curIdx = stages.findIndex((s) => s.key === d.stage);
  const action = STAGE_ACTIONS[d.stage] || {};
  const sd = d.stage_data || {};
  const nextStage = stages[curIdx + 1];
  const prevStage = stages[curIdx - 1];
  const gateMet = action.gate ? action.gate(sd, d, quotes) : true;
  useEffect(() => { setAForm({ ...((d.stage_data || {})[action.group] || {}) }); }, [d.stage, d.id]); // eslint-disable-line
  const saveStageAction = async () => {
    const patch = { ...aForm };
    if (action.doneFlag) patch[action.doneFlag] = true;
    try { await api.put(`/solar/deals/${d.id}`, { stage_data: { [action.group]: patch } }); toast.success('Action saved'); await refresh(); }
    catch { toast.error('Save failed'); }
  };
  const advance = async () => {
    if (!nextStage) return;
    try { await api.post(`/solar/deals/${d.id}/move`, { stage: nextStage.key }); toast.success(`Moved to ${nextStage.label}`); await refresh(); }
    catch (e) { toast.error(e.response?.data?.requirement || e.response?.data?.error || 'Cannot advance'); }
  };
  const moveBack = async () => { if (!prevStage) return; try { await api.post(`/solar/deals/${d.id}/move`, { stage: prevStage.key, force: true }); await refresh(); } catch { toast.error('Failed'); } };
  const markSent = async () => { try { await api.put(`/solar/deals/${d.id}`, { stage_data: { quotation: { sent: true, sent_on: new Date().toISOString().slice(0, 10) } } }); toast.success('Quotation marked sent'); await refresh(); } catch { toast.error('Failed'); } };

  return (
    <>
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center overflow-y-auto p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl my-8">
        <div className="px-5 py-3 border-b flex items-center justify-between">
          <h3 className="font-bold">{isNew ? 'New Solar Lead' : `${deal.deal_no} · ${deal.client_name}`}</h3>
          <button onClick={onClose}><FiX /></button>
        </div>
        <div className="p-5 space-y-3">
          {isNew && (
            <label className="block"><span className="label">From Lead (optional)</span>
              <input className="input-compact w-full" list="solarFromLeadDL" value={d.client_name || ''}
                placeholder="Pick an old client or type a new name…"
                onChange={(e) => {
                  const name = e.target.value;
                  const l = leadByName.get(name.trim().toLowerCase());
                  setD((p) => l
                    ? { ...p, client_name: name, lead_id: l.id, company: l.company_name || p.company, phone: l.phone || p.phone, location: l.district || l.location || p.location, state: l.state || p.state, district: l.district || p.district }
                    : { ...p, client_name: name, lead_id: null });
                }} />
              <datalist id="solarFromLeadDL">{clientSuggestions.map((nm) => <option key={nm} value={nm} />)}</datalist>
            </label>)}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {F('client_name', 'Client name')}{F('company', 'Company')}{F('phone', 'Phone')}
            <label className="block"><span className="label">State</span>
              <select className="input-compact w-full" value={d.state || ''} onChange={(e) => set('state', e.target.value)}>
                <option value="">— state —</option>{STATES.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
            <label className="block"><span className="label">District</span>
              <select className="input-compact w-full" value={d.district || ''} onChange={(e) => set('district', e.target.value)}>
                <option value="">— district —</option>{districts.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
            {F('pincode', 'Pincode')}
            {F('location', 'Site / area')}{F('capacity_kw', 'Capacity (kW)', { type: 'number' })}
            <label className="block"><span className="label">Project type</span>
              <select className="input-compact w-full" value={d.project_type || 'ongrid'} onChange={(e) => set('project_type', e.target.value)}>
                {PROJECT_TYPES.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}</select></label>
            {F('value', 'Deal value ₹', { type: 'number' })}{F('owner_name', 'Owner')}{F('source', 'Source')}
          </div>

          {/* Google Earth / site location */}
          <div className="border rounded-lg p-2 bg-gray-50">
            <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
              <span className="text-xs font-semibold flex items-center gap-1"><FiMapPin size={13} /> Site on Google Earth</span>
              <div className="flex gap-2 items-center">
                <input className="input-compact w-24" placeholder="lat" value={d.lat ?? ''} onChange={(e) => set('lat', e.target.value)} />
                <input className="input-compact w-24" placeholder="lng" value={d.lng ?? ''} onChange={(e) => set('lng', e.target.value)} />
                <a href={`https://earth.google.com/web/search/${encodeURIComponent(mapQ)}`} target="_blank" rel="noreferrer" className="btn btn-secondary text-xs">🌍 Google Earth</a>
                <a href={`https://www.google.com/maps?q=${encodeURIComponent(mapQ)}`} target="_blank" rel="noreferrer" className="btn btn-secondary text-xs">Maps</a>
              </div>
            </div>
            {mapQ && <iframe title="site-map" className="w-full h-48 rounded border" src={`https://maps.google.com/maps?q=${encodeURIComponent(mapQ)}&z=18&t=k&output=embed`} />}
          </div>

          {!isNew && (
            <div className="border-2 border-blue-200 rounded-lg p-3 bg-blue-50/40">
              {/* stage progress */}
              <div className="flex items-center gap-1 mb-2 overflow-x-auto">
                {stages.map((s, i) => (
                  <span key={s.key} className={`text-[9px] px-2 py-1 rounded-full whitespace-nowrap ${i < curIdx ? 'bg-emerald-100 text-emerald-700' : i === curIdx ? 'bg-blue-700 text-white font-semibold' : 'bg-gray-100 text-gray-400'}`}>{i < curIdx ? '✓ ' : ''}{s.label}</span>))}
              </div>
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-blue-900">Step {curIdx + 1}: {action.label}</p>
                {prevStage && <button onClick={moveBack} className="text-xs text-gray-500">← back to {prevStage.label}</button>}
              </div>

              <div className="mt-2">
                {action.kind === 'qualify' && (
                  <button onClick={() => setShowQual(true)} className="btn btn-primary text-sm flex items-center gap-1"><FiPhoneCall size={14} /> {qual ? 'Re-qualify on call' : 'Qualify on call'}</button>)}

                {action.kind === 'form' && (
                  <div className="space-y-2">
                    {action.extra && action.extra(d) && <p className="text-[11px] text-amber-700">⚠ {action.extra(d)}</p>}
                    <div className="grid grid-cols-2 gap-2">
                      {action.fields.map((f) => (
                        <label key={f.k} className="block"><span className="label">{f.label}</span>
                          <input className="input-compact w-full" type={f.type || 'text'} value={aForm[f.k] ?? ''} onChange={(e) => setAForm((p) => ({ ...p, [f.k]: e.target.value }))} /></label>))}
                    </div>
                    <button onClick={saveStageAction} className="btn btn-secondary text-sm">{action.doneFlag ? 'Mark step complete' : 'Save'}</button>
                  </div>)}

                {action.kind === 'quote' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button onClick={() => toQuote(`Option ${String.fromCharCode(65 + quotes.length)}`)} className="btn btn-secondary text-sm flex items-center gap-1"><FiFileText size={14} /> Create quote option</button>
                    {quotes.length > 0 && !sd.quotation?.sent && <button onClick={markSent} className="btn btn-secondary text-sm">✓ Mark quotation sent</button>}
                    {sd.quotation?.sent && <span className="text-xs text-emerald-600">✓ Quotation sent to client</span>}
                  </div>)}

                {action.kind === 'done' && <p className="text-sm text-emerald-700">✓ {action.label}</p>}
              </div>

              {nextStage && (
                <div className="mt-3 flex items-center gap-2 border-t pt-2">
                  <button onClick={advance} disabled={!gateMet} className={`btn text-sm ${gateMet ? 'btn-primary' : 'btn-secondary opacity-50 cursor-not-allowed'}`}>Advance to {nextStage.label} →</button>
                  {gateMet ? <span className="text-[11px] text-emerald-600">✓ Action done — ready to advance</span> : <span className="text-[11px] text-rose-600">🔒 Complete the action above to unlock</span>}
                </div>)}
            </div>)}

          {qual && (
            <div className="border rounded-lg p-3 bg-emerald-50/60 text-xs">
              <p className="font-bold text-emerald-800 mb-1">✓ Qualified — {fmt(d.capacity_kw)} kW {d.project_type}</p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-0.5 text-gray-700">
                {qual.monthly_units && <div>Units/mo: <b>{qual.monthly_units}</b></div>}
                {qual.monthly_bill && <div>Bill: <b>₹{qual.monthly_bill}</b></div>}
                {qual.connection && <div>Conn: <b>{qual.connection}</b></div>}
                {qual.roof_type && <div>Roof: <b>{qual.roof_type}</b></div>}
                {qual.net_metering && <div>Metering: <b>{qual.net_metering}</b></div>}
                {qual.timeline && <div>Timeline: <b>{qual.timeline}</b></div>}
              </div>
            </div>)}

          {/* Quotation options (multiple specs/makes per client) */}
          {!isNew && (
            <div className="border rounded-lg p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold">Quotation options ({quotes.length})</span>
                <button onClick={() => toQuote(`Option ${String.fromCharCode(65 + quotes.length)}`)} className="btn btn-secondary text-xs flex items-center gap-1"><FiPlus size={12} /> New option</button>
              </div>
              {quotes.length === 0 ? <p className="text-[11px] text-gray-400">No quotes yet — give this client a few options (different specs / makes).</p> : (
                <table className="w-full text-xs"><tbody>
                  {quotes.map((q) => (
                    <tr key={q.id} className="border-t">
                      <td className="p-1 font-medium">{q.variant_label || q.quote_no}</td>
                      <td className="p-1">{fmt(q.capacity_kw)} kW</td>
                      <td className="p-1 text-right">{inr(q.sell)} <span className="text-gray-400">(₹{fmt(q.sell_per_w, 2)}/W)</span></td>
                      <td className="p-1 text-right text-emerald-600">{fmt(q.margin_pct, 1)}%</td>
                    </tr>))}
                </tbody></table>)}
            </div>)}

          {!isNew && deal.events?.length > 0 && (
            <details className="text-xs"><summary className="cursor-pointer text-gray-500">Activity ({deal.events.length})</summary>
              <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                {deal.events.map((e) => <li key={e.id} className="text-gray-600">• <b>{e.type}</b> {e.from_stage ? `${e.from_stage}→${e.to_stage}` : (e.to_stage || '')} {e.note ? `· ${e.note}` : ''} <span className="text-gray-400">— {(e.created_at || '').slice(0, 16)} {e.by_name || ''}</span></li>)}
              </ul></details>)}
        </div>
        <div className="px-5 py-3 border-t flex items-center justify-between">
          <div className="flex gap-2">
            {!isNew && <button onClick={lose} className="text-sm text-rose-600">Mark Lost</button>}
            {!isNew && <button onClick={del} className="text-sm text-gray-400"><FiTrash2 size={14} /></button>}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn btn-secondary text-sm">Close</button>
            <button onClick={save} className="btn btn-primary text-sm">Save</button>
          </div>
        </div>
      </div>
    </div>
    {showQual && <QualificationChat deal={d} onClose={() => setShowQual(false)} onDone={onQualDone} />}
    </>);
}
