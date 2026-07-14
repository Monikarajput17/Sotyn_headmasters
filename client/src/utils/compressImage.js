// Client-side image compression.
//
// Mam (2026-05-21) reported: "when they enter task in delegation with
// photo erp is hang".  Root cause: modern phone photos are 5-15 MB
// and the synchronous upload on a typical Indian 4G mobile (~2 Mbps
// upload) takes 30-60s with no feedback — user assumes the app froze.
//
// We resize the image to a max 1920-px edge and re-encode as JPEG at
// 80 % quality.  A 12-MB iPhone photo lands at ~700 KB; uploads in
// 2-3 s on the same connection.  PNG transparency files are passed
// through unchanged (re-encoding to JPEG would fill the alpha with
// black).  Non-image files (PDFs, docs) are also passed through.

const MAX_EDGE = 1920;
const QUALITY  = 0.8;

export async function compressImage(file) {
  if (!file) return null;
  // Pass through PDFs / docs / anything not an image.
  if (!/^image\//.test(file.type)) return file;
  // Keep PNGs (we'd lose transparency on JPEG re-encode).
  if (file.type === 'image/png') return file;
  // Tiny images aren't worth the work.
  if (file.size < 500 * 1024) return file;

  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = dataUrl;
    });

    const { naturalWidth: w, naturalHeight: h } = img;
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    const tw = Math.round(w * scale);
    const th = Math.round(h * scale);

    const canvas = document.createElement('canvas');
    canvas.width  = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, tw, th);

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    if (!blob) return file;  // fallback to original on canvas failure

    // Only swap if compression actually helped.
    if (blob.size >= file.size) return file;

    const baseName = (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg';
    return new File([blob], baseName, { type: 'image/jpeg', lastModified: Date.now() });
  } catch (e) {
    console.warn('[compressImage] failed, uploading original:', e);
    return file;
  }
}
