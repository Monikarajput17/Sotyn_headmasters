import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { FiPlus, FiTrash2, FiEdit2, FiCheck, FiFileText } from 'react-icons/fi';

// PO/FOC Stripped (mam 2026-06-09) — workflow module.
// Three status tabs: Non-Approved → Approved → Re-Approved.
// Each entry = one PO item (type=PO) + up to 10 FOC items (type=FOC) +
// labour + margin.  TPA = (PO Rate×Qty + Σ FOC Rate×Qty + Labour) × (1 + margin%).

const MARGINS = [10, 20, 30, 40, 50, 75, 100];
const MAX_FOC = 10;
const PENDING_CAP = 50;
const DRAFT_CAP = 30;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

const TABS = [
  { key: 'non_approved', label: 'Non-Approved', active: 'bg-amber-500 text-white border-amber-500' },
  { key: 'approved', label: 'Approved', active: 'bg-emerald-600 text-white border-emerald-600' },
  { key: 're_approved', label: 'Re-Approved', active: 'bg-blue-600 text-white border-blue-600' },
];
const STATUS_BADGE = {
  non_approved: 'bg-amber-100 text-amber-700',
  approved: 'bg-emerald-100 text-emerald-700',
  re_approved: 'bg-blue-100 text-blue-700',
};
const blankForm = () => ({ id: null, status: 'non_approved', po_item_id: null, po_name: '', po_rate: 0, qty: 1, labour: 0, labour_item_id: null, labour_name: '', labour_margin: 50, margin: 30, focs: [], foc_pct: '' });
const blankFoc = (margin = 30) => ({ item_id: null, name: '', qty: 1, rate: 0, foc: false, margin });

const calc = (f) => {
  const poAmt = r2((Number(f.po_rate) || 0) * (Number(f.qty) || 0));
  // FOC can be entered as a % of PO (mam 2026-06-22) — either/or with the item
  // rows: a % > 0 means FOC = PO × % and the rows are ignored.
  const focPct = Number(f.foc_pct) || 0;
  // FOC rows flagged foc=true are FREE (not charged) — used for POC items where
  // a row can be PO (charged) or FOC (free). Default (foc falsy) = charged.
  const margin = Number(f.margin) || 0;
  const focAmt = focPct > 0
    ? r2(poAmt * focPct / 100)
    : r2((f.focs || []).reduce((t, x) => t + (x.foc ? 0 : (Number(x.rate) || 0) * (Number(x.qty) || 0)), 0));
  // Sale value of FOC: % mode rides the PO margin; item rows each carry their
  // OWN margin (mam 2026-06-23), null → inherit the PO margin.
  const focSale = focPct > 0
    ? r2(focAmt * (1 + margin / 100))
    : r2((f.focs || []).reduce((t, x) => {
        if (x.foc) return t;
        const amt = (Number(x.rate) || 0) * (Number(x.qty) || 0);
        const m = (x.margin === '' || x.margin == null) ? margin : Number(x.margin) || 0;
        return t + amt * (1 + m / 100);
      }, 0));
  const labourAmt = r2((Number(f.labour) || 0) * (Number(f.qty) || 0)); // labour RATE × PO qty
  const cost = r2(poAmt + focAmt + labourAmt);
  const lMargin = (f.labour_margin === '' || f.labour_margin == null) ? 50 : Number(f.labour_margin) || 0;
  // PO carries the item margin, each FOC its own, labour its own.
  const tpa = r2(poAmt * (1 + margin / 100) + focSale + labourAmt * (1 + lMargin / 100));
  return { cost, tpa };
};

