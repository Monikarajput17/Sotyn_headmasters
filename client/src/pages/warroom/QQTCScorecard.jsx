// QQTC Scorecard 2.0 — the War Room "Performance" tab.
//
// Replaces the old single-table PerformanceView with mam's full
// "KPI Scorecard 2.0 (QQTC)" dashboard (10 sub-tabs), wired to LIVE ERP data:
//   • /api/scoring/weekly      → per-person Quantity/Quality (delegations,
//                                PMS, checklists, tickets — given vs done)
//   • /api/scoring/templates   → role templates + live owner counts
//   • /api/scoring/assignments → who has a KPI template (ownership coverage)
//   • /api/raci/performance    → on-time % feeds the Time pillar
//   • /api/dashboards/cmd-detail → TOC pulse / funnel / AR (constraint view)
//
// The KPI *model* (the 4 QQTC pillars, weight presets, per-designation KPI
// designs, the gamification pipeline, the module audit) is authored content
// from qqtcDesign.js — it's the proposed framework, shown alongside the live
// reality. Time & Cost pillars are marked "pending" until their feeds exist.

import { useState, useEffect, useMemo } from 'react';
import api from '../../api';
import {
  QC, QLAB, QCOL, QQTC, WEIGHT_PRESETS, ACTIVITY_BUCKET,
  GAME, MODULE_AUDIT, FLOW_RULES, DESIGNATIONS, computeQQTC,
} from './qqtcDesign';

// Palette — matches DashboardWarRoom's C exactly so this drops into the
// cream War Room shell seamlessly.
const C = {
  bg: '#F5F4F0', card: '#FFFFFF', ink: '#0E1116', ink2: '#4A4F57',
  line: '#E5E2DA', red: '#D33A2C', amber: '#E2A52E', green: '#1F8A4A',
  blue: '#2C5BA1', violet: '#6B4AAF', soft: '#FAF8F4',
};

const fmtINR = (v) => {
  if (v == null || isNaN(v)) return '—';
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} cr`;
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`;
  if (Math.abs(v) >= 1e3) return `₹${(v / 1e3).toFixed(1)} K`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
};
const fmtNum = (v) => (v == null || isNaN(v) ? '—' : Math.round(v).toLocaleString('en-IN'));
const norm = (s) => (s || '').trim().toLowerCase();

// The 3 TOC moves (Exploit → Subordinate → Elevate) — advisory design.
const TOC_MOVES = [
  ['EXPLOIT (no spend)', 'Collection war room — CMD calls the top-5 debtors personally; block new dispatch until payment terms re-signed; liquidate slow stock.', 'CMD', C.red],
  ['SUBORDINATE (align all)', 'Quote-in-4 rule; decline tenders <18% margin or >60-day terms; no material indent released until DPR filed for that site.', 'COO', C.amber],
  ['ELEVATE (invest)', 'Assign a Billing owner + Collections Officer; build invoice-on-milestone automation (auto RA bill ≤24 h); negotiate vendor DPO 0→45 d.', 'CFO + IT', C.green],
];

// ─── tiny presentational helpers ──────────────────────────────────
const card = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, padding: 18 };
const secTitle = { fontSize: 11, letterSpacing: '1.2px', textTransform: 'uppercase', color: C.ink2, fontWeight: 700, margin: '26px 0 12px', display: 'flex', alignItems: 'center', gap: 8 };
const th = { textAlign: 'left', fontSize: 10.5, padding: '8px', color: C.ink2, textTransform: 'uppercase', letterSpacing: '.4px', whiteSpace: 'nowrap', fontWeight: 700 };
const td = { padding: '9px 8px', fontSize: 12.5, borderBottom: `1px solid ${C.line}`, verticalAlign: 'middle' };

