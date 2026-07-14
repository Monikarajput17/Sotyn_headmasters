// Daily 09:00 CMD audit email — audit item B20 + TOC v3 P0 #5.
//
// At 9 AM local time every day, reads the snapshot JSON files
// written at 7:30 AM by dailyAuditSnapshot.js (in
// data/audit-snapshots/<today>/) and sends a formatted summary
// email to the director address configured in Admin → Email
// Settings (app_settings.email_director_to).
//
// Falls back gracefully:
//   - If SMTP not configured in app_settings → logs skip, no error.
//   - If today's snapshot folder missing → uses live /audit feed
//     directly so the email still goes out (slower but works).
//   - Sunday off (mirrors the DPR prompt + audit-snapshot cadence).
//
// Skip via ERP_DISABLE_CMD_EMAIL=1.

const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/schema');
const { sendEmail, isConfigured } = require('../lib/email');

const SNAPSHOT_ROOT = path.join(__dirname, '..', '..', 'data', 'audit-snapshots');

function todayIso() { return new Date().toISOString().slice(0, 10); }
function isSunday() { return new Date().getDay() === 0; }

function readSnapshotOrLive(db) {
  const today = todayIso();
  const dir = path.join(SNAPSHOT_ROOT, today);
  const files = ['kpi.json', 'audit.json'];
  const out = {};
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      if (fs.existsSync(p)) {
        out[f] = JSON.parse(fs.readFileSync(p, 'utf-8'));
      }
    } catch (_) {}
  }
  // Fallback: if snapshot missing, compute live so the email still goes
  if (!out['kpi.json']) {
    try {
      const { computeKpiPayload } = require('../routes/auditReport');
      out['kpi.json'] = computeKpiPayload(db, 30);
      out._live_fallback = true;
    } catch (_) {}
  }
  return out;
}

const fmtINR = (v) => {
  if (v == null || isNaN(v)) return '—';
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} cr`;
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`;
  if (Math.abs(v) >= 1e3) return `₹${(v / 1e3).toFixed(1)} K`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
};
const fmtNum = (v) => (v == null || isNaN(v) ? '—' : Math.round(v).toLocaleString('en-IN'));
const fmtPct = (v) => (v == null || isNaN(v) ? '—' : `${Math.round(v)}%`);

