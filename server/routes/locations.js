// Admin-only Live Location + Timeline API.
//
// Reads from the existing `location_tracking` table that the Attendance
// page already populates every 30s via /attendance/track-location. No
// new write paths — just two read views for admin / mam:
//
//   GET /api/admin/locations/live   — latest ping per user in last 30 min
//   GET /api/admin/locations/timeline?user_id=N&date=YYYY-MM-DD
//                                    — full ping history for one user / day,
//                                      with distance-from-previous so mam
//                                      can see how much they moved.

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);
router.use(adminOnly);

// Haversine — meters between two GPS points.
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// GET /api/admin/locations/live
//   ?stale_minutes=N   how old a ping can be and still count as "live" (default 30)
//
// Returns one row per user — their MOST RECENT ping in the staleness window.
// Sorted: in-site first, then most-recent first. Useful for a "who is where
// right now" map / list.
router.get('/live', (req, res) => {
  const db = getDb();
  const staleMin = Math.max(1, Math.min(720, parseInt(req.query.stale_minutes, 10) || 30));
  const sinceIso = new Date(Date.now() - staleMin * 60 * 1000).toISOString();

  // Pick the latest ping per user_id within the staleness window.
  // SQLite-friendly: group by user_id, get max(time), then re-join to get the row.
  // Skip users opted out via users.track_location=0 (admins + named excludes
  // configured from User Management). COALESCE so legacy users without the
  // column still default to "tracked".
  const rows = db.prepare(
    `SELECT lt.user_id, u.name as user_name, u.department, u.role,
            lt.latitude, lt.longitude, lt.address, lt.site_name, lt.time
       FROM location_tracking lt
       JOIN users u ON u.id = lt.user_id
       JOIN (
         SELECT user_id, MAX(time) as max_time
           FROM location_tracking
          WHERE time >= ?
          GROUP BY user_id
       ) latest ON latest.user_id = lt.user_id AND latest.max_time = lt.time
      WHERE COALESCE(u.track_location, 1) = 1
      ORDER BY
        CASE
          WHEN lt.site_name = 'GPS_OFF' THEN 0       -- alerts first (audit priority)
          WHEN lt.site_name IS NULL OR lt.site_name = 'Outside' THEN 2
          ELSE 1                                     -- in-site users
        END,
        lt.time DESC`
  ).all(sinceIso);

  const now = Date.now();
  res.json({
    stale_minutes: staleMin,
    as_of: new Date().toISOString(),
    users: rows.map(r => ({
      user_id: r.user_id,
      user_name: r.user_name,
      department: r.department,
      role: r.role,
      latitude: r.latitude,
      longitude: r.longitude,
      address: r.address,
      site_name: r.site_name,
      time: r.time,
      minutes_ago: Math.round((now - new Date(r.time).getTime()) / 60000),
    })),
  });
});

// GET /api/admin/locations/latest
//   ?stale_minutes=N   a ping newer than this counts as "live" (default 30)
//   ?horizon_days=N    ignore pings older than this so we don't pin someone to a
//                      week-old spot forever (default 7)
//
// Latest ping PER USER within the horizon — WITHOUT the live staleness cutoff —
// each tagged live vs "last seen". Powers the Team map: everyone on one map at
// once, live people at their live spot and everyone else at their last-known
// position (mam 2026-07-01: "show all team live or last location if not live").
router.get('/latest', (req, res) => {
  const db = getDb();
  const staleMin = Math.max(1, Math.min(1440, parseInt(req.query.stale_minutes, 10) || 30));
  const horizonDays = Math.max(1, Math.min(90, parseInt(req.query.horizon_days, 10) || 7));
  const sinceIso = new Date(Date.now() - horizonDays * 24 * 60 * 60 * 1000).toISOString();

  const rows = db.prepare(
    `SELECT lt.user_id, u.name as user_name, u.department, u.role,
            lt.latitude, lt.longitude, lt.address, lt.site_name, lt.time
       FROM location_tracking lt
       JOIN users u ON u.id = lt.user_id
       JOIN (
         SELECT user_id, MAX(time) as max_time
           FROM location_tracking
          WHERE time >= ?
          GROUP BY user_id
       ) latest ON latest.user_id = lt.user_id AND latest.max_time = lt.time
      WHERE COALESCE(u.track_location, 1) = 1
      ORDER BY lt.time DESC`
  ).all(sinceIso);

  const geofences = db.prepare(
    `SELECT site_name, latitude, longitude, radius_meters
       FROM geofence_settings WHERE active = 1`
  ).all();

  const now = Date.now();
  const liveMs = staleMin * 60 * 1000;
  const users = rows.map(r => {
    const ageMs = now - new Date(r.time).getTime();
    return {
      user_id: r.user_id, user_name: r.user_name, department: r.department, role: r.role,
      latitude: r.latitude, longitude: r.longitude, address: r.address, site_name: r.site_name,
      time: r.time,
      minutes_ago: Math.round(ageMs / 60000),
      live: ageMs <= liveMs,
    };
  });
  res.json({
    stale_minutes: staleMin, horizon_days: horizonDays, as_of: new Date().toISOString(),
    geofences,
    live_count: users.filter(u => u.live).length,
    users,
  });
});

