// Sales Billing — 4-type sequential client billing (mam 2026-06-13).
// Type 1 Sales Order → 2 Material Delivery → 3 Installation → 4 Final.
// Built on existing Business Book orders; amounts typed manually; one GST %
// per bill; numbering SEPL/SB/<FY>/NNN; Admin + Accounts (installation perm).
const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const round2 = n => Math.round((+n || 0) * 100) / 100;
const BILL_STATUS = { 1: 'ORDER BOOKED', 2: 'MATERIAL DELIVERED', 3: 'INSTALLATION COMPLETE', 4: 'READY FOR PAYMENT' };
const REF_TYPE = { 1: 'Sales Order', 2: 'Delivery Challan', 3: 'DPR', 4: 'Commissioning Report' };

// Financial-year label for a date: Apr–Mar. 2026-06 → "26-27".
function fyLabel(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const y = d.getFullYear(), m = d.getMonth() + 1;
  const start = m >= 4 ? y : y - 1;
  return `${String(start).slice(-2)}-${String(start + 1).slice(-2)}`;
}
// Next bill number SEPL/SB/<FY>/NNN, sequence per FY.
function nextBillNumber(db, dateStr) {
  const prefix = `SEPL/SB/${fyLabel(dateStr)}/`;
  let max = 0;
  for (const r of db.prepare('SELECT bill_number FROM sales_bills WHERE bill_number LIKE ?').all(prefix + '%')) {
    const n = parseInt(String(r.bill_number).split('/').pop(), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return prefix + String(max + 1).padStart(3, '0');
}

// Business Book orders for the "new bill" picker — Order→Planning projects
// (status='planning') surface first, then the rest, so the Sales Order bill is
// raised off the planning project's name / value / BOQ items.
router.get('/orders', requirePermission('installation', 'view'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, lead_no, client_name, company_name, project_name, po_number,
            po_date, po_amount, sale_amount_without_gst, status
       FROM business_book
      ORDER BY CASE status
                 WHEN 'planning' THEN 0 WHEN 'execution' THEN 1
                 WHEN 'advance_received' THEN 2 WHEN 'completed' THEN 3 ELSE 4 END,
               id DESC`
  ).all();
  res.json(rows.map(r => ({
    ...r,
    customer_name: (r.client_name || r.company_name || '').trim(),
  })));
});

// One order: its items + the bills already raised against it (to know the
// next allowed type in the chain).
router.get('/orders/:bbId', requirePermission('installation', 'view'), (req, res) => {
  const db = getDb();
  const bb = db.prepare('SELECT * FROM business_book WHERE id=?').get(req.params.bbId);
  if (!bb) return res.status(404).json({ error: 'Order not found' });
  const items = db.prepare(
    `SELECT id, description, quantity, unit, rate, amount FROM po_items WHERE business_book_id=? ORDER BY id`
  ).all(bb.id);
  const bills = db.prepare(
    `SELECT id, bill_type, bill_number, amount, total_amount, bill_status, approval_status, bill_date
       FROM sales_bills WHERE business_book_id=? AND bill_type IS NOT NULL ORDER BY bill_type`
  ).all(bb.id);
  const haveTypes = new Set(bills.map(b => b.bill_type));
  // In-module chain is 1 → 3 → 4. Type 2 (material delivery) is billed in
  // Dispatch (mam kept the old flow), so it's not created here.
  let nextType = null;
  for (const t of [1, 3, 4]) { if (!haveTypes.has(t)) { nextType = t; break; } }
  res.json({
    order: {
      id: bb.id, lead_no: bb.lead_no, po_number: bb.po_number,
      customer_name: (bb.client_name || bb.company_name || '').trim(),
      project_name: bb.project_name, po_amount: bb.po_amount,
      sale_amount_without_gst: bb.sale_amount_without_gst,
    },
    items, bills, next_type: nextType,
  });
});

// List all 4-type sales bills (legacy delivery-note rows have bill_type NULL).
router.get('/', requirePermission('installation', 'view'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT sb.*, u.name AS created_by_name,
            COALESCE((SELECT SUM(p.amount) FROM payments p
                       WHERE p.reference_type='sales_bill' AND p.reference_id=sb.id), 0) AS received_amount
       FROM sales_bills sb LEFT JOIN users u ON u.id = sb.created_by
      WHERE sb.bill_type IS NOT NULL
      ORDER BY sb.id DESC`
  ).all();
  res.json(rows);
});

// Pending-billing alerts (mam 2026-06-13: "show data automatically as an alert
// so we don't forget a sales order / bill"). Surfaces what still needs billing:
//   - active orders (planning/execution) with NO Type-1 Sales Order bill
//   - approved, billing-ready DPRs not yet billed (Type-3 install)
// MUST be declared before GET /:id so it isn't captured as an :id.
router.get('/pending', requirePermission('installation', 'view'), (req, res) => {
  const db = getDb();
  const ordersWithoutSo = db.prepare(
    `SELECT bb.id, bb.lead_no, bb.client_name, bb.company_name, bb.project_name,
            bb.po_amount, bb.sale_amount_without_gst, bb.status
       FROM business_book bb
      WHERE bb.status IN ('planning','execution','advance_received')
        AND NOT EXISTS (SELECT 1 FROM sales_bills sb WHERE sb.business_book_id=bb.id AND sb.bill_type=1)
      ORDER BY CASE bb.status WHEN 'planning' THEN 0 WHEN 'execution' THEN 1 ELSE 2 END, bb.id DESC`
  ).all().map(r => ({
    id: r.id, lead_no: r.lead_no, status: r.status, project_name: r.project_name,
    customer_name: (r.client_name || r.company_name || '').trim(),
    value: r.sale_amount_without_gst || r.po_amount || 0,
  }));
  let dprReady = { count: 0, value: 0 };
  try {
    dprReady = db.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(COALESCE(d.grand_total_a,0)),0) AS value
         FROM dpr d JOIN sites s ON s.id = d.site_id
        WHERE d.approval_status='approved' AND d.billing_ready=1
          AND d.sales_bill_id IS NULL AND s.business_book_id IS NOT NULL`
    ).get();
  } catch (e) { /* dpr.sales_bill_id may be absent on a stale DB */ }
  res.json({ orders_without_so: ordersWithoutSo, dpr_ready: dprReady });
});

// Material billing view (mam 2026-06-13): each material dispatch (delivery
// challan, by indent number) and whether its client Sales Bill is DONE or
// PENDING. The Sales Bill itself is still created in Dispatch (legacy flow);
// this surfaces the pendency. MUST be before GET /:id.
router.get('/material', requirePermission('installation', 'view'), (req, res) => {
  const db = getDb();
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT dn.id, dn.document_number, dn.delivery_date, dn.source,
              dn.sales_bill_pending, dn.sales_bill_number, dn.grand_total_amount, dn.items_json,
              COALESCE(dn.sales_bill_file_path,
                       (SELECT sbn.file_path FROM delivery_notes sbn
                         WHERE sbn.document_type='sales_bill' AND sbn.document_number=dn.sales_bill_number LIMIT 1)
              ) AS sales_bill_file,
              COALESCE(vp.indent_id, dn.indent_id) AS indent_id, i.indent_number, i.site_name
         FROM delivery_notes dn
         LEFT JOIN vendor_pos vp ON dn.vendor_po_id = vp.id
         LEFT JOIN indents i ON i.id = COALESCE(vp.indent_id, dn.indent_id)
        WHERE dn.document_type = 'challan' AND COALESCE(dn.source,'') <> 'rgp'
        ORDER BY dn.id DESC LIMIT 500`
    ).all();
  } catch (e) { /* tables may be absent on a stale DB */ }
  // Resolve a challan's order (business_book) → its BOQ rates + Against-Delivery
  // %, so VALUE = (delivered qty × BOQ rate) × delivery % (mam 2026-06-15).
  const indentBb = new Map();   // indent_id/site → business_book_id
  const bbCache = new Map();    // bb_id → { pct, rates: Map(descLower→rate) }
  const resolveBb = (indentId, siteName) => {
    const key = indentId ? ('i' + indentId) : ('s:' + (siteName || ''));
    if (indentBb.has(key)) return indentBb.get(key);
    let bbId = null;
    try {
      if (indentId) {
        const r = db.prepare('SELECT op.business_book_id AS bb FROM indents i LEFT JOIN order_planning op ON op.id = i.planning_id WHERE i.id=?').get(indentId);
        bbId = (r && r.bb) || null;
        if (!bbId) { const i2 = db.prepare('SELECT site_name FROM indents WHERE id=?').get(indentId); siteName = (i2 && i2.site_name) || siteName; }
      }
      if (!bbId && siteName) {
        const s = db.prepare('SELECT business_book_id AS bb FROM sites WHERE LOWER(TRIM(name))=LOWER(TRIM(?)) AND business_book_id IS NOT NULL LIMIT 1').get(siteName);
        bbId = (s && s.bb) || null;
      }
    } catch (_) {}
    indentBb.set(key, bbId);
    return bbId;
  };
  // For an order: the Against-Delivery % + its BOQ rates, indexed BOTH by
  // po_item id and by item description, so a dispatched line resolves its BOQ
  // rate even when it isn't linked by po_item_id (mam 2026-06-15: some rows
  // showed ₹0 because the indent items weren't linked to the BOQ).
  const getBb = (bbId) => {
    if (!bbId) return null;
    if (bbCache.has(bbId)) return bbCache.get(bbId);
    let pct = 0; const byId = new Map(), byDesc = new Map();
    try {
      const bb = db.prepare('SELECT payment_against_delivery FROM business_book WHERE id=?').get(bbId);
      pct = parseFloat(String((bb && bb.payment_against_delivery) || '').replace(/[^0-9.]/g, '')) || 0;
      for (const it of db.prepare('SELECT id, description, rate FROM po_items WHERE business_book_id=?').all(bbId)) {
        byId.set(it.id, +it.rate || 0);
        if (it.description) byDesc.set(String(it.description).toLowerCase().trim(), +it.rate || 0);
      }
    } catch (_) {}
    const v = { pct, byId, byDesc };
    bbCache.set(bbId, v);
    return v;
  };
  const indentItemsStmt = db.prepare('SELECT quantity, po_item_id, description, rate FROM indent_items WHERE indent_id=?');

  const out = rows.map(r => {
    const bb = getBb(resolveBb(r.indent_id, r.site_name));
    const pct = bb ? bb.pct : 0;
    let boqValue = 0, itemCount = 0;
    if (r.indent_id) {
      try {
        const items = indentItemsStmt.all(r.indent_id);
        itemCount = items.length;
        for (const it of items) {
          // BOQ rate: by po_item link → by description → the indent line rate.
          let rate = 0;
          if (bb) {
            if (it.po_item_id != null && bb.byId.has(it.po_item_id)) rate = bb.byId.get(it.po_item_id);
            if (!rate) rate = bb.byDesc.get(String(it.description || '').toLowerCase().trim()) || 0;
          }
          if (!rate) rate = +it.rate || 0;
          boqValue += (+it.quantity || 0) * rate;
        }
      } catch (_) {}
    }
    if (!itemCount) { try { itemCount = JSON.parse(r.items_json || '[]').length; } catch (_) {} }
    const value = round2(boqValue * pct / 100);
    return {
      id: r.id, challan_no: r.document_number, date: r.delivery_date, source: r.source,
      indent_number: r.indent_number, site_name: r.site_name, item_count: itemCount,
      boq_value: round2(boqValue), delivery_pct: pct, value,
      sales_bill_status: r.sales_bill_number ? 'done' : (r.sales_bill_pending ? 'pending' : 'na'),
      sales_bill_number: r.sales_bill_number || null,
      sales_bill_file: r.sales_bill_file || null,
    };
  });
  res.json(out);
});

