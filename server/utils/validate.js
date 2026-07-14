// Shared input validators for fields that have caused junk-data
// incidents.  MD's TOC v3 spec (2026-05-15) flagged junk POs in the
// Business Book worth ₹39.6L: "5252525", "141414", "1111111111",
// "00".  Validation runs on POST and PUT for every entry point that
// can store a PO number, so historical junk doesn't get re-saved on
// an edit either.

// Allowed canonical lead sources per MD's spec.  Free text is blocked
// so the Sales-Head dashboard can group leads cleanly.
const ALLOWED_LEAD_SOURCES = ['Tenders', 'Referral', 'Direct', 'Website', 'Channel'];

// Allowed CRM-Funnel "source" values mirror the lead sources (same
// concept — where the enquiry came from).  CRMFunnel.jsx already has
// its own list of source labels; keep them consistent with the master
// lead_sources whitelist so cross-module reporting lines up.
const ALLOWED_FUNNEL_SOURCES = ALLOWED_LEAD_SOURCES;

// PO number rules:
//  - Trim whitespace.
//  - Must be >= 10 characters.
//  - Only alphanumeric + the structural separators humans actually use
//    in real POs: dash, slash, underscore, space.
//  - Cannot be a single repeated digit / character (1111111111, 0000…).
//  - Cannot be the literal junk values we've already seen.
//
// Returns null on success, or a human-readable error string on failure.
const KNOWN_JUNK_POS = new Set(['5252525', '141414', '1111111111', '00', '0', '11111111', '1234567890', '0000000000']);

function validatePoNumber(raw) {
  if (raw === undefined || raw === null) return 'PO number is required';
  const v = String(raw).trim();
  if (!v) return 'PO number is required';
  if (KNOWN_JUNK_POS.has(v)) return `"${v}" is on the junk-PO blocklist. Enter the real PO number from the client document.`;
  if (v.length < 10) return `PO number must be at least 10 characters (got ${v.length}). Real POs look like "PO-2026-00042" or "SEPL/HERO/2026-04".`;
  if (!/^[A-Za-z0-9_\-\/ ]+$/.test(v)) return 'PO number can only contain letters, digits, and separators (- _ / space).';
  // Repeat-character check — collapse to set of distinct chars (ignoring
  // separators).  If only one distinct char, it's junk.
  const distinct = new Set(v.replace(/[-_\/ ]/g, '').toUpperCase().split(''));
  if (distinct.size <= 1) return `"${v}" looks like a placeholder (only one unique character). Enter the real PO number.`;
  return null;
}

function validateLeadSource(raw) {
  if (raw === undefined || raw === null || raw === '') return null; // optional
  const v = String(raw).trim();
  if (!ALLOWED_LEAD_SOURCES.includes(v)) {
    return `Lead source must be one of: ${ALLOWED_LEAD_SOURCES.join(', ')}. Got "${v}".`;
  }
  return null;
}

function validateFunnelSource(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const v = String(raw).trim();
  if (!ALLOWED_FUNNEL_SOURCES.includes(v)) {
    return `CRM Funnel source must be one of: ${ALLOWED_FUNNEL_SOURCES.join(', ')}. Got "${v}".`;
  }
  return null;
}

module.exports = {
  ALLOWED_LEAD_SOURCES,
  ALLOWED_FUNNEL_SOURCES,
  KNOWN_JUNK_POS,
  validatePoNumber,
  validateLeadSource,
  validateFunnelSource,
};
