import { useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { CornerUpLeft, Pencil, SmilePlus } from 'lucide-react';
import { useUI } from '@/stores/ui';
import { SWIPE_IGNORE, SWIPE_THRESHOLD, actionFor, classifySwipe, dragOffset, isHorizontalDrag, sanitizeSwipe, type SwipeAction, type SwipeCaps, type SwipeDir } from '@/lib/swipe';

type Touchy = { onTouchStart?: (e: TouchEvent) => void; onTouchMove?: (e: TouchEvent) => void; onTouchEnd?: (e: TouchEvent) => void; onTouchCancel?: (e: TouchEvent) => void };
export interface SwipeRun { reply(): void; react(): void; edit(): void }

const ICON: Record<Exclude<SwipeAction, 'none'>, typeof CornerUpLeft> = { reply: CornerUpLeft, react: SmilePlus, edit: Pencil };

/**
 * Touch swipe on a message row: drags the row with the finger, shows what will happen, and runs the configured
 * action (Settings > Appearance > Message gestures) when released past the threshold. `chain` is the long-press
 * menu trigger of the same row, so both keep working (the menu timer is cancelled by the same movement slop).
 */
export function useMessageSwipe(opts: { enabled: boolean; caps: SwipeCaps; run: SwipeRun }, chain: Touchy = {}) {
  const prefs = useUI((s) => s.prefs);
  const sw = sanitizeSwipe(prefs);
  const start = useRef<{ x: number; y: number; t: number } | null>(null);
  const dragging = useRef(false);
  const [hint, setHint] = useState<{ dir: SwipeDir; action: SwipeAction; armed: boolean } | null>(null);
  const reset = (el: HTMLElement | null) => { start.current = null; dragging.current = false; if (el) { el.style.transform = ''; el.style.transition = ''; } setHint(null); };

  if (!opts.enabled) return { bind: chain as Touchy, indicator: null as ReactNode };
  const bind: Touchy = {
    onTouchStart: (e) => {
      chain.onTouchStart?.(e);
      const tch = e.touches[0];
      if (e.touches.length !== 1 || !tch || (e.target as HTMLElement).closest(SWIPE_IGNORE)) { start.current = null; return; }
      start.current = { x: tch.clientX, y: tch.clientY, t: Date.now() }; dragging.current = false;
    },
    onTouchMove: (e) => {
      chain.onTouchMove?.(e);
      const s = start.current, tch = e.touches[0]; if (!s || !tch) return;
      const dx = tch.clientX - s.x, dy = tch.clientY - s.y;
      if (!dragging.current) {
        if (Math.abs(dy) > 12 && !isHorizontalDrag(dx, dy)) { start.current = null; return; } // it is a scroll
        if (!isHorizontalDrag(dx, dy)) return;
        dragging.current = true;
      }
      const dir: SwipeDir = dx > 0 ? 'right' : 'left'; const action = actionFor(dir, sw, opts.caps);
      const el = e.currentTarget as HTMLElement;
      if (action === 'none') { el.style.transform = ''; setHint((h) => (h ? null : h)); return; }
      el.style.transition = 'none'; el.style.transform = `translateX(${dragOffset(dx)}px)`;
      const armed = Math.abs(dx) >= SWIPE_THRESHOLD;
      setHint((h) => (h && h.dir === dir && h.action === action && h.armed === armed ? h : { dir, action, armed }));
    },
    onTouchEnd: (e) => {
      chain.onTouchEnd?.(e);
      const s = start.current; const el = e.currentTarget as HTMLElement;
      if (!s || !dragging.current) { reset(el); return; }
      const tch = e.changedTouches[0];
      const dir = tch ? classifySwipe(tch.clientX - s.x, tch.clientY - s.y, Date.now() - s.t) : null;
      el.style.transition = 'transform 160ms ease-out';
      reset(el);
      const action = dir ? actionFor(dir, sw, opts.caps) : 'none';
      if (action !== 'none') { navigator.vibrate?.(8); opts.run[action](); }
    },
    onTouchCancel: (e) => { chain.onTouchCancel?.(e); reset(e.currentTarget as HTMLElement); },
  };
  const Icon = hint && hint.action !== 'none' ? ICON[hint.action] : null;
  const indicator = hint && Icon ? (
    <span aria-hidden data-testid="swipe-hint" className={`pointer-events-none absolute top-1/2 z-10 -translate-y-1/2 rounded-full p-2 ${hint.armed ? 'bg-brand text-white' : 'bg-active text-muted'} ${hint.dir === 'right' ? 'start-1 -translate-x-[110%]' : 'end-1 translate-x-[110%]'}`}><Icon size={18} /></span>
  ) : null;
  return { bind, indicator };
}
