// Induction Admin Tab — manage content shown on the /induction page.
//
// Mam (2026-05-22 Phase 1 Batch E, module #11): 5 standard sections
// (Founder Message / Company Culture / HR Policies / IT-Security /
// SOPs).  Each item is a video URL, PDF link, plain text, or generic
// link.  Employees see the read-only digest at /induction.

import { useEffect, useState } from 'react';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';
import {
  FiPlus, FiEdit2, FiTrash2, FiAward, FiToggleLeft, FiToggleRight,
  FiVideo, FiFileText, FiLink, FiAlignLeft,
} from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';

const SECTIONS = [
  { id: 'founder',      label: 'Founder Message',  color: 'bg-purple-500' },
  { id: 'culture',      label: 'Company Culture',  color: 'bg-blue-500' },
  { id: 'hr_policies',  label: 'HR Policies',      color: 'bg-emerald-500' },
  { id: 'it_security',  label: 'IT / Security',    color: 'bg-amber-500' },
  { id: 'sop',          label: 'SOPs',             color: 'bg-rose-500' },
];

const TYPE_ICON = { text: FiAlignLeft, video: FiVideo, pdf: FiFileText, link: FiLink };

export default function InductionTab() {
  const { canDelete } = useAuth();
  const [rows, setRows] = useState([]);
  const [filterSection, setFilterSection] = useState('all');
  const [showInactive, setShowInactive] = useState(false);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});

  const load = () =>
    api.get('/hr/induction')
      .then(r => setRows(r.data || []))
      .catch(e => toast.error(e.response?.data?.error || 'Failed'));
  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({
      section: filterSection !== 'all' ? filterSection : 'founder',
      title: '', content_type: 'text', content_url: '', content_text: '',
      order_index: rows.length,
    });
    setModal('form');
  };
  const openEdit = (it) => {
    setEditing(it);
    setForm({ ...it, is_active: !!it.is_active });
    setModal('form');
  };
  const save = async (e) => {
    e.preventDefault();
    try {
      if (editing) await api.put(`/hr/induction/${editing.id}`, form);
      else         await api.post('/hr/induction', form);
      toast.success(editing ? 'Updated' : 'Added');
      setModal(false); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Save failed'); }
  };
  const toggleActive = async (it) => {
    try { await api.put(`/hr/induction/${it.id}`, { is_active: !it.is_active }); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const remove = async (it) => {
    if (!confirm(`Remove "${it.title}" from induction?`)) return;
    try { await api.delete(`/hr/induction/${it.id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
  };

  const counts = SECTIONS.reduce((acc, s) => {
    acc[s.id] = rows.filter(r => r.section === s.id && (showInactive || r.is_active)).length;
    return acc;
  }, {});
  const visible = rows.filter(r =>
    (showInactive || r.is_active) &&
    (filterSection === 'all' || r.section === filterSection)
  );

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div>
          <h3 className="font-semibold flex items-center gap-2"><FiAward /> Induction Content</h3>
          <p className="text-[11px] text-gray-500">
            Welcome content new employees see at <code className="bg-gray-100 px-1 rounded">/induction</code> — videos, policies, SOPs
          </p>
        </div>
        <button onClick={openCreate} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Item</button>
      </div>

      {/* Section pills */}
      <div className="flex gap-2 flex-wrap items-center">
        <button
          onClick={() => setFilterSection('all')}
          className={`btn ${filterSection === 'all' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}
        >
          All <span className={`px-1.5 rounded-full text-[10px] font-bold min-w-[22px] text-center ${filterSection === 'all' ? 'bg-white/30 text-white' : 'text-white bg-gray-500'}`}>{rows.length}</span>
        </button>
        {SECTIONS.map(s => {
          const active = filterSection === s.id;
          return (
            <button key={s.id} onClick={() => setFilterSection(s.id)}
              className={`btn ${active ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}>
              {s.label}
              <span className={`px-1.5 rounded-full text-[10px] font-bold min-w-[22px] text-center ${active ? 'bg-white/30 text-white' : `text-white ${s.color}`}`}>{counts[s.id] || 0}</span>
            </button>
          );
        })}
        <label className="flex items-center gap-1.5 text-[12px] text-gray-600">
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="text-sm w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase w-[160px]">Section / Type</th>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Title / Content</th>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase w-[120px]">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(it => {
              const sec = SECTIONS.find(s => s.id === it.section);
              const Icon = TYPE_ICON[it.content_type] || FiAlignLeft;
              return (
                <tr key={it.id} className={`border-t hover:bg-gray-50/60 align-top ${!it.is_active ? 'opacity-50' : ''}`}>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded text-white ${sec?.color || 'bg-gray-400'}`}>
                      {sec?.label || it.section}
                    </span>
                    <div className="text-[10px] text-gray-500 mt-1 uppercase flex items-center gap-1"><Icon size={11}/>{it.content_type}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-900">{it.title}</div>
                    {it.content_url && (
                      <a href={it.content_url} target="_blank" rel="noreferrer" className="text-[11px] text-blue-700 hover:underline break-all">
                        {it.content_url.slice(0, 80)}{it.content_url.length > 80 ? '…' : ''}
                      </a>
                    )}
                    {it.content_text && (
                      <div className="text-[11px] text-gray-500 mt-0.5 line-clamp-2 whitespace-pre-wrap">{it.content_text}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      <button onClick={() => toggleActive(it)} className={`p-1 ${it.is_active ? 'text-emerald-600' : 'text-gray-400'} hover:text-emerald-700`} title={it.is_active ? 'Disable' : 'Enable'}>
                        {it.is_active ? <FiToggleRight size={16}/> : <FiToggleLeft size={16}/>}
                      </button>
                      <button onClick={() => openEdit(it)} className="p-1 text-gray-400 hover:text-blue-600" title="Edit"><FiEdit2 size={14}/></button>
                      {canDelete('hr') && (
                        <button onClick={() => remove(it)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14}/></button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr><td colSpan="3" className="text-center py-8 text-gray-400">
                {rows.length === 0 ? 'No induction content yet — add the first item' : 'No items in this section'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal isOpen={modal === 'form'} onClose={() => setModal(false)} title={editing ? 'Edit Induction Item' : 'Add Induction Item'} wide>
        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Section *</label>
              <select className="select" required value={form.section || ''} onChange={e => setForm({ ...form, section: e.target.value })}>
                {SECTIONS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Type *</label>
              <select className="select" required value={form.content_type || 'text'} onChange={e => setForm({ ...form, content_type: e.target.value })}>
                <option value="text">Text (paragraph / markdown)</option>
                <option value="video">Video (YouTube / Vimeo / direct URL)</option>
                <option value="pdf">PDF (URL to PDF file)</option>
                <option value="link">External Link</option>
              </select>
            </div>
          </div>
          <div>
            <label className="label">Title *</label>
            <input className="input" required value={form.title || ''} onChange={e => setForm({ ...form, title: e.target.value })}
              placeholder="e.g. Welcome from MD" />
          </div>
          {form.content_type !== 'text' && (
            <div>
              <label className="label">URL *</label>
              <input className="input" required value={form.content_url || ''} onChange={e => setForm({ ...form, content_url: e.target.value })}
                placeholder={form.content_type === 'video' ? 'https://youtube.com/watch?v=...' : form.content_type === 'pdf' ? 'https://.../policy.pdf' : 'https://...'} />
            </div>
          )}
          {form.content_type === 'text' && (
            <div>
              <label className="label">Content</label>
              <textarea className="input" rows="6" value={form.content_text || ''} onChange={e => setForm({ ...form, content_text: e.target.value })}
                placeholder="Paste the message / policy text here. Line breaks are preserved." />
            </div>
          )}
          <div>
            <label className="label">Display Order</label>
            <input className="input w-24" type="number" value={form.order_index ?? 0} onChange={e => setForm({ ...form, order_index: +e.target.value })} />
          </div>
          {editing && (
            <label className="flex items-center gap-2 text-[12px]">
              <input type="checkbox" checked={!!form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} />
              <span>Active (visible to employees)</span>
            </label>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Add Item'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
