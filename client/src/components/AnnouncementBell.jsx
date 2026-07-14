import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FiBell, FiPlus, FiX, FiTrash2, FiBookmark, FiEdit2, FiEye,
  FiChevronDown, FiImage, FiCamera, FiPaperclip,
  FiAlertCircle, FiCalendar, FiClock, FiAward, FiCheck,
} from 'react-icons/fi';
import api from '../api';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { fmtDate, fmtTime } from '../utils/datetime';

// HR notification type → icon + colour (used in the Notifications tab)
const NOTIF_TYPE_ICON = {
  interview_reminder: FiCalendar,
  offer_expiry:       FiClock,
  approval_pending:   FiAlertCircle,
  training_assigned:  FiAward,
  scorecard_added:    FiAward,
  generic:            FiBell,
};
const NOTIF_TYPE_COLOR = {
  interview_reminder: 'text-indigo-600',
  offer_expiry:       'text-amber-600',
  approval_pending:   'text-rose-600',
  training_assigned:  'text-emerald-600',
  scorecard_added:    'text-purple-600',
  generic:            'text-gray-600',
};

// Bell icon for the header. Shows an unread-count badge that polls every
// 60 seconds. Clicking opens a dropdown panel listing all announcements
// (pinned first), highlighting any posted since this user's last visit.
// Admins also see a small "+ New" button inside the panel to post directly.
export default function AnnouncementBell() {
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // Mam (2026-05-22): merged inbox — single bell shows both
  // Announcements AND My Notifications.  Replaced the standalone
  // NotificationsBell to fix "why this three button" confusion.
  // Active tab opens to whichever has unread items.
  const [tab, setTab] = useState('notifications');     // 'notifications' | 'announcements'
  const [unread, setUnread] = useState(0);                       // announcements unread count
  const [unreadNotif, setUnreadNotif] = useState(0);             // notifications unread count
  const [items, setItems] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: '', body: '', pinned: false, expires_at: '', attachment_url: '' });
  // Mam (2026-05-22): "upload photo option so that can check photo" —
  // uploadingPhoto drives the spinner; lightboxUrl opens a full-size
  // preview when employee clicks the inline thumbnail.
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState(null);
  const [editing, setEditing] = useState(null);
  // Per-announcement reader drill-down (admin only). Map of id → readers data.
  const [readers, setReaders] = useState({}); // { [annId]: { read_count, unread_count, readers, non_readers } }
  const [expandedReaders, setExpandedReaders] = useState(null); // id of announcement currently expanded
  const ref = useRef(null);

  const loadCount = () => {
    api.get('/announcements/unread-count').then(r => setUnread(r.data?.count || 0)).catch(() => {});
    // Mam (2026-05-22): also poll HR notifications so the merged
    // bell badge reflects both sources.
    api.get('/hr/my-notifications?unread=1').then(r => setUnreadNotif((r.data || []).length)).catch(() => {});
  };
  const loadItems = () => {
    api.get('/announcements').then(r => setItems(r.data || [])).catch(() => setItems([]));
  };
  const loadNotifications = () => {
    api.get('/hr/my-notifications').then(r => setNotifications(r.data || [])).catch(() => setNotifications([]));
  };

  // Poll both unread counts every 60s so the bell badge stays current even
  // when the user keeps the same tab open all day.
  useEffect(() => {
    loadCount();
    const t = setInterval(loadCount, 60000);
    return () => clearInterval(t);
  }, []);

  // Click outside the panel closes it. Loaded once per mount.
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const onOpen = async () => {
    setOpen(true);
    loadItems();
    loadNotifications();
    // Mam (2026-05-22): open to the tab that has unread items so the
    // user sees what matters first.  Default to Notifications because
    // those are personal action items (interview tomorrow, offer
    // expiring).  Announcements are passive broadcasts.
    if (unreadNotif > 0) setTab('notifications');
    else if (unread > 0) setTab('announcements');
    // else keep whichever tab was last open
    // Mark announcements as seen — clears that part of the badge.
    try { await api.post('/announcements/mark-seen'); setUnread(0); } catch {}
  };

  // ── Notification handlers (mam 2026-05-22) ────────────────────────
  const clickNotification = async (n) => {
    if (!n.read_at) {
      try { await api.put(`/hr/notifications/${n.id}/read`); } catch {}
    }
    setOpen(false);
    if (n.link_url) navigate(n.link_url);
    loadNotifications();
    loadCount();
  };
  const markAllNotificationsRead = async () => {
    try { await api.post('/hr/notifications/mark-all-read'); loadNotifications(); loadCount(); } catch {}
  };

  const submitNew = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) return toast.error('Title required');
    try {
      if (editing) {
        await api.put(`/announcements/${editing.id}`, form);
        toast.success('Announcement updated');
      } else {
        await api.post('/announcements', form);
        toast.success('Announcement posted');
      }
      setForm({ title: '', body: '', pinned: false, expires_at: '', attachment_url: '' });
      setAdding(false);
      setEditing(null);
      loadItems();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const remove = async (id) => {
    if (!confirm('Delete this announcement?')) return;
    try { await api.delete(`/announcements/${id}`); toast.success('Deleted'); loadItems(); }
    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
  };

  const startEdit = (a) => {
    setEditing(a);
    setForm({
      title: a.title || '',
      body: a.body || '',
      pinned: !!a.pinned,
      expires_at: a.expires_at ? a.expires_at.slice(0, 16) : '',
      attachment_url: a.attachment_url || '',
    });
    setAdding(true);
  };

  // Mam (2026-05-22): upload photo for the announcement — uses the
  // existing /upload endpoint (multer-backed) so we don't need a new
  // server route.  Accepts image OR PDF.  capture='environment'
  // on the camera button means the rear camera on phones.
  const uploadPhoto = async (file) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return toast.error('File too large (max 10 MB)');
    setUploadingPhoto(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setForm(f => ({ ...f, attachment_url: r.data?.url || '' }));
      toast.success('Photo attached');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Upload failed');
    } finally {
      setUploadingPhoto(false);
    }
  };
  // Tells us whether the attachment is an image (so we render <img>)
  // vs a PDF / other (so we render a link).
  const isImage = (url) => url && /\.(jpe?g|png|gif|webp|bmp|svg)(\?|$)/i.test(url);

  const fmt = (s) => {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return fmtDate(s, { day: '2-digit', month: 'short' }) + ' · ' + fmtTime(s, { hour: '2-digit', minute: '2-digit' });
  };

  // Lazy-load the reader breakdown for one announcement when admin clicks
  // the "👁 N read" pill. Cache so flipping back & forth is instant.
  const toggleReaders = async (annId) => {
    if (expandedReaders === annId) { setExpandedReaders(null); return; }
    setExpandedReaders(annId);
    if (!readers[annId]) {
      try {
        const { data } = await api.get(`/announcements/${annId}/readers`);
        setReaders(prev => ({ ...prev, [annId]: data }));
      } catch (err) {
        toast.error(err.response?.data?.error || 'Failed to load readers');
      }
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => open ? setOpen(false) : onOpen()}
        className="relative p-2 hover:bg-gray-100 rounded-lg flex-shrink-0 text-gray-600"
        title="Notifications & Announcements"
        aria-label={`Notifications and announcements${(unread + unreadNotif) > 0 ? ` — ${unread + unreadNotif} unread` : ''}`}
      >
        <FiBell size={20} />
        {(unread + unreadNotif) > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-red-600 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
            {(unread + unreadNotif) > 9 ? '9+' : (unread + unreadNotif)}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-[92vw] sm:w-[420px] max-h-[80vh] bg-white border border-gray-200 rounded-lg shadow-xl z-50 flex flex-col">
          {/* Mam (2026-05-22): unified header with tabs.  Title +
              close button on row 1, two-tab strip on row 2 with
              per-tab unread badges. */}
          <div className="border-b bg-gradient-to-r from-blue-50 to-blue-100">
            <div className="px-3 py-2 flex items-center justify-between">
              <h4 className="font-semibold text-sm flex items-center gap-1.5"><FiBell size={14}/> Inbox</h4>
              <div className="flex items-center gap-1">
                {tab === 'announcements' && isAdmin() && !adding && (
                  <button onClick={() => { setEditing(null); setForm({ title: '', body: '', pinned: false, expires_at: '', attachment_url: '' }); setAdding(true); }} className="text-[11px] font-semibold text-blue-700 hover:bg-white px-2 py-1 rounded flex items-center gap-1">
                    <FiPlus size={11}/> New
                  </button>
                )}
                {tab === 'notifications' && unreadNotif > 0 && (
                  <button onClick={markAllNotificationsRead} className="text-[11px] text-blue-700 hover:bg-white px-2 py-1 rounded flex items-center gap-1">
                    <FiCheck size={11}/> Mark all read
                  </button>
                )}
                <button onClick={() => setOpen(false)} className="p-1 hover:bg-white rounded"><FiX size={14} /></button>
              </div>
            </div>
            <div className="flex">
              {[
                { id: 'notifications',  label: 'My Notifications', count: unreadNotif },
                { id: 'announcements',  label: 'Announcements',     count: unread       },
              ].map(t => {
                const active = tab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={`flex-1 px-3 py-1.5 text-[12px] font-semibold border-b-2 flex items-center justify-center gap-1.5
                      ${active
                        ? 'border-blue-600 text-blue-700 bg-white/60'
                        : 'border-transparent text-gray-500 hover:text-gray-700'}`}
                  >
                    {t.label}
                    {t.count > 0 && (
                      <span className="bg-red-600 text-white text-[9px] font-bold rounded-full min-w-[16px] h-[16px] flex items-center justify-center px-1">
                        {t.count > 9 ? '9+' : t.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {tab === 'announcements' && adding && isAdmin() && (
            <form onSubmit={submitNew} className="border-b bg-gray-50/60 p-3 space-y-2">
              <input
                className="input text-sm"
                placeholder="Title (e.g. Office holiday on May 1)"
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                required
              />
              <textarea
                className="input text-sm"
                rows="3"
                placeholder="Details (optional)"
                value={form.body}
                onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
              />
              <div className="grid grid-cols-2 gap-2">
                <label className="flex items-center gap-1.5 text-[11px] text-gray-600">
                  <input type="checkbox" checked={!!form.pinned} onChange={e => setForm(f => ({ ...f, pinned: e.target.checked }))} />
                  Pin to top
                </label>
                <input
                  type="datetime-local"
                  className="input text-[11px] py-1"
                  title="Auto-hide after this date (optional)"
                  value={form.expires_at}
                  onChange={e => setForm(f => ({ ...f, expires_at: e.target.value }))}
                />
              </div>

              {/* Mam (2026-05-22): upload photo for the announcement.
                  Two buttons — "Take Photo" uses the device camera
                  (capture='environment' picks the rear lens on phones),
                  "Choose File" opens the standard file picker. */}
              <div className="space-y-1.5">
                {form.attachment_url ? (
                  <div className="relative inline-block">
                    {isImage(form.attachment_url) ? (
                      <img src={form.attachment_url} alt="Attachment preview"
                        className="max-h-32 rounded border border-gray-300 object-cover"/>
                    ) : (
                      <a href={form.attachment_url} target="_blank" rel="noreferrer"
                        className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 rounded border border-gray-300 text-[11px] text-blue-700 hover:underline">
                        <FiPaperclip size={11}/> View attached file
                      </a>
                    )}
                    <button type="button" onClick={() => setForm(f => ({ ...f, attachment_url: '' }))}
                      className="absolute -top-1.5 -right-1.5 bg-red-600 text-white rounded-full w-5 h-5 flex items-center justify-center text-[10px] shadow"
                      title="Remove attachment">
                      <FiX size={10}/>
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-1.5 items-center">
                    <label className="flex items-center gap-1 text-[11px] text-blue-700 hover:text-blue-900 cursor-pointer px-2 py-1 bg-blue-50 border border-blue-200 rounded">
                      <FiCamera size={12}/> Take Photo
                      <input type="file" accept="image/*" capture="environment" className="hidden"
                        disabled={uploadingPhoto}
                        onChange={e => uploadPhoto(e.target.files?.[0])} />
                    </label>
                    <label className="flex items-center gap-1 text-[11px] text-blue-700 hover:text-blue-900 cursor-pointer px-2 py-1 bg-blue-50 border border-blue-200 rounded">
                      <FiImage size={12}/> Choose File
                      <input type="file" accept="image/*,application/pdf" className="hidden"
                        disabled={uploadingPhoto}
                        onChange={e => uploadPhoto(e.target.files?.[0])} />
                    </label>
                    {uploadingPhoto && (
                      <span className="text-[10px] text-gray-500 flex items-center gap-1">
                        <span className="inline-block w-2.5 h-2.5 border-2 border-blue-300 border-t-blue-700 rounded-full animate-spin"/>
                        Uploading…
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => { setAdding(false); setEditing(null); }} className="text-[11px] text-gray-500 hover:text-gray-700 px-2 py-1">Cancel</button>
                <button type="submit" className="btn btn-primary text-[11px] py-1 px-3">{editing ? 'Update' : 'Post'}</button>
              </div>
            </form>
          )}

          {/* ── NOTIFICATIONS TAB ── */}
          {tab === 'notifications' && (
            <div className="flex-1 overflow-y-auto">
              {notifications.length === 0 && (
                <div className="text-center text-gray-400 text-sm py-10 px-4">
                  <FiBell size={28} className="mx-auto opacity-30 mb-2"/>
                  No notifications yet.
                  <div className="text-[10px] text-gray-400 mt-1">Interview reminders, offer responses and pending approvals will land here.</div>
                </div>
              )}
              {notifications.map(n => {
                const Icon = NOTIF_TYPE_ICON[n.type] || FiBell;
                const colorCls = NOTIF_TYPE_COLOR[n.type] || 'text-gray-600';
                return (
                  <button
                    key={n.id}
                    onClick={() => clickNotification(n)}
                    className={`w-full text-left px-3 py-2.5 border-b border-gray-100 hover:bg-gray-50 flex items-start gap-2.5 ${!n.read_at ? 'bg-blue-50/40' : ''}`}>
                    <Icon size={16} className={`mt-0.5 ${colorCls}`}/>
                    <div className="flex-1 min-w-0">
                      <div className={`text-[12.5px] ${!n.read_at ? 'font-semibold' : 'text-gray-700'} truncate`}>{n.title}</div>
                      {n.body && <div className="text-[11px] text-gray-500 line-clamp-2">{n.body}</div>}
                      <div className="text-[10px] text-gray-400 mt-0.5">{fmt(n.created_at)}</div>
                    </div>
                    {!n.read_at && <span className="w-2 h-2 rounded-full bg-blue-600 mt-1.5 flex-shrink-0"/>}
                  </button>
                );
              })}
            </div>
          )}

          {/* ── ANNOUNCEMENTS TAB ── */}
          {tab === 'announcements' && (
          <div className="flex-1 overflow-y-auto">
            {items.length === 0 && (
              <div className="text-center text-gray-400 text-sm py-8 px-4">
                No announcements yet.{isAdmin() && ' Click "+ New" to post the first one.'}
              </div>
            )}
            {items.map(a => (
              <div key={a.id} className={`px-3 py-2.5 border-b ${a.is_new ? 'bg-blue-50/50' : 'hover:bg-gray-50'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {!!a.pinned && <FiBookmark size={11} className="text-amber-500 flex-shrink-0 fill-amber-500" title="Pinned" />}
                      <span className="font-semibold text-sm text-gray-800">{a.title}</span>
                      {!!a.is_new && <span className="text-[9px] font-bold uppercase bg-red-100 text-red-700 px-1.5 py-0.5 rounded">NEW</span>}
                    </div>
                    {a.body && <p className="text-[12px] text-gray-600 mt-1 whitespace-pre-wrap">{a.body}</p>}
                    {/* Mam (2026-05-22): inline photo thumbnail —
                        click to open in a full-screen lightbox.  For
                        non-image attachments (PDF etc.) we show a
                        labelled link instead. */}
                    {a.attachment_url && (
                      <div className="mt-2">
                        {isImage(a.attachment_url) ? (
                          <img
                            src={a.attachment_url}
                            alt={a.title}
                            onClick={() => setLightboxUrl(a.attachment_url)}
                            className="max-h-40 w-full object-cover rounded border border-gray-200 cursor-zoom-in hover:opacity-90"
                          />
                        ) : (
                          <a href={a.attachment_url} target="_blank" rel="noreferrer"
                            className="inline-flex items-center gap-1 text-[11px] text-blue-700 hover:underline">
                            <FiPaperclip size={11}/> View attached file
                          </a>
                        )}
                      </div>
                    )}
                    <div className="text-[10px] text-gray-400 mt-1 flex flex-wrap items-center gap-2">
                      <span>{a.created_by_name || 'Admin'} · {fmt(a.created_at)}</span>
                      {a.expires_at && <span>· expires {fmt(a.expires_at)}</span>}
                      {/* Read tracker — admin only. Shows N of M read.
                          Coloured green when everyone read it, amber otherwise.
                          Click expands a small list of who has / hasn't read. */}
                      {isAdmin() && a.total_users > 0 && (
                        <button
                          onClick={() => toggleReaders(a.id)}
                          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium ${
                            a.read_count >= a.total_users
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                              : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                          }`}
                          title="Click to see who read"
                        >
                          <FiEye size={10} /> {a.read_count} of {a.total_users} read
                          <FiChevronDown size={10} className={`transition-transform ${expandedReaders === a.id ? 'rotate-180' : ''}`} />
                        </button>
                      )}
                    </div>

                    {/* Reader drill-down — only rendered when expanded.
                        Shows two lists: ✓ who has read (with timestamp) and
                        ✗ who hasn't yet, so admin can chase up the laggards. */}
                    {isAdmin() && expandedReaders === a.id && (
                      <div className="mt-2 border-t pt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                        <div>
                          <div className="font-bold text-emerald-700 mb-1">✓ Read ({readers[a.id]?.read_count || 0})</div>
                          {readers[a.id]?.readers?.length ? (
                            <ul className="space-y-0.5 max-h-32 overflow-y-auto">
                              {readers[a.id].readers.map(u => (
                                <li key={u.id} className="text-gray-700">
                                  {u.name} <span className="text-gray-400 text-[9px]">· {fmt(u.seen_at)}</span>
                                </li>
                              ))}
                            </ul>
                          ) : <div className="text-gray-400 italic">Nobody yet</div>}
                        </div>
                        <div>
                          <div className="font-bold text-red-700 mb-1">✗ Not yet ({readers[a.id]?.unread_count || 0})</div>
                          {readers[a.id]?.non_readers?.length ? (
                            <ul className="space-y-0.5 max-h-32 overflow-y-auto">
                              {readers[a.id].non_readers.map(u => (
                                <li key={u.id} className="text-gray-700">{u.name}</li>
                              ))}
                            </ul>
                          ) : <div className="text-emerald-600 italic">Everyone read! 🎉</div>}
                        </div>
                      </div>
                    )}
                  </div>
                  {isAdmin() && (
                    <div className="flex flex-col gap-1 flex-shrink-0">
                      <button onClick={() => startEdit(a)} className="p-1 text-gray-400 hover:text-blue-600" title="Edit"><FiEdit2 size={12} /></button>
                      <button onClick={() => remove(a.id)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={12} /></button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          )}
        </div>
      )}

      {/* Mam (2026-05-22): full-screen photo viewer.  Renders outside
          the bell panel so it can fill the whole screen and isn't
          clipped by the dropdown overflow.  Click anywhere to close. */}
      {lightboxUrl && (
        <div
          onClick={() => setLightboxUrl(null)}
          className="fixed inset-0 z-[100] bg-black/85 flex items-center justify-center p-4 cursor-zoom-out"
        >
          <img src={lightboxUrl} alt="Announcement attachment" className="max-w-full max-h-full object-contain rounded shadow-2xl"/>
          <button
            onClick={(e) => { e.stopPropagation(); setLightboxUrl(null); }}
            className="absolute top-4 right-4 bg-white/90 hover:bg-white text-gray-900 rounded-full w-10 h-10 flex items-center justify-center shadow-lg"
            title="Close">
            <FiX size={18}/>
          </button>
        </div>
      )}
    </div>
  );
}
