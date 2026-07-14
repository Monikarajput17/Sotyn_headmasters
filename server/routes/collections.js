const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const {
  calculateAgeing, getStatusColor,
  syncSalesBillPaymentStatus, ensureTodayCashFlowDaily,
  refreshAllAgeing,
} = require('../lib/cashSync');
const router = express.Router();
router.use(authMiddleware);

// Auto-raise a PMS Task from a collection remark so EVERY remark becomes a tracked
// action item for the finance executive (mam 2026-07-06: "all remarks automatically
// go to PMS task … this follow-up is of finance executive Aanchal"). Used by BOTH
// the Follow-up action (POST /:id/follow-up) and the inline edit (PUT /:id) so it
// fires no matter where the remark is typed. Best-effort — the caller wraps it in
// try/catch so a task failure never fails the underlying save. Returns the task id.
function raisePmsTaskFromRemark(db, r, remark, opts = {}) {
  const text = String(remark || '').trim();
  if (!text) return null;
  // Assignee = Aanchal (collections/finance executive), resolved by name like the
  // payment flow; fall back to whoever logged it so the task is never lost.
  const aanchal = db.prepare("SELECT id FROM users WHERE COALESCE(active,1)=1 AND LOWER(TRIM(name))='aanchal' LIMIT 1").get()
    || db.prepare("SELECT id FROM users WHERE COALESCE(active,1)=1 AND LOWER(name) LIKE 'aanchal%' ORDER BY id LIMIT 1").get();
  const assignee = aanchal ? aanchal.id : opts.loggedBy;
  const client = r.site_name || r.client_name || r.project_name || 'client';
  // Only link project_id when it maps to a real business_book row (matches the
  // pms_tasks_count linkage p.project_id = r.site_id), else leave it null.
  const projectId = (r.site_id && db.prepare('SELECT 1 FROM business_book WHERE id=?').get(r.site_id)) ? r.site_id : null;
  const title = `Collection follow-up — ${client}`.slice(0, 120);
  const desc = `${client}: ${text}`
    + (opts.promised_date ? `\nPromised: ${opts.promised_date}` : '')
    + (opts.promised_amount ? ` · ₹${opts.promised_amount}` : '');
  const info = db.prepare(
    `INSERT INTO pms_tasks (title, description, project_id, project_name_snapshot, crm_name, assigned_by, assigned_to, due_date)
       VALUES (?,?,?,?,?,?,?,?)`
  ).run(title, desc, projectId, r.site_name || r.client_name || null, r.crm_name || null, opts.loggedBy, assignee, opts.promised_date || null);
  try { require('../lib/push').notify(assignee, { title: '💰 Collection follow-up', body: title + (opts.promised_date ? ` · due ${opts.promised_date}` : ''), url: '/pms-tasks', tag: `pms-${info.lastInsertRowid}` }); } catch (_) {}
  return info.lastInsertRowid;
}

