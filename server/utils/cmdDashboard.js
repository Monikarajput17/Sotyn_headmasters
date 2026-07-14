// CMD Dashboard — extended data computer (TOC v3 + Single-Page v2).
//
// Single function `computeCmdDetail(db, days)` returns every list /
// breakdown / chart series the two CMD dashboard pages need.  Designed
// so the SAME response feeds both:
//   /dashboard/cmd        — Stage 1 (Operating Console v2)
//   /dashboard/cmd-toc    — Stage 2 (TOC View v3)
//
// All money figures in raw rupees.  When a metric requires source data
// the ERP doesn't capture yet (e.g. quote-loss reasons, plant performance
// ratio), the field returns `null` and the frontend renders an "—" with
// a "needs capture" tooltip rather than fabricating a number.

const TODAY = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};
const safeGet = (db, sql, ...p) => { try { return db.prepare(sql).get(...p); } catch { return null; } };
const safeAll = (db, sql, ...p) => { try { return db.prepare(sql).all(...p); } catch { return []; } };
const num = (v) => (v == null ? 0 : Number(v) || 0);

function computeCmdDetail(db, daysRaw) {
  const started = Date.now();
  const days = Math.min(365, Math.max(7, parseInt(daysRaw, 10) || 90));
  const from = daysAgo(days);
  const today = TODAY();

  // ── PULSE NUMBERS ──────────────────────────────────────────────
  const bank = safeGet(db,
    `SELECT date, closing_balance FROM cash_flow_daily ORDER BY date DESC LIMIT 1`);
  const cashOnHand = num(bank?.closing_balance);

  // Free cash = bank − dues falling in next 30 days
  const dues30 = num((safeGet(db, `
    SELECT COALESCE(SUM(total_amount),0) c
    FROM purchase_bills
    WHERE payment_status IN ('pending','partial')
      AND date(bill_date) >= date('now', '-30 days')
  `)?.c));
  const freeCash = Math.max(0, cashOnHand - dues30);

  // Burn rate (avg daily outflow over last 30 days) → runway
  const dailyBurn = num((safeGet(db, `
    SELECT COALESCE(SUM(amount), 0) / 30.0 c FROM cash_flow_entries
    WHERE type='outflow' AND date(date) >= date('now', '-30 days')
  `)?.c));
  const runwayDays = dailyBurn > 0 ? Math.round(cashOnHand / dailyBurn) : null;

  // Active sites / order book / revenue MTD / open snags
  // UNIQUE sites, not raw rows. Mam (2026-05-30): "pick unique sites from
  // business book." The `sites` table carries legacy duplicates from PO
  // re-uploads (same project, stray-quote name variants) that inflate the
  // count (was 81). Dedupe by the linked business_book project; active
  // sites with no BB link fall back to a normalized name.
  const activeSites = num(safeGet(db, `
    SELECT COUNT(*) c FROM (
      SELECT DISTINCT CAST(business_book_id AS TEXT) k
        FROM sites WHERE status='active' AND business_book_id IS NOT NULL
      UNION
      SELECT DISTINCT 'name:' || TRIM(LOWER(name)) k
        FROM sites WHERE status='active' AND COALESCE(business_book_id,0)=0
    )
  `)?.c);
  const orderBook = num(safeGet(db, `
    SELECT COALESCE(SUM(total_amount),0) c FROM purchase_orders WHERE status NOT IN ('completed','rejected')
  `)?.c);
  const orderBookCount = num(safeGet(db, `SELECT COUNT(*) c FROM purchase_orders WHERE status NOT IN ('completed','rejected')`)?.c);

  const monthStart = new Date(); monthStart.setDate(1);
  const monthStartIso = monthStart.toISOString().slice(0, 10);
  const revenueMTD = num(safeGet(db, `
    SELECT COALESCE(SUM(total_amount), 0) c FROM sales_bills WHERE date(bill_date) >= ?
  `, monthStartIso)?.c);

  const openSnags = num(safeGet(db, `SELECT COUNT(*) c FROM snags WHERE status='open'`)?.c);
  const oldestSnag = safeGet(db, `
    SELECT julianday('now') - julianday(raised_at) days
    FROM snags WHERE status='open' ORDER BY raised_at ASC LIMIT 1
  `);
  const oldestSnagDays = oldestSnag ? Math.round(oldestSnag.days) : null;

  // DPR adherence today = sites with DPR today / active sites
  const dprToday = num(safeGet(db, `SELECT COUNT(DISTINCT site_id) c FROM dpr WHERE report_date=?`, today)?.c);
  const dprAdherencePct = activeSites > 0 ? Math.round((dprToday / activeSites) * 100) : null;

  // CCC components
  const salesWin = num(safeGet(db, `SELECT COALESCE(SUM(total_amount),0) c FROM sales_bills WHERE date(bill_date) >= ?`, from)?.c);
  const purchasesWin = num(safeGet(db, `SELECT COALESCE(SUM(total_amount),0) c FROM purchase_bills WHERE date(bill_date) >= ?`, from)?.c);
  const arOutstanding = num(safeGet(db, `SELECT COALESCE(SUM(outstanding_amount),0) c FROM receivables`)?.c);
  const apOutstanding = num(safeGet(db, `
    SELECT COALESCE(SUM(total_amount - COALESCE(received_amount, 0)),0) c FROM purchase_bills
    WHERE payment_status IN ('pending','partial')
  `)?.c);
  const dso = salesWin > 0 ? Math.round((arOutstanding / salesWin) * days) : null;
  const dpo = purchasesWin > 0 ? Math.round((apOutstanding / purchasesWin) * days) : null;
  const inventoryTotal = num(safeGet(db, `
    SELECT COALESCE(SUM(quantity * avg_rate), 0) c FROM stock_balance WHERE quantity > 0
  `)?.c);
  const dio = purchasesWin > 0 ? Math.round((inventoryTotal / purchasesWin) * days) : null;
  const ccc = (dso != null && dio != null && dpo != null) ? (dso + dio - dpo) : null;

  // Inventory split
  const inventoryFree = num(safeGet(db, `
    SELECT COALESCE(SUM(s.quantity * s.avg_rate), 0) c
    FROM stock_balance s JOIN warehouses w ON s.warehouse_id = w.id
    WHERE w.type = 'office' AND s.quantity > 0
  `)?.c);
  const inventoryReserved = num(safeGet(db, `
    SELECT COALESCE(SUM(s.quantity * s.avg_rate), 0) c
    FROM stock_balance s JOIN warehouses w ON s.warehouse_id = w.id
    WHERE w.type = 'site_store' AND s.quantity > 0
  `)?.c);
  // Slow / dead: based on last movement.  If stock_movements has rows
  // older than 180/365 days for an item, the remaining balance is
  // considered slow/dead.  Best-effort proxy until a proper aging job.
  const slowMoving = num(safeGet(db, `
    SELECT COALESCE(SUM(s.quantity * s.avg_rate), 0) c
    FROM stock_balance s
    WHERE s.quantity > 0
      AND NOT EXISTS (
        SELECT 1 FROM stock_movements m
        WHERE m.item_master_id = s.item_master_id
          AND date(m.created_at) >= date('now', '-180 days')
      )
  `)?.c);
  const deadStock = num(safeGet(db, `
    SELECT COALESCE(SUM(s.quantity * s.avg_rate), 0) c
    FROM stock_balance s
    WHERE s.quantity > 0
      AND NOT EXISTS (
        SELECT 1 FROM stock_movements m
        WHERE m.item_master_id = s.item_master_id
          AND date(m.created_at) >= date('now', '-365 days')
      )
  `)?.c);

  // WIP locked = sum of PO totals where status='in_progress' minus billed
  const wipBookValue = num(safeGet(db, `
    SELECT COALESCE(SUM(total_amount), 0) c FROM purchase_orders WHERE status='in_progress'
  `)?.c);
  const wipBilled = num(safeGet(db, `
    SELECT COALESCE(SUM(sb.total_amount), 0) c FROM sales_bills sb
    JOIN purchase_orders po ON sb.po_id = po.id WHERE po.status='in_progress'
  `)?.c);

  // ── AR / Cash ──────────────────────────────────────────────────
  const arAging = {
    bucket_0_30:    num(safeGet(db, `SELECT COALESCE(SUM(outstanding_amount),0) c FROM receivables WHERE ageing_bucket='0-30'`)?.c),
    bucket_31_60:   num(safeGet(db, `SELECT COALESCE(SUM(outstanding_amount),0) c FROM receivables WHERE ageing_bucket='31-60'`)?.c),
    bucket_61_90:   num(safeGet(db, `SELECT COALESCE(SUM(outstanding_amount),0) c FROM receivables WHERE ageing_bucket='61-90'`)?.c),
    bucket_90_plus: num(safeGet(db, `SELECT COALESCE(SUM(outstanding_amount),0) c FROM receivables WHERE ageing_bucket='90+'`)?.c),
  };
  const topDebtorsRaw = safeAll(db, `
    SELECT id, client_name, project_name, invoice_number,
           outstanding_amount amt, ageing_days days, follow_up_status status, owner_id
    FROM receivables
    WHERE outstanding_amount > 0
    ORDER BY outstanding_amount DESC LIMIT 5
  `);
  // Mam (2026-05-30 audit): derive the "Action today" column per
  // debtor live from days-overdue instead of hardcoding it in the
  // TOC view JSX.  Buckets: 90+ legal · 60-89 CEO call · 30-59 site
  // visit · <30 follow-up.
  const topDebtors = topDebtorsRaw.map(d => ({
    ...d,
    action_today: (d.days ?? 0) > 90 ? 'Legal notice today'
                : (d.days ?? 0) > 60 ? 'CEO call today'
                : (d.days ?? 0) > 30 ? 'Site visit today'
                : 'Follow-up email today',
  }));

  // 30-day cash forecast — naive: bank + expected receipts (AR within
  // due_date) − expected dues.  Returned as a 30-point series for chart.
  const cashForecast = [];
  let runningCash = cashOnHand;
  for (let i = 0; i <= 30; i += 2) {
    const dateIso = (() => { const d = new Date(); d.setDate(d.getDate() + i); return d.toISOString().slice(0,10); })();
    const expectIn = num(safeGet(db, `
      SELECT COALESCE(SUM(outstanding_amount),0) c FROM receivables
      WHERE date(due_date) <= ? AND date(due_date) > date('now', '-1 day')
    `, dateIso)?.c);
    const expectOut = num(safeGet(db, `
      SELECT COALESCE(SUM(total_amount - COALESCE(received_amount,0)),0) c FROM purchase_bills
      WHERE payment_status IN ('pending','partial')
        AND date(bill_date, '+30 days') <= ?
    `, dateIso)?.c);
    cashForecast.push({ day: `D${i}`, no_action: Math.round((cashOnHand - expectOut * i / 30) / 100000), with_actions: Math.round((cashOnHand + expectIn * 0.6 - expectOut * 0.4) / 100000) });
  }

  // Statutory dues — mam (2026-05-30 audit): "audit all this i need
  // to live data".  Used to be 4 hardcoded {amount: null} rows.  Now
  // pulled live from the statutory_dues_calendar table; each row
  // resolves to "GST due 20-Jun" using the current month + the
  // configured due_day.  Status reds when within 7 days of the date.
  const _monthShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const _todayD = new Date();
  const _thisMonth = _todayD.getMonth();
  const _thisYear = _todayD.getFullYear();
  const statRows = safeAll(db,
    `SELECT label, due_day, amount FROM statutory_dues_calendar
      WHERE active = 1 ORDER BY due_day, label`);
  const statutoryDues = [
    ...statRows.map(r => {
      // due_date for current month; if already past, surface NEXT month's
      const dueThis = new Date(_thisYear, _thisMonth, r.due_day);
      const dueNext = dueThis < _todayD
        ? new Date(_thisYear, _thisMonth + 1, r.due_day)
        : dueThis;
      const daysOut = Math.round((dueNext - _todayD) / 86400000);
      const status = daysOut <= 3 ? 'red' : daysOut <= 10 ? 'amber' : 'green';
      return {
        label: `${r.label} due ${r.due_day}-${_monthShort[dueNext.getMonth()]}`,
        amount: r.amount > 0 ? r.amount : null,
        status,
        // Surface days_out so the UI can show "in 3 days" for context.
        days_out: daysOut,
        unconfigured: r.amount <= 0,
      };
    }),
    { label: 'Vendor AP 30d', amount: dues30, status: dues30 > 0 ? 'amber' : 'green' },
    { label: 'Bank closing',  amount: cashOnHand, status: cashOnHand > 1000000 ? 'green' : 'amber' },
  ];

  // ── Funnel + Sales ─────────────────────────────────────────────
  // Leads / qualified / won counts in the window — sourced from the LIVE
  // Sales Funnel (sales_funnel, 11-stage), NOT the legacy `leads` table.
  // Mam (2026-05-30): the War Room showed "1 leads" because it counted the
  // near-empty legacy `leads` table instead of the real funnel. "won" here
  // = funnel deals reaching contract_signed / won.
  const WON_STAGES = "('contract_signed','won')";
  const leadsCount = num(safeGet(db, `SELECT COUNT(*) c FROM sales_funnel WHERE date(created_at) >= ?`, from)?.c);
  const qualifiedCount = num(safeGet(db, `SELECT COUNT(*) c FROM sales_funnel WHERE date(created_at) >= ? AND is_qualified = 1`, from)?.c);
  const wonCount = num(safeGet(db, `SELECT COUNT(*) c FROM sales_funnel WHERE date(created_at) >= ? AND current_stage IN ${WON_STAGES}`, from)?.c);
  const quotedCount = num(safeGet(db, `SELECT COUNT(*) c FROM quotations WHERE date(created_at) >= ?`, from)?.c);
  const negotiationCount = num(safeGet(db, `SELECT COUNT(*) c FROM crm_funnel WHERE date(created_at) >= ? AND quotation_submitted = 1 AND (final_status IS NULL OR final_status='')`, from)?.c);
  const billedCount = num(safeGet(db, `SELECT COUNT(*) c FROM sales_bills WHERE date(bill_date) >= ?`, from)?.c);
  const collectedCount = num(safeGet(db, `SELECT COUNT(*) c FROM sales_bills WHERE date(bill_date) >= ? AND payment_status='paid'`, from)?.c);
  const funnel = {
    leads: leadsCount,
    qualified: qualifiedCount,  // live sales_funnel.is_qualified count
    quoted: quotedCount,
    pos: num(safeGet(db, `SELECT COUNT(*) c FROM purchase_orders WHERE date(created_at) >= ?`, from)?.c),
    in_execution: num(safeGet(db, `SELECT COUNT(*) c FROM purchase_orders WHERE status='in_progress'`)?.c),
    billed: billedCount,
    collected: collectedCount,
  };

  // Quote lead time
  const quoteLT = safeAll(db, `
    SELECT (julianday(q.created_at) - julianday(l.created_at)) days
    FROM leads l JOIN quotations q ON q.lead_id = l.id
    WHERE l.created_at IS NOT NULL AND q.created_at IS NOT NULL
      AND date(q.created_at) >= ?
  `, from).map(r => r.days).filter(x => x != null && x >= 0);
  const qltSorted = [...quoteLT].sort((a, b) => a - b);
  const median = qltSorted.length ? qltSorted[Math.floor(qltSorted.length / 2)] : null;
  const p90 = qltSorted.length ? qltSorted[Math.floor(qltSorted.length * 0.9)] : null;
  const withinSla = qltSorted.length ? qltSorted.filter(x => x <= 4).length : 0;
  const quoteLeadTime = {
    avg: qltSorted.length ? Math.round((qltSorted.reduce((a, b) => a + b, 0) / qltSorted.length) * 10) / 10 : null,
    median: median != null ? Math.round(median * 10) / 10 : null,
    p90: p90 != null ? Math.round(p90 * 10) / 10 : null,
    within_sla_pct: qltSorted.length ? Math.round((withinSla / qltSorted.length) * 100) : null,
    sample_size: qltSorted.length,
    distribution: [
      { bucket: '0-2d',   count: qltSorted.filter(x => x <= 2).length },
      { bucket: '3-4d',   count: qltSorted.filter(x => x > 2 && x <= 4).length },
      { bucket: '5-7d',   count: qltSorted.filter(x => x > 4 && x <= 7).length },
      { bucket: '8-14d',  count: qltSorted.filter(x => x > 7 && x <= 14).length },
      { bucket: '15-21d', count: qltSorted.filter(x => x > 14 && x <= 21).length },
      { bucket: '22d+',   count: qltSorted.filter(x => x > 21).length },
    ],
  };

  // Quote-loss reasons — from sales_funnel.lost_reason / crm_funnel.loss_reason
  const lossReasons = safeAll(db, `
    SELECT loss_reason reason, COUNT(*) c FROM crm_funnel
    WHERE final_status='loss' AND loss_reason IS NOT NULL
    GROUP BY loss_reason ORDER BY c DESC LIMIT 10
  `);

  // Pending quotes — quotations not yet linked to a PO
  const pendingQuotes = safeAll(db, `
    SELECT q.id, q.quotation_number, q.created_at,
           COALESCE(c.company_name, l.contact_person, l.company_name) client,
           q.final_amount value,
           CAST(julianday('now') - julianday(q.created_at) AS INTEGER) days_open
    FROM quotations q
    LEFT JOIN leads l ON q.lead_id = l.id
    -- Mam (2026-05-30 audit): try a name-match against customers so a
    -- lead that's been converted shows the canonical company name.
    -- (No FK between leads and customers, so fall through to the lead
    -- when no name match is found — the COALESCE handles both.)
    LEFT JOIN customers c ON LOWER(TRIM(c.company_name)) = LOWER(TRIM(l.company_name))
    WHERE NOT EXISTS (SELECT 1 FROM purchase_orders po WHERE po.quotation_id = q.id)
      AND q.status NOT IN ('rejected', 'won')
    ORDER BY q.created_at ASC LIMIT 8
  `);

  // Conversion by source — from the LIVE sales_funnel (source text column),
  // won = stage reached contract_signed / won.
  const conversionBySource = safeAll(db, `
    SELECT COALESCE(NULLIF(TRIM(source),''),'Unknown') source,
           COUNT(*) total,
           SUM(CASE WHEN current_stage IN ${WON_STAGES} THEN 1 ELSE 0 END) won
    FROM sales_funnel
    WHERE date(created_at) >= ?
    GROUP BY COALESCE(NULLIF(TRIM(source),''),'Unknown') HAVING total > 0
    ORDER BY (1.0 * won / total) DESC
  `, from).map(r => ({
    source: r.source, total: r.total, won: r.won,
    conversion_pct: r.total > 0 ? Math.round((r.won / r.total) * 100) : 0,
  }));

  // ── Booking trend by week (last 12 weeks, by category MEPF/Solar) ──
  const bookingTrend = [];
  for (let w = 11; w >= 0; w--) {
    const wStart = (() => { const d = new Date(); d.setDate(d.getDate() - (w + 1) * 7); return d.toISOString().slice(0,10); })();
    const wEnd = (() => { const d = new Date(); d.setDate(d.getDate() - w * 7); return d.toISOString().slice(0,10); })();
    const mepf = num(safeGet(db, `
      SELECT COALESCE(SUM(po_amount), 0) c FROM business_book
      WHERE date(po_date) >= ? AND date(po_date) < ?
        AND (LOWER(category) LIKE '%mepf%' OR LOWER(category) LIKE '%mep%' OR LOWER(category) LIKE '%fire%' OR LOWER(category) LIKE '%hvac%' OR LOWER(category) LIKE '%plumbing%' OR LOWER(category) LIKE '%electrical%')
    `, wStart, wEnd)?.c);
    const solar = num(safeGet(db, `
      SELECT COALESCE(SUM(po_amount), 0) c FROM business_book
      WHERE date(po_date) >= ? AND date(po_date) < ?
        AND LOWER(category) LIKE '%solar%'
    `, wStart, wEnd)?.c);
    bookingTrend.push({ week: `W-${w}`, mepf: Math.round(mepf / 100000), solar: Math.round(solar / 100000) });
  }

  // Top 5 customers by order book share
  const topCustomers = safeAll(db, `
    SELECT bb.client_name client,
           bb.company_name company,
           COALESCE(SUM(bb.po_amount), 0) total_order
    FROM business_book bb
    WHERE bb.po_amount > 0
    GROUP BY bb.client_name, bb.company_name
    ORDER BY total_order DESC LIMIT 5
  `);
  const totalOrderBookSum = topCustomers.reduce((s, r) => s + num(r.total_order), 0) + 1;
  topCustomers.forEach(r => { r.share_pct = Math.round((num(r.total_order) / totalOrderBookSum) * 100); });

  // Pipeline by stage (PO statuses)
  const pipelineByStage = safeAll(db, `
    SELECT status stage, COUNT(*) cnt, COALESCE(SUM(total_amount), 0) value
    FROM purchase_orders GROUP BY status ORDER BY value DESC
  `);

  // ── Vertical mix from business_book.category ───────────────────
  const verticalMix = safeAll(db, `
    SELECT category, COUNT(*) cnt, COALESCE(SUM(po_amount), 0) value
    FROM business_book WHERE po_amount > 0
    GROUP BY category ORDER BY value DESC LIMIT 6
  `);

  // Lead source mix — live sales_funnel.source
  const leadSourceMix = safeAll(db, `
    SELECT COALESCE(NULLIF(TRIM(source),''),'Unknown') source, COUNT(*) cnt
    FROM sales_funnel
    WHERE date(created_at) >= ?
    GROUP BY COALESCE(NULLIF(TRIM(source),''),'Unknown') ORDER BY cnt DESC
  `, from);

  // ── Site execution ────────────────────────────────────────────
  const snagsByPriority = safeAll(db, `
    SELECT priority, COUNT(*) cnt FROM snags WHERE status='open' GROUP BY priority
  `);
  const snagAging = [
    { bucket: '0-3d',   count: num(safeGet(db, `SELECT COUNT(*) c FROM snags WHERE status='open' AND julianday('now') - julianday(raised_at) <= 3`)?.c) },
    { bucket: '4-7d',   count: num(safeGet(db, `SELECT COUNT(*) c FROM snags WHERE status='open' AND julianday('now') - julianday(raised_at) > 3 AND julianday('now') - julianday(raised_at) <= 7`)?.c) },
    { bucket: '8-14d',  count: num(safeGet(db, `SELECT COUNT(*) c FROM snags WHERE status='open' AND julianday('now') - julianday(raised_at) > 7 AND julianday('now') - julianday(raised_at) <= 14`)?.c) },
    { bucket: '15-21d', count: num(safeGet(db, `SELECT COUNT(*) c FROM snags WHERE status='open' AND julianday('now') - julianday(raised_at) > 14 AND julianday('now') - julianday(raised_at) <= 21`)?.c) },
    { bucket: '>21d',   count: num(safeGet(db, `SELECT COUNT(*) c FROM snags WHERE status='open' AND julianday('now') - julianday(raised_at) > 21`)?.c) },
  ];

  // DPR adherence today
  const dprStatus = {
    on_time: dprToday,
    late: 0,
    missed: Math.max(0, activeSites - dprToday),
    total_sites: activeSites,
    adherence_pct: dprAdherencePct,
  };

  // On-time milestone proxy (DPR overall_status)
  const dprMilestoneStats = safeAll(db, `
    SELECT overall_status status, COUNT(*) c FROM dpr WHERE date(report_date) >= ? GROUP BY overall_status
  `, from);
  const dprTotal2 = dprMilestoneStats.reduce((s, r) => s + r.c, 0);
  const onTimePct = dprTotal2 > 0
    ? Math.round((dprMilestoneStats.find(r => r.status === 'on_track')?.c || 0) / dprTotal2 * 100)
    : null;

  // Sites past target close date (committed_completion_date < today, PO still in_progress)
  const sitesPastTarget = safeAll(db, `
    SELECT po.id, po.po_number project, bb.client_name client,
           CAST(julianday('now') - julianday(bb.committed_completion_date) AS INTEGER) slip_days,
           po.total_amount value
    FROM purchase_orders po
    JOIN business_book bb ON po.business_book_id = bb.id
    WHERE po.status = 'in_progress'
      AND bb.committed_completion_date IS NOT NULL
      AND date(bb.committed_completion_date) < date('now')
    ORDER BY slip_days DESC LIMIT 8
  `);

  // ── Procurement ───────────────────────────────────────────────
  const topVendors = safeAll(db, `
    SELECT v.id, v.name,
           COUNT(pb.id) bill_count,
           COALESCE(SUM(pb.total_amount), 0) total_spend,
           AVG(CASE WHEN pb.payment_status='paid' THEN 1.0 ELSE 0 END) * 100 paid_pct
    FROM vendors v
    LEFT JOIN purchase_bills pb ON pb.vendor_id = v.id
      AND date(pb.created_at) >= ?
    GROUP BY v.id, v.name HAVING bill_count > 0
    ORDER BY total_spend DESC LIMIT 5
  `, from);

  // ── PO vs Sales Bill (mam 2026-06-26): per Vendor PO made in Indent-to-
  // Dispatch, compare what we COMMITTED to the vendor (vendor_pos.total_amount,
  // the cost side) against what we BILLED THE CLIENT for that PO (the sale
  // side). The client sale figure is the actual Sales Bill raised against the
  // PO in Dispatch & Receiving — a delivery_notes row of document_type
  // 'sales_bill' (generated bill, value in grand_total_amount), or, if only an
  // external bill number was uploaded onto the challan, that challan's value.
  // Same "sales-billed" definition the Dispatch tab uses (doc='sales_bill' OR
  // sales_bill_number present). Gap = sale − cost (the margin recovered so far;
  // negative or zero where the PO is not yet sales-billed).
  const pvsRaw = safeAll(db, `
    SELECT vp.id, vp.po_number, vp.total_amount AS po_cost,
           COALESCE(vp.po_date, vp.created_at) AS po_date,
           vp.indent_id AS indent_id,
           v.name AS vendor_name, i.indent_number, i.site_name,
           COALESCE(SUM(CASE WHEN dn.document_type='sales_bill'
                             THEN dn.grand_total_amount ELSE 0 END), 0) AS sb_generated,
           COALESCE(SUM(CASE WHEN dn.document_type='challan' AND dn.sales_bill_number IS NOT NULL
                             THEN dn.grand_total_amount ELSE 0 END), 0) AS sb_uploaded
      FROM vendor_pos vp
      LEFT JOIN vendors v        ON v.id = vp.vendor_id
      LEFT JOIN indents i        ON i.id = vp.indent_id
      LEFT JOIN delivery_notes dn ON dn.vendor_po_id = vp.id
     WHERE COALESCE(vp.cancelled, 0) = 0
       AND date(COALESCE(vp.po_date, vp.created_at)) >= ?
     GROUP BY vp.id
     ORDER BY date(COALESCE(vp.po_date, vp.created_at)) DESC, vp.id DESC
     LIMIT 200
  `, from);

  // Expected client SALE for THIS Vendor PO = Σ (its own purchased line qty ×
  // BOQ sale rate) (mam 2026-06-26: "Vendor PO qty (item only po) * billable
  // rate"). Authoritative source = vendor_po_items — the lines actually on
  // this PO — joined to the indent line's priced BOQ po_item for the SALE
  // rate. Keyed by vendor_po_id so each PO gets ONLY its own slice: one indent
  // split across several Vendor POs no longer repeats (and double-counts in the
  // totals) the whole-indent budget on every row. vpi.quantity = the qty on
  // the PO; poi.rate = the client BOQ sale rate; PO-type lines only.
  const budgetByPo = new Map();   // vendor_po_id → this PO's sales budget
  const poIds = pvsRaw.map(r => r.id);
  if (poIds.length) {
    const ph = poIds.map(() => '?').join(',');
    for (const b of safeAll(db, `
      SELECT vpi.vendor_po_id AS po_id,
             SUM(COALESCE(vpi.quantity, 0) * COALESCE(poi.rate, 0)) AS budget
        FROM vendor_po_items vpi
        JOIN indent_items ii ON ii.id = vpi.indent_item_id
        JOIN po_items poi    ON poi.id = ii.po_item_id
       WHERE vpi.vendor_po_id IN (${ph})
         AND UPPER(COALESCE(ii.item_type, '')) = 'PO'
       GROUP BY vpi.vendor_po_id
    `, ...poIds)) {
      budgetByPo.set(b.po_id, num(b.budget));
    }
  }

  const pvsRows = pvsRaw.map(r => {
    const cost = num(r.po_cost);
    // Actual Dispatch sales bill (generated value, else uploaded-bill value) —
    // drives the BILLED / NOT BILLED status only.
    const actualSale = num(r.sb_generated) > 0 ? num(r.sb_generated) : num(r.sb_uploaded);
    // Displayed Sales Bill amount = THIS Vendor PO's own sales budget
    // (its purchased line qty × BOQ sale rate), keyed by vendor_po_id.
    const expected = budgetByPo.get(r.id) || 0;
    const gap = expected - cost;
    return {
      po_id: r.id, po_number: r.po_number, po_date: r.po_date,
      indent_id: r.indent_id || null,
      vendor: r.vendor_name || '—', indent_number: r.indent_number || null,
      site: r.site_name || '—',
      // gap == Throughput (Sales − Purchase). margin_pct = throughput on COST;
      // cash_positive_pct = throughput on SALE (mam 2026-06-26: "cash positive
      // = (sales bill − purchase)/sales bill × 100").
      po_cost: cost, sales_bill: expected, gap,
      margin_pct: cost > 0 ? Math.round((gap / cost) * 1000) / 10 : null,
      cash_positive_pct: expected > 0 ? Math.round((gap / expected) * 1000) / 10 : null,
      billed: actualSale > 0,
    };
  });
  const pvsTotals = pvsRows.reduce((t, r) => {
    t.po_cost += r.po_cost; t.sales_bill += r.sales_bill;
    t.po_count += 1; if (r.billed) t.billed_count += 1;
    return t;
  }, { po_cost: 0, sales_bill: 0, gap: 0, po_count: 0, billed_count: 0 });
  pvsTotals.gap = pvsTotals.sales_bill - pvsTotals.po_cost;     // Throughput
  pvsTotals.cash_positive_pct = pvsTotals.sales_bill > 0
    ? Math.round((pvsTotals.gap / pvsTotals.sales_bill) * 1000) / 10 : null;
  pvsTotals.billed_pct = pvsTotals.po_cost > 0
    ? Math.round((pvsTotals.sales_bill / pvsTotals.po_cost) * 1000) / 10 : null;

  // ── People ────────────────────────────────────────────────────
  const headcount = safeAll(db, `
    SELECT department, COUNT(*) cnt
    FROM employees WHERE status='active' AND department IS NOT NULL
    GROUP BY department ORDER BY cnt DESC
  `);
  const activeFte = num(safeGet(db, `SELECT COUNT(*) c FROM employees WHERE status='active'`)?.c);
  const revPerFte = activeFte > 0 ? Math.round(salesWin / activeFte) : null;
  const revPerFteByDept = headcount.map(d => ({
    department: d.department,
    fte: d.cnt,
    rev_per_fte: d.cnt > 0 ? Math.round(salesWin / d.cnt) : null,
  }));

  // Attendance today — counts from attendance table
  const attTodayPresent = num(safeGet(db, `SELECT COUNT(*) c FROM attendance WHERE date=? AND status IN ('present','late','half_day','short_day')`, today)?.c);
  const attTodayLate = num(safeGet(db, `SELECT COUNT(*) c FROM attendance WHERE date=? AND status='late'`, today)?.c);
  const attTodayLeave = num(safeGet(db, `SELECT COUNT(*) c FROM leave_requests WHERE status='approved' AND date(start_date) <= ? AND date(end_date) >= ?`, today, today)?.c);
  const attTodayAbsent = Math.max(0, activeFte - attTodayPresent - attTodayLeave);

  // KPI top/bottom — best-effort from score_entries.  If empty, returns null.
  const kpiEntries = safeAll(db, `
    SELECT u.id user_id, u.name user_name,
           AVG(se.score) avg_score, COUNT(*) entry_count
    FROM score_entries se
    JOIN users u ON se.user_id = u.id
    WHERE date(se.entry_date) >= date('now', '-30 days')
    GROUP BY u.id, u.name
    HAVING entry_count >= 2
    ORDER BY avg_score DESC
  `);
  const kpiTop = kpiEntries.slice(0, 3).map(r => ({
    user: r.user_name, pct: Math.round(r.avg_score),
  }));
  const kpiBottom = kpiEntries.slice(-3).reverse().map(r => ({
    user: r.user_name, pct: Math.round(r.avg_score),
  }));

  // ── Customer voice ─────────────────────────────────────────────
  const complaintsByPriority = safeAll(db, `
    SELECT priority, COUNT(*) cnt FROM complaints
    WHERE status NOT IN ('resolved', 'closed')
    GROUP BY priority
  `);

  // Predictive flags — simple rule-based, returns top 6
  const predictiveFlags = [];
  // Slip risk: sites with committed_completion_date < today + 14 and DPR shows delayed/blocked
  safeAll(db, `
    SELECT po.po_number ref, bb.client_name client,
           CAST(julianday(bb.committed_completion_date) - julianday('now') AS INTEGER) due_in,
           bb.po_amount value
    FROM purchase_orders po JOIN business_book bb ON po.business_book_id = bb.id
    WHERE po.status='in_progress'
      AND bb.committed_completion_date IS NOT NULL
      AND date(bb.committed_completion_date) BETWEEN date('now') AND date('now', '+14 days')
    ORDER BY due_in ASC LIMIT 3
  `).forEach(r => predictiveFlags.push({
    kind: 'slip_risk', label: `${r.ref} slip risk · ${r.client}`,
    severity: r.due_in <= 7 ? 'red' : 'amber',
    detail: `due in ${r.due_in}d · ₹${Math.round(r.value/100000)}L`,
  }));
  safeAll(db, `
    SELECT client_name, SUM(outstanding_amount) total FROM receivables
    WHERE ageing_bucket='90+' GROUP BY client_name ORDER BY total DESC LIMIT 2
  `).forEach(r => predictiveFlags.push({
    kind: 'churn_risk', label: `${r.client_name} churn risk`,
    severity: 'red', detail: `90+ overdue ₹${Math.round(num(r.total)/100000)}L`,
  }));
  // Cash gap risk
  if (cashOnHand < dues30) {
    predictiveFlags.push({
      kind: 'cash_gap', label: 'Cash gap next 30d',
      severity: 'red',
      detail: `₹${Math.round((dues30 - cashOnHand)/100000)}L short`,
    });
  }

  // ── Junk-PO list (Stage 1 escalation banner) ───────────────────
  // A PO number is "junk" if it's a known dummy, blank, or implausibly
  // short (< 10 chars). Mam (2026-05-30): "if po number junk then check."
  // The COUNT + total now scan ALL junk rows (not just the 5 displayed),
  // so the escalation banner shows the true count and ₹ affected.
  const junkWhere = `po_number IS NOT NULL
      AND (TRIM(po_number) = ''
           OR po_number IN ('5252525','141414','1111111111','00','0','1234567890')
           OR length(TRIM(po_number)) < 10)`;
  const junkPos = safeAll(db, `
    SELECT lead_no, client_name, po_number, po_amount FROM business_book
    WHERE ${junkWhere}
    ORDER BY po_amount DESC LIMIT 10
  `);
  const junkAgg = safeGet(db, `
    SELECT COUNT(*) c, COALESCE(SUM(po_amount), 0) total FROM business_book
    WHERE ${junkWhere}
  `);
  const junkPoCount = num(junkAgg?.c);
  const junkPoTotal = num(junkAgg?.total);

  // ── Cost-of-inaction estimate ──────────────────────────────────
  const costOfInactionDaily = Math.round(
    (arAging.bucket_90_plus * 0.001)  // 0.1% per day on stale AR
    + (slowMoving * 0.0005)            // 0.05% per day on slow stock
    + (dues30 > cashOnHand ? (dues30 - cashOnHand) * 0.0003 : 0)  // 0.03% on cash gap
  );

  // ── Live counts that War Room COO view used to show as "—" ───────
  // Mam (2026-05-30 audit): Material-in-Transit and Tools-Out tiles
  // were rendering literal em-dashes.  Now sourced live.
  const materialsInTransit = num(safeGet(db, `
    SELECT COUNT(*) c FROM indents WHERE status IN ('po_sent','dispatched')
  `)?.c);
  const toolsOut = num(safeGet(db, `
    SELECT COUNT(*) c FROM tools WHERE status='in_use'
  `)?.c);

  // ── IT systems status (sentry, etc.) ─────────────────────────────
  // Mam (2026-05-30 audit): War Room "Systems" traffic light used to
  // be hardcoded amber.  Live boolean now: green if Sentry DSN is
  // configured in app_settings, amber otherwise.
  const sentryDsn = safeGet(db, `SELECT value FROM app_settings WHERE key='sentry_dsn'`);
  const itStatus = {
    sentry_active: !!(sentryDsn && sentryDsn.value && String(sentryDsn.value).trim().length > 0),
  };

  return {
    spec_version: 'v3',
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    window: { from, to: today, days },

    pulse: {
      bank_balance: cashOnHand,
      free_cash: freeCash,
      runway_days: runwayDays,
      order_book: orderBook,
      order_book_count: orderBookCount,
      revenue_mtd: revenueMTD,
      ebitda_ytd_pct: null,    // data gap: cost-of-goods not categorized
      dpr_adherence_pct: dprAdherencePct,
      open_snags: openSnags,
      oldest_snag_days: oldestSnagDays,
      solar_kw_live: null,     // data gap: no plant performance table
      safety_days_lti: null,   // data gap: no incident tracking
      ccc, dso, dio, dpo,
      free_inventory: inventoryFree,
      wip_locked: wipBookValue,
      wip_unbilled: wipBookValue - wipBilled,
      revenue_per_fte_monthly: revPerFte != null ? Math.round(revPerFte / (days / 30)) : null,
      quote_lead_time_avg: quoteLeadTime.avg,
      lead_to_po_pct: leadsCount > 0 ? Math.round((wonCount / leadsCount) * 1000) / 10 : null,
    },

    cash: {
      bank: bank || null,
      ar_outstanding: arOutstanding,
      ar_aging: arAging,
      ap_outstanding: apOutstanding,
      top_5_debtors: topDebtors,
      statutory_dues: statutoryDues,
      cash_forecast_30d: cashForecast,
      cost_of_inaction_daily: costOfInactionDaily,
    },

    sales: {
      funnel,
      vertical_mix: verticalMix,
      lead_source_mix: leadSourceMix,
      booking_trend_12w: bookingTrend,
      top_customers: topCustomers,
      pipeline_by_stage: pipelineByStage,
      quote_lead_time: quoteLeadTime,
      loss_reasons: lossReasons,
      pending_quotes: pendingQuotes,
      conversion_by_source: conversionBySource,
    },

    operations: {
      active_sites: activeSites,
      snags_by_priority: snagsByPriority,
      snag_aging: snagAging,
      dpr: dprStatus,
      on_time_milestone_pct: onTimePct,
      sites_past_target: sitesPastTarget,
      materials_in_transit: materialsInTransit,
      tools_out: toolsOut,
    },

    it: itStatus,

    inventory: {
      total: inventoryTotal,
      free_to_use: inventoryFree,
      reserved: inventoryReserved,
      slow_moving: slowMoving,
      dead_stock: deadStock,
    },

    procurement: {
      top_vendors: topVendors,
      po_vs_sales_bill: { rows: pvsRows, totals: pvsTotals },
    },

    people: {
      active_fte: activeFte,
      headcount,
      revenue_per_fte_window: revPerFte,
      revenue_per_fte_by_dept: revPerFteByDept,
      attendance_today: {
        present: attTodayPresent, late: attTodayLate,
        leave: attTodayLeave, absent: attTodayAbsent, total: activeFte,
      },
      kpi_top: kpiTop,
      kpi_bottom: kpiBottom,
    },

    customer: {
      complaints_by_priority: complaintsByPriority,
      predictive_flags: predictiveFlags,
    },

    data_quality: {
      junk_pos: junkPos,
      junk_po_count: junkPoCount,
      junk_po_total: junkPoTotal,
    },
  };
}

module.exports = { computeCmdDetail };
