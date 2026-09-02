// deno-lint-ignore-file no-explicit-any
// HR — employees (+ shift history), checklists, induction digest, my-training.
// Ported from server/routes/hr.js (Phase-3 Postgres version) — ONLY the
// endpoints the salon UI uses. Candidates / recruitment / offer letters /
// hiring requests / JD / scorecards / manpower plan / notifications /
// screening / docs are intentionally NOT ported here.
import * as XLSX from "xlsx";
import { Router, upload } from "../../_shared/express-lite.ts";
import type { Handler } from "../../_shared/express-lite.ts";
import pg from "../../_shared/pg.ts";
import type { Db } from "../../_shared/pg.ts";
import { authMiddleware, requirePermission } from "../../_shared/auth.ts";
import { getShiftHistory } from "../../_shared/lib/shifts.ts";   // async: await getShiftHistory(pg, id)

const router = Router();
router.use(authMiddleware);

// Mam (2026-05-22): bulk Excel upload for checklists.  10MB cap so behaviour
// matches the PO/BOQ upload flow.  The file never touches disk here — it is
// parsed straight from the multipart buffer (req.file.buffer).
const CHECKLIST_EXCEL_MAX = 10 * 1024 * 1024;
const checklistsExcelUpload = upload;

// ── Candidate timeline helper (mam 2026-05-22 ATS spec) ─────────
// Every status-change / decision / tag-edit / hold-toggle calls this
// so the candidate detail view shows a chronological audit log
// without scattering INSERT statements through every route.
// Fails silently — a missing timeline row should NEVER block the
// underlying business action (the actual candidate update is what
// HR cares about).
export async function logEvent(db: Db, candidateId: any, eventType: string, opts: any = {}) {
  // db is either the root pg adapter or a transaction api (t). Inside a
  // Postgres transaction a failed statement poisons the whole tx, so when a
  // savepoint helper is available we run the insert under it — keeping the
  // original "fails silently, never blocks the business action" behaviour.
  const doInsert = () => db.run(
    `INSERT INTO candidate_events
       (candidate_id, event_type, from_status, to_status, note, user_id, user_name)
     VALUES (?,?,?,?,?,?,?)`,
    +candidateId,
    eventType,
    opts.from_status || null,
    opts.to_status   || null,
    opts.note        || null,
    opts.user_id     || null,
    opts.user_name   || null,
  );
  try {
    if (typeof db.savepoint === 'function') await db.savepoint(doInsert);
    else await doInsert();
  } catch (e) {
    console.warn('[hr/logEvent] failed:', (e as Error).message);
  }
}

// Duplicate-candidate finder — same email (case/space-insensitive) or same
// last-10-digit phone.  Returns an array of {id, name, status, created_at}
// the frontend can show in a warning dialog before letting admin save.
export async function findDuplicates(db: Db, { email, phone, excludeId }: any = {}) {
  const dups: any[] = [];
  const seen = new Set<number>();
  const push = (rows: any[]) => {
    for (const r of rows) {
      if (excludeId && r.id === +excludeId) continue;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      dups.push(r);
    }
  };
  if (email && String(email).trim()) {
    push(await db.all(
      `SELECT id, name, status, phone, email, position, created_at
         FROM candidates WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))`,
      email));
  }
  if (phone && String(phone).trim()) {
    const last10 = String(phone).replace(/\D/g, '').slice(-10);
    if (last10.length === 10) {
      push(await db.all(
        `SELECT id, name, status, phone, email, position, created_at
           FROM candidates
          WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'+',''),'(','') LIKE '%' || ? || '%'`,
        last10));
    }
  }
  return dups;
}

// Employees — salary is confidential; strip it from the response unless the
// requester is an admin or on the HR team (by role name or department).
// JWT only carries { id, role, name, email }, so we look up HR role + dept
// from the DB on each request. The DPR staff-cost endpoint works independently
// via a server-side aggregate, so non-HR users never see individual figures
// even if they are site engineers.
export const canSeeSalary = async (userId: number, userRole: string) => {
  if (userRole === 'admin') return true;
  const u = await pg.get('SELECT department FROM users WHERE id=?', userId);
  if (u?.department && String(u.department).toLowerCase().includes('hr')) return true;
  const roles = await pg.all(
    `SELECT r.name FROM user_roles ur JOIN roles r ON ur.role_id=r.id WHERE ur.user_id=?`,
    userId);
  return roles.some((r: any) => String(r.name || '').toLowerCase().includes('hr'));
};

// Helper — only admin / HR can approve or reject.  Hiring manager who
// raised the request CANNOT approve their own (separation of duties,
// same rule we enforce on Indent).
export async function isHrOrAdmin(req: any) {
  if (req.user.role === 'admin') return true;
  const u = await pg.get('SELECT department FROM users WHERE id=?', req.user.id);
  if (u?.department && String(u.department).toLowerCase().includes('hr')) return true;
  const roles = await pg.all(
    `SELECT r.name FROM user_roles ur JOIN roles r ON ur.role_id=r.id WHERE ur.user_id=?`,
    req.user.id);
  return roles.some((r: any) => String(r.name || '').toLowerCase().includes('hr'));
}

