import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiSun, FiPlus, FiSave, FiTrash2 } from 'react-icons/fi';
import api from '../api';

const COLS = [
  { k: 'activity', l: 'Activity' }, { k: 'unit', l: 'Unit', w: 110 },
  { k: 'rate', l: 'Rate ₹', t: 'number', w: 110 }, { k: 'gst', l: 'GST%', t: 'number', w: 80 },
];

// Solar Labour Master — owned by the Solar module (separate from Sotyn.Headmasters Labour Rate).
export default function SolarLabourMaster() {
  const [rows, setRows] = useState([]);
  const load = () => api.get('/solar/labour').then((r) => setRows(r.data || [])).catch(() => toast.error('Load failed'));
  useEffect(() => { load(); }, []);
  const patch = (i, k, v) => setRows((rs) => rs.map((r, idx) => idx === i ? { ...r, [k]: v, _dirty: true } : r));
  const save = async (r, i) => {
    try {
      const body = {}; COLS.forEach((c) => (body[c.k] = r[c.k]));
      if (r.id) await api.put(`/solar/labour/${r.id}`, body);
      else { const res = await api.post('/solar/labour', body); patch(i, 'id', res.data.id); }
      patch(i, '_dirty', false); toast.success('Saved');
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };
  const del = async (r, i) => {
    if (r.id && !confirm('Delete this labour rate?')) return;
    if (r.id) { try { await api.delete(`/solar/labour/${r.id}`); } catch { toast.error('Delete failed'); return; } }
    setRows((rs) => rs.filter((_, idx) => idx !== i));
  };
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><FiSun className="text-amber-500" /> Solar Labour Master</h1>
        <p className="text-xs text-gray-500">Solar installation / civil / transport / O&amp;M labour rates that feed the quotation engine. Owned by the Solar Sales module.</p>
      </div>
      <div className="card p-4 overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr className="bg-gray-50 text-left text-gray-500 uppercase text-[10px]">
            {COLS.map((c) => <th key={c.k} className="p-2">{c.l}</th>)}<th></th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id || `new${i}`} className="border-t">
                {COLS.map((c) => (
                  <td key={c.k} className="p-1" style={c.w ? { width: c.w } : undefined}>
                    <input className="input-compact w-full" type={c.t || 'text'} value={r[c.k] ?? ''} onChange={(e) => patch(i, c.k, e.target.value)} /></td>))}
                <td className="p-1 whitespace-nowrap">
                  <button onClick={() => save(r, i)} className={`px-2 py-1 rounded ${r._dirty ? 'bg-blue-700 text-white' : 'text-gray-300'}`}><FiSave size={13} /></button>
                  <button onClick={() => del(r, i)} className="px-2 py-1 text-red-500"><FiTrash2 size={13} /></button>
                </td>
              </tr>))}
            {!rows.length && <tr><td colSpan={COLS.length + 1} className="p-4 text-center text-gray-300">No rows.</td></tr>}
          </tbody>
        </table>
        <button onClick={() => setRows((rs) => [...rs, { _dirty: true, active: 1 }])} className="btn btn-secondary text-xs mt-3 flex items-center gap-1"><FiPlus size={13} /> Add row</button>
      </div>
    </div>);
}
