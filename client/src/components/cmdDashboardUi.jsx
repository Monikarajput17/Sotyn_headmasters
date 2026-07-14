// Shared visual primitives for the CMD dashboards (Stage 1 + Stage 2).
// Matches the colour palette + structure of mam's HTML specs:
//   SEPL_CMD_Single_Page_Dashboard_v2.html
//   SEPL_CMD_TOC_Dashboard_v3.html
// Dark navy theme.  Every section card / tile / pill / funnel / table
// here is a 1:1 translation of the HTML reference so the page looks
// identical to what MD signed off.

import React from 'react';

// Palette (kept as inline strings rather than CSS vars so the dark
// theme works inside the regular tailwind page — no global CSS edit).
export const C = {
  bg:    '#0B0D10',
  panel: '#13161B',
  panel2:'#1A1E25',
  line:  '#262B33',
  ink:   '#F2F4F7',
  ink2:  '#9AA3AD',
  ink3:  '#5C6470',
  red:   '#E5484D',
  amber: '#FFB224',
  green: '#46A758',
  blue:  '#3E63DD',
  blue2: '#5B7DE3',
  violet:'#8E4EC6',
  teal:  '#12A594',
  pink:  '#E93D82',
  orange:'#F76808',
};

export const fmtINR = (v) => {
  if (v == null || isNaN(v)) return '—';
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} cr`;
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`;
  if (Math.abs(v) >= 1e3) return `₹${(v / 1e3).toFixed(1)} K`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
};
export const fmtNum = (v) => (v == null || isNaN(v) ? '—' : Math.round(v).toLocaleString('en-IN'));
export const fmtPct = (v) => (v == null || isNaN(v) ? '—' : `${Math.round(v)}%`);

// Top-of-page header band (gradient + title + sub + meta on the right).
export function PageHeader({ title, tag, subtitle, meta, rightTop, rightSub }) {
  return (
    <div style={{
      padding: '14px 22px', display: 'flex', justifyContent: 'space-between',
      alignItems: 'center', borderBottom: `1px solid ${C.line}`,
      background: `linear-gradient(180deg, ${C.panel} 0%, ${C.bg} 100%)`,
    }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: '.3px' }}>
          {title}
          {tag ? (
            <span style={{
              fontSize: 10, background: C.red, color: '#fff', padding: '2px 7px',
              borderRadius: 3, marginLeft: 8, fontWeight: 600, letterSpacing: '.5px',
            }}>{tag}</span>
          ) : null}
        </h1>
        {subtitle ? <div style={{ fontSize: 11, color: C.ink2, marginTop: 2 }}>{subtitle}</div> : null}
      </div>
      <div style={{ textAlign: 'right' }}>
        {rightTop ? <div style={{ fontSize: 11, color: C.ink2 }}>{rightTop}</div> : null}
        {rightSub ? <div style={{ fontSize: 10, color: C.ink3, marginTop: 3 }}>{rightSub}</div> : null}
        {meta}
      </div>
    </div>
  );
}

// Section divider — small uppercase label with a top border.
export function SectionHead({ children, first = false }) {
  return (
    <div style={{
      fontSize: 10, letterSpacing: '1.2px', textTransform: 'uppercase',
      color: C.ink3, fontWeight: 700,
      borderTop: first ? 'none' : `1px solid ${C.line}`,
      paddingTop: first ? 0 : 14, marginTop: first ? 0 : 6,
    }}>{children}</div>
  );
}

// Stripe-on-left KPI tile.  Colour = semantic (red/amber/green/blue/violet/teal).
const stripeColor = {
  red: C.red, amber: C.amber, green: C.green,
  blue: C.blue, violet: C.violet, teal: C.teal, orange: C.orange,
};
export function KpiTile({ label, value, sub, accent = 'blue' }) {
  return (
    <div style={{
      background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8,
      padding: 12, position: 'relative', overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', left: 0, top: 0, width: 3, height: '100%',
        background: stripeColor[accent] || C.blue,
      }} />
      <div style={{
        fontSize: 10, color: C.ink2, textTransform: 'uppercase',
        letterSpacing: '.7px', fontWeight: 600,
      }}>{label}</div>
      <div style={{
        fontSize: 21, fontWeight: 700, letterSpacing: '-.5px',
        marginTop: 4, lineHeight: 1, color: stripeColor[accent] || C.ink,
      }}>{value}</div>
      {sub ? (
        <div style={{ fontSize: 10.5, color: C.ink2, marginTop: 5, lineHeight: 1.35 }}>{sub}</div>
      ) : null}
    </div>
  );
}

