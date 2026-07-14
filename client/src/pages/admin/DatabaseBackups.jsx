// Admin-only: list of nightly DB backups with one-click download + a
// "Backup Now" button for ad-hoc snapshots before risky operations.
//
// The server schedules an automatic backup at 02:00 every day and keeps
// the last 30 on the VPS disk. Mam can download any of them onto her laptop
// as a cold copy — weekly download to laptop is the recommended habit.

import { useState, useEffect } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { FiDownload, FiRefreshCw, FiDatabase, FiClock, FiHardDrive, FiAlertTriangle } from 'react-icons/fi';
import { fmtDateTime } from '../../utils/datetime';
import { getToken } from '../../lib/tokenStore';

const formatSize = (bytes) => {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

export default function DatabaseBackups() {
  const [data, setData] = useState({ backup_dir: '', backups: [] });
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/admin/backups');
      setData(r.data || { backup_dir: '', backups: [] });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load backups');
    }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const runNow = async () => {
    setRunning(true);
    try {
      const r = await api.post('/admin/backups/run');
      toast.success(`Backup created: ${r.data.filename}`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Backup failed');
    }
    setRunning(false);
  };

  // Native streaming download: point a temporary <a> at the token-authorized
  // endpoint so the BROWSER streams the (large, 150+ MB) .db straight to disk
  // via its own download manager. The old approach pulled the whole file into
  // an in-memory blob via axios, which failed on big backups (mam 2026-06-29:
  // "not able to download"). The server accepts the token as a ?token= query
  // param for this one endpoint (a plain navigation can't send an auth header).
  const download = (filename) => {
    const token = getToken();
    if (!token) return toast.error('Session expired — please log in again');
    const a = document.createElement('a');
    a.href = `/api/admin/backups/${encodeURIComponent(filename)}/download?token=${encodeURIComponent(token)}`;
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  };

  const latest = data.backups?.[0];
  const latestAge = latest ? Math.round((Date.now() - new Date(latest.created_at)) / 3600000) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h3 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <FiDatabase className="text-red-600" /> Database Backups
          </h3>
          <p className="text-sm text-gray-500">Automatic nightly snapshots at 2:00 AM. Keeps the last 30 backups.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} disabled={loading} className="btn btn-secondary flex items-center gap-2">
            <FiRefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button onClick={runNow} disabled={running} className="btn btn-primary flex items-center gap-2">
            <FiHardDrive size={14} /> {running ? 'Backing up…' : 'Backup Now'}
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="card">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Total Backups</p>
          <p className="text-2xl font-bold text-gray-800 mt-1">{data.backups?.length || 0}</p>
          <p className="text-[11px] text-gray-400">Retention: last 30 kept</p>
        </div>
        <div className="card">
          <p className="text-xs text-gray-500 uppercase tracking-wide flex items-center gap-1"><FiClock size={11} /> Latest Backup</p>
          {latest ? (
            <>
              <p className="text-2xl font-bold text-gray-800 mt-1">{latestAge === 0 ? 'Just now' : latestAge < 24 ? `${latestAge}h ago` : `${Math.floor(latestAge / 24)}d ago`}</p>
              <p className="text-[11px] text-gray-400">{fmtDateTime(latest.created_at)}</p>
            </>
          ) : (
            <p className="text-sm text-amber-700 mt-1 flex items-center gap-1"><FiAlertTriangle size={13} /> No backups yet — click "Backup Now"</p>
          )}
        </div>
        <div className="card">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Storage Location</p>
          <p className="text-sm font-mono text-gray-700 mt-1 truncate" title={data.backup_dir}>{data.backup_dir || '—'}</p>
          <p className="text-[11px] text-gray-400">On the VPS disk</p>
        </div>
      </div>

      {/* Recommendation banner — nudges mam to take a laptop copy weekly */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm flex items-start gap-2">
        <FiAlertTriangle className="text-blue-600 mt-0.5 flex-shrink-0" size={16} />
        <div>
          <p className="font-semibold text-blue-800">Recommendation</p>
          <p className="text-xs text-blue-700 mt-0.5">
            Click <b>Download</b> on the latest backup once a week and save it to your laptop's cloud-synced folder (Google Drive / OneDrive).
            VPS backups protect against software failures; a laptop copy protects you even if the VPS itself is lost.
          </p>
        </div>
      </div>

      {/* Backup list */}
      <div className="card p-0 overflow-x-auto">
        <table className="text-sm">
          <thead>
            <tr>
              <th>Filename</th>
              <th>Created</th>
              <th>Size</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {(data.backups || []).map((b, idx) => (
              <tr key={b.filename} className={idx === 0 ? 'bg-emerald-50/50' : ''}>
                <td className="font-mono text-xs">
                  {b.filename}
                  {idx === 0 && <span className="ml-2 text-[10px] bg-emerald-200 text-emerald-800 px-1.5 py-0.5 rounded font-bold">LATEST</span>}
                </td>
                <td className="whitespace-nowrap text-xs">{fmtDateTime(b.created_at)}</td>
                <td className="whitespace-nowrap text-xs">{formatSize(b.size)}</td>
                <td>
                  <button onClick={() => download(b.filename)} className="btn btn-secondary text-xs flex items-center gap-1">
                    <FiDownload size={12} /> Download
                  </button>
                </td>
              </tr>
            ))}
            {(data.backups || []).length === 0 && (
              <tr><td colSpan="4" className="text-center py-8 text-gray-400">
                No backups yet. The first scheduled run happens at 2:00 AM — or click <b>Backup Now</b> to create one immediately.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
