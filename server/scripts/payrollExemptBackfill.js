// One-time backfill — mark the 7 always-full-salary employees as
// exempt from attendance-driven payroll deductions.  Mam (2026-06-01):
//
//   "in this Parul goyal, Rajat sir, Nitin Jain, Ankur kaplesh,
//    Pooja Kaplesh (75000), D.S Kaplesh (25000), Soma kaplesh (50000)
//    this person every month make salary full"
//
// These are family / leadership rows that get a flat monthly salary
// regardless of attendance log shortfalls.  The salary_exempt flag
// short-circuits calculateForEmployee() to skip all paid-day /
// half-day / late / leave logic and return base salary as net pay.
//
// Idempotent via app_settings.payroll_exempt_backfill_v1.  Matches
// by case-insensitive name LIKE so minor spelling drift in the
// employees table doesn't miss anyone.  Logs every match + every
// miss so admin can reconcile manually.

const { getDb } = require('../db/schema');

const FLAG_KEY = 'payroll_exempt_backfill_v1';
// Each entry's `match` is the LIKE pattern.  Wider patterns catch
// "D.S Kaplesh" vs "D S Kaplesh" vs "DS Kaplesh".
const EXEMPT_LIST = [
  { match: '%parul%goyal%',   why: 'mam directive 2026-06-01' },
  { match: '%rajat%',         why: 'mam directive 2026-06-01 (Rajat Sir)' },
  { match: '%nitin%jain%',    why: 'mam directive 2026-06-01' },
  { match: '%ankur%kaplesh%', why: 'mam directive 2026-06-01' },
  { match: '%pooja%kaplesh%', why: 'mam directive 2026-06-01 (Rs 75,000)' },
  { match: '%kaplesh%',       why: 'D.S Kaplesh + Soma Kaplesh — broad family match' },
];

function runOnce() {
  if (process.env.ERP_DISABLE_PAYROLL_EXEMPT_BACKFILL === '1') return;
  const db = getDb();
  try { db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)`); } catch (_) {}
  const flag = db.prepare('SELECT value FROM app_settings WHERE key=?').get(FLAG_KEY);
  if (flag) return;

  // Ensure the column exists (idempotent ALTER added to schema.js;
  // belt-and-braces here so a stale prod schema doesn't crash us).
  try { db.exec(`ALTER TABLE employees ADD COLUMN salary_exempt INTEGER DEFAULT 0`); } catch (_) {}

  const find = db.prepare('SELECT id, name FROM employees WHERE LOWER(name) LIKE ?');
  const upd = db.prepare('UPDATE employees SET salary_exempt = 1 WHERE id = ?');

  let totalMarked = 0;
  const matchedNames = new Set();   // dedupe — a "%kaplesh%" + "%pooja%kaplesh%" overlap
  const misses = [];

  for (const e of EXEMPT_LIST) {
    const rows = find.all(e.match);
    if (rows.length === 0) misses.push(e.match);
    for (const r of rows) {
      if (matchedNames.has(r.id)) continue;
      upd.run(r.id);
      matchedNames.add(r.id);
      totalMarked++;
      console.log(`[payroll-exempt] ✓ ${r.name} (id ${r.id}) · ${e.why}`);
    }
  }

  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
    .run(FLAG_KEY, new Date().toISOString());

  console.log(`[payroll-exempt] DONE · ${totalMarked} employees marked salary_exempt=1`);
  if (misses.length) {
    console.log(`[payroll-exempt] WARN · ${misses.length} patterns had no match:`, misses.join(', '));
    console.log('[payroll-exempt]   admin to add the missing employees manually and flip the flag via SQL.');
  }
}

module.exports = { runOnce };
