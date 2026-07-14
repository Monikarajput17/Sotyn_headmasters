// Dynamic email-rules engine (mam 2026-06-03).
//
// fireEmailEvent(eventKey, context) loads every ENABLED email_rule for that
// event, checks its optional conditions against the context, resolves the
// recipients (dynamic-from-record / fixed list / by-role), renders the
// subject + body templates ({{var}} substitution), and sends via the shared
// SMTP transport (lib/email.sendEmail).  Fire-and-forget: never throws into
// the caller's request path.
//
// A "rule" row (email_rules table):
//   event_key    e.g. 'indent.approved'
//   enabled      0/1
//   conditions   JSON array  [{ field, op, value }]   (AND-combined; empty = always)
//   recipients   JSON object { people:[...], fixed:'a@b,c@d', roles:['CRM'] }
//   subject_tpl  text with {{vars}}
//   body_tpl     text with {{vars}}  (rendered to simple HTML)

const { getDb } = require('../db/schema');
const { sendEmail } = require('./email');

// {{var}} → context value (missing → '').  Case/space tolerant.
function renderTemplate(tpl, ctx) {
  if (!tpl) return '';
  return String(tpl).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, name) => {
    const v = ctx[name];
    return v === undefined || v === null ? '' : String(v);
  });
}

function evalOne(cond, ctx) {
  const raw = ctx[cond.field];
  const a = raw === undefined || raw === null ? '' : String(raw).toLowerCase().trim();
  const b = String(cond.value ?? '').toLowerCase().trim();
  switch (cond.op) {
    case 'eq': return a === b;
    case 'ne': return a !== b;
    case 'contains': return a.includes(b);
    case 'gt': return parseFloat(String(raw).replace(/[^0-9.\-]/g, '')) > parseFloat(b);
    case 'lt': return parseFloat(String(raw).replace(/[^0-9.\-]/g, '')) < parseFloat(b);
    default: return true;
  }
}

// All conditions must pass (AND). Empty / invalid → always true.
function evalConditions(conditions, ctx) {
  let list = conditions;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
  if (!Array.isArray(list) || list.length === 0) return true;
  return list.every(c => c && c.field ? evalOne(c, ctx) : true);
}

function resolveRecipients(recipients, ctx) {
  let r = recipients;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch { r = {}; } }
  r = r || {};
  const out = new Set();

  // 1. Dynamic-from-record people → context emails (e.g. raiser_email).
  for (const key of (r.people || [])) {
    const email = ctx[key];
    if (email && String(email).includes('@')) out.add(String(email).trim());
  }
  // 2. Fixed list — comma / newline / semicolon separated.
  for (const e of String(r.fixed || '').split(/[,;\n]+/)) {
    const t = e.trim();
    if (t.includes('@')) out.add(t);
  }
  // 3. By role — every active user holding one of the named roles.
  if (Array.isArray(r.roles) && r.roles.length) {
    try {
      const db = getDb();
      const ph = r.roles.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT DISTINCT u.email
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN roles ro ON ro.id = ur.role_id
          WHERE u.active = 1 AND u.email IS NOT NULL AND u.email != ''
            AND ro.name IN (${ph})`
      ).all(...r.roles);
      for (const row of rows) if (row.email) out.add(String(row.email).trim());
    } catch (e) { /* roles best-effort */ }
  }
  return [...out];
}

// Render the body to minimal HTML (preserve line breaks).
function bodyToHtml(text) {
  const esc = String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.5">${esc.replace(/\n/g, '<br>')}</div>`;
}

// Core: run all enabled rules for an event against a context. Returns a
// summary array (used by /test and logging). Never throws.
async function runRulesForEvent(eventKey, ctx, { onlyRuleId = null } = {}) {
  const db = getDb();
  let rules;
  try {
    rules = onlyRuleId
      ? db.prepare('SELECT * FROM email_rules WHERE id = ?').all(onlyRuleId)
      : db.prepare('SELECT * FROM email_rules WHERE event_key = ? AND enabled = 1').all(eventKey);
  } catch (e) { return []; }

  const results = [];
  for (const rule of rules) {
    try {
      if (!onlyRuleId && !evalConditions(rule.conditions, ctx)) {
        results.push({ rule: rule.name, skipped: 'conditions not met' });
        continue;
      }
      const to = resolveRecipients(rule.recipients, ctx);
      if (!to.length) {
        results.push({ rule: rule.name, skipped: 'no recipients resolved' });
        continue;
      }
      const subject = renderTemplate(rule.subject_tpl, ctx) || '(no subject)';
      const html = bodyToHtml(renderTemplate(rule.body_tpl, ctx));
      // Per-rule dynamic From (supports {{vars}}); blank → global default.
      const from = renderTemplate(rule.from_addr, ctx).trim() || undefined;
      const res = await sendEmail({ to: to.join(','), subject, html, from });
      try {
        db.prepare('UPDATE email_rules SET last_fired_at = CURRENT_TIMESTAMP, fire_count = COALESCE(fire_count,0) + 1 WHERE id = ?').run(rule.id);
      } catch {}
      results.push({ rule: rule.name, to, sent: !!res?.sent, skipped: res?.skipped ? res.reason : undefined });
    } catch (e) {
      results.push({ rule: rule.name, error: e.message });
    }
  }
  return results;
}

// Fire-and-forget — call this from route handlers. Wrapped in setImmediate
// so it never delays or breaks the originating request.
function fireEmailEvent(eventKey, ctx) {
  setImmediate(() => {
    runRulesForEvent(eventKey, ctx || {}).catch(err =>
      console.error(`[email-rules] event ${eventKey} failed:`, err?.message));
  });
}

module.exports = {
  fireEmailEvent,
  runRulesForEvent,
  renderTemplate,
  evalConditions,
  resolveRecipients,
};
