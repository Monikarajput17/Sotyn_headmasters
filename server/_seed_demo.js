// Demo seeder for the Champions League local preview. Idempotent + SAFE:
// it NEVER hardcodes user ids (those collide with real users). Demo rows are
// marked by email '@champdemo.local' and the template name, and clean() only
// ever touches rows carrying that marker.
//   node _seed_demo.js         -> seed demo employees + template + activity
//   node _seed_demo.js clean   -> remove everything this script created
const { getDb, initializeDatabase } = require('./db/schema');
initializeDatabase();
const db = getDb();

const TPL_NAME = 'Field Ops (Demo)';
const EMAIL_MARK = '%@champdemo.local';

function demoUserIds() {
  return db.prepare("SELECT id FROM users WHERE email LIKE ?").all(EMAIL_MARK).map(r => r.id);
}

function clean() {
  db.pragma('foreign_keys = OFF');
  const ids = demoUserIds();
  if (ids.length) {
    const ph = ids.join(',');
    db.prepare(`DELETE FROM delegations WHERE assigned_to IN (${ph})`).run();
    db.prepare(`DELETE FROM leads WHERE assigned_to IN (${ph})`).run();
    db.prepare(`DELETE FROM score_entries WHERE user_id IN (${ph})`).run();
    db.prepare(`DELETE FROM score_user_template WHERE user_id IN (${ph})`).run();
    db.prepare(`DELETE FROM gam_team_member WHERE user_id IN (${ph})`).run();
    db.prepare(`DELETE FROM users WHERE id IN (${ph})`).run();
  }
  const tpl = db.prepare('SELECT id FROM score_templates WHERE name=?').get(TPL_NAME);
  if (tpl) {
    db.prepare('DELETE FROM score_kpis WHERE template_id=?').run(tpl.id);
    db.prepare('DELETE FROM score_user_template WHERE template_id=?').run(tpl.id);
    db.prepare('DELETE FROM score_templates WHERE id=?').run(tpl.id);
  }
  db.pragma('foreign_keys = ON');
  console.log(`Demo data removed (${ids.length} demo users).`);
}

clean(); // always start clean so re-runs don't pile up
if (process.argv[2] === 'clean') { process.exit(0); }

function mondayOf(s){ const d=new Date(s+'T00:00:00Z'); const dow=d.getUTCDay(); d.setUTCDate(d.getUTCDate()+(dow===0?-6:1-dow)); return d.toISOString().slice(0,10); }
function addDays(s,n){ const d=new Date(s+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
const mondays = []; let m = mondayOf('2026-06-01'); while (m <= '2026-06-30') { mondays.push(m); m = addDays(m, 7); }

// Score is driven by a `manual` KPI (full control of the demo numbers) plus a
// zero-weight auto:delegations KPI that exists only to satisfy the activity
// gate (manual KPIs don't register as "activity"). The site/sales auto sources
// can't be used here because the Scorecard engine gates them behind "user
// manages a site", which demo users don't.
//   players: [name, dept, targetScore]  → Champions Score lands exactly here
const players = [
  ['Asha Verma',   'Sales',       132], // green star, above plan
  ['Bharat Singh', 'Procurement', 121],
  ['Chetan Rao',   'Site',        113],
  ['Divya Nair',   'Accounts',    104],
  ['Esha Khan',    'Site',         98],
  ['Farhan Ali',   'Procurement',  89],
  ['Gita Menon',   'Accounts',     77],
  ['Hari Joshi',   'Site',         63],
];

const tx = db.transaction(() => {
  const tplId = db.prepare('INSERT INTO score_templates (name, description) VALUES (?, ?)')
    .run(TPL_NAME, 'Demo template for Champions League preview').lastInsertRowid;
  // weight 0 → no score impact, just provides "activity" for the qualify gate
  db.prepare("INSERT INTO score_kpis (template_id, group_name, metric_name, weightage, direction, data_source, display_order, default_planned) VALUES (?,?,?,?,?,?,?,?)")
    .run(tplId, 'Weekly', 'Tasks done', 0, 'higher_better', 'auto:delegations', 1, 5);
  // weight 100 → drives the score; planned 100, actual = target
  const kPerf = db.prepare("INSERT INTO score_kpis (template_id, group_name, metric_name, weightage, direction, data_source, display_order, default_planned) VALUES (?,?,?,?,?,?,?,?)")
    .run(tplId, 'Weekly', 'Performance', 100, 'higher_better', 'manual', 2, 100).lastInsertRowid;

  const insUser = db.prepare("INSERT INTO users (name, email, password, role, department, active) VALUES (?,?,?,?,?,1)");
  const insAssign = db.prepare("INSERT INTO score_user_template (user_id, template_id) VALUES (?, ?)");
  const insDel = db.prepare("INSERT INTO delegations (assigned_to, title, status, created_at, reviewed_at) VALUES (?,?,?,?,?)");
  const insEntry = db.prepare("INSERT INTO score_entries (user_id, kpi_id, week_start, planned, actual, actual_pct) VALUES (?,?,?,?,?,?)");

  let n = 0;
  for (const [name, dept, target] of players) {
    n++;
    const uid = insUser.run(name, `champdemo_${n}@champdemo.local`, 'x', 'user', dept).lastInsertRowid;
    insAssign.run(uid, tplId);
    for (const mon of mondays) {
      const ts = `${mon} 10:00:00`;
      for (let i = 0; i < 5; i++) insDel.run(uid, 'Demo task', 'approved', ts, ts); // activity
      insEntry.run(uid, kPerf, mon, 100, target, target - 100); // manual perf → CS = target
    }
  }
  console.log(`Seeded ${players.length} demo players across ${mondays.length} weeks (June 2026).`);
});
tx();
