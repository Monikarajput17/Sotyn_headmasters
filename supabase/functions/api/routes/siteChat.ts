// deno-lint-ignore-file no-explicit-any
// "WhatsApp" — internal group chat. Ported from server/routes/siteChat.js
// (Phase-3 Postgres version) + server/lib/chatSocket.js (event semantics).
// Users create named groups, add members, chat (text + photo/file).
// Members-gated, read receipts, unread badges. Module key `site_chat`,
// base /api/site-chat.
//
// Real-time: every Socket.IO `io.to(room).emit(...)` became a Supabase
// Realtime Broadcast (see ./CHAT-REALTIME.md for the exact topics/events):
//   • new message in group G        → topic `chat:group:${G}`, event `message`
//   • message deleted               → topic `chat:group:${G}`, event `message_deleted`
//   • group deleted                 → topic `chat:group:${G}`, event `group_deleted`
//   • "your group list changed"     → topic `user:${uid}`,     event `chat:changed`
//   • WebRTC call signalling        → topic `user:${uid}`,     event `call:signal`
import { Router, type Handler } from "../../_shared/express-lite.ts";
import pg, { type Db } from "../../_shared/pg.ts";
import { authMiddleware, requirePermission } from "../../_shared/auth.ts";
import { broadcast, broadcastMany } from "../../_shared/realtime.ts";
import { storeUpload } from "../../_shared/storage.ts";
const router = Router();
router.use(authMiddleware);

const isAdmin = (req: any) => req.user?.role === "admin";
const isMember = async (db: Db, g: number, u: number) => !!(await db.get("SELECT 1 FROM chat_group_members WHERE group_id=? AND user_id=?", g, u));
// Access = membership; Admin additionally oversees GROUPS but NOT private DMs.
// A 1-on-1 direct message is readable ONLY by its two participants — no admin /
// COO override (mam 2026-06-19: "why coo can check sushila lovely chat").
const canAccess = async (db: Db, req: any, g: number) => {
  if (await isMember(db, g, req.user.id)) return true;
  if (!isAdmin(req)) return false;
  const row = await db.get("SELECT is_dm FROM chat_groups WHERE id=?", g);
  return !!row && !row.is_dm;          // admin sees groups, never private DMs
};
const userName = async (uid: number) => { try { return (await pg.get("SELECT name FROM users WHERE id=?", uid))?.name || ""; } catch { return ""; } };
const markRead = async (db: Db, g: number, uid: number, knownMax?: number | null) => {
  // On the send path the caller already holds the just-inserted id (info.lastInsertRowid),
  // which is this group's newest id — so skip the redundant MAX(id) scan. Every other
  // caller passes nothing and still resolves it here, so behaviour is unchanged.
  const max = knownMax != null ? knownMax
    : ((await db.get("SELECT MAX(id) m FROM chat_messages WHERE group_id=?", g)).m || 0);
  await db.run(`INSERT INTO chat_reads (group_id,user_id,last_read_id,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)
              ON CONFLICT(group_id,user_id) DO UPDATE SET last_read_id=GREATEST(chat_reads.last_read_id,excluded.last_read_id), updated_at=CURRENT_TIMESTAMP`, g, uid, max);
  return max;
};

// ─── Realtime fan-out (Socket.IO room replacement) ──────────────────────────
// The old server delivered a group's events to its room `g:<gid>`, which every
// MEMBER had joined — plus every ADMIN for non-DM groups (chatSocket.roomsFor:
// "Admin joins every GROUP room but only the DM rooms they're a member of").
// audienceFor() reproduces exactly that set as user ids, so the per-user
// `chat:changed` reaches the same people the room broadcast did — and a private
// DM still never reaches an admin who isn't one of its two participants.
async function audienceFor(g: number): Promise<number[]> {
  const ids = new Set<number>();
  for (const r of await pg.all("SELECT user_id FROM chat_group_members WHERE group_id=?", g)) ids.add(Number(r.user_id));
  const grp = await pg.get("SELECT is_dm FROM chat_groups WHERE id=?", g);
  if (grp && !grp.is_dm) {
    for (const a of await pg.all("SELECT id FROM users WHERE role='admin' AND COALESCE(active,1)=1 AND COALESCE(archived,0)=0")) ids.add(Number(a.id));
  }
  return [...ids];
}
// "Something in this group changed — reconcile" → one `chat:changed` per affected
// user on their personal topic. `extra` lets a caller include users who are no
// longer (or not yet) in the member table — e.g. a just-removed member, or the
// members of a group that was deleted a moment ago (audience captured before).
async function notifyChanged(g: number, extra: number[] = []) {
  const uids = new Set<number>([...await audienceFor(g), ...extra]);
  await broadcastMany([...uids].map((uid) => ({ topic: `user:${uid}`, event: "chat:changed", payload: { groupId: g } })));
}

