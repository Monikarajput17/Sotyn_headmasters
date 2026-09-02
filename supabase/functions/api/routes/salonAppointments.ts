// deno-lint-ignore-file no-explicit-any
// Salon Appointments — the booking calendar.
// Ported from server/routes/salonAppointments.js (Phase-3 Postgres version).
import { Router } from "../../_shared/express-lite.ts";
import pg from "../../_shared/pg.ts";
import { nextSequencePg } from "../../_shared/nextSequence.ts";
import { authMiddleware, requirePermission } from "../../_shared/auth.ts";
const router = Router();
router.use(authMiddleware);

const M = 'salon_appointments';

// Edge-function stand-in for server/services/notify (Twilio WhatsApp + SMS).
// Twilio isn't wired into the Edge Function, so this always reports "skipped" —
// the /:id/reminder endpoint then keeps its "Reminder logged" behaviour.
// deno-lint-ignore require-await
async function sendText(_opts: { mobile: string; body: string }): Promise<{ ok: boolean; skipped?: boolean; reason?: string }> {
  return { ok: false, skipped: true, reason: 'notify not configured' };
}

async function attachServices(appt: any) {
  appt.services = await pg.all(
    `SELECT aps.*, s.name AS svc_name FROM appointment_services aps
     LEFT JOIN services s ON s.id = aps.service_id WHERE aps.appointment_id=?`, appt.id);
  return appt;
}

