// Resume parsing — best-effort extraction of name, email, phone,
// address from a candidate's PDF / DOCX / TXT resume.
//
// Mam (2026-05-22): "when upload resume name, mobile number,
// email-id, address, automatically fill here".  Then re-tested with
// her own Monika_Devi_Resume_Updated.pdf and reported "not upload
// data" — parser returned nothing for a resume where the header
// clearly shows MONIKA DEVI / +91 95018 90918 / devimonika17may@…
// / Ludhiana, Punjab.
//
// Root causes fixed in this rewrite (2026-05-22 v2):
//   1. Phone regex was hard-coded to 3-3-4 split (e.g. 999-888-7777).
//      Real resumes write "+91 95018 90918" (5-5 split) which broke
//      the pattern.  New PHONE_RE is digit-by-digit flexible —
//      tolerates ANY whitespace / dash / dot between any two digits.
//   2. Single-line headers with bullets ("Ludhiana, Punjab, India
//      • +91 … • email") were treated as ONE line, so the address
//      heuristic captured the whole monstrous string.  Now we split
//      on bullets / pipes / middots BEFORE running heuristics.
//   3. Name heuristic was too strict — required title-case "First
//      Last" but plenty of resumes write "MONIKA DEVI" in all caps.
//      New guessName tries 4 patterns in order: ALL CAPS 2-3 words,
//      Title Case 2-3 words, single word ≥3 chars in first 3 lines,
//      fallback to first non-junk line.
//
// Strategy now:
//   1. Extract raw text from the file (pdf-parse for PDF,
//      mammoth for DOCX, raw buffer for TXT).
//   2. Normalise: collapse whitespace AND split on bullets / pipes /
//      middots / em-dashes so each contact-line atom is its own line.
//   3. Run focused regex passes for email / phone / pincode /
//      LinkedIn on the FULL normalised text.
//   4. Heuristic for NAME and ADDRESS on the line array.
//
// Returns { name, email, phone, address, linkedin, confidence,
//           raw_text_preview } — any field can be null if not
// confidently detected.

const fs = require('fs');

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

// Indian mobile — 10 digits starting 6-9, with OPTIONAL +91 prefix and
// any combination of whitespace / dashes / dots / parens between any
// two digits.  Anchored on a digit boundary so we don't match the
// middle of a longer number.  Tested against the formats we see most:
//   +91 9501890918           +91-9501890918
//   +91 95018 90918          95018-90918
//   9501890918               +91 9501 8 90918
const PHONE_RE = /(?:\+?\s*91[\s.\-()]*)?(?<!\d)[6-9](?:[\s.\-()]*\d){9}(?!\d)/g;

const PINCODE_RE = /\b\d{6}\b/g;
const LINKEDIN_RE = /linkedin\.com\/in\/[\w-]+/i;

const INDIAN_STATES = [
  'Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa','Gujarat',
  'Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala','Madhya Pradesh',
  'Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland','Odisha','Orissa',
  'Punjab','Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura',
  'Uttar Pradesh','Uttarakhand','West Bengal','Delhi','New Delhi',
  'Chandigarh','Pondicherry','Puducherry','Ladakh','Jammu','Kashmir',
];

// Common Indian metro / large-city names — used as a secondary address
// signal when pincode and state aren't on the same line as the city
// (resumes often write just "Mumbai" or "Bangalore" alone).
const INDIAN_CITIES = [
  'Mumbai','Delhi','New Delhi','Bangalore','Bengaluru','Hyderabad','Ahmedabad',
  'Chennai','Kolkata','Surat','Pune','Jaipur','Lucknow','Kanpur','Nagpur',
  'Indore','Thane','Bhopal','Visakhapatnam','Patna','Vadodara','Ludhiana',
  'Agra','Nashik','Ranchi','Faridabad','Meerut','Rajkot','Varanasi',
  'Srinagar','Aurangabad','Dhanbad','Amritsar','Jodhpur','Coimbatore',
  'Vijayawada','Chandigarh','Gurgaon','Gurugram','Noida','Ghaziabad',
  'Howrah','Allahabad','Prayagraj','Mysore','Mysuru','Mangalore','Kochi',
  'Cochin','Trivandrum','Thiruvananthapuram','Goa','Panaji','Mohali',
];

