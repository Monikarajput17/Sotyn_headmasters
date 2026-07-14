// Project-wise manpower plan (mam 2026-06-12). MIRRORS the computation in
// routes/hr.js GET /manpower-plan — kept identical so the scorecard's
// `auto:site_manpower` source reads the EXACT required-vs-actual numbers the
// HR → Manpower Plan page shows. ⚠️ If the value slab / grouping changes in
// routes/hr.js, update it here too (and vice-versa). One row per unique project:
// REQUIRED manpower (value slab, or per-project override) vs ACTUAL (avg DPR mp).
//
//   Project value → required manpower:
//     ≤ 5 L → 4 | ≤ 25 L → 6 | ≤ 50 L → 8 | ≤ 1 Cr → 10
//     ≤ 5 Cr → 15 | ≤ 10 Cr → 25 | > 10 Cr → 40
const LAKH = 100000, CRORE = 10000000;
function requiredManpower(value) {
  const v = +value || 0;
  if (v <= 5 * LAKH)  return 4;
  if (v <= 25 * LAKH) return 6;
  if (v <= 50 * LAKH) return 8;
  if (v <= 1 * CRORE) return 10;
  if (v <= 5 * CRORE) return 15;
  if (v <= 10 * CRORE) return 25;
  return 40;
}

// Required Site Eng / Jr. Site Eng / Foreman per project (mam 2026-06-13): every
// project needs 1 Jr. Site Eng + 1 Foreman; a senior Site Engineer only once the
// project crosses ₹1.5 Cr.
const ENG_THRESHOLD = 1.5 * CRORE;
function requiredEngineers(value) {
  const big = (+value || 0) >= ENG_THRESHOLD;
  return { se: big ? 1 : 0, jr: 1, fm: 1 };
}

// Classify a PO-linked person by their assigned ROLE(S) into one bucket:
// 'fm' · 'jr' · 'se'. Foreman wins, then junior; everyone else is a senior SE.
function classifyRole(roleNames) {
  const d = String(roleNames || '').toLowerCase();
  if (d.includes('foreman')) return 'fm';
  if (/\b(jr|jnr|junior|trainee|gte|asst|assistant)\b/.test(d) || d.includes('junior')) return 'jr';
  return 'se';
}