// GET /api/admin/locations/timeline?user_id=N&date=YYYY-MM-DD
//
// All pings for that user on that date, ordered by time, with the
// straight-line distance from the previous ping in meters so mam can
// see "moved 540m between 11:02 and 11:18".
router.get('/timeline', (req, res) => {
  const userId = parseInt(req.query.user_id, 10);
  const date = (req.query.date || '').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.date : null;
  if (!userId || !date) return res.status(400).json({ error: 'user_id and date (YYYY-MM-DD) are required' });

  const db = getDb();
  const user = db.prepare('SELECT id, name, department, role FROM users WHERE id=?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const rows = db.prepare(
    `SELECT id, time, latitude, longitude, address, site_name
       FROM location_tracking
      WHERE user_id = ? AND date = ?
      ORDER BY time`
  ).all(userId, date);

  // Also pull the attendance punch in / out for that day so the UI can
  // show "where they went between IN and OUT" — mam's exact ask.
  const att = db.prepare(
    `SELECT punch_in_time, punch_out_time, punch_in_address, punch_out_address,
            site_name as att_site, total_hours, status
       FROM attendance WHERE user_id = ? AND date = ?`
  ).get(userId, date) || {};

  // Teleport detector — flag any ping that requires faster-than-car
  // travel (>120 km/h sustained) since the previous ping. This catches
  // GPS-spoof apps and cell-tower triangulation glitches (e.g. Aanchal's
  // 11:54 AM ping at Jalandhar, 53 km away from her office punch and
  // back in 1 minute = 3,180 km/h, physically impossible). Suspicious
  // pings still appear on the timeline but get a 'suspicious' flag so
  // the UI can flag them in red and EXCLUDE them from total distance.
  const SUSPICIOUS_KMH = 120;
  let totalMeters = 0;
  let suspiciousCount = 0;
  let lastValidIdx = -1;
  const enriched = rows.map((r, i) => {
    let distFromPrev = 0;
    let speedKmh = 0;
    let suspicious = false;
    if (lastValidIdx >= 0) {
      const prev = rows[lastValidIdx];
      distFromPrev = Math.round(haversine(prev.latitude, prev.longitude, r.latitude, r.longitude));
      const dtSec = (new Date(r.time).getTime() - new Date(prev.time).getTime()) / 1000;
      speedKmh = dtSec > 0 ? (distFromPrev / 1000) / (dtSec / 3600) : 0;
      if (speedKmh > SUSPICIOUS_KMH) {
        suspicious = true;
        suspiciousCount += 1;
      }
    }
    // Only count distance for non-suspicious pings, and advance lastValidIdx
    // to this ping only if it's clean — keeps the next gap measured from
    // the last *trusted* point so a single bogus ping doesn't double-charge.
    if (!suspicious) {
      totalMeters += distFromPrev;
      lastValidIdx = i;
    }
    let phase = 'during';
    const t = new Date(r.time).getTime();
    if (att.punch_in_time && t < new Date(att.punch_in_time).getTime()) phase = 'before';
    else if (att.punch_out_time && t > new Date(att.punch_out_time).getTime()) phase = 'after';
    return {
      ...r,
      dist_from_prev_m: distFromPrev,
      speed_kmh: Math.round(speedKmh),
      suspicious,
      phase,
    };
  });

  // Active geofences for office overlay on the map (faint blue circles)
  const geofences = db.prepare(
    `SELECT site_name, latitude, longitude, radius_meters
       FROM geofence_settings WHERE active = 1`
  ).all();

  res.json({
    user,
    date,
    ping_count: rows.length,
    total_distance_m: Math.round(totalMeters),
    attendance: {
      punch_in_time: att.punch_in_time || null,
      punch_out_time: att.punch_out_time || null,
      punch_in_address: att.punch_in_address || null,
      punch_out_address: att.punch_out_address || null,
      site_name: att.att_site || null,
      total_hours: att.total_hours || null,
      status: att.status || null,
    },
    pings: enriched,
    geofences,
    suspicious_count: suspiciousCount,
  });
});

// GET /api/admin/locations/users
//   helper for the timeline picker — list of every user that has any
//   location ping ever AND has not opted out (track_location != 0).
router.get('/users', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT DISTINCT u.id, u.name, u.department
       FROM location_tracking lt
       JOIN users u ON u.id = lt.user_id
      WHERE COALESCE(u.track_location, 1) = 1
      ORDER BY u.name`
  ).all();
  res.json(rows);
});

module.exports = router;
