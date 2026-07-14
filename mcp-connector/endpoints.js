// ---------------------------------------------------------------------------
// SEPL ERP — read-only endpoint catalogue.
//
// EVERY entry here is a GET endpoint. The connector physically only ever issues
// GET requests (see callApi() in server.js), so nothing in the ERP can be
// created, edited or deleted through it no matter what Claude is asked to do.
//
// To expose a new report: add a row here. `name` becomes the Claude tool name,
// `path` is the ERP API path, `params` (optional) documents accepted query
// params so Claude knows how to filter. Keep names snake_case and stable.
// ---------------------------------------------------------------------------

export const ENDPOINTS = [
  // ---- Approvals & Payments -------------------------------------------------
  {
    name: 'get_payment_requests',
    path: '/api/payment-required',
    desc: 'List payment requests. Filter by approval stage to see what is stuck where.',
    params: { status: 'optional — e.g. pending / l1 / l2 / l3 / release / approved / rejected', q: 'optional text search' },
  },
  {
    name: 'get_payment_stats',
    path: '/api/payment-required/stats',
    desc: 'Summary counts/amounts of payment requests by status.',
  },
  {
    name: 'get_payment_inbox_count',
    path: '/api/payment-required/my-inbox-count',
    desc: 'Count of payment requests waiting in the service account\'s approval inbox.',
  },
  {
    name: 'get_cheques',
    path: '/api/cheques',
    desc: 'List cheques (issued/received/cleared/pending).',
    params: { status: 'optional cheque status filter' },
  },
  {
    name: 'get_cheque_summary',
    path: '/api/cheques/stats/summary',
    desc: 'Cheque totals/summary by status.',
  },

  // ---- Finance & Cashflow ---------------------------------------------------
  {
    name: 'get_dashboard',
    path: '/api/dashboard',
    desc: 'Top-level ERP KPI dashboard.',
  },
  {
    name: 'get_ar_ap_tracker',
    path: '/api/ar-ap-tracker',
    desc: 'AR/AP weekly cash-flow tracker rows (receivables + payables).',
  },
  {
    name: 'get_ar_ap_summary',
    path: '/api/ar-ap-tracker/summary',
    desc: 'AR/AP tracker summary totals.',
  },
  {
    name: 'get_cashflow_summary',
    path: '/api/cashflow/summary',
    desc: 'Cashflow summary (balances/inflow/outflow).',
  },
  {
    name: 'get_cashflow_today',
    path: '/api/cashflow/today',
    desc: 'Today\'s cashflow position.',
  },
  {
    name: 'get_cashflow_project_breakdown',
    path: '/api/cashflow/project-breakdown',
    desc: 'Cashflow broken down by project.',
  },
  {
    name: 'get_collections',
    path: '/api/collections',
    desc: 'Collections / receivables list with ageing.',
  },
  {
    name: 'get_collections_summary',
    path: '/api/collections/summary',
    desc: 'Collections summary totals.',
  },
  {
    name: 'get_collections_md_dashboard',
    path: '/api/collections/md-dashboard',
    desc: 'MD-level collections dashboard.',
  },

  // ---- Projects & DPR -------------------------------------------------------
  {
    name: 'get_dpr_summary',
    path: '/api/dpr/summary',
    desc: 'DPR summary — labour cost / manpower / progress per project.',
    params: { site_id: 'optional — restrict to one site' },
  },
  {
    name: 'get_dpr_sites',
    path: '/api/dpr/sites',
    desc: 'List of DPR project sites.',
  },
  {
    name: 'get_dpr_loss_dashboard',
    path: '/api/dpr/loss-dashboard',
    desc: 'DPR loss / cost-overrun dashboard.',
  },
  {
    name: 'get_dpr_progress',
    path: '/api/dpr/progress',
    desc: 'DPR physical-progress data.',
  },

  // ---- Sales, Indents & Procurement ----------------------------------------
  {
    name: 'get_sales_funnel',
    path: '/api/sales-funnel',
    desc: 'Sales funnel leads/opportunities.',
    params: { stage: 'optional funnel stage filter' },
  },
  {
    name: 'get_sales_funnel_dashboard',
    path: '/api/sales-funnel/dashboard',
    desc: 'Sales funnel dashboard (stage-wise totals).',
  },
  {
    name: 'get_indents',
    path: '/api/procurement/indents',
    desc: 'Procurement indents list with status.',
    params: { status: 'optional indent status filter' },
  },
  {
    name: 'get_indent_tracker',
    path: '/api/indent-fms/tracker',
    desc: 'Indent-to-dispatch FMS tracker (stage of each indent).',
  },
  {
    name: 'get_indent_pipeline',
    path: '/api/indent-fms/pipeline',
    desc: 'Indent FMS pipeline view.',
  },
  {
    name: 'get_vendors',
    path: '/api/procurement/vendors',
    desc: 'Vendor master list.',
  },
  {
    name: 'get_vendor_pos',
    path: '/api/procurement/vendor-po',
    desc: 'Vendor purchase orders with approval status.',
  },
  {
    name: 'get_quotations',
    path: '/api/quotations',
    desc: 'Quotations list.',
  },
];

// Path prefixes the generic `erp_get` tool is allowed to call. Any GET path
// under these prefixes is permitted; everything else is refused. This lets
// Claude reach read endpoints not individually listed above WITHOUT opening up
// the whole API. Deliberately excludes auth/admin/backup/user-management paths.
export const ALLOWED_GET_PREFIXES = [
  '/api/dashboard',
  '/api/dashboards',
  '/api/payment-required',
  '/api/cheques',
  '/api/ar-ap-tracker',
  '/api/cashflow',
  '/api/collections',
  '/api/dpr',
  '/api/sales-funnel',
  '/api/procurement',
  '/api/indent-fms',
  '/api/quotations',
  '/api/orders',
  '/api/customers',
  '/api/item-master',
  '/api/inventory',
  '/api/hr',
  '/api/attendance',
  '/api/payroll',
  '/api/raci',
];
