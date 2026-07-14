// Seeds the 20 role-specific MIS scorecard templates mam shared on
// 2026-05-04. Runs once on server boot — only seeds when the
// score_templates table is empty so re-runs are no-ops.
//
// Sources: PDFs in C:\Users\admin\Desktop\scoring\ (Aanchal, Site Eng,
// Supervisor, Monika, Anmol, Ankush, Ajmer, Gaganpreet, Indresh, Lovely,
// Nancy, Nitin, Parul, Pradeep Panda, Raj Kumar, Rajeev Sood, Riti,
// Ruksana, Shubham, Sushila).
//
// data_source on each KPI:
//   'manual'              — admin / user types the actual each week
//   'auto:delegations'    — engine pulls from delegations table
//   'auto:pms'            — engine pulls from pms_tasks
//   'auto:checklists'     — engine pulls from checklist_completions
//   'auto:tickets'        — engine pulls from support_tickets

const TEMPLATES = [
  {
    name: 'Site Engineer',
    description: 'Site execution KPIs — DPR, indents, billing, manpower',
    kpis: [
      { group: 'Weekly', name: 'Weekly DPR Profit', weight: 25, source: 'auto:dpr_profit' },
      { group: 'Weekly', name: 'Indent Accuracy', weight: 10, source: 'auto:indents_in_week' },
      { group: 'Weekly', name: 'Project in Budget', weight: 0 },
      { group: 'Weekly', name: 'MB Signed from Client', weight: 10, source: 'auto:mb_signed' },
      { group: 'Weekly', name: 'Full kitting of manpower and tools before material', weight: 0 },
      { group: 'Weekly', name: 'Indent vs Bill', weight: 10 },
      { group: 'Weekly', name: 'Buffer used', weight: 10 },
      { group: 'Weekly', name: 'Scrap', weight: 5 },
      { group: 'Weekly', name: 'Rework', weight: 5, direction: 'lower_better' },
      { group: 'Weekly', name: 'Milestone completed', weight: 10 },
      { group: 'Weekly', name: 'Indent vs Consumption', weight: 10 },
      { group: 'Weekly', name: 'Stock at site', weight: 5, source: 'auto:stock_at_site' },
    ],
  },
  {
    name: 'Supervisor',
    description: 'On-ground supervision KPIs — DPR, full-kit, stock, photos',
    kpis: [
      { group: 'Basic',  name: 'PMS Task', weight: 5, source: 'auto:pms' },
      { group: 'Weekly', name: 'Rework', weight: 15, direction: 'lower_better' },
      { group: 'Weekly', name: 'DPR Planning', weight: 10, source: 'auto:dpr_count' },
      { group: 'Weekly', name: 'DPR Daily Actual', weight: 10, source: 'auto:dpr_by_user' },
      { group: 'Weekly', name: 'Full kit verification before start', weight: 10 },
      { group: 'Weekly', name: 'Material Receiving signed from client', weight: 10, source: 'auto:material_received' },
      { group: 'Weekly', name: 'Stock report accuracy', weight: 10, source: 'auto:stock_updates' },
      { group: 'Weekly', name: 'Daily Manpower photo', weight: 5 },
      { group: 'Weekly', name: 'Tools List submission', weight: 5, source: 'auto:tools_list' },
      { group: 'Weekly', name: 'Material Loss / Pilferage', weight: 5, direction: 'lower_better' },
      { group: 'Weekly', name: 'DPR Cost Accuracy', weight: 5, source: 'auto:dpr_cost_by_user' },
      { group: 'Weekly', name: 'DPR Profitability Accuracy', weight: 10, source: 'auto:dpr_profit_by_user' },
    ],
  },
  {
    name: 'Aanchal — Finance Executive',
    description: 'Cash-flow + recovery + expense control',
    kpis: [
      { group: 'Basic',  name: 'Checklist', weight: 5, source: 'auto:checklists' },
      { group: 'Basic',  name: 'Delegation', weight: 0, source: 'auto:delegations' },
      { group: 'Basic',  name: 'PMS', weight: 5, source: 'auto:pms' },
      { group: 'Basic',  name: 'Help Ticket', weight: 5, source: 'auto:tickets' },
      { group: 'Weekly', name: 'Overdue Recovery', weight: 15 },
      { group: 'Weekly', name: 'Expense Control (As Per Budget)', weight: 15, direction: 'lower_better' },
      { group: 'Weekly', name: 'Cash Flow Forecast Accuracy', weight: 10 },
      { group: 'Weekly', name: 'Cash Flow Positive', weight: 15 },
      { group: 'Weekly', name: 'Weekly Amount Received', weight: 30 },
    ],
  },
  {
    name: 'Monika — AI Implementation Head',
    description: 'AI roll-out, automations, ROI',
    kpis: [
      { group: 'Basic',  name: 'Delegation', weight: 10, source: 'auto:delegations' },
      { group: 'Basic',  name: 'Help Ticket', weight: 0, source: 'auto:tickets' },
      { group: 'Basic',  name: 'PMS', weight: 0, source: 'auto:pms' },
      { group: 'Weekly', name: 'New Tool Evaluated / Month', weight: 15, target: 3 },
      { group: 'Weekly', name: 'Automations Live Count', weight: 20, target: 4 },
      { group: 'Weekly', name: 'Hours Saved Company Wide / Month', weight: 20, target: 80 },
      { group: 'Weekly', name: 'ROI of AI Dept (X)', weight: 30, target: 1 },
    ],
  },
  {
    name: 'Anmol — DPR / Score Card',
    description: 'DPR planning + actual + score-card accuracy',
    kpis: [
      { group: 'Weekly', name: 'DPR Planning', weight: 10 },
      { group: 'Weekly', name: 'DPR Actual Collection', weight: 10 },
      { group: 'Weekly', name: 'DPR Planning Profit', weight: 10 },
      { group: 'Weekly', name: 'DPR Actual Profit', weight: 15 },
      { group: 'Weekly', name: 'Score Card Accuracy', weight: 10 },
      { group: 'Weekly', name: 'Data Accuracy', weight: 10 },
      { group: 'Weekly', name: 'System Running FMS', weight: 15 },
      { group: 'Weekly', name: 'Checklist', weight: 10, source: 'auto:checklists' },
      { group: 'Weekly', name: 'AI Automation Created', weight: 5 },
      { group: 'Weekly', name: 'Time Saved', weight: 5 },
    ],
  },
  {
    name: 'Ankush — HR Ops + Marketing',
    description: 'Hiring, social media, complaints, training',
    kpis: [
      { group: 'Basic',  name: 'Delegation', weight: 5, source: 'auto:delegations' },
      { group: 'Basic',  name: 'PMS', weight: 0, source: 'auto:pms' },
      { group: 'Basic',  name: 'Checklist', weight: 0, source: 'auto:checklists' },
      { group: 'Basic',  name: 'MEP Marketing Qualified Lead', weight: 10 },
      { group: 'Basic',  name: 'GEM Project Qualified Supply', weight: 10 },
      { group: 'Basic',  name: 'Company Social Media Post / Reels', weight: 10 },
      { group: 'Basic',  name: 'Company Social Media Likes', weight: 10 },
      { group: 'Basic',  name: 'Personal Social Media Post', weight: 10 },
      { group: 'HR',     name: 'Manpower Required Blue', weight: 15 },
      { group: 'HR',     name: 'Manpower Required White', weight: 15 },
      { group: 'Operations', name: 'Complaint Solved %', weight: 5 },
      { group: 'Operations', name: 'Documentation', weight: 5 },
      { group: 'Operations', name: 'Training', weight: 5 },
    ],
  },
  {
    name: 'Ajmer — Procurement Lead',
    description: 'Purchase to receiving + transport savings',
    kpis: [
      { group: 'Basic',  name: 'Delegation', weight: 0, source: 'auto:delegations' },
      { group: 'Basic',  name: 'PMS', weight: 0, source: 'auto:pms' },
      { group: 'Weekly', name: 'Purchase to Rec', weight: 35 },
      { group: 'Weekly', name: 'Transportation Saving', weight: 45 },
      { group: 'Weekly', name: 'Rental Tools Cost', weight: 20, direction: 'lower_better' },
    ],
  },
  {
    name: 'Gaganpreet — Cash Flow Manager',
    description: 'Cash positive, billing conversion, AR control',
    kpis: [
      { group: 'Weekly', name: 'Cash Positive', weight: 15 },
      { group: 'Weekly', name: 'Billing Conversion', weight: 10 },
      { group: 'Weekly', name: 'AR Control', weight: 15 },
      { group: 'Weekly', name: 'Unbilled Revenue', weight: 20, direction: 'lower_better' },
      { group: 'Weekly', name: 'PO to Purchase Bill', weight: 0 },
      { group: 'Weekly', name: 'Cash Forecast Accuracy', weight: 10 },
      { group: 'Weekly', name: 'Vendor Payment Discipline', weight: 15 },
      { group: 'Weekly', name: 'Top 10 Client Collection', weight: 15 },
      { group: 'Monthly', name: 'Monthly Throughput (Sales-TVC)', weight: 0 },
      { group: 'Monthly', name: 'PAT %', weight: 0 },
      { group: 'Monthly', name: 'Gross Margin %', weight: 0 },
      { group: 'Monthly', name: 'AR Days', weight: 0, direction: 'lower_better' },
      { group: 'Monthly', name: 'Cash Conversion Cycle', weight: 0, direction: 'lower_better' },
      { group: 'Monthly', name: 'Billing Cycle Time', weight: 0, direction: 'lower_better' },
      { group: 'Monthly', name: 'Interest Cost %', weight: 0, direction: 'lower_better' },
      { group: 'Monthly', name: 'Budget Variance %', weight: 0, direction: 'lower_better' },
      { group: 'Monthly', name: 'GST Recovery %', weight: 0 },
      { group: 'Monthly', name: 'Cash Reserve Days', weight: 0 },
      { group: 'Monthly', name: 'Compliance', weight: 0 },
    ],
  },
  {
    name: 'Indresh — Billing Engineer',
    description: 'RA bills, MB sheets, AI templates',
    kpis: [
      { group: 'Basic',  name: 'Checklist', weight: 5, source: 'auto:checklists' },
      { group: 'Basic',  name: 'Help Ticket', weight: 5, source: 'auto:tickets' },
      { group: 'Basic',  name: 'PMS Task', weight: 5, source: 'auto:pms' },
      { group: 'Weekly', name: 'RA Bills Raised Weekly', weight: 0, source: 'auto:ra_bills' },
      { group: 'Weekly', name: 'Measurement Sheet Submitted', weight: 0 },
      { group: 'Weekly', name: 'RA Bill Value (Lakhs)', weight: 0 },
      { group: 'Monthly', name: 'RA Bills Raised / Month', weight: 0 },
      { group: 'Monthly', name: 'RA Bill Value (Lakhs) Monthly', weight: 0 },
      { group: 'Monthly', name: 'RA Bill Rejection %', weight: 0, direction: 'lower_better' },
      { group: 'Monthly', name: 'AI Auto RA / MB Templates Used %', weight: 0 },
      { group: 'Monthly', name: 'AI Billing TAT Reduction %', weight: 0 },
    ],
  },
  {
    name: 'Lovely — Sales Coordinator',
    description: 'Payments, response time, full kitting, complaints',
    kpis: [
      { group: 'Basic',  name: 'PMS Task', weight: 0, source: 'auto:pms' },
      { group: 'Basic',  name: 'Help Ticket', weight: 0, source: 'auto:tickets' },
      { group: 'Basic',  name: 'Checklist', weight: 0, source: 'auto:checklists' },
      { group: 'Weekly', name: 'Payments Cleared (In lakh)', weight: 20 },
      { group: 'Weekly', name: 'Response Client Time On Whatsapp', weight: 15, direction: 'lower_better' },
      { group: 'Weekly', name: 'Response Client Time On Email', weight: 10, direction: 'lower_better' },
      { group: 'Weekly', name: 'Number of Escalations to MD', weight: 10, direction: 'lower_better' },
      { group: 'Full Kitting', name: 'Before Start', weight: 10 },
      { group: 'Full Kitting', name: 'Running', weight: 10 },
      { group: 'Full Kitting', name: 'Handover', weight: 10 },
      { group: 'Full Kitting', name: 'Complaint Resolved', weight: 10 },
      { group: 'Full Kitting', name: 'On Time', weight: 5 },
      { group: 'Monthly', name: 'AR Cleared (In CR)', weight: 0 },
      { group: 'Monthly', name: 'AR (In CR)', weight: 0, direction: 'lower_better' },
    ],
  },
  {
    name: 'Nancy — Estimation & Costing Head',
    description: 'BOQ delivery, TAT, margin, conversion',
    kpis: [
      { group: 'Weekly',    name: 'BOQ / Estimates Delivered', weight: 35 },
      { group: 'Weekly',    name: 'Estimation TAT', weight: 20, direction: 'lower_better' },
      { group: 'Weekly',    name: 'Revisions per Project', weight: 10, direction: 'lower_better' },
      { group: 'Weekly',    name: 'Margin Protected on Quotes', weight: 15 },
      { group: 'Weekly',    name: 'BOQ Accuracy %', weight: 0 },
      { group: 'Weekly',    name: 'Conversion', weight: 15 },
      { group: 'Weekly',    name: 'Costing Variance vs Actual', weight: 0, direction: 'lower_better' },
      { group: 'Data Entry', name: 'Lead Win to Business Book', weight: 0 },
      { group: 'Data Entry', name: 'Lead Entry Indent & Lead', weight: 1 },
      { group: 'Data Entry', name: 'Delegation Entry', weight: 2, source: 'auto:delegations' },
      { group: 'Data Entry', name: 'Task Entry', weight: 2 },
    ],
  },
  {
    name: 'Nitin Sir — MD',
    description: 'Throughput, cash flow, full kitting, DSO',
    kpis: [
      { group: 'Basic',  name: 'SR. Delegation', weight: 3, source: 'auto:delegations' },
      { group: 'Basic',  name: 'Help Ticket', weight: 2, source: 'auto:tickets' },
      { group: 'Weekly', name: 'Throughput', weight: 15 },
      { group: 'Weekly', name: 'Barchart vs Per Plan', weight: 10 },
      { group: 'Weekly', name: 'Cash Flow Positive', weight: 45 },
      { group: 'Weekly', name: 'WIP Control', weight: 0 },
      { group: 'Weekly', name: 'Full Kitting Execution', weight: 15 },
      { group: 'Weekly', name: 'Daily Sales Outstanding', weight: 10, direction: 'lower_better' },
    ],
  },
  {
    name: 'Parul — Compliance & Tender',
    description: 'Govt tender, compliance, bad debts, litigation',
    kpis: [
      { group: 'Basic',  name: 'Delegation', weight: 5, source: 'auto:delegations' },
      { group: 'Basic',  name: 'Help Ticket', weight: 0, source: 'auto:tickets' },
      { group: 'Basic',  name: 'PMS', weight: 5, source: 'auto:pms' },
      { group: 'Basic',  name: 'Checklist', weight: 0, source: 'auto:checklists' },
      { group: 'Weekly', name: 'Govt Tender Conversion %', weight: 10 },
      { group: 'Weekly', name: 'Compliance', weight: 15 },
      { group: 'Weekly', name: 'Bad Debts', weight: 15, direction: 'lower_better' },
      { group: 'Weekly', name: 'Gaganpreet Score', weight: 50 },
      { group: 'Monthly', name: 'Conversion %', weight: 15 },
      { group: 'Monthly', name: 'Litigation (1 case per month)', weight: 10 },
      { group: 'Monthly', name: 'Compliance (Monthly)', weight: 25 },
    ],
  },
  {
    name: 'Pradeep Panda — Operations Lead',
    description: 'Site labour, escalations, meetings, calendar',
    kpis: [
      { group: 'Weekly', name: 'Labour at Site', weight: 20 },
      { group: 'Weekly', name: 'Email Reply in 24hrs', weight: 10 },
      { group: 'Weekly', name: 'MD Sir Call Escalation', weight: 10, direction: 'lower_better' },
      { group: 'Weekly', name: 'All Company Delegation Task', weight: 20, source: 'auto:delegations' },
      { group: 'Weekly', name: 'Help Ticket', weight: 10, source: 'auto:tickets' },
      { group: 'Weekly', name: 'PMS Task', weight: 5, source: 'auto:pms' },
      { group: 'Weekly', name: 'Regular Meetings', weight: 10 },
      { group: 'Weekly', name: '50% Calendar Blank', weight: 5 },
      { group: 'Weekly', name: 'Travel Schedule', weight: 10 },
    ],
  },
  {
    name: 'Raj Kumar — Procurement Manager',
    description: 'Material, credit period, full kitting, vendor',
    kpis: [
      { group: 'Basic',  name: 'Delegation', weight: 5, source: 'auto:delegations' },
      { group: 'Basic',  name: 'Help Ticket', weight: 5, source: 'auto:tickets' },
      { group: 'Basic',  name: 'PMS', weight: 5, source: 'auto:pms' },
      { group: 'Basic',  name: 'Checklist', weight: 5, source: 'auto:checklists' },
      { group: 'Weekly', name: 'Negotiated Savings % (Estimation)', weight: 10 },
      { group: 'Weekly', name: 'Material on Credit %', weight: 10 },
      { group: 'Weekly', name: 'Credit Period Days', weight: 10 },
      { group: 'Weekly', name: 'Comparison to PO', weight: 10 },
      { group: 'Weekly', name: 'Full Kitting', weight: 10 },
      { group: 'Weekly', name: 'No Stock Out of Site', weight: 5 },
      { group: 'Weekly', name: 'Material Ready Before Schedule', weight: 10 },
      { group: 'Weekly', name: 'Indent to Receiving', weight: 10 },
      { group: 'Weekly', name: 'Order to Planning', weight: 5 },
      { group: 'Monthly', name: 'Cost Saving', weight: 0 },
      { group: 'Monthly', name: 'Indent to Receiving (Monthly)', weight: 0, direction: 'lower_better' },
      { group: 'Monthly', name: 'Vendor Performance Score', weight: 0 },
      { group: 'Monthly', name: 'Procurement Impact on Delays', weight: 0, direction: 'lower_better' },
    ],
  },
  {
    name: 'Rajeev Sood — Quotation',
    description: 'Quotation quantity, TAT, conversion, costing accuracy',
    kpis: [
      { group: 'Quotation', name: 'Quantity', weight: 25 },
      { group: 'Quotation', name: 'Turnaround Time', weight: 35, direction: 'lower_better' },
      { group: 'Quotation', name: 'Conversion', weight: 20 },
      { group: 'Quotation', name: 'Costing Accuracy', weight: 10 },
      { group: 'Quotation', name: 'Revision Turnaround Time', weight: 10, direction: 'lower_better' },
      { group: 'Monthly', name: 'GP %', weight: 0 },
      { group: 'Monthly', name: 'Conversion (Monthly)', weight: 0 },
    ],
  },
  {
    name: 'Riti — Sales Coordinator (Sales Side)',
    description: 'Meetings, average ticket, response time, lead time',
    kpis: [
      { group: 'Basic',  name: 'Delegation', weight: 5, source: 'auto:delegations' },
      { group: 'Basic',  name: 'PMS Task', weight: 5, source: 'auto:pms' },
      { group: 'Weekly', name: 'Meeting Planned', weight: 25 },
      { group: 'Weekly', name: 'Average Ticket', weight: 30 },
      { group: 'Weekly', name: 'Client Response Time Email', weight: 10, direction: 'lower_better' },
      { group: 'Weekly', name: 'Client Response Time Whatsapp', weight: 0, direction: 'lower_better' },
      { group: 'Weekly', name: 'Proposal Turnaround Time', weight: 10, direction: 'lower_better' },
      { group: 'Weekly', name: 'Lead Time to Call', weight: 10, direction: 'lower_better' },
      { group: 'Weekly', name: 'Sales to Execution Handover', weight: 15 },
      { group: 'Weekly', name: 'Escalation Matrix to MD', weight: 5, direction: 'lower_better' },
      { group: 'Monthly', name: 'Conversion %', weight: 20 },
      { group: 'Monthly', name: 'Sales Pipeline %', weight: 30 },
    ],
  },
  {
    name: 'Ruksana — HR Hiring',
    description: 'Sub-contractor + secured employee hiring',
    kpis: [
      { group: 'Basic',  name: 'Delegation', weight: 0, source: 'auto:delegations' },
      { group: 'Basic',  name: 'PMS Task', weight: 0, source: 'auto:pms' },
      { group: 'Basic',  name: 'Checklist', weight: 0, source: 'auto:checklists' },
      { group: 'Contractor', name: 'Sub-Contractor Blue Collar Lead to Call', weight: 0 },
      { group: 'Contractor', name: 'On-Board', weight: 0 },
      { group: 'Contractor', name: 'Labour Cost Variance', weight: 0, direction: 'lower_better' },
      { group: 'Secured Emp', name: 'SEPL White Collar Lead to Call', weight: 10 },
      { group: 'Secured Emp', name: 'SEPL Blue Collar Lead to Call', weight: 10 },
      { group: 'Secured Emp', name: 'SEPL White Collar Cost', weight: 15, direction: 'lower_better' },
      { group: 'Secured Emp', name: 'SEPL Blue Collar Cost', weight: 10, direction: 'lower_better' },
      { group: 'Secured Emp', name: 'Shortlisted Turnaround Time', weight: 20, direction: 'lower_better' },
      { group: 'Secured Emp', name: 'Joining Conversion', weight: 35 },
    ],
  },
  {
    name: 'Shubham — Accounts',
    description: 'Indent comparison, budgeting, project planning, compliance',
    kpis: [
      { group: 'Basic',  name: 'PMS', weight: 5, source: 'auto:pms' },
      { group: 'Basic',  name: 'Checklist', weight: 5, source: 'auto:checklists' },
      { group: 'Basic',  name: 'Help Ticket', weight: 5, source: 'auto:tickets' },
      { group: 'Weekly', name: 'Indent to Comparison', weight: 10 },
      { group: 'Weekly', name: 'Budgeting vs Actual', weight: 15 },
      { group: 'Weekly', name: 'Project-wise Budget vs Actual', weight: 10 },
      { group: 'Weekly', name: 'Project-wise Cash Flow Planning', weight: 10 },
      { group: 'Weekly', name: 'Project-wise Planning Accuracy', weight: 20 },
      { group: 'Weekly', name: 'Purchase Bill to Receiving', weight: 10 },
      { group: 'Weekly', name: 'Compliance', weight: 5 },
      { group: 'Weekly', name: 'Compliance on Time', weight: 5 },
      { group: 'Monthly', name: 'Indent vs Receiving', weight: 0 },
      { group: 'Monthly', name: 'Budget vs Actual', weight: 0 },
      { group: 'Monthly', name: 'Cash Flow Forecasting', weight: 0 },
      { group: 'Monthly', name: 'Billing TAT', weight: 0, direction: 'lower_better' },
      { group: 'Monthly', name: 'AI Tools', weight: 0 },
      { group: 'Monthly', name: 'Compliance Qty', weight: 0 },
    ],
  },
  {
    name: 'Sushila — Sales Coordinator',
    description: 'Same template family as Lovely (Sales Coordinator)',
    kpis: [
      { group: 'Basic',  name: 'PMS Task', weight: 5, source: 'auto:pms' },
      { group: 'Basic',  name: 'Help Ticket', weight: 0, source: 'auto:tickets' },
      { group: 'Basic',  name: 'Checklist', weight: 0, source: 'auto:checklists' },
      { group: 'Weekly', name: 'Payments Cleared (In lakh)', weight: 15 },
      { group: 'Weekly', name: 'Response Client Time On Whatsapp', weight: 15, direction: 'lower_better' },
      { group: 'Weekly', name: 'Response Client Time On Email', weight: 15, direction: 'lower_better' },
      { group: 'Weekly', name: 'Number of Escalations to MD', weight: 10, direction: 'lower_better' },
      { group: 'Full Kitting', name: 'Before Start', weight: 10 },
      { group: 'Full Kitting', name: 'Running', weight: 15 },
      { group: 'Full Kitting', name: 'Handover', weight: 15 },
      { group: 'Full Kitting', name: 'Complaint Resolved', weight: 0 },
      { group: 'Full Kitting', name: 'On Time', weight: 0 },
      { group: 'Monthly', name: 'AR Cleared (In CR)', weight: 0 },
      { group: 'Monthly', name: 'AR (In CR)', weight: 0, direction: 'lower_better' },
    ],
  },
];

