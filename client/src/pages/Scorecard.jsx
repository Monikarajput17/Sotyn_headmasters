// Per-employee MIS scorecard matching the SEPL Google Sheet format mam
// shared on 2026-05-04. Three tabs:
//   - My Scorecard  : current user's MIS for the picked week, editable
//   - Team Overview : all employees' weekly score (existing dashboard)
//   - Templates     : admin manages KPI templates per role
//   - Assign        : admin maps each user to a template

import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiTrendingUp, FiCalendar, FiEdit2, FiSave, FiUsers, FiSettings, FiPlus, FiTrash2, FiUser, FiDownload, FiTarget } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
} from 'recharts';

// ── Scorecard display convention (mam 2026-07-04): show performance as the
// VARIANCE vs plan — achievement% − 100.  So hitting 100% of plan reads 0%,
// falling short reads negative (DPR 68% → −32%), beating plan reads positive.
// The server/engine keep the raw achievement % (higher-better) so the Champions
// League leaderboard and War Room rankings are unaffected — this transform is
// display-only, applied uniformly to every % the Scorecard page renders.
const vsPlan = (pct) => (pct == null ? null : Math.round(pct) - 100);
const fmtVs = (pct) => { const v = vsPlan(pct); return v == null ? null : `${v > 0 ? '+' : ''}${v}%`; };
const vsClr = (pct) => {
  const v = vsPlan(pct);
  if (v == null) return 'text-gray-300';
  return v >= 0 ? 'text-emerald-700' : v >= -50 ? 'text-amber-700' : 'text-red-700';
};

