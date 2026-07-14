// ============================================================================
// CHAMPIONS LEAGUE — company-wide gamification leaderboard
// ----------------------------------------------------------------------------
// Ranks every employee on their Champions Score, which is built directly on
// the Performance (Scorecard) engine: each person is scored against THEIR OWN
// role template, so all roles compete fairly. 100 = hit your plan, higher =
// beat it. Month/Quarter/Year average the qualifying weeks. Teams = average
// of members. See GAMIFICATION.md for the full design.
// ============================================================================
import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { useUrlTab } from '../hooks/useUrlTab';
import { FaTrophy, FaMedal } from 'react-icons/fa';
import { FiUsers, FiZap, FiRefreshCw, FiAlertCircle, FiSettings, FiTrash2 } from 'react-icons/fi';

const PERIODS = [
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'quarter', label: 'Quarter' },
  { key: 'year', label: 'Year' },
];

// Colour the score: 100+ = on/above plan (green), down through amber to red.
const scoreColor = (s) => {
  if (s == null) return 'text-gray-400';
  if (s >= 100) return 'text-emerald-600';
  if (s >= 85) return 'text-lime-600';
  if (s >= 70) return 'text-amber-600';
  return 'text-red-500';
};
const barColor = (s) => {
  if (s == null) return 'bg-gray-300';
  if (s >= 100) return 'bg-emerald-500';
  if (s >= 85) return 'bg-lime-500';
  if (s >= 70) return 'bg-amber-500';
  return 'bg-red-500';
};
const medalColor = ['text-yellow-400', 'text-gray-400', 'text-amber-600'];

