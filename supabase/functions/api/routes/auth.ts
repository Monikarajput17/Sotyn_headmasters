// Auth + users + roles/permissions — port of server/routes/auth.js onto
// Supabase Auth. Response shapes are unchanged for the React client; the only
// addition is `refresh_token` on login (the client stores it and sends it as
// X-Refresh-Token to /auth/me so the session can slide — mam's no-logout rule).
// deno-lint-ignore-file no-explicit-any
import bcrypt from "bcryptjs";
import { Router } from "../../_shared/express-lite.ts";
import pg from "../../_shared/pg.ts";
import { isLocalDevelopment } from "../../_shared/environment.ts";
import { permissionManager, isPermissionManager, scopeSql, idNumber, assignAttendanceSelfService } from "../../_shared/attendance-access.ts";
import { mountFoundationAccess } from "./foundation-access.ts";
import { logAuditEvent } from "../../_shared/audit.ts";
import {
  adminOnly, adminClient, anonClient, authEmailFor, authMiddleware, ensureAuthAccount, forgetToken,
  getUserPermissions, maybeSlideSession, setAuthPassword,
} from "../../_shared/auth.ts";

const router = Router();
mountFoundationAccess(router);
const err = (res: any, e: unknown, code = 500) => res.status(code).json({ error: (e as Error)?.message || String(e) });

router.post("/login", async (req, res) => {
  const { username, email, password } = req.body || {};
  const identifier = String(username || email || "").trim();
  const ip = req.ip, ua = req.headers["user-agent"] || null;
  if (!identifier || !password) return res.status(400).json({ error: "Username/email and password required" });
  try {
    // Match ALL rows for this identifier (duplicate usernames have existed —
    // mam 2026-06-27), prefer ACTIVE, then authenticate against Supabase Auth.
    const candidates = await pg.all(
      "SELECT * FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?) ORDER BY COALESCE(active,1) DESC, id ASC",
      identifier, identifier);
    const fail = (status: number, msg: string) => {
      logAuditEvent({ action: "LOGIN_FAIL", entity_type: "auth", entity_label: identifier, method: "POST", path: "/api/auth/login", status_code: status, ip, user_agent: ua });
      return res.status(status).json({ error: msg });
    };
    if (!candidates.length) return fail(401, "Invalid credentials");

    let session: any = null, user: any = null;
    for (const cand of candidates) {
      // Legacy row never migrated to Supabase Auth: verify the bcrypt hash
      // ourselves once, then create the Auth account with that same hash.
      if (!cand.auth_user_id) {
        if (!cand.password || !bcrypt.compareSync(password, cand.password)) continue;
        cand.auth_user_id = await ensureAuthAccount(cand, { password_hash: cand.password });
      }
      const { data, error } = await anonClient().auth.signInWithPassword({ email: authEmailFor(cand), password });
      if (!error && data.session) { session = data.session; user = cand; break; }
    }
    if (!user) return fail(401, "Invalid credentials");
    if (user.active === 0) return fail(403, "Your account is disabled. Please contact admin.");

    const permissions = await getUserPermissions(user.id);
    const userRoles = await pg.all("SELECT r.name FROM roles r JOIN user_roles ur ON r.id=ur.role_id WHERE ur.user_id=?", user.id);
    logAuditEvent({ user: { id: user.id, name: user.name, role: user.role }, action: "LOGIN", entity_type: "auth", entity_id: user.id, entity_label: user.name, method: "POST", path: "/api/auth/login", status_code: 200, ip, user_agent: ua });
    res.json({
      token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
      user: {
        id: user.id, name: user.name, email: user.email, username: user.username,
        role: user.role, department: user.department, phone: user.phone,
        approval_role: user.approval_role || null, avatar_url: user.avatar_url || null,
        has_recovery_code: !!user.recovery_code_hash,
      },
      permissions, userRoles: userRoles.map((r: any) => r.name),
    });
  } catch (e) { console.error("[auth login] failed:", (e as Error).message); res.status(500).json({ error: "Login failed — please try again" }); }
});

