// Screening Questions Tab — manage the screening form and its auto-
// rejection rules.
//
// Mam (2026-05-22 Phase 1 Batch C, modules #5 + #6):
//   • Role-based forms (per hiring_request) OR GLOBAL (apply to all)
//   • Types: MCQ / Descriptive / Yes-No / Number
//   • Auto-reject rules: gt / lt / gte / lte / eq / neq / contains /
//     not_contains / in / not_in
//   • Mandatory questions → if unanswered, candidate is 'partial'
//   • Rule fires → candidate is 'rejected' (auto)
//
// The actual "submit screening for a candidate" flow lives inline in
// HR.jsx as part of the candidate row (Run Screening button) so HR
// doesn't have to leave the pipeline view.

import { useEffect, useState } from 'react';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';
import {
  FiPlus, FiEdit2, FiTrash2, FiClipboard, FiAlertTriangle,
  FiToggleLeft, FiToggleRight, FiGlobe, FiBriefcase,
} from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';

const QUESTION_TYPES = [
  { v: 'descriptive', l: 'Descriptive (free text)' },
  { v: 'mcq',         l: 'Multiple Choice' },
  { v: 'yes_no',      l: 'Yes / No' },
  { v: 'number',      l: 'Number' },
];

const REJECT_OPS = [
  { v: '',             l: 'No auto-reject rule' },
  { v: 'gt',           l: 'Greater than' },
  { v: 'gte',          l: 'Greater than or equal' },
  { v: 'lt',           l: 'Less than' },
  { v: 'lte',          l: 'Less than or equal' },
  { v: 'eq',           l: 'Equals' },
  { v: 'neq',          l: 'Not equals' },
  { v: 'contains',     l: 'Contains text' },
  { v: 'not_contains', l: "Doesn't contain" },
  { v: 'in',           l: 'Is one of (csv)' },
  { v: 'not_in',       l: 'Is NOT one of (csv)' },
];