// Get all receivables with filters. Now also returns:
//   - pms_tasks_count : how many PMS tasks were raised for this site
//                       (so mam can see at a glance how much CRM
//                       follow-up activity sits behind a delayed payment)
//   - payments        : array of individual collection installments
//                       [{ amount, collection_date, payment_mode, notes }]
//                       so the table can show "today rec 40, +15 in 10 days"
router.get('/', (req, res) => {
  const { status, ageing_bucket, client, search } = req.query;
  // bb_project_name: best-effort lookup of the matching business_book.project_name
  // for this receivable, by matching r.client_name OR r.site_name against either
  // business_book.client_name or business_book.project_name (case-insensitive +
  // trimmed). Lets the UI show the actual project / site label even on legacy
  // receivables that only carry client_name.
  let sql = `
    SELECT r.*,
           u.name as owner_name,
           (SELECT bb.project_name FROM business_book bb
              WHERE bb.project_name IS NOT NULL AND TRIM(bb.project_name) <> ''
                AND (
                     LOWER(TRIM(bb.client_name))   = LOWER(TRIM(COALESCE(r.client_name,'')))
                  OR LOWER(TRIM(bb.project_name))  = LOWER(TRIM(COALESCE(r.client_name,'')))
                  OR LOWER(TRIM(bb.project_name))  = LOWER(TRIM(COALESCE(r.site_name,'')))
                )
              ORDER BY bb.id LIMIT 1
           ) as bb_project_name,
           (SELECT COUNT(*) FROM pms_tasks p
              WHERE p.project_id = r.site_id
                 OR (r.site_name IS NOT NULL AND r.site_name <> ''
                     AND (p.project_name_snapshot = r.site_name
                          OR p.project_name_snapshot LIKE '%' || r.site_name || '%'))
           ) as pms_tasks_count
      FROM receivables r
      LEFT JOIN users u ON r.owner_id = u.id
     WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND r.status = ?'; params.push(status); }
  if (ageing_bucket) { sql += ' AND r.ageing_bucket = ?'; params.push(ageing_bucket); }
  if (client) { sql += ' AND (r.client_name LIKE ? OR r.site_name LIKE ?)'; params.push(`%${client}%`, `%${client}%`); }
  if (search) { sql += ' AND (r.client_name LIKE ? OR r.site_name LIKE ? OR r.invoice_number LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  sql += ' ORDER BY r.status DESC, r.ageing_days DESC';
  const rows = getDb().prepare(sql).all(...params);

  // Pull payment installments per receivable (one query, then group)
  const ids = rows.map(r => r.id);
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const allPayments = getDb().prepare(
      `SELECT receivable_id, amount, collection_date, payment_mode, transaction_ref, notes
         FROM collections
        WHERE receivable_id IN (${placeholders})
        ORDER BY collection_date DESC, id DESC`
    ).all(...ids);
    const byRecv = new Map();
    for (const p of allPayments) {
      if (!byRecv.has(p.receivable_id)) byRecv.set(p.receivable_id, []);
      byRecv.get(p.receivable_id).push(p);
    }
    for (const r of rows) r.payments = byRecv.get(r.id) || [];
  } else {
    rows.forEach(r => { r.payments = []; });
  }
  res.json(rows);
});

// MD Dashboard — one row per site with money + activity in the same view.
// Correlates each receivable with:
//   - pms_tasks_count : how many CRM tasks were raised for the site
//                       (chasing payment / coordination)
//   - location_pings_7d : how many GPS pings happened for the linked site
//                         in the last 7 days (proxy for "is anyone visiting
//                         the client / site to chase payment")
//   - last_follow_up   : most recent collection_follow_up date for this row
//                       (proxy for Aanchal's actual chasing)
//   - oldest_ageing    : ageing days of the oldest unpaid invoice for the
//                       site (so MD instantly sees the worst offender)
// Sorted by outstanding DESC so MD's eye lands on biggest unpaid first.
router.get('/md-dashboard', (req, res) => {
  const db = getDb();
  const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT
      COALESCE(r.site_name, r.client_name) as site_name,
      r.site_id,
      MIN(r.crm_name)                       as crm_name,
      MIN(u.name)                           as owner_name,
      COUNT(r.id)                           as invoice_count,
      COALESCE(SUM(r.invoice_amount),0)     as target,
      COALESCE(SUM(r.received_amount),0)    as received,
      COALESCE(SUM(r.outstanding_amount),0) as outstanding,
      MAX(r.ageing_days)                    as oldest_ageing,
      MAX(r.next_planned_date)              as next_planned_date,
      MAX(r.last_discussion)                as last_discussion,
      (SELECT COUNT(*) FROM pms_tasks p
         WHERE (r.site_id IS NOT NULL AND p.project_id = r.site_id)
            OR (r.site_name IS NOT NULL AND r.site_name <> ''
                AND (p.project_name_snapshot = r.site_name
                     OR p.project_name_snapshot LIKE '%' || r.site_name || '%'))
      )                                     as pms_tasks_count,
      (SELECT COUNT(*) FROM location_tracking lt
         WHERE lt.time >= ?
           AND lt.site_name IS NOT NULL AND lt.site_name <> 'Outside'
           AND lt.site_name = COALESCE(r.site_name, r.client_name)
      )                                     as location_pings_7d,
      (SELECT MAX(cf.follow_up_date) FROM collection_follow_ups cf
         WHERE cf.receivable_id = r.id
      )                                     as last_follow_up,
      -- Indents raised for this site — total + last 30 days separately
      -- so MD can see fresh procurement activity vs lifetime activity.
      (SELECT COUNT(*) FROM indents ind
         WHERE ind.site_name = COALESCE(r.site_name, r.client_name)
            OR ind.client_name = COALESCE(r.site_name, r.client_name)
      )                                     as indents_count,
      (SELECT COUNT(*) FROM indents ind
         WHERE (ind.site_name = COALESCE(r.site_name, r.client_name)
                OR ind.client_name = COALESCE(r.site_name, r.client_name))
           AND ind.created_at >= DATE('now', '-30 days')
      )                                     as indents_30d,
      -- Materials value SENT to this site — sums OUT movements whose
      -- site_id matches, plus IN movements at this site's site_store
      -- warehouse (i.e. material physically delivered to the site).
      (SELECT COALESCE(SUM(sm.quantity * sm.rate), 0)
         FROM stock_movements sm
        WHERE (sm.site_id = r.site_id AND r.site_id IS NOT NULL)
           OR sm.warehouse_id IN (
             SELECT w.id FROM warehouses w
              WHERE w.type = 'site_store'
                AND w.name = COALESCE(r.site_name, r.client_name) || ' Store'
           )
      )                                     as materials_value_sent,
      -- DPR entries in the last 30 days for that site
      (SELECT COUNT(*) FROM dpr d
         JOIN sites s ON s.id = d.site_id
        WHERE s.name = COALESCE(r.site_name, r.client_name)
          AND d.created_at >= DATE('now', '-30 days')
      )                                     as dpr_count_30d
    FROM receivables r
    LEFT JOIN users u ON u.id = r.owner_id
    GROUP BY COALESCE(r.site_name, r.client_name)
    ORDER BY outstanding DESC
  `).all(since7);

  // Top-line totals
  const totals = rows.reduce((s, r) => ({
    sites: s.sites + 1,
    target: s.target + (+r.target || 0),
    received: s.received + (+r.received || 0),
    outstanding: s.outstanding + (+r.outstanding || 0),
    pms_tasks: s.pms_tasks + (+r.pms_tasks_count || 0),
    location_pings_7d: s.location_pings_7d + (+r.location_pings_7d || 0),
    indents_count: s.indents_count + (+r.indents_count || 0),
    indents_30d: s.indents_30d + (+r.indents_30d || 0),
    materials_value_sent: s.materials_value_sent + (+r.materials_value_sent || 0),
    dpr_count_30d: s.dpr_count_30d + (+r.dpr_count_30d || 0),
  }), { sites: 0, target: 0, received: 0, outstanding: 0, pms_tasks: 0, location_pings_7d: 0, indents_count: 0, indents_30d: 0, materials_value_sent: 0, dpr_count_30d: 0 });
  totals.collection_pct = totals.target > 0 ? +(100 * totals.received / totals.target).toFixed(2) : 0;

  // Flag rows where outstanding is significant AND there's NO recent
  // activity — these are the "silent overdue" sites MD should grill.
  const flagged = rows.filter(r =>
    +r.outstanding > 0 && +r.oldest_ageing > 30 &&
    +r.pms_tasks_count === 0 && +r.location_pings_7d === 0
  );

  res.json({ totals, sites: rows, silent_overdue_count: flagged.length });
});

