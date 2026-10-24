import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { Perm, type Channel } from '@jorcord/shared';
import { api } from '@/lib/api';
import { can } from '@/lib/perms';
import { myChannelPerms } from '@/lib/session';
import { useData } from '@/stores/data';
import { useVoiceUI } from '@/stores/voiceui';
import { toastError } from '@/stores/ui';
import { t } from '@/i18n';

export const VOICE_STATUS_MAX = 500;

/** May I edit this channel's status right now: the permission, and being connected to that channel (the server checks both). */
export function canSetVoiceStatus(channel: Pick<Channel, 'id' | 'guildId' | 'type'>, connectedChannelId: string | null, perms: bigint): boolean {
  return !!channel.guildId && (channel.type === 'voice' || channel.type === 'stage') && connectedChannelId === channel.id && can(perms, Perm.SET_VOICE_CHANNEL_STATUS);
}

/** Read-only status text (sidebar, lobby). Renders nothing when empty. */
export function VoiceStatusText({ status, className }: { status?: string | null; className?: string }) {
  if (!status) return null;
  return <span data-testid="voice-status" title={status} className={className ?? 'truncate text-xs text-muted'}>{status}</span>;
}

/** Status line with an inline editor for members who may set it. */
export function VoiceStatusEditor({ channelId }: { channelId: string }) {
  const ch = useData((s) => Object.values(s.guilds).map((g) => g.channels[channelId]).find(Boolean)) as Channel | undefined;
  const connected = useVoiceUI((s) => s.connectedChannelId);
  const [editing, setEditing] = useState(false); const [draft, setDraft] = useState(''); const [busy, setBusy] = useState(false);
  if (!ch) return null;
  const editable = canSetVoiceStatus(ch, connected, myChannelPerms(ch.id));
  if (!editable && !ch.voiceStatus) return null;
  const save = async (next: string | null) => {
    setBusy(true);
    try { await api.voice.setStatus(ch.id, next); setEditing(false); } catch (e) { toastError(e); }
    setBusy(false);
  };
  if (editing) {
    return (
      <form data-testid="voice-status-form" className="mt-1 flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); void save(draft.trim() || null); }}>
        <input autoFocus aria-label={t('Voice channel status')} className="field !min-h-[28px] flex-1 !py-0.5 text-xs" maxLength={VOICE_STATUS_MAX} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }} placeholder={t('What is happening in this channel?')} />
        <button type="submit" disabled={busy} className="btn btn-primary !min-h-[28px] !px-2 text-xs">{t('Save')}</button>
      </form>
    );
  }
  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-1">
      {ch.voiceStatus ? <VoiceStatusText status={ch.voiceStatus} /> : <span className="truncate text-xs text-muted/70">{t('No status set')}</span>}
      {editable && <button aria-label={t('Set voice channel status')} onClick={() => { setDraft(ch.voiceStatus ?? ''); setEditing(true); }} className="shrink-0 text-interactive hover:text-header"><Pencil size={12} /></button>}
    </div>
  );
}
