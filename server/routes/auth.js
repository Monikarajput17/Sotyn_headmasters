const express = require('express');
const bcrypt = require('bcryptjs');
const pg = require('../db/pg');
const { generateToken, authMiddleware, adminOnly, getUserPermissions } = require('../middleware/auth');
const router = express.Router();

router.post('/login', async (req, res) => {
  // Accept either `username` or `email` as the identifier. Historical clients
  // send `email`; the new login UI sends `username` which may actually be a
  // username OR an email — we match against both columns.
  const { username, email, password } = req.body;
  const identifier = (username || email || '').trim();
  const { logAuditEvent } = require('../middleware/audit');
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || null;
  const ua = req.headers['user-agent'] || null;
  if (!identifier || !password) return res.status(400).json({ error: 'Username/email and password required' });
  try {
    // Look up regardless of `active` so we can return a distinct message when
    // the account is disabled vs. when the password is wrong — otherwise mam
    // can't tell why she's locked out.
    // Match ALL rows for this identifier, then pick the one whose password
    // actually matches. Duplicate usernames have existed (e.g. two 'vijay.kumar'),
    // and a single-row lookup could return the WRONG row — rejecting a correct
    // password ("invalid credentials") or logging the person into someone else's
    // account (seeing the other user's data). mam 2026-06-27.
    const candidates = await pg.all(
      'SELECT * FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)', identifier, identifier
    );
    // Among EVERY row whose password matches, prefer an ACTIVE account. A disabled
    // duplicate (same username + same password — e.g. an old deactivated row, or a
    // shared office default like 'sepl@123') would otherwise be picked first and
    // wrongly report "account disabled", locking a valid user out (mam 2026-06-27).
    const matches = candidates.filter(u => u.password && bcrypt.compareSync(password, u.password));
    const user = matches.find(u => u.active !== 0) || matches[0] || null;
    if (user && user.active === 0) {
      logAuditEvent({
        action: 'LOGIN_FAIL', entity_type: 'auth', entity_label: identifier,
        method: 'POST', path: '/api/auth/login', status_code: 403, ip, user_agent: ua,
      });
      return res.status(403).json({ error: 'Your account is disabled. Please contact admin.' });
    }
    if (!user) {
      // Log failed login attempts so admin can spot brute-force patterns.
      logAuditEvent({
        action: 'LOGIN_FAIL', entity_type: 'auth', entity_label: identifier,
        method: 'POST', path: '/api/auth/login', status_code: 401, ip, user_agent: ua,
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = generateToken(user);
    const permissions = await getUserPermissions(user.id);
    const userRoles = await pg.all('SELECT r.name FROM roles r JOIN user_roles ur ON r.id=ur.role_id WHERE ur.user_id=?', user.id);
    // Successful login — record user + ip + UA for session tracking.
    logAuditEvent({
      user: { id: user.id, name: user.name, role: user.role },
      action: 'LOGIN', entity_type: 'auth', entity_id: user.id, entity_label: user.name,
      method: 'POST', path: '/api/auth/login', status_code: 200, ip, user_agent: ua,
    });
    res.json({
      token,
      user: {
        id: user.id, name: user.name, email: user.email, username: user.username,
        role: user.role, department: user.department, phone: user.phone,
        // L1/L2 indent approval role (mam's 2026-05-26 spec). 'l1' = Nitin
        // Jain ji, 'l2' = Nitin Sir, NULL = ordinary user. Procurement UI
        // uses this to decide whether to show Approve L1 / L2 buttons.
        approval_role: user.approval_role || null,
        avatar_url: user.avatar_url || null,
        // Frontend uses this to force a "set recovery code" modal on first
        // login, guaranteeing every user can self-recover later.
        has_recovery_code: !!user.recovery_code_hash,
      },
      permissions,
      userRoles: userRoles.map(r => r.name)
    });
  } catch (e) {
    console.error('[auth login] failed:', e.message);
    res.status(500).json({ error: 'Login failed — please try again' });
  }
});

router.post('/register', authMiddleware, adminOnly, async (req, res) => {
  const { name, email, username, password, role, department, phone, role_ids, avatar_url } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });
  // Reject duplicates case-insensitively. `email` has a (case-sensitive) UNIQUE
  // index but `username`'s unique index is case-insensitive — guard both here
  // so the error is friendly instead of a raw constraint failure (mam 2026-06-27).
  const uname = username ? username.trim() : null;
  try {
    if (await pg.get('SELECT id FROM users WHERE LOWER(email)=LOWER(?)', email)) {
      return res.status(409).json({ error: 'Email already exists' });
    }
    if (uname && await pg.get('SELECT id FROM users WHERE LOWER(username)=LOWER(?)', uname)) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    const hash = bcrypt.hashSync(password, 10);
    const result = await pg.run('INSERT INTO users (name, email, username, password, role, department, phone, avatar_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      name, email, uname, hash, role || 'user', department || null, phone || null,
      avatar_url ? String(avatar_url).trim() : null);

    // Assign roles
    if (role_ids && role_ids.length > 0) {
      for (const rid of role_ids) {
        await pg.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?) ON CONFLICT DO NOTHING', result.lastInsertRowid, rid);
      }
    }

    const user = await pg.get('SELECT id, name, email, username, role, department, phone FROM users WHERE id = ?', result.lastInsertRowid);
    res.status(201).json({ user, message: 'User created successfully' });
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      const msg = e.message.includes('username') ? 'Username already taken' : 'Email already exists';
      return res.status(409).json({ error: msg });
    }
    res.status(500).json({ error: e.message });
  }
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await pg.get('SELECT id, name, email, username, role, department, phone, recovery_code_hash, approval_role, avatar_url FROM users WHERE id = ?', req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const has_recovery_code = !!user.recovery_code_hash;
    delete user.recovery_code_hash;
    const permissions = await getUserPermissions(req.user.id);
    const userRoles = await pg.all('SELECT r.name FROM roles r JOIN user_roles ur ON r.id=ur.role_id WHERE ur.user_id=?', req.user.id);
    res.json({ ...user, has_recovery_code, permissions, userRoles: userRoles.map(r => r.name) });
  } catch (e) {
    console.error('[auth me] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Set / clear the signed-in user's profile photo (WhatsApp-style avatar).
// The client uploads the file via /api/upload first, then posts the URL here.
// Pass avatar_url:null (or empty) to remove the photo.
router.post('/avatar', authMiddleware, async (req, res) => {
  try {
    const url = req.body?.avatar_url ? String(req.body.avatar_url).trim() : null;
    await pg.run('UPDATE users SET avatar_url=? WHERE id=?', url, req.user.id);
    res.json({ avatar_url: url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Export all ACTIVE users to Excel, with salary (and designation) pulled from
// the employees table — matched by user link first, else by name (mam
// 2026-06-27: "all active users in Excel, salary from employees").
router.get('/users/export.xlsx', authMiddleware, adminOnly, async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const rows = await pg.all(`
      SELECT u.name, u.email, u.username, u.role, u.department, u.phone,
             COALESCE(
               (SELECT e.salary FROM employees e WHERE e.user_id = u.id ORDER BY e.id DESC LIMIT 1),
               (SELECT e.salary FROM employees e WHERE LOWER(TRIM(e.name)) = LOWER(TRIM(u.name)) ORDER BY e.id DESC LIMIT 1),
               0
             ) AS salary,
             COALESCE(
               (SELECT e.designation FROM employees e WHERE e.user_id = u.id ORDER BY e.id DESC LIMIT 1),
               (SELECT e.designation FROM employees e WHERE LOWER(TRIM(e.name)) = LOWER(TRIM(u.name)) ORDER BY e.id DESC LIMIT 1)
             ) AS designation
        FROM users u
       WHERE COALESCE(u.active, 1) = 1
       ORDER BY LOWER(u.name)
    `);
    const header = ['Name', 'Email', 'Username', 'Role', 'Department', 'Designation', 'Phone', 'Salary (₹)'];
    const aoa = [header, ...rows.map(r => [
      r.name || '', r.email || '', r.username || '', r.role || '', r.department || '',
      r.designation || '', r.phone || '', +r.salary || 0,
    ])];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 24 }, { wch: 28 }, { wch: 18 }, { wch: 10 }, { wch: 18 }, { wch: 20 }, { wch: 14 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Active Users');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="active-users-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buf);
  } catch (e) {
    console.error('[users export] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Org hierarchy — every active user with their reporting manager (mam
// 2026-06-27: War Room "Hierarchy" tab). Placed before GET /users/:id-style
// routes so 'hierarchy' isn't swallowed as an id.
router.get('/users/hierarchy', authMiddleware, async (req, res) => {
  try {
    const rows = await pg.all(`
      SELECT u.id, u.name, u.role, u.department, u.manager_id, u.avatar_url, m.name AS manager_name,
             COALESCE(
               (SELECT e.designation FROM employees e WHERE e.user_id = u.id ORDER BY e.id DESC LIMIT 1),
               (SELECT e.designation FROM employees e WHERE LOWER(TRIM(e.name)) = LOWER(TRIM(u.name)) ORDER BY e.id DESC LIMIT 1)
             ) AS designation
        FROM users u
        LEFT JOIN users m ON m.id = u.manager_id
       WHERE COALESCE(u.active, 1) = 1
       ORDER BY LOWER(u.name)`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Set a user's reporting manager (admin only). Guards self-reference + loops.
router.put('/users/:id/manager', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = +req.params.id;
    let mgr = req.body.manager_id;
    mgr = (mgr === '' || mgr == null) ? null : +mgr;
    if (mgr === id) return res.status(400).json({ error: 'A user cannot report to themselves.' });
    if (mgr != null) {
      let cur = mgr, hops = 0;
      while (cur != null && hops++ < 100) {
        if (cur === id) return res.status(400).json({ error: 'That would create a reporting loop.' });
        cur = (await pg.get('SELECT manager_id FROM users WHERE id=?', cur))?.manager_id ?? null;
      }
    }
    await pg.run('UPDATE users SET manager_id=? WHERE id=?', mgr, id);
    res.json({ message: 'Saved', id, manager_id: mgr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/users', authMiddleware, async (req, res) => {
  try {
    // Mam (2026-05-22): "I NEED DATA NOT DELETE PREVIOUS BUT IN FUTURE
    // WHEN I ENTRY SHOW THIS NAME TO ASSIGN IN DATA WHICH IS INACTIVE"
    // — ex-employees should NOT appear in assignment pickers but their
    // historical records must stay intact.  Caller passes ?active_only=1
    // to get only currently-active users.  User Management page (admin)
    // omits the param so it can still see + manage inactives.
    const activeOnly = req.query.active_only === '1';
    const whereClause = activeOnly ? 'WHERE u.active = 1' : '';
    const users = await pg.all(`
      SELECT u.id, u.name, u.email, u.username, u.role, u.department, u.phone, u.active, u.avatar_url,
             COALESCE(u.track_location, 1) as track_location, COALESCE(u.archived, 0) as archived, u.created_at, u.approval_role,
      STRING_AGG(r.name, ',') as role_names
      FROM users u
      LEFT JOIN user_roles ur ON u.id = ur.user_id
      LEFT JOIN roles r ON ur.role_id = r.id
      ${whereClause}
      GROUP BY u.id ORDER BY u.name
    `);
    res.json(users);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Toggle tracking opt-out per user (admin-only). Used by the small switch
// next to each user in User Management. PATCH so it doesn't disturb the
// rest of the user record.
router.patch('/users/:id/track-location', authMiddleware, adminOnly, async (req, res) => {
  try {
    const v = req.body?.track_location ? 1 : 0;
    await pg.run('UPDATE users SET track_location=? WHERE id=?', v, req.params.id);
    res.json({ message: v ? 'Tracking enabled for this user' : 'Tracking disabled for this user', track_location: v });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Archive / restore a user (admin only). mam 2026-07-02: a safe alternative to
// Delete for a user who has attendance/salary history — archiving HIDES them from
// every list and assignment picker and blocks login, but keeps every record (no
// data is deleted). Archiving also deactivates; restoring clears the archive but
// leaves them inactive so the admin re-activates deliberately.
router.patch('/users/:id/archive', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = +req.params.id;
    if (id === req.user.id) return res.status(400).json({ error: "You can't archive your own account." });
    const target = await pg.get('SELECT id, name FROM users WHERE id=?', id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const arch = req.body?.archived ? 1 : 0;
    if (arch) await pg.run('UPDATE users SET archived=1, active=0 WHERE id=?', id);
    else await pg.run('UPDATE users SET archived=0 WHERE id=?', id);
    res.json({ message: arch ? `"${target.name}" archived — hidden from lists, all data kept` : `"${target.name}" restored to the Inactive list`, archived: arch });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update user (admin only)
router.put('/users/:id', authMiddleware, adminOnly, async (req, res) => {
  const { name, email, username, department, phone, role, active, role_ids, password, approval_role, avatar_url } = req.body;

  try {
    const uname = username !== undefined ? (username ? String(username).trim() : null) : undefined;
    // Block duplicate usernames case-INSENSITIVELY before writing, so an admin
    // edit can't set 'Vijay.Kumar' while 'vijay.kumar' exists — re-introducing
    // the duplicate-login bug. register already guards this way; PUT must too
    // (mam 2026-06-27).
    if (uname) {
      const clash = await pg.get('SELECT id FROM users WHERE LOWER(username)=LOWER(?) AND id<>?', uname, req.params.id);
      if (clash) return res.status(409).json({ error: 'Username already taken' });
    }
    if (uname !== undefined) {
      if (password) {
        await pg.run('UPDATE users SET name=?, email=?, username=?, department=?, phone=?, role=?, active=?, password=? WHERE id=?',
          name, email, uname, department, phone, role, active ? 1 : 0, bcrypt.hashSync(password, 10), req.params.id);
      } else {
        await pg.run('UPDATE users SET name=?, email=?, username=?, department=?, phone=?, role=?, active=? WHERE id=?',
          name, email, uname, department, phone, role, active ? 1 : 0, req.params.id);
      }
    } else if (password) {
      await pg.run('UPDATE users SET name=?, email=?, department=?, phone=?, role=?, active=?, password=? WHERE id=?',
        name, email, department, phone, role, active ? 1 : 0, bcrypt.hashSync(password, 10), req.params.id);
    } else {
      await pg.run('UPDATE users SET name=?, email=?, department=?, phone=?, role=?, active=? WHERE id=?',
        name, email, department, phone, role, active ? 1 : 0, req.params.id);
    }
    // Indent approval role (mam 2026-05-28: Nitin Jain couldn't approve
    // L1 because his approval_role was never set — the boot-time seed
    // only auto-tags on first run with a NULL value, no admin UI to fix
    // after). Accept 'l1' | 'l2' | null/'' to clear. Sent separately so
    // omitting the field doesn't clobber an existing assignment.
    if (approval_role !== undefined) {
      const VALID = ['l1', 'l2', 'hr'];
      const cleaned = approval_role && VALID.includes(approval_role) ? approval_role : null;
      await pg.run('UPDATE users SET approval_role=? WHERE id=?', cleaned, req.params.id);
    }
    // Employee photo (mam 2026-06-23): admin can set/clear any user's avatar
    // from User Management. Sent separately so omitting it doesn't wipe it.
    if (avatar_url !== undefined) {
      await pg.run('UPDATE users SET avatar_url=? WHERE id=?', avatar_url ? String(avatar_url).trim() : null, req.params.id);
    }
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      const msg = e.message.includes('username') ? 'Username already taken' : 'Email already exists';
      return res.status(409).json({ error: msg });
    }
    return res.status(500).json({ error: e.message });
  }

  // Update role assignments
  try {
    if (role_ids) {
      await pg.run('DELETE FROM user_roles WHERE user_id=?', req.params.id);
      for (const rid of role_ids) {
        await pg.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?) ON CONFLICT DO NOTHING', req.params.id, rid);
      }
    }
  } catch (e) { return res.status(500).json({ error: e.message }); }

  res.json({ message: 'User updated' });
});

// Self-service: change own password (any logged-in user)
router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!new_password || new_password.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });
    const user = await pg.get('SELECT id, password FROM users WHERE id=?', req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!current_password || !bcrypt.compareSync(current_password, user.password)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    await pg.run('UPDATE users SET password=? WHERE id=?', bcrypt.hashSync(new_password, 10), req.user.id);
    res.json({ message: 'Password changed successfully' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Self-service: set / update a personal recovery code. The user picks any
// memorable code (e.g. a phrase) — stored as a bcrypt hash so even DB
// access can't reveal it. Used by /forgot-password to reset without admin.
router.post('/recovery-code', authMiddleware, async (req, res) => {
  try {
    const { recovery_code } = req.body || {};
    const code = String(recovery_code || '').trim();
    if (code.length < 4) return res.status(400).json({ error: 'Recovery code must be at least 4 characters' });
    await pg.run('UPDATE users SET recovery_code_hash=? WHERE id=?', bcrypt.hashSync(code, 10), req.user.id);
    res.json({ message: 'Recovery code saved. Keep it private — anyone with this code + your username can reset your password.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Forgot password — no auth. Caller proves identity via the personal
// recovery code they previously set. Generic error messages so we don't
// reveal which usernames exist or which have a code configured.
router.post('/forgot-password', async (req, res) => {
  const { logAuditEvent } = require('../middleware/audit');
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || null;
  const ua = req.headers['user-agent'] || null;
  try {
    const { username, recovery_code, new_password } = req.body || {};
    const identifier = String(username || '').trim();
    const code = String(recovery_code || '').trim();
    const newPwd = String(new_password || '').trim();
    if (!identifier || !code || !newPwd) return res.status(400).json({ error: 'Username, recovery code and new password are all required' });
    if (newPwd.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });
    const user = await pg.get('SELECT id, name, recovery_code_hash, active FROM users WHERE LOWER(username)=LOWER(?) OR LOWER(email)=LOWER(?)', identifier, identifier);
    const fail = (reason, status = 400) => {
      logAuditEvent({
        action: 'FORGOT_PASSWORD_FAIL', entity_type: 'auth', entity_label: identifier,
        method: 'POST', path: '/api/auth/forgot-password', status_code: status, ip, user_agent: ua,
        body: { reason },
      });
      return res.status(status).json({ error: 'Username or recovery code is incorrect, or no recovery code is set for this account' });
    };
    if (!user) return fail('no_user');
    // Two paths to reset:
    //   1. The user's own recovery code (set via /auth/recovery-code)
    //   2. The owner-only emergency code (data/RECOVERY.txt) — works for ANY
    //      user, lets mam unlock employees who never set their own code.
    const personalOk = user.recovery_code_hash && bcrypt.compareSync(code, user.recovery_code_hash);
    let emergencyOk = false;
    if (!personalOk) {
      const row = await pg.get("SELECT value FROM app_settings WHERE key='emergency_reset_hash'");
      if (row && row.value && bcrypt.compareSync(code, row.value)) emergencyOk = true;
    }
    if (!personalOk && !emergencyOk) return fail('bad_code');
    // Reset both password and active flag — a forgot-password flow with a
    // valid recovery code should also un-disable an accidentally deactivated
    // account, otherwise the user would still be locked out after the reset.
    await pg.run('UPDATE users SET password=?, active=1 WHERE id=?', bcrypt.hashSync(newPwd, 10), user.id);
    logAuditEvent({
      user: { id: user.id, name: user.name, role: emergencyOk ? 'emergency' : 'self' },
      action: emergencyOk ? 'FORGOT_PASSWORD_OK_EMERGENCY' : 'FORGOT_PASSWORD_OK',
      entity_type: 'auth', entity_id: user.id, entity_label: user.name,
      method: 'POST', path: '/api/auth/forgot-password', status_code: 200, ip, user_agent: ua,
    });
    res.json({ message: 'Password reset successfully. You can now sign in with your new password.' });
  } catch (e) {
    console.error('[forgot-password] failed:', e.message);
    res.status(500).json({ error: 'Reset failed — please try again' });
  }
});

// Admin reset password — set a new password for any user and return it once.
// Existing passwords are bcrypt-hashed and CANNOT be recovered, so admin has
// to set a new one. The returned plain password is shown once to the admin so
// they can share it with the user through a secure channel. Admins should
// never store or email this password.
router.post('/users/:id/reset-password', authMiddleware, adminOnly, async (req, res) => {
  try {
    const user = await pg.get('SELECT id, name, username, email FROM users WHERE id=?', req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Admin-driven reset: min length relaxed to 3 so short office defaults like
    // "123" or "sepl" work. If blank, generate a 10-char random password.
    let newPassword = String(req.body?.new_password || '').trim();
    if (newPassword && newPassword.length < 3) return res.status(400).json({ error: 'Password must be at least 3 characters' });
    if (!newPassword) {
      // Random: 10 chars, mixed case + digits, no ambiguous chars (0/O, 1/l)
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
      newPassword = Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    }

    await pg.run('UPDATE users SET password=? WHERE id=?', bcrypt.hashSync(newPassword, 10), req.params.id);
    res.json({ message: 'Password reset', user: { id: user.id, name: user.name, username: user.username, email: user.email }, new_password: newPassword });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Discover every (table, column) that has a foreign key pointing at
// users(id).  Used by the force-delete path so we don't have to keep
// a hard-coded list of tables in sync with the schema — Postgres'
// catalog tells us dynamically.  Returns [{ table, column, on_delete,
// notnull }].  (Was PRAGMA foreign_key_list before the Supabase move.)
async function findUserFkReferences() {
  return pg.all(`
    SELECT c.conrelid::regclass::text AS table,
           a.attname                  AS column,
           CASE c.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' ELSE 'NO ACTION' END AS on_delete,
           a.attnotnull               AS notnull
      FROM pg_constraint c
      JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass`);
}

// Every (table,column) with a FK to users that STILL has a row referencing
// `id`. Used by the force-delete fallback to clear whatever the first pass
// missed, and to name the exact blocker if one remains.
async function usersStillReferencedBy(t, id) {
  const hits = [];
  for (const ref of await findUserFkReferences()) {
    try {
      const row = await t.savepoint(() => t.get(`SELECT COUNT(*)::int AS c FROM "${ref.table}" WHERE "${ref.column}" = ?`, id));
      if (row && row.c > 0) hits.push({ table: ref.table, column: ref.column, notnull: ref.notnull, count: row.c });
    } catch (_) { /* skip */ }
  }
  return hits;
}

// Hard delete a user. Admin-only. Guarded so admins can't:
//   - delete themselves (would lock them out of the session)
//   - delete the last active admin (would orphan the system)
// Falls back to "deactivate" guidance if FK references block the delete.
//
// Mam (2026-05-22): "not able to delete who left" — when an employee
// leaves, their user row has FK refs on indents.created_by,
// candidates.created_by, etc.  Plain DELETE fails the FK constraint.
// Pass ?force=1 to nullify every FK ref pointing at this user across
// every table, then delete.  Audit-trail snapshots (user_name fields)
// stay intact because we only null the JOIN, not the denormalised
// names.
router.delete('/users/:id', authMiddleware, adminOnly, async (req, res) => {
  const id = +req.params.id;
  const force = req.query.force === '1';
  if (id === req.user.id) {
    return res.status(400).json({ error: "You can't delete your own account. Ask another admin." });
  }
  let target;
  try {
    target = await pg.get('SELECT id, name, role FROM users WHERE id=?', id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin') {
      const adminCount = (await pg.get("SELECT COUNT(*)::int as c FROM users WHERE role='admin' AND active=1")).c;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot delete the only admin. Promote another user to admin first.' });
      }
    }
  } catch (e) { return res.status(500).json({ error: e.message }); }

  // Attendance is PRESERVED, never deleted (mam 2026-07-06: "if user delete,
  // but old attendance data don't delete"). The force path snapshots the
  // person's name onto their attendance rows and only NULLs the user_id —
  // every attendance record is KEPT (just unlinked and still identifiable),
  // and payroll history (kept by employee_id) is untouched.
  const attCount = (await pg.get('SELECT COUNT(*)::int AS c FROM attendance WHERE user_id = ?', id)).c;
  if (force) {
    // Clear every FK reference to this user, then delete — atomically (a partial
    // failure leaves nothing changed). Two passes so it can't be defeated by a
    // reference the first pass doesn't know about. Each step runs under a
    // SAVEPOINT (Postgres aborts a whole tx on any error; SQLite didn't).
    try {
      const refs = await findUserFkReferences();
      const cleared = {};
      await pg.tx(async (t) => {
        const clearOne = async (ref) => {
          if (ref.table === 'user_roles') return;   // deleted explicitly below
          try {
            await t.savepoint(async () => {
              // A NOT NULL FK column can't be nulled — delete those per-user rows
              // (push_subscriptions / notifications / KPI targets are transient).
              // Nullable columns keep their row and just drop the join, preserving
              // any snapshotted user_name (e.g. attendance).
              const r = ref.notnull
                ? await t.run(`DELETE FROM "${ref.table}" WHERE "${ref.column}" = ?`, id)
                : await t.run(`UPDATE "${ref.table}" SET "${ref.column}" = NULL WHERE "${ref.column}" = ?`, id);
              const key = `${ref.table}.${ref.column}`;
              if (r.changes > 0) cleared[key] = (cleared[key] || 0) + r.changes;
            });
          } catch (e) {
            console.warn('[user-delete] could not clear', `${ref.table}.${ref.column}`, '-', e.message);
          }
        };

        // Preserve attendance FIRST — snapshot the person's name so the rows
        // stay identifiable AFTER their user_id is nulled below. The attendance
        // rows themselves are never deleted (mam 2026-07-06).
        try {
          await t.savepoint(() => t.run('UPDATE attendance SET user_name_snapshot = COALESCE(user_name_snapshot, ?) WHERE user_id = ?', target.name, id));
        } catch (_) { /* best-effort; the null below still preserves the row */ }

        for (const ref of refs) await clearOne(ref);                       // pass 1
        await t.run('DELETE FROM user_roles WHERE user_id = ?', id);

        try {
          await t.savepoint(() => t.run('DELETE FROM users WHERE id=?', id));
        } catch (_firstFail) {
          // Clear whatever STILL points at the user (pass 2), then retry.
          for (const ref of await usersStillReferencedBy(t, id)) await clearOne(ref);
          try {
            await t.savepoint(() => t.run('DELETE FROM users WHERE id=?', id));
          } catch (secondFail) {
            const blockers = (await usersStillReferencedBy(t, id)).map(r => `${r.table}.${r.column}`);
            const err = new Error(blockers.length ? `still linked to ${blockers.join(', ')}` : secondFail.message);
            err.blockers = blockers;
            throw err;                                               // rolls back the whole tx
          }
        }
      });
      res.json({
        message: attCount > 0
          ? `User "${target.name}" force-deleted — ${attCount} attendance record${attCount === 1 ? '' : 's'} kept (unlinked, name preserved)`
          : `User "${target.name}" force-deleted`,
        cleared,
        cleared_total: Object.values(cleared).reduce((a, b) => a + b, 0),
        attendance_preserved: attCount,
      });
    } catch (e) {
      console.error('[user-delete force] failed:', e.message);
      if (e.blockers && e.blockers.length) {
        return res.status(409).json({
          error: `Couldn't fully delete "${target.name}" — still linked to: ${e.blockers.join(', ')}. Send these table names to the developer.`,
          blockers: e.blockers,
        });
      }
      res.status(500).json({ error: `Force-delete failed: ${e.message}` });
    }
    return;
  }
  try {
    // user_roles has ON DELETE CASCADE on user_id, so role assignments clear
    // automatically. Other tables (audit_log, indents.created_by, etc.) hold
    // soft references that will keep their snapshotted user_name field —
    // deletion just nulls the join, doesn't break old rows.
    await pg.run('DELETE FROM user_roles WHERE user_id = ?', id);
    await pg.run('DELETE FROM users WHERE id=?', id);
    res.json({ message: `User "${target.name}" deleted` });
  } catch (e) {
    // FK reference count for an informative error so admin can decide
    // whether to force-delete.
    let refCount = 0;
    try {
      const refs = await findUserFkReferences();
      for (const r of refs) {
        if (r.table === 'user_roles') continue;
        try {
          const c = await pg.get(`SELECT COUNT(*)::int as c FROM "${r.table}" WHERE "${r.column}" = ?`, id);
          refCount += (c?.c || 0);
        } catch (_) {}
      }
    } catch (_) {}
    res.status(409).json({
      error: `Delete blocked: ${e.message}.`,
      reference_count: refCount,
      hint: 'Try Deactivate (reversible, recommended), OR Force Delete (passes ?force=1, nulls all FK references first).',
    });
  }
});

// ===== ROLES & PERMISSIONS (Admin Only) =====

router.get('/roles', authMiddleware, async (req, res) => {
  try {
    res.json(await pg.all('SELECT * FROM roles ORDER BY name'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/roles', authMiddleware, adminOnly, async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Role name required' });
  try {
    const r = await pg.run('INSERT INTO roles (name, description) VALUES (?, ?)', name, description);
    res.status(201).json({ id: r.lastInsertRowid, message: 'Role created' });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Role already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/roles/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { name, description } = req.body;
    await pg.run('UPDATE roles SET name=?, description=? WHERE id=?', name, description, req.params.id);
    res.json({ message: 'Role updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/roles/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const role = await pg.get('SELECT * FROM roles WHERE id=?', req.params.id);
    if (role?.is_system) return res.status(400).json({ error: 'Cannot delete system role' });
    await pg.run('DELETE FROM roles WHERE id=?', req.params.id);
    res.json({ message: 'Role deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get permissions for a specific role
router.get('/roles/:id/permissions', authMiddleware, async (req, res) => {
  try {
    res.json(await pg.all('SELECT * FROM role_permissions WHERE role_id=?', req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Set permissions for a role (bulk update). Now also persists can_see_all
// — explicit "scope = ALL records" toggle decoupled from approve.
router.put('/roles/:id/permissions', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { permissions } = req.body;
    await pg.run('DELETE FROM role_permissions WHERE role_id=?', req.params.id);
    for (const p of (permissions || [])) {
      await pg.run('INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_approve, can_see_all) VALUES (?,?,?,?,?,?,?,?)',
        req.params.id, p.module,
        p.can_view ? 1 : 0, p.can_create ? 1 : 0, p.can_edit ? 1 : 0,
        p.can_delete ? 1 : 0, p.can_approve ? 1 : 0, p.can_see_all ? 1 : 0);
    }
    res.json({ message: 'Permissions updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get permissions for current user
router.get('/my-permissions', authMiddleware, async (req, res) => {
  try {
    res.json(await getUserPermissions(req.user.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk import users
router.post('/bulk-import', authMiddleware, adminOnly, async (req, res) => {
  const { users } = req.body;
  if (!users || !Array.isArray(users) || users.length === 0) return res.status(400).json({ error: 'No users provided' });
  let added = 0, errors = [];
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    if (!u.name || !u.email) { errors.push(`Row ${i + 1}: Name and email required`); continue; }
    try {
      const hash = bcrypt.hashSync(u.password || 'sepl@123', 10);
      const r = await pg.run('INSERT INTO users (name, email, password, role, department, phone) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING',
        u.name.trim(), u.email.trim().toLowerCase(), hash, u.role || 'user', u.department || '', u.phone || '');
      if (r.lastInsertRowid && u.role_name) {
        const role = await pg.get('SELECT id FROM roles WHERE name=?', u.role_name);
        if (role) await pg.run('INSERT INTO user_roles (user_id, role_id) VALUES (?,?) ON CONFLICT DO NOTHING', r.lastInsertRowid, role.id);
      }
      if (r.changes > 0) added++;
      else errors.push(`Row ${i + 1}: Email ${u.email} already exists`);
    } catch (err) { errors.push(`Row ${i + 1}: ${err.message}`); }
  }
  res.json({ added, errors, total: users.length });
});

module.exports = router;
