// CMD Audit JSON endpoint — per Master Prompt v3 spec.
// Read-only, token-authenticated, lives OUTSIDE /api/* so it has a
// distinct URL surface (`securederp.in/audit`) that an external
// scheduler (Claude's daily 9 AM email job, or any other automated
// caller) can hit without going through the session-cookie flow.
//
// Endpoints:
//   GET /audit                — 12 KPI tiles + 5 exception lists
//   GET /audit/data-quality   — per-table null/quality scorecard
//   GET /audit/analytics      — 30-day rolling activity analytics
//
// Auth: pass `Authorization: Bearer <AUDIT_API_TOKEN>` header OR
//       `?token=<AUDIT_API_TOKEN>` query.  Token is set per environment
//       in pm2 (`pm2 set ERP:AUDIT_API_TOKEN ...`) or `.env`.
//
// Mam's MD requested this so Claude can generate a daily 9 AM audit
// email for the CMD without giving the AI a user login.

const express = require('express');
const fs = require('fs');
const path = require('path');
const pg = require('../db/pg');

const router = express.Router();

// --- Token auth -----------------------------------------------------
// Keep this here rather than in middleware/auth.js because the rest of
// auth.js is session/cookie-based.  Audit traffic is server-to-server.
router.use((req, res, next) => {
  const expected = process.env.AUDIT_API_TOKEN;
  if (!expected || expected.length < 8) {
    return res.status(503).json({
      error: 'audit_token_unconfigured',
      hint: 'Set AUDIT_API_TOKEN (>=8 chars) in the server environment',
    });
  }
  const headerTok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const queryTok = (req.query.token || '').trim();
  const provided = headerTok || queryTok;
  if (provided !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// --- Small helpers --------------------------------------------------
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};
const monthStart = () => {
  const d = new Date(); d.setDate(1);
  return d.toISOString().slice(0, 10);
};
// Safe wrapper: Postgres throws if a queried table doesn't exist on a
// fresh install.  Returning 0/[] keeps the response shape stable.
// `db` here is the pg adapter (or a tx-bound `t`) — same async surface.
const safeGet = async (db, sql, ...params) => {
  try { return await db.get(sql, ...params); } catch { return null; }
};
const safeAll = async (db, sql, ...params) => {
  try { return await db.all(sql, ...params); } catch { return []; }
};
const safeCount = async (db, sql, ...params) => {
  const r = await safeGet(db, sql, ...params);
  if (!r) return 0;
  return r.c || r.count || Object.values(r)[0] || 0;
};

// --- 12 KPI tiles ---------------------------------------------------
async function computeKpis(db) {
  const t = today();
  const mStart = monthStart();

  return [
    {
      id: 'active_sites',
      label: 'Active Sites',
      value: await safeCount(db, `SELECT COUNT(*) c FROM sites WHERE status='active'`),
      unit: 'count',
    },
    {
      id: 'open_pos',
      label: 'Open Purchase Orders',
      value: await safeCount(db, `SELECT COUNT(*) c FROM purchase_orders WHERE status NOT IN ('completed')`),
      unit: 'count',
    },
    {
      id: 'mtd_sale_value',
      label: 'MTD Sale Value (ex-GST)',
      value: Math.round(((await safeGet(db, `SELECT COALESCE(SUM(sale_amount_without_gst),0) c FROM business_book WHERE LEFT(created_at,10) >= ?`, mStart))?.c) || 0),
      unit: 'inr',
    },
    {
      id: 'mtd_received',
      label: 'MTD Cash Received',
      value: Math.round(((await safeGet(db, `SELECT COALESCE(SUM(amount),0) c FROM cash_flow_entries WHERE type='inflow' AND date >= ?`, mStart))?.c) || 0),
      unit: 'inr',
    },
    {
      id: 'outstanding_receivables',
      label: 'Total Outstanding Receivables',
      value: Math.round(((await safeGet(db, `SELECT COALESCE(SUM(outstanding_amount),0) c FROM receivables`))?.c) || 0),
      unit: 'inr',
    },
    {
      id: 'overdue_receivables',
      label: 'Overdue (>60d) Receivables',
      value: await safeCount(db, `SELECT COUNT(*) c FROM receivables WHERE ageing_bucket IN ('61-90','90+')`),
      unit: 'count',
    },
    {
      id: 'dpr_submitted_today',
      label: 'DPRs Submitted Today',
      value: await safeCount(db, `SELECT COUNT(DISTINCT site_id) c FROM dpr WHERE report_date = ?`, t),
      unit: 'count',
    },
    {
      id: 'dpr_missing_today',
      label: 'Sites Missing DPR Today',
      value: Math.max(0,
        (await safeCount(db, `SELECT COUNT(*) c FROM sites WHERE status='active'`)) -
        (await safeCount(db, `SELECT COUNT(DISTINCT site_id) c FROM dpr WHERE report_date = ?`, t))),
      unit: 'count',
    },
    {
      id: 'pending_payment_requests',
      label: 'Pending Payment Requests',
      value: await safeCount(db, `SELECT COUNT(*) c FROM payment_requests WHERE status NOT IN ('final_approved','rejected')`),
      unit: 'count',
    },
    {
      id: 'pending_indents',
      label: 'Pending Indents',
      value: await safeCount(db, `SELECT COUNT(*) c FROM indents WHERE status NOT IN ('approved','completed','rejected')`),
      unit: 'count',
    },
    {
      id: 'active_employees',
      label: 'Active Employees',
      value: await safeCount(db, `SELECT COUNT(*) c FROM employees WHERE status='active'`),
      unit: 'count',
    },
    {
      id: 'cheques_open',
      label: 'Cheques Awaiting Action',
      value: await safeCount(db, `SELECT COUNT(*) c FROM cheques WHERE current_status IN ('pending','hold')`),
      unit: 'count',
    },
  ];
}

// --- Exception list 1: Duplicates -----------------------------------
async function findDuplicates(db) {
  const out = [];
  // BB duplicates by client_name + project_name (case-insensitive)
  (await safeAll(db, `
    SELECT LOWER(TRIM(client_name)) k1, LOWER(TRIM(project_name)) k2,
           COUNT(*) cnt, STRING_AGG(id::text, ',') ids, STRING_AGG(lead_no::text, ',') leads
    FROM business_book
    WHERE client_name IS NOT NULL AND project_name IS NOT NULL
    GROUP BY k1, k2 HAVING COUNT(*) > 1
  `)).forEach(r => out.push({
    table: 'business_book', kind: 'client_project_pair',
    key: `${r.k1} | ${r.k2}`, count: r.cnt, ids: r.ids, leads: r.leads,
  }));
  // Vendors with same name
  (await safeAll(db, `
    SELECT LOWER(TRIM(name)) k, COUNT(*) cnt, STRING_AGG(id::text, ',') ids
    FROM vendors WHERE name IS NOT NULL
    GROUP BY k HAVING COUNT(*) > 1
  `)).forEach(r => out.push({
    table: 'vendors', kind: 'name', key: r.k, count: r.cnt, ids: r.ids,
  }));
  // Customers with same company_name
  (await safeAll(db, `
    SELECT LOWER(TRIM(company_name)) k, COUNT(*) cnt, STRING_AGG(id::text, ',') ids
    FROM customers WHERE company_name IS NOT NULL
    GROUP BY k HAVING COUNT(*) > 1
  `)).forEach(r => out.push({
    table: 'customers', kind: 'company_name', key: r.k, count: r.cnt, ids: r.ids,
  }));
  // Item master with same name+spec+make
  (await safeAll(db, `
    SELECT LOWER(TRIM(item_name)) k1, LOWER(TRIM(COALESCE(specification,''))) k2,
           LOWER(TRIM(COALESCE(make,''))) k3, COUNT(*) cnt, STRING_AGG(id::text, ',') ids
    FROM item_master WHERE item_name IS NOT NULL
    GROUP BY k1, k2, k3 HAVING COUNT(*) > 1
  `)).forEach(r => out.push({
    table: 'item_master', kind: 'name_spec_make',
    key: `${r.k1} | ${r.k2} | ${r.k3}`, count: r.cnt, ids: r.ids,
  }));
  // PO numbers — these should be UNIQUE; if duplicates exist it's a constraint failure
  (await safeAll(db, `
    SELECT po_number k, COUNT(*) cnt, STRING_AGG(id::text, ',') ids
    FROM purchase_orders WHERE po_number IS NOT NULL
    GROUP BY po_number HAVING COUNT(*) > 1
  `)).forEach(r => out.push({
    table: 'purchase_orders', kind: 'po_number_dup',
    key: r.k, count: r.cnt, ids: r.ids, severity: 'critical',
  }));
  return out;
}

// --- Exception list 2: Arithmetic errors ----------------------------
async function findArithmeticErrors(db) {
  const out = [];
  // sales_bills: amount + gst_amount should equal total_amount (within 1 rupee)
  (await safeAll(db, `
    SELECT id, bill_number, amount, gst_amount, total_amount,
           ROUND((total_amount - amount - gst_amount)::numeric, 2) diff
    FROM sales_bills
    WHERE total_amount > 0
      AND ABS(total_amount - amount - gst_amount) > 1
    LIMIT 100
  `)).forEach(r => out.push({
    table: 'sales_bills', id: r.id, ref: r.bill_number,
    expected: r.amount + r.gst_amount, actual: r.total_amount, diff: r.diff,
  }));
  // purchase_bills: same check
  (await safeAll(db, `
    SELECT id, bill_number, amount, gst_amount, total_amount,
           ROUND((total_amount - amount - gst_amount)::numeric, 2) diff
    FROM purchase_bills
    WHERE total_amount > 0
      AND ABS(total_amount - amount - gst_amount) > 1
    LIMIT 100
  `)).forEach(r => out.push({
    table: 'purchase_bills', id: r.id, ref: r.bill_number,
    expected: r.amount + r.gst_amount, actual: r.total_amount, diff: r.diff,
  }));
  // PO total vs sum of po_items.amount (when items exist)
  (await safeAll(db, `
    SELECT p.id, p.po_number, p.total_amount,
           ROUND((SELECT SUM(amount) FROM po_items WHERE po_id=p.id)::numeric, 2) items_sum
    FROM purchase_orders p
    WHERE p.total_amount > 0
      AND EXISTS (SELECT 1 FROM po_items WHERE po_id=p.id)
      AND ABS(p.total_amount - (SELECT SUM(amount) FROM po_items WHERE po_id=p.id)) > 10
    LIMIT 100
  `)).forEach(r => out.push({
    table: 'purchase_orders', id: r.id, ref: r.po_number,
    expected: r.items_sum, actual: r.total_amount,
    diff: Math.round((r.total_amount - r.items_sum) * 100) / 100,
  }));
  // DPR grand_total_b should be roughly profit_loss + grand_total_a (sanity)
  (await safeAll(db, `
    SELECT id, report_date, site_id, grand_total_a, grand_total_b, profit_loss,
           ROUND(((grand_total_a - grand_total_b) - profit_loss)::numeric, 2) diff
    FROM dpr
    WHERE (grand_total_a > 0 OR grand_total_b > 0)
      AND ABS((grand_total_a - grand_total_b) - profit_loss) > 1
    LIMIT 100
  `)).forEach(r => out.push({
    table: 'dpr', id: r.id, ref: `site=${r.site_id} ${r.report_date}`,
    expected: r.grand_total_a - r.grand_total_b, actual: r.profit_loss, diff: r.diff,
  }));
  return out;
}

// --- Exception list 3: Missing required fields ----------------------
async function findMissingRequired(db) {
  const out = [];
  const push = (table, id, ref, missing) =>
    out.push({ table, id, ref, missing });

  (await safeAll(db, `
    SELECT id, lead_no, client_name, po_amount, sale_amount_without_gst
    FROM business_book
    WHERE lead_no IS NULL OR lead_no=''
       OR client_name IS NULL OR client_name=''
       OR (po_amount IS NULL OR po_amount=0)
    LIMIT 100
  `)).forEach(r => {
    const m = [];
    if (!r.lead_no) m.push('lead_no');
    if (!r.client_name) m.push('client_name');
    if (!r.po_amount) m.push('po_amount');
    push('business_book', r.id, r.lead_no || `#${r.id}`, m);
  });

  (await safeAll(db, `
    SELECT id, po_number, po_date, total_amount
    FROM purchase_orders
    WHERE po_number IS NULL OR po_number=''
       OR po_date IS NULL OR po_date=''
       OR (total_amount IS NULL OR total_amount=0)
    LIMIT 100
  `)).forEach(r => {
    const m = [];
    if (!r.po_number) m.push('po_number');
    if (!r.po_date) m.push('po_date');
    if (!r.total_amount) m.push('total_amount');
    push('purchase_orders', r.id, r.po_number || `#${r.id}`, m);
  });

  (await safeAll(db, `
    SELECT id, name, phone, email FROM vendors
    WHERE (phone IS NULL OR phone='') AND (email IS NULL OR email='')
    LIMIT 100
  `)).forEach(r => push('vendors', r.id, r.name, ['phone', 'email']));

  // Mam (2026-05-16): "please correct vendor master sheet according
  // to firm name autofetch address from whole net and gst number
  // also and contact person also".  Vendors with no GST / no
  // address / no contact-person can't be used to print a clean PO,
  // so surface them here so mam knows which masters need filling.
  (await safeAll(db, `
    SELECT id, name, gst_number, address, contact_person
    FROM vendors
    WHERE (active IS NULL OR active = 1)
      AND ((gst_number IS NULL OR gst_number = '')
        OR (address IS NULL OR address = '')
        OR (contact_person IS NULL OR contact_person = ''))
    LIMIT 200
  `)).forEach(r => {
    const m = [];
    if (!r.gst_number) m.push('gst_number');
    if (!r.address) m.push('address');
    if (!r.contact_person) m.push('contact_person');
    if (m.length) push('vendors', r.id, r.name, m);
  });

  (await safeAll(db, `
    SELECT id, company_name, contact_no, email FROM customers
    WHERE (contact_no IS NULL OR contact_no='') AND (email IS NULL OR email='')
    LIMIT 100
  `)).forEach(r => push('customers', r.id, r.company_name, ['contact_no', 'email']));

  (await safeAll(db, `
    SELECT id, name, address FROM sites
    WHERE address IS NULL OR address=''
    LIMIT 100
  `)).forEach(r => push('sites', r.id, r.name, ['address']));

  (await safeAll(db, `
    SELECT id, name, phone FROM employees
    WHERE status='active' AND (phone IS NULL OR phone='')
    LIMIT 100
  `)).forEach(r => push('employees', r.id, r.name, ['phone']));

  return out;
}

// --- Exception list 4: Stale records --------------------------------
async function findStaleRecords(db) {
  const out = [];
  // POs stuck in 'received' for >30 days — should have moved on by now
  (await safeAll(db, `
    SELECT id, po_number, po_date, created_at FROM purchase_orders
    WHERE status='received' AND LEFT(created_at,10) < ?
    LIMIT 100
  `, daysAgo(30))).forEach(r => out.push({
    table: 'purchase_orders', id: r.id, ref: r.po_number,
    reason: 'status=received for >30 days', age_days: Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000),
  }));
  // Receivables 90+ days old without escalation
  (await safeAll(db, `
    SELECT id, invoice_number, client_name, ageing_bucket, follow_up_status, outstanding_amount
    FROM receivables
    WHERE ageing_bucket='90+'
      AND follow_up_status NOT IN ('escalated','legal')
      AND outstanding_amount > 1000
    LIMIT 100
  `)).forEach(r => out.push({
    table: 'receivables', id: r.id, ref: r.invoice_number || r.client_name,
    reason: `90+ days old, follow_up=${r.follow_up_status}, ₹${r.outstanding_amount}`,
  }));
  // Complaints open >14 days
  (await safeAll(db, `
    SELECT id, complaint_number, client_name, created_at FROM complaints
    WHERE status='open' AND LEFT(created_at,10) < ?
    LIMIT 100
  `, daysAgo(14))).forEach(r => out.push({
    table: 'complaints', id: r.id, ref: r.complaint_number || r.client_name,
    reason: 'open complaint >14 days', age_days: Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000),
  }));
  // Snags open >30 days
  (await safeAll(db, `
    SELECT id, snag_no, description, raised_at FROM snags
    WHERE status='open' AND LEFT(raised_at,10) < ?
    LIMIT 100
  `, daysAgo(30))).forEach(r => out.push({
    table: 'snags', id: r.id, ref: r.snag_no || `#${r.id}`,
    reason: 'open snag >30 days', age_days: Math.floor((Date.now() - new Date(r.raised_at).getTime()) / 86400000),
  }));
  // Indents pending >14 days
  (await safeAll(db, `
    SELECT id, indent_number, status, created_at FROM indents
    WHERE status NOT IN ('approved','completed','rejected')
      AND LEFT(created_at,10) < ?
    LIMIT 100
  `, daysAgo(14))).forEach(r => out.push({
    table: 'indents', id: r.id, ref: r.indent_number,
    reason: `status=${r.status} >14 days`, age_days: Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000),
  }));
  return out;
}

