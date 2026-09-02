// deno-lint-ignore-file no-explicit-any
// Web Push notification helper — used by every route that needs to
// notify a user (delegations / tickets / payments / announcements).
// Port of server/lib/push.js.
//
// VAPID keys are auto-generated on first use and persisted in
// app_settings so isolate restarts don't invalidate every device's
// subscription. web-push is loaded lazily via Deno npm compat inside
// try/catch — if it cannot be loaded, pushes are skipped (never thrown).
import pg from "../pg.ts";

let webpushMod: any = null;
let webpushTried = false;
async function loadWebPush(): Promise<any> {
  if (webpushMod || webpushTried) return webpushMod;
  webpushTried = true;
  try { webpushMod = (await import("npm:web-push@3.6.7")).default; }
  catch (e) { console.warn("[push] web-push unavailable:", (e as Error).message); webpushMod = null; }
  return webpushMod;
}

let initialised = false;
let initPromise: Promise<boolean> | null = null;   // dedupe concurrent first-boot initialisations

export async function ensureVapid(): Promise<boolean> {
  if (initialised) return true;
  if (!initPromise) {
    initPromise = (async () => {
      const webpush = await loadWebPush();
      if (!webpush) return false;
      let pub = (await pg.get(`SELECT value FROM app_settings WHERE key='vapid_public_key'`))?.value;
      let priv = (await pg.get(`SELECT value FROM app_settings WHERE key='vapid_private_key'`))?.value;
      if (!pub || !priv) {
        const keys = webpush.generateVAPIDKeys();
        pub = keys.publicKey;
        priv = keys.privateKey;
        await pg.run(`INSERT INTO app_settings (key, value) VALUES ('vapid_public_key', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, pub);
        await pg.run(`INSERT INTO app_settings (key, value) VALUES ('vapid_private_key', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, priv);
        console.log("[push] generated new VAPID keys");
      }
      const subject = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@securedengineers.com";
      webpush.setVapidDetails(subject, pub, priv);
      initialised = true;
      return true;
    })();
    initPromise.catch(() => { initPromise = null; });   // allow retry after a failure
  }
  return initPromise;
}

export async function getPublicKey(): Promise<string | null> {
  await ensureVapid();
  return (await pg.get(`SELECT value FROM app_settings WHERE key='vapid_public_key'`))?.value ?? null;
}

export interface PushPayload { title: string; body?: string; url?: string; tag?: string; [k: string]: any }
export interface PushResult { sent: number; total?: number; reason?: string }

// Send a single push to one subscription
async function sendOne(sub: any, payload: PushPayload): Promise<{ ok: boolean; reason?: string }> {
  try {
    const webpush = await loadWebPush();
    if (!webpush) return { ok: false, reason: "web-push unavailable" };
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
    );
    return { ok: true };
  } catch (err: any) {
    // 404 / 410 = subscription expired — deactivate it
    if (err.statusCode === 404 || err.statusCode === 410) {
      try {
        await pg.run(`UPDATE push_subscriptions SET active=0 WHERE endpoint=?`, sub.endpoint);
      } catch { /* ignore */ }
      return { ok: false, reason: "expired" };
    }
    return { ok: false, reason: err.message };
  }
}

// Send to one user (all their active devices)
export async function pushToUser(userId: number | string | null | undefined, payload: PushPayload): Promise<PushResult> {
  if (!userId) return { sent: 0 };
  if (!(await ensureVapid())) return { sent: 0, total: 0, reason: "web-push unavailable" };
  const subs = await pg.all(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=? AND active=1`, userId);
  let sent = 0;
  for (const s of subs) {
    const r = await sendOne(s, payload);
    if (r.ok) sent += 1;
  }
  return { sent, total: subs.length };
}

// Send to many users at once
export async function pushToUsers(userIds: Array<number | string>, payload: PushPayload): Promise<PushResult> {
  let sent = 0, total = 0;
  const seen = new Set<number | string>();
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
export async function pushToAll(payload: PushPayload): Promise<PushResult> {
  if (!(await ensureVapid())) return { sent: 0, total: 0, reason: "web-push unavailable" };
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
// can't break a user's submit. (setImmediate equivalent: hands the
// promise to EdgeRuntime.waitUntil when available so the isolate keeps
// it alive after the response is sent.)
function defer(run: () => Promise<unknown>): void {
  const er = (globalThis as any).EdgeRuntime;
  if (er && typeof er.waitUntil === "function") er.waitUntil(run());
  else setTimeout(run, 0);
}

export function notify(userId: number | string | null | undefined, payload: PushPayload): void {
  defer(() => pushToUser(userId, payload).catch((err) => console.warn("[push] notify failed:", err.message)));
}

export function notifyMany(userIds: Array<number | string>, payload: PushPayload): void {
  defer(() => pushToUsers(userIds, payload).catch((err) => console.warn("[push] notifyMany failed:", err.message)));
}

export function notifyAll(payload: PushPayload): void {
  defer(() => pushToAll(payload).catch((err) => console.warn("[push] notifyAll failed:", err.message)));
}

// Alias requested by the Edge port plan (same semantics as notify()).
export const notifyUser = notify;
