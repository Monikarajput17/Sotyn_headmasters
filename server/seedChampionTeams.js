// One-time: build the 4 Champions League teams from mam's PDF (2026-06-27) and
// assign active users to them by name. Wipes any existing Champions teams first.
//   Run on the VPS:   node server/seedChampionTeams.js
const { getDb } = require('./db/schema');
const db = getDb();

// Self-create the Champions tables (same shape as routes/champions.js) so this
// can run before the server has ever loaded that route.
db.exec(`
  CREATE TABLE IF NOT EXISTS gam_team (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, motto TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS gam_team_member (
    id INTEGER PRIMARY KEY AUTOINCREMENT, team_id INTEGER, user_id INTEGER UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
`);

const TEAMS = {
  'Naye Nawab': ['Taranpreet Singh', 'Tenzin Aryan', 'Vishal', 'Amit Kumar', 'Ankit Raj', 'Brijesh Bhatia', 'Durgesh Sharma', 'Gautam Kumar', 'Ishaan Rawat', 'Jatin Verma', 'shahzad ali', 'Shubham Sharma'],
  'Singham':    ['Aakash Chaudhary', 'Vivek', 'Avinash Agrawal', 'Gagandeep singh', 'Gurcharan', 'kuldeepak', 'Manoj Kumar', 'Punit Yadav', 'Raushan Kumar', 'Samsad'],
  'Rockstar':   ['Sushila', 'Aanchal', 'Ajmer', 'Anmol', 'Lovely Sharma', 'MD.Asad Ali', 'Nancy', 'Ruksana', 'Sheetal'],
  'Badshah':    ['Monika Devi', 'Nitin Jain', 'Parul Goyal', 'Prabhdeep Singh', 'Raj Kumar', 'Rajat Sharma'],
};

const norm = (s) => String(s || '').trim().toLowerCase();
const findUser = (name) => db.prepare(
  'SELECT id, name FROM users WHERE LOWER(TRIM(name)) = ? AND COALESCE(active,1)=1 ORDER BY id LIMIT 1'
).get(norm(name));

const unmatched = [];
const assign = db.prepare('INSERT INTO gam_team_member (team_id, user_id) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET team_id=excluded.team_id');
db.transaction(() => {
  db.prepare('DELETE FROM gam_team_member').run();
  db.prepare('DELETE FROM gam_team').run();
  for (const [teamName, members] of Object.entries(TEAMS)) {
    const teamId = db.prepare('INSERT INTO gam_team (name) VALUES (?)').run(teamName).lastInsertRowid;
    for (const name of members) {
      const u = findUser(name);
      if (!u) { unmatched.push(`${name}  →  ${teamName}`); continue; }
      assign.run(teamId, u.id);
    }
  }
})();

console.log('Champions teams rebuilt:');
for (const [t, m] of Object.entries(TEAMS)) {
  const cnt = db.prepare('SELECT COUNT(*) c FROM gam_team_member tm JOIN gam_team gt ON gt.id=tm.team_id WHERE gt.name=?').get(t).c;
  console.log(`  ${t.padEnd(12)} ${cnt}/${m.length} assigned`);
}
if (unmatched.length) {
  console.log('\nUNMATCHED — no ACTIVE user with that exact name (fix the spelling in Users, or drag them in via the kanban):');
  unmatched.forEach((u) => console.log('  - ' + u));
} else {
  console.log('\nAll names matched ✓');
}