// Explicit refresh (client fallback when the sliding header wasn't seen).
router.post("/refresh", async (req, res) => {
  try {
    const rt = req.body?.refresh_token || req.headers["x-refresh-token"];
    if (!rt) return res.status(400).json({ error: "refresh_token required" });
    const { data, error } = await anonClient().auth.refreshSession({ refresh_token: rt });
    if (error || !data.session) return res.status(401).json({ error: "Invalid token" });
    res.json({ token: data.session.access_token, refresh_token: data.session.refresh_token, expires_at: data.session.expires_at });
  } catch (e) { err(res, e); }
});

router.post("/register", authMiddleware, permissionManager, async (req, res) => {
  const { name, email, username, password, role, department, phone, role_ids, avatar_url } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "Name, email and password required" });
  const uname = username ? String(username).trim() : null;
  try {
    if (await pg.get("SELECT id FROM users WHERE LOWER(email)=LOWER(?)", email)) return res.status(409).json({ error: "Email already exists" });
    if (uname && await pg.get("SELECT id FROM users WHERE LOWER(username)=LOWER(?)", uname)) return res.status(409).json({ error: "Username already taken" });
    const hash = bcrypt.hashSync(password, 10);
    const result = await pg.run("INSERT INTO users (name, email, username, password, role, department, phone, avatar_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      name, email, uname, hash, role || "user", department || null, phone || null, avatar_url ? String(avatar_url).trim() : null);
    const id = result.lastInsertRowid!;
    await ensureAuthAccount({ id, email, username: uname }, { password });
    if (role_ids && role_ids.length > 0) {
      for (const rid of role_ids) await pg.run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?) ON CONFLICT DO NOTHING", id, rid);
    }
    await assignAttendanceSelfService(id);
    const user = await pg.get("SELECT id, name, email, username, role, department, phone FROM users WHERE id = ?", id);
    res.status(201).json({ user, message: "User created successfully" });
  } catch (e) {
    const m = (e as Error).message || "";
    if (m.includes("UNIQUE")) return res.status(409).json({ error: m.includes("username") ? "Username already taken" : "Email already exists" });
    err(res, e);
  }
});

router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await pg.get("SELECT id, name, email, username, role, department, phone, recovery_code_hash, approval_role, avatar_url FROM users WHERE id = ?", req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    const has_recovery_code = !!user.recovery_code_hash;
    delete user.recovery_code_hash;
    const permissions = await getUserPermissions(req.user.id);
    const userRoles = await pg.all("SELECT r.name FROM roles r JOIN user_roles ur ON r.id=ur.role_id WHERE ur.user_id=?", req.user.id);
    await maybeSlideSession(req, res);
    res.json({ ...user, has_recovery_code, permissions, userRoles: userRoles.map((r: any) => r.name) });
  } catch (e) { err(res, e); }
});

router.post("/avatar", authMiddleware, async (req, res) => {
  try {
    const url = req.body?.avatar_url ? String(req.body.avatar_url).trim() : null;
    await pg.run("UPDATE users SET avatar_url=? WHERE id=?", url, req.user.id);
    res.json({ avatar_url: url });
  } catch (e) { err(res, e); }
});

