// AI Agent — three features behind /api/ai-agent:
//   (1) Rate intelligence  — /rate-suggestion + /item-history (Feature 1+2)
//   (2) Settings           — /settings (admin-only: paste Anthropic API key
//                            inside the ERP, no .env edit needed — mam's
//                            requirement: 'in erp')
//   (3) Ask ERP chatbot    — /ask (Claude + read-only SQL tool)

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Read/write helpers for the key-value app_settings table. Keys we own:
//   ai_provider  — 'anthropic' (only one for now)
//   ai_api_key   — the secret (server-side only; masked in GET)
//   ai_model     — model id (default claude-opus-4-7)
function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return row?.value ?? null;
}
function setSetting(key, value) {
  getDb().prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
                   ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).run(key, value);
}
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// GET /api/ai-agent/rate-suggestion?item_id=&lead_id=
// Returns last-quoted-to-this-client + 6-month stats across all clients.
// Both null when no history exists for that item (UI hides the panel).
// Gated by 'quotations' perms — the popup only renders inside the BOQ form.
router.get('/rate-suggestion', requirePermission('quotations', 'view'), (req, res) => {
  const itemId = +req.query.item_id;
  const leadId = req.query.lead_id ? +req.query.lead_id : null;
  if (!itemId) return res.status(400).json({ error: 'item_id required' });

  const db = getDb();

  // Pull this client's company_name so we can match historical rows
  // even if a different lead from the same client quoted before.
  let companyName = null;
  if (leadId) {
    const lead = db.prepare('SELECT company_name FROM leads WHERE id=?').get(leadId);
    companyName = lead?.company_name || null;
  }

  const lastForClient = companyName
    ? db.prepare(`SELECT rate, created_at, created_by_name, quantity
                  FROM item_price_history
                  WHERE item_id=? AND company_name=?
                  ORDER BY created_at DESC LIMIT 1`).get(itemId, companyName)
    : null;

  // 6-month window across all clients
  const stats = db.prepare(`SELECT
      COUNT(*) AS n,
      AVG(rate) AS avg_rate,
      MIN(rate) AS min_rate,
      MAX(rate) AS max_rate
    FROM item_price_history
    WHERE item_id=? AND created_at >= datetime('now', '-6 months')`).get(itemId);

  const lastOverall = db.prepare(`SELECT rate, created_at, created_by_name, company_name
                                  FROM item_price_history
                                  WHERE item_id=?
                                  ORDER BY created_at DESC LIMIT 1`).get(itemId);

  const item = db.prepare('SELECT id, item_name, current_price FROM item_master WHERE id=?').get(itemId);

  res.json({
    item,
    last_for_client: lastForClient,         // null if no prior quote to this client
    last_overall: lastOverall,              // null if no history at all
    six_month_stats: stats?.n > 0 ? {
      count: stats.n,
      avg: Math.round(stats.avg_rate),
      min: stats.min_rate,
      max: stats.max_rate,
    } : null,
    company_name: companyName,
  });
});

// GET /api/ai-agent/item-history?item_id=&limit=20
// Full historical log for an item — used by the AI Agent page (later)
// and useful for "show me the rate trend" view.
router.get('/item-history', requirePermission('quotations', 'view'), (req, res) => {
  const itemId = +req.query.item_id;
  const limit = Math.min(+req.query.limit || 20, 100);
  if (!itemId) return res.status(400).json({ error: 'item_id required' });
  const rows = getDb().prepare(`SELECT h.*, l.company_name AS lead_company
                                FROM item_price_history h
                                LEFT JOIN leads l ON h.lead_id=l.id
                                WHERE h.item_id=?
                                ORDER BY h.created_at DESC
                                LIMIT ?`).all(itemId, limit);
  res.json(rows);
});

// ─── AI Settings (admin) ─────────────────────────────────────────────
// Mam pastes her Anthropic API key here, no SSH/.env editing needed.
// GET returns a masked key so the UI can show "configured / not configured"
// without ever sending the secret back to the browser.

router.get('/settings', adminOnly, (req, res) => {
  const key = getSetting('ai_api_key');
  res.json({
    provider: getSetting('ai_provider') || 'anthropic',
    model: getSetting('ai_model') || 'claude-opus-4-7',
    api_key_set: !!key,
    api_key_masked: key ? `${key.slice(0, 7)}…${key.slice(-4)}` : null,
  });
});

router.put('/settings', adminOnly, (req, res) => {
  const { provider, model, api_key } = req.body || {};
  if (provider) setSetting('ai_provider', String(provider).trim() || 'anthropic');
  if (model) setSetting('ai_model', String(model).trim() || 'claude-opus-4-7');
  if (typeof api_key === 'string' && api_key.trim()) {
    // Accept both bare keys and "sk-ant-..."; just trim and store.
    setSetting('ai_api_key', api_key.trim());
  }
  res.json({ message: 'AI settings saved' });
});

