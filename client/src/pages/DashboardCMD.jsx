// CMD Dashboard — Stage 1 (Operating Console)
// Mirrors mam's HTML spec SEPL_CMD_Single_Page_Dashboard_v2.html
// section-by-section, wired to /api/dashboards/cmd-detail.
//
// Reading order documented at the bottom of the page (same as spec):
//   Pulse 8 → Escalation → Funnel + Vertical + Source →
//   Sales (booking trend, top customers, pipeline) →
//   Site execution (snags, DPR, aging) →
//   Procurement (top vendors, inventory exceptions) →
//   Cash (AR aging, top debtors, position) →
//   People (headcount, attendance, KPI top/bottom, risk) →
//   Customer (complaints, AMC, predictive flags) →
//   Decisions (3 levers today)

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import toast from 'react-hot-toast';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell,
  PieChart, Pie, LineChart, Line, AreaChart, Area, CartesianGrid,
} from 'recharts';
import {
  C, fmtINR, fmtNum, fmtPct,
  PageHeader, SectionHead, KpiTile, Card, MiniStat, Pill,
  FunnelBar, TicksList, HBar, Row, ConstraintBanner, StageTabs, DataGap,
} from '../components/cmdDashboardUi';
import { fmtDateTime } from '../utils/datetime';

const tooltipStyle = {
  contentStyle: { background: C.bg, border: `1px solid ${C.line}`, borderRadius: 6, color: C.ink, fontSize: 11 },
  labelStyle: { color: C.ink2 }, itemStyle: { color: C.ink },
};

