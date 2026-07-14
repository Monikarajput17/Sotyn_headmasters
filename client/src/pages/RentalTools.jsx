// Rental Tools Module — mam (2026-05-16) spec:
//   Stage 0 · Enquiry (site eng raises)
//   Stage 1 · Rate Finalised — Ajmer locks vendor + rate, auto-PO created
//   Stage 2 · Material Received at site — site eng uploads live photo + GPS
//   Stage 3 · Returned to vendor — Ajmer signs off
//
// Business-hour SLAs (Sundays + after-5PM rolled forward):
//   - Stage 1 target = enquiry + 5 biz hours
//   - Stage 2 target = date_of_requirement + 1 biz day
//   - Stage 3 target = material_received + days_required (biz days)

import { useState, useEffect, useRef } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import {
  FiTool, FiPlus, FiDownload, FiCamera, FiCheckCircle,
  FiAlertTriangle, FiFileText, FiXCircle, FiSettings, FiEye,
} from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { fmtDateTime, fmtDate } from '../utils/datetime';

// Hard-coded fallbacks — replaced at runtime by labels coming from
// /api/rental-tools/dashboard (mam-editable via Settings).  Keeping
// them here so the page renders sensibly during the first
// dashboard fetch.
const DEFAULT_STAGE_LABEL = {
  enquiry:            'Stage 1 — Enquiry Raised',
  rate_finalised:     'Stage 2 — Rate Finalised',
  material_received:  'Stage 3 — Material at Site',
  returned:           'Stage 4 — Returned · Closed',
  cancelled:          'Cancelled',
};
// Short version — derive by stripping "Stage N — " prefix so admin's
// rename automatically propagates to the in-row badge.
const shortify = (label) => (label || '').replace(/^Stage\s*\d+\s*—\s*/i, '');
const STAGE_COLOR = {
  enquiry:            'bg-blue-100 text-blue-700',
  rate_finalised:     'bg-violet-100 text-violet-700',
  material_received:  'bg-amber-100 text-amber-700',
  returned:           'bg-emerald-100 text-emerald-700',
};
// Chip badge background per stage — matches Sales Funnel aesthetic.
const STAGE_CHIP_BG = {
  enquiry:            'bg-blue-500',
  rate_finalised:     'bg-violet-500',
  material_received:  'bg-amber-500',
  returned:           'bg-emerald-500',
  cancelled:          'bg-red-500',
};
const STAGE_ORDER = ['enquiry', 'rate_finalised', 'material_received', 'returned'];

