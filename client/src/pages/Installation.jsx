import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiEdit2, FiTrash2, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';

export default function Installation() {
  const { canDelete } = useAuth();
  const [installations, setInstallations] = useState([]);
  const [pos, setPos] = useState([]);
  const [users, setUsers] = useState([]);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});

  const load = () => { api.get('/installation').then(r => setInstallations(r.data)); };
  useEffect(() => {
    load();
    api.get('/orders/po').then(r => setPos(r.data));
    // Mam (2026-05-22): hide inactive ex-employees from installer picker.
    api.get('/auth/users?active_only=1').then(r => setUsers(r.data));
  }, []);

  const save = async (e) => {
    e.preventDefault();
    if (editing) { await api.put(`/installation/${editing.id}`, form); }
    else { await api.post('/installation', form); }
    toast.success(editing ? 'Updated' : 'Created');
    setModal(false); load();
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="font-semibold">Sales Billing</h3>
        <div className="flex gap-2">
          <button onClick={() => exportCsv('installations',
            ['PO','Site Address','Start','End','Assigned To','Status'],
            installations.map(i => [i.po_number, i.site_address, i.start_date, i.end_date, i.assigned_to_name, i.status]))}
            className="btn btn-secondary flex items-center gap-2"><FiDownload /> Export Excel</button>
          <button onClick={() => { setEditing(null); setForm({ po_id: '', site_address: '', start_date: '', end_date: '', assigned_to: '', notes: '' }); setModal(true); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Installation</button>
        </div>
      </div>
      <div className="card p-0"><table className="freeze-head">
        <thead><tr><th>PO</th><th>Site Address</th><th>Start</th><th>End</th><th>Assigned To</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          {installations.map(i => (
            <tr key={i.id}>
              <td>{i.po_number}</td><td>{i.site_address}</td><td>{i.start_date}</td><td>{i.end_date}</td>
              <td>{i.assigned_to_name}</td><td><StatusBadge status={i.status} /></td>
              <td><div className="flex gap-1">
                <button onClick={() => { setEditing(i); setForm(i); setModal(true); }} className="p-1.5 hover:bg-red-50 rounded text-red-600"><FiEdit2 size={15} /></button>
                {canDelete('installation') && <button onClick={async () => {
                  if (!confirm(`Delete installation "${i.site_address}"?`)) return;
                  try { await api.delete(`/installation/${i.id}`); toast.success('Deleted'); load(); }
                  catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}
              </div></td>
            </tr>
          ))}
          {installations.length === 0 && <tr><td colSpan="7" className="text-center py-8 text-gray-400">No installations yet</td></tr>}
        </tbody>
      </table></div>

      <Modal isOpen={modal} onClose={() => setModal(false)} title={editing ? 'Edit Installation' : 'Add Installation'}>
        <form onSubmit={save} className="space-y-4">
          <div><label className="label">Purchase Order</label><select className="select" value={form.po_id || ''} onChange={e => setForm({...form, po_id: e.target.value})}><option value="">Select</option>{pos.map(p => <option key={p.id} value={p.id}>{p.po_number} - {p.company_name}</option>)}</select></div>
          <div><label className="label">Site Address</label><textarea className="input" rows="2" value={form.site_address || ''} onChange={e => setForm({...form, site_address: e.target.value})} /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className="label">Start Date</label><input className="input" type="date" value={form.start_date || ''} onChange={e => setForm({...form, start_date: e.target.value})} /></div>
            <div><label className="label">End Date</label><input className="input" type="date" value={form.end_date || ''} onChange={e => setForm({...form, end_date: e.target.value})} /></div>
          </div>
          <div><label className="label">Assigned To</label><select className="select" value={form.assigned_to || ''} onChange={e => setForm({...form, assigned_to: e.target.value})}><option value="">Select</option>{users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
          {editing && <div><label className="label">Status</label><select className="select" value={form.status || ''} onChange={e => setForm({...form, status: e.target.value})}>
            {['pending','in_progress','completed','testing'].map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select></div>}
          <div><label className="label">Notes</label><textarea className="input" rows="2" value={form.notes || ''} onChange={e => setForm({...form, notes: e.target.value})} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'}</button></div>
        </form>
      </Modal>
    </div>
  );
}