router.get("/users/export.xlsx", authMiddleware, permissionManager, async (req, res) => {
  const XLSX = await import('xlsx');
  try {
    const rows = await pg.all(`
      SELECT u.name, u.email, u.username, u.role, u.department, u.phone,
             (SELECT e.salary FROM employees e WHERE e.user_id=u.id AND ${await scopeSql(req,'payroll','view','e.id',true)} ORDER BY e.id DESC LIMIT 1) AS salary,
             (SELECT e.designation FROM employees e WHERE e.user_id=u.id ORDER BY e.id DESC LIMIT 1) AS designation
        FROM users u WHERE COALESCE(u.active, 1) = 1 AND ${await isPermissionManager(req.user.id)?"TRUE":await scopeSql(req,"employees","view","u.id")} ORDER BY LOWER(u.name)`);
    const header = ["Name", "Email", "Username", "Role", "Department", "Designation", "Phone", "Salary (₹)"];
    const aoa = [header, ...rows.map((r: any) => [r.name || "", r.email || "", r.username || "", r.role || "", r.department || "", r.designation || "", r.phone || "", +r.salary || 0])];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 24 }, { wch: 28 }, { wch: 18 }, { wch: 10 }, { wch: 18 }, { wch: 20 }, { wch: 14 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws, "Active Users");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="active-users-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(new Uint8Array(buf));
  } catch (e) { err(res, e); }
});

router.get("/users/hierarchy", authMiddleware, async (req, res) => {
  try {
    res.json(await pg.all(`
      SELECT u.id, u.name, u.role, u.department, u.manager_id, u.avatar_url, m.name AS manager_name,
             (SELECT e.designation FROM employees e WHERE e.user_id=u.id ORDER BY e.id DESC LIMIT 1) AS designation
        FROM users u LEFT JOIN users m ON m.id = u.manager_id
       WHERE COALESCE(u.active, 1) = 1 AND ${await isPermissionManager(req.user.id)?'TRUE':await scopeSql(req,'employees','view','u.id')} ORDER BY LOWER(u.name)`));
  } catch (e) { err(res, e); }
});

router.put("/users/:id/manager", authMiddleware, permissionManager, async (req, res) => {
  try {
    const id = +req.params.id;
    let mgr = req.body.manager_id;
    mgr = (mgr === "" || mgr == null) ? null : +mgr;
    if (mgr === id) return res.status(400).json({ error: "A user cannot report to themselves." });
    if (mgr != null) {
      let cur: number | null = mgr, hops = 0;
      while (cur != null && hops++ < 100) {
        if (cur === id) return res.status(400).json({ error: "That would create a reporting loop." });
        cur = (await pg.get("SELECT manager_id FROM users WHERE id=?", cur))?.manager_id ?? null;
      }
    }
    await pg.run("UPDATE users SET manager_id=? WHERE id=?", mgr, id);
    res.json({ message: "Saved", id, manager_id: mgr });
  } catch (e) { err(res, e); }
});

router.get("/users", authMiddleware, async (req, res) => {
  try {
    const whereClause = req.query.active_only === "1" ? "WHERE u.active = 1" : "WHERE TRUE";
    res.json(await pg.all(`
      SELECT u.id, u.name, u.email, u.username, u.role, u.department, u.phone, u.active, u.avatar_url,
             COALESCE(u.track_location, 1) as track_location, COALESCE(u.archived, 0) as archived, u.created_at, u.approval_role,
             STRING_AGG(r.name, ',') as role_names
      FROM users u LEFT JOIN user_roles ur ON u.id = ur.user_id LEFT JOIN roles r ON ur.role_id = r.id
      ${whereClause} AND ${await isPermissionManager(req.user.id)?"TRUE":await scopeSql(req,"employees","view","u.id")} GROUP BY u.id ORDER BY u.name`));
  } catch (e) { err(res, e); }
});

router.patch("/users/:id/track-location", authMiddleware, permissionManager, async (req, res) => {
  try {
    const v = req.body?.track_location ? 1 : 0;
    await pg.run("UPDATE users SET track_location=? WHERE id=?", v, req.params.id);
    res.json({ message: v ? "Tracking enabled for this user" : "Tracking disabled for this user", track_location: v });
  } catch (e) { err(res, e); }
});

