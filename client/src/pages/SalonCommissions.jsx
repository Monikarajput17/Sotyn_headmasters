import { useState, useEffect } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import { FiPercent, FiTrendingUp } from 'react-icons/fi';

const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const firstOfMonth = () => new Date().toISOString().slice(0, 7) + '-01';
const today = () => new Date().toISOString().slice(0, 10);

export default function SalonCommissions() {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [data, setData] = useState({ rows: [], totals: { revenue: 0, commission: 0, lines: 0 } });

  const load = async () => {
    try { const { data } = await api.get('/salon/commissions', { params: { from, to } }); setData(data); }
    catch { toast.error('Failed to load commissions'); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [from, to]);

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2 mb-1"><FiPercent className="text-blue-700" /> Stylist Commissions</h1>
      <p className="text-sm text-gray-500 mb-5">Computed from completed (paid) sales in the selected period.</p>

      <div className="flex flex-wrap items-end gap-3 mb-5">
        <label className="text-sm">From<input type="date" value={from} onChange={e => setFrom(e.target.value)} className="inp mt-1" /></label>
        <label className="text-sm">To<input type="date" value={to} onChange={e => setTo(e.target.value)} className="inp mt-1" /></label>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-5">
        <Kpi label="Revenue (service)" value={money(data.totals.revenue)} />
        <Kpi label="Total commission" value={money(data.totals.commission)} accent />
        <Kpi label="Service lines" value={data.totals.lines} />
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr><th className="text-left px-4 py-3">Stylist</th><th className="text-right px-4 py-3">Rate</th><th className="text-right px-4 py-3">Services</th><th className="text-right px-4 py-3">Revenue</th><th className="text-right px-4 py-3">Commission</th></tr>
            </thead>
            <tbody className="divide-y">
              {data.rows.map(r => (
                <tr key={r.stylist_id} className="hover:bg-blue-50/40">
                  <td className="px-4 py-3 font-medium text-gray-800">{r.stylist_name}</td>
                  <td className="px-4 py-3 text-right text-gray-500">{r.commission_pct}%</td>
                  <td className="px-4 py-3 text-right text-gray-600">{r.line_count}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{money(r.revenue)}</td>
                  <td className="px-4 py-3 text-right font-semibold text-blue-800">{money(r.commission)}</td>
                </tr>
              ))}
              {!data.rows.length && <tr><td colSpan={5} className="px-4 py-10 text-center text-gray-400">No commissioned sales in this period</td></tr>}
            </tbody>
            {data.rows.length > 0 && (
              <tfoot className="bg-gray-50 font-semibold">
                <tr><td className="px-4 py-3" colSpan={3}>Total</td><td className="px-4 py-3 text-right">{money(data.totals.revenue)}</td><td className="px-4 py-3 text-right text-blue-800">{money(data.totals.commission)}</td></tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

const Kpi = ({ label, value, accent }) => <div className={`rounded-xl p-4 border ${accent ? 'bg-blue-50 border-blue-200' : 'bg-white'}`}><div className="text-xs text-gray-500 flex items-center gap-1"><FiTrendingUp size={12} /> {label}</div><div className={`text-xl font-bold mt-1 ${accent ? 'text-blue-800' : 'text-gray-800'}`}>{value}</div></div>;
