import { useState, useEffect, useRef, Fragment } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiTrash2, FiCheckCircle, FiTag, FiEdit2, FiDownload, FiUpload } from 'react-icons/fi';

// Price Required — workflow:
//   1. Site engineer raises a request for a new item not yet in Item Master.
//   2. Identical requests merge by (name + size + spec + make + uom + type).
//   3. Purchase team enters up to 3 vendor rates per merged item.
//   4. Purchase team picks the final vendor + rate.
//   5. System auto-creates an Item Master entry with that rate and links it.
export default function PriceRequired() {
  const { user, isAdmin, canApprove } = useAuth();
  const isQuoter = isAdmin() || canApprove('procurement') || canApprove('item_master');

  const [tab, setTab] = useUrlTab(isQuoter ? 'quotes' : 'raise');
  const [requests, setRequests] = useState([]);
  const [grouped, setGrouped] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [sites, setSites] = useState([]);

  const [createModal, setCreateModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ site_name: '', item_name: '', size: '', specification: '', make: '', uom: 'PCS', item_type: 'PO', department: '', notes: '' });
  // Distinct departments pulled from Item Master so the dropdown matches the
  // catalog (CIVIL / ELE / FF / GEN / etc.). Auto-fetched when the page loads.
  const [departments, setDepartments] = useState([]);

  const [finalModal, setFinalModal] = useState(null); // grouped row being finalized
  const [finalForm, setFinalForm] = useState({});

  const load = () => {
    api.get('/price-requests').then(r => setRequests(r.data || [])).catch(() => setRequests([]));
    if (isQuoter) {
      api.get('/price-requests/grouped').then(r => setGrouped(r.data || [])).catch(() => setGrouped([]));
    }
  };
  useEffect(() => {
    load();
    api.get('/procurement/vendors').then(r => setVendors((r.data || []).map(v => ({ ...v, label: v.name })))).catch(() => {});
    api.get('/collections/sites').then(r => setSites((r.data || []).map(s => ({ ...s, label: s.name })))).catch(() => {});
    // Pull every distinct department from Item Master and offer them as
    // options. New entries can also be typed (the input is a datalist combo).
    api.get('/item-master/dropdown').then(r => {
      const set = new Set();
      for (const i of (r.data || [])) if (i.department) set.add(String(i.department).trim());
      setDepartments([...set].sort());
    }).catch(() => setDepartments([]));
  }, []);

  // Bulk Excel flow — mam: "give above excel template to raise price
  // required so that can do easily in bulk". Download triggers a
  // pre-filled .xlsx; Upload picks the same template back, inserts
  // every row as an Open price_request, and shows a toast + per-row
  // errors so mam knows what went in.
  const downloadTemplate = async () => {
    try {
      const r = await api.get('/price-requests/template', { responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'SEPL_PriceRequired_Template.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { toast.error(err.response?.data?.error || 'Could not download template'); }
  };
  const bulkUploadRef = useRef(null);
  const handleBulkPick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-upload of the same name
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    const t = toast.loading('Uploading…');
    try {
      const r = await api.post('/price-requests/bulk-upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(r.data?.message || 'Imported', { id: t });
      if (Array.isArray(r.data?.skipped) && r.data.skipped.length) {
        // Don't drown mam in toasts — collapse the first 3 reasons.
        const sample = r.data.skipped.slice(0, 3).map(s => `Row ${s.row}: ${s.reason}`).join('\n');
        toast(`Skipped ${r.data.skipped.length} row${r.data.skipped.length === 1 ? '' : 's'}:\n${sample}${r.data.skipped.length > 3 ? '\n…' : ''}`, { duration: 6000 });
      }
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Upload failed', { id: t }); }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.item_name || !form.item_name.trim()) return toast.error('Item name is required');
    try {
      if (editingId) {
        await api.put(`/price-requests/${editingId}`, form);
        toast.success('Price request updated');
      } else {
        await api.post('/price-requests', form);
        toast.success('Price request raised — purchase team will quote it');
      }
      setCreateModal(false);
      setEditingId(null);
      setForm({ site_name: '', item_name: '', size: '', specification: '', make: '', uom: 'PCS', item_type: 'PO', department: '', notes: '' });
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const openEdit = (r) => {
    setEditingId(r.id);
    setForm({
      site_name: r.site_name || '',
      item_name: r.item_name || '',
      size: r.size || '',
      specification: r.specification || '',
      make: r.make || '',
      uom: r.uom || 'PCS',
      item_type: r.item_type || 'PO',
      department: r.department || '',
      notes: r.notes || '',
    });
    setCreateModal(true);
  };

  const openNew = () => {
    setEditingId(null);
    setForm({ site_name: '', item_name: '', size: '', specification: '', make: '', uom: 'PCS', item_type: 'PO', department: '', notes: '' });
    setCreateModal(true);
  };

  const updateRate = async (anchorId, patch) => {
    try {
      await api.put(`/price-requests/${anchorId}/rate`, patch);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Save failed'); }
  };

  const openFinalize = (g) => {
    // Default to lowest non-zero quote = best offer
    const quotes = [
      { name: g.vendor1_name, rate: +g.vendor1_rate || 0, terms: g.vendor1_terms },
      { name: g.vendor2_name, rate: +g.vendor2_rate || 0, terms: g.vendor2_terms },
      { name: g.vendor3_name, rate: +g.vendor3_rate || 0, terms: g.vendor3_terms },
    ].filter(q => q.name && q.rate > 0).sort((a, b) => a.rate - b.rate);
    const best = quotes[0] || {};
    setFinalForm({
      final_vendor_name: best.name || '',
      final_rate: best.rate || 0,
      final_terms: best.terms || '',
      propagate_to_group: true,
    });
    setFinalModal(g);
  };

  const submitFinalize = async (e) => {
    e.preventDefault();
    if (!finalForm.final_vendor_name) return toast.error('Pick a vendor');
    if (!(+finalForm.final_rate > 0)) return toast.error('Final rate must be greater than 0');
    try {
      const r = await api.post(`/price-requests/${finalModal.anchor_id}/finalize`, finalForm);
      toast.success(`Item added to Master (${r.data.item_code}) — ${r.data.propagated_count} request(s) updated`);
      setFinalModal(null); setFinalForm({});
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const remove = async (id) => {
    if (!confirm('Delete this price request?')) return;
    try { await api.delete(`/price-requests/${id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
  };

  const statusBadge = (s) => {
    const map = {
      open:      'bg-amber-100 text-amber-800 border-amber-200',
      quoted:    'bg-blue-100 text-blue-800 border-blue-200',
      finalized: 'bg-purple-100 text-purple-800 border-purple-200',
      added:     'bg-emerald-100 text-emerald-800 border-emerald-200',
    };
    return <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${map[s] || ''}`}>{s}</span>;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h3 className="text-xl font-bold text-gray-800">Price Required</h3>
          <p className="text-sm text-gray-500">
            Raise items missing from the catalog. Purchase team gets 3 vendor quotes, picks the final rate, and the item is added to Item Master automatically.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          {/* Bulk flow — download a template, fill it offline, upload
              it back. Same shape as the inline form, just many rows. */}
          <button
            onClick={downloadTemplate}
            className="btn btn-secondary flex items-center gap-2 text-sm"
            title="Download blank Excel template to fill many rows at once"
          ><FiDownload /> Template</button>
          <button
            onClick={() => bulkUploadRef.current?.click()}
            className="btn btn-secondary flex items-center gap-2 text-sm"
            title="Upload a filled template — every row becomes a price request"
          ><FiUpload /> Bulk Upload</button>
          <input
            ref={bulkUploadRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={handleBulkPick}
          />
          <button onClick={openNew} className="btn btn-primary flex items-center gap-2 w-full sm:w-auto justify-center"><FiPlus /> Raise Price Request</button>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {isQuoter && (
          <button onClick={() => setTab('quotes')} className={`btn text-sm ${tab === 'quotes' ? 'btn-primary' : 'btn-secondary'}`}>
            Vendor Rates ({grouped.length})
          </button>
        )}
        <button onClick={() => setTab('raise')} className={`btn text-sm ${tab === 'raise' ? 'btn-primary' : 'btn-secondary'}`}>
          All Requests ({requests.length})
        </button>
      </div>

      {/* TAB 1 — Vendor Rates (Stage 2 + 3 for purchase team).
          Card-per-item layout: each item gets its own full-width card with
          a header (item details + companies) and three vendor sections
          arranged side-by-side. The vendor pickers have proper column width
          so the dropdown opens cleanly within the card without overflowing
          a 9-column squeeze. Finalize button sits in the card footer. */}
      {tab === 'quotes' && isQuoter && (
        <div className="space-y-3">
          {grouped.map(g => {
            const typeChip = g.item_type === 'FOC' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : g.item_type === 'RGP' ? 'bg-amber-50 text-amber-700 border-amber-200'
              : 'bg-red-50 text-red-700 border-red-200';
            const filledCount = [1,2,3].filter(n => g[`vendor${n}_name`] && +g[`vendor${n}_rate`] > 0).length;
            return (
              <div key={g.anchor_id} className="card p-0 overflow-visible">
                {/* HEADER — item details + companies + quote progress */}
                <div className="px-4 py-3 border-b bg-gradient-to-r from-blue-50 to-blue-100">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="font-semibold text-gray-900 text-sm">{g.item_name}</h4>
                        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${typeChip}`}>{g.item_type}</span>
                        <span className="text-[11px] text-gray-500">· UOM: {g.uom}</span>
                      </div>
                      {(g.size || g.specification || g.make) && (
                        <div className="text-[11px] text-gray-600 mt-0.5">
                          {g.size && <span><span className="text-gray-400">Size:</span> {g.size}</span>}
                          {g.specification && <span className="ml-2"><span className="text-gray-400">Spec:</span> {g.specification}</span>}
                          {g.make && <span className="ml-2"><span className="text-gray-400">Make:</span> {g.make}</span>}
                        </div>
                      )}
                      <div className="text-[11px] text-gray-600 mt-1">
                        <span className="text-gray-400">Companies:</span>{' '}
                        {g.sites.length ? g.sites.map((s, i) => <span key={i}>{i > 0 && ' · '}📍 {s}</span>) : <span className="text-gray-300">—</span>}
                        {g.request_ids.length > 1 && <span className="text-gray-400 italic ml-2">(merged from {g.request_ids.length})</span>}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] text-gray-500 uppercase tracking-wide">Quotes filled</div>
                      <div className={`text-lg font-bold ${filledCount === 3 ? 'text-emerald-700' : 'text-amber-700'}`}>{filledCount} / 3</div>
                    </div>
                  </div>
                </div>

                {/* THREE VENDOR SECTIONS — side-by-side on desktop, stacked on mobile.
                    Each section has full width to host the searchable dropdown without
                    overflow, plus the rate input and terms select right beneath. */}
                <div className="p-3 grid grid-cols-1 md:grid-cols-3 gap-3">
                  {[1, 2, 3].map(n => (
                    <div key={n} className="border border-gray-200 rounded-lg p-3 bg-gray-50/50">
                      <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-2">Vendor {n}</div>
                      <SearchableSelect
                        options={vendors}
                        value={g[`vendor${n}_name`] || null}
                        valueKey="name" displayKey="name"
                        placeholder="Pick vendor from master"
                        onChange={(v) => updateRate(g.anchor_id, { [`vendor${n}_name`]: v?.name || '' })}
                      />
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        <div>
                          <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Rate ₹</label>
                          <input className="input text-sm text-right tabular-nums" type="number" min="0" placeholder="0"
                            defaultValue={g[`vendor${n}_rate`] || ''}
                            onBlur={e => {
                              const v = e.target.value;
                              if (+v !== +(g[`vendor${n}_rate`] || 0)) updateRate(g.anchor_id, { [`vendor${n}_rate`]: v });
                            }} />
                        </div>
                        <div>
                          <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Terms</label>
                          <select className="select text-sm" value={g[`vendor${n}_terms`] || ''}
                            onChange={e => updateRate(g.anchor_id, { [`vendor${n}_terms`]: e.target.value })}>
                            <option value="">—</option>
                            <option value="Advance">Advance</option>
                            <option value="Credit">Credit</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* FOOTER — Finalize button. Disabled until at least one vendor has a rate. */}
                <div className="px-4 py-2.5 border-t bg-gray-50/60 flex justify-end">
                  <button
                    onClick={() => openFinalize(g)}
                    disabled={filledCount === 0}
                    className="btn btn-primary text-sm flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <FiCheckCircle size={14} /> Finalize & Add to Item Master
                  </button>
                </div>
              </div>
            );
          })}
          {grouped.length === 0 && (
            <div className="card p-8 text-center text-gray-400 text-sm">No open price requests. ✨</div>
          )}
        </div>
      )}

      {/* TAB 2 — All requests (raise / status / personal) */}
      {(tab === 'raise' || !isQuoter) && (
        <div className="card p-0">
          <table className="text-sm w-full freeze-head">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Company</th>
                <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Item</th>
                <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Size / Spec / Make</th>
                <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Type</th>
                <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Raised By</th>
                <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Final Rate</th>
                <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Status</th>
                <th className="text-right px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody>
              {requests.map(r => (
                <tr key={r.id} className="border-t hover:bg-gray-50/60">
                  <td className="px-3 py-2 text-[12px]">{r.site_name || <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2 font-medium">{r.item_name}<div className="text-[10px] text-gray-400">{r.uom}</div></td>
                  <td className="px-3 py-2 text-[11px] text-gray-600">{[r.size, r.specification, r.make].filter(Boolean).join(' · ') || <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2"><span className="text-[10px] font-bold uppercase">{r.item_type}</span></td>
                  <td className="px-3 py-2 text-[11px]">{r.raised_by_name || '—'}</td>
                  <td className="px-3 py-2 tabular-nums">{r.final_rate ? <><span className="font-semibold">₹ {r.final_rate}</span><div className="text-[10px] text-gray-500">{r.final_vendor_name}</div></> : <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2">{statusBadge(r.status)}</td>
                  <td className="px-3 py-2 text-right">
                    {r.status !== 'added' && (r.raised_by === user?.id || isAdmin()) && (
                      <span className="inline-flex gap-1">
                        <button onClick={() => openEdit(r)} className="p-1 text-gray-500 hover:text-amber-600" title="Edit"><FiEdit2 size={14} /></button>
                        <button onClick={() => remove(r.id)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>
                      </span>
                    )}
                    {r.status === 'added' && r.item_master_id && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-700" title="Click Item Master in sidebar to view">
                        <FiTag size={10} /> in Master
                        {r.master_item_code && (
                          <span className="font-mono text-[10px] bg-emerald-50 border border-emerald-200 text-emerald-800 px-1.5 py-0.5 rounded">
                            {r.master_item_code}
                          </span>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {requests.length === 0 && (
                <tr><td colSpan="8" className="text-center py-8 text-gray-400">No requests yet — click "Raise Price Request" to add one.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* RAISE MODAL */}
      <Modal isOpen={createModal} onClose={() => { setCreateModal(false); setEditingId(null); }} title={editingId ? 'Edit Price Request' : 'Raise Price Request'} wide>
        <form onSubmit={submit} className="space-y-3">
          <p className="text-[11px] text-blue-700 bg-blue-50 border border-blue-100 rounded px-3 py-2">
            For items NOT yet in the Item Master. Purchase team will collect 3 vendor quotes, pick a final rate, and the item will be added to Master automatically.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Company Name <span className="text-gray-400 font-normal text-[10px]">(optional · type freely)</span></label>
              <input
                className="input"
                placeholder="e.g. M/s Sardarshahar Agri Energy Pvt. Ltd"
                value={form.site_name || ''}
                onChange={e => setForm({ ...form, site_name: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Item Name <span className="text-red-500">*</span></label>
              <input className="input" required placeholder="e.g. Stainless Steel Coupling" value={form.item_name} onChange={e => setForm({ ...form, item_name: e.target.value })} />
            </div>
            <div>
              <label className="label">Size</label>
              <input className="input" placeholder="e.g. 25mm" value={form.size} onChange={e => setForm({ ...form, size: e.target.value })} />
            </div>
            <div>
              <label className="label">Specification</label>
              <input className="input" placeholder="e.g. SS 304" value={form.specification} onChange={e => setForm({ ...form, specification: e.target.value })} />
            </div>
            <div>
              <label className="label">Make</label>
              <input className="input" placeholder="e.g. Astral / Polycab" value={form.make} onChange={e => setForm({ ...form, make: e.target.value })} />
            </div>
            <div>
              <label className="label">UOM</label>
              <input className="input" placeholder="PCS / MTR / KG / LTR" value={form.uom} onChange={e => setForm({ ...form, uom: e.target.value })} />
            </div>
            <div>
              <label className="label">Type</label>
              <select className="select" value={form.item_type} onChange={e => setForm({ ...form, item_type: e.target.value })}>
                <option value="PO">PO (Purchase Order — Chargeable)</option>
                <option value="FOC">FOC (Free of Cost)</option>
                <option value="RGP">RGP (Returnable Gate Pass)</option>
              </select>
            </div>
            <div>
              <label className="label">
                Department <span className="text-red-600">*</span>
                <span className="text-gray-400 font-normal text-[10px] ml-1">(drives the new item_code prefix · FF1810 / ELV0987 / ELE0035…)</span>
              </label>
              {/* Combo input — pick from existing departments OR type a new
                  one.  Required because the item_code prefix is derived from
                  the department on finalize (mam 2026-05-25: "ITEM NAME
                  CREATE AT PLACE OF PO IF DEPARTMENT FF THEN FF").  Stored
                  uppercase to stay consistent with how Item Master treats
                  them. */}
              <input
                className="input"
                list="price-req-departments"
                required
                placeholder="e.g. FF / ELV / ELE / CIVIL / GEN"
                value={form.department || ''}
                onChange={e => setForm({ ...form, department: e.target.value.toUpperCase() })}
              />
              <datalist id="price-req-departments">
                {departments.map(d => <option key={d} value={d} />)}
              </datalist>
            </div>
            <div className="sm:col-span-2">
              <label className="label">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
              <textarea className="input" rows="2" placeholder="Why is this needed? Any urgency?" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => { setCreateModal(false); setEditingId(null); }} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{editingId ? 'Update Request' : 'Submit Request'}</button>
          </div>
        </form>
      </Modal>

      {/* FINALIZE MODAL */}
      {finalModal && (
        <Modal isOpen={!!finalModal} onClose={() => { setFinalModal(null); setFinalForm({}); }} title={`Finalize — ${finalModal.item_name}`}>
          <form onSubmit={submitFinalize} className="space-y-3">
            <div className="bg-gray-50 rounded-lg p-3 text-xs space-y-1">
              <p className="font-semibold text-gray-700">Vendor quotes for this item:</p>
              {[1, 2, 3].map(n => finalModal[`vendor${n}_name`] && +finalModal[`vendor${n}_rate`] > 0 && (
                <div key={n} className="flex justify-between">
                  <span>{finalModal[`vendor${n}_name`]}</span>
                  <span className="font-mono">Rs {finalModal[`vendor${n}_rate`]} {finalModal[`vendor${n}_terms`] ? `· ${finalModal[`vendor${n}_terms`]}` : ''}</span>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Final Vendor *</label>
                <select
                  className="select"
                  required
                  value={finalForm.final_vendor_name || ''}
                  onChange={e => {
                    const name = e.target.value;
                    let n = 0;
                    for (const i of [1, 2, 3]) {
                      if (finalModal[`vendor${i}_name`] === name) { n = i; break; }
                    }
                    setFinalForm(f => ({
                      ...f,
                      final_vendor_name: name,
                      final_rate: n ? +finalModal[`vendor${n}_rate`] || 0 : f.final_rate,
                      final_terms: n ? finalModal[`vendor${n}_terms`] || '' : f.final_terms,
                    }));
                  }}
                >
                  <option value="">— Pick vendor —</option>
                  {[1, 2, 3].map(n => {
                    const name = finalModal[`vendor${n}_name`];
                    const rate = +finalModal[`vendor${n}_rate`] || 0;
                    if (!name || rate <= 0) return null;
                    const terms = finalModal[`vendor${n}_terms`] || '';
                    return <option key={n} value={name}>{name} — Rs {rate}{terms ? ' · ' + terms : ''}</option>;
                  })}
                </select>
              </div>
              <div>
                <label className="label">Final Rate (₹) *</label>
                <input className="input" type="number" min="0" required value={finalForm.final_rate || ''} onChange={e => setFinalForm(f => ({ ...f, final_rate: +e.target.value }))} />
              </div>
              <div>
                <label className="label">Payment Terms</label>
                <select className="select" value={finalForm.final_terms || ''} onChange={e => setFinalForm(f => ({ ...f, final_terms: e.target.value }))}>
                  <option value="">— Select —</option>
                  <option value="Advance">Advance</option>
                  <option value="Credit">Credit</option>
                </select>
              </div>
              <div className="flex items-center pt-6">
                <label className="flex items-center gap-2 text-[12px] text-gray-700">
                  <input type="checkbox" checked={finalForm.propagate_to_group !== false} onChange={e => setFinalForm(f => ({ ...f, propagate_to_group: e.target.checked }))} />
                  Apply to all {finalModal.request_ids?.length || 1} merged request(s)
                </label>
              </div>
            </div>
            <div className="bg-emerald-50 border border-emerald-200 rounded p-2 text-[11px] text-emerald-800">
              💡 On finalize, this item will be auto-added to the Item Master with the final rate.
            </div>
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => { setFinalModal(null); setFinalForm({}); }} className="btn btn-secondary">Cancel</button>
              <button type="submit" className="btn btn-primary">Finalize & Add to Master</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
