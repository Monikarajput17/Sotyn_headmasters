const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const multer = require('multer');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const { findDuplicate, sendDuplicate } = require('../utils/duplicateGuard');
const router = express.Router();
router.use(authMiddleware);

// ─── Voice-note → text (self-hosted, mam 2026-06-17: "give me free") ──────
// Upload a recorded audio file; the server converts it to 16kHz mono WAV with
// ffmpeg and runs whisper.cpp locally (no API key, no per-use cost). Paths are
// configurable via env so the box can be set up without code changes; if the
// binary/model aren't there yet we return a clear "not set up" message.
//
// VPS-safety (mam 2026-06-17: "my erp should not hang"). The box is tiny and
// shared with the live ERP, so transcription is fenced in four ways:
//   1. `nice -n 19` — lowest CPU priority, so ANY ERP request preempts it.
//   2. whisper threads capped at (cores − 1, min 1) — always leaves a core
//      free for Node, so the app keeps answering while a note transcribes.
//   3. a single-flight busy lock — only one job at a time, so two big files
//      can't pile up and exhaust CPU/RAM (the real "hang" risk on 1-2 GB RAM).
//   4. ffmpeg caps input to 10 min and whisper is hard-killed after 3 min.
const audioTmpDir = path.join(__dirname, '..', '..', 'data', 'uploads', 'audio_tmp');
try { fs.mkdirSync(audioTmpDir, { recursive: true }); } catch (_) {}
const audioUpload = multer({ dest: audioTmpDir, limits: { fileSize: 25 * 1024 * 1024 } });
const WHISPER_BIN = process.env.WHISPER_BIN || '/root/whisper.cpp/main';
const WHISPER_MODELS_DIR = process.env.WHISPER_MODELS_DIR || '/root/whisper.cpp/models';
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
// Language: default 'hi' (Hindi) — these are Hindi/Hinglish voice notes, and
// leaving it on auto/English made Whisper spell Hindi as gibberish English.
// Forcing Hindi makes it transcribe the actual words (in Devanagari). Override
// with WHISPER_LANG=auto or =en if a user mostly speaks English.
const WHISPER_LANG = process.env.WHISPER_LANG || 'hi';
const WHISPER_THREADS = Math.max(1, (require('os').cpus().length || 1) - 1);
let transcribeBusy = false;  // single-flight guard — one job at a time

