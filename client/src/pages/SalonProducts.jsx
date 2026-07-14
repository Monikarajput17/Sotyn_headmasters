import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiEdit2, FiTrash2, FiSearch, FiPackage, FiAlertTriangle } from 'react-icons/fi';

const M = 'salon_products';
const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

export default function SalonProducts() {
  const { canCreate, canEdit, canDelete } = useAuth();
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});

  const load = async () => {
    try { const { data } = await api.get('/salon/products', { params: { search, low_only: lowOnly ? 1 : undefined } }); setRows(data); }
    catch { toast.error('Failed to load products'); }
  };
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); /* eslint-disable-next-line */ }, [search, lowOnly]);

  const openNew = () => { setEditing(null); setForm({ price: 0, cost: 0, stock_qty: 0, reorder_level: 5, active: 1 }); setModal(true); };
  const openEdit = (p) => { setEditing(p); setForm({ ...p }); setModal(true); };
  const save = async () => {
    if (!form.name?.trim()) return toast.error('Product name required');
    try {
      if (editing) await api.put(`/salon/products/${editing.id}`, form);
      else await api.post('/salon/products', form);
      toast.success(editing ? 'Updated' : 'Product added'); setModal(false); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };
  const del = async (p) => { if (!confirm(`Delete "${p.name}"?`)) return; try { await api.delete(`/salon/products/${p.id}`); toast.success('Deleted'); load(); } catch { toast.error('Delete failed'); } };
  const restock = async (p) => {
    const v = prompt(`Add stock for "${p.name}" (use a negative number to reduce). Current: ${p.stock_qty}`, '10');
    if (v === null) return;
    const delta = Number(v); if (isNaN(delta) || !delta) return;
    try { await api.post(`/salon/products/${p.id}/restock`, { delta }); toast.success('Stock updated'); load(); } catch { toast.error('Failed'); }
  };

  const isLow = (p) => p.reorder_level > 0 && p.stock_qty <= p.reorder_level;

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2"><FiPackage className="text-blue-700" /> Retail Products</h1>
          <p className="text-sm text-gray-500">{rows.length} products · sold at the counter, stock auto-deducts on billing</p>
        </div>
        {canCreate(M) && <button onClick={openNew} className="px-3 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-sm font-medium flex items-center gap-1.5"><FiPlus /> New Product</button>}
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products…" className="w-full pl-9 pr-3 py-2 border rounded-lg text-sm" />
        </div>
        <label className="flex items-center gap-2 text-sm px-3 py-2 border rounded-lg cursor-pointer">
          <input type="checkbox" checked={lowOnly} onChange={e => setLowOnly(e.target.checked)} /> Low stock only
        </label>
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-3">Product</th>
                <th className="text-left px-4 py-3">Brand</th>
                <th className="text-right px-4 py-3">Price</th>
                <th className="text-right px-4 py-3">In stock</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map(p => (
                <tr key={p.id} className="hover:bg-blue-50/40">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-800">{p.name}</div>
                    {p.sku && <div className="text-xs text-gray-400">{p.sku}</div>}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{p.brand || '—'}</td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-800">{money(p.price)}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={`font-medium ${isLow(p) ? 'text-red-600' : 'text-gray-700'}`}>{p.stock_qty}</span>
                    {isLow(p) && <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] text-red-600"><FiAlertTriangle size={10} /> low</span>}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {canEdit(M) && <button onClick={() => restock(p)} className="px-2 py-1 text-xs border rounded text-blue-700 hover:bg-blue-50 mr-1">Restock</button>}
                    {canEdit(M) && <button onClick={() => openEdit(p)} className="p-1.5 text-gray-400 hover:text-blue-700" title="Edit"><FiEdit2 /></button>}
                    {canDelete(M) && <button onClick={() => del(p)} className="p-1.5 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 /></button>}
                  </td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={5} className="px-4 py-10 text-center text-gray-400">No products yet</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <Modal isOpen={modal} onClose={() => setModal(false)} title={editing ? 'Edit Product' : 'New Product'}>
        <div className="space-y-3">
          <Field label="Product name"><input value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} className="inp" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Brand"><input value={form.brand || ''} onChange={e => setForm({ ...form, brand: e.target.value })} className="inp" /></Field>
            <Field label="SKU"><input value={form.sku || ''} onChange={e => setForm({ ...form, sku: e.target.value })} className="inp" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Selling price (₹)"><input type="number" value={form.price ?? 0} onChange={e => setForm({ ...form, price: +e.target.value })} className="inp" /></Field>
            <Field label="Cost price (₹)"><input type="number" value={form.cost ?? 0} onChange={e => setForm({ ...form, cost: +e.target.value })} className="inp" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Stock qty"><input type="number" value={form.stock_qty ?? 0} onChange={e => setForm({ ...form, stock_qty: +e.target.value })} className="inp" /></Field>
            <Field label="Reorder level"><input type="number" value={form.reorder_level ?? 0} onChange={e => setForm({ ...form, reorder_level: +e.target.value })} className="inp" /></Field>
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

const Field = ({ label, children }) => <label className="block"><span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{label}</span><div className="mt-1">{children}</div></label>;
