// Print-friendly Vendor PO page — matches Sotyn.Headmasters' standard
// Tally-style PO format: top-right voucher block, side-by-side Vendor /
// Consignee panels, line items with Due-on / Qty / Rate / per / Disc / Amount,
// CGST + SGST + round-off totals, terms block, computer-generated footer.
//
// Opens at /vendor-po/:id/print. Browser's "Print → Save as PDF" handles
// the PDF generation, no server-side library needed.

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';
import { FiPrinter, FiArrowLeft, FiMessageCircle } from 'react-icons/fi';

const fmtMoney = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Date formatter — outputs "6-Feb-26" matching the sample PO.
const fmtDate = (s) => {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const day = d.getDate();
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  const yr = String(d.getFullYear()).slice(-2);
  return `${day}-${mon}-${yr}`;
};

// Company header — single source of truth so it's easy to edit later if
// mam's address / GSTIN changes. Mirrors the SEPL Purchase Order PDF
// format mam shared as the reference layout.
const COMPANY = {
  name: 'SECURED ENGINEERS PVT. LTD',
  gstin: '03AASCS7836D2Z3',
  pan: 'AASCS7836D',
  state: 'Punjab',
  state_code: '03',
  head_office: '2480/1, B.K Tower, 1st Floor, Near Grewal Hospital, Gill Road, LUDHIANA, Punjab - 141003, India',
  branch_office: '91, Springboard, Sector 2, Noida, Uttar Pradesh, India',
};

// Marketing band stats from the reference PDF — 15+ years, 309+ staff, etc.
const STATS = [
  { num: '15+', label: 'YEARS OF\nEXCELLENCE' },
  { num: '309+', label: 'STRONG MANPOWER' },
  { num: '16+', label: 'STATES SERVED' },
  { num: '4+', label: 'COUNTRIES' },
];

