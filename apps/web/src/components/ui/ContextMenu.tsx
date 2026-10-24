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
    const prev = document.activeElement as HTMLElement | null;
    const items = () => [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not([disabled]), input[type=range]') ?? [])];
    requestAnimationFrame(() => { if (!ref.current?.contains(document.activeElement)) items()[0]?.focus({ preventScroll: true }); });
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key === 'Tab') { close(); return; }
      const list = items(); if (!list.length || !ref.current) return;
      const i = list.indexOf(document.activeElement as HTMLElement);
      const go = (j: number) => { e.preventDefault(); e.stopPropagation(); list[(j + list.length) % list.length]?.focus(); };
      const rtl = document.dir === 'rtl';
      if (e.key === 'ArrowDown') go(i + 1); else if (e.key === 'ArrowUp') go(i < 0 ? -1 : i - 1);
      else if ((e.key === 'Home' || e.key === 'End') && (document.activeElement as HTMLInputElement | null)?.type === 'range') return; // slider: jump to min / max
      else if (e.key === 'Home') go(0); else if (e.key === 'End') go(list.length - 1);
      else if (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight') && (document.activeElement as HTMLElement | null)?.getAttribute('aria-haspopup') === 'menu') { e.preventDefault(); (document.activeElement as HTMLElement).click(); requestAnimationFrame(() => (document.activeElement as HTMLElement | null)?.parentElement?.querySelector<HTMLElement>('[role=menuitem] ~ div [role=menuitem], div [role=menuitem]')?.focus()); }
    };
    const c = (e: Event) => { if (!ref.current?.contains(e.target as Node)) close(); };
    window.addEventListener('keydown', k, true); window.addEventListener('mousedown', c); window.addEventListener('blur', close); window.addEventListener('resize', close);
    const sc = () => close(); window.addEventListener('wheel', sc, { passive: true });
    return () => { setTimeout(() => { const ae = document.activeElement; if ((!ae || ae === document.body) && prev?.isConnected) prev.focus({ preventScroll: true }); }, 0); window.removeEventListener('keydown', k, true); window.removeEventListener('mousedown', c); window.removeEventListener('blur', close); window.removeEventListener('resize', close); window.removeEventListener('wheel', sc); };
  }, [menu, close]);
  if (!menu) return null;
  const list = (
    <div ref={ref} role="menu" className={cx('animate-pop bg-float p-1.5 text-[14px] shadow-elev', mobile ? 'safe-bottom w-full rounded-t-xl pb-4' : 'w-[220px] max-w-[92vw] rounded-md')} style={mobile ? undefined : { position: 'fixed', left: pos.x || menu.x, top: pos.y || menu.y }}>
      {mobile && menu.items.some((i) => i.quick) && (
        <div className="mb-1 grid grid-cols-3 gap-1.5 p-1" data-testid="menu-quick">
          {menu.items.filter((i) => i.quick).map((it, i) => { const Icon = it.icon; return (
            <button key={i} role="menuitem" tabIndex={-1} onClick={() => { if (Date.now() - menu.t < 400) return; close(); it.onClick?.(); }} className="flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-lg bg-active px-1 text-xs font-semibold text-header">
              {Icon && <Icon size={20} />}<span className="truncate">{it.label}</span>
            </button>); })}
        </div>
      )}
      {menu.items.map((it, i) => (mobile && it.quick ? null : <Item key={i} it={it} mobile={mobile} close={close} openedAt={menu.t} />))}
    </div>
  );
  return createPortal(mobile
    ? <div className="fixed inset-0 z-[80] flex items-end bg-black/50" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>{list}</div>
    : <div className="fixed inset-0 z-[80] pointer-events-none"><div className="pointer-events-auto">{list}</div></div>, document.body);
}

function Item({ it, mobile, close, openedAt }: { it: MenuItem; mobile: boolean; close: () => void; openedAt: number }) {
  const [sub, setSub] = useState(false);
  if (it.separator) return <div role="separator" className="my-1 h-px bg-divider" />;
  if (it.slider) return <SliderRow s={it.slider} icon={it.icon} mobile={mobile} />;
  const Icon = it.icon;
  return (
    <div className="relative" onMouseEnter={() => it.children && setSub(true)} onMouseLeave={() => setSub(false)}>
      <button role="menuitem" tabIndex={-1} aria-haspopup={it.children ? 'menu' : undefined} aria-expanded={it.children ? sub : undefined} disabled={it.disabled} onClick={() => { if (Date.now() - openedAt < 400) return; /* finger-lift after a long press */ if (it.children) { setSub((v) => (mobile ? !v : true)); return; } close(); it.onClick?.(); }}
        className={cx('flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-start font-medium disabled:opacity-40', mobile && 'min-h-[44px] text-base',
          it.danger ? 'text-danger hover:bg-danger hover:text-white' : 'text-interactive hover:bg-brand hover:text-white')}>
        <span className="flex min-w-0 items-center gap-2">{Icon && <Icon size={16} className="shrink-0" />}<span className="truncate">{it.label}</span></span>
        <span className="flex items-center gap-1 text-xs opacity-70">{it.hint}{it.checked && <Check size={14} />}{it.children && <ChevronRight size={14} />}</span>
      </button>
      {sub && it.children && (
        <div className={cx('z-10 w-52 rounded-md bg-float p-1.5 shadow-elev', mobile ? 'mt-1' : 'absolute start-full top-0 ms-1')}>
          {it.children.map((c, i) => <Item key={i} it={c} mobile={mobile} close={close} openedAt={openedAt} />)}
        </div>
      )}
    </div>
  );
}

/** Inline slider row. Local state so dragging is live even though the menu items are built once. */
function SliderRow({ s, icon: Icon, mobile }: { s: NonNullable<MenuItem['slider']>; icon?: any; mobile: boolean }) {
  const [v, setV] = useState(s.value);
  const text = s.format ? s.format(v) : String(v);
  return (
    <div className={cx('px-2 py-1.5', mobile && 'min-h-[44px]')}>
      <label className="flex items-center justify-between gap-2 text-sm font-medium text-interactive">
        <span className="flex items-center gap-2">{Icon && <Icon size={16} className="shrink-0" />}{s.label}</span>
        <output className="tabular-nums text-xs opacity-80" aria-hidden>{text}</output>
      </label>
      <input type="range" aria-label={s.label} aria-valuetext={text} min={s.min} max={s.max} step={s.step ?? 1} value={v} className="mt-1 w-full accent-brand"
        onChange={(e) => { const n = Number(e.target.value); setV(n); s.onChange(n); }} />
    </div>
  );
}
