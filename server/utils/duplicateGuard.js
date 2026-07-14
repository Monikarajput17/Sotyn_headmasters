// Generic "is this entry already in the DB?" helper.
//
// Mam (2026-05-21): "raise entry data can not be duplicate if some
// enter data duplicate give him notification with code that check
// already do it whole erp".
//
// She showed two PMS-Tasks rows (TSK-0432, TSK-0433) with the same
// description, same assignee, same due-date.  This guard catches that
// shape across any module: caller supplies the table name, the field
// combo that defines "same row", and a column to pull back as the
// human-friendly "code" (TSK-, SEPL-, lead_no, etc).
//
// Returns { code, row } when a duplicate exists, or null when none.
//
// Comparison is case-insensitive + trim-folded for TEXT fields so
// "Send 9 AM report " and "send 9 am report" are treated as the same
// entry.  NULL / blank input fields are ignored (so an empty optional
// field doesn't accidentally match every NULL row).

function findDuplicate(db, opts) {
  const {
    table,
    fields,                 // { col_name: value, ... }
    codeColumn = 'id',      // which column to surface to the user
    codePrefix = '',        // optional prefix to prepend (e.g. 'TSK-')
    codePad = 0,            // zero-pad numeric code to N digits
    excludeId = null,       // skip a specific row (for updates)
  } = opts;

  if (!table || !fields || typeof fields !== 'object') return null;

  // Only include non-empty fields in the equality match.
  const entries = Object.entries(fields).filter(([_, v]) => {
    if (v === null || v === undefined) return false;
    if (typeof v === 'string' && v.trim() === '') return false;
    return true;
  });
  if (entries.length === 0) return null;

  const where = entries
    .map(([k]) => `LOWER(TRIM(COALESCE(${k}, ''))) = LOWER(TRIM(?))`)
    .join(' AND ');
  const params = entries.map(([_, v]) => String(v));

  let sql = `SELECT ${codeColumn} AS _code, * FROM ${table} WHERE ${where}`;
  if (excludeId != null) { sql += ' AND id != ?'; params.push(excludeId); }
  sql += ' LIMIT 1';

  let row;
  try {
    row = db.prepare(sql).get(...params);
  } catch (e) {
    // Malformed table / column — fail open (don't block submission on
    // our bug); just log so we can fix the call-site.
    console.warn('[duplicateGuard] query failed:', e.message, { table, fields });
    return null;
  }
  if (!row) return null;

  // Format the code for the toast: 'TSK-' + padStart(id, 4, '0') etc.
  let code = String(row._code ?? row.id ?? '');
  if (codePad && /^\d+$/.test(code)) code = code.padStart(codePad, '0');
  if (codePrefix) code = codePrefix + code;
  return { code, row };
}

// Convenience for routes: send a uniform 409 response when caught.
//   if (sendDuplicate(res, dup, 'Task with this description already exists')) return;
function sendDuplicate(res, dup, label = 'Entry') {
  if (!dup) return false;
  res.status(409).json({
    error: `Duplicate · ${label} already exists as ${dup.code}`,
    duplicate: true,
    existing_code: dup.code,
    existing_id: dup.row.id,
  });
  return true;
}

module.exports = { findDuplicate, sendDuplicate };
