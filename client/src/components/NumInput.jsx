import { useState, useEffect, useRef } from 'react';

// NumInput — a number-only <input> that doesn't snap to 0 when the user
// backspaces or Ctrl-A + Delete's the field.
//
// Why this exists: the naïve React pattern
//
//   <input type="number" value={qty} onChange={e => setQty(+e.target.value)} />
//
// breaks badly because  +'' === 0.  As soon as the user clears the field,
// state becomes 0, React re-renders with `value={0}`, and the field shows "0"
// again — the user can never empty it to retype.
//
// This component keeps a separate STRING state for what's typed in the box
// (`text`) and parses it into a number for the parent only when it makes
// sense.  Empty string  →  parent receives `null` (or 0 if emitZeroOnEmpty
// is true — keeps backwards compat with existing handlers that expect a
// number).  Anything else  →  parent receives the parsed number.
//
// Drop-in replacement for `<input type="number" ... />` with the same value
// + onChange contract.  Pass `emitZeroOnEmpty` when the parent's state
// handler can't deal with null (most legacy onChange handlers in this
// codebase do `n[i].quantity = +e.target.value` — they want a number).
//
// Usage:
//   <NumInput value={qty} onChange={setQty} placeholder="Qty" min="0" />
//   <NumInput value={item.quantity} onChange={v => setQty(v)} emitZeroOnEmpty />
export default function NumInput({
  value,
  onChange,
  allowDecimal = true,
  emitZeroOnEmpty = false,
  className,
  step,
  ...rest
}) {
  // Without an explicit step, type="number" defaults to step=1 and the
  // browser rejects decimals (e.g. a rate of 21.07 → "nearest valid values
  // are 21 and 22"). Since this input parses decimals by default, allow
  // them: step="any" for decimal inputs, "1" when allowDecimal=false. An
  // explicit step prop still wins.
  const stepAttr = step != null ? step : (allowDecimal ? 'any' : '1');
  // The string the user actually sees in the input.  Initialised from
  // `value` but tracked separately so an empty box doesn't bounce to "0".
  const [text, setText] = useState(
    value === '' || value == null ? '' : String(value)
  );

  // External value changed (e.g. parent reset the form)? Re-sync the
  // visible text — but ONLY when the user isn't actively typing.  A
  // ref tracks "I am editing right now" so we don't yank what they
  // just typed.
  const editingRef = useRef(false);
  useEffect(() => {
    if (editingRef.current) return;
    const next = value === '' || value == null ? '' : String(value);
    if (next !== text) setText(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const handle = (e) => {
    editingRef.current = true;
    const raw = e.target.value;
    setText(raw);

    // Allow the user to type intermediate states like "" or "-" or "."
    // without forcing a number on the parent yet.
    if (raw === '' || raw === '-' || raw === '.' || raw === '-.') {
      if (typeof onChange === 'function') onChange(emitZeroOnEmpty ? 0 : null);
      return;
    }
    const parsed = allowDecimal ? parseFloat(raw) : parseInt(raw, 10);
    if (!Number.isNaN(parsed) && typeof onChange === 'function') {
      onChange(parsed);
    }
  };

  // When the user finally tabs/blurs away, clear the "I'm editing" flag
  // so external value changes can re-sync the text.
  const handleBlur = (e) => {
    editingRef.current = false;
    if (rest.onBlur) rest.onBlur(e);
  };

  return (
    <input
      {...rest}
      type="number"
      step={stepAttr}
      value={text}
      onChange={handle}
      onBlur={handleBlur}
      className={className}
    />
  );
}