// Email (SMTP) settings — also lives in app_settings. Admin-only;
// password is never echoed back. Separate from the AI Agent settings
// so the UI can show two clear panels even though both go through this
// router. Recipient defaults to director@securedengineers.com (mam's
// loss-streak alert target).
router.get('/email-settings', adminOnly, (req, res) => {
  const host = getSetting('email_smtp_host');
  const user = getSetting('email_smtp_user');
  const pass = getSetting('email_smtp_pass');
  res.json({
    host: host || '',
    port: getSetting('email_smtp_port') || '587',
    secure: getSetting('email_smtp_secure') === '1',
    user: user || '',
    from: getSetting('email_from') || '',
    director_to: getSetting('email_director_to') || 'director@securedengineers.com',
    pass_set: !!pass,
    pass_masked: pass ? `${'•'.repeat(8)}${pass.slice(-2)}` : null,
  });
});

router.put('/email-settings', adminOnly, (req, res) => {
  const b = req.body || {};
  if (b.host !== undefined) setSetting('email_smtp_host', String(b.host).trim());
  if (b.port !== undefined) setSetting('email_smtp_port', String(b.port).trim() || '587');
  if (b.secure !== undefined) setSetting('email_smtp_secure', b.secure ? '1' : '0');
  if (b.user !== undefined) setSetting('email_smtp_user', String(b.user).trim());
  if (typeof b.pass === 'string' && b.pass.trim()) setSetting('email_smtp_pass', b.pass.trim());
  if (b.from !== undefined) setSetting('email_from', String(b.from).trim());
  if (b.director_to !== undefined) setSetting('email_director_to', String(b.director_to).trim());
  res.json({ message: 'Email settings saved' });
});

// Send a test email to confirm SMTP works.
router.post('/email-test', adminOnly, async (req, res) => {
  const to = (req.body?.to || '').trim() || getSetting('email_director_to') || 'director@securedengineers.com';
  try {
    const { sendEmail } = require('../lib/email');
    const r = await sendEmail({
      to,
      subject: '[SEPL ERP] Test email',
      html: '<p>This is a test email from SEPL ERP. SMTP is configured correctly.</p>',
      text: 'This is a test email from SEPL ERP. SMTP is configured correctly.',
    });
    if (r?.skipped) return res.status(400).json({ error: `Not configured: ${r.reason}` });
    res.json({ message: `Test email sent to ${to}`, messageId: r?.messageId });
  } catch (e) {
    res.status(502).json({ error: `Send failed: ${e.message}` });
  }
});

// Lets users with ai_agent.view check if the chatbot is configured so
// the floating bubble can render only for permitted users.
router.get('/status', requirePermission('ai_agent', 'view'), (req, res) => {
  res.json({ configured: !!getSetting('ai_api_key') });
});

// ─── Ask ERP (chatbot) ───────────────────────────────────────────────
// POST { question, history?: [{role,content}] } → { answer, sql_runs: [{query,row_count}] }
// Claude is given a SELECT-only "query_database" tool and a digest of the
// schema; it can make up to MAX_TOOL_ITER queries before returning a final
// natural-language answer.

const MAX_TOOL_ITER = 5;
// How often we flush a whitespace byte to the client to keep nginx
// from killing the upstream connection at its 60s proxy_read_timeout.
// 12s leaves plenty of margin under the default and is invisible to
// JSON.parse on the client (leading whitespace is allowed).
const HEARTBEAT_MS = 12_000;
// Wall-clock cap below Nginx's default 60s proxy_read_timeout so the
// chatbot fails fast with a readable error instead of mam seeing a 504.
// Used to be 50s to fail fast under nginx's 60s timeout. We now stream
// heartbeats so nginx no longer kills the upstream — bump this to 150s
// so deep Opus questions with multiple web_search iterations have room
// to complete instead of returning a "took too long" hint.
const ANTHROPIC_TIMEOUT_MS = 90_000;
const ROW_LIMIT = 500;

// Tables Claude is allowed to read. Skipping sensitive auth tables.
const READABLE_TABLES = new Set([
  'sites', 'leads', 'customers', 'item_master', 'item_price_history',
  'boq', 'boq_items', 'quotations', 'business_book', 'purchase_orders',
  'po_items', 'order_planning', 'indents', 'indent_items', 'vendor_pos',
  'vendor_po_items', 'purchase_bills', 'sales_bills', 'delivery_notes',
  'payments', 'cash_flow_entries', 'receivables', 'expenses', 'employees',
  'attendance', 'payment_requests', 'rent_requests', 'dpr', 'dpr_work_items',
  'dpr_material', 'dpr_machinery', 'dpr_manpower', 'dpr_contractors',
  'installations', 'complaints', 'snags', 'sales_funnel', 'company_assets',
]);

function buildSchemaDigest(db) {
  // Compact "table(col TYPE, col TYPE)" lines for every readable table.
  // Cached per process via getSchemaDigest below.
  const lines = [];
  for (const t of READABLE_TABLES) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all();
      if (!cols.length) continue;
      const colList = cols.map(c => `${c.name} ${c.type || ''}`.trim()).join(', ');
      lines.push(`${t}(${colList})`);
    } catch (_) {}
  }
  return lines.join('\n');
}
let _cachedDigest = null;
function getSchemaDigest(db) {
  if (!_cachedDigest) _cachedDigest = buildSchemaDigest(db);
  return _cachedDigest;
}

