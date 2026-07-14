import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiSun, FiPlus, FiSave, FiTrash2 } from 'react-icons/fi';
import api from '../api';

// Solar Material Master — one rate row per make/grade. Owned by the Solar module
// (separate from the generic Sotyn.Headmasters item master). category drives the columns.
const CATS = [
  { key: 'panel', label: 'Panels', cols: [
    { k: 'make', l: 'Make' }, { k: 'item_name', l: 'Model / name' },
    { k: 'grade', l: 'Grade', sel: ['Non-DCR', 'DCR'] }, { k: 'size', l: 'Wp', w: 70 },
    { k: 'rate', l: '₹/Wp', t: 'number', w: 90 }, { k: 'gst', l: 'GST%', t: 'number', w: 70 } ] },
  { key: 'inverter', label: 'Inverters', cols: [
    { k: 'make', l: 'Make' }, { k: 'item_name', l: 'Model' }, { k: 'size', l: 'kW', w: 70 },
    { k: 'rate', l: '₹/W', t: 'number', w: 90 }, { k: 'gst', l: 'GST%', t: 'number', w: 70 } ] },
  { key: 'structure', label: 'Structure', cols: [
    { k: 'make', l: 'Type / Make' }, { k: 'item_name', l: 'Name' },
    { k: 'rate', l: '₹/Wp', t: 'number', w: 90 }, { k: 'gst', l: 'GST%', t: 'number', w: 70 } ] },
  { key: 'cable', label: 'Cables', cols: [
    { k: 'make', l: 'Make' }, { k: 'grade', l: 'Application', sel: ['DC String', 'AC LT'] },
    { k: 'size', l: 'sqmm', w: 70 }, { k: 'rate', l: '₹/m', t: 'number', w: 90 }, { k: 'gst', l: 'GST%', t: 'number', w: 70 } ] },
  { key: 'bos', label: 'BOS', cols: [
    { k: 'item_name', l: 'Category' }, { k: 'make', l: 'Brand' }, { k: 'unit', l: 'Unit', w: 70 },
    { k: 'rate', l: '₹/unit', t: 'number', w: 100 }, { k: 'gst', l: 'GST%', t: 'number', w: 70 } ] },
];

function CatTable({ cat }) {
  const [rows, setRows] = useState([]);
  const load = () => api.get(`/solar/materials?category=${cat.key}`).then((r) => setRows(r.data || [])).catch(() => toast.error('Load failed'));
  useEffect(() => { load(); }, [cat.key]); // eslint-disable-line
  const patch = (i, k, v) => setRows((rs) => rs.map((r, idx) => idx === i ? { ...r, [k]: v, _dirty: true } : r));
  const save = async (r, i) => {
    try {
      const body = { category: cat.key }; cat.cols.forEach((c) => (body[c.k] = r[c.k]));
      if (r.id) await api.put(`/solar/materials/${r.id}`, body);
      else { const res = await api.post('/solar/materials', body); patch(i, 'id', res.data.id); }
      patch(i, '_dirty', false); toast.success('Saved');
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };
  const del = async (r, i) => {
    if (r.id && !confirm('Delete this rate?')) return;
    if (r.id) { try { await api.delete(`/solar/materials/${r.id}`); } catch { toast.error('Delete failed'); return; } }
    setRows((rs) => rs.filter((_, idx) => idx !== i));
  };
  return (
    <div className="card p-4 overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr className="bg-gray-50 text-left text-gray-500 uppercase text-[10px]">
          {cat.cols.map((c) => <th key={c.k} className="p-2">{c.l}</th>)}<th></th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id || `new${i}`} className="border-t">
              {cat.cols.map((c) => (
                <td key={c.k} className="p-1" style={c.w ? { width: c.w } : undefined}>
                  {c.sel
                    ? <select className="input-compact w-full" value={r[c.k] ?? ''} onChange={(e) => patch(i, c.k, e.target.value)}>
                        <option value=""></option>{c.sel.map((o) => <option key={o} value={o}>{o}</option>)}</select>
                    : <input className="input-compact w-full" type={c.t || 'text'} value={r[c.k] ?? ''} onChange={(e) => patch(i, c.k, e.target.value)} />}
                </td>))}
              <td className="p-1 whitespace-nowrap">
                <button onClick={() => save(r, i)} className={`px-2 py-1 rounded ${r._dirty ? 'bg-blue-700 text-white' : 'text-gray-300'}`}><FiSave size={13} /></button>
                <button onClick={() => del(r, i)} className="px-2 py-1 text-red-500"><FiTrash2 size={13} /></button>
              </td>
            </tr>))}
          {!rows.length && <tr><td colSpan={cat.cols.length + 1} className="p-4 text-center text-gray-300">No rows.</td></tr>}
        </tbody>
      </table>
      <button onClick={() => setRows((rs) => [...rs, { _dirty: true, active: 1 }])} className="btn btn-secondary text-xs mt-3 flex items-center gap-1"><FiPlus size={13} /> Add row</button>
    </div>);
}

export default function SolarMaterialMaster() {
  const [active, setActive] = useState('panel');
  const cat = CATS.find((c) => c.key === active);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><FiSun className="text-amber-500" /> Solar Material Master</h1>
        <p className="text-xs text-gray-500">Purchase (cost) rates per make &amp; grade that drive the Solar Quotation engine. Owned by the Solar Sales module.</p>
      </div>
      <div className="flex gap-2 flex-wrap">
        {CATS.map((c) => (
          <button key={c.key} onClick={() => setActive(c.key)} className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${active === c.key ? 'bg-blue-800 text-white border-blue-800' : 'bg-white text-gray-600 border-gray-200'}`}>{c.label}</button>))}
      </div>
      <CatTable cat={cat} />
    </div>);
}