// Words that signal a resume header / not a real person's name.
const NAME_STOP = new Set([
  'curriculum vitae','curriculum-vitae','resume','cv','bio data','biodata',
  'profile','personal details','contact','contact details','about me',
  'objective','summary','professional summary','career objective',
]);

// ── Text extraction per file type ──────────────────────────────
// Returns { text, error } so callers can distinguish "module not
// installed" from "PDF actually has no text" — mam (2026-05-22 v3)
// hit the silent-fail case on her VPS and the UI just said "no
// fields found" with no clue why.
async function extractText(filePath, mimetype = '') {
  const buf = fs.readFileSync(filePath);
  const lower = (filePath || '').toLowerCase();
  // PDF
  if (mimetype.includes('pdf') || lower.endsWith('.pdf')) {
    // Mam (2026-05-22 v3): use the inner-path require so we bypass
    // the well-known pdf-parse init bug — its top-level index.js
    // tries to read a test fixture at ./test/data/05-versions-space.pdf
    // when isDebugMode is true, which crashes the require on some
    // VPS setups (production pruning, strict file perms, etc.).
    // The /lib/pdf-parse.js path exports the same function without
    // the debug init.
    let pdfParse;
    try { pdfParse = require('pdf-parse/lib/pdf-parse.js'); }
    catch (_) {
      try { pdfParse = require('pdf-parse'); }
      catch (e) {
        const msg = `pdf-parse not installed — run 'npm install' on the server (${e.message})`;
        console.warn('[resumeParser]', msg);
        return { text: '', error: msg };
      }
    }
    try {
      const data = await pdfParse(buf);
      return { text: data.text || '', error: null };
    } catch (e) {
      const msg = `pdf-parse failed: ${e.message}`;
      console.warn('[resumeParser]', msg);
      return { text: '', error: msg };
    }
  }
  // DOCX
  if (mimetype.includes('word') || lower.endsWith('.docx')) {
    let mammoth;
    try { mammoth = require('mammoth'); }
    catch (e) {
      const msg = `mammoth not installed — run 'npm install' on the server (${e.message})`;
      console.warn('[resumeParser]', msg);
      return { text: '', error: msg };
    }
    try {
      const { value } = await mammoth.extractRawText({ buffer: buf });
      return { text: value || '', error: null };
    } catch (e) {
      const msg = `mammoth failed: ${e.message}`;
      console.warn('[resumeParser]', msg);
      return { text: '', error: msg };
    }
  }
  // Legacy .doc — neither library reads it.
  if (lower.endsWith('.doc')) {
    return { text: '', error: 'Legacy .doc not supported — please use PDF or .docx' };
  }
  // Plain text fallback
  try { return { text: buf.toString('utf-8'), error: null }; }
  catch (_) { return { text: '', error: 'Could not read file as text' }; }
}

