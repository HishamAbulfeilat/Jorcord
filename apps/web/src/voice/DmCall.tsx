import { Phone, PhoneCall, Video } from 'lucide-react';
import type { Channel } from '@jorcord/shared';
import { useVoiceSnapshot } from '@jorcord/voice/react';
import { useUI } from '@/stores/ui';
import { useData } from '@/stores/data';
import { useVoiceUI } from '@/stores/voiceui';
import { displayName } from '@/lib/format';
import { Avatar } from '@/components/ui/Avatar';
import { ControlBar } from './controls';
import { CallSurface, VoiceBanners } from './Room';
import { joinVoice, setCameraOn } from './controller';
import { useChannelVoiceUsers } from './views';
import { t } from '@/i18n';

export async function startCall(channelId: string, video: boolean) {
  await joinVoice(channelId);
  if (video) await setCameraOn(true);
}

/** Call / video-call buttons for DM headers (rendered by ChatView's header). */
export function useDmCallState(channel: Channel) {
  const users = useChannelVoiceUsers(channel.id);
  const inHere = useVoiceUI((s) => s.connectedChannelId === channel.id && s.conn !== 'idle');
  return { users, inHere };
}

/** Call surface at the top of a DM / group DM while a call is active. */
export function DmCallPanel({ channel }: { channel: Channel }) {
  const { users, inHere } = useDmCallState(channel);
  const me = useData((s) => s.me?.id);
  const snap = useVoiceSnapshot(); const openModal = useUI((s) => s.openModal);
  const conn = useVoiceUI((s) => s.conn);
  if (!inHere && users.length === 0) return null;
  if (!inHere) {
    const others = users.filter((u) => u.id !== me);
    return (
      <div data-testid="dm-call-banner" className="flex items-center gap-3 border-b border-divider bg-success/10 px-4 py-2">
        <PhoneCall size={20} className="text-success" />
        <div className="flex -space-x-2">{others.slice(0, 4).map((u) => <Avatar key={u.id} user={u} size={28} ring="rgb(var(--chat))" />)}</div>
        <span className="min-w-0 flex-1 truncate text-sm text-header">{others.map((u) => displayName(u)).join(', ')} {others.length === 1 ? 'is' : 'are'} in a call</span>
        <button className="btn btn-primary" onClick={() => void startCall(channel.id, false)}>{t('Join Call')}</button>
      </div>
    );
  }
  return (
    <section data-testid="dm-call" aria-label={t('Call')} className="flex h-[min(46vh,420px)] min-h-[260px] shrink-0 flex-col border-b border-divider bg-[#000]/60 max-md:h-[min(52vh,420px)]">
      <VoiceBanners />
      {conn === 'connecting' || snap.status === 'connecting'
        ? <div className="flex flex-1 items-center justify-center text-muted" role="status">{t('Calling…')}</div>
        : snap.participants.length <= 1 && <div className="px-4 pt-3 text-center text-sm text-muted">{t('Waiting for others to join…')}</div>}
      {snap.status !== 'connecting' && <CallSurface compact />}
      <ControlBar onSettings={() => openModal({ kind: 'voiceSettings' })} className="!py-2" />
    </section>
  );
}

export const DmCallIcons = { Phone, Video };
