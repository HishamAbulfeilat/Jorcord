import { useState, type ComponentType } from 'react';
import { EyeOff } from 'lucide-react';
import type { Message } from '@jorcord/shared';
import { useData } from '@/stores/data';
import { useSocial } from '@/stores/social';
import { t } from '@/i18n';

/** True for messages a viewer who ignores `m.author` should see folded away: ordinary messages from somebody else. */
export const isFoldedByIgnore = (m: Pick<Message, 'type' | 'author'>, ignored: Record<string, true>, meId?: string) =>
  !!ignored[m.author.id] && m.author.id !== meId && (m.type === 'default' || m.type === 'reply');

/** One quiet line in place of an ignored author's message; clicking reveals it for this view only. */
export function IgnoredStub({ m, onShow }: { m: Message; onShow: () => void }) {
  return (
    <div className="flex items-center gap-3 px-4 py-1 text-sm text-muted" data-testid="ignored-message" id={`msg-${m.id}`}>
      <span className="flex w-10 justify-end"><EyeOff size={16} aria-hidden /></span>
      <span>{t('Ignored message')}</span>
      <button className="font-medium text-link hover:underline" onClick={onShow}>{t('Show message')}</button>
    </div>
  );
}

/**
 * Wraps the message row: messages from people I ignore are replaced by a stub until clicked. Ignoring is not blocking: the server still
 * delivers everything, so the choice is purely about what this client shows.
 */
export function withIgnore<P extends { m: Message }>(Base: ComponentType<P>): ComponentType<P> {
  return function IgnoreGate(props: P) {
    const ignored = useSocial((s) => s.ignored); const meId = useData((s) => s.me?.id);
    const [shown, setShown] = useState(false);
    if (!shown && isFoldedByIgnore(props.m, ignored, meId)) return <IgnoredStub m={props.m} onShow={() => setShown(true)} />;
    return <Base {...props} />;
  };
}
