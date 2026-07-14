// Assemble the SEPL ERP documentation from docs/sections/*.md into:
//   1. docs/ERP-COMPLETE-DOCUMENTATION.md  (master Markdown, with TOC)
//   2. docs/build/erp-documentation.html   (styled, print-ready HTML)
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const ROOT = path.resolve(__dirname, '..', '..');
const SECTIONS = path.join(ROOT, 'docs', 'sections');
const OUT_MD = path.join(ROOT, 'docs', 'ERP-COMPLETE-DOCUMENTATION.md');
const OUT_HTML = path.join(__dirname, 'erp-documentation.html');

const order = [
  '00-overview.md', '01-getting-started.md', '02-crm.md', '03-quotes-orders.md',
  '04-procurement.md', '05-projects.md', '06-finance.md', '07-hrms.md',
  '08-inventory.md', '09-tasks-service.md', '10-dashboards.md',
  '11-admin-settings.md', '12-automations-integrations.md', '13-technical.md',
];

const slug = (s) => s.toLowerCase().trim()
  .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');

// Read + combine
let combined = '';
for (const f of order) {
  const p = path.join(SECTIONS, f);
  if (!fs.existsSync(p)) { console.warn('MISSING', f); continue; }
  combined += fs.readFileSync(p, 'utf8').trim() + '\n\n';
}

