import { useState, useRef, useEffect } from 'react';

// Render cap — only this many option rows are painted at once. Kept low so
// huge masters (the item-master PO list is ~1700 rows) don't render thousands
// of DOM nodes and hang the page (mam 2026-06-09 "erp is hang"). 400 still
// covers a 350-item BOQ fully; for bigger lists the token search below makes
// anything reachable by typing a couple of words.
const RENDER_CAP = 400;

export default function SearchableSelect({ options, value, onChange, placeholder = 'Search...', displayKey = 'label', valueKey = 'value', buttonClassName = 'input text-left text-sm w-full truncate flex items-center justify-between gap-1 cursor-pointer' }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef(null);
  const inputRef = useRef(null);

  const selected = options.find(o => o[valueKey] === value);
  // Token-based search (mam 2026-06-09): split the query into words and
  // require EVERY word to appear somewhere in the option text, in any order.
  // The " / " separators in item names (e.g. "pipe / ss 304 / 25mm") no
  // longer break the match — "304 pipe" or "ball 25mm ci" now find it.
  const filtered = options.filter(o => {
    if (!search) return true;
    const text = (o[displayKey] || '').toLowerCase();
    const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
    return tokens.every(t => text.includes(t));
  });

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  // selectedLabel is the full untruncated text we'll surface via the
  // native title= attribute on hover (mam 2026-05-25: "i need item where
  // write hose book tooltip of every" — every truncated sub-item should
  // reveal its full name on hover).
  const selectedLabel = selected ? selected[displayKey] : '';

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => { setOpen(!open); setSearch(''); }}
        // title attribute → browser-native tooltip on hover with the full
        // (untruncated) selected value.  Cheap, no library needed, works
        // across all browsers.
        title={selectedLabel || placeholder}
        className={buttonClassName}>
        <span className={`truncate ${selected ? 'text-gray-900' : 'text-gray-400'}`}>
          {selected ? selected[displayKey] : placeholder}
        </span>
        <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </button>

      {open && (
        // Panel width = parent input width (w-full). Long option labels
        // wrap to multiple lines via whitespace-normal break-words on the
        // item buttons. Keeping panel = input width prevents the dropdown
        // from blowing past tight modals (Delegation, Payment Required).
        <div className="absolute z-50 mt-1 w-full max-w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-80 overflow-hidden">
          <div className="p-2 border-b">
            <input ref={inputRef} type="text" className="input text-sm w-full" placeholder="Type to search..."
              value={search} onChange={e => setSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }} />
          </div>
          <div className="overflow-y-auto max-h-64">
            {value && (
              <button type="button" onClick={() => { onChange(null); setOpen(false); }}
                className="w-full text-left px-3 py-2 text-xs text-red-500 hover:bg-red-50 border-b">
                Clear selection
              </button>
            )}
            {filtered.length === 0 && <div className="px-3 py-4 text-sm text-gray-400 text-center">No items found</div>}
            {filtered.slice(0, RENDER_CAP).map(o => (
              <button type="button" key={o[valueKey]} onClick={() => { onChange(o); setOpen(false); setSearch(''); }}
                // title also on each option so even items that get
                // visually truncated mid-scroll show full text on hover.
                title={o[displayKey]}
                className={`w-full text-left px-3 py-2 text-sm whitespace-normal break-words leading-snug hover:bg-red-50 transition-colors ${o[valueKey] === value ? 'bg-red-50 font-medium text-red-700' : 'text-gray-700'}`}>
                {o[displayKey]}
              </button>
            ))}
            {filtered.length > RENDER_CAP && <div className="px-3 py-2 text-xs text-gray-400 text-center">Showing {RENDER_CAP} of {filtered.length} — type more to narrow</div>}
          </div>
        </div>
      )}
    </div>
  );
}
