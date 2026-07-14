import { useState } from 'react';
import { FiInfo } from 'react-icons/fi';

// InfoTooltip — small (i) icon that reveals a longer text on hover/focus.
//
// Used when a field label needs more explanation than fits inline (e.g.
// dropdowns where the OPTIONS contain long descriptive labels that get
// truncated in the select box).  Pass the long text as `text`; mam can
// also pass JSX via `children` for richer popovers.
//
// Usage:
//   <label className="label flex items-center gap-1">
//     Site
//     <InfoTooltip text="Picks the destination site for this indent. Long names will be truncated in the dropdown — hover here to see the full list." />
//   </label>
export default function InfoTooltip({ text, children, side = 'top', className = '' }) {
  const [open, setOpen] = useState(false);
  // Anchored to the icon's LEFT EDGE (left-0), not centered, so the popup
  // always extends rightward instead of pushing off the left side of the
  // viewport when the icon is near the screen edge (mam 2026-05-25:
  // "WHEN I SELECT INFO IN SITE NAME THAT IS HIDE").  width:max-content
  // lets the popup grow up to its max-width naturally.
  const sideClass = {
    top:    'bottom-full left-0 mb-2',
    bottom: 'top-full left-0 mt-2',
    left:   'right-full top-1/2 -translate-y-1/2 mr-2',
    right:  'left-full top-1/2 -translate-y-1/2 ml-2',
  }[side] || 'bottom-full left-0 mb-2';
  return (
    <span
      className={`relative inline-flex items-center ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      tabIndex={0}
    >
      <FiInfo size={12} className="text-gray-400 hover:text-blue-600 cursor-help" />
      {open && (
        <span
          role="tooltip"
          // max-w uses min() so the popup auto-shrinks on narrow screens to
          // stay within viewport (mam 2026-05-25: popup was clipping past
          // modal left edge).  break-words ensures long names like
          // "M/s Chattargarh Renewable Energy Pvt. Ltd (SAEL)" wrap
          // cleanly instead of forcing wider layout.
          style={{ maxWidth: 'min(280px, calc(100vw - 40px))' }}
          className={`absolute z-50 ${sideClass} px-3 py-2 rounded-md bg-gray-900 text-white text-[11px] leading-snug font-normal shadow-lg w-max whitespace-pre-wrap break-words`}>
          {children || text}
        </span>
      )}
    </span>
  );
}
