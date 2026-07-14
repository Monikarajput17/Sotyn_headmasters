const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { validatePoNumber } = require('../utils/validate');
const router = express.Router();
router.use(authMiddleware);

// Mam (2026-05-21): "sales without gst amount . please update of po
// amount (with gst) all business book = sales without gst + (sales
// without gst *18%)".  So PO_AMOUNT is always Sale × 1.18 — no other
// values are valid.  We:
//   1. Backfill every existing row at module load (idempotent, guarded
//      by an app_settings sentinel so it only runs once per fresh
//      deploy of this rule).
//   2. Force-compute on every INSERT / UPDATE so manually typed PO
//      values can't drift again.
// Helper used in both places:
const PO_GST_PCT = 18;
const computePoAmount = (saleAmt) => {
  const s = Number(saleAmt) || 0;
  return Math.round(s * (1 + PO_GST_PCT / 100) * 100) / 100;  // 2-dp
};
// Management discount (mam 2026-06-16): the discount is taken off the Sale
// Amount, then PO (with GST) = NET Sale × 1.18.  The UI keeps the % and the
// Rs amount in sync (two-way); the server is the final guard — if only a %
// arrives we derive the Rs amount, and we clamp the discount to 0..sale so
// a fat-finger can never push net/PO negative.
const computeFinance = (saleAmt, discPct, discAmt) => {
  const s = Number(saleAmt) || 0;
  const pct = Number(discPct) || 0;
  let amt = Number(discAmt) || 0;
  if (!amt && pct) amt = s * pct / 100;          // % given without Rs → derive
  amt = Math.max(0, Math.min(amt, s));           // clamp to 0..sale
  const net = Math.round((s - amt) * 100) / 100;
  return {
    discountPct: Math.round(pct * 100) / 100,
    discountAmount: Math.round(amt * 100) / 100,
    netSale: net,
    poAmount: Math.round(net * (1 + PO_GST_PCT / 100) * 100) / 100,
  };
};

// Idempotent backfill at module load.
try {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)`);
  const flag = db.prepare(`SELECT value FROM app_settings WHERE key='bb_po_eq_sale_x118_v1'`).get();
  if (!flag) {
    const r = db.prepare(`
      UPDATE business_book
      SET po_amount = ROUND(COALESCE(sale_amount_without_gst, 0) * 1.18, 2),
          balance_amount = ROUND(COALESCE(sale_amount_without_gst, 0) * 1.18, 2) - COALESCE(advance_received, 0),
          updated_at = CURRENT_TIMESTAMP
      WHERE COALESCE(sale_amount_without_gst, 0) > 0
    `).run();
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('bb_po_eq_sale_x118_v1', '1')`).run();
    console.log(`[business_book] PO=Sale×1.18 backfill: ${r.changes} rows updated`);
  }
} catch (e) {
  console.warn('[business_book] PO backfill skipped:', e.message);
}

// All fields from Master Business Sheet
const ALL_FIELDS = [
  'lead_type', 'client_name', 'company_name', 'project_name', 'client_contact', 'client_email', 'email_address',
  'source_of_enquiry', 'district', 'state', 'state_code', 'gstin', 'billing_address', 'shipping_address',
  'guarantee_required', 'guarantee_percentage', 'sale_amount_without_gst', 'po_amount',
  'management_discount_pct', 'management_discount_amount', 'net_sale_amount',
  'order_type', 'penalty_clause', 'penalty_clause_date',
  'committed_start_date', 'committed_delivery_date', 'committed_completion_date', 'freight_extra',
  'category', 'customer_type', 'client_type', 'customer_code',
  'employee_assigned', 'employee_id', 'lead_by',
  'management_person_name', 'management_person_contact',
  'operations_person_name', 'operations_person_contact',
  'pmc_person_name', 'pmc_person_contact',
  'architect_person_name', 'architect_person_contact',
  'accounts_person_name', 'accounts_person_contact',
  'tpa_items_count', 'tpa_items_qty', 'tpa_material_amount', 'tpa_labour_amount',
  'accessory_amount', 'required_labour_per_day', 'actual_margin_pct',
  'payment_advance', 'payment_against_delivery', 'payment_against_installation',
  'payment_against_commissioning', 'payment_retention', 'payment_credit', 'credit_days',
  'advance_received', 'balance_amount',
  'po_number', 'po_date', 'po_copy_link',
  'boq_file_link', 'boq_signed_link', 'tpa_material_link', 'tpa_material_signed_link',
  'tpa_labour_link', 'tpa_labour_signed_link', 'final_drawing_link',
  'working_sheet_link',
  'remarks', 'status'
];

