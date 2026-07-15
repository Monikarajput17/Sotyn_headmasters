import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useLocation, useNavigate, Outlet } from 'react-router-dom';
import AnnouncementBell from './AnnouncementBell';
// Mam (2026-05-22): standalone NotificationsBell removed — its
// functionality is now merged into AnnouncementBell as a second tab,
// so there's a single bell icon in the header (was confusing with 3).
import EnablePushButton from './EnablePushButton';
import AIAgentChat from './AIAgentChat';
import { CallProvider } from '../context/CallContext';
import Modal from './Modal';
import toast from 'react-hot-toast';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import { useAppSocket } from '../context/SocketProvider';
import {
  // Navigation + UI controls (kept as-is)
  FiHome, FiMenu, FiX, FiLogOut, FiChevronRight, FiChevronDown, FiKey,
  // ─── No-duplicate icon set (mam 2026-05-27: "icon dont have duplicates") ───
  // 64 distinct icons for 64 sidebar entries. Every one used exactly once.
  // Group headers + standalone Dashboard + Settings group
  FiTarget, FiFileText, FiShoppingBag, FiBriefcase, FiUsers, FiPackage,
  FiCheckSquare, FiPhoneCall, FiStar, FiShield, FiSettings,
  // CRM children
  FiGlobe, FiTrendingUp, FiTrendingDown, FiFilter, FiBook, FiUser,
  // Quotes & Orders children
  FiArchive, FiClipboard, FiTruck, FiShoppingCart, FiSun,
  // Procurement children
  FiGrid, FiHexagon, FiInbox, FiTag,
  // Projects children
  FiBarChart2, FiAlertCircle, FiZap, FiTool,
  // Finance children
  FiFile, FiCreditCard, FiSend, FiList, FiRefreshCw,
  // People children
  FiUserPlus, FiHelpCircle, FiBookOpen, FiCalendar, FiDollarSign, FiAtSign,
  // Inventory children
  FiClock, FiBox, FiServer, FiSliders, FiBookmark,
  // Tasks children
  FiAward, FiPaperclip, FiLayers, FiCheckCircle,
  // Service Desk children
  FiAlertTriangle, FiMessageCircle, FiMessageSquare,
  // Executive children
  FiCrosshair, FiMonitor, FiCompass,
  // Admin children + Settings children
  FiActivity, FiMapPin, FiDatabase, FiMail, FiUserCheck, FiSearch,
  // HRMS · Sub-contractor Hiring workflow (mam 2026-05-28)
  FiGitMerge,
  // Procurement · backward-pass Gantt (mam 2026-05-28)
  FiGitBranch,
} from 'react-icons/fi';
import { LuIndianRupee, LuBrain } from 'react-icons/lu';
import { FaTrophy } from 'react-icons/fa';
import { BiMessageRoundedCheck } from 'react-icons/bi';

// ─── Sidebar structure (mam 2026-05-27 — SEPL_Sidebar_Restructure spec) ───
// Dashboard stays standalone at the very top (no group, single URL).
// Every other item lives in a collapsible accordion group, all initially
// CLOSED and independently expandable (no exclusive-open behaviour — mam
// asked for "expandable independent").  Settings group is pinned to the
// bottom of the scrollable nav (still inside scroll, just last entry).
//
// Renames applied per spec.  Merges:
//   - CRM Sales Funnel    → into Indent to Dispatch (entry removed)
//   - MD Collections      → into Collections (entry removed)
//   - Director's War Room + CMD Operating Console + CMD TOC View → ONE
//                          "Executive" entry in the Executive group
//                          (links to /dashboard/cmd as the canonical
//                          consolidated view; the other 2 routes stay
//                          alive for direct-URL access).
const SIDEBAR_DASHBOARD = { path: '/', label: 'Dashboard', icon: FiHome, module: 'dashboard' };

