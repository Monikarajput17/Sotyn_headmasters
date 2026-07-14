const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Sales Funnel — exactly mam's 11-stage spec (SEPL_Sales_Funnel_ERP_Build_Spec).
// Each key = ERP screen route in the spec. `gate: true` marks stages that
// REQUIRE an explicit approval (no auto-advance) — Stage 6 (CFO + Sales Head
// sign-off) and Stage 10 (Legal + CFO contract lock).
// `sla_hours = null` means no fixed SLA on that stage (T-X in spec).
// `who` is the role that owns the stage.
const STAGES = [
  { key: 'lead_capture',            label: 'Lead/Tender Capture',          color: 'blue',    who: 'BD',           sla_hours: 1,        gate: false },
  { key: 'qualification',           label: 'Qualified or Not',             color: 'indigo',  who: 'Sales Head',   sla_hours: 24,       gate: false },
  { key: 'site_survey',             label: 'Site Survey + Feasibility',    color: 'purple',  who: 'Site Eng',     sla_hours: 72,       gate: false },
  { key: 'concept_design',          label: 'Concept Design / Drawings',    color: 'violet',  who: 'Designer',     sla_hours: 168,      gate: false },
  { key: 'boq_costing',             label: 'BOQ + Vendor Costing',         color: 'amber',   who: 'Estimation',   sla_hours: 168,      gate: false },
  { key: 'pricing_review',          label: 'Internal Pricing Review',      color: 'orange',  who: 'CFO',          sla_hours: 24,       gate: true  },
  { key: 'quote_submitted',         label: 'Quote / Bid Submission',       color: 'cyan',    who: 'Sales',        sla_hours: null,     gate: false },
  { key: 'technical_clarification', label: 'Technical Clarification',      color: 'sky',     who: 'Sales + Tech', sla_hours: 24,       gate: false },
  { key: 'commercial_negotiation',  label: 'Commercial Negotiation',       color: 'teal',    who: 'Sales Head',   sla_hours: null,     gate: false },
  { key: 'contract_signed',         label: 'Contract + LOI / PO',          color: 'emerald', who: 'Legal + CFO',  sla_hours: null,     gate: true  },
  { key: 'project_kickoff',         label: 'Project Kickoff',              color: 'lime',    who: 'PM',           sla_hours: null,     gate: false },
  { key: 'lost',                    label: 'Lost',                         color: 'red',     who: '-',            sla_hours: null,     gate: false },
];

// Backward-compat: old single-letter / legacy stage keys map to new ones.
// Anything still hitting the API with old keys gets translated transparently
// so the UI doesn't break during the 11-stage rollout.
const LEGACY_STAGE_MAP = {
  new_lead: 'lead_capture',
  qualified: 'qualification',
  meeting_assigned: 'site_survey',
  mom_uploaded: 'site_survey',
  drawing_uploaded: 'concept_design',
  boq_created: 'boq_costing',
  quotation_sent: 'quote_submitted',
  won: 'contract_signed',
};
const normalizeStage = (s) => LEGACY_STAGE_MAP[s] || s;

// Helper: add SLA info (due_at, is_overdue, minutes_remaining) to each lead row.
// Called by GET handlers so the client can render "due in 45 min / overdue" chips.
const withSla = (rows) => {
  const now = Date.now();
  return rows.map(r => {
    const stage = STAGES.find(s => s.key === r.current_stage);
    if (!stage || !stage.sla_hours || !r.stage_entered_at) {
      return { ...r, sla_due_at: null, sla_minutes_left: null, sla_overdue: false };
    }
    const enteredMs = new Date(r.stage_entered_at).getTime();
    const dueMs = enteredMs + stage.sla_hours * 3600 * 1000;
    const minutesLeft = Math.round((dueMs - now) / 60000);
    return {
      ...r,
      sla_due_at: new Date(dueMs).toISOString(),
      sla_minutes_left: minutesLeft,
      sla_overdue: minutesLeft < 0,
    };
  });
};

