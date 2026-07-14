// "WhatsApp" — internal group chat, WhatsApp-styled (mam 2026-06-18). Create
// named groups, add the people you want, chat (text + photo/file). Members-
// gated, read receipts (✓✓ + who-read), unread badges, day separators.
import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, memo } from 'react';
import { io } from 'socket.io-client';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { fmtTime, fmtDate, fmtDateTime } from '../utils/datetime';
import { FiSearch, FiSend, FiPaperclip, FiTrash2, FiFile, FiUsers, FiX, FiPlus, FiMic, FiUserPlus, FiInfo, FiPhone, FiVideo, FiArrowLeft, FiChevronDown, FiCornerUpLeft, FiImage } from 'react-icons/fi';
import { BiMessageRoundedCheck } from 'react-icons/bi';
import { useCall } from '../context/CallContext';
import { compressImage } from '../lib/imageCompress';
import { getToken } from '../lib/tokenStore';

const DAY_OPTS = { day: '2-digit', month: 'short', year: 'numeric' };
const HEADER = '#1e3a8a';                          // header royal blue
const isImg = (u) => /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif)$/i.test(String(u || ''));
const isAudio = (u) => /\.(webm|ogg|mp3|m4a|wav|aac|opus)$/i.test(String(u || ''));
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const preview = (m) => (m ? (m.body || (m.attachment_name ? `📎 ${m.attachment_name}` : '')) : '');
const initials = (s) => String(s || '?').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 2).toUpperCase() || '#';

// Stable, module-level avatar (photo or initials). MUST live outside the page
// component — an inline component is a new type each render, which remounts &
// reloads every photo on every keystroke and freezes the chat (mam 2026-06-19
// "add group is hang").
function Avatar({ url, name, size = 36, className = '' }) {
  const st = { width: size, height: size };
  return url
    ? <img src={url} alt={name || ''} className={`rounded-full object-cover flex-shrink-0 ${className}`} style={st} />
    : <span className={`rounded-full bg-blue-100 text-blue-700 font-bold flex items-center justify-center flex-shrink-0 ${className}`} style={{ ...st, fontSize: Math.round(size * 0.34) }}>{initials(name)}</span>;
}

// A chat photo that degrades gracefully. If the browser can't decode the file
// (a broken/missing upload, or an iPhone HEIC/HEIF that non-Safari browsers
// can't render inline) the <img> would otherwise show a blank/black box —
// exactly the "images blank / chats black" mam reported (2026-07-04). On error
// we swap to a clear tap-to-open link instead. Module-level so it keeps its
// own error state and never remounts mid-scroll.
function ChatImage({ url, name }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-blue-700 underline mb-1 break-all">
        <FiImage size={13} /> {name || 'Photo'} — tap to open
      </a>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img src={url} alt={name || ''} loading="lazy" decoding="async" onError={() => setFailed(true)}
        className="rounded mb-1 max-h-52 max-w-full object-cover bg-gray-100" />
    </a>
  );
}

// Quoted-reply preview text — module-level (pure) so it's stable for both the
// message list and the composer's reply bar.
const quotePreview = (m) => m ? (m.body || (m.attachment_name ? `📎 ${m.attachment_name}` : (isImg(m.attachment_url) ? '📷 Photo' : '📎 Attachment'))) : 'Original message';

