const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const uploadDir = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

// Tokenise a description for fuzzy item matching — drop noise words so the
// distinctive keywords (Excavation, MS Pipe, 25mm…) carry the match.
const STOP = new Set(['of','in','the','and','for','with','as','to','a','an','or','on','at','by','is','be','all','any','from','up','its','shall','etc','per','no','nos','each','including','include','included','complete','work','works','type','make','suitable','required','approved','rate','item','sqm','rmt']);
function tokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter(t => t && t.length >= 2 && !STOP.has(t));
}
// Score 0..1 for how well an Item Master item matches a BOQ line. Coverage of
// the item's tokens, BUT weighted down hard for thin evidence: a single common
// material word (e.g. "cement" mentioned inside "construct brick masonry
// manhole") must NOT score high. Real confidence needs several matched
// keywords. The LLM pass (below) makes the final call when configured.
function scoreMatch(lineSet, itemTokens) {
  if (!itemTokens.length) return 0;
  let hit = 0;
  for (const t of itemTokens) if (lineSet.has(t)) hit++;
  if (hit === 0) return 0;
  let score = hit / itemTokens.length;
  if (lineSet.has(itemTokens[0])) score += 0.1;
  // Specificity: scale by matched-keyword count (need ~3 for full weight),
  // and cap matches resting on 0–1 keywords to a weak score.
  score *= Math.min(1, hit / 3);
  if (hit < 2) score = Math.min(score, 0.25);
  return Math.min(1, score);
}

// Read an app_settings value (AI key/model live there, set via AI Settings UI).
function aiSetting(key) {
  try { const r = getDb().prepare('SELECT value FROM app_settings WHERE key=?').get(key); return r ? r.value : null; }
  catch (e) { return null; }
}

// Claude pass: for each line, pick the best catalog item from its fuzzy
// shortlist, or null for composite WORK items that have no single catalog
// match. Returns an array indexed by line, or null if AI isn't configured.
async function llmRefine(ranked) {
  const apiKey = aiSetting('ai_api_key');
  if (!apiKey) return null;
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); } catch (e) { return null; }
  const model = aiSetting('ai_model') || 'claude-opus-4-7';
  const client = new Anthropic.default({ apiKey, timeout: 55000 });
  const blocks = ranked.map((r, i) => {
    const cands = r.scored.slice(0, 8).map(s =>
      `${s.it.id}=${[s.it.item_name, s.it.specification, s.it.size].filter(Boolean).join(' ')}`).join(' | ');
    return `[${i}] "${String(r.line.description).slice(0, 280)}"\n   options: ${cands || '(none)'}`;
  }).join('\n');
  const prompt = `You match client BOQ lines to a company's Item Master (catalog of materials/products it sells).
For each BOQ line, pick the ONE option id that is the SAME product, or null if none genuinely match.
CRITICAL: many lines are CONSTRUCTION WORK (e.g. "construct brick masonry manhole", "lay RCC pipe in trench") that has NO single catalog item — return null for those; do NOT match a material merely mentioned inside the text.
Return ONLY a JSON array, one object per line: {"line": <index>, "item_id": <id or null>, "confidence": <0-100>}.

${blocks}`;
  const resp = await client.messages.create({ model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] });
  const text = (resp.content || []).map(c => c.text || '').join('');
  const a = text.indexOf('['), b = text.lastIndexOf(']');
  if (a === -1 || b === -1) return null;
  const arr = JSON.parse(text.slice(a, b + 1));
  const out = [];
  for (const o of arr) if (o && typeof o.line === 'number') out[o.line] = { item_id: o.item_id ?? null, confidence: Number(o.confidence) || 0 };
  return out;
}

// Turn extracted PDF/Word text into BOQ line items: each meaningful line is a
// description (header/note/total lines skipped); a trailing "<n> <unit>"
// becomes the qty.
function textToLines(text) {
  const raw = String(text || '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const SKIP = /^(s\.?\s*no\.?|sr\.?\s*no\.?|sl\.?\s*no\.?|description|particulars?|hsn|grand total|sub\s*total|subtotal|total\b|note|notes|terms|page\b|quotation\b|date\b|validity|currency|subject|scope|to:|m\/s|email|website|secured ?engineers|fire ?fighting|#$|qty|quantity|uom|unit|rate|amount|gst|cgst|sgst|igst)\b/i;
  const isSerial = l => /^\d{1,3}$/.test(l);                         // item number on its own line
  const isPriceLine = l => /(mtrs?|nos|pcs|sets?|kg|each|point|rmt|rft|sqm|cum)\b/i.test(l) && /(₹|\brs\b|\d{2,})/i.test(l);
  const items = [];
  let cur = null;
  for (const l of raw) {
    if (SKIP.test(l)) continue;
    if (isSerial(l)) { if (cur && cur.parts.length) items.push(cur); cur = { parts: [] }; continue; }
    if (!cur) continue;                                              // skip the header preamble before item #1
    if (isPriceLine(l) && cur.parts.length) continue;                // drop the HSN/qty/rate/amount line
    // also handle a serial prefixed inline: "1. Supply of ..."
    const cleaned = l.replace(/^\s*\d+(\.\d+)*[).]\s+/, '').trim();
    if (cleaned.length >= 3) cur.parts.push(cleaned);
  }
  if (cur && cur.parts.length) items.push(cur);
  return items
    .map(it => ({ description: it.parts.join(' — ').replace(/\s+/g, ' ').trim(), qty: 1, unit: '' }))
    .filter(it => it.description.length > 3 && /[a-z]{3,}/i.test(it.description));
}

// Use Claude to extract clean BOQ line items from raw PDF/Word text — it
// groups multi-line descriptions (name + spec + make) into one item and skips
// headers/notes/totals. Returns [{description, qty}] or null if AI not set up.
async function llmExtractItems(text) {
  const apiKey = aiSetting('ai_api_key');
  if (!apiKey || !text) return null;
  let Anthropic; try { Anthropic = require('@anthropic-ai/sdk'); } catch (e) { return null; }
  const model = aiSetting('ai_model') || 'claude-opus-4-7';
  const client = new Anthropic.default({ apiKey, timeout: 55000 });
  const prompt = `Extract the BOQ / requirement line items from this client document text.
Each item may span SEVERAL lines (item name, long description, "Make: ...", size) — COMBINE those into ONE item's description.
Skip headers, column titles, notes, terms, totals, page numbers, addresses.
Return ONLY a JSON array, one object per item: {"description": "<full combined item text>", "qty": <number, default 1>}.

TEXT:
${String(text).slice(0, 14000)}`;
  const resp = await client.messages.create({ model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] });
  const t = (resp.content || []).map(c => c.text || '').join('');
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a === -1 || b === -1) return null;
  const arr = JSON.parse(t.slice(a, b + 1));
  const out = arr.filter(x => x && x.description && String(x.description).trim().length > 3)
    .map(x => ({ description: String(x.description).replace(/\s+/g, ' ').trim(), qty: Number(x.qty) || 1, unit: '' }));
  return out.length ? out : null;
}