export default function PoFocStripped() {
  const [tab, setTab] = useState('non_approved');
  const [entries, setEntries] = useState([]);
  const [counts, setCounts] = useState({ non_approved: 0, approved: 0, re_approved: 0 });
  const [entriesLoaded, setEntriesLoaded] = useState(false);
  const [poItems, setPoItems] = useState([]);
  const [focItems, setFocItems] = useState([]);
  const [labourItems, setLabourItems] = useState([]);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState(blankForm());
  const [pendSearch, setPendSearch] = useState('');
  const [draftSearch, setDraftSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');

  const load = useCallback(() => {
    api.get('/quotations/po-foc').then(r => { setEntries(r.data.rows || []); setCounts(r.data.counts || {}); setEntriesLoaded(true); }).catch(() => setEntriesLoaded(true));
  }, []);
  // Reload the masters so a rate/UOM edit in Item Master is reflected here
  // (mam 2026-06-11). Show item CODE + UOM in the dropdown label (mam 2026-06-10).
  const loadMasters = useCallback(() => {
    const withCode = x => ({ ...x, display_name: `${x.item_code ? '[' + x.item_code + '] ' : ''}${[x.item_name, x.specification, x.size].filter(Boolean).join(' / ')}${x.uom ? ' · ' + x.uom : ''}` });
    api.get('/item-master/dropdown?type=PO,POC').then(r => setPoItems((r.data || []).map(withCode))).catch(() => {});
    api.get('/item-master/dropdown?type=FOC').then(r => setFocItems((r.data || []).map(withCode))).catch(() => {});
    api.get('/quotations/labour-rates').then(r => setLabourItems((r.data || []).map(x => ({
      id: x.id, item_name: x.item_name, rate: x.rate, uom: x.uom,
      display_name: `${[x.item_name, x.specification, x.size].filter(Boolean).join(' / ')}${x.uom ? ' (' + x.uom + ')' : ''}`,
    })))).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadMasters(); }, [loadMasters]);
  // Returning to this tab (e.g. after editing the item in the Item Master tab)
  // re-pulls live rates/UOM so the cards and counts refresh without a reload.
  useEffect(() => {
    const onFocus = () => { load(); loadMasters(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load, loadMasters]);

  const openNew = () => { setForm(blankForm()); setModal(true); loadMasters(); };
  // Re-pull masters + the live entry so the modal shows the CURRENT Item Master
  // rate/UOM, not the value snapshotted when the kit was first saved.
  // A FOC % is stored as a single synthetic FOC line (is_pct); on load we lift
  // it back into the foc_pct field and hide the synthetic row.
  const fromStored = (data) => {
    const focs = (data.focs || []).map(f => ({ ...f }));
    const pctLine = focs.find(f => f.is_pct);
    return { ...data, foc_pct: pctLine ? pctLine.foc_pct : '', focs: pctLine ? [] : focs };
  };
  const openEdit = (e) => {
    setForm(fromStored(e));
    setModal(true);
    loadMasters();
    api.get(`/quotations/po-foc/${e.id}`).then(r => setForm(fromStored(r.data))).catch(() => {});
  };

  // form helpers
  const setF = (patch) => setForm(f => ({ ...f, ...patch }));
  const pickPo = (opt) => setF(opt ? { po_item_id: opt.id, po_name: opt.display_name || opt.item_name, po_rate: opt.current_price || 0 } : { po_item_id: null, po_name: '', po_rate: 0 });
  const pickLabour = (opt) => setF(opt ? { labour_item_id: opt.id, labour_name: opt.item_name, labour: opt.rate || 0 } : { labour_item_id: null, labour_name: '', labour: 0 });
  const addFoc = () => setForm(f => (f.focs || []).length >= MAX_FOC ? (toast.error(`Max ${MAX_FOC} FOC`), f) : { ...f, focs: [...(f.focs || []), blankFoc(Number(f.margin) || 30)] });
  const patchFoc = (fi, patch) => setForm(f => ({ ...f, focs: f.focs.map((x, j) => j === fi ? { ...x, ...patch } : x) }));
  const removeFoc = (fi) => setForm(f => ({ ...f, focs: f.focs.filter((_, j) => j !== fi) }));
  const pickFoc = (fi, opt) => patchFoc(fi, opt ? { item_id: opt.id, name: opt.display_name || opt.item_name, rate: opt.current_price || 0 } : { item_id: null, name: '', rate: 0 });

  const formCalc = useMemo(() => calc(form), [form]);
  // Type of the picked PO item — POC items let each FOC row be PO (charged) or
  // FOC (free) (mam 2026-06-22). Derived from the loaded master list.
  const poType = useMemo(() => (poItems.find(p => p.id === form.po_item_id)?.type) || 'PO', [poItems, form.po_item_id]);

  // Open the Item Master page (new tab) pre-searched to this item so you can
  // edit it; re-pick it here afterwards to pull the updated rate.
  const codeOf = (list, id) => (list.find(x => x.id === id) || {}).item_code || '';
  // Unit of the picked item, read live off the loaded master list (mam 2026-06-11:
  // "show the unit for PO item, FOC item, even labour item").
  const uomOf = (list, id) => (list.find(x => x.id === id) || {}).uom || '';
  const openItemEdit = (code, name) => window.open(code
    ? `/item-master?edit=${encodeURIComponent(code)}`
    : `/item-master?search=${encodeURIComponent(name || '')}`, '_blank', 'noopener');
  // Labour items live in the Labour Rate sheet (matched by name) — ✎ opens that
  // item's edit form, ➕ opens the sheet ready to add a new labour item.
  const openLabourEdit = (name) => window.open(`/labour-rate?edit=${encodeURIComponent(name || '')}`, '_blank', 'noopener');
  const openLabourAdd = () => window.open('/labour-rate?add=1', '_blank', 'noopener');

  const save = async (approveAfter) => {
    if (!form.po_name) { toast.error('Pick a PO item'); return; }
    try {
      // FOC % → store one effective FOC line (so every consumer that reads
      // `focs` keeps the right amount, no downstream change needed).
      const pct = Number(form.foc_pct) || 0;
      const poAmt = (Number(form.po_rate) || 0) * (Number(form.qty) || 0);
      const focsOut = pct > 0
        ? [{ name: `FOC ${pct}% of PO`, qty: 1, rate: r2(poAmt * pct / 100), is_pct: true, foc_pct: pct }]
        : form.focs;
      const payload = { po_item_id: form.po_item_id, po_name: form.po_name, po_rate: form.po_rate, qty: form.qty, labour: form.labour, labour_item_id: form.labour_item_id, labour_name: form.labour_name, labour_margin: form.labour_margin, margin: form.margin, focs: focsOut };
      let id = form.id;
      if (id) { await api.put(`/quotations/po-foc/${id}`, payload); }
      else { const r = await api.post('/quotations/po-foc', payload); id = r.data.id; }
      if (approveAfter && id) await api.post(`/quotations/po-foc/${id}/approve`);
      toast.success(approveAfter ? 'Approved' : 'Saved');
      setModal(false); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  // Approve in place — flip the one entry locally instead of re-downloading the
  // whole 800-kit list (mam 2026-06-11 "when i approve it takes lots of time").
  // A later load() (tab/window focus) reconciles if anything drifted.
  const approve = async (id) => {
    const cur = entries.find(e => e.id === id);
    try {
      await api.post(`/quotations/po-foc/${id}/approve`);
      toast.success('Approved');
      setEntries(es => es.map(e => e.id === id ? { ...e, status: 'approved' } : e));
      const from = cur?.status;
      if (from && from !== 'approved') setCounts(c => ({ ...c, [from]: Math.max(0, (c[from] || 0) - 1), approved: (c.approved || 0) + 1 }));
    } catch (e) { toast.error('Failed'); }
  };
  const del = async (id) => { if (!confirm('Delete this PO/FOC item?')) return; try { await api.delete(`/quotations/po-foc/${id}`); load(); } catch (e) { toast.error('Failed'); } };

  // "Auto-list PO items needing FOC" (mam 2026-06-10): Non-Approved lists PO
  // items that have no approved FOC kit yet — you open each and define it.
  // Saved drafts (non_approved entries) show as cards above the list.
  const approvedPoIds = useMemo(() => new Set(entries.filter(e => e.status === 'approved' || e.status === 're_approved').map(e => e.po_item_id)), [entries]);
  const draftPoIds = useMemo(() => new Set(entries.filter(e => e.status === 'non_approved').map(e => e.po_item_id)), [entries]);
  // Category filter = the PO item's Item Master department (mam 2026-06-11:
  // "filter category wise — pick Fire Fighting, show all fire fighting"). The
  // dropdown options come from whatever departments the PO items actually have.
  const categories = useMemo(() => [...new Set(poItems.map(p => p.department).filter(Boolean))].sort(), [poItems]);
  const poDeptById = useMemo(() => { const m = new Map(); poItems.forEach(p => m.set(p.id, p.department || '')); return m; }, [poItems]);
  const inCat = (dept) => !catFilter || dept === catFilter;
  const catOf = (e) => poDeptById.get(e.po_item_id) || '';
  const pendingItems = useMemo(() => {
    let list = poItems.filter(p => inCat(p.department || '') && !approvedPoIds.has(p.id) && !draftPoIds.has(p.id));
    const q = pendSearch.toLowerCase().trim();
    if (q) { const toks = q.split(/\s+/).filter(Boolean); list = list.filter(p => toks.every(t => (p.display_name || '').toLowerCase().includes(t))); }
    return list;
  }, [poItems, approvedPoIds, draftPoIds, pendSearch, catFilter]);
  // PO items still needing FOC (incl drafts), within the chosen category.
  const pendingTotal = useMemo(() => poItems.filter(p => inCat(p.department || '') && !approvedPoIds.has(p.id)).length, [poItems, approvedPoIds, catFilter]);
  const tabCount = (k) => {
    if (k === 'non_approved') return pendingTotal;
    if (!catFilter) return counts[k] || 0;
    return entries.filter(e => e.status === k && catOf(e) === catFilter).length;
  };
  const openForPoItem = (p) => { setForm({ ...blankForm(), po_item_id: p.id, po_name: p.display_name || p.item_name, po_rate: p.current_price || 0 }); setModal(true); };

  // Deep-link from the Estimator's "+ Create" / "✏ Edit price breakup":
  // ?poItem=<id> opens the PO/FOC modal for that item — its EXISTING kit (edit) if
  // there is one, else a fresh one prefilled for it (mam 2026-06-30). Waits for the
  // entries to load so an existing kit is never missed (which would create a dup).
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || !entriesLoaded) return;
    const pid = new URLSearchParams(window.location.search).get('poItem');
    if (!pid) return;
    const existing = entries.find(e => String(e.po_item_id) === String(pid));
    if (existing) { autoOpened.current = true; openEdit(existing); return; }
    const p = poItems.find(x => String(x.id) === String(pid));
    if (p) { autoOpened.current = true; openForPoItem(p); }
  }, [poItems, entries, entriesLoaded]);

  const shown = entries.filter(e => e.status === tab && (!catFilter || catOf(e) === catFilter));
  const dq = draftSearch.toLowerCase().trim();
  const dToks = dq.split(/\s+/).filter(Boolean);
  const shownFiltered = dq ? shown.filter(e => dToks.every(t => (e.po_name || '').toLowerCase().includes(t))) : shown;

  const entryCard = (e) => (
    <div key={e.id} className="card p-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-[220px]">
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${STATUS_BADGE[e.status]}`}>{e.status.replace('_', '-').toUpperCase()}</span>
            <span className="font-semibold text-gray-800">{e.po_name}</span>
          </div>
          <div className="text-xs text-gray-500 mt-1">
            Qty {e.qty} · PO ₹{fmt(e.po_rate)} · Margin {e.margin}% · FOC {(e.focs || []).length}
            {e.labour_name ? ` · Labour: ${e.labour_name} (₹${fmt(e.labour)}×${e.qty}, ${e.labour_margin}%)` : ''}
          </div>
          {(e.focs || []).length > 0 && (
            <div className="text-[11px] text-gray-400 mt-0.5 truncate">FOC: {(e.focs || []).map(f => `${f.name}×${f.qty}`).join(', ')}</div>
          )}
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase text-gray-400">TPA</div>
          <div className="text-lg font-bold text-emerald-700">₹{fmt(e.tpa)}</div>
          <div className="text-[10px] text-gray-400">cost ₹{fmt(e.cost)}</div>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2 pt-2 border-t border-gray-100 flex-wrap">
        {(e.status === 'approved' || e.status === 're_approved') && (
          <a href={`/po-foc/${e.id}/print`} target="_blank" rel="noreferrer" className="btn btn-secondary text-xs flex items-center gap-1"><FiFileText size={13} /> View PDF</a>
        )}
        <button onClick={() => openEdit(e)} className="btn btn-secondary text-xs flex items-center gap-1"><FiEdit2 size={13} /> Edit</button>
        {e.status !== 'approved' && (
          <button onClick={() => approve(e.id)} className="btn btn-success text-xs flex items-center gap-1"><FiCheck size={13} /> {e.status === 're_approved' ? 'Re-approve' : 'Approve'}</button>
        )}
        <button onClick={() => del(e.id)} className="text-red-400 hover:text-red-600 ml-auto"><FiTrash2 size={15} /></button>
      </div>
    </div>
  );

  return (
    <div className="space-y-4 pb-24">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">📦 Price Breakup Master</h1>
          <p className="text-sm text-gray-500">Build a PO item with its FOC items, labour and margin, then approve it. Approved items print as a PDF.</p>
        </div>
        <button onClick={openNew} className="btn btn-primary flex items-center gap-1"><FiPlus size={15} /> New PO/FOC</button>
      </div>

      {/* Status pill tabs */}
      <div className="flex gap-2 flex-wrap">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-full text-sm font-semibold border transition ${tab === t.key
              ? t.active
              : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
            {t.label} <span className={`ml-1 ${tab === t.key ? 'opacity-90' : 'text-gray-400'}`}>({tabCount(t.key)})</span>
          </button>
        ))}
      </div>

      {/* Category (department) filter — applies to every tab */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Category</span>
        <select className="select max-w-xs" value={catFilter} onChange={e => setCatFilter(e.target.value)}>
          <option value="">All categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        {catFilter && <button onClick={() => setCatFilter('')} className="text-xs text-indigo-600 hover:text-indigo-800">✕ Clear</button>}
      </div>

      {/* Body */}
      {tab === 'non_approved' ? (
        <>
          {/* Drafts (imported / started) — searchable + capped for perf */}
          {shown.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Pending kits ({shown.length})</div>
                <input className="input max-w-xs" placeholder="Search pending kits…" value={draftSearch} onChange={e => setDraftSearch(e.target.value)} />
              </div>
              {shownFiltered.slice(0, DRAFT_CAP).map(e => entryCard(e))}
              {shownFiltered.length > DRAFT_CAP && (
                <div className="text-xs text-gray-400 text-center">Showing {DRAFT_CAP} of {shownFiltered.length} — type to narrow.</div>
              )}
              {shownFiltered.length === 0 && <div className="text-xs text-gray-400 text-center py-2">No pending kit matches “{draftSearch}”.</div>}
            </div>
          )}
          {/* PO items that still need a FOC kit */}
          <div className="card p-3">
            <div className="text-sm font-semibold text-gray-700 mb-2">PO items needing FOC <span className="text-gray-400">({pendingTotal})</span></div>
            <input className="input mb-2" placeholder="Search a PO item to define its FOC…" value={pendSearch} onChange={e => setPendSearch(e.target.value)} />
            <div className="divide-y divide-gray-100">
              {pendingItems.slice(0, PENDING_CAP).map(p => (
                <div key={p.id} className="flex items-center justify-between gap-2 py-1.5">
                  <span className="text-sm text-gray-700 truncate" title={p.display_name}>{p.display_name}</span>
                  <button onClick={() => openForPoItem(p)} className="btn btn-secondary text-xs whitespace-nowrap flex items-center gap-1"><FiPlus size={12} /> Define FOC</button>
                </div>
              ))}
              {pendingItems.length === 0 && (
                <div className="py-5 text-center text-sm text-gray-400">{pendSearch ? 'No matching PO items.' : 'All PO items have a FOC kit. 🎉'}</div>
              )}
            </div>
            {pendingItems.length > PENDING_CAP && (
              <div className="text-xs text-gray-400 text-center pt-2">Showing {PENDING_CAP} of {pendingItems.length} — type to narrow.</div>
            )}
          </div>
        </>
      ) : (
        <>
          {shown.length === 0 && (
            <div className="card p-8 text-center text-gray-400 text-sm">
              {tab === 'approved' ? 'No approved items yet.' : 'No re-approved (changed) items.'}
            </div>
          )}
          <div className="space-y-3">{shown.map(e => entryCard(e))}</div>
        </>
      )}

      {/* Edit / New modal */}
      <Modal isOpen={modal} onClose={() => setModal(false)} title={form.id ? 'Edit PO/FOC item' : 'New PO/FOC item'} wide>
        <div className="space-y-3">
          <div>
            <label className="label">PO Item (type to search)</label>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0"><SearchableSelect options={poItems} value={form.po_item_id} valueKey="id" displayKey="display_name" placeholder="Search PO items…" onChange={pickPo} /></div>
              {form.po_item_id && (
                <button type="button" title="Edit this item in Item Master (new tab)"
                  onClick={() => openItemEdit(codeOf(poItems, form.po_item_id), form.po_name)}
                  className="text-indigo-500 hover:text-indigo-700 shrink-0"><FiEdit2 size={16} /></button>
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div><label className="label">Qty{uomOf(poItems, form.po_item_id) && <span className="text-indigo-500 font-semibold"> · {uomOf(poItems, form.po_item_id)}</span>}</label><input className="input text-right" type="number" min="1" value={form.qty || ''} onChange={e => setF({ qty: e.target.value })} /></div>
            <div><label className="label">PO Rate ₹{uomOf(poItems, form.po_item_id) && <span className="text-indigo-500 font-semibold"> / {uomOf(poItems, form.po_item_id)}</span>}</label><input className="input text-right" type="number" min="0" value={form.po_rate || ''} onChange={e => setF({ po_rate: e.target.value })} /></div>
            <div><label className="label" title="Margin on PO + FOC">Margin %</label><select className="select" value={form.margin} onChange={e => setF({ margin: +e.target.value })}>{MARGINS.map(m => <option key={m} value={m}>{m}%</option>)}</select></div>
          </div>

          {/* Labour from the Labour Rate sheet — item + rate + margin (like FOC) */}
          <div className="bg-amber-50/50 border border-amber-100 rounded-lg p-3">
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
              <div className="sm:col-span-6">
                <label className="label">Labour Item (from Labour Rate sheet)</label>
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0"><SearchableSelect options={labourItems} value={form.labour_item_id} valueKey="id" displayKey="display_name" placeholder="Search labour item…" onChange={pickLabour} /></div>
                  {form.labour_item_id && (
                    <button type="button" title="Edit this labour item in the Labour Rate sheet (new tab)"
                      onClick={() => openLabourEdit(form.labour_name)}
                      className="text-indigo-500 hover:text-indigo-700 shrink-0"><FiEdit2 size={16} /></button>
                  )}
                  <button type="button" title="Add a new labour item to the Labour Rate sheet (new tab)"
                    onClick={openLabourAdd}
                    className="text-indigo-500 hover:text-indigo-700 shrink-0"><FiPlus size={16} /></button>
                </div>
              </div>
              <div className="sm:col-span-3">
                <label className="label">Labour Rate ₹{uomOf(labourItems, form.labour_item_id) && <span className="text-amber-600 font-semibold"> / {uomOf(labourItems, form.labour_item_id)}</span>}</label>
                <input className="input text-right" type="number" min="0" value={form.labour || ''} onChange={e => setF({ labour: e.target.value })} placeholder="0" />
              </div>
              <div className="sm:col-span-3">
                <label className="label" title="Labour has its own margin (default 50%)">Labour Margin %</label>
                <select className="select" value={form.labour_margin} onChange={e => setF({ labour_margin: +e.target.value })}>{MARGINS.map(m => <option key={m} value={m}>{m}%</option>)}</select>
              </div>
            </div>
            {form.labour_name && <div className="text-[10px] text-gray-500 mt-1">₹{fmt(form.labour)} × qty {form.qty} = ₹{fmt((Number(form.labour) || 0) * (Number(form.qty) || 0))} labour amount</div>}
          </div>

          <div className="bg-gray-50 rounded-lg p-3 border border-gray-100">
            <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
              <span className="text-xs font-semibold text-gray-600">FOC Items <span className="text-gray-400">({(form.focs || []).length}/{MAX_FOC})</span></span>
              <div className="flex items-center gap-2">
                {/* Either/or: enter FOC % of PO instead of item rows (mam 2026-06-22) */}
                <label className="text-[11px] text-gray-500">or FOC % of PO</label>
                <input className="input w-16 text-right py-1 text-xs" type="number" min="0" step="1" value={form.foc_pct}
                  onChange={e => setForm(f => ({ ...f, foc_pct: e.target.value }))} placeholder="0" />
                <button type="button" disabled={(form.focs || []).length >= MAX_FOC || Number(form.foc_pct) > 0} onClick={addFoc}
                  className={`text-xs flex items-center gap-1 px-2 py-1 rounded ${((form.focs || []).length >= MAX_FOC || Number(form.foc_pct) > 0) ? 'text-gray-300' : 'text-indigo-600 hover:bg-indigo-100'}`}><FiPlus size={13} /> Add FOC</button>
              </div>
            </div>
            {Number(form.foc_pct) > 0 ? (
              <div className="text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-100 rounded px-2 py-1.5">
                FOC = PO × {form.foc_pct}% = <b>₹{fmt(r2((Number(form.po_rate) || 0) * (Number(form.qty) || 0) * (Number(form.foc_pct) || 0) / 100))}</b>
                <span className="text-gray-400"> — FOC item rows are ignored while a % is set. Clear the % to use item rows.</span>
              </div>
            ) : (<>
            {(form.focs || []).length === 0 && <div className="text-[11px] text-gray-400 italic">No FOC items. Add up to {MAX_FOC}, or enter a FOC % above.</div>}
            <div className="space-y-2">
              {(form.focs || []).map((f, fi) => (
                <div key={fi} className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-400 w-4">{fi + 1}</span>
                  <div className="flex-1 min-w-0"><SearchableSelect options={focItems} value={f.item_id} valueKey="id" displayKey="display_name" placeholder="Search FOC item…" onChange={opt => pickFoc(fi, opt)} /></div>
                  {f.item_id && <button type="button" title="Edit this item in Item Master (new tab)" onClick={() => openItemEdit(codeOf(focItems, f.item_id), f.name)} className="text-indigo-400 hover:text-indigo-600 shrink-0"><FiEdit2 size={13} /></button>}
                  <select className="select text-xs py-1.5 w-14" value={f.qty} onChange={e => patchFoc(fi, { qty: +e.target.value })}>{Array.from({ length: 10 }, (_, n) => <option key={n + 1} value={n + 1}>{n + 1}</option>)}</select>
                  <span className="text-[10px] text-indigo-500 font-semibold w-10 text-center truncate" title={uomOf(focItems, f.item_id)}>{uomOf(focItems, f.item_id) || '—'}</span>
                  <input className="input text-right text-xs py-1.5 w-20" type="number" min="0" value={f.rate || ''} onChange={e => patchFoc(fi, { rate: e.target.value })} placeholder="rate" />
                  {/* Per-FOC margin — compulsory when picking FOC item-wise
                      (mam 2026-06-23). Defaults to the PO margin; greyed out
                      for free (FOC) rows since they add nothing. */}
                  <select className="select text-xs py-1.5 w-16 shrink-0" disabled={f.foc}
                    value={(f.margin === '' || f.margin == null) ? (Number(form.margin) || 30) : f.margin}
                    onChange={e => patchFoc(fi, { margin: +e.target.value })}
                    title="Margin % for this FOC item">
                    {MARGINS.map(m => <option key={m} value={m}>{m}%</option>)}
                  </select>
                  {/* POC items: each row is PO (charged) or FOC (free) — toggle (mam 2026-06-22) */}
                  {poType === 'POC' && (
                    <button type="button" onClick={() => patchFoc(fi, { foc: !f.foc })}
                      title={f.foc ? 'FOC (free) — click to charge as PO' : 'PO (charged) — click to make FOC'}
                      className={`text-[10px] font-bold px-1.5 py-1 rounded shrink-0 ${f.foc ? 'bg-emerald-100 text-emerald-700' : 'bg-indigo-100 text-indigo-700'}`}>
                      {f.foc ? 'FOC' : 'PO'}
                    </button>
                  )}
                  <button type="button" className="text-red-300 hover:text-red-500" onClick={() => removeFoc(fi)}><FiTrash2 size={13} /></button>
                </div>
              ))}
            </div>
            </>)}
          </div>

          <div className="flex items-center justify-between bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
            <span className="text-xs text-gray-500">Cost ₹{fmt(formCalc.cost)}</span>
            <span className="text-sm font-bold text-emerald-700">TPA ₹{fmt(formCalc.tpa)}</span>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button onClick={() => save(false)} className="btn btn-primary">Save (keep pending)</button>
            <button onClick={() => save(true)} className="btn btn-success flex items-center gap-1"><FiCheck size={14} /> Approve</button>
          </div>
        </div>
      </Modal>

      <p className="text-xs text-gray-400">TPA = (PO Rate × Qty) × (1 + Margin%) + Σ (FOC Rate × FOC Qty × (1 + that FOC's Margin%)) + (Labour Rate × Qty) × (1 + Labour Margin%). Each FOC item now carries its own margin (defaults to the PO margin). Labour carries its own margin (default 50%). Editing an Approved item moves it to Re-Approved until you approve it again.</p>
    </div>
  );
}
