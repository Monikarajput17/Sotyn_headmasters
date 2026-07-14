// CMD Dashboard — Stage 2 (TOC View)
// Mirrors mam's HTML spec SEPL_CMD_TOC_Dashboard_v3.html section-by-section.
//
// Sections (top to bottom, same order as the spec):
//   1. Pulse · 8 TOC-aligned numbers (cash on hand, free cash, CCC,
//      free inventory, WIP, quote lead time, lead→PO, revenue/FTE)
//   2. Today's binding constraint (auto-derived from worst metric)
//   3. Cash engine (CCC waterfall, AR aging, 30-day forecast,
//      top 5 debtors, statutory dues)
//   4. Sales engine (quote LT distribution, lead→PO funnel,
//      loss reasons, pending quotes, conversion by source)
//   5. Ops/PM (WIP by project, on-time%, margin variance,
//      sites past target)
//   6. Inventory (split, free-to-use, slow+dead, stockouts)
//   7. People (KPI hit dist, revenue/FTE by fn, vacancy gap,
//      hire/promote/PIP recommendations)
//   8. Today's 3 TOC moves (Exploit / Subordinate / Elevate)

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import toast from 'react-hot-toast';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell,
  PieChart, Pie, AreaChart, Area, CartesianGrid,
} from 'recharts';
import {
  C, fmtINR, fmtNum, fmtPct,
  PageHeader, SectionHead, KpiTile, Card, MiniStat, Pill,
  TicksList, HBar, Row, ConstraintBanner, TocStep, StageTabs, DataGap,
} from '../components/cmdDashboardUi';
import { fmtDateTime } from '../utils/datetime';

const tooltipStyle = {
  contentStyle: { background: C.bg, border: `1px solid ${C.line}`, borderRadius: 6, color: C.ink, fontSize: 11 },
  labelStyle: { color: C.ink2 }, itemStyle: { color: C.ink },
};

// Pick the worst metric and craft the "binding constraint" statement.
function bindingConstraint(data) {
  const { pulse, cash } = data;
  if (pulse.ccc != null && pulse.ccc > 90) {
    return {
      stmt: `CASH CONVERSION CYCLE (${pulse.ccc} days). Every other problem is downstream of this.`,
      why: `With ${fmtINR(pulse.bank_balance)} bank and ${fmtINR(pulse.free_cash)} free cash, hiring or new spend would make the constraint worse, not better. Subordinate every decision today to shrinking CCC: bill faster, collect aggressively, liquidate idle inventory.`,
    };
  }
  if (cash.ar_aging.bucket_90_plus > pulse.bank_balance * 0.5) {
    return {
      stmt: `COLLECTIONS (${fmtINR(cash.ar_aging.bucket_90_plus)} stuck >90 days).`,
      why: `Outstanding receivables in the worst bucket exceed half the bank balance. Collection war room must run before any new sales effort.`,
    };
  }
  if (pulse.lead_to_po_pct != null && pulse.lead_to_po_pct < 25) {
    return {
      stmt: `SALES CONVERSION (${pulse.lead_to_po_pct}% lead→PO).`,
      why: `Below the 40% TOC threshold. Pipeline leak is the binding constraint until conversion improves — focus quote-in-4 rule and SC closeout discipline.`,
    };
  }
  return {
    stmt: 'No single binding constraint identified — system in balance.',
    why: 'All pulse metrics inside acceptable thresholds. Run weekly TOC review to keep system from drifting back.',
  };
}