// Helper for the Edit/Add modal — UNIQUE PROJECT NAMES from the
// Business Book master. mam: "in collection eng site name is project
// name". So the dropdown lists distinct business_book.project_name
// values (CONSERN PHARMA appears once even though 3 BB rows reference
// it across different POs). Latest PO of any BB row sharing that
// project name is used to auto-fill CRM + suggest target payment.
router.get('/sites', (req, res) => {
  const db = getDb();
  // Mam (2026-05-20): "site name is required from business book
  // company name unique".  Dedupe by COMPANY_NAME from BB.
  //
  // 2026-05-20 hotfix: the previous version used correlated
  // subqueries inside a GROUP BY SELECT to pull crm_name /
  // latest_po_value / latest_po_number per company.  SQLite threw
  // "misuse of aggregate function MIN()" at runtime — the engine
  // doesn't reliably support correlated subqueries against an
  // outer grouped row.  Restructured: one simple grouped SELECT
  // for the company list, then per-row PO lookups via prepared
  // statements in JS (one extra SELECT per company; cheap at our
  // row counts).
  const rows = db.prepare(`
    SELECT MIN(bb.id) as business_book_id,
           TRIM(bb.company_name) as company_name,
           GROUP_CONCAT(DISTINCT bb.client_name)  as client_names,
           GROUP_CONCAT(DISTINCT bb.project_name) as project_names,
           MIN(bb.lead_no) as lead_no
    FROM business_book bb
    WHERE bb.company_name IS NOT NULL AND TRIM(bb.company_name) <> ''
    GROUP BY TRIM(bb.company_name)
    ORDER BY TRIM(bb.company_name)
  `).all();

  // Orphan fallback (BB with project_name but no company_name)
  const orphans = db.prepare(`
    SELECT MIN(id) as business_book_id,
           TRIM(project_name) as project_name,
           GROUP_CONCAT(DISTINCT client_name) as client_names,
           MIN(lead_no) as lead_no
    FROM business_book
    WHERE (company_name IS NULL OR TRIM(company_name) = '')
      AND project_name IS NOT NULL AND TRIM(project_name) <> ''
    GROUP BY TRIM(project_name)
    ORDER BY TRIM(project_name)
  `).all();

  // Prepared statements for the per-row PO lookups
  const getCrm = db.prepare(`
    SELECT po.crm_name FROM purchase_orders po
    JOIN business_book bb ON po.business_book_id = bb.id
    WHERE TRIM(bb.company_name) = ?
      AND po.crm_name IS NOT NULL AND po.crm_name <> ''
    ORDER BY po.created_at DESC LIMIT 1
  `);
  const getTotal = db.prepare(`
    SELECT COALESCE(SUM(po.total_amount), 0) as total FROM purchase_orders po
    JOIN business_book bb ON po.business_book_id = bb.id
    WHERE TRIM(bb.company_name) = ?
  `);
  const getLatestPo = db.prepare(`
    SELECT po.po_number FROM purchase_orders po
    JOIN business_book bb ON po.business_book_id = bb.id
    WHERE TRIM(bb.company_name) = ?
    ORDER BY po.created_at DESC LIMIT 1
  `);

  const enrich = (companyName) => {
    if (!companyName) return { crm_name: null, latest_po_value: 0, latest_po_number: null };
    return {
      crm_name: getCrm.get(companyName)?.crm_name || null,
      latest_po_value: getTotal.get(companyName)?.total || 0,
      latest_po_number: getLatestPo.get(companyName)?.po_number || null,
    };
  };

  const list = [
    ...rows.map(r => {
      const enr = enrich(r.company_name);
      return {
        business_book_id: r.business_book_id,
        id: r.business_book_id,
        name: r.company_name,
        project_name: (r.project_names || '').split(',').filter(Boolean)[0] || r.company_name,
        client_name: (r.client_names || '').split(',').filter(Boolean)[0] || null,
        company_name: r.company_name,
        lead_no: r.lead_no,
        ...enr,
        label: [r.company_name, (r.client_names || '').split(',').filter(Boolean)[0]].filter(Boolean).join(' · '),
      };
    }),
    ...orphans.map(o => ({
      business_book_id: o.business_book_id,
      id: o.business_book_id,
      name: o.project_name,
      project_name: o.project_name,
      client_name: (o.client_names || '').split(',').filter(Boolean)[0] || null,
      company_name: null,
      lead_no: o.lead_no,
      crm_name: null,
      latest_po_value: 0,
      latest_po_number: null,
      label: `${o.project_name} · (no company set)`,
    })),
  ];
  res.json(list);
});

