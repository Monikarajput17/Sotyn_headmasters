// Inventory Management — Phase 1
//
// Tabs:
//   Stock      : current quantity per item per warehouse, with search
//   Receive    : record a stock IN (vendor delivery / opening balance / adjust)
//   Issue      : record a stock OUT — to a site (consumption) OR to another warehouse (transfer)
//   Movements  : full append-only journal with filters
//   Warehouses : manage office store + per-site stores

import { useState, useEffect, useMemo } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import { useAuth } from '../context/AuthContext';
import { FiPackage, FiPlus, FiTrash2, FiSearch, FiArrowDown, FiArrowUp, FiRefreshCw, FiEdit2, FiAlertTriangle, FiHome, FiMapPin, FiBarChart2, FiCheck, FiCamera, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import BarcodeScanner from '../components/BarcodeScanner';
import { fmtDateTime } from '../utils/datetime';

const fmtNum = (n) => (n == null ? '0' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }));
const fmtMoney = (n) => '₹ ' + fmtNum(n);

export default function Inventory() {
  const { canCreate, canEdit, canDelete, isAdmin } = useAuth();
  const [tab, setTab] = useUrlTab('stock');
  const [warehouses, setWarehouses] = useState([]);
  const [sites, setSites] = useState([]);
  const [items, setItems] = useState([]);          // item_master dropdown source
  const [stock, setStock] = useState([]);
  const [summary, setSummary] = useState([]);
  const [movements, setMovements] = useState([]);

  // Filters
  const [stockFilter, setStockFilter] = useState({ warehouse_id: '', search: '', low_only: false });
  const [mvmtFilter, setMvmtFilter] = useState({ warehouse_id: '', type: '', date_from: '', date_to: '' });

  const loadCommon = async () => {
    try {
      const [w, s, im] = await Promise.all([
        api.get('/inventory/warehouses'),
        api.get('/dpr/sites?all=1').catch(() => ({ data: [] })),
        api.get('/item-master/dropdown').catch(() => ({ data: [] })),
      ]);
      setWarehouses(w.data || []);
      setSites(s.data || []);
      // Build a richer label so the search matches by name, code, spec
      // AND department all at once. SearchableSelect does substring match
      // on the label, so packing more text into it = better discoverability
      // when mam searches "cement" / "civil" / "300NB" / etc.
      setItems((im.data || []).map(i => ({
        ...i,
        label: [i.item_code, i.item_name, i.specification, i.size, i.department && '·' + i.department]
          .filter(Boolean).join(' '),
      })));
    } catch (err) { /* keep silent */ }
  };

  const loadSummary = async () => {
    try { const r = await api.get('/inventory/summary'); setSummary(r.data || []); } catch {}
  };

  const loadStock = async () => {
    try {
      const params = new URLSearchParams();
      if (stockFilter.warehouse_id) params.set('warehouse_id', stockFilter.warehouse_id);
      if (stockFilter.search) params.set('search', stockFilter.search);
      if (stockFilter.low_only) params.set('low_only', '1');
      const r = await api.get('/inventory/stock?' + params.toString());
      setStock(r.data || []);
    } catch (err) { toast.error('Failed to load stock'); }
  };

  const loadMovements = async () => {
    try {
      const params = new URLSearchParams();
      Object.entries(mvmtFilter).forEach(([k, v]) => { if (v) params.set(k, v); });
      const r = await api.get('/inventory/movements?' + params.toString());
      setMovements(r.data || []);
    } catch (err) { toast.error('Failed to load movements'); }
  };

  useEffect(() => { loadCommon(); loadSummary(); }, []);
  useEffect(() => { if (tab === 'stock') loadStock(); /* eslint-disable-next-line */ }, [tab, stockFilter]);
  useEffect(() => { if (tab === 'movements') loadMovements(); /* eslint-disable-next-line */ }, [tab, mvmtFilter]);

  // Aggregate for header cards
  const totals = useMemo(() => {
    const valueByWh = summary.reduce((s, w) => s + (+w.total_value || 0), 0);
    const lowCount = summary.reduce((s, w) => s + (+w.low_stock_items || 0), 0);
    const distinctItems = summary.reduce((s, w) => s + (+w.items_in_stock || 0), 0);
    return { valueByWh, lowCount, distinctItems };
  }, [summary]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-3">
        <div>
          <h3 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <FiPackage className="text-red-600" /> Inventory
          </h3>
          <p className="text-sm text-gray-500">
            Stock per warehouse · receive material in · issue to site or transfer between stores · full movement history.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => {
            // Export the currently-loaded stock rows. (Earlier this referenced
            // `flatStock`, which only exists inside StockTab — so the click
            // threw and nothing downloaded. Use the parent's own `stock`, with
            // the real field names: quantity / effective_rate / value.)
            if (!stock.length) { toast.error('No stock to export — open the Stock tab / pick a warehouse first'); return; }
            exportCsv('inventory-stock',
              ['Code','Site','Item','Size','Spec','Make','Type','UoM','Qty','Condition','Rate','Value','Reorder Level'],
              stock.map(s => {
                const rate = (+s.effective_rate > 0) ? +s.effective_rate : ((+s.avg_rate > 0) ? +s.avg_rate : (+s.master_price || 0));
                const value = (+s.value > 0) ? +s.value : rate * (+s.quantity || 0);
                return [s.item_code, s.warehouse_name, s.item_name, s.size, s.specification, s.make, s.item_type, s.uom, s.quantity, s.latest_condition, rate, value, s.reorder_level];
              }));
          }}
            className="btn btn-secondary flex items-center gap-2"><FiDownload size={14} /> Export Excel</button>
          <button onClick={() => { loadSummary(); if (tab === 'stock') loadStock(); if (tab === 'movements') loadMovements(); }}
            className="btn btn-secondary flex items-center gap-2"><FiRefreshCw size={14} /> Refresh</button>
        </div>
      </div>

      {/* Top summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="card p-4 border-l-4 border-red-500">
          <div className="text-[10px] uppercase text-gray-500 font-semibold">Warehouses</div>
          <div className="text-2xl font-bold mt-1">{warehouses.filter(w => w.active).length}</div>
          <div className="text-[10px] text-gray-400">{warehouses.filter(w => w.type === 'office').length} office · {warehouses.filter(w => w.type === 'site_store').length} site</div>
        </div>
        <div className="card p-4 border-l-4 border-emerald-500">
          <div className="text-[10px] uppercase text-gray-500 font-semibold">Distinct Items in Stock</div>
          <div className="text-2xl font-bold mt-1">{fmtNum(totals.distinctItems)}</div>
          <div className="text-[10px] text-gray-400">across all warehouses</div>
        </div>
        <div className="card p-4 border-l-4 border-blue-500">
          <div className="text-[10px] uppercase text-gray-500 font-semibold">Total Stock Value</div>
          <div className="text-2xl font-bold mt-1">{fmtMoney(totals.valueByWh)}</div>
          <div className="text-[10px] text-gray-400">moving avg basis</div>
        </div>
        <div className="card p-4 border-l-4 border-amber-500">
          <div className="text-[10px] uppercase text-gray-500 font-semibold">Below Reorder Level</div>
          <div className="text-2xl font-bold mt-1 text-amber-700">{fmtNum(totals.lowCount)}</div>
          <div className="text-[10px] text-gray-400">items need restocking</div>
        </div>
      </div>

      {/* Opening date is now set PER SITE inside the Opening Stock tab
          (mam 2026-06-25), not as one global date here. */}

      {/* Tabs */}
      <div className="flex gap-2 flex-wrap">
        {[
          ['stock', 'Stock'],
          ['opening', 'Opening Stock (item-wise)', canCreate('inventory')],
          ['receive', 'Receive (IN)', canCreate('inventory')],
          ['issue', 'Issue / Transfer (OUT)', canCreate('inventory')],
          ['movements', 'Movements'],
          ['reports', 'Reports & Valuation'],
          ['warehouses', 'Warehouses'],
        ].filter(([, , cond]) => cond === undefined || cond).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`px-4 py-2 rounded-lg text-sm font-medium border ${tab === id ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'stock' && <StockTab stock={stock} warehouses={warehouses} filter={stockFilter} setFilter={setStockFilter} reload={() => { loadStock(); loadSummary(); }} canEdit={canEdit('inventory') || isAdmin()} canDelete={canDelete('inventory') || isAdmin()} />}
      {tab === 'opening' && <OpeningStockTab warehouses={warehouses} items={items} reload={() => { loadStock(); loadSummary(); }} />}
      {tab === 'receive' && <ReceiveTab warehouses={warehouses} items={items} reload={() => { loadStock(); loadSummary(); }} />}
      {tab === 'issue' && <IssueTab warehouses={warehouses} sites={sites} items={items} reload={() => { loadStock(); loadSummary(); }} />}
      {tab === 'movements' && <MovementsTab movements={movements} warehouses={warehouses} filter={mvmtFilter} setFilter={setMvmtFilter} />}
      {tab === 'reports' && <ReportsTab summary={summary} warehouses={warehouses} />}
      {tab === 'warehouses' && <WarehousesTab warehouses={warehouses} sites={sites} reload={loadCommon} canEdit={canEdit('inventory') || isAdmin()} canCreate={canCreate('inventory') || isAdmin()} />}
    </div>
  );
}

// ---------- STOCK TAB ----------
function StockTab({ stock, warehouses, filter, setFilter, reload, canEdit, canDelete }) {
  // Inline edit: click a "Reorder" cell to set the threshold per (item × warehouse).
  // Saves on blur / Enter; Esc cancels. Optimistic UI with rollback on error.
  const [editing, setEditing] = useState(null); // { warehouse_id, item_master_id, value }
  // Same inline-edit pattern but for the Item Master current_price — lets
  // mam fix missing master prices straight from the Stock view.
  const [pricing, setPricing] = useState(null); // { item_master_id, value }
  // Modal state for full-row qty/rate edit (separate from inline reorder edit).
  const [editRow, setEditRow] = useState(null); // { id, item_name, quantity, avg_rate, notes }
  const [savingRow, setSavingRow] = useState(false);
  // Type filter (PO / FOC / RGP) — mam (2026-06-04): "if i filter rgp show
  // all tools". Purely client-side so it's instant and needs no refetch.
  const [typeFilter, setTypeFilter] = useState('');

  // Item-type badge styling (PO / FOC / RGP), shared by the table + cards.
  const typeBadgeClass = (t) => {
    const T = String(t || '').toUpperCase();
    return T === 'FOC' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : T === 'RGP' ? 'bg-amber-50 text-amber-700 border-amber-200'
      : T === 'PO'  ? 'bg-blue-50 text-blue-700 border-blue-200'
      : 'bg-gray-50 text-gray-400 border-gray-200';
  };

  const saveEditRow = async () => {
    if (!editRow) return;
    const q = +editRow.quantity;
    const r = +editRow.avg_rate;
    if (!(q >= 0)) return toast.error('Quantity must be 0 or more');
    if (!(r >= 0)) return toast.error('Rate must be 0 or more');
    setSavingRow(true);
    try {
      await api.patch(`/inventory/stock/${editRow.id}`, {
        quantity: q, avg_rate: r, notes: editRow.notes || null,
      });
      // Item name / spec / make edit (mam 2026-06-30: "edit item name also") —
      // updates the shared item_master via a safe partial PATCH.
      if (editRow.item_master_id && String(editRow.item_name || '').trim()) {
        await api.patch(`/item-master/${editRow.item_master_id}/identity`, {
          item_name: String(editRow.item_name).trim(),
          specification: editRow.specification || '',
          make: editRow.make || '',
        });
      }
      toast.success('Stock updated');
      setEditRow(null);
      reload();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update');
    } finally {
      setSavingRow(false);
    }
  };

  const deleteRow = async (row) => {
    if (!window.confirm(`Delete ${row.item_name} from ${row.warehouse_name}?\nQty ${row.quantity} ${row.uom || ''} will be removed and an audit-trail OUT entry recorded.`)) return;
    try {
      await api.delete(`/inventory/stock/${row.id}`);
      toast.success('Stock row deleted');
      reload();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to delete');
    }
  };
  const savePrice = async () => {
    if (!pricing) return;
    const val = +pricing.value || 0;
    try {
      await api.patch(`/item-master/${pricing.item_master_id}/price`, { current_price: val });
      toast.success(`Master price set to Rs ${val}`);
      setPricing(null);
      reload();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  };
  const saveReorder = async () => {
    if (!editing) return;
    const val = +editing.value || 0;
    try {
      await api.put(`/inventory/reorder/${editing.warehouse_id}/${editing.item_master_id}`, { reorder_level: val });
      toast.success(`Reorder level set to ${val}`);
      setEditing(null);
      reload();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  };

  // Flat list — mam's spec is one row per (site, item) with Site Name as
  // its own column. The old per-warehouse cards hid the site name in a
  // header above the table; bringing it inline makes filtering + scanning
  // a 50-site deployment much easier.
  // Defensive client-side filter: even if the server response lags behind
  // the dropdown change (network glitch, caching, race condition), rows
  // shown will ALWAYS match the currently-selected warehouse. Without this
  // mam was seeing CHOUDHERY rows under a CONSERN PHARMA filter when the
  // stock state was momentarily stale between fetches.
  const flatStock = useMemo(() => {
    let rows = stock;
    if (filter.warehouse_id) {
      const wid = +filter.warehouse_id;
      rows = rows.filter(r => +r.warehouse_id === wid);
    }
    if (typeFilter) {
      rows = rows.filter(r => String(r.item_type || '').toUpperCase() === typeFilter);
    }
    return rows;
  }, [stock, filter.warehouse_id, typeFilter]);

  // Total value across whatever's currently filtered. Used in the
  // summary banner — especially useful when mam picks a single site
  // and wants the bottom-line value of THAT site's stock.
  const totalValue = useMemo(() => {
    return flatStock.reduce((sum, r) => {
      const eff = (+r.avg_rate > 0) ? +r.avg_rate : (+r.master_price || 0);
      return sum + (eff * (+r.quantity || 0));
    }, 0);
  }, [flatStock]);

  // When user has filtered to one warehouse, show its name in the summary
  // banner; otherwise list the distinct sites count. Prefer the warehouse
  // name found on the row data itself (guaranteed in sync with the DB) over
  // the stale `warehouses` prop, so the banner and the rows can never show
  // contradictory site names.
  const filterSummary = useMemo(() => {
    if (flatStock.length === 0) return null;
    const sites = new Set(flatStock.map(r => r.warehouse_name));
    if (filter.warehouse_id) {
      const fromRows = flatStock[0]?.warehouse_name;
      const fromList = warehouses.find(w => w.id === +filter.warehouse_id)?.name;
      return { label: fromRows || fromList || 'Selected site', single: true };
    }
    return { label: `${sites.size} site${sites.size === 1 ? '' : 's'}`, single: false };
  }, [flatStock, filter.warehouse_id, warehouses]);

  return (
    <>
      <div className="card p-4 grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
        <div>
          <label className="label">Warehouse</label>
          <select className="select" value={filter.warehouse_id} onChange={e => setFilter(f => ({ ...f, warehouse_id: e.target.value }))}>
            <option value="">All warehouses</option>
            {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}{w.type === 'office' ? ' ★' : ''}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Type</label>
          <select className="select" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">All types</option>
            <option value="PO">PO</option>
            <option value="FOC">FOC</option>
            <option value="RGP">RGP (tools)</option>
          </select>
        </div>
        <div>
          <label className="label">Search Item</label>
          <div className="relative">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
            <input className="input pl-9" placeholder="name / code / spec" value={filter.search} onChange={e => setFilter(f => ({ ...f, search: e.target.value }))} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-amber-700">
          <input type="checkbox" className="w-4 h-4 rounded" checked={filter.low_only} onChange={e => setFilter(f => ({ ...f, low_only: e.target.checked }))} />
          Show only items below reorder level
        </label>
      </div>

      {flatStock.length === 0 && (
        <div className="card p-6 text-center text-gray-400 text-sm">
          No stock yet. Use the <span className="font-semibold">Receive</span> tab to record an opening balance or first delivery.
        </div>
      )}

      {/* SUMMARY BANNER — total value of currently-filtered stock.
          When mam picks a single site, this becomes "Stock value at <site>".
          Otherwise it shows total across all sites in view. */}
      {filterSummary && (
        <div className="card p-3 bg-gradient-to-r from-blue-50 to-blue-100 border-l-4 border-blue-500 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm text-gray-700">
            {filterSummary.single ? (
              <>Stock value at <span className="font-semibold text-blue-800">{filterSummary.label}</span></>
            ) : (
              <>Total stock value across <span className="font-semibold text-blue-800">{filterSummary.label}</span></>
            )}
            <span className="text-gray-400 mx-1">·</span>
            <span className="text-gray-500">{flatStock.length} row{flatStock.length === 1 ? '' : 's'}</span>
          </div>
          <div className="text-xl font-bold text-blue-900 tabular-nums">{fmtMoney(totalValue)}</div>
        </div>
      )}

      {/* FLAT TABLE — mam's column order: Code · Site · Item · UOM · Qty ·
          Condition · Rate · Value · Reorder · Actions. Site name lives
          inline (not as a section header) so filtering + scanning is
          easier across many sites. */}
      {/* ─── MOBILE CARDS (mam 2026-06-02) ───────────────────────────
          Read-only summary per stock row; condition is editable
          (matches the inline-edit dropdown in the desktop table).
          Rate + Reorder edits stay desktop-only — the input
          interactions are too cramped on a phone. */}
      {flatStock.length > 0 && (
        <div className="md:hidden space-y-2">
          {flatStock.map(r => {
            const low = r.reorder_level > 0 && r.quantity <= r.reorder_level;
            const cond = r.latest_condition || '';
            const condClass = cond === 'Unused' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : cond === 'Used' ? 'bg-amber-50 text-amber-700 border-amber-200'
              : cond === 'Scrap' ? 'bg-red-50 text-red-700 border-red-200'
              : 'bg-gray-50 text-gray-400 border-gray-200';
            const eff = +r.effective_rate || 0;
            const value = +r.value || (eff * (+r.quantity || 0));
            return (
              <div key={r.id} className={`card p-3 space-y-2 ${low ? 'border-l-4 border-amber-500' : ''}`}>
                <div className="flex justify-between items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-gray-900 text-sm leading-snug">{r.item_name}</div>
                    {(r.size || r.specification || r.make) && (
                      <div className="text-[10px] text-gray-500 mt-0.5">
                        {r.size && <span>{r.size} · </span>}
                        {r.specification && <span>{r.specification} · </span>}
                        {r.make && <span>{r.make}</span>}
                      </div>
                    )}
                    <div className="text-[11px] text-gray-500 mt-1 flex items-center gap-1">
                      {r.warehouse_type === 'office' ? <FiHome size={10} /> : <FiMapPin size={10} />}
                      <span>{r.warehouse_name}</span>
                      {r.item_code && <span className="font-mono text-[10px] text-gray-400 ml-1">· {r.item_code}</span>}
                      {r.item_type && <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${typeBadgeClass(r.item_type)}`}>{r.item_type}</span>}
                    </div>
                  </div>
                  {canEdit ? (
                    <select value={cond} onChange={async (e) => {
                      const next = e.target.value;
                      try {
                        await api.patch(`/inventory/stock/${r.id}`, { condition: next });
                        toast.success(next ? `Marked ${next}` : 'Cleared');
                        reload();
                      } catch (err) { toast.error(err.response?.data?.error || 'Update failed'); }
                    }} className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border cursor-pointer outline-none ${cond ? condClass : 'bg-gray-50 text-gray-400 border-gray-200'}`}>
                      <option value="">—</option>
                      <option value="Unused">Unused</option>
                      <option value="Used">Used</option>
                      <option value="Scrap">Scrap</option>
                    </select>
                  ) : cond ? (
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${condClass}`}>{cond}</span>
                  ) : null}
                </div>
                <div className="grid grid-cols-3 gap-1 text-center pt-1 border-t border-gray-100">
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">Qty {r.uom ? `(${r.uom})` : ''}</div>
                    <div className={`text-sm font-bold tabular-nums ${low ? 'text-amber-700' : 'text-gray-800'}`}>
                      {fmtNum(r.quantity)} {low && <FiAlertTriangle className="inline ml-0.5 text-amber-500" size={11} />}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">Rate</div>
                    <div className="text-sm font-semibold text-gray-700">{fmtMoney(eff)}</div>
                    {r.rate_source === 'none' && <div className="text-[9px] text-amber-600 italic">unset</div>}
                  </div>
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">Value</div>
                    <div className="text-sm font-bold text-emerald-700">{fmtMoney(value)}</div>
                  </div>
                </div>
                {r.reorder_level > 0 && (
                  <div className="text-[10px] text-gray-500 text-center">
                    Reorder at <strong>{fmtNum(r.reorder_level)}</strong>
                    {low && <span className="text-amber-700 font-bold ml-1">· LOW STOCK</span>}
                  </div>
                )}
                {/* Edit / Delete — same actions as the desktop table (mam
                    2026-07-06: "i give him edit option but not showing on
                    mobile"). The Edit button opens the SAME modal, which handles
                    name/qty/rate/spec/make comfortably on a phone (unlike the
                    cramped inline rate/reorder cells, which stay desktop-only). */}
                {(canEdit || canDelete) && (
                  <div className="flex justify-end gap-1 pt-2 border-t border-gray-100">
                    {canEdit && (
                      <button type="button"
                        onClick={() => setEditRow({ id: r.id, item_master_id: r.item_master_id, item_name: r.item_name, specification: r.specification || '', make: r.make || '', warehouse_name: r.warehouse_name, uom: r.uom, quantity: r.quantity, avg_rate: r.avg_rate || r.effective_rate || 0, notes: '' })}
                        className="flex items-center gap-1 text-[11px] font-semibold text-blue-600 px-2.5 py-1 rounded hover:bg-blue-50">
                        <FiEdit2 size={13} /> Edit
                      </button>
                    )}
                    {canDelete && (
                      <button type="button" onClick={() => deleteRow(r)}
                        className="flex items-center gap-1 text-[11px] font-semibold text-red-600 px-2.5 py-1 rounded hover:bg-red-50">
                        <FiTrash2 size={13} /> Delete
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ─── DESKTOP TABLE (md+) ───────────────────────────────────── */}
      {flatStock.length > 0 && (
        <div className="hidden md:block card p-0">
          {/* No overflow-hidden on the card above — it would create an
              intervening scroll container that breaks the sticky
              `freeze-head` thead. mam (2026-06-04): "freeze like excel
              headers". Header sticks to the app's main scroll area. */}
          <div>
            <table className="text-sm w-full freeze-head">
              <thead className="bg-gray-50/60">
                <tr>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Code</th>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Site Name</th>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Item</th>
                  <th className="text-center px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Type</th>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">UOM</th>
                  <th className="text-right px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Quantity</th>
                  <th className="text-center px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Condition</th>
                  <th className="text-right px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Rate</th>
                  <th className="text-right px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Value</th>
                  <th className="text-right px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Reorder</th>
                  {(canEdit || canDelete) && <th className="text-right px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {flatStock.map(r => {
                  const low = r.reorder_level > 0 && r.quantity <= r.reorder_level;
                  const cond = r.latest_condition || '';
                  const condClass = cond === 'Unused' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : cond === 'Used' ? 'bg-amber-50 text-amber-700 border-amber-200'
                    : cond === 'Scrap' ? 'bg-red-50 text-red-700 border-red-200'
                    : 'bg-gray-50 text-gray-400 border-gray-200';
                  // effective_rate: server falls back to item_master.current_price
                  // when no movements have set an avg yet. rate_source = 'master'
                  // tells us to badge it so mam knows it's from the catalog.
                  const eff = +r.effective_rate || 0;
                  const value = +r.value || (eff * (+r.quantity || 0));
                  return (
                    <tr key={r.id} className={`border-t ${low ? 'bg-amber-50/40' : 'hover:bg-gray-50'}`}>
                      <td className="px-3 py-2 text-gray-500 font-mono text-[11px]">{r.item_code || '—'}</td>
                      <td className="px-3 py-2 text-gray-700 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          {r.warehouse_type === 'office' ? <FiHome size={11} className="text-red-500 flex-shrink-0" /> : <FiMapPin size={11} className="text-red-500 flex-shrink-0" />}
                          <span className="text-[12px]">{r.warehouse_name}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-gray-800">
                        {/* Full item details — name on top, then a labelled
                            secondary line showing Size / Spec / Make so mam
                            can identify which exact SKU this row is at a
                            glance, especially when many BALL VALVE / etc.
                            rows differ only by size or spec. */}
                        <div className="font-medium leading-snug">{r.item_name}</div>
                        {(r.size || r.specification || r.make) && (
                          <div className="text-[10px] text-gray-500 leading-snug mt-0.5 space-x-1.5">
                            {r.size && <span><span className="text-gray-400">Size:</span> <span className="font-medium text-gray-600">{r.size}</span></span>}
                            {r.specification && <span><span className="text-gray-400">Spec:</span> <span className="font-medium text-gray-600">{r.specification}</span></span>}
                            {r.make && <span><span className="text-gray-400">Make:</span> <span className="font-medium text-gray-600">{r.make}</span></span>}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {r.item_type ? (
                          <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${typeBadgeClass(r.item_type)}`}>{r.item_type}</span>
                        ) : (
                          <span className="text-[10px] text-gray-300 italic">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-600">{r.uom || '—'}</td>
                      <td className={`px-3 py-2 text-right font-bold tabular-nums ${low ? 'text-amber-700' : 'text-gray-800'}`}>
                        {fmtNum(r.quantity)} {low && <FiAlertTriangle className="inline ml-1 text-amber-500" size={12} />}
                      </td>
                      {/* Inline-edit Condition (mam 2026-05-29: 'unable
                          to edit used, unused'). Click cell to open a
                          small dropdown; changing the value PATCHes the
                          row immediately. canEdit gate falls back to
                          the read-only badge for non-editors. */}
                      <td className="px-3 py-2 text-center">
                        {canEdit ? (
                          <select
                            value={cond}
                            onChange={async (e) => {
                              const next = e.target.value;
                              try {
                                await api.patch(`/inventory/stock/${r.id}`, { condition: next });
                                toast.success(next ? `Marked ${next}` : 'Cleared');
                                reload();
                              } catch (err) {
                                toast.error(err.response?.data?.error || 'Update failed');
                              }
                            }}
                            className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border cursor-pointer outline-none ${cond ? condClass : 'bg-gray-50 text-gray-400 border-gray-200'}`}
                            title="Click to change condition"
                          >
                            <option value="">—</option>
                            <option value="Unused">Unused</option>
                            <option value="Used">Used</option>
                            <option value="Scrap">Scrap</option>
                          </select>
                        ) : cond ? (
                          <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${condClass}`}>{cond}</span>
                        ) : (
                          <span className="text-[10px] text-gray-300 italic">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-600 tabular-nums">
                        {pricing && pricing.item_master_id === r.item_master_id ? (
                          <input
                            type="number" step="any" min="0" autoFocus
                            className="input text-right text-xs py-1 w-24"
                            value={pricing.value}
                            onChange={e => setPricing({ ...pricing, value: e.target.value })}
                            onBlur={savePrice}
                            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); savePrice(); } if (e.key === 'Escape') setPricing(null); }}
                          />
                        ) : (
                          <button
                            type="button"
                            disabled={!canEdit}
                            onClick={() => canEdit && setPricing({ item_master_id: r.item_master_id, value: +r.master_price || '' })}
                            className={`text-right tabular-nums ${canEdit ? 'hover:text-red-600 cursor-pointer' : 'cursor-default'}`}
                            title={canEdit ? 'Click to set Item Master price' : ''}
                          >
                            {fmtMoney(eff)}
                            {r.rate_source === 'master' && eff > 0 && (
                              <div className="text-[9px] text-gray-400 italic">from master</div>
                            )}
                            {r.rate_source === 'none' && (
                              <div className="text-[9px] text-amber-600 italic">click to set</div>
                            )}
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-700 tabular-nums font-semibold">{fmtMoney(value)}</td>
                      <td className="px-3 py-2 text-right text-gray-500 tabular-nums">
                        {editing && editing.warehouse_id === r.warehouse_id && editing.item_master_id === r.item_master_id ? (
                          <input
                            type="number" step="any" min="0"
                            className="input text-right text-xs py-1 w-24"
                            value={editing.value}
                            onChange={e => setEditing({ ...editing, value: e.target.value })}
                            onBlur={saveReorder}
                            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); saveReorder(); } if (e.key === 'Escape') setEditing(null); }}
                            autoFocus
                          />
                        ) : (
                          <button
                            disabled={!canEdit}
                            onClick={() => canEdit && setEditing({ warehouse_id: r.warehouse_id, item_master_id: r.item_master_id, value: r.reorder_level || '' })}
                            className={`text-right ${canEdit ? 'hover:text-red-600 cursor-pointer' : 'cursor-default'}`}
                            title={canEdit ? 'Click to set reorder level' : ''}
                          >
                            {r.reorder_level > 0 ? fmtNum(r.reorder_level) : '—'}
                          </button>
                        )}
                      </td>
                      {(canEdit || canDelete) && (
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          {canEdit && (
                            <button
                              type="button"
                              onClick={() => setEditRow({ id: r.id, item_master_id: r.item_master_id, item_name: r.item_name, specification: r.specification || '', make: r.make || '', warehouse_name: r.warehouse_name, uom: r.uom, quantity: r.quantity, avg_rate: r.avg_rate || r.effective_rate || 0, notes: '' })}
                              className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded"
                              title="Edit item / qty / rate"
                            >
                              <FiEdit2 size={14} />
                            </button>
                          )}
                          {canDelete && (
                            <button
                              type="button"
                              onClick={() => deleteRow(r)}
                              className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded ml-1"
                              title="Delete stock row"
                            >
                              <FiTrash2 size={14} />
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Edit qty / rate modal — records an ADJUST IN or OUT movement
          for the qty delta so the journal stays consistent. */}
      {editRow && (
        <Modal isOpen={true} onClose={() => setEditRow(null)} title="Edit Stock Row" maxWidth="max-w-md">
          <div className="space-y-3 text-sm">
            {/* Item identity — editable (mam 2026-06-30: "edit item name also").
                Saving updates the shared Item Master, so it changes everywhere. */}
            <div>
              <label className="label">Item name</label>
              <input type="text" className="input" value={editRow.item_name || ''}
                onChange={e => setEditRow(r => ({ ...r, item_name: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Specification</label>
                <input type="text" className="input" value={editRow.specification || ''}
                  onChange={e => setEditRow(r => ({ ...r, specification: e.target.value }))} />
              </div>
              <div>
                <label className="label">Make</label>
                <input type="text" className="input" value={editRow.make || ''}
                  onChange={e => setEditRow(r => ({ ...r, make: e.target.value }))} />
              </div>
            </div>
            <div className="bg-gray-50 rounded px-2 py-1.5 text-[11px] text-gray-500">Warehouse: {editRow.warehouse_name} · editing the name changes this item everywhere it appears.</div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Quantity ({editRow.uom || 'PCS'})</label>
                <input type="number" step="any" min="0" className="input"
                  value={editRow.quantity}
                  onChange={e => setEditRow(r => ({ ...r, quantity: e.target.value }))}
                  autoFocus />
              </div>
              <div>
                <label className="label">Avg Rate (₹)</label>
                <input type="number" step="any" min="0" className="input"
                  value={editRow.avg_rate}
                  onChange={e => setEditRow(r => ({ ...r, avg_rate: e.target.value }))} />
              </div>
            </div>
            <div>
              <label className="label">Reason / Notes (optional)</label>
              <input type="text" className="input"
                placeholder="e.g. Physical count adjustment, damage, etc."
                value={editRow.notes}
                onChange={e => setEditRow(r => ({ ...r, notes: e.target.value }))} />
            </div>
            <div className="text-[11px] text-amber-700 bg-amber-50 border-l-2 border-amber-400 px-2 py-1.5 rounded">
              An ADJUST {(+editRow.quantity > +stock.find(s => s.id === editRow.id)?.quantity) ? 'IN' : 'OUT'} movement will be recorded for the qty difference, keeping the audit trail clean.
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setEditRow(null)} className="btn btn-secondary text-sm">Cancel</button>
              <button type="button" disabled={savingRow} onClick={saveEditRow} className="btn btn-primary text-sm flex items-center gap-2">
                <FiCheck size={14} /> {savingRow ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------- OPENING STOCK TAB ----------
// Two entry modes:
//   itemwise  : pick one item -> matrix of all warehouses (good when an
//               item exists at many sites)
//   rowwise   : free rows of (Site · Item · Qty · Photo) — good for
//               sparse data: only the specific entries you need.
//
// Both write to /api/inventory/receive with reference_type='OPENING'.
function OpeningStockTab({ warehouses, items, reload }) {
  const [mode, setMode] = useState('rowwise'); // default to the simpler form mam asked for
  return (
    <>
      <div className="flex gap-2 flex-wrap items-center text-sm">
        <span className="text-gray-500 text-xs">Entry mode:</span>
        {[
          ['rowwise',  'Row entry (Site · Item · Qty · Photo)'],
          ['itemwise', 'Item-wise matrix (one item × all warehouses)'],
        ].map(([id, label]) => (
          <button key={id} type="button" onClick={() => setMode(id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${mode === id ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}>
            {label}
          </button>
        ))}
      </div>
      {mode === 'rowwise'
        ? <OpeningRowEntry warehouses={warehouses} items={items} reload={reload} />
        : <OpeningItemwiseEntry warehouses={warehouses} items={items} reload={reload} />}
    </>
  );
}

// ---------- OPENING STOCK — ROW ENTRY ----------
// One site per session — mam's typical flow is "I'm at Site X, here are
// 50 items with their conditions". Site picker lives at the TOP, item rows
// share that site. Rate + Type are auto-pulled from Item Master (read-only)
// so the user can't accidentally enter a wrong rate. Condition (Used /
// Unused / Scrap) is a per-row dropdown — required because mam tracks
// brand-new stock vs already-used vs scrap on the same item line.
function OpeningRowEntry({ warehouses, items, reload }) {
  const CONDITIONS = ['Unused', 'Used', 'Scrap'];
  const newRow = () => ({ item_master_id: '', quantity: '', condition: '', photo_url: '', uploading: false });
  const [warehouseId, setWarehouseId] = useState(''); // shared across all rows in this session
  const [rows, setRows] = useState([newRow()]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  // Per-site opening date (mam 2026-06-25: "site wise date opening — from that
  // we go automatically"). When a warehouse is picked, load its opening date;
  // editing saves it on that warehouse. Each site has its own day-1 baseline.
  const [siteOpenDate, setSiteOpenDate] = useState('');
  const [savingOpenDate, setSavingOpenDate] = useState(false);
  useEffect(() => {
    if (!warehouseId) { setSiteOpenDate(''); return; }
    const w = warehouses.find(x => String(x.id) === String(warehouseId));
    setSiteOpenDate(w?.opening_date ? String(w.opening_date).slice(0, 10) : '');
  }, [warehouseId, warehouses]);
  const saveSiteOpenDate = async (d) => {
    if (!warehouseId) return;
    setSavingOpenDate(true);
    try {
      await api.post('/inventory/opening-date', { warehouse_id: warehouseId, opening_date: d || '' });
      setSiteOpenDate(d || '');
      toast.success(d ? `Opening date set for this site: ${d}` : 'Opening date cleared for this site');
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to save'); }
    finally { setSavingOpenDate(false); }
  };
  // Department pre-filter so mam can narrow the 3,100-item catalog
  // before searching. e.g. pick "CIVIL" -> dropdown only shows
  // Cement, Hume Pipe, masonry chamber, Excavation, ... etc.
  const [deptFilter, setDeptFilter] = useState('');
  const departments = useMemo(() => {
    const set = new Set();
    for (const i of items) if (i.department) set.add(i.department);
    return [...set].sort();
  }, [items]);
  const filteredItems = useMemo(() => {
    if (!deptFilter) return items;
    return items.filter(i => i.department === deptFilter);
  }, [items, deptFilter]);

  const addRow = () => setRows(r => [...r, newRow()]);
  const rmRow = (i) => setRows(r => r.length === 1 ? [newRow()] : r.filter((_, idx) => idx !== i));
  const setField = (i, k, v) => setRows(r => r.map((x, idx) => idx === i ? { ...x, [k]: v } : x));

  const uploadPhoto = async (i, file) => {
    if (!file) return;
    setField(i, 'uploading', true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setField(i, 'photo_url', r.data.url);
      setField(i, 'uploading', false);
    } catch {
      toast.error('Photo upload failed');
      setField(i, 'uploading', false);
    }
  };

  // A row is valid only when item is picked, qty > 0, AND condition is set.
  // Site is shared at the top — checked separately on submit.
  const valid = rows.filter(r => r.item_master_id && +r.quantity > 0 && r.condition);

  const submit = async (e) => {
    e.preventDefault();
    if (!warehouseId) return toast.error('Pick a Site / Warehouse at the top first');
    // Surface row-level issues so mam knows exactly which row to fix
    // (instead of "no valid rows" which doesn't help her).
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const hasAny = r.item_master_id || +r.quantity > 0 || r.condition;
      if (!hasAny) continue; // empty row — silently skipped
      if (!r.item_master_id) return toast.error(`Row ${i + 1}: pick an Item`);
      if (!(+r.quantity > 0)) return toast.error(`Row ${i + 1}: Quantity must be greater than 0`);
      if (!r.condition) return toast.error(`Row ${i + 1}: pick Condition (Used / Unused / Scrap)`);
    }
    if (valid.length === 0) return toast.error('Add at least one complete row (Item + Qty + Condition)');
    if (rows.some(r => r.uploading)) return toast.error('Wait for photo uploads to finish');
    setSaving(true);
    let okCount = 0;
    for (const row of valid) {
      // Rate auto-pulled from Item Master at submit time (not user-entered)
      const it = items.find(o => o.id === +row.item_master_id);
      const masterRate = +(it?.current_price || 0);
      try {
        await api.post('/inventory/receive', {
          warehouse_id: +warehouseId,
          reference_type: 'OPENING',
          notes: notes || 'Opening balance',
          items: [{
            item_master_id: +row.item_master_id,
            quantity: +row.quantity,
            rate: masterRate,
            photo_url: row.photo_url || null,
            item_condition: row.condition,
          }],
        });
        okCount += 1;
      } catch (err) {
        console.error('opening row failed', err.response?.data?.error);
      }
    }
    toast.success(`Saved ${okCount} of ${valid.length} opening stock row(s)`);
    setRows([newRow()]);
    setNotes('');
    reload();
    setSaving(false);
  };

  const activeWarehouses = warehouses.filter(w => w.active);

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="card p-3 bg-amber-50/50 border-l-4 border-amber-400 text-xs text-amber-900">
        Pick the Site / Warehouse at the top, then add as many items as you want underneath. Rate + Type are auto-picked from Item Master so you only enter Qty + Condition. Use this for old / existing stock BEFORE going live.
      </div>

      {/* SITE / WAREHOUSE picker — ONE for the whole session.
          mam's workflow: "I'm at Site X, here are 50 items I need to log."
          Picking site once (instead of repeating per row) is much faster
          and removes a major source of data-entry errors. */}
      <div className="card p-3 border-l-4 border-blue-500 bg-blue-50/40">
        <label className="label">
          Site / Warehouse <span className="text-red-500">*</span>
          <span className="ml-2 text-[10px] text-gray-500 font-normal normal-case">— applies to ALL rows below</span>
        </label>
        <select className="select" value={warehouseId} onChange={e => setWarehouseId(e.target.value)} required>
          <option value="">Pick site / warehouse…</option>
          {activeWarehouses.map(w => (
            <option key={w.id} value={w.id}>{w.name}{w.type === 'office' ? ' ★' : ''}{w.opening_date ? ` · opens ${String(w.opening_date).slice(0,10)}` : ''}</option>
          ))}
        </select>
        {/* Per-site opening date — the day-1 baseline FOR THIS SITE. Automated
            movements count from this date for this warehouse (mam 2026-06-25). */}
        {warehouseId && (
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-blue-200/60 pt-2">
            <span className="text-[11px] font-semibold text-gray-700">📅 Opening date for this site</span>
            <span className="text-[10px] text-gray-500">— day-1 baseline; automated movements count from here for this warehouse</span>
            <input type="date" className="input w-44 ml-auto" value={siteOpenDate || ''} disabled={savingOpenDate}
              onChange={e => saveSiteOpenDate(e.target.value)} />
            {siteOpenDate && <button type="button" onClick={() => saveSiteOpenDate('')} className="text-xs text-red-500 hover:underline">Clear</button>}
            {savingOpenDate && <span className="text-xs text-gray-400">saving…</span>}
          </div>
        )}
      </div>

      {/* Department pre-filter — narrows the item dropdown from 3,000+
          to just CIVIL / FF / Electrical / etc. so mam can find items
          much faster. Applies to every row in this entry session. */}
      <div className="card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide mr-1">Filter items by department:</span>
          <button
            type="button"
            onClick={() => setDeptFilter('')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${deptFilter === '' ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
          >
            All ({items.length})
          </button>
          {departments.map(d => {
            const count = items.filter(i => i.department === d).length;
            return (
              <button
                key={d}
                type="button"
                onClick={() => setDeptFilter(d)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${deptFilter === d ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
              >
                {d} <span className="opacity-70 ml-0.5">({count})</span>
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-gray-400 mt-2">
          {deptFilter
            ? <>Showing only <span className="font-semibold text-red-700">{deptFilter}</span> items in the search dropdowns below.</>
            : <>Showing all items. Pick a department to narrow the dropdown.</>}
        </p>
      </div>

      {/* Card-per-row layout — old table broke when the item-search
          dropdown opened (it covered the qty / rate / photo columns).
          Cards give each row enough room for the dropdown to expand
          and stay fully visible on mobile. */}
      <div className="space-y-3">
        {rows.map((r, i) => {
          const it = items.find(o => o.id === +r.item_master_id);
          const ready = r.item_master_id && +r.quantity > 0 && r.condition;
          // Rate is AUTO-pulled from Item Master (current_price). Read-only display
          // so mam's people can't accidentally enter a wrong rate during opening
          // balance entry — single source of truth = the catalog price.
          const masterRate = it ? +(it.current_price || 0) : 0;
          // Type badge (PO / FOC / RGP) auto-picked from Item Master.
          const t = String(it?.type || '').toUpperCase();
          const typeClass = t === 'FOC' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
            : t === 'RGP' ? 'bg-amber-50 text-amber-700 border-amber-200'
            : t === 'PO'  ? 'bg-red-50 text-red-700 border-red-200'
            : 'bg-gray-50 text-gray-500 border-gray-200';
          // Condition dot — quick visual anchor on the card stripe
          const condClass = r.condition === 'Unused' ? 'border-emerald-500'
            : r.condition === 'Used' ? 'border-amber-500'
            : r.condition === 'Scrap' ? 'border-red-500'
            : ready ? 'border-emerald-500' : 'border-gray-200';
          return (
            <div key={i} className={`card p-4 border-l-4 ${condClass}`}>
              <div className="flex items-center justify-between mb-3">
                <div className="text-xs font-semibold text-gray-500">
                  Row #{i + 1}
                  {ready && <span className="ml-2 text-[10px] px-2 py-0.5 rounded bg-emerald-100 text-emerald-700">ready</span>}
                </div>
                <button type="button" onClick={() => rmRow(i)} className="p-1 text-gray-400 hover:text-red-600" title="Remove row">
                  <FiTrash2 size={14} />
                </button>
              </div>

              <div className="space-y-3">
                {/* Item picker — full width so the dropdown has room to expand */}
                <div>
                  <label className="label">
                    Item <span className="text-red-500">*</span>
                    {deptFilter && <span className="ml-2 text-[10px] text-gray-400 normal-case font-normal">— filtered to {deptFilter} ({filteredItems.length})</span>}
                  </label>
                  <SearchableSelect
                    options={filteredItems}
                    value={r.item_master_id || null}
                    valueKey="id" displayKey="label"
                    placeholder={`Search ${deptFilter ? deptFilter + ' ' : ''}items by name / code / spec…`}
                    onChange={(opt) => setField(i, 'item_master_id', opt?.id || '')}
                  />
                  {it && (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <p className="text-[11px] text-gray-500">
                        {it.specification && <span>{it.specification} · </span>}
                        UOM: {it.uom || '—'}{it.make ? ' · Make: ' + it.make : ''}
                        {it.department && <span> · Dept: {it.department}</span>}
                      </p>
                      {/* Type badge — auto from Item Master, read-only */}
                      {it.type && (
                        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${typeClass}`} title="Auto-picked from Item Master">
                          {it.type}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Qty + Rate(auto) + Type(auto) + Condition + Photo on one row */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="label">Quantity <span className="text-red-500">*</span></label>
                    <input className="input text-right tabular-nums text-base font-bold" type="number" step="any" min="0" placeholder="0" value={r.quantity} onChange={e => setField(i, 'quantity', e.target.value)} />
                    {it?.uom && <p className="text-[11px] text-gray-400 mt-0.5">in {it.uom}</p>}
                  </div>
                  <div>
                    <label className="label">Rate ₹ <span className="text-gray-400 font-normal text-[10px]">(auto from master)</span></label>
                    <div className="input text-right tabular-nums bg-gray-50 text-gray-700 cursor-not-allowed" title="Auto-picked from Item Master · current_price">
                      {it ? (masterRate > 0 ? masterRate.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : <span className="text-gray-400 italic font-normal">— not set —</span>) : <span className="text-gray-400 italic font-normal">pick item</span>}
                    </div>
                    {it && masterRate > 0 && <p className="text-[11px] text-gray-400 mt-0.5">value: ₹ {(masterRate * (+r.quantity || 0)).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</p>}
                  </div>
                  <div>
                    <label className="label">Condition <span className="text-red-500">*</span></label>
                    <select className="select" value={r.condition} onChange={e => setField(i, 'condition', e.target.value)} required>
                      <option value="">— pick —</option>
                      {CONDITIONS.map(c => (<option key={c} value={c}>{c}</option>))}
                    </select>
                  </div>
                  <div>
                    <label className="label">Photo <span className="text-gray-400 font-normal text-[10px]">(optional)</span></label>
                    <div className="flex items-center gap-2">
                      <input
                        type="file"
                        accept="image/*,.pdf"
                                                disabled={r.uploading}
                        onChange={e => uploadPhoto(i, e.target.files?.[0])}
                        className="block w-full text-xs text-gray-500 file:mr-2 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100"
                      />
                    </div>
                    {r.uploading && <p className="text-[11px] text-amber-600 mt-0.5">uploading…</p>}
                    {r.photo_url && !r.uploading && (
                      <a href={r.photo_url} target="_blank" rel="noreferrer" className="text-[11px] text-emerald-700 hover:underline mt-0.5 inline-block">✓ photo attached</a>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {/* Add row button — separate card so it never collides with the
            search dropdown of the row above */}
        <button
          type="button"
          onClick={addRow}
          className="w-full card p-4 border-2 border-dashed border-gray-300 hover:border-red-400 hover:bg-red-50/30 text-gray-500 hover:text-red-600 flex items-center justify-center gap-2 text-sm font-medium transition-colors"
        >
          <FiPlus size={14} /> Add another item
        </button>
      </div>

      <div>
        <label className="label">Notes (applies to all rows)</label>
        <input className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. Site audit Apr 28, 2026 verified by Rajat" />
      </div>

      <div className="flex justify-between items-center">
        <span className="text-xs text-gray-500">{valid.length} valid row(s) ready to save</span>
        <button type="submit" disabled={saving || valid.length === 0} className="btn btn-primary flex items-center gap-2">
          <FiArrowDown size={14} /> {saving ? 'Saving…' : `Save ${valid.length} Row${valid.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </form>
  );
}

// ---------- OPENING STOCK — ITEM-WISE MATRIX ----------
// (was the previous OpeningStockTab body — kept as a sub-mode)
function OpeningItemwiseEntry({ warehouses, items, reload }) {
  const [selectedItem, setSelectedItem] = useState(null);
  const [notes, setNotes] = useState('');
  // Per-warehouse rows. Keyed by warehouse_id.
  const [whRows, setWhRows] = useState({});  // { [wh_id]: { quantity, rate, photo_url, uploading } }
  const [saving, setSaving] = useState(false);

  // Reset rows when the selected item changes
  useEffect(() => {
    if (!selectedItem) { setWhRows({}); return; }
    const next = {};
    for (const w of warehouses) {
      if (w.active === 0) continue;
      next[w.id] = { quantity: '', rate: '', photo_url: '', uploading: false };
    }
    setWhRows(next);
  }, [selectedItem?.id, warehouses.length]);

  const setRow = (whId, key, val) => setWhRows(r => ({ ...r, [whId]: { ...(r[whId] || {}), [key]: val } }));

  const uploadPhoto = async (whId, file) => {
    if (!file) return;
    setRow(whId, 'uploading', true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setRow(whId, 'photo_url', r.data.url);
      setRow(whId, 'uploading', false);
    } catch {
      toast.error('Photo upload failed');
      setRow(whId, 'uploading', false);
    }
  };

  const totalQty = useMemo(
    () => Object.values(whRows).reduce((s, r) => s + (+(r.quantity) || 0), 0),
    [whRows]
  );
  const filledCount = useMemo(
    () => Object.values(whRows).filter(r => +r.quantity > 0).length,
    [whRows]
  );

  const submit = async (e) => {
    e.preventDefault();
    if (!selectedItem?.id) return toast.error('Pick an item first');
    const valid = Object.entries(whRows).filter(([, r]) => +r.quantity > 0);
    if (valid.length === 0) return toast.error('Enter quantity for at least one warehouse');
    if (Object.values(whRows).some(r => r.uploading)) return toast.error('Wait for photo uploads to finish');
    setSaving(true);
    try {
      // One receive call per warehouse — keeps the existing endpoint simple
      // and the audit log per-warehouse for clarity. Run sequentially so
      // errors on one don't block the rest from being attempted.
      let okCount = 0;
      for (const [whId, r] of valid) {
        try {
          await api.post('/inventory/receive', {
            warehouse_id: +whId,
            reference_type: 'OPENING',
            notes: notes || `Opening balance — ${selectedItem.item_name || selectedItem.label}`,
            items: [{
              item_master_id: selectedItem.id,
              quantity: +r.quantity,
              rate: +(r.rate || 0),
              photo_url: r.photo_url || null,
            }],
          });
          okCount += 1;
        } catch (err) {
          console.error('opening receive failed for wh', whId, err.response?.data?.error);
        }
      }
      toast.success(`Saved opening stock for ${selectedItem.item_name || selectedItem.label} in ${okCount} warehouse(s)`);
      // Reset for next item
      setSelectedItem(null);
      setNotes('');
      setWhRows({});
      reload();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
    setSaving(false);
  };

  const officeWh = warehouses.filter(w => w.active && w.type === 'office');
  const siteWh = warehouses.filter(w => w.active && w.type === 'site_store');

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="card p-4 bg-amber-50/50 border-l-4 border-amber-400">
        <p className="text-sm text-amber-900">
          <span className="font-semibold">For old / existing stock at all warehouses.</span>
          Pick one item, then enter how much of that item is currently sitting at each warehouse. Save once — every warehouse with a quantity gets a separate IN movement tagged "OPENING". Use this BEFORE going live so the system knows your real starting balances.
        </p>
      </div>

      {/* Item picker */}
      <div className="card p-4">
        <label className="label">Pick the item *</label>
        <SearchableSelect
          options={items}
          value={selectedItem?.id || null}
          valueKey="id" displayKey="label"
          placeholder="Search by name or code…"
          onChange={(it) => setSelectedItem(it || null)}
        />
        {selectedItem && (
          <div className="mt-2 text-[11px] text-gray-500">
            <span className="font-medium text-gray-700">{selectedItem.item_name}</span>
            {selectedItem.specification && <span> · {selectedItem.specification}</span>}
            {selectedItem.uom && <span> · UOM: {selectedItem.uom}</span>}
            {selectedItem.make && <span> · Make: {selectedItem.make}</span>}
          </div>
        )}
      </div>

      {selectedItem && (
        <>
          {/* Warehouses grid */}
          <div className="card p-0 overflow-hidden">
            <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
              <h4 className="font-semibold text-gray-700 text-sm">Quantity per warehouse</h4>
              <span className="text-[11px] text-gray-500">{filledCount} warehouse(s) · total {fmtNum(totalQty)} {selectedItem.uom || 'units'}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="text-sm w-full">
                <thead className="bg-gray-50/60">
                  <tr>
                    <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Warehouse</th>
                    <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500 w-32">Quantity</th>
                    <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500 w-32">Rate ₹</th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500 w-64">Photo (optional)</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Office stores first */}
                  {officeWh.map(w => {
                    const r = whRows[w.id] || {};
                    return (
                      <tr key={w.id} className="border-t hover:bg-red-50/30">
                        <td className="px-3 py-2">
                          <div className="font-medium text-gray-800">{w.name}</div>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700">Office</span>
                        </td>
                        <td className="px-2 py-1.5"><input className="input text-right tabular-nums" type="number" step="any" min="0" placeholder="0" value={r.quantity || ''} onChange={e => setRow(w.id, 'quantity', e.target.value)} /></td>
                        <td className="px-2 py-1.5"><input className="input text-right tabular-nums" type="number" step="any" min="0" placeholder="optional" value={r.rate || ''} onChange={e => setRow(w.id, 'rate', e.target.value)} /></td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-center gap-2">
                            <input type="file" accept="image/*,.pdf" disabled={r.uploading}
                              onChange={e => uploadPhoto(w.id, e.target.files?.[0])}
                              className="text-[10px] text-gray-500 file:mr-1 file:py-0.5 file:px-2 file:rounded file:border-0 file:text-[10px] file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100" />
                            {r.uploading && <span className="text-[10px] text-amber-600">…</span>}
                            {r.photo_url && !r.uploading && <a href={r.photo_url} target="_blank" rel="noreferrer" className="text-[10px] text-emerald-700 hover:underline">✓</a>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {/* Site stores */}
                  {siteWh.map(w => {
                    const r = whRows[w.id] || {};
                    return (
                      <tr key={w.id} className="border-t hover:bg-blue-50/30">
                        <td className="px-3 py-2">
                          <div className="font-medium text-gray-800">{w.name}</div>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">Site</span>
                        </td>
                        <td className="px-2 py-1.5"><input className="input text-right tabular-nums" type="number" step="any" min="0" placeholder="0" value={r.quantity || ''} onChange={e => setRow(w.id, 'quantity', e.target.value)} /></td>
                        <td className="px-2 py-1.5"><input className="input text-right tabular-nums" type="number" step="any" min="0" placeholder="optional" value={r.rate || ''} onChange={e => setRow(w.id, 'rate', e.target.value)} /></td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-center gap-2">
                            <input type="file" accept="image/*,.pdf" disabled={r.uploading}
                              onChange={e => uploadPhoto(w.id, e.target.files?.[0])}
                              className="text-[10px] text-gray-500 file:mr-1 file:py-0.5 file:px-2 file:rounded file:border-0 file:text-[10px] file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100" />
                            {r.uploading && <span className="text-[10px] text-amber-600">…</span>}
                            {r.photo_url && !r.uploading && <a href={r.photo_url} target="_blank" rel="noreferrer" className="text-[10px] text-emerald-700 hover:underline">✓</a>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <label className="label">Notes (applies to all warehouses)</label>
            <input className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. Site audit Apr 28, 2026 verified by Rajat" />
          </div>

          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => { setSelectedItem(null); setWhRows({}); setNotes(''); }} className="btn btn-secondary">Reset</button>
            <button type="submit" disabled={saving || filledCount === 0} className="btn btn-primary flex items-center gap-2">
              <FiArrowDown size={14} /> {saving ? 'Saving…' : `Save Opening Stock (${filledCount} warehouse${filledCount === 1 ? '' : 's'})`}
            </button>
          </div>
        </>
      )}

      {!selectedItem && (
        <div className="card p-6 text-center text-gray-400 text-sm">
          ↑ Pick an item above to enter its opening stock across all warehouses.
        </div>
      )}
    </form>
  );
}

// ---------- RECEIVE TAB ----------
function ReceiveTab({ warehouses, items, reload }) {
  const [form, setForm] = useState({ warehouse_id: '', reference_type: 'PURCHASE', reference_id: '', notes: '' });
  const [lines, setLines] = useState([{ item_master_id: '', quantity: '', rate: '', photo_url: '', uploading: false }]);
  const [saving, setSaving] = useState(false);
  const [scanFor, setScanFor] = useState(null);  // index of the line we're scanning for

  // Helper: when a barcode is scanned, look up an item by item_code
  // (case-insensitive, also matches numeric IDs) and set it on the line.
  const onScanResult = (text) => {
    const code = String(text || '').trim();
    if (!code) return;
    const match = items.find(it =>
      (it.item_code && it.item_code.toUpperCase() === code.toUpperCase())
      || String(it.id) === code
    );
    if (!match) {
      toast.error(`No item with code "${code}" in master`);
    } else {
      const i = scanFor;
      setLines(l => l.map((x, idx) => idx === i ? { ...x, item_master_id: match.id } : x));
      toast.success(`Scanned: ${match.item_code} · ${match.item_name}`);
    }
    setScanFor(null);
  };

  const addLine = () => setLines(l => [...l, { item_master_id: '', quantity: '', rate: '', photo_url: '', uploading: false }]);
  const rmLine = (i) => setLines(l => l.filter((_, idx) => idx !== i));
  const setLine = (i, k, v) => setLines(l => l.map((x, idx) => idx === i ? { ...x, [k]: v } : x));

  // Upload a per-line photo (optional). Used mostly for OPENING balance
  // entries where mam wants visual proof of what's actually at a site.
  const uploadPhoto = async (i, file) => {
    if (!file) return;
    setLine(i, 'uploading', true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setLine(i, 'photo_url', r.data.url);
      setLine(i, 'uploading', false);
    } catch {
      toast.error('Photo upload failed');
      setLine(i, 'uploading', false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.warehouse_id) return toast.error('Pick a warehouse');
    const valid = lines.filter(l => l.item_master_id && +l.quantity > 0);
    if (valid.length === 0) return toast.error('Add at least one item with quantity');
    if (lines.some(l => l.uploading)) return toast.error('Wait for photo uploads to finish');
    setSaving(true);
    try {
      await api.post('/inventory/receive', {
        ...form,
        items: valid.map(l => ({ item_master_id: l.item_master_id, quantity: l.quantity, rate: l.rate, photo_url: l.photo_url || null })),
      });
      toast.success(`Received ${valid.length} item(s)`);
      setLines([{ item_master_id: '', quantity: '', rate: '', photo_url: '', uploading: false }]);
      setForm(f => ({ ...f, reference_id: '', notes: '' }));
      reload();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
    setSaving(false);
  };

  return (
    <form onSubmit={submit} className="card p-4 space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="label">Warehouse *</label>
          <select className="select" value={form.warehouse_id} onChange={e => setForm(f => ({ ...f, warehouse_id: e.target.value }))} required>
            <option value="">Select…</option>
            {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}{w.type === 'office' ? ' ★' : ''}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Reference Type</label>
          <select className="select" value={form.reference_type} onChange={e => setForm(f => ({ ...f, reference_type: e.target.value }))}>
            <option value="PURCHASE">Purchase / Vendor delivery</option>
            <option value="GRN">GRN (Goods Receipt Note)</option>
            <option value="OPENING">Opening Balance</option>
            <option value="ADJUST">Adjustment (Stock found)</option>
          </select>
        </div>
        <div>
          <label className="label">Reference No (PO / GRN / Bill)</label>
          <input className="input" value={form.reference_id} onChange={e => setForm(f => ({ ...f, reference_id: e.target.value }))} placeholder="optional" />
        </div>
      </div>

      <div>
        <div className="flex justify-between items-center mb-2">
          <h4 className="font-semibold text-sm text-gray-700">Items</h4>
          <button type="button" onClick={addLine} className="btn btn-secondary text-xs flex items-center gap-1"><FiPlus size={12} /> Add Line</button>
        </div>
        <div className="space-y-3">
          {lines.map((l, i) => (
            <div key={i} className="border rounded-lg p-2 space-y-2 bg-gray-50/40">
              <div className="grid grid-cols-12 gap-2 items-start">
                <div className="col-span-5">
                  <SearchableSelect
                    options={items}
                    value={l.item_master_id || null}
                    valueKey="id" displayKey="label"
                    placeholder="Search item by name / code…"
                    onChange={(it) => setLine(i, 'item_master_id', it?.id || '')}
                  />
                </div>
                <button type="button" onClick={() => setScanFor(i)} className="col-span-1 btn btn-secondary text-xs flex items-center justify-center gap-1" title="Scan barcode to pick item">
                  <FiCamera size={14} />
                </button>
                <input className="input col-span-2" type="number" step="any" min="0" placeholder="Qty" value={l.quantity} onChange={e => setLine(i, 'quantity', e.target.value)} />
                <input className="input col-span-3" type="number" step="any" min="0" placeholder="Rate ₹ (optional)" value={l.rate} onChange={e => setLine(i, 'rate', e.target.value)} />
                <button type="button" onClick={() => rmLine(i)} className="text-gray-400 hover:text-red-600 col-span-1 self-center justify-self-center" title="Remove"><FiTrash2 size={14} /></button>
              </div>
              {/* Optional photo per line — useful for opening balance proof */}
              <div className="grid grid-cols-12 gap-2 items-center pl-1">
                <label className="col-span-3 text-[11px] text-gray-500 flex items-center gap-1">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
                  Photo (optional)
                </label>
                <input
                  type="file"
                  accept="image/*,.pdf"
                                    disabled={l.uploading}
                  onChange={e => uploadPhoto(i, e.target.files?.[0])}
                  className="col-span-7 text-[11px] text-gray-500 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-[10px] file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100"
                />
                <div className="col-span-2">
                  {l.uploading && <span className="text-[10px] text-amber-600">uploading…</span>}
                  {l.photo_url && !l.uploading && (
                    <a href={l.photo_url} target="_blank" rel="noreferrer" className="text-[10px] text-emerald-700 hover:underline">✓ photo attached</a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <label className="label">Notes</label>
        <input className="input" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Vendor name, delivery details, etc." />
      </div>

      <div className="flex justify-end">
        <button type="submit" disabled={saving} className="btn btn-primary flex items-center gap-2">
          <FiArrowDown size={14} /> {saving ? 'Saving…' : 'Receive Stock'}
        </button>
      </div>

      <BarcodeScanner open={scanFor != null} onClose={() => setScanFor(null)} onScan={onScanResult} />
    </form>
  );
}

// ---------- ISSUE TAB ----------
function IssueTab({ warehouses, sites, items, reload }) {
  const [form, setForm] = useState({ from_warehouse_id: '', destination_type: 'site', destination_id: '', notes: '', reference_id: '' });
  const [lines, setLines] = useState([{ item_master_id: '', quantity: '' }]);
  const [saving, setSaving] = useState(false);
  const [scanFor, setScanFor] = useState(null);

  const addLine = () => setLines(l => [...l, { item_master_id: '', quantity: '' }]);
  const rmLine = (i) => setLines(l => l.filter((_, idx) => idx !== i));
  const setLine = (i, k, v) => setLines(l => l.map((x, idx) => idx === i ? { ...x, [k]: v } : x));

  const onScanResult = (text) => {
    const code = String(text || '').trim();
    if (!code) return;
    const match = items.find(it =>
      (it.item_code && it.item_code.toUpperCase() === code.toUpperCase())
      || String(it.id) === code
    );
    if (!match) toast.error(`No item with code "${code}" in master`);
    else {
      const i = scanFor;
      setLines(l => l.map((x, idx) => idx === i ? { ...x, item_master_id: match.id } : x));
      toast.success(`Scanned: ${match.item_code} · ${match.item_name}`);
    }
    setScanFor(null);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.from_warehouse_id) return toast.error('Pick a source warehouse');
    if (!form.destination_id) return toast.error('Pick a destination');
    const valid = lines.filter(l => l.item_master_id && +l.quantity > 0);
    if (valid.length === 0) return toast.error('Add at least one item');
    setSaving(true);
    try {
      await api.post('/inventory/issue', { ...form, items: valid });
      toast.success(form.destination_type === 'warehouse' ? 'Stock transferred' : 'Stock issued to site');
      setLines([{ item_master_id: '', quantity: '' }]);
      setForm(f => ({ ...f, reference_id: '', notes: '' }));
      reload();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
    setSaving(false);
  };

  // Filter destination warehouses to NOT include the source
  const destWarehouses = warehouses.filter(w => w.id !== +form.from_warehouse_id);

  return (
    <form onSubmit={submit} className="card p-4 space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="label">From Warehouse *</label>
          <select className="select" value={form.from_warehouse_id} onChange={e => setForm(f => ({ ...f, from_warehouse_id: e.target.value }))} required>
            <option value="">Select source…</option>
            {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}{w.type === 'office' ? ' ★' : ''}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Destination Type *</label>
          <select className="select" value={form.destination_type} onChange={e => setForm(f => ({ ...f, destination_type: e.target.value, destination_id: '' }))}>
            <option value="site">Site (consumption)</option>
            <option value="warehouse">Another Warehouse (transfer)</option>
          </select>
        </div>
        <div>
          <label className="label">{form.destination_type === 'site' ? 'Destination Site *' : 'Destination Warehouse *'}</label>
          <select className="select" value={form.destination_id} onChange={e => setForm(f => ({ ...f, destination_id: e.target.value }))} required>
            <option value="">Select…</option>
            {form.destination_type === 'site'
              ? sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)
              : destWarehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
      </div>

      <div>
        <div className="flex justify-between items-center mb-2">
          <h4 className="font-semibold text-sm text-gray-700">Items</h4>
          <button type="button" onClick={addLine} className="btn btn-secondary text-xs flex items-center gap-1"><FiPlus size={12} /> Add Line</button>
        </div>
        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 items-start">
              <div className="col-span-8">
                <SearchableSelect
                  options={items}
                  value={l.item_master_id || null}
                  valueKey="id" displayKey="label"
                  placeholder="Search item by name / code…"
                  onChange={(it) => setLine(i, 'item_master_id', it?.id || '')}
                />
              </div>
              <button type="button" onClick={() => setScanFor(i)} className="col-span-1 btn btn-secondary text-xs flex items-center justify-center" title="Scan barcode">
                <FiCamera size={14} />
              </button>
              <input className="input col-span-2" type="number" step="any" min="0" placeholder="Qty" value={l.quantity} onChange={e => setLine(i, 'quantity', e.target.value)} />
              <button type="button" onClick={() => rmLine(i)} className="text-gray-400 hover:text-red-600 col-span-1 self-center justify-self-center" title="Remove"><FiTrash2 size={14} /></button>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="label">Reference No (Indent / Challan)</label>
          <input className="input" value={form.reference_id} onChange={e => setForm(f => ({ ...f, reference_id: e.target.value }))} placeholder="optional" />
        </div>
        <div>
          <label className="label">Notes</label>
          <input className="input" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Issued by / received by / purpose" />
        </div>
      </div>

      <div className="flex justify-end">
        <button type="submit" disabled={saving} className="btn btn-primary flex items-center gap-2">
          <FiArrowUp size={14} /> {saving ? 'Saving…' : (form.destination_type === 'warehouse' ? 'Transfer Stock' : 'Issue to Site')}
        </button>
      </div>

      <BarcodeScanner open={scanFor != null} onClose={() => setScanFor(null)} onScan={onScanResult} />
    </form>
  );
}

// ---------- MOVEMENTS TAB ----------
function MovementsTab({ movements, warehouses, filter, setFilter }) {
  return (
    <>
      <div className="card p-4 grid grid-cols-1 sm:grid-cols-5 gap-3">
        <div>
          <label className="label">Warehouse</label>
          <select className="select" value={filter.warehouse_id} onChange={e => setFilter(f => ({ ...f, warehouse_id: e.target.value }))}>
            <option value="">All</option>
            {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Type</label>
          <select className="select" value={filter.type} onChange={e => setFilter(f => ({ ...f, type: e.target.value }))}>
            <option value="">All</option>
            <option value="IN">IN</option>
            <option value="OUT">OUT</option>
          </select>
        </div>
        <div>
          <label className="label">From Date</label>
          <input type="date" className="input" value={filter.date_from} onChange={e => setFilter(f => ({ ...f, date_from: e.target.value }))} />
        </div>
        <div>
          <label className="label">To Date</label>
          <input type="date" className="input" value={filter.date_to} onChange={e => setFilter(f => ({ ...f, date_to: e.target.value }))} />
        </div>
        <div className="self-end text-xs text-gray-500">{movements.length} movements</div>
      </div>

      <div className="card p-0">
        <table className="text-sm w-full freeze-head">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">When</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Type</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Warehouse</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Item</th>
              <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Qty</th>
              <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Rate</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Reference / Destination</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">By</th>
            </tr>
          </thead>
          <tbody>
            {movements.length === 0 && <tr><td colSpan="8" className="text-center py-8 text-gray-400 text-sm">No movements yet</td></tr>}
            {movements.map(m => (
              <tr key={m.id} className="border-t hover:bg-gray-50">
                <td className="px-3 py-1.5 text-[11px] text-gray-500 font-mono whitespace-nowrap">{fmtDateTime(m.created_at, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                <td className="px-3 py-1.5">
                  <span className={`px-2 py-0.5 text-[10px] rounded ${m.type === 'IN' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                    {m.type}{m.reference_type === 'TRANSFER' ? ' · XFER' : ''}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-gray-700">{m.warehouse_name}</td>
                <td className="px-3 py-1.5">
                  <div className="text-gray-800">{m.item_name}</div>
                  {m.item_code && <div className="text-[10px] text-gray-400 font-mono">{m.item_code}</div>}
                </td>
                <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{fmtNum(m.quantity)} <span className="text-[10px] text-gray-400">{m.uom}</span></td>
                <td className="px-3 py-1.5 text-right text-gray-600 tabular-nums">{m.rate ? fmtMoney(m.rate) : '—'}</td>
                <td className="px-3 py-1.5 text-[11px] text-gray-600">
                  {m.reference_type && <span className="font-medium">{m.reference_type}</span>}
                  {m.reference_id && <span className="ml-1 text-gray-400">#{m.reference_id}</span>}
                  {m.to_warehouse_name && <div className="text-gray-500">→ {m.to_warehouse_name}</div>}
                  {m.from_warehouse_name && <div className="text-gray-500">← {m.from_warehouse_name}</div>}
                  {m.site_name && <div className="text-gray-500">site: {m.site_name}</div>}
                  {m.notes && <div className="text-gray-400 italic truncate max-w-[220px]" title={m.notes}>{m.notes}</div>}
                  {m.photo_url && (
                    <a href={m.photo_url} target="_blank" rel="noreferrer" className="inline-block mt-1">
                      <img src={m.photo_url} alt="proof" className="w-14 h-14 object-cover rounded border hover:scale-150 transition-transform" />
                    </a>
                  )}
                </td>
                <td className="px-3 py-1.5 text-[11px] text-gray-500">{m.created_by_name || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------- REPORTS & VALUATION TAB ----------
// Per-warehouse roll-up + low-stock list. Lightweight — both feeds come
// from /summary and /low-stock so no extra DB load on every visit.
function ReportsTab({ summary, warehouses }) {
  const [lowStock, setLowStock] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.get('/inventory/low-stock')
      .then(r => setLowStock(r.data || []))
      .catch(() => setLowStock([]))
      .finally(() => setLoading(false));
  }, []);

  const grandTotal = useMemo(() => summary.reduce((s, w) => s + (+w.total_value || 0), 0), [summary]);
  const grandItems = useMemo(() => summary.reduce((s, w) => s + (+w.items_in_stock || 0), 0), [summary]);

  return (
    <>
      {/* Hero: total stock value across all warehouses · royal-blue brand
          (mam, 2026-05-20).  Was red gradient. */}
      <div className="card p-6 bg-gradient-to-br from-blue-700 via-blue-800 to-blue-950 text-white shadow-lg">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-widest text-blue-100/80 font-semibold">Total Stock Value (All Warehouses)</div>
            <div className="text-[11px] text-blue-100/70 mt-0.5">Moving-average basis · {fmtNum(grandItems)} items in stock</div>
          </div>
          <div className="text-4xl sm:text-5xl font-extrabold tracking-tight tabular-nums">
            {fmtMoney(grandTotal)}
          </div>
        </div>
      </div>

      {/* Per-warehouse breakdown */}
      <div className="card p-0 overflow-hidden">
        <div className="px-4 py-3 border-b bg-gray-50">
          <h4 className="font-semibold text-gray-700 flex items-center gap-2"><FiBarChart2 size={14} className="text-red-600" /> Stock Value by Warehouse</h4>
        </div>
        <div className="overflow-x-auto">
          <table className="text-sm w-full">
            <thead className="bg-gray-50/60">
              <tr>
                <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Warehouse</th>
                <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Type</th>
                <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Items in Stock</th>
                <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Total Value</th>
                <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Low Stock Items</th>
                <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">% of Total</th>
              </tr>
            </thead>
            <tbody>
              {summary.length === 0 && (
                <tr><td colSpan="6" className="text-center py-8 text-gray-400 text-sm">No warehouses</td></tr>
              )}
              {summary.map(w => {
                const pct = grandTotal > 0 ? ((+w.total_value / grandTotal) * 100) : 0;
                return (
                  <tr key={w.id} className="border-t hover:bg-gray-50">
                    <td className="px-3 py-2 font-medium text-gray-800">{w.name}</td>
                    <td className="px-3 py-2"><span className={`px-2 py-0.5 text-[10px] rounded ${w.type === 'office' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`}>{w.type === 'office' ? 'Office' : 'Site'}</span></td>
                    <td className="px-3 py-2 text-right text-gray-700 tabular-nums">{fmtNum(w.items_in_stock)}</td>
                    <td className="px-3 py-2 text-right font-bold text-red-700 tabular-nums">{fmtMoney(w.total_value)}</td>
                    <td className="px-3 py-2 text-right">
                      {w.low_stock_items > 0
                        ? <span className="text-amber-700 font-semibold">{w.low_stock_items}</span>
                        : <span className="text-gray-400">0</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-500 tabular-nums">{pct.toFixed(1)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Low-stock alerts */}
      <div className="card p-0 overflow-hidden">
        <div className="px-4 py-3 border-b bg-amber-50/60 flex items-center justify-between">
          <h4 className="font-semibold text-amber-800 flex items-center gap-2">
            <FiAlertTriangle size={14} className="text-amber-600" /> Low Stock Alerts
          </h4>
          <span className="text-[11px] text-amber-700">items at or below their reorder level</span>
        </div>
        <div className="overflow-x-auto">
          <table className="text-sm w-full">
            <thead className="bg-gray-50/60">
              <tr>
                <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Warehouse</th>
                <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Item</th>
                <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Current</th>
                <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Reorder Level</th>
                <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Shortfall</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan="5" className="text-center py-6 text-gray-400 text-sm">Loading…</td></tr>}
              {!loading && lowStock.length === 0 && (
                <tr><td colSpan="5" className="text-center py-8 text-emerald-600 text-sm">All items well-stocked. No alerts. ✓</td></tr>
              )}
              {!loading && lowStock.map(r => {
                const short = +r.reorder_level - +r.quantity;
                return (
                  <tr key={r.id} className="border-t bg-amber-50/30 hover:bg-amber-50">
                    <td className="px-3 py-2 text-gray-700">{r.warehouse_name}</td>
                    <td className="px-3 py-2">
                      <div className="text-gray-800">{r.item_name}</div>
                      {r.item_code && <div className="text-[10px] text-gray-400 font-mono">{r.item_code}</div>}
                    </td>
                    <td className="px-3 py-2 text-right font-bold text-amber-700 tabular-nums">{fmtNum(r.quantity)} <span className="text-[10px] text-gray-400">{r.uom}</span></td>
                    <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{fmtNum(r.reorder_level)}</td>
                    <td className="px-3 py-2 text-right text-red-700 font-semibold tabular-nums">{short > 0 ? `-${fmtNum(short)}` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ---------- WAREHOUSES TAB ----------
function WarehousesTab({ warehouses, sites, reload, canEdit, canCreate }) {
  const [modal, setModal] = useState(null); // { id?, name, type, site_id, location, in_charge }
  const open = (w) => setModal(w || { name: '', type: 'office', site_id: '', location: '', in_charge: '' });
  const save = async (e) => {
    e.preventDefault();
    try {
      if (modal.id) {
        await api.put(`/inventory/warehouses/${modal.id}`, modal);
      } else {
        await api.post('/inventory/warehouses', modal);
      }
      toast.success('Saved');
      setModal(null);
      reload();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  };

  return (
    <>
      <div className="flex justify-end">
        {canCreate && <button onClick={() => open()} className="btn btn-primary flex items-center gap-2"><FiPlus size={14} /> Add Warehouse</button>}
      </div>
      <div className="card p-0">
        <table className="text-sm w-full freeze-head">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Name</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Type</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Site</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Location</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">In Charge</th>
              <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Items</th>
              <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Value</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {warehouses.map(w => (
              <tr key={w.id} className="border-t hover:bg-gray-50">
                <td className="px-3 py-2 font-medium text-gray-800">{w.name}</td>
                <td className="px-3 py-2"><span className={`px-2 py-0.5 text-[10px] rounded ${w.type === 'office' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`}>{w.type === 'office' ? 'Office' : 'Site'}</span></td>
                <td className="px-3 py-2 text-gray-600">{w.site_name || '—'}</td>
                <td className="px-3 py-2 text-gray-600">{w.location || '—'}</td>
                <td className="px-3 py-2 text-gray-600">{w.in_charge || '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtNum(w.item_count)}</td>
                <td className="px-3 py-2 text-right text-gray-700 tabular-nums">{fmtMoney(w.total_value)}</td>
                <td className="px-3 py-2"><span className={`text-[10px] px-2 py-0.5 rounded ${w.active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-200 text-gray-500'}`}>{w.active ? 'Active' : 'Inactive'}</span></td>
                <td className="px-3 py-2 text-right">{canEdit && <button onClick={() => open(w)} className="p-1 text-gray-400 hover:text-red-600" title="Edit"><FiEdit2 size={14} /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={!!modal} onClose={() => setModal(null)} title={modal?.id ? 'Edit Warehouse' : 'Add Warehouse'}>
        {modal && (
          <form onSubmit={save} className="space-y-3">
            <div><label className="label">Name *</label><input className="input" required value={modal.name} onChange={e => setModal({ ...modal, name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Type</label>
                <select className="select" value={modal.type} onChange={e => setModal({ ...modal, type: e.target.value })} disabled={!!modal.id}>
                  <option value="office">Office Store</option>
                  <option value="site_store">Site Store</option>
                </select>
              </div>
              <div>
                <label className="label">Linked Site {modal.type === 'site_store' && '*'}</label>
                <select className="select" value={modal.site_id || ''} onChange={e => setModal({ ...modal, site_id: e.target.value })} disabled={modal.type !== 'site_store'}>
                  <option value="">—</option>
                  {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            </div>
            <div><label className="label">Location</label><input className="input" value={modal.location || ''} onChange={e => setModal({ ...modal, location: e.target.value })} placeholder="Building / address" /></div>
            <div><label className="label">In Charge</label><input className="input" value={modal.in_charge || ''} onChange={e => setModal({ ...modal, in_charge: e.target.value })} placeholder="Store keeper name" /></div>
            {modal.id && (
              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input type="checkbox" className="w-4 h-4" checked={!!modal.active} onChange={e => setModal({ ...modal, active: e.target.checked ? 1 : 0 })} />
                Active
              </label>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setModal(null)} className="btn btn-secondary">Cancel</button>
              <button type="submit" className="btn btn-primary">Save</button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
