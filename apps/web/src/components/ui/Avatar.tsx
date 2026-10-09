import type { Presence, User } from '@jorcord/shared';
import { cx, fileUrl, idColor, initials, displayName } from '@/lib/format';
import { useData } from '@/stores/data';
import { Moon, Minus } from 'lucide-react';

export const PRESENCE_COLOR: Record<string, string> = { online: '#23a559', idle: '#f0b232', dnd: '#f23f43', offline: '#80848e', invisible: '#80848e' };
export const PRESENCE_LABEL: Record<string, string> = { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', offline: 'Offline', invisible: 'Invisible' };

export function PresenceDot({ presence, size = 10, ring = 'rgb(var(--side))', className = '' }: { presence: Presence | undefined; size?: number; ring?: string; className?: string }) {
  const p = presence ?? 'offline';
  const color = PRESENCE_COLOR[p];
  return (
    <span role="img" aria-label={PRESENCE_LABEL[p]} className={cx('absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full', className)} style={{ width: size + 4, height: size + 4, background: ring }}>
      <span className="relative flex items-center justify-center rounded-full" style={{ width: size, height: size, background: p === 'idle' || p === 'dnd' || p === 'offline' || p === 'invisible' ? color : color }}>
        {p === 'idle' && <Moon size={size} fill="rgb(var(--side))" strokeWidth={0} className="absolute -left-[2px] -top-[2px]" style={{ color: 'rgb(var(--side))' }} />}
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
  const name = user ? displayName(user) : '?';
  return (
    <span className={cx('relative inline-flex shrink-0 select-none', className)} style={{ width: size, height: size }}>
      {url ? (
        <img src={url} alt="" loading="lazy" draggable={false} className="h-full w-full rounded-full object-cover" />
      ) : (
        <span aria-hidden className="flex h-full w-full items-center justify-center rounded-full font-semibold text-white" style={{ background: user ? idColor(user.id) : '#5865f2', fontSize: Math.max(10, size * 0.38) }}>
          {initials(name).slice(0, 2)}
        </span>
      )}
      {presence && <PresenceDot presence={online ?? live} size={Math.max(8, Math.round(size * 0.28))} ring={ring} />}
    </span>
  );
}
