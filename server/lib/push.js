// Web Push notification helper — used by every route that needs to
// notify a user (delegations / tickets / payments / announcements).
//
// VAPID keys are auto-generated on first boot and persisted in
// app_settings so PM2 restarts don't invalidate every device's
// subscription.

const webpush = require('web-push');
const pg = require('../db/pg');

let initialised = false;
let initPromise = null;   // dedupe concurrent first-boot initialisations

async function ensureVapid() {
  if (initialised) return true;
  if (!initPromise) {
    initPromise = (async () => {
      let pub = (await pg.get(`SELECT value FROM app_settings WHERE key='vapid_public_key'`))?.value;
      let priv = (await pg.get(`SELECT value FROM app_settings WHERE key='vapid_private_key'`))?.value;
      if (!pub || !priv) {
        const keys = webpush.generateVAPIDKeys();
        pub = keys.publicKey;
        priv = keys.privateKey;
        await pg.run(`INSERT INTO app_settings (key, value) VALUES ('vapid_public_key', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, pub);
        await pg.run(`INSERT INTO app_settings (key, value) VALUES ('vapid_private_key', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, priv);
        console.log('[push] generated new VAPID keys');
      }
      const subject = process.env.VAPID_SUBJECT || 'mailto:admin@securedengineers.com';
      webpush.setVapidDetails(subject, pub, priv);
      initialised = true;
      return true;
    })();
    initPromise.catch(() => { initPromise = null; });   // allow retry after a failure
  }
  return initPromise;
}

async function getPublicKey() {
  await ensureVapid();
  return (await pg.get(`SELECT value FROM app_settings WHERE key='vapid_public_key'`))?.value;
}

// Send a single push to one subscription
async function sendOne(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    return { ok: true };
  } catch (err) {
    // 404 / 410 = subscription expired — deactivate it
    if (err.statusCode === 404 || err.statusCode === 410) {
      try {
        await pg.run(`UPDATE push_subscriptions SET active=0 WHERE endpoint=?`, sub.endpoint);
      } catch {}
      return { ok: false, reason: 'expired' };
    }
    return { ok: false, reason: err.message };
  }
}

// Send to one user (all their active devices)
async function pushToUser(userId, payload) {
  if (!userId) return { sent: 0 };
  await ensureVapid();
  const subs = await pg.all(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=? AND active=1`, userId);
  let sent = 0;
  for (const s of subs) {
    const r = await sendOne(s, payload);
    if (r.ok) sent += 1;
  }
  return { sent, total: subs.length };
}

// Send to many users at once
async function pushToUsers(userIds, payload) {
  let sent = 0, total = 0;
  const seen = new Set();
  for (const id of userIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const r = await pushToUser(id, payload);
    sent += r.sent || 0;
    total += r.total || 0;
  }
  return { sent, total };
}

// Send to every active user (announcements)
async function pushToAll(payload) {
  await ensureVapid();
  const subs = await pg.all(`
    SELECT ps.endpoint, ps.p256dh, ps.auth
    FROM push_subscriptions ps
    JOIN users u ON u.id = ps.user_id
    WHERE ps.active=1 AND COALESCE(u.active, 1)=1
  `);
  let sent = 0;
  for (const s of subs) {
    const r = await sendOne(s, payload);
    if (r.ok) sent += 1;
  }
  return { sent, total: subs.length };
}

// Fire-and-forget wrapper — never throws, never blocks the parent
// route. Use this from inside POST/PUT handlers so a push failure
// can't break a user's submit.
function notify(userId, payload) {
  setImmediate(() => {
    pushToUser(userId, payload).catch(err => console.warn('[push] notify failed:', err.message));
  });
}

function notifyMany(userIds, payload) {
  setImmediate(() => {
    pushToUsers(userIds, payload).catch(err => console.warn('[push] notifyMany failed:', err.message));
  });
}

function notifyAll(payload) {
  setImmediate(() => {
    pushToAll(payload).catch(err => console.warn('[push] notifyAll failed:', err.message));
  });
}

module.exports = {
  ensureVapid,
  getPublicKey,
  pushToUser,
  pushToUsers,
  pushToAll,
  notify,
  notifyMany,
  notifyAll,
};