// Pick the most accurate model that's actually installed (medium > small >
// base). The tiny `base` model badly mis-hears Hindi/Hinglish, so dropping a
// bigger model into the models dir + restarting upgrades accuracy with NO
// config change. WHISPER_MODEL env overrides this outright.
function resolveWhisperModel() {
  if (process.env.WHISPER_MODEL) return process.env.WHISPER_MODEL;
  for (const name of ['ggml-medium.bin', 'ggml-small.bin', 'ggml-base.bin']) {
    const p = path.join(WHISPER_MODELS_DIR, name);
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return path.join(WHISPER_MODELS_DIR, 'ggml-base.bin');
}

function getSetting(key) {
  try { const row = getDb().prepare('SELECT value FROM app_settings WHERE key=?').get(key); return row?.value ?? null; }
  catch (_) { return null; }
}

// Staff type tasks in Roman letters, so convert Whisper's accurate Hindi
// (Devanagari) into casual Hinglish using the Claude key the ERP already has.
// Best-effort: no key, or any failure, just returns the original text so
// transcription never breaks. Set WHISPER_ROMANIZE=0 to keep Devanagari.
// Free, dependency-free Devanagari → Roman transliteration. Not perfect
// Hinglish (some inherent-'a' artifacts remain) but always readable Roman,
// no API key / no cost. Used as the guaranteed fallback so output is NEVER
// left in Hindi script.
function devanagariToRoman(input) {
  const V = { 'अ':'a','आ':'aa','इ':'i','ई':'ee','उ':'u','ऊ':'oo','ऋ':'ri','ए':'e','ऐ':'ai','ओ':'o','औ':'au','ऍ':'e','ऑ':'o','ॲ':'a' };
  const M = { 'ा':'aa','ि':'i','ी':'ee','ु':'u','ू':'oo','ृ':'ri','े':'e','ै':'ai','ो':'o','ौ':'au','ॅ':'e','ॉ':'o','ं':'n','ँ':'n','ः':'h' };
  const C = {
    'क':'k','ख':'kh','ग':'g','घ':'gh','ङ':'n','च':'ch','छ':'chh','ज':'j','झ':'jh','ञ':'n',
    'ट':'t','ठ':'th','ड':'d','ढ':'dh','ण':'n','त':'t','थ':'th','द':'d','ध':'dh','न':'n',
    'प':'p','फ':'ph','ब':'b','भ':'bh','म':'m','य':'y','र':'r','ल':'l','व':'v',
    'श':'sh','ष':'sh','स':'s','ह':'h','ळ':'l','ड़':'r','ढ़':'rh','क़':'q','ख़':'kh','ग़':'g','ज़':'z','फ़':'f','य़':'y',
  };
  const D = { '०':'0','१':'1','२':'2','३':'3','४':'4','५':'5','६':'6','७':'7','८':'8','९':'9' };
  const HALANT = '्';
  const chars = Array.from(input);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (C[ch]) {
      out += C[ch];
      const nxt = chars[i + 1];
      if (nxt === HALANT) { i++; continue; }            // conjunct → no vowel
      if (nxt && M[nxt]) { out += M[nxt]; i++; continue; } // explicit matra
      out += 'a';                                        // inherent vowel
    } else if (V[ch]) { out += V[ch]; }
    else if (M[ch]) { out += M[ch]; }
    else if (D[ch]) { out += D[ch]; }
    else { out += ch; }                                  // spaces / punctuation / latin
  }
  return out.replace(/([a-z])a\b/g, '$1');               // drop most word-final inherent 'a'
}

async function romanizeToHinglish(text) {
  if (!text) return text;
  if (process.env.WHISPER_ROMANIZE === '0') return text;
  if (!/[ऀ-ॿ]/.test(text)) return text;   // no Hindi script → nothing to do
  // Prefer Claude (natural Hinglish) IF a key is set — use the SAME model the
  // ERP's AI agent already uses, so we never fail on an unsupported model id.
  const apiKey = getSetting('ai_api_key');
  if (apiKey) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic.default({ apiKey, timeout: 30000 });
      const model = process.env.ROMANIZE_MODEL || getSetting('ai_model') || 'claude-opus-4-7';
      const r = await client.messages.create({
        model, max_tokens: 1200,
        system: 'You transliterate Hindi (Devanagari) into casual Romanized Hinglish exactly how an Indian office worker types in English letters (e.g. "मटेरियल भेजो" -> "material bhejo"). Keep English / brand / product words in English. Do NOT translate the meaning, and do NOT add, remove, or explain anything. Output ONLY the transliterated text.',
        messages: [{ role: 'user', content: text }],
      });
      const out = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      if (out && !/[ऀ-ॿ]/.test(out)) return out;        // good Roman result from Claude
    } catch (_) { /* fall through to the free local transliterator */ }
  }
  return devanagariToRoman(text);                         // guaranteed Roman, no key needed
}

