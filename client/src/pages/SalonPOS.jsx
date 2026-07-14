import { useState, useEffect, useMemo } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiShoppingBag, FiPlus, FiX, FiStar, FiCheckCircle, FiPrinter } from 'react-icons/fi';

const M = 'salon_pos';
const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

export default function SalonPOS() {
  const { canCreate } = useAuth();
  const [clients, setClients] = useState([]);
  const [stylists, setStylists] = useState([]);
  const [services, setServices] = useState([]);
  const [products, setProducts] = useState([]);
  const [settings, setSettings] = useState({ default_tax_pct: 18, point_value: 1, points_per_currency: 0.05 });
  const [clientId, setClientId] = useState('');
  const [clientDetail, setClientDetail] = useState(null);
  const [lines, setLines] = useState([]);
  const [manualDiscount, setManualDiscount] = useState(0);
  const [redeemPoints, setRedeemPoints] = useState(0);
  const [taxPct, setTaxPct] = useState(18);
  const [payMode, setPayMode] = useState('cash');
  const [receipt, setReceipt] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get('/salon/clients'), api.get('/salon/stylists', { params: { active: 1 } }),
      api.get('/salon/services', { params: { active: 1 } }), api.get('/salon/pos/settings'),
      api.get('/salon/products', { params: { active: 1 } }),
    ]).then(([c, st, sv, s, pr]) => {
      setClients(c.data); setStylists(st.data); setServices(sv.data); setProducts(pr.data);
      if (s.data && s.data.id) { setSettings(s.data); setTaxPct(s.data.default_tax_pct ?? 18); }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!clientId) { setClientDetail(null); return; }
    api.get(`/salon/clients/${clientId}`).then(r => setClientDetail(r.data)).catch(() => setClientDetail(null));
  }, [clientId]);

  const membership = clientDetail?.memberships?.find(m => m.status === 'active' && m.plan_type === 'membership' && Number(m.discount_pct) > 0);
  const addService = (id) => {
    const s = services.find(x => x.id === +id); if (!s) return;
    setLines(l => [...l, { item_type: 'service', service_id: s.id, name: s.name, unit_price: s.price, qty: 1, stylist_id: '' }]);
  };
  const addProduct = (id) => {
    const p = products.find(x => x.id === +id); if (!p) return;
    setLines(l => [...l, { item_type: 'product', product_id: p.id, name: p.name, unit_price: p.price, qty: 1, stylist_id: '', stock_qty: p.stock_qty }]);
  };
  const addCustomProduct = () => setLines(l => [...l, { item_type: 'product', name: '', unit_price: 0, qty: 1, stylist_id: '' }]);
  const upd = (i, k, v) => setLines(l => l.map((x, j) => j === i ? { ...x, [k]: v } : x));
  const rm = (i) => setLines(l => l.filter((_, j) => j !== i));

  const subtotal = useMemo(() => lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0), [lines]);
  const memberDiscount = membership && !manualDiscount ? Math.round(subtotal * membership.discount_pct) / 100 : 0;
  const discount = Number(manualDiscount) || memberDiscount;
  const pointValue = Number(settings.point_value) || 1;
  const maxRedeem = Math.min(clientDetail?.loyalty_points || 0, Math.floor((subtotal - discount) / pointValue));
  const redeem = Math.min(Number(redeemPoints) || 0, maxRedeem);
  const redeemValue = redeem * pointValue;
  const taxable = Math.max(0, subtotal - discount - redeemValue);
  const tax = Math.round(taxable * (Number(taxPct) || 0)) / 100;
  const total = Math.round((taxable + tax) * 100) / 100;
  const pointsEarn = clientId ? Math.round((subtotal - discount) * (Number(settings.points_per_currency) || 0)) : 0;

  const checkout = async () => {
    if (!lines.length) return toast.error('Add at least one item');
    if (lines.some(l => l.item_type === 'product' && !l.name.trim())) return toast.error('Name every product line');
    setSaving(true);
    try {
      const { data } = await api.post('/salon/pos', {
        client_id: clientId || null, items: lines, discount: Number(manualDiscount) || 0,
        redeem_points: redeem, tax_pct: Number(taxPct) || 0, payment_mode: payMode,
      });
      setReceipt({ ...data, client_name: clientDetail?.name, lines, payMode });
      setLines([]); setManualDiscount(0); setRedeemPoints(0);
      if (clientId) api.get(`/salon/clients/${clientId}`).then(r => setClientDetail(r.data)).catch(() => {});
      toast.success(`Invoice ${data.invoice_no} · ${money(data.total)}`);
    } catch (e) { toast.error(e.response?.data?.error || 'Checkout failed'); }
    setSaving(false);
  };

  if (!canCreate(M)) return <div className="p-10 text-center text-gray-400">You don't have billing access.</div>;

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2 mb-5"><FiShoppingBag className="text-blue-700" /> Billing / POS</h1>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Left — cart */}
        <div className="lg:col-span-2 space-y-3">
          <div className="bg-white rounded-xl border p-4">
            <div className="grid sm:grid-cols-3 gap-3">
              <Field label="Client (optional for walk-in)">
                <select value={clientId} onChange={e => setClientId(e.target.value)} className="inp">
                  <option value="">Walk-in (no client)</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name} {c.phone ? `· ${c.phone}` : ''}</option>)}
                </select>
              </Field>
              <Field label="Add service">
                <select value="" onChange={e => e.target.value && addService(e.target.value)} className="inp">
                  <option value="">+ Service…</option>
                  {services.map(s => <option key={s.id} value={s.id}>{s.name} · {money(s.price)}</option>)}
                </select>
              </Field>
              <Field label="Add product">
                <select value="" onChange={e => e.target.value && addProduct(e.target.value)} className="inp">
                  <option value="">+ Product…</option>
                  {products.map(p => <option key={p.id} value={p.id} disabled={p.stock_qty <= 0}>{p.name} · {money(p.price)} {p.stock_qty <= 0 ? '(out of stock)' : `· ${p.stock_qty} left`}</option>)}
                </select>
              </Field>
            </div>
            <button onClick={addCustomProduct} className="mt-2 text-xs text-gray-500 hover:text-blue-700 flex items-center gap-1"><FiPlus size={12} /> custom line (not tracked in stock)</button>
            {clientDetail && (
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <span className="bg-amber-50 text-amber-700 px-2 py-1 rounded flex items-center gap-1"><FiStar size={11} /> {clientDetail.loyalty_points} points</span>
                {membership && <span className="bg-blue-50 text-blue-800 px-2 py-1 rounded">{membership.plan_name} — {membership.discount_pct}% off</span>}
              </div>
            )}
          </div>

          <div className="bg-white rounded-xl border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                  <tr><th className="text-left px-3 py-2">Item</th><th className="text-left px-3 py-2">Stylist</th><th className="px-3 py-2 w-16">Qty</th><th className="px-3 py-2 w-24">Price</th><th className="px-3 py-2 text-right">Total</th><th></th></tr>
                </thead>
                <tbody className="divide-y">
                  {lines.map((l, i) => (
                    <tr key={i}>
                      <td className="px-3 py-2">
                        {l.item_type === 'product'
                          ? <input value={l.name} onChange={e => upd(i, 'name', e.target.value)} placeholder="Product name" className="inp !py-1" />
                          : <span className="font-medium text-gray-800">{l.name}</span>}
                      </td>
                      <td className="px-3 py-2">
                        <select value={l.stylist_id} onChange={e => upd(i, 'stylist_id', e.target.value)} className="inp !py-1">
                          <option value="">—</option>
                          {stylists.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2"><input type="number" min="1" value={l.qty} onChange={e => upd(i, 'qty', +e.target.value)} className="inp !py-1 w-16" /></td>
                      <td className="px-3 py-2"><input type="number" value={l.unit_price} onChange={e => upd(i, 'unit_price', +e.target.value)} className="inp !py-1 w-24" /></td>
                      <td className="px-3 py-2 text-right font-medium">{money((l.qty || 0) * (l.unit_price || 0))}</td>
                      <td className="px-2"><button onClick={() => rm(i)} className="text-gray-300 hover:text-red-600"><FiX /></button></td>
                    </tr>
                  ))}
                  {!lines.length && <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-400">Cart is empty — add a service or product</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right — checkout summary */}
        <div className="bg-white rounded-xl border p-4 h-fit lg:sticky lg:top-4 space-y-3">
          <h3 className="font-semibold text-gray-800">Summary</h3>
          <Line label="Subtotal" value={money(subtotal)} />
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500">Discount {memberDiscount > 0 && !manualDiscount ? '(member)' : ''}</span>
            <div className="flex items-center gap-1">₹<input type="number" value={manualDiscount || (memberDiscount || '')} onChange={e => setManualDiscount(+e.target.value)} placeholder={String(memberDiscount || 0)} className="inp !py-1 w-20 text-right" /></div>
          </div>
          {clientDetail && maxRedeem > 0 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-500">Redeem points <span className="text-gray-400">(max {maxRedeem})</span></span>
              <input type="number" min="0" max={maxRedeem} value={redeemPoints} onChange={e => setRedeemPoints(+e.target.value)} className="inp !py-1 w-20 text-right" />
            </div>
          )}
          {redeemValue > 0 && <Line label={`Points value (${redeem} pts)`} value={'− ' + money(redeemValue)} sub />}
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500">Tax %</span>
            <input type="number" value={taxPct} onChange={e => setTaxPct(+e.target.value)} className="inp !py-1 w-16 text-right" />
          </div>
          <Line label="Tax" value={money(tax)} sub />
          <div className="border-t pt-2 flex items-center justify-between">
            <span className="font-semibold text-gray-800">Total</span>
            <span className="text-xl font-bold text-blue-800">{money(total)}</span>
          </div>
          {pointsEarn > 0 && <div className="text-xs text-amber-600 flex items-center gap-1"><FiStar size={11} /> Client earns {pointsEarn} points</div>}
          <Field label="Payment mode">
            <select value={payMode} onChange={e => setPayMode(e.target.value)} className="inp">
              <option value="cash">Cash</option><option value="card">Card</option><option value="upi">UPI</option><option value="wallet">Wallet</option>
            </select>
          </Field>
          <button onClick={checkout} disabled={saving || !lines.length} className="w-full py-3 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-50 text-white font-semibold flex items-center justify-center gap-2">
            <FiCheckCircle /> {saving ? 'Processing…' : `Charge ${money(total)}`}
          </button>
        </div>
      </div>

      <Modal isOpen={!!receipt} onClose={() => setReceipt(null)} title="Payment complete">
        {receipt && (
          <div className="space-y-3 text-center">
            <FiCheckCircle className="mx-auto text-emerald-500" size={48} />
            <div className="text-lg font-bold text-gray-800">{receipt.invoice_no}</div>
            <div className="text-3xl font-bold text-blue-800">{money(receipt.total)}</div>
            <div className="text-sm text-gray-500">{receipt.client_name || 'Walk-in'} · {receipt.payMode.toUpperCase()}</div>
            <div className="text-left border rounded-lg divide-y text-sm">
              <div className="flex justify-between px-3 py-1.5"><span>Subtotal</span><span>{money(receipt.subtotal)}</span></div>
              {receipt.discount > 0 && <div className="flex justify-between px-3 py-1.5"><span>Discount</span><span>− {money(receipt.discount)}</span></div>}
              {receipt.points_redeemed > 0 && <div className="flex justify-between px-3 py-1.5"><span>Points redeemed</span><span>{receipt.points_redeemed}</span></div>}
              <div className="flex justify-between px-3 py-1.5"><span>Tax</span><span>{money(receipt.tax)}</span></div>
              {receipt.points_earned > 0 && <div className="flex justify-between px-3 py-1.5 text-amber-600"><span>Points earned</span><span>+{receipt.points_earned}</span></div>}
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={() => window.print()} className="flex-1 py-2 rounded-lg border text-sm flex items-center justify-center gap-1"><FiPrinter /> Print</button>
              <button onClick={() => setReceipt(null)} className="flex-1 py-2 rounded-lg bg-blue-700 text-white text-sm font-medium">New sale</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

const Field = ({ label, children }) => <label className="block"><span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{label}</span><div className="mt-1">{children}</div></label>;
const Line = ({ label, value, sub }) => <div className={`flex items-center justify-between ${sub ? 'text-xs text-gray-400' : 'text-sm text-gray-600'}`}><span>{label}</span><span>{value}</span></div>;
