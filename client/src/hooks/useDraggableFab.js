// useDraggableFab — turns any floating action button into a draggable
// element that remembers where mam parked it (per-button localStorage
// key).  Used for the Help button and the AI Assistant robot so they
// can be dragged out of the way when they hide content behind them.
//
// Mam (2026-05-16): "this ai robot and help ticket do moveable bcs
// some time hide its back side".
//
// Design notes:
//   - Pointer events (works for mouse + touch + pen on one code path)
//   - 4 px movement threshold separates "click" from "drag" so a quick
//     tap still opens the panel, but the slightest drag suppresses it
//   - Position clamped to viewport on mount + on every window resize
//     (so dragging to one corner then resizing the window doesn't
//     park the button off-screen)
//   - Persisted as { x, y } in px under the supplied storageKey
//
// Usage:
//   const { style, handlers, onClickGuard } = useDraggableFab('fab-help');
//   <button {...handlers} onClick={onClickGuard(() => setOpen(true))}
//           style={style} className="...without bottom-X right-X...">
//     ...
//   </button>

import { useEffect, useRef, useState, useCallback } from 'react';

const SIZE_HINT = 64; // approx button width/height for viewport clamping

function readSaved(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) return null;
    return p;
  } catch { return null; }
}

function defaultBottomRight(offsetRight, offsetBottom) {
  if (typeof window === 'undefined') return { x: 100, y: 100 };
  return {
    x: window.innerWidth  - offsetRight  - SIZE_HINT,
    y: window.innerHeight - offsetBottom - SIZE_HINT,
  };
}

function clamp({ x, y }) {
  if (typeof window === 'undefined') return { x, y };
  return {
    x: Math.min(Math.max(0, x), window.innerWidth  - SIZE_HINT),
    y: Math.min(Math.max(0, y), window.innerHeight - SIZE_HINT),
  };
}

export default function useDraggableFab(storageKey, { offsetRight = 24, offsetBottom = 24 } = {}) {
  const [pos, setPos] = useState(() => clamp(readSaved(storageKey) || defaultBottomRight(offsetRight, offsetBottom)));
  const drag = useRef({ on: false, moved: false, startX: 0, startY: 0, baseX: 0, baseY: 0 });
  const movedRef = useRef(false);

  // Reclamp on window resize so the button never floats off-screen
  useEffect(() => {
    const onResize = () => setPos(prev => clamp(prev));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPointerDown = useCallback((e) => {
    drag.current = {
      on: true,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      baseX: pos.x,
      baseY: pos.y,
    };
    movedRef.current = false;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
  }, [pos.x, pos.y]);

  const onPointerMove = useCallback((e) => {
    if (!drag.current.on) return;
    const dx = e.clientX - drag.current.startX;
    const dy = e.clientY - drag.current.startY;
    if (!drag.current.moved && Math.hypot(dx, dy) > 4) {
      drag.current.moved = true;
      movedRef.current = true;
    }
    if (drag.current.moved) {
      setPos(clamp({ x: drag.current.baseX + dx, y: drag.current.baseY + dy }));
    }
  }, []);

  const onPointerUp = useCallback((e) => {
    if (!drag.current.on) return;
    drag.current.on = false;
    if (drag.current.moved) {
      try { localStorage.setItem(storageKey, JSON.stringify(pos)); } catch (_) {}
    }
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) {}
  }, [pos, storageKey]);

  // Wrap the caller's onClick — if the gesture was a drag, swallow it.
  // movedRef is cleared after the click event so the *next* tap works.
  const onClickGuard = useCallback((cb) => (e) => {
    if (movedRef.current) {
      e.preventDefault();
      e.stopPropagation();
      movedRef.current = false;
      return;
    }
    if (cb) cb(e);
  }, []);

  return {
    style: {
      position: 'fixed',
      left: pos.x,
      top: pos.y,
      right: 'auto',
      bottom: 'auto',
      touchAction: 'none',  // prevent mobile scroll while dragging
    },
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
    onClickGuard,
  };
}
