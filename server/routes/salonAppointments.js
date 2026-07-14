// Salon Appointments — the booking calendar.
const express = require('express');
const { getDb } = require('../db/schema');
const { nextSequence } = require('../db/nextSequence');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const M = 'salon_appointments';

function attachServices(db, appt) {
  appt.services = db.prepare(
    `SELECT aps.*, s.name AS svc_name FROM appointment_services aps
     LEFT JOIN services s ON s.id = aps.service_id WHERE aps.appointment_id=?`
  ).all(appt.id);
  return appt;
}

// GET list — filter by date / range / stylist / status
router.get('/', requirePermission(M, 'view'), (req, res) => {
  const { date, from, to, stylist_id, status, client_id } = req.query;
  const db = getDb();
  let sql = `SELECT a.*, c.name AS client_name, c.phone AS client_phone, st.name AS stylist_name
             FROM appointments a
             LEFT JOIN salon_clients c ON c.id = a.client_id
             LEFT JOIN stylists st ON st.id = a.stylist_id WHERE 1=1`;
  const p = [];
  if (date) { sql += ' AND a.appt_date=?'; p.push(date); }
  if (from) { sql += ' AND a.appt_date>=?'; p.push(from); }
  if (to) { sql += ' AND a.appt_date<=?'; p.push(to); }
  if (stylist_id) { sql += ' AND a.stylist_id=?'; p.push(stylist_id); }
  if (client_id) { sql += ' AND a.client_id=?'; p.push(client_id); }
  if (status) { sql += ' AND a.status=?'; p.push(status); }
  sql += ' ORDER BY a.appt_date, a.start_time';
  const rows = db.prepare(sql).all(...p).map(a => attachServices(db, a));
  res.json(rows);
});

router.get('/:id', requirePermission(M, 'view'), (req, res) => {
  const db = getDb();
  const row = db.prepare(
    `SELECT a.*, c.name AS client_name, c.phone AS client_phone, st.name AS stylist_name
     FROM appointments a
     LEFT JOIN salon_clients c ON c.id = a.client_id
     LEFT JOIN stylists st ON st.id = a.stylist_id WHERE a.id=?`
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(attachServices(db, row));
});

// helper: end time = start + total service duration
function computeEnd(startTime, minutes) {
  if (!startTime) return null;
  const [h, m] = startTime.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  const total = h * 60 + m + (minutes || 0);
  const eh = Math.floor(total / 60) % 24, em = total % 60;
  return `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
}

router.post('/', requirePermission(M, 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.appt_date) return res.status(400).json({ error: 'Appointment date required' });
  const db = getDb();
  const services = Array.isArray(b.services) ? b.services : [];
  const totalDur = services.reduce((s, x) => s + (Number(x.duration_min) || 0), 0);
  const end = b.end_time || computeEnd(b.start_time, totalDur);
  const apptNo = nextSequence(db, 'appointments', 'appt_no', 'APT-', { startFrom: 1000, pad: 5 });

  const tx = db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO appointments (appt_no, client_id, stylist_id, appt_date, start_time, end_time, status, notes, source, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(apptNo, b.client_id || null, b.stylist_id || null, b.appt_date, b.start_time || null, end,
          b.status || 'booked', b.notes || '', b.source || 'walk-in', req.user.id);
    const apptId = r.lastInsertRowid;
    const ins = db.prepare('INSERT INTO appointment_services (appointment_id, service_id, stylist_id, service_name, price) VALUES (?,?,?,?,?)');
    for (const s of services) ins.run(apptId, s.service_id || null, s.stylist_id || b.stylist_id || null, s.service_name || s.name || '', s.price || 0);
    return apptId;
  });
  const id = tx();
  res.status(201).json({ id, appt_no: apptNo });
});

router.put('/:id', requirePermission(M, 'edit'), (req, res) => {
  const b = req.body || {};
  const db = getDb();
  const existing = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const services = Array.isArray(b.services) ? b.services : null;
  const totalDur = services ? services.reduce((s, x) => s + (Number(x.duration_min) || 0), 0) : 0;
  const end = b.end_time || (services ? computeEnd(b.start_time || existing.start_time, totalDur) : existing.end_time);
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE appointments SET client_id=?, stylist_id=?, appt_date=?, start_time=?, end_time=?, status=?, notes=?, source=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
    ).run(b.client_id ?? existing.client_id, b.stylist_id ?? existing.stylist_id, b.appt_date || existing.appt_date,
          b.start_time ?? existing.start_time, end, b.status || existing.status, b.notes ?? existing.notes,
          b.source || existing.source, req.params.id);
    if (services) {
      db.prepare('DELETE FROM appointment_services WHERE appointment_id=?').run(req.params.id);
      const ins = db.prepare('INSERT INTO appointment_services (appointment_id, service_id, stylist_id, service_name, price) VALUES (?,?,?,?,?)');
      for (const s of services) ins.run(req.params.id, s.service_id || null, s.stylist_id || b.stylist_id || null, s.service_name || s.name || '', s.price || 0);
    }
  });
  tx();
  res.json({ message: 'Updated' });
});

// Quick status change (confirm / complete / cancel / no-show)
router.patch('/:id/status', requirePermission(M, 'edit'), (req, res) => {
  const { status } = req.body || {};
  if (!['booked', 'confirmed', 'completed', 'cancelled', 'no_show'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  getDb().prepare('UPDATE appointments SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, req.params.id);
  res.json({ message: 'Status updated' });
});

// Send an appointment reminder over WhatsApp + SMS (via the shared notify
// service, which safely no-ops when Twilio isn't configured).
router.post('/:id/reminder', requirePermission(M, 'edit'), async (req, res) => {
  const db = getDb();
  const a = db.prepare(
    `SELECT a.*, c.name AS client_name, c.phone AS client_phone, st.name AS stylist_name
     FROM appointments a
     LEFT JOIN salon_clients c ON c.id = a.client_id
     LEFT JOIN stylists st ON st.id = a.stylist_id WHERE a.id=?`
  ).get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (!a.client_phone) return res.status(400).json({ error: 'Client has no phone number on file' });
  const s = db.prepare('SELECT salon_name FROM salon_settings WHERE id=1').get() || {};
  const salon = s.salon_name || 'Sotyn.Headmasters';
  const body = `Hi ${a.client_name || 'there'}, a friendly reminder of your appointment at ${salon} on ${a.appt_date}${a.start_time ? ' at ' + a.start_time : ''}${a.stylist_name ? ' with ' + a.stylist_name : ''}. See you soon! 💇`;
  let result;
  try {
    const { sendText } = require('../services/notify');
    result = await sendText({ mobile: a.client_phone, body });
  } catch (e) { result = { ok: false, skipped: true, reason: e.message }; }
  db.prepare('UPDATE appointments SET reminder_sent=1, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(a.id);
  if (!result || result.ok === false || result.skipped) {
    return res.json({ message: 'Reminder logged. To actually deliver WhatsApp/SMS, configure Twilio in .env.', skipped: true, preview: body });
  }
  res.json({ message: 'Reminder sent', preview: body });
});

router.delete('/:id', requirePermission(M, 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM appointments WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