// GET list — filter by date / range / stylist / status
router.get('/', requirePermission(M, 'view'), async (req, res) => {
  try {
    const { date, from, to, stylist_id, status, client_id } = req.query;
    let sql = `SELECT a.*, c.name AS client_name, c.phone AS client_phone, st.name AS stylist_name
               FROM appointments a
               LEFT JOIN salon_clients c ON c.id = a.client_id
               LEFT JOIN stylists st ON st.id = a.stylist_id WHERE 1=1`;
    const p: any[] = [];
    if (date) { sql += ' AND a.appt_date=?'; p.push(date); }
    if (from) { sql += ' AND a.appt_date>=?'; p.push(from); }
    if (to) { sql += ' AND a.appt_date<=?'; p.push(to); }
    if (stylist_id) { sql += ' AND a.stylist_id=?'; p.push(stylist_id); }
    if (client_id) { sql += ' AND a.client_id=?'; p.push(client_id); }
    if (status) { sql += ' AND a.status=?'; p.push(status); }
    sql += ' ORDER BY a.appt_date, a.start_time';
    const rows = await pg.all(sql, ...p);
    for (const a of rows) await attachServices(a);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.get('/:id', requirePermission(M, 'view'), async (req, res) => {
  try {
    const row = await pg.get(
      `SELECT a.*, c.name AS client_name, c.phone AS client_phone, st.name AS stylist_name
       FROM appointments a
       LEFT JOIN salon_clients c ON c.id = a.client_id
       LEFT JOIN stylists st ON st.id = a.stylist_id WHERE a.id=?`, req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(await attachServices(row));
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// helper: end time = start + total service duration
function computeEnd(startTime: string | null | undefined, minutes: number) {
  if (!startTime) return null;
  const [h, m] = startTime.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  const total = h * 60 + m + (minutes || 0);
  const eh = Math.floor(total / 60) % 24, em = total % 60;
  return `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
}

router.post('/', requirePermission(M, 'create'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.appt_date) return res.status(400).json({ error: 'Appointment date required' });
    const services: any[] = Array.isArray(b.services) ? b.services : [];
    const totalDur = services.reduce((s, x) => s + (Number(x.duration_min) || 0), 0);
    const end = b.end_time || computeEnd(b.start_time, totalDur);

    const { id, apptNo } = await pg.tx(async (t) => {
      const no = await nextSequencePg(t, 'appointments', 'appt_no', 'APT-', { startFrom: 1000, pad: 5 });
      const r = await t.run(
        `INSERT INTO appointments (appt_no, client_id, stylist_id, appt_date, start_time, end_time, status, notes, source, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        no, b.client_id || null, b.stylist_id || null, b.appt_date, b.start_time || null, end,
        b.status || 'booked', b.notes || '', b.source || 'walk-in', req.user.id);
      const apptId = r.lastInsertRowid;
      for (const s of services) {
        await t.run('INSERT INTO appointment_services (appointment_id, service_id, stylist_id, service_name, price) VALUES (?,?,?,?,?)',
          apptId, s.service_id || null, s.stylist_id || b.stylist_id || null, s.service_name || s.name || '', s.price || 0);
      }
      return { id: apptId, apptNo: no };
    });
    res.status(201).json({ id, appt_no: apptNo });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.put('/:id', requirePermission(M, 'edit'), async (req, res) => {
  try {
    const b = req.body || {};
    const existing = await pg.get('SELECT * FROM appointments WHERE id=?', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const services: any[] | null = Array.isArray(b.services) ? b.services : null;
    const totalDur = services ? services.reduce((s, x) => s + (Number(x.duration_min) || 0), 0) : 0;
    const end = b.end_time || (services ? computeEnd(b.start_time || existing.start_time, totalDur) : existing.end_time);
    await pg.tx(async (t) => {
      await t.run(
        `UPDATE appointments SET client_id=?, stylist_id=?, appt_date=?, start_time=?, end_time=?, status=?, notes=?, source=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        b.client_id ?? existing.client_id, b.stylist_id ?? existing.stylist_id, b.appt_date || existing.appt_date,
        b.start_time ?? existing.start_time, end, b.status || existing.status, b.notes ?? existing.notes,
        b.source || existing.source, req.params.id);
      if (services) {
        await t.run('DELETE FROM appointment_services WHERE appointment_id=?', req.params.id);
        for (const s of services) {
          await t.run('INSERT INTO appointment_services (appointment_id, service_id, stylist_id, service_name, price) VALUES (?,?,?,?,?)',
            req.params.id, s.service_id || null, s.stylist_id || b.stylist_id || null, s.service_name || s.name || '', s.price || 0);
        }
      }
    });
    res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Quick status change (confirm / complete / cancel / no-show)
router.patch('/:id/status', requirePermission(M, 'edit'), async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['booked', 'confirmed', 'completed', 'cancelled', 'no_show'].includes(status))
      return res.status(400).json({ error: 'Invalid status' });
    await pg.run('UPDATE appointments SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', status, req.params.id);
    res.json({ message: 'Status updated' });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Send an appointment reminder over WhatsApp + SMS (via the shared notify
// service, which safely no-ops when Twilio isn't configured).
router.post('/:id/reminder', requirePermission(M, 'edit'), async (req, res) => {
  try {
    const a = await pg.get(
      `SELECT a.*, c.name AS client_name, c.phone AS client_phone, st.name AS stylist_name
       FROM appointments a
       LEFT JOIN salon_clients c ON c.id = a.client_id
       LEFT JOIN stylists st ON st.id = a.stylist_id WHERE a.id=?`, req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!a.client_phone) return res.status(400).json({ error: 'Client has no phone number on file' });
    const s = await pg.get('SELECT salon_name FROM salon_settings WHERE id=1') || {};
    const salon = s.salon_name || 'Sotyn.Headmasters';
    const body = `Hi ${a.client_name || 'there'}, a friendly reminder of your appointment at ${salon} on ${a.appt_date}${a.start_time ? ' at ' + a.start_time : ''}${a.stylist_name ? ' with ' + a.stylist_name : ''}. See you soon! 💇`;
    let result: any;
    try {
      result = await sendText({ mobile: a.client_phone, body });
    } catch (e) { result = { ok: false, skipped: true, reason: (e as Error).message }; }
    await pg.run('UPDATE appointments SET reminder_sent=1, updated_at=CURRENT_TIMESTAMP WHERE id=?', a.id);
    if (!result || result.ok === false || result.skipped) {
      return res.json({ message: 'Reminder logged. To actually deliver WhatsApp/SMS, configure Twilio in .env.', skipped: true, preview: body });
    }
    res.json({ message: 'Reminder sent', preview: body });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.delete('/:id', requirePermission(M, 'delete'), async (req, res) => {
  try {
    await pg.run('DELETE FROM appointments WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

export default router;
