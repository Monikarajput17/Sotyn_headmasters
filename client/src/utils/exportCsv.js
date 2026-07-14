// Shared CSV download helper used by every page's "Export Excel" button.
//
// Why CSV (not .xlsx)?  Excel and Google Sheets both open CSV directly;
// the file's tiny (no zip overhead), the code path has zero external
// dependencies, and we keep one consistent pattern across the Sotyn.Headmasters.
//
// Critical: the UTF-8 BOM ('﻿') has to lead the file or Excel
// renders ₹ / non-ASCII as garbage (mam reported this previously on
// sales bills).  The charset attribute alone is not enough — Excel
// looks at the BOM first.
//
// Usage:
//   import { exportCsv } from '../utils/exportCsv';
//   exportCsv('expenses', ['Description','Amount'], [['Diesel', 500], ...]);
//
// Empty data shows a toast and bails — no zero-row download.

import toast from 'react-hot-toast';

export function exportCsv(filename, headers, rows) {
  if (!rows || rows.length === 0) {
    toast.error('No data to export');
    return;
  }
  const escape = (c) =>
    `"${(c === null || c === undefined ? '' : String(c)).replace(/"/g, '""')}"`;
  const csv = [headers, ...rows]
    .map((r) => r.map(escape).join(','))
    .join('\r\n'); // CRLF — Excel for Windows prefers it
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a tick to start the download before we revoke
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast.success(`Downloaded ${rows.length} row${rows.length === 1 ? '' : 's'}`);
}
