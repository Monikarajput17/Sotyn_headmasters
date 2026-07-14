// PMS Tasks — Project Management tasks created by CRM against a specific
// Business Book project. Same lifecycle as delegations (pending → submitted →
// approved/rejected) but each task is tied to a BB project and carries the
// CRM name auto-captured from the project's latest Client PO upload.

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Permission helper — admin bypasses, otherwise check role_permissions.
// Mirrors the pattern used by other modules so view/create/edit/delete gates
// are consistent across the app.
const can = (uid, action) => {
  const db = getDb();
  const u = db.prepare('SELECT role FROM users WHERE id=?').get(uid);
  if (u?.role === 'admin') return true;
  const actionCol = { view: 'can_view', create: 'can_create', edit: 'can_edit', delete: 'can_delete', approve: 'can_approve' }[action] || 'can_view';
  const row = db.prepare(
    `SELECT MAX(rp.${actionCol}) as allowed
     FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
     WHERE ur.user_id = ? AND rp.module = 'pms_tasks'`
  ).get(uid);
  return !!row?.allowed;
};

// Dropdown data for the "pick project" selector on the create form. Returns
// every Business Book row with its latest Client PO's crm_name pre-joined, so
// the frontend doesn't have to make a second call when the user picks a project.
router.get('/projects', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
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
  `).all();
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
});

// List PMS tasks, same scope model as delegations: ?scope=mine|given|all and
// ?status=pending|submitted|approved|rejected.
router.get('/', (req, res) => {
  const db = getDb();
  const isAdmin = req.user.role === 'admin';
  const uid = req.user.id;
  const { scope = 'mine', status, crm_id, assignee_id, date_from, date_to } = req.query;

  const where = [];
  const params = [];
  if ((isAdmin || can(uid, 'approve')) && scope === 'all') {
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
  res.json(db.prepare(sql).all(...params));
});

// Create a PMS task. Admin or anyone with pms_tasks.create permission.
// project_id is required; project_name_snapshot and crm_name are captured
// server-side from Business Book + latest Client PO so the UI can't spoof
// them. Title is derived from the first line of the description.
router.post('/', (req, res) => {
  if (!can(req.user.id, 'create')) return res.status(403).json({ error: 'Not allowed to create PMS tasks' });
  const { description, project_id, assigned_to, due_date, attachment_url } = req.body;
  const desc = String(description || '').trim();
  if (!desc) return res.status(400).json({ error: 'Description is required' });
  if (!project_id) return res.status(400).json({ error: 'Project is required' });
  if (!assigned_to) return res.status(400).json({ error: 'Assignee is required' });

  const db = getDb();
  // Look up the project + its latest CRM in one go
  const proj = db.prepare(`
    SELECT bb.id, COALESCE(s.name, bb.project_name) AS project_name,
      (SELECT po.crm_name FROM purchase_orders po
         WHERE po.business_book_id = bb.id AND po.crm_name IS NOT NULL AND po.crm_name != ''
         ORDER BY po.created_at DESC LIMIT 1) AS crm_name
    FROM business_book bb
    LEFT JOIN sites s ON s.business_book_id = bb.id
    WHERE bb.id = ?
  `).get(project_id);
  if (!proj) return res.status(400).json({ error: 'Project not found' });

  const derivedTitle = desc.split(/\r?\n/)[0].slice(0, 80).trim() || 'PMS Task';
  const attachment = attachment_url && String(attachment_url).trim() ? String(attachment_url).trim() : null;
  const r = db.prepare(
    `INSERT INTO pms_tasks
       (title, description, project_id, project_name_snapshot, crm_name, assigned_by, assigned_to, due_date, attachment_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(derivedTitle, desc, proj.id, proj.project_name, proj.crm_name, req.user.id, assigned_to, due_date || null, attachment);

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
});

