const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'erp.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dataDir = path.join(__dirname, '..', '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    db = new Database(DB_PATH);
    // Performance pragmas — measurable speedup on the SEPL VPS:
    // - WAL: concurrent reads while a write is happening (mam: pages
    //   stay snappy even when multiple users punch / save simultaneously)
    // - synchronous=NORMAL: fewer fsyncs, still crash-safe in WAL mode
    // - cache_size=-24000: 24 MB page cache. Trimmed from 64 MB (2026-06-25):
    //   on the 1 GB VPS the old 64 MB cache + 128 MB mmap were ~190 MB of the
    //   process footprint, feeding the OOM-killer that caused the recurring
    //   502s. The DB is small and now well-indexed, so 24 MB is ample and
    //   frees ~140 MB of headroom so the process is far less likely to OOM.
    // - mmap_size=64 MB: read pages via memory-map, fewer syscalls (halved).
    // - temp_store=MEMORY: temp tables/indices in RAM, not disk
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -24000');
    db.pragma('mmap_size = 67108864');
    db.pragma('temp_store = MEMORY');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

// Run a big DDL blob statement-by-statement so one failing statement doesn't
// abort the whole init. On a FRESH database, a handful of CREATE INDEX lines in
// the initial blob reference columns that are only added later by the guarded
// ALTER migrations below (e.g. sales_bills.business_book_id) — on an existing
// prod DB those columns are already present so the indexes build, but on a
// clean bootstrap (this salon fork) the index would throw and kill init. Here
// each statement runs in its own try/catch: every CREATE TABLE still runs, and
// any index that can't build yet is skipped (it's a perf-only artifact and the
// column exists after migrations run). Splitting on ';' is safe because this
// blob contains no triggers / BEGIN…END bodies.
function execResilient(db, sql) {
  // Strip SQL comments BEFORE splitting on ';' — comments in this blob contain
  // semicolons (e.g. "-- mam: does X; then Y"), and a naive split would cut a
  // statement in half and leave comment prose as a bogus "statement". This DDL
  // has no ';' inside string literals, so comment-stripping + split is safe.
  const clean = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
  for (const chunk of clean.split(';')) {
    if (!chunk.trim()) continue;
    try { db.exec(chunk + ';'); }
    catch (e) { console.warn('[schema] init statement skipped (non-fatal):', e.message); }
  }
}

