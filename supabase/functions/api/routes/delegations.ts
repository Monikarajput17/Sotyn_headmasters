// deno-lint-ignore-file no-explicit-any
// Delegations (PMS tasks) — port of server/routes/delegations.js (Phase-3
// Postgres version). Response shapes unchanged.
//
// Edge deviations:
//   • /transcribe (self-hosted whisper.cpp + ffmpeg) needs a local binary and
//     a filesystem — not available in an Edge Function → 501.
//   • The Hinglish romanizer (Claude via the ERP's stored ai_api_key) is kept,
//     loaded lazily so a missing SDK / key simply skips romanization.
import { Router, upload } from "../../_shared/express-lite.ts";
import pg from "../../_shared/pg.ts";
import { authMiddleware } from "../../_shared/auth.ts";
import { notify } from "../../_shared/lib/push.ts";
import { legacyWork } from "../../_shared/work-legacy.ts";
const router = Router();
router.use(authMiddleware);
router.use(legacyWork('tasks'));

// ─── duplicateGuard (local async copy of server/utils/duplicateGuard.js) ──
// Mam (2026-05-21): "raise entry data can not be duplicate if some enter data
// duplicate give him notification with code that check already do it whole erp".
// Comparison is case-insensitive + trim-folded; NULL / blank fields ignored.
async function findDuplicate(db: any, opts: any) {
  const {
    table,
    fields,                 // { col_name: value, ... }
    codeColumn = "id",      // which column to surface to the user
    codePrefix = "",        // optional prefix to prepend (e.g. 'TSK-')
    codePad = 0,            // zero-pad numeric code to N digits
    excludeId = null,       // skip a specific row (for updates)
  } = opts;
  if (!table || !fields || typeof fields !== "object") return null;
  const entries = Object.entries(fields).filter(([_, v]) => {
    if (v === null || v === undefined) return false;
    if (typeof v === "string" && v.trim() === "") return false;
    return true;
  });
  if (entries.length === 0) return null;
  const where = entries
    .map(([k]) => `LOWER(TRIM(COALESCE(${k}::text, ''))) = LOWER(TRIM(?))`)
    .join(" AND ");
  const params: any[] = entries.map(([_, v]) => String(v));
  let sql = `SELECT ${codeColumn} AS _code, * FROM ${table} WHERE ${where}`;
  if (excludeId != null) { sql += " AND id != ?"; params.push(excludeId); }
  sql += " LIMIT 1";
  let row: any;
  try {
    row = await db.get(sql, ...params);
  } catch (e) {
    // Malformed table / column — fail open (don't block submission on our bug).
    console.warn("[duplicateGuard] query failed:", (e as Error).message, { table, fields });
    return null;
  }
  if (!row) return null;
  let code = String(row._code ?? row.id ?? "");
  if (codePad && /^\d+$/.test(code)) code = code.padStart(codePad, "0");
  if (codePrefix) code = codePrefix + code;
  return { code, row };
}
function sendDuplicate(res: any, dup: any, label = "Entry") {
  if (!dup) return false;
  res.status(409).json({
    error: `Duplicate · ${label} already exists as ${dup.code}`,
    duplicate: true,
    existing_code: dup.code,
    existing_id: dup.row.id,
  });
  return true;
}

// ─── Voice-note → text ────────────────────────────────────────────────────
// The original ran ffmpeg + whisper.cpp on the VPS (mam 2026-06-17: "give me
// free"). Edge Functions have no local binaries, so this deployment answers
// 501 and the UI falls back to typing. The romanizer below is kept intact
// for when transcription is wired to a hosted service.
async function getSetting(key: string) {
  try { const row = await pg.get("SELECT value FROM app_settings WHERE key=?", key); return row?.value ?? null; }
  catch (_) { return null; }
}