router.patch("/users/:id/archive", authMiddleware, permissionManager, async (req, res) => {
  try {
    const id = +req.params.id;
    if (id === req.user.id) return res.status(400).json({ error: "You can't archive your own account." });
    const target = await pg.get("SELECT id, name FROM users WHERE id=?", id);
    if (!target) return res.status(404).json({ error: "User not found" });
    const arch = req.body?.archived ? 1 : 0;
    if(arch && await isPermissionManager(id))return res.status(409).json({error:"Permission manager account must remain active for recovery"});
    if (arch) await pg.run("UPDATE users SET archived=1, active=0 WHERE id=?", id);
    else await pg.run("UPDATE users SET archived=0 WHERE id=?", id);
    res.json({ message: arch ? `"${target.name}" archived — hidden from lists, all data kept` : `"${target.name}" restored to the Inactive list`, archived: arch });
  } catch (e) { err(res, e); }
});

router.put("/users/:id", authMiddleware, permissionManager, async (req, res) => {
  if(await isPermissionManager(Number(req.params.id)) && !req.body.active)return res.status(409).json({error:"A permission manager account cannot be disabled through user editing"});
  const { name, email, username, department, phone, role, active, role_ids, password, approval_role, avatar_url } = req.body || {};
  try {
    const uname = username !== undefined ? (username ? String(username).trim() : null) : undefined;
    if (uname) {
      const clash = await pg.get("SELECT id FROM users WHERE LOWER(username)=LOWER(?) AND id<>?", uname, req.params.id);
      if (clash) return res.status(409).json({ error: "Username already taken" });
    }
    const sets = ["name=?", "email=?", "department=?", "phone=?", "role=?", "active=?"];
    const vals: any[] = [name, email, department, phone, role, active ? 1 : 0];
    if (uname !== undefined) { sets.push("username=?"); vals.push(uname); }
    if (password) { sets.push("password=?"); vals.push(bcrypt.hashSync(password, 10)); }
    vals.push(req.params.id);
    await pg.run(`UPDATE users SET ${sets.join(", ")} WHERE id=?`, ...vals);
    if (password) {
      const row = await pg.get("SELECT id, email, username, auth_user_id FROM users WHERE id=?", req.params.id);
      if (row) { const aid = await ensureAuthAccount(row, { password }); if (row.auth_user_id) await setAuthPassword(aid, password); }
    }
    if (approval_role !== undefined) {
      const VALID = ["l1", "l2", "hr"];
      await pg.run("UPDATE users SET approval_role=? WHERE id=?", approval_role && VALID.includes(approval_role) ? approval_role : null, req.params.id);
    }
    if (avatar_url !== undefined) await pg.run("UPDATE users SET avatar_url=? WHERE id=?", avatar_url ? String(avatar_url).trim() : null, req.params.id);
    if (role_ids) {
      await pg.run("DELETE FROM user_roles WHERE user_id=?", req.params.id);
      for (const rid of role_ids) await pg.run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?) ON CONFLICT DO NOTHING", req.params.id, rid);
    }
    res.json({ message: "User updated" });
  } catch (e) {
    const m = (e as Error).message || "";
    if (m.includes("UNIQUE")) return res.status(409).json({ error: m.includes("username") ? "Username already taken" : "Email already exists" });
    err(res, e);
  }
});

router.post("/change-password", authMiddleware, async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!new_password || new_password.length < 4) return res.status(400).json({ error: "New password must be at least 4 characters" });
    const user = await pg.get("SELECT id, email, username, password, auth_user_id FROM users WHERE id=?", req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    const { error } = await anonClient().auth.signInWithPassword({ email: authEmailFor(user), password: String(current_password || "") });
    if (error) return res.status(401).json({ error: "Current password is incorrect" });
    await setAuthPassword(user.auth_user_id, new_password);
    await pg.run("UPDATE users SET password=? WHERE id=?", bcrypt.hashSync(new_password, 10), req.user.id);
    res.json({ message: "Password changed successfully" });
  } catch (e) { err(res, e); }
});

