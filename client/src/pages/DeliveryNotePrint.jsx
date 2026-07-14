// Print-ready Delivery Note for a Vendor PO.
//
// Mam (2026-05-22) shared SEPL_Delivery_Note_Template.pdf and said
// "delivery note make here automatically and show pdf here
// according to po".  This page auto-fills the template from any
// vendor_po id — no DN table row needed (print-on-demand).
//
// Layout below matches mam's reference template:
//   1. Red top strip — GSTIN left · DELIVERY NOTE centre · PAN right
//   2. Company block — SECURED ENGINEERS PVT. LTD - 24-25 centred,
//      HO + Noida addresses, PAN-INDIA presence + speciality strip
//   3. Meta row — Delivery Note No / Date / SEPL PO No / Indent No
//   4. Two-column block — CLIENT / COMPANY left, DELIVERY SITE right
//   5. Items table — SL · DESCRIPTION OF MATERIAL / WORK · HSN/CODE ·
//      QUANTITY · UOM · REMARKS (8 rows minimum, pads if fewer)
//   6. Vehicle / Transport block (filled in by hand at dispatch)
//   7. IMPORTANT — RECEIVING IS VALID ONLY ON THIS DELIVERY NOTE
//   8. RECEIVED IN GOOD CONDITION block (Name / Designation / Date /
//      Signature / Site Stamp / Mobile)
//   9. Bullet-point reminders
//  10. Computer-generated footer
//
// Same HTML→Ctrl+P→Save as PDF pattern as VendorPOPrint.
// Route: /vendor-po/:id/delivery-note

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';

const COMPANY = {
  name: 'SECURED ENGINEERS PVT. LTD',
  fy:   '24-25',
  gstin: '03AASCS7836D2Z3',
  pan:   'AASCS7836D',
  ho:    'HO: 2480/1, B.K Tower, 1st Floor, Near Grewal Hospital, Gill Road, LUDHIANA, Punjab - 141003',
  noida: 'Noida: 91, Springboard, Sector 2, Noida (UP)',
};

const fmtDateLong = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

// Underline placeholder for empty fields — keeps the printed look
// when source data isn't there yet (admin can pen-fill).
function Blank({ width = 140 }) {
  return <span className="inline-block border-b border-dotted border-gray-500 align-bottom" style={{ minWidth: width, height: '1em' }} />;
}

