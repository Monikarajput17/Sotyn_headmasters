// Engineer Performance — extracted from DPR.jsx (mam 2026-05-30:
// "Performance is in under HRMS").  Same component the old
// "Engineer Compliance" tab used, now mounted from HRSystem.jsx
// instead.  Backend endpoint unchanged: GET /dpr/engineer-compliance.
//
// Adds Avg Manpower (= total manpower / DPRs filed) under each
// engineer's headline Manpower stat — mam's example: Gurcharan
// 60 manpower / 5 DPRs = 12 avg.
//
// Public surface: <EngineerPerformance /> — no props, fully
// self-contained including filter strip, tiles, cards, and the
// per-site drill-down modal.

import { useState, useEffect } from 'react';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';
import { FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';

export const fmtINR = (n) => {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1e7) return `${v < 0 ? '-' : ''}₹${(Math.abs(v) / 1e7).toFixed(2)} cr`;
  if (Math.abs(v) >= 1e5) return `${v < 0 ? '-' : ''}₹${(Math.abs(v) / 1e5).toFixed(2)} L`;
  if (Math.abs(v) >= 1e3) return `${v < 0 ? '-' : ''}₹${(Math.abs(v) / 1e3).toFixed(1)} K`;
  return `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
};

// Mam's example: 60 total / 5 DPRs → 12 avg.  When DPR count is
// zero we return 0 (no meaningful average to show).
const avgManpower = (total, dprs) => (dprs > 0 ? Math.round((Number(total) || 0) / dprs) : 0);

export default function EngineerPerformance() {
  // Default range = last 30 days inclusive of today.
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 29);
    return d.toISOString().slice(0, 10);
  });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [search, setSearch] = useState('');
  const [data, setData] = useState({ engineers: [], totals: {}, range: {} });
  const [loading, setLoading] = useState(false);

  // Which engineer cards are expanded (engineer_id → bool).  We let
  // mam expand multiple at once because she often compares engineers
  // side-by-side during reviews.
  const [openEng, setOpenEng] = useState({});

  // Site drill-down modal — null = closed; { siteId, siteName, engineerName } open.
  const [siteModal, setSiteModal] = useState(null);

  const load = () => {
    setLoading(true);
    api.get('/dpr/engineer-compliance', { params: { date_from: dateFrom, date_to: dateTo } })
      .then(r => setData(r.data || { engineers: [], totals: {}, range: {} }))
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  };
  useEffect(load, [dateFrom, dateTo]);

  // Search filter — keeps an engineer if her name OR any of her
  // sites / clients match.  Engineer with no sites still matches by name.
  const filtered = (data.engineers || []).filter(e => {
    if (!search) return true;
    const s = search.toLowerCase();
    if ((e.engineer_name || '').toLowerCase().includes(s)) return true;
    return e.sites.some(st =>
      (st.site_name || '').toLowerCase().includes(s)
      || (st.client_name || '').toLowerCase().includes(s));
  });

  // CSV export — one row per (engineer, site).  Mam (2026-05-30):
  // "not need 60 total only avg manpower" — only the per-DPR average
  // ships in the spreadsheet now.
  const exportRows = () => {
    const rows = [];
    filtered.forEach(e => {
      const avg = avgManpower(e.manpower_total, e.days_dpr_filled_total);
      if (e.sites.length === 0) {
        rows.push({
          Engineer: e.engineer_name, Site: '(no sites assigned)', Client: '',
          'Days Present': 0, 'DPR Filled': 0, Gap: 0,
          'Avg Manpower / DPR': avg,
          'Profit/Loss': 0,
        });
      } else {
        e.sites.forEach(s => rows.push({
          Engineer: e.engineer_name, Site: s.site_name, Client: s.client_name || '',
          'Days Present': s.days_present, 'DPR Filled': s.days_dpr_filled, Gap: s.gap,
          'Avg Manpower / DPR (engineer)': avg,
          'Profit/Loss': s.profit_loss,
        }));
      }
    });
    exportCsv(`engineer-performance-${dateFrom}-to-${dateTo}.csv`, rows);
  };

  const setQuickRange = (days) => {
    const to = new Date();
    const from = new Date(); from.setDate(from.getDate() - (days - 1));
    setDateFrom(from.toISOString().slice(0, 10));
    setDateTo(to.toISOString().slice(0, 10));
  };

  const toggleEng = (id) => setOpenEng(prev => ({ ...prev, [id]: !prev[id] }));

  // Overall avg manpower for the tile row.
  const overallAvgMp = avgManpower(data.totals?.manpower || 0, data.totals?.days_dpr_filled || 0);

  return (
    <div className="space-y-4">
      {/* Filter strip */}
      <div className="card p-3">
        <div className="flex gap-3 flex-wrap items-end">
          <div>
            <label className="text-xs text-gray-600 block mb-1">From</label>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              className="border rounded px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-600 block mb-1">To</label>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              className="border rounded px-2 py-1.5 text-sm" />
          </div>
          <div className="flex gap-1">
            <button onClick={() => setQuickRange(7)}   className="btn btn-secondary text-xs px-2 py-1.5">7d</button>
            <button onClick={() => setQuickRange(30)}  className="btn btn-secondary text-xs px-2 py-1.5">30d</button>
            <button onClick={() => setQuickRange(90)}  className="btn btn-secondary text-xs px-2 py-1.5">90d</button>
            <button onClick={() => setQuickRange(180)} className="btn btn-secondary text-xs px-2 py-1.5">6m</button>
            <button onClick={() => setQuickRange(365)} className="btn btn-secondary text-xs px-2 py-1.5">1y</button>
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="text-xs text-gray-600 block mb-1">Search engineer / site / client</label>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="e.g. Manoj, Hero, HVAC…"
              className="border rounded px-2 py-1.5 text-sm w-full" />
          </div>
          <button onClick={exportRows} disabled={!filtered.length}
            className="btn btn-secondary flex items-center gap-1.5"><FiDownload /> Export CSV</button>
          <button onClick={load} className="btn btn-primary">Refresh</button>
        </div>
        <div className="text-[11px] text-gray-500 mt-2">
          Window: <strong>{data.range?.date_from || dateFrom}</strong> → <strong>{data.range?.date_to || dateTo}</strong> ({data.range?.calendar_days || 0} days).
          Click any engineer card to see her sites · click a site tile to drill into the DPRs + Profit/Loss for that range.
        </div>
      </div>

      {/* Roll-up tiles — 6 tiles: engineers, sites, present, DPRs,
          manpower (with avg subtitle), P&L. */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <div className="card text-center border-l-4 border-blue-500 py-2">
          <div className="text-2xl font-bold text-blue-600">{data.totals?.engineers || 0}</div>
          <div className="text-xs text-gray-500">Site Engineers</div>
          {data.totals?.engineer_breakdown && (
            <div className="text-[10px] text-gray-400 mt-0.5">
              {data.totals.engineer_breakdown.se} Site · {data.totals.engineer_breakdown.jr} Jr
            </div>
          )}
        </div>
        <div className="card text-center border-l-4 border-teal-500 py-2">
          <div className="text-2xl font-bold text-teal-600">{data.totals?.sites || 0}</div>
          <div className="text-xs text-gray-500">Active Sites</div>
        </div>
        <div className="card text-center border-l-4 border-emerald-500 py-2">
          <div className="text-2xl font-bold text-emerald-600">{data.totals?.days_present || 0}</div>
          <div className="text-xs text-gray-500">Days Present</div>
        </div>
        <div className="card text-center border-l-4 border-indigo-500 py-2">
          <div className="text-2xl font-bold text-indigo-600">{data.totals?.days_dpr_filled || 0}</div>
          <div className="text-xs text-gray-500">DPRs Filed</div>
        </div>
        {/* Mam (2026-05-30): "not need 60 total only avg manpower" —
            drop the big total, lead with the avg / DPR figure. */}
        <div className="card text-center border-l-4 border-amber-500 py-2"
             title="Avg manpower per DPR = total manpower (contractor + skilled + helper) ÷ DPRs filed in range.">
          <div className="text-2xl font-bold text-amber-600">{overallAvgMp}</div>
          <div className="text-xs text-gray-500">Avg Manpower / DPR</div>
        </div>
        <div className={`card text-center border-l-4 ${(data.totals?.profit_loss || 0) >= 0 ? 'border-emerald-500' : 'border-red-500'} py-2`}>
          <div className={`text-xl font-bold ${(data.totals?.profit_loss || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            {fmtINR(data.totals?.profit_loss || 0)}
          </div>
          <div className="text-xs text-gray-500">Net Profit / Loss</div>
        </div>
      </div>

      {/* Engineer cards grid */}
      {loading && <div className="text-center py-6 text-gray-400 text-sm">Loading engineers…</div>}
      {!loading && filtered.length === 0 && (
        <div className="card text-center py-8 text-gray-400">No engineers match your search.</div>
      )}
      {!loading && filtered.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(eng => {
            const isOpen = !!openEng[eng.engineer_id];
            const pnl = eng.profit_loss_total || 0;
            const avgMp = avgManpower(eng.manpower_total, eng.days_dpr_filled_total);
            return (
              <div key={eng.engineer_id}
                className={`card p-0 overflow-hidden border-l-4 ${eng.gap_total > 0 ? 'border-red-500' : (eng.sites.length === 0 ? 'border-gray-300' : 'border-emerald-500')}`}>
                {/* Card header — click to expand */}
                <button onClick={() => toggleEng(eng.engineer_id)}
                  className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-sm truncate flex items-center gap-1.5">
                      {eng.engineer_name}
                      {eng.engineer_role_display && (
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-semibold shrink-0 ${eng.engineer_role === 'jr' ? 'bg-violet-100 text-violet-700' : eng.engineer_role === 'fm' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>
                          {eng.engineer_role_display}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-gray-500 truncate">{eng.engineer_email}</div>
                  </div>
                  <span className="text-xs text-gray-400">{isOpen ? '▴' : '▾'}</span>
                </button>
                {/* Stat strip — 5 columns: sites / present / dpr / gap / manpower.
                    Manpower now shows total + avg-per-DPR subtitle. */}
                <div className="grid grid-cols-5 gap-1 px-3 pb-2 text-center">
                  <div>
                    <div className="text-lg font-bold text-teal-600">{eng.sites.length}</div>
                    <div className="text-[10px] text-gray-500 uppercase">Sites</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold text-emerald-600">{eng.days_present_total}</div>
                    <div className="text-[10px] text-gray-500 uppercase">Present</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold text-indigo-600">{eng.days_dpr_filled_total}</div>
                    <div className="text-[10px] text-gray-500 uppercase">DPR</div>
                  </div>
                  <div>
                    <div className={`text-lg font-bold ${eng.gap_total > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{eng.gap_total}</div>
                    <div className="text-[10px] text-gray-500 uppercase">Gap</div>
                  </div>
                  {/* Mam (2026-05-30): show ONLY avg manpower per DPR,
                      drop the total.  Tooltip still spells out the math
                      so the calculation is verifiable on hover. */}
                  <div title={`Total ${eng.manpower_total || 0} ÷ ${eng.days_dpr_filled_total || 0} DPRs = ${avgMp} avg`}>
                    <div className="text-lg font-bold text-amber-600">{avgMp}</div>
                    <div className="text-[10px] text-gray-500 uppercase">Avg MP</div>
                  </div>
                </div>
                {/* P&L band */}
                <div className={`px-3 py-1.5 text-xs flex justify-between ${pnl >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                  <span>Profit / Loss</span>
                  <strong>{fmtINR(pnl)}</strong>
                </div>

                {/* Expanded site mini-tiles */}
                {isOpen && (
                  <div className="border-t bg-gray-50 p-2 space-y-1.5">
                    {(eng.days_present_total > eng.days_present_per_site_sum
                      || eng.days_dpr_filled_total > eng.days_dpr_filled_per_site_sum) && (
                      <div className="text-[10px] text-gray-500 bg-white border-l-2 border-amber-400 px-2 py-1 rounded">
                        Headline shows engineer total. Sites below sum to {eng.days_present_per_site_sum} present / {eng.days_dpr_filled_per_site_sum} DPR — rest are attendance / DPRs we couldn't link to a specific site.
                      </div>
                    )}
                    {eng.sites.length === 0 && (
                      <div className="text-center py-3 text-gray-400 text-xs italic">No sites assigned yet</div>
                    )}
                    {eng.sites.map(s => (
                      <button key={s.site_id}
                        onClick={() => setSiteModal({ siteId: s.site_id, siteName: s.site_name, engineerId: eng.engineer_id, engineerName: eng.engineer_name })}
                        className="w-full text-left bg-white rounded-lg px-2.5 py-2 border hover:border-blue-400 hover:shadow-sm transition-all">
                        <div className="flex justify-between items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold text-xs truncate">{s.site_name}</div>
                            <div className="text-[10px] text-gray-500 truncate">{s.client_name || '—'}</div>
                          </div>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold whitespace-nowrap ${
                            s.days_present === 0 ? 'bg-gray-100 text-gray-600'
                              : s.gap === 0 ? 'bg-emerald-100 text-emerald-700'
                              : s.days_dpr_filled === 0 ? 'bg-red-100 text-red-700'
                              : 'bg-amber-100 text-amber-700'}`}>
                            {s.days_present === 0 ? 'no attendance'
                              : s.gap === 0 ? 'on track'
                              : s.days_dpr_filled === 0 ? 'no DPR'
                              : `${s.gap} missing`}
                          </span>
                        </div>
                        <div className="grid grid-cols-4 gap-1 mt-1.5 text-center">
                          <div>
                            <div className="text-xs font-bold text-emerald-700">{s.days_present}</div>
                            <div className="text-[9px] text-gray-500">PRESENT</div>
                          </div>
                          <div>
                            <div className="text-xs font-bold text-indigo-700">{s.days_dpr_filled}</div>
                            <div className="text-[9px] text-gray-500">DPR</div>
                          </div>
                          <div>
                            <div className={`text-xs font-bold ${s.gap > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{s.gap}</div>
                            <div className="text-[9px] text-gray-500">GAP</div>
                          </div>
                          <div>
                            <div className={`text-xs font-bold ${s.profit_loss >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>{fmtINR(s.profit_loss)}</div>
                            <div className="text-[9px] text-gray-500">P&L</div>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Site drill-down modal */}
      {siteModal && (
        <SiteDprHistoryModal
          siteId={siteModal.siteId}
          siteName={siteModal.siteName}
          engineerId={siteModal.engineerId}
          engineerName={siteModal.engineerName}
          dateFrom={dateFrom}
          dateTo={dateTo}
          onClose={() => setSiteModal(null)}
        />
      )}
    </div>
  );
}

// SiteDprHistoryModal — extracted as well so it stays paired with
// the parent component.  Pulls every DPR for one site_id (with
// same-name siblings folded in via include_siblings=1) in the
// chosen date range, filtered to this engineer's submissions.
function SiteDprHistoryModal({ siteId, siteName, engineerId, engineerName, dateFrom, dateTo, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.get('/dpr', { params: {
      site_id: siteId, date_from: dateFrom, date_to: dateTo,
      include_siblings: 1, submitted_by: engineerId,
    } })
      .then(r => setRows(Array.isArray(r.data) ? r.data : []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [siteId, engineerId, dateFrom, dateTo]);

  const sorted = [...rows].sort((a, b) => (b.report_date || '').localeCompare(a.report_date || ''));
  const totals = sorted.reduce((acc, r) => {
    acc.a += Number(r.grand_total_a || 0);
    acc.b += Number(r.grand_total_b || 0);
    acc.pl += Number(r.profit_loss || 0);
    return acc;
  }, { a: 0, b: 0, pl: 0 });

  const statusPill = (s) => {
    const cls = s === 'approved' ? 'bg-emerald-100 text-emerald-700'
              : s === 'rejected' ? 'bg-red-100 text-red-700'
              : 'bg-amber-100 text-amber-700';
    return <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${cls}`}>{s || 'pending'}</span>;
  };

  return (
    <Modal isOpen={true} onClose={onClose} title={`${siteName} — DPR history`} wide>
      <div className="space-y-3">
        <div className="text-xs text-gray-500">
          Showing DPRs <strong>filed by {engineerName || '—'}</strong> at this site · Window: <strong>{dateFrom}</strong> → <strong>{dateTo}</strong>
        </div>
        <div className="overflow-x-auto border rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-3 py-2">Date</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-right px-3 py-2">A Total</th>
                <th className="text-right px-3 py-2">B Total</th>
                <th className="text-right px-3 py-2">Profit / Loss</th>
                <th className="text-left px-3 py-2">Submitted By</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={6} className="text-center py-6 text-gray-400">Loading…</td></tr>}
              {!loading && sorted.length === 0 && (
                <tr><td colSpan={6} className="text-center py-6 text-gray-400">No DPRs filed for this site in the chosen range.</td></tr>
              )}
              {!loading && sorted.map(r => (
                <tr key={r.id} className="border-t">
                  <td className="px-3 py-1.5 font-medium">{r.report_date}</td>
                  <td className="px-3 py-1.5">{statusPill(r.approval_status)}</td>
                  <td className="px-3 py-1.5 text-right">{fmtINR(r.grand_total_a)}</td>
                  <td className="px-3 py-1.5 text-right">{fmtINR(r.grand_total_b)}</td>
                  <td className={`px-3 py-1.5 text-right font-bold ${Number(r.profit_loss || 0) >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                    {fmtINR(r.profit_loss)}
                  </td>
                  <td className="px-3 py-1.5 text-gray-600 text-xs">{r.submitted_by_name || '—'}</td>
                </tr>
              ))}
            </tbody>
            {!loading && sorted.length > 0 && (
              <tfoot className="bg-gray-50 border-t-2">
                <tr>
                  <td className="px-3 py-2 font-bold" colSpan={2}>Total ({sorted.length} DPR{sorted.length === 1 ? '' : 's'})</td>
                  <td className="px-3 py-2 text-right font-bold">{fmtINR(totals.a)}</td>
                  <td className="px-3 py-2 text-right font-bold">{fmtINR(totals.b)}</td>
                  <td className={`px-3 py-2 text-right font-extrabold text-base ${totals.pl >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                    {fmtINR(totals.pl)}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <div className="flex justify-end">
          <button onClick={onClose} className="btn btn-secondary">Close</button>
        </div>
      </div>
    </Modal>
  );
}