// POST a CLIENT BOQ (Excel / PDF / Word) → auto-match each line to Item
// Master and return a suggested item + rate + confidence per line.
// Core BOQ parse + match — shared by the upload route and the funnel auto-load.
// Throws Error (with optional .status) on failure; the caller handles cleanup.
async function matchBoqFile(filePath, originalName) {
    const ext = String(originalName || '').toLowerCase().split('.').pop();
    let lines = [];
    if (ext === 'pdf') {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(fs.readFileSync(filePath));
      lines = (await llmExtractItems(data.text).catch(() => null)) || textToLines(data.text);
    } else if (ext === 'docx' || ext === 'doc') {
      const mammoth = require('mammoth');
      const r = await mammoth.extractRawText({ path: filePath });
      lines = (await llmExtractItems(r.value).catch(() => null)) || textToLines(r.value);
    } else {
      // Excel / CSV — find the header row, then read Description/Qty/Unit cols.
      const wb = XLSX.readFile(filePath);
      const parseNum = (v) => {
        if (v == null || v === '') return 0;
        if (typeof v === 'number') return v;
        const m = String(v).replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/);
        return m ? parseFloat(m[0]) : 0;
      };
      const parseSheet = (name) => {
        const ws = wb.Sheets[name]; if (!ws) return [];
        const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
        const KW = ['description', 'particulars', 'item', 'work', 'qty', 'quantity', 'unit', 'rate', 's.no', 'sr no', 'sn'];
        let h = -1;
        for (let i = 0; i < Math.min(25, data.length); i++) {
          const row = (data[i] || []).map(c => String(c || '').toLowerCase().trim());
          if (KW.filter(k => row.some(c => c === k || c.includes(k))).length >= 2) { h = i; break; }
        }
        if (h === -1) return [];
        const headers = (data[h] || []).map(x => String(x || '').toLowerCase().trim());
        const col = {};
        headers.forEach((hd, i) => {
          if (col.name === undefined && (hd.includes('description') || hd.includes('particular') || hd === 'item' || hd === 'items' || hd === 'work' || hd.includes('work description'))) col.name = i;
          if (col.qty === undefined && (hd === 'qty' || hd === 'quantity' || hd.includes('qty'))) col.qty = i;
          if (col.unit === undefined && (hd === 'unit' || hd === 'uom' || hd.includes('unit'))) col.unit = i;
        });
        if (col.name === undefined) return [];
        const out = [];
        for (let i = h + 1; i < data.length; i++) {
          const row = data[i] || [];
          const desc = String(row[col.name] || '').trim();
          if (!desc || desc.length < 3) continue;
          out.push({
            description: desc,
            qty: col.qty !== undefined ? (parseNum(row[col.qty]) || 1) : 1,
            unit: col.unit !== undefined ? String(row[col.unit] || '').trim() : '',
          });
        }
        return out;
      };
      for (const name of wb.SheetNames) { const r = parseSheet(name); if (r.length > lines.length) lines = r; }
    }
    if (!lines.length) { const e = new Error('Could not read any items. For Excel: ensure a Description/Qty header row. For PDF/Word: the items must be text (not a scanned image).'); e.status = 400; throw e; }

    // Match the client BOQ against OUR PO items only (the ones quoted, with
    // PO/FOC kits) — mam 2026-06-10. FOC/consumables aren't quoted as lines.
    const items = getDb().prepare(`SELECT id, item_code, department, item_name, specification, size, uom, make, current_price FROM item_master WHERE type='PO'`).all();
    const itemById = new Map(items.map(it => [it.id, it]));
    const itemTok = items.map(it => ({ it, toks: tokens([it.item_name, it.specification, it.size].filter(Boolean).join(' ')) }));

    // PO/FOC kits keyed by po_item_id (approved preferred) — so a matched item
    // carries its PP rate + labour + FOC straight to the quotation line.
    const kitById = new Map();
    for (const k of getDb().prepare('SELECT po_item_id, po_rate, labour, focs_json, status FROM po_foc_entries WHERE po_item_id IS NOT NULL').all()) {
      if (!kitById.has(k.po_item_id) || k.status === 'approved') kitById.set(k.po_item_id, k);
    }

    const mk = (it, score) => {
      if (!it) return null;
      const k = kitById.get(it.id);
      const base = {
        item_id: it.id, code: it.item_code,
        name: [it.item_name, it.specification, it.size].filter(Boolean).join(' / '),
        department: it.department || 'General', rate: it.current_price || 0,
        uom: it.uom || '', make: it.make || '', score: Math.round(score || 0),
      };
      if (k) { base.kit_pp = k.po_rate || 0; base.kit_labour = k.labour || 0; base.kit_focs = JSON.parse(k.focs_json || '[]'); }
      return base;
    };

    // Fuzzy shortlist per line (also the candidate set handed to the AI).
    const ranked = lines.map(line => {
      const lset = new Set(tokens(line.description));
      const scored = itemTok.map(({ it, toks }) => ({ it, score: scoreMatch(lset, toks) }))
        .filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
      return { line, scored };
    });

    // Best-effort AI refinement; falls back to fuzzy if not configured / errors.
    let llm = null;
    try { llm = await llmRefine(ranked); } catch (e) { llm = null; }

    const rows = ranked.map((r, i) => {
      const { line, scored } = r;
      const alts = scored.map(s => mk(s.it, s.score * 100)).filter(Boolean);
      // A very strong fuzzy match (≥85%) is auto-applied as the match — don't
      // let the LLM bump a near-exact name into "try:" (mam 2026-06-10).
      const strong = scored[0] && scored[0].score >= 0.85 ? scored[0] : null;
      if (strong) {
        return {
          description: line.description, qty: line.qty, unit: line.unit,
          confidence: 'high', match: mk(strong.it, strong.score * 100),
          alternatives: alts.filter(a => a.item_id !== strong.it.id).slice(0, 3),
        };
      }
      if (llm && llm[i] !== undefined) {
        const pick = llm[i];
        const it = (pick.item_id != null) ? itemById.get(pick.item_id) : null;
        const cf = Number(pick.confidence) || 0;
        const conf = it ? (cf >= 70 ? 'high' : cf >= 40 ? 'medium' : 'low') : 'none';
        return {
          description: line.description, qty: line.qty, unit: line.unit,
          confidence: it ? conf : 'none', match: it ? mk(it, cf) : null,
          alternatives: alts.filter(a => !it || a.item_id !== it.id).slice(0, 3),
        };
      }
      const best = scored[0];
      const sc = best ? best.score : 0;
      const conf = sc === 0 ? 'none' : sc < 0.3 ? 'low' : sc < 0.6 ? 'medium' : 'high';
      return {
        description: line.description, qty: line.qty, unit: line.unit,
        confidence: best ? conf : 'none', match: best ? mk(best.it, sc * 100) : null,
        alternatives: alts.slice(1, 4),
      };
    });
    return { count: rows.length, rows, matched_by: llm ? 'ai' : 'keyword' };
}

