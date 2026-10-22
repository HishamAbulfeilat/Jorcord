import { BadgeCheck, Bug, Code2, Handshake, Shield, ShieldCheck, Sparkles } from 'lucide-react';
import { userBadges, type UserFlagName } from '@jorcord/shared';
import { t } from '@/i18n';

const ICONS: Record<UserFlagName, typeof Shield> = {
  STAFF: Shield, PARTNER: Handshake, BUG_HUNTER: Bug, EARLY_SUPPORTER: Sparkles, VERIFIED_BOT: BadgeCheck, CERTIFIED_MODERATOR: ShieldCheck, ACTIVE_DEVELOPER: Code2,
};

/** Profile badges for `User.publicFlags`. Renders nothing when the user has none. */
export function UserBadges({ flags, className = '' }: { flags?: number | null; className?: string }) {
  const list = userBadges(flags);
  if (!list.length) return null;
  return (
    <ul aria-label={t('Badges')} className={`flex flex-wrap gap-1.5 ${className}`}>
      {list.map((b) => {
        const Icon = ICONS[b.flag];
        return <li key={b.flag} title={`${b.label}: ${b.description}`} aria-label={b.label} className="flex h-6 w-6 items-center justify-center rounded-full bg-active text-brand"><Icon size={14} aria-hidden /></li>;
      })}
    </ul>
  );
}
