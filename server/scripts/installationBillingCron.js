// Fortnightly installation-billing cron (mam 2026-06-13: "automatically last
// 15 days ... generate sales bill, only give option Sent to Client").
//
// Runs daily at 08:00 (and 90 s after boot for catch-up) but only ACTS on the
// 1st and 16th of the month — i.e. roughly every 15 days. On those days it
// generates Type-3 installation bills from approved, billing-ready DPRs not yet
// billed (amount = each project's DPR work-item value × the order's Against-
// Installation %). Idempotent via dpr.sales_bill_id, so a re-run never double-
// bills. The bills are created APPROVED but NOT sent — a human still clicks
// "Sent to Client" in the Sales Billing screen, so nothing reaches a client
// unattended. Skip via ERP_DISABLE_INSTALL_BILLING=1.

const { getDb } = require('../db/schema');

function isFortnightDay() {
  const d = new Date().getDate();
  return d === 1 || d === 16;
}

function runOnce(force = false) {
  if (!force && !isFortnightDay()) return;
  try {
    const db = getDb();
    const gen = require('../routes/salesBilling').generateInstallationBills;
    if (typeof gen !== 'function') return;
    const r = gen(db, null, { draft: false });
    if (r && r.created) console.log(`[install-billing] generated ${r.created} installation bill(s)`);
  } catch (e) {
    console.error('[install-billing] run failed:', e.message);
  }
}

function scheduleAt(hour, minute, fn, label) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now;
  console.log(`[install-billing] ${label} scheduled for ${next.toLocaleString()}`);
  setTimeout(() => {
    try { fn(); } catch (e) { console.error('[install-billing]', e.message); }
    setInterval(() => { try { fn(); } catch (e) { console.error('[install-billing]', e.message); } }, 24 * 60 * 60 * 1000);
  }, msUntil);
}

function scheduleInstallationBillingCron() {
  if (process.env.ERP_DISABLE_INSTALL_BILLING === '1') {
    console.log('[install-billing] disabled via ERP_DISABLE_INSTALL_BILLING');
    return;
  }
  // Boot catch-up — if today is a fortnight day and the run was missed.
  setTimeout(() => runOnce(false), 90 * 1000);
  scheduleAt(8, 0, () => runOnce(false), 'daily 08:00 (acts on 1st & 16th)');
}

module.exports = { scheduleInstallationBillingCron, runOnce };
