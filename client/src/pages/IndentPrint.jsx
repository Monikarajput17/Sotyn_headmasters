// Print-friendly indent BoQ page. Mam's Procurement page has an
// expanded indent row with N items — this is the same data formatted
// for A4 printing / Save-as-PDF.

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';

const COMPANY = {
  name: 'SECURED ENGINEERS PVT. LTD.',
  head: 'B.K Towers, Janta Nagar, Gill Road, Ludhiana, (PB) 141003',
  corp: '58/A/1, First Floor, Kalu Sarai, New Delhi - 110016',
  email: 'Sales@securedengineers.com',
  website: 'www.securedengineers.com',
};

export default function IndentPrint() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get(`/procurement/indents/${id}/print`)
      .then(r => setData(r.data))
      .catch(err => setError(err.response?.data?.error || 'Failed to load'));
  }, [id]);

  if (error) return <div className="p-8 text-red-600">{error}</div>;
  if (!data) return <div className="p-8 text-gray-400">Loading…</div>;

  const i = data.indent;
  const items = data.items || [];

  const fmtDate = (d) => {
    if (!d) return '—';
    const dt = new Date(d);
    return isNaN(dt) ? d : `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
  };

  return (
    <div className="bg-white min-h-screen">
      <style>{`
        @media print {
          @page { size: A4 landscape; margin: 8mm; }
          body { margin: 0; }
          .no-print { display: none !important; }
          .indent-page { box-shadow: none !important; margin: 0 !important; }
          tr { page-break-inside: avoid; }
        }
        @media screen { body { background: #f3f4f6; } }
        .indent-page {
          max-width: 280mm;
          margin: 16px auto;
          background: white;
          box-shadow: 0 4px 20px rgba(0,0,0,0.1);
          padding: 0;
          font-family: 'Times New Roman', Times, serif;
          color: #111;
        }
        .header {
          display: flex;
          align-items: center;
          padding: 14px 24px 10px;
          border-bottom: 3px solid #c00;
          background: linear-gradient(to right, #fff 60%, #fef2f2);
        }
        .logo {
          width: 80px; height: 60px; flex-shrink: 0;
          background: white; border: 2px solid #c00;
          border-radius: 6px;
          display: flex; align-items: center; justify-content: center;
          font-weight: bold; color: #c00; font-size: 20px;
        }
        .name { flex: 1; padding-left: 14px; }
        .name h1 { font-size: 22px; font-weight: bold; color: #c00; margin: 0; letter-spacing: 0.5px; }
        .name p { font-size: 10px; color: #c00; margin: 2px 0 0; }
        .title-bar {
          background: #c00; color: white;
          padding: 6px 16px; font-weight: bold; font-size: 14px;
          letter-spacing: 1px; text-align: center;
        }
        .meta {
          display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;
          padding: 10px 16px; font-size: 11px; border-bottom: 1px solid #ddd;
        }
        .meta div { background: #fef2f2; padding: 6px 10px; border-radius: 4px; }
        .meta .label { font-size: 9px; color: #888; text-transform: uppercase; }
        .meta .val { font-weight: bold; color: #111; }
        table.items {
          width: calc(100% - 32px);
          margin: 12px 16px;
          border-collapse: collapse;
          font-size: 11px;
        }
        table.items th {
          background: #c00; color: white;
          padding: 6px 8px;
          font-size: 11px;
          text-align: left;
          border: 1px solid #a00;
        }
        table.items td {
          padding: 5px 8px;
          border: 1px solid #ddd;
          vertical-align: top;
        }
        table.items tr:nth-child(even) td { background: #fafafa; }
        .footer {
          margin: 16px;
          padding-top: 8px;
          border-top: 2px dashed #ddd;
          display: flex;
          justify-content: space-between;
          font-size: 10px;
          color: #666;
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
        .toolbar button.secondary { background: #6b7280; }
      `}</style>

      <div className="toolbar no-print">
        <button onClick={() => window.print()}>Print / Save PDF</button>
        <button className="secondary" onClick={() => window.close()}>Close</button>
      </div>

      <div className="indent-page">
        {/* Header */}
        <div className="header">
          <div className="logo">SE</div>
          <div className="name">
            <h1>{COMPANY.name}</h1>
            <p><strong>Head Office:</strong> {COMPANY.head}</p>
            <p><strong>Corporate Office:</strong> {COMPANY.corp}</p>
          </div>
        </div>

        <div className="title-bar">INDENT — BoQ ITEMS</div>

        {/* Meta strip */}
        <div className="meta">
          <div><div className="label">Indent No</div><div className="val">{i.indent_number}</div></div>
          <div><div className="label">Date</div><div className="val">{fmtDate(i.indent_date || i.created_at)}</div></div>
          <div><div className="label">Site</div><div className="val">{i.site_name || i.client_name || '—'}</div></div>
          <div><div className="label">Status</div><div className="val">{(i.status || '').toUpperCase()}</div></div>
          <div><div className="label">Raised By</div><div className="val">{i.raised_by_name || i.created_by_name || '—'}</div></div>
          <div><div className="label">Location</div><div className="val">{i.location || '—'}</div></div>
          <div><div className="label">Lead No</div><div className="val">{i.lead_no || '—'}</div></div>
          <div><div className="label">Total Items</div><div className="val">{items.length}</div></div>
        </div>

        {/* Items table */}
        <table className="items">
          <thead>
            <tr>
              <th style={{ width: '4%' }}>#</th>
              <th style={{ width: '38%' }}>BoQ Description</th>
              <th style={{ width: '22%' }}>Sub-Item (Item Master)</th>
              <th style={{ width: '12%' }}>Make</th>
              <th style={{ width: '8%' }} className="text-right">Qty</th>
              <th style={{ width: '6%' }}>Unit</th>
              <th style={{ width: '10%' }}>Type</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => (
              <tr key={it.id}>
                <td>{idx + 1}</td>
                <td>{it.boq_description || it.description}</td>
                <td>
                  {it.item_code && <div style={{ fontSize: 9, color: '#888' }}>[{it.item_code}]</div>}
                  <div style={{ fontWeight: 'bold' }}>{it.master_name || '—'}</div>
                  {(it.master_size || it.master_uom) && (
                    <div style={{ fontSize: 10, color: '#666' }}>
                      {it.master_size}{it.master_uom ? ` / ${it.master_uom}` : ''}
                    </div>
                  )}
                </td>
                <td>{it.make || '—'}</td>
                <td style={{ textAlign: 'right', fontWeight: 'bold' }}>{it.quantity}</td>
                <td>{it.unit}</td>
                <td>{it.item_type || '—'}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan="7" style={{ textAlign: 'center', padding: '24px', color: '#999' }}>No items in this indent</td></tr>
            )}
          </tbody>
        </table>

        {/* Footer */}
        <div className="footer">
          <div>
            Generated from Sotyn.Headmasters · {new Date().toLocaleString('en-IN')}
          </div>
          <div>
            {COMPANY.email} · {COMPANY.website}
          </div>
        </div>
      </div>
    </div>
  );
}
