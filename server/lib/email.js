// Email helper — SMTP transport configured via app_settings so mam can
// paste her Gmail / SendGrid / Mailgun credentials inside the ERP
// (Admin → Email Settings) without touching the .env file. If SMTP is
// not configured, sendEmail() returns { skipped: true } so callers can
// gracefully no-op (no thrown errors that block their own work).
//
// Settings keys (all stored in app_settings):
//   email_smtp_host       (e.g. smtp.gmail.com)
//   email_smtp_port       (e.g. 587)
//   email_smtp_secure     ('1' for 465/TLS, blank for STARTTLS)
//   email_smtp_user       (full email address)
//   email_smtp_pass       (app password — never logged)
//   email_from            (display from address)
//   email_director_to     (default recipient for alerts;
//                          falls back to director@securedengineers.com)

const { getDb } = require('../db/schema');

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return row?.value ?? null;
}

function getEmailConfig() {
  return {
    host: getSetting('email_smtp_host'),
    port: +getSetting('email_smtp_port') || 587,
    secure: getSetting('email_smtp_secure') === '1',
    user: getSetting('email_smtp_user'),
    pass: getSetting('email_smtp_pass'),
    from: getSetting('email_from') || getSetting('email_smtp_user'),
    director: getSetting('email_director_to') || 'director@securedengineers.com',
  };
}

function isConfigured() {
  const c = getEmailConfig();
  return !!(c.host && c.user && c.pass);
}

async function sendEmail({ to, subject, html, text, from }) {
  const c = getEmailConfig();
  if (!c.host || !c.user || !c.pass) {
    return { skipped: true, reason: 'SMTP not configured' };
  }
  // Lazy-require so the server still boots if nodemailer is missing in dev.
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch (e) { return { skipped: true, reason: 'nodemailer not installed' }; }

  const transporter = nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.secure,
    auth: { user: c.user, pass: c.pass },
  });
  // `from` override (per-rule dynamic sender, mam 2026-06-03) falls back to
  // the global From, then to the SMTP user. Note: many providers (Gmail)
  // ignore a From that isn't the authenticated account / a verified alias.
  const info = await transporter.sendMail({
    from: from || c.from, to: to || c.director, subject, html, text,
  });
  return { sent: true, messageId: info?.messageId };
}

module.exports = { sendEmail, isConfigured, getEmailConfig };