// Upload a BOQ file → match (the original route).
router.post('/auto-match-boq', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    res.json(await matchBoqFile(req.file.path, req.file.originalname));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : ('Failed to parse BOQ: ' + err.message) });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
  }
});

// Auto-load a client's BOQ from the Sales Funnel and match it (mam 2026-06-22).
// No manual upload: find the funnel BOQ file for the selected lead's company
// and run the same matcher. lead_id comes from the /leads dropdown.
router.get('/client-boq', async (req, res) => {
  try {
    const db = getDb();
    const id = req.query.funnel_id || req.query.lead_id;
    if (!id) return res.status(400).json({ error: 'client id required' });
    // The Estimator's Client dropdown IS the Sales Funnel, so look the row up
    // directly by id and take its BOQ file (revised first, then original).
    let name = '', link = null;
    const sfRow = db.prepare('SELECT client_name, company_name, revised_boq_file_link, boq_file_link FROM sales_funnel WHERE id=?').get(id);
    if (sfRow) {
      name = (sfRow.company_name || sfRow.client_name || '').trim();
      link = sfRow.revised_boq_file_link || sfRow.boq_file_link || null;
      // The denormalized column can be stale/null while the funnel's BOQ history
      // (the "BOQs (N)" list) holds the actual file — check that too.
      if (!link) {
        const b = db.prepare(`SELECT boq_file_link FROM sales_funnel_boqs
                              WHERE funnel_id=? AND COALESCE(boq_file_link,'')<>''
                              ORDER BY created_at DESC, id DESC LIMIT 1`).get(id);
        if (b?.boq_file_link) link = b.boq_file_link;
      }
    } else {
      // Legacy fallback: a leads-table id → match the funnel by company name.
      const lead = db.prepare('SELECT company_name FROM leads WHERE id=?').get(id);
      name = (lead?.company_name || '').trim();
    }
    // Still no link? Try matching sales_funnel / crm_funnel by the company name.
    if (!link && name) {
      const sf = db.prepare(`SELECT COALESCE(NULLIF(revised_boq_file_link,''), NULLIF(boq_file_link,'')) AS link
                       FROM sales_funnel WHERE (company_name=? OR client_name=?)
                         AND (COALESCE(revised_boq_file_link,'')<>'' OR COALESCE(boq_file_link,'')<>'')
                       ORDER BY id DESC LIMIT 1`).get(name, name);
      if (sf?.link) link = sf.link;
      if (!link) {
        const cf = db.prepare(`SELECT COALESCE(NULLIF(cust_boq_link,''), NULLIF(boq_file_link,'')) AS link
                         FROM crm_funnel WHERE (company_name=? OR client_name=?)
                           AND (COALESCE(cust_boq_link,'')<>'' OR COALESCE(boq_file_link,'')<>'')
                         ORDER BY id DESC LIMIT 1`).get(name, name);
        if (cf?.link) link = cf.link;
      }
    }
    if (!link) return res.status(404).json({ error: `No BOQ found in the Sales Funnel for "${name || 'this client'}". Upload it in the funnel, or use Upload Client BOQ.` });
    // Resolve the stored link (e.g. '/uploads/xxx') to the real uploads dir,
    // which is <repo>/data/uploads (see server/index.js). basename guards
    // against path traversal and handles full-URL links.
    const filename = path.basename(String(link).split('?')[0]);
    const filePath = path.join(__dirname, '..', '..', 'data', 'uploads', filename);
    if (!filename || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'The funnel BOQ file is not on this server — re-upload it in the funnel.' });
    }
    const out = await matchBoqFile(filePath, path.basename(filePath));
    res.json({ ...out, client_name: name });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : ('Failed to load client BOQ: ' + err.message) });
  }
});

// BOQ
router.get('/boq', (req, res) => {
  res.json(getDb().prepare(`SELECT b.*, l.company_name, u.name as created_by_name FROM boq b
    LEFT JOIN leads l ON b.lead_id=l.id LEFT JOIN users u ON b.created_by=u.id ORDER BY b.created_at DESC`).all());
});

