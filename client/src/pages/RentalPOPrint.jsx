// Rental PO print page — opens at /rental-po/:enquiryId/print.
// Mam (2026-05-16): "where can is pdf of po after create".
//
// Renders a print-styled vendor PO for a rental enquiry: vendor +
// site + rate × days totals + Ajmer's signature block.  Browser's
// Print → Save as PDF handles the actual PDF conversion (same
// pattern as VendorPOPrint.jsx — no server-side PDF library).
//
// Data: /api/rental-tools/enquiries/:id (single fetch, includes
// vendor master fields + linked purchase_orders row).

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';
import { FiPrinter, FiArrowLeft } from 'react-icons/fi';

const fmtMoney = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtDate = (s) => {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const day = d.getDate();
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  const yr = String(d.getFullYear()).slice(-2);
  return `${day}-${mon}-${yr}`;
};

// Company block — same as VendorPOPrint so the printed page looks
// like every other PO leaving the office.  If mam's company details
// change in one place, change them here too (or extract to a shared
// constant later).
const COMPANY = {
  name: 'SECURED ENGINEERS PVT. LTD - 24-25',
  gstin: '03AASCS7836D2Z3',
  pan: 'AASCS7836D',
  state: 'Punjab',
  head_office: '2480/1, B.K Tower, 1st Floor, Near Grewal Hospital, Gill Road, LUDHIANA, Punjab - 141003, India',
};

// Slim rental-specific terms — full 35-clause version on VendorPO
// is overkill for a 3-day scissor-lift rental.  Mam can add to
// these in Settings later if she wants.
const RENTAL_TERMS = [
  'Material to be delivered at the designated site on or before the date of requirement. Late delivery attracts ₹500/day debit.',
  'Vendor is responsible for transportation, loading, unloading and in-transit insurance.',
  'Material must be in working condition and tested before dispatch. Damaged units will be rejected on the spot.',
  'Site Engineer will photograph the material on arrival and on return; both photos form part of the acceptance record.',
  'Return of material must be coordinated with the SEPL rental approver (Ajmer). Material released to vendor only after Ajmer\'s signed acknowledgement.',
  'Rental period starts the day material lands at site and ends the day it is returned. Idle days (no work) are not deductible unless agreed in writing.',
  'GST will be released only against a tax invoice carrying our GSTIN, this PO number, and HSN code. e-Invoice IRN/QR mandatory above ₹5 cr turnover.',
  'Any damage / loss caused during use by SEPL\'s site team will be settled against the vendor\'s deposit / next bill, capped at replacement value.',
  'Payment terms: advance as marked overleaf, balance on return + tax invoice + vendor sign-off, within 7 business days.',
  'This PO is governed by Indian law. Any dispute falls under the exclusive jurisdiction of Ludhiana courts.',
];