// GET all with filters
router.get('/', requirePermission('business_book', 'view'), (req, res) => {
  const { status, category, order_type, lead_type, search, date_from, date_to } = req.query;
  let sql = `SELECT bb.*, u.name as emp_name FROM business_book bb
    LEFT JOIN users u ON bb.employee_id=u.id WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND bb.status=?'; params.push(status); }
  if (category) { sql += ' AND bb.category=?'; params.push(category); }
  if (order_type) { sql += ' AND bb.order_type=?'; params.push(order_type); }
  if (lead_type) { sql += ' AND bb.lead_type=?'; params.push(lead_type); }
  if (date_from) { sql += ' AND bb.created_at >= ?'; params.push(date_from); }
  if (date_to) { sql += ' AND bb.created_at <= ?'; params.push(date_to + ' 23:59:59'); }
  if (search) {
    sql += ' AND (bb.client_name LIKE ? OR bb.company_name LIKE ? OR bb.lead_no LIKE ? OR bb.project_name LIKE ? OR bb.district LIKE ? OR bb.state LIKE ? OR bb.po_number LIKE ? OR bb.customer_code LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY bb.created_at DESC';
  res.json(getDb().prepare(sql).all(...params));
});

// GET summary/stats (must be before /:id)
router.get('/stats/summary', requirePermission('business_book', 'view'), (req, res) => {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as count FROM business_book').get();
  const amounts = db.prepare('SELECT COALESCE(SUM(po_amount),0) as total_po, COALESCE(SUM(advance_received),0) as total_advance, COALESCE(SUM(balance_amount),0) as total_balance, COALESCE(SUM(sale_amount_without_gst),0) as total_sale FROM business_book').get();
  const byStatus = db.prepare("SELECT status, COUNT(*) as count FROM business_book GROUP BY status").all();
  const byCategory = db.prepare("SELECT category, COUNT(*) as count, COALESCE(SUM(po_amount),0) as amount FROM business_book WHERE category IS NOT NULL AND category != '' GROUP BY category").all();
  const byOrderType = db.prepare("SELECT order_type, COUNT(*) as count, COALESCE(SUM(po_amount),0) as amount FROM business_book GROUP BY order_type").all();
  res.json({ total: total.count, ...amounts, byStatus, byCategory, byOrderType });
});

// GET single entry by ID
router.get('/:id', requirePermission('business_book', 'view'), (req, res) => {
  const entry = getDb().prepare(`SELECT bb.*, u.name as emp_name FROM business_book bb
    LEFT JOIN users u ON bb.employee_id=u.id WHERE bb.id=?`).get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  res.json(entry);
});

// POST create
router.post('/', requirePermission('business_book', 'create'), (req, res) => {
  const b = req.body;
  const db = getDb();

  if (!b.client_name || !String(b.client_name).trim()) {
    return res.status(400).json({ error: 'Client name is required' });
  }

  // PO number regex / junk-blocklist guard per TOC v3 P0 #1.
  // BB rows can be created without a PO (lead stage), so only validate
  // when a PO number is actually entered.
  if (b.po_number !== undefined && b.po_number !== null && String(b.po_number).trim() !== '') {
    const poErr = validatePoNumber(b.po_number);
    if (poErr) return res.status(400).json({ error: poErr });
  }

  try {

  // Mam (2026-05-21): block duplicate BB entries — same client +
  // project = same opportunity.  PO number is also caught
  // independently so the same Tally PO can't be booked twice under
  // different client names by mistake.
  const { findDuplicate, sendDuplicate } = require('../utils/duplicateGuard');
  if (b.po_number && String(b.po_number).trim()) {
    const dup = findDuplicate(db, {
      table: 'business_book', fields: { po_number: b.po_number },
      codeColumn: 'lead_no',
    });
    if (sendDuplicate(res, dup, `BB entry with PO ${b.po_number}`)) return;
  }
  const dup = findDuplicate(db, {
    table: 'business_book',
    fields: { client_name: b.client_name, project_name: b.project_name || '' },
    codeColumn: 'lead_no',
  });
  if (sendDuplicate(res, dup, `Business Book entry for ${b.client_name}${b.project_name ? ' · ' + b.project_name : ''}`)) return;

  // Auto-generate Lead No. Uses nextSequence so deletes don't cause
  // UNIQUE-constraint collisions on the next insert.
  const { nextSequence } = require('../db/nextSequence');
  const leadNo = nextSequence(db, 'business_book', 'lead_no', 'SEPL', { startFrom: 20000, pad: 5 });

  // Force PO = NET Sale × 1.18 (mam, 2026-05-21 + discount 2026-06-16).
  // Override any value the client sent — the rule is non-negotiable.
  const fin = computeFinance(b.sale_amount_without_gst, b.management_discount_pct, b.management_discount_amount);
  b.po_amount = fin.poAmount;
  b.management_discount_pct = fin.discountPct;
  b.management_discount_amount = fin.discountAmount;
  b.net_sale_amount = fin.netSale;
  const balanceAmount = (b.po_amount || 0) - (b.advance_received || 0);

  const r = db.prepare(`INSERT INTO business_book (
    lead_no, lead_type, client_name, company_name, project_name, client_contact, client_email, email_address,
    source_of_enquiry, district, state, state_code, gstin, billing_address, shipping_address,
    guarantee_required, guarantee_percentage, sale_amount_without_gst, po_amount,
    management_discount_pct, management_discount_amount, net_sale_amount,
    order_type, penalty_clause, penalty_clause_date,
    committed_start_date, committed_delivery_date, committed_completion_date, freight_extra,
    category, customer_type, client_type, customer_code,
    employee_assigned, employee_id, lead_by,
    management_person_name, management_person_contact,
    operations_person_name, operations_person_contact,
    pmc_person_name, pmc_person_contact,
    architect_person_name, architect_person_contact,
    accounts_person_name, accounts_person_contact,
    tpa_items_count, tpa_items_qty, tpa_material_amount, tpa_labour_amount,
    accessory_amount, required_labour_per_day, actual_margin_pct,
    payment_advance, payment_against_delivery, payment_against_installation,
    payment_against_commissioning, payment_retention, payment_credit, credit_days,
    advance_received, balance_amount,
    po_number, po_date, po_copy_link,
    boq_file_link, boq_signed_link, tpa_material_link, tpa_material_signed_link,
    tpa_labour_link, tpa_labour_signed_link, final_drawing_link,
    working_sheet_link,
    remarks, created_by
  ) VALUES (${Array(75).fill('?').join(',')})`).run(
    leadNo, b.lead_type || 'Private', b.client_name, b.company_name, b.project_name, b.client_contact, b.client_email, b.email_address,
    b.source_of_enquiry, b.district, b.state, b.state_code || null, b.gstin || null, b.billing_address, b.shipping_address,
    b.guarantee_required || 'No', b.guarantee_percentage, b.sale_amount_without_gst || 0, b.po_amount || 0,
    b.management_discount_pct || 0, b.management_discount_amount || 0, b.net_sale_amount || 0,
    b.order_type || 'Supply', b.penalty_clause || 'No', b.penalty_clause_date || null,
    b.committed_start_date || null, b.committed_delivery_date || null, b.committed_completion_date || null, b.freight_extra || 'No',
    b.category, b.customer_type, b.client_type, b.customer_code,
    b.employee_assigned, b.employee_id || null, b.lead_by,
    b.management_person_name, b.management_person_contact,
    b.operations_person_name, b.operations_person_contact,
    b.pmc_person_name, b.pmc_person_contact,
    b.architect_person_name, b.architect_person_contact,
    b.accounts_person_name, b.accounts_person_contact,
    b.tpa_items_count || 0, b.tpa_items_qty, b.tpa_material_amount || 0, b.tpa_labour_amount || 0,
    b.accessory_amount || 0, b.required_labour_per_day, b.actual_margin_pct || 0,
    b.payment_advance, b.payment_against_delivery, b.payment_against_installation,
    b.payment_against_commissioning, b.payment_retention, b.payment_credit, b.credit_days || 0,
    b.advance_received || 0, balanceAmount,
    b.po_number, b.po_date || null, b.po_copy_link,
    b.boq_file_link, b.boq_signed_link, b.tpa_material_link, b.tpa_material_signed_link,
    b.tpa_labour_link, b.tpa_labour_signed_link, b.final_drawing_link,
    b.working_sheet_link || null,
    b.remarks, req.user.id
  );
  const bbId = r.lastInsertRowid;

  // Auto-create Order Planning
  const planResult = db.prepare(
    'INSERT INTO order_planning (business_book_id, planned_start, planned_end, notes, created_by) VALUES (?,?,?,?,?)'
  ).run(bbId, b.committed_start_date || null, b.committed_completion_date || null,
    `Auto: ${leadNo} - ${b.project_name || b.client_name} [${b.category || ''} | ${b.order_type || 'Supply'}]`, req.user.id);

  // Auto-create DPR Site
  const siteName = b.company_name || b.project_name || `${b.client_name} - ${b.category || 'Project'}`;
  const siteAddress = b.shipping_address || b.billing_address || `${b.district || ''}, ${b.state || ''}`;
  const siteResult = db.prepare(
    'INSERT INTO sites (name, address, client_name, business_book_id, supervisor) VALUES (?,?,?,?,?)'
  ).run(siteName, siteAddress, b.client_name || b.company_name, bbId, b.employee_assigned || b.management_person_name);
  const siteId = siteResult.lastInsertRowid;

  // Auto-create Cash Flow entry for advance
  if (b.advance_received && b.advance_received > 0) {
    const today = new Date().toISOString().split('T')[0];
    let daily = db.prepare('SELECT id FROM cash_flow_daily WHERE date=?').get(today);
    if (!daily) {
      const prev = db.prepare('SELECT closing_balance FROM cash_flow_daily WHERE date < ? ORDER BY date DESC LIMIT 1').get(today);
      const dr = db.prepare('INSERT INTO cash_flow_daily (date, opening_balance, closing_balance) VALUES (?,?,?)').run(today, prev?.closing_balance || 0, prev?.closing_balance || 0);
      daily = { id: dr.lastInsertRowid };
    }
    db.prepare('INSERT INTO cash_flow_entries (daily_id, date, type, category, description, amount, party_name, created_by) VALUES (?,?,?,?,?,?,?,?)')
      .run(daily.id, today, 'inflow', 'Advance Received', `Advance from ${b.client_name} - ${leadNo}`, b.advance_received, b.client_name, req.user.id);
    const inflows = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM cash_flow_entries WHERE daily_id=? AND type='inflow'").get(daily.id);
    const outflows = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM cash_flow_entries WHERE daily_id=? AND type='outflow'").get(daily.id);
    const opening = db.prepare('SELECT opening_balance FROM cash_flow_daily WHERE id=?').get(daily.id);
    db.prepare('UPDATE cash_flow_daily SET total_inflows=?, total_outflows=?, closing_balance=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(inflows.t, outflows.t, (opening?.opening_balance || 0) + inflows.t - outflows.t, daily.id);
  }

  // Auto-create receivable for balance
  if ((b.po_amount || 0) > (b.advance_received || 0)) {
    const dueDate = new Date(Date.now() + (b.credit_days || 30) * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    db.prepare('INSERT INTO receivables (client_name, project_name, invoice_amount, received_amount, outstanding_amount, due_date, status, created_by) VALUES (?,?,?,?,?,?,?,?)')
      .run(b.client_name, b.company_name || b.project_name, b.po_amount, b.advance_received || 0, balanceAmount, dueDate, 'green', req.user.id);
  }

  res.status(201).json({
    id: bbId, lead_no: leadNo, message: 'Business Book entry created with auto-links',
    auto_created: { order_planning: planResult.lastInsertRowid, dpr_site: siteId }
  });
  } catch (err) {
    console.error('Business Book POST error:', err);
    res.status(500).json({ error: 'Failed to save: ' + (err.message || 'unknown error') });
  }
});

// PUT update
router.put('/:id', requirePermission('business_book', 'edit'), (req, res) => {
  const b = req.body;
  // Same PO regex guard on edit so historical junk can't be re-saved.
  if (b.po_number !== undefined && b.po_number !== null && String(b.po_number).trim() !== '') {
    const poErr = validatePoNumber(b.po_number);
    if (poErr) return res.status(400).json({ error: poErr });
  }
  // Force PO = NET Sale × 1.18 (mam, 2026-05-21 + discount 2026-06-16).
  // Override any value the client sent so edits can't drift from the rule.
  const fin = computeFinance(b.sale_amount_without_gst, b.management_discount_pct, b.management_discount_amount);
  b.po_amount = fin.poAmount;
  b.management_discount_pct = fin.discountPct;
  b.management_discount_amount = fin.discountAmount;
  b.net_sale_amount = fin.netSale;
  const computedBalance = b.balance_amount !== undefined ? b.balance_amount : (b.po_amount || 0) - (b.advance_received || 0);

  getDb().prepare(`UPDATE business_book SET
    lead_type=?, client_name=?, company_name=?, project_name=?, client_contact=?, client_email=?, email_address=?,
    source_of_enquiry=?, district=?, state=?, state_code=?, gstin=?, billing_address=?, shipping_address=?,
    guarantee_required=?, guarantee_percentage=?, sale_amount_without_gst=?, po_amount=?,
    management_discount_pct=?, management_discount_amount=?, net_sale_amount=?,
    order_type=?, penalty_clause=?, penalty_clause_date=?,
    committed_start_date=?, committed_delivery_date=?, committed_completion_date=?, freight_extra=?,
    category=?, customer_type=?, client_type=?, customer_code=?,
    employee_assigned=?, employee_id=?, lead_by=?,
    management_person_name=?, management_person_contact=?,
    operations_person_name=?, operations_person_contact=?,
    pmc_person_name=?, pmc_person_contact=?,
    architect_person_name=?, architect_person_contact=?,
    accounts_person_name=?, accounts_person_contact=?,
    tpa_items_count=?, tpa_items_qty=?, tpa_material_amount=?, tpa_labour_amount=?,
    accessory_amount=?, required_labour_per_day=?, actual_margin_pct=?,
    payment_advance=?, payment_against_delivery=?, payment_against_installation=?,
    payment_against_commissioning=?, payment_retention=?, payment_credit=?, credit_days=?,
    advance_received=?, balance_amount=?,
    po_number=?, po_date=?, po_copy_link=?,
    boq_file_link=?, boq_signed_link=?, tpa_material_link=?, tpa_material_signed_link=?,
    tpa_labour_link=?, tpa_labour_signed_link=?, final_drawing_link=?,
    working_sheet_link=?,
    remarks=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
    b.lead_type, b.client_name, b.company_name, b.project_name, b.client_contact, b.client_email, b.email_address,
    b.source_of_enquiry, b.district, b.state, b.state_code || null, b.gstin || null, b.billing_address, b.shipping_address,
    b.guarantee_required || 'No', b.guarantee_percentage, b.sale_amount_without_gst || 0, b.po_amount || 0,
    b.management_discount_pct || 0, b.management_discount_amount || 0, b.net_sale_amount || 0,
    b.order_type, b.penalty_clause, b.penalty_clause_date || null,
    b.committed_start_date || null, b.committed_delivery_date || null, b.committed_completion_date || null, b.freight_extra || 'No',
    b.category, b.customer_type, b.client_type, b.customer_code,
    b.employee_assigned, b.employee_id || null, b.lead_by,
    b.management_person_name, b.management_person_contact,
    b.operations_person_name, b.operations_person_contact,
    b.pmc_person_name, b.pmc_person_contact,
    b.architect_person_name, b.architect_person_contact,
    b.accounts_person_name, b.accounts_person_contact,
    b.tpa_items_count || 0, b.tpa_items_qty, b.tpa_material_amount || 0, b.tpa_labour_amount || 0,
    b.accessory_amount || 0, b.required_labour_per_day, b.actual_margin_pct || 0,
    b.payment_advance, b.payment_against_delivery, b.payment_against_installation,
    b.payment_against_commissioning, b.payment_retention, b.payment_credit, b.credit_days || 0,
    b.advance_received || 0, computedBalance,
    b.po_number, b.po_date || null, b.po_copy_link,
    b.boq_file_link, b.boq_signed_link, b.tpa_material_link, b.tpa_material_signed_link,
    b.tpa_labour_link, b.tpa_labour_signed_link, b.final_drawing_link,
    b.working_sheet_link || null,
    b.remarks, b.status, req.params.id
  );
  res.json({ message: 'Updated' });
});