// Staff type tasks in Roman letters, so convert Whisper's accurate Hindi
// (Devanagari) into casual Hinglish using the Claude key the ERP already has.
// Best-effort: no key, or any failure, just returns the original text so
// transcription never breaks. Set WHISPER_ROMANIZE=0 to keep Devanagari.
// Free, dependency-free Devanagari → Roman transliteration. Not perfect
// Hinglish (some inherent-'a' artifacts remain) but always readable Roman,
// no API key / no cost. Used as the guaranteed fallback so output is NEVER
// left in Hindi script.
export function devanagariToRoman(input: string): string {
  const V: Record<string, string> = { "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo", "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऍ": "e", "ऑ": "o", "ॲ": "a" };
  const M: Record<string, string> = { "ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo", "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॅ": "e", "ॉ": "o", "ं": "n", "ँ": "n", "ः": "h" };
  const C: Record<string, string> = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
    "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
    "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "व": "v",
    "श": "sh", "ष": "sh", "स": "s", "ह": "h", "ळ": "l", "ड़": "r", "ढ़": "rh", "क़": "q", "ख़": "kh", "ग़": "g", "ज़": "z", "फ़": "f", "य़": "y",
  };
  const D: Record<string, string> = { "०": "0", "१": "1", "२": "2", "३": "3", "४": "4", "५": "5", "६": "6", "७": "7", "८": "8", "९": "9" };
  const HALANT = "्";
  const chars = Array.from(input);
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (C[ch]) {
      out += C[ch];
      const nxt = chars[i + 1];
      if (nxt === HALANT) { i++; continue; }            // conjunct → no vowel
      if (nxt && M[nxt]) { out += M[nxt]; i++; continue; } // explicit matra
      out += "a";                                        // inherent vowel
    } else if (V[ch]) { out += V[ch]; }
    else if (M[ch]) { out += M[ch]; }
    else if (D[ch]) { out += D[ch]; }
    else { out += ch; }                                  // spaces / punctuation / latin
  }
  return out.replace(/([a-z])a\b/g, "$1");               // drop most word-final inherent 'a'
}

