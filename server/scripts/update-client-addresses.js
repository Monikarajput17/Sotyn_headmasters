// One-shot: update Business Book client addresses (billing + shipping)
// from the address list mam supplied (Downloads/ADDRESS.pdf, 2026-06-04).
//
// The PDF gives one address per company; its "Shipping / Site Address"
// and "Billing Address" columns are identical, so we write the SAME
// cleaned address into both business_book.billing_address and
// shipping_address for every row whose company_name matches.
//
// Matching is by company_name, normalised to alphanumerics + lowercase
// so punctuation / spacing / case differences ("M/s", "M/S", "Ltd.",
// extra spaces) don't block a match.  A company can have several
// business_book rows (e.g. CONSERN PHARMA) — ALL of them are updated.
//
// Idempotent: re-running just re-writes the same values.  Always prints
// a per-company report (rows matched + the matched names) and lists any
// company it could NOT find so mam can correct the name.
//
// Usage (from /root/erp on the VPS):
//   node server/scripts/update-client-addresses.js --dry   # preview only
//   node server/scripts/update-client-addresses.js         # apply
//
// Safe to abort and re-run.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'erp.db');
if (!fs.existsSync(DB_PATH)) {
  console.error('[addr] DB not found at', DB_PATH);
  process.exit(1);
}

const DRY = process.argv.slice(2).includes('--dry');

// Company → address (single cleaned line).  Billing == Shipping.
const ADDRESSES = [
  ['CONSERN PHARMA',
    'Focal Point, VPO Tibba, Near Somasar Gurudwara - 141120'],
  ['Dee Developers Pvt Ltd',
    "survey no.567/1&2, 568/1 577 paiki-1' 578, 579 paiki -2&3 & rs no.-28/p1 village Lakhapar, Taluk - Anjar (Gujarat) pin code -370110"],
  ['Emerald land india pvt ltd (Imperial Golf)',
    '20, THE IMPERIAL GOLF ESTATE, TALWANDI KHURD, LUDHIANA - 142025'],
  ['Fashion tech.',
    'A-32, OKHLA INDUSTRIAL AREA, PHASE 1, South Delhi, Delhi, 110020'],
  ['GURU ANGAD DEV VETERINARY AND ANIMAL SCIENCES UNIVERSITY',
    'FEROZPUR ROAD -, LUDHIANA, PUNJAB -141001'],
  ['Grande Green Farms Pvt Ltd.',
    'Village Kubba, Kubba, Kubba Stadium, TEHSIL SAMRALA, Kubba, Ludhiana, Punjab, 141418'],
  ['HAGER STONE INTERNATIONAL PRIVATE LTD.(HERO HOMES)',
    'VILL BIRMI, HB NO-146, MULLANPUR, LUDHIANA- 141101'],
  ['HERO HOMES',
    'VILL BIRMI, HB NO-146, MULLANPUR, LUDHIANA- 141101'],
  ['Hartex Rubber',
    'Hb 219 Villege Doburji, Tehsil Payal, 141421'],
  ['International Tractors Limited (Sonalika)',
    'VILL. CHAK GUJRAN, JALANDHAR ROAD, POST OFFICE PIPLANWALA, Hoshiarpur, Punjab, 146022'],
  ['JEEWAN MALA HOSPITAL',
    '67/1, NEW, ROHTAK ROAD, New Delhi, Delhi, 110005'],
  ['M/S SAEL (Jewar)',
    '00, Village Sabota, Village Sabota, Jhajjar Road, Jhajjar Road, Jewar, Gautambuddha Nagar, Uttar Pradesh, 203135'],
  ['M/s BARAWARE LLP II',
    'Khewat 45/1, 45/7 and 687 BarawareII LLP, Farrukhnagar-Haily Mandi Road, Cambridge International Sr Sec School, Khera Khurampur, Khurmpur, Gurugram, Haryana-122506'],
  ['M/s Chattargarh Renewable Energy Pvt. Ltd (SAEL)',
    'NH-011, Milestone, 207, Chak 4CHD(A), Village & Tehsil Chattargarh, District Bikaner-334021'],
  ['M/s GRA SPINNING MILL',
    'KHASRA NO 80 MIN 293/103, SIDCO INDUSTRIAL AREA GHATTI, KALNA, Kalna, Kathua, Jammu and Kashmir, 184143'],
  ['Ramana Machine',
    'PART A AREA 0B-9B-18-1/2, HADBAST NO 166, BISWAS PUKHTA TARAF, GEHLEWAL, LUDHIANA -141007'],
  ['THEON PHARMA',
    'SAINI MAJRA, THEON, VILLAGE, BLOCK, NALAGARH, Solan, Himachal Pradesh, 174101'],
  ['V-GUARD INDUSTRIES LTD',
    '6th KM Stone, Khasra No-86, Village Basai, Moradabad Road, Kashipur, Udham Singh, Nagar, Uttarakhand, 244713'],
];

// Normalise a company name to alphanumerics + lowercase for matching.
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const db = new Database(DB_PATH);
const allRows = db.prepare('SELECT id, company_name FROM business_book WHERE company_name IS NOT NULL').all();

// Index business_book rows by normalised company name.
const byNorm = new Map();
for (const r of allRows) {
  const k = norm(r.company_name);
  if (!k) continue;
  if (!byNorm.has(k)) byNorm.set(k, []);
  byNorm.get(k).push(r);
}

const upd = db.prepare('UPDATE business_book SET billing_address=?, shipping_address=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');

console.log(`\n[addr] ${DRY ? 'DRY RUN — no writes' : 'APPLYING updates'} · ${DB_PATH}\n`);
let totalRows = 0;
const unmatched = [];

const run = db.transaction(() => {
  for (const [name, address] of ADDRESSES) {
    const matches = byNorm.get(norm(name)) || [];
    if (matches.length === 0) {
      unmatched.push(name);
      console.log(`  ✗ NO MATCH   ${name}`);
      continue;
    }
    const names = [...new Set(matches.map(m => m.company_name))].join(' | ');
    console.log(`  ✓ ${String(matches.length).padStart(2)} row(s)  ${name}`);
    console.log(`              → matched: ${names}`);
    console.log(`              → address: ${address}`);
    if (!DRY) for (const m of matches) upd.run(address, address, m.id);
    totalRows += matches.length;
  }
});
run();

console.log(`\n[addr] ${DRY ? 'would update' : 'updated'} ${totalRows} business_book row(s) across ${ADDRESSES.length - unmatched.length}/${ADDRESSES.length} companies.`);
if (unmatched.length) {
  console.log(`\n[addr] ${unmatched.length} company name(s) NOT found in business_book — fix the name in the ERP or tell me the exact spelling:`);
  for (const u of unmatched) console.log(`        - ${u}`);
}
console.log('');
db.close();
