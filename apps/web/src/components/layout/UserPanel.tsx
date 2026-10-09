import { Mic, MicOff, Headphones, Settings, VolumeX } from 'lucide-react';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { useVoiceUI } from '@/stores/voiceui';
import { Avatar, PRESENCE_LABEL } from '@/components/ui/Avatar';
import { displayName } from '@/lib/format';
import { Tip } from '@/components/ui/Tooltip';
import { VoiceDock } from '@/components/VoiceChannelView';
import { statusMenu } from './statusMenu';
import { useMenuTrigger } from '@/components/ui/ContextMenu';

export function UserPanel() {
  const me = useData((s) => s.me); const presence = useData((s) => (s.me ? s.presences[s.me.id] : undefined)) ?? 'online';
  const openSettings = useUI((s) => s.openSettings); const openMenu = useUI((s) => s.openMenu);
  const { selfMute, selfDeaf, toggleMute, toggleDeaf } = useVoiceUI();
  const trig = useMenuTrigger(statusMenu);
  if (!me) return null;
  const eff = me.presence && !useData.getState().presences[me.id] ? me.presence : presence;
  return (
    <div>
      <VoiceDock />
      <div className="flex h-[52px] items-center gap-1 bg-[rgb(var(--rail)/0.55)] px-2 safe-bottom box-content">
        <button className="group flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left hover:bg-hover" aria-label="Set status" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu(r.left, r.top - 8 - 190, statusMenu()); }} {...trig}>
          <Avatar user={me} size={32} presence online={eff} ring="rgb(var(--rail))" />
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-sm font-semibold text-header">{displayName(me)}</span>
            <span className="block truncate text-xs text-muted">{me.customStatus?.text || PRESENCE_LABEL[eff]}</span>
          </span>
        </button>
        <Tip text={selfMute ? 'Unmute' : 'Mute'} side="top"><button aria-pressed={selfMute} aria-label={selfMute ? 'Unmute' : 'Mute'} onClick={toggleMute} className={`flex h-8 w-8 items-center justify-center rounded hover:bg-hover ${selfMute ? 'text-danger' : 'text-interactive hover:text-interactive-hover'}`}>{selfMute ? <MicOff size={20} /> : <Mic size={20} />}</button></Tip>
        <Tip text={selfDeaf ? 'Undeafen' : 'Deafen'} side="top"><button aria-pressed={selfDeaf} aria-label={selfDeaf ? 'Undeafen' : 'Deafen'} onClick={toggleDeaf} className={`flex h-8 w-8 items-center justify-center rounded hover:bg-hover ${selfDeaf ? 'text-danger' : 'text-interactive hover:text-interactive-hover'}`}>{selfDeaf ? <VolumeX size={20} /> : <Headphones size={20} />}</button></Tip>
        <Tip text="User Settings" side="top"><button aria-label="User Settings" onClick={() => openSettings({ kind: 'user' })} className="flex h-8 w-8 items-center justify-center rounded text-interactive hover:bg-hover hover:text-interactive-hover"><Settings size={20} /></button></Tip>
      </div>
    </div>
  );
}
