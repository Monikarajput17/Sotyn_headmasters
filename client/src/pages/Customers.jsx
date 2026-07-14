import { useState, useEffect, useRef } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiEdit2, FiSearch, FiEye, FiTrash2, FiUpload, FiUsers, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';

const CATEGORIES = ['FF', 'ELE', 'LV', 'Solar', 'HVAC', 'INTERIOR', 'Govt', 'Private', 'OTHER'];
const CAT_COLORS = {
  FF: 'bg-red-100 text-red-700',
  ELE: 'bg-amber-100 text-amber-700',
  LV: 'bg-red-100 text-red-700',
  Solar: 'bg-emerald-100 text-emerald-700',
  HVAC: 'bg-cyan-100 text-cyan-700',
  INTERIOR: 'bg-purple-100 text-purple-700',
  Govt: 'bg-red-100 text-red-700',
  Private: 'bg-pink-100 text-pink-700',
};

export default function Customers() {
  const { canCreate, canEdit, canDelete } = useAuth();
  const [customers, setCustomers] = useState([]);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [viewData, setViewData] = useState(null);
  const [form, setForm] = useState({});
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  const load = () => api.get('/customers').then(r => setCustomers(r.data)).catch(() => setCustomers([]));
  useEffect(() => { load(); }, []);

  const save = async (e) => {
    e.preventDefault();
    try {
      if (editing) await api.put(`/customers/${editing.id}`, form);
      else await api.post('/customers', form);
      toast.success(editing ? 'Updated' : 'Created');
      setModal(false); setEditing(null); setForm({}); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Error'); }
  };

  const remove = async (c) => {
    if (!confirm(`Delete customer "${c.company_name}"?`)) return;
    try {
      await api.delete(`/customers/${c.id}`);
      toast.success('Deleted'); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Error'); }
  };

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    setUploading(true);
    try {
      const { data } = await api.post('/customers/bulk-import', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(`Imported ${data.added} customers${data.errors?.length ? ` (${data.errors.length} errors)` : ''}`);
      if (data.errors?.length) console.warn('Import errors:', data.errors);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Import failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const filtered = customers.filter(c => {
    if (filterCat && c.category !== filterCat) return false;
    if (search) {
      const q = search.toLowerCase();
      const hit = [c.company_name, c.sub_company_name, c.customer_code, c.contact_no, c.email, c.concern_person_name]
        .some(v => String(v || '').toLowerCase().includes(q));
      if (!hit) return false;
    }
    return true;
  });

  const catCounts = {};
  customers.forEach(c => { if (c.category) catCounts[c.category] = (catCounts[c.category] || 0) + 1; });

  const openAdd = () => { setEditing(null); setForm({}); setModal('form'); };
  const openEdit = (c) => { setEditing(c); setForm({ ...c }); setModal('form'); };

  return (
    <div className="space-y-4">
      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card p-3">
          <div className="flex items-center gap-2 text-gray-500 text-xs"><FiUsers size={14} /> Total Customers</div>
          <div className="text-2xl font-bold text-gray-800 mt-1">{customers.length}</div>
        </div>
        {Object.entries(catCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([cat, count]) => (
          <div key={cat} className="card p-3">
            <div className="flex items-center gap-2 text-gray-500 text-xs">
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${CAT_COLORS[cat] || 'bg-gray-100'}`}>{cat}</span>
            </div>
            <div className="text-2xl font-bold text-gray-800 mt-1">{count}</div>
          </div>
        ))}
      </div>

      {/* Category filter chips */}
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setFilterCat('')} className={`px-3 py-1 rounded-full text-xs font-semibold border ${!filterCat ? 'bg-red-600 text-white' : 'bg-white text-gray-600 border-gray-200'}`}>All ({customers.length})</button>
        {Object.entries(catCounts).sort((a, b) => b[1] - a[1]).map(([cat, count]) => (
          <button key={cat} onClick={() => setFilterCat(filterCat === cat ? '' : cat)} className={`px-3 py-1 rounded-full text-xs font-semibold border ${filterCat === cat ? 'bg-red-600 text-white' : 'bg-white text-gray-600 border-gray-200'}`}>{cat} ({count})</button>
        ))}
      </div>

      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
          <input className="input pl-10" placeholder="Search company, code, contact, concern person..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="select max-w-[180px]" value={filterCat} onChange={e => setFilterCat(e.target.value)}>
          <option value="">All Categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        {canCreate('customers') && (
          <>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleUpload} />
            <button onClick={() => fileRef.current?.click()} disabled={uploading} className="btn btn-secondary flex items-center gap-2 text-sm">
              <FiUpload size={15} /> {uploading ? 'Importing...' : 'Excel Import'}
            </button>
            <button onClick={() => exportCsv('customers',
              ['Code','Category','Company','Sub Company','Address','Contact','Email','Concern Person','Concern Email'],
              filtered.map(c => [c.customer_code, c.category, c.company_name, c.sub_company_name, c.company_registration_address, c.contact_no, c.email, c.concern_person_name, c.concern_person_email]))}
              className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload size={15} /> Export Excel</button>
            <button onClick={openAdd} className="btn btn-primary flex items-center gap-2 text-sm"><FiPlus size={15} /> New Customer</button>
          </>
        )}
      </div>

      <p className="text-sm text-gray-500">Showing {filtered.length} customer{filtered.length === 1 ? '' : 's'}</p>

      <div className="card p-0">
        <div>
          <table className="min-w-[1100px] text-xs w-full freeze-head">
            <thead>
              <tr className="bg-gray-50">
                <th className="px-2 py-2 text-left">Customer Code</th>
                <th className="px-2 py-2 text-left">Company Name</th>
                <th className="px-2 py-2 text-left">Sub Company</th>
                <th className="px-2 py-2">Category</th>
                <th className="px-2 py-2">Contact No</th>
                <th className="px-2 py-2 text-left">Email</th>
                <th className="px-2 py-2 text-left">Concern Person</th>
                <th className="px-2 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.id} className="border-b hover:bg-red-50/30">
                  <td className="px-2 py-2 font-mono text-[10px] text-red-600">{c.customer_code || '-'}</td>
                  <td className="px-2 py-2"><div className="font-semibold">{c.company_name}</div></td>
                  <td className="px-2 py-2 text-[11px]">{c.sub_company_name || '-'}</td>
                  <td className="px-2 py-2 text-center">
                    {c.category ? <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${CAT_COLORS[c.category] || 'bg-gray-100'}`}>{c.category}</span> : '-'}
                  </td>
                  <td className="px-2 py-2 text-[11px]">{c.contact_no || '-'}</td>
                  <td className="px-2 py-2 text-[11px]">{c.email || '-'}</td>
                  <td className="px-2 py-2 text-[11px]">{c.concern_person_name || '-'}</td>
                  <td className="px-2 py-2">
                    <div className="flex gap-1 justify-center">
                      <button onClick={() => { setViewData(c); setModal('view'); }} className="p-1 text-gray-400 hover:text-red-600"><FiEye size={14} /></button>
                      {canEdit('customers') && <button onClick={() => openEdit(c)} className="p-1 text-gray-400 hover:text-amber-600"><FiEdit2 size={14} /></button>}
                      {canDelete('customers') && <button onClick={() => remove(c)} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan="8" className="text-center py-8 text-gray-400">No customers found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* View Modal */}
      <Modal isOpen={modal === 'view'} onClose={() => { setModal(false); setViewData(null); }} title={viewData?.company_name} wide>
        {viewData && (
          <div className="space-y-3 text-sm">
            <div className="flex gap-2 items-center">
              <span className="font-mono text-xs text-red-600">{viewData.customer_code}</span>
              {viewData.category && <span className={`text-xs px-2 py-0.5 rounded font-medium ${CAT_COLORS[viewData.category] || 'bg-gray-100'}`}>{viewData.category}</span>}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div><span className="text-gray-400 text-xs">Sub Company:</span><br/><span className="font-medium">{viewData.sub_company_name || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Contact No:</span><br/><span className="font-medium">{viewData.contact_no || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Email:</span><br/><span className="font-medium">{viewData.email || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Concern Person:</span><br/><span className="font-medium">{viewData.concern_person_name || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Concern Person Email:</span><br/><span className="font-medium">{viewData.concern_person_email || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Concern Person Address:</span><br/><span className="font-medium">{viewData.concern_person_address || '-'}</span></div>
              <div className="col-span-2"><span className="text-gray-400 text-xs">Company Registration Address:</span><br/><span className="font-medium">{viewData.company_registration_address || '-'}</span></div>
            </div>
          </div>
        )}
      </Modal>

      {/* Add/Edit Modal */}
      <Modal isOpen={modal === 'form'} onClose={() => { setModal(false); setEditing(null); }} title={editing ? 'Edit Customer' : 'New Customer'} wide>
        <form onSubmit={save} className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {editing && (
              <div>
                <label className="label">Customer Code</label>
                <input className="input bg-gray-100 font-mono" value={editing.customer_code || ''} readOnly />
              </div>
            )}
            <div>
              <label className="label">Category</label>
              <select className="select" value={form.category || ''} onChange={e => setForm({ ...form, category: e.target.value })}>
                <option value="">Select</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className={editing ? '' : 'col-span-2'}>
              <label className="label">Company Name *</label>
              <input className="input" value={form.company_name || ''} onChange={e => setForm({ ...form, company_name: e.target.value })} required />
            </div>
            <div className="col-span-2">
              <label className="label">Sub Company Name</label>
              <input className="input" value={form.sub_company_name || ''} onChange={e => setForm({ ...form, sub_company_name: e.target.value })} />
            </div>
            <div className="col-span-2">
              <label className="label">Company Registration Address</label>
              <textarea className="input" rows="2" value={form.company_registration_address || ''} onChange={e => setForm({ ...form, company_registration_address: e.target.value })} />
            </div>
            <div>
              <label className="label">Contact No</label>
              <input className="input" value={form.contact_no || ''} onChange={e => setForm({ ...form, contact_no: e.target.value })} />
            </div>
            <div>
              <label className="label">Email</label>
              <input className="input" type="email" value={form.email || ''} onChange={e => setForm({ ...form, email: e.target.value })} />
            </div>
            <div>
              <label className="label">Concern Person Name</label>
              <input className="input" value={form.concern_person_name || ''} onChange={e => setForm({ ...form, concern_person_name: e.target.value })} />
            </div>
            <div>
              <label className="label">Concern Person Email</label>
              <input className="input" type="email" value={form.concern_person_email || ''} onChange={e => setForm({ ...form, concern_person_email: e.target.value })} />
            </div>
            <div className="col-span-2">
              <label className="label">Concern Person Address</label>
              <textarea className="input" rows="2" value={form.concern_person_address || ''} onChange={e => setForm({ ...form, concern_person_address: e.target.value })} />
            </div>
          </div>
          {!editing && (
            <p className="text-xs text-gray-500">Customer code will be auto-generated on save.</p>
          )}
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => { setModal(false); setEditing(null); }} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
