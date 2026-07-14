// Job Descriptions Tab — manages JDs (with templates) for open positions.
//
// Mam (2026-05-22 Phase 1 Batch B, module #3):
//   • Create JD with Title / Description / Responsibilities / Skills /
//     Experience / Education
//   • Save reusable templates so HR can clone the standard SEPL JDs
//   • Each JD has TWO output flavours — Internal (full detail) and
//     Public (sanitised post for Naukri / LinkedIn)
//   • Optionally link a JD to a Hiring Request so the funnel ties up
//
// Lives as a tab inside /hr (per the no-duplicate-sidebar rule).

import { useEffect, useState } from 'react';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';
import {
  FiPlus, FiEdit2, FiTrash2, FiFileText, FiBookmark, FiCopy,
  FiEye, FiArchive, FiCheckCircle,
} from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';

const STATUS_PILLS = [
  { id: 'draft',     label: 'Draft',     bg: 'bg-gray-500' },
  { id: 'published', label: 'Published', bg: 'bg-emerald-500' },
  { id: 'archived',  label: 'Archived',  bg: 'bg-amber-500' },
];

export default function JobDescriptionsTab() {
  const { canDelete } = useAuth();
  const [jds, setJds] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [hiringRequests, setHiringRequests] = useState([]);
  const [filter, setFilter] = useState('all');
  const [modal, setModal] = useState(false);                  // false | 'form' | 'view' | 'template' | 'templatesList'
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [viewing, setViewing] = useState(null);
  const [viewMode, setViewMode] = useState('internal');        // 'internal' | 'public'

  // ── Template editor sub-state
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [templateForm, setTemplateForm] = useState({});

  const load = async () => {
    try {
      const [jdRes, tmpRes, hrRes] = await Promise.all([
        api.get('/hr/job-descriptions'),
        api.get('/hr/jd-templates'),
        api.get('/hr/hiring-requests?status=approved'),
      ]);
      setJds(jdRes.data || []);
      setTemplates(tmpRes.data || []);
      setHiringRequests(hrRes.data || []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load JDs');
    }
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({
      title: '', description: '', responsibilities: '',
      required_skills: '', required_experience: '',
      education_required: '', internal_jd: '', public_job_post: '',
      hiring_request_id: '', template_id: '', status: 'draft',
    });
    setModal('form');
  };

  const openEdit = (jd) => {
    setEditing(jd);
    setForm({ ...jd });
    setModal('form');
  };

  // Pre-fill the JD form from a template — saves admin from typing
  // the standard SEPL boilerplate every time.
  const applyTemplate = (tmplId) => {
    if (!tmplId) return;
    const t = templates.find(x => x.id === +tmplId);
    if (!t) return;
    const c = t.template_content || {};
    setForm(f => ({
      ...f,
      template_id: tmplId,
      title:               f.title               || c.title               || t.name,
      description:         f.description         || c.description         || '',
      responsibilities:    f.responsibilities    || c.responsibilities    || '',
      required_skills:     f.required_skills     || c.required_skills     || '',
      required_experience: f.required_experience || c.required_experience || '',
      education_required:  f.education_required  || c.education_required  || '',
      internal_jd:         f.internal_jd         || c.internal_jd         || '',
      public_job_post:     f.public_job_post     || c.public_job_post     || '',
    }));
    toast.success(`Applied template: ${t.name}`);
  };

  const save = async (e) => {
    e.preventDefault();
    try {
      if (editing) await api.put(`/hr/job-descriptions/${editing.id}`, form);
      else         await api.post('/hr/job-descriptions', form);
      toast.success(editing ? 'Updated' : 'JD created');
      setModal(false); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    }
  };

  const remove = async (jd) => {
    if (!confirm(`Delete JD "${jd.title}"?`)) return;
    try { await api.delete(`/hr/job-descriptions/${jd.id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
  };

  const changeStatus = async (jd, status) => {
    try {
      await api.put(`/hr/job-descriptions/${jd.id}`, { status });
      toast.success(`Marked ${status}`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Status update failed');
    }
  };

  const copyPublic = (jd) => {
    const text = jd.public_job_post || buildAutoPublic(jd);
    navigator.clipboard.writeText(text).then(
      () => toast.success('Public job post copied to clipboard'),
      () => toast.error('Clipboard blocked — please copy manually')
    );
  };

  // Fallback public-post generator when the field is blank — gives
  // admin something usable to paste even before they hand-craft the
  // public version.  Skips salary / internal-only details on purpose.
  const buildAutoPublic = (jd) => {
    const parts = [
      jd.title,
      jd.description ? `\n${jd.description}` : '',
      jd.responsibilities ? `\nKey Responsibilities:\n${jd.responsibilities}` : '',
      jd.required_skills ? `\nRequired Skills:\n${jd.required_skills}` : '',
      jd.required_experience ? `\nExperience: ${jd.required_experience}` : '',
      jd.education_required ? `\nEducation: ${jd.education_required}` : '',
      `\n\nApply: hr@securedengineers.com`,
    ];
    return parts.filter(Boolean).join('\n');
  };

  // ── Templates manager
  const openTemplateEditor = (t) => {
    setEditingTemplate(t);
    setTemplateForm(t ? {
      name: t.name, description: t.description || '',
      is_default: !!t.is_default,
      content: t.template_content || {},
    } : {
      name: '', description: '', is_default: false, content: {},
    });
    setModal('template');
  };
  const saveTemplate = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        name: templateForm.name,
        description: templateForm.description,
        is_default: !!templateForm.is_default,
        template_content: templateForm.content || {},
      };
      if (editingTemplate) await api.put(`/hr/jd-templates/${editingTemplate.id}`, payload);
      else                 await api.post('/hr/jd-templates', payload);
      toast.success(editingTemplate ? 'Template updated' : 'Template saved');
      load();
      setModal('templatesList');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    }
  };
  const deleteTemplate = async (t) => {
    if (!confirm(`Delete template "${t.name}"?`)) return;
    try { await api.delete(`/hr/jd-templates/${t.id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
  };

  // Counts for pills
  const counts = STATUS_PILLS.reduce((acc, s) => {
    acc[s.id] = jds.filter(j => j.status === s.id).length;
    return acc;
  }, {});
  const visible = filter === 'all' ? jds : jds.filter(j => j.status === filter);

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div>
          <h3 className="font-semibold flex items-center gap-2"><FiFileText /> Job Descriptions</h3>
          <p className="text-[11px] text-gray-500">
            Internal JD (full detail) + Public Job Post (for external boards) · templates for fast cloning
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setModal('templatesList')} className="btn btn-secondary flex items-center gap-2">
            <FiBookmark /> Templates ({templates.length})
          </button>
          <button onClick={openCreate} className="btn btn-primary flex items-center gap-2">
            <FiPlus /> New JD
          </button>
        </div>
      </div>

      {/* Status filter pills */}
      <div className="flex gap-2 flex-wrap items-center">
        <button
          onClick={() => setFilter('all')}
          className={`btn ${filter === 'all' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}
        >
          All
          <span className={`px-1.5 rounded-full text-[10px] font-bold min-w-[22px] text-center ${filter === 'all' ? 'bg-white/30 text-white' : 'text-white bg-gray-500'}`}>
            {jds.length}
          </span>
        </button>
        {STATUS_PILLS.map(s => {
          const active = filter === s.id;
          return (
            <button
              key={s.id}
              onClick={() => setFilter(s.id)}
              className={`btn ${active ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}
            >
              {s.label}
              <span className={`px-1.5 rounded-full text-[10px] font-bold min-w-[22px] text-center ${active ? 'bg-white/30 text-white' : `text-white ${s.bg}`}`}>
                {counts[s.id] || 0}
              </span>
            </button>
          );
        })}
      </div>

      {/* List */}
      <div className="card p-0 overflow-x-auto">
        <table className="text-sm w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Title / Hiring Request</th>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Skills / Experience</th>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Status</th>
              <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(jd => (
              <tr key={jd.id} className="border-t hover:bg-gray-50/60 align-top">
                <td className="px-3 py-2">
                  <div className="font-medium text-gray-900">{jd.title}</div>
                  {jd.hiring_request_position && (
                    <div className="text-[11px] text-gray-500">
                      ↳ Hiring Request: {jd.hiring_request_position} ({jd.hiring_request_department})
                    </div>
                  )}
                  {jd.template_name && (
                    <div className="text-[10px] text-gray-400">from template: {jd.template_name}</div>
                  )}
                </td>
                <td className="px-3 py-2 text-[11px]">
                  {jd.required_skills && <div className="line-clamp-2">{jd.required_skills}</div>}
                  {jd.required_experience && <div className="text-gray-500 mt-0.5">Exp: {jd.required_experience}</div>}
                </td>
                <td className="px-3 py-2">
                  {(() => {
                    const sp = STATUS_PILLS.find(s => s.id === jd.status);
                    return <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded text-white ${sp?.bg || 'bg-gray-400'}`}>{sp?.label || jd.status}</span>;
                  })()}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    <button
                      onClick={() => { setViewing(jd); setViewMode('internal'); setModal('view'); }}
                      className="btn btn-secondary text-[11px] py-1 px-2"
                      title="View internal / public JD">
                      <FiEye size={11} className="inline mr-1"/>View
                    </button>
                    {jd.status === 'draft' && (
                      <button onClick={() => changeStatus(jd, 'published')} className="btn btn-primary text-[11px] py-1 px-2 bg-emerald-600 hover:bg-emerald-700 border-emerald-600">
                        <FiCheckCircle size={11} className="inline mr-1"/>Publish
                      </button>
                    )}
                    {jd.status === 'published' && (
                      <button onClick={() => changeStatus(jd, 'archived')} className="btn btn-secondary text-[11px] py-1 px-2">
                        <FiArchive size={11} className="inline mr-1"/>Archive
                      </button>
                    )}
                    <button onClick={() => copyPublic(jd)} className="p-1 text-gray-400 hover:text-blue-600" title="Copy public job post">
                      <FiCopy size={14} />
                    </button>
                    <button onClick={() => openEdit(jd)} className="p-1 text-gray-400 hover:text-blue-600" title="Edit">
                      <FiEdit2 size={14} />
                    </button>
                    {canDelete('hr') && (
                      <button onClick={() => remove(jd)} className="p-1 text-gray-400 hover:text-red-600" title="Delete">
                        <FiTrash2 size={14} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan="4" className="text-center py-8 text-gray-400">
                {jds.length === 0
                  ? 'No JDs yet — click "New JD" to start, or load from a template'
                  : `No ${filter} JDs`}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ─── CREATE / EDIT JD MODAL ─── */}
      <Modal isOpen={modal === 'form'} onClose={() => setModal(false)} title={editing ? `Edit JD — ${editing.title}` : 'New Job Description'} wide>
        <form onSubmit={save} className="space-y-3 max-h-[75vh] overflow-y-auto">
          <p className="text-[11px] text-blue-700 bg-blue-50 border border-blue-100 rounded px-3 py-2">
            Save reusable JD templates separately (Templates button) and reuse them here.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Title *</label>
              <input className="input" required placeholder="e.g. Senior Site Engineer — Chandigarh"
                value={form.title || ''} onChange={e => setForm({ ...form, title: e.target.value })} />
            </div>
            <div>
              <label className="label">Status</label>
              <select className="select" value={form.status || 'draft'} onChange={e => setForm({ ...form, status: e.target.value })}>
                {STATUS_PILLS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Linked Hiring Request</label>
              <select className="select" value={form.hiring_request_id || ''} onChange={e => setForm({ ...form, hiring_request_id: e.target.value })}>
                <option value="">— None —</option>
                {hiringRequests.map(h => <option key={h.id} value={h.id}>{h.position_title} ({h.department})</option>)}
              </select>
            </div>
            <div>
              <label className="label">Load from Template</label>
              <select className="select" value={form.template_id || ''} onChange={e => { setForm({ ...form, template_id: e.target.value }); applyTemplate(e.target.value); }}>
                <option value="">— None —</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name}{t.is_default ? ' ★' : ''}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="label">Short Description</label>
            <textarea className="input" rows="2" placeholder="One-paragraph hook explaining the role"
              value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} />
          </div>
          <div>
            <label className="label">Responsibilities</label>
            <textarea className="input" rows="4" placeholder={`• Lead site execution for X\n• Manage subcontractors\n• Daily progress reports`}
              value={form.responsibilities || ''} onChange={e => setForm({ ...form, responsibilities: e.target.value })} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="label">Required Skills</label>
              <textarea className="input" rows="3" placeholder="AutoCAD, MS Project, MEP coordination…"
                value={form.required_skills || ''} onChange={e => setForm({ ...form, required_skills: e.target.value })} />
            </div>
            <div>
              <label className="label">Required Experience</label>
              <textarea className="input" rows="3" placeholder="5+ years in commercial fit-out projects"
                value={form.required_experience || ''} onChange={e => setForm({ ...form, required_experience: e.target.value })} />
            </div>
            <div>
              <label className="label">Education Required</label>
              <textarea className="input" rows="3" placeholder="B.E. / B.Tech in Civil / Mechanical"
                value={form.education_required || ''} onChange={e => setForm({ ...form, education_required: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="label">Internal JD <span className="text-gray-400 font-normal text-[10px]">(full detail for HR / hiring manager — budget, target level, etc.)</span></label>
            <textarea className="input" rows="4" placeholder="Internal-only details — budget band, target seniority, who this reports to, why we are hiring…"
              value={form.internal_jd || ''} onChange={e => setForm({ ...form, internal_jd: e.target.value })} />
          </div>
          <div>
            <label className="label">Public Job Post <span className="text-gray-400 font-normal text-[10px]">(sanitised version for Naukri / LinkedIn — leave blank to auto-build from fields above)</span></label>
            <textarea className="input" rows="4" placeholder="Public-facing post copy. If left blank, the system builds one from the fields above when you click Copy."
              value={form.public_job_post || ''} onChange={e => setForm({ ...form, public_job_post: e.target.value })} />
          </div>
          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Save JD'}</button>
          </div>
        </form>
      </Modal>

      {/* ─── VIEW JD MODAL (Internal vs Public toggle) ─── */}
      <Modal isOpen={modal === 'view'} onClose={() => setModal(false)} title={viewing?.title || 'JD'} wide>
        {viewing && (
          <div className="space-y-3">
            <div className="flex gap-2">
              {['internal','public'].map(m => (
                <button
                  key={m}
                  onClick={() => setViewMode(m)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold uppercase ${viewMode === m ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'}`}>
                  {m === 'internal' ? 'Internal JD' : 'Public Job Post'}
                </button>
              ))}
              <button
                onClick={() => copyPublic(viewing)}
                className="ml-auto btn btn-secondary text-[11px] py-1 px-2 flex items-center gap-1">
                <FiCopy size={11}/> Copy Public Post
              </button>
            </div>
            {viewMode === 'internal' ? (
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3 max-h-[60vh] overflow-y-auto text-[13px]">
                {viewing.description && <p>{viewing.description}</p>}
                {viewing.responsibilities && (
                  <div><div className="font-semibold mb-1">Responsibilities</div><div className="whitespace-pre-wrap">{viewing.responsibilities}</div></div>
                )}
                {viewing.required_skills && (
                  <div><div className="font-semibold mb-1">Required Skills</div><div className="whitespace-pre-wrap">{viewing.required_skills}</div></div>
                )}
                {viewing.required_experience && (
                  <div><div className="font-semibold mb-1">Required Experience</div><div className="whitespace-pre-wrap">{viewing.required_experience}</div></div>
                )}
                {viewing.education_required && (
                  <div><div className="font-semibold mb-1">Education</div><div className="whitespace-pre-wrap">{viewing.education_required}</div></div>
                )}
                {viewing.internal_jd && (
                  <div className="bg-amber-50 border-l-4 border-amber-400 p-3 rounded">
                    <div className="font-semibold mb-1 text-amber-800">Internal-Only Notes</div>
                    <div className="whitespace-pre-wrap text-amber-900">{viewing.internal_jd}</div>
                  </div>
                )}
              </div>
            ) : (
              <pre className="bg-gray-900 text-gray-100 rounded-lg p-4 text-[12px] whitespace-pre-wrap max-h-[60vh] overflow-y-auto" style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>
                {viewing.public_job_post || buildAutoPublic(viewing)}
              </pre>
            )}
            <div className="flex justify-end pt-2">
              <button onClick={() => setModal(false)} className="btn btn-secondary">Close</button>
            </div>
          </div>
        )}
      </Modal>

      {/* ─── TEMPLATES LIST MODAL ─── */}
      <Modal isOpen={modal === 'templatesList'} onClose={() => setModal(false)} title="JD Templates" wide>
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <p className="text-[12px] text-gray-500">Templates are reusable JD skeletons (e.g. "Site Engineer", "Sales Executive"). Load one when creating a new JD to save typing.</p>
            <button onClick={() => openTemplateEditor(null)} className="btn btn-primary text-[12px] py-1 px-2 flex items-center gap-1"><FiPlus size={12}/> New Template</button>
          </div>
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="text-[12px] w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-2 py-1.5 text-[10px] font-semibold text-gray-500 uppercase">Name</th>
                  <th className="text-left px-2 py-1.5 text-[10px] font-semibold text-gray-500 uppercase">Description</th>
                  <th className="text-left px-2 py-1.5 text-[10px] font-semibold text-gray-500 uppercase">Default</th>
                  <th className="text-left px-2 py-1.5 text-[10px] font-semibold text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody>
                {templates.map(t => (
                  <tr key={t.id} className="border-t">
                    <td className="px-2 py-1.5 font-semibold">{t.name}</td>
                    <td className="px-2 py-1.5 text-gray-600">{t.description || '—'}</td>
                    <td className="px-2 py-1.5">{t.is_default ? '★' : ''}</td>
                    <td className="px-2 py-1.5 flex gap-1">
                      <button onClick={() => openTemplateEditor(t)} className="p-1 text-gray-400 hover:text-blue-600"><FiEdit2 size={13}/></button>
                      <button onClick={() => deleteTemplate(t)} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={13}/></button>
                    </td>
                  </tr>
                ))}
                {templates.length === 0 && (
                  <tr><td colSpan="4" className="text-center py-6 text-gray-400">No templates yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end pt-2">
            <button onClick={() => setModal(false)} className="btn btn-secondary">Close</button>
          </div>
        </div>
      </Modal>

      {/* ─── TEMPLATE EDITOR MODAL ─── */}
      <Modal isOpen={modal === 'template'} onClose={() => setModal('templatesList')} title={editingTemplate ? `Edit Template — ${editingTemplate.name}` : 'New JD Template'} wide>
        <form onSubmit={saveTemplate} className="space-y-3 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Template Name *</label>
              <input className="input" required placeholder="e.g. Site Engineer (Standard)"
                value={templateForm.name || ''} onChange={e => setTemplateForm({ ...templateForm, name: e.target.value })} />
            </div>
            <div>
              <label className="label">Description</label>
              <input className="input" placeholder="Short blurb shown next to the template name"
                value={templateForm.description || ''} onChange={e => setTemplateForm({ ...templateForm, description: e.target.value })} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-[12px]">
            <input type="checkbox" checked={!!templateForm.is_default} onChange={e => setTemplateForm({ ...templateForm, is_default: e.target.checked })}/>
            <span>Mark as default template (auto-selected on new JD)</span>
          </label>
          {['title','description','responsibilities','required_skills','required_experience','education_required','internal_jd','public_job_post'].map(k => (
            <div key={k}>
              <label className="label">{k.replace(/_/g, ' ').replace(/\b\w/g, m => m.toUpperCase())}</label>
              <textarea className="input" rows={k.includes('jd') || k === 'public_job_post' || k === 'responsibilities' ? 3 : 2}
                value={templateForm.content?.[k] || ''}
                onChange={e => setTemplateForm({ ...templateForm, content: { ...(templateForm.content || {}), [k]: e.target.value } })}
              />
            </div>
          ))}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setModal('templatesList')} className="btn btn-secondary">Back</button>
            <button type="submit" className="btn btn-primary">{editingTemplate ? 'Update Template' : 'Save Template'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
