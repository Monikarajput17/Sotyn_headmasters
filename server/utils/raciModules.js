// RACI module definitions — one place that declares, for every module that has
// the per-record RACI + SLA "Responsible" tab, (1) its ordered steps and (2)
// how to read each record's per-step COMPLETION timestamp from that module's
// existing columns / logs. The generic board endpoint in routes/raci.js turns
// these into elapsed-time + late-by figures, so adding a module is just adding
// an entry here — no bespoke timing code per page (mam 2026-06-27: roll the
// Payables RACI pilot out to every module as a pill tab).
//
// Each module: { label, steps:[{key,label,default_sla?}], rows(db) -> [{
//   id, title, subtitle, created_at, stamps:{stepKey: tsOrNull}, current_key }] }
// `stamps[k]` = when step k completed (null if not yet / not captured).
// `current_key` = the step currently in progress (for "waiting NOW" elapsed).

const safeAll = (db, sql, ...p) => { try { return db.prepare(sql).all(...p); } catch (e) { return []; } };

// Parse a SQLite timestamp as UTC (CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS'
// in UTC; without the Z, Date.parse would read it as local time). Shared with
// the same logic Payables uses so every module's clock agrees.
function tsMs(s) {
  if (s == null) return null;
  if (s instanceof Date) return s.getTime();
  let str = String(s).trim();
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(str)) str = str.replace(' ', 'T') + 'Z';
  else if (/^\d{4}-\d{2}-\d{2}$/.test(str)) str = str + 'T00:00:00Z';
  const t = Date.parse(str);
  return Number.isNaN(t) ? null : t;
}

// First step (in declared order) whose stamp is still null = the one in flight.
// Returns null when every step is done (record fully closed).
function firstOpen(steps, stamps) {
  for (const s of steps) if (!stamps[s.key]) return s.key;
  return null;
}

