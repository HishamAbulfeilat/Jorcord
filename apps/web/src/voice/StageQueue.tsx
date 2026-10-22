/** Stage channels: the raised-hand queue (first come first served), anonymous hands, and blocking members from speaking. */
import { useCallback, useEffect, useState } from 'react';
import { Ban, Hand, UserCheck } from 'lucide-react';
import type { Id, StageBlock, StageQueueEntry } from '@jorcord/shared';
import { api } from '@/lib/api';
import { displayName } from '@/lib/format';
import { useData } from '@/stores/data';
import { useLiveVoice } from '@/stores/livevoice';
import { useUI } from '@/stores/ui';
import { t } from '@/i18n';

const fail = (e: unknown) => useUI.getState().toast((e as Error).message || t('Stage action failed'), 'error');

/**
 * The queue of raised hands. Moderators read it from the API (it carries identities, also for anonymous hands) and re-read it
 * whenever the gateway says it changed; everyone else shows what the gateway sends (anonymous hands without identity), falling back
 * to the public hand marks in the voice states until the first update arrives.
 */
export function useStageQueue(channelId: Id, mod: boolean): StageQueueEntry[] {
  const pushed = useLiveVoice((s) => s.queue[channelId]);
  const states = useData((s) => s.voiceStates);
  const [fetched, setFetched] = useState<StageQueueEntry[] | null>(null);
  useEffect(() => {
    if (!mod) { setFetched(null); return; }
    let dead = false;
    api.voice.stageQueue(channelId).then((q) => { if (!dead) setFetched(q); }).catch(() => {});
    return () => { dead = true; };
  }, [channelId, mod, pushed]);
  if (mod && fetched) return fetched;
  if (pushed) return pushed;
  return Object.values(states)
    .filter((v) => v.channelId === channelId && v.suppress && v.requestToSpeakAt)
    .sort((a, b) => String(a.requestToSpeakAt).localeCompare(String(b.requestToSpeakAt)))
    .map((v, i) => ({ userId: v.userId, anonymous: false, requestToSpeakAt: v.requestToSpeakAt!, position: i + 1 }));
}

/** Members a moderator barred from speaking on this stage. */
export function useStageBlocks(channelId: Id, mod: boolean) {
  const [blocks, setBlocks] = useState<StageBlock[]>([]);
  const refresh = useCallback(() => { if (mod) api.voice.stageBlocked(channelId).then(setBlocks).catch(() => {}); }, [channelId, mod]);
  useEffect(() => { refresh(); }, [refresh]);
  return { blocks, refresh };
}

export function StageHands({ channelId, mod, entries, names, onBlocked }: { channelId: Id; mod: boolean; entries: StageQueueEntry[]; names: Record<Id, string>; onBlocked: () => void }) {
  const users = useData((s) => s.users);
  if (!entries.length) return null;
  const nameOf = (id: Id) => names[id] ?? (users[id] ? displayName(users[id]!) : t('Unknown'));
  return (
    <section aria-label={t('Requests to speak')}>
      <h3 className="section-title mb-2">{t('Requests to speak')} — {entries.length}</h3>
      <ol className="grid gap-1">{entries.map((e) => (
        <li key={e.userId ?? `anon-${e.position}`} data-testid="stage-hand" className="flex items-center gap-2 rounded bg-side px-3 py-2 text-sm text-header">
          <span className="w-5 shrink-0 text-end text-xs font-semibold text-muted" aria-label={`${t('Position')} ${e.position}`}>{e.position}</span>
          <Hand size={16} className="shrink-0 text-warn" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{e.userId ? nameOf(e.userId) : t('Anonymous')}{e.anonymous && e.userId && <span className="ms-2 text-xs text-muted">({t('anonymous hand')})</span>}</span>
          {mod && e.userId && <>
            <button className="btn btn-primary" onClick={() => void api.voice.stageSpeaker(channelId, e.userId!, true).catch(fail)}>{t('Invite to Speak')}</button>
            <button className="btn btn-secondary" aria-label={`${t('Block')} ${nameOf(e.userId)} ${t('from speaking')}`} title={t('Block from speaking')} onClick={() => void api.voice.stageBlock(channelId, e.userId!, true).then(onBlocked).catch(fail)}><Ban size={14} /></button>
          </>}
        </li>))}
      </ol>
    </section>
  );
}

export function StageBlockedList({ channelId, blocks, refresh }: { channelId: Id; blocks: StageBlock[]; refresh: () => void }) {
  const users = useData((s) => s.users);
  if (!blocks.length) return null;
  return (
    <section aria-label={t('Blocked from speaking')}>
      <h3 className="section-title mb-2">{t('Blocked from speaking')} — {blocks.length}</h3>
      <ul className="grid gap-1">{blocks.map((b) => (
        <li key={b.userId} className="flex items-center gap-2 rounded bg-side px-3 py-2 text-sm text-header">
          <Ban size={16} className="shrink-0 text-danger" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{users[b.userId] ? displayName(users[b.userId]!) : t('Unknown')}{b.reason && <span className="ms-2 text-xs text-muted">{b.reason}</span>}</span>
          <button className="btn btn-secondary" onClick={() => void api.voice.stageBlock(channelId, b.userId, false).then(refresh).catch(fail)}><UserCheck size={14} />{t('Unblock')}</button>
        </li>))}
      </ul>
    </section>
  );
}

/** Audience: raise / lower my hand, optionally anonymously, and see my place in the queue. */
export function RaiseHand({ channelId, myHand }: { channelId: Id; myHand: boolean }) {
  const hand = useLiveVoice((s) => s.hand[channelId]);
  const [anonymous, setAnonymous] = useState(false);
  const raised = hand ? hand.raised : myHand;
  const toggle = () => void api.voice.stageRequest(channelId, !raised, { anonymous })
    .then((r) => useLiveVoice.getState().setHand(channelId, { raised: !raised, anonymous: !raised && anonymous, position: r.handPosition ?? null }))
    .catch(fail);
  return (
    <div className="flex flex-col items-center gap-2 self-center">
      <button className={`btn btn-lg w-full max-w-xs ${raised ? 'btn-secondary' : 'btn-primary'}`} onClick={toggle}>
        <Hand size={16} />{raised ? t('Lower Hand') : t('Request to Speak')}
      </button>
      {raised
        ? <p role="status" data-testid="hand-position" className="text-sm text-muted">{hand?.position ? `${t('You are number')} ${hand.position} ${t('in line')}` : t('Your hand is raised.')}{hand?.anonymous ? ` · ${t('only moderators can see it is you')}` : ''}</p>
        : <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" className="accent-brand" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />{t('Raise my hand anonymously')}</label>}
    </div>
  );
}
