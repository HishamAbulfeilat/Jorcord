import { useState } from 'react';
import { Hand } from 'lucide-react';
import { messageTtlLabel, type Message } from '@jorcord/shared';
import { api3c } from '@/lib/api3c';
import { useData } from '@/stores/data';
import { toastError } from '@/stores/ui';
import { t } from '@/i18n';

/** "Wave to say hi": replies to a join message with the wave sticker. One wave per person per message (the server enforces it). */
export function WaveButton({ m }: { m: Message }) {
  const me = useData((s) => s.me?.id);
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  if (!m.guildId || m.author.id === me) return null;
  const wave = () => { setState('busy'); api3c.wave(m.channelId, m.id).then(() => setState('done')).catch((e) => { setState(e?.code === 'ALREADY_WAVED' ? 'done' : 'idle'); if (e?.code !== 'ALREADY_WAVED') toastError(e); }); };
  return (
    <button data-testid="wave-button" disabled={state !== 'idle'} onClick={wave} className="ms-2 inline-flex items-center gap-1 rounded border border-divider px-2 py-0.5 align-middle text-xs font-medium text-header hover:bg-hover disabled:opacity-60">
      <Hand size={13} aria-hidden />{state === 'done' ? t('Waved') : t('Wave to say hi')}
    </button>
  );
}

/** System line for a disappearing-messages change (content = new timer in seconds). */
export function ttlSystemText(content: string): string {
  const s = Number(content);
  return s > 0 ? `${t('turned on disappearing messages:')} ${t(messageTtlLabel(s))}` : t('turned off disappearing messages.');
}
