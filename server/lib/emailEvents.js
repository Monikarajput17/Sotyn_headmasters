// Email-trigger event catalog (mam 2026-06-03: "lots of email with trigger
// and pattern with my selected things, dynamic").
//
// Each event declares:
//   key      — stable identifier fired from server code (fireEmailEvent)
//   label    — human name shown in the Email Triggers UI
//   group    — bucket for the UI ("Indent", "DPR & Site", ...)
//   live     — true when server code actually fires this event today
//   vars     — template variables available in subject/body as {{name}}
//   people   — dynamic recipients resolvable from the event context
//              (each maps to an email the engine pulls out of context)
//   fields   — condition-able fields (for the optional "only if" filter)
//
// Adding a new source later = (1) add an entry here, (2) call
// fireEmailEvent(key, context) from that route with the documented vars +
// *_email people.  The UI and engine pick it up automatically.

const EVENTS = {
  'indent.raised': {
    label: 'Indent raised',
    group: 'Indent',
    live: true,
    vars: ['indent_no', 'site', 'category', 'amount', 'raised_by', 'date'],
    people: [
      { key: 'raiser_email', label: 'Indent raiser' },
      { key: 'crm_owner_email', label: 'Project CRM owner' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['category', 'site', 'amount'],
  },
  'indent.crm_approved': {
    label: 'Indent — CRM approved (Extra item)',
    group: 'Indent',
    live: true,
    vars: ['indent_no', 'site', 'category', 'amount', 'margin_pct', 'crm_by', 'date'],
    people: [
      { key: 'raiser_email', label: 'Indent raiser' },
      { key: 'crm_owner_email', label: 'Project CRM owner' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['category', 'site', 'amount'],
  },
  'indent.l1_approved': {
    label: 'Indent — L1 approved',
    group: 'Indent',
    live: true,
    vars: ['indent_no', 'site', 'category', 'amount', 'l1_by', 'date'],
    people: [
      { key: 'raiser_email', label: 'Indent raiser' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['category', 'site', 'amount'],
  },
  'indent.approved': {
    label: 'Indent — fully approved',
    group: 'Indent',
    live: true,
    vars: ['indent_no', 'site', 'category', 'amount', 'approved_by', 'date'],
    people: [
      { key: 'raiser_email', label: 'Indent raiser' },
      { key: 'crm_owner_email', label: 'Project CRM owner' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['category', 'site', 'amount'],
  },
  'indent.rejected': {
    label: 'Indent rejected',
    group: 'Indent',
    live: true,
    vars: ['indent_no', 'site', 'category', 'amount', 'rejected_by', 'reason', 'date'],
    people: [
      { key: 'raiser_email', label: 'Indent raiser' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['category', 'site', 'amount'],
  },
  'dpr.loss_streak': {
    label: 'DPR — consecutive loss days',
    group: 'DPR & Site',
    live: true,
    vars: ['site', 'days', 'total_loss', 'date'],
    people: [
      { key: 'director_email', label: 'Director (default recipient)' },
      { key: 'site_engineer_email', label: 'Site engineer' },
    ],
    fields: ['site', 'days'],
  },

  // ─── Payments & Bills ───────────────────────────────────────────────
  'payment.requested': {
    label: 'Payment request raised',
    group: 'Payments & Bills',
    live: true,
    vars: ['amount', 'party', 'category', 'site', 'purpose', 'requested_by', 'date'],
    people: [
      { key: 'requester_email', label: 'Requester' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['category', 'site', 'amount'],
  },
  'payment.approved': {
    label: 'Payment approved',
    group: 'Payments & Bills',
    live: true,
    vars: ['amount', 'party', 'category', 'step', 'approved_by', 'date'],
    people: [
      { key: 'requester_email', label: 'Requester' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['category', 'amount'],
  },
  'payment.rejected': {
    label: 'Payment rejected',
    group: 'Payments & Bills',
    live: true,
    vars: ['amount', 'party', 'category', 'rejected_by', 'reason', 'date'],
    people: [
      { key: 'requester_email', label: 'Requester' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['category', 'amount'],
  },
  'bill.uploaded': {
    label: 'Purchase bill uploaded',
    group: 'Payments & Bills',
    live: true,
    vars: ['bill_number', 'amount', 'vendor', 'uploaded_by', 'date'],
    people: [
      { key: 'uploader_email', label: 'Uploaded by' },
      { key: 'vendor_email', label: 'Vendor' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['vendor', 'amount'],
  },

  // ─── Complaints & Support ───────────────────────────────────────────
  'complaint.created': {
    label: 'Complaint registered',
    group: 'Complaints & Support',
    live: true,
    vars: ['complaint_no', 'client', 'category', 'problem', 'created_by', 'date'],
    people: [
      { key: 'creator_email', label: 'Created by' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['category', 'client'],
  },
  'complaint.assigned': {
    label: 'Complaint assigned to engineer',
    group: 'Complaints & Support',
    live: true,
    vars: ['complaint_no', 'client', 'engineer', 'date'],
    people: [
      { key: 'engineer_email', label: 'Assigned engineer' },
      { key: 'creator_email', label: 'Created by' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['client'],
  },
  'complaint.resolved': {
    label: 'Complaint resolved',
    group: 'Complaints & Support',
    live: true,
    vars: ['complaint_no', 'client', 'engineer', 'date'],
    people: [
      { key: 'creator_email', label: 'Created by' },
      { key: 'engineer_email', label: 'Assigned engineer' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['client'],
  },
  'ticket.created': {
    label: 'Help ticket created',
    group: 'Complaints & Support',
    live: true,
    vars: ['ticket_no', 'subject', 'priority', 'category', 'created_by', 'date'],
    people: [
      { key: 'creator_email', label: 'Created by' },
      { key: 'assignee_email', label: 'Assignee' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['priority', 'category'],
  },
  'ticket.resolved': {
    label: 'Help ticket resolved',
    group: 'Complaints & Support',
    live: true,
    vars: ['ticket_no', 'subject', 'resolved_by', 'date'],
    people: [
      { key: 'creator_email', label: 'Created by' },
      { key: 'assignee_email', label: 'Assignee' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: [],
  },

  // ─── HR ─────────────────────────────────────────────────────────────
  'leave.requested': {
    label: 'Leave request submitted',
    group: 'HR',
    live: true,
    vars: ['employee', 'leave_type', 'from_date', 'to_date', 'days', 'reason', 'date'],
    people: [
      { key: 'requester_email', label: 'Employee' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['leave_type'],
  },
  'leave.decided': {
    label: 'Leave approved / rejected',
    group: 'HR',
    live: true,
    vars: ['employee', 'leave_type', 'status', 'decided_by', 'date'],
    people: [
      { key: 'requester_email', label: 'Employee' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['leave_type', 'status'],
  },
  'task.assigned': {
    label: 'Task / delegation assigned',
    group: 'HR',
    live: true,
    vars: ['title', 'project', 'due_date', 'assigned_by', 'date'],
    people: [
      { key: 'assignee_email', label: 'Assignee' },
      { key: 'assigner_email', label: 'Assigned by' },
    ],
    fields: ['project'],
  },
};

// Sample values so "Send test" renders a realistic preview without needing
// a live record.
const SAMPLE_CONTEXT = {
  indent_no: 'IND-0123',
  site: 'HERO HOMES',
  category: 'extra_non_schedule',
  amount: '12,500',
  raised_by: 'Raushan Kumar',
  approved_by: 'Nitin Sir',
  l1_by: 'Nitin Jain',
  crm_by: 'Sushila',
  rejected_by: 'Admin',
  reason: 'Budget exceeded',
  margin_pct: '15',
  days: '3',
  total_loss: '45,000',
  date: '2026-06-03',
  // Payments & bills
  amount: '12,500',
  party: 'ABC Traders',
  purpose: 'Site material advance',
  requested_by: 'Raushan Kumar',
  step: 'L1',
  vendor: 'ABC Traders',
  bill_number: 'BILL-0042',
  uploaded_by: 'Store Team',
  // Complaints & support
  complaint_no: 'CMP-0007',
  client: 'Hero Homes',
  problem: 'AC not cooling',
  created_by: 'Front Desk',
  engineer: 'Aakash Chaudhary',
  ticket_no: 'TKT-0019',
  subject: 'Login not working',
  priority: 'High',
  resolved_by: 'Admin',
  // HR
  employee: 'Monika',
  leave_type: 'Casual',
  from_date: '2026-06-05',
  to_date: '2026-06-06',
  status: 'approved',
  decided_by: 'HR Manager',
  title: 'Submit weekly report',
  project: 'Hero Homes',
  due_date: '2026-06-07',
  assigned_by: 'Manager',
};

function listEvents() {
  return Object.entries(EVENTS).map(([key, e]) => ({ key, ...e }));
}

module.exports = { EVENTS, SAMPLE_CONTEXT, listEvents };
