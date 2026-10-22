import { VolumeX, Headphones, MicOff, PhoneOff, Volume2, ArrowRightLeft, Radio } from 'lucide-react';
import { Perm } from '@jorcord/shared';
import type { MenuItem } from '@/stores/ui';
import { useData, findChannel } from '@/stores/data';
import { toast, toastError } from '@/stores/ui';
import { api } from '@/lib/api';
import { can } from '@/lib/perms';
import { myChannelPerms } from '@/lib/session';
import { userMenu } from '@/lib/menus';
import { useUI } from '@/stores/ui';
import { t } from '@/i18n';
import { userPercent, isUserMuted, withUserVolume, withUserMuted } from './userAudio';

/** Context menu for a person in a voice channel: local volume, server-side moderation, then the usual user menu. */
export function voiceUserMenu(userId: string, channelId: string): MenuItem[] {
  const s = useData.getState(); const me = s.me?.id; const ch = findChannel(s, channelId);
  const guildId = ch?.guildId ?? null; const items: MenuItem[] = [];
  const st = s.voiceStates[userId];
  if (userId !== me) {
    const ui = useUI.getState(); const pr = ui.prefs; const pct = userPercent(pr, userId); const muted = isUserMuted(pr, userId);
    items.push(
      { label: t('User Volume'), icon: Volume2, slider: { value: muted ? 0 : pct, min: 0, max: 200, step: 5, label: t('User Volume'), format: (v) => `${v}%`, onChange: (v) => {
        const cur = useUI.getState().prefs;
        if (isUserMuted(cur, userId) && v > 0) useUI.getState().setPref('userMuted', withUserMuted(cur, userId, false));
        useUI.getState().setPref('userVolumes', withUserVolume(useUI.getState().prefs, userId, v));
      } } },
      { label: muted ? t('Unmute (just for me)') : t('Mute (just for me)'), icon: VolumeX, checked: muted, onClick: () => useUI.getState().setPref('userMuted', withUserMuted(useUI.getState().prefs, userId, !muted)) },
    );
  }
  if (userId !== me) {
    const sm = !!useUI.getState().prefs.soundboardMutedUsers[userId];
    items.push({ label: sm ? 'Unmute Soundboard Sounds' : 'Mute Soundboard Sounds', icon: VolumeX, checked: sm, onClick: () => { const p = useUI.getState().prefs; useUI.getState().setPref('soundboardMutedUsers', { ...p.soundboardMutedUsers, [userId]: !sm }); } });
  }
  if (guildId) {
    const perms = myChannelPerms(channelId); const mod: MenuItem[] = [];
    if (userId !== me && can(perms, Perm.MUTE_MEMBERS)) mod.push({ label: st?.serverMute ? 'Server Unmute' : 'Server Mute', icon: MicOff, danger: !st?.serverMute, onClick: () => api.voice.moderate(guildId, userId, { mute: !st?.serverMute }).catch(toastError) });
    if (userId !== me && can(perms, Perm.DEAFEN_MEMBERS)) mod.push({ label: st?.serverDeaf ? 'Server Undeafen' : 'Server Deafen', icon: Headphones, danger: !st?.serverDeaf, onClick: () => api.voice.moderate(guildId, userId, { deaf: !st?.serverDeaf }).catch(toastError) });
    if (userId !== me && can(perms, Perm.MOVE_MEMBERS)) {
      const others = Object.values(s.guilds[guildId]?.channels ?? {}).filter((c) => (c.type === 'voice' || c.type === 'stage') && c.id !== channelId);
      if (others.length) mod.push({ label: 'Move To', icon: ArrowRightLeft, children: others.map((c) => ({ label: c.name ?? 'channel', icon: c.type === 'stage' ? Radio : Volume2, onClick: () => api.voice.move(guildId, userId, c.id).then(() => toast(t('Moved'), 'success')).catch(toastError) })) });
      mod.push({ label: 'Disconnect', icon: PhoneOff, danger: true, onClick: () => api.voice.disconnect(guildId, userId).catch(toastError) });
    }
    if (mod.length) items.push({ separator: true }, ...mod);
  }
  if (items.length) items.push({ separator: true });
  return [...items, ...userMenu(userId, guildId)];
}