router.post('/transcribe', audioUpload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file received.' });
  const inPath = req.file.path;
  const wavPath = `${inPath}.wav`;
  const txtPath = `${wavPath}.txt`;
  const drop = (f) => { try { fs.unlinkSync(f); } catch (_) {} };
  const WHISPER_MODEL = resolveWhisperModel();

  if (transcribeBusy) {
    drop(inPath);
    return res.status(429).json({ error: 'Another voice note is being transcribed right now. Please try again in a few seconds.' });
  }
  if (!fs.existsSync(WHISPER_BIN) || !fs.existsSync(WHISPER_MODEL)) {
    drop(inPath);
    return res.status(503).json({ error: 'Voice transcription is not set up on the server yet. Ask the admin to install Whisper (one-time setup).' });
  }

  transcribeBusy = true;
  // Centralised exit — always frees the temp files AND releases the lock, so
  // the box can never get stuck "busy" after an error / timeout.
  const finish = (status, body) => {
    for (const f of [inPath, wavPath, txtPath]) drop(f);
    transcribeBusy = false;
    if (!res.headersSent) res.status(status).json(body);
  };

  // 1) Normalise to the WAV whisper.cpp expects; `-t 600` caps reading to the
  //    first 10 minutes so a huge file can't peg the CPU indefinitely.
  execFile(FFMPEG_BIN, ['-y', '-t', '600', '-i', inPath, '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath],
    { timeout: 60000 }, (ffErr) => {
      if (ffErr) return finish(400, { error: 'Could not read that audio. Try mp3 / m4a / wav / ogg.' });
      // 2) Transcribe at lowest priority, bounded threads, hard-killed at 5 min
      //    (bigger/more-accurate models are slower). Language is forced to
      //    Hindi (WHISPER_LANG) so it captures the real words instead of
      //    spelling them as English gibberish.
      execFile('nice', ['-n', '19', WHISPER_BIN, '-m', WHISPER_MODEL, '-t', String(WHISPER_THREADS),
        '-l', WHISPER_LANG, '-f', wavPath, '-nt', '-np', '-otxt', '-of', wavPath],
        { maxBuffer: 10 * 1024 * 1024, timeout: 300000, killSignal: 'SIGKILL' }, async (wErr, stdout) => {
          let text = '';
          try { text = fs.readFileSync(txtPath, 'utf8').trim(); } catch (_) {}
          if (!text) text = String(stdout || '').replace(/\[[0-9:.\s\->]+\]/g, '').trim();
          if (wErr && !text) return finish(500, { error: 'Transcription failed or timed out on the server.' });
          // 3) Convert the Hindi text into the Roman Hinglish staff type in.
          let out = text;
          try { out = await romanizeToHinglish(text); } catch (_) {}
          finish(200, { text: out });
        });
    });
});

// Is this user an EA / supervisor / PMS owner (e.g. Sushila, PMS Executive)?
// Treated as having the can_approve flag on the tasks module. Accepts EITHER
// 'delegations' OR 'pms_tasks' so it matches the frontend (which gates its
// buttons on canApprove('pms_tasks')) — grant either and it works end-to-end.
// Such a user gets (a) the "All" tab across everyone's tasks, (b) upload proof
// on anyone's behalf, and (c) approve/reject tasks + extensions.
const isEA = (uid) => {
  const db = getDb();
  const row = db.prepare(
    `SELECT MAX(rp.can_approve) as allowed
     FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
     WHERE ur.user_id = ? AND rp.module IN ('delegations','pms_tasks')`
  ).get(uid);
  return !!row?.allowed;
};

