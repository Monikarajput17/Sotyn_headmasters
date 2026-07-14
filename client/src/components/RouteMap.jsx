// Embedded movement-trail map. Pure Leaflet (no react-leaflet) so it
// stays compatible with React 19 without dragging in extra peer-dep
// pinning. Used on Location Tracking → Timeline to draw the day's GPS
// pings as a red polyline with start (green) and end (red) markers.
//
// Tiles come from OpenStreetMap (free, no API key). Office geofences are
// drawn as faint blue circles when passed via props.

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Leaflet's default marker icons reference assets under /node_modules
// which Vite doesn't bundle by default — point them at the unpkg CDN
// so the markers actually show up. One-shot fix per app load.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const colored = (color) =>
  L.divIcon({
    className: '',
    html: `<div style="background:${color};width:14px;height:14px;border:2px solid white;border-radius:50%;box-shadow:0 0 0 2px ${color};"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });

// Coerce + validate a ping's lat/lng — Leaflet's LatLng constructor
// internally accesses `.lat` on the input, so a single null or NaN
// coord blows up the whole map render with "Cannot read properties of
// null (reading 'lat')".  Mam hit this in prod on the Timeline tab
// when one of the day's pings had NULL coordinates (cell-tower
// triangulation glitch, GPS_OFF marker rows, or schema-default rows).
function isValidCoord(p) {
  if (!p) return false;
  const lat = Number(p.latitude);
  const lng = Number(p.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
    && !(lat === 0 && lng === 0);  // (0,0) is almost always a GPS-off sentinel
}

export default function RouteMap({ pings = [], geofences = [], height = 360 }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);

  // Filter to only pings with usable coordinates BEFORE anything
  // touches Leaflet.  Empty result → friendly empty state.  We
  // recompute inside the effect too so the effect's deps stay
  // referentially stable (original prop arrays).
  const validPings = (pings || []).filter(isValidCoord);
  const validGeofences = (geofences || []).filter(isValidCoord);

  useEffect(() => {
    if (!containerRef.current) return;
    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
    }
    const validPings    = (pings    || []).filter(isValidCoord);
    const validGeofences = (geofences || []).filter(isValidCoord);
    if (validPings.length === 0) return;

    // Initialise map centred on the first ping
    const map = L.map(containerRef.current, { zoomControl: true });
    mapRef.current = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(map);

    // Office geofences (faint blue circles)
    for (const g of validGeofences) {
      L.circle([g.latitude, g.longitude], {
        radius: g.radius_meters || 200,
        color: '#3b82f6',
        fillColor: '#3b82f6',
        fillOpacity: 0.08,
        weight: 1,
      })
        .bindTooltip(g.site_name || 'Office', { permanent: false, direction: 'top' })
        .addTo(map);
    }

    // Day's route as red polyline
    const latlngs = validPings.map((p) => [Number(p.latitude), Number(p.longitude)]);
    const route = L.polyline(latlngs, {
      color: '#dc2626',
      weight: 4,
      opacity: 0.85,
      smoothFactor: 1.2,
    }).addTo(map);

    // Direction arrows along the line — manual midpoint markers every Nth ping
    const arrowEvery = Math.max(1, Math.floor(validPings.length / 10));
    validPings.forEach((p, i) => {
      if (i === 0 || i === validPings.length - 1) return;
      if (i % arrowEvery !== 0) return;
      const lat = Number(p.latitude), lng = Number(p.longitude);
      L.circleMarker([lat, lng], {
        radius: 3,
        color: '#dc2626',
        fillColor: '#dc2626',
        fillOpacity: 1,
        weight: 0,
      })
        .bindTooltip(
          `${p.time_str || p.time || ''}<br>${p.address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`}`,
          { direction: 'top' }
        )
        .addTo(map);
    });

    // Start (green) and End (red) markers
    const start = validPings[0];
    const end = validPings[validPings.length - 1];
    L.marker([Number(start.latitude), Number(start.longitude)], { icon: colored('#10b981') })
      .bindPopup(`<b>Start</b><br>${start.time_str || start.time || ''}<br>${start.address || ''}`)
      .addTo(map);
    if (validPings.length > 1) {
      L.marker([Number(end.latitude), Number(end.longitude)], { icon: colored('#dc2626') })
        .bindPopup(`<b>Last seen</b><br>${end.time_str || end.time || ''}<br>${end.address || ''}`)
        .addTo(map);
    }

    // Fit map to the polyline + geofences
    try {
      const group = L.featureGroup([route, ...validGeofences.map(g =>
        L.circle([g.latitude, g.longitude], { radius: g.radius_meters || 200 })
      )]);
      map.fitBounds(group.getBounds(), { padding: [24, 24] });
    } catch {
      map.setView([Number(start.latitude), Number(start.longitude)], 14);
    }

    // Cleanup when component unmounts or pings change
    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [pings, geofences]);

  if (validPings.length === 0) {
    const droppedCount = (pings || []).length - validPings.length;
    return (
      <div className="card p-6 text-center text-gray-400 text-sm">
        {droppedCount > 0
          ? `No mappable GPS pings (${droppedCount} ping${droppedCount > 1 ? 's' : ''} had missing or invalid coordinates).`
          : 'No GPS pings to plot on the map yet.'}
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
