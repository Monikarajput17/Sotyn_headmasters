# CMD Audit API — Master Prompt v3

Read-only, token-authenticated JSON endpoints that summarise the ERP
state for the daily 9 AM CMD audit email.

## Base URL

```
https://securederp.in/audit
```

(Note: this is **outside** the `/api/*` namespace by design. It is
meant for server-to-server use by an external scheduler / AI agent
and does not participate in the browser session.)

## Authentication

Bearer token in the `Authorization` header **or** `token` query string.

```bash
# Header form (preferred)
curl -H "Authorization: Bearer $AUDIT_API_TOKEN" https://securederp.in/audit

# Query string form (useful for one-shot scheduled HTTP probes)
curl "https://securederp.in/audit?token=$AUDIT_API_TOKEN"
```

The token is set on the server via the `AUDIT_API_TOKEN` environment
variable. Must be **≥ 8 characters**. Until the variable is set, every
audit endpoint returns:

```json
HTTP 503
{ "error": "audit_token_unconfigured",
  "hint": "Set AUDIT_API_TOKEN (>=8 chars) in the server environment" }
```

Wrong/missing token returns `HTTP 401 { "error": "unauthorized" }`.

---

## `GET /audit` — Daily digest

Returns the full report in one call: 12 KPI tiles plus the 5 exception
lists. This is what the 9 AM email job consumes.

### Response shape

```jsonc
{
  "spec_version": "v3",
  "generated_at": "2026-05-13T03:30:00.123Z",
  "duration_ms": 47,
  "database": {
    "path": "/root/erp/data/erp.db",
    "size_bytes": 184320000,
    "last_modified": "2026-05-13T03:29:58.000Z"
  },
  "kpis": [
    { "id": "active_sites",            "label": "Active Sites",                "value": 23,        "unit": "count" },
    { "id": "open_pos",                "label": "Open Purchase Orders",        "value": 51,        "unit": "count" },
    { "id": "mtd_sale_value",          "label": "MTD Sale Value (ex-GST)",     "value": 12450000,  "unit": "inr"   },
    { "id": "mtd_received",            "label": "MTD Cash Received",           "value": 8720000,   "unit": "inr"   },
    { "id": "outstanding_receivables", "label": "Total Outstanding Receivables","value": 4380000,  "unit": "inr"   },
    { "id": "overdue_receivables",     "label": "Overdue (>60d) Receivables",  "value": 7,         "unit": "count" },
    { "id": "dpr_submitted_today",     "label": "DPRs Submitted Today",        "value": 0,         "unit": "count" },
    { "id": "dpr_missing_today",       "label": "Sites Missing DPR Today",     "value": 23,        "unit": "count" },
    { "id": "pending_payment_requests","label": "Pending Payment Requests",    "value": 14,        "unit": "count" },
    { "id": "pending_indents",         "label": "Pending Indents",             "value": 9,         "unit": "count" },
    { "id": "active_employees",        "label": "Active Employees",            "value": 42,        "unit": "count" },
    { "id": "cheques_open",            "label": "Cheques Awaiting Action",     "value": 6,         "unit": "count" }
  ],
  "exceptions": {
    "duplicates":        { "description": "...", "count": 3, "items": [ /* see below */ ] },
    "arithmetic_errors": { "description": "...", "count": 1, "items": [ ... ] },
    "missing_required":  { "description": "...", "count": 8, "items": [ ... ] },
    "stale_records":     { "description": "...", "count": 5, "items": [ ... ] },
    "schema_drift":      { "description": "...", "count": 0, "items": [] }
  },
  "summary": {
    "kpi_count": 12,
    "total_exceptions": 17,
    "critical_exceptions": 0
  }
}
```

### KPI tile contract

Each tile has a stable `id` (never changes — safe for the email
template to address by id) and a human-readable `label`. `unit` is one
of `count` (whole number) or `inr` (Indian rupees, already rounded).

### Exception item shapes

| List | Item fields |
|---|---|
| `duplicates` | `table`, `kind`, `key`, `count`, `ids`, `severity?` |
| `arithmetic_errors` | `table`, `id`, `ref`, `expected`, `actual`, `diff` |
| `missing_required` | `table`, `id`, `ref`, `missing` (array of column names) |
| `stale_records` | `table`, `id`, `ref`, `reason`, `age_days?` |
| `schema_drift` | `table`, `kind`, `missing?`, `detail?`, `severity` |