router.post("/recovery-code", authMiddleware, async (req, res) => {
  try {
    const code = String(req.body?.recovery_code || "").trim();
    if (code.length < 4) return res.status(400).json({ error: "Recovery code must be at least 4 characters" });
    await pg.run("UPDATE users SET recovery_code_hash=? WHERE id=?", bcrypt.hashSync(code, 10), req.user.id);
    res.json({ message: "Recovery code saved. Keep it private — anyone with this code + your username can reset your password." });
  } catch (e) { err(res, e); }
});

router.post("/forgot-password", async (req, res) => {
  const ip = req.ip, ua = req.headers["user-agent"] || null;
  try {
    const { username, recovery_code, new_password } = req.body || {};
    const identifier = String(username || "").trim(), code = String(recovery_code || "").trim(), newPwd = String(new_password || "").trim();
    if (!identifier || !code || !newPwd) return res.status(400).json({ error: "Username, recovery code and new password are all required" });
    if (newPwd.length < 4) return res.status(400).json({ error: "New password must be at least 4 characters" });
    const user = await pg.get("SELECT id, name, email, username, recovery_code_hash, active, auth_user_id FROM users WHERE LOWER(username)=LOWER(?) OR LOWER(email)=LOWER(?)", identifier, identifier);
    const fail = (reason: string) => {
      logAuditEvent({ action: "FORGOT_PASSWORD_FAIL", entity_type: "auth", entity_label: identifier, method: "POST", path: "/api/auth/forgot-password", status_code: 400, ip, user_agent: ua, body: { reason } });
      return res.status(400).json({ error: "Username or recovery code is incorrect, or no recovery code is set for this account" });
    };
    if (!user) return fail("no_user");
    const personalOk = user.recovery_code_hash && bcrypt.compareSync(code, user.recovery_code_hash);
    let emergencyOk = false;
    if (!personalOk) {
      const row = await pg.get("SELECT value FROM app_settings WHERE key='emergency_reset_hash'");
      if (row?.value && bcrypt.compareSync(code, row.value)) emergencyOk = true;
    }
    if (!personalOk && !emergencyOk) return fail("bad_code");
    const aid = await ensureAuthAccount(user, { password: newPwd });
    if (user.auth_user_id) await setAuthPassword(aid, newPwd);
    await pg.run("UPDATE users SET password=?, active=1 WHERE id=?", bcrypt.hashSync(newPwd, 10), user.id);
    logAuditEvent({ user: { id: user.id, name: user.name, role: emergencyOk ? "emergency" : "self" }, action: emergencyOk ? "FORGOT_PASSWORD_OK_EMERGENCY" : "FORGOT_PASSWORD_OK", entity_type: "auth", entity_id: user.id, entity_label: user.name, method: "POST", path: "/api/auth/forgot-password", status_code: 200, ip, user_agent: ua });
    res.json({ message: "Password reset successfully. You can now sign in with your new password." });
  } catch (e) { console.error("[forgot-password] failed:", (e as Error).message); res.status(500).json({ error: "Reset failed — please try again" }); }
});

