// Shared hook to persist a "current tab" selection in the URL query
// string so refreshes (and shared links) don't snap the user back to
// the first tab. Mam reported it on Cheques (2026-05-28) and asked
// for an Sotyn.Headmasters-wide audit; this hook is the single source of truth.
//
// Usage — strict (recommended when the page knows its tab IDs):
//   const [tab, setTab] = useUrlTab(['action_due', 'all'], 'action_due');
//
// Usage — loose (drop-in replacement for useState('default')):
//   const [tab, setTab] = useUrlTab('action_due');
//
// Behaviour:
//   - Reads the URL ?tab=... on first mount and on browser back/fwd.
//   - In strict mode, falls back to `defaultTab` if URL value isn't
//     in `validValues`. In loose mode any string from the URL wins.
//   - When user picks the default tab, the param is REMOVED from the
//     URL so shareable links stay clean.
//   - `paramName` defaults to 'tab' but pages can override (e.g. 'sub')
//     if 'tab' is already taken by something else.

import { useSearchParams } from 'react-router-dom';

export function useUrlTab(validValuesOrDefault, defaultOrParamName, paramName = 'tab') {
  // Resolve the two call styles into one normalised shape.
  let validValues, defaultTab, key;
  if (Array.isArray(validValuesOrDefault)) {
    validValues = validValuesOrDefault;
    defaultTab = defaultOrParamName;
    key = paramName;
  } else {
    validValues = null;                            // loose mode
    defaultTab = validValuesOrDefault;
    key = defaultOrParamName || 'tab';
  }

  const [searchParams, setSearchParams] = useSearchParams();
  const urlValue = searchParams.get(key);
  const isValid = validValues ? validValues.includes(urlValue) : !!urlValue;
  const tab = isValid ? urlValue : defaultTab;

  const setTab = (next) => {
    const params = new URLSearchParams(searchParams);
    const allowed = validValues ? validValues.includes(next) : true;
    if (next === defaultTab || !allowed) params.delete(key);
    else params.set(key, next);
    setSearchParams(params, { replace: false });
  };

  return [tab, setTab];
}
