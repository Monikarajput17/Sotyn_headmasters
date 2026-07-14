const statusColors = {
  new: 'badge-blue', called: 'badge-blue', lead: 'badge-blue',
  qualified: 'badge-purple', meeting_scheduled: 'badge-yellow', meeting_done: 'badge-yellow',
  boq_drawing: 'badge-yellow', quotation_sent: 'badge-yellow', negotiation: 'badge-yellow',
  won: 'badge-green', lost: 'badge-red',
  draft: 'badge-gray', submitted: 'badge-blue', sent: 'badge-blue',
  approved: 'badge-green', rejected: 'badge-red', accepted: 'badge-green',
  pending: 'badge-yellow', in_progress: 'badge-blue', completed: 'badge-green',
  open: 'badge-red', resolved: 'badge-green', closed: 'badge-gray',
  received: 'badge-blue', booked: 'badge-purple', planning: 'badge-yellow',
  execution: 'badge-blue', active: 'badge-green', inactive: 'badge-gray',
  training: 'badge-purple', terminated: 'badge-red',
  paid: 'badge-green', partial: 'badge-yellow',
  pass: 'badge-green', fail: 'badge-red',
  delivered: 'badge-green', dispatched: 'badge-blue', acknowledged: 'badge-purple',
  po_sent: 'badge-blue', signed: 'badge-green', testing: 'badge-purple',
  // 2-level indent approval (mam's 2026-05-26) — intermediate state when
  // L1 (Nitin Jain ji) has approved but L2 (Nitin Sir) hasn't yet.
  l1_approved: 'badge-purple',
  interview_scheduled: 'badge-yellow', interview_done: 'badge-blue', offer_sent: 'badge-purple',
  onboarded: 'badge-green', advance_received: 'badge-green',
  verified: 'badge-blue',
  low: 'badge-gray', medium: 'badge-yellow', high: 'badge-red', critical: 'badge-red',
};

export default function StatusBadge({ status }) {
  if (!status) return null;
  const color = statusColors[status] || 'badge-gray';
  return <span className={`badge ${color}`}>{status.replace(/_/g, ' ')}</span>;
}
