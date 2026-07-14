import { useState, useEffect } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import ResponsibilityTab from '../components/ResponsibilityTab';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiMapPin, FiAlertTriangle, FiCheck, FiEye, FiTrash2, FiAlertCircle, FiDownload, FiCalendar, FiUsers, FiCamera, FiList } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import EngineerPerformance from '../components/EngineerPerformance';

// Mam (2026-05-30): the PO/BOQ rate is the FULL SITC value (Supply +
// Installation + Testing & Commissioning) and already includes labour.
// The DPR's Table A rate should carry only the labour portion, taken as
// 11% of the SITC rate (e.g. 1810 → 199.1). Until real labour rates are
// collected, this 11% is the agreed placeholder.
const LABOUR_RATE_PCT = 0.11;

const SYSTEMS = ['Electrical', 'Fire Fighting', 'Fire Alarm', 'CCTV', 'Access Control', 'PA System', 'Plumbing', 'HVAC', 'Solar', 'Networking', 'Combined'];

// Mam (2026-05-30): "MEPF System only :- Fire Fighting, Electrical,
// Low Voltage, Plumbing, HVAC, Solar advance radio type button".
// Tight 6-system list rendered as colour-coded chip radios instead
// of a free-form dropdown.  Each entry carries the Tailwind colour
// classes used when that chip is selected — pure CSS, no extra
// dependency.
const MEPF_SYSTEMS = [
  { key: 'Fire Fighting', icon: '🔥', sel: 'bg-red-600 text-white border-red-600',          dot: 'bg-red-500' },
  { key: 'Electrical',    icon: '⚡', sel: 'bg-yellow-500 text-white border-yellow-500',    dot: 'bg-yellow-400' },
  { key: 'Low Voltage',   icon: '📡', sel: 'bg-blue-600 text-white border-blue-600',        dot: 'bg-blue-500' },
  { key: 'Plumbing',      icon: '💧', sel: 'bg-cyan-600 text-white border-cyan-600',        dot: 'bg-cyan-500' },
  { key: 'HVAC',          icon: '❄️', sel: 'bg-indigo-600 text-white border-indigo-600',    dot: 'bg-indigo-500' },
  { key: 'Solar',         icon: '☀️', sel: 'bg-amber-500 text-white border-amber-500',      dot: 'bg-amber-400' },
];

// Mam (2026-05-30): "same radio button as weather type" — Weather
// becomes the same chip-radio shape as MEPF System.  Value stays
// lowercase (clear / rainy / …) for backward compat with existing
// DPR rows; only the display label is title-case.
const WEATHER_OPTIONS = [
  { key: 'clear',  label: 'Clear',  icon: '☀️',  sel: 'bg-yellow-500 text-white border-yellow-500', dot: 'bg-yellow-400' },
  { key: 'rainy',  label: 'Rainy',  icon: '🌧️', sel: 'bg-blue-600 text-white border-blue-600',     dot: 'bg-blue-500' },
  { key: 'cloudy', label: 'Cloudy', icon: '☁️',  sel: 'bg-gray-500 text-white border-gray-500',     dot: 'bg-gray-400' },
  { key: 'hot',    label: 'Hot',    icon: '🥵',  sel: 'bg-orange-600 text-white border-orange-600', dot: 'bg-orange-500' },
  { key: 'windy',  label: 'Windy',  icon: '💨',  sel: 'bg-teal-600 text-white border-teal-600',     dot: 'bg-teal-500' },
];
const EQUIPMENT_LIST = ['Welding Machine', 'Pipe Threading Machine', 'Drill Machine', 'Grinder', 'Ladder', 'Scaffolding', 'Pipe Bending Machine', 'Cable Pulling Machine', 'Multimeter', 'Megger', 'Earth Tester', 'Hydro Test Pump', 'Generator', 'Compressor'];

