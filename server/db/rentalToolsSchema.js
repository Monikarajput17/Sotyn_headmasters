// Rental Tools Module — schema migrations (idempotent).
//
// Mam (2026-05-16) spec:
//   Raise enquiry fields: site name, date of requirement, days required,
//                         site engineer name
//   Stage 1 — Finalise Rate  (Ajmer only; finalises vendor + rate;
//                             auto-creates PO; target 5 BUSINESS hours)
//   Stage 2 — Material at site (site engineer uploads live photo+GPS;
//                               alert 1 day if not received)
//   Stage 3 — Return to vendor (Ajmer signs off; target date =
//                               material_received + days_required,
//                               counted as business days)
//
// Business-day rules across all SLAs:
//   - After 17:00 doesn't count → rolls to next day
//   - Sundays don't count → rolls to Monday
//
// Tables:
//   rental_tool_enquiry        — one row per enquiry
//   rental_tool_history        — stage_history audit trail
//
// Foreign keys:
//   - site_id          → sites(id)         (nullable; free text site_name kept too)
//   - site_engineer_id → users(id)
//   - vendor_id        → vendors(id)
//   - po_id            → purchase_orders(id)  (set after Stage 1 auto-PO)
//
// Status semantics:
//   open   → enquiry in flight (any stage 0..2)
//   closed → returned + signed (stage 3 complete)
//   cancelled → mam / Ajmer aborted

function runRentalToolsMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rental_tool_enquiry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enquiry_no TEXT UNIQUE,                          -- RT-YYYY-NNNN
      site_id INTEGER REFERENCES sites(id),
      site_name TEXT NOT NULL,
      tool_description TEXT,                           -- "scissor lift 12m" etc.
      date_of_requirement DATE NOT NULL,
      days_required INTEGER NOT NULL CHECK(days_required > 0),
      site_engineer_id INTEGER REFERENCES users(id),
      site_engineer_name TEXT,
      current_stage TEXT NOT NULL DEFAULT 'enquiry' CHECK(current_stage IN
        ('enquiry','rate_finalised','material_received','returned')),
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN
        ('open','closed','cancelled')),

      -- Stage 1: rate finalisation
      vendor_id INTEGER REFERENCES vendors(id),
      vendor_name TEXT,
      vendor_rate REAL,
      vendor_rate_unit TEXT DEFAULT 'per_day',         -- per_day / per_hour / lumpsum
      po_id INTEGER REFERENCES purchase_orders(id),
      po_number TEXT,
      rate_finalised_at DATETIME,
      rate_finalised_by INTEGER REFERENCES users(id),  -- should be Ajmer
      stage1_target_at DATETIME,                       -- enquiry_at + 5 biz hrs
      stage1_breached INTEGER DEFAULT 0,

      -- Stage 2: material at site
      material_received_at DATETIME,
      material_received_photo TEXT,                    -- relative URL
      material_received_lat REAL,
      material_received_lng REAL,
      stage2_target_at DATETIME,                       -- date_of_requirement + 1 biz day
      stage2_breached INTEGER DEFAULT 0,

      -- Stage 3: return
      return_target_date DATE,                         -- material_received + days_required (biz days)
      returned_at DATETIME,
      return_signed_by INTEGER REFERENCES users(id),   -- should be Ajmer
      return_signed_at DATETIME,
      return_notes TEXT,
      stage3_breached INTEGER DEFAULT 0,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER REFERENCES users(id)
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_rental_tool_enquiry_status ON rental_tool_enquiry(status, current_stage)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rental_tool_enquiry_site   ON rental_tool_enquiry(site_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rental_tool_enquiry_sla    ON rental_tool_enquiry(stage1_target_at, stage2_target_at)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS rental_tool_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enquiry_id INTEGER NOT NULL REFERENCES rental_tool_enquiry(id) ON DELETE CASCADE,
      from_stage TEXT,
      to_stage TEXT NOT NULL,
      triggered_by TEXT,                               -- user id OR 'system'
      notes TEXT,
      entered_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rental_tool_history_enquiry ON rental_tool_history(enquiry_id, entered_at)`);

  // RBAC seed — give admin + site_engineer roles default access; mam
  // can fine-tune in Roles & Permissions later.  Idempotent INSERT OR
  // IGNORE on (role_id, module).
  const seedFlag = db.prepare(`SELECT value FROM app_settings WHERE key=?`).get('rental_tools_rbac_seed_v1');
  if (!seedFlag) {
    try {
      const roles = db.prepare(`SELECT id, name FROM roles`).all();
      const insertPerm = db.prepare(`
        INSERT OR IGNORE INTO role_permissions
          (role_id, module, can_view, can_create, can_edit, can_delete, can_approve, can_see_all)
        VALUES (?, 'rental_tools', ?, ?, ?, ?, ?, ?)
      `);
      roles.forEach(r => {
        const n = (r.name || '').toLowerCase();
        if (n === 'admin') {
          insertPerm.run(r.id, 1, 1, 1, 1, 1, 1);
        } else if (n.includes('engineer') || n.includes('site')) {
          insertPerm.run(r.id, 1, 1, 1, 0, 0, 0);
        } else if (n.includes('director') || n.includes('cmd') || n.includes('coo')) {
          insertPerm.run(r.id, 1, 0, 0, 0, 1, 1);
        }
      });
      db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`)
        .run('rental_tools_rbac_seed_v1', new Date().toISOString());
    } catch (e) {
      console.warn('[rental_tools] RBAC seed skipped:', e.message);
    }
  }
}

module.exports = { runRentalToolsMigrations };
