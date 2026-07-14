// Render docs/SEPL-ERP-Full-Guide.md → a styled, print-ready HTML (then a
// headless-Chrome step turns it into docs/SEPL-ERP-Full-Guide.pdf).
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'docs', 'SEPL-ERP-Full-Guide.md');
const OUT_HTML = path.join(__dirname, 'full-guide.html');

let md = fs.readFileSync(SRC, 'utf8');
// Drop the leading H1 (the cover shows the title).
md = md.replace(/^#\s+SEPL ERP[^\n]*\n/, '');

// GitHub-style heading slugs so the in-document TOC links resolve.
const ghSlug = (s) => String(s).toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s/g, '-');
const renderer = new marked.Renderer();
renderer.heading = (text, level, raw) => {
  const id = ghSlug(typeof raw === 'string' ? raw : text);
  return `<h${level} id="${id}">${text}</h${level}>\n`;
};
marked.setOptions({ renderer, headerIds: false, mangle: false, gfm: true, breaks: false });
const bodyHtml = marked.parse(md);

const today = new Date().toISOString().slice(0, 10);
const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>SEPL ERP — Complete Guide</title>
<style>
  :root { --brand:#1e3a8a; --brand2:#172554; --ink:#1f2937; --muted:#6b7280; --line:#e5e7eb; --accent:#b91c1c; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); font-size: 11pt; line-height: 1.5; margin: 0; }
  .page { max-width: 920px; margin: 0 auto; padding: 28px 40px; }
  .cover { min-height: 96vh; display: flex; flex-direction: column; justify-content: center;
           background: linear-gradient(160deg, var(--brand) 0%, var(--brand2) 100%); color: #fff; padding: 60px; page-break-after: always; }
  .cover .badge { font-size: 13pt; letter-spacing: 3px; text-transform: uppercase; color: #bfdbfe; }
  .cover h1 { font-size: 40pt; line-height: 1.1; margin: 18px 0 8px; font-weight: 800; border: none; }
  .cover .sub { font-size: 15pt; color: #dbeafe; max-width: 640px; }
  .cover .meta { margin-top: 48px; font-size: 11pt; color: #c7d2fe; border-top: 1px solid rgba(255,255,255,.25); padding-top: 16px; }
  .cover .meta b { color: #fff; }
  h1 { color: var(--brand); font-size: 20pt; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 3px solid var(--brand); page-break-before: always; }
  h2 { color: var(--brand2); font-size: 14pt; margin: 22px 0 8px; border-left: 4px solid var(--accent); padding-left: 10px; }
  h3 { color: #374151; font-size: 12pt; margin: 16px 0 6px; }
  h4 { color: #4b5563; font-size: 11pt; margin: 12px 0 4px; }
  p { margin: 6px 0; }
  a { color: var(--brand); text-decoration: none; }
  code { background: #f3f4f6; padding: 1px 5px; border-radius: 4px; font-size: 9.5pt; font-family: "Cascadia Code", Consolas, monospace; }
  pre { background: #0f172a; color: #e2e8f0; padding: 12px 14px; border-radius: 8px; overflow-x: auto; font-size: 9pt; line-height: 1.45; }
  pre code { background: none; color: inherit; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 9.5pt; page-break-inside: avoid; }
  th, td { border: 1px solid var(--line); padding: 5px 8px; text-align: left; vertical-align: top; }
  th { background: var(--brand); color: #fff; font-weight: 600; }
  tr:nth-child(even) td { background: #f8fafc; }
  blockquote { border-left: 4px solid #93c5fd; background: #eff6ff; margin: 10px 0; padding: 6px 14px; color: #1e40af; border-radius: 0 6px 6px 0; }
  ul, ol { margin: 6px 0; padding-left: 22px; }
  li { margin: 2px 0; }
  hr { border: none; border-top: 1px solid var(--line); margin: 20px 0; }
  @media print { .page { max-width: none; } h1 { page-break-before: always; } h2, h3, h4 { page-break-after: avoid; } }
</style></head>
<body>
  <section class="cover">
    <div class="badge">Secured Engineers Pvt. Ltd.</div>
    <h1>SEPL ERP</h1>
    <div class="sub">Complete Guide — User Manual &amp; Technical Reference (steps + technology)</div>
    <div class="meta">
      <div><b>Scope:</b> All modules · step-by-step usage · languages &amp; tech used</div>
      <div><b>Platform:</b> Web app + installable PWA (phone / laptop / desktop)</div>
      <div><b>Stack:</b> React · Node.js / Express · SQLite · Socket.IO · WebRTC</div>
      <div><b>Built by:</b> SOTYN.AI &nbsp;·&nbsp; <b>Generated:</b> ${today}</div>
    </div>
  </section>
  <main class="page">
    ${bodyHtml}
  </main>
</body></html>`;

fs.writeFileSync(OUT_HTML, html, 'utf8');
console.log('Wrote', OUT_HTML, '(' + Math.round(html.length / 1024) + ' KB)');
