// Public Offer Accept page — no login required.
//
// Mam (2026-05-22 Phase 1 Batch D, module #9 — "Offer acceptance
// via link"): candidate gets an offer email with a link to
// https://erp.../offer/<token>.  They click, see the SEPL offer
// letter rendered inline, and click Accept or Decline.  No login,
// no SEPL account needed — the token IS the identity.
//
// Once they respond, the token is "consumed" and any further
// attempt shows a "this offer was already accepted/declined on …"
// message.

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';
import { fmtDateTime as fmtDateTimeIST, fmtDate } from '../utils/datetime';

const COMPANY = {
  name: 'Sotyn.Headmasters Pvt. Ltd.',
};

const fmtINR = (n) => Number(n || 0).toLocaleString('en-IN');
const fmtDateLong = (iso) => iso ? fmtDate(iso, { day: '2-digit', month: 'long', year: 'numeric' }) : '___________';
const fmtDateTime = (iso) => fmtDateTimeIST(iso, { dateStyle: 'medium', timeStyle: 'short' });

export default function PublicOffer() {
  const { token } = useParams();
  const [offer, setOffer] = useState(null);
  const [err, setErr] = useState(null);
  const [decision, setDecision] = useState(null);     // 'accept' | 'decline' | null
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(null);             // {decision, status} after responding

  // Use bare axios (NOT the project's auth-aware `api` instance) so
  // no Authorization header is attached.  Backend route is mounted
  // at /api/public/* and doesn't require auth.
  useEffect(() => {
    axios.get(`/api/public/offer/${token}`)
      .then(r => setOffer(r.data.offer))
      .catch(e => setErr(e.response?.data?.error || 'Failed to load offer'));
  }, [token]);

  const submit = async () => {
    if (!decision) return;
    setSubmitting(true);
    try {
      const r = await axios.post(`/api/public/offer/${token}/respond`, { decision, note });
      setDone({ decision: r.data.decision, status: r.data.status });
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to submit response');
    } finally {
      setSubmitting(false);
    }
  };

  if (err) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <div className="max-w-md bg-white shadow-lg rounded-lg p-6 text-center">
          <div className="text-5xl mb-3">⚠️</div>
          <h2 className="text-xl font-bold text-red-700 mb-2">Cannot open this offer</h2>
          <p className="text-gray-600 text-sm">{err}</p>
          <p className="text-gray-400 text-xs mt-4">If you believe this is a mistake, please contact{' '}
            <a className="text-blue-700" href="mailto:hr@securedengineers.com">hr@securedengineers.com</a>.
          </p>
        </div>
      </div>
    );
  }
  if (!offer) {
    return <div className="min-h-screen flex items-center justify-center text-gray-500">Loading offer…</div>;
  }

  // Already responded — show confirmation card
  const alreadyResponded = offer.offer_accepted_at || offer.offer_declined_at;
  if (done || alreadyResponded) {
    const wasAccepted = done?.decision === 'accept' || (!done && offer.offer_accepted_at);
    const respondedAt = done ? new Date().toISOString() : (offer.offer_accepted_at || offer.offer_declined_at);
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <div className="max-w-md bg-white shadow-lg rounded-lg p-8 text-center">
          <div className="text-6xl mb-4">{wasAccepted ? '🎉' : '✓'}</div>
          <h2 className="text-2xl font-bold mb-2">
            {wasAccepted ? 'Welcome to the team!' : 'Response recorded'}
          </h2>
          <p className="text-gray-700 mb-4">
            {wasAccepted
              ? `Thank you, ${offer.name}. Your acceptance has been received. HR will reach out shortly with onboarding details.`
              : `Thank you for your response, ${offer.name}. Your decision has been recorded.`}
          </p>
          <div className="text-xs text-gray-400 mt-6">
            Responded on {fmtDateTime(respondedAt)}
          </div>
        </div>
      </div>
    );
  }

  // Salary breakup
  let breakup = null;
  if (offer.salary_breakup) {
    try { breakup = typeof offer.salary_breakup === 'string' ? JSON.parse(offer.salary_breakup) : offer.salary_breakup; }
    catch (_) {}
  }
  const monthly = +offer.offered_salary || 0;
  const annual = monthly * 12;
  const lines = breakup?.lines || [
    { name: 'Basic Pay', monthly: monthly ? fmtINR(monthly) : '—', annual: annual ? fmtINR(annual) : '—' },
    { name: 'Conveyance Allowance', monthly: 'As per actual', annual: 'As per actual' },
    { name: 'House Rent Allowance', monthly: 'Provide by company', annual: 'Provide by company' },
    { name: 'Adhoc / Miscellaneous Allowance', monthly: 'N/A', annual: 'N/A' },
  ];
  const totalMonthly = breakup?.total_monthly != null ? fmtINR(breakup.total_monthly) : (monthly ? fmtINR(monthly) : '—');
  const totalAnnual  = breakup?.total_annual  != null ? fmtINR(breakup.total_annual)  : (annual  ? fmtINR(annual)  : '—');

  return (
    <div className="bg-gray-100 min-h-screen py-6">
      <div className="max-w-[840px] mx-auto bg-white shadow-lg rounded-lg overflow-hidden">
        {/* Letterhead */}
        <div className="bg-gradient-to-r from-blue-700 to-blue-800 text-white p-6 text-center">
          <div className="text-2xl font-bold tracking-wide">{COMPANY.name.toUpperCase()}</div>
          <div className="text-xs opacity-90 mt-1">Head Office: Ludhiana, Punjab · Corporate Office: New Delhi</div>
        </div>

        {/* Offer letter content */}
        <div className="p-8 text-[13px] leading-relaxed text-gray-900" style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}>
          <div className="text-center text-[11px] italic font-bold tracking-widest text-gray-700 mb-2">
            PRIVATE AND CONFIDENTIAL
          </div>
          <div className="text-center text-[20px] font-bold tracking-wider mb-6">
            OFFER LETTER
          </div>

          <table className="text-[12.5px] w-full mb-5">
            <tbody>
              <tr><td className="font-bold pr-3 py-0.5 align-top w-[100px]">Name</td><td className="py-0.5">{offer.name}</td></tr>
              <tr><td className="font-bold pr-3 py-0.5 align-top">Email</td><td className="py-0.5">{offer.email || '—'}</td></tr>
              {offer.phone && <tr><td className="font-bold pr-3 py-0.5 align-top">Mobile No</td><td className="py-0.5">{offer.phone}</td></tr>}
              {offer.address && <tr><td className="font-bold pr-3 py-0.5 align-top">Address</td><td className="py-0.5">{offer.address}</td></tr>}
              <tr><td className="font-bold pr-3 py-0.5 align-top">Position</td><td className="py-0.5">{offer.offered_position || offer.position}</td></tr>
              <tr><td className="font-bold pr-3 py-0.5 align-top">Joining</td><td className="py-0.5">{fmtDateLong(offer.joining_date)}</td></tr>
            </tbody>
          </table>

          <p className="mb-4 text-justify">
            <strong>Dear {offer.name},</strong>
          </p>
          <p className="mb-5 text-justify">
            On behalf of {COMPANY.name}, we are pleased to extend you an offer of employment as a{' '}
            <strong>{offer.offered_position || offer.position}</strong> in our organization.
          </p>

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

          <p className="mb-3 text-justify">
            <strong>Probationary Period:</strong>&nbsp; 3 months from the date of joining.
            <strong className="ml-3">Notice Period:</strong>&nbsp; 15 days.
          </p>
        </div>

        {/* Action zone */}
        <div className="bg-gray-50 border-t border-gray-200 p-6">
          <h3 className="text-base font-bold mb-3 text-center text-gray-800">Your Response</h3>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <button
              onClick={() => setDecision('accept')}
              className={`py-4 px-4 rounded-lg border-2 font-bold text-base transition
                ${decision === 'accept'
                  ? 'bg-emerald-600 text-white border-emerald-600 shadow-md'
                  : 'bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-50'}`}>
              ✓ I Accept this Offer
            </button>
            <button
              onClick={() => setDecision('decline')}
              className={`py-4 px-4 rounded-lg border-2 font-bold text-base transition
                ${decision === 'decline'
                  ? 'bg-rose-600 text-white border-rose-600 shadow-md'
                  : 'bg-white text-rose-700 border-rose-300 hover:bg-rose-50'}`}>
              ✗ I Decline
            </button>
          </div>
          {decision && (
            <div className="space-y-3">
              <div>
                <label className="block text-[12px] font-semibold text-gray-700 mb-1">
                  {decision === 'accept' ? 'Message for HR (optional)' : 'Reason for declining (optional)'}
                </label>
                <textarea
                  rows="3"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  placeholder={decision === 'accept'
                    ? "Anything you'd like to communicate before joining?"
                    : "Help us understand — better offer elsewhere? Salary? Location? Timing?"}
                />
              </div>
              <button
                onClick={submit}
                disabled={submitting}
                className={`w-full py-3 rounded-lg font-bold text-white transition disabled:opacity-50
                  ${decision === 'accept' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'}`}>
                {submitting ? 'Submitting…' : `Confirm ${decision === 'accept' ? 'Acceptance' : 'Decline'}`}
              </button>
              <p className="text-[11px] text-gray-500 text-center">
                This response cannot be changed once submitted.
              </p>
            </div>
          )}
        </div>

        <div className="text-center py-3 text-[11px] text-gray-400 border-t border-gray-200">
          Need help? Email{' '}
          <a className="text-blue-700 hover:underline" href="mailto:hr@securedengineers.com">hr@securedengineers.com</a>
        </div>
      </div>
    </div>
  );
}
