// Fire NOC hourly auto-pilot — mam (2026-05-16): "i need easy to user
// for update but automatically things which you can done".
//
// Every hour:
//   - Recompute days_to_expiry for every non-terminal cycle
//   - Advance the stage if days crossed a threshold (T-180 → T-150
//     → T-120 → … → T+30 → LOST_POOL)
//   - Flip status from 'active' → 'lapsed' the moment expiry passes
//   - Log every change to stage_history with trigger='hourly_cron'
//
// Skip via ERP_DISABLE_FIRE_NOC_CRON=1.
//
// Matches the drift-corrected setTimeout pattern used by all the
// other ERP schedulers (backup-db, dailyAuditSnapshot, dprAutoPrompt,
// cashFidelityCron, dailyCmdEmail).

const { getDb } = require('../db/schema');
const { syncAllActiveCycles } = require('../lib/fireNocSync');

function runHourly() {
  if (process.env.ERP_DISABLE_FIRE_NOC_CRON === '1') return;
  try {
    const db = getDb();
    const r = syncAllActiveCycles(db, { trigger: 'hourly_cron' });
    if (r.changed > 0) {
      console.log(`[fire-noc-cron] ${r.changed}/${r.scanned} cycles auto-corrected`);
    }
  } catch (e) {
    console.error('[fire-noc-cron] failed:', e.message);
  }
}

function scheduleFireNocCron() {
  if (process.env.ERP_DISABLE_FIRE_NOC_CRON === '1') {
    console.log('[fire-noc-cron] disabled via ERP_DISABLE_FIRE_NOC_CRON');
    return;
  }
  // First run 60 s after boot so we don't slow startup, then every hour
  console.log('[fire-noc-cron] scheduled — first run in 60s, then hourly');
  setTimeout(() => {
    runHourly();
    setInterval(runHourly, 60 * 60 * 1000);
  }, 60 * 1000);
}

// Idempotent boot-time backfill — mam already has 100+ rows that
// were imported BEFORE the autosync existed; they're stuck at
// stage=CYCLE_CLOSE / status=active.  Run the sync once on boot,
// guarded by an app_settings flag so it never repeats.
function backfillOnceOnBoot() {
  if (process.env.ERP_DISABLE_FIRE_NOC_CRON === '1') return;
  try {
    const db = getDb();
    // Make sure the flag table exists (it does in production, but
    // belt-and-braces for fresh installs)
    try { db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)`); } catch (_) {}
    const flag = db.prepare(`SELECT value FROM app_settings WHERE key=?`).get('fire_noc_autosync_backfilled_v1');
    if (flag) return;  // already done

    const r = syncAllActiveCycles(db, { trigger: 'boot_backfill' });

    // Always mark the flag — even if some rows failed, we don't want
    // a single bad row to make the backfill retry on every boot
    // forever.  Mam can re-run it manually via the cron tick.  The
    // per-row failures are logged below for transparency.
    db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`)
      .run('fire_noc_autosync_backfilled_v1', new Date().toISOString());

    if (r.failed > 0) {
      console.warn(`[fire-noc-cron] boot backfill partial: ${r.changed}/${r.scanned} cycles corrected, ${r.failed} failed`);
      r.sample_errors.forEach(e => console.warn(`[fire-noc-cron]   cycle ${e.cycle_id}: ${e.error}`));
    } else {
      console.log(`[fire-noc-cron] boot backfill complete: ${r.changed}/${r.scanned} cycles corrected`);
    }
  } catch (e) {
    console.error('[fire-noc-cron] boot backfill failed:', e.message);
  }
}

module.exports = { scheduleFireNocCron, backfillOnceOnBoot, runHourly };
