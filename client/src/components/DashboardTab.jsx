// HR Dashboard — top-of-page KPIs + small drill-down charts.
//
// Mam (2026-05-22 Phase 1 Batch C, module #14): 6 headline KPIs
// (open positions, candidates in pipeline, time-to-hire, offer
// acceptance %, joining status, pending interviews) + secondary
// charts (by stage, by source, eligibility breakdown).
//
// Lives as the FIRST tab inside /hr.  Defaults aren't changed —
// HR users still land on Candidates because that's their daily
// surface; this tab is for management's spot-checks.

import { useEffect, useState } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import {
  FiBriefcase, FiUsers, FiClock, FiCheckCircle, FiCalendar,
  FiUserCheck, FiRefreshCw, FiTrendingUp, FiPieChart,
} from 'react-icons/fi';

// Spec stage labels for the by-stage bar chart
const STAGE_LABEL = {
  lead:                 'Applied',
  called:               'Applied (Called)',
  interview_scheduled:  'Interview Scheduled',
  interview_done:       'Interview Done',
  qualified:            'Final Round',
  offer_sent:           'Offer Sent',
  accepted:             'Offer Accepted',
  onboarded:            'Onboarded',
  rejected:             'Rejected',
};
const STAGE_COLOR = {
  lead:                 'bg-blue-500',
  called:               'bg-blue-400',
  interview_scheduled:  'bg-indigo-500',
  interview_done:       'bg-amber-500',
  qualified:            'bg-purple-500',
  offer_sent:           'bg-cyan-500',
  accepted:             'bg-teal-500',
  onboarded:            'bg-emerald-600',
  rejected:             'bg-rose-500',
};

