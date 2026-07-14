import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import api from '../api';
import ResponsibilityTab from '../components/ResponsibilityTab';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import TimePicker from '../components/TimePicker';
import { STATES, DISTRICTS_BY_STATE } from '../data/indiaLocations';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiSearch, FiEye, FiEdit2, FiTrash2, FiChevronRight, FiChevronDown, FiCheck, FiX, FiUpload, FiCalendar, FiFileText, FiTarget, FiTrendingUp, FiDownload, FiMapPin, FiGrid, FiCopy } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { fmtDateIST } from '../utils/dateIST';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';

// Mam's 11-stage Sales Funnel spec (SEPL_Sales_Funnel_ERP_Build_Spec).
// Order in this array is the canonical funnel order; tabs render in this
// sequence and the dashboard funnel chart walks the same path.
const STAGES = [
  'lead_capture',
  'qualification',
  'site_survey',
  'concept_design',
  'boq_costing',
  'pricing_review',
  'quote_submitted',
  'technical_clarification',
  'commercial_negotiation',
  'contract_signed',
  'project_kickoff',
  'lost',
];
// Long label = "Stage N — <Spec name>" so the tab bar reads exactly like
// the section headings in mam's spec doc.
const STAGE_LABELS = {
  lead_capture:            'Stage 1 — Lead/Tender Capture',
  qualification:           'Stage 2 — Qualified or Not',
  site_survey:             'Stage 3 — Site Survey + Feasibility',
  concept_design:          'Stage 4 — Concept Design / Drawings',
  boq_costing:             'Stage 5 — BOQ + Vendor Costing',
  pricing_review:          'Stage 6 — Internal Pricing Review',
  quote_submitted:         'Stage 7 — Quote / Bid Submission',
  technical_clarification: 'Stage 8 — Technical Clarification',
  commercial_negotiation:  'Stage 9 — Commercial Negotiation',
  contract_signed:         'Stage 10 — Contract + LOI / PO',
  project_kickoff:         'Stage 11 — Project Kickoff',
  lost:                    'Lost',
};
// Compact label used inside the funnel chart / row badges / pipeline pills
// where the long "Stage N — …" name doesn't fit.
const STAGE_SHORT = {
  lead_capture:            'Lead Capture',
  qualification:           'Qualified?',
  site_survey:             'Site Survey',
  concept_design:          'Design',
  boq_costing:             'BOQ',
  pricing_review:          'Pricing (GATE)',
  quote_submitted:         'Quote Sent',
  technical_clarification: 'Tech Clarify',
  commercial_negotiation:  'Negotiate',
  contract_signed:         'Contract (GATE)',
  project_kickoff:         'Kickoff',
  lost:                    'Lost',
};
const STAGE_COLORS = {
  lead_capture:            '#3b82f6',  // blue
  qualification:           '#6366f1',  // indigo
  site_survey:             '#8b5cf6',  // purple
  concept_design:          '#a855f7',  // violet
  boq_costing:             '#f59e0b',  // amber
  pricing_review:          '#f97316',  // orange (GATE)
  quote_submitted:         '#06b6d4',  // cyan
  technical_clarification: '#0ea5e9',  // sky
  commercial_negotiation:  '#14b8a6',  // teal
  contract_signed:         '#10b981',  // emerald (GATE)
  project_kickoff:         '#84cc16',  // lime
  lost:                    '#ef4444',  // red
};
const TAB_STYLES = {
  lead_capture:            'bg-blue-500',
  qualification:           'bg-indigo-500',
  site_survey:             'bg-purple-500',
  concept_design:          'bg-violet-500',
  boq_costing:             'bg-amber-500',
  pricing_review:          'bg-orange-500',
  quote_submitted:         'bg-cyan-500',
  technical_clarification: 'bg-sky-500',
  commercial_negotiation:  'bg-teal-500',
  contract_signed:         'bg-emerald-500',
  project_kickoff:         'bg-lime-500',
  lost:                    'bg-red-500',
};
// Stage 6 + Stage 10 are GATE stages — they need an explicit approval
// and are visually distinguished with a 🚦 marker on the tab.
const GATE_STAGES = new Set(['pricing_review', 'contract_signed']);
// Sales-funnel category list — exactly mam's 7-option spec (Section 3 of 7
// of her form): Low Voltage, Fire Fighting, Electrical, SOLAR, MEP, HVAC,
// Plumbing. Order and casing kept verbatim per mam's screenshot.
const CATEGORIES = ['Low Voltage','Fire Fighting','Fire NOC','Electrical','SOLAR','MEP','HVAC','Plumbing'];
const PIE_COLORS = ['#3b82f6','#6366f1','#8b5cf6','#f59e0b','#f97316','#06b6d4','#10b981','#ef4444','#ec4899'];

// Mam (2026-06-01) · Stage 1 Lead Capture changes:
//   3) Tentative timeline now a dropdown of fixed buckets.
//   4) Source list gains "Influencer"; partner dropdown reveals when picked.
//   5) Building Category dropdown — 15 options from mam's screenshot.
const TIMELINE_OPTIONS  = ['15 days', '30 days', '60 days', '90 days', '180 days', '365 days'];
const SOURCE_OPTIONS    = ['Website','Referral','Cold','IPC','GeM','CPPP','State Portal','Repeat','Influencer'];
const BUILDING_CATEGORIES = [
  'Residential Buildings', 'Commercial Buildings', 'Educational Buildings',
  'Healthcare Buildings',  'Industrial Buildings',  'Government Buildings',
  'Religious Buildings',   'Transportation Buildings', 'Recreational Buildings',
  'Financial Buildings',   'Hospitality Buildings',   'Cultural Buildings',
  'Agricultural Buildings','Utility Buildings',       'Emergency Services Buildings',
];

// Validators for the phone + email "verified or correct" check
// (mam 2026-06-01).  Indian mobile = 10 digits starting 6/7/8/9.
const isValidIndianPhone = (s) => /^[6-9]\d{9}$/.test(String(s || '').replace(/\s+/g, ''));
const isValidEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());

