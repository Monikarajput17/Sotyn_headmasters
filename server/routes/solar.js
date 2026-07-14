// Solar Quotation module API (mam 2026-06-21).
// Dedicated solar rate book (panels/inverters/structure/cables/bos/labour),
// engineering factors + settings, and saved solar quotations. Gated by the
// `solar_quotation` module permission. Tables created/seeded by db/seedSolar.js.
const express = require('express');
const XLSX = require('xlsx');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { ensureSolarSchema } = require('../db/seedSolar');

const router = express.Router();
router.use(authMiddleware);

// Defensive: guarantee tables exist even if the boot seed was skipped.
try { ensureSolarSchema(getDb()); } catch (e) { console.warn('[solar] ensureSchema:', e.message); }

const n = (v) => (v === undefined ? null : v);

// ── Rate book: the single payload the engine loads, from the Solar module's own
//    Material Master (solar_materials) + Labour Master (solar_labour) + config.
router.get('/rate-book', requirePermission('solar_quotation', 'view'), (req, res) => {
  const db = getDb();
  const mats = db.prepare('SELECT category, make, grade, item_name, size, rate FROM solar_materials WHERE active=1').all();
  const ui = { panel: {}, inverter: {}, structure: {}, cable: {}, battery: {} };
  const bos = {};
  const invSizes = new Set();
  const counts = { panels: 0, inverters: 0, structure: 0, cables: 0, bos: 0, battery: 0 };
  for (const r of mats) {
    const p = +r.rate || 0;
    switch (r.category) {
      case 'panel':
        ui.panel[r.make] = ui.panel[r.make] || [null, null];
        ui.panel[r.make][r.grade === 'DCR' ? 1 : 0] = p; counts.panels++; break;
      case 'inverter': {
        ui.inverter[r.make] = p; const kw = parseFloat(r.size); if (kw) invSizes.add(kw); counts.inverters++; break;
      }
      case 'structure':
        ui.structure[r.make] = p; counts.structure++; break;
      case 'cable': {
        ui.cable[r.make] = ui.cable[r.make] || [null, null];
        const sz = parseFloat(r.size);
        if (r.grade === 'DC String' && sz === 4) ui.cable[r.make][0] = p;
        if (r.grade === 'AC LT') ui.cable[r.make][1] = p;
        counts.cables++; break;
      }
      case 'bos':
        bos[r.item_name] = p; counts.bos++; break;
      case 'battery':
        ui.battery[r.make] = p; counts.battery++; break;
    }
  }
  const labour = {};
  for (const r of db.prepare('SELECT activity, rate FROM solar_labour WHERE active=1').all()) labour[r.activity] = +r.rate || 0;

  const mount = {}, array = {}, state = {};
  for (const f of db.prepare('SELECT * FROM solar_factors').all()) {
    if (f.kind === 'mount') mount[f.name] = { struct_mult: f.val1, area_per_kwp: f.val2 };
    if (f.kind === 'array') array[f.name] = { struct_mult: f.val1, yield_mult: f.val2 };
    if (f.kind === 'state') state[f.name] = { specific_yield: f.val1, t_min: f.val2, t_max: f.val3 };
  }
  const settingsObj = {};
  for (const s of db.prepare('SELECT key, value FROM solar_settings').all()) settingsObj[s.key] = isNaN(+s.value) ? s.value : +s.value;
  const inverterSizes = [...invSizes].sort((a, b) => b - a);

  res.json({ ui, factors: { mount, array, state }, settings: settingsObj, inverterSizes, bos, labour, counts });
});

