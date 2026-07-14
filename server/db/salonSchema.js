// Salon & Spa Module — schema migrations (idempotent).
//
// Sotyn.Headmasters fork of the ERP. Replaces the construction domain (indent →
// BOQ → PO → DPR) with the salon domain:
//
//   service_categories / services   — the price menu (cut, colour, spa …)
//   stylists                         — staff who perform services (+ commission %)
//   salon_clients                    — individual walk-in / repeat clients
//   appointments (+ _services)       — the booking calendar
//   membership_plans                 — memberships (recurring % off) & prepaid packages
//   client_memberships               — a client's active membership / package balance
//   pos_sales (+ _items)            — the billing / invoice (services + retail products)
//   loyalty_ledger                   — points accrual / redemption trail
//
// Commissions are computed on read from pos_sale_items (no stored table) so
// they always reflect the live sales data.
//
// All CREATE TABLE IF NOT EXISTS + an app_settings-guarded demo seed, so
// re-running on every boot is safe.

function runSalonMigrations(db) {
  db.exec(`
    -- ─── Service menu ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS service_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER REFERENCES service_categories(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      code TEXT,
      duration_min INTEGER DEFAULT 30,
      price REAL DEFAULT 0,
      description TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ─── Stylists / service staff ────────────────────────────────────
    CREATE TABLE IF NOT EXISTS stylists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      specialization TEXT,
      commission_pct REAL DEFAULT 0,
      employee_id INTEGER,           -- optional link to employees(id)
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ─── Clients ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS salon_clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_code TEXT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      gender TEXT,
      dob TEXT,
      notes TEXT,
      loyalty_points INTEGER DEFAULT 0,
      total_visits INTEGER DEFAULT 0,
      total_spent REAL DEFAULT 0,
      last_visit DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_salon_clients_phone ON salon_clients(phone);

    -- ─── Appointments ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appt_no TEXT,
      client_id INTEGER REFERENCES salon_clients(id) ON DELETE SET NULL,
      stylist_id INTEGER REFERENCES stylists(id) ON DELETE SET NULL,
      appt_date TEXT NOT NULL,        -- YYYY-MM-DD
      start_time TEXT,                -- HH:MM
      end_time TEXT,                  -- HH:MM
      status TEXT DEFAULT 'booked' CHECK(status IN ('booked','confirmed','completed','cancelled','no_show')),
      notes TEXT,
      source TEXT DEFAULT 'walk-in',
      reminder_sent INTEGER DEFAULT 0,
      sale_id INTEGER,                -- set once billed
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(appt_date);

    CREATE TABLE IF NOT EXISTS appointment_services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
      service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
      stylist_id INTEGER REFERENCES stylists(id) ON DELETE SET NULL,
      service_name TEXT,
      price REAL DEFAULT 0
    );

    -- ─── Memberships & prepaid packages ──────────────────────────────
    CREATE TABLE IF NOT EXISTS membership_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      plan_type TEXT DEFAULT 'membership' CHECK(plan_type IN ('membership','package')),
      price REAL DEFAULT 0,
      validity_days INTEGER DEFAULT 365,
      discount_pct REAL DEFAULT 0,        -- membership: % off every bill
      services_json TEXT,                 -- package: JSON [{service_id, qty}]
      description TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS client_memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES salon_clients(id) ON DELETE CASCADE,
      plan_id INTEGER REFERENCES membership_plans(id) ON DELETE SET NULL,
      plan_name TEXT,
      plan_type TEXT,
      discount_pct REAL DEFAULT 0,
      start_date TEXT,
      end_date TEXT,
      remaining_json TEXT,                -- package: JSON [{service_id, name, remaining}]
      status TEXT DEFAULT 'active' CHECK(status IN ('active','expired','used','cancelled')),
      sale_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_client_memberships_client ON client_memberships(client_id);

    -- ─── Billing / POS ───────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS pos_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no TEXT,
      client_id INTEGER REFERENCES salon_clients(id) ON DELETE SET NULL,
      appointment_id INTEGER,
      client_membership_id INTEGER,
      subtotal REAL DEFAULT 0,
      discount REAL DEFAULT 0,
      discount_reason TEXT,
      tax_pct REAL DEFAULT 0,
      tax REAL DEFAULT 0,
      total REAL DEFAULT 0,
      payment_mode TEXT DEFAULT 'cash',
      points_earned INTEGER DEFAULT 0,
      points_redeemed INTEGER DEFAULT 0,
      status TEXT DEFAULT 'paid' CHECK(status IN ('paid','unpaid','refunded')),
      notes TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pos_sales_date ON pos_sales(created_at);
    CREATE INDEX IF NOT EXISTS idx_pos_sales_client ON pos_sales(client_id);

    CREATE TABLE IF NOT EXISTS pos_sale_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
      item_type TEXT DEFAULT 'service' CHECK(item_type IN ('service','product')),
      service_id INTEGER,
      name TEXT,
      stylist_id INTEGER REFERENCES stylists(id) ON DELETE SET NULL,
      qty REAL DEFAULT 1,
      unit_price REAL DEFAULT 0,
      line_total REAL DEFAULT 0,
      commission_pct REAL DEFAULT 0,
      commission_amount REAL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pos_sale_items_sale ON pos_sale_items(sale_id);
    CREATE INDEX IF NOT EXISTS idx_pos_sale_items_stylist ON pos_sale_items(stylist_id);

    -- ─── Loyalty ledger ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS loyalty_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES salon_clients(id) ON DELETE CASCADE,
      delta INTEGER NOT NULL,
      balance INTEGER,
      reason TEXT,
      sale_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_loyalty_ledger_client ON loyalty_ledger(client_id);

    -- Retail products sold at the counter (shampoo, serum, etc.). Simple
    -- single-location stock — deducted automatically when sold via POS.
    CREATE TABLE IF NOT EXISTS salon_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sku TEXT,
      brand TEXT,
      price REAL DEFAULT 0,
      cost REAL DEFAULT 0,
      stock_qty REAL DEFAULT 0,
      reorder_level REAL DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Salon-wide settings (loyalty rate, tax %, currency). Single row id=1.
    CREATE TABLE IF NOT EXISTS salon_settings (
      id INTEGER PRIMARY KEY CHECK(id=1),
      salon_name TEXT DEFAULT 'Sotyn.Headmasters',
      currency TEXT DEFAULT '₹',
      default_tax_pct REAL DEFAULT 18,
      points_per_currency REAL DEFAULT 0.05,   -- points earned per ₹1 spent
      point_value REAL DEFAULT 1,              -- ₹ value of 1 point on redemption
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Link a sold line to a retail product (nullable) so POS can deduct stock.
  // Guarded ALTER — pos_sale_items already exists on dev DBs from before this.
  try { db.exec('ALTER TABLE pos_sale_items ADD COLUMN product_id INTEGER'); } catch (_) {}

  db.prepare('INSERT OR IGNORE INTO salon_settings (id) VALUES (1)').run();

  // ─── One-time demo seed (guarded) ──────────────────────────────────
  db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)');
  const seeded = db.prepare("SELECT value FROM app_settings WHERE key='salon_seeded'").get();
  if (!seeded) {
    const catStmt = db.prepare('INSERT INTO service_categories (name, sort_order) VALUES (?, ?)');
    const svcStmt = db.prepare('INSERT INTO services (category_id, name, code, duration_min, price, description) VALUES (?,?,?,?,?,?)');
    const cats = [
      ['Hair', 1, [
        ['Haircut — Women', 'SVC-H01', 45, 600, 'Wash, cut & blow-dry'],
        ['Haircut — Men', 'SVC-H02', 30, 300, 'Cut & style'],
        ['Hair Colour — Global', 'SVC-H03', 120, 2500, 'Full-head global colour'],
        ['Highlights', 'SVC-H04', 150, 3500, 'Foil highlights'],
        ['Hair Spa', 'SVC-H05', 60, 1200, 'Deep-conditioning spa'],
        ['Keratin Treatment', 'SVC-H06', 180, 5000, 'Smoothing keratin'],
      ]],
      ['Skin & Facial', 2, [
        ['Classic Facial', 'SVC-S01', 60, 1500, 'Cleanse, scrub, mask'],
        ['Anti-Ageing Facial', 'SVC-S02', 75, 2500, 'Collagen boost'],
        ['Clean-up', 'SVC-S03', 30, 700, 'Express clean-up'],
      ]],
      ['Nails', 3, [
        ['Manicure', 'SVC-N01', 45, 800, 'Classic manicure'],
        ['Pedicure', 'SVC-N02', 60, 1000, 'Spa pedicure'],
        ['Gel Polish', 'SVC-N03', 45, 1200, 'Long-lasting gel'],
      ]],
      ['Spa & Massage', 4, [
        ['Body Massage — 60 min', 'SVC-M01', 60, 2000, 'Relaxation massage'],
        ['Body Polishing', 'SVC-M02', 90, 3000, 'Full-body polish'],
      ]],
      ['Makeup & Grooming', 5, [
        ['Party Makeup', 'SVC-G01', 90, 3500, 'Occasion makeup'],
        ['Threading', 'SVC-G02', 15, 100, 'Eyebrow threading'],
        ['Waxing — Full Arms', 'SVC-G03', 30, 500, 'Full-arm wax'],
      ]],
    ];
    for (const [cname, order, svcs] of cats) {
      const c = catStmt.run(cname, order);
      for (const s of svcs) svcStmt.run(c.lastInsertRowid, ...s);
    }

    const styStmt = db.prepare('INSERT INTO stylists (name, phone, specialization, commission_pct) VALUES (?,?,?,?)');
    styStmt.run('Priya Sharma', '9800000001', 'Hair & Colour', 15);
    styStmt.run('Anjali Verma', '9800000002', 'Skin & Facials', 12);
    styStmt.run('Rahul Mehta', '9800000003', 'Hair — Men', 10);
    styStmt.run('Neha Kapoor', '9800000004', 'Nails & Spa', 12);

    const planStmt = db.prepare('INSERT INTO membership_plans (name, plan_type, price, validity_days, discount_pct, description) VALUES (?,?,?,?,?,?)');
    planStmt.run('Gold Membership', 'membership', 5000, 365, 15, '15% off every service for 1 year');
    planStmt.run('Silver Membership', 'membership', 2500, 180, 10, '10% off every service for 6 months');

    const prodStmt = db.prepare('INSERT INTO salon_products (name, sku, brand, price, cost, stock_qty, reorder_level) VALUES (?,?,?,?,?,?,?)');
    prodStmt.run('Shampoo — Smooth 250ml', 'PRD-001', 'Loreal', 650, 400, 24, 6);
    prodStmt.run('Conditioner — Smooth 250ml', 'PRD-002', 'Loreal', 700, 430, 18, 6);
    prodStmt.run('Hair Serum 100ml', 'PRD-003', 'Streax', 450, 260, 12, 4);
    prodStmt.run('Hair Colour Kit', 'PRD-004', 'Garnier', 350, 200, 30, 8);
    prodStmt.run('Nail Polish', 'PRD-005', 'Lakme', 250, 120, 40, 10);

    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('salon_seeded', datetime('now'))").run();
    console.log('[salon] demo services / stylists / membership plans / products seeded');
  }
}

module.exports = { runSalonMigrations };
