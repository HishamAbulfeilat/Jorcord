import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Trash2 } from 'lucide-react';
import type { Id } from '@jorcord/shared';
import { api } from '@/lib/api';
import { toast, toastError } from '@/stores/ui';
import { H3 } from './SettingsLayout';
import { t } from '@/i18n';

/** Channel Settings > Integrations: channels that follow this announcement channel, and announcement channels this channel follows. */
export function FollowsList({ channelId, announcement }: { channelId: Id; announcement: boolean }) {
  const qc = useQueryClient();
  const following = useQuery({ queryKey: ['follows', channelId], queryFn: () => api.channels.follows(channelId), retry: false });
  const followers = useQuery({ queryKey: ['followers', channelId], enabled: announcement, queryFn: () => api.channels.followers(channelId), retry: false });
  const drop = (id: Id) => api.channels.unfollow(id).then(() => { void qc.invalidateQueries({ queryKey: ['follows', channelId] }); void qc.invalidateQueries({ queryKey: ['followers', channelId] }); toast(t('Unfollowed'), 'success'); }).catch(toastError);
  return (
    <div data-testid="follows-list">
      <H3>{t('Followed channels')}</H3>
      {!following.data?.length && <p className="text-sm text-muted">{t('This channel does not follow any announcement channel. Use Follow Channel on one to get its news here.')}</p>}
      <ul>{following.data?.map((f) => (
        <li key={f.id} className="flex items-center gap-3 border-b border-divider/50 py-2"><Megaphone size={16} className="text-muted" /><span className="flex-1 truncate text-sm">{f.source?.guildName} · #{f.source?.channelName}</span><button aria-label={`${t('Unfollow')} ${f.source?.channelName}`} className="p-2 text-danger" onClick={() => void drop(f.id)}><Trash2 size={16} /></button></li>
      ))}</ul>
      {announcement && (<>
        <H3>{t('Followers')}</H3>
        {!followers.data?.length && <p className="text-sm text-muted">{t('Nobody follows this channel yet.')}</p>}
        <ul>{followers.data?.map((f) => (
          <li key={f.id} className="flex items-center gap-3 border-b border-divider/50 py-2"><span className="flex-1 truncate text-sm">{f.target?.guildName} · #{f.target?.channelName}</span><button aria-label={`${t('Remove follower')} ${f.target?.channelName}`} className="p-2 text-danger" onClick={() => void drop(f.id)}><Trash2 size={16} /></button></li>
        ))}</ul>
      </>)}
    </div>
  );
}