export async function romanizeToHinglish(text: string): Promise<string> {
  if (!text) return text;
  if (Deno.env.get("WHISPER_ROMANIZE") === "0") return text;
  if (!/[ऀ-ॿ]/.test(text)) return text;   // no Hindi script → nothing to do
  // Prefer Claude (natural Hinglish) IF a key is set — use the SAME model the
  // ERP's AI agent already uses, so we never fail on an unsupported model id.
  const apiKey = await getSetting("ai_api_key");
  if (apiKey) {
    try {
      const Anthropic = (await import("npm:@anthropic-ai/sdk@0.40.1")).default;
      const client = new Anthropic({ apiKey, timeout: 30000 });
      const model = Deno.env.get("ROMANIZE_MODEL") || (await getSetting("ai_model")) || "claude-opus-4-7";
      const r: any = await client.messages.create({
        model, max_tokens: 1200,
        system: 'You transliterate Hindi (Devanagari) into casual Romanized Hinglish exactly how an Indian office worker types in English letters (e.g. "मटेरियल भेजो" -> "material bhejo"). Keep English / brand / product words in English. Do NOT translate the meaning, and do NOT add, remove, or explain anything. Output ONLY the transliterated text.',
        messages: [{ role: "user", content: text }],
      });
      const out = (r.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
      if (out && !/[ऀ-ॿ]/.test(out)) return out;        // good Roman result from Claude
    } catch (_) { /* fall through to the free local transliterator */ }
  }
  return devanagariToRoman(text);                         // guaranteed Roman, no key needed
}

router.post("/transcribe", upload.single("audio"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No audio file received." });
  res.status(501).json({ error: "Voice transcription is not available in this deployment" });
});

// Is this user an EA / supervisor / PMS owner (e.g. Sushila, PMS Executive)?
// Treated as having the can_approve flag on the tasks module. Accepts EITHER
// 'delegations' OR 'pms_tasks' so it matches the frontend (which gates its
// buttons on canApprove('pms_tasks')) — grant either and it works end-to-end.
// Such a user gets (a) the "All" tab across everyone's tasks, (b) upload proof
// on anyone's behalf, and (c) approve/reject tasks + extensions.
const isEA = async (uid: number) => {
  const row = await pg.get(
    `SELECT MAX(rp.can_approve) as allowed
     FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
     WHERE ur.user_id = ? AND rp.module IN ('delegations','pms_tasks')`,
    uid);
  return !!row?.allowed;
};

// List delegations. By default, a user sees tasks assigned TO them. Admin
// and EA (can_approve on delegations) see everything via scope=all.
// Query params: ?scope=mine|given|all, ?status, ?assignee_id, ?date_from, ?date_to
router.get("/", async (req, res) => {
  try {
    const isAdmin = req.user.role === "admin";
    const uid = req.user.id;
    const canSeeAll = isAdmin || await isEA(uid);
    const { scope = "mine", status, assignee_id, date_from, date_to } = req.query;

    const where: string[] = [];
    const params: any[] = [];
    if (canSeeAll && scope === "all") {
      // no user filter — admin / EA sees everything
    } else if (scope === "given") {
      where.push("d.assigned_by = ?"); params.push(uid);
    } else if (scope === "mine") {
      where.push("d.assigned_to = ?"); params.push(uid);
    } else {
      where.push("(d.assigned_to = ? OR d.assigned_by = ?)"); params.push(uid, uid);
    }
    if (status) { where.push("d.status = ?"); params.push(status); }
    // Name filter — admin/EA filter by assignee_id from the dropdown
    if (assignee_id) { where.push("d.assigned_to = ?"); params.push(+assignee_id); }
    // Date range filters — inclusive on both ends. Uses due_date since that's
    // what mam typically cares about when chasing follow-ups.
    if (date_from) { where.push("d.due_date >= ?"); params.push(date_from); }
    if (date_to) { where.push("d.due_date <= ?"); params.push(date_to); }

    const sql = `SELECT d.*,
        au.name as assigned_by_name,
        tu.name as assigned_to_name,
        rv.name as reviewer_name
      FROM delegations d
      LEFT JOIN users au ON au.id = d.assigned_by
      LEFT JOIN users tu ON tu.id = d.assigned_to
      LEFT JOIN users rv ON rv.id = d.reviewer_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY
        CASE d.status WHEN 'rejected' THEN 0 WHEN 'pending' THEN 1 WHEN 'submitted' THEN 2 ELSE 3 END,
        COALESCE(d.due_date, '9999-12-31') ASC,
        d.created_at DESC`;
    res.json(await pg.all(sql, ...params));
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Per-person workload dashboard. mam's spec — one row per assignee with:
//   Total Tasks · Active · Completed · Delayed · Avg Delay (days) · WIP Limit · Status
// Status:
//   Overloaded — active_tasks > wip_limit
//   Constraint — >= 25% of tasks delayed OR avg_delay > 5 days
//   OK         — neither
// WIP limit is 5 by default for everyone; can be made per-user later.
router.get("/dashboard", async (_req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const WIP_LIMIT_DEFAULT = 5;

    const rows = await pg.all(`
      SELECT u.id, u.name as person, u.role, u.department,
             COUNT(d.id) as total_tasks,
             SUM(CASE WHEN d.status IN ('pending','submitted','rejected') THEN 1 ELSE 0 END) as active_tasks,
             SUM(CASE WHEN d.status = 'approved' THEN 1 ELSE 0 END) as completed,
             SUM(CASE WHEN d.status IN ('pending','submitted')
                       AND d.due_date IS NOT NULL AND d.due_date < ? THEN 1 ELSE 0 END) as delayed_tasks,
             ROUND(AVG(CASE WHEN d.status IN ('pending','submitted')
                             AND d.due_date IS NOT NULL AND d.due_date < ?
                            THEN (?::date - LEFT(d.due_date,10)::date) ELSE NULL END)::numeric, 1) as avg_delay
        FROM users u
        LEFT JOIN delegations d ON d.assigned_to = u.id
       WHERE u.active = 1
       GROUP BY u.id, u.name, u.role, u.department
      HAVING COUNT(d.id) > 0
       ORDER BY active_tasks DESC, delayed_tasks DESC, person
    `, today, today, today);

    const out = rows.map((r: any) => {
      const wip = WIP_LIMIT_DEFAULT;
      const delayedRatio = r.total_tasks > 0 ? r.delayed_tasks / r.total_tasks : 0;
      let status = "OK";
      if (r.active_tasks > wip) status = "Overloaded";
      else if (delayedRatio >= 0.25 || (r.avg_delay || 0) > 5) status = "Constraint";
      return {
        id: r.id,
        person: r.person,
        role: r.role,
        department: r.department,
        total_tasks: r.total_tasks || 0,
        active_tasks: r.active_tasks || 0,
        completed: r.completed || 0,
        delayed_tasks: r.delayed_tasks || 0,
        avg_delay: r.avg_delay || 0,
        wip_limit: wip,
        status,
      };
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Create a new delegation. Admin-only — regular users are recipients, not creators.
// Title is derived from the first line of the description (first 80 chars)
// since the UI no longer asks for it separately.
// project_name is optional — free text so admin can tag tasks with a project
// without depending on any master list.
router.post("/", async (req, res) => {
  try {
    // Allow: legacy admin role OR any user whose role-matrix has
    // delegations.create / can_approve. Mam's MD (Ankur Kaplesh) is on
    // a non-admin role with full delegation perms via the matrix — the
    // old hardcoded `role !== 'admin'` check blocked him from raising
    // tasks even though he's the senior-most user. The matrix is the
    // source of truth now.
    if (req.user.role !== "admin") {
      const ok = await pg.get(`
        SELECT MAX(CASE WHEN rp.can_create = 1 OR rp.can_approve = 1 THEN 1 ELSE 0 END) as ok
        FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
        WHERE ur.user_id = ? AND rp.module = 'delegations'
      `, req.user.id);
      if (!ok?.ok) return res.status(403).json({ error: "You need Delegations: Create permission to raise tasks" });
    }
    const { title, description, assigned_to, due_date, project_name, attachment_url } = req.body || {};
    const desc = String(description || "").trim();
    if (!desc) return res.status(400).json({ error: "Description is required" });
    if (!assigned_to) return res.status(400).json({ error: "Assignee is required" });
    const derivedTitle = (title && title.trim()) || desc.split(/\r?\n/)[0].slice(0, 80).trim() || "Task";
    const project = project_name && String(project_name).trim() ? String(project_name).trim() : null;
    const attachment = attachment_url && String(attachment_url).trim() ? String(attachment_url).trim() : null;

    // Mam (2026-05-21): block duplicate tasks — same description + same
    // assignee + same due-date = same task.  Toast surfaces the existing
    // TSK code so the user can find / extend it instead of re-raising.
    const dup = await findDuplicate(pg, {
      table: "delegations",
      fields: { description: desc, assigned_to, due_date: due_date || null },
      codeColumn: "id", codePrefix: "TSK-", codePad: 4,
    });
    if (sendDuplicate(res, dup, "Task")) return;

    const r = await pg.run(
      `INSERT INTO delegations (title, description, assigned_by, assigned_to, due_date, project_name, attachment_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      derivedTitle, desc, req.user.id, assigned_to, due_date || null, project, attachment);
    // Fire-and-forget push to the assignee
    try {
      notify(assigned_to, {
        title: "📋 New Delegation",
        body: `${req.user.name || "Admin"} assigned: ${derivedTitle}${due_date ? ` · due ${due_date}` : ""}`,
        url: "/delegations",
        tag: `delegation-${r.lastInsertRowid}`,
      });
    } catch { /* never block the submit */ }
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Full edit of an existing task — description, assignee, due date, project,
// attachment. Admin or the original assigner only. Allowed in any status
// (pending / submitted / approved / rejected) so mam can fix typos or
// reassign even after submission. Status / proof / reject_reason are NOT
// touched here — those go through their own endpoints.
router.put("/:id", async (req, res) => {
  try {
    const d = await pg.get("SELECT assigned_by, due_date FROM delegations WHERE id=?", req.params.id);
    if (!d) return res.status(404).json({ error: "Task not found" });
    if (d.assigned_by !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the assigner or an admin can edit this task" });
    }
    const b = req.body || {};
    const desc = b.description != null ? String(b.description).trim() : null;
    if (b.description != null && !desc) return res.status(400).json({ error: "Description cannot be empty" });
    const assignedTo = b.assigned_to != null ? +b.assigned_to : null;
    const dueDate = b.due_date != null ? (b.due_date || null) : undefined;
    const project = b.project_name != null ? (String(b.project_name).trim() || null) : undefined;
    const attachment = b.attachment_url != null ? (String(b.attachment_url).trim() || null) : undefined;
    const title = desc ? (desc.split(/\r?\n/)[0].slice(0, 80).trim() || "Task") : null;

    // Build a partial UPDATE — only touch fields the caller actually sent
    const sets: string[] = []; const params: any[] = [];
    if (desc != null) { sets.push("description=?", "title=?"); params.push(desc, title); }
    if (assignedTo) { sets.push("assigned_to=?"); params.push(assignedTo); }
    if (dueDate !== undefined) {
      sets.push("due_date=?"); params.push(dueDate);
      // A manual re-date is "another date given" too, same as an approved extension —
      // bump the health-light counter, but only on a genuine change to a NEW date
      // (not clearing the date or re-saving the same day).
      if (dueDate && d.due_date && dueDate !== d.due_date) sets.push("extension_count = COALESCE(extension_count, 0) + 1");
    }
    if (project !== undefined) { sets.push("project_name=?"); params.push(project); }
    if (attachment !== undefined) { sets.push("attachment_url=?"); params.push(attachment); }
    if (sets.length === 0) return res.status(400).json({ error: "No fields to update" });
    params.push(req.params.id);
    await pg.run(`UPDATE delegations SET ${sets.join(", ")} WHERE id=?`, ...params);
    res.json({ message: "Task updated" });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Inline edit of project_name on an existing task. Admin or the assigner only,
// so random users can't retag someone else's tasks. Empty string clears it.
router.patch("/:id/project", async (req, res) => {
  try {
    const d = await pg.get("SELECT assigned_by FROM delegations WHERE id=?", req.params.id);
    if (!d) return res.status(404).json({ error: "Task not found" });
    if (d.assigned_by !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the assigner or an admin can edit the project" });
    }
    const raw = req.body?.project_name;
    const value = raw && String(raw).trim() ? String(raw).trim() : null;
    await pg.run("UPDATE delegations SET project_name=? WHERE id=?", value, req.params.id);
    res.json({ message: "Project updated", project_name: value });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Inline edit of the EA's followup remark for the MD (mam 2026-06-17).
// EA (can_approve on delegations) or admin only — it's the EA's note, and it
// does NOT change the task's status/completion. Empty string clears it.
router.patch("/:id/followup-remarks", async (req, res) => {
  try {
    const d = await pg.get("SELECT id FROM delegations WHERE id=?", req.params.id);
    if (!d) return res.status(404).json({ error: "Task not found" });
    if (req.user.role !== "admin" && !(await isEA(req.user.id))) {
      return res.status(403).json({ error: "Only the EA or an admin can edit followup remarks" });
    }
    const raw = req.body?.followup_remarks;
    const value = raw && String(raw).trim() ? String(raw).trim() : null;
    await pg.run("UPDATE delegations SET followup_remarks=? WHERE id=?", value, req.params.id);
    res.json({ message: "Followup remark saved", followup_remarks: value });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Assignee requests a due-date extension. Admin (not the assigner) approves.
router.post("/:id/request-extension", async (req, res) => {
  try {
    const { requested_due_date, reason } = req.body || {};
    if (!requested_due_date) return res.status(400).json({ error: "New due date is required" });
    if (!reason || !reason.trim()) return res.status(400).json({ error: "Reason is required" });
    const d = await pg.get("SELECT * FROM delegations WHERE id=?", req.params.id);
    if (!d) return res.status(404).json({ error: "Task not found" });
    if (d.assigned_to !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the assignee can request an extension" });
    }
    if (d.status === "approved") return res.status(400).json({ error: "Task already approved — no extension needed" });
    await pg.run(
      `UPDATE delegations SET requested_due_date=?, extension_reason=?, extension_status='pending',
         extension_reviewed_at=NULL, extension_reviewed_by=NULL
       WHERE id=?`,
      requested_due_date, reason.trim(), req.params.id);
    res.json({ message: "Extension requested — admin will review" });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Admin-only: approve the pending extension — updates due_date, clears request.
// Slippage light rule: red/yellow/green = number of times the due date was
// PUSHED (extension_count), NOT proximity to the date.
router.post("/:id/approve-extension", async (req, res) => {
  try {
    if (req.user.role !== "admin" && !(await isEA(req.user.id))) return res.status(403).json({ error: "Only an admin or PMS owner can approve extensions" });
    const d = await pg.get("SELECT * FROM delegations WHERE id=?", req.params.id);
    if (!d) return res.status(404).json({ error: "Task not found" });
    if (d.extension_status !== "pending" || !d.requested_due_date) {
      return res.status(400).json({ error: "No pending extension to approve" });
    }
    await pg.run(
      `UPDATE delegations SET due_date = requested_due_date,
         extension_count = COALESCE(extension_count, 0) + 1,
         extension_status='approved', extension_reviewed_at=CURRENT_TIMESTAMP, extension_reviewed_by=?
       WHERE id=?`,
      req.user.id, req.params.id);
    res.json({ message: "Extension approved — due date updated" });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Admin-only: reject the pending extension.
router.post("/:id/reject-extension", async (req, res) => {
  try {
    if (req.user.role !== "admin" && !(await isEA(req.user.id))) return res.status(403).json({ error: "Only an admin or PMS owner can reject extensions" });
    const d = await pg.get("SELECT * FROM delegations WHERE id=?", req.params.id);
    if (!d) return res.status(404).json({ error: "Task not found" });
    if (d.extension_status !== "pending") return res.status(400).json({ error: "No pending extension" });
    await pg.run(
      `UPDATE delegations SET extension_status='rejected',
         extension_reviewed_at=CURRENT_TIMESTAMP, extension_reviewed_by=?
       WHERE id=?`,
      req.user.id, req.params.id);
    res.json({ message: "Extension rejected" });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Submit proof. Originally assignee-only; now admin and EA can submit on
// behalf of the assignee too — mam asked for this so her EA can upload
// proof for team members who send photos/PDFs over WhatsApp.
router.post("/:id/submit", async (req, res) => {
  try {
    const { proof_url } = req.body || {};
    const d = await pg.get("SELECT * FROM delegations WHERE id=?", req.params.id);
    if (!d) return res.status(404).json({ error: "Task not found" });
    const canSubmit = d.assigned_to === req.user.id || req.user.role === "admin" || await isEA(req.user.id);
    if (!canSubmit) {
      return res.status(403).json({ error: "Only the assignee, admin or EA can submit proof" });
    }
    if (!proof_url) return res.status(400).json({ error: "Proof file is required" });
    await pg.run(
      `UPDATE delegations SET status='submitted', proof_url=?, submitted_at=CURRENT_TIMESTAMP, reject_reason=NULL WHERE id=?`,
      proof_url, req.params.id);
    res.json({ message: "Proof submitted, awaiting approval" });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Approve / reject — admin OR the PMS owner (EA = can_approve on delegations,
// e.g. Sushila / PMS Executive). Anyone can upload proof (assignee or EA);
// admin/PMS-owner checks + approves/rejects the task.
router.post("/:id/approve", async (req, res) => {
  try {
    if (req.user.role !== "admin" && !(await isEA(req.user.id))) return res.status(403).json({ error: "Only an admin or PMS owner can approve tasks" });
    const d = await pg.get("SELECT * FROM delegations WHERE id=?", req.params.id);
    if (!d) return res.status(404).json({ error: "Task not found" });
    if (d.status !== "submitted") return res.status(400).json({ error: "Task is not awaiting approval" });
    await pg.run(
      `UPDATE delegations SET status='approved', reviewed_at=CURRENT_TIMESTAMP, reviewer_id=? WHERE id=?`,
      req.user.id, req.params.id);
    res.json({ message: "Task approved" });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.post("/:id/reject", async (req, res) => {
  try {
    if (req.user.role !== "admin" && !(await isEA(req.user.id))) return res.status(403).json({ error: "Only an admin or PMS owner can reject tasks" });
    const { reason } = req.body || {};
    if (!reason || !reason.trim()) return res.status(400).json({ error: "Rejection reason is required" });
    const d = await pg.get("SELECT * FROM delegations WHERE id=?", req.params.id);
    if (!d) return res.status(404).json({ error: "Task not found" });
    await pg.run(
      `UPDATE delegations SET status='rejected', reject_reason=?, reviewed_at=CURRENT_TIMESTAMP, reviewer_id=? WHERE id=?`,
      reason.trim(), req.user.id, req.params.id);
    res.json({ message: "Task rejected, assignee notified" });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Delete a delegation — only the assigner or an admin.
router.delete("/:id", async (req, res) => {
  try {
    const d = await pg.get("SELECT assigned_by FROM delegations WHERE id=?", req.params.id);
    if (!d) return res.status(404).json({ error: "Task not found" });
    if (d.assigned_by !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the assigner can delete" });
    }
    await pg.run("DELETE FROM delegations WHERE id=?", req.params.id);
    res.json({ message: "Deleted" });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Dashboard stats for the current user — minimal payload for the homepage widgets.
router.get("/stats", async (req, res) => {
  try {
    const uid = req.user.id;
    const pending_mine = (await pg.get(
      `SELECT COUNT(*) as c FROM delegations WHERE assigned_to=? AND status IN ('pending','rejected')`, uid)).c;
    const awaiting_approval = (await pg.get(
      `SELECT COUNT(*) as c FROM delegations WHERE assigned_by=? AND status='submitted'`, uid)).c;
    const rejected_mine = (await pg.get(
      `SELECT COUNT(*) as c FROM delegations WHERE assigned_to=? AND status='rejected'`, uid)).c;
    res.json({ pending_mine, awaiting_approval, rejected_mine });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

export default router;
