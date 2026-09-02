// PMS Tasks — Project Management tasks created by CRM against a specific
// Business Book project. Same lifecycle as delegations (pending → submitted →
// approved/rejected) but each task is tied to a BB project and carries the
// CRM name auto-captured from the project's latest Client PO upload.

const express = require('express');
const pg = require('../db/pg');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Permission helper — admin bypasses, otherwise check role_permissions.
// Mirrors the pattern used by other modules so view/create/edit/delete gates
// are consistent across the app.
const can = async (uid, action) => {
  const u = await pg.get('SELECT role FROM users WHERE id=?', uid);
  if (u?.role === 'admin') return true;
  const actionCol = { view: 'can_view', create: 'can_create', edit: 'can_edit', delete: 'can_delete', approve: 'can_approve' }[action] || 'can_view';
  const row = await pg.get(
    `SELECT MAX(rp.${actionCol}) as allowed
     FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
     WHERE ur.user_id = ? AND rp.module = 'pms_tasks'`, uid);
  return !!row?.allowed;
};

// Dropdown data for the "pick project" selector on the create form. Returns
// every Business Book row with its latest Client PO's crm_name pre-joined, so
// the frontend doesn't have to make a second call when the user picks a project.
router.get('/projects', async (req, res) => {
  try {
    const rows = await pg.all(`
      SELECT
        bb.id,
        bb.lead_no,
        bb.client_name,
        bb.company_name,
        COALESCE(s.name, bb.project_name) AS project_name,
        (SELECT po.crm_name FROM purchase_orders po
           WHERE po.business_book_id = bb.id AND po.crm_name IS NOT NULL AND po.crm_name != ''
           ORDER BY po.created_at DESC LIMIT 1) AS crm_name
      FROM business_book bb
      LEFT JOIN sites s ON s.business_book_id = bb.id
      ORDER BY bb.created_at DESC
    `);
    // De-duplicate on the unique project triple (site/project/company). If a BB
    // row has multiple sites the COALESCE already picked the site name; we keep
    // the first occurrence of each unique label.
    const seen = new Set();
    const unique = [];
    for (const r of rows) {
      const key = `${(r.project_name || '').toLowerCase()}|${(r.company_name || '').toLowerCase()}|${(r.client_name || '').toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(r);
    }
    res.json(unique);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List PMS tasks, same scope model as delegations: ?scope=mine|given|all and
// ?status=pending|submitted|approved|rejected.
router.get('/', async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const uid = req.user.id;
    const { scope = 'mine', status, crm_id, assignee_id, date_from, date_to } = req.query;

    const where = [];
    const params = [];
    if ((isAdmin || await can(uid, 'approve')) && scope === 'all') {
      // admin or a PMS executive (approve on pms_tasks) sees everything
      // no filter
    } else if (scope === 'followup') {
      // Everyone's tasks, defaulting to active (non-approved). Status dropdown
      // can still override to show approved-only across everyone.
      if (!status) where.push("p.status != 'approved'");
    } else if (scope === 'given') {
      where.push('p.assigned_by = ?'); params.push(uid);
    } else if (scope === 'mine') {
      where.push('p.assigned_to = ?'); params.push(uid);
    } else {
      where.push('(p.assigned_to = ? OR p.assigned_by = ?)'); params.push(uid, uid);
    }
    if (status) { where.push('p.status = ?'); params.push(status); }
    // Mam-requested filters: CRM (assigner), assignee, date range on due_date
    if (crm_id) { where.push('p.assigned_by = ?'); params.push(+crm_id); }
    if (assignee_id) { where.push('p.assigned_to = ?'); params.push(+assignee_id); }
    if (date_from) { where.push('COALESCE(p.due_date, p.created_at) >= ?'); params.push(date_from); }
    if (date_to) { where.push('COALESCE(p.due_date, p.created_at) <= ?'); params.push(date_to + ' 23:59:59'); }

    const sql = `SELECT p.*,
        au.name AS assigned_by_name,
        tu.name AS assigned_to_name,
        rv.name AS reviewer_name,
        bb.lead_no,
        bb.client_name,
        bb.company_name,
        COALESCE(s.name, bb.project_name, p.project_name_snapshot) AS project_name_live
      FROM pms_tasks p
      LEFT JOIN users au ON au.id = p.assigned_by
      LEFT JOIN users tu ON tu.id = p.assigned_to
      LEFT JOIN users rv ON rv.id = p.reviewer_id
      LEFT JOIN business_book bb ON bb.id = p.project_id
      LEFT JOIN sites s ON s.business_book_id = bb.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY
        CASE p.status WHEN 'rejected' THEN 0 WHEN 'pending' THEN 1 WHEN 'submitted' THEN 2 ELSE 3 END,
        COALESCE(p.due_date, '9999-12-31') ASC,
        p.created_at DESC`;
    res.json(await pg.all(sql, ...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create a PMS task. Admin or anyone with pms_tasks.create permission.
// project_id is required; project_name_snapshot and crm_name are captured
// server-side from Business Book + latest Client PO so the UI can't spoof
// them. Title is derived from the first line of the description.
router.post('/', async (req, res) => {
  try {
    if (!(await can(req.user.id, 'create'))) return res.status(403).json({ error: 'Not allowed to create PMS tasks' });
    const { description, project_id, assigned_to, due_date, attachment_url } = req.body;
    const desc = String(description || '').trim();
    if (!desc) return res.status(400).json({ error: 'Description is required' });
    if (!project_id) return res.status(400).json({ error: 'Project is required' });
    if (!assigned_to) return res.status(400).json({ error: 'Assignee is required' });

    // Look up the project + its latest CRM in one go
    const proj = await pg.get(`
      SELECT bb.id, COALESCE(s.name, bb.project_name) AS project_name,
        (SELECT po.crm_name FROM purchase_orders po
           WHERE po.business_book_id = bb.id AND po.crm_name IS NOT NULL AND po.crm_name != ''
           ORDER BY po.created_at DESC LIMIT 1) AS crm_name
      FROM business_book bb
      LEFT JOIN sites s ON s.business_book_id = bb.id
      WHERE bb.id = ?
    `, project_id);
    if (!proj) return res.status(400).json({ error: 'Project not found' });

    const derivedTitle = desc.split(/\r?\n/)[0].slice(0, 80).trim() || 'PMS Task';
    const attachment = attachment_url && String(attachment_url).trim() ? String(attachment_url).trim() : null;
    const r = await pg.run(
      `INSERT INTO pms_tasks
         (title, description, project_id, project_name_snapshot, crm_name, assigned_by, assigned_to, due_date, attachment_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      derivedTitle, desc, proj.id, proj.project_name, proj.crm_name, req.user.id, assigned_to, due_date || null, attachment);

    try {
      const { notify } = require('../lib/push');
      notify(assigned_to, {
        title: `📌 PMS — ${proj.project_name || 'Task'}`,
        body: derivedTitle + (due_date ? ` · due ${due_date}` : ''),
        url: '/pms-tasks',
        tag: `pms-${r.lastInsertRowid}`,
      });
    } catch {}
    res.status(201).json({ id: r.lastInsertRowid, crm_name: proj.crm_name, project_name: proj.project_name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Edit a PMS task — admin or the original assigner only. Allowed in any
// status; status / proof / reject_reason are NOT touched here. Partial
// update — only fields the caller sent are modified.
router.put('/:id', async (req, res) => {
  try {
    const t = await pg.get('SELECT assigned_by FROM pms_tasks WHERE id=?', req.params.id);
    if (!t) return res.status(404).json({ error: 'Task not found' });
    if (t.assigned_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the assigner or an admin can edit this task' });
    }
    const b = req.body || {};
    const desc = b.description != null ? String(b.description).trim() : null;
    if (b.description != null && !desc) return res.status(400).json({ error: 'Description cannot be empty' });
    const assignedTo = b.assigned_to != null ? +b.assigned_to : null;
    const dueDate = b.due_date != null ? (b.due_date || null) : undefined;
    const title = desc ? (desc.split(/\r?\n/)[0].slice(0, 80).trim() || 'PMS Task') : null;

    const sets = []; const params = [];
    if (desc != null) { sets.push('description=?', 'title=?'); params.push(desc, title); }
    if (assignedTo) { sets.push('assigned_to=?'); params.push(assignedTo); }
    if (dueDate !== undefined) { sets.push('due_date=?'); params.push(dueDate); }

    // Optionally allow re-targeting the project (if business book changed)
    if (b.project_id) {
      const proj = await pg.get(`
        SELECT bb.id, COALESCE(s.name, bb.project_name) AS project_name,
          (SELECT po.crm_name FROM purchase_orders po
             WHERE po.business_book_id = bb.id AND po.crm_name IS NOT NULL AND po.crm_name != ''
             ORDER BY po.created_at DESC LIMIT 1) AS crm_name
        FROM business_book bb
        LEFT JOIN sites s ON s.business_book_id = bb.id
        WHERE bb.id = ?
      `, b.project_id);
      if (proj) {
        sets.push('project_id=?', 'project_name_snapshot=?', 'crm_name=?');
        params.push(proj.id, proj.project_name, proj.crm_name);
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    params.push(req.params.id);
    await pg.run(`UPDATE pms_tasks SET ${sets.join(', ')} WHERE id=?`, ...params);
    res.json({ message: 'Task updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Lifecycle: same as delegations ---

router.post('/:id/submit', async (req, res) => {
  try {
    const { proof_url } = req.body;
    const t = await pg.get('SELECT * FROM pms_tasks WHERE id=?', req.params.id);
    if (!t) return res.status(404).json({ error: 'Task not found' });
    if (t.assigned_to !== req.user.id && req.user.role !== 'admin' && !(await can(req.user.id, 'approve'))) {
      return res.status(403).json({ error: 'Only the assignee or a PMS executive can submit proof' });
    }
    if (!proof_url) return res.status(400).json({ error: 'Proof file is required' });
    await pg.run(
      `UPDATE pms_tasks SET status='submitted', proof_url=?, submitted_at=CURRENT_TIMESTAMP, reject_reason=NULL WHERE id=?`,
      proof_url, req.params.id);
    res.json({ message: 'Proof submitted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mam (2026-05-21): "if in pms task site name is sushila then she
// need to approval why not option" — the project's CRM owner should
// also be allowed to approve / reject, not just the assigner.  Match
// the user's name against t.crm_name (case-insensitive, trimmed)
// because the task only stores the CRM as a name snapshot.  Names
// like "Sushila" / "sushila kumari" / "Sushila K" all hit because we
// use word-token overlap.
function isCrmOwner(t, user) {
  if (!t?.crm_name || !user?.name) return false;
  const taskCrm = String(t.crm_name).toLowerCase().trim();
  const userName = String(user.name).toLowerCase().trim();
  if (!taskCrm || !userName) return false;
  if (taskCrm === userName) return true;
  // First-token match — "Sushila" on the task = "Sushila Kumari" user, etc.
  const taskFirst = taskCrm.split(/\s+/)[0];
  const userFirst = userName.split(/\s+/)[0];
  return !!taskFirst && taskFirst === userFirst;
}

async function canApprovePmsTask(t, user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (t.assigned_by === user.id) return true;
  if (isCrmOwner(t, user)) return true;
  // Honour the role-matrix "Approve" permission (mam 2026-06-17): a user
  // granted PMS Tasks → Approve can approve/reject anyone's task.
  if (await can(user.id, 'approve')) return true;
  return false;
}

router.post('/:id/approve', async (req, res) => {
  try {
    const t = await pg.get('SELECT * FROM pms_tasks WHERE id=?', req.params.id);
    if (!t) return res.status(404).json({ error: 'Task not found' });
    if (!(await canApprovePmsTask(t, req.user))) {
      return res.status(403).json({ error: 'Only the assigner, the project CRM owner, or an admin can approve' });
    }
    if (t.status !== 'submitted') return res.status(400).json({ error: 'Task is not awaiting approval' });
    await pg.run(`UPDATE pms_tasks SET status='approved', reviewed_at=CURRENT_TIMESTAMP, reviewer_id=? WHERE id=?`,
      req.user.id, req.params.id);
    res.json({ message: 'Approved' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'Rejection reason is required' });
    const t = await pg.get('SELECT * FROM pms_tasks WHERE id=?', req.params.id);
    if (!t) return res.status(404).json({ error: 'Task not found' });
    if (!(await canApprovePmsTask(t, req.user))) {
      return res.status(403).json({ error: 'Only the assigner, the project CRM owner, or an admin can reject' });
    }
    await pg.run(
      `UPDATE pms_tasks SET status='rejected', reject_reason=?, reviewed_at=CURRENT_TIMESTAMP, reviewer_id=? WHERE id=?`,
      reason.trim(), req.user.id, req.params.id);
    res.json({ message: 'Rejected' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Extension requests (same as delegations) ---

router.post('/:id/request-extension', async (req, res) => {
  try {
    const { requested_due_date, reason } = req.body;
    if (!requested_due_date) return res.status(400).json({ error: 'New due date is required' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason is required' });
    const t = await pg.get('SELECT * FROM pms_tasks WHERE id=?', req.params.id);
    if (!t) return res.status(404).json({ error: 'Task not found' });
    if (t.assigned_to !== req.user.id && req.user.role !== 'admin' && !(await can(req.user.id, 'approve'))) {
      return res.status(403).json({ error: 'Only the assignee or a PMS executive can request an extension' });
    }
    if (t.status === 'approved') return res.status(400).json({ error: 'Task already approved' });
    await pg.run(
      `UPDATE pms_tasks SET requested_due_date=?, extension_reason=?, extension_status='pending',
         extension_reviewed_at=NULL, extension_reviewed_by=NULL
       WHERE id=?`,
      requested_due_date, reason.trim(), req.params.id);
    res.json({ message: 'Extension requested' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/approve-extension', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admin can approve extensions' });
    const t = await pg.get('SELECT * FROM pms_tasks WHERE id=?', req.params.id);
    if (!t || t.extension_status !== 'pending' || !t.requested_due_date) {
      return res.status(400).json({ error: 'No pending extension' });
    }
    await pg.run(
      `UPDATE pms_tasks SET due_date = requested_due_date, extension_status='approved',
         extension_reviewed_at=CURRENT_TIMESTAMP, extension_reviewed_by=?
       WHERE id=?`,
      req.user.id, req.params.id);
    res.json({ message: 'Extension approved' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/reject-extension', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admin can reject extensions' });
    await pg.run(
      `UPDATE pms_tasks SET extension_status='rejected',
         extension_reviewed_at=CURRENT_TIMESTAMP, extension_reviewed_by=?
       WHERE id=?`,
      req.user.id, req.params.id);
    res.json({ message: 'Extension rejected' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete — assigner or admin only.
router.delete('/:id', async (req, res) => {
  try {
    const t = await pg.get('SELECT assigned_by FROM pms_tasks WHERE id=?', req.params.id);
    if (!t) return res.status(404).json({ error: 'Task not found' });
    if (t.assigned_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the assigner can delete' });
    }
    await pg.run('DELETE FROM pms_tasks WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
