// PMS Tasks — Project Management tasks created against a Business Book
// project. Same lifecycle as Delegations but with a project dropdown that
// auto-captures the CRM name from that project's latest Client PO.

import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiUpload, FiMic, FiMicOff, FiCheck, FiX, FiTrash2, FiExternalLink, FiAlertTriangle, FiCalendar, FiDownload } from 'react-icons/fi';

// Web Speech API — live mic dictation (Chromium browsers only).
const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
import { exportCsv } from '../utils/exportCsv';
import { compressImage } from '../utils/compressImage';
import { fmtDate } from '../utils/datetime';

export default function PMSTasks() {
  const { user, isAdmin, canCreate, canApprove } = useAuth();
  // A user granted PMS Tasks → Approve (or admin) can approve/reject and
  // upload proof on ANYONE's task — mam 2026-06-17.
  const pmsApprover = isAdmin() || canApprove('pms_tasks');
  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);
  // Default scope = 'mine' (tasks the logged-in user is involved in,
  // either as assignee or assigner). Mirrors the Delegations page so
  // users land on their own queue, not the entire team's.
  //
  // Scope persisted to URL ?scope=… (mam 2026-05-27: "when i open
  // followup page when i refresh it it goes on front page"). Refresh
  // now keeps the user on the same tab they were viewing.
  const [searchParams, setSearchParams] = useSearchParams();
  const VALID_SCOPES = ['mine', 'given', 'followup', 'all'];
  const urlScope = searchParams.get('scope');
  const [scope, _setScope] = useState(VALID_SCOPES.includes(urlScope) ? urlScope : 'mine');
  const setScope = (s) => {
    _setScope(s);
    setSearchParams(prev => {
      const sp = new URLSearchParams(prev);
      if (s === 'mine') sp.delete('scope'); else sp.set('scope', s);
      return sp;
    }, { replace: true });
  };
  const [statusFilter, setStatusFilter] = useState('');
  // Mam-requested filters: CRM (creator), assignee, date range
  const [crmFilter, setCrmFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [createModal, setCreateModal] = useState(false);
  const [editModal, setEditModal] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [editSaving, setEditSaving] = useState(false);
  const [submitModal, setSubmitModal] = useState(null);
  const [rejectModal, setRejectModal] = useState(null);
  const [extendModal, setExtendModal] = useState(null);
  const [form, setForm] = useState({});
  // Upload state for the new attachment field on the create modal
  // (mam, 2026-05-22: "give here option also upload file like take
  // photo and upload file").
  const [saving, setSaving] = useState(false);
  const [savePct, setSavePct] = useState(0);
  const [submitForm, setSubmitForm] = useState({ proof_url: '', uploading: false });
  const [rejectReason, setRejectReason] = useState('');
  const [extendForm, setExtendForm] = useState({ requested_due_date: '', reason: '' });
  // Voice dictation + audio-file transcription for the Task Description.
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);
  const [transcribing, setTranscribing] = useState(false);
  const audioInputRef = useRef(null);

  // Live mic → description (appends so typing + speaking can be combined).
  const toggleVoice = () => {
    if (!SR) { toast.error("Your browser doesn't support voice input. Use Chrome or Edge."); return; }
    if (listening) { recognitionRef.current?.stop(); setListening(false); return; }
    const rec = new SR();
    rec.lang = 'en-IN';
    rec.interimResults = true;
    rec.continuous = true;
    let finalBuf = '';
    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalBuf += t + ' '; else interim += t;
      }
      setForm(f => ({ ...f, description: ((f._base || '') + finalBuf + interim).trim() }));
    };
    rec.onstart = () => setForm(f => ({ ...f, _base: (f.description ? f.description + ' ' : '') }));
    rec.onerror = (e) => { toast.error('Voice error: ' + (e.error || 'unknown')); setListening(false); };
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  };

  // Upload a recorded audio file → server transcribes (self-hosted Whisper) →
  // text appended to the description. Reuses the delegations transcribe route.
  const handleAudioUpload = async (file) => {
    if (!file) return;
    setTranscribing(true);
    try {
      const fd = new FormData();
      fd.append('audio', file);
      const r = await api.post('/delegations/transcribe', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const text = (r.data?.text || '').trim();
      if (!text) { toast.error('No speech detected in that audio.'); return; }
      setForm(f => ({ ...f, description: (f.description ? f.description.trim() + ' ' : '') + text, _base: undefined }));
      toast.success('Audio transcribed into the task description');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not transcribe the audio.');
    } finally {
      setTranscribing(false);
      if (audioInputRef.current) audioInputRef.current.value = '';
    }
  };

  const load = () => {
    const params = new URLSearchParams({ scope });
    if (statusFilter) params.set('status', statusFilter);
    if (crmFilter) params.set('crm_id', crmFilter);
    if (assigneeFilter) params.set('assignee_id', assigneeFilter);
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    api.get(`/pms-tasks?${params.toString()}`).then(r => setTasks(r.data)).catch(() => setTasks([]));
  };
  useEffect(() => {
    load();
    api.get('/auth/users').then(r => setUsers((r.data || []).filter(u => u.active !== 0))).catch(() => {});
    api.get('/pms-tasks/projects').then(r => setProjects(r.data || [])).catch(() => setProjects([]));
  }, [scope, statusFilter, crmFilter, assigneeFilter, dateFrom, dateTo]);

  const openCreate = () => {
    setForm({
      description: '',
      project_id: '',
      crm_name: '',         // auto-filled when project picked
      project_label: '',    // shown read-only next to the picker
      assigned_to: '',
      due_date: new Date().toISOString().split('T')[0],
      attachment_file: null,
    });
    setSavePct(0);
    setCreateModal(true);
  };

  // When the user picks a project, pull its crm_name + display label from
  // the cached projects list. No extra API call — the /projects endpoint
  // already returned everything we need.
  const onPickProject = (proj) => {
    if (!proj) {
      setForm(f => ({ ...f, project_id: '', crm_name: '', project_label: '' }));
      return;
    }
    const label = [proj.project_name, proj.company_name, proj.client_name].filter(Boolean).join(' · ');
    setForm(f => ({ ...f, project_id: proj.id, crm_name: proj.crm_name || '', project_label: label }));
  };

  const save = async (e) => {
    e.preventDefault();
    if (saving) return;
    if (!String(form.description || '').trim()) return toast.error('Description is required');
    if (!form.project_id) return toast.error('Pick a project');
    if (!form.assigned_to) return toast.error('Pick an assignee');
    setSaving(true); setSavePct(0);
    try {
      // Optional attachment — same compress + progress pipeline that
      // Delegations uses.  Mam's MD reported phantom hangs on large
      // phone photos; compressImage trims a 12-MB iPhone shot to
      // ~700 KB before it leaves the browser.
      let attachmentUrl = null;
      if (form.attachment_file) {
        const compressed = await compressImage(form.attachment_file);
        const fd = new FormData(); fd.append('file', compressed);
        const up = await api.post('/upload', fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
          onUploadProgress: (ev) => {
            if (ev.total) setSavePct(Math.round((ev.loaded / ev.total) * 100));
          },
        });
        attachmentUrl = up.data.url;
      }
      setSavePct(100);
      await api.post('/pms-tasks', {
        description: form.description,
        project_id: form.project_id,
        assigned_to: form.assigned_to,
        due_date: form.due_date,
        attachment_url: attachmentUrl,
      });
      toast.success('PMS task created');
      setCreateModal(false); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create');
    } finally {
      setSaving(false); setSavePct(0);
    }
  };

  // Lifecycle handlers (same shape as Delegations)
  const uploadProof = async (file) => {
    const fd = new FormData(); fd.append('file', file);
    setSubmitForm(s => ({ ...s, uploading: true }));
    try {
      const res = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setSubmitForm({ proof_url: res.data.url, uploading: false });
      toast.success('File uploaded — click Submit');
    } catch { toast.error('Upload failed'); setSubmitForm(s => ({ ...s, uploading: false })); }
  };
  const submitProof = async (e) => {
    e.preventDefault();
    if (!submitForm.proof_url) return toast.error('Please upload proof first');
    try {
      await api.post(`/pms-tasks/${submitModal.id}/submit`, { proof_url: submitForm.proof_url });
      toast.success('Proof submitted — awaiting approval');
      setSubmitModal(null); setSubmitForm({ proof_url: '', uploading: false }); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const approve = async (task) => {
    if (!confirm(`Approve "${task.title}"?`)) return;
    try { await api.post(`/pms-tasks/${task.id}/approve`); toast.success('Approved'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const reject = async (e) => {
    e.preventDefault();
    if (!rejectReason.trim()) return toast.error('Reason is required');
    try {
      await api.post(`/pms-tasks/${rejectModal.id}/reject`, { reason: rejectReason });
      toast.success('Rejected');
      setRejectModal(null); setRejectReason(''); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const requestExtension = async (e) => {
    e.preventDefault();
    if (!extendForm.requested_due_date) return toast.error('Pick a new date');
    if (!extendForm.reason.trim()) return toast.error('Reason is required');
    try {
      await api.post(`/pms-tasks/${extendModal.id}/request-extension`, extendForm);
      toast.success('Extension requested');
      setExtendModal(null); setExtendForm({ requested_due_date: '', reason: '' }); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const approveExtension = async (task) => {
    if (!confirm(`Approve extension to ${task.requested_due_date}?`)) return;
    try { await api.post(`/pms-tasks/${task.id}/approve-extension`); toast.success('Extension approved'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const rejectExtension = async (task) => {
    if (!confirm(`Reject extension request for "${task.title}"?`)) return;
    try { await api.post(`/pms-tasks/${task.id}/reject-extension`); toast.success('Extension rejected'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const del = async (task) => {
    if (!confirm(`Delete "${task.title}"?`)) return;
    try { await api.delete(`/pms-tasks/${task.id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const openEdit = (task) => {
    setEditForm({
      description: task.description || '',
      assigned_to: task.assigned_to || '',
      due_date: task.due_date || '',
      project_id: task.project_id || '',
    });
    setEditModal(task);
  };
  const saveEdit = async (e) => {
    e.preventDefault();
    if (!editForm.description || !editForm.description.trim()) return toast.error('Description is required');
    setEditSaving(true);
    try {
      await api.put(`/pms-tasks/${editModal.id}`, editForm);
      toast.success('Task updated');
      setEditModal(null); setEditForm({}); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update');
    }
    setEditSaving(false);
  };

  const statusBadge = (s) => {
    const map = {
      pending: 'bg-amber-100 text-amber-800 border-amber-200',
      submitted: 'bg-blue-100 text-blue-800 border-blue-200',
      approved: 'bg-emerald-100 text-emerald-800 border-emerald-200',
      rejected: 'bg-red-100 text-red-800 border-red-200',
    };
    return <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${map[s] || 'bg-gray-100 text-gray-700 border-gray-200'}`}>{s}</span>;
  };

  const projectOptions = projects.map(p => ({
    ...p,
    label: `${p.project_name || '(no project name)'}${p.company_name ? ' · ' + p.company_name : ''}${p.client_name ? ' · ' + p.client_name : ''}${p.crm_name ? '  — CRM: ' + p.crm_name : ''}`,
  }));

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h3 className="text-xl font-bold text-gray-800">PMS Tasks</h3>
          <p className="text-sm text-gray-500">Project Management tasks by CRM — pick a project, CRM auto-fills from the latest Client PO.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => exportCsv('pms-tasks',
            ['Task ID','Project','Created By','Description','Assigned To','Due','Status'],
            tasks.map(t => [t.task_id, t.project_name, t.created_by_name, t.description, t.assigned_to_name, t.due_date, t.status]))}
            className="btn btn-secondary flex items-center gap-2"><FiDownload /> Export Excel</button>
          {canCreate('pms_tasks') && (
            <button onClick={openCreate} className="btn btn-primary flex items-center gap-2 justify-center"><FiPlus /> New PMS Task</button>
          )}
        </div>
      </div>

      {/* Mam wants PMS scoped to the logged-in user (like Delegations) —
          users land on their own queue, can expand to team-wide via
          'Followup'. Admin gets the full archive too. */}
      <div className="flex flex-wrap gap-2 text-sm">
        {[
          { id: 'mine', label: 'My Tasks' },
          { id: 'given', label: 'Given by me' },
          { id: 'followup', label: 'Followup (all active)' },
          ...(pmsApprover ? [{ id: 'all', label: isAdmin() ? 'All (admin)' : 'All' }] : []),
        ].map(t => (
          <button key={t.id} onClick={() => setScope(t.id)}
            className={`px-3 py-1.5 rounded-lg font-medium border ${scope === t.id ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
            {t.label}
          </button>
        ))}
        <select className="select text-sm max-w-[180px]" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="submitted">Submitted</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      {/* Mam-requested filters: CRM (creator), Assignee, From / To date */}
      <div className="card p-3 flex flex-wrap items-end gap-3 text-sm">
        <div>
          <label className="label">Created by (CRM)</label>
          <select className="select text-sm w-48" value={crmFilter} onChange={e => setCrmFilter(e.target.value)}>
            <option value="">All</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name}{u.department ? ` — ${u.department}` : ''}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Assigned to</label>
          <select className="select text-sm w-48" value={assigneeFilter} onChange={e => setAssigneeFilter(e.target.value)}>
            <option value="">All</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name}{u.department ? ` — ${u.department}` : ''}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Due From</label>
          <input type="date" className="input text-sm" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        </div>
        <div>
          <label className="label">Due To</label>
          <input type="date" className="input text-sm" value={dateTo} onChange={e => setDateTo(e.target.value)} min={dateFrom || undefined} />
        </div>
        {(crmFilter || assigneeFilter || dateFrom || dateTo) && (
          <button onClick={() => { setCrmFilter(''); setAssigneeFilter(''); setDateFrom(''); setDateTo(''); }}
                  className="text-[11px] text-red-600 hover:underline self-end pb-2">Clear filters</button>
        )}
        <div className="ml-auto text-[11px] text-gray-500 self-end pb-2">
          {tasks.length} task{tasks.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Desktop table — bounded scroll + sticky thead so columns stay
          pinned while scrolling.  Mam, 2026-05-13. */}
      <div className="card p-0 overflow-auto max-h-[70vh] hidden md:block">
        <table className="text-sm">
          <thead className="sticky top-0 z-10 bg-gray-100">
            <tr>
              <th className="w-12 text-center">S.No.</th>
              <th>Task ID</th>
              <th>Project</th>
              <th>Created By <span className="text-[9px] text-gray-400 font-normal normal-case">(CRM below)</span></th>
              <th>Description</th>
              <th>Assigned To</th>
              <th>Due / Done</th>
              <th>Status</th>
              <th>Proof</th>
              <th>Extension</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 && <tr><td colSpan="11" className="text-center text-gray-400 py-8">No PMS tasks</td></tr>}
            {tasks.map((t, idx) => {
              const isAssignee = t.assigned_to === user?.id;
              const isAssigner = t.assigned_by === user?.id;
              // Mam (2026-05-21): "if in pms task site name is sushila
              // then she need to approval why not option" — CRM owner
              // of the project also gets approve / reject rights.
              // Match by first-name token because t.crm_name is a snapshot
              // ("Sushila" vs the user's full "Sushila Kumari").  Server
              // applies the same rule as a safety net.
              const isCrmOwner = (() => {
                if (!t.crm_name || !user?.name) return false;
                const c = String(t.crm_name).toLowerCase().trim();
                const u = String(user.name).toLowerCase().trim();
                return c === u || c.split(/\s+/)[0] === u.split(/\s+/)[0];
              })();
              const canActOnTask = isAssigner || isAdmin() || isCrmOwner || pmsApprover;
              const completedDate = t.reviewed_at ? fmtDate(t.reviewed_at) : null;
              return (
                <tr key={t.id} className={t.status === 'rejected' ? 'bg-red-50/40' : t.status === 'submitted' ? 'bg-blue-50/40' : ''}>
                  <td className="text-center text-xs text-gray-500 font-medium">{idx + 1}</td>
                  <td className="font-mono text-xs text-red-700 whitespace-nowrap">PMS-{String(t.id).padStart(4, '0')}</td>
                  <td className="max-w-[220px]">
                    <div className="font-medium text-gray-800 text-xs">{t.project_name_live || t.project_name_snapshot || <span className="text-gray-300">—</span>}</div>
                    <div className="text-[10px] text-gray-500">
                      {t.lead_no && <span className="font-mono mr-1">{t.lead_no}</span>}
                      {t.company_name && <span>{t.company_name}</span>}
                    </div>
                  </td>
                  <td className="text-xs">
                    {/* Created By = the person who raised the task. CRM name
                        from the linked Client PO shown as a faded subtitle
                        for context. */}
                    <div className="font-medium text-gray-800">
                      {t.assigned_by_name || <span className="text-gray-300">—</span>}
                    </div>
                    {t.crm_name && <div className="text-[10px] text-gray-400">CRM: {t.crm_name}</div>}
                  </td>
                  <td className="max-w-md min-w-[240px]">
                    {/* Wrap properly across all viewports — no more line-clamp,
                        long descriptions break onto multiple lines. */}
                    <div className="text-gray-800 whitespace-pre-wrap break-words text-sm">{t.description}</div>
                    {t.status === 'rejected' && t.reject_reason && (
                      <div className="text-[10px] text-red-700 mt-1 flex items-start gap-1"><FiAlertTriangle size={10} className="mt-0.5 flex-shrink-0" /> {t.reject_reason}</div>
                    )}
                  </td>
                  <td className="whitespace-nowrap">{t.assigned_to_name}</td>
                  <td className="whitespace-nowrap text-xs">
                    {completedDate
                      ? <span className="text-emerald-700 font-medium">Done {completedDate}</span>
                      : t.due_date
                        ? <span className="text-gray-600">Due {t.due_date}</span>
                        : <span className="text-gray-400">—</span>}
                  </td>
                  <td>{statusBadge(t.status)}</td>
                  <td>
                    {/* Show View when proof exists, AND show Upload button
                        on rejected tasks (re-upload) so the task can be
                        retried. Admin / assigner can also upload on
                        behalf of the assignee — same rule as Delegations. */}
                    <div className="flex flex-col gap-1">
                      {t.proof_url && (
                        <a href={t.proof_url} target="_blank" rel="noreferrer" className="text-red-600 text-xs hover:underline flex items-center gap-1"><FiExternalLink size={11} /> View</a>
                      )}
                      {(isAssignee || isAssigner || isAdmin() || pmsApprover) && (t.status === 'pending' || t.status === 'rejected') && (
                        <button onClick={() => { setSubmitModal(t); setSubmitForm({ proof_url: '', uploading: false }); }} className="btn btn-success text-[11px] px-2 py-1 flex items-center gap-1 w-fit">
                          <FiUpload size={11} /> {t.status === 'rejected' ? 'Re-upload' : 'Upload'}
                        </button>
                      )}
                      {!t.proof_url && !((isAssignee || isAssigner || isAdmin() || pmsApprover) && (t.status === 'pending' || t.status === 'rejected')) && (
                        <span className="text-gray-400 text-xs">—</span>
                      )}
                    </div>
                  </td>
                  <td className="whitespace-nowrap">
                    {t.extension_status === 'pending' && t.requested_due_date ? (
                      <div className="flex flex-col gap-1">
                        <span className="text-[10px] text-amber-800 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200 inline-block">→ {t.requested_due_date}</span>
                        {isAdmin() && (
                          <div className="flex gap-1">
                            <button onClick={() => approveExtension(t)} className="text-[10px] text-emerald-600 font-bold hover:underline">Approve</button>
                            <button onClick={() => rejectExtension(t)} className="text-[10px] text-red-600 font-bold hover:underline">Reject</button>
                          </div>
                        )}
                      </div>
                    ) : (isAssignee || isAdmin()) && t.status !== 'approved' ? (
                      <button onClick={() => { setExtendModal(t); setExtendForm({ requested_due_date: t.due_date || '', reason: '' }); }} className="text-[11px] text-gray-500 hover:text-red-600 flex items-center gap-1"><FiCalendar size={11} /> Request</button>
                    ) : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                  <td>
                    <div className="flex gap-1 items-center">
                      {canActOnTask && t.status === 'submitted' && (
                        <>
                          <button onClick={() => approve(t)} className="text-[10px] text-emerald-600 font-bold hover:underline">Approve</button>
                          <button onClick={() => { setRejectModal(t); setRejectReason(''); }} className="text-[10px] text-red-600 font-bold hover:underline">Reject</button>
                        </>
                      )}
                      {(isAssigner || isAdmin()) && (
                        <button onClick={() => openEdit(t)} className="p-1 text-gray-400 hover:text-blue-600" title="Edit task">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
                        </button>
                      )}
                      {(isAssigner || isAdmin()) && <button onClick={() => del(t)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={12} /></button>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {tasks.length === 0 && <div className="card text-center text-gray-400 py-8">No PMS tasks</div>}
        {tasks.map((t, idx) => {
          const isAssignee = t.assigned_to === user?.id;
          const isAssigner = t.assigned_by === user?.id;
          // Mirror the desktop table so the phone doesn't lock out approvers
          // (mam 2026-07-06): CRM owner of the project can approve/reject too.
          const isCrmOwner = (() => {
            if (!t.crm_name || !user?.name) return false;
            const c = String(t.crm_name).toLowerCase().trim();
            const u = String(user.name).toLowerCase().trim();
            return c === u || c.split(/\s+/)[0] === u.split(/\s+/)[0];
          })();
          const canActOnTask = isAssigner || isAdmin() || isCrmOwner || pmsApprover;
          const completedDate = t.reviewed_at ? fmtDate(t.reviewed_at) : null;
          return (
            <div key={t.id} className={`card p-3 ${t.status === 'rejected' ? 'border-l-4 border-red-500' : t.status === 'submitted' ? 'border-l-4 border-blue-500' : ''}`}>
              <div className="flex justify-between items-start gap-2 mb-2">
                <span className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-400 font-semibold">#{idx + 1}</span>
                  <span className="font-mono text-xs text-red-700">PMS-{String(t.id).padStart(4, '0')}</span>
                </span>
                {statusBadge(t.status)}
              </div>
              <p className="text-sm text-gray-800 font-medium mb-2 whitespace-pre-wrap break-words">{t.description}</p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-gray-600 mb-2">
                <div className="col-span-2"><span className="text-gray-400">Project:</span> <b>{t.project_name_live || t.project_name_snapshot || '—'}</b></div>
                {t.crm_name && <div className="col-span-2"><span className="text-gray-400">CRM:</span> <b>{t.crm_name}</b></div>}
                <div><span className="text-gray-400">Assigned to:</span> <b>{t.assigned_to_name}</b></div>
                <div><span className="text-gray-400">By:</span> {t.assigned_by_name}</div>
                {completedDate ? (
                  <div className="col-span-2"><span className="text-gray-400">Completed:</span> <b className="text-emerald-700">{completedDate}</b></div>
                ) : t.due_date && (
                  <div className="col-span-2"><span className="text-gray-400">Due:</span> <b>{t.due_date}</b></div>
                )}
              </div>
              {t.status === 'rejected' && t.reject_reason && (
                <div className="bg-red-50 border border-red-200 rounded px-2 py-1 text-[11px] text-red-700 mb-2 flex items-start gap-1"><FiAlertTriangle size={11} className="mt-0.5" /> {t.reject_reason}</div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {t.proof_url && <a href={t.proof_url} target="_blank" rel="noreferrer" className="btn btn-secondary text-[11px] px-2 py-1 flex items-center gap-1"><FiExternalLink size={11} /> Proof</a>}
                {(isAssignee || isAssigner || isAdmin() || pmsApprover) && (t.status === 'pending' || t.status === 'rejected') && (
                  <button onClick={() => { setSubmitModal(t); setSubmitForm({ proof_url: '', uploading: false }); }} className="btn btn-success text-[11px] px-2 py-1 flex items-center gap-1">
                    <FiUpload size={11} /> {t.status === 'rejected' ? 'Re-upload' : 'Upload Proof'}
                  </button>
                )}
                {/* Extension Approve/Reject (admin) — was desktop-only (mam 2026-07-06). */}
                {t.extension_status === 'pending' && t.requested_due_date && isAdmin() && (
                  <span className="flex items-center gap-1.5">
                    <span className="text-[10px] text-amber-800 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">Ext → {t.requested_due_date}</span>
                    <button onClick={() => approveExtension(t)} className="btn btn-success text-[11px] px-2 py-1">Approve ext</button>
                    <button onClick={() => rejectExtension(t)} className="btn btn-danger text-[11px] px-2 py-1">Reject ext</button>
                  </span>
                )}
                {(isAssignee || isAdmin()) && t.status !== 'approved' && t.extension_status !== 'pending' && (
                  <button onClick={() => { setExtendModal(t); setExtendForm({ requested_due_date: t.due_date || '', reason: '' }); }} className="btn btn-secondary text-[11px] px-2 py-1 flex items-center gap-1"><FiCalendar size={11} /> Extension</button>
                )}
                {canActOnTask && t.status === 'submitted' && (
                  <>
                    <button onClick={() => approve(t)} className="btn btn-success text-[11px] px-2 py-1 flex items-center gap-1"><FiCheck size={11} /> Approve</button>
                    <button onClick={() => { setRejectModal(t); setRejectReason(''); }} className="btn btn-danger text-[11px] px-2 py-1 flex items-center gap-1"><FiX size={11} /> Reject</button>
                  </>
                )}
                {(isAssigner || isAdmin()) && (
                  <button onClick={() => openEdit(t)} className="btn btn-secondary text-[11px] px-2 py-1 flex items-center gap-1" title="Edit task">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
                    Edit
                  </button>
                )}
                {(isAssigner || isAdmin()) && <button onClick={() => del(t)} className="p-1.5 text-gray-400 hover:text-red-600 ml-auto"><FiTrash2 size={13} /></button>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Create Modal */}
      <Modal isOpen={createModal} onClose={() => setCreateModal(false)} title="New PMS Task" wide>
        <form onSubmit={save} className="space-y-3">
          <div>
            <label className="label">Project *</label>
            <SearchableSelect
              options={projectOptions}
              value={form.project_id || null}
              valueKey="id" displayKey="label"
              placeholder="Search project by name, company or client…"
              onChange={(p) => onPickProject(p)}
            />
            {form.crm_name && (
              <p className="text-[11px] text-emerald-700 mt-1 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">
                CRM auto-picked from the latest Client PO for this project: <b>{form.crm_name}</b>
              </p>
            )}
            {form.project_id && !form.crm_name && (
              <p className="text-[11px] text-amber-700 mt-1 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                No Client PO with a CRM name exists for this project yet — the task will be created without a CRM tag.
              </p>
            )}
          </div>
          <div>
            <label className="label flex items-center justify-between">
              <span>Task Description *
                {listening && <span className="ml-2 text-[10px] text-red-600 animate-pulse">● Listening…</span>}
                {transcribing && <span className="ml-2 text-[10px] text-blue-600 animate-pulse">● Transcribing audio…</span>}
              </span>
              <span className="flex items-center gap-1.5">
                <button type="button" onClick={toggleVoice} className={`text-[11px] px-2 py-1 rounded-full flex items-center gap-1 ${listening ? 'bg-red-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                  {listening ? <><FiMicOff size={12} /> Stop</> : <><FiMic size={12} /> Voice</>}
                </button>
                <button type="button" disabled={transcribing} onClick={() => audioInputRef.current?.click()}
                  className={`text-[11px] px-2 py-1 rounded-full flex items-center gap-1 ${transcribing ? 'bg-gray-100 text-gray-400 cursor-wait' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                  <FiUpload size={12} /> {transcribing ? 'Transcribing…' : 'Upload audio'}
                </button>
                <input ref={audioInputRef} type="file" accept="audio/*,.m4a,.mp3,.wav,.ogg,.opus,.webm" className="hidden"
                  onChange={e => handleAudioUpload(e.target.files?.[0])} />
              </span>
            </label>
            <textarea className="input" rows="4" required value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value, _base: undefined })} placeholder="What needs to be done? — or speak / upload an audio note" />
            {!SR && <p className="text-[10px] text-amber-600 mt-0.5">Live voice needs Chrome or Edge — “Upload audio” works in any browser.</p>}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Assign To *</label>
              <SearchableSelect
                options={users.map(u => ({ ...u, label: `${u.name}${u.username ? ' (@' + u.username + ')' : ''}` }))}
                value={form.assigned_to || null}
                valueKey="id" displayKey="label"
                placeholder="Search user…"
                onChange={(u) => setForm({ ...form, assigned_to: u?.id || '' })}
              />
            </div>
            <div>
              <label className="label">Due Date</label>
              <input className="input" type="date" value={form.due_date || ''} onChange={e => setForm({ ...form, due_date: e.target.value })} />
            </div>
          </div>
          {/* Attachment — mam (2026-05-22): "give here option also
              upload file like take photo and upload file".  Same
              paired Take Photo / Choose File pattern as Delegations,
              same compression + progress pipeline. */}
          <div>
            <label className="label">Attachment <span className="text-gray-400 font-normal">(optional — brief / drawing / photo)</span></label>
            <div className="grid grid-cols-2 gap-2">
              <label className="cursor-pointer border-2 border-blue-200 hover:border-blue-400 bg-blue-50/60 rounded-lg p-2 text-center transition flex items-center justify-center gap-1.5">
                <span className="text-blue-700 font-semibold text-sm">📷 Take Photo</span>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={e => setForm({ ...form, attachment_file: e.target.files?.[0] || null })}
                />
              </label>
              <label className="cursor-pointer border-2 border-gray-200 hover:border-gray-400 bg-gray-50 rounded-lg p-2 text-center transition flex items-center justify-center gap-1.5">
                <span className="text-gray-700 font-semibold text-sm">📂 Choose File</span>
                <input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx"
                  className="hidden"
                  onChange={e => setForm({ ...form, attachment_file: e.target.files?.[0] || null })}
                />
              </label>
            </div>
            {form.attachment_file && (
              <p className="text-[10px] text-emerald-600 mt-1">
                Selected: {form.attachment_file.name} ({(form.attachment_file.size / 1024 / 1024).toFixed(1)} MB · will compress before upload if &gt; 500 KB)
              </p>
            )}
          </div>
          {saving && (
            <div className="bg-blue-50 border border-blue-200 rounded p-2 text-[11px] text-blue-800">
              <div className="flex justify-between mb-1">
                <span>{savePct < 100 ? (form.attachment_file ? 'Uploading photo…' : 'Saving…') : 'Finalising…'}</span>
                <span className="font-mono">{savePct}%</span>
              </div>
              <div className="h-1.5 bg-blue-100 rounded overflow-hidden">
                <div className="h-full bg-blue-600 transition-all" style={{ width: `${savePct}%` }} />
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setCreateModal(false)} disabled={saving} className="btn btn-secondary disabled:opacity-50">Cancel</button>
            <button type="submit" disabled={saving} className="btn btn-primary disabled:opacity-50">
              {saving ? `Uploading… ${savePct}%` : 'Assign Task'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit Task Modal — admin / assigner only */}
      <Modal isOpen={!!editModal} onClose={() => { setEditModal(null); setEditForm({}); }} title={editModal ? `Edit task — PMS-${String(editModal.id).padStart(4,'0')}` : 'Edit task'}>
        {editModal && (
          <form onSubmit={saveEdit} className="space-y-3">
            <div>
              <label className="label">Description *</label>
              <textarea
                className="input"
                rows="4"
                value={editForm.description || ''}
                onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="label">Assigned To *</label>
              <select className="select" value={editForm.assigned_to || ''} onChange={e => setEditForm(f => ({ ...f, assigned_to: e.target.value }))}>
                <option value="">—</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.name}{u.department ? ` (${u.department})` : ''}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Due Date</label>
              <input type="date" className="input" value={editForm.due_date || ''} onChange={e => setEditForm(f => ({ ...f, due_date: e.target.value }))} />
            </div>
            {editModal.status === 'rejected' && (
              <div className="bg-amber-50 border border-amber-200 rounded p-2 text-xs text-amber-800">
                Editing a rejected task does NOT auto-resubmit it. The assignee can re-upload proof from the table to retry.
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => { setEditModal(null); setEditForm({}); }} className="btn btn-secondary">Cancel</button>
              <button type="submit" disabled={editSaving} className="btn btn-primary">{editSaving ? 'Saving…' : 'Save Changes'}</button>
            </div>
          </form>
        )}
      </Modal>

      {/* Submit Proof Modal */}
      <Modal isOpen={!!submitModal} onClose={() => setSubmitModal(null)} title={submitModal ? `Submit proof — PMS-${String(submitModal.id).padStart(4,'0')}` : 'Submit proof'}>
        <form onSubmit={submitProof} className="space-y-3">
          {submitModal?.status === 'rejected' && submitModal.reject_reason && (
            <div className="bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">
              <p className="font-semibold mb-0.5 flex items-center gap-1"><FiAlertTriangle size={12} /> Previous rejection</p>
              <p>{submitModal.reject_reason}</p>
            </div>
          )}
          <div>
            <label className="label">Upload proof</label>
            {/* MD's request (mam, 2026-05-21): "Give option of click
                photo in attachment".  Camera-first on left, file-picker
                fallback on right. */}
            <div className="grid grid-cols-2 gap-2 mb-1">
              <label className={`cursor-pointer border-2 ${submitForm.uploading ? 'border-gray-200 bg-gray-50 cursor-not-allowed' : 'border-blue-200 hover:border-blue-400 bg-blue-50/60'} rounded-lg p-2 text-center transition flex items-center justify-center gap-1.5`}>
                <span className="text-blue-700 font-semibold text-sm">📷 Take Photo</span>
                <input type="file" accept="image/*" capture="environment" disabled={submitForm.uploading}
                  className="hidden"
                  onChange={e => { const f = e.target.files[0]; if (f) uploadProof(f); }} />
              </label>
              <label className={`cursor-pointer border-2 ${submitForm.uploading ? 'border-gray-200 bg-gray-50 cursor-not-allowed' : 'border-gray-200 hover:border-gray-400 bg-gray-50'} rounded-lg p-2 text-center transition flex items-center justify-center gap-1.5`}>
                <span className="text-gray-700 font-semibold text-sm">📂 Choose File</span>
                <input type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx" disabled={submitForm.uploading}
                  className="hidden"
                  onChange={e => { const f = e.target.files[0]; if (f) uploadProof(f); }} />
              </label>
            </div>
            {submitForm.uploading && <p className="text-xs text-blue-700 mt-1">Uploading…</p>}
            {submitForm.proof_url && <p className="text-xs text-emerald-600 mt-1">✓ Ready to submit</p>}
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setSubmitModal(null)} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={!submitForm.proof_url || submitForm.uploading} className="btn btn-primary disabled:opacity-50">Submit for Approval</button>
          </div>
        </form>
      </Modal>

      {/* Reject Modal */}
      <Modal isOpen={!!rejectModal} onClose={() => setRejectModal(null)} title="Reject task">
        <form onSubmit={reject} className="space-y-3">
          <div>
            <label className="label">Reason *</label>
            <textarea className="input" rows="3" value={rejectReason} onChange={e => setRejectReason(e.target.value)} required placeholder="Explain what needs to change" />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setRejectModal(null)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-danger">Reject & Send Back</button>
          </div>
        </form>
      </Modal>

      {/* Extension Modal */}
      <Modal isOpen={!!extendModal} onClose={() => setExtendModal(null)} title="Request Due-Date Extension">
        <form onSubmit={requestExtension} className="space-y-3">
          <p className="text-xs text-gray-500">Ask admin for more time. They'll approve or reject.</p>
          <div>
            <label className="label">New requested date *</label>
            <input className="input" type="date" required min={extendModal?.due_date || undefined}
              value={extendForm.requested_due_date} onChange={e => setExtendForm(s => ({ ...s, requested_due_date: e.target.value }))} />
            {extendModal?.due_date && <p className="text-[10px] text-gray-400 mt-0.5">Current due date: {extendModal.due_date}</p>}
          </div>
          <div>
            <label className="label">Reason *</label>
            <textarea className="input" rows="3" required value={extendForm.reason} onChange={e => setExtendForm(s => ({ ...s, reason: e.target.value }))} placeholder="Why do you need more time?" />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setExtendModal(null)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Send Request</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
