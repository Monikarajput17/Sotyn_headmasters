// One-shot: reset the local admin password.
// Usage (from repo root):
//   node server/scripts/reset-admin-password.js              -> sets it to admin123
//   node server/scripts/reset-admin-password.js Mynewpass1   -> sets it to the arg
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'erp.db');
const newPassword = (process.argv[2] || 'admin123').trim();

if (!fs.existsSync(DB_PATH)) {
  console.error(`[reset-admin-password] erp.db not found at: ${DB_PATH}`);
  console.error('Start the server once so the DB is created + seeded, then re-run this script.');
  process.exit(1);
}

const db = new Database(DB_PATH);
const admin = db.prepare("SELECT id, name, email, username FROM users WHERE email='admin@erp.com' OR username='admin'").get();

if (!admin) {
  console.error('[reset-admin-password] No admin user found in DB. Start the server once so the seed runs.');
  process.exit(1);
}

const hash = bcrypt.hashSync(newPassword, 10);
db.prepare('UPDATE users SET password=?, active=1 WHERE id=?').run(hash, admin.id);
console.log(`[reset-admin-password] OK — admin (${admin.username || admin.email}) password set to: ${newPassword}`);
