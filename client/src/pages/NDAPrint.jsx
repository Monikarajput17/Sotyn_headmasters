// Non-Disclosure Agreement — print-ready, HTML→Ctrl+P→Save as PDF.
//
// Mam (2026-05-22 Phase 1 Batch D, module #9): standard SEPL NDA
// auto-filled with the candidate's name, joining date and offered
// position.  Same letterhead and serif styling as the offer letter
// so the candidate sees a consistent SEPL package.
//
// Route: /hr/candidates/:id/nda

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';

const COMPANY = {
  name:     'Sotyn.Headmasters Pvt. Ltd.',
  headOff:  'Head Office: B.K Towers, Janta Nagar, Gill Road, Ludhiana, (PB) (141003)',
  corpOff:  'Corporate Office: 58/A/1, First Floor, Kalu Sarai, New Delhi - 110016',
};

const fmtDateLong = (iso) => {
  if (!iso) return '___________';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
};

export default function NDAPrint() {
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
  const offeredPos = c.offered_position || c.position || '___________';

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
          NON-DISCLOSURE AGREEMENT
        </div>

        <p className="mb-4 text-justify">
          This Non-Disclosure Agreement ("Agreement") is entered into on <strong>{today}</strong> by
          and between <strong>{COMPANY.name}</strong>, having its registered office at the address
          above ("Company"), and <strong>{c.name || '___________'}</strong>, residing at{' '}
          <strong>{c.address || '___________'}</strong> ("Employee"), in connection with the
          Employee's engagement with the Company in the role of <strong>{offeredPos}</strong>.
        </p>

        <h3 className="font-bold mt-5 mb-2">1. Confidential Information</h3>
        <p className="mb-3 text-justify">
          "Confidential Information" includes, without limitation, all business, technical, financial,
          customer, vendor, pricing, project, design, drawing, BOQ, quotation, payroll and operational
          information of the Company, in any form, whether or not marked as confidential, that the
          Employee gains access to during the course of employment.
        </p>

        <h3 className="font-bold mt-5 mb-2">2. Obligations</h3>
        <p className="mb-3 text-justify">
          The Employee shall (a) hold all Confidential Information in strict confidence; (b) use it
          solely for performing duties assigned by the Company; (c) not disclose it to any third
          party (including future employers, clients of competitors, or social/professional
          networks); and (d) on cessation of employment, return or destroy all copies and certify
          the same in writing.
        </p>

        <h3 className="font-bold mt-5 mb-2">3. Intellectual Property</h3>
        <p className="mb-3 text-justify">
          All inventions, designs, drawings, code, documents and works created by the Employee in
          the course of employment, whether alone or with others, shall be the sole property of the
          Company. The Employee assigns all such rights to the Company without further consideration.
        </p>

        <h3 className="font-bold mt-5 mb-2">4. Non-Solicitation</h3>
        <p className="mb-3 text-justify">
          For a period of <strong>twelve (12) months</strong> after cessation of employment, the
          Employee shall not, directly or indirectly, solicit, hire, or attempt to hire any
          employee, contractor or vendor of the Company, nor solicit any client of the Company with
          whom the Employee dealt during employment.
        </p>

        <h3 className="font-bold mt-5 mb-2">5. Term</h3>
        <p className="mb-3 text-justify">
          The Employee's obligations under this Agreement shall remain in force for the duration of
          employment and for a period of <strong>three (3) years</strong> thereafter, except that
          obligations relating to trade secrets shall continue indefinitely.
        </p>

        <h3 className="font-bold mt-5 mb-2">6. Remedies</h3>
        <p className="mb-3 text-justify">
          Any breach of this Agreement may cause irreparable harm to the Company, entitling it to
          seek injunctive relief in addition to all other remedies available at law. The Employee
          shall also be liable for actual damages, costs and reasonable legal fees.
        </p>

        <h3 className="font-bold mt-5 mb-2">7. Governing Law</h3>
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
