import { useShallow } from 'zustand/react/shallow';
import { emojiUrl } from '@/components/chat/Markdown';
import { useVoiceEffects, type VoiceEffect } from '@/stores/voiceEffects';

/** Horizontal drift per effect id, deterministic so a re-render does not make an emoji jump. */
export const driftFor = (id: number) => `${((id * 37) % 41) - 20}px`;

export function EffectGlyph({ e }: { e: Pick<VoiceEffect, 'emoji' | 'emojiId'> }) {
  return e.emojiId
    ? <img src={emojiUrl(e.emojiId, false)} alt={`:${e.emoji}:`} draggable={false} />
    : <span aria-hidden>{e.emoji}</span>;
}

/** Emoji bursts floating over one participant's tile. Decorative: the layer is aria-hidden and ignores the pointer. */
export function TileEffects({ userId }: { userId: string }) {
  const mine = useVoiceEffects(useShallow((s) => s.effects.filter((e) => e.userId === userId)));
  if (!mine.length) return null;
  return (
    <div aria-hidden data-testid="tile-effects" className="pointer-events-none absolute inset-0 z-[8] overflow-hidden">
      {mine.map((e) => (
        <span key={e.id} data-testid="voice-effect" className="jv-effect" style={{ insetInlineStart: `${20 + ((e.id * 53) % 55)}%`, ['--jv-dx' as string]: driftFor(e.id) }}>
          <EffectGlyph e={e} />
        </span>
      ))}
    </div>
  );
}
