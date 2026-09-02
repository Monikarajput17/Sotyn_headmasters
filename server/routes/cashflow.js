const express = require('express');
const pg = require('../db/pg');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Recompute opening/closing for `fromDate` and EVERY later day so a back-dated
// entry (or a delete) cascades forward. opening[fromDate] = closing of the most
// recent day before it; each later opening = the prior day's closing; closing =
// opening + inflows − outflows. Fixes "yesterday's closing ≠ today's opening"
// when entries are added/removed on a past date (mam 2026-07-01).
async function recalcCashFlowFrom(db, fromDate) {
  const prev = await db.get('SELECT closing_balance FROM cash_flow_daily WHERE date < ? ORDER BY date DESC LIMIT 1', fromDate);
  let prevClosing = prev ? prev.closing_balance : null;
  const rows = await db.all('SELECT id, opening_balance, COALESCE(total_inflows,0) AS inflows, COALESCE(total_outflows,0) AS outflows FROM cash_flow_daily WHERE date >= ? ORDER BY date ASC', fromDate);
  await db.tx(async (t) => {
    for (const r of rows) {
      const opening = prevClosing == null ? (r.opening_balance || 0) : prevClosing;
      const closing = opening + r.inflows - r.outflows;
      await t.run('UPDATE cash_flow_daily SET opening_balance = ?, closing_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', opening, closing, r.id);
      prevClosing = closing;
    }
  });
}

