import { useState, useEffect, useRef, useMemo, Fragment } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { FiPlus, FiTrash2, FiUpload, FiEdit2, FiExternalLink, FiEye, FiDownload, FiChevronDown, FiChevronRight, FiMapPin, FiGrid } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import SearchableSelect from '../components/SearchableSelect';
import MultiUserSelect from '../components/MultiUserSelect';
import { useAuth } from '../context/AuthContext';

const CRM_OPTIONS = ['Sushila', 'Lovely'];

// Auto-growing textarea (mam 2026-06-24): the BOQ Description must WRAP and
// show the whole text — no fixed-height box that scrolls "top to down". It
// sizes itself to its content on mount and on every edit, so long lines like
// "STRING INVERTER (MPPT GRID CONNECTED STRING INVERTER 100 KW)" are fully
// visible without an inner scrollbar.
function GrowTextarea({ value, onChange, className, title, placeholder }) {
  const ref = useRef(null);
  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(() => { resize(); }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      className={className}
      style={{ overflow: 'hidden', resize: 'none' }}
      title={title}
      placeholder={placeholder}
      value={value}
      onChange={(e) => { onChange(e); resize(); }}
    />
  );
}

// Match a PO against a free-text filter. Empty filter = all rows. Checks
// every field mam asked about: site/project (project field), client name,
// company name (BB), PO number, lead number, site-engineer names, CRM.
function poMatches(p, q) {
  if (!q || !q.trim()) return true;
  const needle = q.trim().toLowerCase();
  const hay = [
    p.po_number, p.lead_no, p.bb_client, p.company_name, p.bb_project,
    p.site_engineer_names, p.site_engineer_name, p.crm_name, p.bb_category,
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(needle);
}

export default function Orders() {
  const { canDelete } = useAuth();
  const [tab, setTab] = useUrlTab('po');
  const [pos, setPos] = useState([]);
  const [planning, setPlanning] = useState([]);
  const [bbEntries, setBbEntries] = useState([]);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({});
  const [poItems, setPoItems] = useState([{ item_master_id: '', description: '', quantity: 0, unit: 'nos', rate: 0, amount: 0, hsn_code: '', part_price: 0, labour_rate: 0 }]);
  // Mam: "i upload jeewan mala order yesterday till ok but i check half
  // data delete". The bug: PO Edit ALWAYS re-saved po_items on Update,
  // even when she only changed CRM or status — and the server's save
  // path is destructive (DELETE-then-INSERT). With this flag we only
  // touch po_items when she actually changed an item row or uploaded a
  // new BOQ. Reset to false whenever the Edit modal opens with fresh
  // data, flipped to true on the first user edit.
  const [poItemsDirty, setPoItemsDirty] = useState(false);
  // Mam: "give here filter by site name/project name" — single search box
  // matches against PO number, lead#, client/company, project, site engineer,
  // CRM. Lower-case substring match on whatever's typed.
  const [poFilter, setPoFilter] = useState('');
  // Group the PO list by PROJECT — same collapsible layout as Business Book
  // (mam 2026-06-25: "same business book merge with here project wise").
  const [groupPo, setGroupPo] = useState(true);
  const [poExpanded, setPoExpanded] = useState({});
  const [masterItems, setMasterItems] = useState([]);
  const [siteEngineers, setSiteEngineers] = useState([]);
  // All active users — source for the extra project-role pickers (jr site
  // eng / supervisor / welder / helper), which aren't tied to a single role.
  const [allUsers, setAllUsers] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [editingPO, setEditingPO] = useState(null);
  // Sticky error banner inside the PO modal — so the exact server error is
  // visible on-screen (mam can screenshot it) instead of disappearing in a
  // 4-second toast. Cleared whenever the modal opens or save retries.
  const [poError, setPoError] = useState(null);

  const load = () => {
    api.get('/orders/po').then(r => setPos(r.data));
    api.get('/orders/planning').then(r => setPlanning(r.data));
  };

  useEffect(() => {
    load();
    api.get('/orders/business-book-entries').then(r => setBbEntries(r.data));
    api.get('/item-master/dropdown?type=PO').then(r => setMasterItems(r.data)).catch(() => {});
    api.get('/auth/users').then(r => {
      const active = (r.data || []).filter(u => u.active !== 0);
      setSiteEngineers(active.filter(u => (u.role_names || '').split(',').includes('Site Engineer')));
      setAllUsers(active);
    }).catch(() => {});
  }, []);

  const addItem = () => { setPoItems([...poItems, { item_master_id: '', description: '', quantity: 0, unit: 'nos', rate: 0, amount: 0, hsn_code: '', part_price: 0, labour_rate: 0 }]); setPoItemsDirty(true); };
  const removeItem = (i) => { setPoItems(poItems.filter((_, idx) => idx !== i)); setPoItemsDirty(true); };
  // Download the blank BOQ template so users fill data in the exact format the
  // upload parser expects (mam 2026-06-19).
  const downloadBoqTemplate = async () => {
    try {
      const r = await api.get('/orders/po-boq-template', { responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a'); a.href = url; a.download = 'BOQ-template.xlsx'; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast.error('Could not download template'); }
  };
  const updateItem = (i, key, val) => {
    const items = [...poItems];
    items[i][key] = val;
    if (key === 'quantity' || key === 'rate') items[i].amount = (items[i].quantity || 0) * (items[i].rate || 0);
    setPoItems(items);
    setPoItemsDirty(true);
  };

  const handleBBSelect = (bbId) => {
    const bb = bbEntries.find(b => b.id === +bbId);
    if (bb) {
      setForm({ ...form, business_book_id: bb.id, po_number: '', total_amount: bb.po_amount || bb.sale_amount_without_gst || 0 });
    } else {
      setForm({ ...form, business_book_id: '' });
    }
  };

  const handleEditPO = (po) => {
    setEditingPO(po);
    // Prefer multi-id list from backend; fall back to legacy single id
    const engIds = Array.isArray(po.site_engineer_ids_list) && po.site_engineer_ids_list.length > 0
      ? po.site_engineer_ids_list
      : (po.site_engineer_id ? [po.site_engineer_id] : []);
    setForm({
      business_book_id: po.business_book_id || '',
      po_number: po.po_number, po_date: po.po_date, total_amount: po.total_amount || 0,
      advance_amount: po.advance_amount || 0, po_copy_link: po.po_copy_link || '',
      boq_file_link: po.boq_file_link || '',
      pt_advance: po.pt_advance || '', pt_delivery: po.pt_delivery || '',
      pt_installation: po.pt_installation || '', pt_commissioning: po.pt_commissioning || '',
      pt_retention: po.pt_retention || '', status: po.status || 'received',
      site_engineer_ids: engIds, crm_name: po.crm_name || '',
      jr_site_engineer_ids: po.jr_site_engineer_ids_list || [],
      supervisor_ids: po.supervisor_ids_list || [],
      welder_ids: po.welder_ids_list || [],
      helper_ids: po.helper_ids_list || [],
    });
    // Load existing PO items + reset dirty flag — fresh modal open is
    // a clean slate. We'll only re-save items when mam actually edits
    // one (or uploads a new BOQ).
    setPoItemsDirty(false);
    api.get(`/orders/po/${po.id}/items`).then(r => {
      setPoItems(r.data.length > 0 ? r.data.map(i => ({ ...i, item_master_id: i.item_master_id || '' })) : [{ item_master_id: '', description: '', quantity: 0, unit: 'nos', rate: 0, amount: 0, hsn_code: '', part_price: 0, labour_rate: 0 }]);
    }).catch(() => setPoItems([{ item_master_id: '', description: '', quantity: 0, unit: 'nos', rate: 0, amount: 0, hsn_code: '', part_price: 0, labour_rate: 0 }]));
    setModal('po');
  };

  const savePo = async (e) => {
    e.preventDefault();
    setPoError(null);
    const engIds = form.site_engineer_ids || [];
    if (!engIds.length) { setPoError('At least one Site Engineer is required'); toast.error('At least one Site Engineer is required'); return; }
    if (!form.crm_name) { setPoError('CRM is required'); toast.error('CRM is required'); return; }
    let stage = 'start';
    try {
      if (editingPO) {
        stage = 'PUT /orders/po/:id (metadata)';
        await api.put(`/orders/po/${editingPO.id}`, { ...form });
        // Only re-save the line items when mam actually edited them.
        // Skipping this when only CRM / status / dates changed avoids
        // the destructive DELETE-then-INSERT path entirely and protects
        // BOQ data from silent loss on routine PO edits.
        if (poItemsDirty) {
          stage = 'POST /orders/po/:id/items (line items)';
          const itemsPayload = poItems.filter(item => item.description && item.description.trim());
          await api.post(`/orders/po/${editingPO.id}/items`, { items: itemsPayload });
        }
        toast.success(poItemsDirty ? 'PO + line items updated' : 'PO updated (line items unchanged)');
      } else {
        stage = 'POST /orders/po (create)';
        await api.post('/orders/po', { ...form, items: poItems.filter(item => item.description && item.description.trim()) });
        toast.success('PO created');
      }
      setModal(false); setEditingPO(null);
      setPoItems([{ item_master_id: '', description: '', quantity: 0, unit: 'nos', rate: 0, amount: 0, hsn_code: '', part_price: 0, labour_rate: 0 }]);
      load();
    } catch (err) {
      // Show the real server response right in the modal so mam can read /
      // screenshot exactly what failed. Also dump full context so we can
      // trace which of the 2 requests (metadata vs items) crashed.
      const status = err.response?.status;
      const serverErr = err.response?.data?.error;
      const failures = err.response?.data?.failures;
      const parts = [];
      parts.push(`Stage: ${stage}`);
      if (status) parts.push(`HTTP ${status}`);
      if (serverErr) parts.push(`Server: ${serverErr}`);
      if (failures && failures.length) parts.push(`Row failures:\n• ${failures.join('\n• ')}`);
      if (!serverErr && !failures) parts.push(`Raw: ${err.message}`);
      const fullMsg = parts.join('\n');
      setPoError(fullMsg);
      toast.error(serverErr || err.message || 'Failed', { duration: 6000 });
      console.error('[savePo] failed at', stage, err);
    }
  };

  const savePlanning = async (e) => {
    e.preventDefault();
    await api.post('/orders/planning', form);
    toast.success('Planning created');
    setModal(false); load();
  };


  const itemsTotal = poItems.reduce((s, i) => s + (i.amount || 0), 0);

  const tabs = [
    { id: 'po', label: 'Purchase Orders' },
    { id: 'planning', label: 'Order Planning' },
  ];

  // ── PO list grouped by PROJECT (collapsible) — same layout as the
  // Business Book list (mam 2026-06-25). Project falls back to client /
  // company when blank; POs with neither stay on their own row. ──
  const cleanTxt = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const poProjectOf = (p) => cleanTxt(p.bb_project) || cleanTxt(p.bb_client || p.company_name) || '';
  const poGroups = useMemo(() => {
    const map = new Map();
    for (const p of pos.filter(x => poMatches(x, poFilter))) {
      const proj = poProjectOf(p);
      const key = proj ? proj.toLowerCase() : `__none__:${p.id}`;
      if (!map.has(key)) map.set(key, { key, label: proj || '(no project)', pos: [], amount: 0, clients: new Set(), statuses: new Set() });
      const g = map.get(key);
      g.pos.push(p);
      g.amount += (+p.total_amount || 0);
      if (p.bb_client || p.company_name) g.clients.add(cleanTxt(p.bb_client || p.company_name));
      if (p.status) g.statuses.add(p.status);
    }
    return [...map.values()];
  }, [pos, poFilter]);
  const poMergedCount = poGroups.filter(g => g.pos.length > 1).length;
  const togglePoGroup = (key) => setPoExpanded(prev => ({ ...prev, [key]: !prev[key] }));
  const poClientList = (set) => { const a = [...set]; if (!a.length) return '-'; return a.length <= 2 ? a.join(', ') : `${a.slice(0, 2).join(', ')} +${a.length - 2} more`; };

  // One PO row — reused by the flat list and the grouped children so the
  // columns never drift between the two modes.
  const renderPoRow = (p, child = false) => (
    <tr key={p.id} className={child ? 'bg-gray-50/60' : ''}>
      <td className={`font-medium ${child ? 'pl-8' : ''}`}>{p.po_number}</td>
      <td className="text-red-600 font-bold">{p.lead_no || '-'}</td>
      <td>{p.bb_client || p.company_name || '-'}</td>
      <td>{p.bb_project || '-'}</td>
      <td>{p.bb_category || '-'}</td>
      <td>{p.po_date}</td>
      <td className="font-semibold">Rs {p.total_amount?.toLocaleString()}</td>
      <td className="text-xs">{p.site_engineer_names || p.site_engineer_name || <span className="text-gray-400">-</span>}</td>
      <td className="text-xs">{p.crm_name || <span className="text-gray-400">-</span>}</td>
      <td>{p.po_copy_link ? <a href={p.po_copy_link} target="_blank" rel="noreferrer" className="text-red-600 hover:underline flex items-center gap-1 text-xs"><FiExternalLink size={12} /> View</a> : <span className="text-gray-400 text-xs">-</span>}</td>
      <td>{p.boq_file_link ? <a href={p.boq_file_link} target="_blank" rel="noreferrer" className="text-red-600 hover:underline flex items-center gap-1 text-xs"><FiExternalLink size={12} /> View</a> : <span className="text-gray-400 text-xs">-</span>}</td>
      <td><StatusBadge status={p.status} /></td>
      <td>
        <div className="flex gap-1">
          <button onClick={() => handleEditPO(p)} className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded" title="Edit"><FiEdit2 size={15} /></button>
          {canDelete('orders') && <button onClick={async () => {
            if (!confirm(`Delete PO "${p.po_number}"?`)) return;
            try { await api.delete(`/orders/po/${p.id}`); toast.success('Deleted'); load(); }
            catch (err) {
              const data = err.response?.data || {};
              if (err.response?.status === 409 && data.canForce) toast.error(`${data.error} — use Edit to fix the PO instead of deleting.`, { duration: 6000 });
              else toast.error(data.error || 'Delete failed');
            }
          }} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="Delete"><FiTrash2 size={15} /></button>}
        </div>
      </td>
    </tr>
  );

  return (
    <div className="space-y-4">
      <div className="sticky-toolbar">
        <div className="flex gap-2">{tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`btn ${tab === t.id ? 'btn-primary' : 'btn-secondary'}`}>{t.label}</button>
        ))}</div>
      </div>

      {tab === 'po' && (
        <>
          <div className="flex flex-wrap justify-between items-center gap-3">
            <h3 className="font-semibold">Client Purchase Orders</h3>
            <div className="flex gap-2 items-center flex-1 max-w-md">
              <input
                className="input text-sm"
                placeholder="Filter by site / project / client / PO# / lead# / engineer"
                value={poFilter}
                onChange={e => setPoFilter(e.target.value)}
              />
              {poFilter && (
                <button onClick={() => setPoFilter('')} className="text-xs text-gray-500 hover:text-red-600 px-2" title="Clear">×</button>
              )}
            </div>
            <button onClick={() => setGroupPo(v => !v)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition-all ${groupPo ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-white text-gray-500 border-gray-200 hover:border-amber-300'}`}
              title="Merge POs that share the same project">
              <FiGrid size={14} /> {groupPo ? 'Grouped by Project' : 'Group by Project'}
            </button>
            <button onClick={() => exportCsv('purchase-orders',
              ['PO Number','Lead No','Client','Project','Category','Date','Amount','Advance','Status','Site Engineer','CRM'],
              pos.map(p => [p.po_number, p.lead_no, p.client_name, p.project_name, p.category, p.po_date, p.total_amount, p.advance_amount, p.status, p.site_engineer_name, p.crm_name]))}
              className="btn btn-secondary flex items-center gap-2"><FiDownload /> Export Excel</button>
            <button onClick={() => {
              setEditingPO(null);
              setForm({ business_book_id: '', po_number: '', po_date: '', total_amount: 0, advance_amount: 0, po_copy_link: '', boq_file_link: '', pt_advance: '', pt_delivery: '', pt_installation: '', pt_commissioning: '', pt_retention: '', site_engineer_ids: [], crm_name: '', jr_site_engineer_ids: [], supervisor_ids: [], welder_ids: [], helper_ids: [] });
              setPoItems([{ item_master_id: '', description: '', quantity: 0, unit: 'nos', rate: 0, amount: 0, hsn_code: '', part_price: 0, labour_rate: 0 }]);
              setModal('po');
            }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add PO</button>
          </div>
          {poFilter && (() => {
            const matched = pos.filter(p => poMatches(p, poFilter));
            const totalAmount = matched.reduce((s, p) => s + (+p.total_amount || 0), 0);
            return (
              <div className="text-xs text-gray-500 flex flex-wrap gap-x-3 gap-y-1 items-center">
                <span>Showing <b>{matched.length}</b> of {pos.length} POs matching "{poFilter}"</span>
                <span className="text-gray-700">
                  PO Total: <b className="text-red-700">Rs {totalAmount.toLocaleString('en-IN')}</b>
                </span>
              </div>
            );
          })()}
          {groupPo && (
            <div className="text-xs text-gray-500">
              {poGroups.length} project{poGroups.length !== 1 ? 's' : ''} ({pos.filter(p => poMatches(p, poFilter)).length} PO{pos.filter(p => poMatches(p, poFilter)).length !== 1 ? 's' : ''}{poMergedCount > 0 ? `, ${poMergedCount} merged` : ''}) · tap a project to expand
            </div>
          )}
          <div className="card p-0"><table className="freeze-head">
            <thead><tr><th>PO Number</th><th>Lead No</th><th>Client</th><th>Project</th><th>Category</th><th>Date</th><th>Amount</th><th>Site Engineer</th><th>CRM</th><th>PO Copy</th><th>BOQ File</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {/* Flat list, or merged-by-project when grouping is on. */}
              {!groupPo && pos.filter(p => poMatches(p, poFilter)).map(p => renderPoRow(p))}
              {groupPo && poGroups.map(g => {
                const open = !!poExpanded[g.key];
                return (
                  <Fragment key={g.key}>
                    {/* Collapsed project row — project name + PO count + total amount. */}
                    <tr className="bg-blue-50/60 hover:bg-blue-100/60 cursor-pointer border-l-4 border-blue-600" onClick={() => togglePoGroup(g.key)}>
                      <td className="font-medium">
                        <div className="flex items-center gap-1.5 text-blue-700">
                          {open ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
                          <span className="bg-blue-600 text-white text-[11px] font-bold px-2 py-0.5 rounded-full">{g.pos.length} PO{g.pos.length > 1 ? 's' : ''}</span>
                        </div>
                      </td>
                      <td></td>
                      <td className="text-xs">{poClientList(g.clients)}</td>
                      <td className="font-semibold">
                        <span className="flex items-center gap-1"><FiMapPin size={12} className="text-blue-600" /> {g.label}</span>
                        <div className="text-[10px] text-blue-700/80">tap to {open ? 'collapse' : 'expand'}</div>
                      </td>
                      <td></td>
                      <td></td>
                      <td className="font-bold">Rs {g.amount.toLocaleString('en-IN')}<div className="text-[9px] text-gray-400 font-normal uppercase">total</div></td>
                      <td colSpan={6}></td>
                    </tr>
                    {open && g.pos.map(p => renderPoRow(p, true))}
                  </Fragment>
                );
              })}
              {pos.length === 0 && <tr><td colSpan="13" className="text-center py-8 text-gray-400">No orders yet</td></tr>}
            </tbody>
          </table></div>
        </>
      )}

      {tab === 'planning' && (
        <>
          <div className="flex justify-between items-center">
            <h3 className="font-semibold">Order Planning</h3>
            <button onClick={() => { setForm({ po_id: '', business_book_id: '', planned_start: '', planned_end: '', notes: '' }); setModal('planning'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Create Plan</button>
          </div>
          <div className="card p-0"><table className="freeze-head">
            <thead><tr><th>PO</th><th>Client</th><th>Start</th><th>End</th><th>Status</th></tr></thead>
            <tbody>
              {planning.map(p => (
                <tr key={p.id}><td>{p.po_number}</td><td>{p.client_name}</td><td>{p.planned_start}</td><td>{p.planned_end}</td><td><StatusBadge status={p.status} /></td></tr>
              ))}
              {planning.length === 0 && <tr><td colSpan="5" className="text-center py-8 text-gray-400">No plans yet</td></tr>}
            </tbody>
          </table></div>
        </>
      )}

      {/* Add PO Modal */}
      <Modal isOpen={modal === 'po'} onClose={() => { setModal(false); setEditingPO(null); setPoError(null); }} title={editingPO ? `Edit PO - ${editingPO.po_number}` : 'Upload Client Purchase Order'} wide>
        <form onSubmit={savePo} className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">

          {/* Sticky error banner — shows the exact server error when Update
              fails, with which stage (metadata vs items) it broke at. Helps
              mam screenshot + share the error instead of hunting in DevTools. */}
          {poError && (
            <div className="bg-red-50 border-2 border-red-300 rounded-lg p-3 text-xs text-red-800 whitespace-pre-wrap">
              <div className="flex justify-between items-start gap-2 mb-1">
                <b>Save failed — details:</b>
                <button type="button" onClick={() => setPoError(null)} className="text-red-500 hover:text-red-700 font-bold">×</button>
              </div>
              {poError}
            </div>
          )}

          {/* 1. Business Book Entry */}
          <div className="border rounded-lg p-3 bg-gray-50">
            <h4 className="font-semibold text-sm text-gray-700 mb-3">Select Business Book Entry</h4>
            <SearchableSelect
              options={bbEntries.map(bb => ({ ...bb, label: `${bb.lead_no} | ${bb.client_name} | ${bb.project_name || bb.company_name} | ${bb.category || '-'} | Rs ${(bb.sale_amount_without_gst || 0).toLocaleString()}` }))}
              value={form.business_book_id || null}
              valueKey="id"
              displayKey="label"
              placeholder="Type company name to search..."
              onChange={(bb) => { if (bb) handleBBSelect(bb.id); else setForm(f => ({ ...f, business_book_id: '' })); }}
            />
            {form.business_book_id && (() => {
              const bb = bbEntries.find(b => b.id === +form.business_book_id);
              return bb ? (
                <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                  <div><span className="text-gray-400">Client:</span> <span className="font-medium">{bb.client_name}</span></div>
                  <div><span className="text-gray-400">Company:</span> <span className="font-medium">{bb.company_name}</span></div>
                  <div><span className="text-gray-400">Project:</span> <span className="font-medium">{bb.project_name}</span></div>
                  <div><span className="text-gray-400">Category:</span> <span className="font-medium">{bb.category}</span></div>
                </div>
              ) : null;
            })()}
          </div>

          {/* 2. PO Details + Upload PO Copy */}
          <div className="border rounded-lg p-3 bg-red-50">
            <h4 className="font-semibold text-sm text-red-700 mb-3">Purchase Order Details</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div><label className="label">PO Number *</label><input className="input" value={form.po_number || ''} onChange={e => setForm({ ...form, po_number: e.target.value })} required /></div>
              <div><label className="label">PO Date *</label><input className="input" type="date" value={form.po_date || ''} onChange={e => setForm({ ...form, po_date: e.target.value })} required /></div>
              <div><label className="label">Total Amount (Rs)</label><input className="input" type="number" value={form.total_amount || 0} onChange={e => setForm({ ...form, total_amount: +e.target.value })} /></div>
              <div className="col-span-2">
                <label className="label">Site Engineer(s) * <span className="text-gray-400 font-normal">(select one or more)</span></label>
                <div className="border rounded-lg p-2 bg-white flex flex-wrap gap-1.5 min-h-[42px]">
                  {siteEngineers.map(u => {
                    const selected = (form.site_engineer_ids || []).includes(u.id);
                    return (
                      <button key={u.id} type="button"
                        onClick={() => {
                          const cur = form.site_engineer_ids || [];
                          const next = selected ? cur.filter(id => id !== u.id) : [...cur, u.id];
                          setForm({ ...form, site_engineer_ids: next });
                        }}
                        className={`px-2 py-1 rounded-full text-xs font-medium border transition ${selected ? 'bg-red-600 text-white border-red-600' : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'}`}>
                        {selected && <span className="mr-1">✓</span>}{u.name}
                      </button>
                    );
                  })}
                  {siteEngineers.length === 0 && <p className="text-[10px] text-amber-600">No users with role "Site Engineer" yet</p>}
                </div>
                {(form.site_engineer_ids || []).length > 0 && (
                  <p className="text-[10px] text-red-600 mt-0.5">{(form.site_engineer_ids || []).length} selected</p>
                )}
              </div>
              {/* Extra project roles (mam 2026-06-17): jr site eng / supervisor /
                  welder / helper — compact multi-select dropdowns (one row each)
                  instead of repeating the whole user list as chips. All optional. */}
              {[
                { key: 'jr_site_engineer_ids', label: 'Jr. Site Engineer(s)' },
                { key: 'supervisor_ids', label: 'Supervisor(s)' },
                { key: 'welder_ids', label: 'Welder(s)' },
                { key: 'helper_ids', label: 'Helper(s)' },
              ].map(role => (
                <div className="col-span-2" key={role.key}>
                  <label className="label">{role.label} <span className="text-gray-400 font-normal">(optional)</span></label>
                  <MultiUserSelect
                    options={allUsers.map(u => ({ id: u.id, name: u.name }))}
                    value={form[role.key] || []}
                    onChange={(ids) => setForm({ ...form, [role.key]: ids })}
                    placeholder="Select one or more…"
                  />
                </div>
              ))}
              <div>
                <label className="label">CRM *</label>
                <select className="select" required value={form.crm_name || ''} onChange={e => setForm({ ...form, crm_name: e.target.value })}>
                  <option value="">Select CRM</option>
                  {CRM_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              {editingPO && <div><label className="label">Status</label><select className="select" value={form.status || 'received'} onChange={e => setForm({ ...form, status: e.target.value })}><option value="received">Received</option><option value="booked">Booked</option><option value="planning">Planning</option><option value="in_progress">In Progress</option><option value="completed">Completed</option></select></div>}
              <div>
                <label className="label flex items-center gap-2"><FiUpload size={14} /> Upload PO Copy</label>
                {form.po_copy_link ? (
                  <div className="flex items-center gap-2">
                    <a href={form.po_copy_link} target="_blank" rel="noreferrer" className="text-sm text-red-600 underline truncate flex-1">{form.po_copy_link.split('/').pop()}</a>
                    <button type="button" onClick={() => setForm({ ...form, po_copy_link: '' })} className="text-red-500 text-xs">Remove</button>
                  </div>
                ) : (
                  <input type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png" disabled={uploading}
                    onChange={async (e) => {
                      const file = e.target.files[0]; if (!file) return;
                      setUploading(true);
                      try {
                        const fd = new FormData(); fd.append('file', file);
                        const res = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
                        setForm(f => ({ ...f, po_copy_link: res.data.url }));
                        toast.success(`Uploaded: ${res.data.filename}`);
                      } catch { toast.error('Upload failed'); }
                      setUploading(false); e.target.value = '';
                    }}
                    className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100" />
                )}
                {uploading && <p className="text-xs text-red-500 mt-1">Uploading...</p>}
              </div>
            </div>
          </div>

          {/* 3. Upload BOQ → Auto-fetch items (Excel) or just attach (PDF/image) */}
          <div className="border-2 border-dashed border-red-400 rounded-lg p-4 bg-red-50 text-center">
            <h4 className="font-bold text-red-800 mb-2">Upload BOQ File</h4>
            <p className="text-xs text-red-600 mb-2">Upload Excel (.xlsx/.xls) to auto-fill items below. PDF/Image/Word also accepted — will just attach the file.</p>
            <div className="mb-3">
              <button type="button" onClick={downloadBoqTemplate} className="text-xs text-blue-700 underline hover:text-blue-900 inline-flex items-center gap-1">
                <FiDownload size={12} /> Download blank BOQ format
              </button>
              <span className="text-[10px] text-gray-500 ml-1">— fill your data in this template so it imports correctly</span>
            </div>
            <label className={`btn btn-primary inline-flex items-center gap-2 cursor-pointer text-base px-6 py-3 ${uploading ? 'opacity-60 pointer-events-none' : ''}`}>
              <FiUpload size={18} /> {uploading ? 'Uploading...' : 'Upload BOQ & Fetch Items'}
              <input type="file" accept=".xlsx,.xls,.pdf,.doc,.docx,.jpg,.jpeg,.png" className="hidden" disabled={uploading} onChange={async (e) => {
                const file = e.target.files[0]; if (!file) return;
                const isExcel = /\.(xlsx|xls)$/i.test(file.name);
                const fd = new FormData(); fd.append('file', file);
                setUploading(true);
                try {
                  if (isExcel) {
                    const res = await api.post('/orders/po-upload-excel', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
                    if (res.data.items?.length > 0) {
                      setPoItems(res.data.items.map(i => ({ ...i, item_master_id: '' })));
                      setPoItemsDirty(true);  // BOQ upload definitely changes items
                      const total = res.data.items.reduce((s, i) => s + (i.amount || 0), 0);
                      setForm(f => ({ ...f, total_amount: Math.round(total), boq_file_link: res.data.file_url || f.boq_file_link }));
                      toast.success(`Fetched ${res.data.count} items from BOQ`);
                    } else {
                      if (res.data.file_url) setForm(f => ({ ...f, boq_file_link: res.data.file_url }));
                      const hdrs = (res.data.detectedHeaders || []).filter(Boolean).join(' | ');
                      toast.error(`No items parsed. Detected headers row ${res.data.headerRow}: ${hdrs || '(none)'}. Check your Excel has Item/Qty columns.`, { duration: 10000 });
                    }
                  } else {
                    const res = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
                    setForm(f => ({ ...f, boq_file_link: res.data.url }));
                    toast.success(`BOQ attached: ${res.data.filename}`);
                  }
                } catch (err) { toast.error(err.response?.data?.error || 'Upload failed', { duration: 10000 }); }
                setUploading(false); e.target.value = '';
              }} />
            </label>
            {poItems.length > 0 && poItems[0].description && (
              <p className="text-xs text-emerald-600 font-bold mt-2">{poItems.filter(i => i.description).length} items loaded. Total Amount auto-updated.</p>
            )}
            {form.boq_file_link && (
              <div className="mt-2 flex items-center justify-center gap-2 text-xs">
                <span className="text-gray-500">BOQ file attached:</span>
                <a href={form.boq_file_link} target="_blank" rel="noreferrer" className="text-red-600 underline truncate max-w-[260px]">{form.boq_file_link.split('/').pop()}</a>
                <button type="button" onClick={() => setForm(f => ({ ...f, boq_file_link: '' }))} className="text-red-500 hover:underline">Remove</button>
              </div>
            )}
          </div>

          {/* 4. BOQ Items Table */}
          <div className="border rounded-lg p-3 bg-white">
            <div className="flex justify-between items-center mb-3">
              <h4 className="font-semibold text-sm text-gray-700">BOQ Items ({poItems.filter(i => i.description).length} items)</h4>
              <button type="button" onClick={addItem} className="btn btn-secondary text-xs flex items-center gap-1"><FiPlus size={12} /> Add Item</button>
            </div>
            <div className="space-y-2">
              {/* PO modal shows ONLY SITC fields. Labour Rate is captured
                  in the Order Planning step (mam: "first we upload all
                  labour rates in order to planning") and "not delete
                  labour rate column" — so we keep this table clean and
                  let Planning own the labour workflow. */}
              {/* Desktop header — hidden on mobile where each row is a stacked card */}
              <div className="hidden md:grid grid-cols-12 gap-2 text-xs font-semibold text-gray-500 px-1">
                <div>SN</div><div className="col-span-3">Description</div><div>Qty</div><div>Unit</div><div>Rate (SITC)</div><div title="Purchase Price">PP</div><div>Labour</div><div className="col-span-2">Amount</div><div></div>
              </div>
              {poItems.map((item, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-start mb-3 md:mb-2 p-2 md:p-0 border md:border-0 border-gray-100 rounded">
                  {/* SN — full-width small label on mobile */}
                  <div className="col-span-12 md:col-span-1 text-xs font-bold text-gray-500 md:text-center">
                    <span className="md:hidden text-[10px] uppercase text-gray-400">Row </span>{item.sr_no || i + 1}
                  </div>
                  <div className="col-span-12 md:col-span-3">
                    <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Description</div>
                    {/* BOQ description — auto-grows to show the FULL text wrapped
                        (mam 2026-06-24: "wrap text, don't scroll top-to-down").
                        Red while it's not yet mapped to an Item Master item. */}
                    <GrowTextarea
                      className={`input text-[11px] leading-tight px-2 py-1 w-full whitespace-pre-wrap break-words ${item.description && !item.item_master_id ? 'bg-red-50 text-red-800 font-medium' : ''}`}
                      title={item.description || ''}
                      value={item.description || ''}
                      onChange={e => updateItem(i, 'description', e.target.value)}
                      placeholder="BOQ description"
                    />
                    {/* Item Master dropdown beside the description — map the BOQ
                        line to an item WITHOUT replacing the client's BOQ text;
                        only fill blank unit/rate (mam 2026-06-24). Compact. */}
                    <div className="mt-0.5">
                      <SearchableSelect
                        options={masterItems.map(mi => ({ id: mi.id, label: `[${mi.item_code}] ${mi.display_name}`, ...mi }))}
                        value={item.item_master_id || null}
                        valueKey="id"
                        displayKey="label"
                        placeholder="🔗 Map item…"
                        buttonClassName="input text-left text-[11px] px-2 py-1 w-full truncate flex items-center justify-between gap-1 cursor-pointer"
                        onChange={(mi) => {
                          const items = [...poItems];
                          items[i].item_master_id = mi?.id || '';
                          if (mi) {
                            if (!items[i].unit || items[i].unit === 'nos') items[i].unit = (mi.uom || '').toLowerCase() || items[i].unit;
                            if (!(+items[i].rate > 0)) items[i].rate = mi.current_price || items[i].rate;
                            items[i].amount = (items[i].quantity || 0) * (items[i].rate || 0);
                          }
                          setPoItems(items);
                        }}
                      />
                    </div>
                  </div>
                  {/* Qty — wider on mobile so digits fit */}
                  <div className="col-span-4 md:col-span-1">
                    <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Qty</div>
                    <input className="input text-sm" type="number" value={item.quantity} onChange={e => updateItem(i, 'quantity', +e.target.value)} />
                  </div>
                  <div className="col-span-4 md:col-span-1">
                    <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Unit</div>
                    <select className="select text-sm" value={item.unit} onChange={e => updateItem(i, 'unit', e.target.value)}>
                      <option>Nos</option><option>nos</option><option>mtr</option><option>kg</option><option>sqm</option><option>rft</option><option>set</option><option>lot</option><option>pair</option><option>pc</option><option>pcs</option><option>No</option>
                    </select>
                  </div>
                  <div className="col-span-4 md:col-span-1">
                    <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Rate (SITC)</div>
                    <input className="input text-sm" type="number" value={item.rate} onChange={e => updateItem(i, 'rate', +e.target.value)} />
                  </div>
                  {/* PP = Purchase Price — manual or auto-filled from BOQ Excel (mam 2026-06-19) */}
                  <div className="col-span-6 md:col-span-1">
                    <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">PP (Purchase Price)</div>
                    <input className="input text-sm" type="number" value={item.part_price ?? 0} onChange={e => updateItem(i, 'part_price', +e.target.value)} />
                  </div>
                  {/* Labour Rate — manual */}
                  <div className="col-span-6 md:col-span-1">
                    <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Labour Rate</div>
                    <input className="input text-sm" type="number" value={item.labour_rate ?? 0} onChange={e => updateItem(i, 'labour_rate', +e.target.value)} />
                  </div>
                  <div className="col-span-10 md:col-span-2">
                    <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Amount</div>
                    <div className="text-sm font-bold text-gray-700 md:px-2 md:font-medium">Rs {(item.amount || 0).toLocaleString('en-IN')}</div>
                  </div>
                  <div className="col-span-2 md:col-span-1 flex md:block justify-end">
                    <button type="button" onClick={() => removeItem(i)} className="p-1 text-red-400 hover:text-red-600">{poItems.length > 1 && <FiTrash2 size={14} />}</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 pt-2 border-t border-red-200 flex justify-between text-sm">
              <span className="text-red-600 font-medium">{poItems.filter(i => i.description).length} items</span>
              <span className="font-bold text-red-800">Items Total: Rs {itemsTotal.toLocaleString('en-IN')}</span>
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => { setModal(false); setEditingPO(null); }} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{editingPO ? 'Update Purchase Order' : 'Create Purchase Order'}</button>
          </div>
        </form>
      </Modal>

      {/* Order Planning Modal */}
      <Modal isOpen={modal === 'planning'} onClose={() => setModal(false)} title="Create Order Plan">
        <form onSubmit={savePlanning} className="space-y-4">
          <div><label className="label">Purchase Order</label><select className="select" value={form.po_id || ''} onChange={e => setForm({ ...form, po_id: e.target.value })}><option value="">Select</option>{pos.map(p => <option key={p.id} value={p.id}>{p.po_number}</option>)}</select></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className="label">Planned Start</label><input className="input" type="date" value={form.planned_start || ''} onChange={e => setForm({ ...form, planned_start: e.target.value })} /></div>
            <div><label className="label">Planned End</label><input className="input" type="date" value={form.planned_end || ''} onChange={e => setForm({ ...form, planned_end: e.target.value })} /></div>
          </div>
          <div><label className="label">Notes</label><textarea className="input" rows="3" value={form.notes || ''} onChange={e => setForm({ ...form, notes: e.target.value })} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Create</button></div>
        </form>
      </Modal>
    </div>
  );
}
