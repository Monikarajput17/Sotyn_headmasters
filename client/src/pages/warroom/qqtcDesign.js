// QQTC Scorecard 2.0 — authored design/framework content.
// This is the *model* (the proposed KPI design), not live data. The live
// numbers — people, scores, templates, ownership, TOC pulse/funnel — are
// fetched from the ERP APIs inside QQTCScorecard.jsx. Anything here that
// names a person is a *recommendation* (the proposed owner), shown next to
// the live reality so management can compare proposed vs actual.
//
// Ported from mam's standalone "KPI Scorecard 2.0 (QQTC)" dashboard
// (Downloads/data.js + index.html, captured 28 Jun 2026).

// Pillar colours — semantic, encode the 4 QQTC dimensions everywhere.
export const QC = { quantity: '#2563eb', quality: '#16a34a', time: '#d97706', cost: '#9333ea', activity: '#94a3b8' };
export const QLAB = ['Quantity', 'Quality', 'Time', 'Cost'];
export const QCOL = [QC.quantity, QC.quality, QC.time, QC.cost];

// The 4 universal parameters, each fed by real ERP sources, weighted per family.
export const QQTC = [
  { name: 'Quantity', color: QC.quantity, what: 'Volume of work delivered',
    inputs: 'Delegations done · PMS done · Checklists done · Tickets closed · BOQs · Quotations · Hires · DPRs',
    src: 'Tasks, Service Desk, Quotes, HRMS modules — auto', status: 'LIVE' },
  { name: 'Quality', color: QC.quality, what: 'Did the output meet the standard',
    inputs: 'Plan-completion % · checklist compliance · complaints (inverse) · costing accuracy · rework / snags',
    src: 'Plan-vs-actual + Complaints + Snags — auto', status: 'LIVE' },
  { name: 'Time', color: QC.time, what: 'Was it delivered on time',
    inputs: 'TAT · response time · on-time delegation close · DSO · lead time · DPR punctuality',
    src: 'Timestamps on Delegations / Tickets / AR-AP — needs wiring', status: 'PENDING' },
  { name: 'Cost', color: QC.cost, what: 'Financial impact of the work',
    inputs: 'Margin % · expense control · transport savings · cash positive · ₹/watt · budget variance · recovery',
    src: 'Finance + Quotation manual weekly entry — mostly blank', status: 'PENDING' },
];

// Per-family weight presets (each row sums to 100): [Quantity, Quality, Time, Cost]
export const WEIGHT_PRESETS = [
  { fam: 'Sales / Coordination', w: [35, 25, 25, 15] },
  { fam: 'Estimation / Quotation', w: [20, 30, 20, 30] },
  { fam: 'Procurement', w: [25, 20, 20, 35] },
  { fam: 'Finance / Accounts', w: [15, 25, 20, 40] },
  { fam: 'Operations / Site', w: [35, 30, 25, 10] },
  { fam: 'HR', w: [30, 35, 25, 10] },
  { fam: 'Executive / MD', w: [20, 20, 20, 40] },
];

// Universal 20-pt activity bucket every role carries on top of its 80-pt QQTC.
export const ACTIVITY_BUCKET = {
  label: 'Delegations + Help Tickets + PMS', weight: 20,
  rows: [
    ['Delegations closed', '≥90% of assigned', '/delegations', 8],
    ['Help tickets resolved', '≥90% in SLA', '/help-tickets', 6],
    ['PMS tasks done', '≥90% of assigned', '/pms-tasks', 6],
  ],
};

