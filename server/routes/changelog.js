// "What's new in the ERP" — admin-only changelog reader for the
// Daily Activity page. Returns the list of git commits for a given
// date / date range so MD can see what new systems / features /
// fixes shipped each day.
//
// Source of truth = git log on the deployed repo. No manual upkeep
// required — every feature ships with a commit, the commit shows up
// here automatically the next time mam opens this page.

const express = require('express');
const router = express.Router();
const { execFile } = require('child_process');
const path = require('path');
const { authMiddleware, adminOnly } = require('../middleware/auth');

router.use(authMiddleware);
router.use(adminOnly);

// Resolve repo root — server lives at <repo>/server/, so .. is the
// repo. Works in dev and on the deployed VPS (/root/erp).
const REPO_DIR = path.resolve(__dirname, '..', '..');

function categorise(subject) {
  const s = (subject || '').toLowerCase();
  if (/^(feat|new|add)/.test(s) || /\b(module|system|page)\b/.test(s) || /(create|build).*(system|module|page|dashboard)/.test(s)) {
    return { type: 'new', emoji: '🆕', label: 'New Feature' };
  }
  if (/^fix/.test(s) || /\b(bug|broken|error|crash|fail)\b/.test(s)) {
    return { type: 'fix', emoji: '🛠️', label: 'Fix' };
  }
  if (/^(refactor|cleanup|polish|tweak|improve|update|upgrade|enhance)/.test(s)) {
    return { type: 'tweak', emoji: '🔧', label: 'Improvement' };
  }
  if (/^(doc|docs|readme)/.test(s)) {
    return { type: 'doc', emoji: '📝', label: 'Docs' };
  }
  return { type: 'other', emoji: '✨', label: 'Update' };
}

router.get('/', (req, res) => {
  const date = req.query.date;
  const dateTo = req.query.date_to;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
  }
  const since = `${date} 00:00:00`;
  const until = `${(dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) ? dateTo : date} 23:59:59`;

  // %H = full hash · %aI = author ISO date · %an = author name · %s = subject · %b = body
  // \x1f = unit separator inside a record · \x1e = record separator
  const fmt = '%H%x1f%aI%x1f%an%x1f%s%x1f%b%x1e';
  execFile(
    'git',
    ['log', `--since=${since}`, `--until=${until}`, `--pretty=format:${fmt}`, '--no-merges'],
    { cwd: REPO_DIR, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout) => {
      if (err) {
        // git missing or not a repo on this host — return empty list,
        // not an error, so the page still renders.
        return res.json({ since: date, until: dateTo || date, commits: [], note: 'git log unavailable on this host' });
      }
      const records = stdout.split('\x1e').map(r => r.trim()).filter(Boolean);
      const commits = records.map(r => {
        const [hash, iso, author, subject, body] = r.split('\x1f');
        const cat = categorise(subject);
        const cleanBody = (body || '')
          .split('\n')
          .filter(line => !/^Co-Authored-By:/i.test(line) && !/Generated with \[Claude/i.test(line))
          .join('\n')
          .trim();
        return {
          hash: (hash || '').slice(0, 8),
          iso,
          date: iso ? iso.slice(0, 10) : null,
          time: iso ? iso.slice(11, 16) : null,
          author,
          subject: (subject || '').trim(),
          body: cleanBody,
          ...cat,
        };
      }).filter(c => c.subject);

      // Group counts by category for the headline tiles
      const byType = commits.reduce((acc, c) => {
        acc[c.type] = (acc[c.type] || 0) + 1;
        return acc;
      }, {});

      res.json({
        since: date,
        until: dateTo || date,
        commits,
        total: commits.length,
        by_type: byType,
      });
    }
  );
});

module.exports = router;
