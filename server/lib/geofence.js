// Shared geofence math + the "is this punch inside a site?" decision, used by
// punch-in, punch-out AND live track-location so all three behave identically.
//
// WHY THIS EXISTS — mam, recurring complaint: "some in office but say out of
// area / person on exact location but says outside". 95% of punches come from
// PHONES. Indoors a phone's GPS is weak: it either reports a large accuracy
// radius (300m–2km), or — worse — a "confident but wrong" network fix (small
// accuracy, wrong spot). The OLD rule clamped GPS tolerance to a hard 500m, so
// a person standing AT site whose phone was off by >700m got told "you are
// 3200m away" and was BLOCKED from punching. That false block is the bug.
//
// NEW RULE (uncertainty-honest):
//   • Treat the punch as INSIDE when the GPS uncertainty circle overlaps the
//     geofence:  distance - accuracy <= radius.  Accuracy is no longer capped
//     low, so a coarse fix earns a correspondingly large benefit of the doubt.
//   • A staff member is ONLY ever hard-BLOCKED when the phone has a GOOD GPS
//     lock (accuracy <= trust threshold) that places them CONFIDENTLY outside
//     every site. A weak / coarse / unknown fix can never block someone who
//     might be on-site — it is ALLOWED but tagged location_verified=0 so admin
//     can audit it. The selfie remains the real proof of presence (auto-punch
//     is disabled for exactly this accountability reason).

// Haversine — great-circle distance between two lat/lng points, in metres.
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Tolerance defaults (metres). Overridable per-deployment from payroll_settings
// so mam can tune strictness without a code deploy.
const GEO_DEFAULTS = {
  floor: 50,     // ignore sub-50m jitter — every fix gets at least this much slack
  ceiling: 3000, // never grant more than 3km benefit of the doubt (sanity cap)
  trust: 200,    // accuracy <= this = a real GPS lock we trust enough to BLOCK on
};

// Read the (optional) tunable thresholds from payroll_settings. Falls back to
// GEO_DEFAULTS if the columns/table aren't present (stale DB) or are blank.
function geoSettings(db) {
  const s = { ...GEO_DEFAULTS };
  try {
    const r = db.prepare(
      'SELECT geo_accuracy_floor_m AS f, geo_accuracy_ceiling_m AS c, geo_trust_accuracy_m AS t FROM payroll_settings WHERE id=1'
    ).get();
    if (r) {
      if (+r.f > 0) s.floor = +r.f;
      if (+r.c > 0) s.ceiling = +r.c;
      if (+r.t > 0) s.trust = +r.t;
    }
  } catch { /* columns not present on a stale DB — use defaults */ }
  // Guard against a misconfiguration where floor > ceiling.
  if (s.floor > s.ceiling) s.floor = s.ceiling;
  return s;
}

// Decide whether a punch / tracking ping counts as on-site.
//
// Returns:
//   {
//     allow,        // boolean — may this person punch here?
//     verified,     // 1 = trustworthy GPS lock confirms on-site; 0 = allowed but unconfirmed
//     decision,     // 'inside' | 'coarse_allow' | 'outside'
//     matchedSite,  // site name they were matched to ('' when none)
//     nearestSite,  // closest site name (for messaging)
//     nearestDist,  // metres to closest site (rounded; null if no geofences)
//     accuracyUsed, // the clamped accuracy used in the overlap test
//   }
function evaluateGeofence(lat, lng, accuracy, geofences, settings = GEO_DEFAULTS) {
  const accRaw = +accuracy || 0;
  const acc = Math.min(Math.max(accRaw, settings.floor), settings.ceiling);
  let nearest = { dist: Infinity, gf: null };
  let matched = null;
  for (const gf of geofences || []) {
    const d = haversine(+lat, +lng, gf.latitude, gf.longitude);
    if (d < nearest.dist) nearest = { dist: d, gf };
    if (!matched && d - acc <= (gf.radius_meters || 200)) matched = gf; // uncertainty overlaps this site
  }
  const nearestSite = nearest.gf?.site_name || '';
  const nearestDist = nearest.dist === Infinity ? null : Math.round(nearest.dist);
  const goodFix = accRaw > 0 && accRaw <= settings.trust; // a real GPS lock, precise enough to trust

  if (matched) {
    // Uncertainty circle overlaps a site → treat as inside. "verified" only when
    // the fix was a trustworthy lock; a coarse fix that merely overlapped is
    // allowed but flagged for admin review.
    return {
      allow: true, verified: goodFix ? 1 : 0, decision: 'inside',
      matchedSite: matched.site_name || '', nearestSite, nearestDist, accuracyUsed: Math.round(acc),
    };
  }
  if (!goodFix) {
    // Weak / unknown fix that doesn't overlap any site — we CANNOT prove they're
    // away (indoor GPS is unreliable), so we never block them. Allowed + flagged.
    return {
      allow: true, verified: 0, decision: 'coarse_allow',
      matchedSite: nearestSite, nearestSite, nearestDist, accuracyUsed: Math.round(acc),
    };
  }
  // Good GPS lock that doesn't overlap any site. Only BLOCK when the person is
  // CLEARLY beyond the nearest site edge by a safety margin — GPS drifts and site
  // coords/radius are often approximate, so a borderline "outside" precise fix is
  // ALLOWED + flagged instead of blocked (mam 2026-06-30: on-site staff were being
  // falsely blocked). Genuinely-far punches (beyond the margin) still block, so
  // geofencing is preserved.
  const nearRadius = (nearest.gf?.radius_meters || 200);
  const blockBuffer = (settings && settings.blockBuffer) || 300;
  if (nearest.dist - acc <= nearRadius + blockBuffer) {
    return {
      allow: true, verified: 0, decision: 'coarse_allow',
      matchedSite: nearestSite, nearestSite, nearestDist, accuracyUsed: Math.round(acc),
    };
  }
  return {
    allow: false, verified: 0, decision: 'outside',
    matchedSite: '', nearestSite, nearestDist, accuracyUsed: Math.round(acc),
  };
}

module.exports = { haversine, evaluateGeofence, geoSettings, GEO_DEFAULTS };