// Gamification — Lead→Handover pipeline. Master score = handovers (cash) / month.
export const GAME = {
  master: 'Projects handed over per month (cash realized)',
  stages: [
    ['Lead Capture', 'Qualified leads/wk', '<10 qual/wk', 'Sales Coordinator', 'Streak: days with ≥1 source-tagged lead'],
    ['Qualification', 'Qual → quote %', '<40% to quote', 'Sales Coordinator', 'Level-up at 40% qualify rate'],
    ['Quotation', 'Quotes out ≤4 d', 'any quote >4 d', 'Rajeev Sood', 'Quote-in-4 leaderboard'],
    ['Negotiation', 'Win-rate ≥40%', 'margin <18%', 'Sales Head (vacant)', 'Badge: deal ≥18% margin'],
    ['Design Approval', 'Approvals ≤48 h', 'any >48 h', 'Estimation (Asad)', 'Combo: 5 approvals no rework'],
    ['Procurement/Kitting', 'Full-kit ready %', 'kit incomplete', 'Raj Kumar', 'Streak: 0 incomplete releases'],
    ['Production/Site', 'DPR filed %', 'any DPR missed', 'Operations Lead (GAP)', 'Daily DPR streak per site'],
    ['QC / Snags', 'Snags closed ≤7 d', 'any snag >7 d', 'Site Engineer', 'First-pass-yield leaderboard'],
    ['Dispatch', 'On-time dispatch', 'late dispatch', 'Procurement', '—'],
    ['Installation', 'Milestone on-time %', 'any slip', 'Site Engineer', 'Level per milestone hit'],
    ['Billing', 'RA bill ≤24 h of milestone', 'any unbilled milestone', 'Billing (GAP)', '★ Constraint stage — biggest points'],
    ['Handover / Cash', 'Cash collected/mo', 'any AR >30 d', 'Collections (GAP)', '★ Master score — only number that wins'],
  ],
  guardrail: 'Anti-gaming (Rule 8): a stage scores ONLY when its unit passes downstream. Quotes sent, leads logged, or POs raised earn nothing until they convert to a billed, collected handover.',
};

