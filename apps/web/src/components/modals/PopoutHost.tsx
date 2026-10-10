import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useUI } from '@/stores/ui';
import { ProfileCard } from './Profile';
import { EmojiPicker } from '@/components/chat/EmojiPicker';
import { useIsMobile } from '@/lib/hooks';

export function PopoutHost() {
  const p = useUI((s) => s.popout); const close = useUI((s) => s.closePopout); const mobile = useIsMobile();
  const ref = useRef<HTMLDivElement>(null); const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!p || !ref.current || mobile) return;
    const w = ref.current.offsetWidth, h = ref.current.offsetHeight, r = p.rect;
    let left = p.kind === 'user' && r.left > window.innerWidth / 2 ? r.left - w - 8 : p.kind === 'user' ? r.right + 8 : r.right - w;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = p.kind === 'emoji' ? r.top - h - 8 : r.top;
    if (top < 8) top = p.kind === 'emoji' ? r.bottom + 8 : 8;
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    setPos({ left, top });
  }, [p, mobile]);
  useEffect(() => {
    if (!p) { setPos(null); return; }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const c = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    window.addEventListener('keydown', k); const t = setTimeout(() => window.addEventListener('mousedown', c), 0);
    return () => { window.removeEventListener('keydown', k); window.removeEventListener('mousedown', c); clearTimeout(t); };
  }, [p, close]);
  if (!p) return null;
  const content = p.kind === 'user' ? <div className="w-[min(340px,100vw-16px)] shadow-elev"><ProfileCard userId={p.userId} guildId={p.guildId} compact /></div>
    : <EmojiPicker guildId={p.guildId} allowGif allowSticker={p.stickers} onPick={(e) => { p.onPick(e); close(); }} />;
  if (mobile) return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end bg-black/50" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={ref} className="safe-bottom w-full animate-slideUp rounded-t-2xl bg-[rgb(var(--modal-alt))] p-2">{p.kind === 'user' ? <div className="mx-auto max-w-sm">{content}</div> : <div className="[&>div]:!w-full">{content}</div>}</div>
    </div>, document.body);
  return createPortal(<div ref={ref} className="fixed z-[70] animate-pop" style={{ left: pos?.left ?? -999, top: pos?.top ?? -999, visibility: pos ? 'visible' : 'hidden' }}>{content}</div>, document.body);
}
