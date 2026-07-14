// "WhatsApp" — internal group chat. Uses its OWN database (chat.db, separate
// from erp.db) and pushes live updates over Socket.IO (mam 2026-06-18). Users
// create named groups, add members, chat (text + photo/file). Members-gated,
// read receipts, unread badges. Module key `site_chat`, base /api/site-chat.
const express = require('express');
const { getDb } = require('../db/schema');          // erp.db — only for the user list / names
const { getChatDb } = require('../db/chatDb');       // separate chat database
const { emitChat } = require('../lib/chatSocket');   // real-time push
const { rateLimit } = require('../lib/rateLimit');   // in-memory send backpressure
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const isAdmin = (req) => req.user.role === 'admin';
const isMember = (db, g, u) => !!db.prepare('SELECT 1 FROM chat_group_members WHERE group_id=? AND user_id=?').get(g, u);
// Access = membership; Admin additionally oversees GROUPS but NOT private DMs.
// A 1-on-1 direct message is readable ONLY by its two participants — no admin /
// COO override (mam 2026-06-19: "why coo can check sushila lovely chat").
const canAccess = (db, req, g) => {
  if (isMember(db, g, req.user.id)) return true;
  if (!isAdmin(req)) return false;
  const row = db.prepare('SELECT is_dm FROM chat_groups WHERE id=?').get(g);
  return !!row && !row.is_dm;          // admin sees groups, never private DMs
};
const userName = (uid) => { try { return getDb().prepare('SELECT name FROM users WHERE id=?').get(uid)?.name || ''; } catch { return ''; } };
const markRead = (db, g, uid, knownMax) => {
  // On the send path the caller already holds the just-inserted id (info.lastInsertRowid),
  // which is this group's newest id — so skip the redundant MAX(id) scan. Every other
  // caller passes nothing and still resolves it here, so behaviour is unchanged.
  const max = knownMax != null ? knownMax
    : (db.prepare('SELECT MAX(id) m FROM chat_messages WHERE group_id=?').get(g).m || 0);
  db.prepare(`INSERT INTO chat_reads (group_id,user_id,last_read_id,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)
              ON CONFLICT(group_id,user_id) DO UPDATE SET last_read_id=MAX(last_read_id,excluded.last_read_id), updated_at=CURRENT_TIMESTAMP`).run(g, uid, max);
  return max;
};

// Same "which groups can this user reach" rule as canAccess(), expressed as a
// reusable SQL fragment (exactly one `?` for uid) instead of a materialized id
// list — lets /groups and /unread-count push the admin-vs-member predicate
// straight into the DB instead of enumerating ids into JS first (/site-chat
// perf pass — admin-slowness fix).
const accessWhereFor = (admin) => admin
  ? 'g.is_dm=0 OR g.id IN (SELECT group_id FROM chat_group_members WHERE user_id=?)'
  : 'g.id IN (SELECT group_id FROM chat_group_members WHERE user_id=?)';

