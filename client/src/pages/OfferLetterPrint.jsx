// Print-ready Offer Letter for a hired candidate.
//
// Mam (2026-05-22) shared the .docx reference
// (Offer_Letter_Bhanu_Pratap_Rana.docx) and asked the auto-generated
// PDF to match that format exactly.  Layout below mirrors the docx:
//
//   1. Letterhead (centered, top):
//      • SECURED ENGINEERS PVT. LTD. (bold caps)
//      • Head Office: B.K Towers, Janta Nagar, Gill Road, Ludhiana, (PB) (141003)
//      • Corporate Office: 58/A/1, First Floor, Kalu Sarai, New Delhi - 110016
//   2. PRIVATE AND CONFIDENTIAL  (centered, small caps)
//   3. OFFER LETTER  (centered, bold caps, larger)
//   4. Header field block — Date / Name / Address / Email / Mobile No / Subject
//      (in this exact order — Mobile is BEFORE Subject in the docx)
//   5. Dear [Full Name],
//   6. Standard opening paragraph
//   7. CTC table — Basic Pay / Conveyance / HRA /
//      Adhoc Allowance / Miscellaneous Allowance (combined into ONE row) /
//      Total Earnings
//   8. Date of Joining · Probationary Period (3 months) ·
//      Notice Period (15 days, 45-day clearance)
//   9. Confidentiality paragraph
//  10. With Regards · Sotyn.Headmasters Pvt. Ltd. · Human Resources Department
//
// Same HTML→Ctrl+P→Save as PDF pattern as VendorPOPrint /
// IndentPrint / SalarySlipPrint.
//
// Route: /hr/candidates/:id/offer-letter

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';

const COMPANY = {
  name:     'Sotyn.Headmasters Pvt. Ltd.',
  headOff:  'Head Office: B.K Towers, Janta Nagar, Gill Road, Ludhiana, (PB) (141003)',
  corpOff:  'Corporate Office: 58/A/1, First Floor, Kalu Sarai, New Delhi - 110016',
};

const fmtINR = (n) => Number(n || 0).toLocaleString('en-IN');
const fmtDateLong = (iso) => {
  if (!iso) return '___________';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
};

