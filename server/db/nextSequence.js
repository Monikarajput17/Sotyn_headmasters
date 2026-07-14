// Shared helper for generating the next unique sequence number for columns
// like lead_no / ticket_no / quotation_number / grn_number / etc.
//
// Why this exists: many places used `SELECT COUNT(*) + OFFSET` which breaks
// the moment any row is deleted — the count drops but existing IDs stay,
// so the next insert collides on the UNIQUE constraint. mam hit this on
// Business Book on 2026-04-23. This helper instead parses the max numeric
// suffix across existing rows and returns max+1, guaranteeing uniqueness
// regardless of deletes.
//
// Usage:
//   const { nextSequence } = require('../db/nextSequence');
//   const num = nextSequence(db, 'business_book', 'lead_no', 'SEPL', { startFrom: 20000, pad: 5 });
//   // num => 'SEPL20001', 'SEPL20002', ...

function nextSequence(db, table, column, prefix, { startFrom = 0, pad = 0 } = {}) {
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rows = db.prepare(
    `SELECT ${column} as v FROM ${table} WHERE ${column} IS NOT NULL AND ${column} LIKE ?`
  ).all(prefix + '%');

  const re = new RegExp('^' + esc + '(\\d+)');
  let maxNum = startFrom;
  for (const r of rows) {
    const m = String(r.v || '').match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n > maxNum) maxNum = n;
    }
  }
  const next = maxNum + 1;
  return pad > 0 ? `${prefix}${String(next).padStart(pad, '0')}` : `${prefix}${next}`;
}

module.exports = { nextSequence };
