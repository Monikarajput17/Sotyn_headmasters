// ============================================================================
// CHAMPIONS LEAGUE — company-wide gamification
// ----------------------------------------------------------------------------
// Built ON TOP of the existing Scorecard engine (routes/scoring.js).  Every
// employee already has a role-specific template whose KPIs are scored each
// week against THEIR OWN targets (delegations done, DPRs filed on time,
// collections, payments, etc.).  That makes an accountant and a site engineer
// directly comparable: both are expressed as "% of your own plan achieved".
//
// The Champions Score for a week = that weekly scorecard %, clamped to 0..200.
// The scorecard % is "achievement vs plan" (mam 2026-07-03), so hitting exactly
// your plan = 100, beating it climbs above, missing it falls below — no +100
// offset needed any more.  A month/quarter/year score is the AVERAGE of the
// weekly Champions Scores across the weeks the player actually qualified in.
//
// Team score = simple AVERAGE of its members' scores (mam's pick) so small or
// large pods compete fairly.  Guardrail: a week only counts if the player did
// at least `min_activity` units of work that week (no winning on two tasks).
//
// Phase 1 here: scoring engine + leaderboard + teams (with auto-balance) +
// config.  Kudos / manager bonus / persisted award history tables are created
// now but wired in Phase 3.
// ============================================================================
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { computeScorecard } = require('./scoring');

router.use(authMiddleware);

