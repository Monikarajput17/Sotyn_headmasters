// HR Automations cron — mam (2026-05-22 Phase 1 Batch E, module #15).
//
// Every 30 minutes, scans for HR events that need a nudge and:
//   1) Inserts an in-app notification row for the right user(s)
//   2) Sends them an email via server/lib/email.js (if SMTP is set up)
//
// Triggers:
//   • Interview Reminder      — interview_date in the next 24h
//   • Offer Expiry Reminder   — offer_sent_at older than 7 days with
//                                no offer_accepted_at / offer_declined_at
//   • Approval Pending Alert  — hiring_request status='pending' for >24h
//
// Idempotency: each notification carries a dedupe_key so re-runs of
// the cron don't spam the same person about the same event over and
// over.  Example dedupe keys:
//   interview_reminder:<candidate_id>:<YYYY-MM-DD-interview-date>
//   offer_expiry:<candidate_id>
//   approval_pending:<request_id>
//
// Skip cron via ERP_DISABLE_HR_CRON=1.

const { getDb } = require('../db/schema');
let sendEmailFn = null;
try { sendEmailFn = require('../lib/email').sendEmail; } catch (_) {}

const INTERVAL_MS = 30 * 60 * 1000;     // 30 min
const OFFER_EXPIRY_DAYS = 7;
const PENDING_APPROVAL_HRS = 24;

