import { useState, useEffect } from 'react';
import api from '../api';
import ResponsibilityTab from '../components/ResponsibilityTab';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { FiPlus, FiEdit2, FiTrash2, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { useAuth } from '../context/AuthContext';
import { fmtDate } from '../utils/datetime';

const blankRow = () => ({ description: '', quantity: 1, unit: 'nos', rate: 0, item_id: null, suggestion: null });

export default function Quotations() {
  const { canDelete } = useAuth();
  const [tab, setTab] = useUrlTab('boq');
  const [boqs, setBoqs] = useState([]);
  const [quotations, setQuotations] = useState([]);
  const [leads, setLeads] = useState([]);
  const [itemOptions, setItemOptions] = useState([]);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({});
  const [boqItems, setBoqItems] = useState([blankRow()]);

  useEffect(() => {
    api.get('/quotations/boq').then(r => setBoqs(r.data));
    api.get('/quotations').then(r => setQuotations(r.data));
    api.get('/leads').then(r => setLeads(r.data));
    api.get('/item-master/dropdown').then(r => setItemOptions(r.data));
  }, []);

  const reload = () => {
    api.get('/quotations/boq').then(r => setBoqs(r.data));
    api.get('/quotations').then(r => setQuotations(r.data));
  };

  const addBoqItem = () => setBoqItems([...boqItems, blankRow()]);

  // AI Agent: when an item is picked from the catalogue, fetch the
  // rate suggestion (last-quoted-to-this-client + 6-month stats) and
  // pre-fill the rate with the item_master current_price.
  const pickItem = async (rowIdx, item) => {
    const next = [...boqItems];
    if (!item) {
      next[rowIdx] = { ...next[rowIdx], item_id: null, suggestion: null };
      setBoqItems(next);
      return;
    }
    next[rowIdx] = {
      ...next[rowIdx],
      item_id: item.id,
      description: item.display_name,
      unit: item.uom || next[rowIdx].unit,
      rate: next[rowIdx].rate || item.current_price || 0,
    };
    setBoqItems(next);
    try {
      const params = { item_id: item.id };
      if (form.lead_id) params.lead_id = form.lead_id;
      const { data } = await api.get('/ai-agent/rate-suggestion', { params });
      setBoqItems(curr => {
        const c = [...curr];
        c[rowIdx] = { ...c[rowIdx], suggestion: data };
        return c;
      });
    } catch (e) { /* suggestion is best-effort */ }
  };

  const useSuggestedRate = (rowIdx, rate) => {
    const next = [...boqItems];
    next[rowIdx] = { ...next[rowIdx], rate };
    setBoqItems(next);
  };

  const createBoq = async (e) => {
    e.preventDefault();
    // Strip UI-only `suggestion` field before posting
    const items = boqItems.map(({ suggestion, ...rest }) => rest);
    await api.post('/quotations/boq', { ...form, items });
    toast.success('BOQ created');
    setModal(false);
    reload();
  };

  const createQuotation = async (e) => {
    e.preventDefault();
    await api.post('/quotations', form);
    toast.success('Quotation created');
    setModal(false);
    reload();
  };

  const updateQuotation = async (id, status) => {
    const q = quotations.find(x => x.id === id);
    await api.put(`/quotations/${id}`, { ...q, status });
    toast.success('Status updated');
    reload();
  };

  return (
    <div className="space-y-4">
      <div className="sticky-toolbar">
        <div className="flex gap-2">
          <button onClick={() => setTab('boq')} className={`btn ${tab === 'boq' ? 'btn-primary' : 'btn-secondary'}`}>BOQ / Drawings</button>
          <button onClick={() => setTab('quotations')} className={`btn ${tab === 'quotations' ? 'btn-primary' : 'btn-secondary'}`}>Quotations</button>
          <button onClick={() => setTab('responsible')} className={`btn ${tab === 'responsible' ? 'btn-primary' : 'btn-secondary'}`}>⚙ Responsible</button>
        </div>
      </div>

      {tab === 'responsible' && <ResponsibilityTab module="quotation" title="Quotation" />}

      {tab === 'boq' && (
        <>
          <div className="flex justify-between items-center">
            <h3 className="font-semibold text-gray-800">Bill of Quantities</h3>
            <div className="flex gap-2">
              <button onClick={() => exportCsv('boqs',
                ['Title','Client','Drawing','Total','Status','Date'],
                boqs.map(b => [b.title, b.client_name, b.drawing_required ? 'Yes' : 'No', b.total_amount, b.status, b.created_at]))}
                className="btn btn-secondary flex items-center gap-2"><FiDownload /> Export Excel</button>
              <button onClick={() => { setForm({ lead_id: '', title: '', drawing_required: false }); setBoqItems([blankRow()]); setModal('boq'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Create BOQ</button>
            </div>
          </div>
          <div className="card p-0">
            <table className="freeze-head">
              <thead><tr><th>Title</th><th>Client</th><th>Drawing</th><th>Total</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead>
              <tbody>
                {boqs.map(b => (
                  <tr key={b.id}>
                    <td className="font-medium">{b.title}</td>
                    <td>{b.company_name}</td>
                    <td>{b.drawing_required ? 'Yes' : 'No'}</td>
                    <td>Rs {b.total_amount?.toLocaleString()}</td>
                    <td><StatusBadge status={b.status} /></td>
                    <td className="text-gray-500">{fmtDate(b.created_at)}</td>
                    <td>
                      {canDelete('quotations') && <button onClick={async () => {
                        if (!confirm(`Delete BOQ "${b.title}"?`)) return;
                        try { await api.delete(`/quotations/boq/${b.id}`); toast.success('Deleted'); reload(); }
                        catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                      }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}
                    </td>
                  </tr>
                ))}
                {boqs.length === 0 && <tr><td colSpan="7" className="text-center py-8 text-gray-400">No BOQs yet</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'quotations' && (
        <>
          <div className="flex justify-between items-center">
            <h3 className="font-semibold text-gray-800">Quotations</h3>
            <div className="flex gap-2">
              <button onClick={() => exportCsv('quotations',
                ['Number','Client','Total','Discount','Final','Status','Valid Until'],
                quotations.map(q => [q.quotation_number, q.client_name, q.total_amount, q.discount, q.final_amount, q.status, q.valid_until]))}
                className="btn btn-secondary flex items-center gap-2"><FiDownload /> Export Excel</button>
              <button onClick={() => { setForm({ lead_id: '', boq_id: '', total_amount: 0, discount: 0, final_amount: 0, valid_until: '', notes: '' }); setModal('quotation'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Create Quotation</button>
            </div>
          </div>
          <div className="card p-0">
            <table className="freeze-head">
              <thead><tr><th>Number</th><th>Client</th><th>Total</th><th>Discount</th><th>Final</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {quotations.map(q => (
                  <tr key={q.id}>
                    <td className="font-medium">{q.quotation_number}</td>
                    <td>{q.company_name}</td>
                    <td>Rs {q.total_amount?.toLocaleString()}</td>
                    <td>Rs {q.discount?.toLocaleString()}</td>
                    <td className="font-semibold">Rs {q.final_amount?.toLocaleString()}</td>
                    <td><StatusBadge status={q.status} /></td>
                    <td>
                      <div className="flex gap-2 items-center">
                        <select className="select w-32" value={q.status} onChange={e => updateQuotation(q.id, e.target.value)}>
                          {['draft','sent','negotiation','accepted','rejected'].map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                        {canDelete('quotations') && <button onClick={async () => {
                          if (!confirm(`Delete quotation "${q.quotation_number}"?`)) return;
                          try { await api.delete(`/quotations/${q.id}`); toast.success('Deleted'); reload(); }
                          catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                        }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}
                      </div>
                    </td>
                  </tr>
                ))}
                {quotations.length === 0 && <tr><td colSpan="7" className="text-center py-8 text-gray-400">No quotations yet</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* BOQ Modal */}
      <Modal isOpen={modal === 'boq'} onClose={() => setModal(false)} title="Create BOQ" wide>
        <form onSubmit={createBoq} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Lead / Client</label>
              <select className="select" value={form.lead_id} onChange={e => setForm({...form, lead_id: e.target.value})}>
                <option value="">Select</option>
                {leads.map(l => <option key={l.id} value={l.id}>{l.company_name}</option>)}
              </select>
            </div>
            <div><label className="label">Title *</label><input className="input" value={form.title || ''} onChange={e => setForm({...form, title: e.target.value})} required /></div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.drawing_required} onChange={e => setForm({...form, drawing_required: e.target.checked})} /> Drawing Required
          </label>
          <div className="flex items-baseline justify-between">
            <h4 className="font-semibold text-sm">Items</h4>
            <span className="text-xs text-gray-400">AI suggests rates based on past quotations</span>
          </div>
          {boqItems.map((item, i) => (
            <div key={i} className="space-y-2 border border-gray-100 rounded p-2 bg-gray-50">
              {/* Mobile-first layout: stacks on phone, single-row on desktop.
                  Was qty/unit/rate at col-span-1/1/2 of 12 → all three
                  fields disappeared on phone. */}
              <div className="grid grid-cols-12 gap-2">
                <div className="col-span-12 md:col-span-5">
                  <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">BOQ Item</div>
                  <SearchableSelect
                    options={itemOptions}
                    value={item.item_id}
                    valueKey="id"
                    displayKey="display_name"
                    placeholder="Pick from Item Master (or type description below)"
                    onChange={opt => pickItem(i, opt)}
                  />
                </div>
                <div className="col-span-12 md:col-span-3">
                  <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Description</div>
                  <input className="input" placeholder="Description (auto-filled or free text)"
                    value={item.description}
                    onChange={e => { const n = [...boqItems]; n[i].description = e.target.value; setBoqItems(n); }} />
                </div>
                <div className="col-span-4 md:col-span-1">
                  <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Qty</div>
                  {/* `|| ''` lets backspace clear the field instead of
                      snapping back to 0 (mam 2026-05-25). */}
                  <input className="input" type="number" placeholder="Qty" value={item.quantity || ''}
                    onChange={e => { const n = [...boqItems]; n[i].quantity = +e.target.value; setBoqItems(n); }} />
                </div>
                <div className="col-span-3 md:col-span-1">
                  <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Unit</div>
                  <input className="input" placeholder="Unit" value={item.unit}
                    onChange={e => { const n = [...boqItems]; n[i].unit = e.target.value; setBoqItems(n); }} />
                </div>
                <div className="col-span-5 md:col-span-2">
                  <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Rate</div>
                  {/* `|| ''` keeps backspace from snapping to 0 (mam 2026-05-25). */}
                  <input className="input" type="number" placeholder="Rate" value={item.rate || ''}
                    onChange={e => { const n = [...boqItems]; n[i].rate = +e.target.value; setBoqItems(n); }} />
                </div>
              </div>
              {item.suggestion && (item.suggestion.last_for_client || item.suggestion.last_overall) && (
                <RateSuggestion data={item.suggestion} onUse={r => useSuggestedRate(i, r)} />
              )}
            </div>
          ))}
          <button type="button" onClick={addBoqItem} className="btn btn-secondary text-xs">+ Add Item</button>
          <div className="text-right font-semibold">Total: Rs {boqItems.reduce((s, i) => s + i.quantity * i.rate, 0).toLocaleString()}</div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Create BOQ</button>
          </div>
        </form>
      </Modal>

      {/* Quotation Modal */}
      <Modal isOpen={modal === 'quotation'} onClose={() => setModal(false)} title="Create Quotation">
        <form onSubmit={createQuotation} className="space-y-4">
          <div>
            <label className="label">Lead / Client</label>
            <select className="select" value={form.lead_id} onChange={e => setForm({...form, lead_id: e.target.value})}>
              <option value="">Select</option>
              {leads.map(l => <option key={l.id} value={l.id}>{l.company_name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">BOQ Reference</label>
            <select className="select" value={form.boq_id} onChange={e => setForm({...form, boq_id: e.target.value})}>
              <option value="">Select</option>
              {boqs.map(b => <option key={b.id} value={b.id}>{b.title} - Rs {b.total_amount?.toLocaleString()}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            <div><label className="label">Total Amount</label><input className="input" type="number" value={form.total_amount} onChange={e => setForm({...form, total_amount: +e.target.value, final_amount: +e.target.value - (form.discount || 0)})} /></div>
            <div><label className="label">Discount</label><input className="input" type="number" value={form.discount} onChange={e => setForm({...form, discount: +e.target.value, final_amount: (form.total_amount || 0) - +e.target.value})} /></div>
            <div><label className="label">Final Amount</label><input className="input" type="number" value={form.final_amount} readOnly /></div>
          </div>
          <div><label className="label">Valid Until</label><input className="input" type="date" value={form.valid_until} onChange={e => setForm({...form, valid_until: e.target.value})} /></div>
          <div><label className="label">Notes</label><textarea className="input" rows="2" value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} /></div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Create</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

// AI Agent rate suggestion: shows last-quoted-to-this-client and the
// 6-month avg/low/high across all clients, with one-click "use" buttons
// so mam's team quotes consistently and never undersells by accident.
function RateSuggestion({ data, onUse }) {
  const { last_for_client, last_overall, six_month_stats, company_name } = data;
  const fmt = (n) => 'Rs ' + Math.round(n).toLocaleString();
  const ago = (iso) => {
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (days < 1) return 'today';
    if (days === 1) return '1 day ago';
    if (days < 30) return `${days} days ago`;
    const months = Math.floor(days / 30);
    return months === 1 ? '1 month ago' : `${months} months ago`;
  };

  return (
    <div className="bg-blue-50 border border-blue-200 rounded p-2 text-xs space-y-1">
      <div className="font-semibold text-blue-900 flex items-center gap-1">
        <span>AI rate suggestion</span>
      </div>
      {last_for_client && company_name && (
        <div className="flex items-center justify-between">
          <span>
            Last quoted to <span className="font-medium">{company_name}</span>:{' '}
            <span className="font-semibold text-blue-900">{fmt(last_for_client.rate)}</span>{' '}
            <span className="text-gray-500">· {ago(last_for_client.created_at)}{last_for_client.created_by_name ? ` · ${last_for_client.created_by_name}` : ''}</span>
          </span>
          <button type="button" onClick={() => onUse(last_for_client.rate)}
            className="text-blue-700 hover:bg-blue-100 px-2 py-0.5 rounded text-xs font-medium">Use this</button>
        </div>
      )}
      {!last_for_client && last_overall && (
        <div className="flex items-center justify-between">
          <span>
            Last quoted (any client): <span className="font-semibold text-blue-900">{fmt(last_overall.rate)}</span>{' '}
            <span className="text-gray-500">· {ago(last_overall.created_at)}{last_overall.company_name ? ` · ${last_overall.company_name}` : ''}</span>
          </span>
          <button type="button" onClick={() => onUse(last_overall.rate)}
            className="text-blue-700 hover:bg-blue-100 px-2 py-0.5 rounded text-xs font-medium">Use this</button>
        </div>
      )}
      {six_month_stats && (
        <div className="text-gray-600">
          Last 6 months ({six_month_stats.count} {six_month_stats.count === 1 ? 'quote' : 'quotes'}):
          {' '}avg <span className="font-medium text-gray-900">{fmt(six_month_stats.avg)}</span>
          {' '}· low <span className="font-medium text-gray-900">{fmt(six_month_stats.min)}</span>
          {' '}· high <span className="font-medium text-gray-900">{fmt(six_month_stats.max)}</span>
        </div>
      )}
    </div>
  );
}
