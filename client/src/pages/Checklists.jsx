import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiEdit2, FiTrash2, FiUpload, FiExternalLink, FiDownload, FiCalendar, FiCheck, FiX, FiClock } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import TimePicker from '../components/TimePicker';

// Mam (2026-05-22): "department will on drop down :- Sales, Accounts,
// Marketing, Finance, IT, MDO, Operations, Admin" + Purchase added
// 2026-05-22 in a follow-up.  Free-text entries from legacy rows
// still display via the (legacy) option preserved in the select.
const DEPARTMENTS = ['Sales', 'Accounts', 'Purchase', 'Marketing', 'Finance', 'IT', 'MDO', 'Operations', 'Admin'];

export default function Checklists() {
  const { user, canDelete, canEdit, isAdmin } = useAuth();
  const canManage = () => isAdmin() || canEdit('checklists');
  const [checklists, setChecklists] = useState([]);
  const [users, setUsers] = useState([]);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [personFilter, setPersonFilter] = useState('');
  // Today's completions keyed by checklist_id — lets us mark rows green + show proof link inline
  const [todayDone, setTodayDone] = useState({});
  const [uploadingId, setUploadingId] = useState(null);
  // Mam (2026-05-22): bulk add modal — paste many task lines that
  // share frequency / assignee / dates / proof_type.
  const [bulkModal, setBulkModal] = useState(false);
  const [bulkForm, setBulkForm] = useState({});
  // Mam (2026-05-22): text-proof completion modal — opens when the
  // user clicks Mark Done on a row whose proof_type === 'text'.
  const [textProofRow, setTextProofRow] = useState(null);
  const [textProofDraft, setTextProofDraft] = useState('');

  // History / approval tab — mam (2026-05-16): "where i can check as
  // per daily and previous check list done or not done proof and
  // after need to approval".  Switching to 'by-date' loads the
  // /hr/checklists/by-date endpoint with completion + approval data.
  // Mam (2026-05-22) shared her Google Sheet master+instances example;
  // the by-date view IS the instance grid she wants, so default to it.
  // 'master' = template list, 'by-date' = per-day instance grid.
  const [view, setView] = useState('by-date');
  const [historyDate, setHistoryDate] = useState(new Date().toISOString().slice(0, 10));
  const [historyRows, setHistoryRows] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all'); // all | done | not_done | pending | rejected
  const [deptFilter, setDeptFilter] = useState('');
  // Follow-up view (mam, 2026-05-22) — per-task timeline grid spanning
  // N days back → today → N days forward.  Server returns one cell
  // per (task, date) with status (done_approved / done_pending /
  // done_rejected / missed / today / future / na).
  const [followup, setFollowup] = useState(null);
  const [followupBack, setFollowupBack] = useState(7);
  const [followupForward, setFollowupForward] = useState(7);
  // Sub-view inside Follow-up: 'list' = one row per (task, date)
  // matching mam's Google Sheet, 'timeline' = the matrix view.
  // Mam (2026-05-22) prefers list because each row carries its own
  // Upload Proof action.
  const [followupSubView, setFollowupSubView] = useState('list');
  const loadFollowup = async (back = followupBack, forward = followupForward) => {
    try {
      const r = await api.get('/hr/checklists/followup', { params: { back, forward } });
      setFollowup(r.data);
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to load follow-up'); }
  };

  const loadHistory = async (d) => {
    setHistoryLoading(true);
    try {
      const r = await api.get('/hr/checklists/by-date', { params: { date: d || historyDate } });
      setHistoryRows(r.data?.rows || []);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to load history');
    } finally {
      setHistoryLoading(false);
    }
  };

  // Admin approve / reject a completion.  Optional note via prompt
  // (will swap to a proper modal if mam asks for richer UX later).
  const decideCompletion = async (compId, status) => {
    let note = '';
    if (status === 'rejected') {
      note = prompt('Why rejected? (visible to the assignee)') || '';
      if (!note.trim()) { toast.error('Reason required for rejection'); return; }
    }
    try {
      await api.post(`/hr/checklists/completions/${compId}/decision`, { status, note });
      toast.success(`Marked ${status}`);
      loadHistory();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed');
    }
  };

  const load = () => {
    api.get('/hr/checklists').then(r => setChecklists(r.data));
    // Whether each of my own checklists is already done today (used for the inline upload button)
    api.get('/hr/checklists/my-today').then(r => {
      const map = {};
      (r.data || []).forEach(c => { if (c.completion_id) map[c.id] = { proof_url: c.proof_url, submitted_at: c.submitted_at }; });
      setTodayDone(map);
    }).catch(() => setTodayDone({}));
  };
  // Mam (2026-05-22): "show this name to assign in data which is inactive"
  // — ex-employees must not appear in assignment dropdowns.  Server now
  // filters with ?active_only=1.  Past records keep the snapshot.
  useEffect(() => { load(); api.get('/auth/users?active_only=1').then(r => setUsers(r.data)); }, []);
  // Auto-load today's instance grid on first paint so the page lands
  // straight on the actionable view (mam's preferred mental model).
  useEffect(() => { loadHistory(historyDate); /* eslint-disable-next-line */ }, []);

  // Inline "Upload Proof" — picks a file, uploads to /upload, then marks the
  // checklist complete for today with that URL. Appears only on rows assigned
  // to the logged-in user.
  const uploadProof = async (c, file) => {
    setUploadingId(c.id);
    try {
      let proofUrl = null;
      if (file) {
        const fd = new FormData(); fd.append('file', file);
        const up = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        proofUrl = up.data.url;
      }
      // Mam (2026-05-22): proof_type='none' rows pass null file and
      // backend accepts it (no enforcement).  Photo/pdf/file rows
      // always have a file at this point.
      await api.post(`/hr/checklists/${c.id}/complete`, { proof_url: proofUrl });
      toast.success(file ? `Proof uploaded for "${c.description || c.title}"` : `Marked done`);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Upload failed'); }
    setUploadingId(null);
  };

  // Mam (2026-05-22): text-proof completion — submitted via the
  // dedicated modal so admin can type a longer note than fits inline.
  const submitTextProof = async () => {
    if (!textProofDraft.trim()) return toast.error('Type your note before submitting');
    try {
      await api.post(`/hr/checklists/${textProofRow.id}/complete`, { notes: textProofDraft });
      toast.success('Marked done');
      setTextProofRow(null); setTextProofDraft(''); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Mam (2026-05-22): Excel upload for bulk — server parses the file,
  // returns rows as JSON, we paste them into the textarea (formatted
  // as "Task | Label | Type") so admin can review/edit before submit.
  const [excelImporting, setExcelImporting] = useState(false);
  const [templateDownloading, setTemplateDownloading] = useState(false);

  // Mam (2026-05-22): Chrome's <a download> doesn't carry the JWT, so
  // the protected /bulk-template.xlsx route returns 401 and the browser
  // shows "sign in to download".  Fetch via axios (which DOES attach
  // the Bearer token), then trigger a Blob download client-side.
  const downloadTemplate = async () => {
    setTemplateDownloading(true);
    try {
      const r = await api.get('/hr/checklists/bulk-template.xlsx', { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([r.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'checklists-bulk-template.xlsx';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Free the blob URL after the click has been queued.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to download template');
    } finally {
      setTemplateDownloading(false);
    }
  };
  const importExcel = async (file) => {
    if (!file) return;
    setExcelImporting(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api.post('/hr/checklists/parse-excel', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const rows = r.data?.rows || [];
      if (rows.length === 0) {
        toast.error('No tasks found in the Excel file');
        return;
      }
      // Format each row as "Description | Label | Type | Time" —
      // trailing empty columns are dropped, but middle columns get
      // emptied (e.g. "Task |  | photo | 11:00") so the splitter still
      // assigns the right value to the right column index.
      const formatted = rows.map(row => {
        const parts = [row.description];
        const hasL = !!row.proof_label;
        const hasT = !!row.proof_type;
        const hasTime = !!row.due_time;
        if (hasL || hasT || hasTime) parts.push(row.proof_label || '');
        if (hasT || hasTime)         parts.push(row.proof_type || '');
        if (hasTime)                 parts.push(row.due_time);
        return parts.join(' | ');
      }).join('\n');
      // Append to existing textarea content (if any) so admin can
      // upload multiple files / mix typed + imported.
      setBulkForm(f => ({
        ...f,
        lines: f.lines && f.lines.trim() ? f.lines.trimEnd() + '\n' + formatted : formatted,
      }));
      toast.success(`Imported ${rows.length} task(s) from Excel — review and adjust before submitting`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to parse Excel file');
    } finally {
      setExcelImporting(false);
    }
  };

  // Mam (2026-05-22): bulk add — POST many tasks at once.  Now
  // accepts an ARRAY of assignees so one bulk submit creates rows
  // for every picked user.  Server returns added = lines × users.
  const submitBulk = async () => {
    const lines = String(bulkForm.lines || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (lines.length === 0) return toast.error('Paste at least one task line');
    const assignees = (bulkForm.assigned_to_ids || []).filter(Boolean);
    if (assignees.length === 0 && !bulkForm.assigned_to) {
      return toast.error('Pick at least one assignee');
    }
    try {
      const r = await api.post('/hr/checklists/bulk', {
        ...bulkForm,
        tasks: lines,
        assigned_to_ids: assignees.length ? assignees : [bulkForm.assigned_to],
      });
      const n = r.data?.added || (lines.length * Math.max(1, assignees.length));
      toast.success(`Added ${n} checklist task(s)`);
      setBulkModal(false); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Bulk add failed');
    }
  };

  // Group checklists by assignee so the admin view shows one section per person.
  // Sections are ordered alphabetically by assignee name.
  const visible = checklists.filter(c => {
    if (personFilter && String(c.assigned_to) !== String(personFilter)) return false;
    if (deptFilter   && c.department !== deptFilter) return false;
    return true;
  });
  const byPerson = visible.reduce((acc, c) => {
    const key = c.assigned_to_name || 'Unassigned';
    (acc[key] = acc[key] || []).push(c);
    return acc;
  }, {});
  const groupOrder = Object.keys(byPerson).sort((a, b) => a.localeCompare(b));

  const save = async (e) => {
    e.preventDefault();
    if (editing) { await api.put(`/hr/checklists/${editing.id}`, form); }
    else { await api.post('/hr/checklists', form); }
    toast.success(editing ? 'Updated' : 'Created');
    setModal(false); load();
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="font-semibold">Checklists & Recurring Tasks</h3>
        <div className="flex gap-2">
          <button onClick={() => exportCsv('checklists',
            ['Description','Frequency','Due Date','Due Time','Assigned To','Status'],
            checklists.map(c => [c.description || c.title, c.frequency, c.due_date, c.due_time, c.assigned_to_name, c.status]))}
            className="btn btn-secondary flex items-center gap-2"><FiDownload /> Export Excel</button>
          {canManage() && (
            <button onClick={() => {
              // Mam (2026-05-22): "by default end date is 31/12/2026"
              // — hard-pinned to 2026-12-31, NOT current-year (mam:
              // "not 2027 31/12/2026").  Admin overrides when needed.
              const today = new Date();
              const todayIso = today.toISOString().slice(0, 10);
              setEditing(null);
              setForm({
                description: '', frequency: 'monthly', due_date: '', due_time: '', assigned_to: '',
                recurrence_start_date: todayIso,
                recurrence_end_date:   '2026-12-31',
                proof_type: 'photo',
              });
              setModal(true);
            }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Checklist</button>
          )}
          {/* Mam (2026-05-22): bulk add — paste many task lines that
              share the same frequency / assignee / dates / proof type. */}
          {canManage() && (
            <button onClick={() => {
              const today = new Date();
              const todayIso = today.toISOString().slice(0, 10);
              setBulkForm({
                lines: '', frequency: 'monthly', due_date: '', due_time: '',
                assigned_to: '', assigned_to_ids: [],
                department: '',
                recurrence_start_date: todayIso, recurrence_end_date: '2026-12-31',
                proof_type: 'photo',
              });
              setBulkModal(true);
            }} className="btn btn-secondary flex items-center gap-2"><FiPlus /> Bulk Add</button>
          )}
        </div>
      </div>
      {!canManage() && (
        <p className="text-xs text-gray-500 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Only admins can create checklists. Tap <span className="font-semibold text-emerald-700">Upload Proof</span> next to each of your tasks below to submit.
        </p>
      )}

      {/* Tab toggle — match mam's mental model from her Sheet:
          "By Date" = today's instance grid (default; her Sheet 2 view),
          "Master" = recurring-template editor (her Sheet 1 view). */}
      <div className="flex gap-2 flex-wrap items-center">
        <button onClick={() => { setView('by-date'); loadHistory(historyDate); }}
                className={`btn ${view === 'by-date' ? 'btn-primary' : 'btn-secondary'} text-sm flex items-center gap-1.5`}>
          <FiCalendar size={13} /> Today / By Date
        </button>
        <button onClick={() => setView('current')}
                className={`btn ${view === 'current' ? 'btn-primary' : 'btn-secondary'} text-sm flex items-center gap-1.5`}>
          Master Templates
        </button>
        {/* Mam (2026-05-22): "i need followup checklist where all
            record mention previous, present, future" — per-task
            timeline grid with past / today / upcoming cells. */}
        <button onClick={() => { setView('followup'); if (!followup) loadFollowup(); }}
                className={`btn ${view === 'followup' ? 'btn-primary' : 'btn-secondary'} text-sm flex items-center gap-1.5`}>
          <FiClock size={13} /> Follow-up Timeline
        </button>
        {view === 'by-date' && (
          <>
            <input type="date" className="input text-sm w-44" value={historyDate}
                   onChange={e => { setHistoryDate(e.target.value); loadHistory(e.target.value); }} />
            <button onClick={() => { const y = new Date(); y.setDate(y.getDate() - 1); const iso = y.toISOString().slice(0, 10); setHistoryDate(iso); loadHistory(iso); }}
                    className="btn btn-secondary text-xs">Yesterday</button>
            <button onClick={() => { const iso = new Date().toISOString().slice(0, 10); setHistoryDate(iso); loadHistory(iso); }}
                    className="btn btn-secondary text-xs">Today</button>
          </>
        )}
      </div>

      {/* KPI strip on by-date view — mam's master-checklist summary */}
      {view === 'by-date' && !historyLoading && historyRows.length > 0 && (() => {
        const totals = {
          total:    historyRows.length,
          done:     historyRows.filter(r => r.completion_id).length,
          not_done: historyRows.filter(r => !r.completion_id).length,
          pending:  historyRows.filter(r => r.approval_status === 'pending' && r.completion_id).length,
          approved: historyRows.filter(r => r.approval_status === 'approved').length,
          rejected: historyRows.filter(r => r.approval_status === 'rejected').length,
        };
        const pill = (k, label, val, color) => (
          <button onClick={() => setStatusFilter(k)}
            className={`card p-3 border-l-4 ${color} text-left hover:shadow ${statusFilter === k ? 'ring-2 ring-offset-1 ring-blue-400' : ''}`}>
            <div className="text-[10px] uppercase text-gray-500">{label}</div>
            <div className="text-2xl font-bold">{val}</div>
          </button>
        );
        return (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
            {pill('all',      'Total',    totals.total,    'border-l-gray-500')}
            {pill('done',     'Done',     totals.done,     'border-l-emerald-500')}
            {pill('not_done', 'Not Done', totals.not_done, 'border-l-rose-500')}
            {pill('pending',  'Pending Approval', totals.pending, 'border-l-amber-500')}
            {pill('approved', 'Approved', totals.approved, 'border-l-emerald-600')}
            {pill('rejected', 'Rejected', totals.rejected, 'border-l-red-600')}
          </div>
        );
      })()}

      {/* Department filter on by-date view */}
      {view === 'by-date' && historyRows.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-gray-500 font-semibold uppercase">Department:</label>
          <select className="select text-sm max-w-xs" value={deptFilter} onChange={e => setDeptFilter(e.target.value)}>
            <option value="">All departments</option>
            {[...new Set(historyRows.map(r => r.department).filter(Boolean))].sort().map(d => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <span className="text-xs text-gray-400">
            {historyLoading ? 'loading…' : (() => {
              const filtered = historyRows.filter(r => {
                if (deptFilter && r.department !== deptFilter) return false;
                if (statusFilter === 'done')     return !!r.completion_id;
                if (statusFilter === 'not_done') return !r.completion_id;
                if (statusFilter === 'pending')  return r.approval_status === 'pending' && r.completion_id;
                if (statusFilter === 'approved') return r.approval_status === 'approved';
                if (statusFilter === 'rejected') return r.approval_status === 'rejected';
                return true;
              });
              return `${filtered.length} row${filtered.length === 1 ? '' : 's'}`;
            })()}
          </span>
        </div>
      )}

      {/* ─── BY-DATE / APPROVAL view ─────────────────────────────── */}
      {view === 'by-date' && (
        <div className="card p-0 overflow-x-auto">
          <table className="freeze-head">
            <thead>
              <tr>
                <th>Person</th>
                <th>Department</th>
                <th>Task</th>
                <th>Frequency</th>
                <th>Done?</th>
                <th>Proof</th>
                <th>Approval</th>
                <th>Submitted</th>
                {canManage() && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {historyRows.length === 0 && !historyLoading && (
                <tr><td colSpan={canManage() ? 9 : 8} className="text-center py-6 text-gray-400">
                  No checklists for this date.
                </td></tr>
              )}
              {historyRows.filter(r => {
                if (deptFilter && r.department !== deptFilter) return false;
                if (statusFilter === 'done')     return !!r.completion_id;
                if (statusFilter === 'not_done') return !r.completion_id;
                if (statusFilter === 'pending')  return r.approval_status === 'pending' && r.completion_id;
                if (statusFilter === 'approved') return r.approval_status === 'approved';
                if (statusFilter === 'rejected') return r.approval_status === 'rejected';
                return true;
              }).map(r => {
                const done = !!r.completion_id;
                const apStat = r.approval_status || (done ? 'pending' : '—');
                const apBadge = apStat === 'approved' ? 'bg-emerald-100 text-emerald-700'
                              : apStat === 'rejected' ? 'bg-red-100 text-red-700'
                              : apStat === 'pending' ? 'bg-amber-100 text-amber-700'
                              : 'bg-gray-100 text-gray-500';
                return (
                  <tr key={r.id} className={done ? '' : 'bg-gray-50/50'}>
                    <td className="text-xs font-medium">{r.assigned_to_name || '—'}</td>
                    <td className="text-[10px]">
                      {r.department ? (
                        <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">{r.department}</span>
                      ) : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="font-medium max-w-md"><div className="line-clamp-2">{r.description || r.title}</div></td>
                    <td className="capitalize text-xs">{r.frequency}</td>
                    <td>
                      {done ? (
                        <span className="text-emerald-700 font-bold inline-flex items-center gap-1 text-xs"><FiCheck size={12} /> Done</span>
                      ) : (
                        <span className="text-red-700 font-bold inline-flex items-center gap-1 text-xs"><FiX size={12} /> Not done</span>
                      )}
                    </td>
                    <td className="text-xs">
                      {r.proof_url ? (
                        <a href={r.proof_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:text-blue-800 underline inline-flex items-center gap-1">
                          <FiExternalLink size={11} /> View
                        </a>
                      ) : <span className="text-gray-400">—</span>}
                    </td>
                    <td>
                      <span className={`text-[10px] px-2 py-0.5 rounded font-semibold uppercase ${apBadge}`}>{apStat}</span>
                      {r.approval_note && (
                        <div className="text-[10px] text-gray-500 italic mt-0.5" title={r.approval_note}>
                          {r.approval_note.slice(0, 40)}{r.approval_note.length > 40 ? '…' : ''}
                        </div>
                      )}
                      {r.approved_by_name && (
                        <div className="text-[10px] text-gray-500">by {r.approved_by_name}</div>
                      )}
                    </td>
                    <td className="text-xs text-gray-500 font-mono">
                      {r.submitted_at ? new Date(r.submitted_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—'}
                    </td>
                    {canManage() && (
                      <td>
                        {done && apStat === 'pending' ? (
                          <div className="flex gap-1">
                            <button onClick={() => decideCompletion(r.completion_id, 'approved')}
                                    className="px-2 py-1 text-[10px] bg-emerald-100 text-emerald-700 hover:bg-emerald-200 rounded font-semibold inline-flex items-center gap-1">
                              <FiCheck size={10} /> Approve
                            </button>
                            <button onClick={() => decideCompletion(r.completion_id, 'rejected')}
                                    className="px-2 py-1 text-[10px] bg-red-100 text-red-700 hover:bg-red-200 rounded font-semibold inline-flex items-center gap-1">
                              <FiX size={10} /> Reject
                            </button>
                          </div>
                        ) : done && apStat === 'rejected' ? (
                          <button onClick={() => decideCompletion(r.completion_id, 'approved')}
                                  className="px-2 py-1 text-[10px] bg-emerald-100 text-emerald-700 hover:bg-emerald-200 rounded font-semibold inline-flex items-center gap-1">
                            <FiCheck size={10} /> Reverse to Approved
                          </button>
                        ) : done && apStat === 'approved' ? (
                          <button onClick={() => decideCompletion(r.completion_id, 'rejected')}
                                  className="text-[10px] text-gray-500 hover:text-red-600 underline">
                            Re-reject
                          </button>
                        ) : (
                          <span className="text-[10px] text-gray-400 italic">No submission</span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}


      {/* Admin-only filter by assignee (regular users only see their own anyway).
          Hidden in the by-date / approval view since that has its own date picker. */}
      {view === 'current' && canManage() && (
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-gray-500 font-semibold uppercase">Person:</label>
          <select className="select text-sm max-w-xs" value={personFilter} onChange={e => setPersonFilter(e.target.value)}>
            <option value="">All people</option>
            {users.filter(u => u.active !== 0).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          {/* Department filter on Master Templates too (mam, 2026-05-22:
              department should be a first-class facet alongside person). */}
          <label className="text-xs text-gray-500 font-semibold uppercase ml-3">Department:</label>
          <select className="select text-sm max-w-xs" value={deptFilter} onChange={e => setDeptFilter(e.target.value)}>
            <option value="">All departments</option>
            {[...new Set(checklists.map(c => c.department).filter(Boolean))].sort().map(d => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <span className="text-xs text-gray-400">{visible.length} task{visible.length === 1 ? '' : 's'}</span>
        </div>
      )}

      {/* ─── FOLLOW-UP view ──────────────────────────────────────── */}
      {view === 'followup' && (
        <div className="space-y-2">
          {/* Sub-toggle: List (default, one row per instance with
              Upload Proof action) vs Timeline (matrix overview). */}
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => setFollowupSubView('list')}
                    className={`btn ${followupSubView === 'list' ? 'btn-primary' : 'btn-secondary'} text-sm`}>
              📋 List · Upload Proof
            </button>
            <button onClick={() => setFollowupSubView('timeline')}
                    className={`btn ${followupSubView === 'timeline' ? 'btn-primary' : 'btn-secondary'} text-sm`}>
              📅 Timeline Grid
            </button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-gray-500 font-semibold uppercase">Window:</label>
            <select className="select text-sm" value={followupBack} onChange={e => { const v = +e.target.value; setFollowupBack(v); loadFollowup(v, followupForward); }}>
              <option value={3}>3 days back</option>
              <option value={7}>7 days back</option>
              <option value={14}>14 days back</option>
              <option value={30}>30 days back</option>
            </select>
            <span className="text-xs text-gray-400">→ today →</span>
            <select className="select text-sm" value={followupForward} onChange={e => { const v = +e.target.value; setFollowupForward(v); loadFollowup(followupBack, v); }}>
              <option value={3}>3 days forward</option>
              <option value={7}>7 days forward</option>
              <option value={14}>14 days forward</option>
            </select>
            {/* Legend — only shown on the timeline grid */}
            {followupSubView === 'timeline' && (
              <div className="ml-auto flex items-center gap-2 text-[10px] text-gray-600">
                <Cell s="done_approved" /> Approved
                <Cell s="done_pending" /> Pending
                <Cell s="done_rejected" /> Rejected
                <Cell s="missed" /> Missed
                <Cell s="today" /> Today
                <Cell s="future" /> Future
              </div>
            )}
          </div>

          {!followup && <div className="card p-6 text-center text-gray-400">Loading…</div>}
          {followup && followup.rows.length === 0 && <div className="card p-8 text-center text-gray-400">No checklists yet</div>}

          {/* ─── LIST view (default) ───────────────────────────────
              Flattens every (task × applicable date) into one row,
              matching mam's Google Sheet (Name / Task ID / Freq /
              Task / Planned / Status / Action).  Each pending row
              has an Upload Proof button that calls /complete with
              the specific date. */}
          {followup && followupSubView === 'list' && followup.rows.length > 0 && (() => {
            // Flatten cells → instance rows (skip na = out-of-window
            // or wrong weekday; skip future = no point uploading yet).
            const instances = [];
            for (const t of followup.rows) {
              for (const c of t.cells) {
                if (c.status === 'na' || c.status === 'future') continue;
                instances.push({ task: t, cell: c });
              }
            }
            // Most-recent first so today + recent days surface at top
            instances.sort((a, b) => b.cell.date.localeCompare(a.cell.date));
            const statusBadge = {
              done_approved: { label: '✓ Approved',     css: 'bg-emerald-100 text-emerald-700' },
              done_pending:  { label: '⏳ Pending Appr', css: 'bg-amber-100 text-amber-700' },
              done_rejected: { label: '✗ Rejected',     css: 'bg-rose-100 text-rose-700' },
              missed:        { label: '✗ Missed',       css: 'bg-red-100 text-red-700' },
              today:         { label: '○ Today',        css: 'bg-blue-100 text-blue-700' },
            };
            return (
              <div className="card p-0 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-amber-50 text-gray-700 text-[10px] uppercase">
                    <tr>
                      <th className="px-2 py-2 text-left">Name</th>
                      <th className="px-2 py-2 text-left">Task ID</th>
                      <th className="px-2 py-2 text-left">Freq</th>
                      <th className="px-2 py-2 text-left">Task</th>
                      <th className="px-2 py-2 text-left">Planned</th>
                      <th className="px-2 py-2 text-left">Status</th>
                      <th className="px-2 py-2 text-left">Department</th>
                      <th className="px-2 py-2 text-center">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {instances.map((row, idx) => {
                      const c = row.cell;
                      const t = row.task;
                      const badge = statusBadge[c.status] || { label: c.status, css: 'bg-gray-100 text-gray-700' };
                      const dateLabel = new Date(c.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
                      const canUpload = t.assigned_to === user?.id || canManage();
                      const isPending = c.status === 'missed' || c.status === 'today' || c.status === 'done_rejected';
                      const uploadingThis = uploadingId === `${t.id}-${c.date}`;
                      return (
                        <tr key={`${t.id}-${c.date}`} className={`border-t ${idx % 2 ? 'bg-amber-50/30' : ''} hover:bg-blue-50/40`}>
                          <td className="px-2 py-1.5">{t.assigned_to_name || '—'}</td>
                          <td className="px-2 py-1.5 font-mono text-[10px] text-gray-500">#{t.id}</td>
                          <td className="px-2 py-1.5 capitalize text-[11px]">{t.frequency}</td>
                          <td className="px-2 py-1.5 font-medium max-w-md">
                            <div className="line-clamp-2" title={t.description}>{t.description}</div>
                          </td>
                          <td className="px-2 py-1.5 font-mono">{dateLabel}</td>
                          <td className="px-2 py-1.5"><span className={`px-2 py-0.5 rounded text-[10px] font-bold ${badge.css}`}>{badge.label}</span></td>
                          <td className="px-2 py-1.5 text-[10px]">
                            {t.department ? <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">{t.department}</span> : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <div className="flex gap-1 items-center justify-center flex-wrap">
                              {c.proof_url && (
                                <a href={c.proof_url} target="_blank" rel="noreferrer" className="text-[11px] text-blue-700 hover:underline inline-flex items-center gap-1">
                                  <FiExternalLink size={11} /> View
                                </a>
                              )}
                              {canUpload && isPending && (
                                <label className={`btn btn-success text-[10px] px-2 py-1 cursor-pointer flex items-center gap-1 ${uploadingThis ? 'opacity-60 pointer-events-none' : ''}`}>
                                  <FiUpload size={10} /> {uploadingThis ? '…' : (c.status === 'done_rejected' ? 'Re-upload' : 'Upload Proof')}
                                  <input type="file" className="hidden" onChange={async (e) => {
                                    const f = e.target.files?.[0];
                                    if (!f) return;
                                    setUploadingId(`${t.id}-${c.date}`);
                                    try {
                                      const fd = new FormData(); fd.append('file', f);
                                      const up = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
                                      await api.post(`/hr/checklists/${t.id}/complete`, {
                                        proof_url: up.data.url,
                                        completion_date: c.date,
                                      });
                                      toast.success(`Proof uploaded for ${dateLabel}`);
                                      loadFollowup();
                                    } catch (err) { toast.error(err.response?.data?.error || 'Upload failed'); }
                                    setUploadingId(null);
                                    e.target.value = '';
                                  }} />
                                </label>
                              )}
                              {!canUpload && !c.proof_url && <span className="text-gray-300 text-[10px]">—</span>}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {instances.length === 0 && (
                      <tr><td colSpan="8" className="text-center py-8 text-gray-400">No instances in the selected window.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            );
          })()}

          {/* ─── TIMELINE GRID view (toggle) ──────────────────────── */}
          {followup && followupSubView === 'timeline' && followup.rows.length > 0 && (
            <div className="card p-0 overflow-x-auto">
              <table className="text-xs border-collapse">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="text-left px-2 py-2 sticky left-0 bg-gray-50 z-10 min-w-[200px]">Task</th>
                    <th className="text-left px-2 py-2 sticky left-[200px] bg-gray-50 z-10">Person</th>
                    <th className="text-left px-2 py-2">Dept</th>
                    {followup.dates.map((d, i) => {
                      const dt = new Date(d);
                      const isToday = i === followup.today_index;
                      return (
                        <th key={d} className={`px-1 py-1 text-center text-[9px] uppercase ${isToday ? 'bg-blue-100 text-blue-700 font-bold' : 'text-gray-500'}`} style={{ width: 32 }}>
                          <div>{dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</div>
                          <div className="font-normal opacity-60">{dt.toLocaleDateString('en-IN', { weekday: 'short' })}</div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {followup.rows.map(r => (
                    <tr key={r.id} className="border-t hover:bg-blue-50/30">
                      <td className="px-2 py-1.5 sticky left-0 bg-white z-10 min-w-[200px]">
                        <div className="font-medium text-gray-800 text-[12px] line-clamp-2" title={r.description}>{r.description}</div>
                        <div className="text-[9px] text-gray-500 capitalize">{r.frequency}</div>
                      </td>
                      <td className="px-2 py-1.5 sticky left-[200px] bg-white z-10 text-[11px]">{r.assigned_to_name || '—'}</td>
                      <td className="px-2 py-1.5">
                        {r.department ? <span className="text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">{r.department}</span> : <span className="text-gray-300 text-[10px]">—</span>}
                      </td>
                      {r.cells.map(c => (
                        <td key={c.date} className="px-0.5 py-1 text-center" style={{ width: 32 }}>
                          {c.proof_url
                            ? <a href={c.proof_url} target="_blank" rel="noreferrer" title={`${c.date} · ${c.status}\nClick to view proof`}><Cell s={c.status} /></a>
                            : <span title={`${c.date} · ${c.status}`}><Cell s={c.status} /></span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {view === 'current' && groupOrder.length === 0 && (
        <div className="card text-center py-8 text-gray-400">No checklists yet</div>
      )}
      {view === 'current' && groupOrder.map(personName => (
        <div key={personName} className="card p-0 overflow-x-auto">
          <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
            <h4 className="font-bold text-gray-700 text-sm flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-100 text-red-700 text-[10px] font-extrabold">{personName.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase()}</span>
              {personName}
              <span className="text-xs font-normal text-gray-400">({byPerson[personName].length})</span>
            </h4>
          </div>
          <table className="freeze-head">
            <thead><tr><th>Task</th><th>Department</th><th>Frequency</th><th>Due Date / Time</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {byPerson[personName].map(c => (
                <tr key={c.id}>
                  <td className="font-medium max-w-md"><div className="line-clamp-2">{c.description || c.title}</div></td>
                  <td className="text-[11px]">
                    {c.department
                      ? <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">{c.department}</span>
                      : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="capitalize">{c.frequency}</td>
                  <td>
                    {c.frequency === 'daily'
                      ? (c.due_time ? <span className="font-mono">{c.due_time}</span> : <span className="text-gray-400">anytime</span>)
                      : <span>{c.due_date || '—'}{c.due_time ? ` · ${c.due_time}` : ''}</span>}
                  </td>
                  <td><StatusBadge status={c.status} /></td>
                  <td><div className="flex gap-1 flex-wrap items-center">
                    {/* Inline mark-done for the assignee.  Action varies
                        by proof_type (mam 2026-05-22):
                          photo / pdf / file → file picker (accept= varies)
                          text               → opens text modal
                          none               → one-click done */}
                    {c.assigned_to === user?.id && (
                      todayDone[c.id] ? (
                        <span className="text-[10px] text-emerald-700 flex items-center gap-1 bg-emerald-50 px-2 py-1 rounded">
                          ✓ Done today {todayDone[c.id].proof_url && <a href={todayDone[c.id].proof_url} target="_blank" rel="noreferrer" className="text-emerald-800 hover:underline flex items-center gap-0.5"><FiExternalLink size={10} /> proof</a>}
                        </span>
                      ) : (() => {
                        const pt = c.proof_type || 'photo';
                        // Mam (2026-05-22): proof_label overrides the
                        // generic "Photo / PDF / Proof" wording so the
                        // button reads e.g. "Upload GST File".
                        const friendly = c.proof_label && c.proof_label.trim() ? c.proof_label.trim() : null;
                        if (pt === 'text') {
                          return (
                            <button onClick={() => { setTextProofRow(c); setTextProofDraft(''); }}
                              className="btn btn-success text-[11px] px-2 py-1 flex items-center gap-1">
                              ✍️ {friendly ? `Add ${friendly}` : 'Mark Done (text)'}
                            </button>
                          );
                        }
                        if (pt === 'none') {
                          return (
                            <button onClick={() => uploadProof(c, null)}
                              className="btn btn-success text-[11px] px-2 py-1 flex items-center gap-1">
                              ✓ Mark Done
                            </button>
                          );
                        }
                        const accept = pt === 'photo' ? 'image/*'
                                     : pt === 'pdf'   ? '.pdf,application/pdf'
                                     :                  '.pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx';
                        const genericLabel = pt === 'photo' ? 'Photo'
                                           : pt === 'pdf'   ? 'PDF'
                                           :                  'Proof';
                        const label = `Upload ${friendly || genericLabel}`;
                        return (
                          <label className={`btn btn-success text-[11px] px-2 py-1 flex items-center gap-1 cursor-pointer ${uploadingId === c.id ? 'opacity-60 pointer-events-none' : ''}`} title={friendly ? `Required: ${friendly}` : undefined}>
                            <FiUpload size={11} /> {uploadingId === c.id ? '...' : label}
                            <input type="file" accept={accept} className="hidden"
                              onChange={e => { const f = e.target.files[0]; if (f) uploadProof(c, f); e.target.value = ''; }} />
                          </label>
                        );
                      })()
                    )}
                    {canManage() && <button onClick={() => { setEditing(c); setForm(c); setModal(true); }} className="p-1.5 hover:bg-red-50 rounded text-red-600"><FiEdit2 size={15} /></button>}
                    {canManage() && canDelete('checklists') && <button onClick={async () => {
                      if (!confirm(`Delete this checklist?`)) return;
                      try { await api.delete(`/hr/checklists/${c.id}`); toast.success('Deleted'); load(); }
                      catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                    }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <Modal isOpen={modal} onClose={() => setModal(false)} title={editing ? 'Edit Checklist' : 'Add Checklist'}>
        <form onSubmit={save} className="space-y-4">
          <div><label className="label">Task Description *</label><textarea className="input" rows="3" required value={form.description || ''} onChange={e => setForm({...form, description: e.target.value})} placeholder="What needs to be done…" /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className="label">Frequency</label><select className="select" value={form.frequency || 'monthly'} onChange={e => setForm({...form, frequency: e.target.value})}>{['daily','weekly','fortnightly','monthly','quarterly','yearly','once'].map(f => <option key={f} value={f}>{f}</option>)}</select></div>
            {/* For 'once' tasks we keep the Due Date. For recurring (daily/weekly/…),
                we show Time of Day instead since the date is derived from the frequency. */}
            {form.frequency === 'daily' ? (
              <div><label className="label">Time of Day</label><TimePicker value={form.due_time || ''} onChange={v => setForm({...form, due_time: v})} /><p className="text-[10px] text-gray-400 mt-0.5">When should this task be done each day?</p></div>
            ) : (
              <div><label className="label">Due Date</label><input className="input" type="date" value={form.due_date || ''} onChange={e => setForm({...form, due_date: e.target.value})} /></div>
            )}
            {form.frequency !== 'daily' && (
              <div><label className="label">Time of Day <span className="text-gray-400 font-normal">(optional)</span></label><TimePicker value={form.due_time || ''} onChange={v => setForm({...form, due_time: v})} /></div>
            )}
            {/* Mam (2026-05-22): fortnightly = twice a month on two
                specific day-of-month slots ("5 & 20" / "2 & 16").
                Defaults to "1,15" if blank. */}
            {form.frequency === 'fortnightly' && (
              <div className="sm:col-span-2">
                <label className="label">Fortnight Days <span className="text-gray-400 font-normal text-[10px]">(two day-of-month numbers, ≈15 days apart)</span></label>
                <input
                  className="input"
                  placeholder="e.g. 5,20  or  1,15"
                  value={form.fortnight_days || ''}
                  onChange={e => setForm({ ...form, fortnight_days: e.target.value })}
                />
                <p className="text-[10px] text-gray-500 mt-0.5">
                  Instance generates twice a month on these two dates. Leave blank for default <code>1, 15</code>.
                </p>
              </div>
            )}
            <div>
              <label className="label">Assigned To *</label>
              <SearchableSelect
                options={users.map(u => ({ ...u, label: u.name + (u.username ? ' (@' + u.username + ')' : '') + (u.department ? ' · ' + u.department : '') }))}
                value={form.assigned_to || null}
                valueKey="id" displayKey="label"
                placeholder="Search user by name…"
                onChange={(u) => {
                  // Mam (2026-05-22): auto-fill department from the
                  // assignee's user record so admin doesn't have to
                  // re-type it.  Override is still allowed below.
                  setForm({
                    ...form,
                    assigned_to: u?.id || '',
                    department: form.department || u?.department || '',
                  });
                }}
              />
            </div>
            {/* Department — sourced from distinct users.department values
                in the loaded user list, with a datalist so admin can
                type a new one if needed.  Auto-populated above when an
                assignee is picked. */}
            <div>
              <label className="label">Department <span className="text-gray-400 font-normal text-[10px]">(auto-fills from assignee)</span></label>
              <select
                className="select"
                value={form.department || ''}
                onChange={e => setForm({ ...form, department: e.target.value })}
              >
                <option value="">— Pick department —</option>
                {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                {/* Preserve any legacy value not in the fixed list so
                    older rows still display + can be re-saved without
                    losing data.  Marked (legacy) so admin sees the
                    intent. */}
                {form.department && !DEPARTMENTS.includes(form.department) && (
                  <option value={form.department}>{form.department} (legacy)</option>
                )}
              </select>
            </div>
            {/* Mam (2026-05-22): "i want to tell which type proof
                need for complete or text" — admin tells the system
                what the assignee must attach when marking done. */}
            <div>
              <label className="label">Proof Type *</label>
              <select className="select" value={form.proof_type || 'photo'} onChange={e => setForm({ ...form, proof_type: e.target.value })}>
                <option value="photo">📷 Photo (JPG/PNG only)</option>
                <option value="pdf">📄 PDF only</option>
                <option value="file">📎 Any file (photo / PDF / doc)</option>
                <option value="text">✍️ Text note (no file)</option>
                <option value="none">✓ Just mark done (no proof)</option>
              </select>
              <p className="text-[10px] text-gray-400 mt-0.5">
                {form.proof_type === 'text'  && 'Assignee will type a note — no file upload.'}
                {form.proof_type === 'photo' && 'Assignee must upload a photo of the work / receipt / etc.'}
                {form.proof_type === 'pdf'   && 'Assignee must upload a PDF (e.g. signed report).'}
                {form.proof_type === 'file'  && 'Assignee can upload any kind of file.'}
                {form.proof_type === 'none'  && 'One-click done — no attachment needed.'}
                {!form.proof_type && 'Defaults to photo if not set.'}
              </p>
            </div>
            {/* Mam (2026-05-22): "add one proof name like type gst
                file etc" — friendly label shown on the assignee's
                upload button so they know exactly what to attach. */}
            {form.proof_type !== 'none' && (
              <div>
                <label className="label">
                  Proof Name <span className="text-gray-400 font-normal text-[10px]">(what to attach — e.g. "GST File")</span>
                </label>
                <input
                  className="input"
                  list="checklist-proof-name-options"
                  value={form.proof_label || ''}
                  onChange={e => setForm({ ...form, proof_label: e.target.value })}
                  placeholder={form.proof_type === 'text' ? 'e.g. Daily Cash Note' : 'e.g. GST File, Bank Statement, Site Photo'}
                />
                <datalist id="checklist-proof-name-options">
                  <option value="GST File"/>
                  <option value="Bank Statement"/>
                  <option value="Salary Slip"/>
                  <option value="Site Photo"/>
                  <option value="Vendor Invoice"/>
                  <option value="Cash Closing Note"/>
                  <option value="Cheque Image"/>
                  <option value="Petty Cash Voucher"/>
                  <option value="Stock Register Page"/>
                  <option value="Attendance Sheet"/>
                </datalist>
                <p className="text-[10px] text-gray-400 mt-0.5">
                  Upload button will say <span className="font-semibold text-gray-600">"Upload {form.proof_label || (form.proof_type === 'photo' ? 'Photo' : form.proof_type === 'pdf' ? 'PDF' : 'Proof')}"</span>
                </p>
              </div>
            )}
            {editing && <div><label className="label">Status</label><select className="select" value={form.status || ''} onChange={e => setForm({...form, status: e.target.value})}>{['pending','in_progress','completed','overdue'].map(s => <option key={s} value={s}>{s.replace(/_/g,' ')}</option>)}</select></div>}
          </div>

          {/* Recurrence window — mam (2026-05-22): "ask start date and
              end date according to date create checklist task daily
              wise".  Shown only for recurring frequencies (skipped on
              'once' since that's a single-date task and due_date
              already covers it).  Empty bounds = open-ended. */}
          {form.frequency !== 'once' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-blue-50/40 border border-blue-200 rounded-lg p-3">
              <div>
                <label className="label">Start Date *</label>
                <input
                  type="date"
                  className="input"
                  value={form.recurrence_start_date || ''}
                  onChange={e => setForm({ ...form, recurrence_start_date: e.target.value })}
                />
                <p className="text-[10px] text-gray-500 mt-0.5">First date this task should appear</p>
              </div>
              <div>
                <label className="label">End Date *</label>
                <input
                  type="date"
                  className="input"
                  value={form.recurrence_end_date || ''}
                  onChange={e => setForm({ ...form, recurrence_end_date: e.target.value })}
                />
                <p className="text-[10px] text-gray-500 mt-0.5">Last date — task stops generating after this</p>
              </div>
              <div className="sm:col-span-2 text-[11px] text-blue-800 bg-blue-100/70 rounded px-2 py-1">
                {form.frequency === 'daily'    && 'Instance created every day between Start and End.'}
                {form.frequency === 'weekly'   && 'Instance created on the same weekday between Start and End.'}
                {form.frequency === 'fortnightly' && (() => {
                  const days = (form.fortnight_days || '1,15').split(/[,;|&]/).map(s => s.trim()).filter(Boolean).join(' & ');
                  return `Instance created twice a month on day ${days} between Start and End.`;
                })()}
                {/* Mam (2026-05-22): use due_date as anchor.  Blurb
                    spells out the day so admin can verify before save. */}
                {form.frequency === 'monthly' && (() => {
                  if (!form.due_date) return '⚠ Pick a Due Date — it sets the day-of-month the task repeats on.';
                  const d = new Date(form.due_date + 'T00:00:00').getDate();
                  return `Instance created on day ${d} of every month between Start and End.`;
                })()}
                {form.frequency === 'quarterly' && (() => {
                  if (!form.due_date) return '⚠ Pick a Due Date — sets the day-of-month + which month of the quarter.';
                  const dt = new Date(form.due_date + 'T00:00:00');
                  return `Instance created on day ${dt.getDate()} every 3rd month (starting ${dt.toLocaleString('en-IN', { month: 'long' })}) between Start and End.`;
                })()}
                {form.frequency === 'yearly' && (() => {
                  if (!form.due_date) return '⚠ Pick a Due Date — sets the month + day the task repeats each year.';
                  const dt = new Date(form.due_date + 'T00:00:00');
                  return `Instance created on ${dt.toLocaleString('en-IN', { day: '2-digit', month: 'long' })} every year between Start and End.`;
                })()}
              </div>
            </div>
          )}
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'}</button></div>
        </form>
      </Modal>

      {/* ── BULK ADD MODAL (mam 2026-05-22) ──
          Paste many task lines that share the same frequency /
          assignee / dates / proof type.  One line = one task. */}
      <Modal isOpen={bulkModal} onClose={() => setBulkModal(false)} title="Bulk Add Checklists" wide>
        <div className="space-y-3">
          <div className="text-[11px] text-blue-700 bg-blue-50 border border-blue-100 rounded px-3 py-2 space-y-1">
            <div><b>One task per line.</b> Empty lines and duplicates are skipped.</div>
            <div className="text-blue-900">
              💡 <b>Different proof name / time per task?</b> Add columns after each task with <code className="bg-white px-1 rounded">|</code>:
              <pre className="font-mono text-[11px] mt-1 ml-4">{`File GST return       | GST File         | pdf   | 11:00
Bank recon            | Bank Statement                | 10:30
Stock recon           | Stock Photo      | photo | 09:00,13:00,17:00
Send WhatsApp report                                  ← uses shared settings below`}</pre>
              Columns (any subset, in order):
              <code className="bg-white px-1 rounded mx-1">Task</code> |
              <code className="bg-white px-1 rounded mx-1">Proof Name</code> |
              <code className="bg-white px-1 rounded mx-1">Type</code> |
              <code className="bg-white px-1 rounded mx-1">Time (HH:MM)</code>
              <br/>You can also paste 4 columns from Excel (tab-separated works the same way).<br/>
              <b>⏰ Multiple times per task:</b> separate with commas — <code className="bg-white px-1 rounded">09:00,13:00,17:00</code> creates 3 rows (one per slot) for tasks that fire at fixed times of day.
            </div>
          </div>
          {/* Mam (2026-05-22): Excel upload — server parses the
              .xlsx and pastes the rows into the textarea below so
              admin can review/edit before submitting. */}
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-center gap-2 flex-wrap">
            <div className="flex-1 min-w-[180px] text-[11px] text-emerald-800">
              <b>Have an Excel sheet?</b> Upload it — columns: <b>Description · Proof Name · Proof Type · Time</b>.
            </div>
            <button
              type="button"
              onClick={downloadTemplate}
              disabled={templateDownloading}
              className="btn btn-secondary text-[11px] py-1 px-2 flex items-center gap-1 whitespace-nowrap disabled:opacity-60">
              {templateDownloading ? '⏳ Preparing…' : '⬇ Download Template'}
            </button>
            <label className={`btn btn-primary text-[11px] py-1 px-2 flex items-center gap-1 cursor-pointer whitespace-nowrap ${excelImporting ? 'opacity-60 pointer-events-none' : ''}`}>
              {excelImporting ? '⏳ Parsing…' : '📊 Upload Excel'}
              <input type="file" accept=".xlsx,.xls,.csv" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) importExcel(f); e.target.value = ''; }}/>
            </label>
          </div>

          <div>
            <label className="label">Task Lines * <span className="text-gray-400 font-normal text-[10px]">(one per line · optional `| Proof Name | Type | Time` after each)</span></label>
            <textarea
              className="input font-mono text-[12px]"
              rows="8"
              value={bulkForm.lines || ''}
              onChange={e => setBulkForm({ ...bulkForm, lines: e.target.value })}
              placeholder={`Attendance + no-show alerts | Attendance Report | photo | 10:30\nExit checklist + Day-1 joiner verification | Joining Form | pdf | 17:00\nDaily WhatsApp report                                        | 18:00\n...`}
            />
            {/* Live preview of how the lines will be split */}
            {(() => {
              const lines = String(bulkForm.lines || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
              if (lines.length === 0) return <p className="text-[10px] text-gray-500 mt-0.5">0 task(s) ready to create</p>;
              const parsed = lines.map(l => {
                const parts = l.split(/\s*[|\t]\s*/);
                return { desc: parts[0], label: parts[1] || null, type: parts[2] || null, time: parts[3] || null };
              });
              const withCustomLabel = parsed.filter(p => p.label).length;
              const withCustomTime  = parsed.filter(p => p.time).length;
              return (
                <div className="text-[10px] mt-1 space-y-0.5">
                  <p className="text-gray-500">
                    {parsed.length} task(s) ready · {withCustomLabel} with custom proof name · {withCustomTime} with custom time
                  </p>
                  <details className="text-gray-500">
                    <summary className="cursor-pointer hover:text-gray-700">Show parsed preview</summary>
                    <table className="mt-1 text-[10px] w-full border border-gray-200 rounded">
                      <thead className="bg-gray-50"><tr><th className="text-left px-2 py-1">Task</th><th className="text-left px-2 py-1">Proof Name</th><th className="text-left px-2 py-1">Type</th><th className="text-left px-2 py-1">Time</th></tr></thead>
                      <tbody>
                        {parsed.map((p, i) => (
                          <tr key={i} className="border-t">
                            <td className="px-2 py-0.5 truncate max-w-[260px]" title={p.desc}>{p.desc}</td>
                            <td className="px-2 py-0.5">{p.label || <span className="text-gray-400 italic">{bulkForm.proof_label || '—'}</span>}</td>
                            <td className="px-2 py-0.5">{p.type || <span className="text-gray-400 italic">{bulkForm.proof_type || 'photo'}</span>}</td>
                            <td className="px-2 py-0.5 font-mono">{p.time || <span className="text-gray-400 italic">{bulkForm.due_time || '—'}</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                </div>
              );
            })()}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Frequency</label>
              <select className="select" value={bulkForm.frequency || 'monthly'} onChange={e => setBulkForm({ ...bulkForm, frequency: e.target.value })}>
                {['daily','weekly','fortnightly','monthly','quarterly','yearly','once'].map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Time of Day <span className="text-gray-400 font-normal text-[10px]">(optional)</span></label>
              <TimePicker value={bulkForm.due_time || ''} onChange={v => setBulkForm({ ...bulkForm, due_time: v })}/>
            </div>
            {/* Mam (2026-05-22): "if here is month then you dont think
                selection of month if quartly" — anchor date drives:
                  monthly   → repeats on same day-of-month
                  quarterly → repeats every 3rd month on same day
                  yearly    → repeats same month + day each year
                  once      → fires only on this date
                Bulk modal didn't have this field at all; adding it now
                so admin doesn't end up with monthly tasks firing every
                day. */}
            {['monthly','quarterly','yearly','once'].includes(bulkForm.frequency) && (
              <div className="sm:col-span-2">
                <label className="label">
                  {bulkForm.frequency === 'once'      && 'Due Date *'}
                  {bulkForm.frequency === 'monthly'   && 'Anchor Date'}
                  {bulkForm.frequency === 'quarterly' && 'Anchor Date'}
                  {bulkForm.frequency === 'yearly'    && 'Anchor Date'}
                  <span className="text-gray-400 font-normal text-[10px] ml-1">
                    {bulkForm.frequency === 'monthly'   && '(repeats on this DAY-OF-MONTH every month)'}
                    {bulkForm.frequency === 'quarterly' && '(repeats every 3rd month on this DAY)'}
                    {bulkForm.frequency === 'yearly'    && '(repeats this MONTH + DAY each year)'}
                    {bulkForm.frequency === 'once'      && '(one-time)'}
                  </span>
                </label>
                <input type="date" className="input" value={bulkForm.due_date || ''} onChange={e => setBulkForm({ ...bulkForm, due_date: e.target.value })}/>
                {bulkForm.frequency !== 'once' && !bulkForm.due_date && (
                  <p className="text-[10px] text-amber-700 mt-0.5">
                    ⚠ Without an anchor date, this task will appear on EVERY day in the Follow-up grid.  Pick a date so the system knows when it actually fires.
                  </p>
                )}
              </div>
            )}
            {/* Mam (2026-05-22): fortnight-days picker — applies to
                every task in this bulk batch when frequency is
                fortnightly.  Defaults to "1,15" if blank. */}
            {bulkForm.frequency === 'fortnightly' && (
              <div className="sm:col-span-2">
                <label className="label">Fortnight Days <span className="text-gray-400 font-normal text-[10px]">(two day-of-month numbers, ≈15 days apart)</span></label>
                <input
                  className="input"
                  placeholder="e.g. 5,20  or  1,15"
                  value={bulkForm.fortnight_days || ''}
                  onChange={e => setBulkForm({ ...bulkForm, fortnight_days: e.target.value })}
                />
                <p className="text-[10px] text-gray-500 mt-0.5">All tasks in this batch will fire on these two days each month.  Leave blank for default <code>1, 15</code>.</p>
              </div>
            )}
            <div className="sm:col-span-2">
              {/* Mam (2026-05-22): "multiple name mean assign one or
                  multiple user one time" — picker now multi-select.
                  Each picked user becomes a chip; every task line is
                  created for EACH picked user.  So 3 tasks × 2 users
                  = 6 checklist rows in one submit. */}
              <label className="label">Assigned To * <span className="text-gray-400 font-normal text-[10px]">(pick one or many — each task is created for every selected user)</span></label>
              <SearchableSelect
                options={users
                  .filter(u => !(bulkForm.assigned_to_ids || []).includes(u.id))
                  .map(u => ({ ...u, label: u.name + (u.username ? ' (@' + u.username + ')' : '') + (u.department ? ' · ' + u.department : '') }))}
                value={null}
                valueKey="id" displayKey="label"
                placeholder="Search user by name…"
                onChange={(u) => {
                  if (!u?.id) return;
                  const next = [...(bulkForm.assigned_to_ids || []), u.id];
                  setBulkForm({
                    ...bulkForm,
                    assigned_to_ids: next,
                    assigned_to: next[0],   // kept for back-compat on submit
                    department: bulkForm.department || u.department || '',
                  });
                }}
              />
              {(bulkForm.assigned_to_ids || []).length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {(bulkForm.assigned_to_ids || []).map(uid => {
                    const u = users.find(x => x.id === uid);
                    if (!u) return null;
                    return (
                      <span key={uid} className="inline-flex items-center gap-1 text-[11px] bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full border border-blue-200">
                        {u.name}{u.department ? ` · ${u.department}` : ''}
                        <button
                          type="button"
                          onClick={() => {
                            const next = (bulkForm.assigned_to_ids || []).filter(x => x !== uid);
                            setBulkForm({ ...bulkForm, assigned_to_ids: next, assigned_to: next[0] || '' });
                          }}
                          className="ml-0.5 text-blue-600 hover:text-blue-900"
                          aria-label="Remove"
                        >×</button>
                      </span>
                    );
                  })}
                  <span className="text-[10px] text-gray-500 self-center">
                    → will create <b>{(String(bulkForm.lines || '').split(/\r?\n/).filter(l => l.trim()).length) * (bulkForm.assigned_to_ids || []).length}</b> checklist(s) total
                  </span>
                </div>
              )}
            </div>
            <div>
              <label className="label">Department</label>
              <select className="select" value={bulkForm.department || ''} onChange={e => setBulkForm({ ...bulkForm, department: e.target.value })}>
                <option value="">— Pick (or auto-fill from assignee) —</option>
                {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                {bulkForm.department && !DEPARTMENTS.includes(bulkForm.department) && (
                  <option value={bulkForm.department}>{bulkForm.department} (legacy)</option>
                )}
              </select>
            </div>
            <div>
              <label className="label">Proof Type *</label>
              <select className="select" value={bulkForm.proof_type || 'photo'} onChange={e => setBulkForm({ ...bulkForm, proof_type: e.target.value })}>
                <option value="photo">📷 Photo</option>
                <option value="pdf">📄 PDF</option>
                <option value="file">📎 Any file</option>
                <option value="text">✍️ Text note</option>
                <option value="none">✓ Just mark done</option>
              </select>
            </div>
            {bulkForm.proof_type !== 'none' && (
              <div className="sm:col-span-2">
                <label className="label">Proof Name <span className="text-gray-400 font-normal text-[10px]">(shown on upload button — same for all tasks)</span></label>
                <input className="input" list="checklist-proof-name-options"
                  value={bulkForm.proof_label || ''}
                  onChange={e => setBulkForm({ ...bulkForm, proof_label: e.target.value })}
                  placeholder="e.g. GST File, Bank Statement, Daily Cash Note"/>
                {/* Mam (2026-05-22): detect when admin types "|" in
                    the SHARED proof name (expecting it to split across
                    tasks).  Suggest the correct per-line syntax + offer
                    a one-click split that distributes the parts to the
                    task lines. */}
                {(() => {
                  const sharedHasPipe = /\|/.test(bulkForm.proof_label || '');
                  if (!sharedHasPipe) return null;
                  const parts = String(bulkForm.proof_label || '')
                    .split(/\s*\|+\s*/)
                    .map(s => s.replace(/^[:\-•·]\s*/, '').trim())
                    .filter(Boolean);
                  const taskLines = String(bulkForm.lines || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                  const canSplit = parts.length >= 2 && taskLines.length === parts.length;
                  const applySplit = () => {
                    // Rebuild each task line as "task | proofName" using
                    // the parsed parts; clear the shared field.
                    const newLines = taskLines.map((tl, i) => {
                      // Strip any existing trailing "| ..." so re-running
                      // doesn't accumulate pipes.
                      const baseTask = tl.split(/\s*\|/)[0].trim();
                      return `${baseTask} | ${parts[i]}`;
                    }).join('\n');
                    setBulkForm({ ...bulkForm, lines: newLines, proof_label: '' });
                    toast.success(`Split into ${parts.length} per-task proof names`);
                  };
                  return (
                    <div className="mt-1 text-[11px] bg-amber-50 border border-amber-200 rounded px-2 py-1.5 text-amber-900">
                      <b>This field is one literal name applied to every task.</b> Looks like you want different proof names per task.<br/>
                      → Put the proof name AFTER each task line using <code className="bg-white px-1 rounded">|</code>, like:<br/>
                      <code className="block bg-white px-2 py-1 mt-1 rounded text-[10.5px]">Attendance + no-show alerts | Attendance CSV<br/>Exit checklist + Day-1 joiner verification | Signed checklist PDF</code>
                      {canSplit && (
                        <div className="mt-1.5">
                          <button type="button" onClick={applySplit}
                            className="btn btn-secondary text-[10px] py-1 px-2 bg-amber-600 text-white border-amber-600 hover:bg-amber-700">
                            ✓ Auto-fix: split into {parts.length} per-task names
                          </button>
                        </div>
                      )}
                      {!canSplit && parts.length >= 2 && (
                        <div className="mt-1 text-[10px] text-amber-700">
                          Detected {parts.length} parts but you have {taskLines.length} task line(s) — auto-split needs one part per task.  Either edit the names to match the task count, or fix this manually.
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
          {bulkForm.frequency !== 'once' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-blue-50/40 border border-blue-200 rounded-lg p-3">
              <div>
                <label className="label">Start Date *</label>
                <input type="date" className="input" value={bulkForm.recurrence_start_date || ''} onChange={e => setBulkForm({ ...bulkForm, recurrence_start_date: e.target.value })}/>
              </div>
              <div>
                <label className="label">End Date *</label>
                <input type="date" className="input" value={bulkForm.recurrence_end_date || ''} onChange={e => setBulkForm({ ...bulkForm, recurrence_end_date: e.target.value })}/>
              </div>
            </div>
          )}
          <div className="flex justify-end gap-3 pt-1">
            <button onClick={() => setBulkModal(false)} className="btn btn-secondary">Cancel</button>
            <button onClick={submitBulk} className="btn btn-primary">
              Create {String(bulkForm.lines || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).length || ''} Checklist{String(bulkForm.lines || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).length === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      </Modal>

      {/* ── TEXT-PROOF MODAL (mam 2026-05-22) ──
          For checklists where proof_type='text' — assignee types a
          note instead of uploading a file. */}
      <Modal isOpen={!!textProofRow} onClose={() => setTextProofRow(null)} title={`${textProofRow?.proof_label ? `Add ${textProofRow.proof_label}` : 'Mark Done'} — ${textProofRow?.description?.slice(0, 60) || ''}`}>
        <div className="space-y-3">
          <p className="text-[11px] text-blue-700 bg-blue-50 border border-blue-100 rounded px-3 py-2">
            {textProofRow?.proof_label
              ? <>This checklist requires a text note labelled <b>{textProofRow.proof_label}</b>. Type the details below and submit.</>
              : 'This checklist requires a text note (no file upload). Type what you did, then submit.'}
          </p>
          <textarea
            className="input"
            rows="5"
            autoFocus
            value={textProofDraft}
            onChange={e => setTextProofDraft(e.target.value)}
            placeholder={textProofRow?.proof_label ? `Type the ${textProofRow.proof_label.toLowerCase()} details here…` : 'e.g. Bank balance ₹4.32L verified against statement, no discrepancies.'}
          />
          <div className="flex justify-end gap-3">
            <button onClick={() => setTextProofRow(null)} className="btn btn-secondary">Cancel</button>
            <button onClick={submitTextProof} className="btn btn-primary">Submit Note</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// Tiny coloured cell for the Follow-up timeline matrix.
// Status → background colour mapping kept in one place so the legend
// in the toolbar and the grid cells always match.
function Cell({ s }) {
  const map = {
    done_approved: 'bg-emerald-500',
    done_pending:  'bg-amber-400',
    done_rejected: 'bg-rose-500',
    missed:        'bg-red-200',
    today:         'bg-blue-200 ring-2 ring-blue-500',
    future:        'bg-gray-100',
    na:            'bg-white border border-dashed border-gray-200',
  };
  const cls = map[s] || 'bg-gray-100';
  return <span className={`inline-block w-4 h-4 rounded ${cls}`} />;
}