// ---- tables (idempotent, self-creating — same pattern as raci.js) ----------
try {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS gam_team (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      motto TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS gam_team_member (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER REFERENCES gam_team(id) ON DELETE CASCADE,
      user_id INTEGER UNIQUE,             -- a user belongs to at most one pod
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS gam_config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    -- Phase 3 (created now so the schema is stable):
    CREATE TABLE IF NOT EXISTS gam_kudos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user INTEGER, to_user INTEGER,
      points REAL DEFAULT 1, note TEXT,
      period_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS gam_bonus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER, points REAL DEFAULT 0, note TEXT,
      awarded_by INTEGER, period_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS gam_award (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_type TEXT NOT NULL,          -- week | month | quarter | year
      period_key TEXT NOT NULL,           -- e.g. 2026-06-22 / 2026-06 / 2026-Q2 / 2026
      scope TEXT NOT NULL,                -- individual | team
      winner_id INTEGER,                  -- user_id or team_id
      winner_name TEXT,
      score REAL,
      title TEXT,
      locked_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(period_type, period_key, scope)
    );
  `);
} catch (e) { /* ignore — tables may already exist */ }

// ---- config (admin-tunable, no code change needed) -------------------------
const CONFIG_DEFAULTS = {
  min_activity: '1',                  // work units a week needs to count
  league_name: 'Champions League',
};
function getConfig() {
  const out = { ...CONFIG_DEFAULTS };
  try {
    for (const r of getDb().prepare('SELECT key, value FROM gam_config').all()) out[r.key] = r.value;
  } catch (_) {}
  return out;
}

// ---- award titles per cycle ------------------------------------------------
const TITLES = {
  week:    { emoji: '⚡', title: 'Spark of the Week' },
  month:   { emoji: '🌟', title: 'Star Performer' },
  quarter: { emoji: '🏆', title: 'Quarter Champion' },
  year:    { emoji: '👑', title: 'Legend of the Year' },
};
const TEAM_TITLE = { emoji: '🛡️', title: 'Champions Circle' };

// ---- date helpers (IST, mirrors scoring.js week math) ----------------------
function istTodayYMD() { return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); }
function ymd(d) { return d.toISOString().slice(0, 10); }
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return ymd(d);
}
function addDays(dateStr, n) { const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// Resolve the {label,start,end,key} window + the Mondays it spans.
function periodBounds(period, dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (period === 'week') {
    const s = mondayOf(dateStr);
    return { label: `Week of ${s}`, start: s, end: addDays(s, 5), key: s };
  }
  if (period === 'month') {
    const s = ymd(new Date(Date.UTC(y, m, 1)));
    const e = ymd(new Date(Date.UTC(y, m + 1, 0)));
    return { label: `${MONTHS[m]} ${y}`, start: s, end: e, key: `${y}-${String(m + 1).padStart(2, '0')}` };
  }
  if (period === 'quarter') {
    const q = Math.floor(m / 3);
    const s = ymd(new Date(Date.UTC(y, q * 3, 1)));
    const e = ymd(new Date(Date.UTC(y, q * 3 + 3, 0)));
    return { label: `Q${q + 1} ${y}`, start: s, end: e, key: `${y}-Q${q + 1}` };
  }
  // year
  return { label: `${y}`, start: ymd(new Date(Date.UTC(y, 0, 1))), end: ymd(new Date(Date.UTC(y, 11, 31))), key: `${y}` };
}

// Every Monday whose Mon-Sat week overlaps [start,end].
function weekStartsIn(start, end) {
  const out = [];
  let mon = mondayOf(start);
  while (mon <= end) { out.push(mon); mon = addDays(mon, 7); }
  return out;
}

// ---- the scoring core ------------------------------------------------------
// Average the weekly Champions Scores for one user across `weeks`, counting
// only the weeks where they were active enough to qualify.
function userPeriodScore(db, userId, weeks, minActivity, cache) {
  let sum = 0, n = 0, hasTemplate = false, totalActivity = 0;
  for (const wk of weeks) {
    const ck = userId + '|' + wk;
    let sc = cache.get(ck);
    if (sc === undefined) {
      try { sc = computeScorecard(db, userId, wk); } catch (_) { sc = null; }
      cache.set(ck, sc);
    }
    if (!sc || !sc.template || sc.total_weight <= 0) continue;
    hasTemplate = true;
    const act = sc.activity || 0;
    if (act < minActivity) continue;          // week doesn't count
    // Weekly scorecard % is now "achievement vs plan" (100 = hit your plan,
    // above = beat it), so it already IS the Champions Score — no +100 offset.
    // (mam 2026-07-03: the scorecard % switched from variance to achievement;
    // for higher-better KPIs this yields the exact same Champions numbers.)
    const cs = Math.max(0, Math.min(200, (sc.score || 0)));
    sum += cs; n += 1; totalActivity += act;
  }
  if (n === 0) return { qualified: false, hasTemplate, score: null, weeks_counted: 0, activity: totalActivity };
  return { qualified: true, hasTemplate: true, score: Math.round((sum / n) * 10) / 10, weeks_counted: n, activity: totalActivity };
}

// Small TTL cache so re-loading a heavy period (a full year = ~52 weeks ×
// every user) doesn't recompute on every poll.  Keyed by period+date.
const lbCache = new Map();
const LB_TTL_MS = 90 * 1000;

// ---- GET /gamification/leaderboard ----------------------------------------
//   ?period=week|month|quarter|year & ?date=YYYY-MM-DD (defaults to today IST)
router.get('/leaderboard', (req, res) => {
  try {
    const period = ['week', 'month', 'quarter', 'year'].includes(req.query.period) ? req.query.period : 'month';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : istTodayYMD();
    const cacheKey = period + '|' + date;
    const hit = lbCache.get(cacheKey);
    if (hit && (Date.now() - hit.t) < LB_TTL_MS) return res.json(hit.v);

    const db = getDb();
    const cfg = getConfig();
    const minActivity = Math.max(0, parseFloat(cfg.min_activity) || 0);
    const bounds = periodBounds(period, date);
    const weeks = weekStartsIn(bounds.start, bounds.end);

    const users = db.prepare(`
      SELECT id, name, role, department FROM users
      WHERE COALESCE(active, 1) = 1 ORDER BY name`).all();

    // user_id -> {team_id, team_name}
    const teamOf = {};
    for (const r of db.prepare(`
      SELECT tm.user_id, tm.team_id, t.name AS team_name, t.motto
      FROM gam_team_member tm JOIN gam_team t ON t.id = tm.team_id`).all()) {
      teamOf[r.user_id] = r;
    }

    const scCache = new Map();
    const qualified = [], notQualified = [];
    for (const u of users) {
      const r = userPeriodScore(db, u.id, weeks, minActivity, scCache);
      if (!r.hasTemplate) continue;            // no scorecard set up → not a player yet
      const row = {
        user_id: u.id, name: u.name, role: u.role, department: u.department,
        team_id: teamOf[u.id]?.team_id || null, team_name: teamOf[u.id]?.team_name || null,
        score: r.score, weeks_counted: r.weeks_counted, activity: r.activity, qualified: r.qualified,
      };
      (r.qualified ? qualified : notQualified).push(row);
    }
    qualified.sort((a, b) => b.score - a.score);
    qualified.forEach((r, i) => { r.rank = i + 1; });

    // Teams = average of qualified members' scores
    const teams = db.prepare('SELECT t.id, t.name, t.motto, COUNT(tm.user_id) AS member_count FROM gam_team t LEFT JOIN gam_team_member tm ON tm.team_id = t.id GROUP BY t.id ORDER BY t.name').all();
    const rankByUser = {}; qualified.forEach(r => { rankByUser[r.user_id] = { rank: r.rank, score: r.score }; });
    // Full roster per team — so the dashboard can show every member with their
    // team (e.g. "Ankit Raj · Naye Nawab") and rank, even those without a score.
    const membersByTeam = {};
    for (const m of db.prepare('SELECT tm.team_id, tm.user_id, u.name FROM gam_team_member tm JOIN users u ON u.id = tm.user_id WHERE COALESCE(u.active,1)=1').all()) {
      (membersByTeam[m.team_id] = membersByTeam[m.team_id] || []).push({ user_id: m.user_id, name: m.name, rank: rankByUser[m.user_id]?.rank ?? null, score: rankByUser[m.user_id]?.score ?? null });
    }
    const teamRows = teams.map(t => {
      const memScores = qualified.filter(r => r.team_id === t.id).map(r => r.score);
      const avg = memScores.length ? Math.round((memScores.reduce((a, b) => a + b, 0) / memScores.length) * 10) / 10 : null;
      const members = (membersByTeam[t.id] || []).sort((a, b) => (a.rank == null ? 1e9 : a.rank) - (b.rank == null ? 1e9 : b.rank) || String(a.name).localeCompare(String(b.name)));
      return { team_id: t.id, name: t.name, motto: t.motto, member_count: t.member_count, qualified_count: memScores.length, score: avg, members };
    });
    teamRows.sort((a, b) => (b.score == null ? -1 : b.score) - (a.score == null ? -1 : a.score));
    teamRows.forEach((t, i) => { t.rank = t.score == null ? null : i + 1; });

    const titleInfo = TITLES[period] || TITLES.month;
    const out = {
      period, label: bounds.label, start: bounds.start, end: bounds.end, period_key: bounds.key,
      weeks_in_period: weeks.length, min_activity: minActivity,
      league_name: cfg.league_name,
      title: titleInfo, team_title: TEAM_TITLE,
      individuals: qualified,
      not_qualified: notQualified,
      teams: teamRows,
      award: {
        individual: qualified[0] ? { ...qualified[0], ...titleInfo } : null,
        team: (teamRows[0] && teamRows[0].score != null) ? { ...teamRows[0], ...TEAM_TITLE } : null,
      },
    };
    lbCache.set(cacheKey, { t: Date.now(), v: out });
    res.json(out);
  } catch (err) {
    console.error('champions leaderboard error', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- TEAMS -----------------------------------------------------------------
router.get('/teams', (req, res) => {
  const db = getDb();
  const teams = db.prepare('SELECT * FROM gam_team ORDER BY name').all();
  const members = db.prepare(`
    SELECT tm.team_id, tm.user_id, u.name, u.role, u.department
    FROM gam_team_member tm JOIN users u ON u.id = tm.user_id ORDER BY u.name`).all();
  const byTeam = {};
  for (const m of members) (byTeam[m.team_id] = byTeam[m.team_id] || []).push(m);
  // Active scorable users not yet on a team (so the admin can place them)
  const assigned = new Set(members.map(m => m.user_id));
  const unassigned = db.prepare('SELECT id, name, role, department FROM users WHERE COALESCE(active,1)=1 ORDER BY name')
    .all().filter(u => !assigned.has(u.id));
  res.json({ teams: teams.map(t => ({ ...t, members: byTeam[t.id] || [] })), unassigned });
});

router.post('/teams', adminOnly, (req, res) => {
  const { name, motto } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Team name required' });
  const r = getDb().prepare('INSERT INTO gam_team (name, motto) VALUES (?, ?)').run(String(name).trim(), motto || null);
  lbCache.clear();
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/teams/:id', adminOnly, (req, res) => {
  const { name, motto } = req.body || {};
  getDb().prepare('UPDATE gam_team SET name=COALESCE(?,name), motto=COALESCE(?,motto) WHERE id=?')
    .run(name ? String(name).trim() : null, motto !== undefined ? motto : null, req.params.id);
  lbCache.clear();
  res.json({ message: 'Saved' });
});

router.delete('/teams/:id', adminOnly, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM gam_team_member WHERE team_id=?').run(req.params.id);
  db.prepare('DELETE FROM gam_team WHERE id=?').run(req.params.id);
  lbCache.clear();
  res.json({ message: 'Deleted' });
});

// Assign / move a user into a team (user is unique → moves out of any old pod)
router.post('/teams/:id/members', adminOnly, (req, res) => {
  const userId = parseInt(req.body?.user_id, 10);
  if (!userId) return res.status(400).json({ error: 'user_id required' });
  getDb().prepare(`INSERT INTO gam_team_member (team_id, user_id) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET team_id=excluded.team_id`).run(req.params.id, userId);
  lbCache.clear();
  res.json({ message: 'Added' });
});

router.delete('/teams/:id/members/:userId', adminOnly, (req, res) => {
  getDb().prepare('DELETE FROM gam_team_member WHERE team_id=? AND user_id=?').run(req.params.id, req.params.userId);
  lbCache.clear();
  res.json({ message: 'Removed' });
});

// ---- AUTO-BALANCE — the headline "make fair teams" feature ------------------
// Distributes every active scorable user across N balanced pods using a
// snake draft on their CURRENT score: rank players, then deal 1→N, N→1,
// 1→N… so each team gets a comparable mix of strong and developing players.
const TEAM_NAME_POOL = ['Titans', 'Vanguard', 'Apex', 'Falcons', 'Dynamos', 'Pinnacle', 'Spartans', 'Trailblazers', 'Phoenix', 'Olympians'];
router.post('/teams/auto-balance', adminOnly, (req, res) => {
  try {
    const db = getDb();
    const count = Math.max(2, Math.min(10, parseInt(req.body?.count, 10) || 4));
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.date || '') ? req.body.date : istTodayYMD();
    const bounds = periodBounds('month', date);
    const weeks = weekStartsIn(bounds.start, bounds.end);
    const cfg = getConfig();
    const minActivity = Math.max(0, parseFloat(cfg.min_activity) || 0);

    // Rank scorable users by current monthly score (unscored sink to the end).
    const users = db.prepare('SELECT id, name FROM users WHERE COALESCE(active,1)=1').all();
    const scCache = new Map();
    const ranked = users
      .map(u => ({ ...u, sc: userPeriodScore(db, u.id, weeks, minActivity, scCache) }))
      .filter(u => u.sc.hasTemplate)
      .sort((a, b) => (b.sc.score ?? -1) - (a.sc.score ?? -1));
    if (!ranked.length) return res.status(400).json({ error: 'No scorable employees found (assign Performance templates first).' });

    // Fresh teams
    db.prepare('DELETE FROM gam_team_member').run();
    db.prepare('DELETE FROM gam_team').run();
    const teamIds = [];
    for (let i = 0; i < count; i++) {
      const name = TEAM_NAME_POOL[i] || `Team ${i + 1}`;
      teamIds.push(db.prepare('INSERT INTO gam_team (name) VALUES (?)').run(name).lastInsertRowid);
    }
    // Snake draft
    const addMember = db.prepare('INSERT INTO gam_team_member (team_id, user_id) VALUES (?, ?)');
    const tx = db.transaction(() => {
      ranked.forEach((u, idx) => {
        const round = Math.floor(idx / count);
        const pos = idx % count;
        const teamIdx = round % 2 === 0 ? pos : (count - 1 - pos);
        addMember.run(teamIds[teamIdx], u.id);
      });
    });
    tx();
    lbCache.clear();
    res.json({ message: `Created ${count} balanced teams from ${ranked.length} players`, teams: count, players: ranked.length });
  } catch (err) {
    console.error('auto-balance error', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- CONFIG ----------------------------------------------------------------
router.get('/config', (req, res) => res.json(getConfig()));
router.put('/config', adminOnly, (req, res) => {
  const db = getDb();
  const up = db.prepare('INSERT INTO gam_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const k of Object.keys(CONFIG_DEFAULTS)) {
    if (req.body && req.body[k] !== undefined && req.body[k] !== null) up.run(k, String(req.body[k]));
  }
  lbCache.clear();
  res.json(getConfig());
});

module.exports = router;