// Memoised message list — the heavy part of the thread. Its own React.memo
// component with stable props, so composer keystrokes, context refreshes, and
// Layout re-renders DON'T redraw the whole conversation (perf pass). The @mention
// regex and the "others" (read-receipt) set are computed ONCE here, not per row.
const MessageList = memo(function MessageList({ msgs, userId, members, reads, isDm, userAvatars, msgById, isAdmin, onReply, onInfo, onDelete }) {
  // Current-date labels for the Today/Yesterday separators — an intentional read
  // of "now" at render time (the one impure call, isolated).
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const todayLbl = fmtDate(new Date(now), DAY_OPTS);
  const yestLbl = fmtDate(new Date(now - 864e5), DAY_OPTS);
  const dayLabel = (ts) => { const l = fmtDate(ts, DAY_OPTS); return l === todayLbl ? 'Today' : l === yestLbl ? 'Yesterday' : l; };
  const others = useMemo(() => members.filter(m => m.user_id !== userId), [members, userId]);
  // Memoise the (expensive) mention-match PATTERN once per member list; build a
  // fresh RegExp per message so there's no shared mutable lastIndex state.
  const mentionPattern = useMemo(() => {
    const names = members.map(m => m.name).filter(Boolean).sort((a, b) => b.length - a.length);
    if (!names.length) return null;
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return `@(${names.map(esc).join('|')})`;
  }, [members]);
  const renderBody = (body) => {
    if (!body || !mentionPattern) return body;
    const re = new RegExp(mentionPattern, 'g');
    const out = []; let last = 0; let mm;
    while ((mm = re.exec(body))) {
      if (mm.index > last) out.push(body.slice(last, mm.index));
      out.push(<span key={mm.index} className="text-blue-400 font-semibold">@{mm[1]}</span>);
      last = mm.index + mm[0].length;
    }
    if (last < body.length) out.push(body.slice(last));
    return out;
  };
  // Group consecutive messages by calendar day so each day's label can be a
  // sticky header that CASCADES like WhatsApp: it floats at the top of the thread
  // while you read that day, then the next day's label pushes it up. Each day is
  // its own containing block — that's what makes the sticky hand-off clean (a flat
  // list of sticky siblings would just pile up at the top instead).
  const dayGroups = useMemo(() => {
    const groups = []; let cur = null;
    for (const m of msgs) {
      const day = fmtDate(m.created_at, DAY_OPTS);
      if (!cur || cur.day !== day) { cur = { day, ts: m.created_at, items: [] }; groups.push(cur); }
      cur.items.push(m);
    }
    return groups;
  }, [msgs]);
  return (
    <>
      {dayGroups.map(group => (
        <div key={group.day} className="space-y-1.5">
          {/* Sticky, cascading day label. pointer-events-none so it never blocks a
              message tap as it floats over the conversation. */}
          <div className="sticky top-1.5 z-[5] flex justify-center pointer-events-none">
            <span className="text-[10px] font-medium bg-white/90 text-gray-500 px-2.5 py-0.5 rounded-full shadow-sm">{dayLabel(group.ts)}</span>
          </div>
          {group.items.map(m => {
            const own = m.sender_id === userId;
            // Read-receipt state (the ✓✓ + "Read by…" tooltip) renders ONLY on your own
            // messages, so compute it only then — skips an O(members) scan on every other row.
            const readers = own ? others.filter(o => (reads[o.user_id] || 0) >= m.id) : null;
            const allRead = own && others.length > 0 && readers.length === others.length;
            return (
              <div key={m.id} id={`msg-${m.id}`} className={`flex items-end gap-1.5 rounded transition-shadow ${own ? 'justify-end' : 'justify-start'}`}>
                {!own && !isDm && <Avatar url={userAvatars[m.sender_id]} name={m.sender_name} size={26} />}
                <div className={`group max-w-[78%] rounded-lg px-2.5 py-1.5 shadow-sm text-sm ${own ? 'bg-[#e6ecf7]' : 'bg-white'}`}>
                  {!own && <div className="text-[11px] font-semibold text-blue-700 mb-0.5">{m.sender_name}</div>}
                  {m.reply_to_id && (() => {
                    const q = msgById[m.reply_to_id];
                    return (
                      <button type="button" onClick={() => { const el = document.getElementById(`msg-${m.reply_to_id}`); if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('ring-2', 'ring-blue-400'); setTimeout(() => el.classList.remove('ring-2', 'ring-blue-400'), 1200); } }}
                        className="block w-full text-left mb-1 rounded bg-black/[0.06] border-l-4 border-blue-500 px-2 py-1">
                        <div className="text-[11px] font-semibold text-blue-700 truncate">{q ? (q.sender_id === userId ? 'You' : q.sender_name) : 'Message'}</div>
                        <div className="text-[11px] text-gray-600 truncate">{q ? quotePreview(q) : 'Original message unavailable'}</div>
                      </button>
                    );
                  })()}
                  {m.attachment_url && (
                    isImg(m.attachment_url)
                      ? <ChatImage url={m.attachment_url} name={m.attachment_name} />
                      : isAudio(m.attachment_url)
                        ? <audio controls src={m.attachment_url} className="mb-1 h-9 max-w-[230px]" />
                        : <a href={m.attachment_url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-blue-700 underline mb-1 break-all"><FiFile size={13} /> {m.attachment_name || 'attachment'}</a>)}
                  {m.body && <div className="whitespace-pre-wrap break-words text-gray-800">{renderBody(m.body)}</div>}
                  <div className="flex items-center justify-end gap-1.5 mt-0.5">
                    <button onClick={() => onReply(m)} className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 text-gray-400 hover:text-blue-600" title="Reply"><FiCornerUpLeft size={11} /></button>
                    <button onClick={() => onInfo(m)} className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 text-gray-400 hover:text-blue-600" title="Message info"><FiInfo size={11} /></button>
                    {(own || isAdmin) && <button onClick={() => onDelete(m)} className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 text-gray-400 hover:text-red-600"><FiTrash2 size={11} /></button>}
                    <span className="text-[10px] text-gray-400" title={fmtDateTime(m.created_at)}>{fmtTime(m.created_at)}</span>
                    {own && <span title={others.length === 0 ? 'Sent' : readers.length ? `Read by: ${readers.map(r => r.name).join(', ')}` : 'Delivered · not read yet'} className={`text-[11px] leading-none tracking-tighter ${allRead ? 'text-sky-500' : 'text-gray-400'}`}>{others.length === 0 ? '✓' : '✓✓'}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
});

// Memoised group list (left pane). Extracted so the composer's per-keystroke
// setText — which re-renders the page — no longer redraws every group row.
// <MessageList> was already shielded this way; this closes the same gap for the
// list. Re-renders only when groups / search / selection / avatars change.
// Search is now server-driven (perf pass — admin-slowness fix): `groups` is
// already the filtered/paginated page from the server, not the full list, so
// there's no client-side .filter() left here — just render + scroll-to-load-more.
const GroupList = memo(function GroupList({ groups, q, selId, userAvatars, canCreate, hasMore, loadingMore, onLoadMore, onSelect }) {
  const onScroll = (e) => {
    const el = e.currentTarget;
    if (hasMore && !loadingMore && el.scrollHeight - el.scrollTop - el.clientHeight < 120) onLoadMore();
  };
  return (
    <div className="overflow-y-auto flex-1" onScroll={onScroll}>
      {groups.length === 0 && <div className="text-center text-gray-400 text-sm py-8">{q ? 'No groups match your search.' : <>No groups yet.{canCreate ? ' Tap + to create one.' : ''}</>}</div>}
      {groups.map(g => (
        <button key={g.id} onClick={() => onSelect({ id: g.id, name: g.name })}
          className={`w-full text-left px-3 py-2.5 border-b flex items-start gap-2 hover:bg-gray-50 ${selId === g.id ? 'bg-blue-50' : ''}`}>
          <Avatar url={g.is_dm ? userAvatars[g.dm_uid] : null} name={g.name} size={36} />
          <div className="min-w-0 flex-1">
            <div className="flex justify-between items-baseline gap-2">
              <span className="font-semibold text-sm text-gray-800 truncate">{g.name}</span>
              {g.last && <span className="text-[10px] text-gray-400 flex-shrink-0">{fmtTime(g.last.created_at)}</span>}
            </div>
            <div className="flex items-center gap-1.5">
              <div className="text-xs text-gray-500 truncate flex-1">{g.last ? `${g.last.sender_name ? g.last.sender_name.split(' ')[0] + ': ' : ''}${preview(g.last)}` : <span className="italic text-gray-300">{g.members} member{g.members === 1 ? '' : 's'}</span>}</div>
              {g.unread > 0 && <span className="text-[10px] font-bold text-white bg-[#2563eb] rounded-full px-1.5 min-w-[18px] text-center flex-shrink-0">{g.unread}</span>}
            </div>
          </div>
        </button>
      ))}
      {loadingMore && (
        <div className="flex items-center justify-center gap-1.5 py-2 text-[11px] text-gray-400 select-none">
          <span className="w-3.5 h-3.5 rounded-full border-2 border-gray-300 border-t-blue-600 animate-spin" /> Loading more…
        </div>
      )}
    </div>
  );
});

// How many messages a thread loads at a time (initial open + each scroll-up
// page). Kept modest so opening a long project chat renders fast; older
// history streams in on scroll-up (perf pass — S2-B).
const PAGE = 30;
const MAX_LIVE = 100;   // live in-memory window when pinned to the bottom (~3 pages, aligned with the server's 100-row page); older history re-loads on scroll-up
const GROUP_PAGE = 30;  // group list page size — an admin overseeing many groups loads/renders a page at a time instead of every group at once (perf pass — admin-slowness fix)
const GROUP_MAX = 100;  // ceiling for a RESET refetch (mirrors the server's GROUP_MAX) — a scrolled-deep admin's reconcile reloads up to this many rows without truncating, past which the cursor re-extends on scroll

export default function SiteChat() {
  const { canCreate, canDelete, isAdmin, user } = useAuth();
  const { startCall } = useCall();
  const [groups, setGroups] = useState([]);
  const [q, setQ] = useState('');
  const [mineOnly, setMineOnly] = useState(false);  // admin-only "Only chats I'm in" filter
  const [sel, setSel] = useState(null);            // selected group {id, name}
  const [msgs, setMsgs] = useState([]);
  const [members, setMembers] = useState([]);
  const [reads, setReads] = useState({});
  const [readsAt, setReadsAt] = useState({});      // user_id -> last-read timestamp (for Message Info)
  const [hasMore, setHasMore] = useState(false);   // older messages exist above the loaded window (S2-B)
  const [quotedParents, setQuotedParents] = useState([]); // reply-targets older than the loaded window
  const [loadingOlder, setLoadingOlder] = useState(false); // drives the in-thread "loading earlier…" spinner
  const [threadLoading, setThreadLoading] = useState(false); // drives the initial message-load skeleton on thread open (mobile feels frozen on slow networks otherwise)
  const [showJumpDown, setShowJumpDown] = useState(false);  // floating "jump to latest" button when scrolled up
  const [infoMsg, setInfoMsg] = useState(null);    // message whose "info" panel is open
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState(null);   // WhatsApp-style quoted reply
  const [busy, setBusy] = useState(false);
  const [allUsers, setAllUsers] = useState([]);
  const [memOpen, setMemOpen] = useState(false);
  const [memSearch, setMemSearch] = useState('');
  const [renameVal, setRenameVal] = useState('');
  const [dmOpen, setDmOpen] = useState(false);     // "new direct message" picker
  const [dmSearch, setDmSearch] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSel, setNewSel] = useState([]);
  const [newSearch, setNewSearch] = useState('');
  const [recording, setRecording] = useState(false);
  const [recTime, setRecTime] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [mention, setMention] = useState(null);    // @-tag autocomplete: { query, start } or null
  const [groupsHasMore, setGroupsHasMore] = useState(false); // more groups exist beyond the loaded page (perf pass)
  const [loadingGroups, setLoadingGroups] = useState(false); // drives the group-list "loading more…" spinner
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const avatarRef = useRef(null);
  const sendingRef = useRef(false);   // synchronous guard against double-send
  const justSentRef = useRef({ body: '', at: 0 });  // ignore the trailing mobile-keyboard re-inject of a just-sent message
  const endRef = useRef(null);
  const scrollRef = useRef(null);       // the messages scroll container
  const atBottomRef = useRef(true);     // is the user currently pinned to the bottom?
  const lastGroupRef = useRef(null);    // detect a thread switch (always jump to bottom then)
  const socketRef = useRef(null);
  const mediaRef = useRef(null);
  const chunksRef = useRef([]);
  const recTimerRef = useRef(null);
  const changedTimerRef = useRef(null);        // trailing-debounce timer for 'changed' bursts
  const changedGroupsRef = useRef(new Set());  // group ids that fired 'changed' within the window
  const loadingOlderRef = useRef(false);       // guard: one scroll-up page load at a time
  const msgsLenRef = useRef(0);                 // loaded message count (sizes the reconcile window)
  const pendingRestoreRef = useRef(null);       // {prevH,prevTop}: anchor scroll after prepending older
  const groupsLoadingRef = useRef(false);       // guard: one group-list page load at a time
  const groupsLenRef = useRef(0);               // loaded group count (sizes the reset window, same trick as msgsLenRef)
  const groupsCursorRef = useRef(null);         // server's nextCursor for "load the next page"
  const qRef = useRef('');                      // current search text, read inside loadGroups without a stale closure
  const searchTimerRef = useRef(null);          // debounce timer for server-side group search
  const searchMountedRef = useRef(false);       // skip the debounce effect's own fetch on first mount
  const mineOnlyRef = useRef(false);            // current "only my chats" toggle, read inside loadGroups without a stale closure
  const mineMountedRef = useRef(false);         // skip the toggle effect's own fetch on first mount

  // Keyset-paginated group list (perf pass — admin-slowness fix). Default: fetch
  // a RESET page sized to Math.max(GROUP_PAGE, currently-rendered count) so an
  // admin scrolled several pages deep isn't truncated back to page 1 on every
  // poll/socket refresh — same sizing trick loadThread uses for `reconcile`.
  // { more: true }: fetch the next page (via groupsCursorRef) and APPEND, deduping
  // by id. Search (`q` state) rides along on every request via qRef so a reset OR
  // a "more" page both stay scoped to the active search term.
  const loadGroups = useCallback((opts = {}) => {
    if (groupsLoadingRef.current) return Promise.resolve();
    const more = !!opts.more;
    const requestQ = qRef.current;
    const requestMine = mineOnlyRef.current;
    const params = { limit: more ? GROUP_PAGE : Math.min(GROUP_MAX, Math.max(GROUP_PAGE, groupsLenRef.current || GROUP_PAGE)) };
    if (requestQ) params.q = requestQ;
    if (requestMine) params.mine = 1;
    if (more && groupsCursorRef.current) {
      params.phase = groupsCursorRef.current.phase;
      if (groupsCursorRef.current.after_last_id != null) params.after_last_id = groupsCursorRef.current.after_last_id;
      if (groupsCursorRef.current.after_name != null) params.after_name = groupsCursorRef.current.after_name;
      if (groupsCursorRef.current.after_id != null) params.after_id = groupsCursorRef.current.after_id;
    }
    groupsLoadingRef.current = true; setLoadingGroups(true);
    return api.get('/site-chat/groups', { params }).then(r => {
      if (requestQ !== qRef.current || requestMine !== mineOnlyRef.current) return;   // a newer search/toggle superseded this response — drop it
      const { groups: incoming = [], hasMore: incomingHasMore = false, nextCursor = null } = r.data || {};
      if (more) setGroups(gs => { const seen = new Set(gs.map(g => g.id)); return [...gs, ...incoming.filter(g => !seen.has(g.id))]; });
      else setGroups(incoming);
      setGroupsHasMore(incomingHasMore);
      groupsCursorRef.current = nextCursor;
    }).catch(() => {}).finally(() => { groupsLoadingRef.current = false; setLoadingGroups(false); });
  }, []);
  const reloadUsers = useCallback(() => api.get('/auth/users').then(r => setAllUsers((r.data || []).filter(u => u.active !== 0))).catch(() => {}), []);
  // Cursor pagination (perf pass — S2-B). Default: fetch the most-recent PAGE and
  // REPLACE (thread open / reconnect). { before }: fetch the PAGE older than that
  // id and PREPEND, anchoring scroll so the view doesn't jump. { reconcile }: a
  // read-receipt / delete / membership refresh that re-fetches the CURRENTLY
  // loaded window (not just PAGE) so scrolled-up history isn't yanked away. The
  // server stays backward-compatible — omitting limit still returns everything.
  const loadThread = useCallback((id, opts = {}) => {
    if (!id) return Promise.resolve();
    const older = opts.before != null;
    const limit = older ? PAGE : (opts.reconcile ? Math.max(PAGE, msgsLenRef.current || PAGE) : PAGE);
    const params = older ? { limit, before: opts.before } : { limit };
    if (older) {                                     // capture the scroll anchor BEFORE the DOM grows upward
      const el = scrollRef.current;
      pendingRestoreRef.current = el ? { prevH: el.scrollHeight, prevTop: el.scrollTop } : null;
    }
    return api.get(`/site-chat/${id}`, { params }).then(r => {
      const incoming = r.data.messages || [];
      const qp = r.data.quotedParents || [];
      if (older) {
        setMsgs(ms => { const seen = new Set(ms.map(m => m.id)); return [...incoming.filter(m => !seen.has(m.id)), ...ms]; });
        setQuotedParents(prev => { const seen = new Set(prev.map(m => m.id)); return [...prev, ...qp.filter(m => !seen.has(m.id))]; });
        setHasMore(!!r.data.hasMore);
      } else {
        setMsgs(incoming); setMembers(r.data.members || []); setReads(r.data.reads || {}); setReadsAt(r.data.readsAt || {});
        setQuotedParents(qp); setHasMore(!!r.data.hasMore);
        if (r.data.group) setSel(s => (s && s.id === id ? { ...s, name: r.data.group.name, is_dm: r.data.group.is_dm } : s));
        // Opening/polling a thread marks it read — clear its unread badge locally
        // instead of re-fetching the whole groups list every 6s (perf pass). The
        // list's own 12s timer + socket 'changed' still refresh names/last-message.
        setGroups(gs => gs.map(g => (g.id === id ? { ...g, unread: 0 } : g)));
      }
    }).catch(() => {});
  }, []);

  // Cap the live in-memory window so a long session can't grow msgs (and the DOM)
  // without bound. Both append paths (socket 'message' + own send) go through this:
  // dedupe by id, and — ONLY when pinned to the bottom — keep the last MAX_LIVE rows.
  // Older rows stay on the server and re-load via the scroll-up loader; we never trim
  // while the user has scrolled up to read history (guarded by atBottomRef).
  const appendMsg = useCallback((row) => {
    setMsgs(ms => {
      if (ms.some(x => x.id === row.id)) return ms;                 // dedupe by id
      const next = [...ms, row];
      return atBottomRef.current && next.length > MAX_LIVE ? next.slice(next.length - MAX_LIVE) : next;
    });
    // If that push exceeded the cap at the bottom, older rows just left memory — flag
    // that earlier history exists again so the scroll-up loader can re-fetch it.
    if (atBottomRef.current && msgsLenRef.current >= MAX_LIVE) setHasMore(true);
  }, []);

  useEffect(() => { loadGroups(); reloadUsers(); }, [loadGroups, reloadUsers]);
  // Safety-net: refresh the chat list every 12 s even with NO thread open, so
  // new messages / unread badges still surface when the socket can't connect
  // (in-app browsers, flaky nginx WebSocket). The open thread has its own 6 s
  // poll already (mam 2026-07-04).
  useEffect(() => { const t = setInterval(() => { if (!socketRef.current?.connected) loadGroups(); }, 12000); return () => clearInterval(t); }, [loadGroups]);
  // Real-time: one Socket.IO connection; the server pushes a 'changed' event
  // to each group's room on any message/read/member change. Polling stays as
  // a fallback if the socket can't connect.
  useEffect(() => {
    // auth as a FUNCTION so every (re)connect uses the CURRENT token via
    // getToken() — which falls back to the in-memory copy when localStorage is
    // blocked (in-app browsers opened from WhatsApp, private mode). Reading
    // localStorage directly returned null there, so the socket never
    // authenticated and real-time chat was dead for those users — their
    // messages only appeared after a manual refresh (mam 2026-07-04).
    const socket = io({ path: '/socket.io', auth: (cb) => cb({ token: getToken() }), transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    // On (re)connect, re-join the open group's room and catch up on anything
    // missed while disconnected — fixes "always need to refresh" after a drop.
    socket.on('connect', () => { loadGroups(); setSel(s => { if (s) { socket.emit('join', s.id); loadThread(s.id); } return s; }); });
    // New message pushed from the server: append it directly (dedupe by id) so a
    // send/receive shows INSTANTLY without re-fetching the whole thread. The
    // auto-scroll effect keeps the view pinned to the bottom only if the reader
    // is already there (perf pass — S3-client).
    socket.on('message', (row) => { if (row && row.group_id != null) setSel(s => { if (s && s.id === row.group_id) appendMsg(row); return s; }); });
    // 'changed' (read receipts, deletes, membership, last-message) still needs a
    // reconcile fetch, but a BURST of them now collapses into a single trailing
    // reload instead of one-reload-per-event — that reload storm was what made
    // busy groups sluggish (perf pass — S3-client). New messages no longer wait
    // on this path; they arrive via 'message' above.
    socket.on('changed', ({ groupId }) => {
      if (groupId != null) changedGroupsRef.current.add(groupId);
      clearTimeout(changedTimerRef.current);
      changedTimerRef.current = setTimeout(() => {
        const gids = changedGroupsRef.current; changedGroupsRef.current = new Set();
        loadGroups();
        setSel(s => { if (s && gids.has(s.id)) loadThread(s.id, { reconcile: true }); return s; });
      }, 300);
    });
    socket.on('group_deleted', ({ groupId }) => { loadGroups(); setSel(s => (s && s.id === groupId ? null : s)); });
    return () => { socket.disconnect(); socketRef.current = null; clearTimeout(changedTimerRef.current); };
  }, [loadThread, loadGroups, appendMsg]);
  // Reset SYNCHRONOUSLY before the browser paints (useLayoutEffect), so switching
  // threads never flashes the previous thread's messages for a frame before the
  // loader appears. Clearing here — instead of in the async effect below, which runs
  // after paint — guarantees the loader covers from the very first painted frame.
  useLayoutEffect(() => {
    if (!sel) return;
    setText(''); setMention(null); setReplyTo(null);   // drop the composer draft + reply when switching threads
    justSentRef.current = { body: '', at: 0 };         // disarm the send-guard for the new thread
    setMsgs([]); setThreadLoading(true);               // clear the previous thread + show the loader immediately
  }, [sel?.id]);
  useEffect(() => {
    if (!sel) return;
    socketRef.current?.emit('join', sel.id);
    loadThread(sel.id).finally(() => setThreadLoading(false));
    const t = setInterval(() => { if (!socketRef.current?.connected) loadThread(sel.id, { reconcile: true }); }, 6000);    // fallback poll — only when the socket is down
    const onFocus = () => loadThread(sel.id, { reconcile: true });
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [sel?.id, loadThread]);
  // Auto-scroll, WhatsApp-style: jump to the bottom only when opening a thread
  // or when a new message arrives AND the user is already near the bottom. If
  // they've scrolled up to read history, the 6 s poll must NOT yank them back
  // down (mam 2026-06-22: "if i read old message it automatically comes to latest").
  useEffect(() => {
    if (sel?.id !== lastGroupRef.current) {     // thread just opened/switched
      lastGroupRef.current = sel?.id;
      atBottomRef.current = true;
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'end' }));
      return;
    }
    if (atBottomRef.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [msgs, sel?.id]);
  // Keep the loaded-count ref current so a reconcile refresh re-fetches the whole
  // scrolled-in window, not just the newest PAGE (S2-B).
  useEffect(() => { msgsLenRef.current = msgs.length; }, [msgs.length]);
  // Same trick for the group list's reset sizing (perf pass — admin-slowness fix).
  useEffect(() => { groupsLenRef.current = groups.length; }, [groups.length]);
  // Server-side group search: debounce keystrokes, then reset to a fresh page
  // scoped to the new term. Skip the debounce's own fetch on first mount — the
  // mount effect below already loads groups once with q='' via qRef's initial value.
  useEffect(() => {
    qRef.current = q;
    if (!searchMountedRef.current) { searchMountedRef.current = true; return; }
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => { groupsCursorRef.current = null; loadGroups(); }, 300);
    return () => clearTimeout(searchTimerRef.current);
  }, [q, loadGroups]);
  // "Only chats I'm in" toggle (admin): reset to a fresh page in the new scope.
  // Skips its own mount run so it never double-fetches with the mount loader.
  useEffect(() => {
    mineOnlyRef.current = mineOnly;
    if (!mineMountedRef.current) { mineMountedRef.current = true; return; }
    groupsCursorRef.current = null; loadGroups();
  }, [mineOnly, loadGroups]);
  // After a scroll-up page prepends older messages, anchor the scroll so the
  // messages the user was reading stay in place (runs before paint = no jump).
  useLayoutEffect(() => {
    const p = pendingRestoreRef.current; if (!p) return;
    pendingRestoreRef.current = null;
    const el = scrollRef.current; if (el) el.scrollTop = p.prevTop + (el.scrollHeight - p.prevH);
  }, [msgs]);
  const onMsgScroll = () => {
    const el = scrollRef.current; if (!el) return;
    const nowAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    const returnedToBottom = nowAtBottom && !atBottomRef.current;
    atBottomRef.current = nowAtBottom;
    setShowJumpDown(!nowAtBottom);              // React bails if unchanged → no per-pixel re-render
    // Landed back at the bottom after scrolling up through history → release the loaded-up
    // older messages, collapsing to the live window. Safe: the trimmed rows are above the
    // viewport (the view stays put) and re-load on scroll-up.
    if (returnedToBottom && msgs.length > MAX_LIVE) { setMsgs(ms => ms.slice(ms.length - MAX_LIVE)); setHasMore(true); }
    // Near the top with older history available → load the previous page (S2-B).
    if (el.scrollTop < 80 && hasMore && !loadingOlderRef.current && sel && msgs.length) {
      loadingOlderRef.current = true; setLoadingOlder(true);
      loadThread(sel.id, { before: msgs[0].id }).finally(() => { loadingOlderRef.current = false; setLoadingOlder(false); });
    }
  };
  // WhatsApp-style "jump to latest": smooth-scroll the thread to the newest message.
  const jumpToBottom = () => {
    atBottomRef.current = true;
    setShowJumpDown(false);
    // Tapping "jump to latest" also releases any scrolled-up history from memory.
    if (msgs.length > MAX_LIVE) { setMsgs(ms => ms.slice(ms.length - MAX_LIVE)); setHasMore(true); }
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  };
  useEffect(() => { if (memOpen && sel) setRenameVal(sel.name || ''); }, [memOpen, sel?.id]);

  // Resolve a quoted reply's original message from the loaded thread.
  // Include quotedParents (reply-targets older than the loaded page) so a reply's
  // preview still resolves; msgs win over parents on id collisions (S2-B).
  const msgById = useMemo(() => { const o = {}; for (const x of quotedParents) o[x.id] = x; for (const x of msgs) o[x.id] = x; return o; }, [msgs, quotedParents]);
  // (day-label, quotePreview, and renderBody now live in the memoised MessageList
  // / module scope so composer keystrokes don't recompute them per message.)

  const send = async (extra = {}) => {
    if (!sel || sendingRef.current) return;          // ref guard = no duplicate sends
    const body = text;                                // capture before we clear the box
    const payload = { body, ...(replyTo ? { reply_to_id: replyTo.id } : {}), ...extra };
    if (!payload.body?.trim() && !payload.attachment_url) return;
    sendingRef.current = true; setBusy(true);
    atBottomRef.current = true;                       // sending my own message always jumps to bottom
    // Optimistic clear — empty the composer synchronously the instant we send
    // (WhatsApp-style) instead of after the round-trip. Clearing after the await
    // let a trailing mobile predictive-keyboard input event land after setText('')
    // and repopulate the just-sent text, so it stayed in the box (mam 2026-07-10).
    setText(''); setMention(null); setReplyTo(null);
    if (taRef.current) taRef.current.value = '';      // belt-and-suspenders vs the IME buffer
    justSentRef.current = { body, at: Date.now() };   // arm the guard for the trailing IME re-inject
    try {
      const r = await api.post(`/site-chat/${sel.id}`, payload);
      // Append the server-returned row instead of re-fetching the whole thread
      // (perf pass). Socket 'changed' / fallback poll reconciles if needed.
      if (r.data && r.data.id) appendMsg(r.data);
    }
    catch (err) {
      justSentRef.current = { body: '', at: 0 };       // disarm so the guard can't blank the restored draft
      setText(body);                                  // failed send → don't lose the draft
      toast.error(err.response?.data?.error || 'Failed to send');
    }
    finally { sendingRef.current = false; setBusy(false); }
  };
  const attach = async (file) => {
    if (!file || !sel) return;
    setBusy(true);
    try {
      // Compress photos WhatsApp-style before upload so big phone images don't
      // hang the chat (mam 2026-06-25). Keep the original display name.
      const toSend = await compressImage(file);
      const fd = new FormData(); fd.append('file', toSend);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      await send({ attachment_url: r.data.url, attachment_name: r.data.filename || file.name });
    } catch (err) { toast.error(err.response?.data?.error || 'Upload failed'); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  // Voice messages — record with MediaRecorder, then upload + send like any
  // attachment. Tap mic to start; tick to send, bin to cancel.
  const startRec = async () => {
    if (!navigator.mediaDevices?.getUserMedia) return toast.error('Mic not supported here');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = e => { if (e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
        if (mr._send && blob.size > 0) {
          const ext = (mr.mimeType || '').includes('ogg') ? 'ogg' : 'webm';
          attach(new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type }));
        }
      };
      mediaRef.current = mr; mr.start();
      setRecording(true); setRecTime(0);
      recTimerRef.current = setInterval(() => setRecTime(t => t + 1), 1000);
    } catch (e) { toast.error('Microphone blocked — allow access'); }
  };
  const stopRec = (sendIt) => {
    const mr = mediaRef.current; if (!mr) return;
    mr._send = !!sendIt; clearInterval(recTimerRef.current); setRecording(false);
    try { mr.stop(); } catch (_) {}
  };
  const onDrop = (e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer?.files?.[0]; if (f) attach(f); };

  // ── Profile photos (mam 2026-06-19 "like whatsapp use profile photo") ──
  const userAvatars = useMemo(() => { const m = {}; for (const u of allUsers) m[u.id] = u.avatar_url; return m; }, [allUsers]);
  const onAvatarFile = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      // Profile photo is shown tiny — compress hard (square-ish, small).
      const toUpload = await compressImage(file, { maxDim: 512, quality: 0.7 });
      const fd = new FormData(); fd.append('file', toUpload);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      await api.post('/auth/avatar', { avatar_url: r.data.url });
      reloadUsers(); if (sel) loadThread(sel.id);
      toast.success('Profile photo updated');
    } catch (err) { toast.error(err.response?.data?.error || 'Upload failed'); }
    finally { setBusy(false); if (avatarRef.current) avatarRef.current.value = ''; }
  };
  const removeAvatar = async () => {
    try { await api.post('/auth/avatar', { avatar_url: null }); reloadUsers(); toast.success('Photo removed'); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // ── @-mention / tag-by-name (mam 2026-06-19: "at the rate tag by name") ──
  // On each keystroke, look back from the caret for an "@word" token (at the
  // start or after a space) and open a member picker filtered by that word.
  const onTextChange = (e) => {
    const val = e.target.value;
    const js = justSentRef.current;
    // Android predictive keyboards fire a trailing composition-commit right after
    // send that re-injects the just-sent text into the box we cleared. Ignore
    // exactly that: same text, box currently empty, within a short window.
    if (val && text === '' && val === js.body && Date.now() - js.at < 1500) {
      justSentRef.current = { body: '', at: 0 };
      e.target.value = '';                            // undo the re-inject now (state is already '')
      return;                                         // do NOT setText(val)
    }
    setText(val);
    const pos = e.target.selectionStart ?? val.length;
    const m = val.slice(0, pos).match(/(?:^|\s)@([^\s@]*)$/);
    setMention(m ? { query: m[1], start: pos - m[1].length - 1 } : null);
  };
  const mentionList = mention
    ? members.filter(m => m.user_id !== user?.id && m.name && m.name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 6)
    : [];
  const pickMention = (name) => {
    const ta = taRef.current;
    const pos = ta?.selectionStart ?? text.length;
    const before = text.slice(0, mention?.start ?? pos);
    const after = text.slice(pos);
    const inserted = `@${name} `;
    setText(before + inserted + after); setMention(null);
    requestAnimationFrame(() => { if (ta) { const c = (before + inserted).length; ta.focus(); ta.setSelectionRange(c, c); } });
  };
  // (renderBody / @mention highlighting now lives in the memoised MessageList.)

  const delMsg = useCallback(async (m) => {
    if (!confirm('Delete this message?')) return;
    try { await api.delete(`/site-chat/${sel.id}/messages/${m.id}`); loadThread(sel.id); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  }, [sel?.id, loadThread]);
  const saveRename = async () => {
    const name = renameVal.trim();
    if (!name) return toast.error('Group name is required');
    if (name === sel.name) return;
    try { await api.put(`/site-chat/${sel.id}`, { name }); setSel(s => ({ ...s, name })); loadGroups(); loadThread(sel.id); toast.success('Group renamed'); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed to rename'); }
  };
  const addMember = async (uid) => { try { await api.post(`/site-chat/${sel.id}/members`, { user_ids: [uid] }); loadThread(sel.id); } catch (err) { toast.error(err.response?.data?.error || 'Failed'); } };
  const removeMember = async (uid) => { try { await api.delete(`/site-chat/${sel.id}/members/${uid}`); loadThread(sel.id); } catch (err) { toast.error(err.response?.data?.error || 'Failed'); } };

  // Open (or create) a 1-on-1 direct message with a person — anyone can.
  const startDm = async (uid, name) => {
    try {
      const r = await api.post('/site-chat/dm', { user_id: uid });
      setDmOpen(false); setDmSearch(''); loadGroups();
      setSel({ id: r.data.id, name: r.data.name || name, is_dm: 1 });
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to start chat'); }
  };

  const createGroup = async () => {
    if (!newName.trim()) return toast.error('Give the group a name');
    if (busy) return;                                   // guard against double-submit
    setBusy(true);
    try {
      const r = await api.post('/site-chat/groups', { name: newName.trim(), member_ids: newSel });
      setNewOpen(false); setNewName(''); setNewSel([]); setNewSearch('');
      loadGroups(); setSel({ id: r.data.id, name: r.data.name });
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to create group'); }
    finally { setBusy(false); }
  };
  const delGroup = async () => {
    if (!sel || !confirm(`Delete the group "${sel.name}" and all its messages?`)) return;
    try { await api.delete(`/site-chat/${sel.id}`); setSel(null); setMemOpen(false); loadGroups(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Hidden file input for the profile photo — kept at the top level so BOTH the
  // desktop header button and the mobile (chat-list) avatar button can trigger
  // it. `hidden` keeps the element mounted, so the ref stays valid on mobile.
  const avatarInput = <input ref={avatarRef} type="file" accept="image/*" className="hidden" onChange={e => onAvatarFile(e.target.files?.[0])} />;

  return (
    // Full-height flex column. The chat card flex-fills the remaining space, so
    // no fragile magic-number height. dvh (NOT vh) keeps the composer above the
    // phone browser's bottom toolbar (mam 2026-06-19: "below button not show").
    // Mobile subtracts only the app bar + page padding; desktop also the header.
    <div className="schat-wrapper flex flex-col h-[calc(100dvh-69px)] -m-2 md:m-0 sm:h-[calc(100dvh-61px)] md:h-[calc(100dvh-104px)]">
      {avatarInput}
      {/* Page header — desktop only. On mobile the chat takes the full screen
          (like real WhatsApp); the profile photo moves into the list header. */}
      <div className="hidden md:flex items-start justify-between gap-3 mb-3 flex-shrink-0">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2"><BiMessageRoundedCheck className="text-blue-900" /> Salon Chat</h1>
          <p className="text-sm text-gray-500">Internal group chat · create groups · add your people · text + photos/files</p>
        </div>
        {/* Your profile photo — tap to upload (mam 2026-06-19). */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={() => avatarRef.current?.click()} disabled={busy} className="relative" title="Change your photo">
            <Avatar url={userAvatars[user?.id]} name={user?.name} size={42} />
            <span className="absolute -bottom-0.5 -right-0.5 bg-blue-600 text-white rounded-full w-4 h-4 flex items-center justify-center text-[9px] ring-2 ring-white">✎</span>
          </button>
          {userAvatars[user?.id] && <button onClick={removeAvatar} className="text-[11px] text-gray-400 hover:text-red-600">Remove</button>}
        </div>
      </div>

      <div className="flex flex-1 min-h-0 border overflow-hidden bg-white md:rounded-xl">
        {/* ── Group list ────────────────────────────────── */}
        <div className={`w-full sm:w-80 border-r flex flex-col ${sel ? 'hidden sm:flex' : 'flex'}`}>
          <div className="flex items-center gap-2 px-3 py-1 text-white md:py-2" style={{ background: HEADER }}>
            {/* Profile photo — mobile only (desktop has it in the page header). */}
            <button onClick={() => avatarRef.current?.click()} disabled={busy} className="md:hidden relative flex-shrink-0" title="Change your photo">
              <Avatar url={userAvatars[user?.id]} name={user?.name} size={28} />
              <span className="absolute -bottom-0.5 -right-0.5 bg-blue-600 rounded-full w-3.5 h-3.5 flex items-center justify-center text-[8px] ring-2 ring-[#1e3a8a]">✎</span>
            </button>
            <BiMessageRoundedCheck className="hidden md:block" /> <span className="font-semibold text-sm flex-1">Salon Chat</span>
            <button onClick={() => { setDmSearch(''); setDmOpen(true); }} className="p-1.5 rounded hover:bg-white/15" title="New direct message"><FiUserPlus size={18} /></button>
            {canCreate('site_chat') && <button onClick={() => { setNewName(''); setNewSel([]); setNewSearch(''); setNewOpen(true); }} className="p-1.5 rounded hover:bg-white/15" title="New group"><FiPlus size={18} /></button>}
          </div>
          <div className="p-2 border-b">
            <div className="relative">
              <FiSearch className="absolute left-2.5 top-3.5 text-gray-400" size={14} />
              <input className="input pl-8" placeholder="Search group…" value={q} onChange={e => setQ(e.target.value)} />
            </div>
            {/* Admin-only: narrow the list (which shows ALL groups for admins) to
                just the chats the admin is actually a member of. */}
            {isAdmin() && (
              <label className="flex w-fit ml-auto items-center gap-2 mt-2 px-1 text-xs text-gray-500 cursor-pointer select-none">
                <span>Only chats I'm in</span>
                <button type="button" role="switch" aria-checked={mineOnly} onClick={() => setMineOnly(v => !v)}
                  className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${mineOnly ? 'bg-[#2563eb]' : 'bg-gray-300'}`}>
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${mineOnly ? 'translate-x-4' : ''}`} />
                </button>
              </label>
            )}
          </div>
          <GroupList groups={groups} q={q} selId={sel?.id} userAvatars={userAvatars} canCreate={canCreate('site_chat')}
            hasMore={groupsHasMore} loadingMore={loadingGroups} onLoadMore={() => loadGroups({ more: true })} onSelect={setSel} />
        </div>

        {/* ── Thread ────────────────────────────────────── */}
        {/* min-w-0: a flex child defaults to min-width:auto, so on mobile the
            thread refused to shrink below its content and overflowed the pane,
            clipping the left ~160px of every message. min-w-0 lets it collapse
            to the container width so message text wraps instead (mobile fix). */}
        <div className={`flex-1 flex-col min-w-0 ${sel ? 'flex' : 'hidden sm:flex'}`}>
          {!sel ? (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-400 gap-2" style={{ background: '#f4f5f7' }}>
              <BiMessageRoundedCheck size={44} className="text-blue-900" /><span className="text-sm">Pick a group to start chatting</span>
            </div>
          ) : (
            <>
              <div className="px-3 py-1 flex items-center gap-2 text-white md:py-2" style={{ background: HEADER }}>
                <button onClick={() => setSel(null)} className="sm:hidden -ml-1 p-1 rounded hover:bg-white/15" title="Back" aria-label="Back to chats"><FiArrowLeft size={22} /></button>
                <Avatar url={sel.is_dm ? userAvatars[members.find(m => m.user_id !== user?.id)?.user_id] : null} name={sel.name} size={36} />
                {sel.is_dm ? (
                  <>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-sm truncate">{sel.name}</div>
                      <div className="text-[11px] text-white/80 truncate">Direct message</div>
                    </div>
                    {(() => { const oid = members.find(m => m.user_id !== user?.id)?.user_id; return oid ? (
                      <>
                        <button onClick={() => startCall(oid, sel.name, false)} className="p-1.5 rounded hover:bg-white/15" title="Voice call"><FiPhone size={18} /></button>
                        <button onClick={() => startCall(oid, sel.name, true)} className="p-1.5 rounded hover:bg-white/15" title="Video call"><FiVideo size={18} /></button>
                      </>
                    ) : null; })()}
                  </>
                ) : (
                  <>
                    <button onClick={() => { setMemSearch(''); setMemOpen(true); }} className="min-w-0 text-left flex-1">
                      <div className="font-semibold text-sm truncate">{sel.name}</div>
                      <div className="text-[11px] text-white/80 truncate">{members.length ? members.map(m => m.name).filter(Boolean).slice(0, 5).join(', ') : 'tap to add members'}</div>
                    </button>
                    <button onClick={() => { setMemSearch(''); setMemOpen(true); }} className="p-1.5 rounded hover:bg-white/15" title="Members"><FiUsers size={18} /></button>
                  </>
                )}
              </div>

              <div className="relative flex-1 flex flex-col min-h-0">
                <div ref={scrollRef} onScroll={onMsgScroll} className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5 relative" style={{ background: '#f4f5f7' }}
                  onDragOver={e => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
                  onDragLeave={e => { if (e.currentTarget === e.target) setDragOver(false); }}
                  onDrop={onDrop}>
                  {dragOver && <div className="absolute inset-0 z-10 m-2 rounded-lg border-2 border-dashed border-blue-500 bg-blue-500/10 flex items-center justify-center text-blue-700 font-semibold pointer-events-none">Drop file to send</div>}
                  {!threadLoading && msgs.length === 0 && <div className="text-center text-gray-500 text-xs py-8">No messages yet — say hello 👋</div>}
                  {hasMore && (
                    <div className="flex items-center justify-center gap-1.5 py-1.5 text-[11px] text-gray-400 select-none">
                      {loadingOlder
                        ? <><span className="w-3.5 h-3.5 rounded-full border-2 border-gray-300 border-t-blue-600 animate-spin" /> Loading earlier messages…</>
                        : '↑ earlier messages'}
                    </div>
                  )}
                  {/* Fade the messages in beneath the loader. Keeps space-y-1.5 so the
                      day-group spacing MessageList relies on is preserved. Keyed on
                      threadLoading only (not msgs), so new messages append without re-fading. */}
                  <div className={`space-y-1.5 transition-opacity duration-300 ${threadLoading ? 'opacity-0' : 'opacity-100 delay-150'}`}>
                    <MessageList msgs={msgs} userId={user?.id} members={members} reads={reads} isDm={sel.is_dm} userAvatars={userAvatars} msgById={msgById} isAdmin={isAdmin()} onReply={setReplyTo} onInfo={setInfoMsg} onDelete={delMsg} />
                  </div>

                  <div ref={endRef} />
                </div>
                {/* Centered spinner that cross-fades to the real messages. Sits in the
                    non-scrolling parent (a sibling of the scroll div) so it always covers
                    the VISIBLE chat area regardless of scroll position. Always mounted;
                    only its OPACITY toggles — so when the page arrives it fades out over
                    300ms, revealing the messages beneath it (and hiding the auto-scroll-
                    to-bottom snap). No skeleton, no layout jump. */}
                <div
                  className={`absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 pointer-events-none ${threadLoading && msgs.length === 0 ? 'opacity-100 transition-none' : 'opacity-0 transition-opacity duration-500 delay-200'}`}
                  style={{ background: '#f4f5f7' }}
                  aria-hidden={!(threadLoading && msgs.length === 0)}
                >
                  <span className="w-8 h-8 rounded-full border-[3px] border-gray-300 border-t-blue-600 animate-spin" />
                  <span className="text-xs font-medium text-gray-500">Loading messages…</span>
                </div>
                {/* Floating "jump to latest" — shows only when scrolled up off the bottom (WhatsApp-style). */}
                {showJumpDown && (
                  <button onClick={jumpToBottom} title="Jump to latest" aria-label="Jump to latest message"
                    className="absolute bottom-3 right-3 z-20 w-9 h-9 rounded-full bg-white shadow-lg border border-gray-200 flex items-center justify-center text-gray-500 hover:text-blue-600 hover:border-blue-300 transition">
                    <FiChevronDown size={20} />
                  </button>
                )}
              </div>

              {/* min-w-0 on the textarea + flex-shrink-0 on the buttons so the
                  send / mic button never gets clipped off the right edge on a
                  narrow phone (mam 2026-06-19). */}
              {/* Reply preview bar — WhatsApp-style quote above the composer */}
              {replyTo && (
                <div className="border-t bg-gray-100 px-3 py-1.5 flex items-center gap-2">
                  <div className="flex-1 min-w-0 border-l-4 border-blue-500 pl-2">
                    <div className="text-[11px] font-semibold text-blue-700 truncate">Replying to {replyTo.sender_id === user?.id ? 'yourself' : replyTo.sender_name}</div>
                    <div className="text-[11px] text-gray-600 truncate">{quotePreview(replyTo)}</div>
                  </div>
                  <button onClick={() => setReplyTo(null)} className="flex-shrink-0 p-1 text-gray-400 hover:text-gray-700" title="Cancel reply"><FiX size={16} /></button>
                </div>
              )}
              <div className="border-t p-2 flex items-end gap-2 bg-gray-50 relative">
                {/* @-mention picker — floats above the composer */}
                {mention && mentionList.length > 0 && (
                  <div className="absolute bottom-full left-2 right-2 mb-1 bg-white border rounded-lg shadow-lg max-h-52 overflow-y-auto z-20">
                    <div className="px-3 py-1 text-[10px] text-gray-400 uppercase font-semibold border-b">Tag someone</div>
                    {mentionList.map(mu => (
                      <button key={mu.user_id} type="button" onMouseDown={e => { e.preventDefault(); pickMention(mu.name); }}
                        className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-blue-50 text-sm">
                        <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold flex items-center justify-center flex-shrink-0">{initials(mu.name)}</span>
                        <span className="truncate">{mu.name}</span>
                      </button>
                    ))}
                  </div>
                )}
                {recording ? (
                  <>
                    <button onClick={() => stopRec(false)} className="flex-shrink-0 p-2 text-red-500" title="Cancel"><FiTrash2 size={18} /></button>
                    <div className="flex-1 min-w-0 flex items-center gap-2 text-red-500 text-sm px-2"><span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse flex-shrink-0" /> Recording… {mmss(recTime)}</div>
                    <button onClick={() => stopRec(true)} className="flex-shrink-0 p-2.5 rounded-full text-white" style={{ background: '#2563eb' }} title="Send voice"><FiSend size={16} /></button>
                  </>
                ) : (
                  <>
                    <input ref={fileRef} type="file" className="hidden" onChange={e => attach(e.target.files?.[0])} />
                    <button onClick={() => fileRef.current?.click()} disabled={busy} className="flex-shrink-0 p-2 text-gray-500 hover:text-blue-600" title="Attach photo / file"><FiPaperclip size={18} /></button>
                    {/* Wrap the textarea in a flex-1 min-w-0 div (NOT on the
                        textarea itself) — a textarea's intrinsic width isn't
                        reliably collapsed by min-width:0 on mobile, which pushed
                        the send button off the right edge so it never showed
                        (mam 2026-06-25). The reply bar uses this same wrapper. */}
                    <div className="flex-1 min-w-0">
                      <textarea ref={taRef} className="input resize-none block" rows="1" placeholder="Type a message… (@ to tag)" value={text}
                        onChange={onTextChange}
                        onKeyDown={e => {
                          if (mention && mentionList.length) {
                            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionList[0].name); return; }
                            if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
                          }
                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                        }} />
                    </div>
                    {text.trim()
                      ? <button onClick={() => send()} disabled={busy} className="flex-shrink-0 p-2.5 rounded-full text-white disabled:opacity-40" style={{ background: '#2563eb' }}><FiSend size={16} /></button>
                      : <button onClick={startRec} disabled={busy} className="flex-shrink-0 p-2.5 rounded-full text-white" style={{ background: '#2563eb' }} title="Record voice message"><FiMic size={16} /></button>}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── New group ─────────────────────────────────────── */}
      <Modal isOpen={newOpen} onClose={() => setNewOpen(false)} title="New group">
        <div className="space-y-3 text-sm">
          <div><label className="label">Group name *</label><input className="input" value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Hero Homes Site, Accounts Team…" autoFocus /></div>
          <div>
            <label className="label">Add members <span className="text-gray-400 font-normal normal-case">({newSel.length} selected · you're added automatically)</span></label>
            <input className="input mb-1" placeholder="Search people…" value={newSearch} onChange={e => setNewSearch(e.target.value)} />
            <div className="space-y-0.5 max-h-52 overflow-y-auto border rounded p-1">
              {allUsers.filter(u => u.id !== user?.id && (!newSearch || `${u.name} ${u.username || ''}`.toLowerCase().includes(newSearch.toLowerCase()))).map(u => {
                const on = newSel.includes(u.id);
                return (
                  <label key={u.id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50 cursor-pointer">
                    <input type="checkbox" checked={on} onChange={() => setNewSel(s => on ? s.filter(x => x !== u.id) : [...s, u.id])} />
                    <span>{u.name} <span className="text-[11px] text-gray-400">@{u.username}</span></span>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={createGroup} disabled={busy} className="btn btn-primary flex-1 disabled:opacity-50">{busy ? 'Creating…' : 'Create group'}</button>
            <button onClick={() => setNewOpen(false)} className="btn border">Cancel</button>
          </div>
        </div>
      </Modal>

      {/* ── New direct message ────────────────────────────── */}
      <Modal isOpen={dmOpen} onClose={() => setDmOpen(false)} title="New direct message">
        <div className="space-y-2 text-sm">
          <p className="text-xs text-gray-500">Pick a person to message directly — a private 1-on-1 chat.</p>
          <input className="input" placeholder="Search people…" value={dmSearch} onChange={e => setDmSearch(e.target.value)} autoFocus />
          <div className="space-y-0.5 max-h-72 overflow-y-auto border rounded p-1">
            {allUsers.filter(u => u.id !== user?.id && (!dmSearch || `${u.name} ${u.username || ''}`.toLowerCase().includes(dmSearch.toLowerCase()))).map(u => (
              <button key={u.id} onClick={() => startDm(u.id, u.name)} className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded hover:bg-blue-50">
                <Avatar url={userAvatars[u.id]} name={u.name} size={28} />
                <span className="truncate">{u.name} <span className="text-[11px] text-gray-400">@{u.username}</span></span>
              </button>
            ))}
            {allUsers.filter(u => u.id !== user?.id).length === 0 && <div className="text-center text-gray-400 text-xs py-4">No other users found</div>}
          </div>
        </div>
      </Modal>

      {/* ── Members ───────────────────────────────────────── */}
      {sel && (
        <Modal isOpen={memOpen} onClose={() => setMemOpen(false)} title={`Members · ${sel.name}`}>
          <div className="space-y-3 text-sm">
            {!sel.is_dm && canCreate('site_chat') && (
              <div>
                <label className="label">Group name</label>
                <div className="flex gap-2">
                  <input className="input flex-1" value={renameVal} onChange={e => setRenameVal(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); saveRename(); } }} placeholder="Group name" />
                  <button onClick={saveRename} disabled={!renameVal.trim() || renameVal.trim() === sel.name} className="btn btn-primary disabled:opacity-40">Rename</button>
                </div>
              </div>
            )}
            <p className="text-xs text-gray-500">Only people added here can see and post in this group.</p>
            <div>
              <div className="font-semibold text-gray-700 mb-1">In this group ({members.length})</div>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {members.map(m => (
                  <div key={m.user_id} className="flex items-center justify-between bg-gray-50 rounded px-2 py-1">
                    <span className="flex items-center gap-2"><Avatar url={userAvatars[m.user_id]} name={m.name} size={24} />{m.name}</span>
                    {canCreate('site_chat') && m.user_id !== user?.id && <button onClick={() => removeMember(m.user_id)} className="text-gray-400 hover:text-red-600" title="Remove"><FiX size={14} /></button>}
                  </div>
                ))}
              </div>
            </div>
            {canCreate('site_chat') && (
              <div>
                <div className="font-semibold text-gray-700 mb-1">Add member</div>
                <input className="input mb-1" placeholder="Search people…" value={memSearch} onChange={e => setMemSearch(e.target.value)} />
                <div className="space-y-0.5 max-h-40 overflow-y-auto">
                  {allUsers.filter(u => !members.some(m => m.user_id === u.id) && (!memSearch || `${u.name} ${u.username || ''}`.toLowerCase().includes(memSearch.toLowerCase()))).map(u => (
                    <div key={u.id} className="flex items-center justify-between px-2 py-1 border-b">
                      <span>{u.name} <span className="text-[11px] text-gray-400">@{u.username}</span></span>
                      <button onClick={() => addMember(u.id)} className="text-xs font-semibold text-blue-700 hover:bg-blue-50 rounded px-2 py-0.5">+ Add</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {canDelete('site_chat') && <button onClick={delGroup} className="text-xs text-red-600 font-semibold flex items-center gap-1.5 pt-1"><FiTrash2 size={13} /> Delete group</button>}
          </div>
        </Modal>
      )}

      {/* ── Message info (read / delivered) ────────────────── */}
      {infoMsg && (() => {
        const m = infoMsg;
        const others = members.filter(mm => mm.user_id !== m.sender_id);
        const readBy = others.filter(o => (reads[o.user_id] || 0) >= m.id);
        const delivered = others.filter(o => (reads[o.user_id] || 0) < m.id);
        const Row = ({ o, time, tone }) => (
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2"><span className={`w-6 h-6 rounded-full text-[10px] font-bold flex items-center justify-center ${tone}`}>{initials(o.name)}</span>{o.name}</span>
            {time && <span className="text-[11px] text-gray-400">{fmtDateTime(time)}</span>}
          </div>
        );
        return (
          <Modal isOpen={!!infoMsg} onClose={() => setInfoMsg(null)} title="Message info">
            <div className="space-y-3 text-sm">
              <div className="rounded-lg bg-[#e6ecf7] px-3 py-2">
                {m.attachment_name && <div className="text-xs text-gray-600 mb-0.5">📎 {m.attachment_name}</div>}
                {m.body && <div className="whitespace-pre-wrap break-words text-gray-800">{m.body}</div>}
                <div className="text-[10px] text-gray-500 mt-1">{m.sender_name} · {fmtDateTime(m.created_at)}</div>
              </div>
              <div>
                <div className="font-semibold text-sky-600 mb-1">✓✓ Read by ({readBy.length})</div>
                {readBy.length === 0 ? <div className="text-xs text-gray-400">No one yet</div>
                  : <div className="space-y-1">{readBy.map(o => <Row key={o.user_id} o={o} time={readsAt[o.user_id]} tone="bg-sky-100 text-sky-700" />)}</div>}
              </div>
              <div>
                <div className="font-semibold text-gray-500 mb-1">✓✓ Delivered to ({delivered.length})</div>
                {delivered.length === 0 ? <div className="text-xs text-gray-400">—</div>
                  : <div className="space-y-1">{delivered.map(o => <Row key={o.user_id} o={o} tone="bg-gray-100 text-gray-600" />)}</div>}
              </div>
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}
