import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import ResponsibilityTab from '../components/ResponsibilityTab';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiSearch, FiFilter, FiEye, FiCheck, FiX, FiClock, FiCheckCircle, FiXCircle, FiUpload, FiTrash2, FiDownload, FiSettings, FiFile } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { fmtISTPair } from '../utils/dateIST';
import { LuIndianRupee } from 'react-icons/lu';

const CATEGORIES = ['TA/DA', 'Purchase', 'Labour', 'Transport', 'Salary', 'Compliance', 'Manpower Advance'];
const STATUSES = ['pending', 'step1_approved', 'accounts_approved', 'dues_checked', 'velocity_checked', 'final_approved', 'rejected'];
const STATUS_LABELS = { pending: 'Pending', step1_approved: 'Step 1 Approved', accounts_approved: 'Accounts Approved', dues_checked: 'Dues Checked', velocity_checked: 'Velocity Checked', final_approved: 'Final Approved', rejected: 'Rejected' };
// One standard flow for every category (mam 2026-06-11):
// L1 Accountant → L2 Nitin Jain → L3 Ankur Kaplesh → Payment Release Aanchal.
// Step numbers (1,2,3,5) match the server WORKFLOW exactly.
const STEPS = [
  { step: 1, name: 'L1 Approval (Accountant)' },
  { step: 2, name: 'L2 Approval (Nitin Jain)' },
  { step: 3, name: 'L3 Approval (MD - Ankur Kaplesh)' },
  { step: 5, name: 'Payment Release (Aanchal)' },
];
// TA/DA gets an HR pre-approval step (mam 2026-06-17): HR (Prabhdeep Singh)
// before L1 Accountant, for new requests from 15/06/2026.
const TADA_STEPS = [{ step: 0, name: 'HR Approval (Prabhdeep Singh)' }, ...STEPS];

// Canonical order of LIVE workflow stages for the dashboard tiles/chips
// (union of the 5-step and TA/DA workflows). Mam (2026-05-30): the stage
// tiles used to count by the coarse `status`, which stays 'pending' for
// every in-flight request — so everything piled into "HR Approval" and
// the later stages showed 0. A request's true stage is its live
// current_step_name; terminal states fall back to status.
const STAGE_SEQ = ['HR Approval (Prabhdeep Singh)', 'L1 Approval (Accountant)', 'L2 Approval (Nitin Jain)', 'L3 Approval (MD - Ankur Kaplesh)', 'Payment Release (Aanchal)'];
const stageOf = (r) =>
  r.status === 'final_approved' ? 'Approved'
  : r.status === 'rejected' ? 'Rejected'
  : (r.current_step_name || STAGE_SEQ[0]);

// Default 'Required By Date' is today + 5 days — immediate payments can't be
// processed so we set a realistic lead time.
const defaultRequiredByDate = () => {
  const d = new Date();
  d.setDate(d.getDate() + 5);
  return d.toISOString().split('T')[0];
};
// TA/DA travel date window: today and the previous 3 days only — no future
// dates (mam 2026-06-11: travel is already done, claim it within 3 days).
const todayStr = () => new Date().toISOString().split('T')[0];
const minTravelDate = () => {
  const d = new Date();
  d.setDate(d.getDate() - 3);
  return d.toISOString().split('T')[0];
};

const emptyForm = {
  employee_name: '', site_id: '', site_name: '', department: '', contact_number: '',
  category: '', amount: 0, purpose: '', payment_mode: 'Bank', required_by_date: defaultRequiredByDate(),
  travel_from_to: '', travel_dates: '', mode_of_travel: '', stay_details: '',
  ticket_upload: '', start_km: 0, end_km: 0, km_photo: '',
  indent_number: '', item_description: '', vendor_name: '', quotation_link: '', advance_proof: '',
  labour_type: '', number_of_workers: 0, work_duration: '', site_engineer_name: '',
  vehicle_type: '', from_to_location: '', material_description: '', driver_vendor_name: '',
};