const TAG = {
  green: { background: '#E0F1E5', color: '#15803d' }, red: { background: '#FCE7E5', color: '#b91c1c' },
  amber: { background: '#FFF4DC', color: '#9A6E12' }, blue: { background: '#E1ECF7', color: '#1d4ed8' },
  violet: { background: '#EBE3F7', color: '#6B4AAF' }, grey: { background: '#F1EFEA', color: '#64748b' },
};
function Tag({ kind = 'grey', children }) {
  const s = TAG[kind] || TAG.grey;
  return <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', ...s }}>{children}</span>;
}
function SecTitle({ children, sub }) {
  return <div style={secTitle}>{children}{sub && <span style={{ fontWeight: 600, color: C.ink2, textTransform: 'none', letterSpacing: 0, fontSize: 11.5, opacity: 0.85 }}>· {sub}</span>}</div>;
}
function Stat({ k, v, d, color }) {
  return (
    <div style={{ ...card }}>
      <div style={{ fontSize: 11, color: C.ink2, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.4px' }}>{k}</div>
      <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6, letterSpacing: '-0.5px', color: color || C.ink }}>{v}</div>
      {d && <div style={{ fontSize: 11.5, color: C.ink2, marginTop: 2 }}>{d}</div>}
    </div>
  );
}
function Bar({ v, color, suffix = '' }) {
  if (v == null) return <span style={{ fontSize: 11, color: C.ink2 }}>pending</span>;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 90 }}>
      <div style={{ flex: 1, height: 7, background: '#EEF1F6', borderRadius: 4, overflow: 'hidden', minWidth: 44 }}>
        <div style={{ width: `${Math.max(0, Math.min(100, v))}%`, height: '100%', background: color, borderRadius: 4 }} />
      </div>
      <span style={{ fontSize: 11.5, fontWeight: 700, width: 30, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{Math.round(v)}{suffix}</span>
    </div>
  );
}
const grid = (min, gap = 14) => ({ display: 'grid', gap, gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))` });

const SUBTABS = [
  ['overview', 'Overview'], ['toc', 'TOC Constraint'], ['modaudit', 'Module Audit'],
  ['ownership', 'Ownership'], ['fix', 'Fix Ownership'], ['design', 'QQTC Design'],
  ['weekly', 'Weekly Scorecards'], ['score', 'Live Scorecard'], ['top', 'Top Performers'],
  ['game', 'Gamification'],
];

export default function QQTCScorecard() {
  const [sub, setSub] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [weekly, setWeekly] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [perf, setPerf] = useState(null);
  const [cmd, setCmd] = useState(null);          // null until loaded; false if feed unavailable

  useEffect(() => {
    let alive = true;
    Promise.allSettled([
      api.get('/scoring/weekly'),
      api.get('/scoring/templates'),
      api.get('/scoring/assignments'),
      api.get('/raci/performance'),
      api.get('/dashboards/cmd-detail'),
    ]).then(([w, t, a, p, c]) => {
      if (!alive) return;
      if (w.status === 'rejected') { setErr(w.reason?.response?.data?.error || 'Failed to load weekly scores'); setLoading(false); return; }
      setWeekly(w.value.data);
      setTemplates(t.status === 'fulfilled' ? t.value.data : []);
      setAssignments(a.status === 'fulfilled' ? a.value.data : []);
      setPerf(p.status === 'fulfilled' ? p.value.data : null);
      setCmd(c.status === 'fulfilled' ? c.value.data : false);   // false = TOC feed not available
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  // ─── derive everything once ──────────────────────────────────────
  const model = useMemo(() => {
    if (!weekly) return null;
    const users = weekly.users || [];
    const maxDone = Math.max(1, ...users.map(u => u.total_done || 0));
    const timeByName = {};
    (perf?.people || []).forEach(p => { timeByName[norm(p.name)] = p.time_score; });
    const tplByUser = {};
    assignments.forEach(a => { tplByUser[a.user_id] = a.template_id ? (a.template_name || `#${a.template_id}`) : null; });

    const rows = users.map(u => {
      const q = computeQQTC(u, maxDone, timeByName[norm(u.name)] ?? null);
      return { ...u, ...q, template: tplByUser[u.user_id] ?? null };
    });
    const active = rows.filter(r => r.given > 0 || r.done > 0);

    const total = assignments.length || users.length;
    const owned = assignments.filter(a => a.template_id).length;
    const none = total - owned;
    const orphanTpls = templates.filter(t => (t.user_count || 0) === 0);

    return { rows, active, total, owned, none, orphanTpls, maxDone };
  }, [weekly, perf, assignments, templates]);

  if (loading) return <div style={{ padding: 48, textAlign: 'center', color: C.ink2 }}>Loading QQTC scorecard…</div>;
  if (err) return <div style={{ ...card, color: C.red, margin: 12 }}>{err}</div>;
  if (!model) return null;

  return (
    <div>
      {/* sub-tab nav */}
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 18 }}>
        {SUBTABS.map(([key, label]) => {
          const on = sub === key;
          return (
            <button key={key} type="button" onClick={() => setSub(key)} style={{
              padding: '8px 14px', borderRadius: 9, cursor: 'pointer', fontWeight: 600, fontSize: 12.5,
              border: `1px solid ${on ? C.blue : C.line}`, background: on ? C.blue : C.card,
              color: on ? '#fff' : C.ink2, fontFamily: 'inherit',
            }}>{label}</button>
          );
        })}
      </div>

      {sub === 'overview' && <Overview m={model} />}
      {sub === 'toc' && <TOCView cmd={cmd} />}
      {sub === 'modaudit' && <ModuleAudit cmd={cmd} />}
      {sub === 'ownership' && <Ownership m={model} templates={templates} />}
      {sub === 'fix' && <FixOwnership m={model} />}
      {sub === 'design' && <DesignView />}
      {sub === 'weekly' && <WeeklyScorecards />}
      {sub === 'score' && <LiveScorecard m={model} />}
      {sub === 'top' && <TopPerformers m={model} />}
      {sub === 'game' && <Gamification cmd={cmd} />}
    </div>
  );
}

