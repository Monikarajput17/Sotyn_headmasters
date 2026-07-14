import { useState, useEffect } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import { FiPlus, FiEdit2, FiTrash2, FiSend, FiMail } from 'react-icons/fi';
import { fmtDate } from '../utils/datetime';

// Email Triggers (admin) — build dynamic email rules: when <event> fires AND
// <conditions> match, email <recipients> using a {{variable}} template.
// Engine: server/lib/emailRules.js · Catalog: server/lib/emailEvents.js
// (mam 2026-06-03: "lots of email with trigger and pattern, dynamic").

const OPS = [
  { v: 'eq', label: 'equals' },
  { v: 'ne', label: 'not equals' },
  { v: 'contains', label: 'contains' },
  { v: 'gt', label: '> (number)' },
  { v: 'lt', label: '< (number)' },
];

const emptyForm = () => ({
  name: '', event_key: '', enabled: true,
  conditions: [], recipients: { people: [], roles: [], fixed: '' },
  from_addr: '', subject_tpl: '', body_tpl: '',
});

export default function EmailTriggers() {
  const [events, setEvents] = useState([]);
  const [roles, setRoles] = useState([]);
  const [sample, setSample] = useState({});
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [testTo, setTestTo] = useState('');

  const load = () => {
    Promise.all([
      api.get('/email-rules/events'),
      api.get('/email-rules'),
    ]).then(([ev, rl]) => {
      setEvents(ev.data.events || []);
      setRoles(ev.data.roles || []);
      setSample(ev.data.sample || {});
      setRules(rl.data || []);
    }).catch(e => toast.error(e.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const evMap = Object.fromEntries(events.map(e => [e.key, e]));
  const selectedEvent = evMap[form.event_key];

  const openNew = () => { setEditing(null); setForm(emptyForm()); setModalOpen(true); };
  const openEdit = (r) => {
    setEditing(r);
    setForm({
      name: r.name, event_key: r.event_key, enabled: !!r.enabled,
      conditions: Array.isArray(r.conditions) ? r.conditions : [],
      recipients: { people: [], roles: [], fixed: '', ...(r.recipients || {}) },
      from_addr: r.from_addr || '', subject_tpl: r.subject_tpl || '', body_tpl: r.body_tpl || '',
    });
    setModalOpen(true);
  };

  const save = async () => {
    if (!form.name.trim()) return toast.error('Rule name is required');
    if (!form.event_key) return toast.error('Pick an event');
    try {
      if (editing) await api.put(`/email-rules/${editing.id}`, form);
      else await api.post('/email-rules', form);
      toast.success(editing ? 'Rule updated' : 'Rule created');
      setModalOpen(false); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };

  const toggle = async (r) => {
    try { await api.put(`/email-rules/${r.id}/toggle`); load(); }
    catch (e) { toast.error('Toggle failed'); }
  };
  const remove = async (r) => {
    if (!window.confirm(`Delete rule "${r.name}"?`)) return;
    try { await api.delete(`/email-rules/${r.id}`); toast.success('Deleted'); load(); }
    catch (e) { toast.error('Delete failed'); }
  };
  const sendTest = async (r) => {
    const to = window.prompt('Send a test of this rule to which email?', testTo || '');
    if (to === null) return;
    try {
      const res = await api.post(`/email-rules/${r.id}/test`, { to: to.trim() });
      const out = res.data?.results?.[0];
      if (out?.sent) toast.success(`Test sent to ${(out.to || []).join(', ')}`);
      else toast.error(`Not sent: ${out?.skipped || out?.error || 'check SMTP settings'}`);
    } catch (e) { toast.error(e.response?.data?.error || 'Test failed'); }
  };

  // Insert a {{var}} token into the body template.
  const insertVar = (v) => setForm(f => ({ ...f, body_tpl: `${f.body_tpl}{{${v}}}` }));

  const togglePerson = (key) => setForm(f => {
    const has = f.recipients.people.includes(key);
    return { ...f, recipients: { ...f.recipients, people: has ? f.recipients.people.filter(p => p !== key) : [...f.recipients.people, key] } };
  });
  const toggleRole = (name) => setForm(f => {
    const has = f.recipients.roles.includes(name);
    return { ...f, recipients: { ...f.recipients, roles: has ? f.recipients.roles.filter(p => p !== name) : [...f.recipients.roles, name] } };
  });

  const setCond = (i, patch) => setForm(f => {
    const conditions = f.conditions.map((c, idx) => idx === i ? { ...c, ...patch } : c);
    return { ...f, conditions };
  });
  const addCond = () => setForm(f => ({ ...f, conditions: [...f.conditions, { field: (selectedEvent?.fields || [])[0] || '', op: 'eq', value: '' }] }));
  const delCond = (i) => setForm(f => ({ ...f, conditions: f.conditions.filter((_, idx) => idx !== i) }));

  if (loading) return <div className="p-6 text-gray-500">Loading…</div>;

  // Group events for the dropdown.
  const groups = {};
  for (const e of events) { (groups[e.group] = groups[e.group] || []).push(e); }

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2"><FiMail /> Email Triggers</h1>
          <p className="text-sm text-gray-500">Send custom emails automatically when events happen. Uses your SMTP settings (Admin → Email).</p>
        </div>
        <button onClick={openNew} className="btn btn-primary flex items-center gap-2"><FiPlus /> New Rule</button>
      </div>

      {rules.length === 0 ? (
        <div className="bg-gray-50 border border-dashed rounded-lg p-8 text-center text-gray-500">
          No email rules yet. Click <b>New Rule</b> to create your first trigger.
        </div>
      ) : (
        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">Rule</th>
                <th className="text-left px-3 py-2">Event</th>
                <th className="text-left px-3 py-2">Recipients</th>
                <th className="text-center px-3 py-2">On</th>
                <th className="text-left px-3 py-2">Last fired</th>
                <th className="text-right px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map(r => {
                const ev = evMap[r.event_key];
                const rcpt = r.recipients || {};
                const parts = [];
                if (rcpt.people?.length) parts.push(`${rcpt.people.length} from record`);
                if (rcpt.roles?.length) parts.push(`roles: ${rcpt.roles.join(', ')}`);
                if (rcpt.fixed) parts.push('fixed list');
                return (
                  <tr key={r.id} className="border-t">
                    <td className="px-3 py-2 font-medium">{r.name}</td>
                    <td className="px-3 py-2">{ev ? ev.label : r.event_key}</td>
                    <td className="px-3 py-2 text-gray-600">{parts.join(' · ') || <span className="text-amber-600">none set</span>}</td>
                    <td className="px-3 py-2 text-center">
                      <button onClick={() => toggle(r)} className={`px-2 py-0.5 rounded text-xs font-semibold ${r.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-200 text-gray-500'}`}>
                        {r.enabled ? 'ON' : 'OFF'}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-gray-500 text-xs">
                      {r.last_fired_at ? `${fmtDate(r.last_fired_at)} · ${r.fire_count || 0}×` : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => sendTest(r)} className="p-1 text-gray-500 hover:text-blue-600" title="Send test"><FiSend size={15} /></button>
                        <button onClick={() => openEdit(r)} className="p-1 text-gray-500 hover:text-amber-600" title="Edit"><FiEdit2 size={15} /></button>
                        <button onClick={() => remove(r)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={15} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Email Rule' : 'New Email Rule'} wide>
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Rule name *</label>
              <input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Notify CRM on extra indent approval" />
            </div>
            <div>
              <label className="label">When this event happens *</label>
              <select className="select" value={form.event_key} onChange={e => setForm({ ...form, event_key: e.target.value, conditions: [], recipients: { people: [], roles: [], fixed: '' } })}>
                <option value="">Select event…</option>
                {Object.entries(groups).map(([g, evs]) => (
                  <optgroup key={g} label={g}>
                    {evs.map(ev => <option key={ev.key} value={ev.key}>{ev.label}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>

          {selectedEvent && (
            <>
              {/* Recipients */}
              <div className="border rounded-lg p-3 space-y-3">
                <div className="font-semibold text-sm">Who gets the email?</div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">From the record (dynamic)</div>
                  <div className="flex flex-wrap gap-2">
                    {(selectedEvent.people || []).map(p => (
                      <button type="button" key={p.key} onClick={() => togglePerson(p.key)}
                        className={`px-2 py-1 rounded text-xs border ${form.recipients.people.includes(p.key) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300'}`}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
                {roles.length > 0 && (
                  <div>
                    <div className="text-xs text-gray-500 mb-1">By role (all active users with the role)</div>
                    <div className="flex flex-wrap gap-2">
                      {roles.map(rn => (
                        <button type="button" key={rn} onClick={() => toggleRole(rn)}
                          className={`px-2 py-1 rounded text-xs border ${form.recipients.roles.includes(rn) ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-300'}`}>
                          {rn}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <div className="text-xs text-gray-500 mb-1">Fixed addresses (comma / newline separated)</div>
                  <textarea className="input text-sm" rows="2" value={form.recipients.fixed}
                    onChange={e => setForm({ ...form, recipients: { ...form.recipients, fixed: e.target.value } })}
                    placeholder="director@securedengineers.com, accounts@…" />
                </div>
              </div>

              {/* Conditions */}
              <div className="border rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-sm">Only send if… <span className="text-gray-400 font-normal">(optional — all must match)</span></div>
                  <button type="button" onClick={addCond} className="text-xs text-blue-600">+ Add condition</button>
                </div>
                {form.conditions.length === 0 && <div className="text-xs text-gray-400">No conditions — always send when the event fires.</div>}
                {form.conditions.map((c, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <select className="select text-xs flex-1" value={c.field} onChange={e => setCond(i, { field: e.target.value })}>
                      {(selectedEvent.fields || []).map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                    <select className="select text-xs w-28" value={c.op} onChange={e => setCond(i, { op: e.target.value })}>
                      {OPS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
                    </select>
                    <input className="input text-xs flex-1" value={c.value} onChange={e => setCond(i, { value: e.target.value })} placeholder="value" />
                    <button type="button" onClick={() => delCond(i)} className="text-red-500 text-xs px-1">✕</button>
                  </div>
                ))}
              </div>

              {/* Template */}
              <div className="border rounded-lg p-3 space-y-2">
                <div className="font-semibold text-sm">Email content</div>
                <div className="text-[11px] text-gray-500">
                  Click a variable to insert it into the body. Available:&nbsp;
                  {(selectedEvent.vars || []).map(v => (
                    <button type="button" key={v} onClick={() => insertVar(v)}
                      className="inline-block bg-gray-100 hover:bg-blue-100 text-gray-700 rounded px-1.5 py-0.5 mr-1 mb-1 font-mono">
                      {`{{${v}}}`}
                    </button>
                  ))}
                </div>
                <div>
                  <label className="label">From address <span className="text-[10px] text-gray-400 font-normal normal-case">(optional — blank uses your SMTP default)</span></label>
                  <input className="input" value={form.from_addr} onChange={e => setForm({ ...form, from_addr: e.target.value })}
                    placeholder="e.g. alerts@securedengineers.com or {{crm_owner_email}}" />
                  <div className="text-[10px] text-gray-400 mt-0.5">Note: Gmail/most providers only send From the authenticated account or a verified alias.</div>
                </div>
                <div>
                  <label className="label">Subject</label>
                  <input className="input" value={form.subject_tpl} onChange={e => setForm({ ...form, subject_tpl: e.target.value })}
                    placeholder="e.g. Indent {{indent_no}} approved for {{site}}" />
                </div>
                <div>
                  <label className="label">Body</label>
                  <textarea className="input text-sm font-mono" rows="5" value={form.body_tpl} onChange={e => setForm({ ...form, body_tpl: e.target.value })}
                    placeholder={`Hello,\n\nIndent {{indent_no}} ({{category}}) at {{site}} for ₹{{amount}} was approved.\n\n— Sotyn.Headmasters`} />
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />
                Rule enabled (uncheck to pause without deleting)
              </label>
            </>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t">
            <button onClick={() => setModalOpen(false)} className="btn btn-secondary">Cancel</button>
            <button onClick={save} className="btn btn-primary">{editing ? 'Update rule' : 'Create rule'}</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
