// AR/AP Tracker — rolling weekly cash-flow forecast (mam 2026-06-18).
// Mirrors the "Cash Flow June-2026.xlsx": AR (expected receipts by party ×
// week), AP (expected payments by party × week) and a Summary that nets each
// week into a running balance. Amounts are in LAKHS (₹L).
//
// The key rule: changing an amount or a date is blocked until a remark is
// entered, and every change lands in a searchable, exportable Change Log.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { fmtDateTime } from '../utils/datetime';
import { exportCsv } from '../utils/exportCsv';
import { FiPlus, FiEdit2, FiTrash2, FiDownload, FiUpload, FiClipboard, FiTrendingUp, FiTrendingDown, FiBarChart2, FiClock } from 'react-icons/fi';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtCol = (d) => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]} ${MONTHS[+m[2] - 1]}` : (d || ''); };
// Group a date into its calendar week of the month — 1–7 / 8–14 / 15–21 /
// 22–28 / 29–end — so the grid shows one column per week labelled "1–7 Jun".
const weekOf = (dateStr) => {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return { key: String(dateStr || '?'), label: String(dateStr || ''), sort: 'zzz' };
  const y = +m[1], mo = +m[2], d = +m[3];
  const block = d <= 7 ? 1 : d <= 14 ? 2 : d <= 21 ? 3 : d <= 28 ? 4 : 5;
  const start = (block - 1) * 7 + 1;
  const end = block === 5 ? new Date(y, mo, 0).getDate() : block * 7;
  return { key: `${y}-${String(mo).padStart(2, '0')}-W${block}`, label: `${start}–${end} ${MONTHS[mo - 1]}`, sort: `${y}${String(mo).padStart(2, '0')}${block}` };
};
const fmtL = (n) => (n == null || n === '' ? '' : (+n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 }));
const STATUSES = ['planned', 'partial', 'done', 'cancelled'];
const eff = (r) => (r.actual != null && r.actual !== '' ? +r.actual : +r.planned || 0);
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// "2026-06-24" → "Tue 24" — the collection day within a week column.
const fmtDay = (dateStr) => {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(dateStr || '');
  return `${DOW[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()]} ${m[3]}`;
};
// Collection-day model (mirrors the server): AR settles Mon & Thu, AP Tue & Fri.
const COLLECT_DAYS = { AR: [1, 4], AP: [2, 5] };
const NEXT_COLLECT = { AR: { 0: 1, 1: 3, 2: 2, 3: 1, 4: 4, 5: 3, 6: 2 }, AP: { 0: 2, 1: 1, 2: 3, 3: 2, 4: 1, 5: 4, 6: 3 } };
const parseUTCDate = (s) => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
const isoUTC = (d) => d.toISOString().slice(0, 10);
const addUTCDays = (d, n) => { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; };
const mondayOfWeek = (s) => { const d = parseUTCDate(s) || new Date(); const dow = d.getUTCDay(); return addUTCDays(d, dow === 0 ? -6 : 1 - dow); };
// The collection day an entry lands on: itself if already a collection day, else the next one.
const collectionSlot = (s, kind) => {
  const d = parseUTCDate(s); if (!d) return s;
  const days = COLLECT_DAYS[kind] || COLLECT_DAYS.AR;
  if (days.includes(d.getUTCDay())) return s;
  return isoUTC(addUTCDays(d, (NEXT_COLLECT[kind] || NEXT_COLLECT.AR)[d.getUTCDay()]));
};
// "17-06" → "2026-06-17"; passes a YYYY-MM-DD through unchanged.
const ddmmToISO = (s) => {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})\s*[-/.]\s*(\d{1,2})$/);
  if (m) return `2026-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  return '';
};

