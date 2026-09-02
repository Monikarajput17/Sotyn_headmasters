// Post-migration smoke test: logs in, then GETs every parameter-less GET
// route mounted in server/index.js and reports anything that 5xx's.
// A 4xx (missing query param, permission, 404) is fine — we're hunting for
// database/dialect errors, which surface as 500s.
//
// Usage: node scripts/smoke-test-pg.js [baseUrl] [username] [password]
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:5055';
const USER = process.argv[3] || 'admin';
const PASS = process.argv[4] || 'admin123';

const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
const mounts = [];
for (const m of indexSrc.matchAll(/app\.use\('(\/api\/[^']+)',\s*require\('\.\/routes\/([^']+)'\)/g)) {
  mounts.push({ prefix: m[1], file: m[2] });
}

function getRoutes(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', file + '.js'), 'utf8');
  const out = new Set();
  for (const m of src.matchAll(/router\.get\(\s*['"`]([^'"`]*)['"`]/g)) {
    const p = m[1];
    if (p.includes(':') || p.includes('*')) continue;
    out.add(p === '/' ? '' : p);
  }
  return [...out];
}

(async () => {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!login.ok) { console.error('LOGIN FAILED', login.status, await login.text()); process.exit(1); }
  const { token } = await login.json();
  const H = { Authorization: `Bearer ${token}` };

  const results = { ok: 0, client4xx: 0, server5xx: [], total: 0 };
  for (const { prefix, file } of mounts) {
    let routes;
    try { routes = getRoutes(file); } catch { continue; }
    for (const r of routes) {
      const url = `${BASE}${prefix}${r}`;
      results.total++;
      let status, body = '';
      try {
        const res = await fetch(url, { headers: H });
        status = res.status;
        if (status >= 500) body = (await res.text()).slice(0, 160);
      } catch (e) { status = 'ERR'; body = e.message; }
      if (status >= 200 && status < 300) results.ok++;
      else if (status >= 400 && status < 500) results.client4xx++;
      else results.server5xx.push({ url, status, body });
    }
  }
  console.log(`GET routes tested: ${results.total} | 2xx: ${results.ok} | 4xx (expected/param): ${results.client4xx} | 5xx: ${results.server5xx.length}`);
  for (const f of results.server5xx) console.log(`  ${f.status}  ${f.url}\n        ${f.body}`);
  process.exit(results.server5xx.length ? 1 : 0);
})();