export default function DashboardCMDToc() {
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [days, setDays] = useState(90);
  const [loading, setLoading] = useState(false);

  const load = async (d = days) => {
    setLoading(true);
    try { setData((await api.get(`/dashboards/cmd-detail?days=${d}`)).data); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed to load'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  if (!data) {
    return (
      <div style={{ background: C.bg, color: C.ink, padding: 32, margin: -8, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: C.ink2 }}>Loading TOC dashboard…</div>
      </div>
    );
  }

  const { pulse, cash, sales, operations, inventory, people, customer } = data;
  const constraint = bindingConstraint(data);

  // CCC waterfall data
  const cccWaterfall = [
    { name: 'DSO',    value: pulse.dso ?? 0, fill: C.red },
    { name: '+ DIO',  value: pulse.dio ?? 0, fill: C.amber },
    { name: '− DPO',  value: -(pulse.dpo ?? 0), fill: C.green },
    { name: '= CCC',  value: pulse.ccc ?? 0, fill: C.violet },
  ];

  // AR aging bars
  const arAgingChart = [
    { name: '0-30d',  value: Math.round(cash.ar_aging.bucket_0_30 / 100000), fill: C.green },
    { name: '31-60d', value: Math.round(cash.ar_aging.bucket_31_60 / 100000), fill: C.amber },
    { name: '61-90d', value: Math.round(cash.ar_aging.bucket_61_90 / 100000), fill: C.orange },
    { name: '>90d',   value: Math.round(cash.ar_aging.bucket_90_plus / 100000), fill: C.red },
  ];

  // Inventory split donut
  const invSplit = [
    { name: 'Free-to-use', value: inventory.free_to_use, fill: C.green },
    { name: 'Reserved',    value: inventory.reserved,    fill: C.blue },
    { name: 'Slow 180+',   value: inventory.slow_moving, fill: C.amber },
    { name: 'Dead 365+',   value: inventory.dead_stock,  fill: C.red },
  ];

  // Quote-loss reasons donut
  const lossChart = sales.loss_reasons.map((r, i) => ({
    name: r.reason || 'unset', value: r.c,
    fill: [C.red, C.amber, C.blue, C.violet, C.teal][i % 5],
  }));

  // Revenue per FTE by dept
  const revPerFteChart = people.revenue_per_fte_by_dept.map((r, i) => ({
    name: r.department,
    value: r.rev_per_fte ? Math.round(r.rev_per_fte / 100000) : 0,
    fill: r.rev_per_fte > 1e6 ? C.green : r.rev_per_fte > 5e5 ? C.amber : C.red,
  }));

  return (
    <div style={{ background: C.bg, color: C.ink, margin: -8, minHeight: '100vh', fontFamily: 'Inter, -apple-system, sans-serif', fontSize: 12 }}>
      <PageHeader
        title="SEPL Operating Console" tag="CMD · TOC v3"
        subtitle={`Sotyn.Headmasters · MEPF + Solar EPC · ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`}
        rightTop="Theory of Constraints — Identify · Exploit · Subordinate · Elevate · Repeat"
        rightSub="Path: 12 → 50 → 150 → 400 → 1000 → 2000 → 10,000 cr"
      />
      <StageTabs active="toc" onChange={(t) => t === 'op' && nav('/dashboard/cmd')} />

      <div style={{ padding: 14, display: 'grid', gap: 12, maxWidth: 1500, margin: '0 auto' }}>

        {/* ========== PULSE 8 ========== */}
        <SectionHead first>Pulse · 8 numbers (TOC-aligned)</SectionHead>
        <Row cols="strip">
          <KpiTile label="Cash on hand" value={fmtINR(pulse.bank_balance)} accent="amber"
            sub={pulse.runway_days != null ? `Runway ${pulse.runway_days}d` : '—'} />
          <KpiTile label="Free cash (deployable)" value={fmtINR(pulse.free_cash)} accent="red"
            sub={`Bank − 30d dues · ${pulse.bank_balance > 0 ? Math.round((pulse.free_cash / pulse.bank_balance) * 100) : 0}% of cash`} />
          <KpiTile label="CCC days (DSO+DIO−DPO)" value={pulse.ccc != null ? `${pulse.ccc}d` : '—'} accent="red"
            sub={`DSO ${pulse.dso ?? '—'} + DIO ${pulse.dio ?? '—'} − DPO ${pulse.dpo ?? '—'}`} />
          <KpiTile label="Free-to-use inventory" value={fmtINR(pulse.free_inventory)} accent="amber"
            sub={`${inventory.total > 0 ? Math.round((inventory.free_to_use / inventory.total) * 100) : 0}% of stock`} />
          <KpiTile label="WIP locked" value={fmtINR(pulse.wip_locked)} accent="blue"
            sub={`${operations.active_sites} active sites · unbilled ${fmtINR(pulse.wip_unbilled)}`} />
          <KpiTile label="Quote lead time" value={pulse.quote_lead_time_avg != null ? `${pulse.quote_lead_time_avg} d` : '—'} accent="red"
            sub={`target ≤4d · within SLA ${fmtPct(sales.quote_lead_time.within_sla_pct)}`} />
          <KpiTile label="Lead → PO conversion" value={fmtPct(pulse.lead_to_po_pct)} accent="red"
            sub={`target ≥40% · ${sales.funnel.leads} leads in window`} />
          <KpiTile label="Revenue per FTE" value={pulse.revenue_per_fte_monthly != null ? `${fmtINR(pulse.revenue_per_fte_monthly)}/mo` : '—'} accent="violet"
            sub={`${people.active_fte} active employees`} />
        </Row>

        {/* ========== BINDING CONSTRAINT ========== */}
        <SectionHead>Identify · Today's binding constraint</SectionHead>
        <ConstraintBanner label="★ TOC step 1 — the constraint" statement={constraint.stmt} why={constraint.why} />

        {/* ========== CASH ENGINE ========== */}
        <SectionHead>Problem #1 · Cash flow — CCC waterfall · AR · forecast</SectionHead>
        <Row cols="3">
          <Card title="CCC waterfall" meta="days"
            footer={pulse.dso > 60
              ? <><strong style={{ color: C.red }}>Biggest lever: DSO ({pulse.dso}d).</strong> Drop DSO to 60d → estimated cash unlock {fmtINR(cash.ar_outstanding * (pulse.dso - 60) / Math.max(1, pulse.dso))}.</>
              : 'CCC within target range.'}>
            <div style={{ height: 180 }}>
              <ResponsiveContainer>
                <BarChart data={cccWaterfall} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                  <CartesianGrid stroke={C.line} vertical={false} />
                  <XAxis dataKey="name" stroke={C.ink3} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis stroke={C.ink3} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}d`} />
                  <Tooltip {...tooltipStyle} formatter={(v) => `${v} days`} />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                    {cccWaterfall.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card title="AR aging" meta={`total ${fmtINR(cash.ar_outstanding)}`}>
            <div style={{ height: 180 }}>
              <ResponsiveContainer>
                <BarChart data={arAgingChart} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                  <CartesianGrid stroke={C.line} vertical={false} />
                  <XAxis dataKey="name" stroke={C.ink3} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis stroke={C.ink3} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => `₹${v}L`} />
                  <Tooltip {...tooltipStyle} formatter={(v) => `₹${v}L`} />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                    {arAgingChart.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5, marginTop: 6 }}>
              <MiniStat label="0–30d" value={fmtINR(cash.ar_aging.bucket_0_30)} />
              <MiniStat label="31–60" value={fmtINR(cash.ar_aging.bucket_31_60)} color={C.amber} />
              <MiniStat label="61–90" value={fmtINR(cash.ar_aging.bucket_61_90)} color={C.orange} />
              <MiniStat label=">90d"  value={fmtINR(cash.ar_aging.bucket_90_plus)} color={C.red} />
            </div>
          </Card>
          <Card title="30-day cash forecast" meta="free cash projection">
            <div style={{ height: 180 }}>
              <ResponsiveContainer>
                <AreaChart data={cash.cash_forecast_30d} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                  <defs>
                    <linearGradient id="g-toc-no" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.red} stopOpacity={0.5} />
                      <stop offset="100%" stopColor={C.red} stopOpacity={0.05} />
                    </linearGradient>
                    <linearGradient id="g-toc-yes" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.green} stopOpacity={0.5} />
                      <stop offset="100%" stopColor={C.green} stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={C.line} vertical={false} />
                  <XAxis dataKey="day" stroke={C.ink3} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis stroke={C.ink3} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => `₹${v}L`} />
                  <Tooltip {...tooltipStyle} formatter={(v) => `₹${v}L`} />
                  <Area type="monotone" dataKey="no_action" stroke={C.red} fill="url(#g-toc-no)" strokeWidth={2} />
                  <Area type="monotone" dataKey="with_actions" stroke={C.green} fill="url(#g-toc-yes)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Row>

        <Row cols="2">
          <Card title="Top 5 debtors" meta="collect today">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
              <thead><tr style={{ borderBottom: `1px solid ${C.line}` }}>
                <th style={{ textAlign: 'left', color: C.ink2, fontSize: 9.5, padding: '7px 5px', textTransform: 'uppercase' }}>Customer</th>
                <th style={{ textAlign: 'right', color: C.ink2, fontSize: 9.5, padding: '7px 5px', textTransform: 'uppercase' }}>Outstanding</th>
                <th style={{ textAlign: 'right', color: C.ink2, fontSize: 9.5, padding: '7px 5px', textTransform: 'uppercase' }}>Aging</th>
                <th style={{ textAlign: 'left', color: C.ink2, fontSize: 9.5, padding: '7px 5px', textTransform: 'uppercase' }}>Action today</th>
              </tr></thead>
              <tbody>{cash.top_5_debtors.length === 0 ? (
                <tr><td colSpan="4" style={{ textAlign: 'center', color: C.ink3, padding: 12 }}>—</td></tr>
              ) : cash.top_5_debtors.map((d, i) => (
                <tr key={i} style={{ borderBottom: i === cash.top_5_debtors.length - 1 ? 'none' : `1px solid ${C.line}` }}>
                  <td style={{ padding: '8px 5px' }}>{d.client_name?.slice(0, 22)}</td>
                  <td style={{ padding: '8px 5px', textAlign: 'right', fontWeight: 600 }}>{fmtINR(d.amt)}</td>
                  <td style={{ padding: '8px 5px', textAlign: 'right', color: d.days > 90 ? C.red : C.amber }}>{d.days}d</td>
                  {/* Action text derived live in cmdDashboard.js from
                      ageing_days bucket (mam 2026-05-30 audit). */}
                  <td style={{ padding: '8px 5px', fontSize: 11 }}>{d.action_today || (d.days > 90 ? 'Director call · escalate' : d.days > 60 ? 'Stop new dispatch · meet' : 'Reconcile + chase')}</td>
                </tr>
              ))}</tbody>
            </table>
          </Card>
          <Card title="Statutory · AP · payroll" meta="next 30d">
            <TicksList items={cash.statutory_dues.map(d => ({
              label: d.label,
              right: d.amount != null
                ? <span style={{ color: C[d.status] || C.ink2, fontWeight: 600 }}>{fmtINR(d.amount)}</span>
                : <Pill kind="blue">capture needed</Pill>
            }))} />
          </Card>
        </Row>

        {/* ========== SALES ENGINE ========== */}
        <SectionHead>Problem #2 + #3 · Quote lead time · Lead → PO conversion</SectionHead>
        <Row cols="3">
          <Card title="Quote lead time distribution" meta={`${days}d · ${sales.quote_lead_time.sample_size} quotes`}
            footer={sales.quote_lead_time.within_sla_pct != null ? `Within SLA (≤4d): ${sales.quote_lead_time.within_sla_pct}%` : null}>
            {sales.quote_lead_time.sample_size === 0 ? (
              <DataGap note="No leads linked to quotations in the window — link via quotations.lead_id when creating quotes." />
            ) : (
              <>
                <div style={{ height: 180 }}>
                  <ResponsiveContainer>
                    <BarChart data={sales.quote_lead_time.distribution} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                      <CartesianGrid stroke={C.line} vertical={false} />
                      <XAxis dataKey="bucket" stroke={C.ink3} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                      <YAxis stroke={C.ink3} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                      <Tooltip {...tooltipStyle} />
                      <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                        {sales.quote_lead_time.distribution.map((d, i) => <Cell key={i} fill={[C.green, C.green, C.amber, C.orange, C.red, '#A32D2D'][i]} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, marginTop: 8 }}>
                  <MiniStat label="Median" value={`${sales.quote_lead_time.median} d`} />
                  <MiniStat label="P90"    value={`${sales.quote_lead_time.p90} d`} color={C.red} />
                </div>
              </>
            )}
          </Card>
          <Card title="Lead → PO funnel" meta={`${days} days`}>
            {/* Mam (2026-05-22 audit fix): widths now derived from
                actual stage counts (% of Leads), not hardcoded
                100/78/54/41/22.  See sibling fix in DashboardCMD.jsx. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 4 }}>
              {(() => {
                const stages = [
                  ['Leads',       sales.funnel.leads,        C.blue,    '#fff'],
                  ['Qualified',   sales.funnel.qualified,    C.blue2,   '#fff'],
                  ['Quote sent',  sales.funnel.quoted,       '#7896E8', null  ],
                  ['Negotiation', sales.funnel.in_execution, C.amber,   null  ],
                  ['PO won',      sales.funnel.pos,          C.green,   '#fff'],
                ];
                const topVal = stages[0][1] || 0;
                return stages.map(([lbl, val, color, txt], i) => {
                  const w = topVal > 0 ? Math.max(2, Math.round((val / topVal) * 100)) : 0;
                  const prev = i > 0 ? stages[i - 1][1] : null;
                  const drop = prev > 0 && val < prev ? `−${Math.round((1 - val / prev) * 100)}%` : '·';
                  return (
                  <div key={lbl} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 50px', gap: 8, alignItems: 'center', fontSize: 11 }}>
                    <div style={{ height: 18, background: C.panel2, borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${w}%`, height: '100%', background: color, borderRadius: 3, display: 'flex', alignItems: 'center', padding: '0 8px', fontSize: 10, fontWeight: 600, color: txt || '#000' }}>{lbl}</div>
                    </div>
                    <div style={{ textAlign: 'right', fontWeight: 600, fontSize: 11.5 }}>{val}</div>
                    <div style={{ textAlign: 'right', fontSize: 10, color: C.red }}>{drop}</div>
                  </div>
                );
                });
              })()}
            </div>
            <div style={{ fontSize: 10.5, color: C.ink2, marginTop: 10, borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
              {sales.funnel.leads > 0 && sales.funnel.pos > 0
                ? <>Final conversion <strong>{Math.round((sales.funnel.pos / sales.funnel.leads) * 100)}%</strong> · benchmark 40%.</>
                : 'No funnel data in window.'}
            </div>
          </Card>
          <Card title="Quote-loss reasons" meta={`${sales.loss_reasons.length} categorised`}>
            {sales.loss_reasons.length === 0 ? (
              <DataGap note="No CRM Funnel rows with loss_reason set yet — add the field on Loss closing form." />
            ) : (
              <>
                <div style={{ height: 180 }}>
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie data={lossChart} dataKey="value" nameKey="name" innerRadius={40} outerRadius={70}>
                        {lossChart.map((d, i) => <Cell key={i} fill={d.fill} />)}
                      </Pie>
                      <Tooltip {...tooltipStyle} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ display: 'grid', gap: 4, marginTop: 6 }}>
                  {lossChart.slice(0, 5).map((d, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                      <span style={{ width: 9, height: 9, borderRadius: 2, background: d.fill }} />
                      <span style={{ color: C.ink2 }}>{d.name} · {d.value}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>
        </Row>

        <Row cols="2-1">
          <Card title="Top 8 quotes pending" meta="oldest first · close today">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
              <thead><tr style={{ borderBottom: `1px solid ${C.line}` }}>
                <th style={{ textAlign: 'left', color: C.ink2, fontSize: 9.5, padding: '7px 5px', textTransform: 'uppercase' }}>Quote</th>
                <th style={{ textAlign: 'left', color: C.ink2, fontSize: 9.5, padding: '7px 5px', textTransform: 'uppercase' }}>Client</th>
                <th style={{ textAlign: 'right', color: C.ink2, fontSize: 9.5, padding: '7px 5px', textTransform: 'uppercase' }}>Value</th>
                <th style={{ textAlign: 'right', color: C.ink2, fontSize: 9.5, padding: '7px 5px', textTransform: 'uppercase' }}>Days</th>
              </tr></thead>
              <tbody>{sales.pending_quotes.length === 0 ? (
                <tr><td colSpan="4" style={{ textAlign: 'center', color: C.ink3, padding: 12 }}>No pending quotes</td></tr>
              ) : sales.pending_quotes.map((q, i) => (
                <tr key={i} style={{ borderBottom: i === sales.pending_quotes.length - 1 ? 'none' : `1px solid ${C.line}` }}>
                  <td style={{ padding: '8px 5px' }}>{q.quotation_number}</td>
                  <td style={{ padding: '8px 5px' }}>{(q.client || '—').slice(0, 22)}</td>
                  <td style={{ padding: '8px 5px', textAlign: 'right' }}>{fmtINR(q.value)}</td>
                  <td style={{ padding: '8px 5px', textAlign: 'right', color: q.days_open > 14 ? C.red : q.days_open > 7 ? C.amber : C.ink2, fontWeight: q.days_open > 14 ? 600 : 400 }}>{q.days_open}d</td>
                </tr>
              ))}</tbody>
            </table>
          </Card>
          <Card title="Conversion by lead source">
            {sales.conversion_by_source.length === 0 ? (
              <DataGap note="Need leads with source_id set + status='won' transitions." />
            ) : sales.conversion_by_source.map((s, i) => (
              <HBar key={i} label={s.source} value={s.conversion_pct} suffix="%" max={100}
                color={s.conversion_pct >= 40 ? C.green : s.conversion_pct >= 25 ? C.amber : C.red} />
            ))}
            <div style={{ fontSize: 10.5, color: C.ink2, marginTop: 8, borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
              <strong>Action:</strong> double down on the green sources · cut effort on red.
            </div>
          </Card>
        </Row>

        {/* ========== OPERATIONS ========== */}
        <SectionHead>Problem #4 · Operations · Project management</SectionHead>
        <Row cols="3">
          <Card title="On-time milestone %" meta={`last ${days} days`}>
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <div style={{ fontSize: 42, fontWeight: 700, color: operations.on_time_milestone_pct >= 70 ? C.green : operations.on_time_milestone_pct >= 50 ? C.amber : C.red }}>
                {fmtPct(operations.on_time_milestone_pct)}
              </div>
              <div style={{ fontSize: 10, color: C.ink2, marginTop: 6 }}>
                DPR overall_status='on_track' / total
              </div>
            </div>
          </Card>
          <Card title="Sites past target close date" meta={`${operations.sites_past_target.length} flagged`}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
              <thead><tr style={{ borderBottom: `1px solid ${C.line}` }}>
                <th style={{ textAlign: 'left', color: C.ink2, fontSize: 9.5, padding: '7px 5px', textTransform: 'uppercase' }}>Project</th>
                <th style={{ textAlign: 'left', color: C.ink2, fontSize: 9.5, padding: '7px 5px', textTransform: 'uppercase' }}>Client</th>
                <th style={{ textAlign: 'right', color: C.ink2, fontSize: 9.5, padding: '7px 5px', textTransform: 'uppercase' }}>Slip days</th>
                <th style={{ textAlign: 'right', color: C.ink2, fontSize: 9.5, padding: '7px 5px', textTransform: 'uppercase' }}>Locked</th>
              </tr></thead>
              <tbody>{operations.sites_past_target.length === 0 ? (
                <tr><td colSpan="4" style={{ textAlign: 'center', color: C.ink3, padding: 12 }}>None past target</td></tr>
              ) : operations.sites_past_target.slice(0, 6).map((s, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${C.line}` }}>
                  <td style={{ padding: '8px 5px', fontFamily: 'monospace' }}>{s.project}</td>
                  <td style={{ padding: '8px 5px' }}>{(s.client || '—').slice(0, 14)}</td>
                  <td style={{ padding: '8px 5px', textAlign: 'right', color: s.slip_days > 30 ? C.red : C.amber, fontWeight: 600 }}>{s.slip_days}d</td>
                  <td style={{ padding: '8px 5px', textAlign: 'right' }}>{fmtINR(s.value)}</td>
                </tr>
              ))}</tbody>
            </table>
          </Card>
          <Card title="Margin variance">
            <DataGap note="Worst-5 project margin variance lives in /audit/kpi; surface here in v3.1." />
            <div style={{ marginTop: 12, fontSize: 11, color: C.ink2 }}>
              Active POs: <strong>{operations.active_sites}</strong> · billed share: <strong>{pulse.wip_locked > 0 ? Math.round(((pulse.wip_locked - pulse.wip_unbilled) / pulse.wip_locked) * 100) : 0}%</strong>
            </div>
          </Card>
        </Row>

        {/* ========== INVENTORY ========== */}
        <SectionHead>Inventory · TOC view (every ₹ here = ₹ not in cash)</SectionHead>
        <Row cols="4">
          <Card title="Inventory split" meta={`total ${fmtINR(inventory.total)}`}>
            <div style={{ height: 140 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={invSplit} dataKey="value" nameKey="name" innerRadius={35} outerRadius={62}>
                    {invSplit.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  </Pie>
                  <Tooltip {...tooltipStyle} formatter={(v) => fmtINR(v)} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div style={{ display: 'grid', gap: 4, marginTop: 6 }}>
              {invSplit.map((d, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: d.fill }} />
                  <span style={{ color: C.ink2, flex: 1 }}>{d.name}</span>
                  <span>{fmtINR(d.value)}</span>
                </div>
              ))}
            </div>
          </Card>
          <Card title="Free-to-use" meta={`${fmtINR(inventory.free_to_use)} deployable`}>
            <DataGap note="Item-level breakdown needs a list view — see Inventory page for the full table." />
          </Card>
          <Card title="Slow + dead stock" meta={`recover ~${fmtINR(inventory.slow_moving + inventory.dead_stock)}`}>
            <TicksList items={[
              { label: 'Slow-moving (180+ days)', right: <Pill kind="amber">{fmtINR(inventory.slow_moving)}</Pill> },
              { label: 'Dead stock (365+ days)', right: <Pill kind="red">{fmtINR(inventory.dead_stock)}</Pill> },
              { label: 'Liquidate at 60% margin', right: <Pill kind="green">→ {fmtINR((inventory.slow_moving + inventory.dead_stock) * 0.6)} cash</Pill> },
            ]} />
          </Card>
          <Card title="Stockout / drift">
            <DataGap note="Stockout cover days + material drift detection — add via stock_movements heuristic in v3.1." />
          </Card>
        </Row>

        {/* ========== PEOPLE ========== */}
        <SectionHead>Problem #5 · People — who to hire, whom to fire (data-backed)</SectionHead>
        <Row cols="3">
          <Card title="Revenue per FTE by function" meta={`last ${days} days`}>
            {revPerFteChart.length === 0 ? <DataGap note="No active employees grouped by department." /> : (
              <div style={{ height: 180 }}>
                <ResponsiveContainer>
                  <BarChart data={revPerFteChart} layout="vertical" margin={{ top: 5, right: 5, left: 60, bottom: 5 }}>
                    <XAxis type="number" stroke={C.ink3} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => `₹${v}L`} />
                    <YAxis type="category" dataKey="name" stroke={C.ink3} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={80} />
                    <Tooltip {...tooltipStyle} formatter={(v) => `₹${v}L per FTE`} />
                    <Bar dataKey="value" radius={[0, 3, 3, 0]}>
                      {revPerFteChart.map((d, i) => <Cell key={i} fill={d.fill} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>
          <Card title="KPI top performers" meta="last 30 days">
            {people.kpi_top.length === 0
              ? <DataGap note="No score_entries in last 30 days — Scorecard module needs entries." />
              : <TicksList items={people.kpi_top.map(t => ({ label: <><strong>{t.user}</strong></>, right: <Pill kind="green">{t.pct}%</Pill> }))} />}
          </Card>
          <Card title="KPI bottom (PIP / exit)" meta="last 30 days" accent="red">
            {people.kpi_bottom.length === 0
              ? <DataGap note="No score_entries to identify low performers." />
              : <TicksList items={people.kpi_bottom.map(t => ({ label: <><strong>{t.user}</strong></>, right: <Pill kind="red">{t.pct}%</Pill> }))} />}
            <div style={{ fontSize: 10, color: C.ink3, marginTop: 6, lineHeight: 1.45 }}>
              30-day PIP with weekly review · if no movement, exit.
            </div>
          </Card>
        </Row>

        {/* ========== 3 TOC MOVES ========== */}
        <SectionHead>Today's 3 moves · TOC steps Exploit · Subordinate · Elevate</SectionHead>
        <Row cols="3eq">
          <TocStep kind="exploit" title="★ Exploit (no spend)"
            body={<>
              <strong>Run a {Math.min(7, cash.top_5_debtors.length)}-day collection war room.</strong> CMD calls top {cash.top_5_debtors.length} debtors personally
              {cash.top_5_debtors.length > 0 && <> ({cash.top_5_debtors[0].client_name?.slice(0, 14)} {fmtINR(cash.top_5_debtors[0].amt)} · {cash.top_5_debtors[1]?.client_name?.slice(0, 14) || ''} {cash.top_5_debtors[1] ? fmtINR(cash.top_5_debtors[1].amt) : ''})</>}.
              Block new dispatches until payment terms re-signed. Liquidate slow-moving stock at 60% → <strong style={{ color: C.green }}>{fmtINR((inventory.slow_moving + inventory.dead_stock) * 0.6)} cash unlocked</strong>.
            </>}
            owner={`Owner: CMD · Decision: today 17:00 · Cost: zero`}
          />
          <TocStep kind="subord" title="★ Subordinate (align everything)"
            body={<>
              <strong>Quote-in-4 rule.</strong> No quote leaves the office after 4 days from RFQ.
              COO triages quote queue twice daily until Sales Head joins. Sales subordinated to Cash:
              decline tenders &lt;18% margin or with payment terms &gt; 60 days. Site engineers must hit milestone <em>and</em> file DPR before next material indent is released.
            </>}
            owner="Owner: COO · Effective: tomorrow 09:00 · Cost: zero"
          />
          <TocStep kind="elevate" title="★ Elevate (invest)"
            body={<>
              <strong>Hire Collections Officer</strong> (~₹40K/mo) &amp; deploy <strong>invoice-on-milestone automation</strong> in Sotyn.Headmasters (auto-generate RA bill within 24h of milestone — TOC v3 P0 #4, IT build).
              Negotiate vendor DPO from {pulse.dpo ?? '—'} → 45 days with top 3 vendors.<br />
              <strong style={{ color: C.green }}>Target: CCC {pulse.ccc ?? '—'} → 90 days in 60 days.</strong>
            </>}
            owner="Owner: CFO + IT Head · Approve today · Cost ~₹40K/mo"
          />
        </Row>

        {/* Footer */}
        <div style={{ marginTop: 6, padding: '14px 18px', background: '#0E1116', color: C.ink3, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 10.5, lineHeight: 1.6 }}>
          <strong style={{ color: C.ink }}>TOC discipline:</strong> Don't try to fix everything. Identify the binding constraint, exploit it
          until it's no longer binding, subordinate every other function to it, then elevate it with investment.
          Only after CCC ≤ 90 days do we shift focus to the next constraint.
          <br /><br />
          <strong style={{ color: C.ink }}>Live data source:</strong> <code>/api/dashboards/cmd-detail</code> · spec_version {data.spec_version} · generated {fmtDateTime(data.generated_at)}.
        </div>
      </div>
    </div>
  );
}