export default function OfferLetterPrint() {
  const { id } = useParams();
  const [c, setC] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.get(`/hr/candidates/${id}`)
      .then(r => setC(r.data))
      .catch(e => setErr(e.response?.data?.error || 'Failed to load candidate'));
  }, [id]);

  if (err) return <div className="p-6 text-red-700">{err}</div>;
  if (!c)   return <div className="p-6 text-gray-500">Loading…</div>;

  const today        = fmtDateLong(new Date().toISOString().slice(0, 10));
  const offeredPos   = c.offered_position || c.position || '___________';
  const monthly      = +c.offered_salary || 0;
  const annual       = monthly * 12;
  const joiningStr   = fmtDateLong(c.joining_date);

  // Mam (2026-05-22 Batch D): salary_breakup is an OPTIONAL JSON
  // override admin can set on MD Decision.  When null, we render the
  // default SEPL template (Basic = total, allowances as descriptive
  // text).  When set, we render the custom lines.
  let breakup = null;
  if (c.salary_breakup) {
    try { breakup = typeof c.salary_breakup === 'string' ? JSON.parse(c.salary_breakup) : c.salary_breakup; }
    catch (_) { breakup = null; }
  }
  // Default breakup matches the docx reference exactly.
  const lines = breakup?.lines && Array.isArray(breakup.lines) ? breakup.lines : [
    { name: 'Basic Pay',                                  monthly: monthly ? fmtINR(monthly) : '___________', annual: annual ? fmtINR(annual) : '___________' },
    { name: 'Conveyance Allowance',                       monthly: 'As per actual',     annual: 'As per actual' },
    { name: 'House Rent Allowance',                       monthly: 'Provide by company',annual: 'Provide by company' },
    { name: 'Adhoc Allowance / Miscellaneous Allowance',  monthly: 'N/A',               annual: 'N/A' },
  ];
  const totalMonthly = breakup?.total_monthly != null
    ? fmtINR(breakup.total_monthly)
    : (monthly ? fmtINR(monthly) : '___________');
  const totalAnnual  = breakup?.total_annual != null
    ? fmtINR(breakup.total_annual)
    : (annual ? fmtINR(annual) : '___________');

  return (
    <div className="bg-gray-100 min-h-screen py-6 print:bg-white print:py-0">
      {/* On-screen action bar — hidden in print */}
      <div className="max-w-[800px] mx-auto mb-4 flex justify-between items-center print:hidden">
        <a href="/hr" className="text-sm text-blue-700 hover:underline">← Back to HR &amp; Hiring</a>
        <button onClick={() => window.print()} className="btn btn-primary text-sm flex items-center gap-1.5">
          🖨️ Print / Save as PDF
        </button>
      </div>

      {/* Letter — A4 width, white card */}
      <div className="max-w-[800px] mx-auto bg-white shadow-lg print:shadow-none p-10 print:p-12 text-[12.5px] leading-relaxed text-gray-900" style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}>

        {/* ── LETTERHEAD ─────────────────────────────────────────── */}
        <div className="text-center mb-5">
          <div className="text-[16px] font-bold tracking-wide">{COMPANY.name.toUpperCase()}</div>
          <div className="text-[10.5px] mt-1 text-gray-800">{COMPANY.headOff}</div>
          <div className="text-[10.5px] text-gray-800">{COMPANY.corpOff}</div>
        </div>

        {/* Thin separator under the letterhead */}
        <div className="border-t border-gray-400 mb-5" />

        {/* PRIVATE AND CONFIDENTIAL (centered) */}
        <div className="text-center text-[11px] italic font-bold tracking-widest text-gray-700 mb-2">
          PRIVATE AND CONFIDENTIAL
        </div>

        {/* OFFER LETTER title (centered, larger) */}
        <div className="text-center text-[18px] font-bold tracking-wider mb-6">
          OFFER LETTER
        </div>

        {/* Header block — Date / Name / Address / Email / Mobile No / Subject */}
        <table className="text-[12.5px] w-full mb-5">
          <tbody>
            <tr><td className="font-bold pr-3 py-0.5 align-top w-[100px]">Date</td><td className="py-0.5">{today}</td></tr>
            <tr><td className="font-bold pr-3 py-0.5 align-top">Name</td><td className="py-0.5">{c.name || '___________'}</td></tr>
            <tr><td className="font-bold pr-3 py-0.5 align-top">Address</td><td className="py-0.5">{c.address || '___________'}</td></tr>
            <tr><td className="font-bold pr-3 py-0.5 align-top">Email</td><td className="py-0.5">{c.email || '___________'}</td></tr>
            <tr><td className="font-bold pr-3 py-0.5 align-top">Mobile No</td><td className="py-0.5">{c.phone || '___________'}</td></tr>
            <tr><td className="font-bold pr-3 py-0.5 align-top">Subject</td><td className="py-0.5">Offer Letter</td></tr>
          </tbody>
        </table>

        {/* Salutation — full name per the reference docx */}
        <p className="mt-4 mb-3"><strong>Dear {c.name || '___________'},</strong></p>

        {/* Opening paragraph */}
        <p className="mb-5 text-justify">
          On behalf of {COMPANY.name}, we are pleased to extend you an offer of
          employment as a <strong>{offeredPos}</strong> in our organization. We urge
          you to read this letter carefully, since it contains certain important
          details pertaining to your employment.
        </p>

        {/* CTC table */}
        <p className="font-bold mb-2">CTC (With complete break-up):</p>
        <table className="w-full border-collapse text-[11.5px] mb-5">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-gray-700 px-2 py-1.5 text-left">EARNINGS</th>
              <th className="border border-gray-700 px-2 py-1.5 text-right">AMOUNT</th>
              <th className="border border-gray-700 px-2 py-1.5 text-right">NET ANNUAL AMOUNT</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((row, i) => {
              const isNumeric = (v) => v != null && !isNaN(Number(String(v).replace(/[, ]/g, '')));
              return (
                <tr key={i}>
                  <td className="border border-gray-700 px-2 py-1.5">{row.name}</td>
                  <td className={`border border-gray-700 px-2 py-1.5 text-right ${isNumeric(row.monthly) ? 'tabular-nums' : 'italic text-gray-700'}`}>{row.monthly}</td>
                  <td className={`border border-gray-700 px-2 py-1.5 text-right ${isNumeric(row.annual) ? 'tabular-nums' : 'italic text-gray-700'}`}>{row.annual}</td>
                </tr>
              );
            })}
            <tr className="font-bold bg-gray-50">
              <td className="border border-gray-700 px-2 py-1.5">Total Earnings</td>
              <td className="border border-gray-700 px-2 py-1.5 text-right tabular-nums">{totalMonthly}</td>
              <td className="border border-gray-700 px-2 py-1.5 text-right tabular-nums">{totalAnnual}</td>
            </tr>
          </tbody>
        </table>

        {/* Date of Joining */}
        <p className="mb-3 text-justify">
          <strong>Date of Joining:</strong>&nbsp; Your date of joining would be{' '}
          <strong>{joiningStr}</strong>. If joining does not take place on the given
          date then the offer letter will be considered invalid.
        </p>

        {/* Probationary Period */}
        <p className="mb-3 text-justify">
          <strong>Probationary Period:</strong>&nbsp; The probationary period of 3 months
          need to be served by candidate, after joining the job.
        </p>

        {/* Notice Period */}
        <p className="mb-3 text-justify">
          <strong>Notice Period:</strong>&nbsp; If the employee desires to leave the
          company, he/she needs to serve the notice period of 15 days. If the
          performance is not good then the employee can be terminated even during
          the probation period and all salary clearance will be done after 45 days
          even if the employee is terminated.
        </p>

        {/* Confidentiality + sign-off */}
        <p className="mb-6 text-justify">
          Please note that the contents of this letter are confidential and should
          not be used as a bargaining tool for negotiating employment terms with
          any other organization. If you have any queries, please feel free to
          contact us. We look forward to working with you.
        </p>

        <div className="mt-10">
          <div><strong>With Regards,</strong></div>
          <div className="mt-1"><strong>{COMPANY.name}</strong></div>
          <div className="mt-1"><strong>Human Resources Department</strong></div>
        </div>
      </div>

      <style>{`
        @media print {
          @page { size: A4; margin: 18mm; }
          body { background: white !important; }
        }
      `}</style>
    </div>
  );
}