// Same "which groups can this user reach" rule as canAccess(), expressed as a
// reusable SQL fragment (exactly one `?` for uid) instead of a materialized id
// list — lets /groups and /unread-count push the admin-vs-member predicate
// straight into the DB instead of enumerating ids into JS first (/site-chat
// perf pass — admin-slowness fix).
const accessWhereFor = (admin: boolean) => admin
  ? "g.is_dm=0 OR g.id IN (SELECT group_id FROM chat_group_members WHERE user_id=?)"
  : "g.id IN (SELECT group_id FROM chat_group_members WHERE user_id=?)";

// Shared enrichment: DM display name/avatar + last-message/member-count/unread
// per group, scoped to EXACTLY the ids passed in (a full list for the legacy
// unpaginated path, a ~30-row page for the paginated list, or a handful of
// unread groups for the badge) — never re-derives "which groups" itself.
async function enrichGroups(db: Db, uid: number, groups: any[], { withMembers = true }: { withMembers?: boolean } = {}) {
  const dmIds = groups.filter((g) => g.is_dm).map((g) => g.id);
  const dmTitle: Record<number, string> = {}, dmUid: Record<number, number | null> = {};
  if (dmIds.length) {
    const ph = dmIds.map(() => "?").join(",");
    const byG: Record<number, any[]> = {};
    for (const r of await db.all(`SELECT group_id, user_id, user_name FROM chat_group_members WHERE group_id IN (${ph})`, ...dmIds)) (byG[r.group_id] ||= []).push(r);
    for (const id of dmIds) {
      const mem = byG[id] || [];
      const others = mem.filter((m) => m.user_id !== uid);
      dmTitle[id] = (others.length ? others : mem).map((o) => o.user_name).filter(Boolean).join(", ") || "Direct message";
      dmUid[id] = (others[0] || mem[0])?.user_id || null;
    }
  }
  const gids = groups.map((g) => g.id);
  let lastBy: Record<number, any> = {}, memBy: Record<number, number> = {}, unreadBy: Record<number, number> = {};
  if (gids.length) {
    const ph = gids.map(() => "?").join(",");
    lastBy = Object.fromEntries((await db.all(`SELECT group_id,body,attachment_name,sender_name,created_at FROM chat_messages WHERE id IN (SELECT MAX(id) FROM chat_messages WHERE group_id IN (${ph}) GROUP BY group_id)`, ...gids)).map((l) => [l.group_id, l]));
    if (withMembers) {
      memBy = Object.fromEntries((await db.all(`SELECT group_id,COUNT(*) c FROM chat_group_members WHERE group_id IN (${ph}) GROUP BY group_id`, ...gids)).map((c) => [c.group_id, c.c]));
    }
    unreadBy = Object.fromEntries((await db.all(`SELECT cm.group_id, COUNT(*) c FROM chat_messages cm
        WHERE cm.group_id IN (${ph}) AND cm.sender_id<>? AND cm.id > COALESCE((SELECT last_read_id FROM chat_reads r WHERE r.group_id=cm.group_id AND r.user_id=?),0)
        GROUP BY cm.group_id`, ...gids, uid, uid)).map((c) => [c.group_id, c.c]));
  }
  return groups.map((g) => ({ ...g, name: g.is_dm ? (dmTitle[g.id] || g.name) : g.name, dm_uid: g.is_dm ? (dmUid[g.id] || null) : null, last: lastBy[g.id] || null, members: memBy[g.id] || 0, unread: unreadBy[g.id] || 0 }));
}
const sortGroups = (groups: any[]) => groups.sort((a, b) => { const ta = a.last?.created_at || "", tb = b.last?.created_at || ""; if (ta && tb) return tb.localeCompare(ta); if (ta) return -1; if (tb) return 1; return String(a.name).localeCompare(String(b.name)); });

