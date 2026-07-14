// Printable Debit Note — opens at /debit-note/:id/print.
// mam (2026-06-04 post-PO chart, stage 7): a document SEPL sends a vendor
// to recover value for rejected material, short supply, or excess (extra)
// rates. Browser "Print → Save as PDF" handles the PDF. Royal-blue brand
// to match the Vendor PO print.

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';
import { FiPrinter, FiArrowLeft } from 'react-icons/fi';

const fmtMoney = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (s) => {
  if (!s) return '';
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

const TYPE_META = {
  rejected:     { title: 'DEBIT NOTE', subtitle: 'Rejected Material', blurb: 'Raised to recover the value of material rejected at receiving (returned / not accepted).' },
  extra_rate:   { title: 'DEBIT NOTE', subtitle: 'Excess / Extra Rate', blurb: 'Raised to recover the amount billed in excess of the agreed Purchase Order value.' },
  short_supply: { title: 'SHORT SUPPLY NOTICE', subtitle: 'Short Material', blurb: 'Notice of material ordered but not received in full. Please supply the shortfall or issue a credit.' },
};

export default function DebitNotePrint() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get(`/procurement/debit-notes/${id}/print`)
      .then(r => setData(r.data))
      .catch(err => setError(err.response?.data?.error || 'Failed to load'));
  }, [id]);

  if (error) return <div className="min-h-screen flex items-center justify-center text-red-600">{error}</div>;
  if (!data) return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading…</div>;
  const { dn, items } = data;
  const meta = TYPE_META[dn.type] || TYPE_META.rejected;
  const isShort = dn.type === 'short_supply';

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="bg-white border-b shadow-sm print:hidden sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <button onClick={() => window.history.back()} className="btn btn-secondary flex items-center gap-2">
            <FiArrowLeft size={14} /> Back
          </button>
          <button onClick={() => window.print()} className="btn btn-primary flex items-center gap-2">
            <FiPrinter size={14} /> Print / Save as PDF
          </button>
        </div>
      </div>

      <div className="max-w-4xl mx-auto bg-white shadow-lg my-6 print:my-0 print:shadow-none border-2 border-gray-800 print:border-black text-[12px] text-gray-900 overflow-hidden">
        {/* Title bar */}
        <div className="bg-blue-800 text-white py-1.5 px-3 print:bg-blue-800 flex items-center justify-between gap-3">
          <span className="text-[9.5px] opacity-95 font-medium whitespace-nowrap">GSTIN : {COMPANY.gstin}</span>
          <span className="font-extrabold text-[15px] tracking-[0.2em] uppercase leading-none">{meta.title}</span>
          <span className="text-[9.5px] opacity-95 font-medium whitespace-nowrap">PAN : {COMPANY.pan}</span>
        </div>

        {/* Company */}
        <div className="text-center py-1.5 px-3 border-b border-blue-800 bg-gradient-to-b from-blue-50/60 to-white">
          <div className="text-[19px] font-extrabold tracking-tight text-gray-900 leading-tight">{COMPANY.name}</div>
          <div className="text-[9.5px] text-gray-700 mt-0.5 leading-snug"><span className="font-semibold">Head Office:</span> {COMPANY.head_office}</div>
          <div className="text-[10px] font-bold text-blue-800 mt-0.5 uppercase tracking-wide">{meta.subtitle}</div>
        </div>

        {/* Meta + Vendor */}
        <div className="grid grid-cols-2 border-b border-gray-800 print:border-black">
          <div className="border-r border-gray-800 print:border-black p-2 bg-blue-50/30 text-[10.5px] leading-snug">
            <div className="text-[9px] uppercase tracking-wider font-bold text-blue-800">To (Vendor)</div>
            <div className="font-extrabold text-[12.5px] leading-tight">{dn.vendor_name || '—'}</div>
            {dn.vendor_address && <div className="text-gray-700 whitespace-pre-line">{dn.vendor_address}</div>}
            {(dn.district || dn.state) && <div className="text-gray-700">{[dn.district, dn.state].filter(Boolean).join(', ')}</div>}
            {dn.gstin && <div><span className="text-gray-500">GSTIN/UIN:</span> <span className="font-semibold">{dn.gstin}</span></div>}
            {dn.vendor_phone && <div><span className="text-gray-500">Contact:</span> {dn.vendor_phone}</div>}
          </div>
          <div className="p-0 text-[10.5px]">
            <table className="w-full"><tbody>
              <tr>
                <td className="border-b border-r border-gray-800 print:border-black px-2 py-0.5 w-1/2"><span className="text-blue-800 font-semibold">{isShort ? 'Notice No.' : 'Debit Note No.'}:</span> <span className="font-bold">{dn.dn_number}</span></td>
                <td className="border-b border-gray-800 print:border-black px-2 py-0.5 w-1/2"><span className="text-blue-800 font-semibold">Date :</span> <span className="font-bold">{fmtDate(dn.created_at)}</span></td>
              </tr>
              <tr>
                <td className="border-b border-r border-gray-800 print:border-black px-2 py-0.5"><span className="text-blue-800 font-semibold">Against PO:</span> <span className="font-bold">{dn.po_number || '—'}</span></td>
                <td className="border-b border-gray-800 print:border-black px-2 py-0.5"><span className="text-gray-500">PO Date:</span> {fmtDate(dn.po_date)}</td>
              </tr>
              <tr>
                <td colSpan="2" className="px-2 py-0.5"><span className="text-gray-500">Status:</span> <span className="font-semibold uppercase">{dn.status}</span></td>
              </tr>
            </tbody></table>
          </div>
        </div>

        {/* Reason blurb */}
        <div className="px-3 py-1.5 text-[10.5px] text-gray-700 border-b border-gray-800 print:border-black bg-blue-50/20">
          {dn.reason || meta.blurb}
        </div>

        {/* Items */}
        <table className="w-full text-[11px] border-collapse">
          <thead>
            <tr className="border-b-2 border-gray-800 print:border-black bg-blue-800 text-[10px] uppercase tracking-wide font-bold" style={{ color: '#fff' }}>
              <th className="border-r border-blue-900 px-1 py-2 w-8" style={{ color: '#fff' }}>Sl</th>
              <th className="border-r border-blue-900 px-2 py-2 text-left" style={{ color: '#fff' }}>Description</th>
              <th className="border-r border-blue-900 px-1 py-2 w-24" style={{ color: '#fff' }}>{isShort ? 'Short Qty' : 'Qty'}</th>
              <th className="border-r border-blue-900 px-1 py-2 w-24" style={{ color: '#fff' }}>Rate</th>
              <th className="border-r border-blue-900 px-2 py-2 w-28 text-right" style={{ color: '#fff' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan="5" className="px-2 py-3 text-center text-gray-400 border-r border-gray-800">No line items.</td></tr>
            )}
            {items.map((it, i) => (
              <tr key={i} className="align-top">
                <td className="border-r border-b border-gray-800 print:border-black px-1 py-1.5 text-center text-gray-500">{i + 1}</td>
                <td className="border-r border-b border-gray-800 print:border-black px-2 py-1.5">
                  <span className="font-medium">{it.description || '—'}</span>
                  {it.grn_number && <span className="text-[9px] text-gray-500 ml-1">(GRN {it.grn_number})</span>}
                  {it.remarks && <div className="text-[9px] text-gray-500">{it.remarks}</div>}
                </td>
                <td className="border-r border-b border-gray-800 print:border-black px-1 py-1.5 text-right tabular-nums">{(+it.qty || 0).toLocaleString('en-IN')} {it.unit || ''}</td>
                <td className="border-r border-b border-gray-800 print:border-black px-1 py-1.5 text-right tabular-nums">{it.rate != null ? fmtMoney(it.rate) : '—'}</td>
                <td className="border-r border-b border-gray-800 print:border-black px-2 py-1.5 text-right tabular-nums font-semibold">{fmtMoney(it.amount || (+it.qty || 0) * (+it.rate || 0))}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-b-2 border-gray-800 print:border-black bg-blue-800" style={{ color: '#fff' }}>
              <td className="px-1 py-2.5 text-right font-extrabold uppercase text-[13px]" colSpan="4" style={{ color: '#fff' }}>{isShort ? 'Total Short Value' : 'Total Debit'}</td>
              <td className="border-l border-blue-900 px-2 py-2.5 text-right tabular-nums font-extrabold text-[16px]" style={{ color: '#fff' }}>₹ {fmtMoney(dn.amount)}</td>
            </tr>
          </tbody>
        </table>

        <div className="px-4 py-3 text-[10px] text-gray-600 leading-snug">
          {isShort
            ? 'Please arrange to supply the shortfall against the above PO at the earliest, or confirm a credit for the short-supplied value.'
            : 'The above amount is debited to your account against the referenced Purchase Order and is recoverable from any pending payment or by your credit note.'}
        </div>

        <div className="flex justify-between items-end px-4 pb-4 pt-6 text-[11px]">
          <div className="text-gray-500">This is a computer-generated document.</div>
          <div className="text-center">
            <div className="border-t border-gray-500 pt-1 mt-8 px-6 font-semibold">For {COMPANY.name}</div>
          </div>
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
