// Solar lead-qualification call script — designed so a sales coordinator runs it
// on the phone and sounds like a solar engineer. Each question carries a `hint`
// (what the engineer is really probing for) shown to the coordinator, not the
// client. Answers feed `recommend()` which proposes a system + size, then the
// lead is "ready for quotation".

export const QUAL_SECTIONS = [
  {
    title: '1 · Requirement & intent',
    questions: [
      { key: 'decision_maker', label: 'Are you the decision-maker for this investment?', type: 'select', options: ['Yes', 'No — influencer', 'Family/Board decision'], hint: 'Qualify authority early — saves chasing the wrong person.' },
      { key: 'property_type', label: 'What kind of premises is this for?', type: 'select', options: ['Residential', 'Commercial', 'Industrial', 'Institutional', 'Agricultural'], hint: 'Drives tariff category, GST/ITC, subsidy eligibility & structure type.' },
      { key: 'motivation', label: 'What outcome matters most to you from solar?', type: 'select', options: ['Cut electricity bill', 'Backup during power cuts', 'Subsidy benefit', 'Green / CSR image', 'ROI / investment'], hint: 'Backup → hybrid+battery; bill/ROI → on-grid; CSR → premium makes.' },
      { key: 'ownership', label: 'Do you own the premises or is it rented?', type: 'select', options: ['Owned', 'Rented', 'Leased (long term)'], hint: 'Rented shortens usable payback — flag lease tenure.' },
      { key: 'timeline', label: 'When are you looking to install?', type: 'select', options: ['Immediate', '1–3 months', '3–6 months', 'Just exploring'], hint: 'Immediate + decision-maker = hot lead.' },
    ],
  },
  {
    title: '2 · Electricity & load (the engineer’s core)',
    questions: [
      { key: 'monthly_bill', label: 'Average monthly electricity bill (₹)?', type: 'number', hint: 'Sanity-check against units; ROI anchor.' },
      { key: 'monthly_units', label: 'Roughly how many units (kWh) per month? — it’s on your bill', type: 'number', hint: 'THE sizing driver. kWp ≈ units ÷ 108 (4.5 sun-hrs, PR 0.8).' },
      { key: 'connection', label: 'Is it an LT or HT connection?', type: 'select', options: ['LT (Low Tension)', 'HT (High Tension)', 'Not sure'], hint: 'HT → CEIG approval, transformer, different metering.' },
      { key: 'sanctioned_load', label: 'Sanctioned load / contract demand (kW or kVA)?', type: 'number', hint: 'DISCOMs cap solar at ~the sanctioned load — sizing ceiling.' },
      { key: 'phase', label: 'Single phase or three phase supply?', type: 'select', options: ['Single phase', 'Three phase'], hint: '>10 kW needs 3-phase.' },
      { key: 'tariff', label: 'What rate are you paying per unit (₹)?', type: 'number', hint: 'Higher tariff = faster payback = easier close.' },
      { key: 'discom', label: 'Which electricity board / DISCOM?', type: 'text', hint: 'Net-metering rules & approval timelines vary by DISCOM.' },
      { key: 'load_profile', label: 'Is consumption mostly daytime or night?', type: 'select', options: ['Mostly daytime', 'Mostly night', 'Both / 24×7'], hint: 'Daytime favours on-grid; night/24×7 needs battery or net-metering bank.' },
      { key: 'power_cuts', label: 'How often do you face power cuts?', type: 'select', options: ['Frequent (daily)', 'Occasional', 'Rare / none'], hint: 'Frequent → hybrid + battery; sell backup value.' },
      { key: 'dg_backup', label: 'Do you run a DG/genset for backup today?', type: 'select', options: ['Yes', 'No'], hint: 'Solar offsets costly diesel — strong ROI angle.' },
      { key: 'future_load', label: 'Any load/machinery expansion in 1–2 years?', type: 'select', options: ['Yes, expanding', 'No', 'Not sure'], hint: 'Size structure/inverter headroom now.' },
    ],
  },
  {
    title: '3 · Site & roof (feeds sizing + Google Earth)',
    questions: [
      { key: 'roof_type', label: 'What surface will the panels go on?', type: 'select', options: ['RCC roof', 'Metal / tin sheet', 'Ground mount', 'Car park / shed', 'Open land'], hint: 'Drives structure cost & area density.' },
      { key: 'area_sqft', label: 'Shadow-free area available (sq ft)?', type: 'number', hint: '≈100 sq ft per kW rooftop, ~130 ground. Caps the system size.' },
      { key: 'roof_age', label: 'How old is the roof?', type: 'select', options: ['New (<5 yr)', '5–15 yr', 'Old (>15 yr)', 'NA / ground'], hint: 'Old RCC → waterproofing + load check before mounting.' },
      { key: 'shading', label: 'Any shading — buildings, trees, towers, tanks?', type: 'select', options: ['No shading', 'Partial', 'Significant'], hint: 'Shading kills generation — may need optimisers / re-layout.' },
      { key: 'blocks', label: 'Single roof or spread over multiple sheds?', type: 'select', options: ['Single roof', 'Multiple roofs / sheds'], hint: 'Multiple roofs → more cabling, possibly multiple inverters.' },
    ],
  },
  {
    title: '4 · Commercial & financing',
    questions: [
      { key: 'net_metering', label: 'Export surplus to grid (net-metering), or self-consume only?', type: 'select', options: ['Net-metering (export)', 'Captive / zero-export', 'Not sure'], hint: 'Captive → zero-export controller; net-metering → DISCOM application.' },
      { key: 'subsidy', label: 'Interested in PM Surya Ghar subsidy? (residential only)', type: 'select', options: ['Interested', 'Not eligible (C&I)', 'NA'], hint: 'Only domestic ≤10 kW; sets expectations early.' },
      { key: 'financing', label: 'How are you planning to fund it?', type: 'select', options: ['Self-funded', 'Bank loan', 'EMI', 'RESCO / OPEX (zero investment)'], hint: 'OPEX/RESCO changes the whole commercial model.' },
      { key: 'budget', label: 'Any budget range in mind? (optional, ₹)', type: 'number', hint: 'Anchors the quote; flag if unrealistic for the load.' },
      { key: 'competing', label: 'Evaluating other vendors too?', type: 'select', options: ['Yes, comparing', 'No, only us'], hint: 'Comparing → lead with engineering credibility + makes.' },
      { key: 'preferred_make', label: 'Any preferred panel/inverter brands?', type: 'text', hint: 'Tier-1 ask → quote premium variant; map to Material Master makes.' },
    ],
  },
];