// SQL safety filter. Reject anything that isn't a single SELECT.
function validateSelect(sql) {
  if (typeof sql !== 'string') return 'Query must be a string';
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!trimmed) return 'Empty query';
  if (/;/.test(trimmed)) return 'Multiple statements not allowed';
  if (!/^\s*(SELECT|WITH)\s/i.test(trimmed)) return 'Only SELECT/WITH queries are allowed';
  // Quick deny-list — even inside a CTE/subquery, these tokens should never appear
  const banned = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|ATTACH|DETACH|REPLACE|PRAGMA|VACUUM)\b/i;
  if (banned.test(trimmed)) return 'Mutating keywords are not allowed';
  return null;
}

// ─── MODULE WORKFLOW GUIDES ────────────────────────────────────────
// Step-by-step instructions for every major ERP workflow. Surfaced to
// Claude as a `get_module_guide` tool so it can train staff in plain
// English / Hindi when they ask "how to ...". Keep keys short and
// snake_case so the model can call them reliably. Steps stay in
// English-language module names (so screenshots match) — the model
// translates to Hindi prose when the user asks for training in Hindi
// or writes Hindi.
const MODULE_GUIDES = {
  dpr: {
    title: 'DPR — Daily Progress Report',
    when_to_use: 'Site engineer fills this every day to report installation work, manpower, materials, machinery and contractor counts on a site.',
    steps: [
      'Open the **DPR** module from the left sidebar.',
      'Click **+ New DPR**.',
      'Pick the **Site** (Business Book project) from the dropdown.',
      'Fill **Report Date**, **Shift** (morning / day / full-day), **Weather**, and **Overall Status**.',
      'In the **Contractors** section: pick contractor names from the dropdown and enter their manpower count for the day. Use "+ Add Contractor" if more than 5.',
      'In **Work Items**: click a BOQ line and enter today\'s Qty done + Cumulative Qty. The Rate and Labour Rate auto-fill from the PO / Planning step.',
      'In **Manpower Costs**: enter each cost row (Type, Qty, Rate, Amount).',
      'In **Materials Consumed**: pick the item from PO, enter Consumed Today (in the item\'s UOM). Stock auto-decreases at the site warehouse.',
      'In **Machinery/Tools**: equipment, hours used, condition.',
      'Click **Submit DPR**. If you marked Loss for 3 consecutive days, an alert email auto-goes to the director.',
    ],
    permissions: 'Site engineers create. Admin / project head reviews. Module: dpr.create / dpr.view.',
    common_issues: [
      'If "Site" dropdown is empty: ask admin to create the project in **Business Book** first.',
      'If labour rate column is blank on a work item: the **Order Planning** step has no Labour Rate Sheet attached — admin needs to upload it on Orders → Planning.',
    ],
  },
  indent: {
    title: 'Indent — Material Requisition',
    when_to_use: 'Site team raises this when they need items from procurement (PO / FOC / RGP).',
    steps: [
      'Open **Procurement** → **Raise Indent** tab.',
      'Pick the **Site** from the dropdown — BOQ items for that site auto-load below.',
      'For each item you need: tick the row, pick a sub-item from **Item Master** (PO / FOC / RGP), set Qty and Make.',
      'For items not in Item Master: click **Manual** mode and type description, qty, unit.',
      'Click **Save as Draft** (you can edit later) or **Submit Indent** to send to purchase team.',
      'Once approved, purchase team gets 3 vendor quotes (Step 2) and finalizes one (Step 3), creating a Vendor PO.',
    ],
    permissions: 'Site can create. Purchase team can approve. Module: procurement.create / procurement.approve.',
    common_issues: [
      'If BOQ items don\'t load: the site needs a PO with a BOQ Excel uploaded in **Orders**.',
      'If you can\'t find an item in Item Master: raise a **Price Required** request first.',
    ],
  },
  price_required: {
    title: 'Price Required — New Item Request',
    when_to_use: 'When an item you need isn\'t yet in Item Master and needs vendor quotes before it can be used in an Indent.',
    steps: [
      'Open **Price Required** from the sidebar.',
      'Click **+ Raise Price Request** (single item) OR **Bulk Upload** (many items at once).',
      'For bulk: click **Template** to download Excel, fill rows for each item (Item Name, Size, Spec, Make, UOM, Type, Department), save, then **Bulk Upload** → pick the file.',
      'Each request appears in **All Requests** as **OPEN**.',
      'Purchase team enters 3 vendor rates per item (Vendor Rates tab), finalizes one. The item then auto-appears in **Item Master** as **ADDED** with a fresh item code like PO-0042.',
    ],
    permissions: 'Any user creates. Purchase / Admin quotes & finalizes. Module: procurement.approve.',
  },
  vendor_po: {
    title: 'Vendor PO — Send Order to Supplier',
    when_to_use: 'After the purchase team finalizes vendor rates on indented items, a Vendor PO is created to lock the order.',
    steps: [
      'Open **Procurement → Vendor PO** tab.',
      'Click **+ Create Vendor PO**.',
      'Pick the **Indent** — its finalized items auto-list with rate + qty.',
      'Set credit days, T&C, payment terms.',
      'Click **Create Vendor PO** — system generates VPO/YYYY/#### number.',
      'Upload the signed PO PDF if you have a hard copy.',
    ],
    permissions: 'Procurement.approve only.',
  },
  purchase_bill: {
    title: 'Purchase Bill — Record Vendor Invoice',
    when_to_use: 'When the vendor sends their invoice after delivery, record it here against the Vendor PO.',
    steps: [
      'Open **Procurement → Purchase Bills** tab.',
      'Click **+ Add Bill**.',
      'Pick the **Vendor PO** — totals auto-fill.',
      'Enter Bill Number, Bill Date, Amount, GST.',
      'Upload the vendor\'s invoice file (PDF / image).',
      'Click **Save** — the bill is now linked to that Vendor PO and gates the Dispatch step.',
    ],
    permissions: 'Procurement.approve only.',
  },
  sales_bill: {
    title: 'Sales Bill — Tax Invoice to Client',
    when_to_use: 'Send a tax invoice to the client after dispatching billable goods.',
    steps: [
      'Open **Procurement → Dispatch & Receiving** tab.',
      'Find the Vendor PO in "Ready to Dispatch" → click **Create Sales Bill / Delivery Note**.',
      'Pick **Sales Bill** as dispatch type. Document number auto-generates as INV/YYYY/####.',
      'Edit the line items grid — qty / rate / disc % per row. Rate column pre-fills from the Client PO (selling price). Uncheck rows you\'re not dispatching today.',
      'Fill **Place of Supply**, **State Code**, **CGST %** (9% for Punjab), **SGST %** (9%), or **IGST %** (18% for inter-state).',
      'Click **Create Sales Bill** — ERP generates the SEPL-format Tax Invoice in a new tab. Ctrl+P to print on A4.',
      'After delivery, open the dispatch row and click **Mark Received** — upload the client\'s stamped + signed copy.',
    ],
    permissions: 'Procurement.approve only.',
    common_issues: [
      'If Bill To / Ship To fields are blank: open the Business Book lead and fill GSTIN, State Code, Billing Address, Shipping Address.',
    ],
  },
  delivery_challan: {
    title: 'Delivery Challan — FOC / RGP Dispatch',
    when_to_use: 'For FOC (Free of Cost) or RGP (Returnable Gate Pass) dispatches that are NOT billable.',
    steps: [
      'Open **Procurement → Dispatch & Receiving** → **Create Sales Bill / Delivery Note**.',
      'Pick **Delivery Challan** as the dispatch type. Document number auto-generates as DC/YYYY/####.',
      'Items grid hides Rate / Disc / Amount columns (challan is not billable).',
      'Fill **Vehicle No.**, **Driver Name + Mobile**, **LR / Challan No.**, **Total Packages**.',
      'Click **Create Delivery Note** — ERP generates the SEPL-format DN; print on A4 and send with the truck.',
    ],
  },
  order_planning: {
    title: 'Order Planning + Labour Rates',
    when_to_use: 'Plan when execution starts/ends for a PO AND upload the Labour Rate Sheet so DPR can use those rates.',
    steps: [
      'Open **Orders → Order Planning** tab.',
      'Click **+ Create Plan**.',
      'Pick the **Purchase Order** — its BOQ items auto-load below.',
      'Set **Planned Start** and **Planned End** dates.',
      'Click **Upload Labour Rate & Match** → pick the Excel labour-rate sheet. Each row is matched to a BOQ item by SN / description.',
      'Verify the Labour Rate column — edit any row inline if a match looks off.',
      'Click **Save Plan + Labour Rates** — labour rates are saved on po_items and auto-flow into DPR when site engineer fills daily progress.',
    ],
  },
  business_book: {
    title: 'Business Book — Add Client Lead',
    when_to_use: 'Capture a new client / project. This is the root record everything (PO, Planning, DPR, Sales Bill, Cash Flow) links to.',
    steps: [
      'Open **Business Book** from the sidebar.',
      'Click **+ Add Entry**.',
      'Fill **Client Name** (required), **Company/Department**, **Project Name**.',
      'Location & Address: State, **State Code** (e.g. 03 for Punjab), **Client GSTIN**, Billing Address, Shipping Address.',
      'Project & Order details + Payment Terms.',
      'Save — system generates lead number like SEPL20042, and auto-creates the Order Planning + DPR Site + Receivable + Cash Flow row.',
    ],
    common_issues: [
      'Fill GSTIN and State Code so generated Sales Bills auto-populate them.',
    ],
  },
  quotation: {
    title: 'Quotation — Send Price Quote to Client',
    when_to_use: 'Before the client raises a PO, send them a quotation for an enquiry.',
    steps: [
      'Open **Quotations** from sidebar.',
      'Click **+ New Quotation**.',
      'Pick the **Lead** (Business Book entry).',
      'Add BOQ items inline OR upload an Excel BOQ.',
      'System auto-generates QUO-#### number.',
      'Click **Send** → download PDF and email to client.',
    ],
  },
  cash_flow: {
    title: 'Cash Flow — Daily Inflows / Outflows',
    when_to_use: 'Track every Rs in and out of SEPL\'s bank/cash each day.',
    steps: [
      'Open **Cash Flow** from sidebar.',
      'Top cards show today\'s opening, total in, total out, closing for the picked date.',
      'Click **+ Add Entry** to add an inflow (client payment) or outflow (vendor payment, salary, etc.).',
      'Pick category, party, amount, mode (cash / bank / UPI / cheque).',
      'Save — the day\'s totals + the closing balance auto-update.',
    ],
  },
  expense: {
    title: 'Expense — Record Site or Office Expense',
    when_to_use: 'Petty cash, travel, food, fuel, etc.',
    steps: [
      'Open **Expenses** from sidebar.',
      'Click **+ Add Expense**.',
      'Pick **Category** (Travel / Food / Fuel / Material etc.), **Site** (if site-specific), **Date**, **Amount**, **Mode**.',
      'Attach a bill photo if you have one.',
      'Save — appears in Cash Flow as outflow automatically once Paid.',
    ],
  },
  attendance: {
    title: 'Attendance — Mark In / Out',
    when_to_use: 'Daily attendance for office + site staff.',
    steps: [
      'Open **Attendance** from sidebar.',
      'Tap **Mark In** at start of day (records timestamp + GPS).',
      'At end of day tap **Mark Out**.',
      'Admin can view all attendance, mark leave, approve leave requests in the same module.',
    ],
  },
  dpr_loss_alert: {
    title: 'DPR Loss-Day Alert',
    when_to_use: 'Auto-runs — no manual action needed.',
    steps: [
      'When a DPR is submitted and that day\'s net (Sale Value − Cost) is negative, the site enters a "loss day" streak.',
      'If 3 consecutive days are loss, the ERP auto-emails director@securedengineers.com with the site, the 3 dates, and the loss amounts.',
      'Configure the SMTP credentials in **Admin → Email Settings** for the email to actually send.',
    ],
  },
};
const GUIDE_KEYS = Object.keys(MODULE_GUIDES);

