// Admin "Daily Activity / Word Count" dashboard.
//
// Pick a date (or range), see how many characters each user typed into the Sotyn.Headmasters that
// day, broken down by user, by module, and by action. Powered by
// /api/admin/word-count which walks the audit_log body_summary.
//
// Use case: mam tracks how much real data-entry work each employee did.

import { useState, useEffect } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { FiBarChart2, FiCalendar, FiRefreshCw, FiUser, FiPackage, FiAlertCircle, FiX, FiEye, FiShield } from 'react-icons/fi';
import { fmtTime } from '../../utils/datetime';

// Reduce a long UA string to a short "Chrome on Windows" style hint so
// the IP/device column stays readable.  Falls back to first 30 chars
// of the raw UA if no known browser/OS keywords match.
function shortUa(ua) {
  if (!ua) return '—';
  const s = ua.toLowerCase();
  let browser = '?';
  if (s.includes('edg/')) browser = 'Edge';
  else if (s.includes('chrome')) browser = 'Chrome';
  else if (s.includes('firefox')) browser = 'Firefox';
  else if (s.includes('safari')) browser = 'Safari';
  let os = '';
  if (s.includes('android')) os = 'Android';
  else if (s.includes('iphone') || s.includes('ipad')) os = 'iOS';
  else if (s.includes('windows')) os = 'Windows';
  else if (s.includes('mac os')) os = 'macOS';
  else if (s.includes('linux')) os = 'Linux';
  return os ? `${browser} · ${os}` : browser;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

const ACTION_COLORS = {
  CREATE: 'bg-emerald-100 text-emerald-700',
  UPDATE: 'bg-blue-100 text-blue-700',
  DELETE: 'bg-red-100 text-red-700',
};

// Friendly module labels — keep in sync with the sidebar in Layout.jsx so
// mam recognises each row at a glance ("BOQ & Quotations" instead of
// "quotations", "DPR" instead of "dpr", etc.). Anything not in the map
// falls back to the raw entity_type with hyphens/underscores prettified.
const MODULE_LABELS = {
  dpr: 'DPR',
  quotations: 'BOQ & Quotations',
  'business-book': 'Business Book',
  'item-master': 'Item Master',
  'pms-tasks': 'PMS Tasks',
  'payment-required': 'Payment Required',
  'indent-fms': 'Indent FMS',
  procurement: 'Indent to Dispatch',
  complaints: 'Complaints',
  leads: 'Leads / CRM',
  vendors: 'Vendors',
  customers: 'Customers',
  orders: 'Orders & Planning',
  installation: 'Installation',
  billing: 'Billing',
  hr: 'HR & Hiring',
  employees: 'Employees',
  expenses: 'Expenses',
  attendance: 'Attendance',
  collections: 'Collection Engine',
  cashflow: 'Cash Flow',
  delegations: 'Delegations',
  checklists: 'Checklists',
  auth: 'Login / Account',
  admin: 'Admin Settings',
};
const moduleLabel = (m) => MODULE_LABELS[m] || String(m || '—').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

export default function WordCount() {
  const [date, setDate] = useState(todayIso());
  const [dateTo, setDateTo] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [drillUser, setDrillUser] = useState(null); // { user_id, user_name }
  const [detail, setDetail] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  // Verify-user panel — when the admin suspects an attribution problem
  // (e.g. "this user entered rows before their account was created"),
  // pull the actual users row + audit summary + login history so the
  // facts are visible without DB access.  Mam, 2026-05-15.
  const [verify, setVerify] = useState(null);
  const openVerify = async (userId) => {
    setVerify({ loading: true });
    try {
      const r = await api.get(`/admin/word-count/user-check/${userId}`);
      setVerify({ ...r.data, loading: false });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Verify failed');
      setVerify(null);
    }
  };
  // Changelog — what new systems/features were created in the Sotyn.Headmasters
  // on the picked date, sourced from git log on the deployed repo.
  const [changelog, setChangelog] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (dateTo && dateTo !== date) {
        params.set('date_from', date);
        params.set('date_to', dateTo);
      } else {
        params.set('date', date);
      }
      const r = await api.get(`/admin/word-count?${params.toString()}`);
      setData(r.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load');
    }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [date, dateTo]);

  // Pull the changelog (git log) for the same date range so MD can
  // see exactly what new modules / features / fixes shipped that day.
  useEffect(() => {
    const params = new URLSearchParams();
    params.set('date', date);
    if (dateTo && dateTo !== date) params.set('date_to', dateTo);
    api.get(`/admin/changelog?${params.toString()}`)
      .then(r => setChangelog(r.data))
      .catch(() => setChangelog(null));
  }, [date, dateTo]);

  const openDrill = async (u) => {
    setDrillUser(u);
    setDetailLoading(true);
    try {
      const params = new URLSearchParams();
      if (dateTo && dateTo !== date) {
        params.set('date_from', date); params.set('date_to', dateTo);
      } else {
        params.set('date', date);
      }
      params.set('user_id', u.user_id);
      const r = await api.get(`/admin/word-count/detail?${params.toString()}`);
      setDetail(r.data || []);
    } catch (err) {
      toast.error('Failed to load details');
      setDetail([]);
    }
    setDetailLoading(false);
  };

  const fmtNum = (n) => (n || 0).toLocaleString('en-IN');

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h3 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <FiBarChart2 className="text-red-600" /> Daily Activity
          </h3>
          <p className="text-sm text-gray-500">
            Pick a date to see the total characters typed across the entire Sotyn.Headmasters that day (e.g. typing "monika" = 6 characters), with breakdowns by user and module.
          </p>
        </div>
        <button onClick={load} disabled={loading} className="btn btn-secondary flex items-center gap-2">
          <FiRefreshCw className={loading ? 'animate-spin' : ''} size={14} /> Refresh
        </button>
      </div>

      {/* Date picker */}
      <div className="card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <div>
            <label className="label flex items-center gap-1"><FiCalendar size={12} /> Date</label>
            <input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div>
            <label className="label">To (optional, for range)</label>
            <input type="date" className="input" value={dateTo} onChange={e => setDateTo(e.target.value)} min={date} />
            {dateTo && <button onClick={() => setDateTo('')} className="text-[11px] text-red-600 hover:underline mt-1">Clear range</button>}
          </div>
          <div className="text-xs text-gray-500 sm:text-right">
            {dateTo && dateTo !== date
              ? <>Showing <span className="font-semibold">{date}</span> to <span className="font-semibold">{dateTo}</span></>
              : <>Showing single day: <span className="font-semibold">{date}</span></>}
          </div>
        </div>
      </div>

      {/* Hero card — MD wants "total characters for selected date" as
          the headline number ("monika" = 6).  Royal-blue brand
          (mam, 2026-05-20: "this shows red" — was red gradient,
          now matches the rest of the brand). */}
      {data && (
        <div className="card p-6 bg-gradient-to-br from-blue-700 via-blue-800 to-blue-950 text-white shadow-lg">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-widest text-blue-100/80 font-semibold">Total Characters Entered</div>
              <div className="text-[11px] text-blue-100/70 mt-0.5">
                {dateTo && dateTo !== date ? `${date} → ${dateTo}` : date}
              </div>
            </div>
            <div className="text-5xl sm:text-6xl font-extrabold tracking-tight tabular-nums">
              {fmtNum(data.total_chars)}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 mt-5 pt-4 border-t border-white/20">
            <div>
              <div className="text-[10px] uppercase text-blue-100/70 font-semibold">Entries</div>
              <div className="text-xl font-bold mt-0.5">{fmtNum(data.total_activities)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-blue-100/70 font-semibold">Active Users</div>
              <div className="text-xl font-bold mt-0.5">{data.by_user.filter(u => u.activities > 0).length}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-blue-100/70 font-semibold">Modules Used</div>
              <div className="text-xl font-bold mt-0.5">{data.by_module.length}</div>
            </div>
          </div>
        </div>
      )}

      {/* Caveat banner if any rows were truncated */}
      {data && data.truncated_activities > 0 && (
        <div className="card p-3 bg-amber-50 border-l-4 border-amber-400 flex items-start gap-2 text-xs text-amber-900">
          <FiAlertCircle className="mt-0.5 flex-shrink-0" />
          <div>
            <span className="font-semibold">{data.truncated_activities}</span> activities had very large payloads that were
            truncated by the audit log (2000-char cap), so their word count is a lower bound.
          </div>
        </div>
      )}

      {/* What's NEW in the Sotyn.Headmasters — git log for the same date range. Shows
          MD which new modules / features / fixes shipped each day so he
          can review at a glance. Auto-pulled, no manual upkeep. */}
      {changelog && changelog.commits && changelog.commits.length > 0 && (
        <div className="card p-0 overflow-hidden border-l-4 border-emerald-500">
          <div className="px-4 py-3 border-b bg-gradient-to-r from-emerald-50 to-blue-50 flex items-center justify-between">
            <div>
              <h4 className="font-semibold text-gray-800 flex items-center gap-2">
                ✨ What's New in Sotyn.Headmasters
                <span className="text-xs font-normal text-gray-500">— ({changelog.total} {changelog.total === 1 ? 'change' : 'changes'} {changelog.since !== changelog.until ? `${changelog.since} → ${changelog.until}` : `on ${changelog.since}`})</span>
              </h4>
              <p className="text-[11px] text-gray-500 mt-0.5">Auto-pulled from the deploy log so MD can review each day's shipped work.</p>
            </div>
            <div className="flex gap-3 text-xs">
              {changelog.by_type?.new > 0 && <span className="bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded font-bold">🆕 {changelog.by_type.new} New</span>}
              {changelog.by_type?.tweak > 0 && <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded font-bold">🔧 {changelog.by_type.tweak} Tweaks</span>}
              {changelog.by_type?.fix > 0 && <span className="bg-amber-100 text-amber-700 px-2 py-0.5 rounded font-bold">🛠️ {changelog.by_type.fix} Fixes</span>}
            </div>
          </div>
          <div className="divide-y max-h-[420px] overflow-y-auto">
            {changelog.commits.map(c => (
              <details key={c.hash} className="group">
                <summary className="cursor-pointer px-4 py-3 hover:bg-gray-50 flex items-start gap-3 list-none">
                  <span className="text-xl flex-shrink-0">{c.emoji}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                        c.type === 'new' ? 'bg-emerald-100 text-emerald-700' :
                        c.type === 'tweak' ? 'bg-blue-100 text-blue-700' :
                        c.type === 'fix' ? 'bg-amber-100 text-amber-700' :
                        c.type === 'doc' ? 'bg-purple-100 text-purple-700' :
                        'bg-gray-100 text-gray-600'
                      }`}>{c.label}</span>
                      <span className="text-[10px] text-gray-400 font-mono">{c.hash}</span>
                      <span className="text-[10px] text-gray-500">{c.time} · {c.author}</span>
                    </div>
                    <div className="font-semibold text-gray-800 mt-1 text-sm">{c.subject}</div>
                  </div>
                  {c.body && <span className="text-gray-400 text-xs flex-shrink-0">▸</span>}
                </summary>
                {c.body && (
                  <div className="px-12 pb-3 -mt-1 text-xs text-gray-600 whitespace-pre-wrap leading-relaxed">{c.body}</div>
                )}
              </details>
            ))}
          </div>
        </div>
      )}
      {changelog && changelog.commits && changelog.commits.length === 0 && (
        <div className="card p-3 bg-gray-50 border-l-4 border-gray-300 text-xs text-gray-600">
          ✨ No new Sotyn.Headmasters features shipped on this date. Pick another date or expand the range.
        </div>
      )}

      {/* Two-column: by user (left) + by module (right) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* By user */}
        <div className="card p-0 overflow-hidden">
          <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
            <h4 className="font-semibold text-gray-700 flex items-center gap-2"><FiUser size={14} className="text-red-600" /> By User</h4>
            <span className="text-[11px] text-gray-400">click a row for details</span>
          </div>
          <div className="overflow-x-auto">
            <table className="text-sm w-full">
              <thead className="bg-gray-50/60">
                <tr>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase">User</th>
                  <th className="text-right px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase">Characters</th>
                  <th className="text-right px-3 py-2 text-[11px] font-semibold text-gray-400 uppercase">Entries</th>
                </tr>
              </thead>
              <tbody>
                {(data?.by_user || []).slice().sort((a, b) => b.chars - a.chars).map(u => (
                  <tr
                    key={u.user_id || u.user_name}
                    onClick={() => u.user_id && openDrill(u)}
                    className="border-t hover:bg-red-50/40 cursor-pointer"
                  >
                    <td className="px-3 py-2 font-medium text-gray-800">{u.user_name}</td>
                    <td className="px-3 py-2 text-right font-bold text-red-700 text-base tabular-nums">{fmtNum(u.chars)}</td>
                    <td className="px-3 py-2 text-right text-gray-500 text-xs">{fmtNum(u.activities)}</td>
                  </tr>
                ))}
                {data && data.by_user.length === 0 && (
                  <tr><td colSpan="3" className="text-center py-8 text-gray-400 text-sm">No activity on this date</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* By module */}
        <div className="card p-0 overflow-hidden">
          <div className="px-4 py-3 border-b bg-gray-50">
            <h4 className="font-semibold text-gray-700 flex items-center gap-2"><FiPackage size={14} className="text-red-600" /> By Module</h4>
          </div>
          <div className="overflow-x-auto">
            <table className="text-sm w-full">
              <thead className="bg-gray-50/60">
                <tr>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase">Module</th>
                  <th className="text-right px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase">Characters</th>
                  <th className="text-right px-3 py-2 text-[11px] font-semibold text-gray-400 uppercase">Entries</th>
                </tr>
              </thead>
              <tbody>
                {(data?.by_module || []).slice().sort((a, b) => b.chars - a.chars).map(m => (
                  <tr key={m.module} className="border-t hover:bg-gray-50">
                    <td className="px-3 py-2 text-gray-800">{moduleLabel(m.module)}</td>
                    <td className="px-3 py-2 text-right font-bold text-red-700 text-base tabular-nums">{fmtNum(m.chars)}</td>
                    <td className="px-3 py-2 text-right text-gray-500 text-xs">{fmtNum(m.activities)}</td>
                  </tr>
                ))}
                {data && data.by_module.length === 0 && (
                  <tr><td colSpan="3" className="text-center py-8 text-gray-400 text-sm">—</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* By action breakdown — small pill row */}
      {data && data.by_action.length > 0 && (
        <div className="card p-4">
          <div className="text-[11px] font-semibold text-gray-500 uppercase mb-2">By Action</div>
          <div className="flex flex-wrap gap-2">
            {data.by_action.map(a => (
              <div key={a.action} className={`px-3 py-1.5 rounded-lg text-xs ${ACTION_COLORS[a.action] || 'bg-gray-100 text-gray-700'}`}>
                <span className="font-semibold">{a.action}</span>
                <span className="ml-2">{fmtNum(a.chars)} characters</span>
                <span className="ml-1 opacity-60">/ {fmtNum(a.activities)} entries</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Drill-down modal — what a single user typed on this day */}
      {drillUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={() => setDrillUser(null)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b flex items-center justify-between">
              <div>
                <h3 className="font-bold text-gray-800 flex items-center gap-2">
                  <FiEye className="text-red-600" /> {drillUser.user_name} — what they entered
                </h3>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  {dateTo && dateTo !== date ? `${date} to ${dateTo}` : date} ·
                  <span className="font-semibold text-red-700"> {fmtNum(drillUser.chars)} characters</span> · {fmtNum(drillUser.activities)} entries
                </p>
              </div>
              <div className="flex items-center gap-2">
                {/* Verify user — opens a side panel with the user's account
                    facts (created_at, role, active) plus IP/login history.
                    Use this when you suspect a row was logged under the
                    wrong user. */}
                {drillUser.user_id ? (
                  <button onClick={() => openVerify(drillUser.user_id)}
                    className="btn btn-secondary text-xs flex items-center gap-1"
                    title="Show account creation date, login history, and IP usage for this user">
                    <FiShield size={13} /> Verify user
                  </button>
                ) : null}
                <button onClick={() => setDrillUser(null)} className="p-1 text-gray-400 hover:text-gray-700"><FiX size={18} /></button>
              </div>
            </div>
            <div className="overflow-y-auto p-4">
              {detailLoading ? (
                <div className="text-center text-gray-400 py-12 text-sm">Loading...</div>
              ) : detail.length === 0 ? (
                <div className="text-center text-gray-400 py-12 text-sm">No activity</div>
              ) : (
                <>
                {/* Burst-detector summary (mam, 2026-05-16: "how can it
                    possible" — 8 checklists in 4 minutes).  Counts how
                    many actions had <60s gap from the previous.  Surfaces
                    the count + the largest burst window so suspicious
                    rapid-fire patterns are visible without scrolling. */}
                {(() => {
                  let rapidCount = 0;
                  let curRun = 1, longestRun = 1, longestRunModule = '';
                  for (let i = detail.length - 2; i >= 0; i--) {
                    const gap = (new Date(detail[i].at) - new Date(detail[i + 1].at)) / 1000;
                    if (gap < 60) {
                      rapidCount++;
                      curRun++;
                      if (curRun > longestRun) { longestRun = curRun; longestRunModule = detail[i].module || ''; }
                    } else {
                      curRun = 1;
                    }
                  }
                  if (rapidCount === 0) return null;
                  return (
                    <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded text-[11px] text-red-800 flex items-center justify-between">
                      <div>
                        ⚠ <strong>{rapidCount}</strong> rapid-fire action{rapidCount === 1 ? '' : 's'} (&lt;60s gap){longestRun >= 3 ? <> · longest streak: <strong>{longestRun} actions</strong> on <code className="bg-red-100 px-1">{longestRunModule || 'mixed'}</code></> : null}
                      </div>
                      <span className="text-[10px] text-red-600">batch-click or automation pattern</span>
                    </div>
                  );
                })()}
                <table className="text-xs w-full">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="text-left px-2 py-2 text-gray-500 uppercase font-semibold w-24" title="Full date+time on hover for each row">Time</th>
                      {/* Δ Gap — time since the previous action.  Mam
                          (2026-05-16): "how can it possible" looking at
                          8 checklists in 4 minutes.  Red <60s = suspiciously
                          fast (rubber-stamp / batch click-through), amber
                          1-5 min, green >5 min normal.  Helps spot bot/
                          spoofing patterns at a glance. */}
                      <th className="text-left px-2 py-2 text-gray-500 uppercase font-semibold w-16" title="Time between this action and the previous one">Δ Gap</th>
                      <th className="text-left px-2 py-2 text-gray-500 uppercase font-semibold w-20">Action</th>
                      <th className="text-left px-2 py-2 text-gray-500 uppercase font-semibold">Module</th>
                      <th className="text-left px-2 py-2 text-gray-500 uppercase font-semibold">Entry</th>
                      {/* IP + device columns — investigate who ACTUALLY made
                          the entry. Mam, 2026-05-15.  If 66 entries share
                          one IP that differs from the user's usual IP, that
                          IP belongs to whoever was actually using the
                          session. */}
                      <th className="text-left px-2 py-2 text-gray-500 uppercase font-semibold w-28" title="IP address the request came from">IP</th>
                      <th className="text-left px-2 py-2 text-gray-500 uppercase font-semibold w-32" title="Browser + OS as reported by the device">Device</th>
                      <th className="text-right px-2 py-2 text-gray-500 uppercase font-semibold w-16">Chars</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.map((d, idx) => {
                      // Compute gap from the previous (newer-listed)
                      // entry.  detail is ordered newest-first, so
                      // detail[idx + 1] is the action that came
                      // BEFORE the current row chronologically.
                      const prev = detail[idx + 1];
                      const gapSec = prev ? Math.round((new Date(d.at) - new Date(prev.at)) / 1000) : null;
                      const gapLabel = gapSec == null ? '—'
                        : gapSec < 60 ? `${gapSec}s`
                        : gapSec < 3600 ? `${Math.round(gapSec / 60)}m`
                        : gapSec < 86400 ? `${Math.round(gapSec / 3600)}h`
                        : `${Math.round(gapSec / 86400)}d`;
                      const gapClass = gapSec == null ? 'text-gray-300'
                        : gapSec < 60 ? 'text-red-700 font-bold bg-red-50'
                        : gapSec < 300 ? 'text-amber-700 font-semibold bg-amber-50'
                        : 'text-gray-500';
                      return (
                      <tr key={d.id} className="border-t hover:bg-gray-50">
                        <td className="px-2 py-1.5 text-gray-500 font-mono text-[11px]" title={`${d.at} (UTC)`}>
                          {/* Mam (2026-05-16): "it showing wrong time" — the
                              audit log stores UTC timestamps but the previous
                              render used the BROWSER's local timezone.  On
                              VPS machines (or browsers stuck on UTC) that
                              showed UTC time, not IST.  Explicit timeZone
                              forces Asia/Kolkata (+5:30) regardless of where
                              the user is browsing from. */}
                          {fmtTime(d.at, { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}
                        </td>
                        <td className={`px-2 py-1.5 font-mono text-[11px] text-center ${gapClass}`} title={gapSec == null ? 'First action in window' : `${gapSec} seconds since previous action`}>
                          {gapLabel}
                        </td>
                        <td className="px-2 py-1.5">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] ${ACTION_COLORS[d.action] || 'bg-gray-100 text-gray-700'}`}>{d.action}</span>
                        </td>
                        <td className="px-2 py-1.5 capitalize">{String(d.module || '—').replace(/_/g, ' ').replace(/-/g, ' ')}</td>
                        <td className="px-2 py-1.5 text-gray-600 truncate max-w-[220px]" title={d.body_preview || d.entity_label || d.path}>
                          {d.entity_label || d.path || '—'}
                        </td>
                        <td className="px-2 py-1.5 text-gray-600 font-mono text-[11px]" title={d.ip || ''}>{d.ip || '—'}</td>
                        <td className="px-2 py-1.5 text-gray-600 text-[11px] truncate max-w-[160px]" title={d.user_agent || ''}>{shortUa(d.user_agent)}</td>
                        <td className="px-2 py-1.5 text-right font-semibold text-red-700">{fmtNum(d.chars)}{d.truncated && <span title="truncated" className="text-amber-500">*</span>}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Verify-user diagnostic panel — opens on top of the activity
          modal, shows the actual users row + audit timeline + login
          history so admin can confirm whether a "user did action X
          before their account was created" complaint is a real bug
          or just a misread timestamp / shared-session scenario. */}
      {verify && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-start justify-center p-4 overflow-y-auto" onClick={() => setVerify(null)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full mt-12" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b flex items-center justify-between">
              <h3 className="font-bold text-gray-800 flex items-center gap-2">
                <FiShield className="text-emerald-600" /> User account check
              </h3>
              <button onClick={() => setVerify(null)} className="p-1 text-gray-400 hover:text-gray-700"><FiX size={18} /></button>
            </div>
            <div className="p-5 space-y-5 text-sm">
              {verify.loading && <div className="text-center text-gray-400 py-6">Loading…</div>}
              {!verify.loading && !verify.user && (
                <div className="text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
                  No users row with this id. The audit_log entries reference a deleted user — that's likely the source of the attribution confusion.
                </div>
              )}
              {!verify.loading && verify.user && (
                <>
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div className="bg-gray-50 rounded-lg p-3">
                      <div className="text-gray-500 uppercase text-[10px] mb-1">Account row</div>
                      <div className="font-semibold text-gray-800">{verify.user.name}</div>
                      <div className="text-gray-600">id={verify.user.id} · role={verify.user.role} · {verify.user.active ? 'active' : 'inactive'}</div>
                      <div className="text-gray-600">{verify.user.email}{verify.user.username ? ` · @${verify.user.username}` : ''}</div>
                      <div className="text-gray-600 mt-2"><b>Created at:</b> <span className="font-mono">{verify.user.created_at}</span></div>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3">
                      <div className="text-gray-500 uppercase text-[10px] mb-1">Audit footprint</div>
                      <div>Total actions: <b>{fmtNum(verify.audit?.total)}</b></div>
                      <div>First action: <span className="font-mono">{verify.audit?.first_action || '—'}</span></div>
                      <div>Last action: <span className="font-mono">{verify.audit?.last_action || '—'}</span></div>
                      <div>Distinct IPs: <b>{verify.audit?.distinct_ips}</b> · Active days: <b>{verify.audit?.active_days}</b></div>
                    </div>
                  </div>

                  {verify.audit?.first_action && verify.user.created_at &&
                    new Date(verify.audit.first_action) < new Date(verify.user.created_at) && (
                    <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-xs text-amber-900">
                      ⚠ <b>First audit action is BEFORE the account's created_at.</b>
                      This means either (a) the account row was inserted via the DB / a different code path that didn't set <code>created_at</code> at row birth, OR (b) the row was deleted and reinserted, OR (c) someone else used a still-valid JWT after the user was renamed. Look at the IP / device columns in the activity table to identify who actually used the session.
                    </div>
                  )}

                  <div>
                    <div className="font-semibold text-gray-700 mb-1 text-xs">IPs that used this account</div>
                    <table className="text-xs w-full">
                      <thead className="bg-gray-50"><tr>
                        <th className="text-left px-2 py-1">IP</th>
                        <th className="text-right px-2 py-1">Actions</th>
                        <th className="text-left px-2 py-1">First</th>
                        <th className="text-left px-2 py-1">Last</th>
                      </tr></thead>
                      <tbody>
                        {(verify.ips || []).map(i => (
                          <tr key={i.ip} className="border-t">
                            <td className="px-2 py-1 font-mono">{i.ip}</td>
                            <td className="px-2 py-1 text-right">{fmtNum(i.c)}</td>
                            <td className="px-2 py-1 font-mono text-[11px]">{i.first_seen}</td>
                            <td className="px-2 py-1 font-mono text-[11px]">{i.last_seen}</td>
                          </tr>
                        ))}
                        {(!verify.ips || verify.ips.length === 0) && <tr><td colSpan="4" className="text-center text-gray-400 py-3">No IP data recorded</td></tr>}
                      </tbody>
                    </table>
                  </div>

                  <div>
                    <div className="font-semibold text-gray-700 mb-1 text-xs">Recent logins (last 30)</div>
                    <table className="text-xs w-full">
                      <thead className="bg-gray-50"><tr>
                        <th className="text-left px-2 py-1">When</th>
                        <th className="text-left px-2 py-1">Action</th>
                        <th className="text-left px-2 py-1">IP</th>
                        <th className="text-left px-2 py-1">Device</th>
                      </tr></thead>
                      <tbody>
                        {(verify.logins || []).map((l, i) => (
                          <tr key={i} className="border-t">
                            <td className="px-2 py-1 font-mono text-[11px]">{l.at}</td>
                            <td className="px-2 py-1"><span className={`px-1.5 py-0.5 rounded text-[10px] ${l.action === 'LOGIN' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>{l.action}</span></td>
                            <td className="px-2 py-1 font-mono">{l.ip || '—'}</td>
                            <td className="px-2 py-1 text-[11px]" title={l.user_agent}>{shortUa(l.user_agent)}</td>
                          </tr>
                        ))}
                        {(!verify.logins || verify.logins.length === 0) && <tr><td colSpan="4" className="text-center text-gray-400 py-3">No login records yet</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
