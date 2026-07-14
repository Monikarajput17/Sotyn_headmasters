import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import ResponsibilityTab from '../components/ResponsibilityTab';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiTrash2, FiCheckCircle, FiDownload, FiGrid, FiFileText, FiPackage, FiClipboard, FiPrinter, FiUsers } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';

const TYPE_LABEL = { 1: 'Type 1 · Sales Order', 2: 'Type 2 · Material Delivery', 3: 'Type 3 · Installation', 4: 'Type 4 · Final' };
const fmt = n => '₹' + Math.round(+n || 0).toLocaleString('en-IN');

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: FiGrid },
  { id: 'orders', label: 'Sales Order Bills', icon: FiFileText },
  { id: 'material', label: 'Material · PO vs Bill', icon: FiPackage },
  { id: 'dpr', label: 'DPR / Installation Bills', icon: FiClipboard },
  { id: 'responsible', label: 'Responsible', icon: FiUsers },
];

export default function SalesBilling() {
  const { canDelete } = useAuth();
  const [tab, setTab] = useState('dashboard');
  const [bills, setBills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState([]);
  const [pending, setPending] = useState(null);        // { orders_without_so:[], dpr_ready:{count,value} }
  const [material, setMaterial] = useState([]);        // dispatch challans + sales-bill status

  const [modal, setModal] = useState(false);
  const [orderId, setOrderId] = useState('');
  const [order, setOrder] = useState(null);
  const [form, setForm] = useState({ bill_date: new Date().toISOString().split('T')[0], amount: '', gst_rate: 18, reference_doc_no: '' });
  const [saving, setSaving] = useState(false);
  const [payModal, setPayModal] = useState(null);
  const [payForm, setPayForm] = useState({ amount: '', payment_date: new Date().toISOString().split('T')[0], payment_mode: 'Bank', transaction_ref: '' });

  const load = () => {
    api.get('/sales-billing').then(r => setBills(r.data || [])).catch(() => setBills([])).finally(() => setLoading(false));
    api.get('/sales-billing/orders').then(r => setOrders(r.data || [])).catch(() => setOrders([]));
    api.get('/sales-billing/pending').then(r => setPending(r.data)).catch(() => setPending(null));
    api.get('/sales-billing/material').then(r => setMaterial(r.data || [])).catch(() => setMaterial([]));
  };
  useEffect(() => { load(); }, []);

  const genSalesBill = async (challanId) => {
    try {
      const r = await api.post(`/procurement/delivery-notes/${challanId}/generate-sales-bill`, {});
      toast.success(r.data?.existing ? 'Sales bill already exists' : 'Sales bill generated');
      load();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  const openNewFor = (oid) => {
    setForm({ bill_date: new Date().toISOString().split('T')[0], amount: '', gst_rate: 18, reference_doc_no: '' });
    api.get('/sales-billing/orders').then(r => setOrders(r.data || [])).catch(() => setOrders([]));
    setModal(true);
    if (oid) pickOrder(String(oid));
  };

  // ── create ───────────────────────────────────────────────────────
  const openNew = () => {
    setOrderId(''); setOrder(null);
    setForm({ bill_date: new Date().toISOString().split('T')[0], amount: '', gst_rate: 18, reference_doc_no: '' });
    api.get('/sales-billing/orders').then(r => setOrders(r.data || [])).catch(() => setOrders([]));
    setModal(true);
  };
  const pickOrder = (id) => {
    setOrderId(id); setOrder(null);
    if (!id) return;
    api.get(`/sales-billing/orders/${id}`).then(r => {
      setOrder(r.data);
      if (r.data.next_type === 4) {
        const priorSum = (r.data.bills || []).reduce((s, b) => s + (+b.amount || 0), 0);
        if (priorSum) setForm(f => ({ ...f, amount: String(priorSum) }));
      }
    }).catch(() => toast.error('Could not load order'));
  };
  const amount = +form.amount || 0;
  const gstRate = +form.gst_rate || 0;
  const gstAmount = Math.round(amount * gstRate) / 100;
  const total = Math.round((amount + gstAmount) * 100) / 100;
  const nextType = order?.next_type || null;
  const save = async () => {
    if (!orderId) return toast.error('Pick an order');
    if (!nextType) return toast.error('All bills already exist for this order');
    if (amount <= 0) return toast.error('Enter the bill amount');
    setSaving(true);
    try {
      const items = (order?.items || []).map(it => ({ description: it.description, qty_ordered: it.quantity, unit: it.unit, rate: it.rate, amount: it.amount }));
      const r = await api.post('/sales-billing', { business_book_id: orderId, bill_type: nextType, bill_date: form.bill_date, amount, gst_rate: gstRate, reference_doc_no: form.reference_doc_no, items });
      toast.success(r.data.message || 'Bill created');
      setModal(false); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to create bill'); }
    finally { setSaving(false); }
  };

  const approve = async (b) => {
    try {
      const next = b.approval_status === 'approved' ? 'draft' : 'approved';
      await api.put(`/sales-billing/${b.id}/approve`, { approval_status: next });
      toast.success(next === 'approved' ? 'Approved' : 'Reverted to draft'); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  // Open the printable TAX INVOICE (auth-protected HTML → blob → new tab).
  const printBill = async (b) => {
    try {
      const r = await api.get(`/sales-billing/${b.id}/print`, { responseType: 'arraybuffer' });
      window.open(URL.createObjectURL(new Blob([r.data], { type: 'text/html;charset=utf-8' })), '_blank');
    } catch { toast.error('Could not open the invoice'); }
  };
  const del = async (b) => {
    if (!confirm(`Delete bill ${b.bill_number}?`)) return;
    try { await api.delete(`/sales-billing/${b.id}`); toast.success('Deleted'); load(); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  const genInstall = async () => {
    if (!confirm('Generate installation (Type 3) bills from approved, billing-ready DPRs not yet billed? Amount = the BOQ items × qty recorded in the DPR. Review, then mark Sent to Client.')) return;
    try { const r = await api.post('/sales-billing/generate-installation', {}); toast.success(r.data.message || 'Done'); load(); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  const sendToClient = async (b) => {
    try { const r = await api.put(`/sales-billing/${b.id}/sent`, {}); toast.success(r.data.message || 'Updated'); load(); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  const openPay = (b) => { setPayForm({ amount: '', payment_date: new Date().toISOString().split('T')[0], payment_mode: 'Bank', transaction_ref: '' }); setPayModal(b); };
  const savePay = async () => {
    if (!payModal) return;
    if ((+payForm.amount || 0) <= 0) return toast.error('Enter the payment amount');
    try { const r = await api.post(`/sales-billing/${payModal.id}/payment`, payForm); toast.success(r.data.message || 'Payment recorded'); setPayModal(null); load(); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  // ── derived ──────────────────────────────────────────────────────
  const billedByOrder = bills.reduce((m, b) => { m[b.business_book_id] = (m[b.business_book_id] || 0) + (+b.total_amount || 0); return m; }, {});
  const t1 = bills.filter(b => b.bill_type === 1);
  const t3 = bills.filter(b => b.bill_type === 3);
  const t4 = bills.filter(b => b.bill_type === 4);
  const orderBills = bills.filter(b => b.bill_type === 1 || b.bill_type === 4);
  const totalBilled = bills.reduce((s, b) => s + (+b.total_amount || 0), 0);
  const received = t4.reduce((s, b) => s + (+b.received_amount || 0), 0);
  const outstanding = t4.reduce((s, b) => s + ((+b.total_amount || 0) - (+b.received_amount || 0)), 0);

  const StatusCell = (b) => (
    <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 whitespace-nowrap">{b.bill_status}</span>
  );
  const ApprovalCell = (b) => (
    <button onClick={() => approve(b)} className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${b.approval_status === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700 hover:bg-amber-200'}`}>
      {b.approval_status === 'approved' ? '✓ Approved' : 'Approve'}
    </button>
  );

  const BillTable = ({ rows, showPayment, sentMode }) => (
    <div className="card p-0 overflow-x-auto">
      <table className="text-sm w-full">
        <thead>
          <tr className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
            <th className="px-3 py-2 text-left">Bill No</th>
            <th className="px-3 py-2 text-left">Type</th>
            <th className="px-3 py-2 text-left">Customer</th>
            <th className="px-3 py-2 text-left">Project</th>
            <th className="px-3 py-2 text-left">Date</th>
            <th className="px-3 py-2 text-right">Amount</th>
            <th className="px-3 py-2 text-right">GST</th>
            <th className="px-3 py-2 text-right">Total</th>
            <th className="px-3 py-2 text-center">Status</th>
            <th className="px-3 py-2 text-center">{sentMode ? 'Sent to Client' : 'Approval'}</th>
            {showPayment && <th className="px-3 py-2 text-center">Payment</th>}
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={showPayment ? 12 : 11} className="text-center py-8 text-gray-400">Loading…</td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={showPayment ? 12 : 11} className="text-center py-8 text-gray-400">No bills here yet.</td></tr>
          ) : rows.map(b => (
            <tr key={b.id} className="border-t border-gray-100 hover:bg-blue-50/40">
              <td className="px-3 py-2 font-medium text-gray-800 whitespace-nowrap">{b.bill_number}</td>
              <td className="px-3 py-2 text-xs whitespace-nowrap">{TYPE_LABEL[b.bill_type] || b.bill_type}</td>
              <td className="px-3 py-2">{b.customer_name || '-'}</td>
              <td className="px-3 py-2 text-gray-500">{b.project_name || '-'}</td>
              <td className="px-3 py-2 whitespace-nowrap">{b.bill_date}</td>
              <td className="px-3 py-2 text-right">{fmt(b.amount)}</td>
              <td className="px-3 py-2 text-right text-gray-500">{fmt(b.gst_amount)}<span className="text-[10px] ml-0.5">@{b.gst_rate}%</span></td>
              <td className="px-3 py-2 text-right font-semibold text-emerald-700">{fmt(b.total_amount)}</td>
              <td className="px-3 py-2 text-center">{StatusCell(b)}</td>
              <td className="px-3 py-2 text-center">
                {sentMode ? (
                  <button onClick={() => sendToClient(b)} className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${b.sent_to_client ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700 hover:bg-blue-200'}`}>
                    {b.sent_to_client ? '✓ Sent to client' : 'Sent to client'}
                  </button>
                ) : ApprovalCell(b)}
              </td>
              {showPayment && (
                <td className="px-3 py-2 text-center">
                  {b.bill_type === 4 ? (
                    <div className="flex flex-col items-center gap-0.5">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap ${b.payment_status === 'paid' ? 'bg-emerald-100 text-emerald-700' : b.payment_status === 'partial' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'}`}>
                        {b.payment_status === 'paid' ? 'Paid' : b.payment_status === 'partial' ? 'Partial' : 'Unpaid'}
                      </span>
                      {b.received_amount > 0 && <span className="text-[10px] text-gray-400">{fmt(b.received_amount)} / {fmt(b.total_amount)}</span>}
                      {b.approval_status === 'approved' && b.payment_status !== 'paid' && <button onClick={() => openPay(b)} className="text-[10px] text-blue-600 hover:underline">+ Payment</button>}
                    </div>
                  ) : <span className="text-gray-300 text-xs">—</span>}
                </td>
              )}
              <td className="px-3 py-2 text-right whitespace-nowrap">
                <button onClick={() => printBill(b)} className="text-gray-400 hover:text-blue-700 mr-2" title="Print Tax Invoice (PDF)"><FiPrinter size={14} /></button>
                {canDelete && canDelete('installation') && <button onClick={() => del(b)} className="text-gray-300 hover:text-red-500" title="Delete"><FiTrash2 size={14} /></button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <h3 className="font-semibold text-lg">Sales Billing</h3>
        <div className="flex gap-2">
          {tab === 'dpr' && <button onClick={genInstall} className="btn btn-secondary flex items-center gap-2" title="Create Type-3 installation bills from approved DPRs"><FiCheckCircle /> Generate Installation Bills</button>}
          {(tab === 'orders' || tab === 'dashboard') && <button onClick={openNew} className="btn btn-primary flex items-center gap-2"><FiPlus /> New Sales Bill</button>}
          <button onClick={() => exportCsv('sales-bills', ['Bill No', 'Type', 'Customer', 'Project', 'Date', 'Amount', 'GST', 'Total', 'Status', 'Approval'],
            bills.map(b => [b.bill_number, TYPE_LABEL[b.bill_type], b.customer_name, b.project_name, b.bill_date, b.amount, b.gst_amount, b.total_amount, b.bill_status, b.approval_status]))}
            className="btn btn-secondary flex items-center gap-2"><FiDownload /> Export</button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 flex-wrap">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium flex items-center gap-1.5 ${tab === t.id ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      {/* DASHBOARD */}
      {tab === 'dashboard' && (
        <div className="space-y-4">
          {/* Auto pendency alerts — what still needs billing */}
          {pending && (pending.orders_without_so.length > 0 || pending.dpr_ready.count > 0) ? (
            <div className="space-y-2">
              {pending.orders_without_so.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-semibold text-amber-800">⚠ {pending.orders_without_so.length} order(s) have NO Sales Order bill yet</span>
                    <span className="text-[11px] text-amber-600">don't forget to bill these</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {pending.orders_without_so.slice(0, 12).map(o => (
                      <button key={o.id} onClick={() => openNewFor(o.id)}
                        className="text-[11px] bg-white border border-amber-200 rounded-full px-2 py-0.5 hover:bg-amber-100"
                        title={`${o.customer_name} · ${o.project_name || ''} · ${fmt(o.value)} · ${o.status}`}>
                        {o.lead_no || ('BB#' + o.id)} · {o.customer_name || 'order'} <span className="text-amber-600">+ bill</span>
                      </button>
                    ))}
                    {pending.orders_without_so.length > 12 && <span className="text-[11px] text-amber-600 self-center">+{pending.orders_without_so.length - 12} more</span>}
                  </div>
                </div>
              )}
              {pending.dpr_ready.count > 0 && (
                <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3 flex items-center justify-between flex-wrap gap-2">
                  <span className="text-sm font-semibold text-indigo-800">⚠ {pending.dpr_ready.count} approved DPR(s) ready to bill (≈ {fmt(pending.dpr_ready.value)}) — not billed yet</span>
                  <button onClick={genInstall} className="btn btn-primary text-xs">Generate Installation Bills</button>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-sm font-semibold text-emerald-700">✓ All caught up — no orders or DPRs pending a bill.</div>
          )}

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: 'Total Bills', value: bills.length, sub: `${t1.length} SO · ${t3.length} install · ${t4.length} final`, ring: 'bg-slate-100 text-slate-700' },
              { label: 'Total Billed', value: fmt(totalBilled), sub: 'incl. GST', ring: 'bg-blue-100 text-blue-700' },
              { label: 'Received', value: fmt(received), sub: 'against final bills', ring: 'bg-emerald-100 text-emerald-700' },
              { label: 'Outstanding', value: fmt(outstanding), sub: 'to collect', ring: 'bg-rose-100 text-rose-700' },
            ].map((c, i) => (
              <div key={i} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
                <div className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold">{c.label}</div>
                <div className={`text-2xl font-bold leading-tight mt-1 ${c.ring.split(' ')[1]}`}>{c.value}</div>
                <div className="text-[10px] text-gray-400 mt-0.5">{c.sub}</div>
              </div>
            ))}
          </div>
          <div className="text-xs text-gray-500 bg-blue-50 border border-blue-100 rounded-lg px-4 py-2.5">
            Flow per order: <b>Sales Order (T1)</b> → <b>Material delivery (T2, billed in Dispatch)</b> → <b>Installation (T3, auto from DPRs)</b> → <b>Final (T4)</b>. Payment is taken against the Final bill.
          </div>
          <BillTable rows={bills.slice(0, 12)} showPayment />
        </div>
      )}

      {/* SALES ORDER BILLS — order-centric: every Business Book order IS a
          sales order; show its Type-1 bill status (create if missing) + Final. */}
      {tab === 'orders' && (
        <div className="space-y-2">
          <div className="text-xs text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-4 py-2">
            Your <b>orders from Business Book</b> are the sales orders. Raise the <b>Sales Order bill</b> against each, then the Final bill. ★ = in Planning.
          </div>
          <div className="card p-0 overflow-x-auto">
            <table className="text-sm w-full">
              <thead>
                <tr className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
                  <th className="px-3 py-2 text-left">Order</th>
                  <th className="px-3 py-2 text-left">Customer</th>
                  <th className="px-3 py-2 text-left">Project</th>
                  <th className="px-3 py-2 text-right">Order value</th>
                  <th className="px-3 py-2 text-left">Sales Order bill</th>
                  <th className="px-3 py-2 text-left">Final bill / payment</th>
                </tr>
              </thead>
              <tbody>
                {orders.length === 0 ? (
                  <tr><td colSpan="6" className="text-center py-8 text-gray-400">No orders found in Business Book.</td></tr>
                ) : orders.map(o => {
                  const so = bills.find(b => b.business_book_id === o.id && b.bill_type === 1);
                  const final = bills.find(b => b.business_book_id === o.id && b.bill_type === 4);
                  const val = +o.po_amount || +o.sale_amount_without_gst || 0;
                  return (
                    <tr key={o.id} className="border-t border-gray-100 hover:bg-blue-50/40">
                      <td className="px-3 py-2 font-medium whitespace-nowrap">{o.status === 'planning' ? '★ ' : ''}{o.lead_no || ('BB#' + o.id)}</td>
                      <td className="px-3 py-2">{o.customer_name || '-'}</td>
                      <td className="px-3 py-2 text-gray-500">{o.project_name || '-'}</td>
                      <td className="px-3 py-2 text-right">{fmt(val)}</td>
                      <td className="px-3 py-2">
                        {so ? (
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-gray-700">{so.bill_number}</span>
                            <span className="text-emerald-700">{fmt(so.total_amount)}</span>
                            {ApprovalCell(so)}
                          </div>
                        ) : (
                          <button onClick={() => openNewFor(o.id)} className="text-xs text-white bg-blue-600 hover:bg-blue-700 rounded-full px-3 py-1 flex items-center gap-1"><FiPlus size={12} /> Create Sales Order bill</button>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {final ? (
                          <div className="flex items-center gap-2">
                            <span className="text-emerald-700">{fmt(final.total_amount)}</span>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full ${final.payment_status === 'paid' ? 'bg-emerald-100 text-emerald-700' : final.payment_status === 'partial' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'}`}>{final.payment_status === 'paid' ? 'Paid' : final.payment_status === 'partial' ? 'Partial' : 'Unpaid'}</span>
                            {final.approval_status === 'approved' && final.payment_status !== 'paid' && <button onClick={() => openPay(final)} className="text-[11px] text-blue-600 hover:underline">+ Payment</button>}
                          </div>
                        ) : so ? <span className="text-gray-300 text-xs">after installation</span> : <span className="text-gray-300 text-xs">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MATERIAL — dispatch challans by indent, sales-bill done/pending */}
      {tab === 'material' && (
        <div className="space-y-2">
          <div className="text-xs text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-4 py-2">
            Each material dispatch (challan, by <b>indent number</b>) and whether its client <b>Sales Bill</b> is done or pending. Generating the bill uses the Dispatch flow.
            {material.length > 0 && <span className="ml-1 text-rose-600 font-semibold">{material.filter(m => m.sales_bill_status === 'pending').length} pending</span>}
          </div>
          <div className="card p-0 overflow-x-auto">
            <table className="text-sm w-full">
              <thead>
                <tr className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
                  <th className="px-3 py-2 text-left">Indent</th>
                  <th className="px-3 py-2 text-left">Challan</th>
                  <th className="px-3 py-2 text-left">Site</th>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Source</th>
                  <th className="px-3 py-2 text-right">Items</th>
                  <th className="px-3 py-2 text-right">Value</th>
                  <th className="px-3 py-2 text-left">Sales Bill</th>
                </tr>
              </thead>
              <tbody>
                {material.length === 0 ? (
                  <tr><td colSpan="8" className="text-center py-8 text-gray-400">No material dispatches yet. Challans raised in Dispatch will appear here.</td></tr>
                ) : material.map(m => (
                  <tr key={m.id} className="border-t border-gray-100 hover:bg-blue-50/40">
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{m.indent_number || '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{m.challan_no || '-'}</td>
                    <td className="px-3 py-2 text-gray-500">{m.site_name || '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{m.date || '-'}</td>
                    <td className="px-3 py-2 text-xs uppercase text-gray-400">{m.source || '-'}</td>
                    <td className="px-3 py-2 text-right">{m.item_count || 0}</td>
                    <td className="px-3 py-2 text-right" title={m.boq_value ? `${m.delivery_pct}% of BOQ ${fmt(m.boq_value)}` : 'No BOQ rate matched for this challan'}>
                      {fmt(m.value)}{m.delivery_pct ? <span className="text-[9px] text-gray-400 ml-0.5">@{m.delivery_pct}%</span> : null}
                    </td>
                    <td className="px-3 py-2">
                      {m.sales_bill_status === 'done' ? (
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">✓ {m.sales_bill_number || 'Done'}</span>
                          {m.sales_bill_file && <a href={m.sales_bill_file} target="_blank" rel="noopener noreferrer" className="text-[11px] text-blue-600 hover:underline">📎 PDF</a>}
                        </div>
                      ) : m.sales_bill_status === 'pending' ? (
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] px-2 py-0.5 rounded-full bg-rose-100 text-rose-700">Pending</span>
                          <button onClick={() => genSalesBill(m.id)} className="text-[11px] text-blue-600 hover:underline">Generate</button>
                        </div>
                      ) : <span className="text-gray-300 text-xs">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* DPR / INSTALLATION BILLS (Type 3) */}
      {tab === 'dpr' && (
        <div className="space-y-2">
          <div className="text-xs text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-4 py-2">
            Installation bills are generated from <b>submitted, approved DPRs</b> — each DPR is billed once. Click <b>Generate Installation Bills</b> to bill the latest approved DPRs (created as draft for review).
          </div>
          <BillTable rows={t3} showPayment={false} sentMode />
        </div>
      )}

      {tab === 'responsible' && <ResponsibilityTab module="sales_billing" title="Sales Billing" />}

      {/* Create modal */}
      <Modal isOpen={modal} onClose={() => setModal(false)} title="New Sales Bill">
        <div className="space-y-3">
          <div>
            <label className="label">Order → Planning project <span className="text-[10px] font-normal text-gray-400">(★ = in Planning, shown first)</span></label>
            <select className="select w-full" value={orderId} onChange={e => pickOrder(e.target.value)}>
              <option value="">Select an order…</option>
              {orders.map(o => (
                <option key={o.id} value={o.id}>{o.status === 'planning' ? '★ ' : ''}{o.lead_no || ('BB#' + o.id)} — {o.customer_name || 'No name'}{o.project_name ? ` · ${o.project_name}` : ''}{o.po_amount ? ` (${fmt(o.po_amount)})` : ''}{o.status ? ` · ${o.status}` : ''}</option>
              ))}
            </select>
          </div>
          {order && (
            <>
              <div className="bg-gray-50 rounded-lg p-3 text-xs space-y-1">
                <div><b>Customer:</b> {order.order.customer_name || '-'}</div>
                <div><b>Project:</b> {order.order.project_name || '-'}</div>
                <div><b>Order value:</b> {fmt(order.order.sale_amount_without_gst || order.order.po_amount)} {order.order.sale_amount_without_gst ? '(without GST)' : ''}</div>
                {order.bills.length > 0 && <div><b>Bills so far:</b> {order.bills.map(x => `T${x.bill_type}`).join(', ')}</div>}
              </div>
              {nextType ? (
                <div className="text-sm font-semibold text-blue-700 bg-blue-50 rounded-lg px-3 py-2">
                  Next bill: {TYPE_LABEL[nextType]}
                  {nextType === 4 && <div className="text-[11px] font-normal text-gray-600 mt-1">Amount pre-filled with the sum of bills {order.bills.map(x => `T${x.bill_type}`).join('+')} (₹{Math.round(order.bills.reduce((s, b) => s + (+b.amount || 0), 0)).toLocaleString('en-IN')}). Add commissioning on top — editable.</div>}
                </div>
              ) : (
                <div className="text-sm font-semibold text-gray-500 bg-gray-100 rounded-lg px-3 py-2">All bills already exist for this order.</div>
              )}
              {order.items.length > 0 && (
                <div className="max-h-32 overflow-y-auto border border-gray-100 rounded-lg">
                  <table className="text-[11px] w-full">
                    <thead><tr className="bg-gray-50 text-gray-500"><th className="px-2 py-1 text-left">Item</th><th className="px-2 py-1 text-right">Qty</th><th className="px-2 py-1 text-right">Rate</th><th className="px-2 py-1 text-right">Amount</th></tr></thead>
                    <tbody>
                      {order.items.map(it => (
                        <tr key={it.id} className="border-t border-gray-50"><td className="px-2 py-1">{it.description}</td><td className="px-2 py-1 text-right">{it.quantity} {it.unit}</td><td className="px-2 py-1 text-right">{fmt(it.rate)}</td><td className="px-2 py-1 text-right">{fmt(it.amount)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {nextType && (
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="label">Bill date</label><input type="date" className="input w-full" value={form.bill_date} onChange={e => setForm({ ...form, bill_date: e.target.value })} /></div>
                  <div><label className="label">Reference doc no. (optional)</label><input className="input w-full" placeholder="SO / DC / DPR no." value={form.reference_doc_no} onChange={e => setForm({ ...form, reference_doc_no: e.target.value })} /></div>
                  <div><label className="label">Amount (without GST)</label><input type="number" min="0" className="input w-full text-right" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="0" /></div>
                  <div><label className="label">GST %</label><input type="number" min="0" max="100" className="input w-full text-right" value={form.gst_rate} onChange={e => setForm({ ...form, gst_rate: e.target.value })} /></div>
                  <div className="col-span-2 flex justify-between text-sm border-t border-gray-100 pt-2">
                    <span className="text-gray-500">GST {gstRate}% = {fmt(gstAmount)}</span>
                    <span className="font-bold text-emerald-700">Total {fmt(total)}</span>
                  </div>
                </div>
              )}
            </>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button onClick={save} disabled={saving || !nextType} className="btn btn-primary flex items-center gap-1"><FiCheckCircle /> {saving ? 'Saving…' : 'Create Bill'}</button>
          </div>
        </div>
      </Modal>

      {/* Payment modal */}
      <Modal isOpen={!!payModal} onClose={() => setPayModal(null)} title={payModal ? `Record Payment · ${payModal.bill_number}` : 'Record Payment'}>
        {payModal && (
          <div className="space-y-3">
            <div className="bg-gray-50 rounded-lg p-3 text-xs space-y-1">
              <div><b>Customer:</b> {payModal.customer_name}</div>
              <div><b>Final bill total:</b> {fmt(payModal.total_amount)}</div>
              <div><b>Received so far:</b> {fmt(payModal.received_amount)} · <b>Outstanding:</b> {fmt((payModal.total_amount || 0) - (payModal.received_amount || 0))}</div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">Amount received</label><input type="number" min="0" className="input w-full text-right" value={payForm.amount} onChange={e => setPayForm({ ...payForm, amount: e.target.value })} placeholder="0" /></div>
              <div><label className="label">Date</label><input type="date" className="input w-full" value={payForm.payment_date} onChange={e => setPayForm({ ...payForm, payment_date: e.target.value })} /></div>
              <div><label className="label">Mode</label><select className="select w-full" value={payForm.payment_mode} onChange={e => setPayForm({ ...payForm, payment_mode: e.target.value })}>{['Bank', 'Cash', 'UPI', 'Cheque', 'NEFT/RTGS'].map(m => <option key={m} value={m}>{m}</option>)}</select></div>
              <div><label className="label">Reference no. (optional)</label><input className="input w-full" value={payForm.transaction_ref} onChange={e => setPayForm({ ...payForm, transaction_ref: e.target.value })} placeholder="UTR / cheque no." /></div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setPayModal(null)} className="btn btn-secondary">Cancel</button>
              <button onClick={savePay} className="btn btn-primary flex items-center gap-1"><FiCheckCircle /> Record Payment</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
