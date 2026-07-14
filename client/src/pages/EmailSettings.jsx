import { useState, useEffect } from 'react';
import api from '../api';
import toast from 'react-hot-toast';

// Email Settings (admin only). SMTP credentials stored in app_settings;
// used by the DPR loss-streak alert (mam: "send notification on mail to
// director@securedengineers.com if one site loss continues three days").
//
// For Gmail: host=smtp.gmail.com, port=587, secure off; user=full email
// address; pass=16-char App Password from Google → Manage your Account →
// Security → 2-Step → App Passwords. A plain Gmail password will NOT work.
export default function EmailSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [data, setData] = useState({ pass_set: false });
  const [form, setForm] = useState({ host: '', port: '587', secure: false, user: '', pass: '', from: '', director_to: '' });
  const [testTo, setTestTo] = useState('');

  useEffect(() => {
    api.get('/ai-agent/email-settings').then(r => {
      setData(r.data);
      setForm(f => ({ ...f, host: r.data.host || '', port: r.data.port || '587', secure: !!r.data.secure, user: r.data.user || '', from: r.data.from || '', director_to: r.data.director_to || '' }));
      setTestTo(r.data.director_to || '');
    }).catch(e => toast.error(e.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = { ...form };
      if (!payload.pass) delete payload.pass; // blank keeps current
      await api.put('/ai-agent/email-settings', payload);
      toast.success('Email settings saved');
      const fresh = await api.get('/ai-agent/email-settings').then(r => r.data);
      setData(fresh); setForm(f => ({ ...f, pass: '' }));
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  };

  const sendTest = async () => {
    if (!testTo.trim()) { toast.error('Enter a test recipient'); return; }
    setTesting(true);
    try {
      const { data } = await api.post('/ai-agent/email-test', { to: testTo.trim() });
      toast.success(data.message || 'Test email sent');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Test failed');
    } finally { setTesting(false); }
  };

  if (loading) return <div className="text-sm text-gray-500">Loading…</div>;

  return (
    <div className="max-w-2xl space-y-4">
      <div className="card p-4 space-y-3">
        <h3 className="font-semibold text-gray-800">Email Alerts — SMTP</h3>
        <p className="text-sm text-gray-600">
          Used by the DPR loss-streak alert (auto-emails the director when any site has loss for 3+ consecutive days).
          For Gmail: host <code>smtp.gmail.com</code>, port <code>587</code>, user = your full email, password = a 16-character
          App Password from Google (regular passwords will not work).
        </p>

        <div className={`text-sm px-3 py-2 rounded ${data.pass_set ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-yellow-50 text-yellow-800 border border-yellow-200'}`}>
          {data.pass_set
            ? <>SMTP configured · password ending: <span className="font-mono">{data.pass_masked}</span></>
            : 'SMTP not configured — loss-streak alerts are stored but not emailed until you set this up.'}
        </div>

        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><label className="label">SMTP Host</label><input className="input" placeholder="smtp.gmail.com" value={form.host} onChange={e => setForm({ ...form, host: e.target.value })} /></div>
            <div><label className="label">Port</label><input className="input" placeholder="587" value={form.port} onChange={e => setForm({ ...form, port: e.target.value })} /></div>
            <div className="flex items-center gap-2 mt-7">
              <input id="secure" type="checkbox" checked={form.secure} onChange={e => setForm({ ...form, secure: e.target.checked })} className="w-4 h-4" />
              <label htmlFor="secure" className="text-sm">Use TLS/SSL (port 465)</label>
            </div>
            <div><label className="label">Username (full email)</label><input className="input" placeholder="dme@securedengineers.com" value={form.user} onChange={e => setForm({ ...form, user: e.target.value })} /></div>
            <div className="sm:col-span-2"><label className="label">Password / App Password {data.pass_set && <span className="text-xs text-gray-400 font-normal">(leave blank to keep current)</span>}</label><input className="input font-mono text-sm" type="password" placeholder="•••••••• (Gmail App Password is 16 chars)" value={form.pass} onChange={e => setForm({ ...form, pass: e.target.value })} autoComplete="off" /></div>
            <div><label className="label">From address <span className="text-xs text-gray-400 font-normal">(optional)</span></label><input className="input" placeholder="Sotyn.Headmasters <dme@securedengineers.com>" value={form.from} onChange={e => setForm({ ...form, from: e.target.value })} /></div>
            <div><label className="label">Director email (recipient)</label><input className="input" type="email" placeholder="director@securedengineers.com" value={form.director_to} onChange={e => setForm({ ...form, director_to: e.target.value })} /></div>
          </div>
          <div className="flex justify-end">
            <button type="submit" disabled={saving} className="btn btn-primary">{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </form>

        <div className="border-t pt-3 space-y-2">
          <h4 className="font-semibold text-sm text-gray-800">Test</h4>
          <div className="flex gap-2 items-end">
            <div className="flex-1"><label className="label">Send test email to</label><input className="input" type="email" value={testTo} onChange={e => setTestTo(e.target.value)} /></div>
            <button onClick={sendTest} disabled={testing || !data.pass_set} className="btn btn-secondary">{testing ? 'Sending…' : 'Send test'}</button>
          </div>
          {!data.pass_set && <p className="text-xs text-gray-400">Save your SMTP settings before testing.</p>}
        </div>
      </div>
    </div>
  );
}
