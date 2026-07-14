// Admin Audit Log viewer — lists every mutating API action (create / update /
// delete) with filters for user, module, action, date range, and free-text
// search. Click a row to see the full body + optional before/after snapshot.
//
// Powered by /api/admin/audit (admin-only). Data lives in the audit_log
// table populated by server/middleware/audit.js.

import { useState, useEffect } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { FiShield, FiRefreshCw, FiSearch, FiFilter, FiEye, FiX, FiUser, FiCalendar } from 'react-icons/fi';
import { fmtDateTime } from '../../utils/datetime';

const ACTION_COLORS = {
  CREATE: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  UPDATE: 'bg-blue-100 text-blue-700 border-blue-200',
  DELETE: 'bg-red-100 text-red-700 border-red-200',
  LOGIN: 'bg-violet-100 text-violet-700 border-violet-200',
  LOGIN_FAIL: 'bg-red-100 text-red-700 border-red-200',
};
const actionClass = (a) => ACTION_COLORS[a] || 'bg-gray-100 text-gray-700 border-gray-200';
const statusClass = (s) => s >= 200 && s < 300 ? 'text-emerald-700' : s >= 400 ? 'text-red-700' : 'text-gray-500';

export default function AuditLog() {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({ users: [], entityTypes: [], actions: [] });
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [filters, setFilters] = useState({ user_id: '', entity_type: '', action: '', date_from: '', date_to: '', q: '' });
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page, limit });
      Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
      const r = await api.get(`/admin/audit?${params.toString()}`);
      setRows(r.data.rows || []);
      setTotal(r.data.total || 0);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load');
    }
    setLoading(false);
  };

  useEffect(() => {
    api.get('/admin/audit/meta').then(r => setMeta(r.data || {})).catch(() => {});
  }, []);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [page, filters]);

  const totalPages = Math.max(1, Math.ceil(total / limit));
  const resetFilters = () => { setFilters({ user_id: '', entity_type: '', action: '', date_from: '', date_to: '', q: '' }); setPage(1); };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h3 className="text-xl font-bold text-gray-800 flex items-center gap-2"><FiShield className="text-red-600" /> Audit Log</h3>
          <p className="text-sm text-gray-500">Every create / update / delete action across the Sotyn.Headmasters, with user and timestamp. Admin-only.</p>
        </div>
        <button onClick={load} disabled={loading} className="btn btn-secondary flex items-center gap-2">
          <FiRefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="card text-center"><p className="text-xs text-gray-500 uppercase">Total Entries</p><p className="text-xl font-bold">{total.toLocaleString()}</p></div>
        <div className="card text-center"><p className="text-xs text-gray-500 uppercase">Unique Users</p><p className="text-xl font-bold">{meta.users?.length || 0}</p></div>
        <div className="card text-center"><p className="text-xs text-gray-500 uppercase">Modules Logged</p><p className="text-xl font-bold">{meta.entityTypes?.length || 0}</p></div>
        <div className="card text-center"><p className="text-xs text-gray-500 uppercase">Action Types</p><p className="text-xl font-bold">{meta.actions?.length || 0}</p></div>
      </div>

      {/* Filters */}
      <div className="card space-y-2">
        <div className="flex items-center gap-2 text-xs font-bold text-gray-500 uppercase"><FiFilter size={12} /> Filters</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-sm">
          <div className="relative col-span-1 sm:col-span-2">
            <FiSearch size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input className="input pl-8" placeholder="Search path / body / label / user" value={filters.q} onChange={e => { setFilters({ ...filters, q: e.target.value }); setPage(1); }} />
          </div>
          <select className="select" value={filters.user_id} onChange={e => { setFilters({ ...filters, user_id: e.target.value }); setPage(1); }}>
            <option value="">All users</option>
            {(meta.users || []).map(u => <option key={u.user_id} value={u.user_id}>{u.user_name}</option>)}
          </select>
          <select className="select" value={filters.entity_type} onChange={e => { setFilters({ ...filters, entity_type: e.target.value }); setPage(1); }}>
            <option value="">All modules</option>
            {(meta.entityTypes || []).map(t => <option key={t}>{t}</option>)}
          </select>
          <select className="select" value={filters.action} onChange={e => { setFilters({ ...filters, action: e.target.value }); setPage(1); }}>
            <option value="">All actions</option>
            {(meta.actions || []).map(a => <option key={a}>{a}</option>)}
          </select>
          <div className="flex items-center gap-1 text-xs">
            <span className="text-gray-400">From</span>
            <input type="date" className="input py-1 text-xs" value={filters.date_from} onChange={e => { setFilters({ ...filters, date_from: e.target.value }); setPage(1); }} />
          </div>
          <div className="flex items-center gap-1 text-xs">
            <span className="text-gray-400">To</span>
            <input type="date" className="input py-1 text-xs" value={filters.date_to} onChange={e => { setFilters({ ...filters, date_to: e.target.value }); setPage(1); }} />
          </div>
          {Object.values(filters).some(Boolean) && (
            <button onClick={resetFilters} className="text-[11px] text-red-600 hover:underline sm:col-span-3">Clear all filters</button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="card p-0 overflow-x-auto">
        <table className="text-xs">
          <thead>
            <tr>
              <th className="px-2 py-2 text-left">When</th>
              <th className="px-2 py-2 text-left">User</th>
              <th className="px-2 py-2 text-left">Action</th>
              <th className="px-2 py-2 text-left">Module</th>
              <th className="px-2 py-2 text-left">Path</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2 text-left">IP</th>
              <th className="px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className="border-b hover:bg-gray-50 cursor-pointer" onClick={() => setSelected(r)}>
                {/* IST forced — the server stores UTC, but mam (2026-05-16):
                    "it showing wrong time" was seeing UTC because the
                    browser's local timezone was wrong. */}
                <td className="px-2 py-1.5 whitespace-nowrap">{fmtDateTime(r.at, { timeZone: 'Asia/Kolkata' })}</td>
                <td className="px-2 py-1.5 whitespace-nowrap"><FiUser className="inline mr-1 text-gray-400" size={11} />{r.user_name || <span className="text-gray-300">anon</span>}{r.user_role && <span className="text-[10px] text-gray-400 ml-1">[{r.user_role}]</span>}</td>
                <td className="px-2 py-1.5"><span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${actionClass(r.action)}`}>{r.action}</span></td>
                <td className="px-2 py-1.5 whitespace-nowrap">{r.entity_type || <span className="text-gray-300">—</span>}{r.entity_id ? <span className="text-gray-400 ml-1">#{r.entity_id}</span> : ''}</td>
                <td className="px-2 py-1.5 font-mono text-[10px] max-w-[260px] truncate" title={r.path}>{r.path}</td>
                <td className={`px-2 py-1.5 text-center font-semibold ${statusClass(r.status_code)}`}>{r.status_code || '—'}</td>
                <td className="px-2 py-1.5 text-[10px] text-gray-500">{r.ip || '—'}</td>
                <td className="px-2 py-1.5"><button className="text-red-600 hover:text-red-800" onClick={e => { e.stopPropagation(); setSelected(r); }}><FiEye size={14} /></button></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan="8" className="text-center text-gray-400 py-8">No audit entries match these filters.</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-between items-center text-xs text-gray-500">
          <span>Showing {(page - 1) * limit + 1}-{Math.min(page * limit, total)} of {total.toLocaleString()}</span>
          <div className="flex gap-1">
            <button disabled={page === 1} onClick={() => setPage(p => Math.max(1, p - 1))} className="btn btn-secondary text-xs disabled:opacity-40">‹ Prev</button>
            <span className="px-3 py-1.5">Page {page} / {totalPages}</span>
            <button disabled={page === totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))} className="btn btn-secondary text-xs disabled:opacity-40">Next ›</button>
          </div>
        </div>
      )}

      {/* Detail panel */}
      {selected && (
        <div className="fixed inset-0 bg-black/40 z-40 flex items-center justify-center p-4" onClick={() => setSelected(null)}>
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center p-4 border-b sticky top-0 bg-white">
              <div>
                <h4 className="font-bold text-lg">Audit Entry #{selected.id}</h4>
                <p className="text-xs text-gray-500"><FiCalendar className="inline mr-1" size={11} /> {fmtDateTime(selected.at, { timeZone: 'Asia/Kolkata' })} <span className="text-[10px] text-gray-400">IST</span></p>
              </div>
              <button onClick={() => setSelected(null)} className="p-2 hover:bg-gray-100 rounded"><FiX /></button>
            </div>
            <div className="p-4 space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <div><span className="text-gray-400">User:</span> <b>{selected.user_name || 'anon'}</b> {selected.user_role && `[${selected.user_role}]`}</div>
                <div><span className="text-gray-400">Action:</span> <span className={`px-1.5 py-0.5 rounded border font-bold ${actionClass(selected.action)}`}>{selected.action}</span></div>
                <div><span className="text-gray-400">Module:</span> <b>{selected.entity_type || '—'}</b></div>
                <div><span className="text-gray-400">Entity ID:</span> {selected.entity_id || '—'}</div>
                <div><span className="text-gray-400">HTTP:</span> <b>{selected.method}</b> → <span className={statusClass(selected.status_code)}>{selected.status_code}</span></div>
                <div><span className="text-gray-400">IP:</span> {selected.ip || '—'}</div>
              </div>
              <div><span className="text-gray-400">Path:</span> <code className="bg-gray-100 px-1 py-0.5 rounded font-mono text-[11px]">{selected.path}</code></div>
              {selected.entity_label && <div><span className="text-gray-400">Label:</span> <b>{selected.entity_label}</b></div>}
              {selected.query && <div><span className="text-gray-400">Query:</span> <code className="bg-gray-100 px-1 py-0.5 rounded font-mono text-[10px] break-all">{selected.query}</code></div>}
              {selected.body_summary && (
                <div>
                  <div className="text-gray-400 mb-1">Request body (secrets redacted):</div>
                  <pre className="bg-gray-50 p-2 rounded text-[10px] whitespace-pre-wrap break-all font-mono">{selected.body_summary}</pre>
                </div>
              )}
              {selected.before_json && (
                <div>
                  <div className="text-gray-400 mb-1">Before:</div>
                  <pre className="bg-amber-50 p-2 rounded text-[10px] whitespace-pre-wrap break-all font-mono">{selected.before_json}</pre>
                </div>
              )}
              {selected.after_json && (
                <div>
                  <div className="text-gray-400 mb-1">After:</div>
                  <pre className="bg-emerald-50 p-2 rounded text-[10px] whitespace-pre-wrap break-all font-mono">{selected.after_json}</pre>
                </div>
              )}
              {selected.user_agent && <div><span className="text-gray-400">User agent:</span> <span className="text-[10px] text-gray-500">{selected.user_agent}</span></div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