router.post('/boq', (req, res) => {
  const { lead_id, title, drawing_required, items } = req.body;
  const db = getDb();
  const total = (items || []).reduce((s, i) => s + (i.quantity * i.rate), 0);
  const r = db.prepare('INSERT INTO boq (lead_id, title, drawing_required, total_amount, created_by) VALUES (?,?,?,?,?)')
    .run(lead_id, title, drawing_required ? 1 : 0, total, req.user.id);
  const insertItem = db.prepare('INSERT INTO boq_items (boq_id, description, quantity, unit, rate, amount, item_id) VALUES (?,?,?,?,?,?,?)');

  // AI Agent: when a line item is linked to a catalogue item AND has a
  // rate > 0, log it to item_price_history so everyone sees this rate
  // as a suggestion next time. Also bump item_master.current_price to
  // reflect the latest market rate the team is actually quoting.
  const insertHistory = db.prepare(`INSERT INTO item_price_history
    (item_id, rate, quantity, lead_id, company_name, boq_id, source, created_by, created_by_name)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const updateItemPrice = db.prepare('UPDATE item_master SET current_price=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');
  const lead = lead_id ? db.prepare('SELECT company_name FROM leads WHERE id=?').get(lead_id) : null;
  const companyName = lead?.company_name || null;

  for (const i of (items || [])) {
    const itemId = i.item_id ? +i.item_id : null;
    insertItem.run(r.lastInsertRowid, i.description, i.quantity, i.unit, i.rate, i.quantity * i.rate, itemId);
    if (itemId && i.rate > 0) {
      insertHistory.run(itemId, i.rate, i.quantity || 0, lead_id || null, companyName, r.lastInsertRowid, 'boq', req.user.id, req.user.name || null);
      updateItemPrice.run(i.rate, itemId);
    }
  }
  res.status(201).json({ id: r.lastInsertRowid });
});

router.get('/boq/:id', (req, res) => {
  const boq = getDb().prepare('SELECT * FROM boq WHERE id=?').get(req.params.id);
  if (!boq) return res.status(404).json({ error: 'Not found' });
  boq.items = getDb().prepare('SELECT * FROM boq_items WHERE boq_id=?').all(req.params.id);
  res.json(boq);
});

// Quotations
router.get('/', (req, res) => {
  res.json(getDb().prepare(`SELECT q.*, l.company_name, u.name as created_by_name FROM quotations q
    LEFT JOIN leads l ON q.lead_id=l.id LEFT JOIN users u ON q.created_by=u.id ORDER BY q.created_at DESC`).all());
});

router.post('/', (req, res) => {
  const { lead_id, boq_id, total_amount, discount, final_amount, valid_until, notes } = req.body;
  const db = getDb();
  const { nextSequence } = require('../db/nextSequence');
  const qNum = nextSequence(db, 'quotations', 'quotation_number', 'QTN-', { startFrom: 0, pad: 4 });
  const r = db.prepare(
    'INSERT INTO quotations (lead_id, boq_id, quotation_number, total_amount, discount, final_amount, valid_until, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(lead_id, boq_id, qNum, total_amount, discount || 0, final_amount, valid_until, notes, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid, quotation_number: qNum });
});

router.put('/:id', (req, res) => {
  const { total_amount, discount, final_amount, status, valid_until, notes } = req.body;
  getDb().prepare('UPDATE quotations SET total_amount=?, discount=?, final_amount=?, status=?, valid_until=?, notes=? WHERE id=?')
    .run(total_amount, discount, final_amount, status, valid_until, notes, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/:id', (req, res) => {
  const db = getDb();
  const poCount = db.prepare('SELECT COUNT(*) as c FROM purchase_orders WHERE quotation_id=?').get(req.params.id).c;
  if (poCount > 0) return res.status(409).json({ error: 'Cannot delete: Purchase Orders reference this quotation' });
  db.prepare('DELETE FROM quotations WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

router.delete('/boq/:id', (req, res) => {
  const db = getDb();
  const qCount = db.prepare('SELECT COUNT(*) as c FROM quotations WHERE boq_id=?').get(req.params.id).c;
  if (qCount > 0) return res.status(409).json({ error: 'Cannot delete: Quotations reference this BOQ' });
  db.prepare('DELETE FROM boq_items WHERE boq_id=?').run(req.params.id);
  db.prepare('DELETE FROM boq WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ── PO/FOC Stripped (mam 2026-06-09) ──────────────────────────────
// Each entry = one PO item + FOC items + labour + margin, with an
// approval workflow (non_approved → approved → re_approved on later edit).
function computePoFoc(body) {
  const qty = Number(body.qty) || 0;
  const poRate = Number(body.po_rate) || 0;
  const labour = Number(body.labour) || 0;                 // labour rate (from labour_rates)
  const margin = Number(body.margin) || 0;
  const labourMargin = (body.labour_margin === '' || body.labour_margin == null) ? 50 : Number(body.labour_margin) || 0;
  const focs = Array.isArray(body.focs) ? body.focs.filter(f => f && (f.item_id || f.name)).map(f => ({
    item_id: f.item_id || null, name: f.name || '', qty: Number(f.qty) || 1, rate: Number(f.rate) || 0,
    // Per-FOC margin (mam 2026-06-23). null → inherits the PO margin so legacy
    // rows + the FOC-% line recompute exactly as before.
    margin: (f.margin === '' || f.margin == null) ? null : (Number(f.margin) || 0),
    ...(f.foc ? { foc: true } : {}),
    ...(f.is_pct ? { is_pct: true, foc_pct: f.foc_pct } : {}),
  })) : [];
  const poAmt = poRate * qty;
  const focAmt = focs.reduce((t, f) => t + f.rate * f.qty, 0);
  // Each FOC carries its OWN margin; null falls back to the PO margin.
  const focSale = focs.reduce((t, f) => t + f.rate * f.qty * (1 + ((f.margin == null ? margin : f.margin) / 100)), 0);
  const labourAmt = labour * qty;                          // labour RATE × PO qty
  const cost = Math.round((poAmt + focAmt + labourAmt) * 100) / 100;
  // PO carries the item margin, each FOC its own margin, labour its own.
  const tpa = Math.round((poAmt * (1 + margin / 100) + focSale + labourAmt * (1 + labourMargin / 100)) * 100) / 100;
  return { qty, poRate, labour, margin, labourMargin, focs, cost, tpa };
}

// Rebuild the same "[code] name / spec / size · uom" label the client shows.
function itemDisplay(im) {
  return `${im.item_code ? '[' + im.item_code + '] ' : ''}` +
    `${[im.item_name, im.specification, im.size].filter(Boolean).join(' / ')}` +
    `${im.uom ? ' · ' + im.uom : ''}`;
}

// Preload item_master + labour_rates into Maps so liveResolvePoFoc does O(1)
// in-memory lookups instead of a DB query per entry AND per FOC item. The list
// has 800+ kits × ~6-8 FOC each, so the old per-row queries meant thousands of
// point lookups on every load/approve and the page crawled (mam 2026-06-11:
// "takes lots of process time"). Two bulk reads replace all of them.
function buildLiveMaps(db) {
  const items = new Map();
  for (const im of db.prepare('SELECT id, item_code, item_name, specification, size, uom, current_price FROM item_master').all()) items.set(im.id, im);
  const labour = new Map();
  for (const lr of db.prepare('SELECT id, item_name, rate FROM labour_rates').all()) labour.set(lr.id, lr);
  return { items, labour };
}

// Serve an entry LIVE against the Item Master (mam 2026-06-11): PO rate, FOC
// rates, names and UOM are re-read by id every time, so editing an item's
// rate/UOM in the master reflects on existing PO/FOC entries. Stored values
// stay as a fallback when the item was deleted or typed manually (no item_id).
// cost/TPA are recomputed from the live rates so cards and PDF stay consistent.
function liveResolvePoFoc(row, maps) {
  let { po_rate, po_name, labour, labour_name } = row;
  if (row.po_item_id) {
    const im = maps.items.get(row.po_item_id);
    if (im) { po_rate = im.current_price || 0; po_name = itemDisplay(im); }
  }
  // Labour is live off the Labour Rate sheet too.
  if (row.labour_item_id) {
    const lr = maps.labour.get(row.labour_item_id);
    if (lr) { labour = lr.rate || 0; labour_name = lr.item_name; }
  }
  const focs = JSON.parse(row.focs_json || '[]').map(f => {
    if (f && f.item_id) {
      const im = maps.items.get(f.item_id);
      if (im) return { ...f, rate: im.current_price || 0, name: itemDisplay(im) };
    }
    return f;
  });
  const c = computePoFoc({ qty: row.qty, po_rate, labour, margin: row.margin, labour_margin: row.labour_margin, focs });
  return { ...row, po_rate, po_name, labour, labour_name, focs, cost: c.cost, tpa: c.tpa };
}

router.get('/po-foc', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM po_foc_entries ORDER BY updated_at DESC, id DESC').all();
  const counts = { non_approved: 0, approved: 0, re_approved: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  const maps = buildLiveMaps(db);
  res.json({ rows: rows.map(r => liveResolvePoFoc(r, maps)), counts });
});

router.get('/po-foc/:id', (req, res) => {
  const db = getDb();
  const r = db.prepare('SELECT * FROM po_foc_entries WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(liveResolvePoFoc(r, buildLiveMaps(db)));
});

router.post('/po-foc', (req, res) => {
  const c = computePoFoc(req.body);
  const r = getDb().prepare(
    `INSERT INTO po_foc_entries (po_item_id, po_name, po_rate, qty, labour, labour_item_id, labour_name, labour_margin, margin, focs_json, cost, tpa, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'non_approved', ?)`
  ).run(req.body.po_item_id || null, req.body.po_name || '', c.poRate, c.qty, c.labour,
        req.body.labour_item_id || null, req.body.labour_name || '', c.labourMargin, c.margin,
        JSON.stringify(c.focs), c.cost, c.tpa, req.user.id);
  res.json({ id: r.lastInsertRowid, message: 'Saved' });
});

router.put('/po-foc/:id', (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT status FROM po_foc_entries WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const c = computePoFoc(req.body);
  // Editing an APPROVED entry sends it to re_approved (mam's rule).
  const newStatus = cur.status === 'approved' ? 're_approved' : cur.status;
  db.prepare(
    `UPDATE po_foc_entries SET po_item_id=?, po_name=?, po_rate=?, qty=?, labour=?, labour_item_id=?, labour_name=?, labour_margin=?, margin=?,
            focs_json=?, cost=?, tpa=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
  ).run(req.body.po_item_id || null, req.body.po_name || '', c.poRate, c.qty, c.labour,
        req.body.labour_item_id || null, req.body.labour_name || '', c.labourMargin, c.margin,
        JSON.stringify(c.focs), c.cost, c.tpa, newStatus, req.params.id);
  res.json({ message: 'Updated', status: newStatus });
});