// ─── Icon map — NO DUPLICATES (mam 2026-05-27) ────────────────────────
// Every single entry below uses a distinct icon. 64 entries · 64 icons.
// When picking a new icon, search this file first to make sure it's not
// already in use somewhere else.
const SIDEBAR_GROUPS = [
  // ─── Sotyn.Headmasters fork — salon-first navigation ─────────────────────
  { id: 'salon', label: 'Salon', icon: FiStar, items: [
    { path: '/salon/appointments', label: 'Appointments',  icon: FiCalendar,     module: 'salon_appointments' },
    { path: '/salon/billing',      label: 'Billing / POS',  icon: FiShoppingCart, module: 'salon_pos' },
    { path: '/salon/clients',      label: 'Clients',        icon: FiUsers,        module: 'salon_clients' },
    { path: '/salon/services',     label: 'Service Menu',   icon: FiTag,          module: 'salon_services' },
    { path: '/salon/products',     label: 'Retail Products', icon: FiPackage,     module: 'salon_products' },
    { path: '/salon/stylists',     label: 'Stylists',       icon: FiUser,         module: 'salon_stylists' },
    { path: '/salon/memberships',  label: 'Memberships',    icon: FiAward,        module: 'salon_memberships' },
    { path: '/salon/commissions',  label: 'Commissions',    icon: FiTrendingUp,   module: 'salon_commissions' },
  ]},
  // Staff — generic team management that applies to a salon. The construction
  // groups (Finance/Invoices with RA·MB·Installation bills, Cash Flow project
  // finance, Inventory warehouse stock, Service-Desk site complaints, and the
  // construction-KPI Scorecard/Champions) were removed — a salon's money lives
  // in Salon → Billing / Commissions / Dashboard, and retail stock in
  // Salon → Retail Products. Routes stay in App.jsx (just unlinked) so nothing 404s.
  { id: 'people', label: 'Staff', icon: FiUsers, items: [
    { path: '/attendance', label: 'Attendance', icon: FiCalendar,   module: 'attendance' },
    { path: '/payroll',    label: 'Payroll',    icon: FiDollarSign, module: 'payroll' },
    { path: '/employees',  label: 'Employees',  icon: FiAtSign,     module: 'employees' },
    // Hiring (/hr) removed — its Manpower-Planning + Sub-Contractor tabs are
    // construction (Site Engineer, Foreman, DPR). Route stays in App.jsx.
  ]},
  { id: 'tasks', label: 'Tasks', icon: FiCheckSquare, items: [
    { path: '/delegations', label: 'Delegations', icon: FiPaperclip,   module: 'delegations' },
    { path: '/checklists',  label: 'Checklists',  icon: FiCheckCircle, module: 'checklists' },
  ]},
  { id: 'support', label: 'Support', icon: FiPhoneCall, items: [
    { path: '/help-tickets', label: 'Help Tickets', icon: FiMessageCircle, module: null, open: true },
  ]},
  { id: 'admin', label: 'Admin', icon: FiKey, adminOnly: true, items: [
    { path: '/admin/word-count', label: 'Activity Log', icon: FiActivity, module: 'users' },
    { path: '/admin/locations',  label: 'Location',     icon: FiMapPin,   module: 'users' },
  ]},
];