// Edit a PMS task — admin or the original assigner only. Allowed in any
// status; status / proof / reject_reason are NOT touched here. Partial
// update — only fields the caller sent are modified.
router.put('/:id', (req, res) => {
  const db = getDb();
  const t = db.prepare('SELECT assigned_by FROM pms_tasks WHERE id=?').get(req.params.id);
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
    const proj = db.prepare(`
      SELECT bb.id, COALESCE(s.name, bb.project_name) AS project_name,
        (SELECT po.crm_name FROM purchase_orders po
           WHERE po.business_book_id = bb.id AND po.crm_name IS NOT NULL AND po.crm_name != ''
           ORDER BY po.created_at DESC LIMIT 1) AS crm_name
      FROM business_book bb
      LEFT JOIN sites s ON s.business_book_id = bb.id
      WHERE bb.id = ?
    `).get(b.project_id);
    if (proj) {
      sets.push('project_id=?', 'project_name_snapshot=?', 'crm_name=?');
      params.push(proj.id, proj.project_name, proj.crm_name);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE pms_tasks SET ${sets.join(', ')} WHERE id=?`).run(...params);
  res.json({ message: 'Task updated' });
});

// --- Lifecycle: same as delegations ---

router.post('/:id/submit', (req, res) => {
  const { proof_url } = req.body;
  const db = getDb();
  const t = db.prepare('SELECT * FROM pms_tasks WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (t.assigned_to !== req.user.id && req.user.role !== 'admin' && !can(req.user.id, 'approve')) {
    return res.status(403).json({ error: 'Only the assignee or a PMS executive can submit proof' });
  }
  if (!proof_url) return res.status(400).json({ error: 'Proof file is required' });
  db.prepare(
    `UPDATE pms_tasks SET status='submitted', proof_url=?, submitted_at=CURRENT_TIMESTAMP, reject_reason=NULL WHERE id=?`
  ).run(proof_url, req.params.id);
  res.json({ message: 'Proof submitted' });
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

function canApprovePmsTask(t, user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (t.assigned_by === user.id) return true;
  if (isCrmOwner(t, user)) return true;
  // Honour the role-matrix "Approve" permission (mam 2026-06-17): a user
  // granted PMS Tasks → Approve can approve/reject anyone's task.
  if (can(user.id, 'approve')) return true;
  return false;
}

router.post('/:id/approve', (req, res) => {
  const db = getDb();
  const t = db.prepare('SELECT * FROM pms_tasks WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!canApprovePmsTask(t, req.user)) {
    return res.status(403).json({ error: 'Only the assigner, the project CRM owner, or an admin can approve' });
  }
  if (t.status !== 'submitted') return res.status(400).json({ error: 'Task is not awaiting approval' });
  db.prepare(`UPDATE pms_tasks SET status='approved', reviewed_at=CURRENT_TIMESTAMP, reviewer_id=? WHERE id=?`)
    .run(req.user.id, req.params.id);
  res.json({ message: 'Approved' });
});

router.post('/:id/reject', (req, res) => {
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Rejection reason is required' });
  const db = getDb();
  const t = db.prepare('SELECT * FROM pms_tasks WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!canApprovePmsTask(t, req.user)) {
    return res.status(403).json({ error: 'Only the assigner, the project CRM owner, or an admin can reject' });
  }
  db.prepare(
    `UPDATE pms_tasks SET status='rejected', reject_reason=?, reviewed_at=CURRENT_TIMESTAMP, reviewer_id=? WHERE id=?`
  ).run(reason.trim(), req.user.id, req.params.id);
  res.json({ message: 'Rejected' });
});

// --- Extension requests (same as delegations) ---

router.post('/:id/request-extension', (req, res) => {
  const { requested_due_date, reason } = req.body;
  if (!requested_due_date) return res.status(400).json({ error: 'New due date is required' });
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason is required' });
  const db = getDb();
  const t = db.prepare('SELECT * FROM pms_tasks WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (t.assigned_to !== req.user.id && req.user.role !== 'admin' && !can(req.user.id, 'approve')) {
    return res.status(403).json({ error: 'Only the assignee or a PMS executive can request an extension' });
  }
  if (t.status === 'approved') return res.status(400).json({ error: 'Task already approved' });
  db.prepare(
    `UPDATE pms_tasks SET requested_due_date=?, extension_reason=?, extension_status='pending',
       extension_reviewed_at=NULL, extension_reviewed_by=NULL
     WHERE id=?`
  ).run(requested_due_date, reason.trim(), req.params.id);
  res.json({ message: 'Extension requested' });
});

router.post('/:id/approve-extension', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admin can approve extensions' });
  const db = getDb();
  const t = db.prepare('SELECT * FROM pms_tasks WHERE id=?').get(req.params.id);
  if (!t || t.extension_status !== 'pending' || !t.requested_due_date) {
    return res.status(400).json({ error: 'No pending extension' });
  }
  db.prepare(
    `UPDATE pms_tasks SET due_date = requested_due_date, extension_status='approved',
       extension_reviewed_at=CURRENT_TIMESTAMP, extension_reviewed_by=?
     WHERE id=?`
  ).run(req.user.id, req.params.id);
  res.json({ message: 'Extension approved' });
});

router.post('/:id/reject-extension', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admin can reject extensions' });
  const db = getDb();
  db.prepare(
    `UPDATE pms_tasks SET extension_status='rejected',
       extension_reviewed_at=CURRENT_TIMESTAMP, extension_reviewed_by=?
     WHERE id=?`
  ).run(req.user.id, req.params.id);
  res.json({ message: 'Extension rejected' });
});

// Delete — assigner or admin only.
router.delete('/:id', (req, res) => {
  const db = getDb();
  const t = db.prepare('SELECT assigned_by FROM pms_tasks WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (t.assigned_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the assigner can delete' });
  }
  db.prepare('DELETE FROM pms_tasks WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
