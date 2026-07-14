// MD Collections Dashboard — one screen so MD can answer
// "where are we still spending effort but not getting paid?"
//
// Per site: target / received / outstanding / oldest ageing /
// CRM follow-up activity (PMS tasks raised, GPS pings to the site
// in last 7 days, last follow-up date, next planned date,
// last discussion). Sorted by outstanding so the worst lands on top.
//
// "Silent overdue" callout flags sites where outstanding > 0 AND
// ageing > 30 days AND there's been zero PMS tasks + zero site
// visits in last 7 days — i.e. nobody is chasing.

import { useEffect, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { FiRefreshCw, FiAlertTriangle, FiMapPin, FiPhoneCall, FiBarChart2, FiCalendar, FiUser } from 'react-icons/fi';
import { LuIndianRupee } from 'react-icons/lu';

const fmtL = (n) => 'Rs ' + ((+n || 0) / 100000).toFixed(2) + 'L';
const fmtN = (n) => (+n || 0).toLocaleString('en-IN');

export default function CollectionsMD() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showOnlySilent, setShowOnlySilent] = useState(false);

  const load = () => {
    setLoading(true);
    api.get('/collections/md-dashboard')
      .then(r => setData(r.data))
      .catch((err) => { toast.error(err.response?.data?.error || 'Failed'); setData(null); })
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  if (loading) return <div className="p-8 text-center text-gray-400">Loading MD Dashboard…</div>;
  if (!data) return <div className="p-8 text-center text-gray-400">No data</div>;

  const sitesShown = showOnlySilent
    ? data.sites.filter(s => +s.outstanding > 0 && +s.oldest_ageing > 30 && +s.pms_tasks_count === 0 && +s.location_pings_7d === 0)
    : data.sites;

  const isSilent = (s) => +s.outstanding > 0 && +s.oldest_ageing > 30 && +s.pms_tasks_count === 0 && +s.location_pings_7d === 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-3">
        <div>
          <h3 className="text-xl font-bold text-gray-800 flex items-center gap-2"><FiBarChart2 className="text-red-600" /> MD Collections Dashboard</h3>
          <p className="text-sm text-gray-500">Each site at a glance: outstanding payment ↔ activity. Silent overdue sites flagged so nothing falls through the cracks.</p>
        </div>
        <button onClick={load} className="btn btn-secondary flex items-center gap-2"><FiRefreshCw size={14} /> Refresh</button>
      </div>

      {/* Hero — royal-blue brand (mam, 2026-05-20: "red here is also").
          Was from-red-600 via-red-700 to-red-900. */}
      <div className="card p-6 bg-gradient-to-br from-blue-700 via-blue-800 to-blue-950 text-white shadow-lg">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-blue-100/80 font-semibold">Sites</div>
            <div className="text-3xl font-extrabold mt-1">{fmtN(data.totals.sites)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-blue-100/80 font-semibold">Target Total</div>
            <div className="text-3xl font-extrabold mt-1">{fmtL(data.totals.target)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-emerald-100 font-semibold">Received</div>
            <div className="text-3xl font-extrabold mt-1">{fmtL(data.totals.received)}</div>
            <div className="text-[10px] text-blue-100/70">{data.totals.collection_pct}% collected</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-amber-100 font-semibold">Outstanding</div>
            <div className="text-3xl font-extrabold mt-1">{fmtL(data.totals.outstanding)}</div>
          </div>
        </div>
      </div>

      {/* Activity totals + silent overdue alert */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="card p-4 border-l-4 border-blue-500">
          <div className="text-[10px] uppercase text-gray-500 font-semibold">CRM Tasks</div>
          <div className="text-2xl font-bold text-gray-800 mt-0.5">{fmtN(data.totals.pms_tasks)}</div>
          <div className="text-[10px] text-gray-400">PMS follow-up tasks raised</div>
        </div>
        <div className="card p-4 border-l-4 border-purple-500">
          <div className="text-[10px] uppercase text-gray-500 font-semibold">Site Visits 7d</div>
          <div className="text-2xl font-bold text-gray-800 mt-0.5">{fmtN(data.totals.location_pings_7d)}</div>
          <div className="text-[10px] text-gray-400">GPS pings in last 7 days</div>
        </div>
        <div className="card p-4 border-l-4 border-orange-500">
          <div className="text-[10px] uppercase text-gray-500 font-semibold">Indents Raised</div>
          <div className="text-2xl font-bold text-gray-800 mt-0.5">{fmtN(data.totals.indents_count)}</div>
          <div className="text-[10px] text-gray-400">{fmtN(data.totals.indents_30d)} in last 30d · procurement load</div>
        </div>
        <div className="card p-4 border-l-4 border-teal-500">
          <div className="text-[10px] uppercase text-gray-500 font-semibold">Materials Sent</div>
          <div className="text-2xl font-bold text-gray-800 mt-0.5">{fmtL(data.totals.materials_value_sent)}</div>
          <div className="text-[10px] text-gray-400">Stock issued / delivered to sites</div>
        </div>
        <div
          className={`card p-4 border-l-4 ${data.silent_overdue_count > 0 ? 'border-red-500 cursor-pointer hover:bg-red-50/40' : 'border-emerald-500'}`}
          onClick={() => data.silent_overdue_count > 0 && setShowOnlySilent(s => !s)}
          title={data.silent_overdue_count > 0 ? 'Click to filter to these sites' : ''}
        >
          <div className="text-[10px] uppercase text-gray-500 font-semibold flex items-center gap-1">
            <FiAlertTriangle size={11} /> Silent Overdue Sites
          </div>
          <div className={`text-2xl font-bold mt-0.5 ${data.silent_overdue_count > 0 ? 'text-red-700' : 'text-emerald-700'}`}>
            {data.silent_overdue_count}
          </div>
          <div className="text-[10px] text-gray-400">
            {data.silent_overdue_count > 0
              ? 'Outstanding > 30d, no CRM activity & no site visits — needs urgent action'
              : 'Every overdue site has activity. Nothing slipping. ✓'}
          </div>
          {data.silent_overdue_count > 0 && (
            <div className="text-[10px] text-red-600 font-semibold mt-1">{showOnlySilent ? '✓ filter active — click to clear' : 'click to filter'}</div>
          )}
        </div>
      </div>

      {/* Per-site table */}
      <div className="card p-0 overflow-x-auto">
        <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
          <h4 className="font-semibold text-gray-700">Per-Site Activity vs Payment</h4>
          <span className="text-[11px] text-gray-400">{sitesShown.length} site{sitesShown.length === 1 ? '' : 's'}{showOnlySilent ? ' · silent overdue only' : ''}</span>
        </div>
        <table className="text-sm w-full">
          <thead className="bg-gray-50/60">
            <tr>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Site</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">CRM</th>
              <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Target</th>
              <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Received</th>
              <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Outstanding</th>
              <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Oldest Ageing</th>
              <th className="text-center px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">PMS Tasks</th>
              <th className="text-center px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Site Pings (7d)</th>
              <th className="text-center px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Indents</th>
              <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Materials Sent</th>
              <th className="text-center px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">DPR (30d)</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Last Follow-up / Discussion</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Next Planned</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Owner</th>
            </tr>
          </thead>
          <tbody>
            {sitesShown.length === 0 && (
              <tr><td colSpan="14" className="text-center py-8 text-gray-400 text-sm">{showOnlySilent ? 'No silent-overdue sites — well done!' : 'No receivables yet'}</td></tr>
            )}
            {sitesShown.map(s => {
              const silent = isSilent(s);
              const collectionPct = +s.target > 0 ? +(100 * +s.received / +s.target).toFixed(1) : 0;
              return (
                <tr key={s.site_name} className={`border-t ${silent ? 'bg-red-50/40' : 'hover:bg-gray-50'}`}>
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-800 flex items-center gap-1">
                      {silent && <FiAlertTriangle size={12} className="text-red-600" />}
                      {s.site_name}
                    </div>
                    <div className="text-[10px] text-gray-400">{s.invoice_count} invoice{s.invoice_count === 1 ? '' : 's'}</div>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600">{s.crm_name || <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtL(s.target)}</td>
                  <td className="px-3 py-2 text-right text-emerald-700 tabular-nums">
                    {fmtL(s.received)}
                    <div className="text-[10px] text-gray-400">{collectionPct}%</div>
                  </td>
                  <td className="px-3 py-2 text-right text-red-700 font-bold tabular-nums">{fmtL(s.outstanding)}</td>
                  <td className="px-3 py-2 text-right">
                    <span className={`px-2 py-0.5 rounded text-[10px] ${
                      +s.oldest_ageing > 90 ? 'bg-red-100 text-red-800'
                      : +s.oldest_ageing > 60 ? 'bg-amber-100 text-amber-800'
                      : +s.oldest_ageing > 30 ? 'bg-yellow-100 text-yellow-800'
                      : 'bg-emerald-100 text-emerald-800'}`}>
                      {s.oldest_ageing || 0}d
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center">
                    {+s.pms_tasks_count > 0
                      ? <span className="px-2 py-0.5 rounded text-[11px] bg-blue-100 text-blue-700 font-semibold">{s.pms_tasks_count}</span>
                      : <span className="text-gray-300 text-xs">0</span>}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {+s.location_pings_7d > 0
                      ? <span className="px-2 py-0.5 rounded text-[11px] bg-purple-100 text-purple-700 font-semibold">{s.location_pings_7d}</span>
                      : <span className="text-gray-300 text-xs">0</span>}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {+s.indents_count > 0
                      ? (
                        <div>
                          <span className="px-2 py-0.5 rounded text-[11px] bg-orange-100 text-orange-800 font-semibold">{s.indents_count}</span>
                          {+s.indents_30d > 0 && <div className="text-[10px] text-orange-600 mt-0.5">{s.indents_30d} in 30d</div>}
                        </div>
                      )
                      : <span className="text-gray-300 text-xs">0</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-teal-700 font-semibold">
                    {+s.materials_value_sent > 0 ? fmtL(s.materials_value_sent) : <span className="text-gray-300 font-normal">—</span>}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {+s.dpr_count_30d > 0
                      ? <span className="px-2 py-0.5 rounded text-[11px] bg-indigo-100 text-indigo-700 font-semibold">{s.dpr_count_30d}</span>
                      : <span className="text-gray-300 text-xs">0</span>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {s.last_follow_up && <div className="text-gray-700"><FiPhoneCall className="inline mr-1" size={10} />{s.last_follow_up}</div>}
                    {s.last_discussion && (
                      <div className="text-amber-700 italic max-w-[220px] truncate" title={s.last_discussion}>💬 {s.last_discussion}</div>
                    )}
                    {!s.last_follow_up && !s.last_discussion && <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-700">
                    {s.next_planned_date
                      ? <span className="flex items-center gap-1"><FiCalendar size={10} />{s.next_planned_date}</span>
                      : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600">{s.owner_name || <span className="text-gray-300">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Footer hint */}
      <p className="text-[11px] text-gray-400 text-center">
        🔴 Silent overdue = outstanding &gt; 30 days, no PMS task raised, no site visit in last 7 days. Click any "Silent Overdue" card above to filter.
      </p>
    </div>
  );
}
