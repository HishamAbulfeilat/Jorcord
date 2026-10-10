import type { Presence, User } from '@jorcord/shared';
import { cx, fileUrl, idColor, initials, displayName } from '@/lib/format';
import { useData } from '@/stores/data';
import { Moon, Minus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useUI } from '@/stores/ui';
import { t, T } from '@/i18n';

export const isAnimatedUrl = (u: string | null | undefined) => !!u && /\.(gif|apng|webp)(\?|#|$)/i.test(u);
const stills = new Map<string, string | null>();
/** First frame of an animated image as a data URL (null if the browser refuses: cross-origin without CORS). */
function useStill(src: string | null, enabled: boolean): string | null {
  const [still, setStill] = useState<string | null>(src ? stills.get(src) ?? null : null);
  useEffect(() => {
    if (!enabled || !src) return;
    if (stills.has(src)) { setStill(stills.get(src)!); return; }
    let dead = false; const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => { try { const c = document.createElement('canvas'); c.width = img.naturalWidth || 128; c.height = img.naturalHeight || 128; c.getContext('2d')!.drawImage(img, 0, 0); const d = c.toDataURL('image/png'); stills.set(src, d); if (!dead) setStill(d); } catch { stills.set(src, null); } };
    img.onerror = () => { stills.set(src, null); };
    img.src = src; return () => { dead = true; };
  }, [src, enabled]);
  return enabled ? still : null;
}

export const PRESENCE_COLOR: Record<string, string> = { online: '#23a559', idle: '#f0b232', dnd: '#f23f43', offline: '#80848e', invisible: '#80848e' };
export const PRESENCE_LABEL: Record<string, string> = { online: T('Online'), idle: T('Idle'), dnd: T('Do Not Disturb'), offline: T('Offline'), invisible: T('Invisible') };

export function PresenceDot({ presence, size = 10, ring = 'rgb(var(--side))', className = '' }: { presence: Presence | undefined; size?: number; ring?: string; className?: string }) {
  const p = presence ?? 'offline';
  const color = PRESENCE_COLOR[p];
  return (
    <span role="img" aria-label={t(PRESENCE_LABEL[p] ?? 'Offline')} className={cx('absolute -bottom-0.5 -end-0.5 flex items-center justify-center rounded-full', className)} style={{ width: size + 4, height: size + 4, background: ring }}>
      <span className="relative flex items-center justify-center rounded-full" style={{ width: size, height: size, background: p === 'idle' || p === 'dnd' || p === 'offline' || p === 'invisible' ? color : color }}>
        {p === 'idle' && <Moon size={size} fill="rgb(var(--side))" strokeWidth={0} className="absolute -start-[2px] -top-[2px]" style={{ color: 'rgb(var(--side))' }} />}
        {p === 'dnd' && <Minus size={size - 2} strokeWidth={5} style={{ color: 'rgb(var(--side))' }} />}
        {(p === 'offline' || p === 'invisible') && <span className="rounded-full" style={{ width: size / 2.2, height: size / 2.2, background: ring }} />}
      </span>
    </span>
  );
}

interface Props { user?: Pick<User, 'id' | 'username' | 'displayName' | 'avatar'> | null; size?: number; presence?: boolean; ring?: string; className?: string; memberAvatar?: string | null; online?: Presence }
export function Avatar({ user, size = 40, presence, ring, className = '', memberAvatar, online }: Props) {
  const live = useData((s) => (presence && user ? s.presences[user.id] : undefined));
  const url = fileUrl(memberAvatar ?? user?.avatar);
  const autoplay = useUI((s) => s.prefs.autoplayGifs); const [hover, setHover] = useState(false);
  const animated = isAnimatedUrl(url); const still = useStill(url, animated && !autoplay && !hover);
  const name = user ? displayName(user) : '?';
  return (
    <span className={cx('relative inline-flex shrink-0 select-none', className)} style={{ width: size, height: size }} onMouseEnter={animated ? () => setHover(true) : undefined} onMouseLeave={animated ? () => setHover(false) : undefined} data-animated={animated || undefined}>
      {url ? (
        <img src={still ?? url} alt="" loading="lazy" draggable={false} className="h-full w-full rounded-full object-cover" />
      ) : (
        <span aria-hidden className="flex h-full w-full items-center justify-center rounded-full font-semibold text-white" style={{ background: user ? idColor(user.id) : '#5865f2', fontSize: Math.max(10, size * 0.38) }}>
          {initials(name).slice(0, 2)}
        </span>
      )}
      {presence && <PresenceDot presence={online ?? live} size={Math.max(8, Math.round(size * 0.28))} ring={ring} />}
    </span>
  );
}