// Dashboard summary
router.get('/summary', (req, res) => {
  const db = getDb();
  const total = db.prepare('SELECT COALESCE(SUM(outstanding_amount),0) as total FROM receivables WHERE outstanding_amount > 0').get();
  const byBucket = db.prepare('SELECT ageing_bucket, COUNT(*) as count, COALESCE(SUM(outstanding_amount),0) as total FROM receivables WHERE outstanding_amount > 0 GROUP BY ageing_bucket').all();
  const byStatus = db.prepare('SELECT status, COUNT(*) as count, COALESCE(SUM(outstanding_amount),0) as total FROM receivables WHERE outstanding_amount > 0 GROUP BY status').all();
  const topClients = db.prepare('SELECT client_name, SUM(outstanding_amount) as total FROM receivables WHERE outstanding_amount > 0 GROUP BY client_name ORDER BY total DESC LIMIT 10').all();
  const overdue = db.prepare('SELECT COUNT(*) as count, COALESCE(SUM(outstanding_amount),0) as total FROM receivables WHERE ageing_days > 30 AND outstanding_amount > 0').get();

  res.json({ totalOutstanding: total.total, byBucket, byStatus, topClients, overdue });
});

// Payment Advice / Outstanding statement for ONE client (mam 2026-06-04
// post-PO chart, stage 13: "Payment advice with pending balance").
// Lists every receivable (invoice) for the client with billed / received
// / pending, plus the totals.  Rendered by the PaymentAdvicePrint page.
// Keyed by ?client=<client_name> (and optional ?bbid=<business_book_id>).
router.get('/payment-advice', (req, res) => {
  const db = getDb();
  const clientName = String(req.query.client || '').trim();
  const bbid = req.query.bbid ? +req.query.bbid : null;
  if (!clientName && !bbid) return res.status(400).json({ error: 'client name or bbid is required' });

  const rows = bbid
    ? db.prepare(`SELECT * FROM receivables WHERE business_book_id = ? ORDER BY COALESCE(invoice_date, created_at)`).all(bbid)
    : db.prepare(`SELECT * FROM receivables WHERE LOWER(TRIM(client_name)) = LOWER(TRIM(?)) ORDER BY COALESCE(invoice_date, created_at)`).all(clientName);

  const totals = rows.reduce((a, r) => {
    a.billed += +r.invoice_amount || 0;
    a.received += +r.received_amount || 0;
    a.pending += +r.outstanding_amount || 0;
    return a;
  }, { billed: 0, received: 0, pending: 0 });

  // Pull client address / GSTIN from business_book when we can resolve it.
  let client = { name: clientName || rows[0]?.client_name || '', company: null, address: null, gstin: null, state: null };
  try {
    const resolveBbid = bbid || rows.find(r => r.business_book_id)?.business_book_id || null;
    let bb = null;
    if (resolveBbid) bb = db.prepare(`SELECT company_name, client_name, billing_address, gstin, state FROM business_book WHERE id = ?`).get(resolveBbid);
    if (!bb && clientName) bb = db.prepare(`SELECT company_name, client_name, billing_address, gstin, state FROM business_book WHERE LOWER(TRIM(COALESCE(client_name,''))) = LOWER(TRIM(?)) OR LOWER(TRIM(COALESCE(company_name,''))) = LOWER(TRIM(?)) ORDER BY id DESC LIMIT 1`).get(clientName, clientName);
    if (bb) client = { name: bb.client_name || clientName, company: bb.company_name || null, address: bb.billing_address || null, gstin: bb.gstin || null, state: bb.state || null };
  } catch (_) { /* non-fatal */ }

  res.json({
    client,
    invoices: rows.map(r => ({
      invoice_number: r.invoice_number, invoice_date: r.invoice_date,
      project_name: r.project_name, site_name: r.site_name,
      billed: +r.invoice_amount || 0, received: +r.received_amount || 0,
      pending: +r.outstanding_amount || 0, due_date: r.due_date,
      ageing_days: r.ageing_days, ageing_bucket: r.ageing_bucket, status: r.status,
    })),
    totals,
  });
});

