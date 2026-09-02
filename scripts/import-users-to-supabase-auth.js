// One-off: create a Supabase Auth account for every ERP user that doesn't
// have one yet, importing the EXISTING bcrypt password hash (Supabase Auth
// accepts bcrypt via admin.createUser({ password_hash })). Nobody's password
// changes; users log in exactly as before. Links users.auth_user_id.
//
// Requires in .env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL
// Usage: node scripts/import-users-to-supabase-auth.js
require('dotenv').config();
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env'); process.exit(1); }
const admin = createClient(URL_, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const authEmailFor = (r) => (r.email && r.email.includes('@')) ? r.email.trim().toLowerCase()
  : `${(r.username || `user${r.id}`).toLowerCase().replace(/[^a-z0-9._-]/g, '')}@users.headmasters.local`;

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const { rows } = await c.query('SELECT id, name, email, username, password, active, archived, auth_user_id FROM users ORDER BY id');
  const existing = new Map();
  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    for (const u of data.users) existing.set((u.email || '').toLowerCase(), u.id);
    if (data.users.length < 1000) break;
    page++;
  }
  let created = 0, linked = 0, skipped = 0;
  for (const r of rows) {
    if (r.auth_user_id) { skipped++; continue; }
    const email = authEmailFor(r);
    let authId = existing.get(email);
    if (!authId) {
      if (!r.password || !/^\$2[aby]\$/.test(r.password)) { console.log(`  skip #${r.id} ${r.username || r.email}: no bcrypt hash`); skipped++; continue; }
      const { data, error } = await admin.auth.admin.createUser({
        email, email_confirm: true, password_hash: r.password, user_metadata: { erp_user_id: r.id, name: r.name },
      });
      if (error) { console.log(`  FAILED #${r.id} ${email}: ${error.message}`); continue; }
      authId = data.user.id; created++;
    } else linked++;
    await c.query('UPDATE users SET auth_user_id=$1 WHERE id=$2', [authId, r.id]);
    console.log(`  #${r.id} ${r.username || r.email} → ${authId}`);
  }
  console.log(`done: created ${created}, linked-existing ${linked}, skipped ${skipped}, total ${rows.length}`);
  await c.end();
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