// Comprehensive 35-clause Terms & Conditions exactly as on mam's
// reference PO. Stored in a constant so future edits are one place.
const TERMS = [
  ['PO Number Mandatory', 'Our SEPL PO No. {{PO_NUMBER}} must be quoted on every Invoice, Delivery Challan, Packing Slip, Test Certificate, e-Way Bill and all correspondence. Documents without our PO number will not be accepted at site or office.'],
  ['NO PARTIAL DELIVERIES — FULL KITTING MANDATORY', 'Full and complete kitting of the entire ordered scope (all line items, accessories, fasteners, fittings, glands, lugs, terminations and ancillaries) is mandatory. Partial / part-load / split-lot / staggered deliveries are NOT ACCEPTED. Any partial / un-kitted supply will be returned to the vendor at the vendor’s cost and risk, and shall additionally attract LD as per Clause 9.'],
  ['Delivery Note is the ONLY Receiving Document', 'Material receipt at site will be acknowledged EXCLUSIVELY on Sotyn.Headmasters’ Delivery Note (DN). The vendor must obtain dated signature, name and stamp of our authorised site representative on our DN. Do not send your Bill / Invoice for receiving — your bill is for billing/accounting purposes ONLY and will not constitute proof of delivery.'],
  ['Delivery at Site is Vendor’s Responsibility', 'The vendor is solely responsible for transportation, freight, loading, unloading, handling, in-transit insurance, octroi (if any), demurrage and safe delivery of material at the site address designated by Sotyn.Headmasters. No reimbursement of transportation or related charges will be admissible unless specifically agreed in writing in this PO.'],
  ['Test Certificate & Raw Material Traceability', 'Each consignment must carry an OEM/Mill Test Certificate identifying raw-material grade, batch, heat number, MFG date and standard reference (IS/BIS/IEC/ASTM). Goods without TC will be rejected.'],
  ['Packing Slip', 'Every dispatch must include a Packing Slip listing item description, code, HSN, quantity and our PO No. Material received without a Packing Slip will be treated as short-supplied.'],
  ['HSN, GSTIN & e-Invoice', 'Tax Invoice must mention our GSTIN 03AASCS7836D2Z3, correct HSN, place of supply and e-Invoice IRN/QR (where applicable). GST will be released only upon (a) reflection in our GSTR-2B and (b) timely filing by the vendor.'],
  ['Quality & Inspection', 'All goods are subject to inspection at site / vendor’s works / OEM works by Sotyn.Headmasters or its nominee. Right of rejection is absolute; rejected material to be lifted by vendor within 7 days at vendor’s cost, failing which storage charges of 1% per day on invoice value will be debited.'],
  ['Liquidated Damages (LD)', 'For any delay beyond the agreed delivery date, LD shall be levied at 0.5% of the order value per week of delay, capped at 10% of the total PO value, recoverable from any pending payment or by debit note. Time is of the essence of this PO.'],
  ['Warranty / Guarantee (Product-Wise)', 'Goods supplied shall carry warranty as specified per item in the PO / Annexure-A. In the absence of an item-specific warranty, the following minimums apply, whichever is later: (a) Cables, Wires, Conduits, Fasteners, Consumables — 12 months from commissioning or 18 months from dispatch; (b) Panels, Switchgear, MCBs/MCCBs, Starters, DBs, Lighting Fixtures, Pumps, Motors, ELV, Plumbing Fittings — 24 months from commissioning or 30 months from dispatch; (c) HVAC Equipment, Fire-Fighting Equipment, Solar Modules & Inverters, BMS, VFDs and OEM-branded major equipment — 36 months (3 years) from commissioning or 42 months from dispatch; (d) Solar PV modules shall additionally carry the OEM’s standard performance warranty (10/25 years) extended directly to Sotyn.Headmasters / End-Client. Defective items shall be replaced / repaired free of cost including freight both ways, with attendance at site within 72 hours of intimation.'],
  ['Price Firmness & Excess Supply', 'Rates are firm till completion of supply, irrespective of any market / forex / commodity fluctuation. Buyer is under no obligation to accept goods supplied in excess of ordered quantity; such excess shall be returned at vendor’s cost.'],
  ['Right to Cancel / Amend', 'Sotyn.Headmasters reserves the unconditional right to cancel, amend, reduce, foreclose or hold this PO in whole or in part at any time without liability for consequential loss to the vendor.'],
  ['Indemnity', 'The vendor shall fully indemnify and hold harmless Sotyn.Headmasters, its directors, employees and clients against any claim, loss, penalty, fine or damage (including legal cost) arising out of (a) defective material / workmanship, (b) statutory or regulatory non-compliance, (c) IP / patent infringement, (d) acts, omissions or accidents of vendor’s personnel, or (e) third-party injury / property damage attributable to vendor’s supply.'],
  ['Confidentiality & Non-Solicitation', 'Drawings, specifications, BOQ, rates, client name, site information and any data shared by Sotyn.Headmasters are strictly confidential and the property of Sotyn.Headmasters. The vendor shall not disclose, sub-contract, reuse or market the same, nor solicit any client / employee of Sotyn.Headmasters, without prior written consent. This obligation shall survive termination for 3 years.'],
  ['Safety, Insurance & Statutory Compliance', 'Vendor’s personnel (if visiting site) shall comply with PPE, EHS, BOCW, applicable labour, ESI, PF and all statutory norms. Vendor shall maintain valid in-transit, workmen’s compensation and public-liability insurance. Sotyn.Headmasters bears NO liability for vendor’s personnel, equipment or sub-contractors.'],
  ['GST Reimbursement Clawback', 'If any input tax credit, refund or other benefit is denied / delayed / reversed against Sotyn.Headmasters due to vendor’s non-compliance (non-upload on GSTN, non-payment of GST, incorrect documents, GSTIN cancellation), vendor shall reimburse the full loss including interest and penalty, by debit note adjustable against any pending dues, within 15 days of intimation.'],
  ['Set-Off / Recovery', 'Sotyn.Headmasters reserves the unilateral right to set-off / adjust / recover any amount due from the vendor under this or any other PO / contract / order against any payment payable to the vendor, present or future.'],
  ['Force Majeure', 'Neither party shall be liable for delay caused by genuine Force Majeure events. The affected party must notify in writing within 7 days with documentary proof, failing which the defence shall not be available. If FM continues beyond 30 days, Sotyn.Headmasters may terminate without liability.'],
  ['Acceptance', 'Acceptance of this PO (by acknowledgement, dispatch of goods, or commencement of work) shall constitute unconditional acceptance of these Terms & Conditions in their entirety. Any vendor’s printed terms on invoices / challans / quotations shall stand OVERRIDDEN in their entirety.'],
  ['Title, Risk & Acceptance Transfer', 'Title and risk in the goods shall pass to Sotyn.Headmasters only upon (a) receipt of acceptable goods at site against our DN, AND (b) successful site inspection / testing / commissioning. Mere dispatch, billing or transit-handover shall NOT constitute acceptance.'],
  ['No Sub-Contracting / No Substitution', 'The vendor shall not sub-contract, assign, transfer or novate this PO (in whole or part) to any third party without prior written consent of Sotyn.Headmasters. The make / brand / model / origin of goods shall not be substituted; any deviation requires written approval, failing which goods shall be liable for outright rejection.'],
  ['Anti-Bribery, Anti-Corruption & Conflict of Interest', 'The vendor warrants that it has not, and will not, offer any gift, kickback, commission or undue advantage to any director, employee or representative of Sotyn.Headmasters or its clients. Breach shall entitle Sotyn.Headmasters to terminate the PO with immediate effect, blacklist the vendor, forfeit all pending payments, and pursue criminal / civil action.'],
  ['Compliance with Laws & Standards', 'All goods / services shall comply with applicable Indian laws, IS / BIS / IEC / NBC / NEC / NFPA / ASHRAE / MNRE / CEA / state electrical / fire / pollution / environmental codes, as relevant. Vendor confirms it holds all valid licences, registrations and statutory approvals required to perform this PO.'],
  ['Performance Security / Retention', 'Sotyn.Headmasters reserves the right to retain 5%–10% of each invoice value as Performance Retention, releasable only upon expiry of the warranty period and final acceptance, OR to demand a Bank Guarantee (BG) of equivalent value valid up to warranty expiry plus claim period. Retention shall not earn any interest.'],
  ['Audit & Document Rights', 'Sotyn.Headmasters and its auditors / clients shall have the right, upon reasonable notice, to audit the vendor’s invoices, GST returns, dispatch records, MTC, calibration certificates and quality records pertaining to this PO, for up to 7 years from the PO date.'],
  ['Spare Parts & O&M Documentation', 'The vendor shall guarantee availability of spares and after-sales service for a minimum of 10 years from the date of commissioning. Operations & Maintenance manuals, wiring / GA drawings, calibration certificates and as-built documents (in editable + PDF) shall be supplied along with the goods at no additional cost.'],
  ['Free Replacement & Site Attendance', 'During the warranty period, all defects / failures / under-performance shall be rectified by free replacement / repair at site by the vendor, without dismantling cost, transport cost or labour cost on Sotyn.Headmasters’ account. Maximum response time: 72 hours; maximum resolution time: 7 days, failing which Sotyn.Headmasters may rectify at vendor’s risk and cost (recoverable from BG / retention / future bills).'],
  ['Data Protection & Records', 'Any personal / commercial data of Sotyn.Headmasters, its employees or clients shared with the vendor shall be processed solely for performance of this PO, kept secure, and returned / destroyed on completion. Breach shall attract recovery of all consequential damages.'],
  ['Background & Antecedent Verification', 'The vendor warrants that its proprietors / directors / authorised signatories have no adverse criminal, financial, tax-default or regulatory record. Sotyn.Headmasters reserves the right to seek and verify such records at any time.'],
  ['No Lien / No Counter-Claim', 'The vendor shall not exercise any lien on Sotyn.Headmasters’ / Client’s property, drawings, tools or material in its possession, on account of any disputed claim, and shall release the same on demand.'],
  ['Notices', 'All formal notices under this PO shall be sent to Sotyn.Headmasters’ registered Head Office address (Ludhiana) by Email + Registered Post / Courier. Verbal commitments by site / field personnel are NOT BINDING on Sotyn.Headmasters.'],
  ['Severability & Survival', 'If any clause is held invalid, the remaining clauses shall continue in full force. Clauses on Warranty, Confidentiality, Indemnity, Set-Off, Audit, Anti-Corruption and Dispute Resolution shall survive completion / termination of this PO.'],
  ['Governing Law', 'This Purchase Order shall be governed by and construed in accordance with the laws of India.'],
  ['Acceptance of these Terms is unconditional', 'upon any dispatch / part-performance / acknowledgement of this PO. Vendor’s silence within 3 working days of receipt of this PO shall be deemed acceptance of all terms herein.'],
  ['Dispute Resolution & Jurisdiction', 'Any dispute, difference or claim arising out of or in connection with this Purchase Order shall first be referred to and finally resolved by sole arbitration of the Company Arbiter — Advocate Vikas Sharma, whose decision shall be binding on both parties. Arbitration shall be conducted under the Arbitration & Conciliation Act, 1996 (as amended), seat Ludhiana, language English. Subject to the foregoing, courts at Ludhiana shall have exclusive jurisdiction.'],
];