// Hard-cap the row count so a model-generated query with no LIMIT (e.g. an
// accidental cartesian join) can't materialize the whole DB and freeze the
// synchronous SQLite engine for every request (audit 2026-06-12).  We only
// ADD a LIMIT when the query has none — column output is unchanged.
function capSql(sql) {
  const trimmed = String(sql).trim().replace(/;\s*$/, '');
  if (/\blimit\s+\d+(\s*,\s*\d+|\s+offset\s+\d+)?\s*$/i.test(trimmed)) return trimmed;
  return `${trimmed} LIMIT ${ROW_LIMIT + 1}`;
}

function safeRunQuery(db, sql) {
  const err = validateSelect(sql);
  if (err) return { error: err };
  try {
    const stmt = db.prepare(capSql(sql));
    const rows = stmt.all();
    const truncated = rows.length > ROW_LIMIT;
    return {
      row_count: rows.length,
      truncated,
      rows: truncated ? rows.slice(0, ROW_LIMIT) : rows,
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Google Gemini path (mam 2026-06-15: wants a FREE AI key) ───────────────
// Runs the agent against Gemini's NATIVE generateContent API so we get BOTH
// our function tools (read the ERP DB + module guides) AND Google Search
// grounding — so it can quote live MARKET RATES, not only ERP data (mam:
// "not satisfied ... give me rate from market also"). Search grounding is
// handled server-side by Gemini; we only execute our own function calls.
async function runGeminiAgent({ apiKey, model, systemPrompt, history, question, db }) {
  if (typeof fetch !== 'function') {
    const e = new Error('This server\'s Node is too old for Gemini (needs Node 18+).'); e.status = 500; throw e;
  }
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const functionDeclarations = [
    {
      name: 'query_database',
      description: 'Run a single read-only SQL query (SELECT or WITH only) against the ERP SQLite DB. Returns rows as JSON, max 500 rows.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'A single SELECT/WITH query. No semicolons, no DDL/DML.' } }, required: ['query'] },
    },
    {
      name: 'get_module_guide',
      description: 'Look up the official step-by-step guide for an ERP module. Use for any "how to" / training / workflow question.',
      parameters: { type: 'object', properties: { module: { type: 'string', enum: GUIDE_KEYS, description: `Module key — one of: ${GUIDE_KEYS.join(', ')}.` } }, required: ['module'] },
    },
  ];
  // Both tools: our functions + Google Search grounding (for market rates).
  let tools = [{ function_declarations: functionDeclarations }, { google_search: {} }];

  const contents = [];
  for (const m of history) {
    if (!m || !m.role || !m.content) continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content).slice(0, 4000) }] });
  }
  contents.push({ role: 'user', parts: [{ text: question }] });

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // Free-tier rate limits (429) are usually per-minute and clear quickly —
  // retry with backoff so a transient limit doesn't surface as an error
  // (mam 2026-06-15). The route's heartbeat keeps the connection alive while
  // we wait.
  const post = async (body, retries = 2) => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      });
      if (r.status !== 429 || attempt >= retries) return r;
      await sleep(4000 * (attempt + 1)); // 4s, then 8s
    }
  };

  const sqlRuns = [];
  let answer = '';
  for (let iter = 0; iter < MAX_TOOL_ITER; iter++) {
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents, tools,
      generationConfig: { temperature: 0.2, maxOutputTokens: 4000 },
    };
    let r = await post(body);
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      // Some models reject Search-grounding + function-calling together —
      // retry once with our function tools only so the chat still works.
      if (tools.length > 1 && /(tool|search|grounding|function)/i.test(txt)) {
        tools = [{ function_declarations: functionDeclarations }];
        r = await post({ ...body, tools });
        if (!r.ok) { const t2 = await r.text().catch(() => ''); const e = new Error(t2 || `Gemini HTTP ${r.status}`); e.status = r.status; throw e; }
      } else {
        const e = new Error(txt || `Gemini HTTP ${r.status}`); e.status = r.status; throw e;
      }
    }
    const data = await r.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const fnCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
    if (!fnCalls.length) {
      answer = parts.filter(p => p.text).map(p => p.text).join('\n').trim();
      break;
    }
    contents.push({ role: 'model', parts });
    const responseParts = [];
    for (const fc of fnCalls) {
      const args = fc.args || {};
      let resultObj;
      if (fc.name === 'query_database') {
        const result = safeRunQuery(db, args.query || '');
        sqlRuns.push({ query: args.query, row_count: result.row_count ?? 0, error: result.error || null });
        resultObj = result;
      } else if (fc.name === 'get_module_guide') {
        resultObj = MODULE_GUIDES[String(args.module || '').toLowerCase().trim()] || { error: `Unknown module. Available: ${GUIDE_KEYS.join(', ')}` };
      } else {
        resultObj = { error: `unknown tool ${fc.name}` };
      }
      let safe = resultObj;
      try { if (JSON.stringify(resultObj).length > 50000) safe = { note: 'truncated', data: JSON.stringify(resultObj).slice(0, 50000) }; } catch (_) {}
      responseParts.push({ functionResponse: { name: fc.name, response: { result: safe } } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }
  return { answer: answer || '(no answer)', sqlRuns };
}

router.post('/ask', requirePermission('ai_agent', 'view'), async (req, res) => {
  const apiKey = getSetting('ai_api_key');
  if (!apiKey) {
    return res.status(400).json({
      error: 'AI Agent not configured. Ask an admin to paste an API key in Admin → AI Settings.',
    });
  }
  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: 'question required' });
  const priorHistory = Array.isArray(req.body?.history) ? req.body.history.slice(-10) : [];

  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch (e) {
    return res.status(500).json({ error: '@anthropic-ai/sdk not installed on the server. Run `npm install` on the VPS.' });
  }

  // Open a chunked response and start writing tiny heartbeats so nginx's
  // 60s proxy_read_timeout doesn't kill the upstream while Claude is
  // working. X-Accel-Buffering disables nginx's own response buffering.
  // The client (axios → JSON.parse) ignores the leading whitespace.
  // Helper sendJson() bundles the JSON body + ends the stream cleanly.
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.write(' '); // immediate flush so nginx starts its activity timer
  const heartbeat = setInterval(() => {
    try { res.write(' '); } catch (_) {}
  }, HEARTBEAT_MS);
  // If mam closes the chat panel mid-call, stop the heartbeat so it
  // doesn't keep firing into a dead socket.
  req.on('close', () => clearInterval(heartbeat));
  const sendJson = (status, payload) => {
    clearInterval(heartbeat);
    if (!res.headersSent) res.status(status); // status only settable before first write... but we already wrote, so this is a no-op safety
    // For error payloads we still want a 502-style outcome — but we
    // already committed to 200 on the first write. Express keeps the
    // status from the first write, so the client always gets 200 here.
    // The body's "error" field carries the real outcome — frontend
    // already handles that case via toast on err.response?.data?.error
    // OR a missing "answer" key.
    res.end(JSON.stringify(payload));
  };

  // Everything from here on runs AFTER the chunked response + heartbeat have
  // started. If anything throws before we send the JSON body, the stream (and
  // its 12s heartbeat) would keep the socket open forever and the chat sits on
  // "…" (mam 2026-07-06 "ai chat is not working"). This outer try guarantees we
  // always end the response with an answer or a readable error.
  try {
  const db = getDb();
  const client = new Anthropic.default({ apiKey, timeout: ANTHROPIC_TIMEOUT_MS });
  const model = getSetting('ai_model') || 'claude-opus-4-7';
  // Adaptive thinking + effort + Anthropic-server-side tools (web_search)
  // are Opus/Sonnet-4.6-only. Haiku 4.5 either 400s or pushes the request
  // past Nginx's 60s proxy_read_timeout. Used below to conditionally
  // attach those request params and tools.
  const supportsAdaptive = /^claude-(opus-4-[67]|sonnet-4-6)/.test(model);

  // WHO is logged in.  Without this, when the user asks "who is monika"
  // the model has no idea SHE is monika — it just sees an ambiguous
  // name and asks for clarification (mam, 2026-05-15).  Pulling the
  // current user's row from the users table (no password column) and
  // their employee record gives the model concrete identity context.
  let currentUserBlock = '(unknown user)';
  try {
    const u = db.prepare('SELECT id, name, email, username, role, department, phone FROM users WHERE id=?').get(req.user.id);
    const emp = db.prepare('SELECT designation, department, phone, email, status FROM employees WHERE LOWER(name) = LOWER(?) OR user_id=? LIMIT 1').get(u?.name || '', req.user.id);
    if (u) {
      const parts = [
        `Name: ${u.name}`,
        u.username ? `Username: ${u.username}` : null,
        u.email ? `Email: ${u.email}` : null,
        `Role: ${u.role}`,
        (emp?.designation || u.department) ? `Designation/Dept: ${emp?.designation || u.department}` : null,
      ].filter(Boolean);
      currentUserBlock = parts.join(' · ');
    }
  } catch (_) {}

  const systemPrompt = `You are the AI assistant inside Headmasters, a salon & spa business in India (the software platform is Sotyn). You have THREE tools and you are EXPECTED to use them when relevant:

WHO IS ASKING RIGHT NOW:
  ${currentUserBlock}
If a question is about the asker themselves (e.g. "who am I", "kya mera salary hai", "show my attendance"), use the identity above and don't ask them to repeat it.  If a person is mentioned by first name that matches the current user, assume they mean themselves unless context says otherwise.

1. query_database — read the salon database (clients, appointments, services, stylists, sales/invoices, memberships, retail products, loyalty points, attendance, employees, etc.). Use this for ANY question about the salon's own data.

2. web_search — search the live internet. Use this PROACTIVELY for: beauty/salon product prices and brand info, haircare/skincare trends, GST rate lookups, supplier company details, or any fact that lives outside our database.

3. get_module_guide — pull built-in step-by-step instructions for an ERP module. Use this WHENEVER the user asks "how to ...", "kaise karte hai...", "training", "guide me through ...", or asks how to submit / create / file something. Valid module keys: ${GUIDE_KEYS.join(', ')}. Always call this BEFORE saying "I don't know how" — the answer is almost always in the guide.

PERSON-BY-NAME LOOKUPS — when a user asks "who is X", "tell me about X", "X kaun hai", or any question naming a person:
  a) First check if X matches the current user identity above.  If yes, answer using that.
  b) Otherwise call query_database with: SELECT id, name, designation, department, phone, email, status, join_date FROM employees WHERE LOWER(name) LIKE LOWER('%X%').  This covers every SEPL employee.
  c) If still no match, try business_book.employee_assigned / .crm_person, vendors.contact_person, customers.concern_person_name — they're SEPL's external-facing contacts.
  d) Only ask for clarification if (a), (b), AND (c) all came up empty.

Default behaviour for ITEM RATE questions:
- Always query_database for our internal rate first.
- Then web_search the same item on the public Indian web (IndiaMART / Justdial / market portals) for today's price range.
- Present BOTH side by side so the user can see if we're competitive.

LANGUAGE — TRAINING REPLIES:
- If the user writes in Hindi (Devanagari OR Roman-Hindi like "kaise", "kaisa", "kya", "kar do"), reply in Hindi.
- If the user asks "how to ..." or asks for training / guidance, reply in BOTH Hindi (Devanagari prose) AND keep module / button / field names in English so screenshots match the UI. Hindi explains "what to do"; English keeps the literal labels.
- Format step-by-step answers as a numbered list. Bold the literal button text using **markdown** so the user can spot it on screen.
- Keep tone warm and respectful — say "aap" (आप) not "tu". You're talking to mam or to staff she trained.
- For non-training data questions in English, reply in English.

Combine the tools when useful. Money is in Indian Rupees (Rs) — Indian-style formatting (e.g. "Rs 12,50,000"). Be specific: include names, numbers, dates. If a question is ambiguous, make one reasonable assumption and state it. Never invent data — only report what the tools return. When you cite a web-search number, mention the source briefly ("per IndiaMART today").

Database schema (SQLite). Only SELECT/WITH queries are allowed; the tool will reject anything else.

${getSchemaDigest(db)}

Guidance:
- Prefer JOINs over multiple round-trip queries when sensible.
- Use date('now') / datetime('now', '-N days') for recency filters.
- LIMIT large result sets (≤ 100 rows for display).
- For "rates": ALWAYS read item_master.current_price + item_price_history AND web_search for the market price. Show both.
- If they ask about overdue payments, sales_bills with payment_status='pending' or 'partial' is the first place to check; receivables also tracks this.
- If they ask "who", join with employees on the relevant *_by columns.`;

  // Read-only SQL on the local ERP is always available.
  const tools = [
    {
      name: 'query_database',
      description: 'Run a single read-only SQL query (SELECT or WITH only) against the ERP SQLite database. Returns rows as JSON. Limited to 500 rows per query; the response indicates if truncated.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A single SELECT/WITH query. No semicolons, no DDL/DML.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_module_guide',
      description: 'Look up the official step-by-step guide for an ERP module. Use this for any "how to ...", "kaise karte hai", training, or workflow question BEFORE saying you don\'t know. Returns title, when_to_use, step-by-step instructions, required permissions, and common issues.',
      input_schema: {
        type: 'object',
        properties: {
          module: {
            type: 'string',
            description: `Module key — must be one of: ${GUIDE_KEYS.join(', ')}.`,
            enum: GUIDE_KEYS,
          },
        },
        required: ['module'],
      },
    },
  ];
  // Web search available on every model — mam: "i want real ai agent
  // which scan from all over not only from my ERP". Haiku used to
  // 504 because it triggered many web-search iterations past Nginx's
  // 60s timeout; that's mitigated now by ANTHROPIC_TIMEOUT_MS=50s
  // (fails fast with a readable error) + MAX_TOOL_ITER=5.
  // allowed_callers: ['direct'] keeps the tool usable on Haiku
  // (it doesn't support programmatic tool calling).
  tools.push({ type: 'web_search_20260209', name: 'web_search', allowed_callers: ['direct'] });

  // Build conversation history
  const messages = [];
  for (const m of priorHistory) {
    if (!m || !m.role || !m.content) continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    messages.push({ role: m.role, content: String(m.content).slice(0, 4000) });
  }
  messages.push({ role: 'user', content: question });

  // ── Provider fork: Google Gemini (free) vs Anthropic ─────────────────────
  const provider = (getSetting('ai_provider') || 'anthropic').toLowerCase();
  if (provider === 'gemini' || provider === 'google') {
    const gStart = Date.now();
    let gmodel = getSetting('ai_model');
    if (!gmodel || !/gemini/i.test(gmodel)) gmodel = 'gemini-2.0-flash';
    try {
      const { answer, sqlRuns } = await runGeminiAgent({ apiKey, model: gmodel, systemPrompt, history: priorHistory, question, db });
      console.log(`[AI Agent /ask] ok ${gmodel} (gemini) elapsed=${Date.now() - gStart}ms sqlRuns=${sqlRuns.length}`);
      return sendJson(200, { answer, sql_runs: sqlRuns, model: gmodel });
    } catch (e) {
      console.error('[AI Agent /ask] Gemini call failed:', e.status, e.message);
      let hint = '';
      if (e.status === 401 || e.status === 403) hint = ' Check the Gemini API key in Admin → AI Settings.';
      else if (e.status === 429) hint = ' Gemini free-tier quota hit (even after auto-retry). If this keeps happening you\'ve likely used the daily free limit — wait a while, slow down between questions, or switch to Anthropic Haiku in Admin → AI Settings.';
      return sendJson(200, { error: `AI request failed (Gemini): ${String(e.message).slice(0, 300)}${hint}` });
    }
  }

  // supportsAdaptive declared earlier; reused for both adaptive thinking
  // params here and the conditional web_search tool above.
  const baseParams = {
    model,
    max_tokens: 16000,
    system: systemPrompt,
    tools,
  };
  if (supportsAdaptive) {
    baseParams.thinking = { type: 'adaptive' };
    baseParams.output_config = { effort: 'high' };
  }

  const sqlRuns = [];
  let response;
  const startMs = Date.now();
  try {
    for (let iter = 0; iter < MAX_TOOL_ITER; iter++) {
      // Wall-clock cap across iterations so a long agentic run never leaves the
      // chat hanging — return whatever we have so far instead of spinning.
      if (Date.now() - startMs > 110_000) break;
      response = await client.messages.create({ ...baseParams, messages });

      if (response.stop_reason === 'end_turn' || response.stop_reason === 'refusal') break;

      // pause_turn: Anthropic-side tool (web_search) hit its server-side
      // iteration limit. Re-send the same conversation with the assistant
      // turn appended; the server resumes web_search from where it left off.
      // No client-side action needed.
      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }

      if (response.stop_reason !== 'tool_use') break;

      // Append assistant turn verbatim (preserves thinking/tool_use blocks)
      messages.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        if (block.name === 'query_database') {
          const sql = block.input?.query || '';
          const result = safeRunQuery(db, sql);
          sqlRuns.push({ query: sql, row_count: result.row_count ?? 0, error: result.error || null });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result).slice(0, 50000),
            is_error: !!result.error,
          });
        } else if (block.name === 'get_module_guide') {
          const wanted = String(block.input?.module || '').toLowerCase().trim();
          const guide = MODULE_GUIDES[wanted];
          if (!guide) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify({ error: `Unknown module "${wanted}". Available modules: ${GUIDE_KEYS.join(', ')}` }),
              is_error: true,
            });
          } else {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(guide).slice(0, 50000),
              is_error: false,
            });
          }
        }
        // Other tools (web_search) are server-side at Anthropic; nothing
        // for us to do — Anthropic injects its own tool_result block.
      }
      if (!toolResults.length) break;
      messages.push({ role: 'user', content: toolResults });
    }
  } catch (e) {
    const elapsedMs = Date.now() - startMs;
    console.error(`[AI Agent /ask] Anthropic call failed after ${elapsedMs}ms:`, e.message);
    const status = e?.status || 500;
    let hint = '';
    if (status === 401) hint = ' Your API key is invalid — update it in Admin → AI Settings.';
    else if (status === 429) hint = ' Rate limited by Anthropic — wait a few seconds and try again.';
    else if (e?.code === 'ETIMEDOUT' || /timeout/i.test(e?.message || '')) {
      hint = ' Request took too long — try a more specific question, or switch to Claude Opus in Admin → AI Settings.';
    }
    // We've already streamed heartbeat bytes — status code is locked to
    // 200, so the error has to ride along in the body and the frontend
    // checks data.error before data.answer.
    return sendJson(200, { error: `AI request failed: ${e.message}${hint}`, elapsed_ms: elapsedMs });
  }

  const answer = (response?.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  const elapsedMs = Date.now() - startMs;
  console.log(`[AI Agent /ask] ok ${model} elapsed=${elapsedMs}ms sqlRuns=${sqlRuns.length} stop=${response?.stop_reason}`);
  sendJson(200, {
    answer: answer || '(no answer)',
    sql_runs: sqlRuns,
    stop_reason: response?.stop_reason,
    elapsed_ms: elapsedMs,
  });
  } catch (fatal) {
    // Safety net for any error raised OUTSIDE the Anthropic-call try above
    // (system-prompt build, tool setup, answer extraction). Without this the
    // heartbeat keeps the stream open and the chat hangs on "…" forever.
    console.error('[AI Agent /ask] fatal (outside call loop):', fatal?.message);
    try { if (!res.writableEnded) sendJson(200, { error: `AI request failed: ${fatal?.message || 'unknown error'}` }); } catch (_) {}
  }
});

module.exports = router;
