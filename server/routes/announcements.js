const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// All non-expired announcements, pinned first then newest first. Each row
// carries the author's name, an `is_new` flag so the UI can highlight
// announcements posted since this user's last visit to the panel, plus
// `read_count` / `total_users` so admins see "👁 5 of 12 read" at a glance.
router.get('/', (req, res) => {
  const db = getDb();
  const seen = db.prepare('SELECT last_seen_at FROM announcement_reads WHERE user_id=?').get(req.user.id);
  const lastSeen = seen?.last_seen_at || '1970-01-01';
  const rows = db.prepare(`
    SELECT a.*, u.name as created_by_name,
           CASE WHEN a.created_at > ? THEN 1 ELSE 0 END as is_new,
           (SELECT COUNT(*) FROM announcement_reads ar
              JOIN users u2 ON u2.id = ar.user_id
             WHERE u2.active = 1 AND ar.last_seen_at >= a.created_at) as read_count,
           (SELECT COUNT(*) FROM users u3 WHERE u3.active = 1) as total_users
      FROM announcements a
      LEFT JOIN users u ON u.id = a.created_by
     WHERE (a.expires_at IS NULL OR a.expires_at > CURRENT_TIMESTAMP)
     ORDER BY a.pinned DESC, a.created_at DESC
  `).all(lastSeen);
  res.json(rows);
});

// Admin only — drill-down for a single announcement showing who has read it
// (last_seen_at >= announcement.created_at) and who hasn't yet.
router.get('/:id/readers', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const db = getDb();
  const ann = db.prepare('SELECT id, title, created_at FROM announcements WHERE id=?').get(req.params.id);
  if (!ann) return res.status(404).json({ error: 'Not found' });
  const readers = db.prepare(`
    SELECT u.id, u.name, u.role, u.department, ar.last_seen_at as seen_at
      FROM users u
      JOIN announcement_reads ar ON ar.user_id = u.id
     WHERE u.active = 1 AND ar.last_seen_at >= ?
     ORDER BY ar.last_seen_at ASC
  `).all(ann.created_at);
  const nonReaders = db.prepare(`
    SELECT u.id, u.name, u.role, u.department
      FROM users u
      LEFT JOIN announcement_reads ar ON ar.user_id = u.id
     WHERE u.active = 1
       AND (ar.last_seen_at IS NULL OR ar.last_seen_at < ?)
     ORDER BY u.name
  `).all(ann.created_at);
  res.json({
    announcement: ann,
    read_count: readers.length,
    unread_count: nonReaders.length,
    readers,
    non_readers: nonReaders,
  });
});

// Light-weight unread count for the bell icon — used in the header layout
// so we don't have to fetch all announcement bodies just to know the badge.
router.get('/unread-count', (req, res) => {
  const db = getDb();
  const seen = db.prepare('SELECT last_seen_at FROM announcement_reads WHERE user_id=?').get(req.user.id);
  const lastSeen = seen?.last_seen_at || '1970-01-01';
  const row = db.prepare(`
    SELECT COUNT(*) as count
      FROM announcements a
     WHERE a.created_at > ?
       AND (a.expires_at IS NULL OR a.expires_at > CURRENT_TIMESTAMP)
  `).get(lastSeen);
  res.json({ count: row?.count || 0 });
});

// Mark all current announcements as seen for this user — call on panel open.
router.post('/mark-seen', (req, res) => {
  const db = getDb();
  // UPSERT: insert if missing, otherwise bump last_seen_at to now.
  db.prepare(`
    INSERT INTO announcement_reads (user_id, last_seen_at)
    VALUES (?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP
  `).run(req.user.id);
  res.json({ message: 'Marked seen' });
});

// Admin-only — create a new announcement.
router.post('/', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can post announcements' });
  // Mam (2026-05-22): "upload photo option so that can check photo" —
  // admin can attach a banner image (or PDF link) alongside title/body.
  const { title, body, pinned, expires_at, attachment_url } = req.body || {};
  const t = String(title || '').trim();
  if (!t) return res.status(400).json({ error: 'Title is required' });
  const r = getDb().prepare(`
    INSERT INTO announcements (title, body, pinned, expires_at, attachment_url, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(t, body || '', pinned ? 1 : 0, expires_at || null, attachment_url || null, req.user.id);
  // Push to every active user — company-wide alert.
  try {
    const { notifyAll } = require('../lib/push');
    notifyAll({
      title: pinned ? '📌 ' + t : '📣 ' + t,
      body: (body || '').slice(0, 180) || 'New company announcement',
      url: '/',
      tag: `announcement-${r.lastInsertRowid}`,
      requireInteraction: !!pinned,
    });
  } catch {}
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can edit announcements' });
  const { title, body, pinned, expires_at, attachment_url } = req.body || {};
  // Mam (2026-05-22): frontend always sends attachment_url — either a
  // URL string (to set/replace) or '' (to clear).  Empty/undefined → NULL.
  getDb().prepare(`
    UPDATE announcements
       SET title=?, body=?, pinned=?, expires_at=?, attachment_url=?
     WHERE id=?
  `).run(
    String(title || '').trim(),
    body || '',
    pinned ? 1 : 0,
    expires_at || null,
    attachment_url || null,
    req.params.id,
  );
  res.json({ message: 'Updated' });
});

router.delete('/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can delete announcements' });
  getDb().prepare('DELETE FROM announcements WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
