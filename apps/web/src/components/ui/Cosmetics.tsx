import { Crown, Flame, Gem, Heart, Leaf, Moon, PawPrint, Skull, Star, Sun, Swords, Zap } from 'lucide-react';
import type { ServerTag } from '@jorcord/shared';
import { cx } from '@/lib/format';

/** Ring drawn around an avatar (the parent must be `relative`). */
export function AvatarDecoration({ id, size }: { id: string | null | undefined; size: number }) {
  if (!id || size < 20) return null;
  return <span aria-hidden data-deco={id} className={cx('deco', `deco-${id}`)} style={{ ['--w' as string]: `${Math.max(2, Math.round(size * 0.075))}px` }} />;
}
/** Animated overlay for the top of a profile card. */
export function ProfileEffect({ id }: { id: string | null | undefined }) {
  if (!id) return null;
  return <span aria-hidden data-effect={id} className={cx('fx', `fx-${id}`)} />;
}
export const plateClass = (id: string | null | undefined) => (id ? `plate plate-${id}` : '');

const ICONS = { sword: Swords, leaf: Leaf, star: Star, flame: Flame, bolt: Zap, heart: Heart, skull: Skull, crown: Crown, gem: Gem, moon: Moon, sun: Sun, paw: PawPrint } as const;
/** "[ABCD]" chip beside a name. */
export function ServerTagBadge({ tag, className }: { tag: ServerTag | null | undefined; className?: string }) {
  if (!tag) return null;
  const Icon = tag.badge ? ICONS[tag.badge as keyof typeof ICONS] : undefined;
  return <span data-testid="server-tag" title={tag.tag} className={cx('inline-flex shrink-0 items-center gap-0.5 rounded bg-[rgb(var(--active))] px-1 text-[11px] font-bold leading-4 text-header', className)}>{Icon && <Icon size={10} aria-hidden />}{tag.tag}</span>;
}
export { ICONS as TAG_ICONS };