// GET all with filters
router.get('/', requirePermission('leads', 'view'), (req, res) => {
  const { stage, search, assigned_sc, category } = req.query;
  let sql = 'SELECT * FROM sales_funnel WHERE 1=1';
  const params = [];
  if (stage && stage !== 'all') { sql += ' AND current_stage=?'; params.push(stage); }
  if (assigned_sc) { sql += ' AND assigned_sc=?'; params.push(assigned_sc); }
  if (category) { sql += ' AND category LIKE ?'; params.push(`%${category}%`); }
  if (search) {
    sql += ' AND (client_name LIKE ? OR company_name LIKE ? OR lead_no LIKE ? OR phone LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY created_at DESC';
  res.json(withSla(getDb().prepare(sql).all(...params)));
});

// GET stages info
router.get('/stages', (req, res) => res.json(STAGES));

// Spec-defined sources / categories / sub-trades.
// MUST be declared before `/:id` so Express doesn't treat 'meta' as a lead id.
const SOURCES = ['Website','Referral','Cold','IPC','GeM','CPPP','State Portal','Repeat'];
const CATEGORIES_SPEC = ['MEPF Project','Solar EPC'];
const SUB_TRADES = ['M','E','P','F','BMS','ELV','Solar'];
router.get('/meta', (req, res) => res.json({
  sources: SOURCES, categories: CATEGORIES_SPEC, sub_trades: SUB_TRADES, stages: STAGES,
}));

// GET pipeline dashboard
router.get('/dashboard', requirePermission('leads', 'view'), (req, res) => {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as c FROM sales_funnel').get();
  const bystage = db.prepare('SELECT current_stage, COUNT(*) as count FROM sales_funnel GROUP BY current_stage').all();
  // Mam (2026-05-22 audit fix): stage was renamed 'won' → 'contract_signed'
  // in the 11-stage spec (commit sf_stages_v2), but this dashboard
  // still queried the old key — Won Deals tile showed 0.  Match both
  // for backwards compatibility with any rows that escaped the
  // migration.
  const won = db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(won_amount),0) as amount FROM sales_funnel WHERE current_stage IN ('contract_signed','won')").get();
  const lost = db.prepare("SELECT COUNT(*) as c FROM sales_funnel WHERE current_stage='lost'").get();
  const thisMonth = db.prepare("SELECT COUNT(*) as c FROM sales_funnel WHERE created_at >= date('now','start of month')").get();
  const byCategory = db.prepare("SELECT category, COUNT(*) as count FROM sales_funnel WHERE category IS NOT NULL AND category != '' GROUP BY category").all();
  const bySC = db.prepare("SELECT assigned_sc, COUNT(*) as count FROM sales_funnel WHERE assigned_sc IS NOT NULL AND assigned_sc != '' GROUP BY assigned_sc").all();
  const recent = db.prepare('SELECT * FROM sales_funnel ORDER BY updated_at DESC LIMIT 10').all();
  const today = new Date().toISOString().split('T')[0];
  let todayFollowups = 0, overdueFollowups = 0;
  try {
    todayFollowups = db.prepare("SELECT COUNT(*) as c FROM lead_followups WHERE done=0 AND followup_date=?").get(today)?.c || 0;
    overdueFollowups = db.prepare("SELECT COUNT(*) as c FROM lead_followups WHERE done=0 AND followup_date<?").get(today)?.c || 0;
  } catch(e) {}

  // Fortnightly expected-closing forecast (mam 2026-06-25): qualified leads
  // that have a closing date, bucketed into 14-day periods from today, summing
  // their tentative amounts — an AR/AP-tracker-style pipeline view. Lost leads
  // are excluded. Bucketing uses date PARTS (TZ-agnostic for DATE columns).
  let closingByFortnight = [];
  try {
    const rows = db.prepare(
      "SELECT closing_date, COALESCE(tentative_amount,0) AS amt FROM sales_funnel WHERE closing_date IS NOT NULL AND closing_date != '' AND current_stage != 'lost'"
    ).all();
    const DAY = 86400000, FN = 14 * DAY, N = 6;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const fmtD = (ts) => { const d = new Date(ts); return `${String(d.getDate()).padStart(2,'0')} ${MON[d.getMonth()]}`; };
    const buckets = [{ key: 'overdue', label: 'Overdue', count: 0, amount: 0 }];
    for (let i = 0; i < N; i++) {
      const start = todayStart + i * FN;
      buckets.push({ key: 'f' + i, label: `${fmtD(start)}–${fmtD(start + (FN - DAY))}`, count: 0, amount: 0 });
    }
    buckets.push({ key: 'later', label: 'Later', count: 0, amount: 0 });
    for (const r of rows) {
      const parts = String(r.closing_date).slice(0, 10).split('-').map(Number);
      if (parts.length < 3 || !parts[0]) continue;
      const cdStart = new Date(parts[0], parts[1] - 1, parts[2]).getTime();
      let b;
      if (cdStart < todayStart) b = buckets[0];
      else { const idx = Math.floor((cdStart - todayStart) / FN); b = idx < N ? buckets[idx + 1] : buckets[buckets.length - 1]; }
      b.count += 1; b.amount += +r.amt || 0;
    }
    closingByFortnight = buckets;
  } catch (e) {}

  res.json({ total: total.c, byStage: bystage, won, lost, thisMonth: thisMonth.c, byCategory, bySC, recent, stages: STAGES, todayFollowups, overdueFollowups, closingByFortnight });
});

