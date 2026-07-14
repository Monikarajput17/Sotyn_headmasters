// Procurement reminder cron — mam (2026-05-29):
// "only 1 day before reminder and suggestion".
//
// Every weekday at 09:00 (and again 60 s after boot so a fresh deploy
// catches anything missed overnight) we:
//   1. compute "tomorrow business day" — i.e. add 1 calendar day,
//      then skip Sundays + procurement_holidays;
//   2. scan procurement_schedule for live rows with phase='indent'
//      whose end_date equals that tomorrow-business-day;
//   3. for each match, insert ONE announcement (auto-expires in 48 h)
//      with a short suggestion line generated from the AI reasoning
//      already saved on the schedule row.
//
// Dedup: a tiny procurement_schedule_reminders table tracks
// (schedule_row_id, reminder_date) so two boots / two cron firings on
// the same day never double-post.  Once the announcement goes in, it
// also pushes via web-push (same path as Admin → Announcements).
//
// Skip via ERP_DISABLE_PROCSCH_REMINDER=1.

const { getDb } = require('../db/schema');

// Date helpers — IMPORTANT: build YYYY-MM-DD from LOCAL Date parts
// (not toISOString) because in IST (UTC+5:30), toISOString().slice(0,10)
// of a freshly-incremented local midnight drifts back to the previous
// UTC date — i.e. addDaysIso('2026-05-29', 1) would return '2026-05-29'
// instead of '2026-05-30'.  Caught by the smoke test.
function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function addDaysIso(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const ny = dt.getFullYear();
  const nm = String(dt.getMonth() + 1).padStart(2, '0');
  const nd = String(dt.getDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

function isoDow(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getDay(); // 0 = Sunday
}

// "Tomorrow business day" — bump forward 1 calendar day, then keep
// stepping past Sundays + holidays until we land on a working day.
// Mirrors the backward-pass business-day logic the schedule itself
// uses, so the reminder lines up exactly with the indent end_date.
function tomorrowBusinessDay(db, fromIso) {
  const holSet = new Set(
    db.prepare(`SELECT holiday_date FROM procurement_holidays`).all().map(r => r.holiday_date)
  );
  let cur = addDaysIso(fromIso, 1);
  // Skip Sundays + admin-flagged holidays
  for (let i = 0; i < 30; i++) {
    if (isoDow(cur) !== 0 && !holSet.has(cur)) return cur;
    cur = addDaysIso(cur, 1);
  }
  return cur; // safety fallback (should never hit; 30-day holiday stretch unrealistic)
}

function ensureReminderTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS procurement_schedule_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_row_id INTEGER NOT NULL,
      reminder_date DATE NOT NULL,
      announcement_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(schedule_row_id, reminder_date)
    );
    CREATE INDEX IF NOT EXISTS idx_procsch_reminders_date
      ON procurement_schedule_reminders(reminder_date);
  `);
}

// Build a short, mam-friendly suggestion.  Re-uses the AI reasoning
// the regenerate step already saved if present, otherwise falls back
// to a generic nudge that still names the trade.
function buildSuggestion(row) {
  const reasoning = (row.ai_reasoning || '').trim();
  const qtyHint = row.boq_qty && row.unit
    ? `${row.boq_qty} ${row.unit}`
    : (row.boq_qty ? String(row.boq_qty) : '');
  if (reasoning) {
    // Surface the AI's weekly breakdown verbatim — that's why we
    // upgraded the AI prompt yesterday.
    return reasoning;
  }
  const tradeBit = row.trade ? ` (${row.trade})` : '';
  return qtyHint
    ? `Raise indent for ${qtyHint}${tradeBit} — vendor lead time builds in from tomorrow.`
    : `Raise indent today${tradeBit} so the procurement chain stays on schedule.`;
}

function buildAnnouncement(row) {
  const itemName = row.item_description || '(unnamed BOQ item)';
  const projectBit = row.project_name ? ` · ${row.project_name}` : '';
  const title = `⏰ Raise indent tomorrow: ${itemName}${projectBit}`.slice(0, 180);
  const body = [
    `Indent deadline: ${row.end_date} (tomorrow).`,
    row.boq_qty != null ? `Quantity: ${row.boq_qty}${row.unit ? ' ' + row.unit : ''}.` : '',
    row.trade ? `Trade: ${row.trade}.` : '',
    '',
    `Suggestion: ${buildSuggestion(row)}`,
    '',
    `Open Procurement Schedule → project to file the indent now.`,
  ].filter(Boolean).join('\n');
  return { title, body };
}

function runOnce() {
  if (process.env.ERP_DISABLE_PROCSCH_REMINDER === '1') return { scanned: 0, posted: 0, skipped: 0 };
  const db = getDb();
  ensureReminderTable(db);

  const today = todayIso();
  const targetDate = tomorrowBusinessDay(db, today);

  // Live schedule rows whose indent end_date == targetDate.
  // Hydrate item description, unit, qty, project name — exactly the
  // join shape /api/procurement-schedule/:id already uses.
  const rows = db.prepare(`
    SELECT s.id, s.project_id, s.item_id, s.trade, s.phase, s.end_date,
           s.ai_reasoning,
           pi.description AS item_description, pi.unit, pi.quantity AS boq_qty,
           bb.company_name AS project_name
      FROM procurement_schedule s
      LEFT JOIN po_items pi      ON pi.id = s.item_id
      LEFT JOIN business_book bb ON bb.id = s.project_id
     WHERE s.phase = 'indent'
       AND s.end_date = ?
  `).all(targetDate);

  if (rows.length === 0) {
    return { scanned: 0, posted: 0, skipped: 0, targetDate };
  }

  const checkSent = db.prepare(`
    SELECT 1 FROM procurement_schedule_reminders
      WHERE schedule_row_id = ? AND reminder_date = ?
  `);
  const insertReminder = db.prepare(`
    INSERT OR IGNORE INTO procurement_schedule_reminders
      (schedule_row_id, reminder_date, announcement_id)
    VALUES (?, ?, ?)
  `);
  // Expire the announcement 48 h out so old reminders don't clog the
  // bell.  pinned=0 — these are tactical nudges, not company news.
  const insertAnn = db.prepare(`
    INSERT INTO announcements (title, body, pinned, expires_at, created_by)
    VALUES (?, ?, 0, ?, NULL)
  `);
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  let posted = 0, skipped = 0;
  for (const r of rows) {
    if (checkSent.get(r.id, today)) { skipped++; continue; }
    try {
      const { title, body } = buildAnnouncement(r);
      const ins = insertAnn.run(title, body, expiresAt);
      insertReminder.run(r.id, today, ins.lastInsertRowid);
      posted++;

      // Best-effort web-push so users with notifications enabled get
      // the nudge on the device too.  Same shape as the admin POST
      // /api/announcements path.
      try {
        const { notifyAll } = require('../lib/push');
        notifyAll({
          title: '📣 ' + title,
          body: body.slice(0, 180),
          url: `/procurement-schedule?project=${r.project_id}`,
          tag: `procsch-reminder-${r.id}-${today}`,
          requireInteraction: false,
        });
      } catch (_) { /* push is optional */ }
    } catch (e) {
      console.error('[procsch-reminder] post failed for row', r.id, e.message);
    }
  }

  console.log(`[procsch-reminder] ${today} → target ${targetDate}: posted ${posted}, skipped(dedup) ${skipped}, scanned ${rows.length}`);
  return { scanned: rows.length, posted, skipped, targetDate };
}

function scheduleAt(hour, minute, fn, label) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now;
  console.log(`[procsch-reminder] ${label} scheduled for ${next.toLocaleString()} (in ${Math.round(msUntil / 60000)} min)`);
  setTimeout(() => {
    try { fn(); } catch (e) { console.error('[procsch-reminder]', e.message); }
    setInterval(() => {
      try { fn(); } catch (e) { console.error('[procsch-reminder]', e.message); }
    }, 24 * 60 * 60 * 1000);
  }, msUntil);
}

function scheduleProcurementReminderCron() {
  if (process.env.ERP_DISABLE_PROCSCH_REMINDER === '1') {
    console.log('[procsch-reminder] disabled via ERP_DISABLE_PROCSCH_REMINDER');
    return;
  }
  // Boot catch-up — 60 s after start, so a fresh deploy fires any
  // reminders the previous (possibly down) instance missed. Dedup
  // table makes this safe to re-run.
  setTimeout(() => {
    try { runOnce(); } catch (e) { console.error('[procsch-reminder] boot run failed:', e.message); }
  }, 60 * 1000);
  // Daily 09:00 local time — mirrors the CMD email cadence.
  scheduleAt(9, 0, runOnce, 'daily 09:00 reminder');
}

module.exports = { scheduleProcurementReminderCron, runOnce };
