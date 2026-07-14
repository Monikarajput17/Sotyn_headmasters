// Camera-based barcode / QR scanner modal.
//
// Wraps html5-qrcode. When a code is detected, calls onScan(text) with
// the decoded string and closes itself. Mam's flow: tap Scan in any
// Inventory form → camera opens → point at the item barcode → form
// auto-fills the item by matching the scanned text against item_code.
//
// Falls back gracefully when the camera permission is denied.

import { useEffect, useRef, useState } from 'react';
import { FiX, FiCamera, FiZap } from 'react-icons/fi';

export default function BarcodeScanner({ open, onClose, onScan }) {
  const [error, setError] = useState(null);
  const [scanning, setScanning] = useState(false);
  const scannerRef = useRef(null);
  const elementId = 'barcode-scanner-region';

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let scanner = null;

    (async () => {
      try {
        // Lazy-import so the page bundle stays small when scanner unused
        const mod = await import('html5-qrcode');
        const { Html5Qrcode } = mod;
        if (cancelled) return;

        scanner = new Html5Qrcode(elementId);
        scannerRef.current = scanner;

        // Try the back camera first on mobile, fall back to first available
        const devices = await Html5Qrcode.getCameras().catch(() => []);
        if (cancelled) return;
        if (!devices || devices.length === 0) {
          setError('No camera detected on this device.');
          return;
        }
        const backCam = devices.find(d => /back|rear|environment/i.test(d.label)) || devices[0];

        await scanner.start(
          backCam.id,
          { fps: 10, qrbox: { width: 260, height: 160 } },
          (decoded) => {
            if (cancelled) return;
            // Stop on first successful read
            scanner.stop().then(() => scanner.clear()).catch(() => {});
            onScan(decoded);
          },
          () => { /* per-frame failure callback — ignored */ }
        );
        setScanning(true);
        setError(null);
      } catch (e) {
        setError(e?.message || 'Could not start camera. Allow camera permission and retry.');
      }
    })();

    return () => {
      cancelled = true;
      try { if (scanner) { scanner.stop().then(() => scanner.clear()).catch(() => {}); } } catch (e) { /* ignore */ }
      scannerRef.current = null;
      setScanning(false);
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 bg-gradient-to-r from-blue-700 to-blue-800 text-white flex items-center justify-between">
          <h3 className="font-bold flex items-center gap-2"><FiCamera size={16} /> Scan Barcode / QR</h3>
          <button onClick={onClose} className="p-1 hover:bg-white/20 rounded"><FiX size={18} /></button>
        </div>
        <div className="p-3">
          {error ? (
            <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-800 flex items-start gap-2">
              <FiX className="mt-0.5 flex-shrink-0" />
              <div>
                <div className="font-semibold mb-0.5">Camera unavailable</div>
                <div className="text-xs">{error}</div>
                <div className="text-xs text-red-600 mt-2">On mobile: open browser settings → site settings → Camera → Allow.</div>
              </div>
            </div>
          ) : (
            <>
              <div id={elementId} className="w-full bg-black rounded-lg overflow-hidden" style={{ minHeight: 280 }} />
              <p className="text-xs text-gray-500 mt-2 flex items-center gap-1 justify-center">
                <FiZap size={11} className="text-amber-500" /> Point at the item's barcode or QR
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
