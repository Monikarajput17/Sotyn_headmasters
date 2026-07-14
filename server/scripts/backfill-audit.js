// One-shot: synthesise audit_log entries for rows that were created BEFORE
// audit logging started working (the ERP_DISABLE_AUDIT=1 bug period).
//
// For each main entry table, we insert a CREATE row in audit_log with:
//   - the row's own user (assigned_by / created_by / etc.)
//   - the row's own created_at as the audit timestamp
//   - a body_summary JSON of the typed fields so word/char count works
//
// Idempotent: re-running won't double-insert because we check for an
// existing CREATE row keyed on (entity_type, entity_id) before inserting.
//
// Usage (from /root/erp on VPS):
//   node server/scripts/backfill-audit.js
//   node server/scripts/backfill-audit.js --since 2026-04-25     # only on/after this date
//   node server/scripts/backfill-audit.js --table delegations    # one table only
//
// Safe to abort and re-run.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'erp.db');
if (!fs.existsSync(DB_PATH)) {
  console.error('[backfill] DB not found at', DB_PATH);
  process.exit(1);
}

// Parse CLI args
const args = process.argv.slice(2);
let since = null;
let onlyTable = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--since' && args[i + 1]) { since = args[i + 1]; i++; }
  else if (args[i] === '--table' && args[i + 1]) { onlyTable = args[i + 1]; i++; }
}

// Per-table config: which user column links to users(id), which column is the
// human-friendly label, and which text fields should be packed into the
// synthetic body_summary so word/char count works the same as a real POST.
const TABLES = [
  { table: 'delegations',     entity_type: 'delegations',     user_field: 'assigned_by',
    label_field: 'title',     fields: ['title', 'description', 'project_name', 'attachment_url'] },
  { table: 'leads',           entity_type: 'leads',           user_field: 'created_by',
    label_field: 'client_name', fields: ['client_name', 'contact_person', 'requirement', 'phone', 'email', 'address', 'source', 'remarks'] },
  { table: 'complaints',      entity_type: 'complaints',      user_field: 'created_by',
    label_field: 'customer_name', fields: ['customer_name', 'description', 'remarks', 'state', 'address', 'priority'] },
  { table: 'business_book',   entity_type: 'business-book',   user_field: 'created_by',
    label_field: 'company_name', fields: ['company_name', 'project_name', 'client_name', 'contact_person', 'phone', 'email', 'address', 'remarks'] },
  { table: 'purchase_orders', entity_type: 'orders',          user_field: 'created_by',
    label_field: 'po_number', fields: ['po_number', 'po_value', 'remarks', 'crm_name'] },
  { table: 'sites',           entity_type: 'dpr',             user_field: 'created_by',
    label_field: 'name',      fields: ['name', 'address', 'client_name', 'supervisor'] },
  { table: 'dpr',             entity_type: 'dpr',             user_field: 'submitted_by',
    label_field: 'mb_sheet_no', fields: ['weather', 'contractor_name', 'mb_sheet_no', 'safety_incidents', 'next_day_plan', 'hindrances', 'remarks'] },
  { table: 'indents',         entity_type: 'procurement',     user_field: 'created_by',
    label_field: 'indent_number', fields: ['indent_number', 'notes', 'site_name', 'raised_by_name', 'client_name'] },
  { table: 'vendors',         entity_type: 'vendors',         user_field: 'created_by',
    label_field: 'name',      fields: ['name', 'firm_name', 'contact_person', 'phone', 'email', 'address', 'category', 'deals_in', 'gst_number'] },
  { table: 'pms_tasks',       entity_type: 'pms-tasks',       user_field: 'assigned_by',
    label_field: 'title',     fields: ['title', 'description', 'project_name_snapshot', 'crm_name'] },
  { table: 'payment_requests', entity_type: 'payment-required', user_field: 'created_by',
    label_field: 'request_no', fields: ['employee_name', 'site_name', 'department', 'category', 'purpose', 'travel_from_to', 'mode_of_travel', 'stay_details', 'indent_number', 'item_description', 'vendor_name', 'labour_type', 'work_duration', 'site_engineer_name', 'vehicle_type', 'from_to_location', 'material_description'] },
  { table: 'expenses',        entity_type: 'expenses',        user_field: 'created_by',
    label_field: 'description', fields: ['description', 'category', 'remarks'] },
  { table: 'quotations',      entity_type: 'quotations',      user_field: 'created_by',
    label_field: 'quotation_number', fields: ['quotation_number', 'client_name', 'project_name', 'contact_person'] },
  // item_master is intentionally excluded — those 3,000+ rows are bulk-
  // seeded from items_seed.json on first server start, NOT typed by
  // mam's team. Counting them would inflate the dashboard with "(unknown)
  // user · Item Master · 3101 entries" which isn't real data entry work.
  { table: 'customers',       entity_type: 'customers',       user_field: 'created_by',
    label_field: 'name',      fields: ['name', 'company_name', 'contact_person', 'phone', 'email', 'address', 'gst_number'] },
];