// Shared enrichment: DM display name/avatar + last-message/member-count/unread
// per group, scoped to EXACTLY the ids passed in (a full list for the legacy
// unpaginated path, a ~30-row page for the paginated list, or a handful of
// unread groups for the badge) — never re-derives "which groups" itself.
function enrichGroups(db, uid, groups, { withMembers = true } = {}) {
  const dmIds = groups.filter(g => g.is_dm).map(g => g.id);
  const dmTitle = {}, dmUid = {};
  if (dmIds.length) {
    const ph = dmIds.map(() => '?').join(',');
    const byG = {};
    for (const r of db.prepare(`SELECT group_id, user_id, user_name FROM chat_group_members WHERE group_id IN (${ph})`).all(...dmIds)) (byG[r.group_id] ||= []).push(r);
    for (const id of dmIds) {
      const mem = byG[id] || [];
      const others = mem.filter(m => m.user_id !== uid);
      dmTitle[id] = (others.length ? others : mem).map(o => o.user_name).filter(Boolean).join(', ') || 'Direct message';
      dmUid[id] = (others[0] || mem[0])?.user_id || null;
    }
  }
  const gids = groups.map(g => g.id);
  let lastBy = {}, memBy = {}, unreadBy = {};
  if (gids.length) {
    const ph = gids.map(() => '?').join(',');
    lastBy = Object.fromEntries(db.prepare(`SELECT group_id,body,attachment_name,sender_name,created_at FROM chat_messages WHERE id IN (SELECT MAX(id) FROM chat_messages WHERE group_id IN (${ph}) GROUP BY group_id)`).all(...gids).map(l => [l.group_id, l]));
    if (withMembers) {
      memBy = Object.fromEntries(db.prepare(`SELECT group_id,COUNT(*) c FROM chat_group_members WHERE group_id IN (${ph}) GROUP BY group_id`).all(...gids).map(c => [c.group_id, c.c]));
    }
    unreadBy = Object.fromEntries(db.prepare(`SELECT cm.group_id, COUNT(*) c FROM chat_messages cm
        WHERE cm.group_id IN (${ph}) AND cm.sender_id<>? AND cm.id > COALESCE((SELECT last_read_id FROM chat_reads r WHERE r.group_id=cm.group_id AND r.user_id=?),0)
        GROUP BY cm.group_id`).all(...gids, uid, uid).map(c => [c.group_id, c.c]));
  }
  return groups.map(g => ({ ...g, name: g.is_dm ? (dmTitle[g.id] || g.name) : g.name, dm_uid: g.is_dm ? (dmUid[g.id] || null) : null, last: lastBy[g.id] || null, members: memBy[g.id] || 0, unread: unreadBy[g.id] || 0 }));
}
const sortGroups = (groups) => groups.sort((a, b) => { const ta = a.last?.created_at || '', tb = b.last?.created_at || ''; if (ta && tb) return tb.localeCompare(ta); if (ta) return -1; if (tb) return 1; return String(a.name).localeCompare(String(b.name)); });

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
function pageOfGroups(db, { uid, admin, limit, q, cursor }) {
  const accessWhere = accessWhereFor(admin);
  const qWhere = q ? ' AND (g.name LIKE ? OR EXISTS (SELECT 1 FROM chat_group_members m2 WHERE m2.group_id=g.id AND m2.user_id<>? AND m2.user_name LIKE ?))' : '';
  const qParams = q ? [`%${q}%`, uid, `%${q}%`] : [];
  const candidateSql = `SELECT g.id, g.name, g.is_dm, (SELECT MAX(id) FROM chat_messages m WHERE m.group_id=g.id) AS last_id FROM chat_groups g WHERE (${accessWhere})${qWhere}`;
  const phase = cursor?.phase === 2 ? 2 : 1;

  if (phase === 1) {
    const cursorWhere = cursor?.after_last_id != null ? ' AND last_id < ?' : '';
    const cursorParams = cursor?.after_last_id != null ? [cursor.after_last_id] : [];
    let rows = db.prepare(`SELECT * FROM (${candidateSql}) c WHERE last_id IS NOT NULL${cursorWhere} ORDER BY last_id DESC LIMIT ?`)
      .all(uid, ...qParams, ...cursorParams, limit + 1);
    if (rows.length > limit) {
      rows = rows.slice(0, limit);
      return { rows, hasMore: true, nextCursor: { phase: 1, after_last_id: rows[rows.length - 1].last_id } };
    }
    // Phase 1 exhausted this call — fall through into phase 2 from the start.
    const remaining = limit - rows.length;
    const rows2 = db.prepare(`SELECT * FROM (${candidateSql}) c WHERE last_id IS NULL ORDER BY name ASC, id ASC LIMIT ?`).all(uid, ...qParams, remaining + 1);
    const hasMore = rows2.length > remaining;
    const appended = rows2.slice(0, remaining);
    rows = rows.concat(appended);
    const tail = appended.length ? appended[appended.length - 1] : null;
    return { rows, hasMore, nextCursor: hasMore ? { phase: 2, after_name: tail ? tail.name : null, after_id: tail ? tail.id : null } : null };
  }
  // Compound (name, id) keyset — a bare `name > ?` would drop same-named groups.
  const keyWhere = cursor?.after_name != null ? ' AND (name > ? OR (name = ? AND id > ?))' : '';
  const keyParams = cursor?.after_name != null ? [cursor.after_name, cursor.after_name, cursor.after_id ?? 0] : [];
  const rows2 = db.prepare(`SELECT * FROM (${candidateSql}) c WHERE last_id IS NULL${keyWhere} ORDER BY name ASC, id ASC LIMIT ?`).all(uid, ...qParams, ...keyParams, limit + 1);
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
router.get('/ice', (req, res) => {
  const ice = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ];
  try {
    const db = getDb();
    const get = (k) => db.prepare('SELECT value FROM app_settings WHERE key=?').get(k)?.value;
    const url = get('turn_url'), u = get('turn_username'), p = get('turn_password');
    if (url) ice.push({ urls: url, username: u || '', credential: p || '' });
  } catch (_) { /* app_settings may not exist yet */ }
  res.json({ iceServers: ice });
});