function initializeDatabase() {
  const db = getDb();

  execResilient(db, `
    -- Users & Auth
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'user' CHECK(role IN ('admin','manager','user')),
      department TEXT,
      phone TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Roles & Permissions (Admin customizable)
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      is_system INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Module-level permissions per role
    CREATE TABLE IF NOT EXISTS role_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
      module TEXT NOT NULL,
      can_view INTEGER DEFAULT 0,
      can_create INTEGER DEFAULT 0,
      can_edit INTEGER DEFAULT 0,
      can_delete INTEGER DEFAULT 0,
      can_approve INTEGER DEFAULT 0,
      UNIQUE(role_id, module)
    );

    -- User-role assignment (a user can have a custom role)
    CREATE TABLE IF NOT EXISTS user_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
      UNIQUE(user_id, role_id)
    );

    -- Lead Sources
    CREATE TABLE IF NOT EXISTS lead_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    -- Leads / CRM (kept for backward compatibility)
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name TEXT NOT NULL,
      contact_person TEXT,
      phone TEXT,
      email TEXT,
      source_id INTEGER REFERENCES lead_sources(id),
      status TEXT DEFAULT 'new',
      assigned_to INTEGER REFERENCES users(id),
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Sales Funnel Pipeline
    CREATE TABLE IF NOT EXISTS sales_funnel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_no TEXT UNIQUE,
      -- Lead Details
      client_name TEXT NOT NULL,
      company_name TEXT,
      phone TEXT,
      email TEXT,
      category TEXT,
      address TEXT,
      district TEXT,
      state TEXT,
      source TEXT,
      assigned_sc TEXT,
      assigned_asm TEXT,
      -- Stage tracking
      current_stage TEXT DEFAULT 'new_lead',
      -- Stage 1: Qualified
      is_qualified INTEGER DEFAULT 0,
      qualified_by TEXT,
      qualified_date DATETIME,
      qualified_remarks TEXT,
      -- Stage 2: Meeting
      meeting_date DATETIME,
      meeting_location TEXT,
      meeting_assigned_to TEXT,
      meeting_status TEXT DEFAULT 'pending',
      -- Stage 3: MOM
      mom_notes TEXT,
      mom_file_link TEXT,
      mom_filled_by TEXT,
      mom_date DATETIME,
      -- Stage 4: Drawing
      drawing_file1 TEXT,
      drawing_file2 TEXT,
      drawing_file3 TEXT,
      drawing_uploaded_by TEXT,
      drawing_date DATETIME,
      -- Stage 5: BOQ
      boq_file_link TEXT,
      boq_created_by TEXT,
      boq_amount REAL DEFAULT 0,
      boq_date DATETIME,
      -- Stage 6: Quotation
      quotation_number TEXT,
      quotation_file_link TEXT,
      quotation_amount REAL DEFAULT 0,
      quotation_sent_by TEXT,
      quotation_sent_date DATETIME,
      -- Stage 7: Result
      result TEXT,
      result_remarks TEXT,
      result_date DATETIME,
      won_amount REAL DEFAULT 0,
      -- Meta
      remarks TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Help/Support Tickets
    CREATE TABLE IF NOT EXISTS support_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_no TEXT UNIQUE,
      user_id INTEGER REFERENCES users(id),
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT DEFAULT 'bug' CHECK(category IN ('bug','feature_request','how_to','access_issue','data_issue','manpower','material','payment','other')),
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
      status TEXT DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved','closed')),
      attachment_link TEXT,
      module TEXT,
      admin_response TEXT,
      resolved_by INTEGER REFERENCES users(id),
      resolved_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Lead Follow-ups
    CREATE TABLE IF NOT EXISTS lead_followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES sales_funnel(id) ON DELETE CASCADE,
      followup_date DATE NOT NULL,
      followup_time TEXT,
      type TEXT DEFAULT 'call' CHECK(type IN ('call','email','whatsapp','visit','other')),
      outcome TEXT CHECK(outcome IN ('connected','not_reachable','callback','interested','not_interested','meeting_fixed','quotation_asked','follow_later')),
      notes TEXT,
      next_followup_date DATE,
      done INTEGER DEFAULT 0,
      done_by INTEGER REFERENCES users(id),
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Meetings
    CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES leads(id),
      scheduled_at DATETIME NOT NULL,
      location TEXT,
      agenda TEXT,
      outcome TEXT,
      status TEXT DEFAULT 'scheduled' CHECK(status IN ('scheduled','completed','cancelled')),
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- BOQ (Bill of Quantities)
    CREATE TABLE IF NOT EXISTS boq (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES leads(id),
      title TEXT NOT NULL,
      drawing_required INTEGER DEFAULT 0,
      drawing_file TEXT,
      total_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved')),
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS boq_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      boq_id INTEGER REFERENCES boq(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      quantity REAL DEFAULT 0,
      unit TEXT DEFAULT 'nos',
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0
    );

    -- Quotations
    CREATE TABLE IF NOT EXISTS quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES leads(id),
      boq_id INTEGER REFERENCES boq(id),
      quotation_number TEXT UNIQUE,
      total_amount REAL DEFAULT 0,
      discount REAL DEFAULT 0,
      final_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','sent','negotiation','accepted','rejected')),
      valid_until DATE,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- PO/FOC Stripped (mam 2026-06-09): each row = one PO item + its FOC
    -- items + labour + margin, with an approval workflow:
    --   non_approved → still being decided (FOC/labour/margin not fixed)
    --   approved     → fixed; printable as a PDF
    --   re_approved  → an approved item that was changed afterwards
    CREATE TABLE IF NOT EXISTS po_foc_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_item_id INTEGER,
      po_name TEXT,
      po_rate REAL DEFAULT 0,
      qty REAL DEFAULT 1,
      labour REAL DEFAULT 0,                          -- labour RATE (from labour_rates)
      labour_item_id INTEGER,                         -- chosen labour_rates row
      labour_name TEXT,
      labour_margin REAL DEFAULT 50,                  -- labour has its own margin
      margin REAL DEFAULT 30,
      focs_json TEXT,                                 -- [{item_id,name,qty,rate}]
      cost REAL DEFAULT 0,
      tpa REAL DEFAULT 0,
      status TEXT DEFAULT 'non_approved' CHECK(status IN ('non_approved','approved','re_approved')),
      created_by INTEGER REFERENCES users(id),
      approved_by INTEGER REFERENCES users(id),
      approved_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Saved AI Auto-Quotation estimates (mam 2026-06-10): the whole estimator
    -- state so quotations can be listed client-wise and edited later.
    CREATE TABLE IF NOT EXISTS estimate_quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      lead_id INTEGER,
      client_name TEXT,
      acc_pct REAL DEFAULT 0,
      margins_json TEXT,                              -- {category: marginPct}
      rows_json TEXT,                                 -- full estimator rows (with subs)
      manpower_json TEXT,
      cost REAL DEFAULT 0,
      sp REAL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Labour Rate sheet (mam 2026-06-10): item-wise labour / sub-contractor
    -- rates by UOM and category. Seeded once from her uploaded sheet.
    CREATE TABLE IF NOT EXISTS labour_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_name TEXT NOT NULL,
      specification TEXT,
      size TEXT,
      rate REAL DEFAULT 0,                            -- Purchase / Sub-Contractor rate
      uom TEXT,
      category TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Purchase Orders (from client)
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_book_id INTEGER REFERENCES business_book(id),
      lead_id INTEGER REFERENCES leads(id),
      quotation_id INTEGER REFERENCES quotations(id),
      po_number TEXT UNIQUE NOT NULL,
      po_date DATE NOT NULL,
      total_amount REAL DEFAULT 0,
      advance_amount REAL DEFAULT 0,
      advance_received INTEGER DEFAULT 0,
      po_copy_link TEXT,
      pt_advance REAL DEFAULT 0,
      pt_delivery REAL DEFAULT 0,
      pt_installation REAL DEFAULT 0,
      pt_commissioning REAL DEFAULT 0,
      pt_retention REAL DEFAULT 0,
      status TEXT DEFAULT 'received' CHECK(status IN ('received','booked','planning','in_progress','completed')),
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Item Master (from Drive Item-wise sheet)
    CREATE TABLE IF NOT EXISTS item_master (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_code TEXT UNIQUE,
      department TEXT,
      item_name TEXT NOT NULL,
      specification TEXT,
      size TEXT,
      uom TEXT DEFAULT 'PCS',
      gst TEXT DEFAULT '18%',
      type TEXT DEFAULT 'PO',
      make TEXT,
      model_number TEXT,
      current_price REAL DEFAULT 0,
      catalogue_link TEXT,
      photo_link TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Item rate history — every time staff enters a rate for an item
    -- in a BOQ row that's linked to item_master, we log it here so
    -- everyone gets last-rate + 6-month avg/low/high suggestions
    -- next time they quote the same item (mam: AI Agent feature).
    CREATE TABLE IF NOT EXISTS item_price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES item_master(id) ON DELETE CASCADE,
      rate REAL NOT NULL,
      quantity REAL DEFAULT 0,
      lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      company_name TEXT,
      boq_id INTEGER REFERENCES boq(id) ON DELETE SET NULL,
      source TEXT DEFAULT 'boq',
      created_by INTEGER REFERENCES users(id),
      created_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Business Book (Master New Business Booked Sheet - matches Google Form/Excel)
    CREATE TABLE IF NOT EXISTS business_book (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_no TEXT UNIQUE,
      lead_type TEXT DEFAULT 'Private' CHECK(lead_type IN ('Private','Government')),
      client_name TEXT NOT NULL,
      company_name TEXT,
      project_name TEXT,
      client_contact TEXT,
      client_email TEXT,
      email_address TEXT,
      source_of_enquiry TEXT,
      district TEXT,
      state TEXT,
      billing_address TEXT,
      shipping_address TEXT,
      guarantee_required TEXT DEFAULT 'No',
      guarantee_percentage TEXT,
      sale_amount_without_gst REAL DEFAULT 0,
      po_amount REAL DEFAULT 0,
      order_type TEXT DEFAULT 'Supply',
      penalty_clause TEXT DEFAULT 'No',
      penalty_clause_date DATE,
      committed_start_date DATE,
      committed_delivery_date DATE,
      committed_completion_date DATE,
      freight_extra TEXT DEFAULT 'No',
      category TEXT,
      customer_type TEXT,
      client_type TEXT,
      customer_code TEXT,
      -- People
      employee_assigned TEXT,
      employee_id INTEGER REFERENCES users(id),
      lead_by TEXT,
      management_person_name TEXT,
      management_person_contact TEXT,
      operations_person_name TEXT,
      operations_person_contact TEXT,
      pmc_person_name TEXT,
      pmc_person_contact TEXT,
      architect_person_name TEXT,
      architect_person_contact TEXT,
      accounts_person_name TEXT,
      accounts_person_contact TEXT,
      -- TPA Details
      tpa_items_count INTEGER DEFAULT 0,
      tpa_items_qty TEXT,
      tpa_material_amount REAL DEFAULT 0,
      tpa_labour_amount REAL DEFAULT 0,
      accessory_amount REAL DEFAULT 0,
      required_labour_per_day TEXT,
      actual_margin_pct REAL DEFAULT 0,
      -- Payment Terms
      payment_advance TEXT,
      payment_against_delivery TEXT,
      payment_against_installation TEXT,
      payment_against_commissioning TEXT,
      payment_retention TEXT,
      payment_credit TEXT,
      credit_days INTEGER DEFAULT 0,
      advance_received REAL DEFAULT 0,
      balance_amount REAL DEFAULT 0,
      -- PO Details (combined - no separate PO needed)
      po_number TEXT,
      po_date DATE,
      po_copy_link TEXT,
      -- File Links
      boq_file_link TEXT,
      boq_signed_link TEXT,
      tpa_material_link TEXT,
      tpa_material_signed_link TEXT,
      tpa_labour_link TEXT,
      tpa_labour_signed_link TEXT,
      final_drawing_link TEXT,
      -- Other
      remarks TEXT,
      status TEXT DEFAULT 'booked' CHECK(status IN ('booked','advance_received','planning','execution','completed')),
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- PO Items (item-wise data for each PO / Business Book entry)
    CREATE TABLE IF NOT EXISTS po_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_book_id INTEGER REFERENCES business_book(id) ON DELETE CASCADE,
      item_master_id INTEGER REFERENCES item_master(id),
      description TEXT NOT NULL,
      quantity REAL DEFAULT 0,
      unit TEXT DEFAULT 'nos',
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      hsn_code TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Order Planning
    CREATE TABLE IF NOT EXISTS order_planning (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id INTEGER REFERENCES purchase_orders(id),
      business_book_id INTEGER REFERENCES business_book(id),
      planned_start DATE,
      planned_end DATE,
      notes TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed')),
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Vendors
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_code TEXT UNIQUE,
      category TEXT,
      company_name TEXT NOT NULL,
      sub_company_name TEXT,
      company_registration_address TEXT,
      contact_no TEXT,
      email TEXT,
      concern_person_name TEXT,
      concern_person_email TEXT,
      concern_person_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_code TEXT UNIQUE,
      name TEXT NOT NULL,
      firm_name TEXT,
      contact_person TEXT,
      phone TEXT,
      email TEXT,
      district TEXT,
      state TEXT,
      address TEXT,
      category TEXT,
      deals_in TEXT,
      authorized_dealer TEXT,
      type TEXT,
      turnover TEXT,
      team_size TEXT,
      payment_terms TEXT,
      credit_days TEXT,
      gst_number TEXT,
      source TEXT,
      category_wise TEXT,
      sub_category TEXT,
      existing_vendor TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Vendor Rate Comparison
    CREATE TABLE IF NOT EXISTS vendor_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      planning_id INTEGER REFERENCES order_planning(id),
      item_description TEXT NOT NULL,
      vendor1_id INTEGER REFERENCES vendors(id),
      vendor1_rate REAL DEFAULT 0,
      vendor2_id INTEGER REFERENCES vendors(id),
      vendor2_rate REAL DEFAULT 0,
      vendor3_id INTEGER REFERENCES vendors(id),
      vendor3_rate REAL DEFAULT 0,
      final_rate REAL DEFAULT 0,
      selected_vendor_id INTEGER REFERENCES vendors(id),
      approved_by TEXT,
      approval_status TEXT DEFAULT 'pending' CHECK(approval_status IN ('pending','approved','rejected')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Indent (Material Request)
    CREATE TABLE IF NOT EXISTS indents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      planning_id INTEGER REFERENCES order_planning(id),
      indent_number TEXT UNIQUE,
      indent_date DATE DEFAULT CURRENT_DATE,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected','po_sent','dispatched','received')),
      approved_by INTEGER REFERENCES users(id),
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS indent_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      indent_id INTEGER REFERENCES indents(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      quantity REAL DEFAULT 0,
      unit TEXT DEFAULT 'nos',
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      vendor_id INTEGER REFERENCES vendors(id),
      po_item_id INTEGER
    );

    -- Vendor PO (purchase order to vendor)
    CREATE TABLE IF NOT EXISTS vendor_pos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      indent_id INTEGER REFERENCES indents(id),
      vendor_id INTEGER REFERENCES vendors(id),
      po_number TEXT UNIQUE,
      total_amount REAL DEFAULT 0,
      advance_required INTEGER DEFAULT 0,
      advance_paid INTEGER DEFAULT 0,
      status TEXT DEFAULT 'sent' CHECK(status IN ('sent','acknowledged','dispatched','delivered','completed')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Purchase Bills
    CREATE TABLE IF NOT EXISTS purchase_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_po_id INTEGER REFERENCES vendor_pos(id),
      vendor_id INTEGER REFERENCES vendors(id),
      bill_number TEXT,
      bill_date DATE,
      amount REAL DEFAULT 0,
      gst_amount REAL DEFAULT 0,
      total_amount REAL DEFAULT 0,
      payment_status TEXT DEFAULT 'pending' CHECK(payment_status IN ('pending','partial','paid')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Delivery Notes
    CREATE TABLE IF NOT EXISTS delivery_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_po_id INTEGER REFERENCES vendor_pos(id),
      delivery_date DATE,
      received_by INTEGER REFERENCES users(id),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','received','partial','rejected')),
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Sales Bills (to client). The 4-type sequential columns (bill_type,
    -- business_book_id, …) are added by migration so the legacy rows used by
    -- the delivery-note flow keep working.
    CREATE TABLE IF NOT EXISTS sales_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id INTEGER REFERENCES purchase_orders(id),
      business_book_id INTEGER REFERENCES business_book(id),
      bill_number TEXT UNIQUE,
      bill_date DATE,
      amount REAL DEFAULT 0,
      gst_amount REAL DEFAULT 0,
      total_amount REAL DEFAULT 0,
      payment_status TEXT DEFAULT 'pending' CHECK(payment_status IN ('pending','partial','paid')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- Line items for a sales bill (snapshot from the Business Book order).
    CREATE TABLE IF NOT EXISTS sales_bill_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sales_bill_id INTEGER REFERENCES sales_bills(id) ON DELETE CASCADE,
      description TEXT,
      qty_ordered REAL DEFAULT 0,
      qty_delivered REAL DEFAULT 0,
      unit TEXT,
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0
    );
    -- Status / approval audit trail for a sales bill.
    CREATE TABLE IF NOT EXISTS sales_bill_status_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sales_bill_id INTEGER REFERENCES sales_bills(id) ON DELETE CASCADE,
      status TEXT,
      changed_by INTEGER REFERENCES users(id),
      changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      notes TEXT
    );

    -- Debit Notes (mam 2026-06-04 post-PO chart, stage 7): a document
    -- raised against a vendor for (a) material REJECTED at GRN, (b) the
    -- vendor billing EXTRA over the PO rate, or (c) SHORT supply (ordered
    -- vs received shortfall — a "short material" notice).  One table,
    -- distinguished by the type column.  items_json holds the line snapshot so the
    -- printable note is self-contained even if the source GRN/bill changes.
    CREATE TABLE IF NOT EXISTS debit_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dn_number TEXT,
      type TEXT DEFAULT 'rejected' CHECK(type IN ('rejected','extra_rate','short_supply')),
      vendor_po_id INTEGER REFERENCES vendor_pos(id),
      vendor_id INTEGER REFERENCES vendors(id),
      grn_id INTEGER,
      purchase_bill_id INTEGER,
      amount REAL DEFAULT 0,
      reason TEXT,
      items_json TEXT,
      status TEXT DEFAULT 'open' CHECK(status IN ('open','sent','settled','cancelled')),
      file_path TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Installation
    CREATE TABLE IF NOT EXISTS installations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id INTEGER REFERENCES purchase_orders(id),
      site_address TEXT,
      start_date DATE,
      end_date DATE,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','testing')),
      assigned_to INTEGER REFERENCES users(id),
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- RA Bill (Running Account Bill)
    CREATE TABLE IF NOT EXISTS ra_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      installation_id INTEGER REFERENCES installations(id),
      bill_number TEXT,
      bill_date DATE,
      work_done_amount REAL DEFAULT 0,
      previous_amount REAL DEFAULT 0,
      current_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','paid')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- MB Bill (Measurement Book)
    CREATE TABLE IF NOT EXISTS mb_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ra_bill_id INTEGER REFERENCES ra_bills(id),
      installation_id INTEGER REFERENCES installations(id),
      bill_number TEXT,
      measurements TEXT,
      total_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','verified','approved')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Installation Bills
    CREATE TABLE IF NOT EXISTS installation_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      installation_id INTEGER REFERENCES installations(id),
      mb_bill_id INTEGER REFERENCES mb_bills(id),
      bill_number TEXT,
      amount REAL DEFAULT 0,
      payment_status TEXT DEFAULT 'pending' CHECK(payment_status IN ('pending','partial','paid')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Testing & Commissioning
    CREATE TABLE IF NOT EXISTS testing_commissioning (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      installation_id INTEGER REFERENCES installations(id),
      test_date DATE,
      test_type TEXT,
      result TEXT CHECK(result IN ('pass','fail','partial')),
      notes TEXT,
      tested_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Complaints
    CREATE TABLE IF NOT EXISTS complaints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_number TEXT UNIQUE,
      -- Step 1: Registration (Client)
      client_name TEXT NOT NULL,
      company_name TEXT,
      mobile_number TEXT,
      category TEXT,
      problem_detail TEXT NOT NULL,
      customer_type TEXT,
      complaint_type TEXT,
      emp_name TEXT,
      step1_planned_date DATE,
      step1_actual_date DATE,
      step1_time_delay INTEGER DEFAULT 0,
      step1_assigned_to TEXT,
      -- Step 2: Resolution (CRM/LV Team)
      step2_planned_date DATE,
      step2_actual_date DATE,
      step2_time_delay INTEGER DEFAULT 0,
      step2_assigned_to TEXT,
      service_report TEXT,
      -- Legacy fields for backward compat
      installation_id INTEGER REFERENCES installations(id),
      po_id INTEGER REFERENCES purchase_orders(id),
      description TEXT,
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
      status TEXT DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved','closed')),
      resolved_date DATE,
      resolution_notes TEXT,
      created_by INTEGER REFERENCES users(id),
      assigned_to INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Handover Certificates
    CREATE TABLE IF NOT EXISTS handover_certificates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      installation_id INTEGER REFERENCES installations(id),
      po_id INTEGER REFERENCES purchase_orders(id),
      certificate_number TEXT UNIQUE,
      handover_date DATE,
      client_signatory TEXT,
      company_signatory TEXT,
      notes TEXT,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','signed','completed')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Payment Tracking
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT CHECK(type IN ('receivable','payable')),
      reference_type TEXT,
      reference_id INTEGER,
      amount REAL DEFAULT 0,
      payment_date DATE,
      payment_mode TEXT,
      transaction_ref TEXT,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- HR: Job Candidates
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      source TEXT CHECK(source IN ('facebook','naukri','linkedin','reference','other')),
      position TEXT,
      status TEXT DEFAULT 'lead' CHECK(status IN ('lead','called','qualified','interview_scheduled','interview_done','offer_sent','accepted','onboarded','rejected')),
      resume_file TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- HR Phase 1 (mam 2026-05-22 spec): Hiring Requests.
    -- Manager raises a hiring requirement → HR approves → open position.
    -- Candidates can be linked back to a hiring_request_id so the funnel
    -- shows "X applicants for Position Y" per request.
    CREATE TABLE IF NOT EXISTS hiring_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      department TEXT NOT NULL,
      position_title TEXT NOT NULL,
      num_openings INTEGER DEFAULT 1,
      salary_min REAL,
      salary_max REAL,
      experience_required TEXT,              -- e.g. '2-4 years', 'Fresher'
      employment_type TEXT DEFAULT 'full_time' CHECK(employment_type IN ('full_time','part_time','contract','internship','freelance')),
      hiring_deadline DATE,
      reporting_manager_id INTEGER REFERENCES employees(id),
      job_description TEXT,                  -- short JD blurb; full JD module comes in Batch B
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','closed')),
      approval_notes TEXT,
      requested_by INTEGER REFERENCES users(id),
      requested_by_name TEXT,                -- denormalised so list view doesn't need extra JOIN
      approved_by INTEGER REFERENCES users(id),
      approved_at DATETIME,
      closed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- HR Phase 1 Batch B (mam 2026-05-22): JD templates — reusable JD
    -- skeletons HR can clone for new positions (Site Engineer, Sales
    -- Executive, etc.).  template_content is JSON: { responsibilities,
    -- required_skills, required_experience, education_required, etc. }.
    CREATE TABLE IF NOT EXISTS jd_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      template_content TEXT,                 -- JSON blob
      is_default INTEGER DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- HR Phase 1 Batch B (mam 2026-05-22): Job Descriptions.
    -- One JD per position; can be derived from a template + linked to
    -- the hiring_request that opened the role.  Two output flavours
    -- are stored side-by-side: internal_jd (full detail for HR /
    -- managers) and public_job_post (sanitised post for Naukri / LI).
    CREATE TABLE IF NOT EXISTS job_descriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hiring_request_id INTEGER REFERENCES hiring_requests(id),
      template_id INTEGER REFERENCES jd_templates(id),
      title TEXT NOT NULL,                   -- e.g. "Senior Site Engineer — Chandigarh"
      description TEXT,                       -- one-paragraph hook
      responsibilities TEXT,                  -- bullet list, free-text
      required_skills TEXT,                   -- CSV or free-text
      required_experience TEXT,
      education_required TEXT,
      internal_jd TEXT,                       -- full internal-only version
      public_job_post TEXT,                   -- sanitised for external boards
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- HR Phase 1 Batch B (mam 2026-05-22): Interview Scorecards.
    -- One row per (candidate × interviewer × stage).  Stage is either
    -- 'first' (interviewer round) or 'final' (MD round).  All scores
    -- are 1-5; overall_recommend captures the interviewer's verdict
    -- separately from the 4 dimension scores so a "hire" decision is
    -- explicit even if scores are mixed.
    CREATE TABLE IF NOT EXISTS interview_scorecards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      interviewer_id INTEGER REFERENCES employees(id),
      interviewer_name TEXT,                  -- denormalised
      stage TEXT CHECK(stage IN ('first','final')) DEFAULT 'first',
      technical_score INTEGER,                -- 1-5
      communication_score INTEGER,            -- 1-5
      culture_fit_score INTEGER,              -- 1-5
      problem_solving_score INTEGER,          -- 1-5
      overall_recommend TEXT CHECK(overall_recommend IN ('strong_yes','yes','maybe','no','strong_no')),
      strengths TEXT,
      weaknesses TEXT,
      overall_feedback TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- HR Phase 1 Batch E (mam 2026-05-22): Induction items.
    -- Admin manages content per section (Founder Message / Company
    -- Culture / HR Policies / IT-Security / SOPs).  Each item is
    -- either a video URL (YouTube/Vimeo embed), a PDF file URL, or
    -- a plain text block (markdown-ish, rendered as preformatted).
    CREATE TABLE IF NOT EXISTS induction_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section TEXT NOT NULL,                 -- 'founder' | 'culture' | 'hr_policies' | 'it_security' | 'sop' | custom
      title TEXT NOT NULL,
      content_type TEXT CHECK(content_type IN ('text','video','pdf','link')) DEFAULT 'text',
      content_url TEXT,                       -- URL for video/pdf/link
      content_text TEXT,                      -- body for text content
      order_index INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- HR Phase 1 Batch E (mam 2026-05-22): Training videos library.
    -- Categorised by training_type per spec: product / process /
    -- communication / sop.  target_dept / target_role are free-text
    -- CSV so admin can assign by team without coupling to permissions.
    CREATE TABLE IF NOT EXISTS training_videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      video_url TEXT NOT NULL,                -- YouTube/Vimeo embed or direct file URL
      training_type TEXT CHECK(training_type IN ('product','process','communication','sop','other')) DEFAULT 'sop',
      duration_minutes INTEGER,
      target_dept TEXT,                       -- CSV; NULL = any
      target_role TEXT,                       -- CSV; NULL = any
      is_mandatory INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- HR Phase 1 Batch E (mam 2026-05-22): Per-employee training
    -- assignments + completion tracking.  Status flow:
    -- assigned → started → completed (or skipped).
    CREATE TABLE IF NOT EXISTS training_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      video_id INTEGER NOT NULL REFERENCES training_videos(id) ON DELETE CASCADE,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME,
      completion_note TEXT,
      assigned_by INTEGER REFERENCES users(id),
      UNIQUE(employee_id, video_id)
    );

    -- HR Phase 1 Batch E (mam 2026-05-22): In-app notifications.
    -- Created by the hrAutomationsCron scanner + by direct admin
    -- actions.  user_id points at the recipient (HR user, interviewer,
    -- candidate→employee, etc.).  type drives the icon + colour.
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,                    -- 'interview_reminder' | 'offer_expiry' | 'approval_pending' | 'training_assigned' | 'generic'
      title TEXT NOT NULL,
      body TEXT,
      link_url TEXT,                          -- where to send the user when they click
      channel_sent TEXT,                      -- CSV of channels delivered: 'in_app,email'
      dedupe_key TEXT,                        -- prevents duplicate sends from cron re-runs
      read_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- HR Phase 1 Batch D (mam 2026-05-22): Pre-Onboarding doc checklist.
    -- One row per (candidate × doc_type).  Standard doc_type values:
    -- 'aadhaar' | 'pan' | 'resume' | 'experience' | 'bank' | 'photo' |
    -- 'education' | 'other'.  Free-text so admin can add custom items.
    -- Status: 'pending' | 'received' | 'verified' | 'rejected'.
    CREATE TABLE IF NOT EXISTS candidate_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      doc_type TEXT NOT NULL,
      doc_label TEXT,                          -- friendly label, optional
      file_url TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','received','verified','rejected')),
      notes TEXT,
      uploaded_at DATETIME,
      verified_at DATETIME,
      verified_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- HR Phase 1 Batch C (mam 2026-05-22): Screening Questions.
    -- Per-position screening forms (hiring_request_id set) or global
    -- (hiring_request_id NULL) for HR to use during phone screening.
    --
    -- question_type options:
    --   'mcq'         — single-choice from options (JSON array)
    --   'descriptive' — free-text answer
    --   'yes_no'      — boolean
    --   'number'      — numeric input (notice period, current salary, exp etc.)
    --
    -- auto_reject_op + auto_reject_value form the rules engine:
    --   gt (a > v), lt (a < v), gte, lte, eq, neq, contains, not_contains,
    --   in (a ∈ csv-v), not_in
    -- A null op means the question has NO auto-reject rule (info only).
    CREATE TABLE IF NOT EXISTS screening_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hiring_request_id INTEGER REFERENCES hiring_requests(id),
      question_text TEXT NOT NULL,
      question_type TEXT NOT NULL CHECK(question_type IN ('mcq','descriptive','yes_no','number')) DEFAULT 'descriptive',
      options TEXT,                            -- JSON array for MCQ
      is_mandatory INTEGER DEFAULT 0,
      auto_reject_op TEXT,                     -- gt | lt | gte | lte | eq | neq | contains | not_contains | in | not_in
      auto_reject_value TEXT,                  -- string/number/csv depending on op
      auto_reject_reason TEXT,                 -- shown to admin when this rule fires
      order_index INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- HR Phase 1 Batch C (mam 2026-05-22): Screening Answers.
    -- One row per (candidate × question).  Submitting a screening
    -- form deletes-and-reinserts so re-screening doesn't double-count.
    CREATE TABLE IF NOT EXISTS screening_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES screening_questions(id) ON DELETE CASCADE,
      answer_text TEXT,                        -- always stored as text; cast at eval time
      auto_rejected INTEGER DEFAULT 0,         -- did THIS answer trip its rule?
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- HR Phase 1 Batch B (mam 2026-05-22): Final Round Question Bank.
    -- Curated questions MD / panel can pull during the final round,
    -- organised by category (Leadership / Ownership / Decision
    -- Making / Conflict Management / Team Handling).  for_role is a
    -- free-text tag ("Manager", "Engineer", "Sales") so questions
    -- can be filtered when picking — keeps it flexible without
    -- coupling to the permissions role system.
    CREATE TABLE IF NOT EXISTS final_round_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,                -- 'Leadership' | 'Ownership' | etc.
      question_text TEXT NOT NULL,
      for_role TEXT,                          -- free-text: 'Manager' | 'IC' | 'Sales' | 'Any'
      difficulty TEXT CHECK(difficulty IN ('easy','medium','hard')) DEFAULT 'medium',
      notes TEXT,                             -- panellist notes / what to listen for
      is_active INTEGER DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- HR Phase 1 (mam 2026-05-22 spec): Candidate activity timeline.
    -- Every status-change / decision / tag-edit / hold-toggle writes a row
    -- here so the candidate detail view shows a chronological audit log.
    -- event_type values used by routes/hr.js:
    --   'created' | 'status_change' | 'interview_scheduled' | 'interview_done'
    --   | 'md_scheduled' | 'md_decision' | 'offer_generated' | 'finalised'
    --   | 'tags_updated' | 'hold_on' | 'hold_off' | 'note_added'
    CREATE TABLE IF NOT EXISTS candidate_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      note TEXT,
      user_id INTEGER REFERENCES users(id),
      user_name TEXT,                        -- denormalised so deleted users still show
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- HR: Employees
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      designation TEXT,
      department TEXT,
      join_date DATE,
      salary REAL DEFAULT 0,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','training','inactive','terminated')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Sub-Contractors
    CREATE TABLE IF NOT EXISTS sub_contractors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      specialization TEXT,
      rate REAL DEFAULT 0,
      rate_unit TEXT DEFAULT 'per_day',
      status TEXT DEFAULT 'qualified' CHECK(status IN ('qualified','negotiation','onboarded','active','inactive')),
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Expenses
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      amount REAL NOT NULL,
      category TEXT,
      expense_date DATE DEFAULT CURRENT_DATE,
      receipt_file TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','paid')),
      submitted_by INTEGER REFERENCES users(id),
      approved_by INTEGER REFERENCES users(id),
      paid_date DATE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Checklists
    CREATE TABLE IF NOT EXISTS checklists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      frequency TEXT DEFAULT 'monthly' CHECK(frequency IN ('daily','weekly','fortnightly','monthly','quarterly','yearly','once')),
      due_date DATE,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','overdue')),
      assigned_to INTEGER REFERENCES users(id),
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Activity Log
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      module TEXT NOT NULL,
      action TEXT NOT NULL,
      record_id INTEGER,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ============================================
    -- SYSTEM 1: AUTOMATIC CASH FLOW SYSTEM
    -- ============================================
    CREATE TABLE IF NOT EXISTS cash_flow_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date DATE UNIQUE NOT NULL,
      opening_balance REAL DEFAULT 0,
      total_inflows REAL DEFAULT 0,
      total_outflows REAL DEFAULT 0,
      closing_balance REAL DEFAULT 0,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cash_flow_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      daily_id INTEGER REFERENCES cash_flow_daily(id),
      date DATE NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('inflow','outflow')),
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      reference_type TEXT,
      reference_id INTEGER,
      payment_mode TEXT,
      party_name TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ============================================
    -- SYSTEM 2: COLLECTION ENGINE SYSTEM
    -- ============================================
    CREATE TABLE IF NOT EXISTS receivables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_name TEXT NOT NULL,
      project_name TEXT,
      po_id INTEGER REFERENCES purchase_orders(id),
      invoice_number TEXT,
      invoice_date DATE,
      invoice_amount REAL NOT NULL DEFAULT 0,
      received_amount REAL DEFAULT 0,
      outstanding_amount REAL DEFAULT 0,
      due_date DATE,
      ageing_days INTEGER DEFAULT 0,
      ageing_bucket TEXT DEFAULT '0-30' CHECK(ageing_bucket IN ('0-30','31-60','61-90','90+')),
      status TEXT DEFAULT 'red' CHECK(status IN ('green','yellow','red')),
      follow_up_status TEXT DEFAULT 'pending' CHECK(follow_up_status IN ('pending','contacted','promised','escalated','legal')),
      follow_up_date DATE,
      follow_up_notes TEXT,
      escalation_level INTEGER DEFAULT 0,
      owner_id INTEGER REFERENCES users(id),
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS collection_follow_ups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receivable_id INTEGER REFERENCES receivables(id) ON DELETE CASCADE,
      follow_up_date DATE NOT NULL,
      contact_method TEXT CHECK(contact_method IN ('call','email','visit','whatsapp','legal_notice')),
      response TEXT,
      promised_date DATE,
      promised_amount REAL,
      status TEXT DEFAULT 'done',
      followed_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receivable_id INTEGER REFERENCES receivables(id),
      amount REAL NOT NULL,
      collection_date DATE NOT NULL,
      payment_mode TEXT,
      transaction_ref TEXT,
      notes TEXT,
      collected_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ============================================
    -- SYSTEM 3: INDENT TO PAYMENT FMS (Enhanced)
    -- ============================================
    CREATE TABLE IF NOT EXISTS grn (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_po_id INTEGER REFERENCES vendor_pos(id),
      indent_id INTEGER REFERENCES indents(id),
      grn_number TEXT UNIQUE,
      grn_date DATE NOT NULL,
      received_by INTEGER REFERENCES users(id),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','partial','complete','rejected')),
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS grn_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grn_id INTEGER REFERENCES grn(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      ordered_qty REAL DEFAULT 0,
      received_qty REAL DEFAULT 0,
      accepted_qty REAL DEFAULT 0,
      rejected_qty REAL DEFAULT 0,
      unit TEXT DEFAULT 'nos',
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      remarks TEXT
    );

    CREATE TABLE IF NOT EXISTS indent_tracker (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      indent_id INTEGER REFERENCES indents(id),
      stage TEXT NOT NULL CHECK(stage IN ('indent_raised','approval_pending','approved','po_created','dispatched','grn_done','bill_entered','payment_done')),
      stage_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER REFERENCES users(id),
      notes TEXT
    );

    -- ============================================
    -- SYSTEM 4: DPR DAILY CALCULATION SYSTEM
    -- ============================================
    CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT,
      client_name TEXT,
      po_id INTEGER REFERENCES purchase_orders(id),
      business_book_id INTEGER REFERENCES business_book(id),
      site_engineer_id INTEGER REFERENCES users(id),
      supervisor TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','completed','on_hold')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dpr (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER REFERENCES sites(id),
      report_date DATE NOT NULL,
      sales_bill_id INTEGER,
      submitted_by INTEGER REFERENCES users(id),
      submission_time DATETIME,
      weather TEXT DEFAULT 'clear' CHECK(weather IN ('clear','rainy','cloudy','hot','windy')),
      overall_status TEXT DEFAULT 'on_track' CHECK(overall_status IN ('on_track','delayed','ahead','blocked')),
      -- SEPL DPR format
      shift TEXT DEFAULT 'day',
      contractor_name TEXT,
      contractor_manpower INTEGER DEFAULT 0,
      mb_sheet_no TEXT,
      grand_total_a REAL DEFAULT 0,
      grand_total_b REAL DEFAULT 0,
      profit_loss REAL DEFAULT 0,
      floor_zone TEXT,
      system_type TEXT,
      safety_toolbox_talk INTEGER DEFAULT 0,
      safety_ppe_compliance INTEGER DEFAULT 0,
      safety_incidents TEXT,
      next_day_plan TEXT,
      hindrances TEXT,
      site_photos TEXT,
      remarks TEXT,
      billing_ready INTEGER DEFAULT 0,
      approved_by INTEGER REFERENCES users(id),
      approval_status TEXT DEFAULT 'pending' CHECK(approval_status IN ('pending','approved','rejected')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- CRM Sales Funnel FMS (mam's spec — flat 3-step tracking table
    -- parallel to the 11-stage sales_funnel module). Lead capture +
    -- Step 1 Quotation submission, Step 2 Negotiation, Step 3 Win/Loss.
    -- Built as its own table so this simpler workflow doesn't have to
    -- carry the 11-stage funnel's heavier state machine.
    CREATE TABLE IF NOT EXISTS crm_funnel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_no TEXT UNIQUE,
      -- Lead capture
      client_name TEXT NOT NULL,
      company_name TEXT,
      mobile TEXT,
      email TEXT,
      source TEXT,                -- 'SOURCE OF ENQUIRY'
      address TEXT,
      state TEXT,
      district TEXT,
      remarks TEXT,
      category TEXT,
      type TEXT,                  -- private / government / other
      -- Step 1 — Quotation
      cust_boq_link TEXT,
      quotation_link TEXT,
      quotation_amount REAL DEFAULT 0,
      quotation_submitted INTEGER DEFAULT 0,
      quotation_submit_date DATETIME,
      -- Step 2 — Negotiation
      negotiation_status TEXT,    -- 'in_progress' | 'hold' | 'done' | 'dropped'
      negotiation_amount REAL DEFAULT 0,
      negotiation_remarks TEXT,
      -- Step 3 — Win/Loss
      final_status TEXT,          -- 'win' | 'loss' | NULL (still open)
      loss_reason TEXT,
      closed_at DATETIME,
      -- Bookkeeping
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Multi-contractor entries for a DPR. Mam: "AT LEAST OPTION OF 5
    -- CONTRACTOR" — the form originally had a single contractor_name +
    -- contractor_manpower field on the dpr row, which kept getting
    -- overwritten when multiple subcontractors were on site the same day.
    -- This table lets the engineer log each one separately. The legacy
    -- dpr.contractor_name / contractor_manpower columns remain so older
    -- reports stay readable.
    CREATE TABLE IF NOT EXISTS dpr_contractors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dpr_id INTEGER REFERENCES dpr(id) ON DELETE CASCADE,
      name TEXT,
      manpower INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Contractor manpower attendance (mam 2026-06-22): the site engineer's
    -- MORNING punch of which sub-contractors are present on a site and how many
    -- manpower each brought. Separate from team (user) attendance; pre-fills the
    -- DPR "Contractors on Site". One row per site + date + contractor (upsert).
    CREATE TABLE IF NOT EXISTS contractor_attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
      attendance_date TEXT NOT NULL,
      subcontractor_id INTEGER,
      contractor_name TEXT NOT NULL,
      contractor_type TEXT,
      manpower INTEGER DEFAULT 0,
      photo_url TEXT,
      marked_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(site_id, attendance_date, contractor_name)
    );

    -- Work items from PO (item name, qty, rate, amount + floor/zone + planned/actual)
    CREATE TABLE IF NOT EXISTS dpr_work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dpr_id INTEGER REFERENCES dpr(id) ON DELETE CASCADE,
      po_item_id INTEGER REFERENCES po_items(id),
      description TEXT NOT NULL,
      unit TEXT DEFAULT 'nos',
      floor_zone TEXT,
      boq_qty REAL DEFAULT 0,
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      planned_qty REAL DEFAULT 0,
      actual_qty REAL DEFAULT 0,
      cumulative_qty REAL DEFAULT 0,
      variance_pct REAL DEFAULT 0,
      remarks TEXT
    );

    -- MEPF Trade-wise manpower
    CREATE TABLE IF NOT EXISTS dpr_manpower (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dpr_id INTEGER REFERENCES dpr(id) ON DELETE CASCADE,
      trade TEXT NOT NULL,
      required INTEGER DEFAULT 0,
      deployed INTEGER DEFAULT 0,
      shortage INTEGER DEFAULT 0
    );

    -- Material consumed from PO items
    CREATE TABLE IF NOT EXISTS dpr_material (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dpr_id INTEGER REFERENCES dpr(id) ON DELETE CASCADE,
      po_item_id INTEGER REFERENCES po_items(id),
      material_name TEXT NOT NULL,
      unit TEXT DEFAULT 'nos',
      boq_qty REAL DEFAULT 0,
      consumed_today REAL DEFAULT 0,
      cumulative_consumed REAL DEFAULT 0,
      balance_qty REAL DEFAULT 0,
      remarks TEXT
    );

    -- Machinery/Tools used on site
    CREATE TABLE IF NOT EXISTS dpr_machinery (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dpr_id INTEGER REFERENCES dpr(id) ON DELETE CASCADE,
      equipment TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      hours_used REAL DEFAULT 0,
      condition TEXT DEFAULT 'working',
      remarks TEXT
    );

    -- ============================================
    -- PAYMENT REQUIRED MODULE (FMS)
    -- ============================================
    CREATE TABLE IF NOT EXISTS payment_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_no TEXT UNIQUE,
      employee_name TEXT NOT NULL,
      site_id INTEGER REFERENCES sites(id),
      site_name TEXT,
      department TEXT,
      contact_number TEXT,
      category TEXT NOT NULL CHECK(category IN ('TA/DA','Purchase','Labour','Transport')),
      amount REAL NOT NULL DEFAULT 0,
      purpose TEXT NOT NULL,
      payment_mode TEXT DEFAULT 'Bank' CHECK(payment_mode IN ('Cash','Bank','UPI')),
      required_by_date DATE,
      attachment_link TEXT,
      -- TA/DA fields
      travel_from_to TEXT,
      travel_dates TEXT,
      mode_of_travel TEXT,
      stay_details TEXT,
      ticket_upload TEXT,
      start_km REAL DEFAULT 0,
      end_km REAL DEFAULT 0,
      km_photo TEXT,
      -- Purchase fields
      indent_number TEXT,
      item_description TEXT,
      vendor_name TEXT,
      quotation_link TEXT,
      -- Labour fields
      labour_type TEXT,
      number_of_workers INTEGER DEFAULT 0,
      work_duration TEXT,
      site_engineer_name TEXT,
      -- Transport fields
      vehicle_type TEXT,
      from_to_location TEXT,
      material_description TEXT,
      driver_vendor_name TEXT,
      -- Status & Workflow
      current_step INTEGER DEFAULT 1,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','step1_approved','accounts_approved','dues_checked','velocity_checked','final_approved','rejected')),
      rejection_remarks TEXT,
      rejected_by INTEGER REFERENCES users(id),
      rejected_at DATETIME,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Approval trail for payment requests
    CREATE TABLE IF NOT EXISTS payment_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER REFERENCES payment_requests(id) ON DELETE CASCADE,
      step INTEGER NOT NULL,
      step_name TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('approved','rejected')),
      remarks TEXT,
      approved_by INTEGER REFERENCES users(id),
      approved_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ============================================
    -- ATTENDANCE MODULE (Geofencing + Live Photo)
    -- ============================================
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      date DATE NOT NULL,
      punch_in_time DATETIME,
      punch_out_time DATETIME,
      punch_in_lat REAL,
      punch_in_lng REAL,
      punch_in_address TEXT,
      punch_in_photo TEXT,
      punch_out_lat REAL,
      punch_out_lng REAL,
      punch_out_address TEXT,
      punch_out_photo TEXT,
      site_id INTEGER REFERENCES sites(id),
      site_name TEXT,
      total_hours REAL DEFAULT 0,
      status TEXT DEFAULT 'present' CHECK(status IN ('present','half_day','short_day','absent','late','leave','holiday')),
      remarks TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Geofence settings per site
    CREATE TABLE IF NOT EXISTS geofence_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER REFERENCES sites(id),
      site_name TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      radius_meters INTEGER DEFAULT 200,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Project Finance (manual fields for cash flow tracker)
    CREATE TABLE IF NOT EXISTS project_finance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_book_id INTEGER UNIQUE REFERENCES business_book(id),
      amount_received REAL DEFAULT 0,
      milestone_name TEXT,
      aanchal_value REAL DEFAULT 0,
      payment_investment_days INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Location tracking (live tracking throughout the day)
    CREATE TABLE IF NOT EXISTS location_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      date DATE NOT NULL,
      time DATETIME NOT NULL,
      latitude REAL,
      longitude REAL,
      address TEXT,
      site_name TEXT
    );

    -- Leave requests
    CREATE TABLE IF NOT EXISTS leave_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      leave_type TEXT DEFAULT 'casual' CHECK(leave_type IN ('casual','sick','earned','half_day','short_leave','comp_off')),
      from_date DATE NOT NULL,
      to_date DATE NOT NULL,
      from_time TEXT,
      to_time TEXT,
      days INTEGER DEFAULT 1,
      hours REAL DEFAULT 0,
      reason TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      approved_by INTEGER REFERENCES users(id),
      remarks TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Payroll settings (single-row config, id=1). Admin tunes every rule
    -- here so salary auto-calc isn't hardcoded — late cutoff, half-day
    -- cutoff, leave allowances, working days, OT rate, etc.
    CREATE TABLE IF NOT EXISTS payroll_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      late_after_time TEXT DEFAULT '09:46',           -- start of late zone (after this = late mark)
      half_day_after_time TEXT DEFAULT '10:00',       -- after this time = half day deduction
      min_hours_full_day REAL DEFAULT 8,              -- below this hours = half day
      min_hours_half_day REAL DEFAULT 4,              -- below this hours = absent
      skip_half_day_if_short_leave INTEGER DEFAULT 1, -- if short leave applied that day → no half-day deduction
      late_grace_count INTEGER DEFAULT 3,             -- N late marks per month are free
      late_per_minute_rate REAL DEFAULT 20,           -- Rs / minute deduction once over grace
      lates_to_absent INTEGER DEFAULT 0,              -- N late marks = 1 absent (alternative model, 0 disables)
      basic_pct REAL DEFAULT 56.5,                    -- Salary breakdown (matches SEPL slip)
      conveyance_pct REAL DEFAULT 22.6,
      hra_pct REAL DEFAULT 5.9,
      adhoc_pct REAL DEFAULT 15.0,
      misc_pct REAL DEFAULT 0,
      working_days_per_month INTEGER DEFAULT 26,      -- divisor for per-day rate
      sundays_paid INTEGER DEFAULT 1,                 -- 1 = Sundays counted as paid for monthly staff
      cl_per_month REAL DEFAULT 1,                    -- paid casual leave allowance per month
      sl_per_month REAL DEFAULT 1,                    -- paid sick leave allowance
      pl_per_month REAL DEFAULT 1.5,                  -- paid privilege/earned leave
      short_leave_per_month INTEGER DEFAULT 2,        -- short-leave count allowed
      ot_threshold_hours REAL DEFAULT 9,              -- hours/day before OT kicks in (mam: OT for >9h/day)
      ot_rate_multiplier REAL DEFAULT 1,              -- OT pay rate (× normal hourly); mam: straight rate = salary/days/9 per hour
      pay_cycle_start_day INTEGER DEFAULT 1,          -- 1 = month-start, 26 = 26th-to-25th
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER REFERENCES users(id)
    );

    -- Saved monthly payroll runs — when admin "Finalises" a month the
    -- calculated salary snapshot is locked here so future attendance edits
    -- don't change historical payslips.
    CREATE TABLE IF NOT EXISTS payroll_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT NOT NULL,                            -- YYYY-MM
      employee_id INTEGER REFERENCES employees(id),
      employee_name TEXT,
      base_salary REAL DEFAULT 0,
      working_days INTEGER DEFAULT 0,
      paid_days REAL DEFAULT 0,
      half_days INTEGER DEFAULT 0,
      absent_days INTEGER DEFAULT 0,
      late_marks INTEGER DEFAULT 0,
      lates_converted_absent REAL DEFAULT 0,
      paid_leaves REAL DEFAULT 0,
      unpaid_leaves REAL DEFAULT 0,
      sundays REAL DEFAULT 0,
      ot_hours REAL DEFAULT 0,
      gross_earned REAL DEFAULT 0,
      ot_pay REAL DEFAULT 0,
      deductions REAL DEFAULT 0,
      net_pay REAL DEFAULT 0,
      breakdown_json TEXT,                            -- per-day breakdown for slip
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','finalised','disbursed')),
      finalised_by INTEGER REFERENCES users(id),
      finalised_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(month, employee_id)
    );

    -- Advance salary taken by an employee in a given month (mam 2026-06-09:
    -- "some persons take advance salary"). Admin enters the amount in the
    -- monthly payroll screen; payroll deducts it from that month's net pay.
    CREATE TABLE IF NOT EXISTS payroll_advances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT NOT NULL,                            -- YYYY-MM
      employee_id INTEGER REFERENCES employees(id),
      amount REAL DEFAULT 0,
      updated_by INTEGER REFERENCES users(id),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(month, employee_id)
    );

    -- Score-card templates (one per role / job-type). Each template has
    -- many KPIs that sum to 100% weight. Mam shared 20 such templates as
    -- PDFs (Aanchal-Finance, Site Eng, Supervisor, etc.) on 2026-05-04.
    CREATE TABLE IF NOT EXISTS score_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- KPIs (metrics) within a template
    CREATE TABLE IF NOT EXISTS score_kpis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER REFERENCES score_templates(id) ON DELETE CASCADE,
      group_name TEXT,                       -- 'Basic' | 'Weekly' | 'Monthly' | custom
      metric_name TEXT NOT NULL,
      weightage REAL DEFAULT 0,              -- 0-100, sum to 100 per template
      direction TEXT DEFAULT 'higher_better',-- 'higher_better' or 'lower_better'
      data_source TEXT DEFAULT 'manual',     -- 'manual' | 'auto:delegations' | 'auto:pms' | 'auto:checklists' | 'auto:tickets'
      display_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      default_planned REAL DEFAULT 0,        -- fixed weekly target (mam's "this plan is fix")
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Each user is assigned to one template (their role's MIS)
    CREATE TABLE IF NOT EXISTS score_user_template (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      template_id INTEGER REFERENCES score_templates(id),
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      assigned_by INTEGER REFERENCES users(id)
    );

    -- Module owners — mam decides the accountable owner + backup per ERP
    -- module group (2026-06-29). Drives the War Room QQTC "Module Audit" tab:
    -- a row here overrides the authored recommendation. module_key is the
    -- slug of the module label (stable authored content).
    CREATE TABLE IF NOT EXISTS module_owners (
      module_key TEXT PRIMARY KEY,
      owner_user_id INTEGER REFERENCES users(id),
      backup_user_id INTEGER REFERENCES users(id),
      updated_by INTEGER REFERENCES users(id),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Per-user KPI target override — mam (2026-06-02): "Same target
    -- weekly but per-user (different per engineer)".  When a user is
    -- assigned to a template, mam can override the KPI's
    -- default_planned with a user-specific value (e.g. Ajmer's
    -- "Indent vs Bill" target = 5, Aakash's target = 3 — same KPI,
    -- same template).  Scorecard reads this override first; falls
    -- back to score_kpis.default_planned when no row exists.
    CREATE TABLE IF NOT EXISTS score_user_kpi_target (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kpi_id  INTEGER NOT NULL REFERENCES score_kpis(id) ON DELETE CASCADE,
      planned_value REAL NOT NULL DEFAULT 0,
      updated_by INTEGER REFERENCES users(id),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, kpi_id)
    );

    -- Weekly entries: one row per (user, kpi, week_start_monday)
    CREATE TABLE IF NOT EXISTS score_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      kpi_id INTEGER REFERENCES score_kpis(id),
      week_start DATE NOT NULL,
      planned REAL DEFAULT 0,
      actual REAL DEFAULT 0,
      actual_pct REAL,
      last_week_pct REAL,
      total_uptodate REAL,
      pending_uptodate REAL,
      pending_work REAL,
      pending_pct REAL,
      commitment TEXT,
      notes TEXT,
      updated_by INTEGER REFERENCES users(id),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, kpi_id, week_start)
    );

    -- Weekly COMMITMENT — one number per (user, week) that the employee
    -- promises for the COMING week (mam 2026-07-06).  Stored in the same
    -- "variance vs plan" convention the Scorecard renders: 0% = will fully
    -- hit plan, down to −50% = the worst they'll allow themselves.  Keyed to
    -- the week the promise is FOR (target week), so committed_pct[W] pairs
    -- directly with that week's achieved variance for the gap graph.
    CREATE TABLE IF NOT EXISTS score_commitments (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      week_start DATE NOT NULL,
      committed_pct REAL NOT NULL,          -- −50 … 0 (variance vs plan)
      note TEXT,
      updated_by INTEGER REFERENCES users(id),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, week_start)
    );

    -- Web Push subscriptions — one row per (user × device). Multiple
    -- rows per user is fine (mam wants phone + laptop + desktop).
    -- VAPID keys stored in app_settings as a single row.
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      device_label TEXT,
      active INTEGER DEFAULT 1,
      last_seen_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Generic key/value app settings — used for VAPID keys + future
    -- one-shot config that doesn't deserve its own table.
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Dynamic email-trigger rules (mam 2026-06-03: "lots of email with
    -- trigger and pattern with my selected things, dynamic"). Each row is a
    -- user-built rule: when <event_key> fires AND <conditions> match, email
    -- <recipients> using <subject_tpl>/<body_tpl> with {{variable}} merge.
    CREATE TABLE IF NOT EXISTS email_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      event_key TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      conditions TEXT,            -- JSON array [{field,op,value}]
      recipients TEXT,            -- JSON {people:[],fixed:'',roles:[]}
      from_addr TEXT,             -- optional per-rule From (template, {{vars}} ok)
      subject_tpl TEXT,
      body_tpl TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_fired_at DATETIME,
      fire_count INTEGER DEFAULT 0
    );

    -- Sales Funnel — universal stage audit log per mam's spec:
    -- 'every stage entry timestamp · actor (user_id) · action · evidence
    -- (file/note) · stage exit timestamp'. Forward-only state machine;
    -- backward transitions allowed only with reason + supervisor approval
    -- (also logged here).
    CREATE TABLE IF NOT EXISTS sales_funnel_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES sales_funnel(id) ON DELETE CASCADE,
      stage TEXT,                                  -- stage name at time of action
      action TEXT,                                 -- 'create' | 'enter_stage' | 'exit_stage' | 'drop' | 'reopen' | 'edit'
      actor_id INTEGER REFERENCES users(id),
      actor_name TEXT,                             -- snapshot
      evidence_url TEXT,                           -- optional file
      notes TEXT,                                  -- free-text reason / context
      at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sf_audit_lead ON sales_funnel_audit(lead_id, at);

    -- Cheque FMS — mam: "cheque status fms create need filed when
    -- raise/issue check this is stage one cheque details. stage 2 is
    -- call cheque status called action is in give dropdwon clear,
    -- hold, bounce, stopped with give remarks and if cheque hold give
    -- next date." 3-stage workflow:
    --   Stage 1: raise/issue → row inserted with current_status='pending'
    --   Stage 2: on/after cheque_date → action {clear|hold|bounce|stopped}
    --            hold → must include hold_until (next date)
    --   Stage 3: on/after hold_until → action {clear|bounce|stopped}
    -- Every action lands in cheque_actions for full audit trail.
    CREATE TABLE IF NOT EXISTS cheques (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cheque_number TEXT NOT NULL,
      payee_to TEXT NOT NULL,
      bank_name TEXT,
      bank_other TEXT,
      cheque_date DATE NOT NULL,
      amount REAL DEFAULT 0,
      photo_url TEXT,
      issue_status TEXT DEFAULT 'approved' CHECK(issue_status IN ('approved','cancel')),
      current_status TEXT DEFAULT 'pending' CHECK(current_status IN ('pending','clear','hold','bounce','stopped','cancel')),
      hold_until DATE,
      raised_by INTEGER REFERENCES users(id),
      raised_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_cheques_status ON cheques(current_status, cheque_date);
    CREATE INDEX IF NOT EXISTS idx_cheques_hold ON cheques(current_status, hold_until);

    CREATE TABLE IF NOT EXISTS cheque_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cheque_id INTEGER REFERENCES cheques(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK(action IN ('clear','hold','bounce','stopped','cancel','re_issue')),
      remarks TEXT,
      next_date DATE,
      action_by INTEGER REFERENCES users(id),
      action_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_chq_actions_cheque ON cheque_actions(cheque_id, action_at);

    -- Snag list — defects / punch-list items raised against a site,
    -- assigned to an employee, who uploads proof and only then it's
    -- closed by approval (delegation-style flow). Mam's ask:
    -- "assign employee will upload proof and after approval task close
    -- like delegation".
    --
    -- Status flow:
    --   open       → just raised, assignee hasn't submitted proof yet
    --   submitted  → assignee uploaded proof_url, awaiting approval
    --   approved   → raiser/admin accepted the proof, task closed
    --   rejected   → raiser rejected proof; goes back to 'open' next
    --                time assignee resubmits (reject_reason carries why)
    CREATE TABLE IF NOT EXISTS snags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snag_no TEXT UNIQUE,                       -- SNAG-YYYY-####
      site_id INTEGER REFERENCES sites(id),
      site_name TEXT,                            -- snapshot for display
      location TEXT,                             -- e.g. "2nd floor pump room"
      description TEXT NOT NULL,
      photo_url TEXT,                            -- the snag photo (raised)
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
      status TEXT DEFAULT 'open' CHECK(status IN ('open','submitted','approved','rejected')),
      assigned_to INTEGER REFERENCES users(id),
      assigned_to_name TEXT,                     -- snapshot
      raised_by INTEGER REFERENCES users(id),
      raised_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      target_date DATE,
      proof_url TEXT,                            -- assignee's fix photo / PDF
      proof_notes TEXT,                          -- assignee's note on submit
      proof_submitted_at DATETIME,
      proof_submitted_by INTEGER REFERENCES users(id),
      approved_by INTEGER REFERENCES users(id),
      approved_at DATETIME,
      reject_reason TEXT,                        -- why proof was rejected
      rejected_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Rental properties — flats / houses / guest-houses we rent for
    -- staff accommodation (site engineers / supervisors stationed at
    -- project locations). One row per property, agreement-level info.
    CREATE TABLE IF NOT EXISTS rental_properties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT,
      city TEXT,
      state TEXT,
      pincode TEXT,
      landlord_name TEXT,
      landlord_phone TEXT,
      landlord_email TEXT,
      monthly_rent REAL DEFAULT 0,
      deposit_paid REAL DEFAULT 0,
      agreement_start_date DATE,
      agreement_end_date DATE,
      bedrooms INTEGER DEFAULT 1,
      total_capacity INTEGER DEFAULT 1,
      amenities TEXT,                       -- comma-sep e.g. 'AC, Wifi, Geyser'
      agreement_file_url TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','expired','terminated')),
      notes TEXT,
      site_id INTEGER REFERENCES sites(id), -- optional linkage to project site
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Individual rooms within a property (a 3BHK flat has 3 rooms)
    CREATE TABLE IF NOT EXISTS rental_rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER REFERENCES rental_properties(id) ON DELETE CASCADE,
      room_name TEXT NOT NULL,              -- e.g. 'Master Bedroom', 'Room A'
      capacity INTEGER DEFAULT 1,           -- bed count
      status TEXT DEFAULT 'available' CHECK(status IN ('available','occupied','maintenance','reserved')),
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Booking = an occupant stay. Multiple occupants can share a room
    -- (each gets their own row with rent_share splitting the room cost).
    CREATE TABLE IF NOT EXISTS rental_bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER REFERENCES rental_rooms(id),
      property_id INTEGER REFERENCES rental_properties(id),
      occupant_user_id INTEGER REFERENCES users(id),  -- nullable for non-employees
      occupant_name TEXT,                              -- snapshot
      occupant_phone TEXT,
      check_in_date DATE NOT NULL,
      check_out_date DATE,                             -- planned
      actual_checkout_date DATE,
      site_id INTEGER REFERENCES sites(id),            -- which project site
      rent_share REAL DEFAULT 0,                       -- per-occupant share of rent
      deposit_collected REAL DEFAULT 0,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','completed','cancelled')),
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Per-month rent requests — site engineer fills in landlord
    -- details + Aadhar + outside photo + bank/UPI + month and submits.
    -- Admin / accountant approves → paid. Designed as a self-contained
    -- payment workflow (separate from the property/booking entity model).
    CREATE TABLE IF NOT EXISTS rent_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_no TEXT UNIQUE,                  -- RR-YYYY-####
      site_id INTEGER REFERENCES sites(id),
      site_name TEXT,                          -- snapshot for display
      arrange_for TEXT CHECK(arrange_for IN ('SEPL','Contractor')),
      contractor_name TEXT,                    -- only if Contractor
      owner_name TEXT NOT NULL,
      owner_phone TEXT,
      owner_aadhar_url TEXT,                   -- file upload (image / PDF)
      room_photo_url TEXT,                     -- outside-of-room photo
      photo_taken_at DATETIME,                 -- client-side timestamp
      photo_lat REAL,
      photo_lng REAL,
      payment_mode TEXT DEFAULT 'Bank' CHECK(payment_mode IN ('Bank','UPI','Scanner')),
      bank_account TEXT,
      ifsc_code TEXT,
      upi_id TEXT,                             -- UPI handle e.g. 9876543210@paytm
      scanner_url TEXT,                        -- UPI QR screenshot
      rent_month TEXT NOT NULL,                -- 'YYYY-MM'
      rent_amount REAL DEFAULT 0,
      pay_by_day INTEGER DEFAULT 10,           -- day-of-month rent must be paid by
      inactive INTEGER DEFAULT 0,              -- 1 = rental ended (no future rent expected)
      inactive_at DATETIME,
      inactive_reason TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','paid','rejected')),
      approved_by INTEGER REFERENCES users(id),
      approved_at DATETIME,
      paid_by INTEGER REFERENCES users(id),
      paid_at DATETIME,
      paid_via TEXT,                           -- 'Bank' / 'UPI' / 'Cash'
      transaction_ref TEXT,
      receipt_url TEXT,
      reject_reason TEXT,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Monthly rent payments paid to landlord
    CREATE TABLE IF NOT EXISTS rental_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER REFERENCES rental_properties(id) ON DELETE CASCADE,
      period_month TEXT NOT NULL,           -- 'YYYY-MM'
      amount_paid REAL DEFAULT 0,
      paid_date DATE,
      paid_via TEXT,                        -- 'Bank' / 'UPI' / 'Cash'
      transaction_ref TEXT,
      receipt_url TEXT,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(property_id, period_month)
    );

    -- Tools master catalog (returnable assets, separate from consumable
    -- stock). Each tool is unique — drill machine, multimeter, ladder,
    -- etc. — and tracked individually with serial / current location.
    CREATE TABLE IF NOT EXISTS tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_code TEXT UNIQUE,                  -- e.g. T-2026-0001 auto-generated
      name TEXT NOT NULL,
      category TEXT,                          -- 'Drilling','Cutting','Measurement','Safety','Power','Hand','Other'
      brand TEXT,
      model TEXT,
      serial_no TEXT,
      purchase_date DATE,
      purchase_price REAL DEFAULT 0,
      condition TEXT DEFAULT 'good' CHECK(condition IN ('new','good','fair','poor','scrap')),
      status TEXT DEFAULT 'available' CHECK(status IN ('available','in_use','maintenance','lost','scrapped')),
      current_site_id INTEGER REFERENCES sites(id),
      current_user_id INTEGER REFERENCES users(id),
      last_calibration_date DATE,
      next_calibration_date DATE,
      photo_url TEXT,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Movement log — every issue / return / transfer / maintenance / scrap
    -- captured here so admin can answer 'where did this drill go on Apr 5?'
    CREATE TABLE IF NOT EXISTS tool_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_id INTEGER REFERENCES tools(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK(action IN ('issue','return','transfer','maintenance','repair','scrap','calibration')),
      from_site_id INTEGER REFERENCES sites(id),
      to_site_id INTEGER REFERENCES sites(id),
      from_user_id INTEGER REFERENCES users(id),
      to_user_id INTEGER REFERENCES users(id),
      expected_return_date DATE,
      actual_return_date DATE,
      condition_at_action TEXT,
      notes TEXT,
      photo_url TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Weekly tools list submission per site (Supervisor MIS KPI: "Tools
    -- List submission as per given site name tools should be update").
    -- One row per (site, submitter, week_start) — UNIQUE prevents dupes.
    CREATE TABLE IF NOT EXISTS tools_list_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER REFERENCES sites(id),
      submitted_by INTEGER REFERENCES users(id),
      week_start DATE NOT NULL,
      tools_count INTEGER DEFAULT 0,
      tools_json TEXT,                        -- JSON array of {tool_id, name, qty, condition}
      photo_url TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(site_id, submitted_by, week_start)
    );

    -- Company Assets — IT / office equipment register: laptops, mobile
    -- phones, SIM cards, chargers, monitors, etc. Separate from Tools
    -- (which tracks construction equipment). Mam: "add also system
    -- company assets like laptop, sim, phone etc for maintain record".
    --
    -- Issue / Return / Maintenance / Scrap actions are recorded in
    -- company_asset_movements for full history.
    CREATE TABLE IF NOT EXISTS company_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_no TEXT UNIQUE,                       -- AST-YYYY-####
      category TEXT,                              -- Laptop / Mobile / SIM / etc
      name TEXT NOT NULL,                         -- e.g. 'Dell Latitude 5420'
      brand TEXT,
      model TEXT,
      serial_no TEXT,                             -- serial / IMEI / SIM number
      mobile_number TEXT,                         -- for SIM cards
      carrier TEXT,                               -- for SIM cards (Jio / Airtel / VI)
      monthly_cost REAL DEFAULT 0,                -- monthly recharge / subscription
      purchase_date DATE,
      purchase_price REAL DEFAULT 0,
      vendor TEXT,
      warranty_till DATE,
      condition TEXT DEFAULT 'good' CHECK(condition IN ('new','good','fair','poor','damaged','scrap')),
      status TEXT DEFAULT 'available' CHECK(status IN ('available','issued','maintenance','lost','scrapped')),
      current_user_id INTEGER REFERENCES users(id),
      current_user_name TEXT,                     -- snapshot for display
      issued_at DATETIME,
      returned_at DATETIME,
      photo_url TEXT,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- One row per Issue / Return / Maintenance / Scrap event.
    CREATE TABLE IF NOT EXISTS company_asset_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER REFERENCES company_assets(id) ON DELETE CASCADE,
      movement_type TEXT CHECK(movement_type IN ('issue','return','maintenance','scrap')),
      from_user_id INTEGER REFERENCES users(id),
      to_user_id INTEGER REFERENCES users(id),
      notes TEXT,
      performed_by INTEGER REFERENCES users(id),
      performed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Vendor PO ↔ Indent Item link (one PO can cover multiple indent items;
    -- one indent item can split across multiple POs for partial orders).
    CREATE TABLE IF NOT EXISTS vendor_po_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_po_id INTEGER REFERENCES vendor_pos(id) ON DELETE CASCADE,
      indent_item_id INTEGER REFERENCES indent_items(id),
      quantity REAL DEFAULT 0,
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      terms TEXT,                 -- 'Advance' or 'Credit'
      credit_days INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Per-item vendor rates (3-vendor quote per indent line). Up to 3
    -- vendor_N columns keep the sheet-like layout mam asked for. final_rate
    -- + selected_vendor are set once the purchase manager / admin finalizes.
    CREATE TABLE IF NOT EXISTS indent_item_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      indent_item_id INTEGER REFERENCES indent_items(id) ON DELETE CASCADE,
      vendor1_name TEXT, vendor1_rate REAL DEFAULT 0, vendor1_terms TEXT, vendor1_credit_days INTEGER DEFAULT 0,
      vendor2_name TEXT, vendor2_rate REAL DEFAULT 0, vendor2_terms TEXT, vendor2_credit_days INTEGER DEFAULT 0,
      vendor3_name TEXT, vendor3_rate REAL DEFAULT 0, vendor3_terms TEXT, vendor3_credit_days INTEGER DEFAULT 0,
      final_rate REAL DEFAULT 0,
      final_vendor_name TEXT,
      final_terms TEXT,
      final_credit_days INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','quoted','finalized','rejected')),
      entered_by INTEGER REFERENCES users(id),
      finalized_by INTEGER REFERENCES users(id),
      finalized_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Delegations — a user assigns a task to another user; assignee uploads
    -- proof; assigner approves or rejects with a reason. Rejected tasks
    -- reappear on the assignee's dashboard with the reason, so they can redo.
    CREATE TABLE IF NOT EXISTS delegations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      assigned_by INTEGER REFERENCES users(id),
      assigned_to INTEGER REFERENCES users(id),
      due_date DATE,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','submitted','approved','rejected')),
      proof_url TEXT,
      submitted_at DATETIME,
      reviewed_at DATETIME,
      reviewer_id INTEGER REFERENCES users(id),
      reject_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Audit log — records every mutating action (POST / PUT / PATCH /
    -- DELETE) taken against the API. Populated automatically by the
    -- auditMiddleware so admins can answer "who changed what, when?".
    --
    -- before / after are optional JSON snapshots captured by routes that
    -- call the logAuditEvent() helper manually (e.g. when they have the
    -- pre-image of the row). Bulk-auto entries leave those as null.
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at DATETIME DEFAULT CURRENT_TIMESTAMP,
      user_id INTEGER REFERENCES users(id),
      user_name TEXT,
      user_role TEXT,
      action TEXT,                 -- 'CREATE' | 'UPDATE' | 'DELETE' | 'LOGIN' | ... (free-form, default derived from HTTP method)
      entity_type TEXT,            -- e.g. 'purchase_order' | 'complaint' | 'user'
      entity_id TEXT,              -- string so we can handle numeric + natural keys
      entity_label TEXT,           -- human-friendly label (optional)
      method TEXT,                 -- HTTP method
      path TEXT,                   -- request path (without query)
      query TEXT,                  -- JSON-encoded query string
      body_summary TEXT,           -- compact JSON summary of request body (secrets stripped)
      status_code INTEGER,
      ip TEXT,
      user_agent TEXT,
      before_json TEXT,            -- optional pre-image
      after_json TEXT              -- optional post-image
    );
    -- audit_log indexes are created post-migration in safeIndexes (some
    -- prod DBs predate the user_id column and we don't want to crash boot)

    -- Generic singleton key/value bag for app-level state that doesn't
    -- belong on a domain table (emergency reset hash, feature flags, etc).
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ============================================
    -- INVENTORY MANAGEMENT
    -- ============================================
    -- Multiple physical stores: one Office Store (central) + one Site
    -- Store per active site. type='office' for the main warehouse,
    -- type='site_store' for site-attached stores (site_id NOT NULL).
    CREATE TABLE IF NOT EXISTS warehouses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'office' CHECK(type IN ('office','site_store')),
      site_id INTEGER REFERENCES sites(id),
      location TEXT,
      in_charge TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- Live stock = quantity on hand per (item, warehouse) with running
    -- average rate so we can value the stock without a separate ledger.
    -- UNIQUE keeps it idempotent — INSERT OR conflict path updates qty.
    CREATE TABLE IF NOT EXISTS stock_balance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      item_master_id INTEGER NOT NULL REFERENCES item_master(id),
      quantity REAL NOT NULL DEFAULT 0,
      avg_rate REAL DEFAULT 0,
      reorder_level REAL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(warehouse_id, item_master_id)
    );
    -- Append-only journal of every stock change. type IN/OUT/TRANSFER/ADJUST.
    -- For TRANSFER we write TWO rows — one OUT from from_warehouse_id and one
    -- IN to to_warehouse_id, paired by the same reference_id so the UI can
    -- show them as a single movement.
    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      item_master_id INTEGER NOT NULL REFERENCES item_master(id),
      type TEXT NOT NULL CHECK(type IN ('IN','OUT')),
      quantity REAL NOT NULL,
      rate REAL DEFAULT 0,
      total_value REAL DEFAULT 0,
      reference_type TEXT,        -- e.g. 'GRN','OPENING','TRANSFER','ISSUE','ADJUST','PURCHASE'
      reference_id TEXT,          -- pairs the two halves of a TRANSFER + links to GRN/Indent rows
      from_warehouse_id INTEGER REFERENCES warehouses(id),  -- only set on OUT side of a TRANSFER
      to_warehouse_id INTEGER REFERENCES warehouses(id),    -- only set on IN side of a TRANSFER
      site_id INTEGER REFERENCES sites(id),                 -- for site-issue movements
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- stock_movements indexes are created post-migration in safeIndexes

    -- ─── Stock Issue Note — header row for "indent split: X from store" ──
    -- Mam (2026-06-02): when an approver decides to issue N pcs of an
    -- indent line from existing office stock instead of buying new, the
    -- ERP records:
    --   1. This stock_issue_notes header (gives MD an SI/YYYY/#### number
    --      to put on a printed challan for the storekeeper).
    --   2. Per-line OUT entries in stock_movements (reference_type='ISSUE',
    --      reference_id=<note_number>) — same path as transfers/GRNs so
    --      Inventory dashboards roll it up automatically.
    --   3. A child indent_items row with source='store',
    --      stock_issue_note_id pointing here, so the site engineer sees
    --      "5 issued SI/2026/0001 + 15 in PO #..." on one indent.
    CREATE TABLE IF NOT EXISTS stock_issue_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_number TEXT UNIQUE,                                 -- SI/2026/0001 format
      indent_id INTEGER REFERENCES indents(id) ON DELETE SET NULL,
      from_warehouse_id INTEGER REFERENCES warehouses(id),     -- office store we issued from
      to_site_id INTEGER REFERENCES sites(id),                 -- destination site
      total_qty REAL DEFAULT 0,
      total_value REAL DEFAULT 0,
      notes TEXT,
      issued_by INTEGER REFERENCES users(id),
      issued_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ─── PERFORMANCE INDEXES on hot tables (fast page loads) ────────────
    -- These were originally inline here, but some prod DBs were created
    -- before certain columns existed (e.g. audit_log.user_id, vendor_pos
    -- .cancelled, support_tickets.assigned_to). When the rigid db.exec()
    -- block hit a CREATE INDEX on a missing column, SQLite aborted the
    -- whole exec → server crashed at boot. They now live in safeIndexes
    -- below, run AFTER migrations, each guarded by its own try/catch.

    -- SQLite query planner optimizations
    -- WAL mode = better concurrency under load (multiple reads while one
    -- write is happening). NORMAL sync = faster, still crash-safe.

    -- Statutory dues calendar — mam (2026-05-30 dashboard audit):
    -- "audit all this i need to live data".  The Operating Console
    -- + TOC View used to show 4 hardcoded {amount: null} rows
    -- (GST / TDS / PF / Salary) so the page silently leaked stale
    -- data into finance reviews.  This tiny table holds the
    -- expected monthly amount + due day per category; cmdDashboard
    -- pulls it live and computes "due {DD-Mon}" for the current month.
    -- Seeded with 4 default rows at 0 so the structure exists;
    -- admin sets real amounts via SQL or a future Finance Settings UI.
    CREATE TABLE IF NOT EXISTS statutory_dues_calendar (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL UNIQUE,
      due_day INTEGER NOT NULL CHECK(due_day BETWEEN 1 AND 31),
      amount REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- Seed defaults only on first run; INSERT OR IGNORE preserves any
    -- admin edits across redeploys.
    INSERT OR IGNORE INTO statutory_dues_calendar (label, due_day, amount) VALUES
      ('GST',        20, 0),
      ('TDS',         7, 0),
      ('PF / ESI',   15, 0),
      ('Salary',      7, 0);

    -- Labour Payment Indents — mam (2026-05-30): "create a module labour
    -- indent-Payment under Projects".  Site Engineer raises a payment
    -- request for sub-contractor labour, manager approves (with optional
    -- amount adjustment), accounts releases payment.
    --   pending  → approved → paid
    --   pending  → rejected (terminal)
    CREATE TABLE IF NOT EXISTS labour_payment_indents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      indent_no TEXT UNIQUE,                        -- LPI-YYYY-####
      site_id INTEGER REFERENCES sites(id),
      site_name TEXT,                                -- denormalized for fast list display
      sub_contractor_id INTEGER REFERENCES sub_contractors(id),
      sub_contractor_name TEXT NOT NULL,             -- denormalized + supports off-master names
      trade TEXT,                                    -- HVAC / Electrical / … (from sub_con type)
      work_description TEXT,
      period_from DATE NOT NULL,
      period_to DATE NOT NULL,
      manpower_count INTEGER DEFAULT 0,
      man_days REAL DEFAULT 0,
      rate REAL DEFAULT 0,                           -- ₹ per man-day or lumpsum unit
      amount REAL NOT NULL,                          -- requested
      approved_amount REAL,                          -- approver may adjust
      attachment_url TEXT,                           -- measurement sheet / photo proof
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','approved','rejected','paid')),
      approved_by INTEGER REFERENCES users(id),
      approved_at DATETIME,
      approval_remarks TEXT,
      paid_by INTEGER REFERENCES users(id),
      paid_at DATETIME,
      payment_ref TEXT,                              -- UTR / cheque number
      rejected_reason TEXT,
      raised_by INTEGER REFERENCES users(id),
      raised_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_lpi_status ON labour_payment_indents(status);
    CREATE INDEX IF NOT EXISTS idx_lpi_site   ON labour_payment_indents(site_id);
    CREATE INDEX IF NOT EXISTS idx_lpi_subcon ON labour_payment_indents(sub_contractor_id);
    CREATE INDEX IF NOT EXISTS idx_lpi_raised ON labour_payment_indents(raised_by);
    CREATE INDEX IF NOT EXISTS idx_lpi_created ON labour_payment_indents(created_at DESC);

    -- Hot-path FK indexes (mam 2026-06-25 perf audit: "nothing should hang").
    -- These cover the per-row subqueries / joins that ran full table scans on
    -- list loads (vendor-PO list total, sales-bill + DPR lookups, indent items,
    -- payments by reference). Pure speed, no behaviour change.
    CREATE INDEX IF NOT EXISTS idx_vpitems_vpo      ON vendor_po_items(vendor_po_id);
    CREATE INDEX IF NOT EXISTS idx_sbills_po        ON sales_bills(po_id);
    CREATE INDEX IF NOT EXISTS idx_sbills_bb        ON sales_bills(business_book_id);
    CREATE INDEX IF NOT EXISTS idx_sbitems_bill     ON sales_bill_items(sales_bill_id);
    CREATE INDEX IF NOT EXISTS idx_dpr_site         ON dpr(site_id);
    CREATE INDEX IF NOT EXISTS idx_dpr_salesbill    ON dpr(sales_bill_id);
    CREATE INDEX IF NOT EXISTS idx_dprwi_dpr        ON dpr_work_items(dpr_id);
    CREATE INDEX IF NOT EXISTS idx_indents_site     ON indents(site_id);
    CREATE INDEX IF NOT EXISTS idx_indentitems_poi  ON indent_items(po_item_id);
    CREATE INDEX IF NOT EXISTS idx_payments_ref     ON payments(reference_type, reference_id);
    CREATE INDEX IF NOT EXISTS idx_pofoc_poi        ON po_foc_entries(po_item_id);

    -- ============================================================
    -- INDENT LABOUR PAYMENT (Project Execution & Billing) — mam
    -- (2026-06-01, amended 2026-06-02).  Coexists with the simpler
    -- labour_payment_indents module above (those rows stay on
    -- /labour-payment).
    --
    -- Phase-1 amend (mam: "it create wrong project … first amend
    -- it"):  Projects are MANUALLY entered (not derived from
    -- business_book).  Unique name.  No PO column.  Each project
    -- owns three labour spend streams:
    --   L1 Salary       → proj_salary_entries
    --   L2 Daily Wages  → proj_daily_wage_entries
    --   L3 Sub-contract → proj_work_orders + amount_paid running
    -- Budget = SUM of all three.

    CREATE TABLE IF NOT EXISTS proj_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      owner TEXT DEFAULT 'Aanchal',
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- L1 Salary entries.
    --   kind='legacy'  → one bulk row at project kickoff capturing
    --                    pre-ERP salary already spent.
    --   kind='monthly' → optional per-month rows captured going
    --                    forward (employee_name + period_month).
    CREATE TABLE IF NOT EXISTS proj_salary_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES proj_projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('legacy','monthly')),
      employee_name TEXT,
      period_month TEXT,                -- 'YYYY-MM' or NULL for legacy
      amount REAL NOT NULL DEFAULT 0,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_psal_project ON proj_salary_entries(project_id);

    -- L2 Daily Wage entries.
    --   kind='legacy' → one bulk row for pre-ERP daily-wage payout.
    --   kind='entry'  → ongoing payout: per_day_rate × days_required.
    CREATE TABLE IF NOT EXISTS proj_daily_wage_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES proj_projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('legacy','entry')),
      description TEXT,
      per_day_rate REAL DEFAULT 0,
      days_required REAL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,  -- = per_day_rate × days_required (or legacy bulk)
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pdw_project ON proj_daily_wage_entries(project_id);

    -- L3 Sub-contract work orders.  Phase-1 amend keeps a slim
    -- shape: WO file, value, amount paid so far.  The full RA-bill
    -- cycle lands in Phase 6.
    --
    -- Plan workflow:
    --   Project (= business_book) → Budget (3 labour types)
    --                            → Work Orders (sub-contractors)
    --                            → Muster Roll (daily-wage workers)
    --                            → DPR (with work_order link)
    --                            → MB / CDPR (aggregated, lockable)
    --                            → Contractor RA Bill (Raised → Payment → Paid)
    --                            → Client RA Bill (Raised → Payment → Paid)
    --                            → Payment Received (via collections)
    --
    -- Schema strategy: REUSE existing tables (business_book, dpr,
    -- collections, sub_contractors) wherever possible; new tables
    -- only for entities with no existing home.  Every table seeded
    -- here is idempotent (CREATE IF NOT EXISTS / try-catch ALTER).
    -- ============================================================

    CREATE TABLE IF NOT EXISTS proj_budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES business_book(id),
      labour_type TEXT NOT NULL CHECK(labour_type IN ('salary','daily','contracting')),
      category TEXT,                    -- free-text head, e.g. "Site Engineer", "Mason gang", "HVAC sub-con"
      planned_amount REAL NOT NULL DEFAULT 0,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pbud_project ON proj_budgets(project_id);

    -- Work Orders — dynamic count per project (NEVER hardcode 13).
    -- Phase-1 amend (mam): project_id now FKs proj_projects, plus
    -- work_order_file_url for the uploaded WO document and
    -- amount_paid for the running paid-against-value total.
    -- Balance is derived: planned_value − amount_paid.
    CREATE TABLE IF NOT EXISTS proj_work_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES proj_projects(id) ON DELETE CASCADE,
      wo_number TEXT,                   -- e.g. WO/2026/SEPL/0023
      sub_contractor_id INTEGER REFERENCES sub_contractors(id),
      sub_contractor_name TEXT,         -- denormalised (off-master subs)
      scope TEXT,
      planned_value REAL DEFAULT 0,
      amount_paid REAL DEFAULT 0,       -- running total of payments made
      work_order_file_url TEXT,         -- /uploads/... after multer
      planned_start DATE,
      planned_end DATE,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','active','closed','cancelled')),
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pwo_project ON proj_work_orders(project_id);
    CREATE INDEX IF NOT EXISTS idx_pwo_subcon  ON proj_work_orders(sub_contractor_id);

    -- Muster Roll — per-day per-labourer attendance.  Distinct from
    -- the existing dpr_manpower (trade-aggregate) and attendance
    -- (per-employee) tables; this is the on-site daily wage register.
    CREATE TABLE IF NOT EXISTS proj_muster_roll (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES business_book(id),
      work_order_id INTEGER REFERENCES proj_work_orders(id),
      labour_name TEXT NOT NULL,
      trade TEXT,                       -- mason / helper / electrician / …
      date DATE NOT NULL,
      hours_in TEXT,
      hours_out TEXT,
      days REAL NOT NULL DEFAULT 1,
      rate REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      remarks TEXT,
      recorded_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pmr_project_date ON proj_muster_roll(project_id, date);
    CREATE INDEX IF NOT EXISTS idx_pmr_wo           ON proj_muster_roll(work_order_id);

    -- Measurement Book (CDPR) — header + line snapshot so a
    -- finalised MB stays immutable even when the underlying DPR
    -- rows are later edited.  Locking is a one-way action.
    CREATE TABLE IF NOT EXISTS proj_mb_sheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES business_book(id),
      mb_no TEXT,                       -- e.g. MB/2026/SEPL/0007
      period_from DATE NOT NULL,
      period_to   DATE NOT NULL,
      total_qty REAL DEFAULT 0,
      total_amount REAL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','finalised')),
      locked_by INTEGER REFERENCES users(id),
      locked_at DATETIME,
      remarks TEXT,
      generated_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pmb_project ON proj_mb_sheets(project_id);

    CREATE TABLE IF NOT EXISTS proj_mb_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mb_id INTEGER NOT NULL REFERENCES proj_mb_sheets(id) ON DELETE CASCADE,
      work_order_id INTEGER REFERENCES proj_work_orders(id),
      description TEXT,
      unit TEXT,
      qty REAL DEFAULT 0,
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      src_dpr_ids TEXT,                 -- CSV of dpr.id rows aggregated into this line (for audit)
      remarks TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pmbl_mb ON proj_mb_lines(mb_id);

    -- Contractor RA Bill — exactly 3 states per mam's flowchart:
    -- raised → payment → paid.  Deductions are per-bill (retention,
    -- TDS, advance recovery, custom) so they live in a child table.
    CREATE TABLE IF NOT EXISTS proj_contractor_ra_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES business_book(id),
      work_order_id INTEGER REFERENCES proj_work_orders(id),
      mb_id INTEGER REFERENCES proj_mb_sheets(id),
      ra_no TEXT,                       -- e.g. CRA/2026/0001
      gross_amount REAL NOT NULL DEFAULT 0,
      net_amount REAL DEFAULT 0,        -- gross − sum(deductions)
      status TEXT NOT NULL DEFAULT 'raised'
        CHECK(status IN ('raised','payment','paid','cancelled')),
      raised_by INTEGER REFERENCES users(id),
      raised_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      paid_by INTEGER REFERENCES users(id),
      paid_at DATETIME,
      payment_ref TEXT,
      remarks TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pcra_project ON proj_contractor_ra_bills(project_id);
    CREATE INDEX IF NOT EXISTS idx_pcra_wo      ON proj_contractor_ra_bills(work_order_id);

    CREATE TABLE IF NOT EXISTS proj_contractor_ra_deductions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ra_bill_id INTEGER NOT NULL REFERENCES proj_contractor_ra_bills(id) ON DELETE CASCADE,
      label TEXT NOT NULL,              -- 'Retention' / 'TDS' / 'Advance Recovery' / custom
      pct REAL DEFAULT 0,
      amount REAL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pcra_ded_bill ON proj_contractor_ra_deductions(ra_bill_id);

    -- Client RA Bill — SEPL → client side, same 3-state cycle.
    CREATE TABLE IF NOT EXISTS proj_client_ra_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES business_book(id),
      mb_id INTEGER REFERENCES proj_mb_sheets(id),
      ra_no TEXT,                       -- e.g. RA/2026/0005
      gross_amount REAL NOT NULL DEFAULT 0,
      net_amount REAL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'raised'
        CHECK(status IN ('raised','payment','paid','cancelled')),
      raised_by INTEGER REFERENCES users(id),
      raised_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      paid_at DATETIME,
      remarks TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pcli_project ON proj_client_ra_bills(project_id);

    CREATE TABLE IF NOT EXISTS proj_client_ra_deductions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ra_bill_id INTEGER NOT NULL REFERENCES proj_client_ra_bills(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      pct REAL DEFAULT 0,
      amount REAL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pcli_ded_bill ON proj_client_ra_deductions(ra_bill_id);

    -- Announcements — admin posts, everyone reads. Pinned items rise to the top.
    -- expires_at is optional; rows without it stay visible forever until deleted.
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT,
      pinned INTEGER DEFAULT 0,
      expires_at DATETIME,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_announcements_created ON announcements(created_at DESC);

    -- Tracks each user's last visit to the announcements panel so the bell
    -- icon can show a "new" count of announcements posted since.
    CREATE TABLE IF NOT EXISTS announcement_reads (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Pipe Weight master (mam 2026-06-06): pipes are indented in METERS but
    -- enquired to vendors and PO'd in KG. This master holds the conversion:
    -- kg per meter, keyed by pipe Class (B / C / ...) + Size. weight_per_pipe
    -- and pipe_length_m are optional reference fields (kg_per_meter is what
    -- the conversion uses; if length given, kg_per_meter = weight_per_pipe /
    -- length). An item links to a row by storing its kg/m (weight_per_meter).
    CREATE TABLE IF NOT EXISTS pipe_weights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pipe_class TEXT NOT NULL,
      size TEXT NOT NULL,
      kg_per_meter REAL NOT NULL,
      weight_per_pipe REAL,
      pipe_length_m REAL DEFAULT 6,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_pipe_weights_class_size ON pipe_weights(pipe_class, size);

    -- Price Required — site engineer raises a "we need price for this item"
    -- request when an item isn't yet in the catalog. Purchase team gathers 3
    -- vendor quotes, picks a final rate, and the system auto-promotes the
    -- finalized item into item_master so it can be used in future indents.
    --
    -- Identical requests from multiple sites (same name+size+spec+make+uom+type)
    -- merge in the UI so the purchase team only fills rates once.
    CREATE TABLE IF NOT EXISTS price_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_name TEXT,
      item_name TEXT NOT NULL,
      size TEXT,
      specification TEXT,
      make TEXT,
      uom TEXT DEFAULT 'PCS',
      item_type TEXT DEFAULT 'PO' CHECK(item_type IN ('PO','FOC','RGP')),
      notes TEXT,
      raised_by INTEGER REFERENCES users(id),
      status TEXT DEFAULT 'open' CHECK(status IN ('open','quoted','finalized','added')),
      -- 3 vendor quotes
      vendor1_name TEXT, vendor1_rate REAL, vendor1_terms TEXT,
      vendor2_name TEXT, vendor2_rate REAL, vendor2_terms TEXT,
      vendor3_name TEXT, vendor3_rate REAL, vendor3_terms TEXT,
      -- Final pick
      final_vendor_name TEXT,
      final_rate REAL,
      final_terms TEXT,
      finalized_by INTEGER REFERENCES users(id),
      finalized_at DATETIME,
      -- Set after the system promotes this to the catalog
      item_master_id INTEGER REFERENCES item_master(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_price_requests_status ON price_requests(status, created_at DESC);

    -- PMS Tasks — Project Management tasks created by CRM against a specific
    -- Business Book project. Same lifecycle as delegations (pending → submitted
    -- → approved/rejected) but each task is tied to a BB project_id so the
    -- project name + auto-captured CRM name stay authoritative. project_id is
    -- a soft reference to business_book.id so we can show project details even
    -- if the BB row is later edited.
    CREATE TABLE IF NOT EXISTS pms_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      project_id INTEGER REFERENCES business_book(id),
      project_name_snapshot TEXT,   -- captured at create time for history
      crm_name TEXT,                -- captured from the latest Client PO at create time
      assigned_by INTEGER REFERENCES users(id),
      assigned_to INTEGER REFERENCES users(id),
      due_date DATE,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','submitted','approved','rejected')),
      proof_url TEXT,
      submitted_at DATETIME,
      reviewed_at DATETIME,
      reviewer_id INTEGER REFERENCES users(id),
      reject_reason TEXT,
      -- Date-extension request fields (same pattern as delegations)
      requested_due_date DATE,
      extension_reason TEXT,
      extension_status TEXT,
      extension_reviewed_at DATETIME,
      extension_reviewed_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Checklist completions — one row per (checklist, user, date). Used to
    -- show the daily checklist widget on dashboard and track whether the user
    -- uploaded proof today. Unique per-day so users can't double-complete.
    CREATE TABLE IF NOT EXISTS checklist_completions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checklist_id INTEGER REFERENCES checklists(id),
      user_id INTEGER REFERENCES users(id),
      completion_date DATE NOT NULL,
      proof_url TEXT,
      notes TEXT,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(checklist_id, user_id, completion_date)
    );
  `);

  // Safe schema migrations for columns added after initial release
  const migrations = [
    // Labour Rate sheet: specification + size, alongside item_name/uom
    // (mam 2026-06-11: "add specs, size also" to the labour item form).
    ['labour_rates', 'specification TEXT'],
    ['labour_rates', 'size TEXT'],
    // Payroll grace + per-minute late penalty (added when mam moved from a
    // simple "late mark" model to a graduated penalty: 3 free late marks per
    // month, then ₹20/min off the salary for any further late punch).
    // Fixed weekly target per KPI (mam's "this plan is fix" — Monika's
    // ROI=1, Automations=4, etc.). Used as the Planned default when no
    // weekly entry exists.
    ['score_kpis', 'default_planned REAL DEFAULT 0'],
    // Vendor rating out of 10 (mam 2026-06-03: "add for rating 10 out of
    // score" on the Add Vendor form). Optional 0–10 score the team sets
    // when onboarding / reviewing a vendor.
    ['vendors', 'rating REAL'],
    // Last-edited timestamp (mam 2026-06-19: show each vendor's last update
    // date/time in the list so master enrichment is visible at a glance).
    // Stamped on every PUT / bulk-update; the list falls back to created_at
    // for vendors never edited since this column was added.
    ['vendors', 'updated_at DATETIME'],
    // Profile photo (WhatsApp-style avatar) per user — shown in chat bubbles,
    // member lists, etc. Stores an /uploads URL (mam 2026-06-19).
    ['users', 'avatar_url TEXT'],
    // Client PO BOQ: PP = Purchase Price per item (column kept as part_price),
    // alongside the existing labour_rate column. Both manual or auto-filled
    // from the BOQ Excel (mam 2026-06-19: "Rate SITC, Amount, PP, Labour Rate").
    ['po_items', 'part_price REAL'],
    // Suggestion-only AI "marketing rate" per indent item on the Vendor Rates
    // table (mam 2026-06-19) — does NOT affect the 3 vendor rates.
    ['indent_item_rates', 'marketing_rate REAL'],
    // Vendor PO 2-level approval (mam 2026-06-19: "after PO make 2 approval
    // need L1 Nitin Jain, L2 Ankur Kaplesh"). New POs start 'pending_l1';
    // existing POs default to 'approved' so they're grandfathered, not parked.
    ['vendor_pos', "po_approval TEXT DEFAULT 'approved'"],
    ['vendor_pos', 'po_l1_by INTEGER'],
    ['vendor_pos', 'po_l1_at DATETIME'],
    ['vendor_pos', 'po_l2_by INTEGER'],
    ['vendor_pos', 'po_l2_at DATETIME'],
    ['vendor_pos', 'po_reject_by INTEGER'],
    ['vendor_pos', 'po_reject_at DATETIME'],
    ['vendor_pos', 'po_reject_reason TEXT'],
    // Per-rule dynamic From address for email triggers (mam 2026-06-03:
    // "from mail which id also dynamic"). Optional; supports {{vars}}.
    ['email_rules', 'from_addr TEXT'],
    // Supervisor → site linkage so Supervisor template KPIs (DPR Daily
    // Actual, Stock report, Tools List, Material Receiving) can scope
    // by site. The TEXT 'supervisor' column was insufficient for joins.
    ['sites', 'supervisor_id INTEGER REFERENCES users(id)'],
    // Rent request: due-by day of month (mam: 'date also mention like
    // 10 date of month need to submit'). Defaults to 10. Once past
    // (rent_month-01 + pay_by_day) and still pending/approved, the row
    // shows an Overdue badge. 'inactive' marks the rental as vacated
    // so it stops appearing in payment expectations.
    ['rent_requests', 'pay_by_day INTEGER DEFAULT 10'],
    ['rent_requests', 'inactive INTEGER DEFAULT 0'],
    ['rent_requests', 'inactive_at DATETIME'],
    ['rent_requests', 'inactive_reason TEXT'],
    // Payment-mode selector — Bank / UPI / Scanner. Form shows only
    // the matching fields (mam: 'if scanner upload scanner, if bank
    // then bank details, if upi fill upi').
    ['rent_requests', `payment_mode TEXT DEFAULT 'Bank'`],
    ['rent_requests', 'upi_id TEXT'],
    // Employee the rent is being arranged for (room occupant). Snapshot
    // the name so it survives if the user is later deactivated/renamed.
    ['rent_requests', 'employee_user_id INTEGER REFERENCES users(id)'],
    ['rent_requests', 'employee_name TEXT'],
    ['payroll_settings', 'late_grace_count INTEGER DEFAULT 3'],
    ['payroll_settings', 'late_per_minute_rate REAL DEFAULT 20'],
    // Salary breakdown percentages — match SEPL Tally slip format
    ['payroll_settings', 'basic_pct REAL DEFAULT 56.5'],
    ['payroll_settings', 'conveyance_pct REAL DEFAULT 22.6'],
    ['payroll_settings', 'hra_pct REAL DEFAULT 5.9'],
    ['payroll_settings', 'adhoc_pct REAL DEFAULT 15.0'],
    ['payroll_settings', 'misc_pct REAL DEFAULT 0'],
    // Snapshot fields for finalised runs so historical slips don't drift
    ['payroll_runs', 'late_penalty REAL DEFAULT 0'],
    ['payroll_runs', 'basic_pay REAL DEFAULT 0'],
    ['payroll_runs', 'conveyance REAL DEFAULT 0'],
    ['payroll_runs', 'hra REAL DEFAULT 0'],
    ['payroll_runs', 'adhoc REAL DEFAULT 0'],
    ['payroll_runs', 'misc REAL DEFAULT 0'],
    ['payroll_runs', 'advance REAL DEFAULT 0'],
    ['po_foc_entries', 'labour_item_id INTEGER'],
    ['po_foc_entries', 'labour_name TEXT'],
    ['po_foc_entries', 'labour_margin REAL DEFAULT 50'],
    // CRM client-quotation margin on Extra indents — the code reads/writes
    // this but the column was never created → "no such column" on CRM
    // approval. Add it (mam 2026-06-10).
    ['indents', 'crm_margin_pct REAL'],
    ['purchase_orders', 'site_engineer_id INTEGER REFERENCES users(id)'],
    ['purchase_orders', 'site_engineer_ids TEXT'],
    // Extra project roles who sometimes fill site data (mam 2026-06-17) —
    // each a CSV of user ids, same shape as site_engineer_ids.
    ['purchase_orders', 'jr_site_engineer_ids TEXT'],
    ['purchase_orders', 'supervisor_ids TEXT'],
    ['purchase_orders', 'welder_ids TEXT'],
    ['purchase_orders', 'helper_ids TEXT'],
    ['purchase_orders', 'crm_name TEXT'],
    // EA's manual followup note for the MD on a delegation (mam 2026-06-17) —
    // informational only, does not affect task status.
    ['delegations', 'followup_remarks TEXT'],
    ['purchase_orders', 'boq_file_link TEXT'],
    ['attendance', 'auto_punched_in INTEGER DEFAULT 0'],
    ['attendance', 'auto_punched_out INTEGER DEFAULT 0'],
    // Admin override: mam can mark a user present even if they didn't
    // punch (typically for site engineers whose phone died or had no
    // network). The flag hides the row from the user's own My Today /
    // My Month views so they don't see they were marked — only payroll
    // / admin / HR reports include it. marked_by stores who did it for
    // audit; remarks stores the reason mam typed.
    ['attendance', 'admin_marked INTEGER DEFAULT 0'],
    ['attendance', 'marked_by INTEGER REFERENCES users(id)'],
    // Auto-mark-present allow-list. Users with this flag set get an
    // admin_marked='present' row created automatically every day so
    // they don't show up in the 'Not Punched In Today' panel. Mam's
    // initial seed: management / admin accounts that don't punch.
    ['users', 'auto_mark_present INTEGER DEFAULT 0'],
    ['users', 'username TEXT'],
    // Inventory link on GRN — when goods are received we now auto-IN
    // them into a chosen warehouse. Both columns are nullable so old
    // GRNs without the link still work; only filled-in ones trigger
    // the stock movement.
    ['grn', 'warehouse_id INTEGER REFERENCES warehouses(id)'],
    ['grn_items', 'item_master_id INTEGER REFERENCES item_master(id)'],
    // Same auto-IN hook on the modern Procurement → Dispatch & Receiving
    // flow: when mam marks a delivery_note as Received, items from the
    // linked vendor_po_items auto-land in this warehouse. nullable —
    // existing receives without a warehouse just behave like before.
    ['delivery_notes', 'warehouse_id INTEGER REFERENCES warehouses(id)'],
    // Optional photo per stock movement — useful for opening-balance
    // entries at site stores so mam has visual proof of what's actually
    // there. Photo is never required; rendered as a thumbnail in the
    // movements list when set.
    ['stock_movements', 'photo_url TEXT'],
    // Item condition at the time of this movement — captured for
    // opening-balance entries so mam can tell brand-new stock apart from
    // already-used / scrap material on the same item line. NULL for older
    // rows + non-OPENING movements; UI dropdown is Used / Unused / Scrap.
    ['stock_movements', 'item_condition TEXT'],
    // Per-user opt-out from live location tracking. Admin / office-only
    // staff get track_location=0 so they don't show in Admin → Location
    // Tracking. Default 1 so existing field staff keep being tracked.
    ['users', 'track_location INTEGER DEFAULT 1'],
    // Archive (mam 2026-07-02): hide a left/ex user from every list WITHOUT
    // deleting them — attendance, salary and all history stay linked. Archived
    // users are also inactive (can't log in) and are filtered out of the main
    // User Management list + assignment pickers; they live in an "Archived" tab.
    ['users', 'archived INTEGER DEFAULT 0'],
    // Geofence accuracy audit (mam: "some in office but say out of area").
    // Store the GPS accuracy reported at each punch + whether the location
    // could be trusted, so the geofence audit can tell a genuinely far-away
    // punch from a weak indoor-GPS one. location_verified defaults to 1 so
    // every historical row reads as verified; only new weak-GPS punches get 0.
    // See server/lib/geofence.js for the rule.
    ['attendance', 'punch_in_accuracy REAL'],
    ['attendance', 'punch_out_accuracy REAL'],
    ['attendance', 'location_verified INTEGER DEFAULT 1'],
    // Tunable geofence GPS tolerance (metres) — lets mam adjust strictness
    // without a code deploy. floor = min slack every fix gets; ceiling = max
    // benefit of the doubt; trust = accuracy at/under which a fix is precise
    // enough to BLOCK an off-site punch on.
    ['payroll_settings', 'geo_accuracy_floor_m INTEGER DEFAULT 50'],
    ['payroll_settings', 'geo_accuracy_ceiling_m INTEGER DEFAULT 3000'],
    ['payroll_settings', 'geo_trust_accuracy_m INTEGER DEFAULT 200'],
    // Collection Engine v2 — receivable now keyed by SITE (not free-text
    // client+project), CRM auto-fills from the latest PO of that site,
    // and Aanchal logs next-planned-date + last-discussion alongside.
    ['receivables', 'site_id INTEGER REFERENCES sites(id)'],
    ['receivables', 'site_name TEXT'],
    ['receivables', 'crm_name TEXT'],
    // Hiring Pipeline — extends candidates with interview / MD / offer tracking.
    // Status field on candidates already supports the high-level stages
    // (lead → interview_scheduled → interview_done → qualified → offer_sent →
    // accepted → onboarded → rejected). These additive columns capture the
    // detail at each stage so HR can see who's interviewing, when, and what
    // each interviewer's decision was. All nullable — old candidates stay
    // untouched.
    ['candidates', 'interviewer_id INTEGER REFERENCES employees(id)'],
    ['candidates', 'interview_date DATETIME'],
    ['candidates', 'interview_notes TEXT'],
    ['candidates', 'interview_decision TEXT'],     // 'shortlisted' | 'rejected' | 'on_hold'
    ['candidates', 'md_interview_date DATETIME'],
    ['candidates', 'md_interview_notes TEXT'],
    ['candidates', 'md_decision TEXT'],            // 'shortlisted' | 'rejected'
    ['candidates', 'offer_letter_file TEXT'],
    ['candidates', 'offer_sent_at DATETIME'],
    // Mam (2026-05-22): "when here shortlisted & offer send create
    // offer letter and show pdf" — populate auto-generated offer
    // letter at /hr/candidates/:id/offer-letter from these fields.
    ['candidates', 'offered_position TEXT'],
    ['candidates', 'offered_salary REAL'],
    ['candidates', 'joining_date DATE'],
    ['candidates', 'reporting_to TEXT'],
    // Org hierarchy: who each user reports to (self-ref on users). Built from the
    // War Room "Hierarchy" tab (mam 2026-06-27).
    ['users', 'manager_id INTEGER'],
    // Mam (2026-05-22): auto-parsed from the uploaded resume (PDF /
    // DOCX) so the offer letter has full contact details.
    ['candidates', 'address TEXT'],
    ['candidates', 'linkedin_url TEXT'],
    // ── HR Phase 1 (mam 2026-05-22 ATS spec) ────────────────────────
    // tags: free-form CSV chips on each candidate ("urgent", "ex-L&T",
    //        "diversity", etc.).  Search / filter uses LIKE for now.
    // is_on_hold: overlay flag — a candidate at ANY pipeline stage can
    //             be put on hold; UI surfaces "On Hold" as its own
    //             funnel pill without losing the underlying status.
    // hiring_request_id: optional FK back to hiring_requests so a
    //             hiring manager can see all candidates applying for
    //             their open requisition in one click.
    ['candidates', 'tags TEXT'],
    ['candidates', 'is_on_hold INTEGER DEFAULT 0'],
    ['candidates', 'hold_reason TEXT'],
    ['candidates', 'hiring_request_id INTEGER REFERENCES hiring_requests(id)'],
    // HR Phase 1 Batch C (mam 2026-05-22): eligibility engine.
    // Stamped by /candidates/:id/screening-answers after rules run.
    //   'eligible'  — all mandatory questions answered, no rule fired
    //   'partial'   — mandatory question(s) unanswered
    //   'rejected'  — at least one auto-reject rule fired
    //   NULL         — screening hasn't been run yet
    ['candidates', 'eligibility_status TEXT'],
    ['candidates', 'eligibility_reason TEXT'],   // which rule fired (for "rejected") OR which q missed (for "partial")
    ['candidates', 'screened_at DATETIME'],
    // HR Phase 1 Batch D (mam 2026-05-22):
    //  salary_breakup — JSON blob letting admin override the default
    //   CTC line items on the offer letter ({basic, conveyance, hra,
    //   adhoc, misc, total_monthly, total_annual}). NULL = use default.
    //  offer_token    — random 32-char URL-safe string generated when
    //   MD shortlists; candidate uses it to accept/decline the offer
    //   via the unauthenticated /offer/:token page (no login needed).
    //  offer_accepted_at / offer_declined_at — set when candidate
    //   responds via the public link.  Status moves to 'accepted' or
    //   'rejected' accordingly.
    //  offer_response_note — optional message from the candidate.
    // Mam (2026-05-22): "upload photo option so that can check photo"
    // on Announcements — admin posts a holiday / event / circular and
    // can attach a banner image alongside the title/body.
    ['announcements', 'attachment_url TEXT'],
    ['candidates', 'salary_breakup TEXT'],
    ['candidates', 'offer_token TEXT'],
    ['candidates', 'offer_accepted_at DATETIME'],
    ['candidates', 'offer_declined_at DATETIME'],
    ['candidates', 'offer_response_note TEXT'],
    // price_requests carries the item's department (CIVIL / ELE / FF / etc.)
    // so the auto-promoted item_master row lands in the right department too.
    ['price_requests', 'department TEXT'],
    // leave_requests gained these columns over time but the migrations were
    // never registered — older production DBs (created when leave_requests
    // had only the basic from/to/reason set) were missing them, blocking
    // submission with "table leave_requests has no column named hours".
    ['leave_requests', 'hours REAL DEFAULT 0'],
    ['leave_requests', 'days INTEGER DEFAULT 1'],
    ['leave_requests', 'from_time TEXT'],
    ['leave_requests', 'to_time TEXT'],
    ['leave_requests', 'remarks TEXT'],
    // Soft-cancel for Vendor POs — hard delete is blocked by FK constraints
    // (purchase_bills + delivery_notes reference vendor_pos). Cancelling
    // hides the PO from active follow-up lists while preserving the audit
    // trail and any linked financial records.
    ['vendor_pos', 'cancelled INTEGER DEFAULT 0'],
    ['vendor_pos', 'cancelled_at DATETIME'],
    ['vendor_pos', 'cancelled_by INTEGER REFERENCES users(id)'],
    ['vendor_pos', 'cancel_reason TEXT'],
    // Mandatory employee documents — Aadhar / PAN / highest qualification
    // certificate. URLs (pointing at /uploads/<file>) so we can render them
    // as links and download / view directly. NOT NULL is intentionally
    // omitted at the DB level so legacy rows don't break — frontend
    // enforces required-on-create for new records.
    ['employees', 'aadhar_file TEXT'],
    ['employees', 'pan_file TEXT'],
    ['employees', 'qualification_file TEXT'],
    // Mam (2026-06-01 payroll rules): per-employee flags that the
    // payroll engine respects when computing the monthly net pay.
    //   salary_exempt=1     → always full salary regardless of
    //                          attendance / late / absent / leave.
    //                          (Parul Goyal, Rajat Sir, Nitin Jain,
    //                          Ankur Kaplesh, Pooja Kaplesh, D.S.
    //                          Kaplesh, Soma Kaplesh start ON.)
    //   cl_eligible=1       → entitled to monthly CL accrual + carry
    //                          forward.  Default ON.
    //   ot_eligible=0       → only employees with this flag get OT
    //                          pay added to their net.  Default OFF
    //                          per mam (2026-06-01: "over time also
    //                          we give some person") — admin opts
    //                          each person in.
    //   cl_opening_balance  → carry-forward CL count from previous
    //                          period.  Admin imports per mam's
    //                          file (coming separately).
    ['employees', 'salary_exempt INTEGER DEFAULT 0'],
    ['employees', 'cl_eligible INTEGER DEFAULT 1'],
    ['employees', 'ot_eligible INTEGER DEFAULT 0'],
    ['employees', 'cl_opening_balance REAL DEFAULT 0'],
    // can_see_all on role_permissions: explicit per-role-per-module toggle
    // for "scope = ALL records" vs "scope = OWN only". Decoupled from
    // can_approve so admin can grant a role full visibility without giving
    // them approval power (e.g. an auditor role). When can_see_all = 1 OR
    // can_approve = 1, the user sees every record in that module.
    ['role_permissions', 'can_see_all INTEGER DEFAULT 0'],
    // Announcements module — admin posts; everyone reads. Each user's
    // last-seen timestamp is tracked separately so the bell-icon counter
    // can show a "new" badge until they open the panel. Two tables created
    // unconditionally below via CREATE TABLE IF NOT EXISTS — no migration
    // entries needed for those.
    ['receivables', 'next_planned_date DATE'],
    ['receivables', 'last_discussion TEXT'],
    ['receivables', 'business_book_id INTEGER REFERENCES business_book(id)'],
    // DPR consumption now optionally links to the item_master so the
    // auto-OUT to inventory can decrement the right SKU's stock.
    ['dpr_material', 'item_master_id INTEGER REFERENCES item_master(id)'],
    // Self-service password recovery — user sets a personal recovery code
    // (stored as bcrypt hash) which they can later use along with their
    // username to reset their password from the login page. No SMTP needed.
    ['users', 'recovery_code_hash TEXT'],
    // Delegations — due-date extension request (assignee asks admin for more time)
    ['delegations', 'requested_due_date DATE'],
    ['delegations', 'extension_reason TEXT'],
    ['delegations', "extension_status TEXT"],
    ['delegations', 'extension_reviewed_at DATETIME'],
    ['delegations', 'extension_reviewed_by INTEGER REFERENCES users(id)'],
    // How many times the due date has been pushed (0 = still on the original
    // date). Drives the Delegation health light: 0 green, 1 yellow, 2+ red.
    ['delegations', 'extension_count INTEGER DEFAULT 0'],
    // Time-of-day for recurring checklists (daily/weekly/…). Stored as 'HH:MM'.
    ['checklists', 'due_time TEXT'],
    // scoring.js / checklists routes query `WHERE ... COALESCE(active, 1) = 1`.
    // SQLite needs the column to physically exist or the query fails before
    // COALESCE runs — surfaces as 'no such column: active' on weekly score.
    ['checklists', 'active INTEGER DEFAULT 1'],
    // Category-specific asset identifiers — IP for laptops/routers/etc.,
    // IMEI for mobile/tablet (separate from generic serial_no).
    ['company_assets', 'ip_address TEXT'],
    ['company_assets', 'imei TEXT'],

    // ─── Sales Funnel — Stage 1: Lead / Tender Capture (mam's spec) ──
    // Distinguish Private quotes from Government tenders so the form
    // shows the correct fields and the audit / SLA rules differ.
    ['sales_funnel', "lead_kind TEXT DEFAULT 'private'"], // 'private' | 'government'
    // Customer GST / PAN — may be auto-fetched from MCA later.
    ['sales_funnel', 'gst_number TEXT'],
    ['sales_funnel', 'pan_number TEXT'],
    // Project header (separate from address — project_name is what mam
    // displays on the BOQ / quote / contract).
    ['sales_funnel', 'project_name TEXT'],
    ['sales_funnel', 'project_location TEXT'],
    ['sales_funnel', 'pin_code TEXT'],
    // Commercial header
    ['sales_funnel', 'estimated_value REAL DEFAULT 0'],
    ['sales_funnel', 'tentative_timeline TEXT'],
    // Mam (2026-06-01): "PIC 2 BUILDING CATEGORY ALSO ADD AND GIVE
    // PIC DROP DOWN" — new field on Stage 1 lead capture, picked
    // from a 15-option list (Residential / Commercial / Educational
    // / Healthcare / Industrial / Government / Religious /
    // Transportation / Recreational / Financial / Hospitality /
    // Cultural / Agricultural / Utility / Emergency Services).
    ['sales_funnel', 'building_category TEXT'],
    // Influencer reference — when source='Influencer' the user picks
    // a partner from the influencers table; we denormalize both id +
    // name so historical leads keep displaying the partner even if
    // the master row is renamed later.
    ['sales_funnel', 'influencer_id INTEGER REFERENCES influencers(id)'],
    ['sales_funnel', 'influencer_name TEXT'],
    // Sub-trades scope as CSV: M,E,P,F,BMS,ELV,Solar
    ['sales_funnel', 'sub_trades_scope TEXT'],
    // Government-only fields
    ['sales_funnel', 'tender_id TEXT'],
    ['sales_funnel', 'bid_deadline DATE'],
    ['sales_funnel', 'emd_amount REAL DEFAULT 0'],
    ['sales_funnel', 'pbg_required INTEGER DEFAULT 0'],
    // Drop tracking — mam's universal principle: 'Drop with reason'
    ['sales_funnel', 'dropped INTEGER DEFAULT 0'],
    ['sales_funnel', 'drop_reason TEXT'],
    ['sales_funnel', 'dropped_at DATETIME'],
    ['sales_funnel', 'dropped_by INTEGER REFERENCES users(id)'],
    // When a DPR shows a LOSS (Total B > Total A), mam wants the
    // hindrance category captured so we can analyse root causes
    // across sites. Required field at submit-time only when there's
    // a loss; optional otherwise.
    // Categories: Money / Machine / Material / Manpower / Site Clearance.
    ['dpr', 'hindrance_category TEXT'],
    // Per-entry working sheet upload on Business Book — mam: 'upload here
    // file option call working sheet'. Stores the URL of the uploaded
    // file (Excel / PDF / etc) so admin can attach the costing /
    // calculation sheet to each booked order.
    ['business_book', 'working_sheet_link TEXT'],
    // Client GSTIN + state code — needed for the auto-generated Sales
    // Bill / Tax Invoice (templates require these in the Bill To block).
    ['business_book', 'gstin TEXT'],
    ['business_book', 'state_code TEXT'],
    // Management discount (mam 2026-06-16): a discount given on the Sale
    // Amount.  Stored as both a % and the resolved Rs amount (kept in
    // sync by the UI / server).  Net Sale = Sale − discount, and the
    // PO Amount (with GST) recomputes off the NET, not the gross sale.
    ['business_book', 'management_discount_pct REAL DEFAULT 0'],
    ['business_book', 'management_discount_amount REAL DEFAULT 0'],
    ['business_book', 'net_sale_amount REAL DEFAULT 0'],
    // Item Master pricing audit — MD's Phase 1: "Right now Price is
    // just a number — no date, no vendor, no bill. We can't trust it
    // for tenders." Adds vendor link, source provenance (PO / Quote /
    // Manual / Online), bill / PO number + date, captured-at and
    // captured-by so every price has full traceability and an age
    // (green ≤30d, yellow 31-60d, red 60+d).
    ['item_master', 'vendor_id INTEGER REFERENCES vendors(id)'],
    ['item_master', 'source_type TEXT'],                       // PO / Quote / Manual / Online
    ['item_master', 'bill_po_number TEXT'],
    ['item_master', 'bill_po_date DATE'],
    ['item_master', 'priced_at DATETIME'],                     // when current price was captured
    ['item_master', 'priced_by INTEGER REFERENCES users(id)'],
    // Item approval (mam 2026-06-16): a new item entered from anywhere
    // must be approved by an Admin (e.g. Ankur Kaplesh) before it counts
    // as "correct".  DEFAULT 'approved' grandfathers every existing row;
    // new manual entries are inserted as 'pending' (see routes/itemMaster).
    ['item_master', "approval_status TEXT DEFAULT 'approved'"], // approved | pending | rejected
    ['item_master', 'approved_by INTEGER REFERENCES users(id)'],
    ['item_master', 'approved_at DATETIME'],
    // item_price_history exists for BOQ-row rates already; extend so a
    // full Master-page edit also lands here with the same provenance
    // fields the master row carries. Older rows keep null in these.
    ['item_price_history', 'vendor_id INTEGER REFERENCES vendors(id)'],
    ['item_price_history', 'source_type TEXT'],
    ['item_price_history', 'bill_po_number TEXT'],
    ['item_price_history', 'bill_po_date DATE'],

    // Labour rate per BOQ line — mam: "upload labour rate sheet and
    // when upload below match BOQ item labour rate come next column of
    // rate(SITC)". Populated either manually inline or via the Labour
    // Rate Sheet upload that matches by sr_no / description. Flows down
    // into dpr_work_items so DPR cost calc uses the same per-line rate.
    ['po_items', 'labour_rate REAL DEFAULT 0'],
    ['po_items', 'labour_amount REAL DEFAULT 0'],
    ['po_items', 'sr_no INTEGER'],
    // Scope po_items to a specific PO (not just BB) — mam: "i upload
    // this is order to planning infect upload 4 boq for fetch item".
    // Multiple POs share a BB → editing one PO's BOQ used to wipe
    // every other PO's items because DELETE was keyed by business_book_id.
    ['po_items', 'po_id INTEGER REFERENCES purchase_orders(id)'],
    ['business_book', 'labour_rate_file_link TEXT'],
    // Indent Labour Payment (mam 2026-06-01) — Project owner defaults
    // to 'Aanchal' on legacy rows (admin can change per-project later).
    // project_kickoff_legacy_cost = single frozen number captured at
    // project kickoff for older projects that already had cost spent
    // before the ERP came online; surfaced in the dashboard's running
    // tally.
    ['business_book', "owner TEXT DEFAULT 'Aanchal'"],
    ['business_book', 'project_kickoff_legacy_cost REAL DEFAULT 0'],
    // DPR ↔ Work-Order linkage (Phase 4 of Indent Labour Payment).
    // Nullable so every existing DPR row stays valid.
    ['dpr_work_items', 'work_order_id INTEGER REFERENCES proj_work_orders(id)'],
    // Collections (Payment Received) → Client RA Bill linkage
    // (Phase 6 of Indent Labour Payment).  Nullable; legacy
    // collections rows continue to read fine.
    ['collections', 'proj_client_ra_bill_id INTEGER REFERENCES proj_client_ra_bills(id)'],
    // Phase-1 amend (mam 2026-06-02): work_order_file_url + amount_paid
    // for proj_work_orders.  Idempotent so a yesterday-shipped empty
    // table picks them up on next boot.
    ['proj_work_orders', 'work_order_file_url TEXT'],
    ['proj_work_orders', 'amount_paid REAL DEFAULT 0'],
    ['dpr_work_items', 'labour_rate REAL DEFAULT 0'],
    ['dpr_work_items', 'labour_amount REAL DEFAULT 0'],
    // Marks a DPR whose Table A rate already represents the labour portion
    // (11% of SITC) rather than the full SITC. New DPRs are saved with this
    // = 1; the one-time labour-pct backfill (below) converts pre-existing
    // DPRs (where it's 0) exactly once, so it never double-scales on restart.
    ['dpr', 'labour_pct_applied INTEGER DEFAULT 0'],
    // Indent items now pick from item_master; keeps backward-compat description too
    ['indent_items', 'item_master_id INTEGER REFERENCES item_master(id)'],
    ['indent_items', 'make TEXT'],                 // e.g. "Schneider", "L&T"
    ['indent_items', 'is_foc INTEGER DEFAULT 0'],  // free-of-cost flag
    ['indent_items', 'is_tool INTEGER DEFAULT 0'], // tools vs materials flag
    // Indent-level fields shown on the physical indent form
    ['indents', 'client_name TEXT'],   // kept for backward compat (superseded by site_name)
    ['indents', 'location TEXT'],      // kept for backward compat (now derived from site)
    ['indents', 'lead_no TEXT'],       // kept for backward compat (removed from UI)
    ['indents', 'site_name TEXT'],     // unique site name from Business Book
    ['indents', 'raised_by_name TEXT'],// employee who raised the indent
    // Approval / rejection audit trail — mam (2026-05-25): "show how
    // approved and ... if reject then reason mandatory". Approver name
    // already derivable from approved_by; these add WHEN approved and
    // WHY rejected (mandatory non-empty reason).
    ['indents', 'approved_at DATETIME'],
    ['indents', 'rejected_by INTEGER REFERENCES users(id)'],
    ['indents', 'rejected_at DATETIME'],
    ['indents', 'rejection_reason TEXT'],
    // ─── 2-Level Indent Approval (mam's spec 2026-05-26) ───
    // From 2026-05-25 onwards every new indent needs both an L1 sign-off
    // (Nitin Jain ji, Sr. Manager — technical / budget check) AND an L2
    // sign-off (Nitin Sir, Director — final). Older indents stay on the
    // legacy single-approval flow via approval_policy='single' so a flood
    // of pre-existing pending rows doesn't get retroactively re-queued.
    // Existing approved_by / approved_at / rejected_by / rejection_reason
    // continue to capture the FINAL state — L1/L2 fields capture per-level
    // detail. Audit + Approval column stay backward-compatible.
    ['indents', "approval_policy TEXT DEFAULT 'single'"],   // 'single' | 'two_level' | 'crm_two_level'
    ['indents', 'l1_status TEXT'],                           // 'pending' | 'approved' | 'rejected'
    ['indents', 'l1_by INTEGER REFERENCES users(id)'],
    ['indents', 'l1_at DATETIME'],
    ['indents', 'l2_status TEXT'],
    ['indents', 'l2_by INTEGER REFERENCES users(id)'],
    ['indents', 'l2_at DATETIME'],
    // Mam (2026-06-02): "in extra item crm will approv first indent
    // after then l1, l2 and data automatically go to crm funnel".
    // Extra-Schedule / Extra-Non-Schedule indents are CLIENT-BILLABLE,
    // not company expense, so CRM has to sign off FIRST (revenue
    // gatekeeper) before L1/L2 approve the spend.  When CRM approves,
    // a new BoQ line is auto-added to the project's Client PO so it
    // bills automatically.  Flow:
    //   submitted → crm_approved → l1_approved → approved
    // Non-extra indents keep their existing single / two_level paths
    // — crm_status stays 'n/a' there.
    ['indents', "crm_status TEXT DEFAULT 'n/a'"],            // 'n/a' | 'pending' | 'approved' | 'rejected'
    ['indents', 'crm_by INTEGER REFERENCES users(id)'],
    ['indents', 'crm_at DATETIME'],
    ['indents', 'crm_reason TEXT'],
    // When CRM approves, we INSERT a po_items row tagged with this id
    // so the billable line can be tracked back to the originating indent
    // (and reversed if the indent later goes wrong).
    ['indents', 'crm_billable_po_item_id INTEGER REFERENCES po_items(id)'],
    // Tags the two Nitins (seeded below) as the designated approvers so
    // the UI / API can gate Approve L1 / L2 to them. NULL = ordinary user.
    ['users', 'approval_role TEXT'],
    // ─── Indent Category (mam's spec 2026-05-26) ───
    // Old indents had a single flow (all "material"). Mam wants explicit
    // categories so the BOQ picker filters correctly and over-budget items
    // (extras / rentals) carry their own audit trail. Default 'material'
    // keeps every pre-existing indent on the legacy flow without a touch.
    //   material           — BOQ PO + FOC items only (RGP hidden)
    //   rgp                — BOQ RGP items only
    //   extra_schedule     — BOQ row exists, qty cap removed (over-BOQ)
    //   extra_non_schedule — No BOQ link, picked free from Item Master
    //   rental             — Rented tools, validated against buy-outright cost
    ['indents', "indent_category TEXT DEFAULT 'material'"],
    // Per-line flags so listing + downstream reports can tell extra rows
    // apart from regular ones without re-deriving from indents.indent_category.
    ['indent_items', 'is_extra_schedule INTEGER DEFAULT 0'],
    ['indent_items', 'is_extra_non_schedule INTEGER DEFAULT 0'],
    // Rental-only fields. Non-null only when indent.indent_category='rental'.
    // total_rental = quantity * rental_days * rental_rate_per_day. Server
    // blocks the indent if total_rental >= quantity * item_master.current_price
    // (renting can't cost as much or more than buying outright).
    ['indent_items', 'rental_days INTEGER'],
    ['indent_items', 'rental_rate_per_day REAL'],
    // Item classification mirrored from item_master.type (PO / FOC / RGP)
    ['indent_items', 'item_type TEXT'],
    // Links this indent line back to the site BOQ row it was picked from
    ['indent_items', 'po_item_id INTEGER REFERENCES po_items(id)'],
    // Per-item delivery / required-by date.  Mam (2026-05-21): the
    // Vendor PO print's "DUE ON" column should show one date per line
    // (from the indent), not one PO-level date stamped on every row.
    ['indent_items', 'required_date DATE'],
    // Vendor POs are now uploaded from Tally rather than built inside the ERP.
    // po_date  — from the Tally PO (not the ERP creation timestamp)
    // file_path — relative URL under /uploads to the uploaded PO file (PDF/image/xlsx)
    // remarks   — free-text note from the uploader
    // expected_receipt_date — date by which goods are expected from the vendor;
    //   used by mam to chase follow-ups and trigger the purchase-bill upload.
    ['vendor_pos', 'po_date DATE'],
    ['vendor_pos', 'file_path TEXT'],
    ['vendor_pos', 'remarks TEXT'],
    ['vendor_pos', 'expected_receipt_date DATE'],
    // ─── Payment-before-material tracker (mam 2026-05-27) ───
    // Between PO sent → vendor ships → bill uploaded, there's a gap where
    // payment terms control whether the vendor will release material.
    // 3 real-world cases:
    //   advance           → vendor wants ₹X advance before shipping
    //   old_payment_clear → vendor blocks new shipment until old dues clear
    //   no_advance        → standard credit, vendor ships on goodwill
    // NULL = legacy PO (created before this field existed) — keeps the
    // chip off the listing so we can tell legacy from explicit "no_advance".
    // INTERNAL ONLY: PO print page never renders these (vendor already knows
    // what they're owed; this is purely for the purchase team's tracker).
    ['vendor_pos', 'payment_block_type TEXT'],            // 'advance' | 'old_payment_clear' | 'no_advance' | NULL
    ['vendor_pos', 'payment_block_amount REAL'],          // ₹ owed (advance amt OR old dues)
    ['vendor_pos', 'payment_block_notes TEXT'],           // internal context, never printed
    ['vendor_pos', "payment_block_status TEXT DEFAULT 'na'"],  // 'pending' | 'cleared' | 'na'
    ['vendor_pos', 'payment_cleared_at DATETIME'],        // when "Mark Cleared" clicked
    ['vendor_pos', 'payment_cleared_by INTEGER REFERENCES users(id)'],
    // Vendor-facing Payment Terms entered when the PO is created (mam
    // 2026-06-04: "payment terms here when we make po their enter
    // payment terms").  Unlike payment_block_* (internal), THESE print on
    // the vendor PO.  Falls back to the vendor master's terms when blank.
    ['vendor_pos', 'payment_terms TEXT'],                 // 'Advance' | 'Credit' | 'PDC' | 'COD' | free text
    ['vendor_pos', 'credit_days INTEGER'],                // optional credit period for the above
    // Freight terms + charge entered on the Create / Edit PO modal (mam
    // 2026-06-12).  Printed on the vendor PO.  freight_terms is who bears
    // the freight ('Ex-Works' = buyer arranges, 'FOR' = vendor delivers to
    // site); freight_amount (₹) is added to the PO's taxable value so GST
    // applies on it, matching how vendors bill freight.
    ['vendor_pos', 'freight_terms TEXT'],                 // 'Ex-Works' | 'FOR' | NULL
    ['vendor_pos', 'freight_amount REAL DEFAULT 0'],      // ₹ freight added to the PO total
    // Purchase Bills also get an uploaded file (the bill PDF / image / excel)
    ['purchase_bills', 'file_path TEXT'],
    // Material acceptance at bill entry (mam 2026-06-04): 'approved' (default)
    // or 'reject'.  Reject auto-raises a rejected-material debit note.
    ['purchase_bills', "material_status TEXT DEFAULT 'approved'"],
    // Dispatch (delivery_notes) — upgraded from a simple "delivery record" to
    // either a Sales Bill (PO items we sell to client) or a Delivery Challan
    // (FOC / RGP items). document_type + document_number distinguish them,
    // file_path stores the scan/PDF, and received_by_name + received_at
    // capture who actually received the material on the site.
    ['delivery_notes', 'document_type TEXT'],           // 'sales_bill' | 'challan'
    ['delivery_notes', 'document_number TEXT'],         // sales-bill / challan number
    ['delivery_notes', 'file_path TEXT'],
    ['delivery_notes', 'received_by_name TEXT'],        // free text (site engineer / customer rep)
    ['delivery_notes', 'received_at DATETIME'],
    // Proof of receipt (stamped + signed photo of the sales bill / challan)
    // — critical for mam because without this the client sometimes denies
    // receiving material and SEPL takes the loss.
    ['delivery_notes', 'receipt_file_path TEXT'],
    // Support tickets — who is the ticket assigned to? When set, that user
    // sees the ticket on their dashboard and can respond / work on it.
    ['support_tickets', 'assigned_to INTEGER REFERENCES users(id)'],
    // --- Sales Funnel phase-A columns (mam's spec 2026-04-23) ---
    ['sales_funnel', 'first_call_status TEXT'],          // 'interested' | 'not_interested'
    ['sales_funnel', 'first_call_at DATETIME'],          // when the first call was made
    ['sales_funnel', 'first_call_remarks TEXT'],
    ['sales_funnel', 'meeting_recording_url TEXT'],      // phone / VC recording
    ['sales_funnel', 'meeting_location_lat REAL'],       // live location at meeting
    ['sales_funnel', 'meeting_location_lng REAL'],
    ['sales_funnel', 'f2f_status TEXT'],                 // 'done' | 'no_show' | 'rescheduled'
    ['sales_funnel', 'f2f_date DATETIME'],
    ['sales_funnel', 'revised_boq_file_link TEXT'],
    ['sales_funnel', 'lead_type TEXT'],                  // customer/lead type
    // CRM Funnel — mam wants "Lead Type :- new / extra enquiry" and a
    // BOQ file upload right at lead capture (Add CRM Lead modal). The
    // existing `type` column is Private / Government — this new
    // `lead_type` is independent and tracks New vs Extra Enquiry.
    ['crm_funnel', 'lead_type TEXT'],                    // 'New' | 'Extra Enquiry'
    ['crm_funnel', 'boq_file_link TEXT'],                // optional BOQ upload from client
    ['sales_funnel', 'city TEXT'],                       // separate from district
    // SLA tracking — stamp the timestamp when the lead entered its current
    // stage, so overdue detection knows the clock start. SLAs are:
    //   new_lead -> qualified: 1 hour
    //   qualified -> meeting_assigned: 4 hours
    //   meeting_assigned -> f2f: variable (T-X)
    //   f2f -> mom: 1 day
    //   mom -> quotation: variable (T-X)
    //   quotation -> won/lost: 60 days
    ['sales_funnel', 'stage_entered_at DATETIME'],
    // --- MOM form fields (mam's spec 2026-04-23) — a richer MOM capture:
    //   Customer Category / Type → already on the lead (category, lead_type)
    //   M.O.M. (notes)           → already on the lead (mom_notes)
    //   Meeting Location         → already on the lead
    // Below adds the remaining fields:
    ['sales_funnel', 'meeting_purpose TEXT'],               // Purpose Of Meeting
    ['sales_funnel', 'meeting_timestamp_photo_url TEXT'],   // Timestamp Photo (with GPS overlay)
    ['sales_funnel', 'pain_points TEXT'],                   // Pain Points
    ['sales_funnel', 'requirements TEXT'],                  // Requirements
    ['sales_funnel', 'action_planned TEXT'],                // Action Planned (next step)
    ['sales_funnel', 'meeting_format TEXT'],                // Phone / VC / In-Person
    ['sales_funnel', 'meeting_scheduled_by TEXT'],          // who scheduled the meeting
    ['sales_funnel', 'meeting_time_spent_min INTEGER'],     // minutes spent in the meeting
    // user_id of the employee the meeting is assigned to. Stored alongside
    // meeting_assigned_to (TEXT name) so the assigned employee's dashboard
    // can filter "My Planned Meetings" by user_id without name-matching.
    // Mam: 'so that assigned meeting user show their Meeting planned and
    // he will fill mom after on schedule day visit'.
    ['sales_funnel', 'meeting_assigned_to_id INTEGER REFERENCES users(id)'],
    // user_id of the ASM (Area Sales Manager / BD) the lead is assigned
    // to at capture time. Same pattern as meeting_assigned_to_id — name
    // stays in assigned_asm for display, FK in assigned_asm_id for the
    // ASM's "My Leads" dashboard filter.
    ['sales_funnel', 'assigned_asm_id INTEGER REFERENCES users(id)'],
    // Complaints — mam's Google Form (2026-04-23) adds State and Remarks.
    // Complaint Type = Paid / Free (changed from Urgent/Normal/Low)
    // Customer Type = Old Site / Running Site (changed from New/Existing)
    ['complaints', 'state TEXT'],
    ['complaints', 'remarks TEXT'],
    // Delegations — optional project tag the admin can set while creating a
    // task or edit later from the list. Free-text so it doesn't depend on
    // any master list; keeps it flexible for mam's quick day-to-day tasks.
    ['delegations', 'project_name TEXT'],
    // Optional attachment (brief / drawing / photo / doc) the creator can
    // attach when assigning the task. Stored as a /uploads/<name> URL.
    ['delegations', 'attachment_url TEXT'],
    // Mam (2026-05-22): same upload affordance on the New PMS Task
    // modal — pick a brief / drawing / photo when raising.
    ['pms_tasks', 'attachment_url TEXT'],
    // Mam (2026-05-22): Checklists module needs a department tag so
    // admin can filter / route checklists by team.  Auto-populated
    // from the assignee's users.department when picked, editable in
    // the modal as a dropdown sourced from the distinct user
    // departments + a free-text fallback.
    ['checklists', 'department TEXT'],
    ['checklists', 'due_time TEXT'],  // 'HH:MM' for daily / time-of-day display
    // Mam (2026-05-22): "ask start date and end date ... create
    // checklist task daily wise" — recurrence window so a daily
    // task only generates instances inside [start, end].  Out-of-
    // window dates render as N/A in the Follow-up grid and don't
    // count as "missed" on the by-date view.
    ['checklists', 'recurrence_start_date DATE'],
    ['checklists', 'recurrence_end_date DATE'],
    ['checklists', 'reviewer_id INTEGER REFERENCES users(id)'],
    ['checklists', 'proof_url TEXT'],
    ['checklists', 'reject_reason TEXT'],
    // Mam (2026-05-22): "i want to tell which type proof need for
    // complete or text".  Per-checklist proof requirement so the
    // Complete UI knows whether to show a file picker (photo/pdf/
    // file), a textarea (text), or just a done button (none).
    //   'photo' — image only (JPG/PNG) — default for backwards compat
    //   'pdf'   — PDF file only
    //   'file'  — any file (photo / PDF / doc)
    //   'text'  — text note only, no upload
    //   'none'  — no proof needed, just mark done
    ['checklists', "proof_type TEXT DEFAULT 'photo'"],
    // Mam (2026-05-22): "add frequency fortnightly mean month 2 time
    // b/w 15 days distance" — store the two day-of-month slots
    // (e.g. "5,20") on each checklist row.  Default 1,15 if blank.
    // Followup / by-date queries treat day-of-month match as "due".
    ['checklists', 'fortnight_days TEXT'],
    // Mam (2026-05-22): "between MILESTONE and AANCHAL add AR CLEARED
    // so that CRM can add AR cleared and above dashboard also show AR
    // cleared".  New per-project column in raw rupees, edited by CRM
    // on each Cash Flow row.  Summary card sums it across projects.
    ['project_finance', 'ar_cleared_value REAL DEFAULT 0'],
    // Mam (2026-05-22): "add one proof name like type gst file etc"
    // — friendly label shown ON the assignee's upload button so they
    // know what to attach (e.g. "GST File", "Bank Statement",
    // "Site Photo").  Optional; falls back to the generic proof_type
    // label when blank.
    ['checklists', 'proof_label TEXT'],
    // AI Agent: link a BOQ row back to a catalogue item so quotation
    // rates feed item_price_history and the rate-suggestion popup can
    // show last-quoted / 6-month avg-low-high for that exact item.
    // Optional — free-text descriptions still work for one-off items.
    ['boq_items', 'item_id INTEGER REFERENCES item_master(id)'],
    // DPR Loss Reasons follow-up flag (mam: management dashboard so
    // MD can see why each loss happened and check it off after action).
    ['dpr', 'loss_addressed INTEGER DEFAULT 0'],
    ['dpr', 'loss_addressed_by INTEGER REFERENCES users(id)'],
    ['dpr', 'loss_addressed_at DATETIME'],
    ['dpr', 'loss_addressed_note TEXT'],
    // Track which 3-day consecutive-loss alerts were already mailed so
    // the same alert doesn't fire again on every subsequent DPR save.
    ['dpr', 'streak_alert_sent_for DATE'],
    // Dispatch document generation — mam shared SEPL Delivery Note &
    // Sales Bill templates. Instead of just uploading a file, the ERP
    // now generates an HTML print page filled from the Vendor PO + items.
    // These columns hold the dispatch-time fields the auto-fill can't
    // know up-front (vehicle/driver, GST split, freight, etc.).
    // -- Delivery Note specific --
    ['delivery_notes', 'vehicle_no TEXT'],
    ['delivery_notes', 'driver_name TEXT'],
    ['delivery_notes', 'driver_mobile TEXT'],
    ['delivery_notes', 'lr_challan_no TEXT'],
    ['delivery_notes', 'total_packages TEXT'],
    // -- Sales Bill specific --
    ['delivery_notes', 'place_of_supply TEXT'],
    ['delivery_notes', 'state_code TEXT'],
    ['delivery_notes', 'reverse_charge INTEGER DEFAULT 0'],
    ['delivery_notes', 'e_way_bill_no TEXT'],
    ['delivery_notes', 'cgst_pct REAL DEFAULT 0'],
    ['delivery_notes', 'sgst_pct REAL DEFAULT 0'],
    ['delivery_notes', 'igst_pct REAL DEFAULT 0'],
    ['delivery_notes', 'freight_amount REAL DEFAULT 0'],
    ['delivery_notes', 'round_off_amount REAL DEFAULT 0'],
    ['delivery_notes', 'subtotal_amount REAL DEFAULT 0'],
    ['delivery_notes', 'grand_total_amount REAL DEFAULT 0'],
    // Per-line-item overrides for the dispatch (sales-bill / DN).
    // Sales Bill defaults to po_items (Client PO line items) so the
    // rate column is what SEPL charges the client, not vendor cost.
    // The user can edit qty / rate / disc% / include flag inline before
    // hitting Create — those overrides land in items_json so the
    // print page renders the exact lines the user signed off on.
    // Shape: JSON array of {po_item_id, description, hsn, unit, qty,
    //                       rate, disc_pct, amount}
    ['delivery_notes', 'items_json TEXT'],
    // Late Sales Bill — mam (2026-05-25): sometimes goods are dispatched
    // with only a Delivery Note / Challan, and the formal Sales Bill
    // follows days later.  These columns let us flag "DN delivered,
    // Sales Bill still pending" and then back-fill the SB once it arrives.
    ['delivery_notes', 'sales_bill_pending INTEGER DEFAULT 0'],
    ['delivery_notes', 'sales_bill_number TEXT'],
    ['delivery_notes', 'sales_bill_file_path TEXT'],
    ['delivery_notes', 'sales_bill_uploaded_at DATETIME'],
    // From-store challans (mam 2026-06-04): material issued from stock has
    // no Vendor PO, so its delivery challan links to the indent + the
    // Stock Issue Note instead.  vendor_po_id stays NULL for these rows.
    ['delivery_notes', 'indent_id INTEGER'],
    ['delivery_notes', 'stock_issue_note_id INTEGER'],
    ['delivery_notes', "source TEXT DEFAULT 'po'"],   // 'po' | 'store'
    // Auto-generated Sales Bill that still needs completion (missing client
    // GSTIN / selling rates).  mam 2026-06-04: auto-create on receive, flag
    // as draft until the few fields are filled.
    ['delivery_notes', 'is_draft INTEGER DEFAULT 0'],
    // Sub-Contractor module (mam's "Sub-Contractor Form" Google-Form
    // 47-entry workflow brought into ERP). Extends the existing
    // sub_contractors table — legacy HR fields (phone, email,
    // specialization, rate, rate_unit, status, notes) stay; these are
    // added so the same row can carry the full Google-Form data.
    ['sub_contractors', 'state TEXT'],
    ['sub_contractors', 'district TEXT'],
    ['sub_contractors', 'location_extra TEXT'],
    ['sub_contractors', 'contractor_type TEXT'],
    ['sub_contractors', 'experience_years INTEGER DEFAULT 0'],
    ['sub_contractors', 'manpower INTEGER DEFAULT 0'],
    ['sub_contractors', 'with_tools INTEGER DEFAULT 0'],
    ['sub_contractors', 'has_gst INTEGER DEFAULT 0'],
    ['sub_contractors', 'gst_number TEXT'],
    ['sub_contractors', 'rate_in_budget TEXT'],
    ['sub_contractors', 'start_within_days INTEGER DEFAULT 0'],
    ['sub_contractors', 'active INTEGER DEFAULT 1'],
    ['sub_contractors', 'created_by INTEGER REFERENCES users(id)'],
    ['sub_contractors', 'updated_at DATETIME'],
    // Optional Work Order document (mam 2026-06-06) — stored as a /uploads URL.
    ['sub_contractors', 'work_order_file TEXT'],
    // Pipe MTR→KG conversion (mam 2026-06-06): kg per meter. When >0 and the
    // item is indented in meters, Vendor Rates + PO convert qty to KG.
    ['item_master', 'weight_per_meter REAL'],
    // Pipe weight captured as mam's Excel has it — weight of ONE pipe (kg) +
    // the pipe length (m). The conversion still runs off weight_per_meter
    // (= weight_per_pipe / pipe_length_m); these two are stored so the item
    // round-trips and shows the same values mam typed (mam 2026-06-25:
    // "here only give pipe per weight ... purchase in kg").
    ['item_master', 'weight_per_pipe REAL'],
    ['item_master', 'pipe_length_m REAL'],
    // AI Auto-Quotation payment-terms split (mam 2026-06-25): Advance/Material/
    // Installation/T&C/Handover/Retention %, persisted as JSON with the estimate.
    ['estimate_quotations', 'payment_terms_json TEXT'],
    // CRM funnel: tentative project value captured when a lead is qualified
    // at Stage 1 (mam 2026-06-25: "when qualified give option for tentative amt").
    ['sales_funnel', 'tentative_amount REAL'],
    // CRM funnel: expected lead closing date, captured alongside the tentative
    // amount when a lead is qualified (mam 2026-06-25).
    ['sales_funnel', 'closing_date DATE'],
    // Inventory opening date is now PER WAREHOUSE (mam 2026-06-25: "site wise
    // date opening — from that we go automatically"), not one global setting.
    ['warehouses', 'opening_date DATE'],
    ['indent_items', 'weight_per_meter REAL'],
    // PO line snapshot: kg/m used, and the original meters (quantity on the
    // line is stored in KG for pipes so amount = kg × ₹/kg works unchanged).
    ['vendor_po_items', 'weight_per_meter REAL'],
    ['vendor_po_items', 'original_qty_mtr REAL'],
    // Editable PO line snapshot (mam 2026-05-25: edit PO line items after
    // creation).  The Edit-PO modal lets the user override the printed
    // description / HSN per line; these columns store that override.  Were
    // referenced by /with-items + the PUT /vendor-po/:id line-item update
    // since 2026-05-25 but never actually added — so /with-items threw
    // "no such column" → 500 → the Edit modal showed zero line items.
    ['vendor_po_items', 'description TEXT'],
    ['vendor_po_items', 'hsn_code TEXT'],
    // CRM funnel ← Extra indent link (mam 2026-06-06): Extra-Schedule /
    // Extra-Non-Schedule indents drop a funnel "requirement" at raise time.
    ['crm_funnel', 'source_indent_id INTEGER'],
    ['crm_funnel', 'requirement_items TEXT'],
    // ─── Per-user KPI settings — mam (2026-06-02 follow-up) ───────────
    // Initial table (score_user_kpi_target) only held planned_value
    // overrides.  Mam confirmed "every person different KPIs" — Option B:
    // shared template, per-user enable/disable + weight override.  Two
    // new columns reuse the same composite-PK table:
    //   enabled         — 0 hides this KPI from the user entirely.
    //   weight_override — overrides score_kpis.weightage for this user.
    // Backwards compatible: existing rows default to enabled=1 + NULL
    // weight_override → behave exactly as before this change.
    ['score_user_kpi_target', 'enabled INTEGER DEFAULT 1'],
    ['score_user_kpi_target', 'weight_override REAL'],
    // Preserve attendance attribution when a user is hard-deleted (mam
    // 2026-07-06: "if user delete, but old attendance data don't delete").
    // On force-delete we snapshot the person's name here, then null
    // attendance.user_id — the row is KEPT, just unlinked, and still shows
    // who it belonged to (the admin Attendance list COALESCEs to this).
    ['attendance', 'user_name_snapshot TEXT'],
    // ─── Indent line source split — store vs procure ────────────────────
    // Mam (2026-06-02): when an indent line needs 20 pcs and 5 are
    // already in office stock, the L1/L2 approver can now split the line
    // into two children: 5 issued from store (auto-decrements stock_balance,
    // writes a stock_issue_note + an OUT row in stock_movements) and 15
    // continuing through the normal vendor PO flow.  Lets MD see the full
    // audit trail of "what came from store vs what we bought new" on
    // the same indent number.
    ['indent_items', `source TEXT NOT NULL DEFAULT 'procure'`],   // 'procure' | 'store'
    ['indent_items', 'parent_item_id INTEGER REFERENCES indent_items(id)'],
    ['indent_items', 'stock_issue_note_id INTEGER REFERENCES stock_issue_notes(id)'],
    ['indent_items', 'stock_movement_id INTEGER REFERENCES stock_movements(id)'],
    // Food allowance per employee per month (mam 2026-06-12) — ADDED to net
    // pay.  Lives on payroll_advances (already keyed by month + employee_id).
    ['payroll_advances', 'food REAL DEFAULT 0'],
    // Manual monthly overrides (mam 2026-06-13: "give me edit option on days,
    // CL, late so i can give salary now").  NULL = use the auto-calculated
    // value; a number (incl. 0) overrides it for that month.
    ['payroll_advances', 'paid_days_override REAL'],
    ['payroll_advances', 'cl_override REAL'],
    ['payroll_advances', 'late_penalty_override REAL'],
    // Disbursement tracking (mam 2026-06-13): after a month is finalised,
    // Accounts marks each person Paid — anyone left unpaid stays in the record.
    ['payroll_runs', 'paid INTEGER DEFAULT 0'],
    ['payroll_runs', 'paid_at DATETIME'],
    ['payroll_runs', 'paid_by INTEGER REFERENCES users(id)'],
    // Sales Billing — 4-type sequential bill flow (mam 2026-06-13).  Added to
    // the existing sales_bills table so legacy delivery-note rows (bill_type
    // NULL) are untouched; the new module only handles bill_type 1-4.
    ['sales_bills', 'bill_type INTEGER'],                 // 1=Sales Order 2=Delivery 3=Installation 4=Final
    ['sales_bills', 'business_book_id INTEGER REFERENCES business_book(id)'],
    ['sales_bills', 'customer_name TEXT'],
    ['sales_bills', 'customer_gstin TEXT'],
    ['sales_bills', 'project_name TEXT'],
    ['sales_bills', 'gst_rate REAL DEFAULT 0'],
    ['sales_bills', 'bill_status TEXT'],                  // ORDER BOOKED / MATERIAL DELIVERED / ...
    ['sales_bills', 'previous_bill_id INTEGER'],
    ['sales_bills', 'reference_doc_type TEXT'],
    ['sales_bills', 'reference_doc_no TEXT'],
    ['sales_bills', 'reference_id INTEGER'],
    ['sales_bills', "approval_status TEXT DEFAULT 'draft'"],
    ['sales_bills', 'created_by INTEGER REFERENCES users(id)'],
    // Idempotency for the Type-3 installation auto-bill: each DPR is billed
    // into exactly one Type-3 sales bill (mam 2026-06-13: installation bill
    // every 15 days from DPRs).  NULL = not yet billed.
    ['dpr', 'sales_bill_id INTEGER'],
    // "Sent to Client" — the only manual step on an auto-generated installation
    // bill (mam 2026-06-13: "only give option sent to client").
    ['sales_bills', 'sent_to_client INTEGER DEFAULT 0'],
    ['sales_bills', 'sent_at DATETIME'],
    // Room Rentals — PIN code of the rented room + auto metro/non-metro
    // classification (mam 2026-06-23). metro_type IN ('Metro','Non-Metro');
    // pincode_city is the India-Post-resolved district/city for reference.
    ['rent_requests', 'pincode TEXT'],
    ['rent_requests', 'pincode_city TEXT'],
    ['rent_requests', 'metro_type TEXT'],
  ];
  // Unique index on username — case-INSENSITIVE so 'Vijay' and 'vijay' can't
  // coexist (the app always compares LOWER(username); the old case-sensitive index
  // let case-variant duplicates slip through). Allows NULLs for legacy rows.
  // Done defensively: only swap to the new index when the data has no collisions,
  // so a duplicate row can never leave the table with NO uniqueness index at all.
  // If duplicates exist, keep whatever index is there and log them loudly (was
  // silently swallowed before) so they can be de-duped in User Management.
  try {
    const dup = db.prepare(
      "SELECT 1 FROM users WHERE username IS NOT NULL AND username<>'' GROUP BY LOWER(username) HAVING COUNT(*)>1 LIMIT 1"
    ).get();
    if (!dup) {
      db.exec('DROP INDEX IF EXISTS idx_users_username');
      db.exec('CREATE UNIQUE INDEX idx_users_username ON users(LOWER(username)) WHERE username IS NOT NULL');
    } else {
      const list = db.prepare(
        "SELECT LOWER(username) un, COUNT(*) c FROM users WHERE username IS NOT NULL AND username<>'' GROUP BY LOWER(username) HAVING c>1"
      ).all();
      console.error('[schema] username uniqueness NOT hardened — duplicate usernames exist:',
        list.map(d => `${d.un}×${d.c}`).join(', '), '— de-dupe these in User Management, then restart.');
    }
  } catch (e) { console.error('[schema] username index error:', e.message); }

  // De-duplicate indent_item_rates → one row per indent_item (mam 2026-06-23:
  // "in po double double item"). The table never had a UNIQUE(indent_item_id),
  // so the seed (INSERT OR IGNORE) could create multiple rows per item, and
  // any query joining it printed each PO/indent line twice. Keep the LATEST
  // (max-id) row per item, then enforce uniqueness so it can't recur — which
  // also makes the existing INSERT OR IGNORE seeds idempotent.
  try {
    db.exec(`DELETE FROM indent_item_rates
             WHERE indent_item_id IS NOT NULL
               AND id NOT IN (SELECT MAX(id) FROM indent_item_rates
                              WHERE indent_item_id IS NOT NULL
                              GROUP BY indent_item_id)`);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_iir_indent_item ON indent_item_rates(indent_item_id) WHERE indent_item_id IS NOT NULL');
  } catch (e) { console.warn('[migration] indent_item_rates dedupe skipped:', e.message); }

  // Relax payment_requests.category CHECK to allow new categories like
  // 'Salary' and 'Compliance'. SQLite can't ALTER a CHECK constraint, so we
  // detect the old 4-category signature in sqlite_master and rebuild the
  // table via a data-preserving copy. Runs exactly once — the new CREATE
  // TABLE IF NOT EXISTS won't re-create if a relaxed version already exists.

  // Same rebuild pattern for support_tickets — the original CHECK on
  // category only allowed 'bug','feature_request','how_to','data_issue',
  // 'other'. Mam expanded the list to include access_issue, manpower,
  // material, payment. Strip the CHECK altogether (app layer validates
  // via the CATEGORIES list in HelpTickets.jsx) so future additions
  // don't need a migration.
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='support_tickets'").get();
    if (row && /CHECK\s*\(\s*category\s+IN\s*\([^)]*\)\s*\)/i.test(row.sql)
            && !/manpower/i.test(row.sql)) {
      db.exec('BEGIN');
      const newSql = row.sql
        .replace(/CREATE TABLE\s+support_tickets/i, 'CREATE TABLE support_tickets_new')
        .replace(/,?\s*CHECK\s*\(\s*category\s+IN\s*\([^)]*\)\s*\)/i, '');
      db.exec(newSql);
      // Copy by column list so any future renames don't break this.
      const cols = db.prepare("PRAGMA table_info(support_tickets)").all().map(c => c.name).join(',');
      db.exec(`INSERT INTO support_tickets_new (${cols}) SELECT ${cols} FROM support_tickets`);
      db.exec('DROP TABLE support_tickets');
      db.exec('ALTER TABLE support_tickets_new RENAME TO support_tickets');
      db.exec('COMMIT');
      console.log('[migration] support_tickets rebuilt — category CHECK relaxed (manpower/material/payment now allowed)');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) {}
  }

  // Mam (2026-05-21) STILL "not done" after multiple attempts.  Going
  // all-in this time: proper SQLite table-rebuild pattern per docs
  // (foreign_keys=OFF, BEGIN, create new, copy, drop, rename, COMMIT,
  // foreign_keys=ON) PLUS post-rebuild verification that re-reads
  // sqlite_master to confirm the CHECK is gone.  Failure to verify
  // throws so it surfaces in pm2 logs instead of hiding.
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='payment_requests'").get();
    if (row && /CHECK\s*\(\s*category\s+IN/i.test(row.sql)) {
      console.log('[migration] ════════════════════════════════════════════');
      console.log('[migration] payment_requests CHECK detected — rebuilding');
      console.log('[migration] OLD sql:\n', row.sql);

      // SQLite docs require FKs off during structural change.
      db.pragma('foreign_keys = OFF');

      // Clean up any orphan from a prior failed run.
      try { db.exec('DROP TABLE IF EXISTS payment_requests_new'); } catch (_) {}

      // Build the new CREATE statement.  Handles BOTH `CREATE TABLE`
      // and `CREATE TABLE IF NOT EXISTS` shapes, and any inline CHECK
      // clause that references the category column.
      const newSql = row.sql
        .replace(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+payment_requests/i, 'CREATE TABLE payment_requests_new')
        .replace(/,?\s*CHECK\s*\(\s*category\s+IN\s*\([^)]*\)\s*\)/i, '');
      console.log('[migration] NEW sql:\n', newSql);

      if (newSql === row.sql) {
        throw new Error('regex did not modify sql — CHECK clause shape unexpected');
      }

      // Explicit column list — safer than `INSERT ... SELECT *` if the
      // old table has columns the new schema doesn't (or vice-versa).
      const cols = db.prepare('PRAGMA table_info(payment_requests)').all().map(c => c.name);
      const colList = cols.map(c => `"${c}"`).join(', ');

      db.exec('BEGIN');
      db.exec(newSql);
      db.exec(`INSERT INTO payment_requests_new (${colList}) SELECT ${colList} FROM payment_requests`);
      db.exec('DROP TABLE payment_requests');
      db.exec('ALTER TABLE payment_requests_new RENAME TO payment_requests');
      db.exec('COMMIT');

      db.pragma('foreign_keys = ON');

      // VERIFY — re-read sqlite_master and make sure the CHECK is
      // actually gone.  If verification fails, we throw so the next
      // pm2 log line tells mam exactly what to forward to me.
      const after = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='payment_requests'").get();
      if (after && /CHECK\s*\(\s*category\s+IN/i.test(after.sql)) {
        throw new Error('verification failed — CHECK still present after rebuild. post-rebuild sql:\n' + after.sql);
      }
      console.log('[migration] ✓ payment_requests CHECK removed — Salary / Compliance / Other now allowed');
      console.log('[migration] ════════════════════════════════════════════');
    } else if (row) {
      console.log('[migration] payment_requests CHECK already gone — skipping');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    try { db.pragma('foreign_keys = ON'); } catch (_) {}
    console.error('[migration] ✗ payment_requests CHECK drop FAILED:', e.message);
    console.error(e.stack);
  }

  // One-time backfill: legacy form bug (mam 2026-05-28) stored the
  // employee's numeric user_id in indents.raised_by_name instead of
  // their name, so the column displayed "10.0" / "54.0" / "3.0".
  // Recover the actual name by JOIN on users.id.
  //
  // Safety: only updates rows where raised_by_name contains ONLY
  // digits + optional decimal, AND the integer value matches a real
  // user. Won't touch legitimate names that happen to contain digits.
  try {
    const fix = db.prepare(`
      UPDATE indents
         SET raised_by_name = (SELECT name FROM users WHERE id = CAST(indents.raised_by_name AS INTEGER))
       WHERE raised_by_name IS NOT NULL
         AND raised_by_name NOT GLOB '*[^0-9.]*'   -- SQLite uses ^ for class negation, not !
         AND raised_by_name GLOB '[0-9]*'
         AND CAST(raised_by_name AS INTEGER) > 0
         AND CAST(raised_by_name AS INTEGER) IN (SELECT id FROM users)
    `).run();
    if (fix.changes > 0) console.log(`[migration] indents.raised_by_name — backfilled ${fix.changes} numeric rows to user names`);
  } catch (e) { console.error('[migration] raised_by_name backfill failed:', e.message); }

  // Mam (2026-05-28 follow-up): "previous show wrong raise by name so
  // blank here". The numeric→name recovery above isn't reliable — the
  // form bug stored the picked-employee-id, but the indents were often
  // raised by a DIFFERENT person, so mapping the id back gives the
  // wrong name. Blank every existing raised_by_name once. New indents
  // created via the fixed form will store the correct name from today
  // onwards. Tracked by app_settings flag so it runs exactly once.
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='blank_legacy_raised_by_name_v1'").get();
    if (!done) {
      const blanked = db.prepare(`UPDATE indents SET raised_by_name = NULL WHERE raised_by_name IS NOT NULL`).run();
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('blank_legacy_raised_by_name_v1', '1')").run();
      if (blanked.changes > 0) console.log(`[migration] indents.raised_by_name — blanked ${blanked.changes} legacy rows (mam: previous names wrong)`);
    }
  } catch (e) { console.error('[migration] blank legacy raised_by_name failed:', e.message); }

  // Mam (2026-06-08) OT rule: "Overtime per hours >9, OT per hour =
  // salary / total days in month / 9 × extra hours". The engine already
  // computes perHourRate = base / (totalDays × ot_threshold_hours) ×
  // ot_rate_multiplier, so the rule maps exactly to threshold=9 and a
  // straight (×1) multiplier. Set the live settings row once. (v3 flag —
  // mam went 9 → 8 → back to 9; runs even if the earlier passes ran.)
  // Admin can re-tune both in Payroll → Rules/Settings afterwards.
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='payroll_ot_rule_9h_straight_v3'").get();
    if (!done) {
      const r = db.prepare(
        `UPDATE payroll_settings SET ot_threshold_hours = 9, ot_rate_multiplier = 1 WHERE id = 1`
      ).run();
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('payroll_ot_rule_9h_straight_v3', '1')").run();
      if (r.changes > 0) console.log('[migration] payroll OT rule set to >9h at straight (salary/days/9) per-hour rate');
    }
  } catch (e) { console.error('[migration] payroll OT rule set failed:', e.message); }

  // Backfill from-store delivery challans (mam 2026-06-04): store issues
  // created BEFORE the auto-challan feature have a Stock Issue Note but no
  // delivery_notes challan, so they don't show in Dispatch & Receiving.
  // Create one 'challan' (source='store') per stock_issue_note that lacks
  // one, pulling the store lines from the indent_items that reference it.
  // Guarded to run once.
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='backfill_store_challans_v1'").get();
    if (!done) {
      const notes = db.prepare('SELECT id, note_number, indent_id FROM stock_issue_notes').all();
      let created = 0;
      for (const n of notes) {
        const exists = db.prepare("SELECT id FROM delivery_notes WHERE stock_issue_note_id=? AND source='store'").get(n.id);
        if (exists) continue;
        const lines = db.prepare(
          "SELECT description, quantity as qty, unit, rate, item_type FROM indent_items WHERE stock_issue_note_id=?"
        ).all(n.id);
        const billable = lines.some(it => String(it.item_type || '').toUpperCase() === 'PO');
        const itemsJson = JSON.stringify(lines.map(it => ({
          description: it.description, qty: it.qty, unit: it.unit || '',
          rate: +it.rate || 0, amount: (+it.qty || 0) * (+it.rate || 0), item_type: it.item_type || '',
        })));
        const today = new Date().toISOString().slice(0, 10);
        db.prepare(
          `INSERT INTO delivery_notes
             (vendor_po_id, indent_id, stock_issue_note_id, source, delivery_date,
              document_type, document_number, status, sales_bill_pending, items_json, notes)
           VALUES (NULL, ?, ?, 'store', ?, 'challan', ?, 'pending', ?, ?, ?)`
        ).run(n.indent_id, n.id, today, n.note_number, billable ? 1 : 0, itemsJson, 'Material issued from store (backfilled)');
        created++;
      }
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('backfill_store_challans_v1', '1')").run();
      if (created > 0) console.log(`[migration] backfilled ${created} from-store delivery challans`);
    }
  } catch (e) { console.error('[migration] store challan backfill failed:', e.message); }

  // Revert auto-cut from-store Sales Bills (mam 2026-06-06): we used to
  // auto-cut the Sales Bill for PO store items at store issue. mam wants
  // those to instead wait in "Ready to Dispatch" so she cuts them herself.
  // For every from-store challan that was auto-cut, IF its Sales Bill is
  // still a DRAFT and hasn't been received yet (safe to undo), delete that
  // draft Sales Bill and flip the challan back to sales_bill_pending=1 so it
  // reappears in the Ready-to-Dispatch "From-Store · Sales Bill pending"
  // card.  Sales Bills already received/sent are left untouched. Run once.
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='revert_autocut_store_sb_v1'").get();
    if (!done) {
      const challans = db.prepare(
        "SELECT id, sales_bill_number FROM delivery_notes WHERE source='store' AND document_type='challan' AND sales_bill_number IS NOT NULL AND sales_bill_number <> ''"
      ).all();
      let reverted = 0;
      for (const ch of challans) {
        const sb = db.prepare(
          "SELECT id, is_draft, status, received_at FROM delivery_notes WHERE document_type='sales_bill' AND document_number=?"
        ).get(ch.sales_bill_number);
        // Only undo when the Sales Bill is a draft AND not yet received.
        if (sb && sb.is_draft === 1 && !sb.received_at && (sb.status === 'pending' || sb.status == null)) {
          db.prepare('DELETE FROM delivery_notes WHERE id=?').run(sb.id);
          db.prepare("UPDATE delivery_notes SET sales_bill_pending=1, sales_bill_number=NULL WHERE id=?").run(ch.id);
          reverted++;
        }
      }
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('revert_autocut_store_sb_v1', '1')").run();
      if (reverted > 0) console.log(`[migration] reverted ${reverted} auto-cut from-store Sales Bills back to Ready-to-Dispatch (mam)`);
    }
  } catch (e) { console.error('[migration] revert auto-cut store SB failed:', e.message); }

  // Seed the Pipe Weight master with C-class rows from mam's sheet
  // (2026-06-06). kg_per_meter = weight_per_pipe / 6m. mam can edit these and
  // add B-class etc. in the Pipe Weights master UI. Guarded; only seeds if the
  // table is empty so it never clobbers her edits.
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='seed_pipe_weights_cclass_v1'").get();
    const count = db.prepare('SELECT COUNT(*) c FROM pipe_weights').get().c;
    if (!done && count === 0) {
      const C = [
        ['400 mm', 419.46], ['350 mm', 366.12], ['300 mm', 332.82], ['250 mm', 250.62],
        ['200 mm', 199.86], ['150 mm', 127.8], ['100 mm', 87], ['80 mm', 59.4],
        ['65 mm', 47.58], ['50 mm', 37.14], ['40 mm', 26.22], ['32 mm', 22.74], ['25 mm', 17.58],
      ];
      const ins = db.prepare("INSERT INTO pipe_weights (pipe_class, size, kg_per_meter, weight_per_pipe, pipe_length_m, active) VALUES ('C', ?, ?, ?, 6, 1)");
      for (const [size, wpp] of C) ins.run(size, Math.round((wpp / 6) * 1000) / 1000, wpp);
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('seed_pipe_weights_cclass_v1', '1')").run();
      console.log(`[migration] seeded ${C.length} C-class pipe weights`);
    }
  } catch (e) { console.error('[migration] pipe weight seed failed:', e.message); }

  // Backfill indent_items.weight_per_meter from item_master for items that
  // already had a kg/m set (mam 2026-06-06). New indents snapshot it at
  // creation; this catches pre-existing open indents. Guarded once.
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='backfill_indent_item_wpm_v1'").get();
    if (!done) {
      const r = db.prepare(`
        UPDATE indent_items
           SET weight_per_meter = (SELECT im.weight_per_meter FROM item_master im WHERE im.id = indent_items.item_master_id)
         WHERE weight_per_meter IS NULL
           AND item_master_id IS NOT NULL
           AND (SELECT im.weight_per_meter FROM item_master im WHERE im.id = indent_items.item_master_id) > 0
      `).run();
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('backfill_indent_item_wpm_v1', '1')").run();
      if (r.changes > 0) console.log(`[migration] backfilled weight_per_meter on ${r.changes} indent items`);
    }
  } catch (e) { console.error('[migration] indent item wpm backfill failed:', e.message); }

  // mam 2026-06-25: pipe purchase qty = indent qty × the FULL per-pipe weight,
  // NOT divided by length (e.g. 80 mm C-class weight 59.4, a 5 MTR indent →
  // 5 × 59.4 = 297 kg). The conversion factor (weight_per_meter, multiplied by
  // qty) must therefore hold the full per-pipe weight. Rebase every pipe item
  // that has a weight_per_pipe, and its open indent-line snapshots, from the
  // old divided value to the full weight. Guarded with weight_per_pipe > 0 so
  // items without a per-pipe weight are left untouched (never nulled).
  // Finalized vendor_po_items are NOT touched — issued POs stay as-billed.
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='pipe_wpm_full_weight_v1'").get();
    if (!done) {
      const r1 = db.prepare(
        "UPDATE item_master SET weight_per_meter = weight_per_pipe WHERE weight_per_pipe IS NOT NULL AND weight_per_pipe > 0"
      ).run();
      const r2 = db.prepare(`
        UPDATE indent_items
           SET weight_per_meter = (SELECT im.weight_per_pipe FROM item_master im WHERE im.id = indent_items.item_master_id)
         WHERE item_master_id IN (SELECT id FROM item_master WHERE weight_per_pipe IS NOT NULL AND weight_per_pipe > 0)
      `).run();
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('pipe_wpm_full_weight_v1', '1')").run();
      console.log(`[migration] pipe weight_per_meter set to full pipe weight: ${r1.changes} items, ${r2.changes} indent lines`);
    }
  } catch (e) { console.error('[migration] pipe full-weight rebase failed:', e.message); }

  // Backfill CRM funnel requirements for EXISTING Extra indents (mam
  // 2026-06-06: "extra schedule not go into crm funnel"). Older Extra-
  // Schedule / Extra-Non-Schedule indents only entered the funnel on CRM
  // approval, so ones still pending CRM never showed. Create a funnel
  // "requirement" lead for every Extra indent that doesn't already have one
  // (deduped by source_indent_id / [auto-indent:<id>] marker), pulling client
  // data from the linked Business Book + the indent's item list. Also stamps
  // source_indent_id onto any legacy entry that was missing it. Runs once.
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='backfill_extra_crm_funnel_v1'").get();
    if (!done) {
      const { nextSequence } = require('./nextSequence');
      const sysId = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()?.id || null;
      const extras = db.prepare(`
        SELECT i.id, i.indent_number, i.site_name, i.client_name, i.indent_category, i.crm_status,
               bb.company_name AS bb_company, bb.client_name AS bb_client, bb.client_contact AS bb_mobile,
               COALESCE(NULLIF(TRIM(bb.client_email),''), NULLIF(TRIM(bb.email_address),'')) AS bb_email,
               bb.billing_address AS bb_address, bb.source_of_enquiry AS bb_source,
               bb.state AS bb_state, bb.district AS bb_district, bb.owner AS bb_owner
          FROM indents i
          LEFT JOIN order_planning op ON op.id = i.planning_id
          LEFT JOIN business_book bb ON bb.id = op.business_book_id
         WHERE i.indent_category IN ('extra_schedule','extra_non_schedule')
      `).all();
      let created = 0;
      for (const e of extras) {
        const marker = `[auto-indent:${e.id}]`;
        const exists = db.prepare('SELECT id FROM crm_funnel WHERE source_indent_id=? OR remarks LIKE ?').get(e.id, `%${marker}%`);
        if (exists) {
          db.prepare('UPDATE crm_funnel SET source_indent_id=? WHERE id=? AND (source_indent_id IS NULL OR source_indent_id=0)').run(e.id, exists.id);
          continue;
        }
        const reqItems = db.prepare('SELECT description, quantity, unit FROM indent_items WHERE indent_id=?').all(e.id);
        const reqText = reqItems.map(it => `${(+it.quantity || 0).toLocaleString('en-IN')}${it.unit ? ' ' + it.unit : ''} × ${it.description || 'item'}`).join('; ');
        const totalAmt = db.prepare('SELECT COALESCE(SUM(amount),0) t FROM indent_items WHERE indent_id=?').get(e.id).t;
        const clientName = String(e.bb_client || e.bb_company || e.client_name || e.site_name || 'Extra item').trim() || 'Extra item';
        const companyName = e.bb_company || e.bb_client || e.site_name || null;
        const approved = e.crm_status === 'approved';
        const leadNo = nextSequence(db, 'crm_funnel', 'lead_no', 'CRM-', { startFrom: 0, pad: 4 });
        db.prepare(
          `INSERT INTO crm_funnel
             (lead_no, client_name, company_name, mobile, email, source, address,
              state, district, remarks, category, type, lead_type, quotation_amount,
              requirement_items, source_indent_id, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          leadNo, clientName, companyName,
          e.bb_mobile || null, e.bb_email || null, e.bb_source || 'Extra Indent', e.bb_address || null,
          e.bb_state || null, e.bb_district || null,
          `Requirement from Extra indent ${e.indent_number || e.id} (${approved ? 'CRM approved' : 'awaiting CRM approval'})`
            + (e.bb_owner ? ` · owner ${e.bb_owner}` : '') + ` ${marker}`,
          e.indent_category, 'Extra Item', 'Extra Enquiry', +totalAmt || 0,
          reqText || null, e.id, sysId,
        );
        created++;
      }
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('backfill_extra_crm_funnel_v1', '1')").run();
      if (created > 0) console.log(`[migration] backfilled ${created} CRM funnel requirements from existing Extra indents`);
    }
  } catch (e) { console.error('[migration] extra CRM funnel backfill failed:', e.message); }

  // Fill blank client data on existing Extra-indent funnel leads by matching
  // the Business Book on company / client name (mam 2026-06-06: "client name,
  // mobile, district, state pick data from business book according to company
  // name"). Only touches auto Extra leads (source_indent_id set) that are
  // missing mobile or state. client_name is upgraded to the BB client name;
  // mobile / email / address / source / state / district fill where blank.
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='crm_funnel_bb_namematch_v1'").get();
    if (!done) {
      const rows = db.prepare(
        `SELECT id, client_name, company_name FROM crm_funnel
          WHERE source_indent_id IS NOT NULL
            AND (mobile IS NULL OR TRIM(mobile)='' OR state IS NULL OR TRIM(state)='')`
      ).all();
      const findBb = db.prepare(
        `SELECT bb.client_name, bb.company_name, bb.client_contact AS mobile,
                COALESCE(NULLIF(TRIM(bb.client_email),''), NULLIF(TRIM(bb.email_address),'')) AS email,
                bb.billing_address AS address, bb.source_of_enquiry AS source,
                bb.state, bb.district
           FROM business_book bb
          WHERE LOWER(TRIM(bb.company_name)) = LOWER(TRIM(?))
             OR LOWER(TRIM(bb.client_name))  = LOWER(TRIM(?))
          ORDER BY (bb.client_contact IS NOT NULL AND TRIM(bb.client_contact) <> '') DESC, bb.id DESC
          LIMIT 1`
      );
      const upd = db.prepare(
        `UPDATE crm_funnel SET
            client_name = COALESCE(NULLIF(TRIM(?),''), client_name),
            mobile      = COALESCE(NULLIF(TRIM(mobile),''), ?),
            email       = COALESCE(NULLIF(TRIM(email),''), ?),
            address     = COALESCE(NULLIF(TRIM(address),''), ?),
            source      = COALESCE(NULLIF(TRIM(source),''), ?),
            state       = COALESCE(NULLIF(TRIM(state),''), ?),
            district    = COALESCE(NULLIF(TRIM(district),''), ?),
            updated_at  = CURRENT_TIMESTAMP
          WHERE id = ?`
      );
      let fixed = 0;
      for (const r of rows) {
        const name = r.company_name || r.client_name;
        if (!name) continue;
        const bb = findBb.get(name, name);
        if (!bb) continue;
        upd.run(bb.client_name, bb.mobile, bb.email, bb.address, bb.source, bb.state, bb.district, r.id);
        fixed++;
      }
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('crm_funnel_bb_namematch_v1', '1')").run();
      if (fixed > 0) console.log(`[migration] filled BB client data on ${fixed} CRM funnel Extra leads by name match`);
    }
  } catch (e) { console.error('[migration] crm_funnel BB name-match failed:', e.message); }

  // RGP now approves like Material — L1 → L2 (mam 2026-06-06: "rgp approval
  // like as material l1,l2"). Convert still-pending RGP indents that are on
  // the old single-HR policy to two_level so they show the L1/L2 chain.
  // Already-approved / rejected ones are left as-is. Runs once.
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='rgp_to_two_level_v1'").get();
    if (!done) {
      const r = db.prepare(
        `UPDATE indents
            SET approval_policy = 'two_level',
                l1_status = CASE WHEN l1_status IS NULL THEN 'pending' ELSE l1_status END,
                l2_status = CASE WHEN l2_status IS NULL THEN 'pending' ELSE l2_status END
          WHERE indent_category = 'rgp'
            AND approval_policy = 'hr_single'
            AND status NOT IN ('approved','rejected','po_sent','dispatched','received')`
      ).run();
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('rgp_to_two_level_v1', '1')").run();
      if (r.changes > 0) console.log(`[migration] moved ${r.changes} pending RGP indents from HR-single to L1→L2`);
    }
  } catch (e) { console.error('[migration] RGP to two_level failed:', e.message); }

  // Fix blank descriptions on existing RGP gate-pass challans (mam 2026-06-06:
  // "i fill rgp item not showing here"). Early RGP challans stored items_json
  // from indent_items.description, which is empty for RGP (the name lives on
  // the Item Master). Rebuild items_json from the indent's RGP lines with the
  // master name / size / spec. Runs once.
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='fix_rgp_challan_desc_v1'").get();
    if (!done) {
      const challans = db.prepare("SELECT id, indent_id FROM delivery_notes WHERE source='rgp' AND indent_id IS NOT NULL").all();
      const itemStmt = db.prepare(
        `SELECT ii.quantity AS qty, ii.unit,
                COALESCE(NULLIF(TRIM(ii.description),''), NULLIF(TRIM(im.item_name),''), 'Item') AS name,
                im.size, im.specification, im.make, im.item_code
           FROM indent_items ii LEFT JOIN item_master im ON im.id = ii.item_master_id
          WHERE ii.indent_id=? AND UPPER(COALESCE(ii.item_type,''))='RGP' AND COALESCE(ii.quantity,0)>0`
      );
      let fixed = 0;
      for (const ch of challans) {
        const rows = itemStmt.all(ch.indent_id);
        if (!rows.length) continue;
        const items = rows.map(r => ({
          description: [r.name, r.size, r.specification].filter(Boolean).join(' / '),
          qty: +r.qty || 0, unit: r.unit || '', rate: 0, amount: 0,
          item_code: r.item_code || '', make: r.make || '', item_type: 'RGP',
        }));
        db.prepare('UPDATE delivery_notes SET items_json=? WHERE id=?').run(JSON.stringify(items), ch.id);
        fixed++;
      }
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('fix_rgp_challan_desc_v1', '1')").run();
      if (fixed > 0) console.log(`[migration] rebuilt descriptions on ${fixed} RGP gate-pass challans`);
    }
  } catch (e) { console.error('[migration] RGP challan desc rebuild failed:', e.message); }

  // Drop indents.status CHECK entirely (mam 2026-05-28: L1 Nitin Jain
  // hit "CHECK constraint failed: status IN (...)" on Approve L1).
  //
  // Root cause: original constraint listed
  //   ('draft','submitted','approved','rejected','po_sent','dispatched','received')
  // but the 2-level approval rollout added 'l1_approved' as an
  // intermediate state. SQLite can't ALTER a CHECK so existing DBs
  // hit the constraint the moment L1 fires. Strip the CHECK — the
  // route layer validates statuses, and dropping it also future-
  // proofs against any new states (e.g. 'l2_approved' if someone
  // ever wants the L2-only intermediate).
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='indents'").get();
    if (row && /CHECK\s*\(\s*status\s+IN/i.test(row.sql)) {
      console.log('[migration] ════════════════════════════════════════════');
      console.log('[migration] indents.status CHECK detected — rebuilding to drop CHECK');
      db.pragma('foreign_keys = OFF');
      try { db.exec('DROP TABLE IF EXISTS indents_new'); } catch (_) {}

      // Handle both `CREATE TABLE indents` and `CREATE TABLE "indents"`
      // shapes — SQLite normalises to the quoted form after a prior
      // rebuild, and our regex must catch either.
      const newSql = row.sql
        .replace(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(?:"indents"|indents)/i, 'CREATE TABLE indents_new')
        .replace(/,?\s*CHECK\s*\(\s*status\s+IN\s*\([^)]*\)\s*\)/i, '');
      if (newSql === row.sql || !/CREATE TABLE indents_new/.test(newSql)) {
        throw new Error('regex did not produce indents_new — sql shape unexpected:\n' + row.sql.slice(0, 200));
      }

      const cols = db.prepare('PRAGMA table_info(indents)').all().map(c => c.name);
      const colList = cols.map(c => `"${c}"`).join(', ');

      db.exec('BEGIN');
      db.exec(newSql);
      db.exec(`INSERT INTO indents_new (${colList}) SELECT ${colList} FROM indents`);
      db.exec('DROP TABLE indents');
      db.exec('ALTER TABLE indents_new RENAME TO indents');
      db.exec('COMMIT');
      db.pragma('foreign_keys = ON');

      const after = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='indents'").get();
      if (after && /CHECK\s*\(\s*status\s+IN/i.test(after.sql)) {
        throw new Error('verification failed — CHECK still present after rebuild');
      }
      console.log('[migration] ✓ indents.status CHECK removed — l1_approved now allowed');
      console.log('[migration] ════════════════════════════════════════════');
    } else if (row) {
      console.log('[migration] indents.status CHECK already gone — skipping');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    try { db.pragma('foreign_keys = ON'); } catch (_) {}
    console.error('[migration] ✗ indents.status CHECK drop FAILED:', e.message);
    console.error(e.stack);
  }

  // Relax attendance.status CHECK to allow 'short_day' (4-8 hours worked).
  // The punch-out code sets status='short_day' but the original CHECK
  // constraint omitted it, so existing DBs hit "CHECK constraint failed"
  // when an employee punched out with less than 8 hours. Same rebuild
  // pattern as payment_requests above; runs exactly once.
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='attendance'").get();
    if (row && !/short_day/.test(row.sql)) {
      try { db.exec('DROP TABLE IF EXISTS attendance_new'); } catch (_) {}
      db.exec('BEGIN');
      const newSql = row.sql
        // Same IF-NOT-EXISTS fix as payment_requests above.
        .replace(/CREATE TABLE(\s+IF NOT EXISTS)?\s+attendance/i, 'CREATE TABLE attendance_new')
        .replace(/CHECK\s*\(\s*status\s+IN\s*\([^)]*\)\s*\)/i,
                 "CHECK(status IN ('present','half_day','short_day','absent','late','leave','holiday'))");
      db.exec(newSql);
      db.exec('INSERT INTO attendance_new SELECT * FROM attendance');
      db.exec('DROP TABLE attendance');
      db.exec('ALTER TABLE attendance_new RENAME TO attendance');
      db.exec('COMMIT');
      console.log('[migration] attendance.status CHECK relaxed to allow short_day');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) {}
    console.error('[migration] attendance CHECK relax failed:', e.message);
  }

  // Relax leave_requests.leave_type CHECK to include 'short_leave'.
  // The Apply for Leave form on mobile sends leave_type='short_leave' for
  // hour-based leave requests, but the original CHECK constraint listed
  // only ('casual','sick','earned','half_day','comp_off') — so existing
  // production DBs threw "CHECK constraint failed" when users tried to
  // submit a short leave. Same table-rebuild pattern as attendance above.
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='leave_requests'").get();
    if (row && !/short_leave/.test(row.sql)) {
      try { db.exec('DROP TABLE IF EXISTS leave_requests_new'); } catch (_) {}
      db.exec('BEGIN');
      const newSql = row.sql
        // Same IF-NOT-EXISTS fix as the migrations above.
        .replace(/CREATE TABLE(\s+IF NOT EXISTS)?\s+leave_requests/i, 'CREATE TABLE leave_requests_new')
        .replace(/CHECK\s*\(\s*leave_type\s+IN\s*\([^)]*\)\s*\)/i,
                 "CHECK(leave_type IN ('casual','sick','earned','half_day','short_leave','comp_off'))");
      db.exec(newSql);
      // Copy ONLY the columns that exist in the OLD table to be safe.
      const oldCols = db.prepare("PRAGMA table_info(leave_requests)").all().map(c => c.name);
      const newCols = db.prepare("PRAGMA table_info(leave_requests_new)").all().map(c => c.name);
      const shared = oldCols.filter(c => newCols.includes(c)).join(', ');
      db.exec(`INSERT INTO leave_requests_new (${shared}) SELECT ${shared} FROM leave_requests`);
      db.exec('DROP TABLE leave_requests');
      db.exec('ALTER TABLE leave_requests_new RENAME TO leave_requests');
      db.exec('COMMIT');
      console.log('[migration] leave_requests.leave_type CHECK relaxed to allow short_leave');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) {}
    console.error('[migration] leave_requests CHECK relax failed:', e.message);
  }

  // Relax indents.status CHECK to allow 'l1_approved' — the intermediate
  // state when Nitin Jain ji has approved L1 but Nitin Sir's L2 sign-off
  // is still pending. Same rebuild pattern as attendance / leave above.
  //
  // Mam 2026-05-28 follow-up: the migration earlier in this file now
  // STRIPS the CHECK entirely, so the table no longer has any status
  // CHECK at all on freshly-migrated DBs. Guard this block with an
  // extra "CHECK still present" condition so it doesn't keep firing
  // on every boot and barfing 'table indents already exists' (the
  // regex below doesn't handle the quoted "indents" form).
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='indents'").get();
    if (row && /CHECK\s*\(\s*status\s+IN/i.test(row.sql) && !/l1_approved/.test(row.sql)) {
      db.exec('BEGIN');
      const newSql = row.sql
        .replace(/CREATE TABLE\s+indents/i, 'CREATE TABLE indents_new')
        .replace(/CHECK\s*\(\s*status\s+IN\s*\([^)]*\)\s*\)/i,
                 "CHECK(status IN ('draft','submitted','l1_approved','approved','rejected','po_sent','dispatched','received'))");
      db.exec(newSql);
      const oldCols = db.prepare("PRAGMA table_info(indents)").all().map(c => c.name);
      const newCols = db.prepare("PRAGMA table_info(indents_new)").all().map(c => c.name);
      const shared = oldCols.filter(c => newCols.includes(c)).join(', ');
      db.exec(`INSERT INTO indents_new (${shared}) SELECT ${shared} FROM indents`);
      db.exec('DROP TABLE indents');
      db.exec('ALTER TABLE indents_new RENAME TO indents');
      db.exec('COMMIT');
      console.log('[migration] indents.status CHECK relaxed to allow l1_approved (2-level approval)');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) {}
    console.error('[migration] indents CHECK relax failed:', e.message);
  }

  for (const [table, col] of migrations) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch (e) {}
  }

  // Manpower Plan — admin override of the auto (value-slab) required manpower
  // per project (mam 2026-06-12: "admin wants to edit required manpower").
  // Keyed by the normalized project key the manpower-plan endpoint groups by.
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS manpower_required_overrides (
      project_key TEXT PRIMARY KEY,
      required    INTEGER NOT NULL,
      updated_by  INTEGER REFERENCES users(id),
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (e) { console.error('[schema] manpower_required_overrides create failed:', e.message); }

  // Manpower Plan per-project settings (mam 2026-06-12): a project CATEGORY
  // (Live / Old / Service Team / Handover) plus the required-manpower override.
  // Handover ⇒ no team required, no planning (required forced to 0).
  // Supersedes manpower_required_overrides; old overrides are backfilled.
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS manpower_project_settings (
      project_key       TEXT PRIMARY KEY,
      required_override INTEGER,
      category          TEXT,
      updated_by        INTEGER REFERENCES users(id),
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    try {
      db.exec(`INSERT OR IGNORE INTO manpower_project_settings (project_key, required_override)
               SELECT project_key, required FROM manpower_required_overrides`);
    } catch (_) { /* old table may not exist */ }
    // Mam (2026-06-12): "Old" category renamed to "Hold".
    try { db.exec(`UPDATE manpower_project_settings SET category='Hold' WHERE category='Old'`); } catch (_) {}
    // Mam (2026-06-13): also plan Site Engineers / Jr. Site Engineers per
    // project — required comes from a value slab, but allow an admin override
    // of each, same as required manpower.
    // Contractor attendance photo (mam 2026-06-22): per-contractor site photo,
    // people auto-counted by AI to fill the manpower count. Guarded for DBs
    // whose contractor_attendance table was created before this column existed.
    try { db.exec(`ALTER TABLE contractor_attendance ADD COLUMN photo_url TEXT`); } catch (_) {}
    try { db.exec(`ALTER TABLE manpower_project_settings ADD COLUMN site_eng_override INTEGER`); } catch (_) {}
    try { db.exec(`ALTER TABLE manpower_project_settings ADD COLUMN jr_site_eng_override INTEGER`); } catch (_) {}
    try { db.exec(`ALTER TABLE manpower_project_settings ADD COLUMN foreman_override INTEGER`); } catch (_) {}
    // mam 2026-06-30: when the approver edits a line's UOM at approval, mark it so
    // downstream views show THAT unit (Vendor Rates etc.) instead of the master UOM.
    try { db.exec(`ALTER TABLE indent_items ADD COLUMN unit_overridden INTEGER DEFAULT 0`); } catch (_) {}
    // One-time backfill: existing rows whose line UOM already differs from the
    // master UOM were edited deliberately (e.g. IND-0172 mtr→KG), so flag them so
    // the edit shows immediately. Guarded so it runs exactly once.
    try {
      const done = db.prepare("SELECT value FROM app_settings WHERE key='unit_overridden_backfill_v1'").get();
      if (!done) {
        const norm = (expr) => `(CASE LOWER(TRIM(${expr}))
            WHEN 'metre' THEN 'mtr' WHEN 'metres' THEN 'mtr' WHEN 'meter' THEN 'mtr' WHEN 'meters' THEN 'mtr' WHEN 'mtrs' THEN 'mtr' WHEN 'mt' THEN 'mtr' WHEN 'm' THEN 'mtr'
            WHEN 'each' THEN 'nos' WHEN 'piece' THEN 'nos' WHEN 'pieces' THEN 'nos' WHEN 'pcs' THEN 'nos' WHEN 'pc' THEN 'nos' WHEN 'no' THEN 'nos' WHEN 'nos.' THEN 'nos'
            ELSE LOWER(TRIM(${expr})) END)`;
        const mUom = `(SELECT uom FROM item_master WHERE id = indent_items.item_master_id)`;
        db.exec(`UPDATE indent_items SET unit_overridden = 1
           WHERE COALESCE(unit_overridden,0) = 0 AND item_master_id IS NOT NULL
             AND TRIM(COALESCE(unit,'')) <> ''
             AND TRIM(COALESCE(${mUom},'')) <> ''
             AND ${norm('unit')} <> ${norm(mUom)}`);
        db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('unit_overridden_backfill_v1','done')").run();
      }
    } catch (_) {}
  } catch (e) { console.error('[schema] manpower_project_settings create failed:', e.message); }

  // Retention: GPS pings accumulate every 30s per user and were never purged
  // (audit 2026-06-12).  Drop pings older than 60 days on each boot so the
  // table — and the admin live-map self-join over it — stays fast.
  try { db.exec(`DELETE FROM location_tracking WHERE date < date('now','-60 days')`); } catch (_) {}

  // ─── KPI scorecards for the 5 team leads (mam 2026-07-01, from kpi.pdf) ───
  // Each was showing "no template" (0%) on the Scorecard. Build one template per
  // person holding EXACTLY the KPIs on their one-pager, plus the standard Basic
  // auto set (so they get a live baseline instead of a flat 0) and the RACI
  // Responsibility row every template carries. Weights sum to 100; directions
  // match each metric (faster/lower-backlog = lower_better). Two KPIs map to a
  // real auto source that already feeds their card — ERP tickets → auto:tickets
  // (Nitin's card shows "7 tickets, 0 closed"), RA bills → auto:ra_bills. The
  // rest are weekly manual entries. Guarded (runs once). Safe: skips a template
  // that already exists, matches the user case-insensitively (exact, else a
  // UNIQUE first-name match), and ASSIGNS ONLY when the user has no template yet
  // (DO NOTHING) so an already-scored person — e.g. Aanchal at 32% — is never
  // reset. Templates are still created even if no user matches, so they can be
  // assigned from the Scorecard screen.
  try {
    const kdone = db.prepare("SELECT value FROM app_settings WHERE key='kpi_cards_seed_v1'").get();
    if (!kdone) {
      const BASIC = [
        { m: 'Checklist',   w: 5, dir: 'higher_better', src: 'auto:checklists' },
        { m: 'PMS',         w: 5, dir: 'higher_better', src: 'auto:pms' },
        { m: 'Help Ticket', w: 5, dir: 'higher_better', src: 'auto:tickets' },
      ];
      const RACI = { m: 'RACI Steps (All Modules)', w: 0, dir: 'higher_better', src: 'auto:raci_steps_done' };
      const PEOPLE = [
        { user: 'Rajat Sharma', tpl: 'Rajat Sharma — Sales Head', desc: 'Owns: turning leads into orders',
          basic: BASIC, weekly: [
            { m: 'Lead → quote conversion',              w: 17, dir: 'higher_better', src: 'manual' },
            { m: 'Quote → order win rate',               w: 17, dir: 'higher_better', src: 'manual' },
            { m: 'Pipeline value live in CRM',           w: 17, dir: 'higher_better', src: 'manual' },
            { m: 'Every quote followed up within 48 hrs', w: 17, dir: 'higher_better', src: 'manual' },
            { m: 'New orders booked (₹)',                w: 17, dir: 'higher_better', src: 'manual' },
          ] },
        { user: 'Shubham Sharma', tpl: 'Shubham Sharma — Costing / Estimation', desc: 'Owns: accurate quotes, fast',
          basic: BASIC, weekly: [
            { m: 'Time-to-quote (enquiry → quote)',      w: 17, dir: 'lower_better',  src: 'manual' },
            { m: 'Quotes delivered on time',             w: 17, dir: 'higher_better', src: 'manual' },
            { m: 'Quote backlog older than 72 hrs',      w: 17, dir: 'lower_better',  src: 'manual' },
            { m: 'Estimation accuracy (quoted vs actual)', w: 17, dir: 'higher_better', src: 'manual' },
            { m: 'Win rate on quotes submitted',         w: 17, dir: 'higher_better', src: 'manual' },
          ] },
        { user: 'Nitin Jain', tpl: 'Nitin Jain — Operations · Purchase · Store', desc: 'Owns: on-time, on-budget delivery',
          basic: [BASIC[0], BASIC[1]],   // tickets is a main KPI below — don't double-count
          weekly: [
            { m: 'Project milestones delivered on time',   w: 18, dir: 'higher_better', src: 'manual' },
            { m: 'Material on site — zero stockout delays', w: 18, dir: 'higher_better', src: 'manual' },
            { m: 'PO cycle time (indent → PO)',            w: 18, dir: 'lower_better',  src: 'manual' },
            { m: 'Purchase price vs estimate variance',    w: 18, dir: 'lower_better',  src: 'manual' },
            { m: 'ERP tickets closed (not left open)',     w: 18, dir: 'higher_better', src: 'auto:tickets' },
          ] },
        { user: 'Parul Goyal', tpl: 'Parul Goyal — Billing Engineer', desc: 'Owns: turning work into invoices',
          basic: BASIC, weekly: [
            { m: 'Billing cycle (work done → invoice)', w: 22, dir: 'lower_better',  src: 'manual' },
            { m: 'RA bills raised on time',             w: 21, dir: 'higher_better', src: 'auto:ra_bills' },
            { m: 'Unbilled work-in-progress (₹)',       w: 21, dir: 'lower_better',  src: 'manual' },
            { m: 'Invoice dispute / rejection rate',    w: 21, dir: 'lower_better',  src: 'manual' },
          ] },
        { user: 'Aanchal', tpl: 'Aanchal — Collections Executive', desc: 'Owns: money in the bank',
          basic: BASIC, weekly: [
            { m: 'DSO (days to get paid)',                 w: 22, dir: 'lower_better',  src: 'manual' },
            { m: 'Collection efficiency (collected ÷ due)', w: 21, dir: 'higher_better', src: 'manual' },
            { m: 'Overdue > 90 days (₹)',                  w: 21, dir: 'lower_better',  src: 'manual' },
            { m: 'Every overdue account followed up',      w: 21, dir: 'higher_better', src: 'manual' },
          ] },
      ];
      const findTpl  = db.prepare('SELECT id FROM score_templates WHERE name = ?');
      const insTpl   = db.prepare('INSERT INTO score_templates (name, description, active) VALUES (?, ?, 1)');
      const insKpi   = db.prepare('INSERT INTO score_kpis (template_id, group_name, metric_name, weightage, direction, data_source, display_order, active, default_planned) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)');
      const findUser = db.prepare('SELECT id FROM users WHERE active = 1 AND LOWER(TRIM(name)) = LOWER(TRIM(?))');
      const findLike = db.prepare("SELECT id FROM users WHERE active = 1 AND LOWER(TRIM(name)) LIKE LOWER(?)");
      const assign   = db.prepare('INSERT INTO score_user_template (user_id, template_id, assigned_by) VALUES (?, ?, 1) ON CONFLICT(user_id) DO NOTHING');
      let made = 0, assigned = 0;
      for (const p of PEOPLE) {
        let t = findTpl.get(p.tpl);
        let tid;
        if (t) { tid = t.id; }
        else {
          tid = insTpl.run(p.tpl, p.desc).lastInsertRowid;
          let ord = 0;
          for (const k of p.basic)  insKpi.run(tid, 'Basic', k.m, k.w, k.dir, k.src, ord++);
          for (const k of p.weekly) insKpi.run(tid, 'Weekly', k.m, k.w, k.dir, k.src, ord++);
          insKpi.run(tid, 'Responsibility', RACI.m, RACI.w, RACI.dir, RACI.src, ord++);
          made++;
        }
        let u = findUser.get(p.user);
        if (!u) {
          const cands = findLike.all(p.user.split(' ')[0] + '%');
          if (cands.length === 1) u = cands[0];
        }
        if (u) { const r = assign.run(u.id, tid); if (r.changes) assigned++; }
      }
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('kpi_cards_seed_v1', 'done')").run();
      console.log(`[schema] kpi_cards_seed_v1: ${made} templates created, ${assigned} users assigned`);
    }
  } catch (e) { console.error('[schema] kpi_cards_seed_v1 failed:', e.message); }

  // ─── KPI scorecards v2 (mam 2026-07-01, from kpi2.pdf: "add more") ────────
  // Two NEW roles (Durgesh Sharma — AI Marketing Head, Prabhdeep Singh — HR Head)
  // + extra KPIs appended to the people seeded in v1 (Shubham = "sustain", none).
  // The score engine normalises by total weight (score = Σ w·pct / Σ w, see
  // scoring.js), so appended KPIs need NOT re-sum the template to 100. Guarded;
  // re-safe (skips a template / metric that already exists). Runs AFTER v1 so the
  // v1 templates exist to append to.
  try {
    const k2done = db.prepare("SELECT value FROM app_settings WHERE key='kpi_cards_seed_v2'").get();
    if (!k2done) {
      const BASIC = [
        { m: 'Checklist',   w: 5, dir: 'higher_better', src: 'auto:checklists' },
        { m: 'PMS',         w: 5, dir: 'higher_better', src: 'auto:pms' },
        { m: 'Help Ticket', w: 5, dir: 'higher_better', src: 'auto:tickets' },
      ];
      const RACI = { m: 'RACI Steps (All Modules)', w: 0, dir: 'higher_better', src: 'auto:raci_steps_done' };
      // (a) two brand-new people — full templates like v1
      const NEW_PEOPLE = [
        { user: 'Durgesh Sharma', tpl: 'Durgesh Sharma — AI Marketing Head', desc: 'Fills the funnel', weekly: [
          { m: 'Qualified leads generated',             w: 17, dir: 'higher_better', src: 'manual' },
          { m: 'Cost per qualified lead',               w: 17, dir: 'lower_better',  src: 'manual' },
          { m: 'Lead response time',                    w: 17, dir: 'lower_better',  src: 'manual' },
          { m: 'Calculator → enquiry conversion',       w: 17, dir: 'higher_better', src: 'manual' },
          { m: 'Maintain live sales pipeline (₹45 Cr)', w: 17, dir: 'higher_better', src: 'manual' },
        ] },
        { user: 'Prabhdeep Singh', tpl: 'Prabhdeep Singh — HR Head', desc: 'Keeps the engine staffed', weekly: [
          { m: 'Critical roles filled (time-to-hire)',  w: 17, dir: 'lower_better',  src: 'manual' },
          { m: 'Site manpower fill vs plan',            w: 17, dir: 'higher_better', src: 'manual' },
          { m: 'Weekly scorecard reviews done',         w: 17, dir: 'higher_better', src: 'manual' },
          { m: 'Attrition (site talent)',               w: 17, dir: 'lower_better',  src: 'manual' },
          { m: 'Daily DPR profit + DPR collection',     w: 17, dir: 'higher_better', src: 'manual' },
        ] },
      ];
      // (b) extra KPIs appended to existing v1 templates
      const ADD = [
        { tpl: 'Rajat Sharma — Sales Head', kpis: [
          { m: 'Throughput margin maintained', w: 15, dir: 'higher_better', src: 'manual' } ] },
        { tpl: 'Nitin Jain — Operations · Purchase · Store', kpis: [
          { m: 'Full kitting before site start',    w: 15, dir: 'higher_better', src: 'manual' },
          { m: 'Weekly planning (bar chart) → DPR', w: 15, dir: 'higher_better', src: 'manual' } ] },
        { tpl: 'Parul Goyal — Billing Engineer', kpis: [
          { m: 'DPR → billing on time', w: 15, dir: 'higher_better', src: 'manual' } ] },
        { tpl: 'Aanchal — Collections Executive', kpis: [
          { m: 'Expense control + cash-flow sheet', w: 15, dir: 'higher_better', src: 'manual' } ] },
      ];
      const findTpl  = db.prepare('SELECT id FROM score_templates WHERE name = ?');
      const insTpl   = db.prepare('INSERT INTO score_templates (name, description, active) VALUES (?, ?, 1)');
      const insKpi   = db.prepare('INSERT INTO score_kpis (template_id, group_name, metric_name, weightage, direction, data_source, display_order, active, default_planned) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)');
      const maxOrd   = db.prepare('SELECT COALESCE(MAX(display_order), -1) AS m FROM score_kpis WHERE template_id = ?');
      const hasKpi   = db.prepare('SELECT 1 FROM score_kpis WHERE template_id = ? AND metric_name = ?');
      const findUser = db.prepare('SELECT id FROM users WHERE active = 1 AND LOWER(TRIM(name)) = LOWER(TRIM(?))');
      const findLike = db.prepare("SELECT id FROM users WHERE active = 1 AND LOWER(TRIM(name)) LIKE LOWER(?)");
      const assign   = db.prepare('INSERT INTO score_user_template (user_id, template_id, assigned_by) VALUES (?, ?, 1) ON CONFLICT(user_id) DO NOTHING');
      let made = 0, appended = 0, assigned = 0;
      for (const p of NEW_PEOPLE) {
        let t = findTpl.get(p.tpl); let tid;
        if (t) { tid = t.id; }
        else {
          tid = insTpl.run(p.tpl, p.desc).lastInsertRowid;
          let ord = 0;
          for (const k of BASIC)    insKpi.run(tid, 'Basic', k.m, k.w, k.dir, k.src, ord++);
          for (const k of p.weekly) insKpi.run(tid, 'Weekly', k.m, k.w, k.dir, k.src, ord++);
          insKpi.run(tid, 'Responsibility', RACI.m, RACI.w, RACI.dir, RACI.src, ord++);
          made++;
        }
        let u = findUser.get(p.user);
        if (!u) { const c = findLike.all(p.user.split(' ')[0] + '%'); if (c.length === 1) u = c[0]; }
        if (u) { const r = assign.run(u.id, tid); if (r.changes) assigned++; }
      }
      for (const a of ADD) {
        const t = findTpl.get(a.tpl);
        if (!t) continue;
        let ord = maxOrd.get(t.id).m + 1;
        for (const k of a.kpis) {
          if (hasKpi.get(t.id, k.m)) continue;
          insKpi.run(t.id, 'Weekly', k.m, k.w, k.dir, k.src, ord++);
          appended++;
        }
      }
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('kpi_cards_seed_v2', 'done')").run();
      console.log(`[schema] kpi_cards_seed_v2: ${made} new templates, ${appended} KPIs appended, ${assigned} users assigned`);
    }
  } catch (e) { console.error('[schema] kpi_cards_seed_v2 failed:', e.message); }

  // ─── KPI auto-sources v3 (mam 2026-07-01: "weekwise score auto — plan give,
  //     you find the actual") ─────────────────────────────────────────────────
  // Wire the KPIs that HAVE a matching live ERP feed from manual → auto:* so the
  // weekly ACTUAL is pulled from the ERP automatically every week and the score
  // updates on its own — mam only sets the PLAN / target. The score engine
  // recomputes auto:* rows live on every scorecard view (see scoring.js
  // computeAutoCount), so nothing needs to be entered by hand for these.
  // Only rows whose source is the one each person actually OWNS are wired
  // (user-scoped feeds for Rajat/Durgesh/Aanchal, company-wide for the process
  // owner). Pure ratio/time KPIs with NO ERP feed (time-to-quote, estimation
  // accuracy %, DSO days, invoice dispute %, attrition, …) stay manual by design
  // — the ERP doesn't record those numbers, so they need a weekly entry.
  // Guarded; only flips rows still on 'manual' (never clobbers a hand-set one).
  try {
    const k3done = db.prepare("SELECT value FROM app_settings WHERE key='kpi_auto_sources_v3'").get();
    if (!k3done) {
      const AUTO = [
        ['Rajat Sharma — Sales Head',                'New orders booked (₹)',                  'auto:bb_sale_amount'],
        ['Durgesh Sharma — AI Marketing Head',       'Qualified leads generated',              'auto:leads_qualified'],
        ['Prabhdeep Singh — HR Head',                'Critical roles filled (time-to-hire)',   'auto:candidates_onboarded'],
        ['Aanchal — Collections Executive',          'Collection efficiency (collected ÷ due)', 'auto:amount_received_lakh'],
        ['Aanchal — Collections Executive',          'Overdue > 90 days (₹)',                  'auto:receivables_outstanding_cr'],
        ['Aanchal — Collections Executive',          'Every overdue account followed up',      'auto:collections_count'],
        ['Nitin Jain — Operations · Purchase · Store', 'Full kitting before site start',       'auto:items_complete'],
      ];
      const upd = db.prepare(
        `UPDATE score_kpis SET data_source = ?
          WHERE metric_name = ? AND data_source = 'manual'
            AND template_id = (SELECT id FROM score_templates WHERE name = ?)`
      );
      let wired = 0;
      for (const [tpl, metric, src] of AUTO) wired += upd.run(src, metric, tpl).changes;
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('kpi_auto_sources_v3', 'done')").run();
      console.log(`[schema] kpi_auto_sources_v3: ${wired} KPIs wired to live ERP feeds`);
    }
  } catch (e) { console.error('[schema] kpi_auto_sources_v3 failed:', e.message); }

  // ─── Force the 7 KPI-card people onto their NEW templates (mam 2026-07-01:
  //     "scorecard not changed to my requirement") ─────────────────────────────
  // v1's assignment used ON CONFLICT DO NOTHING to avoid resetting an already-
  // scored person — but that ALSO meant anyone who already had an OLD template
  // (e.g. Aanchal on the old "Finance Executive") was left on it, so their
  // scorecard still showed the old KPIs. mam wants the new cards live, so
  // REASSIGN each of the 7 to their kpi.pdf/kpi2.pdf template (DO UPDATE now
  // overrides the old link). Matches by name (exact, else a UNIQUE first-name);
  // skips anyone not found. Guarded; runs once.
  try {
    const rdone = db.prepare("SELECT value FROM app_settings WHERE key='kpi_cards_reassign_v1'").get();
    if (!rdone) {
      const MAP = [
        ['Rajat Sharma',    'Rajat Sharma — Sales Head'],
        ['Shubham Sharma',  'Shubham Sharma — Costing / Estimation'],
        ['Nitin Jain',      'Nitin Jain — Operations · Purchase · Store'],
        ['Parul Goyal',     'Parul Goyal — Billing Engineer'],
        ['Aanchal',         'Aanchal — Collections Executive'],
        ['Durgesh Sharma',  'Durgesh Sharma — AI Marketing Head'],
        ['Prabhdeep Singh', 'Prabhdeep Singh — HR Head'],
      ];
      const findTpl  = db.prepare('SELECT id FROM score_templates WHERE name = ?');
      const findUser = db.prepare('SELECT id FROM users WHERE active = 1 AND LOWER(TRIM(name)) = LOWER(TRIM(?))');
      const findLike = db.prepare("SELECT id FROM users WHERE active = 1 AND LOWER(TRIM(name)) LIKE LOWER(?)");
      const assign   = db.prepare(
        `INSERT INTO score_user_template (user_id, template_id, assigned_by) VALUES (?, ?, 1)
         ON CONFLICT(user_id) DO UPDATE SET template_id=excluded.template_id, assigned_at=CURRENT_TIMESTAMP, assigned_by=excluded.assigned_by`
      );
      let n = 0;
      for (const [nm, tpl] of MAP) {
        const t = findTpl.get(tpl);
        if (!t) continue;
        let u = findUser.get(nm);
        if (!u) { const c = findLike.all(nm.split(' ')[0] + '%'); if (c.length === 1) u = c[0]; }
        if (u) { assign.run(u.id, t.id); n++; }
      }
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('kpi_cards_reassign_v1', 'done')").run();
      console.log(`[schema] kpi_cards_reassign_v1: reassigned ${n}/7 people to their new KPI templates`);
    }
  } catch (e) { console.error('[schema] kpi_cards_reassign_v1 failed:', e.message); }

  // ─── Fill starting TARGETS + this-week sample ACTUALS (mam 2026-07-01:
  //     "fill data" — scorecard was stuck at 0 because targets were unset) ─────
  // The score is ACTUAL-vs-PLAN, so a KPI with plan=0 shows 0% no matter what.
  // This sets a sensible weekly target (default_planned) on every KPI, and for
  // the MANUAL KPIs writes a this-week score_entry with a realistic sample actual
  // so the scorecard shows populated, non-zero numbers out of the box. AUTO KPIs
  // get only the target — their actual is pulled live from the ERP. These are
  // STARTING values mam replaces with her real targets / weekly numbers. Matches
  // people by name; guarded → runs once; fills the deploy week only.
  try {
    const fdone = db.prepare("SELECT value FROM app_settings WHERE key='kpi_fill_data_v1'").get();
    if (!fdone) {
      const now = new Date();
      const mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // this week's Monday (local)
      const WEEK = `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, '0')}-${String(mon.getDate()).padStart(2, '0')}`;
      // [template, user, [{ m, plan, actual }]]  actual=null → AUTO KPI (set target only, ERP fills actual)
      const DATA = [
        ['Rajat Sharma — Sales Head', 'Rajat Sharma', [
          { m: 'Lead → quote conversion', plan: 40, actual: 42 },
          { m: 'Quote → order win rate', plan: 30, actual: 28 },
          { m: 'Pipeline value live in CRM', plan: 500, actual: 520 },
          { m: 'Every quote followed up within 48 hrs', plan: 100, actual: 95 },
          { m: 'New orders booked (₹)', plan: 2000000, actual: null },
          { m: 'Throughput margin maintained', plan: 20, actual: 21 },
        ]],
        ['Shubham Sharma — Costing / Estimation', 'Shubham Sharma', [
          { m: 'Time-to-quote (enquiry → quote)', plan: 2, actual: 1.8 },
          { m: 'Quotes delivered on time', plan: 95, actual: 93 },
          { m: 'Quote backlog older than 72 hrs', plan: 2, actual: 1 },
          { m: 'Estimation accuracy (quoted vs actual)', plan: 92, actual: 91 },
          { m: 'Win rate on quotes submitted', plan: 30, actual: 32 },
        ]],
        ['Nitin Jain — Operations · Purchase · Store', 'Nitin Jain', [
          { m: 'Project milestones delivered on time', plan: 90, actual: 88 },
          { m: 'Material on site — zero stockout delays', plan: 100, actual: 96 },
          { m: 'PO cycle time (indent → PO)', plan: 3, actual: 2.7 },
          { m: 'Purchase price vs estimate variance', plan: 5, actual: 4 },
          { m: 'ERP tickets closed (not left open)', plan: null, actual: null },
          { m: 'Full kitting before site start', plan: null, actual: null },
          { m: 'Weekly planning (bar chart) → DPR', plan: null, actual: null },
        ]],
        ['Parul Goyal — Billing Engineer', 'Parul Goyal', [
          { m: 'Billing cycle (work done → invoice)', plan: 3, actual: 2.7 },
          { m: 'RA bills raised on time', plan: 5, actual: null },
          { m: 'Unbilled work-in-progress (₹)', plan: 500000, actual: 420000 },
          { m: 'Invoice dispute / rejection rate', plan: 5, actual: 3 },
          { m: 'DPR → billing on time', plan: 95, actual: 93 },
        ]],
        ['Aanchal — Collections Executive', 'Aanchal', [
          { m: 'DSO (days to get paid)', plan: 45, actual: 43 },
          { m: 'Collection efficiency (collected ÷ due)', plan: 5, actual: null },
          { m: 'Overdue > 90 days (₹)', plan: 1, actual: null },
          { m: 'Every overdue account followed up', plan: 10, actual: null },
          { m: 'Expense control + cash-flow sheet', plan: 100, actual: 98 },
        ]],
        ['Durgesh Sharma — AI Marketing Head', 'Durgesh Sharma', [
          { m: 'Qualified leads generated', plan: 10, actual: null },
          { m: 'Cost per qualified lead', plan: 500, actual: 480 },
          { m: 'Lead response time', plan: 4, actual: 3.5 },
          { m: 'Calculator → enquiry conversion', plan: 20, actual: 22 },
          { m: 'Maintain live sales pipeline (₹45 Cr)', plan: 45, actual: 46 },
        ]],
        ['Prabhdeep Singh — HR Head', 'Prabhdeep Singh', [
          { m: 'Critical roles filled (time-to-hire)', plan: 2, actual: null },
          { m: 'Site manpower fill vs plan', plan: 95, actual: 93 },
          { m: 'Weekly scorecard reviews done', plan: 7, actual: 7 },
          { m: 'Attrition (site talent)', plan: 5, actual: 4 },
          { m: 'Daily DPR profit + DPR collection', plan: 100, actual: 100 },
        ]],
      ];
      const findTpl = db.prepare('SELECT id FROM score_templates WHERE name = ?');
      const findKpi = db.prepare('SELECT id, direction FROM score_kpis WHERE template_id = ? AND metric_name = ?');
      const setPlan = db.prepare('UPDATE score_kpis SET default_planned = ? WHERE id = ?');
      const findUser = db.prepare('SELECT id FROM users WHERE active = 1 AND LOWER(TRIM(name)) = LOWER(TRIM(?))');
      const findLike = db.prepare("SELECT id FROM users WHERE active = 1 AND LOWER(TRIM(name)) LIKE LOWER(?)");
      const upEntry = db.prepare(
        `INSERT INTO score_entries (user_id, kpi_id, week_start, planned, actual, actual_pct, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, kpi_id, week_start) DO UPDATE SET
           planned=excluded.planned, actual=excluded.actual, actual_pct=excluded.actual_pct, updated_at=CURRENT_TIMESTAMP`
      );
      let plansSet = 0, entries = 0;
      for (const [tpl, uname, kpis] of DATA) {
        const t = findTpl.get(tpl); if (!t) continue;
        let u = findUser.get(uname);
        if (!u) { const c = findLike.all(uname.split(' ')[0] + '%'); if (c.length === 1) u = c[0]; }
        for (const k of kpis) {
          const row = findKpi.get(t.id, k.m); if (!row) continue;
          if (k.plan != null) { setPlan.run(k.plan, row.id); plansSet++; }
          // NOTE: actuals are NOT filled here — they are FETCHED live from the ERP
          // by the auto:* data sources (mam 2026-07-01: "you know where to fetch the
          // number"). Only the target/plan is seeded; the actual comes from data.
        }
      }
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('kpi_fill_data_v1', 'done')").run();
      void WEEK; void upEntry; void findUser; void entries;   // retained refs, no longer used to write sample data
      console.log(`[schema] kpi_fill_data_v1: ${plansSet} targets set (actuals fetched live from ERP)`);
    }
  } catch (e) { console.error('[schema] kpi_fill_data_v1 failed:', e.message); }

  // ─── Wire more KPIs to REAL ERP feeds (mam 2026-07-01: "you know where to
  //     fetch the number" — don't fill by hand) ────────────────────────────────
  // New compute sources were added in scoring.js (pipeline value, throughput
  // margin, PO cycle time, DSO, lead→quote conversion, lead response time,
  // DPR→billing). Point the matching KPIs at them and set the target in the SAME
  // UNIT the source returns (Cr, %, days, hours). Guarded; runs once.
  try {
    const w6 = db.prepare("SELECT value FROM app_settings WHERE key='kpi_auto_sources_v6'").get();
    if (!w6) {
      const MAP = [
        // [template, metric, source, target-in-source-unit]
        ['Rajat Sharma — Sales Head', 'Pipeline value live in CRM', 'auto:pipeline_value_cr', 10],
        ['Rajat Sharma — Sales Head', 'Throughput margin maintained', 'auto:throughput_margin', 20],
        ['Rajat Sharma — Sales Head', 'Lead → quote conversion', 'auto:lead_quote_conversion', 40],
        ['Nitin Jain — Operations · Purchase · Store', 'PO cycle time (indent → PO)', 'auto:po_cycle_days', 3],
        ['Aanchal — Collections Executive', 'DSO (days to get paid)', 'auto:dso_days', 45],
        ['Durgesh Sharma — AI Marketing Head', 'Lead response time', 'auto:lead_response_hours', 4],
        ['Durgesh Sharma — AI Marketing Head', 'Maintain live sales pipeline (₹45 Cr)', 'auto:pipeline_value_cr', 45],
        ['Parul Goyal — Billing Engineer', 'DPR → billing on time', 'auto:dpr_billed_pct', 95],
        ['Shubham Sharma — Costing / Estimation', 'Time-to-quote (enquiry → quote)', 'auto:time_to_quote_days', 2],
      ];
      const upd = db.prepare(
        `UPDATE score_kpis SET data_source = ?, default_planned = ?
          WHERE metric_name = ? AND template_id = (SELECT id FROM score_templates WHERE name = ?)`
      );
      let n = 0;
      for (const [tpl, metric, src, tgt] of MAP) n += upd.run(src, tgt, metric, tpl).changes;
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('kpi_auto_sources_v6', 'done')").run();
      console.log(`[schema] kpi_auto_sources_v6: wired ${n} KPIs to live ERP feeds`);
    }
  } catch (e) { console.error('[schema] kpi_auto_sources_v6 failed:', e.message); }

  // ─── Collections KPIs from AR/AP tracker + cash-flow (mam 2026-07-01): collection
  //     efficiency = actual weekly cash inflow ÷ AR/AP-planned weekly inflow; overdue
  //     = uncollected AR past its due date (₹ Cr). ────────────────────────────────
  try {
    const w7 = db.prepare("SELECT value FROM app_settings WHERE key='kpi_auto_sources_v7'").get();
    if (!w7) {
      const MAP = [
        // Collection efficiency: plan comes LIVE from AR/AP (given), so default is a
        // harmless fallback; overdue target = 1.9 Cr ceiling (mam's current figure).
        ['Aanchal — Collections Executive', 'Collection efficiency (collected ÷ due)', 'auto:collection_efficiency', 0],
        ['Aanchal — Collections Executive', 'Overdue > 90 days (₹)', 'auto:overdue_ar_cr', 1.9],
      ];
      const upd = db.prepare(
        `UPDATE score_kpis SET data_source = ?, default_planned = ?
          WHERE metric_name = ? AND template_id = (SELECT id FROM score_templates WHERE name = ?)`
      );
      let n = 0;
      for (const [tpl, metric, src, tgt] of MAP) n += upd.run(src, tgt, metric, tpl).changes;
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('kpi_auto_sources_v7', 'done')").run();
      console.log(`[schema] kpi_auto_sources_v7: wired ${n} collections KPIs to AR/AP + cash-flow`);
    }
  } catch (e) { console.error('[schema] kpi_auto_sources_v7 failed:', e.message); }

  // Multiple BOQs per lead (mam 2026-06-12: "after some time again again
  // client send boq ... option + to add boq").  The single boq_* columns on
  // sales_funnel keep the LATEST for existing views; the full history lives
  // here so every re-sent BOQ is kept.
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS sales_funnel_boqs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      funnel_id     INTEGER REFERENCES sales_funnel(id) ON DELETE CASCADE,
      boq_file_link TEXT,
      boq_amount    REAL DEFAULT 0,
      notes         TEXT,
      created_by    TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (e) { console.error('[schema] sales_funnel_boqs create failed:', e.message); }

  // ─── 2-Level Indent Approval — tag Nitin Jain ji = L1, Nitin Sir = L2 ─
  // Idempotent: only sets approval_role on rows that don't already carry one,
  // and matches loosely (case-insensitive name LIKE) so minor punctuation in
  // seed data doesn't break it. Runs after the migrations loop so the
  // approval_role column definitely exists.
  try {
    const l1 = db.prepare(`
      UPDATE users SET approval_role='l1'
        WHERE id = (
          SELECT id FROM users
            WHERE LOWER(name) LIKE 'nitin%' AND LOWER(name) LIKE '%jain%'
            ORDER BY id LIMIT 1
        ) AND (approval_role IS NULL OR approval_role='')
    `).run();
    if (l1.changes > 0) console.log('[seed] Tagged Nitin Jain ji as L1 indent approver');

    const l2 = db.prepare(`
      UPDATE users SET approval_role='l2'
        WHERE id = (
          SELECT id FROM users
            WHERE LOWER(name) LIKE 'nitin%' AND LOWER(name) NOT LIKE '%jain%'
              AND (approval_role IS NULL OR approval_role='')
            ORDER BY id LIMIT 1
        ) AND (approval_role IS NULL OR approval_role='')
    `).run();
    if (l2.changes > 0) console.log('[seed] Tagged Nitin Sir as L2 indent approver');
  } catch (e) { /* column not yet present on very first boot — silent */ }

  // ─── Fixed-salary (salary_exempt) employees ──────────────────────
  // Mam 2026-06-09: these people always get their FULL salary — never
  // docked for attendance / late / absent / leave. The salary_exempt flag
  // existed but was never set on the data, so they were being prorated.
  // Match on the LETTERS-ONLY form of the name (case- & punctuation-
  // tolerant exact match: "D.S Kaplesh" → "dskaplesh", "ANKUR KAPLESH" →
  // "ankurkaplesh") so a stray dot/case can't miss or over-match.
  // Idempotent — only touches rows not already exempt.
  try {
    const fixedSalaryNames = new Set([
      'ankurkaplesh', 'nitinjain', 'parulgoyal', 'rajatsir',
      'poojakaplesh', 'somakaplesh', 'dskaplesh',
    ]);
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
    const setExempt = db.prepare('UPDATE employees SET salary_exempt=1 WHERE id=? AND COALESCE(salary_exempt,0)=0');
    let exemptCount = 0;
    for (const e of db.prepare('SELECT id, name FROM employees').all()) {
      if (fixedSalaryNames.has(norm(e.name))) exemptCount += setExempt.run(e.id).changes;
    }
    if (exemptCount > 0) console.log(`[seed] Flagged ${exemptCount} fixed-salary (salary_exempt) employees`);
  } catch (e) { /* employees table/column not ready — silent */ }

  // ─── Seed labour_rates once from mam's uploaded sheet (2026-06-10) ─
  try {
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM labour_rates').get().c;
    if (cnt === 0) {
      const seed = require('./labourRatesSeed.json');
      const ins = db.prepare('INSERT INTO labour_rates (item_name, rate, uom, category) VALUES (?,?,?,?)');
      db.transaction(rows => { for (const r of rows) ins.run(r.item_name, r.rate || 0, r.uom || '', r.category || ''); })(seed);
      console.log(`[seed] Imported ${seed.length} labour_rates from sheet`);
    }
  } catch (e) { console.error('[seed] labour_rates import failed:', e.message); }

  // ─── Import PO/FOC kits once from mam's sheet (2026-06-10) ─────────
  // Each kit = a PO item + its labour + FOC consumables. Codes are resolved
  // to item_master / labour_rates against THIS db. Inserted as non_approved
  // drafts so admin can edit/approve. Guarded by a one-time flag.
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='po_foc_seed_imported'").get();
    if (!done) {
      const seed = require('./poFocSeed.json');
      const findPo = db.prepare("SELECT id, current_price FROM item_master WHERE type='PO' AND LOWER(TRIM(item_code))=LOWER(TRIM(?)) LIMIT 1");
      const findFoc = db.prepare("SELECT id, current_price FROM item_master WHERE type='FOC' AND LOWER(TRIM(item_code))=LOWER(TRIM(?)) LIMIT 1");
      const findLab = db.prepare("SELECT id FROM labour_rates WHERE LOWER(TRIM(item_name))=LOWER(TRIM(?)) LIMIT 1");
      const ins = db.prepare(`INSERT INTO po_foc_entries (po_item_id, po_name, po_rate, qty, labour, labour_item_id, labour_name, labour_margin, margin, focs_json, cost, tpa, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'non_approved')`);
      let n = 0;
      db.transaction(list => {
        for (const e of list) {
          const po = e.po_code ? findPo.get(e.po_code) : null;
          const poRate = e.po_rate || (po && po.current_price) || 0;
          const focs = (e.focs || []).map(f => {
            const fm = f.code ? findFoc.get(f.code) : null;
            return { item_id: fm ? fm.id : null, name: f.name, qty: f.qty || 1, rate: f.rate || (fm && fm.current_price) || 0 };
          });
          const labRate = e.labour_rate || 0;
          const labMatch = e.labour_name ? findLab.get(e.labour_name) : null;
          const margin = 30, labMargin = 50;
          const poAmt = poRate, focAmt = focs.reduce((t, f) => t + f.rate * f.qty, 0), labAmt = labRate;
          const cost = Math.round((poAmt + focAmt + labAmt) * 100) / 100;
          const tpa = Math.round(((poAmt + focAmt) * (1 + margin / 100) + labAmt * (1 + labMargin / 100)) * 100) / 100;
          ins.run(po ? po.id : null, e.po_name, poRate, 1, labRate, labMatch ? labMatch.id : null, e.labour_name || '', labMargin, margin, JSON.stringify(focs), cost, tpa);
          n++;
        }
      })(seed);
      db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('po_foc_seed_imported','1',CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value='1'").run();
      console.log(`[seed] Imported ${n} PO/FOC kits from sheet`);
    }
  } catch (e) { console.error('[seed] po_foc import failed:', e.message); }

  // ─── One-time data backfill: link sites to business_book ──────────
  // Mam: "in dpr all not see boq item which i upload in order to
  // planning". Older DPR sites were inserted with business_book_id =
  // NULL, so the po_items lookup walked off a cliff. Backfill any
  // sites where bb id is missing by matching:
  //   1. site.po_id → purchase_orders.business_book_id
  //   2. site.name matched against business_book.project_name /
  //      client_name / company_name (case-insensitive, trimmed)
  // Idempotent — only updates rows where business_book_id IS NULL.
  try {
    const fixed1 = db.prepare(`
      UPDATE sites SET business_book_id = (
        SELECT po.business_book_id FROM purchase_orders po
         WHERE po.id = sites.po_id AND po.business_book_id IS NOT NULL
         LIMIT 1
      )
      WHERE business_book_id IS NULL AND po_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM purchase_orders po WHERE po.id = sites.po_id AND po.business_book_id IS NOT NULL)
    `).run();
    const fixed2 = db.prepare(`
      UPDATE sites SET business_book_id = (
        SELECT bb.id FROM business_book bb
         WHERE TRIM(LOWER(bb.project_name)) = TRIM(LOWER(sites.name))
            OR TRIM(LOWER(bb.client_name))  = TRIM(LOWER(sites.name))
            OR TRIM(LOWER(bb.company_name)) = TRIM(LOWER(sites.name))
         LIMIT 1
      )
      WHERE business_book_id IS NULL
        AND EXISTS (
          SELECT 1 FROM business_book bb
           WHERE TRIM(LOWER(bb.project_name)) = TRIM(LOWER(sites.name))
              OR TRIM(LOWER(bb.client_name))  = TRIM(LOWER(sites.name))
              OR TRIM(LOWER(bb.company_name)) = TRIM(LOWER(sites.name))
        )
    `).run();
    if ((fixed1.changes || 0) + (fixed2.changes || 0) > 0) {
      console.log(`[backfill] sites.business_book_id: linked ${fixed1.changes} via po_id + ${fixed2.changes} via name match`);
    }
  } catch (e) {
    console.warn('[backfill] sites.business_book_id link failed:', e.message);
  }

  // ─── One-time backfill: po_items.po_id ────────────────────────────
  // Assign every orphan po_items row to the most recent purchase_orders
  // row for the same business_book_id. If a BB has only one PO this is
  // perfect; if a BB had multiple POs whose items were merged (because
  // the old wipe-by-bb-id bug nuked earlier uploads), the surviving
  // items collapse onto the newest PO — which matches reality, since
  // earlier uploads were already lost.
  try {
    const r = db.prepare(`
      UPDATE po_items
         SET po_id = (
           SELECT po.id FROM purchase_orders po
            WHERE po.business_book_id = po_items.business_book_id
            ORDER BY po.id DESC
            LIMIT 1
         )
       WHERE po_id IS NULL
         AND business_book_id IS NOT NULL
    `).run();
    if (r.changes > 0) console.log(`[backfill] po_items.po_id: linked ${r.changes} orphan items to their most-recent PO`);
  } catch (e) {
    console.warn('[backfill] po_items.po_id link failed:', e.message);
  }

  // ─── One-time backfill: historical DPR Table A → labour (11% of SITC) ──
  // Mam (2026-05-30): the BOQ/PO rate is the full SITC value (Supply +
  // Installation + T&C) and already includes labour; the DPR should carry
  // only the labour portion = 11% of SITC. New DPRs are saved by the app
  // already in labour terms (dpr.labour_pct_applied = 1). This block scales
  // every PRE-EXISTING DPR's Table A — dpr_work_items.rate/amount and
  // dpr.grand_total_a — by 11% and recomputes profit_loss = grand_total_a − B,
  // so past Profit/Loss reflects labour cost. Guarded by labour_pct_applied
  // so each DPR converts EXACTLY ONCE (never double-scales, even on restart).
  const LABOUR_PCT = 0.11;
  try {
    const pending = db.prepare(`SELECT COUNT(*) AS c FROM dpr WHERE COALESCE(labour_pct_applied,0) = 0`).get();
    if (pending.c > 0) {
      // Safety backup BEFORE mutating financial history. Checkpoint the WAL
      // into the main file first so the copy is complete, then snapshot to
      // /backups. If the backup can't be written, ABORT — never convert
      // irreversibly without a restore point.
      const fs = require('fs');
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
        const backupsDir = path.join(__dirname, '..', '..', 'backups');
        if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
        const d = new Date();
        const p2 = (n) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
        const backupPath = path.join(backupsDir, `erp-before-labour-pct-${stamp}.db`);
        fs.copyFileSync(DB_PATH, backupPath);
        console.log(`[labour-pct] DB backed up to ${backupPath} before conversion`);
      } catch (be) {
        console.error('[labour-pct] BACKUP FAILED — aborting conversion to protect data:', be.message);
        throw be;
      }

      const convert = db.transaction(() => {
        db.prepare(`
          UPDATE dpr_work_items
             SET rate   = ROUND(rate   * ${LABOUR_PCT}, 2),
                 amount = ROUND(amount * ${LABOUR_PCT}, 2)
           WHERE dpr_id IN (SELECT id FROM dpr WHERE COALESCE(labour_pct_applied,0) = 0)
        `).run();
        // RHS reads the ORIGINAL row values, so profit_loss uses the
        // pre-scale grand_total_a while grand_total_a is itself scaled.
        db.prepare(`
          UPDATE dpr
             SET profit_loss        = ROUND(grand_total_a * ${LABOUR_PCT}, 2) - grand_total_b,
                 grand_total_a      = ROUND(grand_total_a * ${LABOUR_PCT}, 2),
                 labour_pct_applied = 1
           WHERE COALESCE(labour_pct_applied,0) = 0
        `).run();
      });
      convert();
      console.log(`[labour-pct] Converted ${pending.c} historical DPR(s) to labour rate (${Math.round(LABOUR_PCT * 100)}% of SITC)`);
    }
  } catch (e) {
    console.error('[labour-pct] conversion failed:', e.message);
  }

  // ─── PERFORMANCE INDEXES on hot tables (fast page loads) ───────────
  // Runs AFTER migrations so columns added by ALTER TABLE above are
  // already present. Each index is guarded individually — if a column
  // is still missing on a particular DB (e.g. a very old prod that
  // hasn't been touched in a while), the index simply skips and the
  // server boots normally instead of crash-looping.
  // Mam: 'why it take time to reload data, how to fast it'.
  const safeIndexes = [
    // Audit log
    'CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id)',
    'CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action)',
    // Warehouses + stock
    'CREATE INDEX IF NOT EXISTS idx_warehouses_site ON warehouses(site_id)',
    'CREATE INDEX IF NOT EXISTS idx_stock_warehouse ON stock_balance(warehouse_id)',
    'CREATE INDEX IF NOT EXISTS idx_stock_item ON stock_balance(item_master_id)',
    'CREATE INDEX IF NOT EXISTS idx_stock_mvmt_warehouse ON stock_movements(warehouse_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_stock_mvmt_item ON stock_movements(item_master_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_stock_mvmt_ref ON stock_movements(reference_type, reference_id)',
    // Attendance — date filters, per-user month view, late stats
    'CREATE INDEX IF NOT EXISTS idx_att_user_date ON attendance(user_id, date)',
    'CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(date)',
    'CREATE INDEX IF NOT EXISTS idx_att_status ON attendance(status)',
    // Location tracking
    'CREATE INDEX IF NOT EXISTS idx_loc_user_date ON location_tracking(user_id, date)',
    'CREATE INDEX IF NOT EXISTS idx_loc_time ON location_tracking(time DESC)',
    // Leave requests
    'CREATE INDEX IF NOT EXISTS idx_leave_user ON leave_requests(user_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_leave_status ON leave_requests(status)',
    // Payment requests
    'CREATE INDEX IF NOT EXISTS idx_pr_status ON payment_requests(status)',
    'CREATE INDEX IF NOT EXISTS idx_pr_category ON payment_requests(category)',
    'CREATE INDEX IF NOT EXISTS idx_pr_site ON payment_requests(site_id)',
    'CREATE INDEX IF NOT EXISTS idx_pr_creator ON payment_requests(created_by)',
    // Business book
    'CREATE INDEX IF NOT EXISTS idx_bb_company ON business_book(company_name)',
    'CREATE INDEX IF NOT EXISTS idx_bb_employee ON business_book(employee_assigned)',
    'CREATE INDEX IF NOT EXISTS idx_bb_status ON business_book(status)',
    // Sites
    'CREATE INDEX IF NOT EXISTS idx_sites_name ON sites(name)',
    'CREATE INDEX IF NOT EXISTS idx_sites_bb ON sites(business_book_id)',
    // Indents
    'CREATE INDEX IF NOT EXISTS idx_indents_status ON indents(status)',
    'CREATE INDEX IF NOT EXISTS idx_indents_site ON indents(site_name)',
    'CREATE INDEX IF NOT EXISTS idx_indents_created ON indents(created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_indent_items_indent ON indent_items(indent_id)',
    // Vendor POs
    'CREATE INDEX IF NOT EXISTS idx_vpo_indent ON vendor_pos(indent_id)',
    'CREATE INDEX IF NOT EXISTS idx_vpo_vendor ON vendor_pos(vendor_id)',
    'CREATE INDEX IF NOT EXISTS idx_vpo_cancelled ON vendor_pos(cancelled)',
    // DPR
    'CREATE INDEX IF NOT EXISTS idx_dpr_site_date ON dpr(site_id, report_date)',
    'CREATE INDEX IF NOT EXISTS idx_dpr_date ON dpr(report_date)',
    'CREATE INDEX IF NOT EXISTS idx_dpr_approval ON dpr(approval_status)',
    // Delegations
    'CREATE INDEX IF NOT EXISTS idx_del_assignee ON delegations(assigned_to, status)',
    'CREATE INDEX IF NOT EXISTS idx_del_user ON delegations(user_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_del_status ON delegations(status)',
    // Support / help tickets
    'CREATE INDEX IF NOT EXISTS idx_tk_user ON support_tickets(user_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_tk_assignee ON support_tickets(assigned_to, status)',
    'CREATE INDEX IF NOT EXISTS idx_tk_status ON support_tickets(status)',
    // Snags + Company assets
    'CREATE INDEX IF NOT EXISTS idx_snags_status ON snags(status)',
    'CREATE INDEX IF NOT EXISTS idx_snags_assignee ON snags(assigned_to)',
    'CREATE INDEX IF NOT EXISTS idx_snags_raiser ON snags(raised_by)',
    'CREATE INDEX IF NOT EXISTS idx_assets_status ON company_assets(status)',
    'CREATE INDEX IF NOT EXISTS idx_assets_user ON company_assets(current_user_id)',
    'CREATE INDEX IF NOT EXISTS idx_assets_category ON company_assets(category)',
    // Cash flow
    'CREATE INDEX IF NOT EXISTS idx_cf_date ON cash_flow_entries(date)',
    'CREATE INDEX IF NOT EXISTS idx_cf_party ON cash_flow_entries(party_name)',
    // Receivables
    'CREATE INDEX IF NOT EXISTS idx_recv_status ON receivables(status)',
    'CREATE INDEX IF NOT EXISTS idx_recv_client ON receivables(client_name)',
    // Complaints
    'CREATE INDEX IF NOT EXISTS idx_cmp_status ON complaints(status)',
    'CREATE INDEX IF NOT EXISTS idx_cmp_category ON complaints(category)',
    // AI Agent item-rate history — speeds up the rate-suggestion popup
    // (last quoted to this client / 6-month avg-low-high per item).
    'CREATE INDEX IF NOT EXISTS idx_iph_item_date ON item_price_history(item_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_iph_item_lead ON item_price_history(item_id, lead_id)',
    'CREATE INDEX IF NOT EXISTS idx_iph_item_company ON item_price_history(item_id, company_name)',
    'CREATE INDEX IF NOT EXISTS idx_boqi_item ON boq_items(item_id)',
    // Multi-contractor DPR rows — fetched by dpr_id when loading a DPR detail
    'CREATE INDEX IF NOT EXISTS idx_dpr_contractors_dpr ON dpr_contractors(dpr_id)',
    // Sub-contractor master list — filter by type/state when planning
    'CREATE INDEX IF NOT EXISTS idx_sub_contractors_type ON sub_contractors(contractor_type, active)',
    'CREATE INDEX IF NOT EXISTS idx_sub_contractors_state ON sub_contractors(state, district)',
    // CRM Funnel — most common views are "open leads" (final_status NULL)
    // and "by step" (quotation_submitted, negotiation_status, final_status).
    'CREATE INDEX IF NOT EXISTS idx_crm_funnel_final ON crm_funnel(final_status, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_crm_funnel_neg ON crm_funnel(negotiation_status)',
    // Purchase orders + items — joined/filtered by business_book_id on
    // almost every Orders + DPR + procurement query; po_items also looked
    // up by po_id (per-PO line items) and item_master_id (rate joins).
    // These FKs had no index → full scans on every PO page load.
    'CREATE INDEX IF NOT EXISTS idx_po_bb ON purchase_orders(business_book_id)',
    'CREATE INDEX IF NOT EXISTS idx_po_quotation ON purchase_orders(quotation_id)',
    'CREATE INDEX IF NOT EXISTS idx_po_items_po ON po_items(po_id)',
    'CREATE INDEX IF NOT EXISTS idx_po_items_bb ON po_items(business_book_id)',
    'CREATE INDEX IF NOT EXISTS idx_po_items_item ON po_items(item_master_id)',
    // (CRM Kitting's (project_key, checkpoint_id, uploaded_at) lookup is
    // already indexed by idx_kit_entry_proj in routes/crmKitting.js.)
  ];
  for (const sql of safeIndexes) {
    try { db.exec(sql); } catch (e) { /* column missing on a stale DB — non-fatal */ }
  }

  // Re-classify attendance rows so status reflects the CURRENT cutoff
  // (payroll_settings.late_after_time, IST). Idempotent and bidirectional:
  // - Rows past the cutoff become 'late'
  // - Rows at/before the cutoff become 'present'
  // - half_day / short_day / on_leave / absent / admin_marked rows are
  //   left alone so we don't trample manual classifications.
  // Fixes both the original UTC-vs-IST bug AND the case where a previous
  // tighter cutoff left rows mismarked as 'late' after mam relaxed it.
  try {
    const ps = db.prepare("SELECT late_after_time FROM payroll_settings WHERE id=1").get();
    const cutoffStr = (ps?.late_after_time || '09:46').padEnd(5, '0').slice(0, 5);
    const r = db.prepare(`
      UPDATE attendance
         SET status = CASE
             WHEN time(datetime(punch_in_time, '+5 hours', '+30 minutes')) > ?
                  THEN 'late'
             ELSE 'present'
           END
       WHERE punch_in_time IS NOT NULL
         AND status IN ('present', 'late')
         AND COALESCE(admin_marked, 0) = 0
    `).run(cutoffStr + ':00');
    if (r.changes > 0) console.log(`[backfill] re-synced ${r.changes} attendance rows against cutoff ${cutoffStr} IST`);
  } catch (e) { /* non-fatal */ }

  // ─── Sales Funnel — stage key migration to mam's 11-stage spec ─────
  // The pre-spec build used keys like 'new_lead','qualified','meeting_
  // assigned','mom_uploaded','drawing_uploaded','boq_created','quotation_
  // sent','won'. Mam's 11-stage spec replaces them with: 'lead_capture',
  // 'qualification','site_survey','concept_design','boq_costing',
  // 'pricing_review','quote_submitted','technical_clarification',
  // 'commercial_negotiation','contract_signed','project_kickoff' (+ 'lost').
  //
  // This block re-keys every existing lead in one shot so the new tab bar
  // counts the leads correctly. Idempotent — once 'sf_stages_v2' is set in
  // app_settings, it never runs again. Each UPDATE is best-effort
  // (try/catch) so a partial DB doesn't crash boot.
  try {
    const migrated = db.prepare("SELECT value FROM app_settings WHERE key='sf_stages_v2'").get();
    if (!migrated) {
      const remap = [
        ['new_lead',         'lead_capture'],
        ['qualified',        'qualification'],
        ['meeting_assigned', 'site_survey'],
        ['mom_uploaded',     'site_survey'],
        ['drawing_uploaded', 'concept_design'],
        ['boq_created',      'boq_costing'],
        ['quotation_sent',   'quote_submitted'],
        ['won',              'contract_signed'],
        // 'lost' stays 'lost'
      ];
      let total = 0;
      for (const [oldKey, newKey] of remap) {
        try {
          const r = db.prepare('UPDATE sales_funnel SET current_stage=? WHERE current_stage=?').run(newKey, oldKey);
          total += r.changes;
        } catch (e) { /* non-fatal */ }
      }
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('sf_stages_v2', '1')").run();
      if (total > 0) console.log(`[migration] sales_funnel: re-keyed ${total} leads to 11-stage spec`);
    }
  } catch (e) { /* non-fatal */ }

  // Mam (2026-05-22): pre-existing checklists were saved before the
  // recurrence_start_date / recurrence_end_date columns existed, so
  // they all carry NULL bounds.  The strict by-date filter then
  // hides them on every date.  This one-time backfill gives every
  // such row a sensible default:
  //   start = COALESCE(due_date, DATE(created_at))  -- when the task
  //                                                     was first set up
  //   end   = '2026-12-31'                          -- mam's chosen
  //                                                     default cap
  // Idempotent via the checklist_recurrence_backfill_v1 flag.
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='checklist_recurrence_backfill_v1'").get();
    if (!done) {
      const r = db.prepare(`
        UPDATE checklists
        SET recurrence_start_date = COALESCE(recurrence_start_date, due_date, DATE(created_at), DATE('now','localtime')),
            recurrence_end_date   = COALESCE(recurrence_end_date,   '2026-12-31')
        WHERE recurrence_start_date IS NULL OR recurrence_end_date IS NULL
      `).run();
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('checklist_recurrence_backfill_v1', '1')").run();
      if (r.changes > 0) console.log(`[migration] checklists: backfilled recurrence window on ${r.changes} rows (end=2026-12-31)`);
    }
  } catch (e) {
    console.warn('[migration] checklist recurrence backfill skipped:', e.message);
  }

  // HR Phase 1 Batch E (mam 2026-05-22): seed starter induction
  // content so /induction isn't bare on day 1.  Five placeholder
  // items — one per spec section — that mam will replace with
  // real SEPL content (founder video, actual policies, etc.) via
  // the Induction Content tab.  Idempotent via app_settings.
  try {
    const seeded = db.prepare("SELECT value FROM app_settings WHERE key='seed_induction_items_v1'").get();
    if (!seeded) {
      const ITEMS = [
        {
          section: 'founder', order_index: 0, content_type: 'text',
          title: 'Welcome from the Managing Director',
          content_text:
`Dear new colleague,