// Settings group — always rendered LAST (pinned to bottom of the nav)
// per mam's spec.  Same collapsible accordion behaviour as the others.
const SIDEBAR_SETTINGS = { id: 'settings', label: 'Settings', icon: FiSettings, adminOnly: true, items: [
  { path: '/admin/backups',        label: 'Backups',             icon: FiDatabase,  module: 'users' },
  { path: '/admin/ai-settings',    label: 'AI',                  icon: LuBrain,     module: 'users' },
  { path: '/admin/email-settings', label: 'Email',               icon: FiMail,      module: 'users' },
  { path: '/admin/email-triggers', label: 'Email Triggers',      icon: FiZap,       module: 'users' },
  { path: '/admin/users',          label: 'Users',               icon: FiUserCheck, module: 'users' },
  { path: '/admin/roles',          label: 'Roles & Permissions', icon: FiShield,    module: 'users' },
  { path: '/admin/audit',          label: 'Audit Log',           icon: FiSearch,    module: 'users' },
]};

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [pwdModal, setPwdModal] = useState(false);
  const [pwdForm, setPwdForm] = useState({ current_password: '', new_password: '', confirm: '' });
  const [pwdSaving, setPwdSaving] = useState(false);
  // Header user-avatar menu (mam 2026-06-17 header freeze): identity +
  // Change Password + Logout reachable from the top bar even when the
  // sidebar is collapsed — the footer copy stays as-is for the open state.
  const [userMenu, setUserMenu] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout, canView, isAdmin, userRoles } = useAuth();
  const { subscribe } = useAppSocket();

  // Admin bypasses mandatory fields everywhere (mam 2026-06-19: "admin can
  // update anywhere, if a thing is mandatory it's not for him"). We disable
  // the browser's native required-field blocking on every <form> — including
  // modals mounted later — so admin can save partial records app-wide.
  // Non-admins are untouched and keep full validation.
  const adminBypass = isAdmin();
  useEffect(() => {
    if (!adminBypass) return;
    const relax = (root) => {
      if (!root || root.nodeType !== 1) return;
      if (root.tagName === 'FORM') { root.noValidate = true; return; }
      root.querySelectorAll?.('form').forEach(f => { f.noValidate = true; });
    };
    relax(document.body);
    const obs = new MutationObserver(muts => { for (const m of muts) for (const n of m.addedNodes) relax(n); });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [adminBypass]);

  // ── WhatsApp background notifications (mam 2026-06-19) ─────────────────
  // App-wide: a new message in ANY group the user belongs to pops a toast +
  // browser notification and shows an unread badge on the sidebar WhatsApp
  // link — even when not on the chat page. Driven by the chat Socket.IO with
  // a 25 s poll fallback. `unread` already excludes the user's own messages.
  const [waUnread, setWaUnread] = useState(0);
  const waPrev = useRef(null);                 // Map<groupId, unread> from the last fetch
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;

  // Dedicated lightweight endpoint (perf pass — admin-slowness fix): an admin
  // can oversee a large number of groups, and this poll runs every 25s from
  // EVERY page for EVERY signed-in user — reusing the full paginated /groups
  // list here would recompute last-message/member-count for every accessible
  // group in the background continuously. /unread-count instead returns one
  // uncapped total (for the badge number) plus only the small subset of
  // groups that actually have unread messages (for the toast below) — it
  // never needs to know about groups with zero unread.
  const refreshWa = useCallback(async () => {
    try {
      const { data } = await api.get('/site-chat/unread-count');
      const groups = data?.groups || [];
      setWaUnread(data?.total || 0);
      const prev = waPrev.current;
      if (prev && pathRef.current !== '/site-chat') {       // don't alert for the page you're on
        for (const g of groups) {
          if ((g.unread || 0) > (prev.get(g.id) || 0)) {
            const last = g.last || {};
            const body = last.body || (last.attachment_name ? `📎 ${last.attachment_name}` : 'New message');
            const line = `${last.sender_name ? last.sender_name.split(' ')[0] + ': ' : ''}${body}`;
            const gid = g.id, gname = g.name;
            // Prominent, clickable blue banner pinned to the TOP-CENTER so the
            // alert is unmistakably "on top" (mam 2026-06-19).
            toast.custom((t) => (
              <div onClick={() => { toast.dismiss(t.id); navigate('/site-chat'); }}
                className="cursor-pointer flex items-start gap-2 w-[320px] max-w-[88vw] rounded-xl shadow-2xl px-3 py-2.5 text-white"
                style={{ background: '#1e3a8a' }}>
                <BiMessageRoundedCheck className="mt-0.5 text-blue-900 flex-shrink-0" size={20} />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-sm truncate">{gname}</div>
                  <div className="text-xs text-white/90 truncate">{line}</div>
                </div>
                <button onClick={(e) => { e.stopPropagation(); toast.dismiss(t.id); }} className="text-white/70 hover:text-white flex-shrink-0">✕</button>
              </div>
            ), { position: 'top-center', duration: 6000, id: `wa-${gid}` });
            if ('Notification' in window && Notification.permission === 'granted') {
              try {
                const n = new Notification(`Salon Chat · ${gname}`, { body: line, icon: '/icon.svg', tag: `wa-${gid}` });
                n.onclick = () => { window.focus(); navigate('/site-chat'); n.close(); };
              } catch { /* ignore */ }
            }
            break;                                          // one alert per refresh is enough
          }
        }
      }
      waPrev.current = new Map(groups.map(g => [g.id, g.unread || 0]));
    } catch { /* not logged in / not a member yet — ignore */ }
  }, []);

  useEffect(() => {
    if (!user?.id) return;
    if ('Notification' in window && Notification.permission === 'default') { try { Notification.requestPermission(); } catch { /* ignore */ } }
    refreshWa();
    // Chat notifications now ride the shared shell socket (SocketProvider) —
    // no own connection. subscribe() survives the socket's deferred connect and
    // any reconnect, so live badge/toast updates work exactly as before across
    // in-app / storage-blocked browsers (the shared socket keeps the same
    // getToken() function-form auth). The 25s poll stays as the offline fallback.
    const offChanged = subscribe('changed', refreshWa);
    const offDeleted = subscribe('group_deleted', refreshWa);
    const poll = setInterval(refreshWa, 25000);             // fallback for groups joined after connect
    return () => { offChanged(); offDeleted(); clearInterval(poll); };
  }, [user?.id, refreshWa, subscribe]);

  const changePassword = async (e) => {
    e.preventDefault();
    if (pwdForm.new_password !== pwdForm.confirm) { toast.error('New password and confirmation do not match'); return; }
    if (!pwdForm.new_password || pwdForm.new_password.length < 4) { toast.error('New password must be at least 4 characters'); return; }
    setPwdSaving(true);
    try {
      await api.post('/auth/change-password', { current_password: pwdForm.current_password, new_password: pwdForm.new_password });
      toast.success('Password changed');
      setPwdModal(false);
      setPwdForm({ current_password: '', new_password: '', confirm: '' });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to change password');
    }
    setPwdSaving(false);
  };

  useEffect(() => {
    const check = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) setSidebarOpen(true);
      else setSidebarOpen(false);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // (Removed --toolbar-height ResizeObserver — sticky-toolbar and
  // freeze-head were rolled back to inert classes after the layered
  // visual collapsed on the DPR dashboard.  Mam: "seriously do you
  // think its good ui/ux", 2026-05-13.)

  // Close sidebar on mobile when route changes
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
    setUserMenu(false);   // also dismiss the header avatar menu on navigation
  }, [location.pathname, isMobile]);

  // GLOBAL LOCATION TRACKING — was Attendance-page-only before, but mam's
  // team often closes that tab and just uses Leads / Procurement / etc.
  // Running it from the Layout means as long as ANY Sotyn.Headmasters page is open in
  // the browser (or installed PWA), GPS pings every 30 seconds. Each ping
  // also acts as a heartbeat for backend auto-punch.
  // Limitations: a fully-closed browser cannot ping. For 24/7 tracking
  // even when the app is closed, we'd need a native Android wrapper.
  useEffect(() => {
    if (!user) return;                    // not logged in -> no tracking
    if (!navigator.geolocation) return;   // no GPS support
    let cancelled = false;
    let wakeLock = null;

    const trackLocation = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (cancelled) return;
          // accuracy is the radius of GPS uncertainty in meters. Backend
          // uses it to apply a tolerance to the geofence check so users
          // physically on site aren't tagged "Outside" because of indoor
          // GPS drift / cloud cover noise.
          api.post('/attendance/track-location', {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy || 0,
            address: '',
          }).catch(() => {});
        },
        () => {},                              // permission denied / timeout — silent
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
      );
    };

    // Best-effort wake lock so phone screen / tab doesn't fully suspend
    // mid-day; not all browsers support this — silently ignore if missing.
    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          wakeLock = await navigator.wakeLock.request('screen');
        }
      } catch (e) { /* ignore */ }
    };
    requestWakeLock();
    // Named handler so the cleanup can remove it — an anonymous listener here
    // leaked a new one on every user change (audit 2026-06-12).
    const onVisible = () => { if (document.visibilityState === 'visible') requestWakeLock(); };
    document.addEventListener('visibilitychange', onVisible);

    trackLocation();
    const interval = setInterval(trackLocation, 30 * 1000);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      if (wakeLock && wakeLock.release) wakeLock.release().catch(() => {});
    };
  }, [user?.id]);

  // ─── Sidebar search (mam 2026-05-28: "users have issue to find") ───
  // Type-anywhere search across every menu label so an MD who knows
  // "Attendance exists somewhere" doesn't have to remember whether it
  // lives under People or HR.  Matching is case-insensitive substring.
  // When the box has text, the accordion state is overridden — every
  // group with at least one matching child is force-expanded and
  // non-matching siblings are hidden. Empty box restores the saved
  // accordion state untouched.
  const [navSearch, setNavSearch] = useState('');
  const navQuery = navSearch.trim().toLowerCase();
  const itemMatches = (item) => !navQuery || item.label.toLowerCase().includes(navQuery);

  // ─── Sidebar accordion state ───────────────────────────────────────
  // Each group is collapsible, INITIALLY CLOSED, expand independently
  // (multiple can be open at once — not strict accordion).  We persist
  // the open-set in localStorage so a refresh / new tab remembers what
  // mam had open, but the default for a fresh user is everything closed.
  const [openGroups, setOpenGroups] = useState(() => {
    try {
      const raw = localStorage.getItem('sidebar_open_groups');
      if (raw) return new Set(JSON.parse(raw));
    } catch (e) { /* ignore parse errors — fall through */ }
    return new Set();
  });
  const toggleGroup = (id) => setOpenGroups(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    try { localStorage.setItem('sidebar_open_groups', JSON.stringify([...next])); } catch (e) {}
    return next;
  });
  // Auto-open the group whose child route is currently active so a
  // refresh on /cashflow shows Finance expanded with the active item
  // highlighted — much less jarring than always starting closed when
  // the user lands on a deep route.
  useEffect(() => {
    const path = location.pathname;
    for (const g of SIDEBAR_GROUPS) {
      if (g.items.some(it => it.path === path)) {
        setOpenGroups(prev => {
          if (prev.has(g.id)) return prev;
          const next = new Set(prev);
          next.add(g.id);
          try { localStorage.setItem('sidebar_open_groups', JSON.stringify([...next])); } catch (e) {}
          return next;
        });
        break;
      }
    }
    // Same for Settings — if user lands on /admin/users etc.
    if (SIDEBAR_SETTINGS.items.some(it => it.path === location.pathname)) {
      setOpenGroups(prev => {
        if (prev.has(SIDEBAR_SETTINGS.id)) return prev;
        const next = new Set(prev);
        next.add(SIDEBAR_SETTINGS.id);
        try { localStorage.setItem('sidebar_open_groups', JSON.stringify([...next])); } catch (e) {}
        return next;
      });
    }
  }, [location.pathname]);

  // Visibility (mam 2026-05-30: "when i create new module it shows to
  // everyone"). A new module is now HIDDEN by default until it's granted
  // in Roles & Permissions. An item is visible only if:
  //   • it's explicitly flagged `open: true` (the few features open to all
  //     staff — Help Tickets, Onboarding, Training, RFQ Queue), OR
  //   • the role can view its `module` (admin passes everything via canView).
  // An item with no `open` flag and no/unknown module is hidden for
  // non-admins — so forgetting to wire a permission key no longer leaks it.
  const itemVisible = (item) => item.open === true || canView(item.module);
  // A group renders only if (a) it has at least one visible item AND
  // matches the current search (or search is empty), and (b) the user
  // passes any adminOnly gate. Hidden helper items (the 2 legacy CMD
  // routes folded into Executive) don't count.
  const groupVisible = (g) => {
    if (g.adminOnly && !isAdmin()) return false;
    return g.items.some(it => !it.hidden && itemVisible(it) && itemMatches(it));
  };
  const visibleGroups = SIDEBAR_GROUPS.filter(groupVisible);
  const showSettings = groupVisible(SIDEBAR_SETTINGS);
  // While searching, every visible group is force-open so matches are
  // immediately reachable without an extra click on each group header.
  const isGroupOpen = (id) => navQuery ? true : openGroups.has(id);
  const dashboardMatches = itemMatches(SIDEBAR_DASHBOARD);
  const nothingMatches = navQuery && !dashboardMatches && visibleGroups.length === 0 && !showSettings;

  // ─── Header breadcrumb (mam 2026-06-17 header freeze) ───────────────
  // Resolve the current route to { group, label } so the top bar reads
  // "Finance › Cash Flow" instead of a context-free "Cash Flow".
  // Dashboard is standalone (no group); unknown routes fall back to the
  // app name with no crumb.
  const crumb = (() => {
    if (SIDEBAR_DASHBOARD.path === location.pathname) return { group: null, label: SIDEBAR_DASHBOARD.label };
    for (const g of SIDEBAR_GROUPS) {
      const it = g.items.find(m => m.path === location.pathname);
      if (it) return { group: g.label, label: it.label };
    }
    const s = SIDEBAR_SETTINGS.items.find(m => m.path === location.pathname);
    if (s) return { group: SIDEBAR_SETTINGS.label, label: s.label };
    return { group: null, label: 'Headmasters' };
  })();

  // Avatar initials from the user's name (fallback to username), max 2 chars.
  const initials = (user?.name || user?.username || '?')
    .split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';

  return (
    <CallProvider>
    <div className="flex h-screen overflow-hidden">
      {/* Mobile overlay */}
      {sidebarOpen && isMobile && (
        <div className="fixed inset-0 bg-black/60 z-30" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      {/* Sidebar — royal blue brand.  Second pass deepened from
          blue-800→blue-900 to blue-900→blue-950 to match the
          saturated tone in mam's reference image (2026-05-20). */}
      {/* Sidebar — width drops to 0 on desktop when collapsed so the
          main content reclaims the 256px (mam 2026-05-28: "if i hide
          slide bar then i think it should be expend dynamically").
          Mobile still uses translate-x-full so the sidebar slides
          out as an overlay rather than squeezing the page. */}
      {/* transition-transform (not transition-all) — width changes
          on flex items don't reflow reliably when 'all' is being
          transitioned, so we let desktop's w-0 ↔ w-64 snap instantly
          and reserve the animation for mobile's slide-in. */}
      <aside
        className={`fixed md:relative z-40 h-full bg-gradient-to-b from-blue-900 to-blue-950 text-white flex flex-col transition-transform duration-300 flex-shrink-0 overflow-hidden min-w-0 ${
          isMobile
            ? `w-[80vw] max-w-[260px] ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`
            : (sidebarOpen ? 'w-64' : 'w-0')
        }`}
        style={isMobile ? { paddingTop: 'env(safe-area-inset-top)' } : undefined}
      >
        <div className="p-4 border-b border-white/10 flex justify-between items-center">
          <div>
            <div className="flex items-center gap-2">
              {/* Real SEPL logo (served from /salon-logo.svg). If the file
                  is missing, fall back to the 'SE' monogram so the header
                  never looks broken. */}
              <div className="w-9 h-9 bg-white rounded-lg flex items-center justify-center shadow-lg shadow-blue-900/40 overflow-hidden p-0.5">
                <img
                  src="/salon-logo.svg"
                  alt="Headmasters"
                  className="w-full h-full object-contain"
                  onError={(e) => {
                    if (!e.target.dataset.fallback) {
                      e.target.dataset.fallback = '1';
                      e.target.style.display = 'none';
                      const txt = e.target.parentElement.querySelector('span');
                      if (txt) txt.style.display = '';
                    }
                  }}
                />
                <span className="text-blue-700 font-extrabold text-xs" style={{ display: 'none' }}>SE</span>
              </div>
              <div>
                <h1 className="text-sm font-extrabold tracking-tight">Headmasters</h1>
                <p className="text-[9px] text-red-200 -mt-0.5">Salon & Spa</p>
              </div>
            </div>
          </div>
          {isMobile && <button className="p-1.5 hover:bg-white/10 rounded" onClick={() => setSidebarOpen(false)}><FiX size={18} /></button>}
        </div>
        {/* Sidebar search — mam 2026-05-28. Persistent across navigation
            (state lives in Layout) but cleared on tab close. Press
            Escape inside the box to clear quickly. */}
        <div className="px-2 pt-2">
          <div className="relative">
            <FiSearch size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-red-200/70 pointer-events-none" />
            <input
              type="search"
              value={navSearch}
              onChange={e => setNavSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setNavSearch(''); }}
              placeholder="Search menu… (e.g. attendance)"
              className="w-full bg-white/10 hover:bg-white/15 focus:bg-white/15 placeholder-red-200/60 text-white text-xs rounded-md pl-7 pr-4 py-1.5 outline-none focus:ring-1 focus:ring-white/30 transition"
              aria-label="Search sidebar menu"
            />
            {navSearch && (
              <button
                type="button"
                onClick={() => setNavSearch('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-red-200/70 hover:text-white"
                title="Clear search"
              ><FiX size={12} /></button>
            )}
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {/* Dashboard — always standalone at top, no group, single URL
              (mam's spec). Highlighted when on the home route. */}
          {(SIDEBAR_DASHBOARD.module == null || canView(SIDEBAR_DASHBOARD.module)) && dashboardMatches && (
            <Link to={SIDEBAR_DASHBOARD.path}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${location.pathname === SIDEBAR_DASHBOARD.path ? 'bg-white/15 text-white font-medium' : 'text-red-100 hover:bg-white/10 hover:text-white'}`}>
              <SIDEBAR_DASHBOARD.icon size={16} />
              <span className="truncate">{SIDEBAR_DASHBOARD.label}</span>
            </Link>
          )}

          {nothingMatches && (
            <div className="px-3 py-6 text-center text-[11px] text-red-200/70">
              No menu items match <span className="text-white font-semibold">"{navSearch}"</span>
            </div>
          )}

          {/* Collapsible accordion groups — initially closed, each opens
              independently. The chevron rotates to indicate state. */}
          {visibleGroups.map(g => {
            const isOpen = isGroupOpen(g.id);
            const childItems = g.items.filter(it => !it.hidden && itemVisible(it) && itemMatches(it));
            const hasActiveChild = childItems.some(it => location.pathname === it.path);
            return (
              <div key={g.id} className="pt-0.5">
                <button
                  type="button"
                  onClick={() => toggleGroup(g.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${hasActiveChild ? 'text-white font-semibold' : 'text-red-100 hover:bg-white/10 hover:text-white'}`}
                  title={`${isOpen ? 'Collapse' : 'Expand'} ${g.label}`}
                >
                  <g.icon size={16} />
                  <span className="truncate flex-1 text-left">{g.label}</span>
                  <FiChevronRight size={14} className={`transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                </button>
                {isOpen && (
                  <div className="ml-2 mt-0.5 mb-1 pl-3 border-l border-white/15 space-y-0.5">
                    {childItems.map(item => (
                      <Link key={item.path} to={item.path}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors ${location.pathname === item.path ? 'bg-white/15 text-white font-medium' : 'text-red-100 hover:bg-white/10 hover:text-white'}`}>
                        <item.icon size={14} />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {/* Settings group — pinned to the very bottom of the nav per
              mam's spec.  Same collapsible accordion as the others. */}
          {showSettings && (() => {
            const isOpen = isGroupOpen(SIDEBAR_SETTINGS.id);
            const childItems = SIDEBAR_SETTINGS.items.filter(it => itemVisible(it) && itemMatches(it));
            const hasActiveChild = childItems.some(it => location.pathname === it.path);
            return (
              <div className="pt-3 mt-2 border-t border-white/10">
                <button
                  type="button"
                  onClick={() => toggleGroup(SIDEBAR_SETTINGS.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${hasActiveChild ? 'text-white font-semibold' : 'text-red-100 hover:bg-white/10 hover:text-white'}`}
                  title={`${isOpen ? 'Collapse' : 'Expand'} Settings`}
                >
                  <SIDEBAR_SETTINGS.icon size={16} />
                  <span className="truncate flex-1 text-left">{SIDEBAR_SETTINGS.label}</span>
                  <FiChevronRight size={14} className={`transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                </button>
                {isOpen && (
                  <div className="ml-2 mt-0.5 mb-1 pl-3 border-l border-white/15 space-y-0.5">
                    {childItems.map(item => (
                      <Link key={item.path} to={item.path}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors ${location.pathname === item.path ? 'bg-white/15 text-white font-medium' : 'text-red-100 hover:bg-white/10 hover:text-white'}`}>
                        <item.icon size={14} />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
        </nav>
        {/* WhatsApp — pinned just above the user footer / Change Password
            (mam 2026-06-19: "show above where is change password"). Shown to
            EVERY signed-in user (no site_chat permission needed) — access is
            by group membership, so added people can chat by default. */}
        <div className="px-3 py-2 border-t border-white/10">
          <Link to="/site-chat"
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${location.pathname === '/site-chat' ? 'bg-white/15 text-white font-medium' : 'text-red-100 hover:bg-white/10 hover:text-white'}`}>
            <BiMessageRoundedCheck size={17} className="text-white" />
            <span className="truncate flex-1">Salon Chat</span>
            {waUnread > 0 && <span className="text-[10px] font-bold text-white bg-[#2563eb] rounded-full px-1.5 min-w-[18px] text-center">{waUnread > 99 ? '99+' : waUnread}</span>}
          </Link>
        </div>
        <div className="p-3 border-t border-white/10">
          <div className="flex items-center gap-2.5 mb-1">
            {user?.avatar_url ? (
              <img src={user.avatar_url} alt="" className="w-10 h-10 rounded-full object-cover flex-shrink-0 border border-white/30" />
            ) : (
              <span className="w-10 h-10 rounded-full bg-white/20 text-white text-sm font-bold flex items-center justify-center flex-shrink-0">{initials}</span>
            )}
            <div className="min-w-0">
              <div className="text-sm text-red-50 truncate">{user?.name}</div>
              {user?.username && <div className="text-[10px] text-red-200 font-mono truncate">@{user.username}</div>}
            </div>
          </div>
          <div className="text-[10px] text-red-300 mb-1">{user?.email}</div>
          <div className="flex flex-wrap gap-1 mb-2">
            {userRoles.map((r, i) => (
              <span key={i} className="text-[9px] bg-white/20 text-white px-1.5 py-0.5 rounded">{r}</span>
            ))}
          </div>
          <button onClick={() => setPwdModal(true)} className="flex items-center gap-2 px-3 py-1.5 text-sm text-red-100 hover:text-white hover:bg-white/10 rounded w-full mb-1">
            <FiKey size={14} /> <span>Change Password</span>
          </button>
          <button onClick={logout} className="flex items-center gap-2 px-3 py-1.5 text-sm text-yellow-200 hover:text-white hover:bg-white/10 rounded w-full">
            <FiLogOut size={15} /> <span>Logout</span>
          </button>
        </div>
      </aside>

      {/* Change Password Modal */}
      <Modal isOpen={pwdModal} onClose={() => setPwdModal(false)} title="Change Password">
        <form onSubmit={changePassword} className="space-y-4">
          <div>
            <label className="label">Current Password</label>
            <input className="input" type="password" autoComplete="current-password" value={pwdForm.current_password} onChange={e => setPwdForm({ ...pwdForm, current_password: e.target.value })} required />
          </div>
          <div>
            <label className="label">New Password</label>
            <input className="input" type="password" autoComplete="new-password" value={pwdForm.new_password} onChange={e => setPwdForm({ ...pwdForm, new_password: e.target.value })} required minLength={4} />
          </div>
          <div>
            <label className="label">Confirm New Password</label>
            <input className="input" type="password" autoComplete="new-password" value={pwdForm.confirm} onChange={e => setPwdForm({ ...pwdForm, confirm: e.target.value })} required />
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setPwdModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={pwdSaving} className="btn btn-primary">{pwdSaving ? 'Saving...' : 'Change Password'}</button>
          </div>
        </form>
      </Modal>

      {/* Floating "expand sidebar" tab — only when sidebar is collapsed
          on desktop. Mam: 'if I hide sidebar then show expand'. Sticky
          to the left edge so it's impossible to miss. */}
      {!sidebarOpen && !isMobile && (
        <button
          onClick={() => setSidebarOpen(true)}
          className="fixed left-0 top-1/2 -translate-y-1/2 z-30 bg-blue-800 hover:bg-blue-700 text-white pl-1.5 pr-2.5 py-3 rounded-r-lg shadow-lg shadow-blue-900/40 flex items-center gap-1 transition-all hover:pl-2.5 group"
          title="Expand sidebar"
        >
          <FiChevronRight size={18} />
          <span className="text-[10px] font-bold uppercase tracking-wider hidden group-hover:inline">Menu</span>
        </button>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden w-full">
        {/* Mam (2026-06-02): "in iphone when i open it as app above click
            slidebar open difficulties".  iOS PWA renders edge-to-edge
            and apple-mobile-web-app-status-bar-style='black-translucent'
            (in index.html) overlays the status bar + Dynamic Island on
            top of the web view — burying the hamburger button at top-
            left.  Fix: pad the header by env(safe-area-inset-top) so
            the buttons sit BELOW the status bar / Dynamic Island.  The
            CSS min() keeps a sane minimum 10px on devices without an
            inset. */}
        <header
          className="bg-white shadow-sm border-b border-gray-200 px-3 md:px-6 pb-2.5 flex items-center gap-2"
          style={{ paddingTop: 'max(0.625rem, env(safe-area-inset-top))' }}
        >
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-2 hover:bg-gray-100 rounded-lg flex-shrink-0 text-gray-700"
            title={sidebarOpen ? 'Hide sidebar' : (isMobile ? 'Menu' : 'Expand sidebar')}
            aria-label={sidebarOpen ? 'Hide sidebar' : (isMobile ? 'Open menu' : 'Expand sidebar')}
          >
            {/* On mobile the collapsed state must read as a real hamburger (☰) so
                users on the full-screen chat recognise it as the way back to the
                menu / home. Desktop keeps the chevron, which pairs with the
                floating "Menu" tab shown when the sidebar is collapsed. */}
            {sidebarOpen ? <FiMenu size={20} /> : (isMobile ? <FiMenu size={20} /> : <FiChevronRight size={20} />)}
          </button>
          {/* Brand mark — only when the sidebar is collapsed on desktop, so
              the header never loses the SEPL logo (mam 2026-06-17). Mirrors
              the sidebar logo, with the same broken-image fallback. */}
          {!sidebarOpen && !isMobile && (
            <div className="flex items-center gap-2 flex-shrink-0 pr-1">
              <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center ring-1 ring-gray-200 overflow-hidden p-0.5">
                <img
                  src="/salon-logo.svg"
                  alt="Headmasters"
                  className="w-full h-full object-contain"
                  onError={(e) => {
                    if (!e.target.dataset.fallback) {
                      e.target.dataset.fallback = '1';
                      e.target.style.display = 'none';
                      const txt = e.target.parentElement.querySelector('span');
                      if (txt) txt.style.display = '';
                    }
                  }}
                />
                <span className="text-blue-700 font-extrabold text-xs" style={{ display: 'none' }}>SE</span>
              </div>
            </div>
          )}
          {/* Breadcrumb title — "Group › Page" so the current location has
              context across the 64-item app (mam 2026-06-17). */}
          <div className="flex-1 min-w-0">
            {crumb.group && (
              <div className="text-[11px] font-medium text-gray-400 leading-none truncate hidden sm:block">
                {crumb.group}
              </div>
            )}
            <h2 className="text-sm md:text-lg font-semibold text-gray-800 truncate leading-tight">
              {crumb.label}
            </h2>
          </div>
          {/* Push notification toggle — phone / laptop / desktop each
              need to be enabled separately. Mam's MD requirement. */}
          <EnablePushButton />
          {/* Mam (2026-05-22): unified inbox bell.  Shows BOTH HR
              notifications (interview reminders / offer expiries /
              pending approvals) AND company announcements as two
              tabs inside a single dropdown — replaces the previous
              "3 separate bells" layout that confused users. */}
          <AnnouncementBell />
          {/* User avatar menu (mam 2026-06-17 header freeze) — identity +
              Change Password + Logout always reachable from the top bar,
              even when the sidebar is collapsed. */}
          <div className="relative flex-shrink-0">
            <button
              onClick={() => setUserMenu(o => !o)}
              className="flex items-center gap-2 p-1 pr-1.5 md:pr-2 rounded-lg hover:bg-gray-100"
              title={user?.name || 'Account'}
              aria-label="Account menu"
              aria-haspopup="true"
              aria-expanded={userMenu}
            >
              {user?.avatar_url ? (
                <img src={user.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover flex-shrink-0 border border-gray-200" />
              ) : (
                <span className="w-8 h-8 rounded-full bg-blue-900 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">
                  {initials}
                </span>
              )}
              <span className="hidden md:block max-w-[120px] truncate text-sm font-medium text-gray-700">{user?.name}</span>
              <FiChevronDown size={14} className={`hidden md:block text-gray-400 transition-transform ${userMenu ? 'rotate-180' : ''}`} />
            </button>
            {userMenu && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setUserMenu(false)} />
                <div className="absolute right-0 mt-1 w-60 bg-white border border-gray-200 rounded-lg shadow-lg z-40 overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-100">
                    <div className="text-sm font-semibold text-gray-800 truncate">{user?.name}</div>
                    {user?.username && <div className="text-[11px] text-gray-500 font-mono truncate">@{user.username}</div>}
                    {user?.email && <div className="text-[11px] text-gray-400 truncate">{user.email}</div>}
                    {userRoles.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {userRoles.map((r, i) => (
                          <span key={i} className="text-[9px] bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded">{r}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => { setUserMenu(false); setPwdModal(true); }}
                    className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <FiKey size={15} /> Change Password
                  </button>
                  <button
                    onClick={logout}
                    className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 border-t border-gray-100"
                  >
                    <FiLogOut size={15} /> Logout
                  </button>
                  {/* Build stamp moved here (mam 2026-06-17) — kept for PWA
                      cache verification but no longer cluttering the header
                      in front of management. */}
                  <div className="px-4 py-1.5 text-[9px] font-mono text-gray-300 border-t border-gray-100 bg-gray-50">
                    build v{typeof __BUILD_STAMP__ !== 'undefined' ? __BUILD_STAMP__ : 'dev'}
                  </div>
                </div>
              </>
            )}
          </div>
        </header>
        {/* iOS home-indicator padding so content doesn't hide behind the
            bottom safe-area on iPhone X+ (mam 2026-06-02). */}
        <main
          className="flex-1 overflow-y-auto p-2 md:p-6 bg-slate-50"
          style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
        >
          <Outlet />
          {/* Sotyn.Headmasters credit — shown at the bottom of every page (mam 2026-06-19). */}
          <div className="p-footer mt-6 pt-3 border-t border-slate-200 text-center select-none">
            <p className="text-[9px] uppercase tracking-[0.3em] text-slate-400">Powered by</p>
            <p className="text-sm font-extrabold tracking-wide bg-gradient-to-r from-blue-700 via-blue-500 to-blue-700 bg-clip-text text-transparent">Sotyn</p>
          </div>
        </main>
      </div>
      {/* Floating "?" help-ticket bubble removed (mam 2026-06-19) — Help
          Tickets is still reachable from the sidebar page. */}
      <AIAgentChat />
    </div>
    </CallProvider>
  );
}
