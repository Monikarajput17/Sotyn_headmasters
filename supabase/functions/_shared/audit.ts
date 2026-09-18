// Port of server/middleware/audit.js — records every mutating request and
// offers logAuditEvent() for richer manual entries. Fire-and-forget.
import pg from "./pg.ts";
import type { Handler } from "./express-lite.ts";

const SECRET_KEYS = new Set(["password", "current_password", "new_password", "token", "authorization", "secret"]);
const METHOD_TO_ACTION: Record<string, string> = { POST: "CREATE", PUT: "UPDATE", PATCH: "UPDATE", DELETE: "DELETE" };
const SKIP_PATH_PREFIXES = [
  "/api/attendance/track-location", "/api/attendance/my-today", "/api/attendance/my-month",
  "/api/dashboard", "/api/audit", "/api/admin/audit", "/api/upload", "/api/auth/me", "/api/auth/my-permissions",
  "/api/auth/login", "/api/auth/refresh", "/api/site-chat/unread-count",
];

// deno-lint-ignore no-explicit-any
function summariseBody(body: any) {
  if (!body || typeof body !== "object") return null;
  try {
    const safe = Array.isArray(body) ? body.slice() : { ...body };
    if (!Array.isArray(safe)) for (const k of Object.keys(safe)) if (SECRET_KEYS.has(k.toLowerCase())) safe[k] = "[REDACTED]";
    const str = JSON.stringify(safe);
    return str.length > 2000 ? str.slice(0, 2000) + "…" : str;
  } catch { return "[unserialisable]"; }
}
function entityTypeFromPath(p: string) {
  const m = p.replace(/^\/+/, "").split("/");
  if (m[0] === "api" && m[1]) return m[1];
  return m[0] || null;
}
function entityIdFromPath(p: string) {
  const parts = p.split("/").filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) if (/^\d+$/.test(parts[i])) return parts[i];
  return null;
}

export const auditMiddleware: Handler = (req, res, next) => {
  try {
    if (!METHOD_TO_ACTION[req.method]) return next();
    if (SKIP_PATH_PREFIXES.some((p) => (req.originalUrl || "").startsWith(p))) return next();
    const pathOnly = (req.originalUrl || "").split("?")[0];
    res.on("finish", () => {
      const user = req.user || {};
      pg.run(
        `INSERT INTO audit_log (user_id, user_name, user_role, action, entity_type, entity_id, method, path, query, body_summary, status_code, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        user.id ?? null, user.name ?? null, user.role ?? null,
        METHOD_TO_ACTION[req.method] || req.method, entityTypeFromPath(pathOnly), entityIdFromPath(pathOnly),
        req.method, pathOnly,
        req.query && Object.keys(req.query).length ? JSON.stringify(req.query) : null,
        // Work payloads can contain requester-private internal notes and evidence.
        // Their transactional, permission-scoped history is authoritative.
        pathOnly.startsWith('/api/work/') ? '[Details retained in scoped workflow history]' : summariseBody(req.body), res.statusCode ?? null, req.ip || null,
        (req.headers["user-agent"] || "").slice(0, 200) || null,
      ).catch((e) => console.error("[audit] insert failed:", e.message, "path=", pathOnly));
    });
  } catch (e) { console.error("[audit] middleware failure:", (e as Error).message); }
  next();
};

// deno-lint-ignore no-explicit-any
export function logAuditEvent(opts: any) {
  const { user, action, entity_type, entity_id, entity_label, before, after, method, path, query, body, status_code, ip, user_agent } = opts || {};
  pg.run(
    `INSERT INTO audit_log (user_id, user_name, user_role, action, entity_type, entity_id, entity_label, method, path, query, body_summary, status_code, ip, user_agent, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    user?.id || null, user?.name || null, user?.role || null, action || null, entity_type || null,
    entity_id != null ? String(entity_id) : null, entity_label || null, method || null, path || null,
    query ? JSON.stringify(query) : null, body ? summariseBody(body) : null, status_code || null, ip || null,
    user_agent ? String(user_agent).slice(0, 200) : null,
    before ? (typeof before === "string" ? before : JSON.stringify(before)).slice(0, 10000) : null,
    after ? (typeof after === "string" ? after : JSON.stringify(after)).slice(0, 10000) : null,
  ).catch((e) => console.error("[audit] manual log failed:", e.message));
}