function buildHtml(snapshot, db) {
  const today = todayIso();
  const kpi = snapshot['kpi.json'] || {};
  const audit = snapshot['audit.json'] || {};
  const p = kpi.pulse || {};
  const cash = kpi.cash || {};
  const cccObj = kpi.cash_conversion_cycle || {};
  const ar = kpi.ar || { aging: {} };
  const funnel = kpi.funnel || {};
  const sales = kpi.sales || {};
  const bank = kpi.bank || null;
  const wip = kpi.wip || {};

  // Light-weight self-contained HTML (inlined CSS so every mail
  // client renders it).  Mirrors the War Room CMD view aesthetic.
  const row = (label, value, accent = '#0E1116') =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #E5E2DA;color:#4A4F57;font-size:12px;">${label}</td>
         <td style="padding:8px 12px;border-bottom:1px solid #E5E2DA;text-align:right;color:${accent};font-weight:600;font-size:13px;">${value}</td></tr>`;

  const exceptionRow = (label, count) => {
    const colour = count === 0 ? '#1F8A4A' : count < 5 ? '#E2A52E' : '#D33A2C';
    return row(label, `<span style="color:${colour}">${count}</span>`);
  };

  return `<!DOCTYPE html><html><body style="margin:0;background:#F5F4F0;font-family:Arial,sans-serif;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #E5E2DA;border-radius:8px;overflow:hidden;">

    <div style="background:#0E1116;color:#fff;padding:18px 22px;border-bottom:3px solid #D33A2C;">
      <div style="font-size:16px;font-weight:600;">SEPL ERP — Daily Audit · ${today}</div>
      <div style="font-size:11px;color:#bdbdbd;margin-top:3px;">Generated 09:00 IST  ·  ${snapshot._live_fallback ? '<em style="color:#FFCDCB">live fallback (7:30 snapshot missing)</em>' : 'from 07:30 snapshot'}</div>
    </div>

    <div style="padding:18px 22px;">
      <div style="font-size:11px;color:#4A4F57;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;font-weight:700;">Pulse</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        ${row('Bank balance', fmtINR(p.bank_balance ?? bank?.closing_balance), '#1F8A4A')}
        ${row('Runway days', p.runway_days != null ? `${p.runway_days}d` : '—', p.runway_days < 30 ? '#D33A2C' : '#0E1116')}
        ${row('Cash Conversion Cycle', cccObj.ccc != null ? `${cccObj.ccc}d` : '—', cccObj.ccc > 90 ? '#D33A2C' : '#1F8A4A')}
        ${row('DSO / DIO / DPO', `${cccObj.dso ?? '—'} / ${cccObj.dio ?? '—'} / ${cccObj.dpo ?? '—'}`)}
        ${row('AR outstanding', fmtINR(ar.outstanding_total))}
        ${row('AR > 90 days', fmtINR(ar.aging.bucket_90_plus), '#D33A2C')}
        ${row('WIP unbilled', fmtINR(wip.unbilled))}
        ${row('Lead → PO %', fmtPct(funnel.lead_to_po_pct))}
        ${row('Quote lead time', funnel.quote_lead_time_days_avg != null ? `${funnel.quote_lead_time_days_avg} d` : '—')}
        ${row('On-time milestone %', fmtPct(kpi.on_time_milestone_pct))}
      </table>

      ${audit.summary ? `
      <div style="margin-top:24px;font-size:11px;color:#4A4F57;text-transform:uppercase;letter-spacing:1px;font-weight:700;">Data quality exceptions</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:6px;">
        ${exceptionRow('Duplicates',                audit.exceptions?.duplicates?.count ?? 0)}
        ${exceptionRow('Arithmetic errors',         audit.exceptions?.arithmetic_errors?.count ?? 0)}
        ${exceptionRow('Missing required',          audit.exceptions?.missing_required?.count ?? 0)}
        ${exceptionRow('Stale records',             audit.exceptions?.stale_records?.count ?? 0)}
        ${exceptionRow('Schema drift',              audit.exceptions?.schema_drift?.count ?? 0)}
        ${exceptionRow('Cash Flow ↔ BB client collisions', audit.exceptions?.cashflow_recon?.count ?? 0)}
        ${exceptionRow('Cash Flow Sale drift vs BB',       audit.exceptions?.cashflow_sale_drift?.count ?? 0)}
        ${exceptionRow('Attendance geofence violations',   audit.exceptions?.geofence_violations?.count ?? 0)}
        ${row('Total exceptions',    `<strong>${audit.summary.total_exceptions}</strong>`)}
        ${row('Critical',            `<strong style="color:#D33A2C">${audit.summary.critical_exceptions}</strong>`)}
      </table>` : ''}

      <div style="margin-top:24px;padding:12px 14px;background:#FAF8F4;border-left:3px solid #D33A2C;font-size:12px;color:#4A4F57;border-radius:4px;">
        <strong style="color:#0E1116;">Open the full dashboards:</strong><br>
        · <a href="https://securederp.in/dashboard/war-room" style="color:#2C5BA1;">Director's War Room</a><br>
        · <a href="https://securederp.in/dashboard/cmd" style="color:#2C5BA1;">CMD · Operating Console</a><br>
        · <a href="https://securederp.in/dashboard/cmd-toc" style="color:#2C5BA1;">CMD · TOC View</a>
      </div>

      <div style="margin-top:18px;font-size:10px;color:#5C6470;text-align:center;line-height:1.5;">
        Auto-generated daily at 09:00 IST  ·  source: <code>/audit/kpi</code> + <code>/audit</code><br>
        Stop these emails: Admin → Email Settings → clear "Director recipient" field.
      </div>
    </div>
  </div>
  </body></html>`;
}

function buildText(snapshot) {
  const kpi = snapshot['kpi.json'] || {};
  const audit = snapshot['audit.json'] || {};
  const p = kpi.pulse || {};
  const cccObj = kpi.cash_conversion_cycle || {};
  const ar = kpi.ar || { aging: {} };
  const funnel = kpi.funnel || {};
  const wip = kpi.wip || {};
  return [
    `SEPL ERP Daily Audit — ${todayIso()} 09:00 IST`,
    snapshot._live_fallback ? '(live fallback — 7:30 snapshot missing)' : '(from 07:30 snapshot)',
    '',
    `Bank: ${fmtINR(p.bank_balance)}  ·  Runway: ${p.runway_days ?? '—'}d`,
    `CCC: ${cccObj.ccc ?? '—'}d  (DSO ${cccObj.dso ?? '—'} + DIO ${cccObj.dio ?? '—'} − DPO ${cccObj.dpo ?? '—'})`,
    `AR outstanding: ${fmtINR(ar.outstanding_total)}  ·  >90d: ${fmtINR(ar.aging.bucket_90_plus)}`,
    `WIP unbilled: ${fmtINR(wip.unbilled)}`,
    `Lead→PO: ${fmtPct(funnel.lead_to_po_pct)}  ·  Quote lead time: ${funnel.quote_lead_time_days_avg ?? '—'}d`,
    `On-time milestone: ${fmtPct(kpi.on_time_milestone_pct)}`,
    '',
    audit.summary ? `Data exceptions: ${audit.summary.total_exceptions} total, ${audit.summary.critical_exceptions} critical` : '',
    '',
    'Dashboards:',
    '  https://securederp.in/dashboard/war-room',
    '  https://securederp.in/dashboard/cmd',
    '  https://securederp.in/dashboard/cmd-toc',
  ].filter(Boolean).join('\n');
}

async function runOnce() {
  if (process.env.ERP_DISABLE_CMD_EMAIL === '1') return;
  if (isSunday()) {
    console.log('[cmd-email] Sunday — skipping');
    return;
  }
  if (!isConfigured()) {
    console.log('[cmd-email] SMTP not configured (Admin → Email Settings) — skipping');
    return;
  }
  const db = getDb();
  const snapshot = readSnapshotOrLive(db);
  const subject = `SEPL ERP · Daily Audit · ${todayIso()}`;
  try {
    const r = await sendEmail({
      subject,
      html: buildHtml(snapshot, db),
      text: buildText(snapshot),
    });
    if (r.sent) console.log(`[cmd-email] sent ${todayIso()}: ${r.messageId}`);
    else console.log(`[cmd-email] skipped: ${r.reason}`);
  } catch (e) {
    console.error('[cmd-email] send failed:', e.message);
  }
}

function scheduleAt(hour, minute, fn, label) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now;
  console.log(`[cmd-email] ${label} scheduled for ${next.toLocaleString()} (in ${Math.round(msUntil / 60000)} min)`);
  setTimeout(() => {
    fn().catch(e => console.error('[cmd-email]', e.message));
    setInterval(() => fn().catch(e => console.error('[cmd-email]', e.message)), 24 * 60 * 60 * 1000);
  }, msUntil);
}

function scheduleDailyCmdEmail() {
  if (process.env.ERP_DISABLE_CMD_EMAIL === '1') {
    console.log('[cmd-email] disabled via ERP_DISABLE_CMD_EMAIL');
    return;
  }
  scheduleAt(9, 0, runOnce, '09:00 CMD email');
}

module.exports = { scheduleDailyCmdEmail, runOnce };
