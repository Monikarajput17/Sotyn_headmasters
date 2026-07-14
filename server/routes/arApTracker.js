// AR/AP Tracker — rolling weekly cash-flow forecast (mam 2026-06-18).
//
// Mirrors mam's "Cash Flow June-2026.xlsx": an AR grid (expected receipts by
// party × week), an AP grid (expected payments by party × week) and a Summary
// that nets each week's AR − AP into a running balance. Amounts are in LAKHS.
//
// The defining rule (build spec §4/§5): editing an amount or a date is BLOCKED
// until a remark is entered, and every change is written to a readable,
// searchable, exportable change log (old → new, who, when, why). Creating a
// brand-new entry does NOT need a remark.
const express = require('express');
const XLSX = require('xlsx');
const multer = require('multer');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);
const uploadXlsx = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Idempotent schema — created at module load so the tables exist before any
// handler runs, without touching the central schema.js SQL block.
getDb().exec(`
  CREATE TABLE IF NOT EXISTS arap_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK(kind IN ('AR','AP')),
    party TEXT NOT NULL,
    due_date DATE NOT NULL,
    planned REAL DEFAULT 0,
    actual REAL,
    status TEXT DEFAULT 'planned' CHECK(status IN ('planned','partial','done','cancelled')),
    note TEXT,
    created_by INTEGER,
    created_by_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_arap_kind  ON arap_entries(kind);
  CREATE INDEX IF NOT EXISTS idx_arap_date  ON arap_entries(due_date);
  CREATE INDEX IF NOT EXISTS idx_arap_party ON arap_entries(party);

  CREATE TABLE IF NOT EXISTS arap_changelog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER,
    kind TEXT,
    party TEXT,
    field TEXT,
    old_value TEXT,
    new_value TEXT,
    remark TEXT NOT NULL,
    changed_by INTEGER,
    changed_by_name TEXT,
    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_arap_cl_entry ON arap_changelog(entry_id);
  CREATE INDEX IF NOT EXISTS idx_arap_cl_date  ON arap_changelog(changed_at DESC);
`);

// The figure that actually moves cash: the realised actual once it exists,
// else the planned forecast.
const effective = (r) => (r.actual != null && r.actual !== '' ? +r.actual : +r.planned || 0);

