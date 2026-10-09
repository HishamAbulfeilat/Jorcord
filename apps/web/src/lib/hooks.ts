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