export default function DPR() {
  const { user, isAdmin, canEdit, canDelete, canApprove } = useAuth();
  const [tab, setTab] = useUrlTab('dashboard');
  const [reportFilter, setReportFilter] = useState(''); // when set by stat-card click, filters Daily Reports tab
  const [dateTouched, setDateTouched] = useState(false); // true once user explicitly picks a date
  const [summary, setSummary] = useState(null);
  const [dprs, setDprs] = useState([]);
  const [sites, setSites] = useState([]);
  const [users, setUsers] = useState([]);
  const [modal, setModal] = useState(false);
  const [siteModal, setSiteModal] = useState(false);
  const [detailModal, setDetailModal] = useState(false);

  // Weekly planning modal (mam, 2026-05-16: "i want site eng fill
  // full week planning one day fill 7 days plaaning and actual per
  // day according to that").  Site eng picks site + Monday-of-week,
  // fills 7 rows of planned work/manpower/cost in one go.  Backend
  // creates 7 dpr stub rows; daily DPR submission then updates the
  // matching row by date.
  const [planModal, setPlanModal] = useState(false);
  const [planSiteId, setPlanSiteId] = useState('');
  const [planWeekStart, setPlanWeekStart] = useState(() => {
    // Default to next Monday so today's plan stays untouched.
    const d = new Date();
    const day = d.getDay();             // 0=Sun, 1=Mon, …, 6=Sat
    const daysUntilMon = day === 0 ? 1 : (8 - day);
    d.setDate(d.getDate() + daysUntilMon);
    return d.toISOString().slice(0, 10);
  });
  const [planDays, setPlanDays] = useState([]); // 7-row array
  const [planSaving, setPlanSaving] = useState(false);
  // BOQ items for the picked site (mam, 2026-05-16: "planning giving
  // as per boq items").  Auto-fetched whenever planSiteId changes
  // so each row's "Planned Work" becomes a dropdown of real PO line
  // items + planned quantity.
  const [planBoqItems, setPlanBoqItems] = useState([]);

  // Rebuild the 7-row scaffold whenever the week-start changes.
  // Pre-loads any existing planned values via the week-view endpoint
  // so re-opening the modal shows what's already saved.
  const openPlanWeek = async (siteId, weekStartIso) => {
    setPlanSiteId(siteId || '');
    setPlanWeekStart(weekStartIso || planWeekStart);
    setPlanModal(true);
    setPlanBoqItems([]);
    // Build 7 day slots.  `items` is the per-day list of BOQ
    // line plans (multi-item, mam 2026-05-16: "in one day multiple
    // boq item have").  Each entry: { po_item_id, planned_qty }.
    const slots = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStartIso || planWeekStart);
      d.setDate(d.getDate() + i);
      const date = d.toISOString().slice(0, 10);
      slots.push({ date, planned_manpower: 0, planned_grand_total_b: 0, items: [] });
    }
    setPlanDays(slots);
    if (siteId) {
      // Load BOQ items for this site so each row can pick from them.
      try {
        const r = await api.get(`/dpr/sites/${siteId}/po-items`);
        const items = Array.isArray(r.data) ? r.data : (r.data?.items || []);
        setPlanBoqItems(items);
      } catch { setPlanBoqItems([]); }
      // Pre-fill existing planned values for the week.
      try {
        const r = await api.get('/dpr/week-view', { params: { site_id: siteId, week_start: weekStartIso || planWeekStart } });
        const byDate = Object.fromEntries((r.data?.days || []).map(d => [d.report_date, d]));
        setPlanDays(slots.map(s => {
          const existing = byDate[s.date];
          if (!existing) return s;
          return {
            date: s.date,
            planned_manpower: existing.planned_manpower || 0,
            planned_grand_total_b: existing.grand_total_b || 0,
            items: (existing.items || []).map(it => ({
              po_item_id: it.po_item_id,
              planned_qty: it.planned_qty || 0,
            })),
          };
        }));
      } catch { /* fall back to empty slots */ }
    }
  };

  // Helpers for the multi-item rows
  const addPlanItem = (dayIdx) => setPlanDays(prev => prev.map((d, i) =>
    i === dayIdx ? { ...d, items: [...(d.items || []), { po_item_id: '', planned_qty: 0 }] } : d));
  const removePlanItem = (dayIdx, itemIdx) => setPlanDays(prev => prev.map((d, i) =>
    i === dayIdx ? { ...d, items: d.items.filter((_, j) => j !== itemIdx) } : d));
  const updatePlanItem = (dayIdx, itemIdx, patch) => setPlanDays(prev => prev.map((d, i) =>
    i === dayIdx ? { ...d, items: d.items.map((it, j) => j === itemIdx ? { ...it, ...patch } : it) } : d));

  const updatePlanDay = (i, patch) => {
    setPlanDays(prev => prev.map((d, idx) => idx === i ? { ...d, ...patch } : d));
  };

  const savePlanWeek = async () => {
    if (!planSiteId) { toast.error('Pick a site first'); return; }
    setPlanSaving(true);
    try {
      const r = await api.post('/dpr/plan-week', { site_id: planSiteId, week_start: planWeekStart, days: planDays });
      toast.success(`Week plan saved · ${r.data.created} created, ${r.data.updated} updated`);
      setPlanModal(false);
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Save failed');
    } finally {
      setPlanSaving(false);
    }
  };
  const [selectedDpr, setSelectedDpr] = useState(null);
  const [viewStaff, setViewStaff] = useState(null); // attendance-filtered staff breakdown for the viewed DPR
  const [form, setForm] = useState({});
  // Table A: Installation items from PO
  const [workItems, setWorkItems] = useState([]);
  // Phase 4 (mam 2026-06-02): active Work Orders across all projects.
  // Each Table-A row can optionally pick the WO its work belongs to —
  // the dpr_work_items.work_order_id link feeds the Indent Labour
  // Payment dashboard's contractor-progress rollup.
  const [activeWorkOrders, setActiveWorkOrders] = useState([]);
  // Table B: Costs — Skilled @ Rs 800/qty, Helper @ Rs 500/qty (fixed company rates)
  // Staff Cost rate is auto-pulled from the SITE's PO engineers (sum of their
  // monthly salary / 30). Individual salaries are never exposed to the client.
  const [costs, setCosts] = useState([
    { type: 'Skilled Manpower', qty: 0, rate: 800, amount: 0, fixed: true },
    { type: 'Helper', qty: 0, rate: 500, amount: 0, fixed: true },
    { type: 'Rental Cost', qty: 0, rate: 0, amount: 0 },
    { type: 'Staff Cost', qty: 1, rate: 0, amount: 0, auto: true, engineer_count: 0 },
    { type: 'TA/DA', qty: 1, rate: 0, amount: 0, auto: true, ta_da_count: 0 },
  ]);
  const [machinery, setMachinery] = useState([{ equipment: '', quantity: 1, hours_used: 0, condition: 'working' }]);
  // Mam: 'AT LEAST OPTION OF 5 CONTRACTOR' — start with 5 blank rows; "+ Add"
  // appends more, "×" removes (only when more than 5). Empty rows are
  // dropped server-side so we never save junk.
  const [contractors, setContractors] = useState(() => [{ name: '', manpower: 0 }]);
  // Morning Manpower punch (mam 2026-06-22): site engineer records contractor
  // attendance in the morning; it pre-fills the DPR "Contractors on Site".
  const [mmModal, setMmModal] = useState(false);
  const [mmSite, setMmSite] = useState('');
  const [mmDate, setMmDate] = useState(new Date().toISOString().split('T')[0]);
  const [mmRows, setMmRows] = useState([{ name: '', manpower: 0, subcontractor_id: null, contractor_type: '' }]);
  const [mmBusy, setMmBusy] = useState(false);
  // Attendance Records view (mam 2026-06-24) — a register of all saved
  // morning-manpower across sites/dates.
  const [mmRecModal, setMmRecModal] = useState(false);
  const [mmRecRows, setMmRecRows] = useState([]);
  const [mmRecBusy, setMmRecBusy] = useState(false);
  const [mmRecSite, setMmRecSite] = useState('');
  const [mmRecFrom, setMmRecFrom] = useState('');
  const [mmRecTo, setMmRecTo] = useState('');
  const [filterDate, setFilterDate] = useState(new Date().toISOString().split('T')[0]);
  const [poItemsForSite, setPoItemsForSite] = useState([]);
  // Server-side diagnostic when po_items can't be fetched (no BB, no
  // items, or rates not set). Surfaced as a yellow banner above the
  // work items grid so mam knows exactly what to fix.
  const [poItemsDiag, setPoItemsDiag] = useState(null);
  // Sub-contractor master list for the DPR contractor-name picker.
  // Mam (2026-05-30): "contractor name drop down from master sub-
  // contactor".  Lazy-loaded the first time the DPR submit modal opens
  // (engineers won't hit the lookup endpoint while just browsing DPRs).
  const [subcons, setSubcons] = useState([]);
  const [progress, setProgress] = useState([]);
  const [expandedSite, setExpandedSite] = useState({}); // { "engineerId-siteId": true }
  // Progress widget grouping — 'engineer' (default) or 'site'. Mam
  // (2026-05-30): "not particular user name wise — set here site name of
  // completion." Site view dedupes the same site shown under multiple
  // engineers and lists each site once with its completion.
  const [progressView, setProgressView] = useState('engineer');

  // Mam (2026-05-29): "erp is hange make it lite".  The page used to
  // fire ALL FIVE endpoints in parallel on mount AND block the whole
  // page on `if (!summary) Loading...` until the slowest one (the
  // BOQ-progress widget — N×M×K SUM queries) returned.  Now each tab
  // fetches only what it needs, and load() refreshes only the slices
  // already in scope so submit/approve/delete actions don't re-fire
  // dormant tabs.
  const loadSummary  = () => api.get('/dpr/summary').then(r => setSummary(r.data)).catch(() => {});
  const loadSites    = () => api.get('/dpr/sites').then(r => setSites(r.data)).catch(() => {});
  const loadUsers    = () => api.get('/auth/users?active_only=1').then(r => setUsers(r.data)).catch(() => {});
  const loadDprs     = () => {
    const params = (reportFilter && !dateTouched) ? {} : { date: filterDate };
    return api.get('/dpr', { params }).then(r => setDprs(r.data)).catch(() => {});
  };
  const loadProgress = () => api.get('/dpr/progress').then(r => setProgress(r.data)).catch(() => setProgress([]));

  // Refresh whatever is already on screen.  Called after submit /
  // approve / delete actions.  Doesn't pull dormant tabs into scope.
  const load = () => {
    loadSummary();
    loadSites();              // always needed: site picker in submit modal
    loadUsers();               // always needed: engineer picker in site modal
    if (tab === 'reports' || dprs.length)   loadDprs();
    if (tab === 'dashboard' || progress.length) loadProgress();
  };
  // Mount: pull only the always-needed bits (summary tiles + sites
  // picker + users for the Site modal) so the page paints instantly.
  // Heavy slices (BOQ progress, DPR list) come in via the tab-change
  // effect below — only when that tab is actually opened.
  useEffect(() => {
    loadSummary();
    loadSites();
    loadUsers();
    // Phase 4 — load active Work Orders once on mount so the work-item
    // picker has data the first time mam expands the submit modal.
    // Best-effort fetch: if mam doesn't have indent_labour_payment.view
    // permission, the catch silently falls back to an empty list (the
    // WO picker simply doesn't render — DPR still saves as before).
    api.get('/indent-labour-payment/active-work-orders')
      .then(r => setActiveWorkOrders(r.data || []))
      .catch(() => setActiveWorkOrders([]));
  }, []);

  // DPR list refetches whenever the date / status filter changes — but
  // ONLY if the user is on (or has visited) the Daily Reports tab.
  useEffect(() => {
    if (tab === 'reports' || dprs.length) loadDprs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterDate, reportFilter, dateTouched, tab]);

  // Heavy BOQ-progress widget loads only when the dashboard tab is
  // active (and once loaded, refreshes on subsequent dashboard visits
  // via the same effect re-firing).  This is the single biggest
  // reason the page used to hang at "Loading...".
  useEffect(() => {
    if (tab === 'dashboard' && progress.length === 0) loadProgress();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Auto-pull Staff Cost by NAME, attendance-filtered for the report date (mam
  // 2026-06-30). Keyed on site + date so it refreshes when either changes — staff
  // who didn't mark attendance that day are dropped from the cost.
  useEffect(() => {
    const siteId = form.site_id; const scDate = form.report_date || filterDate || '';
    if (!siteId) return;
    api.get(`/dpr/sites/${siteId}/staff-cost`, { params: scDate ? { date: scDate } : {} }).then(r => {
      const { per_day_cost = 0, engineer_count = 0, po_engineers = 0, diagnostic = null, staff = [] } = r.data || {};
      setCosts(prev => prev.map(c => c.type === 'Staff Cost'
        ? { ...c, rate: per_day_cost, engineer_count, po_engineers, auto: per_day_cost > 0, diagnostic, staff, amount: (c.qty || 0) * per_day_cost }
        : c));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.site_id, form.report_date]);

  const handleSiteSelect = (siteId) => {
    setForm(f => ({ ...f, site_id: siteId }));
    setWorkItems([]);
    if (siteId) {
      // Response is now { items, diagnostic, total_count } — older format
      // was a bare array. Handle both for robustness.
      api.get(`/dpr/sites/${siteId}/po-items`).then(r => {
        if (Array.isArray(r.data)) {
          setPoItemsForSite(r.data);
          setPoItemsDiag(null);
        } else {
          setPoItemsForSite(r.data?.items || []);
          setPoItemsDiag(r.data?.diagnostic || null);
        }
      }).catch(() => { setPoItemsForSite([]); setPoItemsDiag(null); });
      // Staff Cost is auto-pulled in a dedicated effect keyed on site + date, so
      // it refreshes when the report date changes (attendance differs per day).
      // Auto-fill TA/DA from approved payment_requests for this site (mam:
      // 'according to site TA/DA that site show here automatically which we
      // fill in payment category TA/DA only'). Engineer can still edit if
      // the figure is wrong.
      api.get(`/dpr/sites/${siteId}/ta-da-cost`).then(r => {
        const { total_amount = 0, count = 0 } = r.data || {};
        setCosts(prev => prev.map(c => c.type === 'TA/DA'
          ? { ...c, qty: 1, rate: total_amount, amount: total_amount, auto: total_amount > 0, ta_da_count: count }
          : c));
      }).catch(() => {});
      // Pre-fill "Contractors on Site" from the morning manpower punch for this
      // site + date (mam 2026-06-22). Only fills when the engineer hasn't already
      // typed contractors, so it never clobbers in-progress edits.
      api.get('/dpr/contractor-attendance', { params: { site_id: siteId, date: form.report_date || filterDate } })
        .then(r => {
          const rows = r.data || [];
          if (!rows.length) return;
          setContractors(prev => (prev.some(c => c.name && c.name.trim())
            ? prev
            : rows.map(x => ({ name: x.contractor_name, manpower: x.manpower }))));
        }).catch(() => {});
    } else { setPoItemsForSite([]); setPoItemsDiag(null); }
  };

  // ── Morning Manpower (contractor attendance) handlers ──────────────────
  const loadMorningManpower = (siteId, date) => {
    if (!siteId || !date) { setMmRows([{ name: '', manpower: 0 }]); return; }
    api.get('/dpr/contractor-attendance', { params: { site_id: siteId, date } })
      .then(r => {
        const rows = r.data || [];
        setMmRows(rows.length
          ? rows.map(x => ({ name: x.contractor_name, manpower: x.manpower, subcontractor_id: x.subcontractor_id, contractor_type: x.contractor_type, photo_url: x.photo_url }))
          : [{ name: '', manpower: 0 }]);
      }).catch(() => setMmRows([{ name: '', manpower: 0 }]));
  };
  const openMorningManpower = () => {
    const site = form.site_id || '';
    setMmSite(site);
    setMmDate(filterDate);
    if (subcons.length === 0) api.get('/sub-contractors/lookup').then(r => setSubcons(r.data || [])).catch(() => {});
    loadMorningManpower(site, filterDate);
    setMmModal(true);
  };
  // Upload a contractor's gang photo and let AI count the people → manpower.
  const countFromPhoto = async (i, file) => {
    if (!file) return;
    const setRow = (patch) => setMmRows(rows => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setRow({ counting: true });
    try {
      const fd = new FormData(); fd.append('file', file);
      const up = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const photo_url = up.data.url;
      setRow({ photo_url });
      const r = await api.post('/dpr/contractor-attendance/count-photo', { photo_url });
      setRow({ manpower: r.data.count, counting: false });
      toast.success(`AI counted ${r.data.count} people from the photo`);
    } catch (e) {
      setRow({ counting: false });
      toast.error(e.response?.data?.error || 'Photo head-count failed');
    }
  };
  const saveMorningManpower = async () => {
    if (!mmSite) return toast.error('Pick a site');
    if (!mmDate) return toast.error('Pick a date');
    setMmBusy(true);
    try {
      const rows = mmRows
        .filter(r => r.name && r.name.trim())
        .map(r => ({ contractor_name: r.name.trim(), manpower: +r.manpower || 0, subcontractor_id: r.subcontractor_id || null, contractor_type: r.contractor_type || null, photo_url: r.photo_url || null }));
      await api.post('/dpr/contractor-attendance', { site_id: mmSite, date: mmDate, rows });
      const total = rows.reduce((s, r) => s + (+r.manpower || 0), 0);
      toast.success(`Morning manpower saved — ${rows.length} contractor(s), ${total} manpower`);
      setMmModal(false);
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to save'); }
    finally { setMmBusy(false); }
  };
  // Load the saved contractor-attendance register (optionally filtered).
  const loadAttendanceRecords = (filters = {}) => {
    setMmRecBusy(true);
    const params = {};
    const site = 'site' in filters ? filters.site : mmRecSite;
    const from = 'from' in filters ? filters.from : mmRecFrom;
    const to = 'to' in filters ? filters.to : mmRecTo;
    if (site) params.site_id = site;
    if (from) params.from = from;
    if (to) params.to = to;
    api.get('/dpr/contractor-attendance/records', { params })
      .then(r => setMmRecRows(r.data || []))
      .catch(() => setMmRecRows([]))
      .finally(() => setMmRecBusy(false));
  };
  const openAttendanceRecords = () => { setMmRecModal(true); loadAttendanceRecords({ site: '', from: '', to: '' }); };

  const addWorkItem = () => setWorkItems([...workItems, { po_item_id: '', description: '', qty: 0, location: '', rate: 0, amount: 0 }]);
  const removeWorkItem = (i) => setWorkItems(workItems.filter((_, idx) => idx !== i));
  const selectWorkItem = (i, poItemId) => {
    const item = poItemsForSite.find(p => p.id === +poItemId);
    const n = [...workItems];
    n[i].po_item_id = +poItemId || '';
    n[i].description = item?.description || '';
    n[i].unit = item?.unit || 'nos';
    n[i].boq_qty = item?.quantity || 0;
    n[i].remaining_qty = item?.remaining_qty ?? item?.quantity ?? 0;
    n[i].filled_qty = item?.filled_qty || 0;
    // Auto-fill the DPR rate from the PO item. The PO rate is the full
    // SITC value (incl. labour); the DPR carries only the labour portion
    // = 11% of SITC (LABOUR_RATE_PCT). Keep the original SITC on the row
    // so the UI can show "11% of SITC ₹X". Rate can still be overridden.
    if (item) {
      const sitc = +item.rate || 0;
      n[i].sitc_rate = sitc;
      n[i].rate = Math.round(sitc * LABOUR_RATE_PCT * 100) / 100;
      n[i].amount = (+n[i].qty || 0) * n[i].rate;
    }
    setWorkItems(n);
  };
  const updateWork = (i, field, val) => {
    const n = [...workItems];
    n[i][field] = val;
    if (field === 'qty' || field === 'rate') n[i].amount = (n[i].qty || 0) * (n[i].rate || 0);
    setWorkItems(n);
  };
  const updateCost = (i, field, val) => {
    const n = [...costs];
    // Block manual rate edits on fixed-rate rows (Skilled 800, Helper 500)
    if (field === 'rate' && n[i].fixed) return;
    n[i][field] = val;
    if (field === 'qty' || field === 'rate') n[i].amount = (n[i].qty || 0) * (n[i].rate || 0);
    setCosts(n);
  };

  const grandTotalA = workItems.reduce((s, w) => s + (w.amount || 0), 0);
  const grandTotalB = costs.reduce((s, c) => s + (c.amount || 0), 0);
  const profitLoss = grandTotalA - grandTotalB;

  // Render one expandable site row (BOQ vs DPR-consumed). Shared by the
  // engineer-grouped view and the site-name view so both stay in sync.
  // `key` is the unique expand-state key; `subLabel` (optional) shows the
  // assigned engineer(s) in the site view.
  const renderSiteRow = (site, key, subLabel) => {
    const expanded = !!expandedSite[key];
    const barColor = site.overall_pct >= 90 ? 'bg-emerald-500' : site.overall_pct >= 50 ? 'bg-red-500' : site.overall_pct >= 20 ? 'bg-amber-500' : 'bg-red-400';
    return (
      <div key={key}>
        <button
          type="button"
          onClick={() => setExpandedSite(s => ({ ...s, [key]: !s[key] }))}
          className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-50 text-left"
        >
          <span className="text-gray-400 text-xs">{expanded ? '▼' : '▶'}</span>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-sm truncate">{site.site_name}</div>
            <div className="text-[11px] text-gray-500 truncate">{site.client_name || ''} · {site.item_count} BOQ items{subLabel ? ` · 👷 ${subLabel}` : ''}</div>
          </div>
          <div className="hidden md:block w-40">
            <div className="h-2.5 bg-gray-200 rounded-full overflow-hidden">
              <div className={`h-full ${barColor} transition-all`} style={{ width: `${Math.min(100, site.overall_pct)}%` }} />
            </div>
            <div className="text-[10px] text-gray-500 text-right mt-0.5">
              Rs {site.total_done_amount.toLocaleString()} / Rs {site.total_boq_amount.toLocaleString()}
            </div>
          </div>
          <div className="w-16 text-right">
            <span className={`text-base font-bold ${site.overall_pct >= 90 ? 'text-emerald-600' : site.overall_pct >= 50 ? 'text-red-600' : site.overall_pct >= 20 ? 'text-amber-600' : 'text-red-500'}`}>
              {site.overall_pct}%
            </span>
          </div>
        </button>
        {expanded && (
          <div className="bg-gray-50/60 px-3 py-2">
            {site.items.length === 0 ? (
              <p className="text-xs text-gray-400 py-2">No BOQ items linked to this site yet</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b">
                      <th className="px-2 py-1.5 text-left">BOQ Item</th>
                      <th className="px-2 py-1.5 text-center">Unit</th>
                      <th className="px-2 py-1.5 text-right">BOQ Qty</th>
                      <th className="px-2 py-1.5 text-right">Done</th>
                      <th className="px-2 py-1.5 text-right">Remaining</th>
                      <th className="px-2 py-1.5 text-left w-36">Progress</th>
                      <th className="px-2 py-1.5 text-right">%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {site.items.map(it => {
                      const ib = it.pct_complete >= 100 ? 'bg-emerald-500' : it.pct_complete >= 50 ? 'bg-red-500' : it.pct_complete >= 20 ? 'bg-amber-500' : 'bg-red-400';
                      return (
                        <tr key={it.po_item_id} className="border-b last:border-0 hover:bg-white">
                          <td className="px-2 py-1 whitespace-normal break-words leading-snug max-w-md">{it.description}</td>
                          <td className="px-2 py-1 text-center text-gray-500">{it.unit || '-'}</td>
                          <td className="px-2 py-1 text-right font-mono">{it.boq_qty}</td>
                          <td className="px-2 py-1 text-right font-mono text-emerald-700 font-semibold">{it.done_qty}</td>
                          <td className="px-2 py-1 text-right font-mono text-red-600">{it.remaining_qty}</td>
                          <td className="px-2 py-1">
                            <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                              <div className={`h-full ${ib}`} style={{ width: `${Math.min(100, it.pct_complete)}%` }} />
                            </div>
                          </td>
                          <td className="px-2 py-1 text-right font-semibold">{it.pct_complete}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // Flatten engineer→sites into a deduped site-name list for the "By Site"
  // view. The same site shown under several engineers collapses to one row
  // (identical completion); we collect the engineer name(s) for the label.
  const siteRowsByName = (() => {
    const m = new Map();
    for (const eng of progress) {
      for (const site of (eng.sites || [])) {
        const k = site.site_name;
        if (!m.has(k)) m.set(k, { site, engineers: new Set() });
        if (eng.engineer?.name) m.get(k).engineers.add(eng.engineer.name);
      }
    }
    return [...m.values()]
      .map(({ site, engineers }) => ({ ...site, engineerNames: [...engineers].join(', ') }))
      .sort((a, b) => a.site_name.localeCompare(b.site_name));
  })();

  const submitDpr = async (e) => {
    e.preventDefault();
    try {
      await api.post('/dpr', {
        ...form,
        work_items: workItems.filter(w => w.po_item_id || w.description),
        manpower: costs.filter(c => c.qty > 0 || c.amount > 0),
        machinery: machinery.filter(m => m.equipment),
        contractors: contractors.filter(c => (c.name && c.name.trim()) || c.manpower > 0),
        grand_total_a: grandTotalA,
        grand_total_b: grandTotalB,
        profit_loss: profitLoss
      });
      toast.success('DPR submitted!'); setModal(false); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Error'); }
  };

  const createSite = async (e) => { e.preventDefault(); await api.post('/dpr/sites', form); toast.success('Site created'); setSiteModal(false); load(); };
  const approveDpr = async (id, status, billingReady) => { await api.put(`/dpr/${id}/approve`, { approval_status: status, billing_ready: billingReady }); toast.success(`DPR ${status}`); load(); };
  const viewDpr = async (id) => {
    setViewStaff(null);
    const { data } = await api.get(`/dpr/${id}`);
    setSelectedDpr(data); setDetailModal(true);
    // Recompute the staff cost by name, attendance-filtered for this DPR's date,
    // so old + new DPRs both show who was counted (mam 2026-06-30).
    if (data?.site_id) {
      api.get(`/dpr/sites/${data.site_id}/staff-cost`, { params: data.report_date ? { date: data.report_date } : {} })
        .then(r => setViewStaff(r.data || null)).catch(() => setViewStaff(null));
    }
  };

  // Mam (2026-05-29): we used to gate the WHOLE page on `summary`
  // here — meaning the toolbar didn't even render until /dpr/summary
  // returned.  Now we paint immediately and the Dashboard tab below
  // shows a thin skeleton while summary loads.

  return (
    <div className="space-y-6">
      <div className="sticky-toolbar">
        <div className="flex gap-2 flex-wrap">
          {['dashboard', 'reports', 'compliance', 'sites', 'losses', 'responsible'].map(t => (
            <button key={t} onClick={() => setTab(t)} className={`btn ${tab === t ? 'btn-primary' : 'btn-secondary'}`}>
              {t === 'dashboard' ? 'Dashboard'
                : t === 'reports' ? 'Daily Reports'
                : t === 'compliance' ? 'Engineer Compliance'
                : t === 'sites' ? 'Sites'
                : t === 'losses' ? 'Loss Reasons'
                : 'Responsible'}
            </button>
          ))}
          {/* Always-visible morning contractor-attendance punch (mam 2026-06-22:
              "where is attendance of contractor" — was hidden on the Reports tab). */}
          <button onClick={openMorningManpower}
            className="btn btn-secondary flex items-center gap-2 ml-auto"
            title="Record contractor manpower attendance (morning punch)">
            <FiUsers /> Contractor Attendance
          </button>
        </div>
      </div>

      {/* Mam (2026-05-30): keep Engineer Compliance HERE in Daily
          Reports AND under HR System → Performance.  Same shared
          component drives both — single source of truth. */}
      {tab === 'losses' && <LossReasonsTab />}
      {tab === 'compliance' && <EngineerPerformance />}
      {tab === 'responsible' && <ResponsibilityTab module="dpr" title="DPR" />}

      {tab === 'dashboard' && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <button type="button" onClick={() => { setReportFilter(''); setTab('sites'); }}
              className="card text-center border-l-4 border-red-500 text-left hover:shadow-md transition-shadow cursor-pointer">
              <div className="text-3xl font-bold text-red-600">{summary ? summary.activeSites : '—'}</div>
              <div className="text-sm text-gray-500">Active Sites <span className="text-[10px] text-red-600 font-semibold">→ view</span></div>
            </button>
            <button type="button" onClick={() => { setFilterDate(new Date().toISOString().split('T')[0]); setDateTouched(true); setReportFilter(''); setTab('reports'); }}
              className="card text-center border-l-4 border-emerald-500 text-left hover:shadow-md transition-shadow cursor-pointer">
              <div className="text-3xl font-bold text-emerald-600">{summary ? summary.todaySubmissions : '—'}</div>
              <div className="text-sm text-gray-500">DPR Today <span className="text-[10px] text-emerald-600 font-semibold">→ view</span></div>
            </button>
            <button type="button" onClick={() => { setDateTouched(false); setReportFilter('pending'); setTab('reports'); }}
              className="card text-center border-l-4 border-amber-500 text-left hover:shadow-md transition-shadow cursor-pointer">
              <div className="text-3xl font-bold text-amber-600">{summary ? summary.pendingApproval : '—'}</div>
              <div className="text-sm text-gray-500">Pending Approval <span className="text-[10px] text-amber-600 font-semibold">→ view</span></div>
            </button>
            <button type="button" onClick={() => { setDateTouched(false); setReportFilter('billing'); setTab('reports'); }}
              className="card text-center border-l-4 border-purple-500 text-left hover:shadow-md transition-shadow cursor-pointer">
              <div className="text-3xl font-bold text-purple-600">{summary ? summary.billingReady : '—'}</div>
              <div className="text-sm text-gray-500">Billing Ready <span className="text-[10px] text-purple-600 font-semibold">→ view</span></div>
            </button>
          </div>
          {summary && summary.missingSites.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2"><FiAlertTriangle className="text-red-600" size={20} /><h4 className="font-bold text-red-700">NO DPR - Payment Blocked!</h4></div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">{summary.missingSites.map(s => (
                <div key={s.id} className="bg-white border border-red-300 rounded-lg p-3 flex items-center gap-2"><FiMapPin className="text-red-500" /><div><div className="font-medium text-sm">{s.name}</div><div className="text-xs text-gray-500">{s.supervisor || 'N/A'}</div></div></div>
              ))}</div>
            </div>
          )}
          {summary && summary.missingSites.length === 0 && summary.activeSites > 0 && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-center gap-3"><FiCheck className="text-emerald-600" size={24} /><h4 className="font-bold text-emerald-700">All sites submitted DPR today!</h4></div>
          )}
          {!summary && (
            <div className="text-center py-4 text-gray-400 text-sm">Loading dashboard summary…</div>
          )}

          {/* BOQ vs DPR-consumed progress, grouped by engineer → site → item */}
          <div className="card p-0 overflow-x-auto">
            <div className="bg-gradient-to-r from-blue-700 to-blue-800 text-white px-4 py-3 flex items-start justify-between gap-3 flex-wrap">
              <div>
                <h3 className="font-bold text-base">{progressView === 'site' ? 'Site Progress' : 'Engineer Progress'} — BOQ vs DPR Consumed</h3>
                <p className="text-xs text-blue-100">
                  {progressView === 'site'
                    ? 'Per site, per BOQ item. Each site listed once.'
                    : 'Per engineer, per site, per BOQ item. Incomplete items first.'}
                  {!isAdmin() && ' Showing only your sites.'}
                </p>
              </div>
              {/* Group-by toggle — mam: site-name-wise completion view */}
              <div className="flex rounded-lg overflow-hidden border border-white/30 text-xs flex-shrink-0">
                <button onClick={() => setProgressView('engineer')}
                  className={`px-3 py-1 font-semibold ${progressView === 'engineer' ? 'bg-white text-blue-700' : 'bg-transparent text-white hover:bg-white/10'}`}>By Engineer</button>
                <button onClick={() => setProgressView('site')}
                  className={`px-3 py-1 font-semibold ${progressView === 'site' ? 'bg-white text-blue-700' : 'bg-transparent text-white hover:bg-white/10'}`}>By Site</button>
              </div>
            </div>
            <div className="p-3 space-y-3">
              {progress.length === 0 && (
                <div className="text-center py-6 text-gray-400 text-sm">No sites assigned yet</div>
              )}

              {/* BY SITE — each site listed once with its completion; the
                  assigned engineer(s) show as a sub-label. */}
              {progressView === 'site' && progress.length > 0 && (
                siteRowsByName.length === 0
                  ? <div className="text-center py-6 text-gray-400 text-sm">No sites assigned yet</div>
                  : <div className="border rounded-lg overflow-hidden divide-y">
                      {siteRowsByName.map(site => renderSiteRow(site, `site-${site.site_name}`, site.engineerNames))}
                    </div>
              )}

              {/* BY ENGINEER — engineer → their sites */}
              {progressView === 'engineer' && progress.map(eng => {
                const engBoq = eng.sites.reduce((s, x) => s + (x.total_boq_amount || 0), 0);
                const engDone = eng.sites.reduce((s, x) => s + (x.total_done_amount || 0), 0);
                const engPct = engBoq > 0 ? Math.round((engDone / engBoq) * 1000) / 10 : 0;
                const engColor = engPct >= 90 ? 'text-emerald-600' : engPct >= 50 ? 'text-red-600' : engPct >= 20 ? 'text-amber-600' : 'text-red-500';
                const engBar = engPct >= 90 ? 'bg-emerald-500' : engPct >= 50 ? 'bg-red-500' : engPct >= 20 ? 'bg-amber-500' : 'bg-red-400';
                return (
                <div key={eng.engineer.id} className="border rounded-lg overflow-hidden">
                  <div className="bg-gradient-to-r from-blue-50 to-blue-50 px-3 py-2 border-b flex justify-between items-center gap-3">
                    <div className="min-w-0">
                      <div className="font-bold text-sm text-gray-800">{eng.engineer.name}</div>
                      <div className="text-[11px] text-gray-500 truncate">{eng.engineer.email} · {eng.site_count} site{eng.site_count === 1 ? '' : 's'}</div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <div className="hidden sm:block w-36">
                        <div className="h-2 bg-white/60 rounded-full overflow-hidden">
                          <div className={`h-full ${engBar}`} style={{ width: `${Math.min(100, engPct)}%` }} />
                        </div>
                        <div className="text-[10px] text-gray-500 text-right mt-0.5">Rs {engDone.toLocaleString()} / {engBoq.toLocaleString()}</div>
                      </div>
                      <div className="text-right">
                        <div className={`text-xl font-extrabold ${engColor}`}>{engPct}%</div>
                        <div className="text-[9px] uppercase text-gray-400 tracking-wider">completion</div>
                      </div>
                    </div>
                  </div>
                  {eng.sites.length === 0 ? (
                    <p className="p-3 text-xs text-gray-400">No sites assigned</p>
                  ) : (
                    <div className="divide-y">
                      {eng.sites.map(site => renderSiteRow(site, `${eng.engineer.id}-${site.site_id}`))}
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {tab === 'reports' && (
        <>
          {reportFilter && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700 flex items-center justify-between">
              <span>Filtered: <b>{reportFilter === 'pending' ? 'Pending Approval' : reportFilter === 'billing' ? 'Billing Ready' : reportFilter}</b> <span className="text-[10px] text-red-500 font-normal">· any date (pick a date below to narrow)</span></span>
              <button type="button" onClick={() => setReportFilter('')} className="text-red-600 hover:underline">Clear filter</button>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <input type="date" className="input w-48" value={filterDate} onChange={e => { setFilterDate(e.target.value); setDateTouched(true); }} />
            <div className="flex gap-2">
              <button onClick={() => exportCsv('dpr-reports',
                ['Site','Date','By','Status','Plan Cost (B-plan)','Actual Cost (B-actual)','Actual Total (A)','Variance (B-act − B-plan)','Approval'],
                dprs.map(d => {
                  const planned = !!d.is_planned_template;
                  const planB = +d.planned_cost_b || 0;
                  const actB = planned ? '' : (+d.grand_total_b || 0);
                  const actA = planned ? '' : (+d.grand_total_a || 0);
                  const variance = (!planned && planB > 0) ? ((+d.grand_total_b || 0) - planB) : '';
                  return [
                    d.site_name, d.report_date, d.submitted_by_name,
                    planned ? 'PLANNED' : 'SUBMITTED',
                    planB || '', actB, actA, variance,
                    planned ? '' : d.approval_status,
                  ];
                }))}
                className="btn btn-secondary flex items-center gap-2"><FiDownload /> Export Excel</button>
              {/* Weekly planning entry-point (mam, 2026-05-16). Pre-fills
                  default site = the one in the daily form's site_id if
                  picked, else empty.  Default week-start = next Monday
                  so site eng files NEXT week's plan, not the current
                  one in flight. */}
              <button onClick={() => openPlanWeek(form.site_id || '', planWeekStart)}
                className="btn btn-secondary flex items-center gap-2"><FiCalendar /> Plan Week</button>
              {/* Morning Manpower — contractor attendance punch (mam 2026-06-22) */}
              <button onClick={openMorningManpower}
                className="btn btn-secondary flex items-center gap-2"><FiUsers /> Morning Manpower</button>
              {/* Attendance Records — register of all saved morning manpower (mam 2026-06-24) */}
              <button onClick={openAttendanceRecords}
                className="btn btn-secondary flex items-center gap-2"><FiList /> Attendance Records</button>
              <button onClick={() => {
                setForm({ site_id: '', report_date: filterDate, weather: 'clear', overall_status: 'on_track', system_type: '', shift: 'day', contractor_name: '', contractor_manpower: 0, mb_sheet_no: '', safety_toolbox_talk: false, safety_ppe_compliance: false, safety_incidents: '', next_day_plan: '', hindrances: '', hindrance_category: '', remarks: '' });
                setWorkItems([]); setPoItemsForSite([]);
                setCosts([
                  { type: 'Skilled Manpower', qty: 0, rate: 800, amount: 0, fixed: true },
                  { type: 'Helper', qty: 0, rate: 500, amount: 0, fixed: true },
                  { type: 'Rental Cost', qty: 0, rate: 0, amount: 0 },
                  { type: 'Staff Cost', qty: 1, rate: 0, amount: 0, auto: true, engineer_count: 0 },
                  { type: 'TA/DA', qty: 1, rate: 0, amount: 0, auto: true, ta_da_count: 0 },
                ]);
                setMachinery([{ equipment: '', quantity: 1, hours_used: 0, condition: 'working' }]);
                setContractors([{ name: '', manpower: 0 }]);
                // Lazy-fetch the sub-contractor master so the contractor
                // dropdown lands populated.  Cached after first open.
                if (subcons.length === 0) {
                  api.get('/sub-contractors/lookup').then(r => setSubcons(r.data || [])).catch(() => {});
                }
                setModal(true);
              }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Submit DPR</button>
            </div>
          </div>
          {/* ─── MOBILE CARDS ───────────────────────────────────────
              Mam (2026-06-02): phone version of the Daily Reports
              table.  Same data, stacked card per DPR — keeps the
              key money columns (Plan / Actual / Variance) visible
              without horizontal scroll. */}
          <div className="md:hidden space-y-3">
            {dprs
              .filter(d => {
                if (!reportFilter) return true;
                if (reportFilter === 'pending') return d.approval_status === 'pending';
                if (reportFilter === 'billing') return d.billing_ready === 1 || d.billing_ready === true;
                return true;
              })
              .map(d => {
                const planned = !!d.is_planned_template;
                const planB = +d.planned_cost_b || 0;
                const actB = +d.grand_total_b || 0;
                const actA = +d.grand_total_a || 0;
                const hasPlan = planB > 0;
                const variance = (!planned && hasPlan) ? (actB - planB) : null;
                return (
                  <div key={d.id} className="card p-3 space-y-2">
                    <div className="flex justify-between items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">DPR</div>
                        <div className="text-base font-bold text-gray-900 truncate">{d.site_name}</div>
                        <div className="text-[11px] text-gray-500">{d.report_date} · {d.submitted_by_name || '—'}</div>
                      </div>
                      {planned
                        ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200"><FiCalendar size={10}/> PLANNED</span>
                        : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">✓ SUBMITTED</span>}
                    </div>
                    {!planned && (
                      <div className="grid grid-cols-3 gap-1 text-center pt-1 border-t border-gray-100">
                        <div>
                          <div className="text-[9px] uppercase text-gray-400">Plan B</div>
                          <div className="text-xs font-bold text-sky-700">{hasPlan ? `₹${Math.round(planB/1000)}K` : '—'}</div>
                        </div>
                        <div>
                          <div className="text-[9px] uppercase text-gray-400">Actual B</div>
                          <div className="text-xs font-bold text-red-600">{`₹${Math.round(actB/1000)}K`}</div>
                        </div>
                        <div>
                          <div className="text-[9px] uppercase text-gray-400">Revenue A</div>
                          <div className="text-xs font-bold text-emerald-600">{`₹${Math.round(actA/1000)}K`}</div>
                        </div>
                      </div>
                    )}
                    {variance !== null && (
                      <div className={`text-[11px] text-center py-1 rounded ${variance > 0 ? 'bg-red-50 text-red-700' : variance < 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-50 text-gray-500'}`}>
                        Variance: <strong>{variance > 0 ? '+' : variance < 0 ? '−' : ''}₹{Math.abs(variance).toLocaleString()}</strong>
                      </div>
                    )}
                    <div className="flex justify-between items-center pt-1 border-t border-gray-100">
                      {!planned ? <StatusBadge status={d.approval_status} /> : <span className="text-[10px] text-gray-400">plan template</span>}
                      <div className="flex gap-1">
                        <button onClick={() => viewDpr(d.id)} className="p-1 hover:bg-red-50 rounded text-red-600"><FiEye size={14} /></button>
                        {!planned && d.approval_status === 'pending' && canApprove('dpr') && <>
                          <button onClick={() => approveDpr(d.id, 'approved', true)} className="btn btn-success text-[10px] py-0.5 px-1.5">Approve+Bill</button>
                          <button onClick={() => approveDpr(d.id, 'rejected', false)} className="btn btn-danger text-[10px] py-0.5 px-1.5">Reject</button>
                        </>}
                        {canDelete('dpr') && <button onClick={async () => {
                          if (!confirm(`Delete DPR for "${d.site_name}" on ${d.report_date}?`)) return;
                          try { await api.delete(`/dpr/${d.id}`); toast.success('Deleted'); load(); }
                          catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                        }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}
                      </div>
                    </div>
                  </div>
                );
              })}
            {dprs.length === 0 && <div className="card p-6 text-center text-gray-400 text-sm">No DPR for this date</div>}
          </div>

          {/* ─── DESKTOP TABLE (md+) ───────────────────────────────── */}
          <div className="hidden md:block card p-0"><table className="freeze-head">
            <thead><tr>
              <th>Site</th><th>Date</th><th>By</th><th>Status</th>
              <th>Plan Cost<div className="text-[10px] font-normal text-gray-400">(B-plan)</div></th>
              <th>Actual Cost<div className="text-[10px] font-normal text-gray-400">(B-actual)</div></th>
              <th>Actual Total(A)<div className="text-[10px] font-normal text-gray-400">(revenue)</div></th>
              <th>Variance<div className="text-[10px] font-normal text-gray-400">(B-act − B-plan)</div></th>
              <th>Approval</th><th>Actions</th>
            </tr></thead>
            <tbody>
              {dprs
                .filter(d => {
                  if (!reportFilter) return true;
                  if (reportFilter === 'pending') return d.approval_status === 'pending';
                  if (reportFilter === 'billing') return d.billing_ready === 1 || d.billing_ready === true;
                  return true;
                })
                .map(d => {
                  const planned = !!d.is_planned_template;
                  const planB = +d.planned_cost_b || 0;
                  const actB = +d.grand_total_b || 0;
                  const actA = +d.grand_total_a || 0;
                  const hasPlan = planB > 0;
                  const variance = (!planned && hasPlan) ? (actB - planB) : null;
                  return (
                <tr key={d.id}>
                  <td className="font-medium">{d.site_name}</td>
                  <td>{d.report_date}</td>
                  <td>{d.submitted_by_name}</td>
                  <td>
                    {planned
                      ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200"><FiCalendar size={10}/> PLANNED</span>
                      : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">✓ SUBMITTED</span>}
                  </td>
                  <td className="font-semibold text-sky-700 text-sm">{hasPlan ? `Rs ${planB.toLocaleString()}` : <span className="text-gray-300">—</span>}</td>
                  <td className="font-semibold text-red-600 text-sm">{planned ? <span className="text-gray-300">—</span> : `Rs ${actB.toLocaleString()}`}</td>
                  <td className="font-semibold text-emerald-600 text-sm">{planned ? <span className="text-gray-300">—</span> : `Rs ${actA.toLocaleString()}`}</td>
                  <td className={`font-bold text-sm ${variance === null ? '' : (variance > 0 ? 'text-red-600' : variance < 0 ? 'text-emerald-600' : 'text-gray-500')}`}>
                    {variance === null ? <span className="text-gray-300">—</span> : `${variance > 0 ? '+' : variance < 0 ? '−' : ''}Rs ${Math.abs(variance).toLocaleString()}`}
                  </td>
                  <td>{planned ? <span className="text-gray-300">—</span> : <StatusBadge status={d.approval_status} />}</td>
                  <td><div className="flex gap-1">
                    <button onClick={() => viewDpr(d.id)} className="p-1 hover:bg-red-50 rounded text-red-600"><FiEye size={14} /></button>
                    {!planned && d.approval_status === 'pending' && canApprove('dpr') && <>
                      <button onClick={() => approveDpr(d.id, 'approved', true)} className="btn btn-success text-[10px] py-0.5 px-1.5">Approve+Bill</button>
                      <button onClick={() => approveDpr(d.id, 'rejected', false)} className="btn btn-danger text-[10px] py-0.5 px-1.5">Reject</button>
                    </>}
                    {canDelete('dpr') && <button onClick={async () => {
                      if (!confirm(`Delete DPR for "${d.site_name}" on ${d.report_date}?`)) return;
                      try { await api.delete(`/dpr/${d.id}`); toast.success('Deleted'); load(); }
                      catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                    }} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}
                  </div></td>
                </tr>
                  );
                })}
              {dprs.length === 0 && <tr><td colSpan="10" className="text-center py-8 text-gray-400">No DPR for this date</td></tr>}
            </tbody>
          </table></div>
        </>
      )}

      {tab === 'sites' && (
        <>
          <div className="flex justify-between items-center"><h4 className="font-semibold">Project Sites</h4>
            <button onClick={() => { setForm({ name: '', address: '', client_name: '', site_engineer_id: '', supervisor: '' }); setSiteModal(true); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Site</button>
          </div>
          <div className="card p-0"><table className="freeze-head">
            <thead><tr><th>Lead No</th><th>Site</th><th>Address</th><th>Client</th><th>Engineer</th><th>Supervisor</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>{sites.map(s => (
              <tr key={s.id}>
                <td className="text-red-600 font-bold">{s.lead_no || '-'}</td>
                <td className="font-medium">{s.name}</td>
                <td>{s.address}</td>
                <td>{s.client_name}</td>
                <td>{s.engineer_name}</td>
                <td>{s.supervisor}</td>
                <td><StatusBadge status={s.status} /></td>
                <td>
                  {/* Deactivate flips status to 'on_hold' (DPR site picker
                      filters status='active' so this hides the site without
                      destroying any DPR / PO / booking history). Reactivate
                      flips it back. */}
                  {(canEdit('dpr') || isAdmin()) && (
                    s.status === 'active' ? (
                      <button onClick={async () => {
                        if (!confirm(`Deactivate site "${s.name}"?\n\nIt will stop appearing in the DPR site picker. You can reactivate it any time.`)) return;
                        try {
                          await api.put(`/dpr/sites/${s.id}`, {
                            name: s.name, address: s.address, client_name: s.client_name,
                            site_engineer_id: s.site_engineer_id, supervisor: s.supervisor,
                            status: 'on_hold',
                          });
                          toast.success('Deactivated');
                          api.get('/dpr/sites').then(r => setSites(r.data));
                        } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
                      }} className="btn btn-secondary text-xs py-1 px-2">Deactivate</button>
                    ) : (
                      <button onClick={async () => {
                        try {
                          await api.put(`/dpr/sites/${s.id}`, {
                            name: s.name, address: s.address, client_name: s.client_name,
                            site_engineer_id: s.site_engineer_id, supervisor: s.supervisor,
                            status: 'active',
                          });
                          toast.success('Reactivated');
                          api.get('/dpr/sites').then(r => setSites(r.data));
                        } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
                      }} className="btn btn-success text-xs py-1 px-2">Reactivate</button>
                    )
                  )}
                </td>
              </tr>
            ))}
              {sites.length === 0 && <tr><td colSpan="8" className="text-center py-8 text-gray-400">No sites</td></tr>}</tbody>
          </table></div>
        </>
      )}

      {/* ===== SUBMIT DPR MODAL - Matches SEPL DPR Format ===== */}
      <Modal isOpen={modal} onClose={() => setModal(false)} title="DAILY PROGRESS SHEET - SECURED ENGINEERS PVT LTD" wide>
        <form onSubmit={submitDpr} className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">

          {/* Header */}
          <div className="border rounded-lg p-3 bg-gray-50">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <div><label className="label">Site Name *</label>
                <select className="select" value={form.site_id || ''} onChange={e => handleSiteSelect(e.target.value)} required>
                  <option value="">Select Site</option>{sites.filter(s => s.status === 'active').map(s => <option key={s.id} value={s.id}>{s.lead_no ? `[${s.lead_no}] ` : ''}{s.name}</option>)}
                </select>
              </div>
              <div><label className="label">Date *</label><input className="input" type="date" value={form.report_date || ''} onChange={e => setForm({ ...form, report_date: e.target.value })} required /></div>
              {isAdmin() ? (
                <div>
                  <label className="label">Engineer Name</label>
                  <SearchableSelect
                    options={users.map(u => ({ ...u, label: u.name + (u.username ? ' (@' + u.username + ')' : '') }))}
                    value={form.engineer_id || null}
                    valueKey="id" displayKey="label"
                    placeholder="Search engineer…"
                    onChange={(u) => setForm({ ...form, engineer_id: u?.id || '' })}
                  />
                </div>
              ) : (
                <div><label className="label">Engineer Name</label><div className="input bg-gray-100 text-gray-700">{user?.name}</div></div>
              )}
              <div className="sm:col-span-2">
                <div className="flex items-baseline justify-between mb-1">
                  <label className="label mb-0">Contractors on Site</label>
                  <button type="button" onClick={() => setContractors([...contractors, { name: '', manpower: 0 }])}
                    className="text-xs text-red-600 hover:underline">+ Add Contractor</button>
                </div>
                <div className="space-y-1.5">
                  {contractors.map((c, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2 items-center">
                      {/* Mam (2026-05-30): "contractor name drop down from
                          master sub-contactor".  SearchableSelect lists every
                          active sub-contractor with their trade in the label
                          so engineers can find by company OR by trade type.
                          We bind by name (string) — keeps backward compat
                          with legacy contractor_name TEXT in older DPRs. */}
                      <div className="col-span-7">
                        <SearchableSelect
                          options={[
                            // Existing free-text values from legacy DPRs land
                            // here too, so re-opening a draft doesn't lose them.
                            ...(c.name && !subcons.find(s => s.name === c.name)
                              ? [{ name: c.name, label: `${c.name} (manual)` }]
                              : []),
                            ...subcons.map(s => ({
                              ...s,
                              label: s.contractor_type ? `${s.name} — ${s.contractor_type}` : s.name,
                            })),
                          ]}
                          value={c.name || ''}
                          valueKey="name"
                          displayKey="label"
                          placeholder={`Contractor ${i + 1}…`}
                          onChange={(s) => {
                            const n = [...contractors];
                            n[i] = { ...n[i], name: s?.name || '' };
                            setContractors(n);
                          }}
                        />
                      </div>
                      <input className="input col-span-4" type="number" placeholder="Manpower"
                        value={c.manpower || ''}
                        onChange={e => { const n = [...contractors]; n[i] = { ...n[i], manpower: +e.target.value || 0 }; setContractors(n); }} />
                      {contractors.length > 1 ? (
                        <button type="button"
                          onClick={() => setContractors(contractors.filter((_, idx) => idx !== i))}
                          className="col-span-1 text-gray-400 hover:text-red-600 text-lg leading-none">×</button>
                      ) : <div className="col-span-1" />}
                    </div>
                  ))}
                </div>
              </div>
              <div><label className="label">Shift</label>
                <div className="flex gap-4 mt-1">
                  {['day', 'evening', 'night'].map(s => (
                    <label key={s} className="flex items-center gap-1 cursor-pointer">
                      <input type="radio" name="shift" value={s} checked={form.shift === s} onChange={() => setForm({ ...form, shift: s })} className="w-4 h-4" />
                      <span className="text-sm capitalize">{s}</span>
                    </label>
                  ))}
                </div>
              </div>
              {/* MEPF System — compact chip-radio.  Mam (2026-05-30):
                  "mepf system , weather look consume space more" —
                  shrunk padding + dropped the unselected color dot. */}
              <div className="sm:col-span-2 md:col-span-3">
                <label className="label">MEPF System</label>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {MEPF_SYSTEMS.map(s => {
                    const active = form.system_type === s.key;
                    return (
                      <button key={s.key} type="button"
                        onClick={() => setForm({ ...form, system_type: active ? '' : s.key })}
                        className={`px-2 py-1 rounded-full text-xs font-medium border transition inline-flex items-center gap-1 ${
                          active
                            ? `${s.sel} shadow-sm`
                            : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                        }`}>
                        <span className="text-sm leading-none">{s.icon}</span>
                        {s.key}
                      </button>
                    );
                  })}
                </div>
                {form.system_type && !MEPF_SYSTEMS.find(s => s.key === form.system_type) && (
                  <div className="text-[11px] text-gray-500 mt-1">
                    Legacy value: <strong>{form.system_type}</strong>
                    <button type="button" onClick={() => setForm({ ...form, system_type: '' })}
                      className="ml-2 text-red-600 hover:underline">clear</button>
                  </div>
                )}
              </div>
              {/* Weather — same compact chip pattern as MEPF. */}
              <div className="sm:col-span-2 md:col-span-3">
                <label className="label">Weather</label>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {WEATHER_OPTIONS.map(w => {
                    const active = (form.weather || 'clear') === w.key;
                    return (
                      <button key={w.key} type="button"
                        onClick={() => setForm({ ...form, weather: w.key })}
                        className={`px-2 py-1 rounded-full text-xs font-medium border transition inline-flex items-center gap-1 ${
                          active
                            ? `${w.sel} shadow-sm`
                            : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                        }`}>
                        <span className="text-sm leading-none">{w.icon}</span>
                        {w.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* TABLE A: Installation Work from PO */}
          <div className="border-2 border-red-300 rounded-lg p-3 bg-red-50">
            <div className="flex justify-between items-center mb-3">
              <h5 className="font-bold text-red-800">TABLE A: Installation Work (BOQ Items from PO)</h5>
              {poItemsForSite.length > 0 && <button type="button" onClick={addWorkItem} className="btn btn-secondary text-xs flex items-center gap-1"><FiPlus size={12} /> Add Item</button>}
            </div>
            {/* Server-side diagnostic — tells mam exactly why items aren't
                fully populated (no Business Book link, no BOQ uploaded,
                or labour rates missing). */}
            {poItemsDiag && (
              <div className="bg-amber-50 border border-amber-300 rounded px-3 py-2 text-xs text-amber-900 mb-2 flex items-start gap-2">
                <FiAlertCircle className="flex-shrink-0 mt-0.5" size={14} />
                <div>
                  <div className="font-bold mb-0.5">
                    {poItemsDiag.reason === 'no_business_book' ? 'No Business Book linked' :
                     poItemsDiag.reason === 'no_po_items' ? 'No BOQ items yet' :
                     poItemsDiag.reason === 'rates_missing'
                       ? `${poItemsDiag.total_count} item${poItemsDiag.total_count === 1 ? '' : 's'} loaded · ${poItemsDiag.total_count - (poItemsDiag.missing_sitc_count || 0)} have a rate set`
                       : 'Heads up'}
                  </div>
                  <div>{poItemsDiag.message}</div>
                </div>
              </div>
            )}
            {poItemsForSite.length > 0 ? (
              <>
                <div className="hidden md:grid grid-cols-12 gap-1 text-[10px] font-bold text-gray-600 mb-1 px-1 uppercase">
                  <div className="md:col-span-4">BOQ Item</div><div className="md:col-span-1">Qty</div><div className="md:col-span-2">Location</div><div className="md:col-span-2">Rate (Rs)</div><div className="md:col-span-2">Amount (Rs)</div><div></div>
                </div>
                {workItems.map((w, i) => (
                  // Mobile-friendly row layout — mam: "qty is very small not
                  // showing peroper when we enter". Mobile splits each work
                  // item into 3 readable rows; desktop keeps the compact 12-
                  // col grid. Each input gets its own mobile-only label so
                  // the user always knows what they're typing into.
                  <div key={i} className="grid grid-cols-12 gap-1 mb-3 md:mb-1.5 items-start bg-white rounded p-2 md:p-1 border md:border-0 border-gray-100">
                    <div className="col-span-12 md:col-span-4">
                      <SearchableSelect
                        options={poItemsForSite.map(item => {
                          // Prepend item_code + append a hidden suffix of
                          // master_name / specification / size / make / type
                          // so substring search finds "raceway" etc. even
                          // when the BOQ description uses different wording.
                          const rateBit = +item.rate > 0 ? `Rs ${(+item.rate).toLocaleString('en-IN')}` : '⚠ no rate';
                          const completedBit = item.remaining_qty <= 0 ? ' — COMPLETED' : '';
                          const codeBit = item.item_code ? `[${item.item_code}] ` : '';
                          const searchSuffix = [
                            item.master_name, item.master_specification, item.master_size,
                            item.master_make, item.master_type,
                          ].filter(Boolean).join(' ');
                          return {
                            id: item.id,
                            label: `${codeBit}${item.description} (BOQ:${item.quantity} | Rem:${item.remaining_qty ?? item.quantity} ${item.unit} | ${rateBit})${completedBit}${searchSuffix ? ' · ' + searchSuffix : ''}`,
                            ...item,
                          };
                        })}
                        value={w.po_item_id || null}
                        valueKey="id"
                        displayKey="label"
                        placeholder="-- Select PO Item --"
                        onChange={(item) => selectWorkItem(i, item?.id || '')}
                      />
                    </div>
                    {/* Qty — col-span-4 on mobile (~33% width, room for 4–5 digits) */}
                    <div className="col-span-4 md:col-span-1">
                      <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Qty</div>
                      <input className="input text-sm w-full" type="number" placeholder="Qty" max={w.remaining_qty || w.boq_qty || 999999} value={w.qty || ''} onChange={e => {
                        const val = +e.target.value;
                        const maxQty = w.remaining_qty ?? w.boq_qty ?? 999999;
                        if (val > maxQty) { toast.error(`Max qty: ${maxQty} (BOQ: ${w.boq_qty}, Already filled: ${w.filled_qty || 0})`); return; }
                        updateWork(i, 'qty', val);
                      }} />
                      {w.po_item_id && (
                        <div className="text-[9px] leading-tight mt-0.5 text-center">
                          <div className="text-gray-500">BOQ: <span className="font-semibold">{w.boq_qty} {w.unit || ''}</span></div>
                          <div className={w.remaining_qty > 0 ? 'text-emerald-600 font-semibold' : 'text-red-500 font-semibold'}>
                            Rem: {w.remaining_qty ?? 0} {w.unit || ''}
                          </div>
                        </div>
                      )}
                    </div>
                    {/* Location — col-span-8 mobile (rest of the qty row) */}
                    <div className="col-span-8 md:col-span-2">
                      <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Location</div>
                      <input className="input text-sm w-full" placeholder="Loc (GF/1F)" value={w.location || ''} onChange={e => updateWork(i, 'location', e.target.value)} />
                    </div>
                    {/* Rate — col-span-6 mobile (half of new row) */}
                    <div className="col-span-6 md:col-span-2">
                      <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Rate (Rs)</div>
                      <input className="input text-sm w-full" type="number" placeholder="Rate" value={w.rate || ''} onChange={e => updateWork(i, 'rate', +e.target.value)} />
                      {w.sitc_rate > 0 && (
                        <div className="text-[9px] leading-tight mt-0.5 text-gray-500">
                          Labour = 11% of SITC ₹{(+w.sitc_rate).toLocaleString('en-IN')}
                        </div>
                      )}
                    </div>
                    {/* Amount — col-span-5 mobile */}
                    <div className="col-span-5 md:col-span-2">
                      <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Amount</div>
                      <div className="text-sm font-bold text-right pr-2 pt-2 md:pt-0">Rs {(w.amount || 0).toLocaleString()}</div>
                    </div>
                    {/* Trash — col-span-1 (just enough for the icon) */}
                    <div className="col-span-1 flex justify-center pt-2 md:pt-0">
                      <button type="button" onClick={() => removeWorkItem(i)} className="p-1 text-red-400 hover:text-red-600"><FiTrash2 size={14} /></button>
                    </div>
                    {/* Phase 4 — Work Order picker.  Spans the full row
                        below the qty / rate / amount inputs so it doesn't
                        squeeze the existing layout, and only renders when
                        the project has at least one active Work Order to
                        choose from (mam 2026-06-02: DPR → Indent Labour
                        Payment progress link). */}
                    {activeWorkOrders.length > 0 && (
                      <div className="col-span-12 flex items-center gap-2 mt-1.5 pt-1.5 border-t border-gray-100">
                        <span className="text-[10px] font-semibold text-gray-500 uppercase whitespace-nowrap">Work Order</span>
                        <div className="flex-1 min-w-0">
                          <SearchableSelect
                            options={activeWorkOrders.map(wo => ({
                              id: wo.id,
                              label: `${wo.wo_number || `WO#${wo.id}`} · ${wo.sub_contractor_name || '—'}${wo.project_name ? ' · ' + wo.project_name : ''}${wo.scope ? ' — ' + wo.scope.slice(0, 40) : ''}`,
                              ...wo,
                            }))}
                            value={w.work_order_id || null}
                            valueKey="id"
                            displayKey="label"
                            placeholder="— optional · link to sub-contractor WO —"
                            buttonClassName="input text-xs w-full text-left flex items-center justify-between gap-1 cursor-pointer"
                            onChange={(wo) => updateWork(i, 'work_order_id', wo?.id || '')}
                          />
                        </div>
                        {w.work_order_id && (
                          <button
                            type="button"
                            onClick={() => updateWork(i, 'work_order_id', '')}
                            className="text-[10px] text-gray-400 hover:text-red-600 px-1"
                            title="Unlink Work Order"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {workItems.length === 0 && <p className="text-xs text-gray-400 text-center py-3">Click "+ Add Item" for items installed today</p>}
                <div className="mt-2 pt-2 border-t-2 border-red-300 text-right">
                  <span className="font-bold text-red-800 text-lg">Grand Total (A): Rs {grandTotalA.toLocaleString()}</span>
                </div>
              </>
            ) : <p className="text-xs text-amber-600">{form.site_id ? 'No PO items for this site. Add PO items in Orders first.' : 'Select a site to load PO items.'}</p>}
          </div>

          {/* TABLE B: Costs */}
          <div className="border-2 border-red-300 rounded-lg p-3 bg-red-50">
            <h5 className="font-bold text-red-800 mb-3">TABLE B: Costs</h5>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-1 text-[10px] font-bold text-gray-600 mb-1 px-1 uppercase">
              <div>Type</div><div>Qty</div><div>Rate (Rs)</div><div>Amount (Rs)</div>
            </div>
            {costs.map((c, i) => {
              const isStaff = c.type === 'Staff Cost';
              const isTaDa = c.type === 'TA/DA';
              // Staff rate is locked only when auto-fetch succeeded. When it
              // returns 0 (no employee/salary), let the user type a rate manually.
              const staffRateLocked = isStaff && c.auto;
              // TA/DA stays editable even when auto-filled, so the engineer
              // can override if the auto-pulled total doesn't match reality
              // for that day.
              const rateLocked = c.fixed || staffRateLocked;
              return (
                <div key={i} className="bg-white rounded p-1 mb-1.5">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-1 items-center">
                    <div className="text-sm font-medium">
                      {c.type}
                      {c.fixed && <span className="ml-1 text-[9px] text-gray-400">(fixed)</span>}
                      {isStaff && c.auto && <span className="ml-1 text-[9px] text-emerald-600">(auto, 1 day)</span>}
                      {isStaff && !c.auto && c.engineer_count === 0 && <span className="ml-1 text-[9px] text-amber-600">(manual — see below)</span>}
                      {isTaDa && c.auto && <span className="ml-1 text-[9px] text-emerald-600">(auto from {c.ta_da_count || 0} approved request{(c.ta_da_count || 0) === 1 ? '' : 's'})</span>}
                      {isTaDa && !c.auto && <span className="ml-1 text-[9px] text-gray-400">(no approved TA/DA for this site)</span>}
                    </div>
                    {isStaff ? (
                      <div className="text-sm text-center text-gray-500 font-medium">1</div>
                    ) : (
                      <input className="input text-sm text-center" type="number" placeholder="0" value={c.qty || ''} onChange={e => updateCost(i, 'qty', +e.target.value)} />
                    )}
                    <input
                      className={`input text-sm text-center ${rateLocked ? 'bg-gray-50 text-gray-500 cursor-not-allowed' : ''}`}
                      type="number"
                      placeholder="0"
                      value={c.rate || ''}
                      readOnly={rateLocked}
                      onChange={e => updateCost(i, 'rate', +e.target.value)}
                      title={c.fixed ? `Fixed company rate: Rs ${c.rate}` : (staffRateLocked ? 'Auto: sum of PO site engineers’ monthly salary ÷ 30' : (isStaff ? 'Type the staff per-day cost manually' : ''))}
                    />
                    <div className="text-sm font-bold text-right pr-2">Rs {(c.amount || 0).toLocaleString()}</div>
                  </div>
                  {isStaff && (
                    <div className="text-[10px] pl-1 mt-1">
                      {!form.site_id ? (
                        <p className="text-gray-500">Select a site first — Staff Cost auto-fills from that PO’s site engineers.</p>
                      ) : (c.staff && c.staff.length > 0) ? (
                        <div className="space-y-0.5">
                          <div className="text-gray-500">Staff cost by name (attendance of {form.report_date || filterDate || 'the date'}):</div>
                          {c.staff.map(s => (
                            <div key={s.user_id} className={`flex justify-between ${s.present ? 'text-gray-700' : 'text-gray-400 line-through'}`}
                              title={s.present ? 'Attendance marked — counted' : 'No attendance / absent — excluded'}>
                              <span>{s.present ? '✓' : '✗'} {s.name}</span>
                              <span>Rs {(s.per_day || 0).toLocaleString()}{!s.present && ' · excluded'}</span>
                            </div>
                          ))}
                          {c.diagnostic && <p className="text-amber-700">{c.diagnostic.message}</p>}
                        </div>
                      ) : (
                        <p className={c.diagnostic ? 'text-amber-700' : 'text-gray-500'}>
                          {c.diagnostic ? c.diagnostic.message
                            : c.po_engineers > 0
                              ? `${c.po_engineers} site engineer${c.po_engineers > 1 ? 's' : ''} are on this PO but none have a matching employee salary record. Type the rate manually, or ask HR to add your salary.`
                              : 'No site engineers / submitter salary found. Type the rate manually below, or ask HR to add your salary.'}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <button type="button" onClick={() => setCosts([...costs, { type: '', qty: 0, rate: 0, amount: 0 }])} className="text-xs text-red-700 hover:underline">+ Add Cost Type</button>
            <div className="mt-2 pt-2 border-t-2 border-red-300 text-right">
              <span className="font-bold text-red-800 text-lg">Grand Total (B): Rs {grandTotalB.toLocaleString()}</span>
            </div>
          </div>

          {/* Profit/Loss */}
          <div className={`border-2 rounded-lg p-4 text-center ${profitLoss >= 0 ? 'border-emerald-400 bg-emerald-50' : 'border-red-400 bg-red-50'}`}>
            <span className={`text-2xl font-bold ${profitLoss >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
              {profitLoss >= 0 ? 'PROFIT' : 'LOSS'}: Rs {Math.abs(profitLoss).toLocaleString()}
            </span>
            <p className="text-xs text-gray-500 mt-1">(A) Rs {grandTotalA.toLocaleString()} - (B) Rs {grandTotalB.toLocaleString()}</p>
          </div>

          {/* Machinery/Tools */}
          <div className="border rounded-lg p-3 bg-cyan-50">
            <h5 className="font-semibold text-sm text-cyan-700 mb-2">Machinery / Tools Used</h5>
            {machinery.map((m, i) => (
              <div key={i} className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-1.5">
                <select className="input text-sm" value={m.equipment} onChange={e => { const n = [...machinery]; n[i].equipment = e.target.value; setMachinery(n); }}>
                  <option value="">Select</option>{EQUIPMENT_LIST.map(eq => <option key={eq}>{eq}</option>)}
                </select>
                <input className="input text-sm" type="number" placeholder="Qty" value={m.quantity || ''} onChange={e => { const n = [...machinery]; n[i].quantity = +e.target.value; setMachinery(n); }} />
                <input className="input text-sm" type="number" placeholder="Hours" value={m.hours_used || ''} onChange={e => { const n = [...machinery]; n[i].hours_used = +e.target.value; setMachinery(n); }} />
                <select className="input text-sm" value={m.condition || 'working'} onChange={e => { const n = [...machinery]; n[i].condition = e.target.value; setMachinery(n); }}>
                  <option value="working">Working</option><option value="idle">Idle</option><option value="breakdown">Breakdown</option>
                </select>
              </div>
            ))}
            <button type="button" onClick={() => setMachinery([...machinery, { equipment: '', quantity: 1, hours_used: 0, condition: 'working' }])} className="text-xs text-cyan-700 hover:underline">+ Add Equipment</button>
          </div>

          {/* Safety */}
          <div className="border rounded-lg p-3 bg-red-50">
            <h5 className="font-semibold text-sm text-red-700 mb-2">Safety & Compliance</h5>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" className="w-4 h-4 rounded" checked={form.safety_toolbox_talk || false} onChange={e => setForm({ ...form, safety_toolbox_talk: e.target.checked })} /><span className="text-sm">Toolbox Talk (TBT)</span></label>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" className="w-4 h-4 rounded" checked={form.safety_ppe_compliance || false} onChange={e => setForm({ ...form, safety_ppe_compliance: e.target.checked })} /><span className="text-sm">PPE Compliance</span></label>
            </div>
            <div className="mt-2"><input className="input" value={form.safety_incidents || ''} onChange={e => setForm({ ...form, safety_incidents: e.target.value })} placeholder="Safety Incidents (Nil if none)" /></div>
          </div>

          {/* Hindrances + Next Day. Mam's rule: when the day ended in a
              LOSS (profitLoss < 0), category + reason are MANDATORY so we
              can analyse root causes across sites. Becomes required
              automatically based on the live profit/loss calc above. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className={`border rounded-lg p-3 ${profitLoss < 0 ? 'border-red-400 bg-red-50' : 'bg-orange-50'}`}>
              <h5 className="font-semibold text-sm text-orange-700 mb-2">
                Hindrances / Issues {profitLoss < 0 && <span className="text-red-700 text-[10px] font-bold ml-1">⚠ MANDATORY (Loss)</span>}
              </h5>
              <div className="mb-2">
                <label className="text-[11px] font-bold text-gray-700 uppercase">Category {profitLoss < 0 && <span className="text-red-600">*</span>}</label>
                <select
                  className="select"
                  required={profitLoss < 0}
                  value={form.hindrance_category || ''}
                  onChange={e => setForm({ ...form, hindrance_category: e.target.value })}
                >
                  <option value="">— pick category —</option>
                  <option value="Money">Money</option>
                  <option value="Machine">Machine</option>
                  <option value="Material">Material</option>
                  <option value="Manpower">Manpower</option>
                  <option value="Site Clearance">Site Clearance</option>
                </select>
              </div>
              <label className="text-[11px] font-bold text-gray-700 uppercase">Reason {profitLoss < 0 && <span className="text-red-600">*</span>}</label>
              <textarea
                className="input"
                rows="2"
                required={profitLoss < 0}
                value={form.hindrances || ''}
                onChange={e => setForm({ ...form, hindrances: e.target.value })}
                placeholder={profitLoss < 0 ? 'Why did this site lose money today? (mandatory)' : 'Material shortage, Drawing pending...'}
              />
            </div>
            <div className="border rounded-lg p-3 bg-emerald-50">
              <h5 className="font-semibold text-sm text-emerald-700 mb-2">Next Day Plan</h5>
              <textarea className="input" rows="2" value={form.next_day_plan || ''} onChange={e => setForm({ ...form, next_day_plan: e.target.value })} placeholder="Tomorrow's work plan..." />
            </div>
          </div>

          <div><label className="label">Remarks</label><textarea className="input" rows="2" value={form.remarks || ''} onChange={e => setForm({ ...form, remarks: e.target.value })} /></div>

          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Submit DPR</button></div>
        </form>
      </Modal>

      {/* Site Modal */}
      <Modal isOpen={siteModal} onClose={() => setSiteModal(false)} title="Add Project Site">
        <form onSubmit={createSite} className="space-y-4">
          <div><label className="label">Site Name *</label><input className="input" value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} required /></div>
          <div><label className="label">Address</label><textarea className="input" rows="2" value={form.address || ''} onChange={e => setForm({ ...form, address: e.target.value })} /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className="label">Client</label><input className="input" value={form.client_name || ''} onChange={e => setForm({ ...form, client_name: e.target.value })} /></div>
            <div><label className="label">Supervisor</label><input className="input" list="dprUsersDL" value={form.supervisor || ''} onChange={e => setForm({ ...form, supervisor: e.target.value })} placeholder="Pick or type" /><datalist id="dprUsersDL">{users.map(u => <option key={u.id} value={u.name} />)}</datalist></div>
            <div><label className="label">Site Engineer</label><select className="select" value={form.site_engineer_id || ''} onChange={e => setForm({ ...form, site_engineer_id: e.target.value })}><option value="">Select</option>{users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setSiteModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Create Site</button></div>
        </form>
      </Modal>

      {/* DPR Detail Modal */}
      <Modal isOpen={detailModal} onClose={() => setDetailModal(false)} title={`DPR - ${selectedDpr?.site_name} - ${selectedDpr?.report_date}`} wide>
        {selectedDpr && (
          <div className="space-y-4 max-h-[70vh] overflow-y-auto">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm bg-gray-50 p-3 rounded-lg">
              <div><strong>Site:</strong> {selectedDpr.site_name}</div>
              <div><strong>Date:</strong> {selectedDpr.report_date}</div>
              <div><strong>Shift:</strong> {selectedDpr.shift || '-'}</div>
              <div className="col-span-2 md:col-span-4"><strong>Contractors:</strong>{' '}
                {selectedDpr.contractors?.length
                  ? selectedDpr.contractors.map(c => `${c.name || '(unnamed)'}${c.manpower ? ` × ${c.manpower}` : ''}`).join(', ')
                  : (selectedDpr.contractor_name ? `${selectedDpr.contractor_name}${selectedDpr.contractor_manpower ? ` × ${selectedDpr.contractor_manpower}` : ''}` : '-')}
              </div>
              <div><strong>System:</strong> {selectedDpr.system_type || '-'}</div>
              <div><strong>Weather:</strong> {selectedDpr.weather}</div>
              <div><strong>By:</strong> {selectedDpr.submitted_by_name}</div>
              <div><strong>Status:</strong> <StatusBadge status={selectedDpr.overall_status} /></div>
            </div>

            {selectedDpr.work_items?.length > 0 && (
              <div className="border-2 border-red-300 rounded-lg p-3">
                <h5 className="font-bold text-red-800 mb-2">TABLE A: Installation Work</h5>
                <table className="text-xs"><thead><tr><th>BOQ Item</th><th>Qty</th><th>Location</th><th>Rate</th><th>Amount</th></tr></thead>
                  <tbody>{selectedDpr.work_items.map(w => (<tr key={w.id}><td>{w.description}</td><td className="font-bold">{w.actual_qty || w.planned_qty}</td><td>{w.floor_zone || '-'}</td><td>Rs {(w.rate || 0).toLocaleString()}</td><td className="font-bold text-emerald-600">Rs {(w.amount || 0).toLocaleString()}</td></tr>))}</tbody>
                </table>
                <div className="text-right font-bold text-red-800 mt-2">Grand Total (A): Rs {selectedDpr.work_items.reduce((s, w) => s + (w.amount || 0), 0).toLocaleString()}</div>
              </div>
            )}

            {selectedDpr.manpower?.length > 0 && (() => {
              const nonStaffB = selectedDpr.manpower.filter(m => m.trade !== 'Staff Cost').reduce((s, m) => s + (m.shortage || 0), 0);
              const storedStaffB = selectedDpr.manpower.filter(m => m.trade === 'Staff Cost').reduce((s, m) => s + (m.shortage || 0), 0);
              const hasBreakdown = !!(viewStaff && viewStaff.staff && viewStaff.staff.length > 0);
              const staffB = hasBreakdown ? (viewStaff.per_day_cost || 0) : storedStaffB;
              const grandB = nonStaffB + staffB;
              const present = (viewStaff?.staff || []).filter(s => s.present);
              const excluded = (viewStaff?.staff || []).filter(s => !s.present);
              return (
                <div className="border-2 border-red-300 rounded-lg p-3">
                  <h5 className="font-bold text-red-800 mb-2">TABLE B: Costs</h5>
                  <table className="text-xs"><thead><tr><th>Type</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
                    <tbody>
                      {/* Non-staff rows as saved. Staff Cost is replaced by the by-name,
                          attendance-filtered breakdown when available (mam 2026-06-30). */}
                      {selectedDpr.manpower.filter(m => m.trade !== 'Staff Cost' || !hasBreakdown).map(m => (
                        <tr key={m.id}><td>{m.trade}</td><td>{m.required}</td><td>Rs {(m.deployed || 0).toLocaleString()}</td><td className="font-bold text-red-600">Rs {(m.shortage || 0).toLocaleString()}</td></tr>
                      ))}
                      {hasBreakdown && present.map(s => (
                        <tr key={'st' + s.user_id}><td>Staff: {s.name}</td><td>1</td><td>Rs {(s.per_day || 0).toLocaleString()}</td><td className="font-bold text-red-600">Rs {(s.per_day || 0).toLocaleString()}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  {hasBreakdown && excluded.length > 0 && (
                    <div className="text-[11px] text-gray-400 mt-1">Excluded (no attendance / absent on {selectedDpr.report_date}): {excluded.map(s => s.name).join(', ')}</div>
                  )}
                  {hasBreakdown && Math.abs(staffB - storedStaffB) > 1 && (
                    <div className="text-[11px] text-amber-600 mt-0.5">Staff cost recomputed by attendance: Rs {staffB.toLocaleString()} (saved was Rs {storedStaffB.toLocaleString()})</div>
                  )}
                  <div className="text-right font-bold text-red-800 mt-2">Grand Total (B): Rs {grandB.toLocaleString()}</div>
                </div>
              );
            })()}

            {(() => {
              // Recompute LOSS/PROFIT with the attendance-filtered staff cost so it
              // matches the by-name Table B above (mam 2026-06-30). Falls back to the
              // saved profit_loss when the breakdown isn't loaded.
              const nonStaffB = (selectedDpr.manpower || []).filter(m => m.trade !== 'Staff Cost').reduce((s, m) => s + (m.shortage || 0), 0);
              const storedStaffB = (selectedDpr.manpower || []).filter(m => m.trade === 'Staff Cost').reduce((s, m) => s + (m.shortage || 0), 0);
              const hasBreakdown = !!(viewStaff && viewStaff.staff && viewStaff.staff.length > 0);
              const staffB = hasBreakdown ? (viewStaff.per_day_cost || 0) : storedStaffB;
              const pl = hasBreakdown ? ((selectedDpr.grand_total_a || 0) - (nonStaffB + staffB)) : (selectedDpr.profit_loss || 0);
              return (
                <div className={`border-2 rounded-lg p-3 text-center ${pl >= 0 ? 'border-emerald-400 bg-emerald-50' : 'border-red-400 bg-red-50'}`}>
                  <span className={`text-xl font-bold ${pl >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                    {pl >= 0 ? 'PROFIT' : 'LOSS'}: Rs {Math.abs(pl).toLocaleString()}
                  </span>
                </div>
              );
            })()}

            {selectedDpr.machinery?.length > 0 && (
              <div><h5 className="font-semibold text-sm mb-2">Machinery/Tools</h5><table className="text-xs"><thead><tr><th>Equipment</th><th>Qty</th><th>Hours</th><th>Condition</th></tr></thead>
                <tbody>{selectedDpr.machinery.map(m => (<tr key={m.id}><td>{m.equipment}</td><td>{m.quantity}</td><td>{m.hours_used}h</td><td>{m.condition}</td></tr>))}</tbody></table></div>
            )}
            {selectedDpr.safety_toolbox_talk !== undefined && (
              <div className="flex gap-4 text-sm">
                <span className={selectedDpr.safety_toolbox_talk ? 'text-emerald-600 font-bold' : 'text-red-500'}>TBT: {selectedDpr.safety_toolbox_talk ? 'Done' : 'Not Done'}</span>
                <span className={selectedDpr.safety_ppe_compliance ? 'text-emerald-600 font-bold' : 'text-red-500'}>PPE: {selectedDpr.safety_ppe_compliance ? 'OK' : 'No'}</span>
              </div>
            )}
            {selectedDpr.hindrances && (
              <div className="bg-orange-50 p-3 rounded text-sm">
                <strong className="text-orange-700">Hindrances:</strong>
                {selectedDpr.hindrance_category && <span className="ml-1 text-[10px] px-2 py-0.5 rounded bg-red-100 text-red-700 font-bold uppercase">{selectedDpr.hindrance_category}</span>}
                <div className="mt-1">{selectedDpr.hindrances}</div>
              </div>
            )}
            {selectedDpr.next_day_plan && <div className="bg-emerald-50 p-3 rounded text-sm"><strong className="text-emerald-700">Next Day Plan:</strong> {selectedDpr.next_day_plan}</div>}
            {selectedDpr.remarks && <div className="text-sm"><strong>Remarks:</strong> {selectedDpr.remarks}</div>}
          </div>
        )}
      </Modal>

      {/* ─── Weekly Plan Modal ─────────────────────────────────────
          Site eng picks a site + week-start, fills 7 rows of planned
          work / manpower / cost in one go.  Saves create or update
          the matching dpr rows (one per day) with planned fields
          populated and actuals left blank. */}
      {/* ── Morning Manpower — contractor attendance punch (mam 2026-06-22) ── */}
      <Modal isOpen={mmModal} onClose={() => setMmModal(false)} title="Morning Manpower — Contractor Attendance">
        <div className="space-y-3">
          <p className="text-xs text-gray-500">Record which contractors are on site this morning and how many manpower each brought. This pre-fills the DPR’s “Contractors on Site” when you submit it.</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Site *</label>
              <select className="select" value={mmSite}
                onChange={e => { setMmSite(e.target.value); loadMorningManpower(e.target.value, mmDate); }}>
                <option value="">Select Site</option>
                {sites.filter(s => s.status === 'active').map(s => <option key={s.id} value={s.id}>{s.lead_no ? `[${s.lead_no}] ` : ''}{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Date *</label>
              <input className="input" type="date" value={mmDate}
                onChange={e => { setMmDate(e.target.value); loadMorningManpower(mmSite, e.target.value); }} />
            </div>
          </div>
          <div>
            <div className="flex items-baseline justify-between mb-1">
              <label className="label mb-0">Contractors present</label>
              <button type="button" onClick={() => setMmRows([...mmRows, { name: '', manpower: 0 }])}
                className="text-xs text-red-600 hover:underline">+ Add Contractor</button>
            </div>
            <div className="space-y-1.5">
              {mmRows.map((c, i) => (
                <div key={i} className="space-y-1">
                  <div className="grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-6">
                      <SearchableSelect
                        options={[
                          ...(c.name && !subcons.find(s => s.name === c.name) ? [{ name: c.name, label: `${c.name} (manual)` }] : []),
                          ...subcons.map(s => ({ ...s, label: s.contractor_type ? `${s.name} — ${s.contractor_type}` : s.name })),
                        ]}
                        value={c.name || ''}
                        valueKey="name"
                        displayKey="label"
                        placeholder={`Contractor ${i + 1}…`}
                        onChange={(s) => { const n = [...mmRows]; n[i] = { ...n[i], name: s?.name || '', subcontractor_id: s?.id || null, contractor_type: s?.contractor_type || null }; setMmRows(n); }}
                      />
                    </div>
                    <input className="input col-span-3" type="number" min="0" placeholder="Manpower"
                      value={c.manpower || ''}
                      onChange={e => { const n = [...mmRows]; n[i] = { ...n[i], manpower: +e.target.value || 0 }; setMmRows(n); }} />
                    {/* Photo → AI auto-counts the people into Manpower (mam 2026-06-22) */}
                    <label className={`col-span-2 btn btn-secondary !py-2 text-[11px] flex items-center justify-center gap-1 cursor-pointer ${c.counting ? 'opacity-60 pointer-events-none' : ''}`}
                      title="Upload a photo of the gang — AI counts the people">
                      <FiCamera size={13} /> {c.counting ? '…' : 'Photo'}
                      <input type="file" accept="image/*" className="hidden" disabled={c.counting}
                        onChange={e => { countFromPhoto(i, e.target.files?.[0]); e.target.value = ''; }} />
                    </label>
                    {mmRows.length > 1 ? (
                      <button type="button" onClick={() => setMmRows(mmRows.filter((_, idx) => idx !== i))}
                        className="col-span-1 text-gray-400 hover:text-red-600 text-lg leading-none">×</button>
                    ) : <div className="col-span-1" />}
                  </div>
                  {(c.photo_url || c.counting) && (
                    <div className="flex items-center gap-2 pl-1">
                      {c.photo_url && <img src={c.photo_url} alt="" className="w-9 h-9 object-cover rounded border" />}
                      <span className="text-[11px] text-gray-500">{c.counting ? 'Counting people in the photo…' : 'Manpower auto-counted from photo — edit if needed'}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="text-xs text-gray-500 mt-2">Total manpower: <b>{mmRows.reduce((s, r) => s + (+r.manpower || 0), 0)}</b> across {mmRows.filter(r => r.name && r.name.trim()).length} contractor(s)</div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => setMmModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="button" onClick={saveMorningManpower} disabled={mmBusy} className="btn btn-primary disabled:opacity-50">{mmBusy ? 'Saving…' : 'Save Morning Manpower'}</button>
          </div>
        </div>
      </Modal>

      {/* ── Contractor Attendance — saved records register (mam 2026-06-24) ── */}
      <Modal isOpen={mmRecModal} onClose={() => setMmRecModal(false)} title="Contractor Attendance — Records" wide>
        <div className="space-y-3">
          <p className="text-xs text-gray-500">All saved morning-manpower attendance. Filter by site and date range.</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
            <div>
              <label className="label">Site</label>
              <select className="select" value={mmRecSite} onChange={e => { setMmRecSite(e.target.value); loadAttendanceRecords({ site: e.target.value }); }}>
                <option value="">All sites</option>
                {sites.map(s => <option key={s.id} value={s.id}>{s.lead_no ? `[${s.lead_no}] ` : ''}{s.name}</option>)}
              </select>
            </div>
            <div><label className="label">From</label><input type="date" className="input" value={mmRecFrom} onChange={e => { setMmRecFrom(e.target.value); loadAttendanceRecords({ from: e.target.value }); }} /></div>
            <div><label className="label">To</label><input type="date" className="input" value={mmRecTo} onChange={e => { setMmRecTo(e.target.value); loadAttendanceRecords({ to: e.target.value }); }} /></div>
            {(mmRecSite || mmRecFrom || mmRecTo) && (
              <button type="button" onClick={() => { setMmRecSite(''); setMmRecFrom(''); setMmRecTo(''); loadAttendanceRecords({ site: '', from: '', to: '' }); }} className="btn btn-secondary text-red-500">Clear</button>
            )}
          </div>

          {mmRecBusy ? (
            <p className="text-sm text-gray-400 text-center py-8">Loading…</p>
          ) : mmRecRows.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No attendance records found.</p>
          ) : (
            <div className="overflow-x-auto max-h-[58vh] border rounded-lg">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-2 py-2 text-left text-xs font-semibold text-gray-600">Date</th>
                    <th className="px-2 py-2 text-left text-xs font-semibold text-gray-600">Site</th>
                    <th className="px-2 py-2 text-left text-xs font-semibold text-gray-600">Contractor</th>
                    <th className="px-2 py-2 text-left text-xs font-semibold text-gray-600">Type</th>
                    <th className="px-2 py-2 text-right text-xs font-semibold text-gray-600">Manpower</th>
                    <th className="px-2 py-2 text-center text-xs font-semibold text-gray-600">Photo</th>
                    <th className="px-2 py-2 text-left text-xs font-semibold text-gray-600">Marked By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {mmRecRows.map(r => (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-2 py-1.5 whitespace-nowrap">{r.attendance_date}</td>
                      <td className="px-2 py-1.5">{r.site_name || '—'}</td>
                      <td className="px-2 py-1.5 font-medium">{r.contractor_name}</td>
                      <td className="px-2 py-1.5 text-gray-500">{r.contractor_type || '—'}</td>
                      <td className="px-2 py-1.5 text-right font-semibold">{r.manpower}</td>
                      <td className="px-2 py-1.5 text-center">
                        {r.photo_url
                          ? <a href={r.photo_url} target="_blank" rel="noreferrer"><img src={r.photo_url} alt="" className="w-8 h-8 object-cover rounded border inline-block hover:ring-2 hover:ring-red-300 cursor-zoom-in" /></a>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-2 py-1.5 text-gray-500">{r.marked_by_name || '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-100 font-bold border-t-2 border-gray-300">
                    <td className="px-2 py-2" colSpan="4">Total — {mmRecRows.length} record(s)</td>
                    <td className="px-2 py-2 text-right">{mmRecRows.reduce((s, r) => s + (+r.manpower || 0), 0)}</td>
                    <td colSpan="2"></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          <div className="flex justify-end"><button type="button" onClick={() => setMmRecModal(false)} className="btn btn-secondary">Close</button></div>
        </div>
      </Modal>

      <Modal isOpen={planModal} onClose={() => setPlanModal(false)} title="Plan This Week — 7-Day DPR Plan" wide>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Site *</label>
              <select className="select" value={planSiteId}
                      onChange={e => { setPlanSiteId(e.target.value); openPlanWeek(e.target.value, planWeekStart); }}>
                <option value="">— Pick site —</option>
                {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Week Starting (Mon) *</label>
              <input type="date" className="input" value={planWeekStart}
                     onChange={e => { setPlanWeekStart(e.target.value); openPlanWeek(planSiteId, e.target.value); }} />
            </div>
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded p-2 text-[11px] text-gray-700">
            Pick a BOQ item from the site's PO and the quantity planned for that day.
            Manpower + budgeted cost are filled alongside. The site engineer updates the
            <strong> actual </strong> values daily via the Submit DPR form — the row for that date will be filled in,
            not duplicated.
            {planSiteId && planBoqItems.length === 0 && (
              <div className="mt-1 text-amber-700">
                <strong>No BOQ items found</strong> for this site's PO. You can still plan with free-text descriptions below,
                or upload the BOQ via Orders & Planning → PO Upload.
              </div>
            )}
          </div>

          {/* Per-day cards.  Each day has a header row (day, date,
              manpower, cost) and a nested table of BOQ items the
              user can add / remove / edit. */}
          <div className="space-y-3">
            {planDays.map((d, i) => {
              const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(d.date).getDay()];
              const isSunday = dayName === 'Sun';
              return (
                <div key={d.date} className={`border rounded ${isSunday ? 'bg-gray-50' : 'bg-white'}`}>
                  <div className="grid grid-cols-12 gap-2 items-center px-3 py-2 border-b bg-gray-50/50 text-xs">
                    <div className="col-span-1 font-semibold">{i + 1}</div>
                    <div className="col-span-2 font-semibold">{dayName}{isSunday ? ' · off' : ''}</div>
                    <div className="col-span-3 font-mono text-[11px]">{d.date}</div>
                    <div className="col-span-2 text-right text-gray-600">Manpower</div>
                    <div className="col-span-2">
                      <input type="number" min="0" className="input text-xs text-right w-full"
                             value={d.planned_manpower}
                             onChange={e => updatePlanDay(i, { planned_manpower: +e.target.value })} />
                    </div>
                    <div className="col-span-2">
                      <input type="number" min="0" step="100" className="input text-xs text-right w-full"
                             placeholder="Cost (₹)"
                             value={d.planned_grand_total_b}
                             onChange={e => updatePlanDay(i, { planned_grand_total_b: +e.target.value })} />
                    </div>
                  </div>

                  <div className="px-3 py-2">
                    {planBoqItems.length === 0 && !isSunday && (
                      <div className="text-[11px] text-amber-700">No BOQ items found for this site's PO — upload BOQ via Orders & Planning to enable item-level planning.</div>
                    )}
                    {planBoqItems.length > 0 && (
                      <>
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-gray-500">
                              <th className="text-left py-1">BOQ Item</th>
                              <th className="text-right py-1 w-32">Planned Qty</th>
                              <th className="w-8"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {(d.items || []).map((it, j) => {
                              const boq = planBoqItems.find(b => +b.id === +it.po_item_id);
                              return (
                                <tr key={j} className="border-t">
                                  <td className="py-1 pr-2">
                                    <select className="select text-xs w-full"
                                            value={it.po_item_id || ''}
                                            onChange={e => updatePlanItem(i, j, { po_item_id: e.target.value })}>
                                      <option value="">— Pick BOQ item —</option>
                                      {planBoqItems.map(b => (
                                        <option key={b.id} value={b.id}>
                                          {b.description || `Item #${b.id}`}{b.unit ? ` (${b.unit})` : ''}{b.quantity ? ` · BOQ qty: ${b.quantity}` : ''}
                                        </option>
                                      ))}
                                    </select>
                                  </td>
                                  <td className="py-1 text-right">
                                    <input type="number" min="0" step="0.01" className="input text-xs text-right w-full"
                                           value={it.planned_qty || ''}
                                           onChange={e => updatePlanItem(i, j, { planned_qty: +e.target.value })}
                                           disabled={!it.po_item_id}
                                           placeholder={boq?.unit || 'qty'} />
                                  </td>
                                  <td className="py-1 text-center">
                                    <button type="button" onClick={() => removePlanItem(i, j)}
                                            className="text-gray-400 hover:text-red-600 text-lg leading-none px-1"
                                            title="Remove item">×</button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        <button type="button" onClick={() => addPlanItem(i)}
                                className="text-[11px] text-red-600 hover:text-red-800 underline mt-1">
                          + Add BOQ item to this day
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="bg-gray-50 border rounded px-3 py-2 text-xs font-semibold flex justify-between">
            <span>Week Totals</span>
            <span>
              {planDays.reduce((s, d) => s + (+d.planned_manpower || 0), 0)} men-days
              {'  ·  Rs '}
              {planDays.reduce((s, d) => s + (+d.planned_grand_total_b || 0), 0).toLocaleString('en-IN')}
            </span>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t">
            <button onClick={() => setPlanModal(false)} className="btn btn-secondary">Cancel</button>
            <button onClick={savePlanWeek} disabled={planSaving || !planSiteId} className="btn btn-primary">
              {planSaving ? 'Saving…' : 'Save Week Plan'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// LossReasonsTab — management dashboard for DPRs with profit_loss < 0.
// Each row shows the site, date, loss amount, hindrance category + reason
// the engineer filled in, plus a "consecutive loss days" streak. Rows
// with streak >= 3 are highlighted red because they trigger the automatic
// email to director@securedengineers.com.
// Category-to-owner map (mam, 2026-05-16: "if manpower then ruksana,
// material then raj kumar, money then aanchal, machine then ajmer,
// site clearance crm as per site name").  Site Clearance falls back
// to the row's CRM resolved server-side (sites.business_book →
// employee_assigned).  Stored as a constant so future re-assignments
// only need a code change here.
const HINDRANCE_OWNERS = {
  Manpower: 'Ruksana',
  Material: 'Raj Kumar',
  Money: 'Aanchal',
  Machine: 'Ajmer',
};
const ownerFor = (row) => {
  if (row.hindrance_category === 'Site Clearance') {
    return row.site_crm_name || row.supervisor || '—';
  }
  return HINDRANCE_OWNERS[row.hindrance_category] || '—';
};


function LossReasonsTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all'); // 'all' | 'streak3' | 'pending'
  // Proof-attach modal (mam: "on address click proof so that problem
  // can solve and identify").  null = closed; { row, note, file,
  // uploading } when open.
  const [addressModal, setAddressModal] = useState(null);

  const load = () => {
    setLoading(true);
    api.get('/dpr/loss-dashboard').then(r => setRows(r.data || []))
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  // Open the proof-attach modal instead of a bare prompt
  const openAddressModal = (row) => setAddressModal({ row, note: '', file: null, uploading: false });

  // Save: optional file → /api/upload → use returned URL as proof_url.
  // PATCH /dpr/:id/loss-addressed with the note + proof_url.
  const submitAddressed = async () => {
    if (!addressModal) return;
    setAddressModal(a => ({ ...a, uploading: true }));
    let proof_url = null;
    if (addressModal.file) {
      try {
        const fd = new FormData();
        fd.append('file', addressModal.file);
        const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        proof_url = r.data?.url || null;
      } catch {
        toast.error('Proof upload failed — submitting without file');
      }
    }
    try {
      await api.patch(`/dpr/${addressModal.row.id}/loss-addressed`, {
        addressed: true,
        note: addressModal.note || null,
        proof_url,
      });
      toast.success('Marked as addressed');
      setAddressModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
      setAddressModal(a => ({ ...a, uploading: false }));
    }
  };

  // Reverse: unmark (no modal, simple confirm)
  const unmarkAddressed = async (row) => {
    if (!confirm('Re-open this loss row as pending follow-up?')) return;
    try {
      await api.patch(`/dpr/${row.id}/loss-addressed`, { addressed: false });
      toast.success('Re-opened');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  };

  const filtered = rows.filter(r => {
    if (filter === 'streak3') return (r.consecutive_loss_days || 0) >= 3;
    if (filter === 'pending') return !r.loss_addressed;
    return true;
  });

  const streak3Count = rows.filter(r => (r.consecutive_loss_days || 0) >= 3 && !r.loss_addressed).length;
  const totalLoss = rows.reduce((s, r) => s + (+r.profit_loss || 0), 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <button onClick={() => setFilter('all')} className={`card text-left ${filter === 'all' ? 'ring-2 ring-red-400' : ''}`}>
          <div className="text-2xl font-bold text-gray-800">{rows.length}</div>
          <div className="text-xs text-gray-500">All loss DPRs</div>
        </button>
        <button onClick={() => setFilter('streak3')} className={`card text-left ${filter === 'streak3' ? 'ring-2 ring-red-400' : ''}`}>
          <div className="text-2xl font-bold text-red-700">{streak3Count}</div>
          <div className="text-xs text-gray-500">3+ day streaks · pending — director gets emailed</div>
        </button>
        <button onClick={() => setFilter('pending')} className={`card text-left ${filter === 'pending' ? 'ring-2 ring-red-400' : ''}`}>
          <div className="text-2xl font-bold text-amber-700">{rows.filter(r => !r.loss_addressed).length}</div>
          <div className="text-xs text-gray-500">Pending follow-up</div>
        </button>
      </div>

      <div className="card p-3 text-sm text-gray-600 flex items-center justify-between">
        <div>Total loss across all rows: <span className="font-bold text-red-700">Rs {Math.abs(Math.round(totalLoss)).toLocaleString('en-IN')}</span></div>
        <div className="text-xs">Email alerts go to <span className="font-mono">director@securedengineers.com</span> when a site hits 3 consecutive loss days.</div>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Site</th><th>Date</th><th>Loss (P/L)</th><th>Hindrance</th>
              <th>Assigned To</th>
              <th>Reason filled by engineer</th>
              <th>Streak</th><th>Submitted By</th><th>Followed Up?</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan="9" className="text-center py-8 text-gray-400">Loading…</td></tr>}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan="9" className="text-center py-8 text-gray-400">
                {filter === 'all' ? 'No loss DPRs — every site is on track 🎉' : 'Nothing matches this filter.'}
              </td></tr>
            )}
            {filtered.map(r => {
              const owner = ownerFor(r);
              return (
              <tr key={r.id} className={(r.consecutive_loss_days || 0) >= 3 && !r.loss_addressed ? 'bg-red-50/60' : ''}>
                <td className="font-medium">{r.site_name || `Site #${r.site_id}`}</td>
                <td>{r.report_date}</td>
                <td className="font-bold text-red-700">Rs {Math.abs(Math.round(+r.profit_loss || 0)).toLocaleString('en-IN')}</td>
                <td>{r.hindrance_category || <span className="text-gray-400">-</span>}</td>
                {/* Auto-resolved owner per category.  Mam: fixed mapping for
                    Manpower/Material/Money/Machine; Site Clearance =
                    site's CRM. */}
                <td>
                  {owner === '—' ? (
                    <span className="text-gray-400">-</span>
                  ) : (
                    <span className="text-xs font-semibold text-gray-800 bg-amber-100 px-2 py-0.5 rounded">{owner}</span>
                  )}
                </td>
                <td className="max-w-[320px] text-xs text-gray-700 whitespace-normal break-words" title={r.hindrances}>{r.hindrances || <span className="text-gray-400">-</span>}</td>
                <td>
                  {(r.consecutive_loss_days || 0) >= 3
                    ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-800"><FiAlertTriangle size={10} /> {r.consecutive_loss_days} DAYS</span>
                    : <span className="text-xs text-gray-600">{r.consecutive_loss_days || 1} day{r.consecutive_loss_days > 1 ? 's' : ''}</span>}
                </td>
                <td className="text-xs">{r.submitted_by_name || '-'}</td>
                <td>
                  {r.loss_addressed ? (
                    <div className="space-y-0.5">
                      <button onClick={() => unmarkAddressed(r)} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 hover:bg-emerald-200" title={r.loss_addressed_note || ''}>
                        <FiCheck size={10} /> Done by {r.addressed_by_name || '-'}
                      </button>
                      {r.loss_addressed_proof_url && (
                        <a href={r.loss_addressed_proof_url} target="_blank" rel="noopener noreferrer"
                           className="block text-[10px] text-blue-600 hover:text-blue-800 underline">
                          View proof
                        </a>
                      )}
                      {r.loss_addressed_note && <div className="text-[10px] text-gray-500 max-w-[180px] truncate" title={r.loss_addressed_note}>{r.loss_addressed_note}</div>}
                    </div>
                  ) : (
                    <button onClick={() => openAddressModal(r)} className="text-xs btn btn-secondary py-0.5 px-2">Mark addressed</button>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Proof-of-resolution modal */}
      {addressModal && (
        <Modal isOpen={true} onClose={() => !addressModal.uploading && setAddressModal(null)} title="Mark loss as addressed">
          <div className="space-y-3 text-sm">
            <div className="bg-amber-50 border border-amber-200 rounded p-2 text-xs text-gray-700">
              <div><strong>Site:</strong> {addressModal.row.site_name}</div>
              <div><strong>Date:</strong> {addressModal.row.report_date}</div>
              <div><strong>Issue:</strong> {addressModal.row.hindrance_category} — {addressModal.row.hindrances}</div>
              <div><strong>Owner:</strong> {ownerFor(addressModal.row)}</div>
            </div>
            <div>
              <label className="label">How was it resolved?</label>
              <textarea className="input" rows="3"
                        value={addressModal.note}
                        onChange={e => setAddressModal(a => ({ ...a, note: e.target.value }))}
                        placeholder="e.g. Extra 4 helpers arranged from Mohali, deployed 17 May 7 AM" />
            </div>
            <div>
              <label className="label">Attach proof (photo / PDF / receipt)</label>
              <input type="file" accept="image/*,application/pdf"
                     onChange={e => setAddressModal(a => ({ ...a, file: e.target.files?.[0] || null }))}
                     className="text-xs" />
              <p className="text-[10px] text-gray-500 mt-1">
                e.g. site photo showing resolution, vendor invoice, delivery challan, signed clearance email — anything that lets management verify the problem is actually solved.
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t">
              <button onClick={() => setAddressModal(null)} disabled={addressModal.uploading} className="btn btn-secondary">Cancel</button>
              <button onClick={submitAddressed} disabled={addressModal.uploading} className="btn btn-primary">
                {addressModal.uploading ? 'Saving…' : 'Mark Addressed'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