export default function DashboardCMD() {
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [days, setDays] = useState(90);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const load = async (d = days) => {
    setLoading(true); setErr(null);
    try {
      const r = await api.get(`/dashboards/cmd-detail?days=${d}`);
      setData(r.data);
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
      toast.error('Could not load CMD dashboard');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  if (err && !data) {
    return (
      <div style={{ background: C.bg, color: C.ink, padding: 24, margin: -8, minHeight: '100vh' }}>
        <h1 style={{ fontSize: 18, fontWeight: 700 }}>CMD Dashboard</h1>
        <p style={{ color: C.red, marginTop: 12 }}>Failed to load: {err}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div style={{ background: C.bg, color: C.ink, padding: 32, margin: -8, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: C.ink2 }}>Loading dashboard…</div>
      </div>
    );
  }

  const { pulse, cash, sales, operations, inventory, procurement, people, customer, data_quality } = data;

  // Chart series prep
  const arAgingChart = [
    { name: '0-30d',  value: Math.round(cash.ar_aging.bucket_0_30 / 100000),  fill: C.green },
    { name: '31-60d', value: Math.round(cash.ar_aging.bucket_31_60 / 100000), fill: C.amber },
    { name: '61-90d', value: Math.round(cash.ar_aging.bucket_61_90 / 100000), fill: C.orange },
    { name: '>90d',   value: Math.round(cash.ar_aging.bucket_90_plus / 100000), fill: C.red },
  ];
  const verticalChart = sales.vertical_mix.map((v, i) => ({
    name: v.category || '—', value: v.value,
    fill: [C.blue, C.amber, C.teal, C.violet, C.pink, C.orange][i % 6],
  }));
  const leadSourceChart = sales.lead_source_mix.map((v, i) => ({
    name: v.source, value: v.cnt,
    fill: [C.violet, C.blue, C.teal, C.amber, C.pink][i % 5],
  }));
  const snagsChart = operations.snags_by_priority.map((s, i) => ({
    name: s.priority || 'unset', value: s.cnt,
    fill: { critical: C.red, high: C.orange, medium: C.amber, low: C.green }[s.priority] || C.ink3,
  }));
  const dprChart = [
    { name: 'On time', value: operations.dpr.on_time, fill: C.green },
    { name: 'Missed',  value: operations.dpr.missed,  fill: C.red },
  ];
  const pipelineChart = sales.pipeline_by_stage.map((s, i) => ({
    name: s.stage, value: Math.round(s.value / 100000),
    fill: [C.blue, C.blue2, C.orange, C.amber, C.red, C.green][i % 6],
  }));
  const cashForecastChart = cash.cash_forecast_30d;

  return (
    <div style={{ background: C.bg, color: C.ink, margin: '-8px -8px -8px -8px', minHeight: '100vh', fontFamily: 'Inter, -apple-system, sans-serif', fontSize: 12 }}>
      <PageHeader
        title="SEPL Operating Console" tag="CMD VIEW"
        subtitle={`Sotyn.Headmasters · MEPF + Solar EPC · ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} · ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} IST`}
        rightTop={<>
          <select value={days} onChange={e => { setDays(+e.target.value); load(+e.target.value); }}
            style={{ background: C.panel, color: C.ink, border: `1px solid ${C.line}`, padding: '4px 10px', borderRadius: 4, fontSize: 11 }}>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={180}>6 months</option>
            <option value={365}>1 year</option>
          </select>
          <span style={{ marginLeft: 8 }}>Refresh: 7:30 AM daily · Data: securederp.in</span>
        </>}
        rightSub="Path: 12 → 50 → 150 → 400 → 1000 → 2000 → 10,000 cr"
      />
      <StageTabs active="op" onChange={(t) => t === 'toc' && nav('/dashboard/cmd-toc')} />

      <div style={{ padding: 14, display: 'grid', gap: 12, maxWidth: 1500, margin: '0 auto' }}>

        {/* ============ PULSE 8 ============ */}
        <SectionHead first>Pulse · 8 numbers that decide today</SectionHead>
        <Row cols="strip">
          <KpiTile label="Bank balance" value={fmtINR(pulse.bank_balance)} accent="amber"
            sub={pulse.runway_days != null ? `Runway ${pulse.runway_days}d` : 'no burn data'} />
          <KpiTile label="Order book" value={fmtINR(pulse.order_book)} accent="red"
            sub={`${pulse.order_book_count} PO · ${operations.active_sites} active sites`} />
          <KpiTile label="Revenue MTD" value={fmtINR(pulse.revenue_mtd)} accent="blue"
            sub="vs MTD target — set in EmailSettings" />
          <KpiTile label="CCC days" value={pulse.ccc != null ? `${pulse.ccc}d` : '—'} accent="violet"
            sub={`DSO ${pulse.dso ?? '—'} + DIO ${pulse.dio ?? '—'} − DPO ${pulse.dpo ?? '—'}`} />
          <KpiTile label="DPR adherence" value={fmtPct(pulse.dpr_adherence_pct)} accent={pulse.dpr_adherence_pct >= 80 ? 'green' : 'red'}
            sub={`${operations.active_sites - operations.dpr.on_time} sites missed today`} />
          <KpiTile label="Open snags" value={fmtNum(pulse.open_snags)} accent="amber"
            sub={pulse.oldest_snag_days ? `oldest ${pulse.oldest_snag_days}d` : 'none open'} />
          <KpiTile label="Free inventory" value={fmtINR(pulse.free_inventory)} accent="teal"
            sub={`of ${fmtINR(inventory.total)} total`} />
          <KpiTile label="Lead → PO" value={fmtPct(pulse.lead_to_po_pct)} accent={pulse.lead_to_po_pct >= 40 ? 'green' : 'red'}
            sub={`${sales.funnel.leads} leads / ${sales.funnel.in_execution} executing`} />
        </Row>

        {/* ============ ESCALATION BANNER ============ */}
        {(data_quality.junk_pos.length > 0 || cash.cost_of_inaction_daily > 0) && (
          <div style={{
            background: 'linear-gradient(90deg, rgba(229,72,77,.18) 0%, rgba(229,72,77,.05) 100%)',
            border: '1px solid rgba(229,72,77,.4)', borderLeft: `3px solid ${C.red}`,
            borderRadius: 6, padding: '9px 14px', fontSize: 11.5, color: '#FFCDCB',
          }}>
            <strong style={{ color: C.red }}>ESCALATION: </strong>
            Cost-of-inaction ≈ <strong>{fmtINR(cash.cost_of_inaction_daily)}/day</strong>
            {data_quality.junk_pos.length > 0 ? (
              <> · {data_quality.junk_pos.length} junk PO numbers totalling <strong>{fmtINR(data_quality.junk_po_total)}</strong> ({data_quality.junk_pos.map(p => p.po_number).join(' · ')})</>
            ) : null}
          </div>
        )}

        {/* ============ FUNNEL + VERTICAL + LEAD SOURCE ============ */}
        <SectionHead>Business cycle · Lead → Quote → PO → Site → Bill → Cash</SectionHead>
        <Row cols="3">
          <Card title="Full lead-to-cash funnel" meta={`last ${days} days`}>
            {/* Mam (2026-05-22 audit fix): the bar widths used to be
                hardcoded (78%, 54%, 32%, 21%, 11%, 6%) so the visual
                lied about actual conversion.  Now they're computed
                from each stage's count as a % of the LEAD count (the
                full-funnel top stage) — a stage at zero shows a 0%-
                wide bar, and the visual matches the numbers below. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 4 }}>
              {(() => {
                const stages = [
                  ['Leads received', sales.funnel.leads,        C.blue,    '#fff'],
                  ['Qualified',      sales.funnel.qualified,    C.blue2,   '#fff'],
                  ['Quotes sent',    sales.funnel.quoted,       '#7896E8', null  ],
                  ['POs received',   sales.funnel.pos,          C.amber,   null  ],
                  ['In execution',   sales.funnel.in_execution, C.orange,  '#fff'],
                  ['Billed',         sales.funnel.billed,       C.red,     '#fff'],
                  ['Cash collected', sales.funnel.collected,    C.green,   '#fff'],
                ];
                const topVal = stages[0][1] || 0;   // Leads received drives the 100% reference
                return stages.map(([lbl, val, color, txt], i) => {
                  // Width as % of top funnel stage; minimum 2% so 0-count
                  // bars are still faintly visible (otherwise the row collapses).
                  const w = topVal > 0 ? Math.max(2, Math.round((val / topVal) * 100)) : 0;
                  const prev = i > 0 ? stages[i - 1][1] : null;
                  const drop = prev > 0 && val < prev ? `−${Math.round((1 - val / prev) * 100)}%` : '·';
                  return <FunnelBar key={lbl} label={lbl} value={val} drop={drop} width={w} color={color} textColor={txt} />;
                });
              })()}
            </div>
            <div style={{ fontSize: 10.5, color: C.ink2, marginTop: 10, borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
              <strong style={{ color: C.red }}>Biggest leak: Bill → Cash ·</strong>
              {' '}AR &gt; 90d {fmtINR(cash.ar_aging.bucket_90_plus)} · Collection Engine RED.
            </div>
          </Card>
          <Card title="Vertical mix" meta={`order book ${fmtINR(pulse.order_book)}`}>
            <div style={{ height: 180 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={verticalChart} dataKey="value" nameKey="name" innerRadius={45} outerRadius={75} paddingAngle={2}>
                    {verticalChart.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  </Pie>
                  <Tooltip {...tooltipStyle} formatter={(v) => fmtINR(v)} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div style={{ display: 'grid', gap: 4, marginTop: 8 }}>
              {verticalChart.slice(0, 4).map((d, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: d.fill }} />
                  <span style={{ color: C.ink2 }}>{d.name} — {fmtINR(d.value)}</span>
                </div>
              ))}
            </div>
          </Card>
          <Card title="Lead source mix" meta={`last ${days} days`}>
            <div style={{ height: 180 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={leadSourceChart} dataKey="value" nameKey="name" outerRadius={75}>
                    {leadSourceChart.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  </Pie>
                  <Tooltip {...tooltipStyle} formatter={(v) => `${v} leads`} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div style={{ display: 'grid', gap: 4, marginTop: 8 }}>
              {leadSourceChart.map((d, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: d.fill }} />
                  <span style={{ color: C.ink2 }}>{d.name} · {d.value}</span>
                </div>
              ))}
            </div>
          </Card>
        </Row>

        {/* ============ SALES & ORDER BOOK ============ */}
        <SectionHead>Sales · Order Book · Customers</SectionHead>
        <Row cols="3">
          <Card title="Booking trend" meta="last 12 weeks · ₹ L">
            <div style={{ height: 180 }}>
              <ResponsiveContainer>
                <AreaChart data={sales.booking_trend_12w} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                  <defs>
                    <linearGradient id="g-mepf" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.blue} stopOpacity={0.6} />
                      <stop offset="100%" stopColor={C.blue} stopOpacity={0.1} />
                    </linearGradient>
                    <linearGradient id="g-solar" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.amber} stopOpacity={0.6} />
                      <stop offset="100%" stopColor={C.amber} stopOpacity={0.1} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={C.line} vertical={false} />
                  <XAxis dataKey="week" stroke={C.ink3} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis stroke={C.ink3} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip {...tooltipStyle} />
                  <Area type="monotone" dataKey="mepf" stroke={C.blue} fill="url(#g-mepf)" strokeWidth={2} />
                  <Area type="monotone" dataKey="solar" stroke={C.amber} fill="url(#g-solar)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card title="Top 5 customers" meta="share of order book">
            {sales.top_customers.length === 0 ? <DataGap note="No business_book rows with po_amount > 0 yet." /> : (() => {
              const max = sales.top_customers[0]?.total_order || 1;
              return sales.top_customers.map((c, i) => (
                <HBar key={i} label={(c.client || c.company || '—').slice(0, 14)}
                  value={fmtINR(c.total_order)} max={max} color={[C.blue, C.blue2, C.amber, C.teal, C.violet][i]} />
              ));
            })()}
            <div style={{ fontSize: 10.5, color: C.ink2, marginTop: 8, borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
              Top 2 concentration: <strong>{(sales.top_customers[0]?.share_pct || 0) + (sales.top_customers[1]?.share_pct || 0)}%</strong>
            </div>
          </Card>
          <Card title="Pipeline by stage" meta="value ₹ L">
            <div style={{ height: 180 }}>
              <ResponsiveContainer>
                <BarChart data={pipelineChart} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                  <CartesianGrid stroke={C.line} vertical={false} />
                  <XAxis dataKey="name" stroke={C.ink3} tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                  <YAxis stroke={C.ink3} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip {...tooltipStyle} formatter={(v) => `₹${v}L`} />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                    {pipelineChart.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Row>

        {/* ============ SITE EXECUTION ============ */}
        <SectionHead>Site execution · MEPF discipline split</SectionHead>
        <Row cols="3">
          <Card title="Snag categories" meta={`${customer.complaints_by_priority.reduce((s, r) => s + r.cnt, 0)} open`}>
            <div style={{ height: 180 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={snagsChart} dataKey="value" nameKey="name" innerRadius={40} outerRadius={70}>
                    {snagsChart.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  </Pie>
                  <Tooltip {...tooltipStyle} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div style={{ display: 'grid', gap: 4, marginTop: 8 }}>
              {snagsChart.map((d, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: d.fill }} />
                  <span style={{ color: C.ink2 }}>{d.name} · {d.value}</span>
                </div>
              ))}
            </div>
          </Card>
          <Card title="DPR adherence today" meta={`${operations.active_sites} sites live`}>
            <div style={{ height: 180 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={dprChart} dataKey="value" nameKey="name" innerRadius={45} outerRadius={75}>
                    {dprChart.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  </Pie>
                  <Tooltip {...tooltipStyle} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 6 }}>
              <MiniStat label="On time" value={fmtNum(operations.dpr.on_time)} color={C.green} />
              <MiniStat label="Late" value={fmtNum(operations.dpr.late)} color={C.amber} />
              <MiniStat label="Missed" value={fmtNum(operations.dpr.missed)} color={C.red} />
            </div>
          </Card>
          <Card title="Snag aging" meta="days open">
            <div style={{ height: 180 }}>
              <ResponsiveContainer>
                <BarChart data={operations.snag_aging} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                  <CartesianGrid stroke={C.line} vertical={false} />
                  <XAxis dataKey="bucket" stroke={C.ink3} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis stroke={C.ink3} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip {...tooltipStyle} />
                  <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                    {operations.snag_aging.map((d, i) => <Cell key={i} fill={['#46A758', '#46A758', '#FFB224', '#E5484D', '#A32D2D'][i]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Row>

        {/* ============ PROCUREMENT ============ */}
        <SectionHead>Procurement · Vendors · Inventory</SectionHead>
        <Row cols="3">
          <Card title="Top vendors by spend" meta={`last ${days}d`}>
            {procurement.top_vendors.length === 0 ? <DataGap note="No purchase_bills.vendor_id yet — vendor-PO flow needed first." /> : (() => {
              const max = procurement.top_vendors[0]?.total_spend || 1;
              return procurement.top_vendors.map((v, i) => (
                <HBar key={v.id} label={(v.name || '—').slice(0, 14)}
                  value={fmtINR(v.total_spend)} max={max} color={[C.green, C.red, C.blue, C.amber, C.violet][i]} />
              ));
            })()}
          </Card>
          <Card title="Cash position" meta={pulse.runway_days != null ? `runway ${pulse.runway_days}d` : ''}>
            <div style={{ height: 180 }}>
              <ResponsiveContainer>
                <AreaChart data={cashForecastChart} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                  <defs>
                    <linearGradient id="g-cash-no" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.red} stopOpacity={0.5} />
                      <stop offset="100%" stopColor={C.red} stopOpacity={0.05} />
                    </linearGradient>
                    <linearGradient id="g-cash-yes" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.green} stopOpacity={0.5} />
                      <stop offset="100%" stopColor={C.green} stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={C.line} vertical={false} />
                  <XAxis dataKey="day" stroke={C.ink3} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis stroke={C.ink3} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => `₹${v}L`} />
                  <Tooltip {...tooltipStyle} formatter={(v) => `₹${v}L`} />
                  <Area type="monotone" dataKey="no_action" stroke={C.red} fill="url(#g-cash-no)" strokeWidth={2} />
                  <Area type="monotone" dataKey="with_actions" stroke={C.green} fill="url(#g-cash-yes)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card title="Inventory exceptions">
            <TicksList items={[
              { label: 'Free-to-use', right: <span style={{ color: C.green, fontWeight: 600 }}>{fmtINR(inventory.free_to_use)}</span> },
              { label: 'Reserved at sites', right: <span style={{ color: C.blue, fontWeight: 600 }}>{fmtINR(inventory.reserved)}</span> },
              { label: 'Slow-moving (180+ days)', right: <Pill kind="amber">{fmtINR(inventory.slow_moving)}</Pill> },
              { label: 'Dead stock (365+ days)', right: <Pill kind="red">{fmtINR(inventory.dead_stock)}</Pill> },
              { label: 'Total inventory value', right: <span style={{ fontWeight: 600 }}>{fmtINR(inventory.total)}</span> },
              { label: 'Free / total ratio', right: <span style={{ color: C.ink2 }}>{inventory.total > 0 ? Math.round((inventory.free_to_use / inventory.total) * 100) : 0}%</span> },
            ]} />
          </Card>
        </Row>

        {/* ============ AR / CASH ============ */}
        <SectionHead>Cash · AR aging · Collection</SectionHead>
        <Row cols="3">
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
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginTop: 8 }}>
              <MiniStat label="0–30d" value={fmtINR(cash.ar_aging.bucket_0_30)} />
              <MiniStat label="31–60" value={fmtINR(cash.ar_aging.bucket_31_60)} color={C.amber} />
              <MiniStat label="61–90" value={fmtINR(cash.ar_aging.bucket_61_90)} color={C.orange} />
              <MiniStat label=">90d"  value={fmtINR(cash.ar_aging.bucket_90_plus)} color={C.red} />
            </div>
          </Card>
          <Card title="Top 5 debtors" meta="overdue">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
              <thead><tr style={{ borderBottom: `1px solid ${C.line}` }}>
                <th style={{ textAlign: 'left', color: C.ink2, fontSize: 9.5, padding: '7px 5px', textTransform: 'uppercase' }}>Customer</th>
                <th style={{ textAlign: 'right', color: C.ink2, fontSize: 9.5, padding: '7px 5px', textTransform: 'uppercase' }}>Outstanding</th>
                <th style={{ textAlign: 'right', color: C.ink2, fontSize: 9.5, padding: '7px 5px', textTransform: 'uppercase' }}>Aging</th>
              </tr></thead>
              <tbody>
                {cash.top_5_debtors.length === 0 ? (
                  <tr><td colSpan="3" style={{ textAlign: 'center', color: C.ink3, padding: 12 }}>No outstanding receivables</td></tr>
                ) : cash.top_5_debtors.map((d, i) => (
                  <tr key={i} style={{ borderBottom: i === cash.top_5_debtors.length - 1 ? 'none' : `1px solid ${C.line}` }}>
                    <td style={{ padding: '8px 5px' }}>{d.client_name?.slice(0, 18) || '—'}</td>
                    <td style={{ padding: '8px 5px', textAlign: 'right', fontWeight: 600 }}>{fmtINR(d.amt)}</td>
                    <td style={{ padding: '8px 5px', textAlign: 'right', color: d.days > 90 ? C.red : d.days > 60 ? C.amber : C.ink2 }}>{d.days}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="Statutory · AP · payroll" meta="next 30d">
            <TicksList items={cash.statutory_dues.map(d => ({
              label: d.label,
              right: d.amount != null
                ? <span style={{ color: C[d.status] || C.ink2, fontWeight: 600 }}>{fmtINR(d.amount)}</span>
                : <span style={{ color: C.ink3, fontSize: 10 }}>capture needed</span>
            }))} />
          </Card>
        </Row>

        {/* ============ PEOPLE ============ */}
        <SectionHead>People · Attendance · KPI</SectionHead>
        <Row cols="4">
          <Card title="Headcount by function">
            <div style={{ height: 180 }}>
              <ResponsiveContainer>
                <BarChart data={people.headcount} layout="vertical" margin={{ top: 5, right: 5, left: 60, bottom: 5 }}>
                  <XAxis type="number" stroke={C.ink3} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="department" stroke={C.ink3} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={80} />
                  <Tooltip {...tooltipStyle} />
                  <Bar dataKey="cnt" radius={[0, 3, 3, 0]}>
                    {people.headcount.map((d, i) => <Cell key={i} fill={[C.blue, C.blue2, C.amber, C.teal, C.violet, C.pink][i % 6]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card title="Today's attendance">
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: C.green }}>
                {people.attendance_today.total > 0
                  ? Math.round((people.attendance_today.present / people.attendance_today.total) * 100) + '%'
                  : '—'}
              </div>
              <div style={{ fontSize: 10, color: C.ink2, marginTop: 3 }}>
                {people.attendance_today.present} of {people.attendance_today.total} present
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
              <MiniStat label="Leave" value={people.attendance_today.leave} />
              <MiniStat label="Absent" value={people.attendance_today.absent} color={C.red} />
              <MiniStat label="Late" value={people.attendance_today.late} color={C.amber} />
            </div>
          </Card>
          <Card title="KPI hit · top & bottom">
            <div style={{ fontSize: 10, color: C.green, fontWeight: 600, marginTop: 4 }}>TOP</div>
            {people.kpi_top.length === 0
              ? <DataGap note="No score_entries in last 30d." />
              : <TicksList items={people.kpi_top.map(t => ({ label: t.user, right: <span style={{ color: C.ink2 }}>{t.pct}%</span> }))} />}
            <div style={{ fontSize: 10, color: C.red, fontWeight: 600, marginTop: 8 }}>BOTTOM</div>
            {people.kpi_bottom.length === 0
              ? <div style={{ fontSize: 10, color: C.ink3, marginTop: 4 }}>—</div>
              : <TicksList items={people.kpi_bottom.map(t => ({ label: t.user, right: <span style={{ color: C.red }}>{t.pct}%</span> }))} />}
          </Card>
          <Card title="Predictive flags · 14d">
            {customer.predictive_flags.length === 0
              ? <div style={{ fontSize: 11, color: C.ink2, padding: 12 }}>No flags raised — system clear.</div>
              : <TicksList items={customer.predictive_flags.map(f => ({
                  label: f.label, right: <Pill kind={f.severity}>{f.detail}</Pill>
                }))} />}
          </Card>
        </Row>

        {/* ============ JUNK DATA WATCH ============ */}
        {data_quality.junk_pos.length > 0 && (
          <>
            <SectionHead>Data quality · Junk POs in book</SectionHead>
            <Card title="Junk-PO list" meta={`total ${fmtINR(data_quality.junk_po_total)} affected`}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                <thead><tr style={{ borderBottom: `1px solid ${C.line}` }}>
                  <th style={{ textAlign: 'left', color: C.ink2, fontSize: 9.5, padding: '7px 5px', textTransform: 'uppercase' }}>Lead No</th>
                  <th style={{ textAlign: 'left', color: C.ink2, fontSize: 9.5, padding: '7px 5px', textTransform: 'uppercase' }}>Client</th>
                  <th style={{ textAlign: 'left', color: C.ink2, fontSize: 9.5, padding: '7px 5px', textTransform: 'uppercase' }}>PO Number</th>
                  <th style={{ textAlign: 'right', color: C.ink2, fontSize: 9.5, padding: '7px 5px', textTransform: 'uppercase' }}>Amount</th>
                </tr></thead>
                <tbody>{data_quality.junk_pos.map((p, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${C.line}` }}>
                    <td style={{ padding: '8px 5px' }}>{p.lead_no}</td>
                    <td style={{ padding: '8px 5px' }}>{p.client_name?.slice(0, 24)}</td>
                    <td style={{ padding: '8px 5px', fontFamily: 'monospace', color: C.red }}>{p.po_number}</td>
                    <td style={{ padding: '8px 5px', textAlign: 'right', fontWeight: 600 }}>{fmtINR(p.po_amount)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </Card>
          </>
        )}

        {/* Footer */}
        <div style={{ marginTop: 6, padding: '14px 18px', background: '#0E1116', color: C.ink3, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 10.5, lineHeight: 1.6 }}>
          <strong style={{ color: C.ink }}>READING ORDER:</strong> Top KPI strip → Funnel + Vertical mix (1 min) → flag any RED tile → drill into the row.
          Sections ordered by money flow: Cycle → Sales (intake) → Execution (delivery) → Procurement (cost) → Cash (output) → People (capacity) → Customer (loyalty).
          <br /><br />
          <strong style={{ color: C.ink }}>RULE:</strong> If a tile turns RED 2 days running, a Cost-of-Inaction line is added at top — never "looks good." ·
          Refresh source: <code>/api/dashboards/cmd-detail</code> · spec_version {data.spec_version} · generated {fmtDateTime(data.generated_at)}.
        </div>
      </div>
    </div>
  );
}