`severity: "critical"` is set on items the audit considers data
integrity violations (duplicate PO numbers, missing tables, missing
required columns). The summary's `critical_exceptions` counts these.

Item lists are capped at **100 rows per check** so the response stays
under a few hundred KB even on a problematic dataset.

---

## `GET /audit/kpi?days=N` — TOC v3 KPI feed

Single endpoint that returns every operating-cycle metric the MD's
TOC v3 spec calls for. Same JSON powers the four role dashboards
(CMD / COO / Sales / Finance), the 9 AM CMD email, and the 7:30 AM
snapshot writer.

Default window is **30 days**; clamp 7–365 via `?days=N`.

```jsonc
{
  "spec_version": "v3",
  "generated_at": "...",
  "window": { "from": "2026-04-15", "to": "2026-05-15", "days": 30 },
  "cash_conversion_cycle": {
    "dso": 47,    // (AR / sales_window) × window_days
    "dio": 31,    // (inventory_value / cogs_window) × window_days
    "dpo": 22,    // (AP / purchases_window) × window_days
    "ccc": 56     // DSO + DIO − DPO  (days)
  },
  "ar": {
    "outstanding_total": 4380000,
    "aging": {
      "bucket_0_30":   1200000,
      "bucket_31_60":   850000,
      "bucket_61_90":   780000,
      "bucket_90_plus": 1550000
    }
  },
  "ap": { "outstanding_total": 1850000, "purchases_in_window": 2400000 },
  "inventory": { "total_value": 3100000, "free_to_use_value": 720000 },
  "sales":     { "total_in_window": 5200000 },
  "bank":      { "date": "2026-05-15", "closing_balance": 1834000 },
  "wip":       { "book_value": 8200000, "billed": 4100000, "unbilled": 4100000 },
  "funnel": {
    "leads_in_window": 24,
    "won_in_window": 6,
    "lead_to_po_pct": 25.0,
    "quote_lead_time_days_avg": 4.2
  },
  "revenue_per_fte": {
    "overall": 123809,           // sales_window / active_FTE
    "active_employees": 42,
    "by_department": [
      { "department": "Sales", "fte": 6, "rev_per_fte": 866666 },
      { "department": "Site",  "fte": 22, "rev_per_fte": 236363 }
    ]
  },
  "on_time_milestone_pct": 78.2,  // proxy: DPR overall_status='on_track' %
  "project_margin_variance": {
    "avg_variance_pct": -3.4,
    "sample_size": 18,
    "worst_5": [
      { "po_number": "PO-2026-00042", "client": "Hero Homes",
        "booked_pct": 18.0, "actual_pct": 9.2, "variance": -8.8 }
    ]
  }
}
```

### Definitions