export default function RentalPOPrint() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get(`/rental-tools/enquiries/${id}`)
      .then(r => setData(r.data))
      .catch(err => setError(err.response?.data?.error || 'Failed to load'));
  }, [id]);

  if (error) return <div className="min-h-screen flex items-center justify-center text-red-600">{error}</div>;
  if (!data) return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading…</div>;

  // Defensive: if Stage 1 hasn't run yet, no PO exists.
  if (!data.po_number) {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-3">
        <div className="text-amber-700 text-lg">No PO created yet for this enquiry.</div>
        <div className="text-xs text-gray-500">Finalise the rate in Stage 1 first, then return here.</div>
      </div>
    );
  }

  const rate = +data.vendor_rate || 0;
  const days = +data.days_required || 0;
  const unitLabel = data.vendor_rate_unit === 'per_hour' ? 'hour'
                  : data.vendor_rate_unit === 'lumpsum' ? 'lumpsum'
                  : 'day';
  const lineAmount = unitLabel === 'lumpsum' ? rate : (rate * days);
  const advance = +data.po?.advance_amount || 0;
  const total = +data.po?.total_amount || lineAmount;
  const balance = total - advance;

  // Intra-state when vendor is in Punjab, else IGST.  Same logic as
  // VendorPOPrint.  Rental quotes are usually quoted GST-inclusive
  // but we still itemise it on the print so the vendor's accountant
  // is clear.
  const sameState = !data.vendor_state || String(data.vendor_state).trim().toLowerCase() === COMPANY.state.toLowerCase();
  const gstRate = 0.18;
  const subtotal = total / (1 + gstRate);
  const taxAmt = total - subtotal;
  const cgst = sameState ? taxAmt / 2 : 0;
  const sgst = sameState ? taxAmt / 2 : 0;
  const igst = sameState ? 0 : taxAmt;

  return (
    <div className="min-h-screen bg-gray-100 print:bg-white py-6 print:p-0">
      {/* Top toolbar — hidden when printing */}
      <div className="max-w-4xl mx-auto px-4 mb-3 flex justify-between print:hidden">
        <button onClick={() => window.history.back()} className="btn btn-secondary text-sm flex items-center gap-2">
          <FiArrowLeft size={14} /> Back
        </button>
        <button onClick={() => window.print()} className="btn btn-primary text-sm flex items-center gap-2">
          <FiPrinter size={14} /> Print / Save PDF
        </button>
      </div>

      <div className="max-w-4xl mx-auto bg-white shadow-lg print:shadow-none p-8 print:p-6 text-[12px] leading-tight">
        {/* Header */}
        <div className="border-b-2 border-red-700 pb-3 mb-4">
          <div className="flex justify-between items-start">
            <div>
              <div className="text-xl font-bold text-red-700">{COMPANY.name}</div>
              <div className="text-[10px] text-gray-600 mt-1">{COMPANY.head_office}</div>
              <div className="text-[10px] text-gray-600 mt-0.5">GSTIN: {COMPANY.gstin} · PAN: {COMPANY.pan}</div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase text-gray-500">Vendor Purchase Order</div>
              <div className="font-bold text-lg">{data.po_number}</div>
              <div className="text-[10px] text-gray-600">Date: {fmtDate(data.po?.po_date || data.created_at)}</div>
            </div>
          </div>
        </div>

        {/* Two-column vendor/site block */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div className="border rounded p-3">
            <div className="text-[10px] uppercase text-gray-500 font-semibold mb-1">Vendor</div>
            <div className="font-bold">{data.vendor_official_name || data.vendor_name || '—'}</div>
            {data.vendor_firm_name && <div>{data.vendor_firm_name}</div>}
            {data.vendor_contact_person && <div className="text-gray-600 text-[10px]">Attn: {data.vendor_contact_person}</div>}
            {data.vendor_address && <div className="text-gray-600 text-[10px] mt-1">{data.vendor_address}</div>}
            <div className="text-gray-600 text-[10px]">
              {[data.vendor_district, data.vendor_state].filter(Boolean).join(', ')}
            </div>
            {(data.vendor_phone || data.vendor_email) && (
              <div className="text-gray-600 text-[10px] mt-1">
                {data.vendor_phone && <>Phone: {data.vendor_phone}</>}
                {data.vendor_phone && data.vendor_email && ' · '}
                {data.vendor_email && <>Email: {data.vendor_email}</>}
              </div>
            )}
          </div>
          <div className="border rounded p-3">
            <div className="text-[10px] uppercase text-gray-500 font-semibold mb-1">Site / Consignee</div>
            <div className="font-bold">{data.site_name || '—'}</div>
            {data.site_engineer_user_name && (
              <div className="text-[10px] text-gray-600 mt-1">Site Engineer: {data.site_engineer_user_name}</div>
            )}
            {data.site_engineer_name && !data.site_engineer_user_name && (
              <div className="text-[10px] text-gray-600 mt-1">Site Engineer: {data.site_engineer_name}</div>
            )}
            <div className="text-[10px] text-gray-600 mt-1">
              Required From: <strong>{fmtDate(data.date_of_requirement)}</strong>
            </div>
            <div className="text-[10px] text-gray-600">
              Duration: <strong>{data.days_required} day{data.days_required !== 1 ? 's' : ''}</strong>
            </div>
          </div>
        </div>

        {/* Line item */}
        <table className="w-full border-collapse border text-[11px] mb-3">
          <thead className="bg-gray-100">
            <tr>
              <th className="border px-2 py-1.5 text-left">#</th>
              <th className="border px-2 py-1.5 text-left">Tool / Description</th>
              <th className="border px-2 py-1.5 text-right">Rate (₹)</th>
              <th className="border px-2 py-1.5 text-center">Per</th>
              <th className="border px-2 py-1.5 text-right">Qty / Days</th>
              <th className="border px-2 py-1.5 text-right">Amount (₹)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border px-2 py-1.5">1</td>
              <td className="border px-2 py-1.5">
                <div className="font-medium">{data.tool_description || data.tool_name || 'Rental tool / equipment'}</div>
                {data.tool_specifications && <div className="text-gray-500 text-[10px]">{data.tool_specifications}</div>}
              </td>
              <td className="border px-2 py-1.5 text-right tabular-nums">{fmtMoney(rate)}</td>
              <td className="border px-2 py-1.5 text-center">{unitLabel}</td>
              <td className="border px-2 py-1.5 text-right tabular-nums">{unitLabel === 'lumpsum' ? '—' : days}</td>
              <td className="border px-2 py-1.5 text-right tabular-nums font-semibold">{fmtMoney(lineAmount)}</td>
            </tr>
          </tbody>
        </table>

        {/* Totals — right-aligned card */}
        <div className="flex justify-end mb-4">
          <table className="text-[11px] border-collapse">
            <tbody>
              <tr><td className="px-3 py-0.5 text-gray-600">Subtotal (excl. GST)</td><td className="px-3 py-0.5 text-right tabular-nums">{fmtMoney(subtotal)}</td></tr>
              {sameState ? (<>
                <tr><td className="px-3 py-0.5 text-gray-600">CGST @ 9%</td><td className="px-3 py-0.5 text-right tabular-nums">{fmtMoney(cgst)}</td></tr>
                <tr><td className="px-3 py-0.5 text-gray-600">SGST @ 9%</td><td className="px-3 py-0.5 text-right tabular-nums">{fmtMoney(sgst)}</td></tr>
              </>) : (
                <tr><td className="px-3 py-0.5 text-gray-600">IGST @ 18%</td><td className="px-3 py-0.5 text-right tabular-nums">{fmtMoney(igst)}</td></tr>
              )}
              <tr className="border-t-2 font-bold"><td className="px-3 py-1">Total (incl. GST)</td><td className="px-3 py-1 text-right tabular-nums">₹ {fmtMoney(total)}</td></tr>
              {advance > 0 && (<>
                <tr><td className="px-3 py-0.5 text-gray-600">Advance Payable</td><td className="px-3 py-0.5 text-right tabular-nums">{fmtMoney(advance)}</td></tr>
                <tr className="border-t font-semibold"><td className="px-3 py-1">Balance on Return</td><td className="px-3 py-1 text-right tabular-nums">{fmtMoney(balance)}</td></tr>
              </>)}
            </tbody>
          </table>
        </div>

        {/* Terms */}
        <div className="mb-4">
          <div className="text-[10px] uppercase text-gray-500 font-semibold mb-1">Terms & Conditions</div>
          <ol className="text-[10px] text-gray-700 list-decimal pl-4 space-y-0.5">
            {RENTAL_TERMS.map((t, i) => <li key={i}>{t}</li>)}
          </ol>
        </div>

        {/* Signatures */}
        <div className="grid grid-cols-2 gap-6 mt-8">
          <div>
            <div className="border-t border-gray-400 pt-1 text-[10px]">For Vendor (Acceptance)</div>
            <div className="text-[10px] text-gray-500 mt-0.5">Sign + Stamp + Date</div>
          </div>
          <div>
            <div className="border-t border-gray-400 pt-1 text-[10px] text-right">For Sotyn.Headmasters</div>
            <div className="text-[10px] text-gray-500 mt-0.5 text-right">
              {data.rate_finalised_by_name || 'Authorised Signatory'}
            </div>
            <div className="text-[10px] text-gray-500 text-right">Rental Approver</div>
          </div>
        </div>

        <div className="text-center text-[9px] text-gray-400 mt-6 pt-3 border-t">
          This is a computer-generated Purchase Order. No signature required if served digitally.
          · Enquiry Ref: {data.enquiry_no}
        </div>
      </div>
    </div>
  );
}