// DELETE (also removes linked sites, POs, items, planning)
router.delete('/:id', requirePermission('business_book', 'delete'), (req, res) => {
  try {
    const db = getDb();
    const id = req.params.id;
    // Safety guard (mam 2026-06-15: a mistaken delete cascade-wiped Hero Homes'
    // DPRs).  Deleting a Business Book order ALSO erases its sites' DPRs +
    // attendance.  Refuse if any DPRs/attendance exist unless ?force=1, so an
    // accidental click can't destroy filled DPRs.
    if (req.query.force !== '1') {
      const sub = '(SELECT id FROM sites WHERE business_book_id=?)';
      const dprCount = db.prepare(`SELECT COUNT(*) c FROM dpr WHERE site_id IN ${sub}`).get(id).c;
      const attCount = db.prepare(`SELECT COUNT(*) c FROM attendance WHERE site_id IN ${sub}`).get(id).c;
      if (dprCount > 0 || attCount > 0) {
        return res.status(409).json({
          error: `This order has ${dprCount} DPR(s) and ${attCount} attendance record(s) under its site(s). Deleting will permanently erase them.`,
          dpr_count: dprCount, attendance_count: attCount, needs_force: true,
        });
      }
    }
    // Disable foreign keys temporarily for clean delete
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM project_finance WHERE business_book_id=?').run(id);
    db.prepare('DELETE FROM po_items WHERE business_book_id=?').run(id);
    db.prepare('DELETE FROM order_planning WHERE business_book_id=?').run(id);
    // Delete DPR data linked to sites of this business_book
    const siteIds = db.prepare('SELECT id FROM sites WHERE business_book_id=?').all(id).map(s => s.id);
    if (siteIds.length > 0) {
      const ids = siteIds.join(',');
      db.prepare(`DELETE FROM dpr_work_items WHERE dpr_id IN (SELECT id FROM dpr WHERE site_id IN (${ids}))`).run();
      db.prepare(`DELETE FROM dpr_manpower WHERE dpr_id IN (SELECT id FROM dpr WHERE site_id IN (${ids}))`).run();
      db.prepare(`DELETE FROM dpr_machinery WHERE dpr_id IN (SELECT id FROM dpr WHERE site_id IN (${ids}))`).run();
      db.prepare(`DELETE FROM dpr WHERE site_id IN (${ids})`).run();
      db.prepare(`DELETE FROM attendance WHERE site_id IN (${ids})`).run();
      db.prepare(`DELETE FROM geofence_settings WHERE site_id IN (${ids})`).run();
    }
    db.prepare('DELETE FROM sites WHERE business_book_id=?').run(id);
    db.prepare('DELETE FROM purchase_orders WHERE business_book_id=?').run(id);
    db.prepare('DELETE FROM receivables WHERE po_id IN (SELECT id FROM purchase_orders WHERE business_book_id=?)').run(id);
    db.prepare('DELETE FROM business_book WHERE id=?').run(id);
    db.pragma('foreign_keys = ON');
    res.json({ message: 'Deleted' });
  } catch (err) {
    try { getDb().pragma('foreign_keys = ON'); } catch(e) {}
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
