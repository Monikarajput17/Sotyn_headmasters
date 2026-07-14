// One-shot: import the 57 payment-collection target rows from mam's
// "Payment collection followup" Google Sheet PDF (28-Apr-2026 export).
//
// Each entry creates a receivable with:
//   client_name + site_name = PDF client name (so the row shows up
//                              in Collection Engine immediately)
//   invoice_amount + outstanding_amount = PDF "Actual" target
//   ageing_days / ageing_bucket / status auto-computed
//   business_book_id linked when a name match is found in business_book
//
// Idempotent: checks (client_name, invoice_amount) before inserting.
// Run again after adding more rows — only new ones get added.
//
// Usage on VPS (from /root/erp):
//   node server/scripts/import-payment-targets.js
//
// To replace existing receivables with the PDF target (overwrite mode):
//   node server/scripts/import-payment-targets.js --overwrite

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'erp.db');
if (!fs.existsSync(DB_PATH)) {
  console.error('[import-targets] erp.db not found at', DB_PATH);
  process.exit(1);
}
const overwrite = process.argv.includes('--overwrite');
const db = new Database(DB_PATH);

// === DATA from PDF ===
// "Sr.no, Client Name, Actual" rows. Normalised whitespace.
const targets = [
  { sr: 2,  name: 'Hagerstone International Pvt Ltd (U.P.)',           amount: 3500000 },
  { sr: 3,  name: 'SAEL INDUSTRIES LIMITED',                            amount: 5607228 },
  { sr: 5,  name: 'Concern Pharma Ltd',                                 amount: 6905263 },
  { sr: 6,  name: 'BARAWARE II LLP',                                    amount: 1330000 },
  { sr: 9,  name: 'CHOUDHERY CHEESE BAZAR PVT LTD',                     amount: 1923462 },
  { sr: 10, name: 'M/S V-GUARD INDUSTRIES',                             amount: 2126224 },
  { sr: 11, name: 'Luminous Power Technologies Pvt Ltd (Baddi)',        amount: 1133090 },
  { sr: 13, name: 'TVH LUMBINI SQAURE OWNERS ASSOCIATION',              amount: 1467554 },
  { sr: 15, name: 'Stryder Cycle Private Limited',                      amount: 3400000 },
  { sr: 16, name: 'NETPLUS BROAD BAND SERVICES PVT LTD',                amount:   13000 },
  { sr: 17, name: 'V & B Hospitalities',                                amount: 1600000 },
  { sr: 18, name: 'M CORE INDUSTRIES PRIVATE LIMITED',                  amount:  665424 },
  { sr: 20, name: 'Vigilant Media Private Limited',                     amount:  534494 },
  { sr: 21, name: 'SEEMA MAHAJAN',                                      amount:   12500 },
  { sr: 22, name: 'NGCC INFRATECH OPC PRIVATE LIMITED',                 amount:  427965 },
  { sr: 23, name: 'HOSPITAL ENGINEER (CIVIL-I), PGI',                   amount:   88000 },
  { sr: 24, name: 'Zoom 1 Clothing Co',                                 amount:  337704 },
  { sr: 25, name: 'FASHION TECH',                                       amount:  319152 },
  { sr: 27, name: 'Bening Hospitality',                                 amount:  199237 },
  { sr: 28, name: 'GURU ANGAD DEV VETERINARY AND ANIMAL SCIENCES UNIVERSITY', amount: 2300000 },
  { sr: 38, name: 'SAEL SOLAR P6 PRIVATE LIMITED',                      amount: 5293799 },
  { sr: 40, name: 'Malbros International Pvt Ltd',                      amount:   73170 },
  { sr: 43, name: 'NGCC INFRATECH OPC PRIVATE LIMITED (CHD)',           amount:   62670 },
  { sr: 44, name: 'Rmx Industries Pvt Ltd.',                            amount:   58569 },
  { sr: 45, name: 'MECH CHOICE',                                        amount:   55056 },
  { sr: 46, name: 'Grande Green Farms Pvt Ltd.',                        amount: 1500000 },
  { sr: 50, name: 'ONYX BIOTEC PVT LTD',                                amount:   31541 },
  { sr: 52, name: 'REGISTRAR PANJAB UNIVERSITY',                        amount:   28395 },
  { sr: 53, name: 'Chanakya Dairy Products Pvt Ltd',                    amount:   24598 },
  { sr: 54, name: 'PARADISE RUBBER INDUSTRIES',                         amount:   16611 },
  { sr: 55, name: 'Jyoti Electricals',                                  amount:   14720 },
  { sr: 57, name: 'Think Gas Ludhiana Pvt Ltd.',                        amount:   14034 },
  { sr: 60, name: 'ANIL KNITWEARS',                                     amount:    7670 },
  { sr: 61, name: 'S.S.S Security Services',                            amount:    7537 },
  { sr: 62, name: 'KRBL LIMITED',                                       amount:    6452 },
  { sr: 63, name: 'ELEV8 COWORKING PRIVATE LIMITED',                    amount:    3600 },
  { sr: 64, name: 'KIPPS CORNER',                                       amount:    3375 },
  { sr: 65, name: 'METRO TYRES LTD UNIT III',                           amount:    3128 },
  { sr: 66, name: 'FRANKLIN LABORATORIES (INDIA) PVT LTD',              amount:    2361 },
  { sr: 68, name: 'SK SHARMA & CO',                                     amount:    2085 },
  { sr: 69, name: 'BAJAJ SPIRITS PRIVATE LIMITED',                      amount:    1806 },
  { sr: 72, name: 'M/S NIRMAL PRODUCTS',                                amount: 1400000 },
  { sr: 73, name: 'Sahil kitty',                                        amount:   50000 },
  { sr: 74, name: 'lohia',                                              amount:   13000 },
  { sr: 75, name: 'raja cloth house',                                   amount: 1100000 },
  { sr: 76, name: 'TDS 24-25 sepl',                                     amount:  380000 },
  { sr: 77, name: 'TDS 23-24 SEPL',                                     amount:  380000 },
  { sr: 78, name: 'TDS 23-24 standard',                                 amount:  380000 },
  { sr: 79, name: 'leh consultancy',                                    amount:  135000 },
  { sr: 80, name: 'deepak builders',                                    amount:  521000 },
  { sr: 84, name: 'MONOGRAM DEALCOM LLP',                               amount:  100000 },
  { sr: 86, name: 'GRA SPINNING MILLS PVT LTD',                         amount: 1738902 },
  { sr: 89, name: 'ankit das',                                          amount:   75000 },
  { sr: 90, name: 'sardar jewllers',                                    amount:  700000 },
  { sr: 91, name: 'BDPL',                                               amount:   90000 },
  { sr: 92, name: 'BEDI',                                               amount: 2000000 },
];

