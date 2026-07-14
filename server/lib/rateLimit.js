// Tiny in-memory fixed-window rate limiter — NO new deps. This server runs as a
// SINGLE process, so an in-process Map is the correct (and simplest) scope; it
// matches the repo's lean, degrade-gracefully style (cf. the compression try/catch
// in server/index.js). Each rateLimit() call owns a PRIVATE bucket map, so limiters
// never interfere with one another.
//
// Returns Express middleware. On limit it responds 429 + Retry-After and does NOT
// call next(), so the wrapped handler never runs. If the key can't be resolved the
// request is allowed through (fail-open — never block traffic on our own bug).
//
// Scope (2026-07 /site-chat perf pass): applied ONLY as route-level middleware on the
// chat send route (see server/routes/siteChat.js). Deliberately NOT global (no
// app.use) and NOT on /login, so no other ERP module's code path changes.

function rateLimit({ windowMs, max, keyFn, message }) {
  const buckets = new Map();   // key -> { count, resetAt }
  return function rateLimiter(req, res, next) {
    let key;
    try { const k = keyFn(req); key = k == null ? null : String(k); } catch (_) { key = null; }
    if (!key) return next();                         // unidentifiable caller → don't block
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now >= b.resetAt) {
      // Start of a new window for this key. Opportunistically prune expired buckets so
      // the map stays bounded without a background timer — cheap, only when the map has
      // grown large and a fresh key arrives.
      if (buckets.size > 5000) for (const [bk, bv] of buckets) if (now >= bv.resetAt) buckets.delete(bk);
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    if (++b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      return res.status(429).json({ error: message || 'Too many requests — please slow down and try again shortly.' });
    }
    next();
  };
}

module.exports = { rateLimit };
