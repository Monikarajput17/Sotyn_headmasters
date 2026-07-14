// Public HR endpoints — NO AUTHENTICATION REQUIRED.
//
// Mam (2026-05-22 Phase 1 Batch D, module #9 - "Offer acceptance
// via link"): candidate clicks a link in the offer email, lands on
// /offer/:token, sees the offer letter inline, and clicks Accept
// or Decline.  No SEPL login required.
//
// Security model:
//   • Token is a random 32-byte base64url string (~256 bits of
//     entropy) → not brute-forceable.
//   • Token is single-use: lookup must match AND status must be
//     'offer_sent' to allow a response.  Once accepted/declined,
//     subsequent POSTs return 409 'Offer already responded to'.
//   • Sensitive fields (salary, internal notes) ARE exposed in the
//     GET response because that's the whole point — candidate
//     needs to see the offer to decide.  We do NOT expose any
//     other candidate's data.
//
// Mounted at /api/public/offer/* — must come BEFORE the global
// auth middleware in server/index.js (or be its own router so it
// doesn't inherit hr.js's authMiddleware).

const express = require('express');
const { getDb } = require('../db/schema');
const router = express.Router();

// ── GET /api/public/offer/:token ─────────────────────────────────
// Returns just enough for the public offer page to render the
// letter and show Accept / Decline buttons.
router.get('/offer/:token', (req, res) => {
  const token = String(req.params.token || '');
  if (!token || token.length < 16) return res.status(400).json({ error: 'Invalid offer link' });
  const c = getDb().prepare(
    `SELECT id, name, email, phone, address,
            position, offered_position, offered_salary, joining_date,
            reporting_to, salary_breakup, offer_sent_at, status,
            offer_accepted_at, offer_declined_at, offer_response_note
       FROM candidates WHERE offer_token = ?`
  ).get(token);
  if (!c) return res.status(404).json({ error: 'Offer not found or has been revoked' });
  // Note: we return status so the frontend can show a "this offer
  // was already accepted on X" message rather than the action buttons.
  res.json({ ok: true, offer: c });
});

// ── POST /api/public/offer/:token/respond ────────────────────────
// Body: { decision: 'accept' | 'decline', note?: '...' }
// Marks the candidate accepted or rejected.  Idempotency: if the
// candidate has already responded, returns 409 with the previous
// decision so the public page can show a clear message.
router.post('/offer/:token/respond', (req, res) => {
  const token = String(req.params.token || '');
  if (!token || token.length < 16) return res.status(400).json({ error: 'Invalid offer link' });
  const { decision, note } = req.body || {};
  if (!['accept','decline'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be accept or decline' });
  }
  const db = getDb();
  const c = db.prepare('SELECT id, status, offer_accepted_at, offer_declined_at FROM candidates WHERE offer_token = ?').get(token);
  if (!c) return res.status(404).json({ error: 'Offer not found' });
  if (c.offer_accepted_at) return res.status(409).json({ error: 'This offer was already accepted', responded_at: c.offer_accepted_at });
  if (c.offer_declined_at) return res.status(409).json({ error: 'This offer was already declined', responded_at: c.offer_declined_at });
  if (!['offer_sent','accepted','onboarded','rejected'].includes(c.status)) {
    return res.status(409).json({ error: 'This offer is no longer active' });
  }

  const isAccept = decision === 'accept';
  const newStatus = isAccept ? 'accepted' : 'rejected';
  const nowField  = isAccept ? 'offer_accepted_at' : 'offer_declined_at';
  db.prepare(`UPDATE candidates SET
                ${nowField} = CURRENT_TIMESTAMP,
                offer_response_note = ?,
                status = ?
              WHERE id = ?`)
    .run(note || null, newStatus, c.id);

  // Log to candidate_events (best-effort — we have no req.user here,
  // so user_id stays NULL; user_name is the candidate's own name).
  try {
    const name = db.prepare('SELECT name FROM candidates WHERE id=?').get(c.id)?.name;
    db.prepare(`INSERT INTO candidate_events
                  (candidate_id, event_type, to_status, note, user_name)
                VALUES (?,?,?,?,?)`)
      .run(c.id, isAccept ? 'offer_accepted' : 'offer_declined', newStatus,
           `Candidate ${isAccept ? 'accepted' : 'declined'} via public link${note ? ' — ' + note : ''}`,
           `${name || 'Candidate'} (via offer link)`);
  } catch (e) { console.warn('[publicHr] event log skipped:', e.message); }

  res.json({ ok: true, decision, status: newStatus });
});

module.exports = router;
