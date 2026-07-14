import { useState, useRef, useEffect } from 'react';

// Compact multi-select dropdown (mam 2026-06-17): one button that shows the
// picked names as chips and opens a searchable checkbox list. Used for the
// PO form's extra project roles (jr site eng / supervisor / welder / helper)
// so we don't repaint the full user list as chips four times over.
//   options : [{ id, name }]
//   value   : array of selected ids
//   onChange: (nextIds[]) => void
export default function MultiUserSelect({ options, value = [], onChange, placeholder = 'Select one or more…', emptyText = 'No users found' }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);
  useEffect(() => { if (open && inputRef.current) inputRef.current.focus(); }, [open]);

  const sel = new Set(value);
  const selectedOpts = options.filter(o => sel.has(o.id));
  const filtered = options.filter(o => {
    if (!search) return true;
    const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
    const text = (o.name || '').toLowerCase();
    return tokens.every(t => text.includes(t));
  });
  const toggle = (id) => onChange(sel.has(id) ? value.filter(v => v !== id) : [...value, id]);

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => { setOpen(!open); setSearch(''); }}
        className="input text-left text-sm w-full flex items-center justify-between gap-1 cursor-pointer min-h-[42px]">
        <span className="flex flex-wrap gap-1 items-center">
          {selectedOpts.length === 0
            ? <span className="text-gray-400">{placeholder}</span>
            : selectedOpts.map(o => (
                <span key={o.id} className="inline-flex items-center gap-1 bg-red-600 text-white rounded-full px-2 py-0.5 text-xs">
                  {o.name}
                  <span onClick={(e) => { e.stopPropagation(); toggle(o.id); }} className="cursor-pointer font-bold leading-none" title="Remove">×</span>
                </span>
              ))}
        </span>
        <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-80 overflow-hidden">
          <div className="p-2 border-b">
            <input ref={inputRef} type="text" className="input text-sm w-full" placeholder="Type to search…"
              value={search} onChange={e => setSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }} />
          </div>
          <div className="overflow-y-auto max-h-64">
            {value.length > 0 && (
              <button type="button" onClick={() => onChange([])}
                className="w-full text-left px-3 py-2 text-xs text-red-500 hover:bg-red-50 border-b">
                Clear all ({value.length})
              </button>
            )}
            {filtered.length === 0 && <div className="px-3 py-4 text-sm text-gray-400 text-center">{emptyText}</div>}
            {filtered.map(o => {
              const on = sel.has(o.id);
              return (
                <button type="button" key={o.id} onClick={() => toggle(o.id)}
                  className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-red-50 transition-colors ${on ? 'bg-red-50 font-medium text-red-700' : 'text-gray-700'}`}>
                  <span className={`inline-flex w-4 h-4 items-center justify-center rounded border text-[10px] flex-shrink-0 ${on ? 'bg-red-600 border-red-600 text-white' : 'border-gray-300'}`}>{on ? '✓' : ''}</span>
                  {o.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
