import { useState, useEffect, useRef } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiMic, FiMicOff, FiUpload, FiCheck, FiX, FiTrash2, FiExternalLink, FiAlertTriangle, FiClock, FiCalendar, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { compressImage } from '../utils/compressImage';
import { fmtDate } from '../utils/datetime';

// Web Speech API — available as SpeechRecognition in Chromium-based browsers
const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

export default function Delegation() {
  const { user, isAdmin, canApprove } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]); // unique project names from Business Book
  // EA = anyone with approve permission on delegations (mam grants this to
  // her assistant). Admin also counts. Both see "All" tab + can upload proof
  // for anyone.
  const isEA = isAdmin() || canApprove('delegations');
  const [view, setView] = useState('list'); // 'list' | 'dashboard'
  const [dashboard, setDashboard] = useState([]);
  const [scope, setScope] = useState(isEA ? 'all' : 'mine'); // mine | given | all
  const [statusFilter, setStatusFilter] = useState('');
  const [healthFilter, setHealthFilter] = useState(''); // '' | green | yellow | red (deadline-slippage light: times the due date was pushed)
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  // Free-text search across Task ID and Description (mam, 2026-05-15:
  // "give option to filter for search option for example if i wtite
  // task or task id").  Applied client-side over the already-filtered
  // tasks array so it composes with status / assignee / date filters.
  const [search, setSearch] = useState('');
  const [createModal, setCreateModal] = useState(false);
  const [editModal, setEditModal] = useState(null); // task being edited (admin / assigner)
  const [editForm, setEditForm] = useState({});
  const [editSaving, setEditSaving] = useState(false);
  const [submitModal, setSubmitModal] = useState(null); // task being submitted
  const [rejectModal, setRejectModal] = useState(null); // task being rejected
  const [extendModal, setExtendModal] = useState(null); // task: assignee requests more time
  const [form, setForm] = useState({});
  const [submitForm, setSubmitForm] = useState({ proof_url: '', uploading: false });
  // Mam's MD (2026-05-21): "Sotyn.Headmasters is hang" when raising task with photo.
  // Root cause was a silent 30-60s photo upload with no progress.  Track
  // a saving flag + percentage so the Save button reflects what's
  // actually happening.
  const [saving, setSaving] = useState(false);
  const [savePct, setSavePct] = useState(0);
  const [proofPct, setProofPct] = useState(0);
  const [rejectReason, setRejectReason] = useState('');
  const [extendForm, setExtendForm] = useState({ requested_due_date: '', reason: '' });
  // Voice input
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);
  // Audio-file → text (server-side transcription)
  const [transcribing, setTranscribing] = useState(false);
  const audioInputRef = useRef(null);

  const load = () => {
    const params = new URLSearchParams({ scope });
    if (statusFilter) params.set('status', statusFilter);
    if (assigneeFilter) params.set('assignee_id', assigneeFilter);
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    api.get(`/delegations?${params.toString()}`).then(r => setTasks(r.data)).catch(() => setTasks([]));
  };
  useEffect(() => {
    load();
    api.get('/auth/users').then(r => setUsers((r.data || []).filter(u => u.active !== 0))).catch(() => {});
    // Pull all Business Book entries → build unique project list for the
    // Project Name picker. Fall back to company_name when project_name is
    // blank so every BB row is reachable. Already-typed project names on
    // existing tasks are also merged in so the dropdown stays useful for
    // legacy free-text entries.
    api.get('/business-book').then(r => {
      // CSV-imported names sometimes carry stray quotes ("""M/s ...""")
      // and trailing whitespace. Clean those before deduping so the
      // dropdown stays tight and 'M/s X' / '"""M/s X"""' don't appear
      // as separate options.
      const cleanName = (s) => (s || '')
        .replace(/^[\s"'`]+|[\s"'`]+$/g, '')   // trim quotes + whitespace from both ends
        .replace(/\s+/g, ' ')                   // collapse internal whitespace
        .trim();
      const seen = new Set();
      const list = [];
      for (const bb of r.data || []) {
        const name = cleanName(bb.project_name) || cleanName(bb.company_name);
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        // Prefer lead_no as the disambiguator (shorter than client name)
        // so each option stays readable even on narrow modals.
        list.push({ name, subtitle: bb.lead_no || '' });
      }
      setProjects(list.sort((a, b) => a.name.localeCompare(b.name)));
    }).catch(() => setProjects([]));
  }, [scope, statusFilter, assigneeFilter, dateFrom, dateTo]);

  // Per-person workload aggregates — only loaded when the dashboard view
  // is active. Refreshes when the user toggles back to it after changes.
  useEffect(() => {
    if (view === 'dashboard') {
      api.get('/delegations/dashboard').then(r => setDashboard(r.data || [])).catch(() => setDashboard([]));
    }
  }, [view]);

  // Deep-link from the War Room "Open ↗" button — highlight + scroll to a
  // specific delegation so the approver can verify its proof (mam 2026-06-24).
  const [highlightId] = useState(() => new URLSearchParams(window.location.search).get('open'));
  useEffect(() => {
    if (!highlightId || !tasks.length) return;
    const el = document.getElementById(`deleg-row-${highlightId}`);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlightId, tasks]);

  // Voice → description. Appends to existing text so user can combine typing + voice.
  const toggleVoice = () => {
    if (!SR) {
      toast.error("Your browser doesn't support voice input. Use Chrome or Edge.");
      return;
    }
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const rec = new SR();
    rec.lang = 'en-IN';
    rec.interimResults = true;
    rec.continuous = true;
    let finalBuf = '';
    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalBuf += t + ' ';
        else interim += t;
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

  // Upload an audio file → server transcribes (self-hosted Whisper) → text is
  // appended to the description. Works for recordings shared on WhatsApp etc.
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

  const openCreate = () => {
    setForm({ description: '', assigned_to: '', due_date: new Date().toISOString().split('T')[0], project_name: '', attachment_file: null });
    setCreateModal(true);
  };

  const save = async (e) => {
    e.preventDefault();
    if (saving) return;  // guard double-submit while upload is in flight
    if (!String(form.description || '').trim()) return toast.error('Description is required');
    setSaving(true); setSavePct(0);
    try {
      // Optional attachment — compress images BEFORE upload (mam's MD,
      // 2026-05-21: "Sotyn.Headmasters is hang" when a 10-MB phone photo took 30s+
      // on the wire).  compressImage() resizes to 1920px / JPEG 80%
      // and lands at ~700 KB.  PDFs/docs pass through unchanged.
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
      await api.post('/delegations', {
        description: form.description,
        assigned_to: form.assigned_to,
        due_date: form.due_date,
        project_name: form.project_name || null,
        attachment_url: attachmentUrl,
      });
      toast.success('Task assigned');
      setCreateModal(false); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create');
    } finally {
      setSaving(false); setSavePct(0);
    }
  };

  // Inline edit — save on blur / Enter. Optimistic: update local state, roll
  // back if the server rejects. Admin / assigner only (backend enforces it
  // too, but we also render the cell as read-only for other viewers).
  const saveProject = async (task, newValue) => {
    const trimmed = (newValue || '').trim();
    const current = task.project_name || '';
    if (trimmed === current) return; // no-op
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, project_name: trimmed || null } : t));
    try {
      await api.patch(`/delegations/${task.id}/project`, { project_name: trimmed });
    } catch (err) {
      // Revert on error
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, project_name: current || null } : t));
      toast.error(err.response?.data?.error || 'Failed to update project');
    }
  };

  // Followup remark (mam 2026-06-17): a manual note the EA keeps for the MD.
  // Purely informational — it does NOT affect task status / completion.
  // EA (or admin) edits; everyone else sees it read-only.
  const saveFollowup = async (task, newValue) => {
    const trimmed = (newValue || '').trim();
    const current = task.followup_remarks || '';
    if (trimmed === current) return;
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, followup_remarks: trimmed || null } : t));
    try {
      await api.patch(`/delegations/${task.id}/followup-remarks`, { followup_remarks: trimmed });
    } catch (err) {
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, followup_remarks: current || null } : t));
      toast.error(err.response?.data?.error || 'Failed to save followup remark');
    }
  };

  // Extension request / approval (admin)
  const requestExtension = async (e) => {
    e.preventDefault();
    if (!extendForm.requested_due_date) return toast.error('Pick a new date');
    if (!extendForm.reason.trim()) return toast.error('Reason is required');
    try {
      await api.post(`/delegations/${extendModal.id}/request-extension`, extendForm);
      toast.success('Extension requested — admin will review');
      setExtendModal(null); setExtendForm({ requested_due_date: '', reason: '' }); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const approveExtension = async (task) => {
    if (!confirm(`Approve extension to ${task.requested_due_date}?`)) return;
    try { await api.post(`/delegations/${task.id}/approve-extension`); toast.success('Extension approved'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const rejectExtension = async (task) => {
    if (!confirm(`Reject extension request for "${task.title}"?`)) return;
    try { await api.post(`/delegations/${task.id}/reject-extension`); toast.success('Extension rejected'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Upload proof file then submit
  const uploadProof = async (file) => {
    setSubmitForm(s => ({ ...s, uploading: true }));
    setProofPct(0);
    try {
      // Compress phone photos before sending — same fix as the
      // task-create flow.  Keeps the proof upload responsive even
      // on a 4G connection.
      const compressed = await compressImage(file);
      const fd = new FormData(); fd.append('file', compressed);
      const res = await api.post('/upload', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (ev) => {
          if (ev.total) setProofPct(Math.round((ev.loaded / ev.total) * 100));
        },
      });
      setSubmitForm({ proof_url: res.data.url, uploading: false });
      setProofPct(100);
      toast.success('File uploaded — click Submit');
    } catch {
      toast.error('Upload failed');
      setSubmitForm(s => ({ ...s, uploading: false }));
    } finally {
      setProofPct(0);
    }
  };
  const submitProof = async (e) => {
    e.preventDefault();
    if (!submitForm.proof_url) return toast.error('Please upload proof first');
    try {
      await api.post(`/delegations/${submitModal.id}/submit`, { proof_url: submitForm.proof_url });
      toast.success('Proof submitted — awaiting approval');
      setSubmitModal(null); setSubmitForm({ proof_url: '', uploading: false }); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const approve = async (task) => {
    if (!confirm(`Approve "${task.title}"?`)) return;
    try { await api.post(`/delegations/${task.id}/approve`); toast.success('Approved'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const reject = async (e) => {
    e.preventDefault();
    if (!rejectReason.trim()) return toast.error('Reason is required');
    try {
      await api.post(`/delegations/${rejectModal.id}/reject`, { reason: rejectReason });
      toast.success('Rejected — assignee notified');
      setRejectModal(null); setRejectReason(''); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const del = async (task) => {
    if (!confirm(`Delete "${task.title}"?`)) return;
    try { await api.delete(`/delegations/${task.id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const openEdit = (task) => {
    setEditForm({
      description: task.description || '',
      assigned_to: task.assigned_to || '',
      due_date: task.due_date || '',
      project_name: task.project_name || '',
    });
    setEditModal(task);
  };
  const saveEdit = async (e) => {
    e.preventDefault();
    if (!editForm.description || !editForm.description.trim()) return toast.error('Description is required');
    setEditSaving(true);
    try {
      await api.put(`/delegations/${editModal.id}`, editForm);
      toast.success('Task updated');
      setEditModal(null); setEditForm({}); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update');
    }
    setEditSaving(false);
  };

  // Strip the legacy bracketed prefix '[TSK-N | project | category | by person]'
  // that existed in descriptions before we moved those fields into proper DB
  // columns. Keeps only the real task text the user typed.
  const cleanDesc = (s) => String(s || '').replace(/^\s*\[[^\]]*\]\s*/, '').trim();

  const statusBadge = (s) => {
    const map = {
      pending: 'bg-amber-100 text-amber-800 border-amber-200',
      submitted: 'bg-blue-100 text-blue-800 border-blue-200',
      approved: 'bg-emerald-100 text-emerald-800 border-emerald-200',
      rejected: 'bg-red-100 text-red-800 border-red-200',
    };
    return <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${map[s] || 'bg-gray-100 text-gray-700 border-gray-200'}`}>{s}</span>;
  };

  // Deadline-slippage light (mam 2026-07-06: "green when task enter date, yellow
  // when user gives a second date but on that date not done, red on the third date").
  // The colour tracks how many times the due date has been PUSHED, not how close it
  // is. Each approved extension / manual re-date bumps extension_count on the server.
  //   GREEN  = done, OR still on the original date (never pushed)
  //   YELLOW = date pushed once — a 2nd date was given and it's still open
  //   RED    = date pushed twice or more — a 3rd (or later) date and still open
  const taskHealth = (t) => {
    if (t.status === 'approved') return 'green';           // done — closed on whatever date
    const n = +t.extension_count || 0;                     // times the date was pushed
    if (n >= 2) return 'red';                              // 3rd date or beyond
    if (n >= 1) return 'yellow';                           // 2nd date given
    return 'green';                                        // still on the original date
  };
  const healthDot = (h) => {
    if (!h) return null;
    const cfg = {
      green: ['bg-emerald-500', 'On the original date'],
      yellow: ['bg-amber-400', 'Date pushed once (2nd date)'],
      red: ['bg-red-500', 'Date pushed 2+ times (3rd date+)'],
    }[h];
    return <span className={`inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 ${cfg[0]}`} title={cfg[1]} />;
  };

  return (
    <div className="space-y-4">
      {/* Header — only admin creates new tasks. Everyone else is a user who receives them. */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h3 className="text-xl font-bold text-gray-800">Delegations</h3>
          <p className="text-sm text-gray-500">{isAdmin() ? 'Assign tasks, upload proof, approve or reject' : 'Upload proof for tasks assigned to you'}</p>
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          {/* View toggle — Dashboard is only meaningful for admin / EA who
              manages the team's workload. Regular users only see "List". */}
          {isEA && (
            <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-sm">
              <button onClick={() => setView('list')}
                className={`px-3 py-1.5 ${view === 'list' ? 'bg-blue-800 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>List</button>
              <button onClick={() => setView('dashboard')}
                className={`px-3 py-1.5 ${view === 'dashboard' ? 'bg-blue-800 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>Dashboard</button>
            </div>
          )}
          <button onClick={() => {
            // Export respects the active search filter so admin can
            // download exactly what's visible on screen.
            const q = search.trim().toLowerCase();
            const rows = q
              ? tasks.filter(t => (t.task_id || '').toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q))
              : tasks;
            exportCsv('delegations',
              ['Task ID','Description','Project','Assigned To','Due','Status'],
              rows.map(t => [t.task_id, t.description, t.project_name, t.assigned_to_name, t.due_date, t.status]));
          }}
            className="btn btn-secondary flex items-center gap-2"><FiDownload /> Export Excel</button>
          {isAdmin() && view === 'list' && (
            <button onClick={openCreate} className="btn btn-primary flex items-center gap-2 justify-center"><FiPlus /> New Task</button>
          )}
        </div>
      </div>

      {/* DASHBOARD — per-person workload table. mam's spec:
          Person · Total · Active · Completed · Delayed · Avg Delay · WIP Limit · Status
          Status: 🔴 Overloaded (active > WIP) · 🔴 Constraint (>=25% delayed
          or avg_delay > 5d) · 🟢 OK */}
      {view === 'dashboard' && (
        <>
          <div className="card p-3 bg-blue-50/40 border-l-4 border-blue-500 text-xs text-gray-700">
            <b>Workload Dashboard</b> — one row per person with active tasks. WIP limit is 5 by default. <span className="text-red-600 font-semibold">Overloaded</span> = too many active tasks. <span className="text-amber-700 font-semibold">Constraint</span> = ≥25% delayed or avg delay &gt; 5 days.
          </div>
          <div className="card p-0 overflow-x-auto">
            <table className="text-sm w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Person</th>
                  <th className="text-right px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Total</th>
                  <th className="text-right px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Active</th>
                  <th className="text-right px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Completed</th>
                  <th className="text-right px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Delayed</th>
                  <th className="text-right px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Avg Delay (Days)</th>
                  <th className="text-right px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">WIP Limit</th>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Status</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.map(r => {
                  const dotClass = r.status === 'Overloaded' ? 'bg-red-500'
                    : r.status === 'Constraint' ? 'bg-red-400'
                    : 'bg-emerald-500';
                  const overActive = r.active_tasks > r.wip_limit;
                  return (
                    <tr key={r.id} className="border-t hover:bg-gray-50/60">
                      <td className="px-3 py-2">
                        <div className="font-medium text-gray-900">{r.person}</div>
                        <div className="text-[10px] text-gray-400">{r.role}{r.department ? ' · ' + r.department : ''}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.total_tasks}</td>
                      <td className={`px-3 py-2 text-right tabular-nums font-bold ${overActive ? 'text-red-600' : 'text-gray-800'}`}>{r.active_tasks}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{r.completed}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${r.delayed_tasks > 0 ? 'text-red-600 font-bold' : 'text-gray-400'}`}>{r.delayed_tasks}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${(r.avg_delay || 0) > 5 ? 'text-red-600 font-bold' : 'text-gray-700'}`}>{r.avg_delay || 0}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-500">{r.wip_limit}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center gap-1.5 text-[11px] font-bold uppercase`}>
                          <span className={`w-2.5 h-2.5 rounded-full ${dotClass}`} />
                          {r.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {dashboard.length === 0 && (
                  <tr><td colSpan="8" className="text-center py-8 text-gray-400 text-sm">No active delegations yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {view === 'list' && (<>

      {/* Filters — scope tabs, status, name (assignee), date from/to. The
          "All" tab shows for admin and EA (anyone with can_approve on
          delegations). Regular users only see their own tasks. */}
      <div className="flex flex-wrap gap-2 text-sm items-center">
        {[
          { id: 'mine', label: 'Assigned to me' },
          ...(isEA ? [{ id: 'all', label: 'All tasks' }] : []),
        ].map(t => (
          <button key={t.id} onClick={() => setScope(t.id)}
            className={`px-3 py-1.5 rounded-lg font-medium border ${scope === t.id ? 'bg-blue-800 text-white border-blue-800' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
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
        {/* Deadline-slippage filter (mam 2026-07-06) — by how many times the due
            date was pushed. Composes with the status/assignee/date filters above. */}
        <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-xs">
          {[
            { id: '', label: 'All', dot: '' },
            { id: 'green', label: '1st date', dot: 'bg-emerald-500' },
            { id: 'yellow', label: '2nd date', dot: 'bg-amber-400' },
            { id: 'red', label: '3rd date+', dot: 'bg-red-500' },
          ].map(h => (
            <button key={h.id || 'all'} type="button" onClick={() => setHealthFilter(h.id)}
              className={`px-2.5 py-1.5 flex items-center gap-1 border-l first:border-l-0 border-gray-200 ${healthFilter === h.id ? 'bg-blue-800 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              {h.dot && <span className={`w-2 h-2 rounded-full ${h.dot}`} />}{h.label}
            </button>
          ))}
        </div>
        {/* Free-text search — matches Task ID OR Description (case-insensitive).
            Empty input = no filter. */}
        <div className="relative flex-1 min-w-[200px] max-w-[320px]">
          <input
            type="text"
            className="input text-sm pr-7"
            placeholder="Search task ID or description…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button onClick={() => setSearch('')} title="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700 text-sm leading-none">×</button>
          )}
        </div>
        {/* Assignee filter — only useful on 'All tasks' (filtering by
            'self' on My Tasks adds nothing), so still admin-scoped. */}
        {scope === 'all' && (
          <div className="w-[220px]">
            <SearchableSelect
              options={users.map(u => ({ ...u, label: u.name + (u.username ? ' (@' + u.username + ')' : '') }))}
              value={assigneeFilter || null}
              valueKey="id" displayKey="label"
              placeholder="All assignees — search…"
              onChange={(u) => setAssigneeFilter(u?.id || '')}
            />
          </div>
        )}
        {/* Date range — useful for everyone (filter MY tasks by date too).
            Mam: 'user can also filter date from to'. */}
        <div className="flex items-center gap-1 text-xs text-gray-500">
          <span>From</span>
          <input type="date" className="input py-1 text-xs w-36" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          <span>To</span>
          <input type="date" className="input py-1 text-xs w-36" value={dateTo} onChange={e => setDateTo(e.target.value)} min={dateFrom || undefined} />
          {(dateFrom || dateTo || assigneeFilter) && (
            <button onClick={() => { setAssigneeFilter(''); setDateFrom(''); setDateTo(''); }} className="text-[11px] text-red-600 hover:underline ml-1">Clear</button>
          )}
        </div>
      </div>

      {/* Table view — Serial / Task ID / Description / Project / Assigned To /
          Due / Status / Upload Proof / Extension / Actions.
          Shown on ALL screen sizes per mam's request (2026-04-23). On phones
          the parent scrolls horizontally so every column stays accessible. */}
      {/* Reverted to the original 10-column table per mam
          (2026-05-21: "not change delegation like previous"). */}
      <div className="card p-0 overflow-auto max-h-[70vh]">
        <table className="text-sm min-w-[1100px] lg:min-w-0 lg:w-full">
          <thead className="sticky top-0 z-10 bg-gray-100">
            <tr>
              <th className="w-12 text-center">S.No.</th>
              <th>Task ID</th>
              <th>Description</th>
              <th>Project</th>
              <th>Assigned To</th>
              <th>Due / Completed</th>
              <th>Status</th>
              <th>Upload Proof</th>
              <th>Extension</th>
              <th>Followup Remarks<br/><span className="text-[9px] font-normal normal-case text-gray-400">(EA → MD)</span></th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              const q = search.trim().toLowerCase();
              let visibleTasks = q
                ? tasks.filter(t =>
                    (t.task_id || '').toLowerCase().includes(q) ||
                    (t.description || '').toLowerCase().includes(q))
                : tasks;
              if (healthFilter) visibleTasks = visibleTasks.filter(t => taskHealth(t) === healthFilter);
              return (<>
                {visibleTasks.length === 0 && <tr><td colSpan="10" className="text-center text-gray-400 py-8">{q ? `No tasks match "${search}"` : 'No tasks'}</td></tr>}
                {visibleTasks.map((t, idx) => {
              const isAssignee = t.assigned_to === user?.id;
              const isAssigner = t.assigned_by === user?.id;
              const canEditProject = isAdmin() || isAssigner;
              const completedDate = t.reviewed_at ? fmtDate(t.reviewed_at) : null;
              return (
                <tr key={t.id} id={`deleg-row-${t.id}`} className={`${t.status === 'rejected' ? 'bg-red-50/40' : t.status === 'submitted' ? 'bg-blue-50/40' : ''}${String(t.id) === String(highlightId) ? ' ring-2 ring-amber-400 ring-inset' : ''}`}>
                  <td className="text-center text-xs text-gray-500 font-medium">{idx + 1}</td>
                  <td className="font-mono text-xs text-red-700 whitespace-nowrap">TSK-{String(t.id).padStart(4, '0')}</td>
                  <td className="align-top" style={{ minWidth: '180px', maxWidth: '340px' }}>
                    <div className="text-gray-800 font-medium whitespace-normal break-words leading-snug">
                      {cleanDesc(t.description || t.title)}
                    </div>
                    {t.attachment_url && (
                      <a href={t.attachment_url} target="_blank" rel="noreferrer" className="text-[10px] text-blue-600 hover:underline flex items-center gap-1 mt-1">
                        <FiExternalLink size={10} /> View attachment
                      </a>
                    )}
                    {t.status === 'rejected' && t.reject_reason && (
                      <div className="text-[10px] text-red-700 mt-1 flex items-start gap-1 whitespace-normal break-words"><FiAlertTriangle size={10} className="mt-0.5 flex-shrink-0" /> {t.reject_reason}</div>
                    )}
                  </td>
                  <td className="whitespace-nowrap">
                    {canEditProject ? (
                      <input
                        type="text"
                        defaultValue={t.project_name || ''}
                        placeholder="— add —"
                        className="text-xs bg-transparent border border-transparent hover:border-gray-200 focus:border-red-400 focus:bg-white rounded px-1.5 py-0.5 w-32 focus:outline-none"
                        onBlur={e => saveProject(t, e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { e.target.value = t.project_name || ''; e.target.blur(); } }}
                        title="Click to edit project"
                      />
                    ) : (
                      <span className="text-xs text-gray-700">{t.project_name || <span className="text-gray-300">—</span>}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap">{t.assigned_to_name}</td>
                  <td className="whitespace-nowrap text-xs">
                    <span className="inline-flex items-center gap-1.5">
                      {healthDot(taskHealth(t))}
                      {completedDate
                        ? <span className="text-emerald-700 font-medium">Done {completedDate}</span>
                        : t.due_date
                          ? <span className="text-gray-600">Due {t.due_date}</span>
                          : <span className="text-gray-400">—</span>}
                    </span>
                  </td>
                  <td>{statusBadge(t.status)}</td>
                  <td>
                    <div className="flex flex-col gap-1">
                      {t.proof_url && (
                        <a href={t.proof_url} target="_blank" rel="noreferrer" className="text-red-600 text-xs hover:underline flex items-center gap-1"><FiExternalLink size={11} /> View</a>
                      )}
                      {(isAssignee || isEA) && (t.status === 'pending' || t.status === 'rejected') && (
                        <button onClick={() => { setSubmitModal(t); setSubmitForm({ proof_url: '', uploading: false }); }} className="btn btn-success text-[11px] px-2 py-1 flex items-center gap-1 w-fit">
                          <FiUpload size={11} /> {t.status === 'rejected' ? 'Re-upload' : 'Upload'}
                        </button>
                      )}
                      {!t.proof_url && !((isAssignee || isEA) && (t.status === 'pending' || t.status === 'rejected')) && (
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
                    ) : isAssignee && t.status !== 'approved' ? (
                      <button onClick={() => { setExtendModal(t); setExtendForm({ requested_due_date: t.due_date || '', reason: '' }); }} className="text-[11px] text-gray-500 hover:text-red-600 flex items-center gap-1"><FiCalendar size={11} /> Request</button>
                    ) : t.extension_status === 'rejected' ? (
                      <span className="text-[10px] text-gray-400">Rejected</span>
                    ) : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                  {/* Followup Remarks — EA writes a manual note for the MD;
                      read-only for everyone else. Does not affect task status. */}
                  <td className="align-top">
                    {isEA ? (
                      <textarea
                        defaultValue={t.followup_remarks || ''}
                        placeholder="— add note —"
                        rows={2}
                        className="text-xs bg-transparent border border-transparent hover:border-gray-200 focus:border-red-400 focus:bg-white rounded px-1.5 py-0.5 w-40 resize-y focus:outline-none align-top"
                        onBlur={e => saveFollowup(t, e.target.value)}
                        onKeyDown={e => { if (e.key === 'Escape') { e.target.value = t.followup_remarks || ''; e.target.blur(); } }}
                        title="EA followup note for MD — does not affect task status"
                      />
                    ) : (
                      <span className="text-xs text-gray-700 whitespace-normal break-words block max-w-[180px]">{t.followup_remarks || <span className="text-gray-300">—</span>}</span>
                    )}
                  </td>
                  <td>
                    <div className="flex gap-1 items-center">
                      {isAdmin() && t.status === 'submitted' && (
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
              </>);
            })()}
          </tbody>
        </table>
      </div>

      {/* Mobile-only card layout REMOVED — per mam's request, the desktop
          table is used on all screens now (horizontal scroll on phones).
          Kept the block below as `hidden` to avoid a rebase conflict if we
          ever want to restore it; adjust the `hidden` class below to
          `md:hidden space-y-2` to bring it back. */}
      <div className="hidden">
        {tasks.length === 0 && <div className="card text-center text-gray-400 py-8">No tasks</div>}
        {tasks.map((t, idx) => {
          const isAssignee = t.assigned_to === user?.id;
          const isAssigner = t.assigned_by === user?.id;
          const canEditProject = isAdmin() || isAssigner;
          const completedDate = t.reviewed_at ? fmtDate(t.reviewed_at) : null;
          return (
            <div key={t.id} className={`card p-3 ${t.status === 'rejected' ? 'border-l-4 border-red-500' : t.status === 'submitted' ? 'border-l-4 border-blue-500' : ''}`}>
              <div className="flex justify-between items-start gap-2 mb-2">
                <span className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-400 font-semibold">#{idx + 1}</span>
                  <span className="font-mono text-xs text-red-700">TSK-{String(t.id).padStart(4, '0')}</span>
                </span>
                {statusBadge(t.status)}
              </div>
              <p className="text-sm text-gray-800 font-medium mb-2 line-clamp-3">{cleanDesc(t.description || t.title)}</p>
              {t.attachment_url && (
                <a href={t.attachment_url} target="_blank" rel="noreferrer" className="text-[11px] text-blue-600 hover:underline flex items-center gap-1 mb-2">
                  <FiExternalLink size={11} /> View attachment
                </a>
              )}

              {/* Project — always shown, inline-editable for admin/assigner,
                  read-only for others. Matches the desktop table column. */}
              <div className="mb-2 text-[11px] text-gray-600">
                <span className="text-gray-400">Project: </span>
                {canEditProject ? (
                  <input
                    type="text"
                    defaultValue={t.project_name || ''}
                    placeholder="— add —"
                    className="bg-transparent border border-transparent hover:border-gray-200 focus:border-red-400 focus:bg-white rounded px-1 py-0.5 text-[11px] font-semibold focus:outline-none w-[70%]"
                    onBlur={e => saveProject(t, e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { e.target.value = t.project_name || ''; e.target.blur(); } }}
                  />
                ) : (
                  <b>{t.project_name || <span className="text-gray-300">—</span>}</b>
                )}
              </div>

              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-gray-600 mb-2">
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
              {t.extension_status === 'pending' && t.requested_due_date && (
                <div className="bg-amber-50 border border-amber-200 rounded px-2 py-1 text-[11px] text-amber-800 mb-2 flex items-start gap-1"><FiCalendar size={11} className="mt-0.5" /> Extension → {t.requested_due_date}</div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {t.proof_url && <a href={t.proof_url} target="_blank" rel="noreferrer" className="btn btn-secondary text-[11px] px-2 py-1 flex items-center gap-1"><FiExternalLink size={11} /> Proof</a>}
                {(isAssignee || isEA) && (t.status === 'pending' || t.status === 'rejected') && (
                  <button onClick={() => { setSubmitModal(t); setSubmitForm({ proof_url: '', uploading: false }); }} className="btn btn-success text-[11px] px-2 py-1 flex items-center gap-1">
                    <FiUpload size={11} /> {t.status === 'rejected' ? 'Re-upload' : 'Upload Proof'}
                  </button>
                )}
                {isAssignee && t.status !== 'approved' && t.extension_status !== 'pending' && (
                  <button onClick={() => { setExtendModal(t); setExtendForm({ requested_due_date: t.due_date || '', reason: '' }); }} className="btn btn-secondary text-[11px] px-2 py-1 flex items-center gap-1"><FiCalendar size={11} /> Extension</button>
                )}
                {isAdmin() && t.status === 'submitted' && (
                  <>
                    <button onClick={() => approve(t)} className="btn btn-success text-[11px] px-2 py-1 flex items-center gap-1"><FiCheck size={11} /> Approve</button>
                    <button onClick={() => { setRejectModal(t); setRejectReason(''); }} className="btn btn-danger text-[11px] px-2 py-1 flex items-center gap-1"><FiX size={11} /> Reject</button>
                  </>
                )}
                {isAdmin() && t.extension_status === 'pending' && (
                  <>
                    <button onClick={() => approveExtension(t)} className="btn btn-success text-[11px] px-2 py-1 flex items-center gap-1"><FiCheck size={11} /> Ext ✓</button>
                    <button onClick={() => rejectExtension(t)} className="btn btn-danger text-[11px] px-2 py-1 flex items-center gap-1"><FiX size={11} /> Ext ✗</button>
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

      </>)}

      {/* Create Modal */}
      <Modal isOpen={createModal} onClose={() => setCreateModal(false)} title="Assign New Task" wide>
        <form onSubmit={save} className="space-y-3">
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
                {/* Upload a recorded audio file → server transcribes it to text. */}
                <button type="button" disabled={transcribing} onClick={() => audioInputRef.current?.click()}
                  className={`text-[11px] px-2 py-1 rounded-full flex items-center gap-1 ${transcribing ? 'bg-gray-100 text-gray-400 cursor-wait' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                  <FiUpload size={12} /> {transcribing ? 'Transcribing…' : 'Upload audio'}
                </button>
                <input ref={audioInputRef} type="file" accept="audio/*,.m4a,.mp3,.wav,.ogg,.opus,.webm" className="hidden"
                  onChange={e => handleAudioUpload(e.target.files?.[0])} />
              </span>
            </label>
            <textarea className="input" rows="4" required value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value, _base: undefined })} placeholder="Type or speak the task details…" />
            {!SR && <p className="text-[10px] text-amber-600 mt-0.5">Voice input needs Chrome or Edge browser.</p>}
          </div>
          <div>
            <label className="label">Assign To *</label>
            <SearchableSelect
              options={users.map(u => ({ ...u, label: `${u.name}${u.username ? ' (@' + u.username + ')' : ''}` }))}
              value={form.assigned_to || null}
              valueKey="id" displayKey="label"
              placeholder="Search user by name or username…"
              onChange={(u) => setForm({ ...form, assigned_to: u?.id || '' })}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Due Date</label>
              <input className="input" type="date" value={form.due_date || ''} onChange={e => setForm({ ...form, due_date: e.target.value })} />
            </div>
            <div>
              <label className="label">Project Name <span className="text-gray-400 font-normal">(optional)</span></label>
              <SearchableSelect
                options={(() => {
                  // Merge legacy free-text project names already on tasks so
                  // they don't disappear when admin opens the modal.
                  const merged = [...projects];
                  const seen = new Set(projects.map(p => p.name.toLowerCase()));
                  for (const t of tasks) {
                    if (t.project_name && !seen.has(t.project_name.toLowerCase())) {
                      seen.add(t.project_name.toLowerCase());
                      merged.push({ name: t.project_name, subtitle: '(existing tag)' });
                    }
                  }
                  return merged.map(p => ({
                    ...p,
                    label: p.subtitle ? `${p.name} — ${p.subtitle}` : p.name,
                  }));
                })()}
                value={form.project_name || null}
                valueKey="name" displayKey="label"
                placeholder="Search project from Business Book…"
                onChange={(p) => setForm({ ...form, project_name: p?.name || '' })}
              />
              <p className="text-[10px] text-gray-400 mt-0.5">From Business Book unique projects. Type to filter — pick one or leave blank.</p>
            </div>
          </div>
          <div>
            <label className="label">Attachment <span className="text-gray-400 font-normal">(optional — e.g. brief, drawing, photo)</span></label>
            {/* Two side-by-side affordances — mam's MD (2026-05-21):
                "Give option of click photo in attachment".  The first
                button (capture="environment") opens the phone's rear
                camera directly; the second is the normal file picker
                for desktops / picking an existing photo / PDF / doc. */}
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
            {form.attachment_file && <p className="text-[10px] text-emerald-600 mt-1">Selected: {form.attachment_file.name} ({(form.attachment_file.size / 1024 / 1024).toFixed(1)} MB · will compress before upload if &gt; 500 KB)</p>}
          </div>
          {/* Upload-progress strip — keeps users from thinking the
              modal froze (mam's MD, 2026-05-21).  Both compressing and
              uploading drive the same bar; jumps to 100 % once the
              POST /api/delegations finishes. */}
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
            <button type="submit" disabled={saving} className="btn btn-primary disabled:opacity-50 flex items-center gap-1.5">
              {saving ? `Uploading… ${savePct}%` : 'Assign Task'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit Task Modal — admin / assigner only */}
      <Modal isOpen={!!editModal} onClose={() => { setEditModal(null); setEditForm({}); }} title={editModal ? `Edit task — ${editModal.title || ''}` : 'Edit task'} wide>
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
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Due Date</label>
                <input type="date" className="input" value={editForm.due_date || ''} onChange={e => setEditForm(f => ({ ...f, due_date: e.target.value }))} />
              </div>
              <div>
                <label className="label">Project (optional)</label>
                <SearchableSelect
                  options={(() => {
                    const merged = [...projects];
                    const seen = new Set(projects.map(p => p.name.toLowerCase()));
                    if (editForm.project_name && !seen.has(editForm.project_name.toLowerCase())) {
                      merged.push({ name: editForm.project_name, subtitle: '(existing tag)' });
                    }
                    return merged.map(p => ({ ...p, label: p.subtitle ? `${p.name} — ${p.subtitle}` : p.name }));
                  })()}
                  value={editForm.project_name || null}
                  valueKey="name" displayKey="label"
                  placeholder="Search project from Business Book…"
                  onChange={(p) => setEditForm(f => ({ ...f, project_name: p?.name || '' }))}
                />
              </div>
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
      <Modal isOpen={!!submitModal} onClose={() => setSubmitModal(null)} title={submitModal ? `Submit proof — ${cleanDesc(submitModal.description || submitModal.title).slice(0, 60)}` : 'Submit proof'}>
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
                photo in attachment".  Camera-first button on the left,
                file-picker fallback on the right. */}
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
            {/* Upload progress bar — replaces the silent "Uploading…"
                line with a visible %.  Mam's MD reported phantom
                hangs because there was no feedback on a 30-60s upload
                of an uncompressed phone photo. */}
            {submitForm.uploading && (
              <div className="mt-1.5">
                <div className="flex justify-between text-[10px] text-blue-700 mb-0.5">
                  <span>Uploading proof…</span>
                  <span className="font-mono">{proofPct}%</span>
                </div>
                <div className="h-1.5 bg-blue-100 rounded overflow-hidden">
                  <div className="h-full bg-blue-600 transition-all" style={{ width: `${proofPct}%` }} />
                </div>
              </div>
            )}
            {submitForm.proof_url && <p className="text-xs text-emerald-600 mt-1">✓ Ready to submit</p>}
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setSubmitModal(null)} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={!submitForm.proof_url || submitForm.uploading} className="btn btn-primary disabled:opacity-50">Submit for Approval</button>
          </div>
        </form>
      </Modal>

      {/* Reject Modal */}
      <Modal isOpen={!!rejectModal} onClose={() => setRejectModal(null)} title={rejectModal ? `Reject — ${cleanDesc(rejectModal.description || rejectModal.title).slice(0, 60)}` : 'Reject'}>
        <form onSubmit={reject} className="space-y-3">
          <div>
            <label className="label">Reason for rejection *</label>
            <textarea className="input" rows="3" value={rejectReason} onChange={e => setRejectReason(e.target.value)} required placeholder="Explain what needs to change so the assignee can fix and resubmit" />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setRejectModal(null)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-danger">Reject & Send Back</button>
          </div>
        </form>
      </Modal>

      {/* Request Extension Modal (assignee) — routed to admin for approval */}
      <Modal isOpen={!!extendModal} onClose={() => setExtendModal(null)} title="Request Due-Date Extension">
        <form onSubmit={requestExtension} className="space-y-3">
          <p className="text-xs text-gray-500">Ask admin for more time on this task. They will see your request and approve or reject it.</p>
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