// One-time data_source upgrade for templates seeded BEFORE the auto-fetch
// patches landed. Maps (template_name, kpi_metric_name) -> new data_source.
// Idempotent — only updates rows where data_source is still 'manual'.
function upgradeAutoSources(db) {
  const map = [
    ['Site Engineer', 'Weekly DPR Profit', 'auto:dpr_profit'],
    ['Site Engineer', 'Indent Accuracy', 'auto:indents_in_week'],
    ['Site Engineer', 'Indent vs Bill', 'auto:indent_vs_bill'],
    // mam 2026-06-29 "automate where manual & data exists": only these two had a
    // real source table with data (complaints=8, candidates=61). Meetings &
    // quotations tables are EMPTY so those KPIs stay manual; amount-in-lakh/CR
    // and %/quality KPIs have no clean auto source and also stay manual.
    ['Sushila — Sales Coordinator', 'Complaint Resolved', 'auto:complaints_resolved'],
    ['Ruksana — HR Hiring', 'On-Board', 'auto:candidates_onboarded'],
    ['Anmol — DPR / Score Card', 'Itemwise complete', 'auto:items_complete'],
    // Finance amount KPIs whose target is in lakh / crore (mam 2026-06-29: auto
    // them). Weekly collections in lakh; current open receivables in crore.
    ['Aanchal — Finance Executive', 'Weekly Amount Received', 'auto:amount_received_lakh'],
    ['Sushila — Sales Coordinator', 'Payments Cleared (In lakh)', 'auto:amount_received_lakh'],
    ['Lovely — Sales Coordinator', 'Payments Cleared (In lakh)', 'auto:amount_received_lakh'],
    ['Sushila — Sales Coordinator', 'AR (In CR)', 'auto:receivables_outstanding_cr'],
    ['Lovely — Sales Coordinator', 'AR (In CR)', 'auto:receivables_outstanding_cr'],
    ['Site Engineer', 'MB Signed from Client', 'auto:mb_signed'],
    ['Site Engineer', 'Stock at site', 'auto:stock_at_site'],
    ['Supervisor', 'DPR Planning', 'auto:dpr_count'],
    ['Supervisor', 'DPR Daily Actual', 'auto:dpr_by_user'],
    ['Supervisor', 'Material Receiving signed from client', 'auto:material_received'],
    ['Supervisor', 'Stock report accuracy', 'auto:stock_updates'],
    ['Supervisor', 'Tools List submission', 'auto:tools_list'],
    ['Supervisor', 'DPR Cost Accuracy', 'auto:dpr_cost_by_user'],
    ['Supervisor', 'DPR Profitability Accuracy', 'auto:dpr_profit_by_user'],
    ['Indresh — Billing Engineer', 'RA Bills Raised Weekly', 'auto:ra_bills'],
  ];
  const upd = db.prepare(`
    UPDATE score_kpis
       SET data_source = ?
     WHERE data_source = 'manual'
       AND metric_name = ?
       AND template_id = (SELECT id FROM score_templates WHERE name = ? LIMIT 1)
  `);
  let changed = 0;
  for (const [tpl, kpi, src] of map) {
    const r = upd.run(src, kpi, tpl);
    changed += r.changes || 0;
  }
  return changed;
}