// Whole-ERP module audit — RACI + QQTC + Goldratt's 8 Rules of Flow.
// owner "GAP" = ownerless. touch = touches the binding constraint (Bill→Cash).
// Red-flag figures are illustrative (from the Operating Console) until that
// feed is confirmed live; ownership + fix recommendations are the real design.
export const MODULE_AUDIT = [
  { mod: 'Sales Billing (/installation)', owner: 'GAP', backup: '—', q: 'No', rules: '1, 3, 8',
    red: 'Only 5 of 69 POs billed · billed share 0% · ₹17.36 cr order book vs ₹1.1 L revenue MTD',
    fix: 'ASSIGN BILLING ENGINEER NOW — this seat owns the binding constraint. Bill the 64 unbilled POs.', touch: true },
  { mod: 'Finance · Collections · AR/AP', owner: 'Aanchal Sharma', backup: 'Parul Goyal*', q: 'Partial', rules: '3, 8',
    red: '₹0 collected in 90 d · top-5 debtors ₹206 L · AR-aging metric broken (shows 0 d)',
    fix: 'Add a Collections Officer; triage by ₹ outstanding; fix AR-aging date capture. *Parul mis-assigned to Cash-Flow template.', touch: true },
  { mod: 'Projects · Site · DPR · Snags', owner: 'GAP', backup: 'Site Engineers (5)', q: 'Partial', rules: '1, 2, 6',
    red: 'DPR adherence 0% (78/78 missed) · 22 open snags (4 critical, oldest 43 d) · ₹62.2 L locked at sites',
    fix: 'Assign Operations Lead (Pradeep template unassigned). No indent released without DPR filed (Rule 2 Full-Kit).', touch: true },
  { mod: 'Procurement · Vendors · Items', owner: 'Raj Kumar', backup: 'Ajmer', q: 'Yes', rules: '2, 7',
    red: '10 junk PO numbers = ₹1.32 cr · DPO 0 (no vendor credit) · ₹62.2 L inventory reserved',
    fix: 'Standardise PO numbering; negotiate DPO 0→45 d with top-3 vendors; full-kit check before release.', touch: true },
  { mod: 'Inventory · Assets · Tools', owner: 'GAP', backup: '—', q: 'No', rules: '1, 6',
    red: '₹62.2 L reserved at sites = cash locked · no slow/dead-stock detection',
    fix: 'Assign a Store/Inventory In-charge with scorecard; add slow-moving (180 d) + dead (365 d) flags.', touch: true },
  { mod: 'Quotes & Orders · Estimation', owner: 'Rajeev Sood', backup: 'MD.Asad Ali', q: 'Yes', rules: '2, 4',
    red: '0 quotes logged sent in 90 d (vs 168 leads) · quote lead-time data gap',
    fix: 'Link quotations.lead_id; enforce Quote-in-4 SLA; decline <18% margin.', touch: true },
  { mod: 'CRM · Sales Funnel · Customers', owner: 'Lovely Sharma', backup: 'Sushila', q: 'Partial', rules: '6, 8',
    red: '168 leads → 12 qualified (−93%) · 36 leads "Unknown" source · top-2 customer concentration 53%',
    fix: 'Capture loss_reason on close; reward qualified→PO not lead volume (Rule 8); diversify beyond top-2 clients.', touch: false },
  { mod: 'Solar Division', owner: 'GAP', backup: '—', q: 'No', rules: '1, 8',
    red: 'No KPI template owner · 119 deals tracked off-ERP, unmeasured here',
    fix: 'Assign a Solar Sales/Delivery owner; fold solar funnel into the same scorecard + TOC view.', touch: false },
  { mod: 'Fire NOC · Compliance · Tender', owner: 'GAP', backup: '—', q: 'No', rules: '2, 7',
    red: 'Parul — Compliance & Tender template unassigned (Parul Goyal mis-routed to Cash-Flow)',
    fix: 'Re-assign Parul Goyal → Compliance & Tender (her actual function).', touch: false },
  { mod: 'HRMS · Attendance · Payroll', owner: 'Ruksana', backup: 'Ankush Sharma', q: 'Partial', rules: '2',
    red: 'Attendance capture 0% (0 of 74 present) · statutory dues "capture needed" (Salary/TDS 7-Jul)',
    fix: 'Fix attendance capture (biometric/app sync); pre-load statutory calendar.', touch: false },
  { mod: 'Performance · Scorecard · Champions', owner: 'Anmol', backup: 'Monika Devi', q: 'Yes', rules: '5, 8',
    red: '0 score_entries in 30 d · 53 of 79 staff unowned · template weights = 130% (≠100)',
    fix: 'This is the measurement system for the constraint — wire it first. Re-tag KPIs to QQTC; rewards must = throughput.', touch: false },
  { mod: 'Tasks · Delegations · PMS · Checklists', owner: 'Anmol', backup: '—', q: 'Partial', rules: '8',
    red: 'These are the activity metrics — must stay capped at the 20% weight, never the 80%',
    fix: 'Hold Delegation+Tickets+PMS combined at 20%; never let activity outscore revenue-touching output (Rule 8).', touch: false },
  { mod: 'Service Desk · Complaints · Help Tickets', owner: 'GAP', backup: '—', q: 'No', rules: '6',
    red: 'No dedicated owner (folded into Sales Coordinator) · repeat tickets = rework signal',
    fix: 'Name a CX owner; root-cause repeat tickets (Rule 6) rather than just closing them.', touch: false },
  { mod: 'Executive · War Room · Console · TOC', owner: 'Ankur Kaplesh (CMD)', backup: 'Nitin Jain (COO)', q: 'n/a', rules: '—',
    red: 'Console is sound; its numbers are only as good as the capture feeding it (CCC/DSO corrupted)',
    fix: 'Keep as the single source of constraint truth. Delegate execution enforcement to COO to cut CMD-approval load.', touch: true },
  { mod: 'Admin · IT · Users · Email · AI', owner: 'GAP', backup: 'ashutosh / Durgesh', q: 'No', rules: '7',
    red: 'Pervasive data-capture gaps are an IT/process-ownership issue (no KPI template for IT)',
    fix: 'Give IT Head a scorecard; IT owns the invoice-on-milestone + lead-quote-link builds that break the constraint.', touch: true },
];

// Flow-rule legend (Goldratt's 8 Rules of Flow) used by the Module Audit tab.
export const FLOW_RULES = '1 WIP · 2 Full-Kit · 3 Triage · 4 Synchronize · 5 Dosage · 6 Rework · 7 Standardize · 8 Local-optimum';

