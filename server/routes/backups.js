// Admin-only API for database backups.
//
// Endpoints:
//   GET   /api/admin/backups              -> list backups (metadata only)
//   POST  /api/admin/backups/run          -> trigger a backup right now
//   GET   /api/admin/backups/:file/download -> stream a backup file

const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { authMiddleware, adminOnly, getSecret } = require('../middleware/auth');
const { runBackup, listBackups, BACKUP_DIR } = require('../scripts/backup-db');

const router = express.Router();

// Stream a backup file so admin can pull it onto their laptop. Guarded: only
// filenames matching the standard backup pattern are served, so this can't read
// arbitrary files from the VPS.
//
// This route has its OWN auth (Authorization header OR ?token= query param) and
// is declared BEFORE the global authMiddleware. That lets the browser download
// the file via a plain navigation — streaming the (large, 150+ MB) .db straight
// to disk — instead of the page pulling the whole file into an in-memory blob,
// which was failing on big backups (mam 2026-06-29: "not able to download").
// Query-token acceptance is scoped to THIS endpoint only.
router.get('/:file/download', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.query.token || '');
  let user;
  try { user = jwt.verify(token, getSecret()); }
  catch (e) { return res.status(401).json({ error: 'Unauthorized' }); }
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

  const file = req.params.file;
  if (!/^erp-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/.test(file)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const full = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Backup not found' });
  res.download(full, file);
});

// Everything below is admin-only via the standard header auth.
router.use(authMiddleware);
router.use(adminOnly);

router.get('/', (req, res) => {
  res.json({ backup_dir: BACKUP_DIR, backups: listBackups() });
});

router.post('/run', async (req, res) => {
  try {
    const r = await runBackup({ silent: true });
    if (!r.ok) return res.status(500).json({ error: r.error });
    res.status(201).json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