function seedScoringTemplates(db) {
  // Always run the upgrade passes — all are idempotent
  const upgraded = upgradeAutoSources(db);
  const targetsUpgraded = upgradeFixedTargets(db);
  // Add the cross-module RACI row to any existing template missing it.
  let raciAdded = addRaciKpiToTemplates(db);
  // Owner / company-wide KPIs for process owners (Sushila → all PMS, Anmol → ERP coverage).
  let ownerAdded = addOwnerKpis(db);
  // Skip initial seed if templates already exist
  const count = db.prepare('SELECT COUNT(*) as c FROM score_templates').get().c;
  if (count > 0) return { seeded: 0, skipped: count, upgraded, targetsUpgraded, raciAdded, ownerAdded };

  const insertTemplate = db.prepare(
    'INSERT INTO score_templates (name, description) VALUES (?, ?)'
  );
  const insertKpi = db.prepare(
    `INSERT INTO score_kpis (template_id, group_name, metric_name, weightage, direction, data_source, display_order, default_planned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const tx = db.transaction(() => {
    for (const t of TEMPLATES) {
      const r = insertTemplate.run(t.name, t.description || null);
      const tid = r.lastInsertRowid;
      let order = 0;
      for (const k of t.kpis) {
        insertKpi.run(
          tid,
          k.group || 'Weekly',
          k.name,
          k.weight || 0,
          k.direction || 'higher_better',
          k.source || 'manual',
          order++,
          k.target || 0
        );
      }
    }
  });
  tx();
  // After initial seed, run the fixed-target pass so brand-new installs
  // get all the bulk-seeded Planned values too, and attach the RACI row to
  // every freshly-seeded template.
  const targetsApplied = upgradeFixedTargets(db);
  raciAdded += addRaciKpiToTemplates(db);
  ownerAdded += addOwnerKpis(db);
  return { seeded: TEMPLATES.length, skipped: 0, upgraded, targetsApplied, raciAdded, ownerAdded };
}

// Bulk-seed all 100+ fixed Planned targets extracted from mam's MIS PDFs.
// Idempotent — only sets default_planned when it's still 0, so any
// admin tweaks via the Templates UI are preserved across deploys.
function upgradeFixedTargets(db) {
  const targets = [
    // Aanchal — Finance Executive
    ['Aanchal — Finance Executive', 'Checklist', 47],
    ['Aanchal — Finance Executive', 'Expense Control (As Per Budget)', 10000],
    ['Aanchal — Finance Executive', 'Cash Flow Positive', 1000000],
    ['Aanchal — Finance Executive', 'Weekly Amount Received', 1.25],

    // Site Engineer
    ['Site Engineer', 'Weekly DPR Profit', 22753.5],
    ['Site Engineer', 'MB Signed from Client', 1],
    ['Site Engineer', 'Indent vs Bill', 1],
    ['Site Engineer', 'Rework', 2],
    ['Site Engineer', 'Indent vs Consumption', 3],
    ['Site Engineer', 'Stock at site', 1],

    // Supervisor
    ['Supervisor', 'Rework', 2],
    ['Supervisor', 'DPR Planning', 1],
    ['Supervisor', 'DPR Daily Actual', 7],
    ['Supervisor', 'Stock report accuracy', 15],
    ['Supervisor', 'Daily Manpower photo', 7],
    ['Supervisor', 'Tools List submission', 1],
    ['Supervisor', 'DPR Cost Accuracy', 7],
    ['Supervisor', 'DPR Profitability Accuracy', 30000],

    // Monika — AI Implementation Head
    ['Monika — AI Implementation Head', 'New Tool Evaluated / Month', 3],
    ['Monika — AI Implementation Head', 'Automations Live Count', 4],
    ['Monika — AI Implementation Head', 'Hours Saved Company Wide / Month', 80],
    ['Monika — AI Implementation Head', 'ROI of AI Dept (X)', 1],

    // Anmol — DPR / Score Card
    ['Anmol — DPR / Score Card', 'DPR Planning', 7],
    ['Anmol — DPR / Score Card', 'DPR Actual Collection', 49],
    ['Anmol — DPR / Score Card', 'DPR Planning Profit', 135057],
    ['Anmol — DPR / Score Card', 'DPR Actual Profit', 135057],
    ['Anmol — DPR / Score Card', 'Score Card Accuracy', 40],
    ['Anmol — DPR / Score Card', 'System Running FMS', -20],
    ['Anmol — DPR / Score Card', 'Checklist', 197],
    ['Anmol — DPR / Score Card', 'AI Automation Created', 2],
    ['Anmol — DPR / Score Card', 'Time Saved', 120],

    // Ankush — HR Ops + Marketing
    ['Ankush — HR Ops + Marketing', 'MEP Marketing Qualified Lead', 6],
    ['Ankush — HR Ops + Marketing', 'GEM Project Qualified Supply', 6],
    ['Ankush — HR Ops + Marketing', 'Company Social Media Post / Reels', 30],
    ['Ankush — HR Ops + Marketing', 'Company Social Media Likes', 5],
    ['Ankush — HR Ops + Marketing', 'Personal Social Media Post', 30],
    ['Ankush — HR Ops + Marketing', 'Manpower Required Blue', 120],
    ['Ankush — HR Ops + Marketing', 'Manpower Required White', 120],
    ['Ankush — HR Ops + Marketing', 'Complaint Solved %', 24],
    ['Ankush — HR Ops + Marketing', 'Training', 3],

    // Ajmer — Procurement Lead
    ['Ajmer — Procurement Lead', 'Transportation Saving', 15000],

    // Gaganpreet — Cash Flow Manager
    ['Gaganpreet — Cash Flow Manager', 'Cash Positive', 1000000],
    ['Gaganpreet — Cash Flow Manager', 'Billing Conversion', 822712],
    ['Gaganpreet — Cash Flow Manager', 'AR Control', 15],
    ['Gaganpreet — Cash Flow Manager', 'Top 10 Client Collection', 10],

    // Indresh — Billing Engineer
    ['Indresh — Billing Engineer', 'RA Bills Raised Weekly', 3],
    ['Indresh — Billing Engineer', 'Measurement Sheet Submitted', 3],
    ['Indresh — Billing Engineer', 'RA Bill Value (Lakhs)', 125],
    ['Indresh — Billing Engineer', 'RA Bills Raised / Month', 12],
    ['Indresh — Billing Engineer', 'RA Bill Value (Lakhs) Monthly', 500],
    ['Indresh — Billing Engineer', 'RA Bill Rejection %', 2],
    ['Indresh — Billing Engineer', 'AI Auto RA / MB Templates Used %', 90],
    ['Indresh — Billing Engineer', 'AI Billing TAT Reduction %', 50],

    // Lovely — Sales Coordinator
    ['Lovely — Sales Coordinator', 'Payments Cleared (In lakh)', 62.5],
    ['Lovely — Sales Coordinator', 'Response Client Time On Whatsapp', 30],
    ['Lovely — Sales Coordinator', 'Response Client Time On Email', 60],
    ['Lovely — Sales Coordinator', 'Number of Escalations to MD', 5],
    ['Lovely — Sales Coordinator', 'Before Start', 12],
    ['Lovely — Sales Coordinator', 'Running', 12],
    ['Lovely — Sales Coordinator', 'On Time', 48],
    ['Lovely — Sales Coordinator', 'AR Cleared (In CR)', 2.5],
    ['Lovely — Sales Coordinator', 'AR (In CR)', 5],

    // Nancy — Estimation & Costing Head
    ['Nancy — Estimation & Costing Head', 'BOQ / Estimates Delivered', 2],
    ['Nancy — Estimation & Costing Head', 'Estimation TAT', 2],
    ['Nancy — Estimation & Costing Head', 'Revisions per Project', 2],
    ['Nancy — Estimation & Costing Head', 'Margin Protected on Quotes', 35],
    ['Nancy — Estimation & Costing Head', 'Conversion', 1],
    ['Nancy — Estimation & Costing Head', 'Lead Entry Indent & Lead', 114],
    ['Nancy — Estimation & Costing Head', 'Delegation Entry', 25],
    ['Nancy — Estimation & Costing Head', 'Task Entry', 28],

    // Nitin Sir — MD
    ['Nitin Sir — MD', 'Throughput', 1000000],
    ['Nitin Sir — MD', 'Barchart vs Per Plan', 30],
    ['Nitin Sir — MD', 'Cash Flow Positive', 1000000],
    ['Nitin Sir — MD', 'Full Kitting Execution', 12],
    ['Nitin Sir — MD', 'Daily Sales Outstanding', 30],

    // Parul — Compliance & Tender
    ['Parul — Compliance & Tender', 'Delegation', 1],
    ['Parul — Compliance & Tender', 'PMS', 2],
    ['Parul — Compliance & Tender', 'Compliance', 20],
    ['Parul — Compliance & Tender', 'Bad Debts', 32.5],
    ['Parul — Compliance & Tender', 'Gaganpreet Score', -10],
    ['Parul — Compliance & Tender', 'Litigation (1 case per month)', 1],
    ['Parul — Compliance & Tender', 'Compliance (Monthly)', 32.5],

    // Pradeep Panda — Operations Lead
    ['Pradeep Panda — Operations Lead', 'Labour at Site', 200],
    ['Pradeep Panda — Operations Lead', 'Email Reply in 24hrs', 24],
    ['Pradeep Panda — Operations Lead', 'MD Sir Call Escalation', 5],
    ['Pradeep Panda — Operations Lead', 'All Company Delegation Task', 32],
    ['Pradeep Panda — Operations Lead', 'PMS Task', 13],
    ['Pradeep Panda — Operations Lead', 'Regular Meetings', 45],
    ['Pradeep Panda — Operations Lead', '50% Calendar Blank', 6],
    ['Pradeep Panda — Operations Lead', 'Travel Schedule', 6],

    // Raj Kumar — Procurement Manager
    ['Raj Kumar — Procurement Manager', 'Credit Period Days', 60],
    ['Raj Kumar — Procurement Manager', 'Full Kitting', 9],
    ['Raj Kumar — Procurement Manager', 'Indent to Receiving', 109],
    ['Raj Kumar — Procurement Manager', 'Cost Saving', 20],
    ['Raj Kumar — Procurement Manager', 'Vendor Performance Score', 90],
    ['Raj Kumar — Procurement Manager', 'Procurement Impact on Delays', 5],

    // Rajeev Sood — Quotation
    ['Rajeev Sood — Quotation', 'Quantity', 2],
    ['Rajeev Sood — Quotation', 'Turnaround Time', 2],
    ['Rajeev Sood — Quotation', 'Conversion', 1],
    ['Rajeev Sood — Quotation', 'Costing Accuracy', 5],
    ['Rajeev Sood — Quotation', 'Revision Turnaround Time', 1],
    ['Rajeev Sood — Quotation', 'GP %', 30],
    ['Rajeev Sood — Quotation', 'Conversion (Monthly)', 20],

    // Riti — Sales Coordinator (Sales Side)
    ['Riti — Sales Coordinator (Sales Side)', 'Meeting Planned', 12],
    ['Riti — Sales Coordinator (Sales Side)', 'Average Ticket', 50],
    ['Riti — Sales Coordinator (Sales Side)', 'Client Response Time Email', 60],
    ['Riti — Sales Coordinator (Sales Side)', 'Client Response Time Whatsapp', 30],
    ['Riti — Sales Coordinator (Sales Side)', 'Proposal Turnaround Time', 2],
    ['Riti — Sales Coordinator (Sales Side)', 'Lead Time to Call', 2],
    ['Riti — Sales Coordinator (Sales Side)', 'Escalation Matrix to MD', 5],
    ['Riti — Sales Coordinator (Sales Side)', 'Conversion %', 20],
    ['Riti — Sales Coordinator (Sales Side)', 'Sales Pipeline %', 30],

    // Ruksana — HR Hiring
    ['Ruksana — HR Hiring', 'SEPL White Collar Lead to Call', 30],
    ['Ruksana — HR Hiring', 'SEPL White Collar Cost', 50000],
    ['Ruksana — HR Hiring', 'Shortlisted Turnaround Time', 2],
    ['Ruksana — HR Hiring', 'Joining Conversion', 2],

    // Shubham — Accounts
    ['Shubham — Accounts', 'PMS', 2],
    ['Shubham — Accounts', 'Checklist', 18],
    ['Shubham — Accounts', 'Indent to Comparison', 66],
    ['Shubham — Accounts', 'Compliance', 20],

    // Sushila — Sales Coordinator
    ['Sushila — Sales Coordinator', 'PMS Task', 1],
    ['Sushila — Sales Coordinator', 'Checklist', 4],
    ['Sushila — Sales Coordinator', 'Payments Cleared (In lakh)', 62.5],
    ['Sushila — Sales Coordinator', 'Response Client Time On Whatsapp', 30],
    ['Sushila — Sales Coordinator', 'Response Client Time On Email', 60],
    ['Sushila — Sales Coordinator', 'Number of Escalations to MD', 5],
    ['Sushila — Sales Coordinator', 'Before Start', 12],
    ['Sushila — Sales Coordinator', 'Running', 12],
    ['Sushila — Sales Coordinator', 'On Time', 48],
    ['Sushila — Sales Coordinator', 'AR Cleared (In CR)', 2.5],
    ['Sushila — Sales Coordinator', 'AR (In CR)', 5],
  ];
  const upd = db.prepare(`
    UPDATE score_kpis
       SET default_planned = ?
     WHERE COALESCE(default_planned, 0) = 0
       AND metric_name = ?
       AND template_id = (SELECT id FROM score_templates WHERE name = ? LIMIT 1)
  `);
  let changed = 0;
  for (const [tpl, kpi, val] of targets) {
    const r = upd.run(val, kpi, tpl);
    changed += r.changes || 0;
  }
  return changed;
}

// Surface the cross-module RACI workload on EVERY scorecard (mam 2026-06-27:
// "if I change every module's RACI according to that person, add in scoring also
// planned actual"). Adds one "RACI Steps (All Modules)" row to each template
// that lacks it: Planned = steps on that person this week (closed + still open),
// Actual = steps they closed — both pulled live from raci_assignment. Weight 0
// so it shows for everyone WITHOUT changing their current score; admin can give
// it weight later. Idempotent — the NOT EXISTS guard skips templates already
// carrying the row, so re-runs on every boot are no-ops.
function addRaciKpiToTemplates(db) {
  const r = db.prepare(`
    INSERT INTO score_kpis (template_id, group_name, metric_name, weightage, direction, data_source, display_order, default_planned)
    SELECT t.id, 'Responsibility', 'RACI Steps (All Modules)', 0, 'higher_better', 'auto:raci_steps_done', 900, 0
      FROM score_templates t
     WHERE COALESCE(t.active, 1) = 1
       AND NOT EXISTS (
         SELECT 1 FROM score_kpis k
          WHERE k.template_id = t.id AND k.data_source = 'auto:raci_steps_done'
       )
  `).run();
  return r.changes || 0;
}

// Owner / company-wide KPIs (mam 2026-06-29): a PROCESS OWNER is scored on the
// whole process, not just their own records. Idempotent + guarded by template
// name — no-op if the template was renamed/absent (then add it via the source
// dropdown). Added at 0 weight so it shows Planned vs Actual without disturbing
// the existing 100% split; the admin sets the weight they want.
function addOwnerKpis(db) {
  const add = (tplName, group, metric, source, order) => {
    const r = db.prepare(`
      INSERT INTO score_kpis (template_id, group_name, metric_name, weightage, direction, data_source, display_order, default_planned)
      SELECT t.id, ?, ?, 0, 'higher_better', ?, ?, 0
        FROM score_templates t
       WHERE t.name = ? AND COALESCE(t.active, 1) = 1
         AND NOT EXISTS (SELECT 1 FROM score_kpis k WHERE k.template_id = t.id AND k.data_source = ?)
    `).run(group, metric, source, order, tplName, source);
    return r.changes || 0;
  };
  let n = 0;
  n += add('Sushila — Sales Coordinator', 'Owner', 'All PMS Tasks (company-wide)', 'auto:pms_all', 950);
  n += add('Anmol — DPR / Score Card', 'Owner', 'ERP Modules Active (coverage)', 'auto:erp_module_coverage', 950);
  return n;
}

module.exports = { seedScoringTemplates, TEMPLATES };
