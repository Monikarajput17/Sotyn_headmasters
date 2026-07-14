import { useState, useEffect, useMemo, useRef, Fragment } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import { STATES, gstStateCode, SEPL_HOME_STATE } from '../data/indiaLocations';
import StatusBadge from '../components/StatusBadge';
import ResponsibilityTab from '../components/ResponsibilityTab';
import NumInput from '../components/NumInput';
import Pagination, { usePagination } from '../components/Pagination';
import InfoTooltip from '../components/InfoTooltip';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiCheck, FiX, FiTrash2, FiEdit2, FiExternalLink, FiChevronDown, FiChevronRight, FiPrinter, FiMessageCircle, FiDownload, FiMapPin, FiCalendar, FiUser, FiInfo, FiRefreshCw } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { fmtDateTime as fmtIST } from '../utils/datetime';

const EMPTY_ITEM = { po_item_id: '', item_master_id: '', description: '', make: '', quantity: 1, unit: 'nos', item_type: '', boq_qty: 0, remaining_qty: null, manual: false, required_date: '' };

// Canonical division for a category / department string. Normalises the messy
// real-world codes (SOLAR vs SOL, PLU vs PLUMB, CIVIL vs CIV, …) into ONE key so
// the Sub-Item picker can scope Item Master to the project's / BOQ's division.
// Returns '' for anything it can't confidently classify, so an unknown category
// (e.g. "Water Tank") leaves the picker UNFILTERED rather than hiding everything.
// mam 2026-06-27: a Fire-Fighting item (FF3387) was pickable under a Solar BOQ.
const DIVISION_OF = (raw) => {
  const c = String(raw || '').trim().toUpperCase();
  if (!c) return '';
  if (/SOLAR|^SOL$/.test(c)) return 'SOLAR';
  if (/FIRE|^FF$/.test(c)) return 'FF';
  if (/ELECTRIC|^ELE$/.test(c)) return 'ELE';
  if (/^LV$|LOW.?VOLTAGE|^ELV$/.test(c)) return 'LV';
  if (/PLUMB|^PLU$|^PLB$|^PHE$/.test(c)) return 'PLB';
  if (/HVAC|AIR.?COND|^AC$/.test(c)) return 'HVAC';
  if (/CIVIL|^CIV$/.test(c)) return 'CIVIL';
  if (/CCTV/.test(c)) return 'CCTV';
  if (/NETWORK|^NET$/.test(c)) return 'NET';
  return '';
};

// True when the Client PO's assigned CRM name (a first name like "Sushila"
// from the Orders dropdown) matches the logged-in user — equal, or one name
// appears as a whitespace token in the other (so "Sushila Sharma" matches
// "Sushila").  Used to let the assigned CRM approve Extra indents even
// without crm_funnel role access.  Mirrors the server gate in procurement.js.
const crmNameMatchesUser = (crmName, userName) => {
  const a = String(crmName || '').trim().toLowerCase();
  const b = String(userName || '').trim().toLowerCase();
  if (!a || !b) return false;
  return a === b || a.split(/\s+/).includes(b) || b.split(/\s+/).includes(a);
};

// Client-side unit display normaliser (mam, 2026-05-16: "not change
// according to itemwise" — stale "Each" / "Metre" / "Mtrs" values
// leaked through when there's no master link).  Aligns with the
// server-side cleanup map so the UI never shows non-standard UoMs
// even if the row hasn't been backfilled yet.
const UNIT_DISPLAY_MAP = {
  each: 'nos', pieces: 'nos', piece: 'nos', nos: 'nos',
  metre: 'mtr', metres: 'mtr', meter: 'mtr', meters: 'mtr', mtrs: 'mtr', mt: 'mtr', m: 'mtr',
  litre: 'ltr', litres: 'ltr', liter: 'ltr', liters: 'ltr', ltr: 'ltr', l: 'ltr',
  kgs: 'kg', kilogram: 'kg', kilograms: 'kg',
  sets: 'set',
  packets: 'packet', pkt: 'packet', pack: 'packet',
  feet: 'ft',
  watts: 'watt', w: 'watt',
};
const cleanUnit = (u) => {
  if (!u) return '';
  const v = String(u).trim().toLowerCase();
  return UNIT_DISPLAY_MAP[v] || v;
};

// Standard units used across MEP / civil indents. Mam asked for a
// dropdown because the Item Master's stored UoM is often wrong and
// the user has to override it manually almost every time.
const UNIT_OPTIONS = [
  'nos','pcs','set','pair','pkt','box','bdl','roll','coil','bag',
  'kg','gms','ton','qtl',
  'mtr','rmt','ft','inch','cm','mm',
  'sqft','sqmtr','sqm','cum','cft',
  'ltr','ml',
];

// One stacked row in the APPROVAL cell for 2-level indents. Reused for
// both L1 and L2. States:
//   pending (+waiting=true)  → grey dot, italic "Waiting" (L1 not done yet)
//   pending                  → amber dot, italic "Pending"
//   approved                 → green tick + name + short date
//   rejected                 → red cross + name + truncated reason
function ApprovalLevelRow({ label, status, name, at, waiting, isReject, reason }) {
  const fmt = (d) => {
    if (!d) return '';
    const dt = new Date(d.includes('T') ? d : d.replace(' ', 'T') + 'Z');
    if (isNaN(dt.getTime())) return '';
    return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ' ' +
           dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  };
  if (status === 'approved') {
    return (
      <div className="flex items-baseline gap-1 text-[11px]">
        <span className="text-emerald-600 font-mono w-3">✓</span>
        <span className="font-semibold text-gray-600 w-5">{label}</span>
        <span className="text-emerald-700 font-medium truncate">{name || '—'}</span>
        <span className="text-[10px] text-gray-500 ml-auto">{fmt(at)}</span>
      </div>
    );
  }
  if (status === 'rejected' || isReject) {
    return (
      <div className="flex items-baseline gap-1 text-[11px]" title={reason || ''}>
        <span className="text-red-600 font-mono w-3">✗</span>
        <span className="font-semibold text-gray-600 w-5">{label}</span>
        <span className="text-red-700 font-medium truncate">{name || '—'}</span>
        {reason && <span className="text-[10px] text-red-500 italic ml-auto truncate max-w-[100px]">“{reason.slice(0, 18)}{reason.length > 18 ? '…' : ''}”</span>}
      </div>
    );
  }
  // pending
  return (
    <div className="flex items-baseline gap-1 text-[11px]">
      <span className={`font-mono w-3 ${waiting ? 'text-gray-300' : 'text-amber-500'}`}>●</span>
      <span className="font-semibold text-gray-500 w-5">{label}</span>
      <span className="text-gray-500 italic truncate">{name || (waiting ? 'Waiting' : 'Pending')}</span>
    </div>
  );
}

// Tiny chip rendered under the PO Number on the Vendor PO list so the
// purchase team can see at a glance whether material is unblocked or
// stuck on payment (mam 2026-05-27). Never rendered on the PO print —
// this is internal-only. Returns null for legacy POs with no entry
// (helps distinguish "no entry" from explicit "no advance").
function PaymentBlockChip({ v }) {
  if (!v || !v.payment_block_type) return null;
  const fmt = (n) => '₹' + Math.round(+n || 0).toLocaleString('en-IN');
  const cleared = v.payment_block_status === 'cleared';
  const t = v.payment_block_type;
  let cls = 'bg-gray-100 text-gray-600 border-gray-300';
  let label = 'No advance';
  if (cleared) {
    cls = 'bg-emerald-50 text-emerald-700 border-emerald-300';
    const when = v.payment_cleared_at ? fmtIST(v.payment_cleared_at, { day: '2-digit', month: 'short' }) : '';
    label = `✓ Cleared${when ? ' ' + when : ''}`;
  } else if (t === 'advance') {
    cls = 'bg-amber-50 text-amber-800 border-amber-300';
    label = `${fmt(v.payment_block_amount)} Adv pending`;
  } else if (t === 'old_payment_clear') {
    cls = 'bg-orange-50 text-orange-800 border-orange-300';
    label = `${fmt(v.payment_block_amount)} Old due`;
  }
  const tooltipParts = [
    label,
    v.payment_block_notes,
    cleared && v.payment_cleared_by_name ? `Cleared by ${v.payment_cleared_by_name}` : null,
  ].filter(Boolean);
  return (
    <div className="mt-0.5">
      <span className={`inline-block text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${cls}`} title={tooltipParts.join(' · ')}>
        {label}
      </span>
    </div>
  );
}

/**
 * MobileItemRow — used inside the Indent-to-Dispatch mobile card.
 * Mam (2026-06-02): "click on item show boq item sub item also and if
 * item big then info button give".  Each item row collapses to one
 * compact line (BOQ description + qty).  When mam taps it (or the ⓘ
 * for long descriptions) we reveal the full BOQ description plus the
 * underlying item_master sub-item — code, name, size, spec, make,
 * type, rate.  Matches the desktop expanded sub-item table at line
 * ~2095 so the data shown on phone is the same data shown on desktop.
 */
function MobileItemRow({ item, idx }) {
  const [open, setOpen] = useState(false);
  const desc = item.description || item.item_name || '—';
  const isLong = (desc || '').length > 55;
  const qty = Number(item.quantity || item.qty || 0);
  const hasMaster = !!(item.item_code || item.master_name || item.master_specification || item.master_size);
  const subLine = [item.master_size, item.master_specification].filter(Boolean).join(' / ');
  // Mam (2026-06-02): source badge.  'store' = issued from existing
  // office inventory (no vendor PO needed); 'procure' = goes through
  // normal vendor flow.  Stamped at L1/L2 approval time.
  const isStore = item.source === 'store';
  return (
    <div className="pb-1 border-b border-gray-50 last:border-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex justify-between items-start gap-2 text-left active:bg-gray-50 rounded -mx-1 px-1 py-0.5"
      >
        <div className="flex-1 min-w-0 flex items-start gap-1">
          {isLong && <FiInfo className="mt-[2px] flex-shrink-0 text-blue-500" size={11} />}
          <span className={`flex-1 min-w-0 ${open ? 'text-gray-800 font-medium' : 'text-gray-600 truncate'}`}>
            {desc}
          </span>
        </div>
        <div className="text-right whitespace-nowrap flex items-center gap-1">
          {isStore && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-300" title={`Issued from office store · ${item.stock_issue_number || ''}`}>
              STORE
            </span>
          )}
          <span className="text-gray-800 font-medium">{qty} {item.unit || ''}</span>
        </div>
      </button>
      {open && (
        <div className={`mt-1 ml-2 pl-2 border-l-2 space-y-0.5 text-[10.5px] text-gray-600 ${isStore ? 'border-emerald-300' : 'border-blue-200'}`}>
          {/* Source line — emphasised so mam can tell at a glance whether
              the item already arrived from store or is still being procured. */}
          {isStore ? (
            <div className="text-emerald-700 font-semibold">
              🟢 Issued from Office Store
              {item.stock_issue_number && <span className="ml-1 font-mono">· {item.stock_issue_number}</span>}
              {item.stock_issued_at && <span className="ml-1 text-gray-500 font-normal">({fmtIST(item.stock_issued_at, { day: '2-digit', month: 'short' })})</span>}
            </div>
          ) : (
            <div className="text-blue-700 font-semibold">🛒 Fresh procurement</div>
          )}
          {hasMaster ? (
            <>
              {(item.item_code || item.master_name) && (
                <div>
                  {item.item_code && <span className="font-mono text-gray-500">[{item.item_code}]</span>}
                  {item.master_name && <span className="ml-1 font-semibold text-gray-800">{item.master_name}</span>}
                </div>
              )}
              {subLine && <div><span className="text-gray-400">Spec/Size:</span> {subLine}</div>}
              {item.make && <div><span className="text-gray-400">Make:</span> {item.make}</div>}
            </>
          ) : (
            <div className="italic text-gray-400">Manual entry (no item-master link)</div>
          )}
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-0.5">
            {item.item_type && <div><span className="text-gray-400">Type:</span> {item.item_type}</div>}
            {+item.master_price > 0 && (
              <div>
                <span className="text-gray-400">Rate:</span> ₹{Math.round(+item.master_price).toLocaleString('en-IN')}
                {item.rate_source === 'history' && (
                  <span className="ml-1 text-[9px] px-1 rounded bg-amber-100 text-amber-700 font-semibold" title="From price history — master sheet has no current_price">hist</span>
                )}
              </div>
            )}
            {+item.line_budget > 0 && <div><span className="text-gray-400">Budget:</span> ₹{Math.round(+item.line_budget).toLocaleString('en-IN')}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Procurement() {
  const { canDelete, canCreate, canEdit, canApprove, canView, user, isAdmin } = useAuth();
  // Site-engineer-style users see only "Raise Indent" — they don't enter
  // vendor rates, upload Vendor POs, Purchase Bills, or Dispatch. Those
  // tabs are gated by canApprove('procurement'), which admin grants to
  // the purchase team / admin role only. Matches mam's request (2026-04-23).
  const canPurchaseOps = isAdmin() || canApprove('procurement');
  const canRaiseIndent = isAdmin() || canCreate('procurement');
  // Tab + sub-tab state synced with URL ?tab=...&subtab=... so refresh /
  // back-button preserves where the user is, and tabs become bookmarkable
  // (mam 2026-05-25: "when i refresh then it go to front page which is
  // wrong"). Use a setter helper that writes both React state AND the URL
  // in one shot — no useEffect ping-pong.
  const [searchParams, setSearchParams] = useSearchParams();
  const VALID_TABS = ['indents', 'rates', 'vendorpo', 'bills', 'delivery', 'debitnotes', 'pipeline', 'responsible'];
  const urlTab = searchParams.get('tab');
  const [tab, _setTab] = useState(VALID_TABS.includes(urlTab) ? urlTab : 'indents');
  const setTab = (newTab) => {
    _setTab(newTab);
    setSearchParams(prev => {
      const sp = new URLSearchParams(prev);
      sp.set('tab', newTab);
      // Clear sub-tab when switching parent tab — previous sub-tab is
      // meaningless on the new tab.
      sp.delete('subtab');
      return sp;
    }, { replace: true });
  };
  const [indents, setIndents] = useState([]);
  const [vendorPos, setVendorPos] = useState([]);
  // Indent raising window (mam 2026-06-16): { isSaturday, emergencyActive,
  // allowed }. Saturday-only raising with an admin one-day emergency override.
  const [raiseWindow, setRaiseWindow] = useState(null);
  const [purchaseBills, setPurchaseBills] = useState([]);
  const [deliveryNotes, setDeliveryNotes] = useState([]);
  const [vendors, setVendors] = useState([]);
  // Vendor-picker options (mam 2026-06-19: "use vendor firm name"). Show
  // "Vendor Name — Firm Name" so a vendor is findable by EITHER, and the
  // SearchableSelect (which searches its display label) matches the firm
  // name too. valueKey stays `name` so the rate still stores vendor.name —
  // downstream finalize / Vendor PO code is untouched.
  const vendorOptions = useMemo(() => vendors.map(v => ({
    ...v,
    label: v.firm_name && v.firm_name !== v.name ? `${v.name} — ${v.firm_name}` : v.name,
  })), [vendors]);
  // Debit Notes (mam 2026-06-04 post-PO chart, stage 7)
  const [debitNotes, setDebitNotes] = useState([]);
  const [dnModal, setDnModal] = useState(false);
  const [dnForm, setDnForm] = useState({ type: 'rejected', vendor_po_id: '', reason: '', items: [], amount: 0, note: '', loaded: false });
  const [dnSaving, setDnSaving] = useState(false);
  const [pipeline, setPipeline] = useState([]);
  // PO qty vs received qty per item, for the Bill-upload modal (mam 2026-06-04).
  const [billItems, setBillItems] = useState(null);
  // Editable received qty per line { vpi_id: qty } — defaults to PO qty,
  // mam edits it down for a short; the bill amount follows received×rate.
  const [billRecv, setBillRecv] = useState({});
  const [editBillId, setEditBillId] = useState(null); // editing received qty of an existing purchase bill
  const [editRate, setEditRate] = useState(null);     // editing selling rate of a generated sales bill
  const loadDebitNotes = () => api.get('/procurement/debit-notes').then(r => setDebitNotes(r.data || [])).catch(() => setDebitNotes([]));
  const loadPipeline = () => api.get('/procurement/po-pipeline').then(r => setPipeline(r.data || [])).catch(() => setPipeline([]));
  useEffect(() => { if (tab === 'debitnotes') loadDebitNotes(); if (tab === 'pipeline') loadPipeline(); /* eslint-disable-next-line */ }, [tab]);
  const openDnModal = () => { setDnForm({ type: 'rejected', vendor_po_id: '', reason: '', items: [], amount: 0, note: '', loaded: false }); setDnModal(true); };
  const loadDnSource = async () => {
    if (!dnForm.vendor_po_id) { toast.error('Pick a Vendor PO first'); return; }
    try {
      const r = await api.get(`/procurement/vendor-po/${dnForm.vendor_po_id}/debit-source?type=${dnForm.type}`);
      setDnForm(f => ({ ...f, items: r.data.items || [], amount: r.data.amount || 0, note: r.data.note || '', reason: f.reason || r.data.note || '', loaded: true }));
      if (!(r.data.items || []).length) toast(r.data.note || 'No source lines found for this type', { icon: 'ℹ️' });
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to load source'); }
  };
  const saveDebitNote = async () => {
    if (!dnForm.vendor_po_id) { toast.error('Pick a Vendor PO'); return; }
    if (!(+dnForm.amount > 0)) { toast.error('Amount must be greater than 0'); return; }
    setDnSaving(true);
    try {
      const r = await api.post('/procurement/debit-notes', {
        type: dnForm.type, vendor_po_id: +dnForm.vendor_po_id,
        reason: dnForm.reason, items: dnForm.items, amount: +dnForm.amount,
      });
      toast.success(`Debit note ${r.data.dn_number} created`);
      setDnModal(false);
      loadDebitNotes();
      window.open(`/debit-note/${r.data.id}/print`, '_blank');
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to save'); }
    finally { setDnSaving(false); }
  };
  const [itemRates, setItemRates] = useState([]); // indent items with their 3-vendor rates + final
  const [pendingPoItems, setPendingPoItems] = useState([]); // finalized items not yet in a Vendor PO
  const [indentItemsForPo, setIndentItemsForPo] = useState([]); // items of the currently picked indent (for the Create Vendor PO modal)
  const [poItemSelection, setPoItemSelection] = useState({}); // { indent_item_id: { checked, quantity, rate, terms, credit_days } }
  const [ratesFilter, setRatesFilter] = useState('all'); // all | pending | quoted | finalized
  // Bulk-fill vendor + terms across ticked Vendor-Rate rows (mam 2026-06-12:
  // "one one item vendor name again again select lots of time").  Tick rows,
  // pick a vendor + terms once, apply to all at once for Vendor 1/2/3.
  const [rateSel, setRateSel] = useState({});          // { [rowKey]: true }
  const [bulkSlot, setBulkSlot] = useState(1);         // which vendor column (1|2|3)
  const [bulkVendorName, setBulkVendorName] = useState('');
  const [bulkTerms, setBulkTerms] = useState('');
  const [bulkCreditDays, setBulkCreditDays] = useState('');
  const [bulkApplying, setBulkApplying] = useState(false);
  const [finalModal, setFinalModal] = useState(null); // { row } being finalized
  const [finalForm, setFinalForm] = useState({});
  const [masterItems, setMasterItems] = useState([]); // Item Master dropdown source
  const [showAllMasters, setShowAllMasters] = useState(() => new Set()); // BOQ ids whose sub-item picker shows ALL divisions, not just the line's
  const [boqItems, setBoqItems] = useState([]); // BOQ items for the currently-selected site
  const [boqLoading, setBoqLoading] = useState(false);
  const [boqDiag, setBoqDiag] = useState(null); // backend diagnostic when BOQ is empty/partial
  const [uploadingBoq, setUploadingBoq] = useState(false);
  const [manualMode, setManualMode] = useState(false); // when true, items are typed free-text (no BOQ lookup)
  const [sites, setSites] = useState([]);         // unique site names (Business Book)
  const [employees, setEmployees] = useState([]); // for "Raised By" dropdown
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({});
  const [warehouses, setWarehouses] = useState([]);  // for Mark Received auto-IN
  // Mam (2026-06-02): "according to delivery note all items and qty
  // show here may delivery note item of qty 10 but when erec its 9".
  // Per-line received qty + short-reason override for partial deliveries.
  // Populated when Mark Received modal opens (via openMarkReceived /
  // openReceivePo) — each entry: {vpi_id, description, ordered_qty,
  // received_qty (editable), short_reason (editable), unit, item_code,
  // master_name, make}.
  const [receiveItems, setReceiveItems] = useState([]);
  const [indentItems, setIndentItems] = useState([{ ...EMPTY_ITEM }]);
  // Editable per-line items for the Sales Bill / Delivery Note modal.
  // Pre-filled from Client PO (po_items) so the rate column shows the
  // SELLING price (what we invoice the client), not vendor cost. Mam can
  // tweak qty / rate / disc % / include flag per row before generating.
  const [dispatchItems, setDispatchItems] = useState([]);
  const [dispatchItemsLoading, setDispatchItemsLoading] = useState(false);
  const [dispatchItemsSource, setDispatchItemsSource] = useState('po_items'); // 'po_items' | 'vendor_po' | 'empty'
  // Rate-source diagnostic — mam (2026-05-16): "if sales bill we
  // enter BOQ SITC rate".  When the backend can't supply BOQ
  // rates (no client PO, all zero rates, etc.) we surface a red
  // warning instead of silently falling back to vendor cost.
  const [dispatchRateInfo, setDispatchRateInfo] = useState({ source: null, warning: null, rated: 0, total: 0 });
  // Bill-To preview for Sales Bill modal — mam (2026-05-16):
  // critical fix #1 from the modal review.  Fetched from
  // /vendor-pos/:id/bill-to whenever a Vendor PO is picked.
  const [dispatchBillTo, setDispatchBillTo] = useState(null);

  // Vendor PO edit modal (mam, 2026-05-20: "how can i edit po
  // after creation because some time need").  Holds the PO row
  // being edited; null = closed.  Form fields are limited to
  // header-level safe edits (date / amount / advance / remarks)
  // — line items + vendor change need their own flows.
  const [editPo, setEditPo] = useState(null);
  const [editPoForm, setEditPoForm] = useState({});
  const [editPoItems, setEditPoItems] = useState([]);    // editable line items
  const [editPoLocked, setEditPoLocked] = useState(false); // locked when bills/DN exist
  const [editPoLockReason, setEditPoLockReason] = useState('');
  const [editPoSaving, setEditPoSaving] = useState(false);

  // Open Edit PO modal — fetches the PO with items so line-level fields
  // can be edited (mam 2026-05-25: "i want edit the po after creation
  // so that after correct").  Surfaces a lock banner if bills or DNs
  // already reference the PO (those would need cancelling first).
  const openEditVendorPo = async (v) => {
    setEditPo(v);
    setEditPoForm({
      po_date: v.po_date || '',
      expected_receipt_date: v.expected_receipt_date || '',
      total_amount: v.total_amount || 0,
      advance_required: v.advance_required || 0,
      remarks: v.remarks || '',
      // Internal payment-block fields (mam 2026-05-27). Pre-fill so editing
      // shows the current state and the user can change vendor stance mid-deal.
      payment_block_type: v.payment_block_type || '',
      payment_block_amount: v.payment_block_amount || '',
      payment_block_notes: v.payment_block_notes || '',
      // Freight terms + charge (mam 2026-06-12).
      freight_terms: v.freight_terms || '',
      freight_amount: v.freight_amount || '',
    });
    setEditPoItems([]);
    setEditPoLocked(false);
    setEditPoLockReason('');
    try {
      const r = await api.get(`/procurement/vendor-po/${v.id}/with-items`);
      setEditPoItems((r.data?.items || []).map(it => ({
        id: it.id,
        quantity: it.quantity,
        rate: it.rate,
        description: it.description || it.master_name || it.indent_description || '',
        hsn_code: it.hsn_code || '',
        item_code: it.item_code || '',
        master_name: it.master_name || '',
        specification: it.specification || '',
        size: it.size || '',
        unit: it.unit || '',
      })));
      if (r.data?.edit_locked) {
        setEditPoLocked(true);
        setEditPoLockReason(`${r.data.bill_count || 0} bill(s) and ${r.data.dn_count || 0} delivery note(s) reference this PO.  Cancel them first to edit line items.`);
      }
    } catch (err) {
      console.error('[openEditVendorPo] fetch items failed:', err.message);
    }
  };
  const saveEditVendorPo = async (e) => {
    e.preventDefault();
    if (!editPo?.id) return;
    setEditPoSaving(true);
    try {
      // Include line items only when NOT locked — server will reject
      // the request 409 if we send items on a locked PO.
      const payload = { ...editPoForm };
      if (!editPoLocked && editPoItems.length) {
        // Strip display-only fields so the server gets the minimal shape.
        payload.items = editPoItems.map(it => ({
          id: it.id,
          quantity: it.quantity,
          rate: it.rate,
          description: it.description,
          hsn_code: it.hsn_code,
        }));
        // Header total_amount will be auto-recomputed server-side from
        // the line items, so don't send the stale value.
        delete payload.total_amount;
      }
      await api.put(`/procurement/vendor-po/${editPo.id}`, payload);
      toast.success('PO updated');
      setEditPo(null);
      setEditPoForm({});
      setEditPoItems([]);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally {
      setEditPoSaving(false);
    }
  };
  // When set, the Raise Indent modal is in EDIT mode for this indent id —
  // saveIndent will PUT instead of POST. Used by the Edit pencil action
  // (mam: 'site eng is on training, if they fill wrong indent can edit').
  const [editingIndentId, setEditingIndentId] = useState(null);

  // Sales Bill late-upload modal (mam 2026-05-25): when a dispatch was
  // sent with Challan only + sales_bill_pending flag, this modal lets
  // mam add the formal SB later.  sbTarget = the dispatch row; null = closed.
  const [sbTarget, setSbTarget] = useState(null);
  const [sbForm, setSbForm] = useState({ sales_bill_number: '', file: null });
  const [sbSaving, setSbSaving] = useState(false);
  // Generate (not upload) a Sales Bill from a challan, then open its
  // printable invoice — mam (2026-06-04): "sales bill generate, not upload".
  const generateSalesBill = async (d) => {
    // Park the print tab synchronously (popup blockers eat window.open
    // after an await) — navigate it once the bill is ready.
    const printWin = window.open('', '_blank');
    try {
      const r = await api.post(`/procurement/delivery-notes/${d.id}/generate-sales-bill`);
      toast.success(`Sales Bill ${r.data.document_number} ${r.data.existing ? 'already exists' : 'generated'}${r.data.is_draft ? ' · DRAFT — fill client GSTIN / rates' : ''}`, { duration: 6000 });
      load();
      const res = await api.get(`/procurement/delivery-notes/${r.data.id}/print`, { responseType: 'arraybuffer' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'text/html;charset=utf-8' }));
      if (printWin) printWin.location = url; else window.open(url, '_blank');
    } catch (err) { if (printWin) printWin.close(); toast.error(err.response?.data?.error || 'Failed to generate Sales Bill'); }
  };
  const submitSalesBill = async () => {
    if (!sbTarget) return;
    const num = String(sbForm.sales_bill_number || '').trim();
    if (!num) { toast.error('Sales Bill number is required'); return; }
    setSbSaving(true);
    try {
      const fd = new FormData();
      fd.append('sales_bill_number', num);
      if (sbForm.file) fd.append('file', sbForm.file);
      await api.post(`/procurement/delivery-notes/${sbTarget.id}/sales-bill`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success(`Sales Bill ${num} added`);
      setSbTarget(null);
      setSbForm({ sales_bill_number: '', file: null });
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Upload failed');
    } finally {
      setSbSaving(false);
    }
  };

  // Approval / Rejection modals (mam 2026-05-25). approveTarget holds the
  // indent row + per-line quantity overrides the approver can tweak.
  // rejectTarget holds the indent row + the mandatory reason field.
  const [approveTarget, setApproveTarget] = useState(null);
  const [approveQtyOverrides, setApproveQtyOverrides] = useState({});
  // Per-line UNIT override (mam 2026-06-06): L2 can fix a wrong Item-Master UOM
  // at approval ("unit can also change ... our itemwise has some wrong").
  const [approveUnitOverrides, setApproveUnitOverrides] = useState({});
  // Mam (2026-06-02): per-line "From Store" qty.  When > 0 the approver
  // is saying "issue N pcs of this line from existing office stock and
  // procure the rest as a fresh vendor PO".  Auto-seeded to min(office,
  // approved) when the modal opens; mam can override anywhere from 0 to
  // min(approved, office_stock).
  const [approveFromStore, setApproveFromStore] = useState({});
  // Client-quotation margin % for Extra-Non-Schedule CRM approval (mam
  // 2026-06-04 workflow chart). Only used at the CRM stage of an
  // extra_non_schedule indent; applied to the auto billable line.
  const [approveMargin, setApproveMargin] = useState('');
  const [approveSaving, setApproveSaving] = useState(false);
  const [rejectTarget, setRejectTarget] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectSaving, setRejectSaving] = useState(false);

  // ── Filter / search / pagination state (mam 2026-05-25 UI sweep) ──────
  // Each tab gets its own filter slice + page index so switching tabs
  // doesn't lose state, and changing a filter on one tab doesn't reset
  // pagination on another.
  //
  // Per-page is now PER-TAB stateful (mam 2026-05-25 follow-up:
  // "show here all data remove page wise as per user requirement").
  // User picks 15 / 50 / 100 / All from the Pagination dropdown; choice
  // persists for that tab until they navigate away.  Defaults to 15.
  const [indPerPage, setIndPerPage]               = useState(15);
  const [ratesPerPage, setRatesPerPage]           = useState(15);
  const [vpoPendingPerPage, setVpoPendingPerPage] = useState(15);
  const [vpoListPerPage, setVpoListPerPage]       = useState(15);
  const [billsFuPerPage, setBillsFuPerPage]       = useState(15);
  const [billsListPerPage, setBillsListPerPage]   = useState(15);
  const [dispReadyPerPage, setDispReadyPerPage]   = useState(15);
  const [dispListPerPage, setDispListPerPage]     = useState(15);
  // Indents
  const [indFilterStatus, setIndFilterStatus]     = useState('all');
  const [indFilterCategory, setIndFilterCategory] = useState('all');  // mam's 5 categories (2026-05-26)
  const [indFilterFrom, setIndFilterFrom]         = useState('');
  const [indFilterTo, setIndFilterTo]             = useState('');
  const [indSearch, setIndSearch]                 = useState('');
  const [indPage, setIndPage]                     = useState(1);
  // Vendor Rates
  const [ratesSearch, setRatesSearch]           = useState('');
  const [ratesPage, setRatesPage]               = useState(1);
  // Vendor PO sub-tabs (pending | list) — URL-synced
  const urlSubTab = searchParams.get('subtab');
  const [vpoSubTab, _setVpoSubTab] = useState(
    urlTab === 'vendorpo' && ['pending','list'].includes(urlSubTab) ? urlSubTab : 'pending'
  );
  const setVpoSubTab = (st) => {
    _setVpoSubTab(st);
    setSearchParams(prev => { const sp = new URLSearchParams(prev); sp.set('subtab', st); return sp; }, { replace: true });
  };
  const [vpoPendingSearch, setVpoPendingSearch] = useState('');
  // Default to 'finalized' — mam (2026-05-25): "I WANT SHOW HERE AFTER
  // RATE FINIALISE".  Only finalized rates are ready for a Vendor PO;
  // pending/quoted items still need purchase team to negotiate.  Mam can
  // flip the dropdown to "All" to see everything if she wants.
  const [vpoPendingStatus, setVpoPendingStatus] = useState('finalized');
  const [vpoPendingPage, setVpoPendingPage]     = useState(1);
  const [vpoListSearch, setVpoListSearch]       = useState('');
  const [vpoListStatus, setVpoListStatus]       = useState('all');
  const [vpoListFrom, setVpoListFrom]           = useState('');
  const [vpoListTo, setVpoListTo]               = useState('');
  const [vpoListPage, setVpoListPage]           = useState(1);
  // Purchase Bills sub-tabs (followup | bills) — URL-synced
  const [billsSubTab, _setBillsSubTab] = useState(
    urlTab === 'bills' && ['followup','bills'].includes(urlSubTab) ? urlSubTab : 'followup'
  );
  const setBillsSubTab = (st) => {
    _setBillsSubTab(st);
    setSearchParams(prev => { const sp = new URLSearchParams(prev); sp.set('subtab', st); return sp; }, { replace: true });
  };
  const [billsFuSearch, setBillsFuSearch]       = useState('');
  const [billsFuExpFrom, setBillsFuExpFrom]     = useState('');
  const [billsFuExpTo, setBillsFuExpTo]         = useState('');
  const [billsFuPage, setBillsFuPage]           = useState(1);
  // ─── Payment tab state (mam 2026-05-27) ───
  // Top-level Payment tab between Vendor PO and Purchase Bills.
  // 3 pill segments: all / urgent (pending advance/old dues) / cleared (done).
  const [paymentPill, setPaymentPill]           = useState('urgent');
  const [paymentSearch, setPaymentSearch]       = useState('');
  const [billsListSearch, setBillsListSearch]   = useState('');
  const [billsListFrom, setBillsListFrom]       = useState('');
  const [billsListTo, setBillsListTo]           = useState('');
  const [billsListPage, setBillsListPage]       = useState(1);
  // Dispatch sub-tabs (ready | list) — URL-synced
  const [dispatchSubTab, _setDispatchSubTab] = useState(
    urlTab === 'delivery' && ['ready','list'].includes(urlSubTab) ? urlSubTab : 'ready'
  );
  const setDispatchSubTab = (st) => {
    _setDispatchSubTab(st);
    setSearchParams(prev => { const sp = new URLSearchParams(prev); sp.set('subtab', st); return sp; }, { replace: true });
  };
  const [dispReadySearch, setDispReadySearch]   = useState('');
  const [dispReadyPage, setDispReadyPage]       = useState(1);
  const [dispListSearch, setDispListSearch]     = useState('');
  const [dispListStatus, setDispListStatus]     = useState('all');
  const [dispListFrom, setDispListFrom]         = useState('');
  const [dispListTo, setDispListTo]             = useState('');
  const [dispListPage, setDispListPage]         = useState(1);
  const [expandedIndents, setExpandedIndents] = useState(() => new Set());
  const toggleIndentRow = (id) => setExpandedIndents(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // ── Tab-wise lazy fetching (mam 2026-05-25: "abd tab wise api fetch") ──
  //
  // Old behaviour: load() fired 9 parallel API calls on mount regardless
  // of which tab was visible.  Slow + wasted bandwidth for users who
  // only opened one tab.
  //
  // New behaviour:
  //   1. Reference data (vendors, sites, employees, masterItems, warehouses)
  //      loads once on mount — these are small and used by modals on
  //      every tab.
  //   2. Each tab's domain data loads ON DEMAND when that tab is first
  //      shown (or when reloadTab is called after a CRUD operation).
  //   3. `loadedTabs` Set caches which tabs have been fetched so quick
  //      tab-switching doesn't refetch unnecessarily.  Tabs are dropped
  //      from the cache after CRUD so the next visit refreshes.
  //
  // Dependencies between tabs (e.g. Bills tab needs vendorPos AND
  // purchaseBills; Dispatch tab needs all three) are spelt out per tab
  // in TAB_FETCHERS so each tab gets exactly what it renders, no more.
  const [loadedTabs, setLoadedTabs] = useState(() => new Set());

  // One-time reference data load.  These are small + cross-tab so it's
  // cheaper to load them once than to track per-tab dependencies.
  const loadReference = () => {
    api.get('/procurement/vendors').then(r => setVendors(r.data)).catch(() => setVendors([]));
    api.get('/item-master/dropdown').then(r => setMasterItems(r.data || [])).catch(() => setMasterItems([]));
    api.get('/procurement/sites').then(r => setSites(r.data || [])).catch(() => setSites([]));
    api.get('/hr/employees').then(r => setEmployees((r.data || []).filter(e => !e.status || e.status === 'active'))).catch(() => setEmployees([]));
    // Warehouses · 403 for non-inventory users → silently empty list.
    api.get('/inventory/warehouses').then(r => setWarehouses(r.data || [])).catch(() => setWarehouses([]));
  };

  // Per-tab loaders.  Each returns a Promise that resolves when all of
  // that tab's required data is in state.  Tabs declare their full
  // dependency set so an indirect tab switch (e.g. Bills uses vendorPos
  // too) still works.
  const TAB_FETCHERS = {
    indents: () => Promise.all([
      api.get('/procurement/indents').then(r => setIndents(r.data)).catch(() => setIndents([])),
      // Also pull Vendor POs so the Raise-Indent KPI strip can show the
      // real "PO Generate" count + "Payment Required" total (mam 2026-06-12).
      api.get('/procurement/vendor-po').then(r => setVendorPos(r.data)).catch(() => setVendorPos([])),
      // Is raising open today? (Saturday-only + admin emergency override.)
      api.get('/procurement/indent-raise-window').then(r => setRaiseWindow(r.data)).catch(() => setRaiseWindow(null)),
    ]),
    rates: () => Promise.all([
      api.get('/procurement/indents').then(r => setIndents(r.data)).catch(() => setIndents([])),
      api.get('/procurement/item-rates').then(r => setItemRates(r.data || [])).catch(() => setItemRates([])),
    ]),
    vendorpo: () => Promise.all([
      api.get('/procurement/vendor-po').then(r => setVendorPos(r.data)).catch(() => setVendorPos([])),
      api.get('/procurement/pending-po-items').then(r => setPendingPoItems(r.data || [])).catch(() => setPendingPoItems([])),
    ]),
    bills: () => Promise.all([
      api.get('/procurement/vendor-po').then(r => setVendorPos(r.data)).catch(() => setVendorPos([])),
      api.get('/procurement/purchase-bills').then(r => setPurchaseBills(r.data)).catch(() => setPurchaseBills([])),
    ]),
    // Mam (2026-06-15) "auto generated, no Dispatch click": opening this tab
    // first sweeps every Ready-to-Dispatch PO and auto-creates its client
    // Sales Bill server-side (idempotent; skips unrated POs), THEN loads — so
    // bills appear on their own with the PDF viewable, no button press.
    delivery: () => api.post('/procurement/auto-sales-bills/sweep')
      .then(r => {
        const n = r.data?.generated_count || 0;
        if (n > 0) toast.success(`${n} Sales Bill${n > 1 ? 's' : ''} auto-generated`, { duration: 5000 });
      })
      .catch(() => {}).then(() => Promise.all([
      api.get('/procurement/vendor-po').then(r => setVendorPos(r.data)).catch(() => setVendorPos([])),
      api.get('/procurement/purchase-bills').then(r => setPurchaseBills(r.data)).catch(() => setPurchaseBills([])),
      api.get('/procurement/delivery-notes').then(r => setDeliveryNotes(r.data)).catch(() => setDeliveryNotes([])),
    ])),
  };

  // Fetch a tab's data, honouring cache.  Pass force=true after a CRUD
  // operation to bypass cache and refresh.
  const loadTab = (tabName, { force = false } = {}) => {
    const fetcher = TAB_FETCHERS[tabName];
    if (!fetcher) return Promise.resolve();
    if (!force && loadedTabs.has(tabName)) return Promise.resolve();
    return fetcher().then(() => {
      setLoadedTabs(prev => new Set(prev).add(tabName));
    });
  };

  // Backward-compat: many CRUD handlers call `load()` to refresh.  Keep
  // the name but reroute it to "refresh the CURRENTLY-ACTIVE tab only"
  // — that's all the user can see, anyway.  We also invalidate the
  // cache for tabs whose data overlaps so a follow-up switch refetches.
  const load = () => {
    // Reset cache for tabs that overlap with the current tab so stale
    // cross-tab data doesn't linger after a create/edit/delete.
    setLoadedTabs(prev => {
      const next = new Set(prev);
      // Most CRUD ops in this page invalidate vendorPos / purchaseBills
      // somehow, so safest to evict the dependent tabs alongside the
      // current one.  Indents tab is self-contained.
      next.delete(tab);
      if (tab === 'vendorpo' || tab === 'bills' || tab === 'delivery') {
        next.delete('vendorpo');
        next.delete('bills');
        next.delete('delivery');
      }
      return next;
    });
    return loadTab(tab, { force: true });
  };

  // Mount → reference data + current tab.  No more 9-call fan-out.
  useEffect(() => {
    loadReference();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tab switch → lazy fetch the new tab's data (cached if already loaded).
  // Raise-Indent is a live dashboard — its UNIT / RATE / LINE BUDGET pull
  // the CURRENT Item Master UOM + price — so always refetch it fresh
  // (mam 2026-06-12: "i edit in uom but not change here live"); other
  // tabs keep using the cache.
  useEffect(() => {
    loadTab(tab, { force: tab === 'indents' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Deep-link from the War Room "My Approvals" inbox: ?approve=<indentId>
  // opens that indent's FULL qty-wise approval modal (mam 2026-06-24: dashboard
  // approve must show items + qty-wise L2 approval, not a blind one-click).
  const approveParamHandled = useRef(null);
  useEffect(() => {
    const id = searchParams.get('approve');
    if (!id || approveParamHandled.current === id) return;
    const it = indents.find(x => String(x.id) === String(id));
    if (it) {
      approveParamHandled.current = id;
      openApproveModal(it);
      const next = new URLSearchParams(searchParams);
      next.delete('approve');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, indents]);

  // Returning to this browser tab after editing an item's UOM / price on
  // the Item Master page in another tab should show the live value here.
  // Refetch the Raise-Indent data on focus; skipped for inline-edit tabs
  // (e.g. Vendor Rates) so in-progress typing isn't clobbered.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible' && tab === 'indents') {
        loadTab('indents', { force: true });
      }
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Site dropdown shows one row per unique name. BOQ/PO items are aggregated
  // across every Business Book entry matching that name, so picking
  // 'CONSERN PHARMA' pools items from all CONSERN PHARMA projects.
  const reloadBoq = async (siteName) => {
    if (!siteName) { setBoqItems([]); setBoqDiag(null); return; }
    setBoqLoading(true);
    try {
      const r = await api.get('/procurement/boq-items', { params: { site_name: siteName } });
      const payload = r.data;
      const list = Array.isArray(payload) ? payload : (payload?.items || []);
      const diag = Array.isArray(payload) ? null : (payload?.diagnostic || null);
      setBoqItems(list);
      setBoqDiag(diag);
    } catch { setBoqItems([]); setBoqDiag(null); }
    setBoqLoading(false);
  };
  const handleSiteChange = (site) => {
    // `site` is the object from SearchableSelect ({ name, lead_no }).
    setForm(f => ({ ...f, site_name: site?.name || '', lead_no: site?.lead_no || '' }));
    setIndentItems([{ ...EMPTY_ITEM }]);
    setBoqDiag(null);
    setManualMode(false);
    reloadBoq(site?.name || '');
  };

  // Fetch items from the BOQ already attached to this site's PO. No
  // re-upload — server parses boq_file_link on disk or falls back to
  // boq_items via the linked quotation, then saves into po_items so
  // Remaining tracking works across indents.
  const fetchExistingBoq = async () => {
    if (!form.site_name) return toast.error('Pick a site first');
    setUploadingBoq(true);
    try {
      const r = await api.post('/procurement/fetch-existing-boq', { site_name: form.site_name });
      toast.success(`Fetched ${r.data.items_saved} items from ${r.data.source === 'po_file' ? `PO ${r.data.po_number} BOQ file` : 'BOQ module'}`);
      reloadBoq(form.site_name);
    } catch (err) { toast.error(err.response?.data?.error || 'Fetch failed'); }
    setUploadingBoq(false);
  };

  // Fallback — if truly nothing on file, admin can still upload.
  const uploadBoqForSite = async (file) => {
    if (!form.site_name) return toast.error('Pick a site first');
    setUploadingBoq(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('site_name', form.site_name);
      const r = await api.post('/procurement/upload-boq-for-site', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(`BOQ saved — ${r.data.items_saved} items`);
      reloadBoq(form.site_name);
    } catch (err) { toast.error(err.response?.data?.error || 'Upload failed'); }
    setUploadingBoq(false);
  };

  // Picking an actual SKU from Item Master for this row. One BOQ line often
  // maps to one PO item plus a few FOC accessories — each gets its own row
  // that references the same BOQ item but a different Item Master entry.
  const pickMasterItem = (i, master) => {
    const n = [...indentItems];
    // DO NOT overwrite `description` here. `description` carries the BOQ
    // line's text from the Client PO (set by pickBoqItem) and is what the
    // BOQ-section header displays. Earlier this function rewrote it with
    // the sub-item's name, which made the header read the sub-item — mam:
    // "look at 2 photo when i select po foc item why boq item name change".
    // The sub-item label is already shown by the SearchableSelect itself,
    // so we only update the linkage + unit/type/make.
    n[i] = {
      ...n[i],
      item_master_id: master?.id || '',
      unit: master?.uom?.toLowerCase() || n[i].unit || 'nos',
      item_type: master?.type || n[i].item_type || '',
      make: master?.make || n[i].make || '',
    };
    setIndentItems(n);

    // Department-mismatch warning — mam (2026-05-25, IND-0075 follow-up):
    // when the picked sub-item's department doesn't match the BOQ row's
    // expected department (derived from the BOQ's primary item_master
    // linkage), fire a yellow warning toast.  Not an error — user can
    // still save if they know better, but they'll notice the mismatch
    // before submitting.  Only fires when BOTH sides have a department
    // — silent otherwise to avoid noise.
    if (master?.department && n[i].po_item_id) {
      const boq = boqItems.find(b => +b.id === +n[i].po_item_id);
      const boqMasterId = boq?.item_master_id;
      if (boqMasterId && +boqMasterId !== +master.id) {
        const boqMaster = masterItems.find(m => +m.id === +boqMasterId);
        const boqDept = String(boqMaster?.department || '').trim().toUpperCase();
        const picked  = String(master.department || '').trim().toUpperCase();
        if (boqDept && picked && boqDept !== picked) {
          toast(`⚠ Dept mismatch: BOQ is ${boqDept}, sub-item is ${picked}. Double-check this is intentional.`, {
            duration: 5000,
            icon: '⚠️',
            style: { background: '#fffbeb', color: '#92400e', border: '1px solid #fcd34d' },
          });
        }
      }
    }
  };

  // Picking a BOQ item for this row — fills description / unit / type / make
  // and copies BOQ qty + remaining so the UI can show "BOQ 100 · Rem 60"
  // like DPR does. FOC items have remaining = null (hidden in UI).
  const pickBoqItem = (i, item) => {
    const n = [...indentItems];
    n[i] = {
      ...n[i],
      po_item_id: item?.id || '',
      item_master_id: item?.item_master_id || '',
      description: item?.description || '',
      unit: (item?.unit || n[i].unit || 'nos').toString().toLowerCase(),
      // Default a freshly-picked BOQ to PO mode (the chargeable case) unless the
      // BOQ line itself is FOC. The BOQ-level PO/FOC toggle can switch it.
      item_type: item?.item_type || 'PO',
      make: item?.item_make || n[i].make || '',
      boq_qty: item?.boq_qty || 0,
      remaining_qty: item?.remaining_qty,
      is_foc: !!item?.is_foc,
    };
    setIndentItems(n);
  };

  const saveIndent = async (e) => {
    e.preventDefault();
    if (!form.site_name) return toast.error('Site Name is required');
    if (!form.raised_by_name) return toast.error('Raised By is required');
    // ─── Per-category client-side validation (mam's spec 2026-05-26) ───
    // Server enforces the same rules, but failing fast in the UI gives
    // a better error UX (row number + specific cause).
    const cat = form.indent_category || 'material';
    // RGP no longer requires BOQ (mam 2026-05-27): returnable material is
    // picked directly from Item Master, not tied to the Client PO BOQ.
    const needsBoq = (cat === 'material' || cat === 'extra_schedule');
    for (let i = 0; i < indentItems.length; i++) {
      const it = indentItems[i];
      if (needsBoq && !it.po_item_id) return toast.error(`Row ${i + 1}: pick BOQ Item (from Client PO)`);
      if (!it.item_master_id) return toast.error(`Row ${i + 1}: pick Sub-Item (from Item Master)`);
      if (!(+it.quantity > 0)) return toast.error(`Row ${i + 1}: Quantity must be greater than 0`);
      if (cat === 'rental') {
        if (!(+it.rental_days > 0)) return toast.error(`Row ${i + 1}: Days must be greater than 0 (Rental)`);
        if (!(+it.rental_rate_per_day > 0)) return toast.error(`Row ${i + 1}: Rate per day must be greater than 0 (Rental)`);
        // Rental-vs-buy block — mirrored server-side. Surfaces here so the
        // user can fix it before sending. masterPrice comes from item_master
        // (or item_price_history fallback) — both surfaced via masterItems.
        const m = masterItems.find(x => +x.id === +it.item_master_id);
        const masterPrice = +m?.current_price || 0;
        if (masterPrice <= 0) return toast.error(`Row ${i + 1}: Cannot validate rental — Item Master rate missing for this item`);
        const totalRental = (+it.quantity || 0) * (+it.rental_days || 0) * (+it.rental_rate_per_day || 0);
        const buyCost = (+it.quantity || 0) * masterPrice;
        if (totalRental >= buyCost) {
          return toast.error(`Row ${i + 1}: Rental cost ₹${Math.round(totalRental).toLocaleString('en-IN')} ≥ buying outright ₹${Math.round(buyCost).toLocaleString('en-IN')}. Buy instead of renting.`);
        }
      }
    }

    // ─── BOQ sub-item rules (mam 2026-06-26: BOQ-level PO/FOC toggle) ─────
    // Each BOQ row is EITHER PO mode (exactly ONE chargeable PO sub-item +
    // optional FOC) OR FOC-only mode (≥1 FOC, no PO — free, not billed).
    // A BOQ with no PO and no FOC (untyped) is invalid. Off-BOQ categories skip.
    if (needsBoq) {
      const subItemsPerBoq = new Map();
      for (const it of indentItems) {
        const poId = Number.isInteger(+it.po_item_id) && +it.po_item_id > 0 ? +it.po_item_id : null;
        if (!poId) continue;
        const t = String(it.item_type || '').toUpperCase();
        const b = subItemsPerBoq.get(poId) || { po: 0, foc: 0 };
        if (t === 'PO') b.po++;
        else if (t === 'FOC') b.foc++;
        subItemsPerBoq.set(poId, b);
      }
      for (const [, b] of subItemsPerBoq) {
        if (b.po > 1) {
          return toast.error('Only ONE PO sub-item allowed per BOQ (PO mode). Keep one and make the rest FOC.');
        }
        if (b.po === 0 && b.foc === 0) {
          return toast.error('Each BOQ needs a sub-item — pick PO (chargeable) or FOC (free) using the BOQ’s Type toggle.');
        }
      }
    }
    const payload = {
      site_name: form.site_name,
      raised_by_name: form.raised_by_name,
      notes: form.notes || '',
      indent_category: cat,
      items: indentItems.map(it => ({
        ...it,
        make: it.make || '',
        // Strip rental fields off non-rental rows so the server doesn't
        // mistake old form state for rental data.
        rental_days: cat === 'rental' ? (+it.rental_days || null) : null,
        rental_rate_per_day: cat === 'rental' ? (+it.rental_rate_per_day || null) : null,
      })),
    };
    try {
      if (editingIndentId) {
        await api.put(`/procurement/indents/${editingIndentId}`, payload);
        toast.success('Indent updated');
      } else {
        await api.post('/procurement/indents', payload);
        toast.success('Indent submitted — awaiting approval');
      }
      setModal(false); setEditingIndentId(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Admin-only: open / close emergency indent raising for today (mam
  // 2026-06-16). Server stores today's IST date so it auto-expires tomorrow.
  const toggleIndentEmergency = async () => {
    try {
      const enable = !(raiseWindow && raiseWindow.emergencyActive);
      const r = await api.put('/procurement/indent-raise-window', { enable });
      setRaiseWindow(r.data);
      toast.success(r.data.emergencyActive ? 'Emergency raising opened for today' : 'Emergency raising turned off');
    } catch (err) { toast.error(err.response?.data?.error || 'Could not update'); }
  };

  // Pre-fill the Raise Indent modal with an existing indent's data so a
  // wrongly filled indent can be corrected in place. Indents that are
  // already approved or have an active Vendor PO against them are
  // blocked server-side anyway — we just hide the button for those.
  const openEditIndent = async (indent) => {
    try {
      const r = await api.get(`/procurement/indents/${indent.id}`);
      const data = r.data;
      setForm({
        site_name: data.site_name || '',
        // Raised By is locked to logged-in user in the form (mam
        // 2026-05-28). On edit: keep the existing name if it's valid
        // (non-numeric, non-empty). Otherwise fall back to the
        // editor's name — claims responsibility for the legacy row.
        raised_by_name: (data.raised_by_name && !/^\d+(\.\d+)?$/.test(String(data.raised_by_name).trim()))
          ? data.raised_by_name
          : (user?.name || ''),
        notes: data.notes || '',
        indent_category: data.indent_category || 'material',
      });
      // Fetch BOQ items inline so we have the list synchronously available
      // for the back-fill below.  reloadBoq() sets state but doesn't return
      // the list, so we can't use it for the per-item lookup.
      let boqList = [];
      try {
        const bRes = await api.get('/procurement/boq-items', { params: { site_name: data.site_name || '' } });
        const payload = bRes.data;
        boqList = Array.isArray(payload) ? payload : (payload?.items || []);
        setBoqItems(boqList);
        setBoqDiag(Array.isArray(payload) ? null : (payload?.diagnostic || null));
      } catch { setBoqItems([]); }

      // Back-fill po_item_id from item_master_id / description — mam
      // (2026-05-25): legacy indents created before po_item_id was a
      // required field have it=NULL even though item_master_id +
      // description are set.  Without this, the Edit modal grouped each
      // item under "__empty_<idx>" and showed an empty BOQ picker for
      // every row.
      //
      // Strategy (in order — first match wins):
      //   1. If the indent item already has a valid po_item_id, keep it.
      //   2. Match by item_master_id  →  BOQ row's primary linkage.
      //   3. Match by exact description (lowercase, trimmed).
      //   4. NEW · Match by description PREFIX (first 60 normalised chars)
      //      — catches truncation differences ("…complete as per" vs the
      //      full "…complete as per drawings & specifications").
      //   5. NEW · Match by SIBLING — if another indent line with the same
      //      description (or item_master_id) already resolved to a BOQ
      //      via steps 2-4, reuse that po_id.  Covers IND-0050 where 3
      //      sub-items share ONE BOQ but only the first one had a matching
      //      item_master_id linkage in the BOQ row.
      //   6. Fall back to manual entry (description preserved).
      const descKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const prefixKey = (s) => descKey(s).slice(0, 60);
      const boqByMaster = new Map();
      const boqByDesc = new Map();
      const boqByPrefix = new Map();
      for (const b of boqList) {
        if (b.item_master_id) {
          const k = +b.item_master_id;
          if (!boqByMaster.has(k)) boqByMaster.set(k, b);
        }
        const dk = descKey(b.description);
        if (dk && !boqByDesc.has(dk)) boqByDesc.set(dk, b);
        const pk = prefixKey(b.description);
        if (pk && !boqByPrefix.has(pk)) boqByPrefix.set(pk, b);
      }
      // First pass · resolve each line independently via methods 1-4.
      const resolved = (data.items || []).map(it => {
        let poId = it.po_item_id || '';
        if (!poId && it.item_master_id) {
          const boq = boqByMaster.get(+it.item_master_id);
          if (boq) poId = boq.id;
        }
        if (!poId && it.description) {
          const boq = boqByDesc.get(descKey(it.description));
          if (boq) poId = boq.id;
        }
        if (!poId && it.description) {
          const boq = boqByPrefix.get(prefixKey(it.description));
          if (boq) poId = boq.id;
        }
        return { it, poId };
      });
      // Second pass · for any STILL-empty rows, see if a sibling with the
      // same description already resolved.  Reuse that poId so all
      // siblings group under the same BOQ section.
      const siblingByDesc = new Map();
      for (const r of resolved) {
        if (r.poId && r.it.description) {
          const k = descKey(r.it.description);
          if (!siblingByDesc.has(k)) siblingByDesc.set(k, r.poId);
        }
      }
      const rows = resolved.map(({ it, poId }) => {
        let finalPoId = poId;
        if (!finalPoId && it.description) {
          finalPoId = siblingByDesc.get(descKey(it.description)) || '';
        }
        return {
          po_item_id: finalPoId,
          item_master_id: it.item_master_id || '',
          description: it.description || '',
          make: it.make || '',
          quantity: +it.quantity || 0,
          unit: it.unit || 'nos',
          item_type: it.item_type || '',
          boq_qty: 0,
          remaining_qty: null,
          manual: !finalPoId && !it.item_master_id && !!it.description,
          required_date: it.required_date || '',
        };
      });
      // Diagnostic — logs to browser console if any line failed to resolve.
      // Helps mam tell us which indent items need attention without us
      // having to ask for screenshots.
      const unresolved = rows.filter(r => !r.po_item_id && r.item_master_id);
      if (unresolved.length) {
        console.warn(`[openEditIndent] ${unresolved.length}/${rows.length} indent items couldn't be matched to a BOQ row.`,
          unresolved.map(r => ({ description: r.description, item_master_id: r.item_master_id })));
      }
      setIndentItems(rows.length ? rows : [{ ...EMPTY_ITEM }]);
      setEditingIndentId(indent.id);
      setModal('indent');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load indent');
    }
  };

  // Admin only — wipes all indents, vendor POs and related rows. Used when
  // mam wants a clean slate before a demo / new operating cycle.
  const wipeData = async () => {
    if (!confirm('Delete ALL Dispatches, Vendor POs, Purchase Bills and Delivery Notes?\n\nThis cannot be undone. Type YES in the next prompt to confirm.')) return;
    const c = prompt('Type YES (in capitals) to confirm permanent deletion:');
    if (c !== 'YES') return toast.error('Cancelled — nothing deleted');
    try {
      const r = await api.post('/procurement/admin/wipe-indents-pos');
      toast.success(`Cleared: ${r.data.counts.indents} dispatches, ${r.data.counts.vendor_pos} POs, ${r.data.counts.purchase_bills} bills, ${r.data.counts.delivery_notes} delivery notes`);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Wipe failed'); }
  };

  const approveIndent = async (id, status) => {
    await api.put(`/procurement/indents/${id}`, { status });
    toast.success(`Indent ${status}`);
    load();
  };
  // Admin Re-approve — revoke a rejection and flip the indent back to approved
  // (mam 2026-06-04). No reason modal; it's an admin override.
  // Re-approve opens the SAME approve modal so the MD can also edit order
  // qty + From-Store qty while re-approving (mam 2026-06-04). First RESET
  // any prior store issue (return the qty to stock, cancel the issue note,
  // merge the split line back to full qty) so the modal shows the original
  // quantities and the From-Store split can be re-entered cleanly — this
  // fixes a wrong store qty (e.g. 10 entered when 1000 was meant).
  const reapproveIndent = async (i) => {
    // PO-sent indents already have a vendor PO out for the full qty. Issuing
    // from store now splits the line but does NOT cancel that PO — warn the
    // admin so they reduce/cancel the vendor PO for the store-issued qty.
    if (i.status === 'po_sent' && !window.confirm(
      `A vendor PO was already SENT for ${i.indent_number || 'this indent'}.\n\n` +
      `Issuing from store now will reopen approval and split the qty, but it will NOT ` +
      `change the vendor PO. After issuing from store, reduce or cancel the vendor PO ` +
      `for that quantity so you don't buy + issue the same material.\n\nContinue?`)) {
      return;
    }
    try {
      const r = await api.post(`/procurement/indents/${i.id}/reset-store-issue`);
      if (r.data?.reversed > 0) {
        toast(`Reset ${r.data.reversed_qty} from a previous store issue — re-enter the split`, { icon: '↩️', duration: 5000 });
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not reset the previous store issue');
      return;
    }
    openApproveModal(i);  // fetches the merged (full-qty) lines
  };

  // Open the Approve modal — pre-seeds the qty-override map with each line's
  // current quantity so the approver can edit-in-place before confirming.
  //
  // Mam (2026-05-25 follow-up): also fetch fresh detail from /indents/:id
  // so the modal has the per-line office_stock + site_stock + master_price
  // numbers that the list endpoint doesn't carry.  Falls back to the row
  // already in the list if the fetch fails.
  const openApproveModal = async (indent) => {
    let detail = indent;
    try {
      const r = await api.get(`/procurement/indents/${indent.id}`);
      detail = { ...indent, items: r.data?.items || indent.items || [] };
    } catch (err) {
      // Use the list-loaded row; the modal still works, just without stock.
    }
    const seed = {};
    // Mam (2026-06-02 follow-up): "5 (auto-suggested) store not auto
    // assigned some time our store have but place is so far then also
    // approved or editable suggest store qty".  We DO NOT pre-fill the
    // From Store column anymore — sometimes the office store is too
    // far from site (transport > fresh-buy cost), or stock is reserved
    // for another job, or it's used/scrap quality.  So:
    //   - Default = 0 (no auto-assign).  Indent flows like before
    //     unless the approver consciously decides to issue from stock.
    //   - The cell still shows "📦 N avail" as a one-click chip that
    //     fills the input with min(stock, approved) on tap.
    const seedStore = {};
    for (const it of (detail.items || [])) {
      seed[it.id] = it.quantity;
      seedStore[it.id] = 0;
    }
    setApproveQtyOverrides(seed);
    setApproveFromStore(seedStore);
    setApproveTarget(detail);
  };
  // Open the Reject modal — empty reason; saves on submit only if non-empty.
  const openRejectModal = (indent) => {
    setRejectReason('');
    setRejectTarget(indent);
  };

  // Open the auto-generated Store Issue Challan (HTML print) for material
  // issued from store at approval (mam 2026-06-23: "store different challan
  // show ... from the approval step"). The print endpoint is auth-protected
  // and returns HTML, so we fetch it as a blob and open that.
  const openStoreChallan = async (challanId) => {
    if (!challanId) return;
    try {
      const printRes = await api.get(`/procurement/delivery-notes/${challanId}/print`, { responseType: 'arraybuffer' });
      const blob = new Blob([printRes.data], { type: 'text/html;charset=utf-8' });
      window.open(URL.createObjectURL(blob), '_blank');
    } catch {
      toast.error('Could not open the Store Issue Challan');
    }
  };

  // Open the item-wise BILLABLE statement (PDF) for an indent — the sale-rate
  // breakdown for showing / auditing (mam 2026-06-24). Auth-protected HTML, so
  // fetch as a blob and open it.
  const openBillablePrint = async (indentId) => {
    try {
      const r = await api.get(`/procurement/indents/${indentId}/billable-print`, { responseType: 'arraybuffer' });
      const blob = new Blob([r.data], { type: 'text/html;charset=utf-8' });
      window.open(URL.createObjectURL(blob), '_blank');
    } catch {
      toast.error('Could not open the billable statement');
    }
  };

  const submitApprove = async () => {
    if (!approveTarget) return;
    // Only send overrides that actually CHANGED, so unchanged lines aren't
    // touched server-side. Also guard against 0 / negative / NaN here so
    // the user gets a friendly toast before the round-trip.
    const original = {};
    for (const it of (approveTarget.items || [])) original[it.id] = it.quantity;
    const changed = {};
    for (const [k, v] of Object.entries(approveQtyOverrides)) {
      const newQty = +v;
      const oldQty = +original[k];
      // 0 is allowed — it means the approver does NOT approve that line (mam
      // 2026-06-06: "L2 want enter approved qty 0"). Negative is invalid.
      if (!Number.isFinite(newQty) || newQty < 0) {
        toast.error(`Quantity cannot be negative`);
        return;
      }
      if (newQty !== oldQty) changed[k] = newQty;
    }
    // Mam (2026-06-02): collect per-line From Store qty.  Only send
    // entries where mam intends to issue from stock (qty > 0).  Server
    // validates qty ≤ approved AND qty ≤ available office stock before
    // splitting the line + decrementing inventory.
    const storeQty = {};
    let storeLineCount = 0;
    let storeTotalQty = 0;
    for (const it of (approveTarget.items || [])) {
      const fs = +approveFromStore[it.id];
      if (Number.isFinite(fs) && fs > 0) {
        storeQty[it.id] = fs;
        storeLineCount++;
        storeTotalQty += fs;
      }
    }
    // Per-line UNIT changes (mam 2026-06-06): only send units the approver
    // actually changed.
    const unitChanged = {};
    for (const it of (approveTarget.items || [])) {
      const u = approveUnitOverrides[it.id];
      if (u != null && String(u).trim() && String(u).trim() !== String(it.unit || '').trim()) {
        unitChanged[it.id] = String(u).trim();
      }
    }
    setApproveSaving(true);
    try {
      const res = await api.put(`/procurement/indents/${approveTarget.id}`, {
        status: 'approved',
        quantity_overrides: changed,
        store_qty_per_item: storeQty,
        unit_overrides: unitChanged,
        // Margin only matters at the CRM stage of an Extra-Non-Schedule
        // indent; the server ignores it otherwise.
        crm_margin_pct: approveMargin === '' ? undefined : +approveMargin,
      });
      const noteSuffix = res.data?.stock_issue_note ? ` · Store issue ${res.data.stock_issue_note} (${storeTotalQty} pcs)` : '';
      toast.success(
        (Object.keys(changed).length ? `Approved with ${Object.keys(changed).length} qty change(s)` : 'Approved')
        + (storeLineCount > 0 ? `${noteSuffix}` : '')
      );
      // Items issued from store → surface the Store Issue Challan right here
      // so the approver can print/hand it over immediately (mam 2026-06-23).
      if (storeLineCount > 0 && res.data?.store_challan_id) {
        const challanId = res.data.store_challan_id;
        openStoreChallan(challanId);   // best-effort auto-open (may be popup-blocked)
        toast((t) => (
          <span className="flex items-center gap-3">
            <span>🧾 Store Issue Challan <b>{res.data.stock_issue_note}</b> ready</span>
            <button
              type="button"
              onClick={() => { openStoreChallan(challanId); toast.dismiss(t.id); }}
              className="btn btn-primary btn-xs whitespace-nowrap">Print</button>
          </span>
        ), { duration: 10000 });
      }
      // ─── Optimistic update (mam 2026-05-28) ─────────────────────────
      // Server's response tells us which stage just completed:
      //   stage='l1_done' → status becomes 'l1_approved'
      //   else            → status becomes 'approved' (final or legacy single)
      // Patch the local indents array IMMEDIATELY so the row's status,
      // action buttons, and the tile counters all reflect the new state
      // without waiting for the load() roundtrip. Otherwise mam sees the
      // old "PENDING" row for ~1 second and thinks the click did nothing
      // (her exact words: "i need to refresh its not good software indication").
      const newStatus = res.data?.stage === 'l1_done' ? 'l1_approved' : 'approved';
      setIndents(prev => prev.map(it => it.id === approveTarget.id ? ({
        ...it,
        status: newStatus,
        l1_status: newStatus === 'l1_approved' || newStatus === 'approved' ? 'approved' : it.l1_status,
        l1_by: it.l1_by || user?.id,
        l1_at: it.l1_at || new Date().toISOString(),
        l2_status: newStatus === 'approved' && it.approval_policy === 'two_level' ? 'approved' : it.l2_status,
        l2_by: newStatus === 'approved' && it.approval_policy === 'two_level' ? user?.id : it.l2_by,
        l2_at: newStatus === 'approved' && it.approval_policy === 'two_level' ? new Date().toISOString() : it.l2_at,
      }) : it));
      setApproveTarget(null);
      setApproveQtyOverrides({});
      setApproveFromStore({});
      setApproveUnitOverrides({});
      setApproveMargin('');
      load();  // background refresh for canonical state
    } catch (err) {
      toast.error(err.response?.data?.error || 'Approve failed');
    } finally {
      setApproveSaving(false);
    }
  };

  const submitReject = async () => {
    if (!rejectTarget) return;
    const r = String(rejectReason || '').trim();
    if (r.length < 3) { toast.error('Please enter a rejection reason (min 3 chars)'); return; }
    setRejectSaving(true);
    try {
      await api.put(`/procurement/indents/${rejectTarget.id}`, {
        status: 'rejected',
        reason: r,
      });
      toast.success('Indent rejected');
      // Optimistic update — same reasoning as submitApprove above.
      setIndents(prev => prev.map(it => it.id === rejectTarget.id ? ({
        ...it,
        status: 'rejected',
        rejection_reason: r,
      }) : it));
      setRejectTarget(null);
      setRejectReason('');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Reject failed');
    } finally {
      setRejectSaving(false);
    }
  };

  // Open the Upload Vendor PO modal. If an indent is pre-selected (from the
  // Pending section), its items auto-load with finalized rates pre-filled so
  // the uploader can tick which indent lines the Tally PO covers.
  // Terms + Credit Days live on the uploaded Tally PO itself — not in the Sotyn.Headmasters.
  const openCreateVendorPo = (indentId = '') => {
    setForm({
      indent_id: indentId || '',
      vendor_id: '',
      po_number: '',
      po_date: new Date().toISOString().slice(0, 10), // default to today
      expected_receipt_date: '',
      total_amount: '',
      remarks: '',
      po_file: null,
    });
    setIndentItemsForPo([]);
    setPoItemSelection({});
    if (indentId) pickIndentForPo(indentId);
    setModal('vendorpo');
  };
  // When user picks an indent in the modal, load its items + seed selection
  // state with finalized rate/vendor/terms so the grid is ready to review.
  const pickIndentForPo = async (indentId) => {
    setForm(f => ({ ...f, indent_id: indentId }));
    if (!indentId) { setIndentItemsForPo([]); setPoItemSelection({}); return; }
    try {
      const r = await api.get(`/procurement/indents/${indentId}/items-for-po`);
      const items = r.data || [];
      setIndentItemsForPo(items);
      const sel = {};
      for (const it of items) {
        // Default to the PENDING qty = approved − already on (non-cancelled)
        // POs, so we don't re-order what's already covered (mam 2026-06-23).
        const pending = Math.max(0, (+it.quantity || 0) - (+it.ordered_qty || 0));
        sel[it.indent_item_id] = {
          checked: it.rate_status === 'finalized' && pending > 0,
          quantity: pending,
          rate: it.final_rate || 0,
        };
      }
      setPoItemSelection(sel);
      // Pre-fill vendor from the finalized items if they all agree. Terms +
      // credit days live on the Tally PO now, so no need to pre-fill them.
      const vendorNames = [...new Set(items.filter(i => i.final_vendor_name).map(i => i.final_vendor_name))];
      const finalisedSum = items
        .filter(i => i.rate_status === 'finalized' && ((+i.quantity || 0) - (+i.ordered_qty || 0)) > 0)
        .reduce((s, i) => {
          const pending = Math.max(0, (+i.quantity || 0) - (+i.ordered_qty || 0));
          const wpm = +i.weight_per_meter || 0;
          const qty = wpm > 0 ? pending * wpm : pending;  // kg for pipes
          return s + (qty * (+i.final_rate || 0));
        }, 0);
      setForm(f => {
        const next = { ...f };
        if (vendorNames.length === 1) {
          const match = vendors.find(v => v.name?.toLowerCase() === vendorNames[0].toLowerCase());
          if (match) next.vendor_id = match.id;
        }
        // Pre-fill the total if all checked lines have finalized rates
        if (!next.total_amount && finalisedSum > 0) next.total_amount = Math.round(finalisedSum * 100) / 100;
        return next;
      });
    } catch { toast.error('Failed to load indent items'); }
  };
  const togglePoItem = (iiId, patch) => {
    setPoItemSelection(prev => ({ ...prev, [iiId]: { ...prev[iiId], ...patch } }));
  };
  // Pipe lines (weight_per_meter > 0) are quoted/PO'd in KG: the editable Qty
  // stays in METERS, but rate is ₹/kg and amount = (mtr × kg/m) × rate.
  const poLineQtyForAmount = (it, s) => {
    const wpm = +it?.weight_per_meter || 0;
    const q = +s?.quantity || 0;
    return wpm > 0 ? q * wpm : q;
  };
  const poTotal = indentItemsForPo.reduce((sum, it) => {
    const s = poItemSelection[it.indent_item_id] || {};
    if (!s.checked) return sum;
    return sum + poLineQtyForAmount(it, s) * (+s.rate || 0);
  }, 0);

  // Upload a Tally Vendor PO. The backend endpoint is multipart/form-data —
  // metadata fields + an optional file + a JSON-encoded items array for the
  // indent line linking (so "Pending for PO" still works).
  const saveVendorPo = async (e) => {
    e.preventDefault();
    if (!form.vendor_id) return toast.error('Pick a vendor');
    // PO Number is now auto-generated server-side (VPO/YYYY/####) — no
    // manual entry. PO file is also optional; mam's flow is to create
    // the PO inside the Sotyn.Headmasters, not upload a Tally PDF.

    // Build line items. For pipe lines (weight_per_meter > 0) convert the
    // entered METERS to KG so the PO is in kg (qty kg × ₹/kg). The original
    // meters + kg/m ride along for the "show both" display on the print.
    const items = indentItemsForPo
      .map(it => ({ it, v: poItemSelection[it.indent_item_id] || {} }))
      .filter(({ v }) => v.checked && +v.quantity > 0 && +v.rate > 0)
      .map(({ it, v }) => {
        const wpm = +it.weight_per_meter || 0;
        if (wpm > 0) {
          const mtr = +v.quantity;
          return {
            indent_item_id: it.indent_item_id,
            quantity: Math.round(mtr * wpm * 1000) / 1000,  // KG
            rate: +v.rate,                                  // ₹/kg
            weight_per_meter: wpm,
            original_qty_mtr: mtr,
          };
        }
        return { indent_item_id: it.indent_item_id, quantity: +v.quantity, rate: +v.rate };
      });

    const fd = new FormData();
    if (form.po_date) fd.append('po_date', form.po_date);
    if (form.expected_receipt_date) fd.append('expected_receipt_date', form.expected_receipt_date);
    fd.append('vendor_id', form.vendor_id);
    if (form.indent_id) fd.append('indent_id', form.indent_id);
    if (form.total_amount) fd.append('total_amount', form.total_amount);
    if (form.remarks) fd.append('remarks', form.remarks);
    // Freight terms + charge (mam 2026-06-12) — printed on the PDF PO.
    if (form.freight_terms) fd.append('freight_terms', form.freight_terms);
    if (+form.freight_amount > 0) fd.append('freight_amount', form.freight_amount);
    if (items.length) fd.append('items', JSON.stringify(items));
    if (form.po_file) fd.append('file', form.po_file);
    // Internal payment-block fields (mam 2026-05-27). Never printed on PO.
    if (form.payment_block_type) fd.append('payment_block_type', form.payment_block_type);
    if (form.payment_block_amount) fd.append('payment_block_amount', form.payment_block_amount);
    if (form.payment_block_notes) fd.append('payment_block_notes', form.payment_block_notes);

    try {
      const r = await api.post('/procurement/vendor-po', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(`Vendor PO ${r.data.po_number} created (Rs ${r.data.total_amount.toLocaleString()}${r.data.lines ? `, ${r.data.lines} linked items` : ''}) — opening print view`);
      setModal(false); load();
      // mam asked for "after create show me po as pdf" — open the printable
      // PO in a new tab so she can review / print / share immediately. The
      // browser's "Save as PDF" handles the PDF generation.
      if (r.data.id) {
        setTimeout(() => window.open(`/vendor-po/${r.data.id}/print`, '_blank'), 300);
      }
    } catch (err) { toast.error(err.response?.data?.error || 'Upload failed'); }
  };

  // Mark Payment Cleared — internal one-click action on the Vendor PO list
  // (mam 2026-05-27). Flips payment_block_status to 'cleared' + stamps user
  // and timestamp. Server is the source of truth; we just refire the load.
  const markPaymentCleared = async (vpoId) => {
    if (!confirm('Mark advance / old payment as CLEARED?\n\nThis is internal-only — it just unblocks material tracking on our side.')) return;
    try {
      const r = await api.patch(`/procurement/vendor-po/${vpoId}/clear-payment`);
      toast.success(r.data?.already ? 'Already cleared' : 'Payment marked cleared');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // ── Vendor PO 2-level approval (mam 2026-06-19: L1 Nitin Jain, L2 Ankur
  // Kaplesh). Show the Approve/Reject buttons to the pending-level approver,
  // admin, or the COO. The backend enforces the same rule.
  const canApprovePo = (v) => {
    if (v.po_approval !== 'pending_l1' && v.po_approval !== 'pending_l2') return false;
    if (isAdmin()) return true;
    const email = String(user?.email || '').toLowerCase(), uname = String(user?.username || '').toLowerCase();
    if (email.startsWith('coo@') || uname.startsWith('coo@')) return true;
    return String(user?.name || '').trim().toLowerCase() === String(v.po_pending_approver || '').trim().toLowerCase();
  };
  const approvePo = async (v) => {
    try { await api.post(`/procurement/vendor-po/${v.id}/po-approve`); toast.success('PO approved'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Approve failed'); }
  };
  const rejectPo = async (v) => {
    const reason = prompt(`Reject Vendor PO "${v.po_number}"?\n\nReason (required):`);
    if (reason === null) return;
    if (!reason.trim() || reason.trim().length < 3) return toast.error('A rejection reason is required');
    try { await api.post(`/procurement/vendor-po/${v.id}/po-reject`, { reason: reason.trim() }); toast.success('PO rejected'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Reject failed'); }
  };

  // Edit the received qty of an EXISTING purchase bill (mam 2026-06-30): loads the
  // PO lines + current received, saves the edited received qty onto the challan so
  // the Delivery Challan reflects it. Isolated from the create flow.
  const openEditQty = (b) => {
    if (!b.vendor_po_id) return toast.error('This bill has no linked Vendor PO to edit quantities against');
    setEditBillId(b.id);
    setForm(f => ({ ...f, vendor_po_id: b.vendor_po_id, bill_number: b.bill_number }));
    setBillItems(null); setBillRecv({}); setModal('editqty');
    api.get(`/procurement/vendor-po/${b.vendor_po_id}/bill-items`).then(r => {
      setBillItems(r.data);
      const recv = {};
      for (const it of (r.data.items || [])) recv[it.vpi_id] = it.received_qty != null ? it.received_qty : it.ordered_qty;
      setBillRecv(recv);
    }).catch(() => setBillItems({ items: [], ordered_total: 0, any_receipt: false }));
  };
  const saveEditQty = async () => {
    if (!form.vendor_po_id || !billItems?.items?.length) return toast.error('No items to update');
    try {
      await api.put(`/procurement/vendor-po/${form.vendor_po_id}/received-qty`, {
        received_items: billItems.items.map(it => ({
          vendor_po_item_id: it.vpi_id, description: it.description, unit: it.unit,
          ordered_qty: +it.ordered_qty || 0,
          received_qty: (billRecv[it.vpi_id] != null ? +billRecv[it.vpi_id] : (it.received_qty != null ? +it.received_qty : +it.ordered_qty || 0)),
          rate: +it.rate || 0,
        })),
      });
      toast.success('Received qty updated — the challan now shows it');
      setModal(false); setEditBillId(null); setBillItems(null); setBillRecv({}); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Update failed'); }
  };

  // Edit the selling RATE per line on a generated Sales Bill (mam 2026-06-30: "also
  // with rate"). Reads the bill's lines from items_json, lets mam type the rate,
  // saves it back so the Tax Invoice shows amounts and stops being a draft.
  const openEditRate = (d) => {
    let items = [];
    try { items = JSON.parse(d.items_json || '[]'); } catch (_) { items = []; }
    setEditRate({
      dnId: d.id, document_number: d.document_number,
      items: items.map(it => ({
        description: it.description || '', qty: +it.qty || +it.quantity || 0,
        unit: it.unit || '', rate: (+it.rate || 0) || '',
      })),
    });
    setModal('editrate');
  };
  const saveEditRate = async () => {
    if (!editRate?.dnId) return;
    try {
      await api.put(`/procurement/delivery-notes/${editRate.dnId}/rates`, {
        rates: editRate.items.map(it => (it.rate === '' ? 0 : +it.rate || 0)),
      });
      toast.success('Rates saved — the Tax Invoice now shows amounts');
      setModal(false); setEditRate(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to save rates'); }
  };

  const savePurchaseBill = async (e) => {
    e.preventDefault();
    if (!form.bill_file) return toast.error('Bill file is required — upload the vendor bill');
    // Multipart — carries the bill_file alongside the metadata, same
    // pattern as the Vendor PO upload.
    const fd = new FormData();
    if (form.vendor_po_id) fd.append('vendor_po_id', form.vendor_po_id);
    if (form.vendor_id) fd.append('vendor_id', form.vendor_id);
    if (form.bill_number) fd.append('bill_number', form.bill_number);
    if (form.bill_date) fd.append('bill_date', form.bill_date);
    fd.append('amount', form.amount || 0);
    fd.append('gst_amount', form.gst_amount || 0);
    fd.append('total_amount', form.total_amount || 0);
    fd.append('material_status', form.material_status || 'approved');
    // Per-line received qty (mam 2026-06-30) → server writes it onto the auto-
    // created delivery challan so the challan shows RECEIVED, not full ordered qty.
    if (billItems?.items?.length) {
      fd.append('received_items', JSON.stringify(billItems.items.map(it => ({
        vendor_po_item_id: it.vpi_id,
        description: it.description, unit: it.unit,
        ordered_qty: +it.ordered_qty || 0,
        received_qty: (billRecv[it.vpi_id] != null ? +billRecv[it.vpi_id]
          : (it.received_qty != null ? +it.received_qty : +it.ordered_qty || 0)),
        rate: +it.rate || 0,
      }))));
    }
    if (form.bill_file) fd.append('file', form.bill_file);
    try {
      const r = await api.post('/procurement/purchase-bills', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const ad = r.data?.auto_debit;
      const asd = r.data?.auto_short_debit;
      const ard = r.data?.auto_reject_debit;
      toast.success('Purchase bill added');
      if (ard) {
        toast.success(`Material REJECTED · auto debit ${ard.dn_number} for ₹${Math.round(ard.amount).toLocaleString('en-IN')}`, { duration: 6000 });
      }
      if (ad) {
        toast.success(`Auto debit ${ad.dn_number} · ₹${Math.round(ad.amount).toLocaleString('en-IN')} (billed over PO) — deducted from payable`, { duration: 6000 });
      }
      if (asd) {
        toast.success(`Auto short-supply debit ${asd.dn_number} · ₹${Math.round(asd.amount).toLocaleString('en-IN')}${r.data?.vendor_mailed ? ' · vendor emailed for the shortfall' : ''}`, { duration: 6000 });
      }
      setModal(false); setBillItems(null); setBillRecv({}); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const saveDeliveryNote = async (e) => {
    e.preventDefault();
    if (!form.document_type) return toast.error('Pick Sales Bill or Delivery Note');
    // document_number is now auto-generated server-side when blank — no
    // user-side required check. Mam can still type one to override.
    // File is OPTIONAL now — the Sotyn.Headmasters generates the document; the signed
    // copy is uploaded later via Mark Received. Mam: "like po I want from
    // erp create sales bill or dispatch which i give you format".
    const fd = new FormData();
    if (form.vendor_po_id) fd.append('vendor_po_id', form.vendor_po_id);
    if (form.delivery_date) fd.append('delivery_date', form.delivery_date);
    if (form.document_type) fd.append('document_type', form.document_type);
    // Only append a document_number if the user explicitly typed one
    // (mam can override the auto-generated value). When blank, the server
    // generates INV/YYYY/#### or DC/YYYY/#### automatically.
    if (form.document_number && form.document_number.trim()) fd.append('document_number', form.document_number.trim());
    if (form.notes) fd.append('notes', form.notes);
    // Document-type-specific fields driven by the conditional cards.
    if (form.document_type === 'challan') {
      ['vehicle_no', 'driver_name', 'driver_mobile', 'lr_challan_no', 'total_packages']
        .forEach(k => { if (form[k] != null && form[k] !== '') fd.append(k, form[k]); });
    } else {
      ['place_of_supply', 'state_code', 'e_way_bill_no', 'vehicle_no',
       'cgst_pct', 'sgst_pct', 'igst_pct', 'freight_amount', 'round_off_amount']
        .forEach(k => { if (form[k] != null && form[k] !== '') fd.append(k, form[k]); });
      if (form.reverse_charge) fd.append('reverse_charge', '1');
    }
    // Per-line-item overrides — only ship rows the user kept (include=true).
    // The server stores this in items_json and the print endpoint uses it
    // in preference to po_items / vendor_po_items. Each row carries qty,
    // rate and disc% so we can rebuild the taxable amount server-side.
    const includedItems = (dispatchItems || []).filter(it => it.include !== false);
    if (includedItems.length) {
      const payload = includedItems.map(it => {
        const qty = +it.quantity || 0;
        const rate = +it.rate || 0;
        const discPct = +it.disc_pct || 0;
        return {
          description: it.description || '',
          hsn: it.hsn || '',
          unit: it.unit || '',
          quantity: qty,
          rate,
          disc_pct: discPct,
          amount: +(qty * rate * (1 - discPct / 100)).toFixed(2),
          item_code: it.item_code || '',
          specification: it.specification || '',
          size: it.size || '',
          item_name: it.item_name || '',
        };
      });
      fd.append('items', JSON.stringify(payload));
      // Send computed subtotal + grand-total to the row too so the list
      // view can show the invoice value without re-joining items_json.
      const subtotal = payload.reduce((s, it) => s + it.amount, 0);
      const cgst = subtotal * (+form.cgst_pct || 0) / 100;
      const sgst = subtotal * (+form.sgst_pct || 0) / 100;
      const igst = subtotal * (+form.igst_pct || 0) / 100;
      const freight = +form.freight_amount || 0;
      const roundOff = +form.round_off_amount || 0;
      const grandTotal = subtotal + cgst + sgst + igst + freight + roundOff;
      fd.append('subtotal_amount', subtotal.toFixed(2));
      fd.append('grand_total_amount', grandTotal.toFixed(2));
    }
    if (form.dispatch_file) fd.append('file', form.dispatch_file);
    // Open the print tab NOW, synchronously, while we're still inside the
    // click gesture. If we wait until after the awaits below, the popup
    // blocker silently eats window.open and nothing appears — that was
    // mam's "not showing pdf sales bill". We park a blank tab here and
    // navigate it to the bill once it's generated; the bill's own page
    // auto-fires the print → Save-as-PDF dialog.
    const printWin = window.open('', '_blank');
    try {
      const r = await api.post('/procurement/delivery-notes', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const which = form.document_type === 'challan' ? 'Delivery Challan' : 'Sales Bill';
      // Show the auto-generated number in the toast so mam knows what
      // INV/DC number was assigned.
      const generatedNo = r.data?.document_number;
      toast.success(generatedNo ? `${which} ${generatedNo} created` : `${which} created`);
      setModal(false); load();
      // Auto-open the generated document in the parked tab so mam can print
      // immediately, matching the "create like a PO" feel she asked for.
      if (r.data?.id) {
        try {
          // Pull as arraybuffer + tag the blob as UTF-8 so ₹ / em-dash
          // don't render as mojibake when opened via blob: URL.
          const printRes = await api.get(`/procurement/delivery-notes/${r.data.id}/print`, { responseType: 'arraybuffer' });
          const blob = new Blob([printRes.data], { type: 'text/html;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          if (printWin) printWin.location = url; else window.open(url, '_blank');
        } catch (_) { if (printWin) printWin.close(); /* user can still click 🖨 Print in the list */ }
      } else if (printWin) { printWin.close(); }
    } catch (err) { if (printWin) printWin.close(); toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Mark a dispatch row as "Received by <name> on <date>" + attach the
  // stamped/signed receipt photo. Multipart so the file rides along.
  const markReceived = async (e) => {
    e.preventDefault();
    if (!form.received_by_name || !form.received_by_name.trim()) return toast.error('Receiver name is required');
    if (!form.receipt_file) return toast.error('Receipt proof photo is required — attach the stamped + signed document');

    // Receiving a Ready-to-Dispatch PO directly (mam 2026-05-30: "show
    // ready POs here + upload receiving"). No dispatch record exists yet,
    // so create a Challan dispatch first with an AUTO-generated DC number
    // (sales_bill_pending=1 — office adds the formal Sales Bill later),
    // then mark THAT received with the uploaded proof.
    let receiveId = form.receive_id;
    if (!receiveId && form.receive_po_id) {
      try {
        const fd0 = new FormData();
        fd0.append('vendor_po_id', form.receive_po_id);
        fd0.append('document_type', 'challan');                 // blank doc# → server auto-generates DC/YYYY/####
        fd0.append('delivery_date', new Date().toISOString().slice(0, 10));
        fd0.append('sales_bill_pending', '1');
        const dn = await api.post('/procurement/delivery-notes', fd0, { headers: { 'Content-Type': 'multipart/form-data' } });
        receiveId = dn.data?.id;
      } catch (err) { return toast.error(err.response?.data?.error || 'Could not create dispatch record'); }
    }
    if (!receiveId) return toast.error('No dispatch to receive against');

    const fd = new FormData();
    fd.append('received_by_name', form.received_by_name);
    if (form.received_at) fd.append('received_at', form.received_at);
    if (form.receipt_file) fd.append('file', form.receipt_file);
    // Optional inventory hook — when mam picks a warehouse, the linked
    // vendor PO's items auto-land as stock IN at that warehouse on the
    // server side. Skipped silently if no warehouse selected.
    if (form.warehouse_id) fd.append('warehouse_id', form.warehouse_id);
    // sales_bill_pending — mam (2026-05-25): flag at receipt time so the
    // dispatch shows the amber "📋 SB PENDING" chip until SB is uploaded.
    if (form.sales_bill_pending) fd.append('sales_bill_pending', '1');
    // Per-line received qty + short reason (mam 2026-06-02).  Server
    // persists this to delivery_notes.items_json AND uses received_qty
    // (not ordered) for the stock-IN amount, so a 10-ordered/9-received
    // PO only adds 9 to inventory.  Drop empty manual rows (no
    // description AND no qty) so the seeded blank row doesn't pollute
    // the payload if mam didn't fill it in.
    if (Array.isArray(receiveItems) && receiveItems.length > 0) {
      const filtered = receiveItems.filter(it => {
        const hasText = (it.description || '').trim().length > 0;
        const hasQty  = (+it.ordered_qty > 0) || (+it.received_qty > 0);
        return hasText || hasQty;
      });
      if (filtered.length > 0) {
        const payload = filtered.map(it => ({
          vendor_po_item_id: it.vpi_id,
          ordered_qty:       +it.ordered_qty || 0,
          received_qty:      +it.received_qty || 0,
          short_reason:      it.short_reason || null,
          description:       it.description || null,
        }));
        fd.append('items_received', JSON.stringify(payload));
      }
    }
    try {
      const r = await api.patch(`/procurement/delivery-notes/${receiveId}/receive`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const ins = r.data?.stock_ins || 0;
      // Count short receipts so mam sees them in the toast — useful audit cue.
      const shortLines = receiveItems.filter(it => +it.received_qty < +it.ordered_qty).length;
      const shortNote = shortLines > 0 ? ` · ${shortLines} short` : '';
      toast.success(ins > 0
        ? `Marked as received · ${ins} item${ins === 1 ? '' : 's'} added to stock${shortNote}`
        : `Marked as received${shortNote}`);
      const ad = r.data?.auto_debit;
      if (ad) toast.success(`Auto short-supply debit ${ad.dn_number} for ₹${Math.round(ad.amount).toLocaleString('en-IN')} raised — see Debit Notes`, { duration: 6000 });
      const asb = r.data?.auto_sales_bill;
      if (asb) toast.success(`Sales Bill ${asb.document_number} auto-generated${asb.is_draft ? ' as DRAFT — fill client GSTIN / rates' : ''}`, { duration: 7000 });
      setModal(false);
      setReceiveItems([]);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Order matches the flow: raise an indent first, purchase team collects
  // 3 vendor quotes + finalizes per item, then turns it into a vendor PO,
  // books the purchase bill, and finally the goods are dispatched to site.
  // Tabs are filtered below by the user's permissions — site engineers
  // with only `procurement.create` see just "Raise Indent"; purchase team
  // with `procurement.approve` see everything.
  const allTabs = [
    { id: 'indents', label: 'Raise Indent', show: canRaiseIndent },
    { id: 'rates', label: 'Vendor Rates', show: canPurchaseOps },
    { id: 'vendorpo', label: 'Vendor PO', show: canPurchaseOps },
    // Payment — dedicated tab between Vendor PO and Purchase Bills (mam
    // 2026-05-27): Accounts works here to unblock advance / old-payment
    // POs; once cleared, Purchase team picks them up in the next tab.
    { id: 'payment', label: 'Payment', show: canPurchaseOps },
    { id: 'bills', label: 'Purchase Bills', show: canPurchaseOps },
    { id: 'delivery', label: 'Dispatch & Receiving', show: canPurchaseOps },
    { id: 'debitnotes', label: 'Debit Notes', show: canPurchaseOps },
    { id: 'pipeline', label: 'PO Pipeline', show: canPurchaseOps },
    // Per-record RACI / SLA "Responsible" board for the indent→dispatch flow,
    // right where the purchase team works (mam 2026-06-29: "where is RACI?").
    { id: 'responsible', label: '⚙ Responsible', show: canPurchaseOps },
  ];
  const tabs = allTabs.filter(t => t.show);

  // --- Vendor Rates (Step 1 + 2) helpers ---
  // Patch a single field on an item's rate row and save to server. Keeps the
  // Merge indent items by (indent_id, item_master_id) so the same sub-item
  // appearing under multiple BOQs in one indent shows as a SINGLE row with
  // combined qty. mam's example: CHECK NUT appears under both MS PIPE and
  // FIRE BUCKET BOQs in IND-0007 — purchase team should fill rate ONCE,
  // not twice. Free-text manual entries (no item_master_id) keep their own
  // row since we can't safely merge them.
  const mergedRates = useMemo(() => {
    const groups = new Map();
    for (const r of itemRates) {
      const groupKey = r.item_master_id
        ? `${r.indent_id}__M${r.item_master_id}`
        : `__solo_${r.indent_item_id}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          ...r,
          indent_item_ids: [r.indent_item_id],
          rate_ids: r.rate_id ? [r.rate_id] : [],
          qty: +r.qty || 0,
        });
      } else {
        const m = groups.get(groupKey);
        m.indent_item_ids.push(r.indent_item_id);
        if (r.rate_id) m.rate_ids.push(r.rate_id);
        m.qty += +r.qty || 0;
        // Status: 'finalized' wins, else 'quoted', else 'pending'
        if (r.rate_status === 'finalized') m.rate_status = 'finalized';
        else if (r.rate_status === 'quoted' && m.rate_status !== 'finalized') m.rate_status = 'quoted';
        // Vendor data: keep the first non-empty value across the merged rows
        for (const n of [1, 2, 3]) {
          if (!m[`vendor${n}_name`] && r[`vendor${n}_name`]) {
            m[`vendor${n}_name`] = r[`vendor${n}_name`];
            m[`vendor${n}_rate`] = r[`vendor${n}_rate`];
            m[`vendor${n}_terms`] = r[`vendor${n}_terms`];
            m[`vendor${n}_credit_days`] = r[`vendor${n}_credit_days`];
          }
        }
        if (r.final_rate) {
          m.final_rate = r.final_rate;
          m.final_vendor_name = r.final_vendor_name;
          m.final_terms = r.final_terms;
          m.final_credit_days = r.final_credit_days;
        }
        // Suggestion columns — keep first non-empty across the merged rows.
        if (!m.pp_rate && r.pp_rate) m.pp_rate = r.pp_rate;
        if (!m.marketing_rate && r.marketing_rate) m.marketing_rate = r.marketing_rate;
      }
    }
    return [...groups.values()];
  }, [itemRates]);

  // Apply a vendor / rate / terms patch to ALL underlying indent_items in
  // the merged group so the DB stays consistent across the rows that share
  // the same item_master in the same indent. Awaiting each call keeps the
  // UI's optimistic update logic intact.
  const updateMergedRate = async (mergedRow, patch) => {
    for (const iid of mergedRow.indent_item_ids) {
      await updateItemRate(iid, patch);
    }
  };

  // AI "marketing rate" — on-demand per row (mam 2026-06-19). Suggestion only;
  // saved to marketing_rate, never the 3 vendor rates.
  const [aiBusy, setAiBusy] = useState({});
  const aiSuggestRate = async (mergedRow) => {
    const iiId = mergedRow.indent_item_ids?.[0];
    if (!iiId) return;
    setAiBusy(b => ({ ...b, [iiId]: true }));
    try {
      const r = await api.post('/procurement/item-rates/ai-suggest', { indent_item_id: iiId });
      toast.success(`AI market rate: Rs ${(+r.data.marketing_rate).toLocaleString('en-IN')}`);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'AI suggest failed'); }
    finally { setAiBusy(b => ({ ...b, [iiId]: false })); }
  };

  // Auto-fill the AI market rate for every item missing one (mam 2026-06-19:
  // "don't need to click, automatically rate here"). THROTTLED: one small batch
  // every ~30s (with 429 back-off) so it stays well under the org's 10k input-
  // tokens/min limit and leaves room for the Ask Sotyn.Headmasters chat. Persisted → an item
  // already done is never recomputed. Self-paced scheduler, set up once per
  // visit to the Vendor Rates tab; reads fresh data via a ref.
  const aiAutoRef = useRef(new Set());     // ids already requested this session
  const aiAutoErrRef = useRef(false);
  const aiAutoTimer = useRef(null);
  const mergedRatesRef = useRef(mergedRates);
  mergedRatesRef.current = mergedRates;
  useEffect(() => {
    if (tab !== 'rates') return;
    let cancelled = false;
    const refreshRates = () => api.get('/procurement/item-rates').then(r => setItemRates(r.data || [])).catch(() => {});
    const runBatch = async () => {
      if (cancelled) return;
      const missing = mergedRatesRef.current
        .filter(r => !(+r.marketing_rate > 0))
        .map(r => r.indent_item_ids?.[0])
        .filter(id => id && !aiAutoRef.current.has(id));
      if (!missing.length) { aiAutoTimer.current = null; return; }   // all done → stop
      const batch = missing.slice(0, 15);
      batch.forEach(id => aiAutoRef.current.add(id));
      let wait = 30000;                                              // ~2 batches/min — gentle on the token limit
      try {
        await api.post('/procurement/item-rates/ai-suggest-bulk', { indent_item_ids: batch });
        if (!cancelled) await refreshRates();
      } catch (err) {
        if (err?.response?.status === 429) {
          batch.forEach(id => aiAutoRef.current.delete(id));         // not done — retry later
          wait = 60000;                                             // back off on rate limit
        } else if (!aiAutoErrRef.current) {
          aiAutoErrRef.current = true; toast.error(err.response?.data?.error || 'AI auto-rate failed');
        }
      }
      if (!cancelled) aiAutoTimer.current = setTimeout(runBatch, wait);
    };
    aiAutoTimer.current = setTimeout(runBatch, 2000);                // start a moment after the tab opens
    return () => { cancelled = true; if (aiAutoTimer.current) { clearTimeout(aiAutoTimer.current); aiAutoTimer.current = null; } };
  }, [tab]);

  // Admin-only: clear ALL the vendor quotes on a merged rate row so the row
  // returns to "Pending" status. Useful when mam wants to re-quote from
  // scratch (wrong rates entered, vendor list changed, etc.). Loops over
  // every rate_id in the merged group.
  const deleteMergedRate = async (mergedRow) => {
    if (!mergedRow.rate_ids?.length) {
      toast('Nothing to clear — no rates entered yet');
      return;
    }
    const label = [mergedRow.master_name || mergedRow.description, mergedRow.size, mergedRow.specification].filter(Boolean).join(' / ');
    if (!confirm(`Clear all vendor quotes for "${label}"?\nThe row will return to Pending.`)) return;
    try {
      for (const rid of mergedRow.rate_ids) {
        await api.delete(`/procurement/item-rates/${rid}`);
      }
      toast.success('Quotes cleared');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Clear failed'); }
  };

  // UI snappy by updating local state optimistically.
  const updateItemRate = async (indentItemId, patch) => {
    // Optimistically merge the patch, then derive rate_status locally the same
    // way the backend does (quoted once any vendor has rate > 0, else pending).
    // Without this, the badge stays "pending" and the Finalize button stays
    // disabled until a full page reload.
    setItemRates(prev => prev.map(r => {
      if (r.indent_item_id !== indentItemId) return r;
      const merged = { ...r, ...patch };
      const anyRate = [merged.vendor1_rate, merged.vendor2_rate, merged.vendor3_rate].some(v => Number(v) > 0);
      if (merged.rate_status !== 'finalized') merged.rate_status = anyRate ? 'quoted' : 'pending';
      return merged;
    }));
    try {
      const { data } = await api.post('/procurement/item-rates', { indent_item_id: indentItemId, ...patch });
      // Capture rate_id on the first save so Finalize can target the right row.
      if (data?.id) {
        setItemRates(prev => prev.map(r => r.indent_item_id === indentItemId && !r.rate_id ? { ...r, rate_id: data.id } : r));
      }
    } catch (err) { toast.error(err.response?.data?.error || 'Save failed'); }
  };
  const openFinalize = (row) => {
    // Default to the lowest non-zero vendor rate (best offer) when opening
    const quotes = [
      { name: row.vendor1_name, rate: row.vendor1_rate, terms: row.vendor1_terms, days: row.vendor1_credit_days },
      { name: row.vendor2_name, rate: row.vendor2_rate, terms: row.vendor2_terms, days: row.vendor2_credit_days },
      { name: row.vendor3_name, rate: row.vendor3_rate, terms: row.vendor3_terms, days: row.vendor3_credit_days },
    ].filter(q => q.name && q.rate > 0).sort((a, b) => a.rate - b.rate);
    const best = quotes[0] || {};
    setFinalForm({
      rate_id: row.rate_id, row,
      final_rate: row.final_rate || best.rate || 0,
      final_vendor_name: row.final_vendor_name || best.name || '',
      final_terms: row.final_terms || best.terms || '',
      final_credit_days: row.final_credit_days || best.days || 0,
    });
    setFinalModal(row);
  };
  const submitFinalize = async (e) => {
    e.preventDefault();
    // A merged row may carry multiple rate_ids (one per underlying indent_item
    // sharing the same item_master in the same indent). Finalize ALL of them
    // so the merged display stays consistent — every backing row picks the
    // same vendor + rate + terms.
    const rateIds = finalForm.row?.rate_ids?.length ? finalForm.row.rate_ids : [finalForm.rate_id].filter(Boolean);
    if (!rateIds.length) return toast.error('Enter a vendor rate first');
    try {
      for (const rid of rateIds) {
        await api.post(`/procurement/item-rates/${rid}/finalize`, finalForm);
      }
      toast.success('Rate finalized');
      setFinalModal(null); setFinalForm({});
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="space-y-3">
      <div className="sticky-toolbar">
        <div className="flex gap-2 flex-wrap items-center justify-between">
          <div className="flex gap-2 flex-wrap">{tabs.map(t => {
            // Urgent-payment badge on the Payment tab — Accounts can see
            // at a glance whether anything needs clearing without clicking
            // (mam 2026-05-27 workflow gate).
            const urgentCount = t.id === 'payment'
              ? (vendorPos || []).filter(po => !po.cancelled && po.payment_block_status === 'pending').length
              : 0;
            return (
              <button key={t.id} onClick={() => setTab(t.id)} className={`btn relative !px-3 !py-1.5 ${tab === t.id ? 'btn-primary' : 'btn-secondary'}`}>
                {t.label}
                {urgentCount > 0 && (
                  <span className="ml-2 inline-flex items-center justify-center text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-600 text-white border border-red-700"
                        title={`${urgentCount} PO${urgentCount === 1 ? '' : 's'} blocked on payment`}>
                    🚨 {urgentCount}
                  </span>
                )}
              </button>
            );
          })}</div>
          {/* One Export button — exports current tab's data */}
          <button onClick={() => {
            if (tab === 'indents')    exportCsv('indents',         ['Indent No','Date','Site','Raised By','Status','Items','Budget','Delivery Bill','Delivery %'], indents.map(i => [i.indent_number, i.indent_date, i.site_name, i.raised_by_name, i.status, (i.items||[]).length, Math.round(i.budget_amount||0), Math.round(i.delivery_bill_amount||0), i.delivery_pct||0]));
            if (tab === 'pos')        exportCsv('vendor-pos',      ['PO Number','PO Date','Vendor','Amount','Status'], vendorPos.map(v => [v.po_number, v.po_date, v.vendor_name, v.total_amount, v.status]));
            if (tab === 'bills')      exportCsv('purchase-bills',  ['Bill No','Vendor','Date','Amount','GST','Total','Payment'], purchaseBills.map(b => [b.bill_number, b.vendor_name, b.bill_date, b.amount, b.gst_amount, b.total_amount, b.payment_status]));
            if (tab === 'dispatch')   exportCsv('dispatch',        ['ID','Type','Doc No','PO','Site','Indent By','Date','Received By','Received On','Status'], deliveryNotes.map(d => [d.id, d.document_type, d.document_number, d.vendor_po_number || (d.source === 'store' ? 'From Store' : ''), d.site_name, d.raised_by_name, d.delivery_date, d.received_by_name, d.received_at ? new Date(d.received_at).toLocaleDateString() : '', d.status]));
            if (tab === 'rates')      exportCsv('vendor-rates',    ['Item','Vendor 1','Rate 1','Vendor 2','Rate 2','Vendor 3','Rate 3','Final'], itemRates.map(r => [r.item_description, r.vendor1_name, r.vendor1_rate, r.vendor2_name, r.vendor2_rate, r.vendor3_name, r.vendor3_rate, r.final_rate]));
          }} className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload /> Export Excel</button>
        </div>
      </div>

      {tab === 'responsible' && <ResponsibilityTab module="indent_to_dispatch" title="Indent to Dispatch" />}

      {tab === 'indents' && (() => {
        // ── Filtering / search ─────────────────────────────────────────
        // mam (2026-05-25): filter by date range + status + search by
        // indent id / site.  All client-side off the already-loaded
        // indents array — no extra API calls.
        //
        // Two scopes:
        //   kpiScope        — indents matching date+search ONLY (no status
        //                     filter, so KPI tiles can still show all 5
        //                     status breakdowns within the date range).
        //   filteredIndents — kpiScope further filtered by status (drives
        //                     the table + pagination).
        // Mam (2026-05-25 follow-up): "data filter also from to according
        // to that amounts count change" — tiles now respect from/to + search.
        const q = indSearch.trim().toLowerCase();
        const matchesDateAndSearch = (i) => {
          if (indFilterFrom) {
            const d = (i.created_at || i.indent_date || '').slice(0, 10);
            if (d && d < indFilterFrom) return false;
          }
          if (indFilterTo) {
            const d = (i.created_at || i.indent_date || '').slice(0, 10);
            if (d && d > indFilterTo) return false;
          }
          if (q) {
            const hay = `${i.indent_number || ''} ${i.site_name || ''} ${i.client_name || ''} ${i.raised_by_name || ''} ${i.created_by_name || ''} ${(i.indent_category || 'material').replace(/_/g, ' ')}`.toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        };
        const kpiScope = indents.filter(matchesDateAndSearch);
        const filteredIndents = indents.filter(i => {
          // 'submitted' (Pending L1) ALSO matches crm_approved — after the CRM
          // step an EXTRA-NON indent still awaits L1, so it belongs in the same
          // bucket (server treats crm_approved like submitted for L1). It was
          // hidden from the Pending-L1 filter before (mam 2026-07-04).
          if (indFilterStatus !== 'all') {
            const inBucket = i.status === indFilterStatus
              || (indFilterStatus === 'submitted' && i.status === 'crm_approved');
            if (!inBucket) return false;
          }
          if (indFilterCategory !== 'all' && (i.indent_category || 'material') !== indFilterCategory) return false;
          if (indFilterFrom) {
            const d = (i.created_at || i.indent_date || '').slice(0, 10);
            if (d && d < indFilterFrom) return false;
          }
          if (indFilterTo) {
            const d = (i.created_at || i.indent_date || '').slice(0, 10);
            if (d && d > indFilterTo) return false;
          }
          if (q) {
            const hay = `${i.indent_number || ''} ${i.site_name || ''} ${i.client_name || ''} ${i.raised_by_name || ''} ${i.created_by_name || ''}`.toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        });
        const indPg = usePagination(filteredIndents, indPerPage, indPage, setIndPage);
        return (
        <>
          <div className="flex justify-between items-center flex-wrap gap-2">
            <h3 className="text-sm font-semibold">Raise Indent</h3>
            {(() => {
              const raiseClosed = !!raiseWindow && !raiseWindow.allowed;
              return (
                <button
                  onClick={() => { setEditingIndentId(null); setForm({ notes: '', site_name: '', raised_by_name: user?.name || '', indent_category: 'material' }); setIndentItems([{ ...EMPTY_ITEM }]); setBoqItems([]); setModal('indent'); }}
                  disabled={raiseClosed}
                  title={raiseClosed ? 'Indents can be raised only on Saturday.' : ''}
                  className={`btn flex items-center gap-2 ${raiseClosed ? 'opacity-50 cursor-not-allowed bg-gray-300 text-gray-600' : 'btn-primary'}`}>
                  <FiPlus /> Raise Indent
                </button>
              );
            })()}
          </div>

          {/* Raise window banner (mam 2026-06-16): indents only on Saturday;
              admin can open an emergency one-day window for everyone. */}
          {raiseWindow && (
            raiseWindow.allowed ? (
              <div className="text-[12px] rounded border px-3 py-2 flex items-center justify-between gap-2 bg-emerald-50 border-emerald-200 text-emerald-800">
                <span>
                  {raiseWindow.isSaturday
                    ? '✅ Saturday — indent raising is open for everyone.'
                    : '⚡ Emergency raising is OPEN for today (enabled by admin).'}
                </span>
                {isAdmin() && !raiseWindow.isSaturday && (
                  <button onClick={toggleIndentEmergency} className="text-[11px] font-semibold px-2 py-1 rounded border border-emerald-300 hover:bg-emerald-100 whitespace-nowrap">
                    Turn off emergency
                  </button>
                )}
              </div>
            ) : (
              <div className="text-[12px] rounded border px-3 py-2 flex items-center justify-between gap-2 bg-amber-50 border-amber-200 text-amber-800">
                <span>🔒 Indents can be raised only on <b>Saturday</b>.{isAdmin() ? ' For a weekday emergency, open today below.' : ''}</span>
                {isAdmin() && (
                  <button onClick={toggleIndentEmergency} className="text-[11px] font-semibold px-2 py-1 rounded border border-amber-400 bg-amber-100 hover:bg-amber-200 whitespace-nowrap">
                    ⚡ Enable emergency raising for today
                  </button>
                )}
              </div>
            )
          )}

          {/* KPI strip — mam (2026-05-25): "show also dashbaord total indent .
              approved indent count with amount , reject count with amount".
              Pure client-side rollup from kpiScope (date+search filtered).
              Each tile colour-coded to the matching status badge so eyes
              can scan: gray=all, amber=pending, emerald=approved,
              red=rejected, blue=PO sent.
              Mam (2026-05-25 follow-up): "data filter also from to according
              to that amounts count change" — tiles now react to date+search
              filters so the totals always match what's in the table below. */}
          {(() => {
            const sum = (arr) => arr.reduce((s, i) => s + (+i.budget_amount || 0), 0);
            const byStatus = (s) => kpiScope.filter(i => i.status === s);
            // Pending L1 = 'submitted' + 'crm_approved'. After the CRM step an
            // EXTRA-NON indent sits in crm_approved but still awaits L1 sign-off
            // (server treats it exactly like 'submitted' for L1), so it must
            // count here — it was silently missing before (mam 2026-07-04).
            const submitted   = kpiScope.filter(i => i.status === 'submitted' || i.status === 'crm_approved');
            const l1Approved  = byStatus('l1_approved');   // Pending L2 (two-level only, mam 2026-05-26)
            const approved    = byStatus('approved');
            const rejected    = byStatus('rejected');
            const poSent      = byStatus('po_sent');
            const filterActive = !!(indFilterFrom || indFilterTo || indSearch.trim());
            // Billable booked once an indent clears approval (mam 2026-06-16):
            // total BOQ sale value of every indent that has PASSED approval —
            // approved or anything beyond it (PO sent / dispatched / received).
            // Sums the same billable_amount shown in the list's Billable column.
            const billableSum = (arr) => arr.reduce((s, i) => s + (+i.billable_amount || 0), 0);
            const postApproval = kpiScope.filter(i => ['approved', 'po_sent', 'dispatched', 'received'].includes(i.status));
            // PO Generate + Payment Required (mam 2026-06-12) — sourced from
            // the Vendor PO list, not the indents, so the count matches the
            // "View by PO" tab exactly.  Payment Required = POs still pending
            // an advance / old-dues clearance (same filter as the Payment tab).
            const poGenCount  = (vendorPos || []).length;
            const poGenAmount = (vendorPos || []).reduce((s, p) => s + (+p.total_amount || 0), 0);
            const urgentPos   = (vendorPos || []).filter(p => !p.cancelled && p.payment_block_status === 'pending');
            const payReqCount = urgentPos.length;
            const payReqAmount = urgentPos.reduce((s, p) => s + (+p.payment_block_amount || 0), 0);
            // Clicking a tile sets the status filter to that bucket so mam
            // can drill from the dashboard view into the matching rows
            // without typing in the toolbar.
            // statusKey drives the indent-status filter on click; pass an
            // onClick override instead (e.g. for tiles that jump to another
            // tab like PO Generate / Payment Required).
            const tile = (label, count, amount, color, statusKey, onClick) => {
              const isActive = !!statusKey && indFilterStatus === statusKey;
              const handle = onClick || (() => { setIndFilterStatus(statusKey); setIndPage(1); });
              return (
                <button
                  type="button"
                  onClick={handle}
                  className={`min-w-0 rounded-lg border ${color.border} ${color.bg} px-2.5 py-1.5 text-left transition hover:shadow-sm ${isActive ? 'ring-2 ring-offset-1 ' + color.ring : ''}`}>
                  <div className={`text-[10px] font-semibold uppercase tracking-wide ${color.text} truncate`}>{label}</div>
                  <div className="flex items-baseline justify-between mt-0.5 gap-1 flex-wrap">
                    <div className={`text-lg font-bold leading-none ${color.text}`}>{count}</div>
                    <div className={`text-[11px] font-medium ${color.text} opacity-80 whitespace-nowrap`}>
                      {amount > 0 ? `₹${Math.round(amount).toLocaleString('en-IN')}` : '—'}
                    </div>
                  </div>
                </button>
              );
            };
            return (
              <>
                {filterActive && (
                  <div className="text-[11px] text-blue-700 bg-blue-50 border border-blue-200 rounded px-3 py-1.5 flex items-center gap-2">
                    📊 Showing totals for the current filter ({kpiScope.length} of {indents.length} indents).
                  </div>
                )}
                {/* 7 KPI tiles auto-fit one row on large screens (mam
                    2026-06-12): 2-up on phones, 4-up on tablets, 7-up on
                    desktop.  PO Generate + Payment Required jump to their
                    own tabs on click instead of filtering the indent list. */}
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
                  {tile('Total Indents',     kpiScope.length,   sum(kpiScope),   { border: 'border-gray-300',    bg: 'bg-gray-50',     text: 'text-gray-700',    ring: 'ring-gray-400'    }, 'all')}
                  {tile('Pending L1',        submitted.length,  sum(submitted),  { border: 'border-amber-300',   bg: 'bg-amber-50',    text: 'text-amber-700',   ring: 'ring-amber-400'   }, 'submitted')}
                  {tile('Pending L2',        l1Approved.length, sum(l1Approved), { border: 'border-purple-300',  bg: 'bg-purple-50',   text: 'text-purple-700',  ring: 'ring-purple-400'  }, 'l1_approved')}
                  {tile('Approved',          approved.length,   sum(approved),   { border: 'border-emerald-300', bg: 'bg-emerald-50',  text: 'text-emerald-700', ring: 'ring-emerald-400' }, 'approved')}
                  {/* Billable · Approved (mam 2026-06-16): BOQ sale value booked
                      once indents clear approval. Clicking jumps to the Approved
                      bucket — closest single-status filter to "post-approval". */}
                  {tile('Billable · Approved', postApproval.length, billableSum(postApproval), { border: 'border-indigo-300', bg: 'bg-indigo-50', text: 'text-indigo-700', ring: 'ring-indigo-400' }, 'approved')}
                  {tile('Rejected',          rejected.length,   sum(rejected),   { border: 'border-red-300',     bg: 'bg-red-50',      text: 'text-red-700',     ring: 'ring-red-400'     }, 'rejected')}
                  {tile('PO Generate',       poGenCount,        poGenAmount,     { border: 'border-blue-300',    bg: 'bg-blue-50',     text: 'text-blue-700',    ring: 'ring-blue-400'    }, null, () => { setTab('vendorpo'); setVpoSubTab('list'); })}
                  {tile('Payment Required',  payReqCount,       payReqAmount,    { border: 'border-rose-300',    bg: 'bg-rose-50',     text: 'text-rose-700',    ring: 'ring-rose-400'    }, null, () => setTab('payment'))}
                </div>
              </>
            );
          })()}

          {/* Filter toolbar — date range + status + search (mam 2026-05-25) */}
          <div className="card p-3 flex flex-wrap items-end gap-2 text-xs">
            <div className="flex-1 min-w-[180px]">
              <label className="label text-[10px] mb-0.5">Search · indent no / site / raised by</label>
              <input className="input text-xs" placeholder="e.g. IND-0070 or Jeewan Mala"
                value={indSearch} onChange={e => { setIndSearch(e.target.value); setIndPage(1); }} />
            </div>
            <div>
              <label className="label text-[10px] mb-0.5">Status</label>
              <select className="select text-xs" value={indFilterStatus}
                onChange={e => { setIndFilterStatus(e.target.value); setIndPage(1); }}>
                <option value="all">All ({indents.length})</option>
                <option value="submitted">Pending L1</option>
                <option value="l1_approved">Pending L2</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="po_sent">PO Sent</option>
                <option value="dispatched">Dispatched</option>
                <option value="received">Received</option>
              </select>
            </div>
            <div>
              <label className="label text-[10px] mb-0.5">Category</label>
              <select className="select text-xs" value={indFilterCategory}
                onChange={e => { setIndFilterCategory(e.target.value); setIndPage(1); }}>
                <option value="all">All</option>
                <option value="material">Material</option>
                <option value="rgp">RGP</option>
                <option value="extra_schedule">Extra · Schedule</option>
                <option value="extra_non_schedule">Extra · Non-Schedule</option>
                <option value="rental">Rental</option>
              </select>
            </div>
            <div>
              <label className="label text-[10px] mb-0.5">From</label>
              <input className="input text-xs" type="date" value={indFilterFrom}
                onChange={e => { setIndFilterFrom(e.target.value); setIndPage(1); }} />
            </div>
            <div>
              <label className="label text-[10px] mb-0.5">To</label>
              <input className="input text-xs" type="date" value={indFilterTo}
                onChange={e => { setIndFilterTo(e.target.value); setIndPage(1); }} />
            </div>
            {(indSearch || indFilterStatus !== 'all' || indFilterCategory !== 'all' || indFilterFrom || indFilterTo) && (
              <button type="button" className="btn btn-secondary text-xs py-1 px-2"
                onClick={() => { setIndSearch(''); setIndFilterStatus('all'); setIndFilterCategory('all'); setIndFilterFrom(''); setIndFilterTo(''); setIndPage(1); }}>
                Reset
              </button>
            )}
            <div className="ml-auto text-[11px] text-gray-500">
              Showing <span className="font-semibold text-gray-700">{filteredIndents.length}</span> of {indents.length}
            </div>
          </div>

          {/* ─── MOBILE CARD VIEW ─────────────────────────────────────
              Mam (2026-06-02): on phones the freeze-head table reads as
              a cramped wall of text.  Cards below mirror her mockup
              (INDENT REFERENCE label · status pill · site row · dispatch
              window · view-details link · optional progress bar).
              Hidden ≥ md so desktop keeps the full table with every
              column intact. */}
          <div className="md:hidden space-y-3">
            {indents.length === 0 && (
              <div className="card p-6 text-center text-gray-400 text-sm">No indents yet</div>
            )}
            {indents.length > 0 && filteredIndents.length === 0 && (
              <div className="card p-6 text-center text-gray-400 text-sm">No indents match the current filters — try Reset</div>
            )}
            {indPg.rows.map(i => {
              const items = i.items || [];
              // Mam (2026-06-02 follow-up): items now visible BY DEFAULT
              // (no longer hidden behind View Details).  Auto-show first
              // 3; expander reveals the rest.
              const expanded = expandedIndents.has(i.id);
              const visibleItems = expanded ? items : items.slice(0, 3);
              const raisedClean = i.raised_by_name && !/^\d+(\.\d+)?$/.test(String(i.raised_by_name).trim())
                ? i.raised_by_name
                : null;

              // Mam's reference = desktop table.  Mirror its action logic
              // exactly so the L1 / L2 / single-approval / Re-reject flow
              // works identically on phone.
              const isTwoLevel = i.approval_policy === 'two_level';
              // Phase A+B (mam 2026-06-02): Extra-Schedule / Extra-Non-Schedule
              // indents route through CRM first.  Detect that policy here so
              // the approve buttons render in the right order: CRM → L1 → L2.
              const isCrmTwoLevel = i.approval_policy === 'crm_two_level';
              const needsCrm = isCrmTwoLevel && i.crm_status === 'pending';
              // Admin is never treated as the blocked self-creator — mam
              // (2026-06-06: "admin can also approval like others"). Matches
              // the backend, which lets admin approve indents they raised.
              const isCreator = i.created_by === user?.id && !isAdmin();
              const canActL1 = isAdmin() || user?.approval_role === 'l1';
              const canActL2 = isAdmin() || user?.approval_role === 'l2';
              // RGP single HR sign-off (mam 2026-06-04).
              const isHrSingle = i.approval_policy === 'hr_single';
              const canActHr = isAdmin() || user?.approval_role === 'hr';
              // CRM action allowed for anyone with CRM module access
              // (mam's pick: "anyone with CRM module access").  The real
              // module key is 'crm_funnel' (there is no 'crm' module), and
              // "access" = can view the CRM funnel — sales/CRM roles get
              // view, only admin gets edit/approve, so gate on view here.
              // ALSO allow the CRM person assigned on the Client PO
              // (planning_crm_name, e.g. Sushila/Lovely) even without the
              // role — matches the server gate (mam 2026-06-03).
              const isAssignedCrm = crmNameMatchesUser(i.planning_crm_name, user?.name);
              const canActCrm = isAdmin() || canView('crm_funnel') || isAssignedCrm;
              const blockSelfL2 = i.l1_by && i.l1_by === user?.id && !isAdmin();

              const renderActionButtons = () => {
                // CRM stage (Extra-billable indents) — fires first, before L1/L2.
                if (needsCrm && i.status === 'submitted' && !isCreator) {
                  if (canActCrm) return (
                    <>
                      <button onClick={() => openApproveModal(i)} className="btn text-xs py-1 px-2 flex-1 bg-purple-600 text-white hover:bg-purple-700">Approve as CRM</button>
                      <button onClick={() => openRejectModal(i)} className="btn btn-danger text-xs py-1 px-2 flex-1">Reject CRM</button>
                    </>
                  );
                  return <span className="text-[10px] text-purple-600 italic">Awaiting CRM (Extra-billable)</span>;
                }
                // RGP single HR sign-off — one approval by an HR-role user.
                if (isHrSingle && i.status === 'submitted' && !isCreator) {
                  if (canActHr) return (
                    <>
                      <button onClick={() => openApproveModal(i)} className="btn btn-success text-xs py-1 px-2 flex-1">Approve (HR)</button>
                      <button onClick={() => openRejectModal(i)} className="btn btn-danger text-xs py-1 px-2 flex-1">Reject</button>
                    </>
                  );
                  return <span className="text-[10px] text-teal-600 italic">Awaiting HR approval</span>;
                }
                if (i.status === 'submitted' && !isCreator) {
                  if (isTwoLevel) {
                    if (canActL1) return (
                      <>
                        <button onClick={() => openApproveModal(i)} className="btn btn-success text-xs py-1 px-2 flex-1">Approve L1</button>
                        <button onClick={() => openRejectModal(i)} className="btn btn-danger text-xs py-1 px-2 flex-1">Reject L1</button>
                      </>
                    );
                    return <span className="text-[10px] text-amber-600 italic">Awaiting {i.approver_names?.l1 || 'L1'}</span>;
                  }
                  if (canApprove('procurement') || isAdmin()) return (
                    <>
                      <button onClick={() => openApproveModal(i)} className="btn btn-success text-xs py-1 px-2 flex-1">Approve</button>
                      <button onClick={() => openRejectModal(i)} className="btn btn-danger text-xs py-1 px-2 flex-1">Reject</button>
                    </>
                  );
                }
                // CRM-approved → behaves like 'submitted' for L1.
                if ((i.status === 'crm_approved') && !isCreator) {
                  if (canActL1) return (
                    <>
                      <button onClick={() => openApproveModal(i)} className="btn btn-success text-xs py-1 px-2 flex-1">Approve L1</button>
                      <button onClick={() => openRejectModal(i)} className="btn btn-danger text-xs py-1 px-2 flex-1">Reject L1</button>
                    </>
                  );
                  return <span className="text-[10px] text-amber-600 italic">CRM ✓ · Awaiting L1</span>;
                }
                if (i.status === 'l1_approved' && !isCreator) {
                  if (canActL2 && !blockSelfL2) return (
                    <>
                      <button onClick={() => openApproveModal(i)} className="btn btn-success text-xs py-1 px-2 flex-1">Approve L2</button>
                      <button onClick={() => openRejectModal(i)} className="btn btn-danger text-xs py-1 px-2 flex-1">Reject L2</button>
                    </>
                  );
                  if (canActL2 && blockSelfL2) return <span className="text-[10px] text-gray-500 italic">L2 needs different reviewer</span>;
                  return <span className="text-[10px] text-purple-600 italic">Awaiting {i.approver_names?.l2 || 'L2'}</span>;
                }
                if (i.status === 'draft') return (
                  <button onClick={() => approveIndent(i.id, 'submitted')} className="btn btn-primary text-xs py-1 px-2 flex-1">Submit</button>
                );
                if ((i.status === 'submitted' || i.status === 'l1_approved') && isCreator) {
                  return <span className="text-[10px] text-gray-500 italic">Awaiting approval</span>;
                }
                if (i.status === 'approved' && (isAdmin() || user?.approval_role === 'l2')) return (
                  <>
                    <button onClick={() => reapproveIndent(i)} className="btn btn-success text-xs py-1 px-2 flex-1" title="Re-confirm this approval">Re-approve</button>
                    <button onClick={() => openRejectModal(i)} className="btn btn-danger text-xs py-1 px-2 flex-1">Re-reject</button>
                  </>
                );
                // PO already sent, but admin/MD still wants to issue some qty
                // from store (mam 2026-06-23). Reopen the approve modal so the
                // From-Store split can be entered + a Store Issue Challan cut.
                if (i.status === 'po_sent' && (isAdmin() || user?.approval_role === 'l2')) return (
                  <button onClick={() => reapproveIndent(i)} className="btn btn-success text-xs py-1 px-2 flex-1" title="Re-open to issue items from store">Issue from Store</button>
                );
                if (i.status === 'rejected' && (isAdmin() || user?.approval_role === 'l2')) return (
                  <button onClick={() => reapproveIndent(i)} className="btn btn-success text-xs py-1 px-2 flex-1" title="Revoke rejection and approve">Re-approve</button>
                );
                return null;
              };

              return (
                <div key={i.id} className="card p-3 space-y-2">
                  {/* Header: indent # · date · status */}
                  <div className="flex justify-between items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Indent No</div>
                      <div className="text-lg font-bold text-gray-900 truncate">{i.indent_number}</div>
                      <div className="text-[11px] text-gray-500 flex items-center gap-1 mt-0.5">
                        <FiCalendar size={10} className="text-gray-400" />
                        {i.created_at ? fmtIST(i.created_at) : (i.indent_date || '—')}
                      </div>
                    </div>
                    <StatusBadge status={i.status} />
                  </div>

                  {/* Site */}
                  <div className="flex items-start gap-1.5 text-xs">
                    <FiMapPin size={12} className="mt-0.5 text-red-500 flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="text-[10px] uppercase text-gray-400">Site</div>
                      <div className="font-medium text-gray-800">{i.site_name || i.client_name || '—'}</div>
                    </div>
                  </div>

                  {/* Category · Raised By · Budget compact strip */}
                  <div className="grid grid-cols-3 gap-2 pt-1 border-t border-gray-100 text-[11px]">
                    <div>
                      <div className="text-[9px] uppercase text-gray-400">Category</div>
                      {(() => {
                        const c = i.indent_category || 'material';
                        const cfg = {
                          material:           { label: 'Material',     color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
                          rgp:                { label: 'RGP',          color: 'bg-purple-50 text-purple-700 border-purple-200' },
                          extra_schedule:     { label: 'Extra · Sched', color: 'bg-amber-50 text-amber-700 border-amber-200' },
                          extra_non_schedule: { label: 'Extra · Non',   color: 'bg-orange-50 text-orange-700 border-orange-200' },
                          rental:             { label: 'Rental',       color: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
                        }[c] || { label: c, color: 'bg-gray-50 text-gray-700 border-gray-200' };
                        return <span className={`inline-block text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${cfg.color}`}>{cfg.label}</span>;
                      })()}
                    </div>
                    <div>
                      <div className="text-[9px] uppercase text-gray-400">Raised By</div>
                      <div className="font-medium text-gray-700 truncate">{raisedClean || '—'}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[9px] uppercase text-gray-400">Budget</div>
                      <div className="font-semibold text-gray-800">
                        {i.budget_amount > 0 ? `₹${Math.round(i.budget_amount).toLocaleString('en-IN')}` : '—'}
                      </div>
                    </div>
                  </div>

                  {/* Delivery Bill (Billable × against-delivery %) */}
                  <div className="grid grid-cols-2 gap-2 pt-1 text-[11px]">
                    <div className="text-right col-start-2">
                      <div className="text-[9px] uppercase text-gray-400">Delivery Bill{i.delivery_pct ? ` @ ${i.delivery_pct}%` : ''}</div>
                      <div className="font-semibold text-emerald-700">
                        {i.delivery_bill_amount > 0 ? `₹${Math.round(i.delivery_bill_amount).toLocaleString('en-IN')}` : '—'}
                      </div>
                    </div>
                  </div>

                  {/* File links — mam (2026-06-02): "indent pdf also not
                      showing so that he can check indent after fill". */}
                  <div className="flex items-center gap-3 text-xs pt-1 border-t border-gray-100">
                    <a href={`/indent/${i.id}/print`} target="_blank" rel="noreferrer"
                       className="text-blue-600 hover:underline flex items-center gap-1 font-semibold">
                      📄 Indent PDF
                    </a>
                    {i.boq_file_link && (
                      <a href={i.boq_file_link} target="_blank" rel="noreferrer"
                         className="text-red-600 hover:underline flex items-center gap-1 font-semibold">
                        <FiExternalLink size={11} /> BOQ
                      </a>
                    )}
                  </div>

                  {/* Items — visible by default (first 3); expand for rest */}
                  {items.length > 0 && (
                    <div className="pt-1 border-t border-gray-100 space-y-1 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-gray-700">
                          Items <span className="text-gray-400 font-normal">({items.length})</span>
                        </span>
                        {items.length > 3 && (
                          <button onClick={() => toggleIndentRow(i.id)} className="text-[10px] text-blue-600 font-semibold">
                            {expanded ? 'Show less' : `Show all ${items.length}`}
                          </button>
                        )}
                      </div>
                      {/* Mam (2026-06-02): "click on item show boq item sub
                          item also and if item big then info button give".
                          Each item row tap-expands inline to reveal the
                          full BOQ description + sub-item (item_master) +
                          spec/size/make/type/rate.  An ⓘ icon appears on
                          long descriptions so the tap target is obvious. */}
                      {visibleItems.map((it, idx) => (
                        <MobileItemRow key={it.id || idx} item={it} idx={idx} />
                      ))}
                    </div>
                  )}

                  {/* Approval row — CRM (Extra-billable) + L1 + L2 stack
                      for crm_two_level / two_level, single line for legacy. */}
                  <div className="pt-1 border-t border-gray-100 text-[11px]">
                    <div className="text-[9px] uppercase text-gray-400 mb-0.5">Approval</div>
                    {(isTwoLevel || isCrmTwoLevel) ? (
                      <div className="space-y-0.5">
                        {isCrmTwoLevel && (
                          <ApprovalLevelRow label="CRM" status={i.crm_status}
                            name={i.crm_by_name} at={i.crm_at}
                            isReject={i.status === 'rejected' && i.crm_status === 'rejected'} reason={i.crm_reason || i.rejection_reason} />
                        )}
                        <ApprovalLevelRow label="L1" status={i.l1_status} name={i.l1_by_name || i.approver_names?.l1} at={i.l1_at}
                          waiting={isCrmTwoLevel && i.crm_status !== 'approved' && i.l1_status === 'pending'}
                          isReject={i.status === 'rejected' && i.l1_status === 'rejected'} reason={i.rejection_reason} />
                        <ApprovalLevelRow label="L2" status={i.l2_status} name={i.l2_by_name || i.approver_names?.l2} at={i.l2_at}
                          waiting={i.l1_status !== 'approved' && i.l2_status === 'pending'}
                          isReject={i.status === 'rejected' && i.l2_status === 'rejected'} reason={i.rejection_reason} />
                      </div>
                    ) : (
                      <>
                        {i.status === 'approved' && (
                          <div className="text-emerald-700 font-medium flex items-center gap-1">
                            <FiCheck size={11} /> {i.approved_by_name || 'approver'}
                            {i.approved_at && <span className="text-[10px] text-gray-500 ml-1">{fmtIST(i.approved_at, { day: '2-digit', month: 'short' })}</span>}
                          </div>
                        )}
                        {i.status === 'rejected' && (
                          <div className="text-red-700 font-medium flex items-center gap-1" title={i.rejection_reason}>
                            <FiX size={11} /> {i.rejected_by_name || 'approver'}
                            {i.rejection_reason && <span className="text-[10px] italic ml-1 truncate">"{i.rejection_reason}"</span>}
                          </div>
                        )}
                        {i.status !== 'approved' && i.status !== 'rejected' && <span className="text-gray-400">—</span>}
                      </>
                    )}
                  </div>

                  {/* Action buttons (approve / reject / submit / re-reject) */}
                  {(() => {
                    const buttons = renderActionButtons();
                    if (!buttons) return null;
                    return (
                      <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
                        {buttons}
                      </div>
                    );
                  })()}

                  {/* Edit + delete row */}
                  {((canEdit('procurement') || isAdmin()) || canDelete('procurement')) && (
                    <div className="flex justify-end gap-2 pt-1 text-[11px]">
                      {(canEdit('procurement') || isAdmin()) && i.status !== 'approved' && (
                        <button onClick={() => openEditIndent(i)} className="text-blue-600 hover:underline flex items-center gap-1">
                          <FiEdit2 size={11} /> Edit
                        </button>
                      )}
                      {canDelete('procurement') && (
                        <button onClick={async () => {
                          if (!confirm(`Delete indent "${i.indent_number}"?`)) return;
                          try { await api.delete(`/procurement/indents/${i.id}`); toast.success('Deleted'); load(); }
                          catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                        }} className="text-red-600 hover:underline flex items-center gap-1">
                          <FiTrash2 size={11} /> Delete
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <Pagination pg={indPg} setPerPage={setIndPerPage} />
          </div>

          {/* ─── DESKTOP TABLE VIEW ───────────────────────────────────
              freeze-col pins Indent No to the left while user scrolls right
              to see Approval / Actions (mam 2026-05-25 — was "time wasting"
              to scroll-end-then-back to read row labels).  Hidden on phones
              in favour of the card list above. */}
          <div className="hidden md:block card p-0 overflow-auto max-h-[70vh]"><table className="freeze-head freeze-col dense-cols">
            <thead><tr><th className="w-8"></th><th>Indent No</th><th>Date</th><th>Site</th><th>Category</th><th>Raised By</th><th>Items</th><th>BOQ</th><th className="text-right">Budget<br/><span className="text-[9px] font-normal text-gray-400 normal-case">(qty × master rate)</span></th><th className="text-right">Delivery Bill<br/><span className="text-[9px] font-normal text-gray-400 normal-case">(billable × del. %)</span></th><th>Status</th><th>Approval</th><th>Actions</th></tr></thead>
            <tbody>
              {indPg.rows.map(i => {
                const items = i.items || [];
                const expanded = expandedIndents.has(i.id);
                return (
                <Fragment key={i.id}>
                <tr>
                  <td className="text-center">
                    {items.length > 0 && (
                      <button onClick={() => toggleIndentRow(i.id)} className="p-1 text-gray-400 hover:text-red-600" title={expanded ? 'Hide items' : 'Show items'}>
                        {expanded ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
                      </button>
                    )}
                  </td>
                  <td className="font-medium">{i.indent_number}</td>
                  <td className="text-xs text-gray-600">{i.created_at ? fmtIST(i.created_at) : (i.indent_date || '—')}</td>
                  <td>{i.site_name || i.client_name || <span className="text-gray-400">—</span>}</td>
                  {/* Dedicated Category column (mam 2026-05-28). Coloured
                      pill mirrors the inline chip's palette so the table
                      reads at a glance. */}
                  <td>
                    {(() => {
                      const c = i.indent_category || 'material';
                      const cfg = {
                        material:           { label: 'Material',     color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
                        rgp:                { label: 'RGP',          color: 'bg-purple-50 text-purple-700 border-purple-200' },
                        extra_schedule:     { label: 'Extra · Sched', color: 'bg-amber-50 text-amber-700 border-amber-200' },
                        extra_non_schedule: { label: 'Extra · Non',   color: 'bg-orange-50 text-orange-700 border-orange-200' },
                        rental:             { label: 'Rental',       color: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
                      }[c] || { label: c, color: 'bg-gray-50 text-gray-700 border-gray-200' };
                      return <span className={`inline-block text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border ${cfg.color}`}>{cfg.label}</span>;
                    })()}
                  </td>
                  <td>{
                    /* Show only the explicit raised_by_name. Mam
                       2026-05-28: legacy rows had wrong names from
                       the form bug, so we blank them at the DB level
                       and rely on this exact field going forward. No
                       fallback to created_by_name — that's a
                       different person and would mislead. */
                    (i.raised_by_name && !/^\d+(\.\d+)?$/.test(String(i.raised_by_name).trim()))
                      ? i.raised_by_name
                      : <span className="text-gray-400">—</span>
                  }</td>
                  <td>
                    {items.length === 0
                      ? <span className="text-gray-400 text-xs">—</span>
                      : (
                        <div className="flex items-center gap-2">
                          <button onClick={() => toggleIndentRow(i.id)} className="text-xs text-red-600 hover:underline">
                            {items.length} item{items.length === 1 ? '' : 's'}
                          </button>
                          <a href={`/indent/${i.id}/print`} target="_blank" rel="noreferrer"
                             className="text-[10px] text-blue-600 hover:underline flex items-center gap-0.5"
                             title="Open print-friendly BoQ — Save as PDF from browser">
                            📄 PDF
                          </a>
                        </div>
                      )}
                  </td>
                  <td>
                    {i.boq_file_link
                      ? <a href={i.boq_file_link} target="_blank" rel="noreferrer" className="text-red-600 hover:underline flex items-center gap-1 text-xs"><FiExternalLink size={12} /> View</a>
                      : <span className="text-gray-400 text-xs">—</span>}
                  </td>
                  {/* Budget = sum of (qty × item_master.current_price) across
                      every line. Tells the approver what they're committing to
                      before they hit Approve. Falls back to '—' when no master
                      rates exist yet so unrated items don't lie about ₹0. */}
                  <td className="text-right">
                    {i.budget_amount > 0 ? (
                      <span className="font-semibold text-gray-800">
                        ₹{Math.round(i.budget_amount).toLocaleString('en-IN')}
                      </span>
                    ) : (
                      <span className="text-gray-300 text-xs" title="No item-master rate on any line">—</span>
                    )}
                  </td>
                  {/* Delivery Bill = Billable × the order's Against-Delivery %
                      — the slice invoiceable on delivery (same basis as the
                      Sales Bill). '—' when billable is 0 or no delivery term. */}
                  <td className="text-right whitespace-nowrap">
                    {i.delivery_bill_amount > 0 ? (
                      <span className="font-semibold text-emerald-700" title={i.delivery_pct ? `${i.delivery_pct}% against delivery` : ''}>
                        ₹{Math.round(i.delivery_bill_amount).toLocaleString('en-IN')}
                        {i.delivery_pct ? <span className="block text-[9px] font-normal text-gray-400">@ {i.delivery_pct}%</span> : null}
                      </span>
                    ) : (
                      <span className="text-gray-300 text-xs" title="No against-delivery % or no billable value">—</span>
                    )}
                  </td>
                  <td><StatusBadge status={i.status} /></td>
                  {/* Approval cell — shows "approved by X · DD MMM" once
                      approved, or "rejected by X · reason" if rejected.
                      For two_level indents (mam 2026-05-26) also shows a
                      stacked L1 + L2 mini-row so progress is visible from
                      the list without opening each row. */}
                  <td className="text-xs">
                    {(i.approval_policy === 'two_level' || i.approval_policy === 'crm_two_level') ? (
                      <div className="space-y-0.5 min-w-[150px]">
                        {/* Extra-billable indents add a CRM stage before L1/L2. */}
                        {i.approval_policy === 'crm_two_level' && (
                          <ApprovalLevelRow
                            label="CRM"
                            status={i.crm_status}
                            name={i.crm_by_name}
                            at={i.crm_at}
                            isReject={i.status === 'rejected' && i.crm_status === 'rejected'}
                            reason={i.crm_reason || i.rejection_reason}
                          />
                        )}
                        <ApprovalLevelRow
                          label="L1"
                          status={i.l1_status}
                          name={i.l1_by_name || i.approver_names?.l1}
                          at={i.l1_at}
                          waiting={i.approval_policy === 'crm_two_level' && i.crm_status !== 'approved' && i.l1_status === 'pending'}
                          isReject={i.status === 'rejected' && i.l1_status === 'rejected'}
                          reason={i.rejection_reason}
                        />
                        <ApprovalLevelRow
                          label="L2"
                          status={i.l2_status}
                          name={i.l2_by_name || i.approver_names?.l2}
                          at={i.l2_at}
                          waiting={i.l1_status !== 'approved' && i.l2_status === 'pending'}
                          isReject={i.status === 'rejected' && i.l2_status === 'rejected'}
                          reason={i.rejection_reason}
                        />
                      </div>
                    ) : (
                      <>
                        {i.status === 'approved' && (
                          <div>
                            <div className="text-emerald-700 font-medium flex items-center gap-1">
                              <FiCheck size={12} /> {i.approved_by_name || 'approver'}
                            </div>
                            {i.approved_at && (
                              <div className="text-[10px] text-gray-500">
                                {fmtIST(i.approved_at, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                              </div>
                            )}
                          </div>
                        )}
                        {i.status === 'rejected' && (
                          <div>
                            <div className="text-red-700 font-medium flex items-center gap-1" title={i.rejection_reason || ''}>
                              <FiX size={12} /> {i.rejected_by_name || 'approver'}
                            </div>
                            {i.rejection_reason && (
                              <div className="text-[10px] text-gray-500 italic max-w-[180px] truncate" title={i.rejection_reason}>
                                “{i.rejection_reason}”
                              </div>
                            )}
                          </div>
                        )}
                        {i.status !== 'approved' && i.status !== 'rejected' && (
                          <span className="text-gray-300">—</span>
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    <div className="flex gap-1 items-center flex-wrap">
                      {/* ─── 2-Level approval routing (mam 2026-05-26) ─────
                          For two_level indents, the same Approve / Reject
                          modals are reused but the label flips to "Approve L1"
                          or "Approve L2" based on current stage, and visibility
                          is gated on user.approval_role (admin sees both).
                          Server enforces the same guards as a safety net. */}
                      {(() => {
                        const isTwoLevel = i.approval_policy === 'two_level';
                        // Extra-Schedule / Extra-Non-Schedule indents route
                        // through CRM first (crm_two_level): CRM → L1 → L2.
                        // The desktop table must mirror the mobile card's
                        // renderActionButtons or these rows show no action
                        // and the CRM approver can't act (mam 2026-06-03).
                        const isCrmTwoLevel = i.approval_policy === 'crm_two_level';
                        const needsCrm = isCrmTwoLevel && i.crm_status === 'pending';
                        // Admin is never treated as the blocked self-creator — mam
              // (2026-06-06: "admin can also approval like others"). Matches
              // the backend, which lets admin approve indents they raised.
              const isCreator = i.created_by === user?.id && !isAdmin();
                        const canActL1 = isAdmin() || user?.approval_role === 'l1';
                        const canActL2 = isAdmin() || user?.approval_role === 'l2';
                        const isHrSingle = i.approval_policy === 'hr_single';
                        const canActHr = isAdmin() || user?.approval_role === 'hr';
                        // CRM action = anyone with CRM module (crm_funnel)
                        // access, OR the CRM person assigned on the Client PO
                        // (planning_crm_name) even without the role — matches
                        // the server gate (mam 2026-06-03).
                        const isAssignedCrm = crmNameMatchesUser(i.planning_crm_name, user?.name);
                        const canActCrm = isAdmin() || canView('crm_funnel') || isAssignedCrm;
                        const blockSelfL2 = i.l1_by && i.l1_by === user?.id && !isAdmin();

                        // CRM stage (Extra-billable) — fires first, before L1/L2.
                        if (needsCrm && i.status === 'submitted' && !isCreator) {
                          if (canActCrm) {
                            return (
                              <>
                                <button onClick={() => openApproveModal(i)} className="btn text-xs py-1 px-2 bg-purple-600 text-white hover:bg-purple-700">Approve as CRM</button>
                                <button onClick={() => openRejectModal(i)} className="btn btn-danger text-xs py-1 px-2">Reject CRM</button>
                              </>
                            );
                          }
                          return <span className="text-[10px] text-purple-600 italic">Awaiting CRM (Extra-billable)</span>;
                        }

                        // RGP single HR sign-off — one approval by an HR-role user.
                        if (isHrSingle && i.status === 'submitted' && !isCreator) {
                          if (canActHr) {
                            return (
                              <>
                                <button onClick={() => openApproveModal(i)} className="btn btn-success text-xs py-1 px-2">Approve (HR)</button>
                                <button onClick={() => openRejectModal(i)} className="btn btn-danger text-xs py-1 px-2">Reject</button>
                              </>
                            );
                          }
                          return <span className="text-[10px] text-teal-600 italic">Awaiting HR approval</span>;
                        }

                        // L1 stage — submitted + (legacy OR two_level pending L1)
                        if (i.status === 'submitted' && !isCreator) {
                          if (isTwoLevel) {
                            if (canActL1) {
                              return (
                                <>
                                  <button onClick={() => openApproveModal(i)} className="btn btn-success text-xs py-1 px-2">Approve L1</button>
                                  <button onClick={() => openRejectModal(i)} className="btn btn-danger text-xs py-1 px-2">Reject L1</button>
                                </>
                              );
                            }
                            return <span className="text-[10px] text-amber-600 italic" title={`Waiting for ${i.approver_names?.l1 || 'L1 approver'}`}>Awaiting {i.approver_names?.l1 || 'L1'}</span>;
                          }
                          // Legacy single-approval flow — original buttons unchanged.
                          if (canApprove('procurement') || isAdmin()) {
                            return (
                              <>
                                <button onClick={() => openApproveModal(i)} className="btn btn-success text-xs py-1 px-2">Approve</button>
                                <button onClick={() => openRejectModal(i)} className="btn btn-danger text-xs py-1 px-2">Reject</button>
                              </>
                            );
                          }
                        }

                        // CRM-approved → behaves like 'submitted' for L1.
                        if (i.status === 'crm_approved' && !isCreator) {
                          if (canActL1) {
                            return (
                              <>
                                <button onClick={() => openApproveModal(i)} className="btn btn-success text-xs py-1 px-2">Approve L1</button>
                                <button onClick={() => openRejectModal(i)} className="btn btn-danger text-xs py-1 px-2">Reject L1</button>
                              </>
                            );
                          }
                          return <span className="text-[10px] text-amber-600 italic" title={`Waiting for ${i.approver_names?.l1 || 'L1 approver'}`}>CRM ✓ · Awaiting {i.approver_names?.l1 || 'L1'}</span>;
                        }

                        // L2 stage — two_level + crm_two_level indents.
                        if (i.status === 'l1_approved' && !isCreator) {
                          if (canActL2 && !blockSelfL2) {
                            return (
                              <>
                                <button onClick={() => openApproveModal(i)} className="btn btn-success text-xs py-1 px-2">Approve L2</button>
                                <button onClick={() => openRejectModal(i)} className="btn btn-danger text-xs py-1 px-2">Reject L2</button>
                              </>
                            );
                          }
                          if (canActL2 && blockSelfL2) {
                            return <span className="text-[10px] text-gray-500 italic" title="You approved L1 — L2 needs a different reviewer">Needs different reviewer</span>;
                          }
                          return <span className="text-[10px] text-purple-600 italic" title={`Waiting for ${i.approver_names?.l2 || 'L2 approver'}`}>Awaiting {i.approver_names?.l2 || 'L2'}</span>;
                        }
                        return null;
                      })()}

                      {/* Admin-only "Re-reject" on approved indents — revokes
                          the approval and flips back to rejected, using the
                          same mandatory-reason modal.  Mam (2026-05-25):
                          "give this permission to delete or again reject". */}
                      {i.status === 'approved' && (isAdmin() || user?.approval_role === 'l2') && (
                        <button onClick={() => openRejectModal(i)} className="btn btn-danger text-xs py-1 px-2" title="Revoke approval and reject this indent">
                          Re-reject
                        </button>
                      )}
                      {/* Re-approve — on a REJECTED indent it revokes the
                          rejection; on an APPROVED/PO-SENT one it reopens the
                          approve modal so the From-Store split can be (re)entered
                          and a Store Issue Challan cut. Admin or the L2 approver
                          / MD (mam 2026-06-04, 2026-06-23: "issue items from
                          store now" on a PO-sent indent). */}
                      {(i.status === 'rejected' || i.status === 'approved' || i.status === 'po_sent') && (isAdmin() || user?.approval_role === 'l2') && (
                        <button onClick={() => reapproveIndent(i)} className="btn btn-success text-xs py-1 px-2" title={i.status === 'rejected' ? 'Revoke rejection and approve' : 'Re-open to edit qty / issue from store'}>
                          {i.status === 'po_sent' ? 'Issue from Store' : 'Re-approve'}
                        </button>
                      )}
                      {/* If creator is viewing their own pending indent, show
                          a small "Awaiting approval" hint instead so they
                          know what's happening. Works for both submitted +
                          l1_approved (two_level intermediate state). */}
                      {(i.status === 'submitted' || i.status === 'l1_approved') && i.created_by === user?.id && (
                        <span className="text-[10px] text-gray-500 italic" title="Only an approver can act on your indent">Awaiting approval</span>
                      )}
                      {i.status === 'draft' && <button onClick={() => approveIndent(i.id, 'submitted')} className="btn btn-primary text-xs py-1 px-2">Submit</button>}
                      {/* Edit — site engineers in training need to fix wrong
                          indents. Allowed for submitted / draft / rejected;
                          approved indents are frozen (server enforces too). */}
                      {(canEdit('procurement') || isAdmin()) && i.status !== 'approved' && (
                        <button onClick={() => openEditIndent(i)} className="p-1 text-gray-400 hover:text-blue-600" title="Edit indent"><FiEdit2 size={14} /></button>
                      )}
                      {canDelete('procurement') && <button onClick={async () => {
                        if (!confirm(`Delete indent "${i.indent_number}"?`)) return;
                        try { await api.delete(`/procurement/indents/${i.id}`); toast.success('Deleted'); load(); }
                        catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                      }} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}
                    </div>
                  </td>
                </tr>
                {expanded && items.length > 0 && (
                  <tr className="bg-gray-50">
                    <td></td>
                    <td colSpan="13" className="p-3">
                      <div className="text-xs font-semibold text-gray-600 mb-2">BoQ items raised in {i.indent_number}</div>
                      <table className="text-xs w-full">
                        <thead>
                          <tr className="text-gray-500 border-b">
                            <th className="text-left py-1 pr-3 w-10">#</th>
                            <th className="text-left py-1 pr-3">BOQ Description</th>
                            <th className="text-left py-1 pr-3">Sub-Item (Item Master)</th>
                            <th className="text-left py-1 pr-3 w-24">Source</th>
                            <th className="text-left py-1 pr-3">Make</th>
                            <th className="text-right py-1 pr-3 w-20">Qty</th>
                            <th className="text-left py-1 pr-3 w-16">Unit</th>
                            <th className="text-left py-1 pr-3 w-16">Type</th>
                            <th className="text-right py-1 pr-3 w-24" title="Cost rate (Item Master)">Rate</th>
                            <th className="text-right py-1 pr-3 w-28" title="Cost = qty × master rate">Line Budget</th>
                            <th className="text-right py-1 pr-3 w-24 text-indigo-600" title="BOQ sale rate (what the client is billed) — from order-planning po_items">Sales Rate</th>
                            <th className="text-right py-1 pr-3 w-28 text-indigo-700" title="Billable = qty × BOQ sale rate">Billable</th>
                            <th className="text-right py-1 pr-3 w-24">PO Pending</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((it, idx) => (
                            <tr key={it.id} className={`border-b border-gray-100 last:border-0 align-top ${it.source === 'store' ? 'bg-emerald-50/30' : ''}`}>
                              <td className="py-1 pr-3 text-gray-500">{idx + 1}</td>
                              <td className="py-1 pr-3">{it.description || <span className="text-gray-400">—</span>}</td>
                              <td className="py-1 pr-3">
                                {/* Sub-Item column: shows item_code + name + size + spec from
                                    item_master so mam can tell rows of the same BOQ apart. */}
                                {(it.item_code || it.master_name) ? (
                                  <div>
                                    {it.item_code && <span className="font-mono text-[10px] text-gray-500">[{it.item_code}]</span>}
                                    {it.master_name && <span className="ml-1 font-medium">{it.master_name}</span>}
                                    {(it.master_specification || it.master_size) && (
                                      <div className="text-[10px] text-gray-500">
                                        {[it.master_size, it.master_specification].filter(Boolean).join(' / ')}
                                      </div>
                                    )}
                                  </div>
                                ) : <span className="text-gray-400 italic">manual entry</span>}
                              </td>
                              {/* Source cell (mam 2026-06-02): tells site
                                  engineer + MD where this line is coming
                                  from.  'STORE' rows already have stock
                                  on hand (SI number visible); 'PROCURE'
                                  goes through normal vendor PO flow. */}
                              <td className="py-1 pr-3">
                                {it.source === 'store' ? (
                                  <div>
                                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-300">🟢 STORE</span>
                                    {it.stock_issue_number && (
                                      <div className="text-[9px] font-mono text-gray-500 mt-0.5">{it.stock_issue_number}</div>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 border border-blue-300">🛒 PROCURE</span>
                                )}
                              </td>
                              <td className="py-1 pr-3">{it.make || <span className="text-gray-400">—</span>}</td>
                              <td className="py-1 pr-3 text-right">{it.quantity}</td>
                              <td className="py-1 pr-3">{it.unit || '—'}</td>
                              <td className="py-1 pr-3">{it.item_type || <span className="text-gray-400">—</span>}</td>
                              <td className="py-1 pr-3 text-right">
                                {+it.master_price > 0 ? (
                                  <div className="inline-flex items-center gap-1">
                                    <span>₹{Math.round(+it.master_price).toLocaleString('en-IN')}</span>
                                    {/* Rate source badge — mam (2026-05-25):
                                        "history" means item_master.current_price
                                        was 0, so we fell back to the last logged
                                        rate from item_price_history.  Lets mam
                                        know to update the master sheet. */}
                                    {it.rate_source === 'history' && (
                                      <span className="text-[9px] px-1 rounded bg-amber-100 text-amber-700 font-medium" title="Rate pulled from item_price_history (master sheet has no current_price). Update Item Master to dismiss.">
                                        hist
                                      </span>
                                    )}
                                  </div>
                                ) : <span className="text-gray-300" title="No rate in Item Master or price history for this sub-item">—</span>}
                              </td>
                              <td className="py-1 pr-3 text-right">
                                {+it.line_budget > 0 ? <span className="font-medium">₹{Math.round(+it.line_budget).toLocaleString('en-IN')}</span> : <span className="text-gray-300">—</span>}
                              </td>
                              {/* Sales Rate + Billable — BOQ sale value per line, for
                                  estimating sales vs cost (mam 2026-06-24). */}
                              <td className="py-1 pr-3 text-right text-indigo-600">
                                {+it.boq_sale_rate > 0 ? `₹${Math.round(+it.boq_sale_rate).toLocaleString('en-IN')}` : <span className="text-gray-300" title="No BOQ sale rate found for this line">—</span>}
                              </td>
                              <td className="py-1 pr-3 text-right">
                                {+it.billable_line > 0 ? <span className="font-semibold text-indigo-700">₹{Math.round(+it.billable_line).toLocaleString('en-IN')}</span> : <span className="text-gray-300">—</span>}
                              </td>
                              {/* PO Pending (mam 2026-06-23): indent qty − qty already on a
                                  Vendor PO. Store lines and FOC/RGP don't go on a PO. */}
                              <td className="py-1 pr-3 text-right">
                                {(() => {
                                  if (it.source === 'store' || it.item_type === 'FOC' || it.item_type === 'RGP')
                                    return <span className="text-gray-300" title="Not procured via Vendor PO">—</span>;
                                  const qty = +it.quantity || 0;
                                  const poQty = +it.po_qty || 0;
                                  const pending = Math.max(0, qty - poQty);
                                  if (qty > 0 && pending <= 0)
                                    return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-300" title={`Full qty (${qty}${it.unit ? ' ' + it.unit : ''}) on PO`}>✓ PO done</span>;
                                  return (
                                    <span className="font-semibold text-amber-700"
                                      title={poQty > 0 ? `${poQty} of ${qty}${it.unit ? ' ' + it.unit : ''} already on a PO` : 'Nothing on a Vendor PO yet'}>
                                      {pending}{it.unit ? ` ${it.unit}` : ''}
                                    </span>
                                  );
                                })()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
                </Fragment>
              );
              })}
              {indents.length === 0 && <tr><td colSpan="14" className="text-center py-8 text-gray-400">No indents yet</td></tr>}
              {indents.length > 0 && filteredIndents.length === 0 && <tr><td colSpan="14" className="text-center py-8 text-gray-400">No indents match the current filters — try Reset</td></tr>}
            </tbody>
          </table>
          <Pagination pg={indPg} setPerPage={setIndPerPage} className="border-t border-gray-100" />
          </div>
        </>
        );
      })()}

      {tab === 'rates' && (() => {
        // Status filter (status chip row) + search by indent no /
        // sub-item description + pagination (mam 2026-05-25).
        const rq = ratesSearch.trim().toLowerCase();
        const filteredRates = mergedRates
          .filter(r => ratesFilter === 'all' ? true : (r.rate_status || 'pending') === ratesFilter)
          .filter(r => {
            if (!rq) return true;
            const hay = `${r.indent_number || ''} ${r.master_name || ''} ${r.description || ''} ${r.site_name || ''}`.toLowerCase();
            return hay.includes(rq);
          });
        const ratesPg = usePagination(filteredRates, ratesPerPage, ratesPage, setRatesPage);
        // ── Bulk-fill helpers (mam 2026-06-12) ──────────────────────────
        const rowKey = r => r.indent_item_ids.join('-');
        const selectedRows = filteredRates.filter(r => rateSel[rowKey(r)]);
        const pageAllSelected = ratesPg.rows.length > 0 && ratesPg.rows.every(r => rateSel[rowKey(r)]);
        const toggleRow = r => setRateSel(prev => {
          const k = rowKey(r); const next = { ...prev };
          if (next[k]) delete next[k]; else next[k] = true;
          return next;
        });
        const togglePage = () => setRateSel(prev => {
          const next = { ...prev };
          if (pageAllSelected) ratesPg.rows.forEach(r => { delete next[rowKey(r)]; });
          else ratesPg.rows.forEach(r => { next[rowKey(r)] = true; });
          return next;
        });
        const applyBulkVendor = async () => {
          if (!selectedRows.length) return toast.error('Tick some item rows first');
          if (!bulkVendorName && !bulkTerms) return toast.error('Pick a vendor and/or terms to apply');
          const n = bulkSlot;
          const patch = {};
          if (bulkVendorName) patch[`vendor${n}_name`] = bulkVendorName;
          if (bulkTerms) {
            patch[`vendor${n}_terms`] = bulkTerms;
            patch[`vendor${n}_credit_days`] = bulkTerms === 'Credit' ? (+bulkCreditDays || 0) : 0;
          }
          setBulkApplying(true);
          try {
            const count = selectedRows.length;
            for (const row of selectedRows) await updateMergedRate(row, patch);
            // Clear the tick selection + reset the bar so it's obvious the
            // apply finished (mam 2026-06-12: "after apply it, its is not clear").
            setRateSel({});
            setBulkVendorName('');
            setBulkTerms('');
            setBulkCreditDays('');
            toast.success(`Applied Vendor ${n} to ${count} item(s)`);
          } catch (e) {
            toast.error('Some rows failed to save — please check');
          } finally { setBulkApplying(false); }
        };
        // Edit one row; if that row is TICKED, copy the vendor NAME / TERMS
        // pick to every other ticked row too — so changing one ticked row
        // fills all of them (mam 2026-06-12: "i selected but not impact
        // anothers").  Rate is never copied (each item is priced on its own).
        const editRate = (r, patch) => {
          updateMergedRate(r, patch);
          const k = rowKey(r);
          if (!rateSel[k]) return;                         // edited row not ticked → single edit
          const field = Object.keys(patch)[0] || '';
          if (!/_(name|terms)$/.test(field)) return;       // only propagate name/terms, not rate
          const others = selectedRows.filter(o => rowKey(o) !== k);
          if (!others.length) return;
          for (const o of others) updateMergedRate(o, patch);
          toast.success(`Also applied to ${others.length} other ticked row(s)`);
        };
        return (
        <>
          {/* Vendor Name uses SearchableSelect component now, sourced from
              Vendor Master. The old <datalist> fallback is removed. */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div>
              <h3 className="font-semibold">Item-wise Vendor Rates</h3>
              <p className="text-xs text-gray-500">Step 1: enter up to 3 vendor quotes per indent item. Step 2: finalize the best rate.</p>
              <p className="text-[11px] text-amber-700 mt-0.5">ⓘ Only indents that have cleared L1 + L2 approval appear here. Pending-approval indents will show up automatically after both approvers sign off.</p>
            </div>
            <div className="flex gap-1 flex-wrap">
              {['all','pending','quoted','finalized'].map(f => (
                <button key={f} onClick={() => { setRatesFilter(f); setRatesPage(1); }}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border ${ratesFilter === f ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                  {f === 'all' ? 'All' : f[0].toUpperCase() + f.slice(1)}
                  <span className="ml-1 opacity-80">({mergedRates.filter(r => f === 'all' ? true : (r.rate_status || 'pending') === f).length})</span>
                </button>
              ))}
            </div>
          </div>

          {/* Search toolbar (mam 2026-05-25) */}
          <div className="card p-3 flex flex-wrap items-end gap-2 text-xs">
            <div className="flex-1 min-w-[220px]">
              <label className="label text-[10px] mb-0.5">Search · indent no / item / site</label>
              <input className="input text-xs" placeholder="e.g. IND-0070 or CHECK NUT"
                value={ratesSearch} onChange={e => { setRatesSearch(e.target.value); setRatesPage(1); }} />
            </div>
            {ratesSearch && (
              <button type="button" className="btn btn-secondary text-xs py-1 px-2"
                onClick={() => { setRatesSearch(''); setRatesPage(1); }}>Reset</button>
            )}
            <div className="ml-auto text-[11px] text-gray-500">
              Showing <span className="font-semibold text-gray-700">{filteredRates.length}</span> of {mergedRates.length}
            </div>
          </div>

          {/* Bulk-fill bar (mam 2026-06-12) — tick rows, pick ONE vendor +
              terms, apply to all ticked at once for Vendor 1 / 2 / 3.  Rate
              stays per-item (each item priced individually). */}
          <div className="card p-3 flex flex-wrap items-end gap-2 text-xs border border-blue-200 bg-blue-50/40">
            <div className="text-[11px] font-semibold text-blue-800 mr-1 leading-tight">
              Bulk fill
              <div className="font-normal text-gray-500 text-[10px]">tick rows → pick vendor + terms → Apply</div>
            </div>
            <div>
              <label className="label text-[10px] mb-0.5">Apply to</label>
              <div className="flex gap-1">
                {[1,2,3].map(n => (
                  <button key={n} type="button" onClick={() => setBulkSlot(n)}
                    className={`px-2 py-1 rounded border text-[11px] font-semibold ${bulkSlot === n ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                    Vendor {n}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-w-[200px]">
              <label className="label text-[10px] mb-0.5">Vendor</label>
              <SearchableSelect
                options={vendorOptions}
                value={bulkVendorName || null}
                valueKey="name" displayKey="label"
                placeholder="Pick vendor"
                buttonClassName="text-[11px] px-2 py-1 w-full border border-gray-200 rounded-md bg-white hover:border-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-400 text-left flex items-center justify-between gap-1 cursor-pointer"
                onChange={(v) => setBulkVendorName(v?.name || '')}
              />
            </div>
            <div>
              <label className="label text-[10px] mb-0.5">Terms</label>
              <select className="select text-xs" style={{ width: '100px' }} value={bulkTerms} onChange={e => setBulkTerms(e.target.value)}>
                <option value="">—</option>
                <option value="Advance">Advance</option>
                <option value="Credit">Credit</option>
              </select>
            </div>
            {bulkTerms === 'Credit' && (
              <div>
                <label className="label text-[10px] mb-0.5">Credit days</label>
                <input type="number" min="0" className="input text-xs text-right" style={{ width: '80px' }} placeholder="days"
                  value={bulkCreditDays} onChange={e => setBulkCreditDays(e.target.value)} />
              </div>
            )}
            <button type="button" disabled={bulkApplying || !selectedRows.length} onClick={applyBulkVendor}
              className="btn btn-primary text-xs py-1 px-3 disabled:opacity-40">
              {bulkApplying ? 'Applying…' : `Apply to ${selectedRows.length} ticked`}
            </button>
            {selectedRows.length > 0 && (
              <button type="button" className="btn btn-secondary text-xs py-1 px-2" onClick={() => setRateSel({})}>
                Clear ({selectedRows.length})
              </button>
            )}
          </div>

          {/* Desktop table — BOQ Item column intentionally removed:
              mam's spec is purchase team enters a vendor rate ONCE per
              (indent · sub-item), regardless of which BOQ line that
              sub-item came from. The same CHECK NUT used in two BOQs
              of one indent is now a SINGLE merged row. */}
          {/* freeze-2col + explicit --freeze-col-1-w pins Indent + Sub-Item
              while scrolling rate columns horizontally (mam 2026-05-25). */}
          <div className="card p-0 overflow-x-auto hidden lg:block" style={{ '--freeze-col-1-w': '150px' }}>
            <table className="text-xs freeze-2col" style={{ minWidth: '1400px' }}>
              <thead>
                <tr className="bg-gray-50">
                  {/* width matches --freeze-col-1-w so the 2nd sticky column
                      sits flush against this one with no gap or overlap. */}
                  <th className="px-2 py-2 text-left" rowSpan="2" style={{ width: '150px', minWidth: '150px' }}>
                    <div className="flex items-center gap-1.5">
                      <input type="checkbox" checked={pageAllSelected} onChange={togglePage} title="Select all rows on this page" />
                      <span>Indent</span>
                    </div>
                  </th>
                  <th className="px-2 py-2 text-left" rowSpan="2" style={{ width: '260px', minWidth: '260px' }}>Sub-Item<br/><span className="text-[9px] font-normal text-gray-400 normal-case">(Item Master)</span></th>
                  <th className="px-2 py-2" rowSpan="2">Qty</th>
                  <th className="px-2 py-2" rowSpan="2" title="Purchase Price from the Order-to-Planning BOQ — suggestion only, doesn't change vendor rates">PP Rate<br/><span className="text-[9px] font-normal text-gray-400 normal-case">(planning)</span></th>
                  <th className="px-2 py-2" rowSpan="2" title="AI-estimated MINIMUM market rate, auto-filled — suggestion only, doesn't change vendor rates">Mktg Rate<br/><span className="text-[9px] font-normal text-gray-400 normal-case">(AI · min mkt)</span></th>
                  <th className="px-2 py-2 text-center" colSpan="3">Vendor 1</th>
                  <th className="px-2 py-2 text-center" colSpan="3">Vendor 2</th>
                  <th className="px-2 py-2 text-center" colSpan="3">Vendor 3</th>
                  <th className="px-2 py-2" rowSpan="2">Status</th>
                  <th className="px-2 py-2" rowSpan="2">Final</th>
                </tr>
                <tr className="bg-gray-50 text-[10px]">
                  <th className="px-2 py-1">Name</th><th className="px-2 py-1">Rate</th><th className="px-2 py-1">Terms</th>
                  <th className="px-2 py-1">Name</th><th className="px-2 py-1">Rate</th><th className="px-2 py-1">Terms</th>
                  <th className="px-2 py-1">Name</th><th className="px-2 py-1">Rate</th><th className="px-2 py-1">Terms</th>
                </tr>
              </thead>
              <tbody>
                {ratesPg.rows.map(r => {
                  const stat = r.rate_status || 'pending';
                  const statColor = stat === 'finalized' ? 'bg-emerald-100 text-emerald-700' : stat === 'quoted' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700';
                  return (
                    <tr key={r.indent_item_ids.join('-')} className={`border-b hover:bg-red-50/30 ${rateSel[rowKey(r)] ? 'bg-blue-50/60' : ''}`}>
                      <td className="px-2 py-2 whitespace-nowrap">
                        <div className="flex items-start gap-1.5">
                          <input type="checkbox" className="mt-0.5" checked={!!rateSel[rowKey(r)]} onChange={() => toggleRow(r)} />
                          <div>
                            <div className="font-medium text-red-700">{r.indent_number}</div>
                            <div className="text-[10px] text-gray-400">{r.site_name}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-2 align-top" style={{ width: '260px', minWidth: '260px', maxWidth: '260px' }}>
                        {r.item_code && <div className="text-[10px] font-mono text-gray-500">[{r.item_code}]</div>}
                        <div className="text-[11px] leading-snug font-medium">
                          {[r.master_name || r.description, r.specification, r.size].filter(Boolean).join(' / ') || <span className="text-gray-300">—</span>}
                        </div>
                        {r.make && <div className="text-[10px] text-gray-400 mt-0.5">Make: {r.make}</div>}
                        {r.indent_item_ids.length > 1 && (
                          <div className="text-[9px] text-gray-400 mt-0.5 italic">merged from {r.indent_item_ids.length} BOQ rows</div>
                        )}
                      </td>
                      <td className="px-2 py-2 text-center font-semibold whitespace-nowrap">
                        {(+r.weight_per_meter > 0) ? (
                          <div>
                            <div>{(Math.round(r.qty * r.weight_per_meter * 100) / 100).toLocaleString('en-IN')} <span className="text-blue-700">KG</span></div>
                            <div className="text-[9px] font-normal text-gray-500">{r.qty} MTR × {r.weight_per_meter} kg/pipe</div>
                          </div>
                        ) : (
                          <>{r.qty} {cleanUnit(r.unit || r.uom)}</>
                        )}
                      </td>
                      {/* PP Rate (purchase price from planning) — suggestion only */}
                      <td className="px-2 py-2 text-center whitespace-nowrap text-[11px]">
                        {+r.pp_rate > 0
                          ? <span className="font-semibold text-indigo-700">Rs {(+r.pp_rate).toLocaleString('en-IN')}</span>
                          : <span className="text-gray-300" title="No purchase price entered in Order-to-Planning for this item">—</span>}
                      </td>
                      {/* Marketing Rate (AI, auto-filled min market rate) — suggestion only */}
                      <td className="px-2 py-2 text-center whitespace-nowrap text-[11px]">
                        {+r.marketing_rate > 0 ? (
                          <>
                            <div className="font-semibold text-fuchsia-700 mb-0.5">Rs {(+r.marketing_rate).toLocaleString('en-IN')}</div>
                            <button type="button" onClick={() => aiSuggestRate(r)} disabled={!!aiBusy[r.indent_item_ids[0]]}
                              className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-fuchsia-100 text-fuchsia-700 border border-fuchsia-300 hover:bg-fuchsia-600 hover:text-white disabled:opacity-50"
                              title="Re-estimate the minimum market rate with AI">{aiBusy[r.indent_item_ids[0]] ? '…' : '↻'}</button>
                          </>
                        ) : (
                          <span className="text-fuchsia-400 text-[10px] animate-pulse" title="AI is estimating the minimum market rate…">AI…</span>
                        )}
                      </td>
                      {[1,2,3].map(n => (
                        <Fragment key={n}>
                          <td className="px-1 py-1" style={{ minWidth: '200px', width: '200px' }}>
                            {/* Vendor picker — searchable dropdown sourced from
                                Vendor Master. Saves vendor.name on the rate
                                row so downstream code (finalize / Vendor PO)
                                keeps working with the existing name column. */}
                            <SearchableSelect
                              options={vendorOptions}
                              value={r[`vendor${n}_name`] || null}
                              valueKey="name" displayKey="label"
                              placeholder="Pick vendor"
                              buttonClassName="text-[11px] px-2 py-1 w-full border border-gray-200 rounded-md bg-white hover:border-gray-300 focus:outline-none focus:ring-1 focus:ring-red-400 text-left flex items-center justify-between gap-1 cursor-pointer"
                              onChange={(v) => editRate(r, { [`vendor${n}_name`]: v?.name || '' })}
                            />
                          </td>
                          <td className="px-1 py-1" style={{ minWidth: '120px' }}>
                            <input
                              className="input text-[11px] px-2 py-1 text-right"
                              style={{ width: '110px', minWidth: '110px' }}
                              type="number"
                              placeholder="0"
                              value={r[`vendor${n}_rate`] || ''}
                              onChange={e => updateMergedRate(r, { [`vendor${n}_rate`]: +e.target.value })}
                            />
                          </td>
                          <td className="px-1 py-1" style={{ minWidth: '180px' }}>
                            <div className="flex items-center gap-1">
                              <select
                                className="select text-[11px] px-2 py-1"
                                style={{ width: '90px', minWidth: '90px' }}
                                value={r[`vendor${n}_terms`] || ''}
                                onChange={e => editRate(r, { [`vendor${n}_terms`]: e.target.value })}
                              >
                                <option value="">—</option>
                                <option value="Advance">Advance</option>
                                <option value="Credit">Credit</option>
                              </select>
                              {/* Manual credit days entry — only when Credit
                                  is selected, otherwise hidden so Advance
                                  rows stay clean. */}
                              {r[`vendor${n}_terms`] === 'Credit' && (
                                <input
                                  type="number"
                                  min="0"
                                  className="input text-[11px] px-1 py-1 text-right"
                                  style={{ width: '70px' }}
                                  placeholder="days"
                                  value={r[`vendor${n}_credit_days`] || ''}
                                  onChange={e => updateMergedRate(r, { [`vendor${n}_credit_days`]: +e.target.value || 0 })}
                                  title="Credit days"
                                />
                              )}
                            </div>
                          </td>
                        </Fragment>
                      ))}
                      <td className="px-2 py-2"><span className={`badge ${statColor}`}>{stat}</span></td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-1">
                          {stat === 'finalized'
                            ? <div className="text-[11px]"><div className="font-semibold text-emerald-700">{r.final_vendor_name}</div><div>Rs {r.final_rate}</div></div>
                            : <button onClick={() => openFinalize(r)} disabled={stat === 'pending'} className="btn btn-primary text-[11px] px-2 py-1 disabled:opacity-40">Finalize</button>}
                          {/* Admin-only: clear ALL vendor quotes for this row.
                              Useful when mam wants to re-quote (wrong rates,
                              vendor change, etc.). Returns row to Pending. */}
                          {(canApprove('procurement') || isAdmin()) && r.rate_ids?.length > 0 && (
                            <button onClick={() => deleteMergedRate(r)} className="p-1 text-gray-400 hover:text-red-600" title="Clear all quotes (re-quote)">
                              <FiTrash2 size={12} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {mergedRates.length === 0 && <tr><td colSpan="14" className="text-center py-8 text-gray-400">No indent items yet — raise an indent first.</td></tr>}
              </tbody>
            </table>
          </div>

          {/* Mobile card layout — uses the same merged-by-(indent · sub-item)
              data so the same item across multiple BOQs collapses to ONE
              card with the combined qty. */}
          <div className="lg:hidden space-y-2">
            {ratesPg.rows.map(r => {
              const stat = r.rate_status || 'pending';
              return (
                <div key={r.indent_item_ids.join('-')} className={`card p-3 space-y-2 ${rateSel[rowKey(r)] ? 'ring-1 ring-blue-300 bg-blue-50/40' : ''}`}>
                  <div className="flex justify-between items-start gap-2">
                    <div className="flex items-start gap-2">
                      <input type="checkbox" className="mt-1" checked={!!rateSel[rowKey(r)]} onChange={() => toggleRow(r)} title="Tick for bulk fill" />
                      <div>
                      <div className="font-medium text-red-700 text-xs">{r.indent_number}</div>
                      {r.item_code && <div className="text-[10px] font-mono text-gray-500">[{r.item_code}]</div>}
                      <div className="text-sm font-medium line-clamp-2">{[r.master_name || r.description, r.specification, r.size].filter(Boolean).join(' / ')}</div>
                      <div className="text-[10px] text-gray-400">{r.site_name} · {r.qty} {cleanUnit(r.unit || r.uom)}{r.make ? ` · ${r.make}` : ''}</div>
                      {r.indent_item_ids.length > 1 && (
                        <div className="text-[9px] text-gray-400 italic mt-0.5">merged from {r.indent_item_ids.length} BOQ rows</div>
                      )}
                      </div>
                    </div>
                    <span className={`badge ${stat === 'finalized' ? 'badge-green' : stat === 'quoted' ? 'badge-blue' : 'badge-yellow'}`}>{stat}</span>
                  </div>
                  {[1,2,3].map(n => (
                    <div key={n} className="border rounded p-2 bg-gray-50">
                      <div className="text-[10px] font-bold text-gray-500 uppercase mb-1">Vendor {n}</div>
                      {/* Mobile layout: full-width Name on top (searchable
                          Vendor Master dropdown), Rate + Terms share the row
                          below. */}
                      <div className="mb-2">
                        <SearchableSelect
                          options={vendorOptions}
                          value={r[`vendor${n}_name`] || null}
                          valueKey="name" displayKey="label"
                          placeholder="Pick vendor from master"
                          buttonClassName="input text-xs w-full text-left flex items-center justify-between gap-1 cursor-pointer"
                          onChange={(v) => editRate(r, { [`vendor${n}_name`]: v?.name || '' })}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <input className="input text-xs" type="number" placeholder="Rate" value={r[`vendor${n}_rate`] || ''} onChange={e => updateMergedRate(r, { [`vendor${n}_rate`]: +e.target.value })} />
                        <select className="select text-xs" value={r[`vendor${n}_terms`] || ''} onChange={e => editRate(r, { [`vendor${n}_terms`]: e.target.value })}>
                          <option value="">— Terms —</option>
                          <option value="Advance">Advance</option>
                          <option value="Credit">Credit</option>
                        </select>
                      </div>
                    </div>
                  ))}
                  {stat === 'finalized'
                    ? <div className="bg-emerald-50 border border-emerald-200 rounded p-2 text-xs"><b className="text-emerald-700">Final:</b> {r.final_vendor_name} @ Rs {r.final_rate}</div>
                    : <button onClick={() => openFinalize(r)} disabled={stat === 'pending'} className="btn btn-primary text-xs w-full disabled:opacity-40">Finalize Rate</button>}
                </div>
              );
            })}
            {mergedRates.length === 0 && <div className="card text-center py-8 text-gray-400">No indent items yet.</div>}
            {mergedRates.length > 0 && filteredRates.length === 0 && <div className="card text-center py-8 text-gray-400">No items match the current filters.</div>}
          </div>
          {/* Shared pagination for both desktop + mobile renderings */}
          <div className="card"><Pagination pg={ratesPg} setPerPage={setRatesPerPage} /></div>
        </>
        );
      })()}

      {tab === 'vendorpo' && (() => {
        // Sub-tab filtering (mam 2026-05-25):
        //   pending  → "Pending for Vendor PO" (yellow highlight, items waiting)
        //   list     → "View by PO"            (the full vendor_pos table)
        // Each sub-tab has its own search + filter + pagination state.
        const pSearch = vpoPendingSearch.trim().toLowerCase();
        const filteredPending = pendingPoItems.filter(p => {
          if (vpoPendingStatus !== 'all' && (p.rate_status || 'pending') !== vpoPendingStatus) return false;
          if (!pSearch) return true;
          const hay = `${p.indent_number || ''} ${p.site_name || ''} ${p.master_name || ''} ${p.description || ''}`.toLowerCase();
          return hay.includes(pSearch);
        });
        const pendingPg = usePagination(filteredPending, vpoPendingPerPage, vpoPendingPage, setVpoPendingPage);

        const lSearch = vpoListSearch.trim().toLowerCase();
        const filteredList = vendorPos.filter(v => {
          if (vpoListStatus !== 'all' && (v.cancelled ? 'cancelled' : v.status) !== vpoListStatus) return false;
          if (vpoListFrom && v.po_date && v.po_date < vpoListFrom) return false;
          if (vpoListTo   && v.po_date && v.po_date > vpoListTo) return false;
          if (!lSearch) return true;
          const hay = `${v.po_number || ''} ${v.indent_number || ''} ${v.vendor_name || ''} ${v.indent_site_name || ''}`.toLowerCase();
          return hay.includes(lSearch);
        });
        const listPg = usePagination(filteredList, vpoListPerPage, vpoListPage, setVpoListPage);
        return (
        <>
          <div className="flex justify-between items-center flex-wrap gap-2">
            <h3 className="font-semibold">Vendor Purchase Orders</h3>
            <button onClick={() => openCreateVendorPo('')} className="btn btn-primary flex items-center gap-2"><FiPlus /> Create Vendor PO</button>
          </div>

          {/* Sub-tabs (mam 2026-05-25) — yellow tinted for the Pending tab
              since those are urgent waiting items, neutral for the full list. */}
          <div className="flex gap-1 border-b border-gray-200">
            <button onClick={() => setVpoSubTab('pending')}
              className={`px-3 py-1.5 text-xs font-semibold border-b-2 -mb-px ${vpoSubTab === 'pending' ? 'border-amber-500 text-amber-700 bg-amber-50' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              Pending for Vendor PO <span className="ml-1 text-[10px] opacity-80">({pendingPoItems.length})</span>
            </button>
            <button onClick={() => setVpoSubTab('list')}
              className={`px-3 py-1.5 text-xs font-semibold border-b-2 -mb-px ${vpoSubTab === 'list' ? 'border-red-600 text-red-700 bg-red-50' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              View by PO <span className="ml-1 text-[10px] opacity-80">({vendorPos.length})</span>
            </button>
          </div>

          {/* ===== Sub-tab 1: Pending for Vendor PO ===== */}
          {vpoSubTab === 'pending' && pendingPoItems.length === 0 && (
            <div className="card text-center py-8 text-gray-400 text-xs">All finalized rates are already on a Vendor PO. 🎉</div>
          )}
          {vpoSubTab === 'pending' && pendingPoItems.length > 0 && (
            <div className="card p-3 bg-amber-50 border border-amber-200">
              <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                <h4 className="font-semibold text-amber-800 text-sm">
                  Pending for Vendor PO
                  <span className="text-xs font-normal text-amber-600 ml-2">
                    ({(() => {
                      const finalisedCount = pendingPoItems.filter(p => (p.rate_status || 'pending') === 'finalized').length;
                      return `${finalisedCount} ready · ${pendingPoItems.length} total`;
                    })()})
                  </span>
                </h4>
                <span className="text-[11px] text-amber-700">Showing finalized-rate items by default — flip the Rate Status filter to see still-quoting / pending items.</span>
              </div>
              {/* Search + status filter strip (mam 2026-05-25) */}
              <div className="flex flex-wrap items-end gap-2 text-xs mb-3 pb-3 border-b border-amber-200">
                <div className="flex-1 min-w-[200px]">
                  <label className="label text-[10px] mb-0.5 text-amber-900">Search · indent no / item</label>
                  <input className="input text-xs" placeholder="e.g. IND-0070 or CHECK NUT"
                    value={vpoPendingSearch} onChange={e => { setVpoPendingSearch(e.target.value); setVpoPendingPage(1); }} />
                </div>
                <div>
                  <label className="label text-[10px] mb-0.5 text-amber-900">Rate Status</label>
                  <select className="select text-xs" value={vpoPendingStatus}
                    onChange={e => { setVpoPendingStatus(e.target.value); setVpoPendingPage(1); }}>
                    <option value="finalized">Finalized (ready for PO)</option>
                    <option value="quoted">Quoted</option>
                    <option value="pending">Pending</option>
                    <option value="all">All (show everything)</option>
                  </select>
                </div>
                {(vpoPendingSearch || vpoPendingStatus !== 'all') && (
                  <button type="button" className="btn btn-secondary text-xs py-1 px-2"
                    onClick={() => { setVpoPendingSearch(''); setVpoPendingStatus('all'); setVpoPendingPage(1); }}>Reset</button>
                )}
                <div className="ml-auto text-[11px] text-amber-900">
                  Showing <span className="font-semibold">{filteredPending.length}</span> of {pendingPoItems.length}
                </div>
              </div>
              <div className="hidden md:block overflow-auto max-h-[70vh]">
                <table className="text-xs freeze-head">
                  <thead><tr className="bg-amber-100/50">
                    <th className="px-2 py-1 text-left">Indent</th>
                    <th className="px-2 py-1 text-left">Item</th>
                    <th className="px-2 py-1">Qty</th>
                    <th className="px-2 py-1">Final Rate</th>
                    <th className="px-2 py-1">Final Vendor</th>
                    <th className="px-2 py-1">Status</th>
                    <th className="px-2 py-1"></th>
                  </tr></thead>
                  <tbody>
                    {pendingPg.rows.map(p => {
                      // Prefer Item Master values for display (what mam picked in the indent)
                      const displayName = [p.master_name || p.description, p.specification, p.size].filter(Boolean).join(' / ');
                      return (
                        <tr key={p.indent_item_id} className="border-b border-amber-100">
                          <td className="px-2 py-1.5 whitespace-nowrap"><b className="text-red-700">{p.indent_number}</b><div className="text-[10px] text-gray-500">{p.site_name}</div></td>
                          <td className="px-2 py-1.5 max-w-[320px]">
                            {p.item_code && <div className="text-[10px] font-mono text-gray-500">[{p.item_code}]</div>}
                            <div className="whitespace-normal leading-snug font-medium">{displayName}</div>
                            <div className="text-[10px] text-gray-400 flex gap-2">
                              {p.make && <span>Make: {p.make}</span>}
                              {p.item_type && <span className={`font-bold ${p.item_type === 'FOC' ? 'text-emerald-600' : p.item_type === 'RGP' ? 'text-amber-600' : 'text-red-600'}`}>{p.item_type}</span>}
                            </div>
                          </td>
                          <td className="px-2 py-1.5 text-center">{p.quantity} {p.unit || p.uom}</td>
                          <td className="px-2 py-1.5 text-right">{p.final_rate ? `Rs ${p.final_rate}` : <span className="text-gray-400">—</span>}</td>
                          <td className="px-2 py-1.5">{p.final_vendor_name || <span className="text-gray-400">—</span>}</td>
                          <td className="px-2 py-1.5">
                            <span className={`badge ${p.rate_status === 'finalized' ? 'badge-green' : 'badge-yellow'}`}>{p.rate_status || 'pending'}</span>
                          </td>
                          <td className="px-2 py-1.5">
                            <button onClick={() => openCreateVendorPo(p.indent_id)} className="btn btn-primary text-[10px] px-2 py-1">Create PO</button>
                          </td>
                        </tr>
                      );
                    })}
                    {filteredPending.length === 0 && (
                      <tr><td colSpan="7" className="text-center py-6 text-amber-700">No items match the current filters.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards — mam (2026-06-02): "i want mobile view
                  changes like this type cards in all steps in indent
                  to dispatch".  Same visual language as the Indents
                  card: small "LABEL" header, big bold ID, status pill
                  on right, site row with pin, 3-col info grid, links
                  row with border-top, big full-width action button. */}
              <div className="md:hidden space-y-3">
                {pendingPg.rows.map(p => {
                  const displayName = [p.master_name || p.description, p.specification, p.size].filter(Boolean).join(' / ');
                  const stat = p.rate_status || 'pending';
                  return (
                    <div key={p.indent_item_id} className="card p-3 space-y-2">
                      {/* Header: indent # · status */}
                      <div className="flex justify-between items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Indent No</div>
                          <div className="text-lg font-bold text-gray-900 truncate">{p.indent_number}</div>
                        </div>
                        <StatusBadge status={stat} />
                      </div>
                      {/* Site */}
                      {p.site_name && (
                        <div className="flex items-start gap-1.5 text-xs">
                          <FiMapPin size={12} className="mt-0.5 text-red-500 flex-shrink-0" />
                          <div className="min-w-0">
                            <div className="text-[10px] uppercase text-gray-400">Site</div>
                            <div className="font-medium text-gray-800">{p.site_name}</div>
                          </div>
                        </div>
                      )}
                      {/* Sub-item description */}
                      <div className="pt-1 border-t border-gray-100">
                        <div className="text-[10px] uppercase text-gray-400 mb-0.5">Sub-Item</div>
                        {p.item_code && <div className="text-[10px] font-mono text-gray-500">[{p.item_code}]</div>}
                        <div className="text-sm font-medium text-gray-800 leading-snug">{displayName || '—'}</div>
                        <div className="text-[10px] text-gray-500 mt-0.5 flex flex-wrap gap-x-2">
                          {p.make && <span>Make: <b className="text-gray-700">{p.make}</b></span>}
                          {p.item_type && (
                            <span className={`font-bold ${p.item_type === 'FOC' ? 'text-emerald-600' : p.item_type === 'RGP' ? 'text-amber-600' : 'text-red-600'}`}>
                              {p.item_type}
                            </span>
                          )}
                        </div>
                      </div>
                      {/* 3-col info grid: Qty · Rate · Vendor */}
                      <div className="grid grid-cols-3 gap-2 pt-1 border-t border-gray-100 text-[11px]">
                        <div>
                          <div className="text-[9px] uppercase text-gray-400">Qty</div>
                          <div className="font-semibold text-gray-800">{p.quantity} {p.unit || p.uom || ''}</div>
                        </div>
                        <div>
                          <div className="text-[9px] uppercase text-gray-400">Final Rate</div>
                          <div className="font-semibold text-gray-800">{p.final_rate ? `Rs ${p.final_rate}` : <span className="text-gray-300">—</span>}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-[9px] uppercase text-gray-400">Vendor</div>
                          <div className="font-medium text-gray-700 truncate" title={p.final_vendor_name}>{p.final_vendor_name || <span className="text-gray-300">—</span>}</div>
                        </div>
                      </div>
                      {/* Action — same green primary as Approve buttons */}
                      <button
                        onClick={() => openCreateVendorPo(p.indent_id)}
                        disabled={stat !== 'finalized'}
                        className="btn btn-primary text-sm py-2 px-3 w-full mt-1 disabled:opacity-50"
                      >
                        + Create Vendor PO
                      </button>
                    </div>
                  );
                })}
                {filteredPending.length === 0 && (
                  <div className="card p-6 text-center text-gray-400 text-sm">No items match the current filters.</div>
                )}
              </div>
              <Pagination pg={pendingPg} setPerPage={setVpoPendingPerPage} className="border-t border-amber-200 pt-2" />
            </div>
          )}

          {/* ===== Sub-tab 2: View by PO ===== */}
          {vpoSubTab === 'list' && (
            <>
              <div className="card p-3 flex flex-wrap items-end gap-2 text-xs">
                <div className="flex-1 min-w-[200px]">
                  <label className="label text-[10px] mb-0.5">Search · PO no / indent / vendor / site</label>
                  <input className="input text-xs" placeholder="e.g. VPO-0042 or IND-0070"
                    value={vpoListSearch} onChange={e => { setVpoListSearch(e.target.value); setVpoListPage(1); }} />
                </div>
                <div>
                  <label className="label text-[10px] mb-0.5">Status</label>
                  <select className="select text-xs" value={vpoListStatus}
                    onChange={e => { setVpoListStatus(e.target.value); setVpoListPage(1); }}>
                    <option value="all">All</option>
                    <option value="open">Open</option>
                    <option value="received">Received</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </div>
                <div>
                  <label className="label text-[10px] mb-0.5">PO Date From</label>
                  <input className="input text-xs" type="date" value={vpoListFrom}
                    onChange={e => { setVpoListFrom(e.target.value); setVpoListPage(1); }} />
                </div>
                <div>
                  <label className="label text-[10px] mb-0.5">PO Date To</label>
                  <input className="input text-xs" type="date" value={vpoListTo}
                    onChange={e => { setVpoListTo(e.target.value); setVpoListPage(1); }} />
                </div>
                {(vpoListSearch || vpoListStatus !== 'all' || vpoListFrom || vpoListTo) && (
                  <button type="button" className="btn btn-secondary text-xs py-1 px-2"
                    onClick={() => { setVpoListSearch(''); setVpoListStatus('all'); setVpoListFrom(''); setVpoListTo(''); setVpoListPage(1); }}>Reset</button>
                )}
                <div className="ml-auto text-[11px] text-gray-500">
                  Showing <span className="font-semibold text-gray-700">{filteredList.length}</span> of {vendorPos.length}
                </div>
              </div>

          <div className="card p-0 overflow-auto max-h-[70vh] hidden md:block"><table className="freeze-head freeze-col">
            <thead><tr><th>PO Number</th><th>Indent</th><th>PO Date</th><th>Vendor</th><th>Amount</th><th>File</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {listPg.rows.map(v => (
                <tr key={v.id}>
                  <td className="font-medium">
                    {v.po_number}
                    <PaymentBlockChip v={v} />
                  </td>
                  {/* Indent column (mam, 2026-05-20). */}
                  <td className="text-xs">
                    <div className="font-mono font-semibold text-blue-800">{v.indent_number || <span className="text-gray-300">—</span>}</div>
                    {v.indent_site_name && <div className="text-[10px] text-gray-500 truncate max-w-[140px]" title={v.indent_site_name}>{v.indent_site_name}</div>}
                  </td>
                  <td>{v.po_date || <span className="text-gray-300">—</span>}</td>
                  <td>{v.vendor_name}</td>
                  <td>Rs {v.total_amount?.toLocaleString()}</td>
                  <td>
                    <div className="flex flex-col gap-1">
                      <a href={`/vendor-po/${v.id}/print`} target="_blank" rel="noopener noreferrer" className="text-red-600 hover:text-red-800 underline text-xs flex items-center gap-1">
                        <FiPrinter size={11} /> View / Print
                      </a>
                      {/* Mam (2026-05-22): "show here also delivery
                          note" — DN link on every PO row across the
                          procurement views. */}
                      <a href={`/vendor-po/${v.id}/delivery-note`} target="_blank" rel="noopener noreferrer" className="text-emerald-700 hover:text-emerald-900 underline text-xs flex items-center gap-1">
                        🚚 Delivery Note
                      </a>
                      {v.file_path && <a href={v.file_path} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline text-[10px]">attached PDF</a>}
                    </div>
                  </td>
                  <td>
                    {v.cancelled
                      ? <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-gray-200 text-gray-600 border border-gray-300" title={v.cancel_reason || 'Cancelled'}>Cancelled</span>
                      : (v.po_approval === 'pending_l1' || v.po_approval === 'pending_l2')
                        ? <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300" title={`Awaiting ${v.po_pending_approver}`}>Pending {v.po_approval === 'pending_l1' ? 'L1' : 'L2'} · {v.po_pending_approver}</span>
                        : v.po_approval === 'rejected'
                          ? <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-red-100 text-red-700 border border-red-300" title={v.po_reject_reason || 'Rejected'}>Rejected</span>
                          : <StatusBadge status={v.status} />}
                  </td>
                  <td>
                    {/* Three actions: Cancel (soft-delete, reverses), Restore
                        (only when already cancelled), Delete (hard, only when
                        no bills / delivery notes block it). */}
                    <div className="flex items-center gap-1">
                      {/* PO approval (mam 2026-06-19): L1 Nitin Jain → L2 Ankur
                          Kaplesh. Approve/Reject show only to the pending-level
                          approver (or admin / COO). */}
                      {!v.cancelled && canApprovePo(v) && (
                        <>
                          <button onClick={() => approvePo(v)} className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-700" title={`Approve ${v.po_approval === 'pending_l1' ? 'L1' : 'L2'}`}>✓ Approve</button>
                          <button onClick={() => rejectPo(v)} className="text-[10px] font-bold px-2 py-0.5 rounded bg-red-100 text-red-700 border border-red-300 hover:bg-red-600 hover:text-white" title="Reject PO">✕</button>
                        </>
                      )}
                      {/* Mark Payment Cleared (mam 2026-05-27) — internal
                          one-click unblock when the advance / old payment
                          has been settled. Only shows when a block is
                          pending. Tiny green button so it doesn't dominate. */}
                      {!v.cancelled && v.payment_block_status === 'pending' && (canApprove('procurement') || isAdmin()) && (
                        <button onClick={() => markPaymentCleared(v.id)}
                                className="text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-300 hover:bg-emerald-600 hover:text-white transition"
                                title="Mark advance / old payment as cleared (internal)">
                          ✓ Clear pmt
                        </button>
                      )}
                      {/* Edit (pencil) — mam (2026-05-20): "how can i
                          edit po after creation because some time
                          need".  Opens a modal with the safe-to-edit
                          header fields.  Hidden once cancelled
                          (restore first). */}
                      {!v.cancelled && (canApprove('procurement') || isAdmin()) && (
                        <button onClick={() => openEditVendorPo(v)}
                                className="p-1 text-gray-400 hover:text-blue-700"
                                title="Edit PO (date / amount / advance / remarks)">
                          <FiEdit2 size={14} />
                        </button>
                      )}
                      {!v.cancelled && (canApprove('procurement') || isAdmin()) && (
                        <button onClick={async () => {
                          const reason = prompt(`Cancel Vendor PO "${v.po_number}"?\n\nThe PO + linked bills/notes stay visible for audit, but it disappears from active follow-ups. Items go back to "Pending for PO".\n\nReason (optional):`);
                          if (reason === null) return;
                          try { await api.post(`/procurement/vendor-po/${v.id}/cancel`, { reason }); toast.success('PO cancelled'); load(); }
                          catch (err) { toast.error(err.response?.data?.error || 'Cancel failed'); }
                        }} className="p-1 text-gray-400 hover:text-amber-600" title="Cancel PO (soft delete)"><FiX size={14} /></button>
                      )}
                      {v.cancelled && (canApprove('procurement') || isAdmin()) && (
                        <button onClick={async () => {
                          if (!confirm(`Restore Vendor PO "${v.po_number}" from cancelled?`)) return;
                          try { await api.post(`/procurement/vendor-po/${v.id}/uncancel`); toast.success('PO restored'); load(); }
                          catch (err) { toast.error(err.response?.data?.error || 'Restore failed'); }
                        }} className="p-1 text-gray-400 hover:text-emerald-600" title="Restore PO"><FiCheck size={14} /></button>
                      )}
                      {canDelete('procurement') && (
                        <button onClick={async () => {
                          if (!confirm(`Permanently delete vendor PO "${v.po_number}"?\n\nWill fail if bills or delivery notes reference it — use Cancel instead in that case.`)) return;
                          try { await api.delete(`/procurement/vendor-po/${v.id}`); toast.success('Deleted'); load(); }
                          catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                        }} className="p-1 text-gray-400 hover:text-red-600" title="Delete (hard)"><FiTrash2 size={14} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {vendorPos.length === 0 && <tr><td colSpan="8" className="text-center py-8 text-gray-400">No vendor POs yet — click "Create Vendor PO"</td></tr>}
              {vendorPos.length > 0 && filteredList.length === 0 && <tr><td colSpan="8" className="text-center py-8 text-gray-400">No POs match the current filters.</td></tr>}
            </tbody>
            <tfoot><tr><td colSpan="8" className="border-t border-gray-100"><Pagination pg={listPg} setPerPage={setVpoListPerPage} /></td></tr></tfoot>
          </table></div>

          {/* Mobile cards — polished pattern matching Indents card. */}
          <div className="md:hidden space-y-3">
            {listPg.rows.map(v => (
              <div key={v.id} className={`card p-3 space-y-2 ${v.cancelled ? 'opacity-60' : ''}`}>
                {/* Header: PO # · status */}
                <div className="flex justify-between items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Vendor PO No</div>
                    <div className="text-lg font-bold text-gray-900 truncate">{v.po_number}</div>
                    <div className="text-[11px] text-gray-500 flex items-center gap-1 mt-0.5">
                      <FiCalendar size={10} className="text-gray-400" />
                      {v.po_date || '—'}
                    </div>
                    <PaymentBlockChip v={v} />
                  </div>
                  {v.cancelled
                    ? <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border border-gray-300 text-gray-600 bg-gray-50" title={v.cancel_reason || 'Cancelled'}>Cancelled</span>
                    : (v.po_approval === 'pending_l1' || v.po_approval === 'pending_l2')
                      ? <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-300" title={`Awaiting ${v.po_pending_approver}`}>Pending {v.po_approval === 'pending_l1' ? 'L1' : 'L2'}</span>
                      : v.po_approval === 'rejected'
                        ? <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-300" title={v.po_reject_reason || 'Rejected'}>Rejected</span>
                        : <StatusBadge status={v.status} />}
                </div>
                {/* Site */}
                {v.indent_site_name && (
                  <div className="flex items-start gap-1.5 text-xs">
                    <FiMapPin size={12} className="mt-0.5 text-red-500 flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="text-[10px] uppercase text-gray-400">Site</div>
                      <div className="font-medium text-gray-800">{v.indent_site_name}</div>
                    </div>
                  </div>
                )}
                {/* 3-col info: Indent · Vendor · Amount */}
                <div className="grid grid-cols-3 gap-2 pt-1 border-t border-gray-100 text-[11px]">
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">Indent</div>
                    <div className="font-mono font-semibold text-blue-800 truncate">{v.indent_number || '—'}</div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">Vendor</div>
                    <div className="font-medium text-gray-700 truncate" title={v.vendor_name}>{v.vendor_name || '—'}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[9px] uppercase text-gray-400">Amount</div>
                    <div className="font-semibold text-emerald-700">Rs {(+v.total_amount || 0).toLocaleString('en-IN')}</div>
                  </div>
                </div>
                {/* Links row */}
                <div className="flex items-center gap-3 text-xs pt-1 border-t border-gray-100 flex-wrap">
                  <a href={`/vendor-po/${v.id}/print`} target="_blank" rel="noopener noreferrer" className="text-red-600 hover:underline flex items-center gap-1 font-semibold">
                    <FiPrinter size={11} /> Print PO
                  </a>
                  <a href={`/vendor-po/${v.id}/delivery-note`} target="_blank" rel="noopener noreferrer" className="text-emerald-700 hover:underline flex items-center gap-1 font-semibold">
                    🚚 Delivery Note
                  </a>
                  {v.file_path && <a href={v.file_path} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-semibold">📎 PDF</a>}
                </div>
                {/* PO approval (mam 2026-06-19): L1 Nitin Jain → L2 Ankur Kaplesh */}
                {!v.cancelled && canApprovePo(v) && (
                  <div className="flex gap-2 mt-1">
                    <button onClick={() => approvePo(v)} className="btn btn-success text-sm py-2 px-3 flex-1">✓ Approve {v.po_approval === 'pending_l1' ? 'L1' : 'L2'}</button>
                    <button onClick={() => rejectPo(v)} className="text-sm py-2 px-3 rounded bg-red-100 text-red-700 border border-red-300 font-semibold">Reject</button>
                  </div>
                )}
                {/* Primary action — Mark Cleared (when payment pending) */}
                {!v.cancelled && v.payment_block_status === 'pending' && (canApprove('procurement') || isAdmin()) && (
                  <button onClick={() => markPaymentCleared(v.id)} className="btn btn-success text-sm py-2 px-3 w-full mt-1">
                    ✓ Mark Payment Cleared
                  </button>
                )}
                {/* Secondary actions: Edit / Cancel / Restore / Delete */}
                <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-100 text-xs">
                  {!v.cancelled && (canApprove('procurement') || isAdmin()) && (
                    <button onClick={() => openEditVendorPo(v)} className="text-blue-600 hover:underline flex items-center gap-1 font-semibold">
                      <FiEdit2 size={11} /> Edit
                    </button>
                  )}
                  {!v.cancelled && (canApprove('procurement') || isAdmin()) && (
                    <button onClick={async () => {
                      const reason = prompt(`Cancel Vendor PO "${v.po_number}"?\n\nReason (optional):`);
                      if (reason === null) return;
                      try { await api.post(`/procurement/vendor-po/${v.id}/cancel`, { reason }); toast.success('PO cancelled'); load(); }
                      catch (err) { toast.error(err.response?.data?.error || 'Cancel failed'); }
                    }} className="text-amber-600 hover:underline flex items-center gap-1 font-semibold">
                      <FiX size={11} /> Cancel
                    </button>
                  )}
                  {v.cancelled && (canApprove('procurement') || isAdmin()) && (
                    <button onClick={async () => {
                      if (!confirm(`Restore Vendor PO "${v.po_number}" from cancelled?`)) return;
                      try { await api.post(`/procurement/vendor-po/${v.id}/uncancel`); toast.success('PO restored'); load(); }
                      catch (err) { toast.error(err.response?.data?.error || 'Restore failed'); }
                    }} className="text-emerald-700 hover:underline flex items-center gap-1 font-semibold">
                      <FiCheck size={11} /> Restore
                    </button>
                  )}
                  {canDelete('procurement') && (
                    <button onClick={async () => {
                      if (!confirm(`Permanently delete vendor PO "${v.po_number}"?`)) return;
                      try { await api.delete(`/procurement/vendor-po/${v.id}`); toast.success('Deleted'); load(); }
                      catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                    }} className="text-red-600 hover:underline flex items-center gap-1 font-semibold">
                      <FiTrash2 size={11} /> Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
            {vendorPos.length === 0 && <div className="card p-6 text-center text-gray-400 text-sm">No vendor POs yet — click "Create Vendor PO"</div>}
            {vendorPos.length > 0 && filteredList.length === 0 && <div className="card p-6 text-center text-gray-400 text-sm">No POs match the current filters.</div>}
            <Pagination pg={listPg} setPerPage={setVpoListPerPage} />
          </div>
            </>
          )}
        </>
        );
      })()}

      {/* ─── PAYMENT tab (mam 2026-05-27) ───
          Dedicated Accounts workflow between Vendor PO and Purchase Bills.
          Surfaces every active PO that has a payment_block_type set, grouped
          by urgency. Accounts clears here → Purchase picks up in next tab. */}
      {tab === 'payment' && (() => {
        // Active (non-cancelled) POs only. Mam's workflow gate (2026-05-27):
        // this tab ONLY shows POs that need (or just had) Accounts action —
        // pending payment OR recently cleared. POs with no_advance / NULL
        // status live in Purchase Bills > Follow-up directly.
        const activePos = (vendorPos || []).filter(po => !po.cancelled);

        // Collapse duplicate POs for the SAME indent + vendor + amount (mam
        // 2026-06-15: "indent one against one vendor → only one need to show").
        // Keeps the first (newest) PO; a genuinely different-amount PO to the
        // same vendor still shows, so a real second PO is never hidden.
        const dedupPos = (list) => {
          const seen = new Set();
          return list.filter(po => {
            const total = Math.round(+po.display_total || +po.total_amount || 0);
            const key = `${(po.indent_number || '').toLowerCase()}|${(po.vendor_name || '').toLowerCase()}|${total}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        };
        // Bucket each PO by payment status (deduped)
        const buckets = {
          urgent:  dedupPos(activePos.filter(po => po.payment_block_status === 'pending')),
          cleared: dedupPos(activePos.filter(po => po.payment_block_status === 'cleared')),
        };
        const sumUrgent  = buckets.urgent.reduce((s, p) => s + (+p.payment_block_amount || 0), 0);
        const sumCleared = buckets.cleared.reduce((s, p) => s + (+p.payment_block_amount || 0), 0);

        // Coerce stale pill selections (na/all) to 'urgent' for users who
        // bookmarked the old URL or had old localStorage state.
        const effectivePill = (paymentPill === 'urgent' || paymentPill === 'cleared') ? paymentPill : 'urgent';

        // Filter pipeline: pill bucket + free-text search
        const q = paymentSearch.trim().toLowerCase();
        const visible = (effectivePill === 'urgent' ? buckets.urgent : buckets.cleared).filter(po => {
          if (!q) return true;
          const hay = `${po.po_number || ''} ${po.indent_number || ''} ${po.vendor_name || ''} ${po.indent_site_name || ''} ${po.payment_block_notes || ''}`.toLowerCase();
          return hay.includes(q);
        });

        return (
          <>
            {/* Pill segments — count + ₹ sum per bucket.  Only 2 pills
                here (Urgent / Cleared) because no_advance + legacy NULL
                POs skip this tab entirely and go straight to Purchase
                Bills > Follow-up per mam's workflow rule. */}
            <div className="flex flex-wrap items-center gap-2">
              {[
                { id: 'urgent',  label: '🚨 Payment Urgent',   activeCls: 'bg-red-600 text-white border-red-700 shadow',           inactiveCls: 'bg-white text-red-700 border-red-300',          n: buckets.urgent.length,  v: sumUrgent,  hint: "Vendor won't ship — Accounts must clear advance / old dues" },
                { id: 'cleared', label: '✓ Recently Cleared',  activeCls: 'bg-emerald-600 text-white border-emerald-700 shadow',  inactiveCls: 'bg-white text-emerald-700 border-emerald-300', n: buckets.cleared.length, v: sumCleared, hint: 'Payment done — Purchase team can now chase the bill in the next tab' },
              ].map(p => {
                const active = effectivePill === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPaymentPill(p.id)}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition ${active ? p.activeCls : p.inactiveCls + ' hover:shadow-sm'}`}
                    title={p.hint}
                  >
                    <span>{p.label}</span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${active ? 'bg-white/20' : 'bg-current/10'}`}>{p.n}</span>
                    {p.v > 0 && (
                      <span className={`text-[10px] ${active ? 'text-white/90' : 'opacity-70'}`}>· ₹{Math.round(p.v).toLocaleString('en-IN')}</span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Workflow hint */}
            <div className="card p-2.5 bg-blue-50/50 border-blue-100 text-[11px] text-blue-900 flex items-center gap-2 flex-wrap">
              <span className="font-semibold">Workflow:</span>
              <span>① Create PO</span>
              <span className="opacity-50">→</span>
              <span><b>No advance?</b> Skips straight to Purchase Bills</span>
              <span className="opacity-50">·</span>
              <span><b>Advance / Old hold?</b> Sits here until Accounts marks cleared</span>
              <span className="opacity-50">→</span>
              <span>Once cleared, the PO moves to <b>Purchase Bills</b> for the bill chase</span>
            </div>

            {/* Search + showing-count */}
            <div className="card p-3 flex flex-wrap items-end gap-3 text-xs">
              <div className="flex-1 min-w-[220px]">
                <label className="label text-[10px] mb-0.5">Search · PO / Indent / Vendor / Notes</label>
                <input
                  type="text"
                  className="input text-xs"
                  placeholder="e.g. VPO/2026/0042 or Aditya Steel or 'last 3 bills overdue'"
                  value={paymentSearch}
                  onChange={e => setPaymentSearch(e.target.value)}
                />
              </div>
              <div className="text-[11px] text-gray-500 self-end pb-1">
                Showing <b>{visible.length}</b> {paymentPill === 'urgent' ? 'urgent' : paymentPill === 'cleared' ? 'cleared' : paymentPill === 'na' ? 'no-advance' : 'active'} PO{visible.length === 1 ? '' : 's'}
              </div>
            </div>

            {/* Desktop table (mobile gets card list below — mam 2026-06-02) */}
            <div className="card p-0 overflow-auto max-h-[70vh] hidden md:block">
              <table className="text-xs freeze-head">
                <thead><tr className="bg-gray-50">
                  <th className="px-3 py-2 text-left">PO Number</th>
                  <th className="px-3 py-2 text-left">Indent / Site</th>
                  <th className="px-3 py-2 text-left">Vendor</th>
                  <th className="px-3 py-2">PO Date</th>
                  <th className="px-3 py-2">Payment</th>
                  <th className="px-3 py-2 text-right">Amount owed</th>
                  <th className="px-3 py-2 text-left">Notes</th>
                  <th className="px-3 py-2 text-center">Action</th>
                </tr></thead>
                <tbody>
                  {visible.map(po => (
                    <tr key={po.id} className="border-b border-gray-100">
                      <td className="px-3 py-2 font-semibold text-red-700 whitespace-nowrap">
                        <a href={`/vendor-po/${po.id}/print`} target="_blank" rel="noopener noreferrer" className="hover:underline">{po.po_number}</a>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="font-mono text-[11px] font-semibold text-blue-800">{po.indent_number || <span className="text-gray-300">—</span>}</div>
                        {po.indent_site_name && <div className="text-[10px] text-gray-500 truncate max-w-[180px]" title={po.indent_site_name}>{po.indent_site_name}</div>}
                      </td>
                      <td className="px-3 py-2 max-w-[200px] truncate" title={po.vendor_name}>{po.vendor_name}</td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">{po.po_date || <span className="text-gray-300">—</span>}</td>
                      <td className="px-3 py-2">
                        <PaymentBlockChip v={po} />
                        {!po.payment_block_type && (
                          <span className="text-[10px] text-gray-400 italic">— not set —</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold whitespace-nowrap">
                        {po.payment_block_amount > 0
                          ? <span className={po.payment_block_status === 'pending' ? 'text-red-700' : 'text-emerald-700'}>₹{Math.round(+po.payment_block_amount).toLocaleString('en-IN')}</span>
                          : <span className="text-gray-300">—</span>}
                        <div className="text-[9px] font-normal text-gray-400">PO total ₹{Math.round(+po.display_total || +po.total_amount || 0).toLocaleString('en-IN')}</div>
                      </td>
                      <td className="px-3 py-2 max-w-[220px]">
                        {po.payment_block_notes ? (
                          <div className="text-[10px] text-gray-600 italic truncate" title={po.payment_block_notes}>"{po.payment_block_notes}"</div>
                        ) : <span className="text-gray-300">—</span>}
                        {po.payment_block_status === 'cleared' && po.payment_cleared_by_name && (
                          <div className="text-[10px] text-emerald-700 mt-0.5">
                            ✓ by {po.payment_cleared_by_name}
                            {po.payment_cleared_at && ' · ' + new Date(po.payment_cleared_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        {po.payment_block_status === 'pending' && (canApprove('procurement') || isAdmin()) && (
                          <button
                            onClick={() => markPaymentCleared(po.id)}
                            className="text-[11px] font-semibold px-2.5 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 transition"
                            title="Mark advance / old payment as cleared (internal)"
                          >
                            ✓ Mark Cleared
                          </button>
                        )}
                        {(canApprove('procurement') || isAdmin()) && (
                          <button
                            onClick={() => openEditVendorPo(po)}
                            className="ml-1 text-[10px] text-blue-600 hover:underline"
                            title="Edit PO — change payment type / amount / notes"
                          >
                            edit
                          </button>
                        )}
                        {canDelete('procurement') && (
                          <button
                            onClick={async () => {
                              if (!confirm(`Permanently delete vendor PO "${po.po_number}"?`)) return;
                              try { await api.delete(`/procurement/vendor-po/${po.id}`); toast.success('Deleted'); load(); }
                              catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                            }}
                            className="ml-1 text-[10px] text-red-600 hover:underline"
                            title="Delete this PO (blocked if any bill / delivery note references it — use Cancel instead)"
                          >
                            delete
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {visible.length === 0 && (
                    <tr><td colSpan="8" className="text-center py-8 text-gray-400 text-xs">
                      {effectivePill === 'urgent'
                        ? '🎉 No urgent payments — every blocked PO is cleared. Purchase team can chase bills in the next tab.'
                        : 'No cleared payments yet. Once Accounts clears an urgent PO, it shows here for confirmation, then moves to Purchase Bills.'}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Mobile cards — same polished pattern as Indents (mam). */}
            <div className="md:hidden space-y-3">
              {visible.map(po => (
                <div key={po.id} className="card p-3 space-y-2">
                  {/* Header: PO # · payment chip */}
                  <div className="flex justify-between items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Vendor PO No</div>
                      <div className="text-lg font-bold text-gray-900 truncate">{po.po_number}</div>
                      <div className="text-[11px] text-gray-500 flex items-center gap-1 mt-0.5">
                        <FiCalendar size={10} className="text-gray-400" />
                        {po.po_date || '—'}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <PaymentBlockChip v={po} />
                      {!po.payment_block_type && <span className="text-[9px] text-gray-400 italic">— not set —</span>}
                    </div>
                  </div>
                  {/* Site */}
                  {po.indent_site_name && (
                    <div className="flex items-start gap-1.5 text-xs">
                      <FiMapPin size={12} className="mt-0.5 text-red-500 flex-shrink-0" />
                      <div className="min-w-0">
                        <div className="text-[10px] uppercase text-gray-400">Site</div>
                        <div className="font-medium text-gray-800">{po.indent_site_name}</div>
                      </div>
                    </div>
                  )}
                  {/* 3-col: Indent · Vendor · Owed */}
                  <div className="grid grid-cols-3 gap-2 pt-1 border-t border-gray-100 text-[11px]">
                    <div>
                      <div className="text-[9px] uppercase text-gray-400">Indent</div>
                      <div className="font-mono font-semibold text-blue-800 truncate">{po.indent_number || '—'}</div>
                    </div>
                    <div>
                      <div className="text-[9px] uppercase text-gray-400">Vendor</div>
                      <div className="font-medium text-gray-700 truncate" title={po.vendor_name}>{po.vendor_name}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[9px] uppercase text-gray-400">Amount Owed</div>
                      {po.payment_block_amount > 0
                        ? <div className={`font-semibold ${po.payment_block_status === 'pending' ? 'text-red-700' : 'text-emerald-700'}`}>₹{Math.round(+po.payment_block_amount).toLocaleString('en-IN')}</div>
                        : <div className="text-gray-300">—</div>}
                    </div>
                  </div>
                  <div className="text-[10px] text-gray-400 -mt-1">PO total ₹{Math.round(+po.display_total || +po.total_amount || 0).toLocaleString('en-IN')}</div>
                  {po.payment_block_notes && (
                    <div className="text-[11px] text-gray-600 italic line-clamp-2 pt-1 border-t border-gray-100" title={po.payment_block_notes}>"{po.payment_block_notes}"</div>
                  )}
                  {po.payment_block_status === 'cleared' && po.payment_cleared_by_name && (
                    <div className="text-[11px] text-emerald-700 font-medium flex items-center gap-1">
                      <FiCheck size={11} /> by {po.payment_cleared_by_name}
                      {po.payment_cleared_at && <span className="text-[10px] text-gray-500 ml-1">{new Date(po.payment_cleared_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</span>}
                    </div>
                  )}
                  {/* Primary action — Mark Cleared */}
                  {po.payment_block_status === 'pending' && (canApprove('procurement') || isAdmin()) && (
                    <button onClick={() => markPaymentCleared(po.id)} className="btn btn-success text-sm py-2 px-3 w-full mt-1">
                      ✓ Mark Payment Cleared
                    </button>
                  )}
                  {/* Secondary — Edit */}
                  {(canApprove('procurement') || isAdmin()) && (
                    <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-100 text-xs">
                      <button onClick={() => openEditVendorPo(po)} className="text-blue-600 hover:underline flex items-center gap-1 font-semibold">
                        <FiEdit2 size={11} /> Edit
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {visible.length === 0 && (
                <div className="card p-6 text-center text-gray-400 text-sm">
                  {effectivePill === 'urgent'
                    ? '🎉 No urgent payments — every blocked PO is cleared.'
                    : 'No cleared payments yet.'}
                </div>
              )}
            </div>
          </>
        );
      })()}

      {tab === 'bills' && (() => {
        // POs that don't have a bill yet — sorted by Expected Receipt Date
        // so the purchase team chases the oldest first. Uses client-side
        // filtering off the already-loaded vendorPos + purchaseBills.
        const billedPoIds = new Set(purchaseBills.map(b => b.vendor_po_id).filter(Boolean));
        const today = new Date().toISOString().slice(0, 10);
        const pendingPos = vendorPos
          // Skip cancelled POs — they're not waiting for a bill anymore.
          .filter(po => !billedPoIds.has(po.id) && !po.cancelled)
          // Payment gate (mam 2026-05-27): POs still blocked on advance /
          // old dues do NOT appear in Purchase Bill follow-up — Accounts
          // handles them in the Payment tab first. Once cleared (or if no
          // payment block at all), they land here for the bill chase.
          .filter(po => po.payment_block_status !== 'pending')
          .sort((a, b) => {
            const ax = a.expected_receipt_date || '9999-12-31';
            const bx = b.expected_receipt_date || '9999-12-31';
            return ax.localeCompare(bx);
          });

        // Sub-tab filtering (mam 2026-05-25)
        const fSearch = billsFuSearch.trim().toLowerCase();
        const filteredFu = pendingPos.filter(po => {
          if (billsFuExpFrom && po.expected_receipt_date && po.expected_receipt_date < billsFuExpFrom) return false;
          if (billsFuExpTo   && po.expected_receipt_date && po.expected_receipt_date > billsFuExpTo) return false;
          if (!fSearch) return true;
          const hay = `${po.po_number || ''} ${po.indent_number || ''} ${po.vendor_name || ''} ${po.indent_site_name || ''}`.toLowerCase();
          return hay.includes(fSearch);
        });
        const fuPg = usePagination(filteredFu, billsFuPerPage, billsFuPage, setBillsFuPage);

        const blSearch = billsListSearch.trim().toLowerCase();
        const filteredBills = purchaseBills.filter(b => {
          if (billsListFrom && b.bill_date && b.bill_date < billsListFrom) return false;
          if (billsListTo   && b.bill_date && b.bill_date > billsListTo) return false;
          if (!blSearch) return true;
          const hay = `${b.bill_number || ''} ${b.vendor_name || ''}`.toLowerCase();
          return hay.includes(blSearch);
        });
        const billsListPg = usePagination(filteredBills, billsListPerPage, billsListPage, setBillsListPage);
        const daysDiff = (d) => {
          if (!d) return null;
          const dt = new Date(d); const tdt = new Date(today);
          return Math.round((dt - tdt) / 86400000);
        };
        const openUploadBill = (po) => {
          setForm({
            vendor_po_id: po.id,
            vendor_po_number: po.po_number,
            vendor_id: po.vendor_id,
            bill_number: '',
            bill_date: today,
            amount: 0,
            gst_amount: 0,
            total_amount: 0,
            material_status: 'approved',
          });
          setBillItems(null);
          setBillRecv({});
          setModal('bill');
          // Load PO qty vs received qty per item + suggest the bill amount.
          api.get(`/procurement/vendor-po/${po.id}/bill-items`).then(r => {
            setBillItems(r.data);
            // Seed editable received: recorded received if any, else PO qty.
            const recv = {};
            for (const it of (r.data.items || [])) recv[it.vpi_id] = it.received_qty != null ? it.received_qty : it.ordered_qty;
            setBillRecv(recv);
            const amt = Math.round((r.data.items || []).reduce((s, it) => s + ((+recv[it.vpi_id] || 0) * (+it.rate || 0)), 0) * 100) / 100;
            setForm(f => ({ ...f, amount: amt, total_amount: amt + (f.gst_amount || 0) }));
          }).catch(() => setBillItems({ items: [], ordered_total: 0, any_receipt: false }));
        };
        return (
        <>
          {/* Sub-tabs (mam 2026-05-25) */}
          <div className="flex justify-between items-center flex-wrap gap-2">
            <div className="flex gap-1 border-b border-gray-200 -mb-px">
              <button onClick={() => setBillsSubTab('followup')}
                className={`px-3 py-1.5 text-xs font-semibold border-b-2 -mb-px ${billsSubTab === 'followup' ? 'border-amber-500 text-amber-700 bg-amber-50' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                Follow-up <span className="ml-1 text-[10px] opacity-80">({pendingPos.length})</span>
              </button>
              <button onClick={() => setBillsSubTab('bills')}
                className={`px-3 py-1.5 text-xs font-semibold border-b-2 -mb-px ${billsSubTab === 'bills' ? 'border-red-600 text-red-700 bg-red-50' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                Purchase Bills <span className="ml-1 text-[10px] opacity-80">({purchaseBills.length})</span>
              </button>
            </div>
            {billsSubTab === 'bills' && (
              <button onClick={() => { setForm({ vendor_id: '', bill_number: '', bill_date: '', amount: 0, gst_amount: 0, total_amount: 0, material_status: 'approved' }); setBillItems(null); setBillRecv({}); setModal('bill'); }} className="btn btn-primary flex items-center gap-2 text-xs"><FiPlus /> Add Bill</button>
            )}
          </div>

          {/* ===== Sub-tab 1: Follow-up ===== */}
          {/* Heads-up banner when POs are hidden behind the payment gate.
              Tells the purchase team where those POs went so they don't
              wonder why a PO they just created isn't showing up here. */}
          {billsSubTab === 'followup' && (() => {
            const blockedCount = (vendorPos || []).filter(po =>
              !po.cancelled && !billedPoIds.has(po.id) && po.payment_block_status === 'pending'
            ).length;
            if (blockedCount === 0) return null;
            return (
              <div className="card p-2.5 bg-red-50 border border-red-200 text-[11px] text-red-800 flex items-center gap-2 flex-wrap">
                <span>🚨 <b>{blockedCount}</b> PO{blockedCount === 1 ? '' : 's'} hidden — blocked on payment.</span>
                <button type="button" onClick={() => setTab('payment')} className="text-red-700 underline font-semibold hover:text-red-900">
                  Go to Payment tab →
                </button>
                <span className="opacity-70">Accounts clears them first, then they appear here automatically.</span>
              </div>
            );
          })()}
          {billsSubTab === 'followup' && pendingPos.length === 0 && (
            <div className="card text-center py-8 text-gray-400 text-xs">No POs awaiting a Purchase Bill. 🎉</div>
          )}
          {billsSubTab === 'followup' && pendingPos.length > 0 && (
            <div className="card p-3 bg-amber-50 border border-amber-200">
              <div className="flex items-center justify-between mb-2 flex-wrap gap-1">
                <h4 className="font-semibold text-amber-800 text-sm">
                  Follow-up: POs awaiting Purchase Bill
                  <span className="text-xs font-normal text-amber-600 ml-2">({pendingPos.length} PO{pendingPos.length === 1 ? '' : 's'})</span>
                </h4>
                <span className="text-[11px] text-amber-700">Sorted by Expected Receipt Date — chase the oldest first</span>
              </div>

              {/* Search + expected-date filter (mam 2026-05-25) */}
              <div className="flex flex-wrap items-end gap-2 text-xs mb-3 pb-3 border-b border-amber-200">
                <div className="flex-1 min-w-[200px]">
                  <label className="label text-[10px] mb-0.5 text-amber-900">Search · PO no / indent no / vendor</label>
                  <input className="input text-xs" placeholder="e.g. VPO-0042 or IND-0070"
                    value={billsFuSearch} onChange={e => { setBillsFuSearch(e.target.value); setBillsFuPage(1); }} />
                </div>
                <div>
                  <label className="label text-[10px] mb-0.5 text-amber-900">Expected From</label>
                  <input className="input text-xs" type="date" value={billsFuExpFrom}
                    onChange={e => { setBillsFuExpFrom(e.target.value); setBillsFuPage(1); }} />
                </div>
                <div>
                  <label className="label text-[10px] mb-0.5 text-amber-900">Expected To</label>
                  <input className="input text-xs" type="date" value={billsFuExpTo}
                    onChange={e => { setBillsFuExpTo(e.target.value); setBillsFuPage(1); }} />
                </div>
                {(billsFuSearch || billsFuExpFrom || billsFuExpTo) && (
                  <button type="button" className="btn btn-secondary text-xs py-1 px-2"
                    onClick={() => { setBillsFuSearch(''); setBillsFuExpFrom(''); setBillsFuExpTo(''); setBillsFuPage(1); }}>Reset</button>
                )}
                <div className="ml-auto text-[11px] text-amber-900">
                  Showing <span className="font-semibold">{filteredFu.length}</span> of {pendingPos.length}
                </div>
              </div>
              <div className="hidden md:block overflow-auto max-h-[70vh]">
                <table className="text-xs freeze-head">
                  <thead><tr className="bg-amber-100/50">
                    <th className="px-2 py-1 text-left">PO Number</th>
                    {/* Indent column added (mam, 2026-05-20: "show here
                        also indent number").  Carries indent_number +
                        site sub-text so mam can trace a PO back to its
                        raising indent without opening the row. */}
                    <th className="px-2 py-1 text-left">Indent</th>
                    <th className="px-2 py-1 text-left">Vendor</th>
                    <th className="px-2 py-1">PO Date</th>
                    <th className="px-2 py-1">Expected Receipt</th>
                    <th className="px-2 py-1">Status</th>
                    <th className="px-2 py-1 text-right">Amount</th>
                    <th className="px-2 py-1">File</th>
                    <th className="px-2 py-1"></th>
                  </tr></thead>
                  <tbody>
                    {fuPg.rows.map(po => {
                      const d = daysDiff(po.expected_receipt_date);
                      let chip;
                      if (!po.expected_receipt_date) chip = <span className="text-gray-400">— no date —</span>;
                      else if (d < 0) chip = <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-200">OVERDUE by {-d}d</span>;
                      else if (d === 0) chip = <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300">DUE TODAY</span>;
                      else if (d <= 3) chip = <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 border border-orange-200">in {d}d</span>;
                      else chip = <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200">in {d}d</span>;
                      return (
                        <tr key={po.id} className="border-b border-amber-100">
                          <td className="px-2 py-1.5 font-semibold text-red-700 whitespace-nowrap">{po.po_number}</td>
                          <td className="px-2 py-1.5 max-w-[160px] whitespace-nowrap">
                            <div className="font-mono text-[11px] font-semibold text-blue-800">{po.indent_number || <span className="text-gray-300">—</span>}</div>
                            {po.indent_site_name && (
                              <div className="text-[10px] text-gray-500 truncate" title={po.indent_site_name}>{po.indent_site_name}</div>
                            )}
                          </td>
                          <td className="px-2 py-1.5 max-w-[220px] truncate">{po.vendor_name}</td>
                          <td className="px-2 py-1.5 text-center whitespace-nowrap">{po.po_date || <span className="text-gray-300">—</span>}</td>
                          <td className="px-2 py-1.5 text-center whitespace-nowrap">{po.expected_receipt_date || <span className="text-gray-300">—</span>}</td>
                          <td className="px-2 py-1.5 text-center">{chip}</td>
                          {/* Show the LIVE computed total (items × 1.18 GST)
                              from display_total — matches what the PO print
                              shows.  Mam, 2026-05-16: header total drifted from
                              the line items.  Drift chip warns when the stored
                              total disagrees with the items sum. */}
                          <td className="px-2 py-1.5 text-right font-semibold whitespace-nowrap">
                            Rs {(+po.display_total || +po.total_amount || 0).toLocaleString('en-IN')}
                            {+po.total_amount_drift > 1 && (
                              <div className="text-[9px] text-amber-700 font-normal" title={`Stored: Rs ${(+po.total_amount).toLocaleString('en-IN')} · Items sum + 18% GST: Rs ${(+po.display_total).toLocaleString('en-IN')}`}>
                                ⚠ drift Rs {(+po.total_amount_drift).toLocaleString('en-IN')}
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            {/* Always show "View PO" — opens the Sotyn.Headmasters-generated
                                print page (PDF-able). If a Tally / signed scan
                                was also uploaded, show a second link below. */}
                            <a href={`/vendor-po/${po.id}/print`} target="_blank" rel="noopener noreferrer" className="text-red-600 hover:text-red-800 underline text-[11px] font-semibold whitespace-nowrap">📄 View PO</a>
                            {/* Mam (2026-05-22): auto-generated Delivery Note
                                per PO — opens print-ready page, no DN row
                                needed.  Uses the SEPL template format mam
                                shared. */}
                            <div><a href={`/vendor-po/${po.id}/delivery-note`} target="_blank" rel="noopener noreferrer" className="text-emerald-700 hover:text-emerald-900 underline text-[11px] font-semibold whitespace-nowrap">🚚 Delivery Note</a></div>
                            {po.file_path && (
                              <div><a href={po.file_path} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline text-[10px]">📎 attached file</a></div>
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            <button onClick={() => openUploadBill(po)} className="btn btn-primary text-[10px] px-2 py-1 whitespace-nowrap">Upload Bill</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards — polished pattern matching Indents (mam). */}
              <div className="md:hidden space-y-3">
                {fuPg.rows.map(po => {
                  const d = daysDiff(po.expected_receipt_date);
                  let chip;
                  if (!po.expected_receipt_date) chip = <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-gray-200 bg-gray-50 text-gray-500 uppercase">no date</span>;
                  else if (d < 0)  chip = <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-red-300 bg-red-50 text-red-700 uppercase">Overdue {-d}d</span>;
                  else if (d === 0) chip = <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-amber-300 bg-amber-50 text-amber-700 uppercase">Due Today</span>;
                  else if (d <= 3)  chip = <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-orange-300 bg-orange-50 text-orange-700 uppercase">In {d}d</span>;
                  else              chip = <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-gray-300 bg-gray-50 text-gray-600 uppercase">In {d}d</span>;
                  return (
                    <div key={po.id} className="card p-3 space-y-2">
                      <div className="flex justify-between items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">PO Number</div>
                          <div className="text-lg font-bold text-gray-900 truncate">{po.po_number}</div>
                          <div className="text-[11px] text-gray-500 flex items-center gap-1 mt-0.5">
                            <FiCalendar size={10} className="text-gray-400" />
                            {po.po_date || '—'}
                          </div>
                        </div>
                        {chip}
                      </div>
                      {po.indent_site_name && (
                        <div className="flex items-start gap-1.5 text-xs">
                          <FiMapPin size={12} className="mt-0.5 text-red-500 flex-shrink-0" />
                          <div className="min-w-0">
                            <div className="text-[10px] uppercase text-gray-400">Site</div>
                            <div className="font-medium text-gray-800">{po.indent_site_name}</div>
                          </div>
                        </div>
                      )}
                      <div className="grid grid-cols-3 gap-2 pt-1 border-t border-gray-100 text-[11px]">
                        <div>
                          <div className="text-[9px] uppercase text-gray-400">Indent</div>
                          <div className="font-mono font-semibold text-blue-800 truncate">{po.indent_number || '—'}</div>
                        </div>
                        <div>
                          <div className="text-[9px] uppercase text-gray-400">Vendor</div>
                          <div className="font-medium text-gray-700 truncate" title={po.vendor_name}>{po.vendor_name}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-[9px] uppercase text-gray-400">Amount</div>
                          <div className="font-semibold text-emerald-700">Rs {(+po.display_total || +po.total_amount || 0).toLocaleString('en-IN')}</div>
                          {+po.total_amount_drift > 1 && <div className="text-[9px] text-amber-700">⚠ drift</div>}
                        </div>
                      </div>
                      <div className="text-[11px] text-gray-500 pt-1 border-t border-gray-100">
                        <span className="text-gray-400">Expected receipt:</span> <b className="text-gray-700">{po.expected_receipt_date || '—'}</b>
                      </div>
                      <div className="flex items-center gap-3 text-xs flex-wrap">
                        <a href={`/vendor-po/${po.id}/print`} target="_blank" rel="noopener noreferrer" className="text-red-600 hover:underline flex items-center gap-1 font-semibold">
                          <FiPrinter size={11} /> Print PO
                        </a>
                        <a href={`/vendor-po/${po.id}/delivery-note`} target="_blank" rel="noopener noreferrer" className="text-emerald-700 hover:underline flex items-center gap-1 font-semibold">
                          🚚 Delivery Note
                        </a>
                        {po.file_path && <a href={po.file_path} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-semibold">📎 File</a>}
                      </div>
                      <button onClick={() => openUploadBill(po)} className="btn btn-primary text-sm py-2 px-3 w-full mt-1">+ Upload Bill</button>
                    </div>
                  );
                })}
                {filteredFu.length === 0 && (
                  <div className="card p-6 text-center text-amber-700 text-sm">No POs match the current filters.</div>
                )}
              </div>
              <Pagination pg={fuPg} setPerPage={setBillsFuPerPage} className="border-t border-amber-200 pt-2" />
            </div>
          )}

          {/* ===== Sub-tab 2: Purchase Bills ===== */}
          {billsSubTab === 'bills' && (
            <>
              <div className="card p-3 flex flex-wrap items-end gap-2 text-xs">
                <div className="flex-1 min-w-[200px]">
                  <label className="label text-[10px] mb-0.5">Search · bill no / vendor</label>
                  <input className="input text-xs" placeholder="e.g. PB-0042 or vendor name"
                    value={billsListSearch} onChange={e => { setBillsListSearch(e.target.value); setBillsListPage(1); }} />
                </div>
                <div>
                  <label className="label text-[10px] mb-0.5">Bill Date From</label>
                  <input className="input text-xs" type="date" value={billsListFrom}
                    onChange={e => { setBillsListFrom(e.target.value); setBillsListPage(1); }} />
                </div>
                <div>
                  <label className="label text-[10px] mb-0.5">Bill Date To</label>
                  <input className="input text-xs" type="date" value={billsListTo}
                    onChange={e => { setBillsListTo(e.target.value); setBillsListPage(1); }} />
                </div>
                {(billsListSearch || billsListFrom || billsListTo) && (
                  <button type="button" className="btn btn-secondary text-xs py-1 px-2"
                    onClick={() => { setBillsListSearch(''); setBillsListFrom(''); setBillsListTo(''); setBillsListPage(1); }}>Reset</button>
                )}
                <div className="ml-auto text-[11px] text-gray-500">
                  Showing <span className="font-semibold text-gray-700">{filteredBills.length}</span> of {purchaseBills.length}
                </div>
              </div>
          <div className="card p-0 overflow-auto max-h-[70vh] hidden md:block"><table className="freeze-head freeze-col">
            <thead><tr><th>Bill No</th><th>Vendor</th><th>Date</th><th>Amount</th><th>GST</th><th>Total</th><th>Debit / Net Pay</th><th>File</th><th>Payment</th><th>Actions</th></tr></thead>
            <tbody>
              {billsListPg.rows.map(b => (
                <tr key={b.id}>
                  <td className="font-medium">{b.bill_number}</td><td>{b.vendor_name}</td><td>{b.bill_date}</td>
                  <td>Rs {b.amount?.toLocaleString()}</td><td>Rs {b.gst_amount?.toLocaleString()}</td>
                  <td className="font-semibold">Rs {b.total_amount?.toLocaleString()}</td>
                  <td>
                    {+b.debit_total > 0 ? (
                      <div className="leading-tight" title="Debit notes on this PO are deducted from the payable">
                        <div className="text-red-600 text-[11px]">− Rs {Math.round(+b.debit_total).toLocaleString('en-IN')}</div>
                        <div className="font-semibold text-emerald-700 text-[11px]">Net Rs {Math.round((+b.total_amount || 0) - (+b.debit_total || 0)).toLocaleString('en-IN')}</div>
                      </div>
                    ) : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                  <td>
                    {b.file_path
                      ? <a href={b.file_path} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline text-xs">View Bill</a>
                      : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                  <td><StatusBadge status={b.payment_status} /></td>
                  <td className="whitespace-nowrap">
                    {b.vendor_po_id && <button onClick={() => openEditQty(b)} className="p-1 text-gray-400 hover:text-blue-600" title="Edit received qty (updates the challan)"><FiEdit2 size={14} /></button>}
                    {canDelete('procurement') && <button onClick={async () => {
                    if (!confirm(`Delete purchase bill "${b.bill_number}"?`)) return;
                    try { await api.delete(`/procurement/purchase-bills/${b.id}`); toast.success('Deleted'); load(); }
                    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                  }} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}
                  </td>
                </tr>
              ))}
              {purchaseBills.length === 0 && <tr><td colSpan="10" className="text-center py-8 text-gray-400">No bills yet</td></tr>}
              {purchaseBills.length > 0 && filteredBills.length === 0 && <tr><td colSpan="10" className="text-center py-8 text-gray-400">No bills match the current filters.</td></tr>}
            </tbody>
            <tfoot><tr><td colSpan="10" className="border-t border-gray-100"><Pagination pg={billsListPg} setPerPage={setBillsListPerPage} /></td></tr></tfoot>
          </table></div>

          {/* Mobile cards — polished pattern matching Indents (mam). */}
          <div className="md:hidden space-y-3">
            {billsListPg.rows.map(b => (
              <div key={b.id} className="card p-3 space-y-2">
                <div className="flex justify-between items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Bill No</div>
                    <div className="text-lg font-bold text-gray-900 truncate">{b.bill_number || '—'}</div>
                    <div className="text-[11px] text-gray-500 flex items-center gap-1 mt-0.5">
                      <FiCalendar size={10} className="text-gray-400" />
                      {b.bill_date || '—'}
                    </div>
                  </div>
                  <StatusBadge status={b.payment_status} />
                </div>
                {b.vendor_name && (
                  <div className="text-xs">
                    <div className="text-[10px] uppercase text-gray-400">Vendor</div>
                    <div className="font-medium text-gray-800 truncate" title={b.vendor_name}>{b.vendor_name}</div>
                  </div>
                )}
                <div className="grid grid-cols-3 gap-2 pt-1 border-t border-gray-100 text-[11px]">
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">Amount</div>
                    <div className="font-semibold text-gray-800">Rs {(+b.amount || 0).toLocaleString('en-IN')}</div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">GST</div>
                    <div className="font-semibold text-gray-800">Rs {(+b.gst_amount || 0).toLocaleString('en-IN')}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[9px] uppercase text-gray-400">Total</div>
                    <div className="font-semibold text-emerald-700">Rs {(+b.total_amount || 0).toLocaleString('en-IN')}</div>
                  </div>
                </div>
                {b.file_path && (
                  <div className="flex items-center gap-3 text-xs pt-1 border-t border-gray-100">
                    <a href={b.file_path} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline flex items-center gap-1 font-semibold">
                      📄 View Bill
                    </a>
                  </div>
                )}
                {(b.vendor_po_id || canDelete('procurement')) && (
                  <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-100 text-xs">
                    {/* Edit received qty — desktop-table action, now on mobile too
                        (mam 2026-07-06: edit options must show on the phone). */}
                    {b.vendor_po_id && (
                      <button onClick={() => openEditQty(b)} title="Edit received qty (updates the challan)"
                        className="text-blue-600 hover:underline flex items-center gap-1 font-semibold">✏️ Edit qty</button>
                    )}
                    {canDelete('procurement') && (
                      <button onClick={async () => {
                        if (!confirm(`Delete purchase bill "${b.bill_number}"?`)) return;
                        try { await api.delete(`/procurement/purchase-bills/${b.id}`); toast.success('Deleted'); load(); }
                        catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                      }} className="text-red-600 hover:underline flex items-center gap-1 font-semibold">
                        <FiTrash2 size={11} /> Delete
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
            {purchaseBills.length === 0 && <div className="card p-6 text-center text-gray-400 text-sm">No bills yet</div>}
            {purchaseBills.length > 0 && filteredBills.length === 0 && <div className="card p-6 text-center text-gray-400 text-sm">No bills match the current filters.</div>}
            <Pagination pg={billsListPg} setPerPage={setBillsListPerPage} />
          </div>
            </>
          )}
        </>
        );
      })()}

      {tab === 'delivery' && (() => {
        // "Ready to Dispatch" — billed POs that still need a client SALES
        // BILL.  mam (2026-06-04): uploading a bill now auto-creates a
        // challan (a receiving doc), so the old "billed but no delivery
        // note" rule always came up empty.  The remaining action is the
        // Sales Bill, so list POs that have a bill but NO sales bill yet.
        const billedPoIds = new Set(purchaseBills.map(b => b.vendor_po_id).filter(Boolean));
        // A PO counts as sales-billed when it has a sales_bill delivery note
        // OR its challan carries a sales_bill_number. The auto-challan from
        // a Purchase Bill does NOT count.
        const salesBilledPoIds = new Set(
          deliveryNotes.filter(d => d.document_type === 'sales_bill' || d.sales_bill_number).map(d => d.vendor_po_id).filter(Boolean)
        );
        const readyToDispatch = vendorPos.filter(po =>
          billedPoIds.has(po.id) && !salesBilledPoIds.has(po.id) && !po.cancelled
        );
        // Sales-Bill-pending challans with NO Vendor PO (i.e. from-store
        // challans) — they can't ride the PO list above, so surface them
        // here too (mam 2026-06-04: "if SB pending, also show in Ready to
        // Dispatch").  PO challans that are SB-pending are already covered
        // by readyToDispatch (billed PO, not yet sales-billed).
        const sbPendingDNs = deliveryNotes.filter(d =>
          d.sales_bill_pending === 1 && !d.sales_bill_number && d.document_type === 'challan' && !d.vendor_po_id
        );

        // Sub-tab filtering (mam 2026-05-25)
        const rSearch = dispReadySearch.trim().toLowerCase();
        const filteredReady = readyToDispatch.filter(po => {
          if (!rSearch) return true;
          const hay = `${po.po_number || ''} ${po.vendor_name || ''} ${po.indent_number || ''}`.toLowerCase();
          return hay.includes(rSearch);
        });
        const readyPg = usePagination(filteredReady, dispReadyPerPage, dispReadyPage, setDispReadyPage);

        const dSearch = dispListSearch.trim().toLowerCase();
        const filteredDispatch = deliveryNotes.filter(d => {
          if (dispListStatus !== 'all' && d.status !== dispListStatus) return false;
          if (dispListFrom && d.received_on && d.received_on.slice(0, 10) < dispListFrom) return false;
          if (dispListTo   && d.received_on && d.received_on.slice(0, 10) > dispListTo) return false;
          if (!dSearch) return true;
          const hay = `${d.po_number || ''} ${d.vendor_po_number || ''} ${d.document_number || ''} ${d.received_by_name || ''} ${d.raised_by_name || ''}`.toLowerCase();
          return hay.includes(dSearch);
        });
        const dispListPg = usePagination(filteredDispatch, dispListPerPage, dispListPage, setDispListPage);
        // Detect item-type hint for each PO (if any indent_item linked is type=PO,
        // suggest Sales Bill; else suggest Challan). We don't have per-item info
        // on the client, so the dropdown defaults to Sales Bill and user can switch.
        const openAddDispatch = (po = null, docType = 'sales_bill') => {
          // docType param (mam 2026-05-25: "here also add delivery note
          // for rec"): pass 'challan' to open the modal as a Delivery
          // Note for FOC / RGP / receipt-only goods.  Defaults to
          // 'sales_bill' for backward compat with existing callers.
          setForm({
            vendor_po_id: po?.id || '',
            vendor_po_number: po?.po_number || '',
            document_type: docType,
            document_number: '',
            delivery_date: new Date().toISOString().slice(0, 10),
            notes: '',
            dispatch_file: null,
          });
          setDispatchItems([]);
          setDispatchItemsSource('empty');
          setDispatchBillTo(null);
          setModal('delivery');
          if (po?.id) {
            setDispatchItemsLoading(true);
            // Fire both fetches in parallel — items + bill-to.
            // Pass doc_type so the backend can refuse vendor-cost
            // fallback for sales_bill (mam, 2026-05-16: "if sales
            // bill we enter BOQ SITC rate").  openAddDispatch is
            // always called from a "create sales bill" path, so the
            // default is sales_bill; user can flip to challan in the
            // modal and we'll respect either way.
            Promise.all([
              // Pass the actual docType so the server picks the right
              // rate-fallback rule (challan allows vendor cost; sales_bill
              // enforces BOQ SITC and warns if missing).
              api.get(`/procurement/vendor-pos/${po.id}/client-po-items`, { params: { doc_type: docType } }).catch(() => ({ data: { items: [], source: 'empty' } })),
              api.get(`/procurement/vendor-pos/${po.id}/bill-to`).catch(() => ({ data: null })),
            ]).then(([itemsRes, billRes]) => {
              const rawRows = (itemsRes.data?.items || []).map(it => ({
                include: true,
                description: [it.description, it.specification, it.size].filter(Boolean).join(' / ') || it.item_name || '',
                hsn: it.hsn_code || '',  // gst_text was misnamed — drop it (it's the rate, not HSN)
                unit: it.unit || '',
                quantity: +it.quantity || 0,
                rate: +it.rate || 0,
                disc_pct: 0,
                item_code: it.item_code || '',
                specification: it.specification || '',
                size: it.size || '',
                item_name: it.item_name || '',
              }));
              // Filter out ghost rows — anything with no description AND
              // (zero qty or zero rate) is junk that confuses mam (was
              // showing as "Item descrip · 0 · nos · 0 · 0" placeholders).
              const rows = rawRows.filter(r => {
                if (r.description && r.description.trim()) return true;
                return (+r.quantity > 0) || (+r.rate > 0);
              });
              setDispatchItems(rows);
              setDispatchItemsSource(rows.length ? (itemsRes.data?.source || 'po_items') : 'empty');
              setDispatchRateInfo({
                source: itemsRes.data?.rate_source || null,
                warning: itemsRes.data?.warning || null,
                rated: +itemsRes.data?.rated_count || 0,
                total: +itemsRes.data?.total_count || rows.length,
              });
              setDispatchBillTo(billRes.data || null);
              // Pre-fill GST defaults from the bill-to state (intra
              // vs inter-state).  Punjab = CGST/SGST 9% each.
              const sameState = (billRes.data?.client_state || '').toLowerCase() === 'punjab';
              setForm(f => ({
                ...f,
                cgst_pct: f.cgst_pct ?? (sameState ? 9 : 0),
                sgst_pct: f.sgst_pct ?? (sameState ? 9 : 0),
                igst_pct: f.igst_pct ?? (sameState ? 0 : 18),
                place_of_supply: f.place_of_supply || billRes.data?.client_state || '',
                state_code: f.state_code || billRes.data?.client_state_code || '',
              }));
            }).finally(() => setDispatchItemsLoading(false));
          }
        };
        // Mam (2026-06-15) "fully auto on Dispatch": clicking Dispatch on a
        // Ready-to-Dispatch PO instantly generates the SALES BILL — items +
        // BOQ×delivery% rates from the PO, GST defaulted from the client
        // state (Punjab → CGST/SGST 9% each, else IGST 18%) — and opens its
        // PDF, with NO modal / no fields to fill. Falls back to the manual
        // modal only when the PO has no billable items.
        const autoDispatchSalesBill = async (po) => {
          if (!po?.id) return;
          // Park the PDF tab synchronously so the popup blocker can't eat it.
          const printWin = window.open('', '_blank');
          const closeWin = () => { try { if (printWin) printWin.close(); } catch (_) {} };
          try {
            const [itemsRes, billRes] = await Promise.all([
              api.get(`/procurement/vendor-pos/${po.id}/client-po-items`, { params: { doc_type: 'sales_bill' } }).catch(() => ({ data: { items: [], source: 'empty' } })),
              api.get(`/procurement/vendor-pos/${po.id}/bill-to`).catch(() => ({ data: null })),
            ]);
            const rows = (itemsRes.data?.items || []).map(it => {
              const qty = +it.quantity || 0;
              const rate = +it.rate || 0;
              return {
                description: [it.description, it.specification, it.size].filter(Boolean).join(' / ') || it.item_name || '',
                hsn: it.hsn_code || '',
                unit: it.unit || '',
                quantity: qty,
                rate,
                disc_pct: 0,
                amount: +(qty * rate).toFixed(2),
                item_code: it.item_code || '',
                specification: it.specification || '',
                size: it.size || '',
                item_name: it.item_name || '',
              };
            }).filter(r => (r.description && r.description.trim()) || r.quantity > 0 || r.rate > 0);
            if (!rows.length) {
              closeWin();
              toast.error('No PO items to bill — opening manual entry');
              openAddDispatch(po);
              return;
            }
            // Mirror the server's safety rule: never auto-bill a line with no
            // rate. If any line is unrated, open the manual modal so mam can
            // fill the selling rate instead of billing zero.
            if (rows.some(r => !(+r.rate > 0))) {
              closeWin();
              toast('Some items have no rate — fill rates to bill', { icon: '✏️' });
              openAddDispatch(po);
              return;
            }
            const sameState = (billRes.data?.client_state || '').toLowerCase() === 'punjab';
            const cgst_pct = sameState ? 9 : 0;
            const sgst_pct = sameState ? 9 : 0;
            const igst_pct = sameState ? 0 : 18;
            const subtotal = rows.reduce((s, it) => s + (it.amount || 0), 0);
            const grandTotal = subtotal + subtotal * (cgst_pct + sgst_pct + igst_pct) / 100;
            const fd = new FormData();
            fd.append('vendor_po_id', po.id);
            fd.append('document_type', 'sales_bill');
            fd.append('delivery_date', new Date().toISOString().slice(0, 10));
            if (billRes.data?.client_state) fd.append('place_of_supply', billRes.data.client_state);
            if (billRes.data?.client_state_code) fd.append('state_code', billRes.data.client_state_code);
            fd.append('cgst_pct', cgst_pct);
            fd.append('sgst_pct', sgst_pct);
            fd.append('igst_pct', igst_pct);
            fd.append('items', JSON.stringify(rows));
            fd.append('subtotal_amount', subtotal.toFixed(2));
            fd.append('grand_total_amount', grandTotal.toFixed(2));
            const r = await api.post('/procurement/delivery-notes', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
            toast.success(`Sales Bill ${r.data?.document_number || ''} generated`);
            load();
            if (r.data?.id) {
              const printRes = await api.get(`/procurement/delivery-notes/${r.data.id}/print`, { responseType: 'arraybuffer' });
              const url = URL.createObjectURL(new Blob([printRes.data], { type: 'text/html;charset=utf-8' }));
              if (printWin) printWin.location = url; else window.open(url, '_blank');
            } else { closeWin(); }
          } catch (err) {
            closeWin();
            toast.error(err.response?.data?.error || 'Failed to generate Sales Bill');
          }
        };
        // Helper — fetch the items on the linked vendor PO so mam can
        // adjust received qty per line in the modal (mam 2026-06-02:
        // "delivery note item of qty 10 but when erec its 9" +
        // "item wise not showing" → console.warn + indent fallback +
        // "by deault pick which items in delivery note" → when nothing
        // comes back, seed ONE blank manual row so mam can just start
        // typing instead of clicking "+ Add Item" first).
        const blankManualRow = () => ({
          vpi_id: `manual-${Date.now()}-0`,
          description: '',
          master_name: '',
          item_code: '',
          specification: '',
          size: '',
          unit: '',
          ordered_qty: 0,
          received_qty: 0,
          short_reason: '',
        });
        const loadReceiveItems = async (vendorPoId) => {
          if (!vendorPoId) { setReceiveItems([blankManualRow()]); return; }
          try {
            // Mam (2026-06-02): "only qty show but editable like if
            // challan then show same items".  Source items from the
            // SAME endpoint that drives the printed Delivery Note PDF
            // (/vendor-po/:id/delivery-note-data) — guarantees the
            // modal shows exactly the rows mam sees on the challan
            // she's holding.  Description / unit / qty are locked;
            // only Received qty (and Short reason on shortage) edit.
            const r = await api.get(`/procurement/vendor-po/${vendorPoId}/delivery-note-data`);
            const raw = r.data?.items || [];
            if (raw.length === 0) {
              console.warn(`[receive-items] PO ${vendorPoId} delivery-note-data returned 0 items — seeding 1 blank manual row.`);
              setReceiveItems([blankManualRow()]);
              return;
            }
            const items = raw.map(it => ({
              vpi_id: it.id,
              description: it.description || it.master_name || '—',
              master_name: it.description || '',  // DN uses 'description' as primary label
              item_code: it.item_code || '',
              specification: it.specification || '',
              size: it.size || '',
              make: it.make || '',
              unit: it.uom || '',
              hsn: it.hsn_code || it.gst_text || '',
              ordered_qty: +it.quantity || 0,
              received_qty: +it.quantity || 0,   // defaults to full delivery
              short_reason: '',
            }));
            setReceiveItems(items);
          } catch (err) {
            console.error('[receive-items] delivery-note-data fetch failed:', err?.response?.status, err?.message);
            // Even on fetch failure, seed a blank row so mam isn't blocked.
            setReceiveItems([blankManualRow()]);
          }
        };

        // Build receive rows from a delivery note's own items_json. Used for
        // from-store challans / Sales Bills (mam 2026-06-06: "items not show")
        // — they have no Vendor PO, so loadReceiveItems(vendor_po_id) came up
        // empty and seeded a blank row. Their lines live in items_json
        // ({description, qty|quantity, unit, rate, ...}).
        const loadReceiveItemsFromJson = (itemsJson) => {
          let arr = [];
          try { arr = JSON.parse(itemsJson || '[]') || []; } catch (_) {}
          if (!Array.isArray(arr) || arr.length === 0) { setReceiveItems([blankManualRow()]); return; }
          setReceiveItems(arr.map(it => {
            const qty = +it.qty || +it.quantity || 0;
            return {
              vpi_id: null,
              description: it.description || it.master_name || '—',
              master_name: it.description || '',
              item_code: it.item_code || '',
              specification: it.specification || '',
              size: it.size || '',
              make: it.make || '',
              unit: it.unit || it.uom || '',
              hsn: it.hsn || it.hsn_code || '',
              ordered_qty: qty,
              received_qty: qty,
              short_reason: '',
            };
          }));
        };

        const openMarkReceived = (d) => {
          setForm({
            receive_id: d.id,
            receive_vendor_po_id: d.vendor_po_id,
            receive_doc: `${d.document_type === 'challan' ? 'Challan' : 'Sales Bill'} ${d.document_number || '#' + d.id}`,
            received_by_name: '',
            received_at: new Date().toISOString().slice(0, 10),
          });
          setReceiveItems([]);
          // From-store (no PO) → read lines from the note's items_json;
          // PO-linked → pull from the PO's delivery-note-data as before.
          if (d.vendor_po_id) loadReceiveItems(d.vendor_po_id);
          else loadReceiveItemsFromJson(d.items_json);
          setModal('receive');
        };
        // Upload receiving for a Ready-to-Dispatch PO directly (no dispatch
        // doc yet). The receive modal collects the receiver + signed proof;
        // markReceived() auto-creates the Challan dispatch (auto DC number)
        // then records the receipt against it.
        const openReceivePo = (po) => {
          setForm({
            receive_po_id: po.id,
            receive_vendor_po_id: po.id,
            receive_doc: `${po.po_number}${po.vendor_name ? ' · ' + po.vendor_name : ''}`,
            received_by_name: '',
            received_at: new Date().toISOString().slice(0, 10),
          });
          setReceiveItems([]);
          loadReceiveItems(po.id);
          setModal('receive');
        };
        return (
        <>
          {/* Sub-tabs (mam 2026-05-25) */}
          <div className="flex justify-between items-center flex-wrap gap-2">
            <div className="flex gap-1 border-b border-gray-200 -mb-px">
              <button onClick={() => setDispatchSubTab('ready')}
                className={`px-3 py-1.5 text-xs font-semibold border-b-2 -mb-px ${dispatchSubTab === 'ready' ? 'border-indigo-500 text-indigo-700 bg-indigo-50' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                Ready to Dispatch <span className="ml-1 text-[10px] opacity-80">({readyToDispatch.length + sbPendingDNs.length})</span>
              </button>
              <button onClick={() => setDispatchSubTab('list')}
                className={`px-3 py-1.5 text-xs font-semibold border-b-2 -mb-px ${dispatchSubTab === 'list' ? 'border-red-600 text-red-700 bg-red-50' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                Dispatch &amp; Receiving <span className="ml-1 text-[10px] opacity-80">({deliveryNotes.length})</span>
              </button>
            </div>
          </div>

          {/* ===== Sub-tab 1: Ready to dispatch ===== */}
          {dispatchSubTab === 'ready' && readyToDispatch.length === 0 && sbPendingDNs.length === 0 && (
            <div className="card text-center py-8 text-gray-400 text-xs">Nothing awaiting a Sales Bill / dispatch. 🎉</div>
          )}
          {/* From-store (no-PO) challans awaiting a Sales Bill — mam 2026-06-04. */}
          {dispatchSubTab === 'ready' && sbPendingDNs.length > 0 && (
            <div className="card p-3 bg-amber-50 border border-amber-200 mb-3">
              <h4 className="font-semibold text-amber-800 text-sm mb-2">
                From-Store · Sales Bill pending
                <span className="text-xs font-normal text-amber-700 ml-2">({sbPendingDNs.length})</span>
              </h4>
              <div className="overflow-auto max-h-[40vh]">
                <table className="text-xs w-full">
                  <thead><tr className="bg-amber-100/50">
                    <th className="px-2 py-1 text-left">Challan No</th>
                    <th className="px-2 py-1 text-left">Site / Company</th>
                    <th className="px-2 py-1">Date</th>
                    <th className="px-2 py-1 text-right">Actions</th>
                  </tr></thead>
                  <tbody>
                    {sbPendingDNs.map(d => (
                      <tr key={d.id} className="border-b border-amber-100">
                        <td className="px-2 py-1.5 font-semibold text-blue-800 whitespace-nowrap">{d.document_number}<span className="ml-1 text-[9px] text-indigo-600">📦 FROM STORE</span></td>
                        <td className="px-2 py-1.5 max-w-[260px] truncate">{d.site_name || '—'}</td>
                        <td className="px-2 py-1.5 text-center whitespace-nowrap">{d.delivery_date || '—'}</td>
                        <td className="px-2 py-1.5 text-right whitespace-nowrap">
                          <button onClick={async () => { const res = await api.get(`/procurement/delivery-notes/${d.id}/print`, { responseType: 'arraybuffer' }); const url = URL.createObjectURL(new Blob([res.data], { type: 'text/html' })); window.open(url, '_blank'); }} className="text-[10px] px-2 py-1 mr-1 rounded border border-gray-300 hover:bg-gray-50">Print</button>
                          <button onClick={() => generateSalesBill(d)} className="text-[10px] px-2 py-1 rounded bg-amber-100 text-amber-800 border border-amber-300 hover:bg-amber-200 font-semibold">Add Sales Bill</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {dispatchSubTab === 'ready' && readyToDispatch.length > 0 && (
            <div className="card p-3 bg-indigo-50 border border-indigo-200">
              <div className="flex items-center justify-between mb-2 flex-wrap gap-1">
                <h4 className="font-semibold text-indigo-800 text-sm">
                  Ready to Dispatch
                  <span className="text-xs font-normal text-indigo-600 ml-2">({readyToDispatch.length} PO{readyToDispatch.length === 1 ? '' : 's'})</span>
                </h4>
                <span className="text-[11px] text-indigo-700">POs with Purchase Bill uploaded but no Dispatch yet — Sales Bill for PO items, Challan for FOC/RGP</span>
              </div>
              {/* Search strip (mam 2026-05-25) */}
              <div className="flex flex-wrap items-end gap-2 text-xs mb-3 pb-3 border-b border-indigo-200">
                <div className="flex-1 min-w-[200px]">
                  <label className="label text-[10px] mb-0.5 text-indigo-900">Search · PO no / vendor / indent</label>
                  <input className="input text-xs" placeholder="e.g. VPO-0042"
                    value={dispReadySearch} onChange={e => { setDispReadySearch(e.target.value); setDispReadyPage(1); }} />
                </div>
                {dispReadySearch && (
                  <button type="button" className="btn btn-secondary text-xs py-1 px-2"
                    onClick={() => { setDispReadySearch(''); setDispReadyPage(1); }}>Reset</button>
                )}
                <div className="ml-auto text-[11px] text-indigo-900">
                  Showing <span className="font-semibold">{filteredReady.length}</span> of {readyToDispatch.length}
                </div>
              </div>
              <div className="hidden md:block overflow-auto max-h-[70vh]">
                <table className="text-xs freeze-head">
                  <thead><tr className="bg-indigo-100/50">
                    <th className="px-2 py-1 text-left">PO Number</th>
                    <th className="px-2 py-1 text-left">Vendor</th>
                    <th className="px-2 py-1">PO Date</th>
                    <th className="px-2 py-1">Expected Receipt</th>
                    <th className="px-2 py-1 text-right">Amount</th>
                    <th className="px-2 py-1"></th>
                  </tr></thead>
                  <tbody>
                    {readyPg.rows.map(po => (
                      <tr key={po.id} className="border-b border-indigo-100">
                        <td className="px-2 py-1.5 font-semibold text-red-700 whitespace-nowrap">
                          {po.po_number}
                          <a href={`/vendor-po/${po.id}/print`} target="_blank" rel="noopener noreferrer" className="block text-[10px] text-red-600 hover:text-red-800 underline font-normal">📄 View PO</a>
                          <a href={`/vendor-po/${po.id}/delivery-note`} target="_blank" rel="noopener noreferrer" className="block text-[10px] text-emerald-700 hover:text-emerald-900 underline font-normal">🚚 Delivery Note</a>
                        </td>
                        <td className="px-2 py-1.5 max-w-[220px] truncate">{po.vendor_name}</td>
                        <td className="px-2 py-1.5 text-center whitespace-nowrap">{po.po_date || <span className="text-gray-300">—</span>}</td>
                        <td className="px-2 py-1.5 text-center whitespace-nowrap">{po.expected_receipt_date || <span className="text-gray-300">—</span>}</td>
                        <td className="px-2 py-1.5 text-right font-semibold whitespace-nowrap">
                          Rs {(+po.display_total || +po.total_amount || 0).toLocaleString('en-IN')}
                          {+po.total_amount_drift > 1 && (
                            <div className="text-[9px] text-amber-700 font-normal" title={`Stored: Rs ${(+po.total_amount).toLocaleString('en-IN')} · Items sum + 18% GST: Rs ${(+po.display_total).toLocaleString('en-IN')}`}>
                              ⚠ drift Rs {(+po.total_amount_drift).toLocaleString('en-IN')}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          <button onClick={() => autoDispatchSalesBill(po)} className="btn btn-primary text-[10px] px-2 py-1 whitespace-nowrap" title="Auto-generate the Sales Bill PDF (BOQ×delivery% rates + client GST) and open it — no form to fill. The PO then moves to Dispatch & Receiving for the site engineer to upload the signed receipt.">Dispatch</button>
                        </td>
                      </tr>
                    ))}
                    {filteredReady.length === 0 && (
                      <tr><td colSpan="6" className="text-center py-6 text-indigo-700">No POs match the current filters.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards — polished pattern matching Indents (mam). */}
              <div className="md:hidden space-y-3">
                {readyPg.rows.map(po => (
                  <div key={po.id} className="card p-3 space-y-2">
                    <div className="flex justify-between items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">PO Number</div>
                        <div className="text-lg font-bold text-gray-900 truncate">{po.po_number}</div>
                        <div className="text-[11px] text-gray-500 flex items-center gap-1 mt-0.5">
                          <FiCalendar size={10} className="text-gray-400" />
                          {po.po_date || '—'}
                        </div>
                      </div>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-indigo-300 bg-indigo-50 text-indigo-700 uppercase">Ready</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 pt-1 border-t border-gray-100 text-[11px]">
                      <div>
                        <div className="text-[9px] uppercase text-gray-400">Vendor</div>
                        <div className="font-medium text-gray-700 truncate" title={po.vendor_name}>{po.vendor_name || '—'}</div>
                      </div>
                      <div>
                        <div className="text-[9px] uppercase text-gray-400">Expected</div>
                        <div className="font-medium text-gray-700">{po.expected_receipt_date || '—'}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-[9px] uppercase text-gray-400">Amount</div>
                        <div className="font-semibold text-emerald-700">Rs {(+po.display_total || +po.total_amount || 0).toLocaleString('en-IN')}</div>
                        {+po.total_amount_drift > 1 && <div className="text-[9px] text-amber-700">⚠ drift</div>}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-xs pt-1 border-t border-gray-100 flex-wrap">
                      <a href={`/vendor-po/${po.id}/print`} target="_blank" rel="noopener noreferrer" className="text-red-600 hover:underline flex items-center gap-1 font-semibold">
                        <FiPrinter size={11} /> Print PO
                      </a>
                      <a href={`/vendor-po/${po.id}/delivery-note`} target="_blank" rel="noopener noreferrer" className="text-emerald-700 hover:underline flex items-center gap-1 font-semibold">
                        🚚 Delivery Note
                      </a>
                    </div>
                    <button onClick={() => autoDispatchSalesBill(po)} className="btn btn-primary text-sm py-2 px-3 w-full mt-1">Dispatch</button>
                  </div>
                ))}
                {filteredReady.length === 0 && (
                  <div className="card p-6 text-center text-indigo-700 text-sm">No POs match the current filters.</div>
                )}
              </div>
              <Pagination pg={readyPg} setPerPage={setDispReadyPerPage} className="border-t border-indigo-200 pt-2" />
            </div>
          )}

          {/* ===== Sub-tab 2: Main dispatch list ===== */}
          {dispatchSubTab === 'list' && (
            <>
              <div className="flex justify-between items-center flex-wrap gap-2">
                <h3 className="font-semibold">Dispatch & Receiving</h3>
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Add Delivery Note · mam (2026-05-25): "here also add
                      delivery note for rec".  Opens the same modal but
                      pre-set to document_type='challan' — used for FOC
                      / RGP / receipt-only goods where no Sales Bill is
                      issued. */}
                  <button onClick={() => openAddDispatch(null, 'challan')} className="btn btn-secondary flex items-center gap-2 text-sm">
                    <FiPlus /> Add Delivery Note
                  </button>
                  <button onClick={() => openAddDispatch(null, 'sales_bill')} className="btn btn-primary flex items-center gap-2">
                    <FiPlus /> Add Sales Bill
                  </button>
                </div>
              </div>
              <div className="card p-3 flex flex-wrap items-end gap-2 text-xs">
                <div className="flex-1 min-w-[200px]">
                  <label className="label text-[10px] mb-0.5">Search · PO no / doc no / received by</label>
                  <input className="input text-xs" placeholder="e.g. VPO-0042"
                    value={dispListSearch} onChange={e => { setDispListSearch(e.target.value); setDispListPage(1); }} />
                </div>
                <div>
                  <label className="label text-[10px] mb-0.5">Status</label>
                  <select className="select text-xs" value={dispListStatus}
                    onChange={e => { setDispListStatus(e.target.value); setDispListPage(1); }}>
                    <option value="all">All</option>
                    <option value="dispatched">Dispatched</option>
                    <option value="received">Received</option>
                  </select>
                </div>
                <div>
                  <label className="label text-[10px] mb-0.5">Received From</label>
                  <input className="input text-xs" type="date" value={dispListFrom}
                    onChange={e => { setDispListFrom(e.target.value); setDispListPage(1); }} />
                </div>
                <div>
                  <label className="label text-[10px] mb-0.5">Received To</label>
                  <input className="input text-xs" type="date" value={dispListTo}
                    onChange={e => { setDispListTo(e.target.value); setDispListPage(1); }} />
                </div>
                {(dispListSearch || dispListStatus !== 'all' || dispListFrom || dispListTo) && (
                  <button type="button" className="btn btn-secondary text-xs py-1 px-2"
                    onClick={() => { setDispListSearch(''); setDispListStatus('all'); setDispListFrom(''); setDispListTo(''); setDispListPage(1); }}>Reset</button>
                )}
                <div className="ml-auto text-[11px] text-gray-500">
                  Showing <span className="font-semibold text-gray-700">{filteredDispatch.length}</span> of {deliveryNotes.length}
                </div>
              </div>
          <div className="card p-0 overflow-auto max-h-[70vh] hidden md:block"><table className="freeze-head freeze-col">
            {/* Mam (2026-06-02): "site name also show here delivery note
                number and against it we will upload receiving".  Bill-
                upload now auto-creates the DN row (commit c7e86ac).
                For legacy billed POs that don't have a DN yet (the
                backfill in schema.js may not have fired on the VPS),
                we ALSO render synthetic "AWAITING" rows below — so
                mam always sees the data and can still Upload Receiving
                which creates the DN inline. */}
            <thead><tr><th>Delivery Note No</th><th>Type</th><th>PO</th><th>Site / Company</th><th>Indent By</th><th>Date</th><th>File</th><th>Received By</th><th>Received On</th><th>Proof</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {/* Receiving (signed receipt) is only against CLIENT delivery
                  notes — NOT vendor POs (mam 2026-06-06: "this vendor wise not
                  required rec; rec is only against client for delivery note").
                  The old synthetic "auto on receive / Upload Receiving" rows for
                  billed Vendor POs were removed. Those POs still live in the
                  "Ready to Dispatch" sub-tab where the client Sales Bill /
                  Delivery Note is created; once created, the real DN shows here
                  for the client's signed receipt. */}
              {dispListPg.rows.map(d => (
                <tr key={d.id}>
                  <td className="font-mono font-semibold text-blue-800">
                    {d.document_number || <span className="text-gray-300 font-sans">—</span>}
                    <div className="text-[10px] text-gray-400 font-sans font-normal">#{d.id}</div>
                  </td>
                  <td>
                    <div className="flex flex-col gap-1 items-start">
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${d.document_type === 'sales_bill' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : d.document_type === 'challan' ? 'bg-sky-50 text-sky-700 border-sky-200' : 'bg-gray-50 text-gray-500 border-gray-200'}`}>
                        {d.document_type === 'sales_bill' ? 'SALES BILL' : d.document_type === 'challan' ? 'CHALLAN' : '—'}
                      </span>
                      {d.source === 'store' && (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border bg-indigo-50 text-indigo-700 border-indigo-300" title="Material issued from store — no Vendor PO">📦 FROM STORE</span>
                      )}
                      {d.is_draft === 1 && (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border bg-red-50 text-red-700 border-red-300" title="Auto-generated Sales Bill — needs client GSTIN / selling rates before sending">✏️ DRAFT</span>
                      )}
                      {/* Sales Bill pending chip — mam (2026-05-25): when
                          dispatched with Challan only and SB will follow
                          later, this amber chip lingers until SB is
                          uploaded via the Add Sales Bill button below. */}
                      {d.sales_bill_pending === 1 && !d.sales_bill_number && (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border bg-amber-50 text-amber-700 border-amber-300" title="Goods delivered on a Challan only — formal Sales Bill is still pending. Click 'Add Sales Bill' in actions to upload when it arrives.">
                          📋 SB PENDING
                        </span>
                      )}
                      {d.sales_bill_number && (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border bg-emerald-50 text-emerald-700 border-emerald-200" title={`Sales Bill ${d.sales_bill_number} uploaded`}>
                          ✓ SB {d.sales_bill_number}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="text-xs">{d.vendor_po_number || (d.source === 'store' ? <span className="text-indigo-600 text-[10px] font-semibold">From Store</span> : <span className="text-gray-300">—</span>)}<div className="text-[10px] text-gray-500">{d.vendor_name || ''}</div></td>
                  {/* Site (mam 2026-06-02) — pulled from indents.site_id via the GET /delivery-notes JOIN */}
                  <td className="text-xs">{d.site_name || <span className="text-gray-300">—</span>}</td>
                  {/* Indent By (mam 2026-06-29) — who raised the originating indent
                      (indents.raised_by_name), resolved via the same JOIN. Blank for
                      dispatches with no linked indent. */}
                  <td className="text-xs">{d.raised_by_name || <span className="text-gray-300">—</span>}</td>
                  <td>{d.delivery_date}</td>
                  <td>
                    {d.file_path
                      ? <a href={d.file_path} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline text-xs">View</a>
                      : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                  <td>{d.received_by_name || <span className="text-gray-300 text-xs">—</span>}</td>
                  <td className="text-xs">{d.received_at ? new Date(d.received_at).toLocaleDateString() : <span className="text-gray-300">—</span>}</td>
                  <td>
                    {d.receipt_file_path
                      ? <a href={d.receipt_file_path} target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:text-emerald-800 underline text-xs font-semibold">Signed ✓</a>
                      : d.received_by_name
                        ? <span className="text-amber-600 text-[11px]">No photo</span>
                        : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                  <td><StatusBadge status={d.status} /></td>
                  <td className="whitespace-nowrap">
                    {/* Print the auto-generated SEPL Delivery Note / Sales
                        Bill PDF (mam's templates). Fetched via axios so the
                        Bearer token rides along, then opened as a Blob URL —
                        plain window.open with a header-auth API would 401. */}
                    <button
                      onClick={async () => {
                        try {
                          // arraybuffer + utf-8 blob so ₹ / em-dash /
                          // 🖨 emoji don't render as Latin-1 mojibake.
                          const res = await api.get(`/procurement/delivery-notes/${d.id}/print`, { responseType: 'arraybuffer' });
                          const blob = new Blob([res.data], { type: 'text/html;charset=utf-8' });
                          window.open(URL.createObjectURL(blob), '_blank', 'noopener');
                        } catch (err) {
                          toast.error(err.response?.data?.error || 'Could not generate document');
                        }
                      }}
                      className="btn btn-secondary text-[10px] px-2 py-1 mr-1"
                      title={`Print SEPL ${d.document_type === 'challan' ? 'Delivery Note' : 'Sales Bill'}`}
                    >🖨 Print</button>
                    {d.document_type === 'sales_bill' && (canApprove('procurement') || isAdmin()) && (
                      <button onClick={() => openEditRate(d)} className="text-[10px] px-2 py-1 mr-1 rounded bg-indigo-100 text-indigo-800 border border-indigo-300 hover:bg-indigo-200 font-semibold" title="Edit the selling rate per line — fills the invoice amounts">✏️ Edit rate</button>
                    )}
                    {!d.received_by_name && (
                      <button onClick={() => openMarkReceived(d)} className="btn btn-success text-[10px] px-2 py-1 mr-1">Mark Received</button>
                    )}
                    {/* Add Sales Bill — only when this dispatch was marked
                        sales_bill_pending=1 AND no SB has been uploaded yet
                        (mam 2026-05-25). */}
                    {d.sales_bill_pending === 1 && !d.sales_bill_number && (canApprove('procurement') || isAdmin()) && (
                      <button onClick={() => generateSalesBill(d)} className="text-[10px] px-2 py-1 mr-1 rounded bg-amber-100 text-amber-800 border border-amber-300 hover:bg-amber-200 font-semibold">
                        Add Sales Bill
                      </button>
                    )}
                    {canDelete('procurement') && <button onClick={async () => {
                      if (!confirm(`Delete dispatch #${d.id}?`)) return;
                      try { await api.delete(`/procurement/delivery-notes/${d.id}`); toast.success('Deleted'); load(); }
                      catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                    }} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}
                  </td>
                </tr>
              ))}
              {deliveryNotes.length === 0 && <tr><td colSpan="12" className="text-center py-8 text-gray-400">No dispatches yet</td></tr>}
              {deliveryNotes.length > 0 && filteredDispatch.length === 0 && <tr><td colSpan="12" className="text-center py-8 text-gray-400">No dispatches match the current filters.</td></tr>}
            </tbody>
            <tfoot><tr><td colSpan="12" className="border-t border-gray-100"><Pagination pg={dispListPg} setPerPage={setDispListPerPage} /></td></tr></tfoot>
          </table></div>

          {/* Mobile cards.  Each card leads with the DN number (mam
              2026-06-02: "delivery note number and against it we will
              upload receiving").  Synthetic AWAITING cards appear at
              the top as a fallback for billed POs that don't yet have
              a delivery_notes row — they still let mam Upload Receiving
              and Sotyn.Headmasters will mint the real DN number on submit. */}
          <div className="md:hidden space-y-3">
            {/* Vendor-PO "Upload Receiving" cards removed — receiving is only
                against client delivery notes (mam 2026-06-06). */}
            {dispListPg.rows.map(d => (
              <div key={d.id} className="card p-3 space-y-2">
                <div className="flex justify-between items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${d.document_type === 'sales_bill' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : d.document_type === 'challan' ? 'bg-sky-50 text-sky-700 border-sky-200' : 'bg-gray-50 text-gray-500 border-gray-200'}`}>
                        {d.document_type === 'sales_bill' ? 'SALES BILL' : d.document_type === 'challan' ? 'CHALLAN' : '—'}
                      </span>
                      <span className="text-[10px] text-gray-400">#{d.id}</span>
                    </div>
                    <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Delivery Note No</div>
                    <div className="text-lg font-bold text-gray-900 truncate">{d.document_number || <span className="text-gray-300 text-sm">— pending —</span>}</div>
                    <div className="text-[11px] text-gray-500 flex items-center gap-1 mt-0.5">
                      <FiCalendar size={10} className="text-gray-400" />
                      {d.delivery_date || '—'}
                    </div>
                  </div>
                  <StatusBadge status={d.status} />
                </div>
                {/* Site (mam 2026-06-02) */}
                {d.site_name && (
                  <div className="flex items-start gap-1.5 text-xs">
                    <FiMapPin size={12} className="mt-0.5 text-red-500 flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="text-[10px] uppercase text-gray-400">Site</div>
                      <div className="font-medium text-gray-800">{d.site_name}</div>
                    </div>
                  </div>
                )}
                {/* Indent By (mam 2026-06-29) — who raised the originating indent */}
                {d.raised_by_name && (
                  <div className="flex items-start gap-1.5 text-xs">
                    <FiUser size={12} className="mt-0.5 text-gray-400 flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="text-[10px] uppercase text-gray-400">Indent By</div>
                      <div className="font-medium text-gray-800">{d.raised_by_name}</div>
                    </div>
                  </div>
                )}
                {(d.sales_bill_pending === 1 && !d.sales_bill_number) && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-300 inline-block">📋 SB Pending</span>
                )}
                {d.sales_bill_number && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200 inline-block">✓ SB {d.sales_bill_number}</span>
                )}
                <div className="grid grid-cols-2 gap-2 pt-1 border-t border-gray-100 text-[11px]">
                  <div>
                    <div className="text-[9px] uppercase text-gray-400">PO</div>
                    <div className="font-mono font-semibold text-blue-800 truncate">{d.vendor_po_number || '—'}</div>
                    {d.vendor_name && <div className="text-[10px] text-gray-500 truncate" title={d.vendor_name}>{d.vendor_name}</div>}
                  </div>
                  <div className="text-right">
                    <div className="text-[9px] uppercase text-gray-400">Received By</div>
                    <div className="font-medium text-gray-700 truncate">{d.received_by_name || <span className="text-gray-300">—</span>}</div>
                    {d.received_at && <div className="text-[10px] text-gray-500">{new Date(d.received_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</div>}
                  </div>
                </div>
                {(d.file_path || d.receipt_file_path) && (
                  <div className="flex items-center gap-3 text-xs pt-1 border-t border-gray-100 flex-wrap">
                    {d.file_path && <a href={d.file_path} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline flex items-center gap-1 font-semibold">📄 Doc</a>}
                    {d.receipt_file_path && <a href={d.receipt_file_path} target="_blank" rel="noopener noreferrer" className="text-emerald-700 hover:underline flex items-center gap-1 font-semibold">✓ Signed Receipt</a>}
                  </div>
                )}
                {/* Primary action — Mark Received (when not yet received) */}
                {!d.received_by_name && (
                  <button onClick={() => openMarkReceived(d)} className="btn btn-success text-sm py-2 px-3 w-full mt-1">Mark Received</button>
                )}
                {/* Secondary actions row */}
                <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-100 text-xs flex-wrap">
                  <button
                    onClick={async () => {
                      try {
                        const res = await api.get(`/procurement/delivery-notes/${d.id}/print`, { responseType: 'arraybuffer' });
                        const blob = new Blob([res.data], { type: 'text/html;charset=utf-8' });
                        window.open(URL.createObjectURL(blob), '_blank', 'noopener');
                      } catch (err) {
                        toast.error(err.response?.data?.error || 'Could not generate document');
                      }
                    }}
                    className="text-gray-600 hover:underline flex items-center gap-1 font-semibold"
                  >🖨 Print</button>
                  {d.sales_bill_pending === 1 && !d.sales_bill_number && (canApprove('procurement') || isAdmin()) && (
                    <button onClick={() => generateSalesBill(d)} className="text-amber-700 hover:underline flex items-center gap-1 font-semibold">+ Add Sales Bill</button>
                  )}
                  {/* Edit rate — desktop-table action, now on mobile too (mam 2026-07-06). */}
                  {d.document_type === 'sales_bill' && (canApprove('procurement') || isAdmin()) && (
                    <button onClick={() => openEditRate(d)} className="text-blue-600 hover:underline flex items-center gap-1 font-semibold">✏️ Edit rate</button>
                  )}
                  {canDelete('procurement') && (
                    <button onClick={async () => {
                      if (!confirm(`Delete dispatch #${d.id}?`)) return;
                      try { await api.delete(`/procurement/delivery-notes/${d.id}`); toast.success('Deleted'); load(); }
                      catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                    }} className="text-red-600 hover:underline flex items-center gap-1 font-semibold">
                      <FiTrash2 size={11} /> Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
            {deliveryNotes.length === 0 && <div className="card p-6 text-center text-gray-400 text-sm">No dispatches yet</div>}
            {deliveryNotes.length > 0 && filteredDispatch.length === 0 && <div className="card p-6 text-center text-gray-400 text-sm">No dispatches match the current filters.</div>}
            <Pagination pg={dispListPg} setPerPage={setDispListPerPage} />
          </div>
            </>
          )}
        </>
        );
      })()}

      {/* ===== Debit Notes tab (mam 2026-06-04 post-PO chart, stage 7) ===== */}
      {tab === 'debitnotes' && (
        <div className="space-y-3">
          <div className="card p-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-gray-800">Debit Notes &amp; Short-Supply Notices</h3>
              <p className="text-xs text-gray-500">Auto-generated on variance: <b>extra rate</b> (bill over PO), <b>short supply</b> (received &lt; ordered), <b>rejected</b> material (at GRN). They appear here automatically — the button is only for a manual/discretionary debit.</p>
            </div>
            <button onClick={openDnModal} className="btn btn-secondary flex items-center gap-2" title="Most debits are raised automatically on variance — use this only for a manual one"><FiPlus /> Manual Debit Note</button>
          </div>
          <div className="card p-0 overflow-x-auto">
            <table className="text-sm w-full freeze-head">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">No.</th>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Type</th>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Vendor</th>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Against PO</th>
                  <th className="text-right px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Amount</th>
                  <th className="text-center px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Status</th>
                  <th className="text-right px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody>
                {debitNotes.length === 0 && <tr><td colSpan="7" className="text-center py-8 text-gray-400">No debit notes yet — they appear here automatically when a bill exceeds a PO, material is received short, or rejected at GRN.</td></tr>}
                {debitNotes.map(d => {
                  const typeLabel = d.type === 'extra_rate' ? 'Extra Rate' : d.type === 'short_supply' ? 'Short Supply' : 'Rejected';
                  const typeCls = d.type === 'extra_rate' ? 'bg-amber-50 text-amber-700 border-amber-200' : d.type === 'short_supply' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-red-50 text-red-700 border-red-200';
                  return (
                    <tr key={d.id} className="border-t hover:bg-gray-50">
                      <td className="px-3 py-2 font-mono text-[11px] text-gray-600">{d.dn_number}</td>
                      <td className="px-3 py-2"><span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${typeCls}`}>{typeLabel}</span></td>
                      <td className="px-3 py-2">{d.vendor_name || '—'}</td>
                      <td className="px-3 py-2 font-mono text-[11px]">{d.po_number || '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold">₹ {Math.round(+d.amount || 0).toLocaleString('en-IN')}</td>
                      <td className="px-3 py-2 text-center"><span className="text-[10px] uppercase text-gray-600">{d.status}</span></td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <a href={`/debit-note/${d.id}/print`} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline text-xs font-medium">View / Print</a>
                        <button onClick={async () => { if (!confirm(`Delete debit note ${d.dn_number}?`)) return; try { await api.delete(`/procurement/debit-notes/${d.id}`); toast.success('Deleted'); loadDebitNotes(); } catch { toast.error('Delete failed'); } }} className="ml-2 p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ===== PO Pipeline tab (mam 2026-06-04 post-PO chart) ===== */}
      {tab === 'pipeline' && (() => {
        const Stage = ({ done, label, sub, tone = 'emerald' }) => (
          <div className="flex flex-col items-center min-w-[70px]">
            <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold border ${done ? (tone === 'emerald' ? 'bg-emerald-100 text-emerald-700 border-emerald-300' : 'bg-blue-100 text-blue-700 border-blue-300') : 'bg-gray-50 text-gray-300 border-gray-200'}`}>{done ? '✓' : '○'}</span>
            <span className={`text-[9px] mt-0.5 uppercase tracking-wide ${done ? 'text-gray-700 font-semibold' : 'text-gray-400'}`}>{label}</span>
            {sub && <span className="text-[8px] text-gray-400">{sub}</span>}
          </div>
        );
        const conn = 'flex-1 h-px bg-gray-200 mt-3 mx-1 min-w-[12px]';
        return (
          <div className="space-y-3">
            <div className="card p-4 flex items-center justify-between gap-3">
              <div>
                <h3 className="font-semibold text-gray-800">Post-PO Pipeline</h3>
                <p className="text-xs text-gray-500">Where each Vendor PO stands: PO → Delivery → Received → Bill → Vendor Paid.</p>
              </div>
              <button onClick={loadPipeline} className="btn btn-secondary flex items-center gap-2 text-sm"><FiRefreshCw size={14} /> Refresh</button>
            </div>
            {pipeline.length === 0 && <div className="card p-6 text-center text-gray-400 text-sm">No vendor POs yet.</div>}
            <div className="space-y-2">
              {pipeline.map(p => {
                const received = (+p.grn_count > 0) || (+p.dn_received > 0);
                const paid = p.bill_payment_status === 'paid';
                return (
                  <div key={p.id} className="card p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                      <div className="min-w-0">
                        <span className="font-mono font-semibold text-blue-800">{p.po_number}</span>
                        <span className="text-gray-400 mx-1">·</span>
                        <span className="text-sm text-gray-700">{p.vendor_name || '—'}</span>
                        {p.site_name && <span className="text-[11px] text-gray-400 ml-2">{p.site_name}</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        {+p.debit_count > 0 && <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded border bg-red-50 text-red-700 border-red-200">{p.debit_count} debit</span>}
                        <span className="text-sm font-semibold tabular-nums text-gray-700">₹ {Math.round(+p.total_amount || 0).toLocaleString('en-IN')}</span>
                        <a href={`/vendor-po/${p.id}/print`} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline text-xs font-medium">PO</a>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <Stage done={true} label="PO" sub={p.po_date || ''} tone="blue" />
                      <div className={conn} />
                      <Stage done={+p.dn_count > 0} label="Delivery" sub={+p.dn_count > 0 ? `${p.dn_count} note` : ''} />
                      <div className={conn} />
                      <Stage done={received} label="Received" sub={+p.grn_count > 0 ? 'GRN' : (+p.dn_received > 0 ? 'signed' : '')} />
                      <div className={conn} />
                      <Stage done={+p.bill_count > 0} label="P.Bill" sub={+p.bill_count > 0 ? `${p.bill_count}` : ''} />
                      <div className={conn} />
                      <Stage done={paid} label="Paid" sub={p.bill_payment_status || (p.payment_block_status === 'pending' ? 'blocked' : '')} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Raise Debit Note modal */}
      <Modal isOpen={dnModal} onClose={() => setDnModal(false)} title="Raise Debit Note / Short-Supply Notice">
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Type</label>
              <select className="select" value={dnForm.type} onChange={e => setDnForm(f => ({ ...f, type: e.target.value, loaded: false, items: [], amount: 0 }))}>
                <option value="rejected">Rejected material</option>
                <option value="extra_rate">Extra rate (billed over PO)</option>
                <option value="short_supply">Short supply</option>
              </select>
            </div>
            <div>
              <label className="label">Against Vendor PO</label>
              <select className="select" value={dnForm.vendor_po_id} onChange={e => setDnForm(f => ({ ...f, vendor_po_id: e.target.value, loaded: false, items: [], amount: 0 }))}>
                <option value="">Select PO…</option>
                {vendorPos.map(p => <option key={p.id} value={p.id}>{p.po_number} — {p.vendor_name}</option>)}
              </select>
            </div>
          </div>
          <button type="button" onClick={loadDnSource} className="btn btn-secondary text-sm">Load suggested lines from {dnForm.type === 'extra_rate' ? 'Purchase Bill' : 'GRN'}</button>
          {dnForm.loaded && (
            <div className="text-xs bg-blue-50 border border-blue-200 rounded p-2">
              <div className="font-semibold text-blue-800">{dnForm.items.length} line(s) · suggested amount ₹{Math.round(+dnForm.amount || 0).toLocaleString('en-IN')}</div>
              {dnForm.note && <div className="text-gray-600 mt-0.5">{dnForm.note}</div>}
              {dnForm.items.slice(0, 6).map((it, i) => (
                <div key={i} className="text-gray-600 mt-0.5">• {it.description} — {(+it.qty || 0).toLocaleString('en-IN')} {it.unit || ''} × ₹{it.rate != null ? (+it.rate).toLocaleString('en-IN') : '—'} = ₹{Math.round(+it.amount || 0).toLocaleString('en-IN')}</div>
              ))}
              {dnForm.items.length > 6 && <div className="text-gray-400 mt-0.5">…and {dnForm.items.length - 6} more</div>}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Amount (₹)</label>
              <input type="number" step="any" min="0" className="input" value={dnForm.amount} onChange={e => setDnForm(f => ({ ...f, amount: e.target.value }))} />
            </div>
            <div>
              <label className="label">Reason / Note</label>
              <input className="input" value={dnForm.reason} onChange={e => setDnForm(f => ({ ...f, reason: e.target.value }))} placeholder="Shown on the printed note" />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t">
            <button type="button" onClick={() => setDnModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="button" onClick={saveDebitNote} disabled={dnSaving} className="btn btn-primary flex items-center gap-2"><FiCheck /> {dnSaving ? 'Saving…' : 'Save & Print'}</button>
          </div>
        </div>
      </Modal>

      {/* Indent Modal */}
      <Modal isOpen={modal === 'indent'} onClose={() => { setModal(false); setEditingIndentId(null); }} title={editingIndentId ? 'Edit Purchase Indent' : 'Raise Purchase Indent'} wide>
        <form onSubmit={saveIndent} className="space-y-4">
          {/* Auto timestamp — mirrors the 'Dated' field on the physical form */}
          <div className="text-[11px] text-gray-500 bg-gray-50 rounded px-3 py-1.5 flex justify-between items-center">
            <span>Dated: <b className="text-gray-700">{new Date().toLocaleString()}</b></span>
            <span className="text-gray-400">(auto-recorded on create)</span>
          </div>
          {/* Header — Site from Business Book, Raised By from Employees. Stacks on mobile. */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="label flex items-center gap-1">
                Site Name *
                {/* mam (2026-05-25): "beside show an info icon, on hovering
                    over it show a tooltip popup with text of the selected
                    field dropdown content".  Tooltip shows the full long
                    site name + lead number which often gets truncated in
                    the picker button. */}
                <InfoTooltip side="right" text={form.site_name
                  ? `Currently picked: ${form.site_name}.\n\nThe selected site's Client PO BOQ items load below — pick one BOQ row, then pick a sub-item from the Item Master. ${boqItems.length} BOQ item(s) available.`
                  : 'Pick the destination site for this indent. Sites are sourced from Business Book — long company names will be truncated in the dropdown, hover here to see what is currently selected.'} />
              </label>
              <SearchableSelect
                options={sites.map(s => ({ id: s.name, label: `${s.lead_no ? '[' + s.lead_no + '] ' : ''}${s.name}`, ...s }))}
                value={form.site_name || null}
                valueKey="id" displayKey="label"
                placeholder="Search site / company / project name…"
                onChange={(s) => handleSiteChange(s)}
              />
              <p className="text-[10px] text-gray-400 mt-0.5">
                {form.site_name
                  ? (boqLoading ? 'Loading BOQ…' : `${boqItems.length} BOQ item${boqItems.length === 1 ? '' : 's'} available for this site`)
                  : 'Pick a site first — its BOQ items will load below.'}
              </p>
            </div>
            <div>
              <label className="label">Raised By *</label>
              {/* Auto-filled from the logged-in user and locked (mam
                  2026-05-28): "Auto-fill from logged-in user, lock the
                  field". Removes the entire class of "wrong person
                  picked" bugs. The form's initial setForm() seeds
                  raised_by_name to user.name on Raise Indent click, so
                  the field is already correct — we just hide the
                  picker and show the value as a read-only chip. */}
              <div className="input bg-gray-50 text-gray-700 cursor-not-allowed select-none flex items-center justify-between">
                <span className="font-medium">{form.raised_by_name || <em className="text-gray-400">(not signed in)</em>}</span>
                <span className="text-[10px] text-gray-400 italic">auto-filled from your login</span>
              </div>
            </div>
          </div>

          {/* ─── Category selector (mam's spec 2026-05-26) ────────────────
              5 indent flows.  Selection drives whether the items section
              uses the BOQ picker, a free Item Master picker, or the rental
              capture (days × rate/day with the rent-vs-buy block). */}
          <div>
            <label className="label">Category *</label>
            <div className="flex gap-1 flex-wrap">
              {[
                { id: 'material',           label: 'Material',         hint: 'BOQ items (PO + FOC). RGP hidden.' },
                { id: 'rgp',                label: 'RGP',              hint: 'Returnable Gate Pass. No BOQ — pick directly from Item Master where type = RGP.' },
                { id: 'extra_schedule',     label: 'Extra · Schedule', hint: 'BOQ item exists, qty cap removed (over-BOQ).' },
                { id: 'extra_non_schedule', label: 'Extra · Non-Schedule', hint: 'Item outside BOQ — pick free from Item Master (PO + FOC).' },
                { id: 'rental',             label: 'Rental',           hint: 'Rented tool — Days × Rate/Day. Blocks if rental ≥ buying outright.' },
              ].map(c => {
                const active = (form.indent_category || 'material') === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      // Reset items when category changes — different categories
                      // have incompatible row shapes (BOQ vs flat Item Master).
                      setForm(f => ({ ...f, indent_category: c.id }));
                      setIndentItems([{ ...EMPTY_ITEM }]);
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                      active
                        ? 'bg-blue-700 text-white border-blue-700 shadow-sm'
                        : 'bg-white text-gray-700 border-gray-200 hover:border-blue-300 hover:text-blue-700'
                    }`}
                    title={c.hint}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-gray-500 mt-1">
              {(() => {
                const c = form.indent_category || 'material';
                if (c === 'material')           return 'BOQ items where type is PO or FOC. RGP items hidden — pick the RGP category for those.';
                if (c === 'rgp')                return 'RGP (Returnable Gate Pass) — items go to site and come back. No BOQ link; pick directly from Item Master where type = RGP.';
                if (c === 'extra_schedule')     return 'BOQ item exists but the site needs MORE qty than BOQ allows. Qty cap is removed — L1+L2 will see the over-commit.';
                if (c === 'extra_non_schedule') return 'Item is completely outside the BOQ. Pick directly from Item Master (PO + FOC types).';
                if (c === 'rental')             return 'Rented tool. Per row: Days × Rate/Day. Server BLOCKS the indent if rental cost ≥ buying outright cost.';
                return '';
              })()}
            </p>
          </div>

          <h4 className="font-semibold text-sm">
            Items
            <span className="text-gray-400 font-normal ml-1">
              {(() => {
                const c = form.indent_category || 'material';
                if (c === 'extra_non_schedule') return '(direct pick from Item Master — no BOQ)';
                if (c === 'rental')             return '(Item Master + Days × Rate/Day)';
                return '(BOQ item from Client PO → then sub-item from Item Master)';
              })()}
            </span>
          </h4>
          {!form.site_name ? (
            <div className="border-2 border-dashed border-gray-200 rounded-lg p-4 text-center text-sm text-gray-500 bg-gray-50">
              Pick a site above — its BOQ items (from the uploaded Client PO) will load here.
            </div>
          ) : (
            <>
              {/* SUMMARY CHIPS — show BOQ count, sub-items count, Chargeable / FOC / POs expected.
                  Hidden until at least one row has a BOQ picked, otherwise the chips would all be 0. */}
              {(() => {
                const filled = indentItems.filter(it => it.po_item_id);
                if (filled.length === 0) return null;
                const boqCount = new Set(filled.map(it => it.po_item_id)).size;
                let chargeable = 0, foc = 0;
                filled.forEach(it => {
                  const t = String(it.item_type || '').toUpperCase();
                  if (t === 'FOC') foc++;
                  else if (t) chargeable++;
                });
                // POs expected ≈ unique makes among chargeable rows (one supplier = one PO).
                const posExpected = new Set(
                  filled.filter(it => String(it.item_type || '').toUpperCase() !== 'FOC')
                        .map(it => (it.make || '').trim().toLowerCase())
                        .filter(Boolean)
                ).size;
                const Chip = ({ label, value, color }) => (
                  <div className={`rounded-lg border ${color} px-2 py-1.5 text-center`}>
                    <div className="text-lg font-bold leading-none">{value}</div>
                    <div className="text-[10px] font-medium text-gray-600 mt-0.5 leading-tight">{label}</div>
                  </div>
                );
                return (
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    <Chip label="BOQ items" value={boqCount} color="bg-blue-50 border-blue-200" />
                    <Chip label="Total sub-items" value={filled.length} color="bg-gray-50 border-gray-200" />
                    <Chip label="Chargeable" value={chargeable} color="bg-red-50 border-red-200" />
                    <Chip label="FOC" value={foc} color="bg-emerald-50 border-emerald-200" />
                    <Chip label="POs expected" value={posExpected || '—'} color="bg-purple-50 border-purple-200" />
                  </div>
                );
              })()}

              {/* ─── Category-aware items rendering (mam's spec 2026-05-26) ─
                  Material / RGP / Extra-Schedule use the BOQ-grouped UI.
                  Extra-Non-Schedule + Rental use a flat list of Item Master
                  rows (no BOQ link).
                  BOQ picker filter (inside the BOQ-grouped IIFE below):
                    Material + Extra-Schedule → type IN (PO, FOC, '')
                    RGP                       → type = RGP
                    (Non-Schedule + Rental don't show BOQ at all) */}
              {/* ─── FLAT-LIST layout for RGP + Extra-Non-Schedule + Rental ───
                  RGP joined this group (mam 2026-05-27): returnable material
                  is brought to site by the contractor, has no BOQ counterpart
                  on the Client PO, so picked directly from Item Master
                  filtered to type='RGP'. */}
              {(form.indent_category === 'rgp' || form.indent_category === 'extra_non_schedule' || form.indent_category === 'rental') && (() => {
                const cat = form.indent_category;
                const isRental = cat === 'rental';
                const isRgp = cat === 'rgp';
                // Filter Item Master for the picker:
                //   RGP            → only type='RGP'
                //   Non-Schedule   → PO + FOC (RGP / RENTAL excluded — own categories)
                //   Rental         → only type='RENTAL' (mam 2026-05-27, mirrors RGP)
                const filteredMasterItems = isRgp
                  ? masterItems.filter(m => String(m.type || '').toUpperCase() === 'RGP')
                  : isRental
                    ? masterItems.filter(m => String(m.type || '').toUpperCase() === 'RENTAL')
                    : masterItems.filter(m => {
                        const t = String(m.type || '').toUpperCase();
                        return t === 'PO' || t === 'FOC' || t === '';
                      });
                const rowLabel = isRental ? 'Rental' : isRgp ? 'RGP item' : 'Extra item';
                return (
                  <div className="space-y-2">
                    {indentItems.map((item, i) => {
                      const m = item.item_master_id ? masterItems.find(x => +x.id === +item.item_master_id) : null;
                      const masterPrice = +m?.current_price || 0;
                      const qty = +item.quantity || 0;
                      const days = +item.rental_days || 0;
                      const ratePerDay = +item.rental_rate_per_day || 0;
                      const totalRental = qty * days * ratePerDay;
                      const buyCost = qty * masterPrice;
                      const rentalBlocks = isRental && (
                        (!m || masterPrice <= 0)
                          ? false  // separate error message below
                          : (totalRental > 0 && totalRental >= buyCost)
                      );
                      const rentalNoPrice = isRental && m && masterPrice <= 0;
                      return (
                        <div key={i} className={`border rounded-lg p-3 space-y-2 ${rentalBlocks ? 'bg-red-50 border-red-300' : 'bg-white'}`}>
                          <div className="flex justify-between items-center">
                            <div className="text-[11px] font-bold text-gray-500 uppercase">
                              {rowLabel} {i + 1}
                            </div>
                            {indentItems.length > 1 && (
                              <button type="button" onClick={() => setIndentItems(indentItems.filter((_, x) => x !== i))} className="p-1 text-gray-400 hover:text-red-600" title="Remove row">
                                <FiTrash2 size={14} />
                              </button>
                            )}
                          </div>
                          {/* Item Master picker — full width on top */}
                          <div>
                            <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">
                              Item (from Item Master) <span className="text-red-500">*</span>
                            </label>
                            <SearchableSelect
                              options={filteredMasterItems.map(x => ({ id: x.id, label: `[${x.item_code}] ${x.display_name || x.item_name}${x.type ? ' · ' + x.type : ''}${x.current_price > 0 ? ' · ₹' + (+x.current_price).toLocaleString('en-IN') : ''}`, ...x }))}
                              value={item.item_master_id || null} valueKey="id" displayKey="label"
                              placeholder="Search Item Master…"
                              onChange={(picked) => pickMasterItem(i, picked)}
                            />
                            {m && (
                              <div className="text-[10px] text-gray-500 mt-0.5">
                                {m.specification || m.size ? <>{[m.size, m.specification].filter(Boolean).join(' / ')} · </> : ''}
                                Master rate: {masterPrice > 0 ? `₹${masterPrice.toLocaleString('en-IN')}` : <span className="text-red-500 italic">not set</span>}
                                {m.type && <> · Type: <span className="font-semibold">{m.type}</span></>}
                              </div>
                            )}
                          </div>
                          {/* Qty + Unit + Make (common) — plus rental Days + Rate/Day */}
                          <div className={`grid gap-2 ${isRental ? 'grid-cols-2 md:grid-cols-6' : 'grid-cols-2 md:grid-cols-4'}`}>
                            <div>
                              <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Qty *</label>
                              <NumInput className="input text-base font-bold text-right" min="0" value={item.quantity} emitZeroOnEmpty onChange={v => { const n = [...indentItems]; n[i].quantity = v; setIndentItems(n); }} />
                            </div>
                            <div>
                              <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Unit</label>
                              <input className="input text-sm" placeholder="nos" value={item.unit || 'nos'} onChange={e => { const n = [...indentItems]; n[i].unit = e.target.value; setIndentItems(n); }} />
                            </div>
                            {isRental && (
                              <>
                                <div>
                                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Days *</label>
                                  <NumInput className="input text-base font-bold text-right" min="0" value={item.rental_days || 0} emitZeroOnEmpty onChange={v => { const n = [...indentItems]; n[i].rental_days = v; setIndentItems(n); }} />
                                </div>
                                <div>
                                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Rate / Day (₹) *</label>
                                  <NumInput className="input text-base font-bold text-right" min="0" value={item.rental_rate_per_day || 0} emitZeroOnEmpty onChange={v => { const n = [...indentItems]; n[i].rental_rate_per_day = v; setIndentItems(n); }} />
                                </div>
                              </>
                            )}
                            <div>
                              <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Make</label>
                              <input className="input text-sm" placeholder="Make" value={item.make || ''} onChange={e => { const n = [...indentItems]; n[i].make = e.target.value; setIndentItems(n); }} />
                            </div>
                            <div>
                              <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Required by</label>
                              <input className="input text-sm" type="date" value={item.required_date || ''} onChange={e => { const n = [...indentItems]; n[i].required_date = e.target.value; setIndentItems(n); }} />
                            </div>
                          </div>
                          {/* Rental cost summary — live computed, red when block fires */}
                          {isRental && (qty > 0 || days > 0 || ratePerDay > 0) && (
                            <div className={`text-xs rounded p-2 ${
                              rentalBlocks ? 'bg-red-100 text-red-800 border border-red-300'
                              : rentalNoPrice ? 'bg-amber-50 text-amber-800 border border-amber-200'
                              : 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                            }`}>
                              {rentalNoPrice ? (
                                <>⚠️ Item Master rate is 0 — set the master rate first so rental can be validated.</>
                              ) : rentalBlocks ? (
                                <><b>BLOCKED.</b> Rental ₹{Math.round(totalRental).toLocaleString('en-IN')} ≥ buying ₹{Math.round(buyCost).toLocaleString('en-IN')}. Buy instead of renting.</>
                              ) : totalRental > 0 ? (
                                <>Rental cost: <b>₹{Math.round(totalRental).toLocaleString('en-IN')}</b> ({qty} × {days} days × ₹{ratePerDay}/day) vs buying outright ₹{Math.round(buyCost).toLocaleString('en-IN')} — savings ₹{Math.round(buyCost - totalRental).toLocaleString('en-IN')}.</>
                              ) : null}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <button type="button" onClick={() => setIndentItems([...indentItems, { ...EMPTY_ITEM, rental_days: 0, rental_rate_per_day: 0 }])} className="btn btn-secondary text-xs">
                      + Add another {isRental ? 'rental' : isRgp ? 'RGP item' : 'item'}
                    </button>
                  </div>
                );
              })()}

              {/* ─── BOQ-grouped layout for Material / Extra-Schedule ─── */}
              {/* RGP moved to the flat layout (mam 2026-05-27): RGP is
                  returnable material brought to site by the contractor —
                  it has no BOQ counterpart on the Client PO, so user picks
                  directly from Item Master where type='RGP'. Same flow as
                  Non-Schedule / Rental. */}
              {(form.indent_category === 'material' || form.indent_category === 'extra_schedule' || !form.indent_category) && (() => {
                const cat = form.indent_category || 'material';
                // Project division from the selected site's Business Book category —
                // the fallback Sub-Item scope when a BOQ line has no master linkage.
                const projectDiv = DIVISION_OF(sites.find(s => s.name === form.site_name)?.category);
                const filteredBoqItems = boqItems.filter(b => {
                  const t = String(b.item_type || '').toUpperCase();
                  return t === 'PO' || t === 'FOC' || t === '';
                });
                const groups = [];
                const seen = new Map();
                indentItems.forEach((item, idx) => {
                  const key = item.po_item_id || `__empty_${idx}`;
                  if (!seen.has(key)) {
                    seen.set(key, groups.length);
                    groups.push({ boq_id: item.po_item_id || '', sample: item, rows: [] });
                  }
                  groups[seen.get(key)].rows.push({ item, idx });
                });

                return groups.map((group, gi) => {
                  // BOQ-level mode (mam 2026-06-26): a BOQ is in PO mode when it
                  // holds the one chargeable PO sub-item, else it's FOC-only.
                  const boqMode = group.rows.some(r => String(r.item.item_type || '').toUpperCase() === 'PO') ? 'PO' : 'FOC';
                  // Division scoping (mam 2026-06-27): the Sub-Item picker lists only
                  // Item Master items in the SAME division/department as this BOQ line,
                  // so a fire-fighting BOQ doesn't show civil/solar SKUs. A per-BOQ
                  // "show all" toggle overrides it for a genuine cross-division accessory.
                  const boqItemRow = boqItems.find(b => +b.id === +group.boq_id);
                  const boqDiv = DIVISION_OF(boqItemRow?.item_master_id ? masterItems.find(m => +m.id === +boqItemRow.item_master_id)?.department : '');
                  // Scope the Sub-Item picker to the BOQ line's own division, or — when
                  // that line isn't linked to a master item — the project's division.
                  const scopeDiv = boqDiv || projectDiv;
                  const showAllMast = showAllMasters.has(group.boq_id);
                  // Switch the whole BOQ between PO and FOC. FOC → all sub-items
                  // FOC (no PO). PO → make the first sub-item the PO if none yet.
                  const setBoqMode = (mode) => {
                    const ids = new Set(group.rows.map(r => r.idx));
                    const firstIdx = group.rows[0]?.idx;
                    const hasPo = group.rows.some(r => String(r.item.item_type || '').toUpperCase() === 'PO');
                    setIndentItems(prev => prev.map((it, x) => {
                      if (!ids.has(x)) return it;
                      if (mode === 'FOC') return { ...it, item_type: 'FOC' };
                      if (!hasPo) return { ...it, item_type: x === firstIdx ? 'PO' : 'FOC' };
                      return it;
                    }));
                  };
                  return (
                  // overflow-visible (not hidden) so the SearchableSelect's
                  // absolute-positioned options popup can escape this card.
                  // We use rounded-t-lg on the header instead so the top
                  // corners still look clean.
                  <div key={gi} className="border rounded-lg bg-gray-50/40">
                    {/* BOQ HEADER — picker if not yet picked, otherwise read-only summary */}
                    <div className={`${group.boq_id ? 'bg-gradient-to-r from-blue-50 to-blue-100' : 'bg-gray-50'} border-b px-3 py-2.5 rounded-t-lg`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          {group.boq_id ? (
                            <>
                              <div className="text-[10px] font-bold text-blue-700 uppercase">BOQ Item (from Client PO)</div>
                              <div className="text-sm font-semibold text-gray-800 truncate" title={group.sample.description}>
                                {group.sample.description || '(no description)'}
                              </div>
                              {(group.sample.boq_qty || group.sample.remaining_qty != null) ? (
                                <div className="text-[11px] text-gray-600 mt-0.5">
                                  {group.sample.boq_qty ? <>BOQ Qty: <span className="font-semibold">{group.sample.boq_qty}</span></> : null}
                                  {group.sample.remaining_qty != null ? <> · Remaining: <span className="font-semibold">{group.sample.remaining_qty}</span></> : null}
                                  <> · {group.rows.length} sub-item{group.rows.length === 1 ? '' : 's'}</>
                                </div>
                              ) : (
                                <div className="text-[11px] text-gray-500 mt-0.5">{group.rows.length} sub-item{group.rows.length === 1 ? '' : 's'}</div>
                              )}
                              {/* BOQ-level PO / FOC toggle — one choice mandatory
                                  (mam 2026-06-26). PO = chargeable (one PO sub-item
                                  + optional FOC, billed). FOC = free of cost (FOC
                                  sub-items only, no PO, not billed). */}
                              <div className="mt-2 flex items-center gap-1.5">
                                <span className="text-[10px] font-bold text-gray-500 uppercase">Type <span className="text-red-500">*</span></span>
                                <button type="button" onClick={() => setBoqMode('PO')}
                                  className={`text-[10px] font-bold px-2.5 py-0.5 rounded border ${boqMode === 'PO' ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-500 border-gray-300 hover:border-red-300'}`}
                                  title="PO = chargeable: exactly one PO sub-item (+ optional FOC). Billed to the client.">PO</button>
                                <button type="button" onClick={() => setBoqMode('FOC')}
                                  className={`text-[10px] font-bold px-2.5 py-0.5 rounded border ${boqMode === 'FOC' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-gray-500 border-gray-300 hover:border-emerald-300'}`}
                                  title="FOC = free of cost: FOC sub-items only, no PO. Not billed to the client.">FOC</button>
                                <span className="text-[10px] text-gray-400 italic">{boqMode === 'FOC' ? 'free — not billed' : 'one PO + optional FOC'}</span>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="text-[10px] font-bold text-gray-500 uppercase mb-1">BOQ Item — pick first <span className="text-red-500">*</span></div>
                              <SearchableSelect
                                options={filteredBoqItems.map(b => ({
                                  id: b.id,
                                  label: `${b.description || '(no desc)'}${b.boq_qty ? ' · Qty ' + b.boq_qty : ''}${b.item_type ? ' · ' + b.item_type : ''}`,
                                  ...b,
                                }))}
                                value={null} valueKey="id" displayKey="label"
                                placeholder={
                                  filteredBoqItems.length
                                    ? (cat === 'rgp'
                                        ? 'Search BOQ item (any) — RGP filter is on the Sub-Item below…'
                                        : 'Search BOQ item (PO + FOC items)…')
                                    : (cat === 'rgp'
                                        ? 'No BOQ items for this site'
                                        : 'No PO/FOC BOQ items for this site')
                                }
                                onChange={(b) => pickBoqItem(group.rows[0].idx, b)}
                              />
                            </>
                          )}
                        </div>
                        {/* Remove the whole BOQ section (and all its sub-items) — only when more than one group exists. */}
                        {groups.length > 1 && (
                          <button
                            type="button"
                            onClick={() => {
                              const idxToRemove = new Set(group.rows.map(r => r.idx));
                              setIndentItems(indentItems.filter((_, x) => !idxToRemove.has(x)));
                            }}
                            className="p-1 text-gray-400 hover:text-red-600 flex-shrink-0"
                            title="Remove this BOQ section"
                          >
                            <FiTrash2 size={16} />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* SUB-ITEMS LIST — shown only when a BOQ is picked. Each row picks an Item Master sub-item. */}
                    {group.boq_id && (
                      <div className="p-2 space-y-2">
                        {/* Desktop column headers — InfoTooltip on Sub-Item
                            explains what's required + warns about dept-mismatch
                            (mam 2026-05-25: "INFO BUTTON SHOW ON ITEM NAME ALSO"). */}
                        {/* Required-by column removed (mam 2026-05-28: "in
                            material required by date not need remove here so
                            can item width big"). The 3 cols it occupied are
                            given to Sub-Item so the picker doesn't truncate
                            to "[FF2635] MS P…". required_date stays in the
                            data model — flat-layout categories (RGP / Rental
                            / Non-Schedule) still expose it, and the Vendor
                            PO print handles null gracefully. */}
                        <div className="hidden md:grid gap-2 text-[10px] font-bold text-gray-500 uppercase px-1" style={{ gridTemplateColumns: 'repeat(15, minmax(0, 1fr)) auto' }}>
                          <div className="col-span-7 flex items-center gap-1">
                            Sub-Item (Item Master) <span className="text-red-500">*</span>
                            <InfoTooltip text={`Pick from Item Master.  Each BOQ section locks to ONE sub-item — if you need more components under the same BOQ, click "+ Add another BOQ item" and pick this BOQ again.\n\nWarning: if the picked sub-item's department differs from the BOQ's category, you'll see a yellow toast — common cause of bad indents (e.g. picking a 12-way DB under a CPVC pipes BOQ).`} />
                          </div>
                          <div className="col-span-2">Make</div>
                          <div className="col-span-2">Type</div>
                          <div className="col-span-2">Qty</div>
                          <div className="col-span-2">Unit</div>
                          <div></div>
                        </div>

                        {/* Division scope notice + Show-all toggle (mam 2026-06-27) */}
                        {scopeDiv && (
                          <div className="px-1 -mt-1 text-[10px] text-gray-500 flex items-center gap-1.5 flex-wrap">
                            <span>🔎 {showAllMast ? <>Showing <b>all divisions</b></> : <>Sub-items limited to <b className="text-blue-700">{scopeDiv}</b> {boqDiv ? "(this BOQ's division)" : '(project division)'}</>}</span>
                            <button type="button"
                              onClick={() => setShowAllMasters(prev => { const n = new Set(prev); if (n.has(group.boq_id)) n.delete(group.boq_id); else n.add(group.boq_id); return n; })}
                              className="text-blue-600 hover:underline font-medium">{showAllMast ? `filter to ${scopeDiv}` : 'show all divisions'}</button>
                          </div>
                        )}

                        {group.rows.map(({ item, idx: i }, subIdx) => {
                          const t = String(item.item_type || '').toUpperCase();
                          const typeClass = t === 'FOC' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : t === 'RGP' ? 'bg-amber-50 text-amber-700 border-amber-200'
                            : t === 'PO' ? 'bg-red-50 text-red-700 border-red-200'
                            : 'bg-gray-50 text-gray-500 border-gray-200';
                          // pickedMaster = the full Item Master row currently selected
                          // for this indent line.  Used to build a rich details
                          // tooltip next to the picker (mam 2026-05-25: "hose drop
                          // down button show tooltip button to show all data").
                          const pickedMaster = item.item_master_id
                            ? masterItems.find(m => +m.id === +item.item_master_id)
                            : null;
                          const masterDetailsText = pickedMaster ? [
                            `Code: [${pickedMaster.item_code || '—'}]`,
                            `Name: ${pickedMaster.item_name || '—'}`,
                            pickedMaster.specification && `Spec: ${pickedMaster.specification}`,
                            pickedMaster.size && `Size: ${pickedMaster.size}`,
                            `UOM: ${pickedMaster.uom || '—'}`,
                            `Type: ${pickedMaster.type || '—'}`,
                            pickedMaster.make && `Make: ${pickedMaster.make}`,
                            pickedMaster.department && `Dept: ${pickedMaster.department}`,
                            pickedMaster.current_price > 0 && `Master Rate: ₹${(+pickedMaster.current_price).toLocaleString('en-IN')}`,
                            `GST: ${pickedMaster.gst || '—'}`,
                          ].filter(Boolean).join('\n') : 'Pick a sub-item first to see its full details.';
                          // Sub-Item filter by category (mam 2026-05-26):
                          //   Material + Extra-Schedule → PO + FOC only (RGP has its own flow)
                          //   RGP                       → RGP only
                          //   (Non-Schedule + Rental use the flat-list layout above, not here)
                          const filteredMasterForBoq = cat === 'rgp'
                            ? masterItems.filter(m => String(m.type || '').toUpperCase() === 'RGP')
                            : masterItems.filter(m => {
                                const t = String(m.type || '').toUpperCase();
                                return t === 'PO' || t === 'FOC' || t === '';
                              });
                          // Division scope: only items in the same division as the BOQ line
                          // (or, if that line is unmapped, the project's division), unless
                          // "show all" is on. DIVISION_OF normalises messy dept codes.
                          const deptScoped = (scopeDiv && !showAllMast)
                            ? filteredMasterForBoq.filter(m => DIVISION_OF(m.department) === scopeDiv)
                            : filteredMasterForBoq;
                          const masterPicker = (
                            <div className="flex items-center gap-1 w-full">
                              <div className="flex-1 min-w-0">
                                <SearchableSelect
                                  options={deptScoped.map(m => ({ id: m.id, label: `[${m.item_code}] ${m.display_name || m.item_name}${m.type ? ' · ' + m.type : ''}`, ...m }))}
                                  value={item.item_master_id || null} valueKey="id" displayKey="label"
                                  placeholder={cat === 'rgp' ? 'Search RGP sub-item…' : 'Search sub-item from Item Master…'}
                                  onChange={(m) => pickMasterItem(i, m)}
                                />
                              </div>
                              {/* (i) info button beside the dropdown — shows
                                  ALL fields of the picked master item on
                                  hover (mam 2026-05-25). Side=right so it
                                  doesn't clip near the top of the modal. */}
                              <InfoTooltip side="right" text={masterDetailsText} />
                            </div>
                          );
                          const makeInput = <input className="input text-sm" placeholder="Make" value={item.make || ''} title={item.make || ''} onChange={e => { const n = [...indentItems]; n[i].make = e.target.value; setIndentItems(n); }} />;
                          // Qty input — uses NumInput so backspace/Ctrl+A
                          // doesn't snap the field back to 0 (mam 2026-05-25).
                          // emitZeroOnEmpty keeps the same number contract
                          // for downstream code that expects a numeric quantity.
                          const qtyInput = <NumInput className="input text-base font-bold text-right" min="0" placeholder="Qty" value={item.quantity} emitZeroOnEmpty onChange={v => { const n = [...indentItems]; n[i].quantity = v; setIndentItems(n); }} />;
                          // (Required-by date removed from BOQ-grouped layout
                          // mam 2026-05-28 — see header note above.)
                          // Unit dropdown — UNIT_OPTIONS covers the common cases.
                          // If the BOQ / Item Master has pre-filled a unit that
                          // isn't in the list (e.g. 'metres'), keep it as an
                          // option so it stays selected; otherwise mam can pick
                          // any standard unit without typing.
                          const curUnit = (item.unit || '').toString().trim();
                          const unitOpts = curUnit && !UNIT_OPTIONS.some(u => u.toLowerCase() === curUnit.toLowerCase())
                            ? [curUnit, ...UNIT_OPTIONS]
                            : UNIT_OPTIONS;
                          const unitInput = (
                            <select className="select text-sm" value={curUnit || 'nos'} onChange={e => { const n = [...indentItems]; n[i].unit = e.target.value; setIndentItems(n); }}>
                              {unitOpts.map(u => <option key={u} value={u}>{u}</option>)}
                            </select>
                          );
                          // Type box. For Material / Extra-Schedule the user
                          // CHOOSES PO or FOC per sub-item (mam 2026-06-25:
                          // "boq → under, give option PO or FOC … if FOC then
                          // no need to enter PO"). PO = procured (goes to a
                          // Vendor PO); FOC = free of cost — excluded from the
                          // PO downstream, so nothing to enter. Defaults to the
                          // Item Master type, else PO. RGP keeps its fixed type.
                          const typeBox = cat === 'rgp' ? (
                            <div className={`text-center text-[11px] font-bold uppercase px-2 py-1.5 rounded-lg border ${typeClass}`} title="RGP returnable item">
                              {item.item_type || 'RGP'}
                            </div>
                          ) : (
                            // In FOC mode the whole BOQ is FOC — lock the row to
                            // FOC (use the header toggle to switch back to PO).
                            <select
                              className={`select text-[11px] font-bold uppercase py-1.5 text-center border ${typeClass} ${boqMode === 'FOC' ? 'opacity-70 cursor-not-allowed' : ''}`}
                              value={t === 'FOC' ? 'FOC' : 'PO'}
                              disabled={boqMode === 'FOC'}
                              onChange={e => { const n = [...indentItems]; n[i].item_type = e.target.value; setIndentItems(n); }}
                              title={boqMode === 'FOC' ? 'FOC-only BOQ — switch the BOQ Type toggle to PO to change this.' : 'PO = procured, needs a Vendor PO.  FOC = free of cost — no PO needed.'}>
                              <option value="PO">PO</option>
                              <option value="FOC">FOC</option>
                            </select>
                          );
                          // Per-sub-item remove only meaningful when there's more than 1 sub-item in this BOQ;
                          // to remove the LAST sub-item, the user removes the entire BOQ section via the header trash.
                          const removeBtn = group.rows.length > 1 ? (
                            <button type="button" onClick={() => setIndentItems(indentItems.filter((_, x) => x !== i))} className="p-1 text-gray-300 hover:text-red-600" title="Remove sub-item">
                              <FiTrash2 size={14} />
                            </button>
                          ) : <div className="w-5" />;

                          return (
                            <div key={i}>
                              {/* MOBILE — stacked card */}
                              <div className="md:hidden border rounded-lg p-2.5 bg-white space-y-2 relative">
                                <div className="flex justify-between items-center">
                                  <span className="text-[10px] font-bold text-gray-400 uppercase">Sub-item {subIdx + 1}</span>
                                  {removeBtn}
                                </div>
                                <div>
                                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5 flex items-center gap-1">
                                    Sub-Item <span className="text-gray-400 font-normal normal-case">(Item Master)</span>
                                    <InfoTooltip text="One sub-item per BOQ section. Mismatched-department picks trigger a warning toast." />
                                  </label>
                                  {masterPicker}
                                </div>
                                <div className="grid grid-cols-4 gap-2">
                                  <div className="col-span-2"><label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Qty</label>{qtyInput}</div>
                                  <div><label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Unit</label>{unitInput}</div>
                                  <div><label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Type</label>{typeBox}</div>
                                </div>
                                <div>
                                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Make</label>
                                  {makeInput}
                                </div>
                              </div>

                              {/* DESKTOP — single row (no Required by; see
                                  header comment above for context) */}
                              <div className="hidden md:block">
                                <div className="grid gap-2 items-center bg-white border rounded-lg p-2" style={{ gridTemplateColumns: 'repeat(15, minmax(0, 1fr)) auto' }}>
                                  <div className="col-span-7">{masterPicker}</div>
                                  <div className="col-span-2">{makeInput}</div>
                                  <div className="col-span-2">{typeBox}</div>
                                  <div className="col-span-2">{qtyInput}</div>
                                  <div className="col-span-2">{unitInput}</div>
                                  {removeBtn}
                                </div>
                              </div>
                            </div>
                          );
                        })}

                        {/* "+ Add FOC / RGP sub-item" — restored on mam's
                            follow-up (2026-05-25: "unable to fill foc or
                            rgp"). PO-type sub-items are still capped at
                            ONE per BOQ (the old IND-0075 mis-categorisation
                            concern), but FOC + RGP can stack freely under
                            the same BOQ — those are free-of-cost / returnable
                            items that legitimately accompany a chargeable
                            PO item (e.g. PO Pipe + FOC Pipe Clamp + RGP
                            Cutting Tool all under one CPVC BOQ).

                            Server enforces the "1 PO per BOQ" rule too,
                            so even direct API calls can't break it. */}
                        {(() => {
                          // Has this BOQ section already used a PO line?
                          // If yes, we lock the FOC-only add button. RGP is
                          // EXCLUDED here in Material / Extra-Schedule flows
                          // because RGP has its own category (mam 2026-05-26).
                          const hasPoLineInGroup = group.rows.some(r =>
                            String(r.item.item_type || '').toUpperCase() === 'PO'
                          );
                          const isRgpCat = cat === 'rgp';
                          // What label + default sub-type goes on the new row?
                          //   RGP category: more RGP sub-items allowed under the same BOQ
                          //   PO mode: the one PO slot is the chargeable line, extra rows are FOC
                          //   FOC mode (mam 2026-06-26): every sub-item is FOC (no PO)
                          const addLabel = isRgpCat
                            ? '+ Add RGP sub-item to this BOQ'
                            : (boqMode === 'FOC' ? '+ Add FOC sub-item to this BOQ' : `+ Add ${hasPoLineInGroup ? 'FOC' : ''} sub-item to this BOQ`);
                          const lockHint = isRgpCat
                            ? null
                            : (boqMode === 'FOC' ? 'FOC-only BOQ — free of cost, not billed to the client'
                               : (hasPoLineInGroup ? '(PO slot used — only FOC can be added here)' : null));
                          const defaultType = isRgpCat ? 'RGP' : (boqMode === 'FOC' ? 'FOC' : (hasPoLineInGroup ? 'FOC' : 'PO'));
                          // With the BOQ-level toggle a PO/FOC choice is always
                          // set, so the old "missing PO" chip no longer applies.
                          const missingPo = false;
                          return (
                            <div className="flex items-center gap-2 flex-wrap">
                              <button
                                type="button"
                                onClick={() => setIndentItems([...indentItems, {
                                  ...EMPTY_ITEM,
                                  po_item_id: group.boq_id,
                                  description: group.sample.description,
                                  boq_qty: group.sample.boq_qty,
                                  remaining_qty: group.sample.remaining_qty,
                                  unit: group.sample.unit || 'nos',
                                  item_type: defaultType,
                                }])}
                                className="text-[11px] text-blue-600 hover:text-blue-800 font-medium px-1 py-1"
                              >{addLabel}</button>
                              {missingPo && (
                                <span className="text-[10px] font-semibold text-red-700 bg-red-50 border border-red-200 rounded px-1.5 py-0.5"
                                      title="Every BOQ needs exactly ONE PO (chargeable) sub-item. FOC/RGP cannot stand alone.">
                                  ⚠ PO sub-item required
                                </span>
                              )}
                              {lockHint && (
                                <span className="text-[10px] text-gray-400 italic">{lockHint}</span>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                  );
                });
              })()}

              {(form.indent_category === 'material' || form.indent_category === 'rgp' || form.indent_category === 'extra_schedule' || !form.indent_category) && (
                <button type="button" onClick={() => setIndentItems([...indentItems, { ...EMPTY_ITEM }])} className="btn btn-secondary text-xs">+ Add another BOQ item</button>
              )}
            </>
          )}
          <div><label className="label">Notes</label><textarea className="input" rows="2" value={form.notes || ''} onChange={e => setForm({...form, notes: e.target.value})} placeholder="Any remarks for Purchase…" /></div>
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3">
            <button type="button" onClick={() => { setModal(false); setEditingIndentId(null); }} className="btn btn-secondary w-full sm:w-auto">Cancel</button>
            <button type="submit" className="btn btn-primary w-full sm:w-auto">{editingIndentId ? 'Save Changes' : 'Submit Indent'}</button>
          </div>
        </form>
      </Modal>

      {/* Vendor PO Modal — PO is created INSIDE the Sotyn.Headmasters. PO number is
          auto-generated (VPO/YYYY/####) on save. File upload is optional
          (e.g. if mam later wants to attach a signed scan). */}
      <Modal isOpen={modal === 'vendorpo'} onClose={() => setModal(false)} title="Create Vendor PO" wide>
        <form onSubmit={saveVendorPo} className="space-y-4">
          <p className="text-[11px] text-gray-500 bg-blue-50 border border-blue-100 rounded px-3 py-2">
            Fill the details below — the PO number will be auto-generated as <b>VPO/{new Date().getFullYear()}/####</b> on save. Link to an indent so the "Pending for PO" list clears.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">PO Number <span className="text-gray-400 font-normal">(auto-generated)</span></label>
              <input
                className="input bg-gray-50 text-gray-700 cursor-not-allowed"
                placeholder={`VPO/${new Date().getFullYear()}/####`}
                value={`Auto-generated when you click "Create Vendor PO"`}
                readOnly
                title="PO numbers are issued by the system in VPO/YYYY/#### format — no manual entry needed."
              />
              <p className="text-[10px] text-gray-400 mt-0.5">Format: VPO/{new Date().getFullYear()}/0001 — assigned automatically on save.</p>
            </div>
            <div>
              <label className="label">PO Date *</label>
              <input className="input" type="date" value={form.po_date || ''} onChange={e => setForm({...form, po_date: e.target.value})} required />
            </div>
            {/* Link to Indent now sits directly after PO Date — picking an indent
                here pre-fills the Vendor and pulls the indent's items into the
                line-item picker below. mam wanted this prominent so the PO is
                anchored to a specific indent up-front. */}
            <div className="sm:col-span-2">
              <label className="label">Link to Indent <span className="text-gray-400 font-normal">(optional)</span></label>
              <select className="select" value={form.indent_id || ''} onChange={e => pickIndentForPo(e.target.value)}>
                <option value="">— No indent link —</option>
                {indents.map(i => <option key={i.id} value={i.id}>{i.indent_number} — {i.site_name}</option>)}
              </select>
              <p className="text-[10px] text-gray-400 mt-0.5">Picking an indent auto-fills the vendor + loads its items below for selection.</p>
            </div>
            <div>
              <label className="label">Vendor *</label>
              <select className="select" value={form.vendor_id || ''} onChange={e => setForm({...form, vendor_id: +e.target.value})} required>
                <option value="">Select vendor</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <p className="text-[10px] text-gray-400 mt-0.5">Auto-picked from finalized rates if all items agree.</p>
            </div>
            <div>
              <label className="label">PO Total Amount <span className="text-gray-400 font-normal">(auto-computed from items)</span></label>
              <input className="input" type="number" step="0.01" min="0" placeholder="0" value={form.total_amount || ''} onChange={e => setForm({...form, total_amount: e.target.value})} />
              <p className="text-[10px] text-gray-400 mt-0.5">Leave blank to use SUM(qty × rate) of the linked indent items.</p>
            </div>
            <div>
              <label className="label">Expected Receipt Date <span className="text-gray-400 font-normal">(when goods are due from vendor)</span></label>
              <input className="input" type="date" value={form.expected_receipt_date || ''} onChange={e => setForm({...form, expected_receipt_date: e.target.value})} />
              <p className="text-[10px] text-gray-400 mt-0.5">Used to chase vendor follow-ups and trigger the Purchase Bill upload.</p>
            </div>
            <div className="sm:col-span-2">
              <label className="label">Remarks <span className="text-gray-400 font-normal">(optional)</span></label>
              <input className="input" placeholder="Any note about this PO" value={form.remarks || ''} onChange={e => setForm({...form, remarks: e.target.value})} />
            </div>
            {/* Freight terms + charge (mam 2026-06-12) — printed on the PDF PO.
                Ex-Works = buyer arranges freight; FOR = vendor delivers to site.
                Freight amount is added to the PO total. */}
            <div>
              <label className="label">Freight Terms <span className="text-gray-400 font-normal">(optional)</span></label>
              <select className="select" value={form.freight_terms || ''} onChange={e => setForm({...form, freight_terms: e.target.value})}>
                <option value="">— None —</option>
                <option value="Ex-Works">Ex-Works (buyer arranges freight)</option>
                <option value="FOR">FOR (vendor delivers to site)</option>
              </select>
            </div>
            <div>
              <label className="label">Freight Amount (₹) <span className="text-gray-400 font-normal">(optional)</span></label>
              <input className="input text-right" type="number" step="0.01" min="0" placeholder="0" value={form.freight_amount || ''} onChange={e => setForm({...form, freight_amount: e.target.value})} />
              <p className="text-[10px] text-gray-400 mt-0.5">Added to the PO total &amp; shown on the PDF.</p>
            </div>
          </div>

          {/* Optional item linking — when an indent is picked, the uploader
              can tick which indent lines the Tally PO covers so the "Pending
              for PO" list clears. Terms / credit days aren't collected here
              because they live on the uploaded Tally PO itself. */}
          {form.indent_id && (
            <div className="border rounded-lg overflow-hidden">
              <div className="bg-gray-50 px-3 py-2 border-b text-xs font-semibold text-gray-600 uppercase flex items-center justify-between">
                <span>Items from this Indent <span className="text-[10px] text-gray-400 normal-case">(optional)</span></span>
                <span className="text-[10px] text-gray-500 normal-case">Tick items covered by this Tally PO</span>
              </div>
              {indentItemsForPo.length === 0 ? (
                <div className="p-4 text-center text-sm text-gray-400">Loading items…</div>
              ) : (
                <div className="overflow-x-auto max-h-[360px]">
                  <table className="text-xs">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="px-2 py-1.5"></th>
                        <th className="px-2 py-1.5 text-left">Item</th>
                        <th className="px-2 py-1.5">Qty</th>
                        <th className="px-2 py-1.5">Unit</th>
                        <th className="px-2 py-1.5">Rate</th>
                        <th className="px-2 py-1.5">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {indentItemsForPo.map(it => {
                        const s = poItemSelection[it.indent_item_id] || {};
                        // Pending = approved − already on (non-cancelled) POs.
                        // Disable only when FULLY ordered, so a partly-ordered
                        // line can still PO its pending qty (mam 2026-06-23).
                        const orderedQty = +it.ordered_qty || 0;
                        const pending = Math.max(0, (+it.quantity || 0) - orderedQty);
                        const fullyOrdered = pending <= 0;
                        const wpm = +it.weight_per_meter || 0;
                        const isPipe = wpm > 0;
                        const kg = isPipe ? Math.round((+s.quantity || 0) * wpm * 100) / 100 : 0;
                        const amount = (s.checked ? (isPipe ? kg : (+s.quantity || 0)) * (+s.rate || 0) : 0);
                        const unit = it.unit || it.uom || '';
                        return (
                          <tr key={it.indent_item_id} className={`border-b ${fullyOrdered ? 'bg-gray-100 text-gray-400' : (s.checked ? 'bg-red-50/40' : '')}`}>
                            <td className="px-2 py-1.5 text-center">
                              <input type="checkbox" disabled={fullyOrdered} checked={!!s.checked} onChange={e => togglePoItem(it.indent_item_id, { checked: e.target.checked })} />
                            </td>
                            <td className="px-2 py-1.5 max-w-[320px]">
                              {it.item_code && <div className="text-[10px] font-mono text-gray-500">[{it.item_code}]</div>}
                              <div className="whitespace-normal leading-snug font-medium">{[it.master_name || it.description, it.specification, it.size].filter(Boolean).join(' / ')}</div>
                              {it.make && <div className="text-[10px] text-gray-400">Make: {it.make}</div>}
                              {isPipe && <div className="text-[10px] text-blue-700 font-semibold">🪈 Pipe · {wpm} kg/pipe — PO in KG</div>}
                              {orderedQty > 0 && (
                                <div className={`text-[10px] font-semibold ${fullyOrdered ? 'text-gray-500 italic' : 'text-amber-600'}`}>
                                  {fullyOrdered ? `Fully ordered (${orderedQty} of ${it.quantity})` : `Ordered ${orderedQty} of ${it.quantity} · pending ${pending}`}
                                </div>
                              )}
                            </td>
                            <td className="px-1 py-1">
                              <NumInput className="input text-[11px] px-1 py-0.5 w-16 text-right" min="0" emitZeroOnEmpty disabled={fullyOrdered} value={s.quantity ?? pending ?? 0} onChange={v => togglePoItem(it.indent_item_id, { quantity: v })} />
                              {isPipe && <div className="text-[10px] text-blue-700 text-right mt-0.5">= {kg.toLocaleString('en-IN')} kg</div>}
                            </td>
                            <td className="px-2 py-1.5 text-center text-gray-600">{isPipe ? <span className="text-blue-700 font-semibold">MTR → KG</span> : (unit || <span className="text-gray-300">—</span>)}</td>
                            <td className="px-1 py-1">
                              <NumInput className="input text-[11px] px-1 py-0.5 w-20 text-right" min="0" emitZeroOnEmpty disabled={fullyOrdered} value={s.rate ?? 0} onChange={v => togglePoItem(it.indent_item_id, { rate: v })} />
                            </td>
                            <td className="px-2 py-1.5 text-right font-semibold">{amount ? `Rs ${amount.toLocaleString()}` : <span className="text-gray-300">—</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="bg-gray-50">
                      {+form.freight_amount > 0 && (
                        <tr><td colSpan="5" className="px-2 py-1 text-right text-gray-600">Freight{form.freight_terms ? ` (${form.freight_terms})` : ''}:</td>
                            <td className="px-2 py-1 text-right text-gray-700">Rs {(+form.freight_amount).toLocaleString()}</td></tr>
                      )}
                      <tr><td colSpan="5" className="px-2 py-2 text-right font-bold">PO Total:</td>
                          <td className="px-2 py-2 text-right font-bold text-red-700">Rs {(poTotal + (+form.freight_amount || 0)).toLocaleString()}</td></tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ─── Payment before material (INTERNAL — mam 2026-05-27) ─────
              Captures vendor's payment expectation for THIS PO. Never printed
              on the vendor PO; the purchase team uses the chip on the list
              to know if material is unblocked. Three real-world cases:
                • No advance  — vendor ships on credit (default)
                • Advance     — vendor wants ₹X before shipping
                • Old payment — vendor blocks until old dues clear
          */}
          <div className="border border-amber-200 bg-amber-50/40 rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase font-bold tracking-wide text-amber-700">⚠ Internal — not printed on vendor PO</span>
            </div>
            <div className="text-xs font-semibold text-gray-700">Payment before material</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
              {[
                { id: 'no_advance',        label: 'No advance',          hint: 'Vendor ships on credit (default)' },
                { id: 'advance',           label: 'Advance required',    hint: 'Vendor wants ₹X before shipping' },
                { id: 'old_payment_clear', label: 'Old payment hold',    hint: 'Old dues must clear before shipment' },
              ].map(opt => {
                const active = (form.payment_block_type || '') === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, payment_block_type: opt.id, payment_block_amount: opt.id === 'no_advance' ? '' : f.payment_block_amount }))}
                    className={`text-left rounded-lg border px-3 py-2 transition ${active ? 'bg-amber-600 text-white border-amber-700 shadow' : 'bg-white text-gray-700 border-gray-200 hover:border-amber-400'}`}
                  >
                    <div className="font-semibold text-[12px]">{opt.label}</div>
                    <div className={`text-[10px] ${active ? 'text-white/90' : 'text-gray-500'}`}>{opt.hint}</div>
                  </button>
                );
              })}
            </div>
            {(form.payment_block_type === 'advance' || form.payment_block_type === 'old_payment_clear') && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
                <div>
                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">
                    {form.payment_block_type === 'advance' ? 'Advance amount (₹)' : 'Old dues amount (₹)'} <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="number" min="1" step="0.01"
                    className="input text-xs"
                    placeholder="e.g. 50000"
                    value={form.payment_block_amount || ''}
                    onChange={e => setForm(f => ({ ...f, payment_block_amount: e.target.value }))}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Internal notes (optional)</label>
                  <input
                    type="text"
                    className="input text-xs"
                    placeholder='e.g. "Last 3 bills overdue 45 days" or "50% advance, balance on delivery"'
                    value={form.payment_block_notes || ''}
                    onChange={e => setForm(f => ({ ...f, payment_block_notes: e.target.value }))}
                    maxLength={500}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Create Vendor PO</button>
          </div>
        </form>
      </Modal>

      {/* Purchase Bill Modal */}
      <Modal isOpen={modal === 'bill'} onClose={() => setModal(false)} title={form.vendor_po_number ? `Upload Bill for ${form.vendor_po_number}` : 'Add Purchase Bill'}>
        <form onSubmit={savePurchaseBill} className="space-y-4">
          {form.vendor_po_number && (
            <div className="bg-emerald-50 border border-emerald-200 rounded px-3 py-2 text-xs text-emerald-700">
              Linked to Vendor PO <b>{form.vendor_po_number}</b>. The bill will automatically clear this PO from the follow-up list.
            </div>
          )}
          {/* PO qty vs received qty per item (mam 2026-06-04): spot a short
              before saving the bill.  Short lines are flagged + a banner. */}
          {form.vendor_po_id && billItems && billItems.items?.length > 0 && (() => {
            // Editable received: default to PO qty (seeded in billRecv).
            const recvQty = (it) => { const v = billRecv[it.vpi_id]; return v == null ? it.ordered_qty : +v; };
            const shortOf = (it) => Math.max(0, (+it.ordered_qty || 0) - recvQty(it));
            const shortLines = billItems.items.filter(it => shortOf(it) > 0);
            const recvAmount = Math.round(billItems.items.reduce((s, it) => s + (recvQty(it) * (+it.rate || 0)), 0) * 100) / 100;
            const onRecvChange = (vpiId, v) => {
              const nr = { ...billRecv, [vpiId]: v };
              setBillRecv(nr);
              const amt = Math.round(billItems.items.reduce((s, it) => s + ((nr[it.vpi_id] == null ? +it.ordered_qty : +nr[it.vpi_id]) * (+it.rate || 0)), 0) * 100) / 100;
              setForm(f => ({ ...f, amount: amt, total_amount: amt + (+f.gst_amount || 0) }));
            };
            return (
              <div className="border rounded-lg overflow-hidden">
                <div className="bg-gray-50 px-3 py-1.5 border-b text-[11px] font-semibold text-gray-600 uppercase flex items-center justify-between">
                  <span>PO vs Received <span className="text-[10px] text-gray-400 normal-case">(received is editable — defaults to PO qty)</span></span>
                  {!billItems.any_receipt && <span className="text-[10px] text-amber-600 normal-case">No receipt recorded — edit received below</span>}
                </div>
                <div className="overflow-x-auto max-h-52">
                  <table className="text-[11px] w-full">
                    <thead className="bg-gray-50 sticky top-0"><tr>
                      <th className="px-2 py-1 text-left">Item</th>
                      <th className="px-2 py-1 text-right">PO Qty</th>
                      <th className="px-2 py-1 text-right">Received</th>
                      <th className="px-2 py-1 text-right">Short</th>
                      <th className="px-2 py-1 text-right">Rate</th>
                    </tr></thead>
                    <tbody>
                      {billItems.items.map(it => {
                        const short = shortOf(it);
                        const isShort = short > 0;
                        return (
                          <tr key={it.vpi_id} className={`border-t ${isShort ? 'bg-amber-50' : ''}`}>
                            <td className="px-2 py-1">{it.description}{it.item_type ? <span className="ml-1 text-[9px] text-gray-400">[{it.item_type}]</span> : null}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{(+it.ordered_qty || 0).toLocaleString('en-IN')} {it.unit}</td>
                            <td className="px-2 py-1 text-right">
                              <NumInput step="any" min="0" value={recvQty(it)}
                                onChange={(v) => onRecvChange(it.vpi_id, v)}
                                className="border border-gray-300 rounded px-1 py-0.5 w-16 text-right text-[11px] focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500" />
                            </td>
                            <td className={`px-2 py-1 text-right tabular-nums font-semibold ${isShort ? 'text-amber-700' : 'text-gray-300'}`}>{isShort ? short.toLocaleString('en-IN') : '0'}</td>
                            <td className="px-2 py-1 text-right tabular-nums">₹{(+it.rate || 0).toLocaleString('en-IN')}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {shortLines.length > 0 && (
                  <div className="bg-amber-50 border-t border-amber-200 px-3 py-1.5 text-[11px] text-amber-800">
                    ⚠ <b>{shortLines.length}</b> item{shortLines.length === 1 ? '' : 's'} short (received less than ordered). A short-supply debit may apply.
                  </div>
                )}
                <div className="bg-blue-50 border-t border-blue-100 px-3 py-1 text-[10px] text-blue-700">
                  Amount from received qty: ₹{recvAmount.toLocaleString('en-IN')} — pre-filled below. Edit the Received qty above to adjust, or override the amount directly.
                </div>
              </div>
            );
          })()}
          {/* Empty / loading states so the modal never looks "broken" when a
              PO has no itemised lines (older POs created without item links). */}
          {form.vendor_po_id && !billItems && (
            <div className="text-[11px] text-gray-400 italic px-1">Loading PO items…</div>
          )}
          {form.vendor_po_id && billItems && (billItems.items?.length || 0) === 0 && (
            <div className="text-[11px] text-gray-500 border border-dashed rounded px-3 py-2 bg-gray-50">
              This PO has no itemised lines linked from the indent, so there's no PO-qty vs received check to show. Enter the bill amount manually.
            </div>
          )}
          <div>
            <label className="label">Vendor *</label>
            <SearchableSelect
              options={vendorOptions}
              value={form.vendor_id || null}
              valueKey="id" displayKey="label"
              placeholder="Search vendor…"
              onChange={(v) => setForm({ ...form, vendor_id: v?.id || '' })}
            />
          </div>
          {/* Material Status (mam 2026-06-04): Approved (default) accepts the
              material; Reject auto-raises a rejected-material debit note. */}
          <div>
            <label className="label">Material Status</label>
            <select className={`select ${form.material_status === 'reject' ? 'border-red-400 text-red-700 font-semibold' : ''}`} value={form.material_status || 'approved'} onChange={e => setForm({ ...form, material_status: e.target.value })}>
              <option value="approved">Approved — accept material</option>
              <option value="reject">Reject — auto-raise a rejected-material debit note</option>
            </select>
            {form.material_status === 'reject' && (
              <p className="text-[11px] text-red-600 mt-0.5">On save, a rejected-material debit note for the bill value will be raised automatically.</p>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className="label">Bill Number</label><input className="input" value={form.bill_number} onChange={e => setForm({...form, bill_number: e.target.value})} /></div>
            <div><label className="label">Bill Date</label><input className="input" type="date" value={form.bill_date} onChange={e => setForm({...form, bill_date: e.target.value})} /></div>
            {/* `|| ''` lets backspace clear the field (mam 2026-05-25). */}
            <div><label className="label">Amount</label><input className="input" type="number" value={form.amount || ''} onChange={e => setForm({...form, amount: +e.target.value, total_amount: +e.target.value + (form.gst_amount || 0)})} /></div>
            <div><label className="label">GST Amount</label><input className="input" type="number" value={form.gst_amount || ''} onChange={e => setForm({...form, gst_amount: +e.target.value, total_amount: (form.amount || 0) + +e.target.value})} /></div>
          </div>
          <div><label className="label">Total</label><input className="input" type="number" value={form.total_amount} readOnly /></div>
          <div>
            <label className="label">Bill File * <span className="text-gray-400 font-normal">(PDF / JPG / PNG / XLSX, max 10 MB)</span></label>
            <input
              className="input"
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls"
              required
              onChange={e => setForm({ ...form, bill_file: e.target.files?.[0] || null })}
            />
            {form.bill_file && <p className="text-[10px] text-emerald-600 mt-0.5">Selected: {form.bill_file.name}</p>}
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Save</button></div>
        </form>
      </Modal>

      {/* Edit received qty of an existing purchase bill (mam 2026-06-30) — updates
          the Delivery Challan's received quantities. */}
      <Modal isOpen={modal === 'editqty'} onClose={() => { setModal(false); setEditBillId(null); }} title={`Edit received qty — ${form.bill_number || ''}`}>
        {!billItems ? (
          <div className="text-sm text-gray-400 py-6 text-center">Loading PO items…</div>
        ) : (billItems.items?.length || 0) === 0 ? (
          <div className="text-sm text-gray-500 py-6 text-center">This PO has no itemised lines linked from the indent — nothing to edit.</div>
        ) : (
          <div className="space-y-3">
            <p className="text-[11px] text-gray-500">Edit how much was actually received per line. Saving updates the Delivery Challan’s quantity.</p>
            <div className="border rounded-lg overflow-hidden">
              <div className="overflow-x-auto max-h-72">
                <table className="text-[11px] w-full">
                  <thead className="bg-gray-50 sticky top-0"><tr>
                    <th className="px-2 py-1 text-left">Item</th>
                    <th className="px-2 py-1 text-right">PO Qty</th>
                    <th className="px-2 py-1 text-right">Received</th>
                    <th className="px-2 py-1 text-right">Short</th>
                  </tr></thead>
                  <tbody>
                    {billItems.items.map(it => {
                      const rq = billRecv[it.vpi_id] == null ? it.ordered_qty : +billRecv[it.vpi_id];
                      const short = Math.max(0, (+it.ordered_qty || 0) - rq);
                      return (
                        <tr key={it.vpi_id} className={`border-t ${short > 0 ? 'bg-amber-50' : ''}`}>
                          <td className="px-2 py-1">{it.description}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{(+it.ordered_qty || 0).toLocaleString('en-IN')} {it.unit}</td>
                          <td className="px-2 py-1 text-right">
                            <NumInput step="any" min="0" value={rq}
                              onChange={(v) => setBillRecv(prev => ({ ...prev, [it.vpi_id]: v }))}
                              className="border border-gray-300 rounded px-1 py-0.5 w-16 text-right text-[11px] focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500" />
                          </td>
                          <td className={`px-2 py-1 text-right tabular-nums font-semibold ${short > 0 ? 'text-amber-700' : 'text-gray-300'}`}>{short > 0 ? short.toLocaleString('en-IN') : '0'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => { setModal(false); setEditBillId(null); }} className="btn btn-secondary">Cancel</button>
              <button type="button" onClick={saveEditQty} className="btn btn-primary">Save qty</button>
            </div>
          </div>
        )}
      </Modal>

      {/* Edit selling rate per line on a generated Sales Bill (mam 2026-06-30). */}
      <Modal isOpen={modal === 'editrate'} onClose={() => { setModal(false); setEditRate(null); }} title={`Edit selling rate — ${editRate?.document_number || ''}`}>
        {!editRate ? null : (editRate.items.length === 0) ? (
          <div className="text-sm text-gray-500 py-6 text-center">This sales bill has no line items to rate.</div>
        ) : (() => {
          const sub = editRate.items.reduce((s, it) => s + ((+it.qty || 0) * (it.rate === '' ? 0 : +it.rate || 0)), 0);
          return (
            <div className="space-y-3">
              <p className="text-[11px] text-gray-500">Type the selling rate per line. The amount, subtotal and GST on the Tax Invoice fill in, and the bill stops being a draft.</p>
              <div className="border rounded-lg overflow-hidden">
                <div className="overflow-x-auto max-h-72">
                  <table className="text-[11px] w-full">
                    <thead className="bg-gray-50 sticky top-0"><tr>
                      <th className="px-2 py-1 text-left">Item</th>
                      <th className="px-2 py-1 text-right">Qty</th>
                      <th className="px-2 py-1 text-right">Rate ₹</th>
                      <th className="px-2 py-1 text-right">Amount ₹</th>
                    </tr></thead>
                    <tbody>
                      {editRate.items.map((it, i) => {
                        const amt = Math.round((+it.qty || 0) * (it.rate === '' ? 0 : +it.rate || 0) * 100) / 100;
                        return (
                          <tr key={i} className="border-t">
                            <td className="px-2 py-1">{it.description}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{(+it.qty || 0).toLocaleString('en-IN')} {it.unit}</td>
                            <td className="px-2 py-1 text-right">
                              <NumInput step="any" min="0" value={it.rate}
                                onChange={(v) => setEditRate(er => ({ ...er, items: er.items.map((x, j) => j === i ? { ...x, rate: v } : x) }))}
                                className="border border-gray-300 rounded px-1 py-0.5 w-20 text-right text-[11px] focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500" />
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums">{amt ? `₹${amt.toLocaleString('en-IN')}` : <span className="text-gray-300">—</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot><tr className="border-t bg-gray-50 font-semibold"><td className="px-2 py-1" colSpan="3">Sub Total</td><td className="px-2 py-1 text-right tabular-nums">₹{(Math.round(sub * 100) / 100).toLocaleString('en-IN')}</td></tr></tfoot>
                  </table>
                </div>
              </div>
              <div className="flex justify-end gap-3">
                <button type="button" onClick={() => { setModal(false); setEditRate(null); }} className="btn btn-secondary">Cancel</button>
                <button type="button" onClick={saveEditRate} className="btn btn-primary">Save rates</button>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* Create Sales Bill / Delivery Note — mam: "like po I want from erp
          create sales bill or dispatch". The form gathers everything the
          template needs, save submits the data, and the SEPL-format
          document is generated right after save (opens in a new tab).
          The signed-copy upload is now a follow-up step after delivery. */}
      {/* Mam (2026-05-22): "only here sales bill" — modal is strictly
          Sales Bill now.  The Delivery Challan option was removed
          from inside (radio chooser deleted).  For challans / FOC
          send-with-truck papers, use the auto-generated DN at
          /vendor-po/:id/delivery-note instead. */}
      {/* Modal title adapts to document_type so it's clear whether you're
          creating a billable Sales Bill or a non-billable Delivery Note
          / Challan (mam 2026-05-25: "here also add delivery note for rec"). */}
      <Modal isOpen={modal === 'delivery'} onClose={() => setModal(false)} title={(() => {
        const kind = form.document_type === 'challan' ? 'Delivery Note' : 'Sales Bill';
        return form.vendor_po_number ? `Create ${kind} — ${form.vendor_po_number}` : `Create ${kind}`;
      })()} wide>
        <form onSubmit={saveDeliveryNote} className="space-y-4">
          {form.vendor_po_number && (
            <div className="bg-emerald-50 border border-emerald-200 rounded px-3 py-2 text-xs text-emerald-700">
              Linked to <strong>source Vendor PO</strong> <b>{form.vendor_po_number}</b>. Once this dispatch is recorded, the PO moves off the "Ready to Dispatch" list.
            </div>
          )}

          {/* Mam (2026-05-22): "here only sales bill of po item with
              only show delivery note as data which is created with po"
              — the Sales Bill form needs client GSTIN + BOQ rates and
              fails on incomplete BB rows.  For routine deliveries the
              admin just needs the auto-generated DN that pulls
              everything from the PO.  Shortcut banner — when admin
              picks a PO they can skip this form entirely. */}
          {form.vendor_po_id && (
            <div className="bg-blue-50 border border-blue-300 rounded-lg px-3 py-2.5 flex items-center justify-between gap-2 flex-wrap">
              <div className="text-[12px] text-blue-900 flex-1 min-w-[200px]">
                🚚 <b>Just need a Delivery Note?</b> Skip this form — the
                auto-generated DN is already filled in from the PO
                (vendor / client / site / items / HSN).
              </div>
              <a
                href={`/vendor-po/${form.vendor_po_id}/delivery-note`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setModal(false)}
                className="btn btn-primary text-[12px] py-1.5 px-3 bg-emerald-700 hover:bg-emerald-800 border-emerald-700 whitespace-nowrap"
              >
                Open Auto-Generated DN →
              </a>
            </div>
          )}

          {/* BILL TO block — mam (2026-05-16): "no client / bill-to block"
              was issue #1.  Surfaces every field a tax invoice needs:
              client name + address + GSTIN + state + state code +
              linked client PO.  Pulled live when a Vendor PO is
              selected.  Yellow warning when any critical field is
              missing so mam knows to fix BB before saving. */}
          {form.document_type === 'sales_bill' && (
            <div className="border-2 border-blue-200 bg-blue-50/40 rounded p-3 space-y-2 text-xs">
              <div className="text-[10px] font-bold uppercase text-blue-700">Bill To · Customer</div>
              {!dispatchBillTo ? (
                <div className="text-gray-400 italic">Pick a Vendor PO to load client details…</div>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <div className="font-bold text-sm">{dispatchBillTo.client_company || <span className="text-amber-700">— client_company missing in BB —</span>}</div>
                      {dispatchBillTo.client_person_name && <div className="text-gray-600">Attn: {dispatchBillTo.client_person_name}</div>}
                      {dispatchBillTo.client_address && <div className="text-gray-600 mt-1">{dispatchBillTo.client_address}</div>}
                      <div className="text-gray-600">
                        {[dispatchBillTo.client_district, dispatchBillTo.client_state].filter(Boolean).join(', ')}
                      </div>
                      {(dispatchBillTo.client_phone || dispatchBillTo.client_email) && (
                        <div className="text-gray-600 mt-1">
                          {dispatchBillTo.client_phone && <>📞 {dispatchBillTo.client_phone}</>}
                          {dispatchBillTo.client_phone && dispatchBillTo.client_email && ' · '}
                          {dispatchBillTo.client_email}
                        </div>
                      )}
                    </div>
                    <div className="space-y-0.5">
                      <div><span className="text-gray-500">GSTIN:</span> <span className="font-mono font-semibold">{dispatchBillTo.client_gstin || <span className="text-amber-700">— not set —</span>}</span></div>
                      <div><span className="text-gray-500">State Code:</span> <span className="font-mono">{dispatchBillTo.client_state_code || <span className="text-amber-700">—</span>}</span></div>
                      <div><span className="text-gray-500">Lead:</span> <span className="font-mono">{dispatchBillTo.lead_no || '—'}</span></div>
                      <div><span className="text-gray-500">Client PO:</span> <span className="font-mono">{dispatchBillTo.client_po_number || '—'}</span></div>
                      <div><span className="text-gray-500">Site:</span> {dispatchBillTo.site_name || '—'}</div>
                    </div>
                  </div>
                  {(!dispatchBillTo.client_company || !dispatchBillTo.client_gstin) && (
                    <div className="text-[10px] bg-amber-100 text-amber-800 border border-amber-200 rounded px-2 py-1 mt-1">
                      ⚠ Customer details incomplete in Business Book. Fix BB row before saving — a tax invoice without
                      {!dispatchBillTo.client_company && ' a client name'}
                      {!dispatchBillTo.client_company && !dispatchBillTo.client_gstin && ' /'}
                      {!dispatchBillTo.client_gstin && ' GSTIN'} is not legally valid.
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {/* Mam (2026-05-22): "only here sales bill" — Dispatch Type
              chooser removed.  This modal is now strictly for Sales
              Bill (formal GST tax invoice tracked in delivery_notes).
              The old Delivery Challan radio is gone — that use case
              (FOC / RGP / "send paper with the truck") is handled by
              the auto-generated Delivery Note at /vendor-po/:id/
              delivery-note, which doesn't need BB completeness or
              BOQ SITC rates.  document_type is locked to 'sales_bill'
              for any new save from this modal. */}
          {!form.vendor_po_number && (
            <div>
              <label className="label">Source Vendor PO <span className="text-[10px] text-gray-400 font-normal">(supply — items came from this PO)</span></label>
              <SearchableSelect
                options={vendorPos.map(v => ({ ...v, label: v.po_number + ' — ' + (v.vendor_name || '') }))}
                value={form.vendor_po_id || null}
                valueKey="id" displayKey="label"
                placeholder="— Not linked — search PO…"
                onChange={(v) => setForm({ ...form, vendor_po_id: v?.id || '' })}
              />
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">{form.document_type === 'challan' ? 'Challan' : 'Sales Bill'} Number</label>
              {/* Auto-generated on save unless mam expands "Override" and
                  types her own. Keeps the modal clean and prevents
                  duplicate / inconsistent numbering. */}
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs">
                <span className="font-mono font-semibold">
                  {form.document_type === 'challan'
                    ? `DC/${new Date().getFullYear()}/####`
                    : `GST/26-26/##`}
                </span>
                <span className="text-emerald-600">— auto-generated on save</span>
              </div>
              <details className="mt-1 text-[10px] text-gray-500">
                <summary className="cursor-pointer hover:text-gray-700">Override manually</summary>
                <input
                  className="input mt-1"
                  value={form.document_number || ''}
                  onChange={e => setForm({...form, document_number: e.target.value})}
                  placeholder={form.document_type === 'challan' ? 'e.g. DC/2026/0042' : 'e.g. GST/26-26/61'}
                />
              </details>
            </div>
            <div>
              <label className="label">Dispatch Date</label>
              <input className="input" type="date" value={form.delivery_date || ''} onChange={e => setForm({...form, delivery_date: e.target.value})} />
            </div>
          </div>

          {/* Editable line items — pulled from the Client PO (po_items) so
              the rate column is the SELLING price, not vendor cost. Mam:
              "give option for edit" — she wants to tweak qty / rate /
              disc % per row before the bill is generated. */}
          <div className="border border-red-200 bg-red-50/40 rounded p-3 space-y-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <div className="text-[10px] font-bold uppercase text-red-700">Line Items</div>
                <div className="text-[10px] text-gray-500">
                  {dispatchItemsLoading ? 'Loading from Client PO…'
                   : form.document_type === 'challan'
                     ? 'Delivery Challan — no rate column (FOC / RGP, not billable). Uncheck items you\'re not dispatching today.'
                     : dispatchItemsSource === 'po_items'
                       ? <>Rate column = <strong className="text-emerald-700">BOQ SITC selling rate</strong> from Client PO. Tweak qty / disc % if needed, or uncheck rows you\'re not billing today.{dispatchRateInfo.rated < dispatchRateInfo.total && <span className="text-amber-700"> ⚠ {dispatchRateInfo.total - dispatchRateInfo.rated} of {dispatchRateInfo.total} BOQ rows have ₹0 rate — fill them in or skip.</span>}</>
                       : dispatchItemsSource === 'indent_fallback'
                         ? <>Pre-filled <strong>{dispatchItems.length}</strong> line(s) from the indent (qty / description / unit). <strong className="text-amber-700">Selling rates left blank</strong> — enter the SITC rate per row before saving.</>
                       : dispatchItemsSource === 'vendor_po' ? 'No Client PO items found — falling back to Vendor PO items (vendor cost). Verify rates before saving.'
                       : 'No items pre-filled. Add rows manually below.'}
                </div>
                {/* Mam (2026-05-22): two-tier warning.
                    rate_source='rate_missing' → AMBER (form is pre-filled,
                       just needs rates) → recoverable in seconds
                    rate_source=null (empty)   → RED (nothing pre-filled,
                       admin has to add rows manually) → needs more work */}
                {form.document_type === 'sales_bill' && !dispatchItemsLoading && dispatchRateInfo.warning && (
                  <div className={`text-[11px] rounded p-2 mt-1 ${
                    dispatchRateInfo.source === 'rate_missing'
                      ? 'bg-amber-50 border border-amber-300 text-amber-900'
                      : 'bg-red-100 border border-red-300 text-red-800'
                  }`}>
                    {dispatchRateInfo.source === 'rate_missing'
                      ? <>⚠ <strong>Selling rates needed.</strong> {dispatchRateInfo.warning}</>
                      : <>❌ <strong>BOQ SITC rates missing.</strong> {dispatchRateInfo.warning}</>
                    }
                  </div>
                )}
              </div>
              {/* "+ Add row" REMOVED on mam's instruction (2026-05-25):
                  "dont add row because already pick according indent".
                  Lines are auto-populated from the indent / BOQ; manual
                  rows let users add ghost items that aren't tied to any
                  PO line, leading to billing mistakes.  If a line really
                  is missing, the source data (BOQ or indent) needs to be
                  fixed — not papered over with a manual row here. */}
            </div>
            {/* Challan = FOC / RGP, not billable, so we hide Rate / Disc /
                Amount columns entirely. Sales Bill keeps the full set. */}
            <div className="overflow-x-auto -mx-3">
              {(() => {
                const isChallan = form.document_type === 'challan';
                const emptyColspan = isChallan ? 6 : 9;
                const subtotalLabelColspan = isChallan ? 5 : 7;
                return (
              <table className="w-full text-[11px]">
                <thead className="bg-red-100/60 text-red-800 uppercase">
                  <tr>
                    <th className="px-1 py-1 text-center" style={{ width: '32px' }}>✓</th>
                    <th className="px-2 py-1 text-left">Description</th>
                    <th className="px-1 py-1 text-left" style={{ width: '70px' }}>HSN</th>
                    <th className="px-1 py-1 text-right" style={{ width: '70px' }}>Qty</th>
                    <th className="px-1 py-1 text-left" style={{ width: '60px' }}>UOM</th>
                    {!isChallan && <th className="px-1 py-1 text-right" style={{ width: '90px' }}>Rate (₹)</th>}
                    {!isChallan && <th className="px-1 py-1 text-right" style={{ width: '60px' }}>Disc %</th>}
                    {!isChallan && <th className="px-1 py-1 text-right" style={{ width: '100px' }}>Amount (₹)</th>}
                    <th className="px-1 py-1" style={{ width: '32px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {dispatchItems.length === 0 && !dispatchItemsLoading && (
                    <tr><td colSpan={emptyColspan} className="px-2 py-3 text-center text-gray-400 italic">No line items found for this PO. Check that the source indent has BOQ-linked items.</td></tr>
                  )}
                  {dispatchItems.map((it, idx) => {
                    const qty = +it.quantity || 0;
                    const rate = +it.rate || 0;
                    const discPct = +it.disc_pct || 0;
                    const amount = qty * rate * (1 - discPct / 100);
                    const update = (patch) => {
                      setDispatchItems(prev => prev.map((r, i) => i === idx ? { ...r, ...patch } : r));
                    };
                    return (
                      <tr key={idx} className={`border-b border-red-100 ${it.include === false ? 'opacity-40 bg-gray-50' : ''}`}>
                        <td className="px-1 py-1 text-center">
                          <input type="checkbox" checked={it.include !== false} onChange={e => update({ include: e.target.checked })} className="w-3.5 h-3.5" />
                        </td>
                        <td className="px-2 py-1 align-top min-w-[240px]">
                          {/* Description is now the INDENT-wise item name
                              (mam 2026-06-04).  item_code chip + a readable,
                              editable, wrapping field. */}
                          {it.item_code && <div className="font-mono text-[9px] text-gray-500 leading-none mb-0.5">[{it.item_code}]</div>}
                          <textarea rows={1} className="w-full bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-red-300 rounded px-1 py-0.5 text-[11px] text-gray-800 font-medium resize-y leading-snug" value={it.description || ''} onChange={e => update({ description: e.target.value })} placeholder="Item / billing description" />
                        </td>
                        <td className="px-1 py-1">
                          <input className="w-full bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-red-300 rounded px-1 py-0.5 text-[10px]" value={it.hsn || ''} onChange={e => update({ hsn: e.target.value })} placeholder="HSN" />
                        </td>
                        <td className="px-1 py-1 text-right">
                          <input type="number" step="0.01" min="0" className="w-full bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-red-300 rounded px-1 py-0.5 text-right" value={it.quantity ?? ''} onChange={e => update({ quantity: e.target.value })} />
                        </td>
                        <td className="px-1 py-1">
                          <input className="w-full bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-red-300 rounded px-1 py-0.5 text-[10px]" value={it.unit || ''} onChange={e => update({ unit: e.target.value })} placeholder="nos" />
                        </td>
                        {!isChallan && (
                          <td className="px-1 py-1 text-right">
                            <input type="number" step="0.01" min="0" className="w-full bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-red-300 rounded px-1 py-0.5 text-right" value={it.rate ?? ''} onChange={e => update({ rate: e.target.value })} />
                          </td>
                        )}
                        {!isChallan && (
                          <td className="px-1 py-1 text-right">
                            <input type="number" step="0.01" min="0" max="100" className="w-full bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-red-300 rounded px-1 py-0.5 text-right" value={it.disc_pct ?? ''} onChange={e => update({ disc_pct: e.target.value })} placeholder="0" />
                          </td>
                        )}
                        {!isChallan && (
                          <td className="px-1 py-1 text-right font-mono">{amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        )}
                        <td className="px-1 py-1 text-center">
                          <button type="button" className="text-red-400 hover:text-red-600 text-sm leading-none" title="Remove row" onClick={() => setDispatchItems(prev => prev.filter((_, i) => i !== idx))}>×</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {!isChallan && dispatchItems.some(it => it.include !== false) && (() => {
                  // Compute live tax preview — mam (2026-05-16): "no
                  // GST preview before save".  Subtotal × form rates,
                  // shown right under the table so the grand total is
                  // visible while the user is still editing items.
                  const subtotal = dispatchItems.filter(it => it.include !== false).reduce((s, it) => {
                    const qty = +it.quantity || 0;
                    const rate = +it.rate || 0;
                    const discPct = +it.disc_pct || 0;
                    return s + qty * rate * (1 - discPct / 100);
                  }, 0);
                  const cgst = subtotal * (+form.cgst_pct || 0) / 100;
                  const sgst = subtotal * (+form.sgst_pct || 0) / 100;
                  const igst = subtotal * (+form.igst_pct || 0) / 100;
                  const freight = +form.freight_amount || 0;
                  const roundOff = +form.round_off_amount || 0;
                  const grand = subtotal + cgst + sgst + igst + freight + roundOff;
                  const fmt2 = (n) => (n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                  return (
                    <tfoot>
                      <tr className="border-t-2 border-red-300 font-semibold">
                        <td colSpan={subtotalLabelColspan} className="px-2 py-1 text-right text-red-800">Sub-total (taxable)</td>
                        <td className="px-1 py-1 text-right font-mono text-red-800">{fmt2(subtotal)}</td>
                        <td></td>
                      </tr>
                      {cgst > 0 && (
                        <tr><td colSpan={subtotalLabelColspan} className="px-2 py-0.5 text-right text-gray-600 text-[10px]">CGST @ {form.cgst_pct}%</td><td className="px-1 py-0.5 text-right font-mono text-gray-700">{fmt2(cgst)}</td><td></td></tr>
                      )}
                      {sgst > 0 && (
                        <tr><td colSpan={subtotalLabelColspan} className="px-2 py-0.5 text-right text-gray-600 text-[10px]">SGST @ {form.sgst_pct}%</td><td className="px-1 py-0.5 text-right font-mono text-gray-700">{fmt2(sgst)}</td><td></td></tr>
                      )}
                      {igst > 0 && (
                        <tr><td colSpan={subtotalLabelColspan} className="px-2 py-0.5 text-right text-gray-600 text-[10px]">IGST @ {form.igst_pct}%</td><td className="px-1 py-0.5 text-right font-mono text-gray-700">{fmt2(igst)}</td><td></td></tr>
                      )}
                      {freight > 0 && (
                        <tr><td colSpan={subtotalLabelColspan} className="px-2 py-0.5 text-right text-gray-600 text-[10px]">Freight</td><td className="px-1 py-0.5 text-right font-mono text-gray-700">{fmt2(freight)}</td><td></td></tr>
                      )}
                      {roundOff !== 0 && (
                        <tr><td colSpan={subtotalLabelColspan} className="px-2 py-0.5 text-right text-gray-600 text-[10px]">Round-off</td><td className="px-1 py-0.5 text-right font-mono text-gray-700">{fmt2(roundOff)}</td><td></td></tr>
                      )}
                      <tr className="border-t-2 border-red-400 font-extrabold bg-red-100/40">
                        <td colSpan={subtotalLabelColspan} className="px-2 py-1.5 text-right text-red-900 text-sm">GRAND TOTAL</td>
                        <td className="px-1 py-1.5 text-right font-mono text-red-900 text-sm">₹ {fmt2(grand)}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  );
                })()}
              </table>
                );
              })()}
            </div>
          </div>

          {/* Conditional fields per document type — fed into the auto-generated
              print page so it matches mam's SEPL Delivery Note / Sales Bill
              templates 1:1. */}
          {form.document_type === 'challan' && (
            <div className="border border-sky-200 bg-sky-50/40 rounded p-3 space-y-3">
              <div className="text-[10px] font-bold uppercase text-sky-700">Vehicle / Transport Details</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div><label className="label">Vehicle No.</label><input className="input" value={form.vehicle_no || ''} onChange={e => setForm({ ...form, vehicle_no: e.target.value })} placeholder="e.g. PB10AB1234" /></div>
                <div><label className="label">Driver Name & Mobile</label><div className="grid grid-cols-2 gap-2"><input className="input" placeholder="Driver name" value={form.driver_name || ''} onChange={e => setForm({ ...form, driver_name: e.target.value })} /><input className="input" placeholder="Mobile" value={form.driver_mobile || ''} onChange={e => setForm({ ...form, driver_mobile: e.target.value })} /></div></div>
                <div><label className="label">LR / Challan No.</label><input className="input" value={form.lr_challan_no || ''} onChange={e => setForm({ ...form, lr_challan_no: e.target.value })} /></div>
                <div><label className="label">Total Packages</label><input className="input" value={form.total_packages || ''} onChange={e => setForm({ ...form, total_packages: e.target.value })} placeholder="e.g. 3 boxes + 2 bundles" /></div>
              </div>
            </div>
          )}
          {form.document_type === 'sales_bill' && (
            <div className="border border-emerald-200 bg-emerald-50/40 rounded p-3 space-y-3">
              <div className="text-[10px] font-bold uppercase text-emerald-700">Tax Invoice Details</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div><label className="label">Place of Supply</label>
                  <select className="select" value={form.place_of_supply || ''} onChange={e => {
                    // Pick the client's state → auto-fill State Code + the
                    // intra/inter-state GST split (Punjab=home → CGST+SGST,
                    // else IGST). All stay editable for the odd exception.
                    const st = e.target.value;
                    const home = st.trim().toLowerCase() === SEPL_HOME_STATE;
                    setForm({ ...form, place_of_supply: st, state_code: gstStateCode(st),
                      cgst_pct: home ? 9 : 0, sgst_pct: home ? 9 : 0, igst_pct: home ? 0 : 18 });
                  }}>
                    <option value="">Select state</option>
                    {STATES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div><label className="label">State Code <span className="text-gray-400 text-[10px]">(auto)</span></label><input className="input" value={form.state_code || ''} onChange={e => setForm({ ...form, state_code: e.target.value })} placeholder="auto from state" /></div>
                <div><label className="label">E-Way Bill No.</label><input className="input" value={form.e_way_bill_no || ''} onChange={e => setForm({ ...form, e_way_bill_no: e.target.value })} /></div>
                <div className="flex items-center gap-2"><input type="checkbox" id="rev_charge" checked={!!form.reverse_charge} onChange={e => setForm({ ...form, reverse_charge: e.target.checked })} className="w-4 h-4" /><label htmlFor="rev_charge" className="text-sm">Reverse Charge</label></div>
                <div><label className="label">Vehicle No.</label><input className="input" value={form.vehicle_no || ''} onChange={e => setForm({ ...form, vehicle_no: e.target.value })} /></div>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
                <div><label className="label">CGST %</label><input className="input" type="number" min="0" step="0.01" value={form.cgst_pct || ''} onChange={e => setForm({ ...form, cgst_pct: +e.target.value })} placeholder="9" /></div>
                <div><label className="label">SGST %</label><input className="input" type="number" min="0" step="0.01" value={form.sgst_pct || ''} onChange={e => setForm({ ...form, sgst_pct: +e.target.value })} placeholder="9" /></div>
                <div><label className="label">IGST %</label><input className="input" type="number" min="0" step="0.01" value={form.igst_pct || ''} onChange={e => setForm({ ...form, igst_pct: +e.target.value })} placeholder="0" /></div>
                <div><label className="label">Freight (Rs)</label><input className="input" type="number" min="0" value={form.freight_amount || ''} onChange={e => setForm({ ...form, freight_amount: +e.target.value })} /></div>
                <div><label className="label">Round Off (Rs)</label><input className="input" type="number" step="0.01" value={form.round_off_amount || ''} onChange={e => setForm({ ...form, round_off_amount: +e.target.value })} /></div>
              </div>
              <p className="text-[10px] text-emerald-700">For Punjab clients: CGST 9% + SGST 9% = 18%. For other states: IGST 18%.</p>
            </div>
          )}

          {/* Existing-document attachment is now optional + de-emphasised
              since the Sotyn.Headmasters itself generates the SEPL-format document.
              Use this only if you already have a paper copy you want to
              attach for reference. The signed copy goes in via Mark
              Received after delivery. */}
          <details className="text-[11px] text-gray-500">
            <summary className="cursor-pointer hover:text-gray-700">Optionally attach an existing scan now (not required)</summary>
            <div className="mt-2">
              <input className="input" type="file" accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls" onChange={e => setForm({ ...form, dispatch_file: e.target.files?.[0] || null })} />
              {form.dispatch_file && <p className="text-[10px] text-emerald-600 mt-0.5">Selected: {form.dispatch_file.name}</p>}
            </div>
          </details>
          <div><label className="label">Notes <span className="text-gray-400 font-normal">(optional)</span></label><textarea className="input" rows="2" value={form.notes || ''} onChange={e => setForm({...form, notes: e.target.value})} /></div>
          <div className="bg-blue-50 border border-blue-200 rounded px-3 py-2 text-[11px] text-blue-800">
            On <b>Create</b>, the Sotyn.Headmasters will generate the SEPL-format <b>{form.document_type === 'challan' ? 'Delivery Note' : 'Sales Bill'}</b> from this PO's items and client info, and open it in a new tab ready to print. The signed copy gets uploaded later via Mark Received.
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Create {form.document_type === 'challan' ? 'Delivery Note' : 'Sales Bill'}</button></div>
        </form>
      </Modal>

      {/* Add Sales Bill modal — mam (2026-05-25): for Challan-only
          dispatches that were marked sales_bill_pending=1, this lets
          her upload the formal Sales Bill once it arrives.  Clears
          the pending flag on save. */}
      <Modal isOpen={!!sbTarget} onClose={() => { setSbTarget(null); setSbForm({ sales_bill_number: '', file: null }); }} title={sbTarget ? `Add Sales Bill — Dispatch #${sbTarget.id}` : 'Add Sales Bill'}>
        {sbTarget && (
          <div className="space-y-4">
            <div className="text-xs bg-amber-50 border border-amber-200 rounded p-3">
              <div className="font-semibold text-amber-800 mb-1">📋 Sales Bill pending — adding now</div>
              <div className="text-amber-700 grid grid-cols-2 gap-1">
                <div><span className="text-gray-500">Dispatch:</span> <b>{sbTarget.document_number || '#' + sbTarget.id}</b></div>
                <div><span className="text-gray-500">PO:</span> <b>{sbTarget.vendor_po_number || '—'}</b></div>
                <div><span className="text-gray-500">Vendor:</span> {sbTarget.vendor_name || '—'}</div>
                <div><span className="text-gray-500">Date:</span> {sbTarget.delivery_date || '—'}</div>
              </div>
            </div>
            <div>
              <label className="label">Sales Bill Number <span className="text-red-600">*</span></label>
              <input className="input" placeholder="e.g. GST/26-26/61"
                value={sbForm.sales_bill_number}
                onChange={(e) => setSbForm(f => ({ ...f, sales_bill_number: e.target.value }))} />
            </div>
            <div>
              <label className="label">Sales Bill File <span className="text-gray-400 text-[10px] font-normal">(optional · PDF / image / xlsx)</span></label>
              <input type="file" className="input"
                accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls"
                onChange={(e) => setSbForm(f => ({ ...f, file: e.target.files?.[0] || null }))} />
              {sbForm.file && <p className="text-[10px] text-emerald-600 mt-0.5">Selected: {sbForm.file.name}</p>}
            </div>
            <div className="flex justify-end gap-3 pt-2 border-t">
              <button type="button" onClick={() => { setSbTarget(null); setSbForm({ sales_bill_number: '', file: null }); }} className="btn btn-secondary">Cancel</button>
              <button type="button" onClick={submitSalesBill} disabled={sbSaving || !sbForm.sales_bill_number.trim()} className="btn btn-primary">
                {sbSaving ? 'Saving…' : 'Add Sales Bill'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Mark Received Modal — captures who received the dispatch AND the
          client's stamped + signed receipt photo as proof of delivery. This
          receipt is critical for mam because without it clients sometimes
          deny receiving the material and SEPL has to absorb the loss. */}
      <Modal isOpen={modal === 'receive'} onClose={() => { setModal(false); setReceiveItems([]); }} title="Mark Received" wide>
        <form onSubmit={markReceived} className="space-y-3">
          <div className="bg-indigo-50 border border-indigo-200 rounded px-3 py-2 text-xs text-indigo-700">
            Recording receipt for <b>{form.receive_doc}</b>.
          </div>
          {/* Per-line received qty (mam 2026-06-02: "according to
              delivery note all items and qty show here may delivery
              note item of qty 10 but when erec its 9").  Editable
              received qty + optional short reason per item.  Section
              always renders so mam can see whether items loaded or
              not (mam follow-up: "item wise not showing"). */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <div className="flex items-center justify-between bg-gray-50 px-3 py-2 border-b border-gray-200">
              <span className="text-xs font-semibold text-gray-700">Items received <span className="text-gray-400 font-normal">({receiveItems.length})</span></span>
              {receiveItems.length > 0 && (() => {
                const short = receiveItems.filter(it => +it.received_qty < +it.ordered_qty).length;
                return short > 0
                  ? <span className="text-[10px] font-bold text-amber-700">⚠ {short} short line{short === 1 ? '' : 's'}</span>
                  : <span className="text-[10px] text-emerald-700">Full delivery</span>;
              })()}
            </div>
            {/* Add-item helper — footer "+ Add another" button.  Pushes
                a manual row with synthetic vpi_id so the backend
                stock-IN fallback kicks in.  Empty-state CTA dropped
                since loadReceiveItems() now always seeds at least 1
                row (mam 2026-06-02: "by deault pick which items in
                delivery note"). */}
            {receiveItems.length > 0 && (
              <div className="px-3 py-2 border-t border-gray-100 bg-gray-50/40 flex justify-end">
                <button
                  type="button"
                  onClick={() => setReceiveItems(prev => [
                    ...prev,
                    {
                      vpi_id: `manual-${Date.now()}-${prev.length}`,
                      description: '',
                      master_name: '',
                      item_code: '',
                      specification: '',
                      size: '',
                      unit: '',
                      ordered_qty: 0,
                      received_qty: 0,
                      short_reason: '',
                    },
                  ])}
                  className="text-xs text-blue-700 font-semibold flex items-center gap-1 hover:underline"
                >
                  <FiPlus size={11} /> Add another item
                </button>
              </div>
            )}
            {receiveItems.length > 0 && (
              <>
                <div className="overflow-x-auto">
                <table className="text-xs w-full">
                  <thead className="bg-gray-50 text-gray-600">
                    <tr>
                      <th className="text-left px-2 py-1 w-8">#</th>
                      <th className="text-left px-2 py-1">Item</th>
                      <th className="text-right px-2 py-1 w-20">Ordered</th>
                      <th className="text-right px-2 py-1 w-24">Received</th>
                      <th className="text-left px-2 py-1 w-12">Unit</th>
                      <th className="text-left px-2 py-1">Short reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receiveItems.map((it, idx) => {
                      const isShort = +it.received_qty < +it.ordered_qty;
                      // Mam (2026-06-02): manual rows have no vpi_id —
                      // their description + unit are editable so mam
                      // can type "MS PIPE 25mm · qty 10" when the PO
                      // doesn't pre-link items.  Auto-linked rows lock
                      // those fields (display only).
                      const isManual = !it.vpi_id || String(it.vpi_id).startsWith('manual-');
                      return (
                        <tr key={it.vpi_id || `manual-${idx}`} className={`border-b border-gray-100 ${isShort ? 'bg-amber-50/30' : ''}`}>
                          <td className="px-2 py-1.5 text-gray-500">{idx + 1}</td>
                          <td className="px-2 py-1.5">
                            {isManual ? (
                              <input
                                type="text"
                                className="input text-xs py-1 px-2 w-full"
                                placeholder="e.g. MS PIPE / C CLASS / 25mm"
                                value={it.description}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setReceiveItems(prev => prev.map((r, i) => i === idx ? { ...r, description: v } : r));
                                }}
                              />
                            ) : (
                              <>
                                {it.item_code && <span className="font-mono text-[10px] text-gray-500">[{it.item_code}] </span>}
                                <span className="font-medium">{it.master_name || it.description}</span>
                                {(it.specification || it.size) && (
                                  <div className="text-[10px] text-gray-500">{[it.size, it.specification].filter(Boolean).join(' / ')}</div>
                                )}
                              </>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            {isManual ? (
                              <NumInput
                                step="any" min="0"
                                value={it.ordered_qty}
                                onChange={(v) => {
                                  const ord = Math.max(0, +v || 0);
                                  setReceiveItems(prev => prev.map((r, i) => i === idx
                                    ? { ...r, ordered_qty: ord, received_qty: Math.min(ord, +r.received_qty || ord) }
                                    : r));
                                }}
                                className="border border-gray-300 rounded px-2 py-1 w-16 text-right text-xs focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                              />
                            ) : (
                              <span className="text-gray-700 font-medium">{it.ordered_qty}</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            <NumInput
                              step="any" min="0" max={isManual ? undefined : it.ordered_qty}
                              value={it.received_qty}
                              onChange={(v) => {
                                const max = isManual ? Infinity : +it.ordered_qty;
                                const clamped = Math.max(0, Math.min(max, +v || 0));
                                setReceiveItems(prev => prev.map((r, i) => i === idx ? { ...r, received_qty: clamped } : r));
                              }}
                              className={`border rounded px-2 py-1 w-20 text-right text-xs focus:ring-1 focus:ring-emerald-500 ${isShort ? 'border-amber-400 bg-amber-50 text-amber-800 font-semibold' : 'border-gray-300 focus:border-emerald-500'}`}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            {isManual ? (
                              <input
                                type="text"
                                className="input text-xs py-1 px-2 w-14"
                                placeholder="kg / m / nos"
                                value={it.unit}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setReceiveItems(prev => prev.map((r, i) => i === idx ? { ...r, unit: v } : r));
                                }}
                              />
                            ) : (
                              <span>{it.unit || '—'}</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            <div className="flex items-center gap-1">
                              <input
                                className="input text-xs py-1 px-2 flex-1"
                                placeholder={isShort ? 'damaged / short / etc.' : '— (no shortage)'}
                                value={it.short_reason}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setReceiveItems(prev => prev.map((r, i) => i === idx ? { ...r, short_reason: v } : r));
                                }}
                                disabled={!isShort}
                              />
                              {isManual && (
                                <button
                                  type="button"
                                  onClick={() => setReceiveItems(prev => prev.filter((_, i) => i !== idx))}
                                  className="text-red-500 hover:text-red-700 p-1"
                                  title="Remove this row"
                                >
                                  <FiTrash2 size={11} />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
                <div className="bg-gray-50/60 px-3 py-1.5 text-[10px] text-gray-500 border-t border-gray-100">
                  Tip: lower the Received qty if the delivery is short. Short lines turn amber and unlock the reason field.
                </div>
              </>
            )}
          </div>
          <div>
            <label className="label">Received By (name) *</label>
            {/* Mam (2026-06-02): "receiver name in drop down with search".
                Native <datalist> combobox — mam picks from the employee
                list with autocomplete-as-she-types, OR types a custom
                name for external receivers (customer rep, sub-contractor,
                anyone not in HR). Works on iPhone Safari too. */}
            <input
              className="input"
              list="receive-by-suggestions"
              placeholder="Type name or pick from list…"
              value={form.received_by_name || ''}
              onChange={e => setForm({...form, received_by_name: e.target.value})}
              required
            />
            <datalist id="receive-by-suggestions">
              {(employees || []).map(emp => (
                <option key={emp.id} value={emp.name}>
                  {emp.role ? `${emp.role}` : ''}{emp.email ? ` · ${emp.email}` : ''}
                </option>
              ))}
            </datalist>
            <p className="text-[10px] text-gray-400 mt-0.5">
              Start typing to filter SEPL staff, or type any name for an external receiver.
            </p>
          </div>
          <div>
            <label className="label">Received On</label>
            <input className="input" type="date" value={form.received_at || ''} onChange={e => setForm({...form, received_at: e.target.value})} />
            <p className="text-[10px] text-gray-400 mt-0.5">Defaults to today if left blank.</p>
          </div>
          <div>
            <label className="label">Receipt Proof * <span className="text-red-500 font-normal">(stamped + signed photo — prevents client denial disputes)</span></label>
            <input
              className="input"
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              required
              onChange={e => setForm({ ...form, receipt_file: e.target.files?.[0] || null })}
            />
            {form.receipt_file && <p className="text-[10px] text-emerald-600 mt-0.5">Selected: {form.receipt_file.name}</p>}
            <p className="text-[10px] text-gray-400 mt-0.5">On mobile, tapping this opens the camera directly — take the photo of the stamped sales bill / challan.</p>
          </div>
          {/* Sales Bill pending — mam (2026-05-25): "rec is against some
              time delivery note so can upload but show sales bill is
              pending".  Lets mam mark "the receipt I'm uploading is the
              DN — Sales Bill is still coming".  Adds the amber chip
              "📋 SB PENDING" to the dispatch row + enables the "Add
              Sales Bill" button once the SB arrives. */}
          <label className="flex items-start gap-2 text-xs bg-amber-50 border border-amber-200 rounded p-2.5 cursor-pointer">
            <input type="checkbox" className="mt-0.5"
              checked={!!form.sales_bill_pending}
              onChange={(e) => setForm({ ...form, sales_bill_pending: e.target.checked })} />
            <span>
              <span className="font-semibold text-amber-800">Sales Bill is pending</span>
              <span className="text-amber-700 block mt-0.5">
                Tick this if the receipt above is a Delivery Note / Challan and the formal Sales Bill will arrive later.  An "📋 SB Pending" chip will show on this dispatch until you upload the Sales Bill.
              </span>
            </span>
          </label>
          {/* Optional inventory link — pick a warehouse to auto-add the
              vendor PO's items as stock. Leave blank to skip. */}
          {warehouses.length > 0 && (
            <div>
              <label className="label">Add to Inventory at Warehouse <span className="text-gray-400 font-normal">(optional)</span></label>
              <select className="select" value={form.warehouse_id || ''} onChange={e => setForm({ ...form, warehouse_id: e.target.value })}>
                <option value="">— don't add to stock (manual entry later) —</option>
                {warehouses.filter(w => w.active).map(w => (
                  <option key={w.id} value={w.id}>{w.name}{w.type === 'office' ? ' ★' : ''}</option>
                ))}
              </select>
              <p className="text-[10px] text-gray-400 mt-0.5">If selected, every item from this vendor PO automatically lands in that warehouse with the PO rate. Skip if you'll record stock manually in Inventory.</p>
            </div>
          )}
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => { setModal(false); setReceiveItems([]); }} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Mark as Received</button>
          </div>
        </form>
      </Modal>

      {/* Finalize Rate Modal — Step 2 of the item-wise rate flow */}
      <Modal isOpen={!!finalModal} onClose={() => { setFinalModal(null); setFinalForm({}); }} title={finalModal ? `Finalize — ${finalModal.description?.slice(0, 60) || 'Item'}` : 'Finalize'}>
        <form onSubmit={submitFinalize} className="space-y-3">
          {/* Quote comparison for quick reference */}
          {finalModal && (
            <div className="bg-gray-50 rounded-lg p-3 text-xs space-y-1">
              <p className="font-semibold text-gray-700">Vendor quotes for this item:</p>
              {[1,2,3].map(n => finalModal[`vendor${n}_name`] && finalModal[`vendor${n}_rate`] > 0 && (
                <div key={n} className="flex justify-between">
                  <span>{finalModal[`vendor${n}_name`]}</span>
                  <span className="font-mono">Rs {finalModal[`vendor${n}_rate`]} {finalModal[`vendor${n}_terms`] ? `· ${finalModal[`vendor${n}_terms`]}` : ''}</span>
                </div>
              ))}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Final Vendor *</label>
              {/* Dropdown of the 3 quoted vendors. mam's flow: 90% of the
                  time the lowest rate (auto-suggested) is right; ~10% of
                  the time mam picks a HIGHER rate vendor because they
                  offer Credit. Picking a vendor here auto-fills the
                  matching rate / terms / credit days from that vendor's
                  quote — overrides allowed below. */}
              <select
                className="select"
                required
                value={finalForm.final_vendor_name || ''}
                onChange={e => {
                  const name = e.target.value;
                  // Find which of the 3 vendor slots matches the picked name,
                  // then copy its rate / terms / credit_days into the final fields.
                  let nMatch = 0;
                  for (const n of [1, 2, 3]) {
                    if (finalModal?.[`vendor${n}_name`] === name) { nMatch = n; break; }
                  }
                  setFinalForm(f => ({
                    ...f,
                    final_vendor_name: name,
                    final_rate: nMatch ? +finalModal[`vendor${nMatch}_rate`] || 0 : f.final_rate,
                    final_terms: nMatch ? finalModal[`vendor${nMatch}_terms`] || '' : f.final_terms,
                    final_credit_days: nMatch ? +finalModal[`vendor${nMatch}_credit_days`] || 0 : f.final_credit_days,
                  }));
                }}
              >
                <option value="">— Pick vendor —</option>
                {finalModal && [1, 2, 3].map(n => {
                  const name = finalModal[`vendor${n}_name`];
                  const rate = +finalModal[`vendor${n}_rate`] || 0;
                  if (!name || rate <= 0) return null;
                  const terms = finalModal[`vendor${n}_terms`] || '';
                  const days = +finalModal[`vendor${n}_credit_days`] || 0;
                  const label = `${name} — Rs ${rate}${terms ? ` · ${terms}` : ''}${terms === 'Credit' && days ? ` (${days}d)` : ''}`;
                  return <option key={n} value={name}>{label}</option>;
                })}
              </select>
            </div>
            <div><label className="label">Final Rate (Rs) *</label><input className="input" type="number" required value={finalForm.final_rate || ''} onChange={e => setFinalForm(f => ({ ...f, final_rate: +e.target.value }))} /></div>
            <div>
              <label className="label">Payment Terms</label>
              <select className="select" value={finalForm.final_terms || ''} onChange={e => setFinalForm(f => ({ ...f, final_terms: e.target.value }))}>
                <option value="">— Select —</option>
                <option value="Advance">Advance</option>
                <option value="Credit">Credit</option>
              </select>
            </div>
            <div><label className="label">Credit Days (if Credit)</label><input className="input" type="number" value={finalForm.final_credit_days || 0} onChange={e => setFinalForm(f => ({ ...f, final_credit_days: +e.target.value }))} disabled={finalForm.final_terms !== 'Credit'} /></div>
          </div>
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button type="button" onClick={() => { setFinalModal(null); setFinalForm({}); }} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Finalize Rate</button>
          </div>
        </form>
      </Modal>

      {/* ─── Edit Vendor PO Modal ──────────────────────────────────
          Mam (2026-05-20).  Header-level safe edits only.  Line
          items / vendor swap need their own flow (not shipped yet).
          Total-amount + vendor edits get blocked server-side when
          any Purchase Bill references the PO.  Modal shows that
          context inline so user knows why a field might fail. */}
      {editPo && (
        <Modal isOpen={true} onClose={() => { setEditPo(null); setEditPoForm({}); setEditPoItems([]); }} title={`Edit Vendor PO — ${editPo.po_number}`} wide>
          <form onSubmit={saveEditVendorPo} className="space-y-3 text-sm">
            <div className="bg-amber-50 border border-amber-200 rounded p-2 text-xs text-gray-700">
              <strong>{editPo.po_number}</strong> · {editPo.vendor_name}
              {editPo.cancelled && <span className="ml-2 text-red-700">· CANCELLED (restore first to edit)</span>}
              <div className="text-[10px] text-gray-500 mt-0.5">
                PO number is immutable.  Total / vendor blocked if any Purchase Bill references this PO — cancel the bill first if needed.
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">PO Date</label>
                <input className="input" type="date"
                       value={editPoForm.po_date || ''}
                       onChange={e => setEditPoForm({ ...editPoForm, po_date: e.target.value })} />
              </div>
              <div>
                <label className="label">Expected Receipt Date</label>
                <input className="input" type="date"
                       value={editPoForm.expected_receipt_date || ''}
                       onChange={e => setEditPoForm({ ...editPoForm, expected_receipt_date: e.target.value })} />
              </div>
              <div>
                <label className="label">Total Amount (₹)</label>
                <input className="input text-right" type="number" step="0.01" min="0"
                       value={editPoForm.total_amount ?? ''}
                       onChange={e => setEditPoForm({ ...editPoForm, total_amount: +e.target.value })} />
                <p className="text-[10px] text-gray-400 mt-0.5">
                  Use only to correct typos. If items changed, recreate the PO.
                </p>
              </div>
              <div>
                <label className="label">Advance Required (₹)</label>
                <input className="input text-right" type="number" step="0.01" min="0"
                       value={editPoForm.advance_required ?? ''}
                       onChange={e => setEditPoForm({ ...editPoForm, advance_required: +e.target.value })} />
              </div>
            </div>

            <div>
              <label className="label">Remarks</label>
              <textarea className="input" rows="3"
                        value={editPoForm.remarks || ''}
                        onChange={e => setEditPoForm({ ...editPoForm, remarks: e.target.value })}
                        placeholder="Any notes about this PO — change reason, supplier follow-up, etc." />
            </div>

            {/* Freight terms + charge (mam 2026-06-12) — printed on the PDF PO. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Freight Terms</label>
                <select className="select" value={editPoForm.freight_terms || ''}
                        onChange={e => setEditPoForm({ ...editPoForm, freight_terms: e.target.value })}>
                  <option value="">— None —</option>
                  <option value="Ex-Works">Ex-Works (buyer arranges freight)</option>
                  <option value="FOR">FOR (vendor delivers to site)</option>
                </select>
              </div>
              <div>
                <label className="label">Freight Amount (₹)</label>
                <input className="input text-right" type="number" step="0.01" min="0" placeholder="0"
                       value={editPoForm.freight_amount ?? ''}
                       onChange={e => setEditPoForm({ ...editPoForm, freight_amount: e.target.value })} />
                <p className="text-[10px] text-gray-400 mt-0.5">Added to the PO total &amp; shown on the PDF.</p>
              </div>
            </div>

            {/* Payment-before-material (INTERNAL — mam 2026-05-27).
                Same UI block as Create modal. Vendor stance can change
                mid-deal (e.g. they get paid for old dues, advance no
                longer needed) — editing here re-syncs the chip. */}
            <div className="border border-amber-200 bg-amber-50/40 rounded-lg p-3 space-y-2">
              <div className="text-[10px] uppercase font-bold tracking-wide text-amber-700">⚠ Internal — not printed on vendor PO</div>
              <div className="text-xs font-semibold text-gray-700">Payment before material</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                {[
                  { id: 'no_advance',        label: 'No advance',          hint: 'Vendor ships on credit (default)' },
                  { id: 'advance',           label: 'Advance required',    hint: 'Vendor wants ₹X before shipping' },
                  { id: 'old_payment_clear', label: 'Old payment hold',    hint: 'Old dues must clear before shipment' },
                ].map(opt => {
                  const active = (editPoForm.payment_block_type || '') === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setEditPoForm(f => ({ ...f, payment_block_type: opt.id, payment_block_amount: opt.id === 'no_advance' ? '' : f.payment_block_amount }))}
                      className={`text-left rounded-lg border px-3 py-2 transition ${active ? 'bg-amber-600 text-white border-amber-700 shadow' : 'bg-white text-gray-700 border-gray-200 hover:border-amber-400'}`}
                    >
                      <div className="font-semibold text-[12px]">{opt.label}</div>
                      <div className={`text-[10px] ${active ? 'text-white/90' : 'text-gray-500'}`}>{opt.hint}</div>
                    </button>
                  );
                })}
              </div>
              {(editPoForm.payment_block_type === 'advance' || editPoForm.payment_block_type === 'old_payment_clear') && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">
                      {editPoForm.payment_block_type === 'advance' ? 'Advance amount (₹)' : 'Old dues amount (₹)'} <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="number" min="1" step="0.01"
                      className="input text-xs"
                      placeholder="e.g. 50000"
                      value={editPoForm.payment_block_amount || ''}
                      onChange={e => setEditPoForm(f => ({ ...f, payment_block_amount: e.target.value }))}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Internal notes (optional)</label>
                    <input
                      type="text"
                      className="input text-xs"
                      placeholder='e.g. "Last 3 bills overdue 45 days"'
                      value={editPoForm.payment_block_notes || ''}
                      onChange={e => setEditPoForm(f => ({ ...f, payment_block_notes: e.target.value }))}
                      maxLength={500}
                    />
                  </div>
                </div>
              )}
              {editPo.payment_block_status === 'cleared' && editPo.payment_cleared_by_name && (
                <div className="text-[10px] text-emerald-700 italic pt-1">
                  ✓ Marked cleared by {editPo.payment_cleared_by_name}
                  {editPo.payment_cleared_at && ' on ' + new Date(editPo.payment_cleared_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </div>
              )}
            </div>

            {/* Line items — mam (2026-05-25): "i want edit the po after
                creation so that after correct".  Editable qty / rate /
                description / HSN per row.  Locked + grey when bills or
                delivery notes already reference this PO (would
                invalidate them).  Live total recalculates as user types. */}
            {editPoItems.length > 0 && (
              <div className="border-t pt-3">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-sm font-semibold">Line Items ({editPoItems.length})</h4>
                  {editPoLocked && (
                    <span className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-0.5">
                      🔒 LOCKED · {editPoLockReason}
                    </span>
                  )}
                </div>
                <div className="overflow-x-auto">
                  <table className="text-xs w-full">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <th className="text-left px-2 py-1 w-8">#</th>
                        <th className="text-left px-2 py-1">Description</th>
                        <th className="text-left px-2 py-1 w-20">HSN</th>
                        <th className="text-right px-2 py-1 w-20">Qty</th>
                        <th className="text-left px-2 py-1 w-16">Unit</th>
                        <th className="text-right px-2 py-1 w-24">Rate (₹)</th>
                        <th className="text-right px-2 py-1 w-28">Amount (₹)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {editPoItems.map((it, idx) => {
                        const amt = (+it.quantity || 0) * (+it.rate || 0);
                        return (
                          <tr key={it.id} className="border-b align-top">
                            <td className="px-2 py-1 text-gray-500">{idx + 1}</td>
                            <td className="px-2 py-1">
                              {it.item_code && <div className="text-[9px] font-mono text-gray-400">[{it.item_code}]</div>}
                              <input className="input text-xs w-full" disabled={editPoLocked}
                                value={it.description || ''}
                                onChange={e => setEditPoItems(prev => prev.map((r, i) => i === idx ? { ...r, description: e.target.value } : r))} />
                            </td>
                            <td className="px-2 py-1">
                              <input className="input text-xs w-full" disabled={editPoLocked}
                                value={it.hsn_code || ''}
                                onChange={e => setEditPoItems(prev => prev.map((r, i) => i === idx ? { ...r, hsn_code: e.target.value } : r))} />
                            </td>
                            <td className="px-2 py-1 text-right">
                              <NumInput className="input text-xs w-full text-right" disabled={editPoLocked} emitZeroOnEmpty min="0"
                                value={it.quantity}
                                onChange={v => setEditPoItems(prev => prev.map((r, i) => i === idx ? { ...r, quantity: v } : r))} />
                            </td>
                            <td className="px-2 py-1 text-gray-600">{it.unit || '—'}</td>
                            <td className="px-2 py-1 text-right">
                              <NumInput className="input text-xs w-full text-right" disabled={editPoLocked} emitZeroOnEmpty min="0"
                                value={it.rate}
                                onChange={v => setEditPoItems(prev => prev.map((r, i) => i === idx ? { ...r, rate: v } : r))} />
                            </td>
                            <td className="px-2 py-1 text-right font-semibold whitespace-nowrap">
                              ₹{amt.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="bg-blue-50 font-semibold">
                        <td colSpan="6" className="px-2 py-2 text-right">Sub-total (taxable)</td>
                        <td className="px-2 py-2 text-right text-blue-700">
                          ₹{editPoItems.reduce((s, it) => s + (+it.quantity || 0) * (+it.rate || 0), 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                        </td>
                      </tr>
                      <tr className="bg-blue-50 font-semibold text-blue-800">
                        <td colSpan="6" className="px-2 py-2 text-right">+ 18% GST · Grand Total</td>
                        <td className="px-2 py-2 text-right">
                          ₹{(editPoItems.reduce((s, it) => s + (+it.quantity || 0) * (+it.rate || 0), 0) * 1.18).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {!editPoLocked && (
                  <p className="text-[10px] text-gray-500 mt-1">
                    Saving will auto-recompute the PO's Total Amount from these line items (× 1.18 GST).
                  </p>
                )}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2 border-t">
              <button type="button" onClick={() => { setEditPo(null); setEditPoForm({}); setEditPoItems([]); }} className="btn btn-secondary">Cancel</button>
              <button type="submit" disabled={editPoSaving} className="btn btn-primary">
                {editPoSaving ? 'Saving…' : 'Update PO'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* APPROVE INDENT MODAL — mam (2026-05-25): "show budget according to
          sub item item wise master sheet total ... and can edit qty at
          approval time".  Approver sees the full line list with editable
          qty inputs + a live budget total at the bottom.  Only changed
          quantities go up in the request body. */}
      <Modal isOpen={!!approveTarget} onClose={() => { setApproveTarget(null); setApproveQtyOverrides({}); setApproveFromStore({}); setApproveUnitOverrides({}); setApproveMargin(''); }} title={approveTarget ? `Approve Indent ${approveTarget.indent_number}` : 'Approve Indent'} wide>
        {approveTarget && (() => {
          const items = approveTarget.items || [];
          const liveBudget = items.reduce((sum, it) => {
            const q = +approveQtyOverrides[it.id];
            return sum + ((Number.isFinite(q) ? q : +it.quantity) * (+it.master_price || 0));
          }, 0);
          const changedCount = items.filter(it => +approveQtyOverrides[it.id] !== +it.quantity).length;
          // Stock-coverage rollup (mam 2026-05-25 follow-up).  Counts how
          // many lines are fully covered by office+site stock so mam can
          // see at a glance "3 of 5 items already on hand" before drilling
          // into individual rows.
          const stockSummary = items.reduce((acc, it) => {
            const usedQty = Number.isFinite(+approveQtyOverrides[it.id]) ? +approveQtyOverrides[it.id] : +it.quantity;
            const total = (+it.office_stock || 0) + (+it.site_stock || 0);
            if (!it.item_master_id) acc.unknown += 1;
            else if (total >= usedQty && usedQty > 0) acc.covered += 1;
            else if (total > 0)                       acc.partial += 1;
            else                                      acc.uncovered += 1;
            return acc;
          }, { covered: 0, partial: 0, uncovered: 0, unknown: 0 });
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-xs bg-emerald-50 border border-emerald-200 rounded p-3">
                <div><span className="text-gray-500">Site:</span> <span className="font-medium">{approveTarget.site_name || '—'}</span></div>
                <div><span className="text-gray-500">Raised by:</span> <span className="font-medium">{approveTarget.raised_by_name || approveTarget.created_by_name}</span></div>
                <div><span className="text-gray-500">Items:</span> <span className="font-medium">{items.length}</span></div>
                <div><span className="text-gray-500">Original budget:</span> <span className="font-medium">₹{Math.round(+approveTarget.budget_amount || 0).toLocaleString('en-IN')}</span></div>
              </div>

              {/* Order Planning context for Extra-item CRM approval (mam
                  2026-06-03): show the project/site this indent maps to in
                  Order Planning + its CRM owner so the approver knows whose
                  billable line they're signing off.  Display-only. */}
              {(approveTarget.approval_policy === 'crm_two_level' || approveTarget.planning_owner || approveTarget.planning_project) && (
                <div className="grid grid-cols-2 gap-3 text-xs bg-purple-50 border border-purple-200 rounded p-3">
                  <div><span className="text-purple-500">Order Planning project:</span> <span className="font-medium text-purple-900">{approveTarget.planning_project || '—'}</span></div>
                  <div><span className="text-purple-500">CRM owner:</span> <span className="font-medium text-purple-900">{approveTarget.planning_owner || '—'}</span></div>
                </div>
              )}

              {/* Stock-coverage banner — surfaces lines that may not need
                  to be purchased because we already have them in stock. */}
              {(stockSummary.covered + stockSummary.partial) > 0 && (
                <div className="text-xs bg-amber-50 border border-amber-200 rounded p-2 flex flex-wrap gap-3 items-center">
                  <span className="font-semibold text-amber-800">⚠ Stock check:</span>
                  {stockSummary.covered > 0 && (
                    <span className="text-emerald-700"><b>{stockSummary.covered}</b> line{stockSummary.covered === 1 ? '' : 's'} fully covered by stock</span>
                  )}
                  {stockSummary.partial > 0 && (
                    <span className="text-amber-700"><b>{stockSummary.partial}</b> partially covered</span>
                  )}
                  <span className="text-gray-500 ml-auto">Consider trimming approved qty to avoid over-buying.</span>
                </div>
              )}

              <datalist id="approve-uom-list">
                {['PCS','MTR','KG','SQMM','PACKET','SET','LOT','PAIR','RFT','LTR','BOX','NOS'].map(u => <option key={u} value={u} />)}
              </datalist>
              <div className="overflow-x-auto">
                <table className="text-xs w-full">
                  <thead className="bg-gray-50 text-gray-600">
                    <tr>
                      <th className="text-left px-2 py-1 w-8">#</th>
                      <th className="text-left px-2 py-1">Sub-Item</th>
                      <th className="text-left px-2 py-1 w-16">Unit</th>
                      <th className="text-right px-2 py-1 w-24">Master Rate</th>
                      {/* Stock columns — mam (2026-05-25): "at approval
                          time i need to show over office stock and stock
                          at site if free".  Helps the approver decide if
                          they should reduce qty / reject because the
                          item is already on hand. */}
                      <th className="text-right px-2 py-1 w-24">Office<br/><span className="text-[9px] font-normal text-gray-400 normal-case">Stock</span></th>
                      <th className="text-right px-2 py-1 w-24">Site<br/><span className="text-[9px] font-normal text-gray-400 normal-case">Stock</span></th>
                      <th className="text-right px-2 py-1 w-24">Original Qty</th>
                      <th className="text-right px-2 py-1 w-24">Approved Qty</th>
                      {/* Mam (2026-06-02): split-source columns.  "From
                          Store" = qty issued from existing office stock
                          (auto-seeded to min(office, approved)).  "To
                          Procure" = remaining qty that goes to vendor PO.
                          The two must sum to Approved Qty — the cell
                          shows red if not. */}
                      <th className="text-right px-2 py-1 w-24 bg-emerald-50">From<br/><span className="text-[9px] font-normal text-emerald-600 normal-case">Store</span></th>
                      <th className="text-right px-2 py-1 w-24 bg-blue-50">To<br/><span className="text-[9px] font-normal text-blue-600 normal-case">Procure</span></th>
                      <th className="text-right px-2 py-1 w-24">Line Budget</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, idx) => {
                      const editedQty = +approveQtyOverrides[it.id];
                      const usedQty = Number.isFinite(editedQty) ? editedQty : +it.quantity;
                      const lineBudget = usedQty * (+it.master_price || 0);
                      const changed = +editedQty !== +it.quantity;
                      return (
                        <tr key={it.id} className={`border-b ${changed ? 'bg-amber-50' : ''}`}>
                          <td className="px-2 py-1 text-gray-500">{idx + 1}</td>
                          <td className="px-2 py-1">
                            {it.item_code && <span className="font-mono text-[10px] text-gray-500">[{it.item_code}] </span>}
                            <span className="font-medium">{it.master_name || it.description}</span>
                            {(it.master_size || it.master_specification) && (
                              <div className="text-[10px] text-gray-500">{[it.master_size, it.master_specification].filter(Boolean).join(' / ')}</div>
                            )}
                          </td>
                          <td className="px-2 py-1">
                            <input
                              list="approve-uom-list"
                              value={approveUnitOverrides[it.id] ?? it.unit ?? ''}
                              onChange={(e) => setApproveUnitOverrides(prev => ({ ...prev, [it.id]: e.target.value }))}
                              placeholder="unit"
                              className="border border-gray-300 rounded px-1.5 py-1 w-16 text-xs focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                            />
                          </td>
                          <td className="px-2 py-1 text-right">
                            {+it.master_price > 0 ? (
                              <div className="inline-flex items-center gap-1 justify-end">
                                <span>₹{(+it.master_price).toLocaleString('en-IN')}</span>
                                {it.rate_source === 'history' && (
                                  <span className="text-[9px] px-1 rounded bg-amber-100 text-amber-700 font-medium" title="Rate from price history — Item Master has no current_price">hist</span>
                                )}
                              </div>
                            ) : <span className="text-gray-300">—</span>}
                          </td>
                          {/* Stock cells — mam (2026-05-25).  Green if
                              office+site stock covers the approved qty,
                              amber if partial (X short), gray if none.
                              When master_id is null (manual entry) show
                              "—" since stock can't be looked up. */}
                          {(() => {
                            const office = +it.office_stock || 0;
                            const site   = +it.site_stock || 0;
                            const total  = office + site;
                            const needed = +usedQty || 0;
                            const covered = needed > 0 && total >= needed;
                            const partial = needed > 0 && total > 0 && total < needed;
                            const stockClass = covered ? 'text-emerald-700 font-semibold' : partial ? 'text-amber-700 font-semibold' : 'text-gray-500';
                            const fmt = (n) => n > 0 ? n.toLocaleString('en-IN') : '0';
                            return (
                              <>
                                <td className={`px-2 py-1 text-right ${stockClass}`}>
                                  {it.item_master_id ? fmt(office) : <span className="text-gray-300">—</span>}
                                </td>
                                <td className={`px-2 py-1 text-right ${stockClass}`}>
                                  {it.item_master_id ? fmt(site) : <span className="text-gray-300">—</span>}
                                  {covered && <div className="text-[9px] font-normal text-emerald-600 normal-case">covered</div>}
                                  {partial && <div className="text-[9px] font-normal text-amber-600 normal-case">{(needed - total).toLocaleString('en-IN')} short</div>}
                                </td>
                              </>
                            );
                          })()}
                          <td className="px-2 py-1 text-right text-gray-500">{it.quantity}</td>
                          <td className="px-2 py-1 text-right">
                            {/* NumInput keeps backspace/select-all-delete from
                                snapping the field to 0 (mam 2026-05-25). */}
                            <NumInput step="any" min="0" emitZeroOnEmpty
                              value={approveQtyOverrides[it.id] ?? it.quantity}
                              onChange={(v) => setApproveQtyOverrides(prev => ({ ...prev, [it.id]: v }))}
                              className="border border-gray-300 rounded px-2 py-1 w-20 text-right text-xs focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500" />
                          </td>
                          {/* From Store cell (mam 2026-06-02 follow-up):
                              defaults to 0 — approver consciously picks.
                              The "📦 N avail · use" chip below the input
                              applies min(stock, approved) on one tap for
                              the common case.  Disabled when no master
                              link or no office stock. */}
                          {(() => {
                            const office = +it.office_stock || 0;
                            // From-store is capped at the recorded office stock AND the
                            // approved qty — you cannot issue more from store than is
                            // actually in stock (mam 2026-06-27: "editable according to
                            // stock, not above"; reverses the 2026-06-23 over-stock allowance).
                            const fs = +approveFromStore[it.id] || 0;
                            const maxFs = Math.min(office, usedQty);
                            const suggest = maxFs;
                            const canIssue = !!it.item_master_id && office > 0;
                            const toProc = Math.max(0, usedQty - fs);
                            const overshoot = fs > maxFs + 0.0001;
                            return (
                              <>
                                <td className="px-2 py-1 text-right bg-emerald-50/40">
                                  {canIssue ? (
                                    <div>
                                      <NumInput step="any" min="0" max={maxFs}
                                        value={approveFromStore[it.id] ?? 0}
                                        onChange={(v) => setApproveFromStore(prev => ({ ...prev, [it.id]: Math.min(+v || 0, maxFs) }))}
                                        className={`border rounded px-2 py-1 w-20 text-right text-xs focus:ring-1 focus:ring-emerald-500 ${overshoot ? 'border-red-400 bg-red-50' : 'border-gray-300 focus:border-emerald-500'}`} />
                                      {/* Recorded-stock quick-pick (only when system shows stock) */}
                                      {office > 0 && fs < suggest && (
                                        <button
                                          type="button"
                                          onClick={() => setApproveFromStore(prev => ({ ...prev, [it.id]: suggest }))}
                                          className="mt-0.5 inline-flex items-center gap-0.5 text-[9px] px-1 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-300 hover:bg-emerald-200"
                                          title={`Use ${suggest} from office store (${office} recorded)`}
                                        >
                                          📦 {office} avail · use {suggest}
                                        </button>
                                      )}
                                      {overshoot && (
                                        <div className="text-[9px] text-red-600 mt-0.5">max {maxFs} (stock)</div>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-gray-300" title="Manual entry (no Item Master link) — cannot issue from store">—</span>
                                  )}
                                </td>
                                <td className="px-2 py-1 text-right bg-blue-50/40 font-medium text-blue-700">
                                  {toProc > 0 ? toProc.toLocaleString('en-IN') : <span className="text-emerald-700" title="100% issued from store, no vendor PO needed">0</span>}
                                </td>
                              </>
                            );
                          })()}
                          <td className="px-2 py-1 text-right font-medium">
                            {+it.master_price > 0 ? `₹${Math.round(lineBudget).toLocaleString('en-IN')}` : <span className="text-gray-300">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    {/* Roll-up of From Store + To Procure totals so mam
                        sees at a glance "5 issued from store, 15 to buy"
                        across the whole indent.  Helps her sanity-check
                        before clicking Approve. */}
                    {(() => {
                      let totalStore = 0, totalProcure = 0;
                      for (const it of items) {
                        const editedQ = +approveQtyOverrides[it.id];
                        const usedQ = Number.isFinite(editedQ) ? editedQ : +it.quantity;
                        const fs = +approveFromStore[it.id] || 0;
                        totalStore += fs;
                        totalProcure += Math.max(0, usedQ - fs);
                      }
                      return (
                        <tr className="bg-gray-100 font-semibold text-xs">
                          <td colSpan="8" className="px-2 py-1 text-right text-gray-500">Split totals →</td>
                          <td className="px-2 py-1 text-right text-emerald-700 bg-emerald-50">{totalStore.toLocaleString('en-IN')}</td>
                          <td className="px-2 py-1 text-right text-blue-700 bg-blue-50">{totalProcure.toLocaleString('en-IN')}</td>
                          <td></td>
                        </tr>
                      );
                    })()}
                    <tr className="bg-emerald-50 font-semibold">
                      <td colSpan="10" className="px-2 py-2 text-right">Approved Budget Total</td>
                      <td className="px-2 py-2 text-right text-emerald-700">₹{Math.round(liveBudget).toLocaleString('en-IN')}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {changedCount > 0 && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                  <strong>{changedCount}</strong> qty change{changedCount === 1 ? '' : 's'} will be applied on approve.
                </div>
              )}

              {/* Client-quotation margin — only for the CRM stage of an
                  Extra-Non-Schedule indent (a brand-new, off-BOQ item).
                  The margin % is added on top of cost for the billable
                  client line. Extra-Schedule reuses the BOQ rate (no margin)
                  so this box doesn't appear for it. */}
              {approveTarget.approval_policy === 'crm_two_level'
                && approveTarget.crm_status === 'pending'
                && (approveTarget.indent_category === 'extra_non_schedule' || approveTarget.indent_category === 'extra_schedule') && (
                <div className="text-xs bg-purple-50 border border-purple-200 rounded p-3 flex flex-wrap items-center gap-3">
                  <span className="font-semibold text-purple-800">Client quotation margin ({approveTarget.indent_category === 'extra_schedule' ? 'Extra-Schedule' : 'Extra-Non-Schedule'}):</span>
                  <div className="flex items-center gap-1">
                    <input type="number" step="any" min="0" placeholder="0"
                      value={approveMargin}
                      onChange={e => setApproveMargin(e.target.value)}
                      className="border border-purple-300 rounded px-2 py-1 w-24 text-right focus:border-purple-500 focus:ring-1 focus:ring-purple-500" />
                    <span className="text-purple-700 font-medium">%</span>
                  </div>
                  <span className="text-gray-500">added on top of cost for the billable client line. Leave blank for no margin.</span>
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2 border-t">
                <button type="button" onClick={() => { setApproveTarget(null); setApproveQtyOverrides({}); setApproveFromStore({}); setApproveUnitOverrides({}); setApproveMargin(''); }} className="btn btn-secondary">Cancel</button>
                <button type="button" onClick={submitApprove} disabled={approveSaving} className="btn btn-success flex items-center gap-1">
                  <FiCheck /> {approveSaving ? 'Approving…' : 'Approve Indent'}
                </button>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* REJECT INDENT MODAL — mam (2026-05-25): "if reject then reason
          mandatory".  Server also enforces a non-empty reason (≥3 chars).
          Reason is saved into indents.rejection_reason and surfaced on
          the Approval column of the indent list. */}
      <Modal isOpen={!!rejectTarget} onClose={() => { setRejectTarget(null); setRejectReason(''); }} title={rejectTarget ? `Reject Indent ${rejectTarget.indent_number}` : 'Reject Indent'}>
        {rejectTarget && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-xs bg-red-50 border border-red-200 rounded p-3">
              <div><span className="text-gray-500">Site:</span> <span className="font-medium">{rejectTarget.site_name || '—'}</span></div>
              <div><span className="text-gray-500">Raised by:</span> <span className="font-medium">{rejectTarget.raised_by_name || rejectTarget.created_by_name}</span></div>
              <div><span className="text-gray-500">Items:</span> <span className="font-medium">{(rejectTarget.items || []).length}</span></div>
              <div><span className="text-gray-500">Budget:</span> <span className="font-medium">₹{Math.round(+rejectTarget.budget_amount || 0).toLocaleString('en-IN')}</span></div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Reason for rejection <span className="text-red-600">*</span>
              </label>
              <textarea rows="4"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="e.g. Qty too high for current scope, item already in stock, vendor rate not finalised, etc."
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-red-500 focus:ring-1 focus:ring-red-500" />
              <div className="flex justify-between mt-1">
                <span className="text-[11px] text-gray-500">Required · the raiser will see this reason</span>
                <span className={`text-[11px] ${rejectReason.trim().length >= 3 ? 'text-emerald-600' : 'text-gray-400'}`}>
                  {rejectReason.trim().length} / min 3 chars
                </span>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2 border-t">
              <button type="button" onClick={() => { setRejectTarget(null); setRejectReason(''); }} className="btn btn-secondary">Cancel</button>
              <button type="button" onClick={submitReject}
                disabled={rejectSaving || rejectReason.trim().length < 3}
                className="btn btn-danger flex items-center gap-1">
                <FiX /> {rejectSaving ? 'Rejecting…' : 'Reject Indent'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
