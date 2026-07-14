import { useState, useEffect } from 'react';
import toast, { Toaster } from 'react-hot-toast';
import { FiScissors, FiClock, FiCheck, FiCheckCircle, FiCalendar } from 'react-icons/fi';

const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const todayStr = () => new Date().toISOString().slice(0, 10);
const api = (path, opts) => fetch('/api/salon/public' + path, opts).then(async r => {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Something went wrong');
  return d;
});

export default function PublicBooking() {
  const [info, setInfo] = useState({ salon_name: 'Sotyn.Headmasters' });
  const [services, setServices] = useState([]);
  const [stylists, setStylists] = useState([]);
  const [picked, setPicked] = useState([]);        // service ids
  const [stylistId, setStylistId] = useState('');
  const [date, setDate] = useState(todayStr());
  const [time, setTime] = useState('11:00');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    api('/info').then(setInfo).catch(() => {});
    api('/services').then(setServices).catch(() => {});
    api('/stylists').then(setStylists).catch(() => {});
  }, []);

  const toggle = (id) => setPicked(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);
  const chosen = services.filter(s => picked.includes(s.id));
  const total = chosen.reduce((s, x) => s + (x.price || 0), 0);
  const totalDur = chosen.reduce((s, x) => s + (x.duration_min || 0), 0);

  const submit = async () => {
    if (!picked.length) return toast.error('Choose at least one service');
    if (!name.trim()) return toast.error('Enter your name');
    if (!phone.trim()) return toast.error('Enter your phone number');
    setSaving(true);
    try {
      const d = await api('/book', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone, email, service_ids: picked, stylist_id: stylistId || null, appt_date: date, start_time: time, notes }),
      });
      setDone(d.appt_no);
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  // group services by category
  const groups = {};
  for (const s of services) { const k = s.category_name || 'Other'; (groups[k] = groups[k] || []).push(s); }

  if (done) {
    return (
      <Shell salon={info.salon_name}>
        <div className="text-center py-10">
          <FiCheckCircle className="mx-auto text-emerald-500" size={64} />
          <h2 className="text-2xl font-bold text-gray-800 mt-4">Booking requested!</h2>
          <p className="text-gray-500 mt-1">Your reference is <span className="font-semibold text-blue-700">{done}</span>.</p>
          <p className="text-gray-500 text-sm mt-2 max-w-sm mx-auto">We'll confirm your appointment shortly. Thank you for choosing {info.salon_name}. 💇</p>
          <button onClick={() => { setDone(null); setPicked([]); setName(''); setPhone(''); setEmail(''); setNotes(''); }} className="mt-6 px-5 py-2.5 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-sm font-medium">Book another</button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell salon={info.salon_name}>
      <div className="grid lg:grid-cols-3 gap-5">
        {/* services */}
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">1 · Choose services</h2>
          {Object.entries(groups).map(([cat, list]) => (
            <div key={cat}>
              <div className="text-xs font-bold text-blue-700 uppercase mb-1.5">{cat}</div>
              <div className="grid sm:grid-cols-2 gap-2">
                {list.map(s => {
                  const on = picked.includes(s.id);
                  return (
                    <button key={s.id} onClick={() => toggle(s.id)} className={`text-left p-3 rounded-xl border transition-colors ${on ? 'border-blue-600 bg-blue-50 ring-1 ring-blue-600' : 'border-gray-200 bg-white hover:border-blue-300'}`}>
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-gray-800 text-sm">{s.name}</span>
                        {on && <FiCheck className="text-blue-700 flex-shrink-0" />}
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-2"><span>{money(s.price)}</span><span className="flex items-center gap-0.5"><FiClock size={11} />{s.duration_min}m</span></div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {!services.length && <p className="text-gray-400 text-sm">No services available right now.</p>}
        </div>

        {/* booking form */}
        <div className="bg-white rounded-xl border p-4 h-fit lg:sticky lg:top-4 space-y-3">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">2 · Your details</h2>
          <Field label="Preferred stylist">
            <select value={stylistId} onChange={e => setStylistId(e.target.value)} className="pinp">
              <option value="">No preference</option>
              {stylists.map(s => <option key={s.id} value={s.id}>{s.name}{s.specialization ? ` · ${s.specialization}` : ''}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Date"><input type="date" min={todayStr()} value={date} onChange={e => setDate(e.target.value)} className="pinp" /></Field>
            <Field label="Time"><input type="time" value={time} onChange={e => setTime(e.target.value)} className="pinp" /></Field>
          </div>
          <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} className="pinp" placeholder="Your name" /></Field>
          <Field label="Phone"><input value={phone} onChange={e => setPhone(e.target.value)} className="pinp" placeholder="10-digit mobile" inputMode="tel" /></Field>
          <Field label="Email (optional)"><input value={email} onChange={e => setEmail(e.target.value)} className="pinp" placeholder="you@email.com" /></Field>
          <Field label="Notes (optional)"><input value={notes} onChange={e => setNotes(e.target.value)} className="pinp" placeholder="Anything we should know?" /></Field>

          <div className="border-t pt-3">
            <div className="flex items-center justify-between text-sm text-gray-600"><span>{chosen.length} service{chosen.length !== 1 ? 's' : ''}{totalDur ? ` · ~${totalDur} min` : ''}</span><span className="text-lg font-bold text-blue-700">{money(total)}</span></div>
            <button onClick={submit} disabled={saving} className="w-full mt-3 py-3 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-50 text-white font-semibold flex items-center justify-center gap-2">
              <FiCalendar /> {saving ? 'Booking…' : 'Request appointment'}
            </button>
            <p className="text-[11px] text-gray-400 text-center mt-2">We'll confirm by phone. No payment needed now.</p>
          </div>
        </div>
      </div>
      <style>{`.pinp{width:100%;border:1px solid #e5e7eb;border-radius:.5rem;padding:.5rem .75rem;font-size:.875rem;outline:none;background:#fff}.pinp:focus{border-color:#1d4ed8;box-shadow:0 0 0 2px rgba(29,78,216,.15)}`}</style>
    </Shell>
  );
}

function Shell({ salon, children }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-blue-100">
      <Toaster position="top-center" />
      <header className="bg-gradient-to-r from-blue-800 to-blue-950 text-white">
        <div className="max-w-5xl mx-auto px-4 py-6 flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-white/10 ring-1 ring-white/30 flex items-center justify-center"><FiScissors size={22} /></div>
          <div>
            <h1 className="text-xl font-extrabold tracking-tight">{salon}</h1>
            <p className="text-blue-200 text-xs">Book your appointment online</p>
          </div>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 py-6">{children}</main>
      <footer className="text-center text-[11px] text-gray-400 py-6">Powered by {salon}</footer>
    </div>
  );
}

const Field = ({ label, children }) => <label className="block"><span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{label}</span><div className="mt-1">{children}</div></label>;
