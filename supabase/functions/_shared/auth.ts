// Auth for the Edge Function — port of server/middleware/auth.js onto
// Supabase Auth.
//
// Identity: Supabase Auth issues the access token (signInWithPassword). The
// ERP profile/roles stay in our `users` table, linked by users.auth_user_id.
// Verification: JWKS (asymmetric project keys) first, GoTrue getUser fallback
// (legacy HS256). A short per-token cache keeps DB lookups off the hot path.
//
// Permissions are unchanged: roles / user_roles / role_permissions, with the
// same requirePermission()/getUserPermissions() semantics the UI depends on.
import { createClient } from "@supabase/supabase-js";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import pg from "./pg.ts";
import type { Handler, Req, Res } from "./express-lite.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

// Clients are created lazily so the function boots (and DB-only / public
// routes work) even before SUPABASE_* keys are configured.
// deno-lint-ignore no-explicit-any
let _admin: any = null;
export function adminClient() {
  if (!_admin) {
    if (!SERVICE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
    _admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  }
  return _admin;
}
export const anonClient = () => {
  if (!ANON_KEY) throw new Error("SUPABASE_ANON_KEY is not configured");
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
};

const jwks = createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`));

// A rejected token (bad signature / expired / disabled account) is an
// AuthError → 401. Anything else (JWKS fetch hiccup, DB connection blip on a
// cold isolate) is INFRASTRUCTURE and must never look like a bad token — the
// client treats 401 as "maybe log out"; a 503 just gets retried.
export class AuthError extends Error {}

export interface TokenClaims { sub: string; exp?: number; iat?: number; email?: string }
export async function verifyAccessToken(token: string): Promise<TokenClaims> {
  let header: { alg?: string } = {};
  try { header = JSON.parse(atob(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"))); } catch { throw new AuthError("Malformed token"); }
  if (header.alg && header.alg !== "HS256") {
    // Asymmetric project keys → verify locally against the published JWKS.
    try {
      const { payload } = await jwtVerify(token, jwks);
      return { sub: String(payload.sub), exp: payload.exp, iat: payload.iat, email: payload.email as string | undefined };
    } catch (e) {
      const code = (e as { code?: string }).code || "";
      // jose signals token problems with ERR_JWT_* / ERR_JWS_* codes; anything
      // else (network, JWKS timeout) is infrastructure → let it surface as such.
      if (code.startsWith("ERR_JWT") || code.startsWith("ERR_JWS") || code.startsWith("ERR_JWKS_NO_MATCHING_KEY")) throw new AuthError("Invalid token");
      throw e;
    }
  }
  // Legacy-secret (HS256) tokens → ask GoTrue.
  const { data, error } = await adminClient().auth.getUser(token);
  if (error || !data?.user) throw new AuthError("Invalid token");
  let exp: number | undefined, iat: number | undefined;
  try { const p = decodeJwt(token); exp = p.exp; iat = p.iat; } catch { /* ignore */ }
  return { sub: data.user.id, exp, iat, email: data.user.email ?? undefined };
}

export interface AuthUser { id: number; email: string | null; role: string; name: string; auth_id: string; exp?: number; iat?: number }
const cache = new Map<string, { u: AuthUser; at: number }>();
const inflight = new Map<string, Promise<AuthUser>>();   // one verification per token at a time
const CACHE_MS = 60_000;

export async function userFromToken(token: string): Promise<AuthUser> {
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.u;
  const pending = inflight.get(token);
  if (pending) return pending;
  const p = (async () => {
    const claims = await verifyAccessToken(token);
    const row = await pg.get(
      "SELECT id, name, email, username, role, department, active, archived FROM users WHERE auth_user_id = ?", claims.sub);
    if (!row) throw new AuthError("No ERP profile linked to this login");
    if (row.archived === 1 || row.active === 0) throw new AuthError("Account disabled");
    const u: AuthUser = { id: row.id, email: row.email, role: row.role, name: row.name, auth_id: claims.sub, exp: claims.exp, iat: claims.iat };
    cache.set(token, { u, at: Date.now() });
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
    return u;
  })();
  inflight.set(token, p);
  try { return await p; } finally { inflight.delete(token); }
}
export const forgetToken = (token: string) => cache.delete(token);

export const authMiddleware: Handler = async (req, res, next) => {
  const token = (req.headers.authorization || "").split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token provided" });
  try {
    req.user = await userFromToken(token);
    next();
  } catch (e) {
    if (e instanceof AuthError) {
      if (String(req.originalUrl || "").includes("/auth/me")) console.warn(`[auth] /auth/me 401 — ${e.message}`);
      return res.status(401).json({ error: "Invalid token" });
    }
    console.error("[auth] verification infrastructure error:", (e as Error).message);
    res.setHeader("Retry-After", "2");
    res.status(503).json({ error: "Authentication temporarily unavailable — please retry" });
  }
};

export const adminOnly: Handler = (req, res, next) => {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin access required" });
  next();
};

export function requirePermission(module: string, action: string): Handler {
  return async (req, res, next) => {
    if (req.user?.role === "admin") return next();
    try {
      const perms = await pg.get(`
        SELECT rp.* FROM role_permissions rp
        JOIN user_roles ur ON rp.role_id = ur.role_id
        WHERE ur.user_id = ? AND rp.module = ?`, req.user.id, module);
      if (!perms) return res.status(403).json({ error: `No access to ${module}` });
      const actionMap: Record<string, string> = { view: "can_view", create: "can_create", edit: "can_edit", delete: "can_delete", approve: "can_approve" };
      const field = actionMap[action];
      if (!field || !perms[field]) return res.status(403).json({ error: `No ${action} permission for ${module}` });
      next();
    } catch (e) {
      console.error("[auth] permission check failed:", (e as Error).message);
      res.status(500).json({ error: "Permission check failed" });
    }
  };
}

export async function getUserPermissions(userId: number) {
  const user = await pg.get("SELECT role FROM users WHERE id = ?", userId);
  if (user?.role === "admin") {
    const modules = [
      "dashboard", "leads", "quotations", "solar_quotation", "orders", "business_book", "item_master", "vendors", "customers", "procurement",
      "cashflow", "collections", "payment_required", "attendance", "indent_fms", "dpr",
      "installation", "billing", "complaints", "hr", "payroll", "employees", "expenses", "checklists", "users", "delegations", "pms_tasks", "inventory", "scoring", "gamification", "tools", "rentals",
      "salon_services", "salon_stylists", "salon_clients", "salon_appointments", "salon_pos", "salon_products", "salon_memberships", "salon_commissions",
    ];
    // deno-lint-ignore no-explicit-any
    const perms: Record<string, any> = {};
    for (const m of modules) perms[m] = { can_view: 1, can_create: 1, can_edit: 1, can_delete: 1, can_approve: 1, can_see_all: 1 };
    return perms;
  }
  const rows = await pg.all(`
    SELECT rp.module, rp.can_view, rp.can_create, rp.can_edit, rp.can_delete, rp.can_approve, rp.can_see_all
    FROM role_permissions rp JOIN user_roles ur ON rp.role_id = ur.role_id WHERE ur.user_id = ?`, userId);
  // deno-lint-ignore no-explicit-any
  const perms: Record<string, any> = {};
  for (const r of rows) {
    if (!perms[r.module]) perms[r.module] = { can_view: 0, can_create: 0, can_edit: 0, can_delete: 0, can_approve: 0, can_see_all: 0 };
    for (const k of ["can_view", "can_create", "can_edit", "can_delete", "can_see_all", "can_approve"]) perms[r.module][k] = perms[r.module][k] || r[k];
  }
  return perms;
}

// ─── Supabase Auth account helpers (used by routes/auth.ts) ─────────────────
// Users may have no real email; Supabase Auth needs one, so we derive a stable
// synthetic address from the username. Never shown to users.
export const authEmailFor = (row: { email?: string | null; username?: string | null; id?: number }) =>
  (row.email && row.email.includes("@")) ? row.email.trim().toLowerCase()
    : `${(row.username || `user${row.id}`).toLowerCase().replace(/[^a-z0-9._-]/g, "")}@users.headmasters.local`;

// Create (or link) the Supabase Auth account for a users row. Accepts either
// a plaintext password or an existing bcrypt hash (imports legacy passwords
// without ever knowing them).
export async function ensureAuthAccount(row: { id: number; email?: string | null; username?: string | null; auth_user_id?: string | null },
  cred: { password?: string; password_hash?: string }): Promise<string> {
  if (row.auth_user_id) return row.auth_user_id;
  const email = authEmailFor(row);
  // deno-lint-ignore no-explicit-any
  const attrs: any = { email, email_confirm: true, user_metadata: { erp_user_id: row.id } };
  if (cred.password_hash) attrs.password_hash = cred.password_hash; else attrs.password = cred.password;
  let { data, error } = await adminClient().auth.admin.createUser(attrs);
  if (error && /already|exists|registered/i.test(error.message)) {
    // Account exists (e.g. re-run) → find it and link.
    const list = await adminClient().auth.admin.listUsers({ perPage: 1000 });
    // deno-lint-ignore no-explicit-any
    const found = list.data?.users?.find((u: any) => (u.email || "").toLowerCase() === email);
    if (!found) throw error;
    data = { user: found } as typeof data;
    error = null;
  }
  if (error || !data?.user) throw error ?? new Error("Auth account creation failed");
  await pg.run("UPDATE users SET auth_user_id=? WHERE id=?", data.user.id, row.id);
  return data.user.id;
}

export async function setAuthPassword(authUserId: string, password: string) {
  const { error } = await adminClient().auth.admin.updateUserById(authUserId, { password });
  if (error) throw error;
}

// Sliding session (mam: "automatically logout — very bad"). When the access
// token is within 2 days of expiry and the client supplied its refresh token,
// rotate the pair and hand both back in headers; the client swaps them in.
export async function maybeSlideSession(req: Req, res: Res) {
  try {
    const exp = req.user?.exp;
    const rt = req.headers["x-refresh-token"];
    if (!exp || !rt) return;
    const remaining = exp - Math.floor(Date.now() / 1000);
    // Slide once the token is in its last quarter (min 30 min): a 1-hour token
    // rotates in its last 30 min, a 7-day token in its last ~1.75 days —
    // without rotating the refresh token on every single /auth/me call.
    const lifetime = req.user?.iat ? exp - req.user.iat : 7 * 24 * 3600;
    if (remaining > Math.max(1800, lifetime * 0.25)) return;
    const { data, error } = await anonClient().auth.refreshSession({ refresh_token: rt });
    if (error || !data.session) return;
    res.setHeader("X-Refresh-Token", data.session.access_token);
    res.setHeader("X-New-Refresh-Token", data.session.refresh_token);
  } catch { /* best-effort */ }
}