// One-time repair (guarded): re-chain the running balance from a FIXED ANCHOR
// date forward. Idempotent — runs once.
//
// Mam (2026-07-02): "correct the calculation from 24 June 2026 records."
// The ledger STARTS at 24-Jun with opening 0 (her formula: 24-Jun closing =
// inflows − outflows, no carried opening — 14,30,000 − 13,99,507 = 30,493).
// From there every later day's opening = the prior day's closing. Days before
// 24-Jun are left untouched. The old prod chain double-counted (26-Jun opening
// was 24-Jun close + 25-Jun close = 48,081.6 instead of 25-Jun close 17,588.6).
//
// Steps, run ONCE on deploy:
//   0. Make sure a daily row exists for every entry-date from the anchor on —
//      TA/DA and other payments loaded by a direct import can create entries
//      without the daily row the cascade walks over (e.g. the 25-Jun outflows).
//   1. Re-sum each day's inflows/outflows straight from cash_flow_entries so the
//      totals match the actual records (the Add-Entry form is the only path that
//      otherwise maintains them).
//   2. Cascade forward from opening 0 on the anchor: 24-Jun close = 0 + in − out;
//      25-Jun open = 24-Jun close; 26-Jun open = 25-Jun close … through to today.
(async () => {
  try {
    // app_settings CREATE TABLE IF NOT EXISTS dropped — schema fully migrated to Postgres.
    const ANCHOR = '2026-06-24';
    if (!(await pg.get("SELECT value FROM app_settings WHERE key='cashflow_cascade_repair_v3'"))) {
      // 0. Ensure a daily row exists for every date that has entries from the
      //    anchor on (imported entries may lack the daily row the cascade needs).
      await pg.run(`
        INSERT INTO cash_flow_daily (date, opening_balance, total_inflows, total_outflows, closing_balance)
        SELECT DISTINCT e.date, 0, 0, 0, 0 FROM cash_flow_entries e
        WHERE e.date >= ? AND NOT EXISTS (SELECT 1 FROM cash_flow_daily d WHERE d.date = e.date)
      `, ANCHOR);
      // 1. Re-sum daily totals from the entries themselves (matched by date,
      //    which is UNIQUE in cash_flow_daily) for the anchor day and everything after.
      await pg.run(`
        UPDATE cash_flow_daily SET
          total_inflows  = COALESCE((SELECT SUM(amount) FROM cash_flow_entries e WHERE e.date = cash_flow_daily.date AND e.type = 'inflow'), 0),
          total_outflows = COALESCE((SELECT SUM(amount) FROM cash_flow_entries e WHERE e.date = cash_flow_daily.date AND e.type = 'outflow'), 0)
        WHERE date >= ?
      `, ANCHOR);
      // 2. Cascade forward. The anchor day opens at 0 (prevClosing seeded to 0),
      //    then each day's opening = the previous day's closing.
      const rows = await pg.all('SELECT id, COALESCE(total_inflows,0) AS inflows, COALESCE(total_outflows,0) AS outflows FROM cash_flow_daily WHERE date >= ? ORDER BY date ASC', ANCHOR);
      let prevClosing = 0;
      await pg.tx(async (t) => {
        for (const r of rows) {
          const opening = prevClosing;
          const closing = opening + r.inflows - r.outflows;
          await t.run('UPDATE cash_flow_daily SET opening_balance = ?, closing_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', opening, closing, r.id);
          prevClosing = closing;
        }
      });
      await pg.run("INSERT INTO app_settings (key,value) VALUES ('cashflow_cascade_repair_v3','done') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
      console.log(`[cashflow] running-balance chain repaired from ${ANCHOR} opening 0 (rows ensured + totals re-summed + cascaded forward)`);
    }
  } catch (e) { console.warn('[cashflow] cascade repair v3 skipped:', e.message); }
})();

// ============= PROJECT FINANCIAL TRACKER =============

// GET all projects with financial data.
// Non-admin users only see projects where they are the assigned CRM —
// match by employee_assigned containing their name or first name.
router.get('/projects', requirePermission('cashflow', 'view'), async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const isAdmin = req.user.role === 'admin';
    // Bypass the CRM-name scope filter when the role has can_approve OR
    // can_see_all on cashflow — that's the explicit "see everyone's
    // projects" toggle in Roles & Permissions. Accountant / Auditor /
    // any role mam ticks See All for, gets the full list like admin.
    const canSeeAll = isAdmin || await (async () => {
      const r = await pg.get(`
        SELECT MAX(CASE WHEN rp.can_approve = 1 OR rp.can_see_all = 1 THEN 1 ELSE 0 END) as ok
        FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
        WHERE ur.user_id = ? AND rp.module = 'cashflow'
      `, req.user.id);
      return !!r?.ok;
    })();

    // GROUP BY company_name — one row per logical project. The bug was
    // that bb.sale_amount_without_gst etc. were SELECTed without an
    // aggregate so SQLite picked a single arbitrary row's value (mam:
    // "concern pharma has 21 BB entries but Sale Value showed only one
    // order"). Now SUMs across every BB row sharing the same project
    // name so totals are correct. Same for PO / Advance / Balance.
    // Dates: take earliest start and latest completion across rows.
    // CRITICAL FIX 2026-05-16 — was previously `LEFT JOIN sites s ON
    // s.business_book_id = bb.id`.  That JOIN multiplied each BB row
    // by its number of attached sites, so SUM(sale_amount) and
    // COUNT(bb.id) BOTH inflated for any BB row with >1 site.
    //
    // Concrete case mam caught: SEPL20073 (M/s Sardarshahar... Rs 1.14
    // cr) had 2 sites linked → Cash Flow reported "6 BB entries" and
    // Rs 2.80 cr when the truth was 5 entries / Rs 1.66 cr.
    //
    // Fix: drop the JOIN entirely.  site_name is now fetched per
    // project in the result.map() loop below (cheap — one extra
    // SELECT per project, same shape as the existing PO / purchase
    // lookups).
    let sql = `SELECT MIN(bb.id) as id,
      MAX(bb.lead_no) as lead_no,
      bb.company_name as project_name,
      MAX(bb.client_name) as client_name,
      MAX(bb.employee_assigned) as crm_person,
      COALESCE(SUM(bb.sale_amount_without_gst), 0) as sale_amount_without_gst,
      COALESCE(SUM(bb.po_amount), 0) as po_amount,
      COALESCE(SUM(bb.advance_received), 0) as advance_received,
      COALESCE(SUM(bb.balance_amount), 0) as balance_amount,
      MAX(bb.category) as category,
      MAX(bb.order_type) as order_type,
      MIN(bb.committed_start_date) as committed_start_date,
      MAX(bb.committed_completion_date) as committed_completion_date,
      MIN(bb.created_at) as created_at,
      COUNT(bb.id) as bb_entry_count
      FROM business_book bb`;
    const params = [];
    if (!canSeeAll) {
      const fullName = (req.user.name || '').trim();
      const firstName = fullName.split(/\s+/)[0] || fullName;
      sql += ` WHERE (LOWER(COALESCE(bb.employee_assigned,'')) LIKE ? OR LOWER(COALESCE(bb.employee_assigned,'')) LIKE ?)`;
      params.push(`%${fullName.toLowerCase()}%`, `%${firstName.toLowerCase()}%`);
    }
    sql += ' GROUP BY bb.company_name ORDER BY bb.company_name';
    const projects = await pg.all(sql, ...params);

    const result = [];
    for (const [idx, p] of projects.entries()) {
      // site_name — fetched here instead of via LEFT JOIN to avoid the
      // sum-inflation bug fixed above.  Picks any one site linked to a
      // BB row sharing this company_name; cheap enough at our row
      // counts.  Null when no site exists.
      const siteRow = await pg.get(
        `SELECT s.name FROM sites s
         JOIN business_book bb ON s.business_book_id = bb.id
         WHERE bb.company_name = ? AND s.name IS NOT NULL
         LIMIT 1`,
        p.project_name);
      p.site_name = siteRow?.name || null;

      // Amount received (from cash flow inflows for this client)
      const received = await pg.get("SELECT COALESCE(SUM(amount),0) as total FROM cash_flow_entries WHERE type='inflow' AND party_name ILIKE ?", `%${p.client_name}%`);

      // Purchase value — only payment_requests where category='Purchase' for this
      // site/project (mam: 'purchase value is pick from payment required where
      // we select category Purchase'). Includes approved + pending so the tracker
      // reflects actual commitment, not just cleared amounts.
      const purchaseValue = await pg.get(
        "SELECT COALESCE(SUM(amount),0) as total FROM payment_requests WHERE category='Purchase' AND site_name ILIKE ?",
        `%${p.project_name}%`);

      // Total PO value + CRM from the latest Client PO uploaded for this project.
      // mam: 'CRM name is pick from client PO upload'.
      const totalPO = await pg.get(
        `SELECT COALESCE(SUM(po.total_amount),0) as total
         FROM purchase_orders po JOIN business_book bb ON po.business_book_id=bb.id
         WHERE bb.company_name=?`,
        p.project_name);
      const poCrm = await pg.get(
        `SELECT po.crm_name FROM purchase_orders po
         JOIN business_book bb ON po.business_book_id=bb.id
         WHERE bb.company_name=? AND po.crm_name IS NOT NULL AND po.crm_name != ''
         ORDER BY po.created_at DESC LIMIT 1`,
        p.project_name);

      const amountReceived = received?.total || 0;
      const purchaseAmt = purchaseValue?.total || 0;

      // Get manual fields from project_finance.
      // aanchal_value and manual_purchase_value are stored as RAW RUPEES
      // (post pf_amounts_raw_rupees_v1 migration, 2026-05-15).  Mam wanted
      // 1:1 input/display, so we no longer apply a × 1,00,000 lakh-to-rupee
      // conversion.
      const pf = await pg.get('SELECT * FROM project_finance WHERE business_book_id=?', p.id);
      const aanchalValue = pf?.aanchal_value || 0;
      const paymentInvestDays = pf?.payment_investment_days || 0;
      const manualPaymentDays = pf?.payment_days || 0;
      // OPTION A — locked last-payment target date.  Once mam enters
      // Compl / Pmt days, the system computes today + total_days
      // ONE TIME and writes it to project_finance.last_payment_target_date.
      // After that the value is read straight from the column — it
      // doesn't auto-shift as the calendar moves forward.  On the FIRST
      // read after this column lands (existing rows have NULL), we
      // backfill the lock from current days so legacy entries also stop
      // drifting.  See backfill below after totalDays is known.
      const lockedTarget = pf?.last_payment_target_date || null;

      // Days calculation
      const startDate = p.committed_start_date ? new Date(p.committed_start_date) : new Date(p.created_at);
      const completionDate = p.committed_completion_date ? new Date(p.committed_completion_date) : null;
      const todayDate = new Date(today);
      const computedCompletionDays = completionDate ? Math.ceil((completionDate - startDate) / (1000 * 60 * 60 * 24)) : 0;
      const paymentDays = manualPaymentDays; // Q: Payment Days (manual)

      // Effective completion days — manual override (project_finance) takes
      // precedence over the date-computed value. The TOTAL displayed in the
      // grid must use this same effective value, otherwise the row reads
      // (manual 10) + (manual 10) = 25 because the totalDays kept silently
      // using the date-computed 15 instead of the manual override 10.
      const effCompletion = pf?.manual_completion_days ?? computedCompletionDays;
      const totalDays = effCompletion + paymentDays; // R: Total = P (effective) + Q

      // Cash Velocity = (J - K) / R = (Aanchal Value - Purchase Value) / Total Days
      // Both aanchalValue and effPurchase are in raw rupees post-migration.
      // The /100000 still appears in the formula so the displayed number stays
      // in "lakhs/day" units (mam's spreadsheet shows 1.50 / 0.05 / etc.).
      const effPurchase = pf?.manual_purchase_value != null ? pf.manual_purchase_value : purchaseAmt;
      const cashVelocity = totalDays > 0 ? Math.round(((aanchalValue - effPurchase) / totalDays / 100000) * 100) / 100 : 0;

      // OPTION A backfill — if project has days entered but no locked
      // target date yet, lock it ONCE from today + totalDays and save.
      // From this point on, the date stays put regardless of calendar
      // movement, until mam edits the row again (the POST handler
      // recomputes-and-locks on every save).
      let effLockedTarget = lockedTarget;
      if (!effLockedTarget && pf && totalDays > 0) {
        try {
          const t = new Date(); t.setDate(t.getDate() + totalDays);
          effLockedTarget = t.toISOString().slice(0, 10);
          // guarded ALTER TABLE (last_payment_target_date) dropped — column exists in the migrated schema.
          await pg.run('UPDATE project_finance SET last_payment_target_date=? WHERE business_book_id=?', effLockedTarget, p.id);
        } catch (_) { /* non-fatal */ }
      }

      result.push({
        sr_no: idx + 1,
        id: p.id,
        bb_entry_count: p.bb_entry_count || 1,  // how many BB rows summed into this project
        project_name: p.project_name || p.client_name,
        // CRM comes from the Client PO if available, falls back to Business Book's employee_assigned
        crm_person: poCrm?.crm_name || p.crm_person,
        category: p.category,
        sale_amount: p.sale_amount_without_gst || 0,
        // PO Amount (With GST) — source of truth is bb.po_amount (now
        // strictly enforced as Sale × 1.18 by businessbook.js, mam
        // 2026-05-21).  We keep the purchase_orders sum available as a
        // separate field for any future tile that wants client-PO
        // upload reconciliation, but the headline PO column reads from
        // BB so it always matches what the user sees on the Business
        // Book page.
        po_amount: p.po_amount || 0,
        client_po_uploaded: totalPO?.total || 0,
        amount_received: pf?.amount_received || amountReceived, // H: Tally (manual)
        milestone_name: pf?.milestone_name || '',  // I: Milestone (manual)
        // Mam (2026-05-22): AR Cleared column between Milestone and
        // Aanchal — CRM marks how much AR has been cleared per project.
        // Raw rupees; manual.  Independent of amount_received (Tally).
        ar_cleared_value: pf?.ar_cleared_value || 0,
        aanchal_value: pf?.aanchal_value || 0,  // J: Aanchal Value (raw rupees, manual)
        purchase_value: pf?.manual_purchase_value != null ? pf.manual_purchase_value : purchaseAmt, // K: Purchase Value (manual raw rupees, else auto from FMS)
        cash_velocity: cashVelocity,  // M: (J-K)/R
        live_date: today,  // N: Today
        payment_investment_days: paymentInvestDays,  // O: Manual by Nitin ji
        completion_days: effCompletion,  // P: manual override OR computed from dates
        payment_days: paymentDays,  // Q: Manual
        total_days: totalDays,  // R: effective P + Q (now consistent with displayed P + Q)
        // OPTION A — locked Last Pmt Date.  Set ONCE at edit time
        // (today + total_days) and never auto-shifts after.  Frontend
        // displays this directly; falls back to legacy compute only if
        // null (which shouldn't happen post-backfill).
        last_payment_target_date: effLockedTarget,
        committed_start: p.committed_start_date,
        committed_completion: p.committed_completion_date,
      });
    }

    // Summary
    // Mam (2026-05-21): the headline "Total Sale Value" tile should
    // match the table's Sale ₹ (with GST) column — i.e., the
    // PO-with-GST sum (bb.po_amount), with sale × 1.18 fallback for
    // any legacy row.  Old totalSale (sum of sale_amount_without_gst)
    // kept under totalSaleExGst in case anything wants the raw value.
    const totalSale = result.reduce((s, r) => s + (r.po_amount || (r.sale_amount || 0) * 1.18), 0);
    const totalSaleExGst = result.reduce((s, r) => s + r.sale_amount, 0);
    const totalReceived = result.reduce((s, r) => s + r.amount_received, 0);
    const totalPurchase = result.reduce((s, r) => s + r.purchase_value, 0);
    // Total Value = sum of Aanchal Values (raw rupees post pf_amounts_raw_rupees_v1
    // migration — no × 1,00,000 conversion needed).
    const totalValue = result.reduce((s, r) => s + (r.aanchal_value || 0), 0);
    // Mam (2026-05-22): new KPI tile — total AR cleared across all projects.
    const totalArCleared = result.reduce((s, r) => s + (r.ar_cleared_value || 0), 0);

    res.json({ projects: result, summary: { totalSale, totalSaleExGst, totalReceived, totalArCleared, totalValue, totalPurchase, projectCount: result.length } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST update project manual fields (milestone, aanchal value, payment days)
router.post('/projects/:id/update', requirePermission('cashflow', 'edit'), async (req, res) => {
  try {
    const { crm_person, amount_received, milestone_name, ar_cleared_value, aanchal_value, payment_investment_days, payment_days, manual_purchase_value, manual_completion_days } = req.body;
    // The defensive ALTER TABLE guards that used to live here (payment_days,
    // manual_purchase_value, manual_completion_days, ar_cleared_value —
    // Mam 2026-05-22: AR Cleared column between Milestone and Aanchal — and
    // last_payment_target_date) are dropped: every column exists in the
    // migrated Postgres schema.
    // OPTION A — locked target date for "Last Pmt Date".  Mam, 2026-05-16:
    // "i want days never increase when days are not edited".  We re-lock
    // the date HERE on every save (today + new total_days).  The dashboard
    // GET reads this column verbatim — no auto-recompute as the calendar
    // moves forward.
    if (crm_person !== undefined) {
      await pg.run('UPDATE business_book SET employee_assigned=? WHERE id=?', crm_person, req.params.id);
    }
    // Compute the fresh target date.  Falls back to existing locked
    // value when the user updated something OTHER than days (so a
    // milestone-only edit doesn't reset the lock).
    let lockedTarget = null;
    const totalDays = (Number(manual_completion_days) || 0) + (Number(payment_days) || 0);
    if (totalDays > 0) {
      const t = new Date(); t.setDate(t.getDate() + totalDays);
      lockedTarget = t.toISOString().slice(0, 10);
    } else {
      // Preserve previous lock if no days change
      const prev = await pg.get('SELECT last_payment_target_date FROM project_finance WHERE business_book_id=?', req.params.id);
      lockedTarget = prev?.last_payment_target_date || null;
    }
    await pg.run(`INSERT INTO project_finance (business_book_id, amount_received, milestone_name, ar_cleared_value, aanchal_value, payment_investment_days, payment_days, manual_purchase_value, manual_completion_days, last_payment_target_date, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT (business_book_id) DO UPDATE SET
        amount_received=EXCLUDED.amount_received, milestone_name=EXCLUDED.milestone_name, ar_cleared_value=EXCLUDED.ar_cleared_value,
        aanchal_value=EXCLUDED.aanchal_value, payment_investment_days=EXCLUDED.payment_investment_days, payment_days=EXCLUDED.payment_days,
        manual_purchase_value=EXCLUDED.manual_purchase_value, manual_completion_days=EXCLUDED.manual_completion_days,
        last_payment_target_date=EXCLUDED.last_payment_target_date, updated_at=EXCLUDED.updated_at`,
      req.params.id, amount_received || 0, milestone_name, ar_cleared_value || 0, aanchal_value || 0, payment_investment_days || 0, payment_days || 0, manual_purchase_value ?? null, manual_completion_days ?? null, lockedTarget);
    res.json({ message: 'Updated', last_payment_target_date: lockedTarget });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============= PROJECT-LEVEL DIAGNOSTIC =============
//
// Breakdown of which BB rows feed into a single Cash Flow project
// row.  Mam (2026-05-16): "look business book sardareshahar total
// amount and cash flow amount check correct this error".  The Cash
// Flow tracker groups BB rows by `company_name` and sums their
// sale_amount_without_gst — when distinct clients share one company
// name (e.g. SAEL hosts 1572663, Manish Kumar, ...) the rollup can
// surprise users by reporting a much larger total than any single
// BB list filter would show.
//
// This endpoint returns every BB row that contributes to one
// company_name's roll-up, with id / lead_no / client / sale /
// po amounts / status, so mam can see EXACTLY which rows are in
// the sum and decide whether to split or rename.
//
// URL: /api/cashflow/project-breakdown?company_name=M%2Fs%20Sardarshahar%20...
router.get('/project-breakdown', requirePermission('cashflow', 'view'), async (req, res) => {
  try {
    const { company_name } = req.query;
    if (!company_name) return res.status(400).json({ error: 'company_name is required' });
    const rows = await pg.all(`
      SELECT id, lead_no, lead_type, client_name, project_name, company_name,
             category, status, sale_amount_without_gst, po_amount,
             advance_received, balance_amount, employee_assigned,
             committed_start_date, committed_completion_date, created_at
      FROM business_book
      WHERE TRIM(company_name) = TRIM(?)
      ORDER BY created_at DESC
    `, company_name);
    const totals = rows.reduce((acc, r) => {
      acc.sale += +r.sale_amount_without_gst || 0;
      acc.po += +r.po_amount || 0;
      acc.advance += +r.advance_received || 0;
      return acc;
    }, { sale: 0, po: 0, advance: 0 });
    res.json({
      company_name,
      row_count: rows.length,
      distinct_clients: new Set(rows.map(r => (r.client_name || '').toLowerCase().trim())).size,
      totals,
      rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============= DAILY CASH FLOW (existing) =============

router.get('/daily', async (req, res) => {
  try {
    const { from, to } = req.query;
    let sql = 'SELECT * FROM cash_flow_daily WHERE 1=1';
    const params = [];
    if (from) { sql += ' AND date >= ?'; params.push(from); }
    if (to) { sql += ' AND date <= ?'; params.push(to); }
    sql += ' ORDER BY date DESC';
    res.json(await pg.all(sql, ...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/today', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    let daily = await pg.get('SELECT * FROM cash_flow_daily WHERE date = ?', today);
    if (!daily) {
      const yesterday = await pg.get('SELECT closing_balance FROM cash_flow_daily WHERE date < ? ORDER BY date DESC LIMIT 1', today);
      const opening = yesterday?.closing_balance || 0;
      await pg.run('INSERT INTO cash_flow_daily (date, opening_balance, closing_balance) VALUES (?, ?, ?)', today, opening, opening);
      daily = await pg.get('SELECT * FROM cash_flow_daily WHERE date = ?', today);
    }
    res.json(daily);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/summary', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    // Mam: "upper why not showing" — the top 4 cards used to be hard-wired
    // to today's row only and stayed at Rs 0 whenever the user picked a
    // different date. Now they reflect the date the client asks for
    // (?date=YYYY-MM-DD); when no row exists for that date we derive the
    // opening = closing from the most recent prior day so the numbers
    // make sense even for days nobody recorded entries.
    const targetDate = req.query.date || today;
    let rowData = await pg.get('SELECT * FROM cash_flow_daily WHERE date = ?', targetDate);
    if (!rowData) {
      const prev = await pg.get('SELECT closing_balance FROM cash_flow_daily WHERE date < ? ORDER BY date DESC LIMIT 1', targetDate);
      const carry = prev?.closing_balance || 0;
      rowData = { date: targetDate, opening_balance: carry, total_inflows: 0, total_outflows: 0, closing_balance: carry };
    }
    const last7 = await pg.all('SELECT * FROM cash_flow_daily ORDER BY date DESC LIMIT 7');
    const monthStart = targetDate.substring(0, 7) + '-01';
    const monthInflow = await pg.get("SELECT COALESCE(SUM(amount),0) as total FROM cash_flow_entries WHERE date >= ? AND type = 'inflow'", monthStart);
    const monthOutflow = await pg.get("SELECT COALESCE(SUM(amount),0) as total FROM cash_flow_entries WHERE date >= ? AND type = 'outflow'", monthStart);
    res.json({
      // Field name stays `today` for frontend compatibility — it's the
      // selected-date row now, not literal today.
      today: rowData,
      last7Days: last7,
      monthlyInflow: monthInflow.total,
      monthlyOutflow: monthOutflow.total,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/entry', async (req, res) => {
  try {
    const { date, type, category, description, amount, payment_mode, party_name } = req.body;
    // Party name made mandatory 2026-05-16 — mam wants every cash entry
    // tied to a known counterparty so audits + future BB linking aren't
    // crippled by anonymous "₹40,000 outflow" rows.
    if (!date || !type || !category || !description || !amount || !party_name) {
      return res.status(400).json({ error: 'All fields required (incl. party name)' });
    }
    let daily = await pg.get('SELECT id FROM cash_flow_daily WHERE date = ?', date);
    if (!daily) {
      const prev = await pg.get('SELECT closing_balance FROM cash_flow_daily WHERE date < ? ORDER BY date DESC LIMIT 1', date);
      const r = await pg.run('INSERT INTO cash_flow_daily (date, opening_balance, closing_balance, created_by) VALUES (?, ?, ?, ?)', date, prev?.closing_balance || 0, prev?.closing_balance || 0, req.user.id);
      daily = { id: r.lastInsertRowid };
    }
    await pg.run('INSERT INTO cash_flow_entries (daily_id, date, type, category, description, amount, payment_mode, party_name, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
      daily.id, date, type, category, description, amount, payment_mode, party_name, req.user.id);
    const inflows = await pg.get("SELECT COALESCE(SUM(amount),0) as t FROM cash_flow_entries WHERE daily_id = ? AND type = 'inflow'", daily.id);
    const outflows = await pg.get("SELECT COALESCE(SUM(amount),0) as t FROM cash_flow_entries WHERE daily_id = ? AND type = 'outflow'", daily.id);
    await pg.run('UPDATE cash_flow_daily SET total_inflows = ?, total_outflows = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      inflows.t, outflows.t, daily.id);
    // Cascade the running balance forward so a back-dated entry flows into every
    // later day's opening/closing (mam 2026-07-01).
    await recalcCashFlowFrom(pg, date);
    const closing = (await pg.get('SELECT closing_balance FROM cash_flow_daily WHERE id = ?', daily.id))?.closing_balance || 0;
    res.status(201).json({ message: 'Entry added', closing_balance: closing });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/entries/:date', async (req, res) => {
  try {
    res.json(await pg.all('SELECT e.*, u.name as created_by_name FROM cash_flow_entries e LEFT JOIN users u ON e.created_by=u.id WHERE e.date = ? ORDER BY e.created_at DESC', req.params.date));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/entry/:id', async (req, res) => {
  try {
    const entry = await pg.get('SELECT * FROM cash_flow_entries WHERE id = ?', req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    await pg.run('DELETE FROM cash_flow_entries WHERE id = ?', req.params.id);
    const inflows = await pg.get("SELECT COALESCE(SUM(amount),0) as t FROM cash_flow_entries WHERE daily_id = ? AND type = 'inflow'", entry.daily_id);
    const outflows = await pg.get("SELECT COALESCE(SUM(amount),0) as t FROM cash_flow_entries WHERE daily_id = ? AND type = 'outflow'", entry.daily_id);
    await pg.run('UPDATE cash_flow_daily SET total_inflows = ?, total_outflows = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      inflows.t, outflows.t, entry.daily_id);
    // Cascade forward so deleting a back-dated entry fixes every later day too.
    await recalcCashFlowFrom(pg, entry.date);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/opening-balance', async (req, res) => {
  try {
    const { date, opening_balance } = req.body;
    if (!date) return res.status(400).json({ error: 'date required' });
    const ob = +opening_balance || 0;
    // Ensure the row exists, then set its opening.
    const existing = await pg.get('SELECT id FROM cash_flow_daily WHERE date = ?', date);
    if (existing) await pg.run('UPDATE cash_flow_daily SET opening_balance = ? WHERE id = ?', ob, existing.id);
    else await pg.run('INSERT INTO cash_flow_daily (date, opening_balance, closing_balance, created_by) VALUES (?, ?, ?, ?)', date, ob, ob, req.user.id);

    // Cascade forward (mam 2026-06-27: "edit opening" must flow through). For the
    // edited day, opening = the value just set; every later day's opening = the
    // prior day's closing; closing = opening + inflows − outflows.
    const rows = await pg.all('SELECT id, date, COALESCE(total_inflows,0) AS inflows, COALESCE(total_outflows,0) AS outflows FROM cash_flow_daily WHERE date >= ? ORDER BY date ASC', date);
    let prevClosing = null;
    await pg.tx(async (t) => {
      for (const r of rows) {
        const opening = prevClosing == null ? ob : prevClosing;
        const closing = opening + r.inflows - r.outflows;
        await t.run('UPDATE cash_flow_daily SET opening_balance = ?, closing_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', opening, closing, r.id);
        prevClosing = closing;
      }
    });
    const closing = (await pg.get('SELECT closing_balance FROM cash_flow_daily WHERE date = ?', date))?.closing_balance;
    res.json({ message: 'Opening updated', closing_balance: closing });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
