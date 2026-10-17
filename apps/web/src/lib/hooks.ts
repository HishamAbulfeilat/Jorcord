import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

export function useMedia(q: string) {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(q); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb); },
    () => window.matchMedia(q).matches, () => false);
}
export const useIsMobile = () => useMedia('(max-width: 767px)');
export const useIsNarrow = () => useMedia('(max-width: 1100px)');

export function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}
export function useOnClickOutside(ref: React.RefObject<HTMLElement>, fn: () => void, on = true) {
  useEffect(() => {
    if (!on) return;
    const h = (e: MouseEvent | TouchEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) fn(); };
    document.addEventListener('mousedown', h); document.addEventListener('touchstart', h);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('touchstart', h); };
  }, [ref, fn, on]);
}
export function useNow(intervalMs = 1000) {
  const [n, setN] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setN(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return n;
}
export function usePrevious<T>(v: T) { const r = useRef<T>(); useEffect(() => { r.current = v; }); return r.current; }

/**
 * Roving tabindex for a list of focusable items inside `ref` (WAI-ARIA list/toolbar pattern): exactly one item is in the tab order,
 * Arrow Up/Down (or Left/Right when horizontal), Home and End move focus. Works on the DOM so virtualised / dnd-managed lists need no changes;
 * a MutationObserver re-applies it as rows come and go. Tab leaves the list and returns to the last-focused item.
 */
export function useRovingTabindex(ref: React.RefObject<HTMLElement>, itemSelector: string, horizontal = false) {
  useEffect(() => {
    const root = ref.current; if (!root) return;
    let current: HTMLElement | null = null;
    const items = () => [...root.querySelectorAll<HTMLElement>(itemSelector)].filter((e) => !(e as HTMLButtonElement).disabled && e.getClientRects().length > 0);
    const apply = () => {
      const list = items(); if (!list.length) return;
      if (!current || !list.includes(current)) current = list.find((e) => e.getAttribute('aria-current') === 'page') ?? list[0]!;
      for (const e of list) { const want = e === current ? '0' : '-1'; if (e.getAttribute('tabindex') !== want) e.setAttribute('tabindex', want); }
    };
    const onFocusIn = (e: FocusEvent) => { const t = (e.target as HTMLElement).closest<HTMLElement>(itemSelector); if (t && t !== current) { current = t; apply(); } };
    const onKey = (e: KeyboardEvent) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>(itemSelector); if (!t || e.altKey || e.ctrlKey || e.metaKey) return;
      const prev = horizontal ? 'ArrowLeft' : 'ArrowUp', next = horizontal ? 'ArrowRight' : 'ArrowDown';
      const list = items(); const i = list.indexOf(t); if (i < 0) return;
      let j = -1;
      if (e.key === next) j = Math.min(list.length - 1, i + 1); else if (e.key === prev) j = Math.max(0, i - 1);
      else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = list.length - 1;
      if (j < 0) return; e.preventDefault(); current = list[j]!; apply(); current.focus(); current.scrollIntoView({ block: 'nearest' });
    };
    apply();
    const mo = new MutationObserver(apply); mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-current'] });
    root.addEventListener('focusin', onFocusIn); root.addEventListener('keydown', onKey);
    return () => { mo.disconnect(); root.removeEventListener('focusin', onFocusIn); root.removeEventListener('keydown', onKey); };
  }, [ref, itemSelector, horizontal]);
}