router.post('/po-foc/:id/approve', (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT id FROM po_foc_entries WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE po_foc_entries SET status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(req.user.id, req.params.id);
  res.json({ message: 'Approved' });
});

router.delete('/po-foc/:id', (req, res) => {
  getDb().prepare('DELETE FROM po_foc_entries WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ── Labour Rate sheet (mam 2026-06-10) ────────────────────────────
router.get('/labour-rates', (req, res) => {
  const db = getDb();
  const { search, category } = req.query;
  const cond = [], args = [];
  if (category) { cond.push('category = ?'); args.push(category); }
  if (search) { cond.push('LOWER(item_name) LIKE ?'); args.push('%' + String(search).toLowerCase() + '%'); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  res.json(db.prepare(`SELECT * FROM labour_rates ${where} ORDER BY category, item_name`).all(...args));
});

router.post('/labour-rates', (req, res) => {
  const { item_name, specification, size, rate, uom, category } = req.body;
  if (!item_name || !String(item_name).trim()) return res.status(400).json({ error: 'Item name is required' });
  const r = getDb().prepare('INSERT INTO labour_rates (item_name, specification, size, rate, uom, category, created_by) VALUES (?,?,?,?,?,?,?)')
    .run(String(item_name).trim(), specification || '', size || '', Number(rate) || 0, uom || '', category || '', req.user.id);
  res.json({ id: r.lastInsertRowid, message: 'Saved' });
});

router.put('/labour-rates/:id', (req, res) => {
  const { item_name, specification, size, rate, uom, category } = req.body;
  if (!item_name || !String(item_name).trim()) return res.status(400).json({ error: 'Item name is required' });
  getDb().prepare('UPDATE labour_rates SET item_name=?, specification=?, size=?, rate=?, uom=?, category=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(String(item_name).trim(), specification || '', size || '', Number(rate) || 0, uom || '', category || '', req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/labour-rates/:id', (req, res) => {
  getDb().prepare('DELETE FROM labour_rates WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ── Labour Rate Excel export / template / bulk import (mam 2026-06-11) ─
const LR_HEADERS = ['Item Name', 'Specification', 'Size', 'Rate', 'UOM', 'Category'];
function sendLabourXlsx(res, rowsAoA, filename) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([LR_HEADERS, ...rowsAoA]);
  ws['!cols'] = LR_HEADERS.map(h => ({ wch: Math.max(14, h.length + 2) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Labour Rates');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
}

// Download every labour rate as a real .xlsx (respects ?search / ?category).
router.get('/labour-rates/export', (req, res) => {
  const db = getDb();
  const { search, category } = req.query;
  const cond = [], args = [];
  if (category) { cond.push('category = ?'); args.push(category); }
  if (search) { cond.push('LOWER(item_name) LIKE ?'); args.push('%' + String(search).toLowerCase() + '%'); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const rows = db.prepare(`SELECT * FROM labour_rates ${where} ORDER BY category, item_name`).all(...args);
  const aoa = rows.map(r => [r.item_name, r.specification || '', r.size || '', r.rate || 0, r.uom || '', r.category || '']);
  sendLabourXlsx(res, aoa, 'labour-rates.xlsx');
});

// Blank template with the header row + one sample line.
router.get('/labour-rates/template', (req, res) => {
  sendLabourXlsx(res, [['SENSOR INSTALLATION', 'MS Type', '25mm', 350, 'PCS', 'ELECTRICAL']], 'labour-rates-template.xlsx');
});

// Find labour items that share the same name (case/space-insensitive) —
// duplicates that splinter one task across two rows (e.g. one MTRS + one Kg),
// which breaks the live link from PO/FOC kits (mam 2026-06-11).
router.get('/labour-rates/duplicates', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM labour_rates ORDER BY item_name, id').all();
  const usage = db.prepare('SELECT labour_item_id AS id, COUNT(*) AS c FROM po_foc_entries WHERE labour_item_id IS NOT NULL GROUP BY labour_item_id').all();
  const useMap = new Map(usage.map(u => [u.id, u.c]));
  const groups = new Map();
  for (const r of rows) {
    const key = String(r.item_name || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...r, used_in: useMap.get(r.id) || 0 });
  }
  res.json([...groups.values()].filter(g => g.length > 1));
});

// Merge duplicate labour rows: repoint every PO/FOC kit from the removed rows
// onto the kept row, then delete the removed rows (one transaction).
router.post('/labour-rates/merge', (req, res) => {
  const keepId = Number(req.body.keep_id);
  const removeIds = (Array.isArray(req.body.remove_ids) ? req.body.remove_ids : []).map(Number).filter(id => id && id !== keepId);
  if (!keepId || !removeIds.length) return res.status(400).json({ error: 'keep_id and at least one remove_id required' });
  const db = getDb();
  if (!db.prepare('SELECT id FROM labour_rates WHERE id=?').get(keepId)) return res.status(404).json({ error: 'Kept item not found' });
  const ph = removeIds.map(() => '?').join(',');
  const result = db.transaction(() => {
    const rep = db.prepare(`UPDATE po_foc_entries SET labour_item_id=? WHERE labour_item_id IN (${ph})`).run(keepId, ...removeIds);
    const del = db.prepare(`DELETE FROM labour_rates WHERE id IN (${ph})`).run(...removeIds);
    return { repointed: rep.changes, removed: del.changes };
  })();
  res.json(result);
});

// Bulk import from an uploaded .xlsx / .xls / .csv. First row = headers;
// columns matched case-insensitively. Item Name required; others optional.
router.post('/labour-rates/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const db = getDb();
  let rows;
  try {
    const wb = XLSX.readFile(req.file.path);
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(400).json({ error: 'Could not parse the file. Expected .xlsx / .xls / .csv' });
  }
  try { fs.unlinkSync(req.file.path); } catch (_) {}
  if (!rows.length) return res.status(400).json({ error: 'No data rows. Row 1 must be headers; data starts on row 2.' });

  const cleanKey = (k) => String(k || '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const insert = db.prepare('INSERT INTO labour_rates (item_name, specification, size, rate, uom, category, created_by) VALUES (?,?,?,?,?,?,?)');
  let added = 0; const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const r = {};
    Object.entries(rows[i]).forEach(([k, v]) => { r[cleanKey(k)] = typeof v === 'string' ? v.trim() : v; });
    const item_name = String(r['item name'] || '').trim();
    if (!item_name) { errors.push(`Row ${i + 2}: Item Name required`); continue; }
    try {
      insert.run(item_name, String(r['specification'] || ''), String(r['size'] || ''),
        Number(r['rate']) || 0, String(r['uom'] || ''), String(r['category'] || ''), req.user.id);
      added++;
    } catch (err) { errors.push(`Row ${i + 2}: ${err.message}`); }
  }
  res.json({ added, total: rows.length, errors });
});

// ── Saved AI Auto-Quotation estimates (mam 2026-06-10) ────────────
router.get('/estimates', (req, res) => {
  const rows = getDb().prepare(`SELECT id, title, client_name, sp, cost, updated_at, created_at
    FROM estimate_quotations ORDER BY client_name COLLATE NOCASE, updated_at DESC`).all();
  res.json(rows);
});
router.get('/estimates/:id', (req, res) => {
  const r = getDb().prepare('SELECT * FROM estimate_quotations WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json({ ...r, margins: JSON.parse(r.margins_json || '{}'), rows: JSON.parse(r.rows_json || '[]'), manpower: JSON.parse(r.manpower_json || '[]'), payment_terms: JSON.parse(r.payment_terms_json || '{}') });
});
router.post('/estimates', (req, res) => {
  const b = req.body || {};
  const r = getDb().prepare(`INSERT INTO estimate_quotations (title, lead_id, client_name, acc_pct, margins_json, rows_json, manpower_json, payment_terms_json, cost, sp, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(b.title || '', b.lead_id || null, b.client_name || '', Number(b.acc_pct) || 0,
    JSON.stringify(b.margins || {}), JSON.stringify(b.rows || []), JSON.stringify(b.manpower || []), JSON.stringify(b.payment_terms || {}),
    Number(b.cost) || 0, Number(b.sp) || 0, req.user.id);
  res.json({ id: r.lastInsertRowid, message: 'Saved' });
});
router.put('/estimates/:id', (req, res) => {
  const b = req.body || {};
  const ex = getDb().prepare('SELECT id FROM estimate_quotations WHERE id=?').get(req.params.id);
  if (!ex) return res.status(404).json({ error: 'Not found' });
  getDb().prepare(`UPDATE estimate_quotations SET title=?, lead_id=?, client_name=?, acc_pct=?, margins_json=?, rows_json=?, manpower_json=?, payment_terms_json=?, cost=?, sp=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(b.title || '', b.lead_id || null, b.client_name || '', Number(b.acc_pct) || 0,
      JSON.stringify(b.margins || {}), JSON.stringify(b.rows || []), JSON.stringify(b.manpower || []), JSON.stringify(b.payment_terms || {}),
      Number(b.cost) || 0, Number(b.sp) || 0, req.params.id);
  res.json({ message: 'Updated' });
});
router.delete('/estimates/:id', (req, res) => {
  getDb().prepare('DELETE FROM estimate_quotations WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Build the multi-sheet quotation Excel (mam's saizar format): one sheet per
// category + a SUMMARY with letterhead, category totals and a manpower block.
// ── Styled quotation workbook (ExcelJS) — logo, navy headers, borders,
// wrapped descriptions, currency number formats. Falls back to the plain
// SheetJS export below if exceljs isn't installed on the server.
async function buildStyledQuotation(ExcelJS, d) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Secured Engineers Pvt Ltd';
  const NAVY = 'FF1E3A8A', LIGHT = 'FFE8EEF7', GREY = 'FFF4F6FA', MONEY = '#,##0.00';
  const thin = { style: 'thin', color: { argb: 'FFD0D7E2' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  const QH = ['S.NO.', 'DESCRIPTION', 'MAKE', 'UNIT', 'QTY', 'RATE', 'AMOUNT', 'PP', 'ACCESS', 'LAB', 'TP', 'TPA', 'MARGIN', 'SP'];
  const styleHeader = (ws, rowIdx, n) => {
    const r = ws.getRow(rowIdx); r.height = 26;
    for (let c = 1; c <= n; c++) { const cell = r.getCell(c); cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }; cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' }; cell.border = border; }
  };

  // ── SUMMARY ──
  const sum = wb.addWorksheet('SUMMARY');
  sum.columns = [{ width: 34 }, { width: 18 }, { width: 16 }, { width: 16 }, { width: 18 }];
  const logoPath = path.join(__dirname, '..', '..', 'client', 'public', 'sepl-logo.png');
  if (fs.existsSync(logoPath)) {
    const imgId = wb.addImage({ filename: logoPath, extension: 'png' });
    sum.addImage(imgId, { tl: { col: 0, row: 0 }, ext: { width: 175, height: 56 } });
    sum.getRow(1).height = 46;
  }
  const co = [['B1', 'SECURED ENGINEERS PVT. LTD', { bold: true, size: 14, color: { argb: NAVY } }],
    ['B2', 'H.O: 2480/1, B.K. Towers, Janta Nagar, Gill Road, Ludhiana', { size: 9, color: { argb: 'FF555555' } }],
    ['B3', 'C.O: 58/A/1, First Floor, Kalu Sarai, New Delhi - 110016', { size: 9, color: { argb: 'FF555555' } }],
    ['B4', 'Website: www.securedengineers.com', { size: 9, color: { argb: 'FF555555' } }]];
  co.forEach(([a, v, f], i) => { sum.mergeCells(`${a}:E${i + 1}`); sum.getCell(a).value = v; sum.getCell(a).font = f; });
  sum.mergeCells('A6:E6'); const tb = sum.getCell('A6'); tb.value = `QUOTATION FOR ${d.title || 'WORK'}`; tb.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; tb.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } }; tb.alignment = { horizontal: 'center', vertical: 'middle' }; sum.getRow(6).height = 24;
  const info = [['NAME', d.client_name, 'Date', new Date().toISOString().slice(0, 10)], ['ADDRESS', d.client_address, 'Quotation No', d.quotation_no], ['PREP BY', d.prep_by, 'Revision No', 'R0']];
  let rr = 8;
  info.forEach(([k, v, k2, v2]) => { sum.getCell(`A${rr}`).value = k; sum.getCell(`A${rr}`).font = { bold: true }; sum.getCell(`B${rr}`).value = v; sum.getCell(`B${rr}`).alignment = { wrapText: true }; sum.getCell(`D${rr}`).value = k2; sum.getCell(`D${rr}`).font = { bold: true }; sum.getCell(`E${rr}`).value = v2; rr++; });
  rr++;
  sum.getCell(`A${rr}`).value = 'S.No.'; sum.getCell(`B${rr}`).value = 'Description'; sum.getCell(`C${rr}`).value = 'SP Amount (Rs)'; styleHeader(sum, rr, 3); rr++;
  let grand = 0, ci = 1;
  for (const [cat, items] of Object.entries(d.byCat)) { const sp = items.reduce((t, it) => t + (Number(it.sp) || 0), 0); grand += sp; sum.getCell(`A${rr}`).value = ci++; sum.getCell(`B${rr}`).value = cat; const cc = sum.getCell(`C${rr}`); cc.value = Math.round(sp * 100) / 100; cc.numFmt = MONEY; [`A${rr}`, `B${rr}`, `C${rr}`].forEach(a => sum.getCell(a).border = border); rr++; }
  sum.getCell(`B${rr}`).value = 'SUB TOTAL'; sum.getCell(`B${rr}`).font = { bold: true }; const stc = sum.getCell(`C${rr}`); stc.value = Math.round(grand * 100) / 100; stc.numFmt = MONEY; stc.font = { bold: true }; rr += 2;
  ['Additional / Manpower Cost', 'Qty', 'Monthly Cost', 'Months', 'Amount'].forEach((h, k) => sum.getCell(rr, k + 1).value = h); styleHeader(sum, rr, 5); rr++;
  let mTotal = 0;
  d.manpower.filter(m => m && m.name).forEach(m => { const amt = (Number(m.qty) || 0) * (Number(m.monthly_cost) || 0) * (Number(m.months) || 0); mTotal += amt; sum.getCell(rr, 1).value = m.name; sum.getCell(rr, 2).value = Number(m.qty) || 0; const mc = sum.getCell(rr, 3); mc.value = Number(m.monthly_cost) || 0; mc.numFmt = MONEY; sum.getCell(rr, 4).value = Number(m.months) || 0; const ac = sum.getCell(rr, 5); ac.value = Math.round(amt * 100) / 100; ac.numFmt = MONEY; for (let c = 1; c <= 5; c++) sum.getCell(rr, c).border = border; rr++; });
  sum.getCell(rr, 4).value = 'Manpower Total'; sum.getCell(rr, 4).font = { bold: true }; const mtc = sum.getCell(rr, 5); mtc.value = Math.round(mTotal * 100) / 100; mtc.numFmt = MONEY; mtc.font = { bold: true }; rr++;
  sum.getCell(rr, 4).value = 'GRAND TOTAL'; sum.getCell(rr, 4).font = { bold: true, size: 12 }; const gtc = sum.getCell(rr, 5); gtc.value = Math.round((grand + mTotal) * 100) / 100; gtc.numFmt = MONEY; gtc.font = { bold: true, size: 12, color: { argb: NAVY } }; for (let c = 1; c <= 5; c++) sum.getCell(rr, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };

  // ── per-category sheets ──
  const safeSheet = (s) => String(s || 'General').replace(/[\\/?*[\]:]/g, ' ').slice(0, 28).trim() || 'Sheet';
  for (const [cat, items] of Object.entries(d.byCat)) {
    const ws = wb.addWorksheet(safeSheet(cat));
    ws.columns = [{ width: 6 }, { width: 52 }, { width: 12 }, { width: 7 }, { width: 7 }, { width: 12 }, { width: 14 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 13 }, { width: 9 }, { width: 13 }];
    QH.forEach((h, k) => ws.getCell(1, k + 1).value = h); styleHeader(ws, 1, QH.length);
    let sp = 0, ri = 2;
    items.forEach((it, idx) => {
      const vals = [idx + 1, it.description || '', it.make || '', it.unit || '', Number(it.qty) || 0, Number(it.rate) || 0, Number(it.sp) || 0, Number(it.pp) || 0, Number(it.acc) || 0, Number(it.lab) || 0, Number(it.tp) || 0, Number(it.tpa) || 0, (Number(it.margin) || 0) + '%', Number(it.sp) || 0];
      vals.forEach((v, k) => {
        const cell = ws.getCell(ri, k + 1); cell.value = v; cell.border = border;
        cell.alignment = { vertical: 'top', wrapText: k === 1, horizontal: k === 0 ? 'center' : (k >= 4 ? 'right' : 'left') };
        if (k === 4) cell.numFmt = '0';
        else if ([5, 6, 7, 8, 9, 10, 11, 13].includes(k)) cell.numFmt = MONEY;
        if (idx % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREY } };
      });
      sp += Number(it.sp) || 0; ri++;
    });
    ws.getCell(ri, 1).value = 'TOTAL'; ws.getCell(ri, 1).font = { bold: true };
    const t7 = ws.getCell(ri, 7); t7.value = Math.round(sp * 100) / 100; t7.numFmt = MONEY; t7.font = { bold: true };
    const t14 = ws.getCell(ri, 14); t14.value = Math.round(sp * 100) / 100; t14.numFmt = MONEY; t14.font = { bold: true };
    for (let c = 1; c <= QH.length; c++) { ws.getCell(ri, c).border = border; ws.getCell(ri, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } }; }
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

router.post('/estimate-export', async (req, res) => {
  const { title = '', client_name = '', client_address = '', quotation_no = '', prep_by = '',
    rows = [], manpower = [] } = req.body || {};
  const sendBuf = (buf) => {
    res.setHeader('Content-Disposition', `attachment; filename="quotation-${String(title || 'estimate').replace(/[^a-z0-9]/gi, '_')}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  };
  // Group by category once (shared by both export paths).
  const byCatShared = {};
  for (const r of rows) { const c = r.category || 'General'; (byCatShared[c] = byCatShared[c] || []).push(r); }

  // Preferred: styled ExcelJS workbook. If exceljs isn't installed (or styling
  // throws), fall through to the plain SheetJS export — never 500 on this.
  let ExcelJS = null; try { ExcelJS = require('exceljs'); } catch { ExcelJS = null; }
  if (ExcelJS) {
    try {
      const buf = await buildStyledQuotation(ExcelJS, { title, client_name, client_address, quotation_no, prep_by, byCat: byCatShared, manpower });
      return sendBuf(buf);
    } catch (e) { /* fall through to plain */ }
  }

  try {
    const wb = XLSX.utils.book_new();
    const safeSheet = (s) => String(s || 'General').replace(/[\\/?*[\]:]/g, ' ').slice(0, 28).trim() || 'Sheet';
    const byCat = {};
    for (const r of rows) { const c = r.category || 'General'; (byCat[c] = byCat[c] || []).push(r); }

    const catTotals = [];
    for (const [cat, items] of Object.entries(byCat)) {
      const aoa = [['S.NO.', 'DESCRIPTION', 'MAKE', 'UNIT', 'QTY', 'RATE', 'AMOUNT', '', 'PP', 'ACCESS', 'LAB', 'TP', 'TPA', 'MARGIN', 'SP']];
      let sp = 0;
      items.forEach((it, i) => {
        aoa.push([i + 1, it.description || '', it.make || '', it.unit || '', it.qty || 0, it.rate || 0, it.sp || 0,
          '', it.pp || 0, it.acc || 0, it.lab || 0, it.tp || 0, it.tpa || 0, (it.margin || 0) + '%', it.sp || 0]);
        sp += Number(it.sp) || 0;
      });
      aoa.push(['TOTAL', '', '', '', '', '', Math.round(sp * 100) / 100, '', '', '', '', '', Math.round(sp * 100) / 100]);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), safeSheet(cat));
      catTotals.push({ cat, sp });
    }

    const sum = [];
    sum.push(['SECURED ENGINEERS PVT. LTD']);
    sum.push(['H.O: 2480/1 , B.K. Towers, Janta Nagar, Gill Road, Ludhiana']);
    sum.push(['C.O : 58/A/1, First Floor, Kalu Sarai, New Delhi - 110016']);
    sum.push(['Website : www.securedengineers.com']);
    sum.push([`QUOTATION FOR ${title || 'WORK'}`]);
    sum.push(['NAME', client_name, '', 'Date-:', new Date().toISOString().slice(0, 10)]);
    sum.push(['ADDRESS', client_address, '', 'Quotation No', quotation_no]);
    sum.push(['PREP BY', prep_by, '', 'Revision No', 'R0']);
    sum.push([]);
    sum.push(['S.No.', 'Description', 'SP Amount (Rs)']);
    let grand = 0;
    catTotals.forEach((c, i) => { sum.push([i + 1, c.cat, Math.round(c.sp * 100) / 100]); grand += c.sp; });
    sum.push(['', 'SUB TOTAL', Math.round(grand * 100) / 100]);
    sum.push([]);
    sum.push(['Additional / Manpower Cost', 'Qty', 'Monthly Cost', 'Months', 'Amount']);
    let mTotal = 0;
    manpower.filter(m => m && m.name).forEach(m => {
      const amt = (Number(m.qty) || 0) * (Number(m.monthly_cost) || 0) * (Number(m.months) || 0);
      sum.push([m.name, m.qty || 0, m.monthly_cost || 0, m.months || 0, Math.round(amt * 100) / 100]);
      mTotal += amt;
    });
    sum.push(['', '', '', 'Manpower Total', Math.round(mTotal * 100) / 100]);
    sum.push(['', '', '', 'GRAND TOTAL', Math.round((grand + mTotal) * 100) / 100]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sum), 'SUMMARY');
    wb.SheetNames.unshift(wb.SheetNames.pop()); // SUMMARY first

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="quotation-${String(title || 'estimate').replace(/[^a-z0-9]/gi, '_')}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

module.exports = router;
