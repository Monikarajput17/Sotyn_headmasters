// Weekly Score Dashboard — basic v1
//   Shows last Mon-Sat (or any picked Mon) work-given vs work-done per
//   employee across Delegations, PMS Tasks, Checklists, Help Tickets.
//   Mam will iterate this with her full scoring template once she sees
//   the baseline.

import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import { FiTrendingUp, FiCalendar, FiChevronRight, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';

const MODULE_LABELS = {
  delegations: 'Delegations',
  pms: 'PMS Tasks',
  checklists: 'Checklists',
  tickets: 'Help Tickets',
};

// Find the most recent Monday (today if today is Mon)
const lastMonday = (offsetWeeks = 0) => {
  const d = new Date();
  const dow = d.getDay(); // 0=Sun
  const offset = dow === 0 ? -6 : (1 - dow);
  d.setDate(d.getDate() + offset - (offsetWeeks * 7));
  return d.toISOString().slice(0, 10);
};

// Default: previous completed Mon-Sat (if today is Mon, that's last week)
const defaultStart = () => {
  const d = new Date();
  const dow = d.getDay();
  const offset = dow === 0 ? -6 : (1 - dow);
  d.setDate(d.getDate() + offset);
  if (dow === 1) d.setDate(d.getDate() - 7); // today is Mon → last week
  return d.toISOString().slice(0, 10);
};

const fmtRange = (start, end) => {
  const s = new Date(start), e = new Date(end);
  const month = (m) => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m];
  return `${s.getDate()} ${month(s.getMonth())} – ${e.getDate()} ${month(e.getMonth())} ${e.getFullYear()}`;
};

const scoreColor = (s) => {
  if (s >= 80) return 'bg-emerald-100 text-emerald-700 border-emerald-300';
  if (s >= 60) return 'bg-blue-100 text-blue-700 border-blue-300';
  if (s >= 40) return 'bg-amber-100 text-amber-700 border-amber-300';
  return 'bg-red-100 text-red-700 border-red-300';
};

