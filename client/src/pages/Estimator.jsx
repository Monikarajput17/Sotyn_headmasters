import { useState, useEffect, useMemo, useRef, useCallback, Fragment } from 'react';
import api from '../api';
import SearchableSelect from '../components/SearchableSelect';
import MultiUserSelect from '../components/MultiUserSelect';
import toast from 'react-hot-toast';
import { FiPlus, FiTrash2, FiDownload, FiUploadCloud, FiEdit2, FiSave, FiRotateCcw, FiRotateCw } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';

// AI Auto-Quotation (Estimator) — mam 2026-06-09.
// Build a BOQ by picking items from Item Master (material rate PP auto-fills
// from current_price; the AI rate-suggestion shows the last-quoted rate).
// Each line: TP = PP + ACC + LAB, TPA = TP × qty,
//            SP = TPA × (1 + margin%)   ← margin is set PER CATEGORY.
// Mirrors mam's own quotation sheet columns (PP/ACC/LAB/TP/TPA/Margin/SP).

const blankRow = () => ({
  item_id: null, code: '', description: '', boq_text: '', category: '', make: '', unit: 'nos',
  qty: 1, pp: 0, lab: 0, suggestion: null,
  confidence: '', matchedName: '', matchScore: 0, alternatives: [],
  subs: [], // accessory / FOC items bundled under this line
  fromKit: false, // material rate + labour + FOC pulled from a PO/FOC kit
});

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

// Quotation Title disciplines (mam): the title is picked from this list and
// multiple may be selected (e.g. "Electrical, Plumbing"). Stored as a
// comma-joined string in `title` so it still flows to save / export / print.
const QUOTE_DISCIPLINES = ['Electrical', 'Mechanical', 'Low Voltage', 'Solar', 'Fire Fighting', 'Plumbing'];
// Split a saved title back into selected tokens, tolerating the legacy
// free-text titles (e.g. "250 KVA Servo") so editing an old estimate never
// loses its name — unknown tokens stay selectable/removable as their own chip.
const titleTokens = (t) => String(t || '').split(',').map(s => s.trim()).filter(Boolean);