export default function ArApTracker() {
  const { canCreate, canEdit, canDelete } = useAuth();
  const [tab, setTab] = useState('ar');                 // ar | ap | summary | log
  const [entries, setEntries] = useState([]);
  const [summary, setSummary] = useState({ rows: [], totals: {} });
  const [log, setLog] = useState([]);
  const [logSearch, setLogSearch] = useState('');
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);          // original row when editing
  const [form, setForm] = useState({});
  const [importResult, setImportResult] = useState(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkRows, setBulkRows] = useState([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [parties, setParties] = useState({ ar: [], ap: [] });
  const [bulkPaste, setBulkPaste] = useState('');
  const blankBulkRow = () => ({ party: '', due_date: '', planned: '' });
  const openBulk = () => { setBulkRows(Array.from({ length: 6 }, blankBulkRow)); setBulkPaste(''); setBulkOpen(true); };
  const setBulkCell = (i, k, v) => setBulkRows(rs => rs.map((r, j) => j === i ? { ...r, [k]: v } : r));
  // Paste a block of "party, date, amount" lines → fill the grid rows.
  const loadPaste = () => {
    const rows = [];
    for (const line of bulkPaste.split(/\r?\n/)) {
      const t = line.trim(); if (!t) continue;
      const parts = t.split(/\t|\s*[,;]\s*/).map(s => s.trim()).filter(Boolean);
      if (parts.length < 3) continue;
      const due = ddmmToISO(parts[1]);
      if (parts[0] && due) rows.push({ party: parts[0], due_date: due, planned: String(parts[2]).replace(/,/g, '') });
    }
    if (!rows.length) return toast.error('No valid lines (need: party, date, amount)');
    setBulkRows(rows); setBulkPaste('');
    toast.success(`${rows.length} rows loaded — review and Add`);
  };

  const load = useCallback(() => {
    api.get('/ar-ap-tracker').then(r => setEntries(r.data || [])).catch(() => {});
    api.get('/ar-ap-tracker/summary').then(r => setSummary(r.data || { rows: [], totals: {} })).catch(() => {});
    api.get('/ar-ap-tracker/parties').then(r => setParties(r.data || { ar: [], ap: [] })).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (tab !== 'log') return;
    api.get('/ar-ap-tracker/changelog', { params: { search: logSearch || undefined } })
      .then(r => setLog(r.data || [])).catch(() => {});
  }, [tab, logSearch]);

  const kind = tab === 'ap' ? 'AP' : 'AR';
  const rows = useMemo(() => entries.filter(e => e.kind === kind), [entries, kind]);
  // AR picks from clients; AP picks from BOTH vendors and clients (many AP
  // parties are clients, not vendors) — one combined list (mam 2026-06-18).
  const partyList = useMemo(() => {
    const merged = kind === 'AR' ? (parties.ar || []) : [...(parties.ap || []), ...(parties.ar || [])];
    return [...new Set(merged)].sort((a, b) => a.localeCompare(b));
  }, [kind, parties]);

  // Pivot: party rows × date columns, cell = sum of effective amounts.
  // Pivot: a fixed 13-week rolling horizon. Weeks are consecutive Mon-start
  // weeks beginning at the earliest entry's week; each week shows its 2
  // collection-day columns (AR Mon/Thu, AP Tue/Fri). Entries land on the
  // collection day they settle on. 13 weeks × 2 days = 26 day columns.
  const pivot = useMemo(() => {
    const parties = [...new Set(rows.map(r => r.party))].sort();
    const istToday = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    const allDates = rows.map(r => r.due_date).filter(Boolean).sort();
    const base = mondayOfWeek(allDates.length ? allDates[0] : istToday);
    const offs = kind === 'AP' ? [1, 4] : [0, 3];        // Tue/Fri vs Mon/Thu offset from Monday
    const weekGroups = [], dates = [];
    for (let i = 0; i < 13; i++) {
      const ws = addUTCDays(base, i * 7);
      const d1 = isoUTC(addUTCDays(ws, offs[0])), d2 = isoUTC(addUTCDays(ws, offs[1]));
      weekGroups.push({ key: `W${i + 1}`, label: `${ws.getUTCDate()} ${MONTHS[ws.getUTCMonth()]}`, dates: [d1, d2] });
      dates.push(d1, d2);
    }
    const daySet = new Set(dates);
    const cell = {};
    for (const r of rows) { const slot = collectionSlot(r.due_date, kind); if (daySet.has(slot)) cell[`${r.party}|${slot}`] = (cell[`${r.party}|${slot}`] || 0) + eff(r); }
    const colTot = Object.fromEntries(dates.map(d => [d, parties.reduce((s, p) => s + (cell[`${p}|${d}`] || 0), 0)]));
    const rowTot = Object.fromEntries(parties.map(p => [p, dates.reduce((s, d) => s + (cell[`${p}|${d}`] || 0), 0)]));
    const grand = dates.reduce((s, d) => s + colTot[d], 0);
    return { dates, parties, cell, colTot, rowTot, grand, weekGroups };
  }, [rows, kind]);

  const openAdd = () => { setEditing(null); setForm({ kind, party: '', due_date: '', planned: '', actual: '', status: 'planned', note: '', remark: '' }); setModal(true); };
  const openEdit = (r) => { setEditing(r); setForm({ ...r, planned: r.planned ?? '', actual: r.actual ?? '', remark: '' }); setModal(true); };

  // Client-side mirror of the server's rule so the user gets instant feedback.
  const amountOrDateChanged = () => editing && (
    (+form.planned || 0) !== (+editing.planned || 0) ||
    (form.actual === '' ? null : +form.actual) !== (editing.actual == null ? null : +editing.actual) ||
    form.due_date !== editing.due_date
  );

  const save = async (e) => {
    e.preventDefault();
    if (!form.party?.trim()) return toast.error('Party is required');
    if (!form.due_date) return toast.error('Date is required');
    if (editing && amountOrDateChanged() && (!form.remark || form.remark.trim().length < 3)) {
      return toast.error('Enter a remark (min 3 chars) to change an amount or date.');
    }
    try {
      if (editing) await api.put(`/ar-ap-tracker/${editing.id}`, form);
      else await api.post('/ar-ap-tracker', form);
      toast.success(editing ? 'Updated' : 'Added');
      setModal(false); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const del = async (r) => {
    const remark = window.prompt(`Delete ${r.kind} · ${r.party} · ${fmtCol(r.due_date)} (₹${fmtL(eff(r))}L)?\n\nEnter a reason (required):`);
    if (remark == null) return;
    if (remark.trim().length < 3) return toast.error('A reason (min 3 chars) is required to delete.');
    try { await api.delete(`/ar-ap-tracker/${r.id}`, { data: { remark: remark.trim() } }); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Upload the Cash-Flow workbook — server parses both sheets, matches AR
  // parties to Business Book clients and AP parties to Vendors, and upserts.
  const doImport = async (file) => {
    if (!file) return;
    setImporting(true);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await api.post('/ar-ap-tracker/import', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setImportResult(r.data);
      toast.success(`Imported ${r.data.imported} new · ${r.data.updated} updated · ${r.data.matched}/${r.data.total} matched`);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Import failed'); }
    finally { setImporting(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  // Bulk add — send the filled rows (party + date + amount) to the same
  // matching/upsert as the Excel import, via the /bulk endpoint's text form.
  const doBulk = async () => {
    const valid = bulkRows.filter(r => r.party?.trim() && r.due_date && +r.planned > 0);
    if (!valid.length) return toast.error('Fill at least one row (party, date, amount)');
    const text = valid.map(r => `${r.party.trim()}, ${r.due_date}, ${r.planned}`).join('\n');
    setBulkBusy(true);
    try {
      const r = await api.post('/ar-ap-tracker/bulk', { kind, text });
      setBulkOpen(false); setImportResult(r.data);
      toast.success(`Added ${r.data.imported} · updated ${r.data.updated}`);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Bulk add failed'); }
    finally { setBulkBusy(false); }
  };

  // Roll unpaid, overdue AR entries onto the next collection day (Mon/Thu) now.
  const doRollOverdue = async () => {
    try {
      const r = await api.post('/ar-ap-tracker/roll-forward');
      toast.success(r.data.rolled ? `${r.data.rolled} overdue entr${r.data.rolled === 1 ? 'y' : 'ies'} rolled to the next collection day` : 'Nothing overdue to roll');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const exportLog = () => exportCsv('arap-change-log',
    ['When (IST)', 'User', 'Kind', 'Party', 'Field', 'Old', 'New', 'Remark'],
    log.map(l => [fmtDateTime(l.changed_at), l.changed_by_name, l.kind, l.party, l.field, l.old_value, l.new_value, l.remark]));

  const TABS = [
    { k: 'ar', label: 'Receivables (AR)', icon: FiTrendingUp },
    { k: 'ap', label: 'Payables (AP)', icon: FiTrendingDown },
    { k: 'summary', label: 'Summary', icon: FiBarChart2 },
    { k: 'log', label: 'Change Log', icon: FiClock },
  ];

  return (
    <div className="space-y-5">
      {/* Shared party suggestions — top-level so both the Add and Bulk modals
          can use it. AR = clients; AP = vendors + clients combined. */}
      <datalist id="arapPartyDL">
        {partyList.map(n => <option key={n} value={n} />)}
      </datalist>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FiBarChart2 className="text-blue-700" /> AR / AP Tracker</h1>
          <p className="text-sm text-gray-500">Rolling weekly cash-flow forecast · amounts in ₹ Lakhs · every amount/date edit needs a remark</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {canCreate('ar_ap_tracker') && (
            <>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={e => doImport(e.target.files?.[0])} />
              <button onClick={() => fileRef.current?.click()} disabled={importing} className="btn btn-secondary flex items-center gap-2" title="Upload the Cash-Flow Excel — AR matched to Business Book clients, AP to Vendors">
                <FiUpload /> {importing ? 'Importing…' : 'Import Excel'}
              </button>
            </>
          )}
          {(tab === 'ar' || tab === 'ap') && canEdit('ar_ap_tracker') && (
            <button onClick={doRollOverdue} className="btn btn-secondary flex items-center gap-2" title="Move unsettled, overdue entries to the next collection day (AR: Mon→Thu/Thu→Mon · AP: Tue→Fri/Fri→Tue)"><FiClock /> Roll overdue</button>
          )}
          {(tab === 'ar' || tab === 'ap') && canCreate('ar_ap_tracker') && (
            <button onClick={openBulk} className="btn btn-secondary flex items-center gap-2" title="Add many rows at once"><FiClipboard /> Bulk {kind}</button>
          )}
          {(tab === 'ar' || tab === 'ap') && canCreate('ar_ap_tracker') && (
            <button onClick={openAdd} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add {kind}</button>
          )}
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {TABS.map(t => (
          <button key={t.k} onClick={() => setTab(t.k)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 ${tab === t.k ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 border'}`}>
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {/* ── AR / AP : grid + list ──────────────────────────────── */}
      {(tab === 'ar' || tab === 'ap') && (
        <>
          <div className="card p-0 overflow-x-auto">
            <div className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase border-b">Forecast grid — party × week (₹L)</div>
            {pivot.parties.length === 0 ? (
              <div className="text-center py-8 text-gray-400 text-sm">No {kind} entries yet. Click “Add {kind}”.</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50">
                    <th rowSpan={2} className="text-left px-3 py-2 sticky left-0 bg-gray-50 align-bottom">Site / Party</th>
                    {pivot.weekGroups.map((g, i) => (
                      <th key={g.key} colSpan={g.dates.length} className="px-2 py-1 text-center border-l border-gray-200">
                        <div className="text-[9px] font-bold text-blue-600 leading-none">Week {i + 1}</div>
                        <div className="text-[10px] font-semibold">{g.label}</div>
                      </th>
                    ))}
                    <th rowSpan={2} className="px-3 py-2 text-right font-bold align-bottom">Total</th>
                  </tr>
                  <tr className="bg-gray-50">
                    {pivot.dates.map((d, i) => (
                      <th key={d} className={`px-2 py-1 text-right text-[10px] font-medium text-gray-500 whitespace-nowrap ${pivot.weekGroups.some(g => g.dates[0] === d) && i > 0 ? 'border-l border-gray-200' : ''}`}>{fmtDay(d)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pivot.parties.map(p => (
                    <tr key={p} className="border-t hover:bg-blue-50/40">
                      <td className="px-3 py-1.5 font-medium sticky left-0 bg-white">{p}</td>
                      {pivot.dates.map((d, i) => <td key={d} className={`px-2 py-1.5 text-right text-gray-700 ${pivot.weekGroups.some(g => g.dates[0] === d) && i > 0 ? 'border-l border-gray-100' : ''}`}>{pivot.cell[`${p}|${d}`] ? fmtL(pivot.cell[`${p}|${d}`]) : <span className="text-gray-300">·</span>}</td>)}
                      <td className="px-3 py-1.5 text-right font-bold">{fmtL(pivot.rowTot[p])}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 bg-gray-50 font-bold">
                    <td className="px-3 py-2 sticky left-0 bg-gray-50">Total</td>
                    {pivot.dates.map((d, i) => <td key={d} className={`px-2 py-2 text-right ${pivot.weekGroups.some(g => g.dates[0] === d) && i > 0 ? 'border-l border-gray-200' : ''}`}>{fmtL(pivot.colTot[d])}</td>)}
                    <td className="px-3 py-2 text-right text-blue-700">{fmtL(pivot.grand)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>

          <div className="card p-0 overflow-x-auto">
            <div className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase border-b">Entries</div>
            <table className="w-full text-sm">
              <thead><tr className="bg-gray-50 text-xs text-gray-500 uppercase">
                <th className="text-left px-3 py-2">Party</th><th className="text-left px-3 py-2">Week</th>
                <th className="text-right px-3 py-2">Planned</th><th className="text-right px-3 py-2">Actual</th>
                <th className="text-left px-3 py-2">Status</th><th className="text-left px-3 py-2">Note</th><th className="px-3 py-2"></th>
              </tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan="7" className="text-center py-6 text-gray-400">No entries.</td></tr>}
                {rows.map(r => (
                  <tr key={r.id} className="border-t hover:bg-gray-50">
                    <td className="px-3 py-2 font-medium">{r.party}</td>
                    <td className="px-3 py-2">{fmtCol(r.due_date)}</td>
                    <td className="px-3 py-2 text-right">{fmtL(r.planned)}</td>
                    <td className="px-3 py-2 text-right">{r.actual == null || r.actual === '' ? <span className="text-gray-300">—</span> : <b className="text-emerald-700">{fmtL(r.actual)}</b>}</td>
                    <td className="px-3 py-2"><span className="text-[11px] px-2 py-0.5 rounded bg-gray-100">{r.status}</span></td>
                    <td className="px-3 py-2 text-gray-500 text-xs max-w-[180px] truncate" title={r.note || ''}>{r.note}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {canEdit('ar_ap_tracker') && <button onClick={() => openEdit(r)} className="p-1.5 text-amber-600 hover:bg-amber-50 rounded" title="Edit"><FiEdit2 size={14} /></button>}
                      {canDelete('ar_ap_tracker') && <button onClick={() => del(r)} className="p-1.5 text-red-600 hover:bg-red-50 rounded" title="Delete"><FiTrash2 size={14} /></button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── Summary : per-week AR / AP / net / running balance ──── */}
      {tab === 'summary' && (
        <div className="space-y-4">
          {/* Cash-cycle alert — surfaces where the running balance dips below
              zero (cash shortfall) so it's visible above the table. */}
          {summary.rows.length > 0 && (() => {
            const rows = summary.rows;
            const neg = rows.filter(r => r.balance < 0);
            const low = rows.reduce((m, r) => (m == null || r.balance < m.balance ? r : m), null);
            const showBal = (b) => (b < 0 ? '(' + fmtL(-b) + ')' : fmtL(b));
            return (
              <div className={`card p-4 border-l-4 ${neg.length ? 'border-red-500 bg-red-50' : 'border-emerald-500 bg-emerald-50'}`}>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  {neg.length
                    ? <div className="font-bold text-sm text-red-700">⚠ Running balance goes NEGATIVE on {neg.length} day{neg.length > 1 ? 's' : ''} — cash shortfall</div>
                    : <div className="font-bold text-sm text-emerald-700">✓ Cash stays positive across the whole cycle</div>}
                  {low && <div className="text-xs text-gray-600">Lowest point: <b className={low.balance < 0 ? 'text-red-700' : 'text-emerald-700'}>₹ {showBal(low.balance)} L</b> on <b>{fmtCol(low.date)}</b></div>}
                </div>
                {neg.length > 0 && (
                  <div className="mt-2 flex gap-1.5 flex-wrap">
                    {neg.map(r => (
                      <span key={r.date} className="text-[11px] font-semibold px-2 py-0.5 rounded bg-white border border-red-200 text-red-700 whitespace-nowrap">
                        {fmtCol(r.date)}: ₹ ({fmtL(-r.balance)}) L
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
          <div className="card p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="bg-gray-50 text-xs text-gray-500 uppercase">
              <th className="text-left px-4 py-2">Week</th><th className="text-right px-4 py-2">AR (in)</th>
              <th className="text-right px-4 py-2">AP (out)</th><th className="text-right px-4 py-2">Net</th>
              <th className="text-right px-4 py-2">Running balance</th>
            </tr></thead>
            <tbody>
              {summary.rows.length === 0 && <tr><td colSpan="5" className="text-center py-6 text-gray-400">No data yet.</td></tr>}
              {summary.rows.map(d => (
                <tr key={d.date} className="border-t">
                  <td className="px-4 py-2 font-medium">{fmtCol(d.date)}</td>
                  <td className="px-4 py-2 text-right text-emerald-700">{fmtL(d.ar)}</td>
                  <td className="px-4 py-2 text-right text-red-600">{fmtL(d.ap)}</td>
                  <td className={`px-4 py-2 text-right font-semibold ${d.net < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{d.net < 0 ? '(' + fmtL(-d.net) + ')' : fmtL(d.net)}</td>
                  <td className={`px-4 py-2 text-right font-bold ${d.balance < 0 ? 'text-red-700' : 'text-blue-700'}`}>{d.balance < 0 ? '(' + fmtL(-d.balance) + ')' : fmtL(d.balance)}</td>
                </tr>
              ))}
              {summary.rows.length > 0 && (
                <tr className="border-t-2 bg-gray-50 font-bold">
                  <td className="px-4 py-2">Total</td>
                  <td className="px-4 py-2 text-right text-emerald-700">{fmtL(summary.totals.ar)}</td>
                  <td className="px-4 py-2 text-right text-red-600">{fmtL(summary.totals.ap)}</td>
                  <td className="px-4 py-2 text-right">{fmtL(summary.totals.net)}</td>
                  <td className="px-4 py-2"></td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* ── Change Log : searchable + CSV export ───────────────── */}
      {tab === 'log' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <input className="input max-w-xs" placeholder="Search party / remark / user…" value={logSearch} onChange={e => setLogSearch(e.target.value)} />
            <button onClick={exportLog} className="btn flex items-center gap-2 border"><FiDownload size={14} /> Export CSV</button>
          </div>
          <div className="card p-0 overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="bg-gray-50 text-gray-500 uppercase">
                <th className="text-left px-3 py-2">When (IST)</th><th className="text-left px-3 py-2">User</th>
                <th className="text-left px-3 py-2">Kind</th><th className="text-left px-3 py-2">Party</th>
                <th className="text-left px-3 py-2">Field</th><th className="text-left px-3 py-2">Change</th>
                <th className="text-left px-3 py-2">Remark</th>
              </tr></thead>
              <tbody>
                {log.length === 0 && <tr><td colSpan="7" className="text-center py-6 text-gray-400">No changes logged.</td></tr>}
                {log.map(l => (
                  <tr key={l.id} className="border-t">
                    <td className="px-3 py-2 whitespace-nowrap text-gray-500">{fmtDateTime(l.changed_at)}</td>
                    <td className="px-3 py-2">{l.changed_by_name}</td>
                    <td className="px-3 py-2">{l.kind}</td>
                    <td className="px-3 py-2 font-medium">{l.party}</td>
                    <td className="px-3 py-2">{l.field}</td>
                    <td className="px-3 py-2 whitespace-nowrap"><span className="text-red-500 line-through">{l.old_value || '∅'}</span> → <span className="text-emerald-700 font-semibold">{l.new_value || '∅'}</span></td>
                    <td className="px-3 py-2 text-gray-700">{l.remark}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Add / Edit modal ───────────────────────────────────── */}
      <Modal isOpen={modal} onClose={() => setModal(false)} title={editing ? `Edit ${kind} entry` : `Add ${kind} entry`}>
        <form onSubmit={save} className="space-y-3">
          <div>
            <label className="label">{kind === 'AR' ? 'Client / Site' : 'Vendor / Party'} * <span className="text-gray-400 font-normal normal-case">(pick from {kind === 'AR' ? 'Business Book' : 'Vendors or clients'}, or type)</span></label>
            <input className="input" list="arapPartyDL" value={form.party || ''} onChange={e => setForm({ ...form, party: e.target.value })}
              placeholder={kind === 'AR' ? 'Search Business Book clients…' : 'Search Vendors…'} required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Week / Date *</label><input type="date" className="input" value={form.due_date || ''} onChange={e => setForm({ ...form, due_date: e.target.value })} required /></div>
            <div><label className="label">Status</label><select className="select" value={form.status || 'planned'} onChange={e => setForm({ ...form, status: e.target.value })}>{STATUSES.map(s => <option key={s}>{s}</option>)}</select></div>
            <div><label className="label">Planned (₹L)</label><input type="number" step="0.01" className="input" value={form.planned ?? ''} onChange={e => setForm({ ...form, planned: e.target.value })} /></div>
            <div><label className="label">Actual (₹L)</label><input type="number" step="0.01" className="input" value={form.actual ?? ''} onChange={e => setForm({ ...form, actual: e.target.value })} placeholder="once realised" /></div>
          </div>
          <div><label className="label">Note</label><input className="input" value={form.note || ''} onChange={e => setForm({ ...form, note: e.target.value })} /></div>
          {editing && (
            <div>
              <label className="label">Remark {amountOrDateChanged() ? <span className="text-red-600">* required (amount/date changed)</span> : <span className="text-gray-400 font-normal normal-case">(logged with this change)</span>}</label>
              <textarea className="input" rows="2" value={form.remark || ''} onChange={e => setForm({ ...form, remark: e.target.value })} placeholder="Why is this changing?" />
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button type="submit" className="btn btn-primary flex-1">{editing ? 'Save changes' : 'Add entry'}</button>
            <button type="button" onClick={() => setModal(false)} className="btn border">Cancel</button>
          </div>
        </form>
      </Modal>

      {/* ── Bulk add (row grid) ────────────────────────────────── */}
      <Modal isOpen={bulkOpen} onClose={() => setBulkOpen(false)} title={`Bulk add ${kind} entries`} wide>
        <div className="space-y-3 text-sm">
          <p className="text-gray-600">Pick the {kind === 'AR' ? 'Business Book client' : 'Vendor'}, the date, and the planned ₹L for each row. Empty rows are ignored.</p>
          {/* Quick paste — drop a block of "party, date, amount" lines and load them into the grid. */}
          <details className="rounded border bg-gray-50">
            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-blue-700">⬇ Paste a list (party, date, amount per line)</summary>
            <div className="p-3 space-y-2">
              <textarea className="input font-mono text-xs" rows="5" value={bulkPaste} onChange={e => setBulkPaste(e.target.value)}
                placeholder={`SBJ, 17-06, 15\nsael, 24-06, 8.44\njmh PI, 17-06, 40`} />
              <button onClick={loadPaste} className="btn btn-secondary text-xs">Load into rows ↓</button>
            </div>
          </details>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-xs text-gray-500 uppercase">
                <th className="text-left px-2 py-1 w-10">#</th>
                <th className="text-left px-2 py-1">{kind === 'AR' ? 'Client / Site' : 'Vendor / Party'}</th>
                <th className="text-left px-2 py-1 w-40">Date</th>
                <th className="text-left px-2 py-1 w-28">Planned (₹L)</th>
                <th className="w-8"></th>
              </tr></thead>
              <tbody>
                {bulkRows.map((r, i) => (
                  <tr key={i}>
                    <td className="px-2 py-1 text-gray-400">{i + 1}</td>
                    <td className="px-2 py-1"><input className="input" list="arapPartyDL" value={r.party} onChange={e => setBulkCell(i, 'party', e.target.value)} placeholder={kind === 'AR' ? 'Search clients…' : 'Search vendors…'} /></td>
                    <td className="px-2 py-1"><input className="input" type="date" value={r.due_date} onChange={e => setBulkCell(i, 'due_date', e.target.value)} /></td>
                    <td className="px-2 py-1"><input className="input" type="number" step="0.01" value={r.planned} onChange={e => setBulkCell(i, 'planned', e.target.value)} /></td>
                    <td className="px-2 py-1 text-center">{bulkRows.length > 1 && <button onClick={() => setBulkRows(rs => rs.filter((_, j) => j !== i))} className="text-red-500 hover:bg-red-50 rounded p-1"><FiTrash2 size={14} /></button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button onClick={() => setBulkRows(rs => [...rs, blankBulkRow()])} className="text-xs text-blue-700 font-semibold flex items-center gap-1"><FiPlus size={13} /> Add row</button>
          <div className="flex gap-2 pt-1">
            <button onClick={doBulk} disabled={bulkBusy} className="btn btn-primary flex-1">{bulkBusy ? 'Adding…' : `Add ${kind} rows`}</button>
            <button onClick={() => setBulkOpen(false)} className="btn border">Cancel</button>
          </div>
        </div>
      </Modal>

      {/* ── Import result ──────────────────────────────────────── */}
      <Modal isOpen={!!importResult} onClose={() => setImportResult(null)} title="Import result">
        {importResult && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-emerald-50 rounded p-2 text-center"><div className="text-lg font-bold text-emerald-700">{importResult.imported}</div><div className="text-[11px] text-gray-500">New</div></div>
              <div className="bg-blue-50 rounded p-2 text-center"><div className="text-lg font-bold text-blue-700">{importResult.updated}</div><div className="text-[11px] text-gray-500">Updated</div></div>
              <div className="bg-amber-50 rounded p-2 text-center"><div className="text-lg font-bold text-amber-700">{importResult.matched}/{importResult.total}</div><div className="text-[11px] text-gray-500">Name-matched</div></div>
            </div>
            <div className="text-xs text-gray-500">AR rows: {importResult.byKind?.AR ?? 0} · AP rows: {importResult.byKind?.AP ?? 0}</div>
            {importResult.unmatched?.length > 0 ? (
              <div>
                <div className="font-semibold text-amber-700 mb-1">Not matched to a Business Book client / Vendor ({importResult.unmatched.length}):</div>
                <div className="max-h-48 overflow-y-auto border rounded p-2 bg-amber-50/40 text-xs space-y-0.5">
                  {importResult.unmatched.map((u, i) => <div key={i}>• {u}</div>)}
                </div>
                <p className="text-[11px] text-gray-500 mt-1">Imported under the sheet's own name. Add these to Business Book / Vendors (or rename to match) and re-import to link them.</p>
              </div>
            ) : <div className="text-emerald-700 text-xs">✓ Every party matched a client / vendor.</div>}
          </div>
        )}
      </Modal>
    </div>
  );
}
