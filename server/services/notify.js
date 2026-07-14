// services/notify.js
//
// Twilio-backed notification helpers.  Right now we only send a
// "complaint registered" confirmation (WhatsApp + SMS) — when more
// notification types are added (resolved, escalated, etc.), add them
// alongside sendComplaintRegistered using the same shape.
//
// Hard rules baked into this module:
//   1. NEVER throw.  Every public function returns a result object
//      describing what happened.  Callers don't need try/catch.
//   2. NEVER block.  If TWILIO_ACCOUNT_SID is missing or the twilio
//      package is not installed, we log a warning once and short-
//      circuit with { skipped: true } so the calling route still
//      finishes.  This keeps local dev (no Twilio credentials) and
//      degraded prod (Twilio down) from breaking complaint
//      registration.
//   3. Indian mobile numbers default to +91.  The complaint form
//      collects 10-digit numbers; we normalise to E.164 here.

const ENV = process.env;

// Lazy-loaded Twilio client.  Lazy because (a) the package may not be
// installed in some envs (we don't want to crash on require) and (b)
// constructing the client only after env vars exist gives a cleaner
// error path.  Reused across calls.
let _client = null;
let _clientWarned = false;
function getClient() {
  if (_client) return _client;
  if (!ENV.TWILIO_ACCOUNT_SID || !ENV.TWILIO_AUTH_TOKEN) {
    if (!_clientWarned) {
      console.warn('[notify] Twilio credentials missing — TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN. Messages will be skipped.');
      _clientWarned = true;
    }
    return null;
  }
  try {
    // require inside a try so a missing twilio package becomes a
    // soft-skip rather than a hard crash at app boot.
    // eslint-disable-next-line global-require
    const twilio = require('twilio');
    _client = twilio(ENV.TWILIO_ACCOUNT_SID, ENV.TWILIO_AUTH_TOKEN);
    return _client;
  } catch (e) {
    if (!_clientWarned) {
      console.warn('[notify] twilio package not installed — run `npm i twilio` in the server folder. Messages will be skipped. (', e.message, ')');
      _clientWarned = true;
    }
    return null;
  }
}

// Normalise an Indian mobile number into E.164.  Rules:
//   - strip everything except digits and a leading '+'
//   - already starts with '+'  →  leave as-is
//   - 10 digits                →  prepend '+91' (India)
//   - 12 digits starting '91'  →  prepend '+'
//   - 11 digits starting '0'   →  drop the 0, prepend '+91' (legacy STD)
//   - anything else            →  return null (caller should skip)
function toE164(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  // Keep a leading + so already-international numbers are preserved
  const hasPlus = s.startsWith('+');
  s = s.replace(/[^\d]/g, '');
  if (!s) return null;
  if (hasPlus) return '+' + s;
  if (s.length === 10) return '+91' + s;
  if (s.length === 12 && s.startsWith('91')) return '+' + s;
  if (s.length === 11 && s.startsWith('0')) return '+91' + s.slice(1);
  return null;
}

// Build the customer-facing text.  Kept verbatim per mam's spec so
// the wording stays consistent across WhatsApp and SMS.
function buildComplaintRegisteredText({ complaintNo, clientName }) {
  const name = String(clientName || 'Customer').trim();
  return `Dear ${name}, your complaint ${complaintNo} has been registered with Secured Engineers. Our team will assign an engineer shortly. - Secured Engineers`;
}

// Single Twilio "create message" call wrapped in a promise that
// resolves to { ok, sid?, error? } and NEVER rejects.  Channel is
// 'whatsapp' or 'sms' (drives the From header + the to: prefix).
async function sendOne(client, channel, fromEnvKey, to, body) {
  const from = ENV[fromEnvKey];
  if (!from) {
    return { ok: false, channel, skipped: true, reason: `${fromEnvKey} not configured` };
  }
  const fromAddr = channel === 'whatsapp' ? `whatsapp:${from}` : from;
  const toAddr   = channel === 'whatsapp' ? `whatsapp:${to}`  : to;
  try {
    const msg = await client.messages.create({ from: fromAddr, to: toAddr, body });
    return { ok: true, channel, sid: msg.sid };
  } catch (e) {
    // Twilio errors carry { code, message, moreInfo }.  Log enough
    // to debug without dumping the whole stack to prod logs.
    console.error(`[notify] ${channel} send failed to ${to}:`, e.code || '', e.message || e);
    return { ok: false, channel, error: e.message || String(e), code: e.code || null };
  }
}

// Public API ----------------------------------------------------------------

// Fire both WhatsApp and SMS in parallel.  Caller doesn't need to await
// this if they don't care about the result — but awaiting is cheap
// (the two sends run concurrently).  Returns an object summarising
// each channel.  Always resolves, never rejects.
async function sendComplaintRegistered({ complaintNo, clientName, mobile }) {
  const e164 = toE164(mobile);
  if (!e164) {
    console.warn('[notify] complaint', complaintNo, '- skipping send: invalid mobile', mobile);
    return { ok: false, skipped: true, reason: 'invalid_mobile', mobile };
  }
  const client = getClient();
  if (!client) {
    return { ok: false, skipped: true, reason: 'twilio_unavailable' };
  }
  const body = buildComplaintRegisteredText({ complaintNo, clientName });
  const [whatsapp, sms] = await Promise.all([
    sendOne(client, 'whatsapp', 'TWILIO_WHATSAPP_FROM', e164, body),
    sendOne(client, 'sms',      'TWILIO_SMS_FROM',      e164, body),
  ]);
  return { ok: whatsapp.ok || sms.ok, to: e164, whatsapp, sms };
}

// Generic one-off notification (WhatsApp + SMS) to a single mobile. Used by
// procurement receiving-mismatch alerts (S16) and other ad-hoc notices. Same
// guarantees as above: never throws, skips cleanly if Twilio isn't configured.
async function sendText({ mobile, body }) {
  const e164 = toE164(mobile);
  if (!e164) return { ok: false, skipped: true, reason: 'invalid_mobile', mobile };
  const client = getClient();
  if (!client) return { ok: false, skipped: true, reason: 'twilio_unavailable' };
  const [whatsapp, sms] = await Promise.all([
    sendOne(client, 'whatsapp', 'TWILIO_WHATSAPP_FROM', e164, body),
    sendOne(client, 'sms', 'TWILIO_SMS_FROM', e164, body),
  ]);
  return { ok: whatsapp.ok || sms.ok, to: e164, whatsapp, sms };
}

module.exports = {
  sendComplaintRegistered,
  sendText,
  // exported for unit testing / reuse
  toE164,
  buildComplaintRegisteredText,
};