const logChange = (db, entry, field, oldV, newV, remark, user) =>
  db.prepare(`INSERT INTO arap_changelog (entry_id, kind, party, field, old_value, new_value, remark, changed_by, changed_by_name)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(entry.id, entry.kind, entry.party, field,
         oldV == null ? '' : String(oldV), newV == null ? '' : String(newV),
         remark, user.id, user.name || '');

// GET list — filter by kind (AR/AP), date range, party, free-text search.
router.get('/', requirePermission('ar_ap_tracker', 'view'), (req, res) => {
  const db = getDb();
  const { kind, from, to, party, search } = req.query;
  const where = [], args = [];
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (from) { where.push('due_date >= ?'); args.push(from); }
  if (to) { where.push('due_date <= ?'); args.push(to); }
  if (party) { where.push('party = ?'); args.push(party); }
  if (search) { where.push('(party LIKE ? OR note LIKE ?)'); args.push(`%${search}%`, `%${search}%`); }
  const sql = `SELECT * FROM arap_entries ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY due_date, party`;
  res.json(db.prepare(sql).all(...args));
});

// GET summary — per-date AR total, AP total, net, running balance (Lakhs).
router.get('/summary', requirePermission('ar_ap_tracker', 'view'), (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM arap_entries').all();
  const byDate = {};
  for (const r of rows) {
    const d = (byDate[r.due_date] || (byDate[r.due_date] = { date: r.due_date, ar: 0, ap: 0 }));
    if (r.kind === 'AR') d.ar += effective(r); else d.ap += effective(r);
  }
  let bal = 0;
  const out = Object.values(byDate).sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map(d => { const net = d.ar - d.ap; bal += net; return { ...d, net: +net.toFixed(2), balance: +bal.toFixed(2) }; });
  const totAR = out.reduce((s, d) => s + d.ar, 0), totAP = out.reduce((s, d) => s + d.ap, 0);
  res.json({ rows: out, totals: { ar: +totAR.toFixed(2), ap: +totAP.toFixed(2), net: +(totAR - totAP).toFixed(2) } });
});

// GET change log — newest first, optional kind + free-text search.
router.get('/changelog', requirePermission('ar_ap_tracker', 'view'), (req, res) => {
  const db = getDb();
  const { kind, search } = req.query;
  const where = [], args = [];
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (search) { where.push('(party LIKE ? OR remark LIKE ? OR field LIKE ? OR changed_by_name LIKE ?)'); args.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
  const sql = `SELECT * FROM arap_changelog ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY changed_at DESC, id DESC LIMIT 1000`;
  res.json(db.prepare(sql).all(...args));
});

// GET party suggestions — unique AR names from the Business Book (client +
// company) and unique AP names from the Vendors master, for the Add/Edit
// dropdowns (mam 2026-06-18).
router.get('/parties', requirePermission('ar_ap_tracker', 'view'), (req, res) => {
  const db = getDb();
  const uniq = (arr) => [...new Set(arr.map(s => String(s || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const ar = uniq(db.prepare('SELECT client_name, company_name FROM business_book').all().flatMap(r => [r.client_name, r.company_name]));
  const ap = uniq(db.prepare('SELECT name FROM vendors').all().map(r => r.name));
  res.json({ ar, ap });
});

// POST create — no remark required for a brand-new entry. We still record a
// "created" change-log row so the audit trail is complete.
router.post('/', requirePermission('ar_ap_tracker', 'create'), (req, res) => {
  const db = getDb();
  const { kind, party, due_date, planned, actual, status, note } = req.body;
  if (!['AR', 'AP'].includes(kind)) return res.status(400).json({ error: 'kind must be AR or AP' });
  if (!party || !String(party).trim()) return res.status(400).json({ error: 'Party is required' });
  if (!due_date) return res.status(400).json({ error: 'Date is required' });
  const info = db.prepare(`INSERT INTO arap_entries (kind, party, due_date, planned, actual, status, note, created_by, created_by_name)
                           VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(kind, String(party).trim(), due_date, +planned || 0,
         actual === '' || actual == null ? null : +actual,
         status || 'planned', note || null, req.user.id, req.user.name || '');
  const row = db.prepare('SELECT * FROM arap_entries WHERE id=?').get(info.lastInsertRowid);
  logChange(db, row, 'created', '', `${kind} · ${party} · ${due_date} · ₹${+planned || 0}L`, note || 'New entry', req.user);
  res.json(row);
});