router.get('/groups', (req, res) => {
  // ?mine=1 → admin sees only the groups they're actually a member of (the
  // sidebar "Only chats I'm in" toggle). Treating the admin as a non-admin here
  // reuses the exact member-only predicate; pagination/search/counts all follow.
  const db = getChatDb(); const uid = req.user.id; const admin = isAdmin(req) && req.query.mine !== '1';
  // No ?limit → legacy full-list behaviour, unchanged (kept for any other
  // caller that still wants everything at once). Admin here IS every non-DM
  // group + own DMs, same rule as before this perf pass; only the paginated
  // branch below avoids materialising + enriching all of them on every load.
  if (req.query.limit == null) {
    const groups = db.prepare(`SELECT g.id, g.name, g.is_dm FROM chat_groups g WHERE ${accessWhereFor(admin)} ORDER BY g.name`).all(uid);
    return res.json(sortGroups(enrichGroups(db, uid, groups)));
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || GROUP_PAGE, 1), GROUP_MAX);
  const q = String(req.query.q || '').trim();
  const cursor = req.query.phase
    ? { phase: parseInt(req.query.phase, 10), after_last_id: req.query.after_last_id != null ? parseInt(req.query.after_last_id, 10) : null, after_name: req.query.after_name != null ? String(req.query.after_name) : null, after_id: req.query.after_id != null ? parseInt(req.query.after_id, 10) : null }
    : null;
  const { rows, hasMore, nextCursor } = pageOfGroups(db, { uid, admin, limit, q, cursor });
  const groups = sortGroups(enrichGroups(db, uid, rows)).map(({ last_id, ...g }) => g);
  res.json({ groups, hasMore, nextCursor });
});