// List delegations. By default, a user sees tasks assigned TO them. Admin
// and EA (can_approve on delegations) see everything via scope=all.
// Query params: ?scope=mine|given|all, ?status, ?assignee_id, ?date_from, ?date_to
router.get('/', (req, res) => {
  const db = getDb();
  const isAdmin = req.user.role === 'admin';
  const uid = req.user.id;
  const canSeeAll = isAdmin || isEA(uid);
  const { scope = 'mine', status, assignee_id, date_from, date_to } = req.query;

  const where = [];
  const params = [];
  if (canSeeAll && scope === 'all') {
    // no user filter — admin / EA sees everything
  } else if (scope === 'given') {
    where.push('d.assigned_by = ?'); params.push(uid);
  } else if (scope === 'mine') {
    where.push('d.assigned_to = ?'); params.push(uid);
  } else {
    where.push('(d.assigned_to = ? OR d.assigned_by = ?)'); params.push(uid, uid);
  }
  if (status) { where.push('d.status = ?'); params.push(status); }
  // Name filter — admin/EA filter by assignee_id from the dropdown
  if (assignee_id) { where.push('d.assigned_to = ?'); params.push(+assignee_id); }
  // Date range filters — inclusive on both ends. Uses due_date since that's
  // what mam typically cares about when chasing follow-ups.
  if (date_from) { where.push('d.due_date >= ?'); params.push(date_from); }
  if (date_to) { where.push('d.due_date <= ?'); params.push(date_to); }

  const sql = `SELECT d.*,
      au.name as assigned_by_name,
      tu.name as assigned_to_name,
      rv.name as reviewer_name
    FROM delegations d
    LEFT JOIN users au ON au.id = d.assigned_by
    LEFT JOIN users tu ON tu.id = d.assigned_to
    LEFT JOIN users rv ON rv.id = d.reviewer_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY
      CASE d.status WHEN 'rejected' THEN 0 WHEN 'pending' THEN 1 WHEN 'submitted' THEN 2 ELSE 3 END,
      COALESCE(d.due_date, '9999-12-31') ASC,
      d.created_at DESC`;
  res.json(db.prepare(sql).all(...params));
});

// Per-person workload dashboard. mam's spec — one row per assignee with:
//   Total Tasks · Active · Completed · Delayed · Avg Delay (days) · WIP Limit · Status
// Status:
//   Overloaded — active_tasks > wip_limit
//   Constraint — >= 25% of tasks delayed OR avg_delay > 5 days
//   OK         — neither
// WIP limit is 5 by default for everyone; can be made per-user later.
router.get('/dashboard', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const WIP_LIMIT_DEFAULT = 5;

  const rows = db.prepare(`
    SELECT u.id, u.name as person, u.role, u.department,
           COUNT(d.id) as total_tasks,
           SUM(CASE WHEN d.status IN ('pending','submitted','rejected') THEN 1 ELSE 0 END) as active_tasks,
           SUM(CASE WHEN d.status = 'approved' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN d.status IN ('pending','submitted')
                     AND d.due_date IS NOT NULL AND d.due_date < ? THEN 1 ELSE 0 END) as delayed_tasks,
           ROUND(AVG(CASE WHEN d.status IN ('pending','submitted')
                           AND d.due_date IS NOT NULL AND d.due_date < ?
                          THEN julianday(?) - julianday(d.due_date) ELSE NULL END), 1) as avg_delay
      FROM users u
      LEFT JOIN delegations d ON d.assigned_to = u.id
     WHERE u.active = 1
     GROUP BY u.id
    HAVING total_tasks > 0
     ORDER BY active_tasks DESC, delayed_tasks DESC, person
  `).all(today, today, today);

  const out = rows.map(r => {
    const wip = WIP_LIMIT_DEFAULT;
    const delayedRatio = r.total_tasks > 0 ? r.delayed_tasks / r.total_tasks : 0;
    let status = 'OK';
    if (r.active_tasks > wip) status = 'Overloaded';
    else if (delayedRatio >= 0.25 || (r.avg_delay || 0) > 5) status = 'Constraint';
    return {
      id: r.id,
      person: r.person,
      role: r.role,
      department: r.department,
      total_tasks: r.total_tasks || 0,
      active_tasks: r.active_tasks || 0,
      completed: r.completed || 0,
      delayed_tasks: r.delayed_tasks || 0,
      avg_delay: r.avg_delay || 0,
      wip_limit: wip,
      status,
    };
  });
  res.json(out);
});

