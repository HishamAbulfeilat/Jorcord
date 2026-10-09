import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ChevronRight, X } from 'lucide-react';
import { cx } from '@/lib/format';
import { useIsMobile } from '@/lib/hooks';

export interface NavItem { id: string; label: string; icon?: any; danger?: boolean }
export interface NavGroup { title?: string; items: NavItem[] }

export function SettingsLayout({ title, groups, tab, onTab, onClose, children, footerNav }: { title: string; groups: NavGroup[]; tab: string; onTab: (t: string) => void; onClose: () => void; children: ReactNode; footerNav?: ReactNode }) {
  const mobile = useIsMobile(); const [showNav, setShowNav] = useState(true);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('[role=dialog][aria-modal]')) onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const nav = (
    <nav aria-label={title} className="scroller flex h-full w-full flex-col bg-side px-3 py-6 md:w-[232px] md:shrink-0 md:items-end md:px-1.5 md:py-[60px] lg:w-[300px]">
      <div className="w-full md:w-[192px]">
        <h2 className="mb-1 truncate px-2.5 text-xs font-bold uppercase tracking-wide text-muted md:hidden">{title}</h2>
        {groups.map((g, gi) => (
          <div key={gi} className="mb-2">
            {g.title && <div className="truncate px-2.5 pb-1.5 pt-1.5 text-xs font-bold uppercase tracking-wide text-muted">{g.title}</div>}
            {g.items.map((it) => (
              <button key={it.id} aria-current={tab === it.id ? 'page' : undefined} onClick={() => { onTab(it.id); setShowNav(false); }}
                className={cx('touch mb-0.5 flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-base font-medium md:min-h-[32px]', tab === it.id && !mobile ? 'bg-active text-header' : it.danger ? 'text-danger hover:bg-hover' : 'text-interactive hover:bg-hover hover:text-interactive-hover')}>
                <span className="flex items-center gap-2">{it.icon && <it.icon size={18} />}{it.label}</span><ChevronRight size={16} className="md:hidden" />
              </button>
            ))}
            {gi < groups.length - 1 && <hr className="mx-2.5 mt-2 border-divider" />}
          </div>
        ))}
        {footerNav}
      </div>
    </nav>
  );
  return createPortal(
    <div className="fixed inset-0 z-[55] flex animate-pop bg-chat" role="dialog" aria-modal="true" aria-label={title}>
      {(!mobile || showNav) && <div className={cx(mobile ? 'w-full' : 'contents')}>
        {mobile && <div className="absolute right-3 z-10" style={{ top: 'calc(var(--sat) + 8px)' }}><button aria-label="Close settings" onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-full text-interactive"><X size={24} /></button></div>}
        {nav}
      </div>}
      {(!mobile || !showNav) && (
        <div className="scroller relative min-w-0 flex-1 bg-chat safe-top">
          {mobile && <button onClick={() => setShowNav(true)} className="sticky top-0 z-10 flex h-12 w-full items-center gap-2 bg-chat px-3 font-semibold text-header"><ArrowLeft size={20} />Back</button>}
          <div className="mx-auto max-w-[740px] px-4 pb-24 pt-4 md:px-10 md:pt-[60px]">{children}</div>
          {!mobile && <div className="fixed right-6 top-[60px] flex flex-col items-center gap-1"><button onClick={onClose} aria-label="Close settings" className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-interactive text-interactive hover:bg-hover hover:text-header"><X size={18} /></button><span className="text-xs font-bold text-muted">ESC</span></div>}
        </div>
      )}
    </div>, document.body);
}

export const H1 = ({ children }: { children: ReactNode }) => <h1 className="mb-5 text-xl font-bold text-header">{children}</h1>;
export const H3 = ({ children }: { children: ReactNode }) => <h3 className="mb-2 mt-6 text-xs font-bold uppercase tracking-wide text-interactive">{children}</h3>;

export function SaveBar({ dirty, onSave, onReset, busy }: { dirty: boolean; onSave: () => void; onReset: () => void; busy?: boolean }) {
  if (!dirty) return null;
  return createPortal(
    <div className="fixed inset-x-3 bottom-4 z-[58] mx-auto flex max-w-[700px] animate-slideUp items-center justify-between gap-3 rounded-md bg-[rgb(var(--float))] p-2.5 pl-4 shadow-elev" role="alert" style={{ marginBottom: 'var(--sab)' }}>
      <span className="text-sm text-header">Careful — you have unsaved changes!</span>
      <span className="flex items-center gap-2"><button className="btn btn-link" onClick={onReset}>Reset</button><button className="btn btn-primary" disabled={busy} onClick={onSave}>Save Changes</button></span>
    </div>, document.body);
}