function notify(db, { user_id, type, title, body, link_url, dedupe_key, sendEmailTo }) {
  if (!user_id) return false;
  // Skip if we've already created this notification (dedupe_key match).
  if (dedupe_key) {
    const existing = db.prepare('SELECT id FROM notifications WHERE user_id = ? AND dedupe_key = ?').get(user_id, dedupe_key);
    if (existing) return false;
  }
  const channels = ['in_app'];
  db.prepare(`INSERT INTO notifications
                (user_id, type, title, body, link_url, channel_sent, dedupe_key)
              VALUES (?,?,?,?,?,?,?)`)
    .run(user_id, type, title, body || null, link_url || null,
         channels.join(','), dedupe_key || null);
  // Best-effort email — never let SMTP failure block the in-app path.
  if (sendEmailFn && sendEmailTo) {
    sendEmailFn({
      to: sendEmailTo,
      subject: `[SEPL ERP] ${title}`,
      text: `${title}\n\n${body || ''}\n\n${link_url ? 'Open: ' + link_url : ''}`,
      html: `<h3>${escapeHtml(title)}</h3><p>${escapeHtml(body || '')}</p>${link_url ? `<p><a href="${escapeHtml(link_url)}">Open in ERP</a></p>` : ''}`,
    }).then(r => {
      if (r && r.skipped) return;
      // Patch the row to record the email channel got sent.
      db.prepare('UPDATE notifications SET channel_sent = ? WHERE user_id = ? AND dedupe_key = ?')
        .run('in_app,email', user_id, dedupe_key);
    }).catch(e => console.warn('[hr-cron] email send failed:', e.message));
  }
  return true;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Scanners ────────────────────────────────────────────────────
function scanInterviewReminders(db) {
  // Candidates with interview_date in next 24h, status interview_scheduled.
  // Notify the interviewer (employee.user_id) — they're the one who needs
  // to prep.
  const rows = db.prepare(`
    SELECT c.id, c.name, c.interview_date,
           e.id AS interviewer_emp_id, u.id AS interviewer_user_id, u.email AS interviewer_email
      FROM candidates c
      LEFT JOIN employees e ON e.id = c.interviewer_id
      LEFT JOIN users u     ON u.id = e.user_id
     WHERE c.status = 'interview_scheduled'
       AND c.interview_date IS NOT NULL
       AND datetime(c.interview_date) BETWEEN datetime('now') AND datetime('now','+1 day')
  `).all();
  let made = 0;
  for (const r of rows) {
    if (!r.interviewer_user_id) continue;
    const dateOnly = r.interview_date?.slice(0, 10);
    const dedupe = `interview_reminder:${r.id}:${dateOnly}`;
    const ok = notify(db, {
      user_id: r.interviewer_user_id,
      type: 'interview_reminder',
      title: `Interview tomorrow — ${r.name}`,
      body: `You have an interview with ${r.name} scheduled at ${r.interview_date}.`,
      link_url: '/hr',
      dedupe_key: dedupe,
      sendEmailTo: r.interviewer_email,
    });
    if (ok) made++;
  }
  return made;
}

function scanOfferExpiries(db) {
  // Offers sent >7 days ago, no candidate response yet.  Notify ALL
  // HR users so someone follows up.
  const stale = db.prepare(`
    SELECT id, name, offer_sent_at FROM candidates
     WHERE status = 'offer_sent'
       AND offer_sent_at IS NOT NULL
       AND offer_accepted_at IS NULL
       AND offer_declined_at IS NULL
       AND julianday('now') - julianday(offer_sent_at) >= ?
  `).all(OFFER_EXPIRY_DAYS);
  if (stale.length === 0) return 0;
  const hrUsers = findHrUsers(db);
  let made = 0;
  for (const c of stale) {
    for (const u of hrUsers) {
      const dedupe = `offer_expiry:${c.id}:${Math.floor(Date.now() / (1000 * 60 * 60 * 24))}`;  // re-trigger daily
      if (notify(db, {
        user_id: u.id,
        type: 'offer_expiry',
        title: `Offer pending response — ${c.name}`,
        body: `Offer was sent on ${c.offer_sent_at?.slice(0,10)} and candidate has not responded. Consider following up.`,
        link_url: '/hr',
        dedupe_key: dedupe,
        sendEmailTo: u.email,
      })) made++;
    }
  }
  return made;
}

function scanPendingApprovals(db) {
  // Hiring requests still 'pending' after 24h.  Notify HR users
  // (separation of duties means the original requester can't approve).
  const stale = db.prepare(`
    SELECT id, position_title, department, requested_by, requested_by_name, created_at
      FROM hiring_requests
     WHERE status = 'pending'
       AND julianday('now') - julianday(created_at) >= (? / 24.0)
  `).all(PENDING_APPROVAL_HRS);
  if (stale.length === 0) return 0;
  const hrUsers = findHrUsers(db);
  let made = 0;
  for (const r of stale) {
    for (const u of hrUsers) {
      // Don't notify the requester themselves — they already know.
      if (u.id === r.requested_by) continue;
      const dedupe = `approval_pending:${r.id}:${Math.floor(Date.now() / (1000 * 60 * 60 * 24))}`;
      if (notify(db, {
        user_id: u.id,
        type: 'approval_pending',
        title: `Hiring Request awaiting approval — ${r.position_title}`,
        body: `${r.requested_by_name || 'A manager'} raised a hiring request for ${r.position_title} (${r.department}). It's been pending for >${PENDING_APPROVAL_HRS}h.`,
        link_url: '/hr',
        dedupe_key: dedupe,
        sendEmailTo: u.email,
      })) made++;
    }
  }
  return made;
}

// HR users = admin OR users with department/role containing "hr".
function findHrUsers(db) {
  return db.prepare(`
    SELECT DISTINCT u.id, u.email
      FROM users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN roles r ON r.id = ur.role_id
     WHERE COALESCE(u.active, 1) = 1
       AND u.email IS NOT NULL AND u.email != ''
       AND (
         LOWER(COALESCE(u.role, '')) = 'admin'
         OR LOWER(COALESCE(u.department, '')) LIKE '%hr%'
         OR LOWER(COALESCE(r.name, '')) LIKE '%hr%'
       )
  `).all();
}

function runOnce() {
  if (process.env.ERP_DISABLE_HR_CRON === '1') return;
  try {
    const db = getDb();
    const a = scanInterviewReminders(db);
    const b = scanOfferExpiries(db);
    const c = scanPendingApprovals(db);
    if (a + b + c > 0) {
      console.log(`[hr-cron] notifications created · interview=${a} offer_expiry=${b} approval_pending=${c}`);
    }
  } catch (e) {
    console.warn('[hr-cron] scan failed:', e.message);
  }
}

function schedule() {
  if (process.env.ERP_DISABLE_HR_CRON === '1') {
    console.log('[hr-cron] disabled via ERP_DISABLE_HR_CRON=1');
    return;
  }
  // Run shortly after boot (10s grace) then every 30 min.
  setTimeout(runOnce, 10_000);
  setInterval(runOnce, INTERVAL_MS);
  console.log(`[hr-cron] scheduled every ${INTERVAL_MS / 60000} min`);
}

module.exports = { schedule, runOnce };
