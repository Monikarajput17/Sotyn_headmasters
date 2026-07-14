import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiSun, FiSave, FiExternalLink } from 'react-icons/fi';
import api from '../api';

// Engineering factors (mount/array/state multipliers) — NOT a rate master.
function FactorsEditor() {
  const [rows, setRows] = useState([]);
  useEffect(() => { api.get('/solar/factors').then((r) => setRows(r.data || [])); }, []);
  const patch = (i, k, v) => setRows((rs) => rs.map((r, idx) => idx === i ? { ...r, [k]: v, _dirty: true } : r));
  const save = async (r, i) => {
    try { await api.put(`/solar/factors/${r.id}`, { val1: r.val1, val2: r.val2, val3: r.val3 }); patch(i, '_dirty', false); toast.success('Saved'); }
    catch { toast.error('Save failed'); }
  };
  const labels = { mount: ['struct ×', 'area m²/kWp', ''], array: ['struct ×', 'yield ×', ''], state: ['yield kWh/kWp', 't-min °C', 't-max °C'] };
  return (
    <div className="card p-4 overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr className="bg-gray-50 text-left text-gray-500 uppercase text-[10px]"><th className="p-2">Kind</th><th className="p-2">Name</th><th className="p-2">Val 1</th><th className="p-2">Val 2</th><th className="p-2">Val 3</th><th></th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className="border-t">
              <td className="p-2">{r.kind}</td><td className="p-2 font-medium">{r.name}</td>
              {[0, 1, 2].map((j) => (
                <td key={j} className="p-1">{(labels[r.kind] || [])[j] !== '' ? (
                  <input className="input-compact w-24" type="number" value={r[`val${j + 1}`] ?? ''} onChange={(e) => patch(i, `val${j + 1}`, e.target.value)} placeholder={(labels[r.kind] || [])[j]} />) : null}</td>))}
              <td className="p-1"><button onClick={() => save(r, i)} className={`px-2 py-1 rounded ${r._dirty ? 'bg-blue-700 text-white' : 'text-gray-300'}`}><FiSave size={13} /></button></td>
            </tr>))}
        </tbody>
      </table>
    </div>);
}

function SettingsEditor() {
  const [rows, setRows] = useState([]);
  useEffect(() => { api.get('/solar/settings').then((r) => setRows(r.data || [])); }, []);
  const patch = (i, v) => setRows((rs) => rs.map((r, idx) => idx === i ? { ...r, value: v, _dirty: true } : r));
  const save = async (r, i) => { try { await api.put(`/solar/settings/${r.key}`, { value: r.value }); setRows((rs) => rs.map((x, idx) => idx === i ? { ...x, _dirty: false } : x)); toast.success('Saved'); } catch { toast.error('Save failed'); } };
  return (
    <div className="card p-4">
      <table className="w-full text-xs">
        <thead><tr className="bg-gray-50 text-left text-gray-500 uppercase text-[10px]"><th className="p-2">Key</th><th className="p-2">Value</th><th className="p-2">Unit</th><th className="p-2">Note</th><th></th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key} className="border-t">
              <td className="p-2 font-medium">{r.key}</td>
              <td className="p-1"><input className="input-compact w-28" value={r.value ?? ''} onChange={(e) => patch(i, e.target.value)} /></td>
              <td className="p-2 text-gray-500">{r.unit}</td><td className="p-2 text-gray-500">{r.note}</td>
              <td className="p-1"><button onClick={() => save(r, i)} className={`px-2 py-1 rounded ${r._dirty ? 'bg-blue-700 text-white' : 'text-gray-300'}`}><FiSave size={13} /></button></td>
            </tr>))}
        </tbody>
      </table>
    </div>);
}

export default function SolarRateMaster() {
  const [active, setActive] = useState('factors');
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><FiSun className="text-amber-500" /> Solar Settings</h1>
        <p className="text-xs text-gray-500">Engineering factors &amp; global settings that drive the solar engine. Equipment rates live in the shared Item Master.</p>
      </div>
      <div className="card p-3 bg-blue-50/40 border-l-4 border-blue-300 text-xs flex items-center justify-between gap-2 flex-wrap">
        <span>Equipment rates live in the <b>Solar Material Master</b>; labour in the <b>Solar Labour Master</b>. This page is only the engine config.</span>
        <div className="flex gap-2">
          <Link to="/solar-material-master" className="btn btn-secondary text-xs flex items-center gap-1 whitespace-nowrap"><FiExternalLink size={13} /> Material Master</Link>
          <Link to="/solar-labour-master" className="btn btn-secondary text-xs flex items-center gap-1 whitespace-nowrap"><FiExternalLink size={13} /> Labour Master</Link>
        </div>
      </div>
      <div className="flex gap-2">
        {[['factors', 'Engineering Factors'], ['settings', 'Global Settings']].map(([k, l]) => (
          <button key={k} onClick={() => setActive(k)} className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${active === k ? 'bg-blue-800 text-white border-blue-800' : 'bg-white text-gray-600 border-gray-200'}`}>{l}</button>))}
      </div>
      {active === 'factors' ? <FactorsEditor /> : <SettingsEditor />}
    </div>);
}
