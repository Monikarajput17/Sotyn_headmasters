// Company Assets — laptop / mobile / SIM / monitor / etc. register
// with issue / return / maintenance / scrap actions and full history.
// Mam: 'add also system company assets like laptop, sim, phone etc
// for maintain record'.

import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiMonitor, FiSmartphone, FiCpu, FiUserPlus, FiCornerUpLeft, FiTool, FiArchive, FiTrash2, FiEdit2, FiSearch, FiClock, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { fmtDateTime } from '../utils/datetime';

const CATEGORIES = [
  'Laptop', 'Desktop', 'Mobile', 'Tablet', 'SIM Card',
  'Headset', 'Monitor', 'Keyboard', 'Mouse', 'Charger',
  'Printer', 'Router', 'Hard Drive', 'USB Drive', 'Camera',
  'Projector', 'Speaker', 'ID Card', 'Other'
];

const STATUSES = ['available', 'issued', 'maintenance', 'lost', 'scrapped'];
const STATUS_PILL = {
  available: 'bg-emerald-100 text-emerald-700',
  issued: 'bg-blue-100 text-blue-700',
  maintenance: 'bg-amber-100 text-amber-700',
  lost: 'bg-red-100 text-red-700',
  scrapped: 'bg-gray-200 text-gray-600',
};
const CONDITION_PILL = {
  new: 'bg-emerald-50 text-emerald-700 border-emerald-300',
  good: 'bg-blue-50 text-blue-700 border-blue-300',
  fair: 'bg-amber-50 text-amber-700 border-amber-300',
  poor: 'bg-orange-50 text-orange-700 border-orange-300',
  damaged: 'bg-red-50 text-red-700 border-red-300',
  scrap: 'bg-gray-100 text-gray-500 border-gray-300',
};

const fmtRs = (n) => `Rs ${(Math.round(n || 0)).toLocaleString('en-IN')}`;

