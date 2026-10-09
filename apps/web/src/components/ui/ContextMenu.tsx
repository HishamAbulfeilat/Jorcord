import { useEffect, useLayoutEffect, useRef, useState, type TouchEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from 'lucide-react';
import { useUI, type MenuItem } from '@/stores/ui';
import { cx } from '@/lib/format';
import { useIsMobile } from '@/lib/hooks';

export function useMenuTrigger(build: () => MenuItem[]) {
  const open = useUI((s) => s.openMenu);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const start = useRef<{ x: number; y: number } | null>(null);
  const clear = () => { clearTimeout(timer.current); start.current = null; };
  return {
    onContextMenu: (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); open(e.clientX, e.clientY, build()); },
    onTouchStart: (e: TouchEvent) => {
      const t = e.touches[0]; start.current = { x: t.clientX, y: t.clientY };
      timer.current = setTimeout(() => { navigator.vibrate?.(8); open(t.clientX, t.clientY, build()); start.current = null; }, 480);
    },
    onTouchMove: (e: TouchEvent) => { const t = e.touches[0]; if (start.current && Math.hypot(t.clientX - start.current.x, t.clientY - start.current.y) > 10) clear(); },
    onTouchEnd: clear, onTouchCancel: clear,
  };
}

export function ContextMenuHost() {
  const menu = useUI((s) => s.menu); const close = useUI((s) => s.closeMenu);
  const mobile = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!menu || !ref.current || mobile) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(menu.x, window.innerWidth - r.width - 8), y: Math.min(menu.y, window.innerHeight - r.height - 8) });
  }, [menu, mobile]);
  useEffect(() => {
    if (!menu) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const c = (e: Event) => { if (!ref.current?.contains(e.target as Node)) close(); };
    window.addEventListener('keydown', k); window.addEventListener('mousedown', c); window.addEventListener('blur', close); window.addEventListener('resize', close);
    const sc = () => close(); window.addEventListener('wheel', sc, { passive: true });
    return () => { window.removeEventListener('keydown', k); window.removeEventListener('mousedown', c); window.removeEventListener('blur', close); window.removeEventListener('resize', close); window.removeEventListener('wheel', sc); };
  }, [menu, close]);
  if (!menu) return null;
  const list = (
    <div ref={ref} role="menu" className={cx('animate-pop bg-float p-1.5 text-[14px] shadow-elev', mobile ? 'safe-bottom w-full rounded-t-xl pb-4' : 'w-[220px] max-w-[92vw] rounded-md')} style={mobile ? undefined : { position: 'fixed', left: pos.x || menu.x, top: pos.y || menu.y }}>
      {menu.items.map((it, i) => <Item key={i} it={it} mobile={mobile} close={close} openedAt={menu.t} />)}
    </div>
  );
  return createPortal(mobile
    ? <div className="fixed inset-0 z-[80] flex items-end bg-black/50" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>{list}</div>
    : <div className="fixed inset-0 z-[80] pointer-events-none"><div className="pointer-events-auto">{list}</div></div>, document.body);
}

function Item({ it, mobile, close, openedAt }: { it: MenuItem; mobile: boolean; close: () => void; openedAt: number }) {
  const [sub, setSub] = useState(false);
  if (it.separator) return <div role="separator" className="my-1 h-px bg-divider" />;
  const Icon = it.icon;
  return (
    <div className="relative" onMouseEnter={() => it.children && setSub(true)} onMouseLeave={() => setSub(false)}>
      <button role="menuitem" disabled={it.disabled} onClick={() => { if (Date.now() - openedAt < 400) return; /* finger-lift after a long press */ if (it.children) { setSub((v) => (mobile ? !v : true)); return; } close(); it.onClick?.(); }}
        className={cx('flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left font-medium disabled:opacity-40', mobile && 'min-h-[44px] text-base',
          it.danger ? 'text-danger hover:bg-danger hover:text-white' : 'text-interactive hover:bg-brand hover:text-white')}>
        <span className="flex min-w-0 items-center gap-2">{Icon && <Icon size={16} className="shrink-0" />}<span className="truncate">{it.label}</span></span>
        <span className="flex items-center gap-1 text-xs opacity-70">{it.hint}{it.checked && <Check size={14} />}{it.children && <ChevronRight size={14} />}</span>
      </button>
      {sub && it.children && (
        <div className={cx('z-10 w-52 rounded-md bg-float p-1.5 shadow-elev', mobile ? 'mt-1' : 'absolute left-full top-0 ml-1')}>
          {it.children.map((c, i) => <Item key={i} it={c} mobile={mobile} close={close} openedAt={openedAt} />)}
        </div>
      )}
    </div>
  );
}
