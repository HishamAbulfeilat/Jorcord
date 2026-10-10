import { CheckCircle2, Info, XCircle } from 'lucide-react';
import { useUI } from '@/stores/ui';
import { cx } from '@/lib/format';

export function Toasts() {
  const toasts = useUI((s) => s.toasts); const dismiss = useUI((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 sm:items-end" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 76px)' }} role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} onClick={() => dismiss(t.id)} className={cx('pointer-events-auto flex max-w-sm animate-slideUp items-center gap-2 rounded-md bg-float px-4 py-3 text-start text-sm font-medium text-header shadow-elev border-s-4', t.kind === 'error' ? 'border-danger' : t.kind === 'success' ? 'border-success' : 'border-brand')}>
          {t.kind === 'error' ? <XCircle size={18} className="text-danger" /> : t.kind === 'success' ? <CheckCircle2 size={18} className="text-success" /> : <Info size={18} className="text-brand" />}
          {t.text}
        </button>
      ))}
    </div>
  );
}
