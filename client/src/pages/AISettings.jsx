import { useState, useEffect } from 'react';
import api from '../api';
import toast from 'react-hot-toast';

// AI Settings (admin only). Pastes the Anthropic API key into the Sotyn.Headmasters
// itself — no SSH, no .env edit. Stored server-side in app_settings.
// The key is never sent back to the browser; GET only returns a masked
// version so the page can show "configured" vs "not configured".
export default function AISettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState({ api_key_set: false });
  const [form, setForm] = useState({ provider: 'anthropic', model: 'claude-opus-4-7', api_key: '' });

  useEffect(() => {
    api.get('/ai-agent/settings').then(r => {
      setStatus(r.data);
      setForm(f => ({ ...f, provider: r.data.provider, model: r.data.model }));
    }).catch(e => toast.error(e.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = { provider: form.provider, model: form.model };
      if (form.api_key.trim()) payload.api_key = form.api_key.trim();
      await api.put('/ai-agent/settings', payload);
      toast.success('AI settings saved');
      const fresh = await api.get('/ai-agent/settings').then(r => r.data);
      setStatus(fresh);
      setForm(f => ({ ...f, api_key: '' }));
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-sm text-gray-500">Loading…</div>;

  return (
    <div className="max-w-2xl space-y-4">
      <div className="card p-4 space-y-3">
        <h3 className="font-semibold text-gray-800">AI Agent — API Key</h3>
        <p className="text-sm text-gray-600">
          Paste your API key here to enable the floating "Ask Sotyn.Headmasters" chat bubble across the system.
          The key is stored in the Sotyn.Headmasters database (not in any file), and never sent back to a browser.
          {form.provider === 'gemini'
            ? <> Get a <b>free</b> Gemini key at <a className="text-red-600 hover:underline" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">aistudio.google.com</a> → <b>Get API key</b>. (Free tier has rate limits and may use data to improve Google's products — avoid for highly sensitive queries.)</>
            : <> Get a key at <a className="text-red-600 hover:underline" href="https://console.anthropic.com" target="_blank" rel="noreferrer">console.anthropic.com</a> → Settings → API Keys.</>}
        </p>

        <div className={`text-sm px-3 py-2 rounded ${status.api_key_set ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-yellow-50 text-yellow-800 border border-yellow-200'}`}>
          {status.api_key_set
            ? <>Configured · current key: <span className="font-mono">{status.api_key_masked}</span></>
            : <>Not configured yet — chatbot is disabled until you paste a key below.</>}
        </div>

        <form onSubmit={save} className="space-y-3">
          <div>
            <label className="label">API Key {status.api_key_set && <span className="text-xs text-gray-500 font-normal">(leave blank to keep current)</span>}</label>
            <input
              className="input font-mono text-sm"
              type="password"
              placeholder={form.provider === 'gemini' ? 'AIza...' : 'sk-ant-...'}
              value={form.api_key}
              onChange={e => setForm({ ...form, api_key: e.target.value })}
              autoComplete="off"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Provider</label>
              <select className="select" value={form.provider} onChange={e => {
                const p = e.target.value;
                // Switch the model default to match the provider so a Claude
                // model id isn't sent to Gemini (or vice-versa).
                setForm(f => ({ ...f, provider: p, model: p === 'gemini' ? 'gemini-2.0-flash' : 'claude-opus-4-7' }));
              }}>
                <option value="anthropic">Anthropic (Claude) — most capable, paid</option>
                <option value="gemini">Google Gemini — free tier</option>
              </select>
            </div>
            <div>
              <label className="label">Model</label>
              <select className="select" value={form.model} onChange={e => setForm({ ...form, model: e.target.value })}>
                {form.provider === 'gemini' ? <>
                  <option value="gemini-2.0-flash">Gemini 2.0 Flash (free, fast)</option>
                  <option value="gemini-2.5-flash">Gemini 2.5 Flash (free, newer)</option>
                  <option value="gemini-1.5-flash">Gemini 1.5 Flash (free)</option>
                </> : <>
                  <option value="claude-opus-4-7">Claude Opus 4.7 (most capable)</option>
                  <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (faster, cheaper)</option>
                  <option value="claude-haiku-4-5">Claude Haiku 4.5 (fastest, cheapest)</option>
                </>}
              </select>
            </div>
          </div>
          <div className="flex justify-end">
            <button type="submit" disabled={saving} className="btn btn-primary">{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      </div>

      <div className="card p-4 text-sm text-gray-600 space-y-2">
        <h4 className="font-semibold text-gray-800">How to use the chatbot</h4>
        <ul className="list-disc pl-5 space-y-1">
          <li>Once configured, every user sees a small chat bubble in the bottom-right corner of every page.</li>
          <li>It can answer questions about leads, customers, items, quotations, POs, payments, DPR, attendance — whatever the data shows.</li>
          <li>Example questions: <span className="italic">"what rate did we give L&T for 1.5T AC last time?"</span> · <span className="italic">"which customers haven't paid in 60 days?"</span> · <span className="italic">"top 5 items by quote volume this quarter"</span></li>
          <li>The chatbot can only READ data — it cannot edit, delete, or send anything.</li>
        </ul>
      </div>
    </div>
  );
}