// GET single (with SLA info)
router.get('/:id', requirePermission('leads', 'view'), (req, res) => {
  const lead = getDb().prepare('SELECT * FROM sales_funnel WHERE id=?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  res.json(withSla([lead])[0]);
});

// Stage 1 validation per mam's spec — GST format, estimated value > 0,
// bid deadline > today (Govt only), required fields per kind.
function validateStage1(b, isCreate) {
  const errors = [];
  if (!b.client_name) errors.push('Customer name is required');
  if (!b.project_name && isCreate) errors.push('Project name is required');
  if (b.lead_kind && !['private','government'].includes(b.lead_kind)) errors.push('Invalid lead_kind');
  // GST format: 2-digit state code + 10-char PAN + 1Z + 1 check char
  if (b.gst_number && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(String(b.gst_number).toUpperCase())) {
    errors.push('GST number is invalid');
  }
  if (b.pan_number && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(b.pan_number).toUpperCase())) {
    errors.push('PAN number is invalid');
  }
  if (b.estimated_value !== undefined && +b.estimated_value < 0) errors.push('Estimated value must be ≥ 0');
  // Government-specific
  if (b.lead_kind === 'government') {
    if (!b.tender_id && isCreate) errors.push('Tender ID is required for Government leads');
    if (b.bid_deadline) {
      const today = new Date(); today.setHours(0,0,0,0);
      const deadline = new Date(b.bid_deadline);
      if (!isNaN(deadline) && deadline < today) errors.push('Bid deadline must be today or later');
    }
  }
  return errors;
}

