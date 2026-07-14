import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiEdit2, FiTrash2, FiSearch, FiScissors, FiClock, FiTag } from 'react-icons/fi';

const M = 'salon_services';

export default function SalonServices() {
  const { canCreate, canEdit, canDelete } = useAuth();
  const [services, setServices] = useState([]);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [modal, setModal] = useState(false);
  const [catModal, setCatModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [catForm, setCatForm] = useState({ name: '', sort_order: 0 });

  const load = async () => {
    try {
      const [s, c] = await Promise.all([
        api.get('/salon/services', { params: { search, category_id: catFilter } }),
        api.get('/salon/services/categories'),
      ]);
      setServices(s.data); setCategories(c.data);
    } catch { toast.error('Failed to load services'); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [search, catFilter]);

  const openNew = () => { setEditing(null); setForm({ duration_min: 30, price: 0, active: 1, category_id: categories[0]?.id || '' }); setModal(true); };
  const openEdit = (s) => { setEditing(s); setForm({ ...s }); setModal(true); };

  const save = async () => {
    if (!form.name?.trim()) return toast.error('Service name required');
    try {
      if (editing) await api.put(`/salon/services/${editing.id}`, form);
      else await api.post('/salon/services', form);
      toast.success(editing ? 'Service updated' : 'Service added');
      setModal(false); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };
  const del = async (s) => {
    if (!confirm(`Delete "${s.name}"?`)) return;
    try { await api.delete(`/salon/services/${s.id}`); toast.success('Deleted'); load(); }
    catch { toast.error('Delete failed'); }
  };
  const saveCat = async () => {
    if (!catForm.name?.trim()) return toast.error('Category name required');
    try { await api.post('/salon/services/categories', catForm); toast.success('Category added'); setCatModal(false); setCatForm({ name: '', sort_order: 0 }); load(); }
    catch { toast.error('Save failed'); }
  };

  const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2"><FiScissors className="text-blue-700" /> Service Menu</h1>
          <p className="text-sm text-gray-500">Your salon's price list — {services.length} services</p>
        </div>
        <div className="flex gap-2">
          {canCreate(M) && <button onClick={() => setCatModal(true)} className="px-3 py-2 rounded-lg border border-blue-300 text-blue-800 hover:bg-blue-50 text-sm font-medium flex items-center gap-1.5"><FiTag /> Category</button>}
          {canCreate(M) && <button onClick={openNew} className="px-3 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-sm font-medium flex items-center gap-1.5"><FiPlus /> New Service</button>}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search services…" className="w-full pl-9 pr-3 py-2 border rounded-lg text-sm" />
        </div>
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)} className="px-3 py-2 border rounded-lg text-sm">
          <option value="">All categories</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-3">Service</th>
                <th className="text-left px-4 py-3">Category</th>
                <th className="text-left px-4 py-3"><FiClock className="inline" /> Duration</th>
                <th className="text-right px-4 py-3">Price</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {services.map(s => (
                <tr key={s.id} className="hover:bg-blue-50/40">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-800">{s.name}</div>
                    {s.code && <div className="text-xs text-gray-400">{s.code}</div>}
                    {!s.active ? <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">inactive</span> : null}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{s.category_name || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{s.duration_min} min</td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-800">{money(s.price)}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {canEdit(M) && <button onClick={() => openEdit(s)} className="p-1.5 text-gray-400 hover:text-blue-700" title="Edit"><FiEdit2 /></button>}
                    {canDelete(M) && <button onClick={() => del(s)} className="p-1.5 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 /></button>}
                  </td>
                </tr>
              ))}
              {!services.length && <tr><td colSpan={5} className="px-4 py-10 text-center text-gray-400">No services yet</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <Modal isOpen={modal} onClose={() => setModal(false)} title={editing ? 'Edit Service' : 'New Service'}>
        <div className="space-y-3">
          <Field label="Service name"><input value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} className="inp" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category">
              <select value={form.category_id || ''} onChange={e => setForm({ ...form, category_id: e.target.value })} className="inp">
                <option value="">—</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Code"><input value={form.code || ''} onChange={e => setForm({ ...form, code: e.target.value })} className="inp" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Duration (min)"><input type="number" value={form.duration_min ?? 30} onChange={e => setForm({ ...form, duration_min: +e.target.value })} className="inp" /></Field>
            <Field label="Price (₹)"><input type="number" value={form.price ?? 0} onChange={e => setForm({ ...form, price: +e.target.value })} className="inp" /></Field>
          </div>
          <Field label="Description"><textarea value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} className="inp" rows={2} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active !== 0} onChange={e => setForm({ ...form, active: e.target.checked ? 1 : 0 })} /> Active</label>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setModal(false)} className="px-4 py-2 rounded-lg border text-sm">Cancel</button>
            <button onClick={save} className="px-4 py-2 rounded-lg bg-blue-700 text-white text-sm font-medium">{editing ? 'Update' : 'Add'}</button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={catModal} onClose={() => setCatModal(false)} title="New Category">
        <div className="space-y-3">
          <Field label="Category name"><input value={catForm.name} onChange={e => setCatForm({ ...catForm, name: e.target.value })} className="inp" /></Field>
          <Field label="Sort order"><input type="number" value={catForm.sort_order} onChange={e => setCatForm({ ...catForm, sort_order: +e.target.value })} className="inp" /></Field>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setCatModal(false)} className="px-4 py-2 rounded-lg border text-sm">Cancel</button>
            <button onClick={saveCat} className="px-4 py-2 rounded-lg bg-blue-700 text-white text-sm font-medium">Add</button>
          </div>
        </div>
      </Modal>
      <style>{`.inp{width:100%;border:1px solid #e5e7eb;border-radius:.5rem;padding:.5rem .75rem;font-size:.875rem;outline:none}.inp:focus{border-color:#1d4ed8;box-shadow:0 0 0 2px rgba(29,78,216,.15)}`}</style>
    </div>
  );
}

function Field({ label, children }) {
  return <label className="block"><span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{label}</span><div className="mt-1">{children}</div></label>;
}