// Default group-list page size + the max a single request may pull. The cap is
// the ceiling for a RESET refetch too: a scrolled-deep admin's poll/socket
// reconcile re-requests Math.max(GROUP_PAGE, rendered count) so their view isn't
// truncated — but only up to GROUP_MAX, past which the cursor re-extends. Mirror
// the message thread's MAX_LIVE=100 ceiling so a busy admin's every-`changed`
// reconcile stays bounded rather than re-aggregating the whole scrolled window.
const GROUP_PAGE = 30;
const GROUP_MAX = 100;

// Keyset page of accessible groups ordered by most-recent-activity-first, then
// messageless groups by name (mirrors sortGroups' tie-break). Two phases so we
// never need a persisted "last activity" column: phase 1 walks groups WITH a
// message via idx_cmsg_group_id (an index descent per candidate group, not a
// table scan); phase 2 (once phase 1 is exhausted) walks message-less groups
// by name. `cursor` is whatever `nextCursor` the previous page returned.
// Phase 1's key (last_id = MAX message id) is globally unique so a bare
// `last_id < ?` is safe. Phase 2's key (name) is NOT unique — group names can
// collide — so it uses a COMPOUND (name, id) keyset; a bare `name > ?` would
// skip the rest of a run of identically-named groups straddling a page edge.
async function pageOfGroups(db: Db, { uid, admin, limit, q, cursor }: { uid: number; admin: boolean; limit: number; q: string; cursor: any }) {
  const accessWhere = accessWhereFor(admin);
  const qWhere = q ? " AND (g.name ILIKE ? OR EXISTS (SELECT 1 FROM chat_group_members m2 WHERE m2.group_id=g.id AND m2.user_id<>? AND m2.user_name ILIKE ?))" : "";
  const qParams = q ? [`%${q}%`, uid, `%${q}%`] : [];
  const candidateSql = `SELECT g.id, g.name, g.is_dm, (SELECT MAX(id) FROM chat_messages m WHERE m.group_id=g.id) AS last_id FROM chat_groups g WHERE (${accessWhere})${qWhere}`;
  const phase = cursor?.phase === 2 ? 2 : 1;

  if (phase === 1) {
    const cursorWhere = cursor?.after_last_id != null ? " AND last_id < ?" : "";
    const cursorParams = cursor?.after_last_id != null ? [cursor.after_last_id] : [];
    let rows = await db.all(`SELECT * FROM (${candidateSql}) c WHERE last_id IS NOT NULL${cursorWhere} ORDER BY last_id DESC LIMIT ?`,
      uid, ...qParams, ...cursorParams, limit + 1);
    if (rows.length > limit) {
      rows = rows.slice(0, limit);
      return { rows, hasMore: true, nextCursor: { phase: 1, after_last_id: rows[rows.length - 1].last_id } };
    }
    // Phase 1 exhausted this call — fall through into phase 2 from the start.
    const remaining = limit - rows.length;
    const rows2 = await db.all(`SELECT * FROM (${candidateSql}) c WHERE last_id IS NULL ORDER BY name ASC, id ASC LIMIT ?`, uid, ...qParams, remaining + 1);
    const hasMore = rows2.length > remaining;
    const appended = rows2.slice(0, remaining);
    rows = rows.concat(appended);
    const tail = appended.length ? appended[appended.length - 1] : null;
    return { rows, hasMore, nextCursor: hasMore ? { phase: 2, after_name: tail ? tail.name : null, after_id: tail ? tail.id : null } : null };
  }
  // Compound (name, id) keyset — a bare `name > ?` would drop same-named groups.
  const keyWhere = cursor?.after_name != null ? " AND (name > ? OR (name = ? AND id > ?))" : "";
  const keyParams = cursor?.after_name != null ? [cursor.after_name, cursor.after_name, cursor.after_id ?? 0] : [];
  const rows2 = await db.all(`SELECT * FROM (${candidateSql}) c WHERE last_id IS NULL${keyWhere} ORDER BY name ASC, id ASC LIMIT ?`, uid, ...qParams, ...keyParams, limit + 1);
  const hasMore = rows2.length > limit;
  const rows = rows2.slice(0, limit);
  const tail = rows[rows.length - 1];
  return { rows, hasMore, nextCursor: hasMore ? { phase: 2, after_name: tail.name, after_id: tail.id } : null };
}

