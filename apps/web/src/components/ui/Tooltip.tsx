import type { ReactNode } from 'react';
export function Tip({ text, children, side = 'right' }: { text: string; children: ReactNode; side?: 'right' | 'top' | 'bottom' | 'left' }) {
  const pos = { right: 'left-full top-1/2 -translate-y-1/2 ml-3', left: 'right-full top-1/2 -translate-y-1/2 mr-3', top: 'bottom-full left-1/2 -translate-x-1/2 mb-2', bottom: 'top-full left-1/2 -translate-x-1/2 mt-2' }[side];
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span role="tooltip" className={`pointer-events-none absolute z-50 hidden whitespace-nowrap rounded bg-float px-3 py-1.5 text-sm font-semibold text-header shadow-high group-hover/tip:md:block ${pos}`}>{text}</span>
    </span>
  );
}