// Lightweight badge/toast feed for the always-on sidebar poll (Layout.jsx,
// every 25s from every page) — deliberately NOT the same query as /groups.
// `total` is a single uncapped aggregate; `groups` is only the (usually small)
// subset that actually has unread messages, capped, so an admin overseeing a
// large number of groups doesn't pay for every group just to show one number
// (/site-chat perf pass — admin-slowness fix, "chat count concern").
const UNREAD_GROUPS_CAP = 30;
router.get('/unread-count', (req, res) => {
  const db = getChatDb(); const uid = req.user.id; const admin = isAdmin(req);
  const accessIdsSql = `SELECT g.id FROM chat_groups g WHERE ${accessWhereFor(admin)}`;
  const unreadCountSql = `SELECT cm.group_id, COUNT(*) c FROM chat_messages cm
      WHERE cm.group_id IN (${accessIdsSql}) AND cm.sender_id<>?
        AND cm.id > COALESCE((SELECT last_read_id FROM chat_reads r WHERE r.group_id=cm.group_id AND r.user_id=?),0)
      GROUP BY cm.group_id`;
  const total = db.prepare(`SELECT COALESCE(SUM(c),0) AS total FROM (${unreadCountSql})`).get(uid, uid, uid).total;
  if (!total) return res.json({ total: 0, groups: [] });
  const unreadRows = db.prepare(`${unreadCountSql} ORDER BY MAX(cm.id) DESC LIMIT ?`).all(uid, uid, uid, UNREAD_GROUPS_CAP);
  const ids = unreadRows.map(r => r.group_id);
  const ph = ids.map(() => '?').join(',');
  const meta = db.prepare(`SELECT id, name, is_dm FROM chat_groups WHERE id IN (${ph})`).all(...ids);
  const enriched = enrichGroups(db, uid, meta, { withMembers: false });
  const byId = Object.fromEntries(enriched.map(g => [g.id, g]));
  const groups = ids.map(id => byId[id]).filter(Boolean);   // preserve unreadRows' recency order
  res.json({ total, groups });
});

router.post('/groups', requirePermission('site_chat', 'create'), (req, res) => {
  const db = getChatDb();
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Group name is required' });
  const ids = Array.isArray(req.body?.member_ids) ? req.body.member_ids.map(Number).filter(Boolean) : [];
  const gid = db.prepare('INSERT INTO chat_groups (name, created_by, created_by_name) VALUES (?,?,?)').run(name, req.user.id, req.user.name || '').lastInsertRowid;
  const ins = db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id, user_name, added_by) VALUES (?,?,?,?)');
  db.transaction(() => { ins.run(gid, req.user.id, req.user.name || '', req.user.id); for (const u of ids) ins.run(gid, u, userName(u), req.user.id); })();
  emitChat(gid, 'changed', { groupId: gid });
  res.json(db.prepare('SELECT id, name FROM chat_groups WHERE id=?').get(gid));
});

// Direct message — open (or create) a 1-on-1 chat with another user. Open to
// EVERY signed-in user (no create permission needed): personal connect like
// WhatsApp (mam 2026-06-19 "if monika wants send to sushila she can direct").
router.post('/dm', (req, res) => {
  const db = getChatDb();
  const me = req.user.id, other = +req.body?.user_id;
  if (!other || other === me) return res.status(400).json({ error: 'Pick a different person to message' });
  // Reuse an existing DM between exactly these two people, if any.
  const existing = db.prepare(`
    SELECT g.id FROM chat_groups g
    WHERE g.is_dm=1
      AND (SELECT COUNT(*) FROM chat_group_members m WHERE m.group_id=g.id)=2
      AND EXISTS (SELECT 1 FROM chat_group_members m WHERE m.group_id=g.id AND m.user_id=?)
      AND EXISTS (SELECT 1 FROM chat_group_members m WHERE m.group_id=g.id AND m.user_id=?)
    LIMIT 1`).get(me, other);
  if (existing) return res.json({ id: existing.id, name: userName(other) });
  const otherName = userName(other), myName = req.user.name || '';
  const gid = db.prepare('INSERT INTO chat_groups (name, is_dm, created_by, created_by_name) VALUES (?,1,?,?)').run(otherName || 'Direct message', me, myName).lastInsertRowid;
  const ins = db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id, user_name, added_by) VALUES (?,?,?,?)');
  db.transaction(() => { ins.run(gid, me, myName, me); ins.run(gid, other, otherName, me); })();
  emitChat(gid, 'changed', { groupId: gid });
  res.json({ id: gid, name: otherName });
});

// Rename a group — same privilege as managing members (create). DMs can't be
// renamed (their title is always the other person's name).
router.put('/:groupId', requirePermission('site_chat', 'create'), (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'Not a member' });
  if (db.prepare('SELECT is_dm FROM chat_groups WHERE id=?').get(g)?.is_dm) return res.status(400).json({ error: 'A direct message cannot be renamed' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  db.prepare('UPDATE chat_groups SET name=? WHERE id=?').run(name, g);
  emitChat(g, 'changed', { groupId: g });
  res.json({ ok: true });
});

