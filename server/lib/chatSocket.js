// Socket.IO layer for the chat — real-time message / read / member updates,
// SEPARATE from the rest of the ERP (mam 2026-06-18). Authenticated with the
// same JWT as the REST API. Each connection joins a room per group it belongs
// to (g:<groupId>); the chat route calls emitChat() to push live events.
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { getSecret } = require('../middleware/auth');
const { getChatDb } = require('../db/chatDb');

let io = null;

function roomsFor(uid, admin) {
  const db = getChatDb();
  // Admin joins every GROUP room but only the DM rooms they're a member of —
  // private DMs are never delivered to admin/COO (mam 2026-06-19).
  const rows = admin
    ? db.prepare('SELECT id AS gid FROM chat_groups WHERE is_dm=0 OR id IN (SELECT group_id FROM chat_group_members WHERE user_id=?)').all(uid)
    : db.prepare('SELECT group_id AS gid FROM chat_group_members WHERE user_id=?').all(uid);
  return rows.map(r => `g:${r.gid}`);
}

function initChatSocket(httpServer) {
  io = new Server(httpServer, { path: '/socket.io', cors: { origin: true, credentials: true } });

  // Authenticate every socket with the JWT (handshake auth or ?token=).
  io.use((socket, next) => {
    try {
      const t = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!t) return next(new Error('No token'));
      socket.user = jwt.verify(t, getSecret());
      next();
    } catch (e) { next(new Error('Auth failed')); }
  });

  io.on('connection', (socket) => {
    const uid = socket.user.id, admin = socket.user.role === 'admin';
    try { for (const r of roomsFor(uid, admin)) socket.join(r); } catch (_) {}
    try { socket.join('u:' + uid); } catch (_) {}     // personal room for 1-on-1 call signalling

    // WebRTC call signalling (mam 2026-06-19) — relay offer/answer/ICE/end to
    // the target user's personal room. Stateless pass-through; the media goes
    // peer-to-peer (WebRTC), only these tiny control messages go via the socket.
    for (const ev of ['call:offer', 'call:answer', 'call:ice', 'call:reject', 'call:end', 'call:cancel']) {
      socket.on(ev, (d = {}) => {
        const to = parseInt(d.to, 10);
        if (to) io.to('u:' + to).emit(ev, { ...d, to: undefined, from: uid, fromName: socket.user.name || '' });
      });
    }

    // Re-join when a client opens / is added to a group. Members always may;
    // admin may join GROUP rooms but NOT a private DM they're not part of.
    socket.on('join', (gid) => {
      try {
        const db = getChatDb(); const g = +gid;
        const isMem = !!db.prepare('SELECT 1 FROM chat_group_members WHERE group_id=? AND user_id=?').get(g, uid);
        if (isMem) return socket.join(`g:${g}`);
        if (admin) { const row = db.prepare('SELECT is_dm FROM chat_groups WHERE id=?').get(g); if (row && !row.is_dm) socket.join(`g:${g}`); }
      } catch (_) {}
    });
  });

  return io;
}

// A 'changed' broadcast is idempotent ("something in this group changed —
// reconcile"), so a burst of them (rapid messages / reads in a busy group)
// safely collapses into ONE trailing broadcast per group instead of one-per-
// event. That caps the socket fan-out that would otherwise pile onto the single
// event loop under load (perf pass — S3 server half). Only 'changed' is
// coalesced; 'message' (which carries the actual new row) and every other event
// stay instant, so message delivery is never delayed.
const CHANGED_WINDOW_MS = 300;
const changedTimers = new Map();     // groupId -> pending timeout (a broadcast already queued)

function scheduleChanged(groupId) {
  if (!io || changedTimers.has(groupId)) return;
  const t = setTimeout(() => {
    changedTimers.delete(groupId);
    try { io.to(`g:${groupId}`).emit('changed', { groupId }); } catch (_) {}
  }, CHANGED_WINDOW_MS);
  if (t.unref) t.unref();             // a pending ping must never keep the process alive
  changedTimers.set(groupId, t);
}

// Push an event to everyone currently in a group's room. 'changed' is coalesced
// per group (see above); all other events fire immediately.
function emitChat(groupId, event, payload) {
  if (!io) return;
  if (event === 'changed') return scheduleChanged(groupId);
  try { io.to(`g:${groupId}`).emit(event, payload); } catch (_) {}
}

module.exports = { initChatSocket, emitChat, getIO: () => io };
