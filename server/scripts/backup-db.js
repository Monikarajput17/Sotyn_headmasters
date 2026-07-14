// Safe online DB backup using better-sqlite3's native backup API.
//
// Why the API and not a plain file copy? SQLite runs in WAL mode, so a plain
// cp/copy can grab the main file mid-write and produce corruption. The backup
// API uses a proper cursor and produces a guaranteed-consistent snapshot even
// while the server is actively writing.
//
// Output: /root/erp-backups/erp-YYYY-MM-DD_HH-mm-ss.db
// Retention: keeps the most recent 30 backups, deletes older.
// Callable from:
//   - the in-process scheduler (runNightlyBackup)
//   - the admin API (router posts to /api/admin/backups/run)
//   - manually via: node server/scripts/backup-db.js

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'erp.db');
// Keep backups OUTSIDE the data/ folder so a rogue data-wipe doesn't nuke
// the history too. ~/erp-backups/ on the VPS; ../../backups locally.
const BACKUP_DIR = process.env.ERP_BACKUP_DIR
  || (process.platform === 'win32'
    ? path.join(__dirname, '..', '..', 'backups')
    : path.join('/root', 'erp-backups'));
const KEEP_COUNT = 30;

const pad = (n) => String(n).padStart(2, '0');
const tsNow = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
};

async function runBackup({ silent = false } = {}) {
  if (!fs.existsSync(DB_PATH)) {
    const msg = `[backup] Source DB not found at ${DB_PATH}`;
    if (!silent) console.error(msg);
    return { ok: false, error: msg };
  }
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const outName = `erp-${tsNow()}.db`;
  const outPath = path.join(BACKUP_DIR, outName);

  const src = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    await src.backup(outPath);
  } finally {
    src.close();
  }

  const { size } = fs.statSync(outPath);

  // Rotate — keep the last KEEP_COUNT only
  const existing = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('erp-') && f.endsWith('.db'))
    .sort();
  const toDelete = existing.slice(0, Math.max(0, existing.length - KEEP_COUNT));
  for (const f of toDelete) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (e) {}
  }

  // Also back up the SEPARATE chat database (mam 2026-06-18: chat.db is its
  // own file). Same backup API + same 30-file retention, prefixed chat-.
  const CHAT_DB = path.join(__dirname, '..', '..', 'data', 'chat.db');
  if (fs.existsSync(CHAT_DB)) {
    try {
      const cs = new Database(CHAT_DB, { readonly: true, fileMustExist: true });
      try { await cs.backup(path.join(BACKUP_DIR, `chat-${tsNow()}.db`)); } finally { cs.close(); }
      const chats = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('chat-') && f.endsWith('.db')).sort();
      for (const f of chats.slice(0, Math.max(0, chats.length - KEEP_COUNT))) { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (e) {} }
    } catch (e) { if (!silent) console.warn('[backup] chat.db backup failed:', e.message); }
  }

  if (!silent) console.log(`[backup] Wrote ${outName} (${(size / 1024 / 1024).toFixed(2)} MB) — kept ${Math.min(existing.length, KEEP_COUNT)} total`);
  return { ok: true, filename: outName, size, backup_dir: BACKUP_DIR };
}

// Schedule the next run at 02:00 local time and keep it running daily.
// Uses setTimeout (one-shot) chained into itself so timezone/DST shifts are
// picked up automatically each day — cleaner than a fixed 24h setInterval.
function scheduleNightly() {
  const nextRun = () => {
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 2, 0, 0, 0); // 02:00 today
    if (target <= now) target.setDate(target.getDate() + 1); // if already past 2am, schedule for tomorrow
    const delay = target - now;
    setTimeout(async () => {
      try { await runBackup(); } catch (e) { console.error('[backup] Scheduled run failed:', e.message); }
      nextRun(); // reschedule the next one
    }, delay);
    console.log(`[backup] Next scheduled run at ${target.toISOString()} (in ${Math.round(delay / 60000)} min)`);
  };
  nextRun();
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('erp-') && f.endsWith('.db'))
    .map(f => {
      const full = path.join(BACKUP_DIR, f);
      const st = fs.statSync(full);
      return { filename: f, size: st.size, created_at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

module.exports = { runBackup, scheduleNightly, listBackups, BACKUP_DIR };

// If invoked directly via `node server/scripts/backup-db.js`, run once.
if (require.main === module) {
  runBackup()
    .then(r => { process.exit(r.ok ? 0 : 1); })
    .catch(err => { console.error('[backup]', err); process.exit(1); });
}