// ---- Build a Table of Contents from H1 (#) and H2 (##) headings ----
const lines = combined.split('\n');
const toc = [];
let inCode = false;
for (const line of lines) {
  if (/^```/.test(line)) { inCode = !inCode; continue; }
  if (inCode) continue;
  const h1 = /^#\s+(.*)$/.exec(line);
  const h2 = /^##\s+(.*)$/.exec(line);
  if (h1) toc.push({ level: 1, text: h1[1].trim() });
  else if (h2) toc.push({ level: 2, text: h2[1].trim() });
}
// Skip the very first H1 (document title) in the TOC
const titleText = (toc[0] && toc[0].level === 1) ? toc.shift().text : 'SEPL ERP Documentation';

// ---- Master Markdown: insert a TOC after the title block ----
const mdToc = ['## Table of Contents', ''];
for (const t of toc) {
  const indent = t.level === 2 ? '    ' : '';
  mdToc.push(`${indent}- [${t.text}](#${slug(t.text)})`);
}
mdToc.push('', '---', '');

// Inject TOC right before the first "# 1." section heading
const firstSecIdx = combined.indexOf('\n# 1.');
let masterMd;
if (firstSecIdx !== -1) {
  masterMd = combined.slice(0, firstSecIdx + 1) + mdToc.join('\n') + combined.slice(firstSecIdx + 1);
} else {
  masterMd = mdToc.join('\n') + combined;
}
fs.writeFileSync(OUT_MD, masterMd, 'utf8');
console.log('Wrote', OUT_MD, '(' + masterMd.split('\n').length + ' lines)');

// ---- HTML render ----
// Custom renderer: add slug ids to headings so the TOC links resolve.
const renderer = new marked.Renderer();
const baseHeading = renderer.heading.bind(renderer);
renderer.heading = (text, level, raw) => {
  const id = slug(typeof raw === 'string' ? raw : text);
  return `<h${level} id="${id}">${text}</h${level}>\n`;
};
marked.setOptions({ renderer, headerIds: false, mangle: false, gfm: true, breaks: false });

const bodyHtml = marked.parse(combined.replace(/^#\s+SEPL ERP[^\n]*\n/, '')); // drop dup title (cover has it)

const tocHtml = toc.map(t =>
  `<li class="toc-l${t.level}"><a href="#${slug(t.text)}">${t.text.replace(/&/g, '&amp;')}</a></li>`
).join('\n');

const today = new Date().toISOString().slice(0, 10);

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>${titleText}</title>
<style>
  :root { --brand:#1e3a8a; --brand2:#172554; --ink:#1f2937; --muted:#6b7280; --line:#e5e7eb; --accent:#b91c1c; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink);
         font-size: 11pt; line-height: 1.5; margin: 0; }
  .page { max-width: 920px; margin: 0 auto; padding: 28px 40px; }
  /* Cover */
  .cover { min-height: 96vh; display: flex; flex-direction: column; justify-content: center;
           background: linear-gradient(160deg, var(--brand) 0%, var(--brand2) 100%); color: #fff;
           padding: 60px; page-break-after: always; }
  .cover .badge { font-size: 13pt; letter-spacing: 3px; text-transform: uppercase; color: #bfdbfe; }
  .cover h1 { font-size: 40pt; line-height: 1.1; margin: 18px 0 8px; font-weight: 800; }
  .cover .sub { font-size: 16pt; color: #dbeafe; max-width: 640px; }
  .cover .meta { margin-top: 48px; font-size: 11pt; color: #c7d2fe; border-top: 1px solid rgba(255,255,255,.25); padding-top: 16px; }
  .cover .meta b { color: #fff; }
  /* TOC */
  .toc { page-break-after: always; }
  .toc h2 { color: var(--brand); border-bottom: 3px solid var(--brand); padding-bottom: 6px; }
  .toc ul { list-style: none; padding-left: 0; }
  .toc li { margin: 2px 0; }
  .toc a { text-decoration: none; color: var(--ink); }
  .toc a:hover { color: var(--accent); }
  .toc-l1 { font-weight: 700; margin-top: 10px !important; font-size: 11.5pt; }
  .toc-l2 { padding-left: 22px; font-size: 10pt; color: #374151; }
  /* Content */
  h1 { color: var(--brand); font-size: 22pt; margin: 0 0 12px; padding-bottom: 8px;
       border-bottom: 3px solid var(--brand); page-break-before: always; }
  h2 { color: var(--brand2); font-size: 15pt; margin: 22px 0 8px; border-left: 4px solid var(--accent);
       padding-left: 10px; }
  h3 { color: #374151; font-size: 12.5pt; margin: 16px 0 6px; }
  h4 { color: #4b5563; font-size: 11pt; margin: 12px 0 4px; text-transform: uppercase; letter-spacing: .5px; }
  p { margin: 6px 0; }
  a { color: var(--brand); }
  code { background: #f3f4f6; padding: 1px 5px; border-radius: 4px; font-size: 9.5pt;
         font-family: "Cascadia Code", Consolas, monospace; }
  pre { background: #0f172a; color: #e2e8f0; padding: 12px 14px; border-radius: 8px; overflow-x: auto;
        font-size: 9pt; line-height: 1.45; }
  pre code { background: none; color: inherit; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 9.5pt; page-break-inside: avoid; }
  th, td { border: 1px solid var(--line); padding: 5px 8px; text-align: left; vertical-align: top; }
  th { background: var(--brand); color: #fff; font-weight: 600; }
  tr:nth-child(even) td { background: #f8fafc; }
  blockquote { border-left: 4px solid #93c5fd; background: #eff6ff; margin: 10px 0; padding: 6px 14px;
               color: #1e40af; border-radius: 0 6px 6px 0; }
  ul, ol { margin: 6px 0; padding-left: 22px; }
  li { margin: 2px 0; }
  hr { border: none; border-top: 1px solid var(--line); margin: 20px 0; }
  @media print {
    .page { max-width: none; }
    h1 { page-break-before: always; }
    h2, h3, h4 { page-break-after: avoid; }
  }
</style></head>
<body>
  <section class="cover">
    <div class="badge">Secured Engineers Pvt. Ltd.</div>
    <h1>SEPL ERP</h1>
    <div class="sub">Complete System Documentation — User Manual, Management Overview &amp; Technical Reference</div>
    <div class="meta">
      <div><b>Scope:</b> All modules · all screens · all automations</div>
      <div><b>Platform:</b> Web application + installable PWA (phone / laptop / desktop)</div>
      <div><b>Stack:</b> React · Node.js / Express · SQLite</div>
      <div><b>Generated:</b> ${today}</div>
    </div>
  </section>
  <nav class="toc page">
    <h2>Table of Contents</h2>
    <ul>${tocHtml}</ul>
  </nav>
  <main class="page">
    ${bodyHtml}
  </main>
</body></html>`;

fs.writeFileSync(OUT_HTML, html, 'utf8');
console.log('Wrote', OUT_HTML, '(' + Math.round(html.length / 1024) + ' KB)');
