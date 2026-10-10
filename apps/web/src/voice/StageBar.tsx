/** Stage instance topic / start / end controls (docs/CONTRACT.md "Stage instances"). Moderator = MANAGE_CHANNELS + MUTE_MEMBERS + MOVE_MEMBERS in the channel. */
import { useEffect } from 'react';
import { Mic2, Pencil, Radio, Square } from 'lucide-react';
import { Perm } from '@jorcord/shared';
import type { Channel } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useUI, toastError } from '@/stores/ui';
import { usePlatform } from '@/stores/platform';
import { can } from '@/lib/perms';
import { myChannelPerms } from '@/lib/session';
import { useData } from '@/stores/data';
import { t } from '@/i18n';

export const canModerateStage = (channelId: string) => can(myChannelPerms(channelId), Perm.MANAGE_CHANNELS, Perm.MUTE_MEMBERS, Perm.MOVE_MEMBERS);

/** Loads the live instance of one stage channel (404 = none) and keeps the store in sync. */
export function useStageInstance(channel: Channel) {
  const stage = usePlatform((s) => s.stages[channel.id]);
  useEffect(() => {
    if (channel.type !== 'stage') return;
    let dead = false;
    api.stages.get(channel.id).then((s) => { if (!dead) usePlatform.getState().setStage(s); }).catch(() => { if (!dead) usePlatform.getState().removeStage(channel.id); });
    return () => { dead = true; };
  }, [channel.id, channel.type]);
  return stage;
}

/** Fetches every live stage of the guild once, for the sidebar's "live" markers. */
export function useGuildStages(guildId: string | undefined) {
  const loaded = usePlatform((s) => (guildId ? !!s.stagesLoaded[guildId] : true));
  const channels = useData((s) => (guildId ? s.guilds[guildId]?.channels : undefined));
  useEffect(() => {
    if (!guildId || loaded || !channels) return;
    usePlatform.setState((s) => ({ stagesLoaded: { ...s.stagesLoaded, [guildId]: true } }));
    const ids = Object.values(channels).filter((c) => c.type === 'stage').map((c) => c.id);
    if (!ids.length) return;
    api.guilds.stageInstances(guildId).then((l) => usePlatform.getState().setStages(guildId, l, ids)).catch(() => {});
  }, [guildId, loaded, channels]);
}

export function StageBar({ channel }: { channel: Channel }) {
  const stage = useStageInstance(channel); const openModal = useUI((s) => s.openModal); const mod = canModerateStage(channel.id);
  if (!stage && !mod) return <div data-testid="stage-bar" className="flex items-center gap-2 border-b border-divider bg-side px-4 py-2 text-sm text-muted"><Radio size={16} aria-hidden />{t('This stage is not live yet.')}</div>;
  if (!stage) return (
    <div data-testid="stage-bar" className="flex flex-wrap items-center gap-3 border-b border-divider bg-side px-4 py-2">
      <span className="flex items-center gap-2 text-sm text-muted"><Radio size={16} aria-hidden />{t('This stage is not live yet.')}</span>
      <button className="btn btn-primary ms-auto" onClick={() => openModal({ kind: 'stage', channelId: channel.id, mode: 'start' })}><Mic2 size={14} />{t('Start Stage')}</button>
    </div>
  );
  return (
    <div data-testid="stage-bar" className="flex flex-wrap items-center gap-3 border-b border-divider bg-side px-4 py-2">
      <span className="rounded bg-danger px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">{t('Live')}</span>
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-header" data-testid="stage-topic" title={stage.topic}>{stage.topic}</span>
      {mod && <>
        <button className="btn btn-secondary" aria-label={t('Edit topic')} onClick={() => openModal({ kind: 'stage', channelId: channel.id, mode: 'edit' })}><Pencil size={14} />{t('Edit topic')}</button>
        <button className="btn btn-danger" onClick={() => openModal({ kind: 'confirm', title: 'End Stage', body: 'End this stage for everyone? Speakers are moved back to the audience and the topic is cleared.', confirmLabel: 'End stage', danger: true, onConfirm: () => api.stages.end(channel.id).then(() => usePlatform.getState().removeStage(channel.id)).catch(toastError) })}><Square size={14} />{t('End Stage')}</button>
      </>}
    </div>
  );
}
