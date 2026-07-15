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

  // ─── Demo seed (guarded) ──────────────────────────────────────────
  db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)');

  // Service menu modelled on Headmasters Ludhiana (headmastersludhiana.co.in) —
  // categories + services mirror their real offering. Their site lists no
  // prices ("UPTO 50% Off"), so these are realistic premium-Ludhiana estimates
  // the salon edits in Service Menu. [name, code, duration_min, price, desc]
  const HEADMASTERS_MENU = [
    ['Hair', 1, [
      ['Haircut — Women (Stylist)', 'H01', 45, 700, 'Wash, cut & blow-dry'],
      ['Haircut — Women (Creative Director)', 'H02', 60, 1500, 'Signature cut by senior artist'],
      ['Haircut — Men', 'H03', 30, 400, 'Cut & style'],
      ['Kids Haircut', 'H04', 30, 350, 'Under 10 years'],
      ['Wash & Blow-Dry', 'H05', 30, 600, 'Shampoo + blow-dry'],
      ['Hair Styling / Ironing / Tongs', 'H06', 45, 900, 'Ironing, curls or tongs'],
    ]],
    ['Hair Colour', 2, [
      ['Root Touch-Up (Ammonia-free)', 'C01', 60, 1300, 'Regrowth colour'],
      ['Global Colour — Short', 'C02', 90, 2500, 'Full-head single colour'],
      ['Global Colour — Long', 'C03', 120, 4000, 'Full-head, long hair'],
      ['Highlights — Full Head', 'C04', 150, 5500, 'Foil highlights'],
      ['Balayage / Ombre', 'C05', 180, 6500, 'Hand-painted balayage'],
      ['Fashion Colour', 'C06', 150, 4500, 'Vibrant fashion shades'],
    ]],
    ['Hair Treatments', 3, [
      ['Hair Spa', 'T01', 45, 1200, 'Deep-conditioning spa'],
      ['Keratin Treatment — Short', 'T02', 120, 5000, 'Smoothing keratin'],
      ['Keratin Treatment — Long', 'T03', 180, 8000, 'Keratin, long hair'],
      ['Smoothening — Short', 'T04', 120, 4500, 'Anti-frizz smoothening'],
      ['Hair Botox', 'T05', 120, 6000, 'Repair & shine treatment'],
      ['Hairfall / Dandruff Treatment', 'T06', 45, 1500, 'Scalp treatment'],
    ]],
    ['Skin & Facial', 4, [
      ['Clean-Up', 'S01', 30, 800, 'Express cleanse'],
      ['Fruit Facial', 'S02', 60, 1200, 'Refreshing fruit facial'],
      ['Gold Facial', 'S03', 75, 2000, 'Radiance gold facial'],
      ['Anti-Ageing Facial', 'S04', 75, 3000, 'Collagen boost'],
      ['Hydra Facial', 'S05', 75, 4000, 'Deep-hydration hydra facial'],
      ['Bleach / De-Tan (Face & Neck)', 'S06', 30, 700, 'Brightening bleach / de-tan'],
    ]],
    ['Waxing & Threading', 5, [
      ['Eyebrow Threading', 'W01', 15, 100, 'Shape & clean'],
      ['Upper Lip Threading', 'W02', 10, 60, ''],
      ['Full Arms Wax', 'W03', 30, 500, 'Honey / rica wax'],
      ['Full Legs Wax', 'W04', 40, 700, ''],
      ['Half Legs / Underarms Wax', 'W05', 20, 300, ''],
      ['Full Body Wax', 'W06', 90, 2500, 'Rica full-body wax'],
    ]],
    ['Nails', 6, [
      ['Manicure — Classic', 'N01', 45, 700, ''],
      ['Manicure — Spa', 'N02', 60, 1200, 'Luxury spa manicure'],
      ['Pedicure — Classic', 'N03', 45, 900, ''],
      ['Pedicure — Spa', 'N04', 60, 1500, 'Luxury spa pedicure'],
      ['Gel Polish', 'N05', 45, 1200, 'Long-lasting gel'],
      ['Nail Extensions', 'N06', 90, 2500, 'Acrylic / gel extensions'],
    ]],
    ['Spa & Massage', 7, [
      ['Head Massage', 'M01', 30, 600, 'Relaxing head massage'],
      ['Body Massage — 60 min', 'M02', 60, 2500, 'Full-body relaxation'],
      ['Sports Therapy', 'M03', 60, 3000, 'Deep-tissue sports massage'],
      ['Body Polishing', 'M04', 90, 3500, 'Full-body polish & glow'],
    ]],
    ['Makeup', 8, [
      ['Day / Light Makeup', 'G01', 60, 2000, 'Natural day look'],
      ['Party Makeup', 'G02', 75, 3500, 'Evening / party look'],
      ['HD Makeup', 'G03', 90, 6000, 'High-definition makeup'],
      ['Airbrush Makeup', 'G04', 90, 8000, 'Airbrush finish'],
      ['Bridal Makeup', 'G05', 150, 15000, 'Complete bridal look'],
      ['Pre-Bridal Package', 'G06', 120, 12000, 'Multi-session pre-bridal'],
    ]],
    ['Aesthetic Treatments', 9, [
      ['Laser Hair Reduction — Upper Lip', 'A01', 20, 1500, 'Per session'],
      ['Laser Hair Reduction — Full Face', 'A02', 40, 4000, 'Per session'],
      ['Laser Hair Reduction — Full Body', 'A03', 120, 12000, 'Per session'],
      ['Chemical Peel', 'A04', 45, 3000, 'Skin resurfacing peel'],
      ['Microdermabrasion', 'A05', 45, 2500, 'Exfoliating treatment'],
      ['Anti-Wrinkle (per zone)', 'A06', 30, 8000, 'Injectable, per zone'],
    ]],
    ['Eyelash & Brows', 10, [
      ['Classic Eyelash Extensions', 'E01', 90, 2500, ''],
      ['Volume Eyelash Extensions', 'E02', 120, 4000, ''],
      ['Lash Lift & Tint', 'E03', 60, 2000, ''],
      ['Eyebrow Microblading', 'E04', 90, 8000, 'Semi-permanent brows'],
    ]],
  ];
  const insertMenu = () => {
    const catStmt = db.prepare('INSERT INTO service_categories (name, sort_order) VALUES (?, ?)');
    const svcStmt = db.prepare('INSERT INTO services (category_id, name, code, duration_min, price, description) VALUES (?,?,?,?,?,?)');
    for (const [cname, order, svcs] of HEADMASTERS_MENU) {
      const c = catStmt.run(cname, order);
      for (const s of svcs) svcStmt.run(c.lastInsertRowid, ...s);
    }
  };

  const seeded = db.prepare("SELECT value FROM app_settings WHERE key='salon_seeded'").get();
  if (!seeded) {
    insertMenu();
    // Menu already at the Headmasters version → mark it so the upgrade below no-ops.
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('salon_menu_headmasters_v1', datetime('now'))").run();

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
    console.log('[salon] Headmasters service menu / stylists / plans / products seeded');
  }

  // Menu upgrade — swap the old generic demo menu for the Headmasters menu on
  // DBs seeded before it existed. Only runs while the salon hasn't billed yet,
  // so a live menu with sales history is never wiped.
  const menuFlag = db.prepare("SELECT value FROM app_settings WHERE key='salon_menu_headmasters_v1'").get();
  if (!menuFlag) {
    const hasSales = db.prepare('SELECT COUNT(*) AS c FROM pos_sales').get().c > 0;
    if (!hasSales) {
      db.exec('DELETE FROM services; DELETE FROM service_categories;');
      insertMenu();
      console.log('[salon] service menu upgraded to Headmasters Ludhiana');
    }
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('salon_menu_headmasters_v1', datetime('now'))").run();
  }
}

module.exports = { runSalonMigrations };
