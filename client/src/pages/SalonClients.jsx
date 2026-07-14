import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiEdit2, FiTrash2, FiSearch, FiUsers, FiStar, FiEye, FiPhone } from 'react-icons/fi';

const M = 'salon_clients';
const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const fmtDate = (s) => s ? new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export default function SalonClients() {
  const { canCreate, canEdit, canDelete } = useAuth();
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [detail, setDetail] = useState(null);

  const load = async () => {
    try { const { data } = await api.get('/salon/clients', { params: { search } }); setRows(data); }
    catch { toast.error('Failed to load clients'); }
  };
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); /* eslint-disable-next-line */ }, [search]);

  const openNew = () => { setEditing(null); setForm({ gender: '' }); setModal(true); };
  const openEdit = (c) => { setEditing(c); setForm({ ...c }); setModal(true); };
  const save = async () => {
    if (!form.name?.trim()) return toast.error('Name required');
    try {
      if (editing) await api.put(`/salon/clients/${editing.id}`, form);
      else await api.post('/salon/clients', form);
      toast.success(editing ? 'Updated' : 'Client added'); setModal(false); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };
  const del = async (c) => { if (!confirm(`Delete "${c.name}"?`)) return; try { await api.delete(`/salon/clients/${c.id}`); toast.success('Deleted'); load(); } catch { toast.error('Delete failed'); } };
  const openDetail = async (c) => { try { const { data } = await api.get(`/salon/clients/${c.id}`); setDetail(data); } catch { toast.error('Failed to load'); } };

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2"><FiUsers className="text-blue-700" /> Clients</h1>
          <p className="text-sm text-gray-500">{rows.length} clients</p>
        </div>
        {canCreate(M) && <button onClick={openNew} className="px-3 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-sm font-medium flex items-center gap-1.5"><FiPlus /> New Client</button>}
      </div>

      <div className="relative mb-4 max-w-sm">
        <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name / phone…" className="w-full pl-9 pr-3 py-2 border rounded-lg text-sm" />
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-3">Client</th>
                <th className="text-left px-4 py-3">Phone</th>
                <th className="text-right px-4 py-3">Visits</th>
                <th className="text-right px-4 py-3">Spent</th>
                <th className="text-right px-4 py-3">Points</th>
                <th className="text-left px-4 py-3">Last visit</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map(c => (
                <tr key={c.id} className="hover:bg-blue-50/40">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-800">{c.name}</div>
                    <div className="text-xs text-gray-400">{c.client_code}</div>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{c.phone || '—'}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{c.total_visits}</td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-800">{money(c.total_spent)}</td>
                  <td className="px-4 py-3 text-right"><span className="inline-flex items-center gap-1 text-amber-600 font-medium"><FiStar size={12} />{c.loyalty_points}</span></td>
                  <td className="px-4 py-3 text-gray-500">{fmtDate(c.last_visit)}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button onClick={() => openDetail(c)} className="p-1.5 text-gray-400 hover:text-blue-700" title="View"><FiEye /></button>
                    {canEdit(M) && <button onClick={() => openEdit(c)} className="p-1.5 text-gray-400 hover:text-blue-700" title="Edit"><FiEdit2 /></button>}
                    {canDelete(M) && <button onClick={() => del(c)} className="p-1.5 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 /></button>}
                  </td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={7} className="px-4 py-10 text-center text-gray-400">No clients yet</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <Modal isOpen={modal} onClose={() => setModal(false)} title={editing ? 'Edit Client' : 'New Client'}>
        <div className="space-y-3">
          <Field label="Name"><input value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} className="inp" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone"><input value={form.phone || ''} onChange={e => setForm({ ...form, phone: e.target.value })} className="inp" /></Field>
            <Field label="Email"><input value={form.email || ''} onChange={e => setForm({ ...form, email: e.target.value })} className="inp" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Gender">
              <select value={form.gender || ''} onChange={e => setForm({ ...form, gender: e.target.value })} className="inp">
                <option value="">—</option><option>Female</option><option>Male</option><option>Other</option>
              </select>
            </Field>
            <Field label="Date of birth"><input type="date" value={form.dob || ''} onChange={e => setForm({ ...form, dob: e.target.value })} className="inp" /></Field>
          </div>
          <Field label="Notes / preferences"><textarea value={form.notes || ''} onChange={e => setForm({ ...form, notes: e.target.value })} className="inp" rows={2} /></Field>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setModal(false)} className="px-4 py-2 rounded-lg border text-sm">Cancel</button>
            <button onClick={save} className="px-4 py-2 rounded-lg bg-blue-700 text-white text-sm font-medium">{editing ? 'Update' : 'Add'}</button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!detail} onClose={() => setDetail(null)} title={detail?.name} wide>
        {detail && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Kpi label="Visits" value={detail.total_visits} />
              <Kpi label="Total spent" value={money(detail.total_spent)} />
              <Kpi label="Loyalty points" value={detail.loyalty_points} accent />
              <Kpi label="Phone" value={detail.phone || '—'} />
            </div>
            {detail.memberships?.filter(m => m.status === 'active').length > 0 && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <div className="text-xs font-semibold text-blue-800 uppercase mb-1">Active membership</div>
                {detail.memberships.filter(m => m.status === 'active').map(m => (
                  <div key={m.id} className="text-sm text-gray-700">{m.plan_name} · {m.discount_pct}% off · valid till {fmtDate(m.end_date)}</div>
                ))}
              </div>
            )}
            <Section title="Recent visits">
              {detail.sales?.length ? detail.sales.map(s => (
                <Row key={s.id}><span>{s.invoice_no}</span><span className="text-gray-500">{fmtDate(s.created_at)}</span><span className="font-medium">{money(s.total)}</span></Row>
              )) : <Empty>No visits yet</Empty>}
            </Section>
            <Section title="Upcoming & past appointments">
              {detail.appointments?.length ? detail.appointments.slice(0, 8).map(a => (
                <Row key={a.id}><span>{a.appt_no}</span><span className="text-gray-500">{fmtDate(a.appt_date)} {a.start_time || ''}</span><span className="text-xs px-2 py-0.5 rounded bg-gray-100">{a.status}</span></Row>
              )) : <Empty>No appointments</Empty>}
            </Section>
            <Section title="Loyalty history">
              {detail.loyalty?.length ? detail.loyalty.map(l => (
                <Row key={l.id}><span className={l.delta >= 0 ? 'text-emerald-600' : 'text-red-600'}>{l.delta >= 0 ? '+' : ''}{l.delta} pts</span><span className="text-gray-500 flex-1 truncate">{l.reason}</span><span className="text-gray-400">{fmtDate(l.created_at)}</span></Row>
              )) : <Empty>No points activity</Empty>}
            </Section>
          </div>
        )}
      </Modal>
    </div>
  );
}

const Field = ({ label, children }) => <label className="block"><span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{label}</span><div className="mt-1">{children}</div></label>;
const Kpi = ({ label, value, accent }) => <div className={`rounded-lg p-3 border ${accent ? 'bg-amber-50 border-amber-200' : 'bg-gray-50'}`}><div className="text-xs text-gray-500">{label}</div><div className={`text-lg font-bold ${accent ? 'text-amber-600' : 'text-gray-800'}`}>{value}</div></div>;
const Section = ({ title, children }) => <div><div className="text-xs font-semibold text-gray-500 uppercase mb-1.5">{title}</div><div className="border rounded-lg divide-y max-h-48 overflow-y-auto">{children}</div></div>;
const Row = ({ children }) => <div className="flex items-center gap-3 px-3 py-2 text-sm">{children}</div>;
const Empty = ({ children }) => <div className="px-3 py-4 text-center text-gray-400 text-sm">{children}</div>;
