import { useState, useEffect } from 'react';
import api from '../api';
import ResponsibilityTab from '../components/ResponsibilityTab';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { FiPlus, FiArrowRight, FiPackage, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';

const STAGES = [
  { key: 'indent_raised', label: 'Indent Raised', color: 'bg-gray-200' },
  { key: 'approval_pending', label: 'Approval Pending', color: 'bg-yellow-200' },
  { key: 'approved', label: 'Approved', color: 'bg-red-200' },
  { key: 'po_created', label: 'PO Created', color: 'bg-red-200' },
  { key: 'dispatched', label: 'Dispatched', color: 'bg-purple-200' },
  { key: 'grn_done', label: 'GRN Done', color: 'bg-teal-200' },
  { key: 'bill_entered', label: 'Bill Entered', color: 'bg-orange-200' },
  { key: 'payment_done', label: 'Payment Done', color: 'bg-emerald-200' },
];

export default function IndentFMS() {
  const [tracker, setTracker] = useState([]);
  const [pipeline, setPipeline] = useState({});
  const [grns, setGrns] = useState([]);
  const [tab, setTab] = useUrlTab('pipeline');
  const [modal, setModal] = useState(false);
  const [grnModal, setGrnModal] = useState(false);
  const [form, setForm] = useState({});
  const [grnItems, setGrnItems] = useState([{ description: '', ordered_qty: 0, received_qty: 0, unit: 'nos', rate: 0 }]);

  const load = () => {
    api.get('/indent-fms/tracker').then(r => setTracker(r.data));
    api.get('/indent-fms/pipeline').then(r => setPipeline(r.data));
    api.get('/indent-fms/grn').then(r => setGrns(r.data));
  };
  useEffect(() => { load(); }, []);

  const updateStage = async (indentId, stage) => {
    await api.post(`/indent-fms/tracker/${indentId}/stage`, { stage });
    toast.success(`Stage updated to: ${STAGES.find(s => s.key === stage)?.label}`);
    load();
  };

  const createGrn = async (e) => {
    e.preventDefault();
    await api.post('/indent-fms/grn', { ...form, items: grnItems });
    toast.success('GRN created');
    setGrnModal(false); load();
  };

  const getStageIndex = (stage) => STAGES.findIndex(s => s.key === stage);

  return (
    <div className="space-y-6">
      <div className="flex gap-2 items-center justify-between flex-wrap">
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setTab('pipeline')} className={`btn ${tab === 'pipeline' ? 'btn-primary' : 'btn-secondary'}`}>Pipeline View</button>
          <button onClick={() => setTab('tracker')} className={`btn ${tab === 'tracker' ? 'btn-primary' : 'btn-secondary'}`}>Indent Tracker</button>
          <button onClick={() => setTab('grn')} className={`btn ${tab === 'grn' ? 'btn-primary' : 'btn-secondary'}`}>GRN</button>
          <button onClick={() => setTab('responsible')} className={`btn ${tab === 'responsible' ? 'btn-primary' : 'btn-secondary'}`}>⚙ Responsible</button>
        </div>
        <button onClick={() => {
          if (tab === 'grn') {
            exportCsv('grns', ['GRN #','Date','Received By','Status'],
              grns.map(g => [g.grn_number, g.grn_date, g.received_by_name, g.status]));
          } else {
            exportCsv('indent-tracker',
              ['Indent #','Date','Created By','Status','Current Stage'],
              tracker.map(t => [t.indent_number, t.indent_date, t.created_by_name, t.status, t.currentStage]));
          }
        }} className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload /> Export Excel</button>
      </div>

      {tab === 'responsible' && <ResponsibilityTab module="indent_to_dispatch" title="Indent to Dispatch" />}

      {tab === 'pipeline' && (
        <>
          {/* Pipeline Overview */}
          <div className="card">
            <h4 className="font-semibold mb-4">Indent to Payment Pipeline</h4>
            <div className="flex items-center gap-1 overflow-x-auto pb-2">
              {STAGES.map((stage, i) => (
                <div key={stage.key} className="flex items-center">
                  <div className={`${stage.color} rounded-lg px-3 py-3 text-center min-w-[100px]`}>
                    <div className="text-2xl font-bold">{pipeline.pipeline?.[stage.key] || 0}</div>
                    <div className="text-[10px] font-medium leading-tight">{stage.label}</div>
                  </div>
                  {i < STAGES.length - 1 && <FiArrowRight className="text-gray-400 mx-1 flex-shrink-0" />}
                </div>
              ))}
            </div>
          </div>

          {/* Active Indents with Stage */}
          <div className="card p-0">
            <div className="p-4 border-b"><h4 className="font-semibold">Active Indents</h4></div>
            <table className="freeze-head">
              <thead><tr><th>Indent No</th><th>Date</th><th>Current Stage</th><th>Progress</th><th>Next Action</th></tr></thead>
              <tbody>
                {(pipeline.activeIndents || []).map(ind => {
                  const stageIdx = getStageIndex(ind.current_stage || 'indent_raised');
                  const nextStage = STAGES[Math.min(stageIdx + 1, STAGES.length - 1)];
                  const progress = ((stageIdx + 1) / STAGES.length) * 100;
                  return (
                    <tr key={ind.id}>
                      <td className="font-medium">{ind.indent_number}</td>
                      <td>{ind.indent_date}</td>
                      <td><span className={`badge ${STAGES[stageIdx]?.color} text-gray-800`}>{STAGES[stageIdx]?.label}</span></td>
                      <td>
                        <div className="w-32 bg-gray-200 rounded-full h-2">
                          <div className="bg-red-600 h-2 rounded-full" style={{ width: `${progress}%` }}></div>
                        </div>
                        <span className="text-xs text-gray-500">{Math.round(progress)}%</span>
                      </td>
                      <td>
                        {stageIdx < STAGES.length - 1 && (
                          <button onClick={() => updateStage(ind.id, nextStage.key)} className="btn btn-primary text-xs py-1">
                            Move to: {nextStage.label}
                          </button>
                        )}
                        {stageIdx === STAGES.length - 1 && <span className="badge badge-green">Completed</span>}
                      </td>
                    </tr>
                  );
                })}
                {(pipeline.activeIndents || []).length === 0 && <tr><td colSpan="5" className="text-center py-8 text-gray-400">No active indents</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'tracker' && (
        <div className="card p-0">
          <div className="p-4 border-b"><h4 className="font-semibold">Full Indent Lifecycle Tracker</h4></div>
          <div>
            <table className="freeze-head">
              <thead><tr><th>Indent No</th><th>Date</th><th>Created By</th><th>Status</th><th>Stages Completed</th><th>Current Stage</th></tr></thead>
              <tbody>
                {tracker.map(t => (
                  <tr key={t.id}>
                    <td className="font-medium">{t.indent_number}</td>
                    <td>{t.indent_date}</td>
                    <td>{t.created_by_name}</td>
                    <td><StatusBadge status={t.status} /></td>
                    <td>
                      <div className="flex gap-0.5">
                        {STAGES.map((s, i) => {
                          const done = t.stageList?.some(sl => sl.stage === s.key);
                          return <div key={s.key} className={`w-4 h-4 rounded-sm ${done ? 'bg-emerald-500' : 'bg-gray-200'}`} title={s.label}></div>;
                        })}
                      </div>
                    </td>
                    <td><span className="badge badge-blue">{t.currentStage?.replace(/_/g, ' ')}</span></td>
                  </tr>
                ))}
                {tracker.length === 0 && <tr><td colSpan="6" className="text-center py-8 text-gray-400">No indents tracked yet</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'grn' && (
        <>
          <div className="flex justify-between items-center">
            <h4 className="font-semibold">Goods Received Notes (GRN)</h4>
            <button onClick={() => { setForm({ vendor_po_id: '', indent_id: '', grn_date: new Date().toISOString().split('T')[0], notes: '' }); setGrnItems([{ description: '', ordered_qty: 0, received_qty: 0, unit: 'nos', rate: 0 }]); setGrnModal(true); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Create GRN</button>
          </div>
          <div className="card p-0">
            <table className="freeze-head">
              <thead><tr><th>GRN No</th><th>Date</th><th>Received By</th><th>Status</th></tr></thead>
              <tbody>
                {grns.map(g => (
                  <tr key={g.id}><td className="font-medium">{g.grn_number}</td><td>{g.grn_date}</td><td>{g.received_by_name}</td><td><StatusBadge status={g.status} /></td></tr>
                ))}
                {grns.length === 0 && <tr><td colSpan="4" className="text-center py-8 text-gray-400">No GRNs yet</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* GRN Modal */}
      <Modal isOpen={grnModal} onClose={() => setGrnModal(false)} title="Create GRN" wide>
        <form onSubmit={createGrn} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div><label className="label">GRN Date</label><input className="input" type="date" value={form.grn_date || ''} onChange={e => setForm({...form, grn_date: e.target.value})} /></div>
          </div>
          <h5 className="font-semibold text-sm">Items</h5>
          {grnItems.map((item, i) => (
            <div key={i} className="grid grid-cols-5 gap-2">
              <input className="input col-span-2" placeholder="Description" value={item.description} onChange={e => { const n = [...grnItems]; n[i].description = e.target.value; setGrnItems(n); }} />
              <input className="input" type="number" placeholder="Ordered" value={item.ordered_qty} onChange={e => { const n = [...grnItems]; n[i].ordered_qty = +e.target.value; setGrnItems(n); }} />
              <input className="input" type="number" placeholder="Received" value={item.received_qty} onChange={e => { const n = [...grnItems]; n[i].received_qty = +e.target.value; setGrnItems(n); }} />
              <input className="input" type="number" placeholder="Rate" value={item.rate} onChange={e => { const n = [...grnItems]; n[i].rate = +e.target.value; setGrnItems(n); }} />
            </div>
          ))}
          <button type="button" onClick={() => setGrnItems([...grnItems, { description: '', ordered_qty: 0, received_qty: 0, unit: 'nos', rate: 0 }])} className="btn btn-secondary text-xs">+ Add Item</button>
          <div><label className="label">Notes</label><textarea className="input" rows="2" value={form.notes || ''} onChange={e => setForm({...form, notes: e.target.value})} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setGrnModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Create GRN</button></div>
        </form>
      </Modal>
    </div>
  );
}