// Membership-driven (mam 2026-06-19: "user add monika she is not able to
// reply"). WhatsApp is open to every signed-in user — you simply see the
// groups you've been added to (admin sees all). NO site_chat module
// permission is needed to view or chat; being a group member IS the access
// control. Only group creation + member management stay privileged below.
// ICE servers for WebRTC calls (mam 2026-06-19). Public STUN works for most
// same-network / simple cases; a TURN server (set turn_url/turn_username/
// turn_password in app_settings, e.g. self-hosted coturn) is needed for calls
// across different networks/NATs.
router.get("/ice", async (_req, res) => {
  const ice: any[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" },
  ];
  try {
    const get = async (k: string) => (await pg.get("SELECT value FROM app_settings WHERE key=?", k))?.value;
    const url = await get("turn_url"), u = await get("turn_username"), p = await get("turn_password");
    if (url) ice.push({ urls: url, username: u || "", credential: p || "" });
  } catch (_) { /* app_settings may not exist yet */ }
  res.json({ iceServers: ice });
});

// WebRTC call signalling (mam 2026-06-19) — was a Socket.IO relay
// (call:offer/answer/ice/reject/end/cancel → the target's personal room
// `u:<uid>`). Now a stateless REST hop: the caller POSTs, we broadcast ONE
// event `call:signal` on the callee's personal topic `user:<toUserId>` with the
// original sub-type inside. Media still goes peer-to-peer (WebRTC); only these
// tiny control messages pass through here.
const CALL_SIGNAL_TYPES = new Set(["offer", "answer", "ice", "reject", "end", "cancel"]);
router.post("/calls/signal", async (req, res) => {
  try {
    const to = parseInt(req.body?.toUserId, 10);
    const type = String(req.body?.type || "").replace(/^call:/, "");
    if (!to) return res.status(400).json({ error: "toUserId required" });
    if (!CALL_SIGNAL_TYPES.has(type)) return res.status(400).json({ error: `type must be one of ${[...CALL_SIGNAL_TYPES].join(", ")}` });
    await broadcast(`user:${to}`, "call:signal", { fromUserId: req.user.id, fromName: req.user.name || "", type, data: req.body?.data ?? {} });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.get("/groups", async (req, res) => {
  try {
    // ?mine=1 → admin sees only the groups they're actually a member of (the
    // sidebar "Only chats I'm in" toggle). Treating the admin as a non-admin here
    // reuses the exact member-only predicate; pagination/search/counts all follow.
    const uid = req.user.id; const admin = isAdmin(req) && req.query.mine !== "1";
    // No ?limit → legacy full-list behaviour, unchanged (kept for any other
    // caller that still wants everything at once). Admin here IS every non-DM
    // group + own DMs, same rule as before this perf pass; only the paginated
    // branch below avoids materialising + enriching all of them on every load.
    if (req.query.limit == null) {
      const groups = await pg.all(`SELECT g.id, g.name, g.is_dm FROM chat_groups g WHERE ${accessWhereFor(admin)} ORDER BY g.name`, uid);
      return res.json(sortGroups(await enrichGroups(pg, uid, groups)));
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || GROUP_PAGE, 1), GROUP_MAX);
    const q = String(req.query.q || "").trim();
    const cursor = req.query.phase
      ? { phase: parseInt(req.query.phase, 10), after_last_id: req.query.after_last_id != null ? parseInt(req.query.after_last_id, 10) : null, after_name: req.query.after_name != null ? String(req.query.after_name) : null, after_id: req.query.after_id != null ? parseInt(req.query.after_id, 10) : null }
      : null;
    const { rows, hasMore, nextCursor } = await pageOfGroups(pg, { uid, admin, limit, q, cursor });
    const groups = sortGroups(await enrichGroups(pg, uid, rows)).map(({ last_id: _last_id, ...g }) => g);
    res.json({ groups, hasMore, nextCursor });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Lightweight badge/toast feed for the always-on sidebar poll (Layout.jsx,
// every 25s from every page) — deliberately NOT the same query as /groups.
// `total` is a single uncapped aggregate; `groups` is only the (usually small)
// subset that actually has unread messages, capped, so an admin overseeing a
// large number of groups doesn't pay for every group just to show one number
// (/site-chat perf pass — admin-slowness fix, "chat count concern").
const UNREAD_GROUPS_CAP = 30;
router.get("/unread-count", async (req, res) => {
  try {
    const uid = req.user.id; const admin = isAdmin(req);
    const accessIdsSql = `SELECT g.id FROM chat_groups g WHERE ${accessWhereFor(admin)}`;
    const unreadCountSql = `SELECT cm.group_id, COUNT(*) c FROM chat_messages cm
        WHERE cm.group_id IN (${accessIdsSql}) AND cm.sender_id<>?
          AND cm.id > COALESCE((SELECT last_read_id FROM chat_reads r WHERE r.group_id=cm.group_id AND r.user_id=?),0)
        GROUP BY cm.group_id`;
    const total = (await pg.get(`SELECT COALESCE(SUM(c),0) AS total FROM (${unreadCountSql}) u`, uid, uid, uid)).total;
    if (!total) return res.json({ total: 0, groups: [] });
    const unreadRows = await pg.all(`${unreadCountSql} ORDER BY MAX(cm.id) DESC LIMIT ?`, uid, uid, uid, UNREAD_GROUPS_CAP);
    const ids = unreadRows.map((r) => r.group_id);
    const ph = ids.map(() => "?").join(",");
    const meta = await pg.all(`SELECT id, name, is_dm FROM chat_groups WHERE id IN (${ph})`, ...ids);
    const enriched = await enrichGroups(pg, uid, meta, { withMembers: false });
    const byId = Object.fromEntries(enriched.map((g) => [g.id, g]));
    const groups = ids.map((id) => byId[id]).filter(Boolean);   // preserve unreadRows' recency order
    res.json({ total, groups });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.post("/groups", requirePermission("site_chat", "create"), async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Group name is required" });
    const ids: number[] = Array.isArray(req.body?.member_ids) ? req.body.member_ids.map(Number).filter(Boolean) : [];
    const gid = (await pg.run("INSERT INTO chat_groups (name, created_by, created_by_name) VALUES (?,?,?)", name, req.user.id, req.user.name || "")).lastInsertRowid!;
    const memberNames: Record<number, string> = {};
    for (const u of ids) memberNames[u] = await userName(u);
    await pg.tx(async (t) => {
      await t.run("INSERT INTO chat_group_members (group_id, user_id, user_name, added_by) VALUES (?,?,?,?) ON CONFLICT DO NOTHING", gid, req.user.id, req.user.name || "", req.user.id);
      for (const u of ids) await t.run("INSERT INTO chat_group_members (group_id, user_id, user_name, added_by) VALUES (?,?,?,?) ON CONFLICT DO NOTHING", gid, u, memberNames[u], req.user.id);
    });
    await notifyChanged(gid);
    res.json(await pg.get("SELECT id, name FROM chat_groups WHERE id=?", gid));
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Direct message — open (or create) a 1-on-1 chat with another user. Open to
// EVERY signed-in user (no create permission needed): personal connect like
// WhatsApp (mam 2026-06-19 "if monika wants send to sushila she can direct").
router.post("/dm", async (req, res) => {
  try {
    const me = req.user.id, other = +req.body?.user_id;
    if (!other || other === me) return res.status(400).json({ error: "Pick a different person to message" });
    // Reuse an existing DM between exactly these two people, if any.
    const existing = await pg.get(`
      SELECT g.id FROM chat_groups g
      WHERE g.is_dm=1
        AND (SELECT COUNT(*) FROM chat_group_members m WHERE m.group_id=g.id)=2
        AND EXISTS (SELECT 1 FROM chat_group_members m WHERE m.group_id=g.id AND m.user_id=?)
        AND EXISTS (SELECT 1 FROM chat_group_members m WHERE m.group_id=g.id AND m.user_id=?)
      LIMIT 1`, me, other);
    if (existing) return res.json({ id: existing.id, name: await userName(other) });
    const otherName = await userName(other), myName = req.user.name || "";
    const gid = (await pg.run("INSERT INTO chat_groups (name, is_dm, created_by, created_by_name) VALUES (?,1,?,?)", otherName || "Direct message", me, myName)).lastInsertRowid!;
    await pg.tx(async (t) => {
      await t.run("INSERT INTO chat_group_members (group_id, user_id, user_name, added_by) VALUES (?,?,?,?) ON CONFLICT DO NOTHING", gid, me, myName, me);
      await t.run("INSERT INTO chat_group_members (group_id, user_id, user_name, added_by) VALUES (?,?,?,?) ON CONFLICT DO NOTHING", gid, other, otherName, me);
    });
    await notifyChanged(gid);
    res.json({ id: gid, name: otherName });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Rename a group — same privilege as managing members (create). DMs can't be
// renamed (their title is always the other person's name).
router.put("/:groupId", requirePermission("site_chat", "create"), async (req, res) => {
  try {
    const g = +req.params.groupId;
    if (!(await canAccess(pg, req, g))) return res.status(403).json({ error: "Not a member" });
    if ((await pg.get("SELECT is_dm FROM chat_groups WHERE id=?", g))?.is_dm) return res.status(400).json({ error: "A direct message cannot be renamed" });
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Name required" });
    await pg.run("UPDATE chat_groups SET name=? WHERE id=?", name, g);
    await notifyChanged(g);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.delete("/:groupId", requirePermission("site_chat", "delete"), async (req, res) => {
  try {
    const g = +req.params.groupId;
    const grp = await pg.get("SELECT * FROM chat_groups WHERE id=?", g);
    if (!grp) return res.status(404).json({ error: "Not found" });
    if (grp.created_by !== req.user.id && !isAdmin(req)) return res.status(403).json({ error: "Only the creator or an admin can delete the group" });
    const audience = await audienceFor(g);          // capture BEFORE the rows are gone
    await pg.tx(async (t) => {
      await t.run("DELETE FROM chat_messages WHERE group_id=?", g);
      await t.run("DELETE FROM chat_group_members WHERE group_id=?", g);
      await t.run("DELETE FROM chat_reads WHERE group_id=?", g);
      await t.run("DELETE FROM chat_groups WHERE id=?", g);
    });
    await broadcast(`chat:group:${g}`, "group_deleted", { groupId: g });
    await broadcastMany(audience.map((uid) => ({ topic: `user:${uid}`, event: "chat:changed", payload: { groupId: g } })));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.get("/:groupId", async (req, res) => {
  try {
    const g = +req.params.groupId;
    if (!(await canAccess(pg, req, g))) return res.status(403).json({ error: "You are not a member of this group" });
    const group = await pg.get("SELECT id, name, is_dm FROM chat_groups WHERE id=?", g);
    if (!group) return res.status(404).json({ error: "Group not found" });
    // Cursor pagination (backward-compatible): a client that passes ?limit=N gets
    // the most-recent N (or N older than ?before=<id>) via idx_cmsg_group_id; a
    // client that passes NOTHING gets the full history exactly as before, so the
    // current app is unaffected until it opts in (/site-chat perf pass).
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 0, 0), 100);
    const before = parseInt(req.query.before, 10) || 0;
    let messages: any[], hasMore = false, quotedParents: any[] = [];
    if (limit > 0) {
      // Newest-first with a +1 look-ahead to know if older messages remain.
      const rows = before
        ? await pg.all("SELECT * FROM chat_messages WHERE group_id=? AND id < ? ORDER BY id DESC LIMIT ?", g, before, limit + 1)
        : await pg.all("SELECT * FROM chat_messages WHERE group_id=? ORDER BY id DESC LIMIT ?", g, limit + 1);
      hasMore = rows.length > limit;
      if (hasMore) rows.pop();                 // drop the look-ahead row
      messages = rows.reverse();               // oldest→newest for display
      // Include quoted-reply parents that fall OUTSIDE this page so replies still
      // render their preview (client merges these into its lookup map).
      const oldestId = messages.length ? messages[0].id : 0;
      const parentIds = [...new Set(messages.map((m) => m.reply_to_id).filter((id) => id && id < oldestId))];
      if (parentIds.length) {
        const ph = parentIds.map(() => "?").join(",");
        quotedParents = await pg.all(`SELECT * FROM chat_messages WHERE id IN (${ph})`, ...parentIds);
      }
    } else {
      messages = await pg.all("SELECT * FROM chat_messages WHERE group_id=? ORDER BY created_at, id", g);
    }
    const members = await pg.all("SELECT user_id, user_name AS name FROM chat_group_members WHERE group_id=? ORDER BY user_name", g);
    // DM header = the OTHER participant's name (per viewer), not the stored name.
    if (group.is_dm) group.name = members.filter((m) => m.user_id !== req.user.id).map((m) => m.name).filter(Boolean).join(", ") || group.name;
    const readRows = await pg.all("SELECT user_id,last_read_id,updated_at FROM chat_reads WHERE group_id=?", g);
    const reads = Object.fromEntries(readRows.map((r) => [r.user_id, r.last_read_id]));
    const readsAt = Object.fromEntries(readRows.map((r) => [r.user_id, r.updated_at]));  // for Message Info read-time
    await markRead(pg, g, req.user.id);
    // NOTE: deliberately do NOT broadcast 'chat:changed' here. Loading a thread used
    // to broadcast 'changed' to the room, but the client reloads the thread on
    // 'changed' → which re-GETs → which re-emits: an infinite self-reinforcing
    // loop that hammered the server and caused intermittent chat errors
    // (mam 2026-06-19). New messages still emit from POST; read receipts refresh
    // via the other members' poll / next message.
    res.json({ group, messages, members, reads, readsAt, hasMore, quotedParents });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Per-user send backpressure (2026-07): caps one user to 40 messages / 10 s → 429,
// so a runaway/abusive client can't flood the backend. Keyed by user id
// (authMiddleware has already set req.user). A human never trips this.
// Edge Function note: the counter lives in THIS isolate's memory — several
// isolates may serve the same user, so the cap is best-effort (per isolate),
// not a hard global limit. Same trade-off as the old in-memory limiter across
// pm2 workers; good enough for its purpose (backpressure, not security).
const SEND_WINDOW_MS = 10_000, SEND_MAX = 40;
const sendBuckets = new Map<number, number[]>();
const sendLimiter: Handler = (req, res, next) => {
  const key = req.user?.id;
  if (!key) return next();
  const now = Date.now();
  const hits = (sendBuckets.get(key) || []).filter((t) => now - t < SEND_WINDOW_MS);
  if (hits.length >= SEND_MAX) {
    sendBuckets.set(key, hits);
    return res.status(429).json({ error: "You are sending messages too fast — take a breath and try again in a moment." });
  }
  hits.push(now); sendBuckets.set(key, hits);
  if (sendBuckets.size > 2000) for (const [k, v] of sendBuckets) if (!v.length || now - v[v.length - 1] >= SEND_WINDOW_MS) sendBuckets.delete(k);
  next();
};

// Any MEMBER can post — gated by group membership ONLY, not any site_chat
// module permission, so anyone added to a group can reply by default
// (mam 2026-06-19: "user add monika she is not able to reply").
// Attachments: the page uploads via POST /upload first and sends the URL in
// the JSON body (unchanged). Additionally, a multipart POST with a `file` part
// is stored straight into Storage (folder `chat`) and becomes the attachment.
router.post("/:groupId", sendLimiter, async (req, res) => {
  try {
    const g = +req.params.groupId;
    if (!(await canAccess(pg, req, g))) return res.status(403).json({ error: "You are not a member of this group" });
    const { body, reply_to_id } = req.body || {};
    let { attachment_url, attachment_name } = req.body || {};
    const f = req.file || (req.files && req.files[0]);
    if (f) {
      if (f.size > 20 * 1024 * 1024) return res.status(413).json({ error: "File too large (max 20 MB)" });
      const { url } = await storeUpload(f, "chat");
      attachment_url = url;
      attachment_name = attachment_name || f.originalname;
    }
    if ((!body || !String(body).trim()) && !attachment_url) return res.status(400).json({ error: "Type a message or attach a file" });
    // Quoted reply — only accept an id that belongs to THIS group (mam 2026-06-25).
    let replyId: number | null = null;
    if (reply_to_id) {
      const ref = await pg.get("SELECT id FROM chat_messages WHERE id=? AND group_id=?", +reply_to_id, g);
      if (ref) replyId = ref.id;
    }
    const info = await pg.run(`INSERT INTO chat_messages (group_id, body, attachment_url, attachment_name, sender_id, sender_name, reply_to_id) VALUES (?,?,?,?,?,?,?)`,
      g, body ? String(body).trim() : null, attachment_url || null, attachment_name || null, req.user.id, req.user.name || "", replyId);
    await markRead(pg, g, req.user.id, info.lastInsertRowid);   // reuse the just-inserted id — skip the MAX(id) scan
    const row = await pg.get("SELECT * FROM chat_messages WHERE id=?", info.lastInsertRowid);
    // Push the new row so an updated client can append it directly (group topic),
    // then tell every affected user their list/unread changed (personal topics).
    await broadcast(`chat:group:${g}`, "message", row);
    await notifyChanged(g);
    res.json(row);
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.post("/:groupId/read", async (req, res) => {
  try {
    const g = +req.params.groupId;
    if (!(await canAccess(pg, req, g))) return res.status(403).json({ error: "Not a member" });
    const last = await markRead(pg, g, req.user.id);
    await notifyChanged(g);
    res.json({ last_read_id: last });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.get("/:groupId/members", async (req, res) => {
  try {
    const g = +req.params.groupId;
    if (!(await canAccess(pg, req, g))) return res.status(403).json({ error: "Not a member" });
    res.json(await pg.all("SELECT user_id, user_name AS name FROM chat_group_members WHERE group_id=? ORDER BY user_name", g));
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});
router.post("/:groupId/members", requirePermission("site_chat", "create"), async (req, res) => {
  try {
    const g = +req.params.groupId;
    if (!(await canAccess(pg, req, g))) return res.status(403).json({ error: "Only a member or admin can add members" });
    const ids: any[] = Array.isArray(req.body?.user_ids) ? req.body.user_ids : [];
    const memberNames: Record<number, string> = {};
    for (const u of ids) memberNames[+u] = await userName(+u);
    let added = 0;
    await pg.tx(async (t) => {
      for (const u of ids) added += (await t.run("INSERT INTO chat_group_members (group_id, user_id, user_name, added_by) VALUES (?,?,?,?) ON CONFLICT DO NOTHING", g, +u, memberNames[+u], req.user.id)).changes;
    });
    await notifyChanged(g);                          // new members are in the table now → included
    res.json({ added });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});
router.delete("/:groupId/members/:userId", requirePermission("site_chat", "create"), async (req, res) => {
  try {
    const g = +req.params.groupId;
    if (!(await canAccess(pg, req, g))) return res.status(403).json({ error: "Only a member or admin can remove members" });
    const removed = +req.params.userId;
    await pg.run("DELETE FROM chat_group_members WHERE group_id=? AND user_id=?", g, removed);
    await notifyChanged(g, [removed]);               // the removed user's list changed too
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.delete("/:groupId/messages/:msgId", async (req, res) => {
  try {
    const g = +req.params.groupId;
    if (!(await canAccess(pg, req, g))) return res.status(403).json({ error: "You are not a member of this group" });
    const msg = await pg.get("SELECT * FROM chat_messages WHERE id=?", req.params.msgId);
    if (!msg) return res.status(404).json({ error: "Not found" });
    if (msg.sender_id !== req.user.id && !isAdmin(req)) return res.status(403).json({ error: "You can only delete your own messages" });
    await pg.run("DELETE FROM chat_messages WHERE id=?", req.params.msgId);
    await broadcast(`chat:group:${g}`, "message_deleted", { id: msg.id });
    await notifyChanged(g);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

export default router;
