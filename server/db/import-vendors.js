const path = require('path');
const { getDb, initializeDatabase } = require('./schema');
initializeDatabase();
const db = getDb();
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'vendors_import.json'), 'utf-8'));

// Add new columns if they don't exist (safe migration)
const cols = ['vendor_code','firm_name','district','state','category','deals_in','authorized_dealer','type','turnover','team_size','payment_terms','credit_days','source','category_wise','sub_category','existing_vendor'];
cols.forEach(col => {
  try { db.exec(`ALTER TABLE vendors ADD COLUMN ${col} TEXT`); } catch(e) {}
});

const insert = db.prepare(`INSERT OR IGNORE INTO vendors (vendor_code, name, firm_name, phone, email, district, state, address, category, deals_in, authorized_dealer, type, turnover, team_size, payment_terms, credit_days, gst_number, source, category_wise, sub_category, existing_vendor) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

let added = 0;
for (const v of data) {
  try {
    const r = insert.run(v.vendor_code || null, v.name, v.firm_name, v.phone, v.email, v.district, v.state, v.address, v.category, v.deals_in, v.authorized_dealer, v.type, v.turnover, v.team_size, v.payment_terms, v.credit_days, v.gst_number, v.source, v.category_wise, v.sub_category, v.existing);
    if (r.changes > 0) added++;
  } catch(e) {}
}

console.log(`\n========================================`);
console.log(`  Vendor Import Complete!`);
console.log(`  Added: ${added} vendors`);
console.log(`  Total: ${db.prepare('SELECT COUNT(*) as c FROM vendors').get().c}`);
console.log(`========================================`);
