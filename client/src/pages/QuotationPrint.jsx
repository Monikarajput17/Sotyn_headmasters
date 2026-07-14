// Printable SEPL Quotation — opens at /quotation/:indentId/print.
// mam (2026-06-06): for Extra (Schedule / Non-Schedule) indents, auto-make a
// client quotation. Each chargeable line is priced from the MOST RECENT
// previous BOQ of the EXACT same item name × the indent qty. Layout follows
// mam's BARAWARE quotation format. Royal-blue brand to match the other prints.

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';
import { FiPrinter, FiArrowLeft } from 'react-icons/fi';

const fmtMoney = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Standard SEPL terms & conditions (from mam's quotation format).
const TERMS = [
  'Estimation value may vary as per the final measurements.',
  'Any alterations to accepted plans and thus the BOQ may lead to discrepancies in the actual amount per applicable item/quantity.',
  'Any kind of changes in approved items in quotation would be chargeable.',
  'Any kind of accessories or fittings not mentioned here, if asked for, would be charged extra.',
  'All types of cabelling work not mentioned in the BOQ would be charged extra.',
  'Any kind of tools and consumables would be in our scope.',
  'Any kind of civil work would be in client scope.',
  'Any kind of Core cutting / wall breaking would be in client scope or if asked would be charged extra.',
  'Ladder / Scaffolding / Crane / Farana etc. would be in client’s scope.',
  'Accomodations like staying, lodging and fooding will be in SEPL scope.',
  'Transportation charges for the manpower will be borne by SEPL.',
  'Transportation charges for material would be extra.',
  'Warranty :- 1 Year or as per manufacturer’s Terms & Conditions applicable from the date of handover.',
  'Warranty (Installation / workmanship) :- 1 Year from the date of handover.',
  'Project Completion :- 90 Days or as per site clearance / availability.',
  'Quotation is valid only for 10 Days.',
  'Fire NOC :- NOC charges to be paid separately or as per actual.',
  'Payment terms :- 50% advance, 40% against Proforma Invoice before dispatch and 10% against testing, commissioning, and handover.',
  'Taxes extra as per actual government rates.',
];

const BLUE = '#1e40af';

export default function QuotationPrint() {
  const { indentId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get(`/procurement/indents/${indentId}/quotation`)
      .then(r => setData(r.data))
      .catch(err => setError(err.response?.data?.error || 'Failed to load'));
  }, [indentId]);

  if (error) return <div className="min-h-screen flex items-center justify-center text-red-600">{error}</div>;
  if (!data) return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading…</div>;

  const { company, quotation, client, items = [], supply_total, basic_amount } = data;
  const anyMissing = items.some(i => !i.rate_found);

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Toolbar — hidden when printing */}
      <div className="bg-white border-b shadow-sm print:hidden sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <button onClick={() => window.history.back()} className="btn btn-secondary flex items-center gap-2"><FiArrowLeft /> Back</button>
          <div className="text-sm text-gray-500">Quotation {quotation.no}</div>
          <button onClick={() => window.print()} className="btn btn-primary flex items-center gap-2"><FiPrinter /> Print / Save PDF</button>
        </div>
      </div>

      <div className="max-w-4xl mx-auto bg-white my-4 print:my-0 shadow print:shadow-none" style={{ fontFamily: 'Georgia, serif' }}>
        {/* Header */}
        <div className="flex items-center gap-4 px-6 pt-6 pb-4">
          <div className="w-20 h-20 border-2 flex items-center justify-center font-bold text-2xl" style={{ borderColor: BLUE, color: BLUE }}>SE</div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold" style={{ color: BLUE }}>{company.name}</h1>
            <div className="text-[11px] text-gray-700 mt-1 leading-relaxed">
              <div><span className="font-semibold">Head Office:</span> {company.ho}</div>
              <div><span className="font-semibold">Corporate Office:</span> {company.co}</div>
              <div><span className="font-semibold">Website:</span> {company.website}</div>
            </div>
          </div>
        </div>

        {/* Title bar */}
        <div className="text-center text-white font-bold tracking-wide py-2" style={{ background: BLUE }}>
          QUOTATION
        </div>

        {/* Client + quotation meta */}
        <div className="grid grid-cols-2 text-[12px] border-b" style={{ borderColor: BLUE }}>
          <div className="p-3 border-r" style={{ borderColor: BLUE }}>
            <div className="text-gray-500 uppercase text-[10px]">Name / Client</div>
            <div className="font-bold">{client.company || client.name || '—'}</div>
            {client.name && client.name !== client.company && <div>{client.name}</div>}
            {client.mobile && <div className="text-gray-600">Mob: {client.mobile}</div>}
            <div className="text-gray-500 uppercase text-[10px] mt-2">Address</div>
            <div>{[client.address, client.district, client.state].filter(Boolean).join(', ') || '—'}</div>
            {client.gstin && <div className="text-gray-600">GSTIN: {client.gstin}</div>}
          </div>
          <div className="p-3 grid grid-cols-2 gap-y-1 content-start">
            <div className="text-gray-500 uppercase text-[10px]">Date</div><div className="text-right font-semibold">{quotation.date}</div>
            <div className="text-gray-500 uppercase text-[10px]">Quotation No</div><div className="text-right font-semibold">{quotation.no}</div>
            <div className="text-gray-500 uppercase text-[10px]">Prep By</div><div className="text-right">SEPL</div>
            <div className="text-gray-500 uppercase text-[10px]">Revision No</div><div className="text-right">0</div>
            {data.indent_number && <><div className="text-gray-500 uppercase text-[10px]">Ref Indent</div><div className="text-right">{data.indent_number}</div></>}
          </div>
        </div>

        {/* Chapter 1 — Supply */}
        <div className="px-6 pt-4">
          <div className="font-bold text-white px-3 py-1.5 flex justify-between" style={{ background: BLUE }}>
            <span>CHAPTER-1 : SUPPLY</span>
            <span>₹ {fmtMoney(supply_total)}</span>
          </div>
          <table className="w-full text-[11.5px] border border-gray-300 border-t-0">
            <thead>
              <tr className="text-white" style={{ background: '#3b54a5' }}>
                <th className="border border-gray-300 px-1 py-1 w-10">S.No.</th>
                <th className="border border-gray-300 px-2 py-1 text-left">Description</th>
                <th className="border border-gray-300 px-1 py-1 w-16">Unit</th>
                <th className="border border-gray-300 px-1 py-1 w-16">Qty</th>
                <th className="border border-gray-300 px-1 py-1 w-24">Rate</th>
                <th className="border border-gray-300 px-1 py-1 w-28">Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan="6" className="border border-gray-300 text-center py-4 text-gray-400">No chargeable (PO) items on this indent.</td></tr>
              )}
              {items.map(it => (
                <tr key={it.sno} className="align-top">
                  <td className="border border-gray-300 px-1 py-1.5 text-center">{it.sno}</td>
                  <td className="border border-gray-300 px-2 py-1.5">
                    {it.description}
                    {!it.rate_found && <span className="ml-1 text-[9px] text-amber-600 font-semibold">(no previous BOQ rate — fill manually)</span>}
                  </td>
                  <td className="border border-gray-300 px-1 py-1.5 text-center">{it.unit}</td>
                  <td className="border border-gray-300 px-1 py-1.5 text-right">{(+it.qty || 0).toLocaleString('en-IN')}</td>
                  <td className="border border-gray-300 px-1 py-1.5 text-right">₹ {fmtMoney(it.rate)}</td>
                  <td className="border border-gray-300 px-1 py-1.5 text-right font-semibold">₹ {fmtMoney(it.amount)}</td>
                </tr>
              ))}
              <tr className="font-bold" style={{ background: '#eef2ff' }}>
                <td className="border border-gray-300 px-2 py-1.5 text-right" colSpan="5">TOTAL</td>
                <td className="border border-gray-300 px-1 py-1.5 text-right">₹ {fmtMoney(supply_total)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Totals */}
        <div className="px-6 pt-3 flex justify-end">
          <table className="text-[12px]">
            <tbody>
              <tr><td className="px-3 py-1 font-bold text-right" style={{ color: BLUE }}>BASIC AMOUNT</td><td className="px-3 py-1 font-bold text-right">₹ {fmtMoney(basic_amount)}</td></tr>
              <tr><td className="px-3 py-1 text-right text-gray-600" colSpan="2">Taxes extra as per actual government rates.</td></tr>
            </tbody>
          </table>
        </div>

        {anyMissing && (
          <div className="px-6 pt-2 print:hidden">
            <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              Some items had no matching previous BOQ rate (priced at ₹0). Add those rates to a BOQ, or edit them before sending.
            </div>
          </div>
        )}

        {/* Terms & Conditions */}
        <div className="px-6 pt-5 pb-3">
          <div className="font-bold text-white px-3 py-1.5" style={{ background: BLUE }}>Terms &amp; Conditions</div>
          <ol className="list-decimal pl-6 text-[10.5px] text-gray-800 leading-relaxed mt-2 space-y-0.5">
            {TERMS.map((t, i) => <li key={i}>{t}</li>)}
          </ol>
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 text-[10.5px] text-gray-600 border-t pt-3 mt-2">
          <div className="italic">“Quality is not an act, it is a habit.”</div>
          <div className="mt-1">We will be happy to supply any further information you may need and trust that you will call on us to fill your order, which will receive our prompt and careful attention.</div>
          <div className="mt-2 text-right font-semibold" style={{ color: BLUE }}>For SECURED ENGINEERS PVT. LTD.</div>
        </div>
      </div>
    </div>
  );
}