export default function Champions() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useUrlTab(['board', 'setup'], 'board');
  const [period, setPeriod] = useState('month');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [openTeam, setOpenTeam] = useState(null);   // expanded team roster on the board

  const load = useCallback(() => {
    setLoading(true);
    api.get(`/gamification/leaderboard?period=${period}`)
      .then(r => setData(r.data))
      .catch(err => toast.error(err.response?.data?.error || 'Failed to load leaderboard'))
      .finally(() => setLoading(false));
  }, [period]);

  useEffect(() => { load(); }, [load]);

  const admin = isAdmin();
  const indis = data?.individuals || [];
  const podium = indis.slice(0, 3);
  const rest = indis.slice(3);

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-yellow-400 to-amber-600 flex items-center justify-center text-white shadow">
            <FaTrophy size={22} />
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-800">{data?.league_name || 'Champions League'}</h1>
            <p className="text-xs text-gray-500">Fair play — everyone scored against their own role targets</p>
          </div>
        </div>
        <button onClick={load} className="text-gray-500 hover:text-gray-800 p-2 rounded-lg hover:bg-gray-100" title="Refresh">
          <FiRefreshCw className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-4 border-b border-gray-200">
        <TabBtn active={tab === 'board'} onClick={() => setTab('board')}>🏆 Leaderboard</TabBtn>
        {admin && <TabBtn active={tab === 'setup'} onClick={() => setTab('setup')}>⚙️ Teams & Setup</TabBtn>}
      </div>

      {tab === 'board' && (
        <>
          {/* Period switcher */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {PERIODS.map(p => (
              <button key={p.key} onClick={() => setPeriod(p.key)}
                className={`px-3.5 py-1.5 rounded-full text-sm font-medium transition ${
                  period === p.key ? 'bg-amber-500 text-white shadow' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {p.label}
              </button>
            ))}
            {data && <span className="text-sm text-gray-500 ml-1">{data.label}</span>}
          </div>

          {loading && !data ? (
            <div className="text-center py-16 text-gray-400">Loading…</div>
          ) : indis.length === 0 ? (
            <EmptyState />
          ) : (
            <>
              {/* Award banners */}
              <div className="grid sm:grid-cols-2 gap-3 mb-5">
                {data.award?.individual && (
                  <Banner emoji={data.award.individual.emoji} title={data.award.individual.title}
                    name={data.award.individual.name} score={data.award.individual.score}
                    sub={data.award.individual.role} />
                )}
                {data.award?.team && (
                  <Banner emoji={data.award.team.emoji} title={data.award.team.title}
                    name={data.award.team.name} score={data.award.team.score}
                    sub={`${data.award.team.qualified_count} players`} />
                )}
              </div>

              {/* Podium */}
              {podium.length > 0 && (
                <div className="grid grid-cols-3 gap-2 sm:gap-4 mb-6">
                  {[1, 0, 2].map(idx => {        // center the #1
                    const p = podium[idx];
                    if (!p) return <div key={idx} />;
                    const heights = ['h-28', 'h-36', 'h-24'];
                    return (
                      <div key={p.user_id} className="flex flex-col items-center justify-end">
                        <FaMedal className={`mb-1 ${medalColor[p.rank - 1] || 'text-gray-300'}`} size={idx === 0 ? 30 : 22} />
                        <div className="text-sm font-semibold text-gray-800 text-center leading-tight">{p.name}</div>
                        <div className={`text-2xl font-extrabold ${scoreColor(p.score)}`}>{p.score}</div>
                        <div className={`w-full ${heights[idx]} rounded-t-xl bg-gradient-to-t ${
                          p.rank === 1 ? 'from-yellow-200 to-yellow-50' : p.rank === 2 ? 'from-gray-200 to-gray-50' : 'from-amber-200 to-amber-50'}
                          border border-b-0 flex items-start justify-center pt-2`}>
                          <span className="text-lg font-bold text-gray-500">#{p.rank}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Full ranking */}
              {rest.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-6">
                  {rest.map(p => (
                    <Row key={p.user_id} p={p} />
                  ))}
                </div>
              )}

              {/* Teams */}
              {data.teams?.length > 0 && (
                <div className="mb-6">
                  <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-2">
                    <FiUsers /> Team Standings
                  </h2>
                  <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                    {data.teams.map(t => (
                      <div key={t.team_id} className="border-b border-gray-100 last:border-0">
                        <div className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50"
                          onClick={() => setOpenTeam(openTeam === t.team_id ? null : t.team_id)}>
                          <span className="w-7 text-center font-bold text-gray-400">{t.rank ? `#${t.rank}` : '–'}</span>
                          <div className="flex-1">
                            <div className="font-medium text-gray-800 flex items-center gap-1">{t.name}
                              <span className="text-gray-300 text-xs">{openTeam === t.team_id ? '▴' : '▾'}</span></div>
                            {t.motto && <div className="text-xs text-gray-400">{t.motto}</div>}
                          </div>
                          <span className="text-xs text-gray-400">{t.qualified_count}/{t.member_count} active</span>
                          <span className={`text-lg font-bold w-14 text-right ${scoreColor(t.score)}`}>{t.score ?? '–'}</span>
                        </div>
                        {openTeam === t.team_id && t.members?.length > 0 && (
                          <div className="bg-gray-50/60 px-4 pb-2">
                            {t.members.map(m => (
                              <div key={m.user_id} className="flex items-center gap-3 py-1 text-sm border-t border-gray-100 first:border-0">
                                <span className="w-7 text-center text-[11px] text-gray-400">{m.rank ? `#${m.rank}` : '—'}</span>
                                <span className="flex-1 text-gray-700">{m.name}</span>
                                <span className={`text-sm font-semibold w-14 text-right ${scoreColor(m.score)}`}>{m.score ?? '—'}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Not qualified note */}
              {data.not_qualified?.length > 0 && (
                <div className="text-xs text-gray-400 flex items-start gap-2">
                  <FiAlertCircle className="mt-0.5 shrink-0" />
                  <span>
                    {data.not_qualified.length} employee(s) had a scorecard but didn't reach the minimum
                    activity ({data.min_activity}) to qualify this period: {data.not_qualified.map(u => u.name).join(', ')}
                  </span>
                </div>
              )}
            </>
          )}
        </>
      )}

      {tab === 'setup' && admin && <Setup onChanged={load} />}
    </div>
  );
}

function TabBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
        active ? 'border-amber-500 text-amber-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
      {children}
    </button>
  );
}

function Banner({ emoji, title, name, score, sub }) {
  return (
    <div className="rounded-xl border border-amber-200 bg-gradient-to-r from-amber-50 to-yellow-50 px-4 py-3 flex items-center gap-3">
      <span className="text-3xl">{emoji}</span>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-amber-700 uppercase tracking-wide">{title}</div>
        <div className="font-bold text-gray-800 truncate">{name}</div>
        {sub && <div className="text-xs text-gray-500 truncate">{sub}</div>}
      </div>
      <div className="text-2xl font-extrabold text-amber-600">{score}</div>
    </div>
  );
}

function Row({ p }) {
  const pct = Math.max(4, Math.min(100, (p.score / 150) * 100));
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-100 last:border-0">
      <span className="w-7 text-center font-bold text-gray-400">#{p.rank}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-800 truncate">{p.name}</span>
          {p.team_name && <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{p.team_name}</span>}
        </div>
        <div className="h-1.5 mt-1 rounded-full bg-gray-100 overflow-hidden">
          <div className={`h-full rounded-full ${barColor(p.score)}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
      <span className="text-xs text-gray-400 hidden sm:block w-20 text-right">{p.weeks_counted} wk{p.weeks_counted === 1 ? '' : 's'}</span>
      <span className={`text-lg font-bold w-12 text-right ${scoreColor(p.score)}`}>{p.score}</span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="text-center py-16 px-4">
      <FaTrophy className="mx-auto text-gray-200 mb-3" size={48} />
      <p className="text-gray-500 font-medium">No ranked players for this period yet</p>
      <p className="text-sm text-gray-400 mt-1 max-w-md mx-auto">
        Players appear here once they have a Performance scorecard with activity. Assign role
        templates under <span className="font-medium">HRMS → Performance</span>, then come back.
      </p>
    </div>
  );
}

// ---- Admin: teams + config -------------------------------------------------
function Setup({ onChanged }) {
  const [teams, setTeams] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [count, setCount] = useState(4);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(null);   // { userId, fromTeamId } while dragging a player card

  const loadAll = useCallback(() => {
    api.get('/gamification/teams').then(r => setTeams(r.data)).catch(() => {});
    api.get('/gamification/config').then(r => setCfg(r.data)).catch(() => {});
  }, []);
  useEffect(() => { loadAll(); }, [loadAll]);

  const autoBalance = () => {
    if (!window.confirm(`This replaces all current teams with ${count} freshly balanced pods. Continue?`)) return;
    setBusy(true);
    api.post('/gamification/teams/auto-balance', { count })
      .then(r => { toast.success(r.data.message); loadAll(); onChanged?.(); })
      .catch(err => toast.error(err.response?.data?.error || 'Failed'))
      .finally(() => setBusy(false));
  };

  const saveCfg = () => {
    api.put('/gamification/config', { min_activity: cfg.min_activity, league_name: cfg.league_name })
      .then(() => { toast.success('Saved'); onChanged?.(); })
      .catch(err => toast.error(err.response?.data?.error || 'Failed'));
  };

  const removeMember = (teamId, userId) => {
    api.delete(`/gamification/teams/${teamId}/members/${userId}`).then(() => { loadAll(); onChanged?.(); });
  };
  const addMember = (teamId, userId) => {
    if (!userId) return;
    api.post(`/gamification/teams/${teamId}/members`, { user_id: +userId }).then(() => { loadAll(); onChanged?.(); });
  };
  const createTeam = () => {
    const name = window.prompt('Team name:');
    if (!name || !name.trim()) return;
    api.post('/gamification/teams', { name: name.trim() }).then(() => { loadAll(); onChanged?.(); })
      .catch(err => toast.error(err.response?.data?.error || 'Failed to create team'));
  };
  const deleteTeam = (id) => {
    if (!window.confirm('Delete this team? Its members move back to Unassigned.')) return;
    api.delete(`/gamification/teams/${id}`).then(() => { loadAll(); onChanged?.(); })
      .catch(err => toast.error(err.response?.data?.error || 'Failed to delete team'));
  };
  // Drag a player card onto a column. Drop on a team → assign/move (user is
  // unique, so it moves out of any old pod). Drop on Unassigned → remove.
  const dropTo = async (targetTeamId) => {
    const d = drag; setDrag(null);
    if (!d || d.fromTeamId === targetTeamId) return;
    try {
      if (targetTeamId == null) {
        if (d.fromTeamId != null) await api.delete(`/gamification/teams/${d.fromTeamId}/members/${d.userId}`);
      } else {
        await api.post(`/gamification/teams/${targetTeamId}/members`, { user_id: d.userId });
      }
      loadAll(); onChanged?.();
    } catch (err) { toast.error(err.response?.data?.error || 'Move failed'); }
  };

  return (
    <div className="space-y-6">
      {/* Config */}
      {cfg && (
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <h3 className="font-semibold text-gray-700 mb-3 flex items-center gap-2"><FiSettings /> Settings</h3>
          <div className="grid sm:grid-cols-2 gap-4">
            <label className="block">
              <span className="text-sm text-gray-600">League name</span>
              <input className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" value={cfg.league_name || ''}
                onChange={e => setCfg({ ...cfg, league_name: e.target.value })} />
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Min. activity to qualify a week</span>
              <input type="number" min="0" className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" value={cfg.min_activity || '0'}
                onChange={e => setCfg({ ...cfg, min_activity: e.target.value })} />
            </label>
          </div>
          <button onClick={saveCfg} className="mt-3 px-4 py-2 bg-amber-500 text-white rounded-lg text-sm font-medium hover:bg-amber-600">Save settings</button>
        </div>
      )}

      {/* Auto-balance */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <h3 className="font-semibold text-gray-700 mb-1 flex items-center gap-2"><FiZap /> Auto-balance teams</h3>
        <p className="text-sm text-gray-500 mb-3">
          Splits every scorable employee into balanced pods using a snake draft on current scores —
          so each team gets a comparable mix of strong and developing players.
        </p>
        <div className="flex items-center gap-3">
          <label className="text-sm text-gray-600">Number of teams</label>
          <input type="number" min="2" max="10" value={count} onChange={e => setCount(+e.target.value)}
            className="w-20 border rounded-lg px-3 py-2 text-sm" />
          <button disabled={busy} onClick={autoBalance}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
            {busy ? 'Balancing…' : 'Generate balanced teams'}
          </button>
        </div>
      </div>

      {/* Teams — kanban board (drag players between pods) */}
      {teams && (() => {
        const columns = [
          { id: null, name: 'Unassigned', members: (teams.unassigned || []).map(u => ({ user_id: u.id, name: u.name, role: u.role, department: u.department })) },
          ...teams.teams,
        ];
        return (
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold text-gray-700 flex items-center gap-2"><FiUsers /> Teams — drag players between pods</h3>
              <button onClick={createTeam} className="text-sm text-indigo-600 hover:underline font-medium">+ Add team</button>
            </div>
            <div className="flex gap-3 overflow-x-auto pb-2">
              {columns.map(col => (
                <div key={col.id ?? 'unassigned'}
                  onDragOver={e => e.preventDefault()} onDrop={() => dropTo(col.id)}
                  className={`flex-shrink-0 w-56 rounded-xl border p-2 transition-colors ${col.id == null ? 'bg-gray-50 border-gray-200' : 'bg-amber-50/40 border-amber-200'}`}>
                  <div className="flex items-center justify-between px-1 mb-2">
                    <span className="text-sm font-semibold text-gray-700">{col.name} <span className="text-xs font-normal text-gray-400">({col.members.length})</span></span>
                    {col.id != null && <button onClick={() => deleteTeam(col.id)} className="text-gray-300 hover:text-red-500 text-xs" title="Delete team"><FiTrash2 size={13} /></button>}
                  </div>
                  <div className="space-y-1.5 min-h-[48px]">
                    {col.members.map(m => (
                      <div key={m.user_id} draggable
                        onDragStart={() => setDrag({ userId: m.user_id, fromTeamId: col.id })}
                        onDragEnd={() => setDrag(null)}
                        className="bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs shadow-sm cursor-grab active:cursor-grabbing hover:border-amber-300">
                        <div className="font-medium text-gray-800 truncate">{m.name}</div>
                        {(m.department || m.role) && <div className="text-[10px] text-gray-400 truncate">{m.department || m.role}</div>}
                      </div>
                    ))}
                    {col.members.length === 0 && <div className="text-[11px] text-gray-300 text-center py-3 border border-dashed border-gray-200 rounded-lg">drop here</div>}
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-gray-400 mt-2">Drag a player card onto a team to assign or move them; drag to <b>Unassigned</b> to remove from a pod.</p>
          </div>
        );
      })()}
    </div>
  );
}
