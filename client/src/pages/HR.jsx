import { useState, useEffect } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import HiringRequestsTab from '../components/HiringRequestsTab';
import JobDescriptionsTab from '../components/JobDescriptionsTab';
import FinalRoundQuestionsTab from '../components/FinalRoundQuestionsTab';
import ScreeningQuestionsTab from '../components/ScreeningQuestionsTab';
import DashboardTab from '../components/DashboardTab';
import InductionTab from '../components/InductionTab';
import TrainingTab from '../components/TrainingTab';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import {
  FiPlus, FiEdit2, FiTrash2, FiCalendar, FiCheckCircle, FiUser, FiFileText,
  FiAward, FiDownload, FiClock, FiTag, FiPauseCircle, FiPlayCircle, FiBriefcase,
  FiAlertTriangle, FiClipboard, FiBarChart2, FiHelpCircle, FiUsers,
} from 'react-icons/fi';
// FiPlayCircle is already imported above for the Hold/Unhold button
// — reused here for the Training Library tab icon.
import { exportCsv } from '../utils/exportCsv';
import { fmtDateTime, fmtDate, fmtTime } from '../utils/datetime';

const candidateStatuses = ['lead','called','qualified','interview_scheduled','interview_done','offer_sent','accepted','onboarded','rejected'];
const sources = ['facebook','naukri','linkedin','reference','other'];

// ---------- Pipeline stage helper ----------
// Translate a candidate row into a clear "current stage" label + the next
// allowed action(s). mam's flow is:
//   1) Lead              → Schedule Interview
//   2) Interview Scheduled → Mark Interview Done (decision)
//   3) Qualified (shortlisted by interviewer) → Schedule MD Interview, then MD Decision
//   4) Offer Sent        → Mark Accepted / Onboarded
//   5) Onboarded / Rejected — final
function pipelineFor(c) {
  const s = c.status || 'lead';
  if (s === 'lead' || s === 'called') {
    return { label: 'New Lead', color: 'bg-gray-100 text-gray-700 border-gray-300', next: 'schedule_interview' };
  }
  if (s === 'interview_scheduled') {
    return { label: 'Interview Scheduled', color: 'bg-blue-100 text-blue-700 border-blue-300', next: 'interview_done' };
  }
  if (s === 'interview_done') {
    // On-hold or pending decision after first interview
    return { label: 'Interview Done · pending decision', color: 'bg-amber-100 text-amber-700 border-amber-300', next: 'interview_decision' };
  }
  if (s === 'qualified') {
    // Shortlisted by interviewer; decide if MD round is scheduled yet.
    if (c.md_interview_date && !c.md_decision) {
      return { label: 'MD Interview Scheduled', color: 'bg-purple-100 text-purple-700 border-purple-300', next: 'md_decision' };
    }
    return { label: 'Shortlisted · MD round pending', color: 'bg-emerald-50 text-emerald-700 border-emerald-300', next: 'schedule_md' };
  }
  if (s === 'offer_sent') {
    return { label: 'Offer Sent', color: 'bg-indigo-100 text-indigo-700 border-indigo-300', next: 'finalize' };
  }
  if (s === 'accepted') {
    return { label: 'Offer Accepted', color: 'bg-teal-100 text-teal-700 border-teal-300', next: 'finalize' };
  }
  if (s === 'onboarded') {
    return { label: 'Onboarded ✓', color: 'bg-green-100 text-green-800 border-green-400', next: null };
  }
  if (s === 'rejected') {
    return { label: 'Rejected', color: 'bg-red-100 text-red-700 border-red-300', next: null };
  }
  return { label: s, color: 'bg-gray-100 text-gray-700 border-gray-300', next: null };
}

