// Daily 07:30 AM audit snapshot — TOC v3 P0 #5.
//
// Every morning at 07:30 local time we pull the same JSON the
// /audit, /audit/kpi, /audit/data-quality, /audit/analytics endpoints
// return and write it to disk so:
//   1. The CMD's 09:00 daily email can attach yesterday's snapshot
//      without rerunning all the queries.
//   2. The TOC dashboards (CMD / COO / Sales / Finance) can render
//      "as of this morning" KPI values without hitting the DB on
//      every page load.
//   3. We have a permanent record of bank / AR aging / WIP / CCC etc.
//      over time — point-in-time history for trend analysis later.
//
// Files land in data/audit-snapshots/<YYYY-MM-DD>/<endpoint>.json.
// 90-day retention; older folders are pruned on each run.
//
// Skip in dev: ERP_DISABLE_AUDIT_SNAPSHOT=1

const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/schema');

// Re-use the same compute functions as the live HTTP routes.  We avoid
// importing the Express router directly (it has middleware and req/res
// dependencies) and re-derive the same shape here.  When TOC v3 lands
// the router and the snapshot job should share a single library; for
// now duplicate the response shape with a single private call to
// `simulateAuditRequest` that drives the route as if via supertest.

const SNAPSHOT_DIR = path.join(__dirname, '..', '..', 'data', 'audit-snapshots');
const RETENTION_DAYS = 90;

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (_) {} }

function todayIso() { return new Date().toISOString().slice(0, 10); }

function prune() {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) return;
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    for (const name of fs.readdirSync(SNAPSHOT_DIR)) {
      const dir = path.join(SNAPSHOT_DIR, name);
      try {
        const st = fs.statSync(dir);
        if (st.isDirectory() && st.mtimeMs < cutoff) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch (_) {}
    }
  } catch (_) {}
}

// Drive the live endpoints via a minimal in-process express call.
// We instantiate the router once and dispatch fake requests to it
// (no HTTP).  This keeps a single implementation source-of-truth.
async function snapshotOnce() {
  if (process.env.ERP_DISABLE_AUDIT_SNAPSHOT === '1') return;
  const expected = process.env.AUDIT_API_TOKEN;
  if (!expected || expected.length < 8) {
    console.warn('[audit-snapshot] AUDIT_API_TOKEN not configured — skipping');
    return;
  }
  const started = Date.now();
  const day = todayIso();
  const outDir = path.join(SNAPSHOT_DIR, day);
  ensureDir(outDir);

  // Lazy-require so the schema is initialized.
  const router = require('../routes/auditReport');

  const fakeReq = (url, query) => ({
    headers: { authorization: `Bearer ${expected}` },
    query: query || {},
    url, originalUrl: url, method: 'GET', path: url,
  });

  const captureRes = () => {
    const r = {
      statusCode: 200,
      _payload: null,
      _headers: {},
      status(code) { this.statusCode = code; return this; },
      setHeader(k, v) { this._headers[k] = v; return this; },
      json(payload) { this._payload = payload; return this; },
      send(payload) { this._payload = payload; return this; },
    };
    return r;
  };

  const endpoints = [
    { path: '/',              file: 'audit.json',         query: {} },
    { path: '/kpi',           file: 'kpi.json',           query: { days: '30' } },
    { path: '/data-quality',  file: 'data-quality.json',  query: {} },
    { path: '/analytics',     file: 'analytics.json',     query: { days: '30' } },
  ];

  let okCount = 0;
  for (const ep of endpoints) {
    try {
      // Find the matching layer in the router and call its handler.
      const layer = router.stack.find(l => l.route && l.route.path === ep.path);
      if (!layer) { console.warn('[audit-snapshot] no route', ep.path); continue; }
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      const req = fakeReq(ep.path, ep.query);
      const res = captureRes();
      // Run the token-auth middleware first (it's the only router.use middleware).
      const mw = router.stack.find(l => !l.route && typeof l.handle === 'function')?.handle;
      let nextCalled = false;
      const next = () => { nextCalled = true; };
      if (mw) mw(req, res, next);
      if (!nextCalled) {
        console.warn('[audit-snapshot] auth blocked', ep.path, res._payload?.error);
        continue;
      }
      await handler(req, res);
      if (res._payload) {
        fs.writeFileSync(path.join(outDir, ep.file), JSON.stringify(res._payload, null, 2));
        okCount += 1;
      }
    } catch (e) {
      console.error('[audit-snapshot] failed', ep.path, e.message);
    }
  }

  // Write a manifest with the run metadata so the email job can pick up
  // the latest snapshot regardless of clock drift.
  try {
    fs.writeFileSync(path.join(outDir, '_manifest.json'), JSON.stringify({
      generated_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      endpoints_ok: okCount,
      endpoints_total: endpoints.length,
      retention_days: RETENTION_DAYS,
    }, null, 2));
  } catch (_) {}

  prune();
  console.log(`[audit-snapshot] ${okCount}/${endpoints.length} endpoints snapshotted to ${outDir} in ${Date.now() - started}ms`);
}

// Schedule the daily 07:30 run.  Uses setTimeout to drift-correct
// to the next 07:30 local time, then setInterval at 24h.  Matches
// the pattern used by scheduleNightly() in backup-db.js.
function scheduleDailyAuditSnapshot() {
  if (process.env.ERP_DISABLE_AUDIT_SNAPSHOT === '1') {
    console.log('[audit-snapshot] disabled via ERP_DISABLE_AUDIT_SNAPSHOT');
    return;
  }
  const TARGET_HOUR = 7;
  const TARGET_MIN = 30;
  const now = new Date();
  const next = new Date(now);
  next.setHours(TARGET_HOUR, TARGET_MIN, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now;
  console.log(`[audit-snapshot] first run scheduled for ${next.toLocaleString()} (in ${Math.round(msUntil / 60000)} min)`);
  setTimeout(() => {
    snapshotOnce().catch(e => console.error('[audit-snapshot] error:', e.message));
    setInterval(() => {
      snapshotOnce().catch(e => console.error('[audit-snapshot] error:', e.message));
    }, 24 * 60 * 60 * 1000);
  }, msUntil);
}

module.exports = { scheduleDailyAuditSnapshot, snapshotOnce };