export default function WeeklyScore() {
  const [weekStart, setWeekStart] = useState(defaultStart());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [drill, setDrill] = useState(null); // { user, module, rows }

  const load = useCallback(() => {
    setLoading(true);
    api.get(`/scoring/weekly?week_start=${weekStart}`)
      .then(r => setData(r.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [weekStart]);

  useEffect(() => { load(); }, [load]);

  const openCell = async (user, moduleKey) => {
    try {
      const r = await api.get(`/scoring/weekly/detail?user_id=${user.user_id}&module=${moduleKey}&week_start=${weekStart}`);
      setDrill({ user, module: moduleKey, rows: r.data.rows || [], week_start: r.data.week_start, week_end: r.data.week_end });
    } catch {
      setDrill({ user, module: moduleKey, rows: [], error: 'Failed to load' });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FiTrendingUp className="text-indigo-600" /> Weekly Score
          </h1>
          <p className="text-sm text-gray-500">Mon-Sat work given vs done per employee. Click any cell to drill into the actual tasks.</p>
        </div>
      </div>

      <div className="card p-4 flex flex-wrap items-center gap-3">
        <FiCalendar className="text-gray-400" size={16} />
        <div>
          <label className="label">Week starting (Monday)</label>
          <input type="date" className="input" value={weekStart} onChange={e => setWeekStart(e.target.value)} />
        </div>
        <div className="flex gap-1">
          <button onClick={() => setWeekStart(lastMonday(1))} className="btn btn-secondary text-xs">Last Week</button>
          <button onClick={() => setWeekStart(lastMonday(0))} className="btn btn-secondary text-xs">This Week</button>
          <button onClick={() => setWeekStart(lastMonday(2))} className="btn btn-secondary text-xs">Two Weeks Ago</button>
        </div>
        {data && (
          <div className="ml-auto text-sm text-gray-700">
            <span className="font-semibold">{fmtRange(data.week_start, data.week_end)}</span> · {data.users?.length || 0} employees
          </div>
        )}
        {data?.users && (
          <button onClick={() => exportCsv(`weekly-score-${weekStart}`,
            ['Rank','Employee','Dept','Given','Done','Score %'],
            data.users.map((u, i) => [i + 1, u.name, u.department, u.given_total, u.done_total, u.score_pct]))}
            className="btn btn-secondary text-xs flex items-center gap-1"><FiDownload size={12} /> Export Excel</button>
        )}
      </div>

      <div className="card p-0">
        <table className="freeze-head">
          <thead>
            <tr>
              <th className="text-left">Rank</th>
              <th className="text-left">Employee</th>
              <th className="text-left">Dept</th>
              <th className="text-center" colSpan={2}>Delegations</th>
              <th className="text-center" colSpan={2}>PMS Tasks</th>
              <th className="text-center" colSpan={2}>Checklists</th>
              <th className="text-center" colSpan={2}>Help Tickets</th>
              <th className="text-center" colSpan={2}>Total</th>
              <th className="text-center">Score</th>
            </tr>
            <tr className="text-[10px] text-gray-500 uppercase">
              <th></th><th></th><th></th>
              <th>Given</th><th>Done</th>
              <th>Given</th><th>Done</th>
              <th>Given</th><th>Done</th>
              <th>Given</th><th>Done</th>
              <th>Given</th><th>Done</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan="14" className="text-center py-8 text-gray-400">Calculating…</td></tr>}
            {!loading && data?.users?.length === 0 && <tr><td colSpan="14" className="text-center py-8 text-gray-400">No employees</td></tr>}
            {!loading && data?.users?.map((u, i) => {
              const Cell = ({ given, done, moduleKey }) => (
                <>
                  <td className="text-center text-gray-600 cursor-pointer hover:bg-blue-50" onClick={() => openCell(u, moduleKey)}>
                    {given || '-'}
                  </td>
                  <td className={`text-center font-semibold cursor-pointer hover:bg-emerald-50 ${done > 0 ? 'text-emerald-700' : 'text-gray-400'}`} onClick={() => openCell(u, moduleKey)}>
                    {done || '-'}
                  </td>
                </>
              );
              return (
                <tr key={u.user_id}>
                  <td className="text-gray-400 font-bold">#{i + 1}</td>
                  <td className="font-medium">{u.name}</td>
                  <td className="text-xs text-gray-500">{u.department || u.role}</td>
                  <Cell given={u.delegations.given} done={u.delegations.done} moduleKey="delegations" />
                  <Cell given={u.pms.given} done={u.pms.done} moduleKey="pms" />
                  <Cell given={u.checklists.given} done={u.checklists.done} moduleKey="checklists" />
                  <Cell given={u.tickets.given} done={u.tickets.done} moduleKey="tickets" />
                  <td className="text-center text-gray-600">{u.total_given}</td>
                  <td className="text-center font-bold text-emerald-700">{u.total_done}</td>
                  <td className="text-center">
                    <span className={`px-2 py-1 rounded-full text-xs font-bold border ${scoreColor(u.score)}`}>
                      {u.score}%
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Drill-down modal */}
      <Modal
        isOpen={!!drill}
        onClose={() => setDrill(null)}
        title={drill ? `${drill.user.name} — ${MODULE_LABELS[drill.module]} (${drill.rows?.length || 0})` : ''}
        wide
      >
        {drill && (
          <div className="max-h-[70vh] overflow-y-auto space-y-2">
            {drill.error && <div className="text-red-600 text-sm">{drill.error}</div>}
            {!drill.error && drill.rows.length === 0 && (
              <div className="text-center py-8 text-gray-400 text-sm">
                No {MODULE_LABELS[drill.module]?.toLowerCase()} found in this week.
              </div>
            )}
            {drill.rows.map(r => (
              <div key={r.id} className="border rounded p-3 bg-gray-50 hover:bg-white transition">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    {drill.module === 'tickets' && (
                      <div className="text-xs text-red-600 font-bold">{r.ticket_no}</div>
                    )}
                    <div className="font-semibold text-sm">{r.title || r.subject || '-'}</div>
                    {r.description && <div className="text-xs text-gray-600 line-clamp-2 mt-0.5">{r.description}</div>}
                    {r.project_name && <div className="text-[10px] text-blue-600 mt-0.5">📁 {r.project_name}</div>}
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded font-bold whitespace-nowrap ${
                    r.status === 'approved' || r.status === 'resolved' || r.status === 'closed' ? 'bg-emerald-100 text-emerald-700' :
                    r.status === 'rejected' ? 'bg-red-100 text-red-700' :
                    r.status === 'submitted' || r.status === 'in_progress' ? 'bg-blue-100 text-blue-700' :
                    'bg-gray-100 text-gray-600'
                  }`}>{r.status || (drill.module === 'checklists' ? 'completed' : '-')}</span>
                </div>
                <div className="flex flex-wrap gap-3 text-[10px] text-gray-500 mt-1">
                  {r.assigned_by_name && <span>by {r.assigned_by_name}</span>}
                  {r.raised_by_name && <span>raised by {r.raised_by_name}</span>}
                  {r.due_date && <span>due {r.due_date}</span>}
                  {r.date && <span>📅 {r.date}</span>}
                  {r.created_at && <span>created {String(r.created_at).split('T')[0]}</span>}
                  {r.priority && <span>{r.priority}</span>}
                  {r.proof_url && <a href={r.proof_url} target="_blank" rel="noreferrer" className="text-blue-600 underline">📎 proof</a>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