Welcome to Secured Engineers Pvt. Ltd. — and welcome to the team.

You are joining a company that has been built brick by brick on three
non-negotiables: quality of work, integrity with our clients, and
care for our people. Every site we deliver, every payment we make,
every commitment we honour — they add up to the reputation we have
earned over the years.

In your first week, focus on three things:
  1. Understand how your role contributes to a project's success
  2. Meet the people you will be working with — make introductions
  3. Ask questions; nothing is silly when you are new

I look forward to seeing what you build with us.

— Managing Director, SEPL`,
        },
        {
          section: 'culture', order_index: 0, content_type: 'text',
          title: 'How We Work — Four Operating Principles',
          content_text:
`1. OWN THE OUTCOME, NOT THE TASK
   Your job is not "I finished my part." It is "the customer got
   what they were promised, on time, at the right quality."

2. CLEAR > CLEVER
   Plain language in WhatsApp, in DPRs, in cash-flow updates.
   If three people read the same line and have to ask "what does
   that mean?", rewrite it.

3. RAISE THE FLAG EARLY
   A missed deadline reported on Day 1 of slippage costs us a
   conversation. The same slippage reported on Day 10 costs the
   project. There is no penalty for early bad news — only for
   late bad news.

4. RESPECT EVERYONE ON SITE
   The mason laying the floor, the vendor delivering pipes, the
   client representative inspecting the work — every person who
   contributes deserves the same baseline of courtesy. We hire
   for skill; we keep people for character.`,
        },
        {
          section: 'hr_policies', order_index: 0, content_type: 'text',
          title: 'HR Policies — Overview',
          content_text:
`Your detailed HR handbook covers the following areas. Ask your HR
business partner for the current version of any specific policy:

  • Working hours, leave policy and holiday calendar
  • Travel, expense claims and reimbursement timelines
  • Performance review cycle and feedback norms
  • Code of conduct and grievance redressal process
  • POSH (Prevention of Sexual Harassment) policy
  • Anti-bribery and conflict of interest declarations
  • Probation, confirmation and exit procedures

