import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiCalendar, FiClock, FiTrash2, FiChevronLeft, FiChevronRight, FiX, FiCheck, FiSend } from 'react-icons/fi';

const M = 'salon_appointments';
const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const todayStr = () => new Date().toISOString().slice(0, 10);

const STATUS = {
  booked: { label: 'Booked', cls: 'bg-blue-100 text-blue-700' },
  confirmed: { label: 'Confirmed', cls: 'bg-indigo-100 text-indigo-700' },
  completed: { label: 'Completed', cls: 'bg-emerald-100 text-emerald-700' },
  cancelled: { label: 'Cancelled', cls: 'bg-gray-100 text-gray-500' },
  no_show: { label: 'No-show', cls: 'bg-red-100 text-red-700' },
};

export default function SalonAppointments() {
  const { canCreate, canEdit, canDelete } = useAuth();
  const [date, setDate] = useState(todayStr());
  const [rows, setRows] = useState([]);
  const [clients, setClients] = useState([]);
  const [stylists, setStylists] = useState([]);
  const [services, setServices] = useState([]);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState(null);

  const load = async () => {
    try { const { data } = await api.get('/salon/appointments', { params: { date } }); setRows(data); }
    catch { toast.error('Failed to load appointments'); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [date]);
  useEffect(() => {
    Promise.all([api.get('/salon/clients'), api.get('/salon/stylists', { params: { active: 1 } }), api.get('/salon/services', { params: { active: 1 } })])
      .then(([c, st, sv]) => { setClients(c.data); setStylists(st.data); setServices(sv.data); }).catch(() => {});
  }, []);

  const shiftDay = (d) => { const nd = new Date(date); nd.setDate(nd.getDate() + d); setDate(nd.toISOString().slice(0, 10)); };

  const openNew = () => setForm({ appt_date: date, start_time: '10:00', client_id: '', stylist_id: '', status: 'booked', services: [], notes: '' });
  const addService = (svcId) => {
    const svc = services.find(s => s.id === +svcId); if (!svc) return;
    setForm(f => ({ ...f, services: [...f.services, { service_id: svc.id, service_name: svc.name, price: svc.price, duration_min: svc.duration_min, stylist_id: f.stylist_id || '' }] }));
  };
  const rmService = (i) => setForm(f => ({ ...f, services: f.services.filter((_, x) => x !== i) }));

  const save = async () => {
    if (!form.appt_date) return toast.error('Date required');
    if (!form.client_id) return toast.error('Select a client');
    try { await api.post('/salon/appointments', form); toast.success('Appointment booked'); setForm(null); load(); }
    catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };
  const setStatus = async (a, status) => { try { await api.patch(`/salon/appointments/${a.id}/status`, { status }); load(); } catch { toast.error('Failed'); } };
  const remind = async (a) => {
    try { const { data } = await api.post(`/salon/appointments/${a.id}/reminder`); toast.success(data.skipped ? 'Reminder logged (configure Twilio to send)' : 'Reminder sent'); load(); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed to send reminder'); }
  };
  const del = async (a) => { if (!confirm(`Delete ${a.appt_no}?`)) return; try { await api.delete(`/salon/appointments/${a.id}`); toast.success('Deleted'); load(); } catch { toast.error('Delete failed'); } };

  const total = (a) => (a.services || []).reduce((s, x) => s + (x.price || 0), 0);

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2"><FiCalendar className="text-blue-700" /> Appointments</h1>
          <p className="text-sm text-gray-500">{rows.length} on this day</p>
        </div>
        {canCreate(M) && <button onClick={openNew} className="px-3 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-sm font-medium flex items-center gap-1.5"><FiPlus /> New Booking</button>}
      </div>

      <div className="flex items-center gap-2 mb-4">
        <button onClick={() => shiftDay(-1)} className="p-2 border rounded-lg hover:bg-gray-50"><FiChevronLeft /></button>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} className="px-3 py-2 border rounded-lg text-sm" />
        <button onClick={() => shiftDay(1)} className="p-2 border rounded-lg hover:bg-gray-50"><FiChevronRight /></button>
        <button onClick={() => setDate(todayStr())} className="px-3 py-2 border rounded-lg text-sm hover:bg-gray-50">Today</button>
      </div>

      <div className="space-y-2">
        {rows.map(a => (
          <div key={a.id} className="bg-white rounded-xl border p-3 sm:p-4 flex flex-wrap items-center gap-3">
            <div className="text-center w-16 flex-shrink-0">
              <div className="text-lg font-bold text-gray-800 flex items-center justify-center gap-1"><FiClock size={14} className="text-blue-600" />{a.start_time || '—'}</div>
              {a.end_time && <div className="text-[11px] text-gray-400">to {a.end_time}</div>}
            </div>
            <div className="flex-1 min-w-[160px]">
              <div className="font-semibold text-gray-800">{a.client_name || 'Walk-in'}</div>
              <div className="text-xs text-gray-500">{(a.services || []).map(s => s.svc_name || s.service_name).join(', ') || 'No services'} · {a.stylist_name || 'Any stylist'}</div>
              <div className="text-[11px] text-gray-400">{a.appt_no} · {a.client_phone || ''}</div>
            </div>
            <div className="font-semibold text-gray-700">{money(total(a))}</div>
            <span className={`text-xs px-2 py-1 rounded ${STATUS[a.status]?.cls}`}>{STATUS[a.status]?.label}</span>
            {canEdit(M) && (a.status === 'booked' || a.status === 'confirmed') && (
              <div className="flex gap-1">
                {a.client_phone && <button onClick={() => remind(a)} title={a.reminder_sent ? 'Reminder already sent — send again' : 'Send WhatsApp/SMS reminder'} className={`p-1.5 rounded ${a.reminder_sent ? 'text-blue-400' : 'text-blue-700'} hover:bg-blue-50`}><FiSend /></button>}
                {a.status === 'booked' && <button onClick={() => setStatus(a, 'confirmed')} title="Confirm" className="p-1.5 text-indigo-500 hover:bg-indigo-50 rounded"><FiCheck /></button>}
                <button onClick={() => setStatus(a, 'completed')} title="Mark complete" className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded"><FiCheck /></button>
                <button onClick={() => setStatus(a, 'cancelled')} title="Cancel" className="p-1.5 text-gray-400 hover:bg-gray-100 rounded"><FiX /></button>
              </div>
            )}
            {canDelete(M) && <button onClick={() => del(a)} className="p-1.5 text-gray-300 hover:text-red-600"><FiTrash2 /></button>}
          </div>
        ))}
        {!rows.length && <div className="text-center text-gray-400 py-12 bg-white rounded-xl border">No appointments for this day</div>}
      </div>

      <Modal isOpen={!!form} onClose={() => setForm(null)} title="New Booking" wide>
        {form && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Client">
                <select value={form.client_id} onChange={e => setForm({ ...form, client_id: e.target.value })} className="inp">
                  <option value="">Select client…</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name} {c.phone ? `· ${c.phone}` : ''}</option>)}
                </select>
              </Field>
              <Field label="Stylist">
                <select value={form.stylist_id} onChange={e => setForm({ ...form, stylist_id: e.target.value })} className="inp">
                  <option value="">Any stylist</option>
                  {stylists.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Date"><input type="date" value={form.appt_date} onChange={e => setForm({ ...form, appt_date: e.target.value })} className="inp" /></Field>
              <Field label="Time"><input type="time" value={form.start_time} onChange={e => setForm({ ...form, start_time: e.target.value })} className="inp" /></Field>
              <Field label="Status">
                <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })} className="inp">
                  <option value="booked">Booked</option><option value="confirmed">Confirmed</option>
                </select>
              </Field>
            </div>
            <Field label="Add services">
              <select value="" onChange={e => e.target.value && addService(e.target.value)} className="inp">
                <option value="">+ Add a service…</option>
                {services.map(s => <option key={s.id} value={s.id}>{s.name} · {money(s.price)} · {s.duration_min}min</option>)}
              </select>
            </Field>
            {form.services.length > 0 && (
              <div className="border rounded-lg divide-y">
                {form.services.map((s, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="flex-1">{s.service_name}</span>
                    <span className="text-gray-500">{s.duration_min}min</span>
                    <span className="font-medium">{money(s.price)}</span>
                    <button onClick={() => rmService(i)} className="text-gray-300 hover:text-red-600"><FiX /></button>
                  </div>
                ))}
                <div className="flex justify-between px-3 py-2 text-sm font-semibold bg-gray-50"><span>Total</span><span>{money(form.services.reduce((a, s) => a + (s.price || 0), 0))}</span></div>
              </div>
            )}
            <Field label="Notes"><input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className="inp" /></Field>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setForm(null)} className="px-4 py-2 rounded-lg border text-sm">Cancel</button>
              <button onClick={save} className="px-4 py-2 rounded-lg bg-blue-700 text-white text-sm font-medium">Book</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

const Field = ({ label, children }) => <label className="block"><span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{label}</span><div className="mt-1">{children}</div></label>;
