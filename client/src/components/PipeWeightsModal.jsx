import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';
import { FiPlus, FiTrash2, FiEdit2, FiX, FiCheck } from 'react-icons/fi';

// Pipe Weight master (mam 2026-06-06). Editable table: Class + Size -> kg/m.
// Used to convert pipe quantities from METERS (indent) to KG (vendor / PO).
// You can enter kg/m directly, OR weight-per-pipe + length and it derives kg/m.
const blank = { id: null, pipe_class: 'C', size: '', kg_per_meter: '', weight_per_pipe: '', pipe_length_m: 6, active: 1 };

export default function PipeWeightsModal({ isOpen, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState(blank);   // the add/edit row
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/pipe-weights', { params: { active: 'all' } })
      .then(r => setRows(r.data || []))
      .catch(e => toast.error(e.response?.data?.error || 'Load failed'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { if (isOpen) { load(); setDraft(blank); } }, [isOpen, load]);

  const save = async () => {
    if (!draft.pipe_class?.trim()) return toast.error('Class is required');
    if (!draft.size?.trim()) return toast.error('Size is required');
    setSaving(true);
    try {
      if (draft.id) await api.put(`/pipe-weights/${draft.id}`, draft);
      else await api.post('/pipe-weights', draft);
      toast.success(draft.id ? 'Updated' : 'Added');
      setDraft(blank);
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  };

  const remove = async (row) => {
    if (!confirm(`Delete ${row.pipe_class} class · ${row.size}?`)) return;
    try { await api.delete(`/pipe-weights/${row.id}`); toast.success('Deleted'); load(); }
    catch (e) { toast.error(e.response?.data?.error || 'Delete failed'); }
  };

  // Live preview of derived kg/m when entering weight-per-pipe + length.
  const derived = (() => {
    if (+draft.kg_per_meter > 0) return +draft.kg_per_meter;
    const wpp = +draft.weight_per_pipe, len = +draft.pipe_length_m || 6;
    return wpp > 0 && len > 0 ? Math.round((wpp / len) * 1000) / 1000 : 0;
  })();

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Pipe Weight Master · MTR → KG" wide>
      <p className="text-xs text-gray-500 mb-3">
        Pipes are indented in <b>meters</b> but enquired to vendors and PO'd in <b>kg</b>.
        This table holds <b>kg per meter</b> by Class + Size. Enter kg/m directly, or fill
        weight-per-pipe + length and it derives kg/m.
      </p>

      {/* Add / edit row */}
      <div className="bg-blue-50 border border-blue-200 rounded p-3 mb-4">
        <div className="text-xs font-semibold text-blue-800 mb-2">{draft.id ? 'Edit row' : 'Add a pipe'}</div>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
          <div>
            <label className="label text-[10px] mb-0.5">Class *</label>
            <input className="input text-xs" placeholder="C / B" value={draft.pipe_class}
              onChange={e => setDraft({ ...draft, pipe_class: e.target.value })} />
          </div>
          <div>
            <label className="label text-[10px] mb-0.5">Size *</label>
            <input className="input text-xs" placeholder="100 mm" value={draft.size}
              onChange={e => setDraft({ ...draft, size: e.target.value })} />
          </div>
          <div>
            <label className="label text-[10px] mb-0.5">kg / meter</label>
            <input className="input text-xs" type="number" step="0.001" placeholder="auto" value={draft.kg_per_meter}
              onChange={e => setDraft({ ...draft, kg_per_meter: e.target.value })} />
          </div>
          <div>
            <label className="label text-[10px] mb-0.5">Wt / pipe (kg)</label>
            <input className="input text-xs" type="number" step="0.01" placeholder="optional" value={draft.weight_per_pipe}
              onChange={e => setDraft({ ...draft, weight_per_pipe: e.target.value })} />
          </div>
          <div>
            <label className="label text-[10px] mb-0.5">Length (m)</label>
            <input className="input text-xs" type="number" step="0.1" value={draft.pipe_length_m}
              onChange={e => setDraft({ ...draft, pipe_length_m: e.target.value })} />
          </div>
          <div className="flex gap-1">
            <button onClick={save} disabled={saving} className="btn btn-primary text-xs px-3 py-1.5 flex-1">
              {draft.id ? <FiCheck size={13} /> : <FiPlus size={13} />} {draft.id ? 'Save' : 'Add'}
            </button>
            {draft.id && (
              <button onClick={() => setDraft(blank)} className="btn btn-secondary text-xs px-2 py-1.5" title="Cancel edit"><FiX size={13} /></button>
            )}
          </div>
        </div>
        {derived > 0 && (
          <div className="text-[11px] text-blue-700 mt-1.5">→ Will store <b>{derived} kg/m</b>{(+draft.kg_per_meter > 0) ? '' : ' (derived from weight ÷ length)'}.</div>
        )}
      </div>

      {/* Table */}
      <div className="overflow-auto max-h-[50vh]">
        <table className="text-xs w-full freeze-head">
          <thead><tr className="bg-gray-100">
            <th className="px-2 py-1.5 text-left">Class</th>
            <th className="px-2 py-1.5 text-left">Size</th>
            <th className="px-2 py-1.5 text-right">kg / meter</th>
            <th className="px-2 py-1.5 text-right">Wt / pipe</th>
            <th className="px-2 py-1.5 text-right">Length</th>
            <th className="px-2 py-1.5 text-center">Status</th>
            <th className="px-2 py-1.5 text-right">Actions</th>
          </tr></thead>
          <tbody>
            {loading && <tr><td colSpan="7" className="text-center py-6 text-gray-400">Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan="7" className="text-center py-6 text-gray-400">No pipe weights yet — add one above.</td></tr>}
            {!loading && rows.map(r => (
              <tr key={r.id} className={`border-b border-gray-100 ${draft.id === r.id ? 'bg-amber-50' : ''} ${!r.active ? 'opacity-50' : ''}`}>
                <td className="px-2 py-1.5 font-semibold">{r.pipe_class}</td>
                <td className="px-2 py-1.5">{r.size}</td>
                <td className="px-2 py-1.5 text-right font-semibold text-blue-800">{r.kg_per_meter}</td>
                <td className="px-2 py-1.5 text-right text-gray-500">{r.weight_per_pipe ?? '—'}</td>
                <td className="px-2 py-1.5 text-right text-gray-500">{r.pipe_length_m ?? '—'}</td>
                <td className="px-2 py-1.5 text-center">
                  <span className={`px-2 py-0.5 rounded text-[10px] ${r.active ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500'}`}>{r.active ? 'Active' : 'Off'}</span>
                </td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap">
                  <button onClick={() => setDraft({ id: r.id, pipe_class: r.pipe_class, size: r.size, kg_per_meter: r.kg_per_meter, weight_per_pipe: r.weight_per_pipe ?? '', pipe_length_m: r.pipe_length_m ?? 6, active: r.active })}
                    className="p-1 text-gray-400 hover:text-blue-600" title="Edit"><FiEdit2 size={13} /></button>
                  <button onClick={() => remove(r)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={13} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
