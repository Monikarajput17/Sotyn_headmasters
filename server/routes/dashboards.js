// In-app role dashboards — TOC v3 P1 #2.
//
// Same JSON shape as /audit/kpi but authenticated via the user's
// normal JWT session (no bearer token needed) and gated to admin.
// This is what the React dashboard pages call.
//
// Going forward each role-specific dashboard (CMD / COO / Sales /
// Finance) reads from this single endpoint and renders only the
// slices that role is supposed to see — RBAC filtering happens in
// the frontend layout, not in the data feed, so the four pages
// stay in sync with the single source of truth.

const express = require('express');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { getDb } = require('../db/schema');
const { computeKpiPayload } = require('./auditReport');
const { computeCmdDetail } = require('../utils/cmdDashboard');

const router = express.Router();
router.use(authMiddleware);

// GET /api/dashboards/pending-approvals — one consolidated inbox of every
// place in the ERP awaiting an approval, so the CMD/MD acts from one screen
// instead of hunting tab-by-tab (mam 2026-06-23). Counts are ERP-wide
// (admin sees all); delegations are scoped to the signed-in approver.
router.get('/pending-approvals', (req, res) => {
  const db = getDb();
  const uid = req.user.id;
  const safe = (sql, ...a) => { try { return db.prepare(sql).get(...a)?.c || 0; } catch (_) { return 0; } };
  const items = [
    { key: 'indents', label: 'Indent Approval', icon: '📋',
      count: safe("SELECT COUNT(*) c FROM indents WHERE status IN ('submitted','l1_approved','crm_approved')"),
      link: '/procurement?tab=indents' },
    { key: 'vendor_po', label: 'Vendor PO Approval', icon: '🧾',
      count: safe("SELECT COUNT(*) c FROM vendor_pos WHERE po_approval IN ('pending_l1','pending_l2')"),
      link: '/procurement?tab=vendorpo' },
    { key: 'payment', label: 'Payment Approval', icon: '💸',
      // Director's inbox shows ONLY what is pending at L3 (MD) — current_step=3
      // (mam 2026-06-26). The full Payment Required module still shows every
      // stage; this card is just the MD's own queue.
      count: safe("SELECT COUNT(*) c FROM payment_requests WHERE current_step=3 AND status NOT IN ('final_approved','rejected')"),
      link: '/payment-required' },
    { key: 'dpr', label: 'DPR Approval', icon: '📝',
      count: safe("SELECT COUNT(*) c FROM dpr WHERE approval_status='pending'"),
      link: '/dpr' },
    { key: 'delegation', label: 'Delegation Sign-off', icon: '✅',
      count: safe("SELECT COUNT(*) c FROM delegations WHERE assigned_by=? AND status='submitted'", uid),
      link: '/delegations' },
  ];
  res.json({ items, total: items.reduce((s, x) => s + x.count, 0) });
});

