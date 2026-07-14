// Cash → Receivables → Sales Bills → Cash Flow chain helpers.
// Implements audit checklist items A7 / A9 / A14 / (verifies B6).
//
// Mam's audit ask 2026-05-16: every payment must update every
// downstream table without manual reconciliation.

function calculateAgeing(dueDate) {
  if (!dueDate) return { days: 0, bucket: '0-30' };
  const now = new Date();
  const due = new Date(dueDate);
  const days = Math.max(0, Math.floor((now - due) / (1000 * 60 * 60 * 24)));
  let bucket = '0-30';
  if (days > 90) bucket = '90+';
  else if (days > 60) bucket = '61-90';
  else if (days > 30) bucket = '31-60';
  return { days, bucket };
}

function getStatusColor(outstandingAmount, ageingDays) {
  if (outstandingAmount <= 0) return 'green';
  if (ageingDays > 60) return 'red';
  if (ageingDays > 30) return 'yellow';
  return 'green';
}

// A9 — sync sales_bills.payment_status when a receivable is updated.
// Matches by invoice_number → bill_number (1:1 link).  If no bill
// found, no-op (some receivables are advance / standalone).  When
// found, recomputes payment_status from sum of all collections on
// the receivable vs the bill's total_amount.
function syncSalesBillPaymentStatus(db, receivableId) {
  try {
    const rec = db.prepare(
      'SELECT id, invoice_number, received_amount FROM receivables WHERE id=?'
    ).get(receivableId);
    if (!rec || !rec.invoice_number) return { synced: 0 };

    const bill = db.prepare(
      'SELECT id, total_amount FROM sales_bills WHERE bill_number=?'
    ).get(rec.invoice_number);
    if (!bill) return { synced: 0 };

    const received = rec.received_amount || 0;
    const total = bill.total_amount || 0;
    let status;
    if (received <= 0) status = 'pending';
    else if (received >= total) status = 'paid';
    else status = 'partial';

    db.prepare(
      'UPDATE sales_bills SET payment_status=? WHERE id=?'
    ).run(status, bill.id);
    return { synced: 1, bill_id: bill.id, status };
  } catch (e) {
    console.warn('[cashSync] syncSalesBillPaymentStatus failed:', e.message);
    return { synced: 0, error: e.message };
  }
}

// A14 — Ensure today's cash_flow_daily row exists with opening =
// yesterday's closing.  Idempotent: if today's row already exists,
// no-op.  Used by:
//   - midnight cron (so dashboards stay accurate even on no-txn days)
//   - the on-demand /collect path (already creates the row but using
//     the same code keeps both branches in sync)
function ensureTodayCashFlowDaily(db, dateIso) {
  const today = dateIso || new Date().toISOString().slice(0, 10);
  const existing = db.prepare(
    'SELECT id FROM cash_flow_daily WHERE date=?'
  ).get(today);
  if (existing) return { created: 0, id: existing.id };
  const prev = db.prepare(
    'SELECT closing_balance FROM cash_flow_daily WHERE date < ? ORDER BY date DESC LIMIT 1'
  ).get(today);
  const openingBalance = prev?.closing_balance || 0;
  const r = db.prepare(
    'INSERT INTO cash_flow_daily (date, opening_balance, closing_balance) VALUES (?, ?, ?)'
  ).run(today, openingBalance, openingBalance);
  return { created: 1, id: r.lastInsertRowid, opening_balance: openingBalance };
}

// A7 — Recompute ageing for every receivable with outstanding > 0.
// Returns counts.  Called from the 01:00 cron AND can be triggered
// manually via POST /api/collections/refresh-ageing.
function refreshAllAgeing(db) {
  const rows = db.prepare(
    'SELECT id, due_date, outstanding_amount FROM receivables WHERE outstanding_amount > 0'
  ).all();
  let updated = 0;
  for (const r of rows) {
    const { days, bucket } = calculateAgeing(r.due_date);
    const statusColor = getStatusColor(r.outstanding_amount, days);
    db.prepare(
      'UPDATE receivables SET ageing_days=?, ageing_bucket=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
    ).run(days, bucket, statusColor, r.id);
    updated += 1;
  }
  return { updated, total: rows.length };
}

module.exports = {
  calculateAgeing,
  getStatusColor,
  syncSalesBillPaymentStatus,
  ensureTodayCashFlowDaily,
  refreshAllAgeing,
};