const fmt = (n) => `₹${(n || 0).toLocaleString('en-IN')}`;
const fmtDt = (iso) => iso ? fmtDateTime(iso, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const fmtD  = (iso) => iso ? fmtDate(iso, { dateStyle: 'medium' }) : '—';

export default function RentalTools() {
  const { user, canCreate, canEdit, canApprove } = useAuth();
  const [tab, setTab] = useUrlTab('dashboard');
  const [dashboard, setDashboard] = useState(null);
  const [enquiries, setEnquiries] = useState([]);
  const [filters, setFilters] = useState({ stage: '', status: 'open', q: '' });
  const [createModal, setCreateModal] = useState(false);
  const [vendors, setVendors] = useState([]);
  const [usersList, setUsersList] = useState([]);
  // Business Book site list — mam (2026-05-16): "site name from
  // business book".  Cleaned + deduped + alpha-sorted so the
  // dropdown stays tight.  Reused for both the Raise Enquiry modal
  // AND the search field's datalist if mam wants free-typing later.
  const [bbSites, setBbSites] = useState([]);
  const [form, setForm] = useState({
    site_name: '', tool_description: '', date_of_requirement: '',
    days_required: 1, site_engineer_id: '', site_engineer_name: '',
  });
  const [drawerEnq, setDrawerEnq] = useState(null);
  const [rateForm, setRateForm] = useState({
    vendor_id: '', vendor_name: '', vendor_rate: '', vendor_rate_unit: 'per_day',
    po_number: '', po_date: new Date().toISOString().slice(0, 10),
    total_amount: '', advance_amount: '',
    crm_name: '',
  });
  const [returnNotes, setReturnNotes] = useState('');
  const fileInputRef = useRef(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  const loadDashboard = async () => {
    try { setDashboard((await api.get('/rental-tools/dashboard')).data); }
    catch { /* admin gate handled in nav */ }
  };
  const loadEnquiries = async () => {
    try {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
      setEnquiries((await api.get(`/rental-tools/enquiries?${params}`)).data);
    } catch (e) { toast.error('Could not load enquiries'); }
  };
  const loadLookups = async () => {
    // Vendor master is mounted under /api/procurement/vendors — same
    // dropdown other modules (POs, indents) use, so any vendor mam
    // adds in Procurement → Vendors is instantly available here.
    try { setVendors((await api.get('/procurement/vendors')).data || []); } catch {}
    try { setUsersList((await api.get('/auth/users')).data.filter(u => u.active !== 0)); } catch {}
    // Business Book → distinct project / company names for site dropdown
    try {
      const r = await api.get('/business-book');
      const cleanName = (s) => (s || '')
        .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const set = new Set();
      (r.data?.entries || r.data || []).forEach(bb => {
        const name = cleanName(bb.project_name || bb.company_name || bb.client_name);
        if (name) set.add(name);
      });
      setBbSites([...set].sort((a, b) => a.localeCompare(b)));
    } catch {}
  };

  useEffect(() => { loadDashboard(); loadEnquiries(); loadLookups(); }, []);
  useEffect(() => { loadEnquiries(); }, [filters]);

  // Mirrors server canApprove(): the designated approver if one is
  // configured, otherwise anyone whose role has can_approve on the
  // module.  Previously the fallback was `false`, so with no approver
  // configured the buttons were ENABLED for everyone (…&& !!approver_id
  // made disabled=false) and the server 403'd on click.
  const isApprover = dashboard?.approver_user_id
    ? user?.id === dashboard.approver_user_id
    : canApprove('rental_tools');
  const mayEdit = canEdit('rental_tools');
  // Stage labels — admin-renamable from Settings.  Falls back to the
  // hard-coded English defaults while the dashboard request is in
  // flight or if the override hasn't been saved.
  const STAGE_LABEL = dashboard?.stage_labels || DEFAULT_STAGE_LABEL;
  const STAGE_LABEL_SHORT = Object.fromEntries(
    Object.entries(STAGE_LABEL).map(([k, v]) => [k, shortify(v)])
  );

  // === Raise enquiry ===
  const createEnquiry = async (e) => {
    e.preventDefault();
    try {
      await api.post('/rental-tools/enquiries', form);
      toast.success('Enquiry raised');
      setCreateModal(false);
      setForm({ site_name: '', tool_description: '', date_of_requirement: '', days_required: 1, site_engineer_id: '', site_engineer_name: '' });
      loadDashboard(); loadEnquiries();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not create');
    }
  };

  // === Drawer ===
  const openDrawer = async (id) => {
    try {
      const r = await api.get(`/rental-tools/enquiries/${id}`);
      setDrawerEnq(r.data);
      // Pre-fill rate form with sensible defaults
      setRateForm({
        vendor_id: r.data.vendor_id || '',
        vendor_name: r.data.vendor_name || '',
        vendor_rate: r.data.vendor_rate || '',
        vendor_rate_unit: r.data.vendor_rate_unit || 'per_day',
        po_number: r.data.po_number || `RT-PO-${Date.now().toString().slice(-6)}`,
        po_date: new Date().toISOString().slice(0, 10),
        total_amount: r.data.vendor_rate ? (+r.data.vendor_rate * +r.data.days_required).toFixed(2) : '',
        advance_amount: '',
        crm_name: r.data.created_by_name || '',
      });
    } catch { toast.error('Could not load enquiry'); }
  };
  const closeDrawer = () => { setDrawerEnq(null); setReturnNotes(''); };

  const finaliseRate = async () => {
    try {
      const payload = { ...rateForm };
      // Auto-compute total if blank
      if (!payload.total_amount && payload.vendor_rate) {
        payload.total_amount = (+payload.vendor_rate * +drawerEnq.days_required).toFixed(2);
      }
      await api.post(`/rental-tools/enquiries/${drawerEnq.id}/finalise-rate`, payload);
      toast.success('Rate finalised · PO created');
      await openDrawer(drawerEnq.id);
      loadDashboard(); loadEnquiries();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed');
    }
  };

  const captureAndUploadPhoto = async () => {
    if (!fileInputRef.current) return;
    fileInputRef.current.click();
  };
  const onPhotoPicked = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!navigator.geolocation) {
      toast.error('Browser does not support GPS');
      return;
    }
    setUploadingPhoto(true);
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const fd = new FormData();
        fd.append('photo', file);
        fd.append('latitude', pos.coords.latitude);
        fd.append('longitude', pos.coords.longitude);
        await api.post(`/rental-tools/enquiries/${drawerEnq.id}/material-received`, fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        toast.success('Material marked received');
        await openDrawer(drawerEnq.id);
        loadDashboard(); loadEnquiries();
      } catch (err) {
        toast.error(err.response?.data?.error || 'Upload failed');
      } finally {
        setUploadingPhoto(false);
      }
    }, (err) => {
      toast.error('GPS denied — allow location and try again');
      setUploadingPhoto(false);
    }, { enableHighAccuracy: true, timeout: 15000 });
  };

  const signReturn = async () => {
    try {
      await api.post(`/rental-tools/enquiries/${drawerEnq.id}/return`, { notes: returnNotes });
      toast.success('Return signed · enquiry closed');
      await openDrawer(drawerEnq.id);
      loadDashboard(); loadEnquiries();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed');
    }
  };

  const cancelEnquiry = async () => {
    if (!confirm('Cancel this enquiry?')) return;
    try {
      await api.post(`/rental-tools/enquiries/${drawerEnq.id}/cancel`);
      toast.success('Cancelled');
      closeDrawer();
      loadDashboard(); loadEnquiries();
    } catch (e) { toast.error('Failed'); }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <FiTool className="text-red-600" /> Rental Tools
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            Enquiry → Rate Finalised → Material at Site → Returned · business-hour SLAs (after 5 PM rolls next day · Sunday rolls Monday)
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => exportCsv('rental-tools-enquiries',
            ['Enquiry','Site','Tool','Days','Site Eng','Stage','Status','Vendor','Rate','PO'],
            enquiries.map(e => [e.enquiry_no, e.site_name, e.tool_description, e.days_required, e.site_engineer_name, e.current_stage, e.status, e.vendor_name, e.vendor_rate, e.po_number]))}
            className="btn btn-secondary flex items-center gap-2 text-sm">
            <FiDownload size={14} /> Export Excel
          </button>
          {canCreate('rental_tools') && (
            <button onClick={() => setCreateModal(true)} className="btn btn-primary flex items-center gap-2 text-sm">
              <FiPlus size={14} /> Raise Enquiry
            </button>
          )}
        </div>
      </div>

      {/* Stage tabs — chip layout matches Sales Funnel (mam, 2026-05-16:
          "i need this type stages").  Each stage chip shows its current
          live count; clicking jumps to the Enquiries list pre-filtered
          to that stage.  Cancelled gets its own chip on the right
          (parallel to Sales Funnel's "Lost"). */}
      <div className="flex gap-2 flex-wrap items-center">
        <button onClick={() => { setTab('dashboard'); setFilters({ ...filters, stage: '', status: '' }); }}
          className={`btn ${tab === 'dashboard' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5 text-sm`}>
          Dashboard
        </button>
        <button onClick={() => { setTab('enquiries'); setFilters({ ...filters, stage: '', status: '' }); }}
          className={`btn ${tab === 'enquiries' && !filters.stage ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5 text-sm`}>
          All Enquiries
          <span className={`px-1.5 rounded-full text-[10px] font-bold min-w-[18px] text-center ${tab === 'enquiries' && !filters.stage ? 'bg-white/30 text-white' : 'bg-gray-400 text-white'}`}>
            {dashboard?.counts?.all ?? 0}
          </span>
        </button>
        {STAGE_ORDER.map(s => {
          const isActive = tab === 'enquiries' && filters.stage === s;
          return (
            <button key={s}
              onClick={() => { setTab('enquiries'); setFilters({ ...filters, stage: s, status: '' }); }}
              className={`btn ${isActive ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5 text-sm`}
              title={STAGE_LABEL[s]}>
              {STAGE_LABEL[s]}
              <span className={`px-1.5 rounded-full text-[10px] font-bold min-w-[18px] text-center ${isActive ? 'bg-white/30 text-white' : `${STAGE_CHIP_BG[s]} text-white`}`}>
                {dashboard?.counts?.[s] ?? 0}
              </span>
            </button>
          );
        })}
        <button
          onClick={() => { setTab('enquiries'); setFilters({ ...filters, stage: 'cancelled', status: '' }); }}
          className={`btn ${tab === 'enquiries' && filters.stage === 'cancelled' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5 text-sm`}>
          {STAGE_LABEL.cancelled}
          <span className={`px-1.5 rounded-full text-[10px] font-bold min-w-[18px] text-center ${tab === 'enquiries' && filters.stage === 'cancelled' ? 'bg-white/30 text-white' : 'bg-red-500 text-white'}`}>
            {dashboard?.counts?.cancelled ?? 0}
          </span>
        </button>
        {user?.role === 'admin' && (
          <button onClick={() => setTab('settings')}
            className={`btn ${tab === 'settings' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5 text-sm`}>
            <FiSettings size={12} /> Settings
          </button>
        )}
      </div>

      {/* ============ DASHBOARD ============
          Tile layout mirrors Sales Funnel for visual consistency. */}
      {tab === 'dashboard' && dashboard && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="card p-4 border-l-4 border-red-500">
              <p className="text-[10px] text-gray-500 font-bold uppercase">Total Enquiries</p>
              <p className="text-3xl font-extrabold text-red-600">{dashboard.counts?.all ?? 0}</p>
            </div>
            <div className="card p-4 border-l-4 border-purple-500">
              <p className="text-[10px] text-gray-500 font-bold uppercase">This Month</p>
              <p className="text-3xl font-extrabold text-purple-600">{dashboard.this_month ?? 0}</p>
            </div>
            <div className="card p-4 border-l-4 border-emerald-500">
              <p className="text-[10px] text-gray-500 font-bold uppercase">Closed (Returned)</p>
              <p className="text-3xl font-extrabold text-emerald-600">{dashboard.counts?.returned ?? 0}</p>
            </div>
            <div className="card p-4 border-l-4 border-red-500">
              <p className="text-[10px] text-gray-500 font-bold uppercase">Cancelled</p>
              <p className="text-3xl font-extrabold text-red-600">{dashboard.counts?.cancelled ?? 0}</p>
            </div>
            <div className="card p-4 border-l-4 border-amber-500">
              <p className="text-[10px] text-gray-500 font-bold uppercase">Open Value</p>
              <p className="text-xl font-extrabold text-amber-600">{fmt(dashboard.total_value)}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="card p-3 border-l-4 border-amber-500">
              <div className="text-2xl font-bold text-amber-700">{dashboard.breaches.stage1_overdue}</div>
              <div className="text-xs text-gray-600">Rate not finalised within 5 biz hrs</div>
            </div>
            <div className="card p-3 border-l-4 border-amber-500">
              <div className="text-2xl font-bold text-amber-700">{dashboard.breaches.stage2_overdue}</div>
              <div className="text-xs text-gray-600">Material not received within 1 biz day of req date</div>
            </div>
            <div className="card p-3 border-l-4 border-red-500">
              <div className="text-2xl font-bold text-red-700">{dashboard.breaches.stage3_overdue}</div>
              <div className="text-xs text-gray-600">Return overdue past target date</div>
            </div>
          </div>

          {!dashboard.approver_user_id && user?.role === 'admin' && (
            <div className="card p-3 bg-amber-50 border border-amber-200 text-xs text-gray-700">
              <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded text-[10px] uppercase font-semibold mr-2">Action needed</span>
              No rental approver (Ajmer) configured yet. Open the <button onClick={() => setTab('settings')} className="text-red-700 underline font-semibold">Settings</button> tab to set one.
            </div>
          )}
        </div>
      )}

      {/* ============ ENQUIRIES LIST ============ */}
      {tab === 'enquiries' && (<>
        <div className="card p-3 flex items-center gap-2">
          <input className="input text-sm flex-1" placeholder="Search enquiry / site / vendor / tool…" value={filters.q} onChange={e => setFilters({ ...filters, q: e.target.value })} />
          {filters.stage && (
            <span className="text-xs text-gray-500">
              Showing <strong>{STAGE_LABEL[filters.stage] || (filters.stage === 'cancelled' ? 'Cancelled' : filters.stage)}</strong>
              {' '}({enquiries.length})
            </span>
          )}
          {(filters.q || filters.stage) && (
            <button onClick={() => setFilters({ stage: '', status: '', q: '' })} className="btn btn-secondary text-sm">Clear</button>
          )}
        </div>
        <div className="card p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="bg-gray-50 text-xs uppercase text-gray-600">
              <th className="text-left px-3 py-2">Enquiry</th>
              <th className="text-left px-3 py-2">Site / Tool</th>
              <th className="text-left px-3 py-2">Req Date</th>
              <th className="text-right px-3 py-2">Days</th>
              <th className="text-left px-3 py-2">Site Eng</th>
              <th className="text-left px-3 py-2">Vendor / Rate</th>
              <th className="text-left px-3 py-2">PO</th>
              <th className="text-left px-3 py-2">Stage</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-center px-3 py-2">Action</th>
            </tr></thead>
            <tbody>
              {enquiries.length === 0 ? (
                <tr><td colSpan="10" className="text-center text-gray-400 py-8">No enquiries — click "Raise Enquiry"</td></tr>
              ) : enquiries.map(e => (
                <tr key={e.id} onClick={() => openDrawer(e.id)} className="cursor-pointer hover:bg-red-50/40 border-b">
                  <td className="px-3 py-2 font-mono text-xs text-blue-700 hover:underline">{e.enquiry_no}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{e.site_name}</div>
                    {e.tool_description && <div className="text-xs text-gray-500">{e.tool_description}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs">{fmtD(e.date_of_requirement)}</td>
                  <td className="px-3 py-2 text-right font-semibold">{e.days_required}</td>
                  <td className="px-3 py-2 text-xs">{e.site_engineer_name || '—'}</td>
                  <td className="px-3 py-2 text-xs">
                    {e.vendor_name ? (<>
                      <div>{e.vendor_name}</div>
                      <div className="text-gray-500">{fmt(e.vendor_rate)} / {e.vendor_rate_unit?.replace('per_', '')}</div>
                    </>) : '—'}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{e.po_number || '—'}</td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded text-xs ${STAGE_COLOR[e.current_stage]}`}>{STAGE_LABEL_SHORT[e.current_stage] || e.current_stage}</span></td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded text-xs ${e.status === 'open' ? 'bg-gray-100 text-gray-700' : e.status === 'closed' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>{e.status}</span></td>
                  {/* Eye-button action (mam, 2026-05-16: "i need action eye
                      button").  Whole row is also clickable so this is the
                      explicit affordance for anyone who doesn't realise
                      the row is interactive.  stopPropagation isn't needed
                      since both paths open the same drawer. */}
                  <td className="px-3 py-2 text-center">
                    <button onClick={(ev) => { ev.stopPropagation(); openDrawer(e.id); }}
                            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                            title="View / act on this enquiry">
                      <FiEye size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>)}

      {/* ============ SETTINGS (admin) ============ */}
      {tab === 'settings' && user?.role === 'admin' && (
        <SettingsPanel dashboard={dashboard} usersList={usersList} reload={loadDashboard} />
      )}

      {/* ============ RAISE ENQUIRY MODAL ============ */}
      <Modal isOpen={createModal} onClose={() => setCreateModal(false)} title="Raise Rental Tool Enquiry">
        <form onSubmit={createEnquiry} className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            {/* Site Name — dropdown from Business Book master (mam,
                2026-05-16: "site name from business book").  Combobox
                so user can type to filter and still type a free-text
                site if it isn't in BB yet (one-off rental that
                won't get a BB entry). */}
            <div>
              <label className="label">Site Name *</label>
              <input
                className="input"
                list="rental-site-options"
                required
                value={form.site_name}
                onChange={e => setForm({ ...form, site_name: e.target.value })}
                placeholder="Pick from Business Book or type…"
                autoComplete="off"
              />
              <datalist id="rental-site-options">
                {bbSites.map(name => <option key={name} value={name} />)}
              </datalist>
            </div>
            <div><label className="label">Tool / Machine</label><input className="input" value={form.tool_description} onChange={e => setForm({ ...form, tool_description: e.target.value })} placeholder="Scissor lift 12m" /></div>
            <div><label className="label">Date of Requirement *</label><input className="input" type="date" required value={form.date_of_requirement} onChange={e => setForm({ ...form, date_of_requirement: e.target.value })} /></div>
            <div><label className="label">Days Required *</label><input className="input" type="number" min="1" required value={form.days_required} onChange={e => setForm({ ...form, days_required: +e.target.value })} /></div>
            <div className="col-span-2">
              <label className="label">Site Engineer *</label>
              <select className="select" required value={form.site_engineer_id} onChange={e => {
                const u = usersList.find(x => x.id === +e.target.value);
                setForm({ ...form, site_engineer_id: e.target.value, site_engineer_name: u?.name || '' });
              }}>
                <option value="">— Select —</option>
                {usersList.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
          </div>
          <div className="text-[11px] text-gray-500 italic bg-amber-50 border border-amber-200 rounded p-2">
            Once raised, Ajmer has <strong>5 business hours</strong> to finalise vendor + rate. After 5 PM rolls to next morning · Sunday rolls to Monday.
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setCreateModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Raise Enquiry</button></div>
        </form>
      </Modal>

      {/* ============ ENQUIRY DETAIL DRAWER ============ */}
      {drawerEnq && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={closeDrawer}></div>
          <div className="fixed top-0 right-0 h-full w-full sm:w-[560px] bg-white shadow-2xl z-50 overflow-y-auto">
            <div className="sticky top-0 bg-gradient-to-r from-blue-800 to-blue-950 text-white p-4 flex items-center justify-between">
              <div className="min-w-0">
                <div className="text-xs opacity-80 uppercase tracking-wider">{drawerEnq.enquiry_no}</div>
                <div className="font-semibold truncate">{drawerEnq.site_name}</div>
                <div className="text-xs opacity-80">{drawerEnq.tool_description || '—'} · {drawerEnq.days_required} days</div>
              </div>
              <button onClick={closeDrawer} className="p-2 hover:bg-white/10 rounded text-xl">×</button>
            </div>

            <div className="p-4 space-y-4">
              {/* Snapshot */}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-gray-50 border rounded p-2">
                  <div className="text-gray-500 uppercase text-[10px]">Stage</div>
                  <div><span className={`px-2 py-0.5 rounded text-xs ${STAGE_COLOR[drawerEnq.current_stage]}`}>{STAGE_LABEL_SHORT[drawerEnq.current_stage] || drawerEnq.current_stage}</span></div>
                </div>
                <div className="bg-gray-50 border rounded p-2">
                  <div className="text-gray-500 uppercase text-[10px]">Status</div>
                  <div className="capitalize font-semibold">{drawerEnq.status}</div>
                </div>
                <div className="bg-gray-50 border rounded p-2 col-span-2">
                  <div className="text-gray-500 uppercase text-[10px]">Req Date / Site Engineer</div>
                  <div>{fmtD(drawerEnq.date_of_requirement)} · {drawerEnq.site_engineer_name || '—'}</div>
                </div>
                {drawerEnq.stage1_target_at && (
                  <div className={`border rounded p-2 col-span-2 ${drawerEnq.stage1_breached ? 'bg-red-50 border-red-200' : 'bg-blue-50 border-blue-200'}`}>
                    <div className="text-gray-500 uppercase text-[10px]">Stage 1 target (rate finalisation)</div>
                    <div className="text-xs">{fmtDt(drawerEnq.stage1_target_at)}{drawerEnq.stage1_breached ? ' · BREACHED' : ''}</div>
                  </div>
                )}
                {drawerEnq.return_target_date && (
                  <div className={`border rounded p-2 col-span-2 ${drawerEnq.stage3_breached ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'}`}>
                    <div className="text-gray-500 uppercase text-[10px]">Return target date</div>
                    <div className="text-xs">{fmtD(drawerEnq.return_target_date)}{drawerEnq.stage3_breached ? ' · OVERDUE' : ''}</div>
                  </div>
                )}
                {/* Always-on PO card — once Stage 1 finalises, the PO
                    is downloadable from here regardless of which
                    stage the enquiry is currently in (mam, 2026-05-16:
                    "where can is pdf of po after create"). */}
                {drawerEnq.po_number && (
                  <div className="border rounded p-2 col-span-2 bg-emerald-50 border-emerald-200 flex items-center justify-between gap-2">
                    <div>
                      <div className="text-gray-500 uppercase text-[10px]">Purchase Order</div>
                      <div className="text-xs font-mono">{drawerEnq.po_number}</div>
                    </div>
                    <a href={`/rental-po/${drawerEnq.id}/print`} target="_blank" rel="noopener noreferrer"
                       className="btn btn-secondary text-xs flex items-center gap-1.5">
                      <FiFileText size={12} /> View / Print PO
                    </a>
                  </div>
                )}
              </div>

              {/* === STAGE 1: Finalise Rate (Ajmer only) === */}
              {drawerEnq.current_stage === 'enquiry' && (
                <div className="border rounded p-3 space-y-3">
                  <div className="text-xs font-semibold uppercase text-gray-700 flex items-center gap-2">
                    <FiFileText /> Stage 1 · Finalise Rate + Create PO
                  </div>
                  {!isApprover && (
                    <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                      {dashboard?.approver_user_id
                        ? <>Only the designated approver (Ajmer) can finalise. Logged in as {user?.name}.</>
                        : <>Only users with approve permission on Rental Tools can finalise. Ask admin to grant it or set an approver in Settings.</>}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <label className="space-y-1 col-span-2">
                      <span className="text-gray-600">Vendor *</span>
                      <select className="select w-full" value={rateForm.vendor_id} onChange={e => {
                        const v = vendors.find(x => x.id === +e.target.value);
                        setRateForm({ ...rateForm, vendor_id: e.target.value, vendor_name: v?.name || '' });
                      }}>
                        <option value="">— Select vendor —</option>
                        {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                      </select>
                    </label>
                    <label className="space-y-1">
                      <span className="text-gray-600">Rate (₹) *</span>
                      <input className="input w-full" type="number" step="0.01" value={rateForm.vendor_rate} onChange={e => {
                        const total = e.target.value ? (+e.target.value * +drawerEnq.days_required).toFixed(2) : '';
                        setRateForm({ ...rateForm, vendor_rate: e.target.value, total_amount: total });
                      }} />
                    </label>
                    <label className="space-y-1">
                      <span className="text-gray-600">Per</span>
                      <select className="select w-full" value={rateForm.vendor_rate_unit} onChange={e => setRateForm({ ...rateForm, vendor_rate_unit: e.target.value })}>
                        <option value="per_day">per day</option>
                        <option value="per_hour">per hour</option>
                        <option value="lumpsum">lump sum</option>
                      </select>
                    </label>
                    <label className="space-y-1">
                      <span className="text-gray-600">PO Number *</span>
                      <input className="input w-full" value={rateForm.po_number} onChange={e => setRateForm({ ...rateForm, po_number: e.target.value })} />
                    </label>
                    <label className="space-y-1">
                      <span className="text-gray-600">PO Date *</span>
                      <input className="input w-full" type="date" value={rateForm.po_date} onChange={e => setRateForm({ ...rateForm, po_date: e.target.value })} />
                    </label>
                    <label className="space-y-1">
                      <span className="text-gray-600">Total Amount (₹) *</span>
                      <input className="input w-full" type="number" step="0.01" value={rateForm.total_amount} onChange={e => setRateForm({ ...rateForm, total_amount: e.target.value })} />
                    </label>
                    <label className="space-y-1">
                      <span className="text-gray-600">Advance (₹)</span>
                      <input className="input w-full" type="number" step="0.01" value={rateForm.advance_amount} onChange={e => setRateForm({ ...rateForm, advance_amount: e.target.value })} />
                    </label>
                    {/* PO Copy Link removed (mam, 2026-05-16: "if po is
                        create in it why here need po link") — the PO is
                        being CREATED by this form, so a copy link makes
                        no sense.  The newly-created PO record is
                        linked to this enquiry via po_id and visible in
                        the standard Purchase Orders module. */}
                    <label className="space-y-1 col-span-2">
                      <span className="text-gray-600">CRM Name</span>
                      <input className="input w-full" value={rateForm.crm_name} onChange={e => setRateForm({ ...rateForm, crm_name: e.target.value })} />
                    </label>
                  </div>
                  <button onClick={finaliseRate} disabled={!isApprover}
                          className="btn btn-primary w-full text-sm flex items-center justify-center gap-2 disabled:opacity-50">
                    <FiCheckCircle /> Finalise Rate & Create PO
                  </button>
                </div>
              )}

              {/* === STAGE 2: Material Received (site eng) === */}
              {drawerEnq.current_stage === 'rate_finalised' && (
                <div className="border rounded p-3 space-y-3">
                  <div className="text-xs font-semibold uppercase text-gray-700 flex items-center gap-2">
                    <FiCamera /> Stage 2 · Material Received at Site
                  </div>
                  <div className="text-xs bg-gray-50 border rounded p-2 space-y-1">
                    <div><strong>Vendor:</strong> {drawerEnq.vendor_name} · {fmt(drawerEnq.vendor_rate)}/{drawerEnq.vendor_rate_unit?.replace('per_', '')}</div>
                    <div className="flex items-center justify-between gap-2">
                      <div><strong>PO:</strong> {drawerEnq.po_number || '—'}</div>
                      {drawerEnq.po_number && (
                        <a href={`/rental-po/${drawerEnq.id}/print`} target="_blank" rel="noopener noreferrer"
                           className="text-red-600 hover:text-red-800 underline text-[11px] flex items-center gap-1">
                          <FiFileText size={12} /> View / Print PO
                        </a>
                      )}
                    </div>
                    <div className="text-gray-500">Site engineer takes a live photo + allows GPS when material lands at site.</div>
                  </div>
                  {!mayEdit && (
                    <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                      You need edit permission on Rental Tools to mark material received. Ask admin to grant it.
                    </div>
                  )}
                  <input ref={fileInputRef} type="file" accept="image/*" capture="environment" onChange={onPhotoPicked} className="hidden" />
                  <button onClick={captureAndUploadPhoto} disabled={uploadingPhoto || !mayEdit}
                          className="btn btn-primary w-full text-sm flex items-center justify-center gap-2 disabled:opacity-50">
                    <FiCamera /> {uploadingPhoto ? 'Uploading…' : 'Take Photo & Mark Received'}
                  </button>
                </div>
              )}

              {/* === STAGE 3: Return (Ajmer) === */}
              {drawerEnq.current_stage === 'material_received' && (
                <div className="border rounded p-3 space-y-3">
                  <div className="text-xs font-semibold uppercase text-gray-700 flex items-center gap-2">
                    <FiCheckCircle /> Stage 3 · Return to Vendor
                  </div>
                  <div className="text-xs bg-gray-50 border rounded p-2 space-y-1">
                    <div><strong>Material received:</strong> {fmtDt(drawerEnq.material_received_at)}</div>
                    {drawerEnq.material_received_photo && <div><a href={drawerEnq.material_received_photo} target="_blank" rel="noreferrer" className="text-blue-600 underline">View receipt photo</a></div>}
                    <div><strong>Return target:</strong> {fmtD(drawerEnq.return_target_date)}</div>
                  </div>
                  {!isApprover && (
                    <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                      {dashboard?.approver_user_id
                        ? <>Only Ajmer can sign the return.</>
                        : <>Only users with approve permission on Rental Tools can sign the return.</>}
                    </div>
                  )}
                  <label className="space-y-1 text-xs block">
                    <span className="text-gray-600">Notes (optional)</span>
                    <input className="input w-full" value={returnNotes} onChange={e => setReturnNotes(e.target.value)} placeholder="e.g. one drum dented, ₹500 deduction" />
                  </label>
                  <button onClick={signReturn} disabled={!isApprover}
                          className="btn btn-primary w-full text-sm flex items-center justify-center gap-2 disabled:opacity-50">
                    <FiCheckCircle /> Sign Return & Close
                  </button>
                </div>
              )}

              {/* === Done === */}
              {drawerEnq.current_stage === 'returned' && (
                <div className="border-2 border-emerald-200 bg-emerald-50 rounded p-3 text-center text-emerald-700 font-semibold text-sm">
                  <FiCheckCircle size={24} className="mx-auto mb-1" />
                  Returned & closed · {fmtDt(drawerEnq.returned_at)}
                </div>
              )}

              {/* Cancel link — server needs the edit bit, so hide it
                  from view-only users instead of letting them click
                  into a 403 "Failed" toast. */}
              {drawerEnq.status === 'open' && mayEdit && (
                <button onClick={cancelEnquiry} className="text-xs text-red-600 hover:underline flex items-center gap-1">
                  <FiXCircle size={12} /> Cancel this enquiry
                </button>
              )}

              {/* Timeline */}
              <div>
                <div className="text-xs font-semibold uppercase text-gray-700 mb-2">Timeline ({drawerEnq.history?.length || 0})</div>
                {(!drawerEnq.history || !drawerEnq.history.length) ? (
                  <div className="text-xs text-gray-400 text-center py-3">No history yet</div>
                ) : (
                  <div className="space-y-2">
                    {[...drawerEnq.history].reverse().map(h => (
                      <div key={h.id} className="border-l-2 border-red-300 pl-3 py-1 text-xs">
                        <div className="text-gray-500 text-[10px]">{fmtDateTime(h.entered_at)}</div>
                        <div className="font-medium">
                          {h.from_stage === h.to_stage ? <span className="text-gray-600">{h.notes}</span> :
                            <><span className="text-gray-400">{h.from_stage || 'new'} → </span><span className="text-red-700">{STAGE_LABEL[h.to_stage] || h.to_stage}</span></>
                          }
                        </div>
                        {h.from_stage !== h.to_stage && h.notes && <div className="text-gray-500 italic">{h.notes}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SettingsPanel({ dashboard, usersList, reload }) {
  const [picked, setPicked] = useState(dashboard?.approver_user_id || '');
  const saveApprover = async () => {
    try {
      await api.put('/rental-tools/settings/approver', { user_id: picked || null });
      toast.success('Approver saved');
      reload();
    } catch { toast.error('Save failed'); }
  };

  // Stage-label rename — admin-only section (mam, 2026-05-16: "i
  // need in setting all stages name and show only admin").  Loads
  // defaults + current overrides from /settings/stage-labels so
  // the admin sees both the live values and the originals for
  // reference.
  const [stageLabels, setStageLabels] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [savingLabels, setSavingLabels] = useState(false);
  useEffect(() => {
    api.get('/rental-tools/settings/stage-labels').then(r => {
      setDefaults(r.data.defaults);
      setStageLabels(r.data.current);
    }).catch(() => {});
  }, []);
  const saveLabels = async () => {
    if (!stageLabels) return;
    setSavingLabels(true);
    try {
      await api.put('/rental-tools/settings/stage-labels', stageLabels);
      toast.success('Stage names saved');
      reload();
    } catch (e) {
      toast.error('Save failed');
    } finally {
      setSavingLabels(false);
    }
  };
  const resetOne = (key) => setStageLabels(prev => ({ ...prev, [key]: defaults[key] }));
  const resetAll = () => setStageLabels({ ...defaults });

  return (
    <div className="space-y-6 max-w-2xl">
      {/* ── Section 1 · Rental approver (existing) ──────────── */}
      <div className="card p-4 space-y-3">
        <h2 className="font-semibold">Rental approver (Ajmer)</h2>
        <p className="text-xs text-gray-500">
          Only this user can finalise rates (Stage 1) and sign returns (Stage 3). Set once,
          change when Ajmer is on leave.
        </p>
        <select className="select" value={picked} onChange={e => setPicked(e.target.value)}>
          <option value="">— Anyone with approve permission —</option>
          {usersList.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <button onClick={saveApprover} className="btn btn-primary text-sm">Save Approver</button>
      </div>

      {/* ── Section 2 · Stage names (new, admin-only) ───────── */}
      <div className="card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold">Stage names</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Rename any stage to match your team's language. Changes show everywhere
              (chips, badges, drawer, exports) for every user.
            </p>
          </div>
          {defaults && (
            <button onClick={resetAll} className="text-xs text-gray-600 hover:text-red-600 underline">
              Reset all to defaults
            </button>
          )}
        </div>
        {!stageLabels || !defaults ? (
          <div className="text-xs text-gray-400 text-center py-4">Loading…</div>
        ) : (
          <div className="space-y-2">
            {Object.keys(defaults).map(key => (
              <div key={key} className="grid grid-cols-12 gap-2 items-center">
                <code className="col-span-3 text-[11px] text-gray-500 font-mono break-all">{key}</code>
                <input
                  className="input col-span-7 text-sm"
                  value={stageLabels[key] || ''}
                  onChange={e => setStageLabels({ ...stageLabels, [key]: e.target.value })}
                  placeholder={defaults[key]}
                  maxLength={80}
                />
                <button
                  onClick={() => resetOne(key)}
                  disabled={stageLabels[key] === defaults[key]}
                  className="col-span-2 text-[10px] text-gray-500 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed"
                  title={`Reset to "${defaults[key]}"`}>
                  Reset
                </button>
              </div>
            ))}
            <div className="pt-2">
              <button onClick={saveLabels} disabled={savingLabels} className="btn btn-primary text-sm">
                {savingLabels ? 'Saving…' : 'Save Stage Names'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