// Split a single text blob into "atom lines" by treating newlines AND
// common in-line separators (bullet •, middot ·, pipe |, em-dash —)
// as line breaks.  This is what lets us split a header like
// "Ludhiana, Punjab • +91 ... • email" into three separate lines.
function atomizeLines(text) {
  const replaced = text
    .replace(/[•·●◦∙■►▪▶]/g, '\n')   // bullets
    .replace(/\s\|\s/g, '\n')           // pipe with surrounding space
    .replace(/\s[–—]\s/g, '\n');        // en-dash / em-dash with spaces
  return replaced
    .split(/\r?\n/)
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// ── Heuristic NAME extraction ──────────────────────────────────
// Most resumes put the candidate's name on or near the very first
// non-blank line, often in a larger font.  We can't see fonts but
// we CAN look for a small set of common patterns.  Strategies, in
// order:
//   1. First 5 lines, ALL CAPS 2-3 words ("MONIKA DEVI")
//   2. First 5 lines, Title Case 2-3 words ("Monika Devi")
//   3. First 3 lines, single word ≥3 chars all letters (fallback —
//      one-word names like "Madonna" exist but rare)
function guessName(lines) {
  const ALL_CAPS = /^[A-Z][A-Z'.-]+(?:\s+[A-Z][A-Z'.-]+){1,3}$/;
  const TITLE    = /^[A-Z][a-zA-Z'.-]+(?:\s+[A-Z][a-zA-Z'.-]+){1,3}$/;
  const SINGLE   = /^[A-Z][a-zA-Z'.-]{2,}$/;

  const candidates = lines.slice(0, 6);
  const safe = (line) => {
    if (!line) return false;
    if (line.length > 60) return false;
    if (/[@\d]/.test(line)) return false;           // skip lines with @ or digits
    if (NAME_STOP.has(line.toLowerCase())) return false;
    return true;
  };

  // Pass 1 — ALL CAPS
  for (const l of candidates) {
    if (safe(l) && ALL_CAPS.test(l)) return l;
  }
  // Pass 2 — Title Case
  for (const l of candidates) {
    if (safe(l) && TITLE.test(l)) return l;
  }
  // Pass 3 — Single Capitalised word in first 3 lines (rare but Mononyms exist)
  for (const l of candidates.slice(0, 3)) {
    if (safe(l) && SINGLE.test(l)) return l;
  }
  return null;
}

// ── Heuristic ADDRESS extraction ───────────────────────────────
// Strategy:
//   1. Find any line containing an Indian PIN (6 digits).  That
//      line is almost always part of the address.  Grab it + the
//      line before (street name often precedes the pin).
//   2. Otherwise, find a line containing a known state name AND
//      a known city, or just a state, or just a city.  Prefer
//      shorter lines (likely a clean "City, State" string vs a
//      long bullet-merged line that slipped through atomization).
//   3. Strip noise (parenthetical "(Open to Remote)" tail etc.)
//      from the chosen line.
function guessAddress(lines) {
  // 1. Pincode hit
  for (let i = 0; i < lines.length; i += 1) {
    PINCODE_RE.lastIndex = 0;
    if (PINCODE_RE.test(lines[i])) {
      PINCODE_RE.lastIndex = 0;
      const prev = (lines[i - 1] || '').trim();
      const cur  = lines[i].trim();
      const chunk = [prev, cur].filter(s => s && s.length < 120).join(', ');
      return cleanAddress(chunk);
    }
  }

  // 2. State / city hit (prefer shorter).
  //
  // CRITICAL: must use word-boundary matching, not substring.  If we
  // do `.includes('punjab')`, a line like "Languages: Hindi, Punjabi"
  // matches because "Punjabi" contains "Punjab" — and since that
  // line is shorter than "Ludhiana, Punjab, India (Open to Remote)",
  // the "prefer shortest" tiebreaker picks the WRONG line.
  // Found by mam's own resume (2026-05-22 v2).
  const stateRegexes = INDIAN_STATES.map(s => new RegExp(`\\b${s.replace(/\s+/g, '\\s+')}\\b`, 'i'));
  const cityRegexes  = INDIAN_CITIES.map(c => new RegExp(`\\b${c.replace(/\s+/g, '\\s+')}\\b`, 'i'));
  const hasState = (line) => stateRegexes.some(r => r.test(line));
  const hasCity  = (line) => cityRegexes.some(r => r.test(line));

  // "Languages: …" lines are NOT addresses no matter what they
  // contain — bail out early so we don't even score them.
  const isLanguagesLine = (line) => /\b(languages?|known\s+languages|spoken)\s*[:\-]/i.test(line);

  const stateMatches = [];
  const cityOnlyMatches = [];

  for (const line of lines) {
    if (line.length > 120) continue;          // skip very long lines
    if (/@/.test(line)) continue;             // contains email → not address
    if (isLanguagesLine(line)) continue;      // languages skill row → skip
    if (/\b\d{4}\b/.test(line)) {             // contains a 4+ digit number → likely a phone/year not address
      // BUT keep going if it ALSO has a state (e.g. "Sector 22, Chandigarh 160022")
      if (!hasState(line)) continue;
    }
    if (hasState(line)) stateMatches.push(line);
    else if (hasCity(line)) cityOnlyMatches.push(line);
  }

  // Prefer the SHORTEST state-hit line (more focused address).
  if (stateMatches.length) {
    stateMatches.sort((a, b) => a.length - b.length);
    return cleanAddress(stateMatches[0]);
  }
  if (cityOnlyMatches.length) {
    cityOnlyMatches.sort((a, b) => a.length - b.length);
    return cleanAddress(cityOnlyMatches[0]);
  }
  return null;
}

