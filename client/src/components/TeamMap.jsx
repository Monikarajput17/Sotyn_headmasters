// Team snapshot map — every tracked person as ONE marker on a single map:
// green = live (pinging now), grey = last seen (offline, shown at their most
// recent known spot), red = GPS off. No polyline (that's RouteMap's job for a
// single person's day). Office geofences drawn as faint blue circles.
// mam 2026-07-01: "show all team live or last location if not live".
//
// Pure Leaflet (no react-leaflet) to match RouteMap + stay React-19 safe.

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// A coloured dot marker (same look as RouteMap's start/end pins).
const dot = (color) =>
  L.divIcon({
    className: '',
    html: `<div style="background:${color};width:16px;height:16px;border:2px solid white;border-radius:50%;box-shadow:0 0 0 2px ${color};"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });

// Guard against null / NaN / (0,0) coords that would blow up Leaflet.
function isValidCoord(p) {
  if (!p) return false;
  const lat = Number(p.latitude);
  const lng = Number(p.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
    && !(lat === 0 && lng === 0);
}

function markerColor(p) {
  if (p.site_name === 'GPS_OFF') return '#ef4444';   // red — GPS off
  if (p.live) return '#10b981';                       // green — live now
  return '#9ca3af';                                   // grey — last seen (offline)
}

function agoText(mins) {
  if (mins == null) return '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ${mins % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function TeamMap({ people = [], geofences = [], height = 460 }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);

  const valid = (people || []).filter(isValidCoord);

  useEffect(() => {
    if (!containerRef.current) return;
    if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }

    const pts = (people || []).filter(isValidCoord);
    const vg = (geofences || []).filter(isValidCoord);
    if (pts.length === 0 && vg.length === 0) return;

    const map = L.map(containerRef.current, { zoomControl: true });
    mapRef.current = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap', maxZoom: 19,
    }).addTo(map);

    // Office geofences (faint blue circles)
    for (const g of vg) {
      L.circle([Number(g.latitude), Number(g.longitude)], {
        radius: g.radius_meters || 200,
        color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.08, weight: 1,
      }).bindTooltip(g.site_name || 'Office', { direction: 'top' }).addTo(map);
    }

    // One marker per person, with a permanent name label + click popup
    const markers = [];
    for (const p of pts) {
      const color = markerColor(p);
      const where = (p.site_name && p.site_name !== 'Outside' && p.site_name !== 'GPS_OFF')
        ? `📍 ${p.site_name}`
        : (p.address || `${Number(p.latitude).toFixed(5)}, ${Number(p.longitude).toFixed(5)}`);
      const status = p.site_name === 'GPS_OFF'
        ? '🔴 GPS off'
        : p.live ? '🟢 Live now' : `⚪ Last seen ${agoText(p.minutes_ago)}`;
      const m = L.marker([Number(p.latitude), Number(p.longitude)], { icon: dot(color) })
        .bindTooltip(p.user_name || 'Unknown', {
          permanent: true, direction: 'right', offset: [10, 0], className: 'team-map-label',
        })
        .bindPopup(`<b>${p.user_name || 'Unknown'}</b><br>${status}<br>${where}`)
        .addTo(map);
      markers.push(m);
    }

    // Fit to everyone + offices
    try {
      const group = L.featureGroup([
        ...markers,
        ...vg.map(g => L.circle([Number(g.latitude), Number(g.longitude)], { radius: g.radius_meters || 200 })),
      ]);
      map.fitBounds(group.getBounds(), { padding: [36, 36], maxZoom: 16 });
    } catch {
      if (pts[0]) map.setView([Number(pts[0].latitude), Number(pts[0].longitude)], 13);
    }

    return () => { if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } };
  }, [people, geofences]);

  if (valid.length === 0) {
    return (
      <div className="card p-6 text-center text-gray-400 text-sm">
        No team locations to show yet — no one has a recent GPS ping.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="rounded-lg border border-gray-200 overflow-hidden"
      style={{ height: `${height}px`, width: '100%' }}
    />
  );
}
