// Cheque FMS — 3-stage cheque workflow:
//   Stage 1: raise/issue (full cheque details)
//   Stage 2: on or after cheque_date, take action — clear / hold / bounce / stopped
//   Stage 3: on or after hold_until (for held cheques), take a follow-up action
// Mam: "cheque status fms create need filed when raise/issue check
// this is stage one cheque details. stage 2 is call cheque status
// called action is in give dropdwon clear,hold, bounce,stopped with
// give remarks and if cheque hold give next date".
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pg = require('../db/pg');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Photo uploads go to the shared /uploads dir (same one PO / Sales-Bill use).
const uploadDir = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const photoUpload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

const ALLOWED_ACTIONS = ['clear', 'hold', 'bounce', 'stopped', 'cancel', 're_issue'];
const ALLOWED_BANKS = ['HDFC', 'ICICI', 'SBI', 'PNB CC', 'PNB Saving', 'Other'];

// DATE('now','localtime') parity — the server's local calendar date.
const localTodayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// LIST — filters by status, bank, payee. Computes a `stage_due` flag so
// the UI can highlight cheques whose cheque_date (or hold_until) has
// arrived and need an action.
router.get('/', requirePermission('cheques', 'view'), async (req, res) => {
  try {
    const { status, bank, search, action_due } = req.query;
    const today = localTodayStr();
    const where = []; const params = [];
    if (status) { where.push('c.current_status = ?'); params.push(status); }
    if (bank) { where.push('c.bank_name = ?'); params.push(bank); }
    if (search) {
      where.push('(c.cheque_number ILIKE ? OR c.payee_to ILIKE ? OR c.bank_name ILIKE ? OR c.bank_other ILIKE ?)');
      const q = `%${search}%`;
      params.push(q, q, q, q);
    }
    if (action_due === '1') {
      // "Action due now" = pending cheques whose cheque_date <= today
      //   OR hold cheques whose hold_until <= today.
      where.push(`(
        (c.current_status = 'pending' AND LEFT(c.cheque_date,10) <= ?)
        OR (c.current_status = 'hold' AND LEFT(c.hold_until,10) <= ?)
      )`);
      params.push(today, today);
    }
    const sql = `
      SELECT c.*,
             u.name AS raised_by_name,
             CASE
               WHEN c.current_status = 'pending' AND LEFT(c.cheque_date,10) <= ? THEN 1
               WHEN c.current_status = 'hold' AND LEFT(c.hold_until,10) <= ? THEN 1
               ELSE 0
             END AS action_due,
             (SELECT COUNT(*) FROM cheque_actions a WHERE a.cheque_id = c.id) AS action_count
        FROM cheques c
        LEFT JOIN users u ON u.id = c.raised_by
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY c.cheque_date DESC, c.id DESC
    `;
    res.json(await pg.all(sql, today, today, ...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One cheque with its full action history.
router.get('/:id', requirePermission('cheques', 'view'), async (req, res) => {
  try {
    const cheque = await pg.get(`
      SELECT c.*, u.name AS raised_by_name
        FROM cheques c LEFT JOIN users u ON u.id = c.raised_by
       WHERE c.id = ?
    `, req.params.id);
    if (!cheque) return res.status(404).json({ error: 'Cheque not found' });
    const actions = await pg.all(`
      SELECT a.*, u.name AS action_by_name
        FROM cheque_actions a LEFT JOIN users u ON u.id = a.action_by
       WHERE a.cheque_id = ?
       ORDER BY a.action_at ASC
    `, req.params.id);
    res.json({ ...cheque, actions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// STAGE 1 — raise/issue a cheque.
router.post('/', requirePermission('cheques', 'create'), photoUpload.single('photo'), async (req, res) => {
  const b = req.body || {};
  if (!b.cheque_number || !String(b.cheque_number).trim()) return res.status(400).json({ error: 'Cheque Number is required' });
  if (!b.payee_to || !String(b.payee_to).trim()) return res.status(400).json({ error: 'Payee is required' });
  if (!b.cheque_date) return res.status(400).json({ error: 'Cheque Date is required' });

  // Mam (2026-05-21): block duplicate cheques — same cheque number
  // from the same bank = same cheque.  Catches accidental re-entry
  // when the same physical cheque is added twice.
  // (utils/duplicateGuard.findDuplicate is sqlite-sync; the identical
  //  trim/case-folded match is inlined here on the pg adapter.)
  const { sendDuplicate } = require('../utils/duplicateGuard');
  let dup = null;
  try {
    const entries = [['cheque_number', b.cheque_number], ['bank_name', b.bank_name || '']]
      .filter(([_, v]) => !(v === null || v === undefined || (typeof v === 'string' && v.trim() === '')));
    if (entries.length) {
      const cond = entries.map(([k]) => `LOWER(TRIM(COALESCE(${k}, ''))) = LOWER(TRIM(?))`).join(' AND ');
      const row = await pg.get(`SELECT id AS _code, * FROM cheques WHERE ${cond} LIMIT 1`, ...entries.map(([_, v]) => String(v)));
      if (row) {
        let code = String(row._code ?? row.id ?? '');
        if (/^\d+$/.test(code)) code = code.padStart(4, '0');
        dup = { code: 'CHQ-' + code, row };
      }
    }
  } catch (e) {
    // Fail open (don't block submission on our bug) — same as duplicateGuard.
    console.warn('[duplicateGuard] query failed:', e.message, { table: 'cheques' });
  }
  if (sendDuplicate(res, dup, `Cheque #${b.cheque_number}${b.bank_name ? ' on ' + b.bank_name : ''}`)) return;

  const amount = +b.amount || 0;
  let photoUrl = null;
  if (req.file) {
    try {
      const safeName = (req.file.originalname || 'cheque').replace(/[^a-zA-Z0-9._-]/g, '_');
      const newName = `${Date.now()}-${safeName}`;
      fs.renameSync(req.file.path, path.join(uploadDir, newName));
      photoUrl = `/uploads/${newName}`;
    } catch (e) { photoUrl = `/uploads/${req.file.filename}`; }
  }
  const bank = b.bank_name && ALLOWED_BANKS.includes(b.bank_name) ? b.bank_name : (b.bank_name || null);
  const issueStatus = ['approved', 'cancel'].includes(b.issue_status) ? b.issue_status : 'approved';
  try {
    const r = await pg.run(`
      INSERT INTO cheques (cheque_number, payee_to, bank_name, bank_other, cheque_date,
                            amount, photo_url, issue_status, current_status, raised_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      String(b.cheque_number).trim(),
      String(b.payee_to).trim(),
      bank,
      b.bank_other || null,
      b.cheque_date,
      amount,
      photoUrl,
      issueStatus,
      issueStatus === 'cancel' ? 'cancel' : 'pending',
      req.user.id,
    );
    res.status(201).json({ id: r.lastInsertRowid, photo_url: photoUrl });
  } catch (e) {
    if (photoUrl) { try { fs.unlinkSync(path.join(uploadDir, path.basename(photoUrl))); } catch (_) {} }
    res.status(500).json({ error: e.message });
  }
});

// EDIT stage-1 details before any action has been logged. Once any
// action exists, the row is read-only (audit integrity).
router.put('/:id', requirePermission('cheques', 'edit'), photoUpload.single('photo'), async (req, res) => {
  try {
    const cur = await pg.get('SELECT id, current_status, photo_url FROM cheques WHERE id=?', req.params.id);
    if (!cur) return res.status(404).json({ error: 'Cheque not found' });
    const hasAction = await pg.get('SELECT 1 FROM cheque_actions WHERE cheque_id=? LIMIT 1', req.params.id);
    if (hasAction) return res.status(400).json({ error: 'Cheque already has an action logged — cannot edit core details. Add a new action instead.' });

    const b = req.body || {};
    let photoUrl = cur.photo_url;
    if (req.file) {
      try {
        const safeName = (req.file.originalname || 'cheque').replace(/[^a-zA-Z0-9._-]/g, '_');
        const newName = `${Date.now()}-${safeName}`;
        fs.renameSync(req.file.path, path.join(uploadDir, newName));
        photoUrl = `/uploads/${newName}`;
      } catch (e) { photoUrl = `/uploads/${req.file.filename}`; }
    }
    const bank = b.bank_name && ALLOWED_BANKS.includes(b.bank_name) ? b.bank_name : (b.bank_name || null);
    const issueStatus = ['approved', 'cancel'].includes(b.issue_status) ? b.issue_status : 'approved';
    await pg.run(`
      UPDATE cheques
         SET cheque_number = COALESCE(?, cheque_number),
             payee_to = COALESCE(?, payee_to),
             bank_name = ?,
             bank_other = ?,
             cheque_date = COALESCE(?, cheque_date),
             amount = COALESCE(?, amount),
             photo_url = ?,
             issue_status = ?,
             current_status = CASE WHEN ? = 'cancel' THEN 'cancel' ELSE current_status END,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `,
      b.cheque_number != null ? String(b.cheque_number).trim() : null,
      b.payee_to != null ? String(b.payee_to).trim() : null,
      bank,
      b.bank_other || null,
      b.cheque_date || null,
      b.amount != null ? +b.amount : null,
      photoUrl,
      issueStatus,
      issueStatus,
      req.params.id,
    );
    res.json({ message: 'Cheque updated', photo_url: photoUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE — only when no actions logged (audit safety).
router.delete('/:id', requirePermission('cheques', 'delete'), async (req, res) => {
  try {
    const cur = await pg.get('SELECT id FROM cheques WHERE id=?', req.params.id);
    if (!cur) return res.status(404).json({ error: 'Cheque not found' });
    const hasAction = await pg.get('SELECT 1 FROM cheque_actions WHERE cheque_id=? LIMIT 1', req.params.id);
    if (hasAction) return res.status(400).json({ error: 'Cheque has actions logged — cannot delete. Cancel it instead.' });
    await pg.run('DELETE FROM cheques WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// STAGE 2 + STAGE 3 — log an action against a cheque. The same endpoint
// serves both because the validation rules are the same: pick from
// allowed actions, attach remarks, and (if action=hold) supply next_date.
router.post('/:id/action', requirePermission('cheques', 'edit'), async (req, res) => {
  try {
    const cheque = await pg.get('SELECT * FROM cheques WHERE id=?', req.params.id);
    if (!cheque) return res.status(404).json({ error: 'Cheque not found' });
    if (['clear', 'bounce', 'stopped', 'cancel'].includes(cheque.current_status)) {
      return res.status(400).json({ error: `Cheque is already in terminal state "${cheque.current_status}" — no more actions allowed.` });
    }
    const b = req.body || {};
    const action = String(b.action || '').toLowerCase();
    if (!ALLOWED_ACTIONS.includes(action)) {
      return res.status(400).json({ error: `Invalid action. Must be one of: ${ALLOWED_ACTIONS.join(', ')}` });
    }
    if (!b.remarks || !String(b.remarks).trim()) {
      return res.status(400).json({ error: 'Remarks are required for every action' });
    }
    let nextDate = null;
    if (action === 'hold') {
      if (!b.next_date) return res.status(400).json({ error: 'Hold action requires a Next Date' });
      nextDate = b.next_date;
    }
    // Map action → new current_status. hold keeps the row in "active"
    // life-cycle, the others move it to terminal except re_issue (which
    // re-opens a held cheque back to pending — rare).
    const newStatus = action === 'hold' ? 'hold'
      : action === 're_issue' ? 'pending'
      : action; // clear / bounce / stopped / cancel

    await pg.tx(async (t) => {
      await t.run(`
        INSERT INTO cheque_actions (cheque_id, action, remarks, next_date, action_by)
        VALUES (?, ?, ?, ?, ?)
      `, req.params.id, action, String(b.remarks).trim(), nextDate, req.user.id);
      await t.run(`
        UPDATE cheques
           SET current_status = ?,
               hold_until = CASE WHEN ? = 'hold' THEN ? ELSE NULL END,
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `, newStatus, action, nextDate, req.params.id);
    });
    res.status(201).json({ message: 'Action logged', new_status: newStatus });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SUMMARY for dashboard cards — count of each status + amount totals.
router.get('/stats/summary', requirePermission('cheques', 'view'), async (req, res) => {
  try {
    const rows = await pg.all(`
      SELECT current_status,
             COUNT(*) AS count,
             COALESCE(SUM(amount), 0) AS total_amount
        FROM cheques
       GROUP BY current_status
    `);
    // Action-due = the only filter the per-status by_status row can't
    // satisfy on its own (it's a date-based slice across pending + hold
    // statuses).  Mam (2026-05-21) wants the "Total Value" tile to
    // change when the Action Due tab is selected, so we surface the
    // amount sum here too.
    const today = localTodayStr();
    const due = await pg.get(`
      SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS total_amount
        FROM cheques
       WHERE (current_status = 'pending' AND LEFT(cheque_date,10) <= ?)
          OR (current_status = 'hold' AND LEFT(hold_until,10) <= ?)
    `, today, today);
    res.json({
      by_status: rows,
      action_due_count: due.c,
      action_due_total_amount: due.total_amount,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
