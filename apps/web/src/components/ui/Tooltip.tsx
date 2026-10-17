import type { ReactNode } from 'react';
/** Discord-style tooltip: dark pill with a small arrow, shown on hover (pointer devices) and on keyboard focus; the trigger carries its own aria-label. */
export function Tip({ text, children, side = 'right' }: { text: string; children: ReactNode; side?: 'right' | 'top' | 'bottom' | 'left' }) {
  const pos = { right: 'start-full top-1/2 -translate-y-1/2 ms-3', left: 'end-full top-1/2 -translate-y-1/2 me-3', top: 'bottom-full start-1/2 -translate-x-1/2 rtl:translate-x-1/2 mb-2', bottom: 'top-full start-1/2 -translate-x-1/2 rtl:translate-x-1/2 mt-2' }[side];
  const arrow = { right: 'end-full top-1/2 -mt-1 border-e-[rgb(var(--float))] border-y-transparent border-s-0', left: 'start-full top-1/2 -mt-1 border-s-[rgb(var(--float))] border-y-transparent border-e-0', top: 'top-full start-1/2 -ms-1 border-t-[rgb(var(--float))] border-x-transparent border-b-0', bottom: 'bottom-full start-1/2 -ms-1 border-b-[rgb(var(--float))] border-x-transparent border-t-0' }[side];
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span role="tooltip" className={`pointer-events-none absolute z-50 hidden whitespace-nowrap rounded-md bg-float px-3 py-1.5 text-sm font-semibold text-header shadow-high ring-1 ring-black/10 group-hover/tip:md:block group-focus-within/tip:md:block ${pos}`}>
        {text}<span aria-hidden className={`absolute h-0 w-0 border-4 ${arrow}`} />
      </span>
    </span>
  );
}