export default function VendorPOPrint() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get(`/procurement/vendor-po/${id}/print`)
      .then(r => setData(r.data))
      .catch(err => setError(err.response?.data?.error || 'Failed to load'));
  }, [id]);

  if (error) return <div className="min-h-screen flex items-center justify-center text-red-600">{error}</div>;
  if (!data) return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading…</div>;
  const { po, items } = data;

  // Subtotal across line items.  Uses the LIVE rate from
  // indent_item_rates.final_rate when present (mam, 2026-05-21:
  // "update here if i update rate in 3 vendor"), falling back to the
  // PO-frozen rate, then to the stored amount.
  const subtotal = items.reduce((s, it) => {
    const r = (it.latest_rate != null && +it.latest_rate > 0) ? +it.latest_rate : +it.rate;
    return s + (+r * +it.quantity || +it.amount || 0);
  }, 0);

  // Freight (mam 2026-06-12). Added to the taxable value so GST is charged
  // on (goods + freight), matching how vendors bill freight. freight_terms
  // ('Ex-Works' / 'FOR') prints in the Terms block below.
  const freightAmount = +po.freight_amount || 0;
  const taxable = subtotal + freightAmount;

  // GST split. Same-state vendor → CGST 9% + SGST 9% (intra). Different
  // state → IGST 18%. Defaults to intra-state when state is missing,
  // matching mam's sample (Punjab buyer, Punjab vendor).
  const sameState = !po.state || String(po.state).trim().toLowerCase() === COMPANY.state.toLowerCase();
  const gstRate = 0.18;
  const cgst = sameState ? taxable * (gstRate / 2) : 0;
  const sgst = sameState ? taxable * (gstRate / 2) : 0;
  const igst = sameState ? 0 : taxable * gstRate;

  // Round to nearest rupee — the difference between the rupee total and
  // the paise-precision running total goes on the ROUND OFF line. So the
  // grand total is always clean rupees.
  const beforeRound = taxable + cgst + sgst + igst;
  const grandTotal = Math.round(beforeRound);
  const roundOff = +(grandTotal - beforeRound).toFixed(2);

  // Total quantity sum (e.g. "60 LTR") — uses the most common unit across
  // line items. Falls back to "—" if mixed.
  const totalQty = items.reduce((s, it) => s + (+it.quantity || 0), 0);
  const units = [...new Set(items.map(it => (it.unit || it.uom || '').toUpperCase()).filter(Boolean))];
  const totalUnit = units.length === 1 ? units[0] : '';

  // Payment Terms — mam (2026-06-04).  The term AND its credit days are
  // taken from the SAME source so they never mismatch (e.g. an "Advance"
  // term must not borrow "30 days" from the vendor master).  Priority:
  //   1. Terms entered on the PO itself (vendor_pos.payment_terms).
  //   2. Terms from the Finalise-Rate step (indent_item_rates.final_terms);
  //      per-item — first line that has terms wins for the header.
  //   3. The Vendor master default (vendors.payment_terms).
  //   4. Any per-line terms frozen on the PO items.
  const hasVal = (s) => s != null && String(s).trim() !== '';
  const finalTermsItem = items.find(it => hasVal(it.final_terms));
  const lineTermsItem = items.find(it => hasVal(it.terms));
  const termsSource =
      hasVal(po.payment_terms)        ? { t: po.payment_terms,            d: po.credit_days }
    : finalTermsItem                  ? { t: finalTermsItem.final_terms,  d: finalTermsItem.final_credit_days }
    : hasVal(po.vendor_payment_terms) ? { t: po.vendor_payment_terms,     d: po.vendor_credit_days }
    : lineTermsItem                   ? { t: lineTermsItem.terms,         d: lineTermsItem.credit_days }
    : null;
  const payTermsText = termsSource ? String(termsSource.t).trim() : '';
  // Credit days only make sense for a credit-type term — "Advance (30
  // days)" / "COD (30 days)" is nonsensical.  Show the suffix only when
  // the term is Credit (or contains "credit"), and render as a whole
  // number so "30.0" doesn't leak through.
  const isCreditTerm = /credit/i.test(payTermsText);
  const payCreditDays = (isCreditTerm && termsSource && +termsSource.d > 0)
    ? Math.round(+termsSource.d) : null;

  const sharePO = () => {
    const phone = String(po.vendor_phone || '').replace(/\D/g, '');
    const url = window.location.href;
    const msg = `*PO ${po.po_number}* from ${COMPANY.name}\n\nDear ${po.contact_person || po.vendor_name || 'Sir/Madam'},\n\nPlease find our Purchase Order below. View / download:\n${url}\n\nTotal: ₹ ${fmtMoney(grandTotal)}\n\nRegards,\nSEPL`;
    if (!phone) {
      window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
    } else {
      const code = phone.length === 10 ? '91' + phone : phone;
      window.open(`https://wa.me/${code}?text=${encodeURIComponent(msg)}`, '_blank');
    }
  };

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Action bar — hidden on print */}
      <div className="bg-white border-b shadow-sm print:hidden sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <button onClick={() => window.history.back()} className="btn btn-secondary flex items-center gap-2">
            <FiArrowLeft size={14} /> Back
          </button>
          <div className="flex gap-2">
            <button onClick={sharePO} className="btn btn-success flex items-center gap-2" title="Share via WhatsApp">
              <FiMessageCircle size={14} /> WhatsApp
            </button>
            <button onClick={() => window.print()} className="btn btn-primary flex items-center gap-2">
              <FiPrinter size={14} /> Print / Save as PDF
            </button>
          </div>
        </div>
      </div>

      {/* PO body — printable. Branded Tally style with SEPL red accents.
          The outer text color is locked to gray-900 so no inherited link
          color (e.g. visited link blue) bleeds into descriptions. */}
      <div className="max-w-4xl mx-auto bg-white shadow-lg my-6 print:my-0 print:shadow-none border-2 border-gray-800 print:border-black text-[12px] text-gray-900 overflow-hidden po-body">
        {/* RED branded title bar — pops the document immediately as a SEPL PO */}
        {/* Mam (2026-06-04): "do it some congested" — the title bar had too
            much empty height.  GSTIN / PAN now flank the title on the SAME
            row so the band is a single tight line instead of three. */}
        <div className="bg-blue-800 text-white py-1.5 px-3 print:bg-blue-800 flex items-center justify-between gap-3">
          <span className="text-[9.5px] opacity-95 font-medium whitespace-nowrap">GSTIN : {COMPANY.gstin}</span>
          <span className="font-extrabold text-[15px] tracking-[0.3em] uppercase leading-none">Purchase Order</span>
          <span className="text-[9.5px] opacity-95 font-medium whitespace-nowrap">PAN : {COMPANY.pan}</span>
        </div>

        {/* Company name + Head Office + Branch Office addresses.
            Mam (2026-05-21): the items table was sitting too far down
            the page — compressed all the marketing rows above it. */}
        <div className="text-center py-1.5 px-3 border-b border-blue-800 bg-gradient-to-b from-blue-50/60 to-white">
          <div className="text-[19px] font-extrabold tracking-tight text-gray-900 leading-tight">{COMPANY.name}</div>
          <div className="text-[9.5px] text-gray-700 mt-0.5 leading-snug">
            <span className="font-semibold">Head Office:</span> {COMPANY.head_office}
            <span className="mx-2 text-gray-400">|</span>
            <span className="font-semibold">Corporate Office:</span> {COMPANY.branch_office}
          </div>
        </div>

        {/* Marketing band — compact one-row strip combining tagline,
            stat chips, presence, and service lines.  Was 4 separate
            bands taking ~120px; now a single ~28px band. */}
        <div className="border-b border-blue-800 bg-blue-50/40 print:bg-blue-50">
          <div className="flex items-center justify-center gap-3 py-1 px-3 text-[9.5px] flex-wrap">
            <span className="font-extrabold uppercase tracking-wider text-blue-800">A Leading Engineering Company of India</span>
            <span className="text-gray-400">•</span>
            {STATS.map((s, i) => (
              <span key={i} className="whitespace-nowrap">
                <span className="font-extrabold text-blue-800">{s.num}</span>
                <span className="text-gray-600 ml-0.5 uppercase text-[8.5px]">{s.label.replace(/\n/g, ' ')}</span>
              </span>
            ))}
          </div>
          <div className="text-center text-[9px] text-gray-700 px-3 py-0.5 border-t border-blue-200 leading-snug">
            <span className="text-blue-800 font-bold uppercase">Pan-India:</span>
            <span className="font-bold text-gray-900 ml-1">LUDHIANA | NOIDA | BANGALORE | MUMBAI</span>
            <span className="text-gray-400 mx-2">•</span>
            <span className="text-gray-600">Specialists in </span>
            <span className="font-extrabold text-blue-800">ELECTRICAL | HVAC | FIRE SAFETY | PLUMBING | SOLAR | ELV</span>
          </div>
        </div>

        {/* TWO-COLUMN HEADER: Details of Vendor (left) | Voucher meta (right).
            Tightened padding for the post-2026-05-21 compact layout. */}
        <div className="grid grid-cols-2 border-b border-gray-800 print:border-black">
          <div className="border-r border-gray-800 print:border-black p-2 bg-blue-50/30 text-[10.5px] leading-snug">
            <div className="text-[9px] uppercase tracking-wider font-bold text-blue-800">Details of Vendor</div>
            <div className="font-extrabold text-[12.5px] leading-tight">{po.vendor_name || '—'}</div>
            {po.firm_name && po.firm_name !== po.vendor_name && <div>{po.firm_name}</div>}
            {po.vendor_address && <div className="text-gray-700 whitespace-pre-line">{po.vendor_address}</div>}
            {(po.district || po.state) && <div className="text-gray-700">{[po.district, po.state].filter(Boolean).join(', ')} - India</div>}
            {po.gst_number && <div><span className="text-gray-500">GSTIN/UIN:</span> <span className="font-semibold">{po.gst_number}</span></div>}
            {po.state && <div><span className="text-gray-500">State:</span> {po.state}{po.state_code ? `, Code ${po.state_code}` : ''}</div>}
          </div>
          <div className="p-0 text-[10.5px]">
            <table className="w-full">
              <tbody>
                <tr>
                  <td className="border-b border-r border-gray-800 print:border-black px-2 py-0.5 w-1/2"><span className="text-blue-800 font-semibold">Voucher No.:</span> <span className="font-bold">SEPL-{po.id}</span></td>
                  <td className="border-b border-gray-800 print:border-black px-2 py-0.5 w-1/2"><span className="text-blue-800 font-semibold">Date :</span> <span className="font-bold">{fmtDate(po.po_date || po.created_at)}</span></td>
                </tr>
                <tr>
                  <td className="border-b border-r border-gray-800 print:border-black px-2 py-0.5"><span className="text-blue-800 font-semibold">SEPL PO No.:</span> <span className="font-bold">{po.po_number || ''}</span></td>
                  <td className="border-b border-gray-800 print:border-black px-2 py-0.5"><span className="text-gray-500">Vendor Code:</span> <span className="font-mono">{po.vendor_code || ''}</span></td>
                </tr>
                <tr>
                  <td className="border-b border-r border-gray-800 print:border-black px-2 py-0.5"><span className="text-blue-800 font-semibold">SEPL Indent No.:</span> <span className="font-bold">{po.indent_number || ''}</span></td>
                  <td className="border-b border-gray-800 print:border-black px-2 py-0.5"><span className="text-gray-500">Contact Person:</span> <span className="font-medium">{po.contact_person || ''}</span></td>
                </tr>
                <tr>
                  <td className="border-b border-r border-gray-800 print:border-black px-2 py-0.5"><span className="text-gray-500">SEPL Lead No.:</span> <span className="font-medium">{po.sepl_lead_no || ''}</span></td>
                  <td className="border-b border-gray-800 print:border-black px-2 py-0.5"><span className="text-gray-500">Contact No.:</span> <span className="font-medium">{po.vendor_phone || ''}</span></td>
                </tr>
                <tr>
                  <td colSpan="2" className="px-2 py-0.5"><span className="text-gray-500">Ref Quote No.:</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* TWO-COLUMN: Supplier (Bill from) | Consignee (Ship to).
            Tightened padding 2026-05-21. */}
        <div className="grid grid-cols-2 border-b border-gray-800 print:border-black">
          <div className="border-r border-gray-800 print:border-black p-2 text-[10.5px] bg-amber-50/30 leading-snug">
            <div className="text-[9px] uppercase tracking-wider font-bold text-amber-700">Supplier (Bill from)</div>
            <div className="font-extrabold text-[12px] leading-tight">{po.vendor_name || '—'}</div>
            {po.vendor_address && <div className="whitespace-pre-line text-gray-700">{po.vendor_address}</div>}
            {(po.district || po.state) && <div className="text-gray-700">{[po.district, po.state].filter(Boolean).join(', ')} - India</div>}
            {po.gst_number && <div><span className="text-gray-500">GSTIN/UIN:</span> <span className="font-semibold">{po.gst_number}</span></div>}
            {po.state && <div><span className="text-gray-500">State:</span> {po.state}{po.state_code ? `, Code ${po.state_code}` : ''}</div>}
          </div>
          <div className="p-2 text-[10.5px] bg-emerald-50/30 leading-snug">
            <div className="text-[9px] uppercase tracking-wider font-bold text-emerald-700">Consignee (Ship to)</div>
            <div className="font-extrabold text-[12px] leading-tight">{po.site_name || COMPANY.name}</div>
            {po.sepl_lead_no && (
              <div className="text-[9.5px] text-gray-700">
                Lead: <span className="font-mono font-semibold">{po.sepl_lead_no}</span>
              </div>
            )}
            {po.client_address_bb && (
              <div className="text-[9px] text-gray-600 whitespace-pre-line leading-tight mt-0.5">
                <span className="text-gray-500">Client Address:</span> {po.client_address_bb}
              </div>
            )}
            <div className="text-[9px] text-gray-600 italic mt-0.5">
              Ship to the site above. Coordinate exact address with the site engineer{po.site_engineer_name ? ` — ${po.site_engineer_name}` : ''}.
            </div>
            <div className="text-[9.5px] text-gray-700 mt-0.5">
              Site Engineer :- {po.site_engineer_name || ''}
              <span className="mx-1 text-gray-400">|</span>
              Mobile Number :- {po.raised_by_phone || ''}
            </div>
          </div>
        </div>

        {/* ITEMS TABLE — 8 columns matching the sample. Improvements over v1:
            - Subtle alternating row tint for readability across many lines
            - First-line of description bold; spec / make / item-code in
              smaller secondary line so the eye scans the item name first
            - Item code shown as a mono-font chip (e.g. PO-0042) for fast
              cross-reference with Item Master and Inventory
            - Totals block visually separated; CGST/SGST in muted text;
              Grand Total in bold + larger size + thicker top border
            - All cells have explicit borders (incl. rightmost Amount column)
              so the table reads as a single tight grid even when the page
              is wider than the content. */}
        <table className="w-full text-[11px] border-collapse">
          <thead>
            <tr className="border-b-2 border-gray-800 print:border-black bg-blue-800 text-[10px] uppercase tracking-wide font-bold print:bg-blue-800" style={{ color: '#ffffff' }}>
              <th className="border-r border-blue-900 print:border-black px-1 py-2 w-8" style={{ color: '#ffffff' }}>Sl<br/>No.</th>
              <th className="border-r border-blue-900 print:border-black px-2 py-2 text-left" style={{ color: '#ffffff' }}>Description of Goods</th>
              <th className="border-r border-blue-900 print:border-black px-1 py-2 w-16" style={{ color: '#ffffff' }}>Type</th>
              <th className="border-r border-blue-900 print:border-black px-1 py-2 w-20" style={{ color: '#ffffff' }}>Quantity</th>
              <th className="border-r border-blue-900 print:border-black px-1 py-2 w-20" style={{ color: '#ffffff' }}>Rate</th>
              <th className="border-r border-blue-900 print:border-black px-1 py-2 w-12" style={{ color: '#ffffff' }}>per</th>
              <th className="border-r border-blue-900 print:border-black px-1 py-2 w-12" style={{ color: '#ffffff' }}>Disc.%</th>
              <th className="border-r border-blue-900 print:border-black px-2 py-2 w-24 text-right" style={{ color: '#ffffff' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => {
              const desc = it.master_name || it.description || '—';
              const detail = [it.size, it.specification].filter(Boolean).join(' · ');
              const make = it.im_make || it.ii_make;
              // UOM source priority: item_master.uom is the canonical
              // unit (mam, 2026-05-15 normalised the master); fall back
              // to whatever the indent line was raised with.
              // Pipe lines are stored & PO'd in KG (quantity = kg); the
              // original meters ride along in original_qty_mtr for "show both".
              const isPipe = +it.weight_per_meter > 0;
              const unit = isPipe ? 'KG' : String(it.uom || it.unit || '').toUpperCase();
              // Mam (2026-05-21): "update here if i update rate in 3
              // vendor" — prefer the latest finalised rate from the
              // Vendor Rates step over the PO-frozen rate.  Drift
              // shown via a small "updated" badge below.
              const liveRate = (it.latest_rate != null && +it.latest_rate > 0) ? +it.latest_rate : +it.rate;
              const rateDrift = +it.rate && +it.latest_rate && +it.latest_rate !== +it.rate;
              const amount = +liveRate * +it.quantity || +it.amount || 0;
              // Per-item TYPE — the procurement classification of the
              // line (PO / FOC / RGP).  Mam's reference PO replaced the
              // old "Due on" date column with this item-wise type.
              // Sourced from indent_items.item_type, falling back to the
              // item_master.type it was mirrored from.
              const itemType = (it.item_type || it.im_type || '').toUpperCase();
              const stripeBg = idx % 2 === 1 ? 'bg-gray-50/40' : '';
              return (
                <tr key={it.id} className={`align-top ${stripeBg}`}>
                  <td className="border-r border-gray-800 print:border-black px-1 py-2 text-center text-gray-500">{idx + 1}</td>
                  <td className="border-r border-gray-800 print:border-black px-2 py-2 text-gray-900">
                    {/* Item code chip + bold name on first visual line, then
                        a subtle secondary line with size · spec · make so
                        long descriptions don't dominate the cell. Explicit
                        dark text colors so no inherited link color bleeds in. */}
                    <div className="flex items-baseline gap-1.5 flex-wrap">
                      {it.item_code && <span className="font-mono text-[9px] text-gray-500 bg-gray-100 px-1 py-0.5 rounded">{it.item_code}</span>}
                      {/* Mam (2026-05-22): unit (MTR / KG / NOS) is
                          already shown in the Quantity column AND the
                          Per column — appending it to the description
                          here was triple-printing it ("ARMOURED WIRE MTR
                          · 300 MTR · MTR").  Description shows the name
                          only now. */}
                      <span className="font-bold text-[11.5px] leading-snug text-gray-900" style={{ color: '#111827' }}>{desc}</span>
                    </div>
                    {(detail || make) && (
                      <div className="text-[9.5px] text-gray-700 mt-0.5 leading-tight">
                        {detail && <span>{detail}</span>}
                        {detail && make && <span className="mx-1">·</span>}
                        {make && <span>Make: <span className="font-semibold text-gray-800">{make}</span></span>}
                      </div>
                    )}
                  </td>
                  <td className="border-r border-gray-800 print:border-black px-1 py-2 text-center font-semibold text-gray-700">{itemType}</td>
                  <td className="border-r border-gray-800 print:border-black px-1 py-2 text-right tabular-nums font-bold">
                    {(+it.quantity || 0).toLocaleString('en-IN')} {unit}
                    {isPipe && +it.original_qty_mtr > 0 && (
                      <div className="text-[8.5px] font-normal text-gray-500">({(+it.original_qty_mtr).toLocaleString('en-IN')} MTR × {it.weight_per_meter} kg/pipe)</div>
                    )}
                  </td>
                  {/* Rate cell — shows current rate only.  Mam
                      (2026-05-21): the audit-trail "was X · updated"
                      badge that previously appeared here when the
                      Vendor Rates step had a newer final_rate is
                      removed.  This page IS the vendor-facing
                      document — any "was X" hint leaks confidential
                      negotiation history to the supplier.  Drift
                      audit lives in the Vendor Rates screen instead. */}
                  <td className="border-r border-gray-800 print:border-black px-1 py-2 text-right tabular-nums">
                    {fmtMoney(liveRate)}
                  </td>
                  <td className="border-r border-gray-800 print:border-black px-1 py-2 text-center text-gray-600">{unit}</td>
                  <td className="border-r border-gray-800 print:border-black px-1 py-2 text-right text-gray-500">{it.disc_pct ? `${it.disc_pct}%` : ''}</td>
                  <td className="border-r border-gray-800 print:border-black px-2 py-2 text-right tabular-nums font-bold text-gray-900">{fmtMoney(amount)}</td>
                </tr>
              );
            })}

            {/* SUBTOTAL — bold separator line */}
            <tr className="border-t-2 border-gray-800 print:border-black">
              <td className="border-r border-gray-800 print:border-black px-1 py-1.5"></td>
              <td colSpan="6" className="border-r border-gray-800 print:border-black px-2 py-1.5 text-right text-[11px] font-semibold text-gray-700">Sub Total</td>
              <td className="border-r border-gray-800 print:border-black px-2 py-1.5 text-right tabular-nums font-bold">{fmtMoney(subtotal)}</td>
            </tr>

            {/* Freight — shown only when a charge is entered. Added to the
                taxable value, so the GST lines below are on (goods + freight). */}
            {freightAmount > 0 && (
              <tr className="text-gray-700">
                <td className="border-r border-gray-800 print:border-black px-1 py-1"></td>
                <td colSpan="6" className="border-r border-gray-800 print:border-black px-2 py-1 text-right">
                  Freight{po.freight_terms ? ` (${po.freight_terms})` : ''}
                </td>
                <td className="border-r border-gray-800 print:border-black px-2 py-1 text-right tabular-nums">{fmtMoney(freightAmount)}</td>
              </tr>
            )}

            {/* GST + Round off — muted */}
            {sameState ? (
              <>
                <tr className="text-gray-600">
                  <td className="border-r border-gray-800 print:border-black px-1 py-1"></td>
                  <td colSpan="6" className="border-r border-gray-800 print:border-black px-2 py-1 text-right italic">CGST @ 9%</td>
                  <td className="border-r border-gray-800 print:border-black px-2 py-1 text-right tabular-nums">{fmtMoney(cgst)}</td>
                </tr>
                <tr className="text-gray-600">
                  <td className="border-r border-gray-800 print:border-black px-1 py-1"></td>
                  <td colSpan="6" className="border-r border-gray-800 print:border-black px-2 py-1 text-right italic">SGST @ 9%</td>
                  <td className="border-r border-gray-800 print:border-black px-2 py-1 text-right tabular-nums">{fmtMoney(sgst)}</td>
                </tr>
              </>
            ) : (
              <tr className="text-gray-600">
                <td className="border-r border-gray-800 print:border-black px-1 py-1"></td>
                <td colSpan="6" className="border-r border-gray-800 print:border-black px-2 py-1 text-right italic">IGST @ 18%</td>
                <td className="border-r border-gray-800 print:border-black px-2 py-1 text-right tabular-nums">{fmtMoney(igst)}</td>
              </tr>
            )}
            {Math.abs(roundOff) > 0.001 && (
              <tr className="text-gray-500">
                <td className="border-r border-gray-800 print:border-black px-1 py-1"></td>
                <td colSpan="6" className="border-r border-gray-800 print:border-black px-2 py-1 text-right italic">Round Off</td>
                <td className="border-r border-gray-800 print:border-black px-2 py-1 text-right tabular-nums">{fmtMoney(roundOff)}</td>
              </tr>
            )}

            {/* GRAND TOTAL — red branded bg, larger fonts for visual pop */}
            <tr className="border-t-2 border-b-2 border-gray-800 print:border-black bg-blue-800 print:bg-blue-800" style={{ color: '#ffffff' }}>
              <td className="border-r border-blue-900 print:border-black px-1 py-3 text-right font-extrabold uppercase text-[13px] tracking-wide" colSpan="3" style={{ color: '#ffffff' }}>Grand Total</td>
              <td className="border-r border-blue-900 print:border-black px-1 py-3 text-right tabular-nums font-bold text-[13px]" style={{ color: '#ffffff' }}>{totalQty.toLocaleString('en-IN')} {totalUnit}</td>
              <td className="border-r border-blue-900 print:border-black px-1 py-3"></td>
              <td className="border-r border-blue-900 print:border-black px-1 py-3"></td>
              <td className="border-r border-blue-900 print:border-black px-1 py-3"></td>
              <td className="border-r border-blue-900 print:border-black px-2 py-3 text-right tabular-nums font-extrabold text-[18px]" style={{ color: '#ffffff' }}>₹ {fmtMoney(grandTotal)}</td>
            </tr>
          </tbody>
        </table>

        {/* Terms & Conditions — branded section header + numbered list */}
        <div className="border-t border-gray-800 print:border-black px-4 py-3 text-[11px] bg-gray-50/40 print:bg-transparent">
          <div className="text-[11px] uppercase tracking-wider font-bold text-blue-800 mb-2 border-b border-blue-800/30 pb-1">Terms &amp; Conditions</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
            <div className="text-[11px]"><span className="text-gray-500">Payment Terms&nbsp;&nbsp;:</span> <span className="font-semibold">{payTermsText || '—'}{payCreditDays ? ` (${payCreditDays} days)` : ''}</span></div>
            <div className="text-[11px]"><span className="text-gray-500">Terms for Delivery&nbsp;&nbsp;:</span> <span className="font-semibold">{po.expected_receipt_date ? `Delivery by ${fmtDate(po.expected_receipt_date)}` : '—'}</span></div>
            {po.freight_terms && (
              <div className="text-[11px]"><span className="text-gray-500">Freight Terms&nbsp;&nbsp;:</span> <span className="font-semibold">{po.freight_terms}{freightAmount > 0 ? ` — ₹ ${fmtMoney(freightAmount)}` : ''}</span></div>
            )}
          </div>
          <ol className="mt-1 space-y-1 text-[10px] leading-snug list-decimal list-outside ml-4 text-gray-700">
            {TERMS.map(([title, body], i) => {
              const filled = body.replace('{{PO_NUMBER}}', po.po_number || '');
              return (
                <li key={i} className="pl-1">
                  <b className="text-gray-900">{title}{title.endsWith(':') ? '' : ':'}</b> {filled}
                </li>
              );
            })}
          </ol>
          {po.remarks && (
            <div className="mt-3 text-[11px] bg-amber-50 border-l-4 border-amber-400 px-3 py-1.5">
              <b className="text-amber-800">Special Notes:</b> {po.remarks}
            </div>
          )}
        </div>

        {/* Footer — branded red bar */}
        <div className="text-center border-t-2 border-blue-800 py-2 text-[11px] font-semibold italic bg-blue-50/60 print:bg-blue-50 text-blue-900">
          This is a Computer Generated Voucher. No Signature Required.
        </div>
      </div>

      <style>{`
        @media print {
          @page { size: A4; margin: 6mm; }
          body { background: white !important; }
          /* Force browsers to print background colors / images so the royal
             blue header bar, totals bar and section tints appear in the PDF. */
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          .print\\:hidden { display: none !important; }
          .print\\:my-0 { margin-top: 0 !important; margin-bottom: 0 !important; }
          .print\\:shadow-none { box-shadow: none !important; }
          .print\\:border-black { border-color: black !important; }
          .print\\:bg-blue-800 { background-color: #1e40af !important; color: white !important; }
          .print\\:bg-blue-50 { background-color: #eff6ff !important; }
          .print\\:bg-transparent { background-color: transparent !important; }
        }
      `}</style>
    </div>
  );
}
