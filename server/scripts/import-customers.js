#!/usr/bin/env node
/**
 * Imports customers from server/scripts/customers-seed.csv into the SQLite DB.
 * Run once after deploying:  node server/scripts/import-customers.js
 *
 * Existing customer codes from the sheet (e.g. SEPLCC1001) are preserved.
 * Rows whose customer_code already exists in the DB are skipped (idempotent).
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { initializeDatabase, getDb } = require('../db/schema');

const CSV_PATH = path.join(__dirname, 'customers-seed.csv');
if (!fs.existsSync(CSV_PATH)) {
  console.error(`Seed file not found: ${CSV_PATH}`);
  process.exit(1);
}

initializeDatabase();
const db = getDb();

const wb = XLSX.read(fs.readFileSync(CSV_PATH), { type: 'buffer' });
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
const headers = (rows[0] || []).map(h => String(h || '').trim());

// Map header -> column index
const headerIdx = (predicate) => headers.findIndex(predicate);

const col = {
  customer_code: headerIdx(h => h.toLowerCase() === 'customer code'),
  category: headerIdx(h => h.toUpperCase() === 'CATEGORY'),
  company_name: headerIdx(h => h.toLowerCase() === 'company name'),
  sub_company_name: headerIdx(h => h.toLowerCase().startsWith('sub') && h.toLowerCase().includes('company')),
  company_registration_address: headerIdx(h => h.toLowerCase().includes('company registration')),
  contact_no: headerIdx(h => h.toLowerCase() === 'contact no'),
  email: headerIdx(h => h.toLowerCase() === 'e-mail id' || h.toLowerCase() === 'email'),
  concern_person_name: headerIdx(h => h.toLowerCase() === 'concern person name'),
  concern_person_email: headerIdx(h => h.toLowerCase() === 'concern person email-id' || h.toLowerCase() === 'concern person email'),
  concern_person_address: headerIdx(h => h.toLowerCase() === 'concern person address'),
};

for (const [k, v] of Object.entries(col)) {
  if (v === -1) console.warn(`WARN: column "${k}" not found in CSV — will be blank`);
}

const val = (row, idx) => (idx >= 0 ? String(row[idx] || '').trim() : '');

const insert = db.prepare(
  'INSERT INTO customers (customer_code, category, company_name, sub_company_name, company_registration_address, contact_no, email, concern_person_name, concern_person_email, concern_person_address) VALUES (?,?,?,?,?,?,?,?,?,?)'
);
const exists = db.prepare('SELECT id FROM customers WHERE customer_code=?');

function nextAutoCode() {
  const count = db.prepare('SELECT COUNT(*) as c FROM customers').get().c;
  return `CUST-${String(count + 1001).padStart(5, '0')}`;
}

let added = 0, skipped = 0, blanks = 0;
const errors = [];

for (let i = 1; i < rows.length; i++) {
  const row = rows[i] || [];
  const company_name = val(row, col.company_name);
  if (!company_name) { blanks++; continue; }

  let code = val(row, col.customer_code);
  if (!code) code = nextAutoCode();

  if (exists.get(code)) { skipped++; continue; }

  try {
    insert.run(
      code,
      val(row, col.category),
      company_name,
      val(row, col.sub_company_name),
      val(row, col.company_registration_address),
      val(row, col.contact_no),
      val(row, col.email),
      val(row, col.concern_person_name),
      val(row, col.concern_person_email),
      val(row, col.concern_person_address)
    );
    added++;
  } catch (err) {
    errors.push(`Row ${i + 1} (${code}): ${err.message}`);
  }
}

console.log(`Customers import complete.`);
console.log(`  Added:   ${added}`);
console.log(`  Skipped: ${skipped} (already existed)`);
console.log(`  Blank:   ${blanks} (no company name)`);
if (errors.length) {
  console.log(`  Errors:  ${errors.length}`);
  errors.slice(0, 10).forEach(e => console.log(`    - ${e}`));
}
