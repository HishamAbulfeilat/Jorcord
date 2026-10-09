/**
 * ============================ VOICE HOOK-UP POINT ============================
 * The voice agent owns apps/web/src/voice/**. Replace the body of this component
 * (or re-export from '@/voice') to render the LiveKit room UI for a voice/stage
 * channel. Props are the contract the shell uses; keep them stable.
 *
 *   <VoiceChannelView channel={channel} />
 *
 * Related slots: <VoiceDock /> (below the channel list, "Voice Connected" panel)
 * and stores/voiceui.ts (self mute / deafen / connected channel id).
 * ==============================================================================
 */
import type { Channel } from '@jorcord/shared';
import { Volume2, Radio } from 'lucide-react';
import { useData } from '@/stores/data';
import { Avatar } from '@/components/ui/Avatar';
import { displayName } from '@/lib/format';
import { useShallow } from 'zustand/react/shallow';

export function VoiceChannelView({ channel }: { channel: Channel }) {
  const users = useData(useShallow((s) => Object.values(s.voiceStates).filter((v) => v.channelId === channel.id).map((v) => s.users[v.userId]).filter(Boolean)));
  const Icon = channel.type === 'stage' ? Radio : Volume2;
  return (
    <div data-voice-placeholder className="flex h-full flex-1 flex-col items-center justify-center gap-4 bg-[#000] p-6 text-center text-white">
      <Icon size={48} className="text-muted" />
      <h2 className="text-2xl font-bold">{channel.name}</h2>
      <p className="max-w-sm text-sm text-muted">Voice is provided by the voice module (LiveKit). This placeholder is replaced by <code>src/voice</code>.</p>
      <div className="flex flex-wrap justify-center gap-3">{users.map((u) => <div key={u.id} className="flex flex-col items-center gap-1 text-xs"><Avatar user={u} size={64} /><span>{displayName(u)}</span></div>)}</div>
    </div>
  );
}

/** Slot rendered above the user panel while connected to voice. */
export function VoiceDock() { return null; }
