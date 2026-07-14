import { useState, useEffect } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiEdit2, FiSearch, FiEye, FiTrash2, FiTruck, FiDownload, FiUpload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { fmtDateTime } from '../utils/datetime';
import { STATES, DISTRICTS_BY_STATE } from '../data/indiaLocations';

const PAGE_SIZE = 50;  // vendors per page — keeps the list short instead of one 654-row scroll
const CATEGORIES = ['FF', 'ELE', 'LV', 'Solar', 'HVAC', 'Plumbing', 'INTERIOR', 'OTHER'];
const TYPES = ['Distributor', 'Trader', 'Manufacture', 'Direct Company', 'Stockist'];
const CAT_COLORS = { FF: 'bg-red-100 text-red-700', ELE: 'bg-amber-100 text-amber-700', LV: 'bg-red-100 text-red-700', Solar: 'bg-emerald-100 text-emerald-700', HVAC: 'bg-cyan-100 text-cyan-700', Plumbing: 'bg-blue-100 text-blue-700', INTERIOR: 'bg-purple-100 text-purple-700' };

// GSTIN format: 2-digit state code + 10-char PAN + 1-digit entity + Z + 1-digit checksum.
// Mam (2026-05-16) asked for GST auto-fetch.  We can't pull the
// full address without an API key, but we can parse the GSTIN
// itself to extract State, PAN, and validate the format — saves
// 3 fields of manual entry whenever the GSTIN is keyed in.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const GST_STATE_CODES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '25': 'Daman and Diu', '26': 'Dadra and Nagar Haveli',
  '27': 'Maharashtra', '28': 'Andhra Pradesh', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh',
  '38': 'Ladakh',
};
const parseGstin = (gstin) => {
  const v = String(gstin || '').toUpperCase().trim();
  if (!v) return { valid: null };
  const valid = GSTIN_RE.test(v);
  const stateCode = v.slice(0, 2);
  const state = GST_STATE_CODES[stateCode] || null;
  const pan = valid ? v.slice(2, 12) : null;
  return { valid, stateCode, state, pan, normalized: v };
};

