const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const uploadDir = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

function generateCustomerCode(db) {
  const { nextSequence } = require('../db/nextSequence');
  return nextSequence(db, 'customers', 'customer_code', 'CUST-', { startFrom: 1000, pad: 5 });
}

// GET list with search
router.get('/', requirePermission('customers', 'view'), (req, res) => {
  const { search, category } = req.query;
  let sql = 'SELECT * FROM customers WHERE 1=1';
  const params = [];
  if (category) { sql += ' AND category=?'; params.push(category); }
  if (search) {
    sql += ' AND (company_name LIKE ? OR sub_company_name LIKE ? OR customer_code LIKE ? OR contact_no LIKE ? OR email LIKE ? OR concern_person_name LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q, q, q, q, q);
  }
  sql += ' ORDER BY created_at DESC';
  res.json(getDb().prepare(sql).all(...params));
});

// GET single
router.get('/:id', requirePermission('customers', 'view'), (req, res) => {
  const row = getDb().prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// POST create (auto-generates customer_code)
router.post('/', requirePermission('customers', 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.company_name || !b.company_name.trim()) return res.status(400).json({ error: 'Company name required' });
  const db = getDb();

  // Mam (2026-05-21): block duplicate customers — same company name
  // = same customer.  Phone / email are additional flags caught if
  // company_name differs by typo.
  const { findDuplicate, sendDuplicate } = require('../utils/duplicateGuard');
  const cnameDup = findDuplicate(db, {
    table: 'customers', fields: { company_name: b.company_name },
    codeColumn: 'customer_code',
  });
  if (sendDuplicate(res, cnameDup, `Customer "${b.company_name.trim()}"`)) return;
  if (b.contact_no && String(b.contact_no).trim()) {
    const dup = findDuplicate(db, {
      table: 'customers', fields: { contact_no: b.contact_no },
      codeColumn: 'customer_code',
    });
    if (sendDuplicate(res, dup, `Customer with phone ${b.contact_no}`)) return;
  }

  const code = generateCustomerCode(db);
  const r = db.prepare(
    'INSERT INTO customers (customer_code, category, company_name, sub_company_name, company_registration_address, contact_no, email, concern_person_name, concern_person_email, concern_person_address) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(code, b.category || '', b.company_name.trim(), b.sub_company_name || '', b.company_registration_address || '', b.contact_no || '', b.email || '', b.concern_person_name || '', b.concern_person_email || '', b.concern_person_address || '');
  res.status(201).json({ id: r.lastInsertRowid, customer_code: code });
});

// PUT update (customer_code is read-only)
router.put('/:id', requirePermission('customers', 'edit'), (req, res) => {
  const b = req.body || {};
  getDb().prepare(
    'UPDATE customers SET category=?, company_name=?, sub_company_name=?, company_registration_address=?, contact_no=?, email=?, concern_person_name=?, concern_person_email=?, concern_person_address=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
  ).run(b.category || '', b.company_name || '', b.sub_company_name || '', b.company_registration_address || '', b.contact_no || '', b.email || '', b.concern_person_name || '', b.concern_person_email || '', b.concern_person_address || '', req.params.id);
  res.json({ message: 'Updated' });
});

// DELETE
router.delete('/:id', requirePermission('customers', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM customers WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// POST bulk-import (Excel upload)
router.post('/bulk-import', requirePermission('customers', 'create'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 });

    let headerIdx = -1;
    for (let i = 0; i < Math.min(10, data.length); i++) {
      const row = (data[i] || []).map(c => String(c || '').toLowerCase());
      if (row.some(c => c.includes('company') || c.includes('customer') || c.includes('name'))) { headerIdx = i; break; }
    }
    if (headerIdx === -1) headerIdx = 0;

    const headers = (data[headerIdx] || []).map(h => String(h || '').toLowerCase().trim());
    const colMap = {};
    headers.forEach((h, i) => {
      if (!colMap.company_name && (h === 'company name' || h === 'company' || (h.includes('company') && !h.includes('sub') && !h.includes('registration') && !h.includes('address')))) colMap.company_name = i;
      if (h.includes('sub') && h.includes('company')) colMap.sub_company_name = i;
      if (h.includes('category')) colMap.category = i;
      if (h.includes('registration') || (h.includes('company') && h.includes('address'))) colMap.company_registration_address = i;
      if (!colMap.contact_no && (h === 'contact no' || h === 'contact' || h === 'phone' || h === 'mobile' || h.includes('contact no'))) colMap.contact_no = i;
      if (!colMap.email && h === 'email') colMap.email = i;
      if (h.includes('concern') && h.includes('name')) colMap.concern_person_name = i;
      if (h.includes('concern') && h.includes('email')) colMap.concern_person_email = i;
      if (h.includes('concern') && h.includes('address')) colMap.concern_person_address = i;
    });

    if (colMap.company_name === undefined) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.status(400).json({ error: 'Could not find "Company Name" column in Excel' });
    }

    const db = getDb();
    const insert = db.prepare(
      'INSERT INTO customers (customer_code, category, company_name, sub_company_name, company_registration_address, contact_no, email, concern_person_name, concern_person_email, concern_person_address) VALUES (?,?,?,?,?,?,?,?,?,?)'
    );

    let added = 0;
    const errors = [];
    for (let i = headerIdx + 1; i < data.length; i++) {
      const row = data[i] || [];
      const company_name = String(row[colMap.company_name] || '').trim();
      if (!company_name) continue;
      try {
        const code = generateCustomerCode(db);
        insert.run(
          code,
          colMap.category !== undefined ? String(row[colMap.category] || '').trim() : '',
          company_name,
          colMap.sub_company_name !== undefined ? String(row[colMap.sub_company_name] || '').trim() : '',
          colMap.company_registration_address !== undefined ? String(row[colMap.company_registration_address] || '').trim() : '',
          colMap.contact_no !== undefined ? String(row[colMap.contact_no] || '').trim() : '',
          colMap.email !== undefined ? String(row[colMap.email] || '').trim() : '',
          colMap.concern_person_name !== undefined ? String(row[colMap.concern_person_name] || '').trim() : '',
          colMap.concern_person_email !== undefined ? String(row[colMap.concern_person_email] || '').trim() : '',
          colMap.concern_person_address !== undefined ? String(row[colMap.concern_person_address] || '').trim() : ''
        );
        added++;
      } catch (err) {
        errors.push(`Row ${i + 1}: ${err.message}`);
      }
    }

    try { fs.unlinkSync(req.file.path); } catch (e) {}
    res.json({ added, errors, total: data.length - headerIdx - 1 });
  } catch (err) {
    try { if (req.file) fs.unlinkSync(req.file.path); } catch (e) {}
    res.status(500).json({ error: 'Failed to parse Excel: ' + err.message });
  }
});

module.exports = router;