// Weekly scorecard design — one QQTC card per DESIGNATION.
//   w = [Quantity, Quality, Time, Cost] (sums to 80); +20 universal activity.
//   m = up to 4 metrics: [KPI, weekly target, ERP source]. who = proposed owner.
export const DESIGNATIONS = [
  { role: 'CMD — Chairman & Managing Director', who: 'Ankur Kaplesh', fam: 'Executive', w: [16, 16, 16, 32],
    m: [['Decisions / approvals cleared', '= all pending each wk', '/dashboard/cmd'], ['Decisions not reversed / reopened', '≥95%', '/audit-log'], ['Avg approval turnaround', '≤24 h', '/delegations'], ['Throughput — cash handed over / wk', '↑ vs last wk', '/collections']] },
  { role: 'COO — Chief Operating Officer', who: 'Nitin Jain', fam: 'Executive', w: [24, 20, 20, 16],
    m: [['Projects dispatched / handed over / wk', '↑ master throughput', '/dashboard/cmd'], ['On-time milestone % across sites', '≥95%', '/solar-projects'], ['Quote-in-4 + DPR-before-indent enforced', '≥95%', '/quotations'], ['Project margin variance (worst-5)', '≤5%', '/expenses']] },
  { role: 'Operations Lead', who: 'GAP — recommend Pradeep', fam: 'Operations', w: [28, 24, 20, 8],
    m: [['Active sites with DPR filed', '= all live sites', '/dpr'], ['Snags closed vs opened (first-pass)', '≥90%', '/snags'], ['Avg snag closure time', '≤7 days', '/snags'], ['Site labour ₹ vs plan', '≤100% of budget', '/indent-labour-payment']] },
  { role: 'Site Engineer', who: 'Aakash · Gagandeep · Raushan · Samsad · kuldeepak', fam: 'Operations', w: [28, 24, 20, 8],
    m: [['DPR filed (days)', '6 / 6', '/dpr'], ['Milestones first-pass (no rework)', '≥90%', '/snags'], ['Milestones on-time', '≥95%', '/solar-projects'], ['Material indent vs BOQ', '≤100% (no over-draw)', '/procurement']] },
  { role: 'Supervisor', who: 'Amit · Ankit Raj · Gautam · Gurcharan · Kuldeep B · Taranpreet · Tenzin', fam: 'Operations', w: [28, 24, 20, 8],
    m: [['Daily site report + photos filed', '6 / 6', '/dpr'], ['Full-kit verified before work (Rule 2)', '≥95%', '/crm-kitting'], ['Manpower attendance logged on time', '≥95%', '/attendance'], ['Site stock variance', '≤2%', '/inventory']] },
  { role: 'Mechanical / Electrical Engineer', who: 'Avinash Agrawal · Punit Yadav', fam: 'Operations', w: [28, 24, 20, 8],
    m: [['Drawings / site coordination cleared', '≥ target / wk', '/solar-projects'], ['Design first-pass approval', '≥90%', '/snags'], ['Design turnaround', '≤ target days', '/dpr'], ['Design-to-BOQ variance', '≤5%', '/estimator']] },
  { role: 'Finance Executive', who: 'Aanchal', fam: 'Finance', w: [12, 20, 16, 32],
    m: [['Payment requests processed', '= queue / wk', '/payment-required'], ['Reconciliation accuracy (no disputes)', '≥98%', '/ar-ap-tracker'], ['Expense approval turnaround', '≤48 h', '/expenses'], ['Overdue recovery + expense control ₹', 'recovery ↑', '/collections']] },
  { role: 'Cash Flow Manager', who: 'GAP — Parul Goyal mis-assigned here', fam: 'Finance', w: [12, 20, 16, 32],
    m: [['Invoices raised', '= billable milestones', '/billing'], ['Billing accuracy (no credit notes)', '≥98%', '/billing'], ['Bill within 24 h of milestone', '≥90%', '/installation'], ['DSO (collections)', '≤60 days', '/ar-ap-tracker']] },
  { role: 'Accounts', who: 'GAP — recommend Shubham', fam: 'Finance', w: [12, 20, 16, 32],
    m: [['Indents compared / budgeted', '= volume / wk', '/procurement'], ['Budget-variance flag accuracy', '≥95%', '/expenses'], ['Statutory filings on time (TDS/GST/PF)', '100% by due date', '/expenses'], ['Cost savings identified ₹', '↑ / wk', '/expenses']] },
  { role: 'Billing Engineer', who: 'GAP — recommend Indresh', fam: 'Finance', w: [16, 20, 20, 24],
    m: [['RA bills + MB sheets raised', '= milestones reached', '/installation'], ['Bill rejection rate by client', '≤5%', '/billing'], ['RA bill within 24 h of milestone', '≥90%', '/installation'], ['Unbilled WIP ₹ closed', '↓ WIP / wk', '/billing']] },
  { role: 'Procurement Manager', who: 'Raj Kumar', fam: 'Procurement', w: [20, 16, 16, 28],
    m: [['POs released vs indents', '= demand / wk', '/procurement'], ['Full-kit complete on dispatch (Rule 2)', '≥95%', '/procurement'], ['Indent → dispatch turnaround', '≤ SLA days', '/procurement'], ['Rate savings + credit period (DPO)', 'savings ↑ · DPO ≥45 d', '/vendors']] },
  { role: 'Procurement Lead', who: 'Ajmer', fam: 'Procurement', w: [20, 16, 16, 28],
    m: [['RFQs cleared', '= queue / wk', '/price-required'], ['Vendor quote completeness', '≥95%', '/vendors'], ['RFQ → rate turnaround', '≤4 days', '/price-required'], ['Transport + negotiation savings ₹', '↑ / wk', '/vendors']] },
  { role: 'Estimation & Costing Head', who: 'MD.Asad Ali (+ Brijesh, Shubham S.)', fam: 'Estimation', w: [16, 24, 16, 24],
    m: [['BOQs delivered', '≥ target / wk', '/estimator'], ['Costing accuracy (actual vs estimate)', '≤5% variance', '/po-foc-stripped'], ['BOQ turnaround from RFQ', '≤4 days', '/estimator'], ['Tender margin maintained', '≥18%', '/quotations']] },
  { role: 'Quotation Engineer', who: 'Rajeev Sood', fam: 'Estimation', w: [16, 24, 16, 24],
    m: [['Quotations sent', '= qualified leads', '/quotations'], ['Quote → PO conversion', '≥40%', '/crm-funnel'], ['Quote within 4 days of RFQ', '≥90% (Quote-in-4)', '/quotations'], ['Quoted margin accuracy', '≥18%', '/po-foc-stripped']] },
  { role: 'Sales Coordinator (Ops)', who: 'Lovely Sharma · Sushila', fam: 'Sales', w: [28, 20, 20, 12],
    m: [['Leads qualified + follow-ups', '≥ target / wk', '/leads'], ['Complaint rate / data completeness', '≤ target', '/complaints'], ['Lead response time', '≤24 h', '/leads'], ['Avg ticket size + full-kitting ₹', '↑', '/crm-kitting']] },
  { role: 'Sales Coordinator (Sales Side)', who: 'GAP — recommend Riti', fam: 'Sales', w: [28, 20, 20, 12],
    m: [['Meetings booked', '≥ target / wk', '/crm-funnel'], ['Meeting → qualified %', '≥ target', '/crm-funnel'], ['Response / lead time', '≤24 h', '/leads'], ['Avg ticket value ₹', '↑', '/business-book']] },
  { role: 'HR — Hiring', who: 'Ruksana', fam: 'HR', w: [24, 28, 20, 8],
    m: [['Positions closed (secured + sub-con)', '= open reqs / wk', '/hr'], ['90-day retention of hires', '≥85%', '/employees'], ['Time-to-fill', '≤ target days', '/subcon-hiring'], ['Cost per hire ₹', '≤ budget', '/payroll']] },
  { role: 'HR Ops + Marketing', who: 'Ankush Sharma', fam: 'HR', w: [24, 28, 20, 8],
    m: [['Onboardings + trainings + posts', '≥ target / wk', '/induction'], ['Complaint resolution + training completion', '≥90%', '/training'], ['Onboarding TAT + payroll on time', '≤ target', '/payroll'], ['Marketing leads generated', '↑ / wk', '/leads']] },
  { role: 'Compliance & Tender', who: 'GAP — reassign Parul Goyal here', fam: 'Estimation', w: [16, 24, 16, 24],
    m: [['Tenders submitted', '= live tenders / wk', '/quotations'], ['Compliance docs complete (no rejection)', '≥95%', '/fire-noc'], ['Fire-NOC + statutory renewals before due', '100%', '/fire-noc'], ['Bad-debt / litigation ₹ avoided-recovered', '↑', '/ar-ap-tracker']] },
  { role: 'AI Implementation Head', who: 'Monika Devi', fam: 'Tech', w: [24, 24, 16, 16],
    m: [['Automations shipped', '≥ target / wk', '/admin/ai-settings'], ['Adoption / uptime of automations', '≥90%', '/admin/ai-settings'], ['Rollout milestones on time', '≥90%', '/delegations'], ['Hours saved ₹ (ROI)', '↑ / wk', '/dashboard/cmd']] },
  { role: 'IT / Software Developer', who: 'ashutosh bhardwaj · Durgesh Sharma', fam: 'Tech', w: [24, 28, 24, 4],
    m: [['Features / fixes shipped', '≥ target / wk', '/help-tickets'], ['Bug / rework rate', '≤ target', '/help-tickets'], ['Ticket resolution SLA', '≤ target', '/help-tickets'], ['Uptime / infra cost', '≥99% · ≤ budget', '/admin/backups']] },
  { role: 'DPR / Scorecard Analyst', who: 'Anmol', fam: 'Support', w: [30, 30, 20, 0],
    m: [['DPRs collected + scorecards published', '= all sites / wk', '/dpr'], ['Scorecard data accuracy', '≥98%', '/scorecard'], ['Weekly MIS published on time (Mon)', '100%', '/scorecard'], ['—', 'folded into Quantity/Quality', '—']] },
  { role: 'DEO — Data Entry Operator', who: 'Nancy', fam: 'Support', w: [30, 30, 20, 0],
    m: [['Records entered', '= queue / wk', '/checklists'], ['Entry accuracy / error rate', '≥99%', '/checklists'], ['Same-day entry', '≥95%', '/checklists'], ['—', 'folded into Quantity/Quality', '—']] },
  { role: 'EA — Executive Assistant', who: 'Sheetal', fam: 'Support', w: [30, 30, 20, 0],
    m: [['CMD tasks / calendar items handled', '= all / wk', '/delegations'], ['Zero-miss on scheduled items', '≥98%', '/delegations'], ['Same-day turnaround', '≥95%', '/delegations'], ['—', 'folded into Quantity/Quality', '—']] },
];

// Compute a person's QQTC row from the live /api/scoring/weekly shape.
//   u = { delegations:{given,done}, pms:{...}, checklists:{...}, tickets:{...}, score }
//   maxDone = the highest total_done across all people (for the Quantity index).
//   timeScore = on-time % from /api/raci/performance if matched, else null (pending).
export function computeQQTC(u, maxDone, timeScore) {
  const done = u.delegations.done + u.pms.done + u.checklists.done + u.tickets.done;
  const given = u.delegations.given + u.pms.given + u.checklists.given + u.tickets.given;
  const quantity = maxDone > 0 ? Math.round((done / maxDone) * 100) : 0;
  const quality = given > 0 ? Math.round((done / given) * 100) : null; // null = nothing assigned
  const time = timeScore == null ? null : timeScore;
  // Live composite: average of the pillars that have data this week.
  const live = [quantity, quality, time].filter(v => v != null);
  const composite = live.length ? Math.round(live.reduce((a, b) => a + b, 0) / live.length) : 0;
  return { done, given, quantity, quality, time, composite };
}
