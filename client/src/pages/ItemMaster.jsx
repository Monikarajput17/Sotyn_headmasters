import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import PipeWeightsModal from '../components/PipeWeightsModal';
import { MAKES } from '../data/makes';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { fmtDateTime } from '../utils/datetime';
import { FiPlus, FiEdit2, FiTrash2, FiSearch, FiDownload, FiUpload, FiPackage, FiFilter, FiX, FiClock, FiAlertTriangle, FiChevronLeft, FiChevronRight, FiImage } from 'react-icons/fi';

const PAGE_SIZE = 100;

// MD's Phase 1 (this week):
//   "Right now Price is just a number — no date, no vendor, no bill.
//    We can't trust it for tenders."
// Replaces the bare current_price with structured pricing provenance:
//   Rate · Vendor (FK) · Source Type (PO/Quote/Manual/Online) · Bill/PO
//   Number · Bill/PO Date · Captured On (auto) · Captured By (auto)
// Plus Price Age colour-coded column (green ≤30 / yellow 31-60 / red
// 60+), filter pills (Expired / Ageing / Make blank / No vendor), and
// a non-destructive Price History viewer per row.

const DEPARTMENTS = ['FF', 'LV', 'ELE', 'CCTV', 'AC', 'NET', 'SOL', 'PLB', 'OTHER'];
const DEPT_LABELS = { FF: 'Fire Fighting', LV: 'Low Voltage', ELE: 'Electrical', CCTV: 'CCTV', AC: 'Access Control', NET: 'Networking', SOL: 'Solar', PLB: 'Plumbing', OTHER: 'Other' };
// PO  = chargeable purchase
// FOC = free-of-cost (no rate, no GST line)
// RGP = Returnable Gate Pass (contractor's own tools to site, return after)
// RENTAL = rented from vendor for short-term use (mam 2026-05-27).
//          Picked from this list in the Rental indent flow, validated
//          against current_price so renting can't cost ≥ buying outright.
const TYPES = ['PO', 'POC', 'FOC', 'RGP', 'RENTAL'];
const UOMS = ['PCS', 'MTR', 'KG', 'SQMM', 'PACKET', 'SET', 'LOT', 'PAIR', 'RFT', 'LTR', 'BOX', 'COIL'];
const SOURCE_TYPES = ['PO', 'Quote', 'Manual', 'Online', 'Bill'];

const emptyForm = {
  item_code: '', department: 'FF', item_name: '', specification: '', size: '',
  uom: 'PCS', gst: '18%', type: 'PO', make: '', model_number: '',
  current_price: '',
  vendor_id: '', source_type: 'Manual', bill_po_number: '', bill_po_date: '',
  weight_per_meter: '', weight_per_pipe: '', pipe_length_m: '',
  photo_link: '',
};