const MODULE_DEFS = {
  // ── Payables (the original pilot) — timing from payment_approvals ────────
  payables: {
    label: 'Payables (Payment Required)',
    steps: [
      { key: '0', label: 'HR Approval' },
      { key: '1', label: 'L1 Approval (Accountant)' },
      { key: '2', label: 'L2 Approval' },
      { key: '3', label: 'L3 Approval (MD)' },
      { key: '5', label: 'Payment Release' },
    ],
    rows(db) {
      const recs = safeAll(db, `
        SELECT id, request_no, vendor_name, employee_name, category, purpose,
               current_step, status, created_at, created_by
          FROM payment_requests ORDER BY created_at DESC LIMIT 500`);
      const ids = recs.map(r => r.id);
      const appr = {};
      if (ids.length) {
        for (let i = 0; i < ids.length; i += 900) {
          const chunk = ids.slice(i, i + 900);
          const ph = chunk.map(() => '?').join(',');
          for (const a of safeAll(db, `
            SELECT request_id, step, MIN(approved_at) at FROM payment_approvals
             WHERE action='approved' AND request_id IN (${ph})
             GROUP BY request_id, step`, ...chunk)) {
            (appr[a.request_id] = appr[a.request_id] || {})[String(a.step)] = a.at;
          }
        }
      }
      const done = new Set(['final_approved', 'rejected']);
      return recs.map(r => {
        const a = appr[r.id] || {};
        const stamps = { '0': a['0'] || null, '1': a['1'] || null, '2': a['2'] || null, '3': a['3'] || null, '5': a['5'] || null };
        return {
          id: r.id,
          title: r.request_no || ('PR #' + r.id),
          subtitle: r.vendor_name || r.employee_name || r.purpose || r.category || '—',
          created_at: r.created_at,
          owner_id: r.created_by || null,
          stamps,
          current_key: done.has(r.status) ? null : String(r.current_step),
        };
      });
    },
  },

  // ── CRM Sales Funnel (3-step) ───────────────────────────────────────────
  crm_funnel: {
    label: 'CRM Sales Funnel',
    steps: [
      { key: 'quotation', label: 'Quotation' },
      { key: 'negotiation', label: 'Negotiation' },
      { key: 'winloss', label: 'Win / Loss' },
    ],
    rows(db) {
      return safeAll(db, `
        SELECT id, lead_no, client_name, company_name, created_at, created_by,
               quotation_submit_date, closed_at, final_status
          FROM crm_funnel ORDER BY created_at DESC LIMIT 500`).map(r => {
        const stamps = { quotation: r.quotation_submit_date || null, negotiation: null, winloss: r.closed_at || null };
        return {
          id: r.id,
          title: r.lead_no || ('Lead #' + r.id),
          subtitle: r.client_name || r.company_name || '—',
          created_at: r.created_at,
          // owner_id = the lead's creator (the salesperson). The board defaults
          // each step's Responsible to this person so the By-Person scoring view
          // fills in without anyone hand-assigning RACI on 53 leads (mam 2026-06-27).
          owner_id: r.created_by || null,
          stamps,
          // negotiation has no timestamp; treat it as "current" once quoted and not closed.
          current_key: r.closed_at ? null : (r.quotation_submit_date ? 'negotiation' : 'quotation'),
        };
      });
    },
  },

  // ── Sales Funnel (7-stage, explicit per-stage date columns) ─────────────
  sales_funnel: {
    label: 'Sales Funnel',
    steps: [
      { key: 'qualified', label: 'Qualified' },
      { key: 'meeting', label: 'Meeting' },
      { key: 'mom', label: 'MOM' },
      { key: 'drawing', label: 'Drawing' },
      { key: 'boq', label: 'BOQ' },
      { key: 'quotation', label: 'Quotation' },
      { key: 'result', label: 'Result (Win/Loss)' },
    ],
    rows(db) {
      const steps = this.steps;
      return safeAll(db, `
        SELECT id, lead_no, client_name, created_at, created_by, current_stage,
               qualified_date, meeting_date, mom_date, drawing_date, boq_date,
               quotation_sent_date, result_date
          FROM sales_funnel ORDER BY created_at DESC LIMIT 500`).map(r => {
        const stamps = {
          qualified: r.qualified_date || null, meeting: r.meeting_date || null,
          mom: r.mom_date || null, drawing: r.drawing_date || null, boq: r.boq_date || null,
          quotation: r.quotation_sent_date || null, result: r.result_date || null,
        };
        return {
          id: r.id, title: r.lead_no || ('Lead #' + r.id), subtitle: r.client_name || '—',
          created_at: r.created_at, owner_id: r.created_by || null, stamps,
          current_key: r.current_stage === 'lost' ? null : firstOpen(steps, stamps),
        };
      });
    },
  },

  // ── Solar Sales Funnel (8-stage, timing from solar_deal_events) ─────────
  solar_funnel: {
    label: 'Solar Sales Funnel',
    steps: [
      { key: 'inquiry', label: 'New Inquiry', default_sla: 48 },
      { key: 'qualification', label: 'Qualification', default_sla: 72 },
      { key: 'survey', label: 'Site Survey', default_sla: 120 },
      { key: 'design', label: 'Design & BOQ', default_sla: 96 },
      { key: 'quotation', label: 'Quotation Sent', default_sla: 120 },
      { key: 'negotiation', label: 'Negotiation', default_sla: 168 },
      { key: 'approval', label: 'Approval', default_sla: 168 },
      { key: 'won', label: 'Won', default_sla: 0 },
    ],
    rows(db) {
      const steps = this.steps;
      const order = steps.map(s => s.key);
      const deals = safeAll(db, `
        SELECT id, deal_no, client_name, company, created_at, stage, status, owner_id
          FROM solar_deals ORDER BY created_at DESC LIMIT 500`);
      const ids = deals.map(d => d.id);
      // entryTime[dealId][stageKey] = first time the deal ENTERED that stage.
      const entry = {};
      if (ids.length) {
        for (let i = 0; i < ids.length; i += 900) {
          const chunk = ids.slice(i, i + 900);
          const ph = chunk.map(() => '?').join(',');
          for (const e of safeAll(db, `
            SELECT deal_id, to_stage, MIN(created_at) at FROM solar_deal_events
             WHERE to_stage IS NOT NULL AND deal_id IN (${ph})
             GROUP BY deal_id, to_stage`, ...chunk)) {
            (entry[e.deal_id] = entry[e.deal_id] || {})[e.to_stage] = e.at;
          }
        }
      }
      return deals.map(d => {
        const en = entry[d.id] || {};
        // A stage is "completed" when the deal entered the NEXT stage.
        const stamps = {};
        order.forEach((k, idx) => {
          const next = order[idx + 1];
          stamps[k] = next ? (en[next] || null) : (d.status === 'won' ? (en.won || d.stage_updated_at || null) : null);
        });
        return {
          id: d.id, title: d.deal_no || ('Deal #' + d.id), subtitle: d.client_name || d.company || '—',
          created_at: d.created_at, owner_id: d.owner_id || null, stamps,
          current_key: (d.status === 'won' || d.status === 'lost') ? null : (d.stage || firstOpen(steps, stamps)),
        };
      });
    },
  },

  // ── Quotation (status-based; only created_at captured today) ─────────────
  quotation: {
    label: 'Quotation',
    steps: [
      { key: 'draft', label: 'Draft Created' },
      { key: 'sent', label: 'Sent to Client' },
      { key: 'negotiation', label: 'Under Negotiation' },
      { key: 'decided', label: 'Accepted / Rejected' },
    ],
    rows(db) {
      const statusStep = { draft: 'draft', sent: 'sent', negotiation: 'negotiation', accepted: 'decided', rejected: 'decided' };
      return safeAll(db, `
        SELECT id, quotation_number, status, created_at, created_by
          FROM quotations ORDER BY created_at DESC LIMIT 500`).map(r => {
        // Only the draft timestamp exists; later transitions aren't stamped yet
        // (mark-done stamps fill them in). RACI assignment still works per step.
        const stamps = { draft: r.created_at || null, sent: null, negotiation: null, decided: null };
        const cur = statusStep[r.status] || 'draft';
        return {
          id: r.id, title: r.quotation_number || ('QT #' + r.id), subtitle: (r.status || 'draft').toUpperCase(),
          created_at: r.created_at, owner_id: r.created_by || null, stamps,
          current_key: (r.status === 'accepted' || r.status === 'rejected') ? null : cur,
        };
      });
    },
  },

  // ── Indent to Dispatch (indent approvals → vendor PO → dispatch) ─────────
  indent_to_dispatch: {
    label: 'Indent to Dispatch',
    steps: [
      { key: 'raised', label: 'Indent Raised' },
      { key: 'l1', label: 'L1 Approval' },
      { key: 'l2', label: 'L2 Approval' },
      { key: 'crm', label: 'CRM Approval (billable)' },
      { key: 'approved', label: 'Final Approved' },
      { key: 'po_l1', label: 'PO L1 Approval' },
      { key: 'po_l2', label: 'PO L2 Approval' },
      { key: 'dispatch', label: 'Dispatch / Delivery' },
      { key: 'purchase_bill', label: 'Purchase Bill' },
    ],
    rows(db) {
      const steps = this.steps;
      return safeAll(db, `
        SELECT i.id, i.indent_number, i.site_name, i.created_at, i.created_by,
               i.l1_at, i.l2_at, i.crm_at, i.approved_at, i.status,
               (SELECT MIN(vp.po_l1_at) FROM vendor_pos vp WHERE vp.indent_id=i.id AND COALESCE(vp.cancelled,0)=0) AS po_l1_at,
               (SELECT MIN(vp.po_l2_at) FROM vendor_pos vp WHERE vp.indent_id=i.id AND COALESCE(vp.cancelled,0)=0) AS po_l2_at,
               (SELECT MIN(dn.created_at) FROM delivery_notes dn
                  JOIN vendor_pos vp ON vp.id=dn.vendor_po_id
                 WHERE vp.indent_id=i.id) AS dispatch_at,
               (SELECT MIN(pb.created_at) FROM purchase_bills pb
                  JOIN vendor_pos vp ON vp.id=pb.vendor_po_id
                 WHERE vp.indent_id=i.id) AS bill_at
          FROM indents i ORDER BY i.created_at DESC LIMIT 500`).map(r => {
        const stamps = {
          raised: r.created_at || null, l1: r.l1_at || null, l2: r.l2_at || null,
          crm: r.crm_at || null, approved: r.approved_at || null,
          po_l1: r.po_l1_at || null, po_l2: r.po_l2_at || null, dispatch: r.dispatch_at || null,
          purchase_bill: r.bill_at || null,
        };
        return {
          id: r.id, title: r.indent_number || ('IND #' + r.id), subtitle: r.site_name || '—',
          created_at: r.created_at, owner_id: r.created_by || null, stamps, current_key: firstOpen(steps, stamps),
        };
      });
    },
  },

  // ── Cheques (raised → settled action) ───────────────────────────────────
  cheques: {
    label: 'Cheques',
    steps: [
      { key: 'raised', label: 'Cheque Raised' },
      { key: 'settled', label: 'Cleared / Settled' },
    ],
    rows(db) {
      const steps = this.steps;
      return safeAll(db, `
        SELECT c.id, c.cheque_number, c.payee_to, c.bank_name, c.raised_at, c.raised_by, c.current_status,
               (SELECT MIN(ca.action_at) FROM cheque_actions ca WHERE ca.cheque_id=c.id) AS first_action_at
          FROM cheques c ORDER BY c.raised_at DESC LIMIT 500`).map(r => {
        const stamps = { raised: r.raised_at || null, settled: r.first_action_at || null };
        return {
          id: r.id, title: r.cheque_number || ('CHQ #' + r.id),
          subtitle: r.payee_to || r.bank_name || '—',
          created_at: r.raised_at, owner_id: r.raised_by || null, stamps,
          current_key: r.current_status === 'pending' ? 'settled' : firstOpen(steps, stamps),
        };
      });
    },
  },

  // ── Hiring (Sub-contractor 14-step workflow; real per-step completed_at) ──
  subcon_hiring: {
    label: 'Hiring (Sub-contractor)',
    steps: [
      { key: '1', label: 'Project Kickoff' },
      { key: '2', label: 'BOQ Scope Split' },
      { key: '3', label: 'Source Vendors' },
      { key: '4', label: 'Pre-Qualify' },
      { key: '5', label: 'RFQ & Negotiate' },
      { key: '6', label: 'Award Decision' },
      { key: '7', label: 'LOI to Vendor' },
      { key: '8', label: 'KYC & Vendor Master' },
      { key: '9', label: 'MSA + NDA' },
      { key: '10', label: 'Safety Induction' },
      { key: '11', label: 'Mobilization Plan' },
      { key: '12', label: 'Issue Work Order' },
      { key: '13', label: 'Mobilization Advance' },
      { key: '14', label: 'Site Entry & Setup' },
    ],
    rows(db) {
      const steps = this.steps;
      const recs = safeAll(db, `
        SELECT sh.id, sh.scope_description, sh.current_step, sh.created_at, sh.created_by, s.name AS site_name
          FROM subcon_hiring sh LEFT JOIN sites s ON s.id = sh.site_id
         ORDER BY sh.created_at DESC LIMIT 500`);
      const ids = recs.map(r => r.id);
      const byId = {};
      if (ids.length) {
        for (let i = 0; i < ids.length; i += 900) {
          const chunk = ids.slice(i, i + 900);
          const ph = chunk.map(() => '?').join(',');
          for (const st of safeAll(db, `
            SELECT hiring_id, step_no, completed_at FROM subcon_hiring_steps
             WHERE hiring_id IN (${ph})`, ...chunk)) {
            (byId[st.hiring_id] = byId[st.hiring_id] || {})[String(st.step_no)] = st.completed_at || null;
          }
        }
      }
      return recs.map(r => {
        const done = byId[r.id] || {};
        const stamps = {};
        steps.forEach(s => { stamps[s.key] = done[s.key] || null; });
        const cur = +r.current_step;
        return {
          id: r.id,
          title: r.site_name || ('Hiring #' + r.id),
          subtitle: (r.scope_description || '—').slice(0, 60),
          created_at: r.created_at, owner_id: r.created_by || null, stamps,
          current_key: (cur >= 1 && cur <= 14) ? String(cur) : firstOpen(steps, stamps),
        };
      });
    },
  },

  // ── DPR (daily report: Submit → Approve) ──────────────────────────────────
  // High-volume daily record. Submit is owned by submitted_by (timed via
  // submission_time); Approve is owned by approved_by but DPR has NO approval
  // timestamp column, so Approve is timed only if someone marks it done.
  dpr: {
    label: 'DPR (Daily Project Report)',
    steps: [
      { key: 'submit', label: 'Submit' },
      { key: 'approve', label: 'Approve' },
    ],
    rows(db) {
      return safeAll(db, `
        SELECT id, report_date, submission_time, created_at, submitted_by, approved_by,
               approval_status, site_id
          FROM dpr ORDER BY report_date DESC, id DESC LIMIT 500`).map(r => ({
        id: r.id,
        title: 'DPR ' + (r.report_date || ('#' + r.id)),
        subtitle: 'Site #' + (r.site_id || '—'),
        created_at: r.created_at || r.report_date,
        owner_id: r.submitted_by || null,
        step_owners: { submit: r.submitted_by || null, approve: r.approved_by || null },
        stamps: { submit: r.submission_time || r.report_date || r.created_at || null, approve: null },
        current_key: r.approval_status === 'approved' ? null : 'approve',
      }));
    },
  },

  // ── Sales Billing (per-bill lifecycle: Raise → Approve → Send → Paid) ──────
  // Step times come from sales_bill_status_log (approved/sent/paid changed_at),
  // with sent_at as a fallback for Send. Each step is owned by whoever performed
  // it (changed_by), defaulting Raise to the bill's creator.
  sales_billing: {
    label: 'Sales Billing',
    steps: [
      { key: 'raise', label: 'Raise' },
      { key: 'approve', label: 'Approve' },
      { key: 'send', label: 'Send' },
      { key: 'paid', label: 'Paid' },
    ],
    rows(db) {
      const bills = safeAll(db, `
        SELECT id, bill_number, bill_type, customer_name, project_name,
               created_at, created_by, sent_at
          FROM sales_bills WHERE bill_type IS NOT NULL
         ORDER BY created_at DESC LIMIT 500`);
      if (!bills.length) return [];
      const ids = bills.map(b => b.id);
      const logByBill = {};
      for (let i = 0; i < ids.length; i += 400) {
        const chunk = ids.slice(i, i + 400);
        const ph = chunk.map(() => '?').join(',');
        for (const l of safeAll(db, `
          SELECT sales_bill_id, status, changed_by, changed_at
            FROM sales_bill_status_log WHERE sales_bill_id IN (${ph})
           ORDER BY changed_at ASC`, ...chunk)) {
          (logByBill[l.sales_bill_id] = logByBill[l.sales_bill_id] || []).push(l);
        }
      }
      const lastOf = (logs, st) => { let f = null; for (const l of logs) if (l.status === st) f = l; return f; };
      return bills.map(b => {
        const logs = logByBill[b.id] || [];
        const apr = lastOf(logs, 'approved'), snt = lastOf(logs, 'sent'), pad = lastOf(logs, 'paid');
        const stamps = {
          raise: b.created_at || null,
          approve: apr ? apr.changed_at : null,
          send: b.sent_at || (snt ? snt.changed_at : null) || null,
          paid: pad ? pad.changed_at : null,
        };
        const step_owners = {
          raise: b.created_by || null,
          approve: apr ? apr.changed_by : null,
          send: snt ? snt.changed_by : null,
          paid: pad ? pad.changed_by : null,
        };
        return {
          id: b.id,
          title: b.bill_number || ('Bill #' + b.id),
          subtitle: b.customer_name || b.project_name || ('Type ' + b.bill_type),
          created_at: b.created_at,
          owner_id: b.created_by || null,
          step_owners, stamps,
          current_key: stamps.paid ? null : (!stamps.approve ? 'approve' : (!stamps.send ? 'send' : 'paid')),
        };
      });
    },
  },

  // ── Collections (Receivables: Invoice → Contacted → Promised → Collected) ──
  // Cash-in lifecycle for ONE receivable. Contacted/Promised are timed from the
  // collection_follow_ups log (first follow-up, first one carrying a promise);
  // Collected fires when outstanding clears, timed by the last payment row in
  // collections. Covers "Cash Flow" too — mam 2026-06-27 chose Cash Flow =
  // Collection. Each step's doer defaults from the source rows so the board fills
  // without hand-assigning (scorecard still counts only explicit RACI names).
  collections: {
    label: 'Collections (Receivables)',
    steps: [
      { key: 'invoice', label: 'Invoice Raised' },
      { key: 'contacted', label: 'Contacted' },
      { key: 'promised', label: 'Promised' },
      { key: 'collected', label: 'Collected' },
    ],
    rows(db) {
      const steps = this.steps;
      const recs = safeAll(db, `
        SELECT id, client_name, invoice_number, invoice_date, outstanding_amount,
               owner_id, created_at, updated_at
          FROM receivables ORDER BY created_at DESC LIMIT 500`);
      if (!recs.length) return [];
      const ids = recs.map(r => r.id);
      const fu = {}, col = {};
      for (let i = 0; i < ids.length; i += 400) {
        const chunk = ids.slice(i, i + 400);
        const ph = chunk.map(() => '?').join(',');
        // Earliest follow-up = Contacted; earliest one carrying a promise = Promised.
        for (const f of safeAll(db, `
          SELECT receivable_id, follow_up_date, promised_date, followed_by
            FROM collection_follow_ups WHERE receivable_id IN (${ph})
           ORDER BY follow_up_date ASC, id ASC`, ...chunk)) {
          const e = fu[f.receivable_id] || (fu[f.receivable_id] = {});
          if (!e.contactAt) { e.contactAt = f.follow_up_date; e.contactBy = f.followed_by; }
          if (!e.promiseAt && f.promised_date) { e.promiseAt = f.follow_up_date; e.promiseBy = f.followed_by; }
        }
        // Latest payment = when Collected completed (ASC scan → last write wins).
        for (const c of safeAll(db, `
          SELECT receivable_id, collection_date, collected_by
            FROM collections WHERE receivable_id IN (${ph})
           ORDER BY collection_date ASC, id ASC`, ...chunk)) {
          col[c.receivable_id] = { at: c.collection_date, by: c.collected_by };
        }
      }
      return recs.map(r => {
        const paid = r.outstanding_amount != null && r.outstanding_amount <= 0;
        const e = fu[r.id] || {}, c = col[r.id] || {};
        const stamps = {
          invoice: r.invoice_date || r.created_at || null,
          contacted: e.contactAt || null,
          promised: e.promiseAt || null,
          collected: paid ? (c.at || r.updated_at || null) : null,
        };
        return {
          id: r.id,
          title: r.invoice_number || ('AR #' + r.id),
          subtitle: r.client_name || '—',
          created_at: r.created_at || r.invoice_date,
          owner_id: r.owner_id || null,
          step_owners: {
            invoice: r.owner_id || null,
            contacted: e.contactBy || null,
            promised: e.promiseBy || null,
            collected: c.by || null,
          },
          stamps,
          current_key: paid ? null : firstOpen(steps, stamps),
        };
      });
    },
  },
};