// ─── OVERVIEW ─────────────────────────────────────────────────────
function Overview({ m }) {
  const ownedPct = Math.round((m.owned / Math.max(1, m.total)) * 100);
  const loggedPct = Math.round((m.active.length / Math.max(1, m.total)) * 100);
  return (
    <>
      <div style={grid(170)}>
        <Stat k="Staff in ERP" v={m.total} d="active users" />
        <Stat k="With KPI owner" v={`${m.owned} / ${m.total}`} d={`${ownedPct}% have a template`} color={ownedPct >= 60 ? C.green : C.amber} />
        <Stat k="No owner" v={m.none} d="invisible to the MIS" color={m.none ? C.red : C.green} />
        <Stat k="Logged work" v={`${m.active.length} / ${m.total}`} d={`only ${loggedPct}% active this week`} color={loggedPct >= 50 ? C.green : C.amber} />
      </div>

      <div style={{ ...card, background: '#FFF8E6', borderColor: '#FDE68A', color: '#92400E', marginTop: 16, fontSize: 13, lineHeight: 1.6 }}>
        <b>Bottom line —</b> the scorecard engine is solid, but it only covers part of the company.
        {' '}<b>{m.none} of {m.total} staff ({Math.round((m.none / Math.max(1, m.total)) * 100)}%)</b> have no KPI template,
        {' '}<b>{m.orphanTpls.length} role templates</b> have no live owner, and only <b>{m.active.length}</b> people logged anything this week.
        Fix ownership first (see the <b>Fix Ownership</b> tab), then the ranking becomes meaningful.
      </div>

      <SecTitle sub="who in the ERP has a KPI owner">⚖️ Ownership coverage</SecTitle>
      <div style={grid(240)}>
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <b style={{ fontSize: 13 }}>KPI template assigned</b><Tag kind="blue">{ownedPct}% owned</Tag>
          </div>
          <div style={{ height: 8, background: '#EEF1F6', borderRadius: 5, overflow: 'hidden', margin: '12px 0 6px' }}>
            <div style={{ width: `${ownedPct}%`, height: '100%', background: C.blue }} />
          </div>
          <div style={{ fontSize: 12, color: C.ink2 }}><b>{m.owned}</b> assigned a template · <b style={{ color: C.red }}>{m.none}</b> on “— none —”</div>
        </div>
        <div style={card}>
          <b style={{ fontSize: 13 }}>Reporting activity this week</b>
          <div style={{ fontSize: 11.5, color: C.ink2, margin: '6px 0 10px' }}>Staff who logged any work into the MIS</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><span>Logged ≥1 item</span><b>{m.active.length}</b></div>
          <div style={{ height: 8, background: '#EEF1F6', borderRadius: 5, overflow: 'hidden', margin: '8px 0' }}>
            <div style={{ width: `${loggedPct}%`, height: '100%', background: C.green }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><span>Silent (all zero)</span><b style={{ color: C.red }}>{m.total - m.active.length}</b></div>
        </div>
      </div>
    </>
  );
}

// ─── LIVE SCORECARD ───────────────────────────────────────────────
function Legend() {
  const items = [['Quantity (live)', QC.quantity], ['Quality (live)', QC.quality], ['Time (proxy)', QC.time], ['Cost (pending)', QC.cost]];
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: C.ink2, margin: '4px 0 10px' }}>
      {items.map(([l, c]) => <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: c }} />{l}</span>)}
    </div>
  );
}
function LiveScorecard({ m }) {
  const rows = [...m.active].sort((a, b) => b.composite - a.composite);
  return (
    <>
      <SecTitle sub="computed from this week's MIS">📋 Live QQTC scorecard</SecTitle>
      <Legend />
      <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: `2px solid ${C.line}` }}>
            {['#', 'Employee', 'Template', 'Done', 'Quantity', 'Quality', 'Time*', 'QQTC', 'ERP %'].map(h => <th key={h} style={th}>{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.user_id} style={{ background: i < 3 ? C.soft : 'transparent' }}>
                <td style={{ ...td, fontWeight: 700, color: i === 0 ? C.amber : C.ink2 }}>{i === 0 ? '🏆' : i + 1}</td>
                <td style={td}><b>{r.name}</b><div style={{ fontSize: 11, color: C.ink2 }}>{r.department || r.role}</div></td>
                <td style={td}>{r.template ? r.template : <span style={{ color: C.red }}>— none —</span>}</td>
                <td style={{ ...td, fontWeight: 700 }}>{r.done}</td>
                <td style={td}><Bar v={r.quantity} color={QC.quantity} /></td>
                <td style={td}><Bar v={r.quality} color={QC.quality} suffix="%" /></td>
                <td style={td}><Bar v={r.time} color={QC.time} suffix="%" /></td>
                <td style={{ ...td, fontWeight: 800, fontSize: 15 }}>{r.composite}</td>
                <td style={td}><Tag kind={r.score >= 80 ? 'green' : r.score >= 40 ? 'amber' : 'red'}>{r.score - 100}%</Tag></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11.5, color: C.ink2, marginTop: 8 }}>*Time = on-time % from RACI step completion where available, else “pending”. Cost is per-role and awaits weekly finance entry, so it is excluded from this week's composite.</div>
    </>
  );
}

