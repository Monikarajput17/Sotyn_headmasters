// Printable Payment Advice / Outstanding Statement for one client.
// mam (2026-06-04 post-PO chart, stage 13): "Payment advice with pending
// balance". Opens at /payment-advice/print?client=<name> (or ?bbid=<id>).
// Lists every invoice with billed / received / pending and the totals.
// Royal-blue brand to match the other SEPL print docs.

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api';
import { FiPrinter, FiArrowLeft } from 'react-icons/fi';

const fmtMoney = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (s) => {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  return `${d.getDate()}-${mon}-${String(d.getFullYear()).slice(-2)}`;
};

const COMPANY = {
  name: 'SECURED ENGINEERS PVT. LTD',
  gstin: '03AASCS7836D2Z3',
  pan: 'AASCS7836D',
  head_office: '2480/1, B.K Tower, 1st Floor, Near Grewal Hospital, Gill Road, LUDHIANA, Punjab - 141003, India',
};

export default function PaymentAdvicePrint() {
  const [sp] = useSearchParams();
  const client = sp.get('client') || '';
  const bbid = sp.get('bbid') || '';
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const q = bbid ? `bbid=${encodeURIComponent(bbid)}` : `client=${encodeURIComponent(client)}`;
    api.get(`/collections/payment-advice?${q}`)
      .then(r => setData(r.data))
      .catch(err => setError(err.response?.data?.error || 'Failed to load'));
  }, [client, bbid]);

  if (error) return <div className="min-h-screen flex items-center justify-center text-red-600">{error}</div>;
  if (!data) return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading…</div>;
  const { client: c, invoices, totals } = data;
  const today = new Date();
  const todayStr = `${today.getDate()}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][today.getMonth()]}-${String(today.getFullYear()).slice(-2)}`;

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="bg-white border-b shadow-sm print:hidden sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <button onClick={() => window.history.back()} className="btn btn-secondary flex items-center gap-2"><FiArrowLeft size={14} /> Back</button>
          <button onClick={() => window.print()} className="btn btn-primary flex items-center gap-2"><FiPrinter size={14} /> Print / Save as PDF</button>
        </div>
      </div>

      <div className="max-w-4xl mx-auto bg-white shadow-lg my-6 print:my-0 print:shadow-none border-2 border-gray-800 print:border-black text-[12px] text-gray-900 overflow-hidden">
        <div className="bg-blue-800 text-white py-1.5 px-3 print:bg-blue-800 flex items-center justify-between gap-3">
          <span className="text-[9.5px] opacity-95 font-medium whitespace-nowrap">GSTIN : {COMPANY.gstin}</span>
          <span className="font-extrabold text-[15px] tracking-[0.2em] uppercase leading-none">Payment Advice</span>
          <span className="text-[9.5px] opacity-95 font-medium whitespace-nowrap">PAN : {COMPANY.pan}</span>
        </div>

        <div className="text-center py-1.5 px-3 border-b border-blue-800 bg-gradient-to-b from-blue-50/60 to-white">
          <div className="text-[19px] font-extrabold tracking-tight text-gray-900 leading-tight">{COMPANY.name}</div>
          <div className="text-[9.5px] text-gray-700 mt-0.5 leading-snug"><span className="font-semibold">Head Office:</span> {COMPANY.head_office}</div>
          <div className="text-[10px] font-bold text-blue-800 mt-0.5 uppercase tracking-wide">Outstanding Statement</div>
        </div>

        <div className="grid grid-cols-2 border-b border-gray-800 print:border-black">
          <div className="border-r border-gray-800 print:border-black p-2 bg-blue-50/30 text-[10.5px] leading-snug">
            <div className="text-[9px] uppercase tracking-wider font-bold text-blue-800">Statement For</div>
            <div className="font-extrabold text-[12.5px] leading-tight">{c.company || c.name || '—'}</div>
            {c.name && c.company && c.name !== c.company && <div className="text-gray-700">Attn: {c.name}</div>}
            {c.address && <div className="text-gray-700 whitespace-pre-line">{c.address}</div>}
            {c.state && <div className="text-gray-700">{c.state}</div>}
            {c.gstin && <div><span className="text-gray-500">GSTIN/UIN:</span> <span className="font-semibold">{c.gstin}</span></div>}
          </div>
          <div className="p-2 text-[10.5px] flex flex-col justify-center">
            <div><span className="text-blue-800 font-semibold">Statement Date:</span> <span className="font-bold">{todayStr}</span></div>
            <div className="text-gray-600">{invoices.length} invoice{invoices.length === 1 ? '' : 's'} on record</div>
          </div>
        </div>

        <table className="w-full text-[11px] border-collapse">
          <thead>
            <tr className="border-b-2 border-gray-800 print:border-black bg-blue-800 text-[10px] uppercase tracking-wide font-bold" style={{ color: '#fff' }}>
              <th className="border-r border-blue-900 px-1 py-2 w-8" style={{ color: '#fff' }}>Sl</th>
              <th className="border-r border-blue-900 px-2 py-2 text-left" style={{ color: '#fff' }}>Invoice / Project</th>
              <th className="border-r border-blue-900 px-1 py-2 w-20" style={{ color: '#fff' }}>Date</th>
              <th className="border-r border-blue-900 px-2 py-2 w-24 text-right" style={{ color: '#fff' }}>Billed</th>
              <th className="border-r border-blue-900 px-2 py-2 w-24 text-right" style={{ color: '#fff' }}>Received</th>
              <th className="border-r border-blue-900 px-2 py-2 w-24 text-right" style={{ color: '#fff' }}>Pending</th>
              <th className="border-r border-blue-900 px-1 py-2 w-16" style={{ color: '#fff' }}>Ageing</th>
            </tr>
          </thead>
          <tbody>
            {invoices.length === 0 && <tr><td colSpan="7" className="px-2 py-3 text-center text-gray-400 border-r border-gray-800">No invoices on record for this client.</td></tr>}
            {invoices.map((iv, i) => (
              <tr key={i} className={`align-top ${i % 2 ? 'bg-gray-50/40' : ''}`}>
                <td className="border-r border-b border-gray-800 print:border-black px-1 py-1.5 text-center text-gray-500">{i + 1}</td>
                <td className="border-r border-b border-gray-800 print:border-black px-2 py-1.5">
                  <span className="font-semibold">{iv.invoice_number || '—'}</span>
                  {(iv.project_name || iv.site_name) && <div className="text-[9px] text-gray-500">{iv.project_name || iv.site_name}</div>}
                </td>
                <td className="border-r border-b border-gray-800 print:border-black px-1 py-1.5 text-center text-gray-700">{fmtDate(iv.invoice_date)}</td>
                <td className="border-r border-b border-gray-800 print:border-black px-2 py-1.5 text-right tabular-nums">{fmtMoney(iv.billed)}</td>
                <td className="border-r border-b border-gray-800 print:border-black px-2 py-1.5 text-right tabular-nums text-emerald-700">{fmtMoney(iv.received)}</td>
                <td className="border-r border-b border-gray-800 print:border-black px-2 py-1.5 text-right tabular-nums font-semibold text-red-700">{fmtMoney(iv.pending)}</td>
                <td className="border-r border-b border-gray-800 print:border-black px-1 py-1.5 text-center text-[9px] text-gray-600">{iv.ageing_days != null ? `${iv.ageing_days}d` : ''}{iv.ageing_bucket ? <div className="text-gray-400">{iv.ageing_bucket}</div> : null}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-b-2 border-gray-800 print:border-black bg-blue-800" style={{ color: '#fff' }}>
              <td className="px-2 py-2.5 text-right font-extrabold uppercase text-[12px]" colSpan="3" style={{ color: '#fff' }}>Total</td>
              <td className="border-l border-blue-900 px-2 py-2.5 text-right tabular-nums font-bold" style={{ color: '#fff' }}>{fmtMoney(totals.billed)}</td>
              <td className="border-l border-blue-900 px-2 py-2.5 text-right tabular-nums font-bold" style={{ color: '#fff' }}>{fmtMoney(totals.received)}</td>
              <td className="border-l border-blue-900 px-2 py-2.5 text-right tabular-nums font-extrabold text-[14px]" style={{ color: '#fff' }}>₹ {fmtMoney(totals.pending)}</td>
              <td className="border-l border-blue-900" style={{ color: '#fff' }}></td>
            </tr>
          </tbody>
        </table>

        <div className="px-4 py-3 text-[11px] bg-blue-50/30 border-t border-gray-800 print:border-black">
          <span className="font-bold text-blue-800">Total Pending Balance: ₹ {fmtMoney(totals.pending)}</span>
          <span className="text-gray-600 ml-2">— kindly arrange payment of the outstanding balance at the earliest. Please ignore if already paid.</span>
        </div>

        <div className="flex justify-between items-end px-4 pb-4 pt-6 text-[11px]">
          <div className="text-gray-500">This is a computer-generated statement.</div>
          <div className="text-center"><div className="border-t border-gray-500 pt-1 mt-8 px-6 font-semibold">For {COMPANY.name}</div></div>
        </div>
      </div>

      <style>{`
        @media print {
          @page { size: A4; margin: 8mm; }
          body { background: white !important; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          .print\\:hidden { display: none !important; }
          .print\\:my-0 { margin-top: 0 !important; margin-bottom: 0 !important; }
          .print\\:shadow-none { box-shadow: none !important; }
          .print\\:border-black { border-color: black !important; }
          .print\\:bg-blue-800 { background-color: #1e40af !important; color: #fff !important; }
        }
      `}</style>
    </div>
  );
}
