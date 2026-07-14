// Final-Round Question Bank — curated questions for the MD round.
//
// Mam (2026-05-22 Phase 1 Batch B, module #8):
//   • Question bank organised by category (Leadership / Ownership /
//     Decision Making / Conflict Management / Team Handling)
//   • Each question tagged with for_role + difficulty + panel notes
//   • "Random pick" button to grab N questions for an upcoming round
//
// 25 starter questions seeded in schema.js so the page is useful
// on day 1.  HR / admin can add / edit / disable from this tab.

import { useEffect, useState } from 'react';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';
import {
  FiPlus, FiEdit2, FiTrash2, FiAward, FiShuffle, FiCopy,
  FiToggleLeft, FiToggleRight,
} from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';

// Spec categories — used both for the filter pills and the create form.
const CATEGORIES = [
  { id: 'Leadership',          color: 'bg-purple-500' },
  { id: 'Ownership',           color: 'bg-emerald-500' },
  { id: 'Decision Making',     color: 'bg-blue-500' },
  { id: 'Conflict Management', color: 'bg-amber-500' },
  { id: 'Team Handling',       color: 'bg-rose-500' },
];

const DIFFICULTIES = ['easy','medium','hard'];

export default function FinalRoundQuestionsTab() {
  const { canDelete } = useAuth();
  const [rows, setRows] = useState([]);
  const [catFilter, setCatFilter] = useState('all');
  const [roleFilter, setRoleFilter] = useState('');
  const [diffFilter, setDiffFilter] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  // Modals
  const [modal, setModal] = useState(false);                  // false | 'form' | 'pick'
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});

  // Pick-N state
  const [pickN, setPickN] = useState(5);
  const [pickResult, setPickResult] = useState([]);

  const load = () => {
    api.get('/hr/final-round-questions')
      .then(r => setRows(r.data || []))
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load questions'));
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({
      category: CATEGORIES[0].id, question_text: '',
      for_role: 'Any', difficulty: 'medium', notes: '', is_active: true,
    });
    setModal('form');
  };
  const openEdit = (q) => {
    setEditing(q);
    setForm({ ...q, is_active: !!q.is_active });
    setModal('form');
  };
  const save = async (e) => {
    e.preventDefault();
    try {
      if (editing) await api.put(`/hr/final-round-questions/${editing.id}`, form);
      else         await api.post('/hr/final-round-questions', form);
      toast.success(editing ? 'Updated' : 'Question added');
      setModal(false); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    }
  };
  const remove = async (q) => {
    if (!confirm(`Delete this question? "${q.question_text.slice(0, 60)}…"`)) return;
    try { await api.delete(`/hr/final-round-questions/${q.id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
  };
  const toggleActive = async (q) => {
    try {
      await api.put(`/hr/final-round-questions/${q.id}`, { is_active: !q.is_active });
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Toggle failed'); }
  };

  // Pick N random questions, optionally filtered
  const runPick = async () => {
    try {
      const params = new URLSearchParams();
      params.set('n', String(pickN));
      if (catFilter !== 'all') params.set('category', catFilter);
      if (roleFilter)          params.set('for_role', roleFilter);
      if (diffFilter)          params.set('difficulty', diffFilter);
      const r = await api.get(`/hr/final-round-questions/pick?${params.toString()}`);
      setPickResult(r.data || []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Pick failed');
    }
  };

  const copyPick = () => {
    const text = pickResult.map((q, i) => `${i + 1}. [${q.category}] ${q.question_text}${q.notes ? `\n   (look for: ${q.notes})` : ''}`).join('\n\n');
    navigator.clipboard.writeText(text).then(
      () => toast.success('Question list copied — paste into your panel notes'),
      () => toast.error('Clipboard blocked')
    );
  };

  // Apply client-side filters (server already has them too, but we
  // already have all rows loaded so filter in-browser for snappy UX)
  const visible = rows.filter(q => {
    if (!showInactive && !q.is_active) return false;
    if (catFilter !== 'all' && q.category !== catFilter) return false;
    if (roleFilter && q.for_role !== roleFilter && q.for_role !== 'Any' && q.for_role !== null) return false;
    if (diffFilter && q.difficulty !== diffFilter) return false;
    return true;
  });

  const counts = CATEGORIES.reduce((acc, c) => {
    acc[c.id] = rows.filter(q => q.category === c.id && (showInactive || q.is_active)).length;
    return acc;
  }, {});

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div>
          <h3 className="font-semibold flex items-center gap-2"><FiAward /> Final Round Question Bank</h3>
          <p className="text-[11px] text-gray-500">
            Curated behavioural questions for the MD round — pick N random when prepping a panel
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => { setModal('pick'); setPickResult([]); }} className="btn btn-secondary flex items-center gap-2">
            <FiShuffle /> Pick {pickN} Random
          </button>
          <button onClick={openCreate} className="btn btn-primary flex items-center gap-2">
            <FiPlus /> Add Question
          </button>
        </div>
      </div>

      {/* Category pills */}
      <div className="flex gap-2 flex-wrap items-center">
        <button
          onClick={() => setCatFilter('all')}
          className={`btn ${catFilter === 'all' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}
        >
          All
          <span className={`px-1.5 rounded-full text-[10px] font-bold min-w-[22px] text-center ${catFilter === 'all' ? 'bg-white/30 text-white' : 'text-white bg-gray-500'}`}>
            {rows.filter(q => showInactive || q.is_active).length}
          </span>
        </button>
        {CATEGORIES.map(c => {
          const active = catFilter === c.id;
          return (
            <button
              key={c.id}
              onClick={() => setCatFilter(c.id)}
              className={`btn ${active ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}
            >
              {c.id}
              <span className={`px-1.5 rounded-full text-[10px] font-bold min-w-[22px] text-center ${active ? 'bg-white/30 text-white' : `text-white ${c.color}`}`}>
                {counts[c.id] || 0}
              </span>
            </button>
          );
        })}
      </div>

      {/* Sub-filters row */}
      <div className="flex gap-2 items-center flex-wrap text-[12px]">
        <select className="select py-1 text-[12px] w-auto" value={roleFilter} onChange={e => setRoleFilter(e.target.value)}>
          <option value="">Any Role</option>
          <option value="Manager">Manager</option>
          <option value="IC">Individual Contributor</option>
          <option value="Sales">Sales</option>
          <option value="Engineer">Engineer</option>
          <option value="Any">Any (explicit)</option>
        </select>
        <select className="select py-1 text-[12px] w-auto" value={diffFilter} onChange={e => setDiffFilter(e.target.value)}>
          <option value="">Any Difficulty</option>
          {DIFFICULTIES.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-gray-600">
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
      </div>

      {/* List */}
      <div className="card p-0 overflow-x-auto">
        <table className="text-sm w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase w-[140px]">Category / Diff</th>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Question</th>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase w-[100px]">For Role</th>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase w-[120px]">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(q => {
              const cat = CATEGORIES.find(c => c.id === q.category);
              return (
                <tr key={q.id} className={`border-t hover:bg-gray-50/60 align-top ${!q.is_active ? 'opacity-50' : ''}`}>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded text-white ${cat?.color || 'bg-gray-400'}`}>
                      {q.category}
                    </span>
                    <div className="text-[10px] text-gray-500 mt-1 uppercase">{q.difficulty}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-gray-900">{q.question_text}</div>
                    {q.notes && <div className="text-[11px] text-gray-500 mt-1 italic">↳ {q.notes}</div>}
                  </td>
                  <td className="px-3 py-2 text-[11px] text-gray-600">{q.for_role || '—'}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      <button
                        onClick={() => toggleActive(q)}
                        className={`p-1 ${q.is_active ? 'text-emerald-600 hover:text-emerald-700' : 'text-gray-400 hover:text-emerald-600'}`}
                        title={q.is_active ? 'Disable' : 'Enable'}>
                        {q.is_active ? <FiToggleRight size={16}/> : <FiToggleLeft size={16}/>}
                      </button>
                      <button onClick={() => openEdit(q)} className="p-1 text-gray-400 hover:text-blue-600" title="Edit"><FiEdit2 size={14}/></button>
                      {canDelete('hr') && (
                        <button onClick={() => remove(q)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14}/></button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr><td colSpan="4" className="text-center py-8 text-gray-400">
                {rows.length === 0 ? 'Question bank is empty — add the first question' : 'No questions match the current filters'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ─── CREATE / EDIT MODAL ─── */}
      <Modal isOpen={modal === 'form'} onClose={() => setModal(false)} title={editing ? 'Edit Question' : 'Add Final-Round Question'} wide>
        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="label">Category *</label>
              <select className="select" required value={form.category || ''} onChange={e => setForm({ ...form, category: e.target.value })}>
                {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.id}</option>)}
              </select>
            </div>
            <div>
              <label className="label">For Role</label>
              <select className="select" value={form.for_role || 'Any'} onChange={e => setForm({ ...form, for_role: e.target.value })}>
                <option value="Any">Any</option>
                <option value="Manager">Manager</option>
                <option value="IC">Individual Contributor</option>
                <option value="Sales">Sales</option>
                <option value="Engineer">Engineer</option>
              </select>
            </div>
            <div>
              <label className="label">Difficulty</label>
              <select className="select" value={form.difficulty || 'medium'} onChange={e => setForm({ ...form, difficulty: e.target.value })}>
                {DIFFICULTIES.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="label">Question Text *</label>
            <textarea className="input" rows="3" required value={form.question_text || ''} onChange={e => setForm({ ...form, question_text: e.target.value })}
              placeholder="e.g. Tell us about a time you made a tough call without complete data." />
          </div>
          <div>
            <label className="label">Panel Notes <span className="text-gray-400 font-normal text-[10px]">(what to listen for / good answer cues)</span></label>
            <textarea className="input" rows="2" value={form.notes || ''} onChange={e => setForm({ ...form, notes: e.target.value })}
              placeholder="e.g. Look for: structured trade-off thinking, willingness to be wrong, follow-up after." />
          </div>
          <label className="flex items-center gap-2 text-[12px]">
            <input type="checkbox" checked={!!form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} />
            <span>Active (include in random picks)</span>
          </label>
          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Add Question'}</button>
          </div>
        </form>
      </Modal>

      {/* ─── PICK RANDOM N MODAL ─── */}
      <Modal isOpen={modal === 'pick'} onClose={() => setModal(false)} title="Pick Random Questions for Final Round" wide>
        <div className="space-y-3">
          <p className="text-[11px] text-blue-700 bg-blue-50 border border-blue-100 rounded px-3 py-2">
            Generates a panel-ready list of random questions using the filters currently active above (Category / Role / Difficulty).
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-[12px] font-semibold">How many?</label>
            <input type="number" min="1" max="20" className="input w-20" value={pickN} onChange={e => setPickN(Math.max(1, Math.min(20, +e.target.value || 5)))} />
            <button onClick={runPick} className="btn btn-primary flex items-center gap-1 text-[12px] py-1 px-3"><FiShuffle size={12}/> Pick</button>
            {pickResult.length > 0 && (
              <button onClick={copyPick} className="btn btn-secondary flex items-center gap-1 text-[12px] py-1 px-3"><FiCopy size={12}/> Copy to clipboard</button>
            )}
          </div>
          {pickResult.length > 0 && (
            <div className="space-y-2 max-h-[55vh] overflow-y-auto">
              {pickResult.map((q, i) => {
                const cat = CATEGORIES.find(c => c.id === q.category);
                return (
                  <div key={q.id} className="border border-gray-200 rounded-lg p-3">
                    <div className="flex items-start gap-2 mb-1">
                      <span className="text-[11px] font-bold text-gray-500 w-5">{i + 1}.</span>
                      <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded text-white ${cat?.color || 'bg-gray-400'}`}>{q.category}</span>
                      <span className="text-[9px] font-bold uppercase text-gray-500">{q.difficulty}</span>
                      {q.for_role && q.for_role !== 'Any' && <span className="text-[9px] uppercase text-gray-500">· {q.for_role}</span>}
                    </div>
                    <div className="text-[13px] text-gray-900 ml-7">{q.question_text}</div>
                    {q.notes && <div className="text-[11px] text-gray-500 mt-1 ml-7 italic">↳ Look for: {q.notes}</div>}
                  </div>
                );
              })}
            </div>
          )}
          {pickResult.length === 0 && (
            <div className="text-center py-8 text-[12px] text-gray-400">Click "Pick" to generate the list</div>
          )}
          <div className="flex justify-end pt-2">
            <button onClick={() => setModal(false)} className="btn btn-secondary">Close</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
