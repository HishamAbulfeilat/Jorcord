import { Gamepad2, Headphones, Radio, Trophy, Tv } from 'lucide-react';
import type { Activity, Id } from '@jorcord/shared';
import { useData } from '@/stores/data';
import { activityElapsed, activityLabel, primaryActivity } from '@/lib/activity';
import { fileUrl } from '@/lib/format';
import { t } from '@/i18n';

const ICON = { playing: Gamepad2, listening: Headphones, watching: Tv, streaming: Radio, competing: Trophy } as const;
const EMPTY: Activity[] = [];
export const useActivities = (userId: Id) => useData((s) => s.activities[userId]) ?? EMPTY;

/** One-line "Playing Chess" for lists (member list, friends). Renders nothing when there is no activity. */
export function ActivityLine({ userId, className = 'block truncate text-xs text-muted' }: { userId: Id; className?: string }) {
  const a = primaryActivity(useActivities(userId));
  if (!a) return null;
  const Icon = ICON[a.type];
  return <span data-testid="activity-line" className={className}><Icon size={12} className="me-1 inline align-[-1px]" aria-hidden />{activityLabel(a)}</span>;
}

/** Profile section listing every activity with details and elapsed time. */
export function ActivityCards({ userId, fallback }: { userId: Id; fallback?: Activity[] }) {
  const live = useActivities(userId); const list = live.length ? live : fallback ?? live;
  if (!list.length) return null;
  return (
    <div className="mb-3" data-testid="activity-cards">
      <h4 className="mb-1 text-xs font-bold uppercase text-header">{t('Activity')}</h4>
      <ul className="space-y-1.5">{list.map((a, i) => {
        const Icon = ICON[a.type]; const img = fileUrl(a.largeImage);
        return (
          <li key={i} className="flex items-center gap-3 rounded bg-[rgb(var(--rail)/0.5)] p-2 text-sm">
            {img ? <img src={img} alt="" className="h-10 w-10 rounded object-cover" /> : <span className="flex h-10 w-10 items-center justify-center rounded bg-active text-header"><Icon size={20} /></span>}
            <span className="min-w-0 leading-tight"><span className="block truncate font-semibold text-header">{activityLabel(a)}</span>
              {a.details && <span className="block truncate text-xs text-normal">{a.details}</span>}{a.state && <span className="block truncate text-xs text-muted">{a.state}</span>}
              <span className="block text-xs text-muted">{activityElapsed(a.startedAt)}</span></span>
          </li>
        );
      })}</ul>
    </div>
  );
}
