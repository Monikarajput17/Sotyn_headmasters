// Room Rental management — track rented properties (staff
// accommodation), rooms within them, who's currently occupying which
// room, and monthly rent payments to each landlord. Dashboard surfaces
// monthly burn, occupancy, expiring agreements.

import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiHome, FiPlus, FiEdit2, FiTrash2, FiSearch, FiAlertCircle, FiUserCheck, FiLogOut, FiCalendar, FiUsers, FiDollarSign, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { STATES } from '../data/indiaLocations';
import { LuIndianRupee } from 'react-icons/lu';
import { fmtDateTime } from '../utils/datetime';

const STATUS_PILL = {
  active: 'bg-emerald-100 text-emerald-700',
  expired: 'bg-amber-100 text-amber-700',
  terminated: 'bg-red-100 text-red-700',
  available: 'bg-emerald-100 text-emerald-700',
  occupied: 'bg-blue-100 text-blue-700',
  maintenance: 'bg-amber-100 text-amber-700',
  reserved: 'bg-purple-100 text-purple-700',
  completed: 'bg-gray-200 text-gray-600',
  cancelled: 'bg-red-100 text-red-700',
};

const fmtRs = (n) => `Rs ${(Math.round(n || 0)).toLocaleString('en-IN')}`;
const monthNow = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export default function Rentals() {
  const { canCreate, canEdit, canDelete, isAdmin } = useAuth();
  // 'requests' is the primary workflow now (mam's "Raise Rent" flow).
  // Properties / Bookings / Payments stay as deeper tools but don't
  // open by default.
  const [tab, setTab] = useUrlTab('requests');
  const [requests, setRequests] = useState([]);
  const [requestStats, setRequestStats] = useState(null);
  const [requestModal, setRequestModal] = useState(false);
  const [requestForm, setRequestForm] = useState({});
  const [rejectingId, setRejectingId] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [payModal, setPayModal] = useState(null);
  const [payForm, setPayForm] = useState({ paid_via: 'Bank' });
  const [reqFilter, setReqFilter] = useState({ month: '', status: '' });
  const [stats, setStats] = useState(null);
  const [properties, setProperties] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [payments, setPayments] = useState([]);
  const [users, setUsers] = useState([]);
  const [sites, setSites] = useState([]);
  const [filters, setFilters] = useState({ status: '', search: '', city: '' });
  const [propModal, setPropModal] = useState(null);
  const [propForm, setPropForm] = useState({});
  const [propDetail, setPropDetail] = useState(null);
  const [bookingModal, setBookingModal] = useState(false);
  const [bookingForm, setBookingForm] = useState({});
  const [paymentModal, setPaymentModal] = useState(false);
  const [paymentForm, setPaymentForm] = useState({ period_month: monthNow(), paid_via: 'Bank' });
  const [roomModal, setRoomModal] = useState(false);
  const [roomForm, setRoomForm] = useState({});

  const loadStats = () => api.get('/rentals/stats').then(r => setStats(r.data)).catch(() => {});
  const loadProperties = useCallback(() => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
    api.get(`/rentals/properties?${params}`).then(r => setProperties(r.data)).catch(() => {});
  }, [filters]);
  const loadBookings = () => api.get('/rentals/bookings').then(r => setBookings(r.data)).catch(() => {});
  const loadPayments = () => api.get('/rentals/payments').then(r => setPayments(r.data)).catch(() => {});

  useEffect(() => {
    loadStats();
    api.get('/auth/users').then(r => setUsers((r.data || []).filter(u => u.active !== 0))).catch(() => {});
    api.get('/dpr/sites?all=1').then(r => setSites(r.data)).catch(() => {});
  }, []);

  const loadRequests = useCallback(() => {
    const params = new URLSearchParams();
    if (reqFilter.month) params.set('month', reqFilter.month);
    if (reqFilter.status) params.set('status', reqFilter.status);
    api.get(`/rentals/rent-requests?${params}`).then(r => setRequests(r.data)).catch(() => {});
    api.get('/rentals/rent-requests/stats').then(r => setRequestStats(r.data)).catch(() => {});
  }, [reqFilter]);

  useEffect(() => {
    if (tab === 'properties') loadProperties();
    if (tab === 'bookings') loadBookings();
    if (tab === 'payments') {
      loadPayments();
      // Also pull rent_requests so 'paid' ones show up grouped by month
      api.get('/rentals/rent-requests').then(r => setRequests(r.data)).catch(() => {});
    }
    if (tab === 'requests') loadRequests();
  }, [tab, loadProperties, loadRequests]);

  const saveProp = async (e) => {
    e.preventDefault();
    try {
      if (propForm.id) {
        await api.put(`/rentals/properties/${propForm.id}`, propForm);
        toast.success('Updated');
      } else {
        await api.post('/rentals/properties', propForm);
        toast.success('Property added');
      }
      setPropModal(null); setPropForm({});
      loadProperties(); loadStats();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const delProp = async (p) => {
    if (!confirm(`Delete "${p.name}" and all its rooms / bookings / payments?`)) return;
    try { await api.delete(`/rentals/properties/${p.id}`); toast.success('Deleted'); loadProperties(); loadStats(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const openDetail = async (p) => {
    try { const r = await api.get(`/rentals/properties/${p.id}`); setPropDetail(r.data); }
    catch (err) { toast.error('Failed'); }
  };
  const reloadDetail = () => { if (propDetail) openDetail(propDetail); };

  const addRoom = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/rentals/properties/${propDetail.id}/rooms`, roomForm);
      toast.success('Room added');
      setRoomModal(false); setRoomForm({});
      reloadDetail();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const saveBooking = async (e) => {
    e.preventDefault();
    try {
      await api.post('/rentals/bookings', bookingForm);
      toast.success('Booked');
      setBookingModal(false); setBookingForm({});
      loadStats(); loadBookings(); reloadDetail();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const checkOut = async (b) => {
    if (!confirm(`Check out ${b.occupant_name || b.occupant_user_name || 'this occupant'}?`)) return;
    try {
      await api.post(`/rentals/bookings/${b.id}/check-out`, {});
      toast.success('Checked out');
      loadStats(); loadBookings(); reloadDetail();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const savePayment = async (e) => {
    e.preventDefault();
    try {
      await api.post('/rentals/payments', paymentForm);
      toast.success('Payment recorded');
      setPaymentModal(false); setPaymentForm({ period_month: monthNow(), paid_via: 'Bank' });
      loadPayments(); reloadDetail();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FiHome className="text-orange-600" /> Room Rentals</h1>
          <p className="text-sm text-gray-500">Raise monthly rent requests with landlord details + photo + bank/UPI proof.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => {
            if (tab === 'payments') exportCsv('rental-payments', ['Period','Property','Occupant','Amount','Paid Via','Date'], payments.map(p => [p.period_month, p.property_name, p.occupant_name, p.amount, p.paid_via, p.paid_on]));
            else if (tab === 'bookings') exportCsv('rental-bookings', ['Status','Occupant','Property','City','Site','Check-in','Check-out','Rent Share'], bookings.map(b => [b.status, b.occupant_name || b.occupant_user_name, b.property_name, b.city, b.site_name, b.check_in, b.check_out, b.rent_share]));
            else exportCsv('rental-requests', ['Req #','Month','Site','Arrange For','Owner','Pay Mode','Amount','Status'], requests.map(r => [r.request_no, r.rent_month, r.site_name, r.arrange_for, r.owner_name, r.payment_mode, r.amount, r.status]));
          }} className="btn btn-secondary flex items-center gap-1 text-sm"><FiDownload size={14} /> Export Excel</button>
          {canCreate('rentals') && tab === 'payments' && (
            <button onClick={() => { setPaymentForm({ period_month: monthNow(), paid_via: 'Bank' }); setPaymentModal(true); }} className="btn btn-primary flex items-center gap-1"><FiPlus size={14} /> Record Payment</button>
          )}
          {canCreate('rentals') && tab === 'requests' && (
            <button onClick={() => { setRequestForm({ rent_month: monthNow(), arrange_for: 'SEPL', pay_by_day: 10, payment_mode: 'Bank' }); setRequestModal(true); }} className="btn btn-primary flex items-center gap-1"><FiPlus size={14} /> Raise Rent</button>
          )}
        </div>
      </div>

      <div className="flex gap-2 flex-wrap text-sm">
        {[
          { id: 'requests', label: 'Raise Rent' },
          { id: 'payments', label: 'Payments Log' },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`btn ${tab === t.id ? 'btn-primary' : 'btn-secondary'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* RAISE RENT — primary workflow */}
      {tab === 'requests' && (
        <>
          {requestStats && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div className="card p-3 border-l-4 border-amber-500"><p className="text-xs text-gray-500">Pending</p><p className="text-2xl font-bold text-amber-600">{requestStats.pending}</p></div>
              <div className="card p-3 border-l-4 border-blue-500"><p className="text-xs text-gray-500">Approved</p><p className="text-2xl font-bold text-blue-600">{requestStats.approved}</p></div>
              <div className="card p-3 border-l-4 border-emerald-500"><p className="text-xs text-gray-500">Paid</p><p className="text-2xl font-bold text-emerald-600">{requestStats.paid}</p></div>
              <div className="card p-3 border-l-4 border-orange-500"><p className="text-xs text-gray-500">Pending Amount</p><p className="text-base font-bold text-orange-700">{fmtRs(requestStats.pending_amount)}</p></div>
              <div className="card p-3 border-l-4 border-emerald-500"><p className="text-xs text-gray-500">Total Paid</p><p className="text-base font-bold text-emerald-700">{fmtRs(requestStats.total_paid_amount)}</p></div>
            </div>
          )}
          <div className="card p-3 flex flex-wrap items-center gap-3">
            <div>
              <label className="label">Month</label>
              <input className="input" type="month" value={reqFilter.month} onChange={e => setReqFilter(f => ({ ...f, month: e.target.value }))} />
            </div>
            <div>
              <label className="label">Status</label>
              <select className="select" value={reqFilter.status} onChange={e => setReqFilter(f => ({ ...f, status: e.target.value }))}>
                <option value="">All</option>
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="paid">Paid</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>
          </div>
          <div className="card p-0">
            <table className="freeze-head">
              <thead>
                <tr>
                  <th>Req No</th><th>Month / Due By</th><th>Site</th><th>Arrange For</th>
                  <th>Owner</th><th>Aadhar</th><th>Photo</th>
                  <th>Pay Mode</th>
                  <th className="text-right">Amount</th><th>Status</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {requests.length === 0 && <tr><td colSpan="11" className="text-center py-8 text-gray-400">No rent requests yet — click "Raise Rent" to start</td></tr>}
                {requests.map(r => {
                  // Compute "due date" and overdue flag
                  const payByDay = r.pay_by_day || 10;
                  let dueDate = null, isOverdue = false;
                  if (r.rent_month) {
                    const [yr, mo] = r.rent_month.split('-').map(Number);
                    dueDate = new Date(yr, mo - 1, payByDay);
                    if (r.status !== 'paid' && r.status !== 'rejected' && !r.inactive && dueDate < new Date()) isOverdue = true;
                  }
                  return (
                  <tr key={r.id} className={r.inactive ? 'opacity-50 bg-gray-50' : ''}>
                    <td className="font-bold text-orange-700 text-xs">
                      {r.request_no}
                      {r.inactive && <div className="text-[9px] mt-0.5 px-1.5 py-0.5 bg-gray-200 text-gray-600 rounded inline-block">INACTIVE</div>}
                    </td>
                    <td className="text-xs">
                      <div className="font-medium">{r.rent_month}</div>
                      <div className="text-[10px] text-gray-500">Due by {payByDay}{payByDay === 1 ? 'st' : payByDay === 2 ? 'nd' : payByDay === 3 ? 'rd' : 'th'}</div>
                      {isOverdue && <span className="text-[9px] px-1.5 py-0.5 bg-red-100 text-red-700 rounded font-bold">⚠ OVERDUE</span>}
                    </td>
                    <td className="text-xs">
                      <div>{r.site_name || r.site_name_live || '—'}</div>
                      {r.pincode && (
                        <div className="text-[10px] mt-0.5 flex items-center gap-1">
                          <span className="text-gray-500">📍 {r.pincode}</span>
                          {r.metro_type && (
                            <span className={`px-1 py-0.5 rounded font-bold ${r.metro_type === 'Metro' ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-600'}`}>{r.metro_type}</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${r.arrange_for === 'SEPL' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>{r.arrange_for}</span>
                      {/* SEPL shows the room occupant (employee); Contractor shows the contractor name (mam 2026-06-23) */}
                      {(r.arrange_for === 'SEPL' ? r.employee_name : r.contractor_name) && (
                        <div className="text-[10px] text-gray-500 mt-0.5">{r.arrange_for === 'SEPL' ? r.employee_name : r.contractor_name}</div>
                      )}
                    </td>
                    <td className="text-xs"><div className="font-medium">{r.owner_name}</div>{r.owner_phone && <div className="text-[10px] text-gray-500">{r.owner_phone}</div>}</td>
                    <td>{r.owner_aadhar_url ? <a href={r.owner_aadhar_url} target="_blank" rel="noreferrer" className="text-blue-600 underline text-xs">📎 view</a> : <span className="text-gray-300 text-xs">—</span>}</td>
                    <td>
                      {r.room_photo_url ? (
                        <a href={r.room_photo_url} target="_blank" rel="noreferrer">
                          <img src={r.room_photo_url} alt="room" className="w-12 h-12 object-cover rounded" />
                        </a>
                      ) : <span className="text-gray-300 text-xs">—</span>}
                      {r.photo_lat && <div className="text-[9px] text-gray-500">{r.photo_lat.toFixed(4)}, {r.photo_lng.toFixed(4)}</div>}
                    </td>
                    <td className="text-xs">
                      {(() => {
                        const mode = r.payment_mode || 'Bank';
                        if (mode === 'Bank' && r.bank_account) {
                          return (
                            <div>
                              <div className="text-[10px] font-bold text-blue-700">🏦 Bank</div>
                              <div>A/c: {r.bank_account}</div>
                              {r.ifsc_code && <div className="text-[10px] text-gray-500">IFSC: {r.ifsc_code}</div>}
                            </div>
                          );
                        }
                        if (mode === 'UPI' && r.upi_id) {
                          return (
                            <div>
                              <div className="text-[10px] font-bold text-purple-700">💸 UPI</div>
                              <div className="break-all">{r.upi_id}</div>
                            </div>
                          );
                        }
                        if (mode === 'Scanner' && r.scanner_url) {
                          return (
                            <div>
                              <div className="text-[10px] font-bold text-emerald-700">📱 Scanner</div>
                              <a href={r.scanner_url} target="_blank" rel="noreferrer" className="text-blue-600 underline">View QR</a>
                            </div>
                          );
                        }
                        return <span className="text-gray-300">—</span>;
                      })()}
                    </td>
                    <td className="text-right font-bold text-red-700">{fmtRs(r.rent_amount)}</td>
                    <td>
                      <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                        r.status === 'paid' ? 'bg-emerald-100 text-emerald-700' :
                        r.status === 'approved' ? 'bg-blue-100 text-blue-700' :
                        r.status === 'rejected' ? 'bg-red-100 text-red-700' :
                        'bg-amber-100 text-amber-700'
                      }`}>{r.status}</span>
                      {r.reject_reason && <div className="text-[9px] text-red-600 mt-0.5" title={r.reject_reason}>↳ {r.reject_reason.slice(0, 40)}...</div>}
                    </td>
                    <td className="whitespace-nowrap">
                      {canEdit('rentals') && (
                        <button onClick={() => { setRequestForm({ ...r }); setRequestModal(true); }} className="text-[10px] text-blue-600 font-bold hover:underline mr-1" title="Edit this rent request"><FiEdit2 size={11} className="inline" /> Edit</button>
                      )}
                      {r.status === 'pending' && isAdmin() && (
                        <div className="flex gap-1">
                          <button onClick={async () => {
                            try { await api.post(`/rentals/rent-requests/${r.id}/approve`); toast.success('Approved'); loadRequests(); }
                            catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
                          }} className="text-[10px] text-emerald-600 font-bold hover:underline">Approve</button>
                          <button onClick={() => { setRejectingId(r.id); setRejectReason(''); }} className="text-[10px] text-red-600 font-bold hover:underline">Reject</button>
                        </div>
                      )}
                      {r.status === 'approved' && canEdit('rentals') && (
                        <button onClick={() => { setPayModal(r); setPayForm({ paid_via: 'Bank' }); }} className="btn btn-success text-[10px] px-2 py-1">Mark Paid</button>
                      )}
                      {canEdit('rentals') && !r.inactive && (
                        <button onClick={async () => {
                          const reason = prompt('Mark this rental inactive (no more rent expected). Reason:');
                          if (reason === null) return;
                          try { await api.post(`/rentals/rent-requests/${r.id}/mark-inactive`, { reason }); toast.success('Marked inactive'); loadRequests(); }
                          catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
                        }} className="text-[10px] text-gray-500 hover:text-red-600 underline ml-1" title="Mark rental ended — stops appearing in pending lists">Mark Inactive</button>
                      )}
                      {canEdit('rentals') && r.inactive && (
                        <button onClick={async () => {
                          try { await api.post(`/rentals/rent-requests/${r.id}/mark-active`); toast.success('Reactivated'); loadRequests(); }
                          catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
                        }} className="text-[10px] text-emerald-600 hover:underline ml-1">Reactivate</button>
                      )}
                      {canDelete('rentals') && r.status === 'pending' && (
                        <button onClick={async () => {
                          if (!confirm(`Delete ${r.request_no}?`)) return;
                          try { await api.delete(`/rentals/rent-requests/${r.id}`); toast.success('Deleted'); loadRequests(); }
                          catch {}
                        }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={12} /></button>
                      )}
                    </td>
                  </tr>
                );})}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* DASHBOARD */}
      {tab === 'dashboard' && stats && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="card p-4 border-l-4 border-orange-500"><p className="text-xs text-gray-500">Active Properties</p><p className="text-2xl font-bold">{stats.total_properties}</p></div>
            <div className="card p-4 border-l-4 border-blue-500">
              <p className="text-xs text-gray-500">Occupancy</p>
              <p className="text-xl font-bold">{stats.occupied_rooms} <span className="text-sm text-gray-400">/ {stats.total_rooms}</span></p>
              <p className="text-[10px] text-gray-500">{stats.vacant_rooms} vacant rooms</p>
            </div>
            <div className="card p-4 border-l-4 border-red-500">
              <p className="text-xs text-gray-500">Monthly Burn</p>
              <p className="text-xl font-bold text-red-700">{fmtRs(stats.monthly_burn)}</p>
            </div>
            <div className="card p-4 border-l-4 border-purple-500">
              <p className="text-xs text-gray-500">Deposit Locked</p>
              <p className="text-xl font-bold text-purple-700">{fmtRs(stats.total_deposit_locked)}</p>
            </div>
            <div className="card p-4 border-l-4 border-amber-500">
              <p className="text-xs text-gray-500">Active Bookings</p>
              <p className="text-2xl font-bold text-amber-600">{stats.active_bookings}</p>
            </div>
            <div className="card p-4 border-l-4 border-red-500">
              <p className="text-xs text-gray-500">Agreements Expiring (30 days)</p>
              <p className="text-2xl font-bold text-red-700">{stats.agreements_expiring_30d}</p>
            </div>
          </div>
        </>
      )}

      {/* PROPERTIES */}
      {tab === 'properties' && (
        <>
          <div className="card p-3 flex flex-wrap gap-2 items-end">
            <div className="relative flex-1 min-w-[200px]">
              <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
              <input className="input pl-9 text-sm" placeholder="Search by name, address, landlord…" value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} />
            </div>
            <input className="input text-sm w-40" placeholder="City" value={filters.city} onChange={e => setFilters(f => ({ ...f, city: e.target.value }))} />
            <select className="select text-sm w-32" value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}>
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="expired">Expired</option>
              <option value="terminated">Terminated</option>
            </select>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {properties.length === 0 && <div className="col-span-full card p-6 text-center text-gray-400 text-sm">No properties yet — click "Add Property" to start</div>}
            {properties.map(p => (
              <div key={p.id} className="card p-4 hover:shadow-md transition cursor-pointer relative" onClick={() => openDetail(p)}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-bold text-base truncate">{p.name}</h3>
                    <p className="text-xs text-gray-500 truncate">{[p.city, p.state].filter(Boolean).join(', ') || '—'}</p>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${STATUS_PILL[p.status]}`}>{p.status}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                  <div><span className="text-gray-400">Landlord:</span> <span className="font-medium">{p.landlord_name || '—'}</span></div>
                  <div><span className="text-gray-400">Phone:</span> <span className="font-medium">{p.landlord_phone || '—'}</span></div>
                  <div><span className="text-gray-400">Rent:</span> <span className="font-bold text-red-700">{fmtRs(p.monthly_rent)}/mo</span></div>
                  <div><span className="text-gray-400">Deposit:</span> <span className="font-medium">{fmtRs(p.deposit_paid)}</span></div>
                  <div className="col-span-2"><span className="text-gray-400">Rooms:</span> <span className="font-bold text-blue-700">{p.occupied_count} / {p.room_count} occupied</span></div>
                  {p.agreement_end_date && (
                    <div className="col-span-2 text-[10px] flex items-center gap-1">
                      <FiCalendar size={10} /> <span className="text-gray-500">Agreement ends:</span> <span className={`font-bold ${new Date(p.agreement_end_date) < new Date(Date.now() + 30*86400000) ? 'text-red-700' : 'text-gray-700'}`}>{p.agreement_end_date}</span>
                    </div>
                  )}
                </div>
                {canEdit('rentals') && (
                  <button onClick={(e) => { e.stopPropagation(); setPropForm(p); setPropModal('add'); }} className="absolute top-2 right-2 mt-6 text-gray-400 hover:text-blue-600 p-1"><FiEdit2 size={12} /></button>
                )}
                {canDelete('rentals') && (
                  <button onClick={(e) => { e.stopPropagation(); delProp(p); }} className="absolute bottom-2 right-2 text-gray-400 hover:text-red-600 p-1"><FiTrash2 size={12} /></button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* BOOKINGS */}
      {tab === 'bookings' && (
        <div className="card p-0">
          <table className="freeze-head">
            <thead><tr><th>Status</th><th>Occupant</th><th>Property / Room</th><th>City</th><th>Site</th><th>Check-in</th><th>Check-out</th><th>Rent Share</th><th>Actions</th></tr></thead>
            <tbody>
              {bookings.length === 0 && <tr><td colSpan="9" className="text-center py-8 text-gray-400">No bookings yet</td></tr>}
              {bookings.map(b => (
                <tr key={b.id}>
                  <td><span className={`text-[10px] px-2 py-0.5 rounded font-bold ${STATUS_PILL[b.status]}`}>{b.status}</span></td>
                  <td className="font-medium">{b.occupant_user_name || b.occupant_name}{b.occupant_phone && <div className="text-[10px] text-gray-500">{b.occupant_phone}</div>}</td>
                  <td className="text-xs">{b.property_name} <span className="text-gray-400">/</span> {b.room_name}</td>
                  <td className="text-xs">{b.city || '—'}</td>
                  <td className="text-xs">{b.site_name || '—'}</td>
                  <td className="text-xs">{b.check_in_date}</td>
                  <td className="text-xs">{b.actual_checkout_date || (b.check_out_date ? `Plan: ${b.check_out_date}` : '—')}</td>
                  <td className="text-right text-xs">{fmtRs(b.rent_share)}</td>
                  <td>
                    {b.status === 'active' && canEdit('rentals') && (
                      <button onClick={() => checkOut(b)} className="btn btn-secondary text-[10px] px-2 py-1 flex items-center gap-1"><FiLogOut size={10} /> Check out</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* PAYMENTS — grouped by month so mam can scan rent paid each
          month at a glance. Combines paid rent_requests + legacy
          rental_payments into a single chronological view. */}
      {tab === 'payments' && (() => {
        // Build a unified row list from both sources
        const all = [];
        for (const r of (requests || []).filter(r => r.status === 'paid')) {
          all.push({
            id: `req-${r.id}`,
            month: r.rent_month,
            property: r.site_name || r.site_name_live || '—',
            landlord: r.owner_name,
            amount: r.rent_amount,
            paid_date: r.paid_at ? r.paid_at.slice(0, 10) : null,
            paid_via: r.paid_via,
            ref: r.transaction_ref,
            receipt: r.receipt_url,
            notes: r.notes,
            request_no: r.request_no,
            arrange_for: r.arrange_for,
          });
        }
        for (const p of (payments || [])) {
          all.push({
            id: `pay-${p.id}`,
            month: p.period_month,
            property: p.property_name || '—',
            landlord: p.landlord_name,
            amount: p.amount_paid,
            paid_date: p.paid_date,
            paid_via: p.paid_via,
            ref: p.transaction_ref,
            receipt: p.receipt_url,
            notes: p.notes,
          });
        }
        // Group by month (descending)
        const byMonth = {};
        for (const r of all) {
          if (!r.month) continue;
          if (!byMonth[r.month]) byMonth[r.month] = [];
          byMonth[r.month].push(r);
        }
        const months = Object.keys(byMonth).sort().reverse();
        const fmtMonth = (m) => {
          const [y, mo] = m.split('-').map(Number);
          const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
          return `${names[mo - 1]} ${y}`;
        };

        if (months.length === 0) {
          return <div className="card p-8 text-center text-gray-400">No rent payments recorded yet</div>;
        }
        return (
          <div className="space-y-4">
            {months.map(m => {
              const rows = byMonth[m];
              const monthTotal = rows.reduce((s, r) => s + (r.amount || 0), 0);
              const sepl = rows.filter(r => r.arrange_for === 'SEPL').reduce((s, r) => s + (r.amount || 0), 0);
              const contractor = rows.filter(r => r.arrange_for === 'Contractor').reduce((s, r) => s + (r.amount || 0), 0);
              return (
                <div key={m} className="card p-0 overflow-hidden">
                  <div className="px-4 py-3 bg-gradient-to-r from-orange-50 to-blue-50 border-b flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="font-bold text-base text-gray-800">{fmtMonth(m)}</h3>
                      <p className="text-[11px] text-gray-500 mt-0.5">{rows.length} payment{rows.length !== 1 ? 's' : ''} · {m}</p>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-gray-500">Month Total</div>
                      <div className="text-xl font-bold text-red-700">{fmtRs(monthTotal)}</div>
                      {(sepl > 0 || contractor > 0) && (
                        <div className="text-[10px] text-gray-500 mt-0.5">
                          {sepl > 0 && <span>SEPL {fmtRs(sepl)}</span>}
                          {sepl > 0 && contractor > 0 && <span className="mx-1">·</span>}
                          {contractor > 0 && <span>Contractor {fmtRs(contractor)}</span>}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table>
                      <thead className="bg-gray-50">
                        <tr>
                          <th>Req No / Property</th>
                          <th>Landlord</th>
                          <th>Type</th>
                          <th className="text-right">Amount</th>
                          <th>Paid Date</th>
                          <th>Mode</th>
                          <th>Ref</th>
                          <th>Receipt</th>
                          <th>Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(r => (
                          <tr key={r.id}>
                            <td>
                              {r.request_no && <div className="text-[10px] text-orange-600 font-bold">{r.request_no}</div>}
                              <div className="text-xs">{r.property}</div>
                            </td>
                            <td className="text-xs">{r.landlord || '—'}</td>
                            <td>
                              {r.arrange_for ? (
                                <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${r.arrange_for === 'SEPL' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>{r.arrange_for}</span>
                              ) : <span className="text-gray-300 text-xs">—</span>}
                            </td>
                            <td className="text-right font-bold text-red-700">{fmtRs(r.amount)}</td>
                            <td className="text-xs">{r.paid_date || '—'}</td>
                            <td className="text-xs">{r.paid_via || '—'}</td>
                            <td className="text-xs">{r.ref || '—'}</td>
                            <td>{r.receipt ? <a href={r.receipt} target="_blank" rel="noreferrer" className="text-blue-600 underline text-xs">📎</a> : <span className="text-gray-300 text-xs">—</span>}</td>
                            <td className="text-xs text-gray-500 max-w-xs truncate" title={r.notes}>{r.notes || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* PROPERTY DETAIL MODAL */}
      <Modal isOpen={!!propDetail} onClose={() => setPropDetail(null)} title={propDetail?.name || 'Property'} wide>
        {propDetail && (
          <div className="space-y-4 max-h-[75vh] overflow-y-auto">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div className="card p-2"><p className="text-[10px] text-gray-500">Monthly Rent</p><p className="font-bold text-red-700">{fmtRs(propDetail.monthly_rent)}</p></div>
              <div className="card p-2"><p className="text-[10px] text-gray-500">Deposit</p><p className="font-bold">{fmtRs(propDetail.deposit_paid)}</p></div>
              <div className="card p-2"><p className="text-[10px] text-gray-500">Agreement End</p><p className="font-bold text-xs">{propDetail.agreement_end_date || '—'}</p></div>
              <div className="card p-2"><p className="text-[10px] text-gray-500">Landlord</p><p className="font-bold text-xs">{propDetail.landlord_name || '—'}<br/><span className="text-gray-500">{propDetail.landlord_phone || ''}</span></p></div>
            </div>

            {/* Rooms */}
            <div className="border rounded p-3">
              <div className="flex items-center justify-between mb-2">
                <h5 className="font-semibold text-sm">Rooms ({propDetail.rooms?.length || 0})</h5>
                {canCreate('rentals') && <button onClick={() => { setRoomForm({ status: 'available', capacity: 1 }); setRoomModal(true); }} className="btn btn-primary text-xs">+ Room</button>}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {propDetail.rooms?.map(r => (
                  <div key={r.id} className="border rounded p-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-bold">{r.room_name}</span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded ${STATUS_PILL[r.status]}`}>{r.status}</span>
                    </div>
                    <div className="text-[10px] text-gray-500 mt-1">Capacity: {r.capacity} · Occupants: {r.occupant_count}</div>
                    {canCreate('rentals') && r.status !== 'maintenance' && (
                      <button onClick={() => { setBookingForm({ room_id: r.id, check_in_date: new Date().toISOString().slice(0, 10), rent_share: Math.round((propDetail.monthly_rent || 0) / Math.max(1, propDetail.total_capacity || 1)) }); setBookingModal(true); }}
                              className="text-[10px] text-blue-600 underline mt-1">Book</button>
                    )}
                  </div>
                ))}
                {(!propDetail.rooms || propDetail.rooms.length === 0) && <p className="text-xs text-gray-400 col-span-full">No rooms yet</p>}
              </div>
            </div>

            {/* Bookings */}
            <div className="border rounded p-3">
              <h5 className="font-semibold text-sm mb-2">Bookings ({propDetail.bookings?.length || 0})</h5>
              <div className="space-y-1 text-xs">
                {propDetail.bookings?.map(b => (
                  <div key={b.id} className="flex items-center justify-between border-b pb-1 last:border-0">
                    <div>
                      <span className="font-medium">{b.occupant_user_name || b.occupant_name}</span>
                      <span className="text-gray-400 mx-1">·</span>
                      <span className="text-gray-500">{b.room_name}</span>
                      <span className="text-gray-400 mx-1">·</span>
                      <span className="text-gray-500">{b.check_in_date} → {b.actual_checkout_date || b.check_out_date || 'ongoing'}</span>
                    </div>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded ${STATUS_PILL[b.status]}`}>{b.status}</span>
                  </div>
                ))}
                {(!propDetail.bookings || propDetail.bookings.length === 0) && <p className="text-gray-400">No bookings yet</p>}
              </div>
            </div>

            {/* Payments */}
            <div className="border rounded p-3">
              <h5 className="font-semibold text-sm mb-2">Rent Payments ({propDetail.payments?.length || 0})</h5>
              <div className="space-y-1 text-xs">
                {propDetail.payments?.map(p => (
                  <div key={p.id} className="flex items-center justify-between border-b pb-1 last:border-0">
                    <div>
                      <span className="font-bold text-blue-700">{p.period_month}</span>
                      <span className="text-gray-400 mx-1">·</span>
                      <span className="text-gray-500">{p.paid_date || 'Pending'}</span>
                      {p.paid_via && <span className="text-gray-400 ml-1">({p.paid_via})</span>}
                    </div>
                    <span className="font-bold text-red-700">{fmtRs(p.amount_paid)}</span>
                  </div>
                ))}
                {(!propDetail.payments || propDetail.payments.length === 0) && <p className="text-gray-400">No payments yet</p>}
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* PROPERTY ADD/EDIT MODAL */}
      <Modal isOpen={!!propModal} onClose={() => { setPropModal(null); setPropForm({}); }} title={propForm.id ? 'Edit Property' : 'Add Property'} wide>
        <form onSubmit={saveProp} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2"><label className="label">Name *</label><input className="input" required value={propForm.name || ''} onChange={e => setPropForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Andheri Mumbai 3BHK Flat" /></div>
            <div className="col-span-2"><label className="label">Address</label><input className="input" value={propForm.address || ''} onChange={e => setPropForm(f => ({ ...f, address: e.target.value }))} /></div>
            <div><label className="label">City</label><input className="input" value={propForm.city || ''} onChange={e => setPropForm(f => ({ ...f, city: e.target.value }))} /></div>
            <div><label className="label">State</label>
              <select className="select" value={propForm.state || ''} onChange={e => setPropForm(f => ({ ...f, state: e.target.value }))}>
                <option value="">Pick state</option>
                {STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div><label className="label">Pincode</label><input className="input" value={propForm.pincode || ''} onChange={e => setPropForm(f => ({ ...f, pincode: e.target.value }))} /></div>
            <div>
              <label className="label">Linked Site (optional)</label>
              <SearchableSelect options={sites} value={propForm.site_id || null} valueKey="id" displayKey="name" placeholder="Pick site…" onChange={(s) => setPropForm(f => ({ ...f, site_id: s?.id || '' }))} />
            </div>
            <div className="col-span-2 border-t pt-3 mt-1"><h5 className="font-bold text-sm">Landlord</h5></div>
            <div><label className="label">Name</label><input className="input" value={propForm.landlord_name || ''} onChange={e => setPropForm(f => ({ ...f, landlord_name: e.target.value }))} /></div>
            <div><label className="label">Phone</label><input className="input" value={propForm.landlord_phone || ''} onChange={e => setPropForm(f => ({ ...f, landlord_phone: e.target.value }))} /></div>
            <div className="col-span-2"><label className="label">Email</label><input className="input" type="email" value={propForm.landlord_email || ''} onChange={e => setPropForm(f => ({ ...f, landlord_email: e.target.value }))} /></div>
            <div className="col-span-2 border-t pt-3 mt-1"><h5 className="font-bold text-sm">Agreement</h5></div>
            <div><label className="label">Monthly Rent (Rs)</label><input type="number" className="input" value={propForm.monthly_rent || 0} onChange={e => setPropForm(f => ({ ...f, monthly_rent: +e.target.value }))} /></div>
            <div><label className="label">Deposit Paid (Rs)</label><input type="number" className="input" value={propForm.deposit_paid || 0} onChange={e => setPropForm(f => ({ ...f, deposit_paid: +e.target.value }))} /></div>
            <div><label className="label">Start Date</label><input type="date" className="input" value={propForm.agreement_start_date || ''} onChange={e => setPropForm(f => ({ ...f, agreement_start_date: e.target.value }))} /></div>
            <div><label className="label">End Date</label><input type="date" className="input" value={propForm.agreement_end_date || ''} onChange={e => setPropForm(f => ({ ...f, agreement_end_date: e.target.value }))} /></div>
            <div><label className="label">Bedrooms</label><input type="number" className="input" value={propForm.bedrooms || 1} onChange={e => setPropForm(f => ({ ...f, bedrooms: +e.target.value }))} /></div>
            <div><label className="label">Total Capacity (beds)</label><input type="number" className="input" value={propForm.total_capacity || 1} onChange={e => setPropForm(f => ({ ...f, total_capacity: +e.target.value }))} /></div>
            <div className="col-span-2"><label className="label">Amenities</label><input className="input" value={propForm.amenities || ''} onChange={e => setPropForm(f => ({ ...f, amenities: e.target.value }))} placeholder="AC, Wifi, Geyser, Furnished…" /></div>
            <div className="col-span-2"><label className="label">Agreement file URL</label><input className="input" value={propForm.agreement_file_url || ''} onChange={e => setPropForm(f => ({ ...f, agreement_file_url: e.target.value }))} placeholder="https://… (upload separately and paste link)" /></div>
            <div>
              <label className="label">Status</label>
              <select className="select" value={propForm.status || 'active'} onChange={e => setPropForm(f => ({ ...f, status: e.target.value }))}>
                <option>active</option><option>expired</option><option>terminated</option>
              </select>
            </div>
            <div className="col-span-2"><label className="label">Notes</label><textarea className="input" rows="2" value={propForm.notes || ''} onChange={e => setPropForm(f => ({ ...f, notes: e.target.value }))} /></div>
          </div>
          <div className="flex justify-end gap-2 pt-3 border-t">
            <button type="button" onClick={() => { setPropModal(null); setPropForm({}); }} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{propForm.id ? 'Save' : 'Add'}</button>
          </div>
        </form>
      </Modal>

      {/* ROOM ADD MODAL */}
      <Modal isOpen={roomModal} onClose={() => { setRoomModal(false); setRoomForm({}); }} title={`Add room — ${propDetail?.name}`}>
        <form onSubmit={addRoom} className="space-y-3">
          <div><label className="label">Room Name *</label><input className="input" required value={roomForm.room_name || ''} onChange={e => setRoomForm(f => ({ ...f, room_name: e.target.value }))} placeholder="e.g. Master Bedroom" /></div>
          <div><label className="label">Capacity (beds)</label><input type="number" className="input" value={roomForm.capacity || 1} onChange={e => setRoomForm(f => ({ ...f, capacity: +e.target.value }))} /></div>
          <div>
            <label className="label">Status</label>
            <select className="select" value={roomForm.status || 'available'} onChange={e => setRoomForm(f => ({ ...f, status: e.target.value }))}>
              <option>available</option><option>occupied</option><option>maintenance</option><option>reserved</option>
            </select>
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setRoomModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Add</button></div>
        </form>
      </Modal>

      {/* BOOKING MODAL */}
      <Modal isOpen={bookingModal} onClose={() => { setBookingModal(false); setBookingForm({}); }} title="New Booking" wide>
        <form onSubmit={saveBooking} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {!bookingForm.room_id && (
              <div className="col-span-2">
                <label className="label">Pick Room *</label>
                <select className="select" required value={bookingForm.room_id || ''} onChange={e => setBookingForm(f => ({ ...f, room_id: +e.target.value }))}>
                  <option value="">— pick a room —</option>
                  {properties.flatMap(p =>
                    (p.room_count > 0 ? [{ optgroup: p.name, propId: p.id }] : []).concat([])
                  )}
                  {properties.map(p => (
                    <optgroup key={p.id} label={p.name}>
                      {/* We can't fetch all rooms upfront, so this is a hint to open detail */}
                    </optgroup>
                  ))}
                </select>
                <p className="text-[10px] text-gray-500 mt-0.5">Tip: easier to start a booking from the property detail page → click "Book" on any available room.</p>
              </div>
            )}
            <div>
              <label className="label">Occupant (employee)</label>
              <SearchableSelect options={users.map(u => ({ ...u, label: u.name + (u.department ? ` — ${u.department}` : '') }))} value={bookingForm.occupant_user_id || null} valueKey="id" displayKey="label" placeholder="Pick user…" onChange={(u) => setBookingForm(f => ({ ...f, occupant_user_id: u?.id || '', occupant_name: u?.name || '' }))} />
            </div>
            <div><label className="label">Or type name (non-employee)</label><input className="input" value={bookingForm.occupant_name || ''} onChange={e => setBookingForm(f => ({ ...f, occupant_name: e.target.value }))} /></div>
            <div><label className="label">Phone</label><input className="input" value={bookingForm.occupant_phone || ''} onChange={e => setBookingForm(f => ({ ...f, occupant_phone: e.target.value }))} /></div>
            <div>
              <label className="label">Project Site (optional)</label>
              <SearchableSelect options={sites} value={bookingForm.site_id || null} valueKey="id" displayKey="name" placeholder="Pick site…" onChange={(s) => setBookingForm(f => ({ ...f, site_id: s?.id || '' }))} />
            </div>
            <div><label className="label">Check-in *</label><input type="date" className="input" required value={bookingForm.check_in_date || ''} onChange={e => setBookingForm(f => ({ ...f, check_in_date: e.target.value }))} /></div>
            <div><label className="label">Planned Check-out</label><input type="date" className="input" value={bookingForm.check_out_date || ''} onChange={e => setBookingForm(f => ({ ...f, check_out_date: e.target.value }))} /></div>
            <div><label className="label">Rent Share (Rs)</label><input type="number" className="input" value={bookingForm.rent_share || 0} onChange={e => setBookingForm(f => ({ ...f, rent_share: +e.target.value }))} /></div>
            <div><label className="label">Deposit Collected</label><input type="number" className="input" value={bookingForm.deposit_collected || 0} onChange={e => setBookingForm(f => ({ ...f, deposit_collected: +e.target.value }))} /></div>
            <div className="col-span-2"><label className="label">Notes</label><textarea className="input" rows="2" value={bookingForm.notes || ''} onChange={e => setBookingForm(f => ({ ...f, notes: e.target.value }))} /></div>
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setBookingModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Book</button></div>
        </form>
      </Modal>

      {/* PAYMENT MODAL */}
      <Modal isOpen={paymentModal} onClose={() => setPaymentModal(false)} title="Record Rent Payment">
        <form onSubmit={savePayment} className="space-y-3">
          <div>
            <label className="label">Property *</label>
            <SearchableSelect options={properties.filter(p => p.status === 'active').map(p => ({ ...p, label: `${p.name} — ${fmtRs(p.monthly_rent)}/mo` }))} value={paymentForm.property_id || null} valueKey="id" displayKey="label" placeholder="Pick property…" onChange={(p) => setPaymentForm(f => ({ ...f, property_id: p?.id || '', amount_paid: f.amount_paid || p?.monthly_rent || 0 }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Period (YYYY-MM) *</label><input className="input" required value={paymentForm.period_month} onChange={e => setPaymentForm(f => ({ ...f, period_month: e.target.value }))} placeholder="2026-05" /></div>
            <div><label className="label">Amount Paid *</label><input type="number" required className="input" value={paymentForm.amount_paid || 0} onChange={e => setPaymentForm(f => ({ ...f, amount_paid: +e.target.value }))} /></div>
            <div><label className="label">Paid Date</label><input type="date" className="input" value={paymentForm.paid_date || ''} onChange={e => setPaymentForm(f => ({ ...f, paid_date: e.target.value }))} /></div>
            <div>
              <label className="label">Mode</label>
              <select className="select" value={paymentForm.paid_via || 'Bank'} onChange={e => setPaymentForm(f => ({ ...f, paid_via: e.target.value }))}>
                <option>Bank</option><option>UPI</option><option>Cash</option><option>Cheque</option>
              </select>
            </div>
            <div className="col-span-2"><label className="label">Transaction Ref</label><input className="input" value={paymentForm.transaction_ref || ''} onChange={e => setPaymentForm(f => ({ ...f, transaction_ref: e.target.value }))} /></div>
            <div className="col-span-2"><label className="label">Receipt URL</label><input className="input" value={paymentForm.receipt_url || ''} onChange={e => setPaymentForm(f => ({ ...f, receipt_url: e.target.value }))} placeholder="https://… (upload separately and paste link)" /></div>
            <div className="col-span-2"><label className="label">Notes</label><textarea className="input" rows="2" value={paymentForm.notes || ''} onChange={e => setPaymentForm(f => ({ ...f, notes: e.target.value }))} /></div>
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setPaymentModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Save</button></div>
        </form>
      </Modal>

      {/* RAISE RENT MODAL — mam's exact field list */}
      <Modal isOpen={requestModal} onClose={() => { setRequestModal(false); setRequestForm({}); }} title={requestForm.id ? `Edit Rent Request ${requestForm.request_no || ''}` : 'Raise Rent Request'} wide>
        <RaiseRentForm
          form={requestForm}
          setForm={setRequestForm}
          sites={sites}
          users={users}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!requestForm.owner_name || !requestForm.rent_month || !requestForm.arrange_for) {
              return toast.error('Owner name, rent month, and arrange-for are required');
            }
            // PIN is mandatory (mam 2026-06-23). Must be a 6-digit code.
            if (!/^\d{6}$/.test(String(requestForm.pincode || ''))) {
              return toast.error('Room PIN code is required (6 digits)');
            }
            // If the user typed a PIN but didn't click "Verify PIN", classify
            // it now so metro_type is always saved.
            let payload = requestForm;
            if (!requestForm.metro_type) {
              try {
                const { data } = await api.get(`/rentals/pincode/${requestForm.pincode}`);
                payload = { ...requestForm, metro_type: data.metro_type, pincode_city: data.city || data.district || requestForm.pincode_city || null };
              } catch { /* non-fatal — save the PIN even if classify fails */ }
            }
            try {
              if (requestForm.id) {
                await api.put(`/rentals/rent-requests/${requestForm.id}`, payload);
                toast.success(`Updated ${requestForm.request_no || ''}`);
              } else {
                const r = await api.post('/rentals/rent-requests', payload);
                toast.success(`Raised ${r.data.request_no}`);
              }
              setRequestModal(false); setRequestForm({});
              loadRequests();
            } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
          }}
          onCancel={() => { setRequestModal(false); setRequestForm({}); }}
        />
      </Modal>

      {/* REJECT MODAL */}
      <Modal isOpen={!!rejectingId} onClose={() => { setRejectingId(null); setRejectReason(''); }} title="Reject Rent Request">
        <div className="space-y-3">
          <div>
            <label className="label">Reason *</label>
            <textarea className="input" rows="3" value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="Min 5 chars — e.g. owner Aadhar mismatch, photo unclear" />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => { setRejectingId(null); setRejectReason(''); }} className="btn btn-secondary">Cancel</button>
            <button onClick={async () => {
              try {
                await api.post(`/rentals/rent-requests/${rejectingId}/reject`, { reason: rejectReason });
                toast.success('Rejected'); setRejectingId(null); setRejectReason(''); loadRequests();
              } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
            }} className="btn btn-danger">Reject</button>
          </div>
        </div>
      </Modal>

      {/* MARK PAID MODAL */}
      <Modal isOpen={!!payModal} onClose={() => setPayModal(null)} title={payModal ? `Mark Paid — ${payModal.request_no}` : ''}>
        {payModal && (
          <form onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.post(`/rentals/rent-requests/${payModal.id}/mark-paid`, payForm);
              toast.success('Marked paid'); setPayModal(null); setPayForm({ paid_via: 'Bank' }); loadRequests();
            } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
          }} className="space-y-3">
            <div className="bg-gray-50 p-3 rounded text-sm">
              <div><b>{payModal.owner_name}</b> · {payModal.rent_month}</div>
              <div className="text-red-700 font-bold mt-1">{fmtRs(payModal.rent_amount)}</div>
            </div>
            <div>
              <label className="label">Paid Via *</label>
              <select className="select" value={payForm.paid_via} onChange={e => setPayForm(f => ({ ...f, paid_via: e.target.value }))}>
                <option>Bank</option><option>UPI</option><option>Cash</option><option>Cheque</option>
              </select>
            </div>
            <div>
              <label className="label">Transaction Ref</label>
              <input className="input" value={payForm.transaction_ref || ''} onChange={e => setPayForm(f => ({ ...f, transaction_ref: e.target.value }))} placeholder="UTR / UPI ref / Cheque no" />
            </div>
            <div>
              <label className="label">Receipt URL</label>
              <input className="input" value={payForm.receipt_url || ''} onChange={e => setPayForm(f => ({ ...f, receipt_url: e.target.value }))} placeholder="Upload separately and paste link" />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setPayModal(null)} className="btn btn-secondary">Cancel</button>
              <button type="submit" className="btn btn-success">Mark Paid</button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

// ---------- Raise Rent Form ----------
function RaiseRentForm({ form, setForm, sites, users, onSubmit, onCancel }) {
  const [uploading, setUploading] = useState(false);
  const [verifying, setVerifying] = useState(false);

  // Verify the room's PIN code (India Post) and auto-pick Metro / Non-Metro.
  const verifyPincode = async () => {
    const pin = String(form.pincode || '').trim();
    if (!/^\d{6}$/.test(pin)) return toast.error('Enter a 6-digit PIN code first');
    setVerifying(true);
    try {
      const { data } = await api.get(`/rentals/pincode/${pin}`);
      const place = data.city || data.district || '';
      setForm(f => ({ ...f, pincode_city: place, metro_type: data.metro_type || '' }));
      toast.success(`${data.metro_type}${place ? ' — ' + place : ''}${data.verified ? '' : ' (by PIN prefix)'}`);
    } catch (e) {
      toast.error(e.response?.data?.error || 'PIN verification failed');
    } finally { setVerifying(false); }
  };

  const upload = async (file) => {
    if (!file) return null;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      return r.data.url;
    } catch (err) {
      toast.error(`Upload failed: ${err.response?.data?.error || err.message}`);
      return null;
    } finally { setUploading(false); }
  };

  const capturePhoto = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = await upload(file);
    if (!url) return;
    const now = new Date().toISOString();
    let lat = null, lng = null;
    if ('geolocation' in navigator) {
      try {
        await new Promise((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => { lat = pos.coords.latitude; lng = pos.coords.longitude; resolve(); },
            () => resolve(),
            { enableHighAccuracy: true, timeout: 5000 }
          );
        });
      } catch {}
    }
    setForm(f => ({ ...f, room_photo_url: url, photo_taken_at: now, photo_lat: lat, photo_lng: lng }));
    toast.success(lat ? `Photo + GPS captured (${lat.toFixed(4)}, ${lng.toFixed(4)})` : 'Photo captured (GPS unavailable)');
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3 max-h-[75vh] overflow-y-auto pr-1">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Site Name</label>
          <SearchableSelect options={sites} value={form.site_id || null} valueKey="id" displayKey="name" placeholder="Pick site…" onChange={(s) => setForm(f => ({ ...f, site_id: s?.id || '', site_name: s?.name || '' }))} />
        </div>
        <div>
          <label className="label">Rent Month *</label>
          <input className="input" type="month" required value={form.rent_month || ''} onChange={e => setForm(f => ({ ...f, rent_month: e.target.value }))} />
        </div>
        <div>
          <label className="label">Arrange For *</label>
          <select className="select" required value={form.arrange_for || ''} onChange={e => setForm(f => ({ ...f, arrange_for: e.target.value }))}>
            <option value="">— pick —</option>
            <option value="SEPL">SEPL (own staff)</option>
            <option value="Contractor">Contractor</option>
          </select>
        </div>
        {/* Contractor → Contractor Name; SEPL → Employee Name (mam 2026-06-23:
            show only the one that matches Arrange For, not both). */}
        {form.arrange_for === 'Contractor' && (
          <div className="col-span-2"><label className="label">Contractor Name</label><input className="input" value={form.contractor_name || ''} onChange={e => setForm(f => ({ ...f, contractor_name: e.target.value }))} /></div>
        )}
        {form.arrange_for === 'SEPL' && (
          <div className="col-span-2">
            <label className="label">Employee Name <span className="text-gray-400 font-normal text-[10px]">(room occupant)</span></label>
            <SearchableSelect
              options={(users || []).map(u => ({ ...u, label: u.name + (u.department ? ` — ${u.department}` : '') }))}
              value={form.employee_user_id || null}
              valueKey="id"
              displayKey="label"
              placeholder="Search employee…"
              onChange={(u) => setForm(f => ({ ...f, employee_user_id: u?.id || '', employee_name: u?.name || '' }))}
            />
          </div>
        )}
        <div className="col-span-2 grid grid-cols-3 gap-3 items-end">
          <div>
            <label className="label">Room PIN Code *</label>
            <input className="input" inputMode="numeric" maxLength={6} placeholder="6-digit PIN"
              value={form.pincode || ''}
              onChange={e => setForm(f => ({ ...f, pincode: e.target.value.replace(/\D/g, '').slice(0, 6), metro_type: '', pincode_city: '' }))} />
          </div>
          <div>
            <button type="button" onClick={verifyPincode} disabled={verifying} className="btn btn-secondary w-full">{verifying ? 'Verifying…' : 'Verify PIN'}</button>
          </div>
          <div>
            {form.metro_type ? (
              <div className="text-xs">
                <span className={`px-2 py-1 rounded font-bold ${form.metro_type === 'Metro' ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-600'}`}>{form.metro_type}</span>
                {form.pincode_city && <div className="text-[10px] text-gray-500 mt-0.5">{form.pincode_city}</div>}
              </div>
            ) : <span className="text-[10px] text-gray-400">Verify to auto-pick Metro / Non-Metro</span>}
          </div>
        </div>
        <div className="col-span-2 border-t pt-3 mt-1"><h5 className="font-bold text-sm">Room Owner</h5></div>
        <div><label className="label">Owner Name *</label><input className="input" required value={form.owner_name || ''} onChange={e => setForm(f => ({ ...f, owner_name: e.target.value }))} /></div>
        <div><label className="label">Owner Phone</label><input className="input" value={form.owner_phone || ''} onChange={e => setForm(f => ({ ...f, owner_phone: e.target.value }))} /></div>
        <div className="col-span-2">
          <label className="label">Owner Aadhar Card <span className="text-gray-400 font-normal text-[10px]">(image / PDF)</span></label>
          {form.owner_aadhar_url ? (
            <div className="flex items-center gap-2"><a href={form.owner_aadhar_url} target="_blank" rel="noreferrer" className="text-blue-600 underline text-sm">📎 Aadhar uploaded</a><button type="button" onClick={() => setForm(f => ({ ...f, owner_aadhar_url: '' }))} className="text-red-500 text-xs">Remove</button></div>
          ) : (
            <input type="file" accept="image/*,.pdf" className="text-xs" onChange={async e => {
              const url = await upload(e.target.files?.[0]); if (url) setForm(f => ({ ...f, owner_aadhar_url: url }));
              e.target.value = '';
            }} />
          )}
        </div>

        <div className="col-span-2 border-t pt-3 mt-1"><h5 className="font-bold text-sm">Room Outside Photo (timestamped + GPS)</h5></div>
        <div className="col-span-2">
          {form.room_photo_url ? (
            <div className="flex items-start gap-3">
              <img src={form.room_photo_url} alt="room" className="w-32 h-32 object-cover rounded border" />
              <div className="text-xs">
                <div className="text-gray-700">📅 {form.photo_taken_at ? fmtDateTime(form.photo_taken_at) : '—'}</div>
                {form.photo_lat && <div className="text-gray-600">📍 {form.photo_lat.toFixed(5)}, {form.photo_lng.toFixed(5)}</div>}
                <button type="button" onClick={() => setForm(f => ({ ...f, room_photo_url: '', photo_taken_at: null, photo_lat: null, photo_lng: null }))} className="text-red-500 text-xs mt-1">Remove</button>
              </div>
            </div>
          ) : (
            <input type="file" accept="image/*" className="text-xs" onChange={capturePhoto} />
          )}
        </div>

        <div className="col-span-2 border-t pt-3 mt-1"><h5 className="font-bold text-sm">Payment Method</h5></div>
        <div className="col-span-2">
          <label className="label">Payment Mode *</label>
          <div className="flex gap-2">
            {['Bank', 'UPI', 'Scanner'].map(m => (
              <label key={m} className={`flex-1 cursor-pointer border-2 rounded-lg p-3 text-center transition ${(form.payment_mode || 'Bank') === m ? 'border-orange-500 bg-orange-50 text-orange-700 font-bold' : 'border-gray-200 hover:bg-gray-50'}`}>
                <input type="radio" name="payment_mode" value={m} checked={(form.payment_mode || 'Bank') === m} onChange={e => setForm(f => ({ ...f, payment_mode: e.target.value }))} className="sr-only" />
                <div className="text-lg mb-1">{m === 'Bank' ? '🏦' : m === 'UPI' ? '💸' : '📱'}</div>
                <div className="text-sm">{m === 'Bank' ? 'Bank Transfer' : m === 'UPI' ? 'UPI ID' : 'QR Scanner'}</div>
              </label>
            ))}
          </div>
        </div>

        {/* Bank fields — only when Bank selected */}
        {(form.payment_mode || 'Bank') === 'Bank' && (
          <>
            <div><label className="label">Bank Account *</label><input className="input" value={form.bank_account || ''} onChange={e => setForm(f => ({ ...f, bank_account: e.target.value }))} placeholder="A/c number" /></div>
            <div><label className="label">IFSC Code *</label><input className="input" value={form.ifsc_code || ''} onChange={e => setForm(f => ({ ...f, ifsc_code: e.target.value.toUpperCase() }))} placeholder="SBIN0001234" /></div>
          </>
        )}

        {/* UPI ID — only when UPI selected */}
        {form.payment_mode === 'UPI' && (
          <div className="col-span-2">
            <label className="label">UPI ID *</label>
            <input className="input" value={form.upi_id || ''} onChange={e => setForm(f => ({ ...f, upi_id: e.target.value }))} placeholder="9876543210@paytm or owner@okhdfcbank" />
          </div>
        )}

        {/* Scanner upload — only when Scanner selected */}
        {form.payment_mode === 'Scanner' && (
          <div className="col-span-2">
            <label className="label">UPI Scanner Screenshot *</label>
            {form.scanner_url ? (
              <div className="flex items-center gap-3">
                <img src={form.scanner_url} alt="QR" className="w-20 h-20 object-contain border rounded" />
                <a href={form.scanner_url} target="_blank" rel="noreferrer" className="text-blue-600 underline text-sm">View full size</a>
                <button type="button" onClick={() => setForm(f => ({ ...f, scanner_url: '' }))} className="text-red-500 text-xs">Remove</button>
              </div>
            ) : (
              <input type="file" accept="image/*" className="text-xs" onChange={async e => {
                const url = await upload(e.target.files?.[0]); if (url) setForm(f => ({ ...f, scanner_url: url }));
                e.target.value = '';
              }} />
            )}
          </div>
        )}

        <div className="col-span-2 border-t pt-3 mt-1"><h5 className="font-bold text-sm">Amount</h5></div>
        <div><label className="label">Rent Amount (Rs)</label><input className="input" type="number" value={form.rent_amount || 0} onChange={e => setForm(f => ({ ...f, rent_amount: +e.target.value }))} /></div>
        <div>
          <label className="label">Pay-By Day of Month <span className="text-gray-400 font-normal text-[10px]">(e.g. 10 = pay by 10th)</span></label>
          <input className="input" type="number" min="1" max="31" value={form.pay_by_day || 10} onChange={e => setForm(f => ({ ...f, pay_by_day: +e.target.value }))} />
        </div>
        <div className="col-span-2"><label className="label">Notes</label><textarea className="input" rows="2" value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></div>
      </div>
      <div className="flex justify-end gap-2 pt-3 border-t">
        <button type="button" onClick={onCancel} className="btn btn-secondary">Cancel</button>
        <button type="submit" disabled={uploading} className="btn btn-primary">{uploading ? 'Uploading…' : 'Submit Request'}</button>
      </div>
    </form>
  );
}
