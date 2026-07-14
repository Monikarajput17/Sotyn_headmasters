import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';

const fmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

// Printable PDF sheet for one approved PO/FOC entry (mam 2026-06-09).
export default function PoFocPrint() {
  const { id } = useParams();
  const [e, setE] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get(`/quotations/po-foc/${id}`).then(r => setE(r.data)).catch(() => setErr('Could not load this PO/FOC item.'));
  }, [id]);

  if (err) return <div style={{ padding: 40 }}>{err}</div>;
  if (!e) return <div style={{ padding: 40 }}>Loading…</div>;

  const poAmt = (Number(e.po_rate) || 0) * (Number(e.qty) || 0);
  const focAmt = (e.focs || []).reduce((t, f) => t + (Number(f.rate) || 0) * (Number(f.qty) || 0), 0);

  return (
    <div style={{ background: '#fff', minHeight: '100vh' }}>
      <style>{`@media print { .no-print { display:none } } body { font-family: Arial, sans-serif; }`}</style>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '28px 32px', color: '#222' }}>
        {/* Header */}
        <div style={{ textAlign: 'center', borderBottom: '2px solid #1e3a8a', paddingBottom: 10, marginBottom: 16 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#1e3a8a' }}>SECURED ENGINEERS PVT. LTD.</div>
          <div style={{ fontSize: 11, color: '#555' }}>H.O: 2480/1, B.K. Towers, Janta Nagar, Gill Road, Ludhiana · www.securedengineers.com</div>
          <div style={{ fontSize: 15, fontWeight: 600, marginTop: 6, letterSpacing: 1 }}>PO / FOC SHEET</div>
        </div>

        <table style={{ width: '100%', fontSize: 13, marginBottom: 14 }}>
          <tbody>
            <tr><td style={{ padding: '3px 0', color: '#666', width: 120 }}>PO Item</td><td style={{ fontWeight: 600 }}>{e.po_name}</td>
              <td style={{ padding: '3px 0', color: '#666', width: 80 }}>Status</td><td style={{ fontWeight: 600, textTransform: 'uppercase' }}>{String(e.status).replace('_', '-')}</td></tr>
            <tr><td style={{ color: '#666' }}>Quantity</td><td>{e.qty}</td><td style={{ color: '#666' }}>PO Rate</td><td>₹{fmt(e.po_rate)}</td></tr>
            <tr><td style={{ color: '#666' }}>Margin</td><td>{e.margin}%</td><td style={{ color: '#666' }}>Labour</td><td>₹{fmt(e.labour)}</td></tr>
          </tbody>
        </table>

        {/* FOC items */}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 14 }}>
          <thead>
            <tr style={{ background: '#f1f5f9' }}>
              <th style={{ border: '1px solid #cbd5e1', padding: 6, textAlign: 'left' }}>#</th>
              <th style={{ border: '1px solid #cbd5e1', padding: 6, textAlign: 'left' }}>FOC Item</th>
              <th style={{ border: '1px solid #cbd5e1', padding: 6, textAlign: 'right' }}>Qty</th>
              <th style={{ border: '1px solid #cbd5e1', padding: 6, textAlign: 'right' }}>Rate ₹</th>
              <th style={{ border: '1px solid #cbd5e1', padding: 6, textAlign: 'right' }}>Amount ₹</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ border: '1px solid #e2e8f0', padding: 6 }}>—</td>
              <td style={{ border: '1px solid #e2e8f0', padding: 6, fontWeight: 600 }}>{e.po_name} (PO)</td>
              <td style={{ border: '1px solid #e2e8f0', padding: 6, textAlign: 'right' }}>{e.qty}</td>
              <td style={{ border: '1px solid #e2e8f0', padding: 6, textAlign: 'right' }}>{fmt(e.po_rate)}</td>
              <td style={{ border: '1px solid #e2e8f0', padding: 6, textAlign: 'right' }}>{fmt(poAmt)}</td>
            </tr>
            {(e.focs || []).map((f, i) => (
              <tr key={i}>
                <td style={{ border: '1px solid #e2e8f0', padding: 6 }}>{i + 1}</td>
                <td style={{ border: '1px solid #e2e8f0', padding: 6 }}>{f.name}</td>
                <td style={{ border: '1px solid #e2e8f0', padding: 6, textAlign: 'right' }}>{f.qty}</td>
                <td style={{ border: '1px solid #e2e8f0', padding: 6, textAlign: 'right' }}>{fmt(f.rate)}</td>
                <td style={{ border: '1px solid #e2e8f0', padding: 6, textAlign: 'right' }}>{fmt((Number(f.rate) || 0) * (Number(f.qty) || 0))}</td>
              </tr>
            ))}
            {e.labour > 0 && (
              <tr>
                <td style={{ border: '1px solid #e2e8f0', padding: 6 }} colSpan={4}>Labour: {e.labour_name || '—'} (₹{fmt(e.labour)}/unit × {e.qty}, +{e.labour_margin}% margin)</td>
                <td style={{ border: '1px solid #e2e8f0', padding: 6, textAlign: 'right' }}>{fmt((Number(e.labour) || 0) * (Number(e.qty) || 0))}</td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4} style={{ border: '1px solid #cbd5e1', padding: 6, textAlign: 'right', fontWeight: 600 }}>Cost (PO + FOC + Labour)</td>
              <td style={{ border: '1px solid #cbd5e1', padding: 6, textAlign: 'right', fontWeight: 600 }}>{fmt(e.cost)}</td>
            </tr>
            <tr style={{ background: '#ecfdf5' }}>
              <td colSpan={4} style={{ border: '1px solid #cbd5e1', padding: 6, textAlign: 'right', fontWeight: 700 }}>TPA (PO+FOC @ {e.margin}%, Labour @ {e.labour_margin}%)</td>
              <td style={{ border: '1px solid #cbd5e1', padding: 6, textAlign: 'right', fontWeight: 700, color: '#047857' }}>₹{fmt(e.tpa)}</td>
            </tr>
          </tfoot>
        </table>

        <div style={{ fontSize: 11, color: '#888', marginTop: 10 }}>FOC supply amount: ₹{fmt(focAmt)} · Generated from Price Breakup Master.</div>

        <div className="no-print" style={{ marginTop: 20, textAlign: 'center' }}>
          <button onClick={() => window.print()} style={{ background: '#1e3a8a', color: '#fff', border: 'none', padding: '8px 22px', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>🖨 Print / Save as PDF</button>
        </div>
      </div>
    </div>
  );
}
