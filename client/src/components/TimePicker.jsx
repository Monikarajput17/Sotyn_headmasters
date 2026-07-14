// Shared 12-hour scroll-column time picker — mam (2026-06-01): "IN
// WHOLE Sotyn.Headmasters THIS TYPE BUT IF UI/UX GOOD AFTER TIME SELECTION BUTTON
// IS APPLY".  The native <input type="time"> opens a column-style
// picker that *commits on click*, which made every accidental tap
// save a wrong time.  This component replaces it with the same
// three-column layout (Hour / Minute / AM-PM) but defers commit to
// an explicit Apply button at the bottom.
//
// API mirrors <input type="time"> for drop-in replacement:
//   <TimePicker
//      value="14:30"            // HH:MM 24-hour, same as HTML5 time input
//      onChange={v => setForm({...form, from_time: v})}
//      placeholder="Pick a time"
//      required={false}
//      className=""             // applied to the trigger button
//      minuteStep={5}           // default 5; pass 1 for every minute
//   />
//
// Value flow:
//   prop value (24h "HH:MM") → internal hour12 + minute + ampm state
//   user scrolls / taps columns → state updates (NOT yet committed)
//   Apply → recompose 24h "HH:MM", call onChange, close popover
//   Cancel / click-outside / Esc → discard, reopen restores last
//                                  committed value

import { useState, useEffect, useRef, useCallback } from 'react';
import { FiClock, FiX, FiCheck } from 'react-icons/fi';

// Convert 24h "HH:MM" → { h12, m, ampm }.  Empty / invalid returns
// noon as a friendly default — better than midnight which often
// reads as "unset" to users.
function parse24(s) {
  if (!s || !/^\d{1,2}:\d{2}$/.test(s)) return { h12: 12, m: 0, ampm: 'PM' };
  const [hh, mm] = s.split(':').map(Number);
  const ampm = hh >= 12 ? 'PM' : 'AM';
  let h12 = hh % 12; if (h12 === 0) h12 = 12;
  return { h12, m: mm, ampm };
}

// Compose { h12, m, ampm } → 24h "HH:MM".
function compose24(h12, m, ampm) {
  let hh = h12 % 12;
  if (ampm === 'PM') hh += 12;
  return `${String(hh).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Pretty-print for the trigger button.
function pretty(s) {
  if (!s) return '';
  const { h12, m, ampm } = parse24(s);
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
}

export default function TimePicker({
  value = '',
  onChange,
  placeholder = 'Pick time',
  required = false,
  disabled = false,
  className = 'input text-left flex items-center gap-2 cursor-pointer',
  minuteStep = 5,
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => parse24(value));
  const rootRef = useRef(null);

  // Resync the draft any time the parent value changes (e.g. when
  // a record is loaded into the form after the picker mounted).
  useEffect(() => { setDraft(parse24(value)); }, [value]);

  // Close on outside click / Esc.  Draft is discarded automatically
  // because Apply is the only path that calls onChange.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const hours = Array.from({ length: 12 }, (_, i) => i + 1);
  // Minute list — every `minuteStep` (default 5).  If the current
  // value falls between steps, fold it in so editing a 14:23 row
  // doesn't snap to 14:25.
  const minutes = (() => {
    const list = [];
    for (let m = 0; m < 60; m += minuteStep) list.push(m);
    if (!list.includes(draft.m)) list.push(draft.m);
    return list.sort((a, b) => a - b);
  })();

  const apply = useCallback(() => {
    onChange?.(compose24(draft.h12, draft.m, draft.ampm));
    setOpen(false);
  }, [draft, onChange]);

  const cancel = () => {
    setDraft(parse24(value));   // discard
    setOpen(false);
  };

  const colStyle = 'flex-1 max-h-[180px] overflow-y-auto py-1 scroll-smooth';
  const cellBase = 'px-3 py-1.5 rounded-md text-sm cursor-pointer select-none text-center transition';
  const cellActive = 'bg-blue-600 text-white font-bold shadow-sm';
  const cellIdle = 'hover:bg-blue-50 text-gray-700';

  return (
    <div ref={rootRef} className="relative w-full">
      <button type="button" disabled={disabled} onClick={() => setOpen(o => !o)}
        className={className}>
        <FiClock size={14} className="text-gray-400 flex-shrink-0" />
        <span className={value ? 'text-gray-800' : 'text-gray-400'}>
          {value ? pretty(value) : placeholder}
        </span>
        {required && !value && <span className="text-red-500 ml-auto">*</span>}
      </button>

      {open && (
        <div className="absolute z-50 mt-1 bg-white border border-gray-200 rounded-lg shadow-xl w-[260px] overflow-hidden"
             onClick={e => e.stopPropagation()}>
          {/* 3-column header — matches mam's screenshot layout */}
          <div className="flex text-[10px] font-bold uppercase tracking-wide text-gray-400 px-2 pt-2">
            <div className="flex-1 text-center">Hour</div>
            <div className="flex-1 text-center">Min</div>
            <div className="flex-1 text-center">AM/PM</div>
          </div>

          <div className="flex gap-1 px-2 pb-2 border-b">
            {/* Hours 1..12 */}
            <div className={colStyle}>
              {hours.map(h => (
                <div key={h}
                  className={`${cellBase} ${draft.h12 === h ? cellActive : cellIdle}`}
                  onClick={() => setDraft(d => ({ ...d, h12: h }))}>
                  {String(h).padStart(2, '0')}
                </div>
              ))}
            </div>
            {/* Minutes (stepped) */}
            <div className={colStyle}>
              {minutes.map(m => (
                <div key={m}
                  className={`${cellBase} ${draft.m === m ? cellActive : cellIdle}`}
                  onClick={() => setDraft(d => ({ ...d, m }))}>
                  {String(m).padStart(2, '0')}
                </div>
              ))}
            </div>
            {/* AM / PM */}
            <div className={colStyle}>
              {['AM', 'PM'].map(ap => (
                <div key={ap}
                  className={`${cellBase} ${draft.ampm === ap ? cellActive : cellIdle}`}
                  onClick={() => setDraft(d => ({ ...d, ampm: ap }))}>
                  {ap}
                </div>
              ))}
            </div>
          </div>

          {/* Apply / Cancel footer.  Apply is the ONLY path that
              commits the value back to the parent — mam's exact ask. */}
          <div className="flex items-center justify-between gap-2 p-2 bg-gray-50">
            <div className="text-xs text-gray-600 font-semibold">
              {String(draft.h12).padStart(2, '0')}:{String(draft.m).padStart(2, '0')} {draft.ampm}
            </div>
            <div className="flex gap-1.5">
              <button type="button" onClick={cancel}
                className="text-xs px-2.5 py-1 rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 flex items-center gap-1">
                <FiX size={12} /> Cancel
              </button>
              <button type="button" onClick={apply}
                className="text-xs px-3 py-1 rounded bg-blue-600 text-white font-semibold hover:bg-blue-700 flex items-center gap-1">
                <FiCheck size={12} /> Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
