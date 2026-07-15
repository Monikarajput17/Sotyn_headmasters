import { useState, useEffect, useRef } from 'react';
import api from '../api';
import { Link } from 'react-router-dom';
import { FiCalendar, FiDollarSign, FiUsers, FiAward, FiClock, FiScissors, FiTrendingUp, FiPercent, FiArrowUpRight } from 'react-icons/fi';

const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const fmtDate = (s) => s ? new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '';

// A card that tilts in 3D toward the cursor (real perspective transform).
function Tilt({ children, className = '', max = 10, style = {} }) {
  const ref = useRef(null);
  const move = (e) => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    el.style.transform = `perspective(1000px) rotateX(${(-py * max).toFixed(2)}deg) rotateY(${(px * max).toFixed(2)}deg) translateY(-6px)`;
  };
  const reset = () => { const el = ref.current; if (el) el.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) translateY(0)'; };
  return (
    <div ref={ref} onMouseMove={move} onMouseLeave={reset} className={className}
      style={{ transformStyle: 'preserve-3d', transition: 'transform .18s cubic-bezier(.03,.98,.52,.99)', willChange: 'transform', ...style }}>
      {children}
    </div>
  );
}

export default function SalonDashboard() {
  const [stats, setStats] = useState(null);
  useEffect(() => { api.get('/salon/commissions/dashboard/stats').then(r => setStats(r.data)).catch(() => {}); }, []);

  return (
    <div className="sd-wrap">
      {/* ambient 3D backdrop */}
      <div className="sd-orb sd-orb-a" />
      <div className="sd-orb sd-orb-b" />
      <div className="sd-orb sd-orb-c" />

      <div className="relative" style={{ zIndex: 1 }}>
        <div className="flex items-center gap-3 mb-7">
          <div className="sd-logo3d"><FiScissors size={26} /></div>
          <div>
            <h1 className="text-2xl font-extrabold text-slate-800 tracking-tight">Headmasters</h1>
            <p className="text-sm text-slate-500">Today at a glance</p>
          </div>
        </div>

        {/* KPI tiles — 3D */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <Kpi to="/salon/appointments" icon={FiCalendar} grad="a" label="Today's appointments" value={stats?.today?.appointments ?? '—'} />
          <Kpi to="/salon/billing" icon={FiDollarSign} grad="b" label="Today's sales" value={money(stats?.today?.sales?.v)} sub={`${stats?.today?.sales?.c ?? 0} bills`} />
          <Kpi icon={FiTrendingUp} grad="c" label="This month revenue" value={money(stats?.month?.revenue)} sub={`${stats?.month?.bills ?? 0} bills`} />
          <Kpi to="/salon/clients" icon={FiUsers} grad="d" label="Total clients" value={stats?.clients ?? '—'} />
        </div>

        <div className="grid lg:grid-cols-2 gap-4">
          {/* Upcoming */}
          <Tilt max={4} className="sd-panel">
            <div className="flex items-center justify-between mb-3" style={{ transform: 'translateZ(24px)' }}>
              <h3 className="font-bold text-slate-800 flex items-center gap-2"><FiClock className="text-blue-600" /> Upcoming appointments</h3>
              <Link to="/salon/appointments" className="text-xs font-semibold text-blue-700 hover:underline flex items-center gap-0.5">View all <FiArrowUpRight size={12} /></Link>
            </div>
            <div style={{ transform: 'translateZ(14px)' }}>
              {stats?.upcoming?.length ? (
                <div className="divide-y divide-slate-100">
                  {stats.upcoming.map(a => (
                    <div key={a.id} className="flex items-center gap-3 py-2.5 text-sm">
                      <div className="sd-time">
                        <div className="font-bold text-slate-800 leading-none">{a.start_time || '—'}</div>
                        <div className="text-[10px] text-slate-400 mt-0.5">{fmtDate(a.appt_date)}</div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-slate-800 truncate">{a.client_name || 'Walk-in'}</div>
                        <div className="text-xs text-slate-500 truncate">{a.stylist_name || 'Any stylist'}</div>
                      </div>
                      <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${a.status === 'confirmed' ? 'bg-indigo-100 text-indigo-700' : 'bg-blue-100 text-blue-700'}`}>{a.status}</span>
                    </div>
                  ))}
                </div>
              ) : <Empty>No upcoming appointments</Empty>}
            </div>
          </Tilt>

          {/* right column */}
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <MiniStat icon={FiPercent} label="Commission (month)" value={money(stats?.month?.commission)} />
              <MiniStat icon={FiAward} label="Active memberships" value={stats?.active_memberships ?? '—'} />
            </div>
            <Tilt max={4} className="sd-panel">
              <div className="flex items-center justify-between mb-3" style={{ transform: 'translateZ(24px)' }}>
                <h3 className="font-bold text-slate-800 flex items-center gap-2"><FiScissors className="text-blue-600" /> Top services</h3>
                <Link to="/salon/services" className="text-xs font-semibold text-blue-700 hover:underline flex items-center gap-0.5">View all <FiArrowUpRight size={12} /></Link>
              </div>
              <div style={{ transform: 'translateZ(12px)' }}>
                {stats?.top_services?.length ? (
                  <div className="space-y-2.5">
                    {stats.top_services.map((s, i) => {
                      const max = Math.max(...stats.top_services.map(x => x.revenue || 0), 1);
                      return (
                        <div key={i}>
                          <div className="flex items-center justify-between text-sm mb-1">
                            <span className="text-slate-700 truncate">{s.name}</span>
                            <span className="text-slate-400 text-xs whitespace-nowrap ml-2">{s.c}× · {money(s.revenue)}</span>
                          </div>
                          <div className="sd-bar"><div className="sd-bar-fill" style={{ width: `${Math.max(6, (s.revenue / max) * 100)}%` }} /></div>
                        </div>
                      );
                    })}
                  </div>
                ) : <Empty>No sales data yet</Empty>}
              </div>
            </Tilt>
          </div>
        </div>
      </div>

      <style>{`
        .sd-wrap{position:relative;overflow:hidden;padding:1.5rem;min-height:100%;
          background:radial-gradient(1200px 600px at 15% -10%, #eef4ff 0%, transparent 55%),
                     radial-gradient(1000px 700px at 110% 10%, #f3ecff 0%, transparent 50%),
                     linear-gradient(180deg,#f8fafc 0%,#eef2f9 100%);}
        @media(min-width:640px){.sd-wrap{padding:1.5rem 2rem}}
        .sd-orb{position:absolute;border-radius:50%;filter:blur(60px);opacity:.5;pointer-events:none;z-index:0;animation:sdFloat 14s ease-in-out infinite}
        .sd-orb-a{width:340px;height:340px;top:-80px;left:-60px;background:radial-gradient(circle at 30% 30%,#93c5fd,#3b82f6)}
        .sd-orb-b{width:300px;height:300px;top:40px;right:-80px;background:radial-gradient(circle at 30% 30%,#c4b5fd,#7c3aed);animation-delay:-4s}
        .sd-orb-c{width:280px;height:280px;bottom:-120px;left:35%;background:radial-gradient(circle at 30% 30%,#a5b4fc,#4f46e5);animation-delay:-8s}
        @keyframes sdFloat{0%,100%{transform:translateY(0) translateX(0)}50%{transform:translateY(-22px) translateX(14px)}}

        .sd-logo3d{width:52px;height:52px;border-radius:16px;display:flex;align-items:center;justify-content:center;color:#fff;
          background:linear-gradient(145deg,#3b82f6,#1e3a8a);
          box-shadow:0 10px 24px -6px rgba(37,99,235,.6), inset 0 2px 3px rgba(255,255,255,.45), inset 0 -4px 8px rgba(0,0,0,.25);}

        .sd-kpi{position:relative;border-radius:20px;padding:18px;color:#fff;overflow:hidden;display:block;
          box-shadow:0 18px 34px -14px rgba(30,41,90,.55), 0 2px 0 rgba(255,255,255,.35) inset;
          transform-style:preserve-3d;transition:transform .18s cubic-bezier(.03,.98,.52,.99),box-shadow .18s;}
        .sd-kpi:hover{box-shadow:0 30px 50px -16px rgba(30,41,90,.6), 0 2px 0 rgba(255,255,255,.4) inset}
        .sd-kpi .sheen{position:absolute;inset:0;background:linear-gradient(120deg,rgba(255,255,255,.35),transparent 40%);pointer-events:none}
        .sd-kpi .badge{width:44px;height:44px;border-radius:13px;display:flex;align-items:center;justify-content:center;
          background:rgba(255,255,255,.22);box-shadow:inset 0 2px 3px rgba(255,255,255,.5), 0 6px 14px rgba(0,0,0,.18);
          transform:translateZ(40px);margin-bottom:12px}
        .sd-kpi .val{font-size:1.9rem;font-weight:800;line-height:1;transform:translateZ(26px);text-shadow:0 2px 6px rgba(0,0,0,.18)}
        .sd-kpi .lab{font-size:.72rem;opacity:.92;margin-top:6px;transform:translateZ(16px)}
        .sd-kpi .sub{font-size:.66rem;opacity:.8;transform:translateZ(12px)}
        .g-a{background:linear-gradient(145deg,#3b82f6,#4338ca)}
        .g-b{background:linear-gradient(145deg,#10b981,#0f766e)}
        .g-c{background:linear-gradient(145deg,#6366f1,#7c3aed)}
        .g-d{background:linear-gradient(145deg,#f59e0b,#ea580c)}

        .sd-panel{background:rgba(255,255,255,.75);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.9);
          border-radius:20px;padding:18px;box-shadow:0 20px 40px -18px rgba(30,41,90,.35), 0 1px 0 rgba(255,255,255,.9) inset;}
        .sd-mini{background:rgba(255,255,255,.8);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.9);border-radius:16px;padding:14px;
          box-shadow:0 14px 28px -16px rgba(30,41,90,.35), 0 1px 0 rgba(255,255,255,.9) inset;transition:transform .18s}
        .sd-mini:hover{transform:translateY(-4px)}
        .sd-mini .orb{width:34px;height:34px;border-radius:11px;display:flex;align-items:center;justify-content:center;color:#fff;
          background:linear-gradient(145deg,#60a5fa,#4338ca);box-shadow:inset 0 2px 2px rgba(255,255,255,.5),0 6px 12px rgba(37,99,235,.35);margin-bottom:8px}
        .sd-time{width:56px;text-align:center;flex-shrink:0;padding:6px 0;border-radius:12px;
          background:linear-gradient(145deg,#eff6ff,#e0e7ff);box-shadow:inset 0 1px 2px #fff,0 4px 8px -3px rgba(37,99,235,.25)}
        .sd-bar{height:8px;border-radius:99px;background:#e6ebf5;overflow:hidden;box-shadow:inset 0 1px 2px rgba(0,0,0,.08)}
        .sd-bar-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,#60a5fa,#4f46e5);box-shadow:0 1px 3px rgba(79,70,229,.5)}
      `}</style>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, sub, to, grad }) {
  const card = (
    <Tilt max={12} className={`sd-kpi g-${grad}`}>
      <span className="sheen" />
      <div className="badge"><Icon size={22} /></div>
      <div className="val">{value}</div>
      <div className="lab">{label}</div>
      {sub && <div className="sub">{sub}</div>}
    </Tilt>
  );
  return to ? <Link to={to} className="block">{card}</Link> : card;
}
const MiniStat = ({ icon: Icon, label, value }) => (
  <div className="sd-mini">
    <div className="orb"><Icon size={16} /></div>
    <div className="text-lg font-bold text-slate-800">{value}</div>
    <div className="text-[11px] text-slate-500">{label}</div>
  </div>
);
const Empty = ({ children }) => <div className="py-6 text-center text-slate-400 text-sm">{children}</div>;
