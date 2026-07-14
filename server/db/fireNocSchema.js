// Fire NOC Renewal Module — schema (PR1 of 7).
//
// Spec: mam's task brief 2026-05-16 (Fire NOC v1).  Decisions Q1-Q6
// confirmed: SQLite tables, rupees REAL (not paise BIGINT), HTML
// print PDFs, Email + push only for outreach v1, inline contact
// columns on property, vitest for tests (PR7).  Full PR plan in
// docs/FIRE_NOC.md.
//
// All migrations idempotent: CREATE TABLE IF NOT EXISTS + CREATE
// INDEX IF NOT EXISTS + seeds guarded by app_settings flag.
//
// Schema for the 11 tables matches the spec exactly with these
// SQLite substitutions:
//   - BIGINT / SMALLINT → INTEGER  (SQLite dynamic typing)
//   - JSONB → TEXT (JSON.stringify/parse in service layer)
//   - TIMESTAMPTZ → DATETIME (ISO-8601 strings)
//   - amount_paise BIGINT → amount REAL  (rupees, per Q1)

function runFireNocMigrations(db) {
  // ── 1. fire_noc_property — building registry ────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS fire_noc_property (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER REFERENCES customers(id),
      state TEXT NOT NULL,
      building_type TEXT NOT NULL CHECK(building_type IN
        ('hospital','school','commercial','industrial','residential','hotel','mall','other')),
      building_grade TEXT CHECK(building_grade IS NULL OR building_grade IN ('A','B','C')),
      building_name TEXT,
      address TEXT,
      pincode TEXT,
      -- Decision-maker contact — inline columns per Q5 (vs. building
      -- a separate Contacts master).  Nullable until T-150 stage.
      decision_maker_name TEXT,
      decision_maker_phone TEXT,
      decision_maker_email TEXT,
      decision_maker_designation TEXT,
      ticket_size_band TEXT CHECK(ticket_size_band IS NULL OR ticket_size_band IN
        ('under_5L','5L_to_25L','25L_to_1Cr','over_1Cr')),
      source TEXT NOT NULL CHECK(source IN
        ('rti','past_client','broker','field_scrape','manual')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER REFERENCES users(id),
      updated_by INTEGER REFERENCES users(id)
    );
  `);

  // ── 2. fire_noc_cycle — one row per NOC renewal cycle ────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS fire_noc_cycle (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL REFERENCES fire_noc_property(id),
      cycle_no INTEGER NOT NULL DEFAULT 1,
      expiry_date DATE NOT NULL,
      -- State machine.  Includes the spec's 10 time-driven stages,
      -- 3 event-triggered check stages, 3 branch stages, and the
      -- closure stage.  17 total.
      current_stage TEXT NOT NULL DEFAULT 'T-180' CHECK(current_stage IN (
        'T-180','T-150','T-120',
        'RESPONSE_CHECK','REENGAGE',
        'T-90',
        'CONVERT_CHECK','LOST_POOL',
        'T-60','T-45','T-30',
        'INSPECTION_CHECK','COMPLIANCE_FIX',
        'T-15','T-0','T+30','CYCLE_CLOSE'
      )),
      stage_entered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      next_expiry_date DATE,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN
        ('active','lost','renewed','archived')),
      lost_reason TEXT,
      owner_user_id INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── 3. fire_noc_stage_history — every transition logged ──────
  // UNIQUE(cycle_id, to_stage, entered_at) gives the hourly cron
  // its idempotency guarantee.  Per spec acceptance criterion #12.
  db.exec(`
    CREATE TABLE IF NOT EXISTS fire_noc_stage_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_id INTEGER NOT NULL REFERENCES fire_noc_cycle(id),
      from_stage TEXT,
      to_stage TEXT NOT NULL,
      entered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      exited_at DATETIME,
      triggered_by TEXT NOT NULL,   -- 'auto' or string(user_id)
      notes TEXT,
      UNIQUE(cycle_id, to_stage, entered_at)
    );
  `);

  // ── 4. fire_noc_outreach — multi-channel send log ────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS fire_noc_outreach (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_id INTEGER NOT NULL REFERENCES fire_noc_cycle(id),
      -- Channel set already supports the future SMS / WhatsApp
      -- wiring (Q4).  Today only 'email' and 'in_app_push' get
      -- actually sent by the cron; 'call' and 'field_visit' are
      -- manually logged.
      channel TEXT NOT NULL CHECK(channel IN
        ('sms','email','whatsapp','in_app_push','call','field_visit')),
      direction TEXT NOT NULL CHECK(direction IN ('outbound','inbound')),
      sent_at DATETIME,
      delivered_at DATETIME,
      responded_at DATETIME,
      template_id TEXT,
      external_msg_id TEXT,
      body TEXT,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN
        ('queued','sent','delivered','failed','bounced')),
      failure_reason TEXT,           -- surfaces in module exception list
      stage_trigger TEXT,            -- which stage fired this send (for idempotency)
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      -- Idempotency: cron can re-fire T-180 outreach without dup.
      UNIQUE(cycle_id, channel, stage_trigger)
    );
  `);

  // ── 5. fire_noc_quote — quotes with maker-checker columns ────
  // PR7 enforces same-user rejection at the service layer; the
  // columns + check are seeded now so the API surface is stable.
  db.exec(`
    CREATE TABLE IF NOT EXISTS fire_noc_quote (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_id INTEGER NOT NULL REFERENCES fire_noc_cycle(id),
      version INTEGER NOT NULL CHECK(version IN (1, 2)),
      amount REAL NOT NULL DEFAULT 0,   -- rupees per Q1
      pdf_path TEXT,
      generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      generated_by INTEGER REFERENCES users(id),
      maker_user_id INTEGER REFERENCES users(id),
      checker_user_id INTEGER REFERENCES users(id),
      approved_at DATETIME,
      approved_by INTEGER REFERENCES users(id),
      accepted_at DATETIME,
      rejected_at DATETIME,
      reject_reason TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN
        ('draft','pending_approval','approved','sent','accepted','rejected')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      -- Idempotency: one quote per (cycle, version).
      UNIQUE(cycle_id, version)
    );
  `);

  // ── 6. fire_noc_document — file uploads per cycle ────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS fire_noc_document (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_id INTEGER NOT NULL REFERENCES fire_noc_cycle(id),
      kind TEXT NOT NULL CHECK(kind IN
        ('drawings','application','dept_filing_receipt','inspection_report',
         'compliance_fix_proof','noc_certificate','final_invoice')),
      file_path TEXT NOT NULL,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      uploaded_by INTEGER REFERENCES users(id),
      govt_reference_no TEXT       -- for dept filings; nullable otherwise
    );
  `);

  // ── 7. fire_noc_inspection — dept inspections ────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS fire_noc_inspection (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_id INTEGER NOT NULL REFERENCES fire_noc_cycle(id),
      scheduled_at DATETIME,
      inspector_name TEXT,
      inspector_contact TEXT,
      result TEXT NOT NULL DEFAULT 'pending' CHECK(result IN ('pending','pass','fail')),
      -- JSONB → TEXT: stores array of {item, note}.  Service layer
      -- JSON.stringify on write, JSON.parse on read.
      failure_items TEXT,
      re_inspection_of_id INTEGER REFERENCES fire_noc_inspection(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── 8. fire_noc_compliance_ticket — per-item fix tickets ─────
  db.exec(`
    CREATE TABLE IF NOT EXISTS fire_noc_compliance_ticket (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_id INTEGER NOT NULL REFERENCES fire_noc_cycle(id),
      inspection_id INTEGER NOT NULL REFERENCES fire_noc_inspection(id),
      item TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN
        ('open','in_progress','fixed','verified')),
      assignee_user_id INTEGER REFERENCES users(id),
      opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      fixed_at DATETIME,
      verified_at DATETIME,
      notes TEXT
    );
  `);

  // ── 9. fire_noc_upsell — T+30 cross-sell quotes ──────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS fire_noc_upsell (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_id INTEGER NOT NULL REFERENCES fire_noc_cycle(id),
      kind TEXT NOT NULL CHECK(kind IN ('amc','annual_audit','refilling','training')),
      quoted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      amount REAL,                -- rupees per Q1
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN
        ('queued','sent','accepted','declined','lost')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      -- Idempotency: one upsell row per (cycle, kind).
      UNIQUE(cycle_id, kind)
    );
  `);

  // ── 10. master_noc_database — lead pool from RTI etc. ────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS master_noc_database (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK(source IN
        ('rti','past_client','broker','field_scrape')),
      state TEXT NOT NULL,
      building_type TEXT,
      building_name TEXT,
      address TEXT,
      current_noc_expiry DATE,
      contact_name TEXT,
      contact_phone TEXT,
      contact_email TEXT,
      matched_property_id INTEGER REFERENCES fire_noc_property(id),
      ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ingested_by INTEGER REFERENCES users(id)
    );
  `);

  // ── 11. fire_noc_state_cycle_rule — renewal cadence lookup ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS fire_noc_state_cycle_rule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      state TEXT NOT NULL,
      building_type_filter TEXT,   -- NULL = applies to all building types
      cycle_years INTEGER NOT NULL,
      UNIQUE(state, building_type_filter)
    );
  `);

  // ── Mandatory indexes (spec requirement) ─────────────────────
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_fnc_expiry_date
      ON fire_noc_cycle(expiry_date);
    CREATE INDEX IF NOT EXISTS idx_fnc_stage_expiry
      ON fire_noc_cycle(current_stage, expiry_date);
    CREATE INDEX IF NOT EXISTS idx_fnc_status_expiry
      ON fire_noc_cycle(status, expiry_date);
    CREATE INDEX IF NOT EXISTS idx_mnd_state_expiry
      ON master_noc_database(state, current_noc_expiry);
    CREATE INDEX IF NOT EXISTS idx_fno_cycle_sent
      ON fire_noc_outreach(cycle_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_fnsh_cycle_entered
      ON fire_noc_stage_history(cycle_id, entered_at);
  `);

  // ── Seed (one-shot, guarded by app_settings) ─────────────────
  try {
    const done = db.prepare(
      "SELECT value FROM app_settings WHERE key='fire_noc_seed_v1'"
    ).get();
    if (!done) {
      // (a) state cycle rules — 8 specific + 1 default fallback.
      // Lookup rule in PR2 service: most-specific match wins
      // (state + building_type) → (state + NULL) → __DEFAULT__.
      const rules = [
        // 1-year cycle for critical-infrastructure types in UP + MH
        ['Uttar Pradesh', 'hospital', 1],
        ['Uttar Pradesh', 'school',   1],
        ['Maharashtra',   'hospital', 1],
        ['Maharashtra',   'school',   1],
        // 2-year cycle: Karnataka all
        ['Karnataka',     null, 2],
        // 3-year cycle: Delhi / Gujarat / TN all
        ['Delhi',         null, 3],
        ['Gujarat',       null, 3],
        ['Tamil Nadu',    null, 3],
        // 5-year fallback (low-risk default)
        ['__DEFAULT__',   null, 5],
      ];
      const ruleStmt = db.prepare(
        'INSERT OR IGNORE INTO fire_noc_state_cycle_rule (state, building_type_filter, cycle_years) VALUES (?, ?, ?)'
      );
      let ruleRows = 0;
      for (const [s, b, y] of rules) {
        const r = ruleStmt.run(s, b, y);
        ruleRows += r.changes;
      }

      // (b) RBAC permission keys — admin always gets the lot.
      // Sales / Sales Head rows only land if those roles exist.
      const grantToRole = (roleName, mod, fields) => {
        const role = db.prepare(
          'SELECT id FROM roles WHERE LOWER(name) = LOWER(?)'
        ).get(roleName);
        if (!role) return 0;
        const existing = db.prepare(
          'SELECT id FROM role_permissions WHERE role_id=? AND module=?'
        ).get(role.id, mod);
        if (existing) {
          // Merge — don't downgrade existing higher permissions.
          const cur = db.prepare(
            'SELECT can_view, can_create, can_edit, can_delete, can_approve, can_see_all FROM role_permissions WHERE id=?'
          ).get(existing.id);
          db.prepare(`
            UPDATE role_permissions SET
              can_view=?, can_create=?, can_edit=?,
              can_delete=?, can_approve=?, can_see_all=?
            WHERE id=?
          `).run(
            cur.can_view    || fields.can_view    || 0,
            cur.can_create  || fields.can_create  || 0,
            cur.can_edit    || fields.can_edit    || 0,
            cur.can_delete  || fields.can_delete  || 0,
            cur.can_approve || fields.can_approve || 0,
            cur.can_see_all || fields.can_see_all || 0,
            existing.id,
          );
          return 1;
        }
        db.prepare(`
          INSERT INTO role_permissions
            (role_id, module, can_view, can_create, can_edit, can_delete, can_approve, can_see_all)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          role.id, mod,
          fields.can_view    || 0,
          fields.can_create  || 0,
          fields.can_edit    || 0,
          fields.can_delete  || 0,
          fields.can_approve || 0,
          fields.can_see_all || 0,
        );
        return 1;
      };

      // Admin role always exists in this ERP — give it the full set.
      let permRows = 0;
      for (const mod of ['fire_noc', 'fire_noc_master_db']) {
        permRows += grantToRole('admin', mod, {
          can_view: 1, can_create: 1, can_edit: 1,
          can_delete: 1, can_approve: 1, can_see_all: 1,
        });
      }

      // Sales Head — full module access + master-db view + approve
      permRows += grantToRole('Sales Head', 'fire_noc', {
        can_view: 1, can_create: 1, can_edit: 1, can_approve: 1,
      });
      permRows += grantToRole('Sales Head', 'fire_noc_master_db', {
        can_view: 1,
      });
      // Sales — view + edit + advance (create), no approve
      permRows += grantToRole('Sales', 'fire_noc', {
        can_view: 1, can_create: 1, can_edit: 1,
      });
      permRows += grantToRole('Sales', 'fire_noc_master_db', {
        can_view: 1,
      });

      db.prepare(
        "INSERT INTO app_settings (key, value) VALUES ('fire_noc_seed_v1', '1')"
      ).run();
      console.log(`[migration] fire_noc_seed_v1: seeded ${ruleRows} state-cycle rules + ${permRows} permission rows`);
    }
  } catch (e) {
    console.warn('[fire_noc] seed failed (non-fatal):', e.message);
  }
}

module.exports = { runFireNocMigrations };