export default function PaymentRequired() {
  const { canCreate, canApprove, canDelete, user } = useAuth();
  const [tab, setTab] = useUrlTab('dashboard');
  // Mam (2026-05-30): My Inbox tab removed.  Old bookmarks pointing
  // at ?tab=inbox land back on Dashboard so they don't dead-end.
  useEffect(() => {
    if (tab === 'inbox') setTab('dashboard');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  const [requests, setRequests] = useState([]);
  // Bulk approve (mam 2026-06-25): pick a person, see all their pending with
  // proof, tick-tick approve — instead of opening each one by one.
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkRows, setBulkRows] = useState([]);
  const [bulkSel, setBulkSel] = useState(() => new Set());
  const [bulkSearch, setBulkSearch] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkStage, setBulkStage] = useState('');        // level filter inside the modal
  const [bulkRejectReason, setBulkRejectReason] = useState('');
  // Per-record RACI editor (mam 2026-06-25: pick R/A/C/I + time per record/step)
  const [raciFor, setRaciFor] = useState(null);          // the record being edited
  const [raciSteps, setRaciSteps] = useState([]);
  const [raciUsers, setRaciUsers] = useState([]);
  const [raciBusy, setRaciBusy] = useState(false);
  // Mam (2026-05-22): "My Inbox" — payment requests where the
  // current step's approver is THIS user.  Fetched separately so
  // we can also use the count for the badge on the tab.
  const [myInbox, setMyInbox] = useState([]);
  const [myInboxCount, setMyInboxCount] = useState(0);
  const [stats, setStats] = useState(null);
  const [sites, setSites] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [modal, setModal] = useState(null);
  const [viewData, setViewData] = useState(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ status: '', category: '', date_from: '', date_to: '' });
  // Client-side filter by LIVE workflow stage (current_step_name / Approved /
  // Rejected). Set by clicking a stage tile or chip. Empty = all stages.
  const [stageFilter, setStageFilter] = useState('');
  // "Approved by L1/L2/L3" view (mam 2026-06-15): step number 1/2/3, or null.
  // When set, the list shows requests that level has signed off and the
  // Approval Amt column shows the amount THAT level approved. Mutually
  // exclusive with stageFilter (the pending-stage chips).
  const [approvedLevel, setApprovedLevel] = useState(null);
  const APPROVED_LEVELS = [{ step: 1, label: 'Approved by L1' }, { step: 2, label: 'Approved by L2' }, { step: 3, label: 'Approved by L3' }];
  const clearedAt = (r, step) => !!(r.step_amounts && r.step_amounts[step] != null);
  const [uploading, setUploading] = useState(false);

  // Approval routing — admin-only (mam, 2026-05-16: "i want hr
  // approval will give to anchal how can be it dynamic all steps").
  // Loads on demand when the Settings modal opens to avoid an extra
  // request on every page load.
  const [routingModal, setRoutingModal] = useState(false);
  const [routingMatrix, setRoutingMatrix] = useState(null);
  const [routingUsers, setRoutingUsers] = useState([]);
  const [routingSaving, setRoutingSaving] = useState({});
  const isAdmin = user?.role === 'admin';

  const openRoutingModal = async () => {
    setRoutingModal(true);
    setRoutingMatrix(null);
    try {
      // Load matrix and users in parallel.  Split error handling so a
      // failure on one call doesn't blank the other half.
      let matrix = null, users = [];
      try {
        const m = await api.get('/payment-required/approval-routing');
        matrix = m.data?.matrix || {};
      } catch (e1) {
        toast.error(`Routing endpoint failed: ${e1.response?.data?.error || e1.message}`);
      }
      try {
        const u = await api.get('/auth/users');
        users = (u.data || []).filter(x => x.active !== 0);
      } catch (e2) {
        toast.error(`Users endpoint failed: ${e2.response?.data?.error || e2.message}`);
      }
      // Even if users failed we still want to show the matrix (admin
      // can at least see current assignments).  Default to empty
      // matrix when the route is missing entirely so the modal
      // doesn't sit forever on "Loading…".
      setRoutingMatrix(matrix || {});
      setRoutingUsers(users);
    } catch (e) {
      toast.error('Failed to load routing');
    }
  };
  const saveRouting = async (category, step, user_id) => {
    const key = `${category}_${step}`;
    setRoutingSaving(s => ({ ...s, [key]: true }));
    try {
      await api.put('/payment-required/approval-routing', { category, step, user_id });
      // Optimistically update the local matrix so the modal reflects the change immediately
      setRoutingMatrix(prev => ({
        ...prev,
        [category]: prev[category].map(s => s.step === step
          ? { ...s, override_user_id: user_id || null, override_user_name: user_id ? routingUsers.find(u => +u.id === +user_id)?.name || null : null }
          : s),
      }));
      toast.success('Routing updated');
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed');
    } finally {
      setRoutingSaving(s => ({ ...s, [key]: false }));
    }
  };

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
    api.get(`/payment-required?${params}`).then(r => setRequests(r.data)).catch(() => {});
    api.get('/payment-required/stats').then(r => setStats(r.data)).catch(() => {});
    // Mam (2026-05-30): My Inbox tab removed → no need to fetch the
    // inbox list or poll the count.  Endpoints remain on the server
    // for any external consumer / future re-introduction.
  }, [search, filters]);

  useEffect(() => {
    load();
    // ?all=1 → any employee raising a payment request can pick from ALL
    // sites (not just ones they're assigned to as a site engineer). Matches
    // mam's ask on 2026-04-23.
    api.get('/dpr/sites?all=1').then(r => setSites(r.data)).catch(() => {});
    api.get('/hr/employees').then(r => setEmployees(r.data)).catch(() => {});
    api.get('/procurement/vendors').then(r => setVendors(r.data || [])).catch(() => {});
  }, [load]);

  // Mandatory-proof validation per category + mode (mam: 'if proof
  // mandatory then why missing'). Block submission until every required
  // receipt is attached — same rules as the approval-modal audit view.
  const requiredProofsMissing = (f) => {
    const missing = [];
    if (f.category === 'TA/DA') {
      if (['Bus','Bus / Rapido','Train','Flight'].includes(f.mode_of_travel) && !f.ticket_upload) {
        missing.push('Travel Ticket');
      }
      if (['Car','Bike'].includes(f.mode_of_travel)) {
        if (!f.km_photo) missing.push('Start KM Photo');
        if (!f.end_km_photo) missing.push('End KM Photo');
      }
    }
    if (f.category === 'Purchase' && !f.quotation_link) {
      missing.push('Quotation / Purchase Order');
    }
    // Manpower Advance: at least one proof document is mandatory (mam 2026-06-29).
    if (f.category === 'Manpower Advance' && !f.advance_proof) {
      missing.push('Proof / Document');
    }
    return missing;
  };

  const [saving, setSaving] = useState(false);   // create-request in flight — blocks double-submit
  const handleSave = async (e) => {
    e.preventDefault();
    if (saving) return;   // guard double-submit — repeated clicks were creating duplicate PRs
    // TA/DA travel date must be today or within the previous 3 days — no future.
    if (form.category === 'TA/DA' && form.travel_dates && (form.travel_dates < minTravelDate() || form.travel_dates > todayStr())) {
      return toast.error(`Travel Date must be between ${minTravelDate()} and ${todayStr()} (today or up to 3 days back).`, { duration: 7000 });
    }
    const missing = requiredProofsMissing(form);
    if (missing.length > 0) {
      return toast.error(`Upload required proof${missing.length > 1 ? 's' : ''} before submitting: ${missing.join(', ')}`, { duration: 7000 });
    }
    setSaving(true);
    try {
      const res = await api.post('/payment-required', form);
      toast.success(`Request ${res.data.request_no} created`);
      setModal(null); setForm({ ...emptyForm }); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
    finally { setSaving(false); }
  };

  const [approvalRemarks, setApprovalRemarks] = useState('');
  // Approver-side amount adjustment (mam 2026-05-28). String state so
  // an empty input doesn't snap to 0 mid-typing.
  const [approvalAmount, setApprovalAmount] = useState('');
  // Admin amount edit (mam 2026-06-17, e.g. salary increase). null = not
  // editing; a string = the value being typed.
  const [editAmt, setEditAmt] = useState(null);

  const saveAmount = async () => {
    const n = +editAmt;
    if (!Number.isFinite(n) || n <= 0) return toast.error('Enter a valid amount');
    try {
      const res = await api.patch(`/payment-required/${viewData.id}/amount`, { amount: n });
      toast.success(res.data.message || 'Amount updated');
      setEditAmt(null);
      setViewData(prev => ({ ...prev, amount: n, approved_amount: n }));
      setApprovalAmount(String(n));
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to update amount'); }
  };

  const handleApprove = async (id) => {
    // Remarks are OPTIONAL when approving (mam 2026-06-18) — only a
    // rejection needs a reason. Don't block approval on an empty box.
    const original = +(viewData?.amount || 0);
    const n = approvalAmount === '' ? null : +approvalAmount;
    if (n !== null) {
      if (!Number.isFinite(n) || n <= 0) return toast.error('Approved amount must be greater than 0');
      if (n > original) return toast.error(`Approved amount cannot exceed the requested Rs ${original.toLocaleString('en-IN')}`);
    }
    try {
      const res = await api.put(`/payment-required/${id}/approve`, { remarks: approvalRemarks, approved_amount: n });
      toast.success(res.data.message); setApprovalRemarks(''); setApprovalAmount(''); load(); setModal(null); setViewData(null);
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const handleReject = async (id) => {
    if (!approvalRemarks || approvalRemarks.trim().length < 5) {
      return toast.error('Please enter rejection reason (minimum 5 characters)');
    }
    try {
      const res = await api.put(`/payment-required/${id}/reject`, { remarks: approvalRemarks });
      toast.success(res.data.message); setApprovalRemarks(''); load(); setModal(null); setViewData(null);
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const viewRequest = async (id) => {
    const { data } = await api.get(`/payment-required/${id}`);
    // Pre-fill the approval amount input with the latest agreed figure
    // so the approver sees what they're carrying forward; they can edit
    // before clicking Approve.
    const current = data.approved_amount != null ? data.approved_amount : data.amount;
    setApprovalAmount(current != null ? String(current) : '');
    setApprovalRemarks('');
    setViewData(data); setModal('view');
  };

  // Deep-link from the War Room "Open ↗" button — auto-open a specific
  // request's proof view so the approver can verify it (mam 2026-06-24).
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('view');
    if (id) viewRequest(id).catch(() => toast.error('Could not open that payment request'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Bulk approve: load only the requests pending MY step (/my-inbox), let
  // the approver filter by person, eyeball the proofs, and approve in one go.
  const openBulk = async () => {
    setBulkOpen(true); setBulkBusy(true); setBulkSearch(''); setBulkRejectReason('');
    setBulkStage(stageFilter || '');               // scope to the level pill you clicked (e.g. L3)
    try {
      const r = await api.get('/payment-required/my-inbox');
      const rows = r.data || [];
      setBulkRows(rows);
      // tick only the ones matching the active level so "click L3 → Bulk" pre-selects L3 only
      const stage = stageFilter || '';
      setBulkSel(new Set(rows.filter(x => !stage || x.current_step_name === stage).map(x => x.id)));
    } catch { toast.error('Could not load your pending approvals'); }
    finally { setBulkBusy(false); }
  };
  const toggleBulk = (id) => setBulkSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const bulkVisible = bulkRows.filter(r => {
    const q = bulkSearch.trim().toLowerCase();
    const matchQ = !q || (r.employee_name || r.created_by_name || '').toLowerCase().includes(q) || (r.request_no || '').toLowerCase().includes(q);
    const matchStage = !bulkStage || r.current_step_name === bulkStage;
    return matchQ && matchStage;
  });
  const setAllVisible = (on) => setBulkSel(s => { const n = new Set(s); bulkVisible.forEach(r => on ? n.add(r.id) : n.delete(r.id)); return n; });
  const bulkPickedCount = bulkVisible.filter(r => bulkSel.has(r.id)).length;
  const bulkSelectedTotal = bulkVisible.filter(r => bulkSel.has(r.id)).reduce((s, r) => s + Number(r.approved_amount ?? r.amount ?? 0), 0);
  const approveBulk = async () => {
    const ids = bulkVisible.filter(r => bulkSel.has(r.id)).map(r => r.id);
    if (!ids.length) return toast.error('Tick at least one request');
    setBulkBusy(true);
    try {
      const r = await api.post('/payment-required/bulk-approve', { ids });
      const { approved = [], skipped = [] } = r.data || {};
      toast.success(`Approved ${approved.length}${skipped.length ? ` · ${skipped.length} skipped` : ''}`);
      setBulkOpen(false); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Bulk approve failed'); }
    finally { setBulkBusy(false); }
  };
  // Open the per-record RACI editor for one request: load its saved RACI +
  // (once) the employee list for the dropdowns.
  const openRaci = async (record) => {
    setRaciFor(record); setRaciBusy(true);
    try {
      const [cfg, usr] = await Promise.all([
        api.get(`/raci/record/payables/${record.id}`),
        raciUsers.length ? Promise.resolve({ data: raciUsers }) : api.get('/auth/users'),
      ]);
      setRaciSteps(cfg.data.steps || []);
      if (!raciUsers.length) setRaciUsers((usr.data || []).filter(u => u.active !== 0));
    } catch { toast.error('Could not load RACI'); }
    finally { setRaciBusy(false); }
  };
  const setRaciField = (i, k, v) => setRaciSteps(s => s.map((x, idx) => idx === i ? { ...x, [k]: v } : x));
  const saveRaci = async () => {
    if (!raciFor) return;
    setRaciBusy(true);
    try {
      await api.put(`/raci/record/payables/${raciFor.id}`, {
        steps: raciSteps.map(s => ({
          step_key: s.key,
          responsible_id: s.responsible_id || null, accountable_id: s.accountable_id || null,
          consulted_id: s.consulted_id || null, informed_id: s.informed_id || null,
          sla_hours: s.sla_hours === '' || s.sla_hours == null ? null : +s.sla_hours,
        })),
      });
      toast.success('RACI saved'); setRaciFor(null); openBulk();   // refresh late badges
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
    finally { setRaciBusy(false); }
  };
  const rejectBulk = async () => {
    const ids = bulkVisible.filter(r => bulkSel.has(r.id)).map(r => r.id);
    if (!ids.length) return toast.error('Tick at least one request');
    if (bulkRejectReason.trim().length < 5) return toast.error('Enter a rejection reason (min 5 characters) to reject');
    if (!confirm(`Reject ${ids.length} selected request(s)? This cannot be undone.`)) return;
    setBulkBusy(true);
    try {
      const r = await api.post('/payment-required/bulk-reject', { ids, remarks: bulkRejectReason.trim() });
      const { rejected = [], skipped = [] } = r.data || {};
      toast.success(`Rejected ${rejected.length}${skipped.length ? ` · ${skipped.length} skipped` : ''}`);
      setBulkOpen(false); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Bulk reject failed'); }
    finally { setBulkBusy(false); }
  };

  const F = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const fmt = (n) => `Rs ${(n || 0).toLocaleString('en-IN')}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><LuIndianRupee className="text-orange-600" /> Payment Required</h1>
          <p className="text-sm text-gray-500">Request payments with multi-level approval workflow</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => exportCsv('payment-requests',
            ['Req No','Employee','Site','Category','Amount','Purpose','Step','Status','Required By','Created'],
            requests.map(r => [r.request_no, r.employee_name, r.site_name, r.category, r.amount, r.purpose, r.current_step, r.status, r.required_by_date, r.created_at]))}
            className="btn btn-secondary flex items-center gap-2"><FiDownload size={16} /> Export Excel</button>
          {isAdmin && (
            <button onClick={openRoutingModal} className="btn btn-secondary flex items-center gap-2"
                    title="Re-assign approval steps to specific users (HR → Aanchal, etc.)">
              <FiSettings size={16} /> Approval Routing
            </button>
          )}
          {canApprove('payment_required') && (
            <button onClick={openBulk} className="btn btn-secondary flex items-center gap-2"
                    title="Approve many of your pending requests at once — filter by person, see proofs, tick-tick approve">
              <FiCheckCircle size={16} /> Bulk Approve
            </button>
          )}
          {canCreate('payment_required') && (
            <button onClick={() => { setForm({ ...emptyForm, employee_name: user?.name || '', required_by_date: defaultRequiredByDate() }); setModal('add'); }} className="btn btn-primary flex items-center gap-2"><FiPlus size={16} /> New Request</button>
          )}
        </div>
      </div>

      {/* Mam (2026-05-30): "in this delete my inbox" — removed the
          📥 My Inbox tab + badge from the strip.  The per-user
          /payment-required/my-inbox(*) endpoints stay on the server
          (no migration needed) — they're just no longer surfaced
          here.  If anyone lands on ?tab=inbox via bookmark, the
          redirect effect just below kicks them to Dashboard. */}
      <div className="flex gap-2 flex-wrap">
        {['dashboard', 'all', 'pending', 'approved', 'rejected', 'responsible'].map(t => {
          const label = t === 'all' ? 'All Requests'
                      : t === 'responsible' ? '⚙ Responsible'
                      : t.charAt(0).toUpperCase() + t.slice(1);
          return (
            <button key={t} onClick={() => setTab(t)} className={`btn ${tab === t ? 'btn-primary' : 'btn-secondary'} text-sm`}>
              {label}
            </button>
          );
        })}
      </div>

      {tab === 'responsible' && <ResponsibilityTab module="payables" title="Payables" />}

      {/* Dashboard */}
      {tab === 'dashboard' && stats && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="card p-4 border-l-4 border-red-500"><p className="text-xs text-gray-500">Total Requests</p><p className="text-2xl font-bold">{stats.total}</p></div>
            <div className="card p-4 border-l-4 border-orange-500"><p className="text-xs text-gray-500">Total Amount</p><p className="text-2xl font-bold text-orange-600">{fmt(stats.totalAmount)}</p></div>
            <div className="card p-4 border-l-4 border-amber-500"><p className="text-xs text-gray-500">Pending</p><p className="text-2xl font-bold text-amber-600">{stats.pending}</p></div>
            <div className="card p-4 border-l-4 border-emerald-500"><p className="text-xs text-gray-500">Approved</p><p className="text-2xl font-bold text-emerald-600">{stats.approved}</p></div>
            <div className="card p-4 border-l-4 border-red-500"><p className="text-xs text-gray-500">Rejected</p><p className="text-2xl font-bold text-red-600">{stats.rejected}</p></div>
          </div>

          {/* Category breakdown */}
          {stats.byCategory?.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {stats.byCategory.map(c => (
                <div key={c.category} className="card p-3"><p className="text-xs text-gray-500">{c.category}</p><p className="font-bold">{c.count} requests</p><p className="text-sm text-gray-600">{fmt(c.amount)}</p></div>
              ))}
            </div>
          )}

          {/* Pending approvals */}
          {stats.pendingApprovals?.length > 0 && (
            <div className="card p-0 overflow-x-auto">
              <div className="p-4 border-b bg-amber-50"><h4 className="font-semibold text-amber-800">Pending Approvals</h4></div>
              <table><thead><tr><th>Req No</th><th>Employee</th><th>Category</th><th>Amount</th><th>Step</th><th>Actions</th></tr></thead>
                <tbody>{stats.pendingApprovals.map(r => (
                  <tr key={r.id}>
                    <td className="font-bold text-red-600 cursor-pointer" onClick={() => viewRequest(r.id)}>{r.request_no}</td>
                    <td>{r.employee_name}</td><td><span className="badge badge-blue">{r.category}</span></td>
                    <td className="font-semibold">{fmt(r.amount)}</td>
                    {/* Mam (2026-05-22): same enrichment as the All
                        Requests table — show approver names so the
                        TA/DA Pending tab also explains where stuck. */}
                    <td className="text-[11px]">
                      <div className="flex items-center gap-1 mb-0.5">
                        <span className="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-mono text-[10px]">{r.approvals_count || 0}/{r.approvals_total || 2}</span>
                        {r.current_step_name && <span className="text-amber-700 font-medium">{r.current_step_name}</span>}
                      </div>
                      {r.last_approved_by_name && <div className="text-[10px] text-emerald-700">✓ by <b>{r.last_approved_by_name}</b></div>}
                      {(r.next_approver_name || r.next_approver_role) && (
                        <div className="text-[10px] text-amber-800">⏳ {r.next_approver_name ? <b>{r.next_approver_name}</b> : <>any <b>{r.next_approver_role}</b></>}</div>
                      )}
                    </td>
                    <td><div className="flex gap-1">
                      <button onClick={() => viewRequest(r.id)} className="p-1 hover:bg-red-50 rounded text-red-600"><FiEye size={14} /></button>
                      {canApprove('payment_required') && <>
                        <button onClick={() => viewRequest(r.id)} className="p-1 hover:bg-amber-50 rounded text-amber-600 font-bold text-xs">Review</button>
                      </>}
                    </div></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Request List */}
      {tab !== 'dashboard' && (
        <>
          <div className="flex gap-3 flex-wrap items-end">
            <div className="relative flex-1 min-w-[200px]"><FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
              <input className="input pl-10" placeholder="Search by employee, request no, purpose, site..." value={search} onChange={e => setSearch(e.target.value)} /></div>
            <div>
              <label className="block text-[9px] font-bold uppercase text-gray-500 leading-none mb-0.5">From</label>
              <input type="date" className="select w-36" value={filters.date_from} onChange={e => setFilters(f => ({ ...f, date_from: e.target.value }))} />
            </div>
            <div>
              <label className="block text-[9px] font-bold uppercase text-gray-500 leading-none mb-0.5">To</label>
              <input type="date" className="select w-36" value={filters.date_to} onChange={e => setFilters(f => ({ ...f, date_to: e.target.value }))} />
            </div>
            <select className="select w-40" value={filters.category} onChange={e => setFilters(f => ({ ...f, category: e.target.value }))}><option value="">All Categories</option>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select>
            <select className="select w-40" value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}><option value="">All Status</option>{STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}</select>
            {(filters.date_from || filters.date_to || filters.category || filters.status || stageFilter || search) && (
              <button onClick={() => { setSearch(''); setStageFilter(''); setApprovedLevel(null); setFilters({ status: '', category: '', date_from: '', date_to: '' }); }}
                className="btn btn-secondary text-xs flex items-center gap-1 text-red-600 whitespace-nowrap">
                <FiX size={12} /> Clear filters
              </button>
            )}
          </div>

          {/* Mam (2026-05-22): "give me one small dashbaord of total
              amount as per my filter change" — live totals strip
              that recomputes from the SAME filter chain used by the
              table below.  Refreshes instantly as admin types in the
              search box or picks a different tab / category.
              My Inbox tab reads from the separately-fetched myInbox
              array (server-filtered to current-step-approver = me).
              Mam 2026-05-29: split the 'Pending' tile into per-stage
              tiles so she can see WHERE each approval is stuck.
              Each tile is clickable — clicking it applies the matching
              status filter, so she can drill into 'who's holding up
              the 142 requests waiting at Accountant?' in one click. */}
          {(() => {
            const source = tab === 'inbox' ? myInbox : requests;
            const visible = source.filter(r => {
              if (tab === 'pending')  return !['final_approved','rejected'].includes(r.status);
              if (tab === 'approved') return r.status === 'final_approved';
              if (tab === 'rejected') return r.status === 'rejected';
              return true;
            });
            // Count + sum by LIVE stage (current_step_name) instead of the
            // coarse status — so each request lands in the step it's
            // actually at. stage===null means "all".
            const rowsOf = (stage) => stage == null ? visible : visible.filter(r => stageOf(r) === stage);
            const PALETTE = [
              { border: 'border-amber-500',  label: 'text-amber-700',  num: 'text-amber-700',  activeBg: 'bg-amber-50',  ring: 'ring-amber-300' },
              { border: 'border-orange-500', label: 'text-orange-700', num: 'text-orange-700', activeBg: 'bg-orange-50', ring: 'ring-orange-300' },
              { border: 'border-purple-500', label: 'text-purple-700', num: 'text-purple-700', activeBg: 'bg-purple-50', ring: 'ring-purple-300' },
              { border: 'border-indigo-500', label: 'text-indigo-700', num: 'text-indigo-700', activeBg: 'bg-indigo-50', ring: 'ring-indigo-300' },
              { border: 'border-sky-500',    label: 'text-sky-700',    num: 'text-sky-700',    activeBg: 'bg-sky-50',    ring: 'ring-sky-300' },
            ];
            // Always show the full standard flow (L1 → L2 → L3 → Release),
            // even a stage with 0 rows, so L3 Ankur Kaplesh is never hidden
            // just because no request sits there yet (mam 2026-06-11).
            const presentStages = STAGE_SEQ;
            const tiles = [
              { key: 'all', label: 'Showing', stage: null, color: { border: 'border-blue-500', label: 'text-gray-500', num: 'text-blue-700', activeBg: 'bg-blue-50', ring: 'ring-blue-300' } },
              ...presentStages.map((st, i) => ({ key: st, label: st, stage: st, color: PALETTE[i % PALETTE.length] })),
              { key: 'Approved', label: 'Approved', stage: 'Approved', color: { border: 'border-emerald-500', label: 'text-emerald-700', num: 'text-emerald-700', activeBg: 'bg-emerald-50', ring: 'ring-emerald-300' } },
              { key: 'Rejected', label: 'Rejected', stage: 'Rejected', color: { border: 'border-rose-500', label: 'text-rose-700', num: 'text-rose-700', activeBg: 'bg-rose-50', ring: 'ring-rose-300' } },
            ];
            const tile = ({ key, label, stage, color }) => {
              const rows = rowsOf(stage);
              const amt = rows.reduce((s, r) => s + (+r.amount || 0), 0);
              const active = stage != null && stageFilter === stage && !approvedLevel;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => { setApprovedLevel(null); setStageFilter(active ? '' : (stage || '')); }}
                  disabled={stage == null}
                  className={`card px-2 py-1.5 border-l-4 text-left transition hover:shadow disabled:cursor-default disabled:hover:shadow-none ${color.border} ${active ? `${color.activeBg} ring-2 ${color.ring}` : ''}`}
                  title={`${label} · ${rows.length} ${rows.length === 1 ? 'request' : 'requests'} · Rs ${fmt(amt)}`}
                >
                  <div className={`text-[9px] uppercase font-semibold leading-tight truncate ${color.label}`}>{label}</div>
                  <div className="flex items-baseline gap-1.5 mt-0.5">
                    <span className={`text-base font-bold leading-none ${color.num}`}>{rows.length}</span>
                    <span className="text-[10px] text-gray-600 leading-none truncate">Rs {fmt(amt)}</span>
                  </div>
                </button>
              );
            };
            return (
              <div className="grid grid-cols-4 md:grid-cols-8 gap-1.5">
                {tiles.map(tile)}
              </div>
            );
          })()}

          {/* "Approved so far by L1/L2/L3" views (mam 2026-06-15): requests
              each level has signed off + the amount it approved. The stage
              filters all live in the clickable tiles above now — this row
              used to duplicate them, which mam called "a mess" (2026-06-18),
              so it shows ONLY these per-level approved views. */}
          {(() => {
            const source = tab === 'inbox' ? myInbox : requests;
            const visible = source.filter(r => {
              if (tab === 'pending')  return !['final_approved','rejected'].includes(r.status);
              if (tab === 'approved') return r.status === 'final_approved';
              if (tab === 'rejected') return r.status === 'rejected';
              return true;
            });
            return (
              <div className="flex gap-1.5 flex-wrap items-center">
                <span className="text-[10px] uppercase font-semibold text-gray-500 mr-1">Approved so far:</span>
                {APPROVED_LEVELS.map(lv => {
                  const lvRows = visible.filter(r => clearedAt(r, lv.step));
                  const n = lvRows.length;
                  const amt = lvRows.reduce((s, r) => s + (+r.step_amounts[lv.step] || 0), 0);
                  const active = approvedLevel === lv.step;
                  return (
                    <button
                      key={lv.step}
                      onClick={() => { setStageFilter(''); setApprovedLevel(active ? null : lv.step); }}
                      className={`text-xs font-semibold px-2.5 py-1 rounded-full border transition flex items-center gap-1.5 bg-green-100 text-green-700 border-green-200 ${active ? 'ring-2 ring-offset-1 ring-green-500' : 'opacity-70 hover:opacity-100'}`}
                    >
                      ✓ {lv.label}
                      <span className={`text-[10px] font-bold rounded-full bg-white/70 px-1.5 ${n === 0 ? 'text-gray-400' : ''}`}>{n}</span>
                      {amt > 0 && <span className="text-[10px] font-semibold opacity-90">Rs {fmt(amt)}</span>}
                    </button>
                  );
                })}
              </div>
            );
          })()}

          {/* ─── MOBILE CARDS (mam 2026-06-02) ───────────────────── */}
          <div className="md:hidden space-y-3">
            {(tab === 'inbox' ? myInbox : requests).filter(r => {
              if (tab === 'pending' && ['final_approved', 'rejected'].includes(r.status)) return false;
              if (tab === 'approved' && r.status !== 'final_approved') return false;
              if (tab === 'rejected' && r.status !== 'rejected') return false;
              if (approvedLevel) { if (!clearedAt(r, approvedLevel)) return false; }
              else if (stageFilter && stageOf(r) !== stageFilter) return false;
              return true;
            }).map(r => {
              const { date, time } = fmtISTPair(r.created_at);
              return (
                <div key={r.id} className="card p-3 space-y-2">
                  <div className="flex justify-between items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Request</div>
                      <div className="text-base font-bold text-red-600 cursor-pointer" onClick={() => viewRequest(r.id)}>{r.request_no}</div>
                      <div className="text-xs text-gray-700 font-medium truncate">{r.employee_name}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold text-gray-900">{fmt(r.amount)}</div>
                      {r.approved_amount != null && +r.approved_amount !== +r.amount && (
                        <div className="text-[11px] font-semibold text-emerald-700">approved {fmt(r.approved_amount)}</div>
                      )}
                      <div className="mt-1"><StatusBadge status={r.status} /></div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className={`badge ${r.category === 'TA/DA' ? 'badge-purple' : r.category === 'Purchase' ? 'badge-blue' : r.category === 'Labour' ? 'badge-green' : 'badge-gray'}`}>{r.category}</span>
                    <span className="text-gray-500 truncate">{r.site_display || r.site_name || '—'}</span>
                  </div>
                  <div className="text-xs text-gray-600 leading-snug break-words" title={r.purpose}>{r.purpose}</div>
                  {(r.item_description || r.material_description || r.stay_details || r.travel_from_to) && (
                    <div className="text-[10px] text-gray-500 break-words">
                      {r.item_description && <span>📦 {r.item_description} </span>}
                      {r.material_description && <span>🚚 {r.material_description} </span>}
                      {r.stay_details && <span>🏨 {r.stay_details} </span>}
                      {r.travel_from_to && <span>✈️ {r.travel_from_to}</span>}
                    </div>
                  )}
                  <div className="pt-2 border-t border-gray-100 text-[11px] space-y-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className="bg-gray-100 px-2 py-0.5 rounded font-mono">{r.approvals_count || 0}/{r.approvals_total || 5}</span>
                      {r.current_step_name && r.status !== 'final_approved' && r.status !== 'rejected' && (
                        <span className="text-amber-700 font-medium">→ {r.current_step_name}</span>
                      )}
                    </div>
                    {r.last_approved_by_name && (
                      <div className="text-emerald-700">✓ {r.last_approved_step_name} by <b>{r.last_approved_by_name}</b></div>
                    )}
                    {r.status !== 'final_approved' && r.status !== 'rejected' && (r.next_approver_name || r.next_approver_role) && (
                      <div className="text-amber-800">⏳ Waiting on {r.next_approver_name ? <b>{r.next_approver_name}</b> : <>any <b>{r.next_approver_role}</b></>}</div>
                    )}
                  </div>
                  <div className="flex justify-between items-center pt-1 border-t border-gray-100 text-[10px] text-gray-500">
                    <span>{date} · {time}</span>
                    <div className="flex gap-1">
                      <button onClick={() => viewRequest(r.id)} className="p-1.5 text-gray-400 hover:text-red-600 rounded"><FiEye size={14} /></button>
                      {canApprove('payment_required') && r.status !== 'final_approved' && r.status !== 'rejected' && (
                        <button onClick={() => viewRequest(r.id)} className="btn btn-secondary text-[10px] py-0.5 px-2">Review</button>
                      )}
                      {canDelete('payment_required') && <button onClick={async () => {
                        if (!confirm(`Delete request "${r.request_no}"?`)) return;
                        try { await api.delete(`/payment-required/${r.id}`); toast.success('Deleted'); load(); }
                        catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                      }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={12} /></button>}
                    </div>
                  </div>
                </div>
              );
            })}
            {requests.length === 0 && <div className="card p-6 text-center text-gray-400 text-sm">No requests found</div>}
          </div>

          {/* ─── DESKTOP TABLE (md+) ───────────────────────────────── */}
          <div className="hidden md:block card p-0"><table className="freeze-head">
            <thead><tr><th>Req No</th><th>Employee</th><th>Site</th><th>Category</th><th>Amount</th><th title="Amount the approver agreed — may be less than requested">Approval Amt</th><th>Purpose</th><th>Step</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead>
            <tbody>
              {(tab === 'inbox' ? myInbox : requests).filter(r => {
                if (tab === 'pending' && ['final_approved', 'rejected'].includes(r.status)) return false;
                if (tab === 'approved' && r.status !== 'final_approved') return false;
                if (tab === 'rejected' && r.status !== 'rejected') return false;
                // "Approved by Lx" view, else the live-stage chip filter.
                if (approvedLevel) { if (!clearedAt(r, approvedLevel)) return false; }
                else if (stageFilter && stageOf(r) !== stageFilter) return false;
                return true;
              }).map(r => (
                <tr key={r.id}>
                  <td className="font-bold text-red-600 cursor-pointer" onClick={() => viewRequest(r.id)}>{r.request_no}</td>
                  <td className="font-medium">{r.employee_name}</td>
                  <td className="text-sm">{r.site_display || r.site_name || '-'}</td>
                  <td><span className={`badge ${r.category === 'TA/DA' ? 'badge-purple' : r.category === 'Purchase' ? 'badge-blue' : r.category === 'Labour' ? 'badge-green' : 'badge-gray'}`}>{r.category}</span></td>
                  <td className="font-semibold">{fmt(r.amount)}</td>
                  {/* Approval Amt — always show a number (mam 2026-06-15
                      "show how much amount"): the latest approver-agreed
                      amount once any level approves, else the requested
                      amount (greyed = not yet approved). Emerald = a level
                      reduced it. */}
                  <td className="font-semibold">
                    {approvedLevel && r.step_amounts && r.step_amounts[approvedLevel] != null
                      ? <span className="text-green-700" title={`Amount approved at L${approvedLevel}`}>{fmt(r.step_amounts[approvedLevel])}</span>
                      : r.approved_amount != null
                        ? <span className={+r.approved_amount !== +r.amount ? 'text-emerald-700' : ''} title={+r.approved_amount !== +r.amount ? `Adjusted from ${fmt(r.amount)}` : 'Approved at requested amount'}>{fmt(r.approved_amount)}</span>
                        : <span className="text-gray-400" title="Not yet approved — will pay the requested amount unless a level adjusts it">{fmt(r.amount)}</span>}
                  </td>
                  <td className="text-sm max-w-[280px]">
                    {/* Show full purpose text, wrap to multiple lines for
                        long entries. Hover shows it again as a tooltip
                        for screen-reader / extra-long cases. Below the
                        purpose we also show the category-specific extra
                        detail (item_description for Purchase, stay_details
                        for TA/DA, etc.) so the row carries everything mam
                        typed without having to open the request. */}
                    <div className="whitespace-normal break-words leading-snug" title={r.purpose}>{r.purpose}</div>
                    {(r.item_description || r.material_description || r.stay_details || r.travel_from_to) && (
                      <div className="text-[10px] text-gray-500 mt-0.5 leading-tight whitespace-normal break-words">
                        {r.item_description && <span>📦 {r.item_description}</span>}
                        {r.material_description && <span>🚚 {r.material_description}</span>}
                        {r.stay_details && <span>🏨 {r.stay_details}</span>}
                        {r.travel_from_to && <span>✈️ {r.travel_from_to}</span>}
                      </div>
                    )}
                  </td>
                  {/* Mam (2026-05-22): "user can show ... where is stuck
                      their payment" — STEP cell now shows both who
                      approved last AND who's blocking next, so the
                      requester sees exactly where the payment sits. */}
                  <td className="text-[11px]">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="bg-gray-100 px-2 py-0.5 rounded font-mono text-[11px]">{r.approvals_count || 0}/{r.approvals_total || 5}</span>
                      {r.current_step_name && r.status !== 'final_approved' && r.status !== 'rejected' && (
                        <span className="text-amber-700 font-medium">→ {r.current_step_name}</span>
                      )}
                    </div>
                    {r.last_approved_by_name && (
                      <div className="text-[10px] text-emerald-700">
                        ✓ {r.last_approved_step_name} by <b>{r.last_approved_by_name}</b>
                      </div>
                    )}
                    {r.status !== 'final_approved' && r.status !== 'rejected' && (r.next_approver_name || r.next_approver_role) && (
                      <div className="text-[10px] text-amber-800">
                        ⏳ Waiting on {r.next_approver_name ? <b>{r.next_approver_name}</b> : <>any <b>{r.next_approver_role}</b></>}
                      </div>
                    )}
                  </td>
                  {/* Status follows the STAGE (mam 2026-06-15): pending at
                      L1/L2/L3, 'Approved' once all 3 sign-offs are done and
                      it's awaiting payment release, 'Paid' when released,
                      'Rejected' if rejected. */}
                  <td>{(() => {
                    const st = stageOf(r);
                    const cls = 'px-2 py-0.5 rounded text-[11px] font-semibold whitespace-nowrap ';
                    if (st === 'Rejected') return <span className={cls + 'bg-red-100 text-red-700'}>Rejected</span>;
                    if (st === 'Approved') return r.l3_missing
                      ? <span className={cls + 'bg-red-100 text-red-700'} title="Released without L2 (Nitin) / L3 (MD) approval — not properly paid. Needs the L3 backfill to correct.">⚠ Not Paid</span>
                      : <span className={cls + 'bg-green-600 text-white'}>Paid</span>;
                    if (st === 'Payment Release (Aanchal)') return <span className={cls + 'bg-emerald-100 text-emerald-700'}>Approved</span>;
                    // Show WHICH level it's pending at (mam 2026-06-18: status was
                    // a hotchpotch — everything just said "Pending"). Level read
                    // from the current step name (HR / L1 / L2 / L3).
                    const lvl = (r.current_step_name || '').match(/\b(HR|L1|L2|L3)\b/)?.[1] || '';
                    return <span className={cls + 'bg-amber-100 text-amber-700'}>Pending{lvl ? ' · ' + lvl : ''}</span>;
                  })()}</td>
                  {/* Date column — mam (2026-05-22): "this is pick wrong
                      time according to indian" — SQLite stores UTC,
                      now converted to IST via fmtISTPair so the row
                      reflects the actual local submission time. */}
                  <td className="text-xs">
                    {(() => {
                      const { date, time } = fmtISTPair(r.created_at);
                      return (
                        <>
                          <div>{date}</div>
                          <div className="text-[10px] text-gray-500">{time}</div>
                        </>
                      );
                    })()}
                  </td>
                  <td><div className="flex gap-1">
                    <button onClick={() => viewRequest(r.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"><FiEye size={15} /></button>
                    {canApprove('payment_required') && r.status !== 'final_approved' && r.status !== 'rejected' && <>
                      <button onClick={() => viewRequest(r.id)} className="p-1.5 text-amber-600 hover:bg-amber-50 rounded font-bold text-xs" title="Review & Approve/Reject">Review</button>
                    </>}
                    {canDelete('payment_required') && <button onClick={async () => {
                      if (!confirm(`Delete request "${r.request_no}"?`)) return;
                      try { await api.delete(`/payment-required/${r.id}`); toast.success('Deleted'); load(); }
                      catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                    }} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}
                  </div></td>
                </tr>
              ))}
              {requests.length === 0 && <tr><td colSpan="11" className="text-center py-8 text-gray-400">No requests found</td></tr>}
            </tbody>
          </table></div>
        </>
      )}

      {/* View Request Modal */}
      <Modal isOpen={modal === 'view'} onClose={() => { setModal(null); setViewData(null); }} title={`${viewData?.request_no || ''} - ${viewData?.employee_name || ''}`} wide>
        {viewData && (
          <div className="space-y-4 max-h-[70vh] overflow-y-auto">
            <div className="flex items-center justify-between bg-gradient-to-r from-orange-50 to-amber-50 p-4 rounded-lg">
              <div><h3 className="text-lg font-bold text-orange-800">{viewData.request_no}</h3><p className="text-sm text-orange-600">{viewData.category} - {viewData.purpose}</p></div>
              <div className="text-right">
                <p className="text-2xl font-bold text-orange-700">{fmt(viewData.amount)}</p>
                <StatusBadge status={viewData.status} />
                {/* Admin amount edit (e.g. salary increase) — can set any
                    positive figure, unlike approvers who can only decrease. */}
                {isAdmin && viewData.status !== 'final_approved' && viewData.status !== 'rejected' && (
                  editAmt === null ? (
                    <button onClick={() => setEditAmt(String(viewData.amount))}
                            className="block ml-auto mt-1 text-[10px] text-blue-600 hover:text-blue-800 underline"
                            title="Edit the request amount (admin only)">
                      ✏️ Edit amount
                    </button>
                  ) : (
                    <div className="mt-1 flex items-center gap-1 justify-end">
                      <span className="text-[11px]">₹</span>
                      <input type="number" value={editAmt} onChange={e => setEditAmt(e.target.value)} autoFocus
                             className="input text-xs w-28 py-0.5"
                             onKeyDown={e => { if (e.key === 'Enter') saveAmount(); if (e.key === 'Escape') setEditAmt(null); }} />
                      <button onClick={saveAmount} className="text-[10px] text-emerald-700 font-bold">Save</button>
                      <button onClick={() => setEditAmt(null)} className="text-[10px] text-gray-500">Cancel</button>
                    </div>
                  )
                )}
                {isAdmin && (
                  <button onClick={openRoutingModal}
                          className="block ml-auto mt-2 text-[10px] text-blue-600 hover:text-blue-800 underline"
                          title="Re-assign HR / Accountant / Release steps to specific users (e.g. HR → Aanchal)">
                    Manage step approvers…
                  </button>
                )}
              </div>
            </div>

            {/* Mam (2026-05-22): full workflow strip — ✓ done with
                timestamp & approver  →  ⏳ current (WAITING ON name)
                 →  ⏸ future · System / Auto steps labelled.  Arrows
                between boxes show the flow direction.  Re-assign
                pencil (admin only) still on un-actioned, non-auto
                steps for routing changes mid-flight. */}
            <div className="flex gap-0 items-stretch flex-wrap">
              {(() => {
                const steps = viewData.workflow || (viewData.category === 'TA/DA' ? TADA_STEPS : STEPS);
                return steps.map((s, idx) => {
                  const approval = viewData.approvals?.find(a => a.step === s.step);
                  const isCurrent = viewData.current_step === s.step && viewData.status !== 'final_approved' && viewData.status !== 'rejected';
                  const isSystem  = (s.approver_role || s.role) === 'System';
                  // Format approval timestamp as "23 May · 10:06"
                  const fmtTs = (iso) => {
                    if (!iso) return '';
                    const d = new Date(iso);
                    if (isNaN(d.getTime())) return '';
                    return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
                  };
                  const box = (
                    <div className={`flex-1 min-w-[120px] p-2 rounded text-[11px] font-medium relative ${
                      approval?.action === 'approved' ? 'bg-emerald-100 text-emerald-700 border border-emerald-300'
                      : approval?.action === 'rejected' ? 'bg-red-100 text-red-700 border border-red-300'
                      : isCurrent ? 'bg-amber-100 text-amber-800 border-2 border-amber-400 shadow'
                      : 'bg-gray-100 text-gray-400 border border-gray-200'
                    }`}>
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="font-bold">Step {s.step}</span>
                        {approval?.action === 'approved' && <span>✓</span>}
                        {approval?.action === 'rejected' && <span>✗</span>}
                        {isCurrent && <span>⏳</span>}
                        {!approval && !isCurrent && <span>⏸</span>}
                      </div>
                      <div className="text-[10.5px] leading-tight">{s.name}</div>
                      {isSystem && <div className="text-[9px] italic text-gray-500 mt-0.5">(auto)</div>}
                      {approval && (
                        <div className="text-[9.5px] mt-1 leading-tight">
                          <div>by <b>{approval.approved_by_name}</b></div>
                          <div className="text-[9px] opacity-75">{fmtTs(approval.approved_at)}</div>
                        </div>
                      )}
                      {isCurrent && !approval && (
                        <div className="text-[9.5px] mt-1 leading-tight font-bold">
                          WAITING ON:<br/>
                          {viewData.next_approver_name
                            ? viewData.next_approver_name
                            : <>any {viewData.next_approver_role || s.approver_role || s.role || '?'}</>}
                        </div>
                      )}
                      {/* Inline re-assign — admin only, non-auto, non-actioned */}
                      {isAdmin && !approval && !isSystem && (
                        <button
                          onClick={openRoutingModal}
                          className="absolute top-1 right-1 text-[9px] px-1 py-0.5 rounded bg-white/80 hover:bg-white border border-gray-300 hover:border-red-400 text-gray-600 hover:text-red-700"
                          title={`Re-assign ${s.name} to a specific user`}
                        >
                          re-assign
                        </button>
                      )}
                    </div>
                  );
                  return (
                    <div key={s.step} className="flex items-center flex-1 min-w-[140px]">
                      {box}
                      {idx < steps.length - 1 && (
                        <div className="px-1 text-gray-400 text-xl font-bold flex-shrink-0">→</div>
                      )}
                    </div>
                  );
                });
              })()}
            </div>

            <div className="grid grid-cols-3 gap-3 text-sm">
              <div><span className="text-gray-400">Employee:</span> <span className="font-medium">{viewData.employee_name}</span></div>
              <div><span className="text-gray-400">Site:</span> <span className="font-medium">{viewData.site_display || viewData.site_name || '-'}</span></div>
              <div><span className="text-gray-400">Department:</span> <span className="font-medium">{viewData.department || '-'}</span></div>
              <div><span className="text-gray-400">Contact:</span> <span className="font-medium">{viewData.contact_number || '-'}</span></div>
              <div><span className="text-gray-400">Payment Mode:</span> <span className="font-medium">{viewData.payment_mode}</span></div>
              <div><span className="text-gray-400">Required By:</span> <span className="font-medium">{viewData.required_by_date || '-'}</span></div>
            </div>

            {/* Category fields */}
            {viewData.category === 'TA/DA' && (
              <div className="border rounded p-3 bg-purple-50"><h5 className="font-semibold text-sm text-purple-700 mb-2">TA/DA Details</h5>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div><span className="text-gray-400">Travel:</span> {viewData.travel_from_to}</div>
                  <div><span className="text-gray-400">Dates:</span> {viewData.travel_dates}</div>
                  <div><span className="text-gray-400">Mode:</span> {viewData.mode_of_travel}</div>
                  <div><span className="text-gray-400">Stay:</span> {viewData.stay_details}</div>
                </div></div>
            )}
            {viewData.category === 'Purchase' && (
              <div className="border rounded p-3 bg-red-50"><h5 className="font-semibold text-sm text-red-700 mb-2">Purchase Details</h5>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div><span className="text-gray-400">Indent No:</span> {viewData.indent_number}</div>
                  <div><span className="text-gray-400">Vendor:</span> {viewData.vendor_name}</div>
                  <div className="col-span-2"><span className="text-gray-400">Items:</span> {viewData.item_description}</div>
                </div></div>
            )}
            {viewData.category === 'Labour' && (
              <div className="border rounded p-3 bg-green-50"><h5 className="font-semibold text-sm text-green-700 mb-2">Labour Details</h5>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div><span className="text-gray-400">Type:</span> {viewData.labour_type}</div>
                  <div><span className="text-gray-400">Workers:</span> {viewData.number_of_workers}</div>
                  <div><span className="text-gray-400">Duration:</span> {viewData.work_duration}</div>
                  <div><span className="text-gray-400">Site Engineer:</span> {viewData.site_engineer_name}</div>
                </div></div>
            )}
            {viewData.category === 'Transport' && (
              <div className="border rounded p-3 bg-gray-50"><h5 className="font-semibold text-sm text-gray-700 mb-2">Transport Details</h5>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div><span className="text-gray-400">Vehicle:</span> {viewData.vehicle_type}</div>
                  <div><span className="text-gray-400">From-To:</span> {viewData.from_to_location}</div>
                  <div><span className="text-gray-400">Material:</span> {viewData.material_description}</div>
                  <div><span className="text-gray-400">Driver/Vendor:</span> {viewData.driver_vendor_name}</div>
                </div></div>
            )}

            {viewData.rejection_remarks && <div className="bg-red-50 p-3 rounded text-sm"><strong className="text-red-700">Rejected:</strong> {viewData.rejection_remarks}</div>}

            {/* Proofs / Receipts — shown prominently so approver can verify
                tickets / KM photos / quotations / attachments before clicking
                Approve or Reject. Images show as thumbnails, PDFs/docs show
                as a 📄 card. Click any tile to open full-size in a new tab.
                If a proof is missing, an "Upload now" button appears so the
                approver / creator can attach it before deciding. */}
            {(() => {
              // Build a list of expected proof slots based on category.
              // Each slot has: field (DB column), label, tint, and required flag.
              const slots = [];
              if (viewData.category === 'TA/DA') {
                if (['Bus','Bus / Rapido','Train','Flight'].includes(viewData.mode_of_travel)) {
                  slots.push({ field: 'ticket_upload', label: 'Travel Ticket', tint: 'purple', required: true });
                }
                if (['Car','Bike'].includes(viewData.mode_of_travel)) {
                  slots.push({ field: 'km_photo', label: `Start KM Photo${viewData.start_km ? ` (${viewData.start_km} km)` : ''}`, tint: 'orange', required: true });
                  slots.push({ field: 'end_km_photo', label: `End KM Photo${viewData.end_km ? ` (${viewData.end_km} km)` : ''}`, tint: 'emerald', required: true });
                }
              }
              if (viewData.category === 'Purchase') {
                slots.push({ field: 'quotation_link', label: 'Quotation / Purchase Order', tint: 'red', required: true });
              }
              if (viewData.category === 'Manpower Advance') {
                slots.push({ field: 'advance_proof', label: 'Proof / Document', tint: 'blue', required: true });
              }
              // Always allow a generic attachment slot at the end
              slots.push({ field: 'attachment_link', label: 'Other Attachment', tint: 'blue', required: false });

              const isImg = (url) => /\.(jpg|jpeg|png|webp|gif|bmp|heic)(\?|$)/i.test(url);
              const tintMap = {
                purple: 'border-purple-300 bg-purple-50',
                orange: 'border-orange-300 bg-orange-50',
                emerald: 'border-emerald-300 bg-emerald-50',
                red: 'border-red-300 bg-red-50',
                blue: 'border-blue-300 bg-blue-50',
              };

              const isFinalised = viewData.status === 'final_approved' || viewData.status === 'rejected';

              // Upload helper — kept available so legacy / in-flight
              // requests that landed before mandatory-proof validation
              // can still attach receipts. Backend PATCH endpoint logs
              // updated_by + updated_at for audit.
              const uploadProof = async (field, file) => {
                if (!file) return;
                try {
                  const fd = new FormData();
                  fd.append('file', file);
                  const up = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
                  await api.patch(`/payment-required/${viewData.id}/proof`, { field, url: up.data.url });
                  toast.success('Proof attached');
                  const { data } = await api.get(`/payment-required/${viewData.id}`);
                  setViewData(data);
                } catch (err) {
                  toast.error(err.response?.data?.error || 'Upload failed');
                }
              };

              const filledCount = slots.filter(s => viewData[s.field]).length;

              return (
                <div className="border-2 border-blue-300 rounded-lg p-3 bg-blue-50/40">
                  <h5 className="font-bold text-sm text-blue-800 mb-2 flex items-center gap-1">
                    📎 Proofs / Receipts {filledCount > 0 && <span className="text-blue-600">({filledCount})</span>}
                  </h5>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {slots.map((s, i) => {
                      const url = viewData[s.field];
                      if (url) {
                        // Filled — show as clickable thumbnail
                        return (
                          <a
                            key={i}
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className={`block rounded-lg border ${tintMap[s.tint]} overflow-hidden hover:shadow-md hover:scale-[1.02] transition-all`}
                            title={`Click to open ${s.label}`}
                          >
                            {isImg(url) ? (
                              <img src={url} alt={s.label} className="w-full h-32 object-cover bg-white" />
                            ) : (
                              <div className="h-32 flex flex-col items-center justify-center bg-white">
                                <span className="text-4xl">📄</span>
                                <span className="text-[10px] text-gray-500 mt-1">PDF / Document</span>
                              </div>
                            )}
                            <div className="px-2 py-1.5 bg-white border-t">
                              <div className="text-xs font-semibold truncate">{s.label}</div>
                              <div className="text-[10px] text-blue-600 underline">Click to view full size</div>
                            </div>
                          </a>
                        );
                      }
                      // Empty slot — show upload tile (only if not finalised).
                      // Required ones get a red "MISSING" treatment; optional
                      // ones a softer gray "Optional" tile.
                      if (isFinalised) return null;
                      return (
                        <label
                          key={i}
                          className={`block rounded-lg border-2 border-dashed ${s.required ? 'border-red-300 bg-red-50/50' : 'border-gray-300 bg-gray-50'} overflow-hidden cursor-pointer hover:shadow-md transition-all`}
                        >
                          <div className="h-32 flex flex-col items-center justify-center text-center px-2">
                            <span className="text-3xl">{s.required ? '⚠️' : '➕'}</span>
                            <span className="text-[11px] font-bold mt-1 text-gray-700">{s.required ? 'MISSING' : 'Optional'}</span>
                            <span className="text-[10px] text-gray-500 mt-0.5">Click to upload</span>
                          </div>
                          <div className="px-2 py-1.5 bg-white border-t">
                            <div className="text-xs font-semibold truncate">{s.label}</div>
                            <div className="text-[10px] text-blue-600 underline">Choose file…</div>
                          </div>
                          <input
                            type="file"
                            accept="image/*,.pdf"
                            className="hidden"
                            onChange={e => uploadProof(s.field, e.target.files?.[0])}
                          />
                        </label>
                      );
                    })}
                  </div>
                  {filledCount === 0 && (
                    <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mt-2">
                      ⚠️ No proofs uploaded with this request. New requests are blocked at filing time if proofs are missing — for legacy requests like this one, click any tile above to attach the receipt before approving.
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Approval trail (now with per-step amount, mam 2026-05-28) */}
            {viewData.approvals?.length > 0 && (
              <div>
                <h5 className="font-semibold text-sm mb-2 flex items-center justify-between">
                  <span>Approval Trail</span>
                  {viewData.approved_amount != null && viewData.approved_amount !== viewData.amount && (
                    <span className="text-[11px] font-normal text-amber-700">
                      Adjusted: Rs {(+viewData.amount).toLocaleString('en-IN')} → <b>Rs {(+viewData.approved_amount).toLocaleString('en-IN')}</b>
                    </span>
                  )}
                </h5>
                <div className="space-y-1">{viewData.approvals.map(a => (
                  <div key={a.id} className={`text-xs p-2 rounded flex justify-between items-center ${a.action === 'approved' ? 'bg-emerald-50' : 'bg-red-50'}`}>
                    <span>
                      <strong>Step {a.step}:</strong> {a.step_name} —{' '}
                      <span className={a.action === 'approved' ? 'text-emerald-700' : 'text-red-600'}>{a.action.toUpperCase()}</span>
                      {' '}by {a.approved_by_name}
                      {a.step_amount != null && (
                        <span className="ml-2 text-[10px] font-semibold text-purple-700">@ Rs {(+a.step_amount).toLocaleString('en-IN')}</span>
                      )}
                    </span>
                    <span className="text-gray-400">{a.approved_at}</span>
                  </div>
                ))}</div>
              </div>
            )}

            {/* Action buttons - role based */}
            {viewData.status !== 'final_approved' && viewData.status !== 'rejected' && viewData.can_approve_current && (() => {
              const original = +(viewData.amount || 0);
              const currentApproved = viewData.approved_amount != null ? +viewData.approved_amount : original;
              const draft = approvalAmount === '' ? null : +approvalAmount;
              const willReduce = draft != null && draft < currentApproved;
              const reduceBy = willReduce ? currentApproved - draft : 0;
              return (
              <div className="border-2 border-amber-300 rounded-lg p-4 bg-amber-50 space-y-3">
                <h5 className="font-bold text-amber-800">Your Approval Required - Step {viewData.current_step}: {(viewData.workflow?.find(w => w.step === viewData.current_step) || {}).name || viewData.current_step_name}</h5>

                {/* Approver-side amount adjustment (mam 2026-05-28) */}
                <div>
                  <label className="label text-amber-700 flex items-center justify-between">
                    <span>Approved Amount (₹) *</span>
                    <span className="text-[10px] font-normal text-gray-500 normal-case">
                      Original request: <b>Rs {original.toLocaleString('en-IN')}</b>
                      {viewData.approved_amount != null && viewData.approved_amount !== viewData.amount && (
                        <> · Already adjusted to <b>Rs {(+viewData.approved_amount).toLocaleString('en-IN')}</b></>
                      )}
                    </span>
                  </label>
                  <input
                    type="number"
                    className="input"
                    min="1"
                    max={original}
                    step="0.01"
                    value={approvalAmount}
                    onChange={e => setApprovalAmount(e.target.value)}
                    placeholder={`Defaults to Rs ${currentApproved.toLocaleString('en-IN')}`}
                  />
                  {willReduce && (
                    <p className="text-[11px] text-amber-800 mt-1">
                      ↓ Reducing by <b>Rs {reduceBy.toLocaleString('en-IN')}</b>. Final payment will be <b>Rs {draft.toLocaleString('en-IN')}</b>.
                    </p>
                  )}
                  {draft != null && draft > original && (
                    <p className="text-[11px] text-red-700 mt-1">
                      ⚠️ Cannot approve more than the original request (Rs {original.toLocaleString('en-IN')}).
                    </p>
                  )}
                </div>

                <div>
                  <label className="label text-amber-700">Reason / Remarks <span className="font-normal normal-case text-gray-500">(optional to approve · required to reject)</span></label>
                  <textarea className="input" rows="3" value={approvalRemarks} onChange={e => setApprovalRemarks(e.target.value)}
                    placeholder="Optional for approval. Required (min 5 chars) if rejecting…" />
                </div>
                <div className="flex gap-3">
                  <button onClick={() => handleApprove(viewData.id)} className="btn btn-success flex-1 py-3 text-base font-bold">Approve</button>
                  <button onClick={() => handleReject(viewData.id)} className="btn btn-danger flex-1 py-3 text-base font-bold">Reject</button>
                </div>
              </div>
              );
            })()}
          </div>
        )}
      </Modal>

      {/* New Request Modal */}
      <Modal isOpen={modal === 'add'} onClose={() => setModal(null)} title="New Payment Request" wide>
        <form onSubmit={handleSave} className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">

          {/* Common fields */}
          {/* Shared suggestion lists — pick from the master OR keep typing
              (mam 2026-06-15 automation: vendor / person fields). */}
          <datalist id="prVendorsDL">{vendors.map(v => <option key={v.id} value={v.name} />)}</datalist>
          <datalist id="prEmployeesDL">{employees.map(e => <option key={e.id} value={e.name} />)}</datalist>
          <div className="border rounded-lg p-3 bg-gray-50">
            <h4 className="font-semibold text-sm text-gray-700 mb-3">Request Details</h4>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label">Employee Name *</label>
                <SearchableSelect
                  options={employees.map(e => ({ ...e, label: e.name + (e.department ? ' (' + e.department + ')' : '') }))}
                  value={form.employee_name || null}
                  valueKey="name" displayKey="label"
                  placeholder="Search employee…"
                  onChange={(emp) => {
                    F('employee_name', emp?.name || '');
                    if (emp) { F('department', emp.department || ''); F('contact_number', emp.phone || ''); }
                  }}
                />
              </div>
              <div>
                <label className="label">Site Name *</label>
                <SearchableSelect
                  options={sites}
                  value={form.site_id || null}
                  valueKey="id" displayKey="name"
                  placeholder="Search site…"
                  onChange={(site) => { F('site_id', site?.id || ''); F('site_name', site?.name || ''); }}
                />
              </div>
              <div><label className="label">Department</label><input className="input" value={form.department} onChange={e => F('department', e.target.value)} /></div>
              <div><label className="label">Contact Number</label><input className="input" value={form.contact_number} onChange={e => F('contact_number', e.target.value)} /></div>
              <div><label className="label">Category *</label>
                <select className="select" value={form.category} onChange={e => F('category', e.target.value)} required>
                  <option value="">Select</option>{CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              {/* `|| ''` lets backspace clear field (mam 2026-05-25). */}
              <div><label className="label">Amount Required (Rs) *</label><input className="input" type="number" value={form.amount || ''} onChange={e => F('amount', +e.target.value)} required /></div>
              <div className="col-span-2"><label className="label">Purpose / Description *</label><input className="input" value={form.purpose} onChange={e => F('purpose', e.target.value)} required /></div>
              <div><label className="label">Payment Mode</label>
                <select className="select" value={form.payment_mode} onChange={e => F('payment_mode', e.target.value)}>
                  <option>Cash</option><option>Bank</option><option>UPI</option>
                </select>
              </div>
              <div>
                <label className="label">Required By Date</label>
                <input className="input" type="date" value={form.required_by_date}
                  min={defaultRequiredByDate()}
                  onChange={e => F('required_by_date', e.target.value)} />
                <p className="text-[10px] text-gray-400 mt-0.5">Earliest: {defaultRequiredByDate()} (today + 5 days).</p>
              </div>
            </div>
          </div>

          {/* TA/DA fields */}
          {form.category === 'TA/DA' && (
            <div className="border rounded-lg p-3 bg-purple-50">
              <h4 className="font-semibold text-sm text-purple-700 mb-3">TA/DA Details</h4>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">Travel From-To *</label><input className="input" value={form.travel_from_to} onChange={e => F('travel_from_to', e.target.value)} required /></div>
                <div><label className="label">Travel Dates *</label>
                  <input className="input" type="date" value={form.travel_dates}
                    min={minTravelDate()} max={todayStr()}
                    onChange={e => F('travel_dates', e.target.value)} required />
                  <p className="text-[10px] text-gray-400 mt-0.5">Today or up to 3 days back ({minTravelDate()} – {todayStr()}). No future dates.</p>
                </div>
                <div><label className="label">Mode of Travel *</label>
                  <select className="select" value={form.mode_of_travel} onChange={e => F('mode_of_travel', e.target.value)} required>
                    <option value="">Select</option><option>Bus / Rapido</option><option>Train</option><option>Flight</option><option>Car</option><option>Bike</option><option>Auto</option>
                  </select>
                </div>
                <div><label className="label">Stay Details</label><input className="input" value={form.stay_details} onChange={e => F('stay_details', e.target.value)} placeholder="Hotel name, duration..." /></div>
              </div>

              {/* Bus/Train/Flight → Ticket upload */}
              {['Bus','Bus / Rapido','Train','Flight'].includes(form.mode_of_travel) && (
                <div className="mt-3 p-3 bg-white rounded border border-purple-200">
                  <label className="label">Upload Ticket *</label>
                  {form.ticket_upload ? (
                    <div className="flex items-center gap-2"><a href={form.ticket_upload} className="text-red-600 text-sm underline" target="_blank" rel="noreferrer">Ticket uploaded</a><button type="button" onClick={() => F('ticket_upload', '')} className="text-red-500 text-xs">Remove</button></div>
                  ) : (
                    <input type="file" onChange={async (e) => {
                      const file = e.target.files[0]; if (!file) return;
                      try { const fd = new FormData(); fd.append('file', file); const res = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } }); F('ticket_upload', res.data.url); toast.success('Ticket uploaded'); } catch { toast.error('Failed'); }
                      e.target.value = '';
                    }} className="text-xs" />
                  )}
                </div>
              )}

              {/* Car/Bike → KM + 2 Separate Photos */}
              {['Car','Bike'].includes(form.mode_of_travel) && (
                <div className="mt-3 p-3 bg-white rounded border border-purple-200 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2 p-2 bg-red-50 rounded">
                      <label className="label">Start KM *</label>
                      <input className="input" type="number" value={form.start_km || ''} onChange={e => F('start_km', +e.target.value)} required />
                      <label className="label text-[10px]">Start KM Meter Photo *</label>
                      {form.km_photo ? (
                        <div className="flex items-center gap-2"><a href={form.km_photo} className="text-red-600 text-xs underline truncate" target="_blank" rel="noreferrer">Photo uploaded</a><button type="button" onClick={() => F('km_photo', '')} className="text-red-500 text-[10px]">Remove</button></div>
                      ) : (
                        <input type="file" accept="image/*" onChange={async (e) => {
                          const file = e.target.files[0]; if (!file) return;
                          try { const fd = new FormData(); fd.append('file', file); const res = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } }); F('km_photo', res.data.url); toast.success('Start photo uploaded'); } catch { toast.error('Failed'); }
                          e.target.value = '';
                        }} className="text-[10px] w-full" />
                      )}
                    </div>
                    <div className="space-y-2 p-2 bg-emerald-50 rounded">
                      <label className="label">End KM *</label>
                      <input className="input" type="number" value={form.end_km || ''} onChange={e => F('end_km', +e.target.value)} required />
                      <label className="label text-[10px]">End KM Meter Photo *</label>
                      {form.end_km_photo ? (
                        <div className="flex items-center gap-2"><a href={form.end_km_photo} className="text-red-600 text-xs underline truncate" target="_blank" rel="noreferrer">Photo uploaded</a><button type="button" onClick={() => F('end_km_photo', '')} className="text-red-500 text-[10px]">Remove</button></div>
                      ) : (
                        <input type="file" accept="image/*" onChange={async (e) => {
                          const file = e.target.files[0]; if (!file) return;
                          try { const fd = new FormData(); fd.append('file', file); const res = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } }); F('end_km_photo', res.data.url); toast.success('End photo uploaded'); } catch { toast.error('Failed'); }
                          e.target.value = '';
                        }} className="text-[10px] w-full" />
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-purple-700 font-bold text-center">Total Distance: {Math.max(0, (form.end_km || 0) - (form.start_km || 0))} km</p>
                </div>
              )}

              {/* Auto → no proof needed */}
              {form.mode_of_travel === 'Auto' && (
                <div className="mt-3 p-2 bg-emerald-50 rounded text-xs text-emerald-700">No proof required for Auto</div>
              )}
            </div>
          )}

          {/* Purchase fields */}
          {form.category === 'Purchase' && (
            <div className="border rounded-lg p-3 bg-red-50">
              <h4 className="font-semibold text-sm text-red-700 mb-3">Purchase Details</h4>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">Indent Number *</label><input className="input" value={form.indent_number} onChange={e => F('indent_number', e.target.value)} required /></div>
                <div><label className="label">Vendor Name *</label><input className="input" list="prVendorsDL" value={form.vendor_name} onChange={e => F('vendor_name', e.target.value)} placeholder="Pick or type" required /></div>
                <div className="col-span-2"><label className="label">Item Description</label><textarea className="input" rows="2" value={form.item_description} onChange={e => F('item_description', e.target.value)} /></div>
                <div><label className="label">Purchase Order Upload *</label>
                  {form.quotation_link ? (
                    <div className="flex items-center gap-2"><a href={form.quotation_link} className="text-red-600 text-sm underline">Quotation uploaded</a><button type="button" onClick={() => F('quotation_link', '')} className="text-red-500 text-xs">Remove</button></div>
                  ) : (
                    <input type="file" onChange={async (e) => {
                      const file = e.target.files[0]; if (!file) return;
                      try { const fd = new FormData(); fd.append('file', file); const res = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } }); F('quotation_link', res.data.url); toast.success('Uploaded'); } catch { toast.error('Failed'); }
                      e.target.value = '';
                    }} className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-700" />
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Labour fields */}
          {form.category === 'Labour' && (
            <div className="border rounded-lg p-3 bg-green-50">
              <h4 className="font-semibold text-sm text-green-700 mb-3">Labour Details</h4>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">Labour Type *</label><select className="select" value={form.labour_type} onChange={e => F('labour_type', e.target.value)} required><option value="">Select</option><option>Skilled</option><option>Unskilled</option><option>Semi-skilled</option><option>Contractor</option></select></div>
                <div><label className="label">Number of Workers *</label><input className="input" type="number" value={form.number_of_workers || ''} onChange={e => F('number_of_workers', +e.target.value)} required /></div>
                <div><label className="label">Work Duration</label><input className="input" value={form.work_duration} onChange={e => F('work_duration', e.target.value)} placeholder="e.g. 5 days, 2 weeks" /></div>
                <div><label className="label">Site Engineer Name</label><input className="input" list="prEmployeesDL" value={form.site_engineer_name} onChange={e => F('site_engineer_name', e.target.value)} placeholder="Pick or type" /></div>
              </div>
            </div>
          )}

          {/* Transport fields */}
          {form.category === 'Transport' && (
            <div className="border rounded-lg p-3 bg-gray-50">
              <h4 className="font-semibold text-sm text-gray-700 mb-3">Transport Details</h4>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">Vehicle Type *</label><select className="select" value={form.vehicle_type} onChange={e => F('vehicle_type', e.target.value)} required><option value="">Select</option><option>Truck</option><option>Pickup</option><option>Tempo</option><option>Car</option><option>Auto</option><option>Crane</option></select></div>
                <div><label className="label">From-To Location *</label><input className="input" value={form.from_to_location} onChange={e => F('from_to_location', e.target.value)} required /></div>
                <div><label className="label">Material Description</label><input className="input" value={form.material_description} onChange={e => F('material_description', e.target.value)} /></div>
                <div><label className="label">Driver / Vendor Name</label><input className="input" list="prVendorsDL" value={form.driver_vendor_name} onChange={e => F('driver_vendor_name', e.target.value)} placeholder="Pick or type" /></div>
              </div>
            </div>
          )}

          {form.category === 'Manpower Advance' && (
            <div className="border rounded-lg p-3 bg-gray-50">
              <h4 className="font-semibold text-sm text-gray-700 mb-1">Manpower Advance — Proof <span className="text-red-500">*</span></h4>
              <p className="text-[11px] text-gray-500 mb-2">Attach at least one supporting document (manpower list, advance voucher, photo…). Image or PDF — mandatory.</p>
              {form.advance_proof ? (
                <div className="flex items-center gap-2">
                  <a href={form.advance_proof} className="text-emerald-700 text-sm underline" target="_blank" rel="noreferrer">Proof uploaded</a>
                  <button type="button" onClick={() => F('advance_proof', '')} className="text-red-500 text-xs">Remove</button>
                </div>
              ) : (
                <input type="file" accept="image/*,application/pdf" onChange={async (e) => {
                  const file = e.target.files[0]; if (!file) return;
                  try { const fd = new FormData(); fd.append('file', file); const res = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } }); F('advance_proof', res.data.url); toast.success('Proof uploaded'); } catch { toast.error('Upload failed'); }
                }} />
              )}
            </div>
          )}

          {/* Approval workflow info — one standard flow for every category */}
          {form.category && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-700">
              <strong>Approval Flow:</strong> <span>L1 Accountant → L2 Nitin Jain → L3 MD (Ankur Kaplesh) → Payment Release Aanchal</span>
            </div>
          )}

          {/* Missing-proofs banner — visible before Submit so the user
              knows what's blocking the request. Same rules as the
              approval-modal audit view + handleSave validation. */}
          {(() => {
            const missing = requiredProofsMissing(form);
            if (missing.length === 0) return null;
            return (
              <div className="bg-red-50 border-2 border-red-300 rounded-lg p-3 text-sm text-red-800">
                <div className="font-bold flex items-center gap-1">⚠️ Missing required proof{missing.length > 1 ? 's' : ''}:</div>
                <ul className="list-disc ml-5 mt-1 text-xs">
                  {missing.map(m => <li key={m}>{m}</li>)}
                </ul>
                <p className="text-[11px] mt-1.5 text-red-700">Submit is blocked until you attach {missing.length > 1 ? 'these receipts' : 'this receipt'}. Proof must be uploaded at request time.</p>
              </div>
            );
          })()}

          <div className="flex justify-end gap-3 pt-2 border-t">
            <button type="button" onClick={() => setModal(null)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving || requiredProofsMissing(form).length > 0}>{saving ? 'Submitting…' : 'Submit Request'}</button>
          </div>
        </form>
      </Modal>

      {/* ─── Approval Routing modal (admin) ────────────────────────
          Matrix of every (category × step) with a per-row user
          dropdown.  Picking a user overrides the default role-based
          routing — only that user (or admin) can approve that step.
          Choosing "— Default (by role) —" clears the override. */}
      <Modal isOpen={routingModal} onClose={() => setRoutingModal(false)} title="Approval Routing — Re-assign Steps" wide>
        {!routingMatrix ? (
          <div className="py-8 text-center text-gray-400">Loading…</div>
        ) : (
          <div className="space-y-4">
            <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-gray-700 leading-relaxed">
              <strong>How this works:</strong> Every category now uses one standard flow —
              <em> L1 Accountant → L2 Nitin Jain → L3 MD (Ankur Kaplesh) → Payment Release Aanchal</em>.
              L1 is open to anyone holding the Accountant role; L2/L3/Release are pinned to the named person.
              Pick a specific user here to <strong>override</strong> a step — from then on only that user (or admin) can clear it.
              Set back to "— Default —" to revert to the standard approver.
            </div>
            {Object.entries(routingMatrix).map(([category, steps]) => (
              <div key={category} className="card p-3">
                <h3 className="font-semibold text-sm mb-2 text-red-700">{category}</h3>
                <table className="w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left px-2 py-1.5 w-12">Step</th>
                      <th className="text-left px-2 py-1.5">Stage</th>
                      <th className="text-left px-2 py-1.5">Default Role</th>
                      <th className="text-left px-2 py-1.5">Assigned To (override)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {steps.map(s => {
                      const key = `${category}_${s.step}`;
                      const saving = !!routingSaving[key];
                      return (
                        <tr key={s.step} className="border-t">
                          <td className="px-2 py-1.5 font-mono">{s.step}</td>
                          <td className="px-2 py-1.5 font-medium">{s.name}</td>
                          <td className="px-2 py-1.5 text-gray-500">{s.role_default}</td>
                          <td className="px-2 py-1.5">
                            <select
                              className="select w-full text-xs"
                              disabled={saving || s.role_default === 'System'}
                              value={s.override_user_id || ''}
                              onChange={e => saveRouting(category, s.step, e.target.value || null)}
                            >
                              <option value="">— Default (by role) —</option>
                              {routingUsers.map(u => (
                                <option key={u.id} value={u.id}>{u.name}</option>
                              ))}
                            </select>
                            {s.role_default === 'System' && (
                              <p className="text-[10px] text-gray-400 mt-0.5">Auto-step — no manual approver.</p>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
            <div className="flex justify-end pt-2 border-t">
              <button onClick={() => setRoutingModal(false)} className="btn btn-primary">Done</button>
            </div>
          </div>
        )}
      </Modal>

      {/* Bulk approve — your pending requests, with proofs, tick-tick approve */}
      <Modal isOpen={bulkOpen} onClose={() => setBulkOpen(false)} title="Bulk Approve — pending your approval" wide>
        <div className="space-y-4">
          {/* Filter (person + level) + select-all controls */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <input className="input flex-1" placeholder="Filter by person (e.g. Monika) or request no…" value={bulkSearch} onChange={e => setBulkSearch(e.target.value)} autoFocus />
            <select className="select sm:w-60" value={bulkStage} onChange={e => setBulkStage(e.target.value)} title="Show only this approval level">
              <option value="">All levels</option>
              {STAGE_SEQ.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <div className="flex gap-3 text-xs flex-shrink-0">
              <button onClick={() => setAllVisible(true)} className="text-blue-600 hover:underline font-medium">Select all</button>
              <button onClick={() => setAllVisible(false)} className="text-gray-500 hover:underline">Clear</button>
            </div>
          </div>

          {/* Summary card — same style as the Approve Indent modal */}
          <div className="grid grid-cols-2 gap-3 text-xs bg-emerald-50 border border-emerald-200 rounded p-3">
            <div><span className="text-gray-500">Approver:</span> <span className="font-medium">{user?.name || 'You'}</span></div>
            <div><span className="text-gray-500">Pending your approval:</span> <span className="font-medium">{bulkRows.length}</span></div>
            <div><span className="text-gray-500">Selected:</span> <span className="font-medium text-emerald-700">{bulkPickedCount}</span></div>
            <div><span className="text-gray-500">Selected total:</span> <span className="font-medium">₹{Math.round(bulkSelectedTotal).toLocaleString('en-IN')}</span></div>
          </div>

          {bulkBusy && !bulkRows.length ? (
            <div className="py-8 text-center text-gray-400 text-sm">Loading your pending approvals…</div>
          ) : bulkVisible.length === 0 ? (
            <div className="py-8 text-center text-emerald-600 text-sm">✅ Nothing pending your approval{bulkSearch ? ' for that filter' : ''}.</div>
          ) : (
            <div className="max-h-[58vh] overflow-y-auto space-y-3 pr-1">
              {bulkVisible.map((r) => {
                // ALL proofs, labelled — incl. the bike Start KM + End KM
                // odometer photos (mam 2026-06-25 "show bike start and end").
                const proofs = [
                  { url: r.km_photo, label: '🛵 Start KM' },
                  { url: r.end_km_photo, label: '🏁 End KM' },
                  { url: r.ticket_upload, label: '🎫 Ticket' },
                  { url: r.quotation_link, label: '📄 Quotation' },
                  { url: r.attachment_link, label: '📎 Other' },
                ].filter(p => p.url);
                const checked = bulkSel.has(r.id);
                const isTada = r.category === 'TA/DA';
                return (
                  <div key={r.id} className={`border rounded-lg overflow-hidden ${checked ? 'border-emerald-400 ring-1 ring-emerald-300' : 'border-gray-200'}`}>
                    {/* header — req no, purpose, amount + the tick */}
                    <div className={`flex items-start gap-3 p-3 ${checked ? 'bg-emerald-50' : 'bg-gradient-to-r from-orange-50 to-amber-50'}`}>
                      <input type="checkbox" checked={checked} onChange={() => toggleBulk(r.id)} className="mt-0.5 w-5 h-5 accent-emerald-600 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-bold text-orange-800">{r.request_no}</span>
                          <div className="flex items-center gap-2 whitespace-nowrap">
                            <button type="button" onClick={() => openRaci(r)} title="Set Responsible / Accountable / Consulted / Informed + time per step for THIS request" className="text-[10px] font-semibold text-indigo-700 hover:text-white hover:bg-indigo-600 border border-indigo-300 rounded px-1.5 py-0.5 transition">⚙ RACI</button>
                            <span className="font-bold text-orange-700">₹{Number(r.approved_amount ?? r.amount).toLocaleString('en-IN')}</span>
                          </div>
                        </div>
                        <div className="text-xs text-orange-600 break-words">{r.category} — {r.purpose}</div>
                      </div>
                    </div>

                    {/* step pipeline */}
                    {Array.isArray(r.steps) && r.steps.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 px-3 py-2 bg-white border-b border-gray-100">
                        {r.steps.map((s, j) => {
                          const ra = s.raci;
                          const tip = ra
                            ? `R: ${ra.responsible || '-'}  |  A: ${ra.accountable || '-'}  |  C: ${ra.consulted || '-'}  |  I: ${ra.informed || '-'}${ra.sla_hours != null ? `  |  SLA ${ra.sla_hours}h` : ''}`
                            : (s.at ? fmtISTPair(s.at).date : '');
                          return (
                            <div key={j} className={`text-[10px] px-2 py-1 rounded border ${s.late_hours > 0 ? 'bg-rose-50 border-rose-300 text-rose-800' : s.status === 'done' ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : s.status === 'current' ? 'bg-amber-50 border-amber-400 text-amber-800 font-semibold' : 'bg-gray-50 border-gray-200 text-gray-400'}`} title={tip}>
                              <div>{s.status === 'done' ? '✓ ' : s.status === 'current' ? '⏳ ' : '○ '}{s.name}{s.by_name ? ` · ${s.by_name}` : ''}</div>
                              {(s.elapsed_hours != null || s.late_hours > 0 || ra?.responsible) && (
                                <div className="flex flex-wrap gap-x-1.5 mt-0.5 leading-tight">
                                  {s.elapsed_hours != null && <span className="text-[9px] text-gray-500">⏱ {s.elapsed_hours}h</span>}
                                  {s.late_hours > 0 && <span className="text-[9px] font-bold text-rose-600">⚠ {s.late_hours}h late</span>}
                                  {ra?.responsible && <span className="text-[9px] text-emerald-700">R:{ra.responsible}</span>}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* details */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 px-3 py-2 text-xs">
                      <div><span className="text-gray-400">Employee:</span> <b>{r.employee_name || r.created_by_name}</b></div>
                      {r.site_name && <div><span className="text-gray-400">Site:</span> {r.site_name}</div>}
                      {r.contact_number && <div><span className="text-gray-400">Contact:</span> {r.contact_number}</div>}
                      {r.payment_mode && <div><span className="text-gray-400">Mode:</span> {r.payment_mode}</div>}
                      {r.required_by_date && <div><span className="text-gray-400">Required by:</span> {r.required_by_date}</div>}
                      {isTada && r.travel_from_to && <div><span className="text-gray-400">Travel:</span> {r.travel_from_to}</div>}
                      {isTada && r.mode_of_travel && <div><span className="text-gray-400">Travel mode:</span> {r.mode_of_travel}</div>}
                      {isTada && r.travel_dates && <div><span className="text-gray-400">Dates:</span> {r.travel_dates}</div>}
                      {isTada && r.stay_details && <div><span className="text-gray-400">Stay:</span> {r.stay_details}</div>}
                    </div>

                    {/* proofs — big, viewable */}
                    <div className="px-3 pb-3">
                      <div className="text-[11px] font-semibold text-blue-700 mb-1">📎 Proofs / Receipts ({proofs.length})</div>
                      {proofs.length > 0 ? (
                        <div className="flex gap-3 flex-wrap">
                          {proofs.map((p, j) => (
                            <div key={j} className="flex flex-col items-center gap-1">
                              <span className="text-[10px] font-semibold text-gray-600 whitespace-nowrap">{p.label}</span>
                              {/\.(png|jpe?g|gif|webp)$/i.test(String(p.url))
                                ? <a href={p.url} target="_blank" rel="noreferrer" title={`${p.label} — open full size`}><img src={p.url} alt={p.label} loading="lazy" className="w-32 h-32 object-cover rounded border hover:ring-2 hover:ring-blue-400" /></a>
                                : <a href={p.url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 underline flex items-center gap-1 px-2 py-1 border rounded h-32 w-32 justify-center"><FiFile size={14} /> Open</a>}
                            </div>
                          ))}
                        </div>
                      ) : <div className="text-[11px] text-amber-600">⚠ no proof attached</div>}
                    </div>
                  </div>
                );
              })}
              {/* running total */}
              <div className="sticky bottom-0 bg-emerald-50 border border-emerald-200 rounded px-3 py-2 flex justify-between text-sm font-semibold">
                <span>Selected Total ({bulkPickedCount})</span>
                <span className="text-emerald-700">₹{Math.round(bulkSelectedTotal).toLocaleString('en-IN')}</span>
              </div>
            </div>
          )}

          <div className="pt-2 border-t space-y-2">
            <textarea className="input w-full text-xs" rows="2" placeholder="Rejection reason (min 5 chars) — required only if you Reject; applies to all selected"
              value={bulkRejectReason} onChange={e => setBulkRejectReason(e.target.value)} />
            <div className="flex justify-end gap-2">
              <button onClick={() => setBulkOpen(false)} className="btn btn-secondary">Cancel</button>
              <button onClick={rejectBulk} disabled={bulkBusy || bulkPickedCount === 0}
                className="btn flex items-center gap-1 bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40">
                <FiXCircle size={16} /> Reject {bulkPickedCount}
              </button>
              <button onClick={approveBulk} disabled={bulkBusy || bulkPickedCount === 0} className="btn btn-success flex items-center gap-1">
                <FiCheckCircle size={16} /> {bulkBusy ? 'Working…' : `Approve ${bulkPickedCount}`}
              </button>
            </div>
          </div>
        </div>
      </Modal>

      {/* Per-record RACI editor — set R/A/C/I + SLA per step for ONE request */}
      <Modal isOpen={!!raciFor} onClose={() => setRaciFor(null)} title={`RACI & time — ${raciFor?.request_no || ''}`} wide>
        <div className="space-y-3">
          <p className="text-xs text-gray-500">Pick the <b>R</b>esponsible / <b>A</b>ccountable / <b>C</b>onsulted / <b>I</b>nformed person and the expected time (SLA hours) for each step of <b>this</b> request. The system flags who is late and by how much.</p>
          {raciBusy && raciSteps.length === 0 ? (
            <div className="py-8 text-center text-gray-400 text-sm">Loading…</div>
          ) : (
            <div className="space-y-2">
              {raciSteps.map((s, i) => (
                <div key={s.key} className="border rounded-lg p-3 bg-white">
                  <div className="font-semibold text-sm mb-2 text-gray-800">{s.label}</div>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    {[['responsible_id', 'Responsible', 'text-emerald-600'], ['accountable_id', 'Accountable', 'text-blue-600'], ['consulted_id', 'Consulted', 'text-amber-600'], ['informed_id', 'Informed', 'text-gray-500']].map(([field, label, tint]) => (
                      <div key={field}>
                        <label className={`label text-[10px] ${tint}`}>{label}</label>
                        <select className="input text-xs" value={s[field] || ''} onChange={e => setRaciField(i, field, e.target.value ? +e.target.value : null)}>
                          <option value="">— pick —</option>
                          {raciUsers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                      </div>
                    ))}
                    <div>
                      <label className="label text-[10px] text-rose-600">SLA (hours)</label>
                      <input type="number" min="0" step="any" className="input text-xs" placeholder="e.g. 24" value={s.sla_hours ?? ''} onChange={e => setRaciField(i, 'sla_hours', e.target.value === '' ? '' : +e.target.value)} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2 border-t">
            <button onClick={() => setRaciFor(null)} className="btn btn-secondary">Cancel</button>
            <button onClick={saveRaci} disabled={raciBusy || raciSteps.length === 0} className="btn btn-primary">{raciBusy ? 'Saving…' : 'Save RACI & time'}</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
