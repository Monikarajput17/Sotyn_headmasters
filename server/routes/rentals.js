// Room Rental management — properties (flats/houses we rent),
// rooms within them, bookings (which employee stays where + when),
// and monthly rent payments to landlord. Used to track staff
// accommodation across project sites.

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission, adminOnly } = require('../middleware/auth');

router.use(authMiddleware);

// ---------- PIN CODE → METRO / NON-METRO ----------
// Metro = the 8 major cities (mam 2026-06-23). A PIN is "verified" via the
// free India Post API (no key); if that's unreachable we fall back to the
// PIN's region prefix so classification still works offline.
const METRO_CITY_WORDS = [
  'delhi', 'new delhi', 'mumbai', 'navi mumbai', 'kolkata', 'calcutta',
  'chennai', 'bengaluru', 'bangalore', 'hyderabad', 'pune', 'ahmedabad',
];
// First-3-digit PIN prefixes of those 8 metros (offline fallback).
const METRO_PIN_PREFIXES = ['110', '400', '700', '600', '560', '500', '411', '380'];

function classifyByName(...parts) {
  const hay = parts.filter(Boolean).join(' ').toLowerCase();
  return METRO_CITY_WORDS.some(w => hay.includes(w)) ? 'Metro' : 'Non-Metro';
}
function classifyByPrefix(pin) {
  return METRO_PIN_PREFIXES.includes(String(pin).slice(0, 3)) ? 'Metro' : 'Non-Metro';
}

// GET /rentals/pincode/:pin — verify a PIN and return city + metro/non-metro.
router.get('/pincode/:pin', requirePermission('rentals', 'view'), async (req, res) => {
  const pin = String(req.params.pin || '').trim();
  if (!/^\d{6}$/.test(pin)) return res.status(400).json({ error: 'PIN code must be 6 digits' });
  let city = null, district = null, state = null, metro_type = null, verified = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch(`https://api.postalpincode.in/pincode/${pin}`, { signal: ctrl.signal });
    clearTimeout(t);
    const data = await resp.json();
    const po = data && data[0] && data[0].Status === 'Success' && data[0].PostOffice && data[0].PostOffice[0];
    if (po) {
      district = po.District || null; state = po.State || null;
      city = po.Block && po.Block !== 'NA' ? po.Block : (po.District || null);
      metro_type = classifyByName(po.Name, po.Block, po.District, po.State);
      verified = true;
    }
  } catch (_) { /* fall back to prefix below */ }
  if (!metro_type) metro_type = classifyByPrefix(pin);
  res.json({ pin, verified, city, district, state, metro_type });
});