// ─── TOP PERFORMERS ───────────────────────────────────────────────
function TopPerformers({ m }) {
  const ranked = m.active.filter(r => r.done > 0).sort((a, b) => b.composite - a.composite);
  const podiumBg = ['linear-gradient(135deg,#caa42a,#f0c544)', 'linear-gradient(135deg,#7a8699,#9aa6ba)', 'linear-gradient(135deg,#a4663a,#c07f4f)'];
  const read = (r) => {
    if (r.quality == null) return <Tag kind="blue">unplanned volume</Tag>;
    if (r.quantity >= 60 && r.quality >= 80) return <Tag kind="green">high vol + reliable</Tag>;
    if (r.quality >= 90) return <Tag kind="green">reliable</Tag>;
    if (r.quantity >= 60 && r.quality < 60) return <Tag kind="amber">busy, low completion</Tag>;
    if (r.quality < 40) return <Tag kind="red">missed plan</Tag>;
    return <Tag kind="grey">low signal</Tag>;
  };
  return (
    <>
      <SecTitle sub="balanced QQTC composite (Quantity + Quality + on-time)">🏆 Who is performing more</SecTitle>
      {ranked.length === 0 ? <div style={{ ...card, color: C.ink2, textAlign: 'center' }}>No logged work this week yet.</div> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14, alignItems: 'end', marginBottom: 18 }}>
            {ranked.slice(0, 3).map((r, i) => (
              <div key={r.user_id} style={{ borderRadius: 14, padding: 16, color: '#fff', textAlign: 'center', background: podiumBg[i], transform: i === 0 ? 'translateY(-8px)' : 'none' }}>
                <div style={{ fontSize: 12, opacity: 0.85, fontWeight: 700 }}>#{i + 1}</div>
                <div style={{ fontSize: 16, fontWeight: 800, margin: '4px 0' }}>{r.name}</div>
                <div style={{ fontSize: 28, fontWeight: 800 }}>{r.composite}</div>
                <div style={{ fontSize: 11, opacity: 0.9 }}>{r.template || r.department || r.role} · ERP {r.score - 100}%</div>
              </div>
            ))}
          </div>
          <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ borderBottom: `2px solid ${C.line}` }}>{['#', 'Employee', 'Role', 'Quantity', 'Quality', 'QQTC', 'ERP %', 'Read'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {ranked.map((r, i) => (
                  <tr key={r.user_id}>
                    <td style={{ ...td, fontWeight: 700 }}>{i + 1}</td>
                    <td style={td}><b>{r.name}</b></td>
                    <td style={{ ...td, color: C.ink2 }}>{r.template || r.department || r.role}</td>
                    <td style={td}>{r.quantity}</td>
                    <td style={td}>{r.quality == null ? '—' : `${r.quality}%`}</td>
                    <td style={{ ...td, fontWeight: 800 }}>{r.composite}</td>
                    <td style={td}>{r.score - 100}%</td>
                    <td style={td}>{read(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

// ─── OWNERSHIP AUDIT ──────────────────────────────────────────────
function Ownership({ m, templates }) {
  const sorted = [...templates].sort((a, b) => (a.user_count || 0) - (b.user_count || 0));
  return (
    <>
      <SecTitle sub={`${templates.length} templates · ${m.orphanTpls.length} with no live owner`}>👤 Role-template ownership</SecTitle>
      <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: `2px solid ${C.line}` }}>{['Role template', 'KPIs', 'Live owners', 'Status'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {sorted.map(t => {
              const n = t.user_count || 0;
              return (
                <tr key={t.id}>
                  <td style={td}><b>{t.name}</b>{t.description && <div style={{ fontSize: 11, color: C.ink2 }}>{t.description}</div>}</td>
                  <td style={td}>{t.kpi_count || 0}</td>
                  <td style={td}>{n}</td>
                  <td style={td}>{n === 0 ? <Tag kind="red">No owner</Tag> : n === 1 ? <Tag kind="green">Owned</Tag> : <Tag kind="green">Owned ×{n}</Tag>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <SecTitle sub="found in the live ERP">🚩 Data-integrity flags</SecTitle>
      <div style={grid(260)}>
        <IntegrityCard sev="high" title={`${m.none} staff with no template`} body={`${m.none} of ${m.total} active users have no KPI template assigned — they never appear in any scorecard.`} />
        <IntegrityCard sev="high" title={`${m.orphanTpls.length} orphan templates`} body={m.orphanTpls.length ? `These templates have 0 live owners: ${m.orphanTpls.map(t => t.name).join(', ')}.` : 'Every template has at least one owner.'} />
        <IntegrityCard sev="med" title={`${m.total - m.active.length} silent this week`} body="Assigned work but logged nothing into delegations / PMS / checklists / tickets this week." />
      </div>
    </>
  );
}
function IntegrityCard({ sev, title, body }) {
  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}><b style={{ fontSize: 13 }}>{title}</b><Tag kind={sev === 'high' ? 'red' : 'amber'}>{sev.toUpperCase()}</Tag></div>
      <div style={{ fontSize: 12.5, color: C.ink2, lineHeight: 1.5 }}>{body}</div>
    </div>
  );
}

// ─── FIX OWNERSHIP ────────────────────────────────────────────────
function FixOwnership({ m }) {
  const unowned = m.rows.filter(r => !r.template);
  const withDept = unowned.filter(r => r.department && r.department !== '—');
  const blank = unowned.filter(r => !r.department || r.department === '—');
  return (
    <>
      <div style={grid(170)}>
        <Stat k="Owned now" v={`${m.owned} / ${m.total}`} d="have a template" color={C.green} />
        <Stat k="To assign" v={unowned.length} d="no template yet" color={C.red} />
        <Stat k="Mappable by dept" v={withDept.length} d="ERP designation set" color={C.amber} />
        <Stat k="Need a title first" v={blank.length} d="blank designation in ERP" />
      </div>
      <SecTitle sub="assign each a template by their ERP designation — apply in Performance → Assign Templates">🛠️ Unowned staff</SecTitle>
      <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: `2px solid ${C.line}` }}>{['#', 'Employee', 'ERP designation', 'Suggested family', 'Action'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {[...unowned].sort((a, b) => (b.department ? 1 : 0) - (a.department ? 1 : 0)).map((r, i) => {
              const hasDept = r.department && r.department !== '—';
              return (
                <tr key={r.user_id}>
                  <td style={{ ...td, color: C.ink2 }}>{i + 1}</td>
                  <td style={td}><b>{r.name}</b></td>
                  <td style={{ ...td, color: hasDept ? C.ink : C.red }}>{hasDept ? r.department : '⚠ not set'}</td>
                  <td style={{ ...td, color: C.ink2 }}>{suggestFamily(r.department || r.role)}</td>
                  <td style={td}>{hasDept ? <Tag kind="amber">assign template</Tag> : <Tag kind="red">set designation</Tag>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
function suggestFamily(d) {
  const s = norm(d);
  if (/sale|crm|business/.test(s)) return 'Sales / Coordination';
  if (/estimat|quotation|design|costing|tender/.test(s)) return 'Estimation / Quotation';
  if (/purchase|procure|store/.test(s)) return 'Procurement';
  if (/finance|account|cash|billing/.test(s)) return 'Finance / Accounts';
  if (/site|operation|supervis|engineer|mechanical|electrical/.test(s)) return 'Operations / Site';
  if (/hr|hiring|market/.test(s)) return 'HR';
  if (/admin|director|management|md|coo|cmd/.test(s)) return 'Executive / MD';
  if (/it|developer|ai/.test(s)) return 'Tech';
  return '— review —';
}

// ─── QQTC DESIGN ──────────────────────────────────────────────────
function DesignView() {
  return (
    <>
      <SecTitle sub="4 universal parameters on every role">🎯 The QQTC model</SecTitle>
      <div style={grid(280)}>
        {QQTC.map(q => (
          <div key={q.name} style={{ ...card, borderLeft: `5px solid ${q.color}`, borderRadius: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: 15, color: q.color }}>{q.name}</h3>
              <Tag kind={q.status === 'LIVE' ? 'green' : 'amber'}>{q.status === 'LIVE' ? 'LIVE DATA' : 'NEEDS WIRING'}</Tag>
            </div>
            <div style={{ fontSize: 12.5, color: C.ink2, marginTop: 4 }}><b>{q.what}.</b></div>
            <div style={{ fontSize: 12.5, margin: '8px 0 0' }}>{q.inputs}</div>
            <div style={{ fontSize: 11, color: C.ink2, marginTop: 8 }}>↳ source: {q.src}</div>
          </div>
        ))}
      </div>

      <SecTitle sub="each row sums to 100%">⚖️ Suggested weight presets by family</SecTitle>
      <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: `2px solid ${C.line}` }}>
            <th style={th}>Role family</th>
            {QLAB.map((l, i) => <th key={l} style={{ ...th, color: QCOL[i] }}>{l}</th>)}
          </tr></thead>
          <tbody>
            {WEIGHT_PRESETS.map(p => (
              <tr key={p.fam}><td style={td}><b>{p.fam}</b></td>{p.w.map((w, i) => <td key={i} style={{ ...td, fontWeight: 700 }}>{w}%</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ ...card, background: '#EEF0FD', borderColor: '#C7D2FE', color: '#3730A3', marginTop: 14, fontSize: 12.5, lineHeight: 1.6 }}>
        <b>How this plugs into the ERP:</b> the template editor already has a “Group” field on every KPI. Re-tag each KPI as <b>Quantity / Quality / Time / Cost</b> and the same engine rolls up a 4-dial score per person — no new tables. Quantity &amp; Quality run on today's auto data; Time &amp; Cost switch on once TAT timestamps and the finance weekly-entry fields are wired.
      </div>
    </>
  );
}

// ─── WEEKLY SCORECARDS (by designation) ───────────────────────────
function WeeklyScorecards() {
  return (
    <>
      <SecTitle sub={`${DESIGNATIONS.length} designations · 80 QQTC + 20 activity`}>📅 Weekly scorecard — every designation</SecTitle>
      <div style={{ ...card, background: '#EEF0FD', borderColor: '#C7D2FE', color: '#3730A3', fontSize: 12.5, lineHeight: 1.6 }}>
        Each role is scored <b>/100 every week</b>: <b>80 pts</b> on its revenue-touching <b>QQTC</b> metrics + <b>20 pts</b> universal (Delegations 8 · Help Tickets 6 · PMS 6). Targets are default recommendations — tune to each person's capacity.
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, color: C.ink2, margin: '12px 0' }}>
        {QLAB.map((l, i) => <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: QCOL[i] }} />{l}</span>)}
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: QC.activity }} />Activity 20</span>
      </div>
      <div style={grid(320)}>
        {DESIGNATIONS.map(d => (
          <div key={d.role} style={{ ...card, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <div><b style={{ fontSize: 13.5 }}>{d.role}</b><div style={{ fontSize: 11.5, color: d.who.startsWith('GAP') ? C.red : C.ink2 }}>{d.who}</div></div>
              <Tag kind="blue">{d.fam}</Tag>
            </div>
            <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', margin: '10px 0 4px' }}>
              {d.w.map((w, i) => w > 0 ? <div key={i} style={{ width: `${w}%`, background: QCOL[i] }} /> : null)}
              <div style={{ width: `${ACTIVITY_BUCKET.weight}%`, background: QC.activity }} />
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6 }}>
              <tbody>
                {d.m.map((mm, i) => {
                  const dim = mm[0] === '—';
                  return (
                    <tr key={i}>
                      <td style={{ padding: '5px 6px', borderBottom: `1px solid ${C.line}`, whiteSpace: 'nowrap' }}>
                        <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 6, fontSize: 10.5, fontWeight: 700, color: '#fff', background: QCOL[i], opacity: dim ? 0.4 : 1 }}>{QLAB[i]} {d.w[i]}</span>
                      </td>
                      <td style={{ padding: '5px 6px', borderBottom: `1px solid ${C.line}`, fontSize: 11.5 }}>{dim ? <span style={{ color: C.ink2 }}>{mm[1]}</span> : <><b>{mm[0]}</b> <span style={{ color: C.ink2 }}>· {mm[1]}</span></>}</td>
                      <td style={{ padding: '5px 6px', borderBottom: `1px solid ${C.line}`, fontSize: 11, color: C.ink2, whiteSpace: 'nowrap' }}>{mm[2]}</td>
                    </tr>
                  );
                })}
                <tr style={{ background: C.soft }}>
                  <td style={{ padding: '5px 6px' }}><Tag kind="grey">Activity {ACTIVITY_BUCKET.weight}</Tag></td>
                  <td style={{ padding: '5px 6px', fontSize: 11, color: C.ink2 }} colSpan={2}>{ACTIVITY_BUCKET.rows.map(r => `${r[0]} (${r[3]})`).join(' · ')}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </>
  );
}

// ─── MODULE AUDIT ─────────────────────────────────────────────────
function ModuleAudit({ cmd }) {
  const sorted = [...MODULE_AUDIT].sort((a, b) => (b.touch ? 1 : 0) - (a.touch ? 1 : 0));
  return (
    <>
      {cmd && <LiveConstraintStrip cmd={cmd} />}
      <SecTitle sub="RACI · QQTC · Goldratt's 8 Rules of Flow">🗂️ Whole-ERP module audit</SecTitle>
      <div style={{ fontSize: 11.5, color: C.ink2, marginBottom: 10 }}>⭐ = touches the binding constraint (Bill → Cash). Ownership &amp; fix recommendations are the design; red-flag figures are illustrative until the live ops feed is confirmed.</div>
      <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: `2px solid ${C.line}` }}>{['Module', 'Owner', 'Backup', 'QQTC', 'Rules ✗', 'Red flags / fix'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {sorted.map(mod => (
              <tr key={mod.mod} style={{ background: mod.touch ? '#FFF7F7' : 'transparent' }}>
                <td style={td}>{mod.touch ? '⭐ ' : ''}<b>{mod.mod}</b></td>
                <td style={td}>{mod.owner === 'GAP' ? <span style={{ color: C.red, fontWeight: 700 }}>⚠ OWNERLESS</span> : <b>{mod.owner}</b>}</td>
                <td style={{ ...td, color: C.ink2 }}>{mod.backup}</td>
                <td style={td}><Tag kind={mod.q === 'Yes' ? 'green' : mod.q === 'Partial' ? 'amber' : mod.q === 'No' ? 'red' : 'grey'}>{mod.q}</Tag></td>
                <td style={td}><Tag kind={mod.rules === '—' ? 'grey' : 'red'}>{mod.rules}</Tag></td>
                <td style={{ ...td, maxWidth: 420 }}><div style={{ fontSize: 11.5, color: '#b91c1c' }}>{mod.red}</div><div style={{ fontSize: 11.5, color: C.ink2, marginTop: 3 }}><b>Fix:</b> {mod.fix}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11.5, color: C.ink2, marginTop: 10 }}><b>Rules:</b> {FLOW_RULES}</div>
    </>
  );
}
function LiveConstraintStrip({ cmd }) {
  const p = cmd.pulse || {}; const f = cmd.sales?.funnel || {};
  const billedShare = f.pos ? Math.round((f.billed / f.pos) * 100) : null;
  return (
    <>
      <SecTitle sub="from /api/dashboards/cmd-detail">📡 Live constraint numbers</SecTitle>
      <div style={grid(150)}>
        <Stat k="Billed of POs" v={billedShare == null ? '—' : `${billedShare}%`} d={`${f.billed ?? 0} of ${f.pos ?? 0} POs`} color={C.red} />
        <Stat k="AR outstanding" v={fmtINR(cmd.cash?.ar_outstanding)} d="to collect" color={C.amber} />
        <Stat k="DPR adherence" v={`${p.dpr_adherence_pct ?? 0}%`} d="sites today" color={(p.dpr_adherence_pct ?? 0) >= 80 ? C.green : C.red} />
        <Stat k="Open snags" v={fmtNum(p.open_snags)} d={p.oldest_snag_days ? `oldest ${p.oldest_snag_days} d` : ''} color={C.amber} />
        <Stat k="Junk POs" v={fmtNum(cmd.data_quality?.junk_po_count)} d={fmtINR(cmd.data_quality?.junk_po_total)} color={(cmd.data_quality?.junk_po_count || 0) ? C.red : C.green} />
      </div>
    </>
  );
}

// ─── TOC CONSTRAINT ───────────────────────────────────────────────
function TOCView({ cmd }) {
  if (cmd === false) return <FeedMissing what="TOC constraint view" />;
  if (!cmd) return null;
  const p = cmd.pulse || {}; const f = cmd.sales?.funnel || {};
  const pulse = [
    ['Bank balance', fmtINR(p.bank_balance), p.runway_days != null ? `Runway ${p.runway_days} days` : '', false],
    ['Order book', fmtINR(p.order_book), `${fmtNum(p.order_book_count)} active`, false],
    ['Revenue MTD', fmtINR(p.revenue_mtd), `vs ${fmtINR(p.order_book)} order book`, false],
    ['CCC days', p.ccc != null ? `${fmtNum(p.ccc)} d` : '—', `DSO ${fmtNum(p.dso)} + DIO ${fmtNum(p.dio)} − DPO ${fmtNum(p.dpo)}`, p.ccc == null || Math.abs(p.ccc) > 1000],
    ['DPR adherence', `${p.dpr_adherence_pct ?? 0}%`, `${cmd.operations?.dpr?.on_time ?? 0} of ${cmd.operations?.dpr?.total_sites ?? 0} sites`, false],
    ['Open snags', fmtNum(p.open_snags), p.oldest_snag_days ? `oldest ${p.oldest_snag_days} d` : '', false],
    ['Free inventory', fmtINR(p.free_inventory), `of ${fmtINR(cmd.inventory?.total)}`, false],
    ['Lead → PO', p.lead_to_po_pct != null ? `${p.lead_to_po_pct}%` : '—', `${f.leads ?? 0} leads`, p.lead_to_po_pct == null],
  ];
  const stages = [['Leads', f.leads], ['Qualified', f.qualified], ['Quoted', f.quoted], ['POs', f.pos], ['In execution', f.in_execution], ['Billed', f.billed], ['Collected', f.collected]];
  const fmax = Math.max(1, ...stages.map(s => s[1] || 0));
  const debtors = cmd.cash?.top_5_debtors || [];
  return (
    <>
      <div style={{ ...card, background: '#FEF2F2', borderColor: '#FECACA', borderLeft: `5px solid ${C.red}` }}>
        <div style={{ fontSize: 12, color: C.ink2 }}>TOC Step 1 — Identify the constraint</div>
        <div style={{ fontSize: 19, fontWeight: 800, color: '#b91c1c', margin: '2px 0 4px' }}>Binding constraint: Bill → Cash</div>
        <div style={{ fontSize: 12.5, color: '#475569' }}>A full order book converts to almost no revenue: only <b>{f.billed ?? 0} of {f.pos ?? 0}</b> POs billed and <b>{fmtINR(cmd.cash?.ar_outstanding)}</b> sits uncollected. The leak is between work-done and cash-in.</div>
      </div>

      <SecTitle sub="live · cmd-detail">📡 Pulse</SecTitle>
      <div style={grid(160)}>
        {pulse.map(([k, v, d, bad]) => <Stat key={k} k={k} v={v} d={d + (bad ? ' · data gap' : '')} color={bad ? C.amber : C.ink} />)}
      </div>

      <div style={{ ...grid(260), marginTop: 14 }}>
        <div style={card}>
          <SecTitle sub={`${cmd.window?.days ?? 90} days`}>🔻 Lead → Cash funnel</SecTitle>
          {stages.map(([nm, v]) => (
            <div key={nm} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', borderBottom: `1px solid ${C.line}` }}>
              <div style={{ width: 96, fontSize: 12, fontWeight: 600 }}>{nm}</div>
              <div style={{ flex: 1, height: 16, borderRadius: 5, background: '#EEF1F6', overflow: 'hidden' }}><div style={{ width: `${Math.max(3, Math.round((v || 0) / fmax * 100))}%`, height: '100%', background: (v || 0) === 0 ? '#CBD5E1' : C.blue }} /></div>
              <div style={{ width: 44, textAlign: 'right', fontSize: 12, fontWeight: 700 }}>{fmtNum(v || 0)}</div>
            </div>
          ))}
        </div>
        <div style={card}>
          <SecTitle sub="collect first">💰 Top debtors</SecTitle>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, paddingBottom: 8 }}><span>Total AR</span><b>{fmtINR(cmd.cash?.ar_outstanding)}</b></div>
          {debtors.length === 0 ? <div style={{ fontSize: 12, color: C.ink2 }}>No outstanding receivables.</div> : debtors.map((d, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderTop: `1px solid ${C.line}` }}>
              <span style={{ fontSize: 12 }}>{d.client_name || '—'}<div style={{ fontSize: 10.5, color: C.red }}>{d.action_today}</div></span>
              <b style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>{fmtINR(d.amt)}</b>
            </div>
          ))}
        </div>
      </div>

      <SecTitle sub="Exploit → Subordinate → Elevate">🎯 The 3 TOC moves</SecTitle>
      <div style={grid(220)}>
        {TOC_MOVES.map(([title, body, owner, col]) => (
          <div key={title} style={{ ...card, borderLeft: `4px solid ${col}` }}>
            <h4 style={{ margin: '0 0 4px', fontSize: 13, color: col }}>{title}</h4>
            <div style={{ fontSize: 12, color: '#475569', lineHeight: 1.5 }}>{body}</div>
            <div style={{ fontSize: 11, color: C.ink2, marginTop: 8 }}>Owner: <b>{owner}</b></div>
          </div>
        ))}
      </div>
    </>
  );
}

// ─── GAMIFICATION ─────────────────────────────────────────────────
function Gamification({ cmd }) {
  const f = cmd && cmd.sales ? cmd.sales.funnel : null;
  const p = cmd ? cmd.pulse : null;
  // Map live values onto the pipeline stages where a feed exists.
  const liveByStage = f ? {
    'Lead Capture': `${f.leads ?? 0} leads`, 'Qualification': `${f.qualified ?? 0} qualified`,
    'Quotation': `${f.quoted ?? 0} quoted`, 'Negotiation': `${f.pos ?? 0} POs won`,
    'Production/Site': `DPR ${p?.dpr_adherence_pct ?? 0}%`, 'QC / Snags': `${p?.open_snags ?? 0} open`,
    'Billing': `${f.billed ?? 0} of ${f.pos ?? 0} billed`, 'Handover / Cash': `${f.collected ?? 0} collected`,
  } : {};
  const masterValue = f ? `${f.billed ?? 0} billed · ${f.collected ?? 0} cash collected` : 'connect the cmd-detail feed';
  return (
    <>
      <div style={{ ...card, background: '#F0FDF4', borderColor: '#86EFAC', borderLeft: `5px solid ${C.green}` }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#15803d', textTransform: 'uppercase', letterSpacing: '.4px' }}>Master score · the only number that wins</div>
        <div style={{ fontSize: 17, fontWeight: 800, marginTop: 4 }}>{GAME.master} → {masterValue}</div>
      </div>
      <SecTitle sub="Lead → Handover · one throughput metric per stage">🎮 Pipeline scoreboard</SecTitle>
      <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: `2px solid ${C.line}` }}>{['#', 'Stage', 'Throughput metric', 'Live', 'Red trigger', 'Owner', 'Mechanic'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {GAME.stages.map((s, i) => {
              const star = s[0] === 'Billing' || s[0] === 'Handover / Cash';
              const live = liveByStage[s[0]];
              return (
                <tr key={s[0]} style={{ background: star ? '#FFFBEB' : 'transparent' }}>
                  <td style={{ ...td, fontWeight: 700 }}>{i + 1}</td>
                  <td style={td}><b>{s[0]}</b></td>
                  <td style={{ ...td, color: C.ink2 }}>{s[1]}</td>
                  <td style={td}>{live ? <b>{live}</b> : <span style={{ color: C.ink2 }}>—</span>}</td>
                  <td style={{ ...td, color: '#b91c1c', fontSize: 11.5 }}>{s[2]}</td>
                  <td style={td}>{/GAP|vacant/.test(s[3]) ? <span style={{ color: C.red }}>{s[3]}</span> : s[3]}</td>
                  <td style={{ ...td, color: C.ink2, fontSize: 11.5 }}>{s[4]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ ...card, background: '#FFF8E6', borderColor: '#FDE68A', color: '#92400E', marginTop: 14, fontSize: 12.5, lineHeight: 1.6 }}>🛡️ {GAME.guardrail}</div>
    </>
  );
}

function FeedMissing({ what }) {
  return (
    <div style={{ ...card, background: '#FFF8E6', borderColor: '#FDE68A', color: '#92400E', textAlign: 'center', padding: 30 }}>
      The {what} needs the Operating Console feed (<code>/api/dashboards/cmd-detail</code>), which didn't load — it's admin-only and may not be wired in this environment. The rest of the scorecard runs on live scoring data.
    </div>
  );
}
