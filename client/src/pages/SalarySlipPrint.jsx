// Print-ready salary slip matching SEPL Tally Payslip format. Pulls live
// data via /payroll/calculate/:employee_id?month=YYYY-MM and renders into
// the exact two-column Earnings / Deductions table mam shared (Ravneet
// Singh ASM Oct'24 slip).
//
// Route: /payroll/slip/:employee_id?month=YYYY-MM
// Print via browser → Save as PDF / paper.

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import api from '../api';
import { rupeesInWords } from '../utils/numberToWords';

const COMPANY = {
  name: 'Sotyn.Headmasters Private Limited',
  head: 'B.K Towers, 2480/1, Gill Rd, near Grewal Hospital, Janta Nagar, Ludhiana, Punjab 141003',
  corp: '58/A/1, First Floor, Kalu Sarai, New Delhi - 110016',
  email: 'Sales@securedengineers.com',
  website: 'www.securedengineers.com',
};

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const fmt = (n) => Math.round(n || 0).toLocaleString('en-IN');

export default function SalarySlipPrint() {
  const { employee_id } = useParams();
  const [params] = useSearchParams();
  const month = params.get('month') || (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get(`/payroll/calculate/${employee_id}?month=${month}`)
      .then(r => setData(r.data))
      .catch(err => setError(err.response?.data?.error || 'Failed to load'));
  }, [employee_id, month]);

  if (error) return <div className="p-8 text-red-600">{error}</div>;
  if (!data) return <div className="p-8 text-gray-400">Loading slip…</div>;

  const [yr, mm] = month.split('-').map(Number);
  const payPeriod = `${MONTH_NAMES[mm - 1]} ${yr}`;
  const formatJoinDate = (d) => {
    if (!d) return '-';
    const dt = new Date(d);
    if (isNaN(dt)) return d;
    return `${String(dt.getDate()).padStart(2, '0')}-${String(dt.getMonth() + 1).padStart(2, '0')}-${dt.getFullYear()}`;
  };

  return (
    <div className="bg-white min-h-screen">
      <style>{`
        @media print {
          @page { size: A4; margin: 0; }
          body { margin: 0; }
          .no-print { display: none !important; }
          .slip-page { box-shadow: none !important; margin: 0 !important; }
        }
        @media screen {
          body { background: #f3f4f6; }
        }
        .slip-page {
          width: 210mm;
          min-height: 297mm;
          margin: 16px auto;
          background: white;
          box-shadow: 0 4px 20px rgba(0,0,0,0.1);
          padding: 0;
          font-family: 'Times New Roman', Times, serif;
          color: #111;
          position: relative;
        }
        .slip-header {
          display: flex;
          align-items: center;
          padding: 14px 24px 10px;
          border-bottom: 3px solid #c00;
          background: linear-gradient(to right, #fff 60%, #fef2f2);
        }
        .slip-logo {
          width: 110px;
          height: 70px;
          flex-shrink: 0;
          background: white;
          border: 2px solid #c00;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: bold;
          color: #c00;
          font-size: 22px;
        }
        .slip-name {
          flex: 1;
          padding-left: 18px;
        }
        .slip-name h1 {
          font-size: 26px;
          font-weight: bold;
          color: #c00;
          letter-spacing: 1px;
          margin: 0;
        }
        .slip-name p {
          font-size: 11px;
          color: #c00;
          margin: 4px 0 0;
        }
        .slip-title {
          text-align: center;
          margin: 22px 24px 12px;
        }
        .slip-title h2 {
          font-size: 18px;
          font-weight: bold;
          margin: 0 0 6px;
        }
        .slip-title p {
          font-size: 13px;
          font-weight: 600;
          margin: 2px 0;
        }
        .slip-meta {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 0 40px;
          padding: 18px 40px 8px;
          font-size: 13px;
        }
        .meta-row { display: grid; grid-template-columns: 130px 12px 1fr; padding: 4px 0; }
        .meta-row .label { font-weight: 500; }
        .meta-row .colon { font-weight: 500; }
        .earnings-table {
          margin: 18px 40px 8px;
          width: calc(100% - 80px);
          border-collapse: collapse;
          font-size: 13px;
        }
        .earnings-table th, .earnings-table td {
          border: 1px solid #999;
          padding: 6px 10px;
        }
        .earnings-table th {
          background: #f3f4f6;
          font-weight: bold;
          text-align: center;
          font-size: 14px;
        }
        .earnings-table td.amount {
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
        .earnings-table tr.total td {
          font-weight: bold;
        }
        .in-words {
          margin: 16px 40px;
          font-size: 13px;
        }
        .footer {
          position: absolute;
          bottom: 0;
          left: 0;
          right: 0;
          background: linear-gradient(to right, #fff 50%, #fef2f2);
          border-top: 3px solid #c00;
          padding: 12px 24px;
          text-align: right;
          font-size: 11px;
          color: #c00;
        }
        .toolbar {
          position: fixed;
          top: 12px;
          right: 12px;
          z-index: 100;
          display: flex;
          gap: 8px;
        }
        .toolbar button {
          padding: 8px 14px;
          background: #dc2626;
          color: white;
          border: none;
          border-radius: 6px;
          font-weight: bold;
          cursor: pointer;
        }
        .toolbar button.secondary {
          background: #6b7280;
        }
      `}</style>

      <div className="toolbar no-print">
        <button onClick={() => window.print()}>Print / Save PDF</button>
        <button className="secondary" onClick={() => window.close()}>Close</button>
      </div>

      <div className="slip-page">
        {/* Header */}
        <div className="slip-header">
          <div className="slip-logo">SE</div>
          <div className="slip-name">
            <h1>SECURED ENGINEERS PVT. LTD.</h1>
            <p><strong>Head Office:</strong> B.K Towers, Janta Nagar, Gill Road, Ludhiana, (PB)(141003)</p>
            <p><strong>Corporate Office:</strong> 58/A/1, First Floor, Kalu Sarai, New Delhi - 110016</p>
          </div>
        </div>

        {/* Title */}
        <div className="slip-title">
          <h2>Payslip</h2>
          <p>{COMPANY.name}</p>
          <p style={{ fontWeight: 'normal', fontSize: 12 }}>{COMPANY.head}</p>
        </div>

        {/* Meta */}
        <div className="slip-meta">
          <div>
            <div className="meta-row"><span className="label">Date of Joining</span><span className="colon">:</span><span>{formatJoinDate(data.join_date)}</span></div>
            <div className="meta-row"><span className="label">Pay Period</span><span className="colon">:</span><span>{payPeriod}</span></div>
            <div className="meta-row"><span className="label">Worked Days</span><span className="colon">:</span><span>{data.paid_days}</span></div>
          </div>
          <div>
            <div className="meta-row"><span className="label">Employee Name</span><span className="colon">:</span><span>{data.employee_name}</span></div>
            <div className="meta-row"><span className="label">Designation</span><span className="colon">:</span><span>{data.designation || '-'}</span></div>
            <div className="meta-row"><span className="label">Department</span><span className="colon">:</span><span>{data.department || '-'}</span></div>
          </div>
        </div>

        {/* Earnings + Deductions table */}
        <table className="earnings-table">
          <thead>
            <tr>
              <th style={{ width: '32%' }}>Earnings</th>
              <th style={{ width: '18%' }}>Amount</th>
              <th style={{ width: '32%' }}>Deductions</th>
              <th style={{ width: '18%' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Basic Pay</td>
              <td className="amount">{fmt(data.basic_pay)}</td>
              <td rowSpan={4}></td>
              <td rowSpan={4}></td>
            </tr>
            <tr>
              <td>Conveyance Allowance</td>
              <td className="amount">{fmt(data.conveyance)}</td>
            </tr>
            <tr>
              <td>House Rent Allowance</td>
              <td className="amount">{fmt(data.hra)}</td>
            </tr>
            <tr>
              <td>Adhoc Allowance</td>
              <td className="amount">{fmt(data.adhoc)}</td>
            </tr>
            <tr>
              <td>Miscellaneous Allowance</td>
              <td className="amount">{data.misc ? fmt(data.misc) : ''}</td>
              <td><strong>Late Penalty</strong></td>
              <td className="amount">{data.late_penalty ? fmt(data.late_penalty) : '0'}</td>
            </tr>
            {(data.ot_pay > 0 || data.advance > 0) && (
              <tr>
                <td>{data.ot_pay > 0 ? `Overtime Pay (${data.ot_hours}h)` : ''}</td>
                <td className="amount">{data.ot_pay > 0 ? fmt(data.ot_pay) : ''}</td>
                <td>{data.advance > 0 ? <strong>Advance Salary</strong> : ''}</td>
                <td className="amount">{data.advance > 0 ? fmt(data.advance) : ''}</td>
              </tr>
            )}
            {data.food > 0 && (
              <tr>
                <td><strong>Food Allowance</strong></td>
                <td className="amount">{fmt(data.food)}</td>
                <td></td>
                <td className="amount"></td>
              </tr>
            )}
            <tr className="total">
              <td>Total Earnings</td>
              <td className="amount">{fmt(data.total_earnings + (data.ot_pay || 0) + (data.food || 0))}</td>
              <td><strong>Deduction</strong></td>
              <td className="amount">{fmt(data.total_deductions)}</td>
            </tr>
            <tr className="total">
              <td colSpan={2}></td>
              <td><strong>Net Pay</strong></td>
              <td className="amount"><strong>{fmt(data.net_pay)}</strong></td>
            </tr>
          </tbody>
        </table>

        {/* In Words */}
        <div className="in-words">
          <strong>In Words</strong>: {rupeesInWords(data.net_pay)}.
        </div>

        {/* Attendance summary (small print, useful when slip questioned) */}
        <div style={{ margin: '8px 40px', fontSize: 11, color: '#555' }}>
          <strong>Attendance:</strong> Worked {data.paid_days} of {data.working_days} working days
          {data.half_days ? ` • ${data.half_days} half day(s)` : ''}
          {data.absent_days ? ` • ${data.absent_days} absent` : ''}
          {data.late_marks ? ` • ${data.late_marks} late mark(s)` : ''}
          {data.late_penalty ? ` (penalty ₹${fmt(data.late_penalty)} after ${data.settings?.late_grace_count || 3} free)` : ''}
          {data.paid_leaves ? ` • ${data.paid_leaves} paid leave(s)` : ''}
          {data.unpaid_leaves ? ` • ${data.unpaid_leaves} unpaid leave(s)` : ''}
          {data.sunday_worked ? ` • ${data.sunday_worked} Sunday(s) worked (extra +${data.sunday_worked_pay} day pay)` : ''}
        </div>

        {/* Footer */}
        <div className="footer">
          <div>Email: {COMPANY.email}</div>
          <div>Website: {COMPANY.website}</div>
        </div>
      </div>
    </div>
  );
}