// Full per-project plan (unique projects grouped by normalized name).
function computeManpowerPlan(db) {
  const bbs = db.prepare(
    `SELECT id, lead_no, project_name, company_name, client_name, po_amount, status
       FROM business_book`
  ).all();
  const sites = db.prepare(`SELECT id, business_book_id FROM sites`).all();
  // Manpower per DPR: prefer the sum of dpr_contractors.manpower, else the
  // legacy dpr.contractor_manpower. One row per DPR.
  const dprRows = db.prepare(
    `SELECT d.id, d.site_id, d.report_date,
            CASE WHEN COALESCE(SUM(dc.manpower), 0) > 0 THEN SUM(dc.manpower)
                 ELSE COALESCE(d.contractor_manpower, 0) END AS mp
       FROM dpr d
       LEFT JOIN dpr_contractors dc ON dc.dpr_id = d.id
      GROUP BY d.id`
  ).all();
  const norm = s => String(s || '').trim();
  const keyOf = bb => (norm(bb.project_name) || norm(bb.company_name) || norm(bb.client_name)
    || (bb.lead_no ? `Lead ${bb.lead_no}` : `BB#${bb.id}`)).toLowerCase();
  const groupByBB = new Map();
  const groups = new Map();
  for (const bb of bbs) {
    const key = keyOf(bb);
    groupByBB.set(bb.id, key);
    const display = norm(bb.project_name) || norm(bb.company_name) || norm(bb.client_name)
      || (bb.lead_no ? `Lead ${bb.lead_no}` : `BB#${bb.id}`);
    if (!groups.has(key)) groups.set(key, { key, project: display, value: 0, mpSum: 0, mpCount: 0, last_dpr_date: null, engUserIds: new Set() });
    groups.get(key).value += +bb.po_amount || 0;
  }
  const siteToBB = new Map();
  for (const s of sites) siteToBB.set(s.id, s.business_book_id);
  // Actual = AVERAGE manpower across the project's DPRs (only DPRs that recorded
  // manpower > 0 count, so unrecorded days don't drag it to 0).
  for (const r of dprRows) {
    const bbId = siteToBB.get(r.site_id);
    if (bbId == null) continue;
    const g = groups.get(groupByBB.get(bbId));
    if (!g) continue;
    const mp = +r.mp || 0;
    if (mp > 0) { g.mpSum += mp; g.mpCount += 1; }
    if (r.report_date && (!g.last_dpr_date || r.report_date > g.last_dpr_date)) g.last_dpr_date = r.report_date;
  }

  // Actual Site Eng / Jr / Foreman per project — the site engineers on each
  // project's POs, classified by assigned ROLE, active users only.
  try {
    const pos = db.prepare(
      `SELECT business_book_id, site_engineer_id, site_engineer_ids FROM purchase_orders`
    ).all();
    for (const po of pos) {
      const g = groups.get(groupByBB.get(po.business_book_id));
      if (!g) continue;
      if (po.site_engineer_id) g.engUserIds.add(po.site_engineer_id);
      if (po.site_engineer_ids) {
        String(po.site_engineer_ids).split(',').map(s => parseInt(s, 10))
          .filter(Boolean).forEach(i => g.engUserIds.add(i));
      }
    }
    const allEngIds = [...new Set([...groups.values()].flatMap(g => [...g.engUserIds]))];
    if (allEngIds.length) {
      const ph = allEngIds.map(() => '?').join(',');
      const userMap = new Map(
        db.prepare(
          `SELECT u.id, u.name, GROUP_CONCAT(r.name) AS role_names
             FROM users u
             LEFT JOIN user_roles ur ON ur.user_id = u.id
             LEFT JOIN roles r ON r.id = ur.role_id
            WHERE u.id IN (${ph}) AND u.active = 1
            GROUP BY u.id`
        ).all(...allEngIds).map(u => [u.id, u])
      );
      for (const g of groups.values()) {
        const seN = [], jrN = [], fmN = [];
        for (const uid of g.engUserIds) {
          const u = userMap.get(uid);
          if (!u) continue;
          const nm = (u.name || '').trim();
          const bucket = classifyRole(u.role_names);
          if (bucket === 'fm') fmN.push(nm); else if (bucket === 'jr') jrN.push(nm); else seN.push(nm);
        }
        g.seActual = seN.length; g.jrActual = jrN.length; g.fmActual = fmN.length;
        g.seNames = seN; g.jrNames = jrN; g.fmNames = fmN;
      }
    }
  } catch (e) { /* purchase_orders / roles tables may be absent on a stale DB */ }

  const settings = new Map();
  try {
    for (const s of db.prepare(`SELECT project_key, required_override, category, site_eng_override, jr_site_eng_override, foreman_override FROM manpower_project_settings`).all()) {
      settings.set(s.project_key, s);
    }
  } catch (e) { /* table may not exist on a very stale DB */ }

  const projects = [...groups.values()].map(g => {
    const s = settings.get(g.key) || {};
    const category = s.category || '';
    const isHandover = category === 'Handover';
    const requiredAuto = requiredManpower(g.value);
    const ov = s.required_override;
    const overridden = !isHandover && ov != null && ov >= 0;
    const required = isHandover ? 0 : (overridden ? ov : requiredAuto);
    const actual = g.mpCount > 0 ? Math.round(g.mpSum / g.mpCount) : 0;
    const engAuto = requiredEngineers(g.value);
    const seOv = s.site_eng_override, jrOv = s.jr_site_eng_override, fmOv = s.foreman_override;
    const seOverridden = !isHandover && seOv != null && seOv >= 0;
    const jrOverridden = !isHandover && jrOv != null && jrOv >= 0;
    const fmOverridden = !isHandover && fmOv != null && fmOv >= 0;
    const seRequired = isHandover ? 0 : (seOverridden ? seOv : engAuto.se);
    const jrRequired = isHandover ? 0 : (jrOverridden ? jrOv : engAuto.jr);
    const fmRequired = isHandover ? 0 : (fmOverridden ? fmOv : engAuto.fm);
    const seActual = g.seActual || 0;
    const jrActual = g.jrActual || 0;
    const fmActual = g.fmActual || 0;
    return {
      key: g.key,
      project: g.project,
      value: Math.round(g.value),
      category,
      is_handover: isHandover,
      required,
      required_auto: requiredAuto,
      required_overridden: overridden,
      actual,
      gap: required - actual,            // > 0 = short (hire), < 0 = surplus
      se_required: seRequired,
      se_required_auto: engAuto.se,
      se_required_overridden: seOverridden,
      se_actual: seActual,
      se_gap: seRequired - seActual,
      se_names: g.seNames || [],
      jr_required: jrRequired,
      jr_required_auto: engAuto.jr,
      jr_required_overridden: jrOverridden,
      jr_actual: jrActual,
      jr_gap: jrRequired - jrActual,
      jr_names: g.jrNames || [],
      fm_required: fmRequired,
      fm_required_auto: engAuto.fm,
      fm_required_overridden: fmOverridden,
      fm_actual: fmActual,
      fm_gap: fmRequired - fmActual,
      fm_names: g.fmNames || [],
      last_dpr_date: g.last_dpr_date,
    };
  }).sort((a, b) => b.gap - a.gap || b.value - a.value);
  return projects;
}

// Company-wide totals for the scorecard: Σ required vs Σ actual across all
// non-handover projects — the same numbers the Manpower Plan page totals to.
function manpowerTotals(db) {
  let required = 0, actual = 0;
  for (const p of computeManpowerPlan(db)) {
    if (p.is_handover) continue;
    required += +p.required || 0;
    actual += +p.actual || 0;
  }
  return { required, actual };
}

module.exports = { requiredManpower, requiredEngineers, classifyRole, computeManpowerPlan, manpowerTotals };