router.delete('/:groupId', requirePermission('site_chat', 'delete'), (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  const grp = db.prepare('SELECT * FROM chat_groups WHERE id=?').get(g);
  if (!grp) return res.status(404).json({ error: 'Not found' });
  if (grp.created_by !== req.user.id && !isAdmin(req)) return res.status(403).json({ error: 'Only the creator or an admin can delete the group' });
  db.transaction(() => {
    db.prepare('DELETE FROM chat_messages WHERE group_id=?').run(g);
    db.prepare('DELETE FROM chat_group_members WHERE group_id=?').run(g);
    db.prepare('DELETE FROM chat_reads WHERE group_id=?').run(g);
    db.prepare('DELETE FROM chat_groups WHERE id=?').run(g);
  })();
  emitChat(g, 'group_deleted', { groupId: g });
  res.json({ ok: true });
});

router.get('/:groupId', (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'You are not a member of this group' });
  const group = db.prepare('SELECT id, name, is_dm FROM chat_groups WHERE id=?').get(g);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  // Cursor pagination (backward-compatible): a client that passes ?limit=N gets
  // the most-recent N (or N older than ?before=<id>) via idx_cmsg_group_id; a
  // client that passes NOTHING gets the full history exactly as before, so the
  // current app is unaffected until it opts in (/site-chat perf pass).
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 0, 0), 100);
  const before = parseInt(req.query.before, 10) || 0;
  let messages, hasMore = false, quotedParents = [];
  if (limit > 0) {
    // Newest-first with a +1 look-ahead to know if older messages remain.
    const rows = before
      ? db.prepare('SELECT * FROM chat_messages WHERE group_id=? AND id < ? ORDER BY id DESC LIMIT ?').all(g, before, limit + 1)
      : db.prepare('SELECT * FROM chat_messages WHERE group_id=? ORDER BY id DESC LIMIT ?').all(g, limit + 1);
    hasMore = rows.length > limit;
    if (hasMore) rows.pop();                 // drop the look-ahead row
    messages = rows.reverse();               // oldest→newest for display
    // Include quoted-reply parents that fall OUTSIDE this page so replies still
    // render their preview (client merges these into its lookup map).
    const oldestId = messages.length ? messages[0].id : 0;
    const parentIds = [...new Set(messages.map(m => m.reply_to_id).filter(id => id && id < oldestId))];
    if (parentIds.length) {
      const ph = parentIds.map(() => '?').join(',');
      quotedParents = db.prepare(`SELECT * FROM chat_messages WHERE id IN (${ph})`).all(...parentIds);
    }
  } else {
    messages = db.prepare('SELECT * FROM chat_messages WHERE group_id=? ORDER BY created_at, id').all(g);
  }
  const members = db.prepare('SELECT user_id, user_name AS name FROM chat_group_members WHERE group_id=? ORDER BY user_name').all(g);
  // DM header = the OTHER participant's name (per viewer), not the stored name.
  if (group.is_dm) group.name = members.filter(m => m.user_id !== req.user.id).map(m => m.name).filter(Boolean).join(', ') || group.name;
  const readRows = db.prepare('SELECT user_id,last_read_id,updated_at FROM chat_reads WHERE group_id=?').all(g);
  const reads = Object.fromEntries(readRows.map(r => [r.user_id, r.last_read_id]));
  const readsAt = Object.fromEntries(readRows.map(r => [r.user_id, r.updated_at]));  // for Message Info read-time
  markRead(db, g, req.user.id);
  // NOTE: deliberately do NOT emitChat('changed') here. Loading a thread used
  // to broadcast 'changed' to the room, but the client reloads the thread on
  // 'changed' → which re-GETs → which re-emits: an infinite self-reinforcing
  // loop that hammered the server and caused intermittent chat errors
  // (mam 2026-06-19). New messages still emit from POST; read receipts refresh
  // via the other members' poll / next message.
  res.json({ group, messages, members, reads, readsAt, hasMore, quotedParents });
});

