import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import {
  FiPlus, FiSearch, FiFilter, FiDownload, FiEdit2, FiTrash2, FiEye,
  FiX, FiBook, FiTrendingUp, FiClock, FiUpload, FiList, FiGrid,
  FiChevronRight, FiChevronDown, FiUsers, FiMapPin
} from 'react-icons/fi';
import { LuIndianRupee } from 'react-icons/lu';
import SearchableSelect from '../components/SearchableSelect';
import { STATES, DISTRICTS_BY_STATE, gstStateCode } from '../data/indiaLocations';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell,
  PieChart, Pie, Legend
} from 'recharts';

const STATUSES = ['booked', 'advance_received', 'planning', 'execution', 'completed'];
const CATEGORIES = ['Low Voltage', 'Fire Fighting', 'Fire NOC', 'Fire Alarm', 'CCTV', 'Access Control', 'PA System', 'Networking', 'Solar', 'Other'];
const ORDER_TYPES = ['Supply', 'SITC', 'AMC', 'Service'];
const LEAD_TYPES = ['Private', 'Government'];
const SOURCES = ['Inbound Enquiry', 'Indiamart Enquiry', 'WhatsApp', 'LinkedIn', 'Reference', 'Tender', 'Other'];

const emptyForm = {
  lead_type: 'Private', client_name: '', company_name: '', project_name: '',
  client_contact: '', client_email: '', email_address: '',
  source_of_enquiry: '', district: '', state: '', state_code: '', gstin: '', billing_address: '', shipping_address: '',
  guarantee_required: 'No', guarantee_percentage: '', sale_amount_without_gst: 0, po_amount: 0,
  management_discount_pct: 0, management_discount_amount: 0, net_sale_amount: 0,
  order_type: 'Supply', penalty_clause: 'No', penalty_clause_date: '',
  committed_start_date: '', committed_delivery_date: '', committed_completion_date: '', freight_extra: 'No',
  category: '', customer_type: '', client_type: '', customer_code: '',
  employee_assigned: '', employee_id: '', lead_by: '',
  management_person_name: '', management_person_contact: '',
  operations_person_name: '', operations_person_contact: '',
  pmc_person_name: '', pmc_person_contact: '',
  architect_person_name: '', architect_person_contact: '',
  accounts_person_name: '', accounts_person_contact: '',
  tpa_items_count: 0, tpa_items_qty: '', tpa_material_amount: 0, tpa_labour_amount: 0,
  accessory_amount: 0, required_labour_per_day: '', actual_margin_pct: 0,
  payment_advance: '', payment_against_delivery: '', payment_against_installation: '',
  payment_against_commissioning: '', payment_retention: '', payment_credit: '', credit_days: 0,
  advance_received: 0,
  po_number: '', po_date: '',
  final_drawing_link: '',
  remarks: '', status: 'booked'
};

// Fields that describe the CLIENT / PROJECT (not the specific order). Copied
// when adding ANOTHER lead for the same client so it isn't re-typed; every
// financial / PO / date / amount field starts fresh (mam 2026-06-25
// "new lead generation button + basic old data fetch").
const NEW_LEAD_BASIC = ['lead_type', 'client_name', 'company_name', 'project_name', 'client_contact', 'client_email', 'email_address', 'source_of_enquiry', 'district', 'state', 'state_code', 'gstin', 'billing_address', 'shipping_address', 'category', 'customer_type', 'client_type', 'customer_code', 'employee_assigned', 'employee_id', 'lead_by', 'management_person_name', 'management_person_contact', 'operations_person_name', 'operations_person_contact', 'pmc_person_name', 'pmc_person_contact', 'architect_person_name', 'architect_person_contact', 'accounts_person_name', 'accounts_person_contact', 'payment_advance', 'payment_against_delivery', 'payment_against_installation', 'payment_against_commissioning', 'payment_retention', 'payment_credit', 'credit_days', 'order_type'];