const db = new Database(DB_PATH);

// Make sure audit_log exists (created by schema init normally; bail otherwise)
const auditExists = db.prepare(
  `SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_log'`
).get();
if (!auditExists) {
  console.error('[backfill] audit_log table missing — start the server once so schema seeds it.');
  process.exit(1);
}

const insertSql = `
  INSERT INTO audit_log (user_id, user_name, user_role, action, entity_type, entity_id, entity_label, method, path, body_summary, status_code, at)
  SELECT ?, ?, ?, 'CREATE', ?, ?, ?, 'POST', ?, ?, 201, ?
   WHERE NOT EXISTS (
     SELECT 1 FROM audit_log
      WHERE entity_type = ? AND entity_id = ? AND action = 'CREATE'
   )
`;
const insertStmt = db.prepare(insertSql);
const userInfo = db.prepare('SELECT name, role FROM users WHERE id = ?');

let grandTotal = 0;
const tables = onlyTable ? TABLES.filter(c => c.table === onlyTable || c.entity_type === onlyTable) : TABLES;
if (onlyTable && tables.length === 0) {
  console.error(`[backfill] no config for table "${onlyTable}". Available:`, TABLES.map(t => t.table).join(', '));
  process.exit(1);
}

for (const cfg of tables) {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(cfg.table);
  if (!exists) { console.log(`[backfill] skip ${cfg.table} (not in schema)`); continue; }

  const cols = new Set(db.prepare(`PRAGMA table_info(${cfg.table})`).all().map(c => c.name));
  if (!cols.has('id') || !cols.has('created_at')) {
    console.log(`[backfill] skip ${cfg.table} (no id/created_at)`); continue;
  }

  const userField = cfg.user_field && cols.has(cfg.user_field) ? cfg.user_field : null;
  const labelField = cfg.label_field && cols.has(cfg.label_field) ? cfg.label_field : null;
  const usableFields = cfg.fields.filter(f => cols.has(f));

  let where = '';
  const params = [];
  if (since) {
    where = ` WHERE created_at >= ?`;
    params.push(since + ' 00:00:00');
  }
  const rows = db.prepare(`SELECT * FROM ${cfg.table}${where} ORDER BY id`).all(...params);

  let inserted = 0;
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      const userId = userField ? r[userField] : null;
      let userName = null, userRole = null;
      if (userId) {
        const u = userInfo.get(userId);
        if (u) { userName = u.name; userRole = u.role; }
      }
      const body = {};
      for (const f of usableFields) {
        if (r[f] != null && r[f] !== '') body[f] = r[f];
      }
      const bodyJson = JSON.stringify(body);
      const bodySummary = bodyJson.length > 2000 ? bodyJson.slice(0, 2000) + '…' : bodyJson;
      const label = labelField ? (r[labelField] || null) : null;
      const apiPath = `/api/${cfg.entity_type}`;
      const result = insertStmt.run(
        userId, userName, userRole,
        cfg.entity_type, String(r.id), label,
        apiPath, bodySummary, r.created_at,
        cfg.entity_type, String(r.id),
      );
      if (result.changes > 0) inserted += 1;
    }
  });
  tx(rows);
  grandTotal += inserted;
  console.log(`[backfill] ${cfg.table}: ${inserted} new audit rows (scanned ${rows.length})`);
}

console.log(`[backfill] DONE — ${grandTotal} synthetic audit rows inserted.`);
console.log('[backfill] Refresh the Daily Activity dashboard to see them.');