// Section card with title + meta + child content.
export function Card({ title, meta, children, footer, accent }) {
  return (
    <div style={{
      background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8,
      padding: 12, position: 'relative',
      borderLeft: accent ? `3px solid ${stripeColor[accent] || C.blue}` : `1px solid ${C.line}`,
    }}>
      {title ? (
        <div style={{
          margin: '0 0 10px', fontSize: 11, color: C.ink2,
          letterSpacing: '.7px', textTransform: 'uppercase', fontWeight: 600,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span>{title}</span>
          {meta ? <span style={{
            color: C.ink3, fontSize: 10, textTransform: 'none',
            letterSpacing: 0, fontWeight: 400,
          }}>{meta}</span> : null}
        </div>
      ) : null}
      {children}
      {footer ? (
        <div style={{
          fontSize: 10.5, color: C.ink2, marginTop: 8,
          borderTop: `1px solid ${C.line}`, paddingTop: 8, lineHeight: 1.5,
        }}>{footer}</div>
      ) : null}
    </div>
  );
}

// Mini stat used inside cards.
export function MiniStat({ label, value, color }) {
  return (
    <div style={{ background: C.panel2, borderRadius: 5, padding: 8 }}>
      <div style={{
        fontSize: 9.5, color: C.ink2, textTransform: 'uppercase',
        letterSpacing: '.5px', fontWeight: 600,
      }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2, color: color || C.ink }}>{value}</div>
    </div>
  );
}

// Tag pill.
export function Pill({ kind = 'blue', children }) {
  const map = {
    red:    { bg: 'rgba(229,72,77,.15)',  color: C.red },
    amber:  { bg: 'rgba(255,178,36,.15)', color: C.amber },
    green:  { bg: 'rgba(70,167,88,.15)',  color: C.green },
    blue:   { bg: 'rgba(62,99,221,.15)',  color: C.blue },
    violet: { bg: 'rgba(142,78,198,.15)', color: C.violet },
  };
  const s = map[kind] || map.blue;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 7px', borderRadius: 3,
      fontSize: 10, fontWeight: 600, letterSpacing: '.4px',
      background: s.bg, color: s.color,
    }}>{children}</span>
  );
}

// Horizontal-funnel row (Leads → Qualified → ... visual).
export function FunnelBar({ label, value, drop, width, color, textColor = '#000' }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr 70px 50px',
      gap: 8, alignItems: 'center', fontSize: 11,
    }}>
      <div style={{
        height: 18, background: C.panel2, borderRadius: 3, overflow: 'hidden',
      }}>
        <div style={{
          width: `${width}%`, height: '100%', background: color, borderRadius: 3,
          display: 'flex', alignItems: 'center', padding: '0 8px',
          fontSize: 10, fontWeight: 600, color: textColor,
        }}>{label}</div>
      </div>
      <div style={{ textAlign: 'right', fontWeight: 600, fontSize: 11.5 }}>{value}</div>
      <div style={{ textAlign: 'right', fontSize: 10, color: drop ? C.red : C.ink3 }}>{drop || '·'}</div>
    </div>
  );
}

// Tick-row (used in side-panels: "Statutory dues", "Vacancy gap", etc.)
export function TicksList({ items }) {
  return (
    <ul style={{ margin: '4px 0 0', padding: 0, listStyle: 'none' }}>
      {items.map((it, i) => (
        <li key={i} style={{
          fontSize: 11, color: C.ink, padding: '5px 0',
          borderBottom: i === items.length - 1 ? 'none' : `1px dashed ${C.line}`,
          display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', gap: 8,
        }}>
          <span>{it.label}</span>
          <span>{it.right || (it.value ? <span style={{ color: C.ink2, fontSize: 10.5 }}>{it.value}</span> : null)}</span>
        </li>
      ))}
    </ul>
  );
}

// Horizontal bar (for "Conversion by source", "Top vendors").
export function HBar({ label, value, max, color, suffix }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '96px 1fr 78px',
      gap: 8, alignItems: 'center', padding: '5px 0', fontSize: 11,
    }}>
      <div style={{ color: C.ink2 }}>{label}</div>
      <div style={{ height: 7, background: C.panel2, borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      <div style={{ textAlign: 'right', fontWeight: 600 }}>{suffix ? `${value}${suffix}` : value}</div>
    </div>
  );
}