// For values ALREADY expressed as variance-vs-plan (the commitment convention:
// 0 = on plan, negative = behind).  Colour + signed label without the −100 shift.
const varClr = (v) => v == null ? 'text-gray-400' : v >= 0 ? 'text-emerald-700' : v >= -50 ? 'text-amber-700' : 'text-red-700';
const fmtVar = (v) => v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`;
const fmtShort = (start) => {
  const d = new Date(start + 'T00:00:00');
  const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  return `${d.getDate()} ${month}`;
};

const lastMonday = (offsetWeeks = 0) => {
  const d = new Date();
  const dow = d.getDay();
  const offset = dow === 0 ? -6 : (1 - dow);
  d.setDate(d.getDate() + offset - (offsetWeeks * 7));
  return d.toISOString().slice(0, 10);
};

const fmtRange = (start) => {
  const s = new Date(start), e = new Date(start);
  e.setDate(s.getDate() + 5);
  const month = (m) => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m];
  return `${s.getDate()} ${month(s.getMonth())} – ${e.getDate()} ${month(e.getMonth())} ${e.getFullYear()}`;
};

const scorePill = (s) => {
  if (s == null) return 'bg-gray-100 text-gray-500';
  if (s >= 0) return 'bg-emerald-100 text-emerald-700';
  if (s >= -25) return 'bg-blue-100 text-blue-700';
  if (s >= -50) return 'bg-amber-100 text-amber-700';
  return 'bg-red-100 text-red-700';
};

// Mam (2026-06-02): "how plan actual say in template that pick from
// here".  For every auto:* source, this map explains in plain English
// which DB field feeds the Plan (target) and which feeds the Actual
// (achievement) for the scoring period.  Rendered as a small chip
// under the source dropdown so the admin doesn't have to guess what
// each abbreviated source name means.  Keep keys identical to the
// `value` attributes on the <option> elements in the source dropdown.
const SOURCE_INFO = {
  manual:                       { plan: 'You set (Target column)',           actual: 'You enter weekly in the scorecard' },
  // Tasks & Tickets — Plan = items assigned this week, Actual = items completed
  'auto:delegations':           { plan: 'Delegations assigned to user',       actual: 'Delegations completed (status=approved)' },
  'auto:pms':                   { plan: 'PMS tasks assigned to user',         actual: 'PMS tasks completed (status=approved)' },
  'auto:checklists':            { plan: 'Active checklists × 6 days',         actual: 'Checklist completions by user' },
  'auto:tickets':               { plan: 'Help tickets assigned to user',      actual: 'Tickets resolved / closed by user' },
  'auto:activity_log':          { plan: 'You set',                            actual: 'Create/update/delete actions the user logged this week (audit trail)' },
  // Responsibility (RACI / SLA) — cross-module accountability from the "Responsible" tabs
  'auto:pms_all':               { plan: 'ALL PMS tasks assigned this week (company-wide)', actual: 'ALL PMS tasks done this week (company-wide)' },
  'auto:delegations_all':       { plan: 'ALL delegations assigned this week (company-wide)', actual: 'ALL delegations done this week (company-wide)' },
  'auto:tickets_all':           { plan: 'ALL help tickets raised this week (company-wide)', actual: 'ALL tickets resolved this week (company-wide)' },
  'auto:erp_module_coverage':   { plan: 'Sotyn.Headmasters modules tracked (the target = all running)', actual: 'Modules with activity this week' },
  'auto:raci_steps_done':       { plan: 'RACI steps on the user this week (closed + still open)', actual: 'RACI steps the user closed this week (all modules)' },
  'auto:raci_ontime_pct':       { plan: 'You set (target %, e.g. 90)',        actual: '% of the user\'s closed steps done within SLA' },
  // DPR
  'auto:dpr_profit':            { plan: 'Σ planned cost (DPR Table B)',       actual: 'Σ actual cost (DPR Table B)' },
  'auto:dpr_count':             { plan: '6 days/week target',                 actual: 'DPR submissions for this site' },
  'auto:dpr_by_user':           { plan: '6 DPRs/week target',                 actual: 'DPRs submitted BY this user' },
  'auto:dpr_profit_by_user':    { plan: 'You set (Target column)',            actual: 'Σ profit/loss across user\'s DPRs' },
  'auto:dpr_cost_by_user':      { plan: 'DPRs submitted',                     actual: 'DPRs approved' },
  // Sales / CRM
  'auto:leads_created':         { plan: 'You set',                            actual: 'Leads assigned to user this week' },
  'auto:leads_qualified':       { plan: 'You set',                            actual: 'Leads moved to qualified by user' },
  'auto:quotations_sent':       { plan: 'You set',                            actual: 'Quotations sent by user' },
  'auto:meetings_planned':      { plan: 'You set',                            actual: 'Meetings scheduled this week' },
  'auto:crm_kitting':           { plan: 'You set',                            actual: 'CRM full-kitting checkpoints the user logged (entries + photos)' },
  // Business Book
  'auto:bb_entries':            { plan: 'You set',                            actual: 'Business Book entries created by user' },
  'auto:bb_po_amount':          { plan: 'You set',                            actual: 'Σ PO amount on user\'s BB entries' },
  'auto:bb_sale_amount':        { plan: 'You set',                            actual: 'Σ Sale amount on user\'s BB entries' },
  'auto:bb_advance':            { plan: 'You set',                            actual: 'Σ Advance received on user\'s BB entries' },
  // Procurement
  'auto:indents_in_week':       { plan: 'Indents created for user\'s site',    actual: 'Indents created for user\'s site' },
  'auto:indent_vs_bill':        { plan: 'Indents raised for the site (this week)', actual: 'Sales bills generated for the site (this week)' },
  'auto:items_complete':        { plan: 'All indent line-items (total)',         actual: 'Items with a PO raised (procured) — company-wide' },
  // HR — Manpower (from the HR → Manpower Plan page)
  'auto:site_manpower':         { plan: 'Σ REQUIRED manpower — value slab, all projects', actual: 'Σ ACTUAL manpower on site (DPR average)' },
  'auto:attrition':             { plan: 'You set (max acceptable leavers)',    actual: 'Count of inactive/terminated staff (all-time)' },
  // System / Engagement (from the audit trail)
  'auto:daily_active_users':    { plan: 'Total active (registered) users',     actual: 'Avg daily distinct users active in the system this week' },
  'auto:data_entry_all':        { plan: 'You set (e.g. 300000)',               actual: 'CREATE/UPDATE/DELETE records entered company-wide this week' },
  'auto:indents_approved':      { plan: 'You set',                            actual: 'Indents approved by user' },
  'auto:vendor_pos_created':    { plan: 'You set',                            actual: 'Vendor POs created by user' },
  'auto:purchase_bills':        { plan: 'You set',                            actual: 'Purchase bills received this week' },
  'auto:dispatch_sent':         { plan: 'You set',                            actual: 'Delivery notes dispatched' },
  'auto:material_received':     { plan: 'You set',                            actual: 'Material receipts at user\'s site' },
  // Inventory
  'auto:stock_in':              { plan: 'You set',                            actual: 'Stock IN movements (count)' },
  'auto:stock_out':             { plan: 'You set',                            actual: 'Stock OUT movements (count)' },
  'auto:stock_to_site':         { plan: 'You set',                            actual: 'Stock issued from office → site' },
  'auto:stock_updates':         { plan: 'You set',                            actual: 'Stock update events per site/week' },
  'auto:tools_list':            { plan: 'You set',                            actual: 'Tools list rows per site' },
  'auto:stock_at_site':         { plan: 'You set',                            actual: 'Stock-at-site flag (0/1)' },
  // Installation & Billing
  'auto:installations_started': { plan: 'You set',                            actual: 'Installation start dates this week' },
  'auto:installations_completed':{ plan: 'You set',                           actual: 'Installations marked complete this week' },
  'auto:sales_bills':           { plan: 'You set',                            actual: 'Sales bills raised this week' },
  'auto:ra_bills':              { plan: 'You set',                            actual: 'RA bills raised for user\'s site' },
  'auto:mb_filed':              { plan: 'You set',                            actual: 'MB sheets filed (count)' },
  'auto:mb_signed':             { plan: 'You set',                            actual: 'MBs signed by client at user\'s site' },
  // Cash Flow
  'auto:amount_received':       { plan: 'You set',                            actual: 'Σ collections amount (by user)' },
  'auto:amount_received_all':   { plan: 'You set',                            actual: 'Σ collections amount (everyone)' },
  'auto:amount_received_lakh':  { plan: 'You set (target in lakh)',           actual: 'Σ collections this week, in LAKH (₹÷1,00,000)' },
  'auto:receivables_outstanding_cr': { plan: 'You set (target in CR, lower better)', actual: 'Current open receivables, in CRORE (₹÷1,00,00,000)' },
  'auto:collections_count':     { plan: 'You set',                            actual: 'Number of collections (by user)' },
  'auto:receivables_outstanding':{ plan: 'You set',                           actual: 'Σ open receivables (owner)' },
  'auto:receivables_count':     { plan: 'You set',                            actual: 'Count of open receivables (owner)' },
  // Payments
  'auto:payments_raised':       { plan: 'You set',                            actual: 'Payment requests raised by user' },
  'auto:payments_approved':     { plan: 'You set',                            actual: 'Payment requests final-approved by user' },
  'auto:payments_rejected':     { plan: 'You set',                            actual: 'Payment requests rejected' },
  // HR Hiring
  'auto:candidates_added':      { plan: 'You set',                            actual: 'Candidates added this week' },
  'auto:candidates_shortlisted':{ plan: 'You set',                            actual: 'Candidates shortlisted this week' },
  'auto:candidates_onboarded':  { plan: 'You set',                            actual: 'Candidates onboarded this week' },
  // Attendance
  'auto:attendance_present_days':{ plan: '6 days target',                     actual: 'Present days this week' },
  'auto:attendance_late_days':  { plan: 'You set (lower better)',             actual: 'Late days this week' },
  'auto:attendance_absent_days':{ plan: '0 days target',                      actual: 'Absent days this week' },
  'auto:leaves_applied':        { plan: 'You set',                            actual: 'Leave requests filed by user' },
  // Master Data
  'auto:customers_added':       { plan: 'You set',                            actual: 'Customers added by user' },
  'auto:vendors_added':         { plan: 'You set',                            actual: 'Vendors added by user' },
};
const sourceInfoFor = (src) => {
  // Per-step RACI sources are dynamic (auto:raci_step:<module>:<step>) — one hint covers them all.
  if (src && src.startsWith('auto:raci_step:')) {
    return { plan: 'This step on the user this week (closed + still open)', actual: 'This step the user closed this week' };
  }
  return SOURCE_INFO[src] || { plan: '—', actual: '—' };
};

export default function Scorecard() {
  const { user, isAdmin } = useAuth();
  const [tab, setTab] = useUrlTab('my');
  const [weekStart, setWeekStart] = useState(lastMonday(0));
  const [viewUserId, setViewUserId] = useState(user?.id);
  const [scorecard, setScorecard] = useState(null);
  const [savingKpi, setSavingKpi] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [tplDetail, setTplDetail] = useState(null);
  const [overview, setOverview] = useState(null);
  // "RACI Steps" row → step-wise breakdown shown INLINE, expanded under the row
  // on the page (mam 2026-06-27: show it here, like an expand — not in a popup).
  const [raci, setRaci] = useState({ open: false, loading: false, data: null });
  // Collapse + drop stale data whenever the viewed user or week changes.
  useEffect(() => { setRaci({ open: false, loading: false, data: null }); }, [viewUserId, weekStart]);
  const toggleRaci = useCallback(() => {
    setRaci(r => {
      if (r.open) return { ...r, open: false };          // collapse
      api.get(`/scoring/raci-breakdown?user_id=${viewUserId}&week_start=${weekStart}`)
        .then(res => setRaci(rr => ({ ...rr, loading: false, data: res.data })))
        .catch(err => { setRaci({ open: false, loading: false, data: null }); toast.error(err.response?.data?.error || 'Failed to load step-wise breakdown'); });
      return { open: true, loading: true, data: r.data };  // expand + fetch fresh
    });
  }, [viewUserId, weekStart]);

  const loadScorecard = useCallback(() => {
    api.get(`/scoring/scorecard?user_id=${viewUserId}&week_start=${weekStart}`)
      .then(r => setScorecard(r.data))
      .catch(err => toast.error(err.response?.data?.error || 'Failed'));
  }, [viewUserId, weekStart]);

  const loadOverview = useCallback(() => {
    api.get(`/scoring/weekly?week_start=${weekStart}`)
      .then(r => setOverview(r.data))
      .catch(() => setOverview(null));
  }, [weekStart]);

  useEffect(() => {
    if (tab === 'my' || tab === 'view') loadScorecard();
    if (tab === 'overview') loadOverview();
    if (tab === 'templates') api.get('/scoring/templates').then(r => setTemplates(r.data || [])).catch(() => {});
    if (tab === 'assign') {
      Promise.all([
        api.get('/scoring/assignments').then(r => r.data),
        api.get('/scoring/templates').then(r => r.data),
      ]).then(([a, t]) => { setAssignments(a || []); setTemplates(t || []); }).catch(() => {});
    }
  }, [tab, loadScorecard, loadOverview]);

  const saveEntry = async (kpi, patch) => {
    setSavingKpi(kpi.kpi_id);
    try {
      await api.put('/scoring/scorecard/entry', {
        user_id: viewUserId,
        kpi_id: kpi.kpi_id,
        week_start: weekStart,
        ...patch,
      });
      // Reload to get fresh totals
      loadScorecard();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally {
      setSavingKpi(null);
    }
  };

  // Group KPIs by group_name for the table render
  const grouped = (scorecard?.kpis || []).reduce((acc, k) => {
    const g = k.group_name || 'Other';
    if (!acc[g]) acc[g] = [];
    acc[g].push(k);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FiTrendingUp className="text-indigo-600" /> Scorecard</h1>
          <p className="text-sm text-gray-500">Weekly MIS — Mon-Sat. Per-role KPI templates with planned vs actual and weighted score.</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <button onClick={() => { setTab('my'); setViewUserId(user.id); }}
          className={`btn ${tab === 'my' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1`}>
          <FiUser size={14} /> My Scorecard
        </button>
        <button onClick={() => setTab('overview')}
          className={`btn ${tab === 'overview' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1`}>
          <FiUsers size={14} /> Team Overview
        </button>
        {isAdmin() && (
          <>
            <button onClick={() => setTab('templates')}
              className={`btn ${tab === 'templates' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1`}>
              <FiSettings size={14} /> Templates
            </button>
            <button onClick={() => setTab('assign')}
              className={`btn ${tab === 'assign' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1`}>
              <FiUsers size={14} /> Assign Templates
            </button>
          </>
        )}
      </div>

      {(tab === 'my' || tab === 'overview' || tab === 'view') && (
        <div className="card p-4 flex flex-wrap items-center gap-3">
          <FiCalendar className="text-gray-400" />
          <div>
            <label className="label">Week starting (Monday)</label>
            <input type="date" className="input" value={weekStart} onChange={e => setWeekStart(e.target.value)} />
          </div>
          <div className="flex gap-1">
            <button onClick={() => setWeekStart(lastMonday(1))} className="btn btn-secondary text-xs">Last Week</button>
            <button onClick={() => setWeekStart(lastMonday(0))} className="btn btn-secondary text-xs">This Week</button>
            <button onClick={() => setWeekStart(lastMonday(2))} className="btn btn-secondary text-xs">Two Weeks Ago</button>
          </div>
          {/* Admin-only employee switcher — pick anyone to inspect their MIS
              without leaving the My Scorecard tab. */}
          {(tab === 'my' || tab === 'view') && isAdmin() && (
            <EmployeeSwitcher value={viewUserId} onChange={setViewUserId} />
          )}
          <div className="ml-auto text-sm text-gray-700">
            <span className="font-semibold">{fmtRange(weekStart)}</span>
          </div>
        </div>
      )}

      {/* MY SCORECARD */}
      {(tab === 'my' || tab === 'view') && scorecard && (
        <>
          <div className="card p-4 flex flex-wrap items-center justify-between gap-3 bg-gradient-to-r from-indigo-50 to-blue-50">
            <div>
              <p className="text-xs text-gray-500">Template</p>
              <p className="text-lg font-bold">{scorecard.template?.name || <span className="text-amber-600">No template assigned</span>}</p>
              {scorecard.template?.description && <p className="text-xs text-gray-500">{scorecard.template.description}</p>}
            </div>
            <div className="flex items-center gap-3">
              {scorecard.template && (scorecard.kpis || []).length > 0 && (
                <button
                  onClick={() => exportCsv(
                    `scorecard-${(scorecard.user?.name || 'user').replace(/\s+/g, '-')}-${weekStart}`,
                    ['Group', 'Team / Person', 'Weight %', 'Last Week %', 'Planned', 'Actual', 'Actual %', 'Total Up-to-date', 'Pending', 'Commitment'],
                    (scorecard.kpis || []).map(k => [
                      k.group_name || 'Other',
                      k.metric_name || '',
                      k.weightage ?? '',
                      vsPlan(k.last_week_pct) ?? '',
                      k.planned ?? 0,
                      k.actual ?? 0,
                      vsPlan(k.actual_pct) ?? '',
                      k.total_uptodate ?? '',
                      k.pending_uptodate ?? k.pending_work ?? '',
                      k.commitment || '',
                    ])
                  )}
                  className="btn btn-secondary text-xs flex items-center gap-1"
                  title="Download this scorecard as CSV (opens in Excel)"
                ><FiDownload size={14} /> Export Excel</button>
              )}
              <div className="text-right">
                <p className="text-xs text-gray-500">Weekly Score <span className="text-gray-400">vs plan</span></p>
                {(() => {
                  // Headline = variance from plan (achievement% − 100), 2 decimals:
                  // 0% = on plan, negative = behind, positive = ahead (mam 2026-07-04).
                  // Engine score stays the raw achievement % so the Champions League /
                  // War Room keep ranking higher-better; this is display-only.
                  if (!scorecard.template) return <p className="text-3xl font-bold text-gray-300">—</p>;
                  const headVs = (scorecard.score ?? 0) - 100;
                  return <p className={`text-3xl font-bold ${vsClr(scorecard.score)}`}>{headVs > 0 ? '+' : ''}{headVs.toFixed(2)}%</p>;
                })()}
              </div>
            </div>
          </div>

          {/* Weekly commitment — the employee's promise for the coming week,
              last week's committed target, and a committed-vs-delivered graph
              so they SEE the gap (mam 2026-07-06). */}
          <CommitmentPanel viewUserId={viewUserId} weekStart={weekStart} />

          {!scorecard.template && (
            <div className="card p-6 text-center text-gray-400 text-sm">
              No template assigned to this user yet. {isAdmin() && <span>Open the <button className="text-blue-600 underline" onClick={() => setTab('assign')}>Assign Templates</button> tab to set one.</span>}
            </div>
          )}

          {scorecard.template && Object.keys(grouped).map(groupName => (
            <div key={groupName} className="card p-0 overflow-x-auto">
              <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 font-bold text-amber-800 text-sm">{groupName}</div>
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-[10px] text-gray-500 uppercase">
                  <tr>
                    <th className="text-left p-2 w-[260px]">Team / Person</th>
                    <th className="text-center p-2 w-16">Weight %</th>
                    <th className="text-center p-2 w-20">Last Week %</th>
                    <th className="text-center p-2 w-24">Planned</th>
                    <th className="text-center p-2 w-24">Actual</th>
                    <th className="text-center p-2 w-20">Actual %</th>
                    <th className="text-center p-2 w-20">Total Up-to-date</th>
                    <th className="text-center p-2 w-20">Pending</th>
                    <th className="text-left p-2">Commitment</th>
                  </tr>
                </thead>
                <tbody>
                  {grouped[groupName].map(k => {
                    const isRaci = k.data_source === 'auto:raci_steps_done';
                    return (
                      <Fragment key={k.kpi_id}>
                        <KpiRow
                          kpi={k}
                          saving={savingKpi === k.kpi_id}
                          onSave={(patch) => saveEntry(k, patch)}
                          readOnly={viewUserId !== user.id && !isAdmin()}
                          onStepWise={isRaci ? toggleRaci : null}
                          stepWiseOpen={isRaci && raci.open}
                        />
                        {isRaci && raci.open && (
                          <tr className="border-t bg-gray-50">
                            <td colSpan={9} className="p-3">
                              {raci.loading
                                ? <p className="text-sm text-gray-500">Loading step-wise…</p>
                                : <RaciBreakdown data={raci.data} />}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}

      {/* TEAM OVERVIEW (existing weekly aggregator) */}
      {tab === 'overview' && overview && (
        <div className="card p-0 overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Employee</th>
                <th>Dept</th>
                <th className="text-center">Delegations</th>
                <th className="text-center">PMS</th>
                <th className="text-center">Checklists</th>
                <th className="text-center">Tickets</th>
                <th className="text-right">Score</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {overview.users.map((u, i) => (
                <tr key={u.user_id}>
                  <td className="text-gray-400 font-bold">#{i + 1}</td>
                  <td className="font-medium">{u.name}</td>
                  <td className="text-xs text-gray-500">{u.department || u.role}</td>
                  <td className="text-center">{u.delegations.done}/{u.delegations.given}</td>
                  <td className="text-center">{u.pms.done}/{u.pms.given}</td>
                  <td className="text-center">{u.checklists.done}/{u.checklists.given}</td>
                  <td className="text-center">{u.tickets.done}/{u.tickets.given}</td>
                  <td className="text-right">
                    <span className={`px-2 py-1 rounded text-xs font-bold ${scorePill(u.score - 100)}`}>{fmtVs(u.score)}</span>
                  </td>
                  <td>
                    <button onClick={() => { setViewUserId(u.user_id); setTab('view'); }} className="btn btn-secondary text-xs">Open MIS</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* TEMPLATES (admin) */}
      {tab === 'templates' && (
        <TemplatesAdmin templates={templates} reload={() => api.get('/scoring/templates').then(r => setTemplates(r.data))} setTplDetail={setTplDetail} />
      )}

      {/* ASSIGN (admin) */}
      {tab === 'assign' && (
        <AssignTemplates assignments={assignments} templates={templates} reload={() => api.get('/scoring/assignments').then(r => setAssignments(r.data))} />
      )}

      {/* Template detail modal */}
      <Modal isOpen={!!tplDetail} onClose={() => setTplDetail(null)} title={tplDetail?.name || 'Template'} wide>
        {tplDetail && <TemplateKpiEditor templateId={tplDetail.id} onChange={() => api.get(`/scoring/templates/${tplDetail.id}`).then(r => setTplDetail(r.data))} />}
      </Modal>
    </div>
  );
}

// ---------- Weekly Commitment panel ----------
// mam (2026-07-06): "separate box for writing the commitment (0 to −50%) for
// the coming week; always show last week's committed target in its own box;
// then a committed-vs-actual graph that gives the emotional angle so the
// employee sees the gap."  All three live here.  The committed % uses the same
// variance-vs-plan convention the rest of the page shows (0 = on plan).
function CommitTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0].payload;
  const gap = row.gap;
  return (
    <div className="bg-white border rounded shadow px-3 py-2 text-xs">
      <div className="font-semibold mb-1">Week of {label}</div>
      <div>Committed: <b className={varClr(row.committed)}>{fmtVar(row.committed)}</b></div>
      <div>Delivered: <b className={varClr(row.actual)}>{fmtVar(row.actual)}</b></div>
      {gap != null && (
        <div className={gap >= 0 ? 'text-emerald-700 mt-0.5' : 'text-red-700 mt-0.5'}>
          {gap >= 0 ? `Met the promise (+${gap}%)` : `Gap of ${gap}% to close`}
        </div>
      )}
    </div>
  );
}

function CommitmentPanel({ viewUserId, weekStart }) {
  const { user, isAdmin } = useAuth();
  const readOnly = viewUserId !== user.id && !isAdmin();
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api.get(`/scoring/commitments?user_id=${viewUserId}&week_start=${weekStart}&weeks=8`)
      .then(r => { setData(r.data); setDraft(r.data?.next?.committed_pct ?? ''); })
      .catch(() => setData(null));
  }, [viewUserId, weekStart]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    const raw = String(draft).trim();
    const v = raw === '' ? null : Number(raw);
    if (v !== null && (!Number.isFinite(v) || v < -50 || v > 0)) {
      toast.error('Commitment must be between 0% and −50%');
      return;
    }
    setSaving(true);
    try {
      await api.put('/scoring/commitment', { user_id: viewUserId, week_start: data.next_week_start, committed_pct: v });
      toast.success(v === null ? 'Commitment cleared' : 'Commitment saved');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  };

  if (!data) return null;
  const current = data.current?.committed_pct ?? null;   // promise made for the viewed week
  const series = data.weeks || [];
  const actualThisWeek = series.length ? series[series.length - 1].actual_pct : null;
  const gapThisWeek = (current != null && actualThisWeek != null)
    ? Math.round((actualThisWeek - current) * 100) / 100 : null;

  const chart = series.map(w => ({
    label: fmtShort(w.week_start),
    committed: w.committed_pct,
    actual: w.actual_pct,
    gap: (w.committed_pct != null && w.actual_pct != null)
      ? Math.round((w.actual_pct - w.committed_pct) * 100) / 100 : null,
  }));
  const vals = chart.flatMap(r => [r.committed, r.actual]).filter(v => v != null);
  const lo = Math.floor(Math.min(-55, 0, ...vals) / 5) * 5;
  const hi = Math.ceil(Math.max(10, 0, ...vals) / 5) * 5;
  // Green when the bar meets/beats the promise line, red when it falls short.
  const barColor = (r) => {
    if (r.actual == null) return '#e5e7eb';
    if (r.committed != null) return r.actual >= r.committed ? '#10b981' : '#ef4444';
    return r.actual >= 0 ? '#10b981' : r.actual >= -50 ? '#f59e0b' : '#ef4444';
  };
  const hasData = vals.length > 0;

  return (
    <div className="card p-4 space-y-4">
      <div className="flex items-center gap-2">
        <FiTarget className="text-indigo-600" />
        <h3 className="font-bold text-sm">Weekly Commitment <span className="text-gray-400 font-normal">— your promise vs what you delivered</span></h3>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Box A — last week's committed target for THIS week (read-only) */}
        <div className="rounded-lg border bg-gradient-to-br from-slate-50 to-white p-4">
          <p className="text-xs text-gray-500">Committed target — this week</p>
          <p className="text-[11px] text-gray-400 mb-1">{fmtRange(weekStart)} · set last week</p>
          {current == null
            ? <p className="text-2xl font-bold text-gray-300">Not committed</p>
            : <p className={`text-3xl font-bold ${varClr(current)}`}>{fmtVar(current)}</p>}
          {gapThisWeek != null && (
            <p className="text-[11px] mt-1 text-gray-600">
              Delivered <b className={varClr(actualThisWeek)}>{fmtVar(actualThisWeek)}</b> ·{' '}
              {gapThisWeek >= 0
                ? <span className="text-emerald-700 font-semibold">met the promise (+{gapThisWeek}%)</span>
                : <span className="text-red-700 font-semibold">gap of {gapThisWeek}%</span>}
            </p>
          )}
        </div>

        {/* Box B — commit for the coming week (editable, 0 … −50) */}
        <div className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-4">
          <p className="text-xs text-indigo-800 font-semibold">My commitment for next week</p>
          <p className="text-[11px] text-gray-500 mb-2">{fmtRange(data.next_week_start)}</p>
          <div className="flex items-center gap-2">
            <input
              type="number" min={-50} max={0} step={5}
              className="input w-28 text-lg font-bold text-center"
              placeholder="0 … −50" value={draft}
              onChange={e => setDraft(e.target.value)} disabled={readOnly || saving}
            />
            <span className="text-gray-500 text-sm">%</span>
            {!readOnly && (
              <button onClick={save} disabled={saving} className="btn btn-primary text-sm flex items-center gap-1">
                <FiSave size={14} /> {saving ? 'Saving…' : 'Commit'}
              </button>
            )}
          </div>
          <p className="text-[10px] text-gray-400 mt-1.5">0% = you'll fully hit plan · −50% = the worst you'll allow. You can't commit below −50%.</p>
        </div>
      </div>

      {/* Graph — the emotional angle: bars (delivered) against the dashed
          promise line, red where they fall short. */}
      <div>
        {hasData ? (
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={chart} margin={{ top: 10, right: 12, left: -12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} domain={[lo, hi]} tickFormatter={v => `${v}%`} />
              <Tooltip content={<CommitTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine y={0} stroke="#94a3b8" strokeWidth={1} ifOverflow="extendDomain" />
              <Bar dataKey="actual" name="Delivered" radius={[3, 3, 0, 0]} maxBarSize={40}>
                {chart.map((r, i) => <Cell key={i} fill={barColor(r)} />)}
              </Bar>
              <Line type="monotone" dataKey="committed" name="Committed" stroke="#4f46e5"
                strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3, fill: '#4f46e5' }} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <div className="text-center text-gray-400 text-sm py-10 border border-dashed rounded">
            No commitments yet. Set one for next week above — the gap graph fills in as the weeks go by.
          </div>
        )}
        <p className="text-[11px] text-gray-500 text-center mt-1">
          Dashed line = what you <b>committed</b>. Bars = what you <b>delivered</b>. <span className="text-red-600 font-semibold">Red bars fall short of your promise</span> — that's the gap to close.
        </p>
      </div>
    </div>
  );
}

// ---------- RACI step-wise breakdown (drill-down of the RACI Steps row) ----------
// Editable "for next week" commitment per step — saves in place to the module
// default (record_id 0) so it sticks for that module/step (mam 2026-06-29:
// "commitment should be editable"). Touches only commitment, never R/A/C/I/SLA.
function CommitmentCell({ row }) {
  const [val, setVal] = useState(row.commitment ?? '');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const next = (val || '').trim();
    if (next === (row.commitment || '')) return;     // unchanged — skip
    setSaving(true);
    try {
      await api.put(`/raci/step-commitment/${row.module}/0`, { step_key: row.step_key, commitment: next });
      row.commitment = next;                          // keep the row's data in sync
    } catch { toast.error('Failed to save commitment'); setVal(row.commitment ?? ''); }
    finally { setSaving(false); }
  };
  return (
    <input type="text" className={`input text-xs w-full ${saving ? 'bg-amber-50' : ''}`}
      placeholder="for next week…" value={val}
      onChange={e => setVal(e.target.value)} onBlur={save} />
  );
}

function RaciBreakdown({ data }) {
  if (!data || data.loading) return <p className="text-sm text-gray-500 p-4">Loading…</p>;
  const rows = data.rows || [];
  if (!rows.length) return <p className="text-sm text-gray-500 p-4">No RACI steps on this person for this week.</p>;
  // Group the per-step rows under their module heading.
  const byMod = rows.reduce((a, r) => { (a[r.module_label] = a[r.module_label] || []).push(r); return a; }, {});
  // Actual % per the scorecard's higher-better rule: (done − planned)/planned, floored at −100.
  const pct = (done, planned) => { if (!planned) return 0; const p = Math.round(((done - planned) / planned) * 100); return p < -100 ? -100 : p; };
  const pctClr = (p) => p >= 0 ? 'text-emerald-700' : p >= -50 ? 'text-amber-700' : 'text-red-700';
  const overall = pct(data.totals.actual, data.totals.planned);
  // Weighted overall % when any step carries a weight: Σ(weight × stepPct)/Σ(weight).
  const wRows = rows.filter(r => +r.weight > 0);
  const hasW = wRows.length > 0;
  const weightedOverall = hasW
    ? Math.round(wRows.reduce((s, r) => s + (+r.weight) * pct(r.actual, r.planned), 0) / wRows.reduce((s, r) => s + (+r.weight), 0))
    : overall;
  return (
    <div className="space-y-4">
      <div className="text-sm text-gray-600">
        Week {data.week_start} → {data.week_end} · <b>{data.totals.planned}</b> planned ·{' '}
        <b className="text-emerald-700">{data.totals.actual}</b> done ·{' '}
        <b className="text-amber-700">{data.totals.pending}</b> pending ·{' '}
        <b className={pctClr(weightedOverall)}>{weightedOverall}%</b>{hasW && <span className="text-[10px] text-gray-400"> (weighted)</span>}
      </div>
      {Object.entries(byMod).map(([mod, list]) => (
        <div key={mod} className="border rounded overflow-hidden">
          <div className="px-3 py-1.5 bg-amber-50 border-b border-amber-200 font-semibold text-amber-800 text-sm">{mod}</div>
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-[10px] text-gray-500 uppercase">
              <tr>
                <th className="text-left p-2">Step</th>
                <th className="text-center p-2 w-14">Wt %</th>
                <th className="text-center p-2 w-20">Planned</th>
                <th className="text-center p-2 w-16">Done</th>
                <th className="text-center p-2 w-16">Pending</th>
                <th className="text-center p-2 w-20">Actual %</th>
                <th className="text-center p-2 w-20">On-time</th>
                <th className="text-left p-2">Commitment (next wk)</th>
              </tr>
            </thead>
            <tbody>
              {list.map(r => (
                <tr key={r.step_key} className="border-t">
                  <td className="p-2 font-medium">{r.step_label}</td>
                  <td className="text-center p-2 text-indigo-700">{r.weight != null ? `${r.weight}%` : <span className="text-gray-300">—</span>}</td>
                  <td className="text-center p-2 font-semibold">{r.planned}</td>
                  <td className="text-center p-2 text-emerald-700">{r.actual}</td>
                  <td className="text-center p-2 text-amber-700">{r.pending || ''}</td>
                  <td className={`text-center p-2 font-bold ${pctClr(pct(r.actual, r.planned))}`}>{pct(r.actual, r.planned)}%</td>
                  <td className="text-center p-2">{r.sla_judged ? `${Math.round((r.on_time / r.sla_judged) * 100)}%` : <span className="text-gray-300">—</span>}</td>
                  <td className="p-2"><CommitmentCell row={r} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

// ---------- Employee Switcher (admin) ----------
function EmployeeSwitcher({ value, onChange }) {
  const [users, setUsers] = useState([]);
  useEffect(() => {
    api.get('/scoring/assignments').then(r => setUsers(r.data || [])).catch(() => {});
  }, []);
  return (
    <div>
      <label className="label">View as</label>
      <select className="select" value={value || ''} onChange={e => onChange(+e.target.value)}>
        {users.map(u => (
          <option key={u.user_id} value={u.user_id}>
            {u.name} {u.template_name ? `— ${u.template_name}` : '(no template)'}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------- KPI Row (editable) ----------
function KpiRow({ kpi, saving, onSave, readOnly, onStepWise, stepWiseOpen }) {
  const [planned, setPlanned] = useState(kpi.planned ?? 0);
  const [actual, setActual] = useState(kpi.actual ?? 0);
  const [pendingUp, setPendingUp] = useState(kpi.pending_uptodate ?? '');
  const [pendingWork, setPendingWork] = useState(kpi.pending_work ?? '');
  const [commitment, setCommitment] = useState(kpi.commitment ?? '');
  const [totalUp, setTotalUp] = useState(kpi.total_uptodate ?? '');
  useEffect(() => {
    setPlanned(kpi.planned ?? 0);
    setActual(kpi.actual ?? 0);
    setPendingUp(kpi.pending_uptodate ?? '');
    setPendingWork(kpi.pending_work ?? '');
    setCommitment(kpi.commitment ?? '');
    setTotalUp(kpi.total_uptodate ?? '');
  }, [kpi.kpi_id, kpi.planned, kpi.actual, kpi.pending_uptodate, kpi.pending_work, kpi.commitment, kpi.total_uptodate]);

  const flush = () => {
    if (readOnly) return;
    onSave({
      planned: Number(planned) || 0,
      actual: Number(actual) || 0,
      pending_uptodate: pendingUp === '' ? null : Number(pendingUp),
      pending_work: pendingWork === '' ? null : Number(pendingWork),
      total_uptodate: totalUp === '' ? null : Number(totalUp),
      commitment: commitment || null,
    });
  };

  // Show the % as variance vs plan (achievement − 100): 0% = on plan, negative =
  // behind, positive = ahead.  Colour on that scale (see vsPlan note up top).
  const pctClr = vsClr(kpi.actual_pct);
  const isAuto = kpi.is_auto;

  return (
    <tr className={`border-t ${saving ? 'bg-amber-50' : ''}`}>
      <td className="p-2">
        <div className="font-medium">{kpi.metric_name}</div>
        <div className="text-[10px] text-gray-500">
          {kpi.direction === 'lower_better' && <span className="text-blue-600">↓ lower better</span>}
          {kpi.direction !== 'lower_better' && <span className="text-emerald-600">↑ higher better</span>}
          {isAuto && <span className="ml-2 px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-[9px] font-bold">AUTO</span>}
          {onStepWise && (
            <button onClick={onStepWise} className="ml-2 text-indigo-600 hover:underline font-semibold">
              {stepWiseOpen ? '▾ hide steps' : '▸ step-wise'}
            </button>
          )}
        </div>
      </td>
      <td className="text-center p-2">{kpi.weightage}%</td>
      <td className="text-center p-2">
        {kpi.last_week_pct != null ? <span className={vsClr(kpi.last_week_pct)}>{fmtVs(kpi.last_week_pct)}</span> : <span className="text-gray-300">—</span>}
      </td>
      <td className="text-center p-2">
        {isAuto ? <span className="text-gray-700">{planned}</span> :
          <input type="number" className="input text-center text-xs w-20 mx-auto" value={planned} onChange={e => setPlanned(e.target.value)} onBlur={flush} disabled={readOnly} />}
      </td>
      <td className="text-center p-2">
        {isAuto ? <span className="text-gray-700">{actual}</span> :
          <input type="number" className="input text-center text-xs w-20 mx-auto" value={actual} onChange={e => setActual(e.target.value)} onBlur={flush} disabled={readOnly} />}
      </td>
      <td className={`text-center p-2 font-bold ${pctClr}`}>{fmtVs(kpi.actual_pct)}</td>
      <td className="text-center p-2">
        <input type="number" className="input text-center text-xs w-20 mx-auto" value={totalUp} onChange={e => setTotalUp(e.target.value)} onBlur={flush} disabled={readOnly} />
      </td>
      <td className="text-center p-2">
        <div className="flex items-center justify-center gap-1">
          <input type="number" className="input text-center text-xs w-16" placeholder="up" value={pendingUp} onChange={e => setPendingUp(e.target.value)} onBlur={flush} disabled={readOnly} />
          <span className="text-gray-300">/</span>
          <input type="number" className="input text-center text-xs w-16" placeholder="wk" value={pendingWork} onChange={e => setPendingWork(e.target.value)} onBlur={flush} disabled={readOnly} />
        </div>
      </td>
      <td className="p-2">
        <input type="text" className="input text-xs w-full" placeholder="…" value={commitment} onChange={e => setCommitment(e.target.value)} onBlur={flush} disabled={readOnly} />
      </td>
    </tr>
  );
}

// ---------- Templates Admin ----------
function TemplatesAdmin({ templates, reload, setTplDetail }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const create = async (e) => {
    e.preventDefault();
    try {
      await api.post('/scoring/templates', { name, description });
      toast.success('Template created');
      setName(''); setDescription(''); setAdding(false);
      reload();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const del = async (t) => {
    if (!confirm(`Delete template "${t.name}" and all its KPIs?`)) return;
    try { await api.delete(`/scoring/templates/${t.id}`); toast.success('Deleted'); reload(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <p className="text-sm text-gray-500">Per-role KPI templates. Edit weights / metrics / data sources here. Mam pre-seeded 20 templates from your MIS PDFs.</p>
        <button onClick={() => setAdding(true)} className="btn btn-primary text-sm flex items-center gap-1"><FiPlus size={14} /> New Template</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {templates.map(t => (
          <div key={t.id} className="card p-4 hover:shadow-md transition cursor-pointer" onClick={() => api.get(`/scoring/templates/${t.id}`).then(r => setTplDetail(r.data))}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-bold text-sm">{t.name}</div>
                {t.description && <p className="text-[11px] text-gray-500 mt-0.5">{t.description}</p>}
              </div>
              <button onClick={(e) => { e.stopPropagation(); del(t); }} className="text-red-500 hover:text-red-700"><FiTrash2 size={14} /></button>
            </div>
            <div className="flex gap-3 mt-3 text-[10px] text-gray-500">
              <span>{t.kpi_count} KPIs</span>
              <span>{t.user_count} assigned</span>
            </div>
          </div>
        ))}
      </div>

      <Modal isOpen={adding} onClose={() => setAdding(false)} title="New Template">
        <form onSubmit={create} className="space-y-3">
          <div><label className="label">Name *</label><input className="input" required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Site Engineer" /></div>
          <div><label className="label">Description</label><input className="input" value={description} onChange={e => setDescription(e.target.value)} placeholder="What this role's KPIs measure" /></div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setAdding(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Create</button></div>
        </form>
      </Modal>
    </div>
  );
}

// ---------- Template KPI Editor ----------
// Per-step RACI <optgroup>s for the template editor's source pickers — one group
// per module, each step an option whose value is "auto:raci_step:<module>:<step>".
// Lets mam tie a KPI to ONE specific step, scored for whoever she names Responsible
// in RACI (mam 2026-06-27: "in template pick step-wise which person I select in RACI").
function RaciStepOptions({ modules }) {
  if (!modules || !modules.length) return null;
  return modules.map(m => (
    <optgroup key={m.key} label={`RACI step · ${m.label}`}>
      {(m.steps || []).map(s => (
        <option key={s.key} value={`auto:raci_step:${m.key}:${s.key}`}>{s.label}</option>
      ))}
    </optgroup>
  ));
}

function TemplateKpiEditor({ templateId, onChange }) {
  const [tpl, setTpl] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ group_name: 'Weekly', metric_name: '', weightage: 0, direction: 'higher_better', data_source: 'manual', default_planned: 0 });
  // Module + step catalogue for the per-step RACI source options (one fetch).
  const [raciModules, setRaciModules] = useState([]);
  useEffect(() => { api.get('/raci/modules').then(r => setRaciModules(r.data || [])).catch(() => {}); }, []);
  // Mam (2026-06-02): "here we done with it plan fill but from where
  // is actual we not show".  Live actual preview — pick any user
  // assigned to THIS template, fetch their current-week scorecard,
  // and merge the actual values into the KPI rows so mam can verify
  // each data source returns real data.
  const [previewUsers, setPreviewUsers] = useState([]);   // users assigned to this template
  const [previewUserId, setPreviewUserId] = useState('');
  const [previewKpis, setPreviewKpis] = useState({});     // { kpi_id: { planned, actual, score } }
  const [previewLoading, setPreviewLoading] = useState(false);

  const load = useCallback(() => {
    api.get(`/scoring/templates/${templateId}`).then(r => setTpl(r.data));
  }, [templateId]);
  useEffect(() => { load(); }, [load]);

  // Load users assigned to this template — we use the assignments
  // endpoint and filter client-side.  Auto-select the first one so
  // mam doesn't have to pick before seeing data.
  useEffect(() => {
    api.get('/scoring/assignments').then(r => {
      const onThis = (r.data || []).filter(a => a.template_id === templateId);
      setPreviewUsers(onThis);
      if (onThis.length > 0 && !previewUserId) setPreviewUserId(onThis[0].user_id);
    }).catch(() => setPreviewUsers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  // When user picked, fetch their scorecard and build a {kpi_id → row} lookup.
  useEffect(() => {
    if (!previewUserId) { setPreviewKpis({}); return; }
    setPreviewLoading(true);
    api.get('/scoring/scorecard', { params: { user_id: previewUserId } })
      .then(r => {
        const map = {};
        for (const k of (r.data?.kpis || [])) {
          map[k.kpi_id || k.id] = k;
        }
        setPreviewKpis(map);
      })
      .catch(() => setPreviewKpis({}))
      .finally(() => setPreviewLoading(false));
  }, [previewUserId]);

  // Per-user KPI overrides — mam (2026-06-02): "every person different
  // KPIs" (Option B).  Three things mam can override per user:
  //   - planned_value  → custom target
  //   - weight_override → custom weight (e.g. demote a KPI to 0% so
  //                       it stays visible but doesn't count toward score)
  //   - enabled         → 0 hides the KPI entirely (struck-through row)
  // All three flow through the same /scoring/users/:uid/kpi-targets
  // endpoint (composite-PK row in score_user_kpi_target).
  const [userOverrides, setUserOverrides] = useState({}); // { kpi_id: {planned_value, enabled, weight_override} }
  useEffect(() => {
    if (!previewUserId) { setUserOverrides({}); return; }
    api.get(`/scoring/users/${previewUserId}/kpi-targets`, { params: { template_id: templateId } })
      .then(r => {
        const map = {};
        for (const row of (r.data || [])) {
          map[row.kpi_id] = {
            planned_value: row.planned_value,
            enabled: row.enabled != null ? row.enabled : 1,
            weight_override: row.weight_override,
          };
        }
        setUserOverrides(map);
      })
      .catch(() => setUserOverrides({}));
  }, [previewUserId, templateId]);

  // Convenience accessors so existing per-target render paths keep working.
  const userTargets = useMemo(() => {
    const o = {};
    for (const [kid, v] of Object.entries(userOverrides)) {
      if (v.planned_value != null) o[kid] = v.planned_value;
    }
    return o;
  }, [userOverrides]);

  // Patch one field; backend handles partial-PUT (other fields stay put).
  const saveUserSetting = async (kpiId, patch) => {
    if (!previewUserId) return;
    try {
      await api.put(`/scoring/users/${previewUserId}/kpi-targets/${kpiId}`, patch);
      setUserOverrides(prev => {
        const next = { ...prev };
        const cur = next[kpiId] || { planned_value: null, enabled: 1, weight_override: null };
        // Apply the patch locally to keep the UI snappy
        const merged = { ...cur };
        if ('planned_value' in patch)   merged.planned_value   = patch.planned_value === '' ? null : (patch.planned_value == null ? null : +patch.planned_value);
        if ('enabled' in patch)         merged.enabled         = patch.enabled ? 1 : 0;
        if ('weight_override' in patch) merged.weight_override = patch.weight_override === '' ? null : (patch.weight_override == null ? null : +patch.weight_override);
        // If row is back to defaults (enabled=1 + no overrides), drop it locally too
        if (merged.enabled === 1 && merged.planned_value == null && merged.weight_override == null) {
          delete next[kpiId];
        } else {
          next[kpiId] = merged;
        }
        return next;
      });
      toast.success('Saved');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save');
    }
  };
  const saveUserTarget = (kpiId, value) =>
    saveUserSetting(kpiId, { planned_value: value === '' || value == null ? null : +value });

  const addKpi = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/scoring/templates/${templateId}/kpis`, form);
      setForm({ group_name: 'Weekly', metric_name: '', weightage: 0, direction: 'higher_better', data_source: 'manual', default_planned: 0 });
      setAdding(false);
      load(); onChange?.();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const updateKpi = async (k, patch) => {
    try { await api.put(`/scoring/kpis/${k.id}`, patch); load(); onChange?.(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const delKpi = async (k) => {
    if (!confirm(`Delete KPI "${k.metric_name}"?`)) return;
    try { await api.delete(`/scoring/kpis/${k.id}`); load(); onChange?.(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  if (!tpl) return <div className="text-gray-400 text-center py-6">Loading…</div>;

  const totalWeight = (tpl.kpis || []).reduce((s, k) => s + (k.weightage || 0), 0);

  return (
    <div className="space-y-3 max-h-[70vh] overflow-y-auto">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <p className="text-xs text-gray-500">Total weight: <span className={`font-bold ${totalWeight === 100 ? 'text-emerald-600' : 'text-amber-600'}`}>{totalWeight}%</span> {totalWeight !== 100 && '(should be 100)'}</p>
        <button onClick={() => setAdding(true)} className="btn btn-primary text-xs flex items-center gap-1"><FiPlus size={12} /> Add KPI</button>
      </div>
      {/* Mam (2026-06-02): "from where is actual we not show".  Pick a
          user assigned to this template → the Actual column below
          renders their current-week computed value per KPI so mam
          can verify each data source is wired correctly. */}
      <div className="bg-blue-50/40 border border-blue-200 rounded p-2 flex items-center gap-2 flex-wrap text-xs">
        <span className="font-semibold text-blue-800">Preview actuals for:</span>
        {previewUsers.length === 0 ? (
          <span className="text-gray-500 italic">No users assigned to this template yet — assign one from "Assign Templates" tab to preview actual values.</span>
        ) : (
          <>
            <select
              className="select text-xs py-1 px-2"
              value={previewUserId}
              onChange={e => setPreviewUserId(+e.target.value)}
            >
              {previewUsers.map(u => (
                <option key={u.user_id} value={u.user_id}>
                  {u.name}{u.department ? ` · ${u.department}` : ''}
                </option>
              ))}
            </select>
            <span className="text-[10px] text-gray-500">
              {previewLoading ? 'loading…' : 'current week, live from Sotyn.Headmasters data'}
            </span>
          </>
        )}
      </div>
      <table className="w-full text-xs">
        <thead className="bg-gray-50">
          <tr>
            <th className="text-left p-2">Group</th>
            <th className="text-left p-2">Metric</th>
            <th className="text-center p-2 w-16">Weight</th>
            <th className="text-center p-2 w-20">Target</th>
            <th className="text-center p-2 w-24">Direction</th>
            <th className="text-center p-2 w-32">Source</th>
            <th className="text-center p-2 w-24">Actual<br/><span className="text-[9px] font-normal text-gray-400 normal-case">(this week)</span></th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {tpl.kpis.map(k => {
            // Per-user override snapshot for this row (only used when
            // previewUserId is set).  Drives the enable toggle + the
            // weight override input + the visual "disabled" dimming.
            const userRow = previewUserId ? userOverrides[k.id] : null;
            const userEnabled = userRow ? userRow.enabled !== 0 : true;
            const userWeight = userRow?.weight_override;
            const hasWeightOverride = userWeight != null;
            return (
            <tr key={k.id} className={`border-t ${previewUserId && !userEnabled ? 'opacity-40 line-through' : ''}`}>
              <td className="p-2">
                <div className="flex items-center gap-2">
                  {/* Mam (2026-06-02): per-user enable toggle.  When a
                      preview user is picked, this controls whether the
                      KPI counts for THAT user.  Disabled rows render
                      dimmed + struck-through.  Hidden when no user
                      picked (template editor mode). */}
                  {previewUserId && (
                    <input
                      type="checkbox"
                      checked={userEnabled}
                      onChange={e => saveUserSetting(k.id, { enabled: e.target.checked ? 1 : 0 })}
                      className="cursor-pointer flex-shrink-0"
                      title={userEnabled
                        ? `Untick to hide this KPI from ${previewUsers.find(u => u.user_id === previewUserId)?.name || 'this user'}'s scorecard.`
                        : 'Tick to include this KPI in the scorecard again.'}
                    />
                  )}
                  <input className="input text-xs" defaultValue={k.group_name} onBlur={e => updateKpi(k, { group_name: e.target.value })} />
                </div>
              </td>
              <td className="p-2"><input className="input text-xs" defaultValue={k.metric_name} onBlur={e => updateKpi(k, { metric_name: e.target.value })} /></td>
              <td className="p-2">
                {previewUserId ? (
                  /* Per-user weight override (Option B).  Empty = falls
                     back to template default. */
                  <div>
                    <input
                      type="number" step="0.1"
                      className={`input text-xs text-center ${hasWeightOverride ? 'border-emerald-400 bg-emerald-50' : ''}`}
                      key={`uw-${previewUserId}-${k.id}-${userWeight ?? 'def'}`}
                      defaultValue={hasWeightOverride ? userWeight : k.weightage}
                      onBlur={e => {
                        const v = e.target.value;
                        const num = +v;
                        if (hasWeightOverride) {
                          if (v === '') saveUserSetting(k.id, { weight_override: null });
                          else if (num !== +userWeight) saveUserSetting(k.id, { weight_override: num });
                        } else {
                          if (v !== '' && num !== (+k.weightage || 0)) saveUserSetting(k.id, { weight_override: num });
                        }
                      }}
                      title={hasWeightOverride
                        ? `Per-user weight (template default: ${k.weightage}%)`
                        : `Falls back to template weight ${k.weightage}%.  Edit to override for this user.`}
                    />
                    <div className="text-[9px] mt-0.5 text-center">
                      {hasWeightOverride
                        ? <span className="text-emerald-700 font-semibold">user weight</span>
                        : <span className="text-gray-400">default: {k.weightage}</span>}
                    </div>
                  </div>
                ) : (
                  <input type="number" className="input text-xs text-center" defaultValue={k.weightage} onBlur={e => updateKpi(k, { weightage: +e.target.value })} />
                )}
              </td>
              {/* Target column — three modes:
                  1. Auto source (locked): shows "auto" pill, target comes
                     from computeAutoCount's `given`.
                  2. Manual + no preview user: edits the TEMPLATE default
                     (k.default_planned) — fallback for everyone.
                  3. Manual + preview user picked: edits the PER-USER
                     override (mam 2026-06-02: "same target weekly but
                     per-user").  Empty → falls back to template default.
                     A small chip below the input shows which mode is
                     active so mam doesn't accidentally change the wrong
                     one. */}
              <td className="p-2">
                {(() => {
                  const isAuto = k.data_source && k.data_source.startsWith('auto:');
                  const AUTO_KEEPS_MANUAL_TARGET = ['auto:dpr_profit_by_user'];
                  const autoLocksTarget = isAuto && !AUTO_KEEPS_MANUAL_TARGET.includes(k.data_source);
                  if (autoLocksTarget) {
                    return (
                      <div className="text-center text-[10px] text-blue-700 bg-blue-50 border border-blue-200 rounded px-1 py-1 cursor-help"
                           title={`Target is computed live from ${k.data_source.replace('auto:', '')} — count of items given to the user in the scoring period.`}>
                        auto
                      </div>
                    );
                  }
                  // Per-user override mode (preview user picked)
                  if (previewUserId) {
                    const overrideVal = userTargets[k.id];
                    const hasOverride = overrideVal != null;
                    return (
                      <div>
                        <input
                          type="number" step="0.1"
                          className={`input text-xs text-center ${hasOverride ? 'border-emerald-400 bg-emerald-50' : ''}`}
                          // controlled via key so switching user remounts the input with fresh defaultValue
                          key={`utg-${previewUserId}-${k.id}-${overrideVal ?? 'def'}`}
                          defaultValue={hasOverride ? overrideVal : (k.default_planned || 0)}
                          onBlur={e => {
                            const v = e.target.value;
                            const num = +v;
                            // Save only if value differs from current state
                            if (hasOverride) {
                              if (v === '' || num === 0) saveUserTarget(k.id, '');         // remove override
                              else if (num !== +overrideVal) saveUserTarget(k.id, num);
                            } else {
                              // No override yet — only save if mam typed a NON-default value
                              if (v !== '' && num !== (+k.default_planned || 0)) saveUserTarget(k.id, num);
                            }
                          }}
                          title={hasOverride ? `Per-user target (override of template default ${k.default_planned})` : `Falls back to template default (${k.default_planned}). Edit to override for this user.`}
                        />
                        <div className="text-[9px] mt-0.5 text-center">
                          {hasOverride
                            ? <span className="text-emerald-700 font-semibold">user override</span>
                            : <span className="text-gray-400">default: {k.default_planned || 0}</span>}
                        </div>
                      </div>
                    );
                  }
                  // No preview user — editing the TEMPLATE default for everyone.
                  return (
                    <input
                      type="number" step="0.1"
                      className="input text-xs text-center"
                      defaultValue={k.default_planned || 0}
                      onBlur={e => updateKpi(k, { default_planned: +e.target.value })}
                      title="Template default — applies to every user assigned to this template (unless overridden per-user)."
                    />
                  );
                })()}
              </td>
              <td className="p-2">
                <select className="select text-xs" defaultValue={k.direction} onChange={e => updateKpi(k, { direction: e.target.value })}>
                  <option value="higher_better">↑ higher</option>
                  <option value="lower_better">↓ lower</option>
                </select>
              </td>
              <td className="p-2">
                <select key={`src-${k.id}-${raciModules.length}`} className="select text-xs" defaultValue={k.data_source} onChange={e => updateKpi(k, { data_source: e.target.value })}>
                  <option value="manual">manual entry</option>
                  <optgroup label="Tasks & Tickets">
                    <option value="auto:delegations">delegations (assigned/done)</option>
                    <option value="auto:pms">pms tasks (assigned/done)</option>
                    <option value="auto:checklists">checklists (per day)</option>
                    <option value="auto:tickets">help tickets (assigned/resolved)</option>
                    <option value="auto:activity_log">activity log — data entries (by user)</option>
                  </optgroup>
                  <optgroup label="Owner / Company-wide (ALL records)">
                    <option value="auto:pms_all">PMS tasks — ALL (company-wide)</option>
                    <option value="auto:delegations_all">Delegations — ALL (company-wide)</option>
                    <option value="auto:tickets_all">Help tickets — ALL (company-wide)</option>
                    <option value="auto:erp_module_coverage">Sotyn.Headmasters module coverage (how many ran)</option>
                  </optgroup>
                  <optgroup label="Responsibility (RACI / SLA)">
                    <option value="auto:raci_steps_done">RACI steps closed (all modules)</option>
                    <option value="auto:raci_ontime_pct">RACI on-time % (within SLA)</option>
                  </optgroup>
                  <RaciStepOptions modules={raciModules} />
                  <optgroup label="DPR (Daily Project Report)">
                    <option value="auto:dpr_profit">DPR profit (planned vs actual ₹) [site]</option>
                    <option value="auto:dpr_count">DPR count (6 days/week target) [site]</option>
                    <option value="auto:dpr_by_user">DPR submitted BY user (count)</option>
                    <option value="auto:dpr_profit_by_user">DPR profit/loss SUM (by user)</option>
                    <option value="auto:dpr_cost_by_user">DPR submitted vs approved (by user)</option>
                  </optgroup>
                  <optgroup label="Sales / CRM">
                    <option value="auto:leads_created">leads created (assigned to user)</option>
                    <option value="auto:leads_qualified">leads qualified (by user)</option>
                    <option value="auto:quotations_sent">quotations sent (by user)</option>
                    <option value="auto:meetings_planned">meetings planned (this week)</option>
                    <option value="auto:crm_kitting">CRM full kitting — checkpoints logged (by user)</option>
                  </optgroup>
                  <optgroup label="Business Book">
                    <option value="auto:bb_entries">BB entries created (by user)</option>
                    <option value="auto:bb_po_amount">BB PO amount SUM (by user)</option>
                    <option value="auto:bb_sale_amount">BB Sale amount SUM (by user)</option>
                    <option value="auto:bb_advance">BB Advance received SUM (by user)</option>
                  </optgroup>
                  <optgroup label="Procurement (Indent → Dispatch)">
                    <option value="auto:indents_in_week">indents created (site)</option>
                    <option value="auto:indent_vs_bill">Indent vs Bill — indents raised vs sales bills (site)</option>
                    <option value="auto:items_complete">Itemwise complete — items with PO raised / total (all)</option>
                    <option value="auto:indents_approved">indents approved (by user)</option>
                    <option value="auto:vendor_pos_created">vendor POs created</option>
                    <option value="auto:purchase_bills">purchase bills received</option>
                    <option value="auto:dispatch_sent">dispatches sent (delivery notes)</option>
                    <option value="auto:material_received">material received (site)</option>
                  </optgroup>
                  <optgroup label="Inventory / Stock">
                    <option value="auto:stock_in">stock IN movements</option>
                    <option value="auto:stock_out">stock OUT movements</option>
                    <option value="auto:stock_to_site">stock issued to site</option>
                    <option value="auto:stock_updates">stock updates per site/week</option>
                    <option value="auto:tools_list">tools list per site</option>
                    <option value="auto:stock_at_site">stock at site flag</option>
                  </optgroup>
                  <optgroup label="Installation & Billing">
                    <option value="auto:installations_started">installations started</option>
                    <option value="auto:installations_completed">installations completed</option>
                    <option value="auto:sales_bills">sales bills raised</option>
                    <option value="auto:ra_bills">RA bills raised (site)</option>
                    <option value="auto:mb_filed">MB bills filed (count)</option>
                    <option value="auto:mb_signed">MB signed by client (site)</option>
                  </optgroup>
                  <optgroup label="Cash Flow / Collections">
                    <option value="auto:amount_received">amount received SUM (by user)</option>
                    <option value="auto:amount_received_all">amount received SUM (all)</option>
                    <option value="auto:amount_received_lakh">amount received — in LAKH (all, weekly)</option>
                    <option value="auto:receivables_outstanding_cr">receivables outstanding — in CRORE (all)</option>
                    <option value="auto:collections_count">collections count (by user)</option>
                    <option value="auto:receivables_outstanding">receivables outstanding SUM (owner)</option>
                    <option value="auto:receivables_count">receivables outstanding count (owner)</option>
                  </optgroup>
                  <optgroup label="Payment Required">
                    <option value="auto:payments_raised">payment requests raised (by user)</option>
                    <option value="auto:payments_approved">payment requests final-approved</option>
                    <option value="auto:payments_rejected">payment requests rejected</option>
                  </optgroup>
                  <optgroup label="HR Hiring">
                    <option value="auto:candidates_added">candidates added</option>
                    <option value="auto:candidates_shortlisted">candidates shortlisted</option>
                    <option value="auto:candidates_onboarded">candidates onboarded</option>
                  </optgroup>
                  <optgroup label="HR — Manpower">
                    <option value="auto:site_manpower">Site manpower — required vs actual (all projects)</option>
                    <option value="auto:attrition">Attrition — staff left count (↓ lower better, you set target)</option>
                  </optgroup>
                  <optgroup label="System / Engagement">
                    <option value="auto:daily_active_users">Daily Active users — avg/day vs total users (all)</option>
                    <option value="auto:data_entry_all">Data Entry — records entered company-wide (weekly)</option>
                  </optgroup>
                  <optgroup label="Attendance">
                    <option value="auto:attendance_present_days">attendance present days (target 6)</option>
                    <option value="auto:attendance_late_days">attendance late days</option>
                    <option value="auto:attendance_absent_days">attendance absent days</option>
                    <option value="auto:leaves_applied">leaves applied (by user)</option>
                  </optgroup>
                  <optgroup label="Complaints">
                    <option value="auto:complaints_raised">complaints raised</option>
                    <option value="auto:complaints_resolved">complaints resolved</option>
                  </optgroup>
                  <optgroup label="Master Data">
                    <option value="auto:customers_added">customers added</option>
                    <option value="auto:vendors_added">vendors added</option>
                  </optgroup>
                </select>
                {/* Mam (2026-06-02): "how plan actual say in template that
                    pick from here".  Plain-English mapping so admin sees
                    exactly which DB field feeds Plan vs Actual for this
                    KPI source.  Pulled from the SOURCE_INFO map at top
                    of file. */}
                {(() => {
                  const info = sourceInfoFor(k.data_source);
                  return (
                    <div className="mt-1 space-y-0.5 text-[9px] leading-tight">
                      <div className="flex items-start gap-1">
                        <span className="font-bold text-blue-700 whitespace-nowrap">Plan:</span>
                        <span className="text-gray-600">{info.plan}</span>
                      </div>
                      <div className="flex items-start gap-1">
                        <span className="font-bold text-emerald-700 whitespace-nowrap">Actual:</span>
                        <span className="text-gray-600">{info.actual}</span>
                      </div>
                    </div>
                  );
                })()}
              </td>
              {/* Actual preview (mam 2026-06-02) — live value from the
                  computeAutoCount path for the selected preview user.
                  Renders the actual value, with a small chip showing
                  whether the source returned data (📊 green if non-
                  zero, ⚪ gray if zero, ⚠ amber if not yet computed). */}
              <td className="p-2 text-center">
                {(() => {
                  if (!previewUserId) return <span className="text-gray-300 text-[10px]">—</span>;
                  if (previewLoading) return <span className="text-gray-400 text-[10px] italic">…</span>;
                  const row = previewKpis[k.id];
                  if (!row) return <span className="text-gray-300 text-[10px]">no data</span>;
                  const actual = row.actual ?? row.actual_value ?? null;
                  const isAuto = k.data_source && k.data_source.startsWith('auto:');
                  let cls = 'bg-gray-100 text-gray-500';
                  if (actual !== null && actual !== undefined && actual !== 0) {
                    cls = 'bg-emerald-100 text-emerald-800';
                  } else if (!isAuto) {
                    cls = 'bg-amber-50 text-amber-700';
                  }
                  return (
                    <div className="inline-flex items-center justify-center gap-1">
                      <span className={`text-[11px] font-bold px-2 py-0.5 rounded ${cls}`} title={`Live actual for ${row.metric_name || k.metric_name} · ${isAuto ? 'auto from ' + k.data_source.replace('auto:', '') : 'manual entry'}`}>
                        {actual !== null && actual !== undefined
                          ? (Number.isFinite(+actual) ? (+actual).toLocaleString('en-IN') : String(actual))
                          : '—'}
                      </span>
                    </div>
                  );
                })()}
              </td>
              <td className="p-2"><button onClick={() => delKpi(k)} className="text-red-500 hover:text-red-700"><FiTrash2 size={12} /></button></td>
            </tr>
            );
          })}
        </tbody>
      </table>

      {adding && (
        <form onSubmit={addKpi} className="border-t pt-3 grid grid-cols-2 gap-2">
          <input className="input text-sm" placeholder="Group (e.g. Weekly)" value={form.group_name} onChange={e => setForm(f => ({ ...f, group_name: e.target.value }))} />
          <input className="input text-sm" placeholder="Metric name" required value={form.metric_name} onChange={e => setForm(f => ({ ...f, metric_name: e.target.value }))} />
          <input type="number" className="input text-sm" placeholder="Weight %" value={form.weightage} onChange={e => setForm(f => ({ ...f, weightage: +e.target.value }))} />
          <input type="number" step="0.1" className="input text-sm" placeholder="Default Target (fixed Planned)" value={form.default_planned} onChange={e => setForm(f => ({ ...f, default_planned: +e.target.value }))} />
          <select className="select text-sm" value={form.direction} onChange={e => setForm(f => ({ ...f, direction: e.target.value }))}>
            <option value="higher_better">↑ higher better</option>
            <option value="lower_better">↓ lower better</option>
          </select>
          <select className="select text-sm col-span-2" value={form.data_source} onChange={e => setForm(f => ({ ...f, data_source: e.target.value }))}>
            <option value="manual">manual entry</option>
            <option value="auto:delegations">auto: delegations</option>
            <option value="auto:pms">auto: pms tasks</option>
            <option value="auto:checklists">auto: checklists</option>
            <option value="auto:tickets">auto: tickets</option>
            <option value="auto:raci_steps_done">auto: RACI steps (all modules)</option>
            <RaciStepOptions modules={raciModules} />
          </select>
          <div className="col-span-2 flex justify-end gap-2">
            <button type="button" onClick={() => setAdding(false)} className="btn btn-secondary text-sm">Cancel</button>
            <button type="submit" className="btn btn-primary text-sm">Add</button>
          </div>
        </form>
      )}
    </div>
  );
}

// ---------- Assign Templates ----------
function AssignTemplates({ assignments, templates, reload }) {
  const setTpl = async (uid, tid) => {
    try { await api.put(`/scoring/assignments/${uid}`, { template_id: tid || null }); reload(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="card p-0 overflow-x-auto">
      <table>
        <thead><tr><th>Employee</th><th>Dept</th><th>Role</th><th>Template</th></tr></thead>
        <tbody>
          {assignments.map(a => (
            <tr key={a.user_id}>
              <td className="font-medium">{a.name}</td>
              <td className="text-xs text-gray-500">{a.department || '-'}</td>
              <td className="text-xs text-gray-500">{a.role}</td>
              <td>
                <select className="select text-sm" value={a.template_id || ''} onChange={e => setTpl(a.user_id, e.target.value ? +e.target.value : null)}>
                  <option value="">— None —</option>
                  {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