For anything not covered here, your first stop is your manager;
your second stop is HR (hr@securedengineers.com).`,
        },
        {
          section: 'it_security', order_index: 0, content_type: 'text',
          title: 'IT &amp; Security — Do / Don\'t',
          content_text:
`DO
  ✓ Use your SEPL ERP login only on company-approved devices
  ✓ Lock your laptop / phone screen when you step away
  ✓ Report a lost device to IT within 30 minutes
  ✓ Use strong passwords (12+ chars, mix of cases and digits)
  ✓ Forward suspicious emails / WhatsApp messages to IT before
    clicking any link

DON'T
  ✗ Share your ERP password with anyone — not even your manager
  ✗ Install pirated software on company devices
  ✗ Save customer / vendor / employee personal data on personal
    Google Drives, WhatsApp groups, or USB sticks
  ✗ Click links from unknown senders, even if they look like our
    bank or a courier company
  ✗ Plug in unknown USB drives or chargers found in public places`,
        },
        {
          section: 'sop', order_index: 0, content_type: 'text',
          title: 'SOPs — Where to Find Them',
          content_text:
`Standard Operating Procedures (SOPs) live in the ERP itself, not in
a separate document folder. The most-used ones during your first
weeks:

  • Daily Progress Report (DPR)        — module: DPR
  • Indent → Vendor PO → Dispatch      — module: Indent to Dispatch
  • Payment Required workflow          — module: Payment Required
  • Snag List + Delegations            — modules: Snag List, Delegations
  • Complaint resolution + OTP closure — module: Complaints
  • Site checklists (daily / weekly)    — module: Checklists