// RACI → scoring. Per-person weekly accountability across EVERY module, using
// the SAME sequential timing + Responsible defaulting as the board (Responsible
// = explicit assignment → module-wide default → step owner → record creator).
// Returns { stepsClosed, slaJudged, onTime, openOnUser, stepsPlanned } where:
//   stepsClosed — steps the user CLOSED within [sinceDate, untilDate] (Actual).
//   openOnUser  — steps still OPEN and sitting on the user right now (the step
//                 currently in-flight on an active record). This is their live
//                 pending workload, the "wk" Pending side of the scorecard.
//   stepsPlanned= stepsClosed + openOnUser → the Planned column: everything that
//                 was on their plate this week (done this week + still pending).
//                 mam 2026-06-27 chose weekly scope: Actual resets every Mon-Sat;
//                 Planned = that week's closures plus what is still open on them.
//   slaJudged   — of the closed steps, how many had an SLA (on-time denominator).
//   onTime      — of slaJudged, how many finished within SLA (the "Time" KPI).
function raciUserWeek(db, userId, sinceDate, untilDate) {
  const HOUR = 3600000;
  let stepsClosed = 0, slaJudged = 0, onTime = 0, openOnUser = 0;
  for (const key of Object.keys(MODULE_DEFS)) {
    const def = MODULE_DEFS[key];
    let recs;
    try { recs = def.rows(db) || []; } catch { continue; }
    if (!recs.length) continue;
    const ids = recs.map(r => r.id);
    const raciByRec = {};
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const ph = chunk.map(() => '?').join(',');
      for (const r of safeAll(db, `SELECT * FROM raci_assignment WHERE module=? AND record_id IN (${ph})`, key, ...chunk)) {
        (raciByRec[r.record_id] = raciByRec[r.record_id] || {})[r.step_key] = r;
      }
    }
    // Module-wide default RACI (record_id 0) — applies where a record has no own
    // assignment, so scoring matches the board's whole-module RACI (mam 2026-06-27).
    const md = {};
    for (const r of safeAll(db, `SELECT * FROM raci_assignment WHERE module=? AND record_id=0`, key)) md[r.step_key] = r;
    // Scorecard attribution: a step counts for a person ONLY where mam explicitly
    // named them in RACI — the per-record Responsible, else the whole-module
    // default (record_id 0). Deliberately NO fallback to the record's owner/
    // creator or the step's native doer (the board keeps those defaults; the
    // scorecard must not), so opening any person's card shows only the steps
    // assigned to their name (mam 2026-06-27: "show only where her name … from raci").
    const responsibleOf = (s, cfg, m, rec) => (cfg && cfg.responsible_id) || (m && m.responsible_id) || null;
    for (const rec of recs) {
      const recRaci = raciByRec[rec.id] || {};
      // current_key === null means the module considers the record done/cancelled,
      // so no step is in-flight → nothing pending on anyone for it.
      const recClosed = rec.current_key == null;
      let prev = tsMs(rec.created_at);
      let sawOpen = false;                             // only the FIRST open step is in-flight
      for (const s of def.steps) {
        const cfg = recRaci[s.key] || {};
        const m = md[s.key] || {};
        const responsibleId = responsibleOf(s, cfg, m, rec);
        // Completion = manual "mark done" stamp, else the module's native date.
        const stampRaw = (cfg && cfg.done_at) || (rec.stamps ? rec.stamps[s.key] : null) || null;
        if (!stampRaw) {
          // First unstamped step = the one in flight now. If it is on this user
          // and the record is still active, it is pending work on them (Planned).
          if (!sawOpen) {
            sawOpen = true;
            if (!recClosed && responsibleId === userId) openOnUser += 1;
          }
          continue;                                    // open → don't advance prev / don't close
        }
        const atMs = tsMs(stampRaw);
        let elapsed = null;
        if (atMs != null && prev != null) { elapsed = Math.max(0, (atMs - prev) / HOUR); prev = atMs; }
        if (responsibleId !== userId) continue;        // not this person's step
        const dateStr = String(stampRaw).slice(0, 10);
        if (dateStr < sinceDate || dateStr > untilDate) continue; // closed outside the week
        stepsClosed += 1;
        const sla = cfg.sla_hours != null ? +cfg.sla_hours : (m.sla_hours != null ? +m.sla_hours : (s.default_sla != null ? +s.default_sla : null));
        if (sla != null && elapsed != null) { slaJudged += 1; if (elapsed <= sla) onTime += 1; }
      }
    }
  }
  return { stepsClosed, slaJudged, onTime, openOnUser, stepsPlanned: stepsClosed + openOnUser };
}