export default function DeliveryNotePrint() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [err, setErr]   = useState(null);

  useEffect(() => {
    api.get(`/procurement/vendor-po/${id}/delivery-note-data`)
      .then(r => setData(r.data))
      .catch(e => setErr(e.response?.data?.error || 'Failed to load PO'));
  }, [id]);

  if (err)  return <div className="p-6 text-red-700">{err}</div>;
  if (!data) return <div className="p-6 text-gray-500">Loading…</div>;

  const po = data.po || {};
  const items = data.items || [];
  const today = fmtDateLong(new Date().toISOString().slice(0, 10));
  // Pad items to 8 rows so the table looks like the printed template
  const padCount = Math.max(0, 8 - items.length);

  return (
    <div className="bg-gray-100 min-h-screen py-6 print:bg-white print:py-0">
      {/* On-screen action bar — hidden in print */}
      <div className="max-w-[820px] mx-auto mb-4 flex justify-between items-center print:hidden">
        <a href="/procurement" className="text-sm text-blue-700 hover:underline">← Back to Procurement</a>
        <button onClick={() => window.print()} className="btn btn-primary text-sm flex items-center gap-1.5">
          🖨️ Print / Save as PDF
        </button>
      </div>

      <div className="max-w-[820px] mx-auto bg-white shadow-lg print:shadow-none p-0 text-[11px] text-gray-900" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
        {/* ── Red top strip ── */}
        <div className="bg-red-900 text-white px-4 py-2 flex justify-between items-center" style={{ backgroundColor: '#1e40af' }}>
          <div className="text-[10px]">GSTIN : <span className="font-semibold">{COMPANY.gstin}</span></div>
          <div className="text-[16px] font-bold tracking-widest">DELIVERY NOTE</div>
          <div className="text-[10px]">PAN : <span className="font-semibold">{COMPANY.pan}</span></div>
        </div>

        {/* ── Company block ── */}
        <div className="text-center px-4 py-3 border-b border-gray-300">
          <h1 className="text-[15px] font-bold m-0" style={{ color: '#1e40af' }}>{COMPANY.name} - {COMPANY.fy}</h1>
          <div className="text-[9.5px] text-gray-600 mt-1">{COMPANY.ho} &nbsp;|&nbsp; {COMPANY.noida}</div>
          <div className="text-[9.5px] text-gray-600 mt-1">
            PAN-INDIA PRESENCE : <b>LUDHIANA</b> | <b>NOIDA</b> | <b>BANGALORE</b> | <b>MUMBAI</b>
            &nbsp;—&nbsp; <b>ELECTRICAL</b> | <b>HVAC</b> | <b>FIRE SAFETY</b> | <b>PLUMBING</b> | <b>SOLAR</b> | <b>ELV</b>
          </div>
        </div>

        {/* ── Meta row — DN No / Date / PO No / Indent No ── */}
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-rose-50">
              <th className="border border-rose-200 px-2 py-1.5 text-left text-[10px] font-semibold text-gray-700 uppercase">Delivery Note No.</th>
              <th className="border border-rose-200 px-2 py-1.5 text-left text-[10px] font-semibold text-gray-700 uppercase">Date</th>
              <th className="border border-rose-200 px-2 py-1.5 text-left text-[10px] font-semibold text-gray-700 uppercase">SEPL PO No.</th>
              <th className="border border-rose-200 px-2 py-1.5 text-left text-[10px] font-semibold text-gray-700 uppercase">Indent No.</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border border-rose-200 px-2 py-1.5 font-mono">{po.dn_number_suggested || <Blank/>}</td>
              <td className="border border-rose-200 px-2 py-1.5">{today}</td>
              <td className="border border-rose-200 px-2 py-1.5 font-mono">{po.po_number || <Blank/>}</td>
              <td className="border border-rose-200 px-2 py-1.5 font-mono">{po.indent_number || <Blank/>}</td>
            </tr>
          </tbody>
        </table>

        {/* ── Two-column block — Client / Site ── */}
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-rose-50">
              <th className="border border-rose-200 px-2 py-1.5 text-left text-[10px] font-semibold text-gray-700 uppercase w-1/2">Client / Company</th>
              <th className="border border-rose-200 px-2 py-1.5 text-left text-[10px] font-semibold text-gray-700 uppercase w-1/2">Delivery Site</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border border-rose-200 px-2 py-2 align-top">
                <div className="font-semibold">M/s {po.client_company || <Blank width={200}/>}</div>
                <div className="text-gray-700 mt-1 leading-snug whitespace-pre-wrap">
                  Address: {po.client_address || <Blank width={260}/>}
                </div>
                <div className="text-gray-700 mt-1">
                  GSTIN: <span className="font-mono">{po.client_gstin || <Blank width={140}/>}</span>
                </div>
                {po.client_person_name && (
                  <div className="text-gray-600 text-[10px] mt-1">Contact: {po.client_person_name}{po.client_phone ? ` · ${po.client_phone}` : ''}</div>
                )}
              </td>
              <td className="border border-rose-200 px-2 py-2 align-top">
                <div className="font-semibold">Site Name: {po.indent_site_name || po.bb_project_name || <Blank width={180}/>}</div>
                <div className="text-gray-700 mt-1 leading-snug whitespace-pre-wrap">
                  Address: {po.site_address || po.client_address || <Blank width={260}/>}
                </div>
                <div className="text-gray-700 mt-1">
                  Site Engineer / Contact: {po.site_engineer_name || <Blank width={140}/>}{po.client_phone ? ` · ${po.client_phone}` : ''}
                </div>
              </td>
            </tr>
          </tbody>
        </table>

        {/* ── Items table ── */}
        <table className="w-full border-collapse mt-1">
          <thead>
            <tr style={{ backgroundColor: '#1e40af' }}>
              <th className="border border-rose-900 px-1 py-1.5 text-[10px] text-white uppercase w-8">SL<br/>NO.</th>
              <th className="border border-rose-900 px-2 py-1.5 text-[10px] text-white uppercase text-left">Description of Material / Work</th>
              <th className="border border-rose-900 px-1 py-1.5 text-[10px] text-white uppercase w-20">HSN / Code</th>
              <th className="border border-rose-900 px-1 py-1.5 text-[10px] text-white uppercase w-20">Quantity</th>
              <th className="border border-rose-900 px-1 py-1.5 text-[10px] text-white uppercase w-16">UOM</th>
              <th className="border border-rose-900 px-2 py-1.5 text-[10px] text-white uppercase w-32">Remarks</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => {
              const detail = [it.specification, it.size, it.make].filter(Boolean).join(' · ');
              return (
                <tr key={it.id || idx} className="align-top">
                  <td className="border border-rose-200 px-1 py-1.5 text-center text-gray-600">{idx + 1}</td>
                  <td className="border border-rose-200 px-2 py-1.5">
                    <div className="font-semibold">{it.description || ''}</div>
                    {detail && <div className="text-[9.5px] text-gray-700 mt-0.5">{detail}</div>}
                    {it.make && !detail.includes(it.make) && <div className="text-[9.5px] text-gray-700">Make: <span className="font-semibold">{it.make}</span></div>}
                  </td>
                  <td className="border border-rose-200 px-1 py-1.5 text-center font-mono text-[10px]">{it.hsn_code || it.gst_text || ''}</td>
                  <td className="border border-rose-200 px-1 py-1.5 text-right tabular-nums font-semibold">{(+it.quantity || 0).toLocaleString('en-IN')}</td>
                  <td className="border border-rose-200 px-1 py-1.5 text-center">{it.uom || ''}</td>
                  <td className="border border-rose-200 px-2 py-1.5"></td>
                </tr>
              );
            })}
            {/* Pad to 8 rows so the table looks like the printed sheet */}
            {Array.from({ length: padCount }).map((_, i) => (
              <tr key={`pad-${i}`}>
                <td className="border border-rose-200 px-1 py-2 text-center text-gray-400">{items.length + i + 1}</td>
                <td className="border border-rose-200 px-2 py-2"></td>
                <td className="border border-rose-200 px-1 py-2"></td>
                <td className="border border-rose-200 px-1 py-2"></td>
                <td className="border border-rose-200 px-1 py-2"></td>
                <td className="border border-rose-200 px-2 py-2"></td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* ── Vehicle / Transport block — filled in by hand at dispatch ── */}
        <div className="px-4 py-3 border-b border-gray-300">
          <div className="text-[10px] font-bold text-gray-700 uppercase mb-2">Vehicle / Transport Details</div>
          <table className="w-full text-[10.5px] border-collapse">
            <thead>
              <tr className="bg-gray-50">
                <th className="border border-gray-300 px-2 py-1 text-left font-semibold text-gray-700">Vehicle No.</th>
                <th className="border border-gray-300 px-2 py-1 text-left font-semibold text-gray-700">Driver Name &amp; Mobile</th>
                <th className="border border-gray-300 px-2 py-1 text-left font-semibold text-gray-700">LR / Challan No.</th>
                <th className="border border-gray-300 px-2 py-1 text-left font-semibold text-gray-700">Total Packages</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="border border-gray-300 px-2 py-3"></td><td className="border border-gray-300 px-2 py-3"></td><td className="border border-gray-300 px-2 py-3"></td><td className="border border-gray-300 px-2 py-3"></td></tr>
            </tbody>
          </table>
        </div>

        {/* ── IMPORTANT notice ── */}
        <div className="px-4 py-3 border-b border-gray-300 bg-amber-50">
          <div className="text-[10.5px] font-bold text-amber-900 uppercase">
            ⚠ Important — Receiving is valid ONLY on this Delivery Note
          </div>
          <p className="text-[10px] text-amber-900 mt-1.5 leading-snug text-justify">
            It is the supplier's responsibility to obtain dated signature, name and stamp of Sotyn.Headmasters'
            authorised site representative on this Delivery Note. Receiving acknowledged on the supplier's
            bill / invoice / challan shall <b>NOT</b> be treated as proof of delivery and may lead to non-payment.
          </p>
        </div>

        {/* ── RECEIVED IN GOOD CONDITION block ── */}
        <div className="px-4 py-3 border-b border-gray-300">
          <div className="text-[10.5px] font-bold text-gray-800 uppercase mb-2">
            Received in Good Condition <span className="font-normal text-gray-500 text-[9.5px]">(to be filled by SEPL site representative)</span>
          </div>
          <table className="w-full text-[10.5px] border-collapse">
            <thead>
              <tr className="bg-gray-50">
                <th className="border border-gray-300 px-2 py-1 text-left font-semibold text-gray-700">Name of Receiver</th>
                <th className="border border-gray-300 px-2 py-1 text-left font-semibold text-gray-700">Designation</th>
                <th className="border border-gray-300 px-2 py-1 text-left font-semibold text-gray-700">Date &amp; Time</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="border border-gray-300 px-2 py-3"></td><td className="border border-gray-300 px-2 py-3"></td><td className="border border-gray-300 px-2 py-3"></td></tr>
            </tbody>
          </table>
          <table className="w-full text-[10.5px] border-collapse mt-2">
            <thead>
              <tr className="bg-gray-50">
                <th className="border border-gray-300 px-2 py-1 text-left font-semibold text-gray-700">Signature</th>
                <th className="border border-gray-300 px-2 py-1 text-left font-semibold text-gray-700">Site Stamp</th>
                <th className="border border-gray-300 px-2 py-1 text-left font-semibold text-gray-700">Mobile No.</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="border border-gray-300 px-2 py-5"></td><td className="border border-gray-300 px-2 py-5"></td><td className="border border-gray-300 px-2 py-5"></td></tr>
            </tbody>
          </table>
        </div>

        {/* ── Bullet reminders ── */}
        <div className="px-4 py-3 border-b border-gray-300">
          <ul className="text-[9.5px] text-gray-700 leading-snug list-disc list-inside space-y-1">
            <li>Please verify quantity, description and condition of material <b>BEFORE</b> signing this Delivery Note.</li>
            <li>Mention shortage / damage / wrong-supply (if any) clearly under <b>REMARKS</b> column. Once signed without remark, supply shall be deemed accepted in full.</li>
            <li>Receiving on this Delivery Note is the only recognised proof of delivery. Bills / Invoices are for accounting only.</li>
            <li>Original copy to be retained by Sotyn.Headmasters' site office; duplicate copy may be returned to the supplier for billing reference.</li>
            <li>For any clarification, contact the Stores / Project Department of Sotyn.Headmasters Pvt. Ltd., Ludhiana.</li>
          </ul>
        </div>

        {/* ── Computer-generated footer ── */}
        <div className="px-4 py-2 text-center text-[9px] text-gray-500 italic">
          This is a Computer Generated Delivery Note. Valid only when received and signed at the designated SEPL site.
        </div>
      </div>

      <style>{`
        @media print {
          @page { size: A4; margin: 10mm; }
          body { background: white !important; }
        }
      `}</style>
    </div>
  );
}