export default function Vendors() {
  const { canCreate, canEdit, canDelete, isAdmin } = useAuth();
  const [vendors, setVendors] = useState([]);
  const [rates, setRates] = useState([]);
  const [tab, setTab] = useUrlTab('vendors');
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [viewData, setViewData] = useState(null);
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('');
  const [page, setPage] = useState(0);  // 0-based; client-side paginator over the filtered list
  // Bulk import (mam 2026-06-16): add many vendors at once from an Excel sheet
  // saved as CSV. Same flow as the Item Master bulk import.
  const [bulkModal, setBulkModal] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkPreview, setBulkPreview] = useState([]);
  const [importing, setImporting] = useState(false);

  const load = () => {
    api.get('/procurement/vendors').then(r => setVendors(r.data));
    api.get('/procurement/vendor-rates').then(r => setRates(r.data));
  };
  useEffect(() => { load(); }, []);

  const saveVendor = async (e) => {
    e.preventDefault();
    // Mam (2026-05-16): "credit days and sub category not mandatory
    // all other are mandatory".  Native required catches text/select
    // fields, but SearchableSelect (state / district) and the GST
    // valid-format check need an explicit guard before submit.
    const missing = [];
    if (!form.name || !String(form.name).trim()) missing.push('Vendor Name');
    if (!form.firm_name || !String(form.firm_name).trim()) missing.push('Firm Name');
    if (!form.category) missing.push('Category');
    if (!form.type) missing.push('Type');
    if (!form.deals_in || !String(form.deals_in).trim()) missing.push('Deals In');
    if (!form.authorized_dealer || !String(form.authorized_dealer).trim()) missing.push('Authorized Dealer');
    if (!form.contact_person || !String(form.contact_person).trim()) missing.push('Contact Person');
    if (!form.phone || !String(form.phone).trim()) missing.push('Phone');
    if (!form.email || !String(form.email).trim()) missing.push('Email');
    if (!form.state) missing.push('State');
    if (!form.district) missing.push('District');
    if (!form.gst_number || !String(form.gst_number).trim()) missing.push('GST Number');
    else if (!parseGstin(form.gst_number).valid) missing.push('GST Number (invalid format)');
    if (!form.payment_terms) missing.push('Payment Terms');
    if (!form.address || !String(form.address).trim()) missing.push('Address');
    // Admin bypasses mandatory fields (mam 2026-06-19) — can save partial.
    if (missing.length && !isAdmin()) {
      toast.error(`Required: ${missing.join(', ')}`);
      return;
    }
    try {
      if (editing) { await api.put(`/procurement/vendors/${editing.id}`, form); }
      else { await api.post('/procurement/vendors', form); }
      toast.success(editing ? 'Updated' : 'Created');
      setModal(false); setEditing(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Error'); }
  };

  const saveRate = async (e) => {
    e.preventDefault();
    await api.post('/procurement/vendor-rates', form);
    toast.success('Rate comparison saved');
    setModal(false); load();
  };

  const approveRate = async (id, status) => {
    await api.put(`/procurement/vendor-rates/${id}/approve`, { approval_status: status });
    toast.success(`Rate ${status}`); load();
  };

  // ── Bulk import ──────────────────────────────────────────────────────
  // Column header (in order) → vendor field. Keep labels Excel-friendly so
  // mam can fill the sheet by hand. Only "Vendor Name" is required; the rest
  // are optional but recommended ("full details").
  const BULK_COLS = [
    ['Vendor Code', 'vendor_code'], ['Vendor Name', 'name'], ['Firm Name', 'firm_name'],
    ['Category', 'category'], ['Type', 'type'], ['Deals In', 'deals_in'],
    ['Authorized Dealer', 'authorized_dealer'], ['Make/Brand', 'makes'], ['Contact Person', 'contact_person'],
    ['Phone', 'phone'], ['Email', 'email'], ['State', 'state'], ['District', 'district'],
    ['GST Number', 'gst_number'], ['Payment Terms', 'payment_terms'], ['Credit Days', 'credit_days'],
    ['Sub Category', 'sub_category'], ['Rating', 'rating'], ['Turnover', 'turnover'],
    ['Team Size', 'team_size'], ['Source', 'source'], ['Address', 'address'],
  ];

  // Quote-aware CSV parser — vendor addresses contain commas, so a naive
  // split(',') would shred them. Handles "..." quoted fields and "" escapes.
  const parseCsvLine = (line) => {
    const out = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
  };

  const parseVendorCsv = (text) => {
    const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];
    // Skip the header row (we map by fixed column order).
    return lines.slice(1).map(line => {
      const c = parseCsvLine(line);
      const v = {};
      BULK_COLS.forEach(([, key], idx) => { v[key] = c[idx] || ''; });
      // Makes are entered semicolon-separated (comma is the CSV delimiter);
      // send as an array so the server stores each brand cleanly.
      v.makes = v.makes ? v.makes.split(/[;,]/).map(s => s.trim()).filter(Boolean) : [];
      return v;
    }).filter(v => v.name);
  };

  const downloadVendorTemplate = () => {
    const header = BULK_COLS.map(([label]) => label).join(',');
    const sample = ['', 'Agni Devices Ltd', 'Agni Devices Pvt Ltd', 'FF', 'Distributor', 'Fire pumps & hydrants',
      'Agni', 'Havells; Agni', 'Ramesh Kumar', '9876543210', 'sales@agni.com', 'Rajasthan', 'Jaipur',
      '08AAAAA0000A1Z5', 'Credit', '30', 'Pumps', '8', '5 Cr', '25', 'Reference', '"12, MI Road, Jaipur"'].join(',');
    const csv = header + '\n' + sample;
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'vendors-template.csv'; a.click();
  };

  const handleBulkFile = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { setBulkText(ev.target.result); setBulkPreview(parseVendorCsv(ev.target.result)); };
    reader.readAsText(file); e.target.value = '';
  };

  const runBulkImport = async () => {
    if (bulkPreview.length === 0) return toast.error('No valid rows — every row needs at least a Vendor Name');
    setImporting(true);
    try {
      const r = await api.post('/procurement/vendors/bulk', { vendors: bulkPreview });
      const { added = 0, updated = 0, skipped = [], errors = [] } = r.data || {};
      toast.success(`${added} added · ${updated} updated${skipped.length ? ` · ${skipped.length} skipped` : ''}${errors.length ? ` · ${errors.length} error(s)` : ''}`);
      if (skipped.length || errors.length) console.warn('Vendor bulk import:', { skipped, errors });
      setBulkModal(false); setBulkText(''); setBulkPreview([]); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Import failed'); }
    setImporting(false);
  };

  const filtered = vendors.filter(v => {
    if (filterCat && v.category !== filterCat) return false;
    if (search) {
      // Search vendor name AND firm name (mam 2026-06-19: "can also search by
      // vendor firm name"), plus deals-in / code / district / phone.
      const q = search.toLowerCase();
      const hit = (f) => (v[f] || '').toString().toLowerCase().includes(q);
      if (!hit('name') && !hit('firm_name') && !hit('deals_in') && !hit('vendor_code') && !hit('district') && !hit('phone') && !hit('contact_person')) return false;
    }
    return true;
  });

  // Paginate the filtered list so the page shows PAGE_SIZE rows at a time
  // instead of all 654 (mam 2026-06-16: "i need to scroll very down").
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const paged = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  // Vendor master data-completeness (mam 2026-06-17): across ALL vendors, how
  // many of the important fields are filled vs blank → one quality %.
  // total fields = vendors × fields-per-vendor (e.g. 660 × 14).
  // 17 vendor data fields (every form field except the auto code + the
  // always-defaulted rating). makes may be an array → treated below.
  const COMPLETENESS_FIELDS = ['name', 'firm_name', 'category', 'type', 'deals_in', 'authorized_dealer', 'makes', 'contact_person', 'phone', 'email', 'state', 'district', 'gst_number', 'payment_terms', 'credit_days', 'sub_category', 'address'];
  const cmpFieldsPer = COMPLETENESS_FIELDS.length;
  const cmpTotal = vendors.length * cmpFieldsPer;
  let cmpFilled = 0;
  for (const v of vendors) for (const f of COMPLETENESS_FIELDS) if (v[f] != null && String(v[f]).trim() !== '') cmpFilled++;
  const cmpPending = cmpTotal - cmpFilled;
  const cmpPct = cmpTotal ? Math.round((cmpFilled / cmpTotal) * 100) : 0;
  // Snap back to page 1 whenever the search / category filter changes.
  useEffect(() => { setPage(0); }, [search, filterCat]);

  // Category counts
  const catCounts = {};
  vendors.forEach(v => { if (v.category) catCounts[v.category] = (catCounts[v.category] || 0) + 1; });

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setTab('vendors')} className={`btn ${tab === 'vendors' ? 'btn-primary' : 'btn-secondary'} text-sm`}>Vendors ({vendors.length})</button>
        <button onClick={() => setTab('rates')} className={`btn ${tab === 'rates' ? 'btn-primary' : 'btn-secondary'} text-sm`}>Rate Comparison</button>
      </div>

      {tab === 'vendors' && (
        <>
          {/* Category filter chips */}
          <div className="flex gap-2 flex-wrap">
            <button onClick={() => setFilterCat('')} className={`px-3 py-1 rounded-full text-xs font-semibold border ${!filterCat ? 'bg-red-600 text-white' : 'bg-white text-gray-600 border-gray-200'}`}>All ({vendors.length})</button>
            {Object.entries(catCounts).sort((a, b) => b[1] - a[1]).map(([cat, count]) => (
              <button key={cat} onClick={() => setFilterCat(filterCat === cat ? '' : cat)} className={`px-3 py-1 rounded-full text-xs font-semibold border ${filterCat === cat ? 'bg-red-600 text-white' : 'bg-white text-gray-600 border-gray-200'}`}>{cat} ({count})</button>
            ))}
          </div>

          <div className="flex gap-3">
            <div className="relative flex-1"><FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} /><input className="input pl-10" placeholder="Search vendor name, firm name, deals in, code, district, phone..." value={search} onChange={e => setSearch(e.target.value)} /></div>
            <button onClick={() => exportCsv('vendors',
              ['Code','Name','Firm','Category','Deals In','Type','Phone','Email','District','State','Authorized Dealer','Turnover'],
              filtered.map(v => [v.vendor_code, v.name, v.firm_name, v.category, v.deals_in, v.type, v.phone, v.email, v.district, v.state, v.authorized_dealer, v.turnover]))}
              className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload size={15} /> Export Excel</button>
            {canCreate('vendors') && <button onClick={() => { setBulkText(''); setBulkPreview([]); setBulkModal(true); }} className="btn btn-secondary flex items-center gap-2 text-sm"><FiUpload size={15} /> Bulk Import</button>}
            {canCreate('vendors') && <button onClick={() => { setEditing(null); setForm({ rating: 2 }); setModal('vendor'); }} className="btn btn-primary flex items-center gap-2 text-sm"><FiPlus size={15} /> Add Vendor</button>}
          </div>

          <p className="text-sm text-gray-500">
            Showing {filtered.length ? safePage * PAGE_SIZE + 1 : 0}–{Math.min(filtered.length, (safePage + 1) * PAGE_SIZE)} of {filtered.length} vendors
          </p>

          {/* Master data-completeness box (mam 2026-06-17): vendors × fields =
              total, filled vs pending, and overall % across ALL vendors. */}
          <div className="card p-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <div className="font-semibold text-gray-700">📋 Master Completeness</div>
            <div><span className="text-gray-500">Fields:</span> <b>{vendors.length.toLocaleString('en-IN')} × {cmpFieldsPer} = {cmpTotal.toLocaleString('en-IN')}</b></div>
            <div className="text-emerald-700"><span className="text-gray-500">Filled:</span> <b>{cmpFilled.toLocaleString('en-IN')}</b></div>
            <div className="text-amber-700"><span className="text-gray-500">Pending:</span> <b>{cmpPending.toLocaleString('en-IN')}</b></div>
            <div className="flex items-center gap-2">
              <span className="text-gray-500">Complete:</span>
              <b className={cmpPct >= 80 ? 'text-emerald-700' : cmpPct >= 50 ? 'text-amber-700' : 'text-red-600'}>{cmpPct}%</b>
              <div className="w-32 h-2 bg-gray-200 rounded overflow-hidden"><div className="h-full bg-blue-600" style={{ width: `${cmpPct}%` }} /></div>
            </div>
            <span className="text-[11px] text-gray-400">across all {vendors.length} vendors · {cmpFieldsPer} key fields each</span>
          </div>

          <div className="card p-0 overflow-x-auto"><table className="min-w-[1000px] text-xs freeze-head">
            <thead><tr className="bg-gray-50">
              <th className="px-2 py-2">Code</th><th className="px-2 py-2 text-left">Vendor / Firm Name</th><th className="px-2 py-2">Category</th>
              <th className="px-2 py-2 text-left">Deals In</th><th className="px-2 py-2">Type</th><th className="px-2 py-2 text-left">District</th>
              <th className="px-2 py-2">Phone</th><th className="px-2 py-2">Payment</th><th className="px-2 py-2">Credit</th><th className="px-2 py-2">Last Updated</th><th className="px-2 py-2">Actions</th>
            </tr></thead>
            <tbody>{paged.map(v => (
              <tr key={v.id} className="border-b hover:bg-red-50/30">
                <td className="px-2 py-2 font-mono text-[10px] text-red-600">{v.vendor_code || '-'}</td>
                <td className="px-2 py-2">
                  <div className="font-semibold">{v.name}</div>
                  {/* Firm name shown right under the vendor name (mam 2026-06-19)
                      so master edits are visible without reopening the vendor. */}
                  {v.firm_name && <div className="text-[10px] text-gray-500 font-medium">{v.firm_name}</div>}
                  {v.authorized_dealer && v.authorized_dealer !== v.firm_name && <div className="text-[10px] text-gray-400">{v.authorized_dealer}</div>}
                </td>
                <td className="px-2 py-2"><span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${CAT_COLORS[v.category] || 'bg-gray-100'}`}>{v.category || '-'}</span></td>
                <td className="px-2 py-2 text-[11px]">{v.deals_in || '-'}</td>
                <td className="px-2 py-2 text-[10px]">{v.type || '-'}</td>
                <td className="px-2 py-2 text-[11px]">{v.district || '-'}{v.state ? `, ${v.state}` : ''}</td>
                <td className="px-2 py-2 text-[11px]">{v.phone || '-'}</td>
                <td className="px-2 py-2 text-[10px]">{v.payment_terms || '-'}</td>
                <td className="px-2 py-2 text-[10px]">{v.credit_days || '-'}</td>
                {/* Last edited — falls back to created_at for vendors not yet
                    re-saved since the updated_at column was added (mam 2026-06-19). */}
                <td className="px-2 py-2 text-[10px] text-gray-500 whitespace-nowrap">{fmtDateTime(v.updated_at || v.created_at) || '-'}</td>
                <td className="px-2 py-2">
                  <div className="flex gap-1">
                    <button onClick={() => { setViewData(v); setModal('view'); }} className="p-1 text-gray-400 hover:text-red-600"><FiEye size={14} /></button>
                    {canEdit('vendors') && <button onClick={() => { setEditing(v); setForm(v); setModal('vendor'); }} className="p-1 text-gray-400 hover:text-amber-600"><FiEdit2 size={14} /></button>}
                    {canDelete('vendors') && <button onClick={async () => {
                      if (!confirm(`Delete vendor "${v.name}"?`)) return;
                      try { await api.delete(`/procurement/vendors/${v.id}`); toast.success('Deleted'); load(); }
                      catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                    }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}
                  </div>
                </td>
              </tr>
            ))}{filtered.length === 0 && <tr><td colSpan="11" className="text-center py-8 text-gray-400">No vendors found</td></tr>}</tbody>
          </table></div>

          {/* Paginator — only when there's more than one page */}
          {pageCount > 1 && (
            <div className="flex items-center justify-between text-xs text-gray-600 mt-1">
              <span>Page <b>{safePage + 1}</b> of <b>{pageCount}</b></span>
              <div className="flex items-center gap-2">
                <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0}
                  className="btn btn-secondary text-xs disabled:opacity-40 disabled:cursor-not-allowed">‹ Prev</button>
                <button onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={safePage >= pageCount - 1}
                  className="btn btn-secondary text-xs disabled:opacity-40 disabled:cursor-not-allowed">Next ›</button>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'rates' && (
        <>
          <div className="flex justify-between items-center">
            <h3 className="font-semibold text-sm">3 Vendor Rate Comparison</h3>
            <button onClick={() => { setForm({ item_description: '', vendor1_id: '', vendor1_rate: 0, vendor2_id: '', vendor2_rate: 0, vendor3_id: '', vendor3_rate: 0, final_rate: 0, selected_vendor_id: '' }); setModal('rate'); }} className="btn btn-primary flex items-center gap-2 text-sm"><FiPlus size={15} /> Add Comparison</button>
          </div>
          <div className="card p-0"><table className="text-xs freeze-head">
            <thead><tr><th>Item</th><th>Vendor 1</th><th>Rate 1</th><th>Vendor 2</th><th>Rate 2</th><th>Vendor 3</th><th>Rate 3</th><th>Final</th><th>Selected</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>{rates.map(r => (
              <tr key={r.id}>
                <td className="font-medium">{r.item_description}</td>
                <td>{r.vendor1_name}</td><td className="font-semibold">Rs {r.vendor1_rate}</td>
                <td>{r.vendor2_name}</td><td className="font-semibold">Rs {r.vendor2_rate}</td>
                <td>{r.vendor3_name}</td><td className="font-semibold">Rs {r.vendor3_rate}</td>
                <td className="font-bold text-emerald-600">Rs {r.final_rate}</td>
                <td className="font-medium text-red-600">{r.selected_vendor_name}</td>
                <td><span className={`badge ${r.approval_status === 'approved' ? 'badge-green' : r.approval_status === 'rejected' ? 'badge-red' : 'badge-yellow'}`}>{r.approval_status}</span></td>
                <td><div className="flex gap-1 items-center">
                  {r.approval_status === 'pending' && (
                    <>
                      <button onClick={() => approveRate(r.id, 'approved')} className="text-[10px] text-emerald-600 font-bold">Approve</button>
                      <button onClick={() => approveRate(r.id, 'rejected')} className="text-[10px] text-red-600 font-bold">Reject</button>
                    </>
                  )}
                  {(canDelete('vendors') || canDelete('procurement')) && <button onClick={async () => {
                    if (!confirm(`Delete rate comparison for "${r.item_description}"?`)) return;
                    try { await api.delete(`/procurement/vendor-rates/${r.id}`); toast.success('Deleted'); load(); }
                    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                  }} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}
                </div></td>
              </tr>
            ))}{rates.length === 0 && <tr><td colSpan="11" className="text-center py-8 text-gray-400">No comparisons yet</td></tr>}</tbody>
          </table></div>
        </>
      )}

      {/* View Vendor Modal */}
      <Modal isOpen={modal === 'view'} onClose={() => { setModal(false); setViewData(null); }} title={viewData?.name} wide>
        {viewData && (
          <div className="space-y-3 text-sm">
            <div className="flex gap-2 items-center">
              <span className={`text-xs px-2 py-0.5 rounded font-medium ${CAT_COLORS[viewData.category] || 'bg-gray-100'}`}>{viewData.category}</span>
              <span className="text-xs bg-gray-100 px-2 py-0.5 rounded">{viewData.type}</span>
              <span className="font-mono text-xs text-red-600">{viewData.vendor_code}</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <div><span className="text-gray-400 text-xs">Deals In:</span><br/><span className="font-medium">{viewData.deals_in || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Make / Brand:</span><br/><span className="font-medium">{viewData.makes || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Authorized:</span><br/><span className="font-medium">{viewData.authorized_dealer || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Contact Person:</span><br/><span className="font-medium">{viewData.contact_person || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Sub Category:</span><br/><span className="font-medium">{viewData.sub_category || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Rating:</span><br/><span className="font-medium">{viewData.rating !== null && viewData.rating !== undefined && viewData.rating !== '' ? `${viewData.rating} / 10` : '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Phone:</span><br/><span className="font-medium">{viewData.phone || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Email:</span><br/><span className="font-medium">{viewData.email || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">GST:</span><br/><span className="font-medium">{viewData.gst_number || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">District:</span><br/><span className="font-medium">{viewData.district}, {viewData.state}</span></div>
              <div><span className="text-gray-400 text-xs">Address:</span><br/><span className="font-medium">{viewData.address || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Payment:</span><br/><span className="font-medium">{viewData.payment_terms} - {viewData.credit_days} days</span></div>
              <div><span className="text-gray-400 text-xs">Turnover:</span><br/><span className="font-medium">{viewData.turnover || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Team Size:</span><br/><span className="font-medium">{viewData.team_size || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Source:</span><br/><span className="font-medium">{viewData.source || '-'}</span></div>
            </div>
          </div>
        )}
      </Modal>

      {/* Add/Edit Vendor Modal */}
      <Modal isOpen={modal === 'vendor'} onClose={() => { setModal(false); setEditing(null); }} title={editing ? 'Edit Vendor' : 'Add Vendor'} wide>
        <form onSubmit={saveVendor} className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            <div><label className="label">Vendor Code</label><input className="input" value={form.vendor_code || ''} onChange={e => setForm({...form, vendor_code: e.target.value})} placeholder="Auto if empty" /></div>
            <div><label className="label">Vendor Name *</label><input className="input" value={form.name || ''} onChange={e => setForm({...form, name: e.target.value})} required /></div>
            {/* Firm Name + Search Web (mam, 2026-05-16: "autofetch
                address from whole net and gst number also and contact
                person also").  No fully-free auto-fetch exists; the
                pragmatic helper is a Google-search button that
                pre-builds a query for address / GST / contact info. */}
            <div>
              <label className="label flex items-center justify-between">
                <span>Firm Name <span className="text-red-500">*</span></span>
                {form.firm_name && (
                  <a target="_blank" rel="noreferrer"
                     href={`https://www.google.com/search?q=${encodeURIComponent(`${form.firm_name} ${form.district || ''} GST address contact`)}`}
                     className="text-[10px] text-blue-600 hover:text-blue-800 underline font-normal normal-case"
                     title="Open Google search for this firm's GST / address / contact in a new tab. Copy back what you need.">
                    🌐 search web
                  </a>
                )}
              </label>
              <input className="input" value={form.firm_name || ''} onChange={e => setForm({...form, firm_name: e.target.value})} required />
            </div>
            <div><label className="label">Category <span className="text-red-500">*</span></label><select className="select" value={form.category || ''} onChange={e => setForm({...form, category: e.target.value})} required><option value="">Select</option>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></div>
            <div><label className="label">Type <span className="text-red-500">*</span></label><select className="select" value={form.type || ''} onChange={e => setForm({...form, type: e.target.value})} required><option value="">Select</option>{TYPES.map(t => <option key={t}>{t}</option>)}</select></div>
            <div><label className="label">Deals In <span className="text-red-500">*</span></label><input className="input" value={form.deals_in || ''} onChange={e => setForm({...form, deals_in: e.target.value})} required /></div>
            <div><label className="label">Authorized Dealer <span className="text-red-500">*</span></label><input className="input" value={form.authorized_dealer || ''} onChange={e => setForm({...form, authorized_dealer: e.target.value})} required /></div>
            {/* Make / Brand — mam (2026-06-15): list the brands this vendor
                deals in, add with "+", up to 10. Stored comma-joined in
                vendors.makes. */}
            <div className="sm:col-span-2 md:col-span-3">
              <label className="label">Make / Brand <span className="text-gray-400 font-normal text-[10px]">(brands this vendor deals in — add up to 10)</span></label>
              {(() => {
                const makesArr = Array.isArray(form.makes)
                  ? form.makes
                  : (form.makes ? String(form.makes).split(',').map(s => s.trim()).filter(Boolean) : []);
                const rows = makesArr.length ? makesArr : [''];
                const setMakes = (arr) => setForm({ ...form, makes: arr });
                return (
                  <div className="space-y-2">
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                      {rows.map((mk, i) => (
                        <div key={i} className="flex items-center gap-1">
                          <input className="input flex-1" value={mk} placeholder={`Make ${i + 1} — e.g. Havells`}
                            onChange={e => { const next = [...rows]; next[i] = e.target.value; setMakes(next); }} />
                          {rows.length > 1 && (
                            <button type="button" title="Remove" onClick={() => setMakes(rows.filter((_, idx) => idx !== i))}
                              className="text-red-500 hover:text-red-700 px-1 text-lg leading-none">×</button>
                          )}
                        </div>
                      ))}
                    </div>
                    {rows.filter(Boolean).length < 10 && (
                      <button type="button" onClick={() => setMakes([...rows.filter(Boolean), ''])}
                        className="text-blue-600 hover:text-blue-800 text-sm font-medium">+ Add make</button>
                    )}
                  </div>
                );
              })()}
            </div>
            {/* Contact Person — mam (2026-05-16): "contact person name
                add here and fill in po".  Already in the vendors
                schema (contact_person column) and the Vendor PO print
                page reads it, but the form was missing the input. */}
            <div><label className="label">Contact Person <span className="text-red-500">*</span></label><input className="input" value={form.contact_person || ''} onChange={e => setForm({...form, contact_person: e.target.value})} placeholder="Name of person to call" required /></div>
            <div><label className="label">Phone <span className="text-red-500">*</span></label><input className="input" value={form.phone || ''} onChange={e => setForm({...form, phone: e.target.value})} required /></div>
            <div><label className="label">Email <span className="text-red-500">*</span></label><input className="input" type="email" value={form.email || ''} onChange={e => setForm({...form, email: e.target.value})} required /></div>
            <div>
              <label className="label">State <span className="text-red-500">*</span></label>
              <SearchableSelect
                options={STATES.map(s => ({ value: s, label: s }))}
                value={form.state || ''} valueKey="value" displayKey="label"
                placeholder="Pick state"
                onChange={(opt) => setForm({ ...form, state: opt?.value || '', district: '' })}
              />
            </div>
            <div>
              <label className="label">District <span className="text-red-500">*</span></label>
              <SearchableSelect
                options={(form.state ? (DISTRICTS_BY_STATE[form.state] || []) : []).map(d => ({ value: d, label: d }))}
                value={form.district || ''} valueKey="value" displayKey="label"
                placeholder={form.state ? 'Pick district' : 'Pick a state first'}
                onChange={(opt) => setForm({ ...form, district: opt?.value || '' })}
              />
            </div>
            {/* GSTIN — auto-extracts State from the 2-digit prefix
                and shows ✓/✗ format validity (mam, 2026-05-16:
                "gst number also").  Full address lookup needs a
                paid API; this gets you the state field for free. */}
            <div>
              <label className="label flex items-center justify-between">
                <span>GST Number <span className="text-red-500">*</span></span>
                {(() => {
                  const g = parseGstin(form.gst_number);
                  if (g.valid === null) return null;
                  return g.valid
                    ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-mono">✓ valid · {g.state || g.stateCode}</span>
                    : <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-mono">✗ bad format</span>;
                })()}
              </label>
              <input
                className="input font-mono"
                value={form.gst_number || ''}
                placeholder="03AAAAA0000A1Z5"
                required
                onChange={e => {
                  const v = e.target.value.toUpperCase().slice(0, 15);
                  const patch = { gst_number: v };
                  const g = parseGstin(v);
                  // Auto-fill State if a valid state code and the field is empty
                  if (g.state && !form.state) {
                    patch.state = g.state;
                  }
                  setForm({ ...form, ...patch });
                }}
              />
            </div>
            <div><label className="label">Payment Terms <span className="text-red-500">*</span></label><select className="select" value={form.payment_terms || ''} onChange={e => setForm({...form, payment_terms: e.target.value})} required><option value="">Select</option><option>Advance</option><option>Credit</option><option>PDC</option><option>COD</option></select></div>
            <div><label className="label">Credit Days <span className="text-[10px] text-gray-400 font-normal normal-case">(optional)</span></label><input className="input" value={form.credit_days || ''} onChange={e => setForm({...form, credit_days: e.target.value})} /></div>
            <div><label className="label">Sub Category <span className="text-[10px] text-gray-400 font-normal normal-case">(optional)</span></label><input className="input" value={form.sub_category || ''} onChange={e => setForm({...form, sub_category: e.target.value})} /></div>
            <div>
              <label className="label">Rating <span className="text-[10px] text-gray-400 font-normal normal-case">(out of 10)</span></label>
              <div className="relative flex items-end justify-between pt-3 pb-1 px-1">
                {/* Track line behind the nodes — red → yellow → green */}
                <div className="absolute left-2 right-2 top-[18px] h-1.5 rounded-full" style={{ background: 'linear-gradient(to right, #ef4444, #f59e0b, #eab308, #22c55e)' }} />
                {[1,2,3,4,5,6,7,8,9,10].map(n => {
                  const hue = Math.round(((n - 1) / 9) * 120); // 0=red → 120=green
                  const color = `hsl(${hue}, 72%, 45%)`;
                  const selected = Number(form.rating) === n;
                  return (
                    <button
                      type="button"
                      key={n}
                      onClick={() => setForm({ ...form, rating: n })}
                      className="relative z-10 flex flex-col items-center gap-0.5 group"
                      title={`${n} / 10`}
                    >
                      <span
                        className="rounded-full bg-white flex items-center justify-center transition-all"
                        style={{
                          width: selected ? 18 : 13,
                          height: selected ? 18 : 13,
                          border: `3px solid ${color}`,
                          boxShadow: selected ? `0 0 0 3px ${color}33` : 'none',
                        }}
                      >
                        <span className="rounded-full" style={{ width: selected ? 7 : 4, height: selected ? 7 : 4, background: color }} />
                      </span>
                      <span className={`text-[9px] leading-none ${selected ? 'font-bold text-gray-800' : 'text-gray-400'}`}>{n}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div><label className="label">Address <span className="text-red-500">*</span></label><textarea className="input" rows="2" value={form.address || ''} onChange={e => setForm({...form, address: e.target.value})} required /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'}</button></div>
        </form>
      </Modal>

      {/* Bulk Import Modal */}
      <Modal isOpen={bulkModal} onClose={() => setBulkModal(false)} title="Bulk Import Vendors" wide>
        <div className="space-y-4">
          <div className="bg-red-50 p-3 rounded-lg text-sm text-red-700">
            <p className="font-semibold mb-1">Add new vendors OR update existing ones:</p>
            <p className="text-[12px]">In Excel, fill one vendor per row, then <b>Save As → CSV</b> and upload it here (or paste the rows below). Only <b>Vendor Name</b> is required.</p>
            <ul className="text-[11px] mt-1 list-disc pl-4 space-y-0.5">
              <li><b>To update an existing vendor</b>, put its <b>Vendor Code</b> (or its existing phone / GSTIN) in the row — only the cells you fill in get updated, blanks are left as-is.</li>
              <li><b>To add a new vendor</b>, leave Vendor Code blank — a code is generated automatically.</li>
              <li>Separate multiple Make/Brand values with a semicolon (e.g. <code>Havells; Agni</code>).</li>
            </ul>
            <p className="font-mono text-[10px] mt-2 break-words">{BULK_COLS.map(([l]) => l).join(', ')}</p>
          </div>
          <button onClick={downloadVendorTemplate} className="btn btn-secondary text-sm flex items-center gap-2"><FiDownload size={14} /> Download Template</button>
          <div>
            <label className="label">Upload CSV</label>
            <input type="file" accept=".csv" onChange={handleBulkFile} className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100" />
          </div>
          <div>
            <label className="label">Or paste CSV rows</label>
            <textarea className="input font-mono text-xs" rows="5" value={bulkText}
              onChange={e => { setBulkText(e.target.value); setBulkPreview(parseVendorCsv(e.target.value)); }}
              placeholder="Paste rows here (include the header row)" />
          </div>
          {bulkPreview.length > 0 && (
            <div>
              <p className="text-sm font-semibold mb-2">{bulkPreview.length} vendor{bulkPreview.length === 1 ? '' : 's'} ready to import</p>
              <div className="max-h-52 overflow-auto border rounded text-xs">
                <table className="w-full">
                  <thead><tr className="bg-gray-50">
                    <th className="px-2 py-1 text-left">Name</th><th className="px-2 py-1 text-left">Firm</th>
                    <th className="px-2 py-1">Category</th><th className="px-2 py-1">Phone</th>
                    <th className="px-2 py-1">GST</th><th className="px-2 py-1 text-left">District</th>
                  </tr></thead>
                  <tbody>{bulkPreview.map((v, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-2 py-1 font-medium">{v.name}</td>
                      <td className="px-2 py-1">{v.firm_name}</td>
                      <td className="px-2 py-1 text-center">{v.category}</td>
                      <td className="px-2 py-1 text-center">{v.phone}</td>
                      <td className="px-2 py-1 text-center font-mono text-[10px]">{v.gst_number}</td>
                      <td className="px-2 py-1">{v.district}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          )}
          <div className="flex justify-end gap-3">
            <button onClick={() => setBulkModal(false)} className="btn btn-secondary">Cancel</button>
            <button onClick={runBulkImport} disabled={bulkPreview.length === 0 || importing} className="btn btn-primary disabled:opacity-50 flex items-center gap-1">
              <FiUpload size={14} /> {importing ? 'Importing…' : `Import ${bulkPreview.length} Vendor${bulkPreview.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </Modal>

      {/* Rate Comparison Modal */}
      <Modal isOpen={modal === 'rate'} onClose={() => setModal(false)} title="3 Vendor Rate Comparison" wide>
        <form onSubmit={saveRate} className="space-y-4">
          <div><label className="label">Item Description *</label><input className="input" value={form.item_description || ''} onChange={e => setForm({...form, item_description: e.target.value})} required /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {[1,2,3].map(n => (
              <div key={n} className="space-y-2 p-3 bg-gray-50 rounded-lg">
                <h4 className="font-semibold text-sm">Vendor {n}</h4>
                <SearchableSelect
                  options={vendors}
                  value={form[`vendor${n}_id`] || null}
                  valueKey="id" displayKey="name"
                  placeholder="Search vendor…"
                  onChange={(v) => setForm({ ...form, [`vendor${n}_id`]: v?.id || '' })}
                />
                <input className="input" type="number" placeholder="Rate" value={form[`vendor${n}_rate`] || 0} onChange={e => setForm({...form, [`vendor${n}_rate`]: +e.target.value})} />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className="label">Final Rate <span className="text-gray-400 text-[10px]">(auto from selected vendor)</span></label><input className="input" type="number" value={form.final_rate || 0} onChange={e => setForm({...form, final_rate: +e.target.value})} /></div>
            <div>
              <label className="label">Selected Vendor</label>
              <SearchableSelect
                options={vendors}
                value={form.selected_vendor_id || null}
                valueKey="id" displayKey="name"
                placeholder="Search vendor…"
                onChange={(v) => {
                  // Auto-fill Final Rate from the chosen vendor's quoted rate
                  // (one of the 3 above). Still editable for a negotiated rate.
                  const id = v?.id || '';
                  let fr = form.final_rate;
                  for (const n of [1, 2, 3]) {
                    if (id && String(form[`vendor${n}_id`]) === String(id)) { fr = +form[`vendor${n}_rate`] || 0; break; }
                  }
                  setForm({ ...form, selected_vendor_id: id, final_rate: fr });
                }}
              />
            </div>
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Save</button></div>
        </form>
      </Modal>
    </div>
  );
}
