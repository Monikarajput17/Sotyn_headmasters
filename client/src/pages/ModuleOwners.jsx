// Module Owners — one screen to assign the OWNER of every RACI module.
// The owner becomes the whole-module Responsible (record_id 0, all steps) and is
// scored on that module's RACI Plan-vs-Actual % on the dashboard. mam 2026-07-04.
import { useState, useEffect } from 'react';
import api from '../api';
import toast from 'react-hot-toast';

export default function ModuleOwners() {
  const [modules, setModules] = useState([]);
  const [users, setUsers] = useState([]);
  const [owners, setOwners] = useState({});
  const [saving, setSaving] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [m, u] = await Promise.all([api.get('/raci/modules'), api.get('/auth/users')]);
        const mods = m.data || [];
        setModules(mods);
        setUsers((u.data || []).filter(x => x.active !== 0));
        const map = {};
        await Promise.all(mods.map(async (mod) => {
          try {
            const r = await api.get(`/raci/record/${mod.key}/0`);
            const counts = {};
            (r.data.steps || []).forEach(s => { if (s.responsible_id) counts[s.responsible_id] = (counts[s.responsible_id] || 0) + 1; });
            const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
            map[mod.key] = top ? +top[0] : '';
          } catch { map[mod.key] = ''; }
        }));
        setOwners(map);
      } catch (e) { toast.error('Could not load modules'); }
      finally { setLoading(false); }
    })();
  }, []);

  const saveOwner = async (mod, ownerId) => {
    setSaving(mod.key);
    try {
      const cur = await api.get(`/raci/record/${mod.key}/0`);
      const steps = (cur.data.steps || []).map(s => ({
        step_key: s.key,
        responsible_id: ownerId ? +ownerId : null,
        accountable_id: s.accountable_id || null,
        consulted_id: s.consulted_id || null,
        informed_id: s.informed_id || null,
        sla_hours: s.sla_hours ?? null,
        weight: s.weight ?? null,
        commitment: s.commitment || null,
      }));
      await api.put(`/raci/record/${mod.key}/0`, { steps });
      setOwners(o => ({ ...o, [mod.key]: ownerId ? +ownerId : '' }));
      toast.success(`${mod.label}: owner saved`);
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
    finally { setSaving(null); }
  };

  if (loading) return <div className="p-6 text-gray-400 text-sm">Loading modules…</div>;
  const assigned = modules.filter(m => owners[m.key]).length;

  return (
    <div className="p-4 max-w-3xl mx-auto">
      <h1 className="text-xl font-bold text-gray-800">Module Owners</h1>
      <p className="text-sm text-gray-500 mt-1 mb-4">
        Pick who <b>owns</b> each module. The owner is scored on that module's <b>RACI Plan-vs-Actual %</b> on the dashboard. Modules with no owner are highlighted.
        <span className="ml-1 text-gray-400">({assigned}/{modules.length} assigned)</span>
      </p>
      <div className="space-y-2">
        {modules.map(mod => {
          const ownerless = !owners[mod.key];
          return (
            <div key={mod.key} className={`flex items-center justify-between gap-3 rounded-lg border p-3 ${ownerless ? 'border-amber-300 bg-amber-50/50' : 'border-gray-200 bg-white'}`}>
              <div className="min-w-0">
                <div className="font-semibold text-sm text-gray-800">{mod.label}</div>
                <div className="text-[11px] text-gray-400">{(mod.steps || []).length} steps{ownerless ? ' · no owner yet' : ''}</div>
              </div>
              <select className="input text-sm w-56 flex-shrink-0" value={owners[mod.key] || ''} disabled={saving === mod.key}
                onChange={e => saveOwner(mod, e.target.value)}>
                <option value="">— select owner —</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}
