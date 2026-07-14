import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiEdit2, FiTrash2, FiAward, FiUserPlus } from 'react-icons/fi';

const M = 'salon_memberships';
const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const fmtDate = (s) => s ? new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

export default function SalonMemberships() {
  const { canCreate, canEdit, canDelete } = useAuth();
  const [plans, setPlans] = useState([]);
  const [sold, setSold] = useState([]);
  const [clients, setClients] = useState([]);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [sellModal, setSellModal] = useState(false);
  const [sell, setSell] = useState({ client_id: '', plan_id: '' });

  const load = async () => {
    try {
      const [p, cm, c] = await Promise.all([
        api.get('/salon/memberships/plans'),
        api.get('/salon/memberships/client-memberships'),
        api.get('/salon/clients'),
      ]);
      setPlans(p.data); setSold(cm.data); setClients(c.data);
    } catch { toast.error('Failed to load'); }
  };
  useEffect(() => { load(); }, []);

  const openNew = () => { setEditing(null); setForm({ plan_type: 'membership', price: 0, validity_days: 365, discount_pct: 10, active: 1 }); setModal(true); };
  const openEdit = (p) => { setEditing(p); setForm({ ...p }); setModal(true); };
  const save = async () => {
    if (!form.name?.trim()) return toast.error('Plan name required');
    try {
      if (editing) await api.put(`/salon/memberships/plans/${editing.id}`, form);
      else await api.post('/salon/memberships/plans', form);
      toast.success(editing ? 'Updated' : 'Plan added'); setModal(false); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };
  const del = async (p) => { if (!confirm(`Delete "${p.name}"?`)) return; try { await api.delete(`/salon/memberships/plans/${p.id}`); toast.success('Deleted'); load(); } catch { toast.error('Delete failed'); } };

  const doSell = async () => {
    if (!sell.client_id || !sell.plan_id) return toast.error('Pick a client and a plan');
    try { await api.post('/salon/memberships/client-memberships', sell); toast.success('Membership sold'); setSellModal(false); setSell({ client_id: '', plan_id: '' }); load(); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2"><FiAward className="text-blue-700" /> Memberships & Packages</h1>
          <p className="text-sm text-gray-500">{plans.length} plans · {sold.filter(s => s.status === 'active').length} active memberships</p>
        </div>
        <div className="flex gap-2">
          {canCreate(M) && <button onClick={() => setSellModal(true)} className="px-3 py-2 rounded-lg border border-blue-300 text-blue-800 hover:bg-blue-50 text-sm font-medium flex items-center gap-1.5"><FiUserPlus /> Sell to client</button>}
          {canCreate(M) && <button onClick={openNew} className="px-3 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-sm font-medium flex items-center gap-1.5"><FiPlus /> New Plan</button>}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 mb-6">
        {plans.map(p => (
          <div key={p.id} className={`rounded-xl border p-4 ${p.plan_type === 'membership' ? 'bg-gradient-to-br from-blue-50 to-blue-100 border-blue-200' : 'bg-white'}`}>
            <div className="flex items-start justify-between">
              <div>
                <div className="font-bold text-gray-800">{p.name}</div>
                <span className="text-[10px] uppercase tracking-wide text-gray-500">{p.plan_type}</span>
              </div>
              <div className="text-lg font-bold text-blue-800">{money(p.price)}</div>
            </div>
            <div className="text-sm text-gray-600 mt-2">{p.description}</div>
            <div className="text-xs text-gray-500 mt-2">
              {p.plan_type === 'membership' && <span className="font-medium text-blue-800">{p.discount_pct}% off every bill · </span>}
              valid {p.validity_days} days
            </div>
            <div className="flex justify-end gap-1 mt-2 pt-2 border-t">
              {canEdit(M) && <button onClick={() => openEdit(p)} className="p-1.5 text-gray-400 hover:text-blue-700"><FiEdit2 /></button>}
              {canDelete(M) && <button onClick={() => del(p)} className="p-1.5 text-gray-400 hover:text-red-600"><FiTrash2 /></button>}
            </div>
          </div>
        ))}
        {!plans.length && <div className="col-span-full text-center text-gray-400 py-8">No plans yet</div>}
      </div>

      <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">Sold memberships</h2>
      <div className="bg-white rounded-xl border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr><th className="text-left px-4 py-3">Client</th><th className="text-left px-4 py-3">Plan</th><th className="text-left px-4 py-3">Discount</th><th className="text-left px-4 py-3">Valid till</th><th className="text-left px-4 py-3">Status</th><th></th></tr>
            </thead>
            <tbody className="divide-y">
              {sold.map(s => (
                <tr key={s.id}>
                  <td className="px-4 py-3 font-medium text-gray-800">{s.client_name}</td>
                  <td className="px-4 py-3 text-gray-600">{s.plan_name}</td>
                  <td className="px-4 py-3 text-gray-600">{s.discount_pct ? `${s.discount_pct}%` : '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{fmtDate(s.end_date)}</td>
                  <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded ${s.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>{s.status}</span></td>
                  <td className="px-2">{canDelete(M) && <button onClick={async () => { if (confirm('Remove?')) { await api.delete(`/salon/memberships/client-memberships/${s.id}`); load(); } }} className="text-gray-300 hover:text-red-600"><FiTrash2 /></button>}</td>
                </tr>
              ))}
              {!sold.length && <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">None sold yet</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <Modal isOpen={modal} onClose={() => setModal(false)} title={editing ? 'Edit Plan' : 'New Plan'}>
        <div className="space-y-3">
          <Field label="Plan name"><input value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} className="inp" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              <select value={form.plan_type || 'membership'} onChange={e => setForm({ ...form, plan_type: e.target.value })} className="inp">
                <option value="membership">Membership (% off)</option><option value="package">Prepaid package</option>
              </select>
            </Field>
            <Field label="Price (₹)"><input type="number" value={form.price ?? 0} onChange={e => setForm({ ...form, price: +e.target.value })} className="inp" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Validity (days)"><input type="number" value={form.validity_days ?? 365} onChange={e => setForm({ ...form, validity_days: +e.target.value })} className="inp" /></Field>
            {form.plan_type === 'membership' && <Field label="Discount %"><input type="number" value={form.discount_pct ?? 0} onChange={e => setForm({ ...form, discount_pct: +e.target.value })} className="inp" /></Field>}
          </div>
          <Field label="Description"><textarea value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} className="inp" rows={2} /></Field>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setModal(false)} className="px-4 py-2 rounded-lg border text-sm">Cancel</button>
            <button onClick={save} className="px-4 py-2 rounded-lg bg-blue-700 text-white text-sm font-medium">{editing ? 'Update' : 'Add'}</button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={sellModal} onClose={() => setSellModal(false)} title="Sell membership to client">
        <div className="space-y-3">
          <Field label="Client">
            <select value={sell.client_id} onChange={e => setSell({ ...sell, client_id: e.target.value })} className="inp">
              <option value="">Select client…</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name} {c.phone ? `· ${c.phone}` : ''}</option>)}
            </select>
          </Field>
          <Field label="Plan">
            <select value={sell.plan_id} onChange={e => setSell({ ...sell, plan_id: e.target.value })} className="inp">
              <option value="">Select plan…</option>
              {plans.filter(p => p.active !== 0).map(p => <option key={p.id} value={p.id}>{p.name} · {money(p.price)}</option>)}
            </select>
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setSellModal(false)} className="px-4 py-2 rounded-lg border text-sm">Cancel</button>
            <button onClick={doSell} className="px-4 py-2 rounded-lg bg-blue-700 text-white text-sm font-medium">Sell</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

const Field = ({ label, children }) => <label className="block"><span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{label}</span><div className="mt-1">{children}</div></label>;
