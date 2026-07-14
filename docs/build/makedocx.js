// Build a Word .docx from the master Markdown using html-to-docx.
// html-to-docx understands a practical subset of HTML/CSS (headings, tables,
// lists, bold, code) — so we feed it clean semantic HTML, not the fancy
// gradient cover from the print HTML.
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const HTMLtoDOCX = require('html-to-docx');

const ROOT = path.resolve(__dirname, '..', '..');
const MD = path.join(ROOT, 'docs', 'ERP-COMPLETE-DOCUMENTATION.md');
const OUT = path.join(ROOT, 'docs', 'SEPL-ERP-Documentation.docx');

let md = fs.readFileSync(MD, 'utf8');
// Drop the markdown TOC block (Word builds its own navigation; the long
// anchor list doesn't link cleanly in docx) — keep everything else.
md = md.replace(/## Table of Contents[\s\S]*?\n---\n/, '');

marked.setOptions({ gfm: true, breaks: false, headerIds: false, mangle: false });
const body = marked.parse(md);

const today = new Date().toISOString().slice(0, 10);
const cover = `
  <p style="text-align:center;color:#1e3a8a;font-size:13px;letter-spacing:2px;">SECURED ENGINEERS PVT. LTD.</p>
  <h1 style="text-align:center;color:#1e3a8a;font-size:40px;margin-top:60px;">SEPL ERP</h1>
  <p style="text-align:center;font-size:18px;color:#374151;">Complete System Documentation</p>
  <p style="text-align:center;font-size:13px;color:#6b7280;">User Manual &middot; Management Overview &middot; Technical Reference</p>
  <p style="text-align:center;font-size:12px;color:#6b7280;margin-top:40px;">Generated ${today}</p>
  <br/><br/>
`;

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #1f2937; }
  h1 { color: #1e3a8a; font-size: 20pt; border-bottom: 2px solid #1e3a8a; }
  h2 { color: #172554; font-size: 15pt; }
  h3 { color: #374151; font-size: 12pt; }
  h4 { color: #4b5563; font-size: 11pt; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #cbd5e1; padding: 4px 7px; font-size: 9.5pt; }
  th { background: #1e3a8a; color: #ffffff; }
  code { font-family: Consolas, monospace; background: #f1f5f9; }
  pre { background: #0f172a; color: #e2e8f0; padding: 8px; font-size: 8.5pt; }
  blockquote { border-left: 3px solid #93c5fd; padding-left: 10px; color: #1e40af; }
</style></head><body>${cover}${body}</body></html>`;

(async () => {
  const buf = await HTMLtoDOCX(html, null, {
    table: { row: { cantSplit: true } },
    footer: true,
    pageNumber: true,
    title: 'SEPL ERP — Complete System Documentation',
    creator: 'SEPL ERP',
    orientation: 'portrait',
    margins: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
  });
  fs.writeFileSync(OUT, buf);
  console.log('Wrote', OUT, '(' + Math.round(buf.length / 1024) + ' KB)');
})().catch(e => { console.error('DOCX failed:', e); process.exit(1); });