- **DSO** = Days Sales Outstanding = `(outstanding receivables ÷ sales in window) × window_days`. Lower is better; bills are getting collected faster.
- **DIO** = Days Inventory Outstanding = `(inventory value ÷ COGS in window) × window_days`. Lower is better.
- **DPO** = Days Payable Outstanding = `(outstanding to vendors ÷ purchases in window) × window_days`. Higher is better; we're financing ourselves on supplier credit.
- **CCC** = `DSO + DIO − DPO`. Days of cash tied up in the operating cycle. **Lower is better.**
- **Free-to-use inventory ₹** = stock value at the central `type='office'` warehouse — not pre-allocated to any site.
- **Quote lead time** = avg `(quotations.created_at − leads.created_at)` for quotes sent in the window.
- **Lead→PO %** = `won leads ÷ leads_created_in_window × 100`.
- **Revenue per FTE** = `sales_window ÷ active employees`, also rolled up by `employees.department` for COO / Sales-Head views.
- **On-time milestone %** *(proxy until TOC v3 P0 #4 lands)* = % of DPR rows in window with `overall_status='on_track'`.
- **Project margin variance** = `(actual_revenue − DPR.cost_b) / actual_revenue × 100` − `business_book.actual_margin_pct`, averaged across the last 50 POs with status in (`in_progress`, `completed`). Negative = we're earning less than booked.

---

## `GET /audit/data-quality`

Per-table null-rate scorecard. Lets CMD see which entities are well-
populated vs. which have lots of blanks on the columns the rest of
the ERP relies on.

```jsonc
{
  "spec_version": "v3",
  "generated_at": "...",
  "duration_ms": 23,
  "overall_quality_score": 94.7,
  "tables": [
    {
      "name": "business_book",
      "row_count": 142,
      "last_rowid": 142,
      "nulls": {
        "lead_no":                 { "null_count": 0, "null_pct": 0.0 },
        "client_name":             { "null_count": 0, "null_pct": 0.0 },
        "po_amount":               { "null_count": 3, "null_pct": 2.11 },
        "sale_amount_without_gst": { "null_count": 1, "null_pct": 0.70 },
        "created_at":              { "null_count": 0, "null_pct": 0.0 }
      },
      "quality_score": 97.9
    }
    /* ...one entry per critical table... */
  ]
}
```

- `null_pct` is a percentage to 2 decimals.
- `quality_score = 100 − worst_null_pct` per table.
- `overall_quality_score` is the row-count-weighted average across all
  tables (so big-table problems hurt more than small-table problems).

---

## `GET /audit/analytics?days=N`

Rolling activity analytics. Default window is **30 days**; pass
`?days=N` (clamped to 1–365) to change.

```jsonc
{
  "spec_version": "v3",
  "generated_at": "...",
  "duration_ms": 31,
  "period": { "from": "2026-04-13", "to": "2026-05-13", "days": 30 },
  "totals": {
    "new_business_book": 18,
    "new_purchase_orders": 11,
    "new_sales_bills": 22,
    "new_purchase_bills": 38,
    "new_dpr": 412,
    "new_indents": 47,
    "new_payment_requests": 63,
    "new_cheques": 14,
    "new_complaints": 3,
    "new_snags": 9
  },
  "by_day": {
    "dpr":          [ { "d": "2026-04-13", "c": 14 }, ... ],
    "sales_bills":  [ { "d": "2026-04-13", "c":  1 }, ... ],
    "cash_inflows": [ { "d": "2026-04-13", "total": 230000 }, ... ]
  },
  "top_vendors": [
    { "id": 12, "name": "Tata Power", "bill_count": 6, "total_spend": 1850000 }
  ],
  "top_clients": [
    { "client_name": "Hero Homes", "entries": 4, "total_sale": 3200000 }
  ]
}
```

---

## Operational notes

### Setting the token in production

```bash
# Set the token (pm2 picks it up on next restart):
pm2 set ERP:AUDIT_API_TOKEN $(openssl rand -hex 32)

# Persist it across server reboots:
pm2 save

# Restart the ERP process to pick up the env var:
pm2 restart erp
```

Then share the generated token over a secure channel with whoever
runs the audit email job (CMD's email automation, Claude API, etc.).

### Suggested daily cron (Linux side)

```bash
# /etc/cron.d/erp-cmd-audit — runs at 09:00 every day, posts the
# response into a Mailgun (or similar) compose endpoint that sends
# the daily summary to the CMD.

0 9 * * *  www-data  curl -sf -H "Authorization: Bearer ${AUDIT_API_TOKEN}" \
              https://securederp.in/audit > /tmp/erp-audit.json \
              && /usr/local/bin/send-cmd-audit-email.py /tmp/erp-audit.json
```

The endpoints are read-only and side-effect-free, so calling them
multiple times (manual + scheduled) is safe.

### Failure modes the email job should handle

| HTTP | Body | Action |
|---|---|---|
| 200 | the JSON above | normal — render & email |
| 401 | `{ error: "unauthorized" }` | token wrong/expired — alert ops, don't email |
| 503 | `{ error: "audit_token_unconfigured" }` | server env not set — alert ops |
| 5xx (other) | varies | retry once after 60s, then alert |

---

## Versioning

The `spec_version` field on every response is **`v3`** for this
release. Any future schema-changing edits (renaming a KPI id, removing
a field) will bump this. Additive changes (new KPI, new exception
list) keep `v3` and just add the new fields, so consumers that ignore
unknown keys continue working.