// GET /api/dashboards/pending-approvals/:key — the actual pending ITEMS for one
// module, so the My-Approvals tab can list + approve them inline (mam
// 2026-06-23). Approval itself reuses each module's own endpoint.
router.get('/pending-approvals/:key', (req, res) => {
  const db = getDb();
  const uid = req.user.id;
  const all = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (_) { return []; } };
  let items = [];
  switch (req.params.key) {
    case 'indents':
      items = all(`SELECT id, indent_number AS title, COALESCE(NULLIF(site_name,''),'—') AS subtitle, status AS meta
                     FROM indents WHERE status IN ('submitted','l1_approved','crm_approved')
                     ORDER BY created_at DESC LIMIT 200`)
        .map(r => ({ ...r, key: 'indents', link: `/procurement?tab=indents&approve=${r.id}` }));
      break;
    case 'vendor_po':
      // Carry a `pdf` link (the Vendor PO print) so the inbox can show the PO
      // before sign-off, and point Open at the pending-approval sub-tab so the
      // actual PO approval screen opens (mam 2026-06-26).
      items = all(`SELECT vp.id, vp.po_number AS title, COALESCE(v.name,'—') AS subtitle, vp.po_approval AS meta, vp.total_amount AS amount
                     FROM vendor_pos vp LEFT JOIN vendors v ON v.id=vp.vendor_id
                     WHERE vp.po_approval IN ('pending_l1','pending_l2') ORDER BY vp.created_at DESC LIMIT 200`)
        .map(r => ({ ...r, key: 'vendor_po', link: '/procurement?tab=vendorpo&subtab=pending', pdf: `/vendor-po/${r.id}/print` }));
      break;
    case 'payment':
      // Director's queue = ONLY items pending at L3 (current_step=3), each with
      // its proof attachment so it can be ticked + bulk-approved here (mam
      // 2026-06-26). Amount shows the latest approver-agreed figure.
      items = all(`SELECT id, COALESCE(NULLIF(vendor_name,''), employee_name, '—') AS title,
                          COALESCE(NULLIF(purpose,''), category, '') AS subtitle,
                          'L3 · MD' AS meta, COALESCE(approved_amount, amount) AS amount,
                          NULLIF(attachment_link,'') AS proof, request_no
                     FROM payment_requests
                     WHERE current_step=3 AND status NOT IN ('final_approved','rejected')
                     ORDER BY created_at DESC LIMIT 200`)
        .map(r => ({ ...r, key: 'payment', link: `/payment-required?view=${r.id}` }));
      break;
    case 'dpr':
      items = all(`SELECT d.id, COALESCE(s.name,'Site #'||d.site_id) AS title, d.report_date AS subtitle, 'pending' AS meta
                     FROM dpr d LEFT JOIN sites s ON s.id=d.site_id
                     WHERE d.approval_status='pending' ORDER BY d.report_date DESC LIMIT 200`)
        .map(r => ({ ...r, key: 'dpr', link: `/dpr?open=${r.id}` }));
      break;
    case 'delegation':
      items = all(`SELECT d.id, COALESCE(d.title,'Task') AS title, COALESCE(u.name,'') AS subtitle, 'submitted' AS meta
                     FROM delegations d LEFT JOIN users u ON u.id=d.assigned_to
                     WHERE d.assigned_by=? AND d.status='submitted' ORDER BY d.created_at DESC LIMIT 200`, uid)
        .map(r => ({ ...r, key: 'delegation', link: `/delegations?open=${r.id}` }));
      break;
  }
  res.json({ key: req.params.key, items });
});

// POST /api/dashboards/approve/:key/:id — one-click approve from the inbox.
// Admin only (the War Room is admin-gated). Indents & POs are fully approved
// (all levels) in one click since the CMD is the final authority; DPR &
// delegations use their own single-step approve via the module endpoints (the
// frontend calls those directly). Payment stays open-only (multi-step finance).
router.post('/approve/:key/:id', adminOnly, (req, res) => {
  const db = getDb();
  const uid = req.user.id;
  const id = +req.params.id;
  try {
    if (req.params.key === 'indents') {
      db.prepare(`UPDATE indents SET
          l1_status='approved', l1_by=COALESCE(l1_by,?), l1_at=COALESCE(l1_at,CURRENT_TIMESTAMP),
          l2_status='approved', l2_by=COALESCE(l2_by,?), l2_at=COALESCE(l2_at,CURRENT_TIMESTAMP),
          crm_status=CASE WHEN approval_policy='crm_two_level' THEN 'approved' ELSE crm_status END,
          status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP,
          rejected_by=NULL, rejected_at=NULL, rejection_reason=NULL
        WHERE id=?`).run(uid, uid, uid, id);
    } else if (req.params.key === 'vendor_po') {
      db.prepare(`UPDATE vendor_pos SET po_approval='approved',
          po_l1_by=COALESCE(po_l1_by,?), po_l1_at=COALESCE(po_l1_at,CURRENT_TIMESTAMP),
          po_l2_by=?, po_l2_at=CURRENT_TIMESTAMP WHERE id=?`).run(uid, uid, id);
    } else {
      return res.status(400).json({ error: 'Approve this item from its module.' });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/dashboards/kpi?days=N — same payload as /audit/kpi.
// Admin-gated until the RBAC rollout (TOC v3 P1 #1) defines the
// five canonical roles; at that point this loosens to allow any
// authenticated user, with field-level masking by role.
router.get('/kpi', adminOnly, (req, res) => {
  try {
    res.json(computeKpiPayload(getDb(), req.query.days));
  } catch (e) {
    console.error('[dashboards/kpi] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/dashboards/cmd-detail?days=N — extended payload for both
// CMD dashboard pages (Stage 1 Operating Console, Stage 2 TOC View).
// Single fetch feeds every section so the page loads in one round-trip.
router.get('/cmd-detail', adminOnly, (req, res) => {
  try {
    res.json(computeCmdDetail(getDb(), req.query.days));
  } catch (e) {
    console.error('[dashboards/cmd-detail] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