// --- Exception list 5: Schema drift ---------------------------------
// Expected columns we depend on across the code.  If any of these
// disappear (or get renamed), the report flags them so the deploy
// can be corrected before downstream queries break.
const EXPECTED_COLUMNS = {
  business_book: ['id', 'lead_no', 'client_name', 'po_amount', 'sale_amount_without_gst', 'created_at'],
  purchase_orders: ['id', 'po_number', 'po_date', 'total_amount', 'status', 'business_book_id'],
  po_items: ['id', 'po_id', 'amount'],
  sales_bills: ['id', 'bill_number', 'amount', 'gst_amount', 'total_amount'],
  purchase_bills: ['id', 'bill_number', 'amount', 'gst_amount', 'total_amount'],
  vendors: ['id', 'name', 'phone', 'email'],
  customers: ['id', 'company_name', 'contact_no', 'email'],
  item_master: ['id', 'item_name', 'specification', 'make', 'current_price'],
  sites: ['id', 'name', 'address', 'status'],
  dpr: ['id', 'site_id', 'report_date', 'grand_total_a', 'grand_total_b', 'profit_loss'],
  receivables: ['id', 'outstanding_amount', 'ageing_bucket', 'follow_up_status'],
  payment_requests: ['id', 'request_no', 'status', 'amount'],
  indents: ['id', 'indent_number', 'status'],
  cheques: ['id', 'cheque_number', 'cheque_date', 'amount', 'current_status'],
  employees: ['id', 'name', 'phone', 'status'],
  cash_flow_entries: ['id', 'date', 'type', 'amount'],
};
async function findSchemaDrift(db) {
  const out = [];
  for (const [table, expectedCols] of Object.entries(EXPECTED_COLUMNS)) {
    let actualCols;
    try {
      actualCols = (await db.all(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=?`, table
      )).map(r => r.column_name);
    } catch (e) {
      out.push({ table, kind: 'table_missing', detail: e.message, severity: 'critical' });
      continue;
    }
    if (actualCols.length === 0) {
      out.push({ table, kind: 'table_missing', severity: 'critical' });
      continue;
    }
    const missing = expectedCols.filter(c => !actualCols.includes(c));
    if (missing.length) {
      out.push({ table, kind: 'columns_missing', missing, severity: 'critical' });
    }
  }
  return out;
}

// --- Exception list 6: Cash Flow ↔ Business Book reconciliation -----
// Mam (2026-05-16) noticed Cash Flow showed Rs 2.80 cr for "M/s
// Sardarshahar Agri Energy Pvt Ltd (SAEL)" while filtering BB for
// "sar" showed only Rs 1.66 cr.  Root cause: Cash Flow groups BB
// rows by `company_name` and sums sale_amount_without_gst, but
// distinct *client_names* often share the same company_name (e.g.
// "1572663", "Manish Kumar" both filed under SAEL).  That's not a
// data-integrity bug per se, but it surprises users — they expect
// one project per company.  This audit flags any company_name where
// >1 distinct client_name rolls up, and where the rollup sum
// materially differs from any single client's contribution.  Mam
// can then decide: rename company_name to disambiguate, OR confirm
// the rollup is intentional.
async function findCashFlowReconciliation(db) {
  const out = [];
  const rows = await safeAll(db, `
    SELECT TRIM(company_name) as company_name,
           COUNT(*) as bb_row_count,
           COUNT(DISTINCT LOWER(TRIM(COALESCE(client_name,'')))) as distinct_clients,
           SUM(COALESCE(sale_amount_without_gst,0)) as total_sale,
           STRING_AGG(id::text, ',') as bb_ids,
           STRING_AGG(DISTINCT TRIM(COALESCE(client_name,'')), ',') as client_list,
           STRING_AGG(lead_no::text, ',') as leads
    FROM business_book
    WHERE company_name IS NOT NULL AND TRIM(company_name) != ''
    GROUP BY TRIM(company_name)
    HAVING COUNT(DISTINCT LOWER(TRIM(COALESCE(client_name,'')))) > 1
  `);
  rows.forEach(r => {
    // Severity: critical when >₹50 L is grouped under one company
    // with >2 distinct clients (likely accidental collision); warning
    // otherwise (could be a parent-company arrangement that's
    // intentional).
    const severity = (r.total_sale > 5000000 && r.distinct_clients > 2) ? 'critical' : 'warning';
    out.push({
      table: 'business_book',
      kind: 'company_name_client_collision',
      company_name: r.company_name,
      bb_row_count: r.bb_row_count,
      distinct_clients: r.distinct_clients,
      total_sale: Math.round(r.total_sale),
      client_list: (r.client_list || '').split(',').filter(Boolean).slice(0, 10),
      bb_ids: r.bb_ids,
      leads: r.leads,
      severity,
      hint: 'Cash Flow tracker sums all rows sharing this company_name. If these are separate projects, rename company_name to disambiguate or split them.',
    });
  });
  return out;
}

// --- Exception list 7: Cash Flow Sale ≡ Business Book Sale ---------
// Mam (2026-05-16): "audit in cash flow amount sum is from business
// book sales amt sum".  Invariant: for every project the Cash Flow
// tracker reports, its `sale_amount_without_gst` total MUST equal
// the raw SUM of sale_amount_without_gst across all BB rows sharing
// that company_name.  Anything else means the dashboard is lying.
//
// This audit catches exactly the bug fixed in 7d87429 — a
// LEFT JOIN sites fan-out that double-counted any BB row with >1
// site.  Going forward, if anyone re-introduces an aggregation
// regression in /cashflow/projects, this check screams about it
// in the next 7:30 AM snapshot and 9 AM CMD email.
//
// Algorithm:
//   1. canonical[company]  = SUM(sale_amount_without_gst) from BB
//      (the truth — what BB itself reports)
//   2. dashboard[company]  = simulate the same logic /cashflow/projects
//      runs today (currently identical, but written separately so a
//      future regression would diverge)
//   3. For every company where |dashboard - canonical| > ₹1 OR the
//      row counts differ, emit an exception.
async function findCashFlowSaleDrift(db) {
  const out = [];

  // 1. Canonical: BB sale sums (this is what the Cash Flow drill-down
  //    modal reports, and what the BB list page sums in its footer).
  const canonical = new Map();
  (await safeAll(db, `
    SELECT TRIM(company_name) as k,
           COUNT(*) as cnt,
           ROUND(COALESCE(SUM(sale_amount_without_gst), 0)::numeric, 2) as sale_sum
    FROM business_book
    WHERE company_name IS NOT NULL AND TRIM(company_name) != ''
    GROUP BY TRIM(company_name)
  `)).forEach(r => canonical.set(r.k, { cnt: r.cnt, sum: r.sale_sum }));

  // 2. Dashboard simulation: mirror the EXACT shape of /cashflow/projects
  //    aggregation.  Today this is identical to canonical because the
  //    fan-out JOIN was removed.  Keeping both queries here so any
  //    future change to the dashboard query (added JOIN, extra filter,
  //    different grouping) is caught by diffing the outputs.
  const dashboard = new Map();
  (await safeAll(db, `
    SELECT bb.company_name as k,
           COUNT(bb.id) as cnt,
           ROUND(COALESCE(SUM(bb.sale_amount_without_gst), 0)::numeric, 2) as sale_sum
    FROM business_book bb
    WHERE bb.company_name IS NOT NULL AND TRIM(bb.company_name) != ''
    GROUP BY bb.company_name
  `)).forEach(r => {
    const key = (r.k || '').trim();
    const existing = dashboard.get(key);
    if (existing) {
      // company_name variants with different whitespace/casing roll up
      // here.  Treat as one logical project for invariant purposes —
      // canonical does the same TRIM().
      existing.cnt += r.cnt;
      existing.sum = Math.round((existing.sum + r.sale_sum) * 100) / 100;
    } else {
      dashboard.set(key, { cnt: r.cnt, sum: r.sale_sum });
    }
  });

  // 3. Diff
  for (const [company, truth] of canonical.entries()) {
    const dash = dashboard.get(company) || { cnt: 0, sum: 0 };
    const sumDiff = Math.round(Math.abs(dash.sum - truth.sum));
    const cntDiff = dash.cnt - truth.cnt;
    if (sumDiff > 1 || cntDiff !== 0) {
      out.push({
        table: 'business_book',
        kind: 'cashflow_sale_drift',
        company_name: company,
        bb_row_count: truth.cnt,
        bb_sale_sum: truth.sum,
        cashflow_row_count: dash.cnt,
        cashflow_sale_sum: dash.sum,
        sum_diff_rupees: sumDiff,
        count_diff: cntDiff,
        // critical if >₹1 L drift — that's material on any dashboard
        severity: sumDiff > 100000 ? 'critical' : 'warning',
        hint: 'Cash Flow tracker total differs from Business Book SUM(sale_amount_without_gst) for this project. Likely a regression in /cashflow/projects aggregation (e.g. an inflating JOIN). Investigate before any KPI in the War Room can be trusted.',
      });
    }
  }
  return out;
}

// --- Exception list 8: Attendance geofence violations --------------
// Mam (2026-05-16): "just a audit our staff says we are away from
// office 3km attendance is punched is it true?"  Look at the past
// 30 days of attendance records: compute the haversine distance
// from each punch's stored lat/lng to the NEAREST active geofence;
// flag anything beyond a generous tolerance (geofence radius +
// 800m).  We don't try to be perfect — GPS noise can shift a pin
// 100-300m in either direction — but anything beyond ~1km is
// almost certainly a real violation (spoofed coords / colleague
// punching for someone / the previously-unenforced punch-out).
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
async function findGeofenceViolations(db) {
  const out = [];
  let geofences;
  try { geofences = await db.all('SELECT * FROM geofence_settings WHERE active=1'); } catch { return out; }
  if (!geofences || geofences.length === 0) return out;

  const radius = geofences[0].radius_meters || 200;
  // Same strict rule as the live punch endpoints (mam, 2026-05-16:
  // "out attendance no no punch out is also need according to
  // geofencing this is blunder").  We allow only the +500m GPS-noise
  // tolerance the server itself uses — same number, so the audit
  // matches what the server enforces and we don't flag legit on-site
  // punches.
  const buffer = 500;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const rows = await safeAll(db, `
    SELECT a.id, a.user_id, a.date, a.punch_in_time, a.punch_out_time,
           a.punch_in_lat, a.punch_in_lng, a.punch_out_lat, a.punch_out_lng,
           a.site_name, u.name as employee_name
    FROM attendance a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.date >= ?
  `, cutoffDate);

  for (const r of rows) {
    const check = (lat, lng, which) => {
      if (lat == null || lng == null) return null;
      let best = { dist: Infinity, site: '' };
      for (const gf of geofences) {
        const d = haversineMeters(+lat, +lng, gf.latitude, gf.longitude);
        if (d < best.dist) best = { dist: d, site: gf.site_name };
      }
      if (best.dist > radius + buffer) {
        return {
          which, distance_m: Math.round(best.dist),
          nearest_site: best.site,
          beyond_3km: best.dist > 3000,
        };
      }
      return null;
    };
    const inV  = check(r.punch_in_lat, r.punch_in_lng, 'punch_in');
    const outV = check(r.punch_out_lat, r.punch_out_lng, 'punch_out');
    if (inV || outV) {
      const farthest = Math.max(inV?.distance_m || 0, outV?.distance_m || 0);
      out.push({
        table: 'attendance', kind: 'geofence_violation',
        attendance_id: r.id, date: r.date,
        employee: r.employee_name || `user#${r.user_id}`,
        site_assigned: r.site_name,
        punch_in_violation: inV,
        punch_out_violation: outV,
        farthest_meters: farthest,
        // critical when >3km — that's mam's threshold from the audit request
        severity: farthest > 3000 ? 'critical' : 'warning',
      });
    }
  }
  return out;
}