// ── Factors & settings (Rate Master) ──────────────────────────────
router.get('/factors', requirePermission('solar_quotation', 'view'), (req, res) => {
  res.json(getDb().prepare('SELECT * FROM solar_factors ORDER BY kind, name').all());
});
router.put('/factors/:id', requirePermission('solar_quotation', 'edit'), (req, res) => {
  const b = req.body || {};
  getDb().prepare('UPDATE solar_factors SET val1=?, val2=?, val3=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(n(b.val1), n(b.val2), n(b.val3), req.params.id);
  res.json({ message: 'Updated' });
});
router.get('/settings', requirePermission('solar_quotation', 'view'), (req, res) => {
  res.json(getDb().prepare('SELECT * FROM solar_settings ORDER BY key').all());
});
router.put('/settings/:key', requirePermission('solar_quotation', 'edit'), (req, res) => {
  getDb().prepare('UPDATE solar_settings SET value=?, updated_at=CURRENT_TIMESTAMP WHERE key=?')
    .run(String(req.body?.value ?? ''), req.params.key);
  res.json({ message: 'Updated' });
});

// ── Saved solar quotations ────────────────────────────────────────
router.get('/quotations', requirePermission('solar_quotation', 'view'), (req, res) => {
  const { deal_id } = req.query;
  const where = deal_id ? 'WHERE deal_id=?' : '';
  const params = deal_id ? [deal_id] : [];
  res.json(getDb().prepare(`SELECT id, quote_no, variant_label, deal_id, client_name, project_type, capacity_kw,
    cost, margin_pct, sell, sell_per_w, grand_total, status, updated_at, created_at
    FROM solar_quotations ${where} ORDER BY updated_at DESC`).all(...params));
});
router.get('/quotations/:id', requirePermission('solar_quotation', 'view'), (req, res) => {
  const r = getDb().prepare('SELECT * FROM solar_quotations WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json({ ...r,
    inputs: JSON.parse(r.inputs_json || '{}'), boq: JSON.parse(r.boq_json || '[]'),
    engineering: JSON.parse(r.engineering_json || '{}'), roi: JSON.parse(r.roi_json || '{}') });
});
const QUOTE_COLS = 'quote_no,lead_id,deal_id,variant_label,client_name,address,project_type,capacity_kw,dc_ac_ratio,panel_make,inverter_make,inputs_json,boq_json,engineering_json,roi_json,cost,margin_pct,sell,sell_per_w,gst_amt,grand_total,status';
function quoteParams(b) {
  return [n(b.quote_no), n(b.lead_id), n(b.deal_id), n(b.variant_label), n(b.client_name), n(b.address), n(b.project_type),
    Number(b.capacity_kw) || 0, Number(b.dc_ac_ratio) || 0, n(b.panel_make), n(b.inverter_make),
    JSON.stringify(b.inputs || {}), JSON.stringify(b.boq || []), JSON.stringify(b.engineering || {}),
    JSON.stringify(b.roi || {}), Number(b.cost) || 0, Number(b.margin_pct) || 0, Number(b.sell) || 0,
    Number(b.sell_per_w) || 0, Number(b.gst_amt) || 0, Number(b.grand_total) || 0, b.status || 'draft'];
}
const QUOTE_PH = QUOTE_COLS.split(',').map(() => '?').join(',');
router.post('/quotations', requirePermission('solar_quotation', 'create'), (req, res) => {
  const db = getDb();
  const r = db.prepare(`INSERT INTO solar_quotations (${QUOTE_COLS},created_by) VALUES (${QUOTE_PH},?)`).run(...quoteParams(req.body || {}), req.user.id);
  // Funnel auto-advance: a quote created from a deal pushes it to the Quotation stage.
  if (req.body?.deal_id) { try { advanceDealOnQuote(db, req.body.deal_id, r.lastInsertRowid, req.user); } catch (e) { console.warn('[solar] deal advance:', e.message); } }
  res.json({ id: r.lastInsertRowid, message: 'Saved' });
});
router.put('/quotations/:id', requirePermission('solar_quotation', 'edit'), (req, res) => {
  const ex = getDb().prepare('SELECT id FROM solar_quotations WHERE id=?').get(req.params.id);
  if (!ex) return res.status(404).json({ error: 'Not found' });
  getDb().prepare(`UPDATE solar_quotations SET ${QUOTE_COLS.split(',').map((c) => `${c}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(...quoteParams(req.body || {}), req.params.id);
  res.json({ message: 'Updated' });
});
router.delete('/quotations/:id', requirePermission('solar_quotation', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM solar_quotations WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Excel export of a solar quote — mam's customer-facing quotation format
// (the PDF she shared: Residence-114-1). Two sheets, mirroring the two pages:
//   Sheet 1 "BOQ"       — S.NO / DESCRIPTION / UNIT / MAKES / QTY only.
//                         NO purchase price, cost or margin: this file goes to
//                         the client, so our costing must never appear here.
//   Sheet 2 "QUOTATION" — client block (Name/Address/Date/Quotation No), the
//                         lumpsum Base Price without GST + ₹/watt, and Notes.
// An extra "INTERNAL" costing sheet is appended ONLY when the export was
// triggered from the Internal view (b.view === 'internal'), so our rates leak
// to nobody by default while mam keeps the costing sheet for her own records.
router.post('/quotations/export', requirePermission('solar_quotation', 'view'), (req, res) => {
  try {
    const b = req.body || {};
    const boq = b.boq || [];
    const kw = Math.round(Number(b.capacity_kw) || 0);
    const typeLbl = String(b.type_label || b.project_type || 'SOLAR').toUpperCase();
    const roof = b.roof_label || 'RCC Roof';
    const sysTitle = `${kw} KW ${typeLbl} SOLAR SYSTEM ON ${roof.toUpperCase()}`;
    const wb = XLSX.utils.book_new();

    // ── Sheet 1: BOQ (customer-facing, no prices) ──
    const boqAoa = [
      [`Proposal for ${kw} KW ${typeLbl} Solar System on ${roof}`],
      ['Providing, laying, testing & commissioning of'],
      ['S.NO.', 'DESCRIPTION', 'UNIT', 'MAKES', 'QTY'],
    ];
    // Grouped shape (mam's format: 1.0 SOLAR PANEL → a, b …) when the client
    // sends it; fall back to a plain numbered list for older callers.
    const grouped = Array.isArray(b.boq_grouped) ? b.boq_grouped : null;
    if (grouped) {
      grouped.forEach((cat) => {
        if (cat.grouped) {
          boqAoa.push([cat.no, cat.name, '', '', '']);
          (cat.items || []).forEach((it, j) => boqAoa.push([String.fromCharCode(97 + j), it.desc || '', it.unit || '', it.make || '', it.qty ?? '']));
        } else {
          const it = (cat.items && cat.items[0]) || {};
          boqAoa.push([cat.no, it.desc || cat.name || '', it.unit || '', it.make || '', it.qty ?? '']);
        }
      });
    } else {
      boq.forEach((l, i) => boqAoa.push([i + 1, l.desc || '', l.unit || '', l.make || '', l.qty || 0]));
    }
    const boqWs = XLSX.utils.aoa_to_sheet(boqAoa);
    boqWs['!cols'] = [{ wch: 6 }, { wch: 60 }, { wch: 8 }, { wch: 22 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, boqWs, 'BOQ');

    // ── Sheet 2: QUOTATION (commercial + notes) ──
    const q = [];
    q.push(['Secured Engineers India']);
    q.push([`QUOTATION FOR ${sysTitle}`]);
    q.push([]);
    q.push(['NAME', b.client_name || '', '', 'Date', new Date().toISOString().slice(0, 10)]);
    q.push(['ADDRESS', b.address || '', '', 'Quotation No', b.quote_no || '']);
    q.push([]);
    q.push(['S No.', 'Description', 'Amount (In Rupees)']);
    q.push([1, sysTitle, r2(b.sell)]);
    q.push(['', 'BASE PRICE WITHOUT GST', `₹${r2(b.sell_per_w)}/watt`]);
    q.push([]);
    q.push(['Note:']);
    (b.notes || []).forEach((nn, i) => q.push([i + 1, nn]));
    const qWs = XLSX.utils.aoa_to_sheet(q);
    qWs['!cols'] = [{ wch: 10 }, { wch: 62 }, { wch: 22 }, { wch: 14 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, qWs, 'QUOTATION');

    // ── Sheet 3 (internal only): full costing ──
    if (b.view === 'internal') {
      const inAoa = [['S.No', 'Description', 'Unit', 'Make', 'Qty', 'Purch ₹/u', 'PP ₹', 'TPA ₹ (cost)', 'Margin %', 'SP ₹', 'Rate ₹']];
      boq.forEach((l, i) => inAoa.push([i + 1, l.desc || '', l.unit || '', l.make || '', l.qty || 0,
        r2(l.ppUnit), r2(l.pp), r2(l.tpa), l.tpa ? r2((l.sp - l.tpa) / l.tpa * 100) : 0, r2(l.sp), r2(l.rate)]));
      inAoa.push([]);
      inAoa.push(['', 'TOTAL (ex-GST)', '', '', '', '', r2(b.cost), r2(b.cost), r2(b.margin_pct), r2(b.sell), `₹${r2(b.sell_per_w)}/W`]);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(inAoa), 'INTERNAL');
    }

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="solar-quote-${String(b.client_name || 'quote').replace(/[^a-z0-9]/gi, '_')}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});
function r2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

// ════════════════ Solar Sales Funnel ════════════════
const STAGES = [
  { key: 'inquiry', label: 'New Inquiry', sla: 2, prob: 10, action: 'Call & qualify the requirement' },
  { key: 'qualification', label: 'Qualification', sla: 3, prob: 20, action: 'Collect load / electricity bill & site type' },
  { key: 'survey', label: 'Site Survey', sla: 5, prob: 35, action: 'Schedule & complete the site survey' },
  { key: 'design', label: 'Design & BOQ', sla: 4, prob: 50, action: 'Prepare system design + BOQ' },
  { key: 'quotation', label: 'Quotation Sent', sla: 5, prob: 65, action: 'Send the solar quotation & follow up' },
  { key: 'negotiation', label: 'Negotiation', sla: 7, prob: 80, action: 'Negotiate price / terms, revise if needed' },
  { key: 'approval', label: 'Approval', sla: 7, prob: 90, action: 'Secure subsidy / loan / PO approval' },
  { key: 'won', label: 'Won', sla: 0, prob: 100, action: 'Handover to installation' },
];
const STAGE_IDX = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));
const stageMeta = (k) => STAGES[STAGE_IDX[k]] || null;

// Exit gate per stage: the concrete action that must be done before advancing.
const STAGE_GATE_LABEL = {
  inquiry: 'Complete the qualification call (Qualify on call)',
  qualification: 'Schedule the site survey (set a date + surveyor)',
  survey: 'Complete the site-survey report (shadow-free area + roof type)',
  design: 'Finalize design & BOQ (confirm system size + type)',
  quotation: 'Create & send at least one quotation to the client',
  negotiation: 'Log the client response / negotiation note',
  approval: 'Confirm the order (PO number or advance received)',
  won: '',
};
function dealGate(db, d) {
  const sd = JSON.parse(d.stage_data_json || '{}');
  const qual = JSON.parse(d.qualification_json || '{}');
  const quoteCount = db.prepare('SELECT COUNT(*) AS n FROM solar_quotations WHERE deal_id=?').get(d.id).n;
  let met = true;
  switch (d.stage) {
    case 'inquiry': met = Object.keys(qual).length > 0; break;
    case 'qualification': met = !!sd.survey?.scheduled_date; break;
    case 'survey': met = !!(sd.survey?.completed && sd.survey?.area_sqft); break;
    case 'design': met = !!(d.capacity_kw > 0 && sd.design?.confirmed); break;
    case 'quotation': met = !!(quoteCount > 0 && sd.quotation?.sent); break;
    case 'negotiation': met = !!sd.negotiation?.note; break;
    case 'approval': met = !!sd.approval?.confirmed; break;
    default: met = true;
  }
  return { met, requirement: STAGE_GATE_LABEL[d.stage] || '', quoteCount };
}

function logDealEvent(db, dealId, type, fromStage, toStage, note, user) {
  db.prepare(`INSERT INTO solar_deal_events (deal_id,type,from_stage,to_stage,note,by_user,by_name) VALUES (?,?,?,?,?,?,?)`)
    .run(dealId, type, fromStage || null, toStage || null, note || null, user?.id || null, user?.name || null);
}
// Push a deal to at least the Quotation stage when a quote is created from it.
function advanceDealOnQuote(db, dealId, quotationId, user) {
  const d = db.prepare('SELECT * FROM solar_deals WHERE id=?').get(dealId);
  if (!d) return;
  db.prepare('UPDATE solar_deals SET quotation_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(quotationId, dealId);
  if (d.status === 'open' && STAGE_IDX[d.stage] < STAGE_IDX['quotation']) {
    db.prepare(`UPDATE solar_deals SET stage='quotation', stage_updated_at=CURRENT_TIMESTAMP,
       next_action=?, next_action_due=date('now','+5 days'), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(stageMeta('quotation').action, dealId);
    logDealEvent(db, dealId, 'stage', d.stage, 'quotation', `Auto-advanced: quotation #${quotationId} created`, user);
  }
}

router.get('/funnel/config', requirePermission('solar_quotation', 'view'), (req, res) => res.json({ stages: STAGES }));

router.get('/deals', requirePermission('solar_quotation', 'view'), (req, res) => {
  const { stage, owner_id, q, include_lost } = req.query;
  const cl = [], p = [];
  if (!include_lost) cl.push("status != 'lost'");
  if (stage) { cl.push('stage=?'); p.push(stage); }
  if (owner_id) { cl.push('owner_id=?'); p.push(owner_id); }
  if (q) { cl.push('(client_name LIKE ? OR company LIKE ? OR deal_no LIKE ?)'); const s = `%${q}%`; p.push(s, s, s); }
  const where = cl.length ? 'WHERE ' + cl.join(' AND ') : '';
  const rows = getDb().prepare(`SELECT *, CAST(julianday('now')-julianday(stage_updated_at) AS INTEGER) AS days_in_stage FROM solar_deals ${where} ORDER BY stage_updated_at DESC`).all(...p);
  res.json(rows.map((r) => ({ ...r, stuck: r.status === 'open' && r.days_in_stage > (stageMeta(r.stage)?.sla ?? 99) })));
});

router.get('/deals/:id', requirePermission('solar_quotation', 'view'), (req, res) => {
  const d = getDb().prepare('SELECT * FROM solar_deals WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  d.events = getDb().prepare('SELECT * FROM solar_deal_events WHERE deal_id=? ORDER BY created_at DESC').all(d.id);
  d.qualification = JSON.parse(d.qualification_json || '{}');
  d.stage_data = JSON.parse(d.stage_data_json || '{}');
  d.quotes = getDb().prepare('SELECT id, quote_no, variant_label, capacity_kw, sell, sell_per_w, margin_pct, grand_total, created_at FROM solar_quotations WHERE deal_id=? ORDER BY created_at').all(d.id);
  d.gate = dealGate(getDb(), d);
  res.json(d);
});

router.post('/deals', requirePermission('solar_quotation', 'create'), (req, res) => {
  const b = req.body || {};
  const stage = STAGE_IDX[b.stage] != null ? b.stage : 'inquiry';
  const db = getDb();
  const r = db.prepare(`INSERT INTO solar_deals
    (lead_id,client_name,company,phone,location,state,district,pincode,lat,lng,capacity_kw,project_type,value,source,stage,owner_id,owner_name,next_action,next_action_due,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    n(b.lead_id), n(b.client_name), n(b.company), n(b.phone), n(b.location), n(b.state), n(b.district), n(b.pincode), n(b.lat), n(b.lng),
    Number(b.capacity_kw) || 0, n(b.project_type), Number(b.value) || 0, n(b.source), stage,
    n(b.owner_id), n(b.owner_name), b.next_action || stageMeta(stage)?.action, n(b.next_action_due), req.user.id);
  const id = r.lastInsertRowid;
  const deal_no = `SOL-${String(id).padStart(4, '0')}`;
  db.prepare('UPDATE solar_deals SET deal_no=? WHERE id=?').run(deal_no, id);
  if (stage === 'won') db.prepare("UPDATE solar_deals SET status='won' WHERE id=?").run(id);
  logDealEvent(db, id, 'created', null, stage, 'Deal created', req.user);
  res.json({ id, deal_no, message: 'Created' });
});

router.put('/deals/:id', requirePermission('solar_quotation', 'edit'), (req, res) => {
  const b = req.body || {};
  if ('qualification' in b) { b.qualification_json = JSON.stringify(b.qualification); }
  // Merge partial stage-action data (one level deep) into stage_data_json.
  if ('stage_data' in b) {
    const cur = JSON.parse((getDb().prepare('SELECT stage_data_json FROM solar_deals WHERE id=?').get(req.params.id) || {}).stage_data_json || '{}');
    for (const k of Object.keys(b.stage_data)) cur[k] = { ...(cur[k] || {}), ...b.stage_data[k] };
    b.stage_data_json = JSON.stringify(cur);
  }
  const cols = ['client_name', 'company', 'phone', 'location', 'state', 'district', 'pincode', 'lat', 'lng', 'capacity_kw', 'project_type', 'value', 'source', 'owner_id', 'owner_name', 'next_action', 'next_action_due', 'lead_id', 'qualification_json', 'stage_data_json'];
  const set = cols.filter((c) => c in b);
  if (!set.length) return res.json({ message: 'No change' });
  getDb().prepare(`UPDATE solar_deals SET ${set.map((c) => `${c}=?`).join(',')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(...set.map((c) => n(b[c])), req.params.id);
  res.json({ message: 'Updated' });
});

router.post('/deals/:id/move', requirePermission('solar_quotation', 'edit'), (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT * FROM solar_deals WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const to = req.body?.stage;
  if (STAGE_IDX[to] == null) return res.status(400).json({ error: 'Bad stage' });
  // ── Stage gating: forward moves need the current step's action done, one step at a time ──
  const fromIdx = STAGE_IDX[d.stage], toIdx = STAGE_IDX[to];
  if (toIdx > fromIdx && !req.body?.force) {
    const g = dealGate(db, d);
    if (!g.met) return res.status(422).json({ error: 'Action required before advancing', requirement: g.requirement, stage: d.stage });
    if (toIdx !== fromIdx + 1) return res.status(422).json({ error: 'Finish one stage at a time.', next: STAGES[fromIdx + 1]?.label });
  }
  const m = stageMeta(to);
  db.prepare(`UPDATE solar_deals SET stage=?, stage_updated_at=CURRENT_TIMESTAMP, status=?,
     next_action=?, next_action_due=date('now','+'||?||' days'), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(to, to === 'won' ? 'won' : 'open', m.action, m.sla || 3, req.params.id);
  logDealEvent(db, d.id, 'stage', d.stage, to, req.body?.note || null, req.user);
  // Goldratt hand-off: a Won deal immediately becomes an execution project.
  if (to === 'won') { try { ensureProjectFromDeal(db, d.id, req.user); } catch (e) { console.warn('[solar] project create:', e.message); } }
  res.json({ message: 'Moved' });
});

router.post('/deals/:id/lose', requirePermission('solar_quotation', 'edit'), (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT stage FROM solar_deals WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE solar_deals SET status='lost', lost_reason=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(n(req.body?.reason), req.params.id);
  logDealEvent(db, req.params.id, 'lost', d.stage, null, req.body?.reason || null, req.user);
  res.json({ message: 'Marked lost' });
});

router.delete('/deals/:id', requirePermission('solar_quotation', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM solar_deal_events WHERE deal_id=?').run(req.params.id);
  getDb().prepare('DELETE FROM solar_deals WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Conversion analytics — reached / conversion% / drop-off / avg-days / stuck.
router.get('/funnel/analytics', requirePermission('solar_quotation', 'view'), (req, res) => {
  const db = getDb();
  const deals = db.prepare('SELECT id, stage, status, value FROM solar_deals').all();
  const events = db.prepare("SELECT deal_id, to_stage FROM solar_deal_events WHERE to_stage IS NOT NULL").all();
  const furthest = {};
  for (const d of deals) furthest[d.id] = STAGE_IDX[d.stage] ?? 0;
  for (const e of events) { const i = STAGE_IDX[e.to_stage]; if (i != null && i > (furthest[e.deal_id] ?? 0)) furthest[e.deal_id] = i; }
  const reached = STAGES.map(() => 0);
  for (const d of deals) { const f = furthest[d.id] ?? 0; for (let i = 0; i <= f; i++) reached[i]++; }
  const cur = STAGES.map(() => ({ n: 0, val: 0 }));
  for (const d of deals) { if (d.status === 'lost') continue; const i = STAGE_IDX[d.stage]; if (i != null) { cur[i].n++; cur[i].val += d.value || 0; } }
  const days = db.prepare("SELECT stage, AVG(julianday('now')-julianday(stage_updated_at)) AS d FROM solar_deals WHERE status='open' GROUP BY stage").all();
  const dayMap = {}; for (const r of days) dayMap[r.stage] = r.d;
  const byStage = STAGES.map((s, i) => ({
    key: s.key, label: s.label, reached: reached[i], current: cur[i].n, value: Math.round(cur[i].val),
    conversion: i === 0 ? 100 : (reached[i - 1] ? Math.round(reached[i] / reached[i - 1] * 100) : 0),
    dropoff: i === 0 ? 0 : Math.max(0, reached[i - 1] - reached[i]),
    avg_days: Math.round(dayMap[s.key] || 0),
  }));
  const won = deals.filter((d) => d.status === 'won');
  const lost = deals.filter((d) => d.status === 'lost');
  const open = deals.filter((d) => d.status === 'open');
  const stuck = db.prepare(`SELECT id, deal_no, client_name, stage, value, CAST(julianday('now')-julianday(stage_updated_at) AS INTEGER) AS days_in_stage
     FROM solar_deals WHERE status='open'`).all()
    .filter((r) => r.days_in_stage > (stageMeta(r.stage)?.sla ?? 99))
    .map((r) => ({ ...r, sla: stageMeta(r.stage)?.sla, stage_label: stageMeta(r.stage)?.label }));
  res.json({
    stages: STAGES, byStage,
    totals: {
      open: open.length, won: won.length, lost: lost.length,
      open_value: Math.round(open.reduce((a, d) => a + (d.value || 0), 0)),
      won_value: Math.round(won.reduce((a, d) => a + (d.value || 0), 0)),
      overall_conversion: reached[0] ? Math.round(won.length / reached[0] * 100) : 0,
    },
    stuck,
  });
});

// ════════════════ Solar Project Execution (Won → Handover → AMC) ════════════════
const PROJECT_STAGES = [
  { key: 'order', label: 'Order Confirmed', sla: 3, action: 'Collect advance + sign agreement' },
  { key: 'design', label: 'Design & Approvals', sla: 10, action: 'Final SLD/structural + DISCOM net-meter + CEIG/subsidy' },
  { key: 'procurement', label: 'Procurement', sla: 15, action: 'Order & receive panels / inverter / BOS' },
  { key: 'installation', label: 'Installation', sla: 12, action: 'Civil, structure, module mounting, DC/AC wiring' },
  { key: 'commissioning', label: 'Commissioning', sla: 7, action: 'DISCOM inspection, meter, grid sync, testing' },
  { key: 'handover', label: 'Handover', sla: 3, action: 'Commissioning cert + generation report + client sign-off' },
  { key: 'amc', label: 'AMC / O&M', sla: 0, action: 'Periodic cleaning, monitoring & preventive maintenance' },
];
const PJ_IDX = Object.fromEntries(PROJECT_STAGES.map((s, i) => [s.key, i]));
const pjMeta = (k) => PROJECT_STAGES[PJ_IDX[k]] || null;

function defaultMilestones(value) {
  const v = Number(value) || 0;
  return [
    { label: 'Advance', pct: 25 }, { label: 'Before structure delivery', pct: 25 },
    { label: 'Before panel delivery', pct: 25 }, { label: 'After installation', pct: 20 },
    { label: 'After handover', pct: 5 },
  ].map((m) => ({ ...m, amount: Math.round(v * m.pct / 100), status: 'pending', collected_on: null }));
}
function defaultChecklist() {
  const C = {
    design: ['Final SLD & structural drawings', 'DISCOM net-metering application', 'CEIG / electrical approval (if HT)', 'Subsidy registration (if applicable)'],
    procurement: ['Panels ordered & received', 'Inverter ordered & received', 'Structure & BOS received'],
    installation: ['Civil & foundation', 'Structure erected', 'Modules mounted & wired', 'Earthing & lightning arrestor'],
    commissioning: ['DISCOM inspection passed', 'Net-meter installed', 'Grid sync & testing'],
    handover: ['Commissioning certificate', 'Generation report & O&M manual', 'Client sign-off'],
  };
  return Object.entries(C).flatMap(([stage, items]) => items.map((item) => ({ stage, item, done: false })));
}
function logProjectEvent(db, id, type, from, to, note, user) {
  db.prepare(`INSERT INTO solar_project_events (project_id,type,from_stage,to_stage,note,by_user,by_name) VALUES (?,?,?,?,?,?,?)`)
    .run(id, type, from || null, to || null, note || null, user?.id || null, user?.name || null);
}
function createProject(db, p, user) {
  const r = db.prepare(`INSERT INTO solar_projects
    (deal_id,quotation_id,client_name,company,location,state,capacity_kw,project_type,value,stage,owner_id,owner_name,
     next_action,next_action_due,start_date,milestones_json,checklist_json,amc_annual_fee,amc_free_until,amc_status,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,date('now','+'||?||' days'),date('now'),?,?,?,date('now','+10 years'),'pending',?)`).run(
    n(p.deal_id), n(p.quotation_id), n(p.client_name), n(p.company), n(p.location), n(p.state),
    Number(p.capacity_kw) || 0, n(p.project_type), Number(p.value) || 0, 'order', n(p.owner_id), n(p.owner_name),
    pjMeta('order').action, pjMeta('order').sla, JSON.stringify(defaultMilestones(p.value)), JSON.stringify(defaultChecklist()),
    200000, user?.id || null);
  const id = r.lastInsertRowid;
  db.prepare('UPDATE solar_projects SET project_no=? WHERE id=?').run(`SP-${String(id).padStart(4, '0')}`, id);
  logProjectEvent(db, id, 'created', null, 'order', 'Project created from won deal', user);
  return id;
}
// Called when a deal is marked Won — spin up its execution project once.
function ensureProjectFromDeal(db, dealId, user) {
  const exists = db.prepare('SELECT id FROM solar_projects WHERE deal_id=?').get(dealId);
  if (exists) return exists.id;
  const d = db.prepare('SELECT * FROM solar_deals WHERE id=?').get(dealId);
  if (!d) return null;
  return createProject(db, { deal_id: d.id, quotation_id: d.quotation_id, client_name: d.client_name, company: d.company,
    location: d.location, state: d.state, capacity_kw: d.capacity_kw, project_type: d.project_type, value: d.value,
    owner_id: d.owner_id, owner_name: d.owner_name }, user);
}

router.get('/projects/config', requirePermission('solar_quotation', 'view'), (req, res) => res.json({ stages: PROJECT_STAGES }));

router.get('/projects', requirePermission('solar_quotation', 'view'), (req, res) => {
  const { stage, status } = req.query;
  const cl = [], p = [];
  if (stage) { cl.push('stage=?'); p.push(stage); }
  if (status) { cl.push('status=?'); p.push(status); }
  const where = cl.length ? 'WHERE ' + cl.join(' AND ') : '';
  const rows = getDb().prepare(`SELECT *, CAST(julianday('now')-julianday(stage_updated_at) AS INTEGER) AS days_in_stage FROM solar_projects ${where} ORDER BY stage_updated_at DESC`).all(...p);
  res.json(rows.map((r) => {
    const ms = JSON.parse(r.milestones_json || '[]');
    const collected = ms.filter((m) => m.status === 'collected').reduce((a, m) => a + (m.amount || 0), 0);
    return { ...r, collected, pending: (r.value || 0) - collected, stuck: r.status === 'active' && r.days_in_stage > (pjMeta(r.stage)?.sla ?? 99) };
  }));
});

router.get('/projects/:id', requirePermission('solar_quotation', 'view'), (req, res) => {
  const r = getDb().prepare('SELECT * FROM solar_projects WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  r.milestones = JSON.parse(r.milestones_json || '[]');
  r.checklist = JSON.parse(r.checklist_json || '[]');
  r.events = getDb().prepare('SELECT * FROM solar_project_events WHERE project_id=? ORDER BY created_at DESC').all(r.id);
  res.json(r);
});

router.post('/projects', requirePermission('solar_quotation', 'create'), (req, res) => {
  const id = createProject(getDb(), req.body || {}, req.user);
  res.json({ id, project_no: `SP-${String(id).padStart(4, '0')}`, message: 'Created' });
});
router.post('/projects/from-deal/:dealId', requirePermission('solar_quotation', 'create'), (req, res) => {
  const id = ensureProjectFromDeal(getDb(), req.params.dealId, req.user);
  if (!id) return res.status(404).json({ error: 'Deal not found' });
  res.json({ id, message: 'Project ready' });
});

router.put('/projects/:id', requirePermission('solar_quotation', 'edit'), (req, res) => {
  const b = req.body || {};
  const cols = ['client_name', 'company', 'location', 'state', 'capacity_kw', 'project_type', 'value', 'owner_id', 'owner_name', 'next_action', 'next_action_due', 'target_handover', 'handover_date', 'amc_annual_fee', 'amc_free_until', 'amc_next_due', 'amc_status', 'status'];
  const set = cols.filter((c) => c in b);
  if ('milestones' in b) { set.push('milestones_json'); b.milestones_json = JSON.stringify(b.milestones); }
  if ('checklist' in b) { set.push('checklist_json'); b.checklist_json = JSON.stringify(b.checklist); }
  if (!set.length) return res.json({ message: 'No change' });
  getDb().prepare(`UPDATE solar_projects SET ${set.map((c) => `${c}=?`).join(',')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(...set.map((c) => n(b[c])), req.params.id);
  res.json({ message: 'Updated' });
});

router.post('/projects/:id/move', requirePermission('solar_quotation', 'edit'), (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT * FROM solar_projects WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const to = req.body?.stage;
  if (PJ_IDX[to] == null) return res.status(400).json({ error: 'Bad stage' });
  const m = pjMeta(to);
  db.prepare(`UPDATE solar_projects SET stage=?, stage_updated_at=CURRENT_TIMESTAMP,
     next_action=?, next_action_due=date('now','+'||?||' days'), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(to, m.action, m.sla || 3, req.params.id);
  if (to === 'handover') db.prepare("UPDATE solar_projects SET handover_date=date('now') WHERE id=?").run(req.params.id);
  if (to === 'amc') db.prepare("UPDATE solar_projects SET amc_status='active', amc_next_due=date('now','+1 year') WHERE id=?").run(req.params.id);
  logProjectEvent(db, d.id, 'stage', d.stage, to, req.body?.note || null, req.user);
  res.json({ message: 'Moved' });
});

router.delete('/projects/:id', requirePermission('solar_quotation', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM solar_project_events WHERE project_id=?').run(req.params.id);
  getDb().prepare('DELETE FROM solar_projects WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

router.get('/projects/stats/analytics', requirePermission('solar_quotation', 'view'), (req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT stage, status, value, milestones_json, CAST(julianday('now')-julianday(stage_updated_at) AS INTEGER) AS days_in_stage, amc_next_due FROM solar_projects").all();
  const byStage = PROJECT_STAGES.map((s) => ({ key: s.key, label: s.label, count: 0, value: 0 }));
  let collected = 0, pending = 0, stuck = [];
  for (const r of rows) {
    const i = PJ_IDX[r.stage]; if (i != null) { byStage[i].count++; byStage[i].value += r.value || 0; }
    const ms = JSON.parse(r.milestones_json || '[]');
    const c = ms.filter((m) => m.status === 'collected').reduce((a, m) => a + (m.amount || 0), 0);
    collected += c; pending += (r.value || 0) - c;
    if (r.status === 'active' && r.days_in_stage > (pjMeta(r.stage)?.sla ?? 99)) stuck.push(r.stage);
  }
  const amcDue = db.prepare("SELECT id, project_no, client_name, amc_next_due FROM solar_projects WHERE amc_status='active' AND amc_next_due IS NOT NULL AND amc_next_due <= date('now','+30 days')").all();
  res.json({
    stages: PROJECT_STAGES,
    byStage: byStage.map((s) => ({ ...s, value: Math.round(s.value) })),
    totals: { active: rows.filter((r) => r.status === 'active').length, value: Math.round(rows.reduce((a, r) => a + (r.value || 0), 0)), collected: Math.round(collected), pending: Math.round(pending), stuck: stuck.length },
    amcDue,
  });
});

// ── Solar Material Master + Labour Master CRUD (owned by the Solar module) ──
const MAT_COLS = ['category', 'make', 'grade', 'item_name', 'size', 'unit', 'rate', 'gst', 'active'];
const LAB_COLS = ['activity', 'unit', 'rate', 'gst', 'active'];
function crud(basePath, table, cols, order) {
  router.get(basePath, requirePermission('solar_quotation', 'view'), (req, res) => {
    let where = '', params = [];
    if (req.query.category && cols.includes('category')) { where = 'WHERE category=?'; params = [req.query.category]; }
    res.json(getDb().prepare(`SELECT * FROM ${table} ${where} ORDER BY ${order}`).all(...params));
  });
  router.post(basePath, requirePermission('solar_quotation', 'create'), (req, res) => {
    const c = cols.filter((k) => k in (req.body || {}));
    if (!c.length) return res.status(400).json({ error: 'No fields' });
    const r = getDb().prepare(`INSERT INTO ${table} (${c.join(',')}) VALUES (${c.map(() => '?').join(',')})`).run(...c.map((k) => n(req.body[k])));
    res.json({ id: r.lastInsertRowid, message: 'Added' });
  });
  router.put(`${basePath}/:id`, requirePermission('solar_quotation', 'edit'), (req, res) => {
    const c = cols.filter((k) => k in (req.body || {}));
    if (!c.length) return res.json({ message: 'No change' });
    getDb().prepare(`UPDATE ${table} SET ${c.map((k) => `${k}=?`).join(',')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...c.map((k) => n(req.body[k])), req.params.id);
    res.json({ message: 'Updated' });
  });
  router.delete(`${basePath}/:id`, requirePermission('solar_quotation', 'delete'), (req, res) => {
    getDb().prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id);
    res.json({ message: 'Deleted' });
  });
}
crud('/materials', 'solar_materials', MAT_COLS, 'category, make, grade');
crud('/labour', 'solar_labour', LAB_COLS, 'activity');

module.exports = router;
