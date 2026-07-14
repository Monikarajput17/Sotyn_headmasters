// Dedicated chat database — kept SEPARATE from the main erp.db (mam 2026-06-18:
// "chat db and socket different"). Its own SQLite file (data/chat.db) so chat
// load never touches the ERP DB. User names are denormalised into the chat
// rows (sender_name / user_name) so no cross-database joins are needed.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CHAT_DB_PATH = path.join(DATA_DIR, 'chat.db');
let chatDb = null;

function getChatDb() {
  if (chatDb) return chatDb;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  chatDb = new Database(CHAT_DB_PATH);
  chatDb.pragma('journal_mode = WAL');
  // /site-chat perf pass (2026-07): connection-level tuning only — NO schema or data
  // change. WAL is set above; these cut event-loop time per write and keep hot pages
  // resident. All are per-connection, so they re-apply on every boot / re-open.
  chatDb.pragma('synchronous = NORMAL');   // WAL-safe: fsync at checkpoints, not every commit
  chatDb.pragma('cache_size = -16000');    // ~16 MB page cache (negative = KiB)
  chatDb.pragma('mmap_size = 268435456');  // up to 256 MB memory-mapped reads (maps at most file size)
  chatDb.pragma('temp_store = MEMORY');    // temp b-trees in RAM, not on disk
  chatDb.pragma('busy_timeout = 5000');    // wait up to 5 s on a transient lock instead of throwing
  chatDb.exec(`
    CREATE TABLE IF NOT EXISTS chat_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      created_by INTEGER, created_by_name TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS chat_group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      user_name TEXT, added_by INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(group_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cgm_group ON chat_group_members(group_id);
    CREATE INDEX IF NOT EXISTS idx_cgm_user ON chat_group_members(user_id);
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, body TEXT,
      attachment_url TEXT, attachment_name TEXT, sender_id INTEGER, sender_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_cmsg_group ON chat_messages(group_id, created_at);
    -- /site-chat perf pass: (group_id,id) makes last-message MAX(id), the unread
    -- range scan (id > last_read), and markRead's MAX(id) index seeks instead of
    -- full table scans; sender_id serves the unread filter (sender_id <> me).
    CREATE INDEX IF NOT EXISTS idx_cmsg_group_id ON chat_messages(group_id, id);
    CREATE INDEX IF NOT EXISTS idx_cmsg_sender ON chat_messages(sender_id);
    CREATE TABLE IF NOT EXISTS chat_reads (
      group_id INTEGER NOT NULL, user_id INTEGER NOT NULL, last_read_id INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (group_id, user_id)
    );
  `);
  // is_dm marks a 1-on-1 direct message (mam 2026-06-19) — same tables as a
  // group, but exactly 2 members and shown as the other person's name.
  try {
    const cols = chatDb.prepare("PRAGMA table_info(chat_groups)").all().map(c => c.name);
    if (!cols.includes('is_dm')) chatDb.exec("ALTER TABLE chat_groups ADD COLUMN is_dm INTEGER DEFAULT 0");
  } catch (e) { /* ignore */ }
  // reply_to_id: WhatsApp-style quoted reply — the id of the message this one
  // replies to (mam 2026-06-25). NULL for normal messages.
  try {
    const mcols = chatDb.prepare("PRAGMA table_info(chat_messages)").all().map(c => c.name);
    if (!mcols.includes('reply_to_id')) chatDb.exec("ALTER TABLE chat_messages ADD COLUMN reply_to_id INTEGER");
  } catch (e) { /* ignore */ }
  return chatDb;
}

module.exports = { getChatDb, CHAT_DB_PATH };
