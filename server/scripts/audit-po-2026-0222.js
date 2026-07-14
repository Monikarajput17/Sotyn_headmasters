// READ-ONLY audit for po-2026-0222 (Jeewan Mala — wrong category/amount).
// Run on the VPS:  cd /root/erp/server && node scripts/audit-po-2026-0222.js
// It changes NOTHING. It prints the PO, its linked business_book, the
// audit_log trail, and candidate Plumbing business_book rows so we can
// decide what to re-link it to.

const { getDb } = require('../db/schema');
const db = getDb();
const PO = 'po-2026-0222';

const rupee = (n) => 'Rs ' + Number(n || 0).toLocaleString('en-IN');

console.log('\n=== 1. Purchase order row ===');
const po = db.prepare(
  `SELECT po.id, po.po_number, po.po_date, po.total_amount, po.business_book_id,
          po.boq_file_link, bb.lead_no, bb.client_name, bb.project_name,
          bb.category AS bb_category, bb.sale_amount_without_gst, bb.po_amount AS bb_po_amount
     FROM purchase_orders po
     LEFT JOIN business_book bb ON bb.id = po.business_book_id
    WHERE po.po_number = ?`
).get(PO);
if (!po) { console.log('  PO not found:', PO); process.exit(0); }
console.log(JSON.stringify(po, null, 2));
console.log('  -> category shown in list =', po.bb_category,
            '| total_amount =', rupee(po.total_amount));

console.log('\n=== 2. Sum of this PO\'s line items (po_items) ===');
const items = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM po_items WHERE po_id = ?').get(po.id);
console.log('  line items:', items.c, '| sum(amount) =', rupee(items.s));

console.log('\n=== 3. audit_log trail for this PO (before/after) ===');
let log = [];
try {
  log = db.prepare(
    `SELECT at, user_name, action, method, path, status_code, before_json, after_json
       FROM audit_log
      WHERE entity_type = 'purchase_order'
        AND (entity_id = ? OR entity_label LIKE ? OR path LIKE ?)
      ORDER BY at DESC LIMIT 20`
  ).all(String(po.id), '%' + PO + '%', '%/' + po.id + '%');
} catch (e) { console.log('  audit_log query error:', e.message); }
if (!log.length) console.log('  (no audit_log rows matched)');
log.forEach(r => {
  console.log(`  ${r.at} ${r.user_name || '?'} ${r.action} ${r.method} ${r.path} -> ${r.status_code}`);
  const pick = (j) => { try { const o = JSON.parse(j); return { business_book_id: o.business_book_id, total_amount: o.total_amount, boq_file_link: o.boq_file_link }; } catch { return null; } };
  if (r.before_json) console.log('     before:', JSON.stringify(pick(r.before_json)));
  if (r.after_json)  console.log('     after :', JSON.stringify(pick(r.after_json)));
});

console.log('\n=== 4. Jeewan Mala business_book rows (to find the Plumbing lead) ===');
const cands = db.prepare(
  `SELECT id, lead_no, client_name, project_name, category, sale_amount_without_gst, po_amount
     FROM business_book
    WHERE project_name LIKE '%Jeewan%' OR project_name LIKE '%Jeewan Mala%' OR client_name LIKE '%Jeewan%'
    ORDER BY category`
).all();
cands.forEach(c => console.log(`  id=${c.id} ${c.lead_no} | ${c.category} | ${c.project_name} | sale=${rupee(c.sale_amount_without_gst)} po=${rupee(c.po_amount)}`));
if (!cands.length) console.log('  (none matched "Jeewan" — widen the LIKE filter)');

console.log('\nNext: if a Plumbing row exists above, re-link the PO to it (see correction script).');