router.get('/employees', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await pg.all(
      `SELECT e.*, u.name as linked_user_name, u.username as linked_username,
              m1.name as reporting_manager_1_name, m2.name as reporting_manager_2_name,
              (SELECT shift_start FROM employee_shifts WHERE employee_id=e.id AND effective_from<=? ORDER BY effective_from DESC, id DESC LIMIT 1) as shift_start,
              (SELECT shift_end   FROM employee_shifts WHERE employee_id=e.id AND effective_from<=? ORDER BY effective_from DESC, id DESC LIMIT 1) as shift_end,
              (SELECT week_off_day FROM employee_shifts WHERE employee_id=e.id AND effective_from<=? ORDER BY effective_from DESC, id DESC LIMIT 1) as week_off_day
       FROM employees e
       LEFT JOIN users u ON u.id = e.user_id
       LEFT JOIN employees m1 ON m1.id = e.reporting_manager_id_1
       LEFT JOIN employees m2 ON m2.id = e.reporting_manager_id_2
       ORDER BY LOWER(e.name)`,
      today, today, today);
    if (await canSeeSalary(req.user.id, req.user.role)) return res.json(rows);
    // Redact salary for everyone else
    res.json(rows.map(({ salary: _salary, ...rest }: any) => rest));
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Shift/week-off history for one employee — GET to list, POST to add a new
// date-effective entry (never an UPDATE; see employee_shifts table comment
// in schema.js — this is what keeps past attendance from being
// retroactively reclassified when a shift or week-off day changes).
router.get('/employees/:id/shifts', async (req, res) => {
  try {
    res.json(await getShiftHistory(pg, +req.params.id));
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.post('/employees/:id/shifts', requirePermission('employees', 'edit'), async (req, res) => {
  try {
    const { effective_from, shift_start, shift_end, week_off_day } = req.body;
    if (!effective_from) return res.status(400).json({ error: 'Effective from date is required' });
    const emp = await pg.get('SELECT id FROM employees WHERE id=?', req.params.id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const r = await pg.run(
      `INSERT INTO employee_shifts (employee_id, effective_from, shift_start, shift_end, week_off_day, created_by)
       VALUES (?,?,?,?,?,?)`,
      req.params.id, effective_from, shift_start || null, shift_end || null,
      (week_off_day === '' || week_off_day == null) ? null : +week_off_day, req.user.id);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.post('/employees', requirePermission('employees', 'create'), async (req, res) => {
  try {
    const { name, phone, email, designation, department, join_date, salary,
            aadhar_file, pan_file, qualification_file,
            reporting_manager_id_1, reporting_manager_id_2 } = req.body;
    let { user_id } = req.body;
    // Auto-link by email if user_id wasn't explicitly set
    if (!user_id && email) {
      const u = await pg.get('SELECT id FROM users WHERE LOWER(email) = LOWER(?)', email);
      if (u) user_id = u.id;
    }
    // KYC docs (Aadhar/PAN/qualification) are optional — can be added later
    // from Edit once the employee has time to bring them in.
    const r = await pg.run(`
      INSERT INTO employees (user_id,name,phone,email,designation,department,join_date,salary,
                             aadhar_file, pan_file, qualification_file,
                             reporting_manager_id_1, reporting_manager_id_2)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, user_id || null, name, phone, email, designation, department, join_date, salary,
      aadhar_file || null, pan_file || null, qualification_file || null,
      reporting_manager_id_1 || null, reporting_manager_id_2 || null);
    res.status(201).json({ id: r.lastInsertRowid, linked_user_id: user_id || null });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Auto-link existing employees to users by matching email (case-insensitive).
// Safe to run any time — only fills rows where user_id IS NULL.
router.post('/employees/auto-link', requirePermission('employees', 'edit'), async (_req, res) => {
  try {
    const candidates = await pg.all(
      `SELECT e.id, u.id as user_id FROM employees e
       JOIN users u ON LOWER(u.email) = LOWER(e.email)
       WHERE e.user_id IS NULL AND e.email IS NOT NULL AND e.email != ''`
    );
    let linked = 0;
    for (const c of candidates) { await pg.run('UPDATE employees SET user_id = ? WHERE id = ?', c.user_id, c.id); linked++; }
    res.json({ linked, scanned: candidates.length });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Bulk import employees
router.post('/employees/bulk', requirePermission('employees', 'create'), async (req, res) => {
  try {
    const { employees } = req.body;
    if (!employees || !Array.isArray(employees) || employees.length === 0) {
      return res.status(400).json({ error: 'No employee data provided' });
    }
    const insertSql = 'INSERT INTO employees (name,phone,email,designation,department,join_date,salary) VALUES (?,?,?,?,?,?,?)';
    let added = 0; const errors: string[] = [];
    for (let i = 0; i < employees.length; i++) {
      const e = employees[i];
      if (!e.name || !e.name.trim()) { errors.push(`Row ${i + 1}: Name is required`); continue; }
      try {
        await pg.run(insertSql, e.name?.trim(), e.phone?.trim() || '', e.email?.trim() || '', e.designation?.trim() || '', e.department?.trim() || '', e.join_date || '', e.salary || 0);
        added++;
      } catch (err) { errors.push(`Row ${i + 1}: ${(err as Error).message}`); }
    }
    res.json({ added, errors, total: employees.length });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.put('/employees/:id', requirePermission('employees', 'edit'), async (req, res) => {
  try {
    const { name, phone, email, designation, department, salary, status, user_id,
            aadhar_file, pan_file, qualification_file,
            reporting_manager_id_1, reporting_manager_id_2 } = req.body;
    const empId = +req.params.id;
    const mgr1 = reporting_manager_id_1 ? +reporting_manager_id_1 : null;
    const mgr2 = reporting_manager_id_2 ? +reporting_manager_id_2 : null;
    if (mgr1 === empId || mgr2 === empId) {
      return res.status(400).json({ error: 'An employee cannot be their own reporting manager' });
    }
    // COALESCE so passing undefined for a doc field doesn't wipe the existing
    // upload — frontend can edit other fields without re-uploading docs.
    await pg.run(`
      UPDATE employees
         SET name=?, phone=?, email=?, designation=?, department=?, salary=?, status=?, user_id=?,
             aadhar_file        = COALESCE(?, aadhar_file),
             pan_file           = COALESCE(?, pan_file),
             qualification_file = COALESCE(?, qualification_file),
             reporting_manager_id_1 = ?,
             reporting_manager_id_2 = ?
       WHERE id=?
    `, name, phone, email, designation, department, salary, status, user_id || null,
      aadhar_file || null, pan_file || null, qualification_file || null,
      mgr1, mgr2, req.params.id);
    res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Delete an employee. Robust like the user delete (auth.js): a bare
// `DELETE FROM employees` used to throw an uncaught FOREIGN KEY error whenever
// the person had payroll or interview history — the admin just saw "Delete
// failed" / "FOREIGN KEY constraint failed" with no reason and no way forward
// (mam 2026-07-06: "not able to delete old employees"). Now:
//   • Payroll history → BLOCK (400) and tell them to deactivate — nulling or
//     deleting salary rows corrupts payroll (same rule as users + attendance).
//   • Interview / hiring links (interviewer, reporting-manager) → these are
//     nullable soft references; a normal delete surfaces a clear 409, and
//     ?force=1 unlinks them first, then deletes.
router.delete('/employees/:id', requirePermission('employees', 'delete'), async (req, res) => {
  try {
  const id = +req.params.id;
  // force=1 is an admin-only path — it rewrites other tables' references.
  const force = req.query.force === '1' && req.user.role === 'admin';
  const emp = await pg.get('SELECT id, name, status FROM employees WHERE id=?', id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  // Salary safety — an employee with ANY payroll history must never be
  // hard-deleted; deactivate (Status → inactive/terminated) instead so every
  // salary record stays intact. Blocks normal AND force delete.
  const payTotal =
    (await pg.get('SELECT COUNT(*) c FROM payroll_runs WHERE employee_id=?', id)).c +
    (await pg.get('SELECT COUNT(*) c FROM payroll_advances WHERE employee_id=?', id)).c;
  if (payTotal > 0) {
    return res.status(400).json({
      error: `"${emp.name}" has ${payTotal} salary/payroll record${payTotal === 1 ? '' : 's'} — deleting would break payroll. Set their Status to "inactive" or "terminated" instead (Edit → Status): all salary history stays intact and they drop off the active list.`,
      payroll_count: payTotal,
      suggest: 'deactivate',
    });
  }

  // Nullable interview/hiring links that FK-block the delete. Safe to unlink on
  // force (they only record "who interviewed / who was reporting manager").
  // training_assignments is ON DELETE CASCADE, so it clears itself.
  const SOFT_REFS: Array<[string, string]> = [
    ['candidates', 'interviewer_id'],
    ['hiring_requests', 'reporting_manager_id'],
    ['interview_scorecards', 'interviewer_id'],
  ];

  if (force) {
    try {
      const cleared: Record<string, number> = {};
      // Each soft-ref UPDATE runs under a savepoint — in Postgres a failed
      // statement would otherwise poison the whole transaction (SQLite let
      // the per-statement try/catch continue).
      await pg.tx(async (tx) => {
        for (const [t, c] of SOFT_REFS) {
          try {
            await tx.savepoint(async () => {
              const r = await tx.run(`UPDATE "${t}" SET "${c}"=NULL WHERE "${c}"=?`, id);
              if (r.changes > 0) cleared[`${t}.${c}`] = r.changes;
            });
          } catch (e) { console.warn('[emp-delete] could not clear', `${t}.${c}`, '-', (e as Error).message); }
        }
        await tx.run('DELETE FROM employees WHERE id=?', id);
      });
      return res.json({ message: `Employee "${emp.name}" force-deleted`, cleared });
    } catch (e) {
      console.error('[emp-delete force] failed:', (e as Error).message);
      return res.status(500).json({ error: `Force-delete failed: ${(e as Error).message}` });
    }
  }

  try {
    await pg.run('DELETE FROM employees WHERE id=?', id);
    res.json({ message: 'Deleted' });
  } catch (_e) {
    let refCount = 0;
    for (const [t, c] of SOFT_REFS) {
      try { refCount += (await pg.get(`SELECT COUNT(*) c FROM "${t}" WHERE "${c}"=?`, id)).c; } catch { /* ignore */ }
    }
    res.status(409).json({
      error: `Delete blocked: "${emp.name}" is still linked to ${refCount || 'other'} interview/hiring record${refCount === 1 ? '' : 's'}.`,
      reference_count: refCount,
      hint: 'Force Delete unlinks those (interviewer / reporting-manager) then deletes. Or set Status to inactive/terminated to keep the record.',
    });
  }
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Checklists
// List checklists. Admin sees all; regular users see only the ones assigned
// to them so they don't read each other's tasks. Ordered by assignee name
// so the frontend can group the rows under each person.
router.get('/checklists', async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const base = `SELECT c.*, u1.name as assigned_to_name, u2.name as created_by_name
      FROM checklists c
      LEFT JOIN users u1 ON c.assigned_to=u1.id
      LEFT JOIN users u2 ON c.created_by=u2.id`;
    const order = ` ORDER BY LOWER(u1.name), c.frequency, c.due_time, c.created_at DESC`;
    if (isAdmin) {
      res.json(await pg.all(base + order));
    } else {
      res.json(await pg.all(base + ' WHERE c.assigned_to=?' + order, req.user.id));
    }
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Title is derived from the first line (80 chars) of the description since
// the UI no longer asks for it separately.
const deriveTitle = (title: any, description: any) => {
  if (title && title.trim()) return title.trim();
  const d = String(description || '').trim();
  return d.split(/\r?\n/)[0].slice(0, 80).trim() || 'Checklist';
};

// Only admins can create / edit / delete checklists. Regular users can read
// and complete (upload proof for) the ones assigned to them.
const _adminGuard: Handler = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can manage checklists' });
  next();
};

// Mam (2026-05-22): proof_type values accepted by POST + PUT.
// Default 'photo' keeps existing rows working (column default).
const ALLOWED_PROOF_TYPES = ['photo', 'pdf', 'file', 'text', 'none'];

// ═════════════════════════════════════════════════════════════════
// Bulk Excel upload for checklists (mam 2026-05-22)
// ═════════════════════════════════════════════════════════════════
// Admin uploads an .xlsx with one row per task.  Recognised columns
// (case-insensitive, in any order, any subset):
//
//   Description / Task             — required, the task text
//   Proof Name / Label             — optional friendly name
//   Proof Type                     — optional; photo/pdf/file/text/none
//
// We return the parsed rows as JSON so the client can stuff them into
// the Bulk Add modal's textarea (formatted as "Task | Label | Type")
// for the admin to review + tweak + submit via the existing
// /checklists/bulk endpoint.  No DB writes here.

// Download a sample template the admin can fill in.
router.get('/checklists/bulk-template.xlsx', (_req, res) => {
  const wb = XLSX.utils.book_new();
  const aoa = [
    ['Description',                                'Proof Name',          'Proof Type', 'Time'],
    ['File monthly GST return',                    'GST File',            'pdf',        '11:00'],
    ['Daily attendance + no-show alerts',          'Attendance Report',   'photo',      '10:30'],
    ['Exit checklist + Day-1 joiner verification', 'Joining Form',        'pdf',        '17:00'],
    ['Send daily WhatsApp report to MD',           'Screenshot',          'photo',      '18:00'],
    ['Reconcile petty cash closing',               'Cash Closing Note',   'text',       '19:30'],
    // Mam (2026-05-22): comma-separated times = one row per slot.
    ['Stock recon + items below ROL',              'Stock Photo',         'photo',      '09:00,13:00,17:00'],
    ['Mark vendor master sheet reviewed',          '',                    'none',       ''],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 50 }, { wch: 24 }, { wch: 12 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Checklists');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="checklists-bulk-template.xlsx"');
  res.send(new Uint8Array(buf));
});

// Parse an uploaded .xlsx and return the rows as JSON.
// (Client decides whether to commit them via /checklists/bulk.)
router.post('/checklists/parse-excel', checklistsExcelUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (req.file.size > CHECKLIST_EXCEL_MAX) return res.status(400).json({ error: 'File too large (max 10MB)' });
  let wb: XLSX.WorkBook;
  try { wb = XLSX.read(req.file.buffer, { type: 'array' }); }
  catch (e) {
    return res.status(400).json({ error: 'Could not read the Excel file: ' + (e as Error).message });
  }
  // (No temp file to clean up — the upload was parsed in memory.)
  const cleanup = () => { /* no-op: in-memory parse */ };

  const sheetName = wb.SheetNames[0];
  if (!sheetName) { cleanup(); return res.status(400).json({ error: 'Excel file has no sheets' }); }
  const ws = wb.Sheets[sheetName];
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (rows.length === 0) { cleanup(); return res.status(400).json({ error: 'Sheet is empty' }); }

  // ── Locate the header row.  Most files put it on row 1, but some
  // people leave 1-2 blank lines or a title at the top.  Scan the
  // first 5 rows for any keyword we know how to map.
  const HEADER_KEYWORDS = ['description', 'task', 'proof name', 'proof', 'name', 'label', 'type', 'proof type', 'time', 'time of day', 'due time'];
  let headerIdx = -1;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const cells = (rows[i] || []).map((c: any) => String(c || '').toLowerCase().trim());
    const matches = HEADER_KEYWORDS.filter(k => cells.some((c: string) => c === k || c.includes(k))).length;
    if (matches >= 1) { headerIdx = i; break; }
  }
  // If no headers, treat row 0 as data with column order [desc, label, type, time]
  let descCol = 0, labelCol = 1, typeCol = 2, timeCol = 3;
  if (headerIdx >= 0) {
    const headers = (rows[headerIdx] || []).map((c: any) => String(c || '').toLowerCase().trim());
    const findCol = (...keys: string[]) => headers.findIndex((h: string) => keys.some(k => h === k || h.includes(k)));
    const di = findCol('description', 'task');
    const li = findCol('proof name', 'label');
    const ti = findCol('proof type', 'type');
    const tmi = findCol('time of day', 'due time', 'time');
    if (di >= 0) descCol = di;
    if (li >= 0) labelCol = li; else labelCol = -1;
    if (ti >= 0) typeCol = ti; else typeCol = -1;
    if (tmi >= 0) timeCol = tmi; else timeCol = -1;
  } else {
    headerIdx = -1;  // start reading from row 0
  }

  // Excel stores time-of-day cells as fractional Date numbers (0.5 =
  // noon) when the user formats the cell as Time.  Convert to HH:MM
  // 24h.  Also accept plain strings ("14:30", "2:30 PM") and pre-
  // formatted Excel strings like "14:30:00".
  const formatExcelTime = (v: any) => {
    if (v == null || v === '') return '';
    if (typeof v === 'number') {
      // Fractional part = time of day; ignore integer part (date)
      const frac = v - Math.floor(v);
      const totalMins = Math.round(frac * 24 * 60);
      const h = Math.floor(totalMins / 60) % 24;
      const m = totalMins % 60;
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
    }
    return String(v).trim();
  };

  const dataStart = headerIdx >= 0 ? headerIdx + 1 : 0;
  const parsed: any[] = [];
  const seen = new Set<string>();
  for (let i = dataStart; i < rows.length; i++) {
    const row = rows[i] || [];
    const description = String(row[descCol] || '').trim();
    if (!description) continue;
    const key = description.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const proof_label = labelCol >= 0 ? String(row[labelCol] || '').trim() || null : null;
    const rawType = typeCol >= 0 ? String(row[typeCol] || '').trim().toLowerCase() : '';
    const proof_type = ALLOWED_PROOF_TYPES.includes(rawType) ? rawType : null;
    const due_time = timeCol >= 0 ? formatExcelTime(row[timeCol]) || null : null;
    parsed.push({ description, proof_label, proof_type, due_time });
  }

  cleanup();
  if (parsed.length === 0) {
    return res.status(400).json({ error: 'No task rows found in the file. The first column should contain task descriptions.' });
  }
  res.json({
    ok: true,
    sheet: sheetName,
    header_row: headerIdx >= 0 ? headerIdx + 1 : null,
    rows: parsed,
    count: parsed.length,
  });
});

// Mam (2026-05-22): normalise fortnight_days CSV input.
// Accepts "5,20" / "5 & 20" / "5;20" / [5,20] — outputs canonical
// "5,20".  Empty / invalid → null (server falls back to "1,15"
// inside applies()).
function normaliseFortnightDays(v: any): string | null {
  if (!v) return null;
  const arr = (Array.isArray(v) ? v : String(v).split(/[,;|&]| and /i))
    .map((s: any) => parseInt(String(s).trim(), 10))
    .filter((n: number) => Number.isFinite(n) && n >= 1 && n <= 31);
  if (arr.length === 0) return null;
  // Dedupe + sort + cap at 2 (it's FORTnightly, not weekly).
  return [...new Set(arr)].sort((a, b) => a - b).slice(0, 2).join(',');
}

router.post('/checklists', requirePermission('checklists', 'create'), async (req, res) => {
  try {
    const { title, description, frequency, due_date, due_time, assigned_to, department,
            recurrence_start_date, recurrence_end_date, proof_type, proof_label,
            fortnight_days } = req.body;
    const t = deriveTitle(title, description);
    const desc = String(description || '').trim();
    if (!desc && !title) return res.status(400).json({ error: 'Description is required' });
    if (!assigned_to) return res.status(400).json({ error: 'Assigned To is required' });
    // Mam (2026-05-22): if the caller didn't supply a department, fall
    // back to the assignee's own users.department so the row is
    // automatically tagged with the right team.
    let dept = department && String(department).trim() ? String(department).trim() : null;
    if (!dept) {
      try {
        const u = await pg.get('SELECT department FROM users WHERE id=?', assigned_to);
        dept = u?.department || null;
      } catch { /* ignore */ }
    }
    const pt = ALLOWED_PROOF_TYPES.includes(proof_type) ? proof_type : 'photo';
    const pl = proof_label && String(proof_label).trim() ? String(proof_label).trim() : null;
    const fd = frequency === 'fortnightly' ? (normaliseFortnightDays(fortnight_days) || '1,15') : null;
    const r = await pg.run(
      `INSERT INTO checklists
         (title, description, frequency, due_date, due_time, assigned_to, department,
          recurrence_start_date, recurrence_end_date, proof_type, proof_label, fortnight_days, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      t, desc, frequency, due_date, due_time || null, assigned_to, dept,
      recurrence_start_date || null, recurrence_end_date || null, pt, pl, fd, req.user.id);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Mam (2026-05-22): "give me checklist bulk" — admin pastes many
// task lines at once, all sharing the same frequency / assignee /
// dept / dates / proof_type.  Reduces 30 single-task adds down to
// one form fill.
router.post('/checklists/bulk', requirePermission('checklists', 'create'), async (req, res) => {
  try {
  const { tasks, frequency, due_date, due_time, assigned_to, assigned_to_ids, department,
          recurrence_start_date, recurrence_end_date, proof_type, proof_label,
          fortnight_days } = req.body || {};
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return res.status(400).json({ error: 'tasks array required' });
  }
  // Mam (2026-05-22): "multiple name mean assign one or multiple
  // user one time" — accept either an array (new shape) or a
  // single id (legacy).  Normalise into one array.
  const assigneeIds: number[] = Array.isArray(assigned_to_ids) && assigned_to_ids.length
    ? assigned_to_ids.map((x: any) => +x).filter(Boolean)
    : (assigned_to ? [+assigned_to] : []);
  if (assigneeIds.length === 0) return res.status(400).json({ error: 'At least one assignee is required' });

  // Department auto-fill — if not explicitly set, take it from the
  // FIRST picked user.  All N tasks × M users get the same dept tag.
  let dept = department && String(department).trim() ? String(department).trim() : null;
  if (!dept) {
    try {
      const u = await pg.get('SELECT department FROM users WHERE id=?', assigneeIds[0]);
      dept = u?.department || null;
    } catch { /* ignore */ }
  }
  const defaultPt = ALLOWED_PROOF_TYPES.includes(proof_type) ? proof_type : 'photo';
  const defaultPl = proof_label && String(proof_label).trim() ? String(proof_label).trim() : null;

  // Mam (2026-05-22): per-line overrides via pipe or tab separator:
  //   Pay GST           | GST File       | pdf | 10:00
  //   Reconcile cash    | Bank Statement | pdf
  //   Take site photo                               | 17:30
  // Column 1 = description (required)
  // Column 2 = proof_label override (optional — falls back to shared)
  // Column 3 = proof_type override  (optional, must be in whitelist)
  // Column 4 = due_time override    (optional, HH:MM 24h; falls back to shared)
  // Lines with NO separator just use the shared bulk settings.
  const normaliseTime = (s: any): string | null => {
    if (!s) return null;
    const t = String(s).trim();
    // Accept HH:MM 24h, H:MM AM/PM, and Excel's HH:MM:SS (drop seconds).
    let m: RegExpMatchArray | null;
    if ((m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*$/))) {
      const h = +m[1], mn = +m[2];
      if (h >= 0 && h <= 23 && mn >= 0 && mn <= 59) return `${String(h).padStart(2,'0')}:${String(mn).padStart(2,'0')}`;
    }
    if ((m = t.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i))) {
      let h = +m[1]; const mn = +m[2]; const ap = m[3].toLowerCase();
      if (h === 12) h = 0;
      if (ap === 'pm') h += 12;
      if (h >= 0 && h <= 23 && mn >= 0 && mn <= 59) return `${String(h).padStart(2,'0')}:${String(mn).padStart(2,'0')}`;
    }
    return null;
  };
  const defaultDueTime = due_time && normaliseTime(due_time);

  const rows: any[] = [];
  const seen = new Set<string>();
  for (const raw of tasks) {
    if (raw == null) continue;
    const line = String(raw).trim();
    if (!line) continue;
    // Split on tab OR pipe (Excel paste vs typed-in syntax)
    const parts = line.split(/\s*[|\t]\s*/);
    const description = parts[0]?.trim();
    if (!description) continue;
    const dupKey = description.toLowerCase();
    if (seen.has(dupKey)) continue;
    seen.add(dupKey);
    const rowLabel = parts[1] && parts[1].trim() ? parts[1].trim() : defaultPl;
    const rawType = parts[2] && parts[2].trim().toLowerCase();
    const rowType = rawType && ALLOWED_PROOF_TYPES.includes(rawType) ? rawType : defaultPt;
    // Mam (2026-05-22): "can add multiple time names also" — the
    // Time column accepts a comma-separated list (09:00, 13:00,
    // 17:00) which expands into one checklist row per time.  Useful
    // for tasks that fire multiple times per day at fixed slots
    // (attendance checks, stock recon, etc.).
    let rowTimes: Array<string | null> = [];
    if (parts[3] && /[,;]/.test(parts[3])) {
      rowTimes = parts[3]
        .split(/[,;]/)
        .map(t => normaliseTime(t))
        .filter(Boolean);
    } else {
      const single = normaliseTime(parts[3]) || defaultDueTime || null;
      rowTimes = [single];
    }
    // Emit one row per time slot.  Description gets an "@ HH:MM"
    // suffix when more than one slot so the rows don't collapse
    // into duplicates of each other in the dedup set.
    for (const t of rowTimes) {
      const desc = rowTimes.length > 1 && t
        ? `${description} @ ${t}`
        : description;
      rows.push({ description: desc, proof_label: rowLabel, proof_type: rowType, due_time: t });
    }
  }
  if (rows.length === 0) return res.status(400).json({ error: 'All task lines were empty' });

  // Mam (2026-05-22): fortnight_days defaults to "1,15" when frequency
  // is fortnightly AND admin didn't pick days.  Same for every task
  // in the batch.
  const fdBulk = frequency === 'fortnightly'
    ? (normaliseFortnightDays(fortnight_days) || '1,15')
    : null;
  const insSql = `INSERT INTO checklists
      (title, description, frequency, due_date, due_time, assigned_to, department,
       recurrence_start_date, recurrence_end_date, proof_type, proof_label, fortnight_days, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`;

  // Mam (2026-05-22): emit one INSERT per (task × assignee) so a
  // batch of 3 tasks × 2 users creates 6 rows in a single atomic tx.
  const added = await pg.tx(async (t) => {
    let added = 0;
    for (const r of rows) {
      const title = deriveTitle(null, r.description);
      for (const uid of assigneeIds) {
        await t.run(insSql, title, r.description, frequency || 'monthly', due_date || null,
                r.due_time || null,
                uid, dept,
                recurrence_start_date || null, recurrence_end_date || null,
                r.proof_type, r.proof_label, fdBulk, req.user.id);
        added++;
      }
    }
    return added;
  });
  res.status(201).json({ added, total: rows.length });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.put('/checklists/:id', requirePermission('checklists', 'edit'), async (req, res) => {
  try {
  const { status, title, description, frequency, due_date, due_time, assigned_to, department,
          recurrence_start_date, recurrence_end_date, proof_type, proof_label,
          fortnight_days } = req.body;
  const t = deriveTitle(title, description);
  if (!assigned_to) return res.status(400).json({ error: 'Assigned To is required' });
  let dept = department && String(department).trim() ? String(department).trim() : null;
  if (!dept) {
    try {
      const u = await pg.get('SELECT department FROM users WHERE id=?', assigned_to);
      dept = u?.department || null;
    } catch { /* ignore */ }
  }
  const pt = ALLOWED_PROOF_TYPES.includes(proof_type) ? proof_type : null;
  // proof_label uses COALESCE-like behaviour: passing undefined keeps
  // existing; passing '' clears it; passing a string sets/replaces.
  const pl = proof_label === undefined ? null
           : proof_label && String(proof_label).trim() ? String(proof_label).trim()
           : '';
  // Same COALESCE-vs-empty trick for fortnight_days as proof_label
  // so passing '' clears, undefined keeps existing, value sets.
  const fdEdit = fortnight_days === undefined ? null
              : fortnight_days && normaliseFortnightDays(fortnight_days)
                ? normaliseFortnightDays(fortnight_days)
                : '';
  // ?::text casts — Postgres can't infer a parameter's type from a bare
  // "? IS NULL" check the way SQLite could.
  await pg.run(
    `UPDATE checklists SET status=?, title=?, description=?, frequency=?, due_date=?, due_time=?,
       assigned_to=?, department=?, recurrence_start_date=?, recurrence_end_date=?,
       proof_type = COALESCE(?, proof_type),
       proof_label = CASE WHEN ?::text IS NULL THEN proof_label
                          WHEN ? = '' THEN NULL
                          ELSE ? END,
       fortnight_days = CASE WHEN ?::text IS NULL THEN fortnight_days
                             WHEN ? = '' THEN NULL
                             ELSE ? END
     WHERE id=?`,
    status, t, description, frequency, due_date, due_time || null, assigned_to, dept,
    recurrence_start_date || null, recurrence_end_date || null, pt,
    pl, pl, pl,
    fdEdit, fdEdit, fdEdit,
    req.params.id);
  res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.delete('/checklists/:id', requirePermission('checklists', 'delete'), async (req, res) => {
  try {
    await pg.run('DELETE FROM checklists WHERE id=?', req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Today's checklists for the logged-in user — used by the dashboard widget.
// Returns active checklists that are due today based on frequency:
//   daily       → every day
//   weekly      → same weekday as the checklist's due_date
//   monthly     → same day-of-month as the checklist's due_date
//   quarterly   → once every 3 months on the due_date's day
//   yearly      → same month-and-day as the due_date
//   once        → exact due_date match
// Each entry is joined with today's completion row (if any) so the UI knows
// whether proof has been uploaded.
router.get('/checklists/my-today', async (req, res) => {
  try {
  const today = new Date().toISOString().split('T')[0];
  const d = new Date(today + 'T00:00:00');
  const todayDow = d.getDay();            // 0..6
  const todayDom = d.getDate();           // 1..31
  const todayMonth = d.getMonth() + 1;    // 1..12

  const uid = req.user.id;

  // Pull checklists assigned to this user OR unassigned (applies to everyone)
  const rows = await pg.all(
    `SELECT c.*, cc.id as completion_id, cc.proof_url, cc.submitted_at, cc.notes
     FROM checklists c
     LEFT JOIN checklist_completions cc
       ON cc.checklist_id = c.id AND cc.user_id = ? AND cc.completion_date = ?
     WHERE (c.assigned_to = ? OR c.assigned_to IS NULL)
       AND (c.status IS NULL OR c.status = 'pending' OR c.status = 'active' OR c.status = '')`,
    uid, today, uid);

  const out = rows.filter((c: any) => {
    const f = String(c.frequency || '').toLowerCase();
    if (!c.due_date && f !== 'daily') return f === 'daily';
    const due = c.due_date ? new Date(c.due_date + 'T00:00:00') : null;
    if (f === 'daily') return true;
    if (f === 'weekly') return due && due.getDay() === todayDow;
    if (f === 'monthly') return due && due.getDate() === todayDom;
    if (f === 'quarterly') {
      if (!due) return false;
      const monthDiff = (todayMonth - (due.getMonth() + 1) + 12) % 3;
      return monthDiff === 0 && due.getDate() === todayDom;
    }
    if (f === 'yearly') return due && due.getMonth() + 1 === todayMonth && due.getDate() === todayDom;
    if (f === 'once') return c.due_date === today;
    return false;
  });

  res.json(out);
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Approval columns — mam (2026-05-16): "after need to approval".
// approval_status defaults to 'pending' so every new completion shows up in
// the admin's approval queue.  (The idempotent SQLite ALTERs that used to
// live here are gone — the migrated Postgres schema already has
// approval_status / approved_by / approved_at / approval_note.)

// Mark a checklist as done for a given date (with optional proof_url
// + notes).  Mam (2026-05-22): users need to back-date submissions
// — e.g. upload Monday morning the proof for the Saturday daily
// task.  Optional body.completion_date defaults to today; admin can
// always back-date, non-admins are clamped to the task's recurrence
// window so they can't fabricate completions for days the task
// didn't even apply.
//
// Uses UPSERT so re-submitting overwrites the proof.  Resets the
// approval status to 'pending' on re-submit so the admin re-reviews.
router.post('/checklists/:id/complete', async (req, res) => {
  try {
  const { proof_url, notes } = req.body;
  const date = req.body.completion_date && String(req.body.completion_date).trim()
    ? String(req.body.completion_date).trim().slice(0, 10)
    : new Date().toISOString().split('T')[0];

  const c = await pg.get('SELECT * FROM checklists WHERE id=?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Checklist not found' });

  // Non-admin clamp: must be inside the recurrence window if one is set.
  if (req.user.role !== 'admin') {
    if (c.recurrence_start_date && date < c.recurrence_start_date) {
      return res.status(400).json({ error: 'Date is before this task\'s Start Date' });
    }
    if (c.recurrence_end_date && date > c.recurrence_end_date) {
      return res.status(400).json({ error: 'Date is after this task\'s End Date' });
    }
  }

  // Mam (2026-05-22): enforce proof_type on completion so admins can
  // trust that whoever marked it done actually attached what was asked.
  const pt = c.proof_type || 'photo';
  if (pt === 'text' && (!notes || !String(notes).trim())) {
    return res.status(400).json({ error: 'This checklist needs a text note to complete' });
  }
  if (['photo','pdf','file'].includes(pt) && !proof_url) {
    return res.status(400).json({ error: `This checklist needs a ${pt === 'photo' ? 'photo' : pt === 'pdf' ? 'PDF' : 'file'} attached to complete` });
  }
  // pt === 'none' → no requirement (just mark done)

  await pg.run(
    `INSERT INTO checklist_completions (checklist_id, user_id, completion_date, proof_url, notes, approval_status)
     VALUES (?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(checklist_id, user_id, completion_date) DO UPDATE SET
       proof_url = excluded.proof_url,
       notes = excluded.notes,
       submitted_at = CURRENT_TIMESTAMP,
       approval_status = 'pending',
       approved_by = NULL, approved_at = NULL, approval_note = NULL`,
    req.params.id, req.user.id, date, proof_url || null, notes || null);
  res.json({ message: `Checklist marked complete for ${date} — pending admin approval`, date });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// ── GET /hr/checklists/by-date?date=YYYY-MM-DD ──────────────────
// Mam (2026-05-16): "where i can check as per daily and previous
// check list done or not done".  Returns every checklist active
// on that date with its completion status (if any), proof URL,
// and approval status.  Admin sees all; non-admin sees only their
// own assignments.
router.get('/checklists/by-date', async (req, res) => {
  try {
  const date: string = req.query.date || new Date().toISOString().slice(0, 10);
  let canManage = req.user.role === 'admin';
  if (!canManage) {
    const _cp = await pg.get("SELECT rp.can_see_all, rp.can_edit, rp.can_create FROM role_permissions rp JOIN user_roles ur ON rp.role_id = ur.role_id WHERE ur.user_id = ? AND rp.module = 'checklists'", req.user.id);
    canManage = !!(_cp && (_cp.can_see_all || _cp.can_edit || _cp.can_create));
  }
  const scope = canManage ? '' : 'AND c.assigned_to = ?';
  // Build args in the exact order placeholders appear in the SQL.
  // Was previously buggy (legacy `params = [date]` was duplicating the
  // first arg → "Too many parameter values were provided").  Mam saw
  // the error after the recurrence-window fields were added.
  const args: any[] = [date];                   // for the JOIN ON ... = ?
  if (!canManage) args.push(req.user.id);         // for the scope ... = ?
  args.push(date, date);                        // start ≤ ? and end ≥ ?

  const rows = await pg.all(`
    SELECT c.id, c.description, c.title, c.frequency, c.due_date, c.due_time,
           c.department, c.recurrence_start_date, c.recurrence_end_date,
           c.fortnight_days,
           c.assigned_to, u.name as assigned_to_name,
           comp.id as completion_id,
           comp.proof_url, comp.notes, comp.submitted_at,
           comp.approval_status, comp.approved_at, comp.approval_note,
           au.name as approved_by_name
    FROM checklists c
    LEFT JOIN users u  ON c.assigned_to = u.id
    LEFT JOIN checklist_completions comp
      ON comp.checklist_id = c.id AND comp.user_id = c.assigned_to AND comp.completion_date = ?
    LEFT JOIN users au ON comp.approved_by = au.id
    WHERE 1=1 ${scope}
      AND (c.recurrence_start_date IS NULL OR c.recurrence_start_date <= ?)
      AND (c.recurrence_end_date   IS NULL OR c.recurrence_end_date   >= ?)
    ORDER BY u.name, c.department, c.description
  `, ...args);
  // Mam (2026-05-22): post-filter so each frequency only fires on its
  // intended day(s).  Uses due_date as the recurrence anchor for
  // monthly / quarterly / yearly — matches the followup's applies()
  // logic so by-date + followup stay in sync.
  const todayDate = new Date(date + 'T00:00:00');
  const dom = todayDate.getDate();
  const filtered = rows.filter((r: any) => {
    const f = String(r.frequency || '').toLowerCase();
    if (f === 'fortnightly') {
      const csv = r.fortnight_days && String(r.fortnight_days).trim() ? r.fortnight_days : '1,15';
      const days = csv.split(/[,;|]/).map((s: string) => parseInt(String(s).trim(), 10)).filter((d: number) => d >= 1 && d <= 31);
      return days.includes(dom);
    }
    if (!r.due_date) return true;                  // legacy: keep generous
    const due = new Date(String(r.due_date).slice(0, 10) + 'T00:00:00');
    if (f === 'monthly')   return dom === due.getDate();
    if (f === 'quarterly') {
      if (dom !== due.getDate()) return false;
      const diff = ((todayDate.getMonth() - due.getMonth()) % 3 + 3) % 3;
      return diff === 0;
    }
    if (f === 'yearly') return todayDate.getMonth() === due.getMonth() && dom === due.getDate();
    if (f === 'once')   return String(r.due_date).slice(0, 10) === date;
    return true;                                    // daily / weekly / unknown
  });
  res.json({ date, rows: filtered });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// ── GET /hr/checklists/followup?back=7&forward=7 ────────────────
// Mam (2026-05-22): "i need followup checklist where all record
// mention previous, present, future".  Returns one row per checklist
// task with a horizontal timeline of dates (back N → today → forward
// N).  Each cell carries the status for that date:
//   'done_approved' | 'done_pending' | 'done_rejected'
//   'missed'  (past + frequency-applicable + no completion)
//   'today'   (current day, no completion yet)
//   'future'  (upcoming + frequency-applicable)
//   'na'      (frequency says this task doesn't apply on that date)
router.get('/checklists/followup', async (req, res) => {
  try {
  const back = Math.min(30, Math.max(0, parseInt(req.query.back || '7', 10)));
  const forward = Math.min(30, Math.max(0, parseInt(req.query.forward || '7', 10)));
  let isAdmin = req.user.role === 'admin';
  if (!isAdmin) { const _cp = await pg.get("SELECT rp.can_see_all, rp.can_edit, rp.can_create FROM role_permissions rp JOIN user_roles ur ON rp.role_id = ur.role_id WHERE ur.user_id = ? AND rp.module = 'checklists'", req.user.id); isAdmin = !!(_cp && (_cp.can_see_all || _cp.can_edit || _cp.can_create)); }

  // Build the date window (ISO YYYY-MM-DD strings, IST).
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dates: string[] = [];
  for (let i = -back; i <= forward; i += 1) {
    const d = new Date(today); d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const fromDate = dates[0];
  const toDate = dates[dates.length - 1];

  // Pull the candidate task list (admin sees all, others only their own).
  const taskSql = isAdmin
    ? `SELECT c.id, c.description, c.title, c.frequency, c.due_date, c.due_time,
              c.department, c.assigned_to, u.name AS assigned_to_name,
              c.recurrence_start_date, c.recurrence_end_date, c.fortnight_days
       FROM checklists c LEFT JOIN users u ON c.assigned_to = u.id
       ORDER BY LOWER(u.name), c.department, c.description`
    : `SELECT c.id, c.description, c.title, c.frequency, c.due_date, c.due_time,
              c.department, c.assigned_to, u.name AS assigned_to_name,
              c.recurrence_start_date, c.recurrence_end_date, c.fortnight_days
       FROM checklists c LEFT JOIN users u ON c.assigned_to = u.id
       WHERE c.assigned_to = ?
       ORDER BY c.department, c.description`;
  const tasks = isAdmin ? await pg.all(taskSql) : await pg.all(taskSql, req.user.id);

  // Pull ALL completions in the window (one query, then bucket
  // client-side by checklist_id + date).
  const compRows = await pg.all(`
    SELECT checklist_id, user_id, completion_date, proof_url,
           approval_status, submitted_at
    FROM checklist_completions
    WHERE completion_date BETWEEN ? AND ?
  `, fromDate, toDate);
  const compMap: Record<string, any> = {};
  for (const r of compRows) {
    compMap[`${r.checklist_id}::${r.completion_date}`] = r;
  }

  // Frequency → "does this date apply to this task?" helper.  Now
  // also respects mam's (2026-05-22) start/end recurrence window:
  // out-of-window dates ALWAYS return false so the cell renders as
  // N/A in the grid and doesn't count as "missed".
  function applies(task: any, dateStr: string): boolean {
    if (task.recurrence_start_date && dateStr < task.recurrence_start_date) return false;
    if (task.recurrence_end_date   && dateStr > task.recurrence_end_date)   return false;
    if (!task.frequency) return true;
    const f = task.frequency.toLowerCase();
    if (f === 'daily') return true;
    if (f === 'weekly') {
      if (!task.due_date) return true;
      return new Date(task.due_date).getDay() === new Date(dateStr).getDay();
    }
    // Mam (2026-05-22): fortnightly = twice a month on the two day-of-
    // month slots stored in fortnight_days ("5,20"; default "1,15").
    // Cell is "applicable" only when the date's day-of-month matches.
    if (f === 'fortnightly') {
      const csv = task.fortnight_days && String(task.fortnight_days).trim()
        ? task.fortnight_days : '1,15';
      const days = csv.split(/[,;|]/).map((s: string) => parseInt(String(s).trim(), 10)).filter((d: number) => d >= 1 && d <= 31);
      if (days.length === 0) return false;
      const dom = new Date(dateStr + 'T00:00:00').getDate();
      return days.includes(dom);
    }
    // Mam (2026-05-22): "if here is month then you dont think selection
    // of month if quartly" — use due_date as the recurrence anchor:
    //   monthly   → fires on same DAY-of-MONTH as due_date, every month
    //   quarterly → fires on same DAY-of-MONTH AND every 3rd month
    //               offset from the due_date month
    //   yearly    → fires on same MONTH + DAY as due_date, every year
    // No due_date set → legacy generous behaviour (matches any day) so
    // existing rows don't suddenly disappear from the grid.
    const d = new Date(dateStr + 'T00:00:00');
    const dueIso = task.due_date ? String(task.due_date).slice(0, 10) : null;
    if (f === 'monthly') {
      if (!dueIso) return true;     // legacy: keep generous
      return d.getDate() === new Date(dueIso + 'T00:00:00').getDate();
    }
    if (f === 'quarterly') {
      if (!dueIso) return true;
      const due = new Date(dueIso + 'T00:00:00');
      if (d.getDate() !== due.getDate()) return false;
      // Same month-of-quarter: (d.month - due.month) divisible by 3
      const diff = ((d.getMonth() - due.getMonth()) % 3 + 3) % 3;
      return diff === 0;
    }
    if (f === 'yearly') {
      if (!dueIso) return true;
      const due = new Date(dueIso + 'T00:00:00');
      return d.getMonth() === due.getMonth() && d.getDate() === due.getDate();
    }
    if (f === 'once') {
      if (!dueIso) return true;
      return dueIso === dateStr;
    }
    return true;
  }

  const rows = tasks.map((t: any) => {
    const cells = dates.map(d => {
      const comp = compMap[`${t.id}::${d}`];
      const isPast   = d < dates[back];
      const isToday  = d === dates[back];
      const inScope  = applies(t, d);
      let status: string;
      if (!inScope) status = 'na';
      else if (comp) {
        if (comp.approval_status === 'approved')      status = 'done_approved';
        else if (comp.approval_status === 'rejected') status = 'done_rejected';
        else                                          status = 'done_pending';
      } else if (isPast)  status = 'missed';
      else if (isToday)   status = 'today';
      else                status = 'future';
      return { date: d, status, proof_url: comp?.proof_url || null, submitted_at: comp?.submitted_at || null };
    });
    return {
      id: t.id,
      description: t.description || t.title,
      frequency: t.frequency,
      department: t.department,
      assigned_to: t.assigned_to,
      assigned_to_name: t.assigned_to_name,
      cells,
    };
  });

  res.json({ from: fromDate, to: toDate, dates, today_index: back, rows });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// ── POST /hr/checklists/completions/:id/decision (admin only) ───
// Approve or reject a checklist completion.  Body: { status, note }.
router.post('/checklists/completions/:id/decision', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { status, note } = req.body || {};
    if (status !== 'approved' && status !== 'rejected') {
      return res.status(400).json({ error: 'status must be "approved" or "rejected"' });
    }
    const r = await pg.run(`
      UPDATE checklist_completions
      SET approval_status = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP, approval_note = ?
      WHERE id = ?
    `, status, req.user.id, note || null, req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: 'Completion not found' });
    res.json({ message: `Marked ${status}` });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// ═════════════════════════════════════════════════════════════════
// INDUCTION (read-only digest for employees — the /induction page)
// ═════════════════════════════════════════════════════════════════
// Sections: Company Culture / HR Policies / IT-Security / SOPs.  Admin CRUD
// lives in the recruitment module and is not ported here.

router.get('/induction', async (req, res) => {
  try {
    const { active } = req.query;
    let sql = `SELECT * FROM induction_items WHERE 1=1`;
    if (active === '1') sql += ' AND is_active = 1';
    sql += ' ORDER BY section, order_index, id';
    res.json(await pg.all(sql));
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// ═════════════════════════════════════════════════════════════════
// TRAINING — employee-facing "My Training"
// ═════════════════════════════════════════════════════════════════

// "My Training" — what's assigned to the logged-in user (via their
// employees.user_id link).  Used by the employee-facing /training page.
router.get('/training/mine', async (req, res) => {
  try {
    const emp = await pg.get('SELECT id FROM employees WHERE user_id = ?', req.user.id);
    if (!emp) return res.json([]);
    const rows = await pg.all(
      `SELECT a.*, v.title, v.description, v.video_url, v.training_type, v.duration_minutes, v.is_mandatory
         FROM training_assignments a
         JOIN training_videos v ON v.id = a.video_id
        WHERE a.employee_id = ? AND v.is_active = 1
        ORDER BY v.is_mandatory DESC, a.assigned_at DESC`,
      emp.id);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.post('/training/assignments/:id/start', async (req, res) => {
  try {
    await pg.run(`UPDATE training_assignments
                       SET started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
                     WHERE id = ?`, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.post('/training/assignments/:id/complete', async (req, res) => {
  try {
    const { note } = req.body || {};
    await pg.run(`UPDATE training_assignments
                       SET completed_at = CURRENT_TIMESTAMP,
                           completion_note = ?,
                           started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
                     WHERE id = ?`, note || null, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// ═════════════════════════════════════════════════════════════════
// NOTIFICATIONS (mam 2026-05-22 Phase 1 Batch E, module #15)
// Bell-icon in the Layout polls /my-notifications every 60 sec.
// ═════════════════════════════════════════════════════════════════
router.get("/my-notifications", async (req, res) => {
  try {
    const { unread } = req.query;
    let sql = "SELECT * FROM notifications WHERE user_id = ?";
    if (unread === "1") sql += " AND read_at IS NULL";
    sql += " ORDER BY created_at DESC LIMIT 50";
    res.json(await pg.all(sql, req.user.id));
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.put("/notifications/:id/read", async (req, res) => {
  try {
    await pg.run(`UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND read_at IS NULL`, req.params.id, req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.post("/notifications/mark-all-read", async (req, res) => {
  try {
    await pg.run(`UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL`, req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

export default router;
