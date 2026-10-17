/** Text chat attached to a voice or stage channel: the same message list and composer, in a side panel (full screen on phones). */
import { useRef } from 'react';
import { X } from 'lucide-react';
import type { Channel } from '@jorcord/shared';
import { useData } from '@/stores/data';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { TypingIndicator } from './TypingIndicator';
import { t } from '@/i18n';

export function VoiceChatPanel({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const snap = useRef<{ cid: string; v: string | null }>({ cid: '', v: null });
  if (snap.current.cid !== channel.id) snap.current = { cid: channel.id, v: useData.getState().readStates[channel.id]?.lastReadId ?? null };
  return (
    <section data-testid="voice-chat" aria-label={t('Voice channel chat')} className="absolute inset-0 z-30 flex min-h-0 flex-col bg-chat md:static md:z-auto md:w-[380px] md:shrink-0 md:border-s md:border-divider">
      <header className="flex h-12 shrink-0 items-center justify-between px-4 shadow-[0_1px_0_rgb(0_0_0/0.2)]">
        <h2 className="truncate font-semibold text-header">{t('Chat')} <span className="text-sm font-normal text-muted">#{channel.name}</span></h2>
        <button aria-label={t('Hide Chat')} onClick={onClose} className="flex h-8 w-8 items-center justify-center text-interactive hover:text-header"><X size={20} /></button>
      </header>
      <MessageList key={channel.id} channel={channel} lastReadSnapshot={snap.current.v} />
      <div className="relative"><TypingIndicator channelId={channel.id} guildId={channel.guildId} /></div>
      <Composer key={'c' + channel.id} channel={channel} />
    </section>
  );
}
