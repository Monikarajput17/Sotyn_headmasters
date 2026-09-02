// Company announcements (Layout bell badge + admin panel).
// Ported from server/routes/announcements.js (Phase-3 Postgres version).
// deno-lint-ignore-file no-explicit-any
import { Router } from "../../_shared/express-lite.ts";
import pg from "../../_shared/pg.ts";
import { authMiddleware } from "../../_shared/auth.ts";
import { notifyAll } from "../../_shared/lib/push.ts";
const router = Router();
router.use(authMiddleware);
const err = (res: any, e: unknown) => res.status(500).json({ error: (e as Error).message });

// All non-expired announcements, pinned first then newest first. Each row
// carries the author's name, an `is_new` flag so the UI can highlight
// announcements posted since this user's last visit to the panel, plus
// `read_count` / `total_users` so admins see "👁 5 of 12 read" at a glance.
router.get("/", async (req, res) => {
  try {
    const seen = await pg.get("SELECT last_seen_at FROM announcement_reads WHERE user_id=?", req.user.id);
    const lastSeen = seen?.last_seen_at || "1970-01-01";
    res.json(await pg.all(`
      SELECT a.*, u.name as created_by_name,
             CASE WHEN a.created_at > ? THEN 1 ELSE 0 END as is_new,
             (SELECT COUNT(*) FROM announcement_reads ar JOIN users u2 ON u2.id = ar.user_id
               WHERE u2.active = 1 AND ar.last_seen_at >= a.created_at) as read_count,
             (SELECT COUNT(*) FROM users u3 WHERE u3.active = 1) as total_users
        FROM announcements a LEFT JOIN users u ON u.id = a.created_by
       WHERE (a.expires_at IS NULL OR a.expires_at > CURRENT_TIMESTAMP)
       ORDER BY a.pinned DESC, a.created_at DESC`, lastSeen));
  } catch (e) { err(res, e); }
});

// Light-weight unread count for the bell icon. Declared before /:id/readers.
router.get("/unread-count", async (req, res) => {
  try {
    const seen = await pg.get("SELECT last_seen_at FROM announcement_reads WHERE user_id=?", req.user.id);
    const lastSeen = seen?.last_seen_at || "1970-01-01";
    const row = await pg.get(`SELECT COUNT(*) as count FROM announcements a
       WHERE a.created_at > ? AND (a.expires_at IS NULL OR a.expires_at > CURRENT_TIMESTAMP)`, lastSeen);
    res.json({ count: row?.count || 0 });
  } catch (e) { err(res, e); }
});

// Admin only — who has read a single announcement and who hasn't yet.
router.get("/:id(\\d+)/readers", async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const ann = await pg.get("SELECT id, title, created_at FROM announcements WHERE id=?", req.params.id);
    if (!ann) return res.status(404).json({ error: "Not found" });
    const readers = await pg.all(`
      SELECT u.id, u.name, u.role, u.department, ar.last_seen_at as seen_at
        FROM users u JOIN announcement_reads ar ON ar.user_id = u.id
       WHERE u.active = 1 AND ar.last_seen_at >= ? ORDER BY ar.last_seen_at ASC`, ann.created_at);
    const nonReaders = await pg.all(`
      SELECT u.id, u.name, u.role, u.department
        FROM users u LEFT JOIN announcement_reads ar ON ar.user_id = u.id
       WHERE u.active = 1 AND (ar.last_seen_at IS NULL OR ar.last_seen_at < ?) ORDER BY u.name`, ann.created_at);
    res.json({ announcement: ann, read_count: readers.length, unread_count: nonReaders.length, readers, non_readers: nonReaders });
  } catch (e) { err(res, e); }
});

// Mark all current announcements as seen for this user — call on panel open.
router.post("/mark-seen", async (req, res) => {
  try {
    await pg.run(`INSERT INTO announcement_reads (user_id, last_seen_at) VALUES (?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP`, req.user.id);
    res.json({ message: "Marked seen" });
  } catch (e) { err(res, e); }
});

// Admin-only — create a new announcement (optional banner image / PDF link —
// mam 2026-05-22: "upload photo option so that can check photo").
router.post("/", async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Only admins can post announcements" });
    const { title, body, pinned, expires_at, attachment_url } = req.body || {};
    const t = String(title || "").trim();
    if (!t) return res.status(400).json({ error: "Title is required" });
    const r = await pg.run(`INSERT INTO announcements (title, body, pinned, expires_at, attachment_url, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
      t, body || "", pinned ? 1 : 0, expires_at || null, attachment_url || null, req.user.id);
    try {
      notifyAll({ title: pinned ? "📌 " + t : "📣 " + t, body: (body || "").slice(0, 180) || "New company announcement", url: "/", tag: `announcement-${r.lastInsertRowid}`, requireInteraction: !!pinned });
    } catch { /* push is best-effort */ }
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { err(res, e); }
});

router.put("/:id(\\d+)", async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Only admins can edit announcements" });
    const { title, body, pinned, expires_at, attachment_url } = req.body || {};
    // Frontend always sends attachment_url — a URL to set/replace or '' to clear. Empty → NULL.
    await pg.run(`UPDATE announcements SET title=?, body=?, pinned=?, expires_at=?, attachment_url=? WHERE id=?`,
      String(title || "").trim(), body || "", pinned ? 1 : 0, expires_at || null, attachment_url || null, req.params.id);
    res.json({ message: "Updated" });
  } catch (e) { err(res, e); }
});

router.delete("/:id(\\d+)", async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Only admins can delete announcements" });
    await pg.run("DELETE FROM announcements WHERE id=?", req.params.id);
    res.json({ message: "Deleted" });
  } catch (e) { err(res, e); }
});

export default router;
