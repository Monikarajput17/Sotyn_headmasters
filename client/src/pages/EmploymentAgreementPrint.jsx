// Employment Agreement — print-ready, HTML→Ctrl+P→Save as PDF.
//
// Mam (2026-05-22 Phase 1 Batch D, module #9): formal employment
// agreement with the same SEPL letterhead.  Covers role / salary /
// hours / leaves / probation / notice / termination / governing law.
// Auto-filled from candidate data set during MD Decision.
//
// Route: /hr/candidates/:id/employment-agreement

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

export default function EmploymentAgreementPrint() {
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

  const today      = fmtDateLong(new Date().toISOString().slice(0, 10));
  const joining    = fmtDateLong(c.joining_date);
  const offeredPos = c.offered_position || c.position || '___________';
  const monthly    = +c.offered_salary || 0;
  const annual     = monthly * 12;
  const reportingTo = c.reporting_to || 'the Reporting Manager assigned by the Company';

  return (
    <div className="bg-gray-100 min-h-screen py-6 print:bg-white print:py-0">
      <div className="max-w-[800px] mx-auto mb-4 flex justify-between items-center print:hidden">
        <a href="/hr" className="text-sm text-blue-700 hover:underline">← Back to HR &amp; Hiring</a>
        <button onClick={() => window.print()} className="btn btn-primary text-sm flex items-center gap-1.5">
          🖨️ Print / Save as PDF
        </button>
      </div>

      <div className="max-w-[800px] mx-auto bg-white shadow-lg print:shadow-none p-10 print:p-12 text-[12.5px] leading-relaxed text-gray-900" style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}>
        {/* Letterhead */}
        <div className="text-center mb-5">
          <div className="text-[16px] font-bold tracking-wide">{COMPANY.name.toUpperCase()}</div>
          <div className="text-[10.5px] mt-1 text-gray-800">{COMPANY.headOff}</div>
          <div className="text-[10.5px] text-gray-800">{COMPANY.corpOff}</div>
        </div>
        <div className="border-t border-gray-400 mb-5" />

        <div className="text-center text-[11px] italic font-bold tracking-widest text-gray-700 mb-2">
          PRIVATE AND CONFIDENTIAL
        </div>
        <div className="text-center text-[18px] font-bold tracking-wider mb-6">
          EMPLOYMENT AGREEMENT
        </div>

        <p className="mb-4 text-justify">
          This Employment Agreement ("Agreement") is made on <strong>{today}</strong> between
          {' '}<strong>{COMPANY.name}</strong>, with its registered office at the address above
          ("Company"), and <strong>{c.name || '___________'}</strong>, residing at{' '}
          <strong>{c.address || '___________'}</strong> ("Employee").
        </p>

        <h3 className="font-bold mt-5 mb-2">1. Position &amp; Reporting</h3>
        <p className="mb-3 text-justify">
          The Employee is appointed as <strong>{offeredPos}</strong> with effect from{' '}
          <strong>{joining}</strong>. The Employee shall report to <strong>{reportingTo}</strong>
          {' '}and shall perform such duties as may be reasonably assigned from time to time.
        </p>

        <h3 className="font-bold mt-5 mb-2">2. Compensation</h3>
        <p className="mb-3 text-justify">
          The Company shall pay a monthly gross salary of <strong>₹{monthly ? fmtINR(monthly) : '___________'}</strong>
          {' '}(Annual CTC ₹{annual ? fmtINR(annual) : '___________'}), payable on or before the 7th
          of the following month, less applicable statutory deductions. The full salary structure is
          detailed in the Offer Letter dated{' '}<strong>{fmtDateLong(c.offer_sent_at?.slice(0, 10))}</strong>.
        </p>

        <h3 className="font-bold mt-5 mb-2">3. Working Hours</h3>
        <p className="mb-3 text-justify">
          Normal working hours shall be 9:30 AM to 6:30 PM, Monday to Saturday, with one hour for
          lunch. The Employee may be required to work additional hours as project demands require,
          without separate overtime compensation.
        </p>

        <h3 className="font-bold mt-5 mb-2">4. Leave</h3>
        <p className="mb-3 text-justify">
          The Employee shall be entitled to leave as per the Company's HR policy in force from time
          to time. Leave must be applied for and approved in advance through the Sotyn.Headmasters.
        </p>

        <h3 className="font-bold mt-5 mb-2">5. Probationary Period</h3>
        <p className="mb-3 text-justify">
          The Employee shall be on probation for a period of <strong>three (3) months</strong> from
          the date of joining. The Company may extend the probation by an additional period not
          exceeding three months. Confirmation in service is at the Company's discretion based on
          performance and conduct.
        </p>

        <h3 className="font-bold mt-5 mb-2">6. Notice Period &amp; Termination</h3>
        <p className="mb-3 text-justify">
          If the Employee wishes to leave, a notice of <strong>fifteen (15) days</strong> in writing
          shall be served. If the Employee's performance is unsatisfactory, the Company may
          terminate employment with or without notice during probation; salary clearance in such
          cases shall be completed within <strong>forty-five (45) days</strong> of termination.
        </p>

        <h3 className="font-bold mt-5 mb-2">7. Confidentiality &amp; IP</h3>
        <p className="mb-3 text-justify">
          The Employee shall be bound by the separate Non-Disclosure Agreement of even date, which
          forms an integral part of this Agreement. All intellectual property created during the
          course of employment vests in the Company.
        </p>

        <h3 className="font-bold mt-5 mb-2">8. Non-Compete</h3>
        <p className="mb-3 text-justify">
          During the term of employment and for <strong>six (6) months</strong> thereafter, the
          Employee shall not, within the same geographical region, engage with any competing
          business in a capacity that would conflict with the Employee's duties to the Company.
        </p>

        <h3 className="font-bold mt-5 mb-2">9. Code of Conduct</h3>
        <p className="mb-3 text-justify">
          The Employee shall comply with all Company policies, the SEPL HR Manual, statutory
          requirements (EPF, ESI, tax, anti-harassment, anti-bribery) and applicable safety norms
          at all sites and offices.
        </p>

        <h3 className="font-bold mt-5 mb-2">10. Governing Law</h3>
        <p className="mb-6 text-justify">
          This Agreement shall be governed by the laws of India and any dispute shall be subject to
          the exclusive jurisdiction of the courts at Ludhiana, Punjab.
        </p>

        <p className="mt-8 mb-2 font-bold">IN WITNESS WHEREOF, the parties have executed this Agreement on the date first written above.</p>

        <div className="grid grid-cols-2 gap-8 mt-10">
          <div>
            <div className="font-bold">For {COMPANY.name}</div>
            <div className="mt-12 border-t border-gray-600 pt-1">Authorised Signatory</div>
            <div className="text-[11px] text-gray-600">Human Resources Department</div>
          </div>
          <div>
            <div className="font-bold">Employee</div>
            <div className="mt-12 border-t border-gray-600 pt-1">{c.name || '___________'}</div>
            <div className="text-[11px] text-gray-600">Date: ____________</div>
          </div>
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
