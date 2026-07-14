import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiEdit2, FiTrash2, FiSearch, FiUser, FiPhone, FiPercent } from 'react-icons/fi';

const M = 'salon_stylists';

export default function SalonStylists() {
  const { canCreate, canEdit, canDelete } = useAuth();
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});

  const load = async () => {
    try { const { data } = await api.get('/salon/stylists', { params: { search } }); setRows(data); }
    catch { toast.error('Failed to load stylists'); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [search]);

  const openNew = () => { setEditing(null); setForm({ commission_pct: 10, active: 1 }); setModal(true); };
  const openEdit = (s) => { setEditing(s); setForm({ ...s }); setModal(true); };
  const save = async () => {
    if (!form.name?.trim()) return toast.error('Name required');
    try {
      if (editing) await api.put(`/salon/stylists/${editing.id}`, form);
      else await api.post('/salon/stylists', form);
      toast.success(editing ? 'Updated' : 'Stylist added'); setModal(false); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };
  const del = async (s) => { if (!confirm(`Delete "${s.name}"?`)) return; try { await api.delete(`/salon/stylists/${s.id}`); toast.success('Deleted'); load(); } catch { toast.error('Delete failed'); } };

  const initials = (n) => (n || '?').split(' ').map(x => x[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2"><FiUser className="text-blue-700" /> Stylists & Staff</h1>
          <p className="text-sm text-gray-500">{rows.length} team members</p>
        </div>
        {canCreate(M) && <button onClick={openNew} className="px-3 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-sm font-medium flex items-center gap-1.5"><FiPlus /> New Stylist</button>}
      </div>

      <div className="relative mb-4 max-w-sm">
        <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search stylists…" className="w-full pl-9 pr-3 py-2 border rounded-lg text-sm" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map(s => (
          <div key={s.id} className={`bg-white rounded-xl border p-4 ${!s.active ? 'opacity-60' : ''}`}>
            <div className="flex items-start gap-3">
              <div className="w-11 h-11 rounded-full bg-gradient-to-br from-blue-600 to-blue-800 text-white flex items-center justify-center font-bold text-sm flex-shrink-0">{initials(s.name)}</div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-gray-800 truncate">{s.name}</div>
                <div className="text-xs text-gray-500 truncate">{s.specialization || 'Stylist'}</div>
                {s.phone && <div className="text-xs text-gray-400 flex items-center gap-1 mt-0.5"><FiPhone size={11} /> {s.phone}</div>}
              </div>
            </div>
            <div className="flex items-center justify-between mt-3 pt-3 border-t">
              <span className="text-xs bg-blue-50 text-blue-800 px-2 py-1 rounded flex items-center gap-1"><FiPercent size={11} /> {s.commission_pct}% commission</span>
              <div>
                {canEdit(M) && <button onClick={() => openEdit(s)} className="p-1.5 text-gray-400 hover:text-blue-700"><FiEdit2 /></button>}
                {canDelete(M) && <button onClick={() => del(s)} className="p-1.5 text-gray-400 hover:text-red-600"><FiTrash2 /></button>}
              </div>
            </div>
          </div>
        ))}
        {!rows.length && <div className="col-span-full text-center text-gray-400 py-10">No stylists yet</div>}
      </div>

      <Modal isOpen={modal} onClose={() => setModal(false)} title={editing ? 'Edit Stylist' : 'New Stylist'}>
        <div className="space-y-3">
          <Field label="Name"><input value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} className="inp" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone"><input value={form.phone || ''} onChange={e => setForm({ ...form, phone: e.target.value })} className="inp" /></Field>
            <Field label="Email"><input value={form.email || ''} onChange={e => setForm({ ...form, email: e.target.value })} className="inp" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Specialization"><input value={form.specialization || ''} onChange={e => setForm({ ...form, specialization: e.target.value })} className="inp" placeholder="Hair, Nails…" /></Field>
            <Field label="Commission %"><input type="number" value={form.commission_pct ?? 0} onChange={e => setForm({ ...form, commission_pct: +e.target.value })} className="inp" /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active !== 0} onChange={e => setForm({ ...form, active: e.target.checked ? 1 : 0 })} /> Active</label>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setModal(false)} className="px-4 py-2 rounded-lg border text-sm">Cancel</button>
            <button onClick={save} className="px-4 py-2 rounded-lg bg-blue-700 text-white text-sm font-medium">{editing ? 'Update' : 'Add'}</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function Field({ label, children }) {
  return <label className="block"><span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{label}</span><div className="mt-1">{children}</div></label>;
}
