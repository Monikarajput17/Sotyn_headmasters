// Cash fidelity cron — audit items A7 + A14 from mam's audit checklist.
//
// Runs two daily jobs, drift-corrected setTimeout pattern matching
// the existing backup-db / dailyAuditSnapshot / dprAutoPrompt
// schedulers (no node-cron dep):
//
//   00:00  cash_flow_daily rollover — ensures today's row exists
//          with opening = yesterday's closing.  Prevents the runway
//          on the CMD dashboard from showing wrong numbers on days
//          with zero collections.
//
//   01:00  receivables ageing refresh — recomputes ageing_days +
//          ageing_bucket + status for every outstanding receivable.
//          Replaces the manual "Refresh Ageing" button as the
//          primary source of truth (button still works on-demand).
//
// Disable in dev via ERP_DISABLE_CASH_CRON=1.

const { getDb } = require('../db/schema');
const { ensureTodayCashFlowDaily, refreshAllAgeing } = require('../lib/cashSync');

function rollOverCashFlowDaily() {
  if (process.env.ERP_DISABLE_CASH_CRON === '1') return;
  try {
    const db = getDb();
    const r = ensureTodayCashFlowDaily(db);
    if (r.created) {
      console.log(`[cash-fidelity] rolled over cash_flow_daily: new row for ${new Date().toISOString().slice(0,10)} opening=${r.opening_balance}`);
    }
  } catch (e) {
    console.error('[cash-fidelity] rollover failed:', e.message);
  }
}

function refreshAgeingNow() {
  if (process.env.ERP_DISABLE_CASH_CRON === '1') return;
  try {
    const db = getDb();
    const r = refreshAllAgeing(db);
    console.log(`[cash-fidelity] receivables ageing refreshed: ${r.updated}/${r.total} rows`);
  } catch (e) {
    console.error('[cash-fidelity] ageing refresh failed:', e.message);
  }
}

function scheduleAt(hour, minute, fn, label) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now;
  console.log(`[cash-fidelity] ${label} scheduled for ${next.toLocaleString()} (in ${Math.round(msUntil / 60000)} min)`);
  setTimeout(() => {
    fn();
    setInterval(fn, 24 * 60 * 60 * 1000);
  }, msUntil);
}

function scheduleCashFidelity() {
  if (process.env.ERP_DISABLE_CASH_CRON === '1') {
    console.log('[cash-fidelity] disabled via ERP_DISABLE_CASH_CRON');
    return;
  }
  scheduleAt(0,  0, rollOverCashFlowDaily, 'cash_flow_daily rollover');
  scheduleAt(1,  0, refreshAgeingNow,      'receivables ageing refresh');
}

module.exports = {
  scheduleCashFidelity,
  rollOverCashFlowDaily,
  refreshAgeingNow,
};