// Create a new delegation. Admin-only — regular users are recipients, not creators.
// Title is derived from the first line of the description (first 80 chars)
// since the UI no longer asks for it separately.
// project_name is optional — free text so admin can tag tasks with a project
// without depending on any master list.
router.post('/', (req, res) => {
  // Allow: legacy admin role OR any user whose role-matrix has
  // delegations.create / can_approve. Mam's MD (Ankur Kaplesh) is on
  // a non-admin role with full delegation perms via the matrix — the
  // old hardcoded `role !== 'admin'` check blocked him from raising
  // tasks even though he's the senior-most user. The matrix is the
  // source of truth now.
  const db = getDb();
  if (req.user.role !== 'admin') {
    const ok = db.prepare(`
      SELECT MAX(CASE WHEN rp.can_create = 1 OR rp.can_approve = 1 THEN 1 ELSE 0 END) as ok
      FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = ? AND rp.module = 'delegations'
    `).get(req.user.id);
    if (!ok?.ok) return res.status(403).json({ error: 'You need Delegations: Create permission to raise tasks' });
  }
  const { title, description, assigned_to, due_date, project_name, attachment_url } = req.body;
  const desc = String(description || '').trim();
  if (!desc) return res.status(400).json({ error: 'Description is required' });
  if (!assigned_to) return res.status(400).json({ error: 'Assignee is required' });
  const derivedTitle = (title && title.trim()) || desc.split(/\r?\n/)[0].slice(0, 80).trim() || 'Task';
  const project = project_name && String(project_name).trim() ? String(project_name).trim() : null;
  const attachment = attachment_url && String(attachment_url).trim() ? String(attachment_url).trim() : null;

  // Mam (2026-05-21): block duplicate tasks — same description + same
  // assignee + same due-date = same task.  Toast surfaces the existing
  // TSK code so the user can find / extend it instead of re-raising.
  const dup = findDuplicate(db, {
    table: 'delegations',
    fields: { description: desc, assigned_to, due_date: due_date || null },
    codeColumn: 'id', codePrefix: 'TSK-', codePad: 4,
  });
  if (sendDuplicate(res, dup, 'Task')) return;

  const r = db.prepare(
    `INSERT INTO delegations (title, description, assigned_by, assigned_to, due_date, project_name, attachment_url)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(derivedTitle, desc, req.user.id, assigned_to, due_date || null, project, attachment);
  // Fire-and-forget push to the assignee
  try {
    const { notify } = require('../lib/push');
    notify(assigned_to, {
      title: '📋 New Delegation',
      body: `${req.user.name || 'Admin'} assigned: ${derivedTitle}${due_date ? ` · due ${due_date}` : ''}`,
      url: '/delegations',
      tag: `delegation-${r.lastInsertRowid}`,
    });
  } catch {}
  res.status(201).json({ id: r.lastInsertRowid });
});

// Full edit of an existing task — description, assignee, due date, project,
// attachment. Admin or the original assigner only. Allowed in any status
// (pending / submitted / approved / rejected) so mam can fix typos or
// reassign even after submission. Status / proof / reject_reason are NOT
// touched here — those go through their own endpoints.
router.put('/:id', (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT assigned_by, due_date FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
  if (d.assigned_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the assigner or an admin can edit this task' });
  }
  const b = req.body || {};
  const desc = b.description != null ? String(b.description).trim() : null;
  if (b.description != null && !desc) return res.status(400).json({ error: 'Description cannot be empty' });
  const assignedTo = b.assigned_to != null ? +b.assigned_to : null;
  const dueDate = b.due_date != null ? (b.due_date || null) : undefined;
  const project = b.project_name != null ? (String(b.project_name).trim() || null) : undefined;
  const attachment = b.attachment_url != null ? (String(b.attachment_url).trim() || null) : undefined;
  const title = desc ? (desc.split(/\r?\n/)[0].slice(0, 80).trim() || 'Task') : null;

  // Build a partial UPDATE — only touch fields the caller actually sent
  const sets = []; const params = [];
  if (desc != null) { sets.push('description=?', 'title=?'); params.push(desc, title); }
  if (assignedTo) { sets.push('assigned_to=?'); params.push(assignedTo); }
  if (dueDate !== undefined) {
    sets.push('due_date=?'); params.push(dueDate);
    // A manual re-date is "another date given" too, same as an approved extension —
    // bump the health-light counter, but only on a genuine change to a NEW date
    // (not clearing the date or re-saving the same day).
    if (dueDate && d.due_date && dueDate !== d.due_date) sets.push('extension_count = COALESCE(extension_count, 0) + 1');
  }
  if (project !== undefined) { sets.push('project_name=?'); params.push(project); }
  if (attachment !== undefined) { sets.push('attachment_url=?'); params.push(attachment); }
  if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE delegations SET ${sets.join(', ')} WHERE id=?`).run(...params);
  res.json({ message: 'Task updated' });
});

