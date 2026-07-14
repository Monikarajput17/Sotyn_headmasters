import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiTarget, FiShoppingCart, FiTool, FiAlertCircle, FiUsers, FiCheckSquare, FiUpload, FiClock, FiAlertTriangle, FiExternalLink, FiCalendar, FiHelpCircle, FiTrendingUp } from 'react-icons/fi';
import { LuIndianRupee } from 'react-icons/lu';
import ErpMantraBanner from '../components/ErpMantraBanner';
import { fmtDate } from '../utils/datetime';

export default function Dashboard() {
  const { isAdmin, user } = useAuth();
  const [stats, setStats] = useState(null);
  const [perf, setPerf] = useState(null);
  const [teams, setTeams] = useState(null);   // team weekly performance (admin)
  const [myTasks, setMyTasks] = useState([]);
  const [todayChecklists, setTodayChecklists] = useState([]);
  const [myTickets, setMyTickets] = useState({ active: 0, recent: [] });
  const [myAttendance, setMyAttendance] = useState(null);
  const [uploadingFor, setUploadingFor] = useState(null); // id of the checklist/task currently uploading

  const loadPersonal = () => {
    api.get('/delegations?scope=mine').then(r => setMyTasks(r.data)).catch(() => setMyTasks([]));
    api.get('/hr/checklists/my-today').then(r => setTodayChecklists(r.data)).catch(() => setTodayChecklists([]));
    // Support tickets assigned to me — open + in_progress ones
    api.get('/support/mine').then(r => setMyTickets(r.data || { active: 0, recent: [] })).catch(() => setMyTickets({ active: 0, recent: [] }));
    // Current month's attendance summary — only relevant for regular users
    // who actually punch in/out. Admin doesn't personally punch attendance
    // (they monitor everyone's), so skip the API call to avoid the noisy
    // "18 absent" figure that mam flagged.
    if (!isAdmin()) {
      api.get('/attendance/my-month').then(r => setMyAttendance(r.data)).catch(() => setMyAttendance(null));
    }
  };

  useEffect(() => {
    api.get('/dashboard').then(r => setStats(r.data));
    loadPersonal();
    // Team performance this week — auto-scored live from Sotyn.Headmasters activity. Admin-only
    // (endpoint is scoring-gated); non-admins just don't see the panel.
    if (isAdmin()) {
      api.get('/scoring/weekly').then(r => setPerf(r.data)).catch(() => setPerf(null));
      api.get('/gamification/teams').then(r => setTeams(r.data)).catch(() => setTeams(null));
    }
  }, []);

  // Shared proof-upload helper: POST /upload then return the URL
  const uploadProof = async (file) => {
    const fd = new FormData(); fd.append('file', file);
    const res = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    return res.data.url;
  };

  const completeChecklist = async (cl, file) => {
    setUploadingFor('cl-' + cl.id);
    try {
      const url = await uploadProof(file);
      await api.post(`/hr/checklists/${cl.id}/complete`, { proof_url: url });
      toast.success(`${cl.title} marked complete`);
      loadPersonal();
    } catch (err) { toast.error(err.response?.data?.error || 'Upload failed'); }
    setUploadingFor(null);
  };

  const submitDelegationProof = async (task, file) => {
    setUploadingFor('del-' + task.id);
    try {
      const url = await uploadProof(file);
      await api.post(`/delegations/${task.id}/submit`, { proof_url: url });
      toast.success('Proof submitted — awaiting approval');
      loadPersonal();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
    setUploadingFor(null);
  };

  if (!stats) return <div className="text-center py-10">Loading...</div>;

  const myPendingTasks = myTasks.filter(t => t.status === 'pending' || t.status === 'rejected');
  const pendingChecklists = todayChecklists.filter(c => !c.completion_id);
  const doneChecklists = todayChecklists.filter(c => c.completion_id);

  // Mam (2026-05-22): the 8 colour-coded KPI tiles (Total Leads /
  // Won Deals / Active Orders / Installations / Open Complaints /
  // Employees / Pending Expenses / Candidates) were removed from the
  // top of the dashboard.  Each module already has its own page +
  // filters that give richer detail than a single number, and the
  // tiles were duplicating those numbers without adding value.
  // The drill-down was a nice-to-have but mam asked to clear the
  // visual noise.  Kept the data fetcher intact (no schema change)
  // in case we want to bring them back behind an admin toggle later.

  const hr = new Date().getHours();
  const greeting = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="space-y-6">
      {/* Greeting + today's date — a warm personal header (mam 2026-07-01:
          "make dashboard attractive"). */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-2xl font-extrabold text-gray-800 tracking-tight">
            {greeting}, {(user?.name || 'there').split(' ')[0]} <span className="align-middle">👋</span>
          </h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        </div>
      </div>

      {/* Daily Sotyn.Headmasters-culture mantra — rotates by day-of-year so the whole
          team sees the same quote in their morning standup. */}
      <ErpMantraBanner />

      {/* Team Performance — This Week. Auto-scored live from Sotyn.Headmasters activity
          (mam 2026-07-01: "show performance current week also automatic").
          Admin-only, hidden when there's no data. */}
      {isAdmin() && perf?.users?.length > 0 && (() => {
        const ranked = perf.users;
        const top = ranked.slice(0, 8);
        const medal = (i) => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`);
        const bar = (s) => (s >= 80 ? 'from-emerald-400 to-emerald-600' : s >= 50 ? 'from-amber-400 to-amber-500' : 'from-rose-400 to-rose-500');
        const av = ['bg-indigo-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-sky-500', 'bg-violet-500', 'bg-teal-500', 'bg-orange-500'];
        const scoreByUser = {};
        // Keep the raw achievement % UNCAPPED so beating plan shows a positive
        // variance (e.g. 132 → +32%), matching the Scorecard page; only the bar
        // WIDTH is clamped to 100 further down.
        ranked.forEach(u => { scoreByUser[u.user_id] = Math.max(0, Math.round(u.score || 0)); });
        // Display scores as VARIANCE vs plan (achievement − 100): on plan reads 0%,
        // behind reads negative, ahead reads +ve (mam 2026-07-04: "performance in
        // negative"). Bars, medals, sort + the Champions engine stay on the raw
        // achievement % — this only rewrites the number shown.
        const vsPlan = (n) => { const v = n - 100; return `${v > 0 ? '+' : ''}${v}%`; };
        const teamRows = (teams?.teams || []).map(t => {
          const members = (t.members || [])
            .map(m => ({ user_id: m.user_id, name: m.name, score: scoreByUser[m.user_id] ?? null }))
            .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || String(a.name || '').localeCompare(String(b.name || '')));
          const scored = members.filter(m => m.score != null);
          const avg = scored.length ? Math.round(scored.reduce((s, m) => s + m.score, 0) / scored.length) : null;
          return { id: t.id, name: t.name, motto: t.motto, members, avg };
        }).sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1));
        const hasTeams = teamRows.some(t => t.members.length > 0);
        const teamAvgVals = teamRows.flatMap(t => t.members.map(m => m.score || 0)); // TEAM AVG = average of all individual scores, blanks as 0
        const headerAvg = hasTeams
          ? (teamAvgVals.length ? Math.round(teamAvgVals.reduce((a, b) => a + b, 0) / teamAvgVals.length) : 0)
          : Math.round(ranked.reduce((a, u) => a + (u.score || 0), 0) / ranked.length);
        return (
          <div className="rounded-2xl shadow-sm border border-gray-100 overflow-hidden bg-white">
            <div className="bg-gradient-to-r from-indigo-600 via-indigo-500 to-red-500 px-5 py-4 flex items-center justify-between">
              <div className="flex items-center gap-2.5 text-white">
                <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center"><FiTrendingUp size={20} /></div>
                <div>
                  <h3 className="font-bold text-lg leading-tight">Performance — This Week</h3>
                  <p className="text-[11px] text-white/80">Auto-scored from Sotyn.Headmasters · {fmtDate(perf.week_start)} – {fmtDate(perf.week_end)}{hasTeams ? ` · ${teamRows.length} teams` : ''}</p>
                </div>
              </div>
              <div className="text-right text-white">
                <div className="text-3xl font-extrabold leading-none">{headerAvg ? vsPlan(headerAvg) : '—'}</div>
                <div className="text-[10px] text-white/80 uppercase tracking-wide">team avg</div>
              </div>
            </div>
            {hasTeams ? (
              <div className="p-4 space-y-3">
                {teamRows.map((t, i) => {
                  const s = t.avg || 0;
                  return (
                    <div key={t.id} className="rounded-xl border border-gray-100 p-3">
                      <div className="flex items-center gap-3">
                        <div className="w-7 text-center text-sm font-bold text-gray-400 flex-shrink-0">{medal(i)}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-baseline gap-2">
                            <span className="font-bold text-sm text-gray-800 truncate">{t.name}{t.motto ? <span className="ml-1 text-[11px] font-normal text-gray-400">· {t.motto}</span> : null}</span>
                            <span className="text-sm font-extrabold text-gray-700 flex-shrink-0">{t.avg ? vsPlan(t.avg) : '—'}</span>
                          </div>
                          <div className="h-2 rounded-full bg-gray-100 overflow-hidden mt-1">
                            <div className={`h-full rounded-full bg-gradient-to-r ${bar(s)} transition-all duration-700`} style={{ width: `${Math.min(100, s)}%` }} />
                          </div>
                        </div>
                      </div>
                      <div className="mt-2 pl-10 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                        {t.members.map((m, mi) => {
                          const champ = mi < 3 && m.score > 0;
                          return (
                            <div key={m.user_id} className={`flex justify-between items-center gap-2 text-xs ${champ ? 'font-semibold' : ''}`}>
                              <span className="flex items-center gap-1.5 min-w-0">
                                <span className="w-4 text-center flex-shrink-0 text-[11px]">{champ ? medal(mi) : <span className="text-gray-300">{mi + 1}</span>}</span>
                                <span className={`truncate ${champ ? 'text-gray-800' : 'text-gray-600'}`}>{m.name}</span>
                              </span>
                              <span className={`flex-shrink-0 ${m.score != null ? (champ ? 'text-emerald-600' : 'text-gray-700') : 'text-gray-300'}`}>{m.score != null ? vsPlan(m.score) : '—'}</span>
                            </div>
                          );
                        })}
                        {t.members.length === 0 && <div className="text-[11px] text-gray-300">No members yet</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5">
                {top.map((u, i) => {
                  const raw = Math.max(0, Math.round(u.score || 0));
                  const s = Math.min(100, raw);
                  return (
                    <div key={u.user_id} className="flex items-center gap-3">
                      <div className="w-6 text-center text-sm font-bold text-gray-400">{medal(i)}</div>
                      <div className={`w-8 h-8 rounded-full ${av[i % av.length]} text-white flex items-center justify-center text-xs font-bold flex-shrink-0`}>{(u.name || '?').charAt(0).toUpperCase()}</div>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-baseline gap-2">
                          <span className="font-semibold text-sm text-gray-800 truncate">{u.name}</span>
                          <span className="text-sm font-bold text-gray-700 flex-shrink-0">{vsPlan(raw)}</span>
                        </div>
                        <div className="h-2 rounded-full bg-gray-100 overflow-hidden mt-1">
                          <div className={`h-full rounded-full bg-gradient-to-r ${bar(s)} transition-all duration-700`} style={{ width: `${Math.min(100, s)}%` }} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="px-4 pb-3 pt-1 flex justify-between items-center border-t border-gray-50">
              <span className="text-[11px] text-gray-400">Updates automatically as work is logged in the Sotyn.Headmasters — no manual entry.</span>
              <Link to="/scorecard" className="text-xs text-indigo-600 hover:underline font-semibold whitespace-nowrap">Full Scorecard →</Link>
            </div>
          </div>
        );
      })()}

      {/* This Month's Attendance — hidden for admin (they don't personally
          punch in/out; they monitor everyone via the Attendance page). Only
          regular users see this card so the "absent" count reflects actual
          missed punches. */}
      {!isAdmin() && myAttendance && (() => {
        const { days, summary, month } = myAttendance;
        const [yr, mo] = month.split('-');
        const monthLabel = new Date(+yr, +mo - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' });
        // Status → style for the day cells
        const cellStyle = (s) => {
          if (s === 'present') return 'bg-emerald-100 text-emerald-800';
          if (s === 'late') return 'bg-amber-100 text-amber-800';
          if (s === 'half_day') return 'bg-amber-50 text-amber-700 border border-amber-300';
          if (s === 'short_day') return 'bg-orange-100 text-orange-800';
          if (s === 'on_leave') return 'bg-blue-100 text-blue-700';
          if (s === 'absent') return 'bg-red-100 text-red-700';
          if (s === 'weekend') return 'bg-gray-100 text-gray-400';
          if (s === 'future') return 'bg-white text-gray-300 border border-gray-100';
          return 'bg-white text-gray-400';
        };
        // Prepend blank cells to align first day with its weekday column
        const firstDow = days.length ? days[0].dow : 0;
        const leadingBlanks = Array.from({ length: firstDow }, (_, i) => <div key={'b' + i} />);
        return (
          <div className="card">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-3">
              <h3 className="font-semibold text-gray-800 flex items-center gap-2"><FiCheckSquare className="text-red-600" /> My Attendance — {monthLabel}</h3>
              <Link to="/attendance" className="text-xs text-red-600 hover:underline">Open Attendance →</Link>
            </div>
            {/* Summary strip */}
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-3 text-center text-xs">
              <div className="bg-emerald-50 rounded p-2"><div className="font-bold text-emerald-700 text-lg">{summary.present}</div><div className="text-emerald-600">Present</div></div>
              <div className="bg-amber-50 rounded p-2"><div className="font-bold text-amber-700 text-lg">{summary.late}</div><div className="text-amber-600">Late</div></div>
              <div className="bg-orange-50 rounded p-2">
                <div className="font-bold text-orange-700 text-lg">
                  {summary.half_day + summary.short_day}
                  {summary.short_leave_count > 0 && (
                    <span className="text-[10px] font-normal text-orange-600 ml-1">+{summary.short_leave_count}sl</span>
                  )}
                </div>
                <div className="text-orange-600">Half/Short {summary.short_leave_hours > 0 && <span className="text-[9px]">({summary.short_leave_hours}h)</span>}</div>
              </div>
              <div className="bg-blue-50 rounded p-2"><div className="font-bold text-blue-700 text-lg">{summary.on_leave}</div><div className="text-blue-600">On Leave</div></div>
              <div className="bg-red-50 rounded p-2"><div className="font-bold text-red-700 text-lg">{summary.absent}</div><div className="text-red-600">Absent</div></div>
              <div className="bg-gray-50 rounded p-2"><div className="font-bold text-gray-700 text-lg">{summary.total_hours}</div><div className="text-gray-600">Total Hrs</div></div>
            </div>
            {/* Mini calendar — Sun..Sat header then 7-col day grid */}
            <div className="grid grid-cols-7 gap-1 text-center">
              {['S','M','T','W','T','F','S'].map((d, i) => (
                <div key={'h' + i} className="text-[10px] font-bold text-gray-400 uppercase py-1">{d}</div>
              ))}
              {leadingBlanks}
              {days.map(d => (
                <div key={d.date} title={`${d.date} · ${d.status.replace('_', ' ')}`}
                  className={`text-[11px] font-semibold rounded py-1.5 ${cellStyle(d.status)}`}>
                  {d.day}
                </div>
              ))}
            </div>
            <p className="text-[10px] text-gray-400 mt-2 text-center">
              Hover a date to see its status. Green = Present · Amber = Late · Blue = Leave · Red = Absent · Grey = Weekend / Future
            </p>
          </div>
        );
      })()}

      {/* Support tickets assigned to me — only shows when there are active ones,
          otherwise stays hidden to keep the dashboard clean. Clicking a ticket
          doesn't navigate (tickets live inside the floating help widget) but
          mam's people see the list + priority + who raised it at a glance. */}
      {myTickets.active > 0 && (
        <div className="card border-l-4 border-indigo-400 bg-indigo-50/30">
          <div className="flex justify-between items-center mb-2">
            <h3 className="font-semibold text-gray-800 flex items-center gap-2">
              <FiHelpCircle className="text-indigo-600" />
              Support Tickets Assigned to You
              <span className="text-xs font-normal text-indigo-600">({myTickets.active} active)</span>
            </h3>
            <span className="text-[11px] text-gray-400">Open the Help (?) button bottom-right to respond</span>
          </div>
          <div className="space-y-1.5">
            {myTickets.recent.map(t => {
              const pColor = t.priority === 'urgent' || t.priority === 'high' ? 'text-red-700 bg-red-100' : t.priority === 'medium' ? 'text-amber-700 bg-amber-100' : 'text-gray-600 bg-gray-100';
              return (
                <div key={t.id} className="bg-white border rounded-lg px-3 py-2 flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-[11px] font-bold text-red-600">{t.ticket_no}</span>
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${pColor}`}>{t.priority.toUpperCase()}</span>
                      {t.module && <span className="text-[10px] bg-red-50 text-red-700 px-1.5 py-0.5 rounded">{t.module}</span>}
                    </div>
                    <p className="text-sm font-medium text-gray-800 line-clamp-1 mt-0.5">{t.subject}</p>
                    <p className="text-[11px] text-gray-500">Raised by {t.user_name}</p>
                  </div>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold whitespace-nowrap ${t.status === 'in_progress' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>{t.status}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* My Tasks & Today's Checklists — always visible so users know where
          to upload proof even when nothing is pending. */}
      {(
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* My pending delegations */}
          <div className="card">
            <div className="flex justify-between items-center mb-3">
              <h3 className="font-semibold text-gray-800 flex items-center gap-2"><FiCheckSquare className="text-red-600" /> My Tasks <span className="text-xs font-normal text-gray-400">({myPendingTasks.length} pending)</span></h3>
              <Link to="/delegations" className="text-xs text-red-600 hover:underline">Open Delegations →</Link>
            </div>
            {myPendingTasks.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">No pending tasks — you're all caught up!</p>
            ) : (
              <div className="space-y-2">
                {myPendingTasks.slice(0, 5).map(t => (
                  <div key={t.id} className={`border rounded-lg p-2.5 ${t.status === 'rejected' ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-white'}`}>
                    <div className="flex justify-between items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm text-gray-800 line-clamp-2">{t.description || t.title}</p>
                        <div className="flex flex-wrap gap-2 text-[10px] text-gray-500 mt-0.5">
                          <span>by {t.assigned_by_name}</span>
                          {t.due_date && <span className="flex items-center gap-1"><FiClock size={10} /> {t.due_date}</span>}
                        </div>
                        {t.status === 'rejected' && t.reject_reason && (
                          <p className="text-[11px] text-red-700 mt-1 flex items-start gap-1"><FiAlertTriangle size={11} className="mt-0.5 flex-shrink-0" /> {t.reject_reason}</p>
                        )}
                        {t.extension_status === 'pending' && (
                          <p className="text-[11px] text-amber-700 mt-1 flex items-start gap-1"><FiCalendar size={11} className="mt-0.5 flex-shrink-0" /> Extension to {t.requested_due_date} — awaiting admin</p>
                        )}
                      </div>
                      <label className={`btn btn-primary text-[11px] px-2 py-1 flex items-center gap-1 cursor-pointer ${uploadingFor === 'del-' + t.id ? 'opacity-60 pointer-events-none' : ''}`}>
                        <FiUpload size={11} /> {uploadingFor === 'del-' + t.id ? '...' : 'Submit'}
                        <input type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx" className="hidden"
                          onChange={e => { const f = e.target.files[0]; if (f) submitDelegationProof(t, f); e.target.value = ''; }} />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Today's checklists */}
          <div className="card">
            <div className="flex justify-between items-center mb-3">
              <h3 className="font-semibold text-gray-800 flex items-center gap-2"><FiCheckSquare className="text-emerald-600" /> Today's Checklists <span className="text-xs font-normal text-gray-400">({pendingChecklists.length} pending, {doneChecklists.length} done)</span></h3>
              <Link to="/checklists" className="text-xs text-red-600 hover:underline">Manage →</Link>
            </div>
            {todayChecklists.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">No checklists due today.</p>
            ) : (
              <div className="space-y-2">
                {todayChecklists.slice(0, 6).map(c => (
                  <div key={c.id} className={`border rounded-lg p-2.5 ${c.completion_id ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200 bg-white'}`}>
                    <div className="flex justify-between items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <p className={`font-semibold text-sm ${c.completion_id ? 'text-emerald-800' : 'text-gray-800'} line-clamp-2`}>
                          {c.completion_id && '✓ '}{c.description || c.title}
                        </p>
                        <div className="flex flex-wrap gap-2 text-[10px] text-gray-500 mt-0.5">
                          <span className="uppercase">{c.frequency}</span>
                          {c.due_time && <span className="flex items-center gap-1 font-mono"><FiClock size={10} /> {c.due_time}</span>}
                          {c.completion_id && c.proof_url && <a href={c.proof_url} target="_blank" rel="noreferrer" className="text-red-600 hover:underline flex items-center gap-1"><FiExternalLink size={10} /> proof</a>}
                        </div>
                      </div>
                      {!c.completion_id && (
                        <label className={`btn btn-success text-[11px] px-2 py-1 flex items-center gap-1 cursor-pointer ${uploadingFor === 'cl-' + c.id ? 'opacity-60 pointer-events-none' : ''}`}>
                          <FiUpload size={11} /> {uploadingFor === 'cl-' + c.id ? '...' : 'Upload Proof'}
                          <input type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx" className="hidden"
                            onChange={e => { const f = e.target.files[0]; if (f) completeChecklist(c, f); e.target.value = ''; }} />
                        </label>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* (Widget block now always rendered — the matching ) closes here) */}

      {/* Recent Data */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="font-semibold text-gray-800 mb-4 flex items-center gap-2"><span className="w-7 h-7 rounded-lg bg-red-50 text-red-600 flex items-center justify-center"><FiTarget size={15} /></span> Recent Leads</h3>
          <div className="overflow-x-auto">
            <table>
              <thead><tr><th>Company</th><th>Status</th><th>Date</th></tr></thead>
              <tbody>
                {stats.recentLeads.map(l => (
                  <tr key={l.id}>
                    <td className="font-medium">{l.company_name}</td>
                    <td><StatusBadge status={l.status} /></td>
                    <td className="text-gray-500">{fmtDate(l.created_at)}</td>
                  </tr>
                ))}
                {stats.recentLeads.length === 0 && <tr><td colSpan="3" className="text-center text-gray-400 py-4">No leads yet</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <h3 className="font-semibold text-gray-800 mb-4 flex items-center gap-2"><span className="w-7 h-7 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center"><FiShoppingCart size={15} /></span> Recent Orders</h3>
          <div className="overflow-x-auto">
            <table>
              <thead><tr><th>PO Number</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {stats.recentOrders.map(o => (
                  <tr key={o.id}>
                    <td className="font-medium">{o.po_number}</td>
                    <td>Rs {o.total_amount?.toLocaleString()}</td>
                    <td><StatusBadge status={o.status} /></td>
                  </tr>
                ))}
                {stats.recentOrders.length === 0 && <tr><td colSpan="3" className="text-center text-gray-400 py-4">No orders yet</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card lg:col-span-2">
          <h3 className="font-semibold text-gray-800 mb-4 flex items-center gap-2"><span className="w-7 h-7 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center"><FiAlertCircle size={15} /></span> Recent Complaints</h3>
          <div className="overflow-x-auto">
            <table>
              <thead><tr><th>Number</th><th>Description</th><th>Priority</th><th>Status</th></tr></thead>
              <tbody>
                {stats.recentComplaints.map(c => (
                  <tr key={c.id}>
                    <td className="font-medium">{c.complaint_number}</td>
                    <td className="max-w-[180px] sm:max-w-xs truncate">{c.description}</td>
                    <td><StatusBadge status={c.priority} /></td>
                    <td><StatusBadge status={c.status} /></td>
                  </tr>
                ))}
                {stats.recentComplaints.length === 0 && <tr><td colSpan="4" className="text-center text-gray-400 py-4">No complaints</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