// Same per-person weekly aggregate as raciUserWeek, but BROKEN DOWN per
// (module, step) instead of a single total — powers the scorecard's "step-wise"
// drill-down (mam 2026-06-27: "show step wise"). Each entry carries planned
// (= done this week + still open on them), actual (= closed this week), pending,
// the on-time tally, and up to 8 example pending record titles. Sorted in module
// declaration order, then step order within each module.
function raciUserWeekBreakdown(db, userId, sinceDate, untilDate) {
  const HOUR = 3600000;
  const acc = new Map();                              // `${module}|${stepKey}` -> tally
  const tallyFor = (mod, modLabel, stepKey, stepLabel, weight, commitment) => {
    const k = `${mod}|${stepKey}`;
    let t = acc.get(k);
    if (!t) {
      t = { module: mod, module_label: modLabel, step_key: stepKey, step_label: stepLabel,
            planned: 0, actual: 0, pending: 0, sla_judged: 0, on_time: 0, pending_records: [],
            // Per-step weightage % + "for next week" commitment, set at the module-default
            // level (record_id 0) in the ⚙ Responsible editor (mam 2026-06-29).
            weight: (weight != null && weight !== '') ? +weight : null,
            commitment: commitment || null };
      acc.set(k, t);
    }
    return t;
  };
  for (const key of Object.keys(MODULE_DEFS)) {
    const def = MODULE_DEFS[key];
    let recs;
    try { recs = def.rows(db) || []; } catch { continue; }
    if (!recs.length) continue;
    const ids = recs.map(r => r.id);
    const raciByRec = {};
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const ph = chunk.map(() => '?').join(',');
      for (const r of safeAll(db, `SELECT * FROM raci_assignment WHERE module=? AND record_id IN (${ph})`, key, ...chunk)) {
        (raciByRec[r.record_id] = raciByRec[r.record_id] || {})[r.step_key] = r;
      }
    }
    const md = {};
    for (const r of safeAll(db, `SELECT * FROM raci_assignment WHERE module=? AND record_id=0`, key)) md[r.step_key] = r;
    // Scorecard attribution: a step counts for a person ONLY where mam explicitly
    // named them in RACI — the per-record Responsible, else the whole-module
    // default (record_id 0). Deliberately NO fallback to the record's owner/
    // creator or the step's native doer (the board keeps those defaults; the
    // scorecard must not), so opening any person's card shows only the steps
    // assigned to their name (mam 2026-06-27: "show only where her name … from raci").
    const responsibleOf = (s, cfg, m, rec) => (cfg && cfg.responsible_id) || (m && m.responsible_id) || null;
    for (const rec of recs) {
      const recRaci = raciByRec[rec.id] || {};
      const recClosed = rec.current_key == null;
      let prev = tsMs(rec.created_at);
      let sawOpen = false;
      for (const s of def.steps) {
        const cfg = recRaci[s.key] || {};
        const m = md[s.key] || {};
        const responsibleId = responsibleOf(s, cfg, m, rec);
        const stampRaw = (cfg && cfg.done_at) || (rec.stamps ? rec.stamps[s.key] : null) || null;
        if (!stampRaw) {
          if (!sawOpen) {
            sawOpen = true;
            if (!recClosed && responsibleId === userId) {
              const t = tallyFor(key, def.label, s.key, s.label, m.weight, m.commitment);
              t.planned += 1; t.pending += 1;
              if (t.pending_records.length < 8) t.pending_records.push(rec.title);
            }
          }
          continue;
        }
        const atMs = tsMs(stampRaw);
        let elapsed = null;
        if (atMs != null && prev != null) { elapsed = Math.max(0, (atMs - prev) / HOUR); prev = atMs; }
        if (responsibleId !== userId) continue;
        const dateStr = String(stampRaw).slice(0, 10);
        if (dateStr < sinceDate || dateStr > untilDate) continue;
        const t = tallyFor(key, def.label, s.key, s.label, m.weight, m.commitment);
        t.planned += 1; t.actual += 1;
        const sla = cfg.sla_hours != null ? +cfg.sla_hours : (m.sla_hours != null ? +m.sla_hours : (s.default_sla != null ? +s.default_sla : null));
        if (sla != null && elapsed != null) { t.sla_judged += 1; if (elapsed <= sla) t.on_time += 1; }
      }
    }
  }
  const moduleOrder = Object.keys(MODULE_DEFS);
  const stepOrder = {};
  for (const k of moduleOrder) stepOrder[k] = Object.fromEntries(MODULE_DEFS[k].steps.map((s, i) => [s.key, i]));
  return Array.from(acc.values()).sort((a, b) => {
    const mo = moduleOrder.indexOf(a.module) - moduleOrder.indexOf(b.module);
    if (mo) return mo;
    return (stepOrder[a.module][a.step_key] ?? 0) - (stepOrder[b.module][b.step_key] ?? 0);
  });
}

module.exports = { MODULE_DEFS, tsMs, raciUserWeek, raciUserWeekBreakdown };