const sel = (v) => String(v || '');

// Propose a system from the answers — the bridge from "qualified" to "quote".
export function recommend(a = {}) {
  const units = Number(a.monthly_units) || 0;
  const bill = Number(a.monthly_bill) || 0;
  const tariff = Number(a.tariff) || 0;
  const area = Number(a.area_sqft) || 0;
  // Size from units (best), else bill ÷ tariff.
  let unitsEff = units || (tariff > 0 ? bill / tariff : 0);
  let kw = unitsEff > 0 ? Math.round(unitsEff / 108) : 0;
  // Cap by sanctioned load and by area.
  const sanctioned = Number(a.sanctioned_load) || 0;
  if (sanctioned > 0) kw = Math.min(kw, Math.round(sanctioned));
  let areaCapped = false;
  if (area > 0) { const byArea = Math.floor(area / (sel(a.roof_type).startsWith('Ground') ? 130 : 100)); if (byArea > 0 && byArea < kw) { kw = byArea; areaCapped = true; } }
  if (kw < 1) kw = 1;

  let system = 'ongrid';
  if (sel(a.net_metering).startsWith('Captive')) system = 'zeroexport';
  else if (sel(a.power_cuts).startsWith('Frequent') || sel(a.load_profile) === 'Mostly night' || sel(a.dg_backup) === 'Yes') system = 'hybrid';

  const flags = [];
  if (sel(a.shading) === 'Significant') flags.push('⚠ Significant shading — verify layout / optimisers on survey.');
  if (sel(a.roof_age).startsWith('Old')) flags.push('⚠ Old RCC roof — waterproofing & load-bearing check needed.');
  if (areaCapped) flags.push('ℹ Size capped by available area, not by consumption.');
  if (sel(a.subsidy) === 'Interested' && sel(a.property_type) !== 'Residential') flags.push('ℹ Subsidy is residential-only — manage expectation.');
  if (Number(a.budget) && kw && Number(a.budget) / (kw * 1000) < 35) flags.push('ℹ Budget looks thin for this load — align scope.');
  if (sel(a.timeline) === 'Immediate' && sel(a.decision_maker) === 'Yes') flags.push('🔥 Hot lead — decision-maker + immediate.');

  const conn = system === 'hybrid' ? 'hybrid' : system === 'zeroexport' ? 'zeroexport' : 'ongrid';
  return { kw, system, conn, flags, est_units: Math.round(unitsEff) };
}

// Returns the fraction (0..1) of questions answered, for a readiness bar.
export function qualProgress(a = {}) {
  const all = QUAL_SECTIONS.flatMap((s) => s.questions.map((q) => q.key));
  const done = all.filter((k) => a[k] !== undefined && a[k] !== '').length;
  return { done, total: all.length, pct: Math.round(done / all.length * 100) };
}