export default function DashboardTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/hr/dashboard');
      setData(r.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  if (loading && !data) return <div className="p-6 text-gray-500">Loading dashboard…</div>;
  if (!data) return <div className="p-6 text-red-700">No data</div>;

  const k = data.kpis || {};
  const tiles = [
    {
      label: 'Open Positions',
      value: k.open_positions,
      sub:   'Approved hiring requests',
      icon:  FiBriefcase,
      color: 'from-blue-500 to-blue-600',
    },
    {
      label: 'Candidates in Pipeline',
      value: k.candidates_in_pipeline,
      sub:   `+${k.new_this_month || 0} this month`,
      icon:  FiUsers,
      color: 'from-indigo-500 to-indigo-600',
    },
    {
      label: 'Time to Hire',
      value: k.time_to_hire_days != null ? `${k.time_to_hire_days}d` : '—',
      sub:   k.time_to_hire_days != null ? 'avg lead → onboarded' : 'No onboarded candidates yet',
      icon:  FiClock,
      color: 'from-amber-500 to-amber-600',
    },
    {
      label: 'Offer Acceptance Rate',
      value: k.offer_acceptance_rate != null ? `${k.offer_acceptance_rate}%` : '—',
      sub:   k.offer_acceptance_rate != null ? 'accepted ÷ offers sent' : 'No offers sent yet',
      icon:  FiCheckCircle,
      color: 'from-emerald-500 to-emerald-600',
    },
    {
      label: 'Joining Pending',
      value: k.joining_pending,
      sub:   `${k.joining_next_30 || 0} joining in next 30 days`,
      icon:  FiUserCheck,
      color: 'from-teal-500 to-teal-600',
    },
    {
      label: 'Pending Interviews',
      value: k.pending_interviews,
      sub:   'scheduled today or later',
      icon:  FiCalendar,
      color: 'from-purple-500 to-purple-600',
    },
  ];

  const elig = data.eligibility || {};
  const eligTotal = (elig.eligible || 0) + (elig.partial || 0) + (elig.rejected || 0) + (elig.not_screened || 0);

  // ── By-stage bar: longest bar = max count
  const stages = (data.by_stage || []).sort((a, b) => b.c - a.c);
  const maxStage = stages.reduce((m, s) => Math.max(m, s.c), 1);

  // ── By-source mini-pie
  const sources = data.by_source || [];
  const sourceTotal = sources.reduce((s, x) => s + x.c, 0);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div>
          <h3 className="font-semibold flex items-center gap-2"><FiTrendingUp /> HR Dashboard</h3>
          <p className="text-[11px] text-gray-500">Phase 1 KPIs at a glance · click any tile to drill into the relevant tab</p>
        </div>
        <button onClick={load} className="btn btn-secondary flex items-center gap-1.5 text-[12px]" disabled={loading}>
          <FiRefreshCw className={loading ? 'animate-spin' : ''} size={12}/> Refresh
        </button>
      </div>

      {/* ── 6 KPI tiles ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {tiles.map(t => {
          const Icon = t.icon;
          return (
            <div key={t.label} className={`bg-gradient-to-br ${t.color} text-white rounded-lg p-4 shadow-sm`}>
              <div className="flex items-start justify-between mb-2">
                <div className="text-[11px] uppercase tracking-wide opacity-90 font-semibold">{t.label}</div>
                <Icon size={18} className="opacity-80"/>
              </div>
              <div className="text-3xl font-bold leading-none">{t.value ?? '—'}</div>
              <div className="text-[10px] mt-1.5 opacity-90">{t.sub}</div>
            </div>
          );
        })}
      </div>

      {/* ── Secondary charts row ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* By-stage bar */}
        <div className="card p-4 lg:col-span-2">
          <h4 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
            <FiUsers size={14}/> Pipeline by Stage <span className="text-[10px] font-normal text-gray-400">(active only — On Hold excluded)</span>
          </h4>
          {stages.length === 0 ? (
            <p className="text-[12px] text-gray-400">No candidates yet</p>
          ) : (
            <div className="space-y-2">
              {stages.map(s => {
                const pct = Math.max(2, Math.round((s.c / maxStage) * 100));
                return (
                  <div key={s.status} className="flex items-center gap-2 text-[12px]">
                    <div className="w-32 text-gray-700">{STAGE_LABEL[s.status] || s.status}</div>
                    <div className="flex-1 bg-gray-100 rounded-full h-5 overflow-hidden">
                      <div className={`h-full ${STAGE_COLOR[s.status] || 'bg-gray-400'} text-white px-2 flex items-center text-[10px] font-bold`} style={{ width: `${pct}%` }}>
                        {s.c}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* By-source */}
        <div className="card p-4">
          <h4 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
            <FiPieChart size={14}/> Candidates by Source
          </h4>
          {sources.length === 0 ? (
            <p className="text-[12px] text-gray-400">No sourced candidates</p>
          ) : (
            <div className="space-y-1.5">
              {sources.map(s => {
                const pct = sourceTotal > 0 ? Math.round((s.c / sourceTotal) * 100) : 0;
                return (
                  <div key={s.source} className="text-[12px]">
                    <div className="flex justify-between mb-0.5">
                      <span className="capitalize text-gray-700">{s.source}</span>
                      <span className="text-gray-500">{s.c} · {pct}%</span>
                    </div>
                    <div className="bg-gray-100 rounded-full h-2 overflow-hidden">
                      <div className="h-full bg-blue-500" style={{ width: `${pct}%` }}/>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Eligibility breakdown (Batch C addition) ── */}
      <div className="card p-4">
        <h4 className="text-sm font-semibold mb-3">Screening / Eligibility</h4>
        {eligTotal === 0 ? (
          <p className="text-[12px] text-gray-400">No candidates have been screened yet</p>
        ) : (
          <div className="flex gap-2 flex-wrap">
            {[
              { k: 'eligible',     label: 'Eligible',     color: 'bg-emerald-500' },
              { k: 'partial',      label: 'Partial',      color: 'bg-amber-500' },
              { k: 'rejected',     label: 'Auto-rejected',color: 'bg-rose-500' },
              { k: 'not_screened', label: 'Not Screened', color: 'bg-gray-400' },
            ].map(s => {
              const c = elig[s.k] || 0;
              const pct = eligTotal > 0 ? Math.round((c / eligTotal) * 100) : 0;
              return (
                <div key={s.k} className="flex-1 min-w-[150px] border border-gray-200 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`w-3 h-3 rounded-full ${s.color}`} />
                    <span className="text-[12px] font-semibold text-gray-700">{s.label}</span>
                  </div>
                  <div className="text-2xl font-bold">{c}</div>
                  <div className="text-[10px] text-gray-500">{pct}% of all candidates</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
