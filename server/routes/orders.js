const express = require('express');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { validatePoNumber } = require('../utils/validate');
const router = express.Router();
router.use(authMiddleware);

// Multer for Excel upload
const fs = require('fs');
const uploadDir = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

// Discover every table whose FOREIGN KEY targets `targetTable` (via SQLite's
// own PRAGMA foreign_key_list) and NULL out the referencing column on rows
// pointing at `ids`. Returns the list of referencers it touched + any errors
// so callers can build a diagnostic message on FK failure.
//
// Used before DELETE statements that have repeatedly hit "FOREIGN KEY
// constraint failed" because a hard-coded dependent list missed a table.
// Self-healing: new tables that gain an FK in future are picked up
// automatically the next time the path runs.
function nullReferencers(db, targetTable, ids) {
  if (!ids || !ids.length) return { referencers: [], errors: [] };
  const placeholders = ids.map(() => '?').join(',');
  const allTables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all().map(r => r.name);
  const referencers = [];
  for (const t of allTables) {
    try {
      const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all();
      for (const fk of fks) {
        if (fk.table === targetTable) referencers.push({ table: t, column: fk.from });
      }
    } catch (_) { /* unreadable table — skip */ }
  }
  const errors = [];
  for (const { table, column } of referencers) {
    try {
      db.prepare(`UPDATE ${table} SET ${column}=NULL WHERE ${column} IN (${placeholders})`).run(...ids);
    } catch (e) {
      errors.push(`${table}.${column}: ${e.message}`);
      console.warn(`[nullReferencers] could not null ${table}.${column}:`, e.message);
    }
  }
  return { referencers, errors };
}