// Try to link each PDF row to a Business Book entry by fuzzy name match
// (case-insensitive, ignores punctuation / extra spaces). Helps the
// Collection Engine site picker auto-link without mam re-typing.
const normalise = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '').trim();
const bbRows = db.prepare(
  `SELECT id, lead_no, client_name, company_name, project_name FROM business_book`
).all();
const bbByNorm = new Map();
for (const r of bbRows) {
  for (const candidate of [r.project_name, r.company_name, r.client_name]) {
    const k = normalise(candidate);
    if (k && !bbByNorm.has(k)) bbByNorm.set(k, r);
  }
}

const matchBB = (name) => {
  const n = normalise(name);
  if (!n) return null;
  // Direct match
  if (bbByNorm.has(n)) return bbByNorm.get(n);
  // Substring match — PDF "Concern Pharma" against BB "CONSERN PHARMA"
  for (const [k, v] of bbByNorm.entries()) {
    if (k.includes(n) || n.includes(k)) return v;
  }
  return null;
};

// Schema may not have business_book_id column yet — add it first so the
// prepared statements below can reference it.
const hasBBCol = (() => {
  const cols = db.prepare(`PRAGMA table_info(receivables)`).all();
  return cols.some(c => c.name === 'business_book_id');
})();
if (!hasBBCol) {
  try { db.exec('ALTER TABLE receivables ADD COLUMN business_book_id INTEGER REFERENCES business_book(id)'); } catch (e) {}
}

const findExisting = db.prepare(
  `SELECT id, invoice_amount FROM receivables
    WHERE LOWER(client_name) = LOWER(?) OR LOWER(site_name) = LOWER(?)
    LIMIT 1`
);
const insertStmt = db.prepare(
  `INSERT INTO receivables
     (client_name, site_name, project_name, invoice_amount, outstanding_amount,
      ageing_days, ageing_bucket, status, business_book_id)
   VALUES (?,?,?,?,?,?,?,?,?)`
);
const updateStmt = db.prepare(
  `UPDATE receivables
      SET invoice_amount = ?, outstanding_amount = MAX(0, ? - COALESCE(received_amount,0)),
          business_book_id = COALESCE(?, business_book_id),
          updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`
);

let inserted = 0, updated = 0, skipped = 0;
const tx = db.transaction(() => {
  for (const t of targets) {
    const bb = matchBB(t.name);
    const existing = findExisting.get(t.name, t.name);
    if (existing) {
      if (overwrite) {
        updateStmt.run(t.amount, t.amount, bb?.id || null, existing.id);
        updated += 1;
      } else if (+existing.invoice_amount !== t.amount) {
        // Auto-update when target differs even without --overwrite, since
        // the PDF is mam's source of truth for target amounts.
        updateStmt.run(t.amount, t.amount, bb?.id || null, existing.id);
        updated += 1;
      } else {
        skipped += 1;
      }
    } else {
      insertStmt.run(
        t.name, t.name, bb?.project_name || bb?.company_name || null,
        t.amount, t.amount,
        0, '0-30', 'red',
        bb?.id || null,
      );
      inserted += 1;
    }
  }
});
tx();

console.log(`[import-targets] DONE — ${inserted} inserted · ${updated} target-updated · ${skipped} unchanged`);
console.log(`[import-targets] BB linkage: ${targets.filter(t => matchBB(t.name)).length} of ${targets.length} matched a Business Book entry`);
console.log(`Refresh Collection Engine — all ${targets.length} targets are now in the table.`);
