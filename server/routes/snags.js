// Snag List — site defects / punch-list items, with a delegation-style
// proof + approval workflow.
//
// Status flow (mam: "assign employee will upload proof and after
// approval task close like delegation"):
//
//   open       → raised; assignee has not yet uploaded proof
//   submitted  → assignee uploaded proof_url; raiser/admin reviewing
//   approved   → raiser/admin accepted proof — task closed
//   rejected   → raiser/admin rejected proof; assignee can resubmit
//
// Permissions:
//   view     — see snags
//   create   — Raise Snag (management / anyone mam ticks)
//   edit     — edit fields, assignee submits proof
//   approve  — approve / reject submitted proof, also acts as admin scope
//   delete   — delete a snag (audit-friendly, admins typically only)

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

function isApprover(db, user) {
  if (user.role === 'admin') return true;
  const r = db.prepare(`
    SELECT MAX(CASE WHEN rp.can_approve = 1 THEN 1 ELSE 0 END) as ok
    FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
    WHERE ur.user_id = ? AND rp.module = 'snags'
  `).get(user.id);
  return !!r?.ok;
}

// LIST
router.get('/', requirePermission('snags', 'view'), (req, res) => {
  try {
    const db = getDb();
    const { status, priority, site_id, assigned_to, scope, search } = req.query;
    let sql = `
      SELECT s.*,
             rb.name as raised_by_name,
             at.name as assigned_to_user_name,
             ap.name as approved_by_name,
             ps.name as proof_submitted_by_name,
             site.name as site_name_live
      FROM snags s
      LEFT JOIN users rb ON rb.id = s.raised_by
      LEFT JOIN users at ON at.id = s.assigned_to
      LEFT JOIN users ap ON ap.id = s.approved_by
      LEFT JOIN users ps ON ps.id = s.proof_submitted_by
      LEFT JOIN sites site ON site.id = s.site_id
      WHERE 1=1
    `;
    const params = [];
    if (status) { sql += ' AND s.status = ?'; params.push(status); }
    if (priority) { sql += ' AND s.priority = ?'; params.push(priority); }
    if (site_id) { sql += ' AND s.site_id = ?'; params.push(site_id); }
    if (assigned_to) { sql += ' AND s.assigned_to = ?'; params.push(assigned_to); }
    // scope=mine → only those raised-by or assigned-to me
    if (scope === 'mine') {
      sql += ' AND (s.raised_by = ? OR s.assigned_to = ?)';
      params.push(req.user.id, req.user.id);
    }
    if (search) {
      sql += ' AND (s.description LIKE ? OR s.location LIKE ? OR s.snag_no LIKE ? OR s.site_name LIKE ?)';
      const q = `%${search}%`;
      params.push(q, q, q, q);
    }
    // Open / submitted at top so urgent things are visible first
    sql += ` ORDER BY
      CASE s.status WHEN 'submitted' THEN 0 WHEN 'open' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END,
      s.raised_at DESC`;
    res.json(db.prepare(sql).all(...params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/stats', requirePermission('snags', 'view'), (req, res) => {
  try {
    const db = getDb();
    const total = db.prepare('SELECT COUNT(*) as c FROM snags').get().c;
    const open = db.prepare("SELECT COUNT(*) as c FROM snags WHERE status='open'").get().c;
    const submitted = db.prepare("SELECT COUNT(*) as c FROM snags WHERE status='submitted'").get().c;
    const approved = db.prepare("SELECT COUNT(*) as c FROM snags WHERE status='approved'").get().c;
    const rejected = db.prepare("SELECT COUNT(*) as c FROM snags WHERE status='rejected'").get().c;
    const critical = db.prepare("SELECT COUNT(*) as c FROM snags WHERE priority='critical' AND status NOT IN ('approved')").get().c;
    res.json({ total, open, submitted, approved, rejected, critical });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// RAISE
router.post('/', requirePermission('snags', 'create'), (req, res) => {
  try {
    const b = req.body;
    if (!b.description || !String(b.description).trim()) {
      return res.status(400).json({ error: 'Description is required' });
    }
    const db = getDb();
    const { nextSequence } = require('../db/nextSequence');
    const yr = new Date().getFullYear();
    const snagNo = nextSequence(db, 'snags', 'snag_no', `SNAG-${yr}-`, { startFrom: 0, pad: 4 });
    const priority = ['low','medium','high','critical'].includes(b.priority) ? b.priority : 'medium';

    let siteName = b.site_name || null;
    if (!siteName && b.site_id) {
      const s = db.prepare('SELECT name FROM sites WHERE id=?').get(b.site_id);
      siteName = s?.name || null;
    }
    let assigneeName = b.assigned_to_name || null;
    if (!assigneeName && b.assigned_to) {
      const u = db.prepare('SELECT name FROM users WHERE id=?').get(b.assigned_to);
      assigneeName = u?.name || null;
    }

    const r = db.prepare(`
      INSERT INTO snags (
        snag_no, site_id, site_name, location, description, photo_url,
        priority, status, assigned_to, assigned_to_name,
        raised_by, target_date
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      snagNo, b.site_id || null, siteName, b.location || null,
      b.description, b.photo_url || null,
      priority, 'open', b.assigned_to || null, assigneeName,
      req.user.id, b.target_date || null
    );

    // Notify the assignee that a snag was raised against them.
    try {
      const { notifyMany } = require('../lib/push');
      if (b.assigned_to && b.assigned_to !== req.user.id) {
        notifyMany([b.assigned_to], {
          title: `🚧 ${snagNo} assigned to you`,
          body: `${siteName ? siteName + ' · ' : ''}${b.location ? b.location + ' · ' : ''}${String(b.description).slice(0, 80)}`,
          url: '/snags',
          tag: `snag-${r.lastInsertRowid}`,
        });
      }
    } catch {}

    res.status(201).json({ id: r.lastInsertRowid, snag_no: snagNo });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// EDIT (raiser / admin / approver — not the assignee)
// Lets the raiser change description / site / location / assignee /
// priority / target. Status is NOT editable here — use submit/approve/reject.
router.put('/:id', requirePermission('snags', 'edit'), (req, res) => {
  try {
    const b = req.body;
    const db = getDb();
    const cur = db.prepare('SELECT raised_by, status FROM snags WHERE id=?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Snag not found' });
    if (cur.raised_by !== req.user.id && !isApprover(db, req.user)) {
      return res.status(403).json({ error: 'Only the raiser or an approver can edit this snag' });
    }

    const fields = ['site_id','site_name','location','description','photo_url','priority','assigned_to','assigned_to_name','target_date'];
    const sets = []; const vals = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f}=?`); vals.push(b[f]); }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    vals.push(req.params.id);
    db.prepare(`UPDATE snags SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SUBMIT PROOF (assignee uploads photo + optional notes)
// Approvers / admin can also submit on behalf of the assignee (matches
// the delegations.js convenience for WhatsApp-handover photos).
router.post('/:id/submit', (req, res) => {
  try {
    const { proof_url, proof_notes } = req.body;
    if (!proof_url) return res.status(400).json({ error: 'Proof file is required' });
    const db = getDb();
    const s = db.prepare('SELECT * FROM snags WHERE id=?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (s.assigned_to !== req.user.id && !isApprover(db, req.user)) {
      return res.status(403).json({ error: 'Only the assignee or an approver can submit proof' });
    }
    if (s.status === 'approved') return res.status(400).json({ error: 'Already approved' });

    db.prepare(`
      UPDATE snags
         SET proof_url=?, proof_notes=?, proof_submitted_by=?, proof_submitted_at=CURRENT_TIMESTAMP,
             status='submitted', reject_reason=NULL, rejected_at=NULL
       WHERE id=?
    `).run(proof_url, proof_notes || null, req.user.id, req.params.id);

    // Notify the raiser that proof is in for review.
    try {
      const { notifyMany } = require('../lib/push');
      if (s.raised_by && s.raised_by !== req.user.id) {
        notifyMany([s.raised_by], {
          title: `✅ ${s.snag_no} — proof submitted`,
          body: `${s.site_name ? s.site_name + ' · ' : ''}Awaiting your approval`,
          url: '/snags',
          tag: `snag-${s.id}`,
        });
      }
    } catch {}

    res.json({ message: 'Proof submitted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// APPROVE — raiser or approver closes the snag.
router.post('/:id/approve', (req, res) => {
  try {
    const db = getDb();
    const s = db.prepare('SELECT * FROM snags WHERE id=?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (s.raised_by !== req.user.id && !isApprover(db, req.user)) {
      return res.status(403).json({ error: 'Only the raiser or an approver can approve' });
    }
    if (s.status !== 'submitted') return res.status(400).json({ error: 'No submitted proof to approve' });

    db.prepare(`
      UPDATE snags SET status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP
       WHERE id=?
    `).run(req.user.id, req.params.id);

    try {
      const { notifyMany } = require('../lib/push');
      if (s.assigned_to && s.assigned_to !== req.user.id) {
        notifyMany([s.assigned_to], {
          title: `🎉 ${s.snag_no} approved`,
          body: 'Snag closed — proof accepted.',
          url: '/snags',
          tag: `snag-${s.id}`,
        });
      }
    } catch {}

    res.json({ message: 'Approved' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// REJECT — raiser sends it back with a reason; assignee resubmits.
router.post('/:id/reject', (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'Reason is required' });
    const db = getDb();
    const s = db.prepare('SELECT * FROM snags WHERE id=?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (s.raised_by !== req.user.id && !isApprover(db, req.user)) {
      return res.status(403).json({ error: 'Only the raiser or an approver can reject' });
    }
    if (s.status !== 'submitted') return res.status(400).json({ error: 'No submitted proof to reject' });

    db.prepare(`
      UPDATE snags SET status='rejected', reject_reason=?, rejected_at=CURRENT_TIMESTAMP
       WHERE id=?
    `).run(reason, req.params.id);

    try {
      const { notifyMany } = require('../lib/push');
      if (s.assigned_to && s.assigned_to !== req.user.id) {
        notifyMany([s.assigned_to], {
          title: `⚠️ ${s.snag_no} — proof rejected`,
          body: String(reason).slice(0, 140),
          url: '/snags',
          tag: `snag-${s.id}`,
        });
      }
    } catch {}

    res.json({ message: 'Rejected — assignee can resubmit' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', requirePermission('snags', 'delete'), (req, res) => {
  try {
    getDb().prepare('DELETE FROM snags WHERE id=?').run(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
