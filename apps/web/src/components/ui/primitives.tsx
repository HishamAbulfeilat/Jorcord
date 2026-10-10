import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2 } from 'lucide-react';
import { cx } from '@/lib/format';
import { t } from '@/i18n';

export const Spinner = ({ size = 20, className = '' }: { size?: number; className?: string }) => <Loader2 size={size} className={cx('animate-spin text-muted', className)} aria-label={t('Loading')} />;

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cx('relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:opacity-50', checked ? 'bg-success' : 'bg-[rgb(var(--active))]')}>
      <span className={cx('absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all', checked ? 'start-[19px]' : 'start-[3px]')} />
    </button>
  );
}

export function Row({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-divider/60 py-3">
      <div className="min-w-0"><div className="font-medium text-header">{title}</div>{desc && <div className="text-sm text-muted">{desc}</div>}</div>
      {children}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, width = 440, labelledBy, padded = true }: { title?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number; labelledBy?: string; padded?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input,textarea,select,button:not([data-close])');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab' && ref.current) {
        const f = [...ref.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),textarea,select,[tabindex]:not([tabindex="-1"])')];
        if (!f.length) return;
        const a = f[0], z = f[f.length - 1];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
        else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); prev?.focus?.(); };
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? 'modal-title'} style={{ maxWidth: width }}
        className="flex max-h-[92dvh] w-full animate-pop flex-col overflow-hidden rounded-t-xl bg-modal shadow-elev sm:rounded-md">
        {title && (
          <div className="relative px-4 pt-5 text-center sm:px-6">
            <h2 id="modal-title" className="text-xl font-bold text-header">{title}</h2>
            <button data-close aria-label={t('Close')} onClick={onClose} className="absolute end-3 top-3 flex h-8 w-8 items-center justify-center rounded text-interactive hover:text-interactive-hover"><X size={20} /></button>
          </div>
        )}
        <div className={cx('scroller min-h-0 flex-1', padded && 'p-4 sm:p-6')}>{children}</div>
        {footer && <div className="flex flex-col-reverse items-stretch justify-end gap-2 bg-modal-alt p-4 sm:flex-row sm:items-center">{footer}</div>}
      </div>
    </div>, document.body);
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: string; badge?: number }[]; value: T; onChange: (t: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto scroller-hide">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={cx('touch flex shrink-0 items-center gap-2 rounded px-3 text-[15px] font-medium sm:min-h-[32px]', value === t.id ? 'bg-active text-header' : 'text-interactive hover:bg-hover hover:text-interactive-hover')}>
          {t.label}{!!t.badge && <span className="rounded-full bg-danger px-1.5 text-xs font-bold text-white">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center text-muted">{icon}<div className="font-semibold text-header">{title}</div>{children && <div className="text-sm">{children}</div>}</div>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="mb-4 block"><span className="label">{label}</span>{children}{hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}</label>;
}

export function Badge({ n, className = '' }: { n: number; className?: string }) {
  if (!n) return null;
  return <span aria-label={`${n} mentions`} className={cx('inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[11px] font-bold leading-none text-white', className)}>{n > 99 ? '99+' : n}</span>;
}