// Per-user send backpressure (2026-07): caps one user to 40 messages / 10 s → 429,
// so a runaway/abusive client can't flood the single event loop (each POST = several
// sync queries + 2 socket broadcasts). In-memory, site-chat only; keyed by user id
// (authMiddleware has already set req.user). A human never trips this.
const sendLimiter = rateLimit({
  windowMs: 10_000, max: 40, keyFn: (req) => req.user?.id,
  message: 'You are sending messages too fast — take a breath and try again in a moment.',
});

// Any MEMBER can post — gated by group membership ONLY, not any site_chat
// module permission, so anyone added to a group can reply by default
// (mam 2026-06-19: "user add monika she is not able to reply").
router.post('/:groupId', sendLimiter, (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'You are not a member of this group' });
  const { body, attachment_url, attachment_name, reply_to_id } = req.body;
  if ((!body || !String(body).trim()) && !attachment_url) return res.status(400).json({ error: 'Type a message or attach a file' });
  // Quoted reply — only accept an id that belongs to THIS group (mam 2026-06-25).
  let replyId = null;
  if (reply_to_id) {
    const ref = db.prepare('SELECT id FROM chat_messages WHERE id=? AND group_id=?').get(+reply_to_id, g);
    if (ref) replyId = ref.id;
  }
  const info = db.prepare(`INSERT INTO chat_messages (group_id, body, attachment_url, attachment_name, sender_id, sender_name, reply_to_id) VALUES (?,?,?,?,?,?,?)`)
    .run(g, body ? String(body).trim() : null, attachment_url || null, attachment_name || null, req.user.id, req.user.name || '', replyId);
  markRead(db, g, req.user.id, info.lastInsertRowid);   // reuse the just-inserted id — skip the MAX(id) scan
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(info.lastInsertRowid);
  // Emit the new row so an updated client can append it directly. Additive: the
  // current client ignores 'message' and still reloads on 'changed' (perf pass).
  emitChat(g, 'message', row);
  emitChat(g, 'changed', { groupId: g });
  res.json(row);
});

router.post('/:groupId/read', (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'Not a member' });
  const last = markRead(db, g, req.user.id);
  emitChat(g, 'changed', { groupId: g });
  res.json({ last_read_id: last });
});

router.get('/:groupId/members', (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'Not a member' });
  res.json(db.prepare('SELECT user_id, user_name AS name FROM chat_group_members WHERE group_id=? ORDER BY user_name').all(g));
});
router.post('/:groupId/members', requirePermission('site_chat', 'create'), (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'Only a member or admin can add members' });
  const ids = Array.isArray(req.body?.user_ids) ? req.body.user_ids : [];
  const ins = db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id, user_name, added_by) VALUES (?,?,?,?)');
  let added = 0; db.transaction(() => { for (const u of ids) added += ins.run(g, +u, userName(+u), req.user.id).changes; })();
  emitChat(g, 'changed', { groupId: g });
  res.json({ added });
});
router.delete('/:groupId/members/:userId', requirePermission('site_chat', 'create'), (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'Only a member or admin can remove members' });
  db.prepare('DELETE FROM chat_group_members WHERE group_id=? AND user_id=?').run(g, +req.params.userId);
  emitChat(g, 'changed', { groupId: g });
  res.json({ ok: true });
});

router.delete('/:groupId/messages/:msgId', (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'You are not a member of this group' });
  const msg = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.msgId);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  if (msg.sender_id !== req.user.id && !isAdmin(req)) return res.status(403).json({ error: 'You can only delete your own messages' });
  db.prepare('DELETE FROM chat_messages WHERE id=?').run(req.params.msgId);
  emitChat(g, 'changed', { groupId: g });
  res.json({ ok: true });
});

module.exports = router;
