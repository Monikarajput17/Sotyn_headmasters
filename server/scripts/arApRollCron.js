// AR/AP collection-day auto-roll cron (mam 2026-06-18).
//
// Money moves on fixed days: AR (receivables) Mon & Thu, AP (payables) Tue &
// Fri. This runs daily at 01:00 (and 90 s after boot for catch-up) and moves
// every still-'planned', not-settled entry whose date has passed onto the next
// collection day for its kind. Each move is logged in the AR/AP change log, so
// it's auditable and reversible. Skip via ERP_DISABLE_ARAP_ROLL=1.
const { getDb } = require('../db/schema');

function runOnce() {
  try {
    const { rollOverdue } = require('../routes/arApTracker');
    if (typeof rollOverdue !== 'function') return;
    const n = rollOverdue(getDb(), { name: 'System (auto-roll)' });
    if (n) console.log(`[arap-roll] rolled ${n} overdue AR entr${n === 1 ? 'y' : 'ies'} to the next Mon/Thu`);
  } catch (e) {
    console.error('[arap-roll] run failed:', e.message);
  }
}

function scheduleAt(hour, minute, fn, label) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  console.log(`[arap-roll] ${label} scheduled for ${next.toLocaleString()}`);
  setTimeout(() => {
    try { fn(); } catch (e) { console.error('[arap-roll]', e.message); }
    setInterval(() => { try { fn(); } catch (e) { console.error('[arap-roll]', e.message); } }, 24 * 60 * 60 * 1000);
  }, next - now);
}

function scheduleArApRollCron() {
  if (process.env.ERP_DISABLE_ARAP_ROLL === '1') { console.log('[arap-roll] disabled via ERP_DISABLE_ARAP_ROLL'); return; }
  setTimeout(runOnce, 90 * 1000);             // boot catch-up
  scheduleAt(1, 0, runOnce, 'daily 01:00');
}

module.exports = { scheduleArApRollCron, runOnce };
