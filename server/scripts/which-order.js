// Diagnostic: for a sales bill (delivery_note), show WHICH Business Book order
// it resolves to and that order's Against-Delivery % — via both paths the print
// could use — plus every Business Book order whose client looks like the search
// keyword. Read-only; changes nothing.
//
// Usage (on the VPS):
//   node server/scripts/which-order.js "GST/26-26/62"      # by bill number
//   node server/scripts/which-order.js 123                 # by delivery_note id
//   node server/scripts/which-order.js "GST/26-26/62" GRA  # also list GRA orders

const path = require('path');
const Database = require('better-sqlite3');

const arg = process.argv[2];
const keyword = (process.argv[3] || '').toUpperCase();
const LIVE = process.env.ERP_DB || path.join(__dirname, '..', '..', 'data', 'erp.db');

if (!arg) { console.error('Usage: node which-order.js "<bill number or dn id>" [client keyword]'); process.exit(1); }

const db = new Database(LIVE, { readonly: true });
const dn = db.prepare('SELECT * FROM delivery_notes WHERE document_number = ? OR id = ?').get(arg, arg);
if (!dn) { console.log('No delivery note / bill matches', JSON.stringify(arg)); process.exit(0); }

const fmtBB = (id) => {
  const bb = db.prepare('SELECT id, company_name, project_name, client_name, lead_no, state, payment_against_delivery FROM business_book WHERE id=?').get(id);
  if (!bb) return `#${id} (missing)`;
  const name = bb.company_name || bb.project_name || bb.client_name || '(no name)';
  return `#${bb.id}  ${name}  (lead ${bb.lead_no || '-'})  · State=${bb.state || '-'}  · AGAINST-DELIVERY = ${bb.payment_against_delivery == null ? '(blank)' : bb.payment_against_delivery}`;
};

console.log(`\nBill: ${dn.document_number}   (dn id ${dn.id})   vendor_po_id=${dn.vendor_po_id}\n`);

console.log('A) Order the BILLED ITEMS belong to  (po_items.business_book_id — THIS is what the bill now uses):');
const a = db.prepare(`
  SELECT poi.business_book_id AS id, COUNT(*) AS n
    FROM vendor_po_items vpi
    JOIN indent_items ii ON ii.id = vpi.indent_item_id
    JOIN po_items poi ON poi.id = ii.po_item_id
   WHERE vpi.vendor_po_id = ? AND poi.business_book_id IS NOT NULL
   GROUP BY poi.business_book_id ORDER BY n DESC`).all(dn.vendor_po_id);
if (!a.length) console.log('   (no BOQ-linked items)');
for (const r of a) console.log(`   ${fmtBB(r.id)}   · ${r.n} line(s)`);

console.log('\nB) Order via indent -> order_planning (old path):');
const b = db.prepare(`
  SELECT op.business_book_id AS id FROM vendor_pos vp
    LEFT JOIN indents i ON i.id = vp.indent_id
    LEFT JOIN order_planning op ON op.id = i.planning_id
   WHERE vp.id = ?`).get(dn.vendor_po_id);
console.log('   ' + (b && b.id ? fmtBB(b.id) : '(none — chain broken)'));

if (keyword) {
  console.log(`\nAll Business Book orders matching "${keyword}":`);
  for (const bb of db.prepare(
    `SELECT id FROM business_book
      WHERE UPPER(COALESCE(company_name,'')||' '||COALESCE(project_name,'')||' '||COALESCE(client_name,'')) LIKE ?`
  ).all('%' + keyword + '%')) console.log('   ' + fmtBB(bb.id));
}

console.log('\n→ The bill uses order (A). If its AGAINST-DELIVERY differs from what');
console.log('  you expected, either fix that order\'s % in Business Book, or the PO');
console.log('  items are linked to the wrong order.\n');
db.close();
