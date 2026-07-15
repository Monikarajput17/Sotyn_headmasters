import { useState, useEffect } from 'react';
import api from '../api';
import { Link } from 'react-router-dom';
import { FiCalendar, FiDollarSign, FiUsers, FiAward, FiClock, FiScissors, FiTrendingUp, FiPercent } from 'react-icons/fi';

const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const fmtDate = (s) => s ? new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '';

export default function SalonDashboard() {
  const [stats, setStats] = useState(null);
  useEffect(() => { api.get('/salon/commissions/dashboard/stats').then(r => setStats(r.data)).catch(() => {}); }, []);

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2"><FiScissors className="text-blue-700" /> Headmasters</h1>
        <p className="text-sm text-gray-500">Today at a glance</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <Tile icon={FiCalendar} label="Today's appointments" value={stats?.today?.appointments ?? '—'} to="/salon/appointments" color="from-blue-500 to-indigo-600" />
        <Tile icon={FiDollarSign} label="Today's sales" value={money(stats?.today?.sales?.v)} sub={`${stats?.today?.sales?.c ?? 0} bills`} to="/salon/billing" color="from-emerald-500 to-teal-600" />
        <Tile icon={FiTrendingUp} label="This month revenue" value={money(stats?.month?.revenue)} sub={`${stats?.month?.bills ?? 0} bills`} color="from-blue-600 to-blue-800" />
        <Tile icon={FiUsers} label="Total clients" value={stats?.clients ?? '—'} to="/salon/clients" color="from-amber-500 to-orange-600" />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="Upcoming appointments" icon={FiClock} link="/salon/appointments">
          {stats?.upcoming?.length ? (
            <div className="divide-y">
              {stats.upcoming.map(a => (
                <div key={a.id} className="flex items-center gap-3 py-2.5 text-sm">
                  <div className="text-center w-14 flex-shrink-0">
                    <div className="font-semibold text-gray-800">{a.start_time || '—'}</div>
                    <div className="text-[10px] text-gray-400">{fmtDate(a.appt_date)}</div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-gray-800 truncate">{a.client_name || 'Walk-in'}</div>
                    <div className="text-xs text-gray-500 truncate">{a.stylist_name || 'Any stylist'}</div>
                  </div>
                  <span className={`text-[11px] px-2 py-0.5 rounded ${a.status === 'confirmed' ? 'bg-indigo-100 text-indigo-700' : 'bg-blue-100 text-blue-700'}`}>{a.status}</span>
                </div>
              ))}
            </div>
          ) : <Empty>No upcoming appointments</Empty>}
        </Card>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <MiniStat icon={FiPercent} label="Commission (month)" value={money(stats?.month?.commission)} />
            <MiniStat icon={FiAward} label="Active memberships" value={stats?.active_memberships ?? '—'} />
          </div>
          <Card title="Top services" icon={FiScissors} link="/salon/services">
            {stats?.top_services?.length ? (
              <div className="divide-y">
                {stats.top_services.map((s, i) => (
                  <div key={i} className="flex items-center justify-between py-2 text-sm">
                    <span className="text-gray-700 truncate">{s.name}</span>
                    <span className="text-gray-400 text-xs">{s.c}× · {money(s.revenue)}</span>
                  </div>
                ))}
              </div>
            ) : <Empty>No sales data yet</Empty>}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Tile({ icon: Icon, label, value, sub, to, color }) {
  const body = (
    <div className="bg-white rounded-xl border p-4 hover:shadow-md transition-shadow h-full">
      <div className={`w-9 h-9 rounded-lg bg-gradient-to-br ${color} text-white flex items-center justify-center mb-2`}><Icon size={18} /></div>
      <div className="text-2xl font-bold text-gray-800">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
      {sub && <div className="text-[11px] text-gray-400">{sub}</div>}
    </div>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}
const MiniStat = ({ icon: Icon, label, value }) => <div className="bg-white rounded-xl border p-3"><div className="text-xs text-gray-500 flex items-center gap-1"><Icon size={12} /> {label}</div><div className="text-lg font-bold text-gray-800 mt-0.5">{value}</div></div>;
const Card = ({ title, icon: Icon, link, children }) => <div className="bg-white rounded-xl border p-4"><div className="flex items-center justify-between mb-2"><h3 className="font-semibold text-gray-800 flex items-center gap-1.5"><Icon className="text-blue-700" size={16} /> {title}</h3>{link && <Link to={link} className="text-xs text-blue-700 hover:underline">View all</Link>}</div>{children}</div>;
const Empty = ({ children }) => <div className="py-6 text-center text-gray-400 text-sm">{children}</div>;