// Heatmap cell for the daily milestone heatmap.
export function HeatCell({ label, value, intensity = 'green' }) {
  const map = {
    green: 'rgba(70,167,88,.45)',
    amber: 'rgba(255,178,36,.45)',
    red:   'rgba(229,72,77,.45)',
  };
  return (
    <div style={{
      height: 24, borderRadius: 3, display: 'flex', alignItems: 'center',
      justifyContent: 'center', fontSize: 9.5, fontWeight: 600, color: '#fff',
      background: map[intensity] || map.green,
    }}>{label} {value}</div>
  );
}

// Layout grid presets matching the HTML spec (.r-strip, .r-3, .r-4, etc.)
export const Row = ({ cols, children, style }) => {
  const map = {
    strip: 'repeat(8, 1fr)',
    '3':   '1.2fr 1fr 1fr',
    '3eq': 'repeat(3, 1fr)',
    '4':   'repeat(4, 1fr)',
    '2':   '1fr 1fr',
    '2-1': '2fr 1fr',
    '1-2': '1fr 2fr',
  };
  return (
    <div style={{
      display: 'grid', gap: 12, marginBottom: 0,
      gridTemplateColumns: map[cols] || cols, ...style,
    }}>{children}</div>
  );
};

// Constraint / escalation banner.
export function ConstraintBanner({ label, statement, why }) {
  return (
    <div style={{
      background: 'linear-gradient(90deg, rgba(229,72,77,.22) 0%, rgba(229,72,77,.05) 100%)',
      border: '1px solid rgba(229,72,77,.45)', borderLeft: `4px solid ${C.red}`,
      borderRadius: 8, padding: '14px 18px',
    }}>
      {label ? (
        <div style={{
          fontSize: 10, color: C.red, letterSpacing: '1.5px',
          textTransform: 'uppercase', fontWeight: 700,
        }}>{label}</div>
      ) : null}
      <div style={{ fontSize: 14, color: '#fff', marginTop: 5, fontWeight: 500, lineHeight: 1.45 }}>{statement}</div>
      {why ? (
        <div style={{ fontSize: 11, color: '#FFCDCB', marginTop: 8, lineHeight: 1.55 }}>{why}</div>
      ) : null}
    </div>
  );
}

// Step card (TOC: Exploit / Subordinate / Elevate).
export function TocStep({ kind, title, body, owner }) {
  const colors = { exploit: C.red, subord: C.amber, elevate: C.green };
  return (
    <div style={{
      padding: '11px 12px', borderRadius: 6,
      background: C.panel2, border: `1px solid ${C.line}`,
    }}>
      <div style={{
        fontSize: 9.5, letterSpacing: '1px', textTransform: 'uppercase',
        fontWeight: 700, marginBottom: 4, color: colors[kind] || C.blue,
      }}>{title}</div>
      <div style={{ fontSize: 11.5, lineHeight: 1.55, color: C.ink }}>{body}</div>
      {owner ? (
        <div style={{
          fontSize: 10, color: C.ink3, marginTop: 6,
          borderTop: `1px dashed ${C.line}`, paddingTop: 5,
        }}>{owner}</div>
      ) : null}
    </div>
  );
}

// Header tab bar — switches between Stage 1 / Stage 2 CMD views.
export function StageTabs({ active, onChange }) {
  const tabs = [
    { id: 'op',  label: 'Stage 1 · Operating Console' },
    { id: 'toc', label: 'Stage 2 · TOC View' },
  ];
  return (
    <div style={{ display: 'flex', gap: 8, padding: '10px 22px', background: C.panel }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => onChange(t.id)} style={{
          padding: '6px 14px', borderRadius: 6, fontSize: 11,
          fontWeight: 600, cursor: 'pointer',
          background: active === t.id ? C.red : 'transparent',
          color: active === t.id ? '#fff' : C.ink2,
          border: `1px solid ${active === t.id ? C.red : C.line}`,
        }}>{t.label}</button>
      ))}
    </div>
  );
}

// Empty / "data gap" placeholder for fields we don't capture yet.
export function DataGap({ note }) {
  return (
    <div style={{
      fontSize: 10, color: C.ink3, padding: '8px 10px',
      background: C.panel2, borderRadius: 4, lineHeight: 1.4,
      fontStyle: 'italic',
    }}>
      <span style={{ color: C.amber, fontWeight: 600 }}>data gap · </span>
      {note}
    </div>
  );
}
