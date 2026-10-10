import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';

/** `lazy()` for a named export: `const X = lazyNamed(() => import('./X'), 'X')`. */
export function lazyNamed<M extends Record<string, any>, K extends keyof M>(load: () => Promise<M>, name: K) {
  return lazy(async () => ({ default: (await load())[name] as ComponentType<any> }));
}
/** Suspense with an optional fallback (default: nothing, so overlays that load on demand do not flash). */
export const Lazy = ({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) => <Suspense fallback={fallback}>{children}</Suspense>;