export default function ScreeningQuestionsTab() {
  const { canDelete } = useAuth();
  const [rows, setRows] = useState([]);
  const [hiringRequests, setHiringRequests] = useState([]);
  const [filterReq, setFilterReq] = useState('');           // '' all | 'global' | <id>
  const [showInactive, setShowInactive] = useState(false);

  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});

  const load = async () => {
    try {
      const [qRes, hrRes] = await Promise.all([
        api.get('/hr/screening-questions'),
        api.get('/hr/hiring-requests'),
      ]);
      setRows(qRes.data || []);
      setHiringRequests(hrRes.data || []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load');
    }
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({
      hiring_request_id: filterReq && filterReq !== 'global' ? +filterReq : null,
      question_text: '', question_type: 'descriptive',
      options: '', is_mandatory: false,
      auto_reject_op: '', auto_reject_value: '', auto_reject_reason: '',
      order_index: rows.length,
    });
    setModal('form');
  };

  const openEdit = (q) => {
    setEditing(q);
    setForm({
      ...q,
      options: Array.isArray(q.options) ? q.options.join('\n') : (q.options || ''),
      is_mandatory: !!q.is_mandatory,
      is_active: !!q.is_active,
      auto_reject_op: q.auto_reject_op || '',
      auto_reject_value: q.auto_reject_value || '',
      auto_reject_reason: q.auto_reject_reason || '',
    });
    setModal('form');
  };

  const save = async (e) => {
    e.preventDefault();
    try {
      // Parse MCQ options (one per line) into a JSON array
      let optionsPayload = null;
      if (form.question_type === 'mcq') {
        const arr = String(form.options || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (arr.length < 2) return toast.error('MCQ needs at least 2 options (one per line)');
        optionsPayload = arr;
      }
      const payload = {
        ...form,
        hiring_request_id: form.hiring_request_id ? +form.hiring_request_id : null,
        options: optionsPayload,
        auto_reject_op: form.auto_reject_op || null,
        auto_reject_value: form.auto_reject_op ? form.auto_reject_value : null,
        auto_reject_reason: form.auto_reject_op ? form.auto_reject_reason : null,
      };
      if (editing) await api.put(`/hr/screening-questions/${editing.id}`, payload);
      else         await api.post('/hr/screening-questions', payload);
      toast.success(editing ? 'Updated' : 'Question added');
      setModal(false); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    }
  };

  const remove = async (q) => {
    if (!confirm(`Delete this screening question? "${q.question_text.slice(0, 60)}…"\nAll answers to this question will be deleted too.`)) return;
    try { await api.delete(`/hr/screening-questions/${q.id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
  };

  const toggleActive = async (q) => {
    try {
      await api.put(`/hr/screening-questions/${q.id}`, { is_active: !q.is_active });
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Toggle failed'); }
  };

  const positionName = (id) => {
    if (id == null) return 'GLOBAL';
    return hiringRequests.find(h => h.id === id)?.position_title || `Request #${id}`;
  };

  // Client-side filter
  const visible = rows.filter(q => {
    if (!showInactive && !q.is_active) return false;
    if (filterReq === 'global') return q.hiring_request_id == null;
    if (filterReq && filterReq !== 'all') return q.hiring_request_id === +filterReq;
    return true;
  });

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div>
          <h3 className="font-semibold flex items-center gap-2"><FiClipboard /> Screening Questions</h3>
          <p className="text-[11px] text-gray-500">
            Phone-screen questions with auto-reject rules · per-position or GLOBAL (apply to all candidates)
          </p>
        </div>
        <button onClick={openCreate} className="btn btn-primary flex items-center gap-2">
          <FiPlus /> Add Question
        </button>
      </div>

      {/* Filter row */}
      <div className="flex gap-2 items-center flex-wrap text-[12px]">
        <select className="select py-1 text-[12px] w-auto" value={filterReq} onChange={e => setFilterReq(e.target.value)}>
          <option value="">All questions</option>
          <option value="global">🌐 Global only</option>
          <optgroup label="Per position">
            {hiringRequests.map(h => (
              <option key={h.id} value={h.id}>{h.position_title} ({h.department})</option>
            ))}
          </optgroup>
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
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase w-[140px]">Scope / Type</th>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Question</th>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase w-[280px]">Auto-Reject Rule</th>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase w-[120px]">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(q => (
              <tr key={q.id} className={`border-t hover:bg-gray-50/60 align-top ${!q.is_active ? 'opacity-50' : ''}`}>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    {q.hiring_request_id == null
                      ? <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 flex items-center gap-1"><FiGlobe size={10}/>GLOBAL</span>
                      : <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 flex items-center gap-1"><FiBriefcase size={10}/>{positionName(q.hiring_request_id)}</span>
                    }
                  </div>
                  <div className="text-[10px] text-gray-500 mt-1 uppercase">{q.question_type.replace(/_/g, ' ')}</div>
                  {!!q.is_mandatory && <div className="text-[10px] text-red-600 mt-0.5 font-bold">MANDATORY *</div>}
                </td>
                <td className="px-3 py-2">
                  <div className="text-gray-900">{q.question_text}</div>
                  {q.question_type === 'mcq' && q.options && (
                    <div className="text-[11px] text-gray-500 mt-1">
                      Options: {Array.isArray(q.options) ? q.options.join(' · ') : q.options}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-[11px]">
                  {q.auto_reject_op ? (
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-1 text-red-700 font-semibold">
                        <FiAlertTriangle size={11}/>
                        Reject if answer <b>{REJECT_OPS.find(o => o.v === q.auto_reject_op)?.l || q.auto_reject_op}</b> <code className="text-[11px] bg-red-50 px-1 rounded">{q.auto_reject_value}</code>
                      </div>
                      {q.auto_reject_reason && <div className="text-gray-500 italic text-[10px]">↳ {q.auto_reject_reason}</div>}
                    </div>
                  ) : (
                    <span className="text-gray-400">No rule (info only)</span>
                  )}
                </td>
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
            ))}
            {visible.length === 0 && (
              <tr><td colSpan="4" className="text-center py-8 text-gray-400">
                {rows.length === 0
                  ? 'No screening questions yet — add the first one'
                  : 'No questions match the current filters'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ─── CREATE / EDIT MODAL ─── */}
      <Modal isOpen={modal === 'form'} onClose={() => setModal(false)} title={editing ? 'Edit Screening Question' : 'Add Screening Question'} wide>
        <form onSubmit={save} className="space-y-3 max-h-[75vh] overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Applies To</label>
              <select className="select" value={form.hiring_request_id || ''} onChange={e => setForm({ ...form, hiring_request_id: e.target.value ? +e.target.value : null })}>
                <option value="">🌐 Global (all candidates)</option>
                {hiringRequests.map(h => <option key={h.id} value={h.id}>{h.position_title} ({h.department})</option>)}
              </select>
            </div>
            <div>
              <label className="label">Question Type *</label>
              <select className="select" required value={form.question_type || 'descriptive'} onChange={e => setForm({ ...form, question_type: e.target.value })}>
                {QUESTION_TYPES.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="label">Question Text *</label>
            <textarea className="input" rows="2" required value={form.question_text || ''} onChange={e => setForm({ ...form, question_text: e.target.value })}
              placeholder="e.g. What is your current notice period (in days)?" />
          </div>
          {form.question_type === 'mcq' && (
            <div>
              <label className="label">Options <span className="text-gray-400 font-normal text-[10px]">(one per line)</span></label>
              <textarea className="input" rows="4" value={form.options || ''} onChange={e => setForm({ ...form, options: e.target.value })}
                placeholder={`Yes\nNo\nMaybe`} />
            </div>
          )}
          <label className="flex items-center gap-2 text-[12px]">
            <input type="checkbox" checked={!!form.is_mandatory} onChange={e => setForm({ ...form, is_mandatory: e.target.checked })} />
            <span>Mandatory <span className="text-gray-500">(unanswered → candidate marked "partial")</span></span>
          </label>

          {/* ── Auto-reject rule block ── */}
          <div className="border border-amber-200 bg-amber-50/40 rounded-lg p-3 space-y-3">
            <p className="text-[11px] font-semibold text-amber-800 flex items-center gap-1">
              <FiAlertTriangle size={12}/> Auto-Reject Rule (optional)
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">When the answer is…</label>
                <select className="select" value={form.auto_reject_op || ''} onChange={e => setForm({ ...form, auto_reject_op: e.target.value })}>
                  {REJECT_OPS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Value</label>
                <input
                  className="input"
                  value={form.auto_reject_value || ''}
                  onChange={e => setForm({ ...form, auto_reject_value: e.target.value })}
                  placeholder={form.auto_reject_op === 'in' || form.auto_reject_op === 'not_in' ? 'comma,separated,list' : (form.question_type === 'number' ? '30' : 'value')}
                  disabled={!form.auto_reject_op}
                />
              </div>
            </div>
            <div>
              <label className="label">Reject Reason <span className="text-gray-400 font-normal text-[10px]">(shown to HR when this rule fires)</span></label>
              <input
                className="input"
                value={form.auto_reject_reason || ''}
                onChange={e => setForm({ ...form, auto_reject_reason: e.target.value })}
                placeholder="e.g. Notice period too long for our urgency"
                disabled={!form.auto_reject_op}
              />
            </div>
            {form.auto_reject_op && (
              <p className="text-[10px] text-amber-800">
                Example trigger: candidate answer <code className="bg-white px-1 rounded">{form.question_type === 'number' ? '45' : 'sample'}</code> would
                {' '}{evalPreview(form) ? <b>REJECT</b> : 'pass'}
              </p>
            )}
          </div>

          {editing && (
            <label className="flex items-center gap-2 text-[12px]">
              <input type="checkbox" checked={!!form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} />
              <span>Active (included in candidate screening forms)</span>
            </label>
          )}

          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Add Question'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

// Mirrors the server-side evalRule() so the form can show a live
// preview ("would this rule fire?") as admin types.
function evalPreview(f) {
  const sampleAns = f.question_type === 'number' ? '45' : 'sample';
  return evalRuleLocal(sampleAns, f.auto_reject_op, f.auto_reject_value);
}
function evalRuleLocal(a, op, v) {
  if (!op) return false;
  a = String(a || '').trim(); v = String(v || '').trim();
  if (!a && a !== '0') return false;
  switch (op) {
    case 'eq':           return a.toLowerCase() === v.toLowerCase();
    case 'neq':          return a.toLowerCase() !== v.toLowerCase();
    case 'gt':           return Number(a) >  Number(v);
    case 'lt':           return Number(a) <  Number(v);
    case 'gte':          return Number(a) >= Number(v);
    case 'lte':          return Number(a) <= Number(v);
    case 'contains':     return a.toLowerCase().includes(v.toLowerCase());
    case 'not_contains': return !a.toLowerCase().includes(v.toLowerCase());
    case 'in': {
      const list = v.split(/[,;|]/).map(s => s.trim().toLowerCase()).filter(Boolean);
      return list.includes(a.toLowerCase());
    }
    case 'not_in': {
      const list = v.split(/[,;|]/).map(s => s.trim().toLowerCase()).filter(Boolean);
      return !list.includes(a.toLowerCase());
    }
    default: return false;
  }
}