export default function Estimator() {
  const [itemOptions, setItemOptions] = useState([]);
  const [leads, setLeads] = useState([]);
  const [leadId, setLeadId] = useState('');
  const [title, setTitle] = useState('');
  const [accPct, setAccPct] = useState(0);          // accessories = % of material (PP)
  const [margins, setMargins] = useState({});        // { category: marginPct }
  const [rows, setRows] = useState([blankRow()]);
  const [matching, setMatching] = useState(false);
  const [kitByPoId, setKitByPoId] = useState({}); // po_item_id → PO/FOC kit (labour, focs, po_rate)
  const pendingKit = useRef(null); // {i,itemId} of a line whose PO/FOC kit is being created in another tab
  // Manpower / additional cost block for the SUMMARY sheet (saizar format).
  // Months default to 1 so the Amount isn't 0 out of the gate (mam 2026-06-22);
  // every row is still editable. Project Start→End dates auto-fill the months.
  const [manpower, setManpower] = useState([
    { name: 'Site Engineer', qty: 1, monthly_cost: 40000, months: 1 },
    { name: 'Junior Engineer', qty: 1, monthly_cost: 25000, months: 1 },
    { name: 'Room rent, Food etc', qty: 1, monthly_cost: 10000, months: 1 },
    { name: 'Hydra', qty: 1, monthly_cost: 75000, months: 1 },
    { name: 'Scaffolding', qty: 1, monthly_cost: 40000, months: 1 },
  ]);
  // Project duration → drives the months on every manpower row (mam 2026-06-22).
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  // Overhead + Documentation = % of project cost (before margin), shown as lines
  // below the manpower table (mam 2026-06-22). Documentation was a flat ₹5,000.
  const [overheadPct, setOverheadPct] = useState(2);
  const [docPct, setDocPct] = useState(1);
  // Payment terms (mam 2026-06-25): the client's milestone split. Must total
  // 100%. Drives a cash-flow sanity check — the early inflow (Advance +
  // Material) should at least cover the material + accessory outflow (PP+ACC),
  // else the project can't be funded from the schedule ("you can't survive").
  const PAY_TERM_DEFAULTS = { advance: 10, material: 50, installation: 20, tc: 10, handover: 5, retention: 5 };
  const [payTerms, setPayTerms] = useState({ ...PAY_TERM_DEFAULTS });
  const [view, setView] = useState('build');     // 'build' | 'saved'
  const [savedList, setSavedList] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  // Which row's "Manual breakup" panel is expanded (discount / acc% / extra
  // cost / make). One at a time; null = all collapsed.
  const [openRow, setOpenRow] = useState(null);
  // Auto-save status (mam #5: "auto save like google sheets").
  const [saveState, setSaveState] = useState('');   // '' | 'saving' | 'saved' | 'error'
  const [savedAt, setSavedAt] = useState(null);
  const savingRef = useRef(false);
  // Undo/redo history for the items grid (mam #7). Snapshots are the immutable
  // row arrays (patchRow always makes new arrays) so reference identity = a
  // change worth recording.
  const histRef = useRef({ past: [], future: [] });
  const prevRowsRef = useRef(rows);
  const isUndoRedo = useRef(false);
  const [, bumpHist] = useState(0);   // force re-render so undo/redo buttons enable/disable
  const fileRef = useRef();

  // PO/FOC kits — picking an item pulls its labour rate + FOC + material rate
  // from the PO/FOC module. Approved kits win over drafts. Returns the map so a
  // caller (e.g. after a kit is created in another tab) can use it immediately.
  const loadKits = useCallback(async () => {
    try {
      const r = await api.get('/quotations/po-foc');
      const map = {};
      for (const k of (r.data.rows || [])) {
        if (!k.po_item_id) continue;
        if (!map[k.po_item_id] || (k.status === 'approved' && map[k.po_item_id].status !== 'approved')) {
          map[k.po_item_id] = { labour: k.labour, po_rate: k.po_rate, focs: k.focs || [], status: k.status, cost: k.cost, tpa: k.tpa };
        }
      }
      setKitByPoId(map);
      return map;
    } catch { return {}; }
  }, []);

  useEffect(() => {
    api.get('/item-master/dropdown').then(r => setItemOptions(r.data)).catch(() => {});
    // Client dropdown = Sales-Funnel clients at the BOQ + Vendor Costing stage
    // only (mam 2026-06-22) — those are the ones with a BOQ ready to quote,
    // not every funnel lead.
    api.get('/sales-funnel?stage=boq_costing').then(r => setLeads(r.data || [])).catch(() => {});
    loadKits();
  }, [loadKits]);

  // After creating a PO/FOC kit for a line in another tab (via "+ Create"),
  // returning here re-pulls kits and auto-applies the new breakup to that line
  // (mam 2026-06-30: "when save here then automatic in ai quotation").
  useEffect(() => {
    const onFocus = async () => {
      const pend = pendingKit.current;
      if (!pend) return;
      const map = await loadKits();
      const kit = map[pend.itemId];
      if (!kit) return; // not saved yet — keep waiting for the next return
      setRows(rs => rs.map((r, idx) => idx === pend.i ? { ...r, ...kitToPatch(kit) } : r));
      pendingKit.current = null;
      toast.success('Price breakup pulled from the new PO/FOC kit');
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadKits]);

  // Turn a PO/FOC kit into the row patch: material rate (PP), labour, FOC items as
  // charged accessories, and a SUGGESTED margin (mam 2026-06-30: "suggest the
  // margin %"). The kit's tpa is its sell price and cost is the raw cost, so
  // (tpa−cost)/cost is the single margin % that reproduces the kit's sell price —
  // the quote's SP then equals the kit's intended sell. Editable afterwards.
  // The single margin % that reproduces a kit's sell price: (tpa−cost)/cost.
  const kitMarginPct = (kit) => {
    const cost = Number(kit?.cost) || 0, tpa = Number(kit?.tpa) || 0;
    return (cost > 0 && tpa > 0) ? Math.round((tpa - cost) / cost * 1000) / 10 : null;
  };
  const kitToPatch = (kit, fallbackPp) => {
    const patch = {
      fromKit: true,
      lab: kit.labour || 0,
      pp: kit.po_rate || fallbackPp || 0,
      subs: (kit.focs || []).map(f => ({ item_id: f.item_id || null, name: f.name || '', qty: f.qty || 1, rate: f.rate || 0, foc: false })),
    };
    const mg = kitMarginPct(kit);
    if (mg != null) patch.margin = mg; // suggested blended margin %
    return patch;
  };

  // Pull labour + FOC + material rate (+ suggested margin) from a PO/FOC kit for an
  // item, if one exists.
  const kitFields = (itemId, fallbackPp) => {
    const kit = kitByPoId[itemId];
    return kit ? kitToPatch(kit, fallbackPp) : null;
  };

  // Category-margin fallback for a line with no explicit per-line margin. The
  // "Margin % per category" UI was removed (margin is set per line now), but this
  // fallback stays so older saved quotes with category margins still compute.
  const marginFor = (cat) => Number(margins[cat] ?? 0);

  // Backfill the kit's suggested margin into any matched line whose margin is
  // still BLANK (mam 2026-06-30: "margin not showing automatic from price
  // breakup"). The live match/pick path already sets it; this covers SAVED quotes
  // that were matched before the suggestion existed. Idempotent — only fills
  // blanks, so once filled it stops (no loop, never overwrites a typed value).
  useEffect(() => {
    if (!rows.length || !Object.keys(kitByPoId).length) return;
    let changed = false;
    const next = rows.map(r => {
      if (r.item_id && (r.margin == null || r.margin === '')) {
        const mg = kitMarginPct(kitByPoId[r.item_id]);
        if (mg != null) { changed = true; return { ...r, margin: mg }; }
      }
      return r;
    });
    if (changed) setRows(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, kitByPoId]);

  // Create a brand-new Item Master entry from an UNMATCHED BOQ line, then open the
  // PO/FOC price-breakup creator for it in a NEW TAB (mam 2026-06-30: "create item
  // mean this open in new tab, and when save here then automatic in ai quotation").
  // Admin → item auto-approved; the line is matched immediately, and the focus
  // handler above pulls the kit's PO rate + labour + FOC back when mam returns.
  const createItem = async (i) => {
    const row = rows[i];
    const name = (row.description || row.boq_text || '').trim();
    if (!name) return toast.error('Add a description first, then Create');
    try {
      const { data } = await api.post('/item-master', {
        item_name: name,
        current_price: Number(row.pp) || 0,
        department: row.category || 'General',
        uom: row.unit || 'PCS',
        type: 'PO',
      });
      const fresh = await api.get('/item-master/dropdown'); setItemOptions(fresh.data || []);
      patchRow(i, { item_id: data.id, matchedName: name, confidence: 'created', matchScore: 100, alternatives: [] });
      openKitTab(i, data.id);
      toast.success('Item created — set its price breakup in the new tab, then come back here');
    } catch (e) { toast.error(e.response?.data?.error || 'Could not create item'); }
  };

  // Save the line's current PP back onto the MATCHED item in Item Master, so the
  // next quotation reuses it (mam 2026-06-29: "add it in price master"). Admin →
  // saves instantly.
  const savePriceToMaster = async (i) => {
    const row = rows[i];
    if (!row.item_id) return toast.error('Match or create an item first');
    try {
      await api.patch(`/item-master/${row.item_id}/price`, { current_price: Number(row.pp) || 0 });
      toast.success('Price saved to Item Master');
    } catch (e) { toast.error(e.response?.data?.error || 'Could not save price'); }
  };

  // Open the PO/FOC price-breakup creator/editor for an item in a NEW TAB and arm
  // the focus handler so this line auto-prices when mam returns.
  const openKitTab = (i, itemId) => {
    pendingKit.current = { i, itemId };
    window.open(`/po-foc-stripped?poItem=${itemId}`, '_blank', 'noopener');
  };

  // Edit a MATCHED item's price breakup (mam 2026-06-30: "edit option"). Opens the
  // PO/FOC creator for the matched item — its existing kit if it has one, else a
  // fresh one — and auto-prices this line on return.
  const editKit = (i) => {
    const row = rows[i];
    if (!row.item_id) return toast.error('Match or create an item first');
    openKitTab(i, row.item_id);
    toast.success('Edit this item’s price breakup in the new tab, then come back here');
  };

  const patchRow = (i, patch) =>
    setRows(rs => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  // Pick an item from Item Master → auto-fill material rate (PP), category,
  // unit, description, then fetch the AI rate suggestion.
  const pickItem = async (i, opt) => {
    if (!opt) { patchRow(i, { item_id: null, suggestion: null, matchedName: '', confidence: '', fromKit: false }); return; }
    const kit = kitFields(opt.id, opt.current_price);
    setRows(rs => rs.map((r, idx) => idx === i ? {
      ...r,
      item_id: opt.id,
      code: opt.item_code || '',
      description: r.description || opt.display_name || opt.item_name || '',
      category: opt.department || 'General',
      make: opt.make || '',
      unit: (r.unit && r.unit !== 'nos') ? r.unit : (opt.uom || 'nos'),
      pp: opt.current_price || 0,
      lab: 0, subs: [], fromKit: false,
      ...(kit || {}),  // PO/FOC kit overrides pp + labour + FOC when it exists
      matchedName: opt.display_name || opt.item_name || '',
      ppAgeDays: opt.age_days ?? null, ppAgeStatus: opt.age_status ?? null,  // rate age (#4)
      matchScore: 100, confidence: 'high', alternatives: [],
    } : r));
    if (kit) toast.success('Labour + FOC pulled from PO/FOC kit');
    try {
      const params = { item_id: opt.id };
      if (leadId) params.lead_id = leadId;
      const { data } = await api.get('/ai-agent/rate-suggestion', { params });
      patchRow(i, { suggestion: data });
    } catch (e) { /* suggestion is best-effort */ }
  };

  // Apply a matched item — pull PP + labour + FOC from its PO/FOC kit (data
  // the backend sends on the match), or fall back to the catalogue rate.
  const matchToRow = (m) => {
    const hasKit = m.kit_pp !== undefined || Array.isArray(m.kit_focs);
    const row = {
      item_id: m.item_id, code: m.code, category: m.department, make: m.make || '',
      pp: hasKit ? (m.kit_pp || m.rate || 0) : (m.rate || 0),
      lab: hasKit ? (m.kit_labour || 0) : 0,
      subs: hasKit ? (m.kit_focs || []).map(f => ({ item_id: f.item_id || null, name: f.name || '', qty: f.qty || 1, rate: f.rate || 0, foc: false })) : [],
      fromKit: hasKit,
      matchedName: m.name, matchScore: m.score,
      confidence: m.score >= 60 ? 'high' : m.score >= 30 ? 'medium' : 'low',
    };
    // Suggest the kit's blended margin so SP reflects the kit's intended sell price
    // (mam 2026-06-30: "suggest the margin %") — same source/logic as kitToPatch.
    const kit = kitByPoId[m.item_id];
    if (kit) { const mg = kitToPatch(kit).margin; if (mg != null) row.margin = mg; }
    return row;
  };
  // Swap a row to one of the AI's alternative matches (one-click review).
  const applyMatch = (i, m) => patchRow(i, matchToRow(m));

  // Map the matcher's response rows → estimator rows (shared by file upload and
  // the funnel auto-load). Keeps the client's original BOQ wording in boq_text.
  const mapBoqRows = (data) => (data.rows || []).map(r => {
    const base = {
      ...blankRow(),
      description: r.description,
      boq_text: r.description,   // keep the client's original BOQ wording (mam 2026-06-22)
      unit: r.unit || r.match?.uom || 'nos',
      qty: r.qty || 1,
      confidence: r.confidence,
      alternatives: r.alternatives || [],
    };
    // Apply the matched item + pull PP + labour + FOC from its PO/FOC kit.
    return r.match ? { ...base, ...matchToRow(r.match) } : base;
  });

  // Upload the CLIENT's BOQ Excel → AI matches every line to Item Master.
  const uploadBoq = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setMatching(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await api.post('/quotations/auto-match-boq', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const mapped = mapBoqRows(data);
      if (!mapped.length) { toast.error('No items found in that BOQ'); return; }
      setRows(mapped);
      const unsure = mapped.filter(m => m.confidence === 'low' || m.confidence === 'none').length;
      toast.success(`Matched ${mapped.length} item(s) — ${unsure} need a quick review`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not read that BOQ');
    } finally {
      setMatching(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // Auto-load the selected client's BOQ from the Sales Funnel — no manual upload
  // (mam 2026-06-22). 404 = this client has no funnel BOQ → stay silent.
  const [loadingClientBoq, setLoadingClientBoq] = useState(false);
  const [clientBoqMsg, setClientBoqMsg] = useState('');   // result of the auto-fetch
  const onPickClient = async (id) => {
    setLeadId(id); setClientBoqMsg('');
    if (!id) return;
    // Don't silently wipe a quotation already in progress.
    const hasWork = rows.some(r => r.description || r.item_id);
    if (hasWork && !window.confirm("Load this client's BOQ from the Sales Funnel? This replaces the current items.")) return;
    setLoadingClientBoq(true);
    try {
      const { data } = await api.get('/quotations/client-boq', { params: { funnel_id: id } });
      const mapped = mapBoqRows(data);
      if (mapped.length) {
        setRows(mapped);
        const unsure = mapped.filter(m => m.confidence === 'low' || m.confidence === 'none').length;
        setClientBoqMsg(`✅ Loaded ${mapped.length} item(s) from this client's funnel BOQ${unsure ? ` — ${unsure} need a quick review` : ''}.`);
        toast.success(`Loaded ${mapped.length} item(s) from the client's funnel BOQ`);
      } else {
        setClientBoqMsg('The funnel BOQ had no readable items — you can upload it below.');
      }
    } catch (err) {
      // Show the server's specific reason (no BOQ in funnel vs file missing vs
      // not a server file) so it's clear why nothing loaded.
      if (err.response?.status === 404) setClientBoqMsg('ℹ️ ' + (err.response?.data?.error || 'No BOQ found in the Sales Funnel for this client — upload it below.'));
      else { setClientBoqMsg(''); toast.error(err.response?.data?.error || 'Could not load client BOQ'); }
    } finally { setLoadingClientBoq(false); }
  };

  // Accessory / FOC sub-items under a line. FOC = free (₹0, just listed);
  // a non-FOC accessory adds rate×qty to that line's cost.
  const addSub = (i) => setRows(rs => rs.map((r, idx) => idx === i
    ? { ...r, subs: [...(r.subs || []), { item_id: null, name: '', qty: 1, rate: 0, foc: true }] } : r));
  const patchSub = (i, si, patch) => setRows(rs => rs.map((r, idx) => idx === i
    ? { ...r, subs: (r.subs || []).map((s, sj) => sj === si ? { ...s, ...patch } : s) } : r));
  const removeSub = (i, si) => setRows(rs => rs.map((r, idx) => idx === i
    ? { ...r, subs: (r.subs || []).filter((_, sj) => sj !== si) } : r));
  const pickSub = (i, si, opt) => patchSub(i, si, opt
    ? { item_id: opt.id, name: opt.display_name || opt.item_name, rate: opt.current_price || 0 }
    : { item_id: null, name: '' });

  const confBadge = (c, score) => {
    if (c === 'high') return <span className="text-emerald-600 font-semibold">✅ {score}%</span>;
    if (c === 'medium') return <span className="text-amber-600 font-semibold">⚠️ {score}%</span>;
    if (c === 'low') return <span className="text-red-500 font-semibold">❗ {score}% check</span>;
    if (c === 'none') return <span className="text-red-500 font-semibold">❗ no match</span>;
    return null;
  };

  // Per-row computed economics (matches mam's sheet).
  //  • Discount % comes off the material / list price (PP): list × (1 − disc%).
  //    (mam #10: "item-wise master price list | discount %".)
  //  • Accessories % can be set PER LINE (row.accPct); blank → the global accPct.
  //  • Extra cost (with remark) is an additional per-line charge folded into TPA
  //    (mam #2: "extra box for any additional cost with remarks").
  //  • Qty NOT mentioned → quote a per-UNIT rate with +20 margin points and
  //    drop the line from the totals — you can't bill an amount without a qty
  //    (mam #9: "always add 20% extra margin to rate where Qty is not mentioned").
  const calc = (row) => {
    const listPp = Number(row.pp) || 0;
    const discount = Math.min(Math.max(Number(row.discountPct) || 0, 0), 100);
    const pp = r2(listPp * (1 - discount / 100));        // effective material after discount
    const qtyMissing = row.qty === '' || row.qty == null || Number(row.qty) === 0;
    const qty = Number(row.qty) || 0;
    const billQty = qtyMissing ? 1 : qty;                // price per-unit when qty unknown
    const lab = Number(row.lab) || 0;
    const lineAccPct = (row.accPct === '' || row.accPct == null) ? (Number(accPct) || 0) : (Number(row.accPct) || 0);
    const extra = Number(row.extraCost) || 0;
    // ACC = charged accessory/FOC subs + a % of material. Per-unit material %
    // so it still works when qty is missing.
    const subsCharged = r2((row.subs || []).filter(s => !s.foc)
      .reduce((t, s) => t + (Number(s.rate) || 0) * (Number(s.qty) || 0), 0));
    const accPerUnit = r2(pp * lineAccPct / 100);
    // Extra cost (mam 2026-06-30: a single "Extra ₹" column before PP, not the
    // per-field boxes) — folded into the line cost (TPA), so margin then applies.
    const acc = r2(subsCharged + accPerUnit * billQty);
    const tp = r2(pp + lab);                              // per-unit base (material + labour)
    const tpa = r2(tp * billQty + acc + extra);           // line cost incl accessories + Extra ₹
    // Per-line margin overrides the category margin when set. Blank → category.
    const baseMargin = (row.margin === '' || row.margin == null) ? marginFor(row.category) : Number(row.margin) || 0;
    const mPct = baseMargin + (qtyMissing ? 20 : 0);      // +20 pts when qty not mentioned (#9)
    const spFull = r2(tpa * (1 + mPct / 100));            // when qty missing this IS the per-unit rate
    const rate = qtyMissing ? spFull : (qty ? r2(spFull / qty) : 0);
    return {
      acc, tp, tpa, mPct, rate, subsCharged, discount, extra,
      effPp: pp, listPp, qtyMissing,
      sp: qtyMissing ? 0 : spFull,        // no line amount without a qty
      cost: qtyMissing ? 0 : tpa,
    };
  };

  const totals = useMemo(() => rows.reduce((t, row) => {
    const c = calc(row);
    t.cost += c.cost; t.sp += c.sp;
    return t;
  }, { cost: 0, sp: 0 }), [rows, accPct, margins]);
  const marginAmt = r2(totals.sp - totals.cost);
  // Per-row readiness (mam #8: "whichever is still pending → yellow"). A line is
  // 'ready' once it has a description AND yields a sale rate; 'pending' if it has
  // a BOQ/description but no price yet; 'empty' blank rows are ignored.
  const rowStatus = (row) => {
    const hasDesc = !!(row.description || row.boq_text);
    if (!hasDesc) return 'empty';
    return calc(row).rate > 0 ? 'ready' : 'pending';
  };
  const completeness = useMemo(() => {
    const considered = rows.filter(r => r.description || r.boq_text);
    const ready = considered.filter(r => rowStatus(r) === 'ready').length;
    return { total: considered.length, ready, pending: considered.length - ready,
      pct: considered.length ? Math.round(ready / considered.length * 100) : 100 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, accPct, margins]);
  // Lines the auto-match couldn't confidently map to Item Master (mam #3:
  // "mention what is not matching"). Surfaced in a panel so they get a manual
  // price instead of silently slipping through at ₹0.
  const unmatched = useMemo(() =>
    rows.map((r, i) => ({ r, i }))
        .filter(({ r }) => (r.boq_text || r.description) && (r.confidence === 'none' || r.confidence === 'low' || (!r.item_id && !(Number(r.pp) > 0)))),
    [rows]);
  // Overhead + Documentation = % of project cost (items cost, before margin).
  const overheadAmt = r2((Number(totals.cost) || 0) * (Number(overheadPct) || 0) / 100);
  const docAmt = r2((Number(totals.cost) || 0) * (Number(docPct) || 0) / 100);
  // Payment terms — must total 100%.
  const PAY_FIELDS = [
    ['advance', 'Advance'], ['material', 'Material'], ['installation', 'Installation'],
    ['tc', 'T & C'], ['handover', 'Handover'], ['retention', 'Retention'],
  ];
  const payTotal = r2(PAY_FIELDS.reduce((t, [k]) => t + (Number(payTerms[k]) || 0), 0));
  const payOk = Math.round(payTotal) === 100;
  // Cash-flow viability: material + accessory OUTFLOW (what you pay vendors,
  // PP×qty + ACC per line) vs the early INFLOW (Advance + Material % of the
  // sale price). If the early money doesn't cover the material, the schedule
  // can't fund the purchase (mam: "you can't survive").
  const ppAccCost = useMemo(() => rows.reduce((t, row) => {
    const c = calc(row);
    if (c.qtyMissing) return t;   // no qty → no funded outflow to schedule
    return t + c.effPp * (Number(row.qty) || 0) + c.acc;
  }, 0), [rows, accPct, margins]);
  const earlyPct = (Number(payTerms.advance) || 0) + (Number(payTerms.material) || 0);
  const earlyInflow = r2((Number(totals.sp) || 0) * earlyPct / 100);
  const payShortfall = r2(ppAccCost - earlyInflow);
  const cashRisk = (Number(totals.sp) || 0) > 0 && payShortfall > 0;
  // Project duration (Start→End) in months → auto-fills the manpower months.
  const projMonths = useMemo(() => {
    if (!startDate || !endDate) return 0;
    const a = new Date(startDate), b = new Date(endDate);
    if (isNaN(+a) || isNaN(+b) || b < a) return 0;
    return Math.max(1, Math.ceil(((b - a) / 86400000 + 1) / 30));
  }, [startDate, endDate]);
  // When the date range changes, set every manpower row's months to it.
  useEffect(() => {
    if (projMonths > 0) setManpower(m => m.map(r => ({ ...r, months: projMonths })));
  }, [projMonths]);

  const exportSheet = () => {
    const headers = ['S.NO', 'ITEM DESCRIPTION', 'UNIT', 'QTY', 'RATE', 'AMOUNT',
      'PP', 'ACC', 'LAB', 'TP', 'TPA', 'MARGIN %', 'SP', 'CATEGORY'];
    const data = [];
    // One row per main item only — FOC items are NOT listed in the export
    // (mam 2026-06-10). Their cost is already inside the line's TPA/SP.
    rows.filter(r => r.description).forEach((row, idx) => {
      const c = calc(row);
      data.push([idx + 1, row.description, row.unit, row.qty, c.rate, c.sp,
        row.pp, c.acc, row.lab, c.tp, c.tpa, c.mPct, c.sp, row.category]);
    });
    if (!data.length) { toast.error('Add at least one item'); return; }
    // Totals line
    data.push(['', 'TOTAL', '', '', '', totals.sp, '', '', '', '', totals.cost, '', totals.sp, '']);
    exportCsv(`quotation-${title || 'estimate'}`, headers, data);
  };

  const patchMp = (i, patch) => setManpower(m => m.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  const addMp = () => setManpower(m => [...m, { name: '', qty: 1, monthly_cost: 0, months: 1 }]);
  const removeMp = (i) => setManpower(m => m.filter((_, idx) => idx !== i));
  const mpAmt = (m) => (Number(m.qty) || 0) * (Number(m.monthly_cost) || 0) * (Number(m.months) || 0);

  // Full saizar-format export: per-category sheets + SUMMARY + manpower.
  const exportXlsx = async () => {
    const data = rows.filter(r => r.description).map((row, idx) => {
      const c = calc(row);
      return { s_no: idx + 1, description: row.description, make: row.make || '', unit: row.unit, qty: Number(row.qty) || 0, rate: c.rate, sp: c.sp, pp: Number(row.pp) || 0, acc: c.acc, lab: Number(row.lab) || 0, tp: c.tp, tpa: c.tpa, margin: c.mPct, category: row.category || 'General' };
    });
    if (!data.length) { toast.error('Add at least one item'); return; }
    const _cl = leads.find(l => String(l.id) === String(leadId));
    const clientName = (_cl?.company_name || _cl?.client_name || '');
    // Append the computed Overhead + Documentation lines to the Summary sheet.
    const mpExport = [...manpower];
    if (overheadAmt > 0) mpExport.push({ name: `Overhead (${overheadPct}% of project cost)`, qty: 1, monthly_cost: overheadAmt, months: 1 });
    if (docAmt > 0) mpExport.push({ name: `Documentation (${docPct}% of project cost)`, qty: 1, monthly_cost: docAmt, months: 1 });
    try {
      const resp = await api.post('/quotations/estimate-export', { title, client_name: clientName, manpower: mpExport, rows: data }, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([resp.data]));
      const a = document.createElement('a'); a.href = url; a.download = `quotation-${(title || 'estimate').replace(/[^a-z0-9]/gi, '_')}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success('Quotation downloaded');
    } catch (e) { toast.error('Export failed'); }
  };

  // Save / list / edit saved quotations (client-wise).
  const loadSavedList = () => api.get('/quotations/estimates').then(r => setSavedList(r.data || [])).catch(() => {});
  useEffect(() => { if (view === 'saved') loadSavedList(); }, [view]);

  const buildPayload = () => {
    const _cl = leads.find(l => String(l.id) === String(leadId));
    const clientName = (_cl?.company_name || _cl?.client_name || '');
    return { title, lead_id: leadId || null, client_name: clientName, acc_pct: accPct, margins, rows, manpower, payment_terms: payTerms, cost: totals.cost, sp: totals.sp };
  };
  const saveEstimate = async () => {
    if (!rows.some(r => r.description)) { toast.error('Add at least one item'); return; }
    try {
      const payload = buildPayload();
      if (currentId) { await api.put(`/quotations/estimates/${currentId}`, payload); }
      else { const r = await api.post('/quotations/estimates', payload); setCurrentId(r.data.id); }
      setSaveState('saved'); setSavedAt(new Date());
      toast.success('Quotation saved');
    } catch (e) { toast.error('Save failed'); }
  };

  // ── Auto-save (mam #5) ─────────────────────────────────────────────
  // Debounced save while editing, Google-Sheets style. To avoid littering the
  // saved list with empty drafts, the FIRST auto-save only fires once there's a
  // title (or it's already a saved estimate) AND at least one described item.
  // A save already in flight is skipped; the trailing debounce retries.
  const autoSave = useCallback(async () => {
    if (savingRef.current) return;
    if (!rows.some(r => r.description)) return;
    if (!currentId && !(title && title.trim())) return;
    savingRef.current = true; setSaveState('saving');
    try {
      const payload = buildPayload();
      if (currentId) await api.put(`/quotations/estimates/${currentId}`, payload);
      else { const r = await api.post('/quotations/estimates', payload); setCurrentId(r.data.id); }
      setSaveState('saved'); setSavedAt(new Date());
    } catch { setSaveState('error'); }
    finally { savingRef.current = false; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, title, margins, accPct, manpower, payTerms, leadId, currentId, totals.cost, totals.sp]);

  useEffect(() => {
    if (view !== 'build') return;
    const t = setTimeout(() => { autoSave(); }, 1500);
    return () => clearTimeout(t);
  }, [view, autoSave]);

  // ── Undo / redo (mam #7) ───────────────────────────────────────────
  // Record the PREVIOUS rows snapshot (debounced) whenever the grid changes,
  // unless the change came from an undo/redo itself.
  useEffect(() => {
    if (isUndoRedo.current) { isUndoRedo.current = false; prevRowsRef.current = rows; return; }
    const t = setTimeout(() => {
      if (prevRowsRef.current !== rows) {
        histRef.current.past.push(prevRowsRef.current);
        if (histRef.current.past.length > 60) histRef.current.past.shift();
        histRef.current.future = [];
        prevRowsRef.current = rows;
        bumpHist(n => n + 1);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [rows]);

  const undo = useCallback(() => {
    const h = histRef.current;
    if (!h.past.length) return;
    const prev = h.past.pop();
    h.future.unshift(prevRowsRef.current);
    isUndoRedo.current = true; prevRowsRef.current = prev;
    setRows(prev); setOpenRow(null); bumpHist(n => n + 1);
  }, []);
  const redo = useCallback(() => {
    const h = histRef.current;
    if (!h.future.length) return;
    const next = h.future.shift();
    h.past.push(prevRowsRef.current);
    isUndoRedo.current = true; prevRowsRef.current = next;
    setRows(next); setOpenRow(null); bumpHist(n => n + 1);
  }, []);

  // Keyboard: Ctrl/Cmd+Z = undo, Ctrl+Y or Ctrl/Cmd+Shift+Z = redo. Ignored
  // while typing in an input/textarea so it doesn't fight native field undo.
  useEffect(() => {
    const onKey = (e) => {
      if (view !== 'build') return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, undo, redo]);
  const editEstimate = async (id) => {
    try {
      const { data } = await api.get(`/quotations/estimates/${id}`);
      setTitle(data.title || ''); setLeadId(data.lead_id || ''); setAccPct(data.acc_pct || 0);
      setMargins(data.margins || {}); setManpower((data.manpower && data.manpower.length) ? data.manpower : []);
      setPayTerms((data.payment_terms && Object.keys(data.payment_terms).length) ? { ...PAY_TERM_DEFAULTS, ...data.payment_terms } : { ...PAY_TERM_DEFAULTS });
      setRows((data.rows && data.rows.length) ? data.rows : [blankRow()]);
      setCurrentId(id); setView('build'); toast.success('Loaded — you can edit and re-save');
    } catch (e) { toast.error('Failed to load'); }
  };
  const delEstimate = async (id) => { if (!confirm('Delete this saved quotation?')) return; try { await api.delete(`/quotations/estimates/${id}`); loadSavedList(); } catch (e) { toast.error('Failed'); } };
  const newEstimate = () => { setTitle(''); setLeadId(''); setAccPct(0); setMargins({}); setRows([blankRow()]); setPayTerms({ ...PAY_TERM_DEFAULTS }); setCurrentId(null); setView('build'); };

  const lab = (s) => <span className="text-[10px] font-semibold text-gray-500 uppercase">{s}</span>;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">🧮 AI Auto-Quotation {currentId && <span className="text-xs font-normal text-amber-600">(editing #{currentId})</span>}</h1>
          <p className="text-sm text-gray-500">Pick items from Item Master — material rate auto-fills, add labour, set margin per category, and the sale price is built automatically.</p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          {view === 'build' && (
            <div className="flex items-center gap-1 mr-1">
              <button onClick={undo} disabled={!histRef.current.past.length} title="Undo (Ctrl+Z)"
                className="btn btn-secondary text-sm px-2 disabled:opacity-40"><FiRotateCcw size={14} /></button>
              <button onClick={redo} disabled={!histRef.current.future.length} title="Redo (Ctrl+Y)"
                className="btn btn-secondary text-sm px-2 disabled:opacity-40"><FiRotateCw size={14} /></button>
            </div>
          )}
          {view === 'build' && saveState && (
            <span className="text-[11px] mr-1 whitespace-nowrap">
              {saveState === 'saving' ? <span className="text-gray-400">Saving…</span>
                : saveState === 'saved' ? <span className="text-emerald-600">✓ Saved{savedAt ? ` ${savedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
                : saveState === 'error' ? <span className="text-red-500">Save failed — retrying</span>
                : null}
            </span>
          )}
          <button onClick={newEstimate} className="btn btn-secondary text-sm flex items-center gap-1"><FiPlus size={14} /> New</button>
          <button onClick={() => setView('build')} className={`px-4 py-2 rounded-full text-sm font-semibold border ${view === 'build' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-200'}`}>Build</button>
          <button onClick={() => setView('saved')} className={`px-4 py-2 rounded-full text-sm font-semibold border ${view === 'saved' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-200'}`}>Saved (by client)</button>
        </div>
      </div>

      {view === 'saved' ? (
        <div className="card p-0 overflow-hidden">
          {savedList.length === 0 && <div className="p-8 text-center text-gray-400 text-sm">No saved quotations yet. Build one and click Save.</div>}
          {(() => {
            const byClient = {};
            savedList.forEach(s => { const c = s.client_name || '— No client —'; (byClient[c] = byClient[c] || []).push(s); });
            return Object.entries(byClient).map(([client, list]) => (
              <div key={client}>
                <div className="px-4 py-2 bg-gray-50 text-xs font-bold uppercase text-gray-600 border-b">{client} <span className="text-gray-400">({list.length})</span></div>
                {list.map(s => (
                  <div key={s.id} className="flex items-center justify-between gap-2 px-4 py-2 border-b border-gray-100 hover:bg-gray-50">
                    <div className="min-w-0">
                      <div className="font-medium text-gray-800 truncate">{s.title || '(untitled)'}</div>
                      <div className="text-[11px] text-gray-400">Sale Price ₹{fmt(s.sp)} · {String(s.updated_at || '').slice(0, 10)}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button onClick={() => editEstimate(s.id)} className="btn btn-secondary text-xs flex items-center gap-1"><FiEdit2 size={12} /> Edit</button>
                      <button onClick={() => delEstimate(s.id)} className="text-red-400 hover:text-red-600"><FiTrash2 size={14} /></button>
                    </div>
                  </div>
                ))}
              </div>
            ));
          })()}
        </div>
      ) : (<>

      {/* Header inputs */}
      <div className="card p-4 grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div>
          <label className="label">Client / Lead</label>
          <select className="select" value={leadId} onChange={e => onPickClient(e.target.value)}>
            <option value="">Select</option>
            {leads.map(l => <option key={l.id} value={l.id}>
              {[l.lead_no, l.company_name || l.client_name].filter(Boolean).join(' · ')}{l.company_name && l.client_name ? ` (${l.client_name})` : ''}
            </option>)}
          </select>
          {loadingClientBoq
            ? <div className="text-[11px] text-indigo-600 mt-1">⏳ Loading this client's BOQ from the Sales Funnel…</div>
            : clientBoqMsg
              ? <div className="text-[11px] text-gray-600 mt-1">{clientBoqMsg}</div>
              : <div className="text-[11px] text-gray-400 mt-1">Picking a client auto-loads their Sales-Funnel BOQ (no upload needed if it's in the funnel).</div>}
        </div>
        <div>
          <label className="label">Quotation Title</label>
          {(() => {
            const selected = titleTokens(title);
            // Offer the 6 standard disciplines plus any custom token already on
            // this estimate, so legacy free-text titles stay visible & editable.
            const opts = [...QUOTE_DISCIPLINES, ...selected.filter(t => !QUOTE_DISCIPLINES.includes(t))]
              .map(d => ({ id: d, name: d }));
            return (
              <MultiUserSelect
                options={opts}
                value={selected}
                onChange={(next) => setTitle(next.join(', '))}
                placeholder="Select discipline(s)…"
                emptyText="No matching discipline"
              />
            );
          })()}
        </div>
        <div>
          <label className="label" title="Accessories = this % of material rate">Accessories % (of material)</label>
          <input className="input" type="number" min="0" step="0.5" value={accPct} onChange={e => setAccPct(e.target.value)} />
        </div>
      </div>

      {/* Auto-build from client BOQ */}
      <div className="card p-4 flex flex-wrap items-center gap-3 bg-indigo-50/50 border border-indigo-100">
        <div className="flex-1 min-w-[220px]">
          <div className="font-semibold text-sm flex items-center gap-1">🤖 Auto-build from Client BOQ</div>
          <div className="text-xs text-gray-500">Upload the client's BOQ — Excel, PDF or Word. AI matches each line to your Item Master and fills the rates. Review the lines it flags ❗.</div>
        </div>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.pdf,.doc,.docx" className="hidden" onChange={uploadBoq} />
        <button type="button" disabled={matching} onClick={() => fileRef.current?.click()}
          className="btn btn-primary text-sm flex items-center gap-1">
          <FiUploadCloud size={15} /> {matching ? 'Matching…' : 'Upload Client BOQ'}
        </button>
      </div>

      {/* Per-category margins */}
      {/* "Margin % per category" block removed (mam 2026-06-30): margin is now set
          PER LINE (each line's Margin column, auto-suggested from the PO/FOC kit),
          so the category-level margin was a duplication. The margins state + the
          marginFor() fallback are kept so older saved quotes still load correctly. */}

      {/* Not matching (mam #3) — BOQ lines the auto-match couldn't map. Click
          one to open its Manual breakup and price it by hand. */}
      {unmatched.length > 0 && (
        <div className="card p-3 bg-red-50 border border-red-200">
          <div className="font-semibold text-sm text-red-700 mb-1.5">⚠ {unmatched.length} line(s) not matched to Item Master — review &amp; price these</div>
          <div className="flex flex-wrap gap-2">
            {unmatched.map(({ r, i }) => {
              const priced = calc(r).rate > 0;
              return (
                <button key={i} type="button" onClick={() => setOpenRow(i)}
                  className="text-[11px] bg-white border border-red-200 rounded px-2 py-1 text-left hover:bg-red-100 max-w-[280px] truncate"
                  title={r.boq_text || r.description}>
                  <span className="text-gray-400">#{i + 1}</span> {r.boq_text || r.description || '(no text)'}
                  <span className={priced ? 'text-emerald-600 font-semibold' : 'text-red-500 font-semibold'}> · {priced ? 'priced' : 'no price'}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Completeness (mam #8) — % of lines that are priced; pending lines are
          highlighted yellow in the table so nothing ships half-priced. */}
      {completeness.total > 0 && (
        <div className={`flex items-center gap-3 text-xs px-1 ${completeness.pending ? 'text-amber-700' : 'text-emerald-700'}`}>
          <span className="font-semibold whitespace-nowrap">{completeness.pct}% priced</span>
          <div className="h-1.5 bg-gray-100 rounded overflow-hidden w-full max-w-[240px]">
            <div className="h-full bg-emerald-400 transition-all" style={{ width: `${completeness.pct}%` }}></div>
          </div>
          {completeness.pending > 0
            ? <span className="whitespace-nowrap">{completeness.pending} line(s) still pending (yellow)</span>
            : <span className="whitespace-nowrap">All lines priced ✓</span>}
        </div>
      )}

      {/* Items table — frozen header (sticky) + fits the width (no horizontal
          drag): table is w-full so columns compress to the container. */}
      <div className="card p-0 overflow-auto max-h-[60vh]">
        <table className="w-full text-sm table-fixed">
          <thead className="sticky top-0 z-10 bg-gray-50">
            <tr className="bg-gray-50 text-left text-[11px] uppercase text-gray-500">
              <th className="p-1.5 w-7">#</th>
              <th className="p-1.5">BOQ item</th>
              <th className="p-1.5">Match item (PO → FOC)</th>
              <th className="p-1.5 w-20">Category</th>
              <th className="p-1.5 text-center w-16">Qty</th>
              <th className="p-1.5 text-right w-16" title="Extra cost for this line — added to the line cost (TPA), then margin applies">Extra ₹</th>
              <th className="p-1.5 text-right w-16" title="Material price (auto from Item Master)">PP ₹</th>
              <th className="p-1.5 text-right w-14" title="Accessories = PP × Acc%">ACC ₹</th>
              <th className="p-1.5 text-right w-16" title="Labour (enter manually / from labour sheet)">LAB ₹</th>
              <th className="p-1.5 text-right w-14" title="TP = PP + ACC + LAB">TP ₹</th>
              <th className="p-1.5 text-right w-16" title="TPA = TP × Qty (total cost)">TPA ₹</th>
              <th className="p-1.5 text-right w-12">Margin</th>
              <th className="p-1.5 text-right w-16" title="SP = TPA × (1 + margin%)">SP ₹</th>
              <th className="p-1.5 text-right w-14" title="Sale rate per unit = SP ÷ Qty">Rate ₹</th>
              <th className="p-1.5 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const c = calc(row);
              const st = rowStatus(row);
              const rowBg = st === 'pending' ? 'bg-amber-50' : ((row.confidence === 'low' || row.confidence === 'none') ? 'bg-red-50/40' : '');
              const hasExtras = (Number(row.discountPct) || 0) > 0 || (row.accPct !== '' && row.accPct != null);
              return (
                <Fragment key={i}>
                <tr className={`border-t border-gray-100 align-top ${rowBg}`}>
                  <td className="p-2 align-top">
                    <div className="text-gray-400">{i + 1}</div>
                    {st === 'pending' && <div className="mt-1 w-2 h-2 rounded-full bg-amber-400" title="Pending — no price yet"></div>}
                    {st === 'ready' && <div className="mt-1 w-2 h-2 rounded-full bg-emerald-400" title="Priced"></div>}
                  </td>
                  {/* Column 2 — BOQ item (client's original line). mam 2026-06-22:
                      "table: s.no | BOQ item | match item". */}
                  <td className="p-2 align-top">
                    {row.boq_text
                      ? <div className="text-[11px] text-gray-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 break-words">{row.boq_text}</div>
                      : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                  {/* Column 3 — Match item (the matched Item Master / PO item,
                      with its FOC accessories listed underneath). */}
                  <td className="p-2 align-top">
                    <SearchableSelect
                      options={itemOptions}
                      value={row.item_id}
                      valueKey="id"
                      displayKey="display_name"
                      placeholder="Search Item Master…"
                      onChange={opt => pickItem(i, opt)}
                    />
                    <input className="input mt-1 text-xs" value={row.description}
                      onChange={e => patchRow(i, { description: e.target.value })}
                      placeholder="Description (auto-filled)" />
                    {!row.item_id && (
                      <button type="button" onClick={() => createItem(i)}
                        className="mt-1 inline-block text-[10px] font-semibold text-emerald-700 border border-emerald-300 rounded px-1.5 py-0.5 hover:bg-emerald-50"
                        title="No match? Creates this as a new item and opens its PO/FOC price-breakup form in a new tab. Set the PO rate / labour / FOC there, save, and come back — this line prices automatically.">
                        ＋ Create in Item Master
                      </button>
                    )}
                    {row.suggestion && (row.suggestion.last_for_client || row.suggestion.last_overall) && (
                      <div className="text-[10px] text-indigo-600 mt-1">
                        🤖 last quoted: ₹{fmt(row.suggestion.last_for_client?.rate || row.suggestion.last_overall?.rate)}
                        <button type="button" className="ml-1 underline"
                          onClick={() => patchRow(i, { pp: row.suggestion.last_for_client?.rate || row.suggestion.last_overall?.rate })}>
                          use as material
                        </button>
                      </div>
                    )}
                    {row.matchedName && (
                      <div className="text-[10px] mt-1 flex items-center gap-1 flex-wrap">
                        {confBadge(row.confidence, row.matchScore)}
                        <span className="text-gray-500">→ {row.matchedName}</span>
                        {row.ppAgeDays != null && (
                          <span className={`px-1 rounded ${row.ppAgeStatus === 'red' ? 'bg-red-100 text-red-700' : row.ppAgeStatus === 'yellow' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}
                            title="Age of the material (PP) rate in Item Master — refresh it if old">
                            rate {row.ppAgeDays}d old
                          </span>
                        )}
                      </div>
                    )}
                    {row.item_id && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        <button type="button" onClick={() => savePriceToMaster(i)}
                          className="inline-block text-[10px] font-semibold text-indigo-700 border border-indigo-300 rounded px-1.5 py-0.5 hover:bg-indigo-50"
                          title="Save the current PP as this item's price in Item Master, so future quotations reuse it.">
                          💾 Save price to master
                        </button>
                        <button type="button" onClick={() => editKit(i)}
                          className="inline-block text-[10px] font-semibold text-amber-700 border border-amber-300 rounded px-1.5 py-0.5 hover:bg-amber-50"
                          title="Open this item's PO/FOC price breakup (PO rate + labour + FOC) in a new tab — edits the existing one or creates it. Auto-prices this line when you return.">
                          ✏ Edit price breakup
                        </button>
                      </div>
                    )}
                    {row.alternatives?.length > 0 && (row.confidence === 'low' || row.confidence === 'medium' || row.confidence === 'none') && (
                      <div className="flex flex-wrap gap-1 mt-1 items-center">
                        <span className="text-[9px] text-gray-400">try:</span>
                        {row.alternatives.map((a, ai) => (
                          <button key={ai} type="button" onClick={() => applyMatch(i, a)}
                            className="text-[10px] bg-white hover:bg-indigo-100 border border-gray-200 rounded px-1 py-0.5">
                            {a.name} ({a.score}%)
                          </button>
                        ))}
                      </div>
                    )}
                    {/* Accessory / FOC sub-items. When pulled from a Price Breakup
                        kit (fromKit) they are PERMANENT — shown read-only, no edit
                        / add / remove (mam 2026-06-22). */}
                    <div className="mt-1.5 pl-2 border-l-2 border-indigo-100 space-y-1">
                      {row.fromKit ? (
                        <>
                          <div className="text-[9px] text-indigo-500 font-semibold uppercase">FOC — from Price Breakup (locked)</div>
                          {(row.subs || []).map((s, si) => (
                            <div key={si} className="flex items-center gap-1.5 text-[10px] text-gray-600">
                              <span className="flex-1 truncate">{s.name || 'item'}</span>
                              <span className="text-gray-400">×{s.qty || 1}</span>
                              <span className={s.foc ? 'text-emerald-600 font-semibold' : 'text-gray-500'}>{s.foc ? 'FOC' : `₹${fmt(s.rate)}`}</span>
                            </div>
                          ))}
                          {(row.subs || []).length === 0 && <div className="text-[10px] text-gray-300 italic">No FOC in this kit.</div>}
                        </>
                      ) : (<>
                      {(row.subs || []).map((s, si) => (
                        <div key={si} className="flex items-center gap-1 flex-wrap">
                          <div className="w-40">
                            <SearchableSelect options={itemOptions} value={s.item_id} valueKey="id"
                              displayKey="display_name" placeholder="Accessory…"
                              onChange={opt => pickSub(i, si, opt)} />
                          </div>
                          <input className="input w-12 text-center py-0.5 text-xs" type="number" min="0"
                            value={s.qty || ''} onChange={e => patchSub(i, si, { qty: e.target.value })} title="Qty" />
                          <label className="text-[10px] flex items-center gap-0.5" title="Free of cost">
                            <input type="checkbox" checked={s.foc} onChange={e => patchSub(i, si, { foc: e.target.checked })} />
                            <span className={s.foc ? 'text-emerald-600 font-semibold' : 'text-gray-400'}>FOC</span>
                          </label>
                          {!s.foc && (
                            <input className="input w-16 text-right py-0.5 text-xs" type="number" min="0"
                              value={s.rate || ''} onChange={e => patchSub(i, si, { rate: e.target.value })} placeholder="rate" />
                          )}
                          <button type="button" className="text-red-300 hover:text-red-500"
                            onClick={() => removeSub(i, si)}><FiTrash2 size={11} /></button>
                        </div>
                      ))}
                      <button type="button" className="text-[10px] text-indigo-600 hover:underline"
                        onClick={() => addSub(i)}>+ Accessory / FOC</button>
                      </>)}
                    </div>
                  </td>
                  <td className="p-1.5 text-xs text-gray-600 break-words">
                    {row.category || '—'}
                    {row.make && <div className="text-[10px] text-gray-400 mt-0.5">Make: {row.make}</div>}
                  </td>
                  <td className="p-1.5">
                    <input className="input w-full text-center py-1 px-1 text-xs [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" type="number" min="0" value={row.qty || ''}
                      onChange={e => patchRow(i, { qty: e.target.value })} />
                  </td>
                  <td className="p-1.5">
                    <input className="input w-full text-right py-1 px-1 text-xs" type="number" min="0" value={row.extraCost || ''}
                      onChange={e => patchRow(i, { extraCost: e.target.value })} placeholder="0"
                      title="Extra cost for this line — added to the line cost (TPA); margin then applies." />
                  </td>
                  <td className="p-1.5">
                    <input className="input w-full text-right py-1 px-1 text-xs" type="number" min="0" value={row.pp || ''}
                      onChange={e => patchRow(i, { pp: e.target.value })} placeholder="0" />
                    {c.discount > 0 && <div className="text-[9px] text-rose-500 text-right mt-0.5" title="Material price after discount">−{c.discount}% = ₹{fmt(c.effPp)}</div>}
                  </td>
                  <td className="p-1.5 text-right text-xs text-gray-600">{fmt(c.acc)}</td>
                  <td className="p-1.5">
                    <input className="input w-full text-right py-1 px-1 text-xs" type="number" min="0" value={row.lab || ''}
                      onChange={e => patchRow(i, { lab: e.target.value })} placeholder="0" />
                    {row.fromKit && <div className="text-[9px] text-indigo-500 mt-0.5 text-right" title="Labour + FOC from the PO/FOC module">🔗</div>}
                  </td>
                  <td className="p-1.5 text-right text-xs text-gray-700">{fmt(c.tp)}</td>
                  <td className="p-1.5 text-right text-xs text-gray-700">{fmt(c.tpa)}</td>
                  <td className="p-1.5 text-right text-xs">
                    <input className="input text-right text-xs py-1 w-14" type="number" min="0"
                      value={row.margin ?? ''} placeholder={`${marginFor(row.category)}`}
                      onChange={e => patchRow(i, { margin: e.target.value })}
                      title="Per-line margin % — overrides the category margin. Blank = use the category margin." />
                  </td>
                  <td className="p-1.5 text-right text-xs font-bold text-emerald-700">{c.qtyMissing ? <span className="text-gray-300" title="No amount without a qty">—</span> : fmt(c.sp)}</td>
                  <td className="p-1.5 text-right text-xs">{fmt(c.rate)}{c.qtyMissing && c.rate > 0 && <div className="text-[8px] text-amber-600 font-semibold leading-tight" title="Qty not mentioned — per-unit rate with +20% margin">rate +20%</div>}</td>
                  <td className="p-1.5 text-center align-top">
                    <div className="flex flex-col items-center gap-1">
                      <button type="button" title="Manual breakup — discount, accessories %, extra cost, make"
                        onClick={() => setOpenRow(openRow === i ? null : i)}
                        className={`text-xs px-1.5 py-0.5 rounded border leading-none ${openRow === i ? 'bg-indigo-600 text-white border-indigo-600' : hasExtras ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'text-gray-500 border-gray-200 hover:bg-gray-50'}`}>
                        ⚙{hasExtras ? '•' : ''}
                      </button>
                      <button type="button" className="text-red-400 hover:text-red-600"
                        onClick={() => setRows(rs => rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs)}>
                        <FiTrash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
                {openRow === i && (
                  <tr className="bg-indigo-50/30 border-t border-indigo-100">
                    <td></td>
                    <td colSpan={14} className="p-3">
                      <div className="text-[11px] font-semibold text-indigo-700 mb-2">
                        Manual breakup — fill anything the auto-match couldn't (use this to price an item not found in the master).
                      </div>
                      <div className="flex flex-wrap items-end gap-4">
                        <label className="text-[11px] text-gray-600">Discount % (on material)
                          <input className="input w-24 mt-0.5 text-right py-1 text-xs" type="number" min="0" max="100" step="0.5"
                            value={row.discountPct ?? ''} placeholder="0" onChange={e => patchRow(i, { discountPct: e.target.value })} />
                        </label>
                        <label className="text-[11px] text-gray-600">Accessories % (this line)
                          <input className="input w-28 mt-0.5 text-right py-1 text-xs" type="number" min="0" step="0.5"
                            value={row.accPct ?? ''} placeholder={`${accPct || 0} (global)`} onChange={e => patchRow(i, { accPct: e.target.value })} />
                        </label>
                        <label className="text-[11px] text-gray-600">Extra cost ₹
                          <input className="input w-28 mt-0.5 text-right py-1 text-xs" type="number" min="0"
                            value={row.extraCost ?? ''} placeholder="0" onChange={e => patchRow(i, { extraCost: e.target.value })} />
                        </label>
                        <label className="text-[11px] text-gray-600 flex-1 min-w-[180px]">Extra cost remark
                          <input className="input w-full mt-0.5 py-1 text-xs" value={row.extraRemark ?? ''}
                            placeholder="reason for the extra cost (crane, special packing…)" onChange={e => patchRow(i, { extraRemark: e.target.value })} />
                        </label>
                        <label className="text-[11px] text-gray-600">Make / brand
                          <input className="input w-40 mt-0.5 py-1 text-xs" value={row.make ?? ''}
                            placeholder="e.g. Polycab" onChange={e => patchRow(i, { make: e.target.value })} />
                        </label>
                        <label className="text-[11px] text-gray-600">Rate source / supplier
                          <input className="input w-40 mt-0.5 py-1 text-xs" value={row.source ?? ''}
                            placeholder="e.g. Vijay Sales" onChange={e => patchRow(i, { source: e.target.value })} />
                        </label>
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-200 bg-gray-50 font-semibold">
              <td className="p-2" colSpan={9}></td>
              <td className="p-2 text-right" title="Total cost">{fmt(totals.cost)}</td>
              <td className="p-2 text-right text-emerald-700" title="Margin amount">+{fmt(marginAmt)}</td>
              <td className="p-2 text-right text-emerald-700 text-base">{fmt(totals.sp)}</td>
              <td className="p-2" colSpan={2}></td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Manpower / Additional cost — flows into the SUMMARY sheet */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-gray-700">Manpower / Additional Cost (for the Summary sheet)</span>
          <button type="button" onClick={addMp} className="text-xs text-indigo-600 hover:underline flex items-center gap-1"><FiPlus size={12} /> Add row</button>
        </div>
        {/* Project duration → auto-fills the Months on every row (mam 2026-06-22) */}
        <div className="flex flex-wrap items-center gap-2 mb-3 text-sm bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
          <span className="font-semibold text-gray-600">Project duration</span>
          <label className="text-[11px] text-gray-500">Start</label>
          <input type="date" className="input w-[150px] py-1 text-sm" value={startDate} max={endDate || undefined} onChange={e => setStartDate(e.target.value)} />
          <label className="text-[11px] text-gray-500">End</label>
          <input type="date" className="input w-[150px] py-1 text-sm" value={endDate} min={startDate || undefined} onChange={e => setEndDate(e.target.value)} />
          {projMonths > 0
            ? <span className="text-emerald-700 font-semibold">= {projMonths} month(s) — applied to all rows below</span>
            : <span className="text-[11px] text-gray-400">pick dates to auto-set the months</span>}
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead><tr className="text-[10px] uppercase text-gray-400 text-left">
              <th className="p-1 min-w-[180px]">Item</th><th className="p-1 text-right">Qty</th><th className="p-1 text-right">Monthly Cost ₹</th><th className="p-1 text-right">Months</th><th className="p-1 text-right">Amount ₹</th><th></th>
            </tr></thead>
            <tbody>
              {manpower.map((m, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="p-1"><input className="input py-1" value={m.name} onChange={e => patchMp(i, { name: e.target.value })} placeholder="e.g. Site Engineer" /></td>
                  <td className="p-1 w-16"><input className="input text-right py-1" type="number" min="0" value={m.qty} onChange={e => patchMp(i, { qty: e.target.value })} /></td>
                  <td className="p-1 w-28"><input className="input text-right py-1" type="number" min="0" value={m.monthly_cost} onChange={e => patchMp(i, { monthly_cost: e.target.value })} /></td>
                  <td className="p-1 w-20"><input className="input text-right py-1" type="number" min="0" value={m.months} onChange={e => patchMp(i, { months: e.target.value })} /></td>
                  <td className="p-1 text-right font-medium">{fmt(mpAmt(m))}</td>
                  <td className="p-1"><button type="button" className="text-red-400 hover:text-red-600" onClick={() => removeMp(i)}><FiTrash2 size={13} /></button></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="border-t-2 border-gray-200 font-semibold"><td className="p-1" colSpan={4}>Manpower Total</td><td className="p-1 text-right text-indigo-700">₹{fmt(manpower.reduce((t, m) => t + mpAmt(m), 0))}</td><td></td></tr></tfoot>
          </table>
        </div>
        {/* Overhead = % of project cost (before margin) — mam 2026-06-22 */}
        <div className="flex flex-wrap items-center justify-end gap-2 mt-3 pt-3 border-t border-gray-200 text-sm">
          <span className="font-semibold text-gray-700">Overhead</span>
          <input className="input w-16 text-right py-1" type="number" min="0" step="0.5"
            value={overheadPct} onChange={e => setOverheadPct(e.target.value)} />
          <span className="text-gray-400">% of project cost (before margin)</span>
          <span className="font-semibold text-indigo-700 ml-2">₹{fmt(overheadAmt)}</span>
        </div>
        {/* Documentation = % of project cost — below Overhead (mam 2026-06-22) */}
        <div className="flex flex-wrap items-center justify-end gap-2 mt-2 text-sm">
          <span className="font-semibold text-gray-700">Documentation</span>
          <input className="input w-16 text-right py-1" type="number" min="0" step="0.5"
            value={docPct} onChange={e => setDocPct(e.target.value)} />
          <span className="text-gray-400">% of project cost (before margin)</span>
          <span className="font-semibold text-indigo-700 ml-2">₹{fmt(docAmt)}</span>
        </div>
      </div>

      {/* Payment Terms — milestone split (must total 100%) + cash-flow check */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <span className="text-sm font-semibold text-gray-700">Payment Terms <span className="text-xs font-normal text-gray-400">— must total 100%</span></span>
          <span className={`text-xs font-bold px-2 py-1 rounded ${payOk ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
            Total: {fmt(payTotal)}%{payOk ? ' ✓' : ' — must be 100%'}
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
          {PAY_FIELDS.map(([k, label]) => (
            <div key={k}>
              <label className="label text-[10px]" title={k === 'tc' ? 'Testing & Commissioning' : undefined}>{label} %</label>
              <input className="input text-right py-1" type="number" min="0" step="1"
                value={payTerms[k]} onChange={e => setPayTerms(p => ({ ...p, [k]: e.target.value }))} />
            </div>
          ))}
        </div>
        {/* Cash-flow viability — Advance + Material vs material+accessory cost */}
        {cashRisk ? (
          <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 text-sm">
            <div className="font-semibold text-red-700">⚠ Check payment terms — this schedule can't fund the material.</div>
            <div className="text-red-600 text-[13px] mt-1 leading-relaxed">
              Advance + Material = <b>{fmt(earlyPct)}%</b> brings in only <b>₹{fmt(earlyInflow)}</b> before installation,
              but material + accessories (PP + ACC) cost <b>₹{fmt(ppAccCost)}</b>. You'd be short <b>₹{fmt(payShortfall)}</b> —
              you can't survive on these terms (you'd fund the purchase from your own pocket). Raise the Advance / Material %.
            </div>
          </div>
        ) : (Number(totals.sp) || 0) > 0 ? (
          <div className="mt-3 bg-emerald-50 border border-emerald-200 rounded-lg p-2.5 text-[13px] text-emerald-700">
            ✓ Advance + Material ({fmt(earlyPct)}% = ₹{fmt(earlyInflow)}) covers the material + accessories cost (₹{fmt(ppAccCost)}).
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => setRows(rs => [...rs, blankRow()])} className="btn btn-secondary text-sm flex items-center gap-1">
          <FiPlus size={14} /> Add Item
        </button>
        <button type="button" onClick={saveEstimate} className="btn btn-success text-sm flex items-center gap-1">
          <FiSave size={14} /> {currentId ? 'Update Saved' : 'Save Quotation'}
        </button>
        <button type="button" onClick={exportXlsx} className="btn btn-primary text-sm flex items-center gap-1">
          <FiDownload size={14} /> Export Quotation (Excel)
        </button>
        <div className="ml-auto text-sm text-gray-600">
          Cost <b>₹{fmt(totals.cost)}</b> &nbsp;·&nbsp; Margin <b className="text-emerald-700">₹{fmt(marginAmt)}</b> &nbsp;·&nbsp; Sale Price <b className="text-emerald-700 text-base">₹{fmt(totals.sp)}</b>
        </div>
      </div>

      <p className="text-xs text-gray-400">
        Formula: TPA = (PP + LAB) × Qty + ACC, where ACC = the total of this line's FOC / accessory items. SP = TPA × (1 + category margin%). Material (PP), labour (LAB) and FOC all pull from the 🔗 PO/FOC kit when the item has one.
      </p>
      </>)}
    </div>
  );
}
