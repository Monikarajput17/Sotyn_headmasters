// Correct po-2026-0222: re-link to the right (Plumbing) business_book so
// its category + base amount follow the correct lead, and align
// total_amount with the uploaded plumbing BOQ.
//
// DRY-RUN by default — prints what it WOULD do and changes nothing.
// Run on the VPS:
//   cd /root/erp/server
//   node scripts/fix-po-2026-0222.js --bb <PLUMBING_BUSINESS_BOOK_ID>           # preview
//   node scripts/fix-po-2026-0222.js --bb <PLUMBING_BUSINESS_BOOK_ID> --apply   # commit
//
// <PLUMBING_BUSINESS_BOOK_ID> = the id printed by section 4 of
// audit-po-2026-0222.js for the Jeewan Mala *Plumbing* row.
//
// Amount: by default we set total_amount = SUM(po_items.amount) — the
// raw plumbing BOQ total (matches how the upload form fills it). Pass
// --amount <value> to force a specific figure instead.

const { getDb } = require('../db/schema');
const db = getDb();
const PO = 'po-2026-0222';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const bbIdx = args.indexOf('--bb');
const amtIdx = args.indexOf('--amount');
const newBbId = bbIdx >= 0 ? Number(args[bbIdx + 1]) : null;
const forcedAmount = amtIdx >= 0 ? Number(args[amtIdx + 1]) : null;
const rupee = (n) => 'Rs ' + Number(n || 0).toLocaleString('en-IN');

if (!newBbId) {
  console.log('ERROR: pass --bb <PLUMBING_BUSINESS_BOOK_ID> (see audit script section 4).');
  process.exit(1);
}

const po = db.prepare('SELECT id, po_number, business_book_id, total_amount FROM purchase_orders WHERE po_number = ?').get(PO);
if (!po) { console.log('PO not found:', PO); process.exit(1); }

const newBb = db.prepare('SELECT id, lead_no, category, project_name FROM business_book WHERE id = ?').get(newBbId);
if (!newBb) { console.log('Target business_book not found: id', newBbId); process.exit(1); }

const itemSum = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM po_items WHERE po_id = ?').get(po.id).s;
const newAmount = forcedAmount != null ? forcedAmount : itemSum;

console.log('\n--- Correction plan for', PO, '---');
console.log('  business_book_id :', po.business_book_id, '->', newBb.id,
            `(${newBb.lead_no} | ${newBb.category} | ${newBb.project_name})`);
console.log('  total_amount     :', rupee(po.total_amount), '->', rupee(newAmount),
            forcedAmount != null ? '(forced)' : '(= sum of po_items)');

if (!apply) {
  console.log('\nDRY-RUN — nothing changed. Re-run with --apply to commit.');
  process.exit(0);
}

const tx = db.transaction(() => {
  db.prepare('UPDATE purchase_orders SET business_book_id = ?, total_amount = ? WHERE id = ?')
    .run(newBb.id, newAmount, po.id);
  // keep po_items pointer consistent with the new business_book
  db.prepare('UPDATE po_items SET business_book_id = ? WHERE po_id = ?').run(newBb.id, po.id);
});
tx();

const after = db.prepare(
  `SELECT po.po_number, po.total_amount, bb.lead_no, bb.category
     FROM purchase_orders po LEFT JOIN business_book bb ON bb.id = po.business_book_id
    WHERE po.id = ?`
).get(po.id);
console.log('\nAPPLIED. Now:', JSON.stringify(after));
console.log('Reload the Purchase Orders page — category should read', after.category, 'and amount', rupee(after.total_amount));
