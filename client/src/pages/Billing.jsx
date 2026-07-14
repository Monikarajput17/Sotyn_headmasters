import { useState, useEffect } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiTrash2, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';

export default function Billing() {
  const { canDelete } = useAuth();
  const [tab, setTab] = useUrlTab('sales');
  const [salesBills, setSalesBills] = useState([]);
  const [raBills, setRaBills] = useState([]);
  const [mbBills, setMbBills] = useState([]);
  const [instBills, setInstBills] = useState([]);
  const [testing, setTesting] = useState([]);
  const [pos, setPos] = useState([]);
  const [installations, setInstallations] = useState([]);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({});

  const load = () => {
    api.get('/procurement/sales-bills').then(r => setSalesBills(r.data));
    api.get('/installation/ra-bills').then(r => setRaBills(r.data));
    api.get('/installation/mb-bills').then(r => setMbBills(r.data));
    api.get('/installation/inst-bills').then(r => setInstBills(r.data));
    api.get('/installation/testing').then(r => setTesting(r.data));
    api.get('/orders/po').then(r => setPos(r.data));
    api.get('/installation').then(r => setInstallations(r.data));
  };
  useEffect(() => { load(); }, []);

  const saveSalesBill = async (e) => { e.preventDefault(); await api.post('/procurement/sales-bills', form); toast.success('Created'); setModal(false); load(); };
  const saveRaBill = async (e) => { e.preventDefault(); await api.post('/installation/ra-bills', form); toast.success('Created'); setModal(false); load(); };
  const saveMbBill = async (e) => { e.preventDefault(); await api.post('/installation/mb-bills', form); toast.success('Created'); setModal(false); load(); };
  const saveInstBill = async (e) => { e.preventDefault(); await api.post('/installation/inst-bills', form); toast.success('Created'); setModal(false); load(); };
  const saveTest = async (e) => { e.preventDefault(); await api.post('/installation/testing', form); toast.success('Created'); setModal(false); load(); };

  const tabs = [
    { id: 'sales', label: 'Sales Bills' },
    { id: 'ra', label: 'RA Bills' },
    { id: 'mb', label: 'MB Bills' },
    { id: 'inst', label: 'Installation Bills' },
    { id: 'testing', label: 'Testing & Commissioning' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap items-center justify-between">
        <div className="flex gap-2 flex-wrap">{tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`btn ${tab === t.id ? 'btn-primary' : 'btn-secondary'}`}>{t.label}</button>
        ))}</div>
        <button onClick={() => {
          if (tab === 'sales')   exportCsv('sales-bills',   ['Bill No','PO','Date','Amount','GST','Total','Payment'], salesBills.map(b => [b.bill_number, b.po_number, b.bill_date, b.amount, b.gst_amount, b.total_amount, b.payment_status]));
          if (tab === 'ra')      exportCsv('ra-bills',      ['Bill No','Date','Work Done','Previous','Current','Status'], raBills.map(b => [b.bill_number, b.bill_date, b.work_done_amount, b.previous_amount, b.current_amount, b.status]));
          if (tab === 'mb')      exportCsv('mb-bills',      ['Bill No','Amount','Status'], mbBills.map(b => [b.bill_number, b.total_amount, b.status]));
          if (tab === 'inst')    exportCsv('inst-bills',    ['Bill No','Amount','Payment'], instBills.map(b => [b.bill_number, b.amount, b.payment_status]));
          if (tab === 'testing') exportCsv('testing',       ['Date','Type','Result','Tested By','Notes'], testing.map(t => [t.test_date, t.test_type, t.result, t.tested_by_name, t.notes]));
        }} className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload /> Export Excel</button>
      </div>

      {tab === 'sales' && (
        <>
          <div className="flex justify-between items-center">
            <h3 className="font-semibold">Sales Bills (to Client)</h3>
            <button onClick={() => { setForm({ po_id: '', bill_date: '', amount: 0, gst_amount: 0, total_amount: 0 }); setModal('sales'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Create Bill</button>
          </div>
          <div className="card p-0"><table className="freeze-head">
            <thead><tr><th>Bill No</th><th>PO</th><th>Date</th><th>Amount</th><th>GST</th><th>Total</th><th>Payment</th><th>Actions</th></tr></thead>
            <tbody>
              {salesBills.map(b => (<tr key={b.id}><td className="font-medium">{b.bill_number}</td><td>{b.po_number}</td><td>{b.bill_date}</td><td>Rs {b.amount?.toLocaleString()}</td><td>Rs {b.gst_amount?.toLocaleString()}</td><td className="font-semibold">Rs {b.total_amount?.toLocaleString()}</td><td><StatusBadge status={b.payment_status} /></td><td>{(canDelete('billing') || canDelete('procurement')) && <button onClick={async () => {
                if (!confirm(`Delete sales bill "${b.bill_number}"?`)) return;
                try { await api.delete(`/procurement/sales-bills/${b.id}`); toast.success('Deleted'); load(); }
                catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
              }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}</td></tr>))}
              {salesBills.length === 0 && <tr><td colSpan="8" className="text-center py-8 text-gray-400">No sales bills</td></tr>}
            </tbody>
          </table></div>
        </>
      )}

      {tab === 'ra' && (
        <>
          <div className="flex justify-between items-center">
            <h3 className="font-semibold">RA Bills (Running Account)</h3>
            <button onClick={() => { setForm({ installation_id: '', bill_number: '', bill_date: '', work_done_amount: 0, previous_amount: 0, current_amount: 0 }); setModal('ra'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Create RA Bill</button>
          </div>
          <div className="card p-0"><table className="freeze-head">
            <thead><tr><th>Bill No</th><th>Date</th><th>Work Done</th><th>Previous</th><th>Current</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {raBills.map(b => (<tr key={b.id}><td className="font-medium">{b.bill_number}</td><td>{b.bill_date}</td><td>Rs {b.work_done_amount?.toLocaleString()}</td><td>Rs {b.previous_amount?.toLocaleString()}</td><td className="font-semibold">Rs {b.current_amount?.toLocaleString()}</td><td><StatusBadge status={b.status} /></td><td>{(canDelete('billing') || canDelete('installation')) && <button onClick={async () => {
                if (!confirm(`Delete RA bill "${b.bill_number}"?`)) return;
                try { await api.delete(`/installation/ra-bills/${b.id}`); toast.success('Deleted'); load(); }
                catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
              }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}</td></tr>))}
              {raBills.length === 0 && <tr><td colSpan="7" className="text-center py-8 text-gray-400">No RA bills</td></tr>}
            </tbody>
          </table></div>
        </>
      )}

      {tab === 'mb' && (
        <>
          <div className="flex justify-between items-center">
            <h3 className="font-semibold">MB Bills (Measurement Book)</h3>
            <button onClick={() => { setForm({ installation_id: '', bill_number: '', measurements: '', total_amount: 0 }); setModal('mb'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Create MB Bill</button>
          </div>
          <div className="card p-0"><table className="freeze-head">
            <thead><tr><th>Bill No</th><th>Amount</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {mbBills.map(b => (<tr key={b.id}><td className="font-medium">{b.bill_number}</td><td className="font-semibold">Rs {b.total_amount?.toLocaleString()}</td><td><StatusBadge status={b.status} /></td><td>{(canDelete('billing') || canDelete('installation')) && <button onClick={async () => {
                if (!confirm(`Delete MB bill "${b.bill_number}"?`)) return;
                try { await api.delete(`/installation/mb-bills/${b.id}`); toast.success('Deleted'); load(); }
                catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
              }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}</td></tr>))}
              {mbBills.length === 0 && <tr><td colSpan="4" className="text-center py-8 text-gray-400">No MB bills</td></tr>}
            </tbody>
          </table></div>
        </>
      )}

      {tab === 'inst' && (
        <>
          <div className="flex justify-between items-center">
            <h3 className="font-semibold">Installation Bills</h3>
            <button onClick={() => { setForm({ installation_id: '', bill_number: '', amount: 0 }); setModal('inst'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Create Bill</button>
          </div>
          <div className="card p-0"><table className="freeze-head">
            <thead><tr><th>Bill No</th><th>Amount</th><th>Payment</th><th>Actions</th></tr></thead>
            <tbody>
              {instBills.map(b => (<tr key={b.id}><td className="font-medium">{b.bill_number}</td><td className="font-semibold">Rs {b.amount?.toLocaleString()}</td><td><StatusBadge status={b.payment_status} /></td><td>{(canDelete('billing') || canDelete('installation')) && <button onClick={async () => {
                if (!confirm(`Delete installation bill "${b.bill_number}"?`)) return;
                try { await api.delete(`/installation/inst-bills/${b.id}`); toast.success('Deleted'); load(); }
                catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
              }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}</td></tr>))}
              {instBills.length === 0 && <tr><td colSpan="4" className="text-center py-8 text-gray-400">No installation bills</td></tr>}
            </tbody>
          </table></div>
        </>
      )}

      {tab === 'testing' && (
        <>
          <div className="flex justify-between items-center">
            <h3 className="font-semibold">Testing & Commissioning</h3>
            <button onClick={() => { setForm({ installation_id: '', test_date: '', test_type: '', result: 'pass', notes: '' }); setModal('test'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Test</button>
          </div>
          <div className="card p-0"><table className="freeze-head">
            <thead><tr><th>Date</th><th>Type</th><th>Result</th><th>Tested By</th><th>Notes</th><th>Actions</th></tr></thead>
            <tbody>
              {testing.map(t => (<tr key={t.id}><td>{t.test_date}</td><td>{t.test_type}</td><td><StatusBadge status={t.result} /></td><td>{t.tested_by_name}</td><td className="max-w-xs truncate">{t.notes}</td><td>{(canDelete('billing') || canDelete('installation')) && <button onClick={async () => {
                if (!confirm(`Delete test record "${t.test_type}"?`)) return;
                try { await api.delete(`/installation/testing/${t.id}`); toast.success('Deleted'); load(); }
                catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
              }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}</td></tr>))}
              {testing.length === 0 && <tr><td colSpan="6" className="text-center py-8 text-gray-400">No tests yet</td></tr>}
            </tbody>
          </table></div>
        </>
      )}

      {/* Modals */}
      <Modal isOpen={modal === 'sales'} onClose={() => setModal(false)} title="Create Sales Bill">
        <form onSubmit={saveSalesBill} className="space-y-4">
          <div><label className="label">Purchase Order</label><select className="select" value={form.po_id} onChange={e => setForm({...form, po_id: e.target.value})}><option value="">Select</option>{pos.map(p => <option key={p.id} value={p.id}>{p.po_number}</option>)}</select></div>
          <div><label className="label">Bill Date</label><input className="input" type="date" value={form.bill_date} onChange={e => setForm({...form, bill_date: e.target.value})} /></div>
          <div className="grid grid-cols-3 gap-4">
            <div><label className="label">Amount</label><input className="input" type="number" value={form.amount} onChange={e => setForm({...form, amount: +e.target.value, total_amount: +e.target.value + (form.gst_amount||0)})} /></div>
            <div><label className="label">GST</label><input className="input" type="number" value={form.gst_amount} onChange={e => setForm({...form, gst_amount: +e.target.value, total_amount: (form.amount||0) + +e.target.value})} /></div>
            <div><label className="label">Total</label><input className="input" type="number" value={form.total_amount} readOnly /></div>
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Create</button></div>
        </form>
      </Modal>

      <Modal isOpen={modal === 'ra'} onClose={() => setModal(false)} title="Create RA Bill">
        <form onSubmit={saveRaBill} className="space-y-4">
          <div><label className="label">Installation</label><select className="select" value={form.installation_id} onChange={e => setForm({...form, installation_id: e.target.value})}><option value="">Select</option>{installations.map(i => <option key={i.id} value={i.id}>#{i.id} - {i.site_address}</option>)}</select></div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="label">Bill Number</label><input className="input" value={form.bill_number} onChange={e => setForm({...form, bill_number: e.target.value})} /></div>
            <div><label className="label">Bill Date</label><input className="input" type="date" value={form.bill_date} onChange={e => setForm({...form, bill_date: e.target.value})} /></div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div><label className="label">Work Done</label><input className="input" type="number" value={form.work_done_amount} onChange={e => setForm({...form, work_done_amount: +e.target.value, current_amount: +e.target.value - (form.previous_amount||0)})} /></div>
            <div><label className="label">Previous</label><input className="input" type="number" value={form.previous_amount} onChange={e => setForm({...form, previous_amount: +e.target.value, current_amount: (form.work_done_amount||0) - +e.target.value})} /></div>
            <div><label className="label">Current</label><input className="input" type="number" value={form.current_amount} readOnly /></div>
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Create</button></div>
        </form>
      </Modal>

      <Modal isOpen={modal === 'mb'} onClose={() => setModal(false)} title="Create MB Bill">
        <form onSubmit={saveMbBill} className="space-y-4">
          <div><label className="label">Installation</label><select className="select" value={form.installation_id} onChange={e => setForm({...form, installation_id: e.target.value})}><option value="">Select</option>{installations.map(i => <option key={i.id} value={i.id}>#{i.id} - {i.site_address}</option>)}</select></div>
          <div><label className="label">Bill Number</label><input className="input" value={form.bill_number} onChange={e => setForm({...form, bill_number: e.target.value})} /></div>
          <div><label className="label">Measurements</label><textarea className="input" rows="3" value={form.measurements} onChange={e => setForm({...form, measurements: e.target.value})} /></div>
          <div><label className="label">Total Amount</label><input className="input" type="number" value={form.total_amount} onChange={e => setForm({...form, total_amount: +e.target.value})} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Create</button></div>
        </form>
      </Modal>

      <Modal isOpen={modal === 'inst'} onClose={() => setModal(false)} title="Create Installation Bill">
        <form onSubmit={saveInstBill} className="space-y-4">
          <div><label className="label">Installation</label><select className="select" value={form.installation_id} onChange={e => setForm({...form, installation_id: e.target.value})}><option value="">Select</option>{installations.map(i => <option key={i.id} value={i.id}>#{i.id} - {i.site_address}</option>)}</select></div>
          <div><label className="label">Bill Number</label><input className="input" value={form.bill_number} onChange={e => setForm({...form, bill_number: e.target.value})} /></div>
          <div><label className="label">Amount</label><input className="input" type="number" value={form.amount} onChange={e => setForm({...form, amount: +e.target.value})} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Create</button></div>
        </form>
      </Modal>

      <Modal isOpen={modal === 'test'} onClose={() => setModal(false)} title="Add Test Record">
        <form onSubmit={saveTest} className="space-y-4">
          <div><label className="label">Installation</label><select className="select" value={form.installation_id} onChange={e => setForm({...form, installation_id: e.target.value})}><option value="">Select</option>{installations.map(i => <option key={i.id} value={i.id}>#{i.id} - {i.site_address}</option>)}</select></div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="label">Test Date</label><input className="input" type="date" value={form.test_date} onChange={e => setForm({...form, test_date: e.target.value})} /></div>
            <div><label className="label">Test Type</label><input className="input" value={form.test_type} onChange={e => setForm({...form, test_type: e.target.value})} /></div>
          </div>
          <div><label className="label">Result</label><select className="select" value={form.result} onChange={e => setForm({...form, result: e.target.value})}><option value="pass">Pass</option><option value="fail">Fail</option><option value="partial">Partial</option></select></div>
          <div><label className="label">Notes</label><textarea className="input" rows="3" value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Save</button></div>
        </form>
      </Modal>
    </div>
  );
}