export default function CompanyAssets() {
  const { canCreate, canEdit, canDelete, isAdmin } = useAuth();
  const [assets, setAssets] = useState([]);
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [filters, setFilters] = useState({ category: '', status: '', search: '' });
  const [modal, setModal] = useState(null); // 'edit' | 'issue' | 'return' | 'maintenance' | 'scrap' | 'history'
  const [form, setForm] = useState({});
  const [actionAsset, setActionAsset] = useState(null);
  const [actionForm, setActionForm] = useState({});
  const [history, setHistory] = useState([]);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
    api.get(`/company-assets?${params}`).then(r => setAssets(r.data || [])).catch(() => {});
    api.get('/company-assets/stats').then(r => setStats(r.data)).catch(() => {});
  }, [filters]);

  useEffect(() => {
    load();
    api.get('/auth/users').then(r => setUsers((r.data || []).filter(u => u.active !== 0))).catch(() => {});
    api.get('/procurement/vendors').then(r => setVendors(r.data || [])).catch(() => {});
  }, [load]);

  const upload = async (file) => {
    if (!file) return null;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      return r.data.url;
    } catch (err) {
      toast.error(`Upload failed: ${err.response?.data?.error || err.message}`);
      return null;
    } finally { setUploading(false); }
  };

  const openAdd = () => { setForm({ condition: 'good', status: 'available', monthly_cost: 0 }); setModal('edit'); };
  const openEdit = (a) => { setForm({ ...a }); setModal('edit'); };

  const save = async (e) => {
    e.preventDefault();
    if (!form.name?.trim()) return toast.error('Name is required');
    try {
      if (form.id) {
        await api.put(`/company-assets/${form.id}`, form);
        toast.success('Updated');
      } else {
        const r = await api.post('/company-assets', form);
        toast.success(`Added ${r.data.asset_no}`);
      }
      setModal(null); setForm({}); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const openAction = (a, type) => {
    setActionAsset(a); setActionForm({}); setModal(type);
  };

  const doAction = async (e) => {
    e.preventDefault();
    try {
      let payload = { notes: actionForm.notes || '' };
      let endpoint = '';
      if (modal === 'issue') {
        if (!actionForm.user_id) return toast.error('Pick employee');
        payload.user_id = actionForm.user_id;
        endpoint = 'issue';
      } else if (modal === 'return') {
        payload.condition = actionForm.condition || actionAsset.condition;
        endpoint = 'return';
      } else if (modal === 'maintenance') endpoint = 'maintenance';
      else if (modal === 'scrap') {
        payload.lost = !!actionForm.lost;
        endpoint = 'scrap';
      }
      const r = await api.post(`/company-assets/${actionAsset.id}/${endpoint}`, payload);
      toast.success(r.data.message || 'Done');
      setModal(null); setActionAsset(null); setActionForm({}); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const remove = async (a) => {
    if (!confirm(`Delete ${a.asset_no} (${a.name})?`)) return;
    try { await api.delete(`/company-assets/${a.id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
  };

  const showHistory = async (a) => {
    try {
      const r = await api.get(`/company-assets/${a.id}`);
      setActionAsset(a);
      setHistory(r.data.movements || []);
      setModal('history');
    } catch (err) { toast.error('Failed to load history'); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FiCpu className="text-indigo-600" /> Company Assets</h1>
          <p className="text-sm text-gray-500">Laptops, phones, SIMs, monitors and other company equipment — issue, return, maintenance log.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => exportCsv('company-assets',
            ['Asset #','Category','Name/Model','Serial/IMEI','SIM/Mobile','Issued To','Condition','Status'],
            assets.map(a => [a.asset_no, a.category, a.name, a.serial_imei, a.sim_mobile, a.issued_to_name, a.condition, a.status]))}
            className="btn btn-secondary flex items-center gap-1 text-sm"><FiDownload size={14} /> Export Excel</button>
          {canCreate('company_assets') && (
            <button onClick={openAdd} className="btn btn-primary flex items-center gap-1"><FiPlus size={14} /> Add Asset</button>
          )}
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <div className="card p-3 border-l-4 border-emerald-500"><p className="text-xs text-gray-500">Available</p><p className="text-2xl font-bold text-emerald-600">{stats.available}</p></div>
          <div className="card p-3 border-l-4 border-blue-500"><p className="text-xs text-gray-500">Issued</p><p className="text-2xl font-bold text-blue-600">{stats.issued}</p></div>
          <div className="card p-3 border-l-4 border-amber-500"><p className="text-xs text-gray-500">In Maintenance</p><p className="text-2xl font-bold text-amber-600">{stats.maintenance}</p></div>
          <div className="card p-3 border-l-4 border-red-500"><p className="text-xs text-gray-500">Lost / Scrapped</p><p className="text-2xl font-bold text-red-700">{(stats.lost || 0) + (stats.scrapped || 0)}</p></div>
          <div className="card p-3 border-l-4 border-purple-500"><p className="text-xs text-gray-500">Asset Value</p><p className="text-base font-bold text-purple-700">{fmtRs(stats.total_value)}</p></div>
          <div className="card p-3 border-l-4 border-orange-500"><p className="text-xs text-gray-500">Monthly Recurring</p><p className="text-base font-bold text-orange-700">{fmtRs(stats.monthly_recurring)}</p><p className="text-[9px] text-gray-400">SIM / subscription</p></div>
        </div>
      )}

      <div className="card p-3 flex flex-wrap items-end gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
          <input className="input pl-9 text-sm" placeholder="Search asset #, name, brand, serial, mobile…" value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} />
        </div>
        <div>
          <label className="label">Category</label>
          <select className="select" value={filters.category} onChange={e => setFilters(f => ({ ...f, category: e.target.value }))}>
            <option value="">All</option>
            {CATEGORIES.map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Status</label>
          <select className="select" value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}>
            <option value="">All</option>
            {STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
        </div>
      </div>

      <div className="card p-0">
        <table className="freeze-head">
          <thead>
            <tr>
              <th>Asset No</th><th>Category</th><th>Name / Model</th>
              <th>Serial / IMEI</th><th>SIM / Mobile</th>
              <th>Issued To</th><th>Condition</th><th>Status</th>
              <th className="text-right">Value</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {assets.length === 0 && (
              <tr><td colSpan="10" className="text-center py-8 text-gray-400">No assets yet — click "Add Asset" to start the register</td></tr>
            )}
            {assets.map(a => (
              <tr key={a.id}>
                <td className="font-bold text-indigo-700 text-xs">{a.asset_no}</td>
                <td className="text-xs">{a.category || <span className="text-gray-300">—</span>}</td>
                <td className="text-xs">
                  <div className="font-medium">{a.name}</div>
                  {(a.brand || a.model) && <div className="text-[10px] text-gray-500">{[a.brand, a.model].filter(Boolean).join(' · ')}</div>}
                </td>
                <td className="text-xs">
                  {a.serial_no && <div>{a.serial_no}</div>}
                  {a.imei && <div className="text-[10px] text-gray-500">IMEI: {a.imei}</div>}
                  {a.ip_address && <div className="text-[10px] text-blue-600">IP: {a.ip_address}</div>}
                  {!a.serial_no && !a.imei && !a.ip_address && <span className="text-gray-300">—</span>}
                </td>
                <td className="text-xs">
                  {a.mobile_number && <div>{a.mobile_number}</div>}
                  {a.carrier && <div className="text-[10px] text-gray-500">{a.carrier}</div>}
                  {!a.mobile_number && !a.carrier && <span className="text-gray-300">—</span>}
                </td>
                <td className="text-xs">{a.current_user_live_name || a.current_user_name || <span className="text-gray-300">—</span>}</td>
                <td><span className={`text-[10px] px-2 py-0.5 rounded font-bold border ${CONDITION_PILL[a.condition] || ''}`}>{a.condition}</span></td>
                <td><span className={`text-[10px] px-2 py-0.5 rounded font-bold ${STATUS_PILL[a.status] || ''}`}>{a.status?.replace('_', ' ')}</span></td>
                <td className="text-right text-xs">{a.purchase_price > 0 ? fmtRs(a.purchase_price) : '—'}</td>
                <td className="whitespace-nowrap">
                  {canEdit('company_assets') && a.status === 'available' && (
                    <button onClick={() => openAction(a, 'issue')} className="btn btn-primary text-[10px] px-2 py-1 mr-1" title="Issue to employee"><FiUserPlus size={11} className="inline" /> Issue</button>
                  )}
                  {canEdit('company_assets') && a.status === 'issued' && (
                    <button onClick={() => openAction(a, 'return')} className="btn btn-success text-[10px] px-2 py-1 mr-1" title="Return"><FiCornerUpLeft size={11} className="inline" /> Return</button>
                  )}
                  {canEdit('company_assets') && a.status !== 'lost' && a.status !== 'scrapped' && (
                    <button onClick={() => openAction(a, 'maintenance')} className="p-1 text-amber-600 hover:text-amber-800" title="Maintenance"><FiTool size={12} /></button>
                  )}
                  {canEdit('company_assets') && a.status !== 'scrapped' && (
                    <button onClick={() => openAction(a, 'scrap')} className="p-1 text-gray-400 hover:text-red-600" title="Scrap / Lost"><FiArchive size={12} /></button>
                  )}
                  <button onClick={() => showHistory(a)} className="p-1 text-gray-400 hover:text-blue-600" title="History"><FiClock size={12} /></button>
                  {(canEdit('company_assets') || isAdmin()) && (
                    <button onClick={() => openEdit(a)} className="p-1 text-gray-400 hover:text-blue-600" title="Edit"><FiEdit2 size={12} /></button>
                  )}
                  {canDelete('company_assets') && (
                    <button onClick={() => remove(a)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={12} /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ADD / EDIT MODAL */}
      <Modal isOpen={modal === 'edit'} onClose={() => { setModal(null); setForm({}); }} title={form.id ? `Edit ${form.asset_no}` : 'Add Asset'} wide>
        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Category</label>
              <select className="select" value={form.category || ''} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
                <option value="">— pick —</option>
                {CATEGORIES.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div><label className="label">Name *</label><input className="input" required value={form.name || ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Dell Latitude 5420" /></div>
            <div><label className="label">Brand</label><input className="input" value={form.brand || ''} onChange={e => setForm(f => ({ ...f, brand: e.target.value }))} placeholder="Dell / HP / Apple…" /></div>
            <div><label className="label">Model</label><input className="input" value={form.model || ''} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} placeholder="e.g. Latitude 5420 i5" /></div>
            <div>
              {/* Label adapts to category — clearer for the user */}
              <label className="label">
                {form.category === 'SIM Card' ? 'SIM Number / ICCID'
                  : form.category === 'Mobile' || form.category === 'Tablet' ? 'Serial Number'
                  : 'Serial Number'}
              </label>
              <input className="input" value={form.serial_no || ''} onChange={e => setForm(f => ({ ...f, serial_no: e.target.value }))} placeholder={form.category === 'SIM Card' ? '89910...' : 'Manufacturer serial'} />
            </div>
            <div>
              <label className="label">Condition</label>
              <select className="select" value={form.condition || 'good'} onChange={e => setForm(f => ({ ...f, condition: e.target.value }))}>
                {['new','good','fair','poor','damaged','scrap'].map(c => <option key={c}>{c}</option>)}
              </select>
            </div>

            {/* IP Address — only for IT / network gear (laptops, desktops,
                monitors, routers, printers). Mam: 'if laptop select the
                laptop name ip address'. */}
            {['Laptop','Desktop','Monitor','Router','Printer'].includes(form.category) && (
              <div className="col-span-2">
                <label className="label">IP Address <span className="text-gray-400 font-normal text-[10px]">(optional)</span></label>
                <input className="input" value={form.ip_address || ''} onChange={e => setForm(f => ({ ...f, ip_address: e.target.value }))} placeholder="e.g. 192.168.1.45" />
              </div>
            )}

            {/* IMEI — separate from serial for Mobile/Tablet (these have
                BOTH a serial AND an IMEI). Mam: 'if sim then number and
                imei number'. */}
            {(form.category === 'Mobile' || form.category === 'Tablet') && (
              <div className="col-span-2">
                <label className="label">IMEI Number</label>
                <input className="input" value={form.imei || ''} onChange={e => setForm(f => ({ ...f, imei: e.target.value }))} placeholder="15-digit IMEI" />
              </div>
            )}

            {/* SIM / mobile-specific fields appear when category is SIM Card or Mobile */}
            {(form.category === 'SIM Card' || form.category === 'Mobile') && (
              <>
                <div><label className="label">Mobile Number</label><input className="input" value={form.mobile_number || ''} onChange={e => setForm(f => ({ ...f, mobile_number: e.target.value }))} placeholder="98XX-XXXXXX" /></div>
                <div>
                  <label className="label">Carrier</label>
                  <select className="select" value={form.carrier || ''} onChange={e => setForm(f => ({ ...f, carrier: e.target.value }))}>
                    <option value="">— pick —</option>
                    <option>Jio</option><option>Airtel</option><option>Vi</option><option>BSNL</option><option>Other</option>
                  </select>
                </div>
                <div className="col-span-2"><label className="label">Monthly Recharge / Plan (Rs)</label><input type="number" className="input" value={form.monthly_cost || 0} onChange={e => setForm(f => ({ ...f, monthly_cost: +e.target.value }))} /></div>
              </>
            )}

            <div className="col-span-2 border-t pt-3 mt-1"><h5 className="font-bold text-sm">Purchase</h5></div>
            <div><label className="label">Purchase Date</label><input type="date" className="input" value={form.purchase_date || ''} onChange={e => setForm(f => ({ ...f, purchase_date: e.target.value }))} /></div>
            <div><label className="label">Purchase Price (Rs)</label><input type="number" className="input" value={form.purchase_price || 0} onChange={e => setForm(f => ({ ...f, purchase_price: +e.target.value }))} /></div>
            <div><label className="label">Vendor</label><input className="input" list="caVendorsDL" value={form.vendor || ''} onChange={e => setForm(f => ({ ...f, vendor: e.target.value }))} placeholder="Pick vendor or type" /><datalist id="caVendorsDL">{vendors.map(v => <option key={v.id} value={v.name} />)}</datalist></div>
            <div><label className="label">Warranty Till</label><input type="date" className="input" value={form.warranty_till || ''} onChange={e => setForm(f => ({ ...f, warranty_till: e.target.value }))} /></div>

            <div className="col-span-2 border-t pt-3 mt-1"><h5 className="font-bold text-sm">Assignment</h5></div>
            <div>
              <label className="label">Issued To <span className="text-gray-400 font-normal text-[10px]">(optional)</span></label>
              <SearchableSelect
                options={users.map(u => ({ ...u, label: u.name + (u.department ? ` — ${u.department}` : '') }))}
                value={form.current_user_id || null}
                valueKey="id"
                displayKey="label"
                placeholder="Pick employee…"
                onChange={(u) => setForm(f => ({ ...f, current_user_id: u?.id || '', current_user_name: u?.name || '', status: u?.id ? 'issued' : (f.status === 'issued' ? 'available' : f.status) }))}
              />
            </div>
            <div>
              <label className="label">Status</label>
              <select className="select" value={form.status || 'available'} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                {STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
              </select>
            </div>

            <div className="col-span-2">
              <label className="label">Photo</label>
              {form.photo_url ? (
                <div className="flex items-start gap-3">
                  <img src={form.photo_url} alt="" className="w-24 h-24 object-cover rounded border" />
                  <button type="button" onClick={() => setForm(f => ({ ...f, photo_url: '' }))} className="text-red-500 text-xs">Remove</button>
                </div>
              ) : (
                <input type="file" accept="image/*" className="text-xs" onChange={async e => {
                  const url = await upload(e.target.files?.[0]); if (url) setForm(f => ({ ...f, photo_url: url }));
                  e.target.value = '';
                }} />
              )}
            </div>
            <div className="col-span-2"><label className="label">Notes</label><textarea className="input" rows="2" value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></div>
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t">
            <button type="button" onClick={() => { setModal(null); setForm({}); }} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={uploading} className="btn btn-primary">{uploading ? 'Uploading…' : (form.id ? 'Save' : 'Add Asset')}</button>
          </div>
        </form>
      </Modal>

      {/* ACTION MODAL — issue / return / maintenance / scrap */}
      <Modal isOpen={['issue','return','maintenance','scrap'].includes(modal)} onClose={() => { setModal(null); setActionAsset(null); setActionForm({}); }} title={actionAsset && modal ? `${modal.charAt(0).toUpperCase() + modal.slice(1)} — ${actionAsset.name}` : ''}>
        {actionAsset && (
          <form onSubmit={doAction} className="space-y-3">
            <div className="bg-gray-50 p-3 rounded text-xs">
              <div><b>{actionAsset.asset_no}</b> · {actionAsset.category || '—'}</div>
              {actionAsset.serial_no && <div>SN: {actionAsset.serial_no}</div>}
              {actionAsset.current_user_name && <div>Currently with: <b>{actionAsset.current_user_name}</b></div>}
            </div>

            {modal === 'issue' && (
              <div>
                <label className="label">Issue To *</label>
                <SearchableSelect
                  options={users.map(u => ({ ...u, label: u.name + (u.department ? ` — ${u.department}` : '') }))}
                  value={actionForm.user_id || null}
                  valueKey="id"
                  displayKey="label"
                  placeholder="Pick employee…"
                  onChange={(u) => setActionForm(f => ({ ...f, user_id: u?.id || '' }))}
                />
              </div>
            )}

            {modal === 'return' && (
              <div>
                <label className="label">Condition on Return</label>
                <select className="select" value={actionForm.condition || actionAsset.condition || 'good'} onChange={e => setActionForm(f => ({ ...f, condition: e.target.value }))}>
                  {['new','good','fair','poor','damaged'].map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
            )}

            {modal === 'scrap' && (
              <div>
                <label className="label">Reason</label>
                <select className="select" value={actionForm.lost ? 'lost' : 'scrap'} onChange={e => setActionForm(f => ({ ...f, lost: e.target.value === 'lost' }))}>
                  <option value="scrap">Scrap (end of life)</option>
                  <option value="lost">Lost / Stolen</option>
                </select>
              </div>
            )}

            <div>
              <label className="label">Notes</label>
              <textarea className="input" rows="2" value={actionForm.notes || ''} onChange={e => setActionForm(f => ({ ...f, notes: e.target.value }))} />
            </div>

            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => { setModal(null); setActionAsset(null); setActionForm({}); }} className="btn btn-secondary">Cancel</button>
              <button type="submit" className={`btn ${modal === 'scrap' ? 'btn-danger' : modal === 'return' ? 'btn-success' : 'btn-primary'}`}>{modal.charAt(0).toUpperCase() + modal.slice(1)}</button>
            </div>
          </form>
        )}
      </Modal>

      {/* HISTORY MODAL */}
      <Modal isOpen={modal === 'history'} onClose={() => { setModal(null); setActionAsset(null); setHistory([]); }} title={actionAsset ? `History — ${actionAsset.asset_no}` : ''} wide>
        {actionAsset && (
          <div className="space-y-2">
            {history.length === 0 && <p className="text-gray-400 text-sm">No movements yet.</p>}
            {history.map(m => (
              <div key={m.id} className="border rounded p-2 text-xs">
                <div className="flex justify-between">
                  <span className={`font-bold uppercase text-[10px] px-2 py-0.5 rounded ${
                    m.movement_type === 'issue' ? 'bg-blue-100 text-blue-700' :
                    m.movement_type === 'return' ? 'bg-emerald-100 text-emerald-700' :
                    m.movement_type === 'maintenance' ? 'bg-amber-100 text-amber-700' :
                    'bg-red-100 text-red-700'
                  }`}>{m.movement_type}</span>
                  <span className="text-gray-500">{m.performed_at ? fmtDateTime(m.performed_at) : '—'}</span>
                </div>
                <div className="mt-1 text-gray-700">
                  {m.from_user_name && <span>From: <b>{m.from_user_name}</b> </span>}
                  {m.to_user_name && <span>→ <b>{m.to_user_name}</b></span>}
                </div>
                {m.notes && <div className="text-gray-500 italic mt-1">↳ {m.notes}</div>}
                <div className="text-[10px] text-gray-400 mt-1">By {m.performed_by_name || '—'}</div>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
