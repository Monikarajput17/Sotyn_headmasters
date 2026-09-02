// deno-lint-ignore-file no-explicit-any
// Help tickets — port of server/routes/support.js (Phase-3 Postgres version).
// Response shapes unchanged. Push + email hooks are fire-and-forget through
// the shared libs (both no-op safely when SMTP / VAPID are not configured).
import { Router } from "../../_shared/express-lite.ts";
import pg from "../../_shared/pg.ts";
import { authMiddleware } from "../../_shared/auth.ts";
import { nextSequencePg } from "../../_shared/nextSequence.ts";
import { fireEmailEvent } from "../../_shared/lib/emailRules.ts";
import { getDirectorEmail } from "../../_shared/lib/email.ts";
import { notify, notifyMany } from "../../_shared/lib/push.ts";

const stUserEmail = async (id: any) => { try { return (await pg.get("SELECT email FROM users WHERE id=?", id))?.email || null; } catch { return null; } };
const stDirector = () => { try { return getDirectorEmail(); } catch { return null; } };
const router = Router();
router.use(authMiddleware);

// GET tickets. Admin can see all by default; non-admin only sees tickets
// they raised or were assigned to. Optional ?scope=mine|given|all changes
// the slice:
//   mine  -> assigned_to = current user (default for non-admins on the page)
//   given -> user_id = current user (raised by me)
//   all   -> everything (admin OR users with help_tickets.see_all)
//
// Mam: 'help tickets also permission one PC we need to followup all help
// tickets'. The help_tickets module See All toggle in Roles & Permissions
// lets her give one specific user/role access to every ticket without
// making them full admin.
router.get("/", async (req, res) => {
  try {
    const user = await pg.get("SELECT role FROM users WHERE id=?", req.user.id);
    const isAdmin = user?.role === "admin";
    // can_see_all OR can_approve on help_tickets → treated as "follow-up everything"
    const seeAllRow = await pg.get(`
      SELECT MAX(CASE WHEN rp.can_see_all = 1 OR rp.can_approve = 1 THEN 1 ELSE 0 END) as ok
      FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = ? AND rp.module = 'help_tickets'
    `, req.user.id);
    const canSeeAll = isAdmin || !!seeAllRow?.ok;
    const scope = String(req.query.scope || "").toLowerCase();
    const status = req.query.status;
    const where: string[] = [];
    const params: any[] = [];
    if (scope === "mine") { where.push("t.assigned_to = ?"); params.push(req.user.id); }
    else if (scope === "given") { where.push("t.user_id = ?"); params.push(req.user.id); }
    else if (scope === "all" && !canSeeAll) {
      // No See-All permission → fall back to OR of mine+given so the URL
      // can't be used to leak other users' tickets.
      where.push("(t.user_id = ? OR t.assigned_to = ?)"); params.push(req.user.id, req.user.id);
    } else if (!scope && !canSeeAll) {
      where.push("(t.user_id = ? OR t.assigned_to = ?)"); params.push(req.user.id, req.user.id);
    }
    if (status) { where.push("t.status = ?"); params.push(status); }

    let sql = `SELECT t.*,
        u.name as user_name,
        r.name as resolved_by_name,
        a.name as assigned_to_name
      FROM support_tickets t
      LEFT JOIN users u ON t.user_id = u.id
      LEFT JOIN users r ON t.resolved_by = r.id
      LEFT JOIN users a ON t.assigned_to = a.id`;
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY t.created_at DESC";
    res.json(await pg.all(sql, ...params));
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Stats for the "Assigned to me" dashboard widget — count of active tickets
// assigned to the current user.
router.get("/mine", async (req, res) => {
  try {
    const active = await pg.get(
      "SELECT COUNT(*) as c FROM support_tickets WHERE assigned_to = ? AND status IN ('open','in_progress')",
      req.user.id,
    );
    const recent = await pg.all(
      `SELECT t.*, u.name as user_name
       FROM support_tickets t
       LEFT JOIN users u ON t.user_id = u.id
       WHERE t.assigned_to = ? AND t.status IN ('open','in_progress')
       ORDER BY
         CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         t.created_at DESC
       LIMIT 5`,
      req.user.id,
    );
    res.json({ active: active.c, recent });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// GET stats (admin dashboard)
router.get("/stats", async (_req, res) => {
  try {
    const total = await pg.get("SELECT COUNT(*) as c FROM support_tickets");
    const open = await pg.get("SELECT COUNT(*) as c FROM support_tickets WHERE status='open'");
    const inProgress = await pg.get("SELECT COUNT(*) as c FROM support_tickets WHERE status='in_progress'");
    const resolved = await pg.get("SELECT COUNT(*) as c FROM support_tickets WHERE status='resolved'");
    const byCategory = await pg.all("SELECT category, COUNT(*) as count FROM support_tickets GROUP BY category");
    res.json({ total: total.c, open: open.c, inProgress: inProgress.c, resolved: resolved.c, byCategory });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// POST new ticket. `assigned_to` is optional; when set, that user sees the
// ticket on their dashboard + can respond to it.
router.post("/", async (req, res) => {
  try {
    const { subject, description, category, priority, attachment_link, module, assigned_to } = req.body || {};
    if (!subject || !description) return res.status(400).json({ error: "Subject and description required" });
    const ticketNo = await nextSequencePg(pg, "support_tickets", "ticket_no", "TK-", { startFrom: 1000, pad: 5 });
    const r = await pg.run(
      "INSERT INTO support_tickets (ticket_no, user_id, subject, description, category, priority, attachment_link, module, assigned_to) VALUES (?,?,?,?,?,?,?,?,?)",
      ticketNo, req.user.id, subject, description, category || "bug", priority || "medium", attachment_link, module, assigned_to ? +assigned_to : null);
    // Push to assignee (or every admin if unassigned)
    try {
      if (assigned_to) {
        notify(+assigned_to, {
          title: `🆘 ${ticketNo} — ${priority || "medium"} priority`,
          body: subject,
          url: "/help-tickets",
          tag: `ticket-${r.lastInsertRowid}`,
        });
      } else {
        const admins = (await pg.all(`SELECT id FROM users WHERE role='admin' AND COALESCE(active,1)=1`)).map((u: any) => u.id);
        notifyMany(admins, {
          title: `🆘 New unassigned ticket — ${ticketNo}`,
          body: subject,
          url: "/help-tickets",
          tag: `ticket-${r.lastInsertRowid}`,
        });
      }
    } catch { /* never block the submit */ }
    fireEmailEvent("ticket.created", {
      ticket_no: ticketNo,
      subject: subject || "",
      priority: priority || "medium",
      category: category || "bug",
      created_by: req.user.name || "",
      date: new Date().toISOString().slice(0, 10),
      creator_email: req.user.email || await stUserEmail(req.user.id),
      assignee_email: assigned_to ? await stUserEmail(+assigned_to) : null,
      director_email: stDirector(),
    });
    res.status(201).json({ id: r.lastInsertRowid, ticket_no: ticketNo });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// PUT update ticket. Permission rules (mam's spec):
//   - Admin     -> can do anything (status, priority, response, assignee)
//   - Raiser    (user_id == current user) -> can resolve/close their own
//                ticket (they decide when their issue is fixed). Cannot
//                reassign — that stays admin-only.
//   - Assignee  (assigned_to == current user) -> can mark in_progress and
//                add a response; CANNOT close (only the raiser/admin can).
router.put("/:id", async (req, res) => {
  try {
    const { status, admin_response, priority, assigned_to } = req.body || {};
    const user = await pg.get("SELECT role FROM users WHERE id=?", req.user.id);
    const ticket = await pg.get("SELECT * FROM support_tickets WHERE id=?", req.params.id);
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    const isAdmin = user?.role === "admin";
    // Mam's follow-up role: anyone with help_tickets.can_see_all OR
    // can_approve gets the same powers as admin for triage (close /
    // reassign / respond on any ticket).
    const seeAllRow = await pg.get(`
      SELECT MAX(CASE WHEN rp.can_see_all = 1 OR rp.can_approve = 1 THEN 1 ELSE 0 END) as ok
      FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = ? AND rp.module = 'help_tickets'
    `, req.user.id);
    const canFollowAll = isAdmin || !!seeAllRow?.ok;
    const isAssignee = ticket.assigned_to === req.user.id;
    const isRaiser = ticket.user_id === req.user.id;
    const closing = (status === "resolved" || status === "closed");

    if (!canFollowAll) {
      if (closing && !isRaiser) {
        return res.status(403).json({ error: "Only the person who raised this ticket (or admin) can close it" });
      }
      if (assigned_to !== undefined) return res.status(403).json({ error: "Only admin / follow-up role can reassign a ticket" });
      if (!isAssignee && !isRaiser) {
        return res.status(403).json({ error: "Only the assignee, raiser, or admin can update this ticket" });
      }
    }

    const resolvedBy = (status === "resolved" || status === "closed") ? req.user.id : null;
    const resolvedAt = (status === "resolved" || status === "closed") ? new Date().toISOString() : null;

    await pg.run(
      `UPDATE support_tickets SET
         status = COALESCE(?, status),
         admin_response = COALESCE(?, admin_response),
         priority = COALESCE(?, priority),
         assigned_to = ${canFollowAll && assigned_to !== undefined ? "?" : "assigned_to"},
         resolved_by = ?,
         resolved_at = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      status, admin_response, priority,
      ...(canFollowAll && assigned_to !== undefined ? [assigned_to ? +assigned_to : null] : []),
      resolvedBy, resolvedAt, req.params.id,
    );
    if (closing) {
      fireEmailEvent("ticket.resolved", {
        ticket_no: ticket.ticket_no,
        subject: ticket.subject || "",
        resolved_by: req.user.name || "",
        date: new Date().toISOString().slice(0, 10),
        creator_email: await stUserEmail(ticket.user_id),
        assignee_email: await stUserEmail(ticket.assigned_to),
        director_email: stDirector(),
      });
    }
    res.json({ message: "Updated" });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// DELETE (admin only)
router.delete("/:id", async (req, res) => {
  try {
    const user = await pg.get("SELECT role FROM users WHERE id=?", req.user.id);
    if (user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
    await pg.run("DELETE FROM support_tickets WHERE id=?", req.params.id);
    res.json({ message: "Deleted" });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

export default router;