// Count how many rows still reference `ids` across the given referencers —
// used to build a precise diagnostic when a DELETE still fails after a
// null-out pass. Returns `{ "table.col": N, ... }` for non-zero counts only.
function countRemainingRefs(db, referencers, ids) {
  if (!ids || !ids.length) return {};
  const placeholders = ids.map(() => '?').join(',');
  const out = {};
  for (const { table, column } of referencers) {
    try {
      const r = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IN (${placeholders})`).get(...ids);
      if (r?.n > 0) out[`${table}.${column}`] = r.n;
    } catch (_) {}
  }
  return out;
}

// Business Book entries for PO dropdown
router.get('/business-book-entries', (req, res) => {
  res.json(getDb().prepare(
    `SELECT bb.id, bb.lead_no, bb.client_name, bb.company_name, COALESCE(s.name, bb.project_name) as project_name,
     bb.category, bb.order_type, bb.po_amount, bb.sale_amount_without_gst, bb.district, bb.state
     FROM business_book bb LEFT JOIN sites s ON s.business_book_id=bb.id ORDER BY bb.created_at DESC`
  ).all());
});

// Purchase Orders
router.get('/po', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`SELECT po.*, bb.lead_no, bb.client_name as bb_client, bb.company_name as bb_company,
    COALESCE(s.name, bb.project_name) as bb_project, bb.category as bb_category,
    l.company_name, q.quotation_number, se.name as site_engineer_name FROM purchase_orders po
    LEFT JOIN business_book bb ON po.business_book_id=bb.id
    LEFT JOIN sites s ON s.business_book_id=bb.id
    LEFT JOIN leads l ON po.lead_id=l.id LEFT JOIN quotations q ON po.quotation_id=q.id
    LEFT JOIN users se ON po.site_engineer_id=se.id
    ORDER BY po.created_at DESC`).all();
  // Resolve multi-engineer names from site_engineer_ids CSV
  for (const r of rows) {
    const csv = r.site_engineer_ids;
    if (csv) {
      const ids = String(csv).split(',').map(x => parseInt(x, 10)).filter(Boolean);
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        const users = db.prepare(`SELECT id, name FROM users WHERE id IN (${placeholders})`).all(...ids);
        r.site_engineer_ids_list = ids;
        r.site_engineer_names = users.map(u => u.name).join(', ');
      }
    } else if (r.site_engineer_id) {
      r.site_engineer_ids_list = [r.site_engineer_id];
      r.site_engineer_names = r.site_engineer_name || '';
    } else {
      r.site_engineer_ids_list = [];
      r.site_engineer_names = '';
    }
    // Extra project roles (mam 2026-06-17): jr site eng / supervisor /
    // welder / helper — same CSV-of-user-ids shape as site engineers.
    for (const f of ['jr_site_engineer', 'supervisor', 'welder', 'helper']) {
      const ids = String(r[`${f}_ids`] || '').split(',').map(x => parseInt(x, 10)).filter(Boolean);
      r[`${f}_ids_list`] = ids;
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        const us = db.prepare(`SELECT id, name FROM users WHERE id IN (${ph})`).all(...ids);
        const byId = new Map(us.map(u => [u.id, u.name]));
        r[`${f}_names`] = ids.map(id => byId.get(id)).filter(Boolean).join(', ');
      } else {
        r[`${f}_names`] = '';
      }
    }
  }
  res.json(rows);
});

router.post('/po', requirePermission('orders', 'create'), (req, res) => {
  const { business_book_id, lead_id, quotation_id, po_number, po_date, total_amount, advance_amount, po_copy_link, boq_file_link, pt_advance, pt_delivery, pt_installation, pt_commissioning, pt_retention, site_engineer_id, site_engineer_ids, crm_name, items, jr_site_engineer_ids, supervisor_ids, welder_ids, helper_ids } = req.body;
  const db = getDb();
  // Extra-role CSVs (jr site eng / supervisor / welder / helper). Accept an
  // array of user ids (preferred) or a CSV string; store as a clean CSV.
  const csvIds = (v) => Array.isArray(v) ? v.map(x => parseInt(x, 10)).filter(Boolean).join(',') : (v == null ? '' : String(v));
  const jrCsv = csvIds(jr_site_engineer_ids), supCsv = csvIds(supervisor_ids), weldCsv = csvIds(welder_ids), helpCsv = csvIds(helper_ids);

  // PO number regex / junk-blocklist guard per TOC v3 P0 #1 — stops
  // historical junk like "5252525", "141414", "1111111111", "00".
  const poErr = validatePoNumber(po_number);
  if (poErr) return res.status(400).json({ error: poErr });

  // Normalize engineer IDs: accept array (preferred) or single legacy id
  const engIds = Array.isArray(site_engineer_ids)
    ? site_engineer_ids.map(x => parseInt(x, 10)).filter(Boolean)
    : (site_engineer_id ? [parseInt(site_engineer_id, 10)].filter(Boolean) : []);
  if (engIds.length === 0) return res.status(400).json({ error: 'At least one Site Engineer is required' });
  if (!crm_name) return res.status(400).json({ error: 'CRM is required' });

  const primaryEng = engIds[0];
  const engCsv = engIds.join(',');

  const r = db.prepare(
    'INSERT INTO purchase_orders (business_book_id, lead_id, quotation_id, po_number, po_date, total_amount, advance_amount, po_copy_link, boq_file_link, pt_advance, pt_delivery, pt_installation, pt_commissioning, pt_retention, site_engineer_id, site_engineer_ids, jr_site_engineer_ids, supervisor_ids, welder_ids, helper_ids, crm_name, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(business_book_id || null, lead_id || null, quotation_id || null, po_number, po_date, total_amount, advance_amount || 0, po_copy_link || null, boq_file_link || null, pt_advance || 0, pt_delivery || 0, pt_installation || 0, pt_commissioning || 0, pt_retention || 0, primaryEng, engCsv, jrCsv, supCsv, weldCsv, helpCsv, crm_name, req.user.id);
  const poId = r.lastInsertRowid;

  // Insert PO items — scoped to THIS PO (po_id = poId) so a later edit
  // of another PO sharing the same business_book doesn't wipe these
  // items. business_book_id is still recorded for cross-PO indent /
  // DPR pooling.
  if (items && items.length > 0) {
    const insertItem = db.prepare('INSERT INTO po_items (business_book_id, po_id, item_master_id, description, quantity, unit, rate, amount, hsn_code, sr_no, part_price, labour_rate) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    items.forEach((item, idx) => {
      if (item.description && item.description.trim()) {
        insertItem.run(
          business_book_id || null,
          poId,
          item.item_master_id || null,
          item.description.trim(),
          +item.quantity || 0,
          item.unit || 'nos',
          +item.rate || 0,
          +item.amount || 0,
          item.hsn_code || '',
          +item.sr_no || idx + 1,
          +item.part_price || 0,        // PP (Part Price)
          +item.labour_rate || 0,        // Labour Rate
        );
      }
    });
  }

  // Sync po_number back to business_book
  if (business_book_id) {
    db.prepare('UPDATE business_book SET po_number=?, po_date=?, po_amount=? WHERE id=?')
      .run(po_number, po_date, total_amount || 0, business_book_id);
    // Update site's po_id if exists
    db.prepare('UPDATE sites SET po_id=? WHERE business_book_id=?').run(poId, business_book_id);
    // Update order_planning po_id
    db.prepare('UPDATE order_planning SET po_id=? WHERE business_book_id=?').run(poId, business_book_id);
  }

  // Update lead status to won
  if (lead_id) db.prepare('UPDATE leads SET status=? WHERE id=?').run('won', lead_id);

  res.status(201).json({ id: poId });
});

router.put('/po/:id', requirePermission('orders', 'edit'), (req, res) => {
  const { business_book_id, po_number, po_date, total_amount, advance_amount, po_copy_link, boq_file_link, pt_advance, pt_delivery, pt_installation, pt_commissioning, pt_retention, status, site_engineer_id, site_engineer_ids, crm_name, jr_site_engineer_ids, supervisor_ids, welder_ids, helper_ids } = req.body;
  // Extra-role CSVs — null when the field is absent so COALESCE keeps the
  // existing value; an explicit [] clears it (csvIds → '').
  const csvIds = (v) => v === undefined ? null : (Array.isArray(v) ? v.map(x => parseInt(x, 10)).filter(Boolean).join(',') : (v == null ? '' : String(v)));
  const jrCsv = csvIds(jr_site_engineer_ids), supCsv = csvIds(supervisor_ids), weldCsv = csvIds(welder_ids), helpCsv = csvIds(helper_ids);
  // Same regex guard on edit — junk PO numbers can't be re-saved.
  if (po_number !== undefined && po_number !== null && String(po_number).trim() !== '') {
    const poErr = validatePoNumber(po_number);
    if (poErr) return res.status(400).json({ error: poErr });
  }
  const engIds = Array.isArray(site_engineer_ids)
    ? site_engineer_ids.map(x => parseInt(x, 10)).filter(Boolean)
    : (site_engineer_id ? [parseInt(site_engineer_id, 10)].filter(Boolean) : []);
  if (engIds.length === 0) return res.status(400).json({ error: 'At least one Site Engineer is required' });
  if (!crm_name) return res.status(400).json({ error: 'CRM is required' });
  const primaryEng = engIds[0];
  const engCsv = engIds.join(',');

  // Numeric coercion — total_amount, advance_amount, pt_* are REAL in the DB.
  // The frontend may send "", "30", "50.5", "30%", " 25 " etc. Convert once
  // here so a single bad value doesn't crash the whole UPDATE. Invalid →
  // `null` (keeps existing via COALESCE) for the required fields, 0 for pt_*.
  const num = (v, fallback = null) => {
    if (v === null || v === undefined || v === '') return fallback;
    const cleaned = String(v).replace(/[^0-9.-]/g, ''); // strip %, spaces, text
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : fallback;
  };

  // Status: if client sends blank / invalid, keep existing via COALESCE(null)
  const VALID_STATUSES = ['received', 'booked', 'planning', 'in_progress', 'completed'];
  const safeStatus = (status && VALID_STATUSES.includes(status)) ? status : null;

  // po_number / po_date are required non-null in the schema — if the form sent
  // empty strings, keep existing values via COALESCE.
  const safePoNumber = po_number && String(po_number).trim() ? String(po_number).trim() : null;
  const safePoDate = po_date && String(po_date).trim() ? po_date : null;

  // business_book_id: lets an edit RE-LINK the PO to a different booked
  // lead (e.g. a PO mistakenly attached to the Electrical lead being
  // moved to the Plumbing lead). Previously this field was dropped on
  // update, so the list's Category/amount — both derived from the linked
  // business_book — could never be corrected from the UI. null (blank /
  // omitted) keeps the existing link via COALESCE; we never silently
  // unlink.
  const safeBbId = (business_book_id !== undefined && business_book_id !== null && String(business_book_id).trim() !== '')
    ? parseInt(business_book_id, 10) : null;

  try {
    const db = getDb();
    // Guard the FK columns so a stale pick never 500s with "FOREIGN KEY
    // constraint failed" (mam 2026-06-24, "error if I update jr site eng"):
    // drop any engineer id that no longer exists in `users` (site_engineer_id
    // REFERENCES users(id)), and ignore a business_book link that's been
    // deleted. The jr/supervisor/welder/helper CSVs are plain TEXT (no FK).
    const liveUserIds = new Set(db.prepare('SELECT id FROM users').all().map(r => r.id));
    const liveEngIds = engIds.filter(id => liveUserIds.has(id));
    if (!liveEngIds.length) return res.status(400).json({ error: 'The selected Site Engineer no longer exists as an active user — pick a current user.' });
    const primaryEngSafe = liveEngIds[0];
    const engCsvSafe = liveEngIds.join(',');
    let bbIdSafe = safeBbId;
    if (bbIdSafe && !db.prepare('SELECT 1 FROM business_book WHERE id=?').get(bbIdSafe)) bbIdSafe = null;

    db.prepare(`UPDATE purchase_orders SET
      business_book_id=COALESCE(?,business_book_id),
      po_number=COALESCE(?,po_number), po_date=COALESCE(?,po_date),
      total_amount=COALESCE(?,total_amount), advance_amount=COALESCE(?,advance_amount),
      po_copy_link=?, boq_file_link=?,
      pt_advance=?, pt_delivery=?, pt_installation=?, pt_commissioning=?, pt_retention=?,
      site_engineer_id=?, site_engineer_ids=?,
      jr_site_engineer_ids=COALESCE(?,jr_site_engineer_ids),
      supervisor_ids=COALESCE(?,supervisor_ids),
      welder_ids=COALESCE(?,welder_ids),
      helper_ids=COALESCE(?,helper_ids),
      crm_name=?,
      status=COALESCE(?,status) WHERE id=?`)
      .run(
        bbIdSafe,
        safePoNumber, safePoDate,
        num(total_amount), num(advance_amount),
        po_copy_link || null, boq_file_link || null,
        num(pt_advance, 0), num(pt_delivery, 0), num(pt_installation, 0), num(pt_commissioning, 0), num(pt_retention, 0),
        primaryEngSafe, engCsvSafe,
        jrCsv, supCsv, weldCsv, helpCsv,
        crm_name,
        safeStatus, req.params.id
      );

    // When the link changed, keep the dependent rows consistent — mirror
    // what POST /po does: re-point this PO's items to the new business
    // book (for indent/DPR pooling) and sync the new lead's po_* fields.
    if (bbIdSafe) {
      db.prepare('UPDATE po_items SET business_book_id=? WHERE po_id=?').run(bbIdSafe, req.params.id);
      const cur = db.prepare('SELECT po_number, po_date, total_amount FROM purchase_orders WHERE id=?').get(req.params.id);
      if (cur) {
        db.prepare('UPDATE business_book SET po_number=?, po_date=?, po_amount=? WHERE id=?')
          .run(cur.po_number, cur.po_date, cur.total_amount || 0, bbIdSafe);
      }
    }
    res.json({ message: 'Updated' });
  } catch (err) {
    console.error('[PO update] failed:', err.message, req.body);
    res.status(500).json({ error: 'Update failed: ' + err.message });
  }
});

router.delete('/po/:id', requirePermission('orders', 'delete'), (req, res) => {
  const db = getDb();
  const id = req.params.id;
  // ?force=1 cascades down through the entire procurement chain so admin
  // can wipe a bad-data PO and re-add. Regular delete (no flag) stays safe
  // — blocks if anything downstream references the PO.
  const force = req.query.force === '1' || req.query.force === 'true';
  try {
    const po = db.prepare('SELECT business_book_id FROM purchase_orders WHERE id=?').get(id);
    if (!po) return res.status(404).json({ error: 'PO not found' });

    // Chain: purchase_orders -> order_planning (po_id) -> indents (planning_id) -> vendor_pos (indent_id) -> purchase_bills (vendor_po_id)
    const vendorPoCount = db.prepare(`
      SELECT COUNT(*) as c FROM vendor_pos
      WHERE indent_id IN (
        SELECT id FROM indents WHERE planning_id IN (
          SELECT id FROM order_planning WHERE po_id=?
        )
      )
    `).get(id).c;

    const billCount = db.prepare(`
      SELECT COUNT(*) as c FROM purchase_bills
      WHERE vendor_po_id IN (
        SELECT id FROM vendor_pos WHERE indent_id IN (
          SELECT id FROM indents WHERE planning_id IN (
            SELECT id FROM order_planning WHERE po_id=?
          )
        )
      )
    `).get(id).c;

    const salesBillCount = db.prepare('SELECT COUNT(*) as c FROM sales_bills WHERE po_id=?').get(id).c;
    const installCount = db.prepare('SELECT COUNT(*) as c FROM installations WHERE po_id=?').get(id).c;

    // Regular delete — block if any dependent record exists. Response
    // includes `canForce: true` so the client can offer a "Force Delete"
    // button if the user wants to wipe everything.
    if (!force && (vendorPoCount > 0 || billCount > 0 || salesBillCount > 0 || installCount > 0)) {
      const refs = [];
      if (vendorPoCount) refs.push(`${vendorPoCount} Vendor PO(s)`);
      if (billCount) refs.push(`${billCount} Purchase Bill(s)`);
      if (salesBillCount) refs.push(`${salesBillCount} Sales Bill(s)`);
      if (installCount) refs.push(`${installCount} Installation(s)`);
      return res.status(409).json({
        error: `Cannot delete: referenced by ${refs.join(', ')}`,
        canForce: true,
        refs: { vendorPoCount, billCount, salesBillCount, installCount },
      });
    }

    // Force delete — cascade down the entire chain in a single transaction.
    if (force) {
      const cascade = db.transaction(() => {
        // Gather ids through the chain so we can delete leaves first
        const planningIds = db.prepare('SELECT id FROM order_planning WHERE po_id=?').all(id).map(r => r.id);
        const indentIds = planningIds.length
          ? db.prepare(`SELECT id FROM indents WHERE planning_id IN (${planningIds.map(() => '?').join(',')})`).all(...planningIds).map(r => r.id)
          : [];
        const vendorPoIds = indentIds.length
          ? db.prepare(`SELECT id FROM vendor_pos WHERE indent_id IN (${indentIds.map(() => '?').join(',')})`).all(...indentIds).map(r => r.id)
          : [];

        // Delete deepest leaves upward
        if (vendorPoIds.length) {
          const ph = vendorPoIds.map(() => '?').join(',');
          db.prepare(`DELETE FROM purchase_bills WHERE vendor_po_id IN (${ph})`).run(...vendorPoIds);
          db.prepare(`DELETE FROM delivery_notes WHERE vendor_po_id IN (${ph})`).run(...vendorPoIds);
          db.prepare(`DELETE FROM vendor_po_items WHERE vendor_po_id IN (${ph})`).run(...vendorPoIds);
          db.prepare(`DELETE FROM vendor_pos WHERE id IN (${ph})`).run(...vendorPoIds);
        }
        if (indentIds.length) {
          const ph = indentIds.map(() => '?').join(',');
          db.prepare(`DELETE FROM indent_item_rates WHERE indent_item_id IN (SELECT id FROM indent_items WHERE indent_id IN (${ph}))`).run(...indentIds);
          db.prepare(`DELETE FROM indent_items WHERE indent_id IN (${ph})`).run(...indentIds);
          db.prepare(`DELETE FROM indents WHERE id IN (${ph})`).run(...indentIds);
        }
        db.prepare('DELETE FROM sales_bills WHERE po_id=?').run(id);
        db.prepare('DELETE FROM installations WHERE po_id=?').run(id);
        db.prepare('DELETE FROM order_planning WHERE po_id=?').run(id);
      });
      cascade();
    }

    // Unlink lingering children and wipe the PO itself. Both the po_items
    // and purchase_orders DELETEs were hitting FK violations because tables
    // we didn't hardcode (e.g. indent_items.po_item_id, plus 7 known tables
    // with po_id REFERENCES purchase_orders) still pointed at the rows.
    // nullReferencers() asks SQLite for the full list and clears them.
    // Wipe THIS PO's items only — was previously by business_book_id
    // which nuked every sibling PO. Now scoped by po_id with a
    // legacy-fallback for any items that haven't been backfilled yet
    // (po_id IS NULL AND business_book_id = po.business_book_id).
    if (po.business_book_id) {
      db.prepare('UPDATE business_book SET po_number=NULL, po_date=NULL, po_amount=0 WHERE id=?').run(po.business_book_id);
    }
    const poItemIds = db.prepare(`
      SELECT id FROM po_items
       WHERE po_id = ?
          OR (po_id IS NULL AND business_book_id = ?)
    `).all(id, po.business_book_id || -1).map(r => r.id);
    if (poItemIds.length) {
      const { referencers: piRefs, errors: piErrs } = nullReferencers(db, 'po_items', poItemIds);
      try {
        db.prepare(`
          DELETE FROM po_items
           WHERE po_id = ?
              OR (po_id IS NULL AND business_book_id = ?)
        `).run(id, po.business_book_id || -1);
      } catch (e) {
        const remaining = countRemainingRefs(db, piRefs, poItemIds);
        console.error('[PO delete] po_items DELETE failed:', e.message, '| poId:', id, '| bbId:', po.business_book_id,
          '| referencers:', piRefs, '| remaining:', remaining, '| nullErrors:', piErrs);
        const hint = Object.keys(remaining).length
          ? ' Still blocking po_items: ' + Object.entries(remaining).map(([k, n]) => `${k}(${n})`).join(', ') + '.'
          : '';
        return res.status(409).json({ error: `Cannot delete PO: line items are referenced elsewhere.${hint}` });
      }
    }
    db.prepare('UPDATE sites SET po_id=NULL WHERE po_id=?').run(id);
    db.prepare('UPDATE order_planning SET po_id=NULL WHERE po_id=?').run(id);

    const { referencers: poRefs, errors: poErrs } = nullReferencers(db, 'purchase_orders', [id]);
    try {
      db.prepare('DELETE FROM purchase_orders WHERE id=?').run(id);
    } catch (e) {
      const remaining = countRemainingRefs(db, poRefs, [id]);
      console.error('[PO delete] purchase_orders DELETE failed:', e.message, '| poId:', id,
        '| referencers:', poRefs, '| remaining:', remaining, '| nullErrors:', poErrs);
      const hint = Object.keys(remaining).length
        ? ' Still blocking: ' + Object.entries(remaining).map(([k, n]) => `${k}(${n})`).join(', ') + '.'
        : '';
      return res.status(409).json({ error: `Cannot delete PO: still referenced by other records.${hint}` });
    }
    res.json({ message: force ? 'Force-deleted (all dependents removed)' : 'Deleted' });
  } catch (err) {
    console.error('PO delete error:', err);
    res.status(500).json({ error: 'Delete failed: ' + err.message });
  }
});

router.delete('/planning/:id', requirePermission('orders', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM order_planning WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// PO Items CRUD
router.get('/po/:id/items', (req, res) => {
  // Get items via business_book_id linked to this PO
  const po = getDb().prepare('SELECT business_book_id FROM purchase_orders WHERE id=?').get(req.params.id);
  if (po?.business_book_id) {
    res.json(getDb().prepare('SELECT * FROM po_items WHERE business_book_id=?').all(po.business_book_id));
  } else {
    res.json([]);
  }
});

// Reset (zero out) labour_rate + labour_amount on every po_items row
// linked to this PO. Mam: "delete labour rate from every previous is ok
// bcs after labour rate add this happen". Used when a labour rate sheet
// was applied to the wrong PO or with a wrong-shape sheet; mam can
// reset and re-upload cleanly. Idempotent and scoped by business_book_id.
router.post('/po/:id/labour-rates/reset', requirePermission('orders', 'edit'), (req, res) => {
  const db = getDb();
  const po = db.prepare('SELECT business_book_id FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!po?.business_book_id) return res.status(404).json({ error: 'PO not found or has no business_book link' });
  const r = db.prepare('UPDATE po_items SET labour_rate = 0, labour_amount = 0 WHERE business_book_id = ?').run(po.business_book_id);
  res.json({
    message: `Cleared labour rate on ${r.changes} item${r.changes === 1 ? '' : 's'}. Upload the Labour Rate Sheet again to repopulate.`,
    cleared_count: r.changes,
  });
});

// Bulk-patch labour_rate (and the derived labour_amount) on po_items.
// Mam: "first we upload all labour rates in order to planning after
// than link with dpr". Used by the Order Planning modal after she
// uploads the Labour Rate Sheet — the rate from each row is matched
// to a po_item and written here without disturbing rate / quantity /
// description. From here the rate flows into dpr_work_items.
router.post('/po/:id/labour-rates', requirePermission('orders', 'edit'), (req, res) => {
  const db = getDb();
  const po = db.prepare('SELECT business_book_id FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  const updates = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!updates.length) return res.status(400).json({ error: 'No items supplied' });

  // Pre-fetch all po_items for this PO so we can validate ownership
  // (don't let a stray id from another PO get patched) and read qty
  // for the labour_amount math.
  const rows = db.prepare('SELECT id, quantity, business_book_id FROM po_items WHERE business_book_id=?').all(po.business_book_id);
  const byId = new Map(rows.map(r => [r.id, r]));

  const upd = db.prepare('UPDATE po_items SET labour_rate=?, labour_amount=? WHERE id=?');
  const tx = db.transaction((items) => {
    let n = 0;
    for (const it of items) {
      const id = +it.po_item_id || +it.id;
      const row = byId.get(id);
      if (!row) continue;
      const labour = +it.labour_rate || 0;
      const amount = +it.labour_amount || (+row.quantity || 0) * labour;
      upd.run(labour, amount, id);
      n++;
    }
    return n;
  });
  try {
    const updated = tx(updates);
    res.json({ message: `Labour rate updated on ${updated} item${updated === 1 ? '' : 's'}`, updated_count: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/po/:id/items', requirePermission('orders', 'edit'), (req, res) => {
 try {
  const { items } = req.body;
  const db = getDb();
  const po = db.prepare('SELECT business_book_id FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });

  // Guard against stale FK references: if the PO points at a business_book
  // row that's been deleted, using that id would blow up with FOREIGN KEY
  // constraint failed. Validate first; if dangling, save items with
  // business_book_id = NULL (item_master_id too).
  let bbId = po?.business_book_id || null;
  if (bbId) {
    const bbExists = db.prepare('SELECT 1 FROM business_book WHERE id=?').get(bbId);
    if (!bbExists) {
      console.warn(`[PO items save] PO ${req.params.id} references missing business_book ${bbId}; saving items without BB link`);
      // Also null out the stale reference on the PO itself so future saves don't hit this
      try { db.prepare('UPDATE purchase_orders SET business_book_id=NULL WHERE id=?').run(req.params.id); } catch (e) {}
      bbId = null;
    }
  }

  // Clear old items for THIS PO only (was previously by business_book_id,
  // which wiped every sibling PO's items — mam's "uploaded 4 BOQs, only
  // one survived" bug). Scope by po_id so each PO has an independent
  // item set. Legacy items with po_id=NULL get scooped up too so a
  // re-upload after a migration still replaces them.
  const poId = +req.params.id || null;
  const poItemIds = db.prepare(`
    SELECT id FROM po_items
     WHERE po_id = ?
        OR (po_id IS NULL AND business_book_id = ?)
  `).all(poId, bbId).map(r => r.id);
  if (poItemIds.length) {
    const { referencers, errors: nullErrors } = nullReferencers(db, 'po_items', poItemIds);
    try {
      db.prepare(`
        DELETE FROM po_items
         WHERE po_id = ?
            OR (po_id IS NULL AND business_book_id = ?)
      `).run(poId, bbId);
    } catch (e) {
      const remaining = countRemainingRefs(db, referencers, poItemIds);
      const knownList = referencers.map(r => `${r.table}.${r.column}`).join(', ') || '(none discovered)';
      const hint = Object.keys(remaining).length
        ? ' Still blocking: ' + Object.entries(remaining).map(([k, n]) => `${k}(${n})`).join(', ') + '.'
        : ` (no remaining refs found across discovered FKs: ${knownList}) — likely a trigger or CHECK constraint. Check pm2 logs for details.`;
      console.error('[PO items save] DELETE failed:', e.message, '| poId:', poId, '| bbId:', bbId,
        '| referencers:', referencers, '| remaining:', remaining, '| nullErrors:', nullErrors);
      return res.status(409).json({
        error: `Cannot replace items: existing indents / DPR entries reference these PO items.${hint} Clear or reassign those entries first.`,
      });
    }
  }

  // Build set of valid item_master ids up-front so we can skip dangling
  // references without individual queries per row.
  const validMasterIds = new Set(db.prepare('SELECT id FROM item_master').all().map(r => r.id));

  const insert = db.prepare('INSERT INTO po_items (business_book_id, po_id, item_master_id, description, quantity, unit, rate, amount, hsn_code, sr_no, part_price, labour_rate) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  let count = 0;
  const errors = [];
  // Coerce numerics safely — empty strings, null, NaN all become 0 so a
  // single bad row doesn't fail the whole 39-item save.
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  try {
    // Wrap all inserts in a single transaction for atomicity + speed.
    const runInserts = db.transaction(() => {
      for (let idx = 0; idx < (items || []).length; idx++) {
        const item = items[idx];
        if (!item || !item.description || !item.description.trim()) continue;
        try {
          // item_master_id: accept only integer ids that actually exist in
          // item_master. Empty string / non-int / unknown id → NULL (so FK
          // doesn't blow up).
          const rawMid = item.item_master_id;
          const midNum = parseInt(rawMid, 10);
          const safeMasterId = Number.isFinite(midNum) && validMasterIds.has(midNum) ? midNum : null;
          insert.run(
            bbId,
            poId,
            safeMasterId,
            item.description.trim(),
            num(item.quantity),
            item.unit || 'nos',
            num(item.rate),
            num(item.amount),
            item.hsn_code || '',
            num(item.sr_no) || idx + 1,
            num(item.part_price),        // PP (Part Price)
            num(item.labour_rate),        // Labour Rate
          );
          count++;
        } catch (rowErr) {
          errors.push(`Row ${idx + 1}: ${rowErr.message}`);
        }
      }
    });
    runInserts();
    if (errors.length) {
      return res.status(400).json({ error: `Saved ${count} items; ${errors.length} failed`, failures: errors });
    }
    res.json({ message: 'Items saved', count });
  } catch (err) {
    console.error('[PO items save] transaction failed:', err.message);
    res.status(500).json({ error: 'Items save failed: ' + err.message });
  }
 } catch (outerErr) {
  // Outer catch for errors in db.prepare / db.get setup before the transaction
  console.error('[PO items save] outer failure:', outerErr.message, '\nbody:', JSON.stringify(req.body).slice(0, 2000));
  res.status(500).json({ error: 'Items save failed (setup): ' + outerErr.message });
 }
});

// Get PO items by business_book_id directly
router.get('/bb/:bbId/items', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM po_items WHERE business_book_id=?').all(req.params.bbId));
});

// Order Planning
router.get('/planning', (req, res) => {
  res.json(getDb().prepare(`SELECT op.*, po.po_number, bb.client_name FROM order_planning op
    LEFT JOIN purchase_orders po ON op.po_id=po.id LEFT JOIN business_book bb ON op.business_book_id=bb.id ORDER BY op.created_at DESC`).all());
});

router.post('/planning', requirePermission('orders', 'create'), (req, res) => {
  const { po_id, business_book_id, planned_start, planned_end, notes } = req.body;
  const r = getDb().prepare(
    'INSERT INTO order_planning (po_id, business_book_id, planned_start, planned_end, notes, created_by) VALUES (?,?,?,?,?,?)'
  ).run(po_id, business_book_id, planned_start, planned_end, notes, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/planning/:id', requirePermission('orders', 'edit'), (req, res) => {
  const { status, planned_start, planned_end, notes } = req.body;
  getDb().prepare('UPDATE order_planning SET status=?, planned_start=?, planned_end=?, notes=? WHERE id=?')
    .run(status, planned_start, planned_end, notes, req.params.id);
  res.json({ message: 'Updated' });
});

// Get BOQ items for a PO (for DPR auto-population)
router.get('/po/:id/boq-items', (req, res) => {
  const db = getDb();
  const po = db.prepare('SELECT quotation_id FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!po?.quotation_id) return res.json([]);
  const quotation = db.prepare('SELECT boq_id FROM quotations WHERE id=?').get(po.quotation_id);
  if (!quotation?.boq_id) return res.json([]);
  const items = db.prepare('SELECT * FROM boq_items WHERE boq_id=?').all(quotation.boq_id);
  res.json(items);
});

// Download PO Excel template
router.get('/po-template', (req, res) => {
  const wb = XLSX.utils.book_new();
  const headers = [
    ['SEPL - Purchase Order Items Template'],
    [''],
    ['Instructions: Fill in the items below and upload. Item Name, Qty, Unit, Rate are required.'],
    [''],
    ['Sr No', 'Item Name', 'Specification', 'Size', 'Qty', 'Unit', 'Rate (Rs)', 'Amount (Rs)', 'HSN Code'],
    [1, 'BRANCH PIPE', 'SS TYPE', '63MM', 10, 'PCS', 1050, '=E6*G6', ''],
    [2, 'HOSE REEL DRUM', 'WITH 30 MTR PIPE', '20mm dia', 5, 'PCS', 3650, '=E7*G7', ''],
    [3, '', '', '', '', 'PCS', '', '', ''],
    [4, '', '', '', '', 'PCS', '', '', ''],
    [5, '', '', '', '', 'PCS', '', '', ''],
    [6, '', '', '', '', 'PCS', '', '', ''],
    [7, '', '', '', '', 'PCS', '', '', ''],
    [8, '', '', '', '', 'PCS', '', '', ''],
    [9, '', '', '', '', 'PCS', '', '', ''],
    [10, '', '', '', '', 'PCS', '', '', ''],
    [11, '', '', '', '', 'PCS', '', '', ''],
    [12, '', '', '', '', 'PCS', '', '', ''],
    [13, '', '', '', '', 'PCS', '', '', ''],
    [14, '', '', '', '', 'PCS', '', '', ''],
    [15, '', '', '', '', 'PCS', '', '', ''],
    [16, '', '', '', '', 'PCS', '', '', ''],
    [17, '', '', '', '', 'PCS', '', '', ''],
    [18, '', '', '', '', 'PCS', '', '', ''],
    [19, '', '', '', '', 'PCS', '', '', ''],
    [20, '', '', '', '', 'PCS', '', '', ''],
  ];
  const ws = XLSX.utils.aoa_to_sheet(headers);
  ws['!cols'] = [{ wch: 6 }, { wch: 25 }, { wch: 25 }, { wch: 15 }, { wch: 8 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws, 'PO Items');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=PO-Items-Template.xlsx');
  res.send(Buffer.from(buf));
});

// Upload PO Excel / BOQ and auto-import items
// Supports: SEPL BOQ format (SN, Item Name, QTY, UNIT, Supply Rate, Installation Rate, SITC Rate, Total Cost)
// Also supports: simple template (Item Name, Specification, Size, Qty, Unit, Rate, Amount, HSN)
// Blank BOQ template (mam 2026-06-19: "give BOQ blank format so data fills in
// the same format and parses correctly"). Headers are chosen to match the
// upload parser exactly (SITC Rate / Purchase Price / Labour Rate etc.).
router.get('/po-boq-template', requirePermission('orders', 'view'), (req, res) => {
  const headers = ['SN', 'Description', 'Specification', 'Size', 'Qty', 'Unit', 'SITC Rate', 'Purchase Price', 'Labour Rate', 'Amount', 'HSN'];
  const sample = [1, 'PVC FLEXIBLE CABLE 3 PHASE 2 CORE', '1.5 SQMM', '1.5sqmm', 100, 'mtr', 45, 38, 5, 4500, ''];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, sample]);
  ws['!cols'] = headers.map(h => ({ wch: Math.max(12, h.length + 3) }));
  XLSX.utils.book_append_sheet(wb, ws, 'BOQ');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="BOQ-template.xlsx"');
  res.send(buf);
});

router.post('/po-upload-excel', requirePermission('orders', 'create'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.readFile(req.file.path);

    // Parse a cell that may be a number, a string like "10 nos", "1,250", or blank
    const parseNum = (v) => {
      if (v === null || v === undefined || v === '') return 0;
      if (typeof v === 'number') return v;
      const cleaned = String(v).replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/);
      return cleaned ? parseFloat(cleaned[0]) : 0;
    };

    // Parse a single sheet → items[]. Returns { items, debug }
    const parseSheet = (sheetName) => {
      const ws = wb.Sheets[sheetName];
      if (!ws) return { items: [], debug: { sheetName, error: 'sheet missing' } };
      const data = XLSX.utils.sheet_to_json(ws, { header: 1 });

      // Find header row — scan first 20 rows for any known column keyword
      const HEADER_KEYWORDS = ['item name', 'description', 'particulars', 'work', 'item', 'qty', 'qnty', 'quantity', 'sitc', 'rate', 'amount', 's/n', 's.no', 'purchase', 'labour', 'labor'];
      let headerIdx = -1;
      for (let i = 0; i < Math.min(20, data.length); i++) {
        const row = (data[i] || []).map(c => String(c || '').toLowerCase().trim());
        const matches = HEADER_KEYWORDS.filter(k => row.some(c => c === k || c.includes(k))).length;
        if (matches >= 2) { headerIdx = i; break; }
      }
      if (headerIdx === -1) return { items: [], debug: { sheetName, error: 'no header row found', rowCount: data.length } };

      const headers = (data[headerIdx] || []).map(h => String(h || '').toLowerCase().trim());
      const isBOQ = headers.some(h => h.includes('sitc') || h.includes('supply rate') || h.includes('total cost'));

      const colMap = {};
      headers.forEach((h, i) => {
        if (colMap.name === undefined && (h.includes('item name') || h.includes('description') || h.includes('particulars') || h === 'work' || h.includes('work description') || h === 'item' || h === 'items')) colMap.name = i;
        if (h.includes('specification') || h === 'spec' || h.includes('specs')) colMap.spec = i;
        if (h === 'size' || h.includes('size')) colMap.size = i;
        if (colMap.qty === undefined && (h === 'qty' || h === 'quantity' || h === 'qnty' || h === 'qnty.' || h.includes('qty') || h.includes('qnty') || h.includes('quantity') || h === 'nos')) colMap.qty = i;
        if (colMap.unit === undefined && (h === 'unit' || h === 'uom' || h.includes('unit') || h === 'units')) colMap.unit = i;
        if (h.includes('sitc rate') || h === 'sitc') colMap.sitcRate = i;
        if (h.includes('supply rate')) colMap.supplyRate = i;
        if (h.includes('installation')) colMap.installRate = i;
        if (h.includes('total cost')) colMap.totalCost = i;
        if (!colMap.rate && (h.includes('rate') && !h.includes('supply') && !h.includes('sitc') && !h.includes('install'))) colMap.rate = i;
        if (h.includes('amount') && !h.includes('total') && !h.includes('labour') && !h.includes('labor')) colMap.amount = i;
        // PP = Purchase Price (mam 2026-06-19), and per-item Labour Rate.
        if (colMap.purchasePrice === undefined && (h === 'pp' || h === 'pp rate' || h.includes('purchase price') || h.includes('purchase rate') || h.includes('buying') || (h.includes('purchase') && !h.includes('order')))) colMap.purchasePrice = i;
        if (colMap.labourRate === undefined && (h.includes('labour rate') || h.includes('labor rate') || h === 'labour' || h === 'labor')) colMap.labourRate = i;
        if (h.includes('hsn')) colMap.hsn = i;
        if (h === 'sn' || h === 's/n' || h === 'sr no' || h === 'sr' || h === 's.no' || h === 's. no' || h === 's.no.' || h === 'sl no' || h === 'sl.no') colMap.sn = i;
      });

      // If unit column header is blank but there's a column right after qty with string values like "mtr", "Nos", "Set", auto-detect it
      if (colMap.qty !== undefined && colMap.unit === undefined) {
        const maybeUnitCol = colMap.qty + 1;
        const UNIT_LIKE = /^(mtr|nos|set|kg|sqm|rft|pair|pcs?|no|lot|unit|ltr|ton|bag|rmt|cum|sft|box|roll|feet|ft|mm|inch)\.?$/i;
        let unitMatches = 0;
        for (let i = headerIdx + 1; i < Math.min(headerIdx + 40, data.length); i++) {
          const v = String((data[i] || [])[maybeUnitCol] || '').trim();
          if (v && UNIT_LIKE.test(v)) unitMatches++;
        }
        if (unitMatches >= 2) colMap.unit = maybeUnitCol;
      }

      const detectedHeaders = (data[headerIdx] || []).map(h => String(h || ''));
      if (colMap.name === undefined) return { items: [], debug: { sheetName, headerRow: headerIdx, detectedHeaders, colMap, error: 'no description column' } };

      const items = [];
      const skipped = { noName: 0, noData: 0 };
      let serial = 1;
      for (let i = headerIdx + 1; i < data.length; i++) {
        const row = data[i] || [];
        const name = String(row[colMap.name] || '').trim();
        if (!name || name.length < 3) { skipped.noName++; continue; }

        let qty = colMap.qty !== undefined ? parseNum(row[colMap.qty]) : 0;
        let rate = 0;
        if (colMap.sitcRate !== undefined) rate = parseNum(row[colMap.sitcRate]);
        if (!rate && colMap.rate !== undefined) rate = parseNum(row[colMap.rate]);
        if (!rate && colMap.supplyRate !== undefined) rate = parseNum(row[colMap.supplyRate]);

        let amount = 0;
        if (colMap.totalCost !== undefined) amount = parseNum(row[colMap.totalCost]);
        if (!amount && colMap.amount !== undefined) amount = parseNum(row[colMap.amount]);

        if (qty === 0 && rate === 0 && amount === 0) { skipped.noData++; continue; }

        if (qty === 0 && amount && rate) qty = Math.round((amount / rate) * 100) / 100;
        if (qty === 0) qty = 1;
        if (!amount) amount = qty * rate;

        const spec = colMap.spec !== undefined ? String(row[colMap.spec] || '').trim() : '';
        const size = colMap.size !== undefined ? String(row[colMap.size] || '').trim() : '';
        const description = [name, spec, size].filter(Boolean).join(' / ');
        const unit = colMap.unit !== undefined ? String(row[colMap.unit] || 'Nos').trim() : 'Nos';
        const part_price = colMap.purchasePrice !== undefined ? parseNum(row[colMap.purchasePrice]) : 0;
        const labour_rate = colMap.labourRate !== undefined ? parseNum(row[colMap.labourRate]) : 0;

        items.push({
          sr_no: serial++,
          description,
          item_name: name,
          specification: spec,
          size: size,
          quantity: qty,
          unit: unit || 'Nos',
          rate: Math.round(rate * 100) / 100,
          amount: Math.round(amount * 100) / 100,
          part_price: Math.round(part_price * 100) / 100,    // PP (Purchase Price)
          labour_rate: Math.round(labour_rate * 100) / 100,
          hsn_code: colMap.hsn !== undefined ? String(row[colMap.hsn] || '').trim() : '',
        });
      }

      return { items, debug: { sheetName, headerRow: headerIdx, detectedHeaders, colMap, skipped, isBOQ } };
    };

    // Try every sheet; pick the one with the most items
    const perSheet = wb.SheetNames.map(parseSheet);
    const best = perSheet.reduce((a, b) => (b.items.length > a.items.length ? b : a), { items: [], debug: {} });
    const items = best.items;
    const headerIdx = best.debug.headerRow;
    const detectedHeaders = best.debug.detectedHeaders || [];
    const colMap = best.debug.colMap || {};
    const skipped = best.debug.skipped || {};
    const isBOQ = !!best.debug.isBOQ;

    if (items.length === 0) {
      // Still keep the file accessible — rename + return file_url so frontend can attach it as BOQ
      let fileUrl = `/uploads/${req.file.filename}`;
      try {
        const safeName = (req.file.originalname || 'boq.xlsx').replace(/[^a-zA-Z0-9._-]/g, '_');
        const newName = `${Date.now()}-${safeName}`;
        const newPath = path.join(path.dirname(req.file.path), newName);
        fs.renameSync(req.file.path, newPath);
        fileUrl = `/uploads/${newName}`;
      } catch (e) {}
      return res.json({
        items: [], count: 0,
        file_url: fileUrl, filename: req.file.originalname,
        sheetsTried: perSheet.map(s => ({ sheet: s.debug.sheetName, items: s.items.length, headers: s.debug.detectedHeaders, error: s.debug.error })),
      });
    }

    // Keep the uploaded file so it can be viewed later as the PO's BOQ file.
    // Rename to include a readable suffix (original filename) served via /uploads.
    let fileUrl = `/uploads/${req.file.filename}`;
    try {
      const safeName = (req.file.originalname || 'boq.xlsx').replace(/[^a-zA-Z0-9._-]/g, '_');
      const newName = `${Date.now()}-${safeName}`;
      const newPath = path.join(path.dirname(req.file.path), newName);
      fs.renameSync(req.file.path, newPath);
      fileUrl = `/uploads/${newName}`;
    } catch (e) { /* if rename fails, fall back to multer's hashed name */ }

    res.json({ items, count: items.length, format: isBOQ ? 'BOQ' : 'template', file_url: fileUrl, filename: req.file.originalname, detectedHeaders, headerRow: headerIdx, colMap, skipped });
  } catch (err) {
    try { if (req.file) fs.unlinkSync(req.file.path); } catch (e) {}
    res.status(500).json({ error: 'Failed to parse Excel: ' + err.message });
  }
});

// LABOUR RATE SHEET UPLOAD — mam: "upload Labour rate sheet and when
// upload below match BOQ item Labour rate come next column of rate(SITC)".
// Same parser shape as po-upload-excel but it only extracts the labour
// rate column and returns rows keyed by sr_no + description so the
// frontend can merge them onto the existing BOQ items without losing
// SITC rates / quantities. Also persists the file so it can be re-shown
// on the PO view later.
router.post('/labour-upload-excel', requirePermission('orders', 'edit'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.readFile(req.file.path);
    const parseNum = (v) => {
      if (v === null || v === undefined || v === '') return 0;
      if (typeof v === 'number') return v;
      const cleaned = String(v).replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/);
      return cleaned ? parseFloat(cleaned[0]) : 0;
    };
    // Parse one sheet — find header row, locate description + labour rate cols.
    const parseSheet = (sheetName) => {
      const ws = wb.Sheets[sheetName];
      if (!ws) return { rows: [], debug: { error: 'sheet missing' } };
      const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
      const HEADER_KW = ['description', 'particulars', 'work', 'item', 'labour', 'labor', 'rate', 's/n', 'sl no', 's.no', 'sr no'];
      let headerIdx = -1;
      for (let i = 0; i < Math.min(20, data.length); i++) {
        const row = (data[i] || []).map(c => String(c || '').toLowerCase().trim());
        const matches = HEADER_KW.filter(k => row.some(c => c === k || c.includes(k))).length;
        if (matches >= 2) { headerIdx = i; break; }
      }
      if (headerIdx === -1) return { rows: [], debug: { error: 'no header row' } };
      const headers = (data[headerIdx] || []).map(h => String(h || '').toLowerCase().trim());
      const colMap = {};
      headers.forEach((h, i) => {
        if (colMap.name === undefined && (h.includes('item name') || h.includes('description') || h.includes('particulars') || h === 'work' || h.includes('work description') || h === 'item' || h === 'items')) colMap.name = i;
        // Match anything mentioning labour / labor — also "installation rate"
        // (template-speak for the labour portion of a SITC).
        if (colMap.labour === undefined && (h.includes('labour') || h.includes('labor') || h.includes('installation rate') || h === 'installation' || h.includes('install rate'))) colMap.labour = i;
        // Fallback: a column named just "rate" if no labour column found.
        if (colMap.rateFallback === undefined && h === 'rate') colMap.rateFallback = i;
        if (h === 'sn' || h === 's/n' || h === 'sr no' || h === 'sr' || h === 's.no' || h === 's. no' || h === 's.no.' || h === 'sl no' || h === 'sl.no') colMap.sn = i;
        if (h === 'qty' || h === 'quantity' || h.includes('qty')) colMap.qty = i;
      });
      if (colMap.name === undefined) return { rows: [], debug: { error: 'no description column', headers } };
      // If no labour column at all, return empty (the frontend will warn).
      const labourCol = colMap.labour !== undefined ? colMap.labour : colMap.rateFallback;
      if (labourCol === undefined) return { rows: [], debug: { error: 'no labour rate column', headers } };
      const rows = [];
      let serial = 1;
      for (let i = headerIdx + 1; i < data.length; i++) {
        const row = data[i] || [];
        const name = String(row[colMap.name] || '').trim();
        if (!name || name.length < 3) continue;
        const labourRate = parseNum(row[labourCol]);
        if (labourRate === 0) continue;
        const snVal = colMap.sn !== undefined ? parseNum(row[colMap.sn]) : 0;
        rows.push({
          sr_no: snVal || serial,
          description: name,
          labour_rate: Math.round(labourRate * 100) / 100,
        });
        serial++;
      }
      return { rows, debug: { headerRow: headerIdx, headers, colMap, labourCol } };
    };
    const perSheet = wb.SheetNames.map(parseSheet);
    const best = perSheet.reduce((a, b) => (b.rows.length > a.rows.length ? b : a), { rows: [], debug: {} });
    // Keep the uploaded file so it can be re-opened from the PO later.
    let fileUrl = `/uploads/${req.file.filename}`;
    try {
      const safeName = (req.file.originalname || 'labour.xlsx').replace(/[^a-zA-Z0-9._-]/g, '_');
      const newName = `${Date.now()}-${safeName}`;
      const newPath = path.join(path.dirname(req.file.path), newName);
      fs.renameSync(req.file.path, newPath);
      fileUrl = `/uploads/${newName}`;
    } catch (e) { /* fallback to multer hashed name */ }
    res.json({
      rows: best.rows,
      count: best.rows.length,
      file_url: fileUrl,
      filename: req.file.originalname,
      debug: best.debug,
    });
  } catch (err) {
    try { if (req.file) fs.unlinkSync(req.file.path); } catch (e) {}
    res.status(500).json({ error: 'Failed to parse Excel: ' + err.message });
  }
});

module.exports = router;