// Pretty age badge — colours match MD's spec.
function AgeBadge({ status, days }) {
  if (status === 'never') return <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded border bg-gray-100 text-gray-500 border-gray-200">NEVER</span>;
  const cls = status === 'green'
    ? 'bg-emerald-100 text-emerald-700 border-emerald-300'
    : status === 'yellow'
      ? 'bg-amber-100 text-amber-800 border-amber-300'
      : 'bg-red-100 text-red-700 border-red-300';
  const label = status === 'red' ? `${days}d · EXPIRED` : `${days}d`;
  return <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${cls}`}>{label}</span>;
}

export default function ItemMaster() {
  const { canCreate, canEdit, canDelete, isAdmin } = useAuth();
  const admin = typeof isAdmin === 'function' ? isAdmin() : !!isAdmin;
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);  // 0-based
  const [loading, setLoading] = useState(false);
  const [vendors, setVendors] = useState([]);
  const [modal, setModal] = useState(null);
  const [bulkModal, setBulkModal] = useState(false);
  const [historyModal, setHistoryModal] = useState(null); // { item, rows }
  const [form, setForm] = useState({ ...emptyForm });
  // Allow opening pre-searched via ?search=CODE, or ?edit=CODE which also
  // auto-opens that item's Edit modal (the ✎ button in the PO/FOC builder
  // opens straight to this quick edit window).
  const [search, setSearch] = useState(() => { const p = new URLSearchParams(window.location.search); return p.get('search') || p.get('edit') || ''; });
  const autoEditCode = useRef((new URLSearchParams(window.location.search)).get('edit'));
  const autoEditDone = useRef(false);
  const [filterDept, setFilterDept] = useState('');
  const [statusFilter, setStatusFilter] = useState(''); // expired | ageing | fresh | never | make_blank | no_vendor
  const [approvalFilter, setApprovalFilter] = useState(''); // '' | pending | approved | rejected
  const [pendingCount, setPendingCount] = useState(0);
  const [bulkData, setBulkData] = useState('');
  const [bulkPreview, setBulkPreview] = useState([]);
  const [pipeModal, setPipeModal] = useState(false);
  const [pipeWeights, setPipeWeights] = useState([]);  // lookup for the item form dropdown
  const [lightbox, setLightbox] = useState(null);      // photo URL shown full-size on click

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (filterDept) params.set('department', filterDept);
    if (statusFilter) params.set('status', statusFilter);
    if (approvalFilter) params.set('approval', approvalFilter);
    params.set('limit', PAGE_SIZE);
    params.set('offset', page * PAGE_SIZE);
    setLoading(true);
    api.get(`/item-master?${params}`)
      .then(r => { setItems(r.data.items || []); setTotal(r.data.total || 0); })
      .catch(err => { toast.error(err.response?.data?.error || 'Could not load items'); })
      .finally(() => setLoading(false));
  }, [search, filterDept, statusFilter, approvalFilter, page]);

  useEffect(() => { load(); }, [load]);

  // Data-completion dashboard (mam 2026-06-15) — global stats across ALL items
  // (not the current page/filter). Reloaded on mount + after any save/delete.
  const [completion, setCompletion] = useState(null);
  const loadCompletion = useCallback(() => {
    api.get('/item-master/completion').then(r => setCompletion(r.data)).catch(() => {});
  }, []);
  useEffect(() => { loadCompletion(); }, [loadCompletion]);

  // Pending-approval count for the review banner (refreshes with the list).
  const loadPendingCount = useCallback(() => {
    api.get('/item-master/approval/pending-count')
      .then(r => setPendingCount(r.data?.pending || 0))
      .catch(() => {});
  }, []);
  useEffect(() => { loadPendingCount(); }, [loadPendingCount, items]);

  // Approve / reject a pending item (Admin only). Refreshes list + count.
  const setApproval = async (item, action) => {
    try {
      await api.post(`/item-master/${item.id}/${action}`);
      toast.success(action === 'approve' ? 'Item approved' : 'Item rejected');
      load(); loadPendingCount();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  const approveAllPending = async () => {
    if (!window.confirm(`Approve all ${pendingCount} pending item(s)?`)) return;
    try {
      const r = await api.post('/item-master/approval/approve-all');
      toast.success(r.data?.message || 'Approved');
      load(); loadPendingCount();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  // Auto-open the Edit modal when launched via ?edit=CODE (from the PO/FOC ✎).
  useEffect(() => {
    if (autoEditDone.current || !autoEditCode.current || !items.length) return;
    const it = items.find(i => String(i.item_code || '').toLowerCase() === String(autoEditCode.current).toLowerCase());
    if (it) { setForm({ ...it, vendor_id: it.vendor_id || '' }); setModal('edit'); autoEditDone.current = true; }
  }, [items]);

  // Snap back to page 1 whenever a filter or search changes so the user
  // doesn't end up on page 14 of a 2-page result and see "No items".
  useEffect(() => { setPage(0); }, [search, filterDept, statusFilter, approvalFilter]);
  useEffect(() => {
    // Lazy-load vendors so the Vendor dropdown in the modal works.
    api.get('/procurement/vendors').then(r => setVendors(r.data || [])).catch(() => setVendors([]));
  }, []);

  // Pipe Weights lookup — for the kg/m picker in the item form. Reloaded
  // when the Pipe Weights master modal closes (mam may have added rows).
  const loadPipeWeights = useCallback(() => {
    api.get('/pipe-weights/lookup').then(r => setPipeWeights(r.data || [])).catch(() => setPipeWeights([]));
  }, []);
  useEffect(() => { loadPipeWeights(); }, [loadPipeWeights]);

  const handleSave = async (e) => {
    e.preventDefault();
    // Mandatory fields (mam 2026-06-15): Item Name, Type, Specification, Size,
    // UOM, GST, Make, Rate.
    const missing = [];
    if (!String(form.item_name || '').trim()) missing.push('Item Name');
    if (!String(form.type || '').trim()) missing.push('Type');
    if (!String(form.specification || '').trim()) missing.push('Specification');
    if (!String(form.size || '').trim()) missing.push('Size');
    if (!String(form.uom || '').trim()) missing.push('UOM');
    if (!String(form.gst || '').trim()) missing.push('GST');
    if (!String(form.make || '').trim()) missing.push('Make');
    if (form.current_price === '' || form.current_price == null) missing.push('Rate');
    // Full pricing traceability (mam 2026-06-15): every rate must carry its
    // source — Vendor, Source Type, Bill/PO Number, Bill/PO Date.
    if (!form.vendor_id) missing.push('Vendor');
    if (!String(form.source_type || '').trim()) missing.push('Source Type');
    if (!String(form.bill_po_number || '').trim()) missing.push('Bill/PO Number');
    if (!String(form.bill_po_date || '').trim()) missing.push('Bill/PO Date');
    // Admin bypasses mandatory fields (mam 2026-06-19) — can update partial.
    if (missing.length && !isAdmin()) { toast.error(`Required: ${missing.join(', ')}`); return; }
    try {
      const payload = {
        ...form,
        vendor_id: form.vendor_id || null,
        // '' (cleared) → 0 so the rate field can be blanked while typing.
        current_price: form.current_price === '' || form.current_price == null ? 0 : Number(form.current_price),
      };
      if (modal === 'edit' && form.id) {
        await api.put(`/item-master/${form.id}`, payload);
        toast.success('Item updated');
      } else {
        const res = await api.post('/item-master', payload);
        toast.success(`Item created: ${res.data.item_code}`);
      }
      setModal(null); setForm({ ...emptyForm }); load(); loadCompletion();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const handleDelete = async (id, code) => {
    if (!confirm(`Delete item ${code}?`)) return;
    try { await api.delete(`/item-master/${id}`); toast.success('Deleted'); load(); loadCompletion(); } catch { toast.error('Failed'); }
  };

  const openHistory = async (item) => {
    try {
      const r = await api.get(`/item-master/${item.id}/price-history`);
      setHistoryModal({ item, rows: r.data || [] });
    } catch { toast.error('Could not load history'); }
  };

  // CSV: matches the new column set MD asked for. Export pulls the
  // ENTIRE filtered set in one go (limit=99999) rather than the
  // currently-visible page — otherwise mam exports 100 rows and thinks
  // 2,285 are missing.
  const exportCSV = async () => {
    if (total === 0) return toast.error('No data');
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (filterDept) params.set('department', filterDept);
    if (statusFilter) params.set('status', statusFilter);
    params.set('limit', 99999);
    let all = [];
    try {
      const r = await api.get(`/item-master?${params}`);
      all = r.data.items || [];
    } catch { toast.error('Export failed'); return; }
    if (all.length === 0) return toast.error('No data');
    const headers = ['Item Code', 'Department', 'Item Name', 'Specification', 'Size', 'UOM', 'GST', 'Type', 'Make', 'Model', 'Rate', 'Vendor Name', 'Source Type', 'Bill/PO Number', 'Bill/PO Date', 'Captured On', 'Captured By', 'Age (days)', 'Age Status'];
    const rows = all.map(i => [
      i.item_code, i.department, i.item_name, i.specification, i.size, i.uom, i.gst, i.type,
      i.make, i.model_number, i.current_price,
      i.vendor_name || '', i.source_type || '', i.bill_po_number || '', i.bill_po_date || '',
      (i.priced_at || '').replace('T', ' ').slice(0, 16), i.priced_by_name || '',
      i.age_days ?? '', i.age_status || '',
    ]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${(c ?? '').toString().replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' }); const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `item-master-${new Date().toISOString().split('T')[0]}.csv`; a.click();
    toast.success(`Exported ${all.length} items`);
  };

  const downloadTemplate = () => {
    const headers = 'Item Code,Department,Item Name,Specification,Size,UOM,GST,Type,Make,Rate,Vendor Name,Source Type,Bill/PO Number,Bill/PO Date';
    const sample = 'FF0100,FF,HYDRANT VALVE,SS BODY,63MM,PCS,18%,PO,AGNI,2500,Agni Devices Ltd,PO,SEPL/PO/2026/042,2026-04-15';
    const csv = headers + '\n' + sample;
    const blob = new Blob([csv], { type: 'text/csv' }); const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'item-master-template.csv'; a.click();
  };

  const parseCSV = (text) => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return [];
    return lines.slice(1).map(line => {
      const c = line.split(',').map(v => v.replace(/^"|"$/g, '').trim());
      if (!c[2]) return null;
      return {
        item_code: c[0], department: c[1], item_name: c[2], specification: c[3], size: c[4],
        uom: c[5] || 'PCS', gst: c[6] || '18%', type: c[7] || 'PO', make: c[8],
        current_price: parseFloat(c[9]) || 0,
        vendor_name: c[10] || '',
        source_type: c[11] || 'Manual',
        bill_po_number: c[12] || '',
        bill_po_date: c[13] || '',
      };
    }).filter(Boolean);
  };

  const handleFile = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { setBulkData(ev.target.result); setBulkPreview(parseCSV(ev.target.result)); };
    reader.readAsText(file); e.target.value = '';
  };

  const bulkImport = async () => {
    if (bulkPreview.length === 0) return toast.error('No valid data');
    try {
      const res = await api.post('/item-master/bulk', { items: bulkPreview });
      toast.success(`Added ${res.data.added} of ${res.data.total} items`);
      setBulkModal(false); setBulkData(''); setBulkPreview([]); load();
    } catch { toast.error('Import failed'); }
  };

  const F = (k, v) => setForm(f => ({ ...f, [k]: v }));
  // Auto-code prefix follows the department: changing FF→ELE re-prefixes an
  // auto-generated code (FF0001 → ELE0001). Custom/hand-typed codes are left
  // alone; an empty code stays empty (backend generates on save). mam 2026-06-22.
  const deptPrefix = (d) => String(d || 'GEN').toUpperCase().substring(0, 3);
  const changeDept = (d) => setForm(f => {
    const m = String(f.item_code || '').match(/^([A-Za-z]{1,4})(\d{2,})$/);
    return { ...f, department: d, item_code: m ? deptPrefix(d) + m[2] : (f.item_code || '') };
  });

  // MD's brief specified exactly 4 filter buttons (plus All to clear).
  // Per-item rate age has only 3 stages (green 0-30 / yellow 31-60 /
  // red 60+) — the badges colour-code each row, the pills filter the
  // list. Removed the earlier "Fresh" and "No Price Yet" extras that
  // weren't in MD's spec.
  const statusPills = [
    { id: '', label: 'All', cls: 'bg-gray-100 text-gray-700 border-gray-200' },
    { id: 'expired', label: 'Expired (60+ days)', cls: 'bg-red-100 text-red-700 border-red-300' },
    { id: 'ageing', label: 'Ageing (31–60 days)', cls: 'bg-amber-100 text-amber-800 border-amber-300' },
    { id: 'make_blank', label: 'Make Blank', cls: 'bg-purple-100 text-purple-700 border-purple-300' },
    { id: 'no_vendor', label: 'No Vendor Linked', cls: 'bg-indigo-100 text-indigo-700 border-indigo-300' },
  ];

  return (
    <div className="space-y-6">
      <div className="sticky-toolbar">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><FiPackage className="text-red-600" /> Item Master</h1>
            <p className="text-sm text-gray-500">{total.toLocaleString('en-IN')} items · with vendor + bill + age tracking</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button onClick={exportCSV} className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload size={15} /> Export</button>
            <button onClick={() => setPipeModal(true)} className="btn btn-secondary flex items-center gap-2 text-sm" title="Pipe MTR → KG weight master">🪈 Pipe Weights</button>
            {canCreate('item_master') && <>
              <button onClick={() => { setBulkData(''); setBulkPreview([]); setBulkModal(true); }} className="btn btn-secondary flex items-center gap-2 text-sm"><FiUpload size={15} /> Bulk Import</button>
              <button onClick={() => { setForm({ ...emptyForm }); setModal('add'); }} className="btn btn-primary flex items-center gap-2"><FiPlus size={15} /> Add Item</button>
            </>}
          </div>
        </div>

        {/* Data-completion dashboard (mam 2026-06-15): how much of the required
            item data is filled across ALL items = items × required fields. */}
        {completion && completion.total_items > 0 && (() => {
          const pct = completion.required_total ? Math.round((completion.filled_total / completion.required_total) * 100) : 0;
          const barColor = pct >= 80 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-500' : 'bg-red-500';
          const LBL = { item_name: 'Item Name', type: 'Type', specification: 'Specification', size: 'Size', uom: 'UOM', gst: 'GST', make: 'Make', rate: 'Rate', vendor: 'Vendor', source_type: 'Source', bill_po_number: 'Bill/PO No', bill_po_date: 'Bill/PO Date' };
          return (
            <div className="bg-white border rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="font-semibold text-sm text-gray-700">📊 Data Completion</div>
                <div className="text-xs text-gray-500">
                  <b className="text-gray-800">{completion.filled_total.toLocaleString('en-IN')}</b> / {completion.required_total.toLocaleString('en-IN')} fields filled
                  {' · '}<b className="text-emerald-700">{completion.complete_items.toLocaleString('en-IN')}</b> of {completion.total_items.toLocaleString('en-IN')} items fully complete
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden"><div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} /></div>
                <div className="text-sm font-bold w-12 text-right">{pct}%</div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {completion.per_field.filter(f => f.missing > 0).sort((a, b) => b.missing - a.missing).map(f => {
                  const target = f.key === 'make' ? 'make_blank' : f.key === 'vendor' ? 'no_vendor' : null;
                  return (
                    <button key={f.key} type="button" onClick={() => target && setStatusFilter(target)}
                      className={`text-[10px] px-2 py-0.5 rounded-full border bg-gray-50 text-gray-600 border-gray-200 ${target ? 'hover:bg-red-50 hover:border-red-300 cursor-pointer' : 'cursor-default'}`}
                      title={target ? 'Click to filter these items' : ''}>
                      {LBL[f.key] || f.key}: <b className="text-red-600">{f.missing.toLocaleString('en-IN')}</b> missing
                    </button>
                  );
                })}
                {completion.per_field.every(f => f.missing === 0) && <span className="text-[11px] text-emerald-700 font-semibold">✓ All items fully filled</span>}
              </div>
            </div>
          );
        })()}

        {/* MD's filter buttons */}
        <div className="flex flex-wrap gap-2">
          {statusPills.map(p => (
            <button
              key={p.id}
              onClick={() => setStatusFilter(p.id)}
              className={`text-[11px] font-semibold px-3 py-1.5 rounded-full border transition ${statusFilter === p.id ? `${p.cls} ring-2 ring-offset-1 ring-red-400` : 'bg-white text-gray-600 border-gray-200 hover:border-red-300 hover:text-red-700'}`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Approval filter (mam 2026-06-16) — new items need an Admin's OK. */}
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-[11px] font-semibold text-gray-500 mr-1">Approval:</span>
          {[
            { id: '', label: 'All' },
            { id: 'pending', label: `Pending${pendingCount ? ` (${pendingCount})` : ''}`, cls: 'bg-amber-100 text-amber-800 border-amber-300' },
            { id: 'approved', label: 'Approved', cls: 'bg-green-100 text-green-800 border-green-300' },
            { id: 'rejected', label: 'Rejected', cls: 'bg-red-100 text-red-700 border-red-300' },
          ].map(p => (
            <button
              key={p.id || 'all'}
              onClick={() => setApprovalFilter(p.id)}
              className={`text-[11px] font-semibold px-3 py-1.5 rounded-full border transition ${approvalFilter === p.id ? `${p.cls || 'bg-blue-100 text-blue-800 border-blue-300'} ring-2 ring-offset-1 ring-red-400` : 'bg-white text-gray-600 border-gray-200 hover:border-red-300 hover:text-red-700'}`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[280px_1fr_auto] gap-3 items-end">
          <div>
            <label className="label flex items-center gap-1"><FiFilter size={12} /> Department</label>
            <select className="select" value={filterDept} onChange={e => setFilterDept(e.target.value)}>
              <option value="">All Departments</option>
              {DEPARTMENTS.map(d => <option key={d} value={d}>{d} — {DEPT_LABELS[d] || d}</option>)}
            </select>
          </div>
          <div>
            <label className="label flex items-center gap-1"><FiSearch size={12} /> Search by name / spec / code / make</label>
            <div className="relative">
              <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
              <input className="input pl-10" placeholder="Type to search…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          </div>
          {(search || filterDept || statusFilter || approvalFilter) && (
            <button onClick={() => { setSearch(''); setFilterDept(''); setStatusFilter(''); setApprovalFilter(''); }} className="btn btn-secondary text-red-500 flex items-center gap-1 whitespace-nowrap">
              <FiX size={14} /> Clear
            </button>
          )}
        </div>
      </div>

      {/* Pending-approval review banner — new items wait for an Admin's OK. */}
      {pendingCount > 0 && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-amber-50 border border-amber-300 rounded-lg px-4 py-3">
          <div className="text-sm text-amber-900">
            <span className="font-bold">{pendingCount}</span> item{pendingCount > 1 ? 's' : ''} awaiting approval.
            {admin ? ' Review and approve so the item master stays correct.' : ' An Admin (e.g. Ankur Kaplesh) will approve them.'}
          </div>
          <div className="flex gap-2">
            <button onClick={() => setApprovalFilter('pending')} className="btn btn-secondary text-xs whitespace-nowrap">Review pending</button>
            {admin && <button onClick={approveAllPending} className="btn btn-primary text-xs whitespace-nowrap">Approve all</button>}
          </div>
        </div>
      )}

      {/* Table */}
      <div className="card p-0">
        <table className="min-w-full freeze-head">
          <thead><tr className="bg-gray-50">
            <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Code</th>
            <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Dept</th>
            <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Item / Spec / Size</th>
            <th className="px-3 py-3 text-center text-xs font-semibold text-gray-600">Photo</th>
            <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Make</th>
            {/* UOM column added per mam, 2026-05-16: "SHOW HERE UOM".
                Surfaces the cleanup script's normalised unit (MTR /
                LTR / PCS / KG / SET / etc.) so users always see how
                rates are quoted. */}
            <th className="px-3 py-3 text-center text-xs font-semibold text-gray-600">UOM</th>
            <th className="px-3 py-3 text-right text-xs font-semibold text-gray-600">Rate (₹)</th>
            <th className="px-3 py-3 text-center text-xs font-semibold text-gray-600">Price Age</th>
            <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Vendor</th>
            <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Source · Bill / PO</th>
            <th className="px-3 py-3 text-center text-xs font-semibold text-gray-600">Approval</th>
            <th className="px-3 py-3 text-center text-xs font-semibold text-gray-600">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {items.map(i => {
              const status = i.age_status || (i.current_price > 0 ? 'green' : 'never');
              const rowCls = status === 'red' ? 'bg-red-50/40 hover:bg-red-100/40' : status === 'yellow' ? 'bg-amber-50/40 hover:bg-amber-100/40' : 'hover:bg-red-50/30';
              const missingVendor = !i.vendor_id;
              const missingMake = !i.make || !i.make.trim();
              return (
                <tr key={i.id} className={rowCls}>
                  <td className="px-3 py-2 font-mono text-xs font-bold text-red-600">{i.item_code}</td>
                  <td className="px-3 py-2"><span className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">{i.department}</span></td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-sm">{i.item_name}</div>
                    <div className="text-xs text-gray-500">{[i.specification, i.size].filter(Boolean).join(' | ')}</div>
                  </td>
                  <td className="px-3 py-2 text-center">
                    {i.photo_link ? (
                      <img src={i.photo_link} alt={i.item_name} loading="lazy"
                        onClick={() => setLightbox(i.photo_link)}
                        className="w-10 h-10 object-cover rounded border border-gray-200 cursor-zoom-in hover:ring-2 hover:ring-red-300 inline-block align-middle" />
                    ) : (
                      <span className="text-[10px] text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-sm">
                    {missingMake ? <span className="text-[10px] text-purple-700 italic">— blank —</span> : i.make}
                  </td>
                  <td className="px-3 py-2 text-center text-xs">
                    {i.uom ? (
                      <span className="inline-flex px-2 py-0.5 rounded font-mono uppercase font-medium bg-gray-100 text-gray-700">{i.uom}</span>
                    ) : (
                      <span className="text-[10px] text-gray-400 italic">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-sm">
                    Rs {(+i.current_price || 0).toLocaleString('en-IN')}
                  </td>
                  <td className="px-3 py-2 text-center"><AgeBadge status={status} days={i.age_days} /></td>
                  <td className="px-3 py-2 text-sm">
                    {missingVendor
                      ? <span className="text-[10px] text-indigo-700 italic inline-flex items-center gap-0.5"><FiAlertTriangle size={10} /> not linked</span>
                      : i.vendor_name}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600">
                    <div>{i.source_type || '—'}</div>
                    {i.bill_po_number && <div className="font-mono text-[10px] text-gray-500">{i.bill_po_number}{i.bill_po_date ? ` · ${i.bill_po_date}` : ''}</div>}
                  </td>
                  {/* Approval status + Admin approve/reject (mam 2026-06-16). */}
                  <td className="px-3 py-2 text-center">
                    {(() => {
                      const st = i.approval_status || 'approved';
                      const badge = st === 'pending'
                        ? 'bg-amber-100 text-amber-800'
                        : st === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700';
                      const label = st.charAt(0).toUpperCase() + st.slice(1);
                      return (
                        <div className="flex flex-col items-center gap-1">
                          <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-semibold ${badge}`}>{label}</span>
                          {st === 'approved' && i.approved_by_name && <span className="text-[9px] text-gray-400">by {i.approved_by_name}</span>}
                          {admin && st !== 'approved' && (
                            <div className="flex gap-1">
                              <button onClick={() => setApproval(i, 'approve')} className="text-[10px] font-semibold px-2 py-0.5 rounded bg-green-600 text-white hover:bg-green-700">Approve</button>
                              {st !== 'rejected' && <button onClick={() => setApproval(i, 'reject')} className="text-[10px] font-semibold px-2 py-0.5 rounded bg-white text-red-600 border border-red-300 hover:bg-red-50">Reject</button>}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <button onClick={() => openHistory(i)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="Price history"><FiClock size={14} /></button>
                      {canEdit('item_master') && <button onClick={() => { setForm({ ...i, vendor_id: i.vendor_id || '' }); setModal('edit'); }} className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded"><FiEdit2 size={14} /></button>}
                      {canDelete('item_master') && <button onClick={() => handleDelete(i.id, i.item_code)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"><FiTrash2 size={14} /></button>}
                    </div>
                  </td>
                </tr>
              );
            })}
            {items.length === 0 && <tr><td colSpan="12" className="text-center py-12 text-gray-400"><FiPackage size={40} className="mx-auto mb-3 opacity-30" /><p>{loading ? 'Loading…' : 'No items found'}</p></td></tr>}
          </tbody>
        </table>
        {/* Paginator — keeps the page snappy even on 2,000+ item masters. */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 bg-gray-50 text-xs">
            <div className="text-gray-600">
              Showing <span className="font-semibold">{page * PAGE_SIZE + 1}</span>–<span className="font-semibold">{Math.min(total, (page + 1) * PAGE_SIZE)}</span> of <span className="font-semibold">{total.toLocaleString('en-IN')}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0 || loading}
                className="btn btn-secondary text-xs flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
              ><FiChevronLeft size={14} /> Prev</button>
              <span className="text-gray-500">Page <b>{page + 1}</b> of <b>{Math.max(1, Math.ceil(total / PAGE_SIZE))}</b></span>
              <button
                onClick={() => setPage(p => ((p + 1) * PAGE_SIZE < total ? p + 1 : p))}
                disabled={(page + 1) * PAGE_SIZE >= total || loading}
                className="btn btn-secondary text-xs flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
              >Next <FiChevronRight size={14} /></button>
            </div>
          </div>
        )}
      </div>

      {/* Add / Edit Modal */}
      <Modal isOpen={modal === 'add' || modal === 'edit'} onClose={() => setModal(null)} title={modal === 'edit' ? `Edit — ${form.item_code}` : 'Add Item'} wide>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            <div><label className="label">Item Code</label><input className="input font-mono" value={form.item_code || ''} onChange={e => F('item_code', e.target.value)} placeholder="Auto-generated if empty" /></div>
            <div><label className="label">Department *</label><select className="select" value={form.department} onChange={e => changeDept(e.target.value)}>{DEPARTMENTS.map(d => <option key={d} value={d}>{d} - {DEPT_LABELS[d] || d}</option>)}</select></div>
            <div><label className="label">Type *</label><select className="select" value={form.type} onChange={e => F('type', e.target.value)}>{TYPES.map(t => <option key={t}>{t}</option>)}</select></div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            <div><label className="label">Item Name *</label><input className="input" value={form.item_name || ''} onChange={e => F('item_name', e.target.value)} required /></div>
            <div><label className="label">Specification *</label><input className="input" value={form.specification || ''} onChange={e => F('specification', e.target.value)} /></div>
            <div><label className="label">Size *</label><input className="input" value={form.size || ''} onChange={e => F('size', e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div><label className="label">UOM *</label><select className="select" value={form.uom} onChange={e => F('uom', e.target.value)}>{UOMS.map(u => <option key={u}>{u}</option>)}</select></div>
            <div><label className="label">GST *</label>
              <select className="select" value={form.gst || ''} onChange={e => F('gst', e.target.value)}>
                <option value="">Select</option>
                {['0%', '5%', '12%', '18%', '28%'].map(g => <option key={g} value={g}>{g}</option>)}
                {form.gst && !['', '0%', '5%', '12%', '18%', '28%'].includes(form.gst) && <option value={form.gst}>{form.gst}</option>}
              </select>
            </div>
            <div><label className="label">Make *</label><input className="input" list="itemMakesDL" value={form.make || ''} onChange={e => F('make', e.target.value)} placeholder="Pick brand or type" /><datalist id="itemMakesDL">{MAKES.map(m => <option key={m} value={m} />)}</datalist></div>
            <div><label className="label">Model #</label><input className="input" value={form.model_number || ''} onChange={e => F('model_number', e.target.value)} /></div>
          </div>

          {/* Item photo (mam): upload an image — shows as a thumbnail in the
              list, click to view full-size. Uses the shared /upload endpoint. */}
          <div className="border border-gray-200 bg-gray-50/60 rounded-lg p-3">
            <label className="label flex items-center gap-2"><FiImage size={14} /> Item Photo <span className="text-xs text-gray-400 font-normal">— shown as a thumbnail in the list; click to enlarge</span></label>
            {form.photo_link ? (
              <div className="flex items-center gap-3">
                <img src={form.photo_link} alt="item" onClick={() => setLightbox(form.photo_link)}
                  className="w-16 h-16 object-cover rounded border border-gray-200 cursor-zoom-in hover:ring-2 hover:ring-red-300" />
                <a href={form.photo_link} target="_blank" rel="noreferrer" className="text-xs text-blue-600 underline truncate flex-1">{form.photo_link.split('/').pop()}</a>
                <button type="button" onClick={() => F('photo_link', '')} className="text-red-500 text-xs hover:underline">Remove</button>
              </div>
            ) : (
              <input type="file" accept="image/*"
                onChange={async (e) => {
                  const file = e.target.files[0]; if (!file) return;
                  try {
                    const fd = new FormData(); fd.append('file', file);
                    const res = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
                    F('photo_link', res.data.url);
                    toast.success('Photo uploaded');
                  } catch { toast.error('Upload failed'); }
                  e.target.value = '';
                }}
                className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100" />
            )}
          </div>

          {/* Pipe weight (mam 2026-06-25). Pipes are indented in METERS but
              purchased in KG. mam's rule: vendor-PO kg = indent qty × the
              WEIGHT PER PIPE entered here — NO dividing by length. e.g. 80 mm
              C-class weight 59.4, a 5 MTR indent → 5 × 59.4 = 297 kg. So the
              entered weight IS the conversion factor (stored as
              weight_per_meter, which the enquiry + PO multiply by qty). */}
          <div className="border border-blue-200 bg-blue-50/40 rounded-lg p-3">
            <label className="label">Pipe weight — weight per pipe (kg) <span className="text-xs text-gray-400 font-normal">— optional, only for pipes; vendor enquiry &amp; PO use kg = indent qty × this weight</span></label>
            <div className="flex flex-wrap gap-2 items-end">
              {/* Pick from the master — fills the weight per pipe. */}
              <div className="flex-1 min-w-[220px]">
                <label className="label text-[10px] mb-0.5 text-gray-500">Pick from Pipe Weights master</label>
                <select className="select" value=""
                  onChange={e => {
                    const pw = pipeWeights.find(p => String(p.id) === e.target.value);
                    if (!pw) return;
                    setForm(f => {
                      const wpp = (pw.weight_per_pipe != null && +pw.weight_per_pipe > 0) ? +pw.weight_per_pipe : (+pw.kg_per_meter || '');
                      return { ...f, weight_per_pipe: wpp, weight_per_meter: wpp };
                    });
                  }}>
                  <option value="">Pick from Pipe Weights master…</option>
                  {pipeWeights.map(p => <option key={p.id} value={p.id}>{p.pipe_class} class · {p.size} ({p.weight_per_pipe ? `${p.weight_per_pipe} kg/pipe` : `${p.kg_per_meter} kg`})</option>)}
                </select>
              </div>
              <div>
                <label className="label text-[10px] mb-0.5 text-gray-500">Weight / pipe (kg)</label>
                <input className="input w-36" type="number" step="0.01" min="0" placeholder="e.g. 59.4"
                  value={form.weight_per_pipe ?? ''}
                  onChange={e => setForm(f => {
                    const v = e.target.value;
                    const wpp = v === '' ? '' : +v;
                    return { ...f, weight_per_pipe: wpp, weight_per_meter: wpp };
                  })} />
              </div>
              {(form.weight_per_pipe || form.weight_per_meter) ? (
                <button type="button" onClick={() => setForm(f => ({ ...f, weight_per_pipe: '', pipe_length_m: '', weight_per_meter: '' }))} className="btn btn-secondary text-xs px-2 mb-0.5">Clear</button>
              ) : null}
            </div>
            {form.weight_per_pipe ? (
              <p className="text-[11px] text-blue-700 mt-1.5">→ Vendor PO kg = indent qty × <b>{form.weight_per_pipe}</b>. e.g. 5 MTR → <b>{Math.round(5 * (+form.weight_per_pipe || 0) * 100) / 100} kg</b>.</p>
            ) : (
              <p className="text-[11px] text-gray-500 mt-1">Enter the weight per pipe (kg). On the vendor PO it's multiplied by the indent qty. Leave blank for non-pipe items.</p>
            )}
          </div>

          {/* MD Phase 1 — pricing provenance block */}
          <div className="border border-red-200 bg-red-50/40 rounded-lg p-3 space-y-3">
            <div className="text-xs font-bold uppercase text-red-700">Pricing — full traceability for tenders</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {/* Rate can be CLEARED to blank (mam 2026-06-15: "rate 0 is not
                  delete") — empty string while typing, normalised to a number
                  on save. Number() also strips a leading 0 (018 → 18). */}
              <div><label className="label">Rate (₹) *</label><input className="input" type="number" min="0" step="0.01" value={form.current_price ?? ''} onChange={e => F('current_price', e.target.value === '' ? '' : Number(e.target.value))} /></div>
              <div>
                <label className="label">Vendor (link) *</label>
                <SearchableSelect
                  options={vendors.map(v => ({ id: v.id, label: v.name, ...v }))}
                  value={form.vendor_id || null}
                  valueKey="id"
                  displayKey="label"
                  placeholder="Pick from Vendors Master…"
                  onChange={v => F('vendor_id', v?.id || '')}
                />
              </div>
              <div><label className="label">Source Type *</label>
                <select className="select" value={form.source_type || 'Manual'} onChange={e => F('source_type', e.target.value)}>
                  {SOURCE_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div><label className="label">Bill / PO Number *</label><input className="input" value={form.bill_po_number || ''} onChange={e => F('bill_po_number', e.target.value)} placeholder="e.g. SEPL/PO/2026/042" /></div>
              <div><label className="label">Bill / PO Date *</label><input className="input" type="date" value={form.bill_po_date || ''} onChange={e => F('bill_po_date', e.target.value)} /></div>
              {modal === 'edit' && (
                <div className="text-[11px] text-gray-500 italic flex flex-col justify-end pb-1">
                  {form.priced_at && <div>Last captured: {fmtDateTime(form.priced_at)}</div>}
                  {form.priced_by_name && <div>By: {form.priced_by_name}</div>}
                </div>
              )}
            </div>
            <p className="text-[11px] text-red-700">Changing Rate / Vendor / Source / Bill — saves the old price to history automatically (never deleted).</p>
          </div>

          <div className="bg-gray-50 p-2 rounded text-sm"><strong>Display in PO:</strong> {[form.item_name, form.specification, form.size].filter(Boolean).join(' / ') || '(enter item details)'}</div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(null)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">{modal === 'edit' ? 'Update' : 'Create'}</button></div>
        </form>
      </Modal>

      {/* Price History Modal */}
      <Modal isOpen={!!historyModal} onClose={() => setHistoryModal(null)} title={historyModal ? `Price History — ${historyModal.item.item_code}` : 'Price History'} wide>
        {historyModal && (
          <div className="space-y-3">
            <div className="bg-gray-50 border border-gray-200 rounded p-2.5 text-xs grid grid-cols-2 gap-1">
              <div><b>Item:</b> {historyModal.item.item_name}</div>
              <div><b>Spec / Size:</b> {[historyModal.item.specification, historyModal.item.size].filter(Boolean).join(' / ') || '—'}</div>
              <div><b>Current rate:</b> Rs {(+historyModal.item.current_price || 0).toLocaleString('en-IN')}</div>
              <div><b>Current vendor:</b> {historyModal.item.vendor_name || '—'}</div>
            </div>
            {historyModal.rows.length === 0 ? (
              <p className="text-sm text-gray-400 italic text-center py-4">No history entries yet. Old prices land here automatically when Rate / Vendor / Source / Bill is changed.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50"><tr><th className="px-2 py-1 text-left">Captured</th><th className="px-2 py-1 text-right">Rate</th><th className="px-2 py-1 text-left">Vendor</th><th className="px-2 py-1 text-left">Source</th><th className="px-2 py-1 text-left">Bill / PO</th><th className="px-2 py-1 text-left">By</th></tr></thead>
                  <tbody>
                    {historyModal.rows.map(h => (
                      <tr key={h.id} className="border-b">
                        <td className="px-2 py-1 whitespace-nowrap">{fmtDateTime(h.created_at)}</td>
                        <td className="px-2 py-1 text-right font-semibold">Rs {(+h.rate || 0).toLocaleString('en-IN')}</td>
                        <td className="px-2 py-1">{h.vendor_name || '—'}</td>
                        <td className="px-2 py-1">{h.source_type || h.source || '—'}</td>
                        <td className="px-2 py-1 font-mono text-[10px]">{h.bill_po_number || '—'}{h.bill_po_date ? ` · ${h.bill_po_date}` : ''}</td>
                        <td className="px-2 py-1 text-gray-500">{h.created_by_name || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex justify-end"><button onClick={() => setHistoryModal(null)} className="btn btn-secondary">Close</button></div>
          </div>
        )}
      </Modal>

      {/* Bulk Import Modal */}
      <Modal isOpen={bulkModal} onClose={() => setBulkModal(false)} title="Bulk Import Items" wide>
        <div className="space-y-4">
          <div className="bg-red-50 p-3 rounded-lg text-sm text-red-700">
            <p className="font-semibold mb-1">CSV columns (in order):</p>
            <p className="font-mono text-[11px]">Item Code, Department, Item Name, Specification, Size, UOM, GST, Type, Make, Rate, Vendor Name, Source Type, Bill/PO Number, Bill/PO Date</p>
            <p className="text-[11px] mt-1">Vendor Name is matched against the Vendors Master (case-insensitive). Source Type: PO / Quote / Manual / Online / Bill.</p>
          </div>
          <button onClick={downloadTemplate} className="btn btn-secondary text-sm flex items-center gap-2"><FiDownload size={14} /> Download Template</button>
          <div><label className="label">Upload CSV</label><input type="file" accept=".csv" onChange={handleFile} className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100" /></div>
          <div><label className="label">Or Paste CSV</label><textarea className="input font-mono text-xs" rows="5" value={bulkData} onChange={e => { setBulkData(e.target.value); setBulkPreview(parseCSV(e.target.value)); }} placeholder="Item Code,Dept,Name,Spec,Size,UOM,GST,Type,Make,Rate,Vendor Name,Source,Bill/PO #,Bill/PO Date" /></div>
          {bulkPreview.length > 0 && (
            <div><p className="text-sm font-semibold mb-2">{bulkPreview.length} items to import</p>
              <div className="max-h-48 overflow-y-auto border rounded text-xs"><table><thead><tr className="bg-gray-50"><th className="px-2 py-1">Code</th><th className="px-2 py-1">Dept</th><th className="px-2 py-1">Name</th><th className="px-2 py-1">Rate</th><th className="px-2 py-1">Vendor</th><th className="px-2 py-1">Source</th><th className="px-2 py-1">Bill/PO</th></tr></thead>
                <tbody>{bulkPreview.map((i, idx) => <tr key={idx}><td className="px-2 py-1">{i.item_code}</td><td className="px-2 py-1">{i.department}</td><td className="px-2 py-1 font-medium">{i.item_name}</td><td className="px-2 py-1">{i.current_price}</td><td className="px-2 py-1">{i.vendor_name}</td><td className="px-2 py-1">{i.source_type}</td><td className="px-2 py-1">{i.bill_po_number}</td></tr>)}</tbody></table></div>
            </div>
          )}
          <div className="flex justify-end gap-3"><button onClick={() => setBulkModal(false)} className="btn btn-secondary">Cancel</button><button onClick={bulkImport} disabled={bulkPreview.length === 0} className="btn btn-primary disabled:opacity-50 flex items-center gap-1"><FiUpload size={14} /> Import {bulkPreview.length} Items</button></div>
        </div>
      </Modal>

      {/* Pipe Weight master (MTR → KG) */}
      <PipeWeightsModal isOpen={pipeModal} onClose={() => { setPipeModal(false); loadPipeWeights(); }} />

      {/* Photo lightbox — click a thumbnail (table or form) to view full-size. */}
      {lightbox && (
        <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4 cursor-zoom-out" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="item" className="max-w-full max-h-full rounded shadow-2xl" onClick={e => e.stopPropagation()} />
          <button onClick={() => setLightbox(null)} className="absolute top-4 right-4 text-white/90 hover:text-white" aria-label="Close"><FiX size={28} /></button>
        </div>
      )}
    </div>
  );
}
