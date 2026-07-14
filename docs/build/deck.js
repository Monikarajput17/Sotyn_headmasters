// SEPL ERP — presentation deck (pptxgenjs)
// Royal-navy brand palette matching the live app. Dark title/closing,
// light content (sandwich). Consistent module-card template + benefit framing.
const pptxgen = require("pptxgenjs");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const fa = require("react-icons/fa");

// ---------- palette ----------
const C = {
  navy:  "0F1E47",   // deep background
  navy2: "16275C",
  blue:  "1E3A8A",   // primary brand
  blue2: "2563EB",
  ice:   "DBEAFE",
  ice2:  "EFF6FF",
  red:   "DC2626",   // sharp accent
  amber: "D97706",
  green: "059669",
  ink:   "1F2937",
  muted: "64748B",
  line:  "E2E8F0",
  white: "FFFFFF",
  light: "F8FAFC",
};
const HF = "Trebuchet MS";   // header font
const BF = "Calibri";        // body font

// ---------- icons ----------
async function icon(IconComponent, color = "#FFFFFF", size = 256) {
  const svg = ReactDOMServer.renderToStaticMarkup(
    React.createElement(IconComponent, { color, size: String(size) })
  );
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + png.toString("base64");
}
const hex = (c) => "#" + c;

(async () => {
  // Pre-render every icon we use (white + colored variants as needed)
  const I = {};
  const need = {
    users: fa.FaUsers, funnel: fa.FaFilter, file: fa.FaFileInvoiceDollar,
    truck: fa.FaTruck, hat: fa.FaHardHat, rupee: fa.FaRupeeSign,
    tie: fa.FaUserTie, boxes: fa.FaBoxes, tasks: fa.FaTasks,
    headset: fa.FaHeadset, chart: fa.FaChartLine, robot: fa.FaRobot,
    plug: fa.FaPlug, sitemap: fa.FaSitemap, shield: fa.FaShieldAlt,
    check: fa.FaCheckCircle, mobile: fa.FaMobileAlt, bolt: fa.FaBolt,
    book: fa.FaBook, layers: fa.FaLayerGroup, server: fa.FaServer,
    rocket: fa.FaRocket, clock: fa.FaClock, lock: fa.FaLock,
    sync: fa.FaSyncAlt, brain: fa.FaBrain, db: fa.FaDatabase,
    arrowUp: fa.FaArrowUp, ban: fa.FaTimesCircle, eye: fa.FaEye,
    hand: fa.FaHandshake, gear: fa.FaCogs,
  };
  for (const [k, comp] of Object.entries(need)) {
    if (!comp) throw new Error(`Icon component undefined for key "${k}" — check the react-icons name`);
    I[k]      = await icon(comp, hex(C.white));
    I[k + "_b"] = await icon(comp, hex(C.blue));
    I[k + "_r"] = await icon(comp, hex(C.red));
  }

  const pres = new pptxgen();
  pres.layout = "LAYOUT_WIDE";          // 13.33 x 7.5
  pres.author = "SEPL ERP";
  pres.title = "SEPL ERP — System Overview";
  const W = 13.33, H = 7.5;
  const shadow = () => ({ type: "outer", color: "0B1437", blur: 9, offset: 3, angle: 135, opacity: 0.18 });

  let pageNo = 0;
  const footer = (slide) => {
    pageNo++;
    slide.addText("SEPL ERP", { x: 0.55, y: H - 0.42, w: 3, h: 0.3, fontFace: BF, fontSize: 9, color: C.muted });
    slide.addText(String(pageNo), { x: W - 1.05, y: H - 0.42, w: 0.5, h: 0.3, fontFace: BF, fontSize: 9, color: C.muted, align: "right" });
  };

  // light content header (kicker + title), no underline rules
  const head = (slide, kicker, title) => {
    slide.background = { color: C.light };
    slide.addText(kicker.toUpperCase(), { x: 0.6, y: 0.45, w: 11, h: 0.3, fontFace: HF, fontSize: 12, bold: true, color: C.red, charSpacing: 2 });
    slide.addText(title, { x: 0.58, y: 0.74, w: 12.1, h: 0.8, fontFace: HF, fontSize: 30, bold: true, color: C.navy });
  };

  const iconChip = (slide, data, x, y, s, bg) => {
    slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: s, h: s, fill: { color: bg }, rectRadius: 0.08, shadow: shadow() });
    const pad = s * 0.24;
    slide.addImage({ data, x: x + pad, y: y + pad, w: s - pad * 2, h: s - pad * 2 });
  };

  // ============================================================ S1 TITLE
  {
    const s = pres.addSlide();
    s.background = { color: C.navy };
    // motif accent: thin red square cluster top-left
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: W, h: 0.16, fill: { color: C.red } });
    s.addText("SECURED ENGINEERS PVT. LTD.", { x: 0.8, y: 1.45, w: 11, h: 0.4, fontFace: HF, fontSize: 15, bold: true, color: C.ice, charSpacing: 3 });
    s.addText("SEPL ERP", { x: 0.75, y: 1.9, w: 11.8, h: 1.6, fontFace: HF, fontSize: 84, bold: true, color: C.white });
    s.addText("One system to run the entire business — sales to cash, site to salary.",
      { x: 0.8, y: 3.55, w: 10.6, h: 0.7, fontFace: BF, fontSize: 21, color: C.ice });
    // tech chips
    const chips = ["React", "Node.js", "Express", "SQLite", "PWA", "Claude AI"];
    let cx = 0.8;
    chips.forEach((t) => {
      const w = 0.55 + t.length * 0.135;
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: cx, y: 4.55, w, h: 0.5, fill: { color: C.navy2 }, line: { color: C.blue2, width: 1 }, rectRadius: 0.25 });
      s.addText(t, { x: cx, y: 4.55, w, h: 0.5, fontFace: BF, fontSize: 13, color: C.white, align: "center", valign: "middle" });
      cx += w + 0.22;
    });
    s.addText("Designed & developed in-house  ·  64+ modules  ·  end-to-end ERP platform",
      { x: 0.8, y: 5.95, w: 11.5, h: 0.4, fontFace: BF, fontSize: 14, italic: true, color: C.ice });
  }

  // ============================================================ S2 PROBLEM
  {
    const s = pres.addSlide();
    head(s, "Why we built it", "The problem we set out to solve");
    const pains = [
      [I.layers_r, "Scattered spreadsheets", "Every department kept its own Excel — numbers never matched."],
      [I.headset_r, "Approvals over WhatsApp", "Payment & purchase approvals lost in chat threads."],
      [I.ban_r, "No single source of truth", "The same client & order retyped in five places."],
      [I.eye_r, "No live view for management", "MD had to ask around for the day's real picture."],
    ];
    const cw = 5.75, ch = 1.95, gx = 0.6, gy = 0.35, x0 = 0.6, y0 = 1.75;
    pains.forEach((p, i) => {
      const x = x0 + (i % 2) * (cw + gx), y = y0 + Math.floor(i / 2) * (ch + gy);
      s.addShape(pres.shapes.RECTANGLE, { x, y, w: cw, h: ch, fill: { color: C.white }, line: { color: C.line, width: 1 }, shadow: shadow() });
      s.addShape(pres.shapes.RECTANGLE, { x, y, w: 0.1, h: ch, fill: { color: C.red } });
      iconChip(s, p[0], x + 0.32, y + 0.42, 1.0, C.ice2);
      s.addText(p[1], { x: x + 1.55, y: y + 0.36, w: cw - 1.8, h: 0.5, fontFace: HF, fontSize: 18, bold: true, color: C.navy });
      s.addText(p[2], { x: x + 1.55, y: y + 0.92, w: cw - 1.8, h: 0.9, fontFace: BF, fontSize: 14, color: C.ink });
    });
    footer(s);
  }

  // ============================================================ S3 SOLUTION
  {
    const s = pres.addSlide();
    s.background = { color: C.navy };
    s.addText("THE SOLUTION", { x: 0.8, y: 0.7, w: 11, h: 0.4, fontFace: HF, fontSize: 13, bold: true, color: C.red, charSpacing: 3 });
    s.addText("One integrated ERP — every department on the same data",
      { x: 0.78, y: 1.05, w: 11.7, h: 1.0, fontFace: HF, fontSize: 30, bold: true, color: C.white });
    const pillars = [
      [I.db, "One source of truth", "The Business Book order is the anchor — POs, DPRs, bills, receivables all link back to it."],
      [I.shield, "Role-based access", "Each person sees only their modules. Every change is audited."],
      [I.gear, "Automated workflows", "Approvals, GST, billing, backups & reminders run on their own."],
    ];
    const cw = 3.78, ch = 3.4, gx = 0.5, x0 = 0.8, y = 2.5;
    pillars.forEach((p, i) => {
      const x = x0 + i * (cw + gx);
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cw, h: ch, fill: { color: C.navy2 }, line: { color: C.blue, width: 1 }, rectRadius: 0.08, shadow: shadow() });
      iconChip(s, p[0], x + 0.4, y + 0.4, 1.1, C.blue);
      s.addText(p[1], { x: x + 0.4, y: y + 1.7, w: cw - 0.8, h: 0.5, fontFace: HF, fontSize: 19, bold: true, color: C.white });
      s.addText(p[2], { x: x + 0.4, y: y + 2.25, w: cw - 0.8, h: 1.0, fontFace: BF, fontSize: 14, color: C.ice });
    });
    footer(s);
  }

  // ============================================================ S4 BY THE NUMBERS
  {
    const s = pres.addSlide();
    s.background = { color: C.blue };
    s.addText("THE PLATFORM AT A GLANCE", { x: 0.8, y: 0.7, w: 11, h: 0.4, fontFace: HF, fontSize: 13, bold: true, color: C.ice, charSpacing: 3 });
    s.addText("Built broad, built deep", { x: 0.78, y: 1.05, w: 11, h: 0.9, fontFace: HF, fontSize: 32, bold: true, color: C.white });
    const stats = [
      ["64+", "Modules"], ["10", "Functional groups"], ["57", "API services"],
      ["150+", "Database tables"], ["12+", "Automated jobs"], ["1", "Installable PWA"],
    ];
    const cw = 3.78, ch = 1.85, gx = 0.5, gy = 0.4, x0 = 0.8, y0 = 2.35;
    stats.forEach((st, i) => {
      const x = x0 + (i % 3) * (cw + gx), y = y0 + Math.floor(i / 3) * (ch + gy);
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cw, h: ch, fill: { color: C.white }, rectRadius: 0.07, shadow: shadow() });
      s.addText(st[0], { x: x + 0.3, y: y + 0.22, w: cw - 0.6, h: 1.0, fontFace: HF, fontSize: 50, bold: true, color: C.red, align: "left" });
      s.addText(st[1], { x: x + 0.32, y: y + 1.25, w: cw - 0.6, h: 0.45, fontFace: BF, fontSize: 15, color: C.ink });
    });
    footer(s);
  }

  // ============================================================ S5 END-TO-END FLOW
  {
    const s = pres.addSlide();
    head(s, "How it fits together", "The sales-to-cash spine");
    const steps = ["Lead", "Quotation", "Order", "Procurement", "Execution\n(DPR)", "Billing", "Collections"];
    const n = steps.length, chW = 1.55, chH = 1.0, y = 2.9;
    const gap = (W - 1.1 - n * chW) / (n - 1);
    let x = 0.55;
    steps.forEach((t, i) => {
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: chW, h: chH, fill: { color: i % 2 ? C.blue : C.navy }, rectRadius: 0.08, shadow: shadow() });
      s.addText(String(i + 1), { x: x + 0.1, y: y + 0.06, w: 0.5, h: 0.35, fontFace: HF, fontSize: 14, bold: true, color: C.ice });
      s.addText(t, { x, y: y + 0.32, w: chW, h: 0.62, fontFace: HF, fontSize: 13, bold: true, color: C.white, align: "center", valign: "middle" });
      if (i < n - 1) s.addText("›", { x: x + chW, y: y + 0.1, w: gap, h: chH, fontFace: HF, fontSize: 30, bold: true, color: C.red, align: "center", valign: "middle" });
      x += chW + gap;
    });
    s.addText([
      { text: "Data flows automatically between modules. ", options: { bold: true, color: C.navy } },
      { text: "Win a lead and it becomes a Business Book order; that order then drives procurement, the site DPR, the client bills and the receivable — nothing is retyped.", options: { color: C.ink } },
    ], { x: 1.4, y: 4.6, w: 10.5, h: 1.2, fontFace: BF, fontSize: 16, align: "center" });
    footer(s);
  }

  // ============================================================ S6 MODULE MAP
  {
    const s = pres.addSlide();
    head(s, "Everything in one place", "The complete module map");
    const groups = [
      [I.users_b, "CRM", "Partners · Funnels · Business Book · Customers · Kitting"],
      [I.file_b, "Quotes & Orders", "Quotations · AI Auto-Quote · PO/FOC · Labour Rate"],
      [I.truck_b, "Procurement", "Items · RFQ · Vendors · Indent→Dispatch · Gantt"],
      [I.hat_b, "Projects", "DPR · Snags · Fire NOC · Sales Billing"],
      [I.rupee_b, "Finance", "Payables · Cheques · Collections · Cash Flow"],
      [I.tie_b, "HRMS", "Hiring · Attendance · Payroll · Performance"],
      [I.boxes_b, "Inventory", "Tools · Assets · Stock · Rentals"],
      [I.tasks_b, "Tasks & Desk", "Delegations · PMS · Checklists · Complaints"],
      [I.chart_b, "Executive", "War Room · Operating Console · TOC View"],
    ];
    const cw = 3.95, ch = 1.35, gx = 0.27, gy = 0.22, x0 = 0.6, y0 = 1.7;
    groups.forEach((g, i) => {
      const x = x0 + (i % 3) * (cw + gx), y = y0 + Math.floor(i / 3) * (ch + gy);
      s.addShape(pres.shapes.RECTANGLE, { x, y, w: cw, h: ch, fill: { color: C.white }, line: { color: C.line, width: 1 }, shadow: shadow() });
      iconChip(s, g[0], x + 0.22, y + 0.27, 0.82, C.ice2);
      s.addText(g[1], { x: x + 1.2, y: y + 0.2, w: cw - 1.35, h: 0.4, fontFace: HF, fontSize: 16, bold: true, color: C.navy });
      s.addText(g[2], { x: x + 1.2, y: y + 0.62, w: cw - 1.35, h: 0.6, fontFace: BF, fontSize: 11, color: C.muted });
    });
    footer(s);
  }

  // ============================================================ MODULE SLIDES (template)
  const moduleSlide = (kicker, title, ic, accent, tagline, cols, benefit) => {
    const s = pres.addSlide();
    head(s, kicker, title);
    // left identity panel
    iconChip(s, ic, 0.62, 1.95, 1.5, accent);
    s.addText(tagline, { x: 0.55, y: 3.7, w: 3.6, h: 2.0, fontFace: BF, fontSize: 15, color: C.ink });
    // right: two columns of feature bullets in a card
    const cardX = 4.7, cardY = 1.75, cardW = 8.05, cardH = 4.0;
    s.addShape(pres.shapes.RECTANGLE, { x: cardX, y: cardY, w: cardW, h: cardH, fill: { color: C.white }, line: { color: C.line, width: 1 }, shadow: shadow() });
    s.addShape(pres.shapes.RECTANGLE, { x: cardX, y: cardY, w: 0.1, h: cardH, fill: { color: accent } });
    const half = Math.ceil(cols.length / 2);
    const mk = (arr) => arr.map((t, i) => ({ text: t, options: { bullet: { code: "2022" }, color: C.ink, breakLine: true, paraSpaceAfter: 8 } }));
    s.addText(mk(cols.slice(0, half)), { x: cardX + 0.45, y: cardY + 0.35, w: cardW / 2 - 0.5, h: cardH - 0.7, fontFace: BF, fontSize: 14, valign: "top" });
    s.addText(mk(cols.slice(half)), { x: cardX + cardW / 2 + 0.1, y: cardY + 0.35, w: cardW / 2 - 0.5, h: cardH - 0.7, fontFace: BF, fontSize: 14, valign: "top" });
    // benefit strip
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.62, y: 6.0, w: 12.1, h: 0.85, fill: { color: C.navy }, rectRadius: 0.08 });
    s.addImage({ data: I.check, x: 0.85, y: 6.2, w: 0.45, h: 0.45 });
    s.addText([
      { text: "Benefit:  ", options: { bold: true, color: C.ice } },
      { text: benefit, options: { color: C.white } },
    ], { x: 1.45, y: 6.0, w: 11.0, h: 0.85, fontFace: BF, fontSize: 15, valign: "middle" });
    footer(s);
    return s;
  };

  moduleSlide("Module 1 of 9 · CRM", "CRM — win and book the work", I.users, C.blue,
    "From first enquiry to a booked order — the front of the whole pipeline.",
    ["Referral Partners master", "CRM Sales Funnel (staged)", "Sales Funnel with SLAs & gates",
     "Business Book (booked orders)", "Customers master", "Full Kitting readiness matrix"],
    "Clients & orders captured once, then reused everywhere — no re-typing, no mismatched numbers.");

  moduleSlide("Module 2 of 9 · Quotes & Orders", "Quotes & Orders — price it fast", I.file, C.blue2,
    "Turn a BOQ into a priced client quotation in minutes, not days.",
    ["Quotations with AI rate suggestion", "AI Auto-Quotation from BOQ upload", "PO / FOC stripped kits",
     "Item-wise labour-rate master", "Material + labour + margin = sale price", "SEPL-format quotation print"],
    "Estimation that used to take a day is auto-priced from history and master rates.");

  moduleSlide("Module 3 of 9 · Procurement", "Procurement — buy & dispatch", I.truck, C.amber,
    "The purchasing engine: Indent → Dispatch in one governed flow.",
    ["Item Master + GST slabs + Pipe kg/m", "RFQ queue & vendor rate compare", "L1 / L2 / CRM approvals",
     "Auto PO, delivery challan & sales bill", "Free-stock allocate from store", "Short-supply debit-note + alert"],
    "Every rupee bought is approved, numbered and traceable — with auto PO & challan paperwork.");

  moduleSlide("Module 4 of 9 · Projects", "Projects — execute on site", I.hat, C.red,
    "Run the job on the ground and bill it stage by stage.",
    ["Daily Progress Reports (DPR)", "Manpower plan vs actual", "Quality snags tracking",
     "Fire NOC renewal auto-pilot", "4-stage sequential Sales Billing", "Correct CGST/SGST vs IGST"],
    "Site progress, labour cost and client billing stay locked to the same project record.");

  moduleSlide("Module 5 of 9 · Finance", "Finance — control the money", I.rupee, C.green,
    "Pay vendors with discipline; collect from clients on time.",
    ["Payables: L1→L2→L3→Release chain", "Cheque FMS", "Receivables ageing & DSO",
     "Invoices / RA / MB bills", "Cash-flow & runway tracker", "Expenses register"],
    "Multi-level approvals stop leakage; ageing & runway give a real cash picture daily.");

  moduleSlide("Module 6 of 9 · HRMS", "HRMS — people & payroll", I.tie, C.blue,
    "Hire, attend, pay and rate the whole workforce.",
    ["Hiring ATS + offer/NDA e-sign", "Sub-contractor hiring tracker", "GPS-geofenced attendance",
     "Rule-based payroll & salary slips", "Employee master", "MIS performance scorecards"],
    "Attendance flows straight into payroll — fewer disputes, faster, accurate pay runs.");

  moduleSlide("Module 7 of 9 · Inventory", "Inventory & Assets", I.boxes, C.amber,
    "Know what you own and where every tool is.",
    ["Office vs site-store stock", "Moving-average valuation", "Barcode scan in/out",
     "Company assets register", "Tool issue & calibration", "Tool & room rentals"],
    "Free stock is offered at indent-approval — buy only the shortfall, not the whole list.");

  moduleSlide("Module 8 of 9 · Tasks & Service Desk", "Tasks & Service Desk", I.tasks, C.blue2,
    "Nothing falls through the cracks — internal or customer-facing.",
    ["Delegated tasks + proof & approval", "PMS project tasks", "Recurring checklists",
     "Customer complaints + OTP close", "In-app help tickets", "WhatsApp / SMS / email alerts"],
    "Accountability with proof — every task and complaint has an owner and an audit trail.");

  moduleSlide("Module 9 of 9 · Executive", "Executive dashboards", I.chart, C.navy2,
    "The MD's live picture of the business, every morning.",
    ["War Room operational view", "Operating Console (CMD)", "Theory-of-Constraints view",
     "12 KPI tiles + exception lists", "Daily 09:00 audit email", "Bearer-token audit API"],
    "Management sees the real position daily — no asking around, no stale spreadsheets.");

  // ============================================================ AUTOMATION & AI
  {
    const s = pres.addSlide();
    head(s, "Works while you sleep", "Automation & built-in AI");
    const left = [
      [I.sync_b, "Nightly DB backup", "02:00 every day, keeps last 30"],
      [I.clock_b, "Daily DPR prompt", "18:00 nudge to site engineers"],
      [I.bolt_b, "Fire NOC auto-advance", "Stages move with passing days"],
      [I.file_b, "Fortnightly auto-billing", "Installation bills on 1st & 16th"],
    ];
    let y = 1.8;
    left.forEach((a) => {
      s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y, w: 6.0, h: 1.0, fill: { color: C.white }, line: { color: C.line, width: 1 }, shadow: shadow() });
      iconChip(s, a[0], 0.78, y + 0.18, 0.64, C.ice2);
      s.addText(a[1], { x: 1.6, y: y + 0.13, w: 4.8, h: 0.4, fontFace: HF, fontSize: 15, bold: true, color: C.navy });
      s.addText(a[2], { x: 1.6, y: y + 0.52, w: 4.8, h: 0.4, fontFace: BF, fontSize: 12, color: C.muted });
      y += 1.15;
    });
    // right: AI panel
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 7.0, y: 1.8, w: 5.7, h: 4.55, fill: { color: C.navy }, rectRadius: 0.08, shadow: shadow() });
    iconChip(s, I.brain, 7.35, 2.15, 1.0, C.red);
    s.addText("“Ask ERP” — AI assistant", { x: 8.55, y: 2.25, w: 4.0, h: 0.8, fontFace: HF, fontSize: 18, bold: true, color: C.white, valign: "middle" });
    s.addText([
      { text: "Powered by Claude. Ask plain-English questions and get answers from your own data.", options: { breakLine: true, paraSpaceAfter: 10, color: C.ice } },
      { text: "Queries the live database", options: { bullet: { code: "2022" }, breakLine: true, paraSpaceAfter: 6, color: C.white } },
      { text: "Explains any module on demand", options: { bullet: { code: "2022" }, breakLine: true, paraSpaceAfter: 6, color: C.white } },
      { text: "Market-rate lookups with web search", options: { bullet: { code: "2022" }, breakLine: true, paraSpaceAfter: 6, color: C.white } },
      { text: "OCR reads uploaded bills", options: { bullet: { code: "2022" }, color: C.white } },
    ], { x: 7.35, y: 3.4, w: 5.0, h: 2.8, fontFace: BF, fontSize: 14, valign: "top" });
    footer(s);
  }

  // ============================================================ INTEGRATIONS
  {
    const s = pres.addSlide();
    head(s, "Connected to the outside world", "Integrations");
    const items = [
      [I.file_b, "Email (SMTP)", "RFQs, POs, reminders, the daily MD summary"],
      [I.headset_b, "WhatsApp & SMS", "Twilio alerts to engineers, transporters, clients"],
      [I.mobile_b, "Web Push", "Browser & phone notifications, per device"],
      [I.shield_b, "Sentry", "Live error monitoring & crash reports"],
      [I.boxes_b, "Excel & PDF", "Bulk import/export and document parsing"],
      [I.brain_b, "Claude AI", "Assistant, market rates & bill OCR"],
    ];
    const cw = 3.95, ch = 1.7, gx = 0.27, gy = 0.28, x0 = 0.6, y0 = 1.75;
    items.forEach((it, i) => {
      const x = x0 + (i % 3) * (cw + gx), y = y0 + Math.floor(i / 3) * (ch + gy);
      s.addShape(pres.shapes.RECTANGLE, { x, y, w: cw, h: ch, fill: { color: C.white }, line: { color: C.line, width: 1 }, shadow: shadow() });
      iconChip(s, it[0], x + 0.28, y + 0.3, 0.82, C.ice2);
      s.addText(it[1], { x: x + 1.25, y: y + 0.28, w: cw - 1.4, h: 0.45, fontFace: HF, fontSize: 16, bold: true, color: C.navy });
      s.addText(it[2], { x: x + 1.25, y: y + 0.72, w: cw - 1.4, h: 0.8, fontFace: BF, fontSize: 12.5, color: C.ink });
    });
    s.addText("Every integration degrades gracefully — if a key isn't set, the ERP keeps working and simply skips that channel.",
      { x: 0.6, y: 5.95, w: 12.1, h: 0.5, fontFace: BF, fontSize: 13, italic: true, color: C.muted, align: "center" });
    footer(s);
  }

  // ============================================================ ARCHITECTURE
  {
    const s = pres.addSlide();
    head(s, "Under the hood", "Architecture & tech stack");
    // simple tier diagram
    const tier = (x, w, label, sub, fill, ic) => {
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 1.9, w, h: 1.7, fill: { color: fill }, rectRadius: 0.08, shadow: shadow() });
      iconChip(s, ic, x + w / 2 - 0.45, 2.05, 0.9, C.red);
      s.addText(label, { x, y: 3.0, w, h: 0.35, fontFace: HF, fontSize: 15, bold: true, color: C.white, align: "center" });
      s.addText(sub, { x, y: 3.32, w, h: 0.25, fontFace: BF, fontSize: 11, color: C.ice, align: "center" });
    };
    tier(0.7, 3.6, "Browser / PWA", "React · Vite · Tailwind", C.blue, I.mobile);
    s.addText("⟷", { x: 4.35, y: 2.45, w: 0.7, h: 0.6, fontFace: HF, fontSize: 26, bold: true, color: C.red, align: "center" });
    tier(5.05, 3.6, "Express API", "57 route services · JWT", C.navy, I.server);
    s.addText("⟷", { x: 8.7, y: 2.45, w: 0.7, h: 0.6, fontFace: HF, fontSize: 26, bold: true, color: C.red, align: "center" });
    tier(9.4, 3.25, "SQLite", "better-sqlite3 · 150+ tables", C.green, I.db);
    s.addText("+ in-process schedulers (cron jobs) · Sentry · web-push · email/SMS — all in one PM2 Node process",
      { x: 0.7, y: 3.8, w: 11.9, h: 0.4, fontFace: BF, fontSize: 12.5, italic: true, color: C.muted, align: "center" });
    // stack table
    s.addTable([
      [{ text: "Layer", options: { bold: true, color: C.white, fill: { color: C.navy } } },
       { text: "Technology", options: { bold: true, color: C.white, fill: { color: C.navy } } },
       { text: "Layer", options: { bold: true, color: C.white, fill: { color: C.navy } } },
       { text: "Technology", options: { bold: true, color: C.white, fill: { color: C.navy } } }],
      ["Frontend", "React 18 + Vite + Tailwind", "Auth", "JWT + bcrypt"],
      ["Backend", "Node.js + Express", "Hosting", "Hostinger VPS + PM2 + Nginx"],
      ["Database", "SQLite (better-sqlite3)", "Monitoring", "Sentry + nightly backups"],
    ], { x: 0.7, y: 4.5, w: 11.95, colW: [1.6, 4.4, 1.6, 4.35], fontFace: BF, fontSize: 12.5, color: C.ink, border: { pt: 0.5, color: C.line }, rowH: 0.42, valign: "middle" });
    footer(s);
  }

  // ============================================================ SECURITY
  {
    const s = pres.addSlide();
    head(s, "Safe by design", "Security & control");
    const items = [
      [I.lock_b, "Authentication", "JWT sessions, bcrypt-hashed passwords, self-service password change."],
      [I.shield_b, "Permissions", "Per-role, per-module view/edit. New modules hidden until granted."],
      [I.eye_b, "Full audit log", "Every create / update / delete is recorded with user & time."],
      [I.sync_b, "Backups", "Automatic nightly snapshots, last 30 retained, one-click restore."],
      [I.mobile_b, "Geofenced attendance", "GPS punch with site geofence — no buddy-punching."],
      [I.server_b, "Self-hosted", "Your data stays on your VPS — no third-party SaaS lock-in."],
    ];
    const cw = 5.9, ch = 1.35, gx = 0.32, gy = 0.22, x0 = 0.6, y0 = 1.75;
    items.forEach((it, i) => {
      const x = x0 + (i % 2) * (cw + gx), y = y0 + Math.floor(i / 2) * (ch + gy);
      s.addShape(pres.shapes.RECTANGLE, { x, y, w: cw, h: ch, fill: { color: C.white }, line: { color: C.line, width: 1 }, shadow: shadow() });
      iconChip(s, it[0], x + 0.25, y + 0.27, 0.8, C.ice2);
      s.addText(it[1], { x: x + 1.2, y: y + 0.2, w: cw - 1.4, h: 0.4, fontFace: HF, fontSize: 15, bold: true, color: C.navy });
      s.addText(it[2], { x: x + 1.2, y: y + 0.6, w: cw - 1.4, h: 0.7, fontFace: BF, fontSize: 12.5, color: C.ink });
    });
    footer(s);
  }

  // ============================================================ BENEFITS
  {
    const s = pres.addSlide();
    s.background = { color: C.navy };
    s.addText("THE PAYOFF", { x: 0.8, y: 0.65, w: 11, h: 0.4, fontFace: HF, fontSize: 13, bold: true, color: C.red, charSpacing: 3 });
    s.addText("What the business gets", { x: 0.78, y: 1.0, w: 11, h: 0.9, fontFace: HF, fontSize: 32, bold: true, color: C.white });
    const bens = [
      [I.bolt, "Faster decisions", "Approvals & the MD report are instant, not chased."],
      [I.check, "Fewer errors", "GST, PO amounts & bill numbers are computed, not typed."],
      [I.eye, "Real-time visibility", "One live picture across sales, sites, cash & people."],
      [I.hand, "Accountability", "Every action is owned, approved and audited."],
      [I.mobile, "Mobile-first", "Site teams work from a phone; installable PWA."],
      [I.rupee, "Lower cost", "Self-hosted, no per-seat licence fees."],
    ];
    const cw = 3.78, ch = 1.7, gx = 0.5, gy = 0.35, x0 = 0.8, y0 = 2.25;
    bens.forEach((b, i) => {
      const x = x0 + (i % 3) * (cw + gx), y = y0 + Math.floor(i / 3) * (ch + gy);
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cw, h: ch, fill: { color: C.navy2 }, line: { color: C.blue, width: 1 }, rectRadius: 0.08, shadow: shadow() });
      iconChip(s, b[0], x + 0.3, y + 0.32, 0.78, C.blue);
      s.addText(b[1], { x: x + 1.25, y: y + 0.28, w: cw - 1.4, h: 0.45, fontFace: HF, fontSize: 16, bold: true, color: C.white });
      s.addText(b[2], { x: x + 1.25, y: y + 0.72, w: cw - 1.4, h: 0.85, fontFace: BF, fontSize: 12.5, color: C.ice });
    });
    footer(s);
  }

  // ============================================================ ROADMAP / MOBILE
  {
    const s = pres.addSlide();
    head(s, "Where it goes next", "Mobile today · roadmap ahead");
    // mobile panel
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.6, y: 1.8, w: 5.6, h: 4.4, fill: { color: C.blue }, rectRadius: 0.08, shadow: shadow() });
    iconChip(s, I.mobile, 0.95, 2.15, 1.0, C.navy);
    s.addText("Already mobile", { x: 2.15, y: 2.25, w: 3.8, h: 0.8, fontFace: HF, fontSize: 19, bold: true, color: C.white, valign: "middle" });
    s.addText([
      { text: "Installs as an app on any phone or laptop", options: { bullet: { code: "2022" }, breakLine: true, paraSpaceAfter: 8, color: C.white } },
      { text: "GPS attendance & live location pings", options: { bullet: { code: "2022" }, breakLine: true, paraSpaceAfter: 8, color: C.white } },
      { text: "Push notifications per device", options: { bullet: { code: "2022" }, breakLine: true, paraSpaceAfter: 8, color: C.white } },
      { text: "Works on 4G for site engineers", options: { bullet: { code: "2022" }, color: C.white } },
    ], { x: 0.95, y: 3.45, w: 5.0, h: 2.6, fontFace: BF, fontSize: 14, valign: "top" });
    // roadmap
    s.addShape(pres.shapes.RECTANGLE, { x: 6.7, y: 1.8, w: 6.0, h: 4.4, fill: { color: C.white }, line: { color: C.line, width: 1 }, shadow: shadow() });
    s.addShape(pres.shapes.RECTANGLE, { x: 6.7, y: 1.8, w: 0.1, h: 4.4, fill: { color: C.red } });
    s.addText("On the roadmap", { x: 7.0, y: 2.0, w: 5.4, h: 0.5, fontFace: HF, fontSize: 19, bold: true, color: C.navy });
    s.addText([
      { text: "Auto-RFQ to mapped vendors", options: { bullet: { code: "2022" }, breakLine: true, paraSpaceAfter: 9, color: C.ink } },
      { text: "Auto-rank lowest vendor & email PO", options: { bullet: { code: "2022" }, breakLine: true, paraSpaceAfter: 9, color: C.ink } },
      { text: "OCR auto-book of purchase bills", options: { bullet: { code: "2022" }, breakLine: true, paraSpaceAfter: 9, color: C.ink } },
      { text: "Auto stock-reorder indents", options: { bullet: { code: "2022" }, breakLine: true, paraSpaceAfter: 9, color: C.ink } },
      { text: "Client payment reminders & DSO push", options: { bullet: { code: "2022" }, breakLine: true, paraSpaceAfter: 9, color: C.ink } },
      { text: "Payment-gateway auto-pay (below threshold)", options: { bullet: { code: "2022" }, color: C.ink } },
    ], { x: 7.0, y: 2.65, w: 5.4, h: 3.4, fontFace: BF, fontSize: 14, valign: "top" });
    footer(s);
  }

  // ============================================================ CLOSING
  {
    const s = pres.addSlide();
    s.background = { color: C.navy };
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: H - 0.16, w: W, h: 0.16, fill: { color: C.red } });
    s.addText("SEPL ERP", { x: 0.8, y: 2.2, w: 11.7, h: 1.3, fontFace: HF, fontSize: 64, bold: true, color: C.white });
    s.addText("Built to run today's business — and scale into tomorrow's.",
      { x: 0.82, y: 3.5, w: 11, h: 0.6, fontFace: BF, fontSize: 21, color: C.ice });
    s.addText([
      { text: "Thank you", options: { bold: true, color: C.white, breakLine: true, paraSpaceAfter: 6 } },
      { text: "dme@securedengineers.com  ·  Secured Engineers Pvt. Ltd.", options: { color: C.ice } },
    ], { x: 0.82, y: 4.5, w: 11, h: 1.0, fontFace: BF, fontSize: 16 });
  }

  await pres.writeFile({ fileName: "C:/Users/admin/Desktop/business-erp/docs/SEPL-ERP-Presentation.pptx" });
  console.log("Wrote SEPL-ERP-Presentation.pptx ·", pageNo + 3, "slides");
})().catch(e => { console.error(e); process.exit(1); });