export default function BusinessBook() {
  const { canCreate, canEdit, canDelete, isAdmin } = useAuth();
  const [entries, setEntries] = useState([]);
  // Active employees for the "Employee Name" dropdown (mam 2026-06-25:
  // pick the assigned employee from a list instead of free text). Inactive
  // / dropped staff are filtered out so the picker stays clean.
  const [employees, setEmployees] = useState([]);
  const [stats, setStats] = useState(null);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [viewEntry, setViewEntry] = useState(null);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ status: '', category: '', order_type: '', lead_type: '' });
  const [showFilters, setShowFilters] = useState(false);
  const [viewMode, setViewMode] = useState('list'); // 'list' | 'dashboard'
  const [expanded, setExpanded] = useState({});      // dashboard: which client+site groups are open
  const [groupList, setGroupList] = useState(true);  // List view: merge leads by project name
  const [listExpanded, setListExpanded] = useState({}); // List view: which project groups are open

  const loadEntries = useCallback(() => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
    api.get(`/business-book?${params}`).then(r => setEntries(r.data)).catch(() => {});
  }, [search, filters]);

  const loadStats = () => {
    api.get('/business-book/stats/summary').then(r => setStats(r.data)).catch(() => {});
  };

  useEffect(() => { loadEntries(); loadStats(); }, [loadEntries]);

  // Load active employees once for the "Employee Name" picker.
  useEffect(() => {
    api.get('/hr/employees')
      .then(r => setEmployees((r.data || []).filter(e => !e.status || e.status === 'active')))
      .catch(() => setEmployees([]));
  }, []);

  // Strip CSV-import quote artifacts ('"""M/s X"""') and surrounding
  // whitespace from text fields before saving — also collapses internal
  // double-spaces. Runs on every text field so old quoted data gets
  // cleaned the next time someone edits + saves.
  const cleanText = (s) => (typeof s === 'string')
    ? s.replace(/^[\s"'`]+|[\s"'`]+$/g, '').replace(/\s+/g, ' ').trim()
    : s;
  const cleanFormText = (f) => {
    const out = { ...f };
    const textFields = ['client_name', 'company_name', 'project_name', 'lead_type',
      'district', 'state', 'state_code', 'gstin', 'po_number', 'category', 'order_type', 'employee_assigned',
      'client_contact', 'client_email', 'email_address', 'source_of_enquiry',
      'customer_type', 'client_type', 'customer_code'];
    for (const k of textFields) if (typeof out[k] === 'string') out[k] = cleanText(out[k]);
    return out;
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.client_name || !form.client_name.trim()) {
      toast.error('Client Name is required');
      return;
    }
    // Full mandatory-field check for NEW entries (mam 2026-06-25: "you don't
    // do mandatory"). Runs in JS so it applies to EVERYONE — including admin,
    // who otherwise bypasses native `required` app-wide (Layout.jsx
    // noValidate). Editing an existing (possibly legacy) entry is NOT blocked
    // on the full set, so old records stay editable.
    if (modal !== 'edit') {
      const REQUIRED = [
        ['company_name', 'Company/Department'],
        ['client_contact', 'Client Contact No.'],
        ['client_email', 'Client Email ID'],
        ['source_of_enquiry', 'Source of Enquiry'],
        ['customer_type', 'Customer Type'],
        ['client_type', 'Client Type'],
        ['state', 'State'],
        ['district', 'District'],
        ['state_code', 'State Code'],
        ['gstin', 'Client GSTIN'],
        ['billing_address', 'Billing Address'],
        ['shipping_address', 'Shipping / Site Address'],
        ['project_name', 'Project Name'],
        ['category', 'Category'],
        ['committed_start_date', 'Committed Start'],
        ['committed_delivery_date', 'Committed Delivery'],
        ['committed_completion_date', 'Committed Completion'],
        ['payment_advance', 'Advance %'],
        ['payment_against_delivery', 'Against Delivery %'],
        ['payment_against_installation', 'Against Installation %'],
        ['payment_against_commissioning', 'Against Commissioning %'],
        ['payment_retention', 'Retention %'],
        ['payment_credit', 'Handover %'],
        ['employee_assigned', 'Employee Name'],
        ['management_person_name', 'Management Person'],
        ['management_person_contact', 'Management Contact'],
        ['accounts_person_name', 'Accounts Person'],
        ['accounts_person_contact', 'Accounts Contact'],
        ['working_sheet_link', 'Working Sheet (upload)'],
        ['boq_file_link', 'BOQ File (upload)'],
      ];
      const missing = REQUIRED
        .filter(([k]) => { const v = form[k]; return v === undefined || v === null || String(v).trim() === ''; })
        .map(([, l]) => l);
      if (!(Number(form.sale_amount_without_gst) > 0)) missing.push('Sale Amount');
      if (!(Number(form.actual_margin_pct) > 0)) missing.push('Actual Margin %');
      if (missing.length) {
        toast.error(`Fill required: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` + ${missing.length - 5} more` : ''}`);
        return;
      }
    }
    const cleaned = cleanFormText(form);
    try {
      if (modal === 'edit' && form.id) {
        await api.put(`/business-book/${form.id}`, cleaned);
        toast.success('Entry updated');
      } else {
        const res = await api.post('/business-book', cleaned);
        toast.success(`Created ${res.data.lead_no} with auto-links`);
      }
      setModal(null); setForm({ ...emptyForm }); loadEntries(); loadStats();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to save'); }
  };

  const handleDelete = async (id, leadNo) => {
    if (!confirm(`Delete entry ${leadNo}?`)) return;
    try {
      await api.delete(`/business-book/${id}`);
      toast.success('Deleted'); loadEntries(); loadStats();
    } catch (e) {
      // Server refuses if the order has DPRs/attendance (deleting wipes them).
      // Ask once more, then force-delete.
      if (e.response?.status === 409 && e.response?.data?.needs_force) {
        const d = e.response.data;
        if (!confirm(`⚠ ${d.error}\n\nThis CANNOT be undone. Delete anyway?`)) return;
        try { await api.delete(`/business-book/${id}?force=1`); toast.success('Deleted'); loadEntries(); loadStats(); }
        catch { toast.error('Failed to delete'); }
      } else {
        toast.error(e.response?.data?.error || 'Failed to delete');
      }
    }
  };

  const handleView = (entry) => { setViewEntry(entry); setModal('view'); };
  const handleEdit = (entry) => { setForm({ ...emptyForm, ...entry }); setModal('edit'); };
  // Add another lead for an existing client — prefill the basic client/project
  // details from one of its leads; PO / amounts / dates stay blank to fill in.
  const newLeadFrom = (entry) => {
    const base = { ...emptyForm };
    if (entry) for (const k of NEW_LEAD_BASIC) { const v = entry[k]; if (v != null && v !== '') base[k] = v; }
    setForm(base); setModal('add');
  };

  const exportCSV = () => {
    if (entries.length === 0) return toast.error('No data');
    const headers = ['Lead No','Lead Type','Client','Company','Project','Category','Order Type','PO Number',
      'Sale Amount','Discount %','Discount Amount','Net Sale','PO Amount','Advance','Balance','Start','Delivery','Completion','District','State',
      'Customer Type','Employee','Status','Remarks'];
    const rows = entries.map(e => [e.lead_no, e.lead_type, e.client_name, e.company_name, e.project_name,
      e.category, e.order_type, e.po_number, e.sale_amount_without_gst,
      e.management_discount_pct, e.management_discount_amount, e.net_sale_amount,
      e.po_amount, e.advance_received,
      e.balance_amount, e.committed_start_date, e.committed_delivery_date, e.committed_completion_date,
      e.district, e.state, e.customer_type, e.employee_assigned, e.status, e.remarks]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${(c ?? '').toString().replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `business-book-${new Date().toISOString().split('T')[0]}.csv`;
    a.click(); toast.success('Exported');
  };

  const clearFilters = () => { setFilters({ status: '', category: '', order_type: '', lead_type: '' }); setSearch(''); };
  const activeFilters = Object.values(filters).filter(Boolean).length + (search ? 1 : 0);
  const fmt = (n) => `Rs ${(n || 0).toLocaleString('en-IN')}`;
  // Mam (2026-05-21): PO Amount (with GST) is always (NET Sale) × 1.18.
  // Mam (2026-06-16): a Management Discount comes off the Sale Amount first.
  // The % and Rs discount fields are kept in two-way sync, then Net Sale =
  // Sale − discount and PO recomputes off the net.  Server re-computes on
  // save as the final guard, so the field can never drift.
  const F = (key, val) => setForm(f => {
    const next = { ...f, [key]: val };
    if (['sale_amount_without_gst', 'management_discount_pct', 'management_discount_amount'].includes(key)) {
      const sale = Number(next.sale_amount_without_gst) || 0;
      let pct = Number(next.management_discount_pct) || 0;
      let amt = Number(next.management_discount_amount) || 0;
      if (key === 'management_discount_amount') {
        // Rs typed/overridden → clamp, then derive the matching % so the two
        // fields always agree (even if someone over-types the discount).
        amt = Math.max(0, Math.min(amt, sale));
        pct = sale > 0 ? Math.round((amt / sale) * 100 * 100) / 100 : 0;
      } else {
        // Sale or % changed → derive the Rs discount from the %, then clamp.
        amt = Math.max(0, Math.min(Math.round(sale * pct / 100 * 100) / 100, sale));
      }
      const net = Math.round((sale - amt) * 100) / 100;
      next.management_discount_pct = pct;
      next.management_discount_amount = amt;
      next.net_sale_amount = net;
      next.po_amount = Math.round(net * 1.18 * 100) / 100;
    }
    return next;
  });

  // Keep Net Sale + PO Amount (with GST) in sync with Sale/discount even on
  // EDIT load. The F handler only recomputes on a field change, so an order
  // opened with a stale stored po_amount/net would otherwise show the OLD
  // figure (mam 2026-06-27: Sale 1,21,91,818 but PO showed 6,98,654 — should be
  // 1,43,86,345 = Sale × 1.18). Net = Sale − discount, PO = Net × 1.18.
  useEffect(() => {
    const sale = Number(form.sale_amount_without_gst) || 0;
    const amt = Number(form.management_discount_amount) || 0;
    const net = Math.round((sale - amt) * 100) / 100;
    const po = Math.round(net * 1.18 * 100) / 100;
    if (form.net_sale_amount !== net || form.po_amount !== po) {
      setForm(f => ({ ...f, net_sale_amount: net, po_amount: po }));
    }
  }, [form.sale_amount_without_gst, form.management_discount_amount]);

  // Dashboard view (mam): MERGE all entries that share the SAME client name
  // AND the SAME site name into one consolidated row.  "Site name" is the
  // Project / Location shown in the list (project_name, falling back to
  // company_name) — the same value the table's Project column displays.
  // Matching is case-insensitive and whitespace-normalised so "M/s ABC "
  // and "m/s abc" collapse together.  Financials are summed across the
  // merged orders; each group expands to its individual leads.
  const norm = (s) => cleanText(s || '').toLowerCase();
  const siteOf = (e) => cleanText(e.project_name) || cleanText(e.company_name) || '';
  const groups = useMemo(() => {
    const map = new Map();
    for (const e of entries) {
      const site = siteOf(e);
      const key = norm(e.client_name) + '||' + norm(site);
      if (!map.has(key)) {
        map.set(key, {
          key, client_name: cleanText(e.client_name) || '(no client)', site_name: site,
          district: e.district, state: e.state,
          orders: [], sale: 0, po: 0, net: 0, advance: 0, balance: 0, discount: 0,
          statuses: new Set(), categories: new Set(),
        });
      }
      const g = map.get(key);
      g.orders.push(e);
      g.sale += e.sale_amount_without_gst || 0;
      g.po += e.po_amount || 0;
      g.net += e.net_sale_amount || 0;
      g.advance += e.advance_received || 0;
      g.balance += e.balance_amount || 0;
      g.discount += e.management_discount_amount || 0;
      if (!g.site_name && site) g.site_name = site;
      if (e.status) g.statuses.add(e.status);
      if (e.category) g.categories.add(e.category);
    }
    return Array.from(map.values()).sort((a, b) => b.sale - a.sale);
  }, [entries]);

  const mergedCount = groups.filter(g => g.orders.length > 1).length;
  const toggleGroup = (key) => setExpanded(p => ({ ...p, [key]: !p[key] }));

  // List view (mam): MERGE leads by PROJECT NAME. All leads sharing the same
  // project show as one collapsible row; clicking expands to every lead under
  // that project in the table. Project name falls back to Company when blank,
  // matching the "Project / Location" column. Leads with neither stay on their
  // own row (unique key) so unrelated blanks never merge together. Group order
  // follows the first lead seen — entries arrive newest-first, so newest
  // projects stay on top.
  const projectLabel = (e) => cleanText(e.project_name) || cleanText(e.company_name) || '(no project)';
  // GST rate is stored as text like "18%". GST sales amount = GST-inclusive
  // total = Sale × (1 + rate%) (mam 2026-06-23). Management discount is its
  // own stored amount.
  // GST sales amount = GST-inclusive total. The Sotyn.Headmasters already stores this as
  // po_amount (= Sale × 1.18, per the business_book rule); fall back to that
  // formula if po_amount isn't set. The % is derived for the sub-label.
  const gstInclOf = (e) => Number(e.po_amount) || ((Number(e.sale_amount_without_gst) || 0) * 1.18);
  const gstPctOf = (e) => { const s = Number(e.sale_amount_without_gst) || 0; if (s <= 0) return 18; return Math.round((gstInclOf(e) / s - 1) * 100); };
  const mgmtDiscOf = (e) => Number(e.management_discount_amount) || 0;
  const locationOf = (e) => [cleanText(e.district), cleanText(e.state)].filter(Boolean).join(', ');
  const listGroups = useMemo(() => {
    const map = new Map();
    for (const e of entries) {
      // Merge leads by PROJECT NAME only (mam 2026-06-24): every lead with the
      // same project (or company, when project is blank) collapses into one
      // group — regardless of client. Leads with no project at all stay on
      // their own row. The group lists its distinct clients in the Client cell.
      const pk = norm(cleanText(e.project_name) || cleanText(e.company_name));
      const key = pk ? pk : `__none__:${e.id}`;
      if (!map.has(key)) {
        map.set(key, { key, label: projectLabel(e), client: cleanText(e.client_name) || '—',
          leads: [], sale: 0, gstIncl: 0, mgmtDisc: 0,
          advance: 0, balance: 0, clients: new Set(), statuses: new Set() });
      }
      const g = map.get(key);
      g.leads.push(e);
      g.sale += e.sale_amount_without_gst || 0;
      g.gstIncl += gstInclOf(e);
      g.mgmtDisc += mgmtDiscOf(e);
      g.advance += e.advance_received || 0;
      g.balance += e.balance_amount || 0;
      if (e.client_name) g.clients.add(cleanText(e.client_name));
      if (e.status) g.statuses.add(e.status);
    }
    return Array.from(map.values());
  }, [entries]);
  const listMergedCount = listGroups.filter(g => g.leads.length > 1).length;
  const toggleListGroup = (key) => setListExpanded(p => ({ ...p, [key]: !p[key] }));
  // List the distinct client names of a merged group instead of "Multiple (N)"
  // (mam 2026-06-23). Cap at 2 names + "+N more" so the cell stays compact.
  const clientList = (clientsSet) => {
    const arr = [...clientsSet];
    if (arr.length === 0) return '-';
    if (arr.length <= 2) return arr.join(', ');
    return `${arr.slice(0, 2).join(', ')} +${arr.length - 2} more`;
  };

  // One Business Book lead as a table row — reused by the flat list, the
  // grouped-list children, so the columns never drift between modes.
  // Polish (mam 2026-06-24): coloured pills for Type + Category. Category
  // colour is a deterministic hash so each category keeps a stable distinct hue.
  const TYPE_PILL = { Government: 'bg-purple-100 text-purple-700', Private: 'bg-blue-100 text-blue-700', Public: 'bg-sky-100 text-sky-700', Corporate: 'bg-indigo-100 text-indigo-700' };
  const CAT_PILL = ['bg-blue-50 text-blue-700', 'bg-emerald-50 text-emerald-700', 'bg-purple-50 text-purple-700', 'bg-orange-50 text-orange-700', 'bg-pink-50 text-pink-700', 'bg-cyan-50 text-cyan-700', 'bg-rose-50 text-rose-700', 'bg-teal-50 text-teal-700'];
  const catColor = (c) => { let h = 0; const s = String(c || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return CAT_PILL[h % CAT_PILL.length]; };

  const renderLeadRow = (b, child = false) => (
    <tr key={b.id} className={`transition-colors ${child ? 'bg-gray-50/60 hover:bg-gray-100' : 'hover:bg-blue-50/40'}`}>
      {/* Lead No + Type */}
      <td className={`px-3 py-1.5 align-top ${child ? 'pl-8' : ''}`}>
        <span className="font-bold text-blue-700 text-[13px] cursor-pointer hover:underline" onClick={() => handleView(b)}>{b.lead_no}</span>
        <div className="mt-1"><span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${TYPE_PILL[b.lead_type] || 'bg-gray-100 text-gray-600'}`}>{b.lead_type}</span></div>
      </td>
      {/* Client */}
      <td className="px-3 py-1.5 align-top">
        <div className="font-medium text-[13px] leading-snug">{cleanText(b.client_name) || '-'}</div>
        {b.employee_assigned && <div className="text-[11px] text-gray-500 leading-snug">👤 {b.employee_assigned}</div>}
      </td>
      {/* Project / Location */}
      <td className="px-3 py-1.5 align-top">
        <div className="font-medium text-[13px] text-gray-800 leading-snug">{cleanText(b.project_name) || cleanText(b.company_name) || '-'}</div>
        {locationOf(b) && <div className="text-[11px] text-gray-500 leading-snug">📍 {locationOf(b)}</div>}
        {b.po_number && <div className="text-[10px] text-gray-400">PO: {b.po_number}</div>}
      </td>
      {/* Category */}
      <td className="px-3 py-1.5 align-top">
        {b.category ? <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium ${catColor(b.category)}`}>{b.category}</span> : <span className="text-gray-300 text-[12px]">-</span>}
        {b.order_type && <div className="text-[10px] text-gray-500 italic mt-1">{b.order_type}</div>}
      </td>
      {/* Sales amount */}
      <td className="px-3 py-2 text-right align-top whitespace-nowrap font-semibold text-[13px]">{fmt(b.sale_amount_without_gst)}</td>
      {/* GST sales amount (Sale + GST) */}
      <td className="px-3 py-2 text-right align-top whitespace-nowrap text-[13px] text-blue-700 font-medium">
        {fmt(gstInclOf(b))}<div className="text-[10px] text-gray-400 font-normal">incl {gstPctOf(b)}% GST</div>
      </td>
      {/* Management discount */}
      <td className="px-3 py-2 text-right align-top whitespace-nowrap text-[12px] text-amber-700">{mgmtDiscOf(b) > 0 ? fmt(mgmtDiscOf(b)) : <span className="text-gray-300">-</span>}</td>
      {/* Actions */}
      <td className="px-3 py-1.5 align-top">
        <div className="flex items-center justify-center gap-0.5">
          <button onClick={() => handleView(b)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors" title="View"><FiEye size={15} /></button>
          {b.boq_file_link && <a href={b.boq_file_link} target="_blank" rel="noreferrer" className="px-1.5 py-1 text-indigo-600 hover:bg-indigo-50 rounded-md text-[10px] font-bold transition-colors" title="View attached BOQ file">BOQ</a>}
          {canEdit('business_book') && <button onClick={() => handleEdit(b)} className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-md transition-colors" title="Edit"><FiEdit2 size={15} /></button>}
          {canDelete('business_book') && <button onClick={() => handleDelete(b.id, b.lead_no)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors" title="Delete"><FiTrash2 size={15} /></button>}
        </div>
      </td>
    </tr>
  );

  // Dashboard analytics — KPI roll-ups + chart series, all derived from the
  // currently-filtered entries so the dashboard moves with the filters.
  const PALETTE = ['#E5484D', '#0EA5E9', '#46A758', '#FFB224', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316', '#64748B', '#A32D2D'];
  const dash = useMemo(() => {
    const sum = (sel) => entries.reduce((s, e) => s + (Number(sel(e)) || 0), 0);
    const clients = new Set(groups.map(g => norm(g.client_name)));
    const sites = new Set(groups.map(g => g.key));
    const tally = (keyFn, valFn) => {
      const m = new Map();
      for (const e of entries) {
        const k = keyFn(e) || 'Uncategorised';
        const cur = m.get(k) || { name: k, value: 0, count: 0 };
        cur.value += Number(valFn(e)) || 0; cur.count += 1; m.set(k, cur);
      }
      return [...m.values()].sort((a, b) => b.value - a.value);
    };
    const byCategory = tally(e => e.category, e => e.sale_amount_without_gst);
    const byOrderType = tally(e => e.order_type, e => e.sale_amount_without_gst);
    const byStatus = (() => {
      const m = new Map();
      for (const e of entries) { const k = (e.status || 'booked').replace(/_/g, ' '); m.set(k, (m.get(k) || 0) + 1); }
      return [...m.entries()].map(([name, value]) => ({ name, value }));
    })();
    // Top clients merge by client name only (across all their sites).
    const cm = new Map();
    for (const g of groups) {
      const k = norm(g.client_name);
      const cur = cm.get(k) || { name: g.client_name, value: 0, orders: 0 };
      cur.value += g.sale; cur.orders += g.orders.length; cm.set(k, cur);
    }
    const topClients = [...cm.values()].sort((a, b) => b.value - a.value).slice(0, 8);
    return {
      sale: sum(e => e.sale_amount_without_gst), po: sum(e => e.po_amount),
      advance: sum(e => e.advance_received), balance: sum(e => e.balance_amount),
      clients: clients.size, sites: sites.size, orders: entries.length,
      byCategory, byOrderType, byStatus, topClients,
    };
  }, [entries, groups]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2"><FiBook className="text-red-600" /> Business Book</h1>
          <p className="text-sm text-gray-500 mt-1">Master New Business Booked Sheet</p>
        </div>
        <div className="flex gap-2 items-center">
          <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
            <button onClick={() => setViewMode('list')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${viewMode === 'list' ? 'bg-white text-red-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
              <FiList size={15} /> List
            </button>
            <button onClick={() => setViewMode('dashboard')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${viewMode === 'dashboard' ? 'bg-white text-red-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
              <FiGrid size={15} /> Dashboard
            </button>
          </div>
          <button onClick={exportCSV} className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload size={16} /> Export CSV</button>
          {canCreate('business_book') && (
            <button onClick={() => { setForm({ ...emptyForm }); setModal('add'); }} className="btn btn-primary flex items-center gap-2"><FiPlus size={16} /> New Entry</button>
          )}
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard icon={FiBook} color="blue" label="Total Entries" value={stats.total} subtext="↗ across all projects" subColor="text-blue-600" />
          <StatCard icon={LuIndianRupee} color="emerald" label="Total PO Value" value={fmt(stats.total_po)} subtext="High-value pipeline (incl GST)" subColor="text-emerald-600" />
          <StatCard icon={FiTrendingUp} color="amber" label="Advance Received" value={fmt(stats.total_advance)} valueColor="text-emerald-600" subtext="✓ verified payments" subColor="text-amber-600" />
          <StatCard icon={FiClock} color="red" label="Balance Pending" value={fmt(stats.total_balance)} valueColor="text-red-600" subtext="⚠ attention required" subColor="text-red-600" />
        </div>
      )}

      {/* Status Chips */}
      {stats && stats.byStatus.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {stats.byStatus.map(s => (
            <button key={s.status} onClick={() => setFilters(f => ({ ...f, status: f.status === s.status ? '' : s.status }))}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-all ${filters.status === s.status ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-600 border-gray-200 hover:border-red-300'}`}>
              {s.status.replace(/_/g, ' ')} ({s.count})
            </button>
          ))}
        </div>
      )}

      {/* Search & Filters */}
      <div className="card p-4 space-y-3">
        <div className="flex gap-3">
          <div className="relative flex-1">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
            <input className="input pl-10" placeholder="Search by client, company, project, lead no, PO number, customer code..."
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button onClick={() => setShowFilters(!showFilters)} className={`btn ${showFilters ? 'btn-primary' : 'btn-secondary'} flex items-center gap-2`}>
            <FiFilter size={16} /> Filters {activeFilters > 0 && <span className="bg-white/20 text-xs px-1.5 py-0.5 rounded-full">{activeFilters}</span>}
          </button>
          {activeFilters > 0 && <button onClick={clearFilters} className="btn btn-secondary text-red-500"><FiX size={14} /> Clear</button>}
        </div>
        {showFilters && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2 border-t">
            <div><label className="label">Status</label><select className="select" value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}><option value="">All</option>{STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></div>
            <div><label className="label">Category</label><select className="select" value={filters.category} onChange={e => setFilters(f => ({ ...f, category: e.target.value }))}><option value="">All</option>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></div>
            <div><label className="label">Order Type</label><select className="select" value={filters.order_type} onChange={e => setFilters(f => ({ ...f, order_type: e.target.value }))}><option value="">All</option>{ORDER_TYPES.map(t => <option key={t}>{t}</option>)}</select></div>
            <div><label className="label">Lead Type</label><select className="select" value={filters.lead_type} onChange={e => setFilters(f => ({ ...f, lead_type: e.target.value }))}><option value="">All</option>{LEAD_TYPES.map(t => <option key={t}>{t}</option>)}</select></div>
          </div>
        )}
      </div>

      {/* Count */}
      <div className="flex justify-between items-center text-sm text-gray-500">
        <div className="flex items-center gap-3">
          <span>
            {viewMode === 'dashboard'
              ? `${groups.length} client + site groups (${entries.length} entries${mergedCount > 0 ? `, ${mergedCount} merged` : ''})`
              : groupList
                ? `${listGroups.length} projects (${entries.length} leads${listMergedCount > 0 ? `, ${listMergedCount} merged` : ''})`
                : `Showing ${entries.length} entries`}
          </span>
          {viewMode === 'list' && (
            <button onClick={() => setGroupList(v => !v)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${groupList ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-white text-gray-500 border-gray-200 hover:border-amber-300'}`}
              title="Merge leads that share the same project name">
              <FiGrid size={12} /> {groupList ? 'Grouped by Project' : 'Group by Project'}
            </button>
          )}
        </div>
        {entries.length > 0 && (
          <span className="font-medium">
            {/* Sum the SAME field the SALE AMT column displays per row
                (sale_amount_without_gst), so the footer matches Cash Flow's
                project SALE column for the same filter. Mam: "only pick
                business book sales value". */}
            Sale Total: {fmt(entries.reduce((s, e) => s + (e.sale_amount_without_gst || 0), 0))}
            {' | Balance: '}{fmt(entries.reduce((s, e) => s + (e.balance_amount || 0), 0))}
          </span>
        )}
      </div>

      {/* Table (List view) */}
      {viewMode === 'list' && (
      <div className="card p-0">
        <div className="overflow-x-auto">
          <table className="min-w-full freeze-head">
            <thead><tr className="bg-gray-50/80 border-b border-gray-200">
              <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">Lead No</th>
              <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">Client</th>
              <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">Project / Location</th>
              <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">Category</th>
              <th className="px-3 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-gray-500">Sales Amt</th>
              <th className="px-3 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-gray-500">GST Sales</th>
              <th className="px-3 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-gray-500">Mgmt Disc</th>
              <th className="px-3 py-3 text-center text-[11px] font-semibold uppercase tracking-wider text-gray-500">Actions</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {/* Flat list, or merged-by-project when grouping is on. */}
              {!groupList && entries.map(b => renderLeadRow(b))}
              {groupList && listGroups.map(g => {
                // Every project — even a single-lead one — renders as the SAME
                // collapsible group row (mam 2026-06-24: "view is same of all").
                // The lead(s) appear on expand.
                const open = !!listExpanded[g.key];
                return (
                  <Fragment key={g.key}>
                    {/* Collapsed merged row — project name + project-wise totals
                        (Sales, GST sales, Mgmt discount). Client/Category/Actions
                        stay blank; the per-lead detail appears on expand. */}
                    <tr className="bg-blue-50/60 hover:bg-blue-100/60 cursor-pointer transition-colors border-l-4 border-blue-600" onClick={() => toggleListGroup(g.key)}>
                      <td className="px-3 py-1.5 align-top">
                        <div className="flex items-center gap-1.5 text-blue-700">
                          {open ? <FiChevronDown size={15} /> : <FiChevronRight size={15} />}
                          <span className="bg-blue-600 text-white text-[11px] font-bold px-2 py-0.5 rounded-full">{g.leads.length} lead{g.leads.length > 1 ? 's' : ''}</span>
                        </div>
                      </td>
                      <td className="px-3 py-1.5 align-top text-[13px] font-medium">{g.client}</td>
                      <td className="px-3 py-1.5 align-top">
                        <div className="font-semibold text-[13px] text-gray-900 flex items-start gap-1 leading-snug"><FiMapPin size={12} className="text-blue-600 mt-0.5 shrink-0" /> {g.label}</div>
                        <div className="text-[10px] text-blue-700/80 ml-4">{g.leads.length} lead{g.leads.length > 1 ? 's' : ''} · tap to {open ? 'collapse' : 'expand'}</div>
                      </td>
                      <td className="px-3 py-1.5" />
                      <td className="px-3 py-1.5 text-right align-top whitespace-nowrap font-bold text-[13px]">{fmt(g.sale)}<div className="text-[9px] text-gray-400 font-normal uppercase">total sales</div></td>
                      <td className="px-3 py-1.5 text-right align-top whitespace-nowrap font-bold text-[13px] text-blue-700">{fmt(g.gstIncl)}<div className="text-[9px] text-gray-400 font-normal uppercase">incl GST</div></td>
                      <td className="px-3 py-1.5 text-right align-top whitespace-nowrap font-bold text-[13px] text-amber-700">{g.mgmtDisc > 0 ? fmt(g.mgmtDisc) : '-'}<div className="text-[9px] text-gray-400 font-normal uppercase">mgmt disc</div></td>
                      <td className="px-3 py-1.5 text-center align-top" onClick={e => e.stopPropagation()}>
                        {canCreate('business_book') && (
                          <button onClick={() => newLeadFrom(g.leads[0])} title="Add another lead for this client — basic details prefilled, fill PO & amounts"
                            className="text-[11px] font-semibold text-blue-700 hover:text-blue-900 whitespace-nowrap inline-flex items-center gap-1"><FiPlus size={12} /> New Lead</button>
                        )}
                      </td>
                    </tr>
                    {/* Sub-header for the expanded per-lead rows */}
                    {open && (
                      <tr className="bg-gray-100/80 text-[10px] uppercase tracking-wide text-gray-500">
                        <td className="px-3 py-1 pl-8">Lead No</td>
                        <td className="px-3 py-1">Client</td>
                        <td className="px-3 py-1">Project / Location</td>
                        <td className="px-3 py-1">Category</td>
                        <td className="px-3 py-1 text-right">Sales Amt</td>
                        <td className="px-3 py-1 text-right">GST Sales</td>
                        <td className="px-3 py-1 text-right">Mgmt Disc</td>
                        <td className="px-3 py-1 text-center">Actions</td>
                      </tr>
                    )}
                    {open && g.leads.map(b => renderLeadRow(b, true))}
                  </Fragment>
                );
              })}
              {entries.length === 0 && <tr><td colSpan="8" className="text-center py-12 text-gray-400"><FiBook size={40} className="mx-auto mb-3 opacity-30" /><p className="font-medium">No entries found</p></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {/* Dashboard view — entries merged by client name + site name */}
      {viewMode === 'dashboard' && (
        <div className="space-y-5">

          {/* KPI roll-up (filtered) */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
            <KpiCard label="Sale Value" value={fmt(dash.sale)} color="text-gray-900" />
            <KpiCard label="PO Value" value={fmt(dash.po)} color="text-blue-700" />
            <KpiCard label="Advance" value={fmt(dash.advance)} color="text-emerald-600" />
            <KpiCard label="Balance" value={fmt(dash.balance)} color="text-red-600" />
            <KpiCard label="Clients" value={dash.clients} color="text-purple-700" />
            <KpiCard label="Sites" value={dash.sites} color="text-amber-600" />
            <KpiCard label="Orders" value={dash.orders} color="text-gray-900" />
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Sale value by category */}
            <div className="card p-4">
              <h4 className="font-semibold text-sm text-gray-700 mb-3">Sale Value by Category</h4>
              {dash.byCategory.length === 0 ? <Empty /> : (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={dash.byCategory} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                    <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} angle={-20} textAnchor="end" height={50} stroke="#94a3b8" axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10 }} stroke="#94a3b8" axisLine={false} tickLine={false} tickFormatter={(v) => v >= 100000 ? `${(v / 100000).toFixed(0)}L` : v} />
                    <Tooltip formatter={(v) => fmt(v)} />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                      {dash.byCategory.map((d, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
            {/* Order count by status */}
            <div className="card p-4">
              <h4 className="font-semibold text-sm text-gray-700 mb-3">Orders by Status</h4>
              {dash.byStatus.length === 0 ? <Empty /> : (
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie data={dash.byStatus} dataKey="value" nameKey="name" innerRadius={50} outerRadius={85} paddingAngle={2}>
                      {dash.byStatus.map((d, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v) => `${v} orders`} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
            {/* Sale value by order type */}
            <div className="card p-4">
              <h4 className="font-semibold text-sm text-gray-700 mb-3">Sale Value by Order Type</h4>
              {dash.byOrderType.length === 0 ? <Empty /> : (
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie data={dash.byOrderType} dataKey="value" nameKey="name" outerRadius={85} label={(e) => e.name}>
                      {dash.byOrderType.map((d, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v) => fmt(v)} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
            {/* Top clients by sale value */}
            <div className="card p-4">
              <h4 className="font-semibold text-sm text-gray-700 mb-3">Top Clients by Sale Value</h4>
              {dash.topClients.length === 0 ? <Empty /> : (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart layout="vertical" data={dash.topClients} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                    <XAxis type="number" tick={{ fontSize: 10 }} stroke="#94a3b8" axisLine={false} tickLine={false} tickFormatter={(v) => v >= 100000 ? `${(v / 100000).toFixed(0)}L` : v} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 9 }} width={110} stroke="#94a3b8" axisLine={false} tickLine={false} />
                    <Tooltip formatter={(v) => fmt(v)} />
                    <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                      {dash.topClients.map((d, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Merged client + site table */}
          <div className="card p-0">
          <div className="overflow-x-auto">
            <table className="min-w-full freeze-head">
              <thead><tr className="bg-gray-50">
                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600 w-8"></th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Client</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Site / Location</th>
                <th className="px-3 py-3 text-center text-xs font-semibold text-gray-600">Orders</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Status</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-gray-600">Sale Amt</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-gray-600">PO Amt</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-gray-600">Advance</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-gray-600">Balance</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {groups.map(g => {
                  const open = !!expanded[g.key];
                  const multi = g.orders.length > 1;
                  return (
                    <Fragment key={g.key}>
                      <tr className={`transition-colors cursor-pointer ${multi ? 'bg-amber-50/40 hover:bg-amber-50' : 'hover:bg-red-50/30'}`} onClick={() => toggleGroup(g.key)}>
                        <td className="px-3 py-3 text-gray-400">{multi ? (open ? <FiChevronDown size={16} /> : <FiChevronRight size={16} />) : null}</td>
                        <td className="px-3 py-3">
                          <div className="font-semibold text-sm text-gray-900 flex items-center gap-1.5"><FiUsers size={13} className="text-gray-400" /> {g.client_name}</div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="text-sm text-gray-800 flex items-center gap-1.5"><FiMapPin size={13} className="text-gray-400" /> {g.site_name || '-'}</div>
                          {g.district && <div className="text-xs text-gray-500 ml-5">{[g.district, g.state].filter(Boolean).join(', ')}</div>}
                        </td>
                        <td className="px-3 py-3 text-center">
                          <span className={`inline-flex items-center justify-center min-w-[24px] px-2 py-0.5 rounded-full text-xs font-bold ${multi ? 'bg-amber-200 text-amber-800' : 'bg-gray-100 text-gray-600'}`}>{g.orders.length}</span>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-1">{[...g.statuses].map(s => <StatusBadge key={s} status={s} />)}</div>
                        </td>
                        <td className="px-3 py-3 text-right font-semibold text-sm">{fmt(g.sale)}</td>
                        <td className="px-3 py-3 text-right text-sm">{fmt(g.po)}</td>
                        <td className="px-3 py-3 text-right text-sm text-emerald-600 font-medium">{fmt(g.advance)}</td>
                        <td className="px-3 py-3 text-right text-sm text-red-600 font-bold">{fmt(g.balance)}</td>
                      </tr>
                      {open && multi && g.orders.map(o => (
                        <tr key={o.id} className="bg-white hover:bg-gray-50 text-sm">
                          <td></td>
                          <td className="px-3 py-2 pl-6">
                            <span className="font-bold text-red-600 cursor-pointer hover:underline" onClick={() => handleView(o)}>{o.lead_no}</span>
                          </td>
                          <td className="px-3 py-2 text-gray-600">{o.category || '-'}{o.po_number ? ` · PO ${o.po_number}` : ''}</td>
                          <td className="px-3 py-2 text-center text-xs text-gray-500">{o.order_type}</td>
                          <td className="px-3 py-2"><StatusBadge status={o.status} /></td>
                          <td className="px-3 py-2 text-right">{fmt(o.sale_amount_without_gst)}</td>
                          <td className="px-3 py-2 text-right">{fmt(o.po_amount)}</td>
                          <td className="px-3 py-2 text-right text-emerald-600">{fmt(o.advance_received)}</td>
                          <td className="px-3 py-2 text-right text-red-600 font-medium">{fmt(o.balance_amount)}</td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
                {groups.length === 0 && <tr><td colSpan="9" className="text-center py-12 text-gray-400"><FiGrid size={40} className="mx-auto mb-3 opacity-30" /><p className="font-medium">No entries found</p></td></tr>}
              </tbody>
              {groups.length > 0 && (
                <tfoot>
                  <tr className="bg-gray-100 font-bold text-sm border-t-2 border-gray-300">
                    <td></td>
                    <td className="px-3 py-3" colSpan="2">Total ({groups.length} groups)</td>
                    <td className="px-3 py-3 text-center">{entries.length}</td>
                    <td></td>
                    <td className="px-3 py-3 text-right">{fmt(groups.reduce((s, g) => s + g.sale, 0))}</td>
                    <td className="px-3 py-3 text-right">{fmt(groups.reduce((s, g) => s + g.po, 0))}</td>
                    <td className="px-3 py-3 text-right text-emerald-700">{fmt(groups.reduce((s, g) => s + g.advance, 0))}</td>
                    <td className="px-3 py-3 text-right text-red-700">{fmt(groups.reduce((s, g) => s + g.balance, 0))}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          </div>
        </div>
      )}

      {/* View Modal */}
      <Modal isOpen={modal === 'view'} onClose={() => { setModal(null); setViewEntry(null); }} title={`${viewEntry?.lead_no || ''} - ${viewEntry?.client_name || ''}`} wide>
        {viewEntry && (
          <div className="space-y-4 max-h-[70vh] overflow-y-auto">
            <div className="flex items-center justify-between bg-gradient-to-r from-blue-50 to-blue-50 p-4 rounded-lg">
              <div>
                <h3 className="text-lg font-bold text-blue-900">{viewEntry.lead_no}</h3>
                <p className="text-sm text-red-600">{viewEntry.project_name || viewEntry.client_name}</p>
              </div>
              <div className="text-right">
                <StatusBadge status={viewEntry.status} />
                <span className={`ml-2 inline-flex px-2 py-0.5 rounded text-xs font-medium ${viewEntry.lead_type === 'Government' ? 'bg-purple-100 text-purple-700' : 'bg-red-100 text-red-700'}`}>{viewEntry.lead_type}</span>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-gray-50 p-3 rounded-lg text-center"><p className="text-xs text-gray-500">Sale Amount</p><p className="font-bold">{fmt(viewEntry.sale_amount_without_gst)}</p></div>
              <div className="bg-red-50 p-3 rounded-lg text-center"><p className="text-xs text-gray-500">PO Amount</p><p className="font-bold text-red-700">{fmt(viewEntry.po_amount)}</p></div>
              <div className="bg-emerald-50 p-3 rounded-lg text-center"><p className="text-xs text-gray-500">Advance</p><p className="font-bold text-emerald-600">{fmt(viewEntry.advance_received)}</p></div>
              <div className="bg-red-50 p-3 rounded-lg text-center"><p className="text-xs text-gray-500">Balance</p><p className="font-bold text-red-600">{fmt(viewEntry.balance_amount)}</p></div>
            </div>
            {/* Management discount row — only shown when a discount was given. */}
            {Number(viewEntry.management_discount_amount) > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="bg-amber-50 p-3 rounded-lg text-center"><p className="text-xs text-gray-500">Mgmt Discount %</p><p className="font-bold text-amber-700">{viewEntry.management_discount_pct || 0}%</p></div>
                <div className="bg-amber-50 p-3 rounded-lg text-center"><p className="text-xs text-gray-500">Mgmt Discount</p><p className="font-bold text-amber-700">- {fmt(viewEntry.management_discount_amount)}</p></div>
                <div className="bg-emerald-50 p-3 rounded-lg text-center"><p className="text-xs text-gray-500">Net Sale Amount</p><p className="font-bold text-emerald-700">{fmt(viewEntry.net_sale_amount)}</p></div>
              </div>
            )}
            <DSection title="Client & Company" items={[['Client', viewEntry.client_name], ['Company/Dept', viewEntry.company_name], ['Contact', viewEntry.client_contact], ['Client Email', viewEntry.client_email], ['Email', viewEntry.email_address], ['Source', viewEntry.source_of_enquiry], ['Customer Type', viewEntry.customer_type], ['Client Type', viewEntry.client_type], ['Customer Code', viewEntry.customer_code]]} />
            <DSection title="Location" items={[['District', viewEntry.district], ['State', viewEntry.state], ['State Code', viewEntry.state_code], ['GSTIN', viewEntry.gstin], ['Billing Address', viewEntry.billing_address], ['Shipping Address', viewEntry.shipping_address]]} />
            <DSection title="Project & Order" items={[['Project', viewEntry.project_name], ['Category', viewEntry.category], ['Order Type', viewEntry.order_type], ['PO Number', viewEntry.po_number], ['PO Date', viewEntry.po_date], ['Guarantee', viewEntry.guarantee_required], ['Guarantee %', viewEntry.guarantee_percentage], ['Penalty Clause', viewEntry.penalty_clause], ['Penalty Date', viewEntry.penalty_clause_date], ['Freight Extra', viewEntry.freight_extra]]} />
            <DSection title="Committed Dates" items={[['Start', viewEntry.committed_start_date], ['Delivery', viewEntry.committed_delivery_date], ['Completion', viewEntry.committed_completion_date]]} />
            <DSection title="People" items={[['Employee', viewEntry.employee_assigned], ['Lead By', viewEntry.lead_by], ['Management Person', viewEntry.management_person_name], ['Mgmt Contact', viewEntry.management_person_contact], ['Operations Person', viewEntry.operations_person_name], ['Ops Contact', viewEntry.operations_person_contact], ['PMC Person', viewEntry.pmc_person_name], ['PMC Contact', viewEntry.pmc_person_contact], ['Architect', viewEntry.architect_person_name], ['Architect Contact', viewEntry.architect_person_contact], ['Accounts Person', viewEntry.accounts_person_name], ['Accounts Contact', viewEntry.accounts_person_contact]]} />
            <DSection title="TPA Details" items={[['TPA Items Count', viewEntry.tpa_items_count], ['TPA Qty', viewEntry.tpa_items_qty], ['TPA Material', fmt(viewEntry.tpa_material_amount)], ['TPA Labour', fmt(viewEntry.tpa_labour_amount)], ['Accessory Amt', fmt(viewEntry.accessory_amount)], ['Labour/Day', viewEntry.required_labour_per_day], ['Actual Margin %', viewEntry.actual_margin_pct]]} />
            <DSection title="Payment Terms" items={[['Advance', viewEntry.payment_advance], ['Against Delivery', viewEntry.payment_against_delivery], ['Against Installation', viewEntry.payment_against_installation], ['Against Commissioning', viewEntry.payment_against_commissioning], ['Retention', viewEntry.payment_retention], ['Handover', viewEntry.payment_credit], ['Credit Days', viewEntry.credit_days]]} />
            {viewEntry.remarks && <div className="bg-yellow-50 p-3 rounded-lg"><p className="text-xs font-semibold text-yellow-700 mb-1">Remarks</p><p className="text-sm">{viewEntry.remarks}</p></div>}
            <div className="text-xs text-gray-400 text-right">Created: {viewEntry.created_at}</div>
          </div>
        )}
      </Modal>

      {/* Add/Edit Modal */}
      <Modal isOpen={modal === 'add' || modal === 'edit'} onClose={() => { setModal(null); setForm({ ...emptyForm }); }}
        title={modal === 'edit' ? `Edit - ${form.lead_no || ''}` : 'New Business Book Entry'} wide>
        <form onSubmit={handleSave} className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          {modal === 'add' && <p className="text-xs text-emerald-600 bg-emerald-50 p-2 rounded font-medium">Lead No. auto-generated. Auto-creates: Order Planning + DPR Site + Receivable + Cash Flow.</p>}

          {/* 1. Client */}
          <FSection title="Client & Company Details" color="gray">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <Sel label="Lead Type" value={form.lead_type} onChange={v => F('lead_type', v)} options={LEAD_TYPES} required />
              <Inp label="Client Name *" value={form.client_name} onChange={v => F('client_name', v)} required />
              <Inp label="Company/Department" value={form.company_name} onChange={v => F('company_name', v)} required />
              <Inp label="Client Contact No." value={form.client_contact} onChange={v => F('client_contact', v)} required />
              <Inp label="Client Email ID" value={form.client_email} onChange={v => F('client_email', v)} required />
              <Inp label="Email Address" value={form.email_address} onChange={v => F('email_address', v)} />
              <Sel label="Source of Enquiry" value={form.source_of_enquiry} onChange={v => F('source_of_enquiry', v)} options={SOURCES} blank="Select" required />
              <Inp label="Customer Type" value={form.customer_type} onChange={v => F('customer_type', v)} placeholder="Hospital, Factory..." required />
              <Sel label="Client Type" value={form.client_type} onChange={v => F('client_type', v)} options={['CRM', 'NBD']} blank="Select" required />
              <Inp label="Customer Code" value={form.customer_code} onChange={v => F('customer_code', v)} />
            </div>
          </FSection>

          {/* 2. Location */}
          <FSection title="Location & Address" color="gray">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <div>
                <label className="label">State</label>
                <SearchableSelect
                  options={STATES.map(s => ({ value: s, label: s }))}
                  value={form.state} valueKey="value" displayKey="label"
                  placeholder="Pick state"
                  onChange={(opt) => { const st = opt?.value || ''; F('state', st); F('district', ''); F('state_code', gstStateCode(st)); }}
                />
              </div>
              <div>
                <label className="label">District</label>
                <SearchableSelect
                  options={(form.state ? (DISTRICTS_BY_STATE[form.state] || []) : []).map(d => ({ value: d, label: d }))}
                  value={form.district} valueKey="value" displayKey="label"
                  placeholder={form.state ? 'Pick district' : 'Pick a state first'}
                  onChange={(opt) => F('district', opt?.value || '')}
                />
              </div>
              <Inp label="State Code" value={form.state_code} onChange={v => F('state_code', v)} placeholder="auto from State (e.g. 03)" required />
              {/* GSTIN feeds into the auto-generated Sales Bill / Tax
                  Invoice. Punjab GSTINs start with 03; verify the format
                  is 15 chars (2 digit state + 10 char PAN + entity code +
                  Z + checksum). */}
              <Inp label="Client GSTIN" value={form.gstin} onChange={v => F('gstin', v)} placeholder="e.g. 03AABCS1234A1Z5" required />
              <Inp label="Billing Address" value={form.billing_address} onChange={v => F('billing_address', v)} required />
              <div className="col-span-2"><Inp label="Shipping / Site Address" value={form.shipping_address} onChange={v => F('shipping_address', v)} required /></div>
            </div>
          </FSection>

          {/* 3. Project & Order + PO */}
          <FSection title="Project, Order & PO Details" color="blue">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <Inp label="Project Name" value={form.project_name} onChange={v => F('project_name', v)} required />
              <Sel label="Order Type" value={form.order_type} onChange={v => F('order_type', v)} options={ORDER_TYPES} required />
              <Sel label="Category" value={form.category} onChange={v => F('category', v)} options={CATEGORIES} blank="Select" required />
              <Sel label="Guarantee Required" value={form.guarantee_required} onChange={v => F('guarantee_required', v)} options={['No', 'Yes']} />
              {form.guarantee_required === 'Yes' && <Inp label="Guarantee %" value={form.guarantee_percentage} onChange={v => F('guarantee_percentage', v)} />}
              <Sel label="Penalty Clause" value={form.penalty_clause} onChange={v => F('penalty_clause', v)} options={['No', 'Yes']} />
              {form.penalty_clause === 'Yes' && <Inp label="Penalty Date" value={form.penalty_clause_date} onChange={v => F('penalty_clause_date', v)} type="date" />}
              <Sel label="Freight Extra" value={form.freight_extra} onChange={v => F('freight_extra', v)} options={['No', 'Yes']} />
              <Inp label="PO Number" value={form.po_number} onChange={v => F('po_number', v)} />
              <Inp label="PO Date" value={form.po_date} onChange={v => F('po_date', v)} type="date" />
            </div>
          </FSection>

          {/* 4. Financial */}
          <FSection title="Financial Details" color="emerald">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <Inp label="Sale Amount (Without GST)" value={form.sale_amount_without_gst} onChange={v => F('sale_amount_without_gst', +v)} type="number" required />
              {/* PO Amount auto-computes as Sale × 1.18 — display only.
                  Mam (2026-05-21): "all business book = sales without
                  gst + (sales without gst *18%)". */}
              <div>
                <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
                  PO Amount (With GST)
                  <span className="ml-1 normal-case font-normal text-emerald-700">· auto = Sale × 1.18</span>
                </label>
                <input
                  type="number"
                  value={form.po_amount || 0}
                  readOnly
                  className="w-full px-3 py-2 border border-emerald-200 bg-emerald-50 rounded-lg text-sm font-semibold text-emerald-900 cursor-not-allowed"
                  title="Auto-computed from (Net Sale Amount) × 1.18"
                />
              </div>
              {/* Management discount (mam 2026-06-16): % and Rs are two-way
                  synced; either one reduces the Sale Amount.  Net Sale (and
                  therefore PO with GST) recompute automatically. */}
              <Inp label="Management Discount %" value={form.management_discount_pct} onChange={v => F('management_discount_pct', +v)} type="number" />
              <Inp label="Management Discount (Rs)" value={form.management_discount_amount} onChange={v => F('management_discount_amount', +v)} type="number" />
              <div>
                <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
                  Net Sale Amount
                  <span className="ml-1 normal-case font-normal text-emerald-700">· Sale − Discount</span>
                </label>
                <input
                  type="number"
                  value={form.net_sale_amount || 0}
                  readOnly
                  className="w-full px-3 py-2 border border-emerald-200 bg-emerald-50 rounded-lg text-sm font-semibold text-emerald-900 cursor-not-allowed"
                  title="Sale Amount minus Management Discount — PO is computed from this"
                />
              </div>
              <Inp label="Advance Received" value={form.advance_received} onChange={v => F('advance_received', +v)} type="number" />
              <Inp label="Accessory Amount" value={form.accessory_amount} onChange={v => F('accessory_amount', +v)} type="number" />
              <Inp label="Actual Margin %" value={form.actual_margin_pct} onChange={v => F('actual_margin_pct', +v)} type="number" required />
            </div>
          </FSection>

          {/* 5. Payment Terms */}
          <FSection title="Payment Terms" color="indigo">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <Inp label="Advance" value={form.payment_advance} onChange={v => F('payment_advance', v)} placeholder="%" required />
              <Inp label="Against Delivery" value={form.payment_against_delivery} onChange={v => F('payment_against_delivery', v)} placeholder="%" required />
              <Inp label="Against Installation" value={form.payment_against_installation} onChange={v => F('payment_against_installation', v)} placeholder="%" required />
              <Inp label="Against Commissioning" value={form.payment_against_commissioning} onChange={v => F('payment_against_commissioning', v)} placeholder="%" required />
              <Inp label="Retention" value={form.payment_retention} onChange={v => F('payment_retention', v)} placeholder="%" required />
              <Inp label="Handover" value={form.payment_credit} onChange={v => F('payment_credit', v)} placeholder="%" required />
              <Inp label="Credit Days" value={form.credit_days} onChange={v => F('credit_days', +v)} type="number" required />
            </div>
          </FSection>

          {/* 6. Dates */}
          <FSection title="Committed Dates" color="amber">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <Inp label="Committed Start" value={form.committed_start_date} onChange={v => F('committed_start_date', v)} type="date" required />
              <Inp label="Committed Delivery" value={form.committed_delivery_date} onChange={v => F('committed_delivery_date', v)} type="date" required />
              <Inp label="Committed Completion" value={form.committed_completion_date} onChange={v => F('committed_completion_date', v)} type="date" required />
            </div>
          </FSection>

          {/* 7. People */}
          <FSection title="People & Contacts" color="purple">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <div>
                <label className="label">Employee Name</label>
                <select className="select" value={form.employee_assigned || ''}
                  onChange={e => F('employee_assigned', e.target.value)} required>
                  <option value="">Select employee</option>
                  {employees.map(emp => (
                    <option key={emp.id} value={emp.name}>{emp.name}{emp.designation ? ` — ${emp.designation}` : ''}</option>
                  ))}
                </select>
              </div>
              <Inp label="Lead By" value={form.lead_by} onChange={v => F('lead_by', v)} />
              <div></div>
              <Inp label="Management Person" value={form.management_person_name} onChange={v => F('management_person_name', v)} required />
              <Inp label="Management Contact" value={form.management_person_contact} onChange={v => F('management_person_contact', v)} required />
              <div></div>
              <Inp label="Operations Person" value={form.operations_person_name} onChange={v => F('operations_person_name', v)} />
              <Inp label="Operations Contact" value={form.operations_person_contact} onChange={v => F('operations_person_contact', v)} />
              <div></div>
              <Inp label="PMC Person" value={form.pmc_person_name} onChange={v => F('pmc_person_name', v)} />
              <Inp label="PMC Contact" value={form.pmc_person_contact} onChange={v => F('pmc_person_contact', v)} />
              <div></div>
              <Inp label="Architect Person" value={form.architect_person_name} onChange={v => F('architect_person_name', v)} />
              <Inp label="Architect Contact" value={form.architect_person_contact} onChange={v => F('architect_person_contact', v)} />
              <div></div>
              <Inp label="Accounts Person" value={form.accounts_person_name} onChange={v => F('accounts_person_name', v)} required />
              <Inp label="Accounts Contact" value={form.accounts_person_contact} onChange={v => F('accounts_person_contact', v)} required />
            </div>
          </FSection>

          {/* 8. TPA */}
          <FSection title="TPA Details" color="rose">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <Inp label="TPA Items Count" value={form.tpa_items_count} onChange={v => F('tpa_items_count', +v)} type="number" />
              <Inp label="Total Qty (TPA Items)" value={form.tpa_items_qty} onChange={v => F('tpa_items_qty', v)} />
              <Inp label="TPA Material Amount" value={form.tpa_material_amount} onChange={v => F('tpa_material_amount', +v)} type="number" />
              <Inp label="TPA Labour Amount" value={form.tpa_labour_amount} onChange={v => F('tpa_labour_amount', +v)} type="number" />
              <Inp label="Required Labour Per Day" value={form.required_labour_per_day} onChange={v => F('required_labour_per_day', v)} />
            </div>
          </FSection>

          {/* 9. Final Drawing Upload */}
          <FSection title="Final Drawing" color="gray">
            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="label flex items-center gap-2"><FiUpload size={14} /> Upload Final Drawing</label>
                {form.final_drawing_link ? (
                  <div className="flex items-center gap-2">
                    <a href={form.final_drawing_link} target="_blank" rel="noreferrer" className="text-sm text-red-600 underline truncate flex-1">
                      {form.final_drawing_link.split('/').pop()}
                    </a>
                    <button type="button" onClick={() => F('final_drawing_link', '')} className="text-red-500 text-xs hover:underline">Remove</button>
                  </div>
                ) : (
                  <input type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.dwg,.jpg,.jpeg,.png"
                    onChange={async (e) => {
                      const file = e.target.files[0]; if (!file) return;
                      try {
                        const fd = new FormData(); fd.append('file', file);
                        const res = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
                        F('final_drawing_link', res.data.url);
                        toast.success(`Uploaded: ${res.data.filename}`);
                      } catch { toast.error('Upload failed'); }
                      e.target.value = '';
                    }}
                    className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100" />
                )}
              </div>
            </div>
          </FSection>

          {/* 10. Working Sheet Upload — mam: 'upload here file option call
              working sheet'. Per-entry costing/calculation document (Excel /
              PDF) attached to each booked order. */}
          <FSection title="Working Sheet" color="blue">
            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="label flex items-center gap-2"><FiUpload size={14} /> Upload Working Sheet</label>
                {form.working_sheet_link ? (
                  <div className="flex items-center gap-2">
                    <a href={form.working_sheet_link} target="_blank" rel="noreferrer" className="text-sm text-blue-600 underline truncate flex-1">
                      📎 {form.working_sheet_link.split('/').pop()}
                    </a>
                    <button type="button" onClick={() => F('working_sheet_link', '')} className="text-red-500 text-xs hover:underline">Remove</button>
                  </div>
                ) : (
                  <input type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.jpg,.jpeg,.png" required
                    onChange={async (e) => {
                      const file = e.target.files[0]; if (!file) return;
                      try {
                        const fd = new FormData(); fd.append('file', file);
                        const res = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
                        F('working_sheet_link', res.data.url);
                        toast.success(`Uploaded: ${res.data.filename}`);
                      } catch { toast.error('Upload failed'); }
                      e.target.value = '';
                    }}
                    className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100" />
                )}
                <p className="text-[10px] text-gray-500 mt-1">Costing / calculation sheet for this order (Excel, PDF, CSV, image).</p>
              </div>
            </div>
          </FSection>

          {/* 11. BOQ File Upload (mam 2026-06-23) — attach the BOQ; the "BOQ"
              button in the list opens it. */}
          <FSection title="BOQ File" color="gray">
            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="label flex items-center gap-2"><FiUpload size={14} /> Upload BOQ File</label>
                {form.boq_file_link ? (
                  <div className="flex items-center gap-2">
                    <a href={form.boq_file_link} target="_blank" rel="noreferrer" className="text-sm text-indigo-600 underline truncate flex-1">📋 {form.boq_file_link.split('/').pop()}</a>
                    <button type="button" onClick={() => F('boq_file_link', '')} className="text-red-500 text-xs hover:underline">Remove</button>
                  </div>
                ) : (
                  <input type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.jpg,.jpeg,.png" required
                    onChange={async (e) => {
                      const file = e.target.files[0]; if (!file) return;
                      try {
                        const fd = new FormData(); fd.append('file', file);
                        const res = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
                        F('boq_file_link', res.data.url);
                        toast.success(`Uploaded: ${res.data.filename}`);
                      } catch { toast.error('Upload failed'); }
                      e.target.value = '';
                    }}
                    className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100" />
                )}
                <p className="text-[10px] text-gray-500 mt-1">Bill of Quantities (Excel / PDF). Shows as a "BOQ" button on the lead row.</p>
              </div>
            </div>
          </FSection>

          {/* Status (edit only) */}
          {modal === 'edit' && <Sel label="Status" value={form.status} onChange={v => F('status', v)} options={STATUSES} />}

          <div><label className="label">Remarks</label><textarea className="input" rows="2" value={form.remarks || ''} onChange={e => F('remarks', e.target.value)} /></div>

          <div className="flex justify-end gap-3 pt-2 border-t">
            <button type="button" onClick={() => { setModal(null); setForm({ ...emptyForm }); }} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{modal === 'edit' ? 'Update Entry' : 'Create Business Entry'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

// Reusable components
function StatCard({ icon: Icon, color, label, value, valueColor, subtext, subColor }) {
  return (
    <div className={`card p-4 border-t-2 border-${color}-500`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] text-gray-500 font-semibold uppercase tracking-wider">{label}</p>
          <p className={`text-2xl font-bold mt-1 ${valueColor || 'text-gray-900'}`}>{value}</p>
        </div>
        <div className={`p-2 bg-${color}-50 rounded-lg shrink-0`}><Icon className={`text-${color}-600`} size={18} /></div>
      </div>
      {subtext && <p className={`text-[11px] mt-2 font-medium ${subColor || 'text-gray-400'}`}>{subtext}</p>}
    </div>
  );
}

function KpiCard({ label, value, color }) {
  return (
    <div className="card p-3">
      <p className="text-[10px] text-gray-500 font-semibold uppercase tracking-wide">{label}</p>
      <p className={`text-lg font-bold mt-0.5 ${color || 'text-gray-900'}`}>{value}</p>
    </div>
  );
}

function Empty() {
  return <div className="h-[240px] flex items-center justify-center text-sm text-gray-400">No data</div>;
}

function FSection({ title, color, children }) {
  const bg = { gray: 'bg-gray-50', blue: 'bg-red-50', emerald: 'bg-emerald-50', amber: 'bg-amber-50', purple: 'bg-purple-50', indigo: 'bg-red-50', rose: 'bg-rose-50' };
  const text = { gray: 'text-gray-700', blue: 'text-red-700', emerald: 'text-emerald-700', amber: 'text-amber-700', purple: 'text-purple-700', indigo: 'text-red-700', rose: 'text-rose-700' };
  return (<div className={`border rounded-lg p-3 ${bg[color] || 'bg-gray-50'}`}><h4 className={`font-semibold text-sm ${text[color] || 'text-gray-700'} mb-3`}>{title}</h4>{children}</div>);
}

function DSection({ title, items }) {
  const filtered = items.filter(([, v]) => v && v !== '-' && v !== 0 && v !== 'Rs 0');
  if (filtered.length === 0) return null;
  return (<div className="border rounded-lg p-3"><h4 className="font-semibold text-sm text-gray-700 mb-2">{title}</h4><div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">{filtered.map(([l, v]) => <div key={l}><p className="text-xs text-gray-400">{l}</p><p className="text-sm font-medium">{v}</p></div>)}</div></div>);
}

function Inp({ label, value, onChange, type = 'text', required, placeholder }) {
  return (<div><label className="label">{label}</label><input className="input" type={type} value={value || ''} onChange={e => onChange(e.target.value)} required={required} placeholder={placeholder} /></div>);
}

function Sel({ label, value, onChange, options, blank, required }) {
  return (<div><label className="label">{label}</label><select className="select" value={value || ''} onChange={e => onChange(e.target.value)} required={required}>{blank && <option value="">{blank}</option>}{options.map(o => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}</select></div>);
}
