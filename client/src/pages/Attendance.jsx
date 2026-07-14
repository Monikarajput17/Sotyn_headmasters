import { useState, useEffect, useRef, useCallback } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiClock, FiMapPin, FiCamera, FiUsers, FiCalendar, FiCheckCircle, FiXCircle, FiPlus, FiAlertTriangle, FiTrash2, FiEdit2, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import TimePicker from '../components/TimePicker';

// Render a stored UTC ISO timestamp as IST time (hh:mm AM/PM). Always pins to
// Asia/Kolkata so a punch shows the correct Indian time even when the viewing
// device's clock isn't set to IST, and returns '—' for rows with no real punch
// (e.g. admin-marked present days) instead of a bogus 1970 "5:30 AM".
// (mam: "attendance punch but not showing timing")
const fmtT = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
  } catch { return '—'; }
};

export default function Attendance() {
  const { user, isAdmin, canDelete, canSeeAll } = useAuth();
  // Admins, or anyone granted "See All" on the attendance module, can view
  // everyone's attendance (mam 2026-06-15: "show all attendance if I give some
  // permission to see all"). Write tools (Grid / Geofence) stay admin-only.
  const seeAll = isAdmin() || canSeeAll('attendance');
  const [tab, setTab] = useUrlTab('punch');
  const [myToday, setMyToday] = useState(null);
  // Mam: daily attendance detail (in/out times + leave) belongs on the
  // Attendance page next to the punch UI, not on the dashboard.
  const [myMonth, setMyMonth] = useState(null);
  // Mam: 'edit option' on leaves table — fixes typos / wrong dates /
  // floating-point hours like 1.3500000000000014.
  const [editingLeave, setEditingLeave] = useState(null);
  const [leaveEditForm, setLeaveEditForm] = useState({});
  const [dashboard, setDashboard] = useState(null);
  const [records, setRecords] = useState([]);
  const [report, setReport] = useState([]);
  const [leaves, setLeaves] = useState([]);
  const [geofences, setGeofences] = useState([]);
  // True only after a SUCCESSFUL geofence fetch — so a failed fetch (transient
  // server blip) never gets mistaken for "no sites configured" (mam 2026-07-01:
  // "No site locations configured" showing in the office).
  const [geofencesLoaded, setGeofencesLoaded] = useState(false);
  // "By User" tab state
  const [allUsers, setAllUsers] = useState([]);
  const [userSearch, setUserSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [userRecords, setUserRecords] = useState([]);
  const today = new Date().toISOString().split('T')[0];
  const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
  const [userDateFrom, setUserDateFrom] = useState(firstOfMonth);
  const [userDateTo, setUserDateTo] = useState(today);
  // "My History" tab — every employee can review their OWN past attendance
  // over a start→end date range (mam 2026-06-12).
  const [myHistFrom, setMyHistFrom] = useState(firstOfMonth);
  const [myHistTo, setMyHistTo] = useState(today);
  const [myHistory, setMyHistory] = useState([]);
  // Monthly Attendance Grid (mam 2026-06-13) — mark present/absent/half/leave
  // for everyone in one screen so no-punch days don't drag payroll to absent.
  const monthNow = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const [gridMonth, setGridMonth] = useState(monthNow());
  const [grid, setGrid] = useState(null);
  const [gridBusy, setGridBusy] = useState(false);
  const [location, setLocation] = useState(null);
  const [address, setAddress] = useState('');
  const [photo, setPhoto] = useState(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(null);
  // Click any attendance selfie thumbnail to open it enlarged. Holds
  // { src, label } of the photo being viewed, or null when closed.
  const [lightbox, setLightbox] = useState(null);
  const [form, setForm] = useState({});
  const [filterDate, setFilterDate] = useState(new Date().toISOString().split('T')[0]);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  const load = useCallback(() => {
    api.get('/attendance/my-today').then(r => setMyToday(r.data)).catch(() => {});
    // Pull current-month detail (per-day in/out + leaves) for the
    // Daily Detail timeline below the punch UI.
    api.get('/attendance/my-month').then(r => setMyMonth(r.data)).catch(() => {});
    // Everyone needs geofence list to see auto-punch status live. It MUST
    // survive a transient server blip (the VPS OOM-restarts): a single failed
    // GET otherwise blanks the list and falsely shows "No site locations
    // configured" even while standing in the office. Retry a few times, and
    // only mark it loaded on a real success so the warning can't fire on a
    // failed fetch (mam 2026-07-01).
    (function loadGeofences(tries) {
      api.get('/attendance/geofence')
        .then(r => { setGeofences(r.data || []); setGeofencesLoaded(true); })
        .catch(() => { if (tries > 1) setTimeout(() => loadGeofences(tries - 1), 2000); });
    })(4);
    if (seeAll) {
      api.get('/attendance/dashboard').then(r => setDashboard(r.data)).catch(() => {});
      api.get(`/attendance?date=${filterDate}`).then(r => setRecords(r.data)).catch(() => {});
      api.get('/attendance/leaves').then(r => setLeaves(r.data)).catch(() => {});
      api.get('/auth/users').then(r => setAllUsers((r.data || []).filter(u => u.active !== 0))).catch(() => {});
      const m = new Date().getMonth() + 1, y = new Date().getFullYear();
      api.get(`/attendance/report?month=${m}&year=${y}`).then(r => setReport(r.data)).catch(() => {});
    }
  }, [filterDate]);

  // Load per-user records when the By User tab filters change
  useEffect(() => {
    if (!seeAll || tab !== 'byuser' || !selectedUserId) { setUserRecords([]); return; }
    api.get(`/attendance?user_id=${selectedUserId}&date_from=${userDateFrom}&date_to=${userDateTo}`)
      .then(r => setUserRecords(r.data))
      .catch(() => setUserRecords([]));
  }, [tab, selectedUserId, userDateFrom, userDateTo, isAdmin]);

  // Load the logged-in user's own attendance when the My History tab /
  // its date range changes. Self-service — works for every employee.
  useEffect(() => {
    if (tab !== 'myhistory') return;
    api.get(`/attendance/my-history?from=${myHistFrom}&to=${myHistTo}`)
      .then(r => setMyHistory(r.data || []))
      .catch(() => setMyHistory([]));
  }, [tab, myHistFrom, myHistTo]);

  useEffect(() => { load(); }, [load]);

  // Location tracking + live geofence status.
  // Pings server every 30 sec so backend auto-punch (5-min rolling window)
  // triggers as soon as the user has been inside/outside long enough.
  // Stops once the day's attendance is closed (punched out).
  useEffect(() => {
    if (myToday?.punch_out_time) return; // day is done
    const trackLocation = () => {
      // Always refresh today's status FIRST, independent of GPS — so a punch made
      // on ANOTHER device (e.g. laptop) shows on this phone even when its GPS is
      // off/flaky (mam 2026-07-01: "even she marks from laptop, update here"). The
      // old code only re-fetched inside the GPS success callback, so a phone that
      // couldn't get a fix never updated.
      api.get('/attendance/my-today').then(r => setMyToday(r.data)).catch(() => {});
      // Even if the browser has no geolocation API, still send a
      // heartbeat so admin sees "online but GPS unavailable" instead of
      // mistaking the user for absent / off-network.
      if (!navigator.geolocation) {
        api.post('/attendance/track-location', { gps_off: true, reason: 'no-geolocation-api' }).catch(() => {});
        return;
      }
      navigator.geolocation.getCurrentPosition(pos => {
        const loc = { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy || 0 };
        setLocation(loc);
        api.post('/attendance/track-location', { ...loc, address: '' }).catch(() => {});
      }, (err) => {
        // GPS off / permission denied / timeout — send a "GPS OFF"
        // heartbeat so the admin Location Tracking page can surface
        // them in red. Mam: 'can show me here like some off GPS even
        // network is good'.
        const reasonMap = { 1: 'permission-denied', 2: 'position-unavailable', 3: 'timeout' };
        api.post('/attendance/track-location', { gps_off: true, reason: reasonMap[err?.code] || 'unknown-error' }).catch(() => {});
      }, { enableHighAccuracy: true, timeout: 15000 });
    };
    trackLocation(); // fire immediately
    const interval = setInterval(trackLocation, 30 * 1000); // every 30 sec
    return () => clearInterval(interval);
  }, [myToday?.punch_out_time]);

  // Refresh today's punch status whenever the tab is (re)focused — so a punch made
  // on another device (laptop) appears here immediately, no manual reload needed
  // (mam 2026-07-01). Independent of GPS and runs even after punch-out.
  useEffect(() => {
    const refresh = () => { if (!document.hidden) api.get('/attendance/my-today').then(r => setMyToday(r.data)).catch(() => {}); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);

  // Client-side geofence detection (haversine) — purely for live status display
  const haversineMeters = (lat1, lon1, lat2, lon2) => {
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };
  // Mirror the server's uncertainty-honest rule (server/lib/geofence.js) so the
  // live status pill matches EXACTLY what Punch In / Out will do. Three states:
  //   inside  — GPS uncertainty overlaps a site (green; punches normally)
  //   weak    — fix too coarse to confirm (amber; CAN still punch, gets flagged)
  //   outside — precise lock, confidently away (red; will be blocked)
  const geoStatus = (() => {
    if (!location) return { state: 'locating' };
    const active = (geofences || []).filter(g => g.active !== 0);
    // Only claim "no sites" once we've actually loaded an empty list from the
    // server. Before that (still loading, or the fetch failed on an OOM blip)
    // stay in 'locating' so we never falsely tell on-site staff there are no
    // geofences (mam 2026-07-01).
    if (active.length === 0) return { state: geofencesLoaded ? 'no_sites' : 'locating' };
    const accRaw = +location.accuracy || 0;
    const acc = Math.min(Math.max(accRaw, 50), 3000);   // floor 50 / ceiling 3000 — matches server
    let nearest = { d: Infinity, g: null }, matched = null;
    for (const g of active) {
      const d = haversineMeters(location.latitude, location.longitude, g.latitude, g.longitude);
      if (d < nearest.d) nearest = { d, g };
      if (!matched && d - acc <= (g.radius_meters || 200)) matched = g;
    }
    const goodFix = accRaw > 0 && accRaw <= 200;   // a real GPS lock — matches server trust threshold
    if (matched) return { state: 'inside', site: matched, dist: Math.round(haversineMeters(location.latitude, location.longitude, matched.latitude, matched.longitude)), acc: Math.round(accRaw) };
    if (!goodFix) return { state: 'weak', site: nearest.g, dist: Math.round(nearest.d), acc: Math.round(accRaw) };
    return { state: 'outside', site: nearest.g, dist: Math.round(nearest.d), acc: Math.round(accRaw) };
  })();

  // Acquire the BEST GPS fix available within a short window. Phones routinely
  // return a coarse network fix first (±500–2000m) and only refine to a real
  // GPS lock (±5–20m) a few seconds later — taking that FIRST fix is exactly
  // why on-site staff were shown "outside / out of area". We watch for up to
  // ~9s, keep the most accurate reading, and resolve early once we get a good
  // (≤40m) lock. Always cleans up the watch + timer so it can't leak.
  const getBestPosition = ({ maxWaitMs = 15000, goodAccuracy = 40 } = {}) => {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject('GPS not supported on this device');
      let best = null, watchId = null, settled = false, timer = null;
      const finish = (err) => {
        if (settled) return; settled = true;
        if (watchId != null) { try { navigator.geolocation.clearWatch(watchId); } catch { /* noop */ } }
        if (timer) clearTimeout(timer);
        if (best) resolve(best);
        else reject(err || 'Could not get your location. Please enable precise location and try again.');
      };
      const onPos = (pos) => {
        const f = { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy || 0 };
        if (!best || (f.accuracy && f.accuracy < best.accuracy)) best = f;
        setLocation(best);              // live-update the status pill as accuracy improves
        if (best.accuracy && best.accuracy <= goodAccuracy) finish(); // good enough — stop early
      };
      timer = setTimeout(() => finish(), maxWaitMs);
      try {
        watchId = navigator.geolocation.watchPosition(
          onPos,
          (e) => { if (!best) finish('Please enable GPS: ' + e.message); }, // only fail if we got NOTHING
          { enableHighAccuracy: true, timeout: maxWaitMs, maximumAge: 0 }
        );
      } catch (e) { finish('GPS error: ' + (e.message || e)); }
    });
  };

  // Back-compat wrapper used by Punch In/Out and "Use My Current Location".
  const getLocation = () => getBestPosition().then(loc => {
    setAddress(`${loc.latitude.toFixed(6)}, ${loc.longitude.toFixed(6)}`);
    return loc;
  });

  // Camera functions
  const openCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 240 } });
      streamRef.current = stream;
      setCameraOpen(true);
      setTimeout(() => { if (videoRef.current) videoRef.current.srcObject = stream; }, 100);
    } catch { toast.error('Camera not available. Please allow camera access.'); }
  };

  const capturePhoto = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = 320; canvas.height = 240;
    canvas.getContext('2d').drawImage(videoRef.current, 0, 0, 320, 240);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
    setPhoto(dataUrl);
    stopCamera();
  };

  const stopCamera = () => {
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    setCameraOpen(false);
  };

  // Punch In
  const handlePunchIn = async () => {
    if (!photo) return toast.error('Please take a selfie first');
    setLoading(true);
    try {
      const loc = await getLocation();
      const res = await api.post('/attendance/punch-in', { ...loc, address, photo, site_name: '' });
      toast.success(res.data.message);
      setPhoto(null); load();
    } catch (err) { toast.error(typeof err === 'string' ? err : err.response?.data?.error || 'Failed'); }
    setLoading(false);
  };

  // Punch Out
  const handlePunchOut = async () => {
    if (!photo) return toast.error('Please take a selfie first');
    setLoading(true);
    try {
      const loc = await getLocation();
      const res = await api.post('/attendance/punch-out', { ...loc, address, photo });
      toast.success(res.data.message);
      setPhoto(null); load();
    } catch (err) { toast.error(typeof err === 'string' ? err : err.response?.data?.error || 'Failed'); }
    setLoading(false);
  };

  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const dateStr = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // ── Monthly Attendance Grid helpers ──────────────────────────────
  const loadGrid = useCallback(() => {
    if (!isAdmin()) return;
    api.get(`/attendance/grid?month=${gridMonth}`).then(r => setGrid(r.data)).catch(() => setGrid(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridMonth]);
  useEffect(() => { if (tab === 'grid') loadGrid(); }, [tab, gridMonth, loadGrid]);

  const cellMeta = (c) => {
    const s = c?.status || '';
    if (s === 'present') return { t: 'P', cls: 'bg-emerald-100 text-emerald-700' };
    if (s === 'late') return { t: 'L', cls: 'bg-amber-100 text-amber-700' };
    if (s === 'half_day') return { t: '½', cls: 'bg-orange-100 text-orange-700' };
    if (s === 'short_day') return { t: 'S', cls: 'bg-orange-100 text-orange-700' };
    if (s === 'leave') return { t: 'CL', cls: 'bg-purple-100 text-purple-700' };
    if (s === 'sunday') return { t: '–', cls: 'bg-gray-50 text-gray-300' };
    if (s === 'absent') return { t: 'A', cls: 'bg-red-50 text-red-600' };
    return { t: '·', cls: 'bg-white text-gray-300' };
  };
  // Export the month's grid to a spreadsheet to share with a hiring manager
  // (mam 2026-07-02). Same P/A/½/CL/L letters as on screen + per-person totals.
  const exportGrid = () => {
    if (!grid || !grid.employees?.length) return;
    const headers = ['Employee', ...grid.days.map(d => String(d.d)), 'Present', 'Absent', 'Half', 'Leave', 'Late'];
    const rows = grid.employees.map(emp => {
      let p = 0, a = 0, h = 0, cl = 0, late = 0;
      const cells = grid.days.map(day => {
        if (day.future) return '';
        const s = (emp.cells[day.date] || {}).status || '';
        if (s === 'present') p++;
        else if (s === 'absent') a++;
        else if (s === 'half_day' || s === 'short_day') h++;
        else if (s === 'leave') cl++;
        else if (s === 'late') late++;
        const t = cellMeta({ status: s }).t;
        return (t === '·' || t === '–') ? '' : t;
      });
      return [emp.name, ...cells, p, a, h, cl, late];
    });
    exportCsv(`monthly-attendance-${gridMonth}`, headers, rows);
    toast.success('Monthly grid exported — open the file in Excel to print or send.');
  };
  const markCell = async (emp, date, status) => {
    if (!emp.user_id) return;
    setGridBusy(true);
    try { await api.post('/attendance/admin-mark', { user_id: emp.user_id, date, status }); loadGrid(); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
    finally { setGridBusy(false); }
  };
  // Click cycles: blank/absent → Present → Absent → Half → Leave → (clear).
  // Real punches and approved leaves are read-only here.
  const onCellClick = (emp, day, c) => {
    if (!emp.user_id || day.future) return;
    if (c.source === 'punch') { toast('Real punch — edit it under Records'); return; }
    if (c.source === 'leave') { toast('Approved leave — manage it under Leaves'); return; }
    const order = ['present', 'absent', 'half_day', 'leave', 'clear'];
    const next = c.source === 'admin' ? order[(order.indexOf(c.status) + 1) % order.length] : 'present';
    markCell(emp, day.date, next);
  };
  const markAllPresent = async (emp) => {
    if (!emp.user_id) return;
    if (!confirm(`Mark ${emp.name} PRESENT on every blank working day in ${gridMonth}? (Sundays, real punches and leaves are left untouched.)`)) return;
    setGridBusy(true);
    try { const r = await api.post('/attendance/admin-mark-bulk', { user_id: emp.user_id, month: gridMonth, status: 'present' }); toast.success(r.data.message); loadGrid(); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
    finally { setGridBusy(false); }
  };
  const linkLogin = async (emp, userId) => {
    if (!userId) return;
    try { const r = await api.post('/attendance/link-login', { employee_id: emp.employee_id, user_id: +userId }); toast.success(r.data.message); loadGrid(); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setTab('punch')} className={`btn ${tab === 'punch' ? 'btn-primary' : 'btn-secondary'} text-sm`}>Punch In/Out</button>
        <button onClick={() => setTab('myhistory')} className={`btn ${tab === 'myhistory' ? 'btn-primary' : 'btn-secondary'} text-sm`}>My History</button>
        {seeAll && <>
          <button onClick={() => setTab('dashboard')} className={`btn ${tab === 'dashboard' ? 'btn-primary' : 'btn-secondary'} text-sm`}>Dashboard</button>
          <button onClick={() => setTab('records')} className={`btn ${tab === 'records' ? 'btn-primary' : 'btn-secondary'} text-sm`}>Records</button>
          <button onClick={() => setTab('byuser')} className={`btn ${tab === 'byuser' ? 'btn-primary' : 'btn-secondary'} text-sm`}>By User</button>
          <button onClick={() => setTab('report')} className={`btn ${tab === 'report' ? 'btn-primary' : 'btn-secondary'} text-sm`}>Monthly Report</button>
          <button onClick={() => setTab('leaves')} className={`btn ${tab === 'leaves' ? 'btn-primary' : 'btn-secondary'} text-sm`}>Leaves</button>
        </>}
        {isAdmin() && <>
          <button onClick={() => setTab('grid')} className={`btn ${tab === 'grid' ? 'btn-primary' : 'btn-secondary'} text-sm`}>Monthly Grid</button>
          <button onClick={() => setTab('geofence')} className={`btn ${tab === 'geofence' ? 'btn-primary' : 'btn-secondary'} text-sm`}>Geofence</button>
        </>}
      </div>

      {/* MONTHLY ATTENDANCE GRID TAB */}
      {tab === 'grid' && isAdmin() && (
        <div className="space-y-3">
          <div className="text-xs text-gray-600 bg-amber-50 border border-amber-100 rounded-lg px-4 py-2.5">
            A day with <b>no punch counts as absent</b> in payroll. Mark people here so salary is right.
            Click a cell to cycle <b>P</b>resent → <b>A</b>bsent → <b>½</b> half → <b>CL</b> leave → clear.
            Real punches and approved leaves are read-only. Use <b>“P all”</b> to fill a person’s blank working days as present.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input type="month" className="input text-sm" value={gridMonth} onChange={e => setGridMonth(e.target.value)} />
            <button onClick={loadGrid} className="btn btn-secondary text-sm">Refresh</button>
            <button onClick={exportGrid} disabled={!grid || !grid.employees?.length} className="btn btn-primary text-sm flex items-center gap-1" title="Download this month's grid as a spreadsheet to send / show the hiring manager">
              <FiDownload size={14} /> Export for Hiring Manager
            </button>
            <div className="flex items-center gap-2 text-[11px] text-gray-500 ml-auto">
              <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">P present</span>
              <span className="px-1.5 py-0.5 rounded bg-red-50 text-red-600">A absent</span>
              <span className="px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">½ half</span>
              <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">CL leave</span>
              <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">L late</span>
            </div>
          </div>
          {!grid ? (
            <div className="card p-8 text-center text-gray-400 text-sm">Loading…</div>
          ) : grid.employees.length === 0 ? (
            <div className="card p-8 text-center text-gray-400 text-sm">No active employees found.</div>
          ) : (
            <div className="card p-0 overflow-x-auto">
              <table className="text-xs border-collapse">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="sticky left-0 z-10 bg-gray-50 text-left px-3 py-2 font-semibold min-w-[160px]">Employee</th>
                    {grid.days.map(day => (
                      <th key={day.date} className={`px-0 py-2 text-center font-semibold w-7 ${day.sunday ? 'text-red-400' : 'text-gray-500'}`} title={day.date}>{day.d}</th>
                    ))}
                    <th className="px-2 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {grid.employees.map(emp => (
                    <tr key={emp.employee_id} className="border-t border-gray-100">
                      <td className="sticky left-0 z-10 bg-white px-3 py-1.5 font-medium text-gray-800 min-w-[160px]">
                        {emp.name}
                        {emp.no_login && (
                          <div className="mt-0.5 flex items-center gap-1">
                            <span className="text-[10px] bg-amber-200 text-amber-800 px-1 rounded">⚠ no login</span>
                            <select className="select text-[10px] py-0 h-6" defaultValue="" onChange={e => linkLogin(emp, e.target.value)} title="Link this employee to their login user">
                              <option value="" disabled>link…</option>
                              {emp.suggestions.map(s => <option key={s.user_id} value={s.user_id}>{s.name}</option>)}
                            </select>
                          </div>
                        )}
                      </td>
                      {grid.days.map(day => {
                        const c = emp.cells[day.date] || {};
                        const meta = cellMeta(c);
                        const ro = !emp.user_id || day.future || c.source === 'punch' || c.source === 'leave';
                        return (
                          <td key={day.date} className="p-0 text-center">
                            <button type="button" disabled={gridBusy || ro}
                              onClick={() => onCellClick(emp, day, c)}
                              title={`${day.date}${c.status ? ' · ' + c.status : ''}${c.source ? ' (' + c.source + ')' : ''}`}
                              className={`w-7 h-7 text-[10px] font-bold ${meta.cls} ${c.source === 'punch' ? 'ring-1 ring-inset ring-blue-200' : ''} ${ro ? 'cursor-default opacity-90' : 'hover:brightness-95'}`}>
                              {day.future ? '' : meta.t}
                            </button>
                          </td>
                        );
                      })}
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {emp.user_id
                          ? <button onClick={() => markAllPresent(emp)} disabled={gridBusy} className="btn btn-secondary text-[11px] py-0.5">P all</button>
                          : <span className="text-[10px] text-gray-300">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* PUNCH IN/OUT TAB */}
      {tab === 'punch' && (
        <div className="max-w-md mx-auto space-y-4">
          <div className="card text-center p-6">
            <FiClock size={40} className="mx-auto text-red-600 mb-2" />
            <h2 className="text-3xl font-bold">{timeStr}</h2>
            <p className="text-sm text-gray-500">{dateStr}</p>
            <p className="text-sm font-medium text-red-600 mt-1">{user?.name}</p>
          </div>

          {/* Status */}
          {myToday ? (
            <div className={`card p-4 ${myToday.punch_out_time ? 'bg-gray-50' : 'bg-emerald-50'}`}>
              <div className="flex justify-between items-center">
                <div>
                  <p className="text-sm font-bold text-emerald-700"><FiCheckCircle className="inline mr-1" /> Punched In: {fmtT(myToday.punch_in_time)}{myToday.auto_punched_in ? <span className="ml-1 text-[10px] bg-purple-100 text-purple-700 px-1 py-0.5 rounded">AUTO</span> : null}</p>
                  {myToday.punch_out_time && <p className="text-sm text-gray-600">Punched Out: {fmtT(myToday.punch_out_time)}{myToday.auto_punched_out ? <span className="ml-1 text-[10px] bg-purple-100 text-purple-700 px-1 py-0.5 rounded">AUTO</span> : null}</p>}
                  {myToday.total_hours > 0 && <p className="text-sm font-bold">Total: {myToday.total_hours} hours</p>}
                </div>
                <StatusBadge status={myToday.status} />
              </div>
              {myToday.punch_in_photo && <img src={myToday.punch_in_photo} alt="Punch In" className="mt-2 w-20 h-16 rounded object-cover" />}
            </div>
          ) : (
            <div className="card p-4 bg-amber-50 text-center"><p className="text-amber-700 font-medium"><FiAlertTriangle className="inline mr-1" /> Not punched in today</p></div>
          )}

          {/* Location status card — mirrors the server's geofence decision so the
              user sees exactly what Punch In/Out will do. A WEAK fix never blocks
              an on-site person; only a precise lock that's confidently away does. */}
          {(() => {
            const st = geoStatus.state;
            const tone = st === 'inside' ? 'emerald' : st === 'weak' ? 'amber' : st === 'outside' ? 'red' : 'gray';
            const border = { emerald: 'border-emerald-500 bg-emerald-50', amber: 'border-amber-500 bg-amber-50', red: 'border-red-500 bg-red-50', gray: 'border-gray-300 bg-gray-50' }[tone];
            const text = { emerald: 'text-emerald-700', amber: 'text-amber-700', red: 'text-red-700', gray: 'text-gray-600' }[tone];
            const iconCls = { emerald: 'text-emerald-600', amber: 'text-amber-600', red: 'text-red-600', gray: 'text-gray-400' }[tone];
            const headline =
              st === 'inside' ? `Inside ${geoStatus.site?.site_name || 'site'} (${geoStatus.dist} m)`
              : st === 'weak' ? `Weak GPS signal (±${geoStatus.acc} m)`
              : st === 'outside' ? `About ${geoStatus.dist} m from ${geoStatus.site?.site_name || 'nearest site'}`
              : st === 'no_sites' ? 'No site locations configured'
              : `Getting precise GPS…${location?.accuracy ? ` (±${Math.round(location.accuracy)} m)` : ''}`;
            return (
              <div className={`card p-4 border-l-4 ${border}`}>
                <div className="flex items-center gap-2 mb-1">
                  <FiMapPin size={16} className={iconCls} />
                  <span className={`font-bold text-sm ${text}`}>{headline}</span>
                </div>
                {!myToday && st === 'inside' && <p className="text-xs text-emerald-700">You're at the site — take a selfie and Punch In below.</p>}
                {!myToday && st === 'weak' && <p className="text-xs text-amber-700">Your phone can't get a precise GPS fix (common indoors). You can still Punch In — it's recorded and flagged for admin review. For a sharper fix, stand near a window or step outside for a moment.</p>}
                {!myToday && st === 'outside' && <p className="text-xs text-red-700">GPS places you away from every site. Move to your assigned site to punch in, or ask admin to mark you.</p>}
                {!myToday && st === 'locating' && <p className="text-xs text-gray-500">Hold on while we lock onto GPS for an accurate location…</p>}
                {!myToday && st === 'no_sites' && <p className="text-xs text-gray-500">Ask admin to add your office/site under Geofence before punching.</p>}
                {myToday && !myToday.punch_out_time && (
                  <p className="text-xs text-emerald-700">✓ Punched in at {fmtT(myToday.punch_in_time)}. Don't forget to Punch Out when your day is done.</p>
                )}
                {myToday?.punch_out_time && <p className="text-xs text-gray-600">Today's attendance completed.</p>}
              </div>
            );
          })()}

          {/* Camera + Manual Punch */}
          <div className="card p-4 space-y-3">
            <p className="text-[11px] text-gray-500 text-center">Take a selfie and punch in / out</p>
            {cameraOpen ? (
              <div className="text-center">
                <video ref={videoRef} autoPlay playsInline className="rounded-lg mx-auto w-full max-w-[320px]" />
                <canvas ref={canvasRef} className="hidden" />
                <div className="flex gap-2 mt-2 justify-center">
                  <button onClick={capturePhoto} className="btn btn-primary flex items-center gap-1"><FiCamera size={16} /> Capture</button>
                  <button onClick={stopCamera} className="btn btn-secondary">Cancel</button>
                </div>
              </div>
            ) : photo ? (
              <div className="text-center">
                <img src={photo} alt="Selfie" className="rounded-lg mx-auto w-40 h-32 object-cover" />
                <button onClick={() => { setPhoto(null); openCamera(); }} className="text-xs text-red-600 mt-1 underline">Retake</button>
              </div>
            ) : (
              <button onClick={openCamera} className="btn btn-secondary w-full flex items-center justify-center gap-2 py-3">
                <FiCamera size={18} /> Take Selfie
              </button>
            )}

            {location && <p className="text-xs text-gray-500 flex items-center gap-1"><FiMapPin size={12} /> {address || `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`}</p>}

            {/* Punch Buttons — "Manual" prefix dropped since auto-punch is
                disabled; these are now THE punch in/out actions. */}
            {!myToday ? (
              <button onClick={handlePunchIn} disabled={loading || !photo} className="btn btn-success w-full py-3 text-sm font-bold disabled:opacity-50">
                {loading ? 'Getting Location…' : 'PUNCH IN'}
              </button>
            ) : !myToday.punch_out_time ? (
              <button onClick={handlePunchOut} disabled={loading || !photo} className="btn btn-danger w-full py-3 text-sm font-bold disabled:opacity-50">
                {loading ? 'Getting Location…' : 'PUNCH OUT'}
              </button>
            ) : (
              <p className="text-center text-emerald-600 font-bold py-2">Today's attendance completed</p>
            )}
          </div>

          {/* Leave Request */}
          <button onClick={() => { setForm({ leave_type: 'casual', from_date: '', to_date: '', reason: '' }); setModal('leave'); }} className="btn btn-secondary w-full text-sm">Apply for Leave</button>

          {/* Daily Detail — last 15 working days with in/out times + any
              leave taken on that date. Mam: "where punch/punch out [...]
              add next to attendance details". */}
          {myMonth?.days?.length > 0 && (() => {
            const recent = myMonth.days
              .filter(d => d.status !== 'future' && d.status !== 'weekend')
              .slice(-15)
              .reverse();
            if (recent.length === 0) return null;
            const fmtTime = (iso) => {
              if (!iso) return '—';
              try {
                return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
              } catch { return '—'; }
            };
            const statusPill = {
              present: 'bg-emerald-100 text-emerald-700',
              late: 'bg-amber-100 text-amber-700',
              half_day: 'bg-amber-50 text-amber-700',
              short_day: 'bg-orange-100 text-orange-800',
              on_leave: 'bg-blue-100 text-blue-700',
              absent: 'bg-red-100 text-red-700',
            };
            return (
              <div className="card p-3">
                <h4 className="text-xs font-bold text-gray-500 uppercase mb-2">Attendance Detail (last 15 working days)</h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-gray-500 border-b">
                        <th className="py-1.5 pr-2 font-semibold">Date</th>
                        <th className="py-1.5 pr-2 font-semibold">In</th>
                        <th className="py-1.5 pr-2 font-semibold">Out</th>
                        <th className="py-1.5 pr-2 font-semibold text-right">Hrs</th>
                        <th className="py-1.5 pr-2 font-semibold">Status</th>
                        <th className="py-1.5 font-semibold">Leave (if any)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.map(d => (
                        <tr key={d.date} className="border-b border-gray-50 last:border-0">
                          <td className="py-1.5 pr-2 font-medium">{d.date}</td>
                          <td className="py-1.5 pr-2 text-emerald-700">{fmtTime(d.punch_in_time)}</td>
                          <td className="py-1.5 pr-2 text-red-700">{fmtTime(d.punch_out_time)}</td>
                          <td className="py-1.5 pr-2 text-right tabular-nums font-semibold">{d.total_hours ? d.total_hours.toFixed(2) : '—'}</td>
                          <td className="py-1.5 pr-2">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${statusPill[d.status] || 'bg-gray-100 text-gray-600'}`}>
                              {d.status?.replace('_', ' ')}
                            </span>
                          </td>
                          <td className="py-1.5">
                            {d.leave ? (
                              <span className="text-[10px] text-blue-700">
                                <span className="font-bold capitalize">{d.leave.leave_type.replace('_', ' ')}</span>
                                {(d.leave.leave_type === 'short_leave' || d.leave.leave_type === 'half_day') && d.leave.from_time && d.leave.to_time && (
                                  <span className="text-blue-600"> · {d.leave.from_time}–{d.leave.to_time}</span>
                                )}
                                {d.leave.hours > 0 && <span className="text-gray-500"> · {d.leave.hours} hr</span>}
                              </span>
                            ) : <span className="text-gray-300">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* ADMIN DASHBOARD */}
      {tab === 'dashboard' && dashboard && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="card p-3 border-l-4 border-red-500"><p className="text-xs text-gray-500">Total</p><p className="text-2xl font-bold">{dashboard.totalUsers}</p></div>
            <div className="card p-3 border-l-4 border-emerald-500"><p className="text-xs text-gray-500">Present</p><p className="text-2xl font-bold text-emerald-600">{dashboard.present}</p></div>
            <div className="card p-3 border-l-4 border-red-500"><p className="text-xs text-gray-500">Absent</p><p className="text-2xl font-bold text-red-600">{dashboard.absent}</p></div>
            <div className="card p-3 border-l-4 border-amber-500"><p className="text-xs text-gray-500">Late</p><p className="text-2xl font-bold text-amber-600">{dashboard.late}</p></div>
            <div className="card p-3 border-l-4 border-purple-500"><p className="text-xs text-gray-500">On Leave</p><p className="text-2xl font-bold text-purple-600">{dashboard.onLeave}</p></div>
          </div>

          {/* Backfill any user's attendance for a PAST date (phone dead /
              forgot to punch / on-site with no network). Opens a modal that
              hits the same admin-mark endpoint the per-day button uses. */}
          <div className="flex justify-end">
            <button
              onClick={() => { setForm({ user_id: '', date: today, status: 'present', remarks: '' }); setModal('admin-mark'); }}
              className="btn btn-primary text-sm flex items-center gap-1">
              <FiCheckCircle size={14} /> Mark / Backfill Attendance
            </button>
          </div>

          {/* Not Punched In */}
          {dashboard.notPunched?.length > 0 && (
            <div className="card bg-red-50 border border-red-200">
              <h4 className="font-bold text-red-700 mb-2"><FiAlertTriangle className="inline mr-1" /> Not Punched In Today ({dashboard.notPunched.length})</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">{dashboard.notPunched.map(u => (
                <div key={u.id} className="bg-white rounded p-2 text-sm">
                  <div className="font-medium">{u.name}</div>
                  <div className="text-xs text-gray-500 mb-1.5">{u.department}</div>
                  {/* Admin override — back-fill present for users who didn't
                      punch. Row is hidden from the user's own dashboard. */}
                  <button onClick={async () => {
                    const remark = prompt(`Mark ${u.name} as PRESENT for today?\n\nReason (optional, for audit):`);
                    if (remark === null) return;
                    try {
                      await api.post('/attendance/admin-mark', { user_id: u.id, date: today, status: 'present', remarks: remark });
                      toast.success(`${u.name} marked present`);
                      load();
                    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
                  }} className="btn btn-success text-[10px] py-1 px-2 w-full">
                    <FiCheckCircle className="inline mr-0.5" size={11} /> Mark Present
                  </button>
                </div>
              ))}</div>
              <p className="text-[10px] text-red-700 mt-2 italic">Admin-marked rows don't appear in the user's own dashboard or month view — only in admin reports.</p>
            </div>
          )}

          {/* Today's Records */}
          <div className="card p-0 overflow-x-auto">
            <div className="p-3 border-b"><h4 className="font-semibold">Today's Attendance</h4></div>
            <div className="overflow-x-auto hidden md:block"><table className="text-sm">
              <thead><tr><th>Name</th><th>Dept</th><th>In</th><th>Out</th><th>Hours</th><th>Status</th><th>Photo</th></tr></thead>
              <tbody>{dashboard.todayRecords?.map(r => (
                <tr key={r.id}>
                  <td className="font-medium">{r.user_name}{r.admin_marked ? <span className="ml-1 text-[9px] bg-amber-100 text-amber-700 px-1 rounded font-bold" title="Admin marked — hidden from user">ADMIN</span> : null}{r.punch_in_time && r.location_verified === 0 ? <span className="ml-1 text-[9px] bg-orange-100 text-orange-700 px-1 rounded font-bold" title="GPS could not confirm this location — check the selfie">⚠ GPS?</span> : null}</td><td className="text-xs">{r.department}</td>
                  <td className="text-emerald-600 text-xs">{fmtT(r.punch_in_time)}{r.auto_punched_in ? <span className="ml-1 text-[9px] bg-purple-100 text-purple-700 px-1 rounded">AUTO</span> : null}</td>
                  <td className="text-red-600 text-xs">{fmtT(r.punch_out_time)}{r.auto_punched_out ? <span className="ml-1 text-[9px] bg-purple-100 text-purple-700 px-1 rounded">AUTO</span> : null}</td>
                  <td className="font-semibold">{r.total_hours || '-'}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td>{r.punch_in_photo && <img src={r.punch_in_photo} alt="" onClick={() => setLightbox({ src: r.punch_in_photo, label: `${r.user_name} — Punch In` })} className="w-10 h-8 rounded object-cover cursor-pointer hover:ring-2 hover:ring-blue-400 transition" />}</td>
                </tr>
              ))}</tbody>
            </table></div>
            {/* Mobile cards — Today's Attendance (mam 2026-06-02). */}
            <div className="md:hidden p-3 space-y-3">
              {(dashboard.todayRecords || []).length === 0 && (
                <div className="text-center text-gray-400 text-sm py-4">No punches today yet.</div>
              )}
              {(dashboard.todayRecords || []).map(r => (
                <div key={r.id} className="border border-gray-200 rounded-lg p-2.5 space-y-1.5 bg-white">
                  <div className="flex justify-between items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Employee</div>
                      <div className="text-base font-bold text-gray-900 truncate flex items-center gap-1">
                        {r.user_name}
                        {r.admin_marked && (
                          <span className="text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-bold" title="Admin marked">ADMIN</span>
                        )}
                      </div>
                      {r.department && <div className="text-[11px] text-gray-500">{r.department}</div>}
                    </div>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="grid grid-cols-3 gap-2 pt-1 border-t border-gray-100 text-[11px]">
                    <div>
                      <div className="text-[9px] uppercase text-gray-400">In</div>
                      <div className="font-semibold text-emerald-700">
                        {fmtT(r.punch_in_time)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[9px] uppercase text-gray-400">Out</div>
                      <div className="font-semibold text-red-700">
                        {fmtT(r.punch_out_time)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[9px] uppercase text-gray-400">Hours</div>
                      <div className="font-semibold text-gray-800">{r.total_hours || '—'}</div>
                    </div>
                  </div>
                  {r.punch_in_photo && (
                    <div className="pt-1 border-t border-gray-100">
                      <img src={r.punch_in_photo} alt="" onClick={() => setLightbox({ src: r.punch_in_photo, label: `${r.user_name} — Punch In` })}
                        className="w-16 h-16 rounded object-cover cursor-pointer ring-1 ring-gray-200" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* RECORDS TAB */}
      {tab === 'records' && (
        <>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <input type="date" className="input w-48" value={filterDate} onChange={e => setFilterDate(e.target.value)} />
            <button onClick={() => exportCsv(`attendance-${filterDate || 'all'}`,
              ['Name','Date','In','Out','Hours','Site','Status'],
              records.map(r => [r.user_name, r.date, r.punch_in_time, r.punch_out_time, r.total_hours, r.site_name, r.status]))}
              className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload /> Export Excel</button>
          </div>
          {/* Desktop table (mobile gets card list below — mam 2026-06-02). */}
          <div className="card p-0 overflow-auto max-h-[70vh] hidden md:block"><table className="text-sm">
            <thead className="sticky top-0 z-10 bg-gray-100"><tr><th>Name</th><th>Date</th><th>In</th><th>Out</th><th>Hours</th><th>Site</th><th>Status</th><th>In Photo</th><th>Out Photo</th><th>Actions</th></tr></thead>
            <tbody>{records.map(r => (
              <tr key={r.id}>
                <td className="font-medium">{r.user_name}{r.admin_marked ? <span className="ml-1 text-[9px] bg-amber-100 text-amber-700 px-1 rounded font-bold" title="Admin marked — hidden from user">ADMIN</span> : null}</td><td>{r.date}</td>
                <td className="text-xs">{fmtT(r.punch_in_time)}{r.auto_punched_in ? <span className="ml-1 text-[9px] bg-purple-100 text-purple-700 px-1 rounded">AUTO</span> : null}</td>
                <td className="text-xs">{fmtT(r.punch_out_time)}{r.auto_punched_out ? <span className="ml-1 text-[9px] bg-purple-100 text-purple-700 px-1 rounded">AUTO</span> : null}</td>
                <td className="font-semibold">{r.total_hours || '-'}</td>
                <td className="text-xs">{r.site_name || '-'}{r.punch_in_time && r.location_verified === 0 ? <span className="ml-1 text-[9px] bg-orange-100 text-orange-700 px-1 rounded font-bold" title="GPS could not confirm this location — check the selfie">⚠ GPS?</span> : null}</td>
                <td><StatusBadge status={r.status} /></td>
                <td>{r.punch_in_photo && <img src={r.punch_in_photo} alt="" onClick={() => setLightbox({ src: r.punch_in_photo, label: `${r.user_name} — Punch In` })} className="w-10 h-8 rounded object-cover cursor-pointer hover:ring-2 hover:ring-blue-400 transition" />}</td>
                <td>{r.punch_out_photo && <img src={r.punch_out_photo} alt="" onClick={() => setLightbox({ src: r.punch_out_photo, label: `${r.user_name} — Punch Out` })} className="w-10 h-8 rounded object-cover cursor-pointer hover:ring-2 hover:ring-blue-400 transition" />}</td>
                <td>{canDelete('attendance') && <button onClick={async () => {
                  if (!confirm(`Delete attendance record for "${r.user_name}" on ${r.date}?`)) return;
                  try { await api.delete(`/attendance/${r.id}`); toast.success('Deleted'); load(); }
                  catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                }} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}</td>
              </tr>
            ))}</tbody>
          </table></div>

          {/* Mobile cards — polished pattern (mam 2026-06-02): small
              "Employee" label → big bold name → status pill, calendar
              row, 3-col In/Out/Hours grid, site pin row, photo strip,
              delete action at bottom. */}
          <div className="md:hidden space-y-3">
            {records.length === 0 && (
              <div className="card p-6 text-center text-gray-400 text-sm">No attendance records for the selected date.</div>
            )}
            {records.map(r => (
              <div key={r.id} className="card p-3 space-y-2">
                <div className="flex justify-between items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Employee</div>
                    <div className="text-lg font-bold text-gray-900 truncate flex items-center gap-1">
                      {r.user_name}
                      {r.admin_marked && (
                        <span className="text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-bold" title="Admin marked — hidden from user">ADMIN</span>
                      )}
                    </div>
                    <div className="text-[11px] text-gray-500 flex items-center gap-1 mt-0.5">
                      <FiCalendar size={10} className="text-gray-400" />
                      {r.date || '—'}
                    </div>
                  </div>
                  <StatusBadge status={r.status} />
                </div>
                {r.site_name && (
                  <div className="flex items-start gap-1.5 text-xs">
                    <FiMapPin size={12} className="mt-0.5 text-red-500 flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="text-[10px] uppercase text-gray-400">Site</div>
                      <div className="font-medium text-gray-800">{r.site_name}</div>
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-3 gap-2 pt-1 border-t border-gray-100 text-[11px]">
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">In</div>
                    <div className="font-semibold text-emerald-700">
                      {fmtT(r.punch_in_time)}
                      {r.auto_punched_in && <span className="ml-1 text-[8px] bg-purple-100 text-purple-700 px-1 rounded">AUTO</span>}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">Out</div>
                    <div className="font-semibold text-red-700">
                      {fmtT(r.punch_out_time)}
                      {r.auto_punched_out && <span className="ml-1 text-[8px] bg-purple-100 text-purple-700 px-1 rounded">AUTO</span>}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[9px] uppercase text-gray-400">Hours</div>
                    <div className="font-semibold text-gray-800">{r.total_hours || '—'}</div>
                  </div>
                </div>
                {(r.punch_in_photo || r.punch_out_photo) && (
                  <div className="flex items-center gap-2 pt-1 border-t border-gray-100">
                    {r.punch_in_photo && (
                      <div className="flex flex-col items-center gap-0.5">
                        <span className="text-[9px] uppercase text-emerald-600 font-semibold">In</span>
                        <img src={r.punch_in_photo} alt="" onClick={() => setLightbox({ src: r.punch_in_photo, label: `${r.user_name} — Punch In` })}
                          className="w-14 h-14 rounded object-cover cursor-pointer ring-1 ring-emerald-200" />
                      </div>
                    )}
                    {r.punch_out_photo && (
                      <div className="flex flex-col items-center gap-0.5">
                        <span className="text-[9px] uppercase text-red-600 font-semibold">Out</span>
                        <img src={r.punch_out_photo} alt="" onClick={() => setLightbox({ src: r.punch_out_photo, label: `${r.user_name} — Punch Out` })}
                          className="w-14 h-14 rounded object-cover cursor-pointer ring-1 ring-red-200" />
                      </div>
                    )}
                  </div>
                )}
                {canDelete('attendance') && (
                  <div className="flex items-center justify-end pt-2 border-t border-gray-100">
                    <button onClick={async () => {
                      if (!confirm(`Delete attendance record for "${r.user_name}" on ${r.date}?`)) return;
                      try { await api.delete(`/attendance/${r.id}`); toast.success('Deleted'); load(); }
                      catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                    }} className="text-red-600 hover:underline flex items-center gap-1 text-xs font-semibold">
                      <FiTrash2 size={11} /> Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* BY USER TAB — pick a person, see their in/out/hours over a range */}
      {/* MY HISTORY — self-service: every employee can review their OWN past
          attendance over a start→end date range (mam 2026-06-12). */}
      {tab === 'myhistory' && (
        <div className="space-y-4">
          <div className="card p-3">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
              <div>
                <label className="label">From</label>
                <input type="date" className="input" value={myHistFrom} max={myHistTo} onChange={e => setMyHistFrom(e.target.value)} />
              </div>
              <div>
                <label className="label">To</label>
                <input type="date" className="input" value={myHistTo} max={today} onChange={e => setMyHistTo(e.target.value)} />
              </div>
              <div>
                <label className="label">&nbsp;</label>
                <button type="button" className="btn btn-secondary text-sm w-full" onClick={() => { setMyHistFrom(firstOfMonth); setMyHistTo(today); }}>This month</button>
              </div>
              <div>
                <label className="label">&nbsp;</label>
                <button type="button" disabled={myHistory.length === 0} className="btn btn-secondary text-sm w-full flex items-center justify-center gap-2 disabled:opacity-40"
                  onClick={() => exportCsv(`my-attendance-${myHistFrom}_to_${myHistTo}`,
                    ['Date','In','Out','Hours','Site','Status'],
                    myHistory.map(r => [
                      r.date,
                      r.punch_in_time ? new Date(r.punch_in_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '',
                      r.punch_out_time ? new Date(r.punch_out_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '',
                      r.total_hours || 0, r.site_name || '', r.status || '',
                    ]))}>
                  <FiDownload /> Export
                </button>
              </div>
            </div>
          </div>

          {/* Summary cards */}
          {(() => {
            const total = myHistory.length;
            const present = myHistory.filter(r => r.punch_in_time).length;
            const late = myHistory.filter(r => r.status === 'late').length;
            const halfDay = myHistory.filter(r => r.status === 'half_day').length;
            const totalHours = myHistory.reduce((s, r) => s + (r.total_hours || 0), 0);
            const avgHours = present > 0 ? (totalHours / present).toFixed(1) : '0';
            return (
              <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                <div className="card p-3"><div className="text-[11px] text-gray-500">Records</div><div className="text-2xl font-bold">{total}</div></div>
                <div className="card p-3"><div className="text-[11px] text-gray-500">Present</div><div className="text-2xl font-bold text-emerald-600">{present}</div></div>
                <div className="card p-3"><div className="text-[11px] text-gray-500">Late</div><div className="text-2xl font-bold text-amber-600">{late}</div></div>
                <div className="card p-3"><div className="text-[11px] text-gray-500">Half Day</div><div className="text-2xl font-bold text-orange-600">{halfDay}</div></div>
                <div className="card p-3"><div className="text-[11px] text-gray-500">Total Hours</div><div className="text-2xl font-bold">{totalHours.toFixed(1)}</div></div>
                <div className="card p-3"><div className="text-[11px] text-gray-500">Avg Hours / day</div><div className="text-2xl font-bold">{avgHours}</div></div>
              </div>
            );
          })()}

          {/* Detail table */}
          <div className="card p-0 overflow-x-auto">
            <div className="p-3 border-b"><h4 className="font-semibold text-sm">My Attendance · {myHistFrom} → {myHistTo}</h4></div>
            <div className="overflow-x-auto">
              <table className="text-sm w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-2 py-2 text-left">Date</th>
                    <th className="px-2 py-2">In</th>
                    <th className="px-2 py-2">Out</th>
                    <th className="px-2 py-2">Hours</th>
                    <th className="px-2 py-2 text-left">Site</th>
                    <th className="px-2 py-2">Status</th>
                    <th className="px-2 py-2">Photos</th>
                  </tr>
                </thead>
                <tbody>
                  {myHistory.map(r => (
                    <tr key={r.id} className="border-b">
                      <td className="px-2 py-2 font-medium">{r.date}</td>
                      <td className="px-2 py-2 text-center text-xs text-emerald-600">
                        {fmtT(r.punch_in_time)}
                        {r.auto_punched_in ? <span className="ml-1 text-[9px] bg-purple-100 text-purple-700 px-1 rounded">AUTO</span> : null}
                      </td>
                      <td className="px-2 py-2 text-center text-xs text-red-600">
                        {fmtT(r.punch_out_time)}
                        {r.auto_punched_out ? <span className="ml-1 text-[9px] bg-purple-100 text-purple-700 px-1 rounded">AUTO</span> : null}
                      </td>
                      <td className="px-2 py-2 text-center font-semibold">{r.total_hours || '-'}</td>
                      <td className="px-2 py-2 text-xs">{r.site_name || '-'}</td>
                      <td className="px-2 py-2 text-center"><StatusBadge status={r.status} /></td>
                      <td className="px-2 py-2">
                        <div className="flex gap-1 justify-center">
                          {r.punch_in_photo && <img src={r.punch_in_photo} alt="In" onClick={() => setLightbox({ src: r.punch_in_photo, label: `Punch In — ${r.date || ''}` })} className="w-8 h-8 rounded object-cover cursor-pointer hover:ring-2 hover:ring-blue-400 transition" title="Punch In" />}
                          {r.punch_out_photo && <img src={r.punch_out_photo} alt="Out" onClick={() => setLightbox({ src: r.punch_out_photo, label: `Punch Out — ${r.date || ''}` })} className="w-8 h-8 rounded object-cover cursor-pointer hover:ring-2 hover:ring-blue-400 transition" title="Punch Out" />}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {myHistory.length === 0 && (
                    <tr><td colSpan="7" className="text-center py-6 text-gray-400">No attendance records in this range</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'byuser' && seeAll && (
        <div className="space-y-4">
          <div className="card p-3">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="md:col-span-2">
                <label className="label">Search Employee</label>
                <input
                  className="input"
                  placeholder="Type name, email, or department..."
                  value={userSearch}
                  onChange={e => setUserSearch(e.target.value)}
                />
                <div className="mt-2 max-h-48 overflow-y-auto border rounded-lg bg-white">
                  {allUsers
                    .filter(u => {
                      if (!userSearch) return true;
                      const q = userSearch.toLowerCase();
                      return (u.name || '').toLowerCase().includes(q)
                        || (u.email || '').toLowerCase().includes(q)
                        || (u.department || '').toLowerCase().includes(q);
                    })
                    .slice(0, 50)
                    .map(u => (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => setSelectedUserId(u.id)}
                        className={`w-full text-left px-3 py-2 text-sm border-b last:border-b-0 hover:bg-red-50 ${selectedUserId === u.id ? 'bg-red-100 font-semibold' : ''}`}
                      >
                        {u.name} <span className="text-xs text-gray-400">— {u.department || u.role_names || u.role || 'User'}</span>
                      </button>
                    ))}
                  {allUsers.length === 0 && <p className="p-3 text-xs text-gray-400">No users loaded</p>}
                </div>
              </div>
              <div>
                <label className="label">From</label>
                <input type="date" className="input" value={userDateFrom} onChange={e => setUserDateFrom(e.target.value)} />
              </div>
              <div>
                <label className="label">To</label>
                <input type="date" className="input" value={userDateTo} onChange={e => setUserDateTo(e.target.value)} />
              </div>
            </div>
          </div>

          {!selectedUserId ? (
            <div className="card p-8 text-center text-gray-400 text-sm">Pick an employee on the left to see their attendance details</div>
          ) : (
            <>
              {/* Summary cards */}
              {(() => {
                const total = userRecords.length;
                const present = userRecords.filter(r => r.punch_in_time).length;
                const late = userRecords.filter(r => r.status === 'late').length;
                const halfDay = userRecords.filter(r => r.status === 'half_day').length;
                const autoIn = userRecords.filter(r => r.auto_punched_in).length;
                const autoOut = userRecords.filter(r => r.auto_punched_out).length;
                const totalHours = userRecords.reduce((s, r) => s + (r.total_hours || 0), 0);
                const avgHours = present > 0 ? (totalHours / present).toFixed(1) : '0';
                const selectedUser = allUsers.find(u => u.id === selectedUserId);
                return (
                  <>
                    <div className="card p-3 flex items-center justify-between">
                      <div>
                        <h4 className="font-bold text-lg">{selectedUser?.name || '—'}</h4>
                        <p className="text-xs text-gray-500">{selectedUser?.department || ''} {selectedUser?.email ? `· ${selectedUser.email}` : ''}</p>
                      </div>
                      <span className="text-xs text-gray-400">{userDateFrom} → {userDateTo}</span>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                      <div className="card p-3"><div className="text-[11px] text-gray-500">Records</div><div className="text-2xl font-bold">{total}</div></div>
                      <div className="card p-3"><div className="text-[11px] text-gray-500">Present</div><div className="text-2xl font-bold text-emerald-600">{present}</div></div>
                      <div className="card p-3"><div className="text-[11px] text-gray-500">Late</div><div className="text-2xl font-bold text-amber-600">{late}</div></div>
                      <div className="card p-3"><div className="text-[11px] text-gray-500">Half Day</div><div className="text-2xl font-bold text-orange-600">{halfDay}</div></div>
                      <div className="card p-3"><div className="text-[11px] text-gray-500">Total Hours</div><div className="text-2xl font-bold">{totalHours.toFixed(1)}</div></div>
                      <div className="card p-3"><div className="text-[11px] text-gray-500">Avg Hours / day</div><div className="text-2xl font-bold">{avgHours}</div></div>
                    </div>
                    {(autoIn > 0 || autoOut > 0) && (
                      <div className="text-xs text-purple-700 bg-purple-50 border border-purple-200 rounded-lg px-3 py-2">
                        Auto-punched: {autoIn} in · {autoOut} out. These entries were marked automatically after 5 min inside/outside the geofence.
                      </div>
                    )}
                  </>
                );
              })()}

              {/* Detail table */}
              <div className="card p-0 overflow-x-auto">
                <div className="p-3 border-b"><h4 className="font-semibold text-sm">Daily Detail</h4></div>
                <div className="overflow-x-auto">
                  <table className="text-sm w-full">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-2 py-2 text-left">Date</th>
                        <th className="px-2 py-2">In</th>
                        <th className="px-2 py-2">Out</th>
                        <th className="px-2 py-2">Hours</th>
                        <th className="px-2 py-2 text-left">Site</th>
                        <th className="px-2 py-2">Status</th>
                        <th className="px-2 py-2">Photos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {userRecords.map(r => (
                        <tr key={r.id} className="border-b">
                          <td className="px-2 py-2 font-medium">{r.date}</td>
                          <td className="px-2 py-2 text-center text-xs text-emerald-600">
                            {fmtT(r.punch_in_time)}
                            {r.auto_punched_in ? <span className="ml-1 text-[9px] bg-purple-100 text-purple-700 px-1 rounded">AUTO</span> : null}
                          </td>
                          <td className="px-2 py-2 text-center text-xs text-red-600">
                            {fmtT(r.punch_out_time)}
                            {r.auto_punched_out ? <span className="ml-1 text-[9px] bg-purple-100 text-purple-700 px-1 rounded">AUTO</span> : null}
                          </td>
                          <td className="px-2 py-2 text-center font-semibold">{r.total_hours || '-'}</td>
                          <td className="px-2 py-2 text-xs">{r.site_name || '-'}</td>
                          <td className="px-2 py-2 text-center"><StatusBadge status={r.status} /></td>
                          <td className="px-2 py-2">
                            <div className="flex gap-1 justify-center">
                              {r.punch_in_photo && <img src={r.punch_in_photo} alt="In" onClick={() => setLightbox({ src: r.punch_in_photo, label: `Punch In — ${r.date || ''}` })} className="w-8 h-8 rounded object-cover cursor-pointer hover:ring-2 hover:ring-blue-400 transition" title="Punch In" />}
                              {r.punch_out_photo && <img src={r.punch_out_photo} alt="Out" onClick={() => setLightbox({ src: r.punch_out_photo, label: `Punch Out — ${r.date || ''}` })} className="w-8 h-8 rounded object-cover cursor-pointer hover:ring-2 hover:ring-blue-400 transition" title="Punch Out" />}
                            </div>
                          </td>
                        </tr>
                      ))}
                      {userRecords.length === 0 && (
                        <tr><td colSpan="7" className="text-center py-6 text-gray-400">No attendance records in this range</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* MONTHLY REPORT */}
      {tab === 'report' && (
        <>
          <div className="card p-0 hidden md:block"><table className="text-sm freeze-head">
            <thead><tr><th>Employee</th><th>Dept</th><th>Present</th><th>Late</th><th>Half Day</th><th>Absent</th><th>Avg Hours</th></tr></thead>
            <tbody>{report.map(r => (
              <tr key={r.user_id}>
                <td className="font-medium">{r.name}</td><td className="text-xs">{r.department}</td>
                <td className="text-emerald-600 font-bold">{r.present_days}</td>
                <td className="text-amber-600">{r.late_days}</td>
                <td>{r.half_days}</td>
                <td className="text-red-600">{r.absent_days}</td>
                <td className="font-semibold">{r.avg_hours || '-'}h</td>
              </tr>
            ))}</tbody>
          </table></div>
          {/* Mobile cards (mam 2026-06-02) */}
          <div className="md:hidden space-y-3">
            {report.length === 0 && (
              <div className="card p-6 text-center text-gray-400 text-sm">No report rows yet — pick a month / year.</div>
            )}
            {report.map(r => (
              <div key={r.user_id} className="card p-3 space-y-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Employee</div>
                  <div className="text-lg font-bold text-gray-900 truncate">{r.name}</div>
                  {r.department && <div className="text-[11px] text-gray-500">{r.department}</div>}
                </div>
                <div className="grid grid-cols-4 gap-2 pt-1 border-t border-gray-100 text-center">
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">Present</div>
                    <div className="text-base font-bold text-emerald-700">{r.present_days || 0}</div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">Late</div>
                    <div className="text-base font-bold text-amber-700">{r.late_days || 0}</div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">Half</div>
                    <div className="text-base font-bold text-gray-700">{r.half_days || 0}</div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">Absent</div>
                    <div className="text-base font-bold text-red-700">{r.absent_days || 0}</div>
                  </div>
                </div>
                <div className="text-center text-[11px] text-gray-500 pt-1 border-t border-gray-100">
                  Avg hours/day: <b className="text-gray-800">{r.avg_hours || '—'}h</b>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* GEOFENCE SETTINGS */}
      {tab === 'geofence' && (
        <>
          <div className="flex justify-between items-center">
            <h4 className="font-semibold">Geofence Areas</h4>
            <button onClick={() => { setForm({ site_name: '', latitude: '', longitude: '', radius_meters: 200 }); setModal('geofence'); }} className="btn btn-primary flex items-center gap-2 text-sm"><FiPlus size={14} /> Add Geofence</button>
          </div>
          <p className="text-xs text-gray-500">Employees can only punch in/out when inside these areas. If no geofence set, punch from anywhere.</p>
          <div className="card p-0 overflow-x-auto"><table className="text-sm">
            <thead><tr><th>Site</th><th>Latitude</th><th>Longitude</th><th>Radius</th><th>Active</th><th>Actions</th></tr></thead>
            <tbody>{geofences.map(g => (
              <tr key={g.id}>
                <td className="font-medium">{g.site_name}</td><td className="text-xs">{g.latitude}</td><td className="text-xs">{g.longitude}</td><td>{g.radius_meters}m</td><td>{g.active ? 'Yes' : 'No'}</td>
                <td className="flex gap-1">
                  <button onClick={() => { setForm({ ...g }); setModal('edit-geofence'); }} className="text-xs text-red-600 font-bold">Edit</button>
                  <button onClick={async () => { if (!confirm('Delete this geofence?')) return; await api.delete(`/attendance/geofence/${g.id}`); toast.success('Deleted'); load(); }} className="text-xs text-red-600 font-bold">Delete</button>
                </td>
              </tr>
            ))}{geofences.length === 0 && <tr><td colSpan="6" className="text-center py-6 text-gray-400">No geofence set. Add site locations for attendance.</td></tr>}</tbody>
          </table></div>
        </>
      )}

      {/* LEAVES TAB */}
      {tab === 'leaves' && (
        <>
        <div className="card p-0 overflow-x-auto hidden md:block"><table className="text-sm">
          <thead><tr><th>Employee</th><th>Type</th><th>From</th><th>To</th><th>Hrs / Days</th><th>Reason</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{leaves.map(l => {
            // For short_leave show from-time → to-time so admin can audit
            // exactly what window the employee took. For full-day leaves
            // (casual / sick / earned / comp_off) just the dates suffice.
            const isShort = l.leave_type === 'short_leave' || l.leave_type === 'half_day';
            return (
            <tr key={l.id}>
              <td className="font-medium">{l.user_name}</td><td className="capitalize">{l.leave_type?.replace('_', ' ')}</td>
              <td className="text-xs">
                <div>{l.from_date}</div>
                {isShort && l.from_time && <div className="text-[10px] text-blue-600 font-bold">{l.from_time}</div>}
              </td>
              <td className="text-xs">
                <div>{l.to_date}</div>
                {isShort && l.to_time && <div className="text-[10px] text-blue-600 font-bold">{l.to_time}</div>}
              </td>
              <td className="text-xs">
                {isShort
                  ? <span className="text-amber-700 font-bold">{l.hours ? `${(+l.hours).toFixed(2).replace(/\.?0+$/, '')} hr${l.hours !== 1 ? 's' : ''}` : '—'}</span>
                  : <span className="font-medium">{l.days} day{l.days !== 1 ? 's' : ''}</span>
                }
              </td>
              <td className="text-xs">{l.reason}</td>
              <td><StatusBadge status={l.status} /></td>
              <td>
                <div className="flex items-center gap-1">
                  {l.status === 'pending' && (
                    <>
                      <button onClick={async () => { await api.put(`/attendance/leave/${l.id}/approve`, { status: 'approved' }); toast.success('Approved'); load(); }} className="text-xs text-emerald-600 font-bold mr-1">Approve</button>
                      <button onClick={async () => { await api.put(`/attendance/leave/${l.id}/approve`, { status: 'rejected' }); toast.success('Rejected'); load(); }} className="text-xs text-red-600 font-bold mr-1">Reject</button>
                    </>
                  )}
                  <button
                    onClick={() => {
                      setEditingLeave(l);
                      setLeaveEditForm({
                        leave_type: l.leave_type || 'casual',
                        from_date: l.from_date || '',
                        to_date: l.to_date || '',
                        from_time: l.from_time || '',
                        to_time: l.to_time || '',
                        days: l.days || 0,
                        hours: l.hours ? +(+l.hours).toFixed(2) : 0,
                        reason: l.reason || '',
                      });
                    }}
                    className="p-1 text-gray-400 hover:text-blue-600"
                    title="Edit"
                  ><FiEdit2 size={14} /></button>
                  <button
                    onClick={async () => {
                      if (!confirm(`Delete this leave request for ${l.user_name}?`)) return;
                      try {
                        await api.delete(`/attendance/leave/${l.id}`);
                        toast.success('Deleted'); load();
                      } catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                    }}
                    className="p-1 text-gray-400 hover:text-red-600"
                    title="Delete"
                  ><FiTrash2 size={14} /></button>
                </div>
              </td>
            </tr>
            );
          })}</tbody>
        </table></div>

        {/* Mobile cards (mam 2026-06-02) — Leaves */}
        <div className="md:hidden space-y-3">
          {leaves.length === 0 && (
            <div className="card p-6 text-center text-gray-400 text-sm">No leave requests yet.</div>
          )}
          {leaves.map(l => {
            const isShort = l.leave_type === 'short_leave' || l.leave_type === 'half_day';
            return (
              <div key={l.id} className="card p-3 space-y-2">
                <div className="flex justify-between items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Employee</div>
                    <div className="text-lg font-bold text-gray-900 truncate">{l.user_name}</div>
                    <div className="text-[11px] capitalize text-gray-600 mt-0.5">{(l.leave_type || '').replace('_', ' ')}</div>
                  </div>
                  <StatusBadge status={l.status} />
                </div>
                <div className="grid grid-cols-2 gap-2 pt-1 border-t border-gray-100 text-[11px]">
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">From</div>
                    <div className="font-semibold text-gray-700">{l.from_date || '—'}</div>
                    {isShort && l.from_time && <div className="text-[10px] text-blue-600 font-semibold">{l.from_time}</div>}
                  </div>
                  <div className="text-right">
                    <div className="text-[9px] uppercase text-gray-400">To</div>
                    <div className="font-semibold text-gray-700">{l.to_date || '—'}</div>
                    {isShort && l.to_time && <div className="text-[10px] text-blue-600 font-semibold">{l.to_time}</div>}
                  </div>
                </div>
                <div className="text-[11px] pt-1 border-t border-gray-100">
                  <span className="text-gray-400">Duration:</span>{' '}
                  {isShort
                    ? <b className="text-amber-700">{l.hours ? `${(+l.hours).toFixed(2).replace(/\.?0+$/, '')} hr${l.hours !== 1 ? 's' : ''}` : '—'}</b>
                    : <b className="text-gray-800">{l.days} day{l.days !== 1 ? 's' : ''}</b>
                  }
                </div>
                {l.reason && (
                  <div className="text-[11px] text-gray-600 italic pt-1 border-t border-gray-100 line-clamp-2">"{l.reason}"</div>
                )}
                {l.status === 'pending' && (
                  <div className="flex items-center gap-2 pt-1">
                    <button onClick={async () => { await api.put(`/attendance/leave/${l.id}/approve`, { status: 'approved' }); toast.success('Approved'); load(); }}
                      className="btn btn-success text-xs py-1.5 px-3 flex-1">Approve</button>
                    <button onClick={async () => { await api.put(`/attendance/leave/${l.id}/approve`, { status: 'rejected' }); toast.success('Rejected'); load(); }}
                      className="btn btn-danger text-xs py-1.5 px-3 flex-1">Reject</button>
                  </div>
                )}
                <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-100 text-xs">
                  <button onClick={() => {
                    setEditingLeave(l);
                    setLeaveEditForm({
                      leave_type: l.leave_type || 'casual',
                      from_date: l.from_date || '', to_date: l.to_date || '',
                      from_time: l.from_time || '', to_time: l.to_time || '',
                      days: l.days || 0, hours: l.hours ? +(+l.hours).toFixed(2) : 0,
                      reason: l.reason || '',
                    });
                  }} className="text-blue-600 hover:underline flex items-center gap-1 font-semibold">
                    <FiEdit2 size={11} /> Edit
                  </button>
                  <button onClick={async () => {
                    if (!confirm(`Delete this leave request for ${l.user_name}?`)) return;
                    try { await api.delete(`/attendance/leave/${l.id}`); toast.success('Deleted'); load(); }
                    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                  }} className="text-red-600 hover:underline flex items-center gap-1 font-semibold">
                    <FiTrash2 size={11} /> Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}

      {/* EDIT LEAVE MODAL — admin / approver fixes typos, wrong dates,
          rounding errors. Status is NOT editable here (use Approve / Reject). */}
      <Modal isOpen={!!editingLeave} onClose={() => { setEditingLeave(null); setLeaveEditForm({}); }} title={editingLeave ? `Edit Leave — ${editingLeave.user_name}` : ''}>
        {editingLeave && (
          <form onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.put(`/attendance/leave/${editingLeave.id}`, leaveEditForm);
              toast.success('Updated');
              setEditingLeave(null); setLeaveEditForm({}); load();
            } catch (err) { toast.error(err.response?.data?.error || 'Update failed'); }
          }} className="space-y-3">
            <div>
              <label className="label">Type</label>
              <select className="select" value={leaveEditForm.leave_type || ''} onChange={e => setLeaveEditForm({ ...leaveEditForm, leave_type: e.target.value })}>
                <option value="casual">Casual</option>
                <option value="sick">Sick</option>
                <option value="earned">Earned</option>
                <option value="half_day">Half Day</option>
                <option value="short_leave">Short Leave</option>
                <option value="comp_off">Comp Off</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">From Date</label>
                <input type="date" className="input" value={leaveEditForm.from_date || ''} onChange={e => setLeaveEditForm({ ...leaveEditForm, from_date: e.target.value })} />
              </div>
              <div>
                <label className="label">To Date</label>
                <input type="date" className="input" value={leaveEditForm.to_date || ''} onChange={e => setLeaveEditForm({ ...leaveEditForm, to_date: e.target.value })} />
              </div>
            </div>
            {(leaveEditForm.leave_type === 'short_leave' || leaveEditForm.leave_type === 'half_day') && (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="label">From Time</label>
                  <TimePicker value={leaveEditForm.from_time || ''} onChange={v => setLeaveEditForm({ ...leaveEditForm, from_time: v })} />
                </div>
                <div>
                  <label className="label">To Time</label>
                  <TimePicker value={leaveEditForm.to_time || ''} onChange={v => setLeaveEditForm({ ...leaveEditForm, to_time: v })} />
                </div>
                <div>
                  <label className="label">Hours</label>
                  <input type="number" step="0.25" className="input" value={leaveEditForm.hours || 0} onChange={e => setLeaveEditForm({ ...leaveEditForm, hours: +e.target.value })} />
                </div>
              </div>
            )}
            {!(leaveEditForm.leave_type === 'short_leave' || leaveEditForm.leave_type === 'half_day') && (
              <div>
                <label className="label">Days</label>
                <input type="number" step="0.5" className="input" value={leaveEditForm.days || 0} onChange={e => setLeaveEditForm({ ...leaveEditForm, days: +e.target.value })} />
              </div>
            )}
            <div>
              <label className="label">Reason</label>
              <textarea className="input" rows="2" value={leaveEditForm.reason || ''} onChange={e => setLeaveEditForm({ ...leaveEditForm, reason: e.target.value })} />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t">
              <button type="button" onClick={() => { setEditingLeave(null); setLeaveEditForm({}); }} className="btn btn-secondary">Cancel</button>
              <button type="submit" className="btn btn-primary">Save</button>
            </div>
          </form>
        )}
      </Modal>

      {/* Leave Modal */}
      <Modal isOpen={modal === 'leave'} onClose={() => setModal(null)} title="Apply for Leave">
        <form onSubmit={async (e) => {
          e.preventDefault();
          // Guard — common reason this form fails: To Date < From Date. Catch
          // it client-side so mam sees a clear message instead of a backend 500.
          if (form.leave_type !== 'short_leave' && form.from_date && form.to_date && form.to_date < form.from_date) {
            toast.error('To Date cannot be earlier than From Date');
            return;
          }
          try { await api.post('/attendance/leave', form); toast.success('Leave applied'); setModal(null); load(); }
          catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
        }} className="space-y-4">
          <div><label className="label">Leave Type</label><select className="select" value={form.leave_type} onChange={e => setForm({ ...form, leave_type: e.target.value })}><option value="casual">Casual Leave</option><option value="sick">Sick Leave</option><option value="earned">Earned Leave</option><option value="half_day">Half Day</option><option value="short_leave">Short Leave (max 4hrs/month)</option><option value="comp_off">Comp Off</option></select></div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">From Date *</label>
              <input
                className="input"
                type="date"
                value={form.from_date}
                onChange={e => {
                  const v = e.target.value;
                  // Auto-align To Date if it would become invalid — so picking
                  // a new "from" doesn't silently leave an out-of-range "to".
                  setForm(f => ({
                    ...f,
                    from_date: v,
                    to_date: (!f.to_date || f.to_date < v) ? v : f.to_date,
                  }));
                }}
                required
              />
            </div>
            {form.leave_type !== 'short_leave' && (
              <div>
                <label className="label">To Date *</label>
                <input
                  className="input"
                  type="date"
                  value={form.to_date}
                  min={form.from_date || undefined}
                  onChange={e => setForm({ ...form, to_date: e.target.value })}
                  required
                />
                {form.from_date && form.to_date && form.to_date < form.from_date && (
                  <p className="text-[11px] text-red-600 mt-0.5">To Date must be on or after From Date</p>
                )}
              </div>
            )}
          </div>
          {form.leave_type === 'short_leave' && (
            <div className="grid grid-cols-2 gap-3 bg-amber-50 p-3 rounded">
              <div><label className="label">From Time *</label><TimePicker value={form.from_time || ''} onChange={v => setForm({ ...form, from_time: v })} required /></div>
              <div><label className="label">To Time *</label><TimePicker value={form.to_time || ''} onChange={v => setForm({ ...form, to_time: v })} required /></div>
              <p className="col-span-2 text-xs text-amber-600">Monthly limit: 4 hours. Exceeding will be rejected.</p>
            </div>
          )}
          <div><label className="label">Reason</label><textarea className="input" rows="2" value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(null)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Apply</button></div>
        </form>
      </Modal>

      {/* Edit Geofence Modal */}
      <Modal isOpen={modal === 'edit-geofence'} onClose={() => setModal(null)} title="Edit Geofence">
        <form onSubmit={async (e) => { e.preventDefault(); try { await api.put(`/attendance/geofence/${form.id}`, form); toast.success('Updated'); setModal(null); load(); } catch (err) { toast.error('Failed'); } }} className="space-y-4">
          <div><label className="label">Site Name *</label><input className="input" value={form.site_name || ''} onChange={e => setForm({ ...form, site_name: e.target.value })} required /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Latitude</label><input className="input" type="number" step="any" value={form.latitude || ''} onChange={e => setForm({ ...form, latitude: e.target.value })} /></div>
            <div><label className="label">Longitude</label><input className="input" type="number" step="any" value={form.longitude || ''} onChange={e => setForm({ ...form, longitude: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Radius (m)</label><input className="input" type="number" value={form.radius_meters || 200} onChange={e => setForm({ ...form, radius_meters: +e.target.value })} /></div>
            <div><label className="label">Active</label><select className="select" value={form.active ? '1' : '0'} onChange={e => setForm({ ...form, active: e.target.value === '1' })}><option value="1">Yes</option><option value="0">No</option></select></div>
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(null)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Update</button></div>
        </form>
      </Modal>

      {/* Admin Mark / Backfill Attendance — pick any user + any PAST date.
          Hits /attendance/admin-mark (admin_marked=1, hidden from the user's
          own view). The endpoint refuses to overwrite a real punch. */}
      <Modal isOpen={modal === 'admin-mark'} onClose={() => setModal(null)} title="Mark / Backfill Attendance">
        <form onSubmit={async (e) => {
          e.preventDefault();
          if (!form.user_id) return toast.error('Please select an employee');
          if (!form.date) return toast.error('Please pick a date');
          if (form.date > today) return toast.error('Cannot mark a future date');
          try {
            await api.post('/attendance/admin-mark', {
              user_id: +form.user_id, date: form.date,
              status: form.status || 'present', remarks: form.remarks || '',
            });
            const who = allUsers.find(u => u.id === +form.user_id)?.name || 'Employee';
            toast.success(`${who} marked ${(form.status || 'present').replace('_', ' ')} for ${form.date}`);
            setModal(null); load();
          } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
        }} className="space-y-4">
          <div>
            <label className="label">Employee *</label>
            <select className="select" value={form.user_id || ''} onChange={e => setForm({ ...form, user_id: e.target.value })} required>
              <option value="">-- Select employee --</option>
              {allUsers.map(u => <option key={u.id} value={u.id}>{u.name}{u.department ? ` · ${u.department}` : ''}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Date *</label>
              <input className="input" type="date" max={today} value={form.date || ''} onChange={e => setForm({ ...form, date: e.target.value })} required />
            </div>
            <div>
              <label className="label">Status *</label>
              <select className="select" value={form.status || 'present'} onChange={e => setForm({ ...form, status: e.target.value })}>
                <option value="present">Present</option>
                <option value="half_day">Half Day</option>
                <option value="short_day">Short Day</option>
                <option value="absent">Absent</option>
                <option value="leave">Leave</option>
                <option value="holiday">Holiday</option>
              </select>
            </div>
          </div>
          <div>
            <label className="label">Reason / Remarks (for audit)</label>
            <textarea className="input" rows="2" placeholder="e.g. phone dead, on site without network" value={form.remarks || ''} onChange={e => setForm({ ...form, remarks: e.target.value })} />
          </div>
          <p className="text-[11px] text-gray-500 italic">Admin-marked rows are hidden from the employee's own dashboard / month view and won't overwrite a real punch.</p>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(null)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Save</button></div>
        </form>
      </Modal>

      {/* Geofence Modal */}
      <Modal isOpen={modal === 'geofence'} onClose={() => setModal(null)} title="Add Geofence Area">
        <form onSubmit={async (e) => { e.preventDefault(); try { await api.post('/attendance/geofence', form); toast.success('Geofence added'); setModal(null); load(); } catch (err) { toast.error(err.response?.data?.error || 'Failed'); } }} className="space-y-4">
          <div><label className="label">Site Name *</label><input className="input" value={form.site_name} onChange={e => setForm({ ...form, site_name: e.target.value })} required /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Latitude *</label><input className="input" type="number" step="any" value={form.latitude} onChange={e => setForm({ ...form, latitude: e.target.value })} required /></div>
            <div><label className="label">Longitude *</label><input className="input" type="number" step="any" value={form.longitude} onChange={e => setForm({ ...form, longitude: e.target.value })} required /></div>
          </div>
          <div><label className="label">Radius (meters)</label><input className="input" type="number" value={form.radius_meters} onChange={e => setForm({ ...form, radius_meters: +e.target.value })} /></div>
          <button type="button" onClick={async () => {
            try { const loc = await getLocation(); setForm(f => ({ ...f, latitude: loc.latitude, longitude: loc.longitude })); toast.success('Current location set'); }
            catch { toast.error('GPS failed'); }
          }} className="btn btn-secondary text-sm w-full"><FiMapPin className="inline mr-1" /> Use My Current Location</button>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(null)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Save Geofence</button></div>
        </form>
      </Modal>

      {/* Photo lightbox — click any attendance selfie to view it full-size.
          Click the backdrop or the × to close. */}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4"
        >
          <div className="relative max-w-2xl w-full" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setLightbox(null)}
              className="absolute -top-3 -right-3 bg-white text-gray-700 rounded-full w-8 h-8 flex items-center justify-center shadow-lg hover:bg-gray-100 text-lg font-bold"
              aria-label="Close"
            >×</button>
            <img src={lightbox.src} alt={lightbox.label || 'Attendance photo'} className="w-full max-h-[80vh] object-contain rounded-lg bg-white" />
            {lightbox.label && (
              <div className="mt-2 text-center text-white text-sm font-medium">{lightbox.label}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
