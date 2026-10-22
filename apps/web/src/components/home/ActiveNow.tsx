import { useMemo } from 'react';
import { useData } from '@/stores/data';
import { Avatar } from '@/components/ui/Avatar';
import { ActivityCards } from '@/components/ui/ActivityLine';
import { displayName } from '@/lib/format';
import { openDmWith } from '@/lib/menus';
import { t } from '@/i18n';

/** "Active Now": friends who are online and currently sharing an activity (rich presence), newest-listed first by name. */
export function ActiveNow() {
  const rels = useData((s) => s.relationships); const acts = useData((s) => s.activities); const presences = useData((s) => s.presences);
  const friends = useMemo(() => Object.values(rels)
    .filter((r) => r.type === 'friend' && (acts[r.user.id]?.length ?? 0) > 0 && presences[r.user.id] && presences[r.user.id] !== 'offline' && presences[r.user.id] !== 'invisible')
    .sort((a, b) => displayName(a.user).localeCompare(displayName(b.user))), [rels, acts, presences]);
  return (
    <aside aria-label={t('Active Now')} data-testid="active-now" className="scroller hidden w-[340px] shrink-0 border-s border-divider p-4 lg:block">
      <h2 className="mb-3 text-xl font-bold text-header">{t('Active Now')}</h2>
      {!friends.length && (
        <div className="rounded-lg p-2 text-center">
          <h3 className="font-semibold text-header">{t('It’s quiet for now…')}</h3>
          <p className="mt-1 text-sm text-muted">{t('When a friend starts an activity, like playing a game, we’ll show it here.')}</p>
        </div>
      )}
      <ul className="space-y-3">{friends.map((r) => (
        <li key={r.user.id}>
          <button type="button" onClick={() => openDmWith(r.user.id)} aria-label={t('Message {name}', { name: displayName(r.user) })} className="w-full rounded-lg bg-side p-3 text-start hover:bg-hover">
            <span className="mb-2 flex items-center gap-2"><Avatar user={r.user} size={32} presence /><span className="truncate font-semibold text-header">{displayName(r.user)}</span></span>
            <ActivityCards userId={r.user.id} />
          </button>
        </li>
      ))}</ul>
    </aside>
  );
}
