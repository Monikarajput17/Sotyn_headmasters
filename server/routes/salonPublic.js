// Public online booking — NO auth (mounted at /api/salon/public). Lets a
// client self-book from a public link. Deliberately read-only except for the
// single /book endpoint, which find-or-creates a client by phone and creates a
// pending ('booked', source 'online') appointment for staff to confirm.
const express = require('express');
const { getDb } = require('../db/schema');
const { nextSequence } = require('../db/nextSequence');
const router = express.Router();

// Light in-memory rate limit per IP so the open endpoint can't be spammed.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000, max = 8;
  const arr = (hits.get(ip) || []).filter(t => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}

router.get('/info', (req, res) => {
  const s = getDb().prepare('SELECT salon_name, currency FROM salon_settings WHERE id=1').get() || {};
  res.json({ salon_name: s.salon_name || 'Sotyn.Headmasters', currency: s.currency || '₹' });
});

router.get('/services', (req, res) => {
  res.json(getDb().prepare(
    `SELECT s.id, s.name, s.price, s.duration_min, c.name AS category_name
     FROM services s LEFT JOIN service_categories c ON c.id = s.category_id
     WHERE s.active=1 ORDER BY c.sort_order, s.name`
  ).all());
});

router.get('/stylists', (req, res) => {
  res.json(getDb().prepare('SELECT id, name, specialization FROM stylists WHERE active=1 ORDER BY name').all());
});

router.post('/book', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) return res.status(429).json({ error: 'Too many requests — please try again in a minute.' });

  const b = req.body || {};
  const name = (b.name || '').trim();
  const phone = (b.phone || '').trim();
  if (!name) return res.status(400).json({ error: 'Please enter your name' });
  if (!/^\+?\d[\d\s-]{6,}$/.test(phone)) return res.status(400).json({ error: 'Please enter a valid phone number' });
  if (!b.appt_date) return res.status(400).json({ error: 'Please pick a date' });
  if (!b.start_time) return res.status(400).json({ error: 'Please pick a time' });
  const serviceIds = Array.isArray(b.service_ids) ? b.service_ids.slice(0, 10) : [];
  if (!serviceIds.length) return res.status(400).json({ error: 'Please choose at least one service' });

  const db = getDb();
  // Resolve services from the DB (never trust prices from the client).
  const svcRows = serviceIds.map(id => db.prepare('SELECT id, name, price, duration_min FROM services WHERE id=? AND active=1').get(id)).filter(Boolean);
  if (!svcRows.length) return res.status(400).json({ error: 'Selected services are unavailable' });
  const stylist = b.stylist_id ? db.prepare('SELECT id FROM stylists WHERE id=? AND active=1').get(b.stylist_id) : null;

  const tx = db.transaction(() => {
    // Find-or-create the client by phone.
    let client = db.prepare('SELECT * FROM salon_clients WHERE phone=?').get(phone);
    if (!client) {
      const code = nextSequence(db, 'salon_clients', 'client_code', 'CL-', { startFrom: 1000, pad: 4 });
      const r = db.prepare('INSERT INTO salon_clients (client_code, name, phone, email) VALUES (?,?,?,?)')
        .run(code, name, phone, b.email || '');
      client = { id: r.lastInsertRowid };
    }
    const totalDur = svcRows.reduce((s, x) => s + (x.duration_min || 0), 0);
    const [h, m] = String(b.start_time).split(':').map(Number);
    let end = null;
    if (!isNaN(h) && !isNaN(m)) {
      const t = h * 60 + m + totalDur; end = `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    }
    const apptNo = nextSequence(db, 'appointments', 'appt_no', 'APT-', { startFrom: 1000, pad: 5 });
    const ar = db.prepare(
      `INSERT INTO appointments (appt_no, client_id, stylist_id, appt_date, start_time, end_time, status, notes, source)
       VALUES (?,?,?,?,?,?, 'booked', ?, 'online')`
    ).run(apptNo, client.id, stylist ? stylist.id : null, b.appt_date, b.start_time, end, b.notes || '');
    const ins = db.prepare('INSERT INTO appointment_services (appointment_id, service_id, stylist_id, service_name, price) VALUES (?,?,?,?,?)');
    for (const s of svcRows) ins.run(ar.lastInsertRowid, s.id, stylist ? stylist.id : null, s.name, s.price);
    return apptNo;
  });

  try {
    const apptNo = tx();
    res.status(201).json({ message: 'Booked', appt_no: apptNo });
  } catch (e) {
    res.status(500).json({ error: 'Could not complete booking, please try again' });
  }
});

module.exports = router;
