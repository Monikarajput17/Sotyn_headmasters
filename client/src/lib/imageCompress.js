// WhatsApp-style image compression before upload.
//
// Phone photos are 3–8 MB at 3000–4000 px. Uploading + re-rendering them at
// full resolution is what made the chat hang, especially on mobile (mam
// 2026-06-25: "chat hangs … image quality like actual WhatsApp low quality").
// This downscales the longest side to `maxDim` and re-encodes as JPEG at
// `quality`, turning a 5 MB photo into ~100–300 KB with no visible loss at
// chat size. Non-images (PDF, audio, etc.) and animated GIFs pass through
// untouched. Any failure falls back to the original file — never blocks a send.
export async function compressImage(file, { maxDim = 1600, quality = 0.6 } = {}) {
  if (!file || !file.type || !file.type.startsWith('image/')) return file;
  if (file.type === 'image/gif') return file; // animated — canvas would flatten it

  try {
    let width, height, source, bitmap = null;
    // Fast path: createImageBitmap (handles orientation, off-main-thread decode).
    bitmap = await createImageBitmap(file).catch(() => null);
    if (bitmap) {
      width = bitmap.width; height = bitmap.height; source = bitmap;
    } else {
      // Fallback via <img> (older browsers / some HEIC).
      const url = URL.createObjectURL(file);
      try {
        source = await new Promise((res, rej) => {
          const i = new Image();
          i.onload = () => res(i); i.onerror = rej; i.src = url;
        });
      } finally { URL.revokeObjectURL(url); }
      width = source.naturalWidth; height = source.naturalHeight;
    }
    if (!width || !height) return file;

    const scale = Math.min(1, maxDim / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0, w, h);
    if (bitmap && bitmap.close) bitmap.close();

    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    // If compression didn't help (already tiny), keep the original.
    if (!blob || blob.size >= file.size) return file;

    const base = (file.name || 'photo').replace(/\.[^.]+$/, '');
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    return file; // never let compression break an upload
  }
}