export default function Leads() {
  const { canCreate, canEdit, canDelete, user } = useAuth();
  const [tab, setTab] = useUrlTab('dashboard');
  const [stageTab, setStageTab] = useState('all');
  const [leads, setLeads] = useState([]);
  const [dashboard, setDashboard] = useState(null);
  const [search, setSearch] = useState('');
  // Group the funnel list by PROJECT — same collapsible layout as Business
  // Book (mam 2026-06-25: "merge project wise like business book").
  const [groupLeads, setGroupLeads] = useState(true);
  const [leadsExpanded, setLeadsExpanded] = useState({});
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [viewData, setViewData] = useState(null);
  const [stageForm, setStageForm] = useState({});
  // Which stage's "Next Action" form is currently visible. Defaults to the
  // lead's current_stage. Clicking any pipeline pill sets this, so admin can
  // jump backwards (to correct) or forwards (to skip optional steps).
  const [viewStage, setViewStage] = useState(null);
  const [followups, setFollowups] = useState([]);
  const [fuForm, setFuForm] = useState({ followup_date: '', followup_time: '', type: 'call', notes: '' });
  // BOQ history (mam 2026-06-12: clients re-send BOQs over time).
  const [boqList, setBoqList] = useState([]);
  const [boqForm, setBoqForm] = useState({ boq_file_link: '', boq_amount: '', notes: '' });
  const [boqAdding, setBoqAdding] = useState(false);
  // Employees list for the "Assign Meeting" dropdown — only active staff
  // are shown so dropped/inactive employees don't clutter the list.
  // Each option carries user_id so the lead row stores both the display
  // name and the FK to users(id) for "My Planned Meetings" filtering.
  const [employees, setEmployees] = useState([]);
  // Mam (2026-06-01) — influencers list for the Source → Partner
  // cascade.  Lazy-fetched the first time the lead modal opens
  // (engineers / sales reps shouldn't pay the cost while just
  // browsing the funnel).  No `influencers:view` perm required —
  // backend exposes a public /lookup path.
  const [influencers, setInfluencers] = useState([]);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (stageTab !== 'all' && stageTab !== 'dashboard') params.set('stage', stageTab);
    api.get(`/sales-funnel?${params}`).then(r => setLeads(r.data)).catch(() => {});
    api.get('/sales-funnel/dashboard').then(r => setDashboard(r.data)).catch(() => {});
  }, [search, stageTab]);

  useEffect(() => { load(); }, [load]);

  // Load active employees once for the Assign Meeting dropdown.
  // Filter to active so dropped employees don't show in the picker.
  useEffect(() => {
    api.get('/hr/employees')
      .then(r => setEmployees((r.data || []).filter(e => !e.status || e.status === 'active')))
      .catch(() => setEmployees([]));
  }, []);

  // Lazy-fetch influencers the first time the lead modal opens.
  // Cached for the rest of the session.  Mam (2026-06-01).
  useEffect(() => {
    if ((modal === 'add' || modal === 'edit') && influencers.length === 0) {
      api.get('/influencers/lookup').then(r => setInfluencers(r.data || [])).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal]);

  const F = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const fmt = n => `Rs ${(n||0).toLocaleString('en-IN')}`;

  // New lead from an existing one (mam 2026-06-25): copies the client's BASIC
  // details so a repeat lead doesn't get re-typed. Opens the New Lead form
  // pre-filled; saving creates a brand-new lead with a freshly generated lead
  // no. (id / lead_no / stage / dates / amounts are NOT copied — it's a new
  // lead. Project name is left blank so the new project is filled in.)
  const cloneLead = (l) => {
    setForm({
      lead_kind: l.lead_kind || 'private',
      client_name: l.client_name || '',
      company_name: l.company_name || '',
      phone: l.phone || '',
      email: l.email || '',
      category: l.category || '',
      building_category: l.building_category || '',
      project_name: '',
      project_location: l.project_location || '',
      pin_code: l.pin_code || '',
      state: l.state || '',
      district: l.district || '',
      address: l.address || '',
      source: l.source || '',
      influencer_id: l.influencer_id || null,
      influencer_name: l.influencer_name || '',
      assigned_sc: l.assigned_sc || user?.name || '',
      assigned_asm: l.assigned_asm || '',
      lead_type: l.lead_type || '',
      remarks: '',
    });
    setModal('add');
    toast.success(`Details copied from ${l.lead_no || 'lead'} — enter the project and save for a new lead no.`);
  };

  const saveLead = async (e) => {
    e.preventDefault();
    // Mam (2026-06-01): "mobile number and email verified or
    // correct" — block submission if either is present but invalid.
    // Both fields stay optional (blank = OK); only filled-in
    // garbage gets rejected.
    if (form.phone && !isValidIndianPhone(form.phone)) {
      toast.error('Enter a valid 10-digit Indian mobile (starts with 6/7/8/9)');
      return;
    }
    if (form.email && !isValidEmail(form.email)) {
      toast.error('Enter a valid email address');
      return;
    }
    if (form.source === 'Influencer' && !form.influencer_id) {
      toast.error('Pick a partner from the Influencer list, or change the source');
      return;
    }
    try {
      if (form.id) { await api.put(`/sales-funnel/${form.id}`, form); toast.success('Updated'); }
      else { const res = await api.post('/sales-funnel', form); toast.success(`Lead ${res.data.lead_no} created`); }
      setModal(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Error'); }
  };

  const advanceStage = async (id, stage, data) => {
    try { await api.post(`/sales-funnel/${id}/stage`, { stage, ...data }); toast.success(`${STAGE_LABELS[stage]||stage}`); setModal(null); setViewData(null); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Error'); }
  };

  const uploadFile = async (file) => { const fd = new FormData(); fd.append('file', file); const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } }); return r.data.url; };
  const loadBoqs = (id) => api.get(`/sales-funnel/${id}/boqs`).then(r=>setBoqList(r.data||[])).catch(()=>setBoqList([]));
  const viewLead = (l) => { setViewData(l); setStageForm({}); setViewStage(null); setModal('view'); setBoqForm({ boq_file_link:'', boq_amount:'', notes:'' }); api.get(`/sales-funnel/${l.id}/followups`).then(r=>setFollowups(r.data)).catch(()=>setFollowups([])); loadBoqs(l.id); };
  const addBoq = async () => {
    if (!boqForm.boq_file_link && !(+boqForm.boq_amount > 0)) return toast.error('Attach a BOQ file or enter an amount');
    setBoqAdding(true);
    try {
      await api.post(`/sales-funnel/${viewData.id}/boq`, boqForm);
      toast.success('BOQ added');
      setBoqForm({ boq_file_link:'', boq_amount:'', notes:'' });
      loadBoqs(viewData.id);
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to add BOQ'); }
    finally { setBoqAdding(false); }
  };

  const addFollowup = async () => {
    if (!fuForm.followup_date) return toast.error('Date required');
    try { await api.post(`/sales-funnel/${viewData.id}/followup`, fuForm); toast.success('Follow-up scheduled'); setFuForm({followup_date:'',followup_time:'',type:'call',notes:''}); api.get(`/sales-funnel/${viewData.id}/followups`).then(r=>setFollowups(r.data)); }
    catch(err) { toast.error(err.response?.data?.error||'Error'); }
  };

  const logFollowup = async (fid, outcome) => {
    const notes = prompt('Notes:');
    const next = prompt('Next follow-up date (YYYY-MM-DD) or leave empty:');
    try { await api.put(`/sales-funnel/followup/${fid}`, { outcome, notes, next_followup_date: next||null }); toast.success('Logged'); api.get(`/sales-funnel/${viewData.id}/followups`).then(r=>setFollowups(r.data)); load(); }
    catch(err) { toast.error('Error'); }
  };

  // Chart data
  const stageChartData = dashboard?.byStage?.map(s => ({ name: STAGE_SHORT[s.current_stage]||s.current_stage, count: s.count, fill: STAGE_COLORS[s.current_stage]||'#888' })) || [];

  // Merge case-variant duplicates ("SOLAR" + "Solar" should collapse into
  // one slice) using the canonical capitalisation from the CATEGORIES
  // list.  Mam, 2026-05-15: the pie was showing both "Solar: 118" and
  // "SOLAR: 1" side by side because the historical free-text capture
  // wasn't normalised.
  const canonicalCategory = (raw) => {
    if (!raw) return 'Uncategorized';
    const lower = String(raw).trim().toLowerCase();
    return CATEGORIES.find(c => c.toLowerCase() === lower) || String(raw).trim();
  };
  const mergedCats = new Map();
  (dashboard?.byCategory || []).forEach(c => {
    const key = canonicalCategory(c.category);
    mergedCats.set(key, (mergedCats.get(key) || 0) + c.count);
  });
  const catChartData = [...mergedCats.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, value], i) => ({ name, value, fill: PIE_COLORS[i % PIE_COLORS.length] }));

  const scChartData = dashboard?.bySC?.map((s,i) => ({ name: s.assigned_sc, count: s.count, fill: PIE_COLORS[i%PIE_COLORS.length] })) || [];

  // Funnel data
  const funnelData = STAGES.filter(s=>s!=='lost').map(s => ({ stage: STAGE_SHORT[s], count: dashboard?.byStage?.find(b=>b.current_stage===s)?.count||0 }));

  // Fortnightly expected-closing forecast (mam 2026-06-25): amount in Lakhs +
  // lead count per 14-day bucket, from the dashboard API (closing_date +
  // tentative_amount captured at Qualify). AR/AP-tracker style.
  const closingChartData = (dashboard?.closingByFortnight || []).map(b => ({
    name: b.label, amountL: Math.round(((b.amount||0)/100000)*100)/100, count: b.count||0, amount: b.amount||0,
  }));

  // SLA chip for a lead row (overdue / due-in / —).
  const slaChipFor = (l) => {
    if (l.sla_minutes_left === null || l.sla_minutes_left === undefined) return <span className="text-gray-300 text-[10px]">—</span>;
    const m = l.sla_minutes_left;
    if (m < 0) { const abs = -m; const label = abs < 60 ? `${abs}m` : abs < 1440 ? `${Math.round(abs/60)}h` : `${Math.round(abs/1440)}d`; return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-200">OVERDUE {label}</span>; }
    if (m < 60) return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200">{m}m left</span>;
    if (m < 1440) return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">{Math.round(m/60)}h left</span>;
    return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200">{Math.round(m/1440)}d left</span>;
  };
  const fmtRs = (n) => (+n > 0 ? `₹${(+n).toLocaleString('en-IN')}` : <span className="text-gray-300">-</span>);

  // One lead row — reused by the flat list and the grouped children so the
  // columns never drift. Tentative Amount column added (mam 2026-06-25).
  const renderLeadRow = (l, child = false) => (
    <tr key={l.id} className={`border-b hover:bg-red-50/40 cursor-pointer ${child ? 'bg-gray-50/60' : ''}`} onClick={()=>viewLead(l)}>
      <td className={`px-3 py-2.5 font-bold text-red-600 ${child ? 'pl-8' : ''}`}>{l.lead_no}</td>
      <td className="px-3 py-2.5"><div className="font-semibold">{l.client_name}</div></td>
      <td className="px-3 py-2.5 text-gray-600">{l.company_name||'-'}</td>
      <td className="px-3 py-2.5"><span className="text-[9px] bg-gray-100 px-2 py-0.5 rounded-full font-medium">{l.category||'-'}</span></td>
      <td className="px-3 py-2.5 text-gray-500">{l.district||l.address||'-'}</td>
      <td className="px-3 py-2.5 text-right font-semibold text-emerald-700">{fmtRs(l.tentative_amount)}</td>
      <td className="px-3 py-2.5">{l.assigned_sc||'-'}</td>
      <td className="px-3 py-2.5"><span className="text-[9px] px-2 py-1 rounded-full font-bold text-white" style={{backgroundColor:STAGE_COLORS[l.current_stage]||'#888'}}>{STAGE_SHORT[l.current_stage]||l.current_stage}</span></td>
      <td className="px-3 py-2.5">{slaChipFor(l)}</td>
      <td className="px-3 py-2.5 text-[10px] text-gray-400">{fmtDateIST(l.created_at)}</td>
      <td className="px-3 py-2.5" onClick={e=>e.stopPropagation()}>
        <div className="flex gap-1">
          {canCreate('leads')&&<button onClick={()=>cloneLead(l)} className="p-1 text-emerald-600 hover:bg-emerald-50 rounded" title="New lead from this client — copies the details, gets a fresh lead no."><FiCopy size={14}/></button>}
          <button onClick={()=>viewLead(l)} className="p-1 text-red-600 hover:bg-red-50 rounded" title="View"><FiEye size={14}/></button>
          {canEdit('leads')&&<button onClick={()=>{setForm(l);setModal('edit');}} className="p-1 text-amber-600 hover:bg-amber-50 rounded" title="Edit"><FiEdit2 size={14}/></button>}
          {canDelete('leads')&&<button onClick={async()=>{if(!confirm('Delete?'))return;await api.delete(`/sales-funnel/${l.id}`);toast.success('Deleted');load();}} className="p-1 text-red-600 hover:bg-red-50 rounded" title="Delete"><FiTrash2 size={14}/></button>}
        </div>
      </td>
    </tr>
  );

  // Group the funnel list by PROJECT NAME (like Business Book). Leads with no
  // project_name stay on their own row (keyed by id) — avoids merging unrelated
  // blank/"na" leads. Each group sums the tentative amounts.
  const cleanTxt = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const leadGroups = useMemo(() => {
    const map = new Map();
    for (const l of leads) {
      const proj = cleanTxt(l.project_name);
      const key = proj ? proj.toLowerCase() : `__none__:${l.id}`;
      if (!map.has(key)) map.set(key, { key, label: proj || (cleanTxt(l.company_name) || cleanTxt(l.client_name) || '(no project)'), leads: [], amount: 0, clients: new Set() });
      const g = map.get(key);
      g.leads.push(l);
      g.amount += (+l.tentative_amount || 0);
      if (l.client_name) g.clients.add(cleanTxt(l.client_name));
    }
    return [...map.values()];
  }, [leads]);
  const leadsMergedCount = leadGroups.filter(g => g.leads.length > 1).length;
  const toggleLeadGroup = (key) => setLeadsExpanded(p => ({ ...p, [key]: !p[key] }));
  const leadClientList = (set) => { const a = [...set]; if (!a.length) return '-'; return a.length <= 2 ? a.join(', ') : `${a.slice(0,2).join(', ')} +${a.length-2} more`; };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <h1 className="text-xl font-bold flex items-center gap-2"><FiTarget className="text-red-600" /> Sales Funnel</h1>
        <div className="flex gap-2">
          <button onClick={() => exportCsv('leads',
            ['Lead No','Client','Company','Category','Location','Phone','Email','Source','Stage','Assigned SC','Assigned ASM','Date'],
            leads.map(l => [l.lead_no, l.client_name, l.company_name, l.category, `${l.district||''} ${l.state||''}`.trim(), l.phone, l.email, l.source, l.current_stage, l.assigned_sc, l.assigned_asm, l.created_at]))}
            className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload size={15}/> Export Excel</button>
          {canCreate('leads') && <button onClick={() => { setForm({ client_name:'',company_name:'',phone:'',email:'',category:'',address:'',source:'',assigned_sc:user?.name||'',assigned_asm:'',remarks:'' }); setModal('add'); }} className="btn btn-primary flex items-center gap-2 text-sm"><FiPlus size={15}/> New Lead</button>}
        </div>
      </div>

      {/* Sales Funnel stage tabs — same pill-button style as the
          Indent-to-Dispatch tabs (Raise Indent / Vendor Rates / …) so
          each stage is a clearly visible step. ALL stages are always
          shown (even when count=0) so mam can see the full pipeline at
          a glance. The count chip on each tab makes it obvious where
          the leads are sitting today. */}
      <div className="flex gap-2 flex-wrap items-center">
        <button
          onClick={() => { setTab('dashboard'); setStageTab('dashboard'); }}
          className={`btn ${tab === 'dashboard' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}
        >
          <FiTrendingUp size={14} /> Dashboard
        </button>
        <button
          onClick={() => { setTab('list'); setStageTab('all'); }}
          className={`btn ${tab === 'list' && stageTab === 'all' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}
        >
          All Leads
          <span className="bg-white/30 text-white px-1.5 rounded-full text-[10px] font-bold min-w-[18px] text-center">
            {dashboard?.total || 0}
          </span>
        </button>
        {STAGES.map(s => {
          const count = dashboard?.byStage?.find(b => b.current_stage === s)?.count || 0;
          const isActive = stageTab === s && tab === 'list';
          return (
            <button
              key={s}
              onClick={() => { setTab('list'); setStageTab(s); }}
              className={`btn ${isActive ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}
              title={STAGE_LABELS[s]}
            >
              {STAGE_LABELS[s]}
              <span className={`px-1.5 rounded-full text-[10px] font-bold min-w-[18px] text-center ${isActive ? 'bg-white/30 text-white' : 'text-white ' + (TAB_STYLES[s] || 'bg-gray-400')}`}>
                {count}
              </span>
            </button>
          );
        })}
        <button
          onClick={() => setTab('responsible')}
          className={`btn ${tab === 'responsible' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}
        >
          ⚙ Responsible
        </button>
      </div>

      {tab === 'responsible' && <ResponsibilityTab module="sales_funnel" title="Sales Funnel" />}

      {/* Dashboard Tab */}
      {tab === 'dashboard' && dashboard && (
        <div className="space-y-4">
          {/* Stats Row */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="card p-4 border-l-4 border-red-500"><p className="text-[10px] text-gray-500 font-bold uppercase">Total Leads</p><p className="text-3xl font-extrabold text-red-600">{dashboard.total}</p></div>
            <div className="card p-4 border-l-4 border-purple-500"><p className="text-[10px] text-gray-500 font-bold uppercase">This Month</p><p className="text-3xl font-extrabold text-purple-600">{dashboard.thisMonth}</p></div>
            <div className="card p-4 border-l-4 border-emerald-500"><p className="text-[10px] text-gray-500 font-bold uppercase">Won Deals</p><p className="text-3xl font-extrabold text-emerald-600">{dashboard.won?.c||0}</p><p className="text-xs text-emerald-500">{dashboard.won?.amount>0?fmt(dashboard.won.amount):''}</p></div>
            <div className="card p-4 border-l-4 border-red-500"><p className="text-[10px] text-gray-500 font-bold uppercase">Lost</p><p className="text-3xl font-extrabold text-red-600">{dashboard.lost?.c||0}</p></div>
            <div className="card p-4 border-l-4 border-amber-500"><p className="text-[10px] text-gray-500 font-bold uppercase">Win Rate</p><p className="text-3xl font-extrabold text-amber-600">{dashboard.total>0?Math.round(((dashboard.won?.c||0)/dashboard.total)*100):0}%</p></div>
            {(dashboard.todayFollowups>0||dashboard.overdueFollowups>0)&&<div className="card p-4 border-l-4 border-orange-500"><p className="text-[10px] text-gray-500 font-bold uppercase">Follow-ups</p><p className="text-xl font-bold text-orange-600">{dashboard.todayFollowups} today</p>{dashboard.overdueFollowups>0&&<p className="text-xs text-red-600 font-bold">{dashboard.overdueFollowups} overdue!</p>}</div>}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Stage Bar Chart */}
            <div className="card">
              <h4 className="font-bold text-sm text-gray-700 mb-3">Pipeline by Stage</h4>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={stageChartData}><XAxis dataKey="name" tick={{fontSize:9}} angle={-20} textAnchor="end" height={50}/><YAxis tick={{fontSize:10}}/><Tooltip/><Bar dataKey="count" radius={[4,4,0,0]}>{stageChartData.map((e,i)=>(<Cell key={i} fill={e.fill}/>))}</Bar></BarChart>
              </ResponsiveContainer>
            </div>

            {/* Category Donut — inline labels removed because they
                collide on small slices.  Counts live in the right-side
                legend instead.  Mam, 2026-05-15. */}
            <div className="card">
              <h4 className="font-bold text-sm text-gray-700 mb-3">By Category</h4>
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie data={catChartData} cx="40%" cy="50%" innerRadius={45} outerRadius={80} dataKey="value" label={false} labelLine={false}>
                    {catChartData.map((e,i)=>(<Cell key={i} fill={e.fill}/>))}
                  </Pie>
                  <Tooltip formatter={(v) => [v, 'leads']} />
                  <Legend iconSize={10} wrapperStyle={{fontSize:11}} layout="vertical" verticalAlign="middle" align="right"
                    formatter={(name, entry) => `${name} — ${entry?.payload?.value ?? 0}`} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* Funnel */}
            <div className="card">
              <h4 className="font-bold text-sm text-gray-700 mb-3">Sales Funnel</h4>
              <div className="space-y-1">{funnelData.map((f,i) => {
                const maxCount = Math.max(...funnelData.map(d=>d.count),1);
                const width = Math.max(20, (f.count/maxCount)*100);
                return (<div key={i} className="flex items-center gap-2">
                  <span className="text-[9px] w-16 text-right text-gray-500 font-medium">{f.stage}</span>
                  <div className="flex-1 bg-gray-100 rounded-full h-6 overflow-hidden">
                    <div className="h-full rounded-full flex items-center px-2 transition-all" style={{width:`${width}%`, backgroundColor:Object.values(STAGE_COLORS)[i]||'#888'}}>
                      <span className="text-white text-[10px] font-bold">{f.count}</span>
                    </div>
                  </div>
                </div>);
              })}</div>
            </div>

            {/* SC Performance — same legend-only style as the Category
                donut so multiple SC names don't collide on the pie. */}
            <div className="card">
              <h4 className="font-bold text-sm text-gray-700 mb-3">By Sales Coordinator</h4>
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie data={scChartData} cx="40%" cy="50%" innerRadius={40} outerRadius={80} dataKey="count" label={false} labelLine={false}>
                    {scChartData.map((e,i)=>(<Cell key={i} fill={e.fill}/>))}
                  </Pie>
                  <Tooltip formatter={(v) => [v, 'leads']} />
                  <Legend iconSize={10} wrapperStyle={{fontSize:11}} layout="vertical" verticalAlign="middle" align="right"
                    formatter={(name, entry) => `${name} — ${entry?.payload?.count ?? 0}`} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* Fortnightly expected closings — AR/AP-tracker style: amount (₹L)
                + lead count per 14-day bucket, from qualified leads' closing
                date + tentative amount (mam 2026-06-25). */}
            <div className="card md:col-span-2">
              <h4 className="font-bold text-sm text-gray-700 mb-3">Expected Closings — Fortnightly <span className="font-normal text-gray-400">· ₹ in Lakhs · from qualified leads' closing date + tentative amount</span></h4>
              {closingChartData.length === 0 || closingChartData.every(b => b.count === 0) ? (
                <div className="h-[220px] flex items-center justify-center text-sm text-gray-400">No leads with a closing date yet — set the Lead Closing Date when qualifying a lead.</div>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={closingChartData} margin={{top:16,right:10,left:0,bottom:5}}>
                    <XAxis dataKey="name" tick={{fontSize:9}} angle={-15} textAnchor="end" height={55}/>
                    <YAxis tick={{fontSize:10}} tickFormatter={(v)=>`${v}L`}/>
                    <Tooltip formatter={(v,n,p)=>[`₹${(p.payload.amount||0).toLocaleString('en-IN')} · ${p.payload.count} lead${p.payload.count===1?'':'s'}`, 'Closing']}/>
                    <Bar dataKey="amountL" radius={[4,4,0,0]}>
                      {closingChartData.map((e,i)=>(<Cell key={i} fill={e.name==='Overdue' ? '#ef4444' : e.name==='Later' ? '#94a3b8' : '#6366f1'}/>))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>
      )}

      {/* List Tab */}
      {tab === 'list' && (<>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[220px]"><FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16}/><input className="input pl-10" placeholder="Search client, company, lead no, phone..." value={search} onChange={e=>setSearch(e.target.value)}/></div>
          <button onClick={()=>setGroupLeads(v=>!v)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition-all ${groupLeads ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-white text-gray-500 border-gray-200 hover:border-amber-300'}`}
            title="Merge leads that share the same project">
            <FiGrid size={14}/> {groupLeads ? 'Grouped by Project' : 'Group by Project'}
          </button>
        </div>
        {groupLeads && (
          <div className="text-xs text-gray-500">{leadGroups.length} project{leadGroups.length!==1?'s':''} ({leads.length} lead{leads.length!==1?'s':''}{leadsMergedCount>0?`, ${leadsMergedCount} merged`:''}) · tap a project to expand</div>
        )}
        <div className="card p-0"><table className="text-xs freeze-head">
          <thead><tr><th className="px-3 py-2">Lead No</th><th className="px-3 py-2">Client</th><th className="px-3 py-2">Company</th><th className="px-3 py-2">Category</th><th className="px-3 py-2">Location</th><th className="px-3 py-2 text-right">Tentative Amt</th><th className="px-3 py-2">SC</th><th className="px-3 py-2">Stage</th><th className="px-3 py-2">SLA</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Actions</th></tr></thead>
          <tbody>
            {/* Flat list, or merged-by-project when grouping is on. */}
            {!groupLeads && leads.map(l => renderLeadRow(l))}
            {groupLeads && leadGroups.map(g => {
              const open = !!leadsExpanded[g.key];
              return (
                <Fragment key={g.key}>
                  {/* Collapsed project row — project + lead count + tentative total. */}
                  <tr className="bg-blue-50/60 hover:bg-blue-100/60 cursor-pointer border-l-4 border-blue-600" onClick={()=>toggleLeadGroup(g.key)}>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5 text-blue-700">
                        {open ? <FiChevronDown size={14}/> : <FiChevronRight size={14}/>}
                        <span className="bg-blue-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">{g.leads.length} lead{g.leads.length>1?'s':''}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-[11px]">{leadClientList(g.clients)}</td>
                    <td className="px-3 py-2" colSpan={2}>
                      <span className="font-semibold text-[12px] text-gray-900 flex items-center gap-1"><FiMapPin size={11} className="text-blue-600"/> {g.label}</span>
                      <span className="text-[9px] text-blue-700/80">tap to {open?'collapse':'expand'}</span>
                    </td>
                    <td className="px-3 py-2"></td>
                    <td className="px-3 py-2 text-right font-bold text-emerald-700">{g.amount>0?`₹${g.amount.toLocaleString('en-IN')}`:'-'}<div className="text-[8px] text-gray-400 font-normal uppercase">tentative</div></td>
                    <td className="px-3 py-2" colSpan={5}></td>
                  </tr>
                  {open && g.leads.map(l => renderLeadRow(l, true))}
                </Fragment>
              );
            })}
            {leads.length===0&&<tr><td colSpan="11" className="text-center py-8 text-gray-400">No leads</td></tr>}
          </tbody>
        </table></div>
      </>)}

      {/* View + Stage Actions */}
      <Modal isOpen={modal==='view'} onClose={()=>{setModal(null);setViewData(null);setViewStage(null);}} title={`${viewData?.lead_no} - ${viewData?.client_name}`} wide>
        {viewData && (<div className="space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Pipeline pills — all clickable. Clicking one sets `viewStage`
              so the "Next Action" form for that stage is shown. Admin can
              use this to jump back (correct a past step) or skip forward
              (for optional stages like Drawings). The lead's own
              `current_stage` doesn't change until the form is submitted. */}
          <div className="flex gap-1 overflow-x-auto pb-2">{STAGES.filter(s=>s!=='lost').map((key,idx)=>{
            const keys=STAGES.filter(s=>s!=='lost'); const si=keys.indexOf(viewData.current_stage); const ti=keys.indexOf(key);
            const done=ti<=si; const cur=viewData.current_stage===key;
            const selected=(viewStage||viewData.current_stage)===key;
            return(<div key={key} className="flex items-center">
              <button
                type="button"
                onClick={()=>{setViewStage(key);setStageForm({});}}
                className={`px-2 py-1 rounded text-[9px] font-bold min-w-[50px] text-center transition-all hover:scale-105 ${selected?'ring-2 ring-offset-1 ring-red-500':''}`}
                style={{backgroundColor:cur||done?STAGE_COLORS[key]:'#e5e7eb',color:cur||done?'white':'#9ca3af'}}
                title={selected ? 'Currently viewing this stage' : `Click to view ${STAGE_LABELS[key]} form`}
              >{STAGE_SHORT[key]}</button>
              {idx<keys.length-1&&<FiChevronRight size={10} className="text-gray-300 mx-0.5"/>}
            </div>);
          })}</div>
          {viewStage && viewStage !== viewData.current_stage && (
            <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 flex items-center justify-between">
              <span>
                {STAGES.indexOf(viewStage) < STAGES.indexOf(viewData.current_stage)
                  ? <>You're viewing a <b>past stage</b> — submitting will set the lead back to this stage (to correct data).</>
                  : <>You're <b>skipping ahead</b> from {STAGE_LABELS[viewData.current_stage]} to {STAGE_LABELS[viewStage]} — some intermediate steps won't be filled.</>}
              </span>
              <button onClick={()=>{setViewStage(null);setStageForm({});}} className="text-amber-700 hover:underline font-bold">Back to current</button>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 text-sm">
            <div><span className="text-gray-400 text-[10px]">Client</span><br/><strong>{viewData.client_name}</strong></div>
            <div><span className="text-gray-400 text-[10px]">Company</span><br/>{viewData.company_name||'-'}</div>
            <div><span className="text-gray-400 text-[10px]">Category</span><br/>{viewData.category||'-'}</div>
            <div><span className="text-gray-400 text-[10px]">Phone</span><br/>{viewData.phone||'-'}</div>
            <div><span className="text-gray-400 text-[10px]">SC</span><br/>{viewData.assigned_sc||'-'}</div>
            <div><span className="text-gray-400 text-[10px]">ASM</span><br/>{viewData.assigned_asm||'-'}</div>
          </div>
          {viewData.qualified_remarks&&<div className="bg-red-50 p-2 rounded text-xs"><strong>Qualified:</strong> {viewData.qualified_remarks}</div>}
          {viewData.meeting_date&&<div className="bg-purple-50 p-2 rounded text-xs"><strong>Meeting:</strong> {viewData.meeting_date} - {viewData.meeting_location}</div>}
          {viewData.mom_notes&&<div className="bg-violet-50 p-2 rounded text-xs"><strong>MOM:</strong> {viewData.mom_notes} {viewData.mom_file_link&&<a href={viewData.mom_file_link} className="text-red-600 underline" target="_blank" rel="noreferrer">File</a>}</div>}
          {viewData.drawing_file1&&<div className="bg-amber-50 p-2 rounded text-xs"><strong>Drawings:</strong> <a href={viewData.drawing_file1} className="text-red-600 underline" target="_blank" rel="noreferrer">1</a> {viewData.drawing_file2&&<a href={viewData.drawing_file2} className="text-red-600 underline ml-2" target="_blank" rel="noreferrer">2</a>} {viewData.drawing_file3&&<a href={viewData.drawing_file3} className="text-red-600 underline ml-2" target="_blank" rel="noreferrer">3</a>}</div>}
          {/* BOQ history + add — clients re-send BOQs over time (mam 2026-06-12). */}
          <div className="border border-orange-200 bg-orange-50/50 rounded-lg p-3 space-y-2">
            <strong className="text-xs text-orange-800">BOQs{boqList.length>0 && <span className="text-orange-500 font-normal"> ({boqList.length})</span>}</strong>
            {boqList.length>0 ? (
              <div className="space-y-1">
                {boqList.map((b,i) => (
                  <div key={b.id} className="flex items-center justify-between gap-2 bg-white rounded px-2 py-1 text-xs border border-orange-100">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[10px] font-mono text-orange-400">#{boqList.length - i}</span>
                      <span className="font-semibold whitespace-nowrap">Rs {(+b.boq_amount||0).toLocaleString('en-IN')}</span>
                      {b.boq_file_link && <a href={b.boq_file_link} className="text-red-600 underline" target="_blank" rel="noreferrer">View</a>}
                      {b.notes && <span className="text-gray-500 truncate">· {b.notes}</span>}
                    </div>
                    <span className="text-[10px] text-gray-400 whitespace-nowrap">{(b.created_at||'').slice(0,10)}{b.created_by?` · ${b.created_by}`:''}</span>
                  </div>
                ))}
              </div>
            ) : <div className="text-[11px] text-gray-400">No BOQ added yet.</div>}
            {canEdit('leads') && (
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-orange-100">
                <input type="file" className="text-[11px]" onChange={async e=>{const f=e.target.files[0]; if(!f) return; try{ const url=await uploadFile(f); setBoqForm(s=>({...s, boq_file_link:url})); toast.success('BOQ uploaded'); }catch{ toast.error('Upload failed'); }}} />
                <input className="input text-xs" style={{width:'130px'}} type="number" placeholder="Amount (₹)" value={boqForm.boq_amount} onChange={e=>setBoqForm(s=>({...s, boq_amount:e.target.value}))} />
                <input className="input text-xs flex-1 min-w-[120px]" placeholder="Note (optional)" value={boqForm.notes} onChange={e=>setBoqForm(s=>({...s, notes:e.target.value}))} />
                <button type="button" disabled={boqAdding} onClick={addBoq} className="btn btn-primary text-xs py-1 px-3 disabled:opacity-40">{boqAdding?'Adding…':'+ Add BOQ'}</button>
                {boqForm.boq_file_link && <span className="text-[10px] text-emerald-600 w-full">✓ File attached — set amount/note, then Add BOQ</span>}
              </div>
            )}
          </div>
          {/* Quote-sent summary — mam (2026-06-01): "NOT SHOWING QUOTE
              SENT FILE WHEN SHOWING FILE THEN I AUDIT".  Surface the
              uploaded quotation PDF as a clickable link so any later
              stage (Tech Clarify, Negotiation, Contract, Kickoff) can
              open it directly without going back to Stage 7. */}
          {(viewData.quotation_number || viewData.quotation_file_link) && (
            <div className="bg-cyan-50 p-2 rounded text-xs flex items-center gap-2 flex-wrap">
              <strong>Quotation:</strong>
              {viewData.quotation_number && <span>{viewData.quotation_number}</span>}
              {viewData.quotation_amount > 0 && <span>· Rs {viewData.quotation_amount.toLocaleString()}</span>}
              {viewData.quotation_sent_date && <span className="text-gray-500">· sent {fmtDateIST(viewData.quotation_sent_date)}</span>}
              {viewData.quotation_file_link
                ? <a href={viewData.quotation_file_link} target="_blank" rel="noreferrer"
                     className="ml-auto inline-flex items-center gap-1 text-cyan-700 font-semibold underline hover:text-cyan-900">
                    📄 View quote file
                  </a>
                : <span className="ml-auto text-gray-400 italic">no file uploaded</span>}
            </div>
          )}
          {viewData.result&&<div className={`p-3 rounded font-bold text-center text-lg ${viewData.result==='won'?'bg-emerald-100 text-emerald-700':'bg-red-100 text-red-700'}`}>{viewData.result.toUpperCase()} {viewData.won_amount>0&&`- ${fmt(viewData.won_amount)}`}</div>}

          {/* Follow-ups */}
          <div className="border rounded-xl p-3 space-y-2">
            <div className="flex justify-between items-center"><h5 className="font-bold text-sm">Follow-ups</h5></div>
            <div className="flex gap-2 items-end">
              <div className="flex-1"><input className="input text-xs" type="date" value={fuForm.followup_date} onChange={e=>setFuForm({...fuForm,followup_date:e.target.value})}/></div>
              <div><TimePicker value={fuForm.followup_time||''} onChange={v=>setFuForm({...fuForm,followup_time:v})} placeholder="Time" className="input text-xs flex items-center gap-2 cursor-pointer"/></div>
              <select className="select text-xs w-24" value={fuForm.type} onChange={e=>setFuForm({...fuForm,type:e.target.value})}><option value="call">Call</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="visit">Visit</option></select>
              <input className="input text-xs flex-1" placeholder="Notes" value={fuForm.notes||''} onChange={e=>setFuForm({...fuForm,notes:e.target.value})}/>
              <button onClick={addFollowup} className="btn btn-primary text-xs px-3">Add</button>
            </div>
            {followups.length>0&&<div className="space-y-1 max-h-32 overflow-y-auto">{followups.map(f=>(
              <div key={f.id} className={`flex items-center justify-between text-xs p-2 rounded ${f.done?'bg-gray-50':'bg-amber-50 border border-amber-200'}`}>
                <div><span className="font-medium">{f.followup_date}</span> {f.followup_time&&<span className="text-gray-400">{f.followup_time}</span>} <span className="capitalize bg-gray-100 px-1 rounded text-[9px]">{f.type}</span> {f.notes&&<span className="text-gray-500 ml-1">{f.notes}</span>}</div>
                <div>{f.done?<span className="text-emerald-600 font-bold text-[9px]">{f.outcome}</span>:(
                  <div className="flex gap-1">
                    <button onClick={()=>logFollowup(f.id,'connected')} className="text-[9px] text-emerald-600 font-bold">Connected</button>
                    <button onClick={()=>logFollowup(f.id,'not_reachable')} className="text-[9px] text-red-600 font-bold">NR</button>
                    <button onClick={()=>logFollowup(f.id,'callback')} className="text-[9px] text-amber-600 font-bold">Callback</button>
                    <button onClick={()=>logFollowup(f.id,'interested')} className="text-[9px] text-red-600 font-bold">Interested</button>
                  </div>
                )}</div>
              </div>
            ))}</div>}
          </div>

          {(() => {
            // Effective stage for the "Next Action" panel — clicking a pill
            // above sets viewStage, so the user can jump to any stage's form.
            const activeStage = viewStage || viewData.current_stage;
            // Terminal states — no further action panel. project_kickoff
            // ends the sales funnel (lead handed off to Project module);
            // lost is a dropped lead.
            if (activeStage === 'lost') return null;
            return (
            <div className="border-2 rounded-xl p-4 space-y-3" style={{borderColor:STAGE_COLORS[activeStage],backgroundColor:STAGE_COLORS[activeStage]+'10'}}>
              <h5 className="font-bold flex items-center justify-between" style={{color:STAGE_COLORS[activeStage]}}>
                <span>{STAGE_LABELS[activeStage]} — Action</span>
                {viewStage && viewStage !== viewData.current_stage && (
                  <span className="text-[10px] font-normal text-gray-500">Lead is currently at: <b>{STAGE_LABELS[viewData.current_stage]}</b></span>
                )}
              </h5>
              {/* Stage 1 → Stage 2: Qualified or Not (GO/NO-GO) */}
              {activeStage==='lead_capture'&&(<div className="space-y-2">
                <textarea className="input" rows="2" placeholder="Remarks..." value={stageForm.qualified_remarks||''} onChange={e=>setStageForm({...stageForm,qualified_remarks:e.target.value})}/>
                {/* Tentative project value — captured when the lead is qualified
                    (mam 2026-06-25). Optional; stored on the funnel lead. */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] font-semibold text-gray-500 uppercase mb-0.5">Tentative project amount (₹) <span className="font-normal normal-case text-gray-400">— qualified lead</span></label>
                    <input className="input" type="number" min="0" placeholder="e.g. 500000"
                      value={stageForm.tentative_amount ?? (viewData.tentative_amount ?? '')}
                      onChange={e=>setStageForm({...stageForm,tentative_amount:e.target.value})}/>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-gray-500 uppercase mb-0.5">Lead closing date <span className="font-normal normal-case text-gray-400">— expected</span></label>
                    <input className="input" type="date"
                      value={stageForm.closing_date ?? (viewData.closing_date ? String(viewData.closing_date).slice(0,10) : '')}
                      onChange={e=>setStageForm({...stageForm,closing_date:e.target.value})}/>
                  </div>
                </div>
                <div className="flex gap-2"><button onClick={()=>advanceStage(viewData.id,'qualification',stageForm)} className="btn btn-success flex-1"><FiCheck className="inline mr-1"/>Qualified</button><button onClick={()=>advanceStage(viewData.id,'not_qualified',stageForm)} className="btn btn-danger flex-1"><FiX className="inline mr-1"/>Not Qualified</button></div>
              </div>)}
              {/* Stage 2 → Stage 3: Schedule Site Survey (was 'Assign Meeting') */}
              {activeStage==='qualification'&&(<div className="space-y-2">
                <input className="input" type="datetime-local" value={stageForm.meeting_date||''} onChange={e=>setStageForm({...stageForm,meeting_date:e.target.value})}/>
                <input className="input" placeholder="Location" value={stageForm.meeting_location||''} onChange={e=>setStageForm({...stageForm,meeting_location:e.target.value})}/>
                {/* Assign Meeting → searchable employee dropdown. Stores
                    both the name (for display) and user_id (so the
                    assignee's dashboard can filter to their meetings). */}
                <SearchableSelect
                  options={employees.map(e => ({
                    value: e.id,
                    label: e.name + (e.designation ? ' — ' + e.designation : ''),
                    name: e.name,
                    user_id: e.user_id,
                  }))}
                  value={stageForm.meeting_assigned_employee_id || ''}
                  onChange={(opt) => setStageForm({
                    ...stageForm,
                    meeting_assigned_employee_id: opt?.value || null,
                    meeting_assigned_to: opt?.name || '',
                    meeting_assigned_to_id: opt?.user_id || null,
                  })}
                  placeholder="Assign To (search employee)..."
                />
                <button onClick={()=>advanceStage(viewData.id,'site_survey',stageForm)} className="btn btn-primary w-full">Schedule Site Survey</button>
              </div>)}
              {/* Stage 3 — Site Survey + Feasibility. Reuses the MOM form
                  (mam's Google Form layout from 2026-04-23): Customer
                  Category, Type, Location, Purpose, Pain Points, Reqs,
                  M.O.M., Action Planned, Format, Time, photos, MOM file. */}
              {activeStage==='site_survey'&&(<div className="space-y-3">
                {/* Customer Category — multi-select (mam 2026-06-25 "can select
                    multiple"). Stored as a comma-separated list in `category`. */}
                <div>
                  <label className="label text-[10px]">Customer Category * <span className="text-gray-400 normal-case font-normal">(select one or more)</span></label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
                    {(() => {
                      const selected = new Set(String(stageForm.category ?? viewData.category ?? '').split(',').map(s => s.trim()).filter(Boolean));
                      return ['Fire Fighting','Electrical','Low Voltage','HVAC','MEPF','Solar','Plumbing','Other'].map(cat => {
                        const isOn = selected.has(cat);
                        return (
                          <label key={cat} className={`flex items-center gap-1.5 px-2 py-1.5 border rounded text-xs cursor-pointer ${isOn ? 'border-red-500 bg-red-50 text-red-700' : 'border-gray-200 hover:bg-gray-50'}`}>
                            <input type="checkbox" name="customer_category" value={cat} checked={isOn}
                              onChange={() => { const next = new Set(selected); isOn ? next.delete(cat) : next.add(cat); setStageForm({ ...stageForm, category: [...next].join(', ') }); }} />
                            {cat}
                          </label>
                        );
                      });
                    })()}
                  </div>
                </div>

                {/* Customer Type — Existing / New */}
                <div>
                  <label className="label text-[10px]">Customer Type *</label>
                  <div className="flex gap-2">
                    {['Existing','New'].map(t => (
                      <label key={t} className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border rounded text-xs cursor-pointer ${(stageForm.lead_type||viewData.lead_type)===t ? 'border-red-500 bg-red-50 text-red-700 font-bold' : 'border-gray-200 hover:bg-gray-50'}`}>
                        <input type="radio" name="customer_type" value={t} checked={(stageForm.lead_type||viewData.lead_type)===t} onChange={()=>setStageForm({...stageForm,lead_type:t})} />
                        {t}
                      </label>
                    ))}
                  </div>
                </div>

                {/* Meeting Location context (editable) */}
                <div>
                  <label className="label text-[10px]">Meeting Location</label>
                  <input className="input" value={stageForm.meeting_location ?? (viewData.meeting_location||'')} onChange={e=>setStageForm({...stageForm,meeting_location:e.target.value})} placeholder="Site / office / online"/>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="label text-[10px]">Purpose of Meeting *</label>
                    <input className="input" value={stageForm.meeting_purpose||''} onChange={e=>setStageForm({...stageForm,meeting_purpose:e.target.value})} placeholder="e.g. site survey / requirement gathering" required/>
                  </div>
                  <div>
                    <label className="label text-[10px]">Meeting Format</label>
                    <select className="select" value={stageForm.meeting_format||''} onChange={e=>setStageForm({...stageForm,meeting_format:e.target.value})}>
                      <option value="">— Select —</option>
                      <option value="in_person">In-Person</option>
                      <option value="phone">Phone</option>
                      <option value="video_call">Video Call</option>
                      <option value="email">Email</option>
                    </select>
                  </div>
                  <div>
                    <label className="label text-[10px]">Meeting Scheduled By</label>
                    <input className="input" value={stageForm.meeting_scheduled_by||''} onChange={e=>setStageForm({...stageForm,meeting_scheduled_by:e.target.value})} placeholder="Name of scheduler"/>
                  </div>
                  <div>
                    <label className="label text-[10px]">Time Spent (minutes)</label>
                    <input className="input" type="number" min="0" value={stageForm.meeting_time_spent_min||''} onChange={e=>setStageForm({...stageForm,meeting_time_spent_min:+e.target.value})} placeholder="e.g. 45"/>
                  </div>
                </div>

                <div>
                  <label className="label text-[10px]">Pain Points</label>
                  <textarea className="input" rows="2" value={stageForm.pain_points||''} onChange={e=>setStageForm({...stageForm,pain_points:e.target.value})} placeholder="Client's current challenges / issues"/>
                </div>
                <div>
                  <label className="label text-[10px]">Requirements</label>
                  <textarea className="input" rows="2" value={stageForm.requirements||''} onChange={e=>setStageForm({...stageForm,requirements:e.target.value})} placeholder="What client needs — scope / quantities / standards"/>
                </div>
                <div>
                  <label className="label text-[10px]">M.O.M. (Minutes of Meeting) *</label>
                  <textarea className="input" rows="3" value={stageForm.mom_notes||''} onChange={e=>setStageForm({...stageForm,mom_notes:e.target.value})} placeholder="What was discussed / agreed" required/>
                </div>
                <div>
                  <label className="label text-[10px]">Action Planned</label>
                  <textarea className="input" rows="2" value={stageForm.action_planned||''} onChange={e=>setStageForm({...stageForm,action_planned:e.target.value})} placeholder="Next steps — who does what by when"/>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="label text-[10px]">Timestamp Photo <span className="text-gray-400 font-normal">(selfie at site with date stamp)</span></label>
                    <input type="file" accept="image/*" onChange={async(e)=>{const f=e.target.files[0];if(!f)return;try{const url=await uploadFile(f);setStageForm(s=>({...s,meeting_timestamp_photo_url:url}));toast.success('Photo uploaded');}catch{toast.error('Failed');}}} className="text-xs"/>
                    {stageForm.meeting_timestamp_photo_url && <p className="text-[10px] text-emerald-600 mt-0.5">✓ Photo attached</p>}
                  </div>
                  <div>
                    <label className="label text-[10px]">MOM File <span className="text-gray-400 font-normal">(optional PDF/doc)</span></label>
                    <input type="file" onChange={async(e)=>{const f=e.target.files[0];if(!f)return;try{const url=await uploadFile(f);setStageForm(s=>({...s,mom_file_link:url}));toast.success('MOM file uploaded');}catch{toast.error('Failed');}}} className="text-xs"/>
                    {stageForm.mom_file_link && <p className="text-[10px] text-emerald-600 mt-0.5">✓ File attached</p>}
                  </div>
                </div>

                <button onClick={()=>advanceStage(viewData.id,'mom_uploaded',stageForm)} disabled={!stageForm.mom_notes||!stageForm.meeting_purpose} className="btn btn-primary w-full disabled:opacity-50">Submit MOM &amp; Move to Design</button>
              </div>)}
              {/* Stage 3 → Stage 4: upload drawings (concept design) */}
              {activeStage==='concept_design'&&(<div className="space-y-2">
                {[1,2,3].map(n=>(<div key={n} className="flex items-center gap-2"><span className="text-xs w-16">Drawing {n}:</span><input type="file" onChange={async(e)=>{const f=e.target.files[0];if(!f)return;try{const url=await uploadFile(f);setStageForm(s=>({...s,[`drawing_file${n}`]:url}));toast.success(`Drawing ${n}`);}catch{toast.error('Failed');}}} className="text-xs flex-1"/>{stageForm[`drawing_file${n}`]&&<span className="text-emerald-600 text-xs">OK</span>}</div>))}
                <button onClick={()=>advanceStage(viewData.id,'concept_design',stageForm)} disabled={!stageForm.drawing_file1} className="btn btn-primary w-full disabled:opacity-50">Submit Drawings &amp; Move to BOQ</button>
              </div>)}
              {/* Stage 4 → Stage 5: BOQ + vendor costing */}
              {activeStage==='boq_costing'&&(<div className="space-y-2">
                <input type="file" onChange={async(e)=>{const f=e.target.files[0];if(!f)return;try{stageForm.boq_file_link=await uploadFile(f);toast.success('BOQ uploaded');}catch{toast.error('Failed');}}} className="text-xs"/>
                <input className="input" type="number" placeholder="BOQ Amount (₹)" value={stageForm.boq_amount||''} onChange={e=>setStageForm({...stageForm,boq_amount:+e.target.value})}/>
                <button onClick={()=>advanceStage(viewData.id,'boq_costing',stageForm)} className="btn btn-primary w-full">Submit BOQ &amp; Send for Pricing Review</button>
              </div>)}
              {/* Stage 5 → Stage 6: Internal Pricing Review (GATE) — stub.
                  Full margin floor / CFO sign-off / slab routing wired
                  when mam asks for Stage 6. */}
              {activeStage==='pricing_review'&&(<div className="space-y-2">
                <div className="text-[11px] bg-orange-50 border border-orange-200 rounded p-2 text-orange-800">
                  🚦 <b>GATE — CFO + Sales Head sign-off.</b> Margin floor enforcement and slab-based approval routing will be added when mam requests Stage 6.
                </div>
                <textarea className="input" rows="2" placeholder="Pricing remarks..." value={stageForm.pricing_remarks||''} onChange={e=>setStageForm({...stageForm,pricing_remarks:e.target.value})}/>
                <button onClick={()=>advanceStage(viewData.id,'quote_submitted',stageForm)} className="btn btn-primary w-full">Approve &amp; Move to Quote Submission</button>
              </div>)}
              {/* Stage 6 → Stage 7: Quote / Bid Submission */}
              {activeStage==='quote_submitted'&&(<div className="space-y-2">
                <input className="input" placeholder="Quotation / Bid Number" value={stageForm.quotation_number||''} onChange={e=>setStageForm({...stageForm,quotation_number:e.target.value})}/>
                <input className="input" type="number" placeholder="Quote Amount (₹)" value={stageForm.quotation_amount||''} onChange={e=>setStageForm({...stageForm,quotation_amount:+e.target.value})}/>
                <input type="file" onChange={async(e)=>{const f=e.target.files[0];if(!f)return;try{stageForm.quotation_file_link=await uploadFile(f);toast.success('Uploaded');}catch{toast.error('Failed');}}} className="text-xs"/>
                <button onClick={()=>advanceStage(viewData.id,'technical_clarification',stageForm)} className="btn btn-primary w-full">Send Quote &amp; Open Clarification Round</button>
              </div>)}
              {/* Stage 7 → Stage 8: Technical Clarification — stub.
                  Mam (2026-06-01): show the previously-sent quote
                  here so the audit happens against the actual file
                  (was hidden, mam couldn't verify what client got). */}
              {activeStage==='technical_clarification'&&(<div className="space-y-2">
                {(viewData.quotation_number || viewData.quotation_file_link) && (
                  <div className="bg-cyan-50 border border-cyan-200 rounded p-2 text-xs flex items-center justify-between gap-2 flex-wrap">
                    <div>
                      <strong>Quote sent to audit:</strong>{' '}
                      {viewData.quotation_number || '(no number)'}
                      {viewData.quotation_amount > 0 && <span> · Rs {viewData.quotation_amount.toLocaleString()}</span>}
                      {viewData.quotation_sent_date && <span className="text-gray-500"> · {fmtDateIST(viewData.quotation_sent_date)}</span>}
                    </div>
                    {viewData.quotation_file_link
                      ? <a href={viewData.quotation_file_link} target="_blank" rel="noreferrer"
                           className="inline-flex items-center gap-1 px-2 py-1 rounded bg-cyan-600 text-white font-semibold hover:bg-cyan-700">
                          📄 Open quote file
                        </a>
                      : <span className="text-red-600 font-semibold">⚠ No file uploaded</span>}
                  </div>
                )}
                <div className="text-[11px] bg-sky-50 border border-sky-200 rounded p-2 text-sky-800">
                  Track customer queries + replies + revision rounds here. Full clarification log will be added when mam requests Stage 8.
                </div>
                <textarea className="input" rows="2" placeholder="Latest clarification / reply..." value={stageForm.clarification_note||''} onChange={e=>setStageForm({...stageForm,clarification_note:e.target.value})}/>
                <button onClick={()=>advanceStage(viewData.id,'commercial_negotiation',stageForm)} className="btn btn-primary w-full">Move to Negotiation</button>
              </div>)}
              {/* Stage 8 → Stage 9: Commercial Negotiation — stub */}
              {activeStage==='commercial_negotiation'&&(<div className="space-y-2">
                <div className="text-[11px] bg-teal-50 border border-teal-200 rounded p-2 text-teal-800">
                  Capture counter-offer, discount asked / given, final price, payment terms. Approval routing by slab will be wired when mam requests Stage 9.
                </div>
                <input className="input" type="number" placeholder="Final Price (₹)" value={stageForm.won_amount||''} onChange={e=>setStageForm({...stageForm,won_amount:+e.target.value})}/>
                <textarea className="input" rows="2" placeholder="Negotiation remarks..." value={stageForm.result_remarks||''} onChange={e=>setStageForm({...stageForm,result_remarks:e.target.value})}/>
                <div className="flex gap-2">
                  <button onClick={()=>advanceStage(viewData.id,'contract_signed',stageForm)} className="btn btn-success flex-1">WIN — Move to Contract</button>
                  <button onClick={()=>advanceStage(viewData.id,'lost',stageForm)} className="btn btn-danger flex-1">LOST</button>
                </div>
              </div>)}
              {/* Stage 9 → Stage 10: Contract + LOI/PO (GATE) — stub */}
              {activeStage==='contract_signed'&&(<div className="space-y-2">
                <div className="text-[11px] bg-emerald-50 border border-emerald-200 rounded p-2 text-emerald-800">
                  🚦 <b>GATE — Legal + CFO sign-off.</b> Capture LOI/PO PDF, signed contract, BG, advance receipt, clause checklist. Full vault will be added when mam requests Stage 10.
                </div>
                <textarea className="input" rows="2" placeholder="Contract remarks..." value={stageForm.contract_remarks||''} onChange={e=>setStageForm({...stageForm,contract_remarks:e.target.value})}/>
                <button onClick={()=>advanceStage(viewData.id,'project_kickoff',stageForm)} className="btn btn-primary w-full">Lock Contract &amp; Trigger Project</button>
              </div>)}
              {/* Stage 10 → Stage 11: Project Kickoff — stub. Terminal of
                  the sales funnel; further work moves into Project /
                  Execution / Billing modules. */}
              {activeStage==='project_kickoff'&&(<div className="space-y-2">
                <div className="text-[11px] bg-lime-50 border border-lime-200 rounded p-2 text-lime-800">
                  🎉 <b>Project kicked off.</b> Lead lifecycle ends here — execution / RA billing / collections continue in Project, Procurement, Billing modules. Full kickoff form (PM assigned, Site Engineer, Gantt, sales→ops handover sign-off) will be added when mam requests Stage 11.
                </div>
              </div>)}
            </div>
            );
          })()}
        </div>)}
      </Modal>

      {/* Add/Edit */}
      {/* STAGE 1 — Lead / Tender Capture (mam's funnel spec).
          Lead Kind toggle: Private vs Government. Govt-specific fields
          (Tender ID, bid deadline, EMD, PBG) appear only when needed. */}
      <Modal isOpen={modal==='add'||modal==='edit'} onClose={()=>setModal(null)} title={modal==='edit'?'Edit Lead':'Stage 1 — Lead / Tender Capture'} wide>
        <form onSubmit={saveLead} className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">
          {/* Lead Kind selector — drives the rest of the form */}
          <div>
            <label className="label">Lead Kind *</label>
            <div className="flex gap-2">
              {[
                { v: 'private', label: '🏢 Private (Quote)', desc: 'Direct customer, RFQ-based' },
                { v: 'government', label: '🏛 Government (Tender)', desc: 'GeM / CPPP / state portal' },
              ].map(o => (
                <label key={o.v} className={`flex-1 cursor-pointer border-2 rounded-lg p-3 text-center transition ${(form.lead_kind || 'private') === o.v ? 'border-red-500 bg-red-50 text-red-700 font-bold' : 'border-gray-200 hover:bg-gray-50'}`}>
                  <input type="radio" name="lead_kind" value={o.v} checked={(form.lead_kind || 'private') === o.v} onChange={e => F('lead_kind', e.target.value)} className="sr-only" />
                  <div className="text-sm">{o.label}</div>
                  <div className="text-[10px] text-gray-500 font-normal mt-0.5">{o.desc}</div>
                </label>
              ))}
            </div>
          </div>

          {/* Customer block — mam (2026-06-01): "gst & pan not
              recuired" (dropped), "mobile number and email
              verified or correct" (validators below). */}
          <div className="border-t pt-3"><h5 className="font-bold text-sm text-red-700 mb-2">Customer</h5></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            <div><label className="label">Customer Name *</label><input className="input" value={form.client_name||''} onChange={e=>F('client_name',e.target.value)} required/></div>
            <div><label className="label">Company / Entity</label><input className="input" value={form.company_name||''} onChange={e=>F('company_name',e.target.value)}/></div>
            <div>
              <label className="label">Phone</label>
              <input className={`input ${form.phone && !isValidIndianPhone(form.phone) ? 'border-red-500 focus:border-red-500' : ''}`}
                value={form.phone||''} onChange={e=>F('phone',e.target.value)}
                placeholder="10 digits, starts 6-9" inputMode="numeric" maxLength="10" />
              {form.phone && !isValidIndianPhone(form.phone) && (
                <div className="text-[10px] text-red-600 mt-0.5">Enter 10-digit Indian mobile (must start with 6, 7, 8 or 9)</div>
              )}
              {form.phone && isValidIndianPhone(form.phone) && (
                <div className="text-[10px] text-emerald-600 mt-0.5">✓ valid</div>
              )}
            </div>
            <div>
              <label className="label">Email</label>
              <input className={`input ${form.email && !isValidEmail(form.email) ? 'border-red-500 focus:border-red-500' : ''}`}
                type="email" value={form.email||''} onChange={e=>F('email',e.target.value)}
                placeholder="name@example.com" />
              {form.email && !isValidEmail(form.email) && (
                <div className="text-[10px] text-red-600 mt-0.5">Enter a valid email (e.g. name@example.com)</div>
              )}
              {form.email && isValidEmail(form.email) && (
                <div className="text-[10px] text-emerald-600 mt-0.5">✓ valid</div>
              )}
            </div>
          </div>

          {/* Project block */}
          <div className="border-t pt-3"><h5 className="font-bold text-sm text-red-700 mb-2">Project</h5></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            <div className="md:col-span-2"><label className="label">Project Name {modal!=='edit' && '*'}</label><input className="input" value={form.project_name||''} onChange={e=>F('project_name',e.target.value)} required={modal!=='edit'}/></div>
            <div><label className="label">PIN Code</label><input className="input" value={form.pin_code||''} onChange={e=>F('pin_code',e.target.value)} maxLength="6"/></div>
            <div className="md:col-span-3"><label className="label">Project Location</label><input className="input" value={form.project_location||''} onChange={e=>F('project_location',e.target.value)} placeholder="Site address / city"/></div>
            <div>
              <label className="label">State</label>
              <SearchableSelect
                options={STATES.map(s => ({ value: s, label: s }))}
                value={form.state || ''} valueKey="value" displayKey="label"
                placeholder="Pick state"
                onChange={(opt) => { F('state', opt?.value || ''); F('district', ''); }}
              />
            </div>
            <div>
              <label className="label">District</label>
              <SearchableSelect
                options={(form.state ? (DISTRICTS_BY_STATE[form.state] || []) : []).map(d => ({ value: d, label: d }))}
                value={form.district || ''} valueKey="value" displayKey="label"
                placeholder={form.state ? 'Pick district' : 'Pick a state first'}
                onChange={(opt) => F('district', opt?.value || '')}
              />
            </div>
            <div><label className="label">Estimated Value (₹)</label><input className="input" type="number" min="0" value={form.estimated_value||0} onChange={e=>F('estimated_value',+e.target.value)}/></div>
            {/* Mam (2026-06-01): tentative timeline locked to a
                6-option dropdown — was a freeform text field. */}
            <div>
              <label className="label">Tentative Timeline</label>
              <select className="select" value={form.tentative_timeline||''} onChange={e=>F('tentative_timeline',e.target.value)}>
                <option value="">Select…</option>
                {TIMELINE_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            {/* Building Category — mam (2026-06-01): "PIC 2 BUILDING
                CATEGORY ALSO ADD AND GIVE PIC DROP DOWN" — 15-option
                list of the building types lead/project belongs to. */}
            <div className="md:col-span-2">
              <label className="label">Building Category</label>
              <SearchableSelect
                options={BUILDING_CATEGORIES.map(b => ({ value: b, label: b }))}
                value={form.building_category || ''}
                valueKey="value" displayKey="label"
                placeholder="Choose building category…"
                onChange={(opt) => F('building_category', opt?.value || '')}
              />
            </div>
          </div>

          {/* Category + Sub-trades */}
          <div className="border-t pt-3"><h5 className="font-bold text-sm text-red-700 mb-2">Scope</h5></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Category *</label>
              {/* 7-option dropdown matching mam's spec (Section 3 of 7).
                  Required — every lead must declare its trade category so
                  the right team picks it up. */}
              <select className="select" required value={form.category||''} onChange={e=>F('category',e.target.value)}>
                <option value="">Select Category</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {/* Sub-trades Scope removed at mam's request — the 7-option
                Category above already captures the trade. The sub_trades_scope
                column stays in the schema (harmless, NULL on new rows). */}
          </div>

          {/* Government-only block */}
          {form.lead_kind === 'government' && (
            <>
              <div className="border-t pt-3"><h5 className="font-bold text-sm text-amber-700 mb-2">🏛 Government / Tender Details</h5></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 bg-amber-50/40 p-3 rounded-lg border border-amber-200">
                <div className="md:col-span-2"><label className="label">Tender ID *</label><input className="input" value={form.tender_id||''} onChange={e=>F('tender_id',e.target.value)} required={form.lead_kind==='government'} placeholder="e.g. GEM/2026/B/12345"/></div>
                <div><label className="label">Bid Deadline</label><input className="input" type="date" value={form.bid_deadline||''} onChange={e=>F('bid_deadline',e.target.value)} min={new Date().toISOString().slice(0,10)}/></div>
                <div><label className="label">EMD Amount (₹)</label><input className="input" type="number" min="0" value={form.emd_amount||0} onChange={e=>F('emd_amount',+e.target.value)}/></div>
                <div className="md:col-span-4 flex items-center gap-2 pt-1">
                  <input id="pbg" type="checkbox" className="w-4 h-4" checked={!!form.pbg_required} onChange={e=>F('pbg_required',e.target.checked?1:0)}/>
                  <label htmlFor="pbg" className="text-sm">PBG (Performance Bank Guarantee) Required</label>
                </div>
              </div>
            </>
          )}

          {/* Source + assignment */}
          <div className="border-t pt-3"><h5 className="font-bold text-sm text-red-700 mb-2">Source &amp; Assignment</h5></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {/* Source — mam (2026-06-01): "SOURCE :- INFLUCER ADD AND
                IF IT SELECT NAME DROP DOWN FROM PARTNERS".  Added
                'Influencer' to the list; partner picker reveals when
                that option is selected. */}
            <div>
              <label className="label">Source</label>
              <select className="select" value={form.source||''} onChange={e=>{
                F('source', e.target.value);
                // When source changes away from Influencer, blank the partner.
                if (e.target.value !== 'Influencer') {
                  F('influencer_id', null);
                  F('influencer_name', '');
                }
              }}>
                <option value="">Select</option>
                {SOURCE_OPTIONS.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            {form.source === 'Influencer' && (
              <div>
                <label className="label">Partner *</label>
                <SearchableSelect
                  options={influencers.map(p => ({
                    value: p.id,
                    label: p.company_name ? `${p.full_name} — ${p.company_name}` : p.full_name,
                    name: p.full_name,
                  }))}
                  value={form.influencer_id || ''}
                  valueKey="value" displayKey="label"
                  placeholder={influencers.length ? 'Pick partner…' : 'No partners in master yet'}
                  onChange={(opt) => {
                    F('influencer_id', opt?.value || null);
                    F('influencer_name', opt?.name || '');
                  }}
                />
              </div>
            )}
            <div><label className="label">SC (Sales Coordinator)</label><input className="input" value={form.assigned_sc||''} onChange={e=>F('assigned_sc',e.target.value)}/></div>
            <div>
              <label className="label">ASM (Area Sales Mgr / BD)</label>
              {/* Employee dropdown with search — same pattern as Assign
                  Meeting. Stores name (display) + user_id (for the ASM
                  dashboard so they can find their assigned leads). */}
              <SearchableSelect
                options={employees.map(e => ({
                  value: e.id,
                  label: e.name + (e.designation ? ' — ' + e.designation : ''),
                  name: e.name,
                  user_id: e.user_id,
                }))}
                value={form.assigned_asm_employee_id || ''}
                onChange={(opt) => setForm(f => ({
                  ...f,
                  assigned_asm_employee_id: opt?.value || null,
                  assigned_asm: opt?.name || '',
                  assigned_asm_id: opt?.user_id || null,
                }))}
                placeholder="Search employee..."
              />
            </div>
          </div>
          <div><label className="label">Remarks</label><textarea className="input" rows="2" value={form.remarks||''} onChange={e=>F('remarks',e.target.value)}/></div>

          <div className="flex justify-end gap-3 pt-3 border-t">
            <button type="button" onClick={()=>setModal(null)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{modal==='edit'?'Update':'Save & Assign'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