// Create receivable. Accepts the original free-text fields AND the new
// v2 fields (site_id / site_name / crm_name / next_planned_date /
// last_discussion). client_name is auto-derived from site_name when
// missing so the existing dashboard still groups things correctly.
router.post('/', requirePermission('collections', 'create'), (req, res) => {
  const b = req.body || {};
  const {
    client_name, project_name, po_id, invoice_number, invoice_date,
    invoice_amount, due_date, owner_id,
    site_id, site_name, crm_name, next_planned_date, last_discussion,
  } = b;
  const target = +invoice_amount;
  const finalClient = client_name || site_name;
  if (!finalClient || !(target > 0)) return res.status(400).json({ error: 'Site/client name and target amount required' });

  const { days, bucket } = calculateAgeing(due_date);
  const statusColor = getStatusColor(target, days);

  const r = getDb().prepare(
    `INSERT INTO receivables
       (client_name, project_name, po_id, invoice_number, invoice_date,
        invoice_amount, outstanding_amount, due_date, ageing_days, ageing_bucket,
        status, owner_id, created_by,
        site_id, site_name, crm_name, next_planned_date, last_discussion)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    finalClient, project_name || site_name || null, po_id || null, invoice_number || null, invoice_date || null,
    target, target, due_date || null, days, bucket,
    statusColor, owner_id || null, req.user.id,
    site_id || null, site_name || null, crm_name || null, next_planned_date || null, last_discussion || null,
  );
  // A "Last Discussion" typed on a brand-new receivable is a remark too — raise a
  // PMS task for it so no remark is missed (mam: "all remarks go to PMS task").
  let pms_task_id = null;
  try {
    if (String(last_discussion || '').trim()) {
      const db = getDb();
      const row = db.prepare('SELECT * FROM receivables WHERE id=?').get(r.lastInsertRowid);
      pms_task_id = raisePmsTaskFromRemark(db, row, last_discussion, {
        promised_date: next_planned_date || null, loggedBy: req.user.id,
      });
    }
  } catch (e) { console.warn('[collections] new-receivable remark → PMS task failed:', e.message); }
  res.status(201).json({ id: r.lastInsertRowid, pms_task_id });
});

// Update receivable. Two modes:
//   - Quick: pass any of follow_up_status / follow_up_date / follow_up_notes /
//     escalation_level / owner_id (the original signature)
//   - Full edit: also accepts client_name / project_name / invoice_number /
//     invoice_date / invoice_amount / due_date. When invoice_amount or
//     due_date change, ageing days/bucket and status colour are recomputed.
router.put('/:id', requirePermission('collections', 'edit'), (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM receivables WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};

  // Build a partial UPDATE — only touch the fields the caller actually sent
  const sets = []; const params = [];
  const set = (k, v) => { sets.push(`${k}=?`); params.push(v); };

  if (b.client_name !== undefined)       set('client_name', b.client_name);
  if (b.project_name !== undefined)      set('project_name', b.project_name);
  if (b.invoice_number !== undefined)    set('invoice_number', b.invoice_number);
  if (b.invoice_date !== undefined)      set('invoice_date', b.invoice_date || null);
  if (b.due_date !== undefined)          set('due_date', b.due_date || null);

  // Defensive FK validators — these columns reference users(id) / sites(id),
  // but the receivable rows may carry stale references to sites/users that
  // were since deleted (data drift). Without this guard, every Edit Save
  // triggers SQLite "FOREIGN KEY constraint failed" because the row's old
  // value re-enters the UPDATE. We coerce unknown ids to NULL so the save
  // always succeeds — the field stays empty until the user picks a fresh value.
  const userExists = (id) => {
    const v = +id; if (!Number.isFinite(v) || v <= 0) return false;
    return !!db.prepare('SELECT 1 FROM users WHERE id=?').get(v);
  };
  const siteExists = (id) => {
    const v = +id; if (!Number.isFinite(v) || v <= 0) return false;
    return !!db.prepare('SELECT 1 FROM sites WHERE id=?').get(v);
  };

  if (b.owner_id !== undefined)          set('owner_id', userExists(b.owner_id) ? +b.owner_id : null);
  if (b.follow_up_status !== undefined)  set('follow_up_status', b.follow_up_status);
  if (b.follow_up_date !== undefined)    set('follow_up_date', b.follow_up_date || null);
  if (b.follow_up_notes !== undefined)   set('follow_up_notes', b.follow_up_notes);
  if (b.escalation_level !== undefined)  set('escalation_level', +b.escalation_level || 0);
  // Collection Engine v2 fields
  if (b.site_id !== undefined)           set('site_id', siteExists(b.site_id) ? +b.site_id : null);
  if (b.site_name !== undefined)         set('site_name', b.site_name || null);
  if (b.crm_name !== undefined)          set('crm_name', b.crm_name || null);
  if (b.next_planned_date !== undefined) set('next_planned_date', b.next_planned_date || null);
  if (b.last_discussion !== undefined)   set('last_discussion', b.last_discussion || null);

  // Resolve effective amount + received for the outstanding recompute.
  // Mam (2026-05-16): "can edit here payment rec." — received_amount
  // is now a directly-editable field on the Edit Receivable form.
  // We accept it on PUT and recompute outstanding_amount accordingly.
  const effInvoiceAmt = b.invoice_amount !== undefined ? +b.invoice_amount : +cur.invoice_amount;
  const effReceived   = b.received_amount !== undefined ? Math.max(0, +b.received_amount) : +cur.received_amount;
  if (b.invoice_amount !== undefined)  set('invoice_amount', effInvoiceAmt);
  if (b.received_amount !== undefined) set('received_amount', effReceived);
  if (b.invoice_amount !== undefined || b.received_amount !== undefined) {
    set('outstanding_amount', Math.max(0, effInvoiceAmt - effReceived));
  }

  // Recompute ageing if due_date or invoice_amount changed
  if (b.due_date !== undefined || b.invoice_amount !== undefined) {
    const dueDate = b.due_date !== undefined ? (b.due_date || cur.due_date) : cur.due_date;
    const amt = b.invoice_amount !== undefined ? +b.invoice_amount : +cur.invoice_amount;
    const { days, bucket } = calculateAgeing(dueDate);
    set('ageing_days', days);
    set('ageing_bucket', bucket);
    set('status', getStatusColor(amt, days));
  }

  if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
  sets.push('updated_at=CURRENT_TIMESTAMP');
  params.push(req.params.id);
  db.prepare(`UPDATE receivables SET ${sets.join(', ')} WHERE id=?`).run(...params);

  // A remark typed via the inline edit (follow_up_notes) or the Collection-Engine
  // discussion box (last_discussion) auto-raises a PMS task too — same as the
  // Follow-up action — but only when the text actually CHANGED to a new non-empty
  // value, so re-saving unrelated fields never spawns a duplicate. (mam: "all
  // remarks automatically go to PMS task".)
  let pms_task_id = null;
  try {
    const noteChanged = b.follow_up_notes !== undefined
      && String(b.follow_up_notes || '').trim()
      && String(b.follow_up_notes || '').trim() !== String(cur.follow_up_notes || '').trim();
    const discChanged = b.last_discussion !== undefined
      && String(b.last_discussion || '').trim()
      && String(b.last_discussion || '').trim() !== String(cur.last_discussion || '').trim();
    if (noteChanged || discChanged) {
      const r = db.prepare('SELECT * FROM receivables WHERE id=?').get(req.params.id) || cur;
      const remark = discChanged ? b.last_discussion : b.follow_up_notes;
      pms_task_id = raisePmsTaskFromRemark(db, r, remark, {
        promised_date: b.next_planned_date || b.follow_up_date || null,
        loggedBy: req.user.id,
      });
    }
  } catch (e) { console.warn('[collections] edit remark → PMS task failed:', e.message); }

  res.json({ message: 'Updated', pms_task_id });
});

// Target vs Received summary, broken down by ageing bucket. Used by the
// "Payment Target vs Received (with Ageing)" panel mam asked for.
//   target           = SUM(invoice_amount)
//   received         = SUM(received_amount)
//   outstanding      = SUM(outstanding_amount)
//   collection_pct   = received / target * 100
//   by_bucket        = same metrics per ageing_bucket
router.get('/target-summary', (req, res) => {
  const db = getDb();
  const overall = db.prepare(`
    SELECT COUNT(*)                      as count,
           COALESCE(SUM(invoice_amount),0)     as target,
           COALESCE(SUM(received_amount),0)    as received,
           COALESCE(SUM(outstanding_amount),0) as outstanding
      FROM receivables
  `).get();
  overall.collection_pct = overall.target > 0 ? +(100 * overall.received / overall.target).toFixed(2) : 0;

  const byBucket = db.prepare(`
    SELECT ageing_bucket,
           COUNT(*)                              as count,
           COALESCE(SUM(invoice_amount),0)       as target,
           COALESCE(SUM(received_amount),0)      as received,
           COALESCE(SUM(outstanding_amount),0)   as outstanding
      FROM receivables
     GROUP BY ageing_bucket
     ORDER BY CASE ageing_bucket
       WHEN '0-30' THEN 0 WHEN '30-60' THEN 1
       WHEN '60-90' THEN 2 WHEN '90+'   THEN 3 ELSE 4 END
  `).all().map(r => ({
    ...r,
    collection_pct: r.target > 0 ? +(100 * r.received / r.target).toFixed(2) : 0,
  }));

  res.json({ overall, by_bucket: byBucket });
});

// Delete receivable (blocks if any collection received)
router.delete('/:id', requirePermission('collections', 'delete'), (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const received = db.prepare('SELECT COUNT(*) as c FROM collections WHERE receivable_id=?').get(id).c;
  if (received > 0) return res.status(409).json({ error: 'Cannot delete: collections have been recorded against this receivable' });
  db.prepare('DELETE FROM collection_follow_ups WHERE receivable_id=?').run(id);
  db.prepare('DELETE FROM receivables WHERE id=?').run(id);
  res.json({ message: 'Deleted' });
});

// Add follow-up
router.post('/:id/follow-up', requirePermission('collections', 'edit'), (req, res) => {
  const { follow_up_date, contact_method, response, promised_date, promised_amount } = req.body;
  const db = getDb();
  db.prepare('INSERT INTO collection_follow_ups (receivable_id, follow_up_date, contact_method, response, promised_date, promised_amount, followed_by) VALUES (?,?,?,?,?,?,?)')
    .run(req.params.id, follow_up_date, contact_method, response, promised_date, promised_amount, req.user.id);

  // Update receivable follow-up status
  db.prepare('UPDATE receivables SET follow_up_status=?, follow_up_date=?, follow_up_notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run('contacted', follow_up_date, response, req.params.id);

  // Auto-raise a PMS Task from the remark so every collection follow-up becomes a
  // tracked action item for the finance executive (mam 2026-07-06: "all remarks
  // automatically go to PMS task … this follow-up is of finance executive
  // Aanchal"). Best-effort: a failure here never fails the follow-up itself.
  let pms_task_id = null;
  try {
    const r = db.prepare('SELECT * FROM receivables WHERE id=?').get(req.params.id) || {};
    pms_task_id = raisePmsTaskFromRemark(db, r, response, {
      promised_date, promised_amount, loggedBy: req.user.id,
    });
  } catch (e) { console.warn('[collections] follow-up → PMS task failed:', e.message); }

  res.status(201).json({ message: 'Follow-up added', pms_task_id });
});

// Get follow-ups for a receivable
router.get('/:id/follow-ups', (req, res) => {
  const followUps = getDb().prepare('SELECT f.*, u.name as followed_by_name FROM collection_follow_ups f LEFT JOIN users u ON f.followed_by=u.id WHERE f.receivable_id=? ORDER BY f.created_at DESC').all(req.params.id);
  res.json(followUps);
});

// Record collection (payment received from client)
router.post('/:id/collect', requirePermission('collections', 'edit'), (req, res) => {
  const { amount, collection_date, payment_mode, transaction_ref, notes } = req.body;
  const amt = +amount;
  if (!(amt > 0)) return res.status(400).json({ error: 'Valid amount required' });
  const db = getDb();

  // Guard against a deleted/stale receivable — otherwise the read below is
  // undefined and rec.received_amount 500s.
  const rec = db.prepare('SELECT * FROM receivables WHERE id=?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Receivable not found' });

  // Record collection (coerce optional fields to null so an omitted field
  // never throws an undefined-bind error).
  db.prepare('INSERT INTO collections (receivable_id, amount, collection_date, payment_mode, transaction_ref, notes, collected_by) VALUES (?,?,?,?,?,?,?)')
    .run(req.params.id, amt, collection_date || new Date().toISOString().split('T')[0], payment_mode || null, transaction_ref || null, notes || null, req.user.id);

  // Update receivable. Use the coerced number so we never string-concat money.
  const newReceived = (rec.received_amount || 0) + amt;
  const newOutstanding = rec.invoice_amount - newReceived;
  const { days, bucket } = calculateAgeing(rec.due_date);
  const statusColor = getStatusColor(newOutstanding, days);

  db.prepare('UPDATE receivables SET received_amount=?, outstanding_amount=?, ageing_days=?, ageing_bucket=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(newReceived, Math.max(0, newOutstanding), days, bucket, statusColor, req.params.id);

  // A9 — sync sales_bills.payment_status if this receivable is
  // linked to a sales bill (via invoice_number = bill_number).
  // Quietly no-ops when no bill is linked.
  const billSync = syncSalesBillPaymentStatus(db, req.params.id);

  // AUTO-LINK + A14 — Add to Cash Flow as inflow; ensureTodayCashFlowDaily
  // creates today's row with opening = yesterday closing if missing.
  const today = collection_date || new Date().toISOString().split('T')[0];
  const dailyRes = ensureTodayCashFlowDaily(db, today);
  const daily = { id: dailyRes.id };
  db.prepare('INSERT INTO cash_flow_entries (daily_id, date, type, category, description, amount, payment_mode, party_name, reference_type, reference_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(daily.id, today, 'inflow', 'Collection', `Collection from ${rec.client_name} - ${rec.invoice_number || ''}`, amount, payment_mode, rec.client_name, 'collection', req.params.id, req.user.id);

  // Recalculate daily cash flow
  const inflows = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM cash_flow_entries WHERE daily_id=? AND type='inflow'").get(daily.id);
  const outflows = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM cash_flow_entries WHERE daily_id=? AND type='outflow'").get(daily.id);
  const opening = db.prepare('SELECT opening_balance FROM cash_flow_daily WHERE id=?').get(daily.id);
  db.prepare('UPDATE cash_flow_daily SET total_inflows=?, total_outflows=?, closing_balance=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(inflows.t, outflows.t, (opening?.opening_balance || 0) + inflows.t - outflows.t, daily.id);

  res.status(201).json({
    message: 'Collection recorded & linked to Cash Flow',
    new_outstanding: Math.max(0, newOutstanding),
    sales_bill_synced: billSync.synced > 0 ? billSync : null,
  });
});

// Refresh all ageing (run daily or on demand).  Same code path as
// the 01:00 cron in scripts/cashFidelityCron.js — shared helper.
router.post('/refresh-ageing', requirePermission('collections', 'edit'), (req, res) => {
  const r = refreshAllAgeing(getDb());
  res.json({ message: `Ageing refreshed for ${r.updated} receivables` });
});

module.exports = router;