export default function HR() {
  const { canDelete } = useAuth();
  // Mam (2026-05-22 ATS Phase 1 spec): top-level tab inside /hr.  No
  // separate sidebar entry — keeps the single "HR & Hiring" entry
  // point per the duplication rule.
  const [tab, setTab] = useUrlTab('candidates');         // 'candidates' | 'hiring-requests'
  const [candidates, setCandidates] = useState([]);
  const [contractors, setContractors] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [stageForm, setStageForm] = useState({});
  const [stageRow, setStageRow] = useState(null);
  const [uploading, setUploading] = useState(false);
  // Mam (2026-05-22): resume parsing auto-fills name/phone/email/
  // address on pick.  parsing flag drives the spinner; parsedHits
  // tells admin which fields the system populated vs left blank
  // so they know what still needs manual entry.
  const [parsingResume, setParsingResume] = useState(false);
  const [parsedHits, setParsedHits] = useState(null);
  // Mam (2026-05-22): pill-tabs for the 7-stage spec pipeline
  // (Applied / Screening / Interview / Final Round / Selected /
  // Rejected / On Hold).  Filter value drives the table filter.
  const [stageFilter, setStageFilter] = useState('all');
  // Mam (2026-05-22 ATS Phase 1):
  //   timelineRow → candidate whose activity log is open in a modal
  //   timelineEvents → fetched events for that candidate
  //   tagsRow / tagsDraft → which row's tags are being edited inline
  //   holdRow / holdDraft → on-hold toggle modal
  //   dupWarning → duplicate detection result when admin tries to save
  const [timelineRow, setTimelineRow] = useState(null);
  const [timelineEvents, setTimelineEvents] = useState([]);
  const [tagsRow, setTagsRow] = useState(null);
  const [tagsDraft, setTagsDraft] = useState('');
  const [holdRow, setHoldRow] = useState(null);
  const [holdDraft, setHoldDraft] = useState('');
  const [dupWarning, setDupWarning] = useState(null);   // { duplicates, payload } | null
  // Batch C: screening modal — applicable questions + admin's draft answers
  const [screeningRow, setScreeningRow] = useState(null);
  const [screeningQs, setScreeningQs] = useState([]);
  const [screeningAns, setScreeningAns] = useState({});  // { [question_id]: answer_text }
  const [screeningSubmitting, setScreeningSubmitting] = useState(false);
  // Batch D: pre-onboarding docs modal
  const [docsRow, setDocsRow] = useState(null);
  const [docsList, setDocsList] = useState([]);

  const load = () => {
    api.get('/hr/candidates').then(r => setCandidates(r.data));
    api.get('/hr/sub-contractors').then(r => setContractors(r.data));
    api.get('/hr/employees').then(r => setEmployees(r.data || [])).catch(() => setEmployees([]));
  };
  useEffect(() => { load(); }, []);

  // Generic file upload helper — reuses /upload, returns the served URL.
  const uploadFile = async (file) => {
    if (!file) return null;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      return r.data.url;
    } catch (err) {
      // Show the real reason — multer size limit, auth token expired, etc.
      const msg = err.response?.data?.error || err.message || 'Upload failed';
      toast.error(`Resume upload failed: ${msg}`, { duration: 6000 });
      console.error('uploadFile error', err);
      return null;
    } finally { setUploading(false); }
  };

  const saveCandidate = async (e, opts = {}) => {
    if (e?.preventDefault) e.preventDefault();
    // Upload the resume first (if attached) and stash the URL on the
    // candidate row so the same file flows naturally into Stage 2's
    // schedule-interview screen — no need to re-upload there.  If the
    // resume parser already uploaded it (form.resume_file is set),
    // skip the duplicate upload.
    let payload = { ...form };
    delete payload._file; // never POST the File object itself
    if (form._file && !form.resume_file) {
      const url = await uploadFile(form._file);
      if (!url) return; // uploadFile shows its own error toast
      payload.resume_file = url;
    }
    try {
      if (editing) {
        await api.put(`/hr/candidates/${editing.id}`, payload);
      } else {
        // Mam (2026-05-22 ATS Phase 1): duplicate detection.  Backend
        // returns 409 + { duplicates: [...] } when email/phone match
        // an existing candidate.  We catch that below and surface a
        // warning dialog instead of an error toast.  opts.force=true
        // skips the check (after admin confirms "Save Anyway").
        const url = opts.force ? '/hr/candidates?force=1' : '/hr/candidates';
        await api.post(url, payload);
      }
      toast.success(editing ? 'Updated' : 'Added candidate (Stage 1 — Applied)');
      setModal(false); setDupWarning(null); load();
    } catch (err) {
      if (err.response?.status === 409 && err.response?.data?.duplicates) {
        // Stash duplicates + the payload so "Save Anyway" can re-submit.
        setDupWarning({
          duplicates: err.response.data.duplicates,
          payload,
        });
        return;
      }
      const msg = err.response?.data?.error || err.message || 'Failed to save candidate';
      toast.error(msg, { duration: 6000 });
      console.error('saveCandidate error', err);
    }
  };

  // Mam (2026-05-22 ATS Phase 1): activity timeline modal — chronological
  // audit log per candidate (created / status changes / decisions /
  // tags / hold / offer generated).
  const openTimeline = async (row) => {
    setTimelineRow(row);
    setTimelineEvents([]);
    try {
      const r = await api.get(`/hr/candidates/${row.id}/timeline`);
      setTimelineEvents(r.data || []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not load timeline');
    }
  };

  const openTags = (row) => {
    setTagsRow(row);
    setTagsDraft(row.tags || '');
  };
  const saveTags = async () => {
    try {
      await api.put(`/hr/candidates/${tagsRow.id}/tags`, { tags: tagsDraft });
      toast.success('Tags updated');
      setTagsRow(null); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update tags');
    }
  };

  const openHold = (row) => {
    setHoldRow(row);
    setHoldDraft(row.hold_reason || '');
  };
  const toggleHold = async (turnOn) => {
    try {
      await api.post(`/hr/candidates/${holdRow.id}/hold`, {
        is_on_hold: turnOn,
        reason: turnOn ? holdDraft : null,
      });
      toast.success(turnOn ? 'Candidate put on hold' : 'Hold removed');
      setHoldRow(null); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to toggle hold');
    }
  };

  // ── Batch C: Screening flow (mam 2026-05-22) ────────────────────
  // Opens the modal pre-loaded with all applicable questions (the
  // candidate's hiring_request_id + globals).  Pre-fills with any
  // existing answers so re-screening shows what was previously asked.
  const openScreening = async (row) => {
    setScreeningRow(row);
    setScreeningQs([]);
    setScreeningAns({});
    try {
      const reqId = row.hiring_request_id || 'global';
      const [qs, prev] = await Promise.all([
        api.get(`/hr/screening-questions?hiring_request_id=${reqId}&active=1`),
        api.get(`/hr/candidates/${row.id}/screening-answers`).catch(() => ({ data: [] })),
      ]);
      setScreeningQs(qs.data || []);
      const draft = {};
      for (const a of (prev.data || [])) draft[a.question_id] = a.answer_text;
      setScreeningAns(draft);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load screening form');
    }
  };

  // ── Batch D: Pre-onboarding docs (mam 2026-05-22) ────────────────
  const openDocs = async (row) => {
    setDocsRow(row);
    setDocsList([]);
    try {
      const r = await api.get(`/hr/candidates/${row.id}/docs`);
      setDocsList(r.data || []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load documents');
    }
  };
  const refreshDocs = async () => {
    try {
      const r = await api.get(`/hr/candidates/${docsRow.id}/docs`);
      setDocsList(r.data || []);
    } catch (_) {}
  };
  const uploadDoc = async (doc, file) => {
    if (!file) return;
    const url = await uploadFile(file);
    if (!url) return;
    try {
      await api.put(`/hr/docs/${doc.id}`, { file_url: url, status: doc.status === 'pending' ? 'received' : doc.status });
      toast.success(`${doc.doc_label || doc.doc_type} uploaded`);
      refreshDocs();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Upload failed');
    }
  };
  const updateDocStatus = async (doc, status) => {
    try {
      await api.put(`/hr/docs/${doc.id}`, { status });
      toast.success(`Marked ${status}`);
      refreshDocs();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  };
  const addCustomDoc = async () => {
    const label = prompt('Custom document label (e.g. "Driving Licence")');
    if (!label) return;
    const type = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30) || 'other';
    try {
      await api.post(`/hr/candidates/${docsRow.id}/docs`, { doc_type: type, doc_label: label });
      refreshDocs();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const deleteDoc = async (doc) => {
    if (!confirm(`Remove "${doc.doc_label || doc.doc_type}" from the checklist?`)) return;
    try { await api.delete(`/hr/docs/${doc.id}`); refreshDocs(); }
    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
  };

  // Copy the candidate-facing offer accept link to clipboard.
  const copyOfferLink = (c) => {
    if (!c.offer_token) return toast.error('No offer link — re-save the MD Decision to generate one');
    const url = `${window.location.origin}/offer/${c.offer_token}`;
    navigator.clipboard.writeText(url).then(
      () => toast.success('Offer link copied — paste it into the candidate\'s email or WhatsApp'),
      () => toast.error('Clipboard blocked — copy manually: ' + url)
    );
  };

  const submitScreening = async () => {
    setScreeningSubmitting(true);
    try {
      const answers = Object.entries(screeningAns).map(([qid, txt]) => ({
        question_id: +qid,
        answer_text: txt,
      }));
      const r = await api.post(`/hr/candidates/${screeningRow.id}/screening-answers`, { answers });
      const verdict = r.data?.status;
      const reason = r.data?.reason;
      const msg = verdict === 'eligible' ? '✓ Candidate is eligible'
                : verdict === 'partial'  ? `⚠ Partial — ${reason}`
                :                          `✗ Auto-rejected — ${reason}`;
      if (verdict === 'rejected') toast.error(msg, { duration: 8000 });
      else if (verdict === 'partial') toast(msg, { icon: '⚠️', duration: 6000 });
      else toast.success(msg);
      setScreeningRow(null); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save screening');
    } finally {
      setScreeningSubmitting(false);
    }
  };

  const saveContractor = async (e) => {
    e.preventDefault();
    if (editing) { await api.put(`/hr/sub-contractors/${editing.id}`, form); }
    else { await api.post('/hr/sub-contractors', form); }
    toast.success(editing ? 'Updated' : 'Created');
    setModal(false); load();
  };

  // ---------- Pipeline action handlers ----------
  const openStage = (row, stage) => { setStageRow(row); setStageForm({}); setModal(stage); };

  const submitScheduleInterview = async (e) => {
    e.preventDefault();
    if (!stageForm.interviewer_id) return toast.error('Pick an interviewer');
    if (!stageForm.interview_date) return toast.error('Pick interview date & time');
    let resumeUrl = stageForm.resume_file || stageRow?.resume_file || null;
    if (stageForm._file) resumeUrl = await uploadFile(stageForm._file);
    if (!resumeUrl) return toast.error('Upload the candidate resume');
    await api.post(`/hr/candidates/${stageRow.id}/schedule-interview`, {
      interviewer_id: +stageForm.interviewer_id,
      interview_date: stageForm.interview_date,
      resume_file: resumeUrl,
      notes: stageForm.notes,
    });
    toast.success('Interview scheduled — Stage 2');
    setModal(false); load();
  };

  const submitInterviewDecision = async (e) => {
    e.preventDefault();
    if (!stageForm.decision) return toast.error('Pick a decision');
    // First the decision (always saved)
    await api.post(`/hr/candidates/${stageRow.id}/interview-done`, {
      decision: stageForm.decision,
      notes: stageForm.notes,
    });
    // Mam (2026-05-22 Batch B): if interviewer filled the scorecard
    // sliders, POST that as a separate row.  Scorecard is OPTIONAL —
    // skip the POST if no scores were entered (don't pollute the
    // table with empty rows).
    const hasAnyScore = ['technical','communication','culture','problem'].some(k => stageForm[`sc_${k}`]);
    if (hasAnyScore || stageForm.sc_overall) {
      try {
        await api.post(`/hr/candidates/${stageRow.id}/scorecard`, {
          interviewer_id:        stageRow?.interviewer_id || null,
          stage:                 'first',
          technical_score:       stageForm.sc_technical,
          communication_score:   stageForm.sc_communication,
          culture_fit_score:     stageForm.sc_culture,
          problem_solving_score: stageForm.sc_problem,
          overall_recommend:     stageForm.sc_overall,
          strengths:             stageForm.sc_strengths,
          weaknesses:            stageForm.sc_weaknesses,
          overall_feedback:      stageForm.notes,    // re-use the decision notes
        });
      } catch (err) {
        // Decision still saved — only warn for the scorecard step.
        console.warn('Scorecard save failed:', err);
        toast.error('Decision saved, but scorecard failed: ' + (err.response?.data?.error || err.message));
      }
    }
    const m = stageForm.decision === 'shortlisted' ? 'Shortlisted — schedule MD interview next'
            : stageForm.decision === 'rejected'    ? 'Marked rejected'
            : 'On hold — keep in pipeline';
    toast.success(m);
    setModal(false); load();
  };

  const submitScheduleMD = async (e) => {
    e.preventDefault();
    if (!stageForm.md_interview_date) return toast.error('Pick MD interview date & time');
    await api.post(`/hr/candidates/${stageRow.id}/schedule-md-interview`, {
      md_interview_date: stageForm.md_interview_date,
      notes: stageForm.notes,
    });
    toast.success('MD interview scheduled — Stage 4');
    setModal(false); load();
  };

  const submitMDDecision = async (e) => {
    e.preventDefault();
    if (!stageForm.decision) return toast.error('Pick a decision');
    if (stageForm.decision === 'shortlisted') {
      // Mam (2026-05-22): SEPL's offer letter is ALWAYS auto-generated
      // from these four fields using the standard SEPL template — no
      // upload-PDF path anymore.  Validation required for the generator.
      if (!stageForm.offered_position?.trim()) return toast.error('Enter the position being offered');
      if (!stageForm.offered_salary)           return toast.error('Enter the offered salary');
      if (!stageForm.joining_date)             return toast.error('Pick the joining date');
    }
    // Batch D: build the salary_breakup payload if admin filled the
    // customizer (lines is non-empty); otherwise null so server keeps
    // its current value / falls back to default.
    let salaryBreakup = null;
    const filledLines = (stageForm.breakup_lines || []).filter(r => r.name?.trim() || r.monthly || r.annual);
    if (filledLines.length > 0) {
      salaryBreakup = {
        lines: filledLines.map(r => ({ name: r.name?.trim() || '', monthly: r.monthly || '', annual: r.annual || '' })),
        total_monthly: stageForm.offered_salary ? +stageForm.offered_salary : null,
        total_annual:  stageForm.offered_salary ? +stageForm.offered_salary * 12 : null,
      };
    }
    await api.post(`/hr/candidates/${stageRow.id}/md-decision`, {
      decision: stageForm.decision,
      notes: stageForm.notes,
      offered_position: stageForm.offered_position,
      offered_salary:   stageForm.offered_salary,
      joining_date:     stageForm.joining_date,
      reporting_to:     stageForm.reporting_to,
      salary_breakup:   salaryBreakup,
    });
    if (stageForm.decision === 'shortlisted') {
      toast.success('Offer ready — opening letter for review');
      // Auto-open the generated offer letter in a new tab so admin can
      // Ctrl+P → Save as PDF or share the URL with the candidate.
      window.open(`/hr/candidates/${stageRow.id}/offer-letter`, '_blank');
    } else {
      toast.success('Rejected by MD');
    }
    setModal(false); load();
  };

  const submitFinalize = async (e) => {
    e.preventDefault();
    if (!stageForm.final_status) return toast.error('Pick final status');
    await api.post(`/hr/candidates/${stageRow.id}/finalize`, {
      final_status: stageForm.final_status,
      notes: stageForm.notes,
    });
    toast.success('Status updated');
    setModal(false); load();
  };

  const fmtDt = (s) => {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return fmtDate(s, { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' + fmtTime(s, { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="space-y-4">
      {/* Top-level tab switcher — Dashboard | Candidates | Hiring
          Requests | JDs | Screening Qs | Final-Round Qs.  Mam
          (2026-05-22 Phase 1 spec) wants all HR modules under the
          single /hr page (no separate sidebar entries). */}
      <div className="flex gap-2 border-b border-gray-200 overflow-x-auto">
        {[
          { id: 'dashboard',       label: 'Dashboard',          icon: FiBarChart2 },
          { id: 'manpower',        label: 'Manpower Plan',      icon: FiUsers },
          { id: 'candidates',      label: 'Candidates (ATS)',   icon: FiUser },
          { id: 'hiring-requests', label: 'Hiring Requests',    icon: FiBriefcase },
          { id: 'jds',             label: 'Job Descriptions',   icon: FiFileText },
          { id: 'screening',       label: 'Screening Qs',       icon: FiClipboard },
          { id: 'final-round',     label: 'Final-Round Qs',     icon: FiAward },
          { id: 'induction',       label: 'Induction Content',  icon: FiAward },
          { id: 'training',        label: 'Training Library',   icon: FiPlayCircle },
        ].map(t => {
          const active = tab === t.id;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px flex items-center gap-1.5 whitespace-nowrap
                ${active
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}
            >
              <Icon size={14}/>{t.label}
            </button>
          );
        })}
      </div>

      {tab === 'dashboard'       && <DashboardTab />}
      {tab === 'manpower'        && <ManpowerTab />}
      {tab === 'hiring-requests' && <HiringRequestsTab employees={employees} />}
      {tab === 'jds'             && <JobDescriptionsTab />}
      {tab === 'screening'       && <ScreeningQuestionsTab />}
      {tab === 'final-round'     && <FinalRoundQuestionsTab />}
      {tab === 'induction'       && <InductionTab />}
      {tab === 'training'        && <TrainingTab />}

      {tab === 'candidates' && (() => {
        // Mam (2026-05-22 ATS Phase 1 spec): 7-stage pipeline.
        //   Applied → Screening → Interview → Final Round → Selected
        //   + Rejected + On Hold (overlay)
        // bucketFor maps existing status + is_on_hold flag to a pill id.
        // On Hold takes precedence — a held candidate at any stage
        // shows only in the On Hold filter (avoid double-counting).
        const bucketFor = (c) => {
          if (c.is_on_hold) return 'on_hold';
          const s = c.status || 'lead';
          if (s === 'rejected') return 'rejected';
          if (s === 'lead' || s === 'called')        return 'applied';
          if (s === 'interview_scheduled')           return 'screening';
          if (s === 'interview_done')                return 'interview';
          if (s === 'qualified')                     return 'final_round';
          if (['offer_sent','accepted','onboarded'].includes(s)) return 'selected';
          return 'applied';
        };
        const STAGE_PILLS = [
          { id: 'applied',     label: '1 · APPLIED',     color: 'bg-blue-500' },
          { id: 'screening',   label: '2 · SCREENING',   color: 'bg-indigo-500' },
          { id: 'interview',   label: '3 · INTERVIEW',   color: 'bg-amber-500' },
          { id: 'final_round', label: '4 · FINAL ROUND', color: 'bg-purple-500' },
          { id: 'selected',    label: '5 · SELECTED',    color: 'bg-emerald-500' },
          { id: 'rejected',    label: 'REJECTED',         color: 'bg-rose-500' },
          { id: 'on_hold',     label: 'ON HOLD',          color: 'bg-gray-500' },
        ];
        const stageCounts = STAGE_PILLS.reduce((acc, s) => {
          acc[s.id] = candidates.filter(c => bucketFor(c) === s.id).length;
          return acc;
        }, {});
        const visibleCandidates = stageFilter === 'all'
          ? candidates
          : candidates.filter(c => bucketFor(c) === stageFilter);
        return (<>
          <div className="flex justify-between items-center flex-wrap gap-2">
            <div>
              <h3 className="font-semibold">Hiring Pipeline</h3>
              <p className="text-[11px] text-gray-500">5 stages: Lead → Schedule Interview → Interview Decision → MD Round → Offer & Onboarding</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => exportCsv('candidates',
                ['Name','Phone','Email','Position','Source','Stage','Notes'],
                candidates.map(c => [c.name, c.phone, c.email, c.position, c.source, c.current_stage, c.notes]))}
                className="btn btn-secondary flex items-center gap-2"><FiDownload /> Export Excel</button>
              <button onClick={() => { setEditing(null); setForm({ name: '', phone: '', email: '', source: 'naukri', position: '', notes: '', address: '' }); setParsedHits(null); setParsingResume(false); setModal('candidate'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Candidate</button>
            </div>
          </div>

          {/* Stage pill tabs — same Sales-Funnel / CRM-Kitting pattern
              with coloured count badges.  Click a pill to filter the
              table.  Mam (2026-05-22). */}
          <div className="flex gap-2 flex-wrap items-center">
            <button
              onClick={() => setStageFilter('all')}
              className={`btn ${stageFilter === 'all' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}
            >
              All
              <span className={`px-1.5 rounded-full text-[10px] font-bold min-w-[22px] text-center ${stageFilter === 'all' ? 'bg-white/30 text-white' : 'text-white bg-gray-500'}`}>
                {candidates.length}
              </span>
            </button>
            {STAGE_PILLS.map(s => {
              const active = stageFilter === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setStageFilter(s.id)}
                  className={`btn ${active ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}
                  title={s.label}
                >
                  {s.label}
                  <span className={`px-1.5 rounded-full text-[10px] font-bold min-w-[22px] text-center ${active ? 'bg-white/30 text-white' : `text-white ${s.color}`}`}>
                    {stageCounts[s.id] || 0}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="card p-0 overflow-x-auto">
            <table className="text-sm w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Candidate</th>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Position / Source</th>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Pipeline Stage</th>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Interview Details</th>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Files</th>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleCandidates.map(c => {
                  const p = pipelineFor(c);
                  return (
                    <tr key={c.id} className="border-t hover:bg-gray-50/60 align-top">
                      <td className="px-3 py-2">
                        <div className="font-medium text-gray-900 flex items-center gap-1.5 flex-wrap">
                          {c.name}
                          {c.is_on_hold && (
                            <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-gray-200 text-gray-700" title={c.hold_reason || 'On hold'}>
                              ⏸ HOLD
                            </span>
                          )}
                          {/* Batch C: eligibility badge stamped after screening */}
                          {c.eligibility_status === 'eligible' && (
                            <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-200" title="Passed screening">✓ ELIGIBLE</span>
                          )}
                          {c.eligibility_status === 'partial' && (
                            <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200" title={c.eligibility_reason || 'Mandatory questions unanswered'}>◐ PARTIAL</span>
                          )}
                          {c.eligibility_status === 'rejected' && (
                            <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 border border-rose-200" title={c.eligibility_reason || 'Auto-rejected by screening'}>✗ AUTO-REJECT</span>
                          )}
                        </div>
                        {c.phone && <div className="text-[11px] text-gray-500">📞 {c.phone}</div>}
                        {c.email && <div className="text-[11px] text-gray-500">✉️ {c.email}</div>}
                        {/* Tag chips (mam Phase 1 spec — free-form CSV) */}
                        {(c.tags && c.tags.trim()) ? (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {c.tags.split(',').map(t => t.trim()).filter(Boolean).map(t => (
                              <span key={t} className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">{t}</span>
                            ))}
                            <button onClick={() => openTags(c)} className="text-[9px] text-gray-400 hover:text-blue-600 underline">edit</button>
                          </div>
                        ) : (
                          <button onClick={() => openTags(c)} className="text-[10px] text-gray-400 hover:text-blue-600 mt-1 flex items-center gap-0.5">
                            <FiTag size={9}/> add tags
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-2 text-[12px]">
                        <div>{c.position || <span className="text-gray-300">—</span>}</div>
                        <div className="text-[10px] text-gray-400 capitalize">{c.source}</div>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`text-[11px] font-bold uppercase px-2 py-1 rounded border ${p.color}`}>{p.label}</span>
                      </td>
                      <td className="px-3 py-2 text-[11px] space-y-0.5">
                        {c.interviewer_name && <div><FiUser className="inline mr-1 text-gray-400" size={11}/>{c.interviewer_name}</div>}
                        {c.interview_date && <div><FiCalendar className="inline mr-1 text-gray-400" size={11}/>1st: {fmtDt(c.interview_date)}</div>}
                        {c.interview_decision && (
                          <div className={`inline-block text-[9px] uppercase font-bold px-1.5 py-0.5 rounded ${c.interview_decision === 'shortlisted' ? 'bg-emerald-100 text-emerald-700' : c.interview_decision === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>1st: {c.interview_decision}</div>
                        )}
                        {c.md_interview_date && <div><FiCalendar className="inline mr-1 text-purple-400" size={11}/>MD: {fmtDt(c.md_interview_date)}</div>}
                        {c.md_decision && (
                          <div className={`inline-block text-[9px] uppercase font-bold px-1.5 py-0.5 rounded ml-1 ${c.md_decision === 'shortlisted' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>MD: {c.md_decision}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-[11px] space-y-1">
                        {c.resume_file && <a href={c.resume_file} target="_blank" rel="noreferrer" className="block text-blue-600 hover:underline"><FiFileText className="inline mr-1" size={11}/>Resume</a>}
                        {c.offer_letter_file && <a href={c.offer_letter_file} target="_blank" rel="noreferrer" className="block text-emerald-600 hover:underline"><FiAward className="inline mr-1" size={11}/>Uploaded PDF</a>}
                        {/* Auto-generated offer letter — visible once the
                            candidate is in offer_sent / accepted / onboarded
                            state.  Opens in a new tab; mam can print or
                            save as PDF.  Mam (2026-05-22). */}
                        {['offer_sent','accepted','onboarded'].includes(c.status) && (
                          <>
                            <a href={`/hr/candidates/${c.id}/offer-letter`} target="_blank" rel="noreferrer" className="block text-blue-700 hover:underline"><FiAward className="inline mr-1" size={11}/>Offer Letter</a>
                            <a href={`/hr/candidates/${c.id}/nda`} target="_blank" rel="noreferrer" className="block text-purple-700 hover:underline"><FiFileText className="inline mr-1" size={11}/>NDA</a>
                            <a href={`/hr/candidates/${c.id}/employment-agreement`} target="_blank" rel="noreferrer" className="block text-indigo-700 hover:underline"><FiFileText className="inline mr-1" size={11}/>Agreement</a>
                            {/* Mam (2026-05-22 Batch D): public accept link */}
                            {c.offer_token && !c.offer_accepted_at && !c.offer_declined_at && (
                              <button
                                onClick={() => copyOfferLink(c)}
                                className="block text-emerald-700 hover:underline text-left"
                                title="Copy offer accept link to share with the candidate (no login needed for them)">
                                🔗 Copy Accept Link
                              </button>
                            )}
                            {c.offer_accepted_at && (
                              <div className="text-[10px] text-emerald-600 font-bold">✓ ACCEPTED via link</div>
                            )}
                            {c.offer_declined_at && (
                              <div className="text-[10px] text-rose-600 font-bold">✗ DECLINED via link</div>
                            )}
                          </>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {p.next === 'schedule_interview' && <button onClick={() => openStage(c, 'schedule_interview')} className="btn btn-primary text-[11px] py-1 px-2"><FiCalendar size={11} className="inline mr-1"/>Schedule Interview</button>}
                          {p.next === 'interview_done' && <button onClick={() => openStage(c, 'interview_decision')} className="btn btn-primary text-[11px] py-1 px-2"><FiCheckCircle size={11} className="inline mr-1"/>Mark Interview Done</button>}
                          {p.next === 'interview_decision' && <button onClick={() => openStage(c, 'interview_decision')} className="btn btn-primary text-[11px] py-1 px-2">Decision</button>}
                          {p.next === 'schedule_md' && <button onClick={() => openStage(c, 'schedule_md')} className="btn btn-primary text-[11px] py-1 px-2"><FiCalendar size={11} className="inline mr-1"/>Schedule MD Interview</button>}
                          {p.next === 'md_decision' && <button onClick={() => openStage(c, 'md_decision')} className="btn btn-primary text-[11px] py-1 px-2"><FiAward size={11} className="inline mr-1"/>MD Decision + Offer</button>}
                          {p.next === 'finalize' && <button onClick={() => openStage(c, 'finalize')} className="btn btn-primary text-[11px] py-1 px-2"><FiCheckCircle size={11} className="inline mr-1"/>Mark Onboarded</button>}
                          <button
                            onClick={() => openScreening(c)}
                            className={`p-1 ${
                              c.eligibility_status === 'eligible' ? 'text-emerald-600 hover:text-emerald-700'
                              : c.eligibility_status === 'partial' ? 'text-amber-600 hover:text-amber-700'
                              : c.eligibility_status === 'rejected' ? 'text-rose-600 hover:text-rose-700'
                              : 'text-gray-400 hover:text-blue-600'
                            }`}
                            title={c.eligibility_status ? `Re-screen (current: ${c.eligibility_status})` : 'Run screening'}>
                            <FiClipboard size={14} />
                          </button>
                          <button onClick={() => openDocs(c)} className="p-1 text-gray-400 hover:text-teal-600" title="Pre-Onboarding Docs"><FiDownload size={14} /></button>
                          <button onClick={() => openTimeline(c)} className="p-1 text-gray-400 hover:text-indigo-600" title="Activity timeline"><FiClock size={14} /></button>
                          <button
                            onClick={() => openHold(c)}
                            className={`p-1 ${c.is_on_hold ? 'text-amber-600 hover:text-amber-700' : 'text-gray-400 hover:text-amber-600'}`}
                            title={c.is_on_hold ? `On hold: ${c.hold_reason || ''}` : 'Put on hold'}>
                            {c.is_on_hold ? <FiPlayCircle size={14}/> : <FiPauseCircle size={14}/>}
                          </button>
                          <button onClick={() => { setEditing(c); setForm(c); setModal('candidate'); }} className="p-1 text-gray-400 hover:text-blue-600" title="Edit basic info"><FiEdit2 size={14} /></button>
                          {canDelete('hr') && <button onClick={async () => {
                            if (!confirm(`Delete candidate "${c.name}"?`)) return;
                            try { await api.delete(`/hr/candidates/${c.id}`); toast.success('Deleted'); load(); }
                            catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                          }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {visibleCandidates.length === 0 && (
                  <tr><td colSpan="6" className="text-center py-8 text-gray-400">
                    {candidates.length === 0
                      ? 'No candidates yet — click "Add Candidate" to start the pipeline'
                      : `No candidates in ${STAGE_PILLS.find(p => p.id === stageFilter)?.label || stageFilter}`}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>);
      })()}

      {tab === 'contractors' && (
        <>
          <div className="flex justify-between items-center">
            <h3 className="font-semibold">Sub-Contractors</h3>
            <button onClick={() => { setEditing(null); setForm({ name: '', phone: '', email: '', specialization: '', rate: 0, rate_unit: 'per_day', notes: '' }); setModal('contractor'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Contractor</button>
          </div>
          <div className="card p-0 overflow-x-auto"><table className="freeze-head">
            <thead><tr><th>Name</th><th>Phone</th><th>Specialization</th><th>Rate</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {contractors.map(c => (
                <tr key={c.id}>
                  <td className="font-medium">{c.name}</td><td>{c.phone}</td><td>{c.specialization}</td>
                  <td>Rs {c.rate}/{c.rate_unit?.replace(/_/g,' ')}</td><td><StatusBadge status={c.status} /></td>
                  <td><div className="flex gap-1">
                    <button onClick={() => { setEditing(c); setForm(c); setModal('contractor'); }} className="p-1.5 hover:bg-red-50 rounded text-red-600"><FiEdit2 size={15} /></button>
                    {canDelete('hr') && <button onClick={async () => {
                      if (!confirm(`Delete contractor "${c.name}"?`)) return;
                      try { await api.delete(`/hr/sub-contractors/${c.id}`); toast.success('Deleted'); load(); }
                      catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                    }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}
                  </div></td>
                </tr>
              ))}
              {contractors.length === 0 && <tr><td colSpan="6" className="text-center py-8 text-gray-400">No contractors yet</td></tr>}
            </tbody>
          </table></div>
        </>
      )}

      {/* ADD / EDIT CANDIDATE — basic info only. Stage actions live in their own modals. */}
      <Modal isOpen={modal === 'candidate'} onClose={() => setModal(false)} title={editing ? 'Edit Candidate' : 'Add Candidate'}>
        <form onSubmit={saveCandidate} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className="label">Name *</label><input className="input" value={form.name || ''} onChange={e => setForm({...form, name: e.target.value})} required /></div>
            <div><label className="label">Phone</label><input className="input" value={form.phone || ''} onChange={e => setForm({...form, phone: e.target.value})} /></div>
            <div><label className="label">Email</label><input className="input" value={form.email || ''} onChange={e => setForm({...form, email: e.target.value})} /></div>
            <div><label className="label">Position</label><input className="input" value={form.position || ''} onChange={e => setForm({...form, position: e.target.value})} /></div>
            <div><label className="label">Source</label><select className="select" value={form.source || ''} onChange={e => setForm({...form, source: e.target.value})}>{sources.map(s => <option key={s} value={s}>{s}</option>)}</select></div>
            {editing && <div><label className="label">Status</label><select className="select" value={form.status || ''} onChange={e => setForm({...form, status: e.target.value})}>{candidateStatuses.map(s => <option key={s} value={s}>{s.replace(/_/g,' ')}</option>)}</select></div>}
          </div>
          <div>
            <label className="label">Resume <span className="text-gray-400 font-normal text-[10px]">(PDF / DOCX — auto-parses name / phone / email / address)</span></label>
            <input
              className="input"
              type="file"
              accept=".pdf,.doc,.docx"
              disabled={parsingResume}
              onChange={async e => {
                const file = e.target.files?.[0];
                if (!file) return;
                setForm({ ...form, _file: file });
                setParsingResume(true); setParsedHits(null);
                try {
                  const fd = new FormData(); fd.append('file', file);
                  const r = await api.post('/hr/candidates/parse-resume', fd, {
                    headers: { 'Content-Type': 'multipart/form-data' },
                  });
                  const p = r.data?.parsed;
                  if (p) {
                    // Only fill EMPTY fields — never overwrite anything
                    // admin already typed manually.
                    setForm(f => ({
                      ...f,
                      _file: file,
                      resume_file: r.data?.resume_url || f.resume_file,
                      name:    f.name    || p.name    || '',
                      phone:   f.phone   || p.phone   || '',
                      email:   f.email   || p.email   || '',
                      address: f.address || p.address || '',
                      linkedin_url: f.linkedin_url || p.linkedin || '',
                    }));
                    setParsedHits(p.confidence || {});
                    const hit = Object.entries(p.confidence || {}).filter(([_, v]) => v).map(([k]) => k);
                    if (hit.length) {
                      toast.success(`Auto-filled: ${hit.join(', ')}`);
                    } else if (p.debug?.extraction_error) {
                      // Mam (2026-05-22 v3): specific error from the
                      // PDF/DOCX parser — usually "pdf-parse not
                      // installed" on the VPS.  Surface it so admin
                      // can act on it instead of guessing.
                      toast.error(`Could not read file: ${p.debug.extraction_error}`, { duration: 9000 });
                    } else if ((p.debug?.text_length || 0) === 0) {
                      toast.error('Could not extract any text from this file — it may be a scanned image PDF. Please fill the form manually.', { duration: 8000 });
                    } else {
                      toast(`Resume saved — text extracted (${p.debug?.text_length || '?'} chars) but no recognisable fields. Please fill manually.`, { icon: 'ℹ️', duration: 7000 });
                    }
                  } else {
                    setForm(f => ({ ...f, _file: file, resume_file: r.data?.resume_url || f.resume_file }));
                    toast('Resume saved — could not auto-parse', { icon: 'ℹ️' });
                  }
                } catch (err) {
                  toast.error(err.response?.data?.error || 'Resume upload failed');
                } finally {
                  setParsingResume(false);
                }
              }}
            />
            {parsingResume && (
              <p className="text-[11px] text-blue-700 mt-1 flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 border-2 border-blue-300 border-t-blue-700 rounded-full animate-spin" />
                Parsing resume…
              </p>
            )}
            {parsedHits && !parsingResume && (
              <p className="text-[10px] text-gray-500 mt-1">
                Auto-fill hits:&nbsp;
                {['name','email','phone','address'].map(k => (
                  <span key={k} className={`mr-1.5 ${parsedHits[k] ? 'text-emerald-700' : 'text-gray-400'}`}>
                    {parsedHits[k] ? '✓' : '✗'} {k}
                  </span>
                ))}
              </p>
            )}
            {/* Show the existing resume link when editing — uploading a new
                file replaces it; otherwise the existing URL is preserved. */}
            {editing && form.resume_file && !form._file && (
              <p className="text-[10px] text-emerald-600 mt-0.5">Existing: <a href={form.resume_file} target="_blank" rel="noreferrer" className="underline">view resume</a> · upload a new file to replace</p>
            )}
            {form._file && !parsingResume && <p className="text-[10px] text-blue-600 mt-0.5">Selected: {form._file.name}</p>}
          </div>
          <div><label className="label">Address <span className="text-gray-400 font-normal text-[10px]">(auto-filled from resume if found)</span></label>
            <textarea className="input" rows="2" value={form.address || ''} onChange={e => setForm({...form, address: e.target.value})} placeholder="House no, Street, City, State, PIN" />
          </div>
          <div><label className="label">Notes</label><textarea className="input" rows="3" value={form.notes || ''} onChange={e => setForm({...form, notes: e.target.value})} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" disabled={uploading} className="btn btn-primary">{uploading ? 'Uploading…' : (editing ? 'Update' : 'Add Candidate')}</button></div>
        </form>
      </Modal>

      {/* STAGE 2 — SCHEDULE FIRST INTERVIEW */}
      <Modal isOpen={modal === 'schedule_interview'} onClose={() => setModal(false)} title={`Schedule Interview — ${stageRow?.name || ''}`}>
        <form onSubmit={submitScheduleInterview} className="space-y-3">
          <p className="text-[11px] text-blue-700 bg-blue-50 border border-blue-100 rounded px-3 py-2">Pick the concerned interviewer (an employee), set a date/time, and upload the candidate's resume. Status will move to "Interview Scheduled".</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Interviewer (Employee) *</label>
              <select className="select" required value={stageForm.interviewer_id || ''} onChange={e => setStageForm(f => ({ ...f, interviewer_id: e.target.value }))}>
                <option value="">— Pick employee —</option>
                {employees.map(e => <option key={e.id} value={e.id}>{e.name}{e.designation ? ` (${e.designation})` : ''}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Interview Date & Time *</label>
              <input className="input" type="datetime-local" required value={stageForm.interview_date || ''} onChange={e => setStageForm(f => ({ ...f, interview_date: e.target.value }))} />
            </div>
          </div>
          <div>
            <label className="label">Resume <span className="text-red-500">*</span> <span className="text-gray-400 font-normal text-[10px]">(PDF / DOC / DOCX)</span></label>
            <input className="input" type="file" accept=".pdf,.doc,.docx" onChange={e => setStageForm(f => ({ ...f, _file: e.target.files?.[0] || null }))} />
            {stageRow?.resume_file && !stageForm._file && (
              <p className="text-[10px] text-emerald-600 mt-0.5">Existing: <a href={stageRow.resume_file} target="_blank" rel="noreferrer" className="underline">view resume</a> · upload a new one to replace</p>
            )}
          </div>
          <div><label className="label">Notes / Instructions</label><textarea className="input" rows="2" value={stageForm.notes || ''} onChange={e => setStageForm(f => ({ ...f, notes: e.target.value }))} placeholder="e.g. Test technical aptitude on JavaScript / specific topics" /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" disabled={uploading} className="btn btn-primary">{uploading ? 'Uploading…' : 'Schedule Interview'}</button></div>
        </form>
      </Modal>

      {/* STAGE 3 — INTERVIEW DECISION + Scorecard (mam Batch B) */}
      <Modal isOpen={modal === 'interview_decision'} onClose={() => setModal(false)} title={`Interview Decision — ${stageRow?.name || ''}`} wide>
        <form onSubmit={submitInterviewDecision} className="space-y-3">
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded px-3 py-2">After the first interview — record the interviewer's decision. <b>Shortlisted</b> moves to MD round; <b>Rejected</b> ends the pipeline.</p>
          {stageRow?.interview_date && <div className="text-[12px] text-gray-600">Interview held: <b>{fmtDt(stageRow.interview_date)}</b>{stageRow.interviewer_name ? ` · by ${stageRow.interviewer_name}` : ''}</div>}
          <div>
            <label className="label">Decision *</label>
            <div className="grid grid-cols-3 gap-2">
              {['shortlisted','on_hold','rejected'].map(d => (
                <button type="button" key={d} onClick={() => setStageForm(f => ({ ...f, decision: d }))}
                  className={`px-3 py-2 rounded-lg border text-xs font-bold uppercase ${stageForm.decision === d
                    ? (d === 'shortlisted' ? 'bg-emerald-600 text-white border-emerald-600' : d === 'rejected' ? 'bg-red-600 text-white border-red-600' : 'bg-amber-500 text-white border-amber-500')
                    : 'bg-white border-gray-200 hover:bg-gray-50 text-gray-700'}`}>
                  {d === 'on_hold' ? '⏸ On Hold' : d === 'shortlisted' ? '✓ Shortlist' : '✗ Reject'}
                </button>
              ))}
            </div>
          </div>

          {/* ─── SCORECARD (mam 2026-05-22 Batch B) ─── */}
          {/* Optional — interviewer can skip if they prefer note-only.
              When ANY score is set, the scorecard row is saved alongside
              the decision via POST /candidates/:id/scorecard. */}
          <div className="border border-indigo-200 bg-indigo-50/40 rounded-lg p-3 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold text-indigo-800">
                Scorecard <span className="text-gray-500 font-normal">(optional — rate 1-5 on each dimension)</span>
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                { k: 'technical',     label: 'Technical' },
                { k: 'communication', label: 'Communication' },
                { k: 'culture',       label: 'Culture Fit' },
                { k: 'problem',       label: 'Problem Solving' },
              ].map(d => (
                <div key={d.k}>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[11px] font-semibold text-gray-700">{d.label}</label>
                    <span className="text-[10px] text-gray-500">{stageForm[`sc_${d.k}`] || '—'}/5</span>
                  </div>
                  <div className="flex gap-1">
                    {[1,2,3,4,5].map(n => (
                      <button type="button" key={n}
                        onClick={() => setStageForm(f => ({ ...f, [`sc_${d.k}`]: f[`sc_${d.k}`] === n ? null : n }))}
                        className={`flex-1 py-1.5 rounded text-xs font-bold border
                          ${stageForm[`sc_${d.k}`] === n
                            ? 'bg-indigo-600 text-white border-indigo-600'
                            : stageForm[`sc_${d.k}`] != null && stageForm[`sc_${d.k}`] >= n
                              ? 'bg-indigo-200 text-indigo-800 border-indigo-300'
                              : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'}`}>
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div>
              <label className="label">Overall Recommendation</label>
              <div className="flex gap-1 flex-wrap">
                {[
                  { v: 'strong_yes', l: 'Strong Yes', c: 'emerald-700' },
                  { v: 'yes',        l: 'Yes',         c: 'emerald-500' },
                  { v: 'maybe',      l: 'Maybe',       c: 'amber-500' },
                  { v: 'no',         l: 'No',          c: 'red-500' },
                  { v: 'strong_no',  l: 'Strong No',   c: 'red-700' },
                ].map(o => (
                  <button type="button" key={o.v}
                    onClick={() => setStageForm(f => ({ ...f, sc_overall: f.sc_overall === o.v ? null : o.v }))}
                    className={`px-3 py-1 rounded text-[11px] font-bold uppercase border
                      ${stageForm.sc_overall === o.v
                        ? `bg-${o.c} text-white border-${o.c}`
                        : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}>
                    {o.l}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Strengths</label>
                <textarea className="input" rows="2" placeholder="e.g. solid systems thinking, fast on MEP basics"
                  value={stageForm.sc_strengths || ''} onChange={e => setStageForm(f => ({ ...f, sc_strengths: e.target.value }))} />
              </div>
              <div>
                <label className="label">Weaknesses / Concerns</label>
                <textarea className="input" rows="2" placeholder="e.g. struggled with conflict scenario, junior on contracts"
                  value={stageForm.sc_weaknesses || ''} onChange={e => setStageForm(f => ({ ...f, sc_weaknesses: e.target.value }))} />
              </div>
            </div>
          </div>

          <div><label className="label">Interview Notes / Decision Reasoning</label><textarea className="input" rows="3" value={stageForm.notes || ''} onChange={e => setStageForm(f => ({ ...f, notes: e.target.value }))} placeholder="Final summary — why shortlisted / rejected / on hold" /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Save Decision{(['technical','communication','culture','problem'].some(k => stageForm[`sc_${k}`]) || stageForm.sc_overall) ? ' + Scorecard' : ''}</button></div>
        </form>
      </Modal>

      {/* STAGE 4 — SCHEDULE MD INTERVIEW */}
      <Modal isOpen={modal === 'schedule_md'} onClose={() => setModal(false)} title={`Schedule MD Interview — ${stageRow?.name || ''}`}>
        <form onSubmit={submitScheduleMD} className="space-y-3">
          <p className="text-[11px] text-purple-700 bg-purple-50 border border-purple-100 rounded px-3 py-2">Final round with MD Sir. Set a date/time. After MD's decision, the offer letter can be uploaded and sent.</p>
          <div>
            <label className="label">MD Interview Date & Time *</label>
            <input className="input" type="datetime-local" required value={stageForm.md_interview_date || ''} onChange={e => setStageForm(f => ({ ...f, md_interview_date: e.target.value }))} />
          </div>
          <div><label className="label">Notes</label><textarea className="input" rows="2" value={stageForm.notes || ''} onChange={e => setStageForm(f => ({ ...f, notes: e.target.value }))} placeholder="Brief MD on the candidate's strengths" /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Schedule MD Round</button></div>
        </form>
      </Modal>

      {/* STAGE 5 — MD DECISION + OFFER LETTER */}
      <Modal isOpen={modal === 'md_decision'} onClose={() => setModal(false)} title={`MD Decision — ${stageRow?.name || ''}`} wide>
        <form onSubmit={submitMDDecision} className="space-y-3">
          <p className="text-[11px] text-indigo-700 bg-indigo-50 border border-indigo-100 rounded px-3 py-2">If MD shortlisted — fill the offer details below and the system will auto-generate the offer letter PDF for review. If rejected — pipeline ends.</p>
          {stageRow?.md_interview_date && <div className="text-[12px] text-gray-600">MD round: <b>{fmtDt(stageRow.md_interview_date)}</b></div>}
          <div>
            <label className="label">MD's Decision *</label>
            <div className="grid grid-cols-2 gap-2">
              {['shortlisted','rejected'].map(d => (
                <button type="button" key={d} onClick={() => setStageForm(f => ({ ...f, decision: d }))}
                  className={`px-3 py-2 rounded-lg border text-xs font-bold uppercase ${stageForm.decision === d
                    ? (d === 'shortlisted' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-red-600 text-white border-red-600')
                    : 'bg-white border-gray-200 hover:bg-gray-50 text-gray-700'}`}>
                  {d === 'shortlisted' ? '✓ Shortlist & Send Offer' : '✗ Reject'}
                </button>
              ))}
            </div>
          </div>
          {stageForm.decision === 'shortlisted' && (
            <div className="bg-emerald-50/50 border border-emerald-200 rounded-lg p-3 space-y-3">
              <p className="text-[11px] text-emerald-800 font-semibold">
                Offer details — system auto-generates the offer letter using SEPL's format
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Position *</label>
                  <input className="input" required
                    value={stageForm.offered_position || stageRow?.position || ''}
                    onChange={e => setStageForm(f => ({ ...f, offered_position: e.target.value }))}
                    placeholder="e.g. Site Engineer" />
                </div>
                <div>
                  <label className="label">Offered Salary (₹/month) *</label>
                  <input className="input" type="number" required
                    value={stageForm.offered_salary || ''}
                    onChange={e => setStageForm(f => ({ ...f, offered_salary: e.target.value }))}
                    placeholder="35000" />
                </div>
                <div>
                  <label className="label">Joining Date *</label>
                  <input className="input" type="date" required
                    value={stageForm.joining_date || ''}
                    onChange={e => setStageForm(f => ({ ...f, joining_date: e.target.value }))} />
                </div>
                <div>
                  <label className="label">Reporting To</label>
                  <input className="input"
                    value={stageForm.reporting_to || ''}
                    onChange={e => setStageForm(f => ({ ...f, reporting_to: e.target.value }))}
                    placeholder="e.g. Ankur Kaplesh" />
                </div>
              </div>
              <p className="text-[10px] text-emerald-700 italic">
                After saving, the offer letter opens in a new tab with SEPL's standard
                format (auto-filled from these fields + the candidate's resume).
                Press Ctrl+P → Save as PDF to share with the candidate.
              </p>

              {/* Batch D: optional CTC breakup customizer */}
              <details className="border-t border-emerald-200 pt-2">
                <summary className="text-[11px] font-semibold text-emerald-800 cursor-pointer select-none">
                  Customize CTC line items (optional — leave blank for SEPL default)
                </summary>
                <div className="mt-2 space-y-2">
                  <p className="text-[10px] text-gray-600">
                    Add or override the CTC rows shown on the offer letter. Leave blank to use the
                    standard SEPL template (Basic + standard allowances).
                  </p>
                  {(stageForm.breakup_lines || []).map((row, i) => (
                    <div key={i} className="grid grid-cols-12 gap-1.5 items-center">
                      <input className="input col-span-5 text-[12px] py-1" placeholder="Line name" value={row.name || ''}
                        onChange={e => setStageForm(f => {
                          const next = [...(f.breakup_lines || [])]; next[i] = { ...next[i], name: e.target.value }; return { ...f, breakup_lines: next };
                        })}/>
                      <input className="input col-span-3 text-[12px] py-1" placeholder="Monthly" value={row.monthly || ''}
                        onChange={e => setStageForm(f => {
                          const next = [...(f.breakup_lines || [])]; next[i] = { ...next[i], monthly: e.target.value }; return { ...f, breakup_lines: next };
                        })}/>
                      <input className="input col-span-3 text-[12px] py-1" placeholder="Annual" value={row.annual || ''}
                        onChange={e => setStageForm(f => {
                          const next = [...(f.breakup_lines || [])]; next[i] = { ...next[i], annual: e.target.value }; return { ...f, breakup_lines: next };
                        })}/>
                      <button type="button" onClick={() => setStageForm(f => ({ ...f, breakup_lines: (f.breakup_lines || []).filter((_, idx) => idx !== i) }))}
                        className="col-span-1 text-rose-500 hover:text-rose-700" title="Remove">
                        <FiTrash2 size={14}/>
                      </button>
                    </div>
                  ))}
                  <button type="button"
                    onClick={() => setStageForm(f => ({ ...f, breakup_lines: [...(f.breakup_lines || []), { name: '', monthly: '', annual: '' }] }))}
                    className="text-[11px] text-emerald-700 hover:underline">
                    + Add CTC line
                  </button>
                </div>
              </details>
            </div>
          )}
          <div><label className="label">MD's Notes</label><textarea className="input" rows="2" value={stageForm.notes || ''} onChange={e => setStageForm(f => ({ ...f, notes: e.target.value }))} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" disabled={uploading} className="btn btn-primary">{uploading ? 'Uploading…' : 'Save Decision'}</button></div>
        </form>
      </Modal>

      {/* STAGE 6 — FINALIZE (Onboarded / Accepted / Rejected) */}
      <Modal isOpen={modal === 'finalize'} onClose={() => setModal(false)} title={`Finalize — ${stageRow?.name || ''}`}>
        <form onSubmit={submitFinalize} className="space-y-3">
          <p className="text-[11px] text-teal-700 bg-teal-50 border border-teal-100 rounded px-3 py-2">Update final state — Accepted (offer accepted, joining pending) → Onboarded (candidate has joined).</p>
          <div>
            <label className="label">Final Status *</label>
            <select className="select" required value={stageForm.final_status || ''} onChange={e => setStageForm(f => ({ ...f, final_status: e.target.value }))}>
              <option value="">— Pick —</option>
              <option value="accepted">Offer Accepted (joining pending)</option>
              <option value="onboarded">Onboarded (joined, in payroll)</option>
              <option value="rejected">Candidate declined / Withdrawn</option>
            </select>
          </div>
          <div><label className="label">Notes</label><textarea className="input" rows="2" value={stageForm.notes || ''} onChange={e => setStageForm(f => ({ ...f, notes: e.target.value }))} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Save</button></div>
        </form>
      </Modal>

      {/* ════════════════════════════════════════════════════════════ */}
      {/*  ATS Phase 1 modals (mam 2026-05-22): Timeline · Tags · Hold */}
      {/*  + Duplicate-warning dialog.                                  */}
      {/* ════════════════════════════════════════════════════════════ */}

      {/* TIMELINE — chronological audit log for one candidate */}
      <Modal isOpen={!!timelineRow} onClose={() => setTimelineRow(null)} title={`Activity Timeline — ${timelineRow?.name || ''}`} wide>
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
          {timelineEvents.length === 0 && (
            <p className="text-[12px] text-gray-400 italic px-2 py-4 text-center">No events recorded yet.</p>
          )}
          {timelineEvents.map(ev => {
            const dt = ev.created_at ? fmtDateTime(ev.created_at, { dateStyle: 'medium', timeStyle: 'short' }) : '';
            const typeColors = {
              created:             'bg-blue-100 text-blue-700 border-blue-300',
              interview_scheduled: 'bg-indigo-100 text-indigo-700 border-indigo-300',
              interview_done:      'bg-amber-100 text-amber-700 border-amber-300',
              md_scheduled:        'bg-purple-100 text-purple-700 border-purple-300',
              md_decision:         'bg-purple-100 text-purple-700 border-purple-300',
              offer_generated:     'bg-emerald-100 text-emerald-700 border-emerald-300',
              finalised:           'bg-teal-100 text-teal-700 border-teal-300',
              tags_updated:        'bg-gray-100 text-gray-700 border-gray-300',
              hold_on:             'bg-amber-100 text-amber-800 border-amber-400',
              hold_off:            'bg-emerald-100 text-emerald-700 border-emerald-300',
            };
            const cls = typeColors[ev.event_type] || 'bg-gray-100 text-gray-700 border-gray-300';
            return (
              <div key={ev.id} className="border border-gray-200 rounded-lg p-2.5 text-[12px] flex items-start gap-3">
                <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border whitespace-nowrap ${cls}`}>{ev.event_type.replace(/_/g, ' ')}</span>
                <div className="flex-1">
                  <div className="text-gray-800">{ev.note || '—'}</div>
                  <div className="text-[10px] text-gray-400 mt-0.5">
                    {dt} · by {ev.user_name || `#${ev.user_id || '?'}`}
                    {ev.from_status && ev.to_status && (
                      <span className="ml-2 text-gray-500">[{ev.from_status} → {ev.to_status}]</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex justify-end pt-3">
          <button onClick={() => setTimelineRow(null)} className="btn btn-secondary">Close</button>
        </div>
      </Modal>

      {/* TAGS — edit free-form CSV chips per candidate */}
      <Modal isOpen={!!tagsRow} onClose={() => setTagsRow(null)} title={`Tags — ${tagsRow?.name || ''}`}>
        <div className="space-y-3">
          <p className="text-[11px] text-gray-500">
            Comma-separated tags for quick filtering / search.  Examples:
            <span className="ml-1 italic">urgent, diversity, ex-L&amp;T, returning-employee</span>
          </p>
          <input
            className="input"
            value={tagsDraft}
            onChange={e => setTagsDraft(e.target.value)}
            placeholder="urgent, ex-L&T, BBA-fresher"
            autoFocus
          />
          {tagsDraft && (
            <div className="flex flex-wrap gap-1">
              {tagsDraft.split(',').map(t => t.trim()).filter(Boolean).map(t => (
                <span key={t} className="text-[10px] font-semibold px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">{t}</span>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-3 pt-1">
            <button onClick={() => setTagsRow(null)} className="btn btn-secondary">Cancel</button>
            <button onClick={saveTags} className="btn btn-primary">Save Tags</button>
          </div>
        </div>
      </Modal>

      {/* HOLD — toggle is_on_hold + reason */}
      <Modal isOpen={!!holdRow} onClose={() => setHoldRow(null)} title={`${holdRow?.is_on_hold ? 'Remove Hold' : 'Put On Hold'} — ${holdRow?.name || ''}`}>
        <div className="space-y-3">
          {holdRow?.is_on_hold ? (
            <>
              <p className="text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-100 rounded px-3 py-2">
                Removing the hold returns the candidate to the regular pipeline.
              </p>
              <div className="text-[12px] text-gray-600">
                <span className="font-semibold">Current reason:</span> {holdRow.hold_reason || '(none recorded)'}
              </div>
              <div className="flex justify-end gap-3 pt-1">
                <button onClick={() => setHoldRow(null)} className="btn btn-secondary">Cancel</button>
                <button onClick={() => toggleHold(false)} className="btn btn-primary bg-emerald-600 hover:bg-emerald-700 border-emerald-600">Remove Hold</button>
              </div>
            </>
          ) : (
            <>
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded px-3 py-2">
                Held candidates stay in the system but move to the "On Hold" filter — they don't show in their original pipeline stage until the hold is removed.
              </p>
              <div>
                <label className="label">Reason <span className="text-gray-400 font-normal text-[10px]">(optional)</span></label>
                <textarea
                  className="input"
                  rows="2"
                  value={holdDraft}
                  onChange={e => setHoldDraft(e.target.value)}
                  placeholder="e.g. Pending budget approval / candidate asked for time / re-engage in Q3"
                />
              </div>
              <div className="flex justify-end gap-3 pt-1">
                <button onClick={() => setHoldRow(null)} className="btn btn-secondary">Cancel</button>
                <button onClick={() => toggleHold(true)} className="btn btn-primary bg-amber-600 hover:bg-amber-700 border-amber-600">Put On Hold</button>
              </div>
            </>
          )}
        </div>
      </Modal>

      {/* ── BATCH C: RUN SCREENING modal ──
          HR types/picks the candidate's answers to the applicable
          screening questions, hits Submit, and the server stamps the
          candidate's eligibility_status (eligible / partial / rejected). */}
      <Modal isOpen={!!screeningRow} onClose={() => setScreeningRow(null)} title={`Run Screening — ${screeningRow?.name || ''}`} wide>
        <div className="space-y-3 max-h-[75vh] overflow-y-auto">
          <p className="text-[11px] text-blue-700 bg-blue-50 border border-blue-100 rounded px-3 py-2">
            Fill the candidate's answers below. The system will auto-stamp <b>Eligible</b> / <b>Partial</b> /
            <b> Auto-Rejected</b> based on the rules configured under the <b>Screening Qs</b> tab.
          </p>
          {screeningRow?.eligibility_status && (
            <div className="text-[12px] text-gray-700 bg-gray-50 border border-gray-200 rounded px-3 py-2">
              Previous result: <b className={
                screeningRow.eligibility_status === 'eligible' ? 'text-emerald-700' :
                screeningRow.eligibility_status === 'partial'  ? 'text-amber-700'    :
                                                                  'text-rose-700'
              }>{screeningRow.eligibility_status.toUpperCase()}</b>
              {screeningRow.eligibility_reason && <span className="ml-1 italic">— {screeningRow.eligibility_reason}</span>}
            </div>
          )}
          {screeningQs.length === 0 ? (
            <div className="text-center py-10 text-gray-400 text-[13px]">
              No screening questions configured yet.<br/>
              <a className="text-blue-700 hover:underline" onClick={() => { setScreeningRow(null); setTab('screening'); }} style={{cursor:'pointer'}}>
                Go to Screening Qs tab to add some →
              </a>
            </div>
          ) : (
            <div className="space-y-3">
              {screeningQs.map((q, idx) => (
                <div key={q.id} className="border border-gray-200 rounded-lg p-3">
                  <div className="flex items-start gap-2 mb-2">
                    <span className="text-[11px] font-bold text-gray-500 w-5">{idx + 1}.</span>
                    <div className="flex-1">
                      <div className="text-[13px] text-gray-900 flex items-center gap-1.5 flex-wrap">
                        {q.question_text}
                        {!!q.is_mandatory && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-100 text-red-700">Mandatory *</span>}
                        {q.auto_reject_op && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-700" title={q.auto_reject_reason || `Reject if answer ${q.auto_reject_op} ${q.auto_reject_value}`}>Has auto-reject rule</span>}
                      </div>
                      <div className="mt-2">
                        {q.question_type === 'mcq' && Array.isArray(q.options) && (
                          <div className="flex flex-wrap gap-2">
                            {q.options.map(opt => (
                              <button
                                type="button"
                                key={opt}
                                onClick={() => setScreeningAns(a => ({ ...a, [q.id]: opt }))}
                                className={`px-3 py-1.5 rounded-lg border text-[12px]
                                  ${screeningAns[q.id] === opt
                                    ? 'bg-blue-600 text-white border-blue-600'
                                    : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}>
                                {opt}
                              </button>
                            ))}
                          </div>
                        )}
                        {q.question_type === 'yes_no' && (
                          <div className="flex gap-2">
                            {['Yes','No'].map(opt => (
                              <button
                                type="button"
                                key={opt}
                                onClick={() => setScreeningAns(a => ({ ...a, [q.id]: opt }))}
                                className={`px-4 py-1.5 rounded-lg border text-[12px] font-bold
                                  ${screeningAns[q.id] === opt
                                    ? (opt === 'Yes' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-red-600 text-white border-red-600')
                                    : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}>
                                {opt}
                              </button>
                            ))}
                          </div>
                        )}
                        {q.question_type === 'number' && (
                          <input
                            type="number"
                            className="input w-40"
                            value={screeningAns[q.id] || ''}
                            onChange={e => setScreeningAns(a => ({ ...a, [q.id]: e.target.value }))}
                            placeholder="number"
                          />
                        )}
                        {q.question_type === 'descriptive' && (
                          <textarea
                            className="input"
                            rows="2"
                            value={screeningAns[q.id] || ''}
                            onChange={e => setScreeningAns(a => ({ ...a, [q.id]: e.target.value }))}
                            placeholder="Candidate's answer"
                          />
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={() => setScreeningRow(null)} className="btn btn-secondary">Cancel</button>
            {screeningQs.length > 0 && (
              <button onClick={submitScreening} disabled={screeningSubmitting} className="btn btn-primary">
                {screeningSubmitting ? 'Evaluating…' : 'Submit & Evaluate'}
              </button>
            )}
          </div>
        </div>
      </Modal>

      {/* ── BATCH D: PRE-ONBOARDING DOCS modal ──
          Per-candidate checklist of standard onboarding documents.
          Seeded with Aadhaar / PAN / Resume / Experience / Bank /
          Photo / Education on first open; admin can add custom items.
          Status flow: pending → received → verified (or rejected). */}
      <Modal isOpen={!!docsRow} onClose={() => setDocsRow(null)} title={`Pre-Onboarding Docs — ${docsRow?.name || ''}`} wide>
        <div className="space-y-3 max-h-[75vh] overflow-y-auto">
          <p className="text-[11px] text-blue-700 bg-blue-50 border border-blue-100 rounded px-3 py-2">
            Standard onboarding checklist. Upload each doc as the candidate sends it, then mark
            <b> Verified</b> once HR has reviewed.
          </p>
          {(() => {
            const total = docsList.length;
            const received = docsList.filter(d => d.status === 'received' || d.status === 'verified').length;
            const verified = docsList.filter(d => d.status === 'verified').length;
            const pct = total > 0 ? Math.round((received / total) * 100) : 0;
            return (
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-[12px]">
                <div className="flex justify-between mb-1">
                  <span className="font-semibold text-gray-700">Progress</span>
                  <span className="text-gray-500">{received}/{total} received · {verified} verified</span>
                </div>
                <div className="bg-gray-200 rounded-full h-2 overflow-hidden">
                  <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }}/>
                </div>
              </div>
            );
          })()}
          <div className="space-y-2">
            {docsList.map(doc => {
              const statusColor = doc.status === 'verified' ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
                                : doc.status === 'received' ? 'bg-blue-100 text-blue-700 border-blue-200'
                                : doc.status === 'rejected' ? 'bg-rose-100 text-rose-700 border-rose-200'
                                :                              'bg-gray-100 text-gray-600 border-gray-200';
              return (
                <div key={doc.id} className="border border-gray-200 rounded-lg p-3">
                  <div className="flex items-start gap-2 flex-wrap">
                    <div className="flex-1 min-w-[200px]">
                      <div className="font-medium text-gray-900 text-[13px]">{doc.doc_label || doc.doc_type}</div>
                      {doc.file_url && (
                        <a href={doc.file_url} target="_blank" rel="noreferrer" className="text-[11px] text-blue-700 hover:underline inline-flex items-center gap-1 mt-0.5">
                          <FiFileText size={10}/> View uploaded file
                        </a>
                      )}
                      {doc.uploaded_at && !doc.file_url && (
                        <div className="text-[10px] text-gray-400">Uploaded: {fmtDate(doc.uploaded_at)}</div>
                      )}
                    </div>
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${statusColor}`}>
                      {doc.status}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    <label className="text-[11px] text-blue-700 hover:underline cursor-pointer">
                      📎 {doc.file_url ? 'Replace' : 'Upload'}
                      <input type="file" className="hidden" onChange={e => uploadDoc(doc, e.target.files?.[0])} />
                    </label>
                    {doc.file_url && doc.status !== 'verified' && (
                      <button onClick={() => updateDocStatus(doc, 'verified')} className="text-[11px] text-emerald-700 hover:underline">✓ Mark Verified</button>
                    )}
                    {doc.status !== 'rejected' && (
                      <button onClick={() => updateDocStatus(doc, 'rejected')} className="text-[11px] text-rose-700 hover:underline">✗ Reject</button>
                    )}
                    {doc.status !== 'pending' && (
                      <button onClick={() => updateDocStatus(doc, 'pending')} className="text-[11px] text-gray-500 hover:underline">↺ Reset</button>
                    )}
                    <button onClick={() => deleteDoc(doc)} className="text-[11px] text-gray-400 hover:text-rose-600 ml-auto" title="Remove from checklist"><FiTrash2 size={12}/></button>
                  </div>
                </div>
              );
            })}
          </div>
          <button onClick={addCustomDoc} className="btn btn-secondary text-[11px] py-1 px-2 flex items-center gap-1">
            <FiPlus size={12}/> Add Custom Document
          </button>
          <div className="flex justify-end pt-2">
            <button onClick={() => setDocsRow(null)} className="btn btn-secondary">Close</button>
          </div>
        </div>
      </Modal>

      {/* DUPLICATE WARNING — shown after POST /candidates returns 409.
          Admin sees the matching candidate(s) and can either cancel
          or "Save Anyway" (re-POSTs with ?force=1). */}
      <Modal isOpen={!!dupWarning} onClose={() => setDupWarning(null)} title="Possible Duplicate Candidate" wide>
        <div className="space-y-3">
          <p className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 flex items-start gap-2">
            <FiAlertTriangle size={16} className="mt-0.5 flex-shrink-0"/>
            <span>
              <b>{dupWarning?.duplicates?.length || 0}</b> existing candidate{(dupWarning?.duplicates?.length || 0) === 1 ? '' : 's'} match the email or phone you entered.
              Open the existing record to update it, or click "Save Anyway" to create a new candidate.
            </span>
          </p>
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="text-[12px] w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-2 py-1.5 text-[10px] font-semibold text-gray-500 uppercase">Existing Candidate</th>
                  <th className="text-left px-2 py-1.5 text-[10px] font-semibold text-gray-500 uppercase">Contact</th>
                  <th className="text-left px-2 py-1.5 text-[10px] font-semibold text-gray-500 uppercase">Status</th>
                  <th className="text-left px-2 py-1.5 text-[10px] font-semibold text-gray-500 uppercase">Added</th>
                </tr>
              </thead>
              <tbody>
                {(dupWarning?.duplicates || []).map(d => (
                  <tr key={d.id} className="border-t">
                    <td className="px-2 py-1.5"><b>{d.name}</b>{d.position ? ` · ${d.position}` : ''}</td>
                    <td className="px-2 py-1.5 text-gray-600">
                      {d.phone || ''}
                      {d.phone && d.email && ' · '}
                      {d.email || ''}
                    </td>
                    <td className="px-2 py-1.5">
                      <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-gray-100 text-gray-700">{d.status?.replace(/_/g, ' ')}</span>
                    </td>
                    <td className="px-2 py-1.5 text-gray-500 text-[11px]">
                      {d.created_at ? fmtDate(d.created_at, { day: '2-digit', month: 'short', year: 'numeric' }) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={() => setDupWarning(null)} className="btn btn-secondary">Cancel</button>
            <button
              onClick={() => saveCandidate(null, { force: true })}
              className="btn btn-primary bg-amber-600 hover:bg-amber-700 border-amber-600">
              Save Anyway (new candidate)
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={modal === 'contractor'} onClose={() => setModal(false)} title={editing ? 'Edit Contractor' : 'Add Contractor'}>
        <form onSubmit={saveContractor} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className="label">Name *</label><input className="input" value={form.name || ''} onChange={e => setForm({...form, name: e.target.value})} required /></div>
            <div><label className="label">Phone</label><input className="input" value={form.phone || ''} onChange={e => setForm({...form, phone: e.target.value})} /></div>
            <div><label className="label">Email</label><input className="input" value={form.email || ''} onChange={e => setForm({...form, email: e.target.value})} /></div>
            <div><label className="label">Specialization</label><input className="input" value={form.specialization || ''} onChange={e => setForm({...form, specialization: e.target.value})} /></div>
            <div><label className="label">Rate (Rs)</label><input className="input" type="number" value={form.rate || 0} onChange={e => setForm({...form, rate: +e.target.value})} /></div>
            <div><label className="label">Rate Unit</label><select className="select" value={form.rate_unit || 'per_day'} onChange={e => setForm({...form, rate_unit: e.target.value})}><option value="per_day">Per Day</option><option value="per_hour">Per Hour</option><option value="per_sqft">Per Sqft</option><option value="lump_sum">Lump Sum</option></select></div>
            {editing && <div><label className="label">Status</label><select className="select" value={form.status || ''} onChange={e => setForm({...form, status: e.target.value})}>{['qualified','negotiation','onboarded','active','inactive'].map(s => <option key={s} value={s}>{s}</option>)}</select></div>}
          </div>
          <div><label className="label">Notes</label><textarea className="input" rows="3" value={form.notes || ''} onChange={e => setForm({...form, notes: e.target.value})} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'}</button></div>
        </form>
      </Modal>
    </div>
  );
}

// Project-wise manpower plan (mam 2026-06-12): per UNIQUE project, the
// required manpower (from the value slab) vs the actual on site (latest
// DPR), so HR can spot shortages and hire / redeploy.
function ManpowerTab() {
  const { canEdit } = useAuth();
  const editable = canEdit('hr');         // admins + HR-editors can override Required
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [editKey, setEditKey] = useState(null);   // project key currently being edited
  const [editVal, setEditVal] = useState('');
  const [saving, setSaving] = useState(false);
  const [catFilter, setCatFilter] = useState('all');
  const CATEGORIES = ['Live', 'Hold', 'Service Team', 'Handover'];
  const load = () => {
    api.get('/hr/manpower-plan')
      .then(r => setRows(r.data || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };
  // Keep the board live so one user's category / required edit shows up for
  // everyone without a manual page refresh (mam 2026-06-12): poll every 20s
  // and refetch whenever the tab regains focus.  The initial spinner only
  // shows on first load; polls swap data in silently.
  useEffect(() => {
    load();
    const id = setInterval(load, 20000);
    const onFocus = () => { if (document.visibilityState === 'visible') load(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Each project row has three editable targets — manpower, Site Engineers and
  // Jr. Site Engineers — so the edit key is composite: `${projectKey}|${role}`.
  const ROLES = {
    manpower:    { label: 'Required manpower',      val: 'required',    auto: 'required_auto',    ov: 'required_overridden' },
    site_eng:    { label: 'Required Site Eng',      val: 'se_required', auto: 'se_required_auto', ov: 'se_required_overridden' },
    jr_site_eng: { label: 'Required Jr. Site Eng',  val: 'jr_required', auto: 'jr_required_auto', ov: 'jr_required_overridden' },
    foreman:     { label: 'Required Foreman',       val: 'fm_required', auto: 'fm_required_auto', ov: 'fm_required_overridden' },
  };
  const ekey = (r, role) => `${r.key}|${role}`;
  const startEdit = (r, role) => { setEditKey(ekey(r, role)); setEditVal(String(r[ROLES[role].val] ?? '')); };
  const cancelEdit = () => { setEditKey(null); setEditVal(''); };
  const saveEdit = async (r, value, role = 'manpower') => {
    setSaving(true);
    try {
      await api.put('/hr/manpower-plan/required', { key: r.key, required: value, role });
      toast.success(value === '' || +value <= 0 ? 'Reset to auto value' : `${ROLES[role].label} updated`);
      cancelEdit();
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Update failed');
    } finally { setSaving(false); }
  };
  const saveCategory = async (r, category) => {
    try {
      await api.put('/hr/manpower-plan/category', { key: r.key, category });
      toast.success(category ? `Marked ${category}` : 'Category cleared');
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Update failed');
    }
  };
  const fmtMoney = n => '₹' + Math.round(+n || 0).toLocaleString('en-IN');
  const fmtShort = n => {
    const v = +n || 0;
    if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
    if (v >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
    return '₹' + Math.round(v).toLocaleString('en-IN');
  };
  const q = search.trim().toLowerCase();
  const filtered = rows.filter(r =>
    (catFilter === 'all' || (r.category || '') === catFilter) &&
    (!q || (r.project || '').toLowerCase().includes(q))
  );
  const totalReq = filtered.reduce((s, r) => s + (r.required || 0), 0);
  const totalAct = filtered.reduce((s, r) => s + (r.actual || 0), 0);
  const totalGap = totalReq - totalAct;
  const shortCount = filtered.filter(r => r.gap > 0).length;
  const overallCoverage = totalReq > 0 ? Math.round((totalAct / totalReq) * 100) : 0;
  const coverage = r => (r.required > 0 ? Math.min(100, Math.round((r.actual / r.required) * 100)) : 0);
  const barColor = pct => (pct >= 100 ? 'bg-emerald-500' : pct >= 50 ? 'bg-amber-500' : 'bg-red-500');
  const fmtDpr = s => {
    if (!s) return null;
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return fmtDate(s, { day: '2-digit', month: 'short', year: '2-digit' });
  };
  // Compact "actual / target" cell for Site Eng & Jr. Site Eng — actual comes
  // from the project's PO site engineers (classified by Employee designation);
  // the target auto-fills from the value slab and the ✏️ overrides it.
  const renderEngCell = (r, role, actualKey, gapKey, namesKey) => {
    if (r.is_handover) return <span className="text-gray-300 text-xs">—</span>;
    const cfg = ROLES[role];
    const required = r[cfg.val] || 0;
    const auto = r[cfg.auto] || 0;
    const overridden = r[cfg.ov];
    const actual = r[actualKey] || 0;
    const gap = r[gapKey];
    const names = r[namesKey] || [];
    if (editKey === ekey(r, role)) {
      return (
        <div className="inline-flex items-center gap-1">
          <input type="number" min="0" autoFocus className="input text-xs text-center" style={{ width: '48px' }}
            value={editVal} onChange={e => setEditVal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') saveEdit(r, editVal, role); if (e.key === 'Escape') cancelEdit(); }} />
          <button type="button" disabled={saving} onClick={() => saveEdit(r, editVal, role)} className="text-emerald-600 hover:text-emerald-800" title="Save"><FiCheckCircle size={15} /></button>
          <button type="button" onClick={cancelEdit} className="text-gray-400 hover:text-gray-600 text-sm font-bold" title="Cancel">✕</button>
        </div>
      );
    }
    const color = (required === 0 && actual === 0) ? 'text-gray-300' : gap > 0 ? 'text-red-600' : 'text-emerald-700';
    return (
      <div className="inline-flex flex-col items-center gap-0.5">
        <div className="inline-flex items-center gap-1" title={overridden ? `Target manually set · default would be ${auto}` : 'Default target: 1 per project'}>
          <span className={`font-bold text-xs ${color}`}>{actual}</span>
          <span className="text-gray-400 text-xs">/ {required}</span>
          {editable && <button type="button" onClick={() => startEdit(r, role)} className="text-gray-300 hover:text-blue-600" title={`Edit ${cfg.label.toLowerCase()}`}><FiEdit2 size={11} /></button>}
          {editable && overridden && <button type="button" onClick={() => saveEdit(r, '', role)} className="text-gray-300 hover:text-red-500 text-sm leading-none" title={`Reset to auto (${auto})`}>↺</button>}
        </div>
        {names.length > 0 && (
          <div className="text-[10px] leading-tight text-gray-500 max-w-[104px] truncate" title={names.join(', ')}>{names.join(', ')}</div>
        )}
      </div>
    );
  };
  // Role totals across the filtered projects — required vs actual on site.
  const sumOf = k => filtered.reduce((s, r) => s + (r[k] || 0), 0);
  const roleCards = [
    { label: 'Site Eng', actual: sumOf('se_actual'), required: sumOf('se_required'), ring: 'bg-indigo-100 text-indigo-600' },
    { label: 'Jr. Site Eng', actual: sumOf('jr_actual'), required: sumOf('jr_required'), ring: 'bg-sky-100 text-sky-600' },
    { label: 'Foreman', actual: sumOf('fm_actual'), required: sumOf('fm_required'), ring: 'bg-amber-100 text-amber-600' },
  ];
  const cards = [
    { label: 'Projects', value: filtered.length, icon: FiBriefcase, ring: 'bg-slate-100 text-slate-600', text: 'text-slate-800' },
    { label: 'Required', value: totalReq, icon: FiUsers, ring: 'bg-blue-100 text-blue-600', text: 'text-blue-700' },
    { label: 'Actual (avg DPR)', value: totalAct, icon: FiCheckCircle, ring: 'bg-emerald-100 text-emerald-600', text: 'text-emerald-700' },
    { label: 'Shortfall', value: totalGap > 0 ? `−${totalGap}` : totalGap === 0 ? '0' : `+${-totalGap}`, sub: `${shortCount} project(s) short`, icon: FiAlertTriangle, ring: totalGap > 0 ? 'bg-red-100 text-red-600' : 'bg-emerald-100 text-emerald-600', text: totalGap > 0 ? 'text-red-600' : 'text-emerald-600' },
  ];

  return (
    <div className="space-y-4">
      {/* Info banner */}
      <div className="text-xs text-gray-600 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-100 rounded-lg px-4 py-2.5">
        <b>Required</b> manpower comes from each project's total value
        (0–5 L → 4 · 5–25 L → 6 · 25–50 L → 8 · 50 L–1 Cr → 10 · 1–5 Cr → 15 · 5–10 Cr → 25 · 10 Cr+ → 40).
        <b> Actual</b> is the average manpower across the project's DPRs. A red <b>gap</b> means more people are needed.
        <b> Site Eng / Jr. Site Eng / Foreman</b> show <i>on site (from the project's PO engineers, by designation) / target</i> — red means short. Every project needs 1 Jr. Site Eng + 1 Foreman; a Site Eng is added once the project is ₹1.5 Cr+.
        {editable && <span className="text-blue-700"> · Click the ✏️ on any <b>Required</b> / target to override it, and set a <b>Category</b> per project — <b>Handover</b> needs no team / no planning.</span>}
      </div>

      {/* Summary stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map((c, i) => {
          const Icon = c.icon;
          return (
            <div key={i} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex items-center gap-3">
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${c.ring}`}><Icon size={18} /></div>
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold truncate">{c.label}</div>
                <div className={`text-2xl font-bold leading-tight ${c.text}`}>{c.value}</div>
                {c.sub && <div className="text-[10px] text-gray-400">{c.sub}</div>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Per-role required vs actual (on site) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {roleCards.map((c, i) => {
          const short = c.actual < c.required;
          return (
            <div key={i} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex items-center gap-3">
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${c.ring}`}><FiUsers size={18} /></div>
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold truncate">{c.label}</div>
                <div className="flex items-baseline gap-1.5 leading-tight">
                  <span className={`text-2xl font-bold ${short ? 'text-red-600' : 'text-emerald-600'}`}>{c.actual}</span>
                  <span className="text-sm text-gray-400">/ {c.required} needed</span>
                </div>
                <div className="text-[10px] text-gray-400">{short ? `${c.required - c.actual} short` : 'on target'}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Overall coverage bar */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-semibold text-gray-600">Overall manpower coverage</span>
          <span className={`text-xs font-bold ${overallCoverage >= 100 ? 'text-emerald-600' : overallCoverage >= 50 ? 'text-amber-600' : 'text-red-600'}`}>{totalAct} / {totalReq} · {overallCoverage}%</span>
        </div>
        <div className="h-2.5 rounded-full bg-gray-100 overflow-hidden">
          <div className={`h-full rounded-full transition-all ${barColor(overallCoverage)}`} style={{ width: `${Math.min(100, overallCoverage)}%` }} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input className="input text-sm max-w-xs flex-1 min-w-[180px]" placeholder="Search project…" value={search} onChange={e => setSearch(e.target.value)} />
        <select className="select text-sm" style={{ width: '160px' }} value={catFilter} onChange={e => setCatFilter(e.target.value)} title="Filter by category">
          <option value="all">All categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          <option value="">Uncategorized</option>
        </select>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="text-sm w-full">
            <thead>
              <tr className="bg-gradient-to-b from-gray-50 to-gray-100 border-b border-gray-200 text-[10px] uppercase tracking-wider text-gray-500">
                <th className="px-4 py-3 text-left font-semibold">Project</th>
                <th className="px-4 py-3 text-left font-semibold">Category</th>
                <th className="px-4 py-3 text-right font-semibold">Project Value</th>
                <th className="px-4 py-3 text-center font-semibold">Required</th>
                <th className="px-4 py-3 text-center font-semibold">Actual</th>
                <th className="px-4 py-3 text-center font-semibold" title="On site (from PO) / target">Site Eng</th>
                <th className="px-4 py-3 text-center font-semibold" title="On site (from PO) / target">Jr. Site Eng</th>
                <th className="px-4 py-3 text-center font-semibold" title="On site (from PO) / target">Foreman</th>
                <th className="px-4 py-3 text-left font-semibold w-44">Coverage</th>
                <th className="px-4 py-3 text-center font-semibold">Gap</th>
                <th className="px-4 py-3 text-left font-semibold">Last DPR</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="11" className="text-center py-10 text-gray-400">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan="11" className="text-center py-10 text-gray-400">No projects found</td></tr>
              ) : filtered.map((r, i) => {
                const pct = coverage(r);
                const accent = r.gap > 0 ? 'border-l-red-400' : r.gap === 0 ? 'border-l-emerald-400' : 'border-l-blue-400';
                return (
                  <tr key={i} className={`border-b border-gray-100 border-l-4 ${accent} ${i % 2 ? 'bg-gray-50/40' : 'bg-white'} hover:bg-blue-50/50 transition-colors`}>
                    <td className="px-4 py-2.5 font-medium text-gray-800">{r.project}</td>
                    <td className="px-4 py-2.5">
                      {editable ? (
                        <select
                          className={`select text-xs ${r.category === 'Handover' ? 'text-gray-500' : ''}`}
                          style={{ minWidth: '120px' }}
                          value={r.category || ''}
                          onChange={e => saveCategory(r, e.target.value)}>
                          <option value="">—</option>
                          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      ) : (
                        r.category
                          ? <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${r.category === 'Handover' ? 'bg-gray-100 text-gray-500' : r.category === 'Live' ? 'bg-emerald-100 text-emerald-700' : r.category === 'Service Team' ? 'bg-indigo-100 text-indigo-700' : 'bg-amber-100 text-amber-700'}`}>{r.category}</span>
                          : <span className="text-gray-300 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold text-gray-700 whitespace-nowrap" title={fmtMoney(r.value)}>{fmtShort(r.value)}</td>
                    <td className="px-4 py-2.5 text-center">
                      {r.is_handover ? (
                        <span className="text-gray-400 text-xs" title="Handover — no team required, no planning">—</span>
                      ) : editKey === ekey(r, 'manpower') ? (
                        <div className="inline-flex items-center gap-1">
                          <input type="number" min="0" autoFocus className="input text-xs text-center" style={{ width: '56px' }}
                            value={editVal} onChange={e => setEditVal(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') saveEdit(r, editVal); if (e.key === 'Escape') cancelEdit(); }} />
                          <button type="button" disabled={saving} onClick={() => saveEdit(r, editVal)} className="text-emerald-600 hover:text-emerald-800" title="Save"><FiCheckCircle size={16} /></button>
                          <button type="button" onClick={cancelEdit} className="text-gray-400 hover:text-gray-600 text-sm font-bold" title="Cancel">✕</button>
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-1">
                          <span
                            className={`inline-flex items-center justify-center min-w-[28px] h-6 px-1.5 rounded-md font-bold text-xs ${r.required_overridden ? 'bg-amber-100 text-amber-700' : 'bg-blue-50 text-blue-700'}`}
                            title={r.required_overridden ? `Manually set · auto would be ${r.required_auto}` : 'Auto from project value'}>
                            {r.required}
                          </span>
                          {editable && (
                            <button type="button" onClick={() => startEdit(r, 'manpower')} className="text-gray-300 hover:text-blue-600" title="Edit required manpower"><FiEdit2 size={12} /></button>
                          )}
                          {editable && r.required_overridden && (
                            <button type="button" onClick={() => saveEdit(r, '')} className="text-gray-300 hover:text-red-500 text-sm leading-none" title={`Reset to auto (${r.required_auto})`}>↺</button>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-center"><span className="inline-flex items-center justify-center min-w-[28px] h-6 px-1.5 rounded-md bg-emerald-50 text-emerald-700 font-bold text-xs">{r.actual}</span></td>
                    <td className="px-4 py-2.5 text-center">{renderEngCell(r, 'site_eng', 'se_actual', 'se_gap', 'se_names')}</td>
                    <td className="px-4 py-2.5 text-center">{renderEngCell(r, 'jr_site_eng', 'jr_actual', 'jr_gap', 'jr_names')}</td>
                    <td className="px-4 py-2.5 text-center">{renderEngCell(r, 'foreman', 'fm_actual', 'fm_gap', 'fm_names')}</td>
                    <td className="px-4 py-2.5">
                      {r.is_handover ? (
                        <span className="text-gray-300 text-xs">—</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden min-w-[56px]">
                            <div className={`h-full rounded-full ${barColor(pct)}`} style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-[10px] font-semibold text-gray-500 w-8 text-right">{pct}%</span>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-center whitespace-nowrap">
                      {r.is_handover
                        ? <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-gray-100 text-gray-500" title="Handover — no team required">No planning</span>
                        : r.gap > 0
                          ? <span className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-red-100 text-red-700">−{r.gap} short</span>
                          : r.gap === 0
                            ? <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-700">On target</span>
                            : <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-blue-100 text-blue-700">+{-r.gap} extra</span>}
                    </td>
                    <td className="px-4 py-2.5 text-xs whitespace-nowrap">
                      {r.last_dpr_date
                        ? <span className="text-gray-600">{fmtDpr(r.last_dpr_date)}</span>
                        : <span className="text-gray-300 italic">no DPR</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