// Strip the common parenthetical noise resumes append to the city —
// "(Open to Remote)", "(WFH)", "(Negotiable)" — and trim trailing
// punctuation.  Cosmetic only; if it goes wrong we still return the
// original chunk.
function cleanAddress(s) {
  if (!s) return s;
  return s.replace(/\s*\([^)]*\)\s*$/, '').replace(/[,;.]+$/, '').trim();
}

// ── Master parser ──────────────────────────────────────────────
async function parseResume(filePath, mimetype = '') {
  let text = '';
  let extractError = null;
  try {
    const r = await extractText(filePath, mimetype);
    text = r.text || '';
    extractError = r.error || null;
  } catch (e) {
    console.warn('[resumeParser] extract threw:', e.message);
    extractError = e.message;
  }

  // Normalise — collapse extra whitespace but keep newlines for
  // line-based heuristics.
  const normText = text.replace(/[ \t]+/g, ' ');
  const lines = atomizeLines(normText);

  const emails = normText.match(EMAIL_RE) || [];
  const phones = normText.match(PHONE_RE) || [];

  // Pick the FIRST email / phone — rarely wrong; secondary ones tend
  // to be reference contacts.  Strip ALL non-digit characters from
  // phone, then strip the leading 91 country code if present, so we
  // end up with a clean 10-digit Indian mobile.
  const email = emails[0] || null;
  let phone = null;
  if (phones[0]) {
    const digits = phones[0].replace(/\D/g, '');
    // If number is 11+ digits and starts with 91, drop the 91 prefix.
    const base = digits.length >= 11 && digits.startsWith('91') ? digits.slice(2) : digits;
    // Keep last 10 digits as the canonical mobile number.
    phone = base.slice(-10);
    if (phone.length !== 10) phone = base;     // fallback if something weird
  }

  const name = guessName(lines);
  const address = guessAddress(lines);
  const linkedin = (normText.match(LINKEDIN_RE) || [])[0] || null;

  return {
    name, email, phone, address, linkedin,
    confidence: {
      name:    !!name,
      email:   !!email,
      phone:   !!phone,
      address: !!address,
    },
    // Mam (2026-05-22 v3): expose diagnostics so the UI can show a
    // specific error when extraction itself failed (e.g. pdf-parse
    // not installed) rather than the generic "no fields found".
    debug: {
      text_length:        text.length,
      lines_detected:     lines.length,
      extraction_error:   extractError,
      extraction_method:  /\.pdf$/i.test(filePath) ? 'pdf-parse'
                        : /\.docx$/i.test(filePath) ? 'mammoth'
                        : /\.doc$/i.test(filePath) ? 'unsupported'
                        : 'plain-text',
    },
    raw_text_preview: text.slice(0, 500),
  };
}

module.exports = { parseResume, extractText, atomizeLines, guessName, guessAddress };
