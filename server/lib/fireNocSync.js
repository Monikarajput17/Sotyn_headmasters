// Fire NOC auto-pilot helpers (mam, 2026-05-16: "i need easy to
// user for update but automatically things which you can done").
//
// One file, three jobs:
//   1. expectedStageAndStatus(days, currentStatus)
//      Pure function — given days-to-expiry + the current cycle
//      status, returns the stage + status the cycle SHOULD be in
//      right now.  Returns null when the cycle is in a terminal
//      state the user has explicitly set ('renewed' / 'lost').
//
//   2. syncCycle(db, cycleId)
//      Applies expectedStageAndStatus to a single cycle in a
//      transaction.  Skips writes when nothing changed.  Logs a
//      stage_history NOTE entry so the timeline records the auto-
//      correction with the trigger source.
//
//   3. syncAllActiveCycles(db)
//      Iterates every cycle whose status is not in a terminal
//      state and calls syncCycle on each.  Returns counts.  Cheap
//      enough at our row counts (a few thousand cycles in the worst
//      case) — full pass takes <100 ms on the dev box.
//
// Used by:
//   - server/routes/fireNoc.js  → bulk import + manual create
//   - server/scripts/fireNocCron.js → hourly tick
//   - server/index.js → one-shot backfill on boot (idempotent
//     via app_settings.fire_noc_autosync_backfilled_v1)

function daysToExpiry(isoDate) {
  if (!isoDate) return null;
  return Math.ceil((new Date(isoDate) - new Date()) / 86400000);
}

// Maps days-to-expiry → { stage, status }.  Stage progression mirrors
// stageForDays() in routes/fireNoc.js (kept in sync manually — same
// thresholds).  Status auto-flips to 'lapsed' once the expiry passes
// and stays until mam explicitly marks 'lost' or 'renewed'.
function expectedStageAndStatus(days, currentStatus) {
  // Terminal user-set states — never auto-touch.  Stops the cron
  // from un-doing a manual "Renewed" / "Lost" decision.
  if (currentStatus === 'renewed' || currentStatus === 'lost') return null;
  if (days == null) return null;

  // Stage progression (matches stageForDays in routes/fireNoc.js)
  let stage;
  if (days > 150) stage = 'T-180';
  else if (days > 120) stage = 'T-150';
  else if (days > 90)  stage = 'T-120';
  else if (days > 60)  stage = 'T-90';
  else if (days > 45)  stage = 'T-60';
  else if (days > 30)  stage = 'T-45';
  else if (days > 15)  stage = 'T-30';
  else if (days > 0)   stage = 'T-15';
  else if (days > -30) stage = 'T+30';        // grace period — still chase
  else                 stage = 'LOST_POOL';   // >30 days past expiry → win-back pool

  // Status: 'archived' once expired (so dashboards can split active
  // vs lapsed renewal funnels); 'active' while still in the runway.
  // Note: 'archived' is the schema-allowed status for "past renewal
  // window but kept for win-back".  The CHECK constraint on
  // fire_noc_cycle.status is ('active','lost','renewed','archived')
  // — initial implementation used 'lapsed' which is more readable
  // but rejected by the constraint.  UI translates 'archived' →
  // "Lapsed" for users; the storage value stays 'archived'.
  const status = days < 0 ? 'archived' : 'active';

  return { stage, status };
}

// Apply the auto-correction to a single cycle.  Returns
//   { id, changed: boolean, from, to, reason }
// so callers can build a summary log.
function syncCycle(db, cycleId, opts = {}) {
  const cycle = db.prepare(`
    SELECT id, current_stage, status, expiry_date, owner_user_id
    FROM fire_noc_cycle WHERE id = ?
  `).get(cycleId);
  if (!cycle) return { id: cycleId, changed: false, reason: 'not_found' };

  const days = daysToExpiry(cycle.expiry_date);
  const expected = expectedStageAndStatus(days, cycle.status);
  if (!expected) return { id: cycleId, changed: false, reason: 'terminal_status' };

  const stageNeedsChange  = expected.stage  !== cycle.current_stage;
  const statusNeedsChange = expected.status !== cycle.status;
  if (!stageNeedsChange && !statusNeedsChange) {
    return { id: cycleId, changed: false, reason: 'already_correct' };
  }

  const trigger = opts.trigger || 'auto';
  const noteBits = [];
  if (statusNeedsChange) noteBits.push(`status ${cycle.status} → ${expected.status}`);
  if (stageNeedsChange)  noteBits.push(`stage ${cycle.current_stage} → ${expected.stage}`);
  const noteText = `AUTO · ${trigger} · ${noteBits.join(' · ')} · days_to_expiry=${days}`;

  const txn = db.transaction(() => {
    if (stageNeedsChange) {
      db.prepare(`UPDATE fire_noc_cycle SET current_stage=?, stage_entered_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(expected.stage, cycleId);
      db.prepare(`UPDATE fire_noc_stage_history SET exited_at=CURRENT_TIMESTAMP WHERE cycle_id=? AND to_stage=? AND exited_at IS NULL`)
        .run(cycleId, cycle.current_stage);
    }
    if (statusNeedsChange) {
      db.prepare(`UPDATE fire_noc_cycle SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(expected.status, cycleId);
    }
    try {
      db.prepare(`INSERT INTO fire_noc_stage_history (cycle_id, from_stage, to_stage, triggered_by, notes) VALUES (?, ?, ?, ?, ?)`)
        .run(cycleId, cycle.current_stage, expected.stage, 'system', noteText);
    } catch (e) {
      // UNIQUE(cycle_id, to_stage, entered_at) — same-second dup; safe to swallow
      if (!String(e.message).includes('UNIQUE')) throw e;
    }
  });
  txn();

  return {
    id: cycleId,
    changed: true,
    from: { stage: cycle.current_stage, status: cycle.status },
    to:   { stage: expected.stage,      status: expected.status },
    trigger,
  };
}

// Bulk pass.  Skips terminal-status cycles via WHERE clause so the
// cron doesn't even read them.  Each cycle runs in an isolated
// try/catch so one bad row (e.g. an out-of-range expiry_date)
// can't bring down the whole backfill — failures are recorded
// and reported, valid rows still get corrected.
function syncAllActiveCycles(db, opts = {}) {
  const ids = db.prepare(`
    SELECT id FROM fire_noc_cycle
    WHERE status NOT IN ('renewed', 'lost')
  `).all().map(r => r.id);
  let changed = 0;
  const changes = [];
  const errors = [];
  for (const id of ids) {
    try {
      const r = syncCycle(db, id, opts);
      if (r.changed) {
        changed++;
        changes.push(r);
      }
    } catch (e) {
      errors.push({ cycle_id: id, error: e.message });
    }
  }
  return {
    scanned: ids.length,
    changed,
    failed: errors.length,
    sample_changes: changes.slice(0, 25),
    sample_errors: errors.slice(0, 10),
  };
}

module.exports = {
  daysToExpiry,
  expectedStageAndStatus,
  syncCycle,
  syncAllActiveCycles,
};