router.post("/users/:id/reset-password", authMiddleware, permissionManager, async (req, res) => {
  try {
    const user = await pg.get("SELECT id, name, username, email, auth_user_id FROM users WHERE id=?", req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    let newPassword = String(req.body?.new_password || "").trim();
    if (newPassword && newPassword.length < 3) return res.status(400).json({ error: "Password must be at least 3 characters" });
    if (!newPassword) {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
      newPassword = Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    }
    // Supabase Auth enforces a minimum of 6 characters; pad short office defaults
    // deterministically so "123" still works as typed? No — be honest: enforce 6.
    if (newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters (Supabase Auth minimum)" });
    const aid = await ensureAuthAccount(user, { password: newPassword });
    if (user.auth_user_id) await setAuthPassword(aid, newPassword);
    await pg.run("UPDATE users SET password=? WHERE id=?", bcrypt.hashSync(newPassword, 10), req.params.id);
    res.json({ message: "Password reset", user: { id: user.id, name: user.name, username: user.username, email: user.email }, new_password: newPassword });
  } catch (e) { err(res, e); }
});

async function findUserFkReferences() {
  return pg.all(`
    SELECT c.conrelid::regclass::text AS table, a.attname AS column,
           CASE c.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' ELSE 'NO ACTION' END AS on_delete,
           a.attnotnull AS notnull
      FROM pg_constraint c
      JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass`);
}
async function usersStillReferencedBy(t: any, id: number) {
  const hits: any[] = [];
  for (const ref of await findUserFkReferences()) {
    try {
      const row = await t.savepoint(() => t.get(`SELECT COUNT(*)::int AS c FROM "${ref.table}" WHERE "${ref.column}" = ?`, id));
      if (row && row.c > 0) hits.push({ table: ref.table, column: ref.column, notnull: ref.notnull, count: row.c });
    } catch { /* skip */ }
  }
  return hits;
}

router.delete("/users/:id", authMiddleware, permissionManager, async (req, res) => {
  if(await isPermissionManager(Number(req.params.id)))return res.status(409).json({error:"Permission manager accounts must be retained for recovery"});
  const id = +req.params.id;
  const force = req.query.force === "1";
  if (id === req.user.id) return res.status(400).json({ error: "You can't delete your own account. Ask another admin." });
  let target: any;
  try {
    target = await pg.get("SELECT id, name, role, auth_user_id FROM users WHERE id=?", id);
    if (!target) return res.status(404).json({ error: "User not found" });
    if (target.role === "admin") {
      const adminCount = (await pg.get("SELECT COUNT(*)::int as c FROM users WHERE role='admin' AND active=1")).c;
      if (adminCount <= 1) return res.status(400).json({ error: "Cannot delete the only admin. Promote another user to admin first." });
    }
  } catch (e) { return err(res, e); }
  const attCount = (await pg.get("SELECT COUNT(*)::int AS c FROM attendance WHERE user_id = ?", id)).c;
  const dropAuth = async () => { if (target.auth_user_id) { try { await adminClient().auth.admin.deleteUser(target.auth_user_id); } catch { /* best-effort */ } } };
  if (force) {
    try {
      const refs = await findUserFkReferences();
      const cleared: Record<string, number> = {};
      await pg.tx(async (t) => {
        const clearOne = async (ref: any) => {
          if (ref.table === "user_roles") return;
          try {
            await t.savepoint(async () => {
              const r = ref.notnull
                ? await t.run(`DELETE FROM "${ref.table}" WHERE "${ref.column}" = ?`, id)
                : await t.run(`UPDATE "${ref.table}" SET "${ref.column}" = NULL WHERE "${ref.column}" = ?`, id);
              const key = `${ref.table}.${ref.column}`;
              if (r.changes > 0) cleared[key] = (cleared[key] || 0) + r.changes;
            });
          } catch (e) { console.warn("[user-delete] could not clear", `${ref.table}.${ref.column}`, "-", (e as Error).message); }
        };
        try { await t.savepoint(() => t.run("UPDATE attendance SET user_name_snapshot = COALESCE(user_name_snapshot, ?) WHERE user_id = ?", target.name, id)); } catch { /* best-effort */ }
        for (const ref of refs) await clearOne(ref);
        await t.run("DELETE FROM user_roles WHERE user_id = ?", id);
        try { await t.savepoint(() => t.run("DELETE FROM users WHERE id=?", id)); }
        catch (_first) {
          for (const ref of await usersStillReferencedBy(t, id)) await clearOne(ref);
          try { await t.savepoint(() => t.run("DELETE FROM users WHERE id=?", id)); }
          catch (second) {
            const blockers = (await usersStillReferencedBy(t, id)).map((r: any) => `${r.table}.${r.column}`);
            const e: any = new Error(blockers.length ? `still linked to ${blockers.join(", ")}` : (second as Error).message);
            e.blockers = blockers; throw e;
          }
        }
      });
      await dropAuth();
      res.json({
        message: attCount > 0 ? `User "${target.name}" force-deleted — ${attCount} attendance record${attCount === 1 ? "" : "s"} kept (unlinked, name preserved)` : `User "${target.name}" force-deleted`,
        cleared, cleared_total: Object.values(cleared).reduce((a, b) => a + b, 0), attendance_preserved: attCount,
      });
    } catch (e: any) {
      if (e.blockers?.length) return res.status(409).json({ error: `Couldn't fully delete "${target.name}" — still linked to: ${e.blockers.join(", ")}. Send these table names to the developer.`, blockers: e.blockers });
      res.status(500).json({ error: `Force-delete failed: ${e.message}` });
    }
    return;
  }
  try {
    await pg.run("DELETE FROM user_roles WHERE user_id = ?", id);
    await pg.run("DELETE FROM users WHERE id=?", id);
    await dropAuth();
    res.json({ message: `User "${target.name}" deleted` });
  } catch (e) {
    let refCount = 0;
    try {
      for (const r of await findUserFkReferences()) {
        if (r.table === "user_roles") continue;
        try { refCount += (await pg.get(`SELECT COUNT(*)::int as c FROM "${r.table}" WHERE "${r.column}" = ?`, id))?.c || 0; } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    res.status(409).json({ error: `Delete blocked: ${(e as Error).message}.`, reference_count: refCount, hint: "Try Deactivate (reversible, recommended), OR Force Delete (passes ?force=1, nulls all FK references first)." });
  }
});

// ===== ROLES & PERMISSIONS =====
router.get("/roles", authMiddleware, permissionManager, async (req, res) => {
  try {
    const roles = await pg.all("SELECT * FROM roles ORDER BY name");
    // Keep local regression fixtures available for diagnostics without filling
    // the normal role editor and user-assignment dropdown with generated roles.
    const hideFixtures = isLocalDevelopment && req.query.include_test !== "1";
    res.json(hideFixtures ? roles.filter((role: any) =>
      !(role.description === "Synthetic fixture" && /^af[0-9]{13}/.test(role.name))) : roles);
  } catch (e) { err(res, e); }
});
router.post("/roles", authMiddleware, permissionManager, async (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: "Role name required" });
  try {
    const r = await pg.run("INSERT INTO roles (name, description) VALUES (?, ?)", name, description);
    await pg.run("INSERT INTO role_permissions(role_id,module,can_view,scope_mode) VALUES(?,'dashboard',1,'self') ON CONFLICT DO NOTHING",r.lastInsertRowid);
    res.status(201).json({ id: r.lastInsertRowid, message: "Role created" });
  } catch (e) {
    if ((e as Error).message.includes("UNIQUE")) return res.status(409).json({ error: "Role already exists" });
    err(res, e);
  }
});
router.put("/roles/:id", authMiddleware, permissionManager, async (req, res) => {
  try { await pg.run("UPDATE roles SET name=?, description=? WHERE id=?", req.body.name, req.body.description, req.params.id); res.json({ message: "Role updated" }); } catch (e) { err(res, e); }
});
router.delete("/roles/:id", authMiddleware, permissionManager, async (req, res) => {
  try {
    const role = await pg.get("SELECT * FROM roles WHERE id=?", req.params.id);
    if (role?.is_system) return res.status(400).json({ error: "Cannot delete system role" });
    await pg.run("DELETE FROM roles WHERE id=?", req.params.id);
    res.json({ message: "Role deleted" });
  } catch (e) { err(res, e); }
});
router.get("/roles/:id/permissions", authMiddleware, permissionManager, async (req, res) => {
  try { res.json(await pg.all("SELECT * FROM role_permissions WHERE role_id=?", req.params.id)); } catch (e) { err(res, e); }
});
router.put("/roles/:id/permissions", authMiddleware, permissionManager, async (req, res) => {
  try {
    const { permissions } = req.body || {};
    if(!Array.isArray(permissions)||permissions.length>200)return res.status(400).json({error:'Permission rows required'});
    for(const p of permissions){
     if(p.module==='permission_admin'||!/^[a-z_]+$/.test(p.module)||!['self','team','branch','all'].includes(p.scope_mode||'self'))return res.status(400).json({error:'Invalid module or scope'});
     const ids=typeof p.scope_branches==='string'?JSON.parse(p.scope_branches):p.scope_branches||[];
     if(!Array.isArray(ids)||ids.some((id:any)=>!idNumber(id)))return res.status(400).json({error:'Valid branch IDs required'});
     for(const id of ids)if(!await pg.get('SELECT id FROM attendance_branches WHERE id=?',id))return res.status(400).json({error:'Unknown branch ID'});
     p.scope_branches=JSON.stringify(ids);
    }
    await pg.tx(async t=>{for(const p of permissions){
     await t.run(`INSERT INTO role_permissions(role_id,module,can_view,can_create,can_edit,can_delete,can_approve,can_see_all,scope_mode,scope_branches) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(role_id,module) DO UPDATE SET can_view=EXCLUDED.can_view,can_create=EXCLUDED.can_create,can_edit=EXCLUDED.can_edit,can_delete=EXCLUDED.can_delete,can_approve=EXCLUDED.can_approve,can_see_all=EXCLUDED.can_see_all,scope_mode=EXCLUDED.scope_mode,scope_branches=EXCLUDED.scope_branches`,
      req.params.id,p.module,p.can_view?1:0,p.can_create?1:0,p.can_edit?1:0,p.can_delete?1:0,p.can_approve?1:0,p.scope_mode==='all'?1:0,p.scope_mode||'self',p.scope_branches);
    }});
    res.json({ message: "Permissions updated" });
  } catch (e) { err(res, e); }
});
router.get("/my-permissions", authMiddleware, async (req, res) => { try { res.json(await getUserPermissions(req.user.id)); } catch (e) { err(res, e); } });

router.post("/bulk-import", authMiddleware, permissionManager, async (req, res) => {
  const { users } = req.body || {};
  if (!users || !Array.isArray(users) || users.length === 0) return res.status(400).json({ error: "No users provided" });
  let added = 0; const errors: string[] = [];
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    if (!u.name || !u.email) { errors.push(`Row ${i + 1}: Name and email required`); continue; }
    try {
      const pwd = u.password || "sepl@123";
      const r = await pg.run("INSERT INTO users (name, email, password, role, department, phone) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        u.name.trim(), u.email.trim().toLowerCase(), bcrypt.hashSync(pwd, 10), u.role || "user", u.department || "", u.phone || "");
      if (r.lastInsertRowid) {
        await ensureAuthAccount({ id: r.lastInsertRowid, email: u.email.trim().toLowerCase() }, { password: pwd });
        if (u.role_name) {
          const role = await pg.get("SELECT id FROM roles WHERE name=?", u.role_name);
          if (role) await pg.run("INSERT INTO user_roles (user_id, role_id) VALUES (?,?) ON CONFLICT DO NOTHING", r.lastInsertRowid, role.id);
        }
        await assignAttendanceSelfService(r.lastInsertRowid);
      }
      if (r.changes > 0) added++; else errors.push(`Row ${i + 1}: Email ${u.email} already exists`);
    } catch (e) { errors.push(`Row ${i + 1}: ${(e as Error).message}`); }
  }
  res.json({ added, errors, total: users.length });
});

router.post("/logout", authMiddleware, (req, res) => { forgetToken((req.headers.authorization || "").split(" ")[1]); res.json({ ok: true }); });

export default router;
