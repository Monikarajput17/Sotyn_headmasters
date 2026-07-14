// Centralised IST date / time formatter.
//
// Mam (2026-05-22): "this is pick wrong time according to indian i
// fill now which time is 22/05/2026 10.22am but see what this pick
// time its blunder when we take scoring".  Payment Required showed
// 04:49:15 for a 10:22 IST submission — that's the raw UTC stored
// by SQLite's CURRENT_TIMESTAMP, never converted on the way out.
//
// Single source of truth:
// - SQLite stores everything as UTC ('YYYY-MM-DD HH:MM:SS', no 'Z').
// - The browser parses that string as LOCAL time by default, which is
//   wrong on every machine.  We append 'Z' before parsing so JS knows
//   it's UTC, then format via toLocaleString('en-IN', { timeZone:
//   'Asia/Kolkata' }).
//
// Use these helpers everywhere a created_at / updated_at / *_at
// timestamp is rendered.  They tolerate undefined / null / already-
// formatted strings without throwing.

function toDate(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  const str = String(s).trim();
  if (!str) return null;
  // Already has timezone marker — let JS parse it as-is.
  if (/Z|[+-]\d{2}:?\d{2}$/i.test(str)) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }
  // SQLite shape: 'YYYY-MM-DD HH:MM:SS' (space, no Z).  Or ISO with 'T'.
  const iso = str.includes('T') ? str : str.replace(' ', 'T');
  const d = new Date(iso + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

// Date + time in IST — e.g. "22 May 2026, 10:22 AM".  Use for any
// "created at / updated at / submitted at" display.
export function fmtIST(s) {
  const d = toDate(s);
  if (!d) return '';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

// Date only in IST — e.g. "22 May 2026".  Use for due dates,
// committed dates, etc., where time-of-day adds noise.
export function fmtDateIST(s) {
  const d = toDate(s);
  if (!d) return '';
  return d.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

// Time only in IST — e.g. "10:22 AM".  Useful for narrow cells where
// the date is implied by context (today's punches, today's entries).
export function fmtTimeIST(s) {
  const d = toDate(s);
  if (!d) return '';
  return d.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

// Two-line variant: returns { date, time } so a tight column can
// stack them.
export function fmtISTPair(s) {
  const d = toDate(s);
  if (!d) return { date: '', time: '' };
  return {
    date: d.toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: 'short', year: 'numeric',
    }),
    time: d.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit', minute: '2-digit', hour12: true,
    }),
  };
}