// One bill + its items.
router.get('/:id', requirePermission('installation', 'view'), (req, res) => {
  const db = getDb();
  const bill = db.prepare('SELECT * FROM sales_bills WHERE id=? AND bill_type IS NOT NULL').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  bill.items = db.prepare('SELECT * FROM sales_bill_items WHERE sales_bill_id=? ORDER BY id').all(bill.id);
  bill.log = db.prepare(
    `SELECT l.*, u.name AS by_name FROM sales_bill_status_log l LEFT JOIN users u ON u.id=l.changed_by
      WHERE l.sales_bill_id=? ORDER BY l.id`
  ).all(bill.id);
  bill.payments = db.prepare(
    `SELECT p.*, u.name AS by_name FROM payments p LEFT JOIN users u ON u.id=p.created_by
      WHERE p.reference_type='sales_bill' AND p.reference_id=? ORDER BY p.id`
  ).all(bill.id);
  bill.received_amount = bill.payments.reduce((s, p) => s + (+p.amount || 0), 0);
  res.json(bill);
});

// ─── Installation Sales Bill — printable TAX INVOICE (mam 2026-06-24, matches
// the supplied template) ──────────────────────────────────────────────────
function amountInWords(n) {
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (x) => x < 20 ? a[x] : `${b[Math.floor(x / 10)]}${x % 10 ? ' ' + a[x % 10] : ''}`;
  const three = (x) => x >= 100 ? `${a[Math.floor(x / 100)]} Hundred${x % 100 ? ' ' + two(x % 100) : ''}` : two(x);
  let num = Math.floor(+n || 0); if (!num) return 'Zero';
  const parts = [];
  const cr = Math.floor(num / 10000000); num %= 10000000;
  const la = Math.floor(num / 100000); num %= 100000;
  const th = Math.floor(num / 1000); num %= 1000;
  if (cr) parts.push(`${two(cr)} Crore`);
  if (la) parts.push(`${two(la)} Lakh`);
  if (th) parts.push(`${two(th)} Thousand`);
  if (num) parts.push(three(num));
  return parts.join(' ').trim();
}
router.get('/:id/print', requirePermission('installation', 'view'), (req, res) => {
  const db = getDb();
  const bill = db.prepare('SELECT * FROM sales_bills WHERE id=? AND bill_type IS NOT NULL').get(req.params.id);
  if (!bill) return res.status(404).send('Bill not found');
  let items = db.prepare('SELECT * FROM sales_bill_items WHERE sales_bill_id=? ORDER BY id').all(bill.id);
  // Installation (Type 3) bills store only the total — pull the BOQ work items
  // from the DPRs they were generated from, aggregated per BOQ line, and scaled
  // so they sum to the bill's taxable value (mam 2026-06-24: "as per DPR BOQ
  // item show"). Works for already-created bills, no migration needed.
  if (!items.length && bill.bill_type === 3) {
    let wi = [];
    try {
      wi = db.prepare(
        `SELECT wi.description, wi.unit, wi.rate,
                COALESCE(SUM(wi.actual_qty), 0) AS qty, COALESCE(SUM(wi.amount), 0) AS amount
           FROM dpr_work_items wi JOIN dpr d ON d.id = wi.dpr_id
          WHERE d.sales_bill_id = ?
          GROUP BY COALESCE(wi.po_item_id, wi.description), wi.rate, wi.unit
          ORDER BY MIN(wi.id)`
      ).all(bill.id);
    } catch (_) { wi = []; }
    const rawSum = wi.reduce((s, x) => s + (+x.amount || 0), 0);
    const ratio = rawSum > 0 ? (+bill.amount || 0) / rawSum : 1;
    items = wi.map(x => ({
      description: x.description,
      qty_ordered: +x.qty || 0,
      unit: x.unit,
      rate: round2((+x.rate || 0) * ratio),
      amount: round2((+x.amount || 0) * ratio),
    }));
  }
  // mam 2026-06-30 ("rate pending"): fill any line whose rate is 0 from the
  // order's CURRENT BOQ (po_items, matched by description), so pricing the order's
  // BOQ flows into the invoice without recreating the bill. Only fills 0/blank
  // rates — never overrides a rate already snapshotted on the bill.
  if (bill.business_book_id && items.some(it => !(+it.rate > 0))) {
    const byDesc = new Map();
    for (const p of db.prepare('SELECT description, rate FROM po_items WHERE business_book_id=?').all(bill.business_book_id)) {
      if (+p.rate > 0 && p.description) byDesc.set(String(p.description).toLowerCase().trim(), +p.rate);
    }
    items = items.map(it => {
      if (+it.rate > 0) return it;
      const live = byDesc.get(String(it.description || '').toLowerCase().trim()) || 0;
      if (!live) return it;
      const qty = +it.qty_delivered || +it.qty_ordered || 0;
      return { ...it, rate: live, amount: round2(qty * live) };
    });
  }
  const bb = bill.business_book_id ? db.prepare('SELECT * FROM business_book WHERE id=?').get(bill.business_book_id) : null;
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(Buffer.from(installBillHTML({ bill, items, bb }), 'utf8'));
});
function installBillHTML({ bill, items, bb }) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inr = (n) => (+n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const gstPct = +bill.gst_rate || 18;
  // When the bill was created before the order was priced, its stored amount/gst
  // are 0 — derive them from the (now live-filled) line items so the invoice shows
  // real figures once the order BOQ is priced (mam 2026-06-30).
  const itemsSum = items.reduce((s, it) => s + (+it.amount || 0), 0);
  const sub = (+bill.amount > 0) ? +bill.amount : Math.round(itemsSum * 100) / 100;
  const igst = (+bill.gst_amount > 0) ? +bill.gst_amount : Math.round(sub * gstPct) / 100;
  const grand = (+bill.total_amount > 0) ? +bill.total_amount : Math.round((sub + igst) * 100) / 100;
  const roundOff = +(Math.round(grand) - (sub + igst)).toFixed(2);
  const billTo = esc(bill.customer_name || bb?.company_name || bb?.client_name || '');
  const billAddr = esc(bb?.billing_address || '');
  const shipName = esc(bill.project_name || bb?.project_name || '');
  const shipAddr = esc(bb?.shipping_address || bb?.billing_address || '');
  const clientGstin = esc(bill.customer_gstin || bb?.gstin || '');
  const fy = (String(bill.bill_number || '').match(/SB\/([0-9-]+)\//) || [])[1] || fyLabel(bill.bill_date);
  const padRows = Math.max(0, 8 - items.length);
  const itemRows = items.map((it, i) => {
    const qty = +it.qty_delivered || +it.qty_ordered || 0;
    return `<tr><td class="c">${i + 1}</td><td>${esc(it.description || '')}</td><td class="c">${esc(it.hsn_code || '')}</td><td class="r">${inr(qty)}</td><td class="c">${esc(it.unit || '')}</td><td class="r">${inr(it.rate)}</td><td class="r">${inr(it.amount)}</td></tr>`;
  }).join('') + Array.from({ length: padRows }, () => `<tr><td class="c">&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(bill.bill_number)}</title>
<style>
  *{box-sizing:border-box} body{font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;margin:0;padding:16px;font-size:11px}
  .sheet{max-width:820px;margin:0 auto;border:1.5px solid #1e40af}
  .hd{text-align:center;padding:8px 10px;border-bottom:1.5px solid #1e40af}
  .hd h1{margin:0;color:#1e40af;font-size:20px;letter-spacing:1px}
  .hd .tag{font-size:9px;letter-spacing:2px;color:#444;margin-top:2px}
  .hd .addr{font-size:9.5px;color:#444;margin-top:3px;line-height:1.5}
  .hd .gst{font-size:10px;font-weight:bold;margin-top:3px}
  .title{background:#1e40af;color:#fff;text-align:center;font-weight:bold;letter-spacing:1px;padding:5px;font-size:12px}
  .orig{text-align:right;font-size:9px;color:#1e40af;padding:2px 8px;font-style:italic}
  table{width:100%;border-collapse:collapse}
  .meta td{border:1px solid #d8c4c4;padding:4px 6px;font-size:10px} .meta .k{color:#1e40af;font-weight:bold;width:14%}
  .party td{border:1px solid #d8c4c4;padding:6px 8px;vertical-align:top;width:50%}
  .party .lab{color:#1e40af;font-weight:bold;font-size:10px;margin-bottom:3px}
  .items th{background:#1e40af;color:#fff;padding:5px 6px;font-size:10px;border:1px solid #1e40af}
  .items td{border:1px solid #d8c4c4;padding:4px 6px;font-size:10px} .items .r{text-align:right} .items .c{text-align:center}
  .tot td{border:1px solid #d8c4c4;padding:3px 8px;font-size:10.5px} .tot .k{text-align:right;font-weight:600;width:78%} .tot .v{text-align:right}
  .grand{background:#e8eefc;font-weight:bold} .grand td{font-size:12px;color:#1e40af}
  .words{border:1px solid #d8c4c4;padding:5px 8px;font-size:10px;font-style:italic}
  .blk{border:1px solid #d8c4c4;padding:6px 8px;font-size:9.5px;line-height:1.6;vertical-align:top}
  .blk b{color:#1e40af}
  .sign{border:1px solid #d8c4c4;padding:8px;height:74px;font-size:9.5px;position:relative}
  .sign .auth{position:absolute;bottom:6px;right:8px;font-weight:bold;color:#1e40af}
  .foot{text-align:center;font-size:8.5px;color:#777;padding:6px}
  .print-btn{position:fixed;top:10px;right:10px;padding:8px 14px;background:#1e40af;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px}
  @media print{.print-btn{display:none}}
</style></head><body>
<button class="print-btn" onclick="window.print()">🖨 Print / Save PDF</button>
<div class="sheet">
  <div class="hd">
    <h1>SECURED ENGINEERS PVT. LTD</h1>
    <div class="tag">ELECTRICAL · HVAC · FIRE SAFETY · PLUMBING · SOLAR EPC</div>
    <div class="addr">H.O.: 2480/1, B.K Tower, 1st Floor, Near Grewal Hospital, Gill Road, Ludhiana, Punjab – 141003<br>
    Noida: 91, Springboard, Sector 2, Noida (UP) &nbsp;|&nbsp; PAN-INDIA: LUDHIANA | NOIDA | BANGALORE | MUMBAI</div>
    <div class="gst">GSTIN: 03AASCS7836D2Z3 &nbsp;&nbsp; PAN: AASCS7836D</div>
  </div>
  <div class="title">TAX INVOICE – INSTALLATION SALES BILL</div>
  <div class="orig">ORIGINAL FOR RECIPIENT</div>
  <table class="meta"><tbody>
    <tr><td class="k">Invoice No.</td><td>${esc(bill.bill_number)}</td><td class="k">Invoice Date</td><td>${esc(bill.bill_date)}</td><td class="k">Sales Order</td><td>${esc(bill.reference_doc_no || '')}</td></tr>
    <tr><td class="k">Financial Yr</td><td>${esc(fy)}</td><td class="k">Client PO No.</td><td>${esc(bb?.po_number || '')}</td><td class="k">E-Way Bill</td><td></td></tr>
  </tbody></table>
  <table class="party"><tbody><tr>
    <td><div class="lab">BILL TO</div><b>${billTo}</b><br>${billAddr}${clientGstin ? `<br>GSTIN: ${clientGstin}` : ''}</td>
    <td><div class="lab">SHIP TO / INSTALLATION SITE</div><b>${shipName}</b><br>${shipAddr}</td>
  </tr></tbody></table>
  <table class="items"><thead><tr>
    <th style="width:5%">SL</th><th>DESCRIPTION OF GOODS / INSTALLATION SERVICE</th><th style="width:10%">HSN/SAC</th><th style="width:8%">QTY</th><th style="width:8%">UOM</th><th style="width:13%">RATE (Rs.)</th><th style="width:14%">AMOUNT (Rs.)</th>
  </tr></thead><tbody>${itemRows}</tbody></table>
  <table class="tot"><tbody>
    <tr><td class="k">Sub Total (Taxable Value)</td><td class="v">${inr(sub)}</td></tr>
    <tr><td class="k">Freight / Packing / Other</td><td class="v">0.00</td></tr>
    <tr><td class="k">Add: IGST @ ${gstPct}%</td><td class="v">${inr(igst)}</td></tr>
    <tr><td class="k">Round Off</td><td class="v">${roundOff >= 0 ? '+' : ''}${inr(roundOff)}</td></tr>
    <tr class="grand"><td class="k">GRAND TOTAL (Rs.)</td><td class="v">${inr(Math.round(grand))}</td></tr>
  </tbody></table>
  <div class="words"><b>AMOUNT CHARGEABLE (IN WORDS):</b> Rupees ${amountInWords(Math.round(grand))} Only</div>
  <table><tbody><tr>
    <td class="blk" style="width:55%"><b>PAYMENT TERMS</b><br>40% of basic value + 100% GST due on delivery; balance per agreed terms.<br><br>
      <b>TERMS &amp; CONDITIONS</b><br>• Payment: 40% basic + 100% GST on delivery; balance per agreed terms.<br>• Interest @ 18% p.a. on overdue amounts.<br>• Goods once sold are not taken back / exchanged.<br>• Installation warranty as per work order. Subject to Ludhiana jurisdiction.<br>• Cheque / DD in favour of "Secured Engineers Pvt. Ltd."; quote Invoice No.</td>
    <td class="blk" style="width:45%"><b>BANK DETAILS FOR PAYMENT</b><br>Beneficiary: Secured Engineers Pvt. Ltd.<br>Bank / Branch: ____________________<br>A/c No.: ____________________<br>IFSC: ____________________<br>UPI ID: ____________________</td>
  </tr></tbody></table>
  <table><tbody><tr>
    <td class="sign" style="width:55%"><b>RECEIVER'S ACKNOWLEDGEMENT</b><br>Received the above goods / installation in good condition.<br><br>Name, Signature &amp; Stamp with Date</td>
    <td class="sign" style="width:45%">For <b>SECURED ENGINEERS PVT. LTD.</b><div class="auth">Authorised Signatory</div></td>
  </tr></tbody></table>
  <div class="foot">This is a Computer-Generated Tax Invoice, valid with IRN / signed QR code. &nbsp;E. &amp; O.E.&nbsp; · Certified that the particulars given above are true and correct.</div>
</div></body></html>`;
}

// Create a sales bill. Enforces the 1→2→3→4 chain per order.
router.post('/', requirePermission('installation', 'create'), (req, res) => {
  try {
    const db = getDb();
    const business_book_id = +req.body.business_book_id;
    const bill_type = +req.body.bill_type;
    if (!business_book_id) return res.status(400).json({ error: 'Pick a Business Book order' });
    if (bill_type === 2) return res.status(400).json({ error: 'Type 2 (material delivery) is billed in Dispatch, not here.' });
    if (![1, 3, 4].includes(bill_type)) return res.status(400).json({ error: 'bill_type must be 1, 3 or 4' });

    const bb = db.prepare('SELECT * FROM business_book WHERE id=?').get(business_book_id);
    if (!bb) return res.status(404).json({ error: 'Order not found' });

    // Chain validation over the in-module sequence 1 → 3 → 4. Every earlier
    // type must already exist; this type must not.
    const SEQ = [1, 3, 4];
    const existing = db.prepare(
      'SELECT id, bill_type FROM sales_bills WHERE business_book_id=? AND bill_type IS NOT NULL'
    ).all(business_book_id);
    const byType = new Map(existing.map(b => [b.bill_type, b.id]));
    if (byType.has(bill_type)) return res.status(409).json({ error: `Type ${bill_type} bill already exists for this order` });
    for (const t of SEQ) {
      if (t >= bill_type) break;
      if (!byType.has(t)) return res.status(409).json({ error: `Create the Type ${t} bill first — bills are sequential` });
    }
    const earlier = SEQ.filter(t => t < bill_type && byType.has(t));
    const previous_bill_id = earlier.length ? byType.get(earlier[earlier.length - 1]) : null;

    const amount = round2(req.body.amount);
    const gst_rate = round2(req.body.gst_rate);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amount must be a non-negative number' });
    if (!Number.isFinite(gst_rate) || gst_rate < 0 || gst_rate > 100) return res.status(400).json({ error: 'GST % must be 0-100' });
    const gst_amount = round2(amount * gst_rate / 100);
    const total_amount = round2(amount + gst_amount);
    const bill_date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.bill_date) ? req.body.bill_date : new Date().toISOString().split('T')[0];
    const customer_name = (bb.client_name || bb.company_name || '').trim();
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    const out = db.transaction(() => {
      const bill_number = nextBillNumber(db, bill_date);
      const r = db.prepare(
        `INSERT INTO sales_bills
           (bill_number, bill_date, amount, gst_amount, total_amount, gst_rate,
            bill_type, business_book_id, customer_name, project_name, bill_status,
            previous_bill_id, reference_doc_type, reference_doc_no, approval_status,
            payment_status, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft', 'pending', ?)`
      ).run(bill_number, bill_date, amount, gst_amount, total_amount, gst_rate,
        bill_type, business_book_id, customer_name, bb.project_name || null, BILL_STATUS[bill_type],
        previous_bill_id, REF_TYPE[bill_type], req.body.reference_doc_no || null, req.user.id);
      const billId = r.lastInsertRowid;
      const insItem = db.prepare(
        `INSERT INTO sales_bill_items (sales_bill_id, description, qty_ordered, qty_delivered, unit, rate, amount)
         VALUES (?,?,?,?,?,?,?)`
      );
      for (const it of items) {
        if (!it || (!it.description && !it.amount)) continue;
        insItem.run(billId, it.description || '', round2(it.qty_ordered), round2(it.qty_delivered), it.unit || '', round2(it.rate), round2(it.amount));
      }
      db.prepare('INSERT INTO sales_bill_status_log (sales_bill_id, status, changed_by, notes) VALUES (?,?,?,?)')
        .run(billId, 'draft', req.user.id, `${REF_TYPE[bill_type]} bill created`);
      return { id: billId, bill_number };
    })();

    res.status(201).json({ message: `Bill ${out.bill_number} created`, ...out });
  } catch (err) {
    console.error('sales-billing create error', err);
    res.status(500).json({ error: err.message });
  }
});

// Approve a bill (Admin + Accounts via installation edit).
router.put('/:id/approve', requirePermission('installation', 'edit'), (req, res) => {
  const db = getDb();
  const bill = db.prepare('SELECT id, approval_status FROM sales_bills WHERE id=? AND bill_type IS NOT NULL').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  const next = req.body.approval_status === 'draft' ? 'draft' : 'approved';
  db.prepare('UPDATE sales_bills SET approval_status=? WHERE id=?').run(next, bill.id);
  db.prepare('INSERT INTO sales_bill_status_log (sales_bill_id, status, changed_by, notes) VALUES (?,?,?,?)')
    .run(bill.id, next, req.user.id, next === 'approved' ? 'Approved' : 'Reverted to draft');
  res.json({ message: next === 'approved' ? 'Approved' : 'Reverted to draft', approval_status: next });
});

// Delete a bill — only if no later-type bill in its chain references it.
router.delete('/:id', requirePermission('installation', 'delete'), (req, res) => {
  const db = getDb();
  const bill = db.prepare('SELECT id FROM sales_bills WHERE id=? AND bill_type IS NOT NULL').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  const child = db.prepare('SELECT id FROM sales_bills WHERE previous_bill_id=?').get(bill.id);
  if (child) return res.status(409).json({ error: 'Delete the later bill in this chain first' });
  // Free the DPRs this installation bill consumed so they can be re-billed.
  db.prepare('UPDATE dpr SET sales_bill_id=NULL WHERE sales_bill_id=?').run(bill.id);
  db.prepare('DELETE FROM sales_bills WHERE id=?').run(bill.id);
  res.json({ message: 'Bill deleted' });
});

// Mark an installation bill "Sent to Client" — the only manual step on an
// auto-generated Type-3 bill (mam 2026-06-13). Toggle.
router.put('/:id/sent', requirePermission('installation', 'edit'), (req, res) => {
  const db = getDb();
  const bill = db.prepare('SELECT id, sent_to_client FROM sales_bills WHERE id=? AND bill_type IS NOT NULL').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  const sent = bill.sent_to_client ? 0 : 1;
  db.prepare('UPDATE sales_bills SET sent_to_client=?, sent_at=' + (sent ? 'CURRENT_TIMESTAMP' : 'NULL') + ' WHERE id=?').run(sent, bill.id);
  db.prepare('INSERT INTO sales_bill_status_log (sales_bill_id, status, changed_by, notes) VALUES (?,?,?,?)')
    .run(bill.id, sent ? 'sent_to_client' : 'unsent', req.user.id, sent ? 'Sent to client' : 'Marked not sent');
  res.json({ message: sent ? 'Marked Sent to Client' : 'Marked not sent', sent_to_client: sent });
});

// Record a payment against a Type-4 (Final) bill — payment is only allowed on
// the final bill (spec rule). Logs into `payments`, updates the bill's
// payment_status, and upserts a Receivables row so it shows in the ledger.
router.post('/:id/payment', requirePermission('installation', 'edit'), (req, res) => {
  try {
    const db = getDb();
    const bill = db.prepare('SELECT * FROM sales_bills WHERE id=? AND bill_type IS NOT NULL').get(req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    if (bill.bill_type !== 4) return res.status(400).json({ error: 'Payment can only be recorded against the Type 4 (Final) bill' });
    if (bill.approval_status !== 'approved') return res.status(400).json({ error: 'Approve the Final bill before recording payment' });
    const amount = round2(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    const payment_date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.payment_date) ? req.body.payment_date : new Date().toISOString().split('T')[0];
    const payment_mode = ['Cash', 'Bank', 'UPI', 'Cheque', 'NEFT/RTGS'].includes(req.body.payment_mode) ? req.body.payment_mode : 'Bank';

    const out = db.transaction(() => {
      db.prepare(
        `INSERT INTO payments (type, reference_type, reference_id, amount, payment_date, payment_mode, transaction_ref, notes, created_by)
         VALUES ('receivable', 'sales_bill', ?, ?, ?, ?, ?, ?, ?)`
      ).run(bill.id, amount, payment_date, payment_mode, req.body.transaction_ref || null, req.body.notes || null, req.user.id);

      const received = round2(db.prepare(
        `SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE reference_type='sales_bill' AND reference_id=?`
      ).get(bill.id).s);
      const pstatus = received >= bill.total_amount - 0.01 ? 'paid' : received > 0 ? 'partial' : 'pending';
      db.prepare('UPDATE sales_bills SET payment_status=? WHERE id=?').run(pstatus, bill.id);
      db.prepare('INSERT INTO sales_bill_status_log (sales_bill_id, status, changed_by, notes) VALUES (?,?,?,?)')
        .run(bill.id, pstatus, req.user.id, `Payment ₹${amount} (${payment_mode})`);

      // Upsert the Receivables ledger row for this final bill.
      const outstanding = round2(bill.total_amount - received);
      const rstatus = outstanding <= 0.01 ? 'green' : received > 0 ? 'yellow' : 'red';
      const existing = db.prepare('SELECT id FROM receivables WHERE invoice_number=?').get(bill.bill_number);
      if (existing) {
        db.prepare('UPDATE receivables SET received_amount=?, outstanding_amount=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
          .run(received, outstanding, rstatus, existing.id);
      } else {
        db.prepare(
          `INSERT INTO receivables (client_name, project_name, business_book_id, invoice_number, invoice_date,
             invoice_amount, received_amount, outstanding_amount, status, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).run(bill.customer_name || 'Customer', bill.project_name || null, bill.business_book_id, bill.bill_number,
          bill.bill_date, bill.total_amount, received, outstanding, rstatus, req.user.id);
      }
      return { received, outstanding, payment_status: pstatus };
    })();

    res.json({ message: 'Payment recorded', ...out });
  } catch (err) {
    console.error('sales-billing payment error', err);
    res.status(500).json({ error: err.message });
  }
});

// Generate Type-3 Installation bills from DPRs (mam 2026-06-13: "installation
// bill according to DPR every 15 days, auto"). Sums each project's DPR Table-A
// value (grand_total_a = labour/installation billing value) for approved,
// billing-ready, NOT-yet-billed DPRs, and raises one Type-3 bill per project.
// Idempotent via dpr.sales_bill_id (a DPR is billed once). Returns a summary.
// `draft=true` (default) creates the bills as DRAFT for review; the scheduled
// fortnightly job calls this with draft=false to auto-approve.
function generateInstallationBills(db, userId, { draft = true } = {}) {
  // Bill value = the BOQ items × qty recorded in the DPR (mam 2026-06-13),
  // i.e. the sum of that DPR's work-item amounts — not the labour-only total.
  const rows = db.prepare(
    `SELECT d.id AS dpr_id, d.report_date, s.business_book_id AS bb_id,
            COALESCE((SELECT SUM(wi.amount) FROM dpr_work_items wi WHERE wi.dpr_id = d.id), 0) AS val
       FROM dpr d JOIN sites s ON s.id = d.site_id
      WHERE d.approval_status = 'approved' AND d.billing_ready = 1
        AND d.sales_bill_id IS NULL AND s.business_book_id IS NOT NULL`
  ).all();
  if (!rows.length) return { created: 0, bills: [] };

  const groups = new Map();   // bb_id → { sum, dprIds, minDate, maxDate }
  for (const r of rows) {
    if (!groups.has(r.bb_id)) groups.set(r.bb_id, { sum: 0, dprIds: [], minDate: r.report_date, maxDate: r.report_date });
    const g = groups.get(r.bb_id);
    g.sum += +r.val || 0;
    g.dprIds.push(r.dpr_id);
    if (r.report_date < g.minDate) g.minDate = r.report_date;
    if (r.report_date > g.maxDate) g.maxDate = r.report_date;
  }

  const today = new Date().toISOString().split('T')[0];
  const out = [];
  const tx = db.transaction(() => {
    for (const [bbId, g] of groups) {
      if (round2(g.sum) <= 0) continue;          // no work recorded this window
      const bb = db.prepare('SELECT * FROM business_book WHERE id=?').get(bbId);
      if (!bb) continue;
      // Installation bill = work value × the "Against Installation" % from the
      // order's Business Book payment terms (mam 2026-06-13).
      const instPct = parseFloat(String(bb.payment_against_installation || '').replace(/[^0-9.]/g, '')) || 0;
      const workValue = round2(g.sum);
      const amount = round2(workValue * instPct / 100);
      if (amount <= 0) continue;                  // no installation % set on this order — skip
      const prior = db.prepare(
        `SELECT id FROM sales_bills WHERE business_book_id=? AND bill_type=1`
      ).get(bbId);
      const gst_rate = 18;                        // installation service GST
      const gst_amount = round2(amount * gst_rate / 100);
      const total_amount = round2(amount + gst_amount);
      const bill_number = nextBillNumber(db, today);
      const r = db.prepare(
        `INSERT INTO sales_bills
           (bill_number, bill_date, amount, gst_amount, total_amount, gst_rate,
            bill_type, business_book_id, customer_name, project_name, bill_status,
            previous_bill_id, reference_doc_type, reference_doc_no, approval_status,
            payment_status, created_by)
         VALUES (?,?,?,?,?,?,3,?,?,?,?,?, 'DPR', ?, ?, 'pending', ?)`
      ).run(bill_number, today, amount, gst_amount, total_amount, gst_rate,
        bbId, (bb.client_name || bb.company_name || '').trim(), bb.project_name || null, BILL_STATUS[3],
        prior ? prior.id : null, `DPRs ${g.minDate} → ${g.maxDate} · ${instPct}% of ₹${workValue}`, draft ? 'draft' : 'approved', userId);
      const billId = r.lastInsertRowid;
      const upd = db.prepare('UPDATE dpr SET sales_bill_id=? WHERE id=?');
      for (const dprId of g.dprIds) upd.run(billId, dprId);
      db.prepare('INSERT INTO sales_bill_status_log (sales_bill_id, status, changed_by, notes) VALUES (?,?,?,?)')
        .run(billId, draft ? 'draft' : 'approved', userId, `Auto installation bill from ${g.dprIds.length} DPR(s)`);
      out.push({ bill_number, business_book_id: bbId, dprs: g.dprIds.length, amount, total_amount });
    }
  });
  tx();
  return { created: out.length, bills: out };
}

// Manual trigger — admin/accounts run it once to verify amounts before the
// fortnightly job is switched on. Creates DRAFT bills.
router.post('/generate-installation', requirePermission('installation', 'create'), (req, res) => {
  try {
    const db = getDb();
    const result = generateInstallationBills(db, req.user.id, { draft: false });
    res.json({ message: result.created ? `${result.created} installation bill(s) generated — review, then mark Sent to Client` : 'No unbilled DPRs ready to bill', ...result });
  } catch (err) {
    console.error('sales-billing generate-installation error', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.generateInstallationBills = generateInstallationBills;