// --- /audit (main) --------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const started = Date.now();
    let dbInfo = { path: null, size_bytes: null, last_modified: null };
    try {
      // The DB path is configurable via DB_PATH; default is ../data/erp.db
      const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'erp.db');
      if (fs.existsSync(dbPath)) {
        const st = fs.statSync(dbPath);
        dbInfo = { path: dbPath, size_bytes: st.size, last_modified: st.mtime.toISOString() };
      }
    } catch (_) {}

    const kpis = await computeKpis(pg);
    const exceptions = {
      duplicates:           { description: 'Records sharing key identifying fields',                 items: await findDuplicates(pg) },
      arithmetic_errors:    { description: 'Computed total ≠ recorded total (>₹1 / >₹10 for POs)', items: await findArithmeticErrors(pg) },
      missing_required:     { description: 'Critical fields blank on otherwise-valid rows',          items: await findMissingRequired(pg) },
      stale_records:        { description: 'Open work-items past their expected SLA',                 items: await findStaleRecords(pg) },
      schema_drift:         { description: 'Columns expected by code but absent from the database',  items: await findSchemaDrift(pg) },
      cashflow_recon:       { description: 'Cash Flow project aggregation collides distinct clients under one company_name', items: await findCashFlowReconciliation(pg) },
      cashflow_sale_drift:  { description: 'Cash Flow project Sale Amount ≠ Business Book sum (canonical invariant)',        items: await findCashFlowSaleDrift(pg) },
      geofence_violations:  { description: 'Attendance punches recorded outside the configured site geofence',               items: await findGeofenceViolations(pg) },
    };
    Object.values(exceptions).forEach(e => { e.count = e.items.length; });

    res.json({
      spec_version: 'v3',
      generated_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      database: dbInfo,
      kpis,
      exceptions,
      summary: {
        kpi_count: kpis.length,
        total_exceptions: Object.values(exceptions).reduce((s, e) => s + e.count, 0),
        critical_exceptions: Object.values(exceptions).reduce(
          (s, e) => s + e.items.filter(i => i.severity === 'critical').length, 0),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- /audit/data-quality --------------------------------------------
// Per-table scorecard: row counts + null rates on the columns we
// actually care about (the EXPECTED_COLUMNS set).  Quality score is
// 100 minus the worst null-rate percentage on a required column.
router.get('/data-quality', async (req, res) => {
  try {
    const started = Date.now();
    const tables = [];

    for (const [table, cols] of Object.entries(EXPECTED_COLUMNS)) {
      const total = await safeCount(pg, `SELECT COUNT(*) c FROM ${table}`);
      const nulls = {};
      let worstNullPct = 0;
      for (const col of cols) {
        if (col === 'id') continue; // id always present (PK)
        let n = 0;
        try {
          // ::text so the blank-string check is valid on numeric columns too
          n = await safeCount(pg, `SELECT COUNT(*) c FROM ${table} WHERE ${col} IS NULL OR ${col}::text=''`);
        } catch { continue; }
        const pct = total > 0 ? Math.round((n / total) * 10000) / 100 : 0;
        nulls[col] = { null_count: n, null_pct: pct };
        if (pct > worstNullPct) worstNullPct = pct;
      }
      const lastRow = await safeGet(pg, `SELECT MAX(id) m FROM ${table}`);
      tables.push({
        name: table,
        row_count: total,
        last_rowid: lastRow ? lastRow.m : null,
        nulls,
        quality_score: Math.max(0, Math.round((100 - worstNullPct) * 10) / 10),
      });
    }

    // Overall score = average of per-table scores, weighted by row count
    const totalRows = tables.reduce((s, t) => s + t.row_count, 0);
    const weightedScore = totalRows > 0
      ? Math.round((tables.reduce((s, t) => s + t.quality_score * t.row_count, 0) / totalRows) * 10) / 10
      : 100;

    res.json({
      spec_version: 'v3',
      generated_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      overall_quality_score: weightedScore,
      tables,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- /audit/analytics -----------------------------------------------
// 30-day rolling activity: how many of each entity were created, plus
// day-by-day counts so CMD can see whether the team is keeping pace.
router.get('/analytics', async (req, res) => {
  try {
    const started = Date.now();
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const from = daysAgo(days);
    const to = today();

    // Total counts in window
    const totals = {
      new_business_book:    await safeCount(pg, `SELECT COUNT(*) c FROM business_book   WHERE LEFT(created_at,10) >= ?`, from),
      new_purchase_orders:  await safeCount(pg, `SELECT COUNT(*) c FROM purchase_orders WHERE LEFT(created_at,10) >= ?`, from),
      new_sales_bills:      await safeCount(pg, `SELECT COUNT(*) c FROM sales_bills     WHERE LEFT(created_at,10) >= ?`, from),
      new_purchase_bills:   await safeCount(pg, `SELECT COUNT(*) c FROM purchase_bills  WHERE LEFT(created_at,10) >= ?`, from),
      new_dpr:              await safeCount(pg, `SELECT COUNT(*) c FROM dpr             WHERE report_date    >= ?`, from),
      new_indents:          await safeCount(pg, `SELECT COUNT(*) c FROM indents         WHERE LEFT(created_at,10) >= ?`, from),
      new_payment_requests: await safeCount(pg, `SELECT COUNT(*) c FROM payment_requests WHERE LEFT(created_at,10) >= ?`, from),
      new_cheques:          await safeCount(pg, `SELECT COUNT(*) c FROM cheques         WHERE LEFT(raised_at,10)  >= ?`, from),
      new_complaints:       await safeCount(pg, `SELECT COUNT(*) c FROM complaints      WHERE LEFT(created_at,10) >= ?`, from),
      new_snags:            await safeCount(pg, `SELECT COUNT(*) c FROM snags           WHERE LEFT(raised_at,10)  >= ?`, from),
    };

    // Day-by-day for the busy tables
    const dailyDpr = await safeAll(pg, `
      SELECT report_date d, COUNT(*) c FROM dpr
      WHERE report_date >= ? GROUP BY d ORDER BY d
    `, from);
    const dailyBills = await safeAll(pg, `
      SELECT LEFT(created_at,10) d, COUNT(*) c FROM sales_bills
      WHERE LEFT(created_at,10) >= ? GROUP BY d ORDER BY d
    `, from);
    const dailyPayments = await safeAll(pg, `
      SELECT LEFT(date,10) d, COALESCE(SUM(amount),0) total FROM cash_flow_entries
      WHERE type='inflow' AND date >= ? GROUP BY d ORDER BY d
    `, from);

    // Top vendors by spend, top customers by sale value
    const topVendors = await safeAll(pg, `
      SELECT v.id, v.name, COUNT(pb.id) bill_count, COALESCE(SUM(pb.total_amount),0) total_spend
      FROM vendors v LEFT JOIN purchase_bills pb ON pb.vendor_id = v.id
        AND LEFT(pb.created_at,10) >= ?
      GROUP BY v.id, v.name HAVING COUNT(pb.id) > 0
      ORDER BY total_spend DESC LIMIT 10
    `, from);
    const topClients = await safeAll(pg, `
      SELECT client_name, COUNT(*) entries, COALESCE(SUM(sale_amount_without_gst),0) total_sale
      FROM business_book
      WHERE LEFT(created_at,10) >= ? AND client_name IS NOT NULL
      GROUP BY client_name ORDER BY total_sale DESC LIMIT 10
    `, from);

    res.json({
      spec_version: 'v3',
      generated_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      period: { from, to, days },
      totals,
      by_day: {
        dpr: dailyDpr,
        sales_bills: dailyBills,
        cash_inflows: dailyPayments,
      },
      top_vendors: topVendors,
      top_clients: topClients,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- /audit/kpi -----------------------------------------------------
// TOC v3 P0 KPI feeds for CMD / COO / Sales / Finance dashboards.
// Single endpoint returns every operating-cycle metric MD asked for
// so the same JSON can power four role-specific views + the 9:00 AM
// audit email + the scheduled 7:30 AM snapshot job.
//
// Definitions used here:
//   DSO = Days Sales Outstanding
//       = (avg outstanding receivables / sales in window) × window_days
//   DIO = Days Inventory Outstanding
//       = (avg inventory value / COGS in window) × window_days
//   DPO = Days Payable Outstanding
//       = (avg outstanding to vendors / purchases in window) × window_days
//   CCC = DSO + DIO − DPO   (cash conversion cycle in days)
//
// All money figures in raw rupees (no lakh conversion).
//
// Exported as `computeKpiPayload(db, days)` so the session-authed
// /api/dashboards/kpi route can render the same JSON for the in-app
// CMD/COO/Sales/Finance dashboards without re-implementing the SQL.
// `db` is the pg adapter (kept as a parameter so external callers keep
// their existing call shape — just pass the pg module now).
async function computeKpiPayload(db, daysRaw) {
  const started = Date.now();
  const days = Math.min(365, Math.max(7, parseInt(daysRaw, 10) || 30));
  const from = daysAgo(days);
  const to = today();

  // ── Sales / receivables ─────────────────────────────────────────
  const salesInWindow = ((await safeGet(db,
    `SELECT COALESCE(SUM(total_amount),0) c FROM sales_bills WHERE LEFT(bill_date,10) >= ?`, from))?.c) || 0;
  const arOutstanding = ((await safeGet(db,
    `SELECT COALESCE(SUM(outstanding_amount),0) c FROM receivables`))?.c) || 0;
  const dso = salesInWindow > 0 ? Math.round((arOutstanding / salesInWindow) * days) : null;

  // AR aging buckets — Finance-Head dashboard
  const arAging = {
    bucket_0_30:  ((await safeGet(db, `SELECT COALESCE(SUM(outstanding_amount),0) c FROM receivables WHERE ageing_bucket='0-30'`))?.c) || 0,
    bucket_31_60: ((await safeGet(db, `SELECT COALESCE(SUM(outstanding_amount),0) c FROM receivables WHERE ageing_bucket='31-60'`))?.c) || 0,
    bucket_61_90: ((await safeGet(db, `SELECT COALESCE(SUM(outstanding_amount),0) c FROM receivables WHERE ageing_bucket='61-90'`))?.c) || 0,
    bucket_90_plus: ((await safeGet(db, `SELECT COALESCE(SUM(outstanding_amount),0) c FROM receivables WHERE ageing_bucket='90+'`))?.c) || 0,
  };

  // ── Purchases / AP ───────────────────────────────────────────────
  const purchasesInWindow = ((await safeGet(db,
    `SELECT COALESCE(SUM(total_amount),0) c FROM purchase_bills WHERE LEFT(bill_date,10) >= ?`, from))?.c) || 0;
  const apOutstanding = ((await safeGet(db,
    `SELECT COALESCE(SUM(total_amount),0) c FROM purchase_bills WHERE payment_status IN ('pending','partial')`))?.c) || 0;
  const dpo = purchasesInWindow > 0 ? Math.round((apOutstanding / purchasesInWindow) * days) : null;

  // ── Inventory ────────────────────────────────────────────────────
  // Free-to-use = stock value not reserved to a specific site.  In our
  // schema a stock row "belongs to" a site warehouse; inventory at the
  // central office warehouse (type='office') is the free pool.
  const inventoryFree = ((await safeGet(db, `
    SELECT COALESCE(SUM(s.quantity * s.avg_rate), 0) c
    FROM stock_balance s
    JOIN warehouses w ON s.warehouse_id = w.id
    WHERE w.type = 'office' AND s.quantity > 0
  `))?.c) || 0;
  const inventoryTotal = ((await safeGet(db, `
    SELECT COALESCE(SUM(quantity * avg_rate), 0) c FROM stock_balance WHERE quantity > 0
  `))?.c) || 0;
  const cogsInWindow = purchasesInWindow; // proxy — refine later with DPR material cost
  const dio = cogsInWindow > 0 ? Math.round((inventoryTotal / cogsInWindow) * days) : null;

  const ccc = (dso != null && dio != null && dpo != null) ? (dso + dio - dpo) : null;

  // ── Quote lead time (RFQ to quote-sent) ────────────────────────
  // Lead.created_at → first quotation row for that lead.
  const quoteLT = (await safeAll(db, `
    SELECT (LEFT(q.created_at,10)::date - LEFT(l.created_at,10)::date) days_to_quote
    FROM leads l JOIN quotations q ON q.lead_id = l.id
    WHERE l.created_at IS NOT NULL AND q.created_at IS NOT NULL
      AND LEFT(q.created_at,10) >= ?
  `, from)).map(r => r.days_to_quote).filter(x => x != null);
  const quoteLeadTimeAvg = quoteLT.length
    ? Math.round((quoteLT.reduce((a, b) => a + b, 0) / quoteLT.length) * 10) / 10
    : null;

  // ── Lead → PO conversion % ────────────────────────────────────
  const leadsInWindow = await safeCount(db, `SELECT COUNT(*) c FROM leads WHERE LEFT(created_at,10) >= ?`, from);
  const wonLeadsInWindow = await safeCount(db, `SELECT COUNT(*) c FROM leads WHERE LEFT(created_at,10) >= ? AND status='won'`, from);
  const leadToPoPct = leadsInWindow > 0 ? Math.round((wonLeadsInWindow / leadsInWindow) * 1000) / 10 : null;

  // ── Revenue per FTE ─────────────────────────────────────────────
  // Group by department so Sales-Head and COO see their own slice.
  const activeFte = await safeCount(db, `SELECT COUNT(*) c FROM employees WHERE status='active'`);
  const totalRevWindow = salesInWindow;
  const revPerFteOverall = activeFte > 0 ? Math.round(totalRevWindow / activeFte) : null;
  const revPerFteByDept = (await safeAll(db, `
    SELECT department, COUNT(*) fte
    FROM employees WHERE status='active' AND department IS NOT NULL
    GROUP BY department ORDER BY fte DESC
  `)).map(r => ({
    department: r.department, fte: r.fte,
    rev_per_fte: r.fte > 0 ? Math.round(totalRevWindow / r.fte) : null,
  }));

  // ── Project on-time milestone % ────────────────────────────────
  // Until milestone tracking lands (TOC v3 P0 #4), proxy with DPR
  // overall_status='on_track' over the last `days` window.
  const dprStatus = await safeAll(db, `
    SELECT overall_status, COUNT(*) c FROM dpr
    WHERE LEFT(report_date,10) >= ? GROUP BY overall_status
  `, from);
  const dprTotal = dprStatus.reduce((s, r) => s + r.c, 0);
  const dprOnTrack = dprStatus.find(r => r.overall_status === 'on_track')?.c || 0;
  const onTimeMilestonePct = dprTotal > 0 ? Math.round((dprOnTrack / dprTotal) * 1000) / 10 : null;

  // ── Project margin variance % ──────────────────────────────────
  // For each PO with sales bills + DPR cost rolled up, compare actual
  // margin vs the booked margin (business_book.actual_margin_pct).
  const marginRows = (await safeAll(db, `
    SELECT
      po.id po_id, po.po_number, bb.client_name, bb.actual_margin_pct booked_pct,
      COALESCE((SELECT SUM(total_amount) FROM sales_bills sb WHERE sb.po_id=po.id), 0) revenue,
      COALESCE((SELECT SUM(grand_total_b) FROM dpr d JOIN sites s ON d.site_id=s.id WHERE s.po_id=po.id), 0) cost
    FROM purchase_orders po
    JOIN business_book bb ON po.business_book_id = bb.id
    WHERE po.status IN ('in_progress','completed')
    ORDER BY po.id DESC LIMIT 50
  `)).map(r => {
    const actual_pct = r.revenue > 0 ? Math.round(((r.revenue - r.cost) / r.revenue) * 1000) / 10 : null;
    const variance = (actual_pct != null && r.booked_pct != null) ? Math.round((actual_pct - r.booked_pct) * 10) / 10 : null;
    return { ...r, actual_pct, variance };
  });
  const marginVariances = marginRows.map(r => r.variance).filter(v => v != null);
  const avgMarginVariance = marginVariances.length
    ? Math.round((marginVariances.reduce((a, b) => a + b, 0) / marginVariances.length) * 10) / 10
    : null;

  // ── Bank position ───────────────────────────────────────────────
  // Latest cash_flow_daily row's closing_balance is the running bank.
  const bank = await safeGet(db,
    `SELECT date, closing_balance FROM cash_flow_daily ORDER BY date DESC LIMIT 1`);

  // ── WIP (work-in-progress) ──────────────────────────────────────
  // PO total amount where status='in_progress' minus already-billed.
  const wipBookValue = ((await safeGet(db, `
    SELECT COALESCE(SUM(po.total_amount), 0) c
    FROM purchase_orders po WHERE po.status='in_progress'
  `))?.c) || 0;
  const wipBilled = ((await safeGet(db, `
    SELECT COALESCE(SUM(sb.total_amount), 0) c
    FROM sales_bills sb
    JOIN purchase_orders po ON sb.po_id = po.id
    WHERE po.status='in_progress'
  `))?.c) || 0;
  const wipUnbilled = wipBookValue - wipBilled;

  return {
    spec_version: 'v3',
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    window: { from, to, days },
    cash_conversion_cycle: { dso, dio, dpo, ccc },
    ar: { outstanding_total: arOutstanding, aging: arAging },
    ap: { outstanding_total: apOutstanding, purchases_in_window: purchasesInWindow },
    inventory: { total_value: inventoryTotal, free_to_use_value: inventoryFree },
    sales: { total_in_window: salesInWindow },
    bank: bank || null,
    wip: { book_value: wipBookValue, billed: wipBilled, unbilled: wipUnbilled },
    funnel: {
      leads_in_window: leadsInWindow,
      won_in_window: wonLeadsInWindow,
      lead_to_po_pct: leadToPoPct,
      quote_lead_time_days_avg: quoteLeadTimeAvg,
    },
    revenue_per_fte: {
      overall: revPerFteOverall,
      active_employees: activeFte,
      by_department: revPerFteByDept,
    },
    on_time_milestone_pct: onTimeMilestonePct,
    project_margin_variance: {
      avg_variance_pct: avgMarginVariance,
      sample_size: marginVariances.length,
      worst_5: marginRows
        .filter(r => r.variance != null)
        .sort((a, b) => a.variance - b.variance)
        .slice(0, 5)
        .map(r => ({ po_number: r.po_number, client: r.client_name, booked_pct: r.booked_pct, actual_pct: r.actual_pct, variance: r.variance })),
    },
  };
}

// Thin route wrapper around the pure compute function.
router.get('/kpi', async (req, res) => {
  try {
    res.json(await computeKpiPayload(pg, req.query.days));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.computeKpiPayload = computeKpiPayload;