Your manager will walk you through the SOPs relevant to your role
in your first week. If a process feels broken, raise a Help Ticket
— that is how we improve the ERP, not by working around it.`,
        },
      ];
      const ins = db.prepare(`INSERT INTO induction_items
        (section, title, content_type, content_url, content_text, order_index, is_active)
        VALUES (?,?,?,?,?,?,1)`);
      let n = 0;
      for (const it of ITEMS) {
        try { ins.run(it.section, it.title, it.content_type, it.content_url || null, it.content_text || null, it.order_index); n++; }
        catch (_) {}
      }
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('seed_induction_items_v1', '1')").run();
      console.log(`[seed] induction_items: inserted ${n} starter items`);
    }
  } catch (e) {
    console.warn('[seed] induction_items skipped:', e.message);
  }

  // HR Phase 1 Batch B (mam 2026-05-22): seed the final-round
  // question bank so the panel has a starting set on day 1.  25
  // questions across the 5 spec categories (Leadership / Ownership /
  // Decision Making / Conflict Management / Team Handling).  Idempotent
  // via the seed_final_round_questions_v1 sentinel.  Admin can add /
  // edit / disable questions from the UI after seeding.
  try {
    const seeded = db.prepare("SELECT value FROM app_settings WHERE key='seed_final_round_questions_v1'").get();
    if (!seeded) {
      const FRQ = [
        // Leadership
        ['Leadership','Describe a time you led a team through significant change. How did you keep people aligned?','Manager','medium','Look for: setting context, listening to concerns, decisive moves, follow-through'],
        ['Leadership','Tell us about a time you had to make an unpopular decision. How did you handle the pushback?','Manager','hard','Look for: principled reasoning, transparency, owning the call'],
        ['Leadership','How do you develop the people who report to you?','Manager','medium','Look for: structured 1:1s, growth plans, specific examples of someone they helped grow'],
        ['Leadership','When you took over a struggling team, what was your first 30 days?','Manager','hard','Look for: diagnostic mindset, listening before acting'],
        ['Leadership','How do you set vision for your team in a way they actually feel?','Manager','medium','Look for: simple language, repeatable narrative, connection to individual work'],
        // Ownership
        ['Ownership','Tell us about a failure that was clearly yours. What did you do?','Any','medium','Look for: blame-free language, specific lessons, behaviour change after'],
        ['Ownership','When was the last time you went beyond your job description?','Any','easy','Look for: initiative without being asked, clear impact'],
        ['Ownership','Describe a project no one asked you to do but you did anyway.','Any','medium','Look for: spotted a gap, made the case, shipped it'],
        ['Ownership','A critical task is yours. You realise the budget is half what you need. What do you do?','Any','medium','Look for: re-scoping, surfacing risk early, not just suffering in silence'],
        ['Ownership','Tell us about a time you missed a deadline. What happened next?','Any','medium','Look for: early signalling, recovery plan, prevention for next time'],
        // Decision Making
        ['Decision Making','Walk us through the hardest decision you have made in the last 12 months.','Any','hard','Look for: trade-offs, who they consulted, how they communicated it'],
        ['Decision Making','When data is incomplete, how do you decide?','Any','medium','Look for: framing assumptions, reversibility, risk appetite'],
        ['Decision Making','Tell us about a time you had to choose between two equally good options.','Any','medium','Look for: structured comparison, clarity on what mattered most'],
        ['Decision Making','When was the last time you changed your mind on something important? Why?','Any','medium','Look for: intellectual honesty, willingness to update'],
        ['Decision Making','You have to choose between launching now vs polishing for 2 more weeks. How do you decide?','Any','medium','Look for: customer impact, learning vs. risk, who else is consulted'],
        // Conflict Management
        ['Conflict Management','Tell us about a conflict you had with a peer. How was it resolved?','Any','medium','Look for: directness, listening to other side, durable resolution'],
        ['Conflict Management','When have you disagreed with your manager? What did you do?','Any','medium','Look for: respectful pushback, escalation path, accepting the call after'],
        ['Conflict Management','How do you handle a teammate who consistently misses commitments?','Manager','hard','Look for: direct feedback first, structured plan, escalation only after'],
        ['Conflict Management','A senior leader publicly criticises your work in a meeting. What do you do?','Any','hard','Look for: composure, clarification, follow-up in private'],
        ['Conflict Management','Two of your reports are not getting along. How do you intervene?','Manager','hard','Look for: hearing both sides, focus on behaviours not personalities, clear expectations'],
        // Team Handling
        ['Team Handling','How do you onboard a new hire in your team?','Manager','easy','Look for: structured plan, early wins, regular check-ins'],
        ['Team Handling','When did you last give someone tough feedback? Walk us through it.','Manager','medium','Look for: timeliness, specificity, framing for growth'],
        ['Team Handling','How do you handle a high performer who is becoming hard to work with?','Manager','hard','Look for: directness, raising the bar on behaviour, willingness to lose them'],
        ['Team Handling','Tell us about a time you had to let someone go. How did you handle it?','Manager','hard','Look for: respectful process, clarity, learnings about hiring'],
        ['Team Handling','How do you run an effective 1:1?','Manager','easy','Look for: agenda owned by report, growth + obstacles + personal, follow-up'],
      ];
      const stmt = db.prepare(`INSERT INTO final_round_questions
        (category, question_text, for_role, difficulty, notes, is_active)
        VALUES (?,?,?,?,?,1)`);
      let count = 0;
      for (const [cat, q, role, diff, notes] of FRQ) {
        try { stmt.run(cat, q, role, diff, notes); count++; } catch (_) {}
      }
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('seed_final_round_questions_v1', '1')").run();
      console.log(`[seed] final_round_questions: inserted ${count} starter questions`);
    }
  } catch (e) {
    console.warn('[seed] final_round_questions skipped:', e.message);
  }

  // Mam (2026-05-22): "add frequency fortnightly mean month 2 time
  // b/w 15 days distance" — relax the checklists.frequency CHECK so
  // the new 'fortnightly' value is accepted.  The old approach edited
  // sqlite_master via `PRAGMA writable_schema`, but SQLite's defensive
  // mode rejects that with "table sqlite_master may not be modified",
  // so the migration silently failed and fortnightly inserts errored.
  // Rebuild the table instead (same proven pattern as the
  // payment_requests / indents CHECK rebuilds).  Idempotent: the CHECK
  // check short-circuits once 'fortnightly' is present.
  try {
    const cur = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='checklists'").get();
    if (cur?.sql && /CHECK\s*\(\s*frequency\s+IN/i.test(cur.sql) && !cur.sql.includes("'fortnightly'")) {
      const newSql = cur.sql
        .replace(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(?:"checklists"|checklists)/i, 'CREATE TABLE checklists_new')
        .replace(/CHECK\s*\(\s*frequency\s+IN\s*\([^)]*\)\s*\)/i,
          "CHECK(frequency IN ('daily','weekly','fortnightly','monthly','quarterly','yearly','once'))");
      if (newSql === cur.sql || !/CREATE TABLE checklists_new/.test(newSql)) {
        throw new Error('regex did not rewrite checklists CREATE — CHECK shape unexpected');
      }
      db.pragma('foreign_keys = OFF');
      try { db.exec('DROP TABLE IF EXISTS checklists_new'); } catch (_) {}
      const cols = db.prepare('PRAGMA table_info(checklists)').all().map(c => `"${c.name}"`).join(', ');
      db.exec('BEGIN');
      db.exec(newSql);
      db.exec(`INSERT INTO checklists_new (${cols}) SELECT ${cols} FROM checklists`);
      db.exec('DROP TABLE checklists');
      db.exec('ALTER TABLE checklists_new RENAME TO checklists');
      db.exec('COMMIT');
      db.pragma('foreign_keys = ON');
      console.log('[migration] checklists CHECK rebuilt to allow fortnightly');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    try { db.pragma('foreign_keys = ON'); } catch (_) {}
    console.warn('[migration] checklist freq fortnightly CHECK rebuild failed:', e.message);
  }

  // Seed the canonical 5 lead-source values per MD's TOC v3 spec.
  // INSERT OR IGNORE so re-runs don't duplicate or overwrite custom
  // sources added by hand.  Free-text source entry is blocked in the
  // route layer; the master list lives here.
  try {
    const seed = ['Tenders', 'Referral', 'Direct', 'Website', 'Channel'];
    const stmt = db.prepare('INSERT OR IGNORE INTO lead_sources (name) VALUES (?)');
    for (const s of seed) stmt.run(s);
  } catch (e) { /* non-fatal */ }

  // One-time normalization of sales_funnel.category capitalisation so
  // case-variants like "SOLAR" and "Solar" collapse into the canonical
  // label from the Leads dropdown.  Mam, 2026-05-15: the By-Category
  // pie was showing both "Solar: 118" and "SOLAR: 1" as separate
  // slices because legacy free-text capture wasn't normalised.
  // Guarded by an app_settings flag so it only runs once.
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='sales_funnel_category_canonical_v1'").get();
    if (!done) {
      const canon = ['Low Voltage', 'Fire Fighting', 'Fire NOC', 'Electrical', 'SOLAR', 'MEP', 'HVAC', 'Plumbing'];
      let total = 0;
      for (const c of canon) {
        try {
          // Match anything that LOWER()s to the same string but isn't
          // already the canonical capitalisation.
          const r = db.prepare(
            'UPDATE sales_funnel SET category = ? WHERE LOWER(TRIM(category)) = LOWER(?) AND category != ?'
          ).run(c, c, c);
          total += r.changes;
        } catch (_) {}
      }
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('sales_funnel_category_canonical_v1', '1')").run();
      if (total > 0) console.log(`[migration] sales_funnel.category: ${total} rows normalised to canonical capitalisation`);
    }
  } catch (e) { /* non-fatal */ }

  // One-time normalization of CRM Funnel free-text sources to the
  // canonical 5 — so editing a legacy row doesn't fail the new
  // backend validator.  Guarded by app_settings flag.
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='crm_funnel_canonical_sources_v1'").get();
    if (!done) {
      const remap = [
        ['Reference', 'Referral'],
        ['Tender Portal', 'Tenders'],
        ['Cold Call', 'Direct'],
        ['Walk-in', 'Direct'],
        ['Existing Client', 'Direct'],
      ];
      let total = 0;
      for (const [oldV, newV] of remap) {
        try {
          const r = db.prepare('UPDATE crm_funnel SET source=? WHERE source=?').run(newV, oldV);
          total += r.changes;
        } catch (_) {}
      }
      try {
        const r = db.prepare("UPDATE crm_funnel SET source=NULL WHERE source='Other'").run();
        total += r.changes;
      } catch (_) {}
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('crm_funnel_canonical_sources_v1', '1')").run();
      if (total > 0) console.log(`[migration] crm_funnel sources normalized: ${total} rows mapped to canonical 5`);
    }
  } catch (e) { /* non-fatal */ }

  // One-time data fix: project_finance.aanchal_value and manual_purchase_value
  // were historically stored as LAKHS (10 meant ₹10,00,000).  Mam (2026-05-15)
  // asked for 1:1 input/display ("if i enter 10 then 10").  Multiply the
  // existing rows by 1,00,000 so the rupee figure is preserved after the
  // frontend/backend stop applying the × 100000 conversion.  Guarded by a
  // flag so it only runs once.
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='pf_amounts_raw_rupees_v1'").get();
    if (!done) {
      const r1 = db.prepare("UPDATE project_finance SET aanchal_value = aanchal_value * 100000 WHERE aanchal_value IS NOT NULL AND aanchal_value > 0").run();
      const r2 = db.prepare("UPDATE project_finance SET manual_purchase_value = manual_purchase_value * 100000 WHERE manual_purchase_value IS NOT NULL AND manual_purchase_value > 0").run();
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('pf_amounts_raw_rupees_v1', '1')").run();
      console.log(`[migration] project_finance: aanchal × 1,00,000 on ${r1.changes} rows; manual_purchase × 1,00,000 on ${r2.changes} rows (lakhs → rupees)`);
    }
  } catch (e) { /* non-fatal */ }

  // One-time seed of mam's auto-mark-present allow-list. Guarded by an
  // app_settings key so toggling someone OFF via the UI doesn't get
  // reverted on the next server restart.
  try {
    const seeded = db.prepare("SELECT value FROM app_settings WHERE key='seed_auto_mark_v1'").get();
    if (!seeded) {
      const seedNames = ['admin','rajat sharma','nitin jain','pooja kaplesh','ankur kaplesh','parul kaplesh','backup admin'];
      const placeholders = seedNames.map(() => '?').join(',');
      db.prepare(
        `UPDATE users SET auto_mark_present=1
          WHERE LOWER(TRIM(name)) IN (${placeholders})`
      ).run(...seedNames);
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('seed_auto_mark_v1', '1')").run();
    }
  } catch (e) { /* non-fatal */ }

  // Seed lead sources
  const sources = ['Indiamart', 'WhatsApp', 'LinkedIn', 'Client Reference', 'YouTube', 'Instagram', 'Twitter'];
  const insertSource = db.prepare('INSERT OR IGNORE INTO lead_sources (name) VALUES (?)');
  for (const s of sources) insertSource.run(s);

  // Seed default roles
  // Sotyn.Headmasters (salon) roles — replace the construction roles.
  const defaultRoles = [
    { name: 'Admin', desc: 'Full access to all modules', is_system: 1 },
    { name: 'Salon Manager', desc: 'Runs the salon — appointments, billing, clients, staff', is_system: 0 },
    { name: 'Receptionist', desc: 'Front desk — bookings, billing, clients', is_system: 0 },
    { name: 'Cashier', desc: 'Billing / POS and client lookup', is_system: 0 },
    { name: 'Stylist', desc: 'View own appointments and commissions', is_system: 0 },
    { name: 'Viewer', desc: 'View-only access', is_system: 0 },
  ];

  const ALL_MODULES = [
    'dashboard','leads','quotations','orders','business_book','item_master','vendors','customers','procurement','cashflow','collections','payment_required','attendance','indent_fms','dpr',
    'installation','billing','complaints','hr','employees','expenses','checklists','users','delegations','pms_tasks','inventory','snags','company_assets','help_tickets',
    'sub_contractors','ai_agent','crm_funnel','cheques','fire_noc','rental_tools','influencers','crm_kitting',
    // Mam (2026-05-21): "add all module in roles& permission" — the
    // four modules below existed in the sidebar / routes / permission
    // checks but were missing from the server's seed list, so newly
    // created roles never got role_permissions rows for them.  Now
    // included so the top-up loop covers every module the UI exposes.
    'payroll','scoring','gamification','tools','rentals',
    // Mam (2026-05-22): HR System Phase 1 — recruitment / ATS /
    // interviews / offers / onboarding.  Gated behind one permission
    // string so individual roles can be tuned (HR Manager full, Hiring
    // Manager view + create, Interviewer view + edit feedback).
    'hr_system',
    // Mam (2026-05-28): Sub-contractor Hiring workflow tracker —
    // 14-step pre-award + onboarding flow per site.
    'subcon_hiring',
    // Mam (2026-05-28): Procurement Schedule — backward-pass Gantt
    // per project so "raise indent by" dates are computed, not guessed.
    'procurement_schedule',
    // Mam (2026-05-30): Labour Payment Indents — site engineer raises,
    // manager approves, accounts pays.  Under Projects sidebar group.
    'labour_payment',
    // Mam (2026-06-01): Indent Labour Payment — full project execution
    // + billing pipeline (Project → Budget → WO → Muster → DPR-link →
    // MB → Contractor RA → Client RA → Payment Received).  Coexists
    // with the simpler labour_payment above (open Q #2).
    'indent_labour_payment',
    // Mam (2026-06-18): AR/AP Tracker — rolling weekly cash-flow forecast
    // (receivables vs payables by party × week) with a mandatory-remark
    // change log. Under the Finance sidebar group.
    'ar_ap_tracker',
    // Mam (2026-06-18): Site Chat — internal WhatsApp-style message thread
    // per site (team-only).
    'site_chat',
    // Mam (2026-06-19): Labour Rate Sheet — was sharing the `quotations`
    // permission so it never showed separately in Roles & Permissions.
    // Now its own module so access can be granted/revoked on its own.
    'labour_rates',
    // AI Auto-Quotation (the /estimator page) — was sharing the `quotations`
    // permission so it never showed separately in Roles & Permissions. Now its
    // own module so access can be granted/revoked independently of BOQ quotes.
    'ai_quotation',
    // Solar Division (PR #2) — Solar Sales Funnel / Quotation / Projects /
    // Material+Labour Master all gate on this one key in server/routes/solar.js
    // and the sidebar, but it was never added here, so no role got a
    // role_permissions row and it never showed in Roles & Permissions.
    'solar_quotation',
    // ─── Sotyn.Headmasters fork — salon & spa modules ───────────────────────
    'salon_services','salon_stylists','salon_clients','salon_appointments',
    'salon_memberships','salon_pos','salon_commissions','salon_products',
  ];

  const insertRole = db.prepare('INSERT OR IGNORE INTO roles (name, description, is_system) VALUES (?, ?, ?)');
  for (const r of defaultRoles) insertRole.run(r.name, r.desc, r.is_system);

  // Seed permissions for each role
  const adminRole = db.prepare("SELECT id FROM roles WHERE name='Admin'").get();
  if (adminRole) {
    const existingPerms = db.prepare('SELECT COUNT(*) as c FROM role_permissions WHERE role_id=?').get(adminRole.id);
    // Self-healing top-up — Admin always gets full access to every
    // module in ALL_MODULES, even ones added after the initial seed.
    // INSERT OR IGNORE keeps existing rows untouched; new modules
    // (fire_noc, rental_tools, influencers, etc.) get auto-added so
    // mam doesn't have to manually tick them in Roles & Permissions
    // after every new feature deploy.
    const topUpAdmin = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_approve) VALUES (?,?,?,?,?,?,?)');
    for (const m of ALL_MODULES) topUpAdmin.run(adminRole.id, m, 1, 1, 1, 1, 1);

    if (existingPerms.c === 0) {
      const insertPerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_approve) VALUES (?,?,?,?,?,?,?)');
      // Admin gets full access
      for (const m of ALL_MODULES) insertPerm.run(adminRole.id, m, 1, 1, 1, 1, 1);

      const SALON_ALL = ['salon_appointments','salon_pos','salon_clients','salon_services','salon_products','salon_stylists','salon_memberships','salon_commissions'];

      // Salon Manager — full run of the salon + staff
      const mgrRole = db.prepare("SELECT id FROM roles WHERE name='Salon Manager'").get();
      if (mgrRole) {
        insertPerm.run(mgrRole.id, 'dashboard', 1, 0, 0, 0, 0);
        for (const m of SALON_ALL) insertPerm.run(mgrRole.id, m, 1, 1, 1, 1, 1);
        for (const m of ['attendance','payroll','employees','checklists','delegations','site_chat']) insertPerm.run(mgrRole.id, m, 1, 1, 1, 1, 1);
      }

      // Receptionist / front desk — bookings, billing, clients
      const recRole = db.prepare("SELECT id FROM roles WHERE name='Receptionist'").get();
      if (recRole) {
        insertPerm.run(recRole.id, 'dashboard', 1, 0, 0, 0, 0);
        insertPerm.run(recRole.id, 'salon_appointments', 1, 1, 1, 0, 0);
        insertPerm.run(recRole.id, 'salon_pos', 1, 1, 0, 0, 0);
        insertPerm.run(recRole.id, 'salon_clients', 1, 1, 1, 0, 0);
        insertPerm.run(recRole.id, 'salon_memberships', 1, 1, 0, 0, 0);
        insertPerm.run(recRole.id, 'delegations', 1, 1, 1, 0, 0);
        for (const m of ['salon_services','salon_products','salon_stylists','site_chat']) insertPerm.run(recRole.id, m, 1, 0, 0, 0, 0);
      }

      // Cashier — billing / POS + client lookup
      const cashRole = db.prepare("SELECT id FROM roles WHERE name='Cashier'").get();
      if (cashRole) {
        insertPerm.run(cashRole.id, 'dashboard', 1, 0, 0, 0, 0);
        insertPerm.run(cashRole.id, 'salon_pos', 1, 1, 0, 0, 0);
        for (const m of ['salon_clients','salon_services','salon_products','salon_appointments','site_chat']) insertPerm.run(cashRole.id, m, 1, 0, 0, 0, 0);
      }

      // Stylist — see their appointments + commissions
      const styRole = db.prepare("SELECT id FROM roles WHERE name='Stylist'").get();
      if (styRole) {
        insertPerm.run(styRole.id, 'dashboard', 1, 0, 0, 0, 0);
        for (const m of ['salon_appointments','salon_commissions','salon_services','site_chat']) insertPerm.run(styRole.id, m, 1, 0, 0, 0, 0);
      }

      // Viewer — view everything
      const viewerRole = db.prepare("SELECT id FROM roles WHERE name='Viewer'").get();
      if (viewerRole) {
        for (const m of ALL_MODULES) insertPerm.run(viewerRole.id, m, 1, 0, 0, 0, 0);
      }
    }
  }

  // Migration: ensure ALL modules have permission rows for ALL roles.
  //
  // Mam (2026-05-30): "when i create new module it shows to everyone."
  // The old default below granted can_view=1 to EVERY role for EVERY
  // module, so each newly added module auto-appeared for all roles. The
  // default is now DENY (can_view=0) for non-admins — a new module stays
  // hidden until an admin grants it in Roles & Permissions. INSERT OR
  // IGNORE means this only writes rows that don't exist yet, so existing
  // access (already-seeded modules) is preserved — nobody is locked out.
  // Admin always gets full access; the few role-specific seeds below are
  // first-run conveniences for known modules only.
  const allRoles = db.prepare('SELECT id, name FROM roles').all();
  const insertPermIfMissing = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_approve) VALUES (?,?,?,?,?,?,?)');
  for (const role of allRoles) {
    for (const mod of ALL_MODULES) {
      const exists = db.prepare('SELECT id FROM role_permissions WHERE role_id=? AND module=?').get(role.id, mod);
      if (!exists) {
        if (role.name === 'Admin') {
          insertPermIfMissing.run(role.id, mod, 1, 1, 1, 1, 1);
        } else {
          // Default DENY — modules are hidden until explicitly granted. The
          // salon roles' grants were seeded above; this only fills the gaps.
          insertPermIfMissing.run(role.id, mod, 0, 0, 0, 0, 0);
        }
      }
    }
  }

  // One-time upgrade: any authenticated user should be able to raise an indent.
  // Grant can_view + can_create on 'procurement' to every non-Viewer role that
  // doesn't have it yet. (Viewers stay view-only by design.)
  try {
    const viewer = db.prepare("SELECT id FROM roles WHERE name='Viewer'").get();
    db.prepare(
      `UPDATE role_permissions SET can_view=1, can_create=1
       WHERE module='procurement' AND (can_view=0 OR can_create=0) AND role_id != ?`
    ).run(viewer ? viewer.id : -1);
  } catch (e) {}

  // One-time upgrade (mam 2026-07-07: "some users can't raise enquiry"):
  // raising a rental-tool enquiry mirrors raising an indent — every
  // non-Viewer role gets view + create. Only Admin had can_create, so
  // the Raise Enquiry button was hidden for everyone else. Stage 1/3
  // stay locked to the designated approver; Stage 2 photo upload needs
  // can_edit, which Site Engineer gets (the spec's Stage 2 actor).
  try {
    const viewer = db.prepare("SELECT id FROM roles WHERE name='Viewer'").get();
    db.prepare(
      `UPDATE role_permissions SET can_view=1, can_create=1
       WHERE module='rental_tools' AND (can_view=0 OR can_create=0) AND role_id != ?`
    ).run(viewer ? viewer.id : -1);
    db.prepare(
      `UPDATE role_permissions SET can_edit=1
       WHERE module='rental_tools' AND can_edit=0
         AND role_id IN (SELECT id FROM roles WHERE name='Site Engineer')`
    ).run();
  } catch (e) {}

  // Seed default admin user
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@erp.com');
  if (!existing) {
    const hash = bcrypt.hashSync('admin123', 10);
    const r = db.prepare('INSERT INTO users (name, email, username, password, role, department) VALUES (?, ?, ?, ?, ?, ?)')
      .run('Admin', 'admin@erp.com', 'admin', hash, 'admin', 'Management');
    // Assign Admin role
    if (adminRole) {
      db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.lastInsertRowid, adminRole.id);
    }
  } else {
    // Backfill username for the pre-existing admin row if empty
    try { db.prepare("UPDATE users SET username='admin' WHERE email='admin@erp.com' AND (username IS NULL OR username='')").run(); } catch (e) {}
  }

  // Seed a SECOND admin so a single forgotten password doesn't lock the
  // company out. If mam loses access to 'admin', she can sign in as
  // 'backup-admin' and reset the primary admin's password from User
  // Management — no SSH / developer required.
  const backupExists = db.prepare('SELECT id FROM users WHERE username = ?').get('backup-admin');
  if (!backupExists) {
    const backupPwd = 'sepl-backup-2026';
    const bhash = bcrypt.hashSync(backupPwd, 10);
    const br = db.prepare('INSERT INTO users (name, email, username, password, role, department) VALUES (?, ?, ?, ?, ?, ?)')
      .run('Backup Admin', 'backup-admin@erp.com', 'backup-admin', bhash, 'admin', 'Management');
    if (adminRole) {
      db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)').run(br.lastInsertRowid, adminRole.id);
    }
    console.log(`[seed] Created backup admin — username: backup-admin, password: ${backupPwd}`);
  }

  // ============================================
  // LOCATION TRACKING OPT-OUT seed (mam's request 2026-04-28)
  // ============================================
  // Admins and a hand-picked list of names get track_location=0 so they
  // don't appear in Admin -> Location Tracking. Idempotent: only sets
  // the flag where it's still default 1, so re-runs respect any manual
  // toggle mam later changes via the UI.
  try {
    db.prepare(`UPDATE users SET track_location=0 WHERE role='admin' AND track_location=1`).run();
    const excludedNames = ['Ankur Kaplesh'];
    for (const n of excludedNames) {
      db.prepare(`UPDATE users SET track_location=0 WHERE LOWER(name)=LOWER(?) AND track_location=1`).run(n);
    }
  } catch (e) { /* track_location column not yet there on first ever boot — silent */ }

  // ============================================
  // INVENTORY SEED — Office Store + ONE Site Store per UNIQUE site name
  // ============================================
  // The `sites` table has duplicates (one row per PO referring to the same
  // customer), so we dedupe by name. Only ONE warehouse per unique site
  // name, linked to the OLDEST site_id with that name.
  try {
    const officeExists = db.prepare("SELECT id FROM warehouses WHERE type='office'").get();
    if (!officeExists) {
      db.prepare("INSERT INTO warehouses (name, type, location, in_charge) VALUES ('Office Store','office','Head Office',?)")
        .run('Admin');
      console.log('[seed] Created Office Store warehouse');
    }

    // STEP 1 — clean up duplicate site_store warehouses created by the
    // earlier seed. For each duplicate name, keep the lowest id and merge
    // stock_balance + redirect stock_movements onto it before deleting.
    try {
      const dupes = db.prepare(`
        SELECT name, MIN(id) as keep_id, GROUP_CONCAT(id) as all_ids, COUNT(*) as c
          FROM warehouses
         WHERE type = 'site_store'
         GROUP BY name
        HAVING c > 1
      `).all();
      let mergedTotal = 0;
      for (const d of dupes) {
        const removeIds = d.all_ids.split(',').map(s => +s).filter(i => i !== d.keep_id);
        for (const rid of removeIds) {
          // Merge stock_balance: sum quantities, weighted-average rate
          const sourceBalances = db.prepare('SELECT * FROM stock_balance WHERE warehouse_id=?').all(rid);
          for (const sb of sourceBalances) {
            const target = db.prepare('SELECT * FROM stock_balance WHERE warehouse_id=? AND item_master_id=?')
              .get(d.keep_id, sb.item_master_id);
            if (target) {
              const totalQty = (+target.quantity || 0) + (+sb.quantity || 0);
              const totalVal = ((+target.quantity || 0) * (+target.avg_rate || 0)) + ((+sb.quantity || 0) * (+sb.avg_rate || 0));
              const newAvg = totalQty > 0 ? totalVal / totalQty : 0;
              db.prepare('UPDATE stock_balance SET quantity=?, avg_rate=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
                .run(totalQty, newAvg, target.id);
              db.prepare('DELETE FROM stock_balance WHERE id=?').run(sb.id);
            } else {
              db.prepare('UPDATE stock_balance SET warehouse_id=? WHERE id=?').run(d.keep_id, sb.id);
            }
          }
          // Redirect any movements pointing at the duplicate warehouse
          db.prepare('UPDATE stock_movements SET warehouse_id=? WHERE warehouse_id=?').run(d.keep_id, rid);
          db.prepare('UPDATE stock_movements SET from_warehouse_id=? WHERE from_warehouse_id=?').run(d.keep_id, rid);
          db.prepare('UPDATE stock_movements SET to_warehouse_id=? WHERE to_warehouse_id=?').run(d.keep_id, rid);
          db.prepare('DELETE FROM warehouses WHERE id=?').run(rid);
          mergedTotal += 1;
        }
      }
      if (mergedTotal > 0) console.log(`[seed] Merged ${mergedTotal} duplicate site_store warehouse(s)`);
    } catch (e) {
      console.error('[seed] dedupe failed:', e.message);
    }

    // STEP 2 — create stores for any UNIQUE site names that don't have one yet.
    // GROUP BY name + MIN(id) so duplicates collapse to a single row.
    const sitesNeedingStores = db.prepare(`
      SELECT MIN(s.id) as id, s.name FROM sites s
       WHERE s.name IS NOT NULL AND s.name <> ''
         AND NOT EXISTS (
           SELECT 1 FROM warehouses w
            WHERE w.type='site_store' AND w.name = s.name || ' Store'
         )
       GROUP BY s.name
    `).all();
    if (sitesNeedingStores.length > 0) {
      const ins = db.prepare("INSERT INTO warehouses (name, type, site_id, location) VALUES (?, 'site_store', ?, ?)");
      for (const s of sitesNeedingStores) ins.run(`${s.name} Store`, s.id, s.name);
      console.log(`[seed] Auto-created ${sitesNeedingStores.length} site_store warehouse(s)`);
    }
  } catch (e) {
    console.error('[seed] Inventory warehouse seed failed:', e.message);
  }

  // Owner-only emergency reset code — last-resort master key for the company
  // owner. Generated ONCE on the first server start, written in plaintext to
  // data/RECOVERY.txt (gitignored, only on the VPS), and stored as a bcrypt
  // hash in app_settings. Mam should copy it from RECOVERY.txt into a safe
  // place (diary / password manager) immediately after deploy. With this
  // code + a username, /auth/emergency-reset can reset ANY user's password
  // — so total lockout is impossible as long as mam keeps the code.
  try {
    const fs = require('fs');
    const existingHash = db.prepare("SELECT value FROM app_settings WHERE key='emergency_reset_hash'").get();
    if (!existingHash) {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
      const code = Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      const hash = bcrypt.hashSync(code, 10);
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('emergency_reset_hash', ?)").run(hash);
      const recoveryPath = path.join(__dirname, '..', '..', 'data', 'RECOVERY.txt');
      const banner = [
        '================================================================',
        '  SEPL ERP - OWNER EMERGENCY RECOVERY CODE',
        '================================================================',
        '',
        `  CODE: ${code}`,
        '',
        '  WHAT THIS IS:',
        '  Last-resort master key. Used with the "Forgot password?" link',
        '  on the login page (it works as a recovery code for ANY user)',
        '  or via the /api/auth/emergency-reset endpoint.',
        '',
        '  WHAT TO DO RIGHT NOW:',
        '  1. Copy the CODE line above into your diary / password manager.',
        `  2. Delete this file from the server  (rm ${recoveryPath})`,
        '     so anyone with VPS access can\'t see it.',
        '  3. Keep the code SECRET. Anyone with this code can reset any',
        '     user\'s password.',
        '',
        '  IF YOU LOSE THIS CODE:',
        '  Run: node server/scripts/regenerate-emergency-code.js',
        '  (overwrites the old code, writes a new RECOVERY.txt)',
        '',
        '================================================================',
        '',
      ].join('\n');
      try {
        fs.writeFileSync(recoveryPath, banner, { encoding: 'utf-8' });
        console.log(`[seed] Wrote owner emergency recovery code to ${recoveryPath}`);
        console.log(`[seed] !! IMPORTANT — open that file, save the code, then delete it !!`);
      } catch (e) {
        console.error('[seed] Could not write RECOVERY.txt — code is in the DB but you need to regenerate it. Error:', e.message);
      }
    }
  } catch (e) {
    console.error('[seed] Emergency recovery setup failed:', e.message);
  }

  // Seed Item Master FIRST (needed for PO items in Business Book seed)
  const itemCount = db.prepare('SELECT COUNT(*) as c FROM item_master').get().c;
  if (itemCount === 0) {
    const fs = require('fs');
    const seedFile = path.join(__dirname, 'items_seed.json');
    if (fs.existsSync(seedFile)) {
      const items = JSON.parse(fs.readFileSync(seedFile, 'utf-8'));
      const insertItem = db.prepare('INSERT OR IGNORE INTO item_master (item_code, department, item_name, specification, size, uom, gst, type, make, current_price) VALUES (?,?,?,?,?,?,?,?,?,?)');
      const insertMany = db.transaction((items) => {
        for (const [code, dept, name, spec, size, unit, price, type, make] of items) {
          insertItem.run(code, dept, name, spec || '', size || '', unit || 'PCS', '18%', type || 'PO', make || '', price || 0);
        }
      });
      insertMany(items);
      console.log(`Seeded ${items.length} Item Master entries from Excel sheet`);
    }
  }

  // Seed sample Business Book entries (last 10 from Master Sheet).
  // Sotyn.Headmasters (salon): these are real SEPL construction leads (CONSERN
  // PHARMA, V-GUARD…) that also populate the Delegation project picker, so they
  // are disabled via ERP_DISABLE_DEMO_SEED. Unset to restore for a construction ERP.
  const bbCount = db.prepare('SELECT COUNT(*) as c FROM business_book').get().c;
  if (bbCount === 0 && !process.env.ERP_DISABLE_DEMO_SEED) {
    const insertBB = db.prepare(`INSERT OR IGNORE INTO business_book (
      lead_no, lead_type, client_name, company_name, client_contact, source_of_enquiry,
      district, state, billing_address, sale_amount_without_gst, order_type, penalty_clause,
      committed_start_date, committed_delivery_date, committed_completion_date,
      employee_assigned, category, management_person_name, management_person_contact,
      customer_code, client_type, po_copy_link, boq_file_link, tpa_material_link, final_drawing_link,
      status, created_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`);

    const seedData = [
      ['SEPL20001','Private','Seema mahajan','CONSERN PHARMA','9872655005','CRR','LUDHIANA','Punjab','LUDHIANA',222000,'SITC','No','2026-01-31','2026-02-06','2026-01-10','MD SIR','Fire Fighting','Seema mahajan','9872655005','SEPLCC1341','CRR','https://drive.google.com/open?id=1N5d0ug3iobuS_v3JGvB1ie0KCFp86u4y','https://drive.google.com/open?id=1vi7Mu5mAiSS_qh7VIlc0tF8ZwDl0uVfg','https://drive.google.com/open?id=1SLLt9c0fZjwHIbu73jBz9kQEZnf3e7FH','https://drive.google.com/open?id=1n6hS884Q69rmDZVQF4dSOYcRmnaIK7SA','booked'],
      ['SEPL20002','Private','Seema mahajan','CONSERN PHARMA','9872655005','CRR','ludhiana','punjab','ludhiana',553105,'SITC','No','2026-02-02','2026-02-09','2026-02-13','MD SIR','Fire Fighting','Seema mahajan','9872655005','SEPLCC1351','CRR','https://drive.google.com/open?id=18DHkuCx7lRYPIvXwkwnh4JcLP-nt2vFA','https://drive.google.com/open?id=1TWwwaAhK6FJAHG7iVaaRFaqHnwZp6hpl','https://drive.google.com/open?id=1bbo4nUybZ1Qbw_g97ZJUmuH-PeiQtzYY','https://drive.google.com/open?id=1jACzRXmfCA7G4Uq228gBMv3SOCU3Bv1W','booked'],
      ['SEPL20003','Private','Gurpreet Sodi','V-GUARD INDUSTRIES LTD','9899900489','CRR','HARIDWAR','HARIDWAR','HARIDWAR',129537,'SITC','No','2026-02-02','2026-02-09','2026-02-13','Lovely Sharma','Fire Fighting','Gurpreet Sodi','9899900489','SEPLCC1076','CRR','https://drive.google.com/open?id=17KedC2fesfiuXaic3loCXk4aDQCPUdUv','https://drive.google.com/open?id=14alGn10sS4bXScYJL7I7xwIwckLiCLWN','https://drive.google.com/open?id=1sXE9BHLAeYZSZH6KcFOh1TqV3udKQ3Kh','https://drive.google.com/open?id=1bAwn6P1Uum8IYuVsABuI-MjXDj8_UzqE','booked'],
      ['SEPL20004','Private','Seema mahajan','CONSERN PHARMA','9872655005','CRR','LUDHIANA','PUNJAB','LUDHIANA',450000,'SITC','No','2026-02-18','2026-02-25','2026-02-28','MD Sir','Water Tank','Seema mahajan','9872655005','SEPLCC1341','CRR','https://drive.google.com/open?id=151CXGmPlvxIraatRZktdi14_6L_C4UZM','https://drive.google.com/open?id=1Ius-YG-t60UNtLS3IhsNxu_vCRKRKvp5','https://drive.google.com/open?id=16a5R9FUraZwsowphPgKbFMrnj2RSePnV','https://drive.google.com/open?id=10-J4hi8qA2_peBwBgrE_navCi83DnOk2','booked'],
      ['SEPL20005','Private','Seema mahajan','CONSERN PHARMA','9872655005','CRR','LUDHIANA','PUNJAB','LUDHIANA',825150,'SITC','Yes','2026-02-26','2026-02-28','2026-03-05','MD Sir','Electrical','Seema mahajan','9872655005','SEPLCC1351','CRR','https://drive.google.com/open?id=1EMyfEpIjbdjy_YyqCU9snSkYqLAUs64z','https://drive.google.com/open?id=1fKH-EYr9jvpEx5BmkZ200kZ9f2Pz-Ilx','https://drive.google.com/open?id=1sdr872lipYaPt_cLPbk1yXaWcd9gW9jj','https://drive.google.com/open?id=1MC6rXQ_18eFETPMGmh1yYgm5wEhOp_7l','booked'],
      ['SEPL20006','Private','Shivam Porwal','Emerald land india pvt ltd (Imperial Golf)','7906673064','Inbound','ludhiana','punjab','ludhiana',350000,'SITC','No','2026-03-06','2026-03-13','2026-03-17','Ankur sir','Fire Fighting','Shivam Porwal','7906673064','SEPLCC1380','NBD','','','','','booked'],
      ['SEPL20007','Private','Harvinder Singh','Harvinder Singh','9501106700','Inbound','LUDHIANA','PUNJAB','LUDHIANA',85000,'Supply','No','2026-03-07','2026-03-09','2026-03-12','Lovely Sharma','Fire Fighting','Harvinder Singh','9501106700','SEPLCC1381','NBD','','','','','booked'],
      ['SEPL20008','Private','Robby Ji Team','Ramana Machine','9876792561','Inbound','Ludhiana','Punjab','Punjab',1221036,'SITC','No','2026-03-18','2026-03-23','2026-03-27','Ankur sir','Solar','Robby Ji Team','9876792561','SEPLCC1379','NBD','https://drive.google.com/open?id=1BKFKpZwilobNawHsQVExISUMKJyjArNH','https://drive.google.com/open?id=1XGDf-q70qDKSaLBO1FKuq8WkliVutSzb','https://drive.google.com/open?id=1QywIKR4VCMmYqeuv0xQ1lftmmaAXN83a','https://drive.google.com/open?id=178ejMW-nUG_hVUzXRpPCq64_mzup5xYY','booked'],
      ['SEPL20009','Private','Mayank','sbj (Nirmal Products)','9877669049','Inbound','PUNJAB','Ludhiana','Ludhiana',365000,'SITC','No','2026-03-25','2026-03-30','2026-04-02','lovely sharma','Water Tank','Mayank','9877669049','SEPLCC1373','CRR','https://drive.google.com/open?id=1348oaE5eSAkDHlPqUopG8CTP-hK56cls','https://drive.google.com/open?id=1DM7NdEdvD6A22RPtjcCr20-nl0Ta24_i','https://drive.google.com/open?id=1DKovp3s0kA2I4rrW_-_IB7JQMrMyMOJK','https://drive.google.com/open?id=1OXQI4Q5Ti5Jet5PWeVE2UEJRTGrywDBx','booked'],
      ['SEPL20010','Private','Seema mahajan','CONSERN PHARMA','9872655005','CRR','LUdhiana','Punjab','LUdhiana',157500,'SITC','No','2026-04-06','2026-04-13','2026-04-16','LOVELY SHARMA','Electrical','Seema mahajan','9872655005','SEPLCC1351','CRR','https://drive.google.com/open?id=1IiI2ETQRFvdAeQNkUAEe5luvUt4sQ7PI','https://drive.google.com/open?id=1d11zaDrp6pWKjo44Y23dPV0IB_M50_2w','https://drive.google.com/open?id=1ek_Rzv1bzliP9deihSjadltH6nXF0k4T','https://drive.google.com/open?id=1lOgP_SsqFJFK--tDjbZSjkQ-mE9QILZw','booked'],
    ];

    for (const d of seedData) {
      insertBB.run(...d);
    }

    // Auto-create sites + order planning for each Business Book entry (NO POs - user enters those)
    const allBB = db.prepare('SELECT id, lead_no, client_name, company_name, project_name, category, district, state, billing_address, shipping_address, employee_assigned, management_person_name, committed_start_date, committed_completion_date FROM business_book').all();
    const insertSite = db.prepare('INSERT INTO sites (name, address, client_name, business_book_id, supervisor) VALUES (?,?,?,?,?)');
    const insertPlan = db.prepare('INSERT INTO order_planning (business_book_id, planned_start, planned_end, notes) VALUES (?,?,?,?)');

    for (const bb of allBB) {
      const siteName = bb.company_name || bb.project_name || `${bb.client_name} - ${bb.category || 'Project'}`;
      const siteAddr = bb.shipping_address || bb.billing_address || `${bb.district}, ${bb.state}`;
      insertSite.run(siteName, siteAddr, bb.client_name || bb.company_name, bb.id, bb.employee_assigned || bb.management_person_name);
      insertPlan.run(bb.id, bb.committed_start_date || null, bb.committed_completion_date || null, `Auto: ${bb.lead_no} - ${siteName}`);
    }
    console.log('Seeded 10 Business Book entries with sites (POs to be entered by user)');
  }

  // Fire NOC Renewal Module — PR1 of 7 (migrations + data model).
  // Self-contained schema lives in db/fireNocSchema.js for readability;
  // re-runs are idempotent (CREATE IF NOT EXISTS + app_settings-guarded
  // seed).  Full module plan: docs/FIRE_NOC.md.
  try {
    const { runFireNocMigrations } = require('./fireNocSchema');
    runFireNocMigrations(db);
  } catch (e) {
    console.warn('[fire_noc] migrations skipped (non-fatal):', e.message);
  }

  // Rental Tools Module — mam, 2026-05-16: 3-stage enquiry → rate →
  // material → return flow with business-hour SLAs.
  try {
    const { runRentalToolsMigrations } = require('./rentalToolsSchema');
    runRentalToolsMigrations(db);
  } catch (e) {
    console.warn('[rental_tools] migrations skipped (non-fatal):', e.message);
  }

  // Salon & Spa Module (Sotyn.Headmasters fork) — services / stylists / clients /
  // appointments / memberships / POS billing / loyalty. Self-contained schema
  // in db/salonSchema.js; idempotent + guarded demo seed.
  try {
    const { runSalonMigrations } = require('./salonSchema');
    runSalonMigrations(db);
  } catch (e) {
    console.warn('[salon] migrations skipped (non-fatal):', e.message);
  }

  // ─── Auto-DN backfill — mam (2026-06-02) ──────────────────────────────
  // "in rec. against delivery note show here ok site name also show here
  // delivery note number and against it we will upload receiving".
  // The Purchase-Bill endpoint now auto-creates a Challan DN at bill
  // upload time so a real DN number is visible in Dispatch & Receiving
  // from day one.  This backfill catches any pre-existing POs that were
  // already in the "billed but no DN" state (the AWAITING rows mam
  // showed me) and gives them DN numbers so they look identical to
  // post-fix data.
  //
  // Originally guarded with app_settings so it ran once.  Mam's first
  // post-deploy screenshot showed the table empty (0 of 0) even though
  // the tab counter said (3) — strongly suggests the guard got set on
  // an earlier deploy where vendor_po_id wasn't yet populated on the
  // purchase_bills rows.  The query is already idempotent via the NOT
  // EXISTS clause (won't touch POs that already have a DN), so it's
  // safe to run on every boot.  Dropped the guard.
  try {
    const { nextSequence } = require('./nextSequence');
    const orphanPos = db.prepare(`
      SELECT vp.id as po_id
        FROM vendor_pos vp
       WHERE COALESCE(vp.cancelled, 0) = 0
         AND EXISTS (SELECT 1 FROM purchase_bills pb WHERE pb.vendor_po_id = vp.id)
         AND NOT EXISTS (SELECT 1 FROM delivery_notes dn WHERE dn.vendor_po_id = vp.id)
    `).all();
    if (orphanPos.length > 0) {
      let created = 0;
      const today = new Date().toISOString().slice(0, 10);
      const ins = db.prepare(
        `INSERT INTO delivery_notes
            (vendor_po_id, delivery_date, document_type, document_number, status, notes)
         VALUES (?, ?, 'challan', ?, 'pending', ?)`
      );
      const tx = db.transaction(() => {
        for (const row of orphanPos) {
          const year = new Date().getFullYear();
          const dnNum = nextSequence(db, 'delivery_notes', 'document_number', `DC/${year}/`, { pad: 4 });
          ins.run(row.po_id, today, dnNum, `Auto-backfilled — bill uploaded before auto-DN feature`);
          created++;
        }
      });
      tx();
      console.log(`[auto_dn_backfill] Created ${created} placeholder Delivery Notes for billed POs without a DN.`);
    }
  } catch (e) {
    console.warn('[auto_dn_backfill] skipped (non-fatal):', e.message);
  }

  console.log('Database initialized successfully');
  return db;
}

module.exports = { getDb, initializeDatabase };
