// Admin-only "Daily Activity / Word Count" report.
//
// What it does: for a given date (or date range), walks every audit_log
// row in that window, parses body_summary as JSON, and counts the words
// inside every string value. Aggregates by user + by module so mam can
// see at a glance who typed how much and where.
//
// Counts ALL mutating activities — CREATE, UPDATE, DELETE — per mam's
// instruction "all activities".
//
// Caveats:
//  - body_summary is truncated at 2000 chars by the audit middleware, so
//    very large submissions undercount. We add an `is_truncated` per row.
//  - Skips obvious non-content fields (ids, dates, urls, secrets).

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);
router.use(adminOnly);

// Field names we don't want to count — they're identifiers / metadata,
// not content the user "typed in".
const SKIP_KEYS = new Set([
  'id', 'user_id', 'created_by', 'updated_by', 'approved_by', 'reviewed_by',
  'role_id', 'role_ids', 'permission_id',
  'created_at', 'updated_at', 'date', 'due_date', 'indent_date',
  'token', 'password', 'current_password', 'new_password', 'recovery_code',
  'file_path', 'attachment_url', 'boq_file_link', 'proof_url', 'photo_url',
  'rate', 'amount', 'quantity', 'qty', 'price', 'gst',
  'latitude', 'longitude', 'radius_meters',
  'active', 'is_foc', 'is_tool', 'manual',
  'page', 'limit', 'offset',
]);