// PUT edit — a change to planned / actual / due_date REQUIRES a remark; each
// changed field is logged individually with that remark.
router.put('/:id', requirePermission('ar_ap_tracker', 'edit'), (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM arap_entries WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const { party, due_date, planned, actual, status, note, remark } = req.body;

  // Build the set of real changes vs the current row.
  const next = {
    party: party != null ? String(party).trim() : cur.party,
    due_date: due_date != null ? due_date : cur.due_date,
    planned: planned != null && planned !== '' ? +planned : (planned === '' ? 0 : cur.planned),
    actual: actual === '' || actual == null ? (actual === '' ? null : cur.actual) : +actual,
    status: status != null ? status : cur.status,
    note: note != null ? note : cur.note,
  };
  const numEq = (a, b) => (a == null ? null : +a) === (b == null ? null : +b);
  const changes = [];
  if (next.party !== cur.party) changes.push(['party', cur.party, next.party]);
  if (next.due_date !== cur.due_date) changes.push(['due_date', cur.due_date, next.due_date]);
  if (!numEq(next.planned, cur.planned)) changes.push(['planned', cur.planned, next.planned]);
  if (!numEq(next.actual, cur.actual)) changes.push(['actual', cur.actual, next.actual]);
  if (next.status !== cur.status) changes.push(['status', cur.status, next.status]);
  if ((next.note || '') !== (cur.note || '')) changes.push(['note', cur.note, next.note]);

  if (!changes.length) return res.json(cur); // nothing to do

  // Mandatory-remark gate: any amount or date change needs a reason.
  const sensitive = changes.some(c => ['planned', 'actual', 'due_date'].includes(c[0]));
  if (sensitive && (!remark || String(remark).trim().length < 3)) {
    return res.status(400).json({ error: 'A remark (min 3 chars) is required to change an amount or date.' });
  }

  db.prepare(`UPDATE arap_entries SET party=?, due_date=?, planned=?, actual=?, status=?, note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(next.party, next.due_date, next.planned, next.actual, next.status, next.note, cur.id);
  const why = (remark && String(remark).trim()) || 'Edited';
  for (const [field, oldV, newV] of changes) logChange(db, cur, field, oldV, newV, why, req.user);
  res.json(db.prepare('SELECT * FROM arap_entries WHERE id=?').get(cur.id));
});

// DELETE — significant, so it also captures a remark into the change log.
router.delete('/:id', requirePermission('ar_ap_tracker', 'delete'), (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM arap_entries WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const remark = req.body?.remark || req.query?.remark;
  if (!remark || String(remark).trim().length < 3) return res.status(400).json({ error: 'A remark (min 3 chars) is required to delete an entry.' });
  logChange(db, cur, 'deleted', `${cur.kind} · ${cur.party} · ${cur.due_date} · ₹${effective(cur)}L`, '', String(remark).trim(), req.user);
  db.prepare('DELETE FROM arap_entries WHERE id=?').run(cur.id);
  res.json({ ok: true });
});

// ── Excel import (mam 2026-06-18) ──────────────────────────────────────
// Upload the "Cash Flow" workbook (AR sheet + AP sheet, party × week grid),
// match each AR party to a Business Book client and each AP party to a
// Vendor, and upsert the cells into the tracker. The sheet's dates are
// entered inconsistently (some as "13-06" text, some as real dates that got
// month/day swapped), so we normalise using the fact that this is a
// June–July forecast: whichever component is 6 or 7 is the month.
const IMPORT_YEAR = 2026;
// Headers are read as FORMATTED text (the "DD-MM" Excel shows), not as Date
// objects — the workbook's real-date cells are corrupted (off-by-one + the
// source stored them wrong), but the displayed text is always correct.
function parseHeaderDate(v) {
  const m = String(v == null ? '' : v).match(/(\d{1,2})\s*[-/.]\s*(\d{1,2})/);
  if (!m) return null;
  const day = +m[1], month = +m[2];                  // sheet convention is DD-MM
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${IMPORT_YEAR}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function parseSheet(ws, kind) {
  // raw:false → every cell becomes its formatted display string, so date
  // headers arrive as "10-06" etc. and amounts as "15" / "9.6".
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null, raw: false });
  if (!rows.length) return [];
  const header = rows[0] || [];
  const dateCols = [];
  for (let c = 1; c < header.length; c++) { const d = parseHeaderDate(header[c]); if (d) dateCols.push({ c, date: d }); }
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const raw = rows[r][0];
    const party = typeof raw === 'string' ? raw.trim() : '';
    if (!party || /^(planned|actual|total)$/i.test(party)) continue;
    for (const dc of dateCols) {
      const amt = parseFloat(String(rows[r][dc.c] == null ? '' : rows[r][dc.c]).replace(/,/g, ''));
      if (Number.isFinite(amt) && amt > 0) out.push({ kind, party, due_date: dc.date, planned: amt });
    }
  }
  return out;
}
// Match a sheet party to a master name: exact (case/space-insensitive) first,
// then a contains-either-way fuzzy. Returns the canonical master name or null.
function buildMatcher(names) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const list = names.filter(Boolean).map(n => ({ name: n, k: norm(n) }));
  return (party) => {
    const p = norm(party);
    if (!p) return null;
    const exact = list.find(x => x.k === p); if (exact) return exact.name;
    const fuzzy = list.find(x => x.k && (x.k.includes(p) || p.includes(x.k)));
    return fuzzy ? fuzzy.name : null;
  };
}

// Shared core for both Excel import and bulk paste: match each party to a
// master and upsert by kind+party+date. ONE combined matcher (Business Book
// clients + Vendors) is used for BOTH AR and AP, so the same party (e.g.
// "sael") resolves to the same canonical name on both sides — AP parties are
// often clients, not vendors (mam 2026-06-18).
function importEntries(db, entries, user, sourceLabel, replace) {
  const clients = db.prepare('SELECT client_name, company_name FROM business_book').all().flatMap(r => [r.client_name, r.company_name]);
  const vendors = db.prepare('SELECT name FROM vendors').all().map(r => r.name);
  const match = buildMatcher([...clients, ...vendors]);
  const upd = db.prepare('UPDATE arap_entries SET planned=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');
  const ins = db.prepare(`INSERT INTO arap_entries (kind, party, due_date, planned, status, note, created_by, created_by_name) VALUES (?,?,?,?,?,?,?,?)`);
  const findExisting = db.prepare('SELECT id FROM arap_entries WHERE kind=? AND party=? AND due_date=?');
  let imported = 0, updated = 0, matched = 0;
  const unmatched = new Set();
  const tx = db.transaction(() => {
    if (replace) db.prepare('DELETE FROM arap_entries').run();
    for (const e of entries) {
      const canonical = match(e.party);
      const party = canonical || e.party;
      if (canonical) matched++; else unmatched.add(`${e.kind}: ${e.party}`);
      const note = canonical && canonical.toLowerCase() !== e.party.toLowerCase() ? `sheet: ${e.party}` : null;
      const ex = findExisting.get(e.kind, party, e.due_date);
      if (ex) { upd.run(e.planned, ex.id); updated++; }
      else { ins.run(e.kind, party, e.due_date, e.planned, 'planned', note, user.id, user.name || ''); imported++; }
    }
    db.prepare(`INSERT INTO arap_changelog (entry_id, kind, party, field, old_value, new_value, remark, changed_by, changed_by_name) VALUES (NULL,?,?,?,?,?,?,?,?)`)
      .run('AR/AP', '—', 'imported', '', `${imported} new · ${updated} updated`, `Bulk add — ${sourceLabel}`, user.id, user.name || '');
  });
  tx();
  return {
    imported, updated, matched, total: entries.length,
    unmatched: [...unmatched].sort(),
    byKind: { AR: entries.filter(e => e.kind === 'AR').length, AP: entries.filter(e => e.kind === 'AP').length },
  };
}

// Parse a free-text date: "DD-MM" / "D-M" (year defaults to IMPORT_YEAR) or "YYYY-MM-DD".
function normLineDate(s) {
  const t = String(s == null ? '' : s).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})\s*[-/.]\s*(\d{1,2})$/);
  if (m) { const day = +m[1], month = +m[2]; if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return `${IMPORT_YEAR}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`; }
  return null;
}

router.post('/import', requirePermission('ar_ap_tracker', 'create'), uploadXlsx.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const db = getDb();
  let wb;
  try { wb = XLSX.read(req.file.buffer); }
  catch (e) { return res.status(400).json({ error: 'Could not read the Excel file' }); }

  // Classify sheets: SUMMARY skipped; names beginning AR / AP.
  let entries = [];
  for (const sn of wb.SheetNames) {
    const up = sn.trim().toUpperCase();
    if (up.startsWith('SUMMARY')) continue;
    const kind = up.startsWith('AR') ? 'AR' : up.startsWith('AP') ? 'AP' : null;
    if (!kind) continue;
    entries = entries.concat(parseSheet(wb.Sheets[sn], kind));
  }
  if (!entries.length) return res.status(400).json({ error: 'No AR/AP rows found. Expecting sheets named "AR…" and "AP…" with a party column and date columns.' });
  const replace = !!(req.body && (req.body.replace === '1' || req.body.replace === 'true'));
  res.json(importEntries(db, entries, req.user, req.file.originalname || 'Excel', replace));
});

// Bulk paste — one entry per line: "party, date, amount" (or prefix a line
// with "AR"/"AP" to override). Date is DD-MM (year defaults to the forecast
// year) or YYYY-MM-DD. Same name-matching + upsert as the Excel import.
router.post('/bulk', requirePermission('ar_ap_tracker', 'create'), (req, res) => {
  const db = getDb();
  const defKind = req.body && /^(AR|AP)$/i.test(req.body.kind || '') ? req.body.kind.toUpperCase() : null;
  const text = req.body && req.body.text;
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Paste at least one line: party, date, amount' });
  const entries = [], skipped = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let parts = t.split(/\t/);                       // tab-separated (Excel paste)
    if (parts.length < 2) parts = t.split(/\s*[,;]\s*/);  // else comma / semicolon
    parts = parts.map(s => s.trim()).filter(Boolean);
    let kind = defKind, party, dateStr, amtStr;
    if (/^(AR|AP)$/i.test(parts[0] || '')) { kind = parts[0].toUpperCase(); [, party, dateStr, amtStr] = parts; }
    else { [party, dateStr, amtStr] = parts; }
    const due = normLineDate(dateStr);
    const amt = parseFloat(String(amtStr == null ? '' : amtStr).replace(/,/g, ''));
    if (party && due && Number.isFinite(amt) && amt > 0 && (kind === 'AR' || kind === 'AP')) entries.push({ kind, party, due_date: due, planned: amt });
    else skipped.push(t);
  }
  if (!entries.length) return res.status(400).json({ error: 'No valid rows. Each line needs: party, date (DD-MM), amount — pick the AR or AP tab first.' });
  const report = importEntries(db, entries, req.user, 'pasted rows', false);
  report.skipped = skipped.length;
  res.json(report);
});

// ── Collection-day auto-roll (mam 2026-06-18) ──────────────────────────
// Money moves only on fixed days: AR (receivables) on MON & THU, AP
// (payables) on TUE & FRI. If an entry isn't settled by its date it rolls to
// the next collection day for its kind — e.g. AR Mon→Thu / Thu→next Mon, AP
// Tue→Fri / Fri→next Tue. Runs daily via cron (arApRollCron) + POST /roll-forward.
// Days-to-add from each weekday (Sun=0 … Sat=6) to reach the kind's next day.
const COLLECT = {
  AR: { 0: 1, 1: 3, 2: 2, 3: 1, 4: 4, 5: 3, 6: 2 },   // Mon & Thu
  AP: { 0: 2, 1: 1, 2: 3, 3: 2, 4: 1, 5: 4, 6: 3 },   // Tue & Fri
};
const COLLECT_LABEL = { AR: 'Mon/Thu', AP: 'Tue/Fri' };
function nextCollectionDay(dateStr, kind) {
  const map = COLLECT[kind] || COLLECT.AR;
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateStr;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() + map[d.getUTCDay()]);
  return d.toISOString().slice(0, 10);
}
// Today's date on the India clock (entries store plain YYYY-MM-DD).
function istToday() { return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); }

// Roll every still-'planned', not-yet-settled AR/AP entry whose date has
// passed onto the next upcoming collection day for its kind. Each move logged.
function rollOverdue(db, user) {
  const today = istToday();
  const pend = db.prepare(`SELECT * FROM arap_entries WHERE status='planned' AND (actual IS NULL OR actual='') AND due_date < ?`).all(today);
  let rolled = 0;
  const tx = db.transaction(() => {
    for (const e of pend) {
      let nd = nextCollectionDay(e.due_date, e.kind), guard = 0;
      while (nd < today && guard++ < 120) nd = nextCollectionDay(nd, e.kind);
      if (!nd || nd === e.due_date) continue;
      db.prepare('UPDATE arap_entries SET due_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(nd, e.id);
      db.prepare(`INSERT INTO arap_changelog (entry_id, kind, party, field, old_value, new_value, remark, changed_by, changed_by_name)
                  VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(e.id, e.kind, e.party, 'due_date (auto-roll)', e.due_date, nd, `Not settled by due date — rolled to next collection day (${COLLECT_LABEL[e.kind] || ''} rule)`, user?.id || null, user?.name || 'System');
      rolled++;
    }
  });
  tx();
  return rolled;
}

// Manual trigger — roll overdue AR + AP entries now.
router.post('/roll-forward', requirePermission('ar_ap_tracker', 'edit'), (req, res) => {
  res.json({ rolled: rollOverdue(getDb(), req.user) });
});

module.exports = router;
module.exports.rollOverdue = rollOverdue;