// Inline edit of project_name on an existing task. Admin or the assigner only,
// so random users can't retag someone else's tasks. Empty string clears it.
router.patch('/:id/project', (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT assigned_by FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
  if (d.assigned_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the assigner or an admin can edit the project' });
  }
  const raw = req.body?.project_name;
  const value = raw && String(raw).trim() ? String(raw).trim() : null;
  db.prepare('UPDATE delegations SET project_name=? WHERE id=?').run(value, req.params.id);
  res.json({ message: 'Project updated', project_name: value });
});

// Inline edit of the EA's followup remark for the MD (mam 2026-06-17).
// EA (can_approve on delegations) or admin only — it's the EA's note, and it
// does NOT change the task's status/completion. Empty string clears it.
router.patch('/:id/followup-remarks', (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT id FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
  if (req.user.role !== 'admin' && !isEA(req.user.id)) {
    return res.status(403).json({ error: 'Only the EA or an admin can edit followup remarks' });
  }
  const raw = req.body?.followup_remarks;
  const value = raw && String(raw).trim() ? String(raw).trim() : null;
  db.prepare('UPDATE delegations SET followup_remarks=? WHERE id=?').run(value, req.params.id);
  res.json({ message: 'Followup remark saved', followup_remarks: value });
});

// Assignee requests a due-date extension. Admin (not the assigner) approves.
router.post('/:id/request-extension', (req, res) => {
  const { requested_due_date, reason } = req.body;
  if (!requested_due_date) return res.status(400).json({ error: 'New due date is required' });
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason is required' });
  const db = getDb();
  const d = db.prepare('SELECT * FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
  if (d.assigned_to !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the assignee can request an extension' });
  }
  if (d.status === 'approved') return res.status(400).json({ error: 'Task already approved — no extension needed' });
  db.prepare(
    `UPDATE delegations SET requested_due_date=?, extension_reason=?, extension_status='pending',
       extension_reviewed_at=NULL, extension_reviewed_by=NULL
     WHERE id=?`
  ).run(requested_due_date, reason.trim(), req.params.id);
  res.json({ message: 'Extension requested — admin will review' });
});

// Admin-only: approve the pending extension — updates due_date, clears request.
router.post('/:id/approve-extension', (req, res) => {
  if (req.user.role !== 'admin' && !isEA(req.user.id)) return res.status(403).json({ error: 'Only an admin or PMS owner can approve extensions' });
  const db = getDb();
  const d = db.prepare('SELECT * FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
  if (d.extension_status !== 'pending' || !d.requested_due_date) {
    return res.status(400).json({ error: 'No pending extension to approve' });
  }
  db.prepare(
    `UPDATE delegations SET due_date = requested_due_date,
       extension_count = COALESCE(extension_count, 0) + 1,
       extension_status='approved', extension_reviewed_at=CURRENT_TIMESTAMP, extension_reviewed_by=?
     WHERE id=?`
  ).run(req.user.id, req.params.id);
  res.json({ message: 'Extension approved — due date updated' });
});

// Admin-only: reject the pending extension.
router.post('/:id/reject-extension', (req, res) => {
  if (req.user.role !== 'admin' && !isEA(req.user.id)) return res.status(403).json({ error: 'Only an admin or PMS owner can reject extensions' });
  const db = getDb();
  const d = db.prepare('SELECT * FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
  if (d.extension_status !== 'pending') return res.status(400).json({ error: 'No pending extension' });
  db.prepare(
    `UPDATE delegations SET extension_status='rejected',
       extension_reviewed_at=CURRENT_TIMESTAMP, extension_reviewed_by=?
     WHERE id=?`
  ).run(req.user.id, req.params.id);
  res.json({ message: 'Extension rejected' });
});

// Submit proof. Originally assignee-only; now admin and EA can submit on
// behalf of the assignee too — mam asked for this so her EA can upload
// proof for team members who send photos/PDFs over WhatsApp.
router.post('/:id/submit', (req, res) => {
  const { proof_url } = req.body;
  const db = getDb();
  const d = db.prepare('SELECT * FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
  const canSubmit = d.assigned_to === req.user.id || req.user.role === 'admin' || isEA(req.user.id);
  if (!canSubmit) {
    return res.status(403).json({ error: 'Only the assignee, admin or EA can submit proof' });
  }
  if (!proof_url) return res.status(400).json({ error: 'Proof file is required' });
  db.prepare(
    `UPDATE delegations SET status='submitted', proof_url=?, submitted_at=CURRENT_TIMESTAMP, reject_reason=NULL WHERE id=?`
  ).run(proof_url, req.params.id);
  res.json({ message: 'Proof submitted, awaiting approval' });
});

// Approve / reject — admin OR the PMS owner (EA = can_approve on delegations,
// e.g. Sushila / PMS Executive). Anyone can upload proof (assignee or EA);
// admin/PMS-owner checks + approves/rejects the task.
router.post('/:id/approve', (req, res) => {
  if (req.user.role !== 'admin' && !isEA(req.user.id)) return res.status(403).json({ error: 'Only an admin or PMS owner can approve tasks' });
  const db = getDb();
  const d = db.prepare('SELECT * FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
  if (d.status !== 'submitted') return res.status(400).json({ error: 'Task is not awaiting approval' });
  db.prepare(
    `UPDATE delegations SET status='approved', reviewed_at=CURRENT_TIMESTAMP, reviewer_id=? WHERE id=?`
  ).run(req.user.id, req.params.id);
  res.json({ message: 'Task approved' });
});

router.post('/:id/reject', (req, res) => {
  if (req.user.role !== 'admin' && !isEA(req.user.id)) return res.status(403).json({ error: 'Only an admin or PMS owner can reject tasks' });
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Rejection reason is required' });
  const db = getDb();
  const d = db.prepare('SELECT * FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
  db.prepare(
    `UPDATE delegations SET status='rejected', reject_reason=?, reviewed_at=CURRENT_TIMESTAMP, reviewer_id=? WHERE id=?`
  ).run(reason.trim(), req.user.id, req.params.id);
  res.json({ message: 'Task rejected, assignee notified' });
});

// Delete a delegation — only the assigner or an admin.
router.delete('/:id', (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT assigned_by FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
  if (d.assigned_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the assigner can delete' });
  }
  db.prepare('DELETE FROM delegations WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Dashboard stats for the current user — minimal payload for the homepage widgets.
router.get('/stats', (req, res) => {
  const db = getDb();
  const uid = req.user.id;
  const pending_mine = db.prepare(
    `SELECT COUNT(*) as c FROM delegations WHERE assigned_to=? AND status IN ('pending','rejected')`
  ).get(uid).c;
  const awaiting_approval = db.prepare(
    `SELECT COUNT(*) as c FROM delegations WHERE assigned_by=? AND status='submitted'`
  ).get(uid).c;
  const rejected_mine = db.prepare(
    `SELECT COUNT(*) as c FROM delegations WHERE assigned_to=? AND status='rejected'`
  ).get(uid).c;
  res.json({ pending_mine, awaiting_approval, rejected_mine });
});

module.exports = router;