// Helper: write an audit row — never throws, used everywhere.
function audit(db, lead_id, stage, action, user, opts = {}) {
  try {
    db.prepare(`
      INSERT INTO sales_funnel_audit (lead_id, stage, action, actor_id, actor_name, evidence_url, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(lead_id, stage || null, action, user?.id || null, user?.name || null, opts.evidence_url || null, opts.notes || null);
  } catch {}
}

// POST create — Stage 1 Lead / Tender Capture. Auto-stamps stage_entered_at
// so the 1-hour SLA for first-call starts ticking. Audit row written.
router.post('/', requirePermission('leads', 'create'), (req, res) => {
  const b = req.body;
  const errors = validateStage1(b, true);
  if (errors.length) return res.status(400).json({ error: errors.join(' · ') });

  const db = getDb();
  const { nextSequence } = require('../db/nextSequence');
  const leadNo = nextSequence(db, 'sales_funnel', 'lead_no', 'SEPL', { startFrom: 9000, pad: 4 });

  const subTrades = Array.isArray(b.sub_trades_scope) ? b.sub_trades_scope.join(',') : (b.sub_trades_scope || null);
  const leadKind = b.lead_kind === 'government' ? 'government' : 'private';

  // Mam (2026-06-01) Stage-1 form additions: building_category +
  // influencer_id/_name (denormalised name keeps history readable
  // if a partner row is renamed in the master).  GST + PAN remain
  // in the column list for backward-compat reads, but the UI no
  // longer collects them; NULLs are persisted on new rows.
  const r = db.prepare(`INSERT INTO sales_funnel
    (lead_no, client_name, company_name, phone, email, category, lead_type, lead_kind,
     gst_number, pan_number, project_name, project_location, pin_code,
     estimated_value, tentative_timeline, sub_trades_scope, building_category,
     tender_id, bid_deadline, emd_amount, pbg_required,
     city, address, district, state, source, influencer_id, influencer_name,
     assigned_sc, assigned_asm, assigned_asm_id,
     remarks, created_by,
     current_stage, stage_entered_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'new_lead', CURRENT_TIMESTAMP)`).run(
    leadNo, b.client_name, b.company_name || null, b.phone || null, b.email || null,
    b.category || null, b.lead_type || null, leadKind,
    b.gst_number ? String(b.gst_number).toUpperCase() : null,
    b.pan_number ? String(b.pan_number).toUpperCase() : null,
    b.project_name || null, b.project_location || null, b.pin_code || null,
    +b.estimated_value || 0, b.tentative_timeline || null, subTrades,
    b.building_category || null,
    b.tender_id || null, b.bid_deadline || null, +b.emd_amount || 0, b.pbg_required ? 1 : 0,
    b.city || null, b.address || null, b.district || null, b.state || null,
    b.source || null,
    // Influencer only stored when source='Influencer' — guards
    // against stale ids when the user toggles source between options.
    b.source === 'Influencer' ? (b.influencer_id || null) : null,
    b.source === 'Influencer' ? (b.influencer_name || null) : null,
    b.assigned_sc || null, b.assigned_asm || null, b.assigned_asm_id || null,
    b.remarks || null,
    req.user.id
  );
  audit(db, r.lastInsertRowid, 'new_lead', 'create', req.user, {
    notes: `Captured as ${leadKind === 'government' ? 'Government tender' : 'Private quote'}` + (b.tender_id ? ` · Tender ${b.tender_id}` : '')
  });
  res.status(201).json({ id: r.lastInsertRowid, lead_no: leadNo });
});

// POST drop — close a lead with mandatory reason. Forward-only state
// machine: a dropped lead can be reopened later but every transition
// is audited.
router.post('/:id/drop', requirePermission('leads', 'edit'), (req, res) => {
  const { reason } = req.body;
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'Drop reason is required' });
  const db = getDb();
  const cur = db.prepare('SELECT id, current_stage, dropped FROM sales_funnel WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Lead not found' });
  if (cur.dropped) return res.status(400).json({ error: 'Lead is already dropped' });
  db.prepare(`
    UPDATE sales_funnel
       SET dropped=1, drop_reason=?, dropped_at=CURRENT_TIMESTAMP, dropped_by=?,
           current_stage='lost', updated_at=CURRENT_TIMESTAMP
     WHERE id=?
  `).run(String(reason).trim(), req.user.id, req.params.id);
  audit(db, cur.id, cur.current_stage, 'drop', req.user, { notes: reason });
  res.json({ message: 'Lead dropped' });
});

// GET audit log for a lead — read-only timeline for the audit panel.
router.get('/:id/audit', requirePermission('leads', 'view'), (req, res) => {
  const rows = getDb().prepare(`
    SELECT a.*, u.name as actor_live_name
      FROM sales_funnel_audit a
      LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.lead_id = ?
     ORDER BY a.at DESC
  `).all(req.params.id);
  res.json(rows);
});

// PUT update — Stage 1 fields editable until lead leaves Stage 1.
// Audit row written for any field change.
router.put('/:id', requirePermission('leads', 'edit'), (req, res) => {
  const b = req.body;
  const errors = validateStage1(b, false);
  if (errors.length) return res.status(400).json({ error: errors.join(' · ') });
  const db = getDb();
  const cur = db.prepare('SELECT current_stage FROM sales_funnel WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Lead not found' });

  const subTrades = Array.isArray(b.sub_trades_scope) ? b.sub_trades_scope.join(',') : (b.sub_trades_scope || null);
  const leadKind = b.lead_kind === 'government' ? 'government' : (b.lead_kind === 'private' ? 'private' : null);

  db.prepare(
    `UPDATE sales_funnel SET
       client_name=?, company_name=?, phone=?, email=?,
       category=?, lead_type=?, lead_kind=COALESCE(?, lead_kind),
       gst_number=?, pan_number=?,
       project_name=?, project_location=?, pin_code=?,
       estimated_value=?, tentative_timeline=?, sub_trades_scope=?,
       tender_id=?, bid_deadline=?, emd_amount=?, pbg_required=?,
       city=?, address=?, district=?, state=?, source=?,
       assigned_sc=?, assigned_asm=?, assigned_asm_id=?, remarks=?,
       updated_at=CURRENT_TIMESTAMP
     WHERE id=?`
  ).run(
    b.client_name, b.company_name || null, b.phone || null, b.email || null,
    b.category || null, b.lead_type || null, leadKind,
    b.gst_number ? String(b.gst_number).toUpperCase() : null,
    b.pan_number ? String(b.pan_number).toUpperCase() : null,
    b.project_name || null, b.project_location || null, b.pin_code || null,
    +b.estimated_value || 0, b.tentative_timeline || null, subTrades,
    b.tender_id || null, b.bid_deadline || null, +b.emd_amount || 0, b.pbg_required ? 1 : 0,
    b.city || null, b.address || null, b.district || null, b.state || null,
    b.source || null,
    b.assigned_sc || null, b.assigned_asm || null, b.assigned_asm_id || null,
    b.remarks || null,
    req.params.id
  );
  audit(db, req.params.id, cur.current_stage, 'edit', req.user, { notes: 'Stage 1 fields updated' });
  res.json({ message: 'Updated' });
});

// POST advance stage — each stage has specific fields per mam's spec.
// Stage keys map 1:1 to the funnel positions (1-11 + lost). Legacy keys
// from the pre-spec build are translated via LEGACY_STAGE_MAP so any
// older client that still calls with old keys keeps working.
router.post('/:id/stage', requirePermission('leads', 'edit'), (req, res) => {
  const b = req.body;
  const db = getDb();
  const lead = db.prepare('SELECT * FROM sales_funnel WHERE id=?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });

  // Translate any legacy stage keys to the current spec keys before the switch.
  const stage = normalizeStage(b.stage);
  let sql = '';
  let params = [];

  switch (stage) {
    // ─── STAGE 2 — QUALIFIED OR NOT (GO/NO-GO) ─────────────────────────
    // Spec fields: customer_score (A/B/C), eligibility_check (Govt only),
    // margin_feasibility_pct, strategic_fit (1-5), decision GO/NO-GO + reason.
    // Existing fields kept so old leads don't lose data: is_qualified,
    // qualified_by, qualified_remarks, first_call_status / remarks.
    case 'qualification':
      sql = `UPDATE sales_funnel SET
        current_stage='qualification', is_qualified=1, qualified_by=?, qualified_date=CURRENT_TIMESTAMP,
        qualified_remarks=?, first_call_status=?, first_call_at=CURRENT_TIMESTAMP,
        first_call_remarks=?, tentative_amount=?, closing_date=?, stage_entered_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = [b.qualified_by || req.user.name, b.qualified_remarks || null,
        b.first_call_status || 'interested', b.first_call_remarks || b.qualified_remarks || null,
        (b.tentative_amount === '' || b.tentative_amount == null) ? null : (+b.tentative_amount || null),
        b.closing_date || null,
        req.params.id];
      break;

    // First Call NOT Interested → drops the lead with reason. Maps to terminal 'lost'.
    case 'not_qualified':
      sql = `UPDATE sales_funnel SET
        current_stage='lost', is_qualified=0, qualified_by=?, qualified_date=CURRENT_TIMESTAMP,
        qualified_remarks=?, first_call_status='not_interested', first_call_at=CURRENT_TIMESTAMP,
        first_call_remarks=?, stage_entered_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = [b.qualified_by || req.user.name, b.qualified_remarks || 'Not qualified',
        b.first_call_remarks || b.qualified_remarks || null, req.params.id];
      break;

    // ─── STAGE 3 — SITE SURVEY + FEASIBILITY ───────────────────────────
    // Replaces 'meeting_assigned'. Existing meeting fields reused as the
    // survey schedule (date, location, surveyor). Spec fields like load
    // study, photos, drawings will be added when mam asks for Stage 3.
    case 'site_survey':
      // Survey date is OPTIONAL (mam 2026-06-25). Empty -> NULL so it saves
      // cleanly; meeting_status stays 'scheduled' only when a date is given.
      sql = `UPDATE sales_funnel SET
        current_stage='site_survey', meeting_date=?, meeting_location=?,
        meeting_assigned_to=?, meeting_assigned_to_id=?,
        meeting_status=?, meeting_recording_url=?,
        meeting_location_lat=?, meeting_location_lng=?,
        stage_entered_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = [b.meeting_date || null, b.meeting_location || null,
        b.meeting_assigned_to || null, b.meeting_assigned_to_id || null,
        b.meeting_date ? 'scheduled' : 'pending',
        b.meeting_recording_url || null,
        b.meeting_location_lat || null, b.meeting_location_lng || null,
        req.params.id];
      break;

    // Face-to-Face outcome — intermediate step within site_survey
    case 'f2f_done':
      sql = `UPDATE sales_funnel SET
        current_stage='site_survey', f2f_status=?, f2f_date=CURRENT_TIMESTAMP,
        stage_entered_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = [b.f2f_status || 'done', req.params.id];
      break;

    // Fill MOM + advance to Stage 4 (Concept Design). MOM marks the
    // tail of Stage 3 (Site Survey) — once captured, the lead moves
    // forward to Design Engineer per spec ("Trigger out: assigns to
    // Design Engineer"). The full MOM Google-Form layout is kept
    // (purpose, pain points, requirements, action planned, format,
    // time spent, timestamp photo, MOM file).
    case 'mom_uploaded':
      if (!b.mom_notes) return res.status(400).json({ error: 'MOM notes required' });
      sql = `UPDATE sales_funnel SET
        current_stage='concept_design',
        mom_notes=?, mom_file_link=?, mom_filled_by=?, mom_date=CURRENT_TIMESTAMP,
        meeting_status='completed',
        category=COALESCE(?, category),
        lead_type=COALESCE(?, lead_type),
        meeting_location=COALESCE(?, meeting_location),
        meeting_purpose=?, meeting_timestamp_photo_url=?, pain_points=?, requirements=?,
        action_planned=?, meeting_format=?, meeting_scheduled_by=?, meeting_time_spent_min=?,
        stage_entered_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = [b.mom_notes, b.mom_file_link, b.mom_filled_by || req.user.name,
        b.category || null, b.lead_type || null, b.meeting_location || null,
        b.meeting_purpose || null, b.meeting_timestamp_photo_url || null,
        b.pain_points || null, b.requirements || null,
        b.action_planned || null, b.meeting_format || null,
        b.meeting_scheduled_by || null,
        b.meeting_time_spent_min ? +b.meeting_time_spent_min : null,
        req.params.id];
      break;

    // ─── STAGE 4 — CONCEPT DESIGN / DRAWINGS ───────────────────────────
    // Replaces 'drawing_uploaded'. Same 3 drawing slots; spec fields
    // (versioning, SLD, load list, structural calc) added later.
    case 'concept_design':
      sql = `UPDATE sales_funnel SET
        current_stage='concept_design',
        drawing_file1=?, drawing_file2=?, drawing_file3=?, drawing_uploaded_by=?,
        drawing_date=CURRENT_TIMESTAMP, stage_entered_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = [b.drawing_file1, b.drawing_file2, b.drawing_file3,
        b.drawing_uploaded_by || req.user.name, req.params.id];
      break;

    // ─── STAGE 5 — BOQ + VENDOR COSTING ────────────────────────────────
    // Replaces 'boq_created'. Same fields; vendor-quote rule and
    // estimation sign-off added later.
    case 'boq_costing':
      sql = `UPDATE sales_funnel SET
        current_stage='boq_costing',
        boq_file_link=?, revised_boq_file_link=?,
        boq_created_by=?, boq_amount=?, boq_date=CURRENT_TIMESTAMP,
        stage_entered_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = [b.boq_file_link, b.revised_boq_file_link || null,
        b.boq_created_by || req.user.name, b.boq_amount || 0, req.params.id];
      break;

    // ─── STAGE 6 — INTERNAL PRICING REVIEW (GATE) — stub ───────────────
    // Spec: CFO + Sales Head only. Margin floor enforced at line level.
    // Slab-based approval routing: <50L Sales Head, 50L-2cr CFO, >2cr CMD.
    // For now: just advance the lead and capture optional remarks.
    case 'pricing_review':
      sql = `UPDATE sales_funnel SET
        current_stage='pricing_review', stage_entered_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = [req.params.id];
      break;

    // ─── STAGE 7 — QUOTE / BID SUBMISSION ──────────────────────────────
    // Replaces 'quotation_sent'. Same fields; Govt EMD/PBG annexures
    // already on the lead from Stage 1.
    case 'quote_submitted':
      sql = `UPDATE sales_funnel SET
        current_stage='quote_submitted',
        quotation_number=?, quotation_file_link=?, quotation_amount=?,
        quotation_sent_by=?, quotation_sent_date=CURRENT_TIMESTAMP,
        stage_entered_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = [b.quotation_number, b.quotation_file_link, b.quotation_amount || 0,
        b.quotation_sent_by || req.user.name, req.params.id];
      break;

    // ─── STAGE 8 — TECHNICAL CLARIFICATION — stub ──────────────────────
    case 'technical_clarification':
      sql = `UPDATE sales_funnel SET
        current_stage='technical_clarification', stage_entered_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = [req.params.id];
      break;

    // ─── STAGE 9 — COMMERCIAL NEGOTIATION — stub ───────────────────────
    case 'commercial_negotiation':
      sql = `UPDATE sales_funnel SET
        current_stage='commercial_negotiation', stage_entered_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = [req.params.id];
      break;

    // ─── STAGE 10 — CONTRACT + LOI/PO (GATE) — stub ────────────────────
    // Existing 'won' state maps here — old won leads were essentially at
    // the contract-signed gate. Captures result + amount on the lead row.
    case 'contract_signed':
      sql = `UPDATE sales_funnel SET
        current_stage='contract_signed', result='won', result_remarks=?,
        result_date=CURRENT_TIMESTAMP, won_amount=?,
        stage_entered_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = [b.result_remarks || null, b.won_amount || 0, req.params.id];
      break;

    // ─── STAGE 11 — PROJECT KICKOFF — stub ─────────────────────────────
    case 'project_kickoff':
      sql = `UPDATE sales_funnel SET
        current_stage='project_kickoff', stage_entered_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = [req.params.id];
      break;

    // ─── TERMINAL — LOST (drop with reason) ────────────────────────────
    case 'lost':
      sql = `UPDATE sales_funnel SET
        current_stage='lost', result='lost', result_remarks=?,
        result_date=CURRENT_TIMESTAMP,
        stage_entered_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = [b.result_remarks, req.params.id];
      break;

    default:
      return res.status(400).json({ error: `Invalid stage: ${b.stage}` });
  }

  // Guard the stage write so a bad bind / SQL issue returns a clear message
  // instead of an unhandled 500 surfacing as a generic "Error" toast
  // (mam 2026-06-25 — empty Remarks bound undefined on Qualify).
  try {
    db.prepare(sql).run(...params);
  } catch (e) {
    console.error('[sales-funnel stage] write failed:', stage, e.message);
    return res.status(500).json({ error: `Could not save this stage: ${e.message}` });
  }
  // Keep every BOQ the client sends — the stage submit records one in the
  // history table too (mam 2026-06-12), alongside the "latest" columns above.
  if (stage === 'boq_costing' && (b.boq_file_link || +b.boq_amount > 0)) {
    try {
      db.prepare(`INSERT INTO sales_funnel_boqs (funnel_id, boq_file_link, boq_amount, created_by, notes)
                  VALUES (?, ?, ?, ?, ?)`)
        .run(req.params.id, b.boq_file_link || null, +b.boq_amount || 0, b.boq_created_by || req.user.name, b.boq_notes || null);
    } catch (_) { /* history is best-effort */ }
  }
  audit(db, req.params.id, stage, 'enter_stage', req.user, {
    notes: b.result_remarks || b.qualified_remarks || b.mom_notes || null,
  });
  res.json({ message: `Stage updated to ${stage}` });
});

// ===== BOQ HISTORY (mam 2026-06-12: clients re-send BOQs over time) =====

// GET all BOQs submitted for a lead (newest first).
router.get('/:id/boqs', requirePermission('leads', 'view'), (req, res) => {
  const rows = getDb().prepare(
    `SELECT id, boq_file_link, boq_amount, notes, created_by, created_at
       FROM sales_funnel_boqs WHERE funnel_id=? ORDER BY created_at DESC, id DESC`
  ).all(req.params.id);
  res.json(rows);
});

// POST an ADDITIONAL BOQ for a lead — works at any stage so a re-sent BOQ
// can always be added.  Records history + refreshes the "latest" columns.
router.post('/:id/boq', requirePermission('leads', 'edit'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  if (!b.boq_file_link && !(+b.boq_amount > 0)) {
    return res.status(400).json({ error: 'Attach a BOQ file or enter an amount' });
  }
  try {
    db.prepare(`INSERT INTO sales_funnel_boqs (funnel_id, boq_file_link, boq_amount, created_by, notes)
                VALUES (?, ?, ?, ?, ?)`)
      .run(req.params.id, b.boq_file_link || null, +b.boq_amount || 0, req.user.name, b.boq_notes || null);
    db.prepare(`UPDATE sales_funnel SET boq_file_link=?, boq_amount=?, boq_date=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(b.boq_file_link || null, +b.boq_amount || 0, req.params.id);
    try { audit(db, req.params.id, 'boq_costing', 'add_boq', req.user, { notes: b.boq_notes || null }); } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== FOLLOW-UPS =====

// GET follow-ups for a lead
router.get('/:id/followups', requirePermission('leads', 'view'), (req, res) => {
  res.json(getDb().prepare(`SELECT f.*, u.name as created_by_name, u2.name as done_by_name FROM lead_followups f
    LEFT JOIN users u ON f.created_by=u.id LEFT JOIN users u2 ON f.done_by=u2.id
    WHERE f.lead_id=? ORDER BY f.followup_date DESC`).all(req.params.id));
});

// POST add follow-up
router.post('/:id/followup', requirePermission('leads', 'create'), (req, res) => {
  const { followup_date, followup_time, type, notes, next_followup_date } = req.body;
  if (!followup_date) return res.status(400).json({ error: 'Follow-up date required' });
  const r = getDb().prepare('INSERT INTO lead_followups (lead_id, followup_date, followup_time, type, notes, next_followup_date, created_by) VALUES (?,?,?,?,?,?,?)')
    .run(req.params.id, followup_date, followup_time, type || 'call', notes, next_followup_date, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});

// PUT log follow-up outcome
router.put('/followup/:fid', requirePermission('leads', 'edit'), (req, res) => {
  const { outcome, notes, next_followup_date } = req.body;
  if (!outcome) return res.status(400).json({ error: 'Outcome required' });
  const db = getDb();
  db.prepare('UPDATE lead_followups SET outcome=?, notes=?, done=1, done_by=?, next_followup_date=? WHERE id=?')
    .run(outcome, notes, req.user.id, next_followup_date, req.params.fid);
  // Auto-create next follow-up if set
  if (next_followup_date) {
    const fu = db.prepare('SELECT lead_id FROM lead_followups WHERE id=?').get(req.params.fid);
    if (fu) {
      db.prepare('INSERT INTO lead_followups (lead_id, followup_date, type, notes, created_by) VALUES (?,?,?,?,?)')
        .run(fu.lead_id, next_followup_date, 'call', 'Auto-scheduled from previous follow-up', req.user.id);
    }
  }
  res.json({ message: 'Follow-up logged' });
});

// GET today's pending follow-ups (for dashboard)
router.get('/followups/today', requirePermission('leads', 'view'), (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const pending = getDb().prepare(`SELECT f.*, sf.lead_no, sf.client_name, sf.company_name, sf.phone, sf.current_stage
    FROM lead_followups f JOIN sales_funnel sf ON f.lead_id=sf.id
    WHERE f.done=0 AND f.followup_date <= ? ORDER BY f.followup_date`).all(today);
  res.json(pending);
});

// GET overdue follow-ups
router.get('/followups/overdue', requirePermission('leads', 'view'), (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const overdue = getDb().prepare(`SELECT f.*, sf.lead_no, sf.client_name, sf.company_name, sf.phone
    FROM lead_followups f JOIN sales_funnel sf ON f.lead_id=sf.id
    WHERE f.done=0 AND f.followup_date < ? ORDER BY f.followup_date`).all(today);
  res.json(overdue);
});

// DELETE
router.delete('/:id', requirePermission('leads', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM sales_funnel WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