// ---------- DASHBOARD STATS ----------
router.get('/stats', requirePermission('rentals', 'view'), (req, res) => {
  try {
    const db = getDb();
    const totalProps = db.prepare(`SELECT COUNT(*) as c FROM rental_properties WHERE status='active'`).get().c;
    const totalRooms = db.prepare(`SELECT COUNT(*) as c FROM rental_rooms`).get().c;
    const occupiedRooms = db.prepare(`SELECT COUNT(*) as c FROM rental_rooms WHERE status='occupied'`).get().c;
    const monthlyBurn = db.prepare(`SELECT COALESCE(SUM(monthly_rent),0) as s FROM rental_properties WHERE status='active'`).get().s;
    const totalDeposit = db.prepare(`SELECT COALESCE(SUM(deposit_paid),0) as s FROM rental_properties WHERE status='active'`).get().s;
    const expiringSoon = db.prepare(`
      SELECT COUNT(*) as c FROM rental_properties
      WHERE status='active' AND agreement_end_date IS NOT NULL
        AND agreement_end_date <= date('now', '+30 days')
    `).get().c;
    const activeBookings = db.prepare(`SELECT COUNT(*) as c FROM rental_bookings WHERE status='active'`).get().c;
    res.json({
      total_properties: totalProps,
      total_rooms: totalRooms,
      occupied_rooms: occupiedRooms,
      vacant_rooms: totalRooms - occupiedRooms,
      monthly_burn: monthlyBurn,
      total_deposit_locked: totalDeposit,
      agreements_expiring_30d: expiringSoon,
      active_bookings: activeBookings,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- PROPERTIES ----------
router.get('/properties', requirePermission('rentals', 'view'), (req, res) => {
  try {
    const { status, search, city } = req.query;
    let sql = `
      SELECT p.*, s.name as site_name,
             (SELECT COUNT(*) FROM rental_rooms r WHERE r.property_id = p.id) as room_count,
             (SELECT COUNT(*) FROM rental_rooms r WHERE r.property_id = p.id AND r.status='occupied') as occupied_count,
             (SELECT COUNT(*) FROM rental_bookings b WHERE b.property_id = p.id AND b.status='active') as active_bookings
      FROM rental_properties p
      LEFT JOIN sites s ON s.id = p.site_id
      WHERE 1=1
    `;
    const params = [];
    if (status) { sql += ' AND p.status = ?'; params.push(status); }
    if (city) { sql += ' AND LOWER(p.city) LIKE ?'; params.push(`%${city.toLowerCase()}%`); }
    if (search) {
      sql += ' AND (LOWER(p.name) LIKE ? OR LOWER(p.address) LIKE ? OR LOWER(p.landlord_name) LIKE ?)';
      const q = `%${search.toLowerCase()}%`;
      params.push(q, q, q);
    }
    sql += ' ORDER BY p.created_at DESC';
    res.json(getDb().prepare(sql).all(...params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/properties/:id', requirePermission('rentals', 'view'), (req, res) => {
  const db = getDb();
  const prop = db.prepare(`
    SELECT p.*, s.name as site_name FROM rental_properties p
    LEFT JOIN sites s ON s.id = p.site_id
    WHERE p.id = ?
  `).get(req.params.id);
  if (!prop) return res.status(404).json({ error: 'Not found' });
  const rooms = db.prepare(`
    SELECT r.*,
           (SELECT COUNT(*) FROM rental_bookings b WHERE b.room_id = r.id AND b.status='active') as occupant_count
    FROM rental_rooms r WHERE r.property_id = ? ORDER BY r.id
  `).all(req.params.id);
  const bookings = db.prepare(`
    SELECT b.*, r.room_name, u.name as occupant_user_name
    FROM rental_bookings b
    LEFT JOIN rental_rooms r ON r.id = b.room_id
    LEFT JOIN users u ON u.id = b.occupant_user_id
    WHERE b.property_id = ?
    ORDER BY b.status='active' DESC, b.check_in_date DESC
  `).all(req.params.id);
  const payments = db.prepare(`
    SELECT * FROM rental_payments WHERE property_id = ? ORDER BY period_month DESC
  `).all(req.params.id);
  res.json({ ...prop, rooms, bookings, payments });
});

router.post('/properties', requirePermission('rentals', 'create'), (req, res) => {
  try {
    const b = req.body;
    if (!b.name) return res.status(400).json({ error: 'Name is required' });
    const db = getDb();
    const r = db.prepare(`
      INSERT INTO rental_properties (
        name, address, city, state, pincode,
        landlord_name, landlord_phone, landlord_email,
        monthly_rent, deposit_paid, agreement_start_date, agreement_end_date,
        bedrooms, total_capacity, amenities, agreement_file_url,
        status, notes, site_id, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      b.name, b.address || null, b.city || null, b.state || null, b.pincode || null,
      b.landlord_name || null, b.landlord_phone || null, b.landlord_email || null,
      b.monthly_rent || 0, b.deposit_paid || 0, b.agreement_start_date || null, b.agreement_end_date || null,
      b.bedrooms || 1, b.total_capacity || 1, b.amenities || null, b.agreement_file_url || null,
      b.status || 'active', b.notes || null, b.site_id || null, req.user.id
    );
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/properties/:id', requirePermission('rentals', 'edit'), (req, res) => {
  try {
    const b = req.body;
    const db = getDb();
    const fields = ['name','address','city','state','pincode','landlord_name','landlord_phone','landlord_email','monthly_rent','deposit_paid','agreement_start_date','agreement_end_date','bedrooms','total_capacity','amenities','agreement_file_url','status','notes','site_id'];
    const sets = []; const vals = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f}=?`); vals.push(b[f]); }
    if (!sets.length) return res.status(400).json({ error: 'No fields' });
    sets.push('updated_at=CURRENT_TIMESTAMP');
    vals.push(req.params.id);
    db.prepare(`UPDATE rental_properties SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/properties/:id', requirePermission('rentals', 'delete'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM rental_payments WHERE property_id=?').run(req.params.id);
  db.prepare('DELETE FROM rental_bookings WHERE property_id=?').run(req.params.id);
  db.prepare('DELETE FROM rental_rooms WHERE property_id=?').run(req.params.id);
  db.prepare('DELETE FROM rental_properties WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ---------- ROOMS ----------
router.post('/properties/:property_id/rooms', requirePermission('rentals', 'create'), (req, res) => {
  try {
    const b = req.body;
    if (!b.room_name) return res.status(400).json({ error: 'Room name required' });
    const r = getDb().prepare(`
      INSERT INTO rental_rooms (property_id, room_name, capacity, status, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.params.property_id, b.room_name, b.capacity || 1, b.status || 'available', b.notes || null);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/rooms/:id', requirePermission('rentals', 'edit'), (req, res) => {
  try {
    const b = req.body;
    const db = getDb();
    const fields = ['room_name','capacity','status','notes'];
    const sets = []; const vals = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f}=?`); vals.push(b[f]); }
    if (!sets.length) return res.status(400).json({ error: 'No fields' });
    vals.push(req.params.id);
    db.prepare(`UPDATE rental_rooms SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/rooms/:id', requirePermission('rentals', 'delete'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM rental_bookings WHERE room_id=?').run(req.params.id);
  db.prepare('DELETE FROM rental_rooms WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ---------- BOOKINGS ----------
router.get('/bookings', requirePermission('rentals', 'view'), (req, res) => {
  try {
    const { status, occupant_user_id, site_id } = req.query;
    let sql = `
      SELECT b.*, r.room_name, p.name as property_name, p.city,
             u.name as occupant_user_name, s.name as site_name
      FROM rental_bookings b
      LEFT JOIN rental_rooms r ON r.id = b.room_id
      LEFT JOIN rental_properties p ON p.id = b.property_id
      LEFT JOIN users u ON u.id = b.occupant_user_id
      LEFT JOIN sites s ON s.id = b.site_id
      WHERE 1=1
    `;
    const params = [];
    if (status) { sql += ' AND b.status=?'; params.push(status); }
    if (occupant_user_id) { sql += ' AND b.occupant_user_id=?'; params.push(occupant_user_id); }
    if (site_id) { sql += ' AND b.site_id=?'; params.push(site_id); }
    sql += ' ORDER BY b.status="active" DESC, b.check_in_date DESC';
    res.json(getDb().prepare(sql).all(...params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/bookings', requirePermission('rentals', 'create'), (req, res) => {
  try {
    const b = req.body;
    if (!b.room_id || !b.check_in_date) return res.status(400).json({ error: 'room_id and check_in_date required' });
    if (!b.occupant_user_id && !b.occupant_name) return res.status(400).json({ error: 'Pick a user or type occupant name' });
    const db = getDb();
    const room = db.prepare('SELECT property_id, capacity, status FROM rental_rooms WHERE id=?').get(b.room_id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const tx = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO rental_bookings (
          room_id, property_id, occupant_user_id, occupant_name, occupant_phone,
          check_in_date, check_out_date, site_id, rent_share, deposit_collected,
          status, notes, created_by
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        b.room_id, room.property_id, b.occupant_user_id || null, b.occupant_name || null, b.occupant_phone || null,
        b.check_in_date, b.check_out_date || null, b.site_id || null,
        b.rent_share || 0, b.deposit_collected || 0,
        'active', b.notes || null, req.user.id
      );
      // Mark room occupied
      db.prepare(`UPDATE rental_rooms SET status='occupied' WHERE id=?`).run(b.room_id);
      return r.lastInsertRowid;
    });
    const id = tx();
    // Notify the occupant if they're a user
    if (b.occupant_user_id) {
      try {
        const { notify } = require('../lib/push');
        notify(b.occupant_user_id, {
          title: '🏠 Room Booked for You',
          body: `Check-in ${b.check_in_date} at ${b.occupant_name || 'rental property'}`,
          url: '/rentals',
          tag: `booking-${id}`,
        });
      } catch {}
    }
    res.status(201).json({ id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/bookings/:id', requirePermission('rentals', 'edit'), (req, res) => {
  try {
    const b = req.body;
    const db = getDb();
    const fields = ['occupant_user_id','occupant_name','occupant_phone','check_in_date','check_out_date','actual_checkout_date','site_id','rent_share','deposit_collected','status','notes'];
    const sets = []; const vals = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f}=?`); vals.push(b[f]); }
    if (!sets.length) return res.status(400).json({ error: 'No fields' });
    vals.push(req.params.id);
    db.prepare(`UPDATE rental_bookings SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/bookings/:id/check-out', requirePermission('rentals', 'edit'), (req, res) => {
  try {
    const db = getDb();
    const booking = db.prepare('SELECT * FROM rental_bookings WHERE id=?').get(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Not found' });
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE rental_bookings
        SET status='completed',
            actual_checkout_date = COALESCE(?, date('now')),
            notes = COALESCE(?, notes)
        WHERE id=?
      `).run(req.body.actual_checkout_date || null, req.body.notes || null, req.params.id);
      // If no other active bookings on this room, mark available
      const others = db.prepare(`SELECT COUNT(*) as c FROM rental_bookings WHERE room_id=? AND status='active' AND id != ?`).get(booking.room_id, req.params.id).c;
      if (others === 0) db.prepare(`UPDATE rental_rooms SET status='available' WHERE id=?`).run(booking.room_id);
    });
    tx();
    res.json({ message: 'Checked out' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/bookings/:id', requirePermission('rentals', 'delete'), (req, res) => {
  const db = getDb();
  const booking = db.prepare('SELECT room_id FROM rental_bookings WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM rental_bookings WHERE id=?').run(req.params.id);
  if (booking) {
    const others = db.prepare(`SELECT COUNT(*) as c FROM rental_bookings WHERE room_id=? AND status='active'`).get(booking.room_id).c;
    if (others === 0) db.prepare(`UPDATE rental_rooms SET status='available' WHERE id=?`).run(booking.room_id);
  }
  res.json({ message: 'Deleted' });
});

// ---------- PAYMENTS ----------
router.get('/payments', requirePermission('rentals', 'view'), (req, res) => {
  try {
    const { property_id, period_month } = req.query;
    let sql = `
      SELECT pay.*, p.name as property_name, p.landlord_name
      FROM rental_payments pay
      LEFT JOIN rental_properties p ON p.id = pay.property_id
      WHERE 1=1
    `;
    const params = [];
    if (property_id) { sql += ' AND pay.property_id=?'; params.push(property_id); }
    if (period_month) { sql += ' AND pay.period_month=?'; params.push(period_month); }
    sql += ' ORDER BY pay.period_month DESC, pay.created_at DESC';
    res.json(getDb().prepare(sql).all(...params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/payments', requirePermission('rentals', 'create'), (req, res) => {
  try {
    const b = req.body;
    if (!b.property_id || !b.period_month) return res.status(400).json({ error: 'property_id and period_month required' });
    const db = getDb();
    db.prepare(`
      INSERT INTO rental_payments (property_id, period_month, amount_paid, paid_date, paid_via, transaction_ref, receipt_url, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(property_id, period_month) DO UPDATE SET
        amount_paid=excluded.amount_paid,
        paid_date=excluded.paid_date,
        paid_via=excluded.paid_via,
        transaction_ref=excluded.transaction_ref,
        receipt_url=COALESCE(excluded.receipt_url, receipt_url),
        notes=excluded.notes
    `).run(
      b.property_id, b.period_month, b.amount_paid || 0, b.paid_date || null,
      b.paid_via || null, b.transaction_ref || null, b.receipt_url || null,
      b.notes || null, req.user.id
    );
    res.status(201).json({ message: 'Saved' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/payments/:id', requirePermission('rentals', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM rental_payments WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ---------- RENT REQUESTS (mam's "Raise Rent" workflow) ----------

router.get('/rent-requests', requirePermission('rentals', 'view'), (req, res) => {
  try {
    const db = getDb();
    const { month, site_id, status, arrange_for } = req.query;
    let sql = `
      SELECT rr.*, s.name as site_name_live, u.name as created_by_name,
             ap.name as approved_by_name, pp.name as paid_by_name
      FROM rent_requests rr
      LEFT JOIN sites s ON s.id = rr.site_id
      LEFT JOIN users u ON u.id = rr.created_by
      LEFT JOIN users ap ON ap.id = rr.approved_by
      LEFT JOIN users pp ON pp.id = rr.paid_by
      WHERE 1=1
    `;
    const params = [];
    if (month) { sql += ' AND rr.rent_month = ?'; params.push(month); }
    if (site_id) { sql += ' AND rr.site_id = ?'; params.push(site_id); }
    if (status) { sql += ' AND rr.status = ?'; params.push(status); }
    if (arrange_for) { sql += ' AND rr.arrange_for = ?'; params.push(arrange_for); }
    sql += ' ORDER BY rr.created_at DESC';
    res.json(db.prepare(sql).all(...params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/rent-requests/stats', requirePermission('rentals', 'view'), (req, res) => {
  try {
    const db = getDb();
    const total = db.prepare('SELECT COUNT(*) as c FROM rent_requests WHERE COALESCE(inactive,0)=0').get().c;
    const pending = db.prepare(`SELECT COUNT(*) as c FROM rent_requests WHERE status='pending' AND COALESCE(inactive,0)=0`).get().c;
    const approved = db.prepare(`SELECT COUNT(*) as c FROM rent_requests WHERE status='approved' AND COALESCE(inactive,0)=0`).get().c;
    const paid = db.prepare(`SELECT COUNT(*) as c FROM rent_requests WHERE status='paid'`).get().c;
    const rejected = db.prepare(`SELECT COUNT(*) as c FROM rent_requests WHERE status='rejected'`).get().c;
    const inactive = db.prepare(`SELECT COUNT(*) as c FROM rent_requests WHERE COALESCE(inactive,0)=1`).get().c;
    const totalAmount = db.prepare(`SELECT COALESCE(SUM(rent_amount),0) as s FROM rent_requests WHERE status='paid'`).get().s;
    const pendingAmount = db.prepare(`SELECT COALESCE(SUM(rent_amount),0) as s FROM rent_requests WHERE status IN ('pending','approved') AND COALESCE(inactive,0)=0`).get().s;
    res.json({ total, pending, approved, paid, rejected, inactive, total_paid_amount: totalAmount, pending_amount: pendingAmount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/rent-requests', requirePermission('rentals', 'create'), (req, res) => {
  try {
    const b = req.body;
    if (!b.owner_name || !b.rent_month || !b.arrange_for) {
      return res.status(400).json({ error: 'owner_name, rent_month, and arrange_for are required' });
    }
    if (!['SEPL', 'Contractor'].includes(b.arrange_for)) {
      return res.status(400).json({ error: 'arrange_for must be SEPL or Contractor' });
    }
    const db = getDb();
    const { nextSequence } = require('../db/nextSequence');
    const yr = new Date().getFullYear();
    const requestNo = nextSequence(db, 'rent_requests', 'request_no', `RR-${yr}-`, { startFrom: 0, pad: 4 });
    // Validate payment_mode and clear non-relevant fields so each row
    // only carries the data for the selected mode.
    const mode = ['Bank', 'UPI', 'Scanner'].includes(b.payment_mode) ? b.payment_mode : 'Bank';
    const bankAcc = mode === 'Bank' ? (b.bank_account || null) : null;
    const ifsc = mode === 'Bank' ? (b.ifsc_code || null) : null;
    const upiId = mode === 'UPI' ? (b.upi_id || null) : null;
    const scannerUrl = mode === 'Scanner' ? (b.scanner_url || null) : null;

    const r = db.prepare(`
      INSERT INTO rent_requests (
        request_no, site_id, site_name, arrange_for, contractor_name,
        employee_user_id, employee_name,
        owner_name, owner_phone, owner_aadhar_url,
        room_photo_url, photo_taken_at, photo_lat, photo_lng,
        payment_mode, bank_account, ifsc_code, upi_id, scanner_url,
        pincode, pincode_city, metro_type,
        rent_month, rent_amount, pay_by_day, notes, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      requestNo, b.site_id || null, b.site_name || null,
      b.arrange_for, b.contractor_name || null,
      b.employee_user_id || null, b.employee_name || null,
      b.owner_name, b.owner_phone || null, b.owner_aadhar_url || null,
      b.room_photo_url || null, b.photo_taken_at || null, b.photo_lat || null, b.photo_lng || null,
      mode, bankAcc, ifsc, upiId, scannerUrl,
      b.pincode || null, b.pincode_city || null,
      (b.metro_type === 'Metro' || b.metro_type === 'Non-Metro') ? b.metro_type : null,
      b.rent_month, b.rent_amount || 0, b.pay_by_day || 10, b.notes || null, req.user.id
    );
    // Notify approvers (admins + anyone with rentals.approve)
    try {
      const { notifyMany } = require('../lib/push');
      const approvers = db.prepare(`
        SELECT DISTINCT u.id FROM users u
        LEFT JOIN user_roles ur ON ur.user_id = u.id
        LEFT JOIN role_permissions rp ON rp.role_id = ur.role_id
        WHERE COALESCE(u.active,1)=1
          AND (u.role='admin' OR (rp.module='rentals' AND rp.can_approve=1))
      `).all().map(x => x.id);
      notifyMany(approvers, {
        title: `🏠 ${requestNo} — Rent for ${b.rent_month}`,
        body: `${b.owner_name}${b.site_name ? ` · ${b.site_name}` : ''} · Rs ${(b.rent_amount || 0).toLocaleString('en-IN')}`,
        url: '/rentals',
        tag: `rent-req-${r.lastInsertRowid}`,
      });
    } catch {}
    res.status(201).json({ id: r.lastInsertRowid, request_no: requestNo });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/rent-requests/:id', requirePermission('rentals', 'edit'), (req, res) => {
  try {
    const b = req.body;
    const db = getDb();
    const fields = [
      'site_id','site_name','arrange_for','contractor_name',
      'employee_user_id','employee_name',
      'owner_name','owner_phone','owner_aadhar_url',
      'room_photo_url','photo_taken_at','photo_lat','photo_lng',
      'payment_mode','bank_account','ifsc_code','upi_id','scanner_url',
      'pincode','pincode_city','metro_type',
      'rent_month','rent_amount','pay_by_day','notes'
    ];
    const sets = []; const vals = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f}=?`); vals.push(b[f]); }
    if (!sets.length) return res.status(400).json({ error: 'No fields' });
    vals.push(req.params.id);
    db.prepare(`UPDATE rent_requests SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/rent-requests/:id/approve', requirePermission('rentals', 'approve'), (req, res) => {
  try {
    const db = getDb();
    db.prepare(`UPDATE rent_requests SET status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(req.user.id, req.params.id);
    // Push to creator
    const r = db.prepare('SELECT request_no, created_by, owner_name FROM rent_requests WHERE id=?').get(req.params.id);
    if (r) {
      try {
        const { notify } = require('../lib/push');
        notify(r.created_by, {
          title: `✅ Rent Approved — ${r.request_no}`,
          body: `${r.owner_name} — awaiting payment release`,
          url: '/rentals',
          tag: `rent-approved-${req.params.id}`,
        });
      } catch {}
    }
    res.json({ message: 'Approved' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/rent-requests/:id/reject', requirePermission('rentals', 'approve'), (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || reason.trim().length < 5) return res.status(400).json({ error: 'Reason required (min 5 chars)' });
    const db = getDb();
    db.prepare(`UPDATE rent_requests SET status='rejected', reject_reason=?, approved_by=?, approved_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(reason.trim(), req.user.id, req.params.id);
    const r = db.prepare('SELECT request_no, created_by FROM rent_requests WHERE id=?').get(req.params.id);
    if (r) {
      try {
        const { notify } = require('../lib/push');
        notify(r.created_by, {
          title: `❌ Rent Rejected — ${r.request_no}`,
          body: reason,
          url: '/rentals',
        });
      } catch {}
    }
    res.json({ message: 'Rejected' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/rent-requests/:id/mark-paid', requirePermission('rentals', 'edit'), (req, res) => {
  try {
    const { paid_via, transaction_ref, receipt_url } = req.body;
    const db = getDb();
    db.prepare(`
      UPDATE rent_requests SET
        status='paid', paid_by=?, paid_at=CURRENT_TIMESTAMP,
        paid_via=?, transaction_ref=?, receipt_url=COALESCE(?, receipt_url)
      WHERE id=?
    `).run(req.user.id, paid_via || null, transaction_ref || null, receipt_url || null, req.params.id);
    const r = db.prepare('SELECT request_no, created_by, owner_name, rent_amount FROM rent_requests WHERE id=?').get(req.params.id);
    if (r) {
      try {
        const { notify } = require('../lib/push');
        notify(r.created_by, {
          title: `💰 Rent Paid — ${r.request_no}`,
          body: `${r.owner_name} · Rs ${(r.rent_amount || 0).toLocaleString('en-IN')} disbursed`,
          url: '/rentals',
        });
      } catch {}
    }
    res.json({ message: 'Marked paid' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/rent-requests/:id', requirePermission('rentals', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM rent_requests WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Mark inactive — rental relationship ended (vacated). No more rent
// expected. Mam: 'when we inactive not payment log'.
router.post('/rent-requests/:id/mark-inactive', requirePermission('rentals', 'edit'), (req, res) => {
  try {
    const { reason } = req.body;
    getDb().prepare(`UPDATE rent_requests SET inactive=1, inactive_at=CURRENT_TIMESTAMP, inactive_reason=? WHERE id=?`)
      .run(reason || null, req.params.id);
    res.json({ message: 'Marked inactive' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/rent-requests/:id/mark-active', requirePermission('rentals', 'edit'), (req, res) => {
  try {
    getDb().prepare(`UPDATE rent_requests SET inactive=0, inactive_at=NULL, inactive_reason=NULL WHERE id=?`)
      .run(req.params.id);
    res.json({ message: 'Marked active' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