// Counts CHARACTERS (letters/digits/punctuation/spaces) in a string —
// per mam's spec ("monika -> 6"). Same junk-filter as the word counter:
// skip pure numbers / URLs / file paths / dates / hex IDs so technical
// values don't inflate the score.
function countCharsInString(s) {
  if (typeof s !== 'string') return 0;
  const t = s.trim();
  if (!t) return 0;
  if (t === '[REDACTED]') return 0;
  if (/^\d+(\.\d+)?$/.test(t)) return 0;                       // pure number
  if (/^https?:\/\//i.test(t)) return 0;                        // url
  if (/^\/?[A-Za-z]:?[\\\/]/.test(t)) return 0;                 // file path
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return 0;                   // ISO date / datetime
  if (/^[a-f0-9-]{8,}$/i.test(t) && !/\s/.test(t)) return 0;    // hex / uuid-ish
  return t.length;                                              // every typed character
}

function countCharsRecursive(value, parentKey) {
  if (value == null) return 0;
  if (typeof value === 'string') {
    if (parentKey && SKIP_KEYS.has(String(parentKey).toLowerCase())) return 0;
    return countCharsInString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return 0;
  if (Array.isArray(value)) {
    let n = 0;
    for (const v of value) n += countCharsRecursive(v, parentKey);
    return n;
  }
  if (typeof value === 'object') {
    let n = 0;
    for (const [k, v] of Object.entries(value)) {
      if (SKIP_KEYS.has(k.toLowerCase())) continue;
      n += countCharsRecursive(v, k);
    }
    return n;
  }
  return 0;
}

function rowCharCount(row) {
  if (!row.body_summary) return { chars: 0, truncated: false };
  const truncated = row.body_summary.endsWith('…');
  let parsed;
  try { parsed = JSON.parse(truncated ? row.body_summary.slice(0, -1) : row.body_summary); }
  catch { return { chars: 0, truncated }; }
  return { chars: countCharsRecursive(parsed), truncated };
}

// GET /api/admin/word-count?date=YYYY-MM-DD
//      &date_from=YYYY-MM-DD &date_to=YYYY-MM-DD  (alt to single date)
//      &user_id=N (optional filter)
//
// Returns aggregates suitable for the dashboard:
//   total_words, total_activities, truncated_activities,
//   by_user:   [{ user_id, user_name, words, activities }]
//   by_module: [{ module, words, activities }]
//   by_action: [{ action, words, activities }]
router.get('/', (req, res) => {
  const db = getDb();
  const { date, user_id } = req.query;
  let dateFrom = req.query.date_from;
  let dateTo = req.query.date_to;
  if (date) { dateFrom = date; dateTo = date; }
  if (!dateFrom) {
    // Default to today (server's local date)
    const d = new Date();
    const iso = d.toISOString().slice(0, 10);
    dateFrom = iso; dateTo = iso;
  }
  if (!dateTo) dateTo = dateFrom;

  const where = ['at >= ?', 'at <= ?', "action IN ('CREATE','UPDATE','DELETE')"];
  const params = [dateFrom + ' 00:00:00', dateTo + ' 23:59:59'];
  if (user_id) { where.push('user_id = ?'); params.push(+user_id); }

  const rows = db.prepare(
    `SELECT id, user_id, user_name, action, entity_type, body_summary
       FROM audit_log
      WHERE ${where.join(' AND ')}
      ORDER BY at DESC`
  ).all(...params);

  const byUser = new Map();
  const byModule = new Map();
  const byAction = new Map();
  let totalChars = 0;
  let truncatedCount = 0;

  for (const r of rows) {
    const { chars, truncated } = rowCharCount(r);
    totalChars += chars;
    if (truncated) truncatedCount += 1;

    const uKey = r.user_id || 0;
    const u = byUser.get(uKey) || { user_id: r.user_id, user_name: r.user_name || '(unknown)', chars: 0, activities: 0 };
    u.chars += chars; u.activities += 1; byUser.set(uKey, u);

    const mod = r.entity_type || '(other)';
    const m = byModule.get(mod) || { module: mod, chars: 0, activities: 0 };
    m.chars += chars; m.activities += 1; byModule.set(mod, m);

    const a = byAction.get(r.action) || { action: r.action, chars: 0, activities: 0 };
    a.chars += chars; a.activities += 1; byAction.set(r.action, a);
  }

  const byUserArr = [...byUser.values()].sort((a, b) => b.chars - a.chars);
  const byModuleArr = [...byModule.values()].sort((a, b) => b.chars - a.chars);
  const byActionArr = [...byAction.values()].sort((a, b) => b.chars - a.chars);

  res.json({
    date_from: dateFrom,
    date_to: dateTo,
    total_chars: totalChars,
    total_activities: rows.length,
    truncated_activities: truncatedCount,
    by_user: byUserArr,
    by_module: byModuleArr,
    by_action: byActionArr,
  });
});

// GET /api/admin/word-count/detail?date=...&user_id=...
// Per-record breakdown so admin can see *what* a user wrote on that day.
router.get('/detail', (req, res) => {
  const db = getDb();
  const { date, user_id } = req.query;
  let dateFrom = req.query.date_from || date;
  let dateTo = req.query.date_to || date;
  if (!dateFrom) {
    const iso = new Date().toISOString().slice(0, 10);
    dateFrom = iso; dateTo = iso;
  }
  if (!dateTo) dateTo = dateFrom;

  const where = ['at >= ?', 'at <= ?', "action IN ('CREATE','UPDATE','DELETE')"];
  const params = [dateFrom + ' 00:00:00', dateTo + ' 23:59:59'];
  if (user_id) { where.push('user_id = ?'); params.push(+user_id); }

  const rows = db.prepare(
    `SELECT id, at, user_id, user_name, action, entity_type, entity_label,
            path, body_summary, ip, user_agent
       FROM audit_log
      WHERE ${where.join(' AND ')}
      ORDER BY at DESC
      LIMIT 1000`
  ).all(...params);

  // Include ip + user_agent so admin can verify WHO actually made an
  // entry (not just whose account was logged in).  Mam (2026-05-15)
  // saw 66 entries attributed to ashutosh BEFORE his account's
  // created_at, suspected Ankur did them — exposing the device fields
  // makes that kind of investigation possible without DB access.
  res.json(rows.map(r => {
    const { chars, truncated } = rowCharCount(r);
    return {
      id: r.id, at: r.at, user_id: r.user_id, user_name: r.user_name,
      action: r.action, module: r.entity_type, entity_label: r.entity_label,
      path: r.path, chars, truncated,
      ip: r.ip || null,
      user_agent: r.user_agent || null,
      body_preview: r.body_summary ? r.body_summary.slice(0, 400) : null,
    };
  }));
});

// GET /api/admin/word-count/user-check/:user_id
// Diagnostic: returns the user record + audit summary so admin can
// see if a user's `created_at` lines up with the audit timeline.
// Used to investigate scenarios like "this user supposedly entered
// rows BEFORE their account existed" — turns out either the account
// was created later from the API/DB tool, or a SHARED-SESSION case
// (someone else using their JWT).  Mam, 2026-05-15.
router.get('/user-check/:user_id', (req, res) => {
  const db = getDb();
  const id = +req.params.user_id;
  if (!id) return res.status(400).json({ error: 'user_id required' });
  const user = db.prepare(
    `SELECT id, name, email, username, role, department, active, created_at
       FROM users WHERE id=?`
  ).get(id);
  const audit = db.prepare(
    `SELECT COUNT(*) total,
            MIN(at) first_action,
            MAX(at) last_action,
            COUNT(DISTINCT ip) distinct_ips,
            COUNT(DISTINCT date(at)) active_days
       FROM audit_log WHERE user_id=?`
  ).get(id);
  const ips = db.prepare(
    `SELECT ip, COUNT(*) c, MIN(at) first_seen, MAX(at) last_seen
       FROM audit_log
      WHERE user_id=? AND ip IS NOT NULL
   GROUP BY ip ORDER BY c DESC LIMIT 10`
  ).all(id);
  const logins = db.prepare(
    `SELECT at, ip, user_agent, status_code, action
       FROM audit_log
      WHERE entity_type='auth' AND user_id=?
        AND action IN ('LOGIN','LOGIN_FAIL','FORGOT_PASSWORD_OK','FORGOT_PASSWORD_OK_EMERGENCY')
   ORDER BY at DESC LIMIT 30`
  ).all(id);
  res.json({ user, audit, ips, logins });
});

module.exports = router;
