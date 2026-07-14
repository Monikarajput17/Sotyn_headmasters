// One-shot: regenerate the owner emergency recovery code.
// Use this when mam has lost the code from data/RECOVERY.txt and her diary.
// Overwrites the previous hash in app_settings and rewrites RECOVERY.txt.
//
// Usage (from repo root):
//   node server/scripts/regenerate-emergency-code.js
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'erp.db');
const RECOVERY_PATH = path.join(__dirname, '..', '..', 'data', 'RECOVERY.txt');

if (!fs.existsSync(DB_PATH)) {
  console.error(`[regen] erp.db not found at ${DB_PATH}. Start the server once first.`);
  process.exit(1);
}

const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const code = Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
const hash = bcrypt.hashSync(code, 10);

const db = new Database(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('emergency_reset_hash', ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).run(hash);

const banner = [
  '================================================================',
  '  SEPL ERP - OWNER EMERGENCY RECOVERY CODE (REGENERATED)',
  '================================================================',
  '',
  `  CODE: ${code}`,
  `  REGENERATED: ${new Date().toISOString()}`,
  '',
  '  The previous emergency code is no longer valid. Save this new',
  '  one in your diary, then DELETE this file from the server:',
  `    rm ${RECOVERY_PATH}`,
  '',
  '================================================================',
  '',
].join('\n');
fs.writeFileSync(RECOVERY_PATH, banner, { encoding: 'utf-8' });
console.log(`[regen] OK — new emergency code written to ${RECOVERY_PATH}`);
console.log(`[regen] Save the code, then delete the file.`);
